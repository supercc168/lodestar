import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { config } from './config'
import { claudeModelEnv, claudeModelIsApiRoute } from './claude-models'

// 固定的 GLM 测试档位(不依赖宿主 config.toml,保证测试确定性)。
// 注意:不用 mock.module('./config')。bun 的模块 mock 无法被 mock.restore() 撤销,
// 在显式多文件同批运行(如 `bun test a.test.ts b.test.ts`)时会泄漏到同作用域其他
// 文件 —— config.test.ts 真实 import './config' 的 parseClaudeModelProfile 会因此
// 拿到本文件 mock 后的残缺对象而抛 SyntaxError。这里与 claude-agent-process.test.ts
// 保持一致:直接改真实 config 单例的 glm 档位,afterEach 原样恢复。
const GLM_FULL = {
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
}

describe('claudeModelEnv per-档位 env 注入', () => {
  let prevGlm: unknown

  beforeEach(() => {
    prevGlm = config.claude.models.glm
    ;(config.claude as any).models.glm = { ...GLM_FULL, env: { ...GLM_FULL.env } }
  })

  afterEach(() => {
    ;(config.claude as any).models.glm = prevGlm
  })

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
    ;(config.claude as any).models.glm = {
      model: 'glm-5.2[1m]',
      base_url: 'https://open.bigmodel.cn/api/anthropic',
      auth_token: 'glm-tok',
      effort: 'xhigh',
      // 无 env_* —— 应回落代码内置默认
    }
    const env = claudeModelEnv('claude:glm')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic')
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.2[1m]')
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('glm-5.2[1m]')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5-turbo')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5-turbo')
  })

  test('glm 档位 config 显式配某 env_* → 仅覆盖该 key,其余用默认', () => {
    ;(config.claude as any).models.glm = {
      model: 'glm-5.2[1m]',
      base_url: 'https://open.bigmodel.cn/api/anthropic',
      auth_token: 'glm-tok',
      env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.6' }, // 只覆盖 opus
    }
    const env = claudeModelEnv('claude:glm')
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-4.6') // config 覆盖
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5-turbo') // 默认
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('glm-5.2[1m]') // 默认
  })
})
