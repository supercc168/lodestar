/**
 * Console / menu / settings cards — every non-turn-card Feishu surface
 * the daemon paints. Companion file to turn.ts; both re-exported from
 * src/cards.ts.
 */

import type { UsageSnapshot } from '../usage'
import { ELEMENTS } from './elements'

interface ConsoleOpts {
  sessionName: string
  status: 'idle' | 'working' | 'awaiting_permission' | 'starting' | 'stopped'
  model?: string
  effort?: string
  /** ms since this ClaudeProcess spawned — formatted to "1h 23m" inside. */
  uptimeMs?: number
  /** All sessions currently running Claude across every Feishu group
   * this daemon owns. Each entry is a sibling project. Empty/undefined
   * → omit the section. The session matching this card's chat is
   * flagged `isCurrent` so the row can be marked. */
  peers?: Array<{
    name: string
    isCurrent: boolean
    status: 'idle' | 'working' | 'awaiting_permission' | 'starting' | 'stopped'
    uptimeMs?: number
  }>
  /** Subscription usage snapshot from ccusage. When `installed: false`
   * the row renders an install hint; otherwise we surface the current
   * 5h billing block + this week's aggregate. Undefined → omit row. */
  usage?: UsageSnapshot
  /** Current context-window occupancy estimate (input + cache tokens of
   * the last assistant message). 0 if no turn has completed yet. */
  contextTokens?: number
  /** Window upper bound. Defaults to 1M (claude-opus-4-7[1m]). */
  contextLimit?: number
  cumStats?: { tokens: number; costUsd: number; turns: number }
  lastTurn?: { tokens: number; costUsd: number; durationMs: number }
  sessionId?: string | null
}

/** Format token counts as a compact human-readable string: 1,234 → 1.2K. */
function fmtTokens(n: number): string {
  if (!n) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'K'
  return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M'
}

function fmtCost(c: number): string {
  if (c < 0.01) return `$${c.toFixed(4)}`
  return `$${c.toFixed(2)}`
}

function fmtDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m ${s}s`
}

function fmtUptime(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const totalMin = Math.floor(ms / 60_000)
  if (totalMin < 60) return `${totalMin}m`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h < 24) return `${h}h ${m}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

/** Human-readable "time until" — null/past dates collapse to '已重置'. */
function fmtResetIn(date: Date | null): string {
  if (!date) return '?'
  const ms = date.getTime() - Date.now()
  if (ms <= 0) return '已重置'
  if (ms < 60 * 60 * 1000) return `${Math.max(1, Math.round(ms / 60_000))}m`
  if (ms < 24 * 60 * 60 * 1000) return `${Math.round(ms / (60 * 60 * 1000))}h`
  return `${Math.round(ms / (24 * 60 * 60 * 1000))}d`
}

/** Human-readable "time since" — clamps sub-minute values to "刚刚". */
function fmtAgo(timestamp: number): string {
  const ms = Date.now() - timestamp
  if (ms < 60_000) return '刚刚'
  if (ms < 60 * 60 * 1000) return `${Math.round(ms / 60_000)}m 前`
  if (ms < 24 * 60 * 60 * 1000) return `${Math.round(ms / (60 * 60 * 1000))}h 前`
  return `${Math.round(ms / (24 * 60 * 60 * 1000))}d 前`
}

const PEER_STATUS_EMOJI: Record<string, string> = {
  idle: '🟢', working: '⚙️', awaiting_permission: '🔐',
  starting: '🚀', stopped: '⚪',
}

/** Render the subscription-usage section of the console card. Pulled out
 * of `consoleCard` so the caller can patch it in after the initial card
 * is on screen (网络往返可能慢于第一次 paint;先占位、回包后替换)。
 *
 * 数据源是 Anthropic 官方 OAuth Usage API (见 src/usage.ts)。
 * 百分比是真实 utilization,失败态按 state 区分显示具体原因。
 *
 * `usage === undefined` → 初始 loading 占位。
 */
export function consoleUsageContent(
  usage: UsageSnapshot | undefined,
): string {
  if (usage === undefined) return '**📊 订阅额度**　_加载中…_'
  switch (usage.state) {
    case 'no_credentials':
      return '**📊 订阅额度**　未找到 OAuth 凭据 (`~/.claude/.credentials.json`)'
    case 'auth_failed':
      return '**📊 订阅额度**　Token 已过期且刷新失败 — 重新 `claude auth login`'
    case 'rate_limited':
      return '**📊 订阅额度**　API 429 限流,稍后重试'
    case 'network':
      return `**📊 订阅额度**　拉取失败${usage.reason ? ' — `' + usage.reason + '`' : ''}`
  }
  // state === 'ok' —— stale 时 head 加 "缓存 Xm 前",重置时间加 `~`
  // 前缀,沿用 omchud HUD 的 stale 标记约定。
  const staleNote = usage.stale ? ` _· 缓存 ${fmtAgo(usage.fetchedAt)}_` : ''
  const resetPrefix = usage.stale ? '~' : ''
  const head = usage.subscriptionType
    ? `**📊 订阅额度** · ${usage.subscriptionType}${staleNote}`
    : `**📊 订阅额度**${staleNote}`
  const lines: string[] = [head]
  if (usage.fiveHour) {
    const parts = [`${Math.round(usage.fiveHour.percent)}%`]
    if (usage.fiveHour.resetsAt) parts.push(`重置 ${resetPrefix}${fmtResetIn(usage.fiveHour.resetsAt)}`)
    lines.push(`　· 5h　${parts.join(' · ')}`)
  }
  if (usage.weekly) {
    const parts = [`${Math.round(usage.weekly.percent)}%`]
    if (usage.weekly.resetsAt) parts.push(`重置 ${resetPrefix}${fmtResetIn(usage.weekly.resetsAt)}`)
    lines.push(`　· 7d　${parts.join(' · ')}`)
  }
  return lines.length === 1 ? '**📊 订阅额度**　_无数据_' : lines.join('\n')
}

export function consoleCard(opts: ConsoleOpts): object {
  const {
    sessionName, status, model, effort, uptimeMs, peers, usage,
    contextTokens, contextLimit, cumStats, lastTurn, sessionId,
  } = opts
  const statusEmoji = {
    idle: '🟢 闲', working: '⚙️ 工作中', awaiting_permission: '🔐 等审批',
    starting: '🚀 启动中', stopped: '⚪ 未运行',
  }[status]

  const modelLine = model ? `${model}${effort ? `/${effort}` : ''}` : null
  const headerLine = [statusEmoji, modelLine].filter(Boolean).join(' · ')

  // Build the metric lines that make this panel useful. Each is "label
  // <tab> value" rendered as plain markdown — keeps it readable inside
  // the small Feishu card area without competing with the button row.
  const lines: string[] = [headerLine]

  if (peers && peers.length > 0) {
    lines.push(`**🗂 活跃项目** (${peers.length})`)
    for (const p of peers) {
      const dot = PEER_STATUS_EMOJI[p.status] ?? '·'
      const up = p.uptimeMs != null && p.uptimeMs > 0 ? ` · ${fmtUptime(p.uptimeMs)}` : ''
      const mark = p.isCurrent ? ' ← 当前' : ''
      lines.push(`　· ${dot} \`${p.name}\`${up}${mark}`)
    }
  }
  if (contextTokens != null && contextTokens > 0) {
    const limit = contextLimit ?? 1_000_000
    const pct = limit > 0 ? Math.round((contextTokens / limit) * 100) : 0
    lines.push(`**📦 上下文**　${fmtTokens(contextTokens)} / ${fmtTokens(limit)}　(${pct}%)`)
  }
  void uptimeMs // session-level uptime is already shown per-project in
  // the 活跃项目 list above (peers[].uptimeMs); the dedicated row would
  // duplicate it for the current session.
  if (cumStats && (cumStats.tokens > 0 || cumStats.costUsd > 0 || cumStats.turns > 0)) {
    lines.push(`**💬 累计**　${fmtTokens(cumStats.tokens)} tokens · ${fmtCost(cumStats.costUsd)} · ${cumStats.turns} turn${cumStats.turns === 1 ? '' : 's'}`)
  }
  if (lastTurn) {
    lines.push(`**🔄 上一轮**　+${fmtTokens(lastTurn.tokens)} · ${fmtCost(lastTurn.costUsd)} · ${fmtDurationMs(lastTurn.durationMs)}`)
  }
  if (sessionId) {
    lines.push(`**🆔 session**　\`${sessionId.slice(0, 8)}…\``)
  }

  const template = status === 'working' ? 'blue'
    : status === 'awaiting_permission' ? 'orange'
    : status === 'stopped' ? 'grey'
    : 'green'

  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `🌟 Lodestar · ${sessionName}` },
      template,
    },
    body: {
      elements: [
        { tag: 'markdown', content: lines.join('\n') },
        // Separate element so showConsole() can replace it after the
        // ccusage fetch completes — initial paint goes out immediately
        // with `_加载中…_`, then this row swaps to real data.
        {
          tag: 'markdown',
          element_id: ELEMENTS.consoleUsage,
          content: consoleUsageContent(usage),
        },
      ],
    },
  }
}

interface MenuOpts {
  question: string
  options: string[]
  requestId: string
}

export function menuCard(opts: MenuOpts): object {
  const { question, options, requestId } = opts
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: '📋 等待选择' },
      template: 'turquoise',
    },
    body: {
      elements: [
        { tag: 'markdown', content: question || '_请选择一项：_' },
        ...options.map((opt, i) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: opt },
          type: 'default',
          behaviors: [{ type: 'callback', value: { kind: 'menu', request_id: requestId, choice: i } }],
        })),
      ],
    },
  }
}

/** Settings patch applied when a turn finishes — flips streaming off
 * and updates the chat-list preview with `⏱ duration · NK tokens`
 * (or just the suffix if interrupted before a result event). */
export function streamingOffSettings(opts: {
  durationSec: string
  tokens?: number
  suffix?: string
}): object {
  const parts: string[] = []
  parts.push(opts.suffix ?? '✅')
  parts.push(`⏱ ${opts.durationSec}s`)
  if (opts.tokens != null && opts.tokens > 0) {
    parts.push(`${fmtTokens(opts.tokens)} tokens`)
  }
  return {
    config: { streaming_mode: false, summary: { content: parts.join(' · ') } },
  }
}
