import { describe, expect, test } from 'bun:test'
import { agentIdentityId, assertAgentIdentityIdAllowed, assertAgentSourceAllowed, buildAgentIdentityCatalog, buildAgentSkillIdentityCatalog } from './agent-identities'
import type { TokenSource } from './token-source'
import { config } from './config'

function source(overrides: Partial<TokenSource> = {}): TokenSource {
  return {
    id: 'glm', kind: 'glm', agent: 'claude', display: 'GLM', enabled: true,
    models: [
      { model: 'GLM-5.3', display: 'GLM-5.3', efforts: ['low', 'max'], defaultEffort: 'max' },
      { model: 'GLM-Air', display: 'GLM-Air', efforts: ['low', 'medium'], defaultEffort: 'medium' },
    ],
    defaultModel: 'GLM-5.3',
    refreshModels: async () => {},
    spawnEnv: env => env,
    resolveSpawnModel: model => model,
    readUsage: async () => ({ state: 'not_applicable', windows: [] }),
    modelCatalogState: { status: 'ready', updatedAt: Date.now() },
    ...overrides,
  }
}

describe('Agent identity catalog', () => {
  test('exposes every model with its real default effort instead of forcing max', () => {
    const catalog = buildAgentIdentityCatalog([source()])
    expect(catalog.identities).toHaveLength(2)
    expect(catalog.identities[1]).toMatchObject({
      id: agentIdentityId('glm', 'GLM-Air'), defaultEffort: 'medium', status: 'ready',
    })
  })

  test('keeps disabled models visible but uncallable', () => {
    const catalog = buildAgentIdentityCatalog([source({ enabled: false, modelCatalogState: { status: 'disabled', updatedAt: 1 } })])
    expect(catalog.identities.every(identity => identity.status === 'source_disabled')).toBe(true)
    expect(catalog.sourceFailures[0].status).toBe('disabled')
  })

  test('keeps missing effort visible and uncallable without a fabricated default', () => {
    const catalog = buildAgentIdentityCatalog([source({
      models: [{ model: 'missing-effort', display: 'Missing effort', efforts: [], defaultEffort: null }],
    })])
    expect(catalog.identities[0]).toMatchObject({
      status: 'model_unavailable', defaultEffort: null, supportedEfforts: [], reason: expect.stringContaining('MISS'),
    })
  })
})

describe('Lodestar Agent Claude subscription exclusion', () => {
  test('excludes subscription sources by source ID or kind without changing the source catalog', async () => {
    let checks = 0
    const subscriptions = [
      source({ id: 'claude-sub', kind: 'claude-subscription' }),
      source({ id: 'claude-subscription', kind: 'other' }),
      source({ id: 'renamed-subscription', kind: 'claude-subscription' }),
      source({ id: 'claude-sub', kind: 'other' }),
    ]
    for (const subscription of subscriptions) {
      subscription.readUsage = async () => { checks++; throw new Error('must not query subscription usage') }
      const models = subscription.models
      const state = subscription.modelCatalogState
      const others = source({ readUsage: async () => { checks++; throw new Error('must not query other usage') } })
      const expected = buildAgentIdentityCatalog([others])
      expect(buildAgentIdentityCatalog([subscription, others])).toEqual(expected)
      expect(await buildAgentSkillIdentityCatalog([subscription, others])).toEqual(expected)
      expect(subscription.models).toBe(models)
      expect(subscription.modelCatalogState).toBe(state)
      expect(subscription.enabled).toBe(true)
    }
    expect(checks).toBe(0)
  })

  test('preserves all Claude families and other models from third-party sources', async () => {
    const mixed = source({ id: 'packy', kind: 'packy', models: [
      { model: 'claude-opus-5-5', display: 'Opus', efforts: ['high'], defaultEffort: 'high' },
      { model: 'anthropic/new-model', display: 'New model', efforts: ['high'], defaultEffort: 'high' },
      { model: 'OPUS5.5', display: 'Premium', efforts: ['high'], defaultEffort: 'high' },
      { model: 'vendor/sonnet-4', display: 'Premium', efforts: ['high'], defaultEffort: 'high' },
      { model: 'haiku', display: 'Premium', efforts: ['high'], defaultEffort: 'high' },
      { model: 'fable-5-1', display: 'Premium', efforts: ['high'], defaultEffort: 'high' },
      { model: 'opaque-model', display: 'Claude model', efforts: ['high'], defaultEffort: 'high' },
      { model: 'opaque-family', display: 'Fable 5.1', efforts: ['high'], defaultEffort: 'high' },
      { model: 'MiniMax-M3', display: 'MiniMax M3', efforts: ['default'], defaultEffort: 'default' },
      { model: 'DeepSeek-V4', display: 'DeepSeek V4', efforts: ['high'], defaultEffort: 'high' },
      { model: 'GLM-5.3', display: 'GLM 5.3', efforts: ['max'], defaultEffort: 'max' },
    ] })
    const models = structuredClone(mixed.models)
    const catalog = buildAgentIdentityCatalog([mixed])
    expect(catalog.identities.map(identity => identity.model)).toEqual(models.map(model => model.model))
    expect(catalog.identities.every(identity => identity.provider === 'claude')).toBe(true)
    expect(await buildAgentSkillIdentityCatalog([mixed])).toEqual(catalog)
    expect(mixed.models).toEqual(models)
  })

  test('refreshing or rebuilding sources keeps subscriptions excluded and updates third-party Claude models', async () => {
    const subscription = source({ id: 'claude-sub', kind: 'claude-subscription' })
    const mixed = source({ id: 'openrouter', kind: 'openrouter', models: [
      { model: 'claude-sonnet-4', display: 'Sonnet 4', efforts: ['high'], defaultEffort: 'high' },
      { model: 'glm-5.3', display: 'GLM 5.3', efforts: ['max'], defaultEffort: 'max' },
    ] })
    const first = await buildAgentSkillIdentityCatalog([subscription, mixed])
    subscription.models.push({ model: 'future-subscription-model', display: 'Future', efforts: ['high'], defaultEffort: 'high' })
    subscription.modelCatalogState = { status: 'ready', updatedAt: Date.now() }
    mixed.models = [
      { model: 'claude-fable-6', display: 'Fable 6', efforts: ['high'], defaultEffort: 'high' },
      { model: 'deepseek-v4', display: 'DeepSeek V4', efforts: ['high'], defaultEffort: 'high' },
    ]
    const updated = await buildAgentSkillIdentityCatalog([{ ...subscription }, { ...mixed }])
    expect(first.identities.map(identity => identity.model)).toEqual(['claude-sonnet-4', 'glm-5.3'])
    expect(updated.identities.map(identity => identity.model)).toEqual(['claude-fable-6', 'deepseek-v4'])
    expect(updated.catalogGeneration).not.toBe(first.catalogGeneration)
  })

  test.each(['disabled', 'loading', 'failed'] as const)('keeps %s diagnostics for supported sources only', async status => {
    const state = { status, updatedAt: 1, ...(status === 'failed' ? { error: 'catalog failed' } : {}) }
    const subscription = source({ id: 'claude-sub', kind: 'claude-subscription', enabled: status !== 'disabled', modelCatalogState: state })
    const other = source({ enabled: status !== 'disabled', modelCatalogState: state })
    const expected = buildAgentIdentityCatalog([other])
    const catalog = await buildAgentSkillIdentityCatalog([subscription, other])
    expect(catalog).toEqual(expected)
    expect(catalog.sourceFailures).toHaveLength(1)
    expect(catalog.sourceFailures[0]?.tokenSourceId).toBe('glm')
    expect(catalog.sourceFailures[0]?.status).toBe(status)
  })

  test.each([
    ['claude-sub', 'default'],
    ['claude-sub', 'sonnet'],
    ['claude-sub', 'GLM-5.3'],
    ['claude-subscription', 'opaque'],
  ])('rejects subscription %s/%s regardless of model name', (sourceId, model) => {
    const message = "Lodestar Agent does not support Claude subscription calls; comply with Claude's user agreement."
    expect(() => assertAgentSourceAllowed(sourceId!)).toThrow(message)
    expect(() => assertAgentIdentityIdAllowed(agentIdentityId(sourceId!, model!))).toThrow(message)
  })

  test.each([
    ['packy', 'claude-opus-5-5'],
    ['openrouter', 'anthropic/model'],
    ['packy', 'SONNET4.6'],
    ['packy', 'opus[1m]'],
    ['packy', 'haiku'],
    ['packy', 'fable-5-1'],
    ['glm', 'GLM-5.3'],
    ['deepseek', 'DeepSeek-V4'],
    ['packy', 'MiniMax-M3'],
    ['codex', 'gpt-6'],
  ])('allows non-subscription %s/%s in direct and encoded identity guards', (sourceId, model) => {
    expect(() => assertAgentSourceAllowed(sourceId!)).not.toThrow()
    expect(() => assertAgentIdentityIdAllowed(agentIdentityId(sourceId!, model!))).not.toThrow()
  })

  test('leaves unknown or malformed identity IDs to normal not-found handling', () => {
    const malformed = [
      'agent:a', 'claude-sub', 'other:claude', 'agent:$$$',
      `agent:${Buffer.from('claude-sub').toString('base64url')}`,
      `agent:${Buffer.from('claude-sub\u0000sonnet\u0000extra').toString('base64url')}`,
      `${agentIdentityId('claude-sub', 'sonnet')}=`,
    ]
    for (const id of malformed) expect(() => assertAgentIdentityIdAllowed(id)).not.toThrow()
  })
})

// ── fork 档位语义:目录未给 defaultEffort 时按本地约定补档 ─────────────
describe('Agent identity catalog(fork 档位回落)', () => {
  test('locks Grok default effort to xhigh', () => {
    const catalog = buildAgentIdentityCatalog([
      source({
        id: 'claude:grok', display: 'Claude · Grok 4.6 · 无痕', defaultModel: 'grok-4.6',
        models: [
          { model: 'grok-4.6', display: 'Grok 4.6', efforts: ['xhigh'], defaultEffort: null },
          { model: 'grok-lite', display: 'Grok Lite', efforts: ['low'], defaultEffort: null },
        ],
      }),
    ])
    expect(catalog.identities[0].defaultEffort).toBe('xhigh')
    expect(catalog.identities[0].supportedEfforts).toEqual(['xhigh'])
    // 候选档不在该模型词表内 → 不造档,保持 null 交面板手动选择。
    expect(catalog.identities[1]).toMatchObject({ defaultEffort: null, supportedEfforts: ['low'] })
  })

  test('dsh 身份取 [deepseek-harness].effort,缺省复用 bootstrap high,绝不回落 Codex 的 max', () => {
    const prev = (config as any).deepseek_harness
    const dsh: Partial<TokenSource> = {
      id: 'deepseek-harness', kind: 'deepseek-harness', agent: 'dsh', display: 'DeepSeek Harness',
      models: [
        { model: 'deepseek-v4-pro', display: 'deepseek-v4-pro', efforts: ['off', 'low', 'high', 'max'], defaultEffort: null },
        { model: 'deepseek-v4-lite', display: 'deepseek-v4-lite', efforts: ['off', 'low', 'max'], defaultEffort: null },
      ],
      defaultModel: 'deepseek-v4-pro',
    }
    try {
      ;(config as any).deepseek_harness = undefined
      let catalog = buildAgentIdentityCatalog([source(dsh)])
      expect(catalog.identities[0].defaultEffort).toBe('high')
      expect(catalog.identities[0].supportedEfforts).toEqual(['off', 'low', 'high', 'max'])
      expect(catalog.identities[0].defaultEffort).not.toBe('max')
      // bootstrap 档不在 lite 词表内 → null,不静默回落到 Codex 的 max。
      expect(catalog.identities[1].defaultEffort).toBeNull()

      ;(config as any).deepseek_harness = { api_key: 'dsh-key', effort: 'low' }
      catalog = buildAgentIdentityCatalog([source(dsh)])
      expect(catalog.identities[0].defaultEffort).toBe('low')

      // 非 DSH 词表(medium)不生效,回落 bootstrap 而不是 Codex 的 max。
      ;(config as any).deepseek_harness = { api_key: 'dsh-key', effort: 'medium' }
      catalog = buildAgentIdentityCatalog([source(dsh)])
      expect(catalog.identities[0].defaultEffort).toBe('high')
    } finally {
      ;(config as any).deepseek_harness = prev
    }
  })

  test('agentIdentityId encodes tokenSourceId NUL model as base64url', () => {
    const encoded = Buffer.from(`claude:glm${String.fromCharCode(0)}claude:glm`, 'utf8').toString('base64url')
    expect(agentIdentityId('claude:glm', 'claude:glm')).toBe(`agent:${encoded}`)
  })
})
