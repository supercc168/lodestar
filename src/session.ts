/**
 * Session — 1 Feishu chat ↔ 1 Claude headless process ↔ 1 streaming card.
 *
 * Owns the ClaudeProcess lifecycle, the per-turn card state machine, and
 * the in-flight permission map.  Wires Claude's stdout events into Card
 * Kit ops, and wires Feishu inbound (text + card-action callbacks) into
 * Claude's stdin.
 *
 * Tool tracking, AskUserQuestion flow, and permission rendering live in
 * sibling modules (session-tools.ts, session-ask.ts,
 * session-permission.ts) so this file stays under Claude Code's
 * per-read token budget (~25K). Fields touched by those helpers carry
 * no `private` modifier — convention is "no modifier = package-internal,
 * only the session-*.ts helpers should touch it."
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ClaudeProcess, type CanUseToolRequest, type HookCallbackRequest, type ClaudeUsage } from './claude-process'
import { CHANNEL_INSTRUCTIONS } from './instructions'
import * as cardkit from './cardkit'
import * as cards from './cards'
import * as feishu from './feishu'
import { log } from './log'
import { readSysInfo } from './sysinfo'
import { readUsage, type UsageSnapshot } from './usage'
import { listSchedules } from './schedule'
import type { TurnState, Status, SessionOpts, LastTurnDelta, CumStats } from './session-types'
import * as sessionTools from './session-tools'
import * as sessionAsk from './session-ask'
import * as sessionPermission from './session-permission'

export type { SessionOpts } from './session-types'

const SEND_MARKER_RE = /\[\[send:\s*([^\]\n]+?)\s*\]\]/g

/** "模型还在干活" 顶部 ticker 的备选动词。turn 起来时随机选一个、整 turn
 * 固定不变,setInterval 每 TICKER_TICK_MS (1s) 跑一次,只刷经过秒数 ——
 * 比让 verb 轮播视觉更稳。opus-4-7 上 extended thinking 走 redacted、
 * 客户端拿不到明文 thinking,这个 ticker 就是 redacted-thinking 阶段
 * 唯一的活体信号。 */
const TICKER_VERBS = [
  '🤔 推敲',
  '💭 琢磨',
  '🧐 端详',
  '🔍 钻研',
  '✨ 构思',
  '🧠 凝神',
  '📐 推演',
  '🎯 锁定',
]
const TICKER_TICK_MS = 1000

/** Soft cap on element count per Feishu card before we proactively
 * rotate to a fresh one. The hard ceiling is ~100 (Feishu rejects
 * additional `POST /elements` with code=300305/300315 once a card has
 * ~100 elements); rotating at 80 keeps a 20% headroom for in-flight
 * stream handlers that already chose the old cardId before this check
 * fired (cardkit's per-card queue may still drain a few more adds onto
 * the soft-closed card before turn.cardId swap takes effect). */
const CARD_ELEMENT_SOFT_LIMIT = 80

export class Session {
  /** Process-wide registry of every Session ever constructed in this daemon.
   * Used by the `hi` console panel to enumerate sibling sessions across
   * Feishu groups. Sessions are never removed (matches the daemon's
   * `sessions` map lifecycle — one Session per chat for the daemon's
   * lifetime). Callers should filter on `isRunning()` when they only
   * want currently-alive Claude processes. */
  static readonly all: Set<Session> = new Set()

  // ── package-internal state (touched by session-*.ts helpers) ──
  proc: ClaudeProcess | null = null
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
  /** Local mirror of the SDK's task list — built incrementally from
   * TaskCreate / TaskUpdate input+output pairs and rendered as a footer
   * on every Task* panel. Lives for the lifetime of the Session
   * instance; daemon restart wipes it (the SDK doesn't replay history).
   * Not authoritative — Claude calling TaskList is still the source of
   * truth; this mirror is purely for the panel readout. */
  currentTodos = new Map<number, cards.Todo>()
  /** SDK 偶尔在 turn 的最后一项是 tool_result(is_error=true) 或已答完
   * AskUserQuestion 时直接 end_turn 不让模型 followup。
   * set 点 + reason:
   *   'ask'        — session-ask.finalizeAsk(AskUserQuestion 答完)
   *   'tool_error' — tool_result(is_error=true) handler(Edit/Read/Bash 失败)
   * clear 点: assistant_text / tool_use handler 入口(模型还在动就归零)
   *   —— tool_result(is_error=false) 不清,SDK 自己合成的 AskUserQuestion
   *   tool_result 不算 followup 证据。
   * result handler 看到 flag 仍非 null → sendUserText('继续') 续 turn,
   * banner / footer 文案按 reason 区分 —— 用户能直接读出来 turn 是
   * 因为"答完没下文"还是"工具出错异常终止"被自动续的。
   * 一次性,result 里读完即 reset。 */
  awaitingFollowup: 'ask' | 'tool_error' | null = null
  status: Status = 'stopped'

  // ── strictly private state ──
  /** Count of user messages we've written to Claude's stdin since the last
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
   * the trailing batch as user-batch (not a scheduled wakeup).
   * Distinguishes user-msg turns from cron-fired scheduled
   * wakeups: count > 0 ⇒ user; count === 0 ⇒ scheduled (and
   * `initCount > 1`). */
  private pendingUserMessageCount = 0
  /** Mid-turn user messages buffered DAEMON-SIDE (not yet sendUserText'd
   * to the SDK). Drained in the `result` handler by writing each to SDK
   * stdin, which doubles as the `priority="now"` wake signal the SDK
   * polling loop needs to start the next batch turn (the SDK won't
   * auto-dequeue queued type-ahead msgs after `result` — confirmed via
   * claude-code issue #39632). Buffering also keeps mid-turn msgs out
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
   * to clear (via deleteReaction). Empty for eager-opened solo turns
   * and for scheduled wakeups (no user messages went into those). */
  private currentBatchReactionIds = new Map<string, string>()
  /** Count of `system/init` events seen this subprocess. The first one is
   * the boot init (claimed by whichever user message lands first); all
   * subsequent ones mark the start of an SDK-initiated turn (queued
   * user message draining or a CronCreate fire). Reset on stop/restart/exit
   * since `init` re-fires after every spawn. */
  private initCount = 0
  /** Sync guard set before any `await` in the eager-open path of
   * `onUserMessage`, cleared after `currentTurn` is set. Closes the race
   * where an SDK-emitted `init` event lands during the eager open's
   * Feishu API await — without this, the init handler would observe
   * `currentTurn === null && queue empty` (we've already shifted) and
   * incorrectly open a *second* scheduled card for the same user
   * message. The flag tells the init handler "an eager open is already
   * claiming the slot, stand down". */
  private openingTurn = false
  private turnCounter = 0
  /** Consecutive SDK error turns since the last `success`. When the SDK
   * closes a turn with `subtype !== 'success'` (error_during_execution /
   * error_max_turns), the daemon swallows the phone push and re-pokes
   * the SDK with a "继续" user message to auto-resume. Two errors in a
   * row → give up: surface the failure (⛔ footer + forced phone push)
   * and reset. Any natural-success turn OR user intervention
   * (mid-turn buffer drain) resets this back to 0. */
  private consecutiveErrors = 0
  /** 让 result handler 把"下一个 turn 不是普通 user_message"这件事透传
   * 给 init handler / openTurnCard。当前只用于 SDK error 的 autoRetry
   * 路径 —— sendUserText('继续') 触发的下一 init,daemon 这边知道这是
   * 续 turn 而不是真用户消息,openTurnCard 用 'auto_retry' kind 出
   * `🔁 SDK 错误自动续` banner、不渲染 "📥 收到" panel。一次性使用,
   * 决定 trigger 后立即 reset null。 */
  private nextOpenKind: 'auto_retry' | 'no_followup_retry' | 'tool_error_retry' | null = null
  /** One-shot: user invoked `stop` during the current turn. Set right
   * before `sendInterrupt`; consumed by the next `result` handler to
   * short-circuit the autoRetry branch. Without this, the SDK's post-
   * interrupt result (typically `is_error:true subtype:error_during_execution`)
   * falls into `isError && !hasMidTurn` and the daemon helpfully
   * sendUserText('继续') + opens a fresh card stamped `🔁 SDK 错误自动续`
   * — exactly the thing the user explicitly told us to stop. The 🛑 打断
   * footer was already painted by the stop case's own closeTurnCard,
   * so this just suppresses the follow-up retry. Reset by exit handler
   * for the proc-died-before-result case. */
  private userInterrupted = false
  // Last seen sessionId — preserved across `kill`/`stop` so a later
  // `restart` can resume the same Claude conversation even after the
  // child process is gone.
  private lastSessionId: string | null = null
  private startedAt: number = 0
  private cumStats: CumStats = { tokens: 0, costUsd: 0, turns: 0 }
  private lastTurnDelta: LastTurnDelta | null = null

  constructor(
    public readonly sessionName: string,
    public readonly chatId: string,
    private opts: SessionOpts = {},
  ) {
    Session.all.add(this)
    // Restore last-known claude session_id from disk so a daemon restart
    // (systemctl, crash, watchdog) doesn't strand the user with a fresh
    // conversation when they next type `restart`.
    this.lastSessionId = feishu.getSessionResume(sessionName)
    if (this.lastSessionId) {
      log(`session "${sessionName}": restored lastSessionId=${this.lastSessionId.slice(0, 8)}…`)
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

  // ── Lifecycle ──────────────────────────────────────────────────────
  async start(): Promise<boolean> {
    if (this.isRunning()) return true
    if (!feishu.isAnthropicAuthenticated()) {
      await feishu.sendText(this.chatId, '❌ Claude 未登录 Anthropic 账号。\n请在服务器上运行 `claude auth login` 后再试。')
      return false
    }
    if (!existsSync(this.workDir)) {
      await feishu.sendText(this.chatId, `🆕 目录 ~/${this.sessionName} 不存在，正在创建…`)
      try { feishu.provisionProject(this.workDir) }
      catch (e) {
        await feishu.sendText(this.chatId, `❌ 创建项目失败: ${e}`)
        return false
      }
    }

    this.status = 'starting'
    this.proc = new ClaudeProcess({
      workDir: this.workDir,
      effort: 'max',
      permissionMode: this.opts.permissionMode ?? 'bypassPermissions',
      appendSystemPrompt: CHANNEL_INSTRUCTIONS,
    })
    this.wireProc(this.proc)
    this.proc.sendInitialize({})
    // 等 `system/init` 落地再认定 ready —— sendInitialize 只把 RPC
    // 写进 stdin,Claude 回包之前 proc.sessionId 还是 null,这时候
    // showConsole() 看到 null 会 fallback 到磁盘上**上一次**会话的
    // lastSessionId,面板就把陈年 session_id 当成"当前会话"贴出去,
    // model / usage / contextWindow 也都没值。等 init 之后再返回,
    // 后续 `hi`、首条 user message 都能拿到真值。5s 兜底,init 真
    // 没来也不死循环。
    await new Promise<void>(resolve => {
      const proc = this.proc!
      const timer = setTimeout(() => {
        proc.off('init', onInit)
        log(`session "${this.sessionName}": init wait timeout (5s) — proceeding`)
        resolve()
      }, 5000)
      const onInit = () => { clearTimeout(timer); resolve() }
      proc.once('init', onInit)
    })

    await feishu.sendText(this.chatId, `✅ Lodestar session "${this.sessionName}" 已就绪，发消息开始对话。`)
    this.status = 'idle'
    this.startedAt = Date.now()
    return true
  }

  /** Drop every ⏳ OneSecond reaction this session is currently holding
   * on user chat messages, then empty the two tracking maps. Used by
   * every tear-down path (proc exit, kill, restart) so reactions don't
   * outlive the conversation that placed them — without this, a Claude
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

  async stop(reason = '已终止'): Promise<void> {
    if (!this.proc) {
      this.status = 'stopped'
      await feishu.sendText(this.chatId, `⚪ session "${this.sessionName}" 当前未运行`)
      return
    }
    // Flip lifecycle state SYNCHRONOUSLY before awaiting kill — daemon's
    // SIGTERM cleanup snapshots `isRunning()` and if we're still mid-
    // `proc.kill()` await it'll see proc!=null and write us into the
    // alive marker, which makes the next boot auto-revive a session
    // the user explicitly killed. Reordering the null-out fixes that
    // race (bug observed 2026-05-15: `kill` immediately followed by
    // `systemctl restart` revived the killed session on boot).
    log(`session "${this.sessionName}": stop (${reason})`)
    const proc = this.proc
    this.lastSessionId = proc.sessionId ?? this.lastSessionId
    this.proc = null
    this.stopTicker(this.currentTurn)
    this.currentTurn = null
    this.pendingUserMessageCount = 0
    this.pendingMidTurnMsgs = []
    this.pendingTurnInputs = []
    this.nextOpenKind = null
    this.lastUserOpenId = ''
    this.releaseAllReactions()
    this.initCount = 0
    this.openingTurn = false
    this.pendingPermissions.clear()
    this.consecutiveErrors = 0
    this.awaitingFollowup = null
    this.status = 'stopped'
    await proc.kill()
    await feishu.sendText(this.chatId, `🔴 ${reason} (session: ${this.sessionName})`)
  }

  async restart(resume = false): Promise<void> {
    const prevSessionId = this.proc?.sessionId ?? this.lastSessionId
    if (this.proc) {
      this.lastSessionId = this.proc.sessionId ?? this.lastSessionId
      await this.proc.kill()
      this.proc = null
    }
    this.stopTicker(this.currentTurn)
    this.currentTurn = null
    this.pendingUserMessageCount = 0
    this.pendingMidTurnMsgs = []
    this.pendingTurnInputs = []
    this.nextOpenKind = null
    this.lastUserOpenId = ''
    this.releaseAllReactions()
    this.initCount = 0
    this.openingTurn = false
    this.pendingPermissions.clear()
    this.consecutiveErrors = 0
    this.awaitingFollowup = null
    if (resume && prevSessionId) {
      this.proc = new ClaudeProcess({
        workDir: this.workDir,
        effort: 'max',
        permissionMode: this.opts.permissionMode ?? 'bypassPermissions',
        resumeSessionId: prevSessionId,
        appendSystemPrompt: CHANNEL_INSTRUCTIONS,
      })
      this.wireProc(this.proc)
      this.proc.sendInitialize({})
      this.status = 'idle'
      this.startedAt = Date.now()
      await feishu.sendText(this.chatId, `🔁 已重启并恢复 session=${prevSessionId.slice(0, 8)}…`)
    } else {
      // Resume requested but no prior session_id on file — surface it
      // explicitly rather than silently fresh-starting (the old behavior
      // hid the daemon-restart sessionId-loss bug for months).
      if (resume) {
        await feishu.sendText(this.chatId, '⚠️ 没有可恢复的上一会话，将以新会话启动')
      }
      // Fresh conversation — drop cumulative stats so the next `hi` shows
      // zeroed counters instead of bleeding numbers from the prior chat.
      this.cumStats = { tokens: 0, costUsd: 0, turns: 0 }
      this.lastTurnDelta = null
      await this.start()
    }
  }

  /** Run a bare-text control command (`hi`, `stop`, `kill`, `restart`, `clear`).
   * Returns true if the command was consumed (don't forward to Claude).
   * Exact match, case-insensitive, ignores trailing whitespace.
   *
   * Trade-off (user-confirmed 2026-05-15): these words are reserved
   * globally — typing "hi" as a literal greeting will show the console
   * card instead of reaching Claude. The ergonomic win (no slash, no
   * shift key, one-handed phone use) outweighs the collision in this
   * product's private-bot use case. `stop` was added 2026-05-15 once
   * auto-interrupt on mid-turn user messages was removed (matching
   * claude-code's native type-ahead behavior) — explicit barge-out
   * needed a knob and `kill` (full subprocess teardown) is too heavy. */
  async runCommand(raw: string): Promise<boolean> {
    switch (raw.trim().toLowerCase()) {
      case 'hi':
        if (!this.isRunning()) {
          const ok = await this.start()
          if (!ok) return true
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
          await feishu.sendText(this.chatId, '⚪ 当前没有正在执行的 turn')
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
        this.nextOpenKind = null
        this.lastUserOpenId = ''
        this.pendingReactionIds = new Map()
        this.currentBatchReactionIds = new Map()
        // Tag the imminent SDK `result` (which DOES arrive after sendInterrupt
        // with is_error:true subtype:error_during_execution — the comment
        // below was wrong) so the result handler doesn't read it as a real
        // SDK failure and helpfully autoRetry into `🔁 SDK 错误自动续`. Must
        // be set BEFORE sendInterrupt — the result can land on the next tick.
        this.userInterrupted = true
        this.awaitingFollowup = null
        this.consecutiveErrors = 0
        this.interrupt()
        // 主动封口,把 footer 改成 🛑 打断、折叠 thinking、把 streaming_mode
        // 翻回 false,否则卡片会僵在 `⏳ working…`。SDK 的 post-interrupt
        // result 也会进 closeTurnCard,但 currentTurn 已被这里置空,那条
        // 路径会 early-return,不会重画 footer。
        await this.closeTurnCard('🛑 打断')
        return true
      case 'kill':
        await this.stop()
        return true
      case 'restart':
        // resume the prior conversation — kills the current proc (if
        // any) and spawns a new one with `--resume <lastSessionId>`.
        // If no process is running, this is how the user gets back the
        // previous conversation after a `kill` or a daemon crash.
        await this.restart(true)
        return true
      case 'clear':
        // "throw away current conversation, start a new one". By design
        // this only makes sense when there IS a current conversation:
        // calling clear from stopped state is a no-op (user-confirmed
        // 2026-05-16) — we don't want a stray `clear` to silently spawn
        // a fresh session the user didn't ask for. To start from cold,
        // use `hi`.
        if (!this.isRunning()) {
          await feishu.sendText(this.chatId, `⚪ session "${this.sessionName}" 当前未运行,clear 无效;用 \`hi\` 启动或 \`restart\` 恢复上一会话`)
          return true
        }
        await this.restart(false)
        return true
    }
    return false
  }

  /** Build the hi-panel card object for this session.
   *
   * Pulled out of `showConsole` so callback handlers (e.g. schedule
   * delete / toggle-mode buttons) can re-render the panel in place via
   * `update_multi: true` without having to send a fresh message. Passing
   * `usage=undefined` paints the `_加载中…_` placeholder — the caller is
   * responsible for the async patch if the panel was sent (not just
   * returned in a callback response). */
  async buildConsoleCard(usage: UsageSnapshot | undefined): Promise<object> {
    const uptimeMs = this.startedAt ? (Date.now() - this.startedAt) : undefined
    const rawModel = this.proc?.lastModel ?? null
    const model = rawModel ? rawModel.replace(/^claude-/, '') : undefined
    const sysinfo = await readSysInfo()
    return cards.consoleCard({
      sessionName: this.sessionName,
      status: this.status,
      model,
      effort: 'max',
      uptimeMs,
      peers: [...Session.all]
        .filter(s => s.isRunning())
        .map(s => ({ ...s.peerSnapshot(), isCurrent: s === this })),
      usage,
      contextTokens: this.currentContextTokens(),
      contextLimit: this.contextWindowMax(),
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
      // List ALL schedules across every project — hi panel is a global
      // dashboard. Each panel shows its `project` so the user can tell
      // them apart; the buttons (toggle / delete) also operate
      // cross-project, no per-session scoping. The MCP path (claude
      // invoking schedule_create/delete from inside a chat) still
      // scopes by project — that's a different attack surface (claude
      // running with arbitrary prompts inside one group shouldn't be
      // able to nuke another group's schedules), while the hi card is
      // operator-only (only humans in your bound groups can press the
      // button).
      schedules: listSchedules(),
    })
  }

  async showConsole(): Promise<void> {
    // Initial paint without usage → cards.ts renders the
    // `_加载中…_` placeholder in the consoleUsage element. We patch
    // it in below once readUsage() resolves (ccusage cold-call is
    // ~5s; not worth blocking the panel on it).
    const card = await this.buildConsoleCard(undefined)
    const messageId = await feishu.sendCard(this.chatId, card)
    if (!messageId) return
    // Patch the usage element asynchronously so the rest of the panel
    // stays responsive. We don't await; failures are logged and the
    // placeholder stays visible (no fallback fabrication).
    void (async () => {
      try {
        const cardId = await cardkit.convertMessageToCard(messageId)
        const usage = await readUsage()
        await cardkit.replaceElement(cardId, cards.ELEMENTS.consoleUsage, {
          tag: 'markdown',
          element_id: cards.ELEMENTS.consoleUsage,
          content: cards.consoleUsageContent(usage),
        })
      } catch (e) { log(`session "${this.sessionName}": consoleUsage patch failed: ${e}`) }
    })()
  }

  interrupt(): void {
    if (!this.proc) return
    log(`session "${this.sessionName}": interrupt`)
    this.proc.sendInterrupt()
  }

  // ── Inbound from Feishu ────────────────────────────────────────────
  /** Inbound user message. Always writes to Claude's stdin immediately —
   * the SDK queues internally if a turn is in flight (FIFO, exactly the
   * type-ahead semantics of the native claude-code REPL). Card opening:
   *   - First msg of session OR no turn in flight  → open card eagerly here
   *   - Mid-flight msg                              → defer; the `init`
   *     handler opens its card when the SDK actually starts the turn
   * This is what lets a single subprocess host both user-typed turns and
   * cron-fired wakeups without the daemon ever calling `sendInterrupt` —
   * `kill`/`stop` are the only paths that interrupt now. */
  async onUserMessage(text: string, files: string[] = [], userOpenId = '', msgId = ''): Promise<void> {
    if (!this.isRunning()) {
      const ok = await this.start()
      if (!ok) return
    }
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
    // wasBusy computation — otherwise this fresh solo message gets
    // falsely wrapped `<u>…</u>` and its card closes with
    // `📨 转交新卡` instead of `✅`.
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
    // check, the daemon would mark it as solo (no `<u>` wrap, no ⏳
    // reaction) and the model would see e.g. "123" + "321" + "1"
    // glued into a single string "1233211" (2026-05-16 accumulator
    // bug).
    const wasBusy = this.currentTurn !== null || this.openingTurn
      || this.pendingUserMessageCount > 0 || this.pendingMidTurnMsgs.length > 0
    this.lastUserOpenId = userOpenId
    // When the SDK will merge this msg with siblings into a multi-
    // content user turn, wrap it in `<u>...</u>` so the model sees a
    // structural boundary it actually attends to. Tried U+001E
    // (ASCII Record Separator) first — invisible and theoretically
    // perfect, but Anthropic's tokenizer effectively drops control
    // chars and `<u>1</u><u>45</u>` became "145" to the model
    // (2026-05-16 accumulator test). HTML-tag wrap is visible but
    // models parse `<tag>` boundaries very reliably from training.
    // Only the very first solo message of a fresh SDK turn slot
    // skips the wrap — no sibling, no merge, no need. Contract
    // declared in CHANNEL_INSTRUCTIONS.
    //
    // File hint **inline 在 wireText 内部**,而不是依赖 sendUserText 把
    // files 拼到 message 整体头部。原因:drainMidTurnAndOpen merge N 条
    // wireText 时,若 files 还按整体拼接 → 所有 file hint 全堆在 long
    // message 开头、N 个 `<u>...</u>` 在后面,模型分不清哪个文件配哪条
    // (P1-1 02:22 现场实证)。inline 后每条 sub-message 自带 file hint,
    // SDK side 所有 sendUserText 调用 files 一律传空。
    const filePrefix = files.length ? files.map(f => `[file: ${f}]`).join(' ') + '\n' : ''
    const body = filePrefix + text
    const wireText = wasBusy ? `<u>${body}</u>` : body

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

    if (this.currentTurn !== null) {
      // Mid-turn — BUFFER instead of immediate sendUserText. The SDK polling
      // loop will not auto-dequeue queued type-ahead msgs after `result`
      // (only `priority="now"` writes wake it — claude-code issue #39632),
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
        // 真用户消息覆盖 autoRetry 意图 —— autoRetry 设的 nextOpenKind
        // 在 SDK init 还没回来时被这条 eager-open 抢先开 turn,init handler
        // 后续看到 currentTurn!=null 直接 return 不会消费 nextOpenKind,
        // 不 reset 会 leak 到下下个 turn 错 stamp '🔁 SDK 错误自动续'。
        this.nextOpenKind = null
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
    //      等 SDK init#1。两种情况下继续直接 sendUserText 都会让 SDK
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

  onAskMessageAnswer(text: string, user: string): Promise<void> {
    return sessionAsk.onAskMessageAnswer(this, text, user)
  }

  onAskAnswer(toolUseId: string, questionIdx: number, optionIdx: number, user: string): Promise<void> {
    return sessionAsk.onAskAnswer(this, toolUseId, questionIdx, optionIdx, user)
  }

  onAskCustomAnswer(toolUseId: string, questionIdx: number, customText: string, user: string): Promise<void> {
    return sessionAsk.onAskCustomAnswer(this, toolUseId, questionIdx, customText, user)
  }

  onPermissionDecision(requestId: string, decision: 'allow' | 'allow_always' | 'deny', user: string): Promise<void> {
    return sessionPermission.onPermissionDecision(this, requestId, decision, user)
  }

  // ── Wiring Claude → Feishu ─────────────────────────────────────────
  private wireProc(p: ClaudeProcess): void {
    p.on('init', () => {
      // Persist the freshly assigned session_id so a later daemon
      // restart can resume this conversation. Skip if unchanged to
      // avoid hammering the file on every init for resumed sessions.
      if (p.sessionId && p.sessionId !== this.lastSessionId) {
        this.lastSessionId = p.sessionId
        feishu.bindSessionResume(this.sessionName, p.sessionId)
      }
      this.initCount++
      log(`session "${this.sessionName}": SDK init#${this.initCount} pendingCount=${this.pendingUserMessageCount} midBuffer=${this.pendingMidTurnMsgs.length} currentTurn=${this.currentTurn ? 'yes' : 'no'} openingTurn=${this.openingTurn}`)

      // Boot init (initCount === 1) is claimed by `onUserMessage`'s
      // eager-open path — if a user message landed before the init
      // arrived, it sits in `pendingUserMessageCount` and we drain it
      // below; otherwise the init opens nothing. Subsequent inits
      // (initCount >= 2) mark the start of an SDK-initiated turn:
      // either the SDK is draining the type-ahead queue we fed it via
      // `sendUserText` (isUserBatch), or it's a CronCreate /
      // ScheduleWakeup fire from idle (isScheduledFire).
      //
      // SDK-driven rotation puts the boundary HERE: the previous
      // turn's `result` already closed the in-flight card with
      // `📨 转交新卡` (because pendingUserMessageCount > 0). Now we
      // open a fresh card whose top panel shows the queued messages.
      // currentTurn should be null at this point (result null'd it);
      // the openingTurn guard catches the eager-open vs init race.
      if (this.currentTurn || this.openingTurn) return
      const isUserBatch = this.pendingUserMessageCount > 0
      const isScheduledFire = !isUserBatch && this.initCount > 1
      if (!isUserBatch && !isScheduledFire) return
      // nextOpenKind 优先(目前只有 autoRetry 路径会设)。autoRetry 自己
      // sendUserText('继续') + pendingCount++,所以 isUserBatch=true,但
      // 我们要它出 `🔁 SDK 错误自动续` banner 而不是普通 user_message —
      // 用 nextOpenKind 顶替。一次性,决定 trigger 后立即 reset。
      const trigger: 'user_message' | 'scheduled' | 'auto_retry' | 'no_followup_retry' | 'tool_error_retry' =
        this.nextOpenKind ?? (isUserBatch ? 'user_message' : 'scheduled')
      this.nextOpenKind = null
      // auto_retry 继承 lastUserOpenId(原 sender),让最终 success push
      // 还能找到要 phone-notify 谁。scheduled 没 sender,留空。
      const userOpenId = trigger === 'scheduled' ? '' : this.lastUserOpenId
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
          await this.openTurnCard(userOpenId, trigger)
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
    p.on('assistant_text', ({ text }: { text: string }) => {
      // 模型在说话 → 清 followup flag。如果上一项是 tool_result(error) 或
      // 已答完的 AskUserQuestion 留下的 flag,模型现在接上话/解释了,daemon
      // 不需要兜底 poke。
      this.awaitingFollowup = null
      this.appendAssistant(text)
    })
    p.on('tool_use', ({ id, name, input }: { id: string; name: string; input: any }) => {
      // 模型在出新工具 → 同样清 flag(典型场景:Edit 失败后模型自己重试)。
      this.awaitingFollowup = null
      sessionTools.addTool(this, id, name, input)
    })
    p.on('tool_result', ({ tool_use_id, content, is_error }: any) => {
      // 仅在工具失败时举 flag —— 工具成功时模型选择 end_turn 是合法行为
      // (悄悄改完文件直接退),不该被 daemon 续。AskUserQuestion 的 SDK 合成
      // tool_result (is_error=false) 走这条路也命中"不动 flag",finalizeAsk
      // 早已把 flag set 成 true,正好保留到 result 里被检测。
      if (is_error) this.awaitingFollowup = 'tool_error'
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
      // turn after sendInterrupt landed (subtype=error_during_execution,
      // is_error=true). The card already shows `🛑 打断` from the stop
      // case's closeTurnCard. Skip the rest unconditionally: NO suffix
      // overwrite, NO consecutiveErrors bump, NO sendUserText('继续'),
      // NO nextOpenKind='auto_retry'. One-shot, read+reset.
      if (this.userInterrupted) {
        this.userInterrupted = false
        const subtype = this.proc?.lastResult.subtype ?? 'unknown'
        const isError = this.proc?.lastResult.is_error === true
        log(`session "${this.sessionName}": SDK result after user stop subtype=${subtype} isError=${isError} — suppress autoRetry`)
        this.status = 'idle'
        return
      }
      // Three orthogonal signals fold into one footer suffix + push/retry
      // decision here:
      //   1. `pendingMidTurnMsgs` — user typed during the turn; their
      //      messages need a fresh card and SDK wake-up. Takes priority
      //      over auto-retry (user is back at the keyboard).
      //   2. `lastResult.is_error` — SDK closed the turn with a non-
      //      `success` subtype (error_during_execution / error_max_turns).
      //      First occurrence: swallow the phone push, re-poke SDK with
      //      "继续" to auto-resume. Second consecutive: give up,
      //      ⛔ footer + force phone push so the user knows.
      //   3. Natural success — `✅` footer, normal phone push, reset
      //      consecutiveErrors.
      // closeTurnCard's default push-on-clean-close stays the floor;
      // `forcePush:true` is the override for the "we hit retry ceiling"
      // case (which has a non-empty suffix and would otherwise be silent).
      const hasMidTurn = this.pendingMidTurnMsgs.length > 0
      const isError = this.proc?.lastResult.is_error === true
      const subtype = this.proc?.lastResult.subtype ?? 'success'
      // turn 收尾时如果还举着 followup flag,意味着 turn 的最后一项是
      // tool_result(is_error) 或已答完的 AskUserQuestion,但模型没继续
      // 推理就 end_turn(success)。SDK bug 兜底 —— daemon 帮 poke 一下。
      // 一次性,读完即 reset,不会延续到下一 turn。优先级:hasMidTurn /
      // isError 都更高(用户介入或真错误时不走这条),所以这里只看
      // success 路径。
      // Snapshot reason 后再清:下面 suffix / nextOpenKind 都要按 reason 出
      // 不同文案("答完没下文" vs "工具出错异常终止"),用户能直接读出
      // turn 是因为哪个原因被自动续的。reset 在 snapshot 之后,保证一次性。
      const followupReason = this.awaitingFollowup
      this.awaitingFollowup = null
      const noFollowupRetry = !hasMidTurn && !isError && followupReason !== null

      let suffix: string | undefined
      let autoRetry = false
      let forcePush = false

      if (hasMidTurn) {
        // User intervention wins over auto-retry — they're actively
        // sending new input, no point also auto-poking the SDK.
        this.consecutiveErrors = 0
        suffix = isError ? `⚠️ SDK ${subtype},用户已介入` : '📨 转交新卡'
      } else if (isError) {
        this.consecutiveErrors++
        if (this.consecutiveErrors >= 2) {
          suffix = `⛔ SDK 连续报错 (${subtype}),已停止`
          forcePush = true
          this.consecutiveErrors = 0
        } else {
          suffix = `⚠️ SDK ${subtype},自动续 turn…`
          autoRetry = true
        }
      } else if (noFollowupRetry) {
        // 不计 consecutiveErrors —— 这不是真错,是 SDK 漏续的兜底。下一轮
        // flag 已 reset,如果模型这次仍不接续(罕见),要么再走 AskUserQuestion
        // 流程重新 set flag,要么 turn 是空 result/真错误,都不会无限循环。
        this.consecutiveErrors = 0
        suffix = followupReason === 'tool_error'
          ? '⚠️ 工具出错异常终止,自动续…'
          : '⚠️ 答完没下文,自动续…'
        autoRetry = true
      } else {
        this.consecutiveErrors = 0
      }

      log(`session "${this.sessionName}": SDK result subtype=${subtype} isError=${isError} midBuffer=${this.pendingMidTurnMsgs.length} consecErr=${this.consecutiveErrors} autoRetry=${autoRetry} followup=${followupReason ?? 'none'} noFollowupRetry=${noFollowupRetry} forcePush=${forcePush}`)
      void this.closeTurnCard(suffix, { forcePush })
      this.status = 'idle'

      if (hasMidTurn) {
        void this.drainMidTurnAndOpen()
      } else if (autoRetry) {
        // Re-poke the SDK to start a fresh turn. Anthropic's text-block
        // API rejects empty content, so use "继续" — minimal Chinese
        // imperative the model parses cleanly. Bumping
        // pendingUserMessageCount makes the init handler classify the
        // resulting turn as user_message (inheriting lastUserOpenId)
        // rather than scheduled, so the eventual success will still
        // phone-push the original sender。同时把 nextOpenKind 设成
        // 'auto_retry' / 'no_followup_retry' / 'tool_error_retry',让 init
        // handler 触发的 openTurnCard 出对应 banner(`🔁 SDK 错误自动续` /
        // `🔁 答完没下文,自动续` / `🛠️ 工具出错异常终止,自动续`),用户
        // 能看出这是 daemon 自续的 turn 而不是凭空冒出一张普通卡片,且能
        // 直接读出续 turn 的原因。
        this.proc?.sendUserText('继续')
        this.pendingUserMessageCount++
        this.nextOpenKind = noFollowupRetry
          ? (followupReason === 'tool_error' ? 'tool_error_retry' : 'no_followup_retry')
          : 'auto_retry'
      }
    })
    p.on('exit', ({ code, signal, expected }: any) => {
      log(`session "${this.sessionName}": claude exited code=${code} signal=${signal} expected=${expected}`)
      this.proc = null
      this.stopTicker(this.currentTurn)
      this.currentTurn = null
      this.pendingUserMessageCount = 0
      this.pendingMidTurnMsgs = []
      this.pendingTurnInputs = []
      this.nextOpenKind = null
      this.lastUserOpenId = ''
      this.releaseAllReactions()
      this.initCount = 0
      this.openingTurn = false
      this.consecutiveErrors = 0
      this.awaitingFollowup = null
      this.userInterrupted = false
      this.status = 'stopped'
      if (!expected && code !== 0 && signal !== 'SIGTERM') {
        void feishu.sendText(this.chatId, `⚠️ Claude 异常退出 (code=${code}, signal=${signal})。回复任意消息将重新启动。`)
      }
    })
  }

  /** Pull per-turn numbers off `proc.lastResult` (set by ClaudeProcess when
   * the `result` message landed) and roll them into cumStats + the
   * "上一轮" delta. Called exactly once per result event, right before
   * closeTurnCard. */
  private accumulateResultStats(): void {
    const r = this.proc?.lastResult
    if (!r) return
    const u = r.usage ?? {}
    const inputTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
    const outputTokens = u.output_tokens ?? 0
    const tokens = inputTokens + outputTokens
    const costUsd = r.cost_usd ?? 0
    const durationMs = r.duration_ms ?? 0
    this.cumStats.tokens += tokens
    this.cumStats.costUsd += costUsd
    this.cumStats.turns += r.num_turns ?? 1
    this.lastTurnDelta = { tokens, costUsd, durationMs, inputTokens }
  }

  /** Current context-window occupancy estimate — uses the most recent
   * assistant `usage` (input + caches), since each assistant reply replays
   * the full conversation. Returns 0 when no per-call usage is available
   * (process dead, or fresh spawn before first assistant message);
   * `lastTurnDelta.inputTokens` is the CUMULATIVE turn input across all
   * API calls in the turn (sum of cache_read across N steps) — using it
   * here would inflate the percentage by Nx after a heavy multi-step
   * turn (observed bug 2026-05-16: 417% in the `hi` panel after killing
   * the proc with a long turn's delta still on file). */
  private currentContextTokens(): number {
    const u = this.proc?.lastUsage as ClaudeUsage | null | undefined
    if (!u) return 0
    return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
  }

  /** Context-window capacity for the model the subprocess is currently
   * running — sourced authoritatively from `result.modelUsage[model]
   * .contextWindow` captured by ClaudeProcess on each turn close, so
   * the daemon doesn't have to enumerate model ids itself (was the
   * source of a "560K/200K" display bug — model id didn't include
   * `[1m]` so the hardcoded fallback won). Returns `null` when no turn
   * has closed yet (fresh spawn / kill / clear / revive); callers must
   * render percentages only when this is a real number. */
  private contextWindowMax(): number | null {
    return this.proc?.lastContextWindow ?? null
  }

  /** Drain `pendingMidTurnMsgs` to the SDK and open a fresh card for the
   * resulting batch turn. Called from the `result` handler when buffered
   * mid-turn messages need to start their own turn. The `sendUserText`
   * calls wake the SDK polling loop (priority="now" semantics) and
   * comprise the input for the new turn. Opens the card here rather
   * than deferring to init because the init for this batch will arrive
   * with `currentTurn` already set and bail.
   *
   * N 条 wireText 用 `\n` join 成 **单条** sendUserText 发给 SDK,而不是
   * N 次独立写。背景:SDK polling loop 在 turn 边界一次只 dequeue 一条
   * user message 进 prompt(claude-code issue #39632),N 次独立写会让
   * SDK 把第 1 条单独开 turn、剩 N-1 条进下一 turn —— daemon 这边 panel
   * 在 openTurnCard 时已经 commit 了全部 N 条到 "前一个" turn,跟 SDK
   * 实际 turn 边界错位(03:19 现场 turn=5 panel 7 条 vs 模型只看到 1 条
   * "1 和 2 两条都收到了")。join 成单条后,SDK 看到 1 个 user message
   * (内部含 N 个 `<u>...</u>` 子块),模型按 CHANNEL_INSTRUCTIONS 规约
   * 拆解 N 条,panel 跟模型实际 input 一致。
   *
   * pendingCount 一次 ++(对应一次 sendUserText)。因为 SDK 不再拆 turn,
   * commit 2258af4 当年用累加保护 spurious 第二 turn 的逻辑不再需要 —
   * SDK 不会自发开 user_batch 子 turn,init handler 也不会误判 scheduled。 */
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
      // wireText 每条已经被 onUserMessage 处理过(`<u>${filePrefix}${text}</u>`),
      // 每条 sub-message 自带 file hint —— SDK side files 一律传空,避免
      // file ↔ message 归属丢失(P1-1)。join 用 `\n` 让边界视觉上也清楚
      // (模型按 CHANNEL_INSTRUCTIONS 规约,`<u>1</u><u>2</u>` 拼在一起也
      // 算独立消息,newline 只是更明显)。
      const merged = batch.map(m => m.wireText).join('\n')
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

  private async openTurnCard(userOpenId: string, trigger: 'user_message' | 'scheduled' | 'auto_retry' | 'no_followup_retry' | 'tool_error_retry'): Promise<void> {
    const turn = ++this.turnCounter
    // Snapshot+clear pendingTurnInputs synchronously here so concurrent
    // pushes between snapshot and the await don't sneak into THIS turn's
    // panel (they'll be picked up by the next turn's open). scheduled
    // turns clear too — they shouldn't carry stale inputs from prior runs.
    const userInputs = this.pendingTurnInputs
    this.pendingTurnInputs = []
    log(`session "${this.sessionName}": openTurnCard turn=${turn} trigger=${trigger} inputs=${userInputs.length}`)
    const card = cards.mainConversationCard({
      sessionName: this.sessionName,
      turn,
      effort: 'max',
      kind: trigger,
      userInputs: trigger === 'user_message' ? userInputs : [],
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
        '❌ 创建对话卡片失败 (Feishu SDK 重试 3 次后仍连不上)。你这条消息没能送到 Claude,请稍后重发。',
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
    // onwards (banner + userInputPanel + ticker + footer — the latter
    // two are constant, the former two depend on trigger / userInputs).
    const initialElementCount =
      (trigger === 'scheduled' || trigger === 'auto_retry' || trigger === 'no_followup_retry' || trigger === 'tool_error_retry' ? 1 : 0) +
      (trigger === 'user_message' && userInputs.length > 0 ? 1 : 0) +
      2
    cardkit.recordCardCreated(cardId, initialElementCount)
    const turnState: TurnState = {
      cardId,
      messageId,
      userOpenId,
      trigger,
      toolCount: 0,
      toolByUseId: new Map(),
      readBatches: new Map(),
      openReadBatchI: null,
      assistantSegmentCount: 0,
      currentAssistantSegmentId: null,
      currentAssistantText: '',
      segmentTexts: new Map(),
      startedAt: Date.now(),
      tickerHandle: null,
      rotating: null,
    }
    this.currentTurn = turnState
    this.startTicker(turnState)
  }

  /** Cheap synchronous check called from stream handlers right before
   * they `addElement` a new tool / assistant segment / Read batch /
   * etc. If the current card is close to Feishu's element ceiling and
   * we haven't already kicked off a rotation, fire-and-forget start a
   * `startMidTurnRotate` and let it run async on its own. The current
   * stream handler still uses `turn.cardId` (the old card) for this
   * iteration — that's fine because (a) cardkit's per-card queue keeps
   * its writes ordered against the soft-close that's about to happen,
   * and (b) the soft limit (80) leaves 20 elements of headroom under
   * the hard cap (~100), so the in-flight adds either fit or are
   * silently swallowed when the old card is disposed. */
  maybeMidTurnRotate(): void {
    const turn = this.currentTurn
    if (!turn) return
    if (turn.rotating) return
    if (cardkit.getElementCount(turn.cardId) < CARD_ELEMENT_SOFT_LIMIT) return
    this.startMidTurnRotate(turn)
  }

  /** Open a fresh card under the **same** SDK turn number to dodge
   * Feishu's per-card element limit. The old card stays in the chat —
   * we flip its footer to "📨 卡片满,转下一张", turn streaming off,
   * and dispose its cardkit state — but it never becomes the writable
   * one again. Everything tool/assistant-related on the turn state is
   * reset so subsequent stream handlers wire up against the new card
   * cleanly; in-flight tool calls whose results land *after* rotation
   * lose their old element ids and re-emerge as fresh tool panels on
   * the new card (acceptable: the user already saw "⏳" frozen on the
   * old card, the new panel makes the result visible somewhere). */
  private startMidTurnRotate(turn: TurnState): void {
    if (turn.rotating) return
    const oldCardId = turn.cardId
    turn.rotating = (async () => {
      try {
        log(`session "${this.sessionName}": mid-turn rotate triggered card=${oldCardId.slice(0, 8)}… elementCount=${cardkit.getElementCount(oldCardId)}`)
        const card = cards.mainConversationCard({
          sessionName: this.sessionName,
          turn: this.turnCounter,
          effort: 'max',
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
        // card_full body has banner(1) + ticker(1) + footer(1) = 3 elements.
        cardkit.recordCardCreated(newCardId, 3)
        // 同步 swap：从这一行起,后续 stream handler 看到的 turn.cardId
        // 是新卡。reset 所有 element-id 引用 (toolCount / assistantSegmentCount
        // 等),旧卡上的 element_id 在新卡里查不到,继续 PUT 会 300313。
        this.stopTicker(turn)
        turn.cardId = newCardId
        turn.messageId = newMessageId
        turn.toolCount = 0
        turn.toolByUseId = new Map()
        turn.readBatches = new Map()
        turn.openReadBatchI = null
        turn.assistantSegmentCount = 0
        turn.currentAssistantSegmentId = null
        turn.currentAssistantText = ''
        turn.segmentTexts = new Map()
        this.startTicker(turn)
        // 旧卡收尾:footer 红字 + streaming_off + dispose。放到 swap 后
        // 是因为这条链是 async,期间 cardkit 队列上还可能有 stream
        // handler enqueue 的 streamText / replaceElement 等;让它们排
        // 在 footer 之前先 flush,视觉更连贯。
        try {
          await cardkit.flush(oldCardId)
          await cardkit.streamText(oldCardId, cards.ELEMENTS.footer, '📨 卡片满,转下一张 ↓')
          cardkit.cancelSummary(oldCardId)
          await cardkit.patchSettings(oldCardId, cards.streamingOffSettings({ suffix: '📨 卡片满' }))
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
  private appendAssistant(delta: string): void {
    if (!this.currentTurn) return
    const turn = this.currentTurn
    // 第一条 assistant text_delta 到达 → 顶部 ticker 活体指示完成使命,
    // 清掉;footer 切到 `⏳ working…` 接力做"还在干活"指示(跟顶部
    // ticker 互斥:同一时刻只有一处亮)。后续 delta 跑时 ticker handle
    // 已 null、stopTicker 短路;footer 的 streamThrottled 由 cardkit
    // lastSent 自然去重,只 PUT 一次。
    this.stopTicker(turn)
    cardkit.streamTextThrottled(turn.cardId, cards.ELEMENTS.footer, '⏳ working…')
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
        // addElement永久失败:reset segmentId 让下次 delta 重新创建
        // segment,否则后续 streamText 全都 PUT 到不存在的 element,
        // 整段 assistant text 在用户那看不到。守 segId 不变以防 turn
        // rotation 或 addTool 已经清掉了它(每次 addElement 闭包带的
        // 是自己创建那次的 segId,只清自己的)。
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
    cardkit.streamTextThrottled(turn.cardId, segId, turn.currentAssistantText)
    // Chat-list preview: tail of the latest assistant text. Feishu
    // truncates anyway; ~60 chars is what shows on a typical phone
    // preview line. patchSummaryThrottled is rate-limited on its own.
    const tail = turn.currentAssistantText.slice(-60)
    cardkit.patchSummaryThrottled(turn.cardId, tail)
  }

  /** 启动 ticker 元素的活体指示。turn 起来时随机选一个 verb,整 turn
   * 固定不变,setInterval 每 TICKER_TICK_MS (1s) 跑一次,刷新经过秒数。
   * 先 setInterval 再 render 是故意的 —— 同步首帧时 tickerHandle 已经
   * set,render 内部的 handle 自检不会误短路;首帧后下一帧要等 1s,
   * 视觉上 ticker 上来就有内容,无空白窗口。 */
  startTicker(turn: TurnState): void {
    if (turn.tickerHandle) return
    const verb = TICKER_VERBS[Math.floor(Math.random() * TICKER_VERBS.length)]
    const render = (): void => {
      // 自检:clearInterval 不撤销已经被 V8 dispatch 进事件循环的那次
      // callback。stopTicker 把 handle 置 null 后这里短路,避免漏一帧
      // 把刚 deleteElement 的 ticker 又 replaceElement 回 verb 文本(此时
      // ticker 元素不存在,PUT 会失败但污染日志)。
      if (turn.tickerHandle == null) return
      const elapsedS = Math.floor((Date.now() - turn.startedAt) / 1000)
      void cardkit.replaceElement(turn.cardId, cards.ELEMENTS.ticker, {
        tag: 'markdown',
        element_id: cards.ELEMENTS.ticker,
        content: `_${verb}中… (${elapsedS}s)_`,
      })
    }
    turn.tickerHandle = setInterval(render, TICKER_TICK_MS)
    render()
  }

  /** 清掉 ticker 并把 ticker 元素从卡片上彻底删掉。调用方负责自己把
   * footer 切到下一态(`⏳ working…` 或 `✅ ...`)。所有 turn 退出路径
   * 都得调:首条 assistant_text、首个 tool_use、closeTurnCard、stop/
   * restart/exit。允许 turn 为 null 让调用方少一道判断。 */
  stopTicker(turn: TurnState | null): void {
    if (!turn || !turn.tickerHandle) return
    clearInterval(turn.tickerHandle)
    turn.tickerHandle = null
    void cardkit.deleteElement(turn.cardId, cards.ELEMENTS.ticker)
  }

  private async closeTurnCard(suffix?: string, opts: { forcePush?: boolean } = {}): Promise<void> {
    // CRITICAL: capture-and-null in a single synchronous block at entry
    // so a parallel `closeTurnCard` (e.g. result event firing while
    // onUserMessage is awaiting an interrupt) can't double-process the
    // same turn — second caller observes null and bails. The promised
    // sync-handler invariant only protects callers that take the turn
    // off the table BEFORE their first await.
    const turn = this.currentTurn
    if (!turn) return
    this.currentTurn = null
    this.stopTicker(turn)
    const elapsed = ((Date.now() - turn.startedAt) / 1000).toFixed(1)
    const cardId = turn.cardId
    const segmentTexts = turn.segmentTexts
    await cardkit.flush(cardId)

    // [[send: /abs/path]] markers — strip them from each assistant
    // segment and collect paths to upload after the card finalizes.
    const sendPaths: string[] = []
    for (const [segId, fullText] of segmentTexts) {
      let changed = false
      const cleaned = fullText.replace(SEND_MARKER_RE, (_m, p1) => {
        changed = true
        const p = String(p1).trim()
        if (p.startsWith('/')) sendPaths.push(p)
        else log(`session "${this.sessionName}": ignore non-absolute send path: ${p}`)
        return ''
      })
      if (changed) {
        const finalText = cleaned.trim() || ' '
        await cardkit.replaceElement(cardId, segId, {
          tag: 'markdown', element_id: segId, content: finalText,
        })
      }
    }

    // thinking 区不再 collapse 成 panel —— replaceElement 会把 typewriter
    // 中段的内容整段换掉,飞书侧用户视觉上"中段消失"。partial 模式下
    // thinkingText 已经在 turn 期间真 streaming 进飞书,turn 结束保留
    // markdown 形态完整可见即可。代价是卡片会长一些,但比 typewriter
    // 被截好得多。
    const sendNote = sendPaths.length ? ` · 📎 ${sendPaths.length}` : ''
    // State marker leads the footer (✅ for natural completion, or the
    // suffix verbatim for non-natural states like `🛑 打断`). The
    // trailing "done" word is gone — the ✅ already carries that
    // meaning. User-confirmed footer order 2026-05-16.
    const stateMark = suffix ? suffix : '✅'
    // Per-turn metrics: context-window occupancy (as a real percentage,
    // not a token count) and dollar cost. Only meaningful on a clean
    // close — suffix-tagged turns (interrupt) didn't fire the `result`
    // event that populates `lastTurnDelta`, so these numbers would be
    // stale and misleading.
    let metrics = ''
    if (!suffix) {
      const ctxTokens = this.currentContextTokens()
      const ctxMax = this.contextWindowMax()
      if (ctxTokens > 0 && ctxMax !== null && ctxMax > 0) {
        const pct = Math.round((ctxTokens / ctxMax) * 100)
        metrics += ` · 📊 ${pct}%`
      }
      const cost = this.lastTurnDelta?.costUsd ?? 0
      if (cost > 0) metrics += ` · 💰 $${cost.toFixed(3)}`
    }
    const footer = `${stateMark} ⏱ ${elapsed}s${metrics}${sendNote}`
    await cardkit.streamText(cardId, cards.ELEMENTS.footer, footer)
    // Final chat-list preview: clean finish shows "⏱ Xs · NK tokens";
    // interrupted shows the suffix instead (no usage event landed).
    // cancelSummary kills any in-flight throttled write so a stale
    // mid-stream tail can't clobber this terminal summary.
    cardkit.cancelSummary(cardId)
    await cardkit.patchSettings(cardId, cards.streamingOffSettings({
      durationSec: elapsed,
      tokens: suffix ? undefined : this.lastTurnDelta?.tokens,
      suffix,
    }))
    await cardkit.dispose(cardId)

    // Phone push on clean turn close so the user knows Claude is done
    // even with the chat backgrounded. Skip on interrupts (no real
    // completion), when we don't know who to ping, and when the turn
    // wasn't kicked off by the user typing a message — scheduled /
    // cron / loop wakeups finish on their own and shouldn't ping the
    // phone. `opts.forcePush` overrides the suffix-gate for the
    // "consecutive SDK errors, giving up" case — that close has a non-
    // empty suffix but the user still needs to know we bailed.
    // Fire-and-forget; urgent_app failures are non-fatal and already
    // logged in feishu.ts.
    if ((opts.forcePush || !suffix) && turn.trigger === 'user_message' && turn.userOpenId && turn.messageId) {
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

    // Fire uploads sequentially AFTER the card is sealed so each file
    // posts as its own Feishu message below the conversation card.
    for (const p of sendPaths) {
      await feishu.uploadAndSend(this.chatId, p)
    }
  }
}
