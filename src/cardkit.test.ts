import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

mock.module('./feishu', () => ({
  getTenantToken: async () => 'tenant-token',
}))

const cardkit = await import('./cardkit')

interface FetchCall {
  method: string
  path: string
  body: any
}

const originalFetch = globalThis.fetch
let calls: FetchCall[] = []

beforeEach(() => {
  calls = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({
      method: String(init?.method ?? 'GET'),
      path: url.pathname.replace('/open-apis/cardkit/v1', ''),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    return new Response(JSON.stringify({ code: 0, data: {} }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('cardkit streaming finalization', () => {
  test('staticizes a buffered streaming markdown element by deleting it before adding the final element', async () => {
    const cardId = 'card_staticize_race'
    const streamId = 'assistant_0'
    const staticId = 'assistant_0_static'
    const content = 'complete mid-turn assistantMessage'

    cardkit.recordCardCreated(cardId, 1)
    cardkit.streamTextThrottled(cardId, streamId, content)
    const staticize = cardkit.staticizeMarkdownElement(cardId, streamId, staticId, content, 'footer')

    await cardkit.flush(cardId)
    await staticize
    await cardkit.dispose(cardId)

    const deleteIdx = calls.findIndex(call =>
      call.method === 'DELETE' &&
      call.path === `/cards/${cardId}/elements/${streamId}`
    )
    const addIdx = calls.findIndex(call =>
      call.method === 'POST' &&
      call.path === `/cards/${cardId}/elements`
    )
    expect(deleteIdx).toBeGreaterThanOrEqual(0)
    expect(addIdx).toBeGreaterThan(deleteIdx)

    const add = calls[addIdx]
    expect(add?.body.type).toBe('insert_before')
    expect(add?.body.target_element_id).toBe('footer')
    expect(JSON.parse(add?.body.elements ?? '[]')).toEqual([{
      tag: 'markdown',
      element_id: staticId,
      content,
    }])

    expect(calls.some(call =>
      call.method === 'PUT' &&
      call.path === `/cards/${cardId}/elements/${streamId}/content`
    )).toBe(false)
  })

  test('delete marks an element dead before a later buffered flush can write it again', async () => {
    const cardId = 'card_delete_race'
    const streamId = 'assistant_0'

    cardkit.recordCardCreated(cardId, 1)
    cardkit.streamTextThrottled(cardId, streamId, 'stale text')
    const deleted = cardkit.deleteElement(cardId, streamId)

    await cardkit.flush(cardId)
    await deleted
    await cardkit.dispose(cardId)

    expect(calls.some(call =>
      call.method === 'DELETE' &&
      call.path === `/cards/${cardId}/elements/${streamId}`
    )).toBe(true)
    expect(calls.some(call =>
      call.method === 'PUT' &&
      call.path === `/cards/${cardId}/elements/${streamId}/content`
    )).toBe(false)
  })
})
