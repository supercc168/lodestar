/**
 * Console / menu / settings cards — every non-turn-card Feishu surface
 * the daemon paints. Companion file to turn.ts; both re-exported from
 * src/cards.ts.
 */

import { SERVICE_LABEL, type SysInfo } from '../sysinfo'
import type { UsageSnapshot } from '../usage'
import { ELEMENTS } from './elements'

export interface ConsoleOpts {
  sessionName: string
  status: 'idle' | 'working' | 'awaiting_permission' | 'starting' | 'stopped'
  /** All sessions currently running Codex across every Feishu group
   * this daemon owns. Each entry is a sibling project. Empty/undefined
   * → 渲染 `_无_`。The session matching this card's chat is
   * flagged `isCurrent` so the row can be marked. */
  peers?: Array<{
    name: string
    isCurrent: boolean
    status: 'idle' | 'working' | 'awaiting_permission' | 'starting' | 'stopped'
    uptimeMs?: number
  }>
  /** Subscription usage snapshot from Codex app-server. Undefined → omit row. */
  usage?: UsageSnapshot
  /** Host snapshot: CPU 负载、内存、AI-managed systemd 服务。
   * undefined 或字段缺失时明确渲染 `_n/a_`,不假数据。 */
  sysinfo?: SysInfo
}

interface StatusCardOpts {
  sessionName: string
  title: string
  status: string
  template?: 'blue' | 'green' | 'orange' | 'red' | 'grey' | 'turquoise'
}

export interface ModelChoice {
  model: string
  displayName: string
  description?: string
  isDefault?: boolean
  selected?: boolean
  efforts: ModelEffortChoice[]
}

export interface ModelEffortChoice {
  effort: string
  description?: string
  isDefault?: boolean
  selected?: boolean
}

interface ModelSelectionCardOpts {
  sessionName: string
  panelId: string
  currentModel?: string | null
  currentEffort?: string | null
  models: ModelChoice[]
}

interface ModelEffortPanelOpts {
  sessionName: string
  panelId: string
  currentModel?: string | null
  currentEffort?: string | null
  selectedModel: ModelChoice
  selectedEffort?: string | null
}

interface ModelResultPanelOpts {
  sessionName: string
  model: string
  effort: string
  scope: string
}

export function statusCardContent(_title: string, status: string): string {
  return status
}

export function statusCard(opts: StatusCardOpts): object {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      streaming_mode: true,
      summary: { content: opts.status },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          element_id: ELEMENTS.footer,
          content: statusCardContent(opts.title, opts.status),
        },
      ],
    },
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}K`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)}M`
  const gb = n / (1024 * 1024 * 1024)
  return gb < 10 ? `${gb.toFixed(1)}G` : `${gb.toFixed(0)}G`
}

/** Format token counts as a compact human-readable string: 1,234 → 1.2K. */
function fmtTokens(n: number): string {
  if (!n) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'K'
  return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M'
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

/** Human-readable "time until" — null/past dates collapse to '已重置'.
 * h/d 段保留 1 位小数(`2.3h` / `5.4d`),m 段已经是整数分钟精度
 * 够细就不再加小数。 */
function fmtResetIn(date: Date | null): string {
  if (!date) return '?'
  const ms = date.getTime() - Date.now()
  if (ms <= 0) return '已重置'
  if (ms < 60 * 60 * 1000) return `${Math.max(1, Math.round(ms / 60_000))}m`
  if (ms < 24 * 60 * 60 * 1000) return `${(ms / (60 * 60 * 1000)).toFixed(1)}h`
  return `${(ms / (24 * 60 * 60 * 1000)).toFixed(1)}d`
}

const PEER_STATUS_EMOJI: Record<string, string> = {
  idle: '🟢', working: '⚙️', awaiting_permission: '🔐',
  starting: '🚀', stopped: '⚪',
}

const PEER_STATUS_LABEL: Record<string, string> = {
  idle: '闲',
  working: '工作中',
  awaiting_permission: '等审批',
  starting: '启动中',
  stopped: '未运行',
}

/** Render the subscription-usage section of the console card. Pulled out
 * of `consoleCard` so the caller can patch it in after the initial card
 * is on screen (网络往返可能慢于第一次 paint;先占位、回包后替换)。
 *
 * 数据源是 Codex app-server 的 ChatGPT 账号与 OpenAI/Codex rate-limit
 * 快照 (见 src/usage.ts)。百分比是真实 usedPercent,失败态按 state 区分。
 *
 * `usage === undefined` → 初始 loading 占位。
 */
export function consoleUsageContent(
  usage: UsageSnapshot | undefined,
): string {
  if (usage === undefined) return '**📊 订阅额度**　_加载中…_'
  switch (usage.state) {
    case 'no_credentials':
      return '**📊 Codex 额度**　未登录 ChatGPT — 运行 `codex login`'
    case 'auth_failed':
      return '**📊 Codex 额度**　当前不是 ChatGPT 登录 — 请运行 `codex login`'
    case 'rate_limited':
      return '**📊 Codex 额度**　API 429 限流,稍后重试'
    case 'network':
      return `**📊 Codex 额度**　拉取失败${usage.reason ? ' — `' + usage.reason + '`' : ''}`
  }
  const head = usage.subscriptionType
    ? `**📊 Codex 额度** · ChatGPT ${usage.subscriptionType}`
    : '**📊 Codex 额度**'
  const lines: string[] = [head]
  if (usage.fiveHour) {
    const parts = [fmtUsagePercent(usage.fiveHour.percent)]
    if (usage.fiveHour.resetsAt) parts.push(`重置 ${fmtResetIn(usage.fiveHour.resetsAt)}`)
    lines.push(`　· ${fmtWindowLabel(usage.fiveHour.durationMins, '主窗口')}　${parts.join(' · ')}`)
  }
  if (usage.weekly) {
    const parts = [fmtUsagePercent(usage.weekly.percent)]
    if (usage.weekly.resetsAt) parts.push(`重置 ${fmtResetIn(usage.weekly.resetsAt)}`)
    lines.push(`　· ${fmtWindowLabel(usage.weekly.durationMins, '次窗口')}　${parts.join(' · ')}`)
  }
  return lines.length === 1 ? '**📊 Codex 额度**　_无数据_' : lines.join('\n')
}

function fmtUsagePercent(percent: number | null | undefined): string {
  return typeof percent === 'number' && Number.isFinite(percent) ? `${Math.round(percent)}%` : 'MISS'
}

function fmtWindowLabel(mins: number | null | undefined, fallback: string): string {
  if (!mins || mins <= 0) return fallback
  if (mins % (24 * 60) === 0) return `${mins / (24 * 60)}d`
  if (mins % 60 === 0) return `${mins / 60}h`
  return `${mins}m`
}

const SERVICE_STATUS_EMOJI: Record<string, string> = {
  active: '🟢', activating: '🚀', reloading: '🔄',
  inactive: '⚪', deactivating: '🟡', failed: '❌',
}

/** Host snapshot panel body: 负载、内存、服务列表。 */
function hostSummary(sysinfo?: SysInfo): string[] {
  const parts: string[] = []
  if (sysinfo?.cpu) parts.push(`load ${sysinfo.cpu.load1.toFixed(2)}`)
  if (sysinfo?.mem) parts.push(`mem ${sysinfo.mem.percent}%`)
  if (sysinfo && !sysinfo.servicesError) parts.push(`${sysinfo.services.length} 服务`)
  return parts
}

export function consoleHostContent(sysinfo?: SysInfo): string {
  if (!sysinfo) {
    return [
      '**负载**　_n/a_',
      '**内存**　_n/a_',
      `**服务** ${SERVICE_LABEL}　_n/a_`,
    ].join('\n')
  }

  const lines: string[] = []
  if (sysinfo.cpu) {
    const { cores, load1, load5, load15 } = sysinfo.cpu
    lines.push(`**负载**　${load1.toFixed(2)} / ${load5.toFixed(2)} / ${load15.toFixed(2)} (${cores}核)`)
  } else {
    lines.push('**负载**　_n/a_')
  }

  if (sysinfo.mem) {
    lines.push(`**内存**　${sysinfo.mem.percent}% (${fmtBytes(sysinfo.mem.usedBytes)}/${fmtBytes(sysinfo.mem.totalBytes)})`)
  } else {
    lines.push('**内存**　_n/a_')
  }

  if (sysinfo.servicesError) {
    lines.push(`**服务** ${SERVICE_LABEL}　_${sysinfo.servicesError}_`)
  } else if (sysinfo.services.length === 0) {
    lines.push(`**服务** ${SERVICE_LABEL}　_无_`)
  } else {
    lines.push(`**服务** ${SERVICE_LABEL} (${sysinfo.services.length})`)
    for (const s of sysinfo.services) {
      const dot = SERVICE_STATUS_EMOJI[s.active] ?? '·'
      const lastActive = s.lastActiveAgoSec
      const stateAge = s.stateAgoSec
      const parts: string[] = [s.active]
      if (s.active === 'active') {
        if (stateAge != null) parts.push(`已运行 ${fmtUptime(stateAge * 1000)}`)
      } else if (s.active === 'inactive' || s.active === 'failed') {
        if (lastActive != null) {
          parts.push(`上次活跃 ${fmtUptime(lastActive * 1000)}前`)
        } else {
          parts.push('从未启动')
        }
        if (stateAge != null) {
          const verb = s.active === 'failed' ? '已挂' : '已停'
          parts.push(`${verb} ${fmtUptime(stateAge * 1000)}`)
        }
      } else if (stateAge != null) {
        parts.push(`已 ${fmtUptime(stateAge * 1000)}`)
      }
      lines.push(`　· ${dot} \`${s.name}\` · ${parts.join(' · ')}`)
    }
  }

  return lines.join('\n')
}

export function consoleMainContent(opts: ConsoleOpts): string {
  const peers = opts.peers ?? []
  if (peers.length === 0) return '_无_'
  return peers.map((p) => {
    const dot = PEER_STATUS_EMOJI[p.status] ?? '·'
    const label = PEER_STATUS_LABEL[p.status] ?? p.status
    const up = p.uptimeMs != null && p.uptimeMs > 0 ? ` · ${fmtUptime(p.uptimeMs)}` : ''
    const mark = p.isCurrent ? ' · 当前' : ''
    return `　· ${dot} \`${p.name}\` · ${label}${up}${mark}`
  }).join('\n')
}

export function consoleMainElement(opts: ConsoleOpts, elementId = ELEMENTS.consoleProjects): object {
  const peers = opts.peers ?? []
  return {
    tag: 'collapsible_panel',
    element_id: elementId,
    header: {
      title: { tag: 'plain_text', content: `🗂 活跃项目 (${peers.length})` },
    },
    expanded: false,
    elements: [{ tag: 'markdown', content: consoleMainContent(opts) }],
  }
}

export function consoleHostElement(sysinfo?: SysInfo, elementId = ELEMENTS.consoleHost): object {
  const summary = hostSummary(sysinfo)
  return {
    tag: 'collapsible_panel',
    element_id: elementId,
    header: {
      title: {
        tag: 'plain_text',
        content: summary.length > 0 ? `🖥 主机状态 · ${summary.join(' · ')}` : '🖥 主机状态',
      },
    },
    expanded: false,
    elements: [{ tag: 'markdown', content: consoleHostContent(sysinfo) }],
  }
}

export function consoleUsageElement(usage: UsageSnapshot | undefined): object {
  return {
    tag: 'markdown',
    element_id: ELEMENTS.consoleUsage,
    content: consoleUsageContent(usage),
  }
}

export function consoleBodyElements(opts: ConsoleOpts, mainElementId?: string): object[] {
  return [
    consoleMainElement(opts, mainElementId),
    consoleHostElement(opts.sysinfo),
    consoleUsageElement(opts.usage),
  ]
}

export function consoleCard(opts: ConsoleOpts): object {
  const { sessionName, status } = opts
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
    body: { elements: consoleBodyElements(opts) },
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

export function modelSelectionCard(opts: ModelSelectionCardOpts): object {
  return modelCard(opts.sessionName, modelSelectionPanelElement(opts))
}

export function modelEffortCard(opts: ModelEffortPanelOpts): object {
  return modelCard(opts.sessionName, modelEffortPanelElement(opts))
}

export function modelResultCard(opts: ModelResultPanelOpts): object {
  return modelCard(opts.sessionName, modelResultPanelElement(opts), 'green')
}

function modelCard(sessionName: string, element: object, template = 'turquoise'): object {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `🤖 model · ${sessionName}` },
      template,
    },
    body: {
      elements: [element],
    },
  }
}

export function modelSelectionPanelElement(opts: ModelSelectionCardOpts): object {
  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.modelPanel,
    header: { title: { tag: 'plain_text', content: '选择模型' } },
    expanded: true,
    elements: [
      {
        tag: 'markdown',
        content: [
          `当前: ${settingsLine(opts.currentModel, opts.currentEffort)}`,
          '先选择模型;下一步会选择 reasoning effort。',
        ].join('\n'),
      },
      ...(opts.models.length
        ? opts.models.map(model => modelChoiceElement(model, opts.panelId, opts.currentEffort))
        : [{ tag: 'markdown', content: '_Codex 未返回可用模型列表_' }]),
    ],
  }
}

export function modelEffortPanelElement(opts: ModelEffortPanelOpts): object {
  const selectedEffort = opts.selectedEffort ?? opts.currentEffort ?? null
  const efforts = opts.selectedModel.efforts.map(effort => ({
    ...effort,
    selected: effort.effort === selectedEffort,
  }))
  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.modelPanel,
    header: { title: { tag: 'plain_text', content: '选择推理强度' } },
    expanded: true,
    elements: [
      {
        tag: 'markdown',
        content: [
          `已选: ${modelTitle(opts.selectedModel)}`,
          `当前: ${settingsLine(opts.currentModel, opts.currentEffort)}`,
          '请选择 reasoning effort,确认后写入本项目。',
        ].join('\n'),
      },
      ...(efforts.length
        ? efforts.map(effort => effortChoiceElement(opts.selectedModel.model, effort, opts.panelId))
        : [{ tag: 'markdown', content: '_Codex 未返回这个模型的可用推理强度,无法完成切换。_' }]),
    ],
  }
}

export function modelResultPanelElement(opts: ModelResultPanelOpts): object {
  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.modelPanel,
    header: { title: { tag: 'plain_text', content: '选择已保存' } },
    expanded: true,
    elements: [{
      tag: 'markdown',
      content: [
        '**已保存**',
        inlineCode(settingsText(opts.model, opts.effort)),
        escapeMarkdown(opts.scope),
      ].join('\n'),
    }],
  }
}

function modelChoiceElement(model: ModelChoice, panelId: string, currentEffort?: string | null): object {
  const title = model.displayName && model.displayName !== model.model
    ? `**${escapeMarkdown(model.displayName)}**`
    : `**${inlineCode(model.model)}**`
  const flags = [
    model.isDefault ? 'Codex 默认' : '',
    model.selected ? '当前模型' : '',
    model.selected && currentEffort ? currentEffort : '',
  ].filter(Boolean)
  const desc = model.description
    ? '\n' + escapeMarkdown(truncate(model.description, 110))
    : ''
  return {
    tag: 'column_set',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 4,
        elements: [{
          tag: 'markdown',
          content: [
            title,
            inlineCode(model.model),
            flags.length ? flags.join(' · ') : '',
          ].filter(Boolean).join('\n') + desc,
        }],
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: '选' },
          type: model.selected ? 'primary' : 'default',
          behaviors: [{ type: 'callback', value: modelSelectActionValue(model, panelId) }],
        }],
      },
    ],
  }
}

function modelSelectActionValue(model: ModelChoice, panelId: string): object {
  return {
    kind: 'model_select',
    panel_id: panelId,
    model: model.model,
    display_name: model.displayName,
    is_default: model.isDefault === true,
    efforts: model.efforts.map(effort => ({
      effort: effort.effort,
      description: effort.description ?? '',
      is_default: effort.isDefault === true,
    })),
  }
}

function effortChoiceElement(model: string, effort: ModelEffortChoice, panelId: string): object {
  const flags = [
    effort.isDefault ? 'Codex 默认' : '',
    effort.selected ? '当前 effort' : '',
  ].filter(Boolean)
  const desc = effort.description
    ? '\n' + escapeMarkdown(truncate(effort.description, 110))
    : ''
  return {
    tag: 'column_set',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 4,
        elements: [{
          tag: 'markdown',
          content: [
            `**${inlineCode(effort.effort)}**`,
            flags.length ? flags.join(' · ') : '',
          ].filter(Boolean).join('\n') + desc,
        }],
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: '选' },
          type: effort.selected ? 'primary' : 'default',
          behaviors: [{ type: 'callback', value: { kind: 'model_effort_select', panel_id: panelId, model, effort: effort.effort } }],
        }],
      },
    ],
  }
}

function modelTitle(model: ModelChoice): string {
  return model.displayName && model.displayName !== model.model
    ? `${escapeMarkdown(model.displayName)} (${inlineCode(model.model)})`
    : inlineCode(model.model)
}

function settingsLine(model?: string | null, effort?: string | null): string {
  return inlineCode(settingsText(model, effort))
}

function settingsText(model?: string | null, effort?: string | null): string {
  if (model && effort) return `${model}/${effort}`
  if (model) return model
  if (effort) return effort
  return '未选择'
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

function escapeMarkdown(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inlineCode(s: string): string {
  return '`' + s.replace(/`/g, '\\`') + '`'
}

/** Settings patch applied when a turn finishes — flips streaming off
 * and updates the chat-list preview with `⏱ duration · 📶 NK`
 * (or just the suffix if interrupted before a result event). */
export function streamingOffSettings(opts: {
  durationSec?: string
  outputTokens?: number | null
  suffix?: string
}): object {
  const parts: string[] = []
  parts.push(opts.suffix ?? '✅')
  // durationSec 缺省的场景:mid-turn rotate 收尾旧卡 (turn 还在跑,没
  // turn-final elapsed)。直接省掉 ⏱ 段,避免拼出 "⏱ undefineds"。
  if (opts.durationSec) parts.push(`⏱ ${opts.durationSec}s`)
  if (opts.outputTokens != null && opts.outputTokens > 0) {
    parts.push(`📶 ${fmtTokens(opts.outputTokens)}`)
  }
  return {
    config: { streaming_mode: false, summary: { content: parts.join(' · ') } },
  }
}
