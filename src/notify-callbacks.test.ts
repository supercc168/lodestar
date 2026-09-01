import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  __setStoreFileForTest,
  buildNotifyResult,
  clearDispatching,
  dispatchCallback,
  get,
  isDispatching,
  loadCallbacks,
  markResolved,
  markUnknown,
  prune,
  recordCallbackSuccess,
  register,
  setDispatching,
  type NotifyRegistration,
} from './notify-callbacks'

let tempDir: string
let tempFile: string

function sampleReg(overrides: Partial<NotifyRegistration> = {}): NotifyRegistration {
  return {
    notifyId: 'nf_test1',
    callbackUrl: 'http://127.0.0.1:9999/hook',
    chatId: 'oc_chat',
    messageId: 'om_msg',
    project: 'feishu',
    title: 'ops',
    text: 'approve?',
    level: 'info',
    imageKeys: [],
    buttons: [{ id: 'approve', text: '✅ 通过', type: 'primary' }],
    createdAt: Date.now(),
    ...overrides,
  }
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lodestar-nc-'))
  tempFile = join(tempDir, 'notify-callbacks.json')
  __setStoreFileForTest(tempFile)  // also clears the in-memory map
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('notify-callbacks store', () => {
  test('register + get round-trip', () => {
    expect(get('nf_test1')).toBeUndefined()
    register(sampleReg())
    const got = get('nf_test1')
    expect(got?.callbackUrl).toBe('http://127.0.0.1:9999/hook')
    expect(got?.buttons[0].id).toBe('approve')
    expect(got?.resolvedAt).toBeUndefined()
  })

  test('persistence survives a fresh load (reload from disk)', () => {
    register(sampleReg({ notifyId: 'nf_persist' }))
    // Simulate a daemon restart: in-memory map is wiped, then we reload
    // from the same file path.
    __setStoreFileForTest(tempFile)  // clear memory but keep the file
    loadCallbacks()
    expect(get('nf_persist')?.messageId).toBe('om_msg')
  })

  test('markResolved stamps resolvedAt + resolvedBy and persists', () => {
    register(sampleReg())
    markResolved('nf_test1', 'approve', 'ou_user1')
    const got = get('nf_test1')
    expect(got?.resolvedAt).toBeGreaterThan(0)
    expect(got?.resolvedBy).toEqual({ buttonId: 'approve', openId: 'ou_user1' })
    // Confirmed on disk after a fresh load.
    __setStoreFileForTest(tempFile)
    loadCallbacks()
    expect(get('nf_test1')?.resolvedBy?.openId).toBe('ou_user1')
  })

  test('prune(now) drops entries older than 7 days, keeps fresh', () => {
    const now = 1_700_000_000_000
    register(sampleReg({ notifyId: 'nf_old', createdAt: now - 8 * 24 * 3600_000 }))
    register(sampleReg({ notifyId: 'nf_new', createdAt: now - 1 * 3600_000 }))
    const removed = prune(now)
    expect(removed).toBe(1)
    expect(get('nf_old')).toBeUndefined()
    expect(get('nf_new')).toBeDefined()
  })

  test('loadCallbacks silently ignores a corrupted file (no throw, empty map)', () => {
    const { writeFileSync } = require('node:fs')
    writeFileSync(tempFile, '{ not valid json')
    __setStoreFileForTest(tempFile)
    expect(() => loadCallbacks()).not.toThrow()
    expect(get('nf_anything')).toBeUndefined()
  })

  test('callbackUrl may be empty (pull / display-only mode still registers)', () => {
    register(sampleReg({ notifyId: 'nf_pull', callbackUrl: '' }))
    expect(get('nf_pull')?.callbackUrl).toBe('')
  })

  test('dispatching guard is in-memory only and survives a reload as cleared', () => {
    register(sampleReg({ notifyId: 'nf_dispatch' }))
    expect(isDispatching('nf_dispatch')).toBe(false)
    setDispatching('nf_dispatch')
    expect(isDispatching('nf_dispatch')).toBe(true)
    // A "restart" wipes the in-memory guard but persists registrations.
    __setStoreFileForTest(tempFile)
    loadCallbacks()
    expect(isDispatching('nf_dispatch')).toBe(false)
    expect(get('nf_dispatch')).toBeDefined()
    // Manual clear also works.
    setDispatching('nf_dispatch')
    clearDispatching('nf_dispatch')
    expect(isDispatching('nf_dispatch')).toBe(false)
  })
})

describe('durable resolved 墓碑 / markUnknown / 运行中修剪(上游 ec149d7)', () => {
  /** 让持久化必然失败:store 指向一个"父路径是普通文件"的位置,
   *  mkdirSync(parent) 必抛 ENOTDIR。clearMemory=false 保留内存态。 */
  function breakStoreKeepMemory(): void {
    const blocker = join(tempDir, 'blocker')
    writeFileSync(blocker, 'not a dir')
    __setStoreFileForTest(join(blocker, 'store.json'), false)
  }

  test('markResolved 找不到注册时抛出(不再静默吞)', () => {
    expect(() => markResolved('nf_missing', 'approve', 'ou_u')).toThrow(/not found/)
  })

  test('markResolved 持久化失败时回滚内存态并抛出(墓碑必须 durable)', () => {
    register(sampleReg({ notifyId: 'nf_rollback' }))
    breakStoreKeepMemory()
    expect(() => markResolved('nf_rollback', 'approve', 'ou_u')).toThrow()
    const got = get('nf_rollback')!
    expect(got.resolvedAt).toBeUndefined()
    expect(got.resolvedBy).toBeUndefined()
  })

  test('recordCallbackSuccess 正常路径 → complete,resolved 墓碑落盘重启可见', () => {
    register(sampleReg({ notifyId: 'nf_ok' }))
    expect(recordCallbackSuccess('nf_ok', 'approve', 'ou_u')).toEqual({ state: 'complete' })
    // 模拟重启:清内存 → 从盘重载,墓碑仍在 → 重复回调可拒
    __setStoreFileForTest(tempFile)
    loadCallbacks()
    expect(get('nf_ok')?.resolvedAt).toBeGreaterThan(0)
    expect(get('nf_ok')?.resolvedBy?.openId).toBe('ou_u')
  })

  test('外部成功但本地持久化失败 → markUnknown 冻结(不当可重试)', () => {
    register(sampleReg({ notifyId: 'nf_unknown' }))
    breakStoreKeepMemory()
    const recorded = recordCallbackSuccess('nf_unknown', 'approve', 'ou_u')
    expect(recorded.state).toBe('unknown')
    if (recorded.state !== 'unknown') throw new Error('expected unknown record')
    expect(recorded.detail).toContain('persistence failed')
    // 内存 guard 保留:unknownAt 冻结、resolvedAt 不得存在(冻结≠已解决)
    const got = get('nf_unknown')!
    expect(got.unknownAt).toBeGreaterThan(0)
    expect(got.unknownBy).toEqual({ buttonId: 'approve', openId: 'ou_u' })
    expect(got.resolvedAt).toBeUndefined()
    expect(typeof got.unknownReason).toBe('string')
  })

  test('markUnknown 可持久化时落盘,buildNotifyResult 暴露 unknown 分支', () => {
    register(sampleReg({ notifyId: 'nf_bnr_unknown' }))
    markUnknown('nf_bnr_unknown', 'approve', 'ou_op', 'test freeze reason')
    const r = buildNotifyResult(get('nf_bnr_unknown')!) as any
    expect(r.resolved).toBe(false)
    expect(r.unknown).toBe(true)
    expect(r.button).toEqual({ id: 'approve', text: '✅ 通过', type: 'primary' })
    expect(r.unknown_by).toBe('ou_op')
    expect(r.unknown_reason).toBe('test freeze reason')
    // 落盘后重启仍冻结
    __setStoreFileForTest(tempFile)
    loadCallbacks()
    expect(get('nf_bnr_unknown')?.unknownAt).toBeGreaterThan(0)
  })

  test('运行中修剪:register 超过修剪间隔时驱逐 7 天+ 记录(不只 boot 时)', () => {
    register(sampleReg({ notifyId: 'nf_stale_run', createdAt: Date.now() - 8 * 24 * 3600_000 }))
    expect(get('nf_stale_run')).toBeDefined()
    // 快进 25h(> 24h 修剪间隔)再 register → 触发运行中 prune
    setSystemTime(new Date(Date.now() + 25 * 3600_000))
    try {
      register(sampleReg({ notifyId: 'nf_fresh_run', createdAt: Date.now() }))
      expect(get('nf_stale_run')).toBeUndefined()
      expect(get('nf_fresh_run')).toBeDefined()
    } finally {
      setSystemTime()
    }
  })
})

describe('buildNotifyResult (pull payload)', () => {
  test('pending ⇒ resolved:false, no button fields', () => {
    register(sampleReg({ notifyId: 'nf_pending' }))
    const r = buildNotifyResult(get('nf_pending')!) as any
    expect(r.resolved).toBe(false)
    expect(r.notify_id).toBe('nf_pending')
    expect(r.project).toBe('feishu')
    expect(r.message_id).toBe('om_msg')
    expect(r.button).toBeUndefined()
    expect(r.resolved_at).toBeUndefined()
  })

  test('resolved ⇒ full verdict with button text/type + operator', () => {
    register(sampleReg({ notifyId: 'nf_done' }))
    markResolved('nf_done', 'approve', 'ou_op')
    const r = buildNotifyResult(get('nf_done')!) as any
    expect(r.resolved).toBe(true)
    expect(r.button).toEqual({ id: 'approve', text: '✅ 通过', type: 'primary' })
    expect(typeof r.resolved_at).toBe('number')
    expect(r.resolved_by).toBe('ou_op')
  })
})

describe('dispatchCallback', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('2xx ⇒ ok', async () => {
    globalThis.fetch = (async () => new Response('ok', { status: 204 })) as unknown as typeof fetch
    const r = await dispatchCallback(sampleReg(), { id: 'approve', text: '✅ 通过', type: 'primary' }, 'ou_u')
    expect(r.ok).toBe(true)
  })

  test('non-2xx ⇒ !ok with HTTP status in detail', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    const r = await dispatchCallback(sampleReg(), { id: 'approve', text: '✅', type: 'primary' }, 'ou_u')
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/500/)
  })

  test('abort (timeout) ⇒ !ok with 超时 detail, never a safe fallback', async () => {
    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
      // Emulate the AbortController firing inside the dispatcher.
      init?.signal?.dispatchEvent?.(new Event('abort'))
      const e = new Error('aborted')
      ;(e as any).name = 'AbortError'
      throw e
    }) as unknown as typeof fetch
    const r = await dispatchCallback(sampleReg(), { id: 'approve', text: '✅', type: 'primary' }, 'ou_u')
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/超时/)
  })

  test('network error ⇒ !ok with the real message', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:9999')
    }) as unknown as typeof fetch
    const r = await dispatchCallback(sampleReg(), { id: 'approve', text: '✅', type: 'primary' }, 'ou_u')
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/ECONNREFUSED/)
  })

  test('payload shape: notify_id / button / operator carried to the caller', async () => {
    let captured: any = null
    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body))
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch
    await dispatchCallback(sampleReg({ notifyId: 'nf_shape' }), { id: 'reject', text: '❌', type: 'danger' }, 'ou_op')
    expect(captured.notify_id).toBe('nf_shape')
    expect(captured.message_id).toBe('om_msg')
    expect(captured.chat_id).toBe('oc_chat')
    expect(captured.project).toBe('feishu')
    expect(captured.button).toEqual({ id: 'reject', text: '❌', type: 'danger' })
    expect(captured.operator).toEqual({ open_id: 'ou_op' })
    expect(typeof captured.timestamp).toBe('number')
  })

  test('reply capture: JSON {text} / {reply} / plain text / empty', async () => {
    // JSON {text}
    globalThis.fetch = (async () => new Response(JSON.stringify({ text: '已发布 v1.2.3' }), { status: 200 })) as unknown as typeof fetch
    let r = await dispatchCallback(sampleReg(), { id: 'a', text: 'x', type: 'default' }, 'ou_u')
    expect(r.reply).toBe('已发布 v1.2.3')
    // JSON {reply} alias
    globalThis.fetch = (async () => new Response(JSON.stringify({ reply: 'ok done' }), { status: 200 })) as unknown as typeof fetch
    r = await dispatchCallback(sampleReg(), { id: 'a', text: 'x', type: 'default' }, 'ou_u')
    expect(r.reply).toBe('ok done')
    // plain text body
    globalThis.fetch = (async () => new Response('deployed', { status: 200 })) as unknown as typeof fetch
    r = await dispatchCallback(sampleReg(), { id: 'a', text: 'x', type: 'default' }, 'ou_u')
    expect(r.reply).toBe('deployed')
    // empty body → no reply
    globalThis.fetch = (async () => new Response('', { status: 204 })) as unknown as typeof fetch
    r = await dispatchCallback(sampleReg(), { id: 'a', text: 'x', type: 'default' }, 'ou_u')
    expect(r.reply).toBeUndefined()
    // capped at 500 chars
    const long = 'x'.repeat(800)
    globalThis.fetch = (async () => new Response(long, { status: 200 })) as unknown as typeof fetch
    r = await dispatchCallback(sampleReg(), { id: 'a', text: 'x', type: 'default' }, 'ou_u')
    expect(r.reply?.length).toBe(500)
  })
})
