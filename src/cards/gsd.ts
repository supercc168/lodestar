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
        actionElement(opts),
      ],
    },
  }
}

function panelContent(opts: GsdPanelOpts): string {
  const s = opts.snapshot
  const name = s.taskName || '—'
  const slug = s.taskSlug || '—'
  const phase = s.phase || 'unknown'
  const phaseHint = s.phaseHint ? ` / ${s.phaseHint}` : ''
  const updated = s.updatedAt || '—'
  const lines = [
    `任务：${inlineCode(name)}`,
    `slug：${inlineCode(slug)}`,
    `状态：${s.status}`,
    `阶段：${inlineCode(phase)}${phaseHint}`,
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

function actionElement(opts: GsdPanelOpts): object {
  const taskSlug = opts.snapshot.taskSlug || ''
  const panelGen = opts.panelGen
  const buttons: Array<{ label: string; kind: string; type?: string }> = [
    { label: '进度', kind: 'gsd_refresh', type: 'default' },
    { label: '继续', kind: 'gsd_continue', type: 'primary' },
    { label: '暂停', kind: 'gsd_pause', type: 'default' },
    { label: '完成', kind: 'gsd_complete', type: 'default' },
    { label: '新任务', kind: 'gsd_new_prompt', type: 'primary' },
  ]

  return {
    tag: 'column_set',
    columns: buttons.map(btn => ({
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
    })),
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
