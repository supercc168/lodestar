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
const { config } = await import('./config')

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

  test('glm 档位 config 未配 env_* → 用内置默认最强组合', () => {
    const prevGlm = config.claude.models.glm
    ;(config.claude as any).models.glm = {
      model: 'glm-5.2[1m]',
      base_url: 'https://open.bigmodel.cn/api/anthropic',
      auth_token: 'glm-tok',
      effort: 'xhigh',
      // 无 env_* —— 应回落代码内置默认
    }
    try {
      const env = claudeModelEnv('claude:glm')
      expect(env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic')
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.2[1m]')
      expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('glm-5.2[1m]')
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5-turbo')
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5-turbo')
    } finally {
      ;(config.claude as any).models.glm = prevGlm
    }
  })

  test('glm 档位 config 显式配某 env_* → 仅覆盖该 key,其余用默认', () => {
    const prevGlm = config.claude.models.glm
    ;(config.claude as any).models.glm = {
      model: 'glm-5.2[1m]',
      base_url: 'https://open.bigmodel.cn/api/anthropic',
      auth_token: 'glm-tok',
      env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.6' }, // 只覆盖 opus
    }
    try {
      const env = claudeModelEnv('claude:glm')
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-4.6') // config 覆盖
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5-turbo') // 默认
      expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('glm-5.2[1m]') // 默认
    } finally {
      ;(config.claude as any).models.glm = prevGlm
    }
  })
})
