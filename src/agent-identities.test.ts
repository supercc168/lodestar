import { describe, expect, test } from 'bun:test'
import { agentIdentityId, buildAgentIdentityCatalog } from './agent-identities'
import type { TokenSource } from './token-source'

function source(overrides: {
  id?: string
  kind?: TokenSource['kind']
  provider?: TokenSource['provider']
  displayName?: string
  description?: string
  selectionModel?: string
  enabled?: boolean
  spawnModel?: string
} = {}): TokenSource {
  const selectionModel = overrides.selectionModel ?? 'claude:glm'
  const enabled = overrides.enabled ?? true
  return {
    id: overrides.id ?? selectionModel,
    kind: overrides.kind ?? 'api',
    provider: overrides.provider ?? 'claude',
    displayName: overrides.displayName ?? 'Claude · GLM-5.3',
    description: overrides.description ?? '',
    selectionModel,
    enabled: () => enabled,
    resolveSpawnModel: () => overrides.spawnModel ?? 'glm-5.3',
    spawnEnv: env => env,
    spawnOverrides: () => ({ modelId: undefined, configArgs: [], env: {} }),
    usageSource: () => 'glm',
    isApiRoute: () => (overrides.kind ?? 'api') === 'api',
  }
}

describe('Agent identity catalog (slim TokenSource)', () => {
  test('emits one identity per configured slot and uses selectionModel as spawn model', () => {
    const catalog = buildAgentIdentityCatalog([
      source(),
      source({
        id: 'gpt-5.6-sol',
        kind: 'login',
        provider: 'codex',
        displayName: 'GPT-5.6 Sol',
        selectionModel: 'gpt-5.6-sol',
        spawnModel: 'gpt-5.6',
      }),
    ])
    expect(catalog.identities).toHaveLength(2)
    expect(catalog.identities[0]).toMatchObject({
      id: agentIdentityId('claude:glm', 'claude:glm'),
      model: 'claude:glm',
      modelDisplay: 'glm-5.3',
      tokenSourceId: 'claude:glm',
      status: 'ready',
    })
    expect(catalog.identities[0].model).not.toBe('glm-5.3')
    expect(catalog.identities[0].supportedEfforts).toEqual([catalog.identities[0].defaultEffort])
    expect(catalog.identities[1]).toMatchObject({
      id: agentIdentityId('gpt-5.6-sol', 'gpt-5.6-sol'),
      model: 'gpt-5.6-sol',
      provider: 'codex',
    })
    expect(JSON.stringify(catalog)).not.toContain('catalog_loading')
    expect(JSON.stringify(catalog)).not.toContain('catalog_failed')
  })

  test('keeps disabled slots visible but uncallable', () => {
    const catalog = buildAgentIdentityCatalog([source({ enabled: false })])
    expect(catalog.identities).toHaveLength(1)
    expect(catalog.identities[0].status).toBe('source_disabled')
    expect(catalog.sourceFailures[0]).toMatchObject({
      tokenSourceId: 'claude:glm',
      status: 'disabled',
    })
  })

  test('locks Grok default effort to xhigh', () => {
    const catalog = buildAgentIdentityCatalog([
      source({
        id: 'claude:grok',
        selectionModel: 'claude:grok',
        displayName: 'Claude · Grok 4.6 · 无痕',
        spawnModel: 'grok-4.6',
      }),
    ])
    expect(catalog.identities[0].defaultEffort).toBe('xhigh')
    expect(catalog.identities[0].supportedEfforts).toEqual(['xhigh'])
  })

  test('agentIdentityId encodes tokenSourceId NUL model as base64url', () => {
    const encoded = Buffer.from(`claude:glm${String.fromCharCode(0)}claude:glm`, 'utf8').toString('base64url')
    expect(agentIdentityId('claude:glm', 'claude:glm')).toBe(`agent:${encoded}`)
  })
})
