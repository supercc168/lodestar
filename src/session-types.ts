/**
 * Shared types split out of session.ts so the main file stays under
 * Claude Code's per-read token budget (~25K). Pure type-only — no
 * runtime imports here. Companion modules: session-tools.ts,
 * session-ask.ts, session-permission.ts.
 */

export interface TurnState {
  cardId: string
  /** Feishu message_id of the card — needed for urgent_app push on clean
   * turn close. Kept separate from cardId because cardkit's stream APIs
   * operate on card_id but the urgent_app endpoint takes message_id. */
  messageId: string
  /** open_id of the user who started this turn. Used to scope the
   * urgent_app push so only the initiator gets pinged (in case there
   * are other members in the group). Empty string → skip the ping. */
  userOpenId: string
  /** What kicked off this turn. Only `'user_message'` turns fire the
   * end-of-turn urgent_app push — scheduled / cron / loop wakeups
   * finish on their own time and pinging the user would be noise,
   * not signal. Ask / permission urgents inside the turn still fire
   * regardless (those genuinely need attention even mid-schedule). */
  trigger: 'user_message' | 'scheduled' | 'auto_retry' | 'no_followup_retry' | 'tool_error_retry'
  toolCount: number
  /** `output` / `isError` are filled in by completeTool — kept on the
   * meta (instead of being thrown away after the first render) so a
   * later Task* op can re-render every prior Task* panel with the
   * latest todo mirror appended. */
  toolByUseId: Map<string, {
    i: number
    name: string
    input: any
    resolvedNote?: string
    output?: string
    isError?: boolean
    /** Set when this tool is part of a merged Read batch — points to the
     * batch's slot in `readBatches[i].items`. completeTool uses it to
     * update the right row instead of rendering a standalone panel. */
    readBatchSlot?: number
  }>
  /** Consecutive `Read` calls collapse into a single panel rendered by
   * `cards.readBatchElement`. Keyed by element index `i` so completeTool
   * can find the batch after its open-window closed (a non-Read tool or
   * new assistant segment has since arrived).
   *
   * `openReadBatchI` is the i of the batch currently accepting new Reads;
   * null once the run ends. Subsequent Read calls open a fresh batch at a
   * new i. */
  readBatches: Map<number, {
    items: Array<{ toolUseId: string; input: any; output: string | null; isError: boolean }>
  }>
  openReadBatchI: number | null
  assistantSegmentCount: number
  currentAssistantSegmentId: string | null
  currentAssistantText: string
  // Per-assistant-segment cumulative text — used at turn close to strip
  // [[send: /path]] markers and replace each segment with a cleaned
  // version, then post the files as separate Feishu messages.
  segmentTexts: Map<string, string>
  startedAt: number
  /** "模型还在干活" 活体指示的 setInterval 句柄,turn 起来后挂上,
   * 在卡片顶部 ticker 元素里每 1s 跳一次刷新经过秒数(verb 是 turn 起
   * 时随机选的、整 turn 固定不变)。首条 assistant_text 或 tool_use
   * 到达即 deleteElement(ticker),让卡片顶部干净。
   *
   * 跟"thinking 文本"无关 —— Anthropic 把 opus-4-7 的 extended thinking
   * 整段 redacted,客户端只拿到加密 signature 没明文,所以飞书卡片
   * 中段不会显示任何 thinking 文本,ticker 就是模型工作过程中唯一
   * 可见的活体信号。 */
  tickerHandle: ReturnType<typeof setInterval> | null
  /** Mid-turn card-rotation lock. Set when we've fire-and-forget kicked
   * off `startMidTurnRotate` to open a fresh card — either proactively
   * (element count crossed CARD_ELEMENT_SOFT_LIMIT) or reactively (an
   * addElement write was rejected by Feishu — see onCardWriteFailure).
   * Stays set until rotation completes so concurrent stream handlers
   * don't all queue duplicate rotation attempts. null means "no rotation
   * in flight". */
  rotating: Promise<void> | null
  /** How many times this turn has rotated to a fresh card. The cap
   * (MAX_MIDTURN_ROTATES) is enforced ONLY on the reactive failure path
   * (onCardWriteFailure) — that's the only one that can run away (Feishu
   * outage, or a poisoned element that fails on every card). The proactive
   * path (maybeMidTurnRotate) bumps this too but isn't capped: it needs ~50
   * genuinely-successful elements per card to fire again, so it's naturally
   * throttled by real output, not by failures. Reset per turn (a fresh
   * TurnState starts at 0). */
  rotateCount: number
  /** Latched once we hit the rotate cap and emit the "giving up" notice,
   * so the notice isn't repeated on every later failed write this turn. */
  rotateGivenUp: boolean
}

export type Status = 'idle' | 'working' | 'awaiting_permission' | 'starting' | 'stopped'

export interface SessionOpts {
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
}

/** Per-turn delta extracted from the SDK `result` message — feeds the
 * "上一轮" line in the console panel. */
export interface LastTurnDelta {
  tokens: number      // input + cache_creation + output for that turn (剔除 cache_read 复读)
  costUsd: number     // 本轮真实成本增量(SDK total_cost_usd 是 session 累计,这里存 delta)
  durationMs: number
}

/** Cumulative session counters. Reset on full restart (`clear`),
 * preserved across `restart`/resume and daemon-restart so the `hi`
 * panel reflects the user's total spend in this conversation
 * regardless of how many times the underlying ClaudeProcess has been
 * respawned. Resumed conversations start counting from the resume
 * point onward — the SDK doesn't replay historical usage on resume,
 * so a long pre-resume conversation shows up as zero here until the
 * first new turn lands. */
export interface CumStats {
  tokens: number
  costUsd: number
  turns: number
}
