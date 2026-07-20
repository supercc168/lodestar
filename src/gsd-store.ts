import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import {
  type BridgeHealth,
  ensureTaskPlanningDir,
  planningHealth,
  switchActivePlanning,
} from './gsd-bridge'

export type GsdTaskStatus = '无任务' | '运行中' | '已暂停' | '已完成'

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
}

const TRACKER_FILE = 'TRACKER.md'
const TASK_FILE = 'TASK.md'

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
  if (!existsSync(p)) {
    return `# GSD 任务跟踪

## 当前活跃任务

- 状态：无任务
- task_slug：
- 任务名称：
- 当前阶段：unknown
- 最后更新：
- planning_path：
- 备注：

## 任务索引

| task_slug | 名称 | 状态 | 创建时间 | 最后更新 |
|-----------|------|------|----------|----------|
`
  }
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

function updateActiveBlock(content: string, patch: Partial<ActiveBlock>): string {
  const lines = content.split(/\r?\n/)
  const out: string[] = []
  let inActive = false
  let sawAnyField = false
  const remaining = new Set<ActiveField>(ACTIVE_FIELDS)
  const merged: ActiveBlock = { ...parseActiveBlock(content), ...patch }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^##\s*当前活跃任务/.test(line)) {
      inActive = true
      out.push(line)
      continue
    }
    if (inActive && /^##\s+/.test(line)) {
      // flush any missing fields before next section
      if (!sawAnyField) {
        for (const key of ACTIVE_FIELDS) {
          out.push(`- ${key}：${merged[key] ?? ''}`)
        }
      } else {
        for (const key of ACTIVE_FIELDS) {
          if (remaining.has(key)) out.push(`- ${key}：${merged[key] ?? ''}`)
        }
      }
      remaining.clear()
      inActive = false
      out.push(line)
      continue
    }
    if (inActive) {
      const field = parseActiveFieldLine(line)
      if (field) {
        sawAnyField = true
        remaining.delete(field.key)
        out.push(`- ${field.key}：${merged[field.key] ?? ''}`)
        continue
      }
      out.push(line)
      continue
    }
    out.push(line)
  }

  if (inActive) {
    if (!sawAnyField) {
      for (const key of ACTIVE_FIELDS) {
        out.push(`- ${key}：${merged[key] ?? ''}`)
      }
    } else {
      for (const key of ACTIVE_FIELDS) {
        if (remaining.has(key)) out.push(`- ${key}：${merged[key] ?? ''}`)
      }
    }
  }

  return out.join('\n')
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

function formatIndexRow(
  slug: string,
  name: string,
  status: string,
  created: string,
  updated: string,
): string {
  return `| ${slug} | ${name} | ${status} | ${created} | ${updated} |`
}

function upsertIndexRow(
  content: string,
  slug: string,
  name: string,
  status: string,
  updated: string,
  created?: string,
): string {
  const lines = content.split(/\r?\n/)
  const out: string[] = []
  let inIndex = false
  let headerSeen = false
  let sepSeen = false
  let replaced = false
  let lastTableLine = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^##\s*任务索引/.test(line)) {
      inIndex = true
      out.push(line)
      continue
    }
    if (inIndex && /^##\s+/.test(line)) {
      if (!replaced && headerSeen) {
        // insert before leaving section
        if (lastTableLine >= 0) {
          // already pushed through lastTableLine; append row before this heading
          out.push(formatIndexRow(slug, name, status, created ?? updated, updated))
        } else {
          out.push(formatIndexRow(slug, name, status, created ?? updated, updated))
        }
        replaced = true
      }
      inIndex = false
      out.push(line)
      continue
    }

    if (inIndex) {
      if (!headerSeen && isTableRow(line) && /task_slug/i.test(line)) {
        headerSeen = true
        out.push(line)
        continue
      }
      if (headerSeen && !sepSeen && isTableSeparator(line)) {
        sepSeen = true
        out.push(line)
        continue
      }
      if (headerSeen && isTableRow(line)) {
        const cells = parseTableCells(line)
        if (cells[0] === slug) {
          const rowCreated = created ?? cells[3] ?? updated
          out.push(formatIndexRow(slug, name || cells[1] || slug, status, rowCreated, updated))
          replaced = true
          lastTableLine = out.length - 1
          continue
        }
        out.push(line)
        lastTableLine = out.length - 1
        continue
      }
      // Drop blank lines inside the index table body so rows stay contiguous.
      if (headerSeen && line.trim() === '') continue
      out.push(line)
      continue
    }

    out.push(line)
  }

  if (inIndex && !replaced) {
    // ensure header/separator if missing
    if (!headerSeen) {
      out.push('')
      out.push('| task_slug | 名称 | 状态 | 创建时间 | 最后更新 |')
      out.push('|-----------|------|------|----------|----------|')
    } else if (!sepSeen) {
      out.push('|-----------|------|------|----------|----------|')
    }
    out.push(formatIndexRow(slug, name, status, created ?? updated, updated))
  }

  return out.join('\n')
}

function writeTracker(projectRoot: string, content: string): void {
  mkdirSync(join(projectRoot, '.gsd'), { recursive: true })
  writeFileSync(trackerPath(projectRoot), content.endsWith('\n') ? content : content + '\n', 'utf8')
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
  writeFileSync(p, body, 'utf8')
}

function updateTaskStatus(projectRoot: string, slug: string, status: GsdTaskStatus, updated: string): void {
  const p = taskPath(projectRoot, slug)
  if (!existsSync(p)) {
    writeTaskMd(projectRoot, slug, slug, status, updated)
    return
  }
  let content = readFileSync(p, 'utf8')
  if (/^- 状态:\s*.*$/m.test(content)) {
    content = content.replace(/^- 状态:\s*.*$/m, `- 状态: ${status}`)
  } else {
    content = content.replace(/^(# .*\n)/, `$1\n- 状态: ${status}\n`)
  }
  if (/^- 最后更新:\s*.*$/m.test(content)) {
    content = content.replace(/^- 最后更新:\s*.*$/m, `- 最后更新: ${updated}`)
  } else {
    content += `\n- 最后更新: ${updated}\n`
  }
  // Ensure pause wording is present for paused status (tests accept 已暂停|暂停)
  if (status === '已暂停' && !/暂停/.test(content)) {
    content = content.replace(/^- 状态:.*$/m, `- 状态: 已暂停`)
  }
  writeFileSync(p, content, 'utf8')
}

function readTaskName(projectRoot: string, slug: string, fallback: string): string {
  const p = taskPath(projectRoot, slug)
  if (!existsSync(p)) return fallback
  const content = readFileSync(p, 'utf8')
  const heading = content.match(/^#\s+(.+)$/m)
  if (heading?.[1]?.trim()) return heading[1].trim()
  return fallback
}

function commitGsd(projectRoot: string, message: string): void {
  const gsd = join(projectRoot, '.gsd')
  if (!existsSync(join(gsd, '.git'))) return
  try {
    execSync('git add -A', { cwd: gsd, stdio: 'ignore' })
    execSync(`git commit -m ${JSON.stringify(message)}`, { cwd: gsd, stdio: 'ignore' })
  } catch {
    // ignore empty commit / not a repo / hook failures
  }
}

function readPhaseHint(projectRoot: string, slug: string): string {
  const candidates = [
    join(projectRoot, '.planning', 'STATE.md'),
    join(projectRoot, '.gsd', slug, '.planning', 'STATE.md'),
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    const text = readFileSync(p, 'utf8')
    const lines = text.split(/\r?\n/)
    for (const line of lines) {
      const m = line.match(
        /^(?:#+\s*)?(?:phase|current_phase|Progress|当前阶段)\s*[:：=]\s*(.+)$/i,
      )
      if (m?.[1]) {
        const v = m[1].trim().replace(/^['"]|['"]$/g, '')
        if (v) return v
      }
      // YAML-ish: phase: discuss
      const y = line.match(/^\s*(?:phase|current_phase|progress)\s*:\s*(.+)$/i)
      if (y?.[1]) {
        const v = y[1].trim().replace(/^['"]|['"]$/g, '')
        if (v && !v.startsWith('{') && !v.startsWith('[')) return v
      }
    }
  }
  return 'unknown'
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

export function slugifyTaskName(name: string): string {
  const nfkd = name.normalize('NFKD').replace(/[̀-ͯ]/g, '')
  const lowered = nfkd.toLowerCase()
  // Keep a-z0-9; replace other runs with single hyphen
  let slug = lowered
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
  if (!slug) slug = 'task'
  return slug
}

function uniqueSlug(projectRoot: string, base: string): string {
  const root = base || 'task'
  if (!existsSync(taskDir(projectRoot, root))) return root
  let n = 2
  while (existsSync(taskDir(projectRoot, `${root}-${n}`))) n++
  return `${root}-${n}`
}

function snapshotFromDisk(projectRoot: string): GsdSnapshot {
  const content = readTrackerRaw(projectRoot)
  const active = parseActiveBlock(content)
  const status = normalizeStatus(active.状态)
  const taskSlug = active.task_slug || ''
  const taskName = active.任务名称 || (taskSlug ? readTaskName(projectRoot, taskSlug, '') : '')
  const phase = active.当前阶段 || 'unknown'
  const updatedAt = active.最后更新 || ''
  const planningPath = active.planning_path || (taskSlug ? planningPathFor(taskSlug) : '')
  const note = active.备注 || ''
  const bridge = planningHealth(projectRoot)
  const phaseHint = taskSlug ? readPhaseHint(projectRoot, taskSlug) : 'unknown'
  return {
    status,
    taskSlug,
    taskName,
    phase,
    updatedAt,
    planningPath,
    note,
    bridge,
    phaseHint,
  }
}

export function readGsdSnapshot(projectRoot: string): GsdSnapshot {
  return snapshotFromDisk(projectRoot)
}

function pauseRunningIfAny(projectRoot: string, content: string, updated: string): string {
  const active = parseActiveBlock(content)
  const status = normalizeStatus(active.状态)
  const slug = active.task_slug
  if (status !== '运行中' || !slug) return content

  updateTaskStatus(projectRoot, slug, '已暂停', updated)
  const name = active.任务名称 || readTaskName(projectRoot, slug, slug)
  let next = updateActiveBlock(content, {
    状态: '已暂停',
    最后更新: updated,
  })
  next = upsertIndexRow(next, slug, name, '已暂停', updated)
  return next
}

function indexHasSlug(content: string, slug: string): boolean {
  const lines = content.split(/\r?\n/)
  let inIndex = false
  let headerSeen = false
  for (const line of lines) {
    if (/^##\s*任务索引/.test(line)) {
      inIndex = true
      continue
    }
    if (inIndex && /^##\s+/.test(line)) break
    if (!inIndex) continue
    if (!headerSeen && isTableRow(line) && /task_slug/i.test(line)) {
      headerSeen = true
      continue
    }
    if (headerSeen && isTableRow(line)) {
      const cells = parseTableCells(line)
      if (cells[0] === slug) return true
    }
  }
  return false
}

function removeIncompleteTaskDir(projectRoot: string, slug: string): void {
  if (!slug) return
  const dir = taskDir(projectRoot, slug)
  if (!existsSync(dir)) return
  rmSync(dir, { recursive: true, force: true })
}

export function createAndActivateTask(
  projectRoot: string,
  taskName: string,
  opts?: { slug?: string },
): GsdSnapshot {
  const updated = nowIso()
  let content = readTrackerRaw(projectRoot)

  const base = opts?.slug ? slugifyTaskName(opts.slug) : slugifyTaskName(taskName)
  const slug = uniqueSlug(projectRoot, base || 'task')

  // Prepare NEW task only first. Do not pause the previous task until the
  // planning bridge can switch, so a bridge failure cannot leave the old
  // TASK permanently 已暂停 while TRACKER still shows 运行中.
  writeTaskMd(projectRoot, slug, taskName, '运行中', updated)
  ensureTaskPlanningDir(projectRoot, slug)

  let bridge: BridgeHealth
  try {
    bridge = switchActivePlanning(projectRoot, slug)
  } catch (err) {
    // New slug is not in TRACKER yet — clean incomplete dir and leave previous task intact.
    if (!indexHasSlug(content, slug)) {
      removeIncompleteTaskDir(projectRoot, slug)
    }
    throw err
  }

  // Bridge switched successfully: now pause any previous 运行中 and activate new.
  content = pauseRunningIfAny(projectRoot, content, updated)

  const phaseHint = readPhaseHint(projectRoot, slug)
  const phase = phaseHint && phaseHint !== 'unknown' ? phaseHint : 'unknown'
  const planningPath = planningPathFor(slug)

  content = updateActiveBlock(content, {
    状态: '运行中',
    task_slug: slug,
    任务名称: taskName,
    当前阶段: phase,
    最后更新: updated,
    planning_path: planningPath,
    备注: '',
  })
  content = upsertIndexRow(content, slug, taskName, '运行中', updated, updated)
  writeTracker(projectRoot, content)
  commitGsd(projectRoot, `gsd(${slug}): 创建任务`)

  return {
    status: '运行中',
    taskSlug: slug,
    taskName,
    phase,
    updatedAt: updated,
    planningPath,
    note: '',
    bridge,
    phaseHint,
  }
}

export function pauseActiveTask(projectRoot: string): GsdSnapshot {
  const updated = nowIso()
  let content = readTrackerRaw(projectRoot)
  const active = parseActiveBlock(content)
  const status = normalizeStatus(active.状态)
  const slug = active.task_slug

  // Only a 运行中 task can be paused. 已完成 / 无任务 / 已暂停 are no-ops.
  if (!slug || status !== '运行中') {
    return snapshotFromDisk(projectRoot)
  }

  updateTaskStatus(projectRoot, slug, '已暂停', updated)
  const name = active.任务名称 || readTaskName(projectRoot, slug, slug)
  content = updateActiveBlock(content, {
    状态: '已暂停',
    最后更新: updated,
  })
  content = upsertIndexRow(content, slug, name, '已暂停', updated)
  writeTracker(projectRoot, content)
  commitGsd(projectRoot, `gsd(${slug}): 暂停任务`)

  const snap = snapshotFromDisk(projectRoot)
  return { ...snap, status: '已暂停', updatedAt: updated }
}

export function completeActiveTask(projectRoot: string): GsdSnapshot {
  const updated = nowIso()
  let content = readTrackerRaw(projectRoot)
  const active = parseActiveBlock(content)
  const status = normalizeStatus(active.状态)
  const slug = active.task_slug

  if (!slug || status === '无任务') {
    return snapshotFromDisk(projectRoot)
  }

  updateTaskStatus(projectRoot, slug, '已完成', updated)
  const name = active.任务名称 || readTaskName(projectRoot, slug, slug)
  content = updateActiveBlock(content, {
    状态: '已完成',
    最后更新: updated,
  })
  content = upsertIndexRow(content, slug, name, '已完成', updated)
  writeTracker(projectRoot, content)
  commitGsd(projectRoot, `gsd(${slug}): 完成任务`)

  const snap = snapshotFromDisk(projectRoot)
  return { ...snap, status: '已完成', updatedAt: updated }
}
