import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { config } from './config'
import {
  claudeModelConfigured,
  claudeModelEffort,
  claudeModelEnv,
  claudeModelIsApiRoute,
} from './claude-models'

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

// Grok 走 wuhen-ai 的 Anthropic 兼容端点,与 GLM 同为第三方 API 路由,但 tier
// 映射 + CLAUDE_CODE_* flag 全部经 config env_* 注入(代码无 grok 专用默认,
// 不像 glm 有 DEFAULT_GLM_ENV 硬编码)。此处复刻 GLM 的 config 隔离范式。
describe('grok 档位(wuhen-ai 第三方 Anthropic 兼容路由)', () => {
  let prevGrok: unknown

  beforeEach(() => {
    prevGrok = config.claude.models.grok
    ;(config.claude as any).models.grok = {
      model: 'grok-4.5',
      base_url: 'https://api.wuhen-ai.com',
      auth_token: 'grok-tok',
      effort: 'xhigh',
      env: {
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
        ANTHROPIC_DEFAULT_FABLE_MODEL: 'grok-4.5',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'grok-4.5',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'grok-4.5',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'grok-4.5',
      },
    }
  })

  afterEach(() => {
    ;(config.claude as any).models.grok = prevGrok
  })

  test('grok 档位注入 base_url + auth_token + tier 映射 + CLAUDE_CODE_* flag', () => {
    expect(claudeModelIsApiRoute('claude:grok')).toBe(true)
    expect(claudeModelConfigured('claude:grok')).toBe(true)
    expect(claudeModelEffort('claude:grok')).toBe('xhigh')
    const env = claudeModelEnv('claude:grok')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.wuhen-ai.com')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('grok-tok')
    // 四档 tier 别名全指 grok-4.5,防止 Claude Code 辅助调用打到官方 claude id
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('grok-4.5')
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('grok-4.5')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('grok-4.5')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('grok-4.5')
    // 关掉非必要流量与 attribution 头(第三方端点不需要)
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0')
  })

  test('grok 未配 token → 未配置、env 为空(route 仍为 api,被 picker 拦截)', () => {
    ;(config.claude as any).models.grok = {} // 仅 DEFAULT_CLAUDE_MODELS 提供 route:'api'
    expect(claudeModelIsApiRoute('claude:grok')).toBe(true)
    expect(claudeModelConfigured('claude:grok')).toBe(false)
    expect(claudeModelEnv('claude:grok')).toEqual({})
  })
})

// grokcc 是第二个 grok 渠道(CatCodex / catcodexapi,new-api 网关),与 grok
// (wuhen)同构。复刻 grok 的 config 隔离范式验证 env 注入与未配置态。
describe('grokcc 档位(CatCodex catcodexapi 第三方 Anthropic 兼容路由)', () => {
  let prevGrokcc: unknown

  beforeEach(() => {
    prevGrokcc = config.claude.models.grokcc
    ;(config.claude as any).models.grokcc = {
      model: 'grok-4.5',
      base_url: 'https://catcodexapi.com',
      auth_token: 'grokcc-tok',
      effort: 'xhigh',
      env: {
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
        ANTHROPIC_DEFAULT_FABLE_MODEL: 'grok-4.5',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'grok-4.5',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'grok-4.5',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'grok-4.5',
      },
    }
  })

  afterEach(() => {
    ;(config.claude as any).models.grokcc = prevGrokcc
  })

  test('grokcc 档位注入 base_url + auth_token + tier 映射 + CLAUDE_CODE_* flag', () => {
    expect(claudeModelIsApiRoute('claude:grokcc')).toBe(true)
    expect(claudeModelConfigured('claude:grokcc')).toBe(true)
    expect(claudeModelEffort('claude:grokcc')).toBe('xhigh')
    const env = claudeModelEnv('claude:grokcc')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://catcodexapi.com')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('grokcc-tok')
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('grok-4.5')
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('grok-4.5')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('grok-4.5')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('grok-4.5')
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0')
  })

  test('grokcc 未配 token → 未配置、env 为空(route 仍为 api)', () => {
    ;(config.claude as any).models.grokcc = {}
    expect(claudeModelIsApiRoute('claude:grokcc')).toBe(true)
    expect(claudeModelConfigured('claude:grokcc')).toBe(false)
    expect(claudeModelEnv('claude:grokcc')).toEqual({})
  })
})
