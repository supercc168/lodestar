import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  type BridgeHealth,
  ensureWorkstreamRoute,
  normalizeTaskSlug,
  planningHealth,
} from './gsd-bridge'

export type GsdTaskStatus = '无任务' | '运行中' | '已暂停' | '已完成'

/** Fine-grained plan/cursor progress read from the selected task STATE.md. */
export type GsdProgressDetail = {
  completedPlans: number | null
  totalPlans: number | null
  completedPhases: number | null
  totalPhases: number | null
  percent: number | null
  currentPlan: string
  nextAction: string
  cursor?: {
    cursor: string
    item: string
    status: string
  }
}

export type GsdSnapshot = {
  status: GsdTaskStatus
  taskSlug: string
  taskName: string
  phase: string
  updatedAt: string
  planningPath: string
  note: string
  bridge: BridgeHealth
  phaseHint?: string
  /** Present when STATE.md yields at least one useful progress field. */
  progress?: GsdProgressDetail
  /** Deterministic summary of every unfinished task; selection remains session-local. */
  unfinishedTasks: GsdTaskSummary[]
}

export type GsdTaskSummary = {
  taskSlug: string
  taskName: string
  taskType: string
  status: Exclude<GsdTaskStatus, '无任务' | '已完成'>
  phase: string
  createdAt: string
  updatedAt: string
  summary: string
}

type GsdTaskRecord = Omit<GsdTaskSummary, 'status'> & {
  status: Exclude<GsdTaskStatus, '无任务'>
  taskContent: string
  stateContent: string
}

const TRACKER_FILE = 'TRACKER.md'
const TASK_FILE = 'TASK.md'
const LOCK_TIMEOUT_MS = 30_000
const LOCK_RETRY_MS = 100
const DEFAULT_TRACKER = `# GSD 任务跟踪

> 这里只列出未完成任务。当前会话选择由 GSD session-local workstream 保存，不属于任务状态。

## 未完成任务

| task_slug | 名称 | 类型 | 状态 | 当前阶段 | 创建时间 | 最后更新 | 简述 |
|-----------|------|------|------|----------|----------|----------|------|
`

const ACTIVE_FIELDS = [
  '状态',
  'task_slug',
  '任务名称',
  '当前阶段',
  '最后更新',
  'planning_path',
  '备注',
] as const

type ActiveField = (typeof ACTIVE_FIELDS)[number]

type ActiveBlock = {
  状态: string
  task_slug: string
  任务名称: string
  当前阶段: string
  最后更新: string
  planning_path: string
  备注: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function withGsdWriteLock<T>(projectRoot: string, operation: () => T): T {
  const gsdRoot = join(projectRoot, '.gsd')
  const gitRoot = join(gsdRoot, '.git')
  if (!existsSync(gitRoot)) throw new Error(`GSD local git missing: ${gsdRoot}`)
  const lockPath = join(gitRoot, 'yiui-gsd-write.lock')
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  while (true) {
    try {
      mkdirSync(lockPath)
      writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, at: nowIso() }))
      break
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error
      try {
        const owner = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'))
        const stale = Date.now() - statSync(lockPath).mtimeMs >= LOCK_TIMEOUT_MS
        if (stale && !processIsAlive(Number(owner.pid))) {
          rmSync(lockPath, { recursive: true, force: true })
          continue
        }
      } catch {
        // A half-created lock is only removable after the same stale timeout.
        try {
          if (Date.now() - statSync(lockPath).mtimeMs >= LOCK_TIMEOUT_MS) {
            rmSync(lockPath, { recursive: true, force: true })
            continue
          }
        } catch {}
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for GSD write lock: ${lockPath}`)
      sleep(LOCK_RETRY_MS)
    }
  }
  try {
    return operation()
  } finally {
    rmSync(lockPath, { recursive: true, force: true })
  }
}

function runGit(
  projectRoot: string,
  args: string[],
  opts?: { allowFailure?: boolean },
): { status: number; stdout: string; stderr: string } {
  const gsdRoot = join(projectRoot, '.gsd')
  const result = spawnSync('git', args, { cwd: gsdRoot, encoding: 'utf8' })
  if (result.error) throw new Error(`git ${args.join(' ')} failed: ${result.error.message}`)
  const status = result.status ?? 1
  if (status !== 0 && !opts?.allowFailure) {
    const detail = (result.stderr || result.stdout || '').trim()
    throw new Error(`git ${args.join(' ')} failed with exit ${status}${detail ? `: ${detail}` : ''}`)
  }
  return { status, stdout: result.stdout || '', stderr: result.stderr || '' }
}

function writeFileAtomic(path: string, content: string): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  const tempPath = join(directory, `.${randomUUID()}.tmp`)
  try {
    writeFileSync(tempPath, content, 'utf8')
    renameSync(tempPath, path)
  } finally {
    rmSync(tempPath, { force: true })
  }
}

function trackerPath(projectRoot: string): string {
  return join(projectRoot, '.gsd', TRACKER_FILE)
}

function taskDir(projectRoot: string, slug: string): string {
  return join(projectRoot, '.gsd', slug)
}

function taskPath(projectRoot: string, slug: string): string {
  return join(taskDir(projectRoot, slug), TASK_FILE)
}

function planningPathFor(slug: string): string {
  return slug ? `.gsd/${slug}/.planning/` : ''
}

function emptyActive(): ActiveBlock {
  return {
    状态: '无任务',
    task_slug: '',
    任务名称: '',
    当前阶段: 'unknown',
    最后更新: '',
    planning_path: '',
    备注: '',
  }
}

function parseActiveFieldLine(line: string): { key: ActiveField; value: string } | null {
  const m = line.match(/^- ([^：:]+)[：:]\s*(.*)$/)
  if (!m) return null
  const key = m[1].trim() as ActiveField
  if (!(ACTIVE_FIELDS as readonly string[]).includes(key)) return null
  return { key, value: m[2].trim() }
}

function readTrackerRaw(projectRoot: string): string {
  const p = trackerPath(projectRoot)
  if (!existsSync(p)) return DEFAULT_TRACKER
  return readFileSync(p, 'utf8')
}

function parseActiveBlock(content: string): ActiveBlock {
  const active = emptyActive()
  const lines = content.split(/\r?\n/)
  let inActive = false
  for (const line of lines) {
    if (/^##\s*当前活跃任务/.test(line)) {
      inActive = true
      continue
    }
    if (inActive && /^##\s+/.test(line)) break
    if (!inActive) continue
    const field = parseActiveFieldLine(line)
    if (field) active[field.key] = field.value
  }
  return active
}
function isTableSeparator(line: string): boolean {
  return /^\|[\s\-|:]+\|$/.test(line.trim())
}

function isTableRow(line: string): boolean {
  const t = line.trim()
  return t.startsWith('|') && t.endsWith('|') && !isTableSeparator(t)
}

function parseTableCells(line: string): string[] {
  const t = line.trim()
  const inner = t.slice(1, t.endsWith('|') ? -1 : undefined)
  return inner.split('|').map((c) => c.trim())
}
function writeTracker(projectRoot: string, content: string): void {
  mkdirSync(join(projectRoot, '.gsd'), { recursive: true })
  writeFileAtomic(trackerPath(projectRoot), content.endsWith('\n') ? content : content + '\n')
}

function writeTaskMd(
  projectRoot: string,
  slug: string,
  name: string,
  status: GsdTaskStatus,
  updated: string,
  created?: string,
): void {
  const dir = taskDir(projectRoot, slug)
  mkdirSync(dir, { recursive: true })
  const p = taskPath(projectRoot, slug)
  let createdAt = created ?? updated
  if (existsSync(p)) {
    const prev = readFileSync(p, 'utf8')
    const m = prev.match(/^- 创建时间:\s*(.*)$/m)
    if (m?.[1]?.trim()) createdAt = m[1].trim()
  }
  const body = `# ${name}

- task_slug: ${slug}
- 任务类型: generic
- 状态: ${status}
- 创建时间: ${createdAt}
- 最后更新: ${updated}
- 简述:

## 备注
`
  writeFileAtomic(p, body)
}
function stripScalar(raw: string): string {
  return raw.trim().replace(/^['"]|['"]$/g, '')
}

function readProgressInteger(frontMatter: string, name: string): number | null {
  // JS has no \z; capture indented lines after `progress:` until a non-indented line or EOF.
  const progressMatch = frontMatter.match(
    /^progress:\s*\r?\n((?:[ \t]+[^\r\n]*(?:\r?\n|$))*)/m,
  )
  if (!progressMatch?.[1]) return null
  const field = progressMatch[1].match(
    new RegExp(`^[ \\t]+${name}:\\s*(\\d+)\\s*$`, 'm'),
  )
  if (!field?.[1]) return null
  const n = Number.parseInt(field[1], 10)
  return Number.isFinite(n) ? n : null
}

function readStateBodyScalar(content: string, name: string): string {
  // Prefer list form used by yiui-gsd / render-codex-plan: `- current_plan: ...`
  const list = content.match(
    new RegExp(`^\\-\\s*${name}:\\s*(.+?)\\s*$`, 'im'),
  )
  if (list?.[1]) return stripScalar(list[1])
  // Bold markdown: **Current plan:** ...
  const bold = content.match(
    new RegExp(`\\*\\*${name}\\*\\*\\s*[:：]\\s*(.+?)\\s*$`, 'im'),
  )
  if (bold?.[1]) return stripScalar(bold[1])
  // Plain "Current plan: ..." / "current_plan: ..."
  const plain = content.match(
    new RegExp(`^(?:#+\\s*)?${name}\\s*[:：=]\\s*(.+?)\\s*$`, 'im'),
  )
  if (plain?.[1]) return stripScalar(plain[1])
  return ''
}

function readCurrentCursor(
  stateContent: string,
): GsdProgressDetail['cursor'] | undefined {
  // JS has no \z; take heading body then cut at the next ## heading.
  const section = stateContent.match(/^##\s+单向执行游标\s*\r?\n([\s\S]*)/m)
  if (!section?.[1]) return undefined
  let body = section[1]
  const nextHeading = body.search(/^##\s+/m)
  if (nextHeading >= 0) body = body.slice(0, nextHeading)

  const rowRe = /^\|\s*([^|\r\n]+?)\s*\|\s*([^|\r\n]+?)\s*\|\s*([^|\r\n]+?)\s*\|/gm
  let m: RegExpExecArray | null
  while ((m = rowRe.exec(body)) !== null) {
    const cursor = m[1].trim()
    const item = m[2].trim()
    const status = m[3].trim()
    if (cursor === '游标' || /^-+$/.test(cursor.replace(/\s/g, ''))) continue
    if (status === 'GREEN' || status === '已验证') continue
    return { cursor, item, status }
  }
  return undefined
}

/**
 * Parse plan/phase progress from STATE.md text.
 * Aligns with `yiui-gsd.mjs render-codex-plan` field names.
 * Missing or partial STATE is non-fatal — returns undefined when nothing useful.
 */
export function parseStateProgress(stateContent: string): GsdProgressDetail | undefined {
  // YAML frontmatter at start of file (JS has no \A; use ^ without /m).
  const fm = stateContent.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  const frontMatter = fm?.[1] ?? ''

  let totalPlans = frontMatter ? readProgressInteger(frontMatter, 'total_plans') : null
  let completedPlans = frontMatter
    ? readProgressInteger(frontMatter, 'completed_plans')
    : null
  let totalPhases = frontMatter
    ? readProgressInteger(frontMatter, 'total_phases')
    : null
  let completedPhases = frontMatter
    ? readProgressInteger(frontMatter, 'completed_phases')
    : null
  let percent = frontMatter ? readProgressInteger(frontMatter, 'percent') : null

  // Body fallbacks: "Plan: 2 of 5" / "Progress: 40%"
  // Only used when frontmatter counters are missing. "Plan A of B" is a
  // position line — treat A as completed when status says phase/plan complete,
  // otherwise A-1 (in progress on plan A).
  if (totalPlans == null || completedPlans == null) {
    const planOf = stateContent.match(
      /Plan\s*[:：]\s*(\d+)\s+of\s+(\d+)/i,
    )
    if (planOf) {
      if (totalPlans == null) {
        const total = Number.parseInt(planOf[2], 10)
        totalPlans = Number.isFinite(total) ? total : null
      }
      if (completedPlans == null) {
        const current = Number.parseInt(planOf[1], 10)
        if (Number.isFinite(current)) {
          const statusLine = stateContent.match(
            /(?:\*\*)?Status(?:\*\*)?\s*[:：]\s*(.+)$/im,
          )
          const statusText = statusLine?.[1]?.trim() ?? ''
          const looksComplete =
            /phase\s*complete|complete|completed|done|finished/i.test(statusText) ||
            (totalPlans != null && current >= totalPlans && /100\s*%/.test(stateContent))
          completedPlans = looksComplete
            ? Math.min(current, totalPlans ?? current)
            : Math.max(0, current - 1)
        }
      }
    }
  }
  if (
    totalPlans != null &&
    completedPlans != null &&
    (totalPlans < 0 || completedPlans < 0 || completedPlans > totalPlans)
  ) {
    // Illegal counters — drop plan counts before deriving percent
    totalPlans = null
    completedPlans = null
  }

  if (percent == null) {
    const bar = stateContent.match(/Progress\s*[:：].*?(\d+)\s*%/i)
    if (bar?.[1]) {
      const p = Number.parseInt(bar[1], 10)
      if (Number.isFinite(p) && p >= 0 && p <= 100) percent = p
    }
  }
  if (
    percent == null &&
    totalPlans != null &&
    totalPlans > 0 &&
    completedPlans != null &&
    completedPlans >= 0
  ) {
    percent = Math.round((completedPlans / totalPlans) * 100)
  }
  if (percent != null && (percent < 0 || percent > 100)) {
    percent = null
  }

  const currentPlan =
    readStateBodyScalar(stateContent, 'current_plan') ||
    readStateBodyScalar(stateContent, 'Current plan') ||
    readStateBodyScalar(stateContent, '当前计划')
  const nextAction =
    readStateBodyScalar(stateContent, 'next_action') ||
    readStateBodyScalar(stateContent, 'Next action') ||
    readStateBodyScalar(stateContent, '下一步')
  const cursor = readCurrentCursor(stateContent)

  const has =
    totalPlans != null ||
    completedPlans != null ||
    totalPhases != null ||
    completedPhases != null ||
    percent != null ||
    !!currentPlan ||
    !!nextAction ||
    !!cursor
  if (!has) return undefined

  return {
    completedPlans,
    totalPlans,
    completedPhases,
    totalPhases,
    percent,
    currentPlan,
    nextAction,
    cursor,
  }
}
function normalizeStatus(raw: string): GsdTaskStatus {
  const s = raw.trim()
  if (s === '运行中' || s === '已暂停' || s === '已完成' || s === '无任务') return s
  if (!s) return '无任务'
  if (/暂停/.test(s)) return '已暂停'
  if (/完成/.test(s)) return '已完成'
  if (/运行/.test(s)) return '运行中'
  return '无任务'
}

/**
 * Stable task-dir slug from a display name.
 * - Prefer ASCII/latin/digits (kebab-case) when present.
 * - Pure CJK / non-latin names fall back to `t-` + sha1 hex prefix so
 *   distinct Chinese names don't all collide on `task` / `task-2`.
 */
export function slugifyTaskName(name: string): string {
  const nfkd = name.normalize('NFKD').replace(/[̀-ͯ]/g, '')
  const lowered = nfkd.toLowerCase()
  // Keep a-z0-9; replace other runs with single hyphen
  let slug = lowered
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
  if (!slug) {
    const hash = createHash('sha1').update(name).digest('hex').slice(0, 8)
    return `t-${hash}`
  }
  return slug
}

function uniqueSlug(projectRoot: string, base: string): string {
  const root = base || 'task'
  if (!existsSync(taskDir(projectRoot, root))) return root
  let n = 2
  while (existsSync(taskDir(projectRoot, `${root}-${n}`))) n++
  return `${root}-${n}`
}
function readNamedTaskField(content: string, name: string): string {
  const match = content.match(new RegExp('^-\\s*' + name + '[：:]\\s*(.*?)\\s*$', 'm'))
  return match?.[1]?.trim() || ''
}

function readGitFile(projectRoot: string, relativePath: string): string | null {
  const result = runGit(projectRoot, ['show', 'HEAD:' + relativePath], { allowFailure: true })
  return result.status === 0 ? result.stdout.replace(/^\uFEFF/, '') : null
}

type LegacyTaskMetadata = {
  name?: string
  type?: string
  status?: string
  phase?: string
  created?: string
  updated?: string
  summary?: string
}

function legacyTaskMetadata(content: string): Map<string, LegacyTaskMetadata> {
  const result = new Map<string, LegacyTaskMetadata>()
  for (const line of content.split(/\r?\n/)) {
    if (!isTableRow(line)) continue
    const cells = parseTableCells(line)
    if (!cells[0] || cells[0] === 'task_slug') continue
    if (cells.length >= 8) {
      result.set(cells[0], {
        name: cells[1],
        type: cells[2],
        status: cells[3],
        phase: cells[4],
        created: cells[5],
        updated: cells[6],
        summary: cells[7],
      })
    } else if (cells.length >= 5) {
      result.set(cells[0], {
        name: cells[1],
        status: cells[2],
        created: cells[3],
        updated: cells[4],
      })
    }
  }
  const active = parseActiveBlock(content)
  if (active.task_slug) {
    result.set(active.task_slug, {
      ...(result.get(active.task_slug) || {}),
      name: active.任务名称 || result.get(active.task_slug)?.name,
      status: active.状态 || result.get(active.task_slug)?.status,
      phase: active.当前阶段 || result.get(active.task_slug)?.phase,
      updated: active.最后更新 || result.get(active.task_slug)?.updated,
    })
  }
  return result
}

function taskSlugs(projectRoot: string, committed: boolean): string[] {
  const result = new Set<string>()
  const gsdRoot = join(projectRoot, '.gsd')
  if (!committed && existsSync(gsdRoot)) {
    for (const entry of readdirSync(gsdRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(gsdRoot, entry.name, TASK_FILE))) {
        result.add(entry.name)
      }
    }
  }
  const tree = runGit(projectRoot, ['ls-tree', '-r', '--name-only', 'HEAD'], { allowFailure: true })
  if (tree.status === 0) {
    for (const path of tree.stdout.split(/\r?\n/)) {
      const match = path.match(/^([^/]+)\/TASK\.md$/)
      if (match) result.add(match[1])
    }
  }
  return [...result].sort()
}

function readTaskRecord(
  projectRoot: string,
  slug: string,
  committed = false,
): GsdTaskRecord | null {
  const taskRelative = slug + '/TASK.md'
  const stateRelative = slug + '/.planning/STATE.md'
  const taskContent = committed
    ? readGitFile(projectRoot, taskRelative)
    : (existsSync(join(projectRoot, '.gsd', taskRelative))
      ? readFileSync(join(projectRoot, '.gsd', taskRelative), 'utf8').replace(/^\uFEFF/, '')
      : null)
  if (!taskContent) return null
  const trackerContent = committed
    ? (readGitFile(projectRoot, TRACKER_FILE) || '')
    : readTrackerRaw(projectRoot)
  const fallback = legacyTaskMetadata(trackerContent).get(slug) || {}
  const declaredSlug = readNamedTaskField(taskContent, 'task_slug')
  if (declaredSlug && declaredSlug !== slug) {
    throw new Error('TASK.md task_slug mismatch, directory=' + slug + ', value=' + declaredSlug)
  }
  const rawStatus = readNamedTaskField(taskContent, '状态') || fallback.status || ''
  const status = normalizeStatus(rawStatus)
  if (status === '无任务') throw new Error('TASK.md status missing or invalid: ' + taskRelative)
  const stateContent = committed
    ? (readGitFile(projectRoot, stateRelative) || '')
    : (existsSync(join(projectRoot, '.gsd', stateRelative))
      ? readFileSync(join(projectRoot, '.gsd', stateRelative), 'utf8').replace(/^\uFEFF/, '')
      : '')
  const heading = taskContent.match(/^#\s+(.+?)\s*$/m)
  const phase = (
    readStateBodyScalar(stateContent, 'current_phase') ||
    fallback.phase ||
    'unknown'
  )
  return {
    taskSlug: slug,
    taskName: heading?.[1]?.trim() || fallback.name || slug,
    taskType: readNamedTaskField(taskContent, '任务类型') || fallback.type || 'generic',
    status,
    phase,
    createdAt: readNamedTaskField(taskContent, '创建时间') || fallback.created || '',
    updatedAt: readNamedTaskField(taskContent, '最后更新') || fallback.updated || '',
    summary: readNamedTaskField(taskContent, '简述') || fallback.summary || '',
    taskContent,
    stateContent,
  }
}

function listTaskRecords(
  projectRoot: string,
  opts?: { workingSlug?: string; committedOthers?: boolean },
): GsdTaskRecord[] {
  const slugs = new Set(taskSlugs(projectRoot, false))
  if (opts?.committedOthers) {
    for (const slug of taskSlugs(projectRoot, true)) slugs.add(slug)
  }
  const records: GsdTaskRecord[] = []
  for (const slug of [...slugs].sort()) {
    const committed = Boolean(opts?.committedOthers && slug !== opts.workingSlug)
    const record = readTaskRecord(projectRoot, slug, committed)
    if (record) records.push(record)
  }
  return records.sort((left, right) => {
    const rank = (status: GsdTaskRecord['status']) => status === '运行中' ? 0 : status === '已暂停' ? 1 : 2
    return rank(left.status) - rank(right.status) ||
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.taskSlug.localeCompare(right.taskSlug)
  })
}

function taskSummary(record: GsdTaskRecord): GsdTaskSummary {
  if (record.status === '已完成') {
    throw new Error('completed task cannot be converted to unfinished summary')
  }
  return {
    taskSlug: record.taskSlug,
    taskName: record.taskName,
    taskType: record.taskType,
    status: record.status,
    phase: record.phase,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    summary: record.summary,
  }
}

export function readGsdTaskSummaries(projectRoot: string): GsdTaskSummary[] {
  if (!existsSync(join(projectRoot, '.gsd', '.git'))) return []
  return listTaskRecords(projectRoot)
    .filter(record => record.status !== '已完成')
    .map(taskSummary)
}

function escapeTrackerCell(value: string): string {
  return value.trim().replace(/\s+/g, ' ').replaceAll('|', '\\|')
}

function rebuiltTrackerContent(records: GsdTaskRecord[]): string {
  const rows = records
    .filter(record => record.status !== '已完成')
    .map(record => [
      record.taskSlug,
      escapeTrackerCell(record.taskName),
      escapeTrackerCell(record.taskType),
      record.status,
      escapeTrackerCell(record.phase),
      escapeTrackerCell(record.createdAt),
      escapeTrackerCell(record.updatedAt),
      escapeTrackerCell(record.summary),
    ])
    .map(cells => '| ' + cells.join(' | ') + ' |')
  return DEFAULT_TRACKER.trimEnd() + (rows.length ? '\n' + rows.join('\n') : '') + '\n'
}

function rebuildTrackerLocked(
  projectRoot: string,
  opts?: { workingSlug?: string; committedOthers?: boolean },
): void {
  writeTracker(projectRoot, rebuiltTrackerContent(listTaskRecords(projectRoot, opts)))
}

function defaultProjectContent(projectRoot: string): string {
  const name = projectRoot.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || 'project'
  return [
    '# ' + name,
    '',
    '## What This Is',
    '',
    '这是 ' + name + ' 的项目级共享 GSD 上下文。任务名称、范围、完成标准和执行游标分别保存在 .gsd/{task-slug}/TASK.md 与 .gsd/{task-slug}/.planning/STATE.md，不得写回本文件形成任务级双源。',
    '',
    '## Core Value',
    '',
    '在项目硬规则与验证门禁下持续交付可验证、可恢复的增量变更。',
    '',
    '## Requirements',
    '',
    '### Active',
    '',
    '- 允许多个不同 task_slug 同时处于运行中；当前会话选择不属于任务状态。',
    '- 所有任务共享项目源码和运行进程；修改范围重叠时串行执行或使用独立 Git worktree。',
    '- 项目硬规则以根指令文件为准，任务事实以代码、测试、Git、TASK 和 STATE 为准。',
    '- .gsd/TRACKER.md 只索引未完成任务；任务完成后保留目录与 Git 历史。',
    '',
    '### Out of Scope',
    '',
    '- 在共享 PROJECT 中记录单个任务的范围、阶段、执行游标或临时状态。',
    '- 通过任务切换隐式暂停其他任务。',
    '',
    '## Evolution',
    '',
    '只有跨任务成立且经过验证的项目级事实才更新本文件。任务专属决策保留在对应任务产物中。',
    '',
  ].join('\n')
}

function stagedFiles(projectRoot: string): string[] {
  return runGit(projectRoot, ['diff', '--cached', '--name-only']).stdout
    .split(/\r?\n/)
    .filter(Boolean)
}

function assertEmptyGsdIndex(projectRoot: string): void {
  const staged = stagedFiles(projectRoot)
  if (staged.length) {
    throw new Error('GSD index must be empty before write: ' + staged.join(', '))
  }
}

function assertCleanManagedFiles(projectRoot: string, paths: string[]): void {
  const dirty = runGit(projectRoot, ['status', '--porcelain', '--', ...paths]).stdout.trim()
  if (dirty) {
    throw new Error('GSD managed files must be clean before init: ' + dirty.replace(/\r?\n/g, ', '))
  }
}

function commitSpecificPathsLocked(
  projectRoot: string,
  paths: string[],
  message: string,
): boolean {
  assertEmptyGsdIndex(projectRoot)
  runGit(projectRoot, ['add', '--', ...paths])
  const staged = stagedFiles(projectRoot)
  const gsdRoot = join(projectRoot, '.gsd')
  const allowedDirs = paths.filter(path => {
    try {
      return statSync(join(gsdRoot, path)).isDirectory()
    } catch {
      return false
    }
  })
  const allowedFiles = new Set(paths.filter(path => !allowedDirs.includes(path)))
  const unexpected = staged.filter(path => (
    !allowedFiles.has(path) &&
    !allowedDirs.some(directory => path === directory || path.startsWith(directory + '/'))
  ))
  if (unexpected.length) {
    runGit(projectRoot, ['reset', '-q', '--', ...paths], { allowFailure: true })
    throw new Error('scoped GSD commit includes unexpected files: ' + unexpected.join(', '))
  }
  const diff = runGit(projectRoot, ['diff', '--cached', '--quiet'], { allowFailure: true })
  if (diff.status === 0) return false
  if (diff.status !== 1) {
    runGit(projectRoot, ['reset', '-q', '--', ...paths], { allowFailure: true })
    throw new Error('failed to inspect staged GSD diff: exit ' + diff.status)
  }
  const commit = runGit(projectRoot, ['commit', '-m', message], { allowFailure: true })
  if (commit.status !== 0) {
    runGit(projectRoot, ['reset', '-q', '--', ...paths], { allowFailure: true })
    throw new Error('GSD commit failed: ' + (commit.stderr.trim() || 'exit ' + commit.status))
  }
  return true
}

function ensureGsdRepo(projectRoot: string): void {
  const gsdRoot = join(projectRoot, '.gsd')
  mkdirSync(gsdRoot, { recursive: true })
  const gitWasPresent = existsSync(join(gsdRoot, '.git'))
  if (!gitWasPresent) runGit(projectRoot, ['init', '-q'])
  withGsdWriteLock(projectRoot, () => {
    assertEmptyGsdIndex(projectRoot)
    const managedPaths = ['.gitignore', 'PROJECT.md', TRACKER_FILE]
    if (gitWasPresent) assertCleanManagedFiles(projectRoot, managedPaths)
    const ignorePath = join(gsdRoot, '.gitignore')
    const lines = existsSync(ignorePath)
      ? readFileSync(ignorePath, 'utf8').replace(/\r\n?/g, '\n').split('\n').filter(Boolean)
      : []
    if (!lines.includes('**/.planning/config.json')) lines.push('**/.planning/config.json')
    writeFileAtomic(ignorePath, lines.join('\n') + '\n')
    if (!existsSync(trackerPath(projectRoot))) writeTracker(projectRoot, DEFAULT_TRACKER)
    const projectPath = join(gsdRoot, 'PROJECT.md')
    if (!existsSync(projectPath)) writeFileAtomic(projectPath, defaultProjectContent(projectRoot))
    commitSpecificPathsLocked(
      projectRoot,
      managedPaths,
      'init gsd task repo',
    )
  })
}

function commitTaskLocked(projectRoot: string, slug: string, message: string): void {
  rebuildTrackerLocked(projectRoot, { workingSlug: slug, committedOthers: true })
  commitSpecificPathsLocked(projectRoot, [TRACKER_FILE, slug], message)
}

function updateStateLifecycle(
  projectRoot: string,
  slug: string,
  status: 'paused' | 'in_progress' | 'completed',
  updated: string,
): void {
  const path = join(projectRoot, '.gsd', slug, '.planning', 'STATE.md')
  if (!existsSync(path)) return
  let content = readFileSync(path, 'utf8')
  if (/^status:\s*.*$/m.test(content)) {
    content = content.replace(/^status:\s*.*$/m, 'status: ' + status)
  } else if (/^---\r?\n/.test(content)) {
    content = content.replace(/^---\r?\n/, match => match + 'status: ' + status + '\n')
  }
  if (/^last_updated:\s*.*$/m.test(content)) {
    content = content.replace(/^last_updated:\s*.*$/m, 'last_updated: "' + updated + '"')
  }
  writeFileAtomic(path, content)
}

function updateTaskStatusLocked(
  projectRoot: string,
  record: GsdTaskRecord,
  status: Exclude<GsdTaskStatus, '无任务'>,
  updated: string,
): void {
  let content = record.taskContent
  if (!/^-\s*状态[：:]\s*.*$/m.test(content)) {
    throw new Error('TASK.md status field missing: ' + record.taskSlug + '/TASK.md')
  }
  content = content.replace(/^-\s*状态[：:]\s*.*$/m, '- 状态: ' + status)
  if (/^-\s*最后更新[：:]\s*.*$/m.test(content)) {
    content = content.replace(/^-\s*最后更新[：:]\s*.*$/m, '- 最后更新: ' + updated)
  } else {
    throw new Error('TASK.md updated field missing: ' + record.taskSlug + '/TASK.md')
  }
  writeFileAtomic(taskPath(projectRoot, record.taskSlug), content)
  updateStateLifecycle(
    projectRoot,
    record.taskSlug,
    status === '已暂停' ? 'paused' : status === '已完成' ? 'completed' : 'in_progress',
    updated,
  )
}

function emptySnapshot(projectRoot: string, unfinishedTasks: GsdTaskSummary[]): GsdSnapshot {
  return {
    status: '无任务',
    taskSlug: '',
    taskName: '',
    phase: 'unknown',
    updatedAt: '',
    planningPath: '',
    note: '',
    bridge: planningHealth(projectRoot),
    phaseHint: 'unknown',
    unfinishedTasks,
  }
}

function snapshotForRecord(
  projectRoot: string,
  record: GsdTaskRecord,
  unfinishedTasks: GsdTaskSummary[],
): GsdSnapshot {
  return {
    status: record.status,
    taskSlug: record.taskSlug,
    taskName: record.taskName,
    phase: record.phase,
    updatedAt: record.updatedAt,
    planningPath: planningPathFor(record.taskSlug),
    note: record.summary,
    bridge: planningHealth(projectRoot, record.taskSlug),
    phaseHint: record.phase,
    progress: record.stateContent ? parseStateProgress(record.stateContent) : undefined,
    unfinishedTasks,
  }
}

function legacySelectedSlug(projectRoot: string): string {
  const tracker = readTrackerRaw(projectRoot)
  if (!/^##\s*当前活跃任务/m.test(tracker)) return ''
  return parseActiveBlock(tracker).task_slug
}

export function readGsdSnapshot(projectRoot: string, taskSlug = ''): GsdSnapshot {
  if (!existsSync(join(projectRoot, '.gsd', '.git'))) return emptySnapshot(projectRoot, [])
  const records = listTaskRecords(projectRoot)
  const unfinishedTasks = records
    .filter(record => record.status !== '已完成')
    .map(taskSummary)
  const requestedSlug = taskSlug.trim()
  const selectedSlug = requestedSlug ? normalizeTaskSlug(requestedSlug) : legacySelectedSlug(projectRoot)
  if (!selectedSlug) return emptySnapshot(projectRoot, unfinishedTasks)
  const record = records.find(task => task.taskSlug === selectedSlug)
  return record ? snapshotForRecord(projectRoot, record, unfinishedTasks) : emptySnapshot(projectRoot, unfinishedTasks)
}

function parseFinalizationFields(stateContent: string): Record<string, string> {
  const frontMatter = stateContent.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!frontMatter) throw new Error('STATE.md 缺少合法的 YAML 前置区。')
  const lines = frontMatter[1].split(/\r?\n/)
  const indexes = lines.flatMap((line, index) => /^finalization:\s*$/.test(line) ? [index] : [])
  if (indexes.length !== 1) {
    throw new Error('STATE.md 的 YAML 前置区 finalization 数量必须为 1，实际=' + indexes.length + '。')
  }
  const fields: Record<string, string> = {}
  for (let index = indexes[0] + 1; index < lines.length; index++) {
    const line = lines[index]
    if (/^\S/.test(line)) break
    if (!line.trim()) continue
    const match = line.match(/^  ([a-z_]+):\s*(.*?)\s*$/)
    if (!match) throw new Error('finalization 包含无法识别的行：' + line)
    if (Object.hasOwn(fields, match[1])) throw new Error('finalization 包含重复字段：' + match[1])
    fields[match[1]] = match[2]
  }
  return fields
}

function finalizationInteger(fields: Record<string, string>, name: string, minimum: number): number {
  const raw = fields[name]
  if (raw == null || !/^-?\d+$/.test(raw)) {
    throw new Error('STATE.md finalization 字段必须是整数：' + name)
  }
  const value = Number(raw)
  if (value < minimum) throw new Error('STATE.md finalization 字段越界：' + name + '=' + value)
  return value
}

export function assertGsdFinalizationComplete(projectRoot: string, taskSlug: string): void {
  const slug = normalizeTaskSlug(taskSlug)
  const statePath = join(projectRoot, '.gsd', slug, '.planning', 'STATE.md')
  if (!existsSync(statePath)) throw new Error('完成门禁失败：STATE.md 不存在，task_slug=' + slug)
  const fields = parseFinalizationFields(readFileSync(statePath, 'utf8'))
  const changeGeneration = finalizationInteger(fields, 'change_generation', 0)
  const reviewedGeneration = finalizationInteger(fields, 'reviewed_generation', -1)
  const blockingFindings = finalizationInteger(fields, 'blocking_findings', 0)
  const finalVerifiedGeneration = finalizationInteger(fields, 'final_verified_generation', -1)
  const finalVerificationRuns = finalizationInteger(fields, 'final_verification_runs', 0)
  if (!/^(true|false)$/i.test(fields.scope_frozen || '')) {
    throw new Error('STATE.md finalization.scope_frozen 必须是 true 或 false。')
  }
  if (reviewedGeneration !== changeGeneration) {
    throw new Error('完成门禁失败：reviewed_generation 与 change_generation 不一致。')
  }
  if (fields.scope_frozen.toLowerCase() !== 'true') {
    throw new Error('完成门禁失败：scope_frozen=false。')
  }
  if (blockingFindings !== 0) {
    throw new Error('完成门禁失败：blocking_findings=' + blockingFindings + '。')
  }
  if (finalVerifiedGeneration !== changeGeneration) {
    throw new Error('完成门禁失败：final_verified_generation 不是当前变更代际。')
  }
  if (finalVerificationRuns < 1) {
    throw new Error('完成门禁失败：尚无有效最终验收。')
  }
}

export function selectGsdTask(projectRoot: string, taskSlug: string): GsdSnapshot {
  const slug = normalizeTaskSlug(taskSlug)
  ensureGsdRepo(projectRoot)
  const record = readTaskRecord(projectRoot, slug)
  if (!record) throw new Error('GSD task not found: ' + slug)
  if (record.status === '已完成') throw new Error('已完成任务不能重新选择：' + slug)
  ensureWorkstreamRoute(projectRoot, slug)
  return readGsdSnapshot(projectRoot, slug)
}

export function createAndActivateTask(
  projectRoot: string,
  taskName: string,
  opts?: { slug?: string; summary?: string },
): GsdSnapshot {
  const name = taskName.trim()
  if (!name || /[\r\n]/.test(name)) throw new Error('任务名称必须是非空单行文本')
  const summary = opts?.summary?.trim() || ''
  if (/[\r\n]/.test(summary)) throw new Error('任务简述必须是单行文本')
  ensureGsdRepo(projectRoot)
  const base = opts?.slug ? slugifyTaskName(opts.slug) : slugifyTaskName(name)
  let slug = ''
  withGsdWriteLock(projectRoot, () => {
    assertEmptyGsdIndex(projectRoot)
    slug = uniqueSlug(projectRoot, base || 'task')
    const updated = nowIso()
    writeTaskMd(projectRoot, slug, name, '运行中', updated)
    if (summary) {
      const path = taskPath(projectRoot, slug)
      const content = readFileSync(path, 'utf8').replace(/^- 简述:\s*$/m, '- 简述: ' + summary)
      writeFileAtomic(path, content)
    }
    mkdirSync(join(projectRoot, '.gsd', slug, '.planning'), { recursive: true })
    ensureWorkstreamRoute(projectRoot, slug)
    commitTaskLocked(projectRoot, slug, 'gsd(' + slug + '): 创建任务')
  })
  return readGsdSnapshot(projectRoot, slug)
}

export function pauseGsdTask(projectRoot: string, taskSlug: string): GsdSnapshot {
  const slug = normalizeTaskSlug(taskSlug)
  ensureGsdRepo(projectRoot)
  withGsdWriteLock(projectRoot, () => {
    assertEmptyGsdIndex(projectRoot)
    const record = readTaskRecord(projectRoot, slug)
    if (!record) throw new Error('GSD task not found: ' + slug)
    if (record.status !== '运行中') return
    updateTaskStatusLocked(projectRoot, record, '已暂停', nowIso())
    commitTaskLocked(projectRoot, slug, 'gsd(' + slug + '): 暂停任务')
  })
  return readGsdSnapshot(projectRoot, slug)
}

export function resumeGsdTask(projectRoot: string, taskSlug: string): GsdSnapshot {
  const slug = normalizeTaskSlug(taskSlug)
  ensureGsdRepo(projectRoot)
  withGsdWriteLock(projectRoot, () => {
    assertEmptyGsdIndex(projectRoot)
    const record = readTaskRecord(projectRoot, slug)
    if (!record) throw new Error('GSD task not found: ' + slug)
    if (record.status === '已完成') throw new Error('已完成任务不能恢复：' + slug)
    ensureWorkstreamRoute(projectRoot, slug)
    if (record.status !== '已暂停') return
    updateTaskStatusLocked(projectRoot, record, '运行中', nowIso())
    commitTaskLocked(projectRoot, slug, 'gsd(' + slug + '): 恢复任务')
  })
  return readGsdSnapshot(projectRoot, slug)
}

export function completeGsdTask(projectRoot: string, taskSlug: string): GsdSnapshot {
  const slug = normalizeTaskSlug(taskSlug)
  ensureGsdRepo(projectRoot)
  const before = readTaskRecord(projectRoot, slug)
  if (!before) throw new Error('GSD task not found: ' + slug)
  if (before.status === '已完成') return readGsdSnapshot(projectRoot, slug)
  assertGsdFinalizationComplete(projectRoot, slug)
  withGsdWriteLock(projectRoot, () => {
    assertEmptyGsdIndex(projectRoot)
    const record = readTaskRecord(projectRoot, slug)
    if (!record) throw new Error('GSD task not found: ' + slug)
    if (record.status === '已完成') return
    updateTaskStatusLocked(projectRoot, record, '已完成', nowIso())
    commitTaskLocked(projectRoot, slug, 'gsd(' + slug + '): 完成任务')
  })
  return readGsdSnapshot(projectRoot, slug)
}

/** Compatibility wrappers; new callers should always pass a target task_slug. */
export function pauseActiveTask(projectRoot: string, taskSlug = ''): GsdSnapshot {
  const slug = taskSlug || legacySelectedSlug(projectRoot)
  return slug ? pauseGsdTask(projectRoot, slug) : readGsdSnapshot(projectRoot)
}

export function resumeActiveTask(projectRoot: string, taskSlug = ''): GsdSnapshot {
  const slug = taskSlug || legacySelectedSlug(projectRoot)
  return slug ? resumeGsdTask(projectRoot, slug) : readGsdSnapshot(projectRoot)
}

export function completeActiveTask(projectRoot: string, taskSlug = ''): GsdSnapshot {
  const slug = taskSlug || legacySelectedSlug(projectRoot)
  return slug ? completeGsdTask(projectRoot, slug) : readGsdSnapshot(projectRoot)
}
