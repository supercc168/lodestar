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

describe('cardkit 错误码级写失败分类与 checked add (上游 4185808)', () => {
  test('classifies only a real nested 300305 as component capacity', () => {
    expect(cardkit.isElementLimitFailure(300305, { message: 'component limit' })).toBe(true)
    expect(cardkit.isElementLimitFailure(300315, {
      message: 'Failed to add element: inner code: 300305, element exceeds limit',
    })).toBe(true)
    expect(cardkit.isElementLimitFailure(300315, {
      message: 'Duplicate ID, inner code: 300301',
    })).toBe(false)
    expect(cardkit.isElementLimitFailure(300315, {
      message: 'elementID format error. Only alphabets, numbers, and underscores are allowed. It must start with an alphabet and not exceed 20 characters; code: 300301',
    })).toBe(false)
    expect(cardkit.isElementLimitFailure(300315, {
      message: 'number of elements in a column exceeds the maximum; code: 300301',
    })).toBe(false)
    expect(cardkit.isElementLimitFailure(300315, {
      message: 'number of card components exceeds the maximum limit',
    })).toBe(true)
    expect(cardkit.isElementLimitFailure(200570, { message: 'invalid image keys' })).toBe(false)
    expect(cardkit.isElementLimitFailure(300308, { message: 'server internal error' })).toBe(false)
    // 上游 9493684：300315 也可能包一层 200860 体积上限，须当容量失败。
    // 本地保留 isElementLimitFailure / isCardSizeLimitCode 拆分，不引入
    // isCardCapacityFailure 重命名。
    expect(cardkit.isCardSizeLimitCode(200860)).toBe(true)
    expect(cardkit.isCardSizeLimitFailure(200860, { message: 'ErrMsg: card over max size;' })).toBe(true)
    expect(cardkit.isCardSizeLimitFailure(300315, {
      message: 'Failed to add element: inner code: 200860, card over max size',
    })).toBe(true)
    expect(cardkit.isCardSizeLimitFailure(300315, {
      message: 'Failed to add element: ErrMsg: card over max size;',
    })).toBe(true)
    expect(cardkit.isCardSizeLimitFailure(300315, {
      message: 'Duplicate ID, inner code: 300301',
    })).toBe(false)
    expect(cardkit.isDuplicateElementFailure(300315, { message: 'Duplicate ID; code: 300301' })).toBe(true)
    expect(cardkit.isDuplicateElementFailure(300315, { message: 'elementID format error; code: 300301' })).toBe(false)
    expect(cardkit.isDuplicateElementFailure(300305, { message: 'Duplicate ID' })).toBe(false)
  })

  test('reports the failing card, operation, element, target and Feishu log id via meta.failure', async () => {
    const cardId = 'card_failure_context'
    let capturedCode: number | undefined
    let capturedKind: string | undefined
    let captured: any = null
    cardkit.recordCardCreated(cardId, 1, (code, meta) => {
      capturedCode = code
      capturedKind = meta?.kind
      captured = meta?.failure ?? null
    })
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 300315,
      msg: 'Duplicate ID; inner code: 300301',
    }), {
      headers: {
        'Content-Type': 'application/json',
        'x-tt-logid': 'log_card_failure_context',
      },
    })) as unknown as typeof fetch

    await cardkit.addElement(cardId, {
      tag: 'markdown', element_id: 'assistant_0', content: 'x',
    }, {
      type: 'insert_before', targetElementId: 'footer',
    })

    expect(capturedCode).toBe(300315)
    expect(capturedKind).toBe('api')
    expect(captured).toMatchObject({
      cardId,
      operation: 'addElement',
      elementId: 'assistant_0',
      targetElementId: 'footer',
      code: 300315,
      httpStatus: 200,
      logId: 'log_card_failure_context',
    })
    expect(captured.message).toContain('Duplicate ID')
    await cardkit.dispose(cardId)
  })

  test('serializes safe markdown while preserving structured image components (三挂点)', async () => {
    const cardId = 'card_markdown_image_boundary'
    cardkit.recordCardCreated(cardId, 1)
    await cardkit.addElement(cardId, {
      tag: 'column_set',
      element_id: 'assistant_0',
      columns: [{
        tag: 'column',
        elements: [
          { tag: 'markdown', content: 'bad ![x](img_key)' },
          { tag: 'img', img_key: 'img_v2_uploaded' },
        ],
      }],
    })

    const add = calls.find(call =>
      call.method === 'POST' && call.path === `/cards/${cardId}/elements`
    )
    const sent = JSON.parse(add?.body.elements ?? '[]')[0]
    expect(sent.columns[0].elements[0].content).not.toContain('![')
    expect(sent.columns[0].elements[0].content).toContain('img_key')
    expect(sent.columns[0].elements[1]).toEqual({ tag: 'img', img_key: 'img_v2_uploaded' })

    // replaceElement 同款挂点
    await cardkit.replaceElement(cardId, 'assistant_0', {
      tag: 'markdown', element_id: 'assistant_0', content: 'again ![y](img_v2_fake)',
    })
    const put = calls.find(call =>
      call.method === 'PUT' && call.path === `/cards/${cardId}/elements/assistant_0`
    )
    expect(JSON.parse(put?.body.element ?? '{}').content).not.toContain('![')

    // createCardEntity 同款挂点(卡片实体 JSON 序列化前)
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({
        method: String(init?.method ?? 'GET'),
        path: url.pathname.replace('/open-apis/cardkit/v1', ''),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return new Response(JSON.stringify({ code: 0, data: { card_id: 'card_entity_safe' } }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch
    await cardkit.createCardEntity({
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: 'inject ![z](img_v2_bad)' }] },
    })
    const create = calls.find(call => call.method === 'POST' && call.path === '/cards')
    expect(String(create?.body.data ?? '')).not.toContain('![')
    await cardkit.dispose(cardId)
  })

  test('addElementResult returns structured failure and duplicate-id reconciles via clearDeadElementForReconcile', async () => {
    const cardId = 'card_add_result'
    cardkit.recordCardCreated(cardId, 1)

    const ok = await cardkit.addElementResult(cardId, {
      tag: 'markdown', element_id: 'ctx_0', content: 'first',
    })
    expect(ok).toEqual({ landed: true })
    expect(cardkit.getElementCount(cardId)).toBe(2)

    let failNext = true
    const healthy = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (failNext) {
        failNext = false
        return new Response(JSON.stringify({
          code: 300315, msg: 'Failed to add element; Duplicate ID; code: 300301',
        }), { headers: { 'Content-Type': 'application/json' } })
      }
      return await healthy(input, init)
    }) as typeof fetch

    const dup = await cardkit.addElementResult(cardId, {
      tag: 'markdown', element_id: 'ctx_dup', content: 'again',
    })
    expect(dup.landed).toBe(false)
    expect(dup.failure?.code).toBe(300315)
    expect(cardkit.isDuplicateElementFailure(dup.failure?.code, dup.failure)).toBe(true)
    // 计数只在 API 返回 0 后自增:失败的 add 不动计数
    expect(cardkit.getElementCount(cardId)).toBe(2)
    expect(cardkit.isDeadElement(cardId, 'ctx_dup')).toBe(true)

    // duplicate-id 可能是"落了但 ACK 丢":对账允许一次 checked PUT
    cardkit.clearDeadElementForReconcile(cardId, 'ctx_dup')
    expect(cardkit.isDeadElement(cardId, 'ctx_dup')).toBe(false)
    const reconciled = await cardkit.replaceElementChecked(cardId, 'ctx_dup', {
      tag: 'markdown', element_id: 'ctx_dup', content: 'again',
    }, { notifyCardFailure: false })
    expect(reconciled).toBe(true)
    await cardkit.dispose(cardId)
  })

  test('landed addElement clears a stale dead marker for the same element id', async () => {
    const cardId = 'card_dead_clear'
    cardkit.recordCardCreated(cardId, 1)
    let failNext = true
    const healthy = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (failNext) {
        failNext = false
        return new Response(JSON.stringify({ code: 300308, msg: 'transient reject' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return await healthy(input, init)
    }) as typeof fetch

    await cardkit.addElement(cardId, { tag: 'markdown', element_id: 'seg_0', content: 'x' })
    expect(cardkit.isDeadElement(cardId, 'seg_0')).toBe(true)
    await cardkit.addElement(cardId, { tag: 'markdown', element_id: 'seg_0', content: 'x' })
    expect(cardkit.isDeadElement(cardId, 'seg_0')).toBe(false)
    expect(cardkit.getElementCount(cardId)).toBe(2)
    await cardkit.dispose(cardId)
  })
})

describe('cardkit checked settings PATCH and disposed-card guard (upstream ec149d7)', () => {
  test('patchSettingsChecked reports whether the terminal PATCH landed', async () => {
    const cardId = 'card_checked_settings'
    cardkit.recordCardCreated(cardId, 1)
    expect(await cardkit.patchSettingsChecked(cardId, { config: { streaming_mode: false } })).toBe(true)

    const okFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: 300308, msg: 'settings rejected' }), {
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
    expect(await cardkit.patchSettingsChecked(cardId, { config: { streaming_mode: false } })).toBe(false)
    // 失败不得清 bookkeeping:元素计数仍在,恢复后同卡可继续落地
    expect(cardkit.getElementCount(cardId)).toBe(1)
    globalThis.fetch = okFetch
    expect(await cardkit.patchSettingsChecked(cardId, { config: { streaming_mode: false } })).toBe(true)
    await cardkit.dispose(cardId)
  })

  test('patchSettingsChecked returns false when the PATCH times out unconfirmed', async () => {
    const cardId = 'card_checked_settings_net'
    cardkit.recordCardCreated(cardId, 1)
    globalThis.fetch = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
    expect(await cardkit.patchSettingsChecked(cardId, { config: { streaming_mode: false } })).toBe(false)
    expect(cardkit.getElementCount(cardId)).toBe(1)
    await cardkit.dispose(cardId)
  }, 10_000)

  test('patchSettingsChecked reopens an expired stream and retries once', async () => {
    const cardId = 'card_checked_settings_reopen'
    cardkit.recordCardCreated(cardId, 1)
    let attempt = 0
    globalThis.fetch = (async () => {
      attempt++
      return new Response(JSON.stringify(attempt === 1
        ? { code: 300309, msg: 'streaming mode is closed' }
        : { code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch
    expect(await cardkit.patchSettingsChecked(cardId, { config: { streaming_mode: false } })).toBe(true)
    expect(attempt).toBe(3) // failed PATCH → reopen PATCH → terminal PATCH retry
    await cardkit.dispose(cardId)
  })

  test('patchSummaryThrottled records lastSent only after the PATCH landed', async () => {
    const cardId = 'card_summary_landed'
    cardkit.recordCardCreated(cardId, 1)
    let failSettings = true
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({
        method: String(init?.method ?? 'GET'),
        path: url.pathname.replace('/open-apis/cardkit/v1', ''),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return new Response(JSON.stringify(failSettings
        ? { code: 300308, msg: 'settings rejected' }
        : { code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
    cardkit.patchSummaryThrottled(cardId, '预览内容')
    await wait(1900) // SUMMARY_FLUSH_MS(1500) + margin
    expect(calls.filter(c => c.path === `/cards/${cardId}/settings`)).toHaveLength(1)

    // PATCH 未落地不得记 lastSent → 同 summary 重投必须再次发送
    failSettings = false
    cardkit.patchSummaryThrottled(cardId, '预览内容')
    await wait(1900)
    expect(calls.filter(c => c.path === `/cards/${cardId}/settings`)).toHaveLength(2)
    await cardkit.dispose(cardId)
  }, 15_000)

  test('disposed card mutations do not recreate state or hit the wire', async () => {
    const cardId = 'card_disposed_guard'
    cardkit.recordCardCreated(cardId, 2)
    await cardkit.dispose(cardId)

    await cardkit.addElement(cardId, { tag: 'markdown', element_id: 'e1', content: 'x' })
    await cardkit.replaceElement(cardId, 'footer', { tag: 'markdown', element_id: 'footer', content: 'x' })
    await cardkit.deleteElement(cardId, 'e1')
    await cardkit.patchSettings(cardId, { config: {} })
    expect(await cardkit.patchSettingsChecked(cardId, { config: {} })).toBe(false)

    expect(calls).toHaveLength(0)
    expect(cardkit.getElementCount(cardId)).toBe(0)

    // 同 id 重新开卡(recordCardCreated)清墓碑,恢复可写
    cardkit.recordCardCreated(cardId, 1)
    await cardkit.addElement(cardId, { tag: 'markdown', element_id: 'e2', content: 'y' })
    expect(calls.filter(c => c.path === `/cards/${cardId}/elements`)).toHaveLength(1)
    await cardkit.dispose(cardId)
  })
})

describe('checked card writes', () => {
  test('replaceElementChecked reports a Feishu PUT rejection', async () => {
    const cardId = 'card_checked_replace'
    cardkit.recordCardCreated(cardId, 1)
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: 300308, msg: 'element rejected' }), {
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch

    expect(await cardkit.replaceElementChecked(cardId, 'assistant_0', {
      tag: 'markdown', element_id: 'assistant_0', content: 'x',
    })).toBe(false)
    await cardkit.dispose(cardId)
  })

  // 上游原题为 'add/delete checked variants return false on rejected mutations';
  // add 部分与本地 addElementResult 结构化失败例(card_add_result)意图重复,
  // 裁剪为 delete 聚焦版锁定本 plan 新增的 deleteElementChecked。
  test('deleteElementChecked returns false on a rejected delete mutation', async () => {
    const deleteCard = 'card_checked_delete'
    cardkit.recordCardCreated(deleteCard, 2)
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: 300313, msg: 'delete rejected' }), {
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
    expect(await cardkit.deleteElementChecked(deleteCard, 'math_1')).toBe(false)
    await cardkit.dispose(deleteCard)
  })

  test('HTTP errors and malformed success bodies never count as landed writes', async () => {
    for (const [cardId, response] of [
      ['card_http_502', new Response(JSON.stringify({ msg: 'gateway error' }), {
        status: 502, headers: { 'Content-Type': 'application/json' },
      })],
      ['card_missing_code', new Response(JSON.stringify({ data: {} }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })],
    ] as const) {
      cardkit.recordCardCreated(cardId, 1)
      globalThis.fetch = (async () => response.clone()) as unknown as typeof fetch
      expect(await cardkit.replaceElementChecked(cardId, 'assistant_0', {
        tag: 'markdown', element_id: 'assistant_0', content: 'x',
      }, { notifyCardFailure: false })).toBe(false)
      await cardkit.dispose(cardId)
    }
  })

  test('a size rejection in an isolated replacement leaves the original element writable', async () => {
    const cardId = 'card_local_size_failure'
    let notifications = 0
    let attempts = 0
    cardkit.recordCardCreated(cardId, 1, () => { notifications++ })
    globalThis.fetch = (async () => new Response(JSON.stringify(++attempts === 1
      ? { code: 200860, msg: 'ErrMsg: card over max size;' }
      : { code: 0, data: {} }), {
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch

    try {
      expect(await cardkit.replaceElementChecked(cardId, 'assistant_0', {
        tag: 'column_set', element_id: 'assistant_0',
        columns: [{ tag: 'column', elements: [{ tag: 'img', img_key: 'uploaded_formula' }] }],
      }, { notifyCardFailure: false })).toBe(false)
      expect(notifications).toBe(0)
      expect(cardkit.isDeadElement(cardId, 'assistant_0')).toBe(false)
      expect(await cardkit.replaceElementChecked(cardId, 'assistant_0', {
        tag: 'markdown', element_id: 'assistant_0', content: '原始公式 $$x^2$$',
      })).toBe(true)
      expect(attempts).toBe(2)
    } finally {
      await cardkit.dispose(cardId)
    }
  })

  test('a throwing card failure callback cannot poison the write queue', async () => {
    const cardId = 'card_throwing_failure_callback'
    cardkit.recordCardCreated(cardId, 1, () => { throw new Error('callback boom') })
    let attempt = 0
    globalThis.fetch = (async () => {
      attempt++
      return new Response(JSON.stringify(attempt === 1
        ? { code: 300308, msg: 'first rejected' }
        : { code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    expect(await cardkit.replaceElementChecked(cardId, 'assistant_0', {
      tag: 'markdown', element_id: 'assistant_0', content: 'first',
    })).toBe(false)
    expect(await cardkit.addElementChecked(cardId, {
      tag: 'markdown', element_id: 'second', content: 'second',
    })).toBe(true)
    await cardkit.dispose(cardId)
  })
})

describe('disposed card write guard (review #3)', () => {
  test('recordCardCreated 复活同 id 卡(新 turn 复用 card id 场景)', async () => {
    const cardId = 'card_revive'
    cardkit.recordCardCreated(cardId, 1)
    // 旧生命周期留下死元素 + write-dead(stale-open 换代时旧 state 未必
    // 来得及 dispose)——复活必须整体丢弃旧 state,而不是在其上打补丁。
    const healthy = globalThis.fetch
    let failNext = true
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (failNext) {
        failNext = false
        return new Response(JSON.stringify({ code: 300308, msg: 'stale reject' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return await healthy(input, init)
    }) as typeof fetch
    await cardkit.addElement(cardId, { tag: 'markdown', element_id: 'rv1', content: 'stale' })
    expect(cardkit.isDeadElement(cardId, 'rv1')).toBe(true)
    cardkit.markCardWriteDead(cardId)

    // 未经 dispose 直接同 id 再开卡:全新生命周期,旧 deadElements/writeDead/closing 不残留
    cardkit.recordCardCreated(cardId, 1)
    expect(cardkit.isDeadElement(cardId, 'rv1')).toBe(false)
    await cardkit.addElement(cardId, { tag: 'markdown', element_id: 'rv1', content: 'ok' })
    await cardkit.flush(cardId)
    expect(calls.some(c => c.method === 'POST' && c.path === `/cards/${cardId}/elements` && JSON.parse(c.body.elements)[0]?.element_id === 'rv1')).toBe(true)

    // dispose 后同 id 复活同样成立(上游原型场景)
    await cardkit.dispose(cardId)
    cardkit.recordCardCreated(cardId, 1)
    await cardkit.addElement(cardId, { tag: 'markdown', element_id: 'rv2', content: 'ok2' })
    await cardkit.flush(cardId)
    expect(calls.some(c => c.method === 'POST' && c.path === `/cards/${cardId}/elements` && JSON.parse(c.body.elements)[0]?.element_id === 'rv2')).toBe(true)
    await cardkit.dispose(cardId)
  })

  test('dispose synchronously closes the enqueue gate before draining', async () => {
    const cardId = 'card_dispose_race'
    cardkit.recordCardCreated(cardId, 1)
    let releaseFetch: () => void = () => {}
    const fetchStarted = new Promise<void>(resolve => {
      globalThis.fetch = (async () => {
        resolve()
        await new Promise<void>(release => { releaseFetch = release })
        return new Response(JSON.stringify({ code: 0, data: {} }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }) as unknown as typeof fetch
    })

    const first = cardkit.addElementChecked(cardId, {
      tag: 'markdown', element_id: 'first', content: 'first',
    })
    await fetchStarted
    const disposing = cardkit.dispose(cardId)
    const second = await cardkit.addElementChecked(cardId, {
      tag: 'markdown', element_id: 'second', content: 'second',
    })
    expect(second).toBe(false)
    releaseFetch()
    expect(await first).toBe(true)
    await disposing
    expect(cardkit.isDisposed(cardId)).toBe(true)
  })
})
