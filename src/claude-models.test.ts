import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { config } from './config'
import {
  claudeModelConfigured,
  claudeModelEffort,
  claudeModelEnv,
  claudeModelIsApiRoute,
  claudeModelIsGrok,
  claudeModelTierEnv,
} from './claude-models'

// 固定的 GLM 测试档位(不依赖宿主 config.toml,保证测试确定性)。
// 注意:不用 mock.module('./config')。bun 的模块 mock 无法被 mock.restore() 撤销,
// 在显式多文件同批运行(如 `bun test a.test.ts b.test.ts`)时会泄漏到同作用域其他
// 文件 —— config.test.ts 真实 import './config' 的 parseClaudeModelProfile 会因此
// 拿到本文件 mock 后的残缺对象而抛 SyntaxError。这里与 claude-agent-process.test.ts
// 保持一致:直接改真实 config 单例的 glm 档位,afterEach 原样恢复。
const GLM_FULL = {
  model: 'glm-5.3',
  base_url: 'https://open.bigmodel.cn/api/anthropic',
  auth_token: 'glm-tok',
  effort: 'max',
  env: {
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5-turbo',
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'glm-5.3',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5-turbo',
  },
}

const GROK_FULL = {
  grok: {
    model: 'grok-4.6',
    base_url: 'https://api.wuhen-ai.com',
    auth_token: 'grok-token',
    effort: 'xhigh',
  },
  grokcc: {
    model: 'grok-4.6',
    base_url: 'https://catcodexapi.com',
    auth_token: 'grokcc-token',
    effort: 'xhigh',
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
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.3')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.3')
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('glm-5.3')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5.3')
    // 裸 glm-5.3 无 [1m] 后缀,SDK 默认判 200K;内置默认 env 显式注入 1M
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1000000')
  })

  test('官方登录档位不注入任何 env(零污染)', () => {
    expect(claudeModelEnv('claude:opus')).toEqual({})
    expect(claudeModelEnv('claude:fable')).toEqual({})
    expect(claudeModelIsApiRoute('claude:opus')).toBe(false)
    expect(claudeModelIsApiRoute('claude:glm')).toBe(true)
  })

  test('第一方登录档位：飞书主力 + Sonnet 5 light（选 Opus 不注入 Fable）', () => {
    expect(claudeModelTierEnv(null)).toEqual({
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-fable-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-fable-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-sonnet-5',
    })
    expect(claudeModelTierEnv('claude:fable')).toEqual(claudeModelTierEnv(null))
    expect(claudeModelTierEnv('claude:opus')).toEqual({
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-opus-5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-opus-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-sonnet-5',
    })
  })

  test('GLM 的四个 tier alias 仍锁到当前第三方真实模型', () => {
    for (const value of Object.values(claudeModelTierEnv('claude:glm'))) {
      expect(value).toBe('glm-5.3')
    }
  })

  test('glm 档位 config 未配 env_* → 用内置默认最强组合', () => {
    ;(config.claude as any).models.glm = {
      model: 'glm-5.3',
      base_url: 'https://open.bigmodel.cn/api/anthropic',
      auth_token: 'glm-tok',
      effort: 'max',
      // 无 env_* —— 应回落代码内置默认
    }
    const env = claudeModelEnv('claude:glm')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic')
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.3')
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('glm-5.3')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.3')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5.3')
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1000000')
  })

  test('glm 档位忽略分裂的 tier alias,统一锁到当前 model', () => {
    ;(config.claude as any).models.glm = {
      model: 'glm-5.3',
      base_url: 'https://open.bigmodel.cn/api/anthropic',
      auth_token: 'glm-tok',
      env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.6' }, // 只覆盖 opus
    }
    const env = claudeModelEnv('claude:glm')
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.3')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.3')
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('glm-5.3')
  })
})

describe('Claude Grok API profiles', () => {
  let prevModels: unknown

  beforeEach(() => {
    prevModels = config.claude.models
    ;(config.claude as any).models = structuredClone(GROK_FULL)
  })

  afterEach(() => {
    ;(config.claude as any).models = prevModels
  })

  test('无痕与 CatCodex 都解析为 Claude API Grok 档位', () => {
    for (const [name, baseUrl, effort] of [
      ['grok', 'https://api.wuhen-ai.com', 'xhigh'],
      ['grokcc', 'https://catcodexapi.com', 'xhigh'],
    ] as const) {
      const model = `claude:${name}`
      expect(claudeModelIsApiRoute(model)).toBe(true)
      expect(claudeModelConfigured(model)).toBe(true)
      expect(claudeModelIsGrok(model)).toBe(true)
      expect(claudeModelEffort(model)).toBe(effort)
      const env = claudeModelEnv(model)
      expect(env.ANTHROPIC_BASE_URL).toBe(baseUrl)
      expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('500000')
      expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('450000')
      expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
      expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0')
      for (const value of Object.values(claudeModelTierEnv(model))) expect(value).toBe('grok-4.6')
    }
  })

  test('Grok 默认兼容环境允许档位 env 显式覆盖', () => {
    ;(config.claude as any).models.grokcc = {
      ...GROK_FULL.grokcc,
      env: {
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '256000',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0',
      },
    }
    const env = claudeModelEnv('claude:grokcc')
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('256000')
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('450000')
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('0')
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0')
  })

  test('未配置时两个内建 Grok 档位保持 API route 且不可选择', () => {
    ;(config.claude as any).models = {}
    for (const model of ['claude:grok', 'claude:grokcc']) {
      expect(claudeModelIsApiRoute(model)).toBe(true)
      expect(claudeModelConfigured(model)).toBe(false)
      expect(claudeModelIsGrok(model)).toBe(false)
      expect(claudeModelEnv(model)).toEqual({})
    }
  })
})

describe('Claude DeepSeek API profiles', () => {
  let prevModels: unknown

  beforeEach(() => {
    prevModels = config.claude.models
    ;(config.claude as any).models = {
      deepseek: {
        model: 'deepseek-v4-pro[1m]',
        base_url: 'https://api.deepseek.com/anthropic',
        auth_token: 'deepseek-tok',
        effort: 'max',
      },
    }
  })

  afterEach(() => {
    ;(config.claude as any).models = prevModels
  })

  test('deepseek 档位按官方接入文档拆分 alias:主力三档锁 V4 Pro,haiku 锁 V4 Flash', () => {
    // 2026-08-14 对齐官方 8-13 Claude Code 接入文档:haiku 便宜 ~1/3 走 Flash,
    // 其余三档锁主力。与 GLM/Grok 的"四档全锁"不同。
    const env = claudeModelEnv('claude:deepseek')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('deepseek-tok')
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('deepseek-v4-pro[1m]')
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('deepseek-v4-pro[1m]')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('deepseek-v4-pro[1m]')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('deepseek-v4-flash')
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('deepseek-v4-flash')
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('786432')
  })

  test('spawn 边界 claudeModelTierEnv 对 deepseek 同样拆分(覆盖 profile env 残余)', () => {
    const tier = claudeModelTierEnv('claude:deepseek')
    expect(tier.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('deepseek-v4-pro[1m]')
    expect(tier.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('deepseek-v4-pro[1m]')
    expect(tier.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('deepseek-v4-pro[1m]')
    expect(tier.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('deepseek-v4-flash')
  })

  test('deepseek 默认兼容环境允许档位 env 显式覆盖非 alias 键', () => {
    ;(config.claude as any).models.deepseek.env = {
      CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-chat',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '256000',
    }
    const env = claudeModelEnv('claude:deepseek')
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('deepseek-chat')
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('256000')
  })

  test('未配置 token 时 deepseek 保持 API route 且不可选择', () => {
    ;(config.claude as any).models.deepseek = {}
    expect(claudeModelIsApiRoute('claude:deepseek')).toBe(true)
    expect(claudeModelConfigured('claude:deepseek')).toBe(false)
    expect(claudeModelEnv('claude:deepseek')).toEqual({})
  })
})
