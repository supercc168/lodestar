import { describe, expect, mock, test } from 'bun:test'

mock.module('./config', () => ({
  config: {
    codex: {
      env: {},
      models: {
        kimi: {
          display_name: 'Codex · Kimi',
          base_url: 'https://api.moonshot.cn/v1',
          wire_api: 'chat',
          api_key: 'sk-kimi',
          model: 'kimi-k2',
          effort: 'high',
        },
        // 缺 model → 未配置
        broken: { base_url: 'https://x.example.com', api_key: 'sk-x' },
        // 登录档(无 base_url)
        legacy: { model: 'gpt-5.5' },
        // API 档但靠 codex 的 ChatGPT 登录态(无痕),不自带 key
        wuhen: {
          base_url: 'https://api.wuhen-ai.com',
          requires_openai_auth: 'true',
          model: 'gpt-5.6-sol',
        },
      },
    },
    claude: { env: {}, models: {} },
  },
}))

const {
  codexProviderSlug,
  codexEnvKeyName,
  codexEnvFromConfig,
  codexConfigArgs,
  toCodexProfile,
  codexModelProfiles,
  codexModelProfile,
  codexModelIsApiRoute,
  codexModelRequiresOpenaiAuth,
  codexModelConfigured,
  codexModelEffort,
  resolveCodexModelId,
  codexSpawnOverrides,
  codexModelChoices,
} = await import('./codex-models')

describe('codex model slug helpers', () => {
  test('provider slug is lodestar-prefixed and sanitized', () => {
    expect(codexProviderSlug('wuhen-ai')).toBe('lodestar_wuhen_ai')
  })
  test('env key name is uppercase sanitized', () => {
    expect(codexEnvKeyName('wuhen-ai')).toBe('LODESTAR_CODEX_WUHEN_AI_KEY')
  })
})

describe('codexConfigArgs', () => {
  test('builds -c overrides for provider + endpoint (api_key → env_key declared)', () => {
    const args = codexConfigArgs(
      { base_url: 'https://api.moonshot.cn/v1', wire_api: 'chat', api_key: 'sk-kimi', model: 'kimi-k2' },
      'kimi',
    )
    // flat ['-c','k=v', …];断言关键对存在
    expect(args).toContain('model_provider="lodestar_kimi"')
    expect(args).toContain('model_providers.lodestar_kimi.base_url="https://api.moonshot.cn/v1"')
    expect(args).toContain('model_providers.lodestar_kimi.wire_api="chat"')
    expect(args).toContain('model_providers.lodestar_kimi.env_key="LODESTAR_CODEX_KIMI_KEY"')
    // 每个 k=v 前面都跟一个 '-c'
    expect(args.filter(a => a === '-c').length).toBe((args.length) / 2)
  })
  test('adds requires_openai_auth and OMITS env_key when no api_key', () => {
    const args = codexConfigArgs(
      { base_url: 'https://api.wuhen-ai.com', requires_openai_auth: 'true', model: 'gpt-5.6-sol' },
      'wuhen',
    )
    expect(args).toContain('model_providers.lodestar_wuhen.requires_openai_auth=true')
    // codex 对未设的 env_key 变量会中止 → 无 api_key 时绝不声明 env_key(2026-07-06 实测)
    expect(args.some(a => a.includes('.env_key='))).toBe(false)
  })
  test('defaults wire_api to chat', () => {
    const args = codexConfigArgs({ base_url: 'https://x' }, 'x')
    expect(args).toContain('model_providers.lodestar_x.wire_api="chat"')
  })
})

describe('codexEnvFromConfig', () => {
  test('injects api_key under generated env key', () => {
    expect(codexEnvFromConfig({ api_key: 'sk-1' }, 'kimi')).toEqual({ LODESTAR_CODEX_KIMI_KEY: 'sk-1' })
  })
  test('empty when no api_key (requires_openai_auth path)', () => {
    expect(codexEnvFromConfig({ requires_openai_auth: 'true' }, 'wuhen')).toEqual({})
  })
})

describe('toCodexProfile', () => {
  test('infers api route from base_url and computes configured', () => {
    const p = toCodexProfile('kimi', {
      base_url: 'https://api.moonshot.cn/v1', api_key: 'sk', model: 'kimi-k2',
    })!
    expect(p.key).toBe('codex:kimi')
    expect(p.route).toBe('api')
    expect(p.modelId).toBe('kimi-k2')
    expect(p.configured).toBe(true)
  })
  test('api route missing model is not configured', () => {
    const p = toCodexProfile('broken', { base_url: 'https://x', api_key: 'sk' })!
    expect(p.route).toBe('api')
    expect(p.configured).toBe(false)
  })
  test('login route (no base_url) is always configured with empty overrides', () => {
    const p = toCodexProfile('legacy', { model: 'gpt-5.5' })!
    expect(p.route).toBe('login')
    expect(p.configured).toBe(true)
    expect(p.configArgs).toEqual([])
    expect(p.env).toEqual({})
  })
  test('explicit route wins over inference', () => {
    const p = toCodexProfile('forced', { route: 'login', base_url: 'https://x' })!
    expect(p.route).toBe('login')
  })
})

describe('config-driven lookups', () => {
  test('codexModelProfile resolves by codex: key', () => {
    expect(codexModelProfile('codex:kimi')?.modelId).toBe('kimi-k2')
    expect(codexModelProfile('gpt-5.5')).toBeNull()
  })
  test('codexModelIsApiRoute / codexModelConfigured', () => {
    expect(codexModelIsApiRoute('codex:kimi')).toBe(true)
    expect(codexModelConfigured('codex:kimi')).toBe(true)
    expect(codexModelConfigured('codex:broken')).toBe(false)
    expect(codexModelConfigured('gpt-5.5')).toBe(true) // 未知 key 当就绪
  })
  test('codexModelEffort reads per-slot effort', () => {
    expect(codexModelEffort('codex:kimi')).toBe('high')
  })
  test('resolveCodexModelId maps codex: key to real id; bare id unchanged', () => {
    expect(resolveCodexModelId('codex:kimi')).toBe('kimi-k2')
    expect(resolveCodexModelId('gpt-5.5')).toBe('gpt-5.5')
  })
  test('codexSpawnOverrides: api slot carries args+env; login empty', () => {
    const api = codexSpawnOverrides('codex:kimi')
    expect(api.modelId).toBe('kimi-k2')
    expect(api.env).toEqual({ LODESTAR_CODEX_KIMI_KEY: 'sk-kimi' })
    expect(api.configArgs.length).toBeGreaterThan(0)
    const login = codexSpawnOverrides('gpt-5.5')
    expect(login).toEqual({ modelId: 'gpt-5.5', configArgs: [], env: {} })
  })
  test('codexModelChoices lists only api slots (incl unconfigured)', () => {
    const choices = codexModelChoices()
    const models = choices.map(c => c.model).sort()
    expect(models).toEqual(['codex:broken', 'codex:kimi', 'codex:wuhen'])
    expect(choices.find(c => c.model === 'codex:kimi')!.effort).toBe('high')
  })
  test('codexModelRequiresOpenaiAuth: only requires_openai_auth api slots keep the login precheck', () => {
    // 无痕:API 档但仍需 ChatGPT 登录态 → 保留预检
    expect(codexModelRequiresOpenaiAuth('codex:wuhen')).toBe(true)
    // kimi:自带 key 的 API 档 → 跳过预检
    expect(codexModelRequiresOpenaiAuth('codex:kimi')).toBe(false)
    // 内建登录档(非 codex: 档位)→ 不适用
    expect(codexModelRequiresOpenaiAuth('gpt-5.5')).toBe(false)
  })
})
