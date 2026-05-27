import type { CodexUsage } from './codex-process'

/** Latest model-call input size is the current context-window occupancy.
 * cachedInputTokens is only a cache-hit breakdown inside inputTokens, not
 * additional context. */
export function contextTokensFromUsage(usage: CodexUsage | null | undefined): number {
  return usage?.input_tokens ?? 0
}

export function contextLimitForModel(model: string | null | undefined): number | null {
  if (!model) return null

  const normalized = model.toLowerCase()
  if (normalized === 'gpt-5.5' || normalized.startsWith('gpt-5.5')) return 1_000_000
  if (normalized === 'gpt-5.4' || normalized.startsWith('gpt-5.4-')) return 1_050_000
  if (normalized === 'gpt-4.1' || normalized.startsWith('gpt-4.1-')) return 1_000_000

  return null
}

export function contextPercent(tokens: number, limit: number | null | undefined): number | null {
  if (limit == null || limit <= 0) return null
  return Math.round((tokens / limit) * 100)
}
