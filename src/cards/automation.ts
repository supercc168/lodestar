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
