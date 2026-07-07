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

  test('stdout 含外链图片 → body 降级,不残留会被 CardKit 解析成 image 的 ![]()', () => {
    const p = automationRunPanel(run({
      runId: 'r1', kind: 'codex-execute', status: 'running',
      stdoutTail: '产物 ![架构图](https://x/y.png) 已生成',
    })) as any
    expect(p.elements[0].content).not.toMatch(/!\[/)
    expect(p.elements[0].content).toContain('https://x/y.png')
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
