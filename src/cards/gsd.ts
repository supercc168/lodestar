import { ELEMENTS } from './elements'
import type { GsdSnapshot } from '../gsd-store'
import type { BridgeHealth } from '../gsd-bridge'

export interface GsdPanelNotice {
  type: 'success' | 'error' | 'info'
  content: string
}

export type GsdPanelOpts = {
  snapshot: GsdSnapshot
  providerLabel: string
  panelGen: string
  notice?: GsdPanelNotice
  awaitingName?: boolean
  /**
   * Session-level gate: true only when this chat is actively executing the
   * active GSD task (daemon inject / `[Lodestar GSD]` message). Disk-only
   * 运行中 without session execution must not show plan/cursor detail.
   */
  showProgress?: boolean
}

export function gsdPanelCard(opts: GsdPanelOpts): object {
  const template = opts.notice?.type === 'error'
    ? 'red'
    : opts.snapshot.status === '运行中'
      ? 'green'
      : opts.snapshot.status === '已暂停'
        ? 'orange'
        : opts.snapshot.status === '已完成'
          ? 'turquoise'
          : 'blue'

  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `gsd · ${opts.snapshot.status}` },
      template,
    },
    body: {
      elements: [
        ...(opts.notice ? [noticeElement(opts.notice)] : []),
        {
          tag: 'markdown',
          element_id: ELEMENTS.gsdPanel,
          content: panelContent(opts),
        },
        // Two rows: five equal-weight buttons in one column_set are too
        // narrow on Feishu and render as "..." with labels clipped.
        ...actionElements(opts),
      ],
    },
  }
}

function panelContent(opts: GsdPanelOpts): string {
  const s = opts.snapshot
  const name = s.taskName || '—'
  const slug = s.taskSlug || '—'
  const phase = s.phase || 'unknown'
  // Avoid duplicating phase when TRACKER phase already equals STATE phaseHint.
  const phaseHint =
    s.phaseHint && s.phaseHint !== 'unknown' && s.phaseHint !== phase
      ? ` / ${s.phaseHint}`
      : ''
  const updated = s.updatedAt || '—'
  const lines = [
    `任务：${inlineCode(name)}`,
    `slug：${inlineCode(slug)}`,
    `状态：${s.status}`,
    `阶段：${inlineCode(phase)}${phaseHint}`,
    ...progressLines(s, opts.showProgress === true),
    `bridge：${bridgeLabel(s.bridge)}`,
    `provider：${inlineCode(opts.providerLabel)}`,
    `更新：${inlineCode(updated)}`,
  ]
  if (s.note) lines.push(`备注：${s.note}`)
  if (opts.awaitingName) {
    lines.push('')
    lines.push(`<font color='orange'>等待任务名：请发送下一条消息作为新任务名称（约 300s 内）。</font>`)
  }
  return lines.join('\n')
}

/**
 * Extra lines from STATE.md plan/cursor progress (read-only mirror).
 * Requires both disk status **运行中** and session `showProgress` (this chat
 * is executing GSD). Paused/completed/idle or ordinary non-GSD chat keep the
 * coarse header only.
 */
function progressLines(
  s: GsdPanelOpts['snapshot'],
  showProgress: boolean,
): string[] {
  if (!showProgress) return []
  if (s.status !== '运行中') return []
  const p = s.progress
  if (!p) return []
  const lines: string[] = []

  if (p.totalPlans != null && p.completedPlans != null) {
    const bar = progressBar(p.completedPlans, p.totalPlans, p.percent)
    lines.push(
      `计划：${inlineCode(`${p.completedPlans}/${p.totalPlans}`)}${bar ? ` ${bar}` : ''}`,
    )
  } else if (p.percent != null) {
    lines.push(`进度：${inlineCode(`${p.percent}%`)}`)
  }

  if (p.totalPhases != null && p.completedPhases != null && p.totalPhases > 0) {
    lines.push(`phase 进度：${inlineCode(`${p.completedPhases}/${p.totalPhases}`)}`)
  }

  if (p.currentPlan) {
    lines.push(`当前计划：${inlineCode(truncate(p.currentPlan, 80))}`)
  }

  if (p.cursor) {
    const item = p.cursor.item ? ` ${truncate(p.cursor.item, 48)}` : ''
    lines.push(
      `游标：${inlineCode(`[GSD ${p.cursor.cursor}]`)} ${inlineCode(p.cursor.status)}${item ? ` ${item}` : ''}`,
    )
  }

  if (p.nextAction) {
    lines.push(`下一步：${inlineCode(truncate(p.nextAction, 80))}`)
  }

  return lines
}

function progressBar(
  completed: number,
  total: number,
  percent: number | null,
): string {
  if (total <= 0) return ''
  const pct =
    percent != null && Number.isFinite(percent)
      ? Math.max(0, Math.min(100, percent))
      : Math.max(0, Math.min(100, Math.round((completed / total) * 100)))
  const width = 10
  const filled = Math.round((pct / 100) * width)
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
  return `\`${bar}\` ${pct}%`
}

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return t.slice(0, Math.max(0, max - 1)) + '…'
}

function bridgeLabel(bridge: BridgeHealth): string {
  if (bridge.ok) return 'OK'
  switch (bridge.kind) {
    case 'missing':
      return '缺失'
    case 'broken':
      return '损坏'
    case 'not-link':
      return '非链接'
    default:
      return bridge.kind
  }
}

type GsdActionButton = { label: string; kind: string; type?: string }

function actionElements(opts: GsdPanelOpts): object[] {
  const taskSlug = opts.snapshot.taskSlug || ''
  const panelGen = opts.panelGen
  // Keep ≤3 buttons per row (same practical density as permission cards).
  const rows: GsdActionButton[][] = [
    [
      { label: '进度', kind: 'gsd_refresh', type: 'default' },
      { label: '继续', kind: 'gsd_continue', type: 'primary' },
      { label: '暂停', kind: 'gsd_pause', type: 'default' },
    ],
    [
      { label: '完成', kind: 'gsd_complete', type: 'default' },
      { label: '新任务', kind: 'gsd_new_prompt', type: 'primary' },
    ],
  ]

  return rows.map(buttons => ({
    tag: 'column_set',
    columns: buttons.map(btn => buttonColumn(btn, taskSlug, panelGen)),
  }))
}

function buttonColumn(
  btn: GsdActionButton,
  taskSlug: string,
  panelGen: string,
): object {
  return {
    tag: 'column',
    width: 'weighted',
    weight: 1,
    elements: [{
      tag: 'button',
      text: { tag: 'plain_text', content: btn.label },
      type: btn.type ?? 'default',
      behaviors: [{
        type: 'callback',
        value: {
          kind: btn.kind,
          task_slug: taskSlug,
          panel_gen: panelGen,
        },
      }],
    }],
  }
}

function noticeElement(notice: GsdPanelNotice): object {
  const color = notice.type === 'error'
    ? 'red'
    : notice.type === 'success'
      ? 'green'
      : 'grey'
  return {
    tag: 'markdown',
    content: notice.content
      .split('\n')
      .map(line => `<font color='${color}'>${escapeMarkdown(line) || ' '}</font>`)
      .join('\n'),
  }
}

function inlineCode(s: string): string {
  return '`' + s.replace(/`/g, '\\`') + '`'
}

function escapeMarkdown(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
