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
    throw new Error(`cardkit ${method} ${path}: code=${json.code} msg=${json.msg}`)
  }
  return json?.data
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
  const seq = nextSeq(cardId)
  s.queue = s.queue.then(async () => {
    try {
      await call('PUT', `/cards/${cardId}/elements/${elementId}/content`, {
        content, sequence: seq,
      })
      s.lastSent.set(elementId, content)
    } catch (e) {
      log(`cardkit streamText ${cardId}/${elementId}: ${e}`)
    }
  })
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

/** Add a new element to the card body or relative to a sibling. */
export function addElement(
  cardId: string,
  element: object,
  opts: { type?: 'append' | 'insert_before' | 'insert_after'; targetElementId?: string } = {},
): Promise<void> {
  const s = state(cardId)
  const seq = nextSeq(cardId)
  s.queue = s.queue.then(async () => {
    try {
      await call('POST', `/cards/${cardId}/elements`, {
        type: opts.type ?? 'append',
        ...(opts.targetElementId ? { target_element_id: opts.targetElementId } : {}),
        elements: JSON.stringify([element]),
        sequence: seq,
      })
    } catch (e) { log(`cardkit addElement ${cardId}: ${e}`) }
  })
  return s.queue
}

/** Replace an entire element (used to swap a tool placeholder with its result). */
export function replaceElement(cardId: string, elementId: string, element: object): Promise<void> {
  const s = state(cardId)
  const seq = nextSeq(cardId)
  s.queue = s.queue.then(async () => {
    try {
      await call('PUT', `/cards/${cardId}/elements/${elementId}`, {
        element: JSON.stringify(element),
        sequence: seq,
      })
    } catch (e) { log(`cardkit replaceElement ${cardId}/${elementId}: ${e}`) }
  })
  return s.queue
}

/** Delete an element by id. */
export function deleteElement(cardId: string, elementId: string): Promise<void> {
  const s = state(cardId)
  const seq = nextSeq(cardId)
  s.queue = s.queue.then(async () => {
    try {
      await call('DELETE', `/cards/${cardId}/elements/${elementId}`, {
        sequence: seq,
      })
    } catch (e) { log(`cardkit deleteElement ${cardId}/${elementId}: ${e}`) }
  })
  return s.queue
}

/** Patch settings — used to flip streaming_mode off when a turn finishes. */
export function patchSettings(cardId: string, settings: object): Promise<void> {
  const s = state(cardId)
  const seq = nextSeq(cardId)
  s.queue = s.queue.then(async () => {
    try {
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
}
