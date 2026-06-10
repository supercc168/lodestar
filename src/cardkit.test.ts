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

describe('cardkit card operations', () => {
  test('retries id_convert when Feishu has not indexed the just-sent message yet', async () => {
    let attempt = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({
        method: String(init?.method ?? 'GET'),
        path: url.pathname.replace('/open-apis/cardkit/v1', ''),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      attempt++
      if (attempt === 1) {
        return new Response(JSON.stringify({
          code: 200740,
          msg: 'ErrMsg: queried result is empty;',
        }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({
        code: 0,
        data: { card_id: 'card_ready' },
      }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    await expect(cardkit.convertMessageToCard('om_recent', { retryDelaysMs: [0, 0] }))
      .resolves.toBe('card_ready')

    expect(calls.map(call => call.path)).toEqual(['/cards/id_convert', '/cards/id_convert'])
  })

  test('flush waits for queued card writes', async () => {
    const cardId = 'card_flush_queue'
    const element = { tag: 'markdown', element_id: 'assistant_0', content: 'complete assistantMessage' }

    cardkit.recordCardCreated(cardId, 1)
    const write = cardkit.addElement(cardId, element, {
      type: 'insert_before',
      targetElementId: 'footer',
    })

    await cardkit.flush(cardId)
    await write
    await cardkit.dispose(cardId)

    const add = calls.find(call =>
      call.method === 'POST' &&
      call.path === `/cards/${cardId}/elements`
    )
    expect(add?.body.type).toBe('insert_before')
    expect(add?.body.target_element_id).toBe('footer')
    expect(JSON.parse(add?.body.elements ?? '[]')).toEqual([element])
  })
})
