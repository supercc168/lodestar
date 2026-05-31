import type { CodexUsage } from './codex-process'

const CONTEXT_BASELINE_TOKENS = 12_000

/** Latest model-call totalTokens is the current active context size.
 * cachedInputTokens is only a cache-hit breakdown inside inputTokens, not
 * additional context. */
export function contextTokensFromUsage(usage: CodexUsage | null | undefined): number | null {
  if (!usage) return null
  return typeof usage.total_tokens === 'number' && Number.isFinite(usage.total_tokens)
    ? usage.total_tokens
    : null
}

export function contextLimitFromAppServer(window: number | null | undefined): number | null {
  return typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : null
}

export function contextRemainingPercent(tokens: number, limit: number | null | undefined): number | null {
  if (limit == null || limit <= 0) return null
  if (limit <= CONTEXT_BASELINE_TOKENS) return 0
  const effectiveWindow = limit - CONTEXT_BASELINE_TOKENS
  const used = Math.max(0, tokens - CONTEXT_BASELINE_TOKENS)
  const remaining = Math.max(0, effectiveWindow - used)
  return Math.round(Math.min(100, Math.max(0, (remaining / effectiveWindow) * 100)))
}

export function contextUsedPercent(tokens: number, limit: number | null | undefined): number | null {
  const remaining = contextRemainingPercent(tokens, limit)
  return remaining == null ? null : Math.min(100, Math.max(0, 100 - remaining))
}
