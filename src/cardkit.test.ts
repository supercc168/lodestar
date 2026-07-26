import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
// 注册共享 ./feishu mock(见该文件头注释:多文件各自 mock 会互相覆盖)
import './feishu-test-mock'

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

describe('cardkit write-dead card', () => {
  test('markCardWriteDead makes all subsequent writes no-ops', async () => {
    cardkit.recordCardCreated('card_wd', 3)
    cardkit.markCardWriteDead('card_wd')

    await cardkit.addElement('card_wd', { tag: 'markdown', element_id: 'e1', content: 'x' })
    await cardkit.replaceElement('card_wd', 'footer', { tag: 'markdown', element_id: 'footer', content: 'x' })
    await cardkit.deleteElement('card_wd', 'e1')
    await cardkit.patchSettings('card_wd', { config: {} })

    expect(calls.length).toBe(0)
    expect(cardkit.getElementCount('card_wd')).toBe(3)
    await cardkit.dispose('card_wd')
  })
})

describe('cardkit terminal write failure observation', () => {
  /** 只让下一次 Card Kit HTTP 调用失败(返回指定 code),之后恢复默认 mock。 */
  function failNextCardKitCall(code: number): void {
    const previousFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      globalThis.fetch = previousFetch
      const url = new URL(String(input))
      calls.push({
        method: String(init?.method ?? 'GET'),
        path: url.pathname.replace('/open-apis/cardkit/v1', ''),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return new Response(JSON.stringify({ code, msg: `injected failure ${code}` }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch
  }

  const footer = () => ({ tag: 'markdown', element_id: 'footer', content: '✅ 完成' })

  test('replaceElement reports API failure, write-dead, and dead-element short circuits', async () => {
    const failures: Array<number | undefined> = []

    cardkit.recordCardCreated('card_replace_fail', 2)
    failNextCardKitCall(300313)
    await cardkit.replaceElement('card_replace_fail', 'footer', footer(), code => failures.push(code))

    cardkit.recordCardCreated('card_replace_dead', 2)
    cardkit.markCardWriteDead('card_replace_dead')
    await cardkit.replaceElement('card_replace_dead', 'footer', footer(), code => failures.push(code))

    cardkit.recordCardCreated('card_replace_element_dead', 1)
    failNextCardKitCall(300305)
    await cardkit.addElement('card_replace_element_dead', footer(), {}, () => {})
    await cardkit.replaceElement('card_replace_element_dead', 'footer', footer(), code => failures.push(code))

    expect(failures).toEqual([300313, undefined, undefined])
    await cardkit.dispose('card_replace_fail')
    await cardkit.dispose('card_replace_dead')
    await cardkit.dispose('card_replace_element_dead')
  })

  test('patchSettings reports API failure and write-dead short circuit', async () => {
    const failures: Array<number | undefined> = []

    cardkit.recordCardCreated('card_patch_fail', 1)
    failNextCardKitCall(300317)
    await cardkit.patchSettings('card_patch_fail', { config: {} }, code => failures.push(code))

    cardkit.recordCardCreated('card_patch_dead', 1)
    cardkit.markCardWriteDead('card_patch_dead')
    await cardkit.patchSettings('card_patch_dead', { config: {} }, code => failures.push(code))

    expect(failures).toEqual([300317, undefined])
    await cardkit.dispose('card_patch_fail')
    await cardkit.dispose('card_patch_dead')
  })

  test('successful terminal writes do not invoke the failure callback', async () => {
    const failures: Array<number | undefined> = []
    cardkit.recordCardCreated('card_terminal_ok', 2)

    await cardkit.replaceElement('card_terminal_ok', 'footer', footer(), code => failures.push(code))
    await cardkit.patchSettings('card_terminal_ok', { config: {} }, code => failures.push(code))

    expect(failures).toEqual([])
    expect(calls.filter(call => call.path === '/cards/card_terminal_ok/elements/footer')).toHaveLength(1)
    expect(calls.filter(call => call.path === '/cards/card_terminal_ok/settings')).toHaveLength(1)
    await cardkit.dispose('card_terminal_ok')
  })
})

describe('cardkit capacity codes', () => {
  test('classifies element-count and total-size ceilings', () => {
    expect(cardkit.isElementLimitCode(300305)).toBe(true)
    expect(cardkit.isElementLimitCode(300315)).toBe(true)
    expect(cardkit.isElementLimitCode(200860)).toBe(false)

    expect(cardkit.isCardSizeLimitCode(200860)).toBe(true)
    expect(cardkit.isCardSizeLimitCode(300305)).toBe(false)

    expect(cardkit.isCardCapacityCode(300305)).toBe(true)
    expect(cardkit.isCardCapacityCode(200860)).toBe(true)
    expect(cardkit.isCardCapacityCode(300308)).toBe(false)
  })

  test('classifies pure transport failures as network', () => {
    expect(cardkit.isNetworkError(new TypeError('fetch failed'))).toBe(true)
    expect(cardkit.isNetworkError(new Error('socket hang up'))).toBe(true)
    const apiErr = new Error('cardkit PUT: code=300308') as Error & { code: number }
    apiErr.code = 300308
    expect(cardkit.isNetworkError(apiErr)).toBe(false)
    expect(cardkit.isNetworkError(null)).toBe(true)
  })
})

describe('cardkit network retry and footer isolation', () => {
  test('retries network transport failures then succeeds without elevating card failure', async () => {
    const failures: Array<{ code?: number; kind?: string }> = []
    let attempt = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({
        method: String(init?.method ?? 'GET'),
        path: url.pathname.replace('/open-apis/cardkit/v1', ''),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      attempt++
      if (attempt === 1) throw new TypeError('fetch failed')
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    cardkit.recordCardCreated('card_net_retry', 1, (code, meta) => {
      failures.push({ code, kind: meta?.kind })
    })
    await cardkit.addElement('card_net_retry', {
      tag: 'markdown', element_id: 'assistant_0', content: 'recovered',
    }, { type: 'insert_before', targetElementId: 'footer' })

    expect(attempt).toBe(2)
    expect(failures).toEqual([])
    expect(cardkit.getElementCount('card_net_retry')).toBe(2)
    await cardkit.dispose('card_net_retry')
  })

  test('exhausted network retries report kind=network without rotating content path', async () => {
    const failures: Array<{ code?: number; kind?: string }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({
        method: String(init?.method ?? 'GET'),
        path: url.pathname.replace('/open-apis/cardkit/v1', ''),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      throw new TypeError('fetch failed')
    }) as typeof fetch

    cardkit.recordCardCreated('card_net_exhaust', 1, (code, meta) => {
      failures.push({ code, kind: meta?.kind })
    })
    await cardkit.addElement('card_net_exhaust', {
      tag: 'markdown', element_id: 'assistant_net', content: 'x',
    })

    // 1 initial + 2 retries = 3 attempts
    expect(calls.filter(c => c.path === '/cards/card_net_exhaust/elements')).toHaveLength(3)
    expect(failures).toEqual([{ code: undefined, kind: 'network' }])
    expect(cardkit.getElementCount('card_net_exhaust')).toBe(1)
    await cardkit.dispose('card_net_exhaust')
  })

  test('footer replaceElement failures do not elevate to card-level onFailure', async () => {
    const cardFailures: Array<number | undefined> = []
    const callFailures: Array<{ code?: number; kind?: string }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({
        method: String(init?.method ?? 'GET'),
        path: url.pathname.replace('/open-apis/cardkit/v1', ''),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return new Response(JSON.stringify({ code: 300308, msg: 'footer reject' }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    cardkit.recordCardCreated('card_footer_iso', 2, code => cardFailures.push(code))
    await cardkit.replaceElement(
      'card_footer_iso',
      'footer',
      { tag: 'markdown', element_id: 'footer', content: 'Writing(1s)' },
      (code, meta) => callFailures.push({ code, kind: meta?.kind }),
    )

    expect(cardFailures).toEqual([])
    expect(callFailures).toEqual([{ code: 300308, kind: 'api' }])
    await cardkit.dispose('card_footer_iso')
  })

  test('non-footer replaceElement failures still elevate to card-level onFailure', async () => {
    const cardFailures: Array<{ code?: number; kind?: string }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({
        method: String(init?.method ?? 'GET'),
        path: url.pathname.replace('/open-apis/cardkit/v1', ''),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return new Response(JSON.stringify({ code: 300308, msg: 'assistant reject' }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    cardkit.recordCardCreated('card_assistant_fail', 2, (code, meta) => {
      cardFailures.push({ code, kind: meta?.kind })
    })
    await cardkit.replaceElement('card_assistant_fail', 'assistant_0', {
      tag: 'markdown', element_id: 'assistant_0', content: 'x',
    })

    expect(cardFailures).toEqual([{ code: 300308, kind: 'api' }])
    await cardkit.dispose('card_assistant_fail')
  })

  test('successful addElement invokes onSuccess after recovery', async () => {
    let successes = 0
    cardkit.recordCardCreated('card_onsuccess', 1, undefined, () => { successes++ })
    await cardkit.addElement('card_onsuccess', {
      tag: 'markdown', element_id: 'assistant_ok', content: 'ok',
    })
    expect(successes).toBe(1)
    // footer replace must not fire onSuccess
    await cardkit.replaceElement('card_onsuccess', 'footer', {
      tag: 'markdown', element_id: 'footer', content: 'tick',
    })
    expect(successes).toBe(1)
    await cardkit.dispose('card_onsuccess')
  })
})
