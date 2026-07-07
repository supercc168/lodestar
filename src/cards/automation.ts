/**
 * 任务清单自动化「工作室成员」运行的累积视图 + 状态卡渲染(纯层)。
 *
 * 与 cards/background.ts 平行:background 累积 SDK task_* 事件(会话内后台
 * 子 agent);本模块累积 tasklist-worker 的成员子进程运行(codex-plan /
 * agy-plan / codex-execute / agy-review / codex-merge),渲染成项目主群里
 * 一张按活跃波次的「自动化状态卡」——每运行一个折叠 panel,标题写成员+
 * 任务+状态+时长,展开看 stdout tail。
 *
 * 纯函数:reducers 不可变更新,render 无副作用。I/O 生命周期在
 * src/tasklist-cards.ts。本文件不 import feishu/cardkit/tasklist。
 */

import { fmtElapsed } from './format'
import { sanitizeMarkdownForCardKit } from './elements'

export type AutomationRunKind =
  | 'codex-plan' | 'agy-plan' | 'codex-execute' | 'agy-review' | 'codex-merge'

export type AutomationRunStatus = 'running' | 'completed' | 'failed'

/** 卡里一个成员运行的累积视图(tasklist-cards 以 runId 为 key 维护)。 */
export interface AutomationRunView {
  runId: string
  kind: AutomationRunKind
  taskGuid?: string
  taskSummary: string
  status: AutomationRunStatus
  /** 运行启动时刻(ms)。 */
  startedAt: number
  /** 终态时刻(ms);终态时长 = endTime - startedAt。 */
  endTime?: number
  /** 最近 stdout(尽力,trim 到预算)。 */
  stdoutTail: string
  error?: string
}

/** 一个项目当前波次的累积:runs + 空闲判定信号。 */
export interface AutomationBurst {
  runs: AutomationRunView[]
  /** 本轮扫描本卡是否有 run 开始/结束(settleIdleProjects 的空闲信号)。 */
  sawActivityThisScan: boolean
  /** 连续空闲扫描计数(防抖沉降)。 */
  idleScans: number
}

/** 卡内 element_id:每运行一个 panel(auto_run_<id>),其 body 是 auto_run_body_<id>。 */
export const AUTO_ELEMENTS = {
  panel: (runId: string) => `auto_run_${runId}`,
  body: (runId: string) => `auto_run_body_${runId}`,
} as const

const CARDED_KINDS: ReadonlySet<string> = new Set([
  'codex-plan', 'agy-plan', 'codex-execute', 'agy-review', 'codex-merge',
])

/** agy-pick 等非入卡 kind → false;5 个有意义成员 → true(并窄化类型)。 */
export function isCardedKind(kind: string): kind is AutomationRunKind {
  return CARDED_KINDS.has(kind)
}

const STDOUT_TAIL_BUDGET = 1500

/** 保留最近 STDOUT_TAIL_BUDGET 字,超出丢头部并前缀省略号。 */
function trimTail(s: string): string {
  const t = (s ?? '').trimEnd()
  return t.length <= STDOUT_TAIL_BUDGET ? t : '…' + t.slice(t.length - STDOUT_TAIL_BUDGET)
}

// ── reducers(纯,不可变) ──────────────────────────────────────────────

export function emptyBurst(): AutomationBurst {
  return { runs: [], sawActivityThisScan: false, idleScans: 0 }
}

/** 新成员运行入 burst(status=running)。已存在 runId 幂等(只标 sawActivity)。 */
export function burstAddRun(
  burst: AutomationBurst,
  runId: string,
  kind: AutomationRunKind,
  taskGuid: string | undefined,
  taskSummary: string,
  startedAt: number,
): AutomationBurst {
  if (burst.runs.some(r => r.runId === runId)) return { ...burst, sawActivityThisScan: true }
  const run: AutomationRunView = {
    runId, kind, taskGuid,
    taskSummary: taskSummary.trim() || '(无任务标题)',
    status: 'running', startedAt, stdoutTail: '',
  }
  return { ...burst, runs: [...burst.runs, run], sawActivityThisScan: true }
}

/** 更新某 run 的 stdout tail(便宜赋值)。无归属 run 返回原 burst 引用。 */
export function burstUpdateStdout(burst: AutomationBurst, runId: string, tail: string): AutomationBurst {
  if (!burst.runs.some(r => r.runId === runId)) return burst
  return {
    ...burst,
    runs: burst.runs.map(r => r.runId === runId ? { ...r, stdoutTail: trimTail(tail) } : r),
  }
}

/** 结算某 run 成终态。exited→completed,其余→failed。无归属 run 返回原引用。 */
export function burstSettleRun(
  burst: AutomationBurst,
  runId: string,
  processStatus: 'exited' | 'failed',
  error: string | undefined,
  endTime: number,
): AutomationBurst {
  if (!burst.runs.some(r => r.runId === runId)) return burst
  const status: AutomationRunStatus = processStatus === 'exited' ? 'completed' : 'failed'
  return {
    ...burst,
    sawActivityThisScan: true,
    runs: burst.runs.map(r => r.runId === runId ? { ...r, status, error: error ?? r.error, endTime } : r),
  }
}

/** 一轮扫描末尾结算:有活动→复位、idleScans=0;无活动→idleScans+1。
 *  返回新 burst 与是否该沉降(idleScans 达阈值)。 */
export function burstMarkScan(
  burst: AutomationBurst,
  idleThreshold = 1,
): { burst: AutomationBurst; shouldSettle: boolean } {
  if (burst.sawActivityThisScan) {
    return { burst: { ...burst, sawActivityThisScan: false, idleScans: 0 }, shouldSettle: false }
  }
  const idleScans = burst.idleScans + 1
  return { burst: { ...burst, idleScans }, shouldSettle: idleScans >= idleThreshold }
}

export function hasRunningRun(burst: AutomationBurst): boolean {
  return burst.runs.some(r => r.status === 'running')
}

// ── 渲染(纯) ─────────────────────────────────────────────────────────

const KIND_ICON: Record<AutomationRunKind, string> = {
  'codex-plan': '📝', 'agy-plan': '📝', 'codex-execute': '🛠️', 'agy-review': '🔍', 'codex-merge': '🔀',
}

const KIND_LABEL: Record<AutomationRunKind, string> = {
  'codex-plan': 'Codex规划', 'agy-plan': 'agy规划', 'codex-execute': 'Codex执行',
  'agy-review': 'agy审核', 'codex-merge': 'Codex合并',
}

export function memberLabel(kind: AutomationRunKind): string {
  return KIND_LABEL[kind]
}

function terminalElapsed(run: AutomationRunView): number {
  if (run.endTime && run.endTime > run.startedAt) return run.endTime - run.startedAt
  return 0
}

/** 标题里的状态+时长标签(折叠时常驻可见)。 */
export function statusLabel(run: AutomationRunView, now: number): string {
  switch (run.status) {
    case 'running': return `🟡 运行中 ${fmtElapsed(now - run.startedAt)}`
    case 'completed': return `✅ 用时 ${fmtElapsed(terminalElapsed(run))}`
    case 'failed': return `❌ 失败 ${fmtElapsed(terminalElapsed(run))}`
  }
}

/** 聊天列表预览(config.summary)用:N 进行中(· M 已结束)。 */
export function summarizeAutomation(runs: AutomationRunView[]): string {
  const running = runs.filter(r => r.status === 'running').length
  const done = runs.length - running
  if (running > 0) return `${running} 进行中${done ? ` · ${done} 已结束` : ''}`
  return done ? `${done} 已结束` : '空'
}

/** 详情 body:error 一行 + stdout tail;都空显 (暂无输出)。 */
function renderBody(run: AutomationRunView): string {
  const lines: string[] = []
  if (run.error) lines.push(`⚠ ${run.error}`)
  const tail = run.stdoutTail.trim()
  if (tail) lines.push(tail)
  return sanitizeMarkdownForCardKit(lines.length ? lines.join('\n') : '_(暂无输出)_')
}

/** 单运行的整 panel —— 标题「图标 成员 · 任务 — 状态·时长」,展开看 body。 */
export function automationRunPanel(run: AutomationRunView, now: number = Date.now()): object {
  return {
    tag: 'collapsible_panel',
    element_id: AUTO_ELEMENTS.panel(run.runId),
    header: { title: { tag: 'plain_text', content: `${KIND_ICON[run.kind]} ${memberLabel(run.kind)} · ${run.taskSummary} — ${statusLabel(run, now)}` } },
    expanded: false,
    elements: [{ tag: 'markdown', element_id: AUTO_ELEMENTS.body(run.runId), content: renderBody(run) }],
  }
}

/** 活卡整张 JSON —— 首个成员运行到来时 sendCard 用,streaming 开。 */
export function automationLiveCard(projectName: string, runs: AutomationRunView[], now: number = Date.now()): object {
  return {
    schema: '2.0',
    config: { streaming_mode: true, summary: { content: `🧭 ${projectName} 自动化 · ${summarizeAutomation(runs)}` } },
    body: { elements: runs.map(r => automationRunPanel(r, now)) },
  }
}

/** 历史沉降卡 —— 波次全空闲后 updateCard 成这个,只渲染终态 run,streaming 关。 */
export function automationHistoryCard(projectName: string, runs: AutomationRunView[], now: number = Date.now()): object {
  const terminal = runs.filter(r => r.status !== 'running')
  return {
    schema: '2.0',
    config: { streaming_mode: false, summary: { content: `🧭 ${projectName} 自动化(历史) · ${terminal.length} 已结束` } },
    body: { elements: terminal.map(r => automationRunPanel(r, now)) },
  }
}
