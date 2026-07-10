import { describe, expect, test } from 'bun:test'

import { config } from './config'
import { providerUsageSnapshotFromResponse, readUsage, updateUsageFromRateLimits } from './usage'

describe('usage cache semantics', () => {
  test('keeps last live snapshot when a later live update payload is empty', () => {
    const snapshot = updateUsageFromRateLimits({
      planType: 'plus',
      primary: { usedPercent: 12.4, windowDurationMins: 300 },
      secondary: { usedPercent: 66.6, windowDurationMins: 10_080 },
    })

    expect(snapshot.state).toBe('ok')
    if (snapshot.state !== 'ok') throw new Error('expected ok snapshot')
    expect(snapshot.fiveHour?.percent).toBe(12.4)
    expect(snapshot.weekly?.percent).toBe(66.6)

    const kept = updateUsageFromRateLimits(null)
    expect(kept).toEqual(snapshot)
  })

  test('does not coerce missing usage percentages to 0', () => {
    const snapshot = updateUsageFromRateLimits({
      planType: 'pro',
      primary: { windowDurationMins: 300 },
      secondary: { windowDurationMins: 10_080 },
    })

    expect(snapshot.state).toBe('ok')
    if (snapshot.state !== 'ok') throw new Error('expected ok snapshot')
    expect(snapshot.fiveHour?.percent).toBeNull()
    expect(snapshot.weekly?.percent).toBeNull()
  })
})

describe('provider usage snapshots', () => {
  test('parses CCSwitch-compatible third-party provider balance payloads', () => {
    const snapshot = providerUsageSnapshotFromResponse('Codex · Wuhen', {
      quota: { remaining: 12.34, unit: 'USD' },
      is_active: true,
    })

    expect(snapshot.state).toBe('provider_usage')
    if (snapshot.state !== 'provider_usage') throw new Error('expected provider usage snapshot')
    expect(snapshot.providerName).toBe('Codex · Wuhen')
    expect(snapshot.remaining).toBe(12.34)
    expect(snapshot.unit).toBe('USD')
    expect(snapshot.isValid).toBe(true)
  })

  test('reports HTML provider usage responses as non-JSON instead of leaking parser errors', async () => {
    const prevModels = config.codex.models
    const prevFetch = globalThis.fetch
    ;(config.codex as any).models = {
      wuhen: {
        display_name: 'Codex · 无痕',
        base_url: 'https://api.wuhen-ai.com',
        api_key: 'sk-test',
        model: 'gpt-5.6-sol',
      },
    }
    globalThis.fetch = async () => new Response('<!doctype html><html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })

    try {
      const snapshot = await readUsage('codex:wuhen')

      expect(snapshot.state).toBe('provider_unavailable')
      if (snapshot.state !== 'provider_unavailable') throw new Error('expected provider_unavailable snapshot')
      expect(snapshot.reason).toContain('非 JSON')
      expect(snapshot.reason).not.toContain('Unexpected token')
    } finally {
      globalThis.fetch = prevFetch
      ;(config.codex as any).models = prevModels
    }
  })
})
