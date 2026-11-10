import type { AgentProcess } from './agent-process'
import { claudeAccounts, processClaudeAccount } from './claude-accounts'
import { claudeWeeklyUsageWindow } from './claude-usage'
import { getTokenSourceForAccount, type UsageSnapshotUnified } from './token-source'
import { peekTokenSourceUsage } from './token-source-cache'
import { fmtResetIn } from './cards/usage'

/** Account a Claude subscription Agent worker was started on, captured once at startup. */
export interface ClaudeLaunchAccount {
  accountId: string
  accountName: string
  /** Chosen account's cached quota at selection time: `4.1h·7%·[6.9d·17%]` (percent = used), or a MISS reason. */
  quota: string
  /** Every enrolled account's cached quota at selection time, e.g. `default 4.1h·7%·[6.9d·17%]; vale [6.9d·3%]`. */
  pool: string
}

type Window = { percent?: number | null; resetsAt?: Date | null } | null | undefined

function segment(window: Window): string | null {
  if (!window) return null
  if (typeof window.percent !== 'number' || !Number.isFinite(window.percent)) return 'MISS'
  const reset = window.resetsAt instanceof Date && window.resetsAt.getTime() > Date.now() ? fmtResetIn(window.resetsAt) : ''
  const percent = `${Math.round(window.percent)}%`
  return reset ? `${reset}·${percent}` : percent
}

/** Same compact format as the chat footer: five-hour window, then the model's weekly window in brackets. */
export function claudeQuotaSummary(snapshot: UsageSnapshotUnified | undefined, model: string): string {
  if (!snapshot) return 'MISS'
  if (snapshot.state !== 'ok') return `MISS(${snapshot.reason ?? snapshot.state})`
  const five = segment(snapshot.windows?.find(window => window.kind === 'fiveHour'))
  const week = segment(claudeWeeklyUsageWindow(snapshot, model) ?? { percent: null, resetsAt: null })
  if (five && week) return `${five}·[${week}]`
  if (week) return `[${week}]`
  return five ?? 'MISS'
}

function accountQuota(accountId: string, model: string): string {
  try {
    const source = getTokenSourceForAccount('claude-sub', accountId)
    return source ? claudeQuotaSummary(peekTokenSourceUsage(source), model) : 'MISS(来源)'
  } catch (error) {
    return `MISS(${error instanceof Error ? error.message : String(error)})`
  }
}

/** Reporting only: reads the selection already bound to `proc` and the cached quota; never queries upstream. */
export function describeClaudeLaunchAccount(proc: AgentProcess, model: string): ClaudeLaunchAccount | null {
  const accountId = processClaudeAccount(proc)
  if (!accountId) return null
  let accountName = accountId
  try { accountName = claudeAccounts.get(accountId).name || accountId } catch { /* Keep the id. */ }
  let pool = ''
  try {
    pool = claudeAccounts.list().map(account => `${account.name || account.id} ${accountQuota(account.id, model)}`).join('; ')
  } catch (error) {
    pool = `MISS(${error instanceof Error ? error.message : String(error)})`
  }
  return { accountId, accountName, quota: accountQuota(accountId, model), pool }
}
