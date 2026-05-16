/**
 * Subscription usage snapshot for the `hi` console panel.
 *
 * Source: Anthropic 官方 OAuth Usage API —— `GET /api/oauth/usage`.
 * 不再依赖外部 ccusage CLI。
 *
 * 凭据来源: `~/.claude/.credentials.json`(Linux 服务器,无 macOS
 * Keychain 分支)。结构由 Claude Code 写入,我们读 `claudeAiOauth`
 * 字段拿 access_token / refresh_token / expires_at / subscriptionType /
 * rateLimitTier。
 *
 * access_token 过期时,用 refresh_token 调 platform.claude.com
 * `/v1/oauth/token` 刷新,刷新成功后原子写回凭据文件
 * (tmp + rename),保证多进程并发安全。
 *
 * 失败可见 (no_fallbacks):
 *   - 凭据缺失      → state='no_credentials'
 *   - 刷新也失败    → state='auth_failed'
 *   - API 返回 429  → state='rate_limited' (+ resetsAt 可选)
 *   - 其它网络异常  → state='network'
 *
 * 卡片渲染层 (`cards.consoleUsageContent`) 按 state 分别显示具体原因,
 * 不静默回退到旧值,不伪造百分比。
 *
 * Lodestar 启动后,每次 `hi` 弹板都会拉一次;CACHE_TTL_MS 内的重复
 * 调用共享同一份快照,不打 API。in-flight 去重保证并发的多个
 * 群同时唤出控制台时只触发一次后台请求。
 *
 * Stale fallback (照 omchud HUD 规则): 单独记最后一次成功拉到的
 * `state:'ok'` 快照,本次拉取失败 (network/rate_limited/auth_failed)
 * 且距上次成功 <= MAX_STALE_MS (15 分钟) 时,返回上次的 ok 快照并打
 * `stale:true` 标签,卡片层加 "缓存 Xm 前" 提示。这是 no_fallbacks
 * 规则的显式例外 —— 用户明确要求订阅额度面板用缓存兜底,因为短暂
 * 网络抖动里把面板上的数字抹成红色"拉取失败"信息密度反而更低。
 *
 * 429 指数退避: 收到 rate_limited 时增加 rateLimitedCount,下次允许
 * 实拉的时间设为 now + CACHE_TTL_MS * 2^(count-1),封顶 5 分钟。
 * 退避窗口内的 readUsage 直接走 stale fallback,不打 API。任何非 429
 * 的响应 (ok / network / auth_failed) 都会重置计数器。
 *
 * 参考实现: oh-my-claudecode HUD `src/hud/usage-api.ts`。这里只保留
 * Lodestar 用得到的最小子集 —— 不处理 keychain、不处理第三方网关
 * (z.ai / MiniMax)、不处理 enterprise 货币换算、不做多文件 cache 与
 * 文件锁。
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { log } from './log'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const TOKEN_REFRESH_URL = 'https://platform.claude.com/v1/oauth/token'
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const API_TIMEOUT_MS = 10_000
const CACHE_TTL_MS = 60_000
/** 失败时回退到上次成功快照的最大年龄。超过此值就不再用缓存兜底,
 * 显示真实失败状态 —— 跟 omchud HUD 的 MAX_STALE_DATA_MS 对齐。 */
const MAX_STALE_MS = 15 * 60 * 1000
/** 429 退避封顶,跟 omchud HUD 的 MAX_RATE_LIMITED_BACKOFF_MS 对齐。 */
const RATE_LIMITED_MAX_BACKOFF_MS = 5 * 60 * 1000

function credentialsPath(): string {
  return join(homedir(), '.claude', '.credentials.json')
}

interface OAuthCredentials {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  subscriptionType?: string
  rateLimitTier?: string
}

export interface UsageWindow {
  /** 0-100, Anthropic 直接返回的 utilization 真实值 */
  percent: number
  /** 这个窗口何时重置;ISO 解析失败则 null */
  resetsAt: Date | null
}

export type UsageSnapshot =
  | { state: 'no_credentials' }
  | { state: 'auth_failed' }
  | { state: 'rate_limited' }
  | { state: 'network'; reason?: string }
  | {
      state: 'ok'
      subscriptionType?: string
      fiveHour: UsageWindow | null
      weekly: UsageWindow | null
      fetchedAt: number
      /** true 时本快照不是这次实拉的,而是 lastOk 兜底回来的旧数据。
       * 卡片层据此显示 "缓存" 标记 + 重置时间加 `~` 前缀。 */
      stale?: boolean
    }

type UsageSnapshotOk = Extract<UsageSnapshot, { state: 'ok' }>

let cache: { data: UsageSnapshot; at: number } | null = null
/** 最近一次 state:'ok' 的快照,用于失败时兜底。和 cache 分开存:
 * cache 是短时去重 (60s),lastOk 是长尾兜底 (15min)。 */
let lastOk: { snapshot: UsageSnapshotOk; at: number } | null = null
let inFlight: Promise<UsageSnapshot> | null = null
/** 连续 429 计数,用于指数退避;遇到任何非 429 响应就重置为 0。 */
let rateLimitedCount = 0
/** 在这个时间戳之前不打 API,直接走 stale fallback。 */
let rateLimitedUntil = 0

function rateLimitedBackoffMs(count: number): number {
  return Math.min(
    CACHE_TTL_MS * Math.pow(2, Math.max(0, count - 1)),
    RATE_LIMITED_MAX_BACKOFF_MS,
  )
}

function readCredentials(): OAuthCredentials | null {
  const path = credentialsPath()
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw)
    const creds = parsed.claudeAiOauth ?? parsed
    if (!creds?.accessToken) return null
    return {
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      expiresAt: creds.expiresAt,
      subscriptionType: creds.subscriptionType,
      rateLimitTier: creds.rateLimitTier,
    }
  } catch (e) {
    log(`usage: read credentials failed: ${e}`)
    return null
  }
}

/** 把刷新后的 access_token / refresh_token / expires_at 原子写回原文件,
 * 保留其它字段(scopes、subscriptionType、organizationUuid 等)。
 * 走 tmp + rename 防止半写状态被读到。 */
function writeBackCredentials(updated: OAuthCredentials): void {
  const path = credentialsPath()
  if (!existsSync(path)) return
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const target = parsed.claudeAiOauth ?? parsed
    target.accessToken = updated.accessToken
    if (updated.refreshToken) target.refreshToken = updated.refreshToken
    if (updated.expiresAt != null) target.expiresAt = updated.expiresAt
    const tmp = `${path}.tmp.${process.pid}`
    try {
      writeFileSync(tmp, JSON.stringify(parsed, null, 2), { mode: 0o600 })
      renameSync(tmp, path)
    } catch (e) {
      try { if (existsSync(tmp)) unlinkSync(tmp) } catch {}
      throw e
    }
  } catch (e) {
    log(`usage: writeBackCredentials failed: ${e}`)
  }
}

function isExpired(creds: OAuthCredentials): boolean {
  return creds.expiresAt != null && creds.expiresAt <= Date.now()
}

async function refreshAccessToken(refreshToken: string): Promise<OAuthCredentials | null> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  }).toString()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS)
  try {
    const res = await fetch(TOKEN_REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: ctrl.signal,
    })
    if (res.status !== 200) {
      log(`usage: token refresh HTTP ${res.status}`)
      return null
    }
    const json = await res.json() as any
    if (!json?.access_token) return null
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? refreshToken,
      expiresAt: json.expires_in
        ? Date.now() + json.expires_in * 1000
        : json.expires_at,
    }
  } catch (e) {
    log(`usage: token refresh threw: ${e}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

interface UsageApiResponse {
  five_hour?: { utilization?: number; resets_at?: string }
  seven_day?: { utilization?: number; resets_at?: string }
}

function parseDate(s: string | undefined): Date | null {
  if (!s) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

function clampPct(v: number | undefined): number {
  if (v == null || !isFinite(v)) return 0
  return Math.max(0, Math.min(100, v))
}

interface FetchResult {
  data: UsageApiResponse | null
  /** 失败原因:undefined = 成功;其它字符串是分类错误。 */
  reason?: 'rate_limited' | 'network'
  detail?: string
}

async function fetchUsageFromApi(accessToken: string): Promise<FetchResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS)
  try {
    const res = await fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
      signal: ctrl.signal,
    })
    if (res.status === 200) {
      const data = await res.json() as UsageApiResponse
      return { data }
    }
    if (res.status === 429) return { data: null, reason: 'rate_limited' }
    return { data: null, reason: 'network', detail: `HTTP ${res.status}` }
  } catch (e: any) {
    return { data: null, reason: 'network', detail: e?.message ?? String(e) }
  } finally {
    clearTimeout(timer)
  }
}

async function fetchUsage(): Promise<UsageSnapshot> {
  let creds = readCredentials()
  if (!creds) return { state: 'no_credentials' }

  if (isExpired(creds)) {
    if (!creds.refreshToken) return { state: 'auth_failed' }
    const refreshed = await refreshAccessToken(creds.refreshToken)
    if (!refreshed) return { state: 'auth_failed' }
    creds = { ...creds, ...refreshed }
    writeBackCredentials(creds)
  }

  const result = await fetchUsageFromApi(creds.accessToken)
  if (result.reason === 'rate_limited') return { state: 'rate_limited' }
  if (result.reason === 'network' || !result.data) return { state: 'network', reason: result.detail }

  const data = result.data
  const fiveHour = data.five_hour?.utilization != null
    ? { percent: clampPct(data.five_hour.utilization), resetsAt: parseDate(data.five_hour.resets_at) }
    : null
  const weekly = data.seven_day?.utilization != null
    ? { percent: clampPct(data.seven_day.utilization), resetsAt: parseDate(data.seven_day.resets_at) }
    : null

  return {
    state: 'ok',
    subscriptionType: creds.subscriptionType,
    fiveHour,
    weekly,
    fetchedAt: Date.now(),
  }
}

/** 失败快照 → 如果 MAX_STALE_MS 内还有 lastOk,就返回 lastOk 的副本
 * (打 stale 标);否则透传失败快照。state:'ok' 走 fast path 原样返回。 */
function withStaleFallback(snapshot: UsageSnapshot): UsageSnapshot {
  if (snapshot.state === 'ok') return snapshot
  if (lastOk && Date.now() - lastOk.at < MAX_STALE_MS) {
    return { ...lastOk.snapshot, stale: true }
  }
  return snapshot
}

/** 返回订阅额度快照。CACHE_TTL_MS 内的重复调用读缓存;并发请求去重为
 * 单次后台 fetch。拉取失败但 lastOk 仍在 MAX_STALE_MS 内时,回退到
 * lastOk 并打 stale 标。连续 429 走指数退避,退避窗口内不打 API。
 * 永不抛出 —— 失败状态由 `state` 字段表达,卡片层按 state 分支渲染。 */
export async function readUsage(): Promise<UsageSnapshot> {
  // 429 退避窗口内不打 API。cache 里可能存的就是 rate_limited 失败态,
  // withStaleFallback 会自动用 lastOk 顶上(15min 内)。
  if (Date.now() < rateLimitedUntil) {
    return withStaleFallback(cache?.data ?? { state: 'rate_limited' })
  }
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return withStaleFallback(cache.data)
  if (inFlight) return inFlight
  inFlight = fetchUsage()
    .then(d => {
      cache = { data: d, at: Date.now() }
      if (d.state === 'ok') lastOk = { snapshot: d, at: Date.now() }
      if (d.state === 'rate_limited') {
        rateLimitedCount += 1
        rateLimitedUntil = Date.now() + rateLimitedBackoffMs(rateLimitedCount)
      } else {
        rateLimitedCount = 0
        rateLimitedUntil = 0
      }
      inFlight = null
      return withStaleFallback(d)
    })
    .catch(e => {
      log(`usage: fetchUsage threw: ${e}`)
      inFlight = null
      return withStaleFallback({ state: 'network', reason: String(e) })
    })
  return inFlight
}
