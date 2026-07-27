/** 共享时长格式化 —— background / automation 状态卡共用。
 *  ms → "45s" / "2m13s" / "1h5m"。 */
export function fmtElapsed(ms: number): string {
  if (!ms || ms < 0) return '0s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60}m`
}

const LIVE_ELAPSED_BUCKETS = [
  { limitMs: 30_000, label: '<30s' },
  { limitMs: 60_000, label: '<1m' },
  { limitMs: 180_000, label: '<3m' },
  { limitMs: 300_000, label: '<5m' },
  { limitMs: 600_000, label: '<10m' },
] as const

const TEN_MINUTES_MS = 600_000

/**
 * Coarse elapsed label for live card status plus the delay until it changes.
 * Callers can schedule one update per boundary instead of pushing every second.
 */
export function elapsedBucket(elapsedMs: number): { label: string; nextDelayMs: number } {
  const ms = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0
  for (const bucket of LIVE_ELAPSED_BUCKETS) {
    if (ms < bucket.limitMs) {
      return { label: bucket.label, nextDelayMs: bucket.limitMs - ms }
    }
  }

  const completedSteps = Math.floor((ms - TEN_MINUTES_MS) / TEN_MINUTES_MS)
  const nextBoundary = TEN_MINUTES_MS + (completedSteps + 1) * TEN_MINUTES_MS
  return {
    label: `${(completedSteps + 1) * 10}m+`,
    nextDelayMs: nextBoundary - ms,
  }
}
