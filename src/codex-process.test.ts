import { describe, expect, spyOn, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { Writable } from 'node:stream'

import {
  diffUsageTotals,
  effectiveTurnTokens,
  contextCompactionNoticeFromMessage,
  contextCompactionNoticeFromNotification,
  CodexProcess,
  CodexRpcResponseError,
  codexAppServerArgs,
  codexApiProviderArgs,
  codexAppServerSpawnOptions,
  imageGenerationOutput,
  usageFromTokenUsagePayload,
} from './codex-process'
import { resetAgentSessionRegistryForTest } from './agent-session-registry'
// fork-only helpers under test:
import { buildCodexAppServerArgs, buildCodexSpawnEnv, buildSpawnPath, codexLoginStatusAuthenticated } from './codex-process'
import { validateConversationLaunch } from './conversation'

function makeCodexLifecycleHarness(stdinOverrides: Record<string, unknown> = {}): any {
  const proc = Object.create(CodexProcess.prototype) as any
  proc.alive = true
  proc.expectedExit = false
  proc.exitEventEmitted = false
  proc.stdoutBuf = ''
  proc.stderrBuf = ''
  proc.childExitCode = null
  proc.childExitSignal = null
  proc.requestCounter = 0
  proc.pending = new Map()
  proc.serverRequests = new Map()
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

test('custom Codex providers use environment auth without a subscription login override', () => {
  const args = codexApiProviderArgs({ id: 'packy', name: 'Packy "API"', baseUrl: 'https://cf.api.fan/v1', envKey: 'PACKY_KEY' })
  expect(args).toContain('model_provider="packy"')
  const definition = args.find(arg => arg.startsWith('model_providers.packy='))!
  expect(definition).toContain(`name=${JSON.stringify('Packy "API"')}`)
  expect(definition).toContain('requires_openai_auth=false')
  expect(definition).toContain('env_key="PACKY_KEY"')
  expect(args.join(' ')).not.toContain('forced_login_method')
  expect(() => codexApiProviderArgs({ id: 'openai', name: 'bad', baseUrl: 'https://host', envKey: 'KEY' })).toThrow('保留')
})

test('custom provider is explicit on fresh, resumed and forked Codex threads', async () => {
  const apiProvider = { id: 'packy', name: 'PackyAPI', baseUrl: 'https://cf.api.fan/v1', envKey: 'PACKY_KEY' }
  for (const kind of ['fresh', 'resume', 'fork'] as const) {
    const launch = kind === 'fresh' ? { kind } : { kind, source: { provider: 'codex', sessionId: 'source-thread', cwd: '/repo' } }
    const { proc, calls } = makeCodexProtocolHarness({ model: 'kimi-k3', effort: 'high', apiProvider, launch })
    await proc.initializeAndStartThread()
    const call = calls.find(call => call.method === `thread/${kind === 'fresh' ? 'start' : kind}`)!
    expect(call.params.modelProvider).toBe('packy')
    expect(call.params.model).toBe('kimi-k3')
    expect(call.params.config.model_reasoning_effort).toBe('high')
  }
})

test('returning to a Codex subscription overrides a previous API provider on resume', async () => {
  const { proc, calls } = makeCodexProtocolHarness({ tokenSourceId: 'codex-sub', model: 'gpt-test', effort: 'high',
    launch: { kind: 'resume', source: { provider: 'codex', sessionId: 'source-thread', cwd: '/repo' } } })
  await proc.initializeAndStartThread()
  expect(calls.find(call => call.method === 'thread/resume')!.params.modelProvider).toBe('openai')
})

type ProtocolCall = { method: string; params: any }

test('steering targets the active Codex turn without starting or interrupting it', async () => {
  const { proc, calls, events } = makeCodexProtocolHarness({}, (method, params) => {
    expect(method).toBe('turn/steer')
    return { turnId: params.expectedTurnId }
  })
  proc.sessionId = 'thread'
  proc.currentTurnId = 'active-turn'
  await expect(proc.steerUserText('focus on tests', ['/tmp/input.txt'], 'input-1')).resolves.toBe(true)
  expect(calls).toEqual([{ method: 'turn/steer', params: {
    threadId: 'thread', expectedTurnId: 'active-turn', clientUserMessageId: 'input-1',
    input: [{ type: 'text', text: '[file: /tmp/input.txt]\n\nfocus on tests', text_elements: [] }],
  } }])
  expect(events).toEqual([])
  expect(proc.currentTurnId).toBe('active-turn')
  const notification = { threadId: 'thread', turnId: 'active-turn', item: { type: 'userMessage', id: 'native-item', clientId: 'input-1', content: [] } }
  proc.handleNotification('item/started', { ...notification, threadId: 'child-thread' })
  proc.handleNotification('item/started', { ...notification, turnId: 'old-turn' })
  proc.handleNotification('item/started', { ...notification, item: { ...notification.item, clientId: 'unknown-input' } })
  expect(events.filter(([name]) => name === 'user_input_consumed')).toEqual([])
  proc.handleNotification('item/started', notification)
  proc.handleNotification('item/started', notification)
  proc.handleNotification('item/completed', notification)
  expect(events.filter(([name]) => name === 'user_input_consumed')).toEqual([['user_input_consumed', { inputId: 'input-1' }]])
  expect(events.filter(([name]) => name === 'input_batch_end')).toEqual([])
  proc.handleNotification('item/started', { threadId: 'child-thread', turnId: 'child-turn', item: { type: 'reasoning', id: 'child-reasoning' } })
  expect(events.filter(([name]) => name === 'input_batch_end')).toEqual([])
  proc.handleNotification('item/started', { threadId: 'thread', turnId: 'active-turn', item: { type: 'reasoning', id: 'main-reasoning' } })
  proc.handleNotification('item/started', { threadId: 'thread', turnId: 'active-turn', item: { type: 'reasoning', id: 'main-reasoning-2' } })
  expect(events.filter(([name]) => name === 'input_batch_end')).toEqual([['input_batch_end', { itemId: 'main-reasoning' }]])
})

test('Codex consumption can precede its RPC receipt and remains in native event order', async () => {
  let proc: any
  const h = makeCodexProtocolHarness({}, async (_method, params) => {
    proc.handleNotification('item/started', { threadId: 'thread', turnId: 'turn',
      item: { type: 'userMessage', id: 'native-item', clientId: params.clientUserMessageId, content: [] } })
    expect(h.events.map(([name]) => name)).toEqual(['user_input_consumed'])
    return { turnId: 'turn' }
  })
  proc = h.proc
  proc.sessionId = 'thread'; proc.currentTurnId = 'turn'
  await proc.steerUserText('guidance', [], 'before-ack')
  expect(h.events).toEqual([['user_input_consumed', { inputId: 'before-ack' }]])
})

test('idle steering submits nothing; rejection and unknown receipts never start another turn', async () => {
  for (const outcome of ['rejected', 'malformed', 'late-success']) {
    const { proc, calls, events } = makeCodexProtocolHarness({}, () => {
      proc.currentTurnId = null
      if (outcome === 'rejected') throw new Error('no active turn')
      return outcome === 'malformed' ? {} : { turnId: 'active-turn' }
    })
    expect(await proc.steerUserText('idle')).toBe(false)
    expect(calls).toEqual([])
    proc.sessionId = 'thread'
    proc.currentTurnId = 'active-turn'
    if (outcome === 'late-success') await expect(proc.steerUserText('more')).resolves.toBe(true)
    else await expect(proc.steerUserText('more')).rejects.toThrow(outcome === 'rejected' ? 'no active turn' : '未确认')
    expect(calls.map(call => call.method)).toEqual(['turn/steer'])
    expect(events).toEqual([])
    expect(proc.currentTurnId).toBeNull()
  }
})

test('model discovery rejects repeated or malformed pagination instead of looping or returning a partial catalog', async () => {
  for (const nextCursor of ['repeated-page', 42, undefined]) {
    let pages = 0
    const { proc } = makeCodexProtocolHarness({}, async method => {
      if (method === 'initialize') return {}
      if (method === 'model/list') {
        if (++pages > 2) throw new Error('test guard: pagination failed to terminate')
        return { data: [], nextCursor }
      }
      throw new Error(`unexpected request ${method}`)
    })
    await expect(proc.listModels()).rejects.toThrow(
      typeof nextCursor === 'string' ? 'model/list returned a repeated nextCursor' : 'model/list returned an invalid nextCursor',
    )
    expect(pages).toBe(typeof nextCursor === 'string' ? 2 : 1)
  }
})

function makeCodexProtocolHarness(
  opts: Record<string, unknown> = {},
  respond?: (method: string, params: any) => any | Promise<any>,
): { proc: any; calls: ProtocolCall[]; writes: any[]; events: Array<[string, any]> } {
  const proc = Object.create(CodexProcess.prototype) as any
  const calls: ProtocolCall[] = []
  const writes: any[] = []
  const events: Array<[string, any]> = []
  proc.alive = true
  proc.turnRetryEnabled = true
  proc.opts = { workDir: '/repo', ...opts }
  proc.readyPromise = null
  proc.initializePromise = null
  proc.conversationResumable = false
  proc.conversationRolloutPath = null
  proc.currentTurnId = null
  proc.sessionId = null
  proc.lastCompletedTurnId = null
  proc.lastUsage = null
  proc.lastResult = {
    cost_usd: null,
    cost_delta_usd: null,
    duration_ms: null,
    num_turns: null,
    usage: null,
    subtype: null,
    is_error: false,
  }
  proc.write = (message: any) => {
    writes.push(message)
    // merged write() contract: return null on success, an Error on failure.
    return null
  }
  proc.request = async (method: string, params: any) => {
    calls.push({ method, params })
    let result: any
    if (respond) result = await respond(method, params)
    else if (method === 'initialize') result = {}
    else if (method === 'thread/start') result = { thread: { id: 'fresh-thread', cwd: '/repo' } }
    else if (method === 'thread/resume') result = { thread: { id: params.threadId, cwd: '/repo' } }
    else if (method === 'thread/fork') result = { thread: { id: 'forked-thread', cwd: '/repo' } }
    else if (method === 'model/list' || method === 'thread/list') result = { data: [], nextCursor: null }
    else throw new Error(`unexpected request ${method}`)
    if (
      method.startsWith('thread/')
      && typeof result?.thread?.id === 'string'
      && !Object.prototype.hasOwnProperty.call(result.thread, 'path')
    ) {
      result = {
        ...result,
        thread: {
          ...result.thread,
          path: `/rollouts/rollout-${result.thread.id}.jsonl`,
        },
      }
    }
    return result
  }
  proc.primeRolloutImageGenerationScan = () => {}
  proc.flushRolloutImageGenerations = () => {}
  proc.assertConversationRolloutMaterialized = () => {}
  proc.verifyConversationMaterialized = async () => {}
  proc.emit = (event: string, payload: any) => {
    events.push([event, payload])
    return true
  }
  return { proc, calls, writes, events }
}

const CAPACITY_MESSAGE = 'Selected model is at capacity. Please try a different model'
const STREAM_MESSAGE = 'stream disconnected before completion: An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 00000000-0000-4000-8000-000000000001 in your message.'
const COMPACT_MESSAGE = 'Error running remote compact task: Connection failed: error sending request'
const COMPACT_ERROR = { message: COMPACT_MESSAGE, codexErrorInfo: { httpConnectionFailed: { httpStatusCode: null } } }
const REQUEST_TIMEOUT_MESSAGE = 'request timed out'
const REQUEST_TIMEOUT_ERROR = { message: 'unexpected status 408 Request Timeout: {"detail":"Request body read timed out"}', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 408 } } }
const OVERLOADED_ERROR = { message: 'Service temporarily overloaded', codexErrorInfo: 'serverOverloaded' }
const TRANSPORT_ERROR_KINDS = ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts']

async function withCapacityClock(run: (clock: {
  timers: Map<number, { callback: () => void; delay: number }>
  tick(): Promise<void>
}) => Promise<void>): Promise<void> {
  let nextId = 100_000
  const timers = new Map<number, { callback: () => void; delay: number }>()
  const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number) => {
    const id = nextId++
    timers.set(id, { callback, delay })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout)
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(((id: number) => { timers.delete(id) }) as typeof clearTimeout)
  try {
    await run({
      timers,
      async tick() {
        const next = timers.entries().next().value
        if (!next) throw new Error('no scheduled capacity retry')
        timers.delete(next[0])
        next[1].callback()
        await flushCapacityMicrotasks()
      },
    })
  } finally {
    timeout.mockRestore()
    clear.mockRestore()
  }
}

async function flushCapacityMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

function capacityHarness(respond?: (method: string, params: any) => any | Promise<any>) {
  let turn = 0
  const harness = makeCodexProtocolHarness({ model: 'selected-model', effort: 'high' }, respond ?? (method => {
    if (method === 'turn/start') return { turn: { id: `capacity-turn-${++turn}` } }
    if (method === 'turn/interrupt') return {}
    throw new Error(`unexpected request ${method}`)
  }))
  harness.proc.sessionId = 'capacity-thread'
  harness.proc.readyPromise = Promise.resolve()
  harness.proc.conversationResumable = true
  // 本地 fork 语义:turn_started 只从持久化的 turn/started 通知发出
  //(上游 recordTurnStarted 把响应与通知折叠成一次,合并实现保留 fork 的通知路径)。
  // 真实 app-server 必然回放该通知;harness 在 turn/start 响应处同步补放,
  // 让 RPC 响应与主动通知的时序与线上一致。
  const innerRequest = harness.proc.request
  harness.proc.request = async (method: string, params: any) => {
    const result = await innerRequest(method, params)
    if (method === 'turn/start') {
      const turnId = typeof result?.turn?.id === 'string' && result.turn.id
        ? result.turn.id
        : typeof result?.turnId === 'string' && result.turnId ? result.turnId : null
      if (turnId) {
        harness.proc.handleNotification('turn/started', {
          threadId: 'capacity-thread',
          turn: { id: turnId },
        })
      }
    }
    return result
  }
  return harness
}

function completeCapacityTurn(proc: any, error: any = { message: CAPACITY_MESSAGE }): void {
  proc.handleNotification('turn/completed', {
    threadId: 'capacity-thread',
    turn: { id: proc.currentTurnId, status: error ? 'failed' : 'completed', error },
  })
}

describe('native Codex quota terminal classification', () => {
  test('early error never switches; only main-thread terminal failure carries accepted recovery metadata', async () => {
    const { proc, events } = capacityHarness()
    proc.sendUserText('one task'); await flushCapacityMicrotasks()
    const error = { codexErrorInfo: 'usageLimitExceeded', message: "You've hit your usage limit." }
    proc.handleNotification('error', { threadId: 'capacity-thread', turnId: proc.currentTurnId, error, willRetry: false })
    expect(events.filter(([name]) => name === 'result')).toHaveLength(0)
    completeCapacityTurn(proc, error)
    expect(events.find(([name]) => name === 'result')?.[1]).toMatchObject({ is_error: true, codexQuotaFailure: { accepted: true } })
  })
  test('explicit turn/start rejection preserves unaccepted input including file hints', async () => {
    const { proc, events } = capacityHarness(async () => {
      throw new CodexRpcResponseError('turn/start', 1, -32000, 'usage denied', { codexErrorInfo: 'usageLimitExceeded' })
    })
    proc.sendUserText('one task', ['/input']); await flushCapacityMicrotasks()
    expect(events.find(([name]) => name === 'result')?.[1]).toMatchObject({
      codexQuotaFailure: { accepted: false, rejectedInput: '[file: /input]\n\none task' },
    })
  })
  test('transport timeout and rate-limited control APIs cannot authorize replay', async () => {
    const { proc, events } = capacityHarness(async () => { throw new Error('turn/start timed out HTTP 429') })
    proc.sendUserText('one task'); await flushCapacityMicrotasks()
    const result = events.find(([name]) => name === 'result')?.[1]
    expect(result.is_error).toBe(true); expect(result.codexQuotaFailure).toBeUndefined()
  })
})

describe('codex model capacity recovery', () => {
  test('waits for terminal failure, keeps one logical task open and continues its existing history', async () => {
    await withCapacityClock(async clock => {
      const { proc, calls, events } = capacityHarness()
      proc.sendUserText('original task', ['/tmp/input.png'])
      await flushCapacityMicrotasks()
      for (const willRetry of [true, false]) {
        proc.handleNotification('error', {
          threadId: 'capacity-thread', turnId: proc.currentTurnId,
          error: { message: CAPACITY_MESSAGE }, willRetry,
        })
      }
      expect(clock.timers.size).toBe(0)
      expect(events.filter(([event]) => event === 'error').map(([, error]) => error.message))
        .toEqual([CAPACITY_MESSAGE, CAPACITY_MESSAGE])

      // The completion may omit the error already supplied by the notification.
      const failedId = proc.currentTurnId
      proc.handleNotification('turn/completed', {
        threadId: 'capacity-thread', turn: { id: failedId, status: 'failed' },
      })
      proc.handleNotification('turn/completed', {
        threadId: 'capacity-thread', turn: { id: failedId, status: 'failed', error: { message: CAPACITY_MESSAGE } },
      })
      expect(events.filter(([event]) => event === 'result')).toEqual([])
      expect(proc.lastCompletedTurnId).toBeNull()
      expect([...clock.timers.values()].map(timer => timer.delay)).toEqual([5_000])
      expect(proc.turnRetry).toMatchObject({ phase: 'waiting', attempt: 1, message: CAPACITY_MESSAGE })
      await clock.tick()

      const starts = calls.filter(call => call.method === 'turn/start')
      expect(starts).toHaveLength(2)
      expect(starts[0]!.params.input[0].text).toBe('[file: /tmp/input.png]\n\noriginal task')
      expect(starts[1]!.params.input[0].text).toContain('继续完成用户尚未完成的任务')
      expect(starts[1]!.params.input[0].text).not.toContain('original task')
      expect(starts[1]!.params).toEqual({ ...starts[0]!.params, input: starts[1]!.params.input })
      expect(proc.opts).toMatchObject({ model: 'selected-model', effort: 'high' })
      expect(events.filter(([event]) => event === 'turn_started').at(-1)?.[1].retry).toBe(true)
      completeCapacityTurn(proc, null)
      expect(events.filter(([event]) => event === 'result')).toEqual([
        ['result', expect.objectContaining({ is_error: false, turn_id: 'capacity-turn-2' })],
      ])
      expect(proc.turnRetry).toBeNull()
      expect(clock.timers.size).toBe(0)
    })
  })

  test('keeps retrying with capped backoff and resets after a successful task', async () => {
    await withCapacityClock(async clock => {
      const { proc, events } = capacityHarness()
      proc.sendUserText('do work')
      await flushCapacityMicrotasks()
      for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]) {
        completeCapacityTurn(proc)
        expect([...clock.timers.values()].map(timer => timer.delay)).toEqual([delay])
        expect(events.filter(([event]) => event === 'result')).toEqual([])
        await clock.tick()
      }
      completeCapacityTurn(proc, null)
      proc.sendUserText('next task')
      await flushCapacityMicrotasks()
      completeCapacityTurn(proc)
      expect(proc.turnRetry).toMatchObject({ attempt: 1, delayMs: 5_000 })
    })
  })

  test('retries an explicitly rejected turn/start with its original input and files', async () => {
    await withCapacityClock(async clock => {
      let starts = 0
      const { proc, calls, events } = capacityHarness(method => {
        if (method !== 'turn/start') throw new Error(`unexpected request ${method}`)
        if (++starts === 1) throw new CodexRpcResponseError(method, 1, -32000, CAPACITY_MESSAGE)
        return { turn: { id: 'accepted-retry' } }
      })
      proc.sendUserText('unaccepted task', ['/tmp/data.csv'])
      await flushCapacityMicrotasks()
      expect(events.filter(([event]) => event === 'result')).toEqual([])
      await clock.tick()
      expect(calls[1]).toEqual(calls[0])
      // No earlier accepted turn: this boundary must seed the usage baseline.
      expect(events.find(([event]) => event === 'turn_started')?.[1].retry).toBeUndefined()
      completeCapacityTurn(proc, null)
    })
  })

  test('unrelated failures and initialization errors remain terminal', async () => {
    await withCapacityClock(async clock => {
      for (const error of [
        new CodexRpcResponseError('turn/start', 1, -32000, 'Usage limit exceeded'),
        new CodexRpcResponseError('thread/start', 1, -32000, CAPACITY_MESSAGE),
        new Error('turn/start request timed out'),
      ]) {
        const { proc, events } = capacityHarness(() => { throw error })
        proc.sendUserText('do work')
        await flushCapacityMicrotasks()
        expect(events.filter(([event]) => event === 'result')).toHaveLength(1)
        expect(proc.lastResult.is_error).toBe(true)
        expect(clock.timers.size).toBe(0)
      }
      for (const message of ['Context window capacity exceeded', 'Unauthorized', 'Usage limit exceeded']) {
        const { proc, events } = capacityHarness()
        proc.sendUserText('do work')
        await flushCapacityMicrotasks()
        completeCapacityTurn(proc, { message })
        expect(events.filter(([event]) => event === 'result')).toHaveLength(1)
        expect(clock.timers.size).toBe(0)
      }
    })
  })

  test.each([CAPACITY_MESSAGE, STREAM_MESSAGE, COMPACT_MESSAGE, REQUEST_TIMEOUT_MESSAGE])('interrupt during backoff cancels even an already-queued timer callback (%s)', async message => {
    await withCapacityClock(async clock => {
      const { proc, calls, events } = capacityHarness()
      proc.sendUserText('do work')
      await flushCapacityMicrotasks()
      completeCapacityTurn(proc, { message })
      const staleTimer = [...clock.timers.values()][0]!
      proc.sendInterrupt()
      expect(clock.timers.size).toBe(0)
      staleTimer.callback()
      await flushCapacityMicrotasks()
      expect(calls.filter(call => call.method === 'turn/start')).toHaveLength(1)
      expect(events.filter(([event]) => event === 'result')).toEqual([
        ['result', expect.objectContaining({ subtype: 'interrupted', checkpoint: null })],
      ])
    })
  })

  test.each([CAPACITY_MESSAGE, STREAM_MESSAGE, COMPACT_MESSAGE, REQUEST_TIMEOUT_MESSAGE])('interrupt also cancels a retry awaiting its turn/start acknowledgement (%s)', async message => {
    await withCapacityClock(async clock => {
      let resolveRetry!: (value: any) => void
      let starts = 0
      const { proc, calls, events } = capacityHarness(method => {
        if (method === 'turn/interrupt') return {}
        if (++starts === 1) return { turn: { id: 'first-turn' } }
        return new Promise(resolve => { resolveRetry = resolve })
      })
      proc.sendUserText('do work')
      await flushCapacityMicrotasks()
      completeCapacityTurn(proc, { message })
      await clock.tick()
      proc.sendInterrupt()
      proc.sendInterrupt()
      resolveRetry({ turn: { id: 'cancelled-retry' } })
      await flushCapacityMicrotasks()
      expect(proc.currentTurnId).toBeNull()
      expect(calls.at(-1)).toEqual({
        method: 'turn/interrupt', params: { threadId: 'capacity-thread', turnId: 'cancelled-retry' },
      })
      proc.handleNotification('turn/completed', {
        threadId: 'capacity-thread',
        turn: { id: 'cancelled-retry', status: 'failed', error: { message } },
      })
      expect(events.filter(([event]) => event === 'result')).toHaveLength(1)
      expect(clock.timers.size).toBe(0)
    })
  })

  test.each([CAPACITY_MESSAGE, STREAM_MESSAGE, COMPACT_MESSAGE, REQUEST_TIMEOUT_MESSAGE])('a synchronous stop at the retry progress event prevents the request from being sent (%s)', async message => {
    await withCapacityClock(async clock => {
      const { proc, calls, events } = capacityHarness()
      const emit = proc.emit
      proc.emit = (event: string, payload: any) => {
        emit(event, payload)
        if (event === 'turn_retry' && payload.phase === 'retrying') proc.sendInterrupt()
        return true
      }
      proc.sendUserText('do work')
      await flushCapacityMicrotasks()
      completeCapacityTurn(proc, { message })
      await clock.tick()
      expect(calls.filter(call => call.method === 'turn/start')).toHaveLength(1)
      expect(events.filter(([event]) => event === 'result')).toHaveLength(1)
    })
  })

  test.each([CAPACITY_MESSAGE, STREAM_MESSAGE, COMPACT_MESSAGE, REQUEST_TIMEOUT_MESSAGE])('new input, native continuation, kill and OS exit all retire the waiting timer (%s)', async message => {
    await withCapacityClock(async clock => {
      for (const action of ['input', 'native', 'kill', 'exit']) {
        const { proc, calls, events } = capacityHarness()
        proc.sendUserText('do work')
        await flushCapacityMicrotasks()
        completeCapacityTurn(proc, { message })
        const staleTimer = [...clock.timers.values()][0]!
        if (action === 'input') proc.sendUserText('new instruction')
        if (action === 'native') proc.handleNotification('turn/started', {
          threadId: 'capacity-thread', turn: { id: 'native-continuation' },
        })
        if (action === 'kill') {
          proc.sendSignal = () => {}
          proc.waitForExit = async () => true
          await proc.kill()
        }
        if (action === 'exit') proc.handleChildExit(1, null)
        expect(clock.timers.size).toBe(0)
        staleTimer.callback()
        await flushCapacityMicrotasks()
        expect(calls.filter(call => call.method === 'turn/start')).toHaveLength(action === 'input' ? 2 : 1)
        if (action === 'native') {
          expect(proc.currentTurnId).toBe('native-continuation')
          expect(events.filter(([event]) => event === 'turn_retry').at(-1)?.[1].phase).toBe('retrying')
        }
      }
    })
  })

  test.each([CAPACITY_MESSAGE, STREAM_MESSAGE, COMPACT_MESSAGE, REQUEST_TIMEOUT_MESSAGE])('child-thread and stale retryable errors cannot turn an unrelated failure into a retry (%s)', async message => {
    await withCapacityClock(async clock => {
      const { proc, events } = capacityHarness()
      proc.sendUserText('do work')
      await flushCapacityMicrotasks()
      for (const [threadId, turnId] of [['child-thread', proc.currentTurnId], ['capacity-thread', 'old-turn']]) {
        proc.handleNotification('error', { threadId, turnId, error: { message }, willRetry: false })
        proc.handleNotification('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error: { message } } })
      }
      proc.handleNotification('turn/completed', {
        threadId: 'capacity-thread', turn: { id: proc.currentTurnId, status: 'failed' },
      })
      expect(clock.timers.size).toBe(0)
      expect(events.filter(([event]) => event === 'result')).toHaveLength(1)
    })
  })
})

describe('codex transient failure recovery', () => {
  test.each([
    ...[
      { message: STREAM_MESSAGE, codexErrorInfo: 'other' },
      { message: STREAM_MESSAGE },
      { message: 'upstream stream ended', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } },
    ].map(error => ({ error, reason: 'stream_disconnected', continuationMessage: '响应流连接中断' })),
    ...[
      COMPACT_ERROR,
      { message: COMPACT_MESSAGE },
      { message: COMPACT_MESSAGE, codexErrorInfo: 'other' },
      { ...COMPACT_ERROR, message: `${COMPACT_MESSAGE} for url (https://example.com/responses/compact)` },
      { message: `Codex ${COMPACT_MESSAGE}`, codexErrorInfo: 'httpConnectionFailed' },
      { message: 'Error running remote compact task: request timed out', codexErrorInfo: 'other' },
      { message: 'Error running remote compact task: unexpected status 503 Service Unavailable', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } },
      ...[408, 503].map(httpStatusCode => ({ message: COMPACT_MESSAGE, codexErrorInfo: { httpConnectionFailed: { httpStatusCode } } })),
    ].map(error => ({ error, reason: 'compact_connection_failed', continuationMessage: '远程压缩时连接失败' })),
    ...[
      REQUEST_TIMEOUT_ERROR, OVERLOADED_ERROR,
      { message: REQUEST_TIMEOUT_MESSAGE, codexErrorInfo: 'other' },
      { message: 'workspace routing discovery timed out', codexErrorInfo: 'other' },
      { message: 'unexpected status 502 Bad Gateway', codexErrorInfo: 'other' },
      { message: 'Connection failed: error sending request', codexErrorInfo: 'other' },
    ].map(error => ({ error, reason: 'transient_error', continuationMessage: '临时连接或服务错误' })),
    ...TRANSPORT_ERROR_KINDS.flatMap(kind => [undefined, null, 408, 500, 502, 503, 504].map(httpStatusCode => ({
      error: { message: 'Upstream transport failed', codexErrorInfo: { [kind]: httpStatusCode === undefined ? {} : { httpStatusCode } } },
      reason: kind === 'responseStreamDisconnected' ? 'stream_disconnected' : 'transient_error',
      continuationMessage: kind === 'responseStreamDisconnected' ? '响应流连接中断' : '临时连接或服务错误',
    }))),
    // fork WR-03 宽口径(合并保留):满载文案先于 codexErrorInfo 标签判定,
    // 'unauthorized'/429 伴随 "Selected model is at capacity" 时归 capacity 重试
    //(对齐 session.isCodexCapacityError 分类面)。
    ...[
      { message: CAPACITY_MESSAGE, codexErrorInfo: 'unauthorized' },
      { message: CAPACITY_MESSAGE, codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } },
    ].map(error => ({ error, reason: 'capacity', continuationMessage: '上一轮因模型暂时满载而中断' })),
  ])('continues accepted history only after a failed terminal event (%j)', async ({ error, reason, continuationMessage }) => {
    await withCapacityClock(async clock => {
      const { proc, calls, events } = capacityHarness()
      proc.sendUserText('task with completed effects', ['/tmp/input.csv'])
      await flushCapacityMicrotasks()
      const turnId = proc.currentTurnId
      proc.handleNotification('item/completed', {
        threadId: 'capacity-thread', turnId,
        item: { id: 'completed-tool', type: 'commandExecution', command: 'echo done', cwd: '/repo', status: 'completed', aggregatedOutput: 'done', exitCode: 0 },
      })
      for (const willRetry of [true, false]) {
        proc.handleNotification('error', { threadId: 'capacity-thread', turnId, error, willRetry })
        expect(clock.timers.size).toBe(0)
      }
      // The terminal error may be supplied only by the preceding notification.
      proc.handleNotification('turn/completed', { threadId: 'capacity-thread', turn: { id: turnId, status: 'failed' } })
      proc.handleNotification('turn/completed', { threadId: 'capacity-thread', turn: { id: turnId, status: 'failed', error } })
      expect(proc.turnRetry).toMatchObject({ reason, attempt: 1, delayMs: 5000, message: error.message })
      expect(clock.timers.size).toBe(1)
      expect(events.filter(([name]) => name === 'result')).toHaveLength(0)
      expect(events.filter(([name]) => name === 'error')).toHaveLength(2)
      await clock.tick()
      const starts = calls.filter(call => call.method === 'turn/start')
      expect(starts).toHaveLength(2)
      const continuation = starts[1]!.params.input[0].text
      expect(continuation).toContain(continuationMessage)
      expect(continuation).toContain('避免重复已完成的操作')
      expect(continuation).not.toContain('task with completed effects')
      expect(continuation).not.toContain('/tmp/input.csv')
      expect(starts[1]!.params).toEqual({ ...starts[0]!.params, input: starts[1]!.params.input })
      expect(events.filter(([name]) => name === 'turn_started').at(-1)?.[1].retry).toBe(true)
      completeCapacityTurn(proc, null)
      expect(events.filter(([name]) => name === 'result')).toEqual([
        ['result', expect.objectContaining({ is_error: false })],
      ])
      expect(clock.timers.size).toBe(0)
    })
  })

  test.each([{ message: STREAM_MESSAGE, codexErrorInfo: 'other' }, COMPACT_ERROR, REQUEST_TIMEOUT_ERROR, OVERLOADED_ERROR])('limits transient recovery to three attempts and preserves the final error (%j)', async error => {
    await withCapacityClock(async clock => {
      const { proc, events } = capacityHarness()
      proc.sendUserText('do work')
      await flushCapacityMicrotasks()
      for (const delay of [5000, 10000, 20000]) {
        completeCapacityTurn(proc, error)
        expect([...clock.timers.values()].map(timer => timer.delay)).toEqual([delay])
        expect(events.filter(([name]) => name === 'result')).toHaveLength(0)
        await clock.tick()
      }
      completeCapacityTurn(proc, error)
      expect(clock.timers.size).toBe(0)
      expect(proc.turnRetry).toBeNull()
      expect(events.filter(([name]) => name === 'result')).toEqual([
        ['result', expect.objectContaining({ is_error: true, error: error.message })],
      ])
      proc.sendUserText('next task')
      await flushCapacityMicrotasks()
      completeCapacityTurn(proc, error)
      expect(proc.turnRetry).toMatchObject({ attempt: 1, delayMs: 5000 })
    })
  })

  test('stream, compact and service failures share a budget that capacity failures neither consume nor reset', async () => {
    await withCapacityClock(async clock => {
      const { proc, events } = capacityHarness()
      proc.sendUserText('do work')
      await flushCapacityMicrotasks()
      for (const [delay, error] of [[5000, COMPACT_ERROR], [10000, { message: STREAM_MESSAGE }], [20000, REQUEST_TIMEOUT_ERROR]] as const) {
        for (let i = 0; i < 4; i++) {
          completeCapacityTurn(proc)
          await clock.tick()
        }
        completeCapacityTurn(proc, error)
        expect(proc.turnRetry.delayMs).toBe(delay)
        await clock.tick()
      }
      completeCapacityTurn(proc, OVERLOADED_ERROR)
      expect(clock.timers.size).toBe(0)
      expect(events.filter(([name]) => name === 'result')).toHaveLength(1)
    })
  })

  test.each([{ message: STREAM_MESSAGE }, COMPACT_ERROR, REQUEST_TIMEOUT_ERROR, OVERLOADED_ERROR])('successful completion restores the transient budget for the next task (%j)', async error => {
    await withCapacityClock(async clock => {
      const { proc } = capacityHarness()
      for (let task = 0; task < 2; task++) {
        proc.sendUserText('do work')
        await flushCapacityMicrotasks()
        for (const delay of [5000, 10000, 20000]) {
          completeCapacityTurn(proc, error)
          expect(proc.turnRetry.delayMs).toBe(delay)
          await clock.tick()
        }
        completeCapacityTurn(proc, null)
        expect(proc.turnRetry).toBeNull()
      }
    })
  })

  test.each([{ message: STREAM_MESSAGE, codexErrorInfo: 'other' }, COMPACT_ERROR, REQUEST_TIMEOUT_ERROR, OVERLOADED_ERROR])('explicit rejection resends unaccepted input, while unknown transport outcomes stay terminal (%j)', async error => {
    await withCapacityClock(async clock => {
      let starts = 0
      const { proc, calls, events } = capacityHarness(method => {
        if (++starts === 1) throw new CodexRpcResponseError(method, 1, -32000, error.message, { codexErrorInfo: error.codexErrorInfo })
        return { turn: { id: 'accepted-stream-retry' } }
      })
      proc.sendUserText('unaccepted task', ['/tmp/input.csv'])
      await flushCapacityMicrotasks()
      await clock.tick()
      expect(calls[1]).toEqual(calls[0])
      expect(events.find(([name]) => name === 'turn_started')?.[1].retry).toBeUndefined()
      completeCapacityTurn(proc, null)
      for (const failure of [new Error(error.message), new Error('turn/start timed out'),
        new CodexRpcResponseError('thread/start', 2, -32000, error.message)]) {
        const h = capacityHarness(() => { throw failure })
        h.proc.sendUserText('do work')
        await flushCapacityMicrotasks()
        expect(h.events.filter(([name]) => name === 'result')).toHaveLength(1)
        expect(clock.timers.size).toBe(0)
      }
    })
  })

  test('permanent errors and unconfirmed terminal states do not authorize transient recovery', async () => {
    await withCapacityClock(async clock => {
      for (const error of [
        ...['unauthorized', 'usageLimitExceeded', 'contextWindowExceeded', 'badRequest'].map(codexErrorInfo => ({ message: STREAM_MESSAGE, codexErrorInfo })),
        ...[400, 401, 403, 429].map(httpStatusCode => ({ message: STREAM_MESSAGE, codexErrorInfo: { responseStreamDisconnected: { httpStatusCode } } })),
        ...['unauthorized', 'usageLimitExceeded', 'contextWindowExceeded', 'badRequest'].map(codexErrorInfo => ({ message: COMPACT_MESSAGE, codexErrorInfo })),
        ...[400, 401, 403, 429].map(httpStatusCode => ({ message: COMPACT_MESSAGE, codexErrorInfo: { httpConnectionFailed: { httpStatusCode } } })),
        ...['Error running remote compact task: Unauthorized', 'Error running remote compact task: context window exceeded'].map(message => ({ message, codexErrorInfo: 'httpConnectionFailed' })),
        ...TRANSPORT_ERROR_KINDS.flatMap(kind => [0, 400, 401, 403, 404, 409, 413, 422, 429, 501, 505, '503'].map(httpStatusCode => ({ message: COMPACT_MESSAGE, codexErrorInfo: { [kind]: { httpStatusCode } } }))),
        ...['sessionBudgetExceeded', 'rateLimitExceeded', 'flexUnavailable', 'cyberPolicy', 'misalignmentPolicyViolation', 'tooManyDenials', 'threadRollbackFailed', 'sandboxError', 'internalServerError', 'futureError'].map(codexErrorInfo => ({ message: COMPACT_MESSAGE, codexErrorInfo })),
        ...[{ activeTurnNotSteerable: { turnKind: 'compact' } }, { httpConnectionFailed: null }, { futureError: {} }, { httpConnectionFailed: {}, unauthorized: {} }, ['httpConnectionFailed']].map(codexErrorInfo => ({ message: COMPACT_MESSAGE, codexErrorInfo })),
        // 合并口径(fork WR-03 宽分类):"Selected model is at capacity" 文案先于
        // codexErrorInfo 判定,伴随 'unauthorized'/429 标签时仍归 capacity(与
        // session.isCodexCapacityError 分类面对齐)——这两例在上方 transient
        // failure recovery 参数化重试组中验证其重试行为。
        { message: 'unexpected status 401 Unauthorized', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: null } } },
        ...['unexpected status 401 Unauthorized', 'usage limit exceeded', "You've hit your usage limit"].map(additionalDetails => ({ message: 'Upstream transport failed', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: null } }, additionalDetails })),
        { message: 'workspace routing discovery failed', codexErrorInfo: 'other' },
        { message: `${COMPACT_MESSAGE}: usage limit exceeded`, codexErrorInfo: 'other' },
        { message: 'An error occurred while processing your request.', codexErrorInfo: 'other' },
      ]) {
        const { proc, events } = capacityHarness()
        proc.sendUserText('do work')
        await flushCapacityMicrotasks()
        completeCapacityTurn(proc, error)
        expect(events.filter(([name]) => name === 'result')).toHaveLength(1)
        expect(clock.timers.size).toBe(0)
      }
      for (const error of [{ message: STREAM_MESSAGE }, COMPACT_ERROR, REQUEST_TIMEOUT_ERROR, OVERLOADED_ERROR]) {
        for (const terminal of [{ status: 'interrupted', id: 'capacity-turn-1' }, { status: 'failed' }]) {
          const { proc } = capacityHarness()
          proc.sendUserText('do work')
          await flushCapacityMicrotasks()
          proc.handleNotification('turn/completed', { threadId: 'capacity-thread', turn: { ...terminal, error } })
          expect(clock.timers.size).toBe(0)
        }
      }
    })
  })

  test('matching terminal diagnostics retain omitted native error metadata without borrowing a different error', async () => {
    await withCapacityClock(async clock => {
      for (const metadata of [
        { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } },
        { codexErrorInfo: 'unauthorized' },
        { codexErrorInfo: 'other', additionalDetails: 'usage limit exceeded' },
      ]) {
        const { proc, events } = capacityHarness()
        proc.sendUserText('do work')
        await flushCapacityMicrotasks()
        proc.handleNotification('error', { threadId: 'capacity-thread', turnId: proc.currentTurnId,
          error: { message: COMPACT_MESSAGE, ...metadata }, willRetry: false })
        completeCapacityTurn(proc, { message: COMPACT_MESSAGE })
        expect(clock.timers.size).toBe(0)
        expect(events.filter(([name]) => name === 'result')).toHaveLength(1)
      }
      for (const sameMessage of [true, false]) {
        const { proc, events } = capacityHarness()
        proc.sendUserText('do work')
        await flushCapacityMicrotasks()
        proc.handleNotification('error', { threadId: 'capacity-thread', turnId: proc.currentTurnId,
          error: { message: 'Upstream transport failed', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } }, willRetry: false })
        completeCapacityTurn(proc, { message: sameMessage ? 'Upstream transport failed' : 'Unknown terminal failure' })
        expect(clock.timers.size).toBe(sameMessage ? 1 : 0)
        if (sameMessage) { await clock.tick(); completeCapacityTurn(proc, null) }
        expect(events.filter(([name]) => name === 'result')).toHaveLength(1)
      }
    })
  })

  test('failed manual compaction cannot resume an already completed task; new input restores automatic recovery', async () => {
    await withCapacityClock(async clock => {
      let starts = 0
      const { proc, calls, events } = capacityHarness(method => {
        if (method === 'thread/compact/start') return {}
        if (method === 'turn/start') return { turn: { id: `user-turn-${++starts}` } }
        throw new Error(`unexpected request ${method}`)
      })
      proc.sendUserText('completed task')
      await flushCapacityMicrotasks()
      completeCapacityTurn(proc, null)
      await proc.compactThread()
      proc.handleNotification('turn/started', { threadId: 'capacity-thread', turn: { id: 'manual-compact' } })
      completeCapacityTurn(proc, COMPACT_ERROR)
      expect(clock.timers.size).toBe(0)
      expect(calls.filter(call => call.method === 'turn/start')).toHaveLength(1)
      expect(events.filter(([name, payload]) => name === 'result' && payload.is_error)).toHaveLength(1)
      proc.sendUserText('new task')
      await flushCapacityMicrotasks()
      completeCapacityTurn(proc, COMPACT_ERROR)
      expect(clock.timers.size).toBe(1)
    })
  })

  test.each(['active', 'waiting'])('manual compaction cannot disable recovery for a %s task', async state => {
    await withCapacityClock(async clock => {
      const { proc } = capacityHarness()
      proc.sendUserText('do work')
      await flushCapacityMicrotasks()
      if (state === 'waiting') completeCapacityTurn(proc, COMPACT_ERROR)
      await expect(proc.compactThread()).rejects.toThrow('while a task is active')
      if (state === 'active') completeCapacityTurn(proc, COMPACT_ERROR)
      expect(clock.timers.size).toBe(1)
    })
  })

  test('routing discovery failure continues only with a native timeout from the same turn', async () => {
    await withCapacityClock(async clock => {
      const { proc, calls, events } = capacityHarness()
      proc.sendUserText('task with completed effects')
      await flushCapacityMicrotasks()
      const turnId = proc.currentTurnId
      proc.handleNotification('error', {
        threadId: 'capacity-thread', turnId, willRetry: true,
        error: { message: 'Reconnecting... 3/5', codexErrorInfo: 'other', additionalDetails: 'workspace routing discovery timed out' },
      })
      expect(clock.timers.size).toBe(0)
      const error = { message: 'workspace routing discovery failed', codexErrorInfo: 'other' }
      proc.handleNotification('error', { threadId: 'capacity-thread', turnId, error, willRetry: false })
      proc.handleNotification('turn/completed', { threadId: 'capacity-thread', turn: { id: turnId, status: 'failed' } })
      expect(proc.turnRetry).toMatchObject({ reason: 'transient_error', delayMs: 5000 })
      expect(events.filter(([name]) => name === 'result')).toHaveLength(0)
      await clock.tick()
      expect(calls.filter(call => call.method === 'turn/start').at(-1)!.params.input[0].text).not.toContain('task with completed effects')
      // Timeout evidence from the previous attempt cannot authorize this one.
      completeCapacityTurn(proc, error)
      expect(clock.timers.size).toBe(0)
      expect(events.filter(([name]) => name === 'result')).toHaveLength(1)
    })
  })

  test('routing timeout hints cannot override permanent errors or cross thread, turn and task boundaries', async () => {
    await withCapacityClock(async clock => {
      for (const scenario of ['child', 'stale', 'permanent', 'permanent-hint', 'http-hint', 'permanent-text-hint', 'http-text-hint', 'nonretrying', 'new-input']) {
        const { proc, events } = capacityHarness()
        proc.sendUserText('do work')
        await flushCapacityMicrotasks()
        proc.handleNotification('error', {
          threadId: scenario === 'child' ? 'child-thread' : 'capacity-thread',
          turnId: scenario === 'stale' ? 'old-turn' : proc.currentTurnId,
          willRetry: scenario !== 'nonretrying',
          error: { message: scenario === 'permanent-text-hint' ? 'unauthorized'
              : scenario === 'http-text-hint' ? 'unexpected status 401 Unauthorized' : 'Reconnecting... 3/5',
            codexErrorInfo: scenario === 'permanent-hint' ? 'unauthorized'
              : scenario === 'http-hint' ? { httpConnectionFailed: { httpStatusCode: 401 } } : 'other',
            additionalDetails: 'workspace routing discovery timed out' },
        })
        if (scenario === 'new-input') {
          completeCapacityTurn(proc, null)
          proc.sendUserText('next task')
          await flushCapacityMicrotasks()
        }
        completeCapacityTurn(proc, { message: 'workspace routing discovery failed', codexErrorInfo: scenario === 'permanent' ? 'unauthorized' : 'other' })
        expect(clock.timers.size).toBe(0)
        expect(events.filter(([name, payload]) => name === 'result' && payload.is_error)).toHaveLength(1)
      }
    })
  })
})

describe('codex JSON-RPC lifecycle reliability', () => {
  test('starts the complete app-server feature surface without isolation overrides', () => {
    expect(codexAppServerArgs()).toEqual(['app-server', '--listen', 'stdio://'])
  })

  for (const resume of [false, true]) {
    test(`delegated Codex workers retain native delegation at process and thread launch (resume=${resume})`, async () => {
      expect(codexAppServerArgs()).toEqual(['app-server', '--listen', 'stdio://'])
      const { proc, calls } = makeCodexProtocolHarness({
        model: 'worker-model', effort: 'xhigh',
        ...(resume ? { launch: { kind: 'resume', source: { provider: 'codex', sessionId: 'worker-thread', cwd: '/repo' } } } : {}),
      })
      await proc.initializeAndStartThread()
      const launch = calls.find(call => call.method === (resume ? 'thread/resume' : 'thread/start'))!
      expect(launch.params.config).not.toHaveProperty('features.multi_agent')
      expect(launch.params.config.model_reasoning_effort).toBe('xhigh')
      expect(launch.params.sandbox).toBe('danger-full-access')
      expect(launch.params.model).toBe('worker-model')
    })
    for (const allowUserInput of [true, false]) {
      test(`Codex input tools follow the current invocation policy (resume=${resume}, allowUserInput=${allowUserInput})`, async () => {
        const { proc, calls } = makeCodexProtocolHarness({
          allowUserInput, model: 'worker-model', effort: 'xhigh', appendSystemPrompt: 'complete the goal without questions',
          ...(resume ? { launch: { kind: 'resume', source: { provider: 'codex', sessionId: 'worker-thread', cwd: '/repo' } } } : {}),
        }, async (method, params) => {
          if (method === 'initialize') return {}
          if (method === 'thread/start' || method === 'thread/resume') {
            return { thread: { id: params.threadId ?? 'worker-thread', cwd: '/repo' } }
          }
          if (method === 'turn/start') return { turn: { id: 'execution-turn', status: 'inProgress' } }
          throw new Error(`unexpected request ${method}`)
        })
        proc.readyPromise = proc.initializeAndStartThread()
        await proc.startTurn('complete the goal')
        const launch = calls.find(call => call.method === (resume ? 'thread/resume' : 'thread/start'))!
        expect(launch.params.config['features.default_mode_request_user_input']).toBe(allowUserInput)
        expect(launch.params.config['tools.experimental_request_user_input.enabled']).toBe(allowUserInput)
        expect(launch.params.config.model_reasoning_effort).toBe('xhigh')
        expect(launch.params.model).toBe('worker-model')
        const turn = calls.find(call => call.method === 'turn/start')!
        expect(turn.params.collaborationMode).toEqual(allowUserInput ? undefined : {
          mode: 'default',
          settings: { model: 'worker-model', reasoning_effort: 'xhigh', developer_instructions: 'complete the goal without questions' },
        })
      })
    }
  }

  test('keeps Windows-compatible Codex spawning shell-free so TOML argv stays literal', () => {
    const env = { PATH: 'C:\\bin' }
    expect(codexAppServerSpawnOptions('C:\\repo', env)).toEqual({
      cwd: 'C:\\repo',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env,
    })
    expect(codexAppServerArgs()).not.toContain('--disable')
  })

  test('registers pending before write and clears its timeout on response', async () => {
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

  test('JSON-RPC response errors retain the pending method in diagnostics', async () => {
    const proc = makeCodexLifecycleHarness({
      write: (chunk: string) => {
        const id = JSON.parse(chunk).id
        queueMicrotask(() => proc.handleMessage({
          id,
          error: { code: -32000, message: 'no rollout found for thread id ghost-thread' },
        }))
        return true
      },
    })

    const request = proc.request('thread/resume', {}, 20)
    await expect(request).rejects.toThrow('codex app-server thread/resume failed')
    await expect(request).rejects.toMatchObject({
      method: 'thread/resume',
      requestId: 1,
      serverCode: -32000,
      serverMessage: 'no rollout found for thread id ghost-thread',
    })
    expect(proc.pending.size).toBe(0)
  })

  test('rejects dead stdin writes without leaving a pending request', async () => {
    const proc = makeCodexLifecycleHarness({ writable: false })

    await expect(proc.request('initialize', {}, 20)).rejects.toThrow('stdin is not writable')
    expect(proc.pending.size).toBe(0)
  })

  test('rejects asynchronous stdin write failures without leaking pending', async () => {
    const proc = makeCodexLifecycleHarness({
      write: (_chunk: string, callback: (error?: Error) => void) => {
        queueMicrotask(() => callback(new Error('EPIPE')))
        return true
      },
    })

    await expect(proc.request('initialize', {}, 20)).rejects.toThrow('EPIPE')
    expect(proc.pending.size).toBe(0)
  })

  test('a spawn error without a pid terminalizes lifecycle instead of leaving a ghost alive process', async () => {
    const proc = makeCodexLifecycleHarness()
    const exits: any[] = []
    proc.on('error', () => {})
    proc.on('exit', (event: any) => exits.push(event))
    const pending = proc.request('initialize', {}, 100)

    proc.handleChildProcessError(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))

    await expect(pending).rejects.toThrow('process failed before initialize response')
    expect(proc.isAlive()).toBe(false)
    await expect(proc.kill(1)).resolves.toBeUndefined()
    expect(exits).toEqual([{ code: null, signal: null, expected: false }])
  })

  test('OS exit keeps pending RPCs alive until a final stdout response is drained on close', async () => {
    let requestId = 0
    const proc = makeCodexLifecycleHarness({
      write: (chunk: string) => {
        requestId = JSON.parse(chunk).id
        return true
      },
    })
    const pending = proc.request('thread/read', {}, 100)
    proc.stdoutBuf = JSON.stringify({ id: requestId, result: { thread: { id: 'thread-1' } } })

    proc.handleChildExit(0, null)
    expect(proc.pending.size).toBe(1)
    proc.handleChildClose(0, null)

    await expect(pending).resolves.toEqual({ thread: { id: 'thread-1' } })
    expect(proc.pending.size).toBe(0)
    expect(proc.isAlive()).toBe(false)
  })

  test('stdin EPIPE does not reject an already-sent RPC whose response is in the stdout tail', async () => {
    let requestId = 0
    const proc = makeCodexLifecycleHarness({
      write: (chunk: string) => {
        requestId = JSON.parse(chunk).id
        return true
      },
    })
    proc.expectedExit = true
    const pending = proc.request('thread/read', {}, 100)

    proc.handleStdinError(new Error('EPIPE'))
    expect(proc.pending.size).toBe(1)
    proc.stdoutBuf = JSON.stringify({ id: requestId, result: { thread: { id: 'thread-1' } } })
    proc.handleChildClose(0, null)

    await expect(pending).resolves.toEqual({ thread: { id: 'thread-1' } })
  })

  test('public exit waits for tail materialization continuations before Session cleanup', async () => {
    const proc = makeCodexLifecycleHarness()
    const exits: any[] = []
    proc.on('exit', (event: any) => exits.push(event))
    let releaseMaterialization: () => void = () => {}
    const materialization = new Promise<void>(resolve => {
      releaseMaterialization = resolve
    })
    proc.conversationMaterializationVerification = materialization
    void materialization.then(() => {
      proc.conversationMaterializationVerification = null
    })

    proc.handleChildExit(0, null)
    proc.handleChildClose(0, null)
    expect(exits).toEqual([])
    expect(proc.isAlive()).toBe(true)

    releaseMaterialization()
    await proc.exitPromise
    expect(exits).toEqual([{ code: 0, signal: null, expected: false }])
    expect(proc.isAlive()).toBe(false)
  })

  test('times out unanswered requests and removes them from pending', async () => {
    const proc = makeCodexLifecycleHarness()

    await expect(proc.request('thread/start', {}, 5)).rejects.toThrow('timed out after 5ms')
    expect(proc.pending.size).toBe(0)
  })

  test('waits for real exit after SIGKILL instead of returning after delivery', async () => {
    const proc = makeCodexLifecycleHarness()
    const signals: string[] = []
    proc.proc.kill = (signal: string) => {
      signals.push(signal)
      if (signal === 'SIGKILL') {
        queueMicrotask(() => {
          proc.alive = false
          proc.exitEventEmitted = true
          proc.resolveExit()
        })
      }
      return true
    }

    await expect(proc.kill(5)).resolves.toBeUndefined()
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(proc.alive).toBe(false)
  })

  test('rejects kill when neither TERM nor KILL produces an exit', async () => {
    const proc = makeCodexLifecycleHarness()
    const signals: string[] = []
    proc.proc.kill = (signal: string) => {
      signals.push(signal)
      return true
    }

    await expect(proc.kill(2)).rejects.toThrow('did not exit after SIGTERM and SIGKILL')
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })
})

describe('codex app-server conversation protocol', () => {
  test('catalog and main launch share one initialize handshake and send initialized once', async () => {
    let releaseInitialize!: () => void
    const initializeGate = new Promise<void>(resolve => { releaseInitialize = resolve })
    const { proc, calls, writes } = makeCodexProtocolHarness({}, async (method, _params) => {
      if (method === 'initialize') {
        await initializeGate
        return {}
      }
      if (method === 'thread/start') return { thread: { id: 'main-thread', cwd: '/repo' } }
      if (method === 'model/list') return { data: [], nextCursor: null }
      throw new Error(`unexpected request ${method}`)
    })

    const main = proc.initializeAndStartThread()
    const catalog = proc.listModels()
    await Promise.resolve()
    expect(calls.filter(c => c.method === 'initialize')).toHaveLength(1)

    releaseInitialize()
    await expect(Promise.all([main, catalog])).resolves.toEqual([undefined, []])
    expect(calls.filter(c => c.method === 'initialize')).toHaveLength(1)
    expect(writes).toEqual([{ method: 'initialized' }])
    expect(calls.findIndex(c => c.method === 'initialize')).toBeLessThan(calls.findIndex(c => c.method === 'thread/start'))
    expect(calls.findIndex(c => c.method === 'initialize')).toBeLessThan(calls.findIndex(c => c.method === 'model/list'))
  })

  test('does not issue catalog requests when the initialized notification cannot be written', async () => {
    const { proc, calls } = makeCodexProtocolHarness()
    proc.write = () => new Error('stdin is not writable')

    await expect(proc.listModels()).rejects.toThrow('initialized notification write failed')
    expect(calls.filter(c => c.method === 'initialize')).toHaveLength(1)
    expect(calls.some(c => c.method === 'model/list')).toBe(false)
  })

  test('maps an explicit fresh launch to thread/start', async () => {
    const { proc, calls } = makeCodexProtocolHarness({
      launch: { kind: 'fresh' },
    })

    await proc.initializeAndStartThread()
    const launches = calls.filter(c => c.method.startsWith('thread/'))
    expect(launches).toHaveLength(1)
    expect(launches[0].method).toBe('thread/start')
    expect(launches[0].params).not.toHaveProperty('threadId')
    expect(proc.sessionId).toBe('fresh-thread')
    expect(proc.isConversationResumable()).toBe(false)
  })

  test('maps explicit resume to thread/resume', async () => {
    const { proc, calls } = makeCodexProtocolHarness({
      launch: { kind: 'resume', source: { provider: 'codex', sessionId: 'explicit-thread', cwd: '/repo' } },
    })
    await proc.initializeAndStartThread()
    expect(calls.find(c => c.method === 'thread/resume')?.params).toMatchObject({
      threadId: 'explicit-thread', cwd: '/repo', excludeTurns: true,
    })
    expect(proc.isConversationResumable()).toBe(true)
  })

  test('maps a Codex turn checkpoint to thread/fork lastTurnId', async () => {
    const source = { provider: 'codex' as const, sessionId: 'source-thread', cwd: '/repo' }
    const { proc, calls } = makeCodexProtocolHarness({
      launch: {
        kind: 'fork',
        source,
        through: { provider: 'codex', kind: 'turn', id: 'turn-7', source },
      },
    })

    await proc.initializeAndStartThread()
    expect(calls.find(c => c.method === 'thread/fork')?.params).toMatchObject({
      threadId: 'source-thread',
      lastTurnId: 'turn-7',
      cwd: '/repo',
      excludeTurns: true,
    })
    expect(proc.sessionId).toBe('forked-thread')
    expect(proc.isConversationResumable()).toBe(true)
  })

  test('sendInitialize returns the same exact readiness transaction to every caller', async () => {
    let releaseStart!: () => void
    const startGate = new Promise<void>(resolve => { releaseStart = resolve })
    const { proc } = makeCodexProtocolHarness({}, async (method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') {
        await startGate
        return { thread: { id: 'fresh-thread', cwd: '/repo' } }
      }
      throw new Error(`unexpected request ${method}`)
    })

    proc.sendInitialize()
    const first = proc.initializationPromise()
    proc.sendInitialize()
    const second = proc.initializationPromise()
    expect(second).toBe(first)
    releaseStart()
    await expect(first).resolves.toBeUndefined()
  })

  test('rejects a non-turn fork checkpoint before sending thread/fork', async () => {
    const source = { provider: 'codex', sessionId: 'source-thread', cwd: '/repo' }
    const { proc, calls } = makeCodexProtocolHarness({
      launch: {
        kind: 'fork',
        source,
        through: { provider: 'codex', kind: 'assistant-message', id: 'message-1', source },
      },
    })

    await expect(proc.initializeAndStartThread()).rejects.toThrow('must be a codex turn checkpoint')
    expect(calls.some(c => c.method === 'thread/fork')).toBe(false)
  })

  test('rejects a fork response that reuses the source id without falling back', async () => {
    const source = { provider: 'codex' as const, sessionId: 'source-thread', cwd: '/repo' }
    const { proc, calls } = makeCodexProtocolHarness({
      launch: { kind: 'fork', source },
    }, async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'thread/fork') return { thread: { id: params.threadId, cwd: '/repo' } }
      throw new Error(`unexpected request ${method}`)
    })

    await expect(proc.initializeAndStartThread()).rejects.toThrow('returned source thread id')
    expect(calls.filter(c => c.method === 'thread/fork')).toHaveLength(1)
    expect(calls.some(c => c.method === 'thread/resume' || c.method === 'thread/start')).toBe(false)
    expect(proc.sessionId).toBeNull()
  })

  test('rejects a fork response without a new thread id', async () => {
    const source = { provider: 'codex' as const, sessionId: 'source-thread', cwd: '/repo' }
    const { proc, calls } = makeCodexProtocolHarness({
      launch: { kind: 'fork', source },
    }, async (method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/fork') return { thread: { cwd: '/repo' } }
      throw new Error(`unexpected request ${method}`)
    })

    await expect(proc.initializeAndStartThread()).rejects.toThrow('thread/fork returned no thread.id')
    expect(calls.some(c => c.method === 'thread/resume' || c.method === 'thread/start')).toBe(false)
    expect(proc.sessionId).toBeNull()
  })

  test('rejects a launch response for a different cwd before exposing the thread id', async () => {
    const { proc } = makeCodexProtocolHarness({}, async (method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'wrong-cwd-thread', cwd: '/other' } }
      throw new Error(`unexpected request ${method}`)
    })

    await expect(proc.initializeAndStartThread()).rejects.toThrow('returned cwd=/other, expected /repo')
    expect(proc.sessionId).toBeNull()
  })

  test('rejects a launch response without an authoritative rollout path', async () => {
    const { proc } = makeCodexProtocolHarness({}, async (method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') {
        return { thread: { id: 'pathless-thread', cwd: '/repo', path: null } }
      }
      throw new Error(`unexpected request ${method}`)
    })

    await expect(proc.initializeAndStartThread()).rejects.toThrow('returned invalid thread.path=MISS')
    expect(proc.sessionId).toBeNull()
  })

  test('runs every Codex turn with the complete danger-full-access policy', async () => {
    const { proc, calls } = makeCodexProtocolHarness({}, async (method) => {
      if (method === 'turn/start') return { turn: { id: 'agent-turn' } }
      throw new Error(`unexpected request ${method}`)
    })
    proc.readyPromise = Promise.resolve()
    proc.sessionId = 'agent-thread'
    await proc.startTurn('work')
    expect(calls[0]).toMatchObject({
      method: 'turn/start',
      params: {
        sandboxPolicy: { type: 'dangerFullAccess' },
        runtimeWorkspaceRoots: ['/repo'],
      },
    })
  })

  test('rejects a resume response that routes to a different thread id', async () => {
    const source = { provider: 'codex' as const, sessionId: 'expected-thread', cwd: '/repo' }
    const { proc } = makeCodexProtocolHarness({
      launch: { kind: 'resume', source },
    }, async (method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/resume') {
        return { thread: { id: 'wrong-thread', cwd: '/repo' } }
      }
      throw new Error(`unexpected request ${method}`)
    })

    await expect(proc.initializeAndStartThread()).rejects.toThrow(
      'thread/resume returned thread id wrong-thread, expected expected-thread',
    )
    expect(proc.sessionId).toBeNull()
  })

  test('turn/start response and notification share one canonical transition', async () => {
    const { proc, events } = makeCodexProtocolHarness({}, async (method) => {
      if (method === 'turn/start') return { turn: { id: 'turn-response' } }
      throw new Error(`unexpected request ${method}`)
    })
    proc.readyPromise = Promise.resolve()
    proc.sessionId = 'main-thread'
    proc.conversationResumable = false

    await proc.startTurn('hello')
    expect(proc.isConversationResumable()).toBe(false)
    expect(events.filter(([event]) => event === 'conversation_materialized')).toEqual([])
    proc.handleNotification('turn/started', {
      threadId: 'main-thread',
      turn: { id: 'turn-response' },
    })
    await Promise.resolve()

    expect(proc.currentTurnId).toBe('turn-response')
    expect(events.filter(([event]) => event === 'turn_started')).toEqual([
      ['turn_started', { turn_id: 'turn-response', thread_id: 'main-thread' }],
    ])
    expect(events.filter(([event]) => event === 'conversation_materialized')).toEqual([
      ['conversation_materialized', {
        session_id: 'main-thread',
        source: 'turn/started notification',
      }],
    ])
    expect(proc.isConversationResumable()).toBe(true)
  })

  test('malformed turn/started cannot mark a fresh conversation resumable', () => {
    const { proc, events } = makeCodexProtocolHarness()
    proc.sessionId = 'main-thread'
    proc.conversationResumable = false

    // 合并口径(fork 8ae9856):空 turn.id 的通知记日志并忽略,不 throw(上游
    // recordTurnStarted 的 no-turn.id throw 随该机制一并删除)。安全性不变:
    // 未物化/未夺主。
    expect(() => proc.handleNotification('turn/started', {
      threadId: 'main-thread',
      turn: {},
    })).not.toThrow()

    expect(proc.currentTurnId ?? null).toBeNull()
    expect(proc.isConversationResumable()).toBe(false)
    expect(events.filter(([event]) => event === 'conversation_materialized')).toEqual([])
    expect(events.filter(([event]) => event === 'turn_started')).toEqual([])
  })

  test('turn lifecycle notifications without the exact main thread id fail closed', () => {
    const { proc, events } = makeCodexProtocolHarness()
    proc.sessionId = 'main-thread'
    proc.currentTurnId = 'turn-current'

    // 异轮 turn/started 不得夺取轮属主(冲突守卫;缺失 threadId 按 fork 口径
    // 归属主线程,但 id 不匹配照样拒绝)。
    proc.handleNotification('turn/started', { turn: { id: 'turn-missing-thread' } })
    expect(proc.currentTurnId).toBe('turn-current')

    // 显式异线程(sub-thread)的终止通知被 isForeignThread 前置过滤:既不得
    // 终结主轮、也不得 emit result(合并保留 fork 的外线程隔离)。

    proc.handleNotification('turn/completed', {
      threadId: 'child-thread',
      turn: { id: 'turn-current', status: 'completed' },
    })
    expect(proc.currentTurnId).toBe('turn-current')
    expect(events.filter(([event]) => event === 'turn_started' || event === 'result')).toEqual([])
  })

  test('turn/started without authoritative thread/read acknowledgement emits failure and stays unbound', async () => {
    const { proc, events } = makeCodexProtocolHarness()
    proc.sessionId = 'main-thread'
    proc.conversationRolloutPath = '/rollouts/rollout-main-thread.jsonl'
    proc.conversationResumable = false
    proc.verifyConversationMaterialized = async () => {
      throw new Error('rollout stat EACCES')
    }

    proc.handleNotification('turn/started', {
      threadId: 'main-thread',
      turn: { id: 'turn-1' },
    })
    await Promise.resolve()

    expect(proc.isConversationResumable()).toBe(false)
    expect(events.filter(([event]) => event === 'conversation_materialized')).toEqual([])
    expect(events.filter(([event]) => event === 'conversation_materialization_failed')).toEqual([
      ['conversation_materialization_failed', {
        session_id: 'main-thread',
        path: '/rollouts/rollout-main-thread.jsonl',
        source: 'turn/started notification',
        error: expect.any(Error),
      }],
    ])
  })

  test('materialization verification requires thread/read includeTurns and exact id cwd path', async () => {
    const { proc, calls } = makeCodexProtocolHarness({}, async (method, params) => {
      if (method === 'thread/read') {
        return {
          thread: {
            id: params.threadId,
            cwd: '/repo',
            path: '/rollouts/rollout-main-thread.jsonl',
            turns: [{ id: 'turn-1' }],
          },
        }
      }
      throw new Error(`unexpected request ${method}`)
    })
    delete proc.verifyConversationMaterialized
    proc.sessionId = 'main-thread'
    proc.conversationRolloutPath = '/rollouts/rollout-main-thread.jsonl'

    await expect(proc.verifyConversationMaterialized('turn/started notification')).resolves.toBeUndefined()
    expect(calls).toContainEqual({
      method: 'thread/read',
      params: { threadId: 'main-thread', includeTurns: true },
    })
  })

  test('materialization barrier drains a completion-triggered retry before settling', async () => {
    const { proc } = makeCodexProtocolHarness()
    proc.sessionId = 'main-thread'
    proc.conversationRolloutPath = '/rollouts/rollout-main-thread.jsonl'
    proc.conversationResumable = false
    let attempts = 0
    let releaseRetry: () => void = () => {}
    const retryGate = new Promise<void>(resolve => { releaseRetry = resolve })
    proc.verifyConversationMaterialized = async () => {
      attempts++
      if (attempts === 1) throw new Error('first verification raced persistence')
      await retryGate
    }

    proc.markConversationMaterialized('turn/started notification')
    proc.markConversationMaterialized('turn/completed notification')
    const barrier = proc.conversationMaterializationBarrier()
    expect(barrier).not.toBeNull()
    let settled = false
    void barrier!.then(() => { settled = true })
    for (let i = 0; i < 6; i++) await Promise.resolve()

    expect(attempts).toBe(2)
    expect(settled).toBe(false)
    releaseRetry()
    await expect(barrier!).resolves.toBeUndefined()
    expect(proc.isConversationResumable()).toBe(true)
  })

  test('does not revive a completed turn when its turn/start response arrives late', async () => {
    let resolveStart!: (value: any) => void
    const startResponse = new Promise<any>(resolve => { resolveStart = resolve })
    const { proc, events } = makeCodexProtocolHarness({}, async (method) => {
      if (method === 'turn/start') return startResponse
      throw new Error(`unexpected request ${method}`)
    })
    proc.readyPromise = Promise.resolve()
    proc.sessionId = 'main-thread'
    proc.lastCompletedTurnId = 'previous-turn'

    // 走交付路径(fork 口径):建 delivery 即清上一轮 checkpoint,与响应/通知
    // 到达顺序无关。
    proc.sendUserText('fast turn')
    expect(proc.lastCompletedTurnId).toBeNull()
    proc.handleNotification('turn/started', {
      threadId: 'main-thread',
      turn: { id: 'fast-turn' },
    })
    proc.handleNotification('turn/completed', {
      threadId: 'main-thread',
      turn: { id: 'fast-turn', status: 'completed', durationMs: 1 },
    })
    resolveStart({ turn: { id: 'fast-turn' } })
    for (let i = 0; i < 8; i++) await Promise.resolve()

    // 迟到的 turn/start 响应(delivery 已终结)不得复活轮属主,也不得重复
    // 发 turn_started(通知路径是唯一发点)。
    expect(proc.currentTurnId).toBeNull()
    expect(proc.lastCompletedTurnId).toBe('fast-turn')
    expect(events.filter(([event]) => event === 'turn_started')).toHaveLength(1)
  })

  test('late turn/started for a finished id cannot capture the next turn owner', () => {
    const { proc } = makeCodexProtocolHarness()
    proc.sessionId = 'main-thread'
    proc.finishedTurnIds = new Set(['turn-old'])
    const { delivery } = proc.beginTurnStart()

    // 已终结 turn 的迟到 turn/started(finishedTurnIds 守卫)被忽略。
    proc.handleNotification('turn/started', {
      threadId: 'main-thread',
      turn: { id: 'turn-old' },
    })
    expect(delivery.turnId).toBeNull()
    expect(proc.currentTurnId).toBeNull()

    // 新 turn 正常接管投递。
    proc.handleNotification('turn/started', {
      threadId: 'main-thread',
      turn: { id: 'turn-new' },
    })
    expect(delivery.turnId).toBe('turn-new')
    expect(proc.currentTurnId).toBe('turn-new')
  })

  test('late or duplicate turn/completed cannot clear a newer active turn or emit a second result', () => {
    const { proc, events } = makeCodexProtocolHarness()
    proc.sessionId = 'main-thread'
    proc.currentTurnId = 'turn-new'
    proc.lastCompletedTurnId = 'checkpoint-newer'
    proc.finishedTurnIds = new Set(['turn-finished'])

    proc.handleNotification('turn/completed', {
      threadId: 'main-thread',
      turn: { id: 'turn-finished', status: 'completed' },
    })
    proc.handleNotification('turn/completed', {
      threadId: 'main-thread',
      turn: { id: 'turn-old-first-terminal', status: 'completed' },
    })

    expect(proc.currentTurnId).toBe('turn-new')
    expect(proc.lastCompletedTurnId).toBe('checkpoint-newer')
    expect(events.filter(([event]) => event === 'result')).toEqual([])
    expect(proc.finishedTurnIds.has('turn-old-first-terminal')).toBe(true)
  })

  test('a duplicate completion for the current turn emits exactly one terminal result', () => {
    const { proc, events } = makeCodexProtocolHarness()
    proc.sessionId = 'main-thread'
    proc.currentTurnId = 'turn-1'
    proc.conversationResumable = true
    proc.finishedTurnIds = new Set()
    const notification = {
      threadId: 'main-thread',
      turn: { id: 'turn-1', status: 'completed' },
    }

    proc.handleNotification('turn/completed', notification)
    proc.handleNotification('turn/completed', notification)

    expect(events.filter(([event]) => event === 'result')).toHaveLength(1)
    expect(proc.currentTurnId).toBeNull()
  })

  test('ignores an old request timeout after its turn completed and the next turn started', async () => {
    let rejectFirst!: (error: Error) => void
    let resolveSecond!: (value: any) => void
    const firstResponse = new Promise<any>((_resolve, reject) => { rejectFirst = reject })
    const secondResponse = new Promise<any>(resolve => { resolveSecond = resolve })
    let requestIndex = 0
    const { proc, events } = makeCodexProtocolHarness({}, async (method) => {
      if (method !== 'turn/start') throw new Error(`unexpected request ${method}`)
      requestIndex += 1
      return requestIndex === 1 ? firstResponse : secondResponse
    })
    proc.readyPromise = Promise.resolve()
    proc.sessionId = 'main-thread'

    proc.sendUserText('first')
    await Promise.resolve()
    proc.handleNotification('turn/started', {
      threadId: 'main-thread',
      turn: { id: 'first-turn' },
    })
    proc.handleNotification('turn/completed', {
      threadId: 'main-thread',
      turn: { id: 'first-turn', status: 'completed', durationMs: 1 },
    })

    proc.sendUserText('second')
    await Promise.resolve()
    proc.handleNotification('turn/started', {
      threadId: 'main-thread',
      turn: { id: 'second-turn' },
    })

    rejectFirst(new Error('turn/start request timed out'))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(proc.currentTurnId).toBe('second-turn')
    expect(proc.lastResult.is_error).toBe(false)
    expect(events.filter(([event]) => event === 'result')).toEqual([
      ['result', expect.objectContaining({ turn_id: 'first-turn', is_error: false })],
    ])

    resolveSecond({ turn: { id: 'second-turn' } })
    await Promise.resolve()
    await Promise.resolve()
    expect(proc.currentTurnId).toBe('second-turn')
    expect(events.filter(([event]) => event === 'turn_started')).toHaveLength(2)
  })

  test('still reports a turn/start rejection owned by the current generation', async () => {
    const { proc, events } = makeCodexProtocolHarness({}, async (method) => {
      if (method === 'turn/start') throw new Error('current request failed')
      throw new Error(`unexpected request ${method}`)
    })
    proc.readyPromise = Promise.resolve()
    proc.sessionId = 'main-thread'

    proc.sendUserText('will fail')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(proc.currentTurnId).toBeNull()
    expect(events.filter(([event]) => event === 'result')).toEqual([
      ['result', expect.objectContaining({
        subtype: 'codex_turn_start_failed',
        is_error: true,
        error: 'current request failed',
      })],
    ])
  })

  test('records the canonical main-thread turn/completed id publicly', () => {
    const { proc, events } = makeCodexProtocolHarness()
    proc.sessionId = 'main-thread'
    proc.currentTurnId = 'turn-9'

    proc.handleNotification('turn/completed', {
      threadId: 'main-thread',
      turn: { id: 'turn-9', status: 'completed', durationMs: 25 },
    })

    expect(proc.lastCompletedTurnId).toBe('turn-9')
    expect(proc.currentTurnId).toBeNull()
    expect(events.filter(([event]) => event === 'result')).toEqual([
      ['result', expect.objectContaining({
        turn_id: 'turn-9',
        checkpoint: {
          provider: 'codex',
          kind: 'turn',
          id: 'turn-9',
          source: { provider: 'codex', sessionId: 'main-thread', cwd: '/repo' },
        },
      })],
    ])
  })

  test('failed or malformed terminal turns cannot reuse an earlier checkpoint', () => {
    for (const turn of [
      { id: 'failed-turn', status: 'failed', error: { type: 'model_error' } },
      { status: 'completed' },
    ]) {
      const { proc, events } = makeCodexProtocolHarness()
      proc.sessionId = 'main-thread'
      proc.lastCompletedTurnId = 'previous-turn'
      proc.handleNotification('turn/completed', { threadId: 'main-thread', turn })

      expect(proc.lastCompletedTurnId).toBeNull()
      expect(events.find(([event]) => event === 'result')?.[1].checkpoint).toBeNull()
    }
  })

  test('lists exact-cwd interactive conversations across every page without over-filtering their source', async () => {
    const { proc, calls, writes } = makeCodexProtocolHarness({}, async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'thread/list' && params.cursor === null) {
        return {
          data: [{ id: 'newer', cwd: '/repo', preview: 'new task', updatedAt: 1_777_000_000, status: { type: 'idle' } }],
          nextCursor: 'page-2',
        }
      }
      if (method === 'thread/list' && params.cursor === 'page-2') {
        return {
          data: [{ id: 'older', cwd: '/repo', preview: 'old task', updatedAt: 1_776_000_000, status: { type: 'systemError' } }],
          nextCursor: null,
        }
      }
      throw new Error(`unexpected request ${method}`)
    })

    await expect(proc.listConversations()).resolves.toEqual([
      { provider: 'codex', sessionId: 'newer', cwd: '/repo', preview: 'new task', ts: 1_777_000_000_000, status: 'idle' },
      { provider: 'codex', sessionId: 'older', cwd: '/repo', preview: 'old task', ts: 1_776_000_000_000, status: 'systemError' },
    ])
    expect(calls.filter(c => c.method === 'thread/list').map(c => c.params)).toEqual([
      {
        cursor: null,
        limit: 100,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        cwd: '/repo',
      },
      {
        cursor: 'page-2',
        limit: 100,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        cwd: '/repo',
      },
    ])
    expect(writes).toEqual([{ method: 'initialized' }])
    expect(calls.some(c => c.method === 'thread/start')).toBe(false)
  })

  test('excludes delegated Agent threads from the main rs history', async () => {
    resetAgentSessionRegistryForTest(['codex:delegated'])
    try {
      const { proc } = makeCodexProtocolHarness({}, async (method) => {
        if (method === 'initialize') return {}
        if (method === 'thread/list') return {
          data: [
            { id: 'delegated', cwd: '/repo', preview: 'child work', updatedAt: 2 },
            { id: 'main', cwd: '/repo', preview: 'main work', updatedAt: 1 },
          ],
          nextCursor: null,
        }
        throw new Error(`unexpected request ${method}`)
      })
      await expect(proc.listConversations()).resolves.toEqual([
        { provider: 'codex', sessionId: 'main', cwd: '/repo', preview: 'main work', ts: 1000 },
      ])
    } finally {
      resetAgentSessionRegistryForTest()
    }
  })

  test('surfaces thread/list transport and malformed-response failures', async () => {
    const failed = makeCodexProtocolHarness({}, async (method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/list') throw new Error('list unavailable')
      throw new Error(`unexpected request ${method}`)
    }).proc
    await expect(failed.listConversations()).rejects.toThrow('list unavailable')

    const malformed = makeCodexProtocolHarness({}, async (method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/list') return { nextCursor: null }
      throw new Error(`unexpected request ${method}`)
    }).proc
    await expect(malformed.listConversations()).rejects.toThrow('no data array')

    const wrongCwd = makeCodexProtocolHarness({}, async (method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/list') {
        return { data: [{ id: 'wrong', cwd: '/other', preview: 'x', updatedAt: 1 }], nextCursor: null }
      }
      throw new Error(`unexpected request ${method}`)
    }).proc
    await expect(wrongCwd.listConversations()).rejects.toThrow('invalid thread summary')
  })

  test('resolves a legacy resume id through stable thread/read cwd metadata', async () => {
    const { proc, calls } = makeCodexProtocolHarness({}, async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'thread/read') return { thread: { id: params.threadId, cwd: '/repo' } }
      throw new Error(`unexpected request ${method}`)
    })
    await expect(proc.readConversationRef('legacy-thread')).resolves.toEqual({
      provider: 'codex', sessionId: 'legacy-thread', cwd: '/repo',
    })
    expect(calls.find(call => call.method === 'thread/read')?.params).toEqual({
      threadId: 'legacy-thread', includeTurns: false,
    })
  })
})

describe('codex rollout incremental reader', () => {
  test('authoritative rollout checks require the exact app-server path to be a readable file', () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-rollout-authority-'))
    const file = join(root, 'rollout-thread-1.jsonl')
    const { proc } = makeCodexProtocolHarness()
    delete proc.assertConversationRolloutMaterialized
    proc.conversationRolloutPath = file

    try {
      expect(() => proc.assertConversationRolloutMaterialized('test notification')).toThrow(
        'rollout is not readable',
      )
      writeFileSync(file, '{}\n')
      expect(() => proc.assertConversationRolloutMaterialized('test notification')).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('reads only appended bytes and retains an incomplete JSON line', () => {
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

      const line = JSON.stringify({ payload: { type: 'image_generation_end', call_id: 'img-1' } })
      const split = Math.floor(line.length / 2)
      writeFileSync(file, line.slice(0, split))
      proc.flushRolloutImageGenerations()
      expect(seen).toHaveLength(0)
      expect(proc.rolloutReadOffset).toBe(split)

      appendFileSync(file, line.slice(split) + '\n')
      proc.flushRolloutImageGenerations()
      expect(seen).toEqual([{ type: 'image_generation_end', call_id: 'img-1' }])
      expect(proc.rolloutReadOffset).toBe(Buffer.byteLength(line + '\n'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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
    // reasoning item 走 UNMAPPED log(不 emit raw);thread/status/changed 已被
    // 子 agent 状态机消费(exec-cell 编排的终态信号),不再落 raw。
    expect(raw).toHaveLength(0)
    expect(compacted).toHaveLength(1)
  })

  test('retains the completed image prompt when the start event has no prompt', () => {
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
          revisedPrompt: undefined,
        },
      }],
      ['tool_result', {
        tool_use_id: 'img-1',
        content: '/tmp/cat.png',
        is_error: false,
        input: { status: 'completed', revisedPrompt: 'A cute cat curled up in a sunbeam.' },
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

describe('codex collab agent translation (ultra multi-agent)', () => {
  function makeProc(): { proc: any; events: Array<[string, any]> } {
    const proc = Object.create(CodexProcess.prototype) as any
    const events: Array<[string, any]> = []
    proc.opts = { workDir: '/tmp' }
    proc.collabAgentNames = new Map()
    proc.collabAgentSettled = new Set()
    proc.collabAgentSummaries = new Map()
    proc.emit = (event: string, payload: unknown) => {
      events.push([event, payload])
      return true
    }
    return { proc, events }
  }

  test('subAgentActivity started → bg_task_started + promoted; completed terminal via collabAgentToolCall → bg_task_settled', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: {
        type: 'subAgentActivity',
        id: 'call_1',
        kind: 'started',
        agentThreadId: 'agent-thread-1',
        agentPath: '/root/order_schema/official_history_orders',
      },
      threadId: 'main-thread',
      turnId: 'turn-1',
    })

    const bgEvents = events.filter(([e]) => e.startsWith('bg_task'))
    expect(bgEvents).toEqual([
      ['bg_task_started', {
        task_id: 'agent-thread-1',
        task_type: 'local_agent',
        description: 'official_history_orders',
        prompt: undefined,
      }],
      ['bg_task_updated', {
        task_id: 'agent-thread-1',
        patch: { is_backgrounded: true },
      }],
    ])

    // wait 调用携带 agentsStates:running → updated;completed(message)→ settled。
    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall',
        id: 'call_2',
        tool: 'wait',
        status: 'completed',
        agentsStates: {
          'agent-thread-1': { status: 'completed', message: '调查结论:可以改' },
        },
      },
      threadId: 'main-thread',
      turnId: 'turn-1',
    })

    const settled = events.filter(([e]) => e === 'bg_task_settled')
    expect(settled).toEqual([['bg_task_settled', {
      task_id: 'agent-thread-1',
      status: 'completed',
      summary: '调查结论:可以改',
    }]])

    // 同 agent 的后续 wait item 重复携带终态 → 不重复结算、不翻活。
    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall',
        id: 'call_3',
        tool: 'wait',
        status: 'completed',
        agentsStates: {
          'agent-thread-1': { status: 'completed', message: '调查结论:可以改' },
        },
      },
      threadId: 'main-thread',
      turnId: 'turn-1',
    })
    expect(events.filter(([e]) => e === 'bg_task_settled')).toHaveLength(1)
  })

  test('spawnAgent emits one Agent tool panel (started) and closes it once (completed)', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: {
        type: 'collabAgentToolCall',
        id: 'spawn-1',
        tool: 'spawnAgent',
        status: 'inProgress',
        prompt: '调查 history_orders 接口',
        receiverThreadIds: ['agent-thread-2'],
        agentsStates: { 'agent-thread-2': { status: 'running', message: null } },
      },
      threadId: 'main-thread',
      turnId: 'turn-2',
    })

    // spawn started:一个 Agent tool_use + bg_task_started/promoted(先于 subAgentActivity)
    const toolUses = events.filter(([e]) => e === 'tool_use')
    expect(toolUses).toHaveLength(1)
    expect(toolUses[0][1].name).toBe('Agent')
    expect(toolUses[0][1].input.description).toBe('派生 1 个子 agent')

    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall',
        id: 'spawn-1',
        tool: 'spawnAgent',
        status: 'completed',
        receiverThreadIds: ['agent-thread-2'],
        agentsStates: { 'agent-thread-2': { status: 'running', message: null } },
      },
      threadId: 'main-thread',
      turnId: 'turn-2',
    })

    // completed 不再补 tool_use,只补 tool_result 关面板。
    expect(events.filter(([e]) => e === 'tool_use')).toHaveLength(1)
    const results = events.filter(([e]) => e === 'tool_result')
    expect(results).toHaveLength(1)
    expect(results[0][1].tool_use_id).toBe('spawn-1')
    expect(results[0][1].content).toContain('agent-thread-2: running')
  })

  test('pure orchestration calls (wait/sendInput/closeAgent) emit no tool panels', () => {
    const { proc, events } = makeProc()
    for (const tool of ['wait', 'sendInput', 'resumeAgent', 'closeAgent']) {
      proc.handleNotification('item/started', {
        item: { type: 'collabAgentToolCall', id: `x-${tool}`, tool, status: 'inProgress', agentsStates: {} },
        threadId: 'main-thread', turnId: 'turn-3',
      })
      proc.handleNotification('item/completed', {
        item: { type: 'collabAgentToolCall', id: `x-${tool}`, tool, status: 'completed', agentsStates: {} },
        threadId: 'main-thread', turnId: 'turn-3',
      })
    }
    expect(events.filter(([e]) => e === 'tool_use' || e === 'tool_result')).toHaveLength(0)
  })

  test('errored agent settles as failed; unknown orchestration items stay out of UNHANDLED noise', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: {
        type: 'subAgentActivity',
        id: 'call_9',
        kind: 'started',
        agentThreadId: 'agent-thread-3',
        agentPath: '/root/fix_bug',
      },
      threadId: 'main-thread', turnId: 'turn-4',
    })
    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall',
        id: 'call_10',
        tool: 'wait',
        status: 'completed',
        agentsStates: { 'agent-thread-3': { status: 'errored', message: 'context window exceeded' } },
      },
      threadId: 'main-thread', turnId: 'turn-4',
    })

    const settled = events.filter(([e]) => e === 'bg_task_settled')
    expect(settled).toEqual([['bg_task_settled', {
      task_id: 'agent-thread-3',
      status: 'failed',
      summary: 'context window exceeded',
    }]])
    expect(events.filter(([e]) => e === 'raw')).toHaveLength(0)
  })
})

describe('codex collab followup reactivation', () => {
  test('settled agent re-runs via followup: revive then settle again', () => {
    const proc = Object.create(CodexProcess.prototype) as any
    const events: Array<[string, any]> = []
    proc.opts = { workDir: '/tmp' }
    proc.collabAgentNames = new Map()
    proc.collabAgentSettled = new Set()
    proc.collabAgentSummaries = new Map()
    proc.emit = (event: string, payload: unknown) => {
      events.push([event, payload])
      return true
    }

    const startedItem = {
      type: 'subAgentActivity',
      id: 'call_a',
      kind: 'started',
      agentThreadId: 'agent-r',
      agentPath: '/root/final_review',
    }
    proc.handleNotification('item/started', { item: startedItem, threadId: 'm', turnId: 't' })
    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall',
        id: 'w1',
        tool: 'wait',
        status: 'completed',
        agentsStates: { 'agent-r': { status: 'completed', message: '初审完成' } },
      },
      threadId: 'm', turnId: 't',
    })
    expect(events.filter(([e]) => e === 'bg_task_settled')).toHaveLength(1)

    // followup_task:agent 重新 running → 补 started+promote 让沉降后已清空的
    // entry 重新入池,running patch 翻活墓碑。
    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall',
        id: 'w2',
        tool: 'sendInput',
        status: 'completed',
        agentsStates: { 'agent-r': { status: 'running', message: null } },
      },
      threadId: 'm', turnId: 't',
    })
    const tail = events.filter(([e]) => e.startsWith('bg_task')).slice(-3)
    expect(tail.map(([e]) => e)).toEqual(['bg_task_started', 'bg_task_updated', 'bg_task_updated'])
    expect(tail[0][1].description).toBe('final_review')
    expect(tail[2][1].patch).toEqual({ status: 'running' })

    // 第二次完成 → 重新结算,summary 换新。
    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall',
        id: 'w3',
        tool: 'wait',
        status: 'completed',
        agentsStates: { 'agent-r': { status: 'completed', message: '复审完成' } },
      },
      threadId: 'm', turnId: 't',
    })
    const settled = events.filter(([e]) => e === 'bg_task_settled')
    expect(settled).toHaveLength(2)
    expect(settled[1][1].summary).toBe('复审完成')
  })
})

describe('codex collab closeAgent and terminal-first edge cases', () => {
  function makeProc(): { proc: any; events: Array<[string, any]> } {
    const proc = Object.create(CodexProcess.prototype) as any
    const events: Array<[string, any]> = []
    proc.opts = { workDir: '/tmp' }
    proc.collabAgentNames = new Map()
    proc.collabAgentSettled = new Set()
    proc.collabAgentSummaries = new Map()
    proc.emit = (event: string, payload: unknown) => {
      events.push([event, payload])
      return true
    }
    return { proc, events }
  }

  test('closeAgent settles receivers as stopped even when snapshot says running', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: {
        type: 'subAgentActivity', id: 'sa1', kind: 'started',
        agentThreadId: 'ag-1', agentPath: '/root/worker',
      },
      threadId: 'm', turnId: 't',
    })
    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall', id: 'c1', tool: 'closeAgent', status: 'completed',
        receiverThreadIds: ['ag-1'],
        agentsStates: { 'ag-1': { status: 'running', message: null } },
      },
      threadId: 'm', turnId: 't',
    })
    const settled = events.filter(([e]) => e === 'bg_task_settled')
    expect(settled).toEqual([['bg_task_settled', { task_id: 'ag-1', status: 'stopped' }]])
  })

  test('terminal-first agent: started+promoted+settled in one item, no running patch after settle', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall', id: 'w9', tool: 'wait', status: 'completed',
        receiverThreadIds: ['ag-fast'],
        agentsStates: { 'ag-fast': { status: 'completed', message: '秒完' } },
      },
      threadId: 'm', turnId: 't',
    })
    const kinds = events.filter(([e]) => e.startsWith('bg_task')).map(([e]) => e)
    expect(kinds).toEqual(['bg_task_started', 'bg_task_updated', 'bg_task_settled'])
  })

  test('spawn-first uses placeholder name; subAgentActivity later patches real name', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: {
        type: 'collabAgentToolCall', id: 'sp1', tool: 'spawnAgent', status: 'inProgress',
        receiverThreadIds: ['ag-2'], prompt: 'gAAAAABciphertext',
        agentsStates: { 'ag-2': { status: 'running', message: null } },
      },
      threadId: 'm', turnId: 't',
    })
    const firstStarted = events.find(([e]) => e === 'bg_task_started')!
    expect(firstStarted[1].description).toBe('子 agent')
    expect(firstStarted[1].prompt).toBe('(继承主线程历史的密文任务书)')

    proc.handleNotification('item/started', {
      item: {
        type: 'subAgentActivity', id: 'sa2', kind: 'started',
        agentThreadId: 'ag-2', agentPath: '/root/etl/orders',
      },
      threadId: 'm', turnId: 't',
    })
    const starteds = events.filter(([e]) => e === 'bg_task_started')
    expect(starteds).toHaveLength(2)
    expect(starteds[1][1].description).toBe('orders')
  })
})

describe('codex subagent item filtering (main-card cleanliness)', () => {
  function makeProc(): { proc: any; events: Array<[string, any]> } {
    const proc = Object.create(CodexProcess.prototype) as any
    const events: Array<[string, any]> = []
    proc.opts = { workDir: '/tmp' }
    proc.collabAgentNames = new Map()
    proc.collabAgentSettled = new Set()
    proc.collabAgentSummaries = new Map()
    proc.sessionId = 'main-thread'
    proc.emit = (event: string, payload: unknown) => {
      events.push([event, payload])
      return true
    }
    return { proc, events }
  }

  test('subagent-thread commandExecution becomes subagent_step, not tool_use', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: { type: 'commandExecution', id: 'exec-1', command: 'pytest -q', cwd: '/tmp' },
      threadId: 'sub-thread-1',
      turnId: 'turn-1',
    })
    proc.handleNotification('item/completed', {
      item: { type: 'commandExecution', id: 'exec-1', command: 'pytest -q', aggregatedOutput: '3 passed', exitCode: 0 },
      threadId: 'sub-thread-1',
      turnId: 'turn-1',
    })
    expect(events.filter(([e]) => e === 'tool_use')).toHaveLength(0)
    const steps = events.filter(([e]) => e === 'subagent_step')
    expect(steps).toHaveLength(2)
    expect(steps[0][1]).toMatchObject({ thread_id: 'sub-thread-1', tool: 'Bash', phase: 'started' })
    expect(steps[1][1]).toMatchObject({
      thread_id: 'sub-thread-1', tool: 'Bash', phase: 'completed', brief: '→ 3 passed',
    })
  })

  test('subagent Bash step brief unwraps PowerShell-wrapped desc command', () => {
    // Windows 上 Codex 把命令包进 powershell.exe 调用,子 agent 后台卡 steps
    // 的 brief 也要显示中文说明,不显示 powershell.exe 路径。
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: {
        type: 'commandExecution', id: 'exec-ps', cwd: 'C:\\repo',
        command: `'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -Command '# desc: 查看模板目录状态\nGet-ChildItem "C:\\repo\\templates" -Recurse'`,
      },
      threadId: 'sub-thread-1',
      turnId: 'turn-1',
    })
    const steps = events.filter(([e]) => e === 'subagent_step')
    expect(steps).toHaveLength(1)
    expect((steps[0][1] as any).brief).toBe('查看模板目录状态')
  })

  test('subagent agentMessage does not leak into main assistant stream', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/completed', {
      item: { type: 'agentMessage', id: 'msg-sub', text: '子 agent 阶段性输出' },
      threadId: 'sub-thread-1',
      turnId: 'turn-1',
    })
    expect(events.filter(([e]) => e === 'assistant_block_stop')).toHaveLength(0)
    // 主线程的 agentMessage 不受影响
    proc.handleNotification('item/completed', {
      item: { type: 'agentMessage', id: 'msg-main', text: '主线程正文' },
      threadId: 'main-thread',
      turnId: 'turn-1',
    })
    expect(events.filter(([e]) => e === 'assistant_block_stop')).toHaveLength(1)
  })

  test('main-thread commandExecution still emits tool_use (unchanged behavior)', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: { type: 'commandExecution', id: 'exec-2', command: 'ls', cwd: '/tmp' },
      threadId: 'main-thread',
      turnId: 'turn-1',
    })
    expect(events.filter(([e]) => e === 'tool_use')).toHaveLength(1)
  })
})

describe('codex subagent step filtering', () => {
  test('reasoning items produce no subagent_step (step budget reserved for tools)', () => {
    const proc = Object.create(CodexProcess.prototype) as any
    const events: Array<[string, any]> = []
    proc.opts = { workDir: '/tmp' }
    proc.collabAgentNames = new Map()
    proc.collabAgentSettled = new Set()
    proc.collabAgentSummaries = new Map()
    proc.sessionId = 'main-thread'
    proc.emit = (event: string, payload: unknown) => {
      events.push([event, payload])
      return true
    }
    for (const phase of ['item/started', 'item/completed'] as const) {
      proc.handleNotification(phase, {
        item: { type: 'reasoning', id: 'rs-1', summary: [], content: ['思考中…'] },
        threadId: 'sub-thread-1',
        turnId: 't',
      })
    }
    // reasoning 完成也不出 step
    expect(events.filter(([e]) => e === 'subagent_step')).toHaveLength(0)
  })
})

describe('codex exec-cell orchestration via thread/status/changed', () => {
  function makeProc(): { proc: any; events: Array<[string, any]> } {
    const proc = Object.create(CodexProcess.prototype) as any
    const events: Array<[string, any]> = []
    proc.opts = { workDir: '/tmp' }
    proc.collabAgentNames = new Map()
    proc.collabAgentSettled = new Set()
    proc.collabAgentSummaries = new Map()
    proc.collabAgentWasActive = new Set()
    proc.sessionId = 'main-thread'
    proc.emit = (event: string, payload: unknown) => {
      events.push([event, payload])
      return true
    }
    return { proc, events }
  }

  test('idle(create)→active→idle(complete) settles as completed; create-idle does not', () => {
    const { proc, events } = makeProc()
    // spawn 信号(subAgentActivity)先到
    proc.handleNotification('item/started', {
      item: { type: 'subAgentActivity', id: 'sa', kind: 'started', agentThreadId: 'ag-x', agentPath: '/root/etl' },
      threadId: 'main-thread', turnId: 't',
    })
    // 创建态 idle:不结算
    proc.handleNotification('thread/status/changed', { threadId: 'ag-x', status: { type: 'idle' } })
    expect(events.filter(([e]) => e === 'bg_task_settled')).toHaveLength(0)
    // active:running
    proc.handleNotification('thread/status/changed', { threadId: 'ag-x', status: { type: 'active', activeFlags: [] } })
    // 完成态 idle:结算 completed
    proc.handleNotification('thread/status/changed', { threadId: 'ag-x', status: { type: 'idle' } })
    const settled = events.filter(([e]) => e === 'bg_task_settled')
    expect(settled).toEqual([['bg_task_settled', { task_id: 'ag-x', status: 'completed' }]])
  })

  test('revive after idle: second active re-enters pool and settles again', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: { type: 'subAgentActivity', id: 'sa', kind: 'started', agentThreadId: 'ag-y', agentPath: '/root/rev' },
      threadId: 'main-thread', turnId: 't',
    })
    proc.handleNotification('thread/status/changed', { threadId: 'ag-y', status: { type: 'active' } })
    proc.handleNotification('thread/status/changed', { threadId: 'ag-y', status: { type: 'idle' } })
    // 复活:followup 再拉起 → settled 清除,重新入池 running
    proc.handleNotification('thread/status/changed', { threadId: 'ag-y', status: { type: 'active' } })
    const revived = events.filter(([e]) => e === 'bg_task_settled')
    expect(revived).toHaveLength(1) // 尚未第二次 idle
    const lastStarted = events.filter(([e]) => e === 'bg_task_started').at(-1)!
    expect(lastStarted[1].description).toBe('rev')
    proc.handleNotification('thread/status/changed', { threadId: 'ag-y', status: { type: 'idle' } })
    expect(events.filter(([e]) => e === 'bg_task_settled')).toHaveLength(2)
  })

  test('main-thread and unknown-thread status changes are ignored', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('thread/status/changed', { threadId: 'main-thread', status: { type: 'active' } })
    proc.handleNotification('thread/status/changed', { threadId: 'unknown-ag', status: { type: 'active' } })
    expect(events.filter(([e]) => e.startsWith('bg_task'))).toHaveLength(0)
  })
})

describe('codex review-round-3 fixes', () => {
  function makeProc(): { proc: any; events: Array<[string, any]> } {
    const proc = Object.create(CodexProcess.prototype) as any
    const events: Array<[string, any]> = []
    proc.opts = { workDir: '/tmp' }
    proc.collabAgentNames = new Map()
    proc.collabAgentSettled = new Set()
    proc.collabAgentSummaries = new Map()
    proc.collabAgentWasActive = new Set()
    proc.sessionId = 'main-thread'
    proc.emit = (event: string, payload: unknown) => {
      events.push([event, payload])
      return true
    }
    return { proc, events }
  }

  test('child turn/completed does not emit main result (entry-level threadId filter)', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('turn/completed', {
      threadId: 'sub-thread',
      turn: { id: 'turn-sub', status: 'completed', durationMs: 1000 },
    })
    expect(events.filter(([e]) => e === 'result')).toHaveLength(0)
    // 主线程 turn 照常
    proc.handleNotification('turn/completed', {
      threadId: 'main-thread',
      turn: { id: 'turn-main', status: 'completed', durationMs: 2000 },
    })
    expect(events.filter(([e]) => e === 'result')).toHaveLength(1)
  })

  test('child agentMessage/delta does not emit assistant_text', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/agentMessage/delta', {
      threadId: 'sub-thread', turnId: 't', itemId: 'msg-sub', delta: '子agent输出',
    })
    expect(events.filter(([e]) => e === 'assistant_text')).toHaveLength(0)
    proc.handleNotification('item/agentMessage/delta', {
      threadId: 'main-thread', turnId: 't', itemId: 'msg-main', delta: '主线程正文',
    })
    expect(events.filter(([e]) => e === 'assistant_text')).toHaveLength(1)
  })

  test('child tokenUsage does not overwrite main-thread usage', () => {
    const { proc, events } = makeProc()
    proc.lastUsage = { total_tokens: 999 }
    proc.handleNotification('thread/tokenUsage/updated', {
      threadId: 'sub-thread', turnId: 't',
      tokenUsage: { last: { totalTokens: 1 }, total: { totalTokens: 2 } },
    })
    expect(events.filter(([e]) => e === 'token_usage')).toHaveLength(0)
    expect(proc.lastUsage.total_tokens).toBe(999)
  })

  test('systemError settles as failed; agentMessage text becomes settle summary', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: { type: 'subAgentActivity', id: 'sa', kind: 'started', agentThreadId: 'ag-e', agentPath: '/root/review' },
      threadId: 'main-thread', turnId: 't',
    })
    proc.handleNotification('item/completed', {
      item: { type: 'agentMessage', id: 'm1', text: '审查结论:发现 2 处问题' },
      threadId: 'ag-e', turnId: 't',
    })
    proc.handleNotification('thread/status/changed', { threadId: 'ag-e', status: { type: 'active' } })
    proc.handleNotification('thread/status/changed', { threadId: 'ag-e', status: { type: 'systemError' } })
    const settled = events.filter(([e]) => e === 'bg_task_settled')
    expect(settled).toEqual([['bg_task_settled', {
      task_id: 'ag-e', status: 'failed', summary: '审查结论:发现 2 处问题',
    }]])
  })

  test('authoritative agentsStates terminal corrects fallback completed into failed', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: { type: 'subAgentActivity', id: 'sa', kind: 'started', agentThreadId: 'ag-c', agentPath: '/root/x' },
      threadId: 'main-thread', turnId: 't',
    })
    // idle 兜底先结算成 completed
    proc.handleNotification('thread/status/changed', { threadId: 'ag-c', status: { type: 'active' } })
    proc.handleNotification('thread/status/changed', { threadId: 'ag-c', status: { type: 'idle' } })
    // 权威 agentsStates 随后带 errored → 墓碑纠正为 failed,不翻活
    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall', id: 'w', tool: 'wait', status: 'completed',
        agentsStates: { 'ag-c': { status: 'errored', message: 'boom' } },
      },
      threadId: 'main-thread', turnId: 't',
    })
    expect(events.filter(([e]) => e === 'bg_task_settled')).toHaveLength(1)
    const corrections = events.filter(([e, p]) => e === 'bg_task_updated' && (p as any).patch?.status === 'failed')
    expect(corrections).toHaveLength(1)
    expect((corrections[0][1] as any).patch.error).toBe('boom')
  })

  test('late subAgentActivity name patch does not revive a settled task', () => {
    const { proc, events } = makeProc()
    // spawn-first 占位
    proc.handleNotification('item/started', {
      item: {
        type: 'collabAgentToolCall', id: 'sp', tool: 'spawnAgent', status: 'inProgress',
        receiverThreadIds: ['ag-l'], agentsStates: { 'ag-l': { status: 'running', message: null } },
      },
      threadId: 'main-thread', turnId: 't',
    })
    // 结算
    proc.handleNotification('thread/status/changed', { threadId: 'ag-l', status: { type: 'active' } })
    proc.handleNotification('thread/status/changed', { threadId: 'ag-l', status: { type: 'idle' } })
    const settledBefore = events.filter(([e]) => e === 'bg_task_settled').length
    // 晚到的 subAgentActivity(started)带真名 —— 只改 map,不发 started(不复活)
    proc.handleNotification('item/started', {
      item: { type: 'subAgentActivity', id: 'sa-late', kind: 'started', agentThreadId: 'ag-l', agentPath: '/root/real_name' },
      threadId: 'main-thread', turnId: 't',
    })
    expect(events.filter(([e]) => e === 'bg_task_settled').length).toBe(settledBefore)
    const starteds = events.filter(([e]) => e === 'bg_task_started')
    expect(starteds.length).toBe(1) // 只有 spawn-first 那次
  })
})


// ═══════════════════════════════════════════════════════════════════════
// 以下为本地 fork 独有测试(合并保留):交付回执模型、D-11 委派、D3 输入、
// 外线程隔离、宽口径容量重试、本地 spawn/登录帮助函数锚。
// 上游同义测试保留在上方,不重复。
// ═══════════════════════════════════════════════════════════════════════

// ── 交付模型探针与 turn/start 回执(本地独有)──────────────────────────
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
  stdin: { write: (...args: any[]) => unknown; writable?: boolean },
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
    proc.write = () => null
    proc.request = (method: string, params: any) => {
      requests.push({ method, params })
      // 4185808:thread.path 成为 rollout 权威,init 响应必须带合法路径。
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 'thread-late-init', cwd: '/tmp', path: '/tmp/rollouts/thread-late-init.jsonl' } })
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
    proc.write = () => null

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

// ── collab 状态机 fork 叠加锚(cf41941)────────────────────────────────
describe('codex collab 状态机 fork 叠加锚(cf41941)', () => {
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
      ['subagent_step', { thread_id: 'sub-x', item_id: 'cmd-1', tool: 'Bash', phase: 'started', brief: 'bun test' }],
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

describe('buildCodexAppServerArgs', () => {
  test('no overrides → bare app-server on stdio', () => {
    expect(buildCodexAppServerArgs([])).toEqual(['app-server', '--listen', 'stdio://'])
  })
  test('allowDelegation === false → --disable multi_agent before --listen (fork D-11)', () => {
    expect(buildCodexAppServerArgs([], false)).toEqual([
      'app-server',
      '--disable', 'multi_agent',
      '--listen', 'stdio://',
    ])
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
    expect(params.config).toEqual({
      'tools.experimental_request_user_input.enabled': true,
      'features.default_mode_request_user_input': true,
      model_reasoning_effort: 'high',
    })
    // 单层委派(D-11 口径 3):allowDelegation === false 时 thread 级关闭 multi_agent。
    const delegated = Object.create(CodexProcess.prototype) as any
    delegated.opts = { workDir: '/tmp', effort: 'high', allowDelegation: false }
    expect(delegated.threadParams().config['features.multi_agent']).toBe(false)
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

function launchHarness(
  workDir: string,
  optsExtra: Record<string, unknown>,
  respond: (method: string, params: any) => any,
): {
  proc: any
  events: Array<[string, any]>
  requests: Array<{ method: string; params: any }>
} {
  const proc = Object.create(CodexProcess.prototype) as any
  const events: Array<[string, any]> = []
  const requests: Array<{ method: string; params: any }> = []
  proc.opts = { workDir, effort: 'high', ...optsExtra }
  // 构造器派生的只读字段:Object.create 不跑构造器,按同源派生补齐。
  proc.launchKind = (optsExtra as any).launch?.kind ?? 'fresh'
  proc.sessionId = null
  proc.pendingTurnStart = null
  proc.currentTurnId = null
  proc.lastUsage = null
  proc.conversationResumable = false
  proc.conversationRolloutPath = null
  proc.conversationMaterializationVerification = null
  proc.conversationMaterializationRetrySource = null
  proc.lastConversationMaterializationFailure = null
  proc.emittedImageGenerationIds = new Set()
  proc.primeRolloutImageGenerationScan = () => {}
  proc.write = () => null
  proc.emit = (event: string, payload: unknown) => {
    events.push([event, payload])
    return true
  }
  proc.request = (method: string, params: any) => {
    requests.push({ method, params })
    return Promise.resolve(respond(method, params))
  }
  return { proc, events, requests }
}

describe('codex ConversationLaunch 三分支映射(上游 ff44afb/4185808)', () => {
  const codexRef = (sessionId: string, cwd: string) =>
    ({ provider: 'codex', sessionId, cwd }) as const

  test('launch{kind:fresh} → thread/start(experimentalRawEvents/persistExtendedHistory 关)', async () => {
    const workDir = '/tmp'
    const { proc, requests } = launchHarness(workDir, { launch: { kind: 'fresh' } }, method => {
      if (method === 'initialize') return {}
      return { thread: { id: 'thread-new', cwd: workDir, path: `/rollouts/thread-new.jsonl` } }
    })

    await proc.initializeAndStartThread()

    const start = requests.find(r => r.method === 'thread/start')
    expect(start).toBeDefined()
    expect(start!.params.experimentalRawEvents).toBe(false)
    expect(start!.params.persistExtendedHistory).toBe(false)
    expect(start!.params.threadId).toBeUndefined()
    expect(requests.some(r => r.method === 'thread/resume' || r.method === 'thread/fork')).toBe(false)
    expect(proc.sessionId).toBe('thread-new')
    // fresh 线程仍是内存 id:materialization 确认前不可恢复(01-13 门控)。
    expect(proc.conversationResumable).toBe(false)
  })

  test('launch{kind:resume} → thread/resume {threadId=source.sessionId, excludeTurns:true}', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-launch-resume-'))
    try {
      const rollout = join(root, 'thread-src.jsonl')
      writeFileSync(rollout, '{"type":"turn_started"}\n')
      const { proc, requests } = launchHarness(
        root,
        { launch: { kind: 'resume', source: codexRef('thread-src', root) } },
        method => {
          if (method === 'initialize') return {}
          return { thread: { id: 'thread-src', cwd: root, path: rollout, turns: [] } }
        },
      )

      await proc.initializeAndStartThread()

      const resume = requests.find(r => r.method === 'thread/resume')
      expect(resume).toBeDefined()
      expect(resume!.params.threadId).toBe('thread-src')
      expect(resume!.params.excludeTurns).toBe(true)
      expect(resume!.params.persistExtendedHistory).toBe(false)
      expect(requests.some(r => r.method === 'thread/start' || r.method === 'thread/fork')).toBe(false)
      expect(proc.conversationResumable).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('launch{kind:fork,through} → thread/fork {threadId, lastTurnId, excludeTurns:true};无 through 不带 lastTurnId', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-launch-fork-'))
    try {
      const rollout = join(root, 'thread-forked.jsonl')
      writeFileSync(rollout, '{"type":"turn_started"}\n')
      const respond = (method: string) => {
        if (method === 'initialize') return {}
        return { thread: { id: 'thread-forked', cwd: root, path: rollout, turns: [] } }
      }
      const source = codexRef('thread-src', root)
      const through = { provider: 'codex', kind: 'turn', id: 'turn-9', source } as const

      const withThrough = launchHarness(root, { launch: { kind: 'fork', source, through } }, respond)
      await withThrough.proc.initializeAndStartThread()
      const fork = withThrough.requests.find(r => r.method === 'thread/fork')
      expect(fork).toBeDefined()
      expect(fork!.params.threadId).toBe('thread-src')
      expect(fork!.params.lastTurnId).toBe('turn-9')
      expect(fork!.params.excludeTurns).toBe(true)

      const fullFork = launchHarness(root, { launch: { kind: 'fork', source } }, respond)
      await fullFork.proc.initializeAndStartThread()
      const full = fullFork.requests.find(r => r.method === 'thread/fork')
      expect(full).toBeDefined()
      expect('lastTurnId' in full!.params).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('fork 返回 source thread id 时 throw(挂账 #7 源 id guard,错误文案含返回 id)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-fork-guard-'))
    try {
      const rollout = join(root, 'thread-src.jsonl')
      writeFileSync(rollout, '{"type":"turn_started"}\n')
      const source = codexRef('thread-src', root)
      const { proc } = launchHarness(root, { launch: { kind: 'fork', source } }, method => {
        if (method === 'initialize') return {}
        // app-server 违约:fork 未派生新 thread,返回了源 id。
        return { thread: { id: 'thread-src', cwd: root, path: rollout, turns: [] } }
      })

      await expect(proc.initializeAndStartThread()).rejects.toThrow(/thread-src/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('fork 过 materialization 验证门 → conversationResumable=true(launchKind!==fresh 门天然覆盖)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-fork-mat-'))
    try {
      const rollout = join(root, 'thread-forked.jsonl')
      writeFileSync(rollout, '{"type":"turn_started"}\n')
      const source = codexRef('thread-src', root)
      const { proc, requests } = launchHarness(root, { launch: { kind: 'fork', source } }, method => {
        if (method === 'initialize') return {}
        return { thread: { id: 'thread-forked', cwd: root, path: rollout, turns: [] } }
      })

      await proc.initializeAndStartThread()

      // fork materializes its own rollout before the RPC returns(上游注释):
      // verify(thread/read)后 resumable=true,可立即 persist 恢复绑定。
      expect(requests.some(r => r.method === 'thread/fork')).toBe(true)
      expect(requests.some(r => r.method === 'thread/read')).toBe(true)
      expect(proc.sessionId).toBe('thread-forked')
      expect(proc.conversationResumable).toBe(true)
      expect(proc.conversationRolloutPath).toBe(rollout)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

})

describe('validateConversationLaunch 五重校验(上游 ff44afb)', () => {
  const source = { provider: 'codex', sessionId: 'thread-src', cwd: '/work' } as const

  test('provider 不符 throw', () => {
    expect(() =>
      validateConversationLaunch({ kind: 'resume', source: { ...source, provider: 'claude' } as any }, 'codex'),
    ).toThrow(/provider mismatch/)
  })

  test('空 source id throw', () => {
    expect(() =>
      validateConversationLaunch({ kind: 'resume', source: { ...source, sessionId: '  ' } }, 'codex'),
    ).toThrow(/session id is empty/)
  })

  test('cwd 非绝对 throw', () => {
    expect(() =>
      validateConversationLaunch({ kind: 'resume', source: { ...source, cwd: 'relative/dir' } }, 'codex'),
    ).toThrow(/not absolute/)
  })

  test('cwd 与 expectedCwd 不一致 throw;legacy null cwd 缺失 throw', () => {
    expect(() =>
      validateConversationLaunch({ kind: 'resume', source }, 'codex', '/elsewhere'),
    ).toThrow(/cwd mismatch/)
    expect(() =>
      validateConversationLaunch({ kind: 'resume', source: { ...source, cwd: null } }, 'codex', '/work'),
    ).toThrow(/cwd is missing/)
  })

  test('through 归属错 throw;合法 fork launch 通过', () => {
    const through = { provider: 'codex', kind: 'turn', id: 'turn-1', source } as const
    expect(() =>
      validateConversationLaunch(
        { kind: 'fork', source: { ...source, sessionId: 'thread-other' }, through: through as any },
        'codex',
      ),
    ).toThrow(/does not match fork source/)
    expect(() =>
      validateConversationLaunch({ kind: 'fork', source, through: through as any }, 'codex', '/work'),
    ).not.toThrow()
  })
})

// ── checkpoint 本地清空点与 isForeignThread 外线程隔离(ff44afb 叠加锚)──
function checkpointHarness(workDir = '/tmp'): { proc: any; events: Array<[string, any]> } {
  const proc = Object.create(CodexProcess.prototype) as any
  const events: Array<[string, any]> = []
  proc.opts = { workDir, effort: 'high' }
  proc.sessionId = 'thread-ckpt'
  proc.currentTurnId = null
  proc.pendingTurnStart = null
  proc.lastUsage = null
  // materialization 已确认(01-13 链早退),聚焦 checkpoint 生命周期。
  proc.conversationResumable = true
  proc.emittedImageGenerationIds = new Set()
  proc.flushRolloutImageGenerations = () => {}
  proc.emit = (event: string, payload: unknown) => {
    events.push([event, payload])
    return true
  }
  return { proc, events }
}


describe('codex checkpoint fork 叠加锚(交付清空点与 isThread 隔离)', () => {
  test('sendUserText 建 delivery 处与 failTurnStart 均清空(清空点 2/3,陷阱 3 本地落点)', async () => {
    const fixture = pendingTurnStartFixture('thread-ckpt')

    // 清空点 2:建 delivery 即清(await 前)——turn/start 传输失败也会 emit result,
    // 失败不得复用上轮锚。
    fixture.proc.lastCompletedTurnId = 'stale-turn'
    const dispatch = fixture.proc.sendUserText('hello')
    expect(dispatch.kind).toBe('turn_start_pending')
    expect(fixture.proc.lastCompletedTurnId).toBeNull()

    // 清空点 3:failTurnStart 清空。
    fixture.proc.lastCompletedTurnId = 'stale-turn'
    fixture.rejectTurnStart(new Error('turn/start transport down'))
    const receipt = await receiptWithin(dispatch)
    expect(receipt.kind).toBe('rejected')
    expect(fixture.proc.lastCompletedTurnId).toBeNull()
    expect(fixture.resultEvents.at(-1)?.is_error).toBe(true)
  })

// GREEN 后叠加锚(本地独有):外线程事件不产生 checkpoint 副作用——
// isForeignThread 前置过滤(98bb01d)在 checkpoint 采集之前,子线程
// turn/completed 既不清空也不覆写主线程锚。
describe('codex checkpoint 外线程隔离(本地 isForeignThread 叠加锚)', () => {
  test('isForeignThread 的 turn/started|completed 不碰 lastCompletedTurnId', () => {
    const { proc } = checkpointHarness()

    proc.handleNotification('turn/started', { threadId: 'thread-ckpt', turn: { id: 'turn-1' } })
    proc.handleNotification('turn/completed', {
      threadId: 'thread-ckpt',
      turn: { id: 'turn-1', status: 'completed' },
    })
    expect(proc.lastCompletedTurnId).toBe('turn-1')

    proc.handleNotification('turn/completed', {
      threadId: 'child-thread',
      turn: { id: 'child-turn', status: 'completed' },
    })
    expect(proc.lastCompletedTurnId).toBe('turn-1')

    proc.handleNotification('turn/started', { threadId: 'child-thread', turn: { id: 'child-turn-2' } })
    expect(proc.lastCompletedTurnId).toBe('turn-1')
  })
})
})

function catalogHarness(
  workDir: string,
  respond: (method: string, params: any) => any,
): { proc: any; requests: Array<{ method: string; params: any }> } {
  const proc = Object.create(CodexProcess.prototype) as any
  const requests: Array<{ method: string; params: any }> = []
  proc.opts = { workDir, effort: 'high' }
  // 线程 handshake 已完成:catalog 前置(ensureCatalogReady)直接放行。
  proc.readyPromise = Promise.resolve()
  // 合并实现里 catalog 走 ensureInitialized()(initialize RPC + initialized 通知
  // write);write 契约:null = 成功。probe 不触碰真实 stdin。
  proc.write = () => null
  proc.request = (method: string, params: any) => {
    requests.push({ method, params })
    return Promise.resolve(respond(method, params))
  }
  return { proc, requests }
}

describe('codex thread/list 严格结构校验(fork 叠加锚)', () => {
  test('严格结构校验即 throw:cwd 不匹配 summary/invalid nextCursor/重复 cursor/无 data', async () => {
    const workDir = '/work'
    // cwd 不匹配条目 = invalid summary(请求已按 cwd 过滤,响应违约即 throw)。
    const mismatched = catalogHarness(workDir, () => ({
      data: [{ id: 't1', preview: 'p1', updatedAt: 1700000001, cwd: '/elsewhere' }],
      nextCursor: null,
    }))
    await expect(mismatched.proc.listConversations()).rejects.toThrow(/invalid thread summary/)

    const badCursor = catalogHarness(workDir, () => ({
      data: [{ id: 't1', preview: 'p1', updatedAt: 1700000001, cwd: workDir }],
      nextCursor: 42,
    }))
    await expect(badCursor.proc.listConversations()).rejects.toThrow(/invalid nextCursor/)

    const repeated = catalogHarness(workDir, () => ({
      data: [{ id: 't1', preview: 'p1', updatedAt: 1700000001, cwd: workDir }],
      nextCursor: 'cur-x',
    }))
    await expect(repeated.proc.listConversations()).rejects.toThrow(/repeated pagination cursor cur-x/)

    const noData = catalogHarness(workDir, () => ({}))
    await expect(noData.proc.listConversations()).rejects.toThrow(/no data array/)
  })
})

// ── 宽口径容量重试(fork WR-03,并入上游 2e6e1e0 引擎的 fork 锚点)──────
function forkCapacityHarness(respond?: (method: string, params: any) => any | Promise<any>) {
  let turn = 0
  const events: Array<[string, any]> = []
  const calls: Array<{ method: string; params: any }> = []
  const proc = Object.create(CodexProcess.prototype) as any
  proc.opts = { workDir: '/tmp', model: 'selected-model', effort: 'high' }
  proc.sessionId = 'capacity-thread'
  proc.alive = true
  proc.expectedExit = false
  proc.readyPromise = Promise.resolve()
  proc.conversationResumable = true
  proc.conversationRolloutPath = null
  proc.conversationMaterializationVerification = null
  proc.lastConversationMaterializationFailure = null
  proc.pendingTurnStart = null
  proc.currentTurnId = null
  proc.deliveryCounter = 0
  proc.turnStartGeneration = 0
  proc.lastUsage = null
  proc.lastCompletedTurnId = null
  proc.turnRetryTimer = null
  proc.turnRetryCount = 0
  proc.transientRetryCount = 0
  proc.turnRetryHasStarted = false
  proc.turnRetryEnabled = true
  proc.turnError = null
  proc.routingTimeoutTurnId = null
  proc.turnRetry = null
  proc.finishedTurnIds = new Set()
  proc.exitEventEmitted = false
  proc.emittedImageGenerationIds = new Set()
  proc.flushRolloutImageGenerations = () => {}
  proc.markConversationMaterialized = () => {}
  proc.emit = (event: string, payload: unknown) => {
    events.push([event, payload])
    return true
  }
  proc.request = async (method: string, params: any) => {
    calls.push({ method, params })
    if (!respond && method !== 'turn/start' && method !== 'turn/interrupt') {
      throw new Error(`unexpected request ${method}`)
    }
    const result = respond
      ? await respond(method, params)
      : method === 'turn/start'
        ? { turn: { id: `capacity-turn-${++turn}` } }
        : {}
    const turnId = result?.turn?.id
    if (method === 'turn/start' && typeof turnId === 'string' && turnId) {
      proc.handleNotification('turn/started', { threadId: 'capacity-thread', turn: { id: turnId } })
    }
    return result
  }
  proc.sendSignal = () => {}
  proc.waitForExit = async () => true
  return { proc, calls, events }
}

describe('codex model capacity recovery(fork 宽口径与交付锚)', () => {
  test('宽口径容量失败同样进入进程层退避重试', async () => {
    await withCapacityClock(async clock => {
      for (const message of [
        'serverOverloaded',
        'Upstream model is at capacity, please retry later',
        'Please try a different model',
      ]) {
        const { proc, events } = forkCapacityHarness()
        proc.sendUserText('do work')
        await flushCapacityMicrotasks()
        completeCapacityTurn(proc, { message })
        expect(events.filter(([event]) => event === 'result')).toEqual([])
        expect(proc.turnRetry).toMatchObject({ phase: 'waiting', attempt: 1, delayMs: 5_000, message })
        proc.sendInterrupt()
        await flushCapacityMicrotasks()
        expect(clock.timers.size).toBe(0)
      }
    })
  })

  test('turn/start 的宽口径容量拒绝也按原输入重试', async () => {
    await withCapacityClock(async clock => {
      let starts = 0
      const serverMessage = 'serverOverloaded'
      const { proc, calls, events } = forkCapacityHarness(method => {
        if (method !== 'turn/start') throw new Error(`unexpected request ${method}`)
        if (++starts === 1) throw new CodexRpcResponseError(method, 1, -32000, serverMessage)
        return { turn: { id: 'accepted-wide-retry' } }
      })
      proc.sendUserText('unaccepted task')
      await flushCapacityMicrotasks()
      expect(events.filter(([event]) => event === 'result')).toEqual([])
      await clock.tick()
      expect(calls[1]).toEqual(calls[0])
      completeCapacityTurn(proc, null)
      expect(events.filter(([event]) => event === 'result')).toHaveLength(1)
    })
  })

  test('interrupt during backoff cancels even an already-queued timer callback', async () => {
    await withCapacityClock(async clock => {
      const { proc, calls, events } = forkCapacityHarness()
      proc.sendUserText('do work')
      await flushCapacityMicrotasks()
      completeCapacityTurn(proc)
      const staleTimer = [...clock.timers.values()][0]!
      proc.sendInterrupt()
      expect(clock.timers.size).toBe(0)
      staleTimer.callback()
      await flushCapacityMicrotasks()
      expect(calls.filter(call => call.method === 'turn/start')).toHaveLength(1)
      expect(events.filter(([event]) => event === 'result')).toEqual([
        ['result', expect.objectContaining({ subtype: 'interrupted', checkpoint: null })],
      ])
    })
  })

  test('interrupt also cancels a retry awaiting its turn/start acknowledgement', async () => {
    await withCapacityClock(async clock => {
      let resolveRetry!: (value: any) => void
      let starts = 0
      const { proc, calls, events } = forkCapacityHarness(method => {
        if (method === 'turn/interrupt') return {}
        if (++starts === 1) return { turn: { id: 'first-turn' } }
        return new Promise(resolve => { resolveRetry = resolve })
      })
      proc.sendUserText('do work')
      await flushCapacityMicrotasks()
      completeCapacityTurn(proc)
      await clock.tick()
      proc.sendInterrupt()
      proc.sendInterrupt()
      resolveRetry({ turn: { id: 'cancelled-retry' } })
      await flushCapacityMicrotasks()
      expect(proc.currentTurnId).toBeNull()
      expect(calls.at(-1)).toEqual({
        method: 'turn/interrupt', params: { threadId: 'capacity-thread', turnId: 'cancelled-retry' },
      })
      proc.handleNotification('turn/completed', {
        threadId: 'capacity-thread',
        turn: { id: 'cancelled-retry', status: 'failed', error: { message: CAPACITY_MESSAGE } },
      })
      expect(events.filter(([event]) => event === 'result')).toHaveLength(1)
      expect(clock.timers.size).toBe(0)
    })
  })

  test('a synchronous stop at the retry progress event prevents the request from being sent', async () => {
    await withCapacityClock(async clock => {
      const { proc, calls, events } = forkCapacityHarness()
      const emit = proc.emit
      proc.emit = (event: string, payload: any) => {
        emit(event, payload)
        if (event === 'turn_retry' && payload.phase === 'retrying') proc.sendInterrupt()
        return true
      }
      proc.sendUserText('do work')
      await flushCapacityMicrotasks()
      completeCapacityTurn(proc)
      await clock.tick()
      expect(calls.filter(call => call.method === 'turn/start')).toHaveLength(1)
      expect(events.filter(([event]) => event === 'result')).toHaveLength(1)
    })
  })

  test('new input, native continuation, kill and OS exit all retire the waiting timer', async () => {
    await withCapacityClock(async clock => {
      for (const action of ['input', 'native', 'kill', 'exit']) {
        const { proc, calls, events } = forkCapacityHarness()
        proc.sendUserText('do work')
        await flushCapacityMicrotasks()
        completeCapacityTurn(proc)
        const staleTimer = [...clock.timers.values()][0]!
        if (action === 'input') proc.sendUserText('new instruction')
        if (action === 'native') proc.handleNotification('turn/started', {
          threadId: 'capacity-thread', turn: { id: 'native-continuation' },
        })
        if (action === 'kill') {
          proc.sendSignal = () => {}
          proc.waitForExit = async () => true
          await proc.kill()
        }
        if (action === 'exit') proc.handleChildExit(1, null)
        expect(clock.timers.size).toBe(0)
        staleTimer.callback()
        await flushCapacityMicrotasks()
        expect(calls.filter(call => call.method === 'turn/start')).toHaveLength(action === 'input' ? 2 : 1)
        if (action === 'native') {
          expect(proc.currentTurnId).toBe('native-continuation')
          expect(events.filter(([event]) => event === 'turn_retry').at(-1)?.[1].phase).toBe('retrying')
        }
      }
    })
  })

  test('child-thread and stale capacity errors cannot turn an unrelated failure into a retry', async () => {
    await withCapacityClock(async clock => {
      const { proc, events } = forkCapacityHarness()
      proc.sendUserText('do work')
      await flushCapacityMicrotasks()
      for (const [threadId, turnId] of [['child-thread', proc.currentTurnId], ['capacity-thread', 'old-turn']]) {
        proc.handleNotification('error', { threadId, turnId, error: { message: CAPACITY_MESSAGE }, willRetry: false })
        proc.handleNotification('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error: { message: CAPACITY_MESSAGE } } })
      }
      proc.handleNotification('turn/completed', {
        threadId: 'capacity-thread', turn: { id: proc.currentTurnId, status: 'failed' },
      })
      expect(clock.timers.size).toBe(0)
      expect(events.filter(([event]) => event === 'result')).toHaveLength(1)
    })
  })

  test('容量拒绝先结算交付再排重试(本地交付模型,session await 不悬挂)', async () => {
    await withCapacityClock(async clock => {
      const { proc } = forkCapacityHarness(method => {
        if (method !== 'turn/start') throw new Error(`unexpected request ${method}`)
        throw new CodexRpcResponseError(method, 1, -32000, CAPACITY_MESSAGE)
      })
      let pendingStartAtFirstRetry: unknown = 'unset'
      const emit = proc.emit
      proc.emit = (event: string, payload: any) => {
        if (event === 'turn_retry' && payload.phase === 'waiting') {
          // settle 先于重试排定:容量分支先按 ack 结算并清空 pendingTurnStart,
          // 才调用 scheduleCapacityRetry 并同步 emit turn_retry。
          pendingStartAtFirstRetry = proc.pendingTurnStart
        }
        return emit(event, payload)
      }
      const dispatch = proc.sendUserText('local task') as any
      expect(dispatch.kind).toBe('turn_start_pending')
      const settlement = await dispatch.settlement
      expect(settlement).toMatchObject({ kind: 'ack', turnId: null, deliveryId: dispatch.deliveryId })
      expect(pendingStartAtFirstRetry).toBeNull()
      expect(proc.turnRetry).toMatchObject({ phase: 'waiting', attempt: 1, message: CAPACITY_MESSAGE })
      expect(clock.timers.size).toBe(1)
    })
  })
})
