/**
 * Subscription usage snapshot for the `hi` console panel.
 *
 * Source: the `ccusage` CLI (https://github.com/ryoppippi/ccusage), which
 * parses Claude Code's local JSONL transcripts on demand. We shell out
 * twice in parallel and cache the merged result for CACHE_TTL_MS.
 *
 *   - `blocks --active --token-limit max` → current 5h billing block.
 *     `tokenLimitStatus.limit` is ccusage's "peak historical block"
 *     value, used as the denominator for the 5h percentage. NOTE:
 *     this is consumption relative to your own heaviest 5h ever —
 *     NOT the Anthropic tier quota (which we have no way to read
 *     without OAuth roundtrips). It's an internally-consistent burn
 *     indicator, not an official quota gauge.
 *
 *   - `weekly --order desc` → list of weekly aggregates, newest first.
 *     ccusage's weekly doesn't expose tokenLimitStatus, so we compute
 *     the same "peak historical week" ratio locally.
 *
 * Failures stay visible (no fallback fabrication):
 *   - ccusage not on PATH → `installed: false` → card renders install hint.
 *   - ccusage runs but yields nothing → `fiveHour: null`, `weekly: null`.
 */

import { spawn } from 'node:child_process'
import { log } from './log'

const CCUSAGE_BIN = 'ccusage'
const CACHE_TTL_MS = 60_000
const SPAWN_TIMEOUT_MS = 15_000

export interface FiveHourBlock {
  costUsd: number
  totalTokens: number
  /** End of the current 5h billing window per ccusage. */
  windowEndsAt: Date
  /** Tokens/min over the current window, if ccusage reported one. */
  burnRatePerMin: number | null
  /** Consumption vs. user's historical peak 5h block (0–100). Null
   * when ccusage hasn't built a peak yet (very new install). */
  percentUsed: number | null
  /** Minutes left in this 5h window per ccusage's projection. */
  remainingMinutes: number | null
}

export interface WeeklyAggregate {
  /** ISO date of this week's start, format ccusage chose (Sun by default). */
  weekStart: string
  costUsd: number
  totalTokens: number
  /** Consumption vs. user's historical peak week (0–100). Null when
   * there's no prior week to compare against. */
  percentUsed: number | null
  /** Fractional days remaining until end of week (start + 7d). */
  remainingDays: number | null
}

export type UsageSnapshot =
  | { installed: false }
  | {
      installed: true
      fiveHour: FiveHourBlock | null
      weekly: WeeklyAggregate | null
      /** When this snapshot was computed. */
      fetchedAt: number
    }

function clampPct(v: number): number {
  if (!isFinite(v)) return 0
  return Math.max(0, Math.min(100, v))
}

let cache: { data: UsageSnapshot; at: number } | null = null
let inFlight: Promise<UsageSnapshot> | null = null

/** `null` = not on PATH (ENOENT); `undefined` = ran but failed (timeout,
 * non-zero exit, JSON parse error). Distinct so the caller can render
 * different UX. */
type RunResult = any | null | undefined

function runCcusage(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let proc
    try {
      proc = spawn(CCUSAGE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e: any) {
      if (e?.code === 'ENOENT') return resolve(null)
      log(`ccusage spawn threw: ${e}`)
      return resolve(undefined)
    }

    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      log(`ccusage ${args.join(' ')}: timeout after ${SPAWN_TIMEOUT_MS}ms`)
    }, SPAWN_TIMEOUT_MS)

    proc.on('error', (err: any) => {
      clearTimeout(timer)
      if (err?.code === 'ENOENT') resolve(null)
      else { log(`ccusage error: ${err}`); resolve(undefined) }
    })
    proc.stdout!.on('data', (b) => { stdout += b.toString() })
    proc.stderr!.on('data', (b) => { stderr += b.toString() })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        log(`ccusage ${args.join(' ')}: exit ${code} stderr=${stderr.slice(0, 200)}`)
        return resolve(undefined)
      }
      try { resolve(JSON.parse(stdout)) }
      catch (e) { log(`ccusage JSON parse: ${e}`); resolve(undefined) }
    })
  })
}

async function fetchUsage(): Promise<UsageSnapshot> {
  const [blocks, weekly] = await Promise.all([
    // --active filters to the current 5h block (cheaper to parse).
    // --token-limit max derives a cap from the user's peak historical
    // block so ccusage emits `tokenLimitStatus`, giving us a numerator+
    // denominator without us reading every block ourselves.
    runCcusage(['blocks', '--json', '--active', '--token-limit', 'max']),
    runCcusage(['weekly', '--json', '--order', 'desc']),
  ])

  if (blocks === null || weekly === null) return { installed: false }

  let fiveHour: FiveHourBlock | null = null
  if (blocks && Array.isArray(blocks.blocks)) {
    const active = blocks.blocks.find((b: any) => b?.isActive && !b?.isGap)
    if (active) {
      const totalTokens = Number(active.totalTokens) || 0
      const limit = Number(active.tokenLimitStatus?.limit) || 0
      fiveHour = {
        costUsd: Number(active.costUSD) || 0,
        totalTokens,
        windowEndsAt: new Date(active.endTime),
        burnRatePerMin: typeof active.burnRate?.tokensPerMinute === 'number'
          ? active.burnRate.tokensPerMinute : null,
        percentUsed: limit > 0 ? clampPct((totalTokens / limit) * 100) : null,
        remainingMinutes: typeof active.projection?.remainingMinutes === 'number'
          ? active.projection.remainingMinutes : null,
      }
    }
  }

  let wk: WeeklyAggregate | null = null
  if (weekly && Array.isArray(weekly.weekly) && weekly.weekly.length > 0) {
    const current = weekly.weekly[0]
    const totalTokens = Number(current.totalTokens) || 0
    // Peak historical week (excluding the current one — comparing
    // against itself would always read 100%). When this is the only
    // recorded week we leave percentUsed null.
    const peakTokens = weekly.weekly.slice(1).reduce(
      (m: number, w: any) => Math.max(m, Number(w?.totalTokens) || 0), 0)
    const percentUsed = peakTokens > 0 ? clampPct((totalTokens / peakTokens) * 100) : null
    // Week end = weekStart + 7 days. ccusage emits weekStart as YYYY-MM-DD;
    // parse as UTC so DST/timezone shifts don't drift the countdown.
    const weekStartIso = String(current.week ?? '')
    let remainingDays: number | null = null
    if (weekStartIso) {
      const start = new Date(weekStartIso + 'T00:00:00Z')
      if (!isNaN(start.getTime())) {
        const endMs = start.getTime() + 7 * 24 * 60 * 60 * 1000
        remainingDays = Math.max(0, (endMs - Date.now()) / (24 * 60 * 60 * 1000))
      }
    }
    wk = {
      weekStart: weekStartIso,
      costUsd: Number(current.totalCost) || 0,
      totalTokens,
      percentUsed,
      remainingDays,
    }
  }

  return { installed: true, fiveHour, weekly: wk, fetchedAt: Date.now() }
}

/** Returns a usage snapshot. Cached for CACHE_TTL_MS; concurrent callers
 * dedupe to a single in-flight ccusage run. First call after stale-out
 * pays the full ccusage cost (~5s on this machine); subsequent reads are
 * instant. Never throws — returns `{ installed: false }` if ccusage is
 * missing, or an empty `{ installed: true, fiveHour: null, ... }` if it
 * runs but yields no data. */
export async function readUsage(): Promise<UsageSnapshot> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data
  if (inFlight) return inFlight
  inFlight = fetchUsage().then(d => {
    cache = { data: d, at: Date.now() }
    inFlight = null
    return d
  }).catch(e => {
    log(`usage: fetchUsage threw: ${e}`)
    inFlight = null
    return cache?.data ?? { installed: false }
  })
  return inFlight
}
