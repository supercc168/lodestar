/**
 * Feishu Card Kit v1 wrapper.
 *
 * Endpoints used (base = https://open.feishu.cn/open-apis/cardkit/v1):
 *   POST   /cards/id_convert                              message_id → card_id
 *   POST   /cards                                         create a card entity
 *   POST   /cards/:card_id/elements                       add element
 *   PUT    /cards/:card_id/elements/:element_id           replace element
 *   DELETE /cards/:card_id/elements/:element_id           remove element
 *   PATCH  /cards/:card_id/settings                       toggle streaming_mode etc.
 *
 * Per-card invariants enforced here:
 *   - `sequence` is monotonically increasing per card_id
 *   - all writes for a card are serialized through a Promise queue
 */

import { getTenantToken } from './feishu'
import { log } from './log'

const BASE = 'https://open.feishu.cn/open-apis/cardkit/v1'

const ID_CONVERT_RETRY_DELAYS_MS = [0, 250, 750, 1500]
/** Transient transport failures (TypeError: fetch failed / ECONNRESET / …)
 * get a short retry burst inside the per-card queue before we surface them.
 * These are NOT Feishu capacity signals — rotating cards cannot fix them,
 * and counting them toward the mid-turn failure-rotate cap is what turned
 * etmmo footer ticker blips into log-only turns (2026-07-25/26). */
const NETWORK_RETRY_DELAYS_MS = [200, 500]
/** Footer is a single stable element rewritten every second for the phase
 * ticker. A failed footer tick must skip/degrade — never escalate to the
 * card-level onFailure → mid-turn rotate path. */
const FOOTER_ELEMENT_ID = 'footer'

interface CardState {
  sequence: number
  queue: Promise<void>
  /** Live count of elements on the card. Initialised by
   * `recordCardCreated` (session passes the body.elements.length of the
   * just-sent card), then incremented in addElement's success branch and
   * decremented in deleteElement's. Used by session to pre-empt the
   * cardkit "element exceeds the limit" (300305/300315) ceiling — once
   * the count climbs into the danger zone, session rotates a new card
   * mid-turn before the next addElement would 400. Approximate (a failed
   * addElement won't bump it, so the count tracks "elements Feishu
   * believes exist" not "elements we tried to create"). */
  elementCount: number
  /** element_ids that must no longer receive writes. Usually this means
   * `addElement` was rejected by Feishu (most often `300305/300315
   * [element exceeds the limit]`), so the element does NOT exist on Feishu's
   * side and every subsequent `replaceElement`/`deleteElement`
   * would 300313/300121. Per-card and dropped on `dispose`, so a rotated-to
   * fresh card starts clean. */
  deadElements: Set<string>
  /** Card-level write kill-switch (see markCardWriteDead). Once set, every
   * write op short-circuits to a resolved promise — no HTTP, no onFailure.
   * Session flips this when it hits the failure-rotate cap and goes
   * log-only: without it, the per-second footer ticker and stream handlers
   * keep hammering the unwritable card (2026-07-04: 663 × code=300308 in
   * 11 minutes against one dead card). */
  writeDead?: boolean
  /** Card-level write-failure callback, set by recordCardCreated. Invoked
   * by any cardkit write op that fails even after the streaming-closed
   * reopen+retry (and network retries); the session uses it to decide
   * whether to rotate (see Session.onCardWriteFailure). Not fired for
   * deletes (a failed delete is harmless — it doesn't block new content)
   * or for footer replaceElement (phase ticker must degrade in place, not
   * burn mid-turn rotate budget). */
  onFailure?: CardWriteFailureHandler
  /** Fired after a successful addElement only. Session uses this to clear
   * the failure-rotate streak once real content lands on the live card
   * (footer ticks must not reset the streak — they run every second). */
  onSuccess?: () => void
}

/** Why a cardkit write failed after local retries. `network` means no Feishu
 * business code (fetch/TCP/DNS); session must not mid-turn-rotate on it.
 * `api` is any Feishu cardkit business rejection (capacity, sequence, etc.). */
export type CardWriteFailureKind = 'network' | 'api'

export interface CardWriteFailureMeta {
  kind: CardWriteFailureKind
}

/** Card-level / per-call failure callback. `code` is the Feishu business
 * code when kind=api; undefined for pure network failures and short-circuits.
 * Second arg is optional so older call sites (`code => ...`) keep working. */
export type CardWriteFailureHandler = (code?: number, meta?: CardWriteFailureMeta) => void

/** Feishu's element-ceiling rejection. `300315` wraps the inner
 * `300305 [element exceeds the limit]`; treat both as "card is full".
 * Exported so session can turn an add failure into a forced rotate
 * without re-encoding the magic numbers. */
export function isElementLimitCode(code?: number): boolean {
  return code === 300305 || code === 300315
}

/** Feishu total-card payload ceiling (`200860 card over max size`). Distinct
 * from element-count limits: a card with ~40 panels can still 200860 if each
 * panel carries a fat command/stdout dump. Session treats this the same as
 * "card is full" for mid-turn rotate, and renderers must also clamp content
 * so a single oversized element doesn't burn the rotate budget on every card. */
export function isCardSizeLimitCode(code?: number): boolean {
  return code === 200860
}

/** Any "this card can't take more content" signal — element count or bytes. */
export function isCardCapacityCode(code?: number): boolean {
  return isElementLimitCode(code) || isCardSizeLimitCode(code)
}

/** True when the failure has no Feishu business `code` — pure transport
 * (TypeError: fetch failed, ECONNRESET, undici connect timeout, DNS, …).
 * Feishu API rejections always attach a numeric `code` on the Error. */
export function isNetworkError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return true
  const code = (e as { code?: unknown }).code
  return typeof code !== 'number'
}

const cards = new Map<string, CardState>()

/** Card ids that were disposed (turn closed / rotated away). Mutation APIs
 * on a disposed card must NOT silently re-create state via state() and fire
 * real HTTP writes at a card whose stream is closed — that both pollutes
 * the wire and resurrects leaked state (上游 ec149d7). Bounded tombstone
 * set: oldest entries are evicted past the cap, so a long-lived daemon
 * doesn't accumulate one entry per rotated card forever. */
const disposedCards = new Set<string>()
const MAX_DISPOSED_CARD_TOMBSTONES = 5000

function rememberDisposedCard(cardId: string): void {
  disposedCards.delete(cardId)
  disposedCards.add(cardId)
  while (disposedCards.size > MAX_DISPOSED_CARD_TOMBSTONES) {
    const oldest = disposedCards.values().next().value
    if (typeof oldest !== 'string') break
    disposedCards.delete(oldest)
  }
}

/** True if this card was disposed. Late async writers (promises landing
 * after turn close) check this before scheduling writes. */
export function isDisposed(cardId: string): boolean {
  return disposedCards.has(cardId)
}

interface SummaryState {
  latest: string
  lastSent: string
  timer: ReturnType<typeof setTimeout> | null
}
const summaryStates = new Map<string, SummaryState>()
const SUMMARY_FLUSH_MS = 1500

function state(cardId: string): CardState {
  let s = cards.get(cardId)
  if (!s) {
    s = {
      sequence: 0,
      queue: Promise.resolve(),
      elementCount: 0,
      deadElements: new Set(),
    }
    cards.set(cardId, s)
  }
  return s
}

/** Session calls this once right after sendCard + convertMessageToCard,
 * passing the number of elements that were in the card's initial body
 * (banner + userInputPanel + footer = 1–3 depending on turn
 * kind). Without this, the element-count tracker only sees adds/deletes
 * that happen *after* card creation, and session can't reliably decide
 * "is this card close to the limit?" — that's the data point that
 * triggers a mid-turn rotate to dodge `code=300305/300315`.
 *
 * `onSuccess` is optional: only real content writes (addElement) fire it;
 * session uses it to clear the failure-rotate streak after recovery. */
export function recordCardCreated(
  cardId: string,
  initialElementCount: number,
  onFailure?: CardWriteFailureHandler,
  onSuccess?: () => void,
): void {
  // 新生命周期开始:同 id 重建(测试复用固定 card id / 飞书同 id 再开卡)
  // 时清除 disposed 墓碑,恢复可写。
  disposedCards.delete(cardId)
  const s = state(cardId)
  s.elementCount = initialElementCount
  s.onFailure = onFailure
  s.onSuccess = onSuccess
}

/** Read the live element count maintained by addElement/deleteElement.
 * Returns 0 if the card has no state yet (which is also the right answer
 * for "this card has no elements that we know about"). */
export function getElementCount(cardId: string): number {
  return cards.get(cardId)?.elementCount ?? 0
}

/** True if `elementId` was recorded dead on this card (its addElement was
 * rejected, so the element doesn't exist on Feishu). Mid-turn rotation reads
 * this for tool panels: dead ⇒ rebuild on the fresh card, alive ⇒ leave it on
 * the old card. */
export function isDeadElement(cardId: string, elementId: string): boolean {
  return cards.get(cardId)?.deadElements.has(elementId) ?? false
}

/** Stop all future writes to this card. Idempotent; cleared only by
 * dispose (a rotated-to fresh card has its own state). Covers both new
 * enqueues and already-queued tasks that haven't reached the wire yet
 * (each op re-checks the flag when it runs). */
export function markCardWriteDead(cardId: string): void {
  state(cardId).writeDead = true
  cancelSummary(cardId)
}

function nextSeq(cardId: string): number {
  const s = state(cardId)
  s.sequence += 1
  return s.sequence
}

function markElementDead(s: CardState, elementId: string): void {
  s.deadElements.add(elementId)
}

async function call(method: string, path: string, body?: object): Promise<any> {
  const token = await getTenantToken()
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const json = await res.json() as any
  if (json?.code && json.code !== 0) {
    const e = new Error(`cardkit ${method} ${path}: code=${json.code} msg=${json.msg}`) as Error & { code: number }
    e.code = json.code
    throw e
  }
  return json?.data
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isStreamingClosed(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false
  const code = (e as any).code
  // 300309 "streaming mode is closed" — TTL already fired before our write.
  // 200850 "card streaming timeout"   — TTL fired exactly during our write.
  // Both mean the streaming session is gone and a reopen will unstick the card.
  return code === 300309 || code === 200850
}

/** Reopen streaming_mode on a card that Feishu auto-closed after its
 * 10-minute streaming TTL (no keepalive, no idle reset — the timer
 * starts when streaming is opened and fires regardless of activity).
 * Called from inside the per-card queue's catch path, so it allocates
 * its own sequence and runs inline without re-enqueueing. */
async function reopenStreaming(cardId: string): Promise<void> {
  const seq = nextSeq(cardId)
  await call('PATCH', `/cards/${cardId}/settings`, {
    settings: JSON.stringify({ config: { streaming_mode: true } }),
    sequence: seq,
  })
}

function failureMetaFromError(e: unknown): CardWriteFailureMeta {
  return { kind: isNetworkError(e) ? 'network' : 'api' }
}

function failureCodeFromError(e: unknown): number | undefined {
  const code = (e as { code?: unknown } | null)?.code
  return typeof code === 'number' ? code : undefined
}

/** Run `op`, retrying briefly on pure network transport failures. Returns
 * only after success or a non-network error / exhausted retries. */
async function withNetworkRetry(
  cardId: string,
  label: string,
  op: () => Promise<void>,
): Promise<void> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt <= NETWORK_RETRY_DELAYS_MS.length; attempt++) {
    try {
      await op()
      return
    } catch (e) {
      lastErr = e
      if (!isNetworkError(e) || attempt === NETWORK_RETRY_DELAYS_MS.length) throw e
      const delay = NETWORK_RETRY_DELAYS_MS[attempt] ?? 0
      log(`cardkit ${label} ${cardId}: network error, retry ${attempt + 1}/${NETWORK_RETRY_DELAYS_MS.length} in ${delay}ms: ${e}`)
      if (delay > 0) await sleep(delay)
    }
  }
  throw lastErr
}

/** Run `op` inside the per-card queue. Network transport failures retry
 * briefly first. If it then fails with code=300309 or 200850 (Feishu
 * auto-closed / timed-out streaming after the 10-minute TTL), reopen
 * streaming inline and retry `op` once more (with its own network
 * retries). Anything else — other failure, reopen failure, retry
 * failure — is logged and swallowed, matching the fire-and-forget
 * contract every cardkit op already has at the call sites.
 *
 * `elevateCardFailure` false skips the card-level onFailure (footer
 * ticks / deletes). Per-call onFailure still fires so callers can
 * observe the miss. */
async function withReopenOnStreamingClosed(
  cardId: string,
  label: string,
  op: () => Promise<void>,
  onFailure?: CardWriteFailureHandler,
  opts: { silent?: boolean; elevateCardFailure?: boolean } = {},
): Promise<void> {
  const silent = opts.silent === true
  const elevateCardFailure = opts.elevateCardFailure !== false
  // 失败统一出口:card-level handler 先(它同步快照当前段/tool 后再异步
  // 换卡),per-call onFailure 后(addElement 的 deadElements.add + session
  // 段游标 reset)。顺序要紧 —— 换卡的同步快照必须在 reset 把
  // currentAssistant* 清空之前跑。silent(deleteElement) 与
  // elevateCardFailure=false(footer) 跳过 card-level:删不掉/tick 丢一次
  // 都不该烧换卡额度。
  const fail = (e: unknown): void => {
    const code = failureCodeFromError(e)
    const meta = failureMetaFromError(e)
    if (!silent && elevateCardFailure) state(cardId).onFailure?.(code, meta)
    onFailure?.(code, meta)
  }
  try {
    await withNetworkRetry(cardId, label, op)
    return
  } catch (e) {
    if (!isStreamingClosed(e)) {
      log(`cardkit ${label} ${cardId}: ${e}`)
      fail(e)
      return
    }
    log(`cardkit ${label} ${cardId}: streaming closed (code=${(e as any).code}) — reopening`)
  }
  try {
    await withNetworkRetry(cardId, `${label} reopenStreaming`, () => reopenStreaming(cardId))
  } catch (re) {
    log(`cardkit STREAMING_REOPEN_FAILED ${cardId}: ${re}`)
    fail(re)
    return
  }
  try {
    await withNetworkRetry(cardId, `${label} retry-after-reopen`, op)
  } catch (e2) {
    log(`cardkit ${label} ${cardId} retry-after-reopen: ${e2}`)
    fail(e2)
  }
}

function isIdConvertEmptyResult(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as any).code === 200740
}

interface IdConvertOptions {
  retryDelaysMs?: number[]
}

/** Convert a sent interactive message into a card entity. */
export async function convertMessageToCard(
  messageId: string,
  opts: IdConvertOptions = {},
): Promise<string> {
  const delays = opts.retryDelaysMs?.length ? opts.retryDelaysMs : ID_CONVERT_RETRY_DELAYS_MS
  let lastErr: unknown = null
  for (let i = 0; i < delays.length; i++) {
    const delay = delays[i] ?? 0
    if (delay > 0) await sleep(delay)
    try {
      const data = await call('POST', '/cards/id_convert', { message_id: messageId })
      if (typeof data?.card_id !== 'string' || !data.card_id) {
        throw new Error(`cardkit POST /cards/id_convert: missing card_id`)
      }
      // convert 返回的 card_id 开启新生命周期:清掉旧墓碑,让中途失所有权
      // 的 stale-open 终态写(recordCardCreated 之前)不被上一世的 dispose
      // 挡住(测试复用固定 id 时同理)。
      disposedCards.delete(data.card_id)
      return data.card_id
    } catch (e) {
      lastErr = e
      if (!isIdConvertEmptyResult(e) || i === delays.length - 1) throw e
      const nextDelay = delays[i + 1] ?? 0
      log(`cardkit id_convert ${messageId}: empty result, retry ${i + 2}/${delays.length} in ${nextDelay}ms`)
    }
  }
  throw lastErr
}

/** Create a card entity from raw schema-2.0 card JSON. */
export async function createCardEntity(card: object): Promise<string> {
  const data = await call('POST', '/cards', {
    type: 'card_json',
    data: JSON.stringify(card),
  })
  // 同 convertMessageToCard:新卡实体 = 新生命周期,清旧墓碑。
  if (typeof data?.card_id === 'string') disposedCards.delete(data.card_id)
  return data.card_id
}

/** Wait for all currently queued writes for a card. */
export async function flush(cardId: string): Promise<void> {
  const s = cards.get(cardId)
  if (!s) return
  await s.queue
}

/** Add a new element to the card body or relative to a sibling.
 *
 * `onFailure` fires asynchronously (after promise queue settles) if the
 * element was NOT created — either the first attempt failed with a non-
 * 300309 error, or the retry-after-reopen also failed. Use it to invalidate
 * any daemon-side reference to the element you tried to add (e.g. a segment
 * id), so subsequent writes don't keep PUTting content to a phantom element
 * that Feishu will silently reject. Default (no callback) preserves the
 * legacy fire-and-forget swallow behavior. */
export function addElement(
  cardId: string,
  element: object,
  opts: { type?: 'append' | 'insert_before' | 'insert_after'; targetElementId?: string } = {},
  onFailure?: CardWriteFailureHandler,
): Promise<void> {
  // disposed 判断必须先于 state():否则 dispose 后的迟到写会经 state()
  // 误建全新 bookkeeping(sequence 归零)并对已关流的卡发真实 HTTP。
  if (disposedCards.has(cardId)) return Promise.resolve()
  const s = state(cardId)
  if (s.writeDead) return Promise.resolve()
  const elementId = (element as { element_id?: string }).element_id
  s.queue = s.queue.then(() => withReopenOnStreamingClosed(
    cardId,
    `addElement`,
    async () => {
      if (s.writeDead) return
      const seq = nextSeq(cardId)
      await call('POST', `/cards/${cardId}/elements`, {
        type: opts.type ?? 'append',
        ...(opts.targetElementId ? { target_element_id: opts.targetElementId } : {}),
        elements: JSON.stringify([element]),
        sequence: seq,
      })
      // Only bump after the API returns 0 — a 300305/300315 throw will
      // bypass this line, so the count tracks "elements Feishu actually
      // accepted" not "elements we tried to push".
      s.elementCount += 1
      // Real content landed — clear any prior failure-rotate streak.
      s.onSuccess?.()
    },
    (code, meta) => {
      // Add rejected ⇒ this element_id does not exist on Feishu's side.
      // Mark it dead so subsequent replace/delete aimed at it
      // short-circuit instead of spraying 300313/300121. Then forward the
      // code: session turns an element-limit code into a forced mid-turn
      // rotate (the local counter can't be trusted here — a failed add
      // doesn't bump it, so it never reaches the rotate threshold on its
      // own).
      if (elementId) markElementDead(s, elementId)
      onFailure?.(code, meta)
    },
  ))
  return s.queue
}

/** Replace an entire element (used to swap a tool placeholder with its result).
 *
 * `onFailure` fires exactly once if the replace did NOT land — API failure
 * (with the parsed Card Kit code), or a write-dead / dead-element short
 * circuit (no code). 注意与 addElement 的差异:addElement 的 write-dead
 * 短路是静默的,这里短路也回调 —— 终态写(footer 终态、streaming 收尾)
 * 必须可观测,否则调用方无从决定 raw 文本兜底。Default (no callback)
 * preserves the legacy fire-and-forget swallow behavior. */
export function replaceElement(
  cardId: string,
  elementId: string,
  element: object,
  onFailure?: CardWriteFailureHandler,
): Promise<void> {
  if (disposedCards.has(cardId)) return Promise.resolve()
  const s = state(cardId)
  // Footer ticks must never escalate to card-level rotate. write-dead /
  // dead-element short-circuits still report to per-call onFailure so
  // terminal footer writers can fall back to raw text.
  const elevateCardFailure = elementId !== FOOTER_ELEMENT_ID
  if (s.writeDead || s.deadElements.has(elementId)) {
    onFailure?.()
    return Promise.resolve()
  }
  s.queue = s.queue.then(() => withReopenOnStreamingClosed(
    cardId,
    `replaceElement ${elementId}`,
    async () => {
      if (s.writeDead || s.deadElements.has(elementId)) {
        onFailure?.()
        return
      }
      const seq = nextSeq(cardId)
      await call('PUT', `/cards/${cardId}/elements/${elementId}`, {
        element: JSON.stringify(element),
        sequence: seq,
      })
    },
    onFailure,
    { elevateCardFailure },
  ))
  return s.queue
}

/** Delete an element by id. */
export function deleteElement(cardId: string, elementId: string): Promise<void> {
  if (disposedCards.has(cardId)) return Promise.resolve()
  const s = state(cardId)
  if (s.writeDead || s.deadElements.has(elementId)) return Promise.resolve()
  s.queue = s.queue.then(() => withReopenOnStreamingClosed(
    cardId,
    `deleteElement ${elementId}`,
    async () => {
      if (s.writeDead || s.deadElements.has(elementId)) return
      const seq = nextSeq(cardId)
      await call('DELETE', `/cards/${cardId}/elements/${elementId}`, {
        sequence: seq,
      })
      s.elementCount = Math.max(0, s.elementCount - 1)
      markElementDead(s, elementId)
    },
    undefined,
    { silent: true },
  ))
  return s.queue
}

/** Throttled card-summary update. The summary text is what Feishu shows
 * in the chat list as the message preview. We coalesce writes on a
 * SUMMARY_FLUSH_MS window so assistant deltas don't blow up
 * the settings-PATCH endpoint. Whitespace is collapsed and the input
 * is trimmed; empty content is ignored. */
export function patchSummaryThrottled(cardId: string, content: string): void {
  if (disposedCards.has(cardId) || cards.get(cardId)?.writeDead) return
  const trimmed = (content ?? '').replace(/\s+/g, ' ').trim()
  if (!trimmed) return
  let s = summaryStates.get(cardId)
  if (!s) {
    s = { latest: trimmed, lastSent: '', timer: null }
    summaryStates.set(cardId, s)
  } else {
    s.latest = trimmed
  }
  if (s.timer) return
  s.timer = setTimeout(() => {
    const st = summaryStates.get(cardId)
    if (!st) return
    if (disposedCards.has(cardId)) { summaryStates.delete(cardId); return }
    st.timer = null
    if (st.latest === st.lastSent) return
    const toSend = st.latest
    // lastSent 只在 PATCH 确认落地后记录:超时/拒绝时保持原值,让同一
    // summary 的下一次投递可以重发,而不是被 latest===lastSent 挡死
    // (上游 ec149d7)。current === st 防 dispose→重开卡窗口里误写新状态。
    void patchSettingsChecked(cardId, { config: { summary: { content: toSend } } })
      .then(landed => {
        const current = summaryStates.get(cardId)
        if (landed && current === st) current.lastSent = toSend
      })
  }, SUMMARY_FLUSH_MS)
}

/** Cancel any pending throttled summary write. Call before emitting
 * a terminal summary (e.g. "✅ ⏱ 12.3s · 4.2K tokens") so a stale
 * in-flight update can't fire after and clobber the final preview. */
export function cancelSummary(cardId: string): void {
  const s = summaryStates.get(cardId)
  if (!s) return
  if (s.timer) { clearTimeout(s.timer); s.timer = null }
  summaryStates.delete(cardId)
}

/** Patch settings — used to flip streaming_mode off when a turn finishes.
 *
 * `nextSeq` is called inside the queued task (not at enqueue time) to
 * match addElement/replaceElement/deleteElement above. Mixing
 * call-time and execution-time seq allocation interleaves badly: a
 * patchSettings enqueued right after a replaceElement would grab the
 * smaller seq number, but the replaceElement's then-block would grab
 * the larger one when it ran first, so the patchSettings PATCH lands
 * with a stale seq and Feishu rejects 300317 "sequence number compare
 * failed". Keeping all writes on execution-time allocation makes the
 * seq order match the queue order. */
export function patchSettings(
  cardId: string,
  settings: object,
  onFailure?: CardWriteFailureHandler,
): Promise<void> {
  return patchSettingsChecked(cardId, settings, onFailure).then(() => {})
}

/** Checked settings mutation for terminal/static-card transactions. Unlike
 * the legacy fire-and-forget wrapper, callers can distinguish a landed PATCH
 * from a timeout/rejection and must not dispose bookkeeping on false
 * (上游 ec149d7). 本地适配:保留 elevateCardFailure=false —— settings
 * PATCH(streaming_off / summary)不是容量信号,失败不得进 card-level
 * onFailure 烧换卡额度(2026-07-25/26 网络抖动教训);per-call onFailure
 * 契约照旧。300309/200850 过期流走 reopen+重试(上游同步引入)。 */
export async function patchSettingsChecked(
  cardId: string,
  settings: object,
  onFailure?: CardWriteFailureHandler,
): Promise<boolean> {
  if (disposedCards.has(cardId)) return false
  const s = state(cardId)
  if (s.writeDead) {
    onFailure?.()
    return false
  }
  let landed = false
  let failed = false
  s.queue = s.queue.then(() => withReopenOnStreamingClosed(
    cardId,
    'patchSettings',
    async () => {
      if (disposedCards.has(cardId) || s.writeDead) {
        onFailure?.()
        return
      }
      const seq = nextSeq(cardId)
      await call('PATCH', `/cards/${cardId}/settings`, {
        settings: JSON.stringify(settings),
        sequence: seq,
      })
      landed = true
    },
    (code, meta) => {
      failed = true
      onFailure?.(code, meta)
    },
    { elevateCardFailure: false },
  ))
  await s.queue
  return landed && !failed && !disposedCards.has(cardId) && !s.writeDead
}

/** Drop in-memory bookkeeping for a finished card. Tombstones the id so
 * late async writers can't re-create state and write to the closed card. */
export async function dispose(cardId: string): Promise<void> {
  const s = cards.get(cardId)
  if (!s) {
    rememberDisposedCard(cardId)
    cancelSummary(cardId)
    return
  }
  await flush(cardId)
  await s.queue
  cards.delete(cardId)
  rememberDisposedCard(cardId)
  cancelSummary(cardId)
}
