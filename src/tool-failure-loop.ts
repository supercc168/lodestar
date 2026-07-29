import { createHash } from 'node:crypto'

export const TOOL_FAILURE_CORRECT_REPEAT = 2
export const TOOL_FAILURE_STOP_REPEAT = 3

type ToolFailureLoopVerdictBase = {
  repeatCount: number
  fingerprintHash: string
  toolName: string
}

export type ToolFailureLoopVerdict =
  | (ToolFailureLoopVerdictBase & { type: 'none' })
  | (ToolFailureLoopVerdictBase & { type: 'correct' })
  | (ToolFailureLoopVerdictBase & { type: 'stop' })

function canonicalValue(value: unknown, stack: WeakSet<object>): unknown {
  if (value === undefined) return { $type: 'undefined' }
  if (typeof value === 'bigint') return { $type: 'bigint', value: String(value) }
  if (typeof value === 'function' || typeof value === 'symbol') {
    return { $type: typeof value, value: String(value) }
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { $type: 'number', value: String(value) }
  }
  if (!value || typeof value !== 'object') return value
  if (stack.has(value)) return { $type: 'circular' }

  stack.add(value)
  try {
    if (Array.isArray(value)) return value.map(item => canonicalValue(item, stack))
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      out[key] = canonicalValue(source[key], stack)
    }
    return out
  } finally {
    stack.delete(value)
  }
}

export function toolFailureFingerprint(
  toolName: string,
  input: unknown,
  error: unknown,
): string {
  const normalizedError = typeof error === 'string'
    ? error.trim().replace(/\r\n/g, '\n')
    : JSON.stringify(canonicalValue(error, new WeakSet()))
  const normalizedInput = JSON.stringify(canonicalValue(input, new WeakSet())) ?? String(input)
  return createHash('sha256')
    .update(toolName)
    .update('\0')
    .update(normalizedInput)
    .update('\0')
    .update(normalizedError)
    .digest('hex')
}

/** Counts only consecutive identical failures. Success, changed input, or a
 * changed error starts a fresh sequence, so ordinary one-off retries stay valid. */
export class ToolFailureLoopGuard {
  private fingerprintHash: string | null = null
  private repeatCount = 0

  observeFailure(toolName: string, input: unknown, error: unknown): ToolFailureLoopVerdict {
    const fingerprintHash = toolFailureFingerprint(toolName, input, error)
    if (fingerprintHash === this.fingerprintHash) this.repeatCount += 1
    else {
      this.fingerprintHash = fingerprintHash
      this.repeatCount = 1
    }

    const type: ToolFailureLoopVerdict['type'] = this.repeatCount === TOOL_FAILURE_CORRECT_REPEAT
        ? 'correct'
        : this.repeatCount === TOOL_FAILURE_STOP_REPEAT
          ? 'stop'
          : 'none'
    return {
      type,
      repeatCount: this.repeatCount,
      fingerprintHash,
      toolName,
    }
  }

  observeSuccess(): void {
    this.reset()
  }

  reset(): void {
    this.fingerprintHash = null
    this.repeatCount = 0
  }
}
