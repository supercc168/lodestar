/**
 * Schema 2.0 turn-card templates: the main streaming card, the per-tool
 * collapsible panels, and the AskUserQuestion interactive panel. All
 * rendering for "the in-flight conversation card" lives here. Console
 * UI lives in console.ts; the shared element-id convention is in
 * elements.ts.
 */

import { ELEMENTS } from './elements'

/** Minimal projection of a Codex task — used by Session's local mirror,
 * built incrementally from observed TaskCreate / TaskUpdate input+output
 * pairs. Not authoritative (Codex is the source of truth), but enough
 * to render the "全部任务清单" footer on every Task* panel. */
export interface Todo {
  id: number
  subject?: string
  description?: string
  status: 'pending' | 'in_progress' | 'completed' | string
  owner?: string
  activeForm?: string
}

function todoStatusIcon(s: string): string {
  switch (s) {
    case 'pending':     return '☐'
    case 'in_progress': return '🔄'
    case 'completed':   return '✅'
    default:            return '·'
  }
}

/** Render the session's full todo mirror as a markdown list. Empty list
 * yields '' so callers can unconditionally concat. Sorted by numeric id
 * so the order matches creation order regardless of Map iteration. */
function renderTodoList(todos: Todo[]): string {
  if (!todos || todos.length === 0) return ''
  const sorted = [...todos].sort((a, b) => a.id - b.id)
  const lines = ['', '---', `**📋 当前任务清单（${sorted.length} 项）**`, '']
  for (const t of sorted) {
    const icon = todoStatusIcon(t.status)
    const subject = t.subject ?? '(无 subject)'
    const ownerTag = t.owner ? `  · ${t.owner}` : ''
    lines.push(`- ${icon} **#${t.id}** ${subject}${ownerTag}`)
  }
  return lines.join('\n')
}

/** Single-line summary used as a collapsible-panel header for a tool call. */
export function summarizeToolInput(name: string, input: any): string {
  if (!input || typeof input !== 'object') return ''
  const truncate = (s: string, n: number) => s.length > n ? s.slice(0, n) + '…' : s
  // Task workflow tools (TaskCreate / TaskUpdate / TaskList / ...) carry
  // structured fields that summarize much better as natural language than
  // as truncated JSON. Routed first so they don't fall through to the
  // generic Agent/Task case below.
  if (name.startsWith('Task') && name !== 'Task') {
    return truncate(summarizeTaskWorkflow(name, input), 80)
  }
  switch (name) {
    case 'Bash':       return summarizeBashInput(input)
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

function summarizeBashInput(input: any): string {
  const truncate = (s: string, n: number) => s.length > n ? s.slice(0, n) + '…' : s
  const info = bashPresentation(input)
  if (info.description) return truncate(info.description.replace(/\s+/g, ' '), 80)
  const command = info.command
  if (!command) return ''
  const oneLine = command.replace(/\s+/g, ' ')
  const lines = command.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines.length <= 1) return truncate(oneLine, 80)
  const firstMeaningful = lines.find(line =>
    !line.startsWith('#') &&
    !/^set\s+-/.test(line) &&
    !/^cd\s+/.test(line) &&
    !/^[A-Za-z_][A-Za-z0-9_]*=/.test(line) &&
    !/^cat\s+<<['"]?\w+['"]?/.test(line)
  ) ?? lines[0]
  return `Shell 脚本 · ${lines.length} 行 · ${truncate(firstMeaningful, 46)}`
}

function bashPresentation(input: any): { description: string; command: string } {
  const rawCommand = unwrapShellCommand(String(input?.command ?? input?.cmd ?? input?.script ?? ''))
  const firstLine = rawCommand.split('\n', 1)[0]?.trim() ?? ''
  const comment = firstLine.startsWith('#') && !firstLine.startsWith('#!')
    ? firstLine.replace(/^#\s*/, '').trim()
    : ''
  const commentDesc = comment.replace(/^(?:desc|dec|description|说明|目的|用途)\s*[:：]\s*/i, '').trim()
  const command = commentDesc
    ? rawCommand.split('\n').slice(1).join('\n').trimStart()
    : rawCommand
  const explicit = String(input?.description ?? input?.reason ?? '').trim()
  return { description: commentDesc || explicit, command: command || rawCommand }
}

function unwrapShellCommand(command: string): string {
  const normalized = command.replace(/\r\n/g, '\n').trim()
  const shell = normalized.match(/^(?:\/usr\/bin\/env\s+)?(?:\/[\w./-]+\/)?(?:ba|z|fi)?sh\s+-[A-Za-z]*c[A-Za-z]*\s+([\s\S]+)$/)
  if (!shell) return normalized
  const inner = stripShellArgQuotes(shell[1])
  return inner || normalized
}

function stripShellArgQuotes(arg: string): string {
  const s = arg.trim()
  if (s.length < 2) return s
  const pairs: Record<string, string> = { '"': '"', "'": "'", '“': '”' }
  const close = pairs[s[0]]
  if (!close || !s.endsWith(close)) return s
  const body = s.slice(1, -1)
  if (s[0] === "'") return body.replace(/'\\''/g, "'")
  return body.replace(/\\(["\\$`])/g, '$1').replace(/\\n/g, '\n')
}

function fenceBlock(text: string, lang = ''): string {
  let fence = '```'
  while (text.includes(fence)) fence += '`'
  return `${fence}${lang}\n${text}\n${fence}`
}

function inlineCode(v: unknown): string {
  return '`' + String(v ?? '').replace(/`/g, "'") + '`'
}

function renderBashBody(input: any, output: string | null, resolvedNote?: string): string {
  const info = bashPresentation(input)
  const command = info.command
  const reason = info.description
  const lines: string[] = []
  if (reason) lines.push(`**目的**: ${reason}`)
  if (input?.cwd) lines.push(`**cwd**: ${inlineCode(input.cwd)}`)
  if (input?.source) lines.push(`**source**: ${inlineCode(input.source)}`)
  if (lines.length > 0) lines.push('')
  lines.push('**命令**')
  lines.push(fenceBlock(command || '(空命令)', 'bash'))
  if (resolvedNote) {
    lines.push('')
    lines.push(resolvedNote)
  }
  if (output != null) {
    lines.push('')
    lines.push('---')
    lines.push('**output:**')
    lines.push(fenceBlock(output.slice(0, 3000)))
  }
  return lines.join('\n')
}

/** Header summary for Task* workflow tools — `Task` (singular) is the
 * separate subagent-spawn tool and is handled above; everything else
 * (TaskCreate / TaskUpdate / TaskList / TaskGet / TaskStop / TaskOutput /
 * TaskDelete) summarises through here. */
function summarizeTaskWorkflow(name: string, input: any): string {
  switch (name) {
    case 'TaskCreate':
      return `📝 创建: ${input.subject ?? '(无 subject)'}`
    case 'TaskUpdate': {
      const parts: string[] = []
      if (input.status) parts.push(`→ ${input.status}`)
      if (input.owner) parts.push(`owner=${input.owner}`)
      if (input.subject) parts.push(`subject="${input.subject}"`)
      if (input.addBlocks) parts.push(`blocks=[${(input.addBlocks ?? []).join(',')}]`)
      if (input.addBlockedBy) parts.push(`blockedBy=[${(input.addBlockedBy ?? []).join(',')}]`)
      const tail = parts.length ? ' ' + parts.join(', ') : ''
      return `✏️ #${input.taskId ?? '?'}${tail}`
    }
    case 'TaskList':   return '📋 查询任务列表'
    case 'TaskGet':    return `🔍 查询 #${input.taskId ?? '?'}`
    case 'TaskStop':   return `⏹ 停止 #${input.taskId ?? '?'}`
    case 'TaskOutput': return `📤 取输出 #${input.taskId ?? '?'}`
    case 'TaskDelete': return `🗑 删除 #${input.taskId ?? '?'}`
  }
  return name
}

/** Markdown body for Task* workflow tools — replaces the generic JSON
 * dump with a human-readable description of the operation plus, once the
 * tool result is in, Codex's text reply (which already contains "Task
 * #N created" / "Updated task #X" / a rendered list for TaskList). When
 * `todos` is non-empty, the full mirror is appended as a "📋 当前任务
 * 清单" footer so every Task* panel doubles as a current-state readout. */
function renderTaskWorkflowBody(name: string, input: any, output: string | null, todos?: Todo[]): string {
  const lines: string[] = []
  switch (name) {
    case 'TaskCreate':
      lines.push(`**📝 创建任务**`)
      if (input.subject)    lines.push(`- subject: ${input.subject}`)
      if (input.description) lines.push(`- 描述: ${input.description}`)
      if (input.activeForm) lines.push(`- 进行时: ${input.activeForm}`)
      break
    case 'TaskUpdate': {
      lines.push(`**✏️ 更新 #${input.taskId ?? '?'}**`)
      if (input.status)       lines.push(`- status → \`${input.status}\``)
      if (input.subject)      lines.push(`- subject: ${input.subject}`)
      if (input.description)  lines.push(`- description: ${input.description}`)
      if (input.owner)        lines.push(`- owner: ${input.owner}`)
      if (input.activeForm)   lines.push(`- 进行时: ${input.activeForm}`)
      if (input.addBlocks)    lines.push(`- blocks → ${(input.addBlocks).join(', ')}`)
      if (input.addBlockedBy) lines.push(`- blockedBy → ${(input.addBlockedBy).join(', ')}`)
      if (input.metadata)     lines.push(`- metadata: \`${JSON.stringify(input.metadata)}\``)
      break
    }
    case 'TaskList':   lines.push('**📋 查询当前任务清单**'); break
    case 'TaskGet':    lines.push(`**🔍 查询 #${input.taskId ?? '?'}**`); break
    case 'TaskStop':   lines.push(`**⏹ 停止 #${input.taskId ?? '?'}**`); break
    case 'TaskOutput': lines.push(`**📤 取 #${input.taskId ?? '?'} 输出**`); break
    case 'TaskDelete': lines.push(`**🗑 删除 #${input.taskId ?? '?'}**`); break
    default:
      lines.push(`**${name}**`)
      lines.push('```\n' + JSON.stringify(input ?? {}, null, 2).slice(0, 1000) + '\n```')
  }
  if (output != null) {
    lines.push('')
    lines.push('---')
    lines.push('**结果**')
    lines.push(output.slice(0, 3000))
  }
  return lines.join('\n') + renderTodoList(todos ?? [])
}

interface MainCardOpts {
  sessionName: string
  turn: number
  model?: string
  effort?: string
  /** What started this turn:
   *   'user_message' — user input batch(panel "📥 收到 (N)" 渲染原文)
   *   'scheduled'    — cron / ScheduleWakeup 自发开 turn(banner `⏰ 触发`)
   *   'card_full'    — 同一 Codex turn 的"续卡":前一张卡写满(element 数
   *                   触顶 ~75)或写入被飞书拒,session rotate 出来的新卡
   *                   (banner `📨 接续上一张`,无 panel,turn 号跟旧卡
   *                   相同) */
  kind?: 'user_message' | 'scheduled' | 'card_full'
  /** 本轮 Codex 收到的 user wireText 列表。boot turn 通常是 1 条;mid-turn
   * 用户连发的 N 条会在下一 turn 一并塞进。空数组 / undefined 时不渲染
   * userInput panel(scheduled / cron-fired turn 没 user input)。 */
  userInputs?: string[]
}

/** Local wall-clock stamp `YYYY-MM-DD HH:MM:SS` for the scheduled-fire
 * banner. scheduled turns 自发开,没有用户消息做"何时触发"的锚点;卡片又
 *会一直留在群历史里,夜里 cron 跑的轮次第二天回看时,banner 上带个触发
 * 时刻才能一眼对上是几点起的。零填充沿用 notify.ts / console.ts 的写法。 */
function fireStampNow(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Initial card sent at the start of each turn. Streaming on. */
export function mainConversationCard(opts: MainCardOpts): object {
  const banner = opts.kind === 'scheduled'
    ? [{ tag: 'markdown', content: `⏰ 触发 · ${fireStampNow()}` }]
    : opts.kind === 'card_full'
    ? [{ tag: 'markdown', content: '📨 接续上一张(同一轮 Codex turn,前一张卡写满或写入受限)' }]
    : []
  const inputs = opts.userInputs ?? []
  const userInputPanel = inputs.length > 0
    ? [{
        tag: 'collapsible_panel',
        element_id: ELEMENTS.userInput,
        header: { title: { tag: 'plain_text', content: `📥 收到 (${inputs.length})` } },
        expanded: false,
        elements: inputs.map(text => ({
          tag: 'markdown',
          // Markdown 里 < > 这些字符在 Card Kit 渲染里会被解析,转一下避免
          // 用户输入里的 HTML 之类被当结构吞掉。
          content: text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        })),
      }]
    : []
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
      // Initial body: [scheduled banner?] + [userInput panel?] + ticker
      // (活体指示) + footer。assistant segments 和 tool panels insert_before
      // footer 在 Codex streaming 时实时插入。
      // 空字符串会被 CardKit PUT 拒,所以两个占位都用单空格;首条真写入
      // 自动覆盖。footer 留单空格而不是 `⏳ working…` —— 顶部 ticker 已经
      // 在"模型还在干活"这件事上做活体指示了,底部再喊一遍冗余且突兀。
      // closeTurnCard 收尾时会 streamText 写真正的最终态 (`✅ 12.3s · 💰 $0.05`
      // 之类)。
      elements: [
        ...banner,
        ...userInputPanel,
        { tag: 'markdown', element_id: ELEMENTS.ticker, content: ' ' },
        { tag: 'markdown', element_id: ELEMENTS.footer, content: ' ' },
      ],
    },
  }
}

/** Empty assistant segment to be inserted just before the footer. */
export function assistantSegmentElement(i: number): object {
  return { tag: 'markdown', element_id: ELEMENTS.assistant(i), content: ' ' }
}

/** Element to insert for each tool call. Expandable for big results.
 *
 * Header is a one-line summary: status + name + summarized input.
 * Body holds the full input + (after completion) the full output.
 * `resolvedNote` is an optional one-liner appended below the input —
 * used to surface "✅ 允许 by Alice" inline after a permission decision
 * lands but before the actual tool execution completes. */
export function toolCallElement(
  i: number,
  name: string,
  input: any,
  output: string | null,
  status: '⏳' | '✅' | '❌' = '⏳',
  resolvedNote?: string,
  /** Session's full todo mirror — only rendered when the tool is a Task*
   * workflow op. Other tools ignore it. Passed in by Session so every
   * Task* panel shows the *current* state, not just this op's diff. */
  todos?: Todo[],
): object {
  const summary = summarizeToolInput(name, input)
  const headerText = summary
    ? `${status} 🔧 ${name}: ${summary}`
    : `${status} 🔧 ${name}`
  const isTaskWorkflow = name.startsWith('Task') && name !== 'Task'
  const noteBlock = resolvedNote ? `\n\n${resolvedNote}` : ''
  // Task* gets a narrative body (operation + result + current todo list),
  // the rest keeps the JSON-input + raw-output split — generic dump is
  // better for unfamiliar tools where users can't predict what fields
  // matter.
  const body = isTaskWorkflow
    ? renderTaskWorkflowBody(name, input, output, todos) + noteBlock
    : name === 'Bash'
      ? renderBashBody(input, output, resolvedNote)
      : '```\n' + JSON.stringify(input ?? {}, null, 2).slice(0, 2000) + '\n```'
        + noteBlock
        + (output != null ? '\n---\n**output:**\n```\n' + output.slice(0, 3000) + '\n```' : '')
  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.tool(i),
    header: { title: { tag: 'plain_text', content: headerText } },
    expanded: false,
    elements: [
      { tag: 'markdown', content: body },
    ],
  }
}

/** Panel for one or more `Read` tool calls in a row. Body lists file
 * paths only — never the contents, since piping repo source into a
 * Feishu group is the wrong default (chat history persists, the bot
 * runs as the user, so anything readable on disk is one tool-call away
 * from being archived in Lark). Header collapses to `Read: <path>` for
 * a single item and `Read · N 次` once a run has joined. */
export function readBatchElement(
  i: number,
  items: Array<{ input: any; output: string | null; isError: boolean }>,
): object {
  const n = items.length
  const anyError = items.some(it => it.isError)
  const allDone = items.every(it => it.output !== null)
  const status = anyError ? '❌' : allDone ? '✅' : '⏳'
  const headerText = n === 1
    ? (() => {
        const summary = summarizeToolInput('Read', items[0]?.input)
        return summary ? `${status} 🔧 Read: ${summary}` : `${status} 🔧 Read`
      })()
    : `${status} 🔧 Read · ${n} 次`
  const lines = items.map(it => `\`${String(it.input.file_path ?? '(无 path)')}\``)
  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.tool(i),
    header: { title: { tag: 'plain_text', content: headerText } },
    expanded: false,
    elements: [{ tag: 'markdown', content: lines.join('\n') }],
  }
}

/** Same tool panel as `toolCallElement`, but with the 🔐 status and
 * three inline action buttons (allow / allow_always / deny). Expanded
 * by default so the user can read the request without clicking through.
 * This is the "merge into tool panel" UX — the permission decision
 * lives on the same row as the tool call instead of as a separate
 * floating card. */
export function toolCallPermissionElement(
  i: number,
  name: string,
  input: any,
  requestId: string,
): object {
  const summary = summarizeToolInput(name, input)
  const headerText = summary
    ? `🔐 等审批 · ${name}: ${summary}`
    : `🔐 等审批 · ${name}`
  const inputBlock = name === 'Bash'
    ? renderBashBody(input, null)
    : '```\n' + JSON.stringify(input ?? {}, null, 2).slice(0, 2000) + '\n```'
  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.tool(i),
    header: { title: { tag: 'plain_text', content: headerText } },
    expanded: true,
    elements: [
      { tag: 'markdown', content: inputBlock },
      {
        tag: 'column_set',
        columns: [
          permissionButtonColumn('✅ 允许', 'primary', requestId, 'allow'),
          permissionButtonColumn('♾️ 始终允许', 'default', requestId, 'allow_always'),
          permissionButtonColumn('❌ 拒绝', 'danger', requestId, 'deny'),
        ],
      },
    ],
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

/** Schema of an AskUserQuestion question, projected to just the fields
 * the panel needs. Mirrors the SDK tool's input — kept loose since the
 * runtime guarantees it matches. */
export interface AskQuestion {
  question: string
  header?: string
  multiSelect?: boolean
  options: { label: string; description?: string }[]
}

/** Per-question final-state. Mutually-exclusive branches: option pick
 * vs. free-form custom text. */
export interface AskAnswered {
  optionIdx?: number
  customText?: string
  user?: string
}

/** State the panel renders against. `currentIdx` undefined → terminal
 * (every question answered). Otherwise it's the question currently on
 * screen; everything in `answered` is history. */
export interface AskState {
  currentIdx?: number
  answered: Map<number, AskAnswered>
}

/** Render one question's body — either as clickable interactive_container
 * rows (when picked === undefined) or as plain markdown summary
 * (already-answered, shown in history-panel context). */
function renderAskQuestionBody(
  q: AskQuestion,
  toolUseId: string,
  questionIdx: number,
  picked?: AskAnswered,
): any[] {
  const els: any[] = []
  els.push({ tag: 'markdown', content: `**${q.question}**` })
  for (let oi = 0; oi < q.options.length; oi++) {
    const opt = q.options[oi]
    const desc = opt.description ? `  ·  ${opt.description}` : ''
    if (picked) {
      const isPicked = picked.optionIdx === oi
      els.push({
        tag: 'markdown',
        content: isPicked
          ? `✅ **${opt.label}**${desc}`
          : `~~◯ ${opt.label}${desc}~~`,
      })
    } else {
      els.push({
        tag: 'interactive_container',
        background_style: 'default',
        has_border: true,
        corner_radius: '6px',
        padding: '8px 12px',
        margin: '4px 0px 4px 0px',
        behaviors: [{
          type: 'callback',
          value: {
            kind: 'ask',
            tool_use_id: toolUseId,
            question_idx: questionIdx,
            option_idx: oi,
          },
        }],
        elements: [{ tag: 'markdown', content: `**${opt.label}**${desc}` }],
      })
    }
  }
  if (picked?.customText) {
    els.push({ tag: 'markdown', content: `✏️ **自定义回答**：${picked.customText}` })
  }
  return els
}

/** Folded "📜 已答 N 题" panel — option C from the multi-question
 * design discussion. Returns null when there's no history to show. */
function renderAskHistoryPanel(
  questions: AskQuestion[],
  answered: Map<number, AskAnswered>,
): any | null {
  if (answered.size === 0) return null
  const lines: string[] = []
  const sortedIdx = [...answered.keys()].sort((a, b) => a - b)
  for (const idx of sortedIdx) {
    const q = questions[idx]
    const a = answered.get(idx)!
    const tag = q?.header ?? `Q${idx + 1}`
    const value = a.customText
      ?? (a.optionIdx !== undefined ? q?.options[a.optionIdx]?.label : undefined)
      ?? '?'
    lines.push(`- ✅ **${tag}**：${value}`)
  }
  return {
    tag: 'collapsible_panel',
    header: {
      title: { tag: 'plain_text', content: `📜 已答 ${answered.size} 题（点击展开）` },
    },
    expanded: false,
    elements: [{ tag: 'markdown', content: lines.join('\n') }],
  }
}

/** Tool-panel renderer for `AskUserQuestion` — Codex's structured
 * multiple-choice question. Daemon takes over the client-side role:
 * instead of letting the request fall through to the generic JSON
 * dump (or worse, the permission flow that misappropriates it), we
 * render each question with one button per option, callbacks tagged
 * `kind:'ask'` so the Lark handler can route the answer back as a
 * `tool_result`.
 *
 * Single-question is the common case; multi-question gets buttons on
 * the first question only and a text-only listing for the rest (an
 * acceptable limitation — these are rare in practice and we can lift
 * it once the UX is validated). */
export function askUserQuestionElement(
  i: number,
  toolUseId: string,
  questions: AskQuestion[],
  status: '🤔' | '✅' | '❌' = '🤔',
  state?: AskState,
): object {
  const total = questions.length
  const answered = state?.answered ?? new Map<number, AskAnswered>()
  const currentIdx = state?.currentIdx
  const isTerminal = currentIdx === undefined && answered.size > 0
  const bodyElements: any[] = []
  let headerText: string

  if (isTerminal) {
    // All questions resolved — collapse and roll up answers in header
    // + body. Single-question case keeps the old "已回答：xxx" header
    // style; multi-question gets a "已回答 · N 题" count and a flat
    // listing of Q→A pairs in the body.
    if (total === 1) {
      const q0 = questions[0]
      const a0 = answered.get(0)
      const value = a0?.customText
        ?? (a0?.optionIdx !== undefined ? q0?.options[a0.optionIdx]?.label : undefined)
        ?? '?'
      const headerTag = q0?.header ? ` · ${q0.header}` : ''
      headerText = `${status} 已回答${headerTag}：${value}`
    } else {
      headerText = `${status} 已回答 · ${total} 题`
    }
    const sortedIdx = [...answered.keys()].sort((a, b) => a - b)
    for (const idx of sortedIdx) {
      const q = questions[idx]
      const a = answered.get(idx)!
      const tag = q?.header ?? `Q${idx + 1}`
      const value = a.customText
        ?? (a.optionIdx !== undefined ? q?.options[a.optionIdx]?.label : undefined)
        ?? '?'
      bodyElements.push({
        tag: 'markdown',
        content: `**${tag}**：${value}`,
      })
    }
    const lastUser = [...answered.values()].reverse().find(a => a.user)?.user
    if (lastUser) {
      bodyElements.push({
        tag: 'markdown',
        content: `\n*— 由 ${lastUser} 回答*`,
      })
    }
  } else if (currentIdx !== undefined && questions[currentIdx]) {
    // In-progress: render current question + folded history above.
    // Progress tag in header lets the user see how many are left,
    // even with the history panel folded.
    const q = questions[currentIdx]
    const headerTag = q.header ? ` · ${q.header}` : ''
    const progress = total > 1 ? ` (${currentIdx + 1}/${total})` : ''
    headerText = `${status} 🤔 AskUserQuestion${headerTag}${progress}`
    const history = renderAskHistoryPanel(questions, answered)
    if (history) bodyElements.push(history)
    bodyElements.push(...renderAskQuestionBody(q, toolUseId, currentIdx))
    bodyElements.push({
      tag: 'markdown',
      content: '_💬 也可以直接在群里回复你的答案（裸词命令 `hi`/`kill`/`restart`/`clear` 仍然优先）_',
    })
  } else {
    // Defensive fallback — neither answered nor a valid currentIdx.
    headerText = `${status} 🤔 AskUserQuestion`
    if (questions[0]) {
      bodyElements.push({ tag: 'markdown', content: `**${questions[0].question}**` })
    }
  }

  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.tool(i),
    header: { title: { tag: 'plain_text', content: headerText } },
    expanded: !isTerminal,
    elements: bodyElements,
  }
}
