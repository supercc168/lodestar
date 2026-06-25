/**
 * Claude Code Task 工具(TaskCreate/Update/List/Get)的累积状态板 + 渲染。
 *
 * 为什么需要这层:codex 的 TodoWrite 一次调用就带完整 todos 数组,直接渲染
 * 即可。但 Claude Code 把它拆成了 4 个工具 —— TaskCreate/Update/Get 都是
 * 单点操作,只有 TaskList 才返回完整快照。只看单次工具调用的数据,渲染出来
 * 就是碎片:TaskCreate 只显示"待办 1 项",TaskUpdate 只显示"改了某条",根本
 * 看不到整体进度。官方文档(code.claude.com/docs/en/agent-sdk/todo-tracking)
 * 的建议就是 —— 维护一份以 task id 为 key 的 map,跨调用累积。
 *
 * 本模块是纯函数 + 类型,无 Session 依赖;session-tools.ts 持有 board 并在
 * 每次 Task 工具完成时调 applyTaskTool 累积,再调 taskBoardElement 渲染整个
 * board,产出与 codex TodoWrite 一致的列表效果。
 */

import { ELEMENTS } from './elements'

/** 一条任务在板上的累积视图。status 含 'deleted' —— 删除不真删,先标记,
 * 供渲染层过滤;真正移除由 TaskList 全量替换或下一次重建自然回收。 */
export interface TaskBoardEntry {
  id: string
  subject: string
  description?: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
}

export type TaskToolName = 'TaskCreate' | 'TaskUpdate' | 'TaskList' | 'TaskGet'

const TASK_TOOL_NAMES: ReadonlySet<TaskToolName> = new Set([
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
])

/** 判定 + 类型收窄合一:是 Task 工具就返回它的强类型名,否则 null。
 * 调用方(session-tools.ts)用它替代 tool.ts 私有的 isPlanTaskTool,避免跨
 * 模块依赖 module-private 函数。 */
export function asTaskToolName(name: string): TaskToolName | null {
  return TASK_TOOL_NAMES.has(name as TaskToolName) ? name as TaskToolName : null
}

/** 本次渲染的是哪个操作 + 面板状态。header 上的"创建任务/更新任务/..."区分
 * 仍保留(让用户知道这一步在干嘛),但 body 永远渲染整个 board 的当前快照。 */
export interface TaskBoardOp {
  name: TaskToolName
  status: '⏳' | '✅' | '❌'
}

const OP_LABEL: Record<TaskToolName, string> = {
  TaskCreate: '创建任务',
  TaskUpdate: '更新任务',
  TaskList: '任务列表',
  TaskGet: '查看任务',
}

const STATUS_LABEL: Record<TaskBoardEntry['status'], string> = {
  pending: '待办',
  in_progress: '进行中',
  completed: '完成',
  deleted: '已删',
}

function parseOutput(output: string | null): any {
  if (!output) return null
  try {
    const parsed = JSON.parse(output)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** task id 的防御性读取:官方说 Claude Code 会把 id/task_id 修成 taskId,但
 * 这个修复不反映在流里,所以两侧都要认。 */
function taskIdOf(t: any): string {
  return String(t?.taskId ?? t?.id ?? t?.task_id ?? '').trim()
}

function subjectOf(t: any): string {
  return String(t?.subject ?? t?.content ?? '').trim()
}

function statusOf(t: any): TaskBoardEntry['status'] {
  const s = t?.status
  return s === 'pending' || s === 'in_progress' || s === 'completed' || s === 'deleted'
    ? s
    : 'pending'
}

/** 没有可靠 id 时的稳定回退 key —— 用 subject 本身,保证同一 subject 不会
 * 重复堆叠(TaskCreate 重试 / 模型重复发同一条时)。 */
function fallbackId(subject: string): string {
  return `subj:${subject}`
}

function entryFromSnapshot(t: any): TaskBoardEntry | null {
  const subject = subjectOf(t)
  if (!subject) return null
  const id = taskIdOf(t) || fallbackId(subject)
  return {
    id,
    subject,
    description: typeof t?.description === 'string' ? t.description : undefined,
    activeForm: typeof t?.activeForm === 'string' ? t.activeForm : undefined,
    status: statusOf(t),
  }
}

/**
 * 把一次 Task 工具调用累积到 board 上,返回**新** board(不可变更新)。
 *
 * - TaskList → output 是完整快照,全量替换(权威来源,能校正之前所有漂移)
 * - TaskCreate → output = `{ task: { id, subject } }`,抓 id 追加;同 id 已在
 *   板上则更新(批量创建 / 重发去重)
 * - TaskUpdate → input = `{ taskId, status, subject? }`,按 id 改;status=
 *   'deleted' 时移除该条
 * - TaskGet → output 是单条详情,补全 / 刷新板上的对应条目
 *
 * TaskCreate 在 addTool 阶段(output=null)拿不到 id,本函数此时不应被调用 ——
 * board 更新只在 completeTool(output 到位)后发生。若误传 null output,各分支
 * 会安全 no-op 返回原 board。
 */
export function applyTaskTool(
  board: TaskBoardEntry[],
  name: TaskToolName,
  input: any,
  output: string | null,
): TaskBoardEntry[] {
  if (name === 'TaskList') {
    const parsed = parseOutput(output)
    // tasks 字段存在(含空数组)就是权威快照,必须接受 —— 空数组表示模型
    // 已清空,接受它(no-fallbacks:不拿旧 board 藏掉上游明确结果)。只有
    // 根本没有合法 tasks 字段(output 解析失败 / 非 JSON 文本)才视为数据
    // 缺失,保留旧 board。
    const tasksArr: any[] | null = Array.isArray(parsed?.tasks)
      ? parsed.tasks
      : Array.isArray(parsed)
        ? parsed
        : null
    if (tasksArr === null) return board
    const next: TaskBoardEntry[] = []
    for (const t of tasksArr) {
      const e = entryFromSnapshot(t)
      if (e) next.push(e)
    }
    return next
  }

  if (name === 'TaskCreate') {
    const parsed = parseOutput(output)
    const t = parsed?.task ?? parsed
    const id = taskIdOf(t)
    const subject = subjectOf(t) || subjectOf(input)
    if (!subject) return board
    const key = id || fallbackId(subject)
    if (board.some(e => e.id === key)) {
      return board.map(e => e.id === key
        ? { ...e, id: key, subject, status: e.status === 'deleted' ? 'pending' : e.status }
        : e)
    }
    return [...board, { id: key, subject, status: 'pending' }]
  }

  if (name === 'TaskUpdate') {
    const id = taskIdOf(input)
    if (!id) return board
    const status = statusOf(input)
    if (status === 'deleted') return board.filter(e => e.id !== id)
    const newSubject = subjectOf(input)
    if (!board.some(e => e.id === id)) {
      // 模型 update 了一条 board 里没有的(比如 resume 后板为空)—— 用 input
      // 自带的 subject 兜底建一条,等下次 TaskList 校正。
      const subject = newSubject || id
      return [...board, { id, subject, status }]
    }
    return board.map(e => e.id === id
      ? { ...e, status, ...(newSubject ? { subject: newSubject } : {}) }
      : e)
  }

  if (name === 'TaskGet') {
    const parsed = parseOutput(output)
    const t = parsed?.task ?? parsed
    const id = taskIdOf(t) || taskIdOf(input)
    if (!id) return board
    const existing = board.find(e => e.id === id)
    const subject = subjectOf(t) || existing?.subject || subjectOf(input)
    if (!subject) return board
    const merged: TaskBoardEntry = {
      id,
      subject,
      description: typeof t?.description === 'string' ? t.description : existing?.description,
      activeForm: typeof t?.activeForm === 'string' ? t.activeForm : existing?.activeForm,
      status: t?.status ? statusOf(t) : (existing?.status ?? 'pending'),
    }
    return existing
      ? board.map(e => e.id === id ? merged : e)
      : [...board, merged]
  }

  return board
}

/** 渲染当前 board 的统计摘要,用作面板 header —— 与 codex TodoWrite 的
 * summarizeTodoInput 输出格式对齐("N 项 · 进行中 X · 待办 Y")。 */
export function summarizeTaskBoard(board: TaskBoardEntry[]): string {
  const visible = board.filter(t => t.status !== 'deleted')
  if (visible.length === 0) return '空'
  const counts = new Map<string, number>()
  for (const t of visible) {
    const label = STATUS_LABEL[t.status]
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  // 固定顺序:进行中 → 待办 → 完成,让进度一眼可读。
  const order = ['进行中', '待办', '完成']
  const summary = order
    .map(label => counts.has(label) ? `${label} ${counts.get(label)}` : '')
    .filter(Boolean)
    .join(' · ')
  return `${visible.length} 项${summary ? ` · ${summary}` : ''}`
}

function renderTaskBoardBody(board: TaskBoardEntry[], resolvedNote?: string): string {
  const visible = board.filter(t => t.status !== 'deleted')
  const lines: string[] = [`**待办**: ${visible.length} 项`]
  // 进行中的排最前,完成的沉底 —— 跟实际工作焦点一致。
  const rank: Record<TaskBoardEntry['status'], number> = {
    in_progress: 0, pending: 1, completed: 2, deleted: 3,
  }
  const ordered = [...visible].sort((a, b) => rank[a.status] - rank[b.status])
  for (const t of ordered.slice(0, 12)) {
    const label = STATUS_LABEL[t.status]
    // 进行中时优先用 activeForm(更"正在进行"的语气),其余用 subject。
    const content = (t.status === 'in_progress' && t.activeForm) ? t.activeForm : t.subject
    lines.push(`- ${label}: ${content || '(空)'}`)
  }
  if (ordered.length > 12) lines.push(`- 还有 ${ordered.length - 12} 项未显示`)
  if (resolvedNote) {
    lines.push('')
    lines.push(resolvedNote)
  }
  return lines.join('\n')
}

/**
 * Task 工具的面板:header 是本次操作名 + board 统计,body 是整个 board 的列表
 * 快照。与 codex TodoWrite 面板视觉一致 —— 无论这次是 Create/Update/Get,
 * 用户看到的都是"当前完整任务板 + 进度",而不是孤立的单条。
 */
export function taskBoardElement(
  i: number,
  board: TaskBoardEntry[],
  op: TaskBoardOp,
  resolvedNote?: string,
): object {
  const toolName = OP_LABEL[op.name]
  const summary = summarizeTaskBoard(board)
  const headerText = `${op.status} 🔧 ${toolName}: ${summary}`
  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.tool(i),
    header: { title: { tag: 'plain_text', content: headerText } },
    expanded: false,
    elements: [
      { tag: 'markdown', content: renderTaskBoardBody(board, resolvedNote) },
    ],
  }
}
