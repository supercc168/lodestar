import { describe, expect, test } from 'bun:test'

import { config } from './config'
import {
  claudeProviderUsageFromNewApiTokenResponse,
  claudeProviderUsageFromV1Response,
  isNewApiUsageHost,
  readClaudeProviderUsage,
} from './claude-provider-usage'

describe('claude provider usage host detection', () => {
  test('recognizes CatCodex / NewAPI hosts for /api/usage/token', () => {
    expect(isNewApiUsageHost('https://catcodexapi.com')).toBe(true)
    expect(isNewApiUsageHost('https://catcodexapi.com/v1')).toBe(true)
    expect(isNewApiUsageHost('https://api.newapi.pro')).toBe(true)
    expect(isNewApiUsageHost('https://api.wuhen-ai.com')).toBe(false)
  })
})

describe('claude provider usage parsers', () => {
  test('parses CatCodex unlimited token usage without inventing USD', () => {
    const snapshot = claudeProviderUsageFromNewApiTokenResponse('Claude Code · Grok 4.5(CatCodex)', {
      code: true,
      data: {
        name: 'cc-grok',
        object: 'token_usage',
        total_used: 390_493_193,
        total_granted: 0,
        total_available: -390_493_193,
        unlimited_quota: true,
      },
      message: 'ok',
    })

    expect(snapshot.state).toBe('ok')
    if (snapshot.state !== 'ok') throw new Error('expected ok')
    expect(snapshot.unlimited).toBe(true)
    expect(snapshot.tokenName).toBe('cc-grok')
    expect(snapshot.totalUsed).toBe(390_493_193)
    expect(snapshot.remaining).toBeUndefined()
    expect(snapshot.unit).toBeUndefined()
  })

  test('parses NewAPI limited quota as internal units, not USD', () => {
    const snapshot = claudeProviderUsageFromNewApiTokenResponse('CatCodex', {
      data: {
        name: 'limited',
        total_used: 1000,
        total_available: 5000,
        unlimited_quota: false,
      },
    })
    expect(snapshot.state).toBe('ok')
    if (snapshot.state !== 'ok') throw new Error('expected ok')
    expect(snapshot.unlimited).toBe(false)
    expect(snapshot.remaining).toBe(5000)
    expect(snapshot.unit).toBe('quota')
    expect(snapshot.totalUsed).toBe(1000)
  })

  test('parses Wuhen / CCSwitch-compatible /v1/usage balance', () => {
    const snapshot = claudeProviderUsageFromV1Response('Claude Code · Grok 4.5(无痕)', {
      balance: 2544.33,
      remaining: 2544.33,
      unit: 'USD',
      isValid: true,
      planName: '钱包余额',
    })
    expect(snapshot.state).toBe('ok')
    if (snapshot.state !== 'ok') throw new Error('expected ok')
    expect(snapshot.unlimited).toBe(false)
    expect(snapshot.remaining).toBe(2544.33)
    expect(snapshot.unit).toBe('USD')
    expect(snapshot.planName).toBe('钱包余额')
    expect(snapshot.isValid).toBe(true)
  })
})

describe('readClaudeProviderUsage routing', () => {
  test('CatCodex profile hits /api/usage/token with Bearer token', async () => {
    const prev = config.claude.models.grokcc
    const prevFetch = globalThis.fetch
    const urls: string[] = []
    ;(config.claude as any).models = {
      ...config.claude.models,
      grokcc: {
        display_name: 'Claude Code · Grok 4.5(CatCodex)',
        base_url: 'https://catcodexapi.com',
        auth_token: 'sk-cat',
        model: 'grok-4.5',
        effort: 'xhigh',
      },
    }
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input))
      expect(init?.headers && (init.headers as any).authorization).toBe('Bearer sk-cat')
      return new Response(JSON.stringify({
        code: true,
        data: {
          name: 'cc-grok',
          total_used: 12,
          unlimited_quota: true,
        },
        message: 'ok',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    try {
      const snapshot = await readClaudeProviderUsage('claude:grokcc')
      expect(urls[0]).toBe('https://catcodexapi.com/api/usage/token')
      expect(snapshot.state).toBe('ok')
      if (snapshot.state !== 'ok') throw new Error('expected ok')
      expect(snapshot.unlimited).toBe(true)
      expect(snapshot.tokenName).toBe('cc-grok')
    } finally {
      globalThis.fetch = prevFetch
      ;(config.claude as any).models.grokcc = prev
    }
  })

  test('Wuhen Grok profile hits /v1/usage', async () => {
    const prev = config.claude.models.grok
    const prevFetch = globalThis.fetch
    const urls: string[] = []
    ;(config.claude as any).models = {
      ...config.claude.models,
      grok: {
        display_name: 'Claude Code · Grok 4.5(无痕)',
        base_url: 'https://api.wuhen-ai.com',
        auth_token: 'sk-wuhen',
        model: 'grok-4.5',
        effort: 'high',
      },
    }
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response(JSON.stringify({
        remaining: 99.5,
        unit: 'USD',
        isValid: true,
        planName: '钱包余额',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    try {
      const snapshot = await readClaudeProviderUsage('claude:grok')
      expect(urls[0]).toBe('https://api.wuhen-ai.com/v1/usage')
      expect(snapshot.state).toBe('ok')
      if (snapshot.state !== 'ok') throw new Error('expected ok')
      expect(snapshot.remaining).toBe(99.5)
      expect(snapshot.unit).toBe('USD')
    } finally {
      globalThis.fetch = prevFetch
      ;(config.claude as any).models.grok = prev
    }
  })

  test('reports HTML as non-JSON without leaking parser errors', async () => {
    const prev = config.claude.models.grok
    const prevFetch = globalThis.fetch
    ;(config.claude as any).models = {
      ...config.claude.models,
      grok: {
        display_name: 'Claude Code · Grok 4.5(无痕)',
        base_url: 'https://api.wuhen-ai.com',
        auth_token: 'sk-wuhen',
        model: 'grok-4.5',
      },
    }
    globalThis.fetch = (async () => new Response('<!doctype html><html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })) as typeof fetch

    try {
      const snapshot = await readClaudeProviderUsage('claude:grok')
      expect(snapshot.state).toBe('unavailable')
      if (snapshot.state !== 'unavailable') throw new Error('expected unavailable')
      expect(snapshot.reason).toContain('非 JSON')
      expect(snapshot.reason).not.toContain('Unexpected token')
    } finally {
      globalThis.fetch = prevFetch
      ;(config.claude as any).models.grok = prev
    }
  })
})
