import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { config } from './config'
import type { ClaudeQuotaRank } from './claude-quota'

/** Codex Sol identity suggested when the Claude subscription pool cannot take another run. */
export const CLAUDE_SUB_FALLBACK_IDENTITY = 'agent:Y29kZXgtc3ViAGdwdC02LjEtc29s'

export const DEFAULT_CLAUDE_SUB_MAX_CONCURRENT = 4
export const DEFAULT_CLAUDE_SUB_MAX_PER_ACCOUNT = 2
/** A Claude subscription account whose five-hour window is at or above this used % takes no new Agent runs. */
export const CLAUDE_SUB_FIVE_HOUR_MAX_USED = 80
/** A Claude subscription account whose applicable weekly window is at or above this used % is excluded. */
export const CLAUDE_SUB_WEEKLY_MAX_USED = 90

export interface ClaudeSubAgentLimits {
  /** Concurrent claude-sub Agent workers across all accounts (queued for a collision lock included). */
  global: number
  /** Concurrent claude-sub Agent workers on one account. */
  perAccount: number
  fiveHourMaxUsed: number
  weeklyMaxUsed: number
}

function positiveInt(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim())
  return Number.isSafeInteger(value) && value >= 1 ? value : undefined
}

/**
 * Environment overrides win over `[agent]` in config.toml; both are optional so
 * no config edit is needed for the defaults (4 overall, 2 per account).
 */
export function claudeSubAgentLimits(env: Record<string, string | undefined> = process.env): ClaudeSubAgentLimits {
  const section = config.agent
  return {
    global: positiveInt(env.LODESTAR_CLAUDE_SUB_MAX_CONCURRENT) ?? positiveInt(section?.claude_sub_max_concurrent)
      ?? DEFAULT_CLAUDE_SUB_MAX_CONCURRENT,
    perAccount: positiveInt(env.LODESTAR_CLAUDE_SUB_MAX_PER_ACCOUNT) ?? positiveInt(section?.claude_sub_max_per_account)
      ?? DEFAULT_CLAUDE_SUB_MAX_PER_ACCOUNT,
    fiveHourMaxUsed: CLAUDE_SUB_FIVE_HOUR_MAX_USED,
    weeklyMaxUsed: CLAUDE_SUB_WEEKLY_MAX_USED,
  }
}

export function claudeSubFullError(detail: string): Error {
  return Object.assign(new Error(
    `CLAUDE_SUB_FULL: ${detail}; no Claude subscription account can take this run now (no fallback to an exhausted or full account). `
    + `Use the Codex Sol identity ${CLAUDE_SUB_FALLBACK_IDENTITY} instead, or retry after a claude-sub run finishes.`,
  ), { code: 'CLAUDE_SUB_FULL' })
}

/** One lock path per kind; collisions compare paths by equality or ancestry. */
export interface AgentRunLockKey {
  kind: 'workdir' | 'unity' | 'evidence'
  path: string
}

function canonicalPath(path: string): string {
  try { return realpathSync(path) } catch { return resolve(path) }
}

/** Nearest directory at or above `start` holding both Assets/ and ProjectSettings/ (a Unity project root). */
export function findUnityProjectRoot(start: string): string | null {
  let current = canonicalPath(start)
  while (true) {
    try {
      if (statSync(join(current, 'Assets')).isDirectory() && statSync(join(current, 'ProjectSettings')).isDirectory()) return current
    } catch { /* keep walking */ }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export function resolveEvidenceDir(workDir: string, raw: string): string {
  return canonicalPath(isAbsolute(raw) ? raw : resolve(workDir, raw))
}

export function agentRunLockKeys(workDir: string, evidenceDir?: string): AgentRunLockKey[] {
  const keys: AgentRunLockKey[] = [{ kind: 'workdir', path: canonicalPath(workDir) }]
  const unity = findUnityProjectRoot(workDir)
  if (unity && unity !== keys[0]!.path) keys.push({ kind: 'unity', path: unity })
  if (evidenceDir) keys.push({ kind: 'evidence', path: existsSync(evidenceDir) ? canonicalPath(evidenceDir) : resolve(evidenceDir) })
  return keys
}

export function formatLockKey(key: AgentRunLockKey): string {
  return `${key.kind}:${key.path}`
}

export function parseLockKey(raw: string): AgentRunLockKey | null {
  const index = raw.indexOf(':')
  if (index <= 0) return null
  const kind = raw.slice(0, index)
  if (kind !== 'workdir' && kind !== 'unity' && kind !== 'evidence') return null
  return { kind, path: raw.slice(index + 1) }
}

function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true
  const withSep = (path: string) => path.endsWith(sep) ? path : path + sep
  return b.startsWith(withSep(a)) || a.startsWith(withSep(b))
}

/** First pair of colliding keys: the same directory, or one inside the other. */
export function findLockCollision(mine: readonly AgentRunLockKey[], theirs: readonly AgentRunLockKey[]):
  [AgentRunLockKey, AgentRunLockKey] | null {
  for (const a of mine) for (const b of theirs) if (pathsOverlap(a.path, b.path)) return [a, b]
  return null
}

/**
 * Agent-only account gate on top of the shared quota rank: the per-account run cap
 * and the 5h / weekly thresholds. Returns the exclusion reason, or null when eligible.
 */
export function agentClaudeAccountRejection(
  rank: Pick<ClaudeQuotaRank, 'fiveHourUsed' | 'weeklyUsed'>, agentRuns: number, limits: ClaudeSubAgentLimits,
): string | null {
  if (agentRuns >= limits.perAccount) return `每号上限 ${limits.perAccount} 已满（${agentRuns} 个 Agent run）`
  if (rank.fiveHourUsed !== undefined && rank.fiveHourUsed >= limits.fiveHourMaxUsed) {
    return `5h 已用 ${Math.round(rank.fiveHourUsed)}% ≥ ${limits.fiveHourMaxUsed}%`
  }
  if (rank.weeklyUsed !== undefined && rank.weeklyUsed >= limits.weeklyMaxUsed) {
    return `周额度已用 ${Math.round(rank.weeklyUsed)}% ≥ ${limits.weeklyMaxUsed}%`
  }
  return null
}
