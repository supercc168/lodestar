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

/** 活跃 footer / 后台卡 header 的耗时展示模式。
 *  - `bucket`: 粗档位 (`<30s`/`<1m`/…)，只在档位边界 push（默认，省飞书配额）
 *  - `second`: 旧行为，按秒显示并每秒/每 2s push */
export type LiveElapsedMode = 'bucket' | 'second'

const LIVE_ELAPSED_BUCKETS = [
  { limitMs: 30_000, label: '<30s' },
  { limitMs: 60_000, label: '<1m' },
  { limitMs: 180_000, label: '<3m' },
  { limitMs: 300_000, label: '<5m' },
  { limitMs: 600_000, label: '<10m' },
] as const

const TEN_MINUTES_MS = 600_000

/** second 模式下 footer / 后台卡前 10m 都按 1s tick(对齐旧 FOOTER_STATUS_TICK_MS)。 */
export const LIVE_ELAPSED_SECOND_FOOTER_TICK_MS = 1000

/** second 模式超 10m 后切粗档位,治「等用户答 AskUserQuestion 时 footer 无限按秒计到
 *  隔夜 / 一两天」——前 10m 仍按秒,之后只在 5m 边界 push 一次(10m+ / 15m+ / 20m+…)。
 *  颗粒度 5m(细于 bucket 的 10m):second 本就是「想看精确」,超 10m 后也不宜一下跳太粗。*/
const SECOND_BUCKET_BASE_MS = 600_000
const SECOND_BUCKET_STEP_MS = 300_000

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

/**
 * Live elapsed for footer / background headers.
 * `bucket` → coarse label + delay to next boundary;
 * `second` → `Ns` label + 1s delay for the first 10m, then 5m-granularity
 * buckets (`10m+`/`15m+`/…) pushed only at boundaries (footer 与后台卡同源)。
 */
export function liveElapsed(
  elapsedMs: number,
  mode: LiveElapsedMode = 'bucket',
): { label: string; nextDelayMs: number } {
  if (mode === 'second') {
    const ms = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0
    // 超 10m 不再按秒:改 5m 颗粒度档位 10m+ / 15m+ / 20m+…,只在 5m 边界 push。
    if (ms >= SECOND_BUCKET_BASE_MS) {
      const idx = Math.floor((ms - SECOND_BUCKET_BASE_MS) / SECOND_BUCKET_STEP_MS)
      const nextBoundary = SECOND_BUCKET_BASE_MS + (idx + 1) * SECOND_BUCKET_STEP_MS
      return { label: `${10 + idx * 5}m+`, nextDelayMs: nextBoundary - ms }
    }
    return {
      label: `${Math.floor(ms / 1000)}s`,
      nextDelayMs: LIVE_ELAPSED_SECOND_FOOTER_TICK_MS,
    }
  }
  return elapsedBucket(elapsedMs)
}
