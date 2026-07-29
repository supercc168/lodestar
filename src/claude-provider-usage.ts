/**
 * Claude 第三方 API 渠道额度快照 —— 给 `hi` console 的 Grok 等 Claude API 档用。
 *
 * 与 spawn 同源：凭据取自 config.toml `[claude.models.<slug>]`（经
 * claudeModelProfile），不读进程环境，避免被其它会话残留污染。
 *
 * 目前识别两类网关：
 *   1. CatCodex / New API：GET {root}/api/usage/token
 *      → unlimited_quota / total_used / name
 *   2. CCSwitch 兼容余额（无痕等）：GET {root}/v1/usage
 *      → remaining / balance / unit / isValid / planName
 *
 * 失败可见 (no_fallbacks)：无凭据 / 接口不存在 / 鉴权失败 / 非 JSON /
 * 限流 / 网络各自显式 MISS，绝不把 quota 单位换算成臆测美元。
 */

import { claudeModelProfile } from './claude-models'
import { log } from './log'

const API_TIMEOUT_MS = 10_000

export type ClaudeProviderUsageSnapshot =
  | { state: 'no_credentials'; providerName?: string }
  | { state: 'rate_limited'; providerName?: string }
  | { state: 'network'; providerName?: string; reason?: string }
  | { state: 'unavailable'; providerName: string; reason?: string }
  | {
      state: 'ok'
      providerName: string
      /** CatCodex/NewAPI token 名，如 cc-grok */
      tokenName?: string
      /** 钱包/套餐名（无痕 planName 等） */
      planName?: string
      /** true = 渠道标记不限额度 */
      unlimited: boolean
      remaining?: number | string
      unit?: string
      /** 累计消耗（渠道内部单位，不换算） */
      totalUsed?: number | string
      isValid: boolean
      fetchedAt: number
    }

type ClaudeProviderUsageOk = Extract<ClaudeProviderUsageSnapshot, { state: 'ok' }>

/** per-model cache：不同 Claude API 档位余额互不覆盖。 */
const cacheByModel = new Map<string, ClaudeProviderUsageSnapshot>()
const inFlightByModel = new Map<string, Promise<ClaudeProviderUsageSnapshot>>()

function firstPresent(...values: unknown[]): unknown {
  return values.find(v => v !== undefined && v !== null && v !== '')
}

function contentTypeIsJson(contentType: string | null): boolean {
  return /\bjson\b/i.test(contentType ?? '')
}

function rootFromBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/i, '')
}

/** CatCodex / New API 风格 host：走 /api/usage/token。 */
export function isNewApiUsageHost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host.includes('catcodex') || host.includes('newapi') || host.includes('new-api')
  } catch {
    return /catcodex|new-?api/i.test(baseUrl)
  }
}

function providerUsageEndpoint(baseUrl: string): { kind: 'newapi_token' | 'v1_usage'; url: string } {
  const root = rootFromBaseUrl(baseUrl)
  if (isNewApiUsageHost(baseUrl)) {
    return { kind: 'newapi_token', url: `${root}/api/usage/token` }
  }
  return { kind: 'v1_usage', url: `${root}/v1/usage` }
}

function snapshotFromV1Usage(providerName: string, response: any): ClaudeProviderUsageSnapshot {
  const remaining = firstPresent(response?.remaining, response?.quota?.remaining, response?.balance)
  if (remaining === undefined) {
    return {
      state: 'unavailable',
      providerName,
      reason: '余额接口未返回 remaining/balance',
    }
  }
  const unit = String(firstPresent(response?.unit, response?.quota?.unit, 'USD') ?? 'USD')
  const isValid = firstPresent(response?.is_active, response?.isValid, true) !== false
  const planName = typeof response?.planName === 'string' && response.planName
    ? response.planName
    : undefined
  return {
    state: 'ok',
    providerName,
    planName,
    unlimited: false,
    remaining: typeof remaining === 'number' ? remaining : String(remaining),
    unit,
    isValid,
    fetchedAt: Date.now(),
  }
}

function snapshotFromNewApiToken(providerName: string, response: any): ClaudeProviderUsageSnapshot {
  // NewAPI 常包一层 { code, data, message }
  const data = response?.data && typeof response.data === 'object' ? response.data : response
  if (!data || typeof data !== 'object') {
    return {
      state: 'unavailable',
      providerName,
      reason: 'token 用量接口返回空 data',
    }
  }

  const unlimited = data.unlimited_quota === true || data.unlimitedQuota === true
  const totalUsed = firstPresent(data.total_used, data.totalUsed)
  const remaining = firstPresent(data.total_available, data.totalAvailable, data.remain_quota, data.remainQuota)
  const tokenName = typeof data.name === 'string' && data.name ? data.name : undefined
  const isValid = firstPresent(data.is_active, data.isValid, true) !== false

  // 不限额度：仍可展示累计消耗；有限额度才强调 remaining。
  if (!unlimited && remaining === undefined && totalUsed === undefined) {
    return {
      state: 'unavailable',
      providerName,
      reason: 'token 用量接口未返回 total_used/remaining',
    }
  }

  const ok: ClaudeProviderUsageOk = {
    state: 'ok',
    providerName,
    tokenName,
    unlimited,
    isValid,
    fetchedAt: Date.now(),
  }
  if (totalUsed !== undefined) {
    ok.totalUsed = typeof totalUsed === 'number' ? totalUsed : String(totalUsed)
  }
  if (!unlimited && remaining !== undefined) {
    // NewAPI remain_quota 是内部计数单位，不是 USD —— 标 unit 为 quota，避免误导。
    ok.remaining = typeof remaining === 'number' ? remaining : String(remaining)
    ok.unit = 'quota'
  }
  return ok
}

function snapshotFromBody(
  kind: 'newapi_token' | 'v1_usage',
  providerName: string,
  body: string,
  contentType: string | null,
): ClaudeProviderUsageSnapshot {
  const text = body.trim()
  if (!text) {
    return { state: 'unavailable', providerName, reason: '渠道余额接口返回空响应' }
  }
  const looksJson = text.startsWith('{') || text.startsWith('[')
  if (!looksJson && !contentTypeIsJson(contentType)) {
    return {
      state: 'unavailable',
      providerName,
      reason: `渠道余额接口返回非 JSON${contentType ? ` (${contentType})` : ''}`,
    }
  }
  try {
    const json = JSON.parse(text)
    return kind === 'newapi_token'
      ? snapshotFromNewApiToken(providerName, json)
      : snapshotFromV1Usage(providerName, json)
  } catch {
    return {
      state: 'unavailable',
      providerName,
      reason: text.startsWith('<')
        ? `渠道余额接口返回非 JSON${contentType ? ` (${contentType})` : ''}`
        : '渠道余额接口 JSON 解析失败',
    }
  }
}

async function fetchClaudeProviderUsage(model: string): Promise<ClaudeProviderUsageSnapshot> {
  const profile = claudeModelProfile(model)
  const providerName = profile?.displayName || model
  if (!profile || profile.route !== 'api') {
    return { state: 'unavailable', providerName, reason: '非 Claude API 路由' }
  }

  const baseUrl = profile.env.ANTHROPIC_BASE_URL?.trim()
  const token = (profile.env.ANTHROPIC_AUTH_TOKEN || profile.env.ANTHROPIC_API_KEY || '').trim()
  if (!baseUrl || !token) {
    return { state: 'no_credentials', providerName }
  }

  const { kind, url } = providerUsageEndpoint(baseUrl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      signal: controller.signal,
    })
    if (res.status === 429) return { state: 'rate_limited', providerName }
    if (res.status === 401 || res.status === 403) {
      return { state: 'unavailable', providerName, reason: '渠道余额接口鉴权失败' }
    }
    if (res.status === 404) {
      return {
        state: 'unavailable',
        providerName,
        reason: kind === 'newapi_token' ? '渠道未提供 /api/usage/token' : '渠道未提供 /v1/usage',
      }
    }
    if (!res.ok) {
      return { state: 'unavailable', providerName, reason: `渠道余额接口 HTTP ${res.status}` }
    }
    return snapshotFromBody(kind, providerName, await res.text(), res.headers.get('content-type'))
  } catch (e: any) {
    const reason = e?.name === 'AbortError' ? `timeout after ${API_TIMEOUT_MS}ms` : (e?.message ?? String(e))
    log(`claude-provider-usage: fetch failed for ${providerName}: ${reason}`)
    return { state: 'network', providerName, reason }
  } finally {
    clearTimeout(timer)
  }
}

/** 解析器导出，供单测直接喂 JSON，不打网络。 */
export function claudeProviderUsageFromV1Response(providerName: string, response: any): ClaudeProviderUsageSnapshot {
  return snapshotFromV1Usage(providerName, response)
}

export function claudeProviderUsageFromNewApiTokenResponse(
  providerName: string,
  response: any,
): ClaudeProviderUsageSnapshot {
  return snapshotFromNewApiToken(providerName, response)
}

export async function readClaudeProviderUsage(model: string): Promise<ClaudeProviderUsageSnapshot> {
  const key = model.trim() || 'claude:unknown'
  const existing = inFlightByModel.get(key)
  if (existing) return existing

  const pending = fetchClaudeProviderUsage(key)
    .then(d => {
      inFlightByModel.delete(key)
      if (d.state === 'network') return cacheByModel.get(key) ?? d
      cacheByModel.set(key, d)
      return d
    })
    .catch(e => {
      log(`claude-provider-usage: fetch threw for ${key}: ${e}`)
      inFlightByModel.delete(key)
      return cacheByModel.get(key) ?? { state: 'network', reason: String(e) }
    })

  inFlightByModel.set(key, pending)
  return pending
}
