import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { Writable } from 'node:stream'

import {
  buildCodexAppServerArgs,
  buildCodexSpawnEnv,
  buildSpawnPath,
  codexLoginStatusAuthenticated,
  diffUsageTotals,
  effectiveTurnTokens,
  contextCompactionNoticeFromMessage,
  contextCompactionNoticeFromNotification,
  CodexProcess,
  imageGenerationOutput,
  usageFromTokenUsagePayload,
} from './codex-process'

function notificationHarness(): { proc: any; events: Array<[string, any]> } {
  const proc = Object.create(CodexProcess.prototype) as any
  const events: Array<[string, any]> = []
  proc.opts = { workDir: '/tmp' }
  proc.sessionId = 'thread-structured'
  proc.emittedImageGenerationIds = new Set()
  // collab→bg 翻译状态机四表(cf41941):Object.create 不跑字段初始化器,手动补。
  proc.collabAgentNames = new Map()
  proc.collabAgentSettled = new Set()
  proc.collabAgentWasActive = new Set()
  proc.collabAgentSummaries = new Map()
  proc.emit = (event: string, payload: unknown) => {
    events.push([event, payload])
    return true
  }
  return { proc, events }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function pendingTurnStartFixture(threadId: string): {
  proc: any
  resolveTurnStart: (value: unknown) => void
  rejectTurnStart: (error: Error) => void
  resultEvents: any[]
} {
  const proc = Object.create(CodexProcess.prototype) as any
  const turnStart = deferred<unknown>()
  const resultEvents: any[] = []
  proc.opts = { workDir: '/tmp', effort: 'high' }
  proc.sessionId = threadId
  proc.alive = true
  proc.deliveryCounter = 0
  proc.pendingTurnStart = null
  proc.currentTurnId = null
  proc.lastUsage = null
  proc.emittedImageGenerationIds = new Set()
  proc.flushRolloutImageGenerations = () => {}
  proc.startTurn = () => turnStart.promise
  proc.emit = (event: string, payload: unknown) => {
    if (event === 'result') resultEvents.push(payload)
    return true
  }
  return {
    proc,
    resolveTurnStart: turnStart.resolve,
    rejectTurnStart: turnStart.reject,
    resultEvents,
  }
}

function requestFailureTurnStartFixture(
  threadId: string,
  stdin: { write: (...args: any[]) => unknown },
): { proc: any; resultEvents: any[] } {
  const proc = Object.create(CodexProcess.prototype) as any
  const resultEvents: any[] = []
  proc.opts = { workDir: '/tmp', effort: 'high' }
  proc.sessionId = threadId
  proc.readyPromise = Promise.resolve()
  proc.alive = true
  proc.deliveryCounter = 0
  proc.pendingTurnStart = null
  proc.currentTurnId = null
  proc.lastUsage = null
  proc.requestCounter = 0
  proc.pending = new Map()
  proc.proc = { stdin }
  proc.emit = (event: string, payload: unknown) => {
    if (event === 'result') resultEvents.push(payload)
    return true
  }
  return { proc, resultEvents }
}

async function receiptWithin(dispatch: any, timeoutMs = 50): Promise<any> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      dispatch.settlement,
      new Promise(resolve => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe('codex turn/start delivery receipt', () => {
  test('turn/started ACK wins over a later RPC rejection', async () => {
    const { proc, rejectTurnStart, resultEvents } = pendingTurnStartFixture('thread-1')
    const dispatch = proc.sendUserText('hello') as any
    expect(dispatch.kind).toBe('turn_start_pending')

    proc.handleNotification('turn/started', {
      threadId: 'thread-1',
      turn: { id: 'turn-1' },
    })
    rejectTurnStart(new Error('late reject'))

    expect(await dispatch.settlement).toEqual({
      kind: 'ack',
      deliveryId: dispatch.deliveryId,
      threadId: 'thread-1',
      turnId: 'turn-1',
    })
    await Promise.resolve()
    expect(resultEvents).toEqual([])
  })

  test('RPC rejection settles rejected without throwing from the receipt', async () => {
    const { proc, rejectTurnStart, resultEvents } = pendingTurnStartFixture('thread-1')
    const dispatch = proc.sendUserText('hello') as any
    rejectTurnStart(new Error('rejected'))

    const settlement = await dispatch.settlement
    expect(settlement).toMatchObject({
      kind: 'rejected',
      deliveryId: dispatch.deliveryId,
      threadId: 'thread-1',
    })
    expect(settlement.error).toBeInstanceOf(Error)
    expect(resultEvents).toContainEqual(expect.objectContaining({
      subtype: 'codex_turn_start_failed',
      delivery_id: dispatch.deliveryId,
      thread_id: 'thread-1',
    }))
  })

  test('a dead process settles rejected instead of hanging', async () => {
    const { proc } = requestFailureTurnStartFixture('thread-dead', { write: () => {} })
    proc.alive = false
    const dispatch = proc.sendUserText('hello') as any

    expect(await receiptWithin(dispatch)).toMatchObject({
      kind: 'rejected',
      deliveryId: dispatch.deliveryId,
      threadId: 'thread-dead',
    })
  })

  test('a stdin write failure settles rejected instead of hanging', async () => {
    const { proc } = requestFailureTurnStartFixture('thread-write-failed', {
      // writable:true 让写路径真正走到 write() 抛出(ec149d7 后 write 有
      // 前置可写检查,裸 stub 缺 writable 字段会被前置检查短路)。
      writable: true,
      write: () => {
        throw new Error('stdin closed')
      },
    })
    const dispatch = proc.sendUserText('hello') as any

    expect(await receiptWithin(dispatch)).toMatchObject({
      kind: 'rejected',
      deliveryId: dispatch.deliveryId,
      threadId: 'thread-write-failed',
    })
  })

  test('an asynchronous stdin EPIPE rejects the registered request and receipt', async () => {
    const epipe = Object.assign(new Error('broken pipe'), { code: 'EPIPE' })
    let failWrite: (() => void) | null = null
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        failWrite = () => callback(epipe)
      },
    })
    const { proc } = requestFailureTurnStartFixture('thread-async-write-failed', stdin)
    const dispatch = proc.sendUserText('hello') as any
    await Promise.resolve()
    await Promise.resolve()

    expect(proc.pending.size).toBe(1)
    expect(failWrite).not.toBeNull()
    failWrite!()

    expect(await receiptWithin(dispatch)).toMatchObject({
      kind: 'rejected',
      deliveryId: dispatch.deliveryId,
      threadId: 'thread-async-write-failed',
      error: expect.objectContaining({ code: 'EPIPE' }),
    })
    expect(proc.pending.size).toBe(0)
    await new Promise(resolve => setImmediate(resolve))
  })

  test('turn/completed before the RPC response ACKs once with the same delivery identity', async () => {
    const { proc, resolveTurnStart, resultEvents } = pendingTurnStartFixture('thread-1')
    const dispatch = proc.sendUserText('hello') as any
    proc.handleNotification('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed' },
    })
    resolveTurnStart({ turn: { id: 'turn-1' } })

    expect(await dispatch.settlement).toEqual({
      kind: 'ack',
      deliveryId: dispatch.deliveryId,
      threadId: 'thread-1',
      turnId: 'turn-1',
    })
    await Promise.resolve()
    expect(resultEvents).toEqual([
      expect.objectContaining({
        delivery_id: dispatch.deliveryId,
        thread_id: 'thread-1',
        turn_id: 'turn-1',
      }),
    ])
  })

  test('an RPC ACK binds the turn early enough for an immediate interrupt', async () => {
    const { proc, resolveTurnStart } = pendingTurnStartFixture('thread-rpc-interrupt')
    const requests: Array<{ method: string; params: unknown }> = []
    proc.request = (method: string, params: unknown) => {
      requests.push({ method, params })
      return Promise.resolve({})
    }
    const dispatch = proc.sendUserText('hello') as any

    resolveTurnStart({ turn: { id: 'turn-rpc-interrupt' } })
    expect(await dispatch.settlement).toMatchObject({
      kind: 'ack',
      turnId: 'turn-rpc-interrupt',
    })

    proc.sendInterrupt()
    expect(requests).toContainEqual({
      method: 'turn/interrupt',
      params: {
        threadId: 'thread-rpc-interrupt',
        turnId: 'turn-rpc-interrupt',
      },
    })
  })

  test('an overlapping second send is rejected without orphaning the first receipt', async () => {
    const { proc, rejectTurnStart } = pendingTurnStartFixture('thread-1')
    const first = proc.sendUserText('first') as any
    const second = proc.sendUserText('second') as any

    expect(second).toMatchObject({ kind: 'rejected', provider: 'codex' })
    rejectTurnStart(new Error('first rejected'))
    expect(await first.settlement).toMatchObject({
      kind: 'rejected',
      deliveryId: first.deliveryId,
      threadId: 'thread-1',
    })
  })

  test('a conflicting same-thread completion cannot clear or complete the newer turn', async () => {
    const { proc, resultEvents } = pendingTurnStartFixture('thread-1')
    const dispatch = proc.sendUserText('newer') as any
    proc.handleNotification('turn/started', {
      threadId: 'thread-1',
      turn: { id: 'turn-newer' },
    })
    expect(await dispatch.settlement).toMatchObject({ kind: 'ack', turnId: 'turn-newer' })

    proc.handleNotification('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-stale', status: 'completed' },
    })

    expect(proc.currentTurnId).toBe('turn-newer')
    expect(proc.pendingTurnStart?.deliveryId).toBe(dispatch.deliveryId)
    expect(resultEvents).toEqual([])
  })

  for (const lateTurn of [
    { label: 'conflicting', value: { id: 'turn-bad' } },
    { label: 'empty', value: {} },
  ]) {
    test(`a late ${lateTurn.label} turn/started cannot replace an RPC-bound turn`, async () => {
      const { proc, resolveTurnStart, resultEvents } = pendingTurnStartFixture('thread-1')
      const startedEvents: unknown[] = []
      const emit = proc.emit
      proc.emit = (event: string, payload: unknown) => {
        if (event === 'turn_started') startedEvents.push(payload)
        return emit(event, payload)
      }
      const dispatch = proc.sendUserText('hello') as any
      resolveTurnStart({ turn: { id: 'turn-good' } })
      expect(await dispatch.settlement).toMatchObject({ kind: 'ack', turnId: 'turn-good' })

      proc.handleNotification('turn/started', {
        threadId: 'thread-1',
        turn: lateTurn.value,
      })

      expect(proc.currentTurnId).toBe('turn-good')
      expect(startedEvents).toEqual([])

      proc.handleNotification('turn/completed', {
        threadId: 'thread-1',
        turn: { id: 'turn-good', status: 'completed' },
      })
      expect(resultEvents).toEqual([
        expect.objectContaining({
          delivery_id: dispatch.deliveryId,
          thread_id: 'thread-1',
          turn_id: 'turn-good',
        }),
      ])
    })
  }

  test('a pre-init send defers turn/start until the thread initializes', async () => {
    const proc = Object.create(CodexProcess.prototype) as any
    const turnStart = deferred<unknown>()
    const requests: Array<{ method: string; params: any }> = []
    proc.opts = { workDir: '/tmp', effort: 'high' }
    proc.launchKind = 'fresh'
    proc.sessionId = null
    proc.alive = true
    proc.deliveryCounter = 0
    proc.pendingTurnStart = null
    proc.currentTurnId = null
    proc.lastUsage = null
    proc.emittedImageGenerationIds = new Set()
    proc.primeRolloutImageGenerationScan = () => {}
    proc.flushRolloutImageGenerations = () => {}
    proc.emit = () => true
    proc.request = (method: string, params: any) => {
      requests.push({ method, params })
      // 4185808:thread.path 成为 rollout 权威,init 响应必须带合法路径。
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 'thread-late-init', path: '/tmp/rollouts/thread-late-init.jsonl' } })
      if (method === 'turn/start') return turnStart.promise
      return Promise.resolve({})
    }

    const dispatch = proc.sendUserText('early hello') as any
    expect(dispatch.kind).toBe('turn_start_pending')
    expect(dispatch.threadId).toBeNull()
    expect(requests.filter(r => r.method === 'turn/start')).toEqual([])

    proc.sendInitialize()
    await proc.readyPromise
    for (let i = 0; i < 20 && !requests.some(r => r.method === 'turn/start'); i++) {
      await Promise.resolve()
    }
    expect(dispatch.threadId).toBe('thread-late-init')
    expect(requests).toContainEqual({
      method: 'turn/start',
      params: expect.objectContaining({ threadId: 'thread-late-init' }),
    })

    turnStart.resolve({ turn: { id: 'turn-late-init' } })
    expect(await dispatch.settlement).toEqual({
      kind: 'ack',
      deliveryId: dispatch.deliveryId,
      threadId: 'thread-late-init',
      turnId: 'turn-late-init',
    })
    expect(proc.currentTurnId).toBe('turn-late-init')
  })

  test('exit before init settles a pre-init delivery as rejected with its unbound thread', async () => {
    const proc = Object.create(CodexProcess.prototype) as any
    proc.opts = { workDir: '/tmp', effort: 'high' }
    proc.sessionId = null
    proc.alive = true
    proc.deliveryCounter = 0
    proc.pendingTurnStart = null
    proc.currentTurnId = null
    proc.lastUsage = null
    proc.emittedImageGenerationIds = new Set()
    proc.readyPromise = new Promise<void>(() => {})
    proc.emit = () => true

    const dispatch = proc.sendUserText('doomed hello') as any
    expect(dispatch.kind).toBe('turn_start_pending')

    proc.alive = false
    proc.rejectTurnStart(proc.pendingTurnStart, new Error('codex app-server exited'))
    expect(await dispatch.settlement).toMatchObject({
      kind: 'rejected',
      deliveryId: dispatch.deliveryId,
      threadId: null,
    })
  })
})

describe('codex process compaction notifications', () => {
  test('detects explicit thread compaction notifications', () => {
    const notice = contextCompactionNoticeFromNotification('thread/compacted', {
      threadId: 'thread-1',
      turnId: 'turn-1',
    })

    expect(notice?.sourceMethod).toBe('thread/compacted')
    expect(notice?.threadId).toBe('thread-1')
    expect(notice?.turnId).toBe('turn-1')
  })

  test('detects Codex event messages persisted as context_compacted', () => {
    const notice = contextCompactionNoticeFromNotification('event_msg', {
      type: 'context_compacted',
    })

    expect(notice?.sourceMethod).toBe('event_msg')
    expect(notice?.sourceType).toBe('context_compacted')
    expect(notice?.phase).toBe('end')
  })

  test('detects raw compacted records with replacement history', () => {
    const notice = contextCompactionNoticeFromMessage({
      timestamp: '2026-06-03T16:03:16.331Z',
      type: 'compacted',
      payload: {
        message: '',
        replacement_history: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: '旧消息' }] },
        ],
      },
    })

    expect(notice?.sourceMethod).toBe('compacted')
    expect(notice?.sourceType).toBe('compacted')
    expect(notice?.phase).toBe('start')
    expect(notice?.timestamp).toBe('2026-06-03T16:03:16.331Z')
    expect(notice?.replacement_history).toHaveLength(1)
  })

  test('detects raw response compaction items', () => {
    const notice = contextCompactionNoticeFromNotification('rawResponseItem/completed', {
      item: {
        type: 'contextCompaction',
        id: 'item-1',
      },
      threadId: 'thread-2',
    })

    expect(notice?.sourceMethod).toBe('rawResponseItem/completed')
    expect(notice?.sourceType).toBe('contextCompaction')
    expect(notice?.phase).toBe('end')
    expect(notice?.itemId).toBe('item-1')
    expect(notice?.threadId).toBe('thread-2')
  })

  test('marks live app-server context compaction item start and completion', () => {
    const started = contextCompactionNoticeFromNotification('item/started', {
      item: {
        type: 'contextCompaction',
        id: 'compact-1',
      },
      threadId: 'thread-3',
      turnId: 'turn-3',
    })
    const completed = contextCompactionNoticeFromNotification('item/completed', {
      item: {
        type: 'contextCompaction',
        id: 'compact-1',
        replacementHistory: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: '旧消息' }] },
        ],
      },
      threadId: 'thread-3',
      turnId: 'turn-3',
    })

    expect(started?.phase).toBe('start')
    expect(started?.itemId).toBe('compact-1')
    expect(started?.threadId).toBe('thread-3')
    expect(completed?.phase).toBe('end')
    expect(completed?.itemId).toBe('compact-1')
    expect(completed?.replacementHistory).toHaveLength(1)
  })

  test('ignores unrelated notifications', () => {
    expect(contextCompactionNoticeFromNotification('thread/settings/updated', {
      threadSettings: { model: 'gpt-5' },
    })).toBeNull()
  })

  test('unmapped app-server notifications are logged without breaking message handling', () => {
    const proc = Object.create(CodexProcess.prototype) as any
    const raw: unknown[] = []
    const compacted: unknown[] = []
    proc.opts = { workDir: '/tmp' }
    proc.emit = (event: string, payload: unknown) => {
      if (event === 'raw') raw.push(payload)
      if (event === 'context_compacted') compacted.push(payload)
      return true
    }

    expect(() => proc.handleNotification('item/started', {
      item: { type: 'contextCompaction', id: 'compact-2' },
      threadId: 'thread-4',
      turnId: 'turn-4',
    })).not.toThrow()
    expect(() => proc.handleNotification('thread/status/changed', {
      threadId: 'thread-4',
      status: { type: 'idle' },
    })).not.toThrow()
    expect(() => proc.handleNotification('item/started', {
      item: { type: 'reasoning', id: 'rs-1', summary: [], content: [] },
      threadId: 'thread-4',
      turnId: 'turn-4',
    })).not.toThrow()
    // thread/status/changed 已从高频静默 raw 名单改道 handleThreadStatusChanged
    // (cf41941):未知线程 no-op,不再 emit raw。
    expect(raw).toHaveLength(0)
    expect(compacted).toHaveLength(1)
  })

  test('ignores child-thread completion and compaction while the primary turn is running', () => {
    const proc = Object.create(CodexProcess.prototype) as any
    const events: string[] = []
    proc.opts = { workDir: '/tmp' }
    proc.sessionId = 'primary-thread'
    proc.currentTurnId = 'primary-turn'
    proc.lastUsage = null
    proc.emit = (event: string) => {
      events.push(event)
      return true
    }

    proc.handleNotification('thread/started', {
      thread: { id: 'child-thread' },
    })
    proc.handleNotification('turn/started', {
      threadId: 'child-thread',
      turn: { id: 'child-turn' },
    })
    proc.handleNotification('turn/completed', {
      threadId: 'child-thread',
      turn: { id: 'child-turn', status: 'completed' },
    })
    proc.handleNotification('item/completed', {
      threadId: 'child-thread',
      turnId: 'child-turn',
      item: { type: 'contextCompaction', id: 'child-compact' },
    })
    proc.handleMessage({
      type: 'context_compacted',
      threadId: 'child-thread',
      turnId: 'child-turn',
    })

    expect(proc.sessionId).toBe('primary-thread')
    expect(proc.currentTurnId).toBe('primary-turn')
    expect(events).toEqual([])

    proc.handleNotification('item/completed', {
      threadId: 'primary-thread',
      turnId: 'primary-turn',
      item: { type: 'contextCompaction', id: 'primary-compact' },
    })
    proc.handleNotification('turn/completed', {
      threadId: 'primary-thread',
      turn: { id: 'primary-turn', status: 'completed' },
    })

    expect(events).toEqual(['context_compacted', 'result'])
    expect(proc.currentTurnId).toBeNull()
  })

  test('uses the requested resume thread as the primary filter before init completes', () => {
    const proc = Object.create(CodexProcess.prototype) as any
    proc.opts = { workDir: '/tmp', resumeSessionId: 'resume-thread' }
    proc.sessionId = null

    proc.handleNotification('thread/started', {
      thread: { id: 'child-thread' },
    })
    expect(proc.sessionId).toBeNull()

    proc.handleNotification('thread/started', {
      thread: { id: 'resume-thread' },
    })
    expect(proc.sessionId).toBe('resume-thread')
  })

  test('rejects child-thread server requests without exposing them to the primary session', () => {
    const proc = Object.create(CodexProcess.prototype) as any
    const events: string[] = []
    const responses: any[] = []
    proc.opts = { workDir: '/tmp' }
    proc.sessionId = 'primary-thread'
    proc.serverRequests = new Map()
    proc.emit = (event: string) => {
      events.push(event)
      return true
    }
    proc.write = (response: any) => responses.push(response)

    proc.handleMessage({
      id: 1,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'child-thread',
        itemId: 'child-ask',
        questions: [],
      },
    })

    expect(events).toEqual([])
    expect(responses).toEqual([{
      id: 1,
      error: { code: -32601, message: 'server request belongs to a child thread' },
    }])
    expect(proc.serverRequests.size).toBe(0)

    proc.handleMessage({
      id: 2,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'primary-thread',
        itemId: 'primary-ask',
        questions: [],
      },
    })

    expect(events).toEqual(['tool_use', 'can_use_tool'])
    expect(proc.serverRequests.has('2')).toBe(true)
  })

  test('maps snake_case image generation fields to a sendable result path', () => {
    const proc = Object.create(CodexProcess.prototype) as any
    const events: Array<[string, any]> = []
    proc.opts = { workDir: '/tmp' }
    proc.emittedImageGenerationIds = new Set()
    proc.emit = (event: string, payload: unknown) => {
      events.push([event, payload])
      return true
    }

    proc.handleNotification('item/started', {
      item: {
        type: 'imageGeneration',
        id: 'img-1',
        status: 'inProgress',
        revised_prompt: 'A cute cat curled up in a sunbeam.',
      },
      threadId: 'thread-5',
      turnId: 'turn-5',
    })
    proc.handleNotification('item/completed', {
      item: {
        type: 'imageGeneration',
        id: 'img-1',
        status: 'completed',
        revised_prompt: 'A cute cat curled up in a sunbeam.',
        saved_path: '/tmp/cat.png',
        result: 'ignored when saved_path exists',
      },
      threadId: 'thread-5',
      turnId: 'turn-5',
    })

    expect(events).toEqual([
      ['tool_use', {
        id: 'img-1',
        name: 'ImageGeneration',
        input: {
          status: 'inProgress',
          revisedPrompt: 'A cute cat curled up in a sunbeam.',
        },
      }],
      ['tool_result', {
        tool_use_id: 'img-1',
        content: '/tmp/cat.png',
        is_error: false,
      }],
    ])
  })

  test('materializes inline base64 image generation results to a sendable file path', () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-imggen-'))
    try {
      const output = imageGenerationOutput({
        call_id: 'ig-inline',
        result: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      }, 'thread-inline', root)

      expect(output).toBe(join(root, 'thread-inline', 'ig-inline.png'))
      expect(readFileSync(output).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('codex model settings boundary', () => {
  test('rejects live model updates without sending thread/settings/update', async () => {
    const proc = Object.create(CodexProcess.prototype) as any
    const requests: string[] = []
    proc.opts = { workDir: '/tmp', model: 'old-model', effort: 'high' }
    proc.sessionId = 'thread-model-settings'
    proc.readyPromise = Promise.resolve()
    proc.request = async (method: string) => { requests.push(method) }

    await expect(proc.setModelSettings('gpt-5.6-sol', 'max'))
      .rejects.toThrow('does not support live model settings')
    expect(requests).toEqual([])
    expect(proc.opts).toMatchObject({ model: 'old-model', effort: 'high' })
  })
})

describe('codex structured progress notifications', () => {
  test('preserves dynamic tool input and camelCase completion content from stdin notifications', () => {
    const { proc, events } = notificationHarness()

    proc.handleNotification('item/started', {
      threadId: 'thread-structured',
      turnId: 'turn-structured',
      item: {
        type: 'dynamicToolCall',
        id: 'call-1',
        tool: 'exec',
        arguments: 'text("ready");\n',
      },
    })
    proc.handleNotification('item/completed', {
      threadId: 'thread-structured',
      turnId: 'turn-structured',
      item: {
        type: 'dynamicToolCall',
        id: 'call-1',
        tool: 'exec',
        success: true,
        contentItems: [
          { type: 'inputText', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
          { type: 'inputText', text: 'ready' },
        ],
      },
    })

    expect(events).toEqual([
      ['tool_use', {
        id: 'call-1',
        name: 'exec',
        input: 'text("ready");\n',
      }],
      ['tool_result', {
        tool_use_id: 'call-1',
        content: JSON.stringify([
          { type: 'inputText', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
          { type: 'inputText', text: 'ready' },
        ], null, 2),
        is_error: false,
      }],
    ])
  })

  test('maps sub-agent activity items without relying on a status field', () => {
    const { proc, events } = notificationHarness()
    const shared = {
      type: 'subAgentActivity',
      agentThreadId: 'agent-thread-1',
      agentPath: '/root/worker-1',
    }

    proc.handleNotification('item/started', {
      threadId: 'thread-structured',
      turnId: 'turn-structured',
      item: { ...shared, id: 'activity-start', kind: 'started' },
    })
    proc.handleNotification('item/completed', {
      threadId: 'thread-structured',
      turnId: 'turn-structured',
      item: { ...shared, id: 'activity-interact', kind: 'interacted' },
    })
    proc.handleNotification('item/completed', {
      threadId: 'thread-structured',
      turnId: 'turn-structured',
      item: { ...shared, id: 'activity-stop', kind: 'interrupted' },
    })

    // 双通路(RESEARCH #12):subagent_activity 观测 emit 保留(watchdog 喂养),
    // collab 状态机同时翻译出 bg_task_*(游标卡)。
    expect(events).toEqual([
      ['subagent_activity', {
        activityId: 'activity-start',
        agentThreadId: 'agent-thread-1',
        agentPath: '/root/worker-1',
        kind: 'started',
      }],
      ['bg_task_started', {
        task_id: 'agent-thread-1',
        task_type: 'local_agent',
        description: 'worker-1',
      }],
      ['bg_task_updated', {
        task_id: 'agent-thread-1',
        patch: { is_backgrounded: true },
      }],
      ['subagent_activity', {
        activityId: 'activity-interact',
        agentThreadId: 'agent-thread-1',
        agentPath: '/root/worker-1',
        kind: 'interacted',
      }],
      ['subagent_activity', {
        activityId: 'activity-stop',
        agentThreadId: 'agent-thread-1',
        agentPath: '/root/worker-1',
        kind: 'interrupted',
      }],
      ['bg_task_updated', {
        task_id: 'agent-thread-1',
        patch: { status: 'paused' },
      }],
    ])
  })

  test('emits collab agent state and translates agentsStates to bg events without a tool result', () => {
    const { proc, events } = notificationHarness()
    const agentsStates = {
      'agent-thread-running': { status: 'running' },
      'agent-thread-completed': { status: 'completed' },
      'agent-thread-missing': {},
    }

    proc.handleNotification('item/completed', {
      threadId: 'thread-structured',
      turnId: 'turn-structured',
      item: {
        type: 'collabAgentToolCall',
        id: 'collab-1',
        tool: 'spawn_agent',
        status: 'completed',
        agentsStates,
      },
    })

    // timeline 压缩(cf41941):collabAgentToolCall 不再产出 agentsStates JSON
    // dump 的 tool_result;collab_agent_state 观测 emit(watchdog)保留,
    // agentsStates 翻译为 bg_task_*(占位名入池 → running / settled)。
    expect(events.filter(([event]) => event === 'tool_result')).toEqual([])
    expect(events[0]).toEqual(['collab_agent_state', { toolUseId: 'collab-1', agentsStates }])
    expect(events.slice(1)).toEqual([
      ['bg_task_started', { task_id: 'agent-thread-running', task_type: 'local_agent', description: '子 agent', prompt: undefined }],
      ['bg_task_updated', { task_id: 'agent-thread-running', patch: { is_backgrounded: true } }],
      ['bg_task_updated', { task_id: 'agent-thread-running', patch: { status: 'running' } }],
      ['bg_task_started', { task_id: 'agent-thread-completed', task_type: 'local_agent', description: '子 agent', prompt: undefined }],
      ['bg_task_updated', { task_id: 'agent-thread-completed', patch: { is_backgrounded: true } }],
      ['bg_task_settled', { task_id: 'agent-thread-completed', status: 'completed', summary: undefined }],
    ])
  })

  test.each([
    ['empty string', ''],
    ['number', 42],
  ])('suppresses collab state for an invalid %s id but still translates agentsStates', (_label, id) => {
    const { proc, events } = notificationHarness()
    const agentsStates = { 'agent-thread-1': { status: 'running' } }

    proc.handleNotification('item/completed', {
      threadId: 'thread-structured',
      turnId: 'turn-structured',
      item: {
        type: 'collabAgentToolCall',
        id,
        tool: 'spawn_agent',
        status: 'completed',
        agentsStates,
      },
    })

    expect(events.filter(([event]) => event === 'collab_agent_state')).toEqual([])
    // timeline 压缩后 collabAgentToolCall 不再出 tool_result;bg 翻译不依赖 item.id。
    expect(events.filter(([event]) => event === 'tool_result')).toEqual([])
    expect(events.filter(([event]) => event === 'bg_task_started')).toHaveLength(1)
  })

  test.each([
    ['array payload', []],
    ['string payload', 'running'],
    ['number payload', 1],
    ['non-plain payload', new Date(0)],
    ['null entry', { 'agent-thread-1': null }],
    ['array entry', { 'agent-thread-1': [] }],
    ['string entry', { 'agent-thread-1': 'running' }],
    ['non-plain entry', { 'agent-thread-1': new Date(0) }],
    ['non-string status', { 'agent-thread-1': { status: 1 } }],
  ])('rejects malformed collab agent state %s', (_label, agentsStates) => {
    const { proc, events } = notificationHarness()

    proc.handleNotification('item/completed', {
      threadId: 'thread-structured',
      turnId: 'turn-structured',
      item: {
        type: 'collabAgentToolCall',
        id: 'collab-invalid',
        tool: 'spawn_agent',
        status: 'completed',
        agentsStates,
      },
    })

    expect(events.filter(([event]) => event === 'collab_agent_state')).toEqual([])
    // 恶意/畸形 agentsStates:观测 emit 拒收(既有防线),bg 翻译零事件,
    // timeline 压缩后也不再有 tool_result。
    expect(events.filter(([event]) => event === 'tool_result')).toEqual([])
    expect(events.filter(([event]) => event.startsWith('bg_task_'))).toEqual([])
  })
})

describe('codex 多 agent collab→bg 翻译状态机(上游 cf41941)', () => {
  test('exec-cell 生命周期:spawn→创建 idle 不结算→active→agentMessage 采集→idle 结算 completed(summary 墓碑)→重复 idle 去重', () => {
    const { proc, events } = notificationHarness()
    proc.handleNotification('item/started', {
      threadId: 'thread-structured',
      item: { type: 'subAgentActivity', id: 'act-1', kind: 'started', agentThreadId: 'sub-1', agentPath: '/root/order/worker' },
    })
    expect(events).toEqual([
      ['subagent_activity', { activityId: 'act-1', agentThreadId: 'sub-1', agentPath: '/root/order/worker', kind: 'started' }],
      ['bg_task_started', { task_id: 'sub-1', task_type: 'local_agent', description: 'worker' }],
      ['bg_task_updated', { task_id: 'sub-1', patch: { is_backgrounded: true } }],
    ])
    events.length = 0

    // 首个 idle 是创建态(spawn 后未开跑):没见过 active 不结算。
    proc.handleNotification('thread/status/changed', { threadId: 'sub-1', status: { type: 'idle' } })
    expect(events).toEqual([])

    proc.handleNotification('thread/status/changed', { threadId: 'sub-1', status: { type: 'active' } })
    expect(events).toEqual([['bg_task_updated', { task_id: 'sub-1', patch: { status: 'running' } }]])
    events.length = 0

    // 外线程 agentMessage:捕获末段文本作 summary,不出 step、不进主卡。
    proc.handleNotification('item/completed', {
      threadId: 'sub-1',
      item: { type: 'agentMessage', id: 'am-1', text: '结论:全部通过' },
    })
    expect(events).toEqual([])

    proc.handleNotification('thread/status/changed', { threadId: 'sub-1', status: { type: 'idle' } })
    expect(events).toEqual([['bg_task_settled', { task_id: 'sub-1', status: 'completed', summary: '结论:全部通过' }]])
    events.length = 0

    // 重复终态快照:settled 去重。
    proc.handleNotification('thread/status/changed', { threadId: 'sub-1', status: { type: 'idle' } })
    expect(events).toEqual([])
  })

  test('systemError 结算 failed;followup 复活(active 再临)清标记重新入池', () => {
    const { proc, events } = notificationHarness()
    proc.handleNotification('item/started', {
      threadId: 'thread-structured',
      item: { type: 'subAgentActivity', id: 'act-2', kind: 'started', agentThreadId: 'sub-2', agentPath: '/root/fixer' },
    })
    proc.handleNotification('thread/status/changed', { threadId: 'sub-2', status: { type: 'active' } })
    events.length = 0

    proc.handleNotification('thread/status/changed', { threadId: 'sub-2', status: { type: 'systemError' } })
    expect(events).toEqual([['bg_task_settled', { task_id: 'sub-2', status: 'failed', summary: undefined }]])
    events.length = 0

    // 复活:closeAgent/终态后线程重新 active → 清 settled 标记 + 重新入池 + running。
    proc.handleNotification('thread/status/changed', { threadId: 'sub-2', status: { type: 'active' } })
    expect(events).toEqual([
      ['bg_task_started', { task_id: 'sub-2', task_type: 'local_agent', description: 'fixer' }],
      ['bg_task_updated', { task_id: 'sub-2', patch: { is_backgrounded: true } }],
      ['bg_task_updated', { task_id: 'sub-2', patch: { status: 'running' } }],
    ])
    events.length = 0

    proc.handleNotification('thread/status/changed', { threadId: 'sub-2', status: { type: 'idle' } })
    expect(events).toEqual([['bg_task_settled', { task_id: 'sub-2', status: 'completed', summary: undefined }]])
  })

  test('未知线程的 thread/status/changed 不驱动后台卡(主线程/未 spawn 线程)', () => {
    const { proc, events } = notificationHarness()
    proc.handleNotification('thread/status/changed', { threadId: 'thread-structured', status: { type: 'active' } })
    proc.handleNotification('thread/status/changed', { threadId: 'sub-unknown', status: { type: 'active' } })
    expect(events).toEqual([])
  })

  test('spawn-first 占位名入卡(密文任务书归一)+ subAgentActivity 后到补名', () => {
    const { proc, events } = notificationHarness()
    const fernet = 'gAAAAB' + 'x'.repeat(60)
    proc.handleNotification('item/started', {
      threadId: 'thread-structured',
      item: {
        type: 'collabAgentToolCall',
        id: 'collab-9',
        tool: 'spawnAgent',
        status: 'inProgress',
        prompt: fernet,
        model: 'gpt-5.6-sol',
        receiverThreadIds: ['sub-9'],
        agentsStates: { 'sub-9': { status: 'pendingInit' } },
      },
    })
    expect(events).toEqual([
      ['bg_task_started', { task_id: 'sub-9', task_type: 'local_agent', description: '子 agent', prompt: '(继承主线程历史的密文任务书)' }],
      ['bg_task_updated', { task_id: 'sub-9', patch: { is_backgrounded: true } }],
      ['bg_task_updated', { task_id: 'sub-9', patch: { status: 'pending' } }],
      // spawn 在主卡留一行摘要面板 —— prompt 密文归一,description 写「派生 N 个子 agent」。
      ['tool_use', {
        id: 'collab-9',
        name: 'Agent',
        input: { tool: 'spawnAgent', prompt: '(继承主线程历史的密文任务书)', description: '派生 1 个子 agent', model: 'gpt-5.6-sol' },
      }],
    ])
    events.length = 0

    // agentPath 真名后到:已知 id 补名(仅 started patch,不重发 is_backgrounded)。
    proc.handleNotification('item/started', {
      threadId: 'thread-structured',
      item: { type: 'subAgentActivity', id: 'act-9', kind: 'started', agentThreadId: 'sub-9', agentPath: '/root/order/writer' },
    })
    expect(events).toEqual([
      ['subagent_activity', { activityId: 'act-9', agentThreadId: 'sub-9', agentPath: '/root/order/writer', kind: 'started' }],
      ['bg_task_started', { task_id: 'sub-9', task_type: 'local_agent', description: 'writer' }],
    ])
  })

  test('timeline 压缩:wait/sendInput 编排调用不出面板;spawn completed 出摘要 result;closeAgent 强制结算 receiver', () => {
    const { proc, events } = notificationHarness()
    proc.handleNotification('item/started', {
      threadId: 'thread-structured',
      item: { type: 'subAgentActivity', id: 'act-3', kind: 'started', agentThreadId: 'sub-3', agentPath: '/root/runner' },
    })
    events.length = 0

    // wait:无独立信息量,不出 tool_use/tool_result;collab_agent_state 观测保留。
    proc.handleNotification('item/completed', {
      threadId: 'thread-structured',
      item: { type: 'collabAgentToolCall', id: 'collab-w', tool: 'wait', status: 'completed', agentsStates: { 'sub-3': { status: 'running' } } },
    })
    expect(events).toEqual([
      ['collab_agent_state', { toolUseId: 'collab-w', agentsStates: { 'sub-3': { status: 'running' } } }],
      ['bg_task_updated', { task_id: 'sub-3', patch: { status: 'running' } }],
    ])
    events.length = 0

    // spawnAgent completed:tool_result 是逐 agent「线程前8: 状态」摘要,不再 JSON dump。
    proc.handleNotification('item/completed', {
      threadId: 'thread-structured',
      item: { type: 'collabAgentToolCall', id: 'collab-s', tool: 'spawnAgent', status: 'completed', receiverThreadIds: ['sub-3'], agentsStates: { 'sub-3': { status: 'running' } } },
    })
    expect(events).toEqual([
      ['collab_agent_state', { toolUseId: 'collab-s', agentsStates: { 'sub-3': { status: 'running' } } }],
      ['bg_task_updated', { task_id: 'sub-3', patch: { status: 'running' } }],
      ['tool_result', { tool_use_id: 'collab-s', content: 'sub-3: running', is_error: false }],
    ])
    events.length = 0

    // closeAgent completed:关闭前快照常见 running —— receiver 无条件结算 stopped。
    proc.handleNotification('item/completed', {
      threadId: 'thread-structured',
      item: { type: 'collabAgentToolCall', id: 'collab-c', tool: 'closeAgent', status: 'completed', receiverThreadIds: ['sub-3'], agentsStates: { 'sub-3': { status: 'running' } } },
    })
    expect(events).toEqual([
      ['collab_agent_state', { toolUseId: 'collab-c', agentsStates: { 'sub-3': { status: 'running' } } }],
      ['bg_task_updated', { task_id: 'sub-3', patch: { status: 'running' } }],
      ['bg_task_settled', { task_id: 'sub-3', status: 'stopped' }],
    ])
  })

  test('外线程工具 item 改道 subagent_step:started 带命令 brief,completed 回填输出;reasoning 不占 steps 预算', () => {
    const { proc, events } = notificationHarness()
    proc.handleNotification('item/started', {
      threadId: 'sub-x',
      item: { type: 'commandExecution', id: 'cmd-1', command: 'bun test', cwd: '/tmp' },
    })
    expect(events).toEqual([
      ['subagent_step', { thread_id: 'sub-x', item_id: 'cmd-1', tool: 'Bash', phase: 'started', brief: '`bun test`' }],
    ])
    events.length = 0

    proc.handleNotification('item/completed', {
      threadId: 'sub-x',
      item: { type: 'commandExecution', id: 'cmd-1', aggregatedOutput: '12 pass\n0 fail\n', exitCode: 0 },
    })
    expect(events).toHaveLength(1)
    expect(events[0][0]).toBe('subagent_step')
    expect(events[0][1]).toMatchObject({ thread_id: 'sub-x', item_id: 'cmd-1', phase: 'completed', brief: '→ 12 pass 0 fail' })
    events.length = 0

    // reasoning 每轮上百条,转空 step 会刷满 ~1000 字符预算 —— 不出 step。
    proc.handleNotification('item/started', {
      threadId: 'sub-x',
      item: { type: 'reasoning', id: 'rs-9', summary: [], content: [] },
    })
    expect(events).toEqual([])
  })

  test('外线程其余事件(turn/delta/usage)仍全吞掉,不冒充主轮信号', () => {
    const { proc, events } = notificationHarness()
    proc.handleNotification('turn/completed', { threadId: 'sub-y', turn: { id: 't-y', status: 'completed' } })
    proc.handleNotification('item/agentMessage/delta', { threadId: 'sub-y', itemId: 'am-y', delta: '子 agent 正文' })
    proc.handleNotification('thread/tokenUsage/updated', { threadId: 'sub-y', tokenUsage: { last: { totalTokens: 9 } } })
    expect(events).toEqual([])
  })
})

// ── 上游 ec149d7 主题 H:控制面加固 ─────────────────────────────────
// 30s 控制请求超时 / write 前置可写检查 / rejectPendingRequests /
// SIGTERM→SIGKILL waitForExit / rollout StringDecoder+remainder。
function makeCodexLifecycleHarness(stdinOverrides: Record<string, unknown> = {}): any {
  const proc = Object.create(CodexProcess.prototype) as any
  proc.alive = true
  proc.expectedExit = false
  proc.requestCounter = 0
  proc.pending = new Map()
  proc.serverRequests = new Map()
  proc.stdinErrorListenerAttached = true
  proc.proc = {
    stdin: {
      destroyed: false,
      writableEnded: false,
      writable: true,
      write: () => true,
      ...stdinOverrides,
    },
    kill: () => true,
  }
  proc.exitPromise = new Promise<void>(resolve => { proc.resolveExit = resolve })
  return proc
}

/** bun 1.3.5 对「await 永不 settle 的 promise + per-test timeout」会忙旋而非判超时
 *  (本仓实测 88% CPU 挂死)—— 用 race 包住被测 promise,悬挂时测试自身仍快速失败。 */
async function settlementWithin(promise: Promise<unknown>, timeoutMs = 500): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise.then(() => 'resolved', (e: Error) => `rejected: ${e.message}`),
      new Promise<string>(resolve => {
        timer = setTimeout(() => resolve('hung'), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe('codex JSON-RPC 控制面可靠性(上游 ec149d7 主题 H)', () => {
  test('未答控制请求按超时拒绝并从 pending 移除', async () => {
    const proc = makeCodexLifecycleHarness()

    const outcome = await settlementWithin(proc.request('thread/start', {}, 5))
    expect(outcome).toContain('timed out after 5ms')
    expect(proc.pending.size).toBe(0)
  })

  test('stdin 不可写时同步拒绝,不留悬挂 pending', async () => {
    const proc = makeCodexLifecycleHarness({ writable: false })

    const outcome = await settlementWithin(proc.request('initialize', {}, 20))
    expect(outcome).toContain('stdin is not writable')
    expect(proc.pending.size).toBe(0)
  })

  test('SIGTERM/SIGKILL 都杀不死时 kill 如实拒绝,不静默返回', async () => {
    const proc = makeCodexLifecycleHarness()
    const signals: string[] = []
    proc.proc.kill = (signal: string) => {
      signals.push(signal)
      return true
    }

    await expect(proc.kill(2)).rejects.toThrow('did not exit after SIGTERM and SIGKILL')
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  test('先注册 pending 再写,响应到达清 pending 与超时定时器', async () => {
    let written = ''
    const proc = makeCodexLifecycleHarness({
      write: (chunk: string) => {
        written = chunk
        const id = JSON.parse(chunk).id
        proc.handleMessage({ id, result: { ok: true } })
        return true
      },
    })

    await expect(proc.request('model/list', {}, 20)).resolves.toEqual({ ok: true })
    expect(JSON.parse(written)).toMatchObject({ id: 1, method: 'model/list' })
    expect(proc.pending.size).toBe(0)
  })

  test('异步 stdin 写失败以原始 error 拒绝(EPIPE 可分类),pending 不泄漏', async () => {
    const epipe = Object.assign(new Error('EPIPE'), { code: 'EPIPE' })
    const proc = makeCodexLifecycleHarness({
      write: (_chunk: string, callback: (error?: Error) => void) => {
        queueMicrotask(() => callback(epipe))
        return true
      },
    })

    const outcome = await settlementWithin(proc.request('initialize', {}, 200))
    expect(outcome).toContain('EPIPE')
    expect(proc.pending.size).toBe(0)
  })

  test('SIGTERM 未死升级 SIGKILL 并等真实 exit 才返回', async () => {
    const proc = makeCodexLifecycleHarness()
    const signals: string[] = []
    proc.proc.kill = (signal: string) => {
      signals.push(signal)
      if (signal === 'SIGKILL') {
        queueMicrotask(() => {
          proc.alive = false
          proc.resolveExit()
        })
      }
      return true
    }

    await expect(proc.kill(5)).resolves.toBeUndefined()
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(proc.alive).toBe(false)
  })
})

// ── 上游 4185808 主题 D:codex materialization 验证与事件次序纪律 ──────
// conversationResumable/rollout 路径权威 + thread/read 5s 验证 +
// conversation_materialized/_materialization_failed 事件 + CodexRpcResponseError
// 分类 + exit-close drain 次序 + stdin EPIPE 不连坐 + spawn 失败终态化。
function materializationHarness(workDir: string): {
  proc: any
  events: Array<[string, any]>
  requests: Array<{ method: string; params: any; timeoutMs?: number }>
} {
  const proc = Object.create(CodexProcess.prototype) as any
  const events: Array<[string, any]> = []
  const requests: Array<{ method: string; params: any; timeoutMs?: number }> = []
  proc.opts = { workDir, effort: 'high' }
  proc.sessionId = 'thread-mat'
  proc.alive = true
  proc.expectedExit = false
  proc.pendingTurnStart = null
  proc.currentTurnId = null
  proc.lastUsage = null
  proc.conversationResumable = false
  proc.conversationRolloutPath = null
  proc.conversationMaterializationVerification = null
  proc.conversationMaterializationRetrySource = null
  proc.lastConversationMaterializationFailure = null
  proc.emittedImageGenerationIds = new Set()
  proc.flushRolloutImageGenerations = () => {}
  proc.emit = (event: string, payload: unknown) => {
    events.push([event, payload])
    return true
  }
  proc.request = (method: string, params: any, timeoutMs?: number) => {
    requests.push({ method, params, timeoutMs })
    return Promise.resolve({
      thread: { id: proc.sessionId, cwd: workDir, path: proc.conversationRolloutPath, turns: [] },
    })
  }
  return { proc, events, requests }
}

/** 驱动 materialization 验证收敛:等 barrier(失败吞掉)+ 两拍微任务让
 *  emit/finally 续体跑完。RED 阶段 barrier 方法不存在时为 no-op。 */
async function drainMaterialization(proc: any): Promise<void> {
  const barrier = proc.conversationMaterializationBarrier?.()
  if (barrier) await barrier.catch(() => {})
  await Promise.resolve()
  await Promise.resolve()
}

describe('codex conversation materialization 验证(上游 4185808 主题 D)', () => {
  test('turn/started 触发 thread/read(5s 超时)验证,rollout 在盘 → conversation_materialized + resumable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-mat-'))
    try {
      const rollout = join(root, 'thread-mat.jsonl')
      writeFileSync(rollout, '{"type":"turn_started"}\n')
      const { proc, events, requests } = materializationHarness(root)
      proc.conversationRolloutPath = rollout

      proc.handleNotification('turn/started', { threadId: 'thread-mat', turn: { id: 'turn-1' } })
      await drainMaterialization(proc)

      expect(requests).toContainEqual({
        method: 'thread/read',
        params: { threadId: 'thread-mat', includeTurns: true },
        timeoutMs: 5000,
      })
      expect(events).toContainEqual(['turn_started', { turn_id: 'turn-1', thread_id: 'thread-mat' }])
      expect(events).toContainEqual([
        'conversation_materialized',
        { session_id: 'thread-mat', source: 'turn/started notification' },
      ])
      expect(proc.isConversationResumable()).toBe(true)
      expect(proc.conversationMaterializationFailure()).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rollout 不在盘 → conversation_materialization_failed 可观测且不置 resumable;下一信号重验成功补发 materialized', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-mat-fail-'))
    try {
      const rollout = join(root, 'thread-mat.jsonl')
      const { proc, events } = materializationHarness(root)
      proc.conversationRolloutPath = rollout // 文件不存在:statSync 失败

      proc.handleNotification('turn/started', { threadId: 'thread-mat', turn: { id: 'turn-1' } })
      await drainMaterialization(proc)

      const failed = events.filter(([name]) => name === 'conversation_materialization_failed')
      expect(failed).toHaveLength(1)
      expect(failed[0][1]).toMatchObject({
        session_id: 'thread-mat',
        path: rollout,
        source: 'turn/started notification',
      })
      expect(failed[0][1].error).toBeInstanceOf(Error)
      expect(proc.isConversationResumable()).toBe(false)
      expect(proc.conversationMaterializationFailure()).toBeInstanceOf(Error)

      // 落盘后同 turn 的下一个 turn/started 重验成功 → materialized 补发。
      writeFileSync(rollout, '{"type":"turn_started"}\n')
      proc.handleNotification('turn/started', { threadId: 'thread-mat', turn: { id: 'turn-1' } })
      await drainMaterialization(proc)

      expect(events).toContainEqual([
        'conversation_materialized',
        { session_id: 'thread-mat', source: 'turn/started notification' },
      ])
      expect(proc.isConversationResumable()).toBe(true)
      expect(proc.conversationMaterializationFailure()).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('RPC 响应错误分类为 CodexRpcResponseError(method/id/code/message);字符串错误 code=null', async () => {
    const mod = (await import('./codex-process')) as any
    const proc = makeCodexLifecycleHarness()

    const first = proc.request('thread/resume', {}, 200)
    proc.handleMessage({ id: 1, error: { code: -32600, message: 'no rollout found for thread id thread-mat' } })
    const firstError = await first.then(() => null, (e: Error) => e)
    expect(firstError).toBeInstanceOf(mod.CodexRpcResponseError)
    expect(firstError).toMatchObject({
      name: 'CodexRpcResponseError',
      method: 'thread/resume',
      requestId: 1,
      serverCode: -32600,
      serverMessage: 'no rollout found for thread id thread-mat',
    })

    const second = proc.request('thread/read', {}, 200)
    proc.handleMessage({ id: 2, error: 'boom' })
    const secondError = await second.then(() => null, (e: Error) => e)
    expect(secondError).toBeInstanceOf(mod.CodexRpcResponseError)
    expect(secondError).toMatchObject({ serverCode: null, serverMessage: 'boom' })

    // 传输错误(写失败)保留原始 error 分类(01-09 契约),不得包成 RPC 响应错误。
    const epipe = Object.assign(new Error('EPIPE'), { code: 'EPIPE' })
    const transport = makeCodexLifecycleHarness({
      write: (_chunk: string, callback: (error?: Error) => void) => {
        queueMicrotask(() => callback(epipe))
        return true
      },
    })
    const third = transport.request('initialize', {}, 200)
    const thirdError = await third.then(() => null, (e: Error) => e)
    expect((thirdError as any).code).toBe('EPIPE')
    expect(thirdError).not.toBeInstanceOf(mod.CodexRpcResponseError)
  })
})

describe('codex exit-close-error 事件次序纪律(上游 4185808 主题 D)', () => {
  function lifecycleEventHarness(): { proc: any; events: Array<[string, any]> } {
    const proc = makeCodexLifecycleHarness()
    const events: Array<[string, any]> = []
    proc.stdoutBuf = ''
    proc.stderrBuf = ''
    proc.exitEventEmitted = false
    proc.childExitCode = null
    proc.childExitSignal = null
    proc.conversationMaterializationVerification = null
    proc.emit = (event: string, payload: unknown) => {
      events.push([event, payload])
      return true
    }
    return { proc, events }
  }

  test('exit 先到不拒未答请求;close 先 drain stdout tail(final response 不丢)再拒真正未答', async () => {
    const { proc, events } = lifecycleEventHarness()
    const answered = proc.request('turn/start', {}, 1000)
    const unanswered = proc.request('model/list', {}, 1000)
    expect(proc.pending.size).toBe(2)

    proc.handleChildExit(0, null)
    expect(proc.pending.size).toBe(2) // exit 不拒:final response 可能还在 stdout 缓冲
    expect(proc.isAlive()).toBe(true) // 公开 exit 事件前所有权仍在
    expect(events.filter(([name]) => name === 'exit')).toHaveLength(0)

    proc.stdoutBuf = JSON.stringify({ id: 1, result: { turn: { id: 'turn-tail' } } }) // 无尾部换行
    proc.handleChildClose(0, null)

    expect(await settlementWithin(answered)).toBe('resolved')
    expect(await settlementWithin(unanswered)).toBe('rejected: codex app-server closed before model/list response (id=2)')
    expect(events.filter(([name]) => name === 'exit')).toEqual([
      ['exit', { code: 0, signal: null, expected: false }],
    ])
    expect(proc.isAlive()).toBe(false)
    expect(proc.pending.size).toBe(0)
  })

  test('stdin error 事件不连坐 pending 表(EPIPE 只由 per-write 回调拒自己的请求)', async () => {
    const { proc, events } = lifecycleEventHarness()
    const untouched = proc.request('turn/start', {}, 1000)
    expect(proc.pending.size).toBe(1)

    proc.handleStdinError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))

    expect(proc.pending.size).toBe(1) // 不连坐:已注册请求保留(等响应/close/超时)
    expect(await settlementWithin(untouched, 30)).toBe('hung')
    expect(events.map(([name]) => name)).toEqual(['error'])
  })

  test('spawn 失败(无 pid)终态化:alive=false + 拒未答 + exit(null,null) 单次', async () => {
    const { proc, events } = lifecycleEventHarness()
    proc.proc.pid = undefined
    const doomed = proc.request('initialize', {}, 1000)

    proc.handleChildProcessError(new Error('spawn codex ENOENT'))

    expect(proc.alive).toBe(false)
    expect(proc.isAlive()).toBe(false)
    expect(await settlementWithin(doomed)).toBe(
      'rejected: codex app-server process failed before initialize response (id=1): spawn codex ENOENT',
    )
    expect(events.filter(([name]) => name === 'exit')).toEqual([
      ['exit', { code: null, signal: null, expected: false }],
    ])
  })

  test('OS exit 已见但 stdio 未 close 时,kill 等待 close、超时如实抛出', async () => {
    const { proc } = lifecycleEventHarness()
    proc.alive = false // handleChildExit 已跑,close 未到
    await expect(proc.kill(5)).rejects.toThrow('exited but stdio did not close within 5ms')
  })
})

describe('codex rollout 增量读取(StringDecoder+remainder)', () => {
  test('只读追加字节,半行 JSON 保留 remainder 到下次拼接', () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-rollout-'))
    const file = join(root, 'rollout.jsonl')
    try {
      const proc = Object.create(CodexProcess.prototype) as any
      const seen: any[] = []
      proc.sessionId = 'thread-1'
      proc.rolloutFilePath = file
      proc.rolloutReadOffset = 0
      proc.rolloutLineRemainder = ''
      proc.rolloutDecoder = new StringDecoder('utf8')
      proc.emitRolloutImageGeneration = (payload: any) => { seen.push(payload) }

      // 多字节 UTF-8(中文 prompt)故意让切点落在字符中间:分段读不裂字。
      const line = JSON.stringify({ payload: { type: 'image_generation_end', call_id: 'img-1', revisedPrompt: '生成一只柴犬' } })
      const bytes = Buffer.from(line, 'utf8')
      const split = bytes.indexOf(Buffer.from('柴', 'utf8')[0]) + 1 // 柴 的首字节后切开
      writeFileSync(file, bytes.subarray(0, split))
      proc.flushRolloutImageGenerations()
      expect(seen).toHaveLength(0)
      expect(proc.rolloutReadOffset).toBe(split)

      appendFileSync(file, Buffer.concat([bytes.subarray(split), Buffer.from('\n')]))
      proc.flushRolloutImageGenerations()
      expect(seen).toEqual([{ type: 'image_generation_end', call_id: 'img-1', revisedPrompt: '生成一只柴犬' }])
      expect(proc.rolloutReadOffset).toBe(bytes.length + 1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('codex subagent completed step 带工具名(mapCompletedItem 并入 started 映射)', () => {
  test('completed 阶段 subagent_step 的 tool 不再是 undefined', () => {
    const { proc, events } = notificationHarness()
    proc.handleNotification('item/completed', {
      threadId: 'sub-tool',
      item: { type: 'commandExecution', id: 'cmd-9', command: 'bun test', cwd: '/tmp', aggregatedOutput: '3 passed\n', exitCode: 0 },
    })
    expect(events).toHaveLength(1)
    expect(events[0][1]).toMatchObject({
      thread_id: 'sub-tool', item_id: 'cmd-9', tool: 'Bash', phase: 'completed', brief: '→ 3 passed',
    })
  })
})

describe('codex onStdout 解析与分发分离(cf41941 事故防放大器)', () => {
  test('坏 JSON 行与 listener 异常各只丢自己,不连坐后续消息分发', () => {
    const proc = Object.create(CodexProcess.prototype) as any
    proc.stdoutBuf = ''
    const seen: any[] = []
    let first = true
    proc.handleMessage = (msg: any) => {
      if (first) {
        first = false
        throw new TypeError('cards.applySubagentStep is not a function')
      }
      seen.push(msg)
    }
    expect(() => proc.onStdout(Buffer.from('not-json\n{"method":"a"}\n{"method":"b"}\n'))).not.toThrow()
    // 坏 JSON 跳过;{"method":"a"} 的 handler 异常只丢自己;{"method":"b"} 照常分发。
    expect(seen).toEqual([{ method: 'b' }])
  })
})

describe('codex token usage helpers', () => {
  test('parses app-server token usage payloads for last and total snapshots', () => {
    expect(usageFromTokenUsagePayload({
      totalTokens: 1200,
      inputTokens: 900,
      outputTokens: 300,
      reasoningOutputTokens: 220,
      cachedInputTokens: 400,
    })).toEqual({
      total_tokens: 1200,
      input_tokens: 900,
      output_tokens: 300,
      reasoning_output_tokens: 220,
      cache_creation_input_tokens: undefined,
      cache_read_input_tokens: 400,
    })
  })

  test('computes turn aggregate from absolute thread totals', () => {
    const usage = diffUsageTotals(
      {
        total_tokens: 10_000,
        input_tokens: 7_000,
        output_tokens: 3_000,
        reasoning_output_tokens: 1_200,
        cache_read_input_tokens: 2_800,
      },
      {
        total_tokens: 4_000,
        input_tokens: 3_100,
        output_tokens: 900,
        reasoning_output_tokens: 500,
        cache_read_input_tokens: 1_200,
      },
    )

    expect(usage).toEqual({
      total_tokens: 6000,
      input_tokens: 3900,
      output_tokens: 2100,
      reasoning_output_tokens: 700,
      cache_creation_input_tokens: undefined,
      cache_read_input_tokens: 1600,
    })
    expect(effectiveTurnTokens(usage)).toBe(6000)
    expect(effectiveTurnTokens({ total_tokens: 1234 })).toBe(1234)
    expect(effectiveTurnTokens(null)).toBeNull()
  })

  test('clamps negative deltas and treats missing totals as unknown', () => {
    expect(diffUsageTotals(
      { input_tokens: 100, output_tokens: 20 },
      { input_tokens: 120, output_tokens: 10 },
    )).toEqual({
      total_tokens: undefined,
      input_tokens: 0,
      output_tokens: 10,
      reasoning_output_tokens: undefined,
      cache_creation_input_tokens: undefined,
      cache_read_input_tokens: undefined,
    })
    expect(diffUsageTotals(null, null)).toBeNull()
  })
})

describe('buildCodexAppServerArgs', () => {
  test('no overrides → bare app-server on stdio', () => {
    expect(buildCodexAppServerArgs([])).toEqual(['app-server', '--listen', 'stdio://'])
  })
  test('inserts -c overrides before --listen', () => {
    const args = buildCodexAppServerArgs(['-c', 'model_provider="lodestar_kimi"'])
    expect(args).toEqual([
      'app-server',
      '-c', 'model_provider="lodestar_kimi"',
      '--listen', 'stdio://',
    ])
  })
})

describe('buildSpawnPath', () => {
  test('Codex child environment locks GSD runtime after provider overrides', () => {
    const env = buildCodexSpawnEnv({
      GSD_RUNTIME: 'claude',
      LODESTAR_TEST_PROVIDER_KEY: 'set',
    })
    expect(env.GSD_RUNTIME).toBe('codex')
    expect(env.LODESTAR_TEST_PROVIDER_KEY).toBe('set')
  })

  test('user-level bins stay ahead of inherited PATH (deterministic codex/tool resolution)', () => {
    // codex 常是 `#!/usr/bin/env node` 的 npm shim,node 可能只存在于继承 PATH 的某个目录
    // (如 Apple Silicon 的 /opt/homebrew/bin)。替换式 PATH 会丢掉它 → shim 退出 127。
    const path = buildSpawnPath('/opt/homebrew/bin:/usr/local/bin')
    expect(path).toContain('/opt/homebrew/bin')
    // 用户级 bin 仍排在继承 PATH 前,保持工具解析的确定性优先级
    expect(path.indexOf(join(homedir(), '.local', 'bin')))
      .toBeLessThan(path.indexOf('/opt/homebrew/bin'))
  })

  test('inherited node dirs win over the stale /usr/local/bin fallback (codex ESM needs modern node)', () => {
    // 回归:/usr/local/bin 可能有陈旧 node(实测某机 v10.20.1)。codex 启动器是
    // `#!/usr/bin/env node` 的 ESM,必须让继承 PATH 里的 homebrew/nvm 新 node 先命中,
    // 否则老 node 解析 ESM 失败 → codex 退出 code=1。
    const seg = buildSpawnPath('/opt/homebrew/bin').split(delimiter)
    expect(seg.indexOf('/opt/homebrew/bin')).toBeLessThan(seg.lastIndexOf('/usr/local/bin'))
    // 但系统兜底仍保留:整机唯一 node 只在 /usr/local/bin 时不至于退出 127
    expect(seg).toContain('/usr/local/bin')
  })

  test('empty inherited PATH does not leave a stray/trailing delimiter', () => {
    const path = buildSpawnPath('')
    expect(path).not.toContain(delimiter + delimiter)
    expect(path.endsWith(delimiter)).toBe(false)
  })
})

describe('codexLoginStatusAuthenticated', () => {
  test('ChatGPT OAuth login counts as authenticated', () => {
    expect(codexLoginStatusAuthenticated('Logged in using ChatGPT')).toBe(true)
  })
  test('API key login counts as authenticated (无痕 wuhen 一类第三方 key)', () => {
    expect(codexLoginStatusAuthenticated('Logged in using an API key - sk-69c70***37641')).toBe(true)
  })
  test('not-logged-in output is unauthenticated', () => {
    expect(codexLoginStatusAuthenticated('Not logged in')).toBe(false)
    expect(codexLoginStatusAuthenticated('')).toBe(false)
  })
})

describe('codex app-server error notifications', () => {
  test('nested error.message is surfaced on the Error (capacity / serverOverloaded)', () => {
    const { proc, events } = notificationHarness()
    // Match primary thread so isForeignThread does not drop the notification.
    proc.sessionId = 'thread-capacity'
    proc.handleNotification('error', {
      error: {
        message: 'Selected model is at capacity. Please try a different model.',
        codexErrorInfo: 'serverOverloaded',
        additionalDetails: null,
      },
      willRetry: false,
      threadId: 'thread-capacity',
      turnId: 'turn-capacity',
    })
    const errorEvents = events.filter(([name]) => name === 'error')
    expect(errorEvents).toHaveLength(1)
    const err = errorEvents[0]?.[1]
    expect(err).toBeInstanceOf(Error)
    expect(String((err as Error).message)).toContain('Selected model is at capacity')
  })

  test('top-level message still works when nested error is absent', () => {
    const { proc, events } = notificationHarness()
    proc.handleNotification('error', {
      message: 'plain top-level failure',
    })
    const errorEvents = events.filter(([name]) => name === 'error')
    expect(errorEvents).toHaveLength(1)
    expect(String((errorEvents[0]?.[1] as Error).message)).toBe('plain top-level failure')
  })
})

describe('codex request_user_input 三小件(D3)', () => {
  test('threadParams 下发 default_mode_request_user_input feature flag', () => {
    const proc = Object.create(CodexProcess.prototype) as any
    proc.opts = { workDir: '/tmp', effort: 'high' }
    const params = proc.threadParams()
    expect(params.config).toEqual({ 'features.default_mode_request_user_input': true })
  })

  test('respondError 带 code:-32601(缺 code 会让 app-server 反序列化失败悬挂)', () => {
    const proc = Object.create(CodexProcess.prototype) as any
    const writes: any[] = []
    proc.serverRequests = new Map()
    proc.write = (msg: any) => writes.push(msg)
    proc.respondError('req-1', 'denied by user')
    expect(writes).toHaveLength(1)
    expect(writes[0].error).toEqual({ code: -32601, message: 'denied by user' })
  })
})

describe('codex assistant emit 契约带 parentToolUseId(上游 7c14677-B)', () => {
  // codex 主线程 assistant 事件按统一契约补 parentToolUseId: null —— 外线程
  // (子 agent)通知在 handleNotification 入口即被 isForeignThread 拦截,
  // 到达 emit 点的只有主线程,恒为 null。
  test('agentMessage delta 与终态 emit 均携带 parentToolUseId: null', () => {
    const { proc, events } = notificationHarness()

    proc.handleNotification('item/agentMessage/delta', {
      threadId: 'thread-structured',
      itemId: 'msg-1',
      delta: '主线程正文',
    })
    proc.handleNotification('item/completed', {
      threadId: 'thread-structured',
      item: { id: 'msg-1', type: 'agentMessage' },
    })

    const text = events.find(([name]) => name === 'assistant_text')
    const stop = events.find(([name]) => name === 'assistant_block_stop')
    expect(text?.[1]).toEqual({ uuid: 'msg-1', text: '主线程正文', parentToolUseId: null })
    expect(stop?.[1]).toEqual({ index: 'msg-1', parentToolUseId: null })
  })
})
