/**
 * Feishu Card Kit v1 wrapper.
 *
 * Endpoints used (base = https://open.feishu.cn/open-apis/cardkit/v1):
 *   POST   /cards/id_convert                              message_id → card_id
 *   POST   /cards                                         create a card entity
 *   PUT    /cards/:card_id/elements/:element_id/content   stream text (typewriter)
 *   POST   /cards/:card_id/elements                       add element
 *   PUT    /cards/:card_id/elements/:element_id           replace element
 *   DELETE /cards/:card_id/elements/:element_id           remove element
 *   PATCH  /cards/:card_id/settings                       toggle streaming_mode etc.
 *
 * Per-card invariants enforced here:
 *   - `sequence` is monotonically increasing per card_id
 *   - all writes for a card are serialized through a Promise queue
 *   - text-streaming PUTs are batched on a 2s cadence to stay well under
 *     cardkit's per-card rate ceiling when many project sessions stream at once
 */

import { getTenantToken } from './feishu'
import { log } from './log'

const BASE = 'https://open.feishu.cn/open-apis/cardkit/v1'

const FLUSH_INTERVAL_MS = 2000
const ID_CONVERT_RETRY_DELAYS_MS = [0, 250, 750, 1500]

interface CardState {
  sequence: number
  queue: Promise<void>
  buffer: Map<string, string>          // element_id → latest full text
  /** element_id → 最近一次「已入队 PUT」的全量内容。关键:是"已入队"而非
   * "已送达" —— 在 streamText 入队时同步写,不是 PUT 完成后写。
   * flush 去重读它,所以它必须同步反映"我已经决定要发到哪",否则 block stop
   * 直接 PUT 完整内容后,后续定时 flush 还会重复发同一帧。 */
  lastEnqueued: Map<string, string>
  flushTimer: ReturnType<typeof setTimeout> | null
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
   * side and every subsequent `streamText`/`replaceElement`/`deleteElement`
   * would 300313/300121. It also covers streaming assistant elements that
   * have been deliberately replaced by static markdown and deleted. Per-card
   * and dropped on `dispose`, so a rotated-to fresh card starts clean. */
  deadElements: Set<string>
  /** Card-level write-failure callback, set by recordCardCreated. Invoked
   * by any cardkit write op that fails even after the streaming-closed
   * reopen+retry; the session uses it to rotate onto a fresh card (see
   * Session.onCardWriteFailure). Not fired for deletes (a failed delete is
   * harmless — it doesn't block new content). */
  onFailure?: (code?: number) => void
}

/** Feishu's element-ceiling rejection. `300315` wraps the inner
 * `300305 [element exceeds the limit]`; treat both as "card is full".
 * Exported so session can turn an add failure into a forced rotate
 * without re-encoding the magic numbers. */
export function isElementLimitCode(code?: number): boolean {
  return code === 300305 || code === 300315
}

const cards = new Map<string, CardState>()

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
      buffer: new Map(),
      lastEnqueued: new Map(),
      flushTimer: null,
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
 * triggers a mid-turn rotate to dodge `code=300305/300315`. */
export function recordCardCreated(
  cardId: string,
  initialElementCount: number,
  onFailure?: (code?: number) => void,
): void {
  const s = state(cardId)
  s.elementCount = initialElementCount
  s.onFailure = onFailure
}

/** Read the live element count maintained by addElement/deleteElement.
 * Returns 0 if the card has no state yet (which is also the right answer
 * for "this card has no elements that we know about"). */
export function getElementCount(cardId: string): number {
  return cards.get(cardId)?.elementCount ?? 0
}

/** True if `elementId` was recorded dead on this card (its addElement was
 * rejected, so the element doesn't exist on Feishu). Mid-turn rotation
 * reads this to decide whether the just-failed assistant segment needs
 * rebuilding on the fresh card: dead ⇒ rebuild (its text never made it
 * onto the old card), alive ⇒ leave it, the old card already shows it. */
export function isDeadElement(cardId: string, elementId: string): boolean {
  return cards.get(cardId)?.deadElements.has(elementId) ?? false
}

function nextSeq(cardId: string): number {
  const s = state(cardId)
  s.sequence += 1
  return s.sequence
}

function markElementDead(s: CardState, elementId: string): void {
  s.deadElements.add(elementId)
  s.buffer.delete(elementId)
  s.lastEnqueued.delete(elementId)
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

/** Run `op` inside the per-card queue. If it fails with code=300309
 * or 200850 (Feishu auto-closed / timed-out streaming after the 10-
 * minute TTL), reopen streaming inline and retry `op` exactly once.
 * Anything else — other failure, reopen failure, retry failure — is
 * logged and swallowed, matching the fire-and-forget contract every
 * cardkit op already has at the call sites. */
async function withReopenOnStreamingClosed(
  cardId: string,
  label: string,
  op: () => Promise<void>,
  onFailure?: (code?: number) => void,
  silent = false,
): Promise<void> {
  // 失败统一出口:card-level handler 先(它同步快照当前段/tool 后再异步
  // 换卡),per-call onFailure 后(addElement 的 deadElements.add + session
  // 段游标 reset)。顺序要紧 —— 换卡的同步快照必须在 reset 把
  // currentAssistant* 清空之前跑。silent(deleteElement)跳过 card-level:
  // 删不掉一个元素不影响新内容,不值得为它换卡。
  const fail = (code?: number): void => {
    if (!silent) state(cardId).onFailure?.(code)
    onFailure?.(code)
  }
  try {
    await op()
    return
  } catch (e) {
    if (!isStreamingClosed(e)) {
      log(`cardkit ${label} ${cardId}: ${e}`)
      fail((e as any)?.code)
      return
    }
    log(`cardkit ${label} ${cardId}: streaming closed (code=${(e as any).code}) — reopening`)
  }
  try {
    await reopenStreaming(cardId)
  } catch (re) {
    log(`cardkit STREAMING_REOPEN_FAILED ${cardId}: ${re}`)
    fail((re as any)?.code)
    return
  }
  try {
    await op()
  } catch (e2) {
    log(`cardkit ${label} ${cardId} retry-after-reopen: ${e2}`)
    fail((e2 as any)?.code)
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
  return data.card_id
}

/** PUT element content (full text) — triggers typewriter on prefix-match.
 *
 * NOTE: CardKit rejects empty-string content with code 99992402 ("field
 * validation failed"); we drop empty/whitespace-only writes here so callers
 * can stream naively without per-call empty checks. */
export function streamText(cardId: string, elementId: string, content: string): Promise<void> {
  if (!content || !content.trim()) return Promise.resolve()
  const s = state(cardId)
  // 死元素(addElement 被飞书拒过,元素根本不存在)直接吞掉:再 PUT 只会
  // 300313,而 streamTextThrottled 每个 delta 都重发全文,会把一个建失败的段
  // 放大成一串红。等 rotation 把 turn 切到新卡,新段就正常了。
  if (s.deadElements.has(elementId)) return Promise.resolve()
  // 「已入队」位置必须在这里同步推进,而不是等 PUT 完成。这样 block stop
  // 的直接完整 PUT 可以让后续定时 flush 通过 lastEnqueued 去重跳过同一帧。
  // 全量 PUT 自带自愈:某次 PUT 失败会被下一个更长的全量覆盖,所以提前把
  // 「已入队」前移是安全的(失败的内容不会永久丢,除非它正好是最后一帧 ——
  // 那种情况由 content_block_stop / closeTurnCard 的兜底 flush 覆盖)。
  s.lastEnqueued.set(elementId, content)
  s.queue = s.queue.then(() => withReopenOnStreamingClosed(
    cardId,
    `streamText ${elementId}`,
    async () => {
      if (s.deadElements.has(elementId)) return
      const seq = nextSeq(cardId)
      await call('PUT', `/cards/${cardId}/elements/${elementId}/content`, {
        content, sequence: seq,
      })
    },
  ))
  return s.queue
}

/** Throttled streaming: buffer latest full text and auto-flush on a
 * per-card timer. Block boundaries call streamText directly to push the
 * final frame immediately without changing the steady-state cadence. */
export function streamTextThrottled(cardId: string, elementId: string, fullContent: string): void {
  if (!fullContent || !fullContent.trim()) return
  const s = state(cardId)
  if (s.deadElements.has(elementId)) return
  s.buffer.set(elementId, fullContent)

  if (!s.flushTimer) {
    s.flushTimer = setTimeout(() => {
      flush(cardId).catch(e => log(`cardkit flush(timer) ${cardId}: ${e}`))
    }, FLUSH_INTERVAL_MS)
  }
}

/** Force an immediate flush of the buffered streams for a card. */
export async function flush(cardId: string): Promise<void> {
  const s = cards.get(cardId)
  if (!s) return
  if (s.flushTimer) { clearTimeout(s.flushTimer); s.flushTimer = null }
  const pending = [...s.buffer.entries()]
  s.buffer.clear()
  for (const [eid, text] of pending) {
    if (s.lastEnqueued.get(eid) === text) continue
    await streamText(cardId, eid, text)
  }
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
  onFailure?: (code?: number) => void,
): Promise<void> {
  const s = state(cardId)
  const elementId = (element as { element_id?: string }).element_id
  s.queue = s.queue.then(() => withReopenOnStreamingClosed(
    cardId,
    `addElement`,
    async () => {
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
    },
    (code) => {
      // Add rejected ⇒ this element_id does not exist on Feishu's side.
      // Mark it dead so subsequent streamText/replace/delete aimed at it
      // short-circuit instead of spraying 300313/300121. Then forward the
      // code: session turns an element-limit code into a forced mid-turn
      // rotate (the local counter can't be trusted here — a failed add
      // doesn't bump it, so it never reaches the rotate threshold on its
      // own).
      if (elementId) markElementDead(s, elementId)
      onFailure?.(code)
    },
  ))
  return s.queue
}

/** Freeze a streaming markdown element by deleting the old streaming element
 * first, then inserting a new static markdown element before the provided
 * stable sibling.
 * This avoids toggling whole-card streaming_mode mid-turn while still making
 * completed assistant blocks fully visible before tools or later blocks land.
 */
export function staticizeMarkdownElement(
  cardId: string,
  elementId: string,
  staticElementId: string,
  content: string,
  insertBeforeElementId: string,
): Promise<void> {
  if (!content || !content.trim()) return Promise.resolve()
  const s = state(cardId)
  if (s.deadElements.has(elementId)) return Promise.resolve()
  const element = {
    tag: 'markdown',
    element_id: staticElementId,
    content: content.trim() || ' ',
  }
  s.queue = s.queue.then(async () => {
    if (s.deadElements.has(elementId)) return
    let deleted = false
    await withReopenOnStreamingClosed(
      cardId,
      `staticizeElement delete-old ${elementId}`,
      async () => {
        if (s.deadElements.has(elementId)) return
        const deleteSeq = nextSeq(cardId)
        await call('DELETE', `/cards/${cardId}/elements/${elementId}`, {
          sequence: deleteSeq,
        })
        deleted = true
      },
      undefined,
      true,
    )
    if (!deleted) return
    s.elementCount = Math.max(0, s.elementCount - 1)
    markElementDead(s, elementId)

    await withReopenOnStreamingClosed(
      cardId,
      `staticizeElement add-final ${staticElementId}`,
      async () => {
        const addSeq = nextSeq(cardId)
        await call('POST', `/cards/${cardId}/elements`, {
          type: 'insert_before',
          target_element_id: insertBeforeElementId,
          elements: JSON.stringify([element]),
          sequence: addSeq,
        })
        s.elementCount += 1
      },
    )
  })
  return s.queue
}

/** Replace an entire element (used to swap a tool placeholder with its result). */
export function replaceElement(cardId: string, elementId: string, element: object): Promise<void> {
  const s = state(cardId)
  if (s.deadElements.has(elementId)) return Promise.resolve()
  s.queue = s.queue.then(() => withReopenOnStreamingClosed(
    cardId,
    `replaceElement ${elementId}`,
    async () => {
      if (s.deadElements.has(elementId)) return
      const seq = nextSeq(cardId)
      await call('PUT', `/cards/${cardId}/elements/${elementId}`, {
        element: JSON.stringify(element),
        sequence: seq,
      })
    },
  ))
  return s.queue
}

/** Delete an element by id. */
export function deleteElement(cardId: string, elementId: string): Promise<void> {
  const s = state(cardId)
  if (s.deadElements.has(elementId)) return Promise.resolve()
  s.queue = s.queue.then(() => withReopenOnStreamingClosed(
    cardId,
    `deleteElement ${elementId}`,
    async () => {
      if (s.deadElements.has(elementId)) return
      const seq = nextSeq(cardId)
      await call('DELETE', `/cards/${cardId}/elements/${elementId}`, {
        sequence: seq,
      })
      s.elementCount = Math.max(0, s.elementCount - 1)
      markElementDead(s, elementId)
    },
    undefined,
    true,
  ))
  return s.queue
}

/** Throttled card-summary update. The summary text is what Feishu shows
 * in the chat list as the message preview. We coalesce writes on a
 * SUMMARY_FLUSH_MS window so streaming assistant deltas don't blow up
 * the settings-PATCH endpoint. Whitespace is collapsed and the input
 * is trimmed; empty content is ignored. */
export function patchSummaryThrottled(cardId: string, content: string): void {
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
    st.timer = null
    if (st.latest === st.lastSent) return
    const toSend = st.latest
    st.lastSent = toSend
    void patchSettings(cardId, { config: { summary: { content: toSend } } })
  }, SUMMARY_FLUSH_MS)
}

/** Cancel any pending throttled summary write. Call before emitting
 * a terminal summary (e.g. "✅ ⏱ 12.3s · 4.2K tokens") so a stale
 * mid-stream tail can't fire after and clobber the final preview. */
export function cancelSummary(cardId: string): void {
  const s = summaryStates.get(cardId)
  if (!s) return
  if (s.timer) { clearTimeout(s.timer); s.timer = null }
  summaryStates.delete(cardId)
}

/** Patch settings — used to flip streaming_mode off when a turn finishes.
 *
 * `nextSeq` is called inside the queued task (not at enqueue time) to
 * match streamText/addElement/replaceElement/deleteElement above. Mixing
 * call-time and execution-time seq allocation interleaves badly: a
 * patchSettings enqueued right after a replaceElement would grab the
 * smaller seq number, but the replaceElement's then-block would grab
 * the larger one when it ran first, so the patchSettings PATCH lands
 * with a stale seq and Feishu rejects 300317 "sequence number compare
 * failed". Keeping all writes on execution-time allocation makes the
 * seq order match the queue order. */
export function patchSettings(cardId: string, settings: object): Promise<void> {
  const s = state(cardId)
  s.queue = s.queue.then(async () => {
    try {
      const seq = nextSeq(cardId)
      await call('PATCH', `/cards/${cardId}/settings`, {
        settings: JSON.stringify(settings),
        sequence: seq,
      })
    } catch (e) { log(`cardkit patchSettings ${cardId}: ${e}`) }
  })
  return s.queue
}

/** Drop in-memory bookkeeping for a finished card. */
export async function dispose(cardId: string): Promise<void> {
  const s = cards.get(cardId)
  if (!s) return
  await flush(cardId)
  await s.queue
  cards.delete(cardId)
  cancelSummary(cardId)
}
