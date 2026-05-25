/**
 * ChatGPT/Codex usage snapshot for the `hi` console panel.
 *
 * Source: Codex app-server `account/read` + `account/rateLimits/read`.
 * This stays on the same auth path as the daemon itself: the user's
 * local `codex login` ChatGPT session.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { resolveCodexBin } from './codex-process'
import { log } from './log'

const API_TIMEOUT_MS = 10_000
const CACHE_TTL_MS = 60_000
const MAX_STALE_MS = 15 * 60 * 1000

export interface UsageWindow {
  percent: number
  resetsAt: Date | null
  durationMins?: number | null
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
      stale?: boolean
    }

type UsageSnapshotOk = Extract<UsageSnapshot, { state: 'ok' }>

let cache: { data: UsageSnapshot; at: number } | null = null
let lastOk: { snapshot: UsageSnapshotOk; at: number } | null = null
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

function clampPct(v: unknown): number {
  return typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(100, v)) : 0
}

function windowFromRateLimit(w: any): UsageWindow | null {
  if (!w) return null
  return {
    percent: clampPct(w.usedPercent),
    resetsAt: typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000) : null,
    durationMins: typeof w.windowDurationMins === 'number' ? w.windowDurationMins : null,
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

function withStaleFallback(snapshot: UsageSnapshot): UsageSnapshot {
  if (snapshot.state === 'ok') return snapshot
  if (lastOk && Date.now() - lastOk.at < MAX_STALE_MS) {
    return { ...lastOk.snapshot, stale: true }
  }
  return snapshot
}

export async function readUsage(): Promise<UsageSnapshot> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return withStaleFallback(cache.data)
  if (inFlight) return inFlight
  inFlight = fetchUsage()
    .then(d => {
      cache = { data: d, at: Date.now() }
      if (d.state === 'ok') lastOk = { snapshot: d, at: Date.now() }
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
