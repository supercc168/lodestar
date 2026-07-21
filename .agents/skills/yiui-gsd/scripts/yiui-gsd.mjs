#!/usr/bin/env node

/**
 * Cross-platform yiui-gsd helpers.
 *
 * The skill is distributed to projects that already require Node.js >= 18.
 * Keeping the workflow here avoids making macOS/Linux depend on a healthy
 * PowerShell runtime while the legacy .ps1 files remain thin compatibility
 * entry points.
 */

import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const DEFAULT_TRACKER = `# GSD 任务跟踪

> 这里只列出未完成任务。当前会话选择由 GSD session-local workstream 保存，不属于任务状态。

## 未完成任务

| task_slug | 名称 | 类型 | 状态 | 当前阶段 | 创建时间 | 最后更新 | 简述 |
|-----------|------|------|------|----------|----------|----------|------|
`

const LOCK_TIMEOUT_MS = 30_000
const LOCK_RETRY_MS = 100
const SESSION_KEY_NAMES = [
  'GSD_SESSION_KEY',
  'CODEX_THREAD_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
  'OPENCODE_SESSION_ID',
  'GEMINI_SESSION_ID',
  'CURSOR_SESSION_ID',
  'WINDSURF_SESSION_ID',
  'TERM_SESSION_ID',
  'WT_SESSION',
  'TMUX_PANE',
  'ZELLIJ_SESSION_NAME',
]

function fail(message) {
  throw new Error(message)
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function readText(path) {
  if (!existsSync(path)) return ''
  return readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
}

function normalizeNewlines(content) {
  return content.replace(/\r\n?/g, '\n')
}

function writeText(path, content, { bom = false } = {}) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${bom ? '\uFEFF' : ''}${content}`, 'utf8')
}

function writeTextAtomic(path, content, { bom = false } = {}) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `${bom ? '\uFEFF' : ''}${content}`, 'utf8')
    renameSync(temporary, path)
  } finally {
    if (pathExists(temporary)) rmSync(temporary, { force: true })
  }
}

function pathStat(path) {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function pathExists(path) {
  return pathStat(path) !== null
}

function readLinkTarget(path) {
  try {
    return readlinkSync(path)
  } catch {
    return null
  }
}

function isLink(path) {
  const stat = pathStat(path)
  return Boolean(stat?.isSymbolicLink() || readLinkTarget(path) != null)
}

function removeLinkOnly(path) {
  if (!pathExists(path)) return
  if (!isLink(path)) fail(`refusing to remove non-link planning route: ${path}`)
  try {
    unlinkSync(path)
    return
  } catch {
    if (process.platform !== 'win32') fail(`failed to remove planning symlink: ${path}`)
  }
  rmSync(path, { recursive: false, force: true })
}

function sameFile(left, right) {
  try {
    const a = statSync(left)
    const b = statSync(right)
    if (a.dev === b.dev && a.ino === b.ino) return true
    return readFileSync(left).equals(readFileSync(right))
  } catch {
    return false
  }
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function removeStaleLock(lockPath) {
  try {
    const ownerPath = join(lockPath, 'owner.json')
    const age = Date.now() - statSync(lockPath).mtimeMs
    if (age < LOCK_TIMEOUT_MS) return false
    let ownerPid = 0
    try {
      ownerPid = Number(JSON.parse(readText(ownerPath) || '{}').pid)
    } catch {
      // A process can die after mkdir and before owner.json is fully written.
    }
    if (processIsAlive(ownerPid)) return false
    rmSync(lockPath, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

function withGsdWriteLock(gsdRoot, operation) {
  const gitRoot = join(gsdRoot, '.git')
  if (!pathExists(gitRoot)) fail(`GSD local git missing: ${gsdRoot}`)
  const lockPath = join(gitRoot, 'yiui-gsd-write.lock')
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  while (true) {
    try {
      mkdirSync(lockPath)
      writeText(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (removeStaleLock(lockPath)) continue
      if (Date.now() >= deadline) fail(`timed out waiting for GSD write lock: ${lockPath}`)
      sleep(LOCK_RETRY_MS)
    }
  }
  try {
    return operation()
  } finally {
    rmSync(lockPath, { recursive: true, force: true })
  }
}

function resolveProjectRoot(options = {}) {
  return resolve(options['project-root'] || options.projectRoot || process.cwd())
}

function resolveCodexHome(options = {}) {
  return resolve(options['codex-home'] || options.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex'))
}

function resolveDefaultsPath(options = {}) {
  return resolve(
    options['gsd-defaults-path'] ||
      options.gsdDefaultsPath ||
      process.env.GSD_DEFAULTS_PATH ||
      join(homedir(), '.gsd', 'defaults.json'),
  )
}

function runGit(args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) fail(`git ${args.join(' ')} failed: ${result.error.message}`)
  if (result.status !== 0 && !allowFailure) {
    const detail = (result.stderr || result.stdout || '').trim()
    fail(`git ${args.join(' ')} failed with exit ${result.status}${detail ? `: ${detail}` : ''}`)
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }
}

function nowIso() {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return shifted.toISOString().replace(/\.\d{3}Z$/, '+08:00')
}

function normalizeSlug(value) {
  const slug = String(value || '').trim()
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    fail(`invalid task slug: ${slug || '(empty)'}`)
  }
  return slug
}

function defaultProjectContent(root) {
  const name = basename(root)
  return `# ${name}\n\n## What This Is\n\n这是 ${name} 的项目级共享 GSD 上下文。任务名称、范围、完成标准和执行游标分别保存在 .gsd/{task-slug}/TASK.md 与 .gsd/{task-slug}/.planning/STATE.md，不得写回本文件形成任务级双源。\n\n## Core Value\n\n在项目硬规则与验证门禁下持续交付可验证、可恢复的增量变更。\n\n## Requirements\n\n### Active\n\n- 允许多个不同 task_slug 同时处于运行中；当前会话选择不属于任务状态。\n- 所有任务共享项目源码和运行进程；修改范围重叠时串行执行或使用独立 Git worktree。\n- 项目硬规则以根指令文件为准，任务事实以代码、测试、Git、TASK 和 STATE 为准。\n- .gsd/TRACKER.md 只索引未完成任务；任务完成后保留目录与 Git 历史。\n\n### Out of Scope\n\n- 在共享 PROJECT 中记录单个任务的范围、阶段、执行游标或临时状态。\n- 通过任务切换隐式暂停其他任务。\n\n## Evolution\n\n只有跨任务成立且经过验证的项目级事实才更新本文件。任务专属决策保留在对应任务产物中。\n`
}

function ensureIgnoreLine(path, requiredLine) {
  const lines = normalizeNewlines(readText(path)).split('\n').filter(Boolean)
  if (!lines.includes(requiredLine)) lines.push(requiredLine)
  writeText(path, `${lines.join('\n')}\n`)
}

function stagedFiles(gsdRoot) {
  return runGit(['diff', '--cached', '--name-only'], gsdRoot).stdout.split(/\r?\n/).filter(Boolean)
}

function assertEmptyGsdIndex(gsdRoot, action = 'write') {
  const staged = stagedFiles(gsdRoot)
  if (staged.length) fail(`GSD index must be empty before ${action}: ${staged.join(', ')}`)
}

function assertCleanManagedFiles(gsdRoot, paths, action) {
  const dirty = runGit(['status', '--porcelain', '--', ...paths], gsdRoot).stdout.trim()
  if (dirty) fail(`GSD managed files must be clean before ${action}: ${dirty.replace(/\r?\n/g, ', ')}`)
}

export function initGsdRepo(options = {}) {
  const root = resolveProjectRoot(options)
  const gsdRoot = join(root, '.gsd')
  mkdirSync(gsdRoot, { recursive: true })
  const gitWasPresent = pathExists(join(gsdRoot, '.git'))
  if (!gitWasPresent) runGit(['init', '-q'], gsdRoot)

  const result = withGsdWriteLock(gsdRoot, () => {
    assertEmptyGsdIndex(gsdRoot, 'init')
    const managedPaths = ['.gitignore', 'PROJECT.md', 'TRACKER.md']
    if (gitWasPresent) assertCleanManagedFiles(gsdRoot, managedPaths, 'init')
    const gitignorePath = join(gsdRoot, '.gitignore')
    ensureIgnoreLine(gitignorePath, '**/.planning/config.json')
    const trackerPath = join(gsdRoot, 'TRACKER.md')
    if (!existsSync(trackerPath)) writeText(trackerPath, DEFAULT_TRACKER)
    const projectPath = join(gsdRoot, 'PROJECT.md')
    if (!existsSync(projectPath)) writeText(projectPath, defaultProjectContent(root))

    runGit(['add', '--', ...managedPaths], gsdRoot)
    const diff = runGit(['diff', '--cached', '--quiet'], gsdRoot, { allowFailure: true })
    if (diff.status === 1) {
      const commit = runGit(['commit', '-m', 'init gsd task repo'], gsdRoot, { allowFailure: true })
      if (commit.status !== 0) {
        runGit(['reset', '-q', '--', ...managedPaths], gsdRoot, { allowFailure: true })
        fail(`GSD init commit failed: ${commit.stderr.trim() || `exit ${commit.status}`}`)
      }
    } else if (diff.status !== 0) {
      runGit(['reset', '-q', '--', ...managedPaths], gsdRoot, { allowFailure: true })
      fail(`failed to inspect GSD init diff: exit ${diff.status}`)
    }
    return { root, gsdRoot, trackerPath, projectPath }
  })
  console.log(`GSD repo ready: ${gsdRoot}`)
  return result
}

function parseTrackerField(content, field) {
  const match = content.match(new RegExp(`^-\\s*${escapeRegExp(field)}[：:]\\s*(.*?)\\s*$`, 'm'))
  return match ? match[1].trim() : ''
}

function replaceUnique(content, pattern, replacement, field, path) {
  const matches = [...content.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))]
  if (matches.length !== 1) fail(`${field} field count must be 1, got ${matches.length}: ${path}`)
  return content.replace(pattern, replacement)
}

function escapeMarkdownCell(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').replaceAll('|', '\\|')
}

function readCurrentPhase(content) {
  const match = content.match(/^-?\s*current_phase:\s*(.*?)\s*$/m)
  return match?.[1]?.trim() || 'unknown'
}

function readCommittedFile(gsdRoot, relativePath) {
  const result = runGit(['show', `HEAD:${relativePath}`], gsdRoot, { allowFailure: true })
  return result.status === 0 ? result.stdout : null
}

function readTaskRecord(root, slug, { committed = false } = {}) {
  const gsdRoot = join(root, '.gsd')
  const taskRelative = `${slug}/TASK.md`
  const taskPath = join(gsdRoot, taskRelative)
  const content = committed ? readCommittedFile(gsdRoot, taskRelative) : readText(taskPath)
  if (content == null || !content) return null
  const declaredSlug = parseTrackerField(content, 'task_slug')
  if (declaredSlug !== slug) fail(`TASK.md task_slug mismatch, directory=${slug}, value=${declaredSlug || '(missing)'}`)
  const status = parseTrackerField(content, '状态')
  if (!['运行中', '已暂停', '已完成'].includes(status)) fail(`invalid task status for ${slug}: ${status || '(missing)'}`)
  const heading = content.match(/^#\s+(.+?)\s*$/m)
  const stateRelative = `${slug}/.planning/STATE.md`
  const stateContent = committed ? readCommittedFile(gsdRoot, stateRelative) : readText(join(gsdRoot, stateRelative))
  return {
    slug,
    name: heading?.[1]?.trim() || slug,
    type: parseTrackerField(content, '任务类型') || 'generic',
    status,
    phase: stateContent ? readCurrentPhase(stateContent) : 'unknown',
    created: parseTrackerField(content, '创建时间'),
    updated: parseTrackerField(content, '最后更新'),
    summary: parseTrackerField(content, '简述'),
    content,
  }
}

function listTaskRecords(root, options = {}) {
  const gsdRoot = join(root, '.gsd')
  if (!existsSync(gsdRoot)) return []
  const workingSlug = String(options.workingTaskSlug || '')
  const slugs = new Set()
  for (const entry of readdirSync(gsdRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== '.git' && entry.name !== '.locks') slugs.add(entry.name)
  }
  if (options.committedOthers) {
    const tree = runGit(['ls-tree', '-r', '--name-only', 'HEAD'], gsdRoot, { allowFailure: true })
    if (tree.status === 0) {
      for (const path of tree.stdout.split(/\r?\n/)) {
        const match = path.match(/^([^/]+)\/TASK\.md$/)
        if (match) slugs.add(match[1])
      }
    }
  }
  const records = []
  for (const slug of slugs) {
    const committed = Boolean(options.committedOthers && slug !== workingSlug)
    const record = readTaskRecord(root, slug, { committed })
    if (record && record.status !== '已完成') records.push(record)
  }
  return records.sort((left, right) => {
    const rank = (value) => value === '运行中' ? 0 : 1
    return rank(left.status) - rank(right.status) || right.updated.localeCompare(left.updated) || left.slug.localeCompare(right.slug)
  })
}

function trackerContent(records) {
  const rows = records.map(task => `| ${task.slug} | ${escapeMarkdownCell(task.name)} | ${escapeMarkdownCell(task.type)} | ${task.status} | ${escapeMarkdownCell(task.phase)} | ${escapeMarkdownCell(task.created)} | ${escapeMarkdownCell(task.updated)} | ${escapeMarkdownCell(task.summary)} |`)
  return `${DEFAULT_TRACKER.trimEnd()}${rows.length ? `\n${rows.join('\n')}` : ''}\n`
}

export function updateGsdTracker(options = {}) {
  const root = resolveProjectRoot(options)
  const gsdRoot = join(root, '.gsd')
  if (!pathExists(join(gsdRoot, '.git'))) fail(`GSD local git missing: ${gsdRoot}`)
  const operation = () => {
    assertEmptyGsdIndex(gsdRoot, 'tracker update')
    const records = listTaskRecords(root, {
      workingTaskSlug: options['working-task-slug'] || options.workingTaskSlug,
      committedOthers: Boolean(options['committed-others'] || options.committedOthers),
    })
    writeTextAtomic(join(gsdRoot, 'TRACKER.md'), trackerContent(records))
    if (!options.quiet) console.log(`Rebuilt GSD tracker: ${records.length} unfinished task(s)`)
    return records
  }
  const lockAlreadyHeld = Boolean(options['lock-already-held'] || options.lockAlreadyHeld)
  return lockAlreadyHeld ? operation() : withGsdWriteLock(gsdRoot, operation)
}

function updateTaskStatusFile(root, slug, status) {
  const path = join(root, '.gsd', slug, 'TASK.md')
  let content = readText(path)
  if (!content) fail(`TASK.md missing for ${slug}`)
  const now = nowIso()
  content = replaceUnique(content, /^\-\s*状态[：:]\s*.*?\s*$/m, `- 状态: ${status}`, '状态', path)
  content = replaceUnique(content, /^\-\s*最后更新[：:]\s*.*?\s*$/m, `- 最后更新: ${now}`, '最后更新', path)
  writeText(path, content, { bom: readFileSync(path).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) })
  return now
}

function updateStateStatus(root, slug, status) {
  const path = join(root, '.gsd', slug, '.planning', 'STATE.md')
  if (!existsSync(path)) return
  let content = readText(path)
  content = replaceUnique(content, /^status:\s*.*?\s*$/m, `status: ${status}`, 'status', path)
  content = replaceUnique(content, /^last_updated:\s*.*?\s*$/m, `last_updated: "${nowIso()}"`, 'last_updated', path)
  writeText(path, content)
}

function ensurePlanningRouter(root, slug) {
  const canonical = join(root, '.gsd', slug, '.planning')
  const sharedCanonical = join(root, '.gsd', 'PROJECT.md')
  if (!existsSync(sharedCanonical)) fail(`shared GSD PROJECT.md missing: ${sharedCanonical}`)
  mkdirSync(canonical, { recursive: true })
  const planningRoot = join(root, '.planning')
  const rootStat = pathStat(planningRoot)
  if (rootStat && isLink(planningRoot)) removeLinkOnly(planningRoot)
  else if (rootStat && !rootStat.isDirectory()) fail(`.planning exists and is not a directory: ${planningRoot}`)
  mkdirSync(join(planningRoot, 'workstreams'), { recursive: true })

  const sharedRoute = join(planningRoot, 'PROJECT.md')
  if (pathExists(sharedRoute)) {
    if (!sameFile(sharedRoute, sharedCanonical)) fail(`shared PROJECT.md differs from canonical: ${sharedRoute}`)
    const a = statSync(sharedRoute)
    const b = statSync(sharedCanonical)
    if (!(a.dev === b.dev && a.ino === b.ino)) {
      unlinkSync(sharedRoute)
      linkSync(sharedCanonical, sharedRoute)
    }
  } else linkSync(sharedCanonical, sharedRoute)

  const route = join(planningRoot, 'workstreams', slug)
  if (pathExists(route)) {
    if (!isLink(route)) fail(`workstream route exists and is not a link: ${route}`)
    let actual = ''
    try { actual = realpathSync(route) } catch { /* replace broken link */ }
    let expected = resolve(canonical)
    try { expected = realpathSync(canonical) } catch { /* canonical was just created */ }
    if (actual === expected) return { root, slug, canonical, route }
    removeLinkOnly(route)
  }
  if (process.platform === 'win32') symlinkSync(canonical, route, 'junction')
  else symlinkSync(relative(dirname(route), canonical) || canonical, route, 'dir')
  return { root, slug, canonical, route }
}

function resolveGsdTools(options = {}) {
  return resolve(options['gsd-tools-path'] || options.gsdToolsPath || join(resolveCodexHome(options), 'gsd-core', 'bin', 'gsd-tools.cjs'))
}

function runGsdTools(options, args, { allowFailure = false } = {}) {
  const tool = resolveGsdTools(options)
  if (!existsSync(tool)) {
    if (allowFailure) return { status: 1, stdout: '', stderr: `missing ${tool}` }
    fail(`GSD Core CLI missing: ${tool}`)
  }
  const result = spawnSync(process.execPath, [tool, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...(options.env || {}) },
  })
  if (result.error) fail(`GSD Core CLI failed: ${result.error.message}`)
  if (result.status !== 0 && !allowFailure) fail((result.stderr || result.stdout || `GSD Core exit ${result.status}`).trim())
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' }
}

function activeWorkstream(options, root) {
  const result = runGsdTools(options, ['query', 'workstream.get', '--cwd', root], { allowFailure: true })
  if (result.status !== 0) return ''
  try {
    return String(JSON.parse(result.stdout).active || '').trim()
  } catch {
    return ''
  }
}

function setActiveWorkstream(options, root, slug) {
  runGsdTools(options, ['query', 'workstream.set', slug, '--raw', '--cwd', root])
}

export function switchActiveTask(options = {}) {
  const root = resolveProjectRoot(options)
  const slug = normalizeSlug(options['task-slug'] || options.taskSlug)
  const gsdRoot = join(root, '.gsd')
  const taskPath = join(gsdRoot, slug, 'TASK.md')
  if (!existsSync(taskPath)) fail(`TASK.md missing: .gsd/${slug}/TASK.md`)
  let resumed = false
  const route = withGsdWriteLock(gsdRoot, () => {
    assertEmptyGsdIndex(gsdRoot, 'task switch')
    const task = readTaskRecord(root, slug)
    if (task.status === '已完成') fail(`completed task cannot be implicitly reopened: ${slug}`)
    if (task.status === '已暂停') {
      updateTaskStatusFile(root, slug, '运行中')
      updateStateStatus(root, slug, 'in_progress')
      resumed = true
    }
    const result = ensurePlanningRouter(root, slug)
    updateGsdTracker({ projectRoot: root, lockAlreadyHeld: true, quiet: true })
    setActiveWorkstream(options, root, slug)
    return result
  })
  if (!options.deferCommit) {
    gsdLocalCommit({ ...options, projectRoot: root, taskSlug: slug, message: resumed ? `gsd(${slug}): 恢复任务` : `gsd(${slug}): 同步任务索引` })
  }
  if (!SESSION_KEY_NAMES.some(name => String((options.env || process.env)[name] || '').trim())) {
    console.warn('warning: no stable GSD session key; workstream selection may use the shared fallback pointer')
  }
  console.log(`Selected GSD workstream: ${slug}`)
  return route
}

export function gsdLocalCommit(options = {}) {
  const root = resolveProjectRoot(options)
  const slug = normalizeSlug(options['task-slug'] || options.taskSlug)
  const message = String(options.message || '').trim()
  if (!message) fail('commit message is required')
  const gsdRoot = join(root, '.gsd')
  if (!pathExists(join(gsdRoot, '.git'))) fail('.gsd git missing, run init-gsd-repo first')
  return withGsdWriteLock(gsdRoot, () => {
    assertEmptyGsdIndex(gsdRoot, 'commit')
    updateGsdTracker({
      projectRoot: root,
      workingTaskSlug: slug,
      committedOthers: true,
      lockAlreadyHeld: true,
      quiet: true,
    })
    const paths = ['TRACKER.md', slug]
    if (options['include-shared-project'] || options.includeSharedProject) paths.unshift('PROJECT.md')
    runGit(['add', '--', ...paths], gsdRoot)
    const staged = stagedFiles(gsdRoot)
    const allowedShared = new Set(options['include-shared-project'] || options.includeSharedProject ? ['PROJECT.md', 'TRACKER.md'] : ['TRACKER.md'])
    const unexpected = staged.filter(path => !allowedShared.has(path) && !path.startsWith(`${slug}/`))
    if (unexpected.length) {
      runGit(['reset', '-q', '--', ...paths], gsdRoot, { allowFailure: true })
      fail(`scoped GSD commit includes unexpected files: ${unexpected.join(', ')}`)
    }
    const diff = runGit(['diff', '--cached', '--quiet'], gsdRoot, { allowFailure: true })
    if (diff.status === 0) {
      console.log(`No GSD changes to commit for ${slug}`)
      return { committed: false }
    }
    if (diff.status !== 1) {
      runGit(['reset', '-q', '--', ...paths], gsdRoot, { allowFailure: true })
      fail(`failed to inspect staged GSD diff: exit ${diff.status}`)
    }
    const commit = runGit(['commit', '-m', message], gsdRoot, { allowFailure: true })
    if (commit.status !== 0) {
      runGit(['reset', '-q', '--', ...paths], gsdRoot, { allowFailure: true })
      fail(`GSD commit failed: ${commit.stderr.trim() || `exit ${commit.status}`}`)
    }
    console.log(`Committed GSD task ${slug}: ${message}`)
    return { committed: true }
  })
}

function taskMarkdown({ slug, name, type, summary, now, note }) {
  const details = String(note || '').trim()
  return `# ${name}\n\n- task_slug: ${slug}\n- 任务类型: ${type}\n- 状态: 运行中\n- 创建时间: ${now}\n- 最后更新: ${now}\n- 简述: ${summary}\n\n${details ? `${details}\n\n` : ''}## 备注\n`
}

export function newGsdTask(options = {}) {
  const root = resolveProjectRoot(options)
  const slug = normalizeSlug(options['task-slug'] || options.taskSlug)
  const name = String(options['task-name'] || options.taskName || '').trim()
  const summary = String(options.summary || '').trim()
  if (!name || !summary || /[\r\n]/.test(name) || /[\r\n]/.test(summary)) fail('task name and summary must be non-empty single-line text')
  initGsdRepo({ projectRoot: root })
  const gsdRoot = join(root, '.gsd')
  withGsdWriteLock(gsdRoot, () => {
    assertEmptyGsdIndex(gsdRoot, 'task creation')
    const directory = join(gsdRoot, slug)
    if (pathExists(directory)) fail(`Task already exists: .gsd/${slug}`)
    mkdirSync(join(directory, '.planning'), { recursive: true })
    const now = nowIso()
    writeText(join(directory, 'TASK.md'), taskMarkdown({ slug, name, type: 'generic', summary, now, note: '' }))
  })
  switchActiveTask({ ...options, projectRoot: root, taskSlug: slug, deferCommit: true })
  gsdLocalCommit({ ...options, projectRoot: root, taskSlug: slug, message: `gsd(${slug}): 创建任务` })
  console.log(`Created GSD task: ${slug}`)
  return { root, slug }
}

export function setGsdTaskStatus(options = {}) {
  const root = resolveProjectRoot(options)
  const slug = normalizeSlug(options['task-slug'] || options.taskSlug)
  const status = String(options.status || '').trim()
  if (!['已暂停', '已完成'].includes(status)) fail(`invalid target status: ${status || '(empty)'}`)
  const gsdRoot = join(root, '.gsd')
  if (status === '已完成') assertFinalizationGate({ ...options, projectRoot: root, taskSlug: slug, requireCompleted: true, emit: false })
  let changed = false
  withGsdWriteLock(gsdRoot, () => {
    assertEmptyGsdIndex(gsdRoot, 'task status update')
    const task = readTaskRecord(root, slug)
    if (!task) fail(`TASK.md missing for ${slug}`)
    if (task.status === status) return
    if (task.status === '已完成') fail(`completed task cannot be reopened: ${slug}`)
    updateTaskStatusFile(root, slug, status)
    updateStateStatus(root, slug, status === '已暂停' ? 'paused' : 'completed')
    changed = true
  })
  if (changed) gsdLocalCommit({ ...options, projectRoot: root, taskSlug: slug, message: `gsd(${slug}): ${status === '已暂停' ? '暂停任务' : '完成任务'}` })
  if (status === '已完成' && activeWorkstream(options, root) === slug) {
    runGsdTools(options, ['query', 'workstream.set', '--clear', '--raw', '--cwd', root])
  }
  console.log(`GSD task status: ${slug} -> ${status}`)
  return { root, slug, status, changed }
}

export function bootstrapAutouiTask(options = {}) {
  const root = resolveProjectRoot(options)
  const slug = normalizeSlug(options['task-slug'] || options.taskSlug)
  const name = String(options['task-name'] || options.taskName || '').trim()
  if (!name || /[\r\n]/.test(name)) fail('task name must be non-empty single-line text')
  const brief = String(options['user-brief'] || options.userBrief || '').trim().replace(/\s+/g, ' ') || '待 discuss 阶段补充'
  initGsdRepo({ projectRoot: root })
  const gsdRoot = join(root, '.gsd')
  const taskDir = join(gsdRoot, slug)
  const planningDir = join(taskDir, '.planning')
  const now = nowIso()
  const screenshotDir = join(gsdRoot, slug, 'evidence', 'screenshots')
  withGsdWriteLock(gsdRoot, () => {
    assertEmptyGsdIndex(gsdRoot, 'AutoUI task creation')
    if (pathExists(taskDir)) fail(`Task already exists: .gsd/${slug}`)
    mkdirSync(planningDir, { recursive: true })
    const taskMd = taskMarkdown({
      slug,
      name,
      type: 'autoui',
      summary: brief,
      now,
      note: `## AutoUI 初始范围\n\n- 核心价值：在 AutoUI 规范下完成可运行、可验证、可恢复的 UI 交付闭环。\n- 证据目录：.gsd/${slug}/evidence/\n- 里程碑记录：.gsd/${slug}/milestones/MILESTONES.md\n\n### 初始边界\n\n- 未在 discuss 确认的协议或服务端改动不在范围内。\n- 未在 plan 写入边界的文件范围外修改不在范围内。\n\n### 约束\n\n- \`.gsd/\` 不进入项目主仓库。\n- 允许多个不同 task_slug 为运行中；同一 task_slug 只允许一个写入者。\n- 共享源码范围重叠时必须串行执行或使用独立 Git worktree。\n- UI 闸门、证据与验收规范以 yiui-auto-ui 为准。`,
    })
    const pathsMd = `# 证据路径约定\n\n- task_slug: ${slug}\n- 项目根: ${root}\n\n## evidence（AI 证据，按需建子目录）\n\n- logs: .gsd/${slug}/evidence/logs/\n- uivision: .gsd/${slug}/evidence/uivision/\n- tool-results: .gsd/${slug}/evidence/tool-results/\n- screenshots: .gsd/${slug}/evidence/screenshots/\n\n## milestones（用户向里程碑，非 AI 恢复源）\n\n- MILESTONES.md: .gsd/${slug}/milestones/MILESTONES.md\n- AUTOUI-RECORD.md: .gsd/${slug}/milestones/AUTOUI-RECORD.md\n- images: .gsd/${slug}/milestones/images/\n\n## notes\n\n- RUNTIME-ENTRY.md: 主界面/OpenYIUI 跑通后填写\n- SERVER-GAPS.md: 上游协议/字段缺失时填写\n- AI-LIMITATIONS.md: 需人工验收项\n\n## 截图工具默认 outputDirectory\n\n${screenshotDir}\n\n## git 约定\n\n- markdown 与证据路径索引提交到 .gsd 本地 git\n- 大二进制截图默认只 commit 路径引用\n`
    const milestonesMd = `# ${name} — 里程碑记录\n\n> 用户向回顾文档；**不作为 AI 恢复入口**。\n> 进度真相源：对应 workstream 的 STATE.md、phase PLAN/SUMMARY。\n\n## 基本信息\n\n| 项目 | 内容 |\n|---|---|\n| task_slug | ${slug} |\n| 进度源 | ../TASK.md、.planning/STATE.md |\n| 图片目录 | images/ |\n| 当前状态 | 进行中 |\n\n## 关键节点总览\n\n| 时间 | 阶段 | 用户向说明 | 做了什么 | 当前效果 | 图片/素材 | 下一步 |\n|---|---|---|---|---|---|---|\n`
    writeText(join(taskDir, 'TASK.md'), taskMd, { bom: true })
    writeText(join(taskDir, 'notes', 'PATHS.md'), pathsMd, { bom: true })
    writeText(join(taskDir, 'milestones', 'MILESTONES.md'), milestonesMd, { bom: true })
  })
  switchActiveTask({ ...options, projectRoot: root, taskSlug: slug, deferCommit: true })
  gsdLocalCommit({ ...options, projectRoot: root, taskSlug: slug, message: `gsd(${slug}): 创建 autoui 任务` })
  console.log(`Bootstrapped autoui task: ${slug}`)
  return { root, slug, taskDir, planningDir }
}

function readStateScalar(content, name) {
  const match = content.match(new RegExp(`^-\\s*${escapeRegExp(name)}:\\s*(.*?)\\s*$`, 'm'))
  return match ? match[1].trim() : ''
}

function readProgressInteger(frontMatter, name) {
  const lines = frontMatter.split(/\r?\n/)
  let inProgress = false
  for (const line of lines) {
    if (/^progress:\s*$/.test(line)) {
      inProgress = true
      continue
    }
    if (inProgress && /^\S/.test(line)) break
    if (inProgress) {
      const match = line.match(new RegExp(`^\\s+${escapeRegExp(name)}:\\s*(\\d+)\\s*$`))
      if (match) return Number(match[1])
    }
  }
  return null
}

function readCurrentCursor(stateContent) {
  const lines = stateContent.split(/\r?\n/)
  const start = lines.findIndex((line) => /^##\s+单向执行游标\s*$/.test(line))
  if (start < 0) return null
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) break
    const row = lines[index].match(/^\|\s*(?<cursor>[^|]+?)\s*\|\s*(?<item>[^|]+?)\s*\|\s*(?<status>[^|]+?)\s*\|/)
    if (!row) continue
    const cursor = row.groups.cursor.trim()
    const item = row.groups.item.trim()
    const status = row.groups.status.trim()
    if (cursor === '游标' || /^-+$/.test(cursor)) continue
    if (status !== 'GREEN' && status !== '已验证') return { cursor, item, status }
  }
  return null
}

function readPlanTitle(planPath, planNumber) {
  if (!existsSync(planPath)) return `Plan ${String(planNumber).padStart(2, '0')}（计划文件缺失）`
  const content = readText(planPath)
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^#\s+(.+?)\s*$/)
    if (!match) continue
    const title = match[1].trim().replace(/^Plan\s*\d+\s*[：:]?\s*/i, '').trim()
    if (title) return title
  }
  const objective = content.match(/<objective>\s*([\s\S]*?)\s*<\/objective>/i)
  if (objective) {
    const value = objective[1].replace(/\s+/g, ' ').trim()
    if (value) return value.length > 96 ? `${value.slice(0, 96)}...` : value
  }
  return `Plan ${String(planNumber).padStart(2, '0')}`
}

function walkFiles(directory) {
  const result = []
  if (!existsSync(directory)) return result
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...walkFiles(path))
    else if (entry.isFile()) result.push(path)
  }
  return result
}

function listPlanInfos(planningPath) {
  return walkFiles(planningPath)
    .map((path) => {
      const name = basename(path)
      const match = name.match(/^(\d+(?:-\d+)?)-PLAN\.md$/)
      if (!match) return null
      const id = match[1]
      const parts = id.split('-').map((part) => Number(part))
      const sortKey = parts.map((part) => String(part).padStart(8, '0')).join('-')
      return {
        id,
        sortKey,
        path,
        title: readPlanTitle(path, parts.at(-1)),
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
}

export function renderCodexPlan(options = {}) {
  const root = resolveProjectRoot(options)
  const trackerPath = join(root, '.gsd', 'TRACKER.md')
  if (!existsSync(trackerPath)) fail(`TRACKER.md 不存在，路径=${trackerPath}。`)
  const trackerContent = readText(trackerPath)
  const requestedSlug = String(options['task-slug'] || options.taskSlug || '').trim()
  let activeTaskSlug = requestedSlug ? normalizeSlug(requestedSlug) : activeWorkstream(options, root)
  let legacyTrackerSelection = false
  if (!activeTaskSlug) {
    // Migration fallback only. New TRACKER files deliberately have no active block.
    activeTaskSlug = parseTrackerField(trackerContent, 'task_slug')
    legacyTrackerSelection = Boolean(activeTaskSlug)
  }

  if (!activeTaskSlug) {
    return {
      schema_version: 1,
      active: false,
      task_slug: '',
      task_name: '',
      task_status: '',
      source: trackerPath,
      explanation: '当前会话没有选择 GSD 任务。',
      plan: [],
      diagnostics: [],
    }
  }

  activeTaskSlug = normalizeSlug(activeTaskSlug)
  const taskPath = join(root, '.gsd', activeTaskSlug, 'TASK.md')
  if (!existsSync(taskPath)) fail(`指定任务缺少 TASK.md，task_slug=${activeTaskSlug}，路径=${taskPath}。`)
  const taskContent = readText(taskPath)
  const taskStatus = parseTrackerField(taskContent, '状态') || (legacyTrackerSelection ? parseTrackerField(trackerContent, '状态') : '')
  const heading = taskContent.match(/^#\s+(.+?)\s*$/m)
  const taskName = heading?.[1]?.trim() || (legacyTrackerSelection ? parseTrackerField(trackerContent, '任务名称') : '') || activeTaskSlug
  let currentPhase = legacyTrackerSelection ? parseTrackerField(trackerContent, '当前阶段') : ''

  const planningPath = join(root, '.gsd', activeTaskSlug, '.planning')
  const statePath = join(planningPath, 'STATE.md')
  if (!existsSync(statePath)) fail(`任务缺少 STATE.md，task_slug=${activeTaskSlug}，路径=${statePath}。`)
  const stateContent = readText(statePath)
  const frontMatter = stateContent.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!frontMatter) fail(`STATE.md 缺少合法 YAML 前置区，路径=${statePath}。`)

  const totalPlans = readProgressInteger(frontMatter[1], 'total_plans')
  const completedPlans = readProgressInteger(frontMatter[1], 'completed_plans')
  if (totalPlans === null || completedPlans === null) {
    fail(`STATE.md progress 缺少 total_plans 或 completed_plans，路径=${statePath}。`)
  }
  if (totalPlans < 0 || completedPlans < 0 || completedPlans > totalPlans) {
    fail(`STATE.md progress 计数非法，completed_plans=${completedPlans}，total_plans=${totalPlans}。`)
  }

  const currentPlan = readStateScalar(stateContent, 'current_plan')
  const nextAction = readStateScalar(stateContent, 'next_action')
  const statePhase = readStateScalar(stateContent, 'current_phase')
  if (statePhase) currentPhase = statePhase
  const currentCursor = readCurrentCursor(stateContent)
  let currentPlanId = ''
  const currentPlanFile = currentPlan.match(/(\d+(?:-\d+)?)-PLAN\.md/)
  if (currentPlanFile) currentPlanId = currentPlanFile[1]
  else {
    const currentPlanNumber = currentPlan.match(/^(\d+(?:-\d+)?)\b/)
    if (currentPlanNumber) currentPlanId = currentPlanNumber[1]
  }

  const diagnostics = []
  const planInfos = listPlanInfos(planningPath)
  if (planInfos.length !== totalPlans) {
    diagnostics.push(`PLAN 文件数量与 STATE 不一致：files=${planInfos.length}，STATE.total_plans=${totalPlans}。`)
  }
  const currentPlanIndex = currentPlanId ? planInfos.findIndex((plan) => plan.id === currentPlanId) : -1
  if (completedPlans < totalPlans && currentPlanIndex >= 0 && currentPlanIndex !== completedPlans) {
    const expectedId = completedPlans < planInfos.length ? planInfos[completedPlans].id : 'unknown'
    diagnostics.push(`STATE.current_plan 与进度计数不一致：current_plan=${currentPlan}，期望计划=${expectedId}。`)
  }
  if (/待创建/.test(currentPlan) && currentPlanId) {
    const declared = planInfos.find((plan) => plan.id === currentPlanId)
    if (declared) diagnostics.push(`STATE.current_plan 仍标记待创建，但计划文件已存在：${declared.path}。`)
  }

  const activePlanIndex = completedPlans >= totalPlans
    ? null
    : currentPlanIndex >= completedPlans
      ? currentPlanIndex
      : completedPlans
  const plan = []
  for (let index = 0; index < totalPlans; index += 1) {
    const info = planInfos[index]
    const planId = info?.id || String(index + 1).padStart(2, '0')
    let title = info?.title || `Plan ${planId}（计划文件缺失）`
    let labelId = planId
    if (index === activePlanIndex && currentCursor) {
      const cursorTitle = currentCursor.item.replace(/^Plan\s*\d+(?:-\d+)?\s*[：:]?\s*/i, '').trim()
      if (cursorTitle) title = cursorTitle
      labelId = `${labelId}/${currentCursor.cursor}`
    }
    let status = 'pending'
    if (index < completedPlans) status = 'completed'
    else if (index === activePlanIndex && taskStatus === '运行中') status = 'in_progress'
    plan.push({ step: `[GSD ${labelId}] ${title}`, status })
  }

  const cursorSummary = currentCursor ? `，游标=${currentCursor.cursor}（${currentCursor.status}）` : ''
  return {
    schema_version: 1,
    active: true,
    task_slug: activeTaskSlug,
    task_name: taskName,
    task_status: taskStatus,
    current_phase: currentPhase,
    source: statePath,
    current_plan: currentPlan,
    current_cursor: currentCursor,
    next_action: nextAction,
    explanation: `GSD ${activeTaskSlug}：已完成 ${completedPlans}/${totalPlans}，当前计划=${currentPlan}${cursorSummary}。`,
    plan,
    diagnostics,
  }
}

function setTomlString(content, key, value, eol) {
  const line = `${key} = "${value}"`
  const keyPattern = new RegExp(`^${escapeRegExp(key)}\\s*=.*$`, 'm')
  if (keyPattern.test(content)) return content.replace(keyPattern, line)
  const developerPattern = /^developer_instructions\s*=/m
  if (!developerPattern.test(content)) fail(`Agent TOML missing developer_instructions: ${key}`)
  return content.replace(developerPattern, `${line}${eol}developer_instructions =`)
}

function formatBackupTimestamp() {
  const value = new Date()
  const pad = (n, width = 2) => String(n).padStart(width, '0')
  return `${value.getFullYear()}${pad(value.getMonth() + 1)}${pad(value.getDate())}-${pad(value.getHours())}${pad(value.getMinutes())}${pad(value.getSeconds())}${pad(value.getMilliseconds(), 3)}`
}

export function applyAgentPolicy(options = {}) {
  const codexHome = resolveCodexHome(options)
  const defaultsPath = resolveDefaultsPath(options)
  const verifyOnly = Boolean(options['verify-only'] || options.verifyOnly)
  const defaultsDirectory = dirname(defaultsPath)
  const agentsDirectory = join(codexHome, 'agents')
  const catalogPath = join(codexHome, 'gsd-core', 'bin', 'shared', 'model-catalog.json')
  if (!existsSync(catalogPath)) fail(`GSD model catalog not found: ${catalogPath}`)
  if (!existsSync(agentsDirectory)) fail(`Codex GSD agents directory not found: ${agentsDirectory}`)

  let defaults = {}
  const rawDefaults = readText(defaultsPath)
  if (rawDefaults.trim()) {
    try {
      defaults = JSON.parse(rawDefaults)
    } catch (error) {
      fail(`invalid GSD defaults JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (!isObject(defaults)) defaults = {}
  defaults.resolve_model_ids = 'omit'
  defaults.runtime = 'codex'
  defaults.model_profile = 'adaptive'
  defaults.subagent_timeout = 1800000
  const profileOverrides = isObject(defaults.model_profile_overrides) ? defaults.model_profile_overrides : {}
  profileOverrides.codex = { opus: 'gpt-5.6-sol', sonnet: 'gpt-5.6-sol', haiku: 'gpt-5.6-sol' }
  defaults.model_profile_overrides = profileOverrides
  const effort = isObject(defaults.effort) ? defaults.effort : {}
  const agentOverrides = isObject(effort.agent_overrides) ? effort.agent_overrides : {}
  effort.default = 'high'
  effort.routing_tier_defaults = { light: 'medium', standard: 'high', heavy: 'high' }
  effort.agent_overrides = agentOverrides
  defaults.effort = effort

  const expectedDefaults = `${JSON.stringify(defaults, null, 2)}\n`
  const currentDefaults = existsSync(defaultsPath) ? readText(defaultsPath) : ''
  const defaultsChanged = currentDefaults !== expectedDefaults
  let catalog
  try {
    catalog = JSON.parse(readText(catalogPath))
  } catch (error) {
    fail(`invalid GSD model catalog JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const agentFiles = readdirSync(agentsDirectory)
    .filter((name) => /^gsd-.*\.toml$/.test(name))
    .sort()
    .map((name) => join(agentsDirectory, name))
  if (!agentFiles.length) fail(`No GSD Codex agent TOML files found in: ${agentsDirectory}`)

  const timestamp = formatBackupTimestamp()
  const backupRoot = join(codexHome, 'gsd-user-files-backup', `agent-policy-${timestamp}`)
  const agentChanges = []
  let flexRemoved = 0
  const violations = []

  for (const path of agentFiles) {
    const fileName = basename(path)
    const agentName = fileName.slice(0, -'.toml'.length)
    const catalogAgent = catalog?.agents?.[agentName]
    const routingTier = catalogAgent ? String(catalogAgent.routingTier || 'standard') : 'standard'
    const expectedEffort = routingTier === 'light' ? 'medium' : 'high'
    const content = readText(path)
    const eol = content.includes('\r\n') ? '\r\n' : '\n'
    const hadFlex = /^service_tier\s*=\s*"flex"\s*$/m.test(content)
    let updated = content.replace(/^service_tier\s*=\s*"flex"\s*\r?\n?/gm, '')
    updated = setTomlString(updated, 'model', 'gpt-5.6-sol', eol)
    updated = setTomlString(updated, 'model_reasoning_effort', expectedEffort, eol)

    if (updated !== content) {
      agentChanges.push({ agent: agentName, tier: routingTier, effort: expectedEffort })
      if (hadFlex) flexRemoved += 1
      if (!verifyOnly) {
        const agentBackupDirectory = join(backupRoot, 'agents')
        mkdirSync(agentBackupDirectory, { recursive: true })
        copyFileSync(path, join(agentBackupDirectory, fileName))
        writeText(path, updated)
      }
    }

    const verificationContent = verifyOnly ? content : updated
    if (!/^model\s*=\s*"gpt-5\.6-sol"\s*$/m.test(verificationContent)) violations.push(`${agentName} model`)
    if (!new RegExp(`^model_reasoning_effort\\s*=\\s*"${escapeRegExp(expectedEffort)}"\\s*$`, 'm').test(verificationContent)) {
      violations.push(`${agentName} effort`)
    }
    if (/^service_tier\s*=\s*"flex"\s*$/m.test(verificationContent)) violations.push(`${agentName} flex`)
  }

  if (defaultsChanged && !verifyOnly) {
    mkdirSync(defaultsDirectory, { recursive: true })
    if (existsSync(defaultsPath)) {
      mkdirSync(backupRoot, { recursive: true })
      copyFileSync(defaultsPath, join(backupRoot, 'defaults.json'))
    }
    writeText(defaultsPath, expectedDefaults)
  }

  const result = {
    mode: verifyOnly ? 'verify' : 'apply',
    defaults_path: defaultsPath,
    defaults_changed: defaultsChanged,
    agents_checked: agentFiles.length,
    agents_changed: agentChanges.length,
    flex_removed: flexRemoved,
    backup_path: !verifyOnly && pathExists(backupRoot) ? backupRoot : null,
    violations,
  }
  if (options.emit !== false) console.log(JSON.stringify(result, null, 2))
  return result
}

function parseFinalizationState(statePath) {
  const content = readText(statePath)
  const frontMatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!frontMatter) fail(`STATE.md 缺少合法的 YAML 前置区，路径=${statePath}。`)
  const lines = frontMatter[1].split(/\r?\n/)
  const indexes = lines.reduce((result, line, index) => {
    if (/^finalization:\s*$/.test(line)) result.push(index)
    return result
  }, [])
  if (!indexes.length) fail(`STATE.md 的 YAML 前置区缺少 finalization，路径=${statePath}。`)
  if (indexes.length > 1) fail(`STATE.md 的 YAML 前置区存在重复 finalization，数量=${indexes.length}，路径=${statePath}。`)
  const fields = {}
  for (let index = indexes[0] + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\S/.test(line)) break
    if (!line.trim()) continue
    const match = line.match(/^  (?<name>[a-z_]+):\s*(?<value>.*?)\s*$/)
    if (!match) fail(`finalization 包含无法识别的行，行内容=${line}。`)
    if (Object.hasOwn(fields, match.groups.name)) fail(`finalization 包含重复字段，字段=${match.groups.name}。`)
    fields[match.groups.name] = match.groups.value
  }
  return fields
}

function readIntegerField(fields, name, minimum) {
  if (!Object.hasOwn(fields, name)) fail(`STATE.md 的 finalization 缺少字段，字段=${name}。`)
  if (!/^-?\d+$/.test(fields[name])) fail(`STATE.md 的 finalization 字段必须是整数，字段=${name}，实际值=${fields[name]}。`)
  const value = Number(fields[name])
  if (value < minimum) fail(`STATE.md 的 finalization 字段超出允许范围，字段=${name}，实际值=${value}，最小值=${minimum}。`)
  return value
}

export function assertFinalizationGate(options = {}) {
  const root = resolveProjectRoot(options)
  const explicitStatePath = String(options['state-path'] || options.statePath || '').trim()
  let taskSlug = String(options['task-slug'] || options.taskSlug || '').trim()
  if (!explicitStatePath && !taskSlug) taskSlug = activeWorkstream(options, root)
  if (taskSlug) taskSlug = normalizeSlug(taskSlug)
  if (!explicitStatePath && !taskSlug) fail('未指定 task_slug，且当前会话没有选择 GSD 任务。')
  const statePath = resolve(explicitStatePath || join(root, '.gsd', taskSlug, '.planning', 'STATE.md'))
  if (!existsSync(statePath)) fail(`STATE.md 不存在，路径=${statePath}。`)
  const fields = parseFinalizationState(statePath)
  const changeGeneration = readIntegerField(fields, 'change_generation', 0)
  const reviewedGeneration = readIntegerField(fields, 'reviewed_generation', -1)
  const blockingFindings = readIntegerField(fields, 'blocking_findings', 0)
  const finalVerifiedGeneration = readIntegerField(fields, 'final_verified_generation', -1)
  const finalVerificationRuns = readIntegerField(fields, 'final_verification_runs', 0)
  if (!Object.hasOwn(fields, 'scope_frozen')) fail('STATE.md 的 finalization 缺少字段，字段=scope_frozen。')
  if (!/^(true|false)$/i.test(fields.scope_frozen)) fail(`STATE.md 的 finalization 字段必须是 true 或 false，字段=scope_frozen，实际值=${fields.scope_frozen}。`)
  const scopeFrozen = fields.scope_frozen.toLowerCase() === 'true'
  if (reviewedGeneration !== changeGeneration) fail(`阻断级审查尚未在当前变更代际收敛，change_generation=${changeGeneration}，reviewed_generation=${reviewedGeneration}。`)
  if (!scopeFrozen) fail(`当前范围尚未冻结，scope_frozen=${scopeFrozen}。`)
  if (blockingFindings !== 0) fail(`仍有未关闭的阻断项，blocking_findings=${blockingFindings}。`)
  const requireCompleted = Boolean(options['require-completed'] || options.requireCompleted)
  if (requireCompleted) {
    if (finalVerifiedGeneration !== changeGeneration) fail(`最终验收代际不是当前变更代际，change_generation=${changeGeneration}，final_verified_generation=${finalVerifiedGeneration}。`)
    if (finalVerificationRuns < 1) fail(`尚无形成有效结果的最终验收，final_verification_runs=${finalVerificationRuns}。`)
  }
  const mode = requireCompleted ? '完成门禁' : '终验前门禁'
  if (options.emit !== false) {
    console.log(`${mode} 通过：STATE=${statePath}，change_generation=${changeGeneration}，scope_frozen=true，blocking_findings=0。`)
  }
  return { statePath, changeGeneration, requireCompleted }
}

function listMatchingEntries(directory, pattern) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => pattern.test(entry.name))
    .map((entry) => entry.name)
}

function verifyLine(ok, message, state) {
  console.log(`  [${ok ? 'ok' : 'FAIL'}] ${message}`)
  if (!ok) state.fail = true
}

export function verifyInstall(options = {}) {
  const root = resolveProjectRoot(options)
  const state = { fail: false }
  const skillPath = join(root, '.agents', 'skills', 'yiui-gsd', 'SKILL.md')
  const skillRoot = dirname(skillPath)
  console.log(`verify yiui-gsd @ ${root}`)
  verifyLine(existsSync(skillPath), 'project skill .agents/skills/yiui-gsd/SKILL.md', state)
  for (const name of [
    'extra-codex-agent-policy.md',
    'extra-finalization-gate.md',
    'extra-junction-bridge.md',
    'extra-phrase-map.md',
    'extra-planning-efficiency.md',
    'extra-tracker-schema.md',
  ]) {
    verifyLine(existsSync(join(skillRoot, name)), `skill reference ${name}`, state)
  }
  for (const name of [
    'apply-codex-agent-policy.ps1',
    'assert-finalization-gate.ps1',
    'bootstrap-autoui-task.ps1',
    'gsd-local-commit.ps1',
    'init-gsd-repo.ps1',
    'new-gsd-task.ps1',
    'render-codex-plan.ps1',
    'set-gsd-task-status.ps1',
    'switch-active-task.ps1',
    'update-gsd-tracker.ps1',
    'yiui-gsd.mjs',
  ]) {
    verifyLine(existsSync(join(skillRoot, 'scripts', name)), `skill script ${name}`, state)
  }
  verifyLine(!existsSync(join(skillRoot, 'scripts', 'bootstrap_autoui_task.py')), 'AutoUI bootstrap has no Python dependency', state)

  const claudeSkill = join(root, '.claude', 'skills', 'yiui-gsd')
  verifyLine(pathExists(claudeSkill) && existsSync(join(claudeSkill, 'SKILL.md')), 'claude skill entry resolves: .claude/skills/yiui-gsd', state)
  const claudeRules = join(root, '.claude', 'CLAUDE.md')
  verifyLine(existsSync(claudeRules) && readText(claudeRules).includes('yiui-gsd'), '.claude/CLAUDE.md pins yiui-gsd', state)

  const projectSkillDir = join(root, '.agents', 'skills')
  const vendored = listMatchingEntries(projectSkillDir, /^gsd-/)
  verifyLine(!vendored.length, 'no official gsd-* under project .agents/skills', state)

  const codexHome = resolveCodexHome(options)
  const versionPath = join(codexHome, 'gsd-core', 'VERSION')
  verifyLine(existsSync(versionPath), existsSync(versionPath) ? `GSD core VERSION=${readText(versionPath).trim()} (${join(codexHome, 'gsd-core')})` : `missing ${versionPath} (run install.sh)`, state)
  const globalSkills = listMatchingEntries(join(homedir(), '.agents', 'skills'), /^gsd-/)
  verifyLine(globalSkills.length >= 5, `global gsd-* skills count=${globalSkills.length}`, state)
  const agentEntries = listMatchingEntries(join(codexHome, 'agents'), /^gsd-.*\.(toml|md)$/)
  verifyLine(agentEntries.length >= 5, `codex gsd-* agents count=${agentEntries.length}`, state)

  try {
    const policy = applyAgentPolicy({ ...options, codexHome, verifyOnly: true, emit: false })
    const policyOk = !policy.defaults_changed && policy.agents_changed === 0 && policy.violations.length === 0
    verifyLine(policyOk, policyOk ? `agent policy clean (${policy.agents_checked} TOML files)` : `agent policy drift: defaults_changed=${policy.defaults_changed}, agents_changed=${policy.agents_changed}, violations=${policy.violations.join(', ') || 'none'}`, state)
  } catch (error) {
    verifyLine(false, `agent policy check failed: ${error instanceof Error ? error.message : String(error)}`, state)
  }

  const gsdRoot = join(root, '.gsd')
  if (pathExists(join(gsdRoot, '.git'))) console.log('  [ok] .gsd local git present')
  else if (pathExists(gsdRoot)) console.log('  [ok] .gsd present (no .git yet — run install --init-gsd)')
  else console.log('  [ok] .gsd not initialized (optional; use --init-gsd or first GSD task)')
  if (state.fail) {
    console.log('verify FAILED')
    process.exitCode = 1
  } else {
    console.log('verify OK')
  }
  return !state.fail
}

function parseArgs(argv) {
  const [command = '', ...tokens] = argv
  const options = {}
  const positional = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('-')) {
      positional.push(token)
      continue
    }
    const key = token.replace(/^-+/, '').replace(/_/g, '-').toLowerCase()
    const next = tokens[index + 1]
    if (next && !next.startsWith('-')) {
      options[key] = next
      index += 1
    } else {
      options[key] = true
    }
  }
  return { command: command.toLowerCase(), options, positional }
}

export function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv)
  switch (command) {
    case 'init-gsd-repo':
      return initGsdRepo(options)
    case 'switch-active-task':
      return switchActiveTask(options)
    case 'new-gsd-task':
      return newGsdTask(options)
    case 'set-gsd-task-status':
      return setGsdTaskStatus(options)
    case 'update-gsd-tracker':
      return updateGsdTracker(options)
    case 'gsd-local-commit':
      return gsdLocalCommit(options)
    case 'render-codex-plan':
    case 'render-plan': {
      const result = renderCodexPlan(options)
      console.log(JSON.stringify(result, null, 2))
      return result
    }
    case 'apply-codex-agent-policy':
    case 'apply-agent-policy': {
      const result = applyAgentPolicy(options)
      if (options['verify-only'] && (result.defaults_changed || result.agents_changed || result.violations.length)) {
        process.exitCode = 1
      }
      return result
    }
    case 'assert-finalization-gate':
      return assertFinalizationGate(options)
    case 'bootstrap-autoui-task':
      return bootstrapAutouiTask(options)
    case 'verify-install':
      return verifyInstall(options)
    default:
      fail(`unknown yiui-gsd helper command: ${command || '(missing)'}`)
  }
}

function isMainModule() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(SCRIPT_PATH)
  } catch {
    return resolve(process.argv[1]) === resolve(SCRIPT_PATH)
  }
}

if (isMainModule()) {
  try {
    main()
  } catch (error) {
    console.error(`yiui-gsd: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
