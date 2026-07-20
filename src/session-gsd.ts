import type { Session } from './session'
import * as cards from './cards'
import * as feishu from './feishu'
import { agentProviderLabel } from './agent-process'
import { log } from './log'
import { messageOf } from './session-util'
import {
  completeActiveTask,
  createAndActivateTask,
  pauseActiveTask,
  readGsdSnapshot,
  resumeActiveTask,
  type GsdSnapshot,
} from './gsd-store'
import { planningHealth, switchActivePlanning } from './gsd-bridge'
import {
  buildGsdInjectPrompt,
  isGsdInjectPrompt,
  parseGsdInjectTaskSlug,
} from './gsd-prompt'

export const GSD_AWAITING_NAME_MS = 300_000
export const GSD_PANEL_STALE_MSG = '面板已过期，请发 gsd 刷新'
export const GSD_BUSY_MSG = '会话忙碌，稍后再继续 GSD'

export type GsdActionResult = {
  ok: boolean
  message: string
  card?: object
}

/** Cancel awaiting_name capture (timeout / control command / bare gsd / successful consume). */
export function clearGsdAwaitingName(s: Session): void {
  s.gsdAwaitingNameUntil = 0
}

/** Clear session-local “currently executing GSD” marker. */
export function clearGsdExecution(s: Session): void {
  s.gsdExecution = null
}

/**
 * Mark this session as actively executing GSD for `taskSlug`.
 * Pure session memory — not a second state source for TRACKER.
 */
export function markGsdExecution(
  s: Session,
  taskSlug: string,
  source: 'inject' | 'message' = 'inject',
): void {
  const slug = taskSlug.trim()
  if (!slug) return
  s.gsdExecution = { taskSlug: slug, source, at: Date.now() }
}

/**
 * Observe a user-facing message for GSD execution detection.
 * - Inject templates (`[Lodestar GSD]`) arm execution for their task_slug.
 * - Non-GSD text that **starts its own turn** clears execution (ordinary chat).
 * - Mid-turn buffered messages do not clear (in-flight GSD may still be active).
 *
 * Callers must not pass `startsOwnTurn: true` on early-return paths that never
 * open/queue a real agent turn (agy busy reject, watchdog hold, etc.).
 */
export function noteGsdUserMessage(
  s: Session,
  text: string,
  opts?: { startsOwnTurn?: boolean },
): void {
  if (isGsdInjectPrompt(text)) {
    const slug =
      parseGsdInjectTaskSlug(text) ||
      readGsdSnapshot(s.workDir).taskSlug ||
      s.gsdExecution?.taskSlug ||
      ''
    if (slug) markGsdExecution(s, slug, 'inject')
    return
  }
  if (opts?.startsOwnTurn) {
    // Ordinary user turn supersedes prior GSD-exec signal.
    clearGsdExecution(s)
  }
}

/** Arm execution from inject text only — never clears. Safe before early returns. */
export function noteGsdInjectIfAny(s: Session, text: string): void {
  noteGsdUserMessage(s, text, { startsOwnTurn: false })
}

/**
 * Fine progress (plan bar / cursor) is shown only when:
 * 1. disk active task is 运行中, and
 * 2. this session is marked as executing that same task (gsdExecution).
 */
export function shouldShowGsdProgress(
  snapshot: GsdSnapshot,
  gsdExecution: Session['gsdExecution'],
): boolean {
  if (snapshot.status !== '运行中') return false
  if (!snapshot.taskSlug) return false
  if (!gsdExecution?.taskSlug) return false
  return gsdExecution.taskSlug === snapshot.taskSlug
}

/**
 * Reserved GSD control text: bare `gsd` / `gsd status` / known subcommands.
 * Used so awaiting_name and agent forward do not swallow these.
 */
export function isGsdBareword(raw: string): boolean {
  return parseGsdTextCommand(raw) !== null
}

/** Parsed Feishu/chat text command for GSD (null = not a gsd control). */
export type GsdTextCommand =
  | { kind: 'panel' }
  | { kind: 'continue' }
  | { kind: 'pause' }
  | { kind: 'complete' }
  | { kind: 'new'; name?: string }
  | { kind: 'help' }

const GSD_CONTINUE_SUB = new Set(['continue', 'go', 'next', '续', '继续'])
const GSD_PAUSE_SUB = new Set(['pause', '暂停'])
const GSD_COMPLETE_SUB = new Set(['complete', 'done', '完成'])
const GSD_NEW_SUB = new Set(['new', 'start', '新任务', '开任务'])
const GSD_HELP_SUB = new Set(['help', '?', '帮助'])

/**
 * Parse `gsd` text controls. Unknown `gsd …` forms return null so freeform
 * text can still reach the agent (e.g. "gsd 风格的重构思路").
 */
export function parseGsdTextCommand(raw: string): GsdTextCommand | null {
  const t = raw.trim()
  if (!t) return null
  if (/^gsd(?:\s+status)?$/i.test(t)) return { kind: 'panel' }

  const m = t.match(/^gsd\s+(\S+)(?:\s+([\s\S]+))?$/i)
  if (!m) return null
  const sub = m[1].toLowerCase()
  const rest = (m[2] ?? '').trim()

  if (GSD_CONTINUE_SUB.has(sub)) return { kind: 'continue' }
  if (GSD_PAUSE_SUB.has(sub)) return { kind: 'pause' }
  if (GSD_COMPLETE_SUB.has(sub)) return { kind: 'complete' }
  if (GSD_NEW_SUB.has(sub)) {
    return rest ? { kind: 'new', name: rest } : { kind: 'new' }
  }
  if (GSD_HELP_SUB.has(sub)) return { kind: 'help' }
  return null
}

export const GSD_HELP_TEXT = [
  'GSD 命令：',
  '· `gsd` / `gsd status` — 打开/刷新状态卡',
  '· `gsd continue`（go/next/继续）— 标记本会话执行并注入推进',
  '· `gsd pause`（暂停）— 暂停活跃任务',
  '· `gsd done`（complete/完成）— 标记完成',
  '· `gsd new [任务名]` / `gsd start [任务名]` — 无名称则等下一条消息；有名称则直接创建并注入',
  '· `gsd help` — 本说明',
  '细进度仅在本会话标记为执行中且磁盘任务为运行中时显示。',
].join('\n')

export function validatePanelGen(s: Session, panelGen: string): GsdActionResult | null {
  if (!panelGen || panelGen !== s.gsdPanelGen) {
    return { ok: false, message: GSD_PANEL_STALE_MSG }
  }
  return null
}

function providerLabel(s: Session): string {
  return agentProviderLabel(s.currentProvider())
}

function isSessionBusy(s: Session): boolean {
  // Same mid-turn signals as onUserMessage's wasBusy / drain guards.
  return !!(
    s.currentTurn ||
    s.openingTurn ||
    s.pendingUserMessageCount > 0 ||
    s.pendingMidTurnMsgs.length > 0
  )
}

/** Drop abandoned idle queue counters before GSD busy checks (no-op when mid-turn). */
function clearStaleIdleQueueIfSafe(s: Session, reason: string): void {
  if (typeof s.clearStaleIdleQueueState !== 'function') return
  // Only when the session looks idle enough that a false busy is plausible.
  if (s.currentTurn || s.openingTurn) return
  s.clearStaleIdleQueueState(reason)
}

/** Invalidate the current panel gen so a concurrent second click fails validatePanelGen. */
export function bumpGsdPanelGen(s: Session): string {
  s.gsdPanelGen = String(Date.now())
  return s.gsdPanelGen
}

/**
 * Pure ordering helper for continue: busy must be decided before any resume/bridge mutation.
 * Used by unit tests to lock the side-effect order.
 */
export function gsdContinueMayMutateStore(args: {
  panelGenOk: boolean
  isRunning: boolean
  isBusy: boolean
}): boolean {
  if (!args.panelGenOk) return false
  if (args.isRunning && args.isBusy) return false
  return true
}

function buildCard(
  s: Session,
  notice?: cards.GsdPanelNotice,
  awaitingName = false,
): object {
  const snapshot = readGsdSnapshot(s.workDir)
  // Stale execution marker (task switched / no longer running) → drop it.
  if (
    s.gsdExecution &&
    (snapshot.status !== '运行中' ||
      !snapshot.taskSlug ||
      s.gsdExecution.taskSlug !== snapshot.taskSlug)
  ) {
    clearGsdExecution(s)
  }
  s.gsdPanelGen = String(Date.now())
  return cards.gsdPanelCard({
    snapshot,
    providerLabel: providerLabel(s),
    panelGen: s.gsdPanelGen,
    notice,
    awaitingName,
    showProgress: shouldShowGsdProgress(snapshot, s.gsdExecution),
  })
}

/** @returns true when the card was updated or a new panel message id was stored. */
async function publishCard(
  s: Session,
  card: object,
  opts?: { preferUpdate?: boolean },
): Promise<boolean> {
  const preferUpdate = opts?.preferUpdate !== false
  if (preferUpdate && s.gsdPanelMessageId) {
    try {
      await feishu.updateCard(s.gsdPanelMessageId, card)
      return true
    } catch (e) {
      log(`session "${s.sessionName}": gsd panel update failed: ${messageOf(e)}; resending`)
    }
  }
  const messageId = await feishu.sendCard(s.chatId, card)
  if (messageId) {
    s.gsdPanelMessageId = messageId
    return true
  }
  log(`session "${s.sessionName}": gsd panel send failed`)
  await feishu.sendTextRaw(s.chatId, '❌ gsd 面板发送失败')
  return false
}

function resultWithCard(
  s: Session,
  ok: boolean,
  message: string,
  noticeType: cards.GsdPanelNotice['type'] = ok ? 'success' : 'error',
  awaitingName = false,
): GsdActionResult {
  const prefix = ok ? '✅' : '❌'
  const card = buildCard(
    s,
    { type: noticeType, content: `${prefix} ${message}` },
    awaitingName,
  )
  return { ok, message, card }
}

function ensureBridge(projectRoot: string, taskSlug: string): void {
  let health = planningHealth(projectRoot)
  if (health.ok) return
  health = switchActivePlanning(projectRoot, taskSlug)
  if (!health.ok) {
    throw new Error(`planning bridge 不可用 (${health.kind})`)
  }
}

export async function showGsdPanel(s: Session): Promise<void> {
  const awaiting = s.gsdAwaitingNameUntil > Date.now()
  const card = buildCard(s, undefined, awaiting)
  // Prefer in-place update when a panel message is already known; else send.
  await publishCard(s, card)
}

export async function refreshGsdPanelIfPresent(s: Session): Promise<void> {
  if (!s.gsdPanelMessageId) return
  try {
    const awaiting = s.gsdAwaitingNameUntil > Date.now()
    const card = buildCard(s, undefined, awaiting)
    await publishCard(s, card)
  } catch (e) {
    log(`session "${s.sessionName}": refreshGsdPanelIfPresent failed: ${messageOf(e)}`)
  }
}

/**
 * Panel buttons pass a non-null panelGen (must match).
 * Text commands pass `null` to skip generation checks.
 */
function checkPanelGen(
  s: Session,
  panelGen: string | null | undefined,
): GsdActionResult | null {
  if (panelGen == null) return null
  return validatePanelGen(s, panelGen)
}

export async function onGsdRefresh(
  s: Session,
  _taskSlug: string,
  panelGen: string | null = null,
): Promise<GsdActionResult> {
  const stale = checkPanelGen(s, panelGen)
  if (stale) return stale
  const awaiting = s.gsdAwaitingNameUntil > Date.now()
  return resultWithCard(s, true, '已刷新', 'success', awaiting)
}

export async function onGsdContinue(
  s: Session,
  taskSlug: string,
  panelGen: string | null = null,
): Promise<GsdActionResult> {
  const stale = checkPanelGen(s, panelGen)
  if (stale) return stale

  try {
    // Read-only prechecks first — never resume / switch bridge while busy.
    const snapBefore = readGsdSnapshot(s.workDir)
    if (snapBefore.status !== '运行中' && snapBefore.status !== '已暂停') {
      return resultWithCard(s, false, '没有可继续的 GSD 任务（需运行中或已暂停）')
    }
    if (taskSlug && snapBefore.taskSlug && taskSlug !== snapBefore.taskSlug) {
      return resultWithCard(s, false, '任务已切换，请刷新面板')
    }
    if (!snapBefore.taskSlug) {
      return resultWithCard(s, false, '没有活跃 task_slug')
    }

    // Clear abandoned idle queue counters (safe no-op mid-turn) before busy check.
    clearStaleIdleQueueIfSafe(s, 'gsd_continue')
    if (s.isRunning() && isSessionBusy(s)) {
      // Busy: return without mutating store/bridge or bumping panelGen for inject.
      return resultWithCard(s, false, GSD_BUSY_MSG)
    }

    let snap = snapBefore
    if (snap.status === '已暂停') {
      snap = resumeActiveTask(s.workDir)
    }
    if (!snap.taskSlug) {
      return resultWithCard(s, false, '没有活跃 task_slug')
    }

    ensureBridge(s.workDir, snap.taskSlug)

    // Invalidate panel gen before inject so a second click with the old
    // gen fails validatePanelGen (anti double-continue / double-inject).
    bumpGsdPanelGen(s)

    // Continue supersedes name capture; never treat the inject template as a name.
    clearGsdAwaitingName(s)
    // Arm execution before inject so the returned panel already shows fine progress.
    markGsdExecution(s, snap.taskSlug, 'inject')
    const prompt = buildGsdInjectPrompt({
      action: 'continue',
      taskSlug: snap.taskSlug,
      taskName: snap.taskName || snap.taskSlug,
      provider: s.currentProvider(),
    })
    // Non-blocking inject: after validation / busy / resume / bridge, fire
    // onUserMessage and return the card immediately so Feishu ACK is not
    // blocked on cold-start / openTurnCard latency. On inject failure clear
    // the session execution marker so the panel does not keep showing fine
    // progress as if GSD were running. Disk may stay 运行中 after resume —
    // user can retry `gsd continue`. Matches daemon toast-first long-ops
    // (fork/back/resume). Create-task path still awaits (needs inject outcome).
    void s.onUserMessage(prompt).catch(e => {
      log(`session "${s.sessionName}": gsd continue inject failed: ${messageOf(e)}`)
      clearGsdExecution(s)
      void refreshGsdPanelIfPresent(s)
    })
    return resultWithCard(s, true, '已注入')
  } catch (e) {
    const message = `继续失败: ${messageOf(e)}`
    log(`session "${s.sessionName}": gsd continue failed: ${messageOf(e)}`)
    clearGsdExecution(s)
    return resultWithCard(s, false, message)
  }
}

export async function onGsdPause(
  s: Session,
  taskSlug: string,
  panelGen: string | null = null,
): Promise<GsdActionResult> {
  const stale = checkPanelGen(s, panelGen)
  if (stale) return stale

  try {
    const before = readGsdSnapshot(s.workDir)
    if (taskSlug && before.taskSlug && taskSlug !== before.taskSlug) {
      return resultWithCard(s, false, '任务已切换，请刷新面板')
    }
    if (before.status !== '运行中') {
      return resultWithCard(s, false, '仅运行中任务可暂停')
    }
    const snap = pauseActiveTask(s.workDir)
    clearGsdExecution(s)
    return resultWithCard(s, true, snap.status === '已暂停' ? '已暂停' : '暂停未生效')
  } catch (e) {
    const message = `暂停失败: ${messageOf(e)}`
    log(`session "${s.sessionName}": gsd pause failed: ${messageOf(e)}`)
    return resultWithCard(s, false, message)
  }
}

export async function onGsdComplete(
  s: Session,
  taskSlug: string,
  panelGen: string | null = null,
): Promise<GsdActionResult> {
  const stale = checkPanelGen(s, panelGen)
  if (stale) return stale

  try {
    const before = readGsdSnapshot(s.workDir)
    if (taskSlug && before.taskSlug && taskSlug !== before.taskSlug) {
      return resultWithCard(s, false, '任务已切换，请刷新面板')
    }
    if (before.status !== '运行中' && before.status !== '已暂停') {
      return resultWithCard(s, false, '没有可完成的 GSD 任务')
    }
    const snap = completeActiveTask(s.workDir)
    clearGsdExecution(s)
    return resultWithCard(s, true, snap.status === '已完成' ? '已完成' : '完成未生效')
  } catch (e) {
    const message = `完成失败: ${messageOf(e)}`
    log(`session "${s.sessionName}": gsd complete failed: ${messageOf(e)}`)
    return resultWithCard(s, false, message)
  }
}

export async function onGsdNewPrompt(
  s: Session,
  _taskSlug: string,
  panelGen: string | null = null,
): Promise<GsdActionResult> {
  const stale = checkPanelGen(s, panelGen)
  if (stale) return stale

  s.gsdAwaitingNameUntil = Date.now() + GSD_AWAITING_NAME_MS
  return resultWithCard(
    s,
    true,
    '请发送下一条消息作为新任务名称（约 300s 内）',
    'info',
    true,
  )
}

/**
 * Create + activate + inject discuss for a named task.
 * Shared by awaiting-name capture and `gsd new|start <name>` text commands.
 */
export async function startNamedGsdTask(
  s: Session,
  name: string,
): Promise<GsdActionResult> {
  const taskName = name.trim()
  if (!taskName) {
    return resultWithCard(s, false, '任务名不能为空', 'error', true)
  }

  let createdSlug = ''
  try {
    clearStaleIdleQueueIfSafe(s, 'gsd_new_task_name')
    if (s.isRunning() && isSessionBusy(s)) {
      return resultWithCard(s, false, GSD_BUSY_MSG, 'error', false)
    }

    const snap: GsdSnapshot = createAndActivateTask(s.workDir, taskName)
    createdSlug = snap.taskSlug
    ensureBridge(s.workDir, snap.taskSlug)

    // Invalidate panel gen before await inject (anti double-create / double-inject).
    bumpGsdPanelGen(s)
    // New task inject counts as GSD execution for this session.
    markGsdExecution(s, snap.taskSlug, 'inject')

    const prompt = buildGsdInjectPrompt({
      action: 'new-task-discuss',
      taskSlug: snap.taskSlug,
      taskName: snap.taskName || taskName,
      provider: s.currentProvider(),
    })

    const card = buildCard(s, {
      type: 'success',
      content: `✅ 已创建任务 ${snap.taskName || taskName}，正在注入…`,
    })
    // Caller may publish; also return card for panel/command paths.
    await publishCard(s, card)
    await s.onUserMessage(prompt)
    return {
      ok: true,
      message: `已创建任务 ${snap.taskName || taskName}`,
      card,
    }
  } catch (e) {
    // Disk may already have the new task as 运行中 after createAndActivateTask.
    // Never leave a sticky session execution marker without a live inject turn.
    clearGsdExecution(s)
    const detail = messageOf(e)
    const message = createdSlug
      ? `任务已创建（${createdSlug}）但未成功注入: ${detail}。可发 gsd continue 重试。`
      : `创建任务失败: ${detail}`
    log(`session "${s.sessionName}": gsd create task failed: ${detail}`)
    return resultWithCard(s, false, message)
  }
}

/**
 * Text-command entry for GSD controls (no panel_gen).
 * Publishes/updates the GSD card when a result card is produced.
 */
export async function runGsdTextCommand(
  s: Session,
  raw: string,
): Promise<boolean> {
  const cmd = parseGsdTextCommand(raw)
  if (!cmd) return false

  if (cmd.kind === 'help') {
    await feishu.sendText(s.chatId, GSD_HELP_TEXT)
    return true
  }
  if (cmd.kind === 'panel') {
    await showGsdPanel(s)
    return true
  }

  let result: GsdActionResult
  switch (cmd.kind) {
    case 'continue':
      result = await onGsdContinue(s, '', null)
      break
    case 'pause':
      result = await onGsdPause(s, '', null)
      break
    case 'complete':
      result = await onGsdComplete(s, '', null)
      break
    case 'new':
      if (cmd.name) {
        clearGsdAwaitingName(s)
        result = await startNamedGsdTask(s, cmd.name)
        // startNamedGsdTask already published on success; still publish on error.
        if (!result.ok && result.card) await publishCard(s, result.card)
        if (!result.ok) {
          await feishu.sendText(s.chatId, `❌ ${result.message}`)
        }
        return true
      }
      result = await onGsdNewPrompt(s, '', null)
      break
    default:
      return false
  }

  const published = result.card ? await publishCard(s, result.card) : false
  if (!result.ok) {
    await feishu.sendText(s.chatId, `❌ ${result.message}`)
  } else if (!result.card) {
    await feishu.sendText(s.chatId, `✅ ${result.message}`)
  } else if (!published) {
    // publishCard already posted "面板发送失败"; do not also claim ✅ success.
    // Surface that the control action itself still ran (continue inject, etc.).
    await feishu.sendText(s.chatId, `⚠️ 面板未更新：${result.message}`)
  }
  return true
}

export async function maybeConsumeGsdTaskName(s: Session, text: string): Promise<boolean> {
  if (!(s.gsdAwaitingNameUntil > Date.now())) return false

  const name = text.trim()
  // Empty / pure whitespace: keep awaiting; do not forward as agent turn.
  if (!name) {
    await feishu.sendText(s.chatId, '⚠️ 任务名不能为空，请重新发送任务名称')
    return true
  }
  // Internal inject templates (and accidental re-entry) must reach the agent.
  if (name.startsWith('[Lodestar GSD]')) return false
  // Control barewords and nested gsd commands should not become task names.
  // (Primary path: session-commands clears awaiting when the control is
  // consumed; this is a belt-and-suspenders for gsd if it ever lands here.)
  if (isGsdBareword(name)) {
    clearGsdAwaitingName(s)
    return false
  }

  clearGsdAwaitingName(s)

  const result = await startNamedGsdTask(s, name)
  if (!result.ok) {
    // Keep awaiting so user can retype a name after a transient failure.
    s.gsdAwaitingNameUntil = Date.now() + GSD_AWAITING_NAME_MS
    if (result.card) {
      // Rebuild with awaiting flag for the waiting prompt line.
      const card = buildCard(s, { type: 'error', content: `❌ ${result.message}` }, true)
      await publishCard(s, card)
    }
    await feishu.sendText(s.chatId, `❌ ${result.message}`)
  }
  return true
}
