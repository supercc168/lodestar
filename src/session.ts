/**
 * Session — 1 Feishu chat ↔ 1 Codex app-server process ↔ 1 streaming card.
 *
 * Owns the CodexProcess lifecycle, the per-turn card state machine, and
 * the in-flight permission map.  Wires Codex app-server events into Card
 * Kit ops, and wires Feishu inbound (text + card-action callbacks) into
 * Codex turns.
 *
 * Tool tracking, AskUserQuestion flow, and permission rendering live in
 * sibling modules (session-tools.ts, session-ask.ts,
 * session-permission.ts) so this file stays under Codex's
 * per-read token budget (~25K). Fields touched by those helpers carry
 * no `private` modifier — convention is "no modifier = package-internal,
 * only the session-*.ts helpers should touch it."
 */

import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import {
  CODEX_EFFORT,
  CodexProcess,
  diffUsageTotals,
  effectiveTurnTokens,
  isCodexReasoningEffort,
  type CanUseToolRequest,
  type CodexModel,
  type CodexReasoningEffort,
  type CodexUsage,
  type ContextCompactedNotification,
  type HookCallbackRequest,
  type PlanDelta,
  type TokenUsageUpdated,
  type ThreadGoal,
  type TurnPlanUpdated,
} from './codex-process'
import { CHANNEL_INSTRUCTIONS } from './instructions'
import * as cardkit from './cardkit'
import * as cards from './cards'
import * as feishu from './feishu'
import { log } from './log'
import { readSysInfo } from './sysinfo'
import { readUsage, updateUsageFromRateLimits, type UsageSnapshot } from './usage'
import { contextLimitFromAppServer, contextTokensFromUsage } from './context-window'
import { extractAskUsrMarkers, extractSendMarkerPaths, stripAskUsrMarkers } from './outbound-markers'
import type { TurnState, Status, SessionOpts, LastTurnDelta, CumStats } from './session-types'
import * as sessionTools from './session-tools'
import * as sessionAsk from './session-ask'
import * as sessionHostAsk from './session-host-ask'
import * as sessionPermission from './session-permission'
import * as worktree from './worktree'

export type { SessionOpts } from './session-types'

function compactionKey(notice: ContextCompactedNotification): string {
  return notice.itemId || notice.turnId || '__latest__'
}

function latestPendingCompactionKey(turn: TurnState): string | null {
  let key: string | null = null
  for (const k of turn.contextCompactionPending.keys()) key = k
  return key
}

function mergeCompactionNotices(
  start: ContextCompactedNotification | undefined,
  end: ContextCompactedNotification,
): ContextCompactedNotification {
  if (!start) return end
  return { ...start, ...end, phase: 'end' }
}

const FOOTER_STATUS_TICK_MS = 1000
const FOOTER_THINKING_PREFIX = 'Thinking...'
const FOOTER_WORKING = 'Working...'
const RESUME_INIT_NOTICE_MS = 10_000
const RESUME_INIT_TIMEOUT_MS = 120_000

interface ModelPanelState {
  models: cards.ModelChoice[]
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type WorktreeActionResult = { ok: boolean; message: string; card: object }
type ModelActionResult = { ok: boolean; message: string; card?: object }

/** Soft cap on element count per Feishu card before we proactively
 * rotate to a fresh one. The hard ceiling is NOT ~100 as once assumed:
 * a 2026-05-23 dogfood turn hit `300305 [element exceeds the limit]` at
 * ~76 elements (tool_60 + assistant_13 + base). The old soft cap of 80
 * sat ABOVE the real ceiling, so `getElementCount() >= 80` never became
 * true before Feishu rejected the add — rotation never fired and the card
 * froze mid-turn. Keep this comfortably under the observed ~75; 50 leaves
 * headroom for in-flight stream handlers that already chose the old cardId
 * before this check fired, and for heavier element mixes that trip the
 * limit earlier. This number is no longer the only line of defense:
 * addElement's 300305/300315 now forces a rotate directly (see
 * Session.onCardWriteFailure), so a wrong guess here still self-heals. */
const CARD_ELEMENT_SOFT_LIMIT = 50

/** Max mid-turn card rotations per turn. Past this we stop opening fresh
 * cards and fall back to log-only for the rest of the turn. Guards the
 * "rotate on any write failure" path against a runaway loop where every
 * card keeps failing (Feishu outage, or an element whose own content
 * Feishu rejects on every card) — without a cap that would spray an
 * endless trail of empty cards into the chat. */
const MAX_MIDTURN_ROTATES = 5

interface LifecycleProgressOpts {
  announce?: boolean
  onStatus?: (status: string) => void
}

interface FooterTimer {
  setStatus(status: string): void
  stop(): void
  elapsedSec(): string
}

interface StatusCardHandle {
  cardId: string
  title: string
  timer: FooterTimer
}

function timedStatus(status: string, startedAt: number): string {
  const elapsedS = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  return `${status} (${elapsedS}s)`
}

function staticAssistantElementId(streamElementId: string): string {
  return `${streamElementId}_static`
}

export class Session {
  /** Process-wide registry of every Session ever constructed in this daemon.
   * Used by the `hi` console panel to enumerate sibling sessions across
   * Feishu groups. Sessions are never removed (matches the daemon's
   * `sessions` map lifecycle — one Session per chat for the daemon's
   * lifetime). Callers should filter on `isRunning()` when they only
   * want currently-alive Codex processes. */
  static readonly all: Set<Session> = new Set()

  // ── package-internal state (touched by session-*.ts helpers) ──
  proc: CodexProcess | null = null
  currentTurn: TurnState | null = null
  pendingPermissions = new Map<string, { toolUseId: string }>()
  /** Open AskUserQuestion tool calls — keyed by tool_use_id. The SDK
   * routes AskUserQuestion through the can_use_tool flow even under
   * bypass; we have to thread the permission `requestId` through here
   * so the answer (option click OR custom text submit) can resolve
   * the permission with `updatedInput.answers` populated.
   * `deferredAnswer` covers the race where the user clicks/submits
   * BEFORE can_use_tool arrives (addTool fires on the assistant
   * message; can_use_tool is a separate control_request that lands
   * slightly later). */
  pendingAsks = new Map<string, {
    questions: cards.AskQuestion[]
    i: number
    requestId?: string
    /** 累计答案 — key 是 question 原文 (SDK 把这条 record 格式
     * 化进 tool_result), value 是用户选的 option label 或自定
     * 义文字。全部 question 都答完时一并塞进 updatedInput.answers
     * 发回 SDK。 */
    answers: Record<string, string>
    /** 已答详情 (按 question idx 索引)，用来给历史面板和 terminal
     * 状态画选中态。answers 同步累计，但这里多保留 customText /
     * optionIdx 字段以便 UI 区分两种回答路径。 */
    answered: Map<number, cards.AskAnswered>
    /** 当前展示的 question idx。undefined 表示全部答完 (terminal)
     * —— 这时若 requestId 已就位则 finalize；否则等 renderPermission
     * 一来立即 finalize。 */
    currentIdx?: number
  }>()
  /** Host-side askusr cards triggered by assistant marker protocol.
   * Kept separate from SDK AskUserQuestion because there is no
   * can_use_tool/requestId handshake here — the host injects the
   * synthetic tool call/tool result into thread history after the user
   * answers, then starts a fresh continuation turn. */
  pendingHostAsks = new Map<string, {
    questions: cards.AskQuestion[]
    answered: Map<number, cards.AskAnswered>
    currentIdx?: number
    toolCallId: string
    inputJson: string
    cardId?: string
    messageId?: string
    creatingCard?: boolean
    resumeStarted?: boolean
  }>()
  /** Thread-scoped goal reported by Codex app-server. Pure progress
   * accounting updates refresh this snapshot without adding card elements;
   * only objective/status/budget changes are rendered. */
  currentGoal: cards.ThreadGoal | null = null
  status: Status = 'stopped'

  // ── strictly private state ──
  /** Count of user messages we've sent to Codex since the last
   * turn opened on our side. NOT a FIFO of individual messages — the SDK
   * USUALLY batch-merges every mid-turn user message into a single
   * combined turn once the in-flight turn finishes, so most of the time
   * the daemon observes **one** init event per batch. Tracking a count +
   * last-sender (rather than an Array<msg>) keeps the daemon's view
   * loosely in sync with the SDK's dequeue semantics. Caveat verified
   * 2026-05-17 (test1 accumulator, 8-message rapid-fire): when the first
   * write lands in an idle SDK, that single msg gets its own turn and
   * the rest merge into a second turn — i.e. 1+(N-1) split, not always
   * one merge. To stay coherent with this, `drainMidTurnAndOpen` bumps
   * the count by `batch.length` up front (covering both the first solo
   * turn and the eventual merged tail), and the init handler resets to
   * 0 on the first claim. If the SDK takes the merge path, the bail at
   * `currentTurn=yes` in the init handler leaves pendingCount stale (>0)
   * until the GC at the next `onUserMessage`; if it takes the split
   * path, the second init sees pendingCount>0 and correctly classifies
   * the trailing batch as user-batch. */
  private pendingUserMessageCount = 0
  /** Mid-turn user messages buffered DAEMON-SIDE (not yet sendUserText'd
   * to the SDK). Drained in the `result` handler by writing each to SDK
   * stdin, which doubles as the wake signal the Codex app-server needs
   * to start the next batch turn (it won't auto-dequeue queued
   * type-ahead msgs after `result` — confirmed in dogfood testing).
   * Buffering also keeps mid-turn msgs out
   * of any AskUserQuestion `QUEUE remove` storm, since they were never
   * in the SDK queue to begin with. */
  private pendingMidTurnMsgs: Array<{ text: string; wireText: string; userOpenId: string; msgId: string }> = []
  /** 下一个 turn 的 user inputs 暂存区。所有 sendUserText 的 wireText 在
   * sendUserText 之前 push 这里;openTurnCard 创建 turn 时一次性取走 + clear。
   * mainConversationCard 把这些 wireText 渲染成顶部"📥 收到 (N)"折叠面板,
   * 让用户在卡片自己里就能看到这一轮触发了什么(不必滚群里找原消息)。
   * mid-turn buffer 的消息不在这里 push —— 它们走 drainMidTurnAndOpen 那条
   * 路径,drain 时统一 push。 */
  private pendingTurnInputs: string[] = []
  /** Most recent userOpenId seen via `onUserMessage`. Used only when a
   * merged batch fires its init event and the daemon needs *some* open_id
   * to scope the eventual `urgent_app` push — there's no obviously right
   * answer when N messages from possibly different users collapse into
   * one turn, and "the most recent sender" is a defensible default for
   * the single-user private-bot scenario this product targets. */
  private lastUserOpenId = ''
  /** Feishu message_ids of user messages that arrived while the daemon
   * was busy (turn in flight or mid-open), mapped to the `reaction_id`
   * of the `OneSecond` reaction placed at arrival. The reaction_id is
   * what `deleteReaction` needs to *remove* the OneSecond once the
   * message has been absorbed by the SDK (either system-reminder
   * injection mid-turn or a merged-batch dequeue on next turn).
   * User feedback (2026-05-15): replacing OneSecond with a second
   * CheckMark stacked two emojis on the same row; cleaner UX is
   * "queued → released" via removal, not "queued → done" via
   * stacking. */
  private pendingReactionIds = new Map<string, string>()
  /** Snapshot of `pendingReactionIds` taken when the init handler
   * claims a merged batch — these are the Feishu messages whose
   * OneSecond reactions are the currently-open turn's responsibility
   * to clear (via deleteReaction). Empty for eager-opened solo turns. */
  private currentBatchReactionIds = new Map<string, string>()
  /** Count of `system/init` events seen this subprocess. The first one is
   * the boot init (claimed by whichever user message lands first); later
   * ones can mark the start of SDK-driven queued user message draining.
   * Reset on stop/restart/exit
   * since `init` re-fires after every spawn. */
  private initCount = 0
  /** Sync guard set before any `await` in the eager-open path of
   * `onUserMessage`, cleared after `currentTurn` is set. Closes the race
   * where an SDK-emitted `init` event lands during the eager open's
   * Feishu API await — without this, the init handler would observe
   * `currentTurn === null && queue empty` (we've already shifted) and
   * incorrectly open a second card for the same user message. The flag
   * tells the init handler "an eager open is already
   * claiming the slot, stand down". */
  private openingTurn = false
  private turnCounter = 0
  /** One-shot: user invoked `stop` during the current turn. Set right
   * before `sendInterrupt`; consumed by the next `result` handler so it
   * does not overwrite the 🛑 footer already painted by the stop path.
   * Reset by exit handler for the proc-died-before-result case. */
  private userInterrupted = false
  // Last known resumable thread id. Persisted once a turn starts, so
  // `restart` can resume an in-flight conversation even if the daemon
  // exits before the turn finishes.
  private lastSessionId: string | null = null
  private selectedModel: string | null = null
  private selectedEffort: CodexReasoningEffort | null = null
  private modelPanels = new Map<string, ModelPanelState>()
  private startedAt: number = 0
  private cumStats: CumStats = { tokens: 0, costUsd: 0, turns: 0 }
  private lastTurnDelta: LastTurnDelta | null = null
  private currentTurnUsageBaseline: CodexUsage | null = null
  private currentTurnUsageBaselineKnown = false
  private lastTurnUsage: CodexUsage | null = null
  /** Resume path can restore a historical thread without replaying its
   * absolute token totals into the new subprocess. Until we observe one
   * fresh absolute total snapshot, the next turn's baseline is unknown
   * and must not be guessed as zero. */
  private usageTotalsSeedUnknown = false

  constructor(
    public readonly sessionName: string,
    public readonly chatId: string,
    private opts: SessionOpts = {},
  ) {
    Session.all.add(this)
    // Restore last-known Codex thread_id from disk so a daemon restart
    // (systemctl, crash, watchdog) doesn't strand the user with a fresh
    // conversation when they next type `restart`.
    this.lastSessionId = feishu.getSessionResume(sessionName)
    if (this.lastSessionId) {
      log(`session "${sessionName}": restored lastSessionId=${this.lastSessionId.slice(0, 8)}…`)
    }
    const selection = feishu.getSessionModelSelection(sessionName)
    this.selectedModel = selection?.model ?? null
    this.selectedEffort = selection?.effort ?? null
    if (this.selectedModel) {
      log(`session "${sessionName}": restored selected model=${this.selectedModel} effort=${this.selectedEffort ?? 'unset'}`)
    }
  }

  /** Minimal cross-chat snapshot for the `hi` peer-list section.
   * `startedAt` stays private so this is the documented read path. */
  peerSnapshot(): { name: string; status: Status; uptimeMs?: number } {
    return {
      name: this.sessionName,
      status: this.status,
      uptimeMs: this.startedAt ? (Date.now() - this.startedAt) : undefined,
    }
  }

  get workDir(): string { return join(feishu.PROJECTS_ROOT, this.sessionName) }
  isRunning(): boolean { return !!this.proc && this.proc.isAlive() }

  private modelForSpawn(): string | undefined {
    return this.selectedModel ?? undefined
  }

  private effortForSpawn(): CodexReasoningEffort {
    return this.selectedEffort ?? CODEX_EFFORT
  }

  private currentModelLabel(): string | null {
    return this.selectedModel ?? this.proc?.lastModel ?? null
  }

  private currentEffortLabel(): CodexReasoningEffort {
    return this.selectedEffort ?? this.proc?.lastEffort ?? CODEX_EFFORT
  }

  private modelEffortLabel(): string {
    const model = this.currentModelLabel()
    const effort = this.currentEffortLabel()
    return model ? `${model}/${effort}` : effort
  }

  private withModel(text: string): string {
    const label = this.modelEffortLabel()
    return text.includes(label) ? text : `${text} · ${label}`
  }

  private modelLine(): string {
    return this.modelEffortLabel()
  }

  private startFooterTimer(
    cardId: string,
    initialStatus: string,
    renderContent: (status: string) => string = status => status,
  ): FooterTimer {
    const startedAt = Date.now()
    let status = initialStatus
    let stopped = false
    const render = (): void => {
      if (stopped) return
      void cardkit.streamText(
        cardId,
        cards.ELEMENTS.footer,
        renderContent(timedStatus(status, startedAt)),
      )
    }
    const handle = setInterval(render, FOOTER_STATUS_TICK_MS)
    render()
    return {
      setStatus(next: string): void {
        status = next
        render()
      },
      stop(): void {
        if (stopped) return
        stopped = true
        clearInterval(handle)
      },
      elapsedSec(): string {
        return ((Date.now() - startedAt) / 1000).toFixed(1)
      },
    }
  }

  private async openStatusCard(
    title: string,
    initialStatus: string,
    template: 'blue' | 'green' | 'orange' | 'red' | 'grey' | 'turquoise' = 'blue',
  ): Promise<StatusCardHandle | null> {
    const startedAt = Date.now()
    const card = cards.statusCard({
      sessionName: this.sessionName,
      title,
      status: timedStatus(initialStatus, startedAt),
      template,
    })
    const messageId = await feishu.sendCard(this.chatId, card)
    if (!messageId) {
      log(`session "${this.sessionName}": status card send failed title=${title}`)
      await feishu.sendTextRaw(this.chatId, `❌ 创建状态卡片失败: ${title}`)
      return null
    }
    let cardId: string
    try { cardId = await cardkit.convertMessageToCard(messageId) }
    catch (e) {
      log(`session "${this.sessionName}": status card id_convert failed title=${title}: ${e}`)
      await feishu.sendTextRaw(this.chatId, `❌ 状态卡片初始化失败: ${title}`)
      return null
    }
    cardkit.recordCardCreated(cardId, 1)
    return {
      cardId,
      title,
      timer: this.startFooterTimer(
        cardId,
        initialStatus,
        status => cards.statusCardContent(title, status),
      ),
    }
  }

  private setStatusCard(handle: StatusCardHandle | null, status: string): void {
    handle?.timer.setStatus(status)
  }

  private async closeStatusCard(handle: StatusCardHandle | null, finalStatus: string): Promise<void> {
    if (!handle) return
    handle.timer.stop()
    const elapsed = handle.timer.elapsedSec()
    const content = cards.statusCardContent(handle.title, `${finalStatus} (${elapsed}s)`)
    await cardkit.flush(handle.cardId)
    await cardkit.streamText(handle.cardId, cards.ELEMENTS.footer, content)
    cardkit.cancelSummary(handle.cardId)
    await cardkit.patchSettings(handle.cardId, cards.streamingOffSettings({
      durationSec: elapsed,
      suffix: finalStatus,
    }))
    await cardkit.dispose(handle.cardId)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────
  async start(opts: LifecycleProgressOpts = {}): Promise<boolean> {
    const announce = opts.announce ?? true
    const report = opts.onStatus
    if (this.isRunning()) {
      report?.(this.withModel('✅ Codex 已运行'))
      return true
    }
    report?.('🔎 检查 Codex 登录')
    if (!feishu.isOpenAIChatGPTAuthenticated()) {
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      report?.('❌ Codex 未登录 ChatGPT 账号')
      if (announce) {
        await feishu.sendText(this.chatId, '❌ Codex 未登录 ChatGPT 账号。\n请在服务器上运行 `codex login` 后再试。')
      }
      return false
    }
    if (!existsSync(this.workDir)) {
      report?.(`🆕 创建项目目录 ~/${this.sessionName}`)
      if (announce) await feishu.sendText(this.chatId, `🆕 目录 ~/${this.sessionName} 不存在，正在创建…`)
      try { feishu.provisionProject(this.workDir) }
      catch (e) {
        this.status = 'stopped'
        this.opts.onLifecycleChange?.()
        report?.(`❌ 创建项目失败: ${e}`)
        if (announce) await feishu.sendText(this.chatId, `❌ 创建项目失败: ${e}`)
        return false
      }
    }

    this.status = 'starting'
    this.currentGoal = null
    this.currentTurnUsageBaseline = null
    this.currentTurnUsageBaselineKnown = false
    this.usageTotalsSeedUnknown = false
    report?.(this.withModel('🚀 启动 Codex'))
    this.proc = new CodexProcess({
      workDir: this.workDir,
      model: this.modelForSpawn(),
      effort: this.effortForSpawn(),
      appendSystemPrompt: this.spawnDeveloperInstructions(),
    })
    this.wireProc(this.proc)
    this.proc.sendInitialize()
    report?.('⏳ 等待 Codex init')
    // 等 `system/init` 落地再认定 ready —— sendInitialize 只把 RPC
    // 写进 app-server 之前 proc.sessionId 还是 null,这时候
    // showConsole() 看到 null 会 fallback 到磁盘上**上一次**会话的
    // lastSessionId,面板就把陈年 thread_id 当成"当前会话"贴出去,
    // model / usage / contextWindow 也都没值。等 init 之后再返回,
    // 后续 `hi`、首条 user message 都能拿到真值。5s 兜底,init 真
    // 没来也不死循环。
    const init = await this.waitForProcInit(this.proc, 5000)
    if (init.state === 'error' || init.state === 'exit') {
      log(`session "${this.sessionName}": codex init failed: ${init.error ?? init.state}`)
      report?.(`❌ Codex 启动失败: ${init.error ?? init.state}`)
      if (announce) await feishu.sendText(this.chatId, `❌ Codex 启动失败: ${init.error ?? init.state}`)
      await this.proc?.kill(1000).catch(() => {})
      this.proc = null
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      return false
    }
    if (init.state === 'timeout') {
      log(`session "${this.sessionName}": init wait timeout (5s) — proceeding`)
      report?.(this.withModel('⏳ Codex 已启动，init 确认超时'))
    }

    if (announce) {
      const modelLine = this.modelLine()
      await feishu.sendText(this.chatId, [
        `✅ Lodestar session "${this.sessionName}" 已就绪，发消息开始对话。`,
        modelLine,
      ].filter(Boolean).join('\n'))
    }
    this.status = 'idle'
    this.startedAt = Date.now()
    this.opts.onLifecycleChange?.()
    report?.(this.withModel('✅ Codex 已就绪'))
    return true
  }

  private async waitForProcInit(
    proc: CodexProcess,
    timeoutMs: number,
  ): Promise<{ state: 'init' | 'error' | 'exit' | 'timeout'; error?: unknown }> {
    return await new Promise(resolve => {
      let settled = false
      const finish = (state: 'init' | 'error' | 'exit' | 'timeout', error?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        proc.off('init', onInit)
        proc.off('error', onError)
        proc.off('exit', onExit)
        resolve({ state, error })
      }
      const timer = setTimeout(() => finish('timeout'), timeoutMs)
      const onInit = () => finish('init')
      const onError = (e: unknown) => finish('error', e)
      const onExit = (e: unknown) => finish('exit', e)
      proc.once('init', onInit)
      proc.once('error', onError)
      proc.once('exit', onExit)
    })
  }

  private async waitForProcResumeInit(
    proc: CodexProcess,
    onStillWaiting: () => void,
  ): Promise<{ state: 'init' | 'error' | 'exit' | 'timeout'; error?: unknown }> {
    return await new Promise(resolve => {
      let settled = false
      const finish = (state: 'init' | 'error' | 'exit' | 'timeout', error?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(noticeTimer)
        clearTimeout(timeoutTimer)
        proc.off('init', onInit)
        proc.off('error', onError)
        proc.off('exit', onExit)
        resolve({ state, error })
      }
      const noticeTimer = setTimeout(() => {
        if (!settled) onStillWaiting()
      }, RESUME_INIT_NOTICE_MS)
      const timeoutTimer = setTimeout(() => {
        finish('timeout', new Error(`resume init timed out after ${RESUME_INIT_TIMEOUT_MS / 1000}s`))
      }, RESUME_INIT_TIMEOUT_MS)
      const onInit = () => finish('init')
      const onError = (e: unknown) => finish('error', e)
      const onExit = (e: unknown) => finish('exit', e)
      proc.once('init', onInit)
      proc.once('error', onError)
      proc.once('exit', onExit)
    })
  }

  /** Drop every ⏳ OneSecond reaction this session is currently holding
   * on user chat messages, then empty the two tracking maps. Used by
   * every tear-down path (proc exit, kill, restart) so reactions don't
   * outlive the conversation that placed them — without this, a Codex
   * crash / daemon SIGTERM leaves orphan ⏳ stuck on user messages until
   * Feishu's UI eventually GCs them (which it doesn't, in practice).
   * closeTurnCard has its own release pass (with the slightly-early
   * merged-batch trade-off documented there); this is the catastrophic-
   * exit pass. Direct `deleteReaction` calls are fire-and-forget and
   * swallow their own failures (see feishu.deleteReaction). */
  private releaseAllReactions(): void {
    for (const [msgId, rid] of [
      ...this.pendingReactionIds.entries(),
      ...this.currentBatchReactionIds.entries(),
    ]) {
      if (rid) void feishu.deleteReaction(msgId, rid)
    }
    this.pendingReactionIds = new Map()
    this.currentBatchReactionIds = new Map()
  }

  async stop(reason = '已终止', opts: LifecycleProgressOpts = {}): Promise<void> {
    const announce = opts.announce ?? true
    const report = opts.onStatus
    if (!this.proc) {
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      report?.('⚪ session 当前未运行')
      if (announce) await feishu.sendText(this.chatId, `⚪ session "${this.sessionName}" 当前未运行`)
      return
    }
    report?.('🛑 停止 Codex')
    // Flip lifecycle state SYNCHRONOUSLY before awaiting kill — daemon's
    // SIGTERM cleanup snapshots `isRunning()` and if we're still mid-
    // `proc.kill()` await it'll see proc!=null and write us into the
    // alive marker, which makes the next boot auto-revive a session
    // the user explicitly killed. Reordering the null-out fixes that
    // race (bug observed 2026-05-15: `kill` immediately followed by
    // `systemctl restart` revived the killed session on boot).
    log(`session "${this.sessionName}": stop (${reason})`)
    const proc = this.proc
    this.proc = null
    this.stopThinkingFooter(this.currentTurn)
    this.currentTurn = null
    this.pendingUserMessageCount = 0
    this.pendingMidTurnMsgs = []
    this.pendingTurnInputs = []
    this.lastUserOpenId = ''
    this.releaseAllReactions()
    this.initCount = 0
    this.openingTurn = false
    this.pendingAsks.clear()
    this.pendingHostAsks.clear()
    this.pendingPermissions.clear()
    this.currentTurnUsageBaseline = null
    this.currentTurnUsageBaselineKnown = false
    this.usageTotalsSeedUnknown = false
    this.status = 'stopped'
    this.opts.onLifecycleChange?.()
    await proc.kill()
    report?.(`✅ ${reason}`)
    if (announce) await feishu.sendText(this.chatId, `🔴 ${reason} (session: ${this.sessionName})`)
  }

  async restart(resume = false, opts: LifecycleProgressOpts = {}): Promise<boolean> {
    const announce = opts.announce ?? true
    let report = opts.onStatus
    const prevSessionId = this.lastSessionId
    const prevThreadLabel = prevSessionId ? prevSessionId.slice(0, 8) : ''
    let statusCard: StatusCardHandle | null = null
    if (!report && announce && resume && prevSessionId) {
      const initialStatus = this.proc
        ? this.withModel('🔁 重启 Codex')
        : this.withModel(`🔁 恢复上一会话 thread=${prevThreadLabel}…`)
      statusCard = await this.openStatusCard('restart', initialStatus)
      if (statusCard) report = status => this.setStatusCard(statusCard, status)
    }
    const announceText = announce && !statusCard
    const closeInternalStatusCard = async (finalStatus: string): Promise<void> => {
      if (statusCard) await this.closeStatusCard(statusCard, finalStatus)
    }
    if (this.proc) {
      report?.('🛑 停止当前 Codex')
      await this.proc.kill()
      this.proc = null
    }
    this.stopThinkingFooter(this.currentTurn)
    this.currentTurn = null
    this.pendingUserMessageCount = 0
    this.pendingMidTurnMsgs = []
    this.pendingTurnInputs = []
    this.lastUserOpenId = ''
    this.releaseAllReactions()
    this.initCount = 0
    this.openingTurn = false
    this.pendingAsks.clear()
    this.pendingHostAsks.clear()
    this.pendingPermissions.clear()
    this.currentTurnUsageBaseline = null
    this.currentTurnUsageBaselineKnown = false
    if (resume && prevSessionId) {
      this.status = 'starting'
      this.usageTotalsSeedUnknown = true
      report?.(this.withModel(`🔁 恢复上一会话 thread=${prevThreadLabel}…`))
      this.proc = new CodexProcess({
        workDir: this.workDir,
        model: this.modelForSpawn(),
        effort: this.effortForSpawn(),
        resumeSessionId: prevSessionId,
        appendSystemPrompt: this.spawnDeveloperInstructions(),
      })
      this.wireProc(this.proc)
      this.proc.sendInitialize()
      report?.('⏳ 等待 Codex init 确认')
      const init = await this.waitForProcResumeInit(this.proc, () => {
        log(`session "${this.sessionName}": resume init still pending after ${RESUME_INIT_NOTICE_MS / 1000}s`)
        report?.(this.withModel(`⏳ 仍在等待 Codex init 确认 thread=${prevThreadLabel}…`))
      })
      if (init.state === 'error' || init.state === 'exit' || init.state === 'timeout') {
        log(`session "${this.sessionName}": codex resume failed: ${init.error ?? init.state}`)
        const finalStatus = init.state === 'timeout'
          ? '❌ Codex 恢复超时'
          : `❌ Codex 恢复失败: ${init.error ?? init.state}`
        report?.(finalStatus)
        if (announceText) await feishu.sendText(this.chatId, finalStatus)
        await this.proc?.kill(1000).catch(() => {})
        this.proc = null
        this.status = 'stopped'
        this.opts.onLifecycleChange?.()
        await closeInternalStatusCard(finalStatus)
        return false
      }
      const msg = this.withModel(`✅ 已恢复上一会话 thread=${prevThreadLabel}…`)
      report?.(msg)
      if (announceText) await feishu.sendText(this.chatId, msg)
      this.status = 'idle'
      this.startedAt = Date.now()
      this.opts.onLifecycleChange?.()
      await closeInternalStatusCard(msg)
      return true
    } else {
      // Resume requested but no prior session_id on file — surface it
      // explicitly rather than silently fresh-starting (the old behavior
      // hid the daemon-restart sessionId-loss bug for months).
      if (resume) {
        report?.('⚠️ 没有可恢复的上一会话，将以新会话启动')
        if (announceText) await feishu.sendText(this.chatId, '⚠️ 没有可恢复的上一会话，将以新会话启动')
      }
      // Fresh conversation — drop cumulative stats so the next `hi` shows
      // zeroed counters instead of bleeding numbers from the prior chat.
      this.cumStats = { tokens: 0, costUsd: 0, turns: 0 }
      this.lastTurnDelta = null
      this.lastTurnUsage = null
      this.usageTotalsSeedUnknown = false
      return await this.start(opts)
    }
  }

  private worktreeProjectName(): string {
    return worktree.projectNameFromSessionName(this.sessionName)
  }

  private worktreeProjectDir(): string {
    return join(feishu.PROJECTS_ROOT, this.worktreeProjectName())
  }

  private spawnDeveloperInstructions(): string {
    const extra = this.worktreeExtraInstruction()
    return extra ? `${CHANNEL_INSTRUCTIONS}\n${extra}` : CHANNEL_INSTRUCTIONS
  }

  private worktreeExtraInstruction(): string | null {
    const instructionsPath = worktree.worktreeInstructionsPathForManagedBranch(
      this.workDir,
      this.worktreeProjectDir(),
      this.worktreeProjectName(),
    )
    if (!instructionsPath) return null
    return `本项目在当前工作目录有额外的约定${instructionsPath}，你必须严格遵守`
  }

  private async runWorktreeCommand(arg: string, userOpenId: string): Promise<void> {
    if (!arg) {
      await this.showWorktrees()
      return
    }
    const slug = worktree.normalizeWorktreeSlug(arg)
    if (!slug) {
      await feishu.sendText(this.chatId, '❌ 名称无效。用英文/数字/._-，最长 63。')
      return
    }
    if (!userOpenId) {
      await feishu.sendText(this.chatId, '❌ 找不到发起人，不能拉群。')
      return
    }

    const projectName = this.worktreeProjectName()
    const projectDir = this.worktreeProjectDir()
    let ensured: worktree.EnsureWorktreeResult
    try {
      ensured = worktree.ensureProjectWorktree(projectDir, projectName, slug)
    } catch (e) {
      await feishu.sendText(this.chatId, `❌ wt 失败: ${messageOf(e)}`)
      return
    }

    try {
      const chat = await feishu.ensureChatForSession(ensured.chatName, userOpenId)
      const action = chat.created ? '已创建' : (chat.joined ? '已加入' : '已在群内')
      const parentMsg = await feishu.sendCard(this.chatId, cards.worktreeNoticeCard({
        slug,
        branch: ensured.branch,
        status: action,
      }))
      if (!parentMsg) await feishu.sendTextRaw(this.chatId, `❌ wt 卡片失败: ${slug}`)
      const childMsg = await feishu.sendCard(chat.chatId, cards.worktreeNoticeCard({
        slug,
        branch: ensured.branch,
        status: '就绪',
        body: '开始吧。',
      }))
      if (!childMsg) await feishu.sendTextRaw(chat.chatId, `❌ wt 卡片失败: ${slug}`)
    } catch (e) {
      await feishu.sendText(this.chatId, `❌ wt 已建，拉群失败: ${messageOf(e)}`)
    }
  }

  private async buildWorktreeListCard(notice?: { type: 'success' | 'error' | 'info'; content: string }): Promise<object> {
    const projectName = this.worktreeProjectName()
    const projectDir = this.worktreeProjectDir()
    const entries = worktree.listProjectWorktrees(projectDir, projectName)
    const hiddenMergedUnmountedCount = entries.filter(
      entry => entry.state === 'merged' && !entry.mounted,
    ).length
    const visibleEntries = entries.filter(entry => entry.state !== 'merged' || entry.mounted)
    const chatIndex = await feishu.listNormalChatIdsByName()
    return cards.worktreeListCard({
      projectName,
      projectDir,
      hiddenMergedUnmountedCount,
      notice,
      entries: visibleEntries.map(entry => {
        const ids = chatIndex.get(entry.chatName) ?? []
        const preferred = feishu.preferredChatForSession.get(entry.chatName)
        const chatId = preferred && ids.includes(preferred)
          ? preferred
          : ids.length === 1
            ? ids[0]
            : null
        return {
          slug: entry.slug,
          chatName: entry.chatName,
          branch: entry.branch,
          state: entry.state,
          path: entry.worktreePath ?? entry.expectedPath,
          mounted: entry.mounted,
          dirtyCount: entry.dirtyCount,
          statusLine: entry.statusLine,
          error: entry.error,
          chatId,
          duplicateChatCount: ids.length,
        }
      }),
    })
  }

  async showWorktrees(): Promise<void> {
    try {
      const card = await this.buildWorktreeListCard()
      const messageId = await feishu.sendCard(this.chatId, card)
      if (!messageId) await feishu.sendTextRaw(this.chatId, '❌ wt 列表失败')
    } catch (e) {
      await feishu.sendText(this.chatId, `❌ wt 列表失败: ${messageOf(e)}`)
    }
  }

  private modelListCwd(): string {
    if (existsSync(this.workDir)) return this.workDir
    if (existsSync(feishu.PROJECTS_ROOT)) return feishu.PROJECTS_ROOT
    return process.cwd()
  }

  private async listAvailableModels(): Promise<CodexModel[]> {
    if (this.proc?.isAlive()) {
      return await withTimeout(this.proc.listModels(), 20_000, 'model/list')
    }
    if (!feishu.isOpenAIChatGPTAuthenticated()) {
      throw new Error('Codex 未登录 ChatGPT 账号。请在服务器上运行 `codex login` 后再试。')
    }
    const proc = new CodexProcess({
      workDir: this.modelListCwd(),
      effort: this.effortForSpawn(),
      appendSystemPrompt: CHANNEL_INSTRUCTIONS,
    })
    try {
      return await withTimeout(proc.listModels(), 20_000, 'model/list')
    } finally {
      await proc.kill(1000).catch(e => log(`session "${this.sessionName}": temp model-list proc kill failed: ${e}`))
    }
  }

  async showModelPanel(): Promise<void> {
    let models: CodexModel[]
    try {
      models = await this.listAvailableModels()
    } catch (e) {
      const message = `❌ 模型列表失败: ${messageOf(e)}`
      log(`session "${this.sessionName}": model list failed: ${messageOf(e)}`)
      await feishu.sendText(this.chatId, message)
      return
    }

    const panelId = randomUUID()
    const currentModel = this.currentModelLabel()
    const currentEffort = this.currentEffortLabel()
    const choices = this.modelChoices(models)
    this.modelPanels.set(panelId, { models: choices })
    const messageId = await feishu.sendCard(this.chatId, cards.modelSelectionCard({
      sessionName: this.sessionName,
      panelId,
      currentModel,
      currentEffort,
      models: choices,
    }))
    if (!messageId) {
      this.modelPanels.delete(panelId)
      await feishu.sendTextRaw(this.chatId, '❌ 模型面板发送失败')
      return
    }
  }

  private modelChoices(models: CodexModel[]): cards.ModelChoice[] {
    const seen = new Set<string>()
    const currentModel = this.currentModelLabel()
    const currentEffort = this.currentEffortLabel()
    const choices: cards.ModelChoice[] = []
    for (const m of models) {
      if (seen.has(m.model)) continue
      seen.add(m.model)
      choices.push({
        model: m.model,
        displayName: m.displayName,
        description: m.description,
        isDefault: m.isDefault,
        selected: currentModel === m.model,
        efforts: m.supportedReasoningEfforts.map(effort => ({
          effort: effort.reasoningEffort,
          description: effort.description,
          isDefault: m.defaultReasoningEffort === effort.reasoningEffort,
          selected: currentModel === m.model && currentEffort === effort.reasoningEffort,
        })),
      })
    }
    return choices
  }

  private initialEffortForModel(model: cards.ModelChoice): string | null {
    const currentEffort = this.currentEffortLabel()
    if (model.selected && model.efforts.some(effort => effort.effort === currentEffort)) return currentEffort
    return model.efforts.find(effort => effort.isDefault)?.effort ?? model.efforts[0]?.effort ?? null
  }

  private modelChoiceFromAction(model: string, raw: any): cards.ModelChoice | null {
    const effortsRaw = Array.isArray(raw?.efforts) ? raw.efforts : []
    const efforts: cards.ModelEffortChoice[] = effortsRaw
      .map((item: any) => ({
        effort: typeof item?.effort === 'string' ? item.effort : '',
        description: typeof item?.description === 'string' ? item.description : '',
        isDefault: item?.is_default === true,
      }))
      .filter((item: cards.ModelEffortChoice) => item.effort)
    if (efforts.length === 0) return null
    return {
      model,
      displayName: typeof raw?.display_name === 'string' && raw.display_name ? raw.display_name : model,
      description: '',
      isDefault: raw?.is_default === true,
      selected: this.currentModelLabel() === model,
      efforts,
    }
  }

  private modelSelectionScope(): string {
    return this.currentTurn
      ? '当前 turn 不变,下一轮开始使用。'
      : this.proc?.isAlive()
        ? '下一轮开始使用。'
        : '下次启动 Codex 时使用。'
  }

  async onModelSelect(modelRaw: string, panelIdRaw = '', _userOpenId = '', actionValue: any = null): Promise<ModelActionResult> {
    const model = modelRaw.trim()
    if (!model) {
      const message = '模型为空'
      await feishu.sendText(this.chatId, `❌ ${message}`)
      return { ok: false, message }
    }
    const panelId = panelIdRaw.trim()
    const panel = this.modelPanels.get(panelId)
    const choice = panel?.models.find(m => m.model === model) ?? this.modelChoiceFromAction(model, actionValue)
    if (!choice) {
      return { ok: false, message: '模型不在当前面板列表中,请重新发送 model' }
    }
    const selectedEffort = this.initialEffortForModel(choice)
    return {
      ok: choice.efforts.length > 0,
      message: choice.efforts.length > 0 ? `已选择模型 ${model},请选择 effort` : '这个模型未返回可用 effort',
      card: cards.modelEffortCard({
        sessionName: this.sessionName,
        panelId,
        currentModel: this.currentModelLabel(),
        currentEffort: this.currentEffortLabel(),
        selectedModel: choice,
        selectedEffort,
      }),
    }
  }

  async onModelEffortSelect(modelRaw: string, effortRaw: string, panelIdRaw = '', _userOpenId = ''): Promise<ModelActionResult> {
    const model = modelRaw.trim()
    const effortValue = effortRaw.trim()
    if (!model) return { ok: false, message: '模型为空' }
    if (!isCodexReasoningEffort(effortValue)) return { ok: false, message: 'reasoning effort 无效' }
    const effort: CodexReasoningEffort = effortValue
    const panelId = panelIdRaw.trim()
    const panel = this.modelPanels.get(panelId)
    const choice = panel?.models.find(m => m.model === model)
    if (choice && !choice.efforts.some(item => item.effort === effort)) {
      return { ok: false, message: 'reasoning effort 不属于该模型' }
    }
    try {
      if (this.proc?.isAlive()) {
        await withTimeout(this.proc.setModelSettings(model, effort), 20_000, 'thread/settings/update')
      }
      this.selectedModel = model
      this.selectedEffort = effort
      feishu.bindSessionModel(this.sessionName, model, effort)
      const scope = this.modelSelectionScope()
      this.modelPanels.delete(panelId)
      return {
        ok: true,
        message: `已选择 ${model} / ${effort}`,
        card: cards.modelResultCard({
          sessionName: this.sessionName,
          model,
          effort,
          scope,
        }),
      }
    } catch (e) {
      const message = `模型切换失败: ${messageOf(e)}`
      log(`session "${this.sessionName}": set model settings failed: ${messageOf(e)}`)
      await feishu.sendText(this.chatId, `❌ ${message}`)
      return { ok: false, message }
    }
  }

  private async worktreeActionResult(
    ok: boolean,
    message: string,
    type: 'success' | 'error' | 'info',
  ): Promise<WorktreeActionResult> {
    try {
      return { ok, message, card: await this.buildWorktreeListCard({ type, content: message }) }
    } catch (e) {
      const listError = `列表刷新失败: ${messageOf(e)}`
      log(`session "${this.sessionName}": wt action panel refresh failed: ${messageOf(e)}`)
      return {
        ok: false,
        message: `${message}\n${listError}`,
        card: cards.worktreeNoticeCard({
          slug: 'wt',
          branch: 'work/*',
          status: message,
          body: listError,
          template: 'red',
        }),
      }
    }
  }

  async onWorktreeDisband(slugRaw: string): Promise<WorktreeActionResult> {
    const slug = worktree.normalizeWorktreeSlug(slugRaw)
    if (!slug) return this.worktreeActionResult(false, '❌ 名称无效', 'error')
    const projectName = this.worktreeProjectName()
    const projectDir = this.worktreeProjectDir()
    try {
      const chatName = worktree.worktreeChatName(projectName, slug)
      const runningSession = [...Session.all].find(s => s.sessionName === chatName && s.isRunning())
      if (runningSession) {
        const message = `❌ 解散 ${slug} 失败: Codex 正在运行，请先在 ${chatName} 群里 stop 或 kill。`
        return this.worktreeActionResult(false, message, 'error')
      }
      worktree.assertProjectWorktreeClean(projectDir, projectName, slug)
      const disbanded = await feishu.disbandChatForSession(chatName)
      const removed = worktree.removeProjectWorktreeIfClean(projectDir, projectName, slug)
      const message = [
        `✅ ${slug} 已解散`,
        removed.removedWorktree ? 'dir removed' : 'dir missing',
        disbanded.disbanded ? 'group removed' : 'group missing',
        removed.branch,
      ].join('\n')
      return this.worktreeActionResult(true, message, 'success')
    } catch (e) {
      const message = `❌ 解散 ${slug} 失败: ${messageOf(e)}`
      return this.worktreeActionResult(false, message, 'error')
    }
  }

  /** Run a bare-text control command (`hi`, `stop`, `kill`, `restart`, `clear`, `model`).
   * Returns true if the command was consumed (don't forward to Codex).
   * Exact match, case-insensitive, ignores trailing whitespace.
   *
   * Trade-off (user-confirmed 2026-05-15): these words are reserved
   * globally — typing "hi" as a literal greeting will show the console
   * card instead of reaching Codex. The ergonomic win (no slash, no
   * shift key, one-handed phone use) outweighs the collision in this
   * product's private-bot use case. `stop` was added 2026-05-15 once
   * auto-interrupt on mid-turn user messages was removed (matching
   * Codex's native type-ahead behavior) — explicit barge-out
   * needed a knob and `kill` (full subprocess teardown) is too heavy. */
  async runCommand(raw: string, userOpenId = ''): Promise<boolean> {
    const wt = raw.trim().match(/^wt(?:\s+(.+))?$/i)
    if (wt) {
      await this.runWorktreeCommand((wt[1] ?? '').trim(), userOpenId)
      return true
    }
    switch (raw.trim().toLowerCase()) {
      case 'model':
        await this.showModelPanel()
        return true
      case 'hi':
        {
          const needsStart = !this.isRunning()
          const statusCard = needsStart
            ? await this.openStatusCard('hi', this.withModel('🚀 启动 Codex'))
            : null
          let lastStatus = this.withModel('🚀 启动 Codex')
          const ok = needsStart
            ? await this.start({
                announce: !statusCard,
                onStatus: status => {
                  lastStatus = status
                  this.setStatusCard(statusCard, status)
                },
              })
            : true
          if (!ok) {
            await this.closeStatusCard(statusCard, lastStatus.startsWith('❌') ? lastStatus : '❌ 启动失败')
            return true
          }
          if (statusCard) {
            await this.replaceStatusCardWithConsole(statusCard, this.withModel('✅ Codex 已就绪'))
            return true
          }
          if (needsStart) await this.closeStatusCard(statusCard, this.withModel('✅ Codex 已就绪'))
        }
        await this.showConsole()
        return true
      case 'stop':
        // Soft barge-out: interrupt the current turn (if any) AND drop
        // the pending-message count so a stack of type-ahead doesn't
        // refire after the interrupt. Subprocess stays alive. Note: the
        // SDK keeps its OWN internal queue of the user-text frames we
        // already sendText'd — interrupt should also flush that side,
        // but the daemon can't reach into it directly; in practice the
        // sendInterrupt() control_request causes the SDK to discard
        // queued input alongside the in-flight call.
        if (!this.currentTurn && this.pendingUserMessageCount === 0 && this.pendingMidTurnMsgs.length === 0) {
          const statusCard = await this.openStatusCard('stop', '⚪ 当前没有正在执行的 turn', 'grey')
          if (statusCard) {
            await this.closeStatusCard(statusCard, '⚪ 无正在执行的 turn')
          } else {
            await feishu.sendText(this.chatId, '⚪ 当前没有正在执行的 turn')
          }
          return true
        }
        log(`session "${this.sessionName}": stop command — interrupt + drop count=${this.pendingUserMessageCount} midBuffer=${this.pendingMidTurnMsgs.length}`)
        // Cancelled queued msgs: remove the OneSecond (no longer waiting)
        // and stamp a CrossMark (explicit cancelled state, distinct from
        // a natural release where reactions just disappear). Cancelled
        // mid-batch msgs get the same treatment.
        // 用 `seen` Set 去重 —— mid-turn buffer 跟 pendingReactionIds 的
        // msgId 重叠(onUserMessage 进 buffer 时同时 trackReaction),
        // 两次 addReaction(CrossMark) 会在飞书侧渲染两个 ❌ (P0-1)。
        const seen = new Set<string>()
        for (const [msgId, rid] of [
          ...this.pendingReactionIds.entries(),
          ...this.currentBatchReactionIds.entries(),
        ]) {
          if (rid) void feishu.deleteReaction(msgId, rid)
          void feishu.addReaction(msgId, 'CrossMark')
          seen.add(msgId)
        }
        // Mid-turn buffer never reached SDK — cancel those too.
        for (const msg of this.pendingMidTurnMsgs) {
          if (msg.msgId && !seen.has(msg.msgId)) void feishu.addReaction(msg.msgId, 'CrossMark')
        }
        this.pendingUserMessageCount = 0
        this.pendingMidTurnMsgs = []
        this.pendingTurnInputs = []
        this.lastUserOpenId = ''
        this.pendingReactionIds = new Map()
        this.currentBatchReactionIds = new Map()
        // Tag the imminent SDK `result` so the result handler does not
        // repaint the footer after this stop path already closed the card.
        // Must be set BEFORE sendInterrupt — the result can land next tick.
        this.userInterrupted = true
        this.interrupt()
        // 主动封口,把 footer 改成 🛑 打断、停止 thinking timer、把 streaming_mode
        // 翻回 false,否则卡片会僵在运行中状态。SDK 的 post-interrupt
        // result 也会进 closeTurnCard,但 currentTurn 已被这里置空,那条
        // 路径会 early-return,不会重画 footer。
        await this.closeTurnCard('🛑 打断')
        return true
      case 'kill':
        {
          const wasRunning = this.isRunning()
          const initialStatus = wasRunning ? '🛑 停止 Codex' : '⚪ session 当前未运行'
          const statusCard = await this.openStatusCard('kill', initialStatus, wasRunning ? 'red' : 'grey')
          await this.stop('已终止', {
            announce: !statusCard,
            onStatus: status => {
              this.setStatusCard(statusCard, status)
            },
          })
          await this.closeStatusCard(statusCard, wasRunning ? '✅ Codex 已终止' : '⚪ Codex 未运行')
        }
        return true
      case 'restart':
        // resume the prior conversation — kills the current proc (if
        // any) and spawns a new one with `--resume <lastSessionId>`.
        // If no process is running, this is how the user gets back the
        // previous conversation after a `kill` or a daemon crash.
        {
          const resumeThreadLabel = this.lastSessionId ? this.lastSessionId.slice(0, 8) : ''
          const initialStatus = this.isRunning()
            ? this.withModel('🔁 重启 Codex')
            : resumeThreadLabel
              ? this.withModel(`🔁 恢复上一会话 thread=${resumeThreadLabel}…`)
              : this.withModel('🔁 启动 Codex')
          const statusCard = await this.openStatusCard('restart', initialStatus)
          let lastStatus = initialStatus
          const ok = await this.restart(true, {
            announce: !statusCard,
            onStatus: status => {
              lastStatus = status
              this.setStatusCard(statusCard, status)
            },
          })
          const finalStatus = ok
            ? (lastStatus.startsWith('✅') ? lastStatus : (resumeThreadLabel ? '✅ 已恢复上一会话' : '✅ Codex 已就绪'))
            : (lastStatus.startsWith('❌') ? lastStatus : '❌ 重启失败')
          await this.closeStatusCard(statusCard, ok ? this.withModel(finalStatus) : finalStatus)
        }
        return true
      case 'clear':
        // "throw away current conversation, start a new one". By design
        // this only makes sense when there IS a current conversation:
        // calling clear from stopped state is a no-op (user-confirmed
        // 2026-05-16) — we don't want a stray `clear` to silently spawn
        // a fresh session the user didn't ask for. To start from cold,
        // use `hi`.
        if (!this.isRunning()) {
          this.status = 'stopped'
          this.opts.onLifecycleChange?.()
          const statusCard = await this.openStatusCard('clear', '⚪ session 当前未运行', 'grey')
          if (statusCard) {
            await this.closeStatusCard(statusCard, '⚪ Codex 未运行，clear 无效')
          } else {
            await feishu.sendText(this.chatId, `⚪ session "${this.sessionName}" 当前未运行,clear 无效;用 \`hi\` 启动或 \`restart\` 恢复上一会话`)
          }
          return true
        }
        {
          const statusCard = await this.openStatusCard('clear', '🧹 清空并启动新会话', 'orange')
          let lastStatus = '🧹 清空并启动新会话'
          const ok = await this.restart(false, {
            announce: !statusCard,
            onStatus: status => {
              lastStatus = status
              this.setStatusCard(statusCard, status)
            },
          })
          await this.closeStatusCard(statusCard, ok ? this.withModel('✅ 已清空并启动新会话') : (lastStatus.startsWith('❌') ? lastStatus : '❌ 清空失败'))
        }
        return true
    }
    return false
  }

  /** Build the hi-panel data snapshot for this session.
   *
   * Passing `usage=undefined` paints the `_加载中…_` placeholder — the
   * caller is responsible for the async patch if the panel was sent. */
  async buildConsoleOpts(usage: UsageSnapshot | undefined): Promise<cards.ConsoleOpts> {
    const uptimeMs = this.startedAt ? (Date.now() - this.startedAt) : undefined
    const rawModel = this.currentModelLabel()
    const model = rawModel ?? undefined
    const sysinfo = await readSysInfo()
    return {
      sessionName: this.sessionName,
      status: this.status,
      model,
      effort: this.currentEffortLabel(),
      uptimeMs,
      peers: [...Session.all]
        .filter(s => s.isRunning())
        .map(s => ({ ...s.peerSnapshot(), isCurrent: s === this })),
      usage,
      contextTokens: this.currentContextTokens(),
      contextLimit: this.contextLimitForDisplay(),
      cumStats: this.cumStats,
      lastTurn: this.lastTurnDelta
        ? {
            tokens: this.lastTurnDelta.tokens,
            costUsd: this.lastTurnDelta.costUsd,
            durationMs: this.lastTurnDelta.durationMs,
          }
        : undefined,
      sessionId: this.proc?.sessionId ?? this.lastSessionId,
      sysinfo,
    }
  }

  async buildConsoleCard(usage: UsageSnapshot | undefined): Promise<object> {
    return cards.consoleCard(await this.buildConsoleOpts(usage))
  }

  private async patchConsoleUsage(cardId: string): Promise<void> {
    const usage = await readUsage()
    await cardkit.replaceElement(cardId, cards.ELEMENTS.consoleUsage, cards.consoleUsageElement(usage))
  }

  private patchConsoleUsageLater(cardId: string): void {
    void (async () => {
      try {
        await this.patchConsoleUsage(cardId)
      } catch (e) {
        log(`session "${this.sessionName}": consoleUsage patch failed: ${e}`)
      } finally {
        try { await cardkit.dispose(cardId) }
        catch (e) { log(`session "${this.sessionName}": console card dispose failed: ${e}`) }
      }
    })()
  }

  private async replaceStatusCardWithConsole(handle: StatusCardHandle, finalStatus: string): Promise<void> {
    handle.timer.stop()
    const elapsed = handle.timer.elapsedSec()
    const consoleOpts = await this.buildConsoleOpts(undefined)
    await cardkit.flush(handle.cardId)
    await cardkit.replaceElement(
      handle.cardId,
      cards.ELEMENTS.footer,
      cards.consoleMainElement(consoleOpts, cards.ELEMENTS.footer),
    )
    await cardkit.addElement(
      handle.cardId,
      cards.consoleUsageElement(undefined),
      { type: 'insert_after', targetElementId: cards.ELEMENTS.footer },
    )
    cardkit.cancelSummary(handle.cardId)
    await cardkit.patchSettings(handle.cardId, cards.streamingOffSettings({
      durationSec: elapsed,
      suffix: finalStatus,
    }))
    this.patchConsoleUsageLater(handle.cardId)
  }

  async showConsole(): Promise<void> {
    // Initial paint without usage → cards.ts renders the
    // `_加载中…_` placeholder in the consoleUsage element. We patch
    // it in below once readUsage() resolves; not worth blocking the
    // panel on the Codex account/rate-limit round trip.
    const card = await this.buildConsoleCard(undefined)
    const messageId = await feishu.sendCard(this.chatId, card)
    if (!messageId) return
    // Patch the usage element asynchronously so the rest of the panel
    // stays responsive. We don't await; failures are logged and the
    // placeholder stays visible (no fallback fabrication).
    void (async () => {
      let cardId = ''
      try {
        cardId = await cardkit.convertMessageToCard(messageId)
        await this.patchConsoleUsage(cardId)
      } catch (e) {
        log(`session "${this.sessionName}": consoleUsage patch failed: ${e}`)
      } finally {
        if (cardId) {
          try { await cardkit.dispose(cardId) }
          catch (e) { log(`session "${this.sessionName}": console card dispose failed: ${e}`) }
        }
      }
    })()
  }

  interrupt(): void {
    if (!this.proc) return
    log(`session "${this.sessionName}": interrupt`)
    this.proc.sendInterrupt()
  }

  private async startColdUserTurn(text: string, wireText: string, userOpenId: string): Promise<void> {
    this.openingTurn = true
    this.pendingTurnInputs.push(text)
    try {
      await this.openTurnCard(userOpenId, 'user_message', {
        initialFooter: 'Waiting...(0s)',
        startThinking: false,
      })
      const turn = this.currentTurn
      if (!turn) return
      const bootTimer = this.startFooterTimer(
        turn.cardId,
        '🚀 启动 Codex',
        status => this.withModel(status),
      )
      let lastBootStatus = '🚀 启动 Codex'
      const ok = await this.start({
        announce: false,
        onStatus: status => {
          lastBootStatus = status
          bootTimer.setStatus(status)
        },
      })
      bootTimer.stop()
      await cardkit.flush(turn.cardId)
      if (!ok) {
        this.pendingUserMessageCount = 0
        this.pendingMidTurnMsgs = []
        this.pendingTurnInputs = []
        this.lastUserOpenId = ''
        this.releaseAllReactions()
        await this.closeTurnCard(lastBootStatus.startsWith('❌') ? lastBootStatus : '❌ 启动失败', { forcePush: true })
        return
      }
      this.startThinkingFooter(turn)
      this.proc!.sendUserText(wireText, [])
      this.pendingUserMessageCount++
      this.status = 'working'
    } finally {
      this.openingTurn = false
    }
  }

  // ── Inbound from Feishu ────────────────────────────────────────────
  /** Inbound user message. Starts a Codex turn immediately when idle —
   * the SDK queues internally if a turn is in flight (FIFO, exactly the
   * type-ahead semantics of the native Codex UI). Card opening:
   *   - First msg of session OR no turn in flight  → open card eagerly here
   *   - Mid-flight msg                              → defer; the `init`
   *     handler opens its card when the SDK actually starts the turn
   * This is what lets a single subprocess host both user-typed turns and
   * cron-fired wakeups without the daemon ever calling `sendInterrupt` —
   * `kill`/`stop` are the only paths that interrupt now. */
  async onUserMessage(text: string, files: string[] = [], userOpenId = '', msgId = ''): Promise<void> {
    // Garbage-collect leftover state from a batch the SDK abandoned —
    // most commonly an AskUserQuestion mid-turn, which makes the SDK
    // emit `QUEUE remove × N` and drop every msg we'd already
    // sendText'd into its queue. The daemon doesn't see those remove
    // events, so `pendingUserMessageCount` and `pendingReactionIds`
    // stay stuck. If the SDK is idle right now (no turn, no eager-
    // open in flight) AND init has already fired at least once
    // (otherwise we'd be in the bootstrap race window where
    // leftover count IS valid — see wasBusy comment below), the
    // leftover count is stale and must be cleared BEFORE the
    // wasBusy computation — otherwise this fresh solo message is
    // misclassified as queued and its card closes with `📨 转交新卡`
    // instead of `✅`.
    if (this.initCount >= 1 && !this.currentTurn && !this.openingTurn && this.pendingUserMessageCount > 0) {
      this.pendingUserMessageCount = 0
      // Release stale ⏳ reactions left on the abandoned batch's
      // chat messages. addReaction callbacks still in flight will
      // fall through to the orphan path in the wasBusy branch
      // below (which deletes whatever rid lands after both maps
      // are empty).
      for (const [m, rid] of this.pendingReactionIds) {
        if (rid) void feishu.deleteReaction(m, rid)
      }
      this.pendingReactionIds = new Map()
    }
    // Capture busy-state SYNC, before any state mutation — this decides
    // whether the message will visibly queue (gets the OneSecond → later
    // CheckMark lifecycle reactions on its Feishu chat message) or
    // eager-open its own card (no reaction needed; the card itself is
    // the acknowledgement).
    //
    // `pendingUserMessageCount > 0` catches the bootstrap race: daemon
    // just spawned, `initCount` is still 0 so no card is open yet, but
    // we've already sendText'd a previous user message into the SDK.
    // The next message lands in the SAME merged-batch SDK queue, so
    // it IS mid-flight from the SDK's perspective — without this
    // check, the daemon would mark it as solo (no ⏳ reaction) and
    // lose track of the queued turn.
    const wasBusy = this.currentTurn !== null || this.openingTurn
      || this.pendingUserMessageCount > 0 || this.pendingMidTurnMsgs.length > 0
    this.lastUserOpenId = userOpenId
    // File hint **inline 在 wireText 内部**,而不是依赖 sendUserText 把
    // files 拼到 message 整体头部。原因:drainMidTurnAndOpen merge N 条
    // wireText 时,若 files 还按整体拼接 → 所有 file hint 全堆在 long
    // message 开头,模型分不清哪个文件配哪条。inline 后每条 sub-message
    // 自带 file hint,SDK side 所有 sendUserText 调用 files 一律传空。
    const filePrefix = files.length ? files.map(f => `[file: ${f}]`).join(' ') + '\n' : ''
    const wireText = filePrefix + text

    // Reaction helper: track the OneSecond reaction so deleteReaction can
    // clear it later. Use empty-string sentinel until addReaction returns.
    const trackReaction = (id: string) => {
      this.pendingReactionIds.set(id, '')
      void (async () => {
        const rid = await feishu.addReaction(id, 'OneSecond')
        if (!rid) return
        if (this.pendingReactionIds.has(id)) {
          this.pendingReactionIds.set(id, rid)
        } else if (this.currentBatchReactionIds.has(id)) {
          this.currentBatchReactionIds.set(id, rid)
        } else {
          // Orphan: both maps cleared before our add returned. Delete
          // directly so the user doesn't see a stale ⏳ forever.
          void feishu.deleteReaction(id, rid)
        }
      })()
    }

    if (!this.isRunning()) {
      if (this.openingTurn || this.currentTurn) {
        this.pendingMidTurnMsgs.push({ text, wireText, userOpenId, msgId })
        if (msgId) trackReaction(msgId)
        return
      }
      await this.startColdUserTurn(text, wireText, userOpenId)
      return
    }

    if (this.currentTurn !== null) {
      // Mid-turn — BUFFER instead of immediate sendUserText. The SDK polling
      // loop will not auto-dequeue queued type-ahead msgs after `result`
      // (we explicitly write again to wake the Codex app-server),
      // so writing here would leave the msg stuck until the next user msg
      // arrives. Drain happens in the `result` handler, which both wakes
      // the SDK and opens a fresh card for the new batch turn.
      this.pendingMidTurnMsgs.push({ text, wireText, userOpenId, msgId })
      if (msgId) trackReaction(msgId)
      return
    }

    // No in-flight turn: send straight to SDK. This path handles
    //   - first message after spawn (init not yet fired)
    //   - bootstrap race (sibling msgs landing before init#1)
    //   - solo message after a prior turn has fully closed
    // Eager-open path: open the card BEFORE feeding SDK, so a card-open
    // failure doesn't strand the daemon with SDK processing a turn we
    // have nowhere to render. `!openingTurn` means no sibling is mid-
    // open; `initCount >= 1` means SDK boot init has fired (otherwise
    // the init handler owns turn opening and we just feed the queue
    // below). On failure openTurnCard surfaces a red banner via
    // sendTextRaw; SDK was idle so no interrupt needed.
    if (!this.openingTurn && this.initCount >= 1) {
      this.openingTurn = true
      try {
        // openTurnCard 内部读 pendingTurnInputs 渲染 "📥 收到" panel,要在
        // 它之前 push;之后再 sendUserText 给 SDK,顺序无关紧要(panel 是
        // daemon 自渲染,跟 SDK input 流分离)。
        this.pendingTurnInputs.push(text)
        await this.openTurnCard(userOpenId, 'user_message')
        if (!this.currentTurn) return
        this.proc!.sendUserText(wireText, [])
        this.pendingUserMessageCount++
        this.status = 'working'
      } finally {
        this.openingTurn = false
      }
      return
    }

    // Non-eager path 分两支:
    //   A) openingTurn=true 或 pendingUserMessageCount>0 — sibling 在
    //      openTurnCard,或者 cold-start 第一条 sendUserText 已经发出在
    //      等 SDK init#1。两种情况下直接 sendUserText 都会让 SDK
    //      把这条偷偷合并进 sibling 的 turn(或第一条触发的 cold-start
    //      turn),但 panel input 已经被 snapshot 决定 → "内容跟响应不
    //      一致"race(02:22 + 03:19 现场,以及 commit 2258af4 注释里的
    //      cold-start "first write lands in idle SDK" empirical 行为)。
    //      改成 mid-turn buffer 风格:不 sendUserText、不 push
    //      pendingTurnInputs,等 sibling turn close 后由 result handler
    //      的 midBuffer drain 走 merge 一致处理。
    //   B) cold start 第一条 (initCount===0 且 pendingCount===0) — init
    //      还没来,必须 sendUserText 喂 SDK 才能 wake;init handler 后续
    //      触发 openTurnCard 时一次性消费 pendingTurnInputs。
    if (this.openingTurn || this.pendingUserMessageCount > 0) {
      this.pendingMidTurnMsgs.push({ text, wireText, userOpenId, msgId })
      if (msgId) trackReaction(msgId)
      return
    }
    this.pendingTurnInputs.push(text)
    this.proc!.sendUserText(wireText, [])
    this.pendingUserMessageCount++
    if (wasBusy && msgId) {
      // Bootstrap race / sibling-opening race: until a card is open,
      // the OneSecond ⏳ is the only ack the user gets. The init handler
      // inherits these via currentBatchReactionIds when it opens.
      trackReaction(msgId)
    }
  }

  // ── External API delegated to helpers ──────────────────────────────
  // Thin wrappers so daemon.ts keeps its `session.xxx(...)` call style;
  // bodies live in session-ask.ts / session-permission.ts.

  hasPendingAsk(): boolean {
    return sessionAsk.hasPendingAsk(this)
  }

  hasPendingHostAsk(): boolean {
    return sessionHostAsk.hasPendingHostAsk(this)
  }

  onAskMessageAnswer(text: string, user: string, msgId: string): Promise<void> {
    return sessionAsk.onAskMessageAnswer(this, text, user, msgId)
  }

  onHostAskMessageAnswer(text: string, user: string, msgId: string): Promise<void> {
    return sessionHostAsk.onHostAskMessageAnswer(this, text, user, msgId)
  }

  onAskAnswer(toolUseId: string, questionIdx: number, optionIdx: number, user: string): Promise<void> {
    return sessionAsk.onAskAnswer(this, toolUseId, questionIdx, optionIdx, user)
  }

  onHostAskAnswer(toolUseId: string, questionIdx: number, optionIdx: number, user: string): Promise<ModelActionResult> {
    return sessionHostAsk.onHostAskAnswer(this, toolUseId, questionIdx, optionIdx, user)
  }

  onAskCustomAnswer(toolUseId: string, questionIdx: number, customText: string, user: string): Promise<boolean> {
    return sessionAsk.onAskCustomAnswer(this, toolUseId, questionIdx, customText, user)
  }

  onHostAskCustomAnswer(toolUseId: string, questionIdx: number, customText: string, user: string): Promise<ModelActionResult> {
    return sessionHostAsk.onHostAskCustomAnswer(this, toolUseId, questionIdx, customText, user)
  }

  onPermissionDecision(requestId: string, decision: 'allow' | 'allow_always' | 'deny', user: string): Promise<void> {
    return sessionPermission.onPermissionDecision(this, requestId, decision, user)
  }

  async startHostAskContinuation(wireText: string): Promise<void> {
    if (!this.isRunning()) throw new Error('codex is not running')
    if (this.currentTurn || this.openingTurn) throw new Error('codex turn still active')
    this.openingTurn = true
    try {
      await this.openTurnCard('', 'user_message')
      if (!this.currentTurn) throw new Error('failed to open continuation turn card')
      this.proc!.sendUserText(wireText, [])
      this.pendingUserMessageCount++
      this.status = 'working'
    } finally {
      this.openingTurn = false
    }
  }

  // ── Wiring Codex → Feishu ──────────────────────────────────────────
  private persistResumableSessionId(): void {
    const sessionId = this.proc?.sessionId
    if (!sessionId || sessionId === this.lastSessionId) return
    this.lastSessionId = sessionId
    feishu.bindSessionResume(this.sessionName, sessionId)
  }

  private wireProc(p: CodexProcess): void {
    p.on('error', err => {
      log(`session "${this.sessionName}": codex process error: ${err}`)
    })
    p.on('init', () => {
      this.initCount++
      log(`session "${this.sessionName}": SDK init#${this.initCount} pendingCount=${this.pendingUserMessageCount} midBuffer=${this.pendingMidTurnMsgs.length} currentTurn=${this.currentTurn ? 'yes' : 'no'} openingTurn=${this.openingTurn}`)

      // Boot init (initCount === 1) is claimed by `onUserMessage`'s
      // eager-open path — if a user message landed before the init
      // arrived, it sits in `pendingUserMessageCount` and we drain it
      // below; otherwise the init opens nothing. Subsequent inits
      // (initCount >= 2) can mark the start of an SDK-initiated turn
      // when the SDK is draining the type-ahead queue we fed it via
      // `sendUserText` (isUserBatch).
      //
      // SDK-driven rotation puts the boundary HERE: the previous
      // turn's `result` already closed the in-flight card with
      // `📨 转交新卡` (because pendingUserMessageCount > 0). Now we
      // open a fresh card whose top panel shows the queued messages.
      // currentTurn should be null at this point (result null'd it);
      // the openingTurn guard catches the eager-open vs init race.
      if (this.currentTurn || this.openingTurn) return
      const isUserBatch = this.pendingUserMessageCount > 0
      if (!isUserBatch) return
      const userOpenId = this.lastUserOpenId
      if (isUserBatch) {
        this.pendingUserMessageCount = 0
        // Inherit the queued reaction_ids — this turn is collectively
        // responsible for releasing their OneSecond reactions when it
        // closes (via deleteReaction in closeTurnCard).
        this.currentBatchReactionIds = this.pendingReactionIds
        this.pendingReactionIds = new Map()
      }
      this.openingTurn = true
      void (async () => {
        try {
          await this.openTurnCard(userOpenId, 'user_message')
          if (!this.currentTurn) {
            // SDK already started this turn (its `init` is what got us
            // here) but we have no card to render into. Interrupt so
            // assistant/tool events aren't silently dropped while the
            // model burns tokens. Release the reactions this batch
            // inherited (init handler moved them above) — otherwise
            // they stay ⏳ forever on the user's chat messages.
            log(`session "${this.sessionName}": init-path openTurnCard failed — sendInterrupt + release reactions`)
            this.proc?.sendInterrupt()
            this.releaseAllReactions()
          } else {
            this.status = 'working'
          }
        } finally {
          this.openingTurn = false
        }
      })()
    })
    p.on('turn_started', () => {
      this.persistResumableSessionId()
      const total = this.proc?.lastTotalUsage
      if (this.usageTotalsSeedUnknown && !total) {
        this.currentTurnUsageBaseline = null
        this.currentTurnUsageBaselineKnown = false
        return
      }
      this.currentTurnUsageBaseline = total ? { ...total } : null
      this.currentTurnUsageBaselineKnown = true
    })
    p.on('token_usage', ({ totalUsage }: TokenUsageUpdated) => {
      if (totalUsage) this.usageTotalsSeedUnknown = false
    })
    p.on('turn_plan_updated', (plan: TurnPlanUpdated) => {
      this.handleTurnPlanUpdated(plan)
    })
    p.on('plan_delta', (delta: PlanDelta) => {
      this.handlePlanDelta(delta)
    })
    p.on('context_compacted', (notice: ContextCompactedNotification) => {
      this.handleContextCompacted(notice)
    })
    p.on('rate_limits_updated', (rateLimits: any) => {
      updateUsageFromRateLimits(rateLimits)
    })
    p.on('thread_goal_updated', (goal: ThreadGoal) => {
      this.handleThreadGoalUpdated(goal)
    })
    p.on('thread_goal_cleared', () => {
      this.handleThreadGoalCleared()
    })
    p.on('assistant_text', ({ text }: { text: string }) => {
      this.appendAssistant(text)
    })
    p.on('assistant_block_stop', () => {
      // 一段 content block 收尾(SSE content_block_stop)→ 把当前 assistant 段
      // 静态化成完整 markdown,然后 reset 段游标让下一段开新元素。这条 emit 在该段最后一个
      // text_delta 之后同步到达(codex-process 按 stdout 行序 emit),所以
      // appendAssistant 已把全量累进 currentAssistantText,这里定稿拿到的是完整段。
      this.finalizeCurrentAssistantSegment()
    })
    p.on('tool_use', ({ id, name, input }: { id: string; name: string; input: any }) => {
      sessionTools.addTool(this, id, name, input)
    })
    p.on('tool_result', ({ tool_use_id, content, is_error }: any) => {
      sessionTools.completeTool(this, tool_use_id, content, is_error)
    })
    p.on('can_use_tool', (req: CanUseToolRequest) => {
      sessionPermission.renderPermission(this, req)
    })
    p.on('hook_callback', (req: HookCallbackRequest) => {
      // No hooks registered → fail-safe ack.
      this.proc?.sendHookResponse(req.request_id, {})
    })
    p.on('result', () => {
      this.accumulateResultStats()
      // User just hit `stop` — this result is the SDK closing the in-flight
      // turn after sendInterrupt landed. The card already shows `🛑 打断`
      // from the stop path, so skip the rest unconditionally.
      if (this.userInterrupted) {
        this.userInterrupted = false
        const subtype = this.proc?.lastResult.subtype ?? 'unknown'
        const isError = this.proc?.lastResult.is_error === true
        log(`session "${this.sessionName}": SDK result after user stop subtype=${subtype} isError=${isError} — ignored`)
        this.status = 'idle'
        return
      }
      const hasMidTurn = this.pendingMidTurnMsgs.length > 0
      const isError = this.proc?.lastResult.is_error === true
      const subtype = this.proc?.lastResult.subtype ?? 'success'
      const hostAskFlowActive = this.pendingHostAsks.size > 0

      let suffix: string | undefined
      let forcePush = false

      if (hasMidTurn && !hostAskFlowActive) {
        suffix = isError ? `⚠️ Codex ${subtype},用户已介入` : '📨 转交新卡'
      } else if (isError) {
        suffix = `⚠️ Codex ${subtype}`
        forcePush = true
      }

      log(`session "${this.sessionName}": SDK result subtype=${subtype} isError=${isError} midBuffer=${this.pendingMidTurnMsgs.length} forcePush=${forcePush}`)
      void this.closeTurnCard(suffix, { forcePush, hasFreshResult: true })
      this.status = 'idle'
      sessionHostAsk.resumeAnsweredHostAsks(this)

      if (hasMidTurn && !hostAskFlowActive) {
        void this.drainMidTurnAndOpen()
      }
    })
    p.on('exit', ({ code, signal, expected }: any) => {
      log(`session "${this.sessionName}": codex exited code=${code} signal=${signal} expected=${expected}`)
      this.proc = null
      this.stopThinkingFooter(this.currentTurn)
      this.currentTurn = null
      this.pendingUserMessageCount = 0
      this.pendingMidTurnMsgs = []
      this.pendingTurnInputs = []
      this.lastUserOpenId = ''
      this.releaseAllReactions()
      this.initCount = 0
      this.openingTurn = false
      // 进程没了 ⇒ 任何 pending ask 都不可能再收到 can_use_tool 或回传答案,
      // 定义上已死。不清的话 hasPendingAsk() 恒 true,后续每条消息都被
      // onAskMessageAnswer 当僵尸答案吞掉,session 焊死到下次 daemon 重启
      // (kill/restart 同样在上面补了这一清理)。
      this.pendingAsks.clear()
      this.pendingHostAsks.clear()
      this.pendingPermissions.clear()
      this.userInterrupted = false
      this.currentTurnUsageBaseline = null
      this.currentTurnUsageBaselineKnown = false
      this.usageTotalsSeedUnknown = false
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      if (!expected && code !== 0 && signal !== 'SIGTERM') {
        void feishu.sendText(this.chatId, `⚠️ Codex 异常退出 (code=${code}, signal=${signal})。回复任意消息将重新启动。`)
      }
    })
  }

  /** Pull per-turn numbers off `proc.lastResult` (set by CodexProcess when
   * the `result` message landed) and roll them into cumStats + the
   * "上一轮" delta. Turn usage uses absolute thread totals from
   * `thread/tokenUsage/updated.total` minus the baseline captured at
   * `turn_started`, so a multi-request turn is aggregated correctly
   * instead of inheriting only the final request's `last` snapshot.
   * Called exactly once per result event, right before closeTurnCard. */
  private accumulateResultStats(): void {
    const r = this.proc?.lastResult
    if (!r) return
    const u = this.currentTurnUsageBaselineKnown
      ? diffUsageTotals(this.proc?.lastTotalUsage, this.currentTurnUsageBaseline)
      : null
    this.lastTurnUsage = u
    this.currentTurnUsageBaseline = null
    this.currentTurnUsageBaselineKnown = false
    // 有效 token = 真正喂进(input + 本轮新建缓存)+ 产出。故意不含
    // cache_read_input_tokens —— 那是把整段已缓存上下文又复读一遍的计费量,
    // 每轮几乎等于全窗口,计进来会让累计虚高一个量级。这里的 usage 是
    // 整个 turn 的绝对总量差值,不是最后一次模型请求的快照。
    const tokens = effectiveTurnTokens(u)
    // cost 取本进程算好的本轮增量,而非 total_cost_usd 累计值 —— 直接累加
    // Codex 当前没有逐 turn dollar cost,这里保持 0/null。
    const costUsd = r.cost_delta_usd ?? 0
    const durationMs = r.duration_ms ?? 0
    if (tokens != null) this.cumStats.tokens += tokens
    this.cumStats.costUsd += costUsd
    this.cumStats.turns += r.num_turns ?? 1
    this.lastTurnDelta = { tokens, costUsd, durationMs }
  }

  /** Current context-window occupancy estimate. Codex app-server reports
   * the latest model request in tokenUsage.last; its totalTokens is the
   * active context size. cachedInputTokens is a subset breakdown of
   * inputTokens, not extra context. */
  private currentContextTokens(): number | null {
    const u = this.proc?.lastUsage as CodexUsage | null | undefined
    return contextTokensFromUsage(u)
  }

  /** Display denominator for context percentage, sourced from Codex
   * app-server's effective modelContextWindow for this thread. */
  private contextLimitForDisplay(): number | null {
    return contextLimitFromAppServer(this.proc?.lastContextWindow)
  }

  /** Drain `pendingMidTurnMsgs` to the SDK and open a fresh card for the
   * resulting batch turn. Called from the `result` handler when buffered
   * mid-turn messages need to start their own turn. The `sendUserText`
   * calls wake the SDK polling loop (priority="now" semantics) and
   * comprise the input for the new turn. Opens the card here rather
   * than deferring to init because the init for this batch will arrive
   * with `currentTurn` already set and bail.
   *
   * N 条 wireText 用 `\n\n` join 成 **单条** sendUserText 发给 SDK,而不是
   * N 次独立写。背景:SDK polling loop 在 turn 边界一次只 dequeue 一条
   * user message 进 prompt,N 次独立写会让
   * SDK 把第 1 条单独开 turn、剩 N-1 条进下一 turn —— daemon 这边 panel
   * 在 openTurnCard 时已经 commit 了全部 N 条到 "前一个" turn,跟 SDK
   * 实际 turn 边界错位(03:19 现场 turn=5 panel 7 条 vs 模型只看到 1 条
   * "1 和 2 两条都收到了")。join 成单条后,SDK 看到 1 个 user message,
   * panel 跟模型实际 input 一致。
   *
   * pendingCount 一次 ++(对应一次 sendUserText)。因为 SDK 不再拆 turn,
   * commit 2258af4 当年用累加保护 spurious 第二 turn 的逻辑不再需要 —
   * SDK 不会自发开 user_batch 子 turn。 */
  private async drainMidTurnAndOpen(): Promise<void> {
    if (this.pendingMidTurnMsgs.length === 0) return
    const batch = this.pendingMidTurnMsgs
    this.pendingMidTurnMsgs = []
    this.openingTurn = true
    try {
      // daemon-side state: panel inputs + reaction transfer。不走 sendUserText,
      // SDK 那边由 join 后的单条统一处理。
      for (const msg of batch) {
        this.pendingTurnInputs.push(msg.text)
        if (msg.msgId) {
          const rid = this.pendingReactionIds.get(msg.msgId) ?? ''
          this.currentBatchReactionIds.set(msg.msgId, rid)
          this.pendingReactionIds.delete(msg.msgId)
        }
      }
      // wireText 每条已经在 onUserMessage 内 inline 了自己的 file hint;
      // SDK side files 一律传空,避免 file ↔ message 归属丢失(P1-1)。
      const merged = batch.map(m => m.wireText).join('\n\n')
      this.proc!.sendUserText(merged, [])
      this.pendingUserMessageCount++
      const last = batch[batch.length - 1]
      const userOpenId = last?.userOpenId ?? this.lastUserOpenId
      await this.openTurnCard(userOpenId, 'user_message')
      // 不动 pendingUserMessageCount;init handler 在 isUserBatch 路径
      // 自己 reset。merge 之后 SDK 不拆 turn,不会再有空 user_message turn。
      this.status = 'working'
    } finally {
      this.openingTurn = false
    }
  }

  private async openTurnCard(
    userOpenId: string,
    trigger: 'user_message',
    opts: { initialFooter?: string; startThinking?: boolean } = {},
  ): Promise<void> {
    const turn = ++this.turnCounter
    // Snapshot+clear pendingTurnInputs synchronously here so concurrent
    // pushes between snapshot and the await don't sneak into THIS turn's
    // panel (they'll be picked up by the next turn's open).
    const userInputs = this.pendingTurnInputs
    this.pendingTurnInputs = []
    log(`session "${this.sessionName}": openTurnCard turn=${turn} trigger=${trigger} inputs=${userInputs.length}`)
    const initialFooter = this.withModel(opts.initialFooter ?? 'Waiting...(0s)')
    const card = cards.mainConversationCard({
      sessionName: this.sessionName,
      turn,
      model: this.currentModelLabel() ?? undefined,
      effort: this.currentEffortLabel(),
      kind: trigger,
      userInputs,
      initialFooter,
    })
    const messageId = await feishu.sendCard(this.chatId, card)
    if (!messageId) {
      log(`session "${this.sessionName}": openTurnCard sendCard EXHAUSTED retries — surfacing via raw text`)
      // sendCard already retried 3× through the SDK. If it still came back
      // null we're either on a sustained SDK-axios outage or a Feishu
      // business reject. Either way the user just sent us a message and
      // it's gone into a black hole — surface that explicitly so they
      // know to resend instead of waiting for a reply that won't come.
      // Use raw fetch (not sendText) because if the SDK is the broken
      // thing we'd be doomed to silence otherwise.
      await feishu.sendTextRaw(
        this.chatId,
        '❌ 创建对话卡片失败 (Feishu SDK 重试 3 次后仍连不上)。你这条消息没能送到 Codex,请稍后重发。',
      )
      // currentTurn left null as the failure signal. Caller decides
      // whether to sendInterrupt: onUserMessage's eager-open path
      // hasn't fed SDK yet so doesn't need to; the init handler has
      // (SDK started the turn itself) and must.
      return
    }
    let cardId: string
    try { cardId = await cardkit.convertMessageToCard(messageId) }
    catch (e) { log(`session "${this.sessionName}": id_convert failed: ${e}`); return }
    // Tell cardkit how many elements the initial body already has so
    // its element-count tracker is correct from the first addElement
    // onwards (userInputPanel + footer).
    const initialElementCount =
      (userInputs.length > 0 ? 1 : 0) +
      1
    cardkit.recordCardCreated(cardId, initialElementCount, (code) => this.onCardWriteFailure(code))
    const turnState: TurnState = {
      cardId,
      messageId,
      userOpenId,
      trigger,
      toolCount: 0,
      toolByUseId: new Map(),
      planSteps: [],
      planExplanation: null,
      planUpdateCount: 0,
      goalUpdateCount: 0,
      contextCompactCount: 0,
      contextCompactionPending: new Map(),
      readBatches: new Map(),
      openReadBatchI: null,
      assistantSegmentCount: 0,
      currentAssistantSegmentId: null,
      currentAssistantText: '',
      segmentTexts: new Map(),
      startedAt: Date.now(),
      thinkingFooterHandle: null,
      thinkingFooterStartedAt: 0,
      rotating: null,
      rotateCount: 0,
      rotateGivenUp: false,
      outboundSeenPaths: new Set(),
      outboundSentPaths: new Set(),
      hostAskMarkersSeen: new Set(),
    }
    this.currentTurn = turnState
    if (opts.startThinking !== false) this.startThinkingFooter(turnState)
  }

  /** Cheap synchronous check called from stream handlers right before
   * they `addElement` a new tool / assistant segment / Read batch /
   * etc. If the current card is close to Feishu's element ceiling and
   * we haven't already kicked off a rotation, fire-and-forget start a
   * `startMidTurnRotate` and let it run async on its own. The current
   * stream handler still uses `turn.cardId` (the old card) for this
   * iteration — that's fine because (a) cardkit's per-card queue keeps
   * its writes ordered against the soft-close that's about to happen,
   * and (b) the soft limit (CARD_ELEMENT_SOFT_LIMIT=50) sits well under
   * the observed ~75 ceiling, so an in-flight add either fits or — if it
   * doesn't — trips onCardWriteFailure, which rotates reactively anyway. */
  maybeMidTurnRotate(): void {
    const turn = this.currentTurn
    if (!turn) return
    if (turn.rotating) return
    if (cardkit.getElementCount(turn.cardId) < CARD_ELEMENT_SOFT_LIMIT) return
    this.startMidTurnRotate(turn)
  }

  /** Reactive rotation trigger: cardkit calls this (via the addElement
   * onFailure path) whenever a write to the card was rejected by Feishu —
   * ANY code, not just 300305/300315. The element limit was the symptom
   * that surfaced this, but the same response ("the card is unwritable,
   * move to a fresh one") applies to a schema/rule change, or a transient
   * server reject that survived the reopen-retry. Deliberately does NOT
   * consult getElementCount: a failed add never bumps the counter, so the
   * count is stuck below the soft cap exactly when a rotate is most needed
   * (the bug that froze the 2026-05-23 turn at ~76 elements). Idempotent
   * (a rotation already in flight is left alone) and capped
   * (MAX_MIDTURN_ROTATES) so a persistent failure can't spin forever. */
  onCardWriteFailure(code?: number): void {
    const turn = this.currentTurn
    if (!turn) return
    if (turn.rotating) return
    if (turn.rotateCount >= MAX_MIDTURN_ROTATES) {
      if (!turn.rotateGivenUp) {
        turn.rotateGivenUp = true
        log(`session "${this.sessionName}": rotate cap (${MAX_MIDTURN_ROTATES}) hit — giving up, rest of turn is log-only`)
        void feishu.sendTextRaw(this.chatId, `⚠️ 卡片连续 ${MAX_MIDTURN_ROTATES} 次写入失败(疑似飞书故障或内容超限),本轮后续输出仅日志可见。`)
      }
      return
    }
    const why = cardkit.isElementLimitCode(code) ? `element limit (${code})` : `write failure (code=${code ?? 'n/a'})`
    log(`session "${this.sessionName}": ${why} on card=${turn.cardId.slice(0, 8)}… — rotating to fresh card`)
    this.startMidTurnRotate(turn)
  }

  /** Open a fresh card under the **same** SDK turn number to dodge
   * Feishu's per-card element limit. The old card stays in the chat —
   * we flip its footer to "📨 已续至下一张卡", turn streaming off, and
   * dispose its cardkit state — but it never becomes the writable one
   * again. Turn state is reset so subsequent stream handlers wire up
   * against the new card cleanly; the still-live content is carried over
   * rather than dropped: the in-flight assistant segment (rebuilt and
   * continued) and any unfinished / failed tools (rebuildToolsOnRotate
   * moves them, Reads split out), while already-finished tools stay on
   * the old card. */
  private startMidTurnRotate(turn: TurnState): void {
    if (turn.rotating) return
    turn.rotateCount++
    const oldCardId = turn.cardId
    // 同步快照 tool 簿子 —— swap 会把这俩 Map 换成新的空 Map,旧对象仍被这俩
    // 引用持有(切卡 async 窗口里到达的新 tool 也继续 append 进旧 Map),
    // rebuildToolsOnRotate 用它们把"未完成/建失败"的 tool 搬到新卡。
    // assistant 段不在这里快照:它要带的是 swap 那一刻的最新全文(含切卡窗口期
    // 的 delta),所以放到 swap 时再读 —— 配合 appendAssistant onFailure 在
    // rotating 期间不 reset,这段会一直累积到 swap,窗口期的字一个不丢。
    const oldToolByUseId = turn.toolByUseId
    const oldBatches = turn.readBatches
    turn.rotating = (async () => {
      try {
        log(`session "${this.sessionName}": mid-turn rotate triggered card=${oldCardId.slice(0, 8)}… elementCount=${cardkit.getElementCount(oldCardId)}`)
        const card = cards.mainConversationCard({
          sessionName: this.sessionName,
          turn: this.turnCounter,
          model: this.currentModelLabel() ?? undefined,
          effort: this.currentEffortLabel(),
          kind: 'card_full',
          userInputs: [],
        })
        const newMessageId = await feishu.sendCard(this.chatId, card)
        if (!newMessageId) {
          log(`session "${this.sessionName}": mid-turn rotate sendCard EXHAUSTED — staying on old card,subsequent adds will drop`)
          await feishu.sendTextRaw(
            this.chatId,
            '⚠️ 卡片元素超出飞书上限,本轮后续输出仅日志可见(开新卡失败)。',
          )
          return
        }
        let newCardId: string
        try { newCardId = await cardkit.convertMessageToCard(newMessageId) }
        catch (e) {
          log(`session "${this.sessionName}": mid-turn rotate id_convert failed: ${e}`)
          return
        }
        // card_full body has banner(1) + footer(1) = 2 elements.
        cardkit.recordCardCreated(newCardId, 2, (code) => this.onCardWriteFailure(code))
        // 同步 swap：从这一行起,后续 stream handler 看到的 turn.cardId
        // 是新卡。reset 所有 element-id 引用 (toolCount / assistantSegmentCount
        // 等),旧卡上的 element_id 在新卡里查不到,继续 PUT 会 300313。
        this.stopThinkingFooter(turn)
        turn.cardId = newCardId
        turn.messageId = newMessageId
        turn.toolCount = 0
        turn.toolByUseId = new Map()
        turn.readBatches = new Map()
        turn.openReadBatchI = null
        turn.planUpdateCount = 0
        turn.goalUpdateCount = 0
        // swap 那一刻读当前正在写的段(含切卡 async 窗口里到达的全部 delta ——
        // onFailure 在 rotating 期间不 reset,所以这段一直累积到这里)。先读后清。
        const carrySegId = turn.currentAssistantSegmentId
        const carryText = (turn.currentAssistantText ?? '').trim()
        const oldSegmentTexts = turn.segmentTexts
        turn.assistantSegmentCount = 0
        turn.currentAssistantSegmentId = null
        turn.currentAssistantText = ''
        turn.segmentTexts = new Map()
        if (carryText) cardkit.streamTextThrottled(turn.cardId, cards.ELEMENTS.footer, this.withModel(FOOTER_WORKING))
        else this.startThinkingFooter(turn)
        // 把"还在跑 / 建失败"的 tool 搬到新卡(已完成的留旧卡),Read 切开重建。
        sessionTools.rebuildToolsOnRotate(this, oldCardId, newCardId, oldToolByUseId, oldBatches)
        // 当前 assistant 段还没收尾就换卡时,整段迁到新卡继续写。不要把半段
        // 留旧卡、半段接新卡；旧卡收尾时会删除原流式元素。
        if (carrySegId && carryText) {
          const ri = turn.assistantSegmentCount++
          const reSegId = cards.ELEMENTS.assistant(ri)
          turn.currentAssistantSegmentId = reSegId
          turn.currentAssistantText = carryText
          turn.segmentTexts.set(reSegId, carryText)
          void cardkit.addElement(newCardId, cards.assistantSegmentElement(ri), {
            type: 'insert_before', targetElementId: cards.ELEMENTS.footer,
          })
          cardkit.streamTextThrottled(newCardId, reSegId, this.cleanAssistantTextForDisplay(carryText))
        }
        // 旧卡收尾:footer 红字 + streaming_off + dispose。放到 swap 后
        // 是因为这条链是 async,期间 cardkit 队列上还可能有 stream
        // handler enqueue 的 streamText / replaceElement 等;让它们排
        // 在 footer 之前先 flush,视觉更连贯。
        try {
          await cardkit.flush(oldCardId)
          // 旧卡上已完成的 assistant 段做最终替换。当前迁移中的半段要从
          // 旧卡删除,避免同一段同时出现在两张卡上；已静态化并删除的流式
          // 元素会被 cardkit 的 deadElements 跳过。
          for (const [segId, fullText] of oldSegmentTexts) {
            if (carrySegId && carryText && segId === carrySegId) continue
            await cardkit.replaceElement(oldCardId, segId, {
              tag: 'markdown',
              element_id: segId,
              content: this.cleanAssistantTextForDisplay(fullText).trim() || ' ',
            })
          }
          if (carrySegId && carryText) {
            await cardkit.deleteElement(oldCardId, carrySegId)
          }
          const compactNote = turn.contextCompactCount > 0
            ? ` · 🚨 压缩×${turn.contextCompactCount}`
            : ''
          await cardkit.streamText(oldCardId, cards.ELEMENTS.footer, this.withModel(`📨 已续至下一张卡 ↓${compactNote}`))
          cardkit.cancelSummary(oldCardId)
          await cardkit.patchSettings(oldCardId, cards.streamingOffSettings({ suffix: '📨 转下一张' }))
          await cardkit.dispose(oldCardId)
        } catch (e) {
          log(`session "${this.sessionName}": mid-turn rotate close-old failed: ${e}`)
        }
        log(`session "${this.sessionName}": mid-turn rotate done old=${oldCardId.slice(0, 8)}… new=${newCardId.slice(0, 8)}…`)
      } finally {
        turn.rotating = null
      }
    })()
  }

  // Stream-event handlers are intentionally SYNCHRONOUS. Every cardkit op
  // is queued (per-card Promise chain in cardkit.ts), so we fire-and-
  // forget here and rely on enqueue source order — that way no `await`
  // can yield mid-handler and let `closeTurnCard` (or another event) race
  // and mutate `this.currentTurn` underfoot.

  private addPlanSnapshotOnCurrentTurn(): void {
    const turn = this.currentTurn
    if (!turn || turn.planSteps.length === 0) return
    this.maybeMidTurnRotate()
    const cardId = turn.cardId
    const elementId = cards.ELEMENTS.planUpdate(turn.planUpdateCount++)
    void cardkit.addElement(cardId, cards.planElement(turn.planSteps, turn.planExplanation, '', elementId), {
      type: 'insert_before',
      targetElementId: cards.ELEMENTS.footer,
    })
  }

  private addGoalUpdateOnCurrentTurn(goal: cards.ThreadGoal): void {
    const turn = this.currentTurn
    if (!turn) return
    this.maybeMidTurnRotate()
    const elementId = cards.ELEMENTS.goalUpdate(turn.goalUpdateCount++)
    void cardkit.addElement(turn.cardId, cards.goalElement(goal, elementId), {
      type: 'insert_before',
      targetElementId: cards.ELEMENTS.footer,
    })
  }

  private addGoalClearedOnCurrentTurn(): void {
    const turn = this.currentTurn
    if (!turn) return
    this.maybeMidTurnRotate()
    const elementId = cards.ELEMENTS.goalUpdate(turn.goalUpdateCount++)
    void cardkit.addElement(turn.cardId, {
      tag: 'markdown',
      element_id: elementId,
      content: '**🎯 当前目标**\n\n已清除',
    }, {
      type: 'insert_before',
      targetElementId: cards.ELEMENTS.footer,
    })
  }

  private handleContextCompacted(notice: ContextCompactedNotification): void {
    const turn = this.currentTurn
    if (!turn) {
      if (notice.phase === 'start') {
        log(`session "${this.sessionName}": context compaction start with no current turn`)
        return
      }
      log(`session "${this.sessionName}": context compacted with no current turn`)
      void feishu.sendTextRaw(this.chatId, '🚨🚨🚨 CONTEXT COMPACTED / 上下文已压缩 🚨🚨🚨\n\nCodex 报告发生了上下文压缩,但当前没有可写的对话卡片。')
      return
    }
    this.stopThinkingFooter(turn)
    if (turn.currentAssistantSegmentId) this.finalizeCurrentAssistantSegment()
    turn.openReadBatchI = null
    this.maybeMidTurnRotate()
    if (notice.phase === 'start') {
      const i = turn.contextCompactCount++
      const key = compactionKey(notice)
      turn.contextCompactionPending.set(key, { i, cardId: turn.cardId, notice })
      const elementId = cards.ELEMENTS.contextCompact(i)
      log(`session "${this.sessionName}": context compaction start #${i + 1} key=${key}`)
      void cardkit.addElement(turn.cardId, cards.contextCompactionElement(i, notice, elementId), {
        type: 'insert_before',
        targetElementId: cards.ELEMENTS.footer,
      })
      cardkit.patchSummaryThrottled(turn.cardId, `🚨 压缩×${turn.contextCompactCount}`)
      return
    }
    const key = notice.itemId && turn.contextCompactionPending.has(notice.itemId)
      ? notice.itemId
      : latestPendingCompactionKey(turn)
    const pending = key ? turn.contextCompactionPending.get(key) : undefined
    if (key) turn.contextCompactionPending.delete(key)
    const merged = mergeCompactionNotices(pending?.notice, notice)
    const i = pending?.i ?? turn.contextCompactCount++
    const cardId = pending?.cardId ?? turn.cardId
    const elementId = cards.ELEMENTS.contextCompact(i)
    log(`session "${this.sessionName}": context compaction completed #${i + 1}${key ? ` key=${key}` : ''}`)
    if (pending) {
      void cardkit.replaceElement(cardId, elementId, cards.contextCompactionElement(i, merged, elementId))
    } else {
      void cardkit.addElement(cardId, cards.contextCompactionElement(i, merged, elementId), {
        type: 'insert_before',
        targetElementId: cards.ELEMENTS.footer,
      })
    }
    cardkit.patchSummaryThrottled(turn.cardId, `🚨 压缩×${turn.contextCompactCount}`)
  }

  private handleTurnPlanUpdated(update: TurnPlanUpdated): void {
    const turn = this.currentTurn
    if (!turn) {
      log(`session "${this.sessionName}": turn/plan/updated with no current turn`)
      return
    }
    this.stopThinkingFooter(turn)
    if (turn.currentAssistantSegmentId) this.finalizeCurrentAssistantSegment()
    turn.openReadBatchI = null
    if (!Array.isArray(update.plan)) {
      log(`session "${this.sessionName}": turn/plan/updated missing plan array`)
      turn.planSteps = []
    } else {
      turn.planSteps = update.plan.map(step => ({
        step: typeof step.step === 'string' && step.step ? step.step : 'MISS',
        status: typeof step.status === 'string' && step.status ? step.status : 'MISS',
      }))
    }
    turn.planExplanation = typeof update.explanation === 'string' ? update.explanation : null
    this.addPlanSnapshotOnCurrentTurn()
  }

  private handlePlanDelta(delta: PlanDelta): void {
    if (typeof delta.delta !== 'string' || !delta.delta) {
      log(`session "${this.sessionName}": item/plan/delta missing delta text`)
      return
    }
    if (typeof delta.itemId !== 'string' || !delta.itemId) {
      log(`session "${this.sessionName}": item/plan/delta missing itemId`)
    }
  }

  private handleThreadGoalUpdated(goal: ThreadGoal): void {
    if (!goal || typeof goal.objective !== 'string') {
      log(`session "${this.sessionName}": thread/goal/updated missing objective`)
      return
    }
    if (goal.tokenBudget != null && typeof goal.tokenBudget !== 'number') {
      log(`session "${this.sessionName}": thread/goal/updated invalid tokenBudget`)
    }
    const previousGoal = this.currentGoal
    const currentGoal: cards.ThreadGoal = {
      objective: goal.objective,
      status: typeof goal.status === 'string' && goal.status ? goal.status : 'MISS',
      tokenBudget: typeof goal.tokenBudget === 'number'
        ? goal.tokenBudget
        : goal.tokenBudget === null
          ? null
          : Number.NaN,
      tokensUsed: typeof goal.tokensUsed === 'number' ? goal.tokensUsed : Number.NaN,
      timeUsedSeconds: typeof goal.timeUsedSeconds === 'number' ? goal.timeUsedSeconds : Number.NaN,
    }
    this.currentGoal = currentGoal
    if (
      previousGoal &&
      cards.goalDisplaySignature(previousGoal) === cards.goalDisplaySignature(currentGoal)
    ) {
      return
    }
    const turn = this.currentTurn
    if (turn) {
      this.stopThinkingFooter(turn)
      if (turn.currentAssistantSegmentId) this.finalizeCurrentAssistantSegment()
      turn.openReadBatchI = null
    }
    this.addGoalUpdateOnCurrentTurn(currentGoal)
  }

  private handleThreadGoalCleared(): void {
    if (!this.currentGoal) return
    this.currentGoal = null
    const turn = this.currentTurn
    if (!turn) return
    this.stopThinkingFooter(turn)
    if (turn.currentAssistantSegmentId) this.finalizeCurrentAssistantSegment()
    turn.openReadBatchI = null
    this.addGoalClearedOnCurrentTurn()
  }

  private appendAssistant(delta: string): void {
    if (!this.currentTurn) return
    const turn = this.currentTurn
    // 第一条 assistant text_delta 到达 → footer 从 Thinking timer 切到
    // Working。后续 delta 跑时 thinking footer handle 已 null,stopThinkingFooter 短路。
    this.stopThinkingFooter(turn)
    if (!turn.currentAssistantSegmentId) {
      // New assistant segment opens a visual break — any prior Read run
      // is now visually separated from future Reads, so close the batch
      // window. Future Reads will start a fresh batch at a new i.
      turn.openReadBatchI = null
      // Pre-empt the "element exceeds the limit" 300305/300315 cliff —
      // if the card's element count is approaching Feishu's cap, fire-and-
      // forget kick off a mid-turn rotation onto a fresh card. The
      // *current* addElement still goes to turn.cardId (the old card)
      // and either fits within the headroom or fails silently; the
      // rotation handler resets turn state once the new card is up so
      // subsequent stream handlers see the new cardId.
      this.maybeMidTurnRotate()
      const i = turn.assistantSegmentCount++
      const segId = cards.ELEMENTS.assistant(i)
      turn.currentAssistantSegmentId = segId
      turn.currentAssistantText = ''
      void cardkit.addElement(turn.cardId, cards.assistantSegmentElement(i), {
        type: 'insert_before', targetElementId: cards.ELEMENTS.footer,
      }, () => {
        // 切新卡由 card-level onFailure(recordCardCreated 注册)统一触发。
        // 正在切卡(rotating)时绝不 reset:swap 会读当前 currentAssistantText
        // carry 到新卡,期间到达的 delta 要继续 append 到本段、一个不丢 —— reset
        // 会把它们截断。只有"没在切卡"(熔断后不再切的兜底)才 reset 段游标,
        // 让下个 delta 重建段,免得后续 streamText 全 PUT 到死 element。
        if (turn.rotating) return
        if (turn.currentAssistantSegmentId === segId) {
          log(`session "${this.sessionName}": assistant segment ${segId} addElement failed — will retry on next delta`)
          turn.currentAssistantSegmentId = null
          turn.currentAssistantText = ''
          turn.segmentTexts.delete(segId)
        }
      })
    }
    turn.currentAssistantText += delta
    const segId = turn.currentAssistantSegmentId
    if (!segId) return  // addElement 已失败 reset,等下一次 delta 重建
    turn.segmentTexts.set(segId, turn.currentAssistantText)
    this.processOutboundMarkers(turn.currentAssistantText)
    this.processHostAskMarkers(turn.currentAssistantText, turn)
    const displayText = this.cleanAssistantTextForDisplay(turn.currentAssistantText)
    cardkit.streamTextThrottled(turn.cardId, segId, displayText)
    // Chat-list preview: tail of the latest assistant text. Feishu
    // truncates anyway; ~60 chars is what shows on a typical phone
    // preview line. patchSummaryThrottled is rate-limited on its own.
    const tail = displayText.slice(-60)
    cardkit.patchSummaryThrottled(turn.cardId, tail)
  }

  /** 收尾当前 assistant 段:把流式 markdown 元素静态化成完整 markdown,
   * 然后清空段游标。这里不再 mid-turn 关开全卡 streaming_mode,避免
   * 客户端 typewriter 状态在 settings toggle 后回退或闪烁；也不再只做
   * /content 完整帧,因为后续工具/新段可能在客户端打字机追上前冻结该段。 */
  finalizeCurrentAssistantSegment(): void {
    const turn = this.currentTurn
    if (!turn) return
    // 正在切卡:别动当前段 —— rotate 会在 swap 时读 currentAssistantText carry
    // 到新卡续写。这里若定稿/reset,过渡窗口里的当前段文字会被清空、carry 落空
    // (跟 appendAssistant onFailure 在 rotating 期间不 reset 同一个道理)。代价是
    // 切卡窗口恰好跨 block 边界时两段可能并作一段 —— 不丢内容,可接受。
    if (turn.rotating) return
    const segId = turn.currentAssistantSegmentId
    const text = turn.currentAssistantText ?? ''
    if (segId && text.trim()) {
      void cardkit.staticizeMarkdownElement(
        turn.cardId,
        segId,
        staticAssistantElementId(segId),
        this.cleanAssistantTextForDisplay(text),
        cards.ELEMENTS.footer,
      )
    }
    turn.currentAssistantSegmentId = null
    turn.currentAssistantText = ''
  }

  /** 从一段文字里找完整 [[send: /abs/path]] 标记,一看到就立即发。正文保留
   * 原标记不改,让用户知道触发了哪个文件路径。 */
  private processOutboundMarkers(text: string): void {
    for (const path of extractSendMarkerPaths(text)) {
      this.sendOutboundPath(path, 'send marker')
    }
  }

  private processHostAskMarkers(text: string, turn: TurnState): void {
    for (const marker of extractAskUsrMarkers(text)) {
      if (turn.hostAskMarkersSeen.has(marker.raw)) continue
      turn.hostAskMarkersSeen.add(marker.raw)
      sessionHostAsk.queueHostAskFromMarker(this, marker.payload, marker.raw)
    }
  }

  private cleanAssistantTextForDisplay(text: string): string {
    return stripAskUsrMarkers(text, '\n\n_已发起澄清问题，请回答对应卡片。_')
  }

  sendOutboundPath(rawPath: string, source: string): void {
    const p = rawPath.trim()
    if (!p) return
    const turn = this.currentTurn
    if (turn?.outboundSeenPaths.has(p)) return
    turn?.outboundSeenPaths.add(p)
    if (!isAbsolute(p)) {
      log(`session "${this.sessionName}": ignore non-absolute outbound path from ${source}: ${p}`)
      return
    }
    turn?.outboundSentPaths.add(p)
    log(`session "${this.sessionName}": outbound send from ${source}: ${p}`)
    void feishu.uploadAndSend(this.chatId, p)
  }

  /** Start the footer thinking indicator. It lives in the stable footer
   * element instead of a throwaway top element; deleting that first live
   * element can make Feishu's typewriter drop the first assistant segment. */
  startThinkingFooter(turn: TurnState): void {
    if (turn.thinkingFooterHandle) return
    turn.thinkingFooterStartedAt = Date.now()
    const render = (): void => {
      if (turn.thinkingFooterHandle == null) return
      const elapsedS = Math.max(1, Math.floor((Date.now() - turn.thinkingFooterStartedAt) / 1000))
      void cardkit.streamText(
        turn.cardId,
        cards.ELEMENTS.footer,
        this.withModel(`${FOOTER_THINKING_PREFIX}(${elapsedS}s)`),
      )
    }
    turn.thinkingFooterHandle = setInterval(render, FOOTER_STATUS_TICK_MS)
    render()
  }

  /** Stop the thinking timer and leave the stable footer in working state.
   * There is deliberately no deleteElement here. */
  stopThinkingFooter(turn: TurnState | null): void {
    if (!turn || !turn.thinkingFooterHandle) return
    clearInterval(turn.thinkingFooterHandle)
    turn.thinkingFooterHandle = null
    turn.thinkingFooterStartedAt = 0
    void cardkit.streamTextThrottled(turn.cardId, cards.ELEMENTS.footer, this.withModel(FOOTER_WORKING))
  }

  private async closeTurnCard(
    suffix?: string,
    opts: { forcePush?: boolean; hasFreshResult?: boolean } = {},
  ): Promise<void> {
    // CRITICAL: capture-and-null in a single synchronous block at entry
    // so a parallel `closeTurnCard` (e.g. result event firing while
    // onUserMessage is awaiting an interrupt) can't double-process the
    // same turn — second caller observes null and bails. The promised
    // sync-handler invariant only protects callers that take the turn
    // off the table BEFORE their first await.
    const turn = this.currentTurn
    if (!turn) return
    this.currentTurn = null
    this.stopThinkingFooter(turn)
    const elapsed = ((Date.now() - turn.startedAt) / 1000).toFixed(1)
    const cardId = turn.cardId
    const segmentTexts = turn.segmentTexts
    await cardkit.flush(cardId)

    // [[send: /abs/path]] markers are handled mid-stream by
    // processOutboundMarkers(). closeTurnCard only finalizes text display.
    // 对**每个** assistant 段 replaceElement 成最终内容:这里 replaceElement
    // 的职责是把流式元素固化成静态 markdown。
    // "把没播完的打字机尾巴补全上屏"靠的是紧接其后的 streaming_mode=false
    // 全局收尾 —— 对仍在流式状态里的段,实测它会把每个流式文本组件的未上屏
    // 部分一次性 commit 到 replaceElement 设定的最终内容。中途 block_stop
    // 已经把多数段静态化,这里主要兜最后一段和异常时没静态化成功的段。
    for (const [segId, fullText] of segmentTexts) {
      // 收尾定稿:把流式最后一帧补成完整段。**保留 [[send:]] 标记原文显示**
      // (用户要求 2026-05-23:标签留着,让用户看到发了哪个文件)。replaceElement
      // 自身不触发流式 commit,真正全显靠紧随其后的 streaming_mode=false 全局收尾。
      await cardkit.replaceElement(cardId, segId, {
        tag: 'markdown',
        element_id: segId,
        content: this.cleanAssistantTextForDisplay(fullText).trim() || ' ',
      })
    }

    // thinking 区不再 collapse 成 panel —— replaceElement 会把 typewriter
    // 中段的内容整段换掉,飞书侧用户视觉上"中段消失"。partial 模式下
    // thinkingText 已经在 turn 期间真 streaming 进飞书,turn 结束保留
    // markdown 形态完整可见即可。代价是卡片会长一些,但比 typewriter
    // 被截好得多。
    // State marker leads the footer (✅ for natural completion, or the
    // suffix verbatim for non-natural states like `🛑 打断`). The
    // trailing "done" word is gone — the ✅ already carries that
    // meaning. User-confirmed footer order 2026-05-16.
    const stateMark = suffix ? suffix : '✅'
    // Footer line 1 keeps the terminal status compact. Usage-derived
    // numbers only render when a fresh SDK result landed for THIS turn;
    // interrupts/boot failures would otherwise show stale prior-turn data.
    const line1Parts = [`${stateMark} ⏱ ${elapsed}s`]
    if (opts.hasFreshResult) {
      const ctxTokens = this.currentContextTokens()
      const ctxMax = this.contextLimitForDisplay()
      const ctxPercent = cards.footerContextPercentLabel(ctxTokens, ctxMax)
      if (ctxPercent) line1Parts.push(`🧠 ${ctxPercent}`)
      const cost = this.lastTurnDelta?.costUsd ?? 0
      if (cost > 0) line1Parts.push(`💰 $${cost.toFixed(3)}`)
    }
    if (turn.contextCompactCount > 0) line1Parts.push(`🚨 压缩×${turn.contextCompactCount}`)
    if (turn.outboundSentPaths.size > 0) line1Parts.push(`📎 ${turn.outboundSentPaths.size}`)
    const modelLabel = this.modelLine()
    if (modelLabel) line1Parts.push(modelLabel)
    const footerLine1 = line1Parts.join(' ｜ ')
    const footerLine2 = opts.hasFreshResult
      ? cards.footerTokenDetailLine(this.lastTurnUsage)
      : ''
    const footer = footerLine2 ? `${footerLine1}\n${footerLine2}` : footerLine1
    await cardkit.streamText(cardId, cards.ELEMENTS.footer, footer)
    // Final chat-list preview: clean finish shows "⏱ Xs · NK tokens";
    // interrupted shows the suffix instead (no usage event landed).
    // cancelSummary kills any in-flight throttled write so a stale
    // mid-stream tail can't clobber this terminal summary.
    cardkit.cancelSummary(cardId)
    await cardkit.patchSettings(cardId, cards.streamingOffSettings({
      durationSec: elapsed,
      outputTokens: opts.hasFreshResult ? this.lastTurnUsage?.output_tokens : undefined,
      suffix,
    }))
    await cardkit.dispose(cardId)

    // Phone push on clean turn close so the user knows Codex is done
    // even with the chat backgrounded. Skip on interrupts (no real
    // completion), when we don't know who to ping, and when the turn
    // wasn't kicked off by the user typing a message. `opts.forcePush`
    // overrides the suffix-gate for the
    // "consecutive SDK errors, giving up" case — that close has a non-
    // empty suffix but the user still needs to know we bailed.
    // Fire-and-forget; urgent_app failures are non-fatal and already
    // logged in feishu.ts.
    if ((opts.forcePush || !suffix) && turn.userOpenId && turn.messageId) {
      void feishu.urgentApp(turn.messageId, [turn.userOpenId])
    }

    // Release the OneSecond reactions on every queued Feishu message
    // this turn was responsible for. Two buckets:
    //   1. `currentBatchReactionIds` — msgs the init handler explicitly
    //      claimed (SDK dequeued them as a merged next-turn batch).
    //   2. `pendingReactionIds` — msgs whose fate is invisible to the
    //      daemon: the SDK either dequeued them as part of the
    //      JUST-CLOSED turn OR injected them mid-turn as
    //      `<system-reminder>` and silently removed them from the
    //      queue (common when the current turn had tool calls).
    //      Without visibility into queue-operation events the daemon
    //      can't tell which; the safe default is "the prior turn just
    //      ended, so the msg is at least *acknowledged* now —
    //      release the OneSecond and let it stop saying 'queued',
    //      instead of leaving it stuck permanently."
    //      For merged-batch follow-ups, this releases slightly early
    //      (before the merged turn actually runs), which is an
    //      acceptable trade vs. msgs stuck under OneSecond forever.
    const releaseEntries = [
      ...this.currentBatchReactionIds.entries(),
      ...this.pendingReactionIds.entries(),
    ]
    if (releaseEntries.length > 0) {
      for (const [msgId, rid] of releaseEntries) {
        if (rid) void feishu.deleteReaction(msgId, rid)
      }
      this.currentBatchReactionIds = new Map()
      this.pendingReactionIds = new Map()
    }
  }
}
