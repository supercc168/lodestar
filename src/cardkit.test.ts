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

    // 短路只针对「显式删除」的元素(三态语义,上游 378f4a4):失败可恢复的元素
    // 与 footer 仍然放行,所以这里先用一次真实删除把元素置为不可复活。
    cardkit.recordCardCreated('card_replace_element_dead', 1)
    await cardkit.addElement(
      'card_replace_element_dead',
      { tag: 'markdown', element_id: 'assistant_0', content: 'assistant content' },
      {},
      () => {},
    )
    await cardkit.deleteElement('card_replace_element_dead', 'assistant_0')
    const callsBeforeShortCircuit = calls.length
    await cardkit.replaceElement(
      'card_replace_element_dead',
      'assistant_0',
      { tag: 'markdown', element_id: 'assistant_0', content: 'late content' },
      code => failures.push(code),
    )

    expect(failures).toEqual([300313, undefined, undefined])
    expect(failures).toHaveLength(3)
    expect(calls).toHaveLength(callsBeforeShortCircuit)
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

describe('cardkit 容量指纹数据模型 (上游 378f4a4)', () => {
  /** 只让「内容里带 oversized 的 payload」被拒,其余写成功 —— 失败响应是
   * 300315 内嵌 300305 的真容量形态,必须走真实写路径拿到指纹。 */
  function mockCapacityOnOversized(): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({
        method: String(init?.method ?? 'GET'),
        path: url.pathname.replace('/open-apis/cardkit/v1', ''),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      const body = String(init?.body ?? '')
      return new Response(JSON.stringify(body.includes('oversized')
        ? {
            code: 300315,
            msg: 'Failed to add element: number of card components exceeds the maximum limit; code: 300305',
          }
        : { code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch
  }

  /** 元素自带的 element_id 不进指纹:同一内容换编号/换卡必须同指纹。 */
  const contentElement = (id: string, content: string) => ({
    tag: 'column_set',
    element_id: id,
    columns: [{ tag: 'column', elements: [{ tag: 'markdown', element_id: `${id}_text`, content }] }],
  })

  test('capacity fingerprint is stable across cards for the same rejected payload', async () => {
    const ids = ['card_fingerprint_old', 'card_fingerprint_new']
    mockCapacityOnOversized()
    const rejected = async (cardId: string, id: string): Promise<string> => {
      const result = await cardkit.addElementResult(cardId, contentElement(id, 'oversized'))
      expect(result.landed).toBe(false)
      expect(result.failure?.code).toBe(300315)
      expect(cardkit.isElementLimitFailure(result.failure?.code, result.failure)).toBe(true)
      expect(result.failure?.capacityFingerprint).toMatch(/^[a-f0-9]{64}$/)
      return result.failure!.capacityFingerprint!
    }
    try {
      for (const id of ids) cardkit.recordCardCreated(id, 2)
      // 两张卡写入「同一正文,不同元素编号」+ 换卡后 footer 定时刷新;
      // 指纹只看正文内容,三者都不得改变结果。
      await cardkit.addElement(ids[0]!, contentElement('tool_0', 'previous'))
      await cardkit.addElement(ids[1]!, contentElement('tool_7', 'previous'))
      await cardkit.replaceElement(ids[1]!, 'footer', {
        tag: 'markdown', element_id: 'footer', content: 'Thinking(17s)',
      })
      const old = await rejected(ids[0]!, 'assistant_5')
      expect(await rejected(ids[1]!, 'assistant_0')).toBe(old)
      // 内容变了 → 指纹必须变(否则 session 层会把新载荷当重复拒掉)
      await cardkit.replaceElement(ids[1]!, 'tool_7', contentElement('tool_7', 'new output'))
      expect(await rejected(ids[1]!, 'assistant_1')).not.toBe(old)
      // 换卡要重建的正文元素被显式删除后,指纹回到「只有被拒载荷」形态
      await cardkit.deleteElement(ids[0]!, 'tool_0')
      await cardkit.deleteElement(ids[1]!, 'tool_7')
      const empty = await rejected(ids[0]!, 'assistant_6')
      expect(empty).not.toBe(old)
      expect(await rejected(ids[1]!, 'assistant_2')).toBe(empty)
    } finally {
      for (const id of ids) await cardkit.dispose(id)
    }
  })

  test('non-capacity failures never carry a capacity fingerprint', async () => {
    const cardId = 'card_fingerprint_non_capacity'
    cardkit.recordCardCreated(cardId, 1)
    // schema 类:300315 内嵌 300301 duplicate id —— 不是容量,不得带指纹
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 300315, msg: 'Failed to add element; Duplicate ID; code: 300301',
    }), {
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
    const schema = await cardkit.addElementResult(cardId, {
      tag: 'markdown', element_id: 'dup_0', content: 'dup',
    })
    expect(schema.landed).toBe(false)
    expect(schema.failure?.code).toBe(300315)
    expect(schema.failure && 'capacityFingerprint' in schema.failure).toBe(false)

    // 网络类:kind=network 且无业务 code,同样不得带指纹
    globalThis.fetch = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    const net = await cardkit.addElementResult(cardId, {
      tag: 'markdown', element_id: 'net_0', content: 'net',
    })
    expect(net.landed).toBe(false)
    expect(net.failure?.code).toBeUndefined()
    expect(net.failure && 'capacityFingerprint' in net.failure).toBe(false)
    await cardkit.dispose(cardId)
  })

  test('footer writes stay out of the written-content fingerprints', async () => {
    const cardId = 'card_fingerprint_footer'
    cardkit.recordCardCreated(cardId, 2)
    await cardkit.addElement(cardId, { tag: 'markdown', element_id: 'assistant_0', content: 'body' })
    expect(cardkit.getWrittenContentElementIds(cardId)).toEqual(['assistant_0'])
    await cardkit.replaceElement(cardId, 'footer', {
      tag: 'markdown', element_id: 'footer', content: 'Writing(1s)',
    })
    await cardkit.addElement(cardId, { tag: 'markdown', element_id: 'footer', content: 'Writing(2s)' })
    expect(cardkit.getWrittenContentElementIds(cardId)).toEqual(['assistant_0'])
    expect(cardkit.getWrittenContentElementIds('card_fingerprint_never_created')).toEqual([])
    await cardkit.dispose(cardId)
  })
})

describe('cardkit 失败元素三态语义 (上游 378f4a4)', () => {
  /** 只让下一次 Card Kit 调用失败(返回指定 code),之后恢复默认 mock。 */
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

  test('a rejected add keeps its placement so a later update rebuilds it (上游 378f4a4)', async () => {
    const id = 'card_three_state_placement'
    cardkit.recordCardCreated(id, 1)
    failNextCardKitCall(300308)
    try {
      const added = cardkit.addElementChecked(id, {
        tag: 'markdown', element_id: 'tool_0', content: 'working',
      }, { type: 'insert_before', targetElementId: 'footer' })
      const completed = cardkit.replaceElementChecked(id, 'tool_0', {
        tag: 'markdown', element_id: 'tool_0', content: 'complete result',
      })
      expect(await added).toBe(false)
      // 失败可恢复:同 id 的更新用最新内容在原 placement 重建
      expect(await completed).toBe(true)
      expect(calls.map(call => call.method)).toEqual(['POST', 'POST'])
      expect(calls[1]!.body.target_element_id).toBe('footer')
      expect(calls[1]!.body.elements).toContain('complete result')
      expect(cardkit.isDeadElement(id, 'tool_0')).toBe(false)
      expect(cardkit.getElementCount(id)).toBe(2)
    } finally {
      await cardkit.dispose(id)
    }
  })

  test('a rejected update stays retryable and never revives after an explicit delete (上游 378f4a4)', async () => {
    const id = 'card_three_state_retry'
    cardkit.recordCardCreated(id, 1)
    await cardkit.addElementChecked(id, { tag: 'markdown', element_id: 'tool_0', content: 'working' })
    const healthy = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 200860, msg: 'ErrMsg: card over max size;',
    }), {
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
    try {
      expect(await cardkit.replaceElementChecked(id, 'tool_0', {
        tag: 'markdown', element_id: 'tool_0', content: 'oversized result',
      })).toBe(false)
      // 容量拒绝仍标 dead(保本地 300315/200860 判定),但不再是永久死元素
      expect(cardkit.isDeadElement(id, 'tool_0')).toBe(true)
      globalThis.fetch = healthy
      expect(await cardkit.replaceElementChecked(id, 'tool_0', {
        tag: 'markdown', element_id: 'tool_0', content: 'updated result',
      })).toBe(true)
      // 删除成功:指纹与失败标记一并清除,迟到的更新立即短路且不发 HTTP
      expect(await cardkit.deleteElementChecked(id, 'tool_0')).toBe(true)
      expect(cardkit.getWrittenContentElementIds(id)).toEqual([])
      const before = calls.length
      expect(await cardkit.replaceElementChecked(id, 'tool_0', {
        tag: 'markdown', element_id: 'tool_0', content: 'late result',
      })).toBe(false)
      expect(calls).toHaveLength(before)
    } finally {
      await cardkit.dispose(id)
    }
  })

  test('deleting after a rejected capacity update removes the remote element (上游 378f4a4)', async () => {
    const id = 'card_three_state_delete'
    cardkit.recordCardCreated(id, 1)
    await cardkit.addElementChecked(id, { tag: 'markdown', element_id: 'tool_0', content: 'old content' })
    failNextCardKitCall(200860)
    try {
      expect(await cardkit.replaceElementChecked(id, 'tool_0', {
        tag: 'markdown', element_id: 'tool_0', content: 'new content',
      })).toBe(false)
      expect(cardkit.isDeadElement(id, 'tool_0')).toBe(true)
      expect(await cardkit.deleteElementChecked(id, 'tool_0')).toBe(true)
      expect(calls.at(-1)?.method).toBe('DELETE')
      expect(calls.at(-1)?.path).toBe(`/cards/${id}/elements/tool_0`)
      expect(cardkit.getElementCount(id)).toBe(1)
    } finally {
      await cardkit.dispose(id)
    }
  })

  test('writeDead short-circuits every write path ahead of the recovery semantics', async () => {
    const id = 'card_three_state_write_dead'
    cardkit.recordCardCreated(id, 1)
    await cardkit.addElement(id, { tag: 'markdown', element_id: 'tool_0', content: 'x' })
    cardkit.markCardWriteDead(id)
    const before = calls.length

    await cardkit.addElement(id, { tag: 'markdown', element_id: 'tool_1', content: 'y' })
    await cardkit.replaceElement(id, 'tool_0', { tag: 'markdown', element_id: 'tool_0', content: 'z' })
    await cardkit.deleteElement(id, 'tool_0')
    expect(await cardkit.replaceElementChecked(id, 'tool_0', {
      tag: 'markdown', element_id: 'tool_0', content: 'z2',
    })).toBe(false)
    expect(await cardkit.addElementChecked(id, {
      tag: 'markdown', element_id: 'tool_2', content: 'w',
    })).toBe(false)

    expect(calls).toHaveLength(before)
    expect(cardkit.getElementCount(id)).toBe(2)
    await cardkit.dispose(id)
  })

  test('dispose drops the three-state bookkeeping together with the card', async () => {
    const id = 'card_three_state_dispose'
    cardkit.recordCardCreated(id, 1)
    failNextCardKitCall(300308)
    await cardkit.addElement(id, {
      tag: 'markdown', element_id: 'tool_0', content: 'x',
    }, { type: 'insert_before', targetElementId: 'footer' })
    expect(cardkit.isDeadElement(id, 'tool_0')).toBe(true)

    await cardkit.dispose(id)
    expect(cardkit.isDisposed(id)).toBe(true)
    // 状态整体随卡丢弃:dead/placement/指纹都不残留(墓碑语义不变)
    expect(cardkit.isDeadElement(id, 'tool_0')).toBe(false)
    expect(cardkit.getWrittenContentElementIds(id)).toEqual([])
    const before = calls.length
    await cardkit.addElement(id, { tag: 'markdown', element_id: 'tool_0', content: 'late' })
    expect(calls).toHaveLength(before)
  })

  test('a retried add reports its real landed state with the latest content (上游 378f4a4)', async () => {
    const id = 'card_three_state_landed'
    cardkit.recordCardCreated(id, 1)
    failNextCardKitCall(300308)
    try {
      const failed = await cardkit.addElementResult(id, {
        tag: 'markdown', element_id: 'tool_0', content: 'working',
      }, { type: 'insert_before', targetElementId: 'footer' })
      expect(failed.landed).toBe(false)
      expect(failed.failure?.code).toBe(300308)

      const retried = await cardkit.addElementResult(id, {
        tag: 'markdown', element_id: 'tool_0', content: 'latest',
      }, { type: 'insert_before', targetElementId: 'footer' })
      expect(retried).toEqual({ landed: true })
      expect(calls.at(-1)?.body.target_element_id).toBe('footer')
      expect(String(calls.at(-1)?.body.elements)).toContain('latest')
      expect(cardkit.getElementCount(id)).toBe(2)
      expect(cardkit.getWrittenContentElementIds(id)).toEqual(['tool_0'])
    } finally {
      await cardkit.dispose(id)
    }
  })
})

describe('cardkit 测试矩阵收口:上游五意图 + 本地止损回归 (上游 378f4a4)', () => {
  const CAPACITY_REJECTION = 'Failed to add element: number of card components exceeds the maximum limit; code: 300305'

  function failNextCardKitCall(code: number, msg = `injected failure ${code}`): void {
    const previousFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      globalThis.fetch = previousFetch
      const url = new URL(String(input))
      calls.push({
        method: String(init?.method ?? 'GET'),
        path: url.pathname.replace('/open-apis/cardkit/v1', ''),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return new Response(JSON.stringify({ code, msg }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch
  }

  /** 走真实写路径制造一次容量失败,取回本次被拒载荷的 capacityFingerprint。 */
  async function rejectedPayloadFingerprint(
    cardId: string,
    elementId: string,
    element: object,
  ): Promise<string | undefined> {
    const healthy = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 300315, msg: CAPACITY_REJECTION,
    }), {
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
    let fingerprint: string | undefined
    try {
      await cardkit.replaceElement(cardId, elementId, element, (_code, meta) => {
        fingerprint = meta?.failure?.capacityFingerprint
      })
    } finally {
      globalThis.fetch = healthy
    }
    return fingerprint
  }

  test('同一内容跨重新编号/更新/删除保持指纹一致 (上游 378f4a4)', async () => {
    // 卡 A:同内容经「新增 → 更新」两步,元素编号是 assistant_0 / tool_0
    cardkit.recordCardCreated('card_matrix_renumber_a', 2)
    await cardkit.addElementChecked('card_matrix_renumber_a', {
      tag: 'markdown', element_id: 'assistant_0', content: 'final answer',
    })
    await cardkit.addElementChecked('card_matrix_renumber_a', {
      tag: 'markdown', element_id: 'tool_0', content: 'tool result v1',
    })
    await cardkit.replaceElementChecked('card_matrix_renumber_a', 'tool_0', {
      tag: 'markdown', element_id: 'tool_0', content: 'tool result v2',
    })

    // 卡 B:同样的最终内容,元素编号完全不同(assistant_12 / tool_5),一步到位
    cardkit.recordCardCreated('card_matrix_renumber_b', 2)
    await cardkit.addElementChecked('card_matrix_renumber_b', {
      tag: 'markdown', element_id: 'assistant_12', content: 'final answer',
    })
    await cardkit.addElementChecked('card_matrix_renumber_b', {
      tag: 'markdown', element_id: 'tool_5', content: 'tool result v2',
    })

    const cardA = await rejectedPayloadFingerprint('card_matrix_renumber_a', 'tool_0', {
      tag: 'markdown', element_id: 'tool_0', content: 'oversized result',
    })
    const cardB = await rejectedPayloadFingerprint('card_matrix_renumber_b', 'tool_5', {
      tag: 'markdown', element_id: 'tool_5', content: 'oversized result',
    })
    expect(cardA).toBeString()
    expect(cardA).toBe(cardB)

    // 删除卡 A 上的 assistant_0:已写入内容变了,指纹必须跟着变(删除如实反映)
    expect(await cardkit.deleteElementChecked('card_matrix_renumber_a', 'assistant_0')).toBe(true)
    const afterDelete = await rejectedPayloadFingerprint('card_matrix_renumber_a', 'tool_0', {
      tag: 'markdown', element_id: 'tool_0', content: 'oversized result',
    })
    expect(afterDelete).not.toBe(cardA)

    await cardkit.dispose('card_matrix_renumber_a')
    await cardkit.dispose('card_matrix_renumber_b')
  })

  test('队列中的工具结果用最新内容与原始 placement 重建失败占位 (上游 378f4a4)', async () => {
    const id = 'card_matrix_queued_rebuild'
    cardkit.recordCardCreated(id, 1)
    failNextCardKitCall(300308)

    // 不 await:两次写按队列顺序执行 —— 占位 add 失败(dead + failedAdds 记
    // placement),随后到达的工具结果必须在原 placement 用最新内容重建。
    const placeholder = cardkit.addElement(id, {
      tag: 'markdown', element_id: 'tool_0', content: 'running',
    }, { type: 'insert_before', targetElementId: 'footer' })
    const toolResult = cardkit.replaceElement(id, 'tool_0', {
      tag: 'markdown', element_id: 'tool_0', content: 'tool result',
    })
    await Promise.all([placeholder, toolResult])

    expect(calls.map(call => call.method)).toEqual(['POST', 'POST'])
    expect(calls[1]!.body.target_element_id).toBe('footer')
    expect(calls[1]!.body.elements).toContain('tool result')
    expect(cardkit.isDeadElement(id, 'tool_0')).toBe(false)
    expect(cardkit.getElementCount(id)).toBe(2)
    await cardkit.dispose(id)
  })

  test('被拒更新可恢复与显式删除保持删除并存 (上游 378f4a4)', async () => {
    const id = 'card_matrix_recover_and_delete'
    cardkit.recordCardCreated(id, 2)
    await cardkit.addElementChecked(id, {
      tag: 'markdown', element_id: 'assistant_0', content: 'draft',
    })
    await cardkit.addElementChecked(id, {
      tag: 'markdown', element_id: 'math_1', content: 'formula',
    })
    expect(await cardkit.deleteElementChecked(id, 'math_1')).toBe(true)

    failNextCardKitCall(300315, CAPACITY_REJECTION)
    expect(await cardkit.replaceElementChecked(id, 'assistant_0', {
      tag: 'markdown', element_id: 'assistant_0', content: 'oversized final',
    })).toBe(false)
    expect(await cardkit.replaceElementChecked(id, 'assistant_0', {
      tag: 'markdown', element_id: 'assistant_0', content: 'final',
    })).toBe(true)

    // 两条结论同时成立:可恢复的元素回到「已写入」,删除的元素不在其中
    expect(cardkit.getWrittenContentElementIds(id)).toEqual(['assistant_0'])
    expect(cardkit.isDeadElement(id, 'math_1')).toBe(true)
    const before = calls.length
    expect(await cardkit.replaceElementChecked(id, 'math_1', {
      tag: 'markdown', element_id: 'math_1', content: 'late late',
    })).toBe(false)
    expect(calls).toHaveLength(before)
    await cardkit.dispose(id)
  })

  test('失败更新之后再删除,远端元素确实被移除 (上游 378f4a4)', async () => {
    const id = 'card_matrix_delete_after_failure'
    cardkit.recordCardCreated(id, 1)
    await cardkit.addElementChecked(id, {
      tag: 'markdown', element_id: 'assistant_0', content: 'v1',
    })
    expect(cardkit.getElementCount(id)).toBe(2)

    failNextCardKitCall(300308)
    expect(await cardkit.replaceElementChecked(id, 'assistant_0', {
      tag: 'markdown', element_id: 'assistant_0', content: 'v2',
    })).toBe(false)

    expect(await cardkit.deleteElementChecked(id, 'assistant_0')).toBe(true)
    expect(calls.at(-1)?.method).toBe('DELETE')
    expect(calls.at(-1)?.path).toBe(`/cards/${id}/elements/assistant_0`)
    expect(cardkit.getElementCount(id)).toBe(1)
    expect(cardkit.getWrittenContentElementIds(id)).toEqual([])

    const before = calls.length
    expect(await cardkit.replaceElementChecked(id, 'assistant_0', {
      tag: 'markdown', element_id: 'assistant_0', content: 'late v3',
    })).toBe(false)
    expect(calls).toHaveLength(before)
    await cardkit.dispose(id)
  })

  test('数千张新卡之后关闭的卡仍不可写,未知卡无状态可写 (上游 378f4a4)', async () => {
    const closed = 'card_matrix_closed'
    cardkit.recordCardCreated(closed, 1)
    await cardkit.addElementChecked(closed, {
      tag: 'markdown', element_id: 'assistant_0', content: 'x',
    })
    await cardkit.dispose(closed)
    expect(cardkit.isDisposed(closed)).toBe(true)

    for (let i = 0; i < 4999; i += 1) {
      const filler = `card_matrix_filler_${i}`
      cardkit.recordCardCreated(filler, 1)
      await cardkit.dispose(filler)
    }

    // 墓碑仍有界在 MAX_DISPOSED_CARD_TOMBSTONES = 5000 之内:迟到写一律短路
    expect(cardkit.isDisposed(closed)).toBe(true)
    const before = calls.length
    expect(await cardkit.addElementChecked(closed, {
      tag: 'markdown', element_id: 'late', content: 'y',
    })).toBe(false)
    expect(await cardkit.replaceElementChecked(closed, 'assistant_0', {
      tag: 'markdown', element_id: 'assistant_0', content: 'z',
    })).toBe(false)
    await cardkit.addElement(closed, { tag: 'markdown', element_id: 'late2', content: 'w' })
    await cardkit.deleteElement(closed, 'assistant_0')
    expect(calls).toHaveLength(before)

    // 没见过的卡:读操作不凭空创建状态(本地沿用 lazy state + 墓碑语义)
    expect(cardkit.isDisposed('card_matrix_never_seen')).toBe(false)
    expect(cardkit.getElementCount('card_matrix_never_seen')).toBe(0)
    expect(cardkit.getWrittenContentElementIds('card_matrix_never_seen')).toEqual([])
    expect(cardkit.isDeadElement('card_matrix_never_seen', 'assistant_0')).toBe(false)
  })

  test('writeDead 之后所有写入短路 —— 本地止损回归门', async () => {
    const id = 'card_matrix_write_dead'
    cardkit.recordCardCreated(id, 2)
    await cardkit.addElementChecked(id, {
      tag: 'markdown', element_id: 'assistant_0', content: 'x',
    })
    const countBefore = cardkit.getElementCount(id)
    cardkit.markCardWriteDead(id)
    cardkit.markCardWriteDead(id) // 幂等

    const before = calls.length
    for (let i = 0; i < 20; i += 1) {
      await cardkit.addElement(id, { tag: 'markdown', element_id: `late_${i}`, content: 'y' })
      await cardkit.replaceElement(id, 'assistant_0', {
        tag: 'markdown', element_id: 'assistant_0', content: 'z',
      })
    }
    await cardkit.deleteElement(id, 'assistant_0')
    await cardkit.patchSettings(id, { config: { streaming_mode: false } })
    expect(await cardkit.addElementChecked(id, {
      tag: 'markdown', element_id: 'late_checked', content: 'y',
    })).toBe(false)
    expect(await cardkit.replaceElementChecked(id, 'assistant_0', {
      tag: 'markdown', element_id: 'assistant_0', content: 'z',
    })).toBe(false)
    expect(await cardkit.patchSettingsChecked(id, { config: { streaming_mode: false } })).toBe(false)

    expect(calls).toHaveLength(before)
    expect(cardkit.getElementCount(id)).toBe(countBefore)

    // 止损不跨生命周期残留:dispose 后同 id 重建恢复可写
    await cardkit.dispose(id)
    cardkit.recordCardCreated(id, 1)
    await cardkit.addElementChecked(id, {
      tag: 'markdown', element_id: 'assistant_0', content: 'fresh',
    })
    expect(calls).toHaveLength(before + 1)
    await cardkit.dispose(id)
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
