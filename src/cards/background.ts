/**
 * 后台任务 / 子 agent 的状态累积 + 游标卡渲染。
 *
 * 与 cards/task-board.ts 的区别:task-board 是 TaskCreate/Update/List 工具
 * (用户任务板)的累积,渲染成 turn 卡内的常驻元素(element_id task_board_live);
 * 本模块是 SDK task_* 消息族(子 agent / 后台 bash / MCP / workflow 的后台
 * 执行)的累积,渲染成一张独立的「后台游标卡」——吸附在对话末尾,被新消息
 * 超越时沉降为历史快照(updateCard),只在全部终态时固化留在原地。
 *
 * 卡片结构(每任务合一个 panel —— 标题写状态+时长,展开看详情):
 *   ┌ config.summary: "🧭 后台任务 · N 进行中·M 已结束"   ← 聊天列表预览
 *   │ [bg_<id> collapsible_panel]                          ← 每任务一个 panel
 *   │   header: "🟢 Explore · 搜索 — 🟡 运行中 47s"        ← 状态+时长 标题
 *   │   └ [bg_body_<id>] 耗时/用量/任务/执行过程(steps)
 *   │ ...
 *
 * 状态机由 session 驱动(事件来自 claude-agent-process.handleSystemMessage):
 *   task_started      → applyBgTaskStarted  (新增 running,记 startedAt)
 *   task_progress     → applyBgTaskProgress (刷 usage / last_tool / summary)
 *   task_updated      → applyBgTaskUpdated  (改 status / is_backgrounded / error)
 *   task_notification → applyBgTaskSettled  (终态 + endTime)
 * 子 agent 逐步工具调用(tool_use/tool_result 带 parent_tool_use_id)归属到对应
 * task,累积成 steps[](trim 到最近 ~1000 字)。
 */

import type {
  BgTaskStartedEvent,
  BgTaskProgressEvent,
  BgTaskUpdatedEvent,
  BgTaskSettledEvent,
  BgTaskStatus,
} from '../claude-agent-process'

export type { BgTaskStatus }

/** 后台任务种类,归一化自 SDK task_type + subagent_type 推断。 */
export type BgTaskType = 'subagent' | 'shell' | 'monitor' | 'workflow' | 'unknown'

/** 一条后台任务的累积视图,session 以 task_id 为 key 维护一份数组。 */
export interface BgTaskEntry {
  id: string
  toolUseId?: string
  type: BgTaskType
  description: string
  subagentType?: string
  workflowName?: string
  /** 子 agent 任务描述(task_started.prompt)。 */
  prompt?: string
  status: BgTaskStatus
  /** 任务启动时刻(ms) —— 算运行时长的起点。 */
  startedAt: number
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
  lastToolName?: string
  summary?: string
  error?: string
  isBackgrounded?: boolean
  /** 终态时刻(ms);终态时长 = endTime - startedAt。 */
  endTime?: number
  /** 子 agent 逐步工具调用(按 parent_tool_use_id 归属),trim 到最近 ~1000 字。 */
  steps: BgTaskStep[]
}

/** 一步工具调用的简述(tool_use 到达时建,tool_result 到达时回填结果)。 */
export interface BgTaskStep {
  /** 关联的 tool_use id —— tool_result 到达时按它回填结果摘要到同一 step。 */
  toolUseId: string
  tool: string
  /** 单行简述:`工具 输入摘要` 或 `工具 输入摘要 → 结果摘要`(result 回填后)。 */
  brief: string
}

/** 后台卡内部 element_id:每任务一个 panel(bg_<id>),其 body 是 bg_body_<id>。
 * 刷新任务时 replaceElement 整个 panel(header 状态/时长 + body 一起)。 */
export const BG_ELEMENTS = {
  panel: (id: string) => `bg_${id}`,
  body: (id: string) => `bg_body_${id}`,
} as const

// ── 归一化 / 判定 ────────────────────────────────────────────────────

function normalizeType(taskType?: string, subagentType?: string): BgTaskType {
  // SDK 实测 task_type 带 local_ 前缀:local_agent / local_bash / local_workflow。
  const t = taskType ?? ''
  if (t === 'subagent' || t === 'local_agent') return 'subagent'
  if (t === 'shell' || t === 'local_bash' || t === 'local_shell') return 'shell'
  if (t === 'monitor' || t === 'local_monitor') return 'monitor'
  if (t === 'workflow' || t === 'local_workflow') return 'workflow'
  if (subagentType) return 'subagent'
  return 'unknown'
}

/** 终态:不再变化,不再占活跃计数。running / pending / paused 都算活跃。 */
export function isBgTerminal(t: BgTaskEntry): boolean {
  return t.status === 'completed' || t.status === 'failed' || t.status === 'killed'
}

/** 是否还有活跃任务(决定游标卡要不要继续跟随 / 重建)。 */
export function hasActiveBgTask(tasks: BgTaskEntry[]): boolean {
  return tasks.some(t => !isBgTerminal(t))
}

// ── 累积器(纯函数,不可变更新;now 默认 Date.now()) ────────────────────

export function applyBgTaskStarted(
  entries: BgTaskEntry[],
  e: BgTaskStartedEvent,
  now: number = Date.now(),
): BgTaskEntry[] {
  const type = normalizeType(e.task_type, e.subagent_type)
  if (entries.some(t => t.id === e.task_id)) {
    return entries.map(t => t.id === e.task_id
      ? {
          ...t,
          type,
          toolUseId: e.tool_use_id ?? t.toolUseId,
          description: e.description || t.description,
          subagentType: e.subagent_type ?? t.subagentType,
          workflowName: e.workflow_name ?? t.workflowName,
          prompt: e.prompt ?? t.prompt,
        }
      : t)
  }
  return [...entries, {
    id: e.task_id,
    toolUseId: e.tool_use_id,
    type,
    description: e.description,
    subagentType: e.subagent_type,
    workflowName: e.workflow_name,
    prompt: e.prompt,
    status: 'running',
    startedAt: now,
    steps: [],
  }]
}

export function applyBgTaskProgress(entries: BgTaskEntry[], e: BgTaskProgressEvent): BgTaskEntry[] {
  if (!entries.some(t => t.id === e.task_id)) return entries
  return entries.map(t => t.id === e.task_id
    ? {
        ...t,
        description: e.description ?? t.description,
        subagentType: e.subagent_type ?? t.subagentType,
        usage: e.usage ?? t.usage,
        lastToolName: e.last_tool_name ?? t.lastToolName,
        summary: e.summary ?? t.summary,
        status: t.status === 'pending' ? 'running' : t.status,
      }
    : t)
}

export function applyBgTaskUpdated(entries: BgTaskEntry[], e: BgTaskUpdatedEvent): BgTaskEntry[] {
  if (!entries.some(t => t.id === e.task_id)) return entries
  return entries.map(t => {
    if (t.id !== e.task_id) return t
    const p = e.patch
    return {
      ...t,
      status: p.status ?? t.status,
      description: p.description ?? t.description,
      error: p.error ?? t.error,
      isBackgrounded: p.is_backgrounded ?? t.isBackgrounded,
      endTime: p.end_time ?? t.endTime,
    }
  })
}

export function applyBgTaskSettled(
  entries: BgTaskEntry[],
  e: BgTaskSettledEvent,
  now: number = Date.now(),
): BgTaskEntry[] {
  const mapped: BgTaskStatus = e.status === 'completed' ? 'completed'
    : e.status === 'failed' ? 'failed'
    : 'killed'
  if (!entries.some(t => t.id === e.task_id)) {
    return [...entries, {
      id: e.task_id,
      type: 'unknown',
      description: e.summary ?? '(已结束)',
      status: mapped,
      startedAt: now,
      usage: e.usage,
      summary: e.summary,
      endTime: now,
      steps: [],
    }]
  }
  return entries.map(t => t.id === e.task_id
    ? { ...t, status: mapped, usage: e.usage ?? t.usage, summary: e.summary ?? t.summary, endTime: t.endTime ?? now }
    : t)
}

// ── 子 agent 逐步工具调用(parent_tool_use_id 关联) ────────────────────

const STEP_CHAR_BUDGET = 1000

/** 从最新 step 往回累加 brief 长度,超出 budget 丢最旧的 —— 保留最新的 ~1000 字过程。 */
function trimSteps(steps: BgTaskStep[]): BgTaskStep[] {
  let total = 0
  let keepFrom = 0
  for (let i = steps.length - 1; i >= 0; i--) {
    total += steps[i].brief.length + 5
    if (total > STEP_CHAR_BUDGET) { keepFrom = i + 1; break }
  }
  return keepFrom === 0 ? steps : steps.slice(keepFrom)
}

function briefInput(name: string, input: any): string {
  const s = (x: unknown): string => typeof x === 'string' ? x : ''
  switch (name) {
    case 'Bash': return `\`${s(input?.command).slice(0, 60)}\``
    case 'Read': return s(input?.file_path)
    case 'Edit': return s(input?.file_path)
    case 'Write': return s(input?.file_path)
    case 'Grep': return `"${s(input?.pattern)}" in ${s(input?.path ?? '.')}`
    case 'Glob': return `"${s(input?.pattern)}"`
    case 'Task': return s(input?.description)
    case 'WebSearch': return `"${s(input?.query)}"`
    default: return JSON.stringify(input ?? {}).replace(/\s+/g, ' ').slice(0, 60)
  }
}

function briefResult(content: string, isError: boolean): string {
  const c = (content ?? '').replace(/\s+/g, ' ').trim()
  return isError ? `❌ ${c.slice(0, 80)}` : c.slice(0, 80)
}

/** tool_use 到达:parent_tool_use_id 匹配的 task 追加一步(无结果)。主线程工具
 *  (parentToolUseId 为 null/undefined)跳过 —— 它们不属于任何后台 task。 */
export function applyBgToolUse(
  tasks: BgTaskEntry[],
  parentToolUseId: string | null | undefined,
  toolUseId: string,
  name: string,
  input: any,
): BgTaskEntry[] {
  if (!parentToolUseId) return tasks
  return tasks.map(t => t.toolUseId === parentToolUseId
    ? { ...t, steps: trimSteps([...t.steps, { toolUseId, tool: name, brief: `${name} ${briefInput(name, input)}`.trim() }]) }
    : t)
}

/** tool_result 到达:按 tool_use_id 回填结果摘要到对应 step(同 task 内)。 */
export function applyBgToolResult(
  tasks: BgTaskEntry[],
  parentToolUseId: string | null | undefined,
  toolUseId: string,
  content: string,
  isError: boolean,
): BgTaskEntry[] {
  if (!parentToolUseId) return tasks
  return tasks.map(t => {
    if (t.toolUseId !== parentToolUseId) return t
    let matched = false
    const steps = t.steps.map(s => {
      if (matched || s.toolUseId !== toolUseId) return s
      matched = true
      return { ...s, brief: `${s.brief} → ${briefResult(content, isError)}` }
    })
    return { ...t, steps: trimSteps(steps) }
  })
}

// ── 渲染 ─────────────────────────────────────────────────────────────

const TYPE_ICON: Record<BgTaskType, string> = {
  subagent: '🟢',
  shell: '⚙️',
  monitor: '📡',
  workflow: '🔁',
  unknown: '🔹',
}

const TYPE_LABEL: Record<BgTaskType, string> = {
  subagent: '子agent',
  shell: 'shell',
  monitor: '监控',
  workflow: '工作流',
  unknown: '任务',
}

function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** ms → "45s" / "2m13s" / "1h5m"。 */
function fmtElapsed(ms: number): string {
  if (!ms || ms < 0) return '0s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60}m`
}

function ownerOf(t: BgTaskEntry): string {
  return t.subagentType ?? t.workflowName ?? TYPE_LABEL[t.type]
}

function terminalElapsed(t: BgTaskEntry): number {
  if (t.usage?.duration_ms) return t.usage.duration_ms
  if (t.endTime && t.endTime > t.startedAt) return t.endTime - t.startedAt
  return 0
}

/** 标题里的状态+时长标签(折叠时常驻可见)。running 显示「已运行 Ns」,终态「用时/失败 Ns」。 */
function statusLabel(t: BgTaskEntry, now: number): string {
  switch (t.status) {
    case 'running': return `🟡 运行中 ${fmtElapsed(now - t.startedAt)}`
    case 'paused': return `⏸️ 已暂停 ${fmtElapsed(now - t.startedAt)}`
    case 'pending': return `⚪ 等待中`
    case 'completed': return `✅ 用时 ${fmtElapsed(terminalElapsed(t))}`
    case 'failed': return `❌ 失败 ${fmtElapsed(terminalElapsed(t))}`
    case 'killed': return `💀 已终止 ${fmtElapsed(terminalElapsed(t))}`
  }
}

/** header 摘要:N 进行中(· M 已结束)。聊天列表预览(config.summary)用。 */
export function summarizeBackground(tasks: BgTaskEntry[]): string {
  const active = tasks.filter(t => !isBgTerminal(t)).length
  const terminal = tasks.length - active
  if (active > 0) return `${active} 进行中${terminal ? ` · ${terminal} 已结束` : ''}`
  return terminal ? `${terminal} 已结束` : '空'
}

/** 详情 body —— 精简:仅 error(异常一行) + steps(执行过程,每步一行)。
 *  用量/摘要/prompt 等元信息不入 body(header 状态行已够,后面占行越少越好)。 */
function renderDetailBody(t: BgTaskEntry): string {
  const lines: string[] = []
  if (t.error) lines.push(`⚠ ${t.error}`)
  for (let i = 0; i < t.steps.length; i++) {
    lines.push(`${i + 1}. ${t.steps[i].brief}`)
  }
  return lines.length > 0 ? lines.join('\n') : '_(暂无执行记录)_'
}

/** 单任务的整 panel —— 标题写「图标 责任人·描述 — 状态·时长」,展开看详情 body。
 *  session 据此 addElement(新任务)/replaceElement(刷新,整个 panel)。 */
export function backgroundTaskPanel(t: BgTaskEntry, now: number = Date.now()): object {
  return {
    tag: 'collapsible_panel',
    element_id: BG_ELEMENTS.panel(t.id),
    header: { title: { tag: 'plain_text', content: `${TYPE_ICON[t.type]} ${ownerOf(t)} · ${t.description || '(无描述)'} — ${statusLabel(t, now)}` } },
    expanded: false,
    elements: [{ tag: 'markdown', element_id: BG_ELEMENTS.body(t.id), content: renderDetailBody(t) }],
  }
}

/** 活卡整张 JSON —— 首个后台任务到来时 sendCard 用。streaming 开。
 *  初始 body = 每任务一个 panel。 */
export function backgroundLiveCard(tasks: BgTaskEntry[], now: number = Date.now()): object {
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      summary: { content: `🧭 后台任务 · ${summarizeBackground(tasks)}` },
    },
    body: {
      elements: tasks.map(t => backgroundTaskPanel(t, now)),
    },
  }
}

/** 历史沉降卡 —— 用户发新消息且仍有活跃任务时,把旧卡 updateCard 成这个。
 *  只渲染终态任务,streaming 关。留在原地不再跟随。 */
export function backgroundHistoryCard(tasks: BgTaskEntry[], now: number = Date.now()): object {
  const terminal = tasks.filter(isBgTerminal)
  return {
    schema: '2.0',
    config: {
      streaming_mode: false,
      summary: { content: `🧭 后台任务(历史) · ${terminal.length} 已结束` },
    },
    body: {
      elements: terminal.map(t => backgroundTaskPanel(t, now)),
    },
  }
}

/** 固定标识卡 —— 旧卡撤销时若全部仍在跑(无终态),updateCard 成这个占位。 */
export function backgroundMigratedMarker(): object {
  return {
    schema: '2.0',
    config: {
      streaming_mode: false,
      summary: { content: '↪ 后台任务进行中' },
    },
    body: {
      elements: [{
        tag: 'markdown',
        element_id: 'bg_marker',
        content: '↪ 本轮后台任务仍在进行，进度已迁至最新卡片',
      }],
    },
  }
}
