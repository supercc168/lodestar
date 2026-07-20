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
import { buildGsdInjectPrompt } from './gsd-prompt'

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

/** Bareword: `gsd` or `gsd status` (case-insensitive). */
export function isGsdBareword(raw: string): boolean {
  return /^gsd(?:\s+status)?$/i.test(raw.trim())
}

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
  s.gsdPanelGen = String(Date.now())
  return cards.gsdPanelCard({
    snapshot,
    providerLabel: providerLabel(s),
    panelGen: s.gsdPanelGen,
    notice,
    awaitingName,
  })
}

async function publishCard(
  s: Session,
  card: object,
  opts?: { preferUpdate?: boolean },
): Promise<void> {
  const preferUpdate = opts?.preferUpdate !== false
  if (preferUpdate && s.gsdPanelMessageId) {
    try {
      await feishu.updateCard(s.gsdPanelMessageId, card)
      return
    } catch (e) {
      log(`session "${s.sessionName}": gsd panel update failed: ${messageOf(e)}; resending`)
    }
  }
  const messageId = await feishu.sendCard(s.chatId, card)
  if (messageId) {
    s.gsdPanelMessageId = messageId
  } else {
    log(`session "${s.sessionName}": gsd panel send failed`)
    await feishu.sendTextRaw(s.chatId, '❌ gsd 面板发送失败')
  }
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

export async function onGsdRefresh(
  s: Session,
  _taskSlug: string,
  panelGen: string,
): Promise<GsdActionResult> {
  const stale = validatePanelGen(s, panelGen)
  if (stale) return stale
  const awaiting = s.gsdAwaitingNameUntil > Date.now()
  return resultWithCard(s, true, '已刷新', 'success', awaiting)
}

export async function onGsdContinue(
  s: Session,
  taskSlug: string,
  panelGen: string,
): Promise<GsdActionResult> {
  const stale = validatePanelGen(s, panelGen)
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
    const prompt = buildGsdInjectPrompt({
      action: 'continue',
      taskSlug: snap.taskSlug,
      taskName: snap.taskName || snap.taskSlug,
      provider: s.currentProvider(),
    })
    // Non-blocking inject: after validation / busy / resume / bridge, fire
    // onUserMessage and return the card immediately so Feishu ACK is not
    // blocked on cold-start / openTurnCard latency. Residual risk: inject
    // failure is only logged (store already resumed); prefer low ACK latency
    // over awaiting full turn open. Matches daemon toast-first long-ops
    // (fork/back/resume). Create-task path still awaits (needs inject outcome
    // for re-arm awaiting on failure).
    void s.onUserMessage(prompt).catch(e => {
      log(`session "${s.sessionName}": gsd continue inject failed: ${messageOf(e)}`)
    })
    return resultWithCard(s, true, '已注入')
  } catch (e) {
    const message = `继续失败: ${messageOf(e)}`
    log(`session "${s.sessionName}": gsd continue failed: ${messageOf(e)}`)
    return resultWithCard(s, false, message)
  }
}

export async function onGsdPause(
  s: Session,
  taskSlug: string,
  panelGen: string,
): Promise<GsdActionResult> {
  const stale = validatePanelGen(s, panelGen)
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
  panelGen: string,
): Promise<GsdActionResult> {
  const stale = validatePanelGen(s, panelGen)
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
  panelGen: string,
): Promise<GsdActionResult> {
  const stale = validatePanelGen(s, panelGen)
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

  try {
    clearStaleIdleQueueIfSafe(s, 'gsd_new_task_name')
    if (s.isRunning() && isSessionBusy(s)) {
      // Re-arm so user can retry after the turn settles.
      s.gsdAwaitingNameUntil = Date.now() + GSD_AWAITING_NAME_MS
      await feishu.sendText(s.chatId, `❌ ${GSD_BUSY_MSG}`)
      const card = buildCard(s, { type: 'error', content: `❌ ${GSD_BUSY_MSG}` }, true)
      await publishCard(s, card)
      return true
    }

    const snap: GsdSnapshot = createAndActivateTask(s.workDir, name)
    ensureBridge(s.workDir, snap.taskSlug)

    // Invalidate panel gen before await inject (anti double-create / double-inject).
    bumpGsdPanelGen(s)

    const prompt = buildGsdInjectPrompt({
      action: 'new-task-discuss',
      taskSlug: snap.taskSlug,
      taskName: snap.taskName || name,
      provider: s.currentProvider(),
    })

    const card = buildCard(s, {
      type: 'success',
      content: `✅ 已创建任务 ${snap.taskName || name}，正在注入…`,
    })
    await publishCard(s, card)
    await s.onUserMessage(prompt)
    return true
  } catch (e) {
    const message = `创建任务失败: ${messageOf(e)}`
    log(`session "${s.sessionName}": gsd create task failed: ${messageOf(e)}`)
    // Keep awaiting so user can retype a name after a transient failure.
    s.gsdAwaitingNameUntil = Date.now() + GSD_AWAITING_NAME_MS
    const card = buildCard(s, { type: 'error', content: `❌ ${message}` }, true)
    await publishCard(s, card)
    await feishu.sendText(s.chatId, `❌ ${message}`)
    return true
  }
}
