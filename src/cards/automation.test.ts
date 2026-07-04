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
