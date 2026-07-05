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
