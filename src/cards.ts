/**
 * Schema 2.0 Feishu card templates.
 *
 * Element-id convention (must be unique within a card):
 *   user_input        — the collapsible "你说" panel
 *   thinking          — the de-emphasized thinking stream
 *   tool_<i>          — one collapsible per tool call, indexed from 0
 *   assistant         — the main streaming assistant answer
 *   footer            — runtime footer (timing / status)
 */

export const ELEMENTS = {
  thinking: 'thinking',
  footer: 'footer',
  tool: (i: number) => `tool_${i}`,
  /** Assistant text is segmented: every tool call closes the running segment
   * and the next assistant chunk opens a new one, so element order in the
   * card matches Claude's emission order. */
  assistant: (i: number) => `assistant_${i}`,
} as const

/** Single-line summary used as a collapsible-panel header for a tool call. */
export function summarizeToolInput(name: string, input: any): string {
  if (!input || typeof input !== 'object') return ''
  const truncate = (s: string, n: number) => s.length > n ? s.slice(0, n) + '…' : s
  switch (name) {
    case 'Bash':       return truncate(String(input.command ?? ''), 80)
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit': return truncate(String(input.file_path ?? ''), 80)
    case 'Glob':       return truncate(String(input.pattern ?? ''), 80)
    case 'Grep':       return truncate(`${input.pattern ?? ''}${input.path ? ' in ' + input.path : ''}`, 80)
    case 'WebFetch':
    case 'WebSearch': return truncate(String(input.url ?? input.query ?? ''), 80)
    case 'Agent':
    case 'Task':       return truncate(String(input.description ?? input.subject ?? ''), 80)
    case 'Skill':      return truncate(String(input.skill ?? ''), 80)
  }
  // generic fallback: first string-valued field
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v) return truncate(v, 80)
  }
  return ''
}

interface MainCardOpts {
  sessionName: string
  turn: number
  model?: string
  effort?: string
  userText: string
}

/** Initial card sent at the start of each turn. Streaming on. */
export function mainConversationCard(_opts: MainCardOpts): object {
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      summary: { content: '[Lodestar 正在生成…]' },
      streaming_config: {
        print_frequency_ms: { default: 60, android: 60, ios: 60, pc: 30 },
        print_step: { default: 2, android: 2, ios: 2, pc: 4 },
        print_strategy: 'fast',
      },
    },
    body: {
      // Initial body has just thinking + footer; assistant segments and tool
      // panels are inserted between them in real time as Claude streams.
      // Note: empty-string content is rejected by CardKit PUT so the
      // thinking element starts with a single space placeholder; the first
      // real append overwrites it.
      elements: [
        { tag: 'markdown', element_id: ELEMENTS.thinking, content: ' ' },
        { tag: 'markdown', element_id: ELEMENTS.footer, content: '⏳ working…' },
      ],
    },
  }
}

/** Empty assistant segment to be inserted just before the footer. */
export function assistantSegmentElement(i: number): object {
  return { tag: 'markdown', element_id: ELEMENTS.assistant(i), content: ' ' }
}

/** Final state for the thinking section once a turn closes — collapse the
 * full thinking text into a panel so the card stays clean.  Replaces the
 * top-level `thinking` markdown element via PUT /elements/:id. */
export function thinkingCollapsedPanel(fullText: string): object {
  const trimmed = fullText.trim()
  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.thinking,
    header: { title: { tag: 'plain_text', content: `💭 思考过程 (${trimmed.length} 字)` } },
    expanded: false,
    elements: [
      { tag: 'markdown', content: trimmed.slice(0, 8000) || '_(空)_' },
    ],
  }
}

/** Element to insert for each tool call. expandable for big results.
 *
 * Header is a one-line summary: status + name + summarized input.
 * Body holds the full input + (after completion) the full output. */
export function toolCallElement(
  i: number,
  name: string,
  input: any,
  output: string | null,
  status: '⏳' | '✅' | '❌' = '⏳',
): object {
  const summary = summarizeToolInput(name, input)
  const headerText = summary
    ? `${status} 🔧 ${name}: ${summary}`
    : `${status} 🔧 ${name}`
  const inputBlock = '```\n' + JSON.stringify(input ?? {}, null, 2).slice(0, 2000) + '\n```'
  const outputBlock = output != null
    ? '\n---\n**output:**\n```\n' + output.slice(0, 3000) + '\n```'
    : ''
  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.tool(i),
    header: { title: { tag: 'plain_text', content: headerText } },
    expanded: false,
    elements: [
      { tag: 'markdown', content: inputBlock + outputBlock },
    ],
  }
}

interface PermissionOpts {
  sessionName: string
  toolName: string
  description: string
  inputPreview: string
  requestId: string
}

export function permissionCard(opts: PermissionOpts): object {
  const { sessionName, toolName, description, inputPreview, requestId } = opts
  let pretty = inputPreview
  try { pretty = JSON.stringify(JSON.parse(inputPreview), null, 2) } catch {}
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `🔐 权限请求 · ${toolName}` },
      subtitle: { tag: 'plain_text', content: sessionName },
      template: 'orange',
    },
    body: {
      elements: [
        { tag: 'markdown', content: description },
        { tag: 'markdown', content: '```\n' + pretty.slice(0, 2000) + '\n```' },
        {
          tag: 'column_set',
          columns: [
            permissionButtonColumn('✅ 允许', 'primary', requestId, 'allow'),
            permissionButtonColumn('♾️ 始终允许', 'default', requestId, 'allow_always'),
            permissionButtonColumn('❌ 拒绝', 'danger', requestId, 'deny'),
          ],
        },
      ],
    },
  }
}

function permissionButtonColumn(label: string, type: string, requestId: string, decision: string): object {
  return {
    tag: 'column', width: 'weighted', weight: 1,
    elements: [{
      tag: 'button',
      text: { tag: 'plain_text', content: label },
      type,
      behaviors: [{ type: 'callback', value: { kind: 'permission', request_id: requestId, decision } }],
    }],
  }
}

export function permissionResolvedCard(
  toolName: string,
  decision: 'allow' | 'allow_always' | 'deny',
  user: string,
): object {
  const ok = decision !== 'deny'
  const label = decision === 'allow_always' ? '始终允许' : decision === 'allow' ? '已允许' : '已拒绝'
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `🔐 权限请求 · ${toolName}` },
      template: ok ? 'green' : 'red',
    },
    body: {
      elements: [{
        tag: 'markdown',
        content: `${ok ? '✅' : '❌'} **${label}** by ${user || '匿名'} · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`,
      }],
    },
  }
}

interface ConsoleOpts {
  sessionName: string
  status: 'idle' | 'working' | 'awaiting_permission' | 'starting' | 'stopped'
  model?: string
  effort?: string
  uptime?: string
  lastActivity?: string
  hasSession: boolean
}

export function consoleCard(opts: ConsoleOpts): object {
  const { sessionName, status, model, effort, uptime, lastActivity, hasSession } = opts
  const statusEmoji = {
    idle: '🟢 闲', working: '⚙️ 工作中', awaiting_permission: '🔐 等审批',
    starting: '🚀 启动中', stopped: '⚪ 未运行',
  }[status]
  const meta = [
    `状态: ${statusEmoji}`,
    model ? `模型: ${model}${effort ? `/${effort}` : ''}` : null,
    uptime ? `运行: ${uptime}` : null,
    lastActivity ? `最近: ${lastActivity}` : null,
  ].filter(Boolean).join(' · ')

  const buttons: [string, string, string][] = hasSession
    ? [
        ['⏸ 中断', 'interrupt', 'default'],
        ['🧹 /clear', 'clear', 'default'],
        ['⏹ 终止', 'stop', 'danger'],
        ['📁 ls', 'ls', 'default'],
      ]
    : [
        ['🚀 启动', 'start', 'primary'],
        ['🔁 续聊', 'resume', 'default'],
        ['📁 ls', 'ls', 'default'],
      ]

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
        { tag: 'markdown', content: meta || '_(no state)_' },
        {
          tag: 'column_set',
          columns: buttons.map(([label, action, kind]) => ({
            tag: 'column', width: 'weighted', weight: 1,
            elements: [{
              tag: 'button',
              text: { tag: 'plain_text', content: label },
              type: kind,
              behaviors: [{ type: 'callback', value: { kind: 'console', action } }],
            }],
          })),
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

export const STREAMING_OFF_SETTINGS = {
  config: { streaming_mode: false, summary: { content: '✅ Lodestar 完成' } },
}
