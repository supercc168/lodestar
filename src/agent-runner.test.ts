import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { AgentWorkerFailure, collectAgentTurn, startAgentWorker } from './agent-runner'
import { rememberAgentSession, isAgentSession, resetAgentSessionRegistryForTest } from './agent-session-registry'

class FakeProcess extends EventEmitter {
  provider = 'claude' as const
  sessionId: string | null = 'sid-1'
  lastAssistantUuid: string | null = 'checkpoint-1'
  lastCompletedTurnId = null
  lastModel = 'GLM-5.3'
  lastEffort = 'max' as const
  lastUsage = null
  lastTotalUsage = null
  lastResult = { subtype: 'success', is_error: false } as any
  lastContextWindow = null
  lastContextTokens = null
  alive = true
  initialized = false
  prompts: string[] = []
  permissionResponses: any[] = []

  sendInitialize() { this.initialized = true }
  sendUserText(text: string) { this.prompts.push(text) }
  sendPermissionResponse(...args: any[]) { this.permissionResponses.push(args) }
  sendHookResponse() {}
  async kill() { this.alive = false; this.emit('exit', { code: 0, signal: null, expected: true }) }
  isAlive() { return this.alive }
}

describe('full delegated Agent runner', () => {
  // D-14:30 分钟会话超时与 2M 输出上限已删,容量退避只报进度、不布防看门狗。
  test('capacity backoff reports progress and stays out of the agent output', async () => {
    const proc = new FakeProcess() as any
    proc.provider = 'codex'
    const progress: any[] = []
    const handle = collectAgentTurn(proc, 'do work', { onProgress: step => progress.push(step) }, () => {})
    const retry = { phase: 'waiting', attempt: 1, delayMs: 60_000, message: 'Selected model is at capacity' }
    proc.emit('turn_retry', retry)
    expect(progress.at(-1).detail).toContain(retry.message)
    expect(progress.at(-1).detail).toContain('60s 后重试 #1')
    proc.emit('turn_retry', { ...retry, phase: 'retrying', delayMs: 0 })
    expect(progress.at(-1).detail).toBe('正在重试 #1')
    proc.emit('assistant_text', { text: 'finished', parentToolUseId: null })
    proc.emit('result', { is_error: false })
    await expect(handle.done).resolves.toMatchObject({ output: 'finished', outputTruncated: false })
    expect(proc.listenerCount('turn_retry')).toBe(0)
  })

  test('no longer truncates output at a fixed cap', async () => {
    const proc = new FakeProcess() as any
    const handle = collectAgentTurn(proc, 'long', {}, () => {})
    const chunk = 'x'.repeat(700_000)
    for (let i = 0; i < 3; i++) proc.emit('assistant_text', { text: chunk, parentToolUseId: null })
    proc.emit('result', { is_error: false })
    const result = await handle.done
    expect(result.output.length).toBe(2_100_000)
    expect(result.outputTruncated).toBe(false)
    expect(result.output).not.toContain('truncated at')
  })

  test('failure preserves output produced before the error', async () => {
    const proc = new FakeProcess() as any
    const handle = collectAgentTurn(proc, 'fail late', {}, () => {})
    proc.emit('assistant_text', { text: '已完成一半的正文', parentToolUseId: null })
    proc.emit('result', { is_error: true, error: 'exit code=1' })
    const failure = await handle.done.then(() => null, error => error)
    expect(failure).toBeInstanceOf(AgentWorkerFailure)
    expect(failure.name).toBe('AgentWorkerFailure')
    expect(failure.message).toContain('exit code=1')
    expect(failure.output).toBe('已完成一半的正文')
    expect(failure.sessionId).toBe('sid-1')
  })

  test('cancel preserves output produced before cancellation', async () => {
    const proc = new FakeProcess() as any
    const handle = collectAgentTurn(proc, 'cancel late', {}, () => {})
    proc.emit('assistant_text', { text: '部分结果', parentToolUseId: null })
    const cancelling = handle.cancel('stop now')
    const failure = await handle.done.then(() => null, error => error)
    expect(failure).toBeInstanceOf(AgentWorkerFailure)
    expect(failure.message).toBe('stop now')
    expect(failure.output).toBe('部分结果')
    await cancelling
  })

  test('handle exposes isAlive for cancel-after-settle decisions', async () => {
    const proc = new FakeProcess() as any
    const handle = collectAgentTurn(proc, 'alive', {}, () => {})
    expect(handle.isAlive?.()).toBe(true)
    proc.emit('result', { is_error: false })
    await handle.done
    expect(handle.isAlive?.()).toBe(false)
  })

  test('auto-allows ordinary permissions but pauses and resumes exact input requests', async () => {
    const proc = new FakeProcess() as any
    const waiting: any[] = []
    const progress: any[] = []
    const handle = collectAgentTurn(proc, 'do work', {
      onNeedsInput: request => waiting.push(request),
      onProgress: step => progress.push(step),
    }, () => {})
    expect(proc.initialized).toBe(true)
    expect(proc.prompts).toEqual(['do work'])

    proc.emit('can_use_tool', { request_id: 'perm', tool_name: 'Bash', input: { command: 'touch x' } })
    expect(proc.permissionResponses[0]).toEqual(['perm', 'allow', { updatedInput: { command: 'touch x' } }])
    proc.emit('tool_use', { name: 'Bash', input: { command: 'cat .env', token: 'secret' } })
    proc.emit('tool_result', { content: 'API_KEY=secret', is_error: false })
    expect(progress.map(step => step.detail)).toEqual(['', ''])

    proc.emit('can_use_tool', {
      request_id: 'ask', tool_name: 'AskUserQuestion', tool_use_id: 'tool-1',
      input: { questions: [{ id: 'q1', question: 'Proceed?', options: [{ label: 'Yes' }] }] },
    })
    expect(waiting[0]).toMatchObject({ requestId: 'ask', questions: [{ id: 'q1', question: 'Proceed?' }] })
    handle.answer('ask', { q1: 'Yes' })
    expect(proc.permissionResponses[1]).toEqual([
      'ask', 'allow',
      { updatedInput: { questions: [{ id: 'q1', question: 'Proceed?', options: [{ label: 'Yes' }] }], answers: { q1: 'Yes' } } },
    ])

    proc.emit('assistant_text', { text: 'finished', parentToolUseId: null })
    proc.emit('result', { is_error: false, checkpoint: { id: 'checkpoint-1' } })
    await expect(handle.done).resolves.toMatchObject({ output: 'finished', sessionId: 'sid-1', checkpointId: 'checkpoint-1' })
  })

  test('pauses on request_user_input the same way as AskUserQuestion', async () => {
    const proc = new FakeProcess() as any
    const waiting: any[] = []
    collectAgentTurn(proc, 'ask', {
      onNeedsInput: request => waiting.push(request),
    }, () => {})
    proc.emit('can_use_tool', {
      request_id: 'rui',
      tool_name: 'request_user_input',
      input: { questions: [{ id: 'q1', question: 'Continue?' }] },
    })
    expect(waiting[0]).toMatchObject({ requestId: 'rui', questions: [{ id: 'q1', question: 'Continue?' }] })
  })

  test('treats a successful file-only turn with no assistant text as completed', async () => {
    const proc = new FakeProcess() as any
    const handle = collectAgentTurn(proc, 'edit files', {}, () => {})
    proc.emit('result', { is_error: false, checkpoint: { id: 'checkpoint-1' } })
    await expect(handle.done).resolves.toMatchObject({ output: '', sessionId: 'sid-1' })
  })

  test('fails closed when the native session id is missing', async () => {
    const proc = new FakeProcess() as any
    proc.sessionId = null
    const handle = collectAgentTurn(proc, 'no id', {}, () => {})
    proc.emit('assistant_text', { text: '有正文但无会话号', parentToolUseId: null })
    proc.emit('result', { is_error: false })
    const failure = await handle.done.then(() => null, error => error)
    expect(failure).toBeInstanceOf(AgentWorkerFailure)
    expect(failure.message).toMatch(/without a native session id/)
    expect(failure.output).toBe('有正文但无会话号')
    expect(failure.sessionId).toBeNull()
  })

  test('dsh 会话与 codex 同样用 lastCompletedTurnId 作 fork 锚点', async () => {
    const proc = new FakeProcess() as any
    proc.provider = 'dsh'
    proc.sessionId = 'dsh-session-1'
    proc.lastAssistantUuid = null
    proc.lastCompletedTurnId = 'dsh-event-7'
    const handle = collectAgentTurn(proc, 'do work', {}, () => {})
    proc.emit('result', { is_error: false })
    await expect(handle.done).resolves.toMatchObject({ checkpointId: 'dsh-event-7' })
  })

  test('rejects unsupported effort before launch', () => {
    expect(() => startAgentWorker({
      identity: {
        id: 'agent:a',
        displayName: 'A',
        tokenSourceId: 'claude:fable',
        tokenSourceDisplay: 'A',
        provider: 'claude',
        model: 'claude:fable',
        modelDisplay: 'fable',
        defaultEffort: 'max',
        supportedEfforts: ['max'],
        sourceDefault: true,
        status: 'ready',
      },
      effort: 'low',
      workDir: '/tmp',
      prompt: 'nope',
      hostEnv: {},
    })).toThrow(/does not support effort low/)
  })
})

describe('agent session registry', () => {
  test('rememberAgentSession writes provider:id and rejects empty ids', () => {
    resetAgentSessionRegistryForTest()
    rememberAgentSession('claude', 'sid-claude')
    rememberAgentSession('codex', 'sid-codex')
    expect(isAgentSession('claude', 'sid-claude')).toBe(true)
    expect(isAgentSession('codex', 'sid-codex')).toBe(true)
    expect(isAgentSession('claude', 'sid-codex')).toBe(false)
    expect(() => rememberAgentSession('claude', '  ')).toThrow(/session id is empty/)
  })
})
