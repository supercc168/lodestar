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
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const DEFAULT_TRACKER = `# GSD 任务跟踪

## 当前活跃任务

- 状态：无任务
- task_slug：
- 任务名称：
- 任务类型：
- 当前阶段：unknown
- 最后更新：
- planning_path：
- 备注：

## 任务索引

| task_slug | 名称 | 状态 | 创建时间 | 最后更新 |
|-----------|------|------|----------|----------|
`

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

export function initGsdRepo(options = {}) {
  const root = resolveProjectRoot(options)
  const gsdRoot = join(root, '.gsd')
  mkdirSync(gsdRoot, { recursive: true })

  const gitignorePath = join(gsdRoot, '.gitignore')
  if (!existsSync(gitignorePath)) {
    writeText(gitignorePath, '# GSD sensitive config (may contain API keys)\n**/.planning/config.json\n')
  }

  const trackerPath = join(gsdRoot, 'TRACKER.md')
  if (!existsSync(trackerPath)) writeText(trackerPath, DEFAULT_TRACKER)

  if (!pathExists(join(gsdRoot, '.git'))) {
    runGit(['init', '-q'], gsdRoot)
  }
  runGit(['add', '.gitignore', 'TRACKER.md'], gsdRoot)
  const status = runGit(['status', '--porcelain'], gsdRoot).stdout.trim()
  if (status) runGit(['commit', '-m', 'init gsd task repo'], gsdRoot)

  console.log(`GSD repo ready: ${gsdRoot}`)
  return { root, gsdRoot, trackerPath }
}

export function switchActiveTask(options = {}) {
  const root = resolveProjectRoot(options)
  const slug = normalizeSlug(options['task-slug'] || options.taskSlug)
  const taskDir = join(root, '.gsd', slug)
  if (!pathExists(taskDir)) fail(`Task dir missing: .gsd/${slug}`)

  const planningCanonical = join(taskDir, '.planning')
  mkdirSync(planningCanonical, { recursive: true })
  const planningLink = join(root, '.planning')
  const existing = pathStat(planningLink)
  if (existing) {
    if (!existing.isSymbolicLink()) {
      fail('.planning exists and is not a symlink/junction/link')
    }
    unlinkSync(planningLink)
  }

  if (process.platform === 'win32') {
    symlinkSync(planningCanonical, planningLink, 'junction')
  } else {
    const target = relative(root, planningCanonical) || '.'
    symlinkSync(target, planningLink, 'dir')
  }

  console.log(`Switched active task: ${slug}`)
  return { root, slug, planningCanonical, planningLink }
}

export function gsdLocalCommit(options = {}) {
  const root = resolveProjectRoot(options)
  const message = String(options.message || '').trim()
  if (!message) fail('commit message is required')
  const gsdRoot = join(root, '.gsd')
  if (!pathExists(gsdRoot)) fail('.gsd missing, run init-gsd-repo first')
  if (!pathExists(join(gsdRoot, '.git'))) fail('.gsd git missing, run init-gsd-repo first')

  runGit(['add', '-A'], gsdRoot)
  const status = runGit(['status', '--porcelain'], gsdRoot).stdout.trim()
  if (!status) {
    console.log('No changes to commit')
    return { committed: false }
  }
  runGit(['commit', '-m', message], gsdRoot)
  console.log(`Committed: ${message}`)
  return { committed: true }
}

function parseTrackerField(content, field) {
  const match = content.match(new RegExp(`^-\\s*${escapeRegExp(field)}[：:]\\s*(.*?)\\s*$`, 'm'))
  return match ? match[1].trim() : ''
}

function updateIndexRow(content, slug, name, status, created, updated) {
  const row = `| ${slug} | ${name} | ${status} | ${created} | ${updated} |`
  const existing = new RegExp(`^\\| ${escapeRegExp(slug)} \\|.*$`, 'm')
  if (existing.test(content)) return content.replace(existing, row)
  const marker = '|-----------|------|------|----------|----------|'
  if (content.includes(marker)) return content.replace(marker, `${marker}\n${row}`)
  return `${content.trimEnd()}\n${row}\n`
}

function updateIndexStatus(content, slug, status, updated) {
  const pattern = new RegExp(
    `^\\| ${escapeRegExp(slug)} \\| ([^|]+) \\| [^|]+ \\| ([^|]+) \\| [^|]+ \\|$`,
    'm',
  )
  const match = content.match(pattern)
  if (!match) return content
  return content.replace(pattern, `| ${slug} | ${match[1].trim()} | ${status} | ${match[2].trim()} | ${updated} |`)
}

function pauseRunningTask(root, trackerContent, now) {
  if (parseTrackerField(trackerContent, '状态') !== '运行中') return
  const oldSlug = parseTrackerField(trackerContent, 'task_slug')
  if (!oldSlug) return
  const taskPath = join(root, '.gsd', oldSlug, 'TASK.md')
  const content = normalizeNewlines(readText(taskPath))
  if (!content) return
  const normalized = content
    .replace(/^- 状态: .*$/m, '- 状态: 已暂停')
    .replace(/^- 最后更新: .*$/m, `- 最后更新: ${now}`)
  writeText(taskPath, normalized, { bom: true })
}

function buildTracker(root, slug, name, now, oldContent) {
  pauseRunningTask(root, oldContent, now)
  let content = oldContent
  const oldRunning = parseTrackerField(oldContent, '状态') === '运行中'
  const oldSlug = oldRunning ? parseTrackerField(oldContent, 'task_slug') : ''
  if (oldSlug && oldSlug !== slug) content = updateIndexStatus(content, oldSlug, '已暂停', now)
  content = updateIndexRow(content, slug, name, '运行中', now, now)

  const active = `## 当前活跃任务\n\n- 状态：运行中\n- task_slug：${slug}\n- 任务名称：${name}\n- 任务类型：autoui\n- 当前阶段：discuss\n- 最后更新：${now}\n- planning_path：.gsd/${slug}/.planning/\n- 备注：autoui\n`
  const activePattern = /## 当前活跃任务\n\n[\s\S]*?(?=\n##\s+|$)/
  if (activePattern.test(content)) return content.replace(activePattern, active.trimEnd()) + '\n'
  return `${content.trimEnd()}\n\n${active}`
}

export function bootstrapAutouiTask(options = {}) {
  const root = resolveProjectRoot(options)
  const slug = normalizeSlug(options['task-slug'] || options.taskSlug)
  const name = String(options['task-name'] || options.taskName || '').trim()
  if (!name) fail('task name is required')
  const brief = String(options['user-brief'] || options.userBrief || '').trim() || '待 discuss 阶段补充'
  const gsdRoot = join(root, '.gsd')
  if (!pathExists(gsdRoot)) initGsdRepo({ projectRoot: root })

  const taskDir = join(gsdRoot, slug)
  if (pathExists(taskDir)) fail(`Task already exists: .gsd/${slug}`)
  const planningDir = join(taskDir, '.planning')
  const now = nowIso()
  const screenshotDir = join(gsdRoot, slug, 'evidence', 'screenshots')
  mkdirSync(planningDir, { recursive: true })

  const taskMd = `# ${name}\n\n- task_slug: ${slug}\n- 任务类型: autoui\n- 状态: 运行中\n- 创建时间: ${now}\n- 最后更新: ${now}\n- 简述: ${brief}\n\n## 备注\n\n本任务由 bootstrap-autoui-task 创建。编排与恢复走 GSD；UI 规范见 yiui-auto-ui。\n`
  const pathsMd = `# 证据路径约定\n\n- task_slug: ${slug}\n- 项目根: ${root}\n\n## evidence（AI 证据，按需建子目录）\n\n- logs: .gsd/${slug}/evidence/logs/\n- uivision: .gsd/${slug}/evidence/uivision/\n- tool-results: .gsd/${slug}/evidence/tool-results/\n- screenshots: .gsd/${slug}/evidence/screenshots/\n\n## milestones（用户向里程碑，非 AI 恢复源）\n\n- MILESTONES.md: .gsd/${slug}/milestones/MILESTONES.md\n- AUTOUI-RECORD.md: .gsd/${slug}/milestones/AUTOUI-RECORD.md\n- images: .gsd/${slug}/milestones/images/\n\n## notes\n\n- RUNTIME-ENTRY.md: 主界面/OpenYIUI 跑通后填写\n- SERVER-GAPS.md: 上游协议/字段缺失时填写\n- AI-LIMITATIONS.md: 需人工验收项\n\n## 截图工具默认 outputDirectory\n\n${screenshotDir}\n\n## git 约定\n\n- markdown 与证据路径索引提交到 .gsd 本地 git\n- 大二进制截图默认只 commit 路径引用\n`
  const milestonesMd = `# ${name} — 里程碑记录\n\n> 用户向回顾文档；**不作为 AI 恢复入口**。\n> 进度真相源：.planning/STATE.md、phase PLAN/SUMMARY。\n\n## 基本信息\n\n| 项目 | 内容 |\n|---|---|\n| task_slug | ${slug} |\n| 进度源 | ../TASK.md、.planning/STATE.md |\n| 图片目录 | images/ |\n| 当前状态 | 进行中 |\n\n## 关键节点总览\n\n| 时间 | 阶段 | 用户向说明 | 做了什么 | 当前效果 | 图片/素材 | 下一步 |\n|---|---|---|---|---|---|---|\n`
  const projectMd = `# ${name}\n\n## What This Is\n\nAutoUI 长任务：${brief}\n\n任务类型：autoui。编排与恢复走 GSD；UI 闸门、证据与验收规范见 yiui-auto-ui。\n\n## Core Value\n\n在 AutoUI 规范下完成可运行、可验证、可恢复的 UI 交付闭环。\n\n## Requirements\n\n### Active\n\n- [ ] discuss：明确任务模式、ROADMAP、需求边界\n- [ ] plan：可执行准备闸门、验收用例、VERIFICATION 骨架\n- [ ] execute：按 phase PLAN 实现 UI / 逻辑 / 编译\n- [ ] verify：验证矩阵、经验写入 extra-ui-learnings（如适用）\n- [ ] ship：Done 总闸门与用户向 MILESTONES\n\n### Out of Scope\n\n- 未在 discuss 确认的协议/服务端改动\n- 未在 plan 写入边界的文件范围外修改\n\n## Context\n\n- 用户简述：${brief}\n- 证据目录：.gsd/${slug}/evidence/\n- 里程碑记录：.gsd/${slug}/milestones/MILESTONES.md\n\n## Constraints\n\n- **Git**: .gsd/ 不进 projectx 主仓库\n- **并发**: 同时仅 1 个运行中 GSD 任务\n- **AutoUI**: 须遵循 yiui-auto-ui（extra-ui-strategies.md + 任务经验写入 extra-ui-learnings.md）\n\n---\n*Created: ${now} by bootstrap-autoui-task*\n`

  writeText(join(taskDir, 'TASK.md'), taskMd, { bom: true })
  writeText(join(taskDir, 'notes', 'PATHS.md'), pathsMd, { bom: true })
  writeText(join(taskDir, 'milestones', 'MILESTONES.md'), milestonesMd, { bom: true })
  writeText(join(planningDir, 'PROJECT.md'), projectMd, { bom: true })

  const trackerPath = join(gsdRoot, 'TRACKER.md')
  const oldTracker = normalizeNewlines(readText(trackerPath) || DEFAULT_TRACKER)
  writeText(trackerPath, buildTracker(root, slug, name, now, oldTracker), { bom: true })
  switchActiveTask({ projectRoot: root, taskSlug: slug })
  gsdLocalCommit({ projectRoot: root, message: `gsd(${slug}): 创建 autoui 任务` })
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
  let taskStatus = parseTrackerField(trackerContent, '状态')
  let activeTaskSlug = parseTrackerField(trackerContent, 'task_slug')
  let taskName = parseTrackerField(trackerContent, '任务名称')
  let currentPhase = parseTrackerField(trackerContent, '当前阶段')
  const requestedSlug = String(options['task-slug'] || options.taskSlug || '').trim()

  if (requestedSlug) {
    activeTaskSlug = normalizeSlug(requestedSlug)
    const taskPath = join(root, '.gsd', activeTaskSlug, 'TASK.md')
    if (!existsSync(taskPath)) fail(`指定任务缺少 TASK.md，task_slug=${activeTaskSlug}，路径=${taskPath}。`)
    const taskContent = readText(taskPath)
    taskStatus = parseTrackerField(taskContent, '状态')
    const heading = taskContent.match(/^#\s+(.+?)\s*$/m)
    taskName = heading ? heading[1].trim() : activeTaskSlug
  }

  if (!activeTaskSlug || taskStatus === '无任务') {
    return {
      schema_version: 1,
      active: false,
      task_slug: '',
      task_name: '',
      task_status: taskStatus,
      source: trackerPath,
      explanation: '当前没有活跃 GSD 任务。',
      plan: [],
      diagnostics: [],
    }
  }

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
  const statePath = resolve(options['state-path'] || options.statePath || join(root, '.planning', 'STATE.md'))
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
  console.log(`${mode} 通过：STATE=${statePath}，change_generation=${changeGeneration}，scope_frozen=true，blocking_findings=0。`)
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
  console.log(`verify yiui-gsd @ ${root}`)
  verifyLine(existsSync(skillPath), 'project skill .agents/skills/yiui-gsd/SKILL.md', state)

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
