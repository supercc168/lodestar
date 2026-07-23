import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { config } from './config'
import {
  listTokenSources,
  resolveClaudeSpawnEnv,
  resolveCodexSpawnOverrides,
  resolveTokenSource,
  resolveUsageSource,
  scrubAnthropicEnv,
} from './token-source'

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

describe('token-source scrubAnthropicEnv', () => {
  test('抹掉 base_url/token/api_key 与四档 tier alias', () => {
    const cleaned = scrubAnthropicEnv({
      KEEP: '1',
      ANTHROPIC_BASE_URL: 'https://evil.example',
      ANTHROPIC_AUTH_TOKEN: 'tok',
      ANTHROPIC_API_KEY: 'key',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'x',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'x',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'x',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'x',
    })
    expect(cleaned).toEqual({ KEEP: '1' })
  })
})

describe('token-source Claude login vs api', () => {
  let prevGlm: unknown

  beforeEach(() => {
    prevGlm = config.claude.models.glm
    ;(config.claude as any).models.glm = { ...GLM_FULL, env: { ...GLM_FULL.env } }
  })

  afterEach(() => {
    ;(config.claude as any).models.glm = prevGlm
  })

  test('fable login:scrub 后不注入凭据,锁 tier 到 claude-fable-5', () => {
    const source = resolveTokenSource('claude', 'claude:fable')
    expect(source.kind).toBe('login')
    expect(source.provider).toBe('claude')
    expect(source.enabled()).toBe(true)
    expect(source.isApiRoute()).toBe(false)
    expect(source.resolveSpawnModel()).toBe('claude-fable-5')
    expect(source.usageSource()).toBe('not_applicable')

    const env = source.spawnEnv({
      PATH: '/bin',
      ANTHROPIC_BASE_URL: 'https://should-be-scrubbed',
      ANTHROPIC_AUTH_TOKEN: 'leak',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-leak',
    })
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-fable-5')
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('claude-fable-5')
    expect(env.GSD_RUNTIME).toBe('claude')
    expect(env.PATH).toBe('/bin')
  })

  test('opus login:resolveSpawnModel = claude-opus-4-8', () => {
    const source = resolveTokenSource('claude', 'claude:opus')
    expect(source.kind).toBe('login')
    expect(source.resolveSpawnModel()).toBe('claude-opus-4-8')
    const env = source.spawnEnv({})
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-4-8')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  test('glm api:注入 base_url/token 且 tier 收敛到 profile.model', () => {
    const source = resolveTokenSource('claude', 'claude:glm')
    expect(source.kind).toBe('api')
    expect(source.enabled()).toBe(true)
    expect(source.isApiRoute()).toBe(true)
    expect(source.resolveSpawnModel()).toBe('glm-5.2[1m]')
    expect(source.usageSource()).toBe('glm')

    const env = resolveClaudeSpawnEnv('claude:glm', {
      ANTHROPIC_API_KEY: 'official-leak',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
    })
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('glm-tok')
    // tier 最终由 claudeModelTierEnv 锁到 profile.model(覆盖 profile.env 里的 turbo 等)
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.2[1m]')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.2[1m]')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5.2[1m]')
    expect(env.GSD_RUNTIME).toBe('claude')
  })

  test('未配置 glm:enabled=false,但仍可解析 source(选择时由 session-model 拦截)', () => {
    ;(config.claude as any).models.glm = {
      model: '',
      base_url: '',
      auth_token: '',
    }
    const source = resolveTokenSource('claude', 'claude:glm')
    expect(source.kind).toBe('api')
    expect(source.enabled()).toBe(false)
  })
})

describe('token-source Codex login vs api', () => {
  let prevModels: unknown

  beforeEach(() => {
    prevModels = config.codex.models
    ;(config.codex as any).models = {
      wuhen: {
        display_name: 'Codex · Wuhen',
        description: 'test',
        model: 'gpt-5.6-sol',
        base_url: 'https://wuhen.example/v1',
        api_key: 'wu-key',
        route: 'api',
        effort: 'max',
      },
    }
  })

  afterEach(() => {
    ;(config.codex as any).models = prevModels
  })

  test('gpt-5.6-sol login:空 configArgs/env', () => {
    const source = resolveTokenSource('codex', 'gpt-5.6-sol')
    expect(source.kind).toBe('login')
    expect(source.provider).toBe('codex')
    expect(source.enabled()).toBe(true)
    expect(source.isApiRoute()).toBe(false)
    expect(source.usageSource()).toBe('codex')
    const o = source.spawnOverrides()
    expect(o.configArgs).toEqual([])
    expect(o.env).toEqual({})
    expect(o.modelId).toBe('gpt-5.6-sol')
  })

  test('codex api 档:注入 provider configArgs + key env', () => {
    const source = resolveTokenSource('codex', 'codex:wuhen')
    expect(source.kind).toBe('api')
    expect(source.enabled()).toBe(true)
    expect(source.isApiRoute()).toBe(true)
    const o = resolveCodexSpawnOverrides('codex:wuhen')
    expect(o.modelId).toBe('gpt-5.6-sol')
    expect(o.configArgs.some(a => a.includes('model_provider='))).toBe(true)
    expect(Object.keys(o.env).length).toBeGreaterThan(0)
    expect(Object.values(o.env)).toContain('wu-key')
  })
})

describe('token-source list + usage helpers', () => {
  test('listTokenSources 含 claude login 档与 sol', () => {
    const ids = listTokenSources().map(s => s.id)
    expect(ids).toContain('claude:fable')
    expect(ids).toContain('claude:opus')
    expect(ids.some(id => id.includes('gpt-5.6-sol') || id === 'codex-login:gpt-5.6-sol')).toBe(true)
  })

  test('resolveUsageSource 与历史 usageSourceForAgent 对齐', () => {
    expect(resolveUsageSource('codex', 'gpt-5.6-sol')).toBe('codex')
    expect(resolveUsageSource('claude', 'claude:fable')).toBe('not_applicable')
    expect(resolveUsageSource('claude', 'claude:glm')).toBe('glm')
    expect(resolveUsageSource('claude', 'claude:grok')).toBe('not_applicable')
  })
})
