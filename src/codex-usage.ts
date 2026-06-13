import type { CodexUsage } from './codex-process'

function objectOrNull(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === 'object' ? v as Record<string, unknown> : null
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function anyUsageValue(usage: CodexUsage): boolean {
  return Object.values(usage).some(v => typeof v === 'number' && Number.isFinite(v))
}

function nestedNumber(obj: Record<string, unknown> | null, key: string): number | undefined {
  return obj ? numberOrUndefined(obj[key]) : undefined
}

export function usageFromTokenUsagePayload(raw: unknown): CodexUsage | null {
  const obj = objectOrNull(raw)
  if (!obj) return null
  const inputDetails = objectOrNull(obj.inputTokensDetails) ?? objectOrNull(obj.input_tokens_details)
  const outputDetails = objectOrNull(obj.outputTokensDetails) ?? objectOrNull(obj.output_tokens_details)
  const usage: CodexUsage = {
    total_tokens: numberOrUndefined(obj.totalTokens ?? obj.total_tokens),
    input_tokens: numberOrUndefined(obj.inputTokens ?? obj.input_tokens),
    output_tokens: numberOrUndefined(obj.outputTokens ?? obj.output_tokens),
    reasoning_output_tokens: numberOrUndefined(
      obj.reasoningOutputTokens ??
      obj.reasoning_output_tokens ??
      nestedNumber(outputDetails, 'reasoningTokens') ??
      nestedNumber(outputDetails, 'reasoning_tokens'),
    ),
    cache_creation_input_tokens: numberOrUndefined(
      obj.cacheCreationInputTokens ?? obj.cache_creation_input_tokens,
    ),
    cache_read_input_tokens: numberOrUndefined(
      obj.cachedInputTokens ??
      obj.cached_input_tokens ??
      obj.cacheReadInputTokens ??
      obj.cache_read_input_tokens ??
      nestedNumber(inputDetails, 'cachedTokens') ??
      nestedNumber(inputDetails, 'cached_tokens'),
    ),
  }
  return anyUsageValue(usage) ? usage : null
}

export function diffUsageTotals(
  total: CodexUsage | null | undefined,
  baseline: CodexUsage | null | undefined,
): CodexUsage | null {
  const deltaField = (key: keyof CodexUsage): number | undefined => {
    const totalVal = numberOrUndefined(total?.[key])
    const baselineVal = numberOrUndefined(baseline?.[key])
    if (totalVal === undefined && baselineVal === undefined) return undefined
    return Math.max(0, (totalVal ?? 0) - (baselineVal ?? 0))
  }
  const usage: CodexUsage = {
    total_tokens: deltaField('total_tokens'),
    input_tokens: deltaField('input_tokens'),
    output_tokens: deltaField('output_tokens'),
    reasoning_output_tokens: deltaField('reasoning_output_tokens'),
    cache_creation_input_tokens: deltaField('cache_creation_input_tokens'),
    cache_read_input_tokens: deltaField('cache_read_input_tokens'),
  }
  return anyUsageValue(usage) ? usage : null
}

export function effectiveTurnTokens(usage: CodexUsage | null | undefined): number | null {
  if (!usage) return null
  return (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0)
}

