/**
 * ChatGPT/Codex usage snapshot for the `hi` console panel.
 *
 * Source: Codex app-server `account/read` + `account/rateLimits/read`.
 * This stays on the same auth path as the daemon itself: the user's
 * local `codex login` ChatGPT session.
 *
 * Third-party Codex routes (`codex:<slug>`) do not expose the official
 * ChatGPT rolling quota. For those routes we optionally query the
 * provider `/v1/usage` endpoint using the CCSwitch-compatible balance
 * response shape.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { config } from './config'
import { codexModelProfile } from './codex-models'
import { resolveCodexBin } from './codex-process'
import { log } from './log'

const API_TIMEOUT_MS = 10_000

export interface UsageWindow {
  percent: number | null
  resetsAt: Date | null
  durationMins?: number | null
}

export type UsageSnapshot =
  | { state: 'no_credentials' }
  | { state: 'auth_failed' }
  | { state: 'rate_limited' }
  | { state: 'network'; reason?: string }
  | {
      state: 'provider_usage'
      providerName: string
      remaining: number | string
      unit: string
      isValid: boolean
      fetchedAt: number
    }
  | {
      state: 'provider_unavailable'
      providerName: string
      reason?: string
    }
  | {
      state: 'ok'
      subscriptionType?: string
      fiveHour: UsageWindow | null
      weekly: UsageWindow | null
      fetchedAt: number
    }

type UsageSnapshotOk = Extract<UsageSnapshot, { state: 'ok' }>

let cache: UsageSnapshot | null = null
let inFlight: Promise<UsageSnapshot> | null = null

class AppServerOnce {
  private proc: ChildProcessByStdio<Writable, Readable, Readable>
  private buf = ''
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>()

  constructor() {
    this.proc = spawn(resolveCodexBin(), ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    }) as ChildProcessByStdio<Writable, Readable, Readable>
    this.proc.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk))
    this.proc.stderr.on('data', (chunk: Buffer) => {
      const s = chunk.toString().trim()
      if (s) log(`usage[codex stderr]: ${s}`)
    })
    this.proc.on('exit', (code, signal) => {
      for (const [id, p] of this.pending) {
        p.reject(new Error(`codex app-server exited before ${p.method} response id=${id} code=${code} signal=${signal}`))
      }
      this.pending.clear()
    })
  }

  private onStdout(chunk: Buffer): void {
    this.buf += chunk.toString()
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      let msg: any
      try { msg = JSON.parse(line) } catch { continue }
      if (!Object.prototype.hasOwnProperty.call(msg, 'id')) continue
      const pending = this.pending.get(msg.id)
      if (!pending) continue
      this.pending.delete(msg.id)
      if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)))
      else pending.resolve(msg.result)
    }
  }

  request(method: string, params: any): Promise<any> {
    const id = this.nextId++
    this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
    })
  }

  async close(): Promise<void> {
    try { this.proc.kill('SIGTERM') } catch {}
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    p.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e) })
  })
}

function clampPct(v: unknown): number | null {
  return typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(100, v)) : null
}

function windowFromRateLimit(w: any): UsageWindow | null {
  if (!w) return null
  return {
    percent: clampPct(w.usedPercent),
    resetsAt: typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000) : null,
    durationMins: typeof w.windowDurationMins === 'number' ? w.windowDurationMins : null,
  }
}

function providerUsageEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  const root = trimmed.replace(/\/v1$/i, '')
  return `${root}/v1/usage`
}

function firstPresent(...values: unknown[]): unknown {
  return values.find(v => v !== undefined && v !== null && v !== '')
}

function contentTypeIsJson(contentType: string | null): boolean {
  return /\bjson\b/i.test(contentType ?? '')
}

function providerUsageSnapshotFromBody(providerName: string, body: string, contentType: string | null): UsageSnapshot {
  const text = body.trim()
  if (!text) {
    return {
      state: 'provider_unavailable',
      providerName,
      reason: '渠道余额接口返回空响应',
    }
  }

  const looksJson = text.startsWith('{') || text.startsWith('[')
  if (!looksJson && !contentTypeIsJson(contentType)) {
    return {
      state: 'provider_unavailable',
      providerName,
      reason: `渠道余额接口返回非 JSON${contentType ? ` (${contentType})` : ''}`,
    }
  }

  try {
    return providerUsageSnapshotFromResponse(providerName, JSON.parse(text))
  } catch {
    return {
      state: 'provider_unavailable',
      providerName,
      reason: text.startsWith('<')
        ? `渠道余额接口返回非 JSON${contentType ? ` (${contentType})` : ''}`
        : '渠道余额接口 JSON 解析失败',
    }
  }
}

export function providerUsageSnapshotFromResponse(providerName: string, response: any): UsageSnapshot {
  const remaining = firstPresent(response?.remaining, response?.quota?.remaining, response?.balance)
  if (remaining === undefined) {
    return {
      state: 'provider_unavailable',
      providerName,
      reason: '余额接口未返回 remaining',
    }
  }
  const unit = firstPresent(response?.unit, response?.quota?.unit, 'USD')
  const isValid = firstPresent(response?.is_active, response?.isValid, true) !== false
  return {
    state: 'provider_usage',
    providerName,
    remaining: typeof remaining === 'number' ? remaining : String(remaining),
    unit: String(unit),
    isValid,
    fetchedAt: Date.now(),
  }
}

export function updateUsageFromRateLimits(rateLimits: any): UsageSnapshot {
  if (!rateLimits) return cache ?? { state: 'network', reason: 'empty rate limit update' }
  const snapshot: UsageSnapshotOk = {
    state: 'ok',
    subscriptionType: rateLimits.planType,
    fiveHour: windowFromRateLimit(rateLimits.primary),
    weekly: windowFromRateLimit(rateLimits.secondary),
    fetchedAt: Date.now(),
  }
  cache = snapshot
  return snapshot
}

async function fetchProviderUsage(model: string): Promise<UsageSnapshot | null> {
  const profile = codexModelProfile(model)
  if (!profile || profile.route !== 'api') return null
  const providerName = profile.displayName || profile.name
  const raw = config.codex.models[profile.name]
  const baseUrl = raw?.base_url?.trim()
  const apiKey = raw?.api_key?.trim()
  if (!baseUrl) {
    return {
      state: 'provider_unavailable',
      providerName,
      reason: '未配置 base_url',
    }
  }
  if (!apiKey) {
    return {
      state: 'provider_unavailable',
      providerName,
      reason: '未配置 api_key,无法查询渠道余额',
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
  try {
    const res = await fetch(providerUsageEndpoint(baseUrl), {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: controller.signal,
    })
    if (res.status === 429) return { state: 'rate_limited' }
    if (res.status === 401 || res.status === 403) {
      return {
        state: 'provider_unavailable',
        providerName,
        reason: '渠道余额接口鉴权失败',
      }
    }
    if (res.status === 404) {
      return {
        state: 'provider_unavailable',
        providerName,
        reason: '渠道未提供 /v1/usage',
      }
    }
    if (!res.ok) {
      return {
        state: 'provider_unavailable',
        providerName,
        reason: `渠道余额接口 HTTP ${res.status}`,
      }
    }
    return providerUsageSnapshotFromBody(providerName, await res.text(), res.headers.get('content-type'))
  } catch (e: any) {
    const reason = e?.name === 'AbortError' ? `timeout after ${API_TIMEOUT_MS}ms` : (e?.message ?? String(e))
    log(`usage: provider usage fetch failed for ${providerName}: ${reason}`)
    return {
      state: 'provider_unavailable',
      providerName,
      reason,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function fetchUsage(): Promise<UsageSnapshot> {
  const app = new AppServerOnce()
  try {
    await withTimeout(app.request('initialize', {
      clientInfo: { name: 'lodestar-usage', version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }), API_TIMEOUT_MS)

    const accountRes = await withTimeout(app.request('account/read', {}), API_TIMEOUT_MS)
    const account = accountRes?.account
    if (!account) return { state: 'no_credentials' }
    if (account.type !== 'chatgpt') return { state: 'auth_failed' }

    const limitsRes = await withTimeout(app.request('account/rateLimits/read', {}), API_TIMEOUT_MS)
    const limits = limitsRes?.rateLimitsByLimitId?.codex ?? limitsRes?.rateLimits
    if (!limits) return { state: 'network', reason: 'empty rate limit response' }
    return {
      state: 'ok',
      subscriptionType: account.planType ?? limits.planType ?? 'chatgpt',
      fiveHour: windowFromRateLimit(limits.primary),
      weekly: windowFromRateLimit(limits.secondary),
      fetchedAt: Date.now(),
    }
  } catch (e: any) {
    log(`usage: codex app-server usage failed: ${e?.message ?? e}`)
    return { state: 'network', reason: e?.message ?? String(e) }
  } finally {
    await app.close()
  }
}

/** 读最近一次 usage cache,不触发 fetch。给 turn footer 用 —— codex turn
 * 中 `updateUsageFromRateLimits` 已把当轮 rateLimit 写进 cache,这里直接
 * 复用,避免每轮 turn 都为拿一个百分比去 spawn 一个 codex app-server
 * 子进程(readUsage 的代价)。cache 为空(turn 中没收到 rateLimit)返回 null,
 * 调用方按 no_fallbacks 省略 5h 段。 */
export function peekUsage(): UsageSnapshot | null {
  return cache
}

export async function readUsage(model?: string): Promise<UsageSnapshot> {
  if (model) {
    const providerUsage = await fetchProviderUsage(model)
    if (providerUsage) return providerUsage
  }

  if (inFlight) return inFlight

  inFlight = fetchUsage()
    .then(d => {
      inFlight = null
      if (d.state === 'network') return cache ?? d
      cache = d
      return d
    })
    .catch(e => {
      log(`usage: fetchUsage threw: ${e}`)
      inFlight = null
      return cache ?? { state: 'network', reason: String(e) }
    })
  return inFlight
}
