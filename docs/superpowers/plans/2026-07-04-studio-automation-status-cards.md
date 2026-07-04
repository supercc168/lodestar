# 任务清单自动化「工作室成员」状态卡 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让任务清单自动化流水线里的 Codex/agy「工作室成员」运行,在项目主群实时显示一张按活跃波次的状态卡,每个成员运行一个折叠 panel(标题实时状态+时长,展开显示 stdout tail),全空闲后沉降历史卡。

**Architecture:** 复刻 `src/cards/background.ts` 的「纯 reducer + 纯渲染」+ `src/session.ts` 的「I/O 生命周期」两层分离。纯层放 `src/cards/automation.ts`(累积 + 渲染,全单测);I/O 层放新模块 `src/tasklist-cards.ts`(内存卡句柄、开卡/30s tick 刷新/沉降,调 feishu+cardkit)。`src/tasklist-worker.ts` 的唯一子进程咽喉点 `runAgentProcess` 接三个 hook(`onRunStart`/`onRunStdout`/`onRunSettle`),扫描末尾接 `settleIdleProjects()`。卡片发到 `binding.chatId`(新增字段,`enableTasklist` 落库 + 旧 binding worker 首轮回填 + `task` 面板自愈)。

**Tech Stack:** TypeScript,Bun runtime + `bun test`,Feishu Card Kit schema 2.0,`node:child_process`。

## Global Constraints

- 卡写失败**绝不阻塞** tasklist-worker:所有 feishu/cardkit 调用在 I/O 层,worker 主体不感知失败。
- 纯层(`automation.ts`)不 import `feishu`/`cardkit`/`tasklist`,只做不可变累积与渲染(对标 `background.ts`)。
- 校验只用 `bun test <file>` 与 `bun run build`(仓库无独立 tsc typecheck;见 `AGENTS.md:45`)。
- 元素 id 走模块内本地 `AUTO_ELEMENTS`,不写进 `src/cards/elements.ts`(对标 `background.ts` 的 `BG_ELEMENTS`)。
- `agy-pick` 运行不入卡(秒级选任务);只有 5 个成员 kind 入卡:`codex-plan`/`agy-plan`/`codex-execute`/`agy-review`/`codex-merge`。
- 中文注释与既有模块风格一致。

---

## File Structure

- **新增** `src/cards/automation.ts` — 纯 reducer(`AutomationBurst` 累积)+ 纯渲染 + 类型 + `AUTO_ELEMENTS`。责任:自动化状态卡的所有决策逻辑与 JSON 结构。
- **新增** `src/cards/automation.test.ts` — 纯层单测。
- **新增** `src/tasklist-cards.ts` — I/O 生命周期:内存 `Map<projectName, ProjectCard>`、开卡/tick/沉降、chatId 解析+回填。责任:把纯层累积推到飞书。
- **新增** `src/tasklist-cards.test.ts` — I/O 层聚焦测试(仅 mock `./feishu`,不 mock `cardkit`)。
- **改** `src/cards.ts` — barrel re-export `./cards/automation`。
- **改** `src/tasklist.ts` — `TasklistBinding` 加 `chatId?`;`enableTasklist` 落 chatId;`loadTasklistMap` 解析 chatId。
- **改** `src/tasklist-worker.ts` — `runAgentProcess` 接三 hook;`runTasklistWorkerOnce` 末尾 `settleIdleProjects()`;`processTasklist` 开头 `backfillChatId`。
- **改** `src/session-tasklist.ts` — `showTasklistPanel` 在 `binding.chatId` 缺失时用当前群自愈写入 + 提示。
- **改** `src/cards/AGENTS.md` — 补 `automation.ts` 条目。

---

## Task 1: 纯 reducer 层 `automation.ts`

**Files:**
- Create: `src/cards/automation.ts`
- Test: `src/cards/automation.test.ts`

**Interfaces:**
- Consumes: 无(纯层,零内部依赖)。
- Produces(后续任务依赖这些精确签名):
  - `type AutomationRunKind = 'codex-plan' | 'agy-plan' | 'codex-execute' | 'agy-review' | 'codex-merge'`
  - `type AutomationRunStatus = 'running' | 'completed' | 'failed'`
  - `interface AutomationRunView { runId: string; kind: AutomationRunKind; taskGuid?: string; taskSummary: string; status: AutomationRunStatus; startedAt: number; endTime?: number; stdoutTail: string; error?: string }`
  - `interface AutomationBurst { runs: AutomationRunView[]; sawActivityThisScan: boolean; idleScans: number }`
  - `const AUTO_ELEMENTS = { panel: (runId: string) => string; body: (runId: string) => string }`
  - `isCardedKind(kind: string): kind is AutomationRunKind`
  - `emptyBurst(): AutomationBurst`
  - `burstAddRun(burst, runId: string, kind: AutomationRunKind, taskGuid: string | undefined, taskSummary: string, startedAt: number): AutomationBurst`
  - `burstUpdateStdout(burst, runId: string, tail: string): AutomationBurst`
  - `burstSettleRun(burst, runId: string, processStatus: 'exited' | 'failed', error: string | undefined, endTime: number): AutomationBurst`
  - `burstMarkScan(burst, idleThreshold?: number): { burst: AutomationBurst; shouldSettle: boolean }`
  - `hasRunningRun(burst): boolean`

- [ ] **Step 1: 写失败测试(reducers)**

Create `src/cards/automation.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'

import {
  isCardedKind,
  emptyBurst,
  burstAddRun,
  burstUpdateStdout,
  burstSettleRun,
  burstMarkScan,
  hasRunningRun,
  type AutomationBurst,
} from './automation'

describe('isCardedKind', () => {
  test('5 个成员 kind 入卡,agy-pick 不入卡', () => {
    for (const k of ['codex-plan', 'agy-plan', 'codex-execute', 'agy-review', 'codex-merge']) {
      expect(isCardedKind(k)).toBe(true)
    }
    expect(isCardedKind('agy-pick')).toBe(false)
    expect(isCardedKind('whatever')).toBe(false)
  })
})

describe('burstAddRun', () => {
  test('新 run 入 burst,status=running,标 sawActivity', () => {
    const b = burstAddRun(emptyBurst(), 'r1', 'codex-execute', 'g1', '修登录bug', 1000)
    expect(b.runs).toHaveLength(1)
    expect(b.runs[0]).toMatchObject({ runId: 'r1', kind: 'codex-execute', taskGuid: 'g1', taskSummary: '修登录bug', status: 'running', startedAt: 1000, stdoutTail: '' })
    expect(b.sawActivityThisScan).toBe(true)
  })

  test('空 taskSummary → (无任务标题)', () => {
    const b = burstAddRun(emptyBurst(), 'r1', 'agy-plan', undefined, '   ', 0)
    expect(b.runs[0].taskSummary).toBe('(无任务标题)')
  })

  test('重复 runId 幂等,不堆叠,仍标 sawActivity', () => {
    let b = burstAddRun(emptyBurst(), 'r1', 'agy-plan', 'g1', 'x', 0)
    b = { ...b, sawActivityThisScan: false }
    b = burstAddRun(b, 'r1', 'agy-plan', 'g1', 'x', 0)
    expect(b.runs).toHaveLength(1)
    expect(b.sawActivityThisScan).toBe(true)
  })
})

describe('burstUpdateStdout', () => {
  test('更新对应 run 的 tail;超预算保留尾部并加省略号', () => {
    let b = burstAddRun(emptyBurst(), 'r1', 'codex-execute', 'g1', 't', 0)
    b = burstUpdateStdout(b, 'r1', 'hello world')
    expect(b.runs[0].stdoutTail).toBe('hello world')
    const big = 'x'.repeat(2000)
    b = burstUpdateStdout(b, 'r1', big)
    expect(b.runs[0].stdoutTail.length).toBe(1501) // 1 省略号 + 1500
    expect(b.runs[0].stdoutTail.startsWith('…')).toBe(true)
  })

  test('无归属 run 返回原引用', () => {
    const b = burstAddRun(emptyBurst(), 'r1', 'agy-plan', 'g1', 't', 0)
    expect(burstUpdateStdout(b, 'nope', 'x')).toBe(b)
  })
})

describe('burstSettleRun', () => {
  test('exited → completed,记 endTime,标 sawActivity', () => {
    let b = burstAddRun(emptyBurst(), 'r1', 'codex-execute', 'g1', 't', 1000)
    b = { ...b, sawActivityThisScan: false }
    b = burstSettleRun(b, 'r1', 'exited', undefined, 5000)
    expect(b.runs[0]).toMatchObject({ status: 'completed', endTime: 5000 })
    expect(b.sawActivityThisScan).toBe(true)
  })

  test('failed → failed,带 error', () => {
    let b = burstAddRun(emptyBurst(), 'r1', 'agy-review', 'g1', 't', 0)
    b = burstSettleRun(b, 'r1', 'failed', 'timed out', 3000)
    expect(b.runs[0]).toMatchObject({ status: 'failed', error: 'timed out', endTime: 3000 })
  })

  test('无归属 run 返回原引用', () => {
    const b = burstAddRun(emptyBurst(), 'r1', 'agy-plan', 'g1', 't', 0)
    expect(burstSettleRun(b, 'nope', 'exited', undefined, 1)).toBe(b)
  })
})

describe('burstMarkScan', () => {
  test('有活动 → 复位、idleScans=0、不沉降', () => {
    const b0: AutomationBurst = { runs: [], sawActivityThisScan: true, idleScans: 3 }
    const { burst, shouldSettle } = burstMarkScan(b0)
    expect(burst.sawActivityThisScan).toBe(false)
    expect(burst.idleScans).toBe(0)
    expect(shouldSettle).toBe(false)
  })

  test('无活动 → idleScans+1,达阈值(默认1)即沉降', () => {
    const b0: AutomationBurst = { runs: [], sawActivityThisScan: false, idleScans: 0 }
    const { burst, shouldSettle } = burstMarkScan(b0)
    expect(burst.idleScans).toBe(1)
    expect(shouldSettle).toBe(true)
  })

  test('无活动但未达自定义阈值不沉降', () => {
    const b0: AutomationBurst = { runs: [], sawActivityThisScan: false, idleScans: 0 }
    expect(burstMarkScan(b0, 2).shouldSettle).toBe(false)
  })
})

describe('hasRunningRun', () => {
  test('有 running 为真,全终态为假', () => {
    let b = burstAddRun(emptyBurst(), 'r1', 'agy-plan', 'g1', 't', 0)
    expect(hasRunningRun(b)).toBe(true)
    b = burstSettleRun(b, 'r1', 'exited', undefined, 1)
    expect(hasRunningRun(b)).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/cards/automation.test.ts`
Expected: FAIL —「Cannot find module './automation'」。

- [ ] **Step 3: 实现 reducer 层**

Create `src/cards/automation.ts`:

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/cards/automation.test.ts`
Expected: PASS(全部 reducer 用例)。

- [ ] **Step 5: 提交**

```bash
git add src/cards/automation.ts src/cards/automation.test.ts
git commit -m "feat(automation): 状态卡纯 reducer 层(burst 累积 + isCardedKind)"
```

---

## Task 2: 纯渲染层 + barrel 导出

**Files:**
- Modify: `src/cards/automation.ts`(追加渲染函数)
- Modify: `src/cards/automation.test.ts`(追加渲染测试)
- Modify: `src/cards.ts`(re-export)

**Interfaces:**
- Consumes: Task 1 的 `AutomationRunView` / `AutomationBurst` / `AUTO_ELEMENTS`。
- Produces:
  - `memberLabel(kind: AutomationRunKind): string`
  - `statusLabel(run: AutomationRunView, now: number): string`
  - `summarizeAutomation(runs: AutomationRunView[]): string`
  - `automationRunPanel(run: AutomationRunView, now?: number): object`
  - `automationLiveCard(projectName: string, runs: AutomationRunView[], now?: number): object`
  - `automationHistoryCard(projectName: string, runs: AutomationRunView[], now?: number): object`

- [ ] **Step 1: 追加失败测试(渲染)**

Append to `src/cards/automation.test.ts`:

```ts
import {
  memberLabel,
  statusLabel,
  summarizeAutomation,
  automationRunPanel,
  automationLiveCard,
  automationHistoryCard,
  AUTO_ELEMENTS,
  type AutomationRunView,
} from './automation'

const run = (over: Partial<AutomationRunView> & Pick<AutomationRunView, 'runId' | 'kind' | 'status'>): AutomationRunView => ({
  taskSummary: '任务', startedAt: 0, stdoutTail: '', ...over,
})

describe('memberLabel / statusLabel', () => {
  test('kind → 中文成员名', () => {
    expect(memberLabel('codex-execute')).toBe('Codex执行')
    expect(memberLabel('agy-review')).toBe('agy审核')
    expect(memberLabel('codex-merge')).toBe('Codex合并')
  })

  test('running 显示已运行时长', () => {
    expect(statusLabel(run({ runId: 'r', kind: 'codex-execute', status: 'running', startedAt: 0 }), 193000))
      .toBe('🟡 运行中 3m13s')
  })

  test('completed 显示用时(endTime-startedAt)', () => {
    expect(statusLabel(run({ runId: 'r', kind: 'agy-plan', status: 'completed', startedAt: 1000, endTime: 49000 }), 999999))
      .toBe('✅ 用时 48s')
  })

  test('failed 显示失败时长', () => {
    expect(statusLabel(run({ runId: 'r', kind: 'agy-review', status: 'failed', startedAt: 0, endTime: 65000 }), 0))
      .toBe('❌ 失败 1m5s')
  })
})

describe('summarizeAutomation', () => {
  test('N 进行中 · M 已结束', () => {
    const runs = [
      run({ runId: 'a', kind: 'codex-execute', status: 'running' }),
      run({ runId: 'b', kind: 'agy-plan', status: 'completed' }),
      run({ runId: 'c', kind: 'codex-plan', status: 'failed' }),
    ]
    expect(summarizeAutomation(runs)).toBe('1 进行中 · 2 已结束')
  })

  test('全终态只显示已结束', () => {
    expect(summarizeAutomation([run({ runId: 'b', kind: 'agy-plan', status: 'completed' })])).toBe('1 已结束')
  })

  test('空', () => {
    expect(summarizeAutomation([])).toBe('空')
  })
})

describe('automationRunPanel', () => {
  test('panel 结构:element_id + 标题含成员/任务/状态,body 有 tail', () => {
    const p = automationRunPanel(run({ runId: 'r1', kind: 'codex-execute', status: 'running', taskSummary: '修登录bug', startedAt: 0, stdoutTail: 'building...' }), 12000) as any
    expect(p.tag).toBe('collapsible_panel')
    expect(p.element_id).toBe(AUTO_ELEMENTS.panel('r1'))
    expect(p.header.title.content).toBe('🛠️ Codex执行 · 修登录bug — 🟡 运行中 12s')
    expect(p.elements[0].element_id).toBe(AUTO_ELEMENTS.body('r1'))
    expect(p.elements[0].content).toBe('building...')
  })

  test('无输出 body 显 (暂无输出);有 error 首行 ⚠', () => {
    const p1 = automationRunPanel(run({ runId: 'r1', kind: 'agy-plan', status: 'running' })) as any
    expect(p1.elements[0].content).toBe('_(暂无输出)_')
    const p2 = automationRunPanel(run({ runId: 'r2', kind: 'agy-plan', status: 'failed', error: 'boom' })) as any
    expect(p2.elements[0].content).toBe('⚠ boom')
  })
})

describe('automationLiveCard / automationHistoryCard', () => {
  test('live:streaming 开,summary 带项目名,body 每 run 一个 panel', () => {
    const runs = [run({ runId: 'a', kind: 'codex-execute', status: 'running' })]
    const c = automationLiveCard('etmmo', runs, 0) as any
    expect(c.schema).toBe('2.0')
    expect(c.config.streaming_mode).toBe(true)
    expect(c.config.summary.content).toBe('🧭 etmmo 自动化 · 1 进行中')
    expect(c.body.elements).toHaveLength(1)
  })

  test('history:streaming 关,只渲染终态 run', () => {
    const runs = [
      run({ runId: 'a', kind: 'codex-execute', status: 'running' }),
      run({ runId: 'b', kind: 'agy-plan', status: 'completed' }),
    ]
    const c = automationHistoryCard('etmmo', runs, 0) as any
    expect(c.config.streaming_mode).toBe(false)
    expect(c.config.summary.content).toBe('🧭 etmmo 自动化(历史) · 1 已结束')
    expect(c.body.elements).toHaveLength(1) // running 的被过滤
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/cards/automation.test.ts`
Expected: FAIL —「memberLabel is not a function / not exported」。

- [ ] **Step 3: 追加渲染实现**

Append to `src/cards/automation.ts`:

```ts
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

/** ms → "45s" / "2m13s" / "1h5m"(复刻 background.ts fmtElapsed)。 */
function fmtElapsed(ms: number): string {
  if (!ms || ms < 0) return '0s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60}m`
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
  return lines.length ? lines.join('\n') : '_(暂无输出)_'
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/cards/automation.test.ts`
Expected: PASS(reducer + 渲染全部)。

- [ ] **Step 5: barrel re-export**

In `src/cards.ts`, after the `} from './cards/background'` block (currently the last export, ends at line ~116), append:

```ts
export {
  type AutomationRunKind,
  type AutomationRunStatus,
  type AutomationRunView,
  type AutomationBurst,
  AUTO_ELEMENTS,
  isCardedKind,
  emptyBurst,
  burstAddRun,
  burstUpdateStdout,
  burstSettleRun,
  burstMarkScan,
  hasRunningRun,
  memberLabel,
  statusLabel,
  summarizeAutomation,
  automationRunPanel,
  automationLiveCard,
  automationHistoryCard,
} from './cards/automation'
```

- [ ] **Step 6: 跑全量卡测试确认 barrel 无破坏**

Run: `bun test src/cards/automation.test.ts src/cards/turn.test.ts`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/cards/automation.ts src/cards/automation.test.ts src/cards.ts
git commit -m "feat(automation): 状态卡渲染层 + barrel 导出"
```

---

## Task 3: `TasklistBinding.chatId` 字段

**Files:**
- Modify: `src/tasklist.ts:90-101`(接口)、`:138-149`(enableTasklist)、`:273-284`(loadTasklistMap 解析)

**Interfaces:**
- Consumes: 无。
- Produces:`TasklistBinding.chatId?: string`(Task 4/5 读它)。`cloneBinding` 用 `JSON.parse(JSON.stringify())`,自动带上该字段,无需改。

- [ ] **Step 1: 接口加字段**

In `src/tasklist.ts`, in `interface TasklistBinding` (line 90), add `chatId?: string` after `ownerOpenId`:

```ts
export interface TasklistBinding {
  guid: string
  name: string
  url: string
  projectName: string
  ownerOpenId: string
  /** 项目主群 chatId —— 自动化状态卡发送目标。enableTasklist 落库,
   *  旧 binding 由 tasklist-cards.backfillChatId 首轮回填。 */
  chatId?: string
  createdAt?: string
  sections?: TasklistSectionMap
  tasks?: Record<string, TaskAutomationState>
  processes?: Record<string, AutomationProcessRecord>
  worker?: TasklistWorkerState
}
```

- [ ] **Step 2: enableTasklist 落 chatId**

In `enableTasklist` (line 138), add `chatId` to the binding literal:

```ts
  const binding: TasklistBinding = {
    guid: tasklist.guid,
    name: tasklist.name,
    url: tasklist.url,
    projectName,
    ownerOpenId,
    chatId,
    createdAt: tasklist.createdAt,
    sections: {},
    tasks: {},
    processes: {},
    worker: {},
  }
```

(`chatId` 是 `enableTasklist(projectName, chatId)` 的第二个入参,本就在手。)

- [ ] **Step 3: loadTasklistMap 解析 chatId**

In `loadTasklistMap` (line 273), add `chatId` to the reconstructed binding:

```ts
      const binding: TasklistBinding = {
        guid: item.guid,
        name: item.name,
        url: typeof item.url === 'string' ? item.url : '',
        projectName,
        ownerOpenId: typeof item.ownerOpenId === 'string' ? item.ownerOpenId : '',
        chatId: typeof item.chatId === 'string' && item.chatId ? item.chatId : undefined,
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : undefined,
        sections: readSectionMap(item.sections),
        tasks: readTasks(item.tasks),
        processes: readProcesses(item.processes),
        worker: readWorker(item.worker),
      }
```

- [ ] **Step 4: 校验编译无破坏**

Run: `bun test src/tasklist-worker.test.ts`
Expected: PASS(既有清单 worker 测试不受影响)。

- [ ] **Step 5: 提交**

```bash
git add src/tasklist.ts
git commit -m "feat(tasklist): TasklistBinding 加 chatId 字段(enableTasklist 落库 + load 解析)"
```

---

## Task 4: I/O 生命周期层 `tasklist-cards.ts`

**Files:**
- Create: `src/tasklist-cards.ts`
- Test: `src/tasklist-cards.test.ts`

**Interfaces:**
- Consumes:Task 1/2 的 `cards.burst*` / `cards.automation*Card` / `cards.isCardedKind` / `cards.AUTO_ELEMENTS`;`tasklist.getTasklistBinding` / `tasklist.updateTasklistBinding`;`AutomationProcessRecord`(`./tasklist`);`feishu.sendCard` / `feishu.updateCard` / `feishu.chatIdForSession`;`cardkit.convertMessageToCard` / `addElement` / `replaceElement` / `patchSummaryThrottled` / `recordCardCreated`。
- Produces(Task 5 依赖):
  - `onRunStart(record: AutomationProcessRecord): void`
  - `onRunStdout(runId: string, projectName: string, tail: string): void`
  - `onRunSettle(record: AutomationProcessRecord): void`
  - `settleIdleProjects(): void`
  - `backfillChatId(projectName: string): void`
  - 纯 helper(DI,单测用,无副作用):`resolveChatId(binding: { chatId?: string; projectName: string }, lookup: (name: string) => string | null): string | null`、`computeBackfill(binding: { chatId?: string; projectName: string } | null, lookup: (name: string) => string | null): string | null`
  - 测试清理:`__resetCardsForTest(): void`

**测试策略(避 `mock.module` 进程级冲突)**:`bun` 的 `mock.module` 是进程级注册(见 `src/feishu-test-mock.ts` 头注释),per-file 各自 `mock('./feishu')` 或 `mock('./tasklist')` 会互相顶掉,`bun test` 全量单进程跑时炸别的测试。故本层:① 决策逻辑抽成 DI 纯 helper(`resolveChatId`/`computeBackfill`,lookup 注入),直接单测;② 复用**共享** `feishu-test-mock.ts`(扩两个键),不 mock `./tasklist`(用真模块,未知项目 `getTasklistBinding` 返 null,走无卡安全分支);③ happy-path 开卡 + 回填持久化的真实 cardkit/落盘交互留给 Task 7 真机 smoke。

- [ ] **Step 1: 扩展共享 feishu 替身(加 `chatIdForSession` + `updateCard`)**

In `src/feishu-test-mock.ts`, add a settable holder and two mock keys. After the `export const projectProfiles = ...` line (line 22), add:

```ts
/** chatIdForSession 替身返回值,测试可改。 */
export const feishuMockState = { chatIdForSession: null as string | null }
```

In `resetFeishuMock()`, reset it — change the function body to:

```ts
export function resetFeishuMock(): void {
  for (const arr of [sentCards, sentTexts, sentRawTexts, deletedReactions, boundResumes, urgentPushes]) {
    arr.length = 0
  }
  projectProfiles.clear()
  feishuMockState.chatIdForSession = null
}
```

In the `mock.module('./feishu', () => ({ ... }))` object, add two keys (before the closing `}))`):

```ts
  updateCard: async () => {},
  chatIdForSession: (_sessionName: string) => feishuMockState.chatIdForSession,
```

(纯增键,现有测试不用它们,无行为变化。)

- [ ] **Step 2: 写失败测试(DI 纯 helper + 无卡安全,复用共享 mock,零 per-file mock.module)**

Create `src/tasklist-cards.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

// 复用共享 feishu 替身(进程级注册一次,不与其它测试冲突)。
import './feishu-test-mock'
import { sentCards, resetFeishuMock } from './feishu-test-mock'
import {
  resolveChatId,
  computeBackfill,
  onRunStart,
  onRunSettle,
  settleIdleProjects,
  __resetCardsForTest,
} from './tasklist-cards'
import type { AutomationProcessRecord } from './tasklist'

const rec = (over: Partial<AutomationProcessRecord> & Pick<AutomationProcessRecord, 'runId' | 'kind'>): AutomationProcessRecord => ({
  projectName: 'no-such-project', tasklistGuid: 'tl', command: ['x'], cwd: '/x', status: 'running', startedAt: 'now', ...over,
})

beforeEach(() => { resetFeishuMock() })
afterEach(() => { __resetCardsForTest() })

describe('resolveChatId(§6:binding.chatId 优先,回退 lookup)', () => {
  test('binding.chatId 命中 → 直接返回,不调 lookup', () => {
    let called = false
    const got = resolveChatId({ chatId: 'oc_bound', projectName: 'p' }, () => { called = true; return 'oc_x' })
    expect(got).toBe('oc_bound')
    expect(called).toBe(false)
  })
  test('无 chatId → 回退 lookup 命中', () => {
    expect(resolveChatId({ projectName: 'p' }, () => 'oc_resolved')).toBe('oc_resolved')
  })
  test('无 chatId 且 lookup 也 null → null', () => {
    expect(resolveChatId({ projectName: 'p' }, () => null)).toBeNull()
  })
})

describe('computeBackfill(§6:仅在缺 chatId 时回填)', () => {
  test('缺 chatId 且 lookup 命中 → 返回待落库 chatId', () => {
    expect(computeBackfill({ projectName: 'p' }, () => 'oc_resolved')).toBe('oc_resolved')
  })
  test('已有 chatId → null(不回填)', () => {
    expect(computeBackfill({ chatId: 'oc_have', projectName: 'p' }, () => 'oc_other')).toBeNull()
  })
  test('binding 为 null → null', () => {
    expect(computeBackfill(null, () => 'oc_x')).toBeNull()
  })
  test('缺 chatId 但 lookup null → null', () => {
    expect(computeBackfill({ projectName: 'p' }, () => null)).toBeNull()
  })
})

describe('无卡安全(未开卡时 hook 不抛、不发卡)', () => {
  test('agy-pick 不入卡:不建壳、不发卡', () => {
    onRunStart(rec({ runId: 'p1', kind: 'agy-pick' as unknown as AutomationProcessRecord['kind'] }))
    expect(sentCards).toHaveLength(0)
  })

  test('未知项目(无 binding)的 codex-execute:openCard 在 !binding 处 return,不发卡', async () => {
    onRunStart(rec({ runId: 'r1', kind: 'codex-execute' }))
    await Promise.resolve() // 让异步 openCard 跑完
    expect(sentCards).toHaveLength(0)
  })

  test('从未开卡的 project settle / 空 settleIdleProjects 不抛', () => {
    expect(() => onRunSettle(rec({ runId: 'x', kind: 'codex-merge', status: 'exited' }))).not.toThrow()
    expect(() => settleIdleProjects()).not.toThrow()
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `bun test src/tasklist-cards.test.ts`
Expected: FAIL —「Cannot find module './tasklist-cards'」。

- [ ] **Step 4: 实现 I/O 层**

Create `src/tasklist-cards.ts`:

```ts
/**
 * 任务清单自动化状态卡的 I/O 生命周期(按活跃波次 · per-project)。
 *
 * 纯累积/渲染在 cards/automation.ts;这里持内存卡句柄、开卡/30s tick 刷新/
 * 沉降,调 feishu + cardkit 写飞书。核心不变式:内存 burst 是唯一真源,所有
 * 卡写都是尽力 reconcile;先改视图、再写卡;开卡未就绪时写卡跳过,靠开卡后
 * 全量重建兜底。所有卡写失败绝不阻塞 tasklist-worker。
 */

import * as cardkit from './cardkit'
import * as cards from './cards'
import * as feishu from './feishu'
import { log } from './log'
import * as tasklist from './tasklist'
import type { AutomationProcessRecord } from './tasklist'

const REFRESH_TICK_MS = 30_000

interface CardHandle {
  chatId: string
  messageId: string
  cardId: string
  /** 已 addElement 过 panel 的 runId(区分 add vs replace)。 */
  addedPanels: Set<string>
  refreshTimer: ReturnType<typeof setInterval> | null
  /** cardkit 写失败(recordCardCreated 回调置)后停止一切刷卡。 */
  cardWriteFailed: boolean
}

interface ProjectCard {
  projectName: string
  burst: cards.AutomationBurst
  handle: CardHandle | null
}

const cardsByProject = new Map<string, ProjectCard>()
const opening = new Set<string>()

function getOrInit(projectName: string): ProjectCard {
  let pc = cardsByProject.get(projectName)
  if (!pc) { pc = { projectName, burst: cards.emptyBurst(), handle: null }; cardsByProject.set(projectName, pc) }
  return pc
}

/** 测试清理:清空内存卡壳 + 停所有 tick timer(仅供 *.test.ts)。 */
export function __resetCardsForTest(): void {
  for (const pc of cardsByProject.values()) if (pc.handle?.refreshTimer) clearInterval(pc.handle.refreshTimer)
  cardsByProject.clear()
  opening.clear()
}

/** §6 chatId 解析(DI 纯):优先 binding.chatId,回退 lookup。lookup 注入以便单测。 */
export function resolveChatId(
  binding: { chatId?: string; projectName: string },
  lookup: (name: string) => string | null,
): string | null {
  return binding.chatId ?? lookup(binding.projectName)
}

/** §6 步骤2 决策(DI 纯):缺 chatId 时返回待落库 chatId,否则 null。 */
export function computeBackfill(
  binding: { chatId?: string; projectName: string } | null,
  lookup: (name: string) => string | null,
): string | null {
  if (!binding || binding.chatId) return null
  return lookup(binding.projectName)
}

/** §6 步骤2:旧 binding 缺 chatId 时 worker 每轮开头调一次,解析成功即持久化。 */
export function backfillChatId(projectName: string): void {
  const chatId = computeBackfill(tasklist.getTasklistBinding(projectName), feishu.chatIdForSession)
  if (!chatId) return
  try {
    tasklist.updateTasklistBinding(projectName, b => { b.chatId = chatId })
    log(`tasklist-cards: backfilled chatId for "${projectName}" → ${chatId}`)
  } catch (e) {
    log(`tasklist-cards: backfill chatId failed for "${projectName}": ${e}`)
  }
}

function taskSummaryFor(projectName: string, taskGuid: string | undefined): string {
  if (!taskGuid) return ''
  return tasklist.getTasklistBinding(projectName)?.tasks?.[taskGuid]?.summary ?? ''
}

// ── worker hook(先改视图,再尽力写卡) ─────────────────────────────────

export function onRunStart(record: AutomationProcessRecord): void {
  if (!cards.isCardedKind(record.kind)) return
  const pc = getOrInit(record.projectName)
  pc.burst = cards.burstAddRun(
    pc.burst, record.runId, record.kind, record.taskGuid,
    taskSummaryFor(record.projectName, record.taskGuid), Date.now(),
  )
  if (pc.handle) { renderRun(pc, record.runId); patchSummary(pc) }
  else if (!opening.has(record.projectName)) void openCard(record.projectName)
  // opening 中:仅落视图,openCard 完成后 reconcileAll 兜底。
}

export function onRunStdout(runId: string, projectName: string, tail: string): void {
  const pc = cardsByProject.get(projectName)
  if (!pc) return
  pc.burst = cards.burstUpdateStdout(pc.burst, runId, tail)
  // 不主动写卡;30s tick 统一重渲染 running panel。
}

export function onRunSettle(record: AutomationProcessRecord): void {
  if (!cards.isCardedKind(record.kind)) return
  const pc = cardsByProject.get(record.projectName)
  if (!pc) return
  const processStatus: 'exited' | 'failed' = record.status === 'exited' ? 'exited' : 'failed'
  pc.burst = cards.burstSettleRun(pc.burst, record.runId, processStatus, record.error, Date.now())
  if (pc.handle) { renderRun(pc, record.runId); patchSummary(pc) }
}

/** worker 每轮扫描末尾调一次:空闲计数 + 达阈值沉降。 */
export function settleIdleProjects(): void {
  for (const pc of [...cardsByProject.values()]) {
    const { burst, shouldSettle } = cards.burstMarkScan(pc.burst)
    pc.burst = burst
    if (!shouldSettle) continue
    if (pc.handle) void settleCard(pc.projectName)
    else cardsByProject.delete(pc.projectName) // 无卡空壳直接清
  }
}

// ── 内部 I/O ──────────────────────────────────────────────────────────

async function openCard(projectName: string): Promise<void> {
  opening.add(projectName)
  try {
    const pc = cardsByProject.get(projectName)
    if (!pc || pc.handle) return
    const binding = tasklist.getTasklistBinding(projectName)
    if (!binding) return
    const chatId = resolveChatId(binding, feishu.chatIdForSession)
    if (!chatId) { log(`tasklist-cards: no chatId for "${projectName}", skip card this burst`); return }
    const messageId = await feishu.sendCard(chatId, cards.automationLiveCard(projectName, pc.burst.runs))
    if (!messageId) { log(`tasklist-cards: sendCard failed for "${projectName}"`); return }
    let cardId: string
    try { cardId = await cardkit.convertMessageToCard(messageId) }
    catch (e) { log(`tasklist-cards: convertMessageToCard failed "${projectName}": ${e}`); return }
    const handle: CardHandle = {
      chatId, messageId, cardId,
      addedPanels: new Set(pc.burst.runs.map(r => r.runId)),
      refreshTimer: null, cardWriteFailed: false,
    }
    cardkit.recordCardCreated(cardId, pc.burst.runs.length, () => { handle.cardWriteFailed = true })
    pc.handle = handle
    // 开卡后全量重建:吸收异步开卡窗口内 settle/stdout 对视图的改动。
    reconcileAll(pc)
    handle.refreshTimer = setInterval(() => tick(projectName), REFRESH_TICK_MS)
  } catch (e) {
    log(`tasklist-cards: openCard error "${projectName}": ${e}`)
  } finally {
    opening.delete(projectName)
  }
}

/** 30s tick:只重渲染仍 running 的 panel(刷时长/tail)+ 刷 summary。 */
function tick(projectName: string): void {
  const pc = cardsByProject.get(projectName)
  if (!pc || !pc.handle || pc.handle.cardWriteFailed) return
  const now = Date.now()
  for (const run of pc.burst.runs) if (run.status === 'running') renderRun(pc, run.runId, now)
  patchSummary(pc)
}

/** 单 run 渲染:未加过 panel → addElement;加过 → replaceElement。cardkit 内部
 *  队列化 + 失败经 recordCardCreated 回调置 cardWriteFailed,故此处 void 即可。 */
function renderRun(pc: ProjectCard, runId: string, now: number = Date.now()): void {
  const handle = pc.handle
  if (!handle || handle.cardWriteFailed) return
  const run = pc.burst.runs.find(r => r.runId === runId)
  if (!run) return
  const panel = cards.automationRunPanel(run, now)
  if (handle.addedPanels.has(runId)) {
    void cardkit.replaceElement(handle.cardId, cards.AUTO_ELEMENTS.panel(runId), panel)
  } else {
    handle.addedPanels.add(runId)
    void cardkit.addElement(handle.cardId, panel)
  }
}

function reconcileAll(pc: ProjectCard): void {
  const now = Date.now()
  for (const run of pc.burst.runs) renderRun(pc, run.runId, now)
  patchSummary(pc)
}

function patchSummary(pc: ProjectCard): void {
  if (!pc.handle || pc.handle.cardWriteFailed) return
  cardkit.patchSummaryThrottled(pc.handle.cardId, `🧭 ${pc.projectName} 自动化 · ${cards.summarizeAutomation(pc.burst.runs)}`)
}

async function settleCard(projectName: string): Promise<void> {
  const pc = cardsByProject.get(projectName)
  cardsByProject.delete(projectName)
  if (!pc || !pc.handle) return
  if (pc.handle.refreshTimer) clearInterval(pc.handle.refreshTimer)
  try {
    await feishu.updateCard(pc.handle.messageId, cards.automationHistoryCard(projectName, pc.burst.runs))
  } catch (e) {
    log(`tasklist-cards: settleCard updateCard failed "${projectName}": ${e}`)
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test src/tasklist-cards.test.ts`
Expected: PASS(纯 helper + 无卡安全用例全绿)。

- [ ] **Step 6: 跑全量确认扩展的共享 mock 未破坏其它测试**

Run: `bun test`
Expected: PASS(feishu-test-mock 只增键,session/其它测试不受影响)。

- [ ] **Step 7: 提交**

```bash
git add src/tasklist-cards.ts src/tasklist-cards.test.ts src/feishu-test-mock.ts
git commit -m "feat(tasklist-cards): 状态卡 I/O 生命周期(开卡/tick/沉降 + chatId 回填 DI 纯 helper)"
```

---

## Task 5: `tasklist-worker.ts` 接线

**Files:**
- Modify: `src/tasklist-worker.ts:1-10`(import)、`:74-97`(processTasklist backfill)、`:57-72`(settleIdleProjects)、`:651-716`(runAgentProcess 三 hook)

**Interfaces:**
- Consumes:Task 4 的 `tasklistCards.onRunStart` / `onRunStdout` / `onRunSettle` / `settleIdleProjects` / `backfillChatId`。
- Produces:无(终端接线)。

- [ ] **Step 1: import**

In `src/tasklist-worker.ts`, add after the existing imports (after line 23's `tasklist-worker-git` import block):

```ts
import * as tasklistCards from './tasklist-cards'
```

- [ ] **Step 2: processTasklist 首轮回填 chatId**

In `processTasklist` (line 74), after `let binding = await tasklist.ensureTasklistSections(projectName)` (line 78), add:

```ts
    let binding = await tasklist.ensureTasklistSections(projectName)
    tasklistCards.backfillChatId(projectName)
    await markStaleRunningProcesses(projectName, binding)
```

- [ ] **Step 3: 扫描末尾沉降空闲卡**

In `runTasklistWorkerOnce` (line 57), add `settleIdleProjects()` after the `for` loop, inside the `try`:

```ts
  running = true
  try {
    for (const binding of tasklist.listTasklistBindings()) {
      await processTasklist(binding.projectName)
    }
    tasklistCards.settleIdleProjects()
  } catch (e) {
    log(`tasklist-worker: scan failed: ${messageOf(e)}`)
  } finally {
    running = false
  }
```

- [ ] **Step 4: runAgentProcess 接三 hook**

In `runAgentProcess` (line 651): (a) after `storeProcessRecord(opts.projectName, record)` (line 682), add `onRunStart`; (b) in the stdout `on('data')` handler (line 692), add `onRunStdout`; (c) after `storeProcessRecord(opts.projectName, finalRecord)` (line 711), add `onRunSettle`.

```ts
  record = { ...record, pid: proc.pid || undefined }
  storeProcessRecord(opts.projectName, record)
  tasklistCards.onRunStart(record)
  if (opts.taskGuid && opts.refKey) {
    markRunOnTask(opts.projectName, opts.taskGuid, opts.refKey, runId, opts.fingerprint, 'running')
  }
```

```ts
  proc.stdout.on('data', chunk => {
    stdout = tail(stdout + stdoutDecoder.write(chunk), PROCESS_OUTPUT_TAIL_LIMIT)
    tasklistCards.onRunStdout(runId, opts.projectName, stdout)
  })
```

```ts
  storeProcessRecord(opts.projectName, finalRecord)
  tasklistCards.onRunSettle(finalRecord)
  if (opts.taskGuid && opts.refKey) {
    markRunOnTask(opts.projectName, opts.taskGuid, opts.refKey, runId, opts.fingerprint, status, finalRecord.error)
  }
  return finalRecord
```

- [ ] **Step 5: 校验既有 worker 测试无破坏**

Run: `bun test src/tasklist-worker.test.ts src/tasklist-cards.test.ts src/cards/automation.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/tasklist-worker.ts
git commit -m "feat(tasklist-worker): runAgentProcess 接状态卡 hook + 首轮回填 chatId + 空闲沉降"
```

---

## Task 6: `task` 面板 chatId 自愈

**Files:**
- Modify: `src/session-tasklist.ts:23-26`(showTasklistPanel)

**Interfaces:**
- Consumes:`tasklist.getTasklistBinding` / `tasklist.updateTasklistBinding`(既有)。
- Produces:无。

- [ ] **Step 1: showTasklistPanel 缺 chatId 时用当前群自愈写入 + 提示**

Replace `showTasklistPanel` (line 23-26) in `src/session-tasklist.ts`:

```ts
export async function showTasklistPanel(s: Session): Promise<void> {
  const projectName = s.worktreeProjectName()
  const binding = tasklist.getTasklistBinding(projectName)
  // §6 步骤3:旧 binding 缺 chatId → 用当前群自愈写入,让自动化状态卡能定位群。
  if (binding && !binding.chatId) {
    try {
      tasklist.updateTasklistBinding(projectName, b => { b.chatId = s.chatId })
      log(`session "${s.sessionName}": backfilled tasklist chatId → ${s.chatId}`)
      await feishu.sendTextRaw(s.chatId, '✅ 已将自动化状态卡绑定到本群')
    } catch (e) {
      log(`session "${s.sessionName}": tasklist chatId self-heal failed: ${messageOf(e)}`)
    }
  }
  const messageId = await feishu.sendCard(s.chatId, tasklistPanel(s))
  if (!messageId) await feishu.sendTextRaw(s.chatId, '❌ task 面板发送失败')
}
```

- [ ] **Step 2: 校验既有面板测试无破坏**

Run: `bun test src/cards/task.test.ts`
Expected: PASS(`task.ts` 渲染未变,`showTasklistPanel` 逻辑加了自愈分支)。

- [ ] **Step 3: 提交**

```bash
git add src/session-tasklist.ts
git commit -m "feat(session-tasklist): task 面板缺 chatId 时用当前群自愈写入"
```

---

## Task 7: 全量校验 + 构建 + 文档 + 真机 smoke

**Files:**
- Modify: `src/cards/AGENTS.md`(补 `automation.ts` 条目)

- [ ] **Step 1: 全量 bun test**

Run: `bun test`
Expected: PASS(无回归)。

- [ ] **Step 2: 构建**

Run: `bun run build`
Expected: 五个 `dist/*.js` 产物生成,无类型/打包错误。

- [ ] **Step 3: 补 AGENTS.md**

In `src/cards/AGENTS.md`, in the Key Files table (after the `background`/`agy.ts` rows), add:

```markdown
| `automation.ts` | 任务清单自动化「工作室成员」运行的累积视图(`AutomationBurst`)+ 状态卡渲染(每运行一个折叠 panel),纯层;I/O 生命周期在 `src/tasklist-cards.ts`。 |
```

- [ ] **Step 4: 提交文档**

```bash
git add src/cards/AGENTS.md
git commit -m "docs(cards): AGENTS 补 automation.ts 条目"
```

- [ ] **Step 5: 真机 smoke(需部署 daemon;人工)**

在 etmmo 飞书群:
1. 发 `task` 一次 → 确认回「✅ 已将自动化状态卡绑定到本群」(旧 binding 自愈;新环境跳过)。
2. 往 `[AI]待执行` 放一个任务,等 worker 扫描(≤30s + 15s boot)。
3. 确认项目群出现「🧭 etmmo 自动化」活卡:成员 panel 标题状态+时长实时走,展开有 stdout tail(print 缓冲时显「(暂无输出)」)。
4. 成员跑完 → panel 变 ✅/❌ 墓碑并定格时长。
5. 流水线进入静息(等人工审核/全完成)→ 下一轮扫描后活卡沉降为「🧭 etmmo 自动化(历史)」,streaming 关、留原地。
6. 查 daemon 日志确认无 `tasklist-cards: ... failed` 异常刷屏;若见 `no chatId`,回 Task 6 自愈路径排查。

若 tick 期间飞书 streaming TTL 报错致 `cardWriteFailed`,标题会定格最后一次「运行中 Nm」——记录到 spec §8「可选缓解」,本期不阻断。

---

## Self-Review(计划自查)

- **Spec 覆盖**:§5.1 渲染→Task 1/2;§5.2 生命周期→Task 4;§6 chatId 三层(enable 落库/worker 回填/task 自愈)→Task 3/5/6;§7 开卡后重建+先改视图→Task 4 `openCard`/`renderRun`;§7.4 空闲沉降→Task 1 `burstMarkScan`+Task 4 `settleIdleProjects`+Task 5 扫描末尾;§7.5 agy-pick 不入卡→Task 1 `isCardedKind`;§8 卡失败不阻塞→Task 4 `cardWriteFailed`+全 try/catch;§9 字段→Task 3;§11 测试→各任务 TDD + Task 7 smoke;§12 逐文件→Task 1-7 全覆盖。无遗漏。
- **类型一致**:`burstSettleRun(..., processStatus: 'exited'|'failed', ...)` 在 Task 4 由 `record.status === 'exited' ? 'exited' : 'failed'` 供给一致;`automationRunPanel`/`automationLiveCard`/`automationHistoryCard` 参数顺序 Task 2 定义与 Task 4 调用一致;`AUTO_ELEMENTS.panel(runId)` Task 1 定义、Task 4 `replaceElement` 使用一致。
- **占位扫描**:无 TBD/TODO;每个 code step 含完整代码;测试含真实断言。
- **风险留痕**:`worktreeProjectName()` 与会话名 map 键一致性(spec 假设#1)在 Task 7 smoke 校验;真机 cardkit 交互(convertMessageToCard/replaceElement happy path)由 smoke 覆盖,单测只保证 chatId 门槛与无卡安全。
