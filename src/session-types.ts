/**
 * Shared types split out of session.ts so the main file stays under
 * agent per-read token budgets. Pure type-only — no
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
  /** What kicked off this turn. Kept explicit for turn lifecycle logic. */
  trigger: 'user_message'
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
  /** Footer thinking timer. While present, footer shows `Thinking...(Ns)`.
   * Assistant text or tool execution clears it to `Working...`; after all
   * tools finish it can start again while the model is silent. */
  thinkingFooterHandle: ReturnType<typeof setInterval> | null
  thinkingFooterStartedAt: number
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
  /** 本 turn 已处理过的出站路径请求。包括合法绝对路径和被拒绝的非绝对路径,
   * 用来避免流式文本反复扫到同一个 [[send: ...]] 时重复上传或刷日志。 */
  outboundSeenPaths: Set<string>
  /** 已实际排队上传的绝对路径。用于 footer 计数和跨 rotate 去重。 */
  outboundSentPaths: Set<string>
}

export type Status = 'idle' | 'working' | 'awaiting_permission' | 'starting' | 'stopped'

export interface SessionOpts {
  /** Daemon hook: persist its current alive-session snapshot whenever this
   * session starts, stops, exits, or changes process lifecycle. Scripts
   * that construct Session directly can omit it. */
  onLifecycleChange?: () => void
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
 * regardless of how many times the underlying CodexProcess has been
 * respawned. Resumed conversations start counting from the resume
 * point onward — the SDK doesn't replay historical usage on resume,
 * so a long pre-resume conversation shows up as zero here until the
 * first new turn lands. */
export interface CumStats {
  tokens: number
  costUsd: number
  turns: number
}
