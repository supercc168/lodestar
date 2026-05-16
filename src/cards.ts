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
  /** Console (hi) card — the subscription-usage row is rendered as its
   * own element so we can replace it after the initial card lands,
   * decoupling the slow ccusage fetch from the rest of the panel's
   * synchronous data. */
  consoleUsage: 'console_usage',
} as const

/** Minimal projection of an SDK task — used by Session's local mirror,
 * built incrementally from observed TaskCreate / TaskUpdate input+output
 * pairs. Not authoritative (the SDK is the source of truth), but enough
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
 * tool result is in, the SDK's text reply (which already contains "Task
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
  userText: string
  /** What started this turn. `'scheduled'` adds a top-of-card banner so
   * the user can tell a cron-fired wakeup apart from one of their own
   * messages — the user's message bubble is otherwise the only visual
   * cue, and scheduled turns have no preceding bubble in the chat. */
  kind?: 'user_message' | 'scheduled'
}

/** Initial card sent at the start of each turn. Streaming on. */
export function mainConversationCard(opts: MainCardOpts): object {
  const banner = opts.kind === 'scheduled'
    ? [{ tag: 'markdown', content: '⏰ **定时任务触发** — Claude 在 idle 间隙被 CronCreate / ScheduleWakeup 唤醒' }]
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
      // Initial body has just thinking + footer; assistant segments and tool
      // panels are inserted between them in real time as Claude streams.
      // Note: empty-string content is rejected by CardKit PUT so the
      // thinking element starts with a single space placeholder; the first
      // real append overwrites it.
      elements: [
        ...banner,
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
  const inputBlock = '```\n' + JSON.stringify(input ?? {}, null, 2).slice(0, 2000) + '\n```'
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

/** Tool-panel renderer for `AskUserQuestion` — the SDK's structured
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
  usage?: import('./usage').UsageSnapshot
  /** Current context-window occupancy estimate (input + cache tokens of
   * the last assistant message). 0 if no turn has completed yet. */
  contextTokens?: number
  /** Window upper bound. Defaults to 1M (claude-opus-4-7[1m]). */
  contextLimit?: number
  cumStats?: { tokens: number; costUsd: number; turns: number }
  lastTurn?: { tokens: number; costUsd: number; durationMs: number }
  sessionId?: string | null
  hasSession: boolean
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
  usage: import('./usage').UsageSnapshot | undefined,
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
  // state === 'ok'
  const head = usage.subscriptionType
    ? `**📊 订阅额度** · ${usage.subscriptionType}`
    : '**📊 订阅额度**'
  const lines: string[] = [head]
  if (usage.fiveHour) {
    const parts = [`${Math.round(usage.fiveHour.percent)}%`]
    if (usage.fiveHour.resetsAt) parts.push(`重置 ${fmtResetIn(usage.fiveHour.resetsAt)}`)
    lines.push(`　· 5h　${parts.join(' · ')}`)
  }
  if (usage.weekly) {
    const parts = [`${Math.round(usage.weekly.percent)}%`]
    if (usage.weekly.resetsAt) parts.push(`重置 ${fmtResetIn(usage.weekly.resetsAt)}`)
    lines.push(`　· 7d　${parts.join(' · ')}`)
  }
  return lines.length === 1 ? '**📊 订阅额度**　_无数据_' : lines.join('\n')
}

export function consoleCard(opts: ConsoleOpts): object {
  const {
    sessionName, status, model, effort, uptimeMs, peers, usage,
    contextTokens, contextLimit, cumStats, lastTurn, sessionId, hasSession,
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
  if (contextTokens != null) {
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

  void hasSession // accept the field for caller compat; lifecycle is now
  // driven by bare-word commands (`hi` / `kill` / `restart` / `clear`),
  // not buttons — keeps the panel pure-readout and one-handed mobile-
  // friendly. The 'refresh' / 'ls' actions stay in onConsoleAction for
  // backward compat with any still-floating older cards in chat history.

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
