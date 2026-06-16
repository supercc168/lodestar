import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, mock, test } from 'bun:test'

mock.module('./config', () => ({
  config: {
    claude: {
      env: {},
      models: {},
    },
  },
}))

const {
  buildClaudeSpawnPath,
  ClaudeAgentProcess,
} = await import('./claude-agent-process')
const {
  resolveClaudeModelEnv,
  resolveClaudeSdkModel,
} = await import('./claude-models')

describe('Claude model profiles', () => {
  test('keeps npm-global, local bins, and existing PATH in Claude spawn PATH', () => {
    if (process.platform === 'win32') return
    const originalPath = process.env.PATH
    try {
      process.env.PATH = ['/opt/custom/bin', '/usr/bin'].join(delimiter)
      const entries = buildClaudeSpawnPath().split(delimiter)

      expect(entries).toContain(join(homedir(), '.local', 'npm-global', 'bin'))
      expect(entries).toContain(join(homedir(), '.local', 'bin'))
      expect(entries).toContain('/opt/custom/bin')
      expect(entries.filter(entry => entry === '/usr/bin')).toHaveLength(1)
    } finally {
      process.env.PATH = originalPath
    }
  })

  test('maps GLM and DeepSeek profiles to SDK model and env tiers', () => {
    expect(resolveClaudeSdkModel('claude:default')).toBe('opus')
    expect(resolveClaudeSdkModel('claude:glm')).toBe('opus')
    expect(resolveClaudeModelEnv('claude:glm')).toEqual({
      OMC_MODEL_HIGH: '5.2',
      OMC_MODEL_MEDIUM: '5.2',
      OMC_MODEL_LOW: '4.7',
      ANTHROPIC_DEFAULT_OPUS_MODEL: '5.2',
      ANTHROPIC_DEFAULT_SONNET_MODEL: '5.2',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: '4.7',
    })

    expect(resolveClaudeSdkModel('claude:deepseek')).toBe('opus')
    expect(resolveClaudeModelEnv('claude:deepseek')).toEqual({
      OMC_MODEL_HIGH: 'DeepSeekv4pro',
      OMC_MODEL_MEDIUM: 'v4pro',
      OMC_MODEL_LOW: 'v4flash',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'DeepSeekv4pro',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'v4pro',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'v4flash',
    })
  })
})

describe('Claude user dialog bridge', () => {
  test('uses session_state_changed running as turn start boundary', () => {
    const proc = new ClaudeAgentProcess({
      workDir: '/tmp',
      effort: 'high',
    }) as any
    const inits: any[] = []
    const started: any[] = []
    proc.on('init', (event: any) => inits.push(event))
    proc.on('turn_started', (event: any) => started.push(event))

    proc.handleMessage({
      type: 'system',
      subtype: 'init',
      uuid: 'init-1',
      session_id: 'claude-session-1',
      model: 'sonnet',
    })
    expect(inits).toHaveLength(1)
    expect(started).toEqual([])

    proc.handleMessage({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'running',
      uuid: 'turn-1',
      session_id: 'claude-session-1',
    })
    proc.handleMessage({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'requires_action',
      uuid: 'turn-1-permission',
      session_id: 'claude-session-1',
    })
    proc.handleMessage({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'running',
      uuid: 'turn-1-resumed',
      session_id: 'claude-session-1',
    })
    expect(started).toEqual([{ turn_id: 'turn-1', thread_id: 'claude-session-1' }])

    proc.handleMessage({
      type: 'result',
      subtype: 'success',
      uuid: 'result-1',
      session_id: 'claude-session-1',
      is_error: false,
      duration_ms: 10,
      num_turns: 1,
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {},
    })
    proc.handleMessage({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'running',
      uuid: 'turn-2',
      session_id: 'claude-session-1',
    })
    expect(started).toEqual([
      { turn_id: 'turn-1', thread_id: 'claude-session-1' },
      { turn_id: 'turn-2', thread_id: 'claude-session-1' },
    ])
  })

  test('routes askUserQuestion dialog through AskUserQuestion permission flow', async () => {
    const proc = new ClaudeAgentProcess({
      workDir: '/tmp',
      effort: 'high',
    }) as any
    const toolUses: any[] = []
    const permissions: any[] = []
    proc.on('tool_use', (event: any) => toolUses.push(event))
    proc.on('can_use_tool', (event: any) => {
      permissions.push(event)
      proc.sendPermissionResponse(event.request_id, 'allow', {
        updatedInput: {
          ...event.input,
          answers: { 'Pick one?': 'A' },
        },
      })
    })

    const abortController = new AbortController()
    const resultPromise = proc.onUserDialog({
      dialogKind: 'askUserQuestion',
      toolUseID: 'tool_dialog_1',
      payload: {
        question: 'Pick one?',
        options: ['A', 'B'],
      },
    }, { signal: abortController.signal })

    expect(toolUses).toEqual([{
      id: 'tool_dialog_1',
      name: 'AskUserQuestion',
      input: {
        question: 'Pick one?',
        options: ['A', 'B'],
        questions: [{
          question: 'Pick one?',
          options: [{ label: 'A' }, { label: 'B' }],
        }],
      },
    }])
    expect(permissions).toHaveLength(1)
    expect(permissions[0].tool_name).toBe('AskUserQuestion')
    expect(permissions[0].tool_use_id).toBe('tool_dialog_1')

    await expect(resultPromise).resolves.toEqual({
      behavior: 'completed',
      result: { 'Pick one?': 'A' },
    })
  })
})

describe('Claude token accounting', () => {
  test('accumulates per-result usage when modelUsage totals are absent', () => {
    const proc = new ClaudeAgentProcess({
      workDir: '/tmp',
      effort: 'high',
    }) as any
    const usageEvents: any[] = []
    proc.on('token_usage', (event: any) => usageEvents.push(event))

    proc.handleMessage({
      type: 'result',
      subtype: 'success',
      uuid: 'result-1',
      session_id: 'claude-session-1',
      is_error: false,
      duration_ms: 10,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 2 },
      modelUsage: {},
    })
    proc.handleMessage({
      type: 'result',
      subtype: 'success',
      uuid: 'result-2',
      session_id: 'claude-session-1',
      is_error: false,
      duration_ms: 12,
      num_turns: 1,
      usage: {
        input_tokens: 7,
        output_tokens: 1,
        cache_creation_input_tokens: 1,
        cache_read_input_tokens: 3,
      },
      modelUsage: {},
    })

    expect(usageEvents).toHaveLength(2)
    expect(usageEvents[0].usage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
    })
    expect(usageEvents[0].totalUsage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
    })
    expect(usageEvents[1].usage).toEqual({
      input_tokens: 7,
      output_tokens: 1,
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 3,
      total_tokens: 12,
    })
    expect(usageEvents[1].totalUsage).toEqual({
      input_tokens: 17,
      output_tokens: 3,
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 3,
      total_tokens: 24,
    })
    expect(proc.lastTotalUsage).toEqual(usageEvents[1].totalUsage)
  })

  test('uses modelUsage as authoritative cumulative totals when present', () => {
    const proc = new ClaudeAgentProcess({
      workDir: '/tmp',
      effort: 'high',
    }) as any
    const usageEvents: any[] = []
    proc.on('token_usage', (event: any) => usageEvents.push(event))

    proc.handleMessage({
      type: 'result',
      subtype: 'success',
      uuid: 'result-1',
      session_id: 'claude-session-1',
      is_error: false,
      duration_ms: 10,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 2 },
      modelUsage: {
        opus: {
          inputTokens: 100,
          outputTokens: 20,
          cacheCreationInputTokens: 5,
          cacheReadInputTokens: 30,
          contextWindow: 200000,
          costUSD: 0.25,
        },
      },
    })
    expect(proc.lastResult.cost_delta_usd).toBeCloseTo(0.25)
    proc.handleMessage({
      type: 'result',
      subtype: 'success',
      uuid: 'result-2',
      session_id: 'claude-session-1',
      is_error: false,
      duration_ms: 12,
      num_turns: 1,
      usage: { input_tokens: 4, output_tokens: 1 },
      modelUsage: {
        glm: {
          input_tokens: 130,
          output_tokens: 25,
          cache_creation_input_tokens: 8,
          cache_read_input_tokens: 40,
          context_window: 258000,
          cost_usd: 0.31,
        },
      },
    })

    expect(usageEvents[0].usage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
    })
    expect(usageEvents[0].totalUsage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      reasoning_output_tokens: 0,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 30,
      total_tokens: 155,
    })
    expect(usageEvents[0].contextWindow).toBe(200000)

    expect(usageEvents[1].usage).toEqual({
      input_tokens: 4,
      output_tokens: 1,
      total_tokens: 5,
    })
    expect(usageEvents[1].totalUsage).toEqual({
      input_tokens: 130,
      output_tokens: 25,
      reasoning_output_tokens: 0,
      cache_creation_input_tokens: 8,
      cache_read_input_tokens: 40,
      total_tokens: 203,
    })
    expect(usageEvents[1].contextWindow).toBe(258000)
    expect(proc.lastResult.cost_delta_usd).toBeCloseTo(0.06)
  })
})
