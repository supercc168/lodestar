import { describe, expect, mock, test } from 'bun:test'

mock.module('./config', () => ({
  config: {
    claude: {
      env: {},
      models: {
        glm: {
          model: 'glm-5.2[1m]',
          base_url: 'https://open.bigmodel.cn/api/anthropic',
          auth_token: 'glm-tok',
          effort: 'xhigh',
          env: {
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2[1m]',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5-turbo',
            ANTHROPIC_DEFAULT_FABLE_MODEL: 'glm-5.2[1m]',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5-turbo',
          },
        },
      },
    },
    codex: { env: {}, models: {} },
  },
}))

const { claudeModelEnv, claudeModelIsApiRoute } = await import('./claude-models')

describe('claudeModelEnv per-档位 env 注入', () => {
  test('GLM 档位注入别名映射 + base_url/token', () => {
    const env = claudeModelEnv('claude:glm')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('glm-tok')
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.2[1m]')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5-turbo')
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('glm-5.2[1m]')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5-turbo')
  })

  test('官方登录档位不注入任何 env(零污染)', () => {
    expect(claudeModelEnv('claude:opus')).toEqual({})
    expect(claudeModelEnv('claude:fable')).toEqual({})
    expect(claudeModelIsApiRoute('claude:opus')).toBe(false)
    expect(claudeModelIsApiRoute('claude:glm')).toBe(true)
  })
})
