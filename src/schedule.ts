/**
 * Daemon-managed scheduled tasks.
 *
 * Each schedule names a project (= group name = session name), a prompt
 * to feed Codex, a render mode, and either a cron expression (recurring)
 * or a one-shot fireAt timestamp. The scheduler ticks every minute,
 * fires anything whose `nextFireAt` has passed, and spawns an isolated
 * `CodexProcess` per fire — fresh thread (no resume), cwd at the
 * project's working directory, with Codex FullAccess policy so the
 * automation isn't blocked waiting for an audience that doesn't exist.
 *
 * Render modes:
 *   silent  — minimal: only the final assistant text is posted as a
 *             notify-style card; tool calls / intermediate text are
 *             dropped. Best for cron jobs that just need to *report*.
 *   verbose — full transcript: assistant segments, tool calls (each
 *             with input + output panels), result meta. Static one-shot
 *             card, no streaming entity. Best for "I want to occasionally
 *             check the work, not just the verdict."
 *
 * Persistence: schedules.json in DATA_DIR. Writes happen on every
 * mutation (create / update nextFireAt / delete). No external cron lib;
 * a minimal 5-field parser covers `m h dom mon dow` with `*`, `*\/N`,
 * `a,b,c`, `a-b`. Anything beyond that is rejected by validateCron with
 * a specific error so the MCP caller can surface it.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { log } from './log'
import { SCHEDULES_FILE } from './paths'
import * as feishu from './feishu'
import { CodexProcess, type CodexResultMeta } from './codex-process'
import { CHANNEL_INSTRUCTIONS } from './instructions'
import { scheduledSummaryCard, type CollectedTool } from './cards/scheduled-summary'
import { notifyCardForScheduled } from './notify'

export type ScheduleMode = 'silent' | 'verbose'
export type ScheduleLevel = 'info' | 'warn' | 'error'

export interface Schedule {
  id: string
  /** Sanitized session name — what `feishu.chatIdForSession` consumes. */
  project: string
  prompt: string
  mode: ScheduleMode
  level: ScheduleLevel
  /** Human-readable label (defaults to `id.slice(0,8)` if not given).
   * Surfaces in card headers as `⏰ <name>`. */
  name: string
  /** Trigger discriminator: exactly one of these is set. */
  cron?: string
  fireAt?: number
  createdAt: number
  lastFiredAt?: number
  /** Pre-computed next firing time (unix ms). Tick reads this for O(N)
   * scan instead of re-parsing the cron each tick. Refreshed on fire. */
  nextFireAt: number
}

const schedules = new Map<string, Schedule>()
const RUN_LOG_DIR = '.lodestar'
const RUN_LOG_FILE = 'schedule-runs.jsonl'
const RUN_LOG_TEXT_LIMIT = 6000

// ── Persistence ─────────────────────────────────────────────────────
function persist(): void {
  try {
    mkdirSync(dirname(SCHEDULES_FILE), { recursive: true })
    const arr = [...schedules.values()]
    writeFileSync(SCHEDULES_FILE, JSON.stringify(arr, null, 2))
  } catch (e) {
    log(`schedule: persist failed: ${e}`)
  }
}

function load(): void {
  if (!existsSync(SCHEDULES_FILE)) return
  try {
    const raw = readFileSync(SCHEDULES_FILE, 'utf8')
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return
    for (const s of arr) {
      if (!s || typeof s !== 'object') continue
      if (!s.id || !s.project || !s.prompt) continue
      schedules.set(s.id, s as Schedule)
    }
    log(`schedule: loaded ${schedules.size} schedule(s) from ${SCHEDULES_FILE}`)
  } catch (e) {
    log(`schedule: load failed: ${e}`)
  }
}

// ── Cron parser ─────────────────────────────────────────────────────
// Minimal 5-field cron: `minute hour dayOfMonth month dayOfWeek`.
// Each field: `*` | number | `*/step` | `a-b` | `a,b,c`.
// dow: 0=Sunday..6=Saturday (and 7=Sunday accepted for compatibility).

interface CronExpr {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
}

const FIELD_RANGES = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour',   min: 0, max: 23 },
  { name: 'dom',    min: 1, max: 31 },
  { name: 'month',  min: 1, max: 12 },
  { name: 'dow',    min: 0, max: 7  },
] as const

function parseField(field: string, min: number, max: number, name: string): Set<number> {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/)
    let body = part
    let step = 1
    if (stepMatch) {
      body = stepMatch[1]
      step = Number(stepMatch[2])
      if (!Number.isFinite(step) || step <= 0) throw new Error(`bad step in "${field}" (${name})`)
    }
    let start = min, end = max
    if (body === '*') {
      // range stays min..max
    } else if (body.includes('-')) {
      const [a, b] = body.split('-')
      start = Number(a); end = Number(b)
    } else {
      const n = Number(body)
      if (!Number.isFinite(n)) throw new Error(`bad value "${body}" in "${field}" (${name})`)
      start = n; end = n
    }
    if (!Number.isFinite(start) || !Number.isFinite(end))
      throw new Error(`bad range "${body}" in "${field}" (${name})`)
    if (start < min || end > max || start > end)
      throw new Error(`out-of-range "${body}" in "${field}" (${name}); allowed ${min}..${max}`)
    for (let v = start; v <= end; v += step) out.add(v)
  }
  return out
}

export function parseCron(expr: string): CronExpr {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error(`cron must be 5 fields ("m h dom mon dow"), got ${fields.length}: "${expr}"`)
  const parsed: any = {}
  for (let i = 0; i < 5; i++) {
    const r = FIELD_RANGES[i]
    parsed[r.name] = parseField(fields[i], r.min, r.max, r.name)
  }
  // Normalize dow=7 → 0 (Sunday). Cron has historically allowed both.
  if (parsed.dow.has(7)) { parsed.dow.delete(7); parsed.dow.add(0) }
  return parsed as CronExpr
}

/** Throws on bad cron with a specific error; otherwise returns the parsed form. */
export function validateCron(expr: string): CronExpr {
  return parseCron(expr)
}

/** Compute next time strictly *after* `from` matching this cron. Searches
 * minute-by-minute up to ~2 years; throws if nothing found (e.g. the
 * cron is `0 0 30 2 *` — Feb 30 never happens). 2-year cap is a sanity
 * stop, real production cron expressions never need that much lookahead. */
export function nextCronFire(expr: CronExpr, from: number): number {
  // Round up to the next whole minute boundary, +1min to ensure strict "after".
  const d = new Date(from)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  const cap = 366 * 24 * 60 * 2  // 2 years in minutes
  for (let i = 0; i < cap; i++) {
    const dow = d.getDay()
    if (
      expr.minute.has(d.getMinutes()) &&
      expr.hour.has(d.getHours()) &&
      expr.dom.has(d.getDate()) &&
      expr.month.has(d.getMonth() + 1) &&
      expr.dow.has(dow)
    ) {
      return d.getTime()
    }
    d.setMinutes(d.getMinutes() + 1)
  }
  throw new Error(`cron never matches within 2 years`)
}

// ── CRUD ────────────────────────────────────────────────────────────
function genId(): string {
  return randomBytes(6).toString('hex')
}

export interface CreateScheduleInput {
  project: string
  prompt: string
  mode?: ScheduleMode
  level?: ScheduleLevel
  name?: string
  cron?: string
  /** Relative one-shot delay (mutually exclusive with `cron`). */
  delaySeconds?: number
}

export function createSchedule(input: CreateScheduleInput): Schedule {
  if (!input.project) throw new Error('project required')
  if (!input.prompt) throw new Error('prompt required')
  const hasCron = !!input.cron
  const hasDelay = typeof input.delaySeconds === 'number'
  if (hasCron === hasDelay) throw new Error('exactly one of {cron, delaySeconds} required')

  const id = genId()
  const now = Date.now()
  let nextFireAt: number
  let cron: string | undefined
  let fireAt: number | undefined
  if (hasCron) {
    const parsed = validateCron(input.cron!)
    nextFireAt = nextCronFire(parsed, now)
    cron = input.cron
  } else {
    if (!Number.isFinite(input.delaySeconds!)) throw new Error('delaySeconds must be a finite number')
    if (input.delaySeconds! < 0) throw new Error('delaySeconds must be ≥ 0')
    fireAt = now + Math.round(input.delaySeconds! * 1000)
    nextFireAt = fireAt
  }
  const s: Schedule = {
    id,
    project: input.project,
    prompt: input.prompt,
    mode: input.mode ?? 'silent',
    level: input.level ?? 'info',
    name: input.name ?? id.slice(0, 8),
    cron,
    fireAt,
    createdAt: now,
    nextFireAt,
  }
  schedules.set(id, s)
  persist()
  log(`schedule: created id=${id} project=${s.project} mode=${s.mode} ${cron ? `cron="${cron}"` : `fireAt=${new Date(fireAt!).toISOString()}`}`)
  return s
}

export function listSchedules(project?: string): Schedule[] {
  const all = [...schedules.values()]
  return project ? all.filter(s => s.project === project) : all
}

export function getSchedule(id: string): Schedule | undefined {
  return schedules.get(id)
}

export function deleteSchedule(id: string, project?: string): boolean {
  const s = schedules.get(id)
  if (!s) return false
  if (project && s.project !== project) return false
  schedules.delete(id)
  persist()
  log(`schedule: deleted id=${id} project=${s.project}`)
  return true
}

/** Flip silent ↔ verbose. Project-scoped: returns null if id missing or
 * belongs to a different project. Returns the updated schedule on success. */
export function toggleScheduleMode(id: string, project?: string): Schedule | null {
  const s = schedules.get(id)
  if (!s) return null
  if (project && s.project !== project) return null
  s.mode = s.mode === 'silent' ? 'verbose' : 'silent'
  persist()
  log(`schedule: toggled mode id=${id} → ${s.mode}`)
  return s
}

// ── Tick + fire ─────────────────────────────────────────────────────

let tickTimer: ReturnType<typeof setInterval> | null = null

/** Boot — load persisted schedules, start the per-minute tick. Idempotent. */
export function startScheduler(): void {
  if (tickTimer) return
  load()
  // Run an immediate tick so any schedule whose nextFireAt is already in
  // the past (daemon was down across the firing time) fires on startup
  // rather than waiting up to a minute.
  void tick()
  tickTimer = setInterval(() => { void tick() }, 60_000)
  log(`schedule: scheduler started (tick=60s)`)
}

export function stopScheduler(): void {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
}

function clippedText(text: string): string {
  if (text.length <= RUN_LOG_TEXT_LIMIT) return text
  return `${text.slice(0, RUN_LOG_TEXT_LIMIT)}\n...[truncated ${text.length - RUN_LOG_TEXT_LIMIT} chars]`
}

function appendRunInspectionLog(
  workDir: string,
  s: Schedule,
  record: {
    elapsedMs: number
    exitCode: number | null
    finalText: string
    meta: CodexResultMeta
    toolCount: number
    sendMessageId: string | null
    sendError: string | null
  },
): void {
  const dir = join(workDir, RUN_LOG_DIR)
  const file = join(dir, RUN_LOG_FILE)
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(file, JSON.stringify({
      firedAt: new Date().toISOString(),
      scheduleId: s.id,
      name: s.name,
      project: s.project,
      trigger: s.cron ? 'cron' : 'once',
      cron: s.cron,
      fireAt: s.fireAt,
      mode: s.mode,
      level: s.level,
      elapsedMs: record.elapsedMs,
      exitCode: record.exitCode,
      result: record.meta,
      toolCount: record.toolCount,
      sendMessageId: record.sendMessageId,
      sendError: record.sendError,
      finalText: clippedText(record.finalText),
    }) + '\n')
  } catch (e) {
    log(`schedule: run inspection log append failed id=${s.id} file=${file}: ${e}`)
  }
}

async function tick(): Promise<void> {
  const now = Date.now()
  const due: Schedule[] = []
  for (const s of schedules.values()) {
    if (s.nextFireAt <= now) due.push(s)
  }
  if (due.length === 0) return
  // Fire each due schedule; one-shot (fireAt) gets deleted, recurring (cron)
  // gets nextFireAt advanced. Fires run concurrently — each gets its own
  // CodexProcess; they don't share state.
  for (const s of due) {
    if (s.cron) {
      try {
        const parsed = parseCron(s.cron)
        s.nextFireAt = nextCronFire(parsed, now)
        s.lastFiredAt = now
      } catch (e) {
        log(`schedule: cron parse failed for id=${s.id} cron="${s.cron}" — disabling: ${e}`)
        schedules.delete(s.id)
      }
    } else {
      // One-shot: delete BEFORE firing so a slow fire can't be re-triggered
      // by a subsequent tick.
      schedules.delete(s.id)
    }
    void fireSchedule(s).catch(e => log(`schedule: fire id=${s.id} crashed: ${e}`))
  }
  persist()
}

async function fireSchedule(s: Schedule): Promise<void> {
  const chatId = feishu.chatIdForSession(s.project)
  if (!chatId) {
    log(`schedule: fire id=${s.id} project="${s.project}" — no chat binding, skip`)
    return
  }
  const workDir = join(feishu.PROJECTS_ROOT, s.project)
  if (!existsSync(workDir)) {
    log(`schedule: fire id=${s.id} workDir="${workDir}" missing, skip`)
    return
  }
  log(`schedule: fire id=${s.id} project=${s.project} mode=${s.mode}`)

  const proc = new CodexProcess({
    workDir,
    permissionMode: 'bypassPermissions',
    appendSystemPrompt: CHANNEL_INSTRUCTIONS,
  })

  const assistantSegs: string[] = []
  let currentSeg = ''
  const tools = new Map<string, CollectedTool>()
  const toolOrder: string[] = []
  const startedAt = Date.now()
  let exitCode: number | null = null

  const flushSeg = () => {
    if (currentSeg) { assistantSegs.push(currentSeg); currentSeg = '' }
  }

  // CodexProcess queues sendUserText behind app-server initialization,
  // so schedules can issue initialize + prompt back-to-back.
  proc.on('assistant_text', ({ text }: { text: string }) => {
    currentSeg += text
  })
  proc.on('tool_use', ({ id, name, input }: { id: string; name: string; input: any }) => {
    // A new tool means the current assistant text segment ends here.
    flushSeg()
    tools.set(id, { id, name, input, output: null, isError: false })
    toolOrder.push(id)
  })
  proc.on('tool_result', ({ tool_use_id, content, is_error }: { tool_use_id: string; content: any; is_error: boolean }) => {
    const t = tools.get(tool_use_id)
    if (!t) return
    t.output = typeof content === 'string' ? content : JSON.stringify(content)
    t.isError = !!is_error
  })
  proc.on('error', err => {
    log(`schedule: fire id=${s.id} codex error: ${err}`)
  })

  const resultPromise = new Promise<void>((resolve) => {
    proc.on('result', () => {
      flushSeg()
      resolve()
    })
    proc.on('exit', ({ code }: { code: number | null }) => {
      exitCode = code
      // exit before result → crashed mid-turn. Resolve so we can surface it.
      flushSeg()
      resolve()
    })
  })

  proc.sendInitialize()
  proc.sendUserText(s.prompt)
  // Watchdog: schedules without bounded runtime hang the daemon's memory.
  // 30 min ceiling — anything longer is a user error (or our bug).
  const timeoutMs = 30 * 60 * 1000
  await Promise.race([
    resultPromise,
    new Promise<void>(resolve => setTimeout(() => {
      log(`schedule: fire id=${s.id} watchdog timeout (${timeoutMs}ms), killing`)
      resolve()
    }, timeoutMs)),
  ])

  const elapsedMs = Date.now() - startedAt
  const finalText = assistantSegs.join('\n\n').trim()
  const meta = proc.lastResult
  let sendMessageId: string | null = null
  let sendError: string | null = null

  // Render output before killing the process — `proc.lastResult` is read
  // while the proc is still alive (already populated by 'result').
  try {
    if (s.mode === 'verbose') {
      const card = scheduledSummaryCard({
        name: s.name,
        project: s.project,
        prompt: s.prompt,
        assistantSegs,
        tools: toolOrder.map(id => tools.get(id)!).filter(Boolean),
        elapsedMs,
        meta,
        crashed: exitCode !== null && meta.subtype === null,
        level: s.level,
      })
      const msgId = await feishu.sendCard(chatId, card)
      sendMessageId = msgId
      if (!msgId) sendError = 'sendCard returned null'
      log(`schedule: fire id=${s.id} verbose card sent msg=${msgId ?? 'FAILED'}`)
    } else {
      // silent (B mode) — notify-style card with just the final assistant text.
      // Empty finalText (e.g. Codex only used tools and ended silently)
      // surfaces as `_（无文字输出）_` instead of an empty body.
      const card = notifyCardForScheduled({
        title: `⏰ ${s.name}`,
        text: finalText || '_（无文字输出）_',
        level: s.level,
        elapsedMs,
      })
      const msgId = await feishu.sendCard(chatId, card)
      sendMessageId = msgId
      if (!msgId) sendError = 'sendCard returned null'
      log(`schedule: fire id=${s.id} silent notify sent msg=${msgId ?? 'FAILED'}`)
    }
  } catch (e) {
    sendError = String(e)
    log(`schedule: fire id=${s.id} render/send failed: ${e}`)
  }
  appendRunInspectionLog(workDir, s, {
    elapsedMs,
    exitCode,
    finalText,
    meta,
    toolCount: toolOrder.length,
    sendMessageId,
    sendError,
  })

  // Clean up the subprocess. SIGTERM with short grace — automation
  // shouldn't have anything stateful to flush.
  await proc.kill(3000).catch(() => {})
}
