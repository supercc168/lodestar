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
import { INBOX_DIR } from './paths'
import { readUsage } from './usage'
import type { TurnState, Status, SessionOpts, LastTurnDelta, CumStats } from './session-types'
import * as sessionTools from './session-tools'
import * as sessionAsk from './session-ask'
import * as sessionPermission from './session-permission'

export type { SessionOpts } from './session-types'

const SEND_MARKER_RE = /\[\[send:\s*([^\]\n]+?)\s*\]\]/g

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
  private pendingMidTurnMsgs: Array<{ wireText: string; files: string[]; userOpenId: string; msgId: string }> = []
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
    this.currentTurn = null
    this.pendingUserMessageCount = 0
    this.pendingMidTurnMsgs = []
    this.lastUserOpenId = ''
    this.releaseAllReactions()
    this.initCount = 0
    this.openingTurn = false
    this.pendingPermissions.clear()
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
    this.currentTurn = null
    this.pendingUserMessageCount = 0
    this.pendingMidTurnMsgs = []
    this.lastUserOpenId = ''
    this.releaseAllReactions()
    this.initCount = 0
    this.openingTurn = false
    this.pendingPermissions.clear()
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
        for (const [msgId, rid] of [
          ...this.pendingReactionIds.entries(),
          ...this.currentBatchReactionIds.entries(),
        ]) {
          if (rid) void feishu.deleteReaction(msgId, rid)
          void feishu.addReaction(msgId, 'CrossMark')
        }
        // Mid-turn buffer never reached SDK — cancel those too.
        for (const msg of this.pendingMidTurnMsgs) {
          if (msg.msgId) void feishu.addReaction(msg.msgId, 'CrossMark')
        }
        this.pendingUserMessageCount = 0
        this.pendingMidTurnMsgs = []
        this.lastUserOpenId = ''
        this.pendingReactionIds = new Map()
        this.currentBatchReactionIds = new Map()
        this.interrupt()
        // SDK 收到 interrupt 后不发 `result`,没人会触发 closeTurnCard。
        // 这里主动封口,把 footer 改成 🛑 打断、折叠 thinking、把
        // streaming_mode 翻回 false,否则卡片会僵在 `⏳ working…`。
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

  async showConsole(): Promise<void> {
    const uptimeMs = this.startedAt ? (Date.now() - this.startedAt) : undefined
    // Strip the `claude-` prefix so the panel stays compact: `opus-4-7`
    // reads better than `claude-opus-4-7` in the small status header.
    const rawModel = this.proc?.lastModel ?? null
    const model = rawModel ? rawModel.replace(/^claude-/, '') : undefined
    const card = cards.consoleCard({
      sessionName: this.sessionName,
      status: this.status,
      model,
      effort: 'max',
      uptimeMs,
      peers: [...Session.all]
        .filter(s => s.isRunning())
        .map(s => ({ ...s.peerSnapshot(), isCurrent: s === this })),
      // Initial paint without usage → cards.ts renders the
      // `_加载中…_` placeholder in the consoleUsage element. We patch
      // it in below once readUsage() resolves (ccusage cold-call is
      // ~5s; not worth blocking the panel on it).
      usage: undefined,
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
    })
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
    const wireText = wasBusy ? `<u>${text}</u>` : text

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
      this.pendingMidTurnMsgs.push({ wireText, files, userOpenId, msgId })
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
        await this.openTurnCard(userOpenId, 'user_message')
        if (!this.currentTurn) return
        this.proc!.sendUserText(wireText, files)
        this.pendingUserMessageCount++
        this.status = 'working'
      } finally {
        this.openingTurn = false
      }
      return
    }

    // Non-eager path: either init hasn't fired yet (cold start) or a
    // sibling onUserMessage is already opening. Feed SDK directly; the
    // init handler / sibling card-opener will batch this message in.
    this.proc!.sendUserText(wireText, files)
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
      const userOpenId = isUserBatch ? this.lastUserOpenId : ''
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
          await this.openTurnCard(userOpenId, isUserBatch ? 'user_message' : 'scheduled')
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
      this.appendAssistant(text)
    })
    p.on('thinking', ({ text }: { text: string }) => {
      this.appendThinking(text)
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
      // Daemon-driven rotation: mid-turn msgs were buffered (not yet
      // sent to SDK) — close the in-flight card with `📨 转交新卡` and
      // drain the buffer in one shot. The drain writes each buffered
      // msg to SDK stdin, which is the `priority="now"` wake the SDK
      // polling loop needs (claude-code issue #39632) AND constitutes
      // the input for the new batch turn. We open the new card here
      // ourselves rather than waiting on init — the SDK init for this
      // batch will fire shortly but `currentTurn` will already be set,
      // so the init handler will return without double-opening.
      const hasMidTurn = this.pendingMidTurnMsgs.length > 0
      const suffix = hasMidTurn ? '📨 转交新卡' : undefined
      log(`session "${this.sessionName}": SDK result midBuffer=${this.pendingMidTurnMsgs.length} suffix=${suffix ?? '<✅>'}`)
      void this.closeTurnCard(suffix)
      this.status = 'idle'
      if (hasMidTurn) void this.drainMidTurnAndOpen()
    })
    p.on('exit', ({ code, signal, expected }: any) => {
      log(`session "${this.sessionName}": claude exited code=${code} signal=${signal} expected=${expected}`)
      this.proc = null
      this.currentTurn = null
      this.pendingUserMessageCount = 0
      this.pendingMidTurnMsgs = []
      this.lastUserOpenId = ''
      this.releaseAllReactions()
      this.initCount = 0
      this.openingTurn = false
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
   * `[1m]` so the hardcoded fallback won). */
  private contextWindowMax(): number {
    return this.proc?.lastContextWindow ?? 200_000
  }

  /** Drain `pendingMidTurnMsgs` to the SDK and open a fresh card for the
   * resulting batch turn. Called from the `result` handler when buffered
   * mid-turn messages need to start their own turn. The `sendUserText`
   * calls wake the SDK polling loop (priority="now" semantics) and
   * comprise the input for the new turn. Opens the card here rather
   * than deferring to init because the init for this batch will arrive
   * with `currentTurn` already set and bail.
   *
   * Each sendUserText also bumps `pendingUserMessageCount`. The SDK
   * USUALLY collapses our N writes into one merged turn, but **not
   * always** — empirically observed 2026-05-17, test1 accumulator
   * session: when the first write lands in an idle SDK (turn just
   * ended), the SDK eagerly starts a turn for that msg alone, then
   * merges the rest into a second turn. Without the bump here, that
   * second turn fires an `init` with `pendingUserMessageCount === 0`
   * and the init handler misclassifies it as a scheduled wakeup,
   * painting the `⏰ 触发` banner on what is really a user batch. */
  private async drainMidTurnAndOpen(): Promise<void> {
    if (this.pendingMidTurnMsgs.length === 0) return
    const batch = this.pendingMidTurnMsgs
    this.pendingMidTurnMsgs = []
    this.openingTurn = true
    try {
      for (const msg of batch) {
        this.proc!.sendUserText(msg.wireText, msg.files)
        this.pendingUserMessageCount++
        if (msg.msgId) {
          const rid = this.pendingReactionIds.get(msg.msgId) ?? ''
          this.currentBatchReactionIds.set(msg.msgId, rid)
          this.pendingReactionIds.delete(msg.msgId)
        }
      }
      const last = batch[batch.length - 1]
      const userOpenId = last?.userOpenId ?? this.lastUserOpenId
      await this.openTurnCard(userOpenId, 'user_message')
      this.status = 'working'
    } finally {
      this.openingTurn = false
    }
  }

  private async openTurnCard(userOpenId: string, trigger: 'user_message' | 'scheduled'): Promise<void> {
    const turn = ++this.turnCounter
    log(`session "${this.sessionName}": openTurnCard turn=${turn} trigger=${trigger}`)
    const card = cards.mainConversationCard({
      sessionName: this.sessionName,
      turn,
      effort: 'max',
      kind: trigger,
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
    this.currentTurn = {
      cardId,
      messageId,
      userOpenId,
      trigger,
      thinkingText: '',
      toolCount: 0,
      toolByUseId: new Map(),
      readBatches: new Map(),
      openReadBatchI: null,
      assistantSegmentCount: 0,
      currentAssistantSegmentId: null,
      currentAssistantText: '',
      segmentTexts: new Map(),
      startedAt: Date.now(),
    }
  }

  // Stream-event handlers are intentionally SYNCHRONOUS. Every cardkit op
  // is queued (per-card Promise chain in cardkit.ts), so we fire-and-
  // forget here and rely on enqueue source order — that way no `await`
  // can yield mid-handler and let `closeTurnCard` (or another event) race
  // and mutate `this.currentTurn` underfoot.
  private appendAssistant(delta: string): void {
    if (!this.currentTurn) return
    const turn = this.currentTurn
    if (!turn.currentAssistantSegmentId) {
      // New assistant segment opens a visual break — any prior Read run
      // is now visually separated from future Reads, so close the batch
      // window. Future Reads will start a fresh batch at a new i.
      turn.openReadBatchI = null
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

  private appendThinking(delta: string): void {
    if (!this.currentTurn) return
    this.currentTurn.thinkingText += delta
    cardkit.streamTextThrottled(
      this.currentTurn.cardId,
      cards.ELEMENTS.thinking,
      this.currentTurn.thinkingText,
    )
  }

  private async closeTurnCard(suffix?: string): Promise<void> {
    // CRITICAL: capture-and-null in a single synchronous block at entry
    // so a parallel `closeTurnCard` (e.g. result event firing while
    // onUserMessage is awaiting an interrupt) can't double-process the
    // same turn — second caller observes null and bails. The promised
    // sync-handler invariant only protects callers that take the turn
    // off the table BEFORE their first await.
    const turn = this.currentTurn
    if (!turn) return
    this.currentTurn = null
    const elapsed = ((Date.now() - turn.startedAt) / 1000).toFixed(1)
    const cardId = turn.cardId
    const thinkingText = turn.thinkingText
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

    if (thinkingText.trim()) {
      await cardkit.replaceElement(cardId, cards.ELEMENTS.thinking, cards.thinkingCollapsedPanel(thinkingText))
    }
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
      if (ctxTokens > 0 && ctxMax > 0) {
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
    // phone. Fire-and-forget; urgent_app failures are non-fatal and
    // already logged in feishu.ts.
    if (!suffix && turn.trigger === 'user_message' && turn.userOpenId && turn.messageId) {
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
    // Path gate: workDir (Claude's project sandbox), the inbox where
    // user-uploaded attachments land, and the /tmp/lodestar- namespace
    // for ad-hoc artifacts.  Anything outside is refused — see
    // feishu.isPathAllowed.
    const allowedRoots = [this.workDir, INBOX_DIR, '/tmp/lodestar-']
    for (const p of sendPaths) {
      await feishu.uploadAndSend(this.chatId, p, allowedRoots)
    }
  }
}
