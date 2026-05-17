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
 *   - text-streaming PUTs are batched on a 120ms / 32-char heuristic to
 *     stay well under cardkit's per-card rate ceiling
 */

import { getTenantToken } from './feishu'
import { log } from './log'

const BASE = 'https://open.feishu.cn/open-apis/cardkit/v1'

const FLUSH_INTERVAL_MS = 120
const FLUSH_MIN_DELTA = 32

interface CardState {
  sequence: number
  queue: Promise<void>
  buffer: Map<string, string>          // element_id → latest full text
  lastSent: Map<string, string>        // element_id → text last actually PUT
  flushTimer: ReturnType<typeof setTimeout> | null
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
      lastSent: new Map(),
      flushTimer: null,
    }
    cards.set(cardId, s)
  }
  return s
}

function nextSeq(cardId: string): number {
  const s = state(cardId)
  s.sequence += 1
  return s.sequence
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

function isStreamingClosed(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as any).code === 300309
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
 * (Feishu auto-closed streaming after the 10-minute TTL), reopen
 * streaming inline and retry `op` exactly once. Anything else — non-
 * 300309 failure, reopen failure, retry failure — is logged and
 * swallowed, matching the fire-and-forget contract every cardkit op
 * already has at the call sites. */
async function withReopenOnStreamingClosed(
  cardId: string,
  label: string,
  op: () => Promise<void>,
  onFailure?: () => void,
): Promise<void> {
  try {
    await op()
    return
  } catch (e) {
    if (!isStreamingClosed(e)) {
      log(`cardkit ${label} ${cardId}: ${e}`)
      if (onFailure) onFailure()
      return
    }
    log(`cardkit ${label} ${cardId}: streaming closed (300309) — reopening`)
  }
  try {
    await reopenStreaming(cardId)
  } catch (re) {
    log(`cardkit STREAMING_REOPEN_FAILED ${cardId}: ${re}`)
    if (onFailure) onFailure()
    return
  }
  try {
    await op()
  } catch (e2) {
    log(`cardkit ${label} ${cardId} retry-after-reopen: ${e2}`)
    if (onFailure) onFailure()
  }
}

/** Convert a sent interactive message into a card entity. */
export async function convertMessageToCard(messageId: string): Promise<string> {
  const data = await call('POST', '/cards/id_convert', { message_id: messageId })
  return data.card_id
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
  s.queue = s.queue.then(() => withReopenOnStreamingClosed(
    cardId,
    `streamText ${elementId}`,
    async () => {
      const seq = nextSeq(cardId)
      await call('PUT', `/cards/${cardId}/elements/${elementId}/content`, {
        content, sequence: seq,
      })
      s.lastSent.set(elementId, content)
    },
  ))
  return s.queue
}

/** Throttled streaming: buffer + auto-flush every FLUSH_INTERVAL_MS or
 * when the buffered delta crosses FLUSH_MIN_DELTA characters. */
export function streamTextThrottled(cardId: string, elementId: string, fullContent: string): void {
  if (!fullContent || !fullContent.trim()) return
  const s = state(cardId)
  s.buffer.set(elementId, fullContent)

  const last = s.lastSent.get(elementId) ?? ''
  const delta = fullContent.length - last.length
  if (delta >= FLUSH_MIN_DELTA) {
    flush(cardId).catch(e => log(`cardkit flush(min-delta) ${cardId}: ${e}`))
    return
  }
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
    if (s.lastSent.get(eid) === text) continue
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
  onFailure?: () => void,
): Promise<void> {
  const s = state(cardId)
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
    },
    onFailure,
  ))
  return s.queue
}

/** Replace an entire element (used to swap a tool placeholder with its result). */
export function replaceElement(cardId: string, elementId: string, element: object): Promise<void> {
  const s = state(cardId)
  s.queue = s.queue.then(() => withReopenOnStreamingClosed(
    cardId,
    `replaceElement ${elementId}`,
    async () => {
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
  s.queue = s.queue.then(() => withReopenOnStreamingClosed(
    cardId,
    `deleteElement ${elementId}`,
    async () => {
      const seq = nextSeq(cardId)
      await call('DELETE', `/cards/${cardId}/elements/${elementId}`, {
        sequence: seq,
      })
    },
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
