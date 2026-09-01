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

/** 管道加固版(上游 ec149d7):request 内建超时、stdin 写失败回调、
 * spawn error 自 finish、close SIGTERM→SIGKILL 升级。export + 构造器
 * bin/args 形参是本地测试缝(默认值即生产行为,假 app-server 测管道,
 * 不 spawn 真 codex),同 __setStoreFileForTest 范式。 */
export class AppServerOnce {
  private proc: ChildProcessByStdio<Writable, Readable, Readable>
  private buf = ''
  private nextId = 1
  private alive = true
  private exitPromise: Promise<void>
  private resolveExit!: () => void
  private pending = new Map<number, {
    resolve: (v: any) => void
    reject: (e: Error) => void
    method: string
    timer: ReturnType<typeof setTimeout>
  }>()

  constructor(
    bin: string = resolveCodexBin(),
    args: string[] = ['app-server', '--listen', 'stdio://'],
  ) {
    this.proc = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    }) as ChildProcessByStdio<Writable, Readable, Readable>
    this.exitPromise = new Promise(resolve => { this.resolveExit = resolve })
    this.proc.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk))
    this.proc.stderr.on('data', (chunk: Buffer) => {
      const s = chunk.toString().trim()
      if (s) log(`usage[codex stderr]: ${s}`)
    })
    const finish = (error: Error) => {
      if (!this.alive) return
      this.alive = false
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error(`${error.message}; pending ${p.method} id=${id}`))
      }
      this.pending.clear()
      this.resolveExit()
    }
    this.proc.on('error', error => finish(new Error(`codex app-server spawn failed: ${error.message}`)))
    this.proc.on('exit', (code, signal) => {
      finish(new Error(`codex app-server exited code=${code} signal=${signal}`))
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
      clearTimeout(pending.timer)
      if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)))
      else pending.resolve(msg.result)
    }
  }

  request(method: string, params: any, timeoutMs = API_TIMEOUT_MS): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      if (!this.alive) {
        reject(new Error(`codex app-server is not alive; cannot request ${method}`))
        return
      }
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(new Error(`codex app-server ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, method, timer })
      try {
        this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
          if (!error) return
          const pending = this.pending.get(id)
          if (!pending) return
          this.pending.delete(id)
          clearTimeout(pending.timer)
          pending.reject(new Error(`codex app-server write failed for ${method}: ${error.message}`))
        })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async close(timeoutMs = 2000): Promise<void> {
    if (!this.alive) return
    if (!this.proc.kill('SIGTERM')) throw new Error('codex app-server rejected SIGTERM')
    const exited = await Promise.race([
      this.exitPromise.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), timeoutMs)),
    ])
    if (exited) return
    if (!this.proc.kill('SIGKILL')) throw new Error('codex app-server rejected SIGKILL')
    const killed = await Promise.race([
      this.exitPromise.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), timeoutMs)),
    ])
    if (!killed) throw new Error(`codex app-server did not exit after SIGKILL (${timeoutMs}ms)`)
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

/** 窗口归类:codex 不保证 primary/secondary 位置语义 —— Prolite 等套餐把
 * 唯一的周窗口塞在 primary(secondary=null),Plus/Pro 才是 primary=5h +
 * secondary=周。按 windowDurationMins 真实时长归类(300→5h,10080→周),
 * 位置只作 fallback(时长缺失时)。 */
function classifyWindows(limits: any): { fiveHour: UsageWindow | null; weekly: UsageWindow | null } {
  const primary = windowFromRateLimit(limits?.primary)
  const secondary = windowFromRateLimit(limits?.secondary)
  const byDuration = (w: UsageWindow | null, mins: number): boolean =>
    w?.durationMins === mins
  if (byDuration(primary, 10_080) && byDuration(secondary, 300)) {
    // 未见过的倒挂形态(primary=周、secondary=5h),按时长纠正
    return { fiveHour: secondary, weekly: primary }
  }
  if (byDuration(primary, 10_080) && !secondary) {
    // Prolite 形态:唯一的周窗口在 primary
    return { fiveHour: null, weekly: primary }
  }
  if (byDuration(primary, 300) || (!primary?.durationMins && primary)) {
    // 常规 Plus/Pro:primary=5h;或时长缺失按位置
    if (primary && !primary.durationMins) {
      log(`usage: classifyWindows fallback by position (primary durationMins missing) — codex 新窗口形态,归类需回访`)
    }
    return { fiveHour: primary, weekly: secondary }
  }
  // primary 是其他时长(如自定义 individualLimit):按位置保守处理
  if (primary) {
    log(`usage: classifyWindows fallback by position (primary durationMins=${primary.durationMins}) — codex 新窗口形态,归类需回访`)
  }
  return { fiveHour: primary, weekly: secondary }
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
    ...classifyWindows(rateLimits),
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
      ...classifyWindows(limits),
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
