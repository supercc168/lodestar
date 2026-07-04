import { describe, expect, test } from 'bun:test'

import {
  applyBgTaskStarted,
  applyBgTaskProgress,
  applyBgTaskUpdated,
  applyBgTaskSettled,
  applyBgToolUse,
  applyBgToolResult,
  isBgTerminal,
  hasActiveBgTask,
  summarizeBackground,
  backgroundTaskPanel,
  backgroundLiveCard,
  backgroundHistoryCard,
  backgroundMigratedMarker,
  BG_ELEMENTS,
  type BgTaskEntry,
} from './background'

const mk = (over: Partial<BgTaskEntry> & Pick<BgTaskEntry, 'id' | 'status'>): BgTaskEntry => ({
  type: 'subagent',
  description: 'd',
  startedAt: 0,
  steps: [],
  ...over,
})

describe('applyBgTaskStarted — 新增 + 归一化 + startedAt', () => {
  test('新增 running,type 归一化 local_workflow→workflow,记 startedAt', () => {
    let tasks: BgTaskEntry[] = []
    tasks = applyBgTaskStarted(tasks, { task_id: 't1', task_type: 'local_workflow', description: '跑 spec', workflow_name: 'spec' }, 1000)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ id: 't1', type: 'workflow', status: 'running', startedAt: 1000, workflowName: 'spec' })
  })

  test('有 subagent_type 无 task_type → type=subagent', () => {
    let tasks: BgTaskEntry[] = []
    tasks = applyBgTaskStarted(tasks, { task_id: 't2', description: '搜索', subagent_type: 'Explore' })
    expect(tasks[0].type).toBe('subagent')
    expect(tasks[0].subagentType).toBe('Explore')
  })

  test('local_ 前缀归一化:local_bash→shell / local_agent→subagent / local_workflow→workflow', () => {
    expect(applyBgTaskStarted([], { task_id: 'b', task_type: 'local_bash', description: 'build' })[0].type).toBe('shell')
    expect(applyBgTaskStarted([], { task_id: 'a', task_type: 'local_agent', description: 'explore' })[0].type).toBe('subagent')
    expect(applyBgTaskStarted([], { task_id: 'w', task_type: 'local_workflow', description: 'spec' })[0].type).toBe('workflow')
  })

  test('重复 task_id 不堆叠,补全字段但保留 status/usage/startedAt', () => {
    let tasks: BgTaskEntry[] = [mk({ id: 't1', type: 'unknown', description: '旧', status: 'running', startedAt: 1000, usage: { total_tokens: 100, tool_uses: 2, duration_ms: 1000 } })]
    tasks = applyBgTaskStarted(tasks, { task_id: 't1', task_type: 'shell', description: '新描述' }, 9999)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].description).toBe('新描述')
    expect(tasks[0].type).toBe('shell')
    expect(tasks[0].status).toBe('running')
    expect(tasks[0].startedAt).toBe(1000)  // 不被覆盖
    expect(tasks[0].usage?.total_tokens).toBe(100)
  })
})

describe('applyBgTaskProgress — 刷新 + 状态提升', () => {
  test('刷 usage/last_tool/summary', () => {
    let tasks: BgTaskEntry[] = [mk({ id: 't1', status: 'running', subagentType: 'Explore' })]
    tasks = applyBgTaskProgress(tasks, { task_id: 't1', usage: { total_tokens: 500, tool_uses: 3, duration_ms: 2000 }, last_tool_name: 'Grep', summary: '命中 3 处' })
    expect(tasks[0].usage?.total_tokens).toBe(500)
    expect(tasks[0].lastToolName).toBe('Grep')
    expect(tasks[0].summary).toBe('命中 3 处')
  })

  test('pending → running', () => {
    let tasks: BgTaskEntry[] = [mk({ id: 't1', status: 'pending' })]
    tasks = applyBgTaskProgress(tasks, { task_id: 't1' })
    expect(tasks[0].status).toBe('running')
  })

  test('未知 task_id no-op', () => {
    const tasks: BgTaskEntry[] = [mk({ id: 't1', status: 'running' })]
    expect(applyBgTaskProgress(tasks, { task_id: 'tX' })).toBe(tasks)
  })
})

describe('applyBgTaskUpdated — 状态变更', () => {
  test('改 status + is_backgrounded + error', () => {
    let tasks: BgTaskEntry[] = [mk({ id: 't1', type: 'shell', description: 'build', status: 'running' })]
    tasks = applyBgTaskUpdated(tasks, { task_id: 't1', patch: { status: 'paused', is_backgrounded: true, error: 'oom' } })
    expect(tasks[0].status).toBe('paused')
    expect(tasks[0].isBackgrounded).toBe(true)
    expect(tasks[0].error).toBe('oom')
  })

  test('未知 task_id no-op', () => {
    const tasks: BgTaskEntry[] = [mk({ id: 't1', status: 'running' })]
    expect(applyBgTaskUpdated(tasks, { task_id: 'tX', patch: { status: 'completed' } })).toBe(tasks)
  })
})

describe('applyBgTaskSettled — 终态映射 + endTime', () => {
  test('completed/failed/stopped → completed/failed/killed,记 endTime', () => {
    let tasks: BgTaskEntry[] = [
      mk({ id: 't1', status: 'running', startedAt: 1000 }),
      mk({ id: 't2', status: 'running', startedAt: 1000 }),
      mk({ id: 't3', status: 'running', startedAt: 1000 }),
    ]
    tasks = applyBgTaskSettled(tasks, { task_id: 't1', status: 'completed', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 7000 } }, 8000)
    tasks = applyBgTaskSettled(tasks, { task_id: 't2', status: 'failed' }, 8000)
    tasks = applyBgTaskSettled(tasks, { task_id: 't3', status: 'stopped' }, 8000)
    expect(tasks.map(t => t.status)).toEqual(['completed', 'failed', 'killed'])
    expect(tasks[0].endTime).toBe(8000)
    expect(tasks[0].usage?.duration_ms).toBe(7000)
  })

  test('错过 started → 补建终态记录', () => {
    const next = applyBgTaskSettled([], { task_id: 'tZ', status: 'completed', summary: 'done' }, 8000)
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ id: 'tZ', status: 'completed', type: 'unknown', summary: 'done', endTime: 8000 })
  })
})

describe('applyBgToolUse / applyBgToolResult — 子 agent 逐步过程', () => {
  test('parentToolUseId 匹配的 task 追加 step;主线程(null)/不匹配跳过', () => {
    let tasks: BgTaskEntry[] = [mk({ id: 't1', toolUseId: 'parent_1', status: 'running' })]
    tasks = applyBgToolUse(tasks, 'parent_1', 'tu_1', 'Grep', { pattern: 'auth', path: 'src' })
    expect(tasks[0].steps).toHaveLength(1)
    expect(tasks[0].steps[0]).toMatchObject({ toolUseId: 'tu_1', tool: 'Grep' })
    expect(tasks[0].steps[0].brief).toContain('auth')
    // 主线程工具(null)跳过
    tasks = applyBgToolUse(tasks, null, 'tu_2', 'Bash', { command: 'ls' })
    expect(tasks[0].steps).toHaveLength(1)
    // 不匹配的 parent 跳过
    tasks = applyBgToolUse(tasks, 'other_parent', 'tu_3', 'Read', { file_path: '/x' })
    expect(tasks[0].steps).toHaveLength(1)
  })

  test('tool_result 按 tool_use_id 回填结果到对应 step', () => {
    let tasks: BgTaskEntry[] = [mk({ id: 't1', toolUseId: 'parent_1', status: 'running' })]
    tasks = applyBgToolUse(tasks, 'parent_1', 'tu_1', 'Grep', { pattern: 'auth', path: 'src' })
    tasks = applyBgToolResult(tasks, 'parent_1', 'tu_1', '命中 3 处', false)
    expect(tasks[0].steps[0].brief).toBe('Grep "auth" in src → 命中 3 处')
  })

  test('tool_result 错误加 ❌', () => {
    let tasks: BgTaskEntry[] = [mk({ id: 't1', toolUseId: 'p', status: 'running' })]
    tasks = applyBgToolUse(tasks, 'p', 'tu', 'Bash', { command: 'npm test' })
    tasks = applyBgToolResult(tasks, 'p', 'tu', 'tests failed', true)
    expect(tasks[0].steps[0].brief).toContain('❌')
    expect(tasks[0].steps[0].brief).toContain('tests failed')
  })

  test('trim:steps 累积超 ~1000 字只留最新', () => {
    let tasks: BgTaskEntry[] = [mk({ id: 't1', toolUseId: 'p', status: 'running' })]
    for (let i = 0; i < 50; i++) {
      tasks = applyBgToolUse(tasks, 'p', `tu_${i}`, 'Read', { file_path: `/very/long/path/to/file/number/${i}/source.ts` })
    }
    const totalBrief = tasks[0].steps.reduce((n, s) => n + s.brief.length + 5, 0)
    expect(totalBrief).toBeLessThanOrEqual(1100)
    expect(tasks[0].steps.length).toBeLessThan(50)
    expect(tasks[0].steps[tasks[0].steps.length - 1].brief).toContain('number/49')
  })
})

describe('isBgTerminal / hasActiveBgTask', () => {
  test('终态判定', () => {
    expect(isBgTerminal(mk({ id: 'x', status: 'completed' }))).toBe(true)
    expect(isBgTerminal(mk({ id: 'x', status: 'failed' }))).toBe(true)
    expect(isBgTerminal(mk({ id: 'x', status: 'killed' }))).toBe(true)
    expect(isBgTerminal(mk({ id: 'x', status: 'running' }))).toBe(false)
    expect(isBgTerminal(mk({ id: 'x', status: 'paused' }))).toBe(false)
  })
  test('hasActiveBgTask', () => {
    expect(hasActiveBgTask([mk({ id: 'a', status: 'completed' }), mk({ id: 'b', status: 'failed' })])).toBe(false)
    expect(hasActiveBgTask([mk({ id: 'a', status: 'completed' }), mk({ id: 'b', status: 'running' })])).toBe(true)
    expect(hasActiveBgTask([])).toBe(false)
  })
})

describe('summarizeBackground', () => {
  test('混合计数', () => {
    expect(summarizeBackground([mk({ id: 'a', status: 'running' }), mk({ id: 'b', status: 'completed' })])).toBe('1 进行中 · 1 已结束')
    expect(summarizeBackground([mk({ id: 'a', status: 'running' })])).toBe('1 进行中')
    expect(summarizeBackground([mk({ id: 'a', status: 'completed' }), mk({ id: 'b', status: 'failed' })])).toBe('2 已结束')
    expect(summarizeBackground([])).toBe('空')
  })
})

describe('任务 panel —— 标题状态+时长,展开详情', () => {
  test('running:header 写「责任人·描述 — 运行中 Ns」,时长随 now', () => {
    const t = mk({ id: 't1', type: 'subagent', description: '搜索认证', status: 'running', startedAt: 0, subagentType: 'Explore' })
    const panel = backgroundTaskPanel(t, 45000) as any
    expect(panel.tag).toBe('collapsible_panel')
    expect(panel.expanded).toBe(false)
    expect(panel.element_id).toBe('bg_t1')
    expect(panel.header.title.content).toContain('Explore')
    expect(panel.header.title.content).toContain('搜索认证')
    expect(panel.header.title.content).toContain('运行中')
    expect(panel.header.title.content).toContain('45s')
  })

  test('completed:header 写「用时 Ns」(用 usage.duration_ms)', () => {
    const t = mk({ id: 't1', type: 'shell', description: 'build', status: 'completed', startedAt: 0, usage: { total_tokens: 10, tool_uses: 1, duration_ms: 23000 } })
    const panel = backgroundTaskPanel(t, 999999) as any
    expect(panel.header.title.content).toContain('用时 23s')
  })

  test('failed:header 写「失败 Ns」', () => {
    const t = mk({ id: 't1', status: 'failed', startedAt: 0, usage: { total_tokens: 1, tool_uses: 1, duration_ms: 12000 } })
    const panel = backgroundTaskPanel(t, 999999) as any
    expect(panel.header.title.content).toContain('失败')
    expect(panel.header.title.content).toContain('12s')
  })

  test('body 精简:不含用量/摘要,无 steps 时占位', () => {
    const t = mk({ id: 't1', type: 'subagent', description: 'd', status: 'running', subagentType: 'Explore', usage: { total_tokens: 1200, tool_uses: 8, duration_ms: 1000 }, summary: '命中 3 处' })
    const panel = backgroundTaskPanel(t, 1000) as any
    const body = panel.elements[0]
    expect(body.element_id).toBe('bg_body_t1')
    expect(body.content).not.toContain('1.2K tok')
    expect(body.content).not.toContain('命中 3 处')
    expect(body.content).toContain('暂无执行记录')
  })

  test('body 含 steps(精简,无 prompt/标题)', () => {
    let t = mk({ id: 't1', type: 'subagent', toolUseId: 'p', description: '搜索', status: 'running', subagentType: 'Explore', prompt: '找 auth 代码' })
    t = applyBgToolUse([t], 'p', 'tu_1', 'Grep', { pattern: 'auth', path: 'src' })[0]
    t = applyBgToolResult([t], 'p', 'tu_1', '命中 3 处', false)[0]
    const panel = backgroundTaskPanel(t, 1000) as any
    const body = panel.elements[0]
    expect(body.content).toContain('Grep')
    expect(body.content).toContain('命中 3 处')
    expect(body.content).not.toContain('执行过程')
    expect(body.content).not.toContain('找 auth 代码')
  })
})

describe('整卡三态', () => {
  test('backgroundLiveCard:每任务一个 panel,streaming 开', () => {
    const tasks = [
      mk({ id: 't1', type: 'subagent', description: 'a', status: 'running', subagentType: 'Explore' }),
      mk({ id: 't2', type: 'shell', description: 'build', status: 'completed', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1000 } }),
    ]
    const card = backgroundLiveCard(tasks, 1000) as any
    expect(card.schema).toBe('2.0')
    expect(card.config.streaming_mode).toBe(true)
    const els = card.body.elements
    expect(els[0].tag).toBe('collapsible_panel')
    expect(els[0].element_id).toBe('bg_t1')
    expect(els[1].element_id).toBe('bg_t2')
  })

  test('backgroundHistoryCard:streaming 关 + 只渲染终态任务 panel', () => {
    const tasks = [
      mk({ id: 't1', description: '活跃', status: 'running' }),
      mk({ id: 't2', description: '完成的', status: 'completed', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1000 } }),
    ]
    const card = backgroundHistoryCard(tasks, 1000) as any
    expect(card.config.streaming_mode).toBe(false)
    const els = card.body.elements
    expect(els).toHaveLength(1)
    expect(els[0].tag).toBe('collapsible_panel')
    expect(els[0].element_id).toBe('bg_t2')
    expect(els[0].header.title.content).toContain('完成的')
  })

  test('backgroundMigratedMarker:固定标识', () => {
    const card = backgroundMigratedMarker() as any
    expect(card.config.streaming_mode).toBe(false)
    expect(card.body.elements[0].content).toContain('迁至最新卡片')
  })
})
