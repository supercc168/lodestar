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
  ClaudeAgentProcess,
} = await import('./claude-agent-process')
const {
  resolveClaudeModelEnv,
  resolveClaudeSdkModel,
} = await import('./claude-models')

describe('Claude model profiles', () => {
  test('maps GLM and DeepSeek profiles to SDK model and env tiers', () => {
    expect(resolveClaudeSdkModel('claude:glm')).toBe('sonnet')
    expect(resolveClaudeModelEnv('claude:glm')).toEqual({
      OMC_MODEL_HIGH: '5.2',
      OMC_MODEL_MEDIUM: '5.2',
      OMC_MODEL_LOW: '4.7',
      ANTHROPIC_DEFAULT_OPUS_MODEL: '5.2',
      ANTHROPIC_DEFAULT_SONNET_MODEL: '5.2',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: '4.7',
    })

    expect(resolveClaudeSdkModel('claude:deepseek')).toBe('sonnet')
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
