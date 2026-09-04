import type { AgentIdentity, AgentSourceFailure } from '../agent-identities'
import { ELEMENTS } from './elements'

export interface AgentIdentityListCardOpts {
  panelId: string
  page: number
  totalPages: number
  catalog: AgentIdentity[]
  failures: AgentSourceFailure[]
}

export function agentIdentityListCard(opts: AgentIdentityListCardOpts): object {
  const elements: object[] = [{
    tag: 'markdown',
    element_id: ELEMENTS.agentIdentityPanel,
    content: [
      '**全局 Agent 身份**',
      '列出本机已配置的固定档位（一档一位）。目录只读，不能在此开跑；委派由主 Agent 调用 lodestar-agent。',
      `目录第 ${opts.page + 1}/${opts.totalPages} 页`,
    ].join('\n'),
  }]
  if (opts.failures.length) {
    elements.push({
      tag: 'collapsible_panel',
      header: { title: { tag: 'plain_text', content: `MISS · ${opts.failures.length} 个账号` } },
      expanded: false,
      elements: [{
        tag: 'markdown',
        content: opts.failures.map(failure => `- **${escapeMarkdown(failure.display)}**：${escapeMarkdown(failure.reason)}`).join('\n'),
      }],
    })
  }
  elements.push(...opts.catalog.map(identityRow), pager(opts))
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: '🧠 agents' }, template: 'purple' },
    body: { elements },
  }
}

function identityRow(identity: AgentIdentity): object {
  const ready = identity.status === 'ready'
  const detail = ready ? 'ready' : `${identity.status}: ${identity.reason ?? 'MISS'}`
  return {
    tag: 'markdown',
    content: [
      `**${escapeMarkdown(identity.displayName)}** ${identity.sourceDefault ? '· default' : ''}`,
      `${inlineCode(identity.id)}\n${inlineCode(identity.model)} · 默认 ${inlineCode(identity.defaultEffort)} · ${escapeMarkdown(detail)}`,
    ].join('\n'),
  }
}

function pager(opts: AgentIdentityListCardOpts): object {
  return {
    tag: 'column_set',
    columns: [
      buttonColumn('上一页', { kind: 'agent_identity_page', panel_id: opts.panelId, page: Math.max(0, opts.page - 1) }),
      buttonColumn('刷新', { kind: 'agent_identity_page', panel_id: opts.panelId, page: opts.page }),
      buttonColumn('下一页', { kind: 'agent_identity_page', panel_id: opts.panelId, page: Math.min(opts.totalPages - 1, opts.page + 1) }),
    ],
  }
}

function buttonColumn(text: string, value: Record<string, unknown>): object {
  return {
    tag: 'column', width: 'weighted', weight: 1,
    elements: [{
      tag: 'button',
      text: { tag: 'plain_text', content: text },
      type: 'default',
      behaviors: [{ type: 'callback', value }],
    }],
  }
}

function inlineCode(value: string): string {
  return '`' + value.replace(/`/g, '\\`') + '`'
}

function escapeMarkdown(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
