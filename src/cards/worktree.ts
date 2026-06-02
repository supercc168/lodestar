export interface WorktreeCardEntry {
  slug: string
  chatName: string
  branch: string
  state: 'active' | 'merged' | 'stale'
  path: string
  mounted: boolean
  dirtyCount: number | null
  statusLine: string | null
  error: string | null
  chatId: string | null
  duplicateChatCount: number
}

export interface WorktreeListCardOpts {
  projectName: string
  projectDir: string
  entries: WorktreeCardEntry[]
}

export interface WorktreeNoticeCardOpts {
  slug: string
  branch: string
  status: string
  body?: string
  template?: string
}

export function worktreeListCard(opts: WorktreeListCardOpts): object {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: '🌿 wt' },
      template: 'turquoise',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: opts.entries.length
            ? `${opts.entries.length} 个工作分支`
            : `_无 work/* 分支。发 ${inlineCode('wt name')} 创建。_`,
        },
        ...opts.entries.flatMap(worktreeEntryElements),
      ],
    },
  }
}

function worktreeEntryElements(entry: WorktreeCardEntry): object[] {
  const repoState = entry.error
    ? 'err'
    : entry.mounted
      ? entry.dirtyCount && entry.dirtyCount > 0
        ? `dirty ${entry.dirtyCount}`
        : entry.state === 'merged'
          ? 'merged'
          : entry.state === 'stale'
            ? 'stale'
            : 'clean'
      : 'off'
  const chatState = entry.duplicateChatCount > 1
    ? `群重复 ${entry.duplicateChatCount}`
    : entry.chatId
      ? '群 OK'
      : '无群'
  const columns: object[] = [{
    tag: 'column',
    width: 'weighted',
    weight: 4,
    elements: [{
      tag: 'markdown',
      content: `**${inlineCode(entry.slug)}**\n${repoState} · ${chatState}\n${inlineCode(entry.branch)}`,
    }],
  }]
  if (entry.mounted || entry.chatId) {
    columns.push({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [{
        tag: 'button',
        text: { tag: 'plain_text', content: '删' },
        type: 'danger',
        behaviors: [{ type: 'callback', value: { kind: 'worktree_disband', slug: entry.slug } }],
      }],
    })
  }
  return [{ tag: 'column_set', columns }]
}

export function worktreeNoticeCard(opts: WorktreeNoticeCardOpts): object {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `🌿 ${opts.slug}` },
      template: opts.template ?? 'green',
    },
    body: {
      elements: [{
        tag: 'markdown',
        content: [
          opts.status,
          inlineCode(opts.branch),
          ...(opts.body ? [opts.body] : []),
        ].join('\n'),
      }],
    },
  }
}

function inlineCode(s: string): string {
  return '`' + s.replace(/`/g, '\\`') + '`'
}
