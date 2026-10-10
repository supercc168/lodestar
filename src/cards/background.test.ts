import { describe, expect, test } from 'bun:test'

import {
  applyBgTaskStarted,
  applyBgTaskProgress,
  applyBgTaskUpdated,
  promotePendingOnAdvance,
  applyBgTaskSettled,
  applyBgToolUse,
  applyBgToolResult,
  applySubagentStep,
  subagentStepBrief,
  shortIdHash,
  archiveTerminalAgents,
  resurrectRunning,
  resurrectSettled,
  isBgTerminal,
  hasActiveBgTask,
  splitTerminal,
  backgroundLiveSummary,
  backgroundTaskPanel,
  backgroundFoldPanel,
  foldSignature,
  backgroundLiveCard,
  backgroundHistoryCard,
  emptyBgStore,
  BG_ELEMENTS,
  BG_FOLD_KEEP,
  type BgArchiveEntry,
  type BgTaskEntry,
  type BgStore,
} from './background'
import { elapsedBucket, liveElapsed, LIVE_ELAPSED_SECOND_FOOTER_TICK_MS } from './format'

const mk = (over: Partial<BgTaskEntry> & Pick<BgTaskEntry, 'id' | 'status'>): BgTaskEntry => ({
  type: 'subagent',
  description: 'd',
  startedAt: 0,
  steps: [],
  ...over,
})

describe('elapsedBucket', () => {
  test('maps live elapsed time to stable labels and exact next boundaries', () => {
    expect(elapsedBucket(-1)).toEqual({ label: '<30s', nextDelayMs: 30_000 })
    expect(elapsedBucket(0)).toEqual({ label: '<30s', nextDelayMs: 30_000 })
    expect(elapsedBucket(29_999)).toEqual({ label: '<30s', nextDelayMs: 1 })
    expect(elapsedBucket(30_000)).toEqual({ label: '<1m', nextDelayMs: 30_000 })
    expect(elapsedBucket(59_999)).toEqual({ label: '<1m', nextDelayMs: 1 })
    expect(elapsedBucket(60_000)).toEqual({ label: '<3m', nextDelayMs: 120_000 })
    expect(elapsedBucket(180_000)).toEqual({ label: '<5m', nextDelayMs: 120_000 })
    expect(elapsedBucket(300_000)).toEqual({ label: '<10m', nextDelayMs: 300_000 })
    expect(elapsedBucket(600_000)).toEqual({ label: '10m+', nextDelayMs: 600_000 })
    expect(elapsedBucket(1_199_999)).toEqual({ label: '10m+', nextDelayMs: 1 })
    expect(elapsedBucket(1_200_000)).toEqual({ label: '20m+', nextDelayMs: 600_000 })
    // 本地档位恒为 10m 颗粒度、标签按分钟累加(60m+/70m+/180m+),不做小时换算 —— 上游的小时制断言按本地语义对齐。
    expect(elapsedBucket(3_600_000)).toEqual({ label: '60m+', nextDelayMs: 600_000 })
    expect(elapsedBucket(4_200_000)).toEqual({ label: '70m+', nextDelayMs: 600_000 })
    expect(elapsedBucket(10_800_000)).toEqual({ label: '180m+', nextDelayMs: 600_000 })
  })

  test('normalizes non-finite input instead of producing a zero-delay timer loop', () => {
    expect(elapsedBucket(Number.NaN)).toEqual({ label: '<30s', nextDelayMs: 30_000 })
    expect(elapsedBucket(Number.POSITIVE_INFINITY)).toEqual({ label: '<30s', nextDelayMs: 30_000 })
  })
})

describe('liveElapsed', () => {
  test('bucket mode delegates to elapsedBucket', () => {
    expect(liveElapsed(45_000, 'bucket')).toEqual(elapsedBucket(45_000))
    expect(liveElapsed(45_000)).toEqual(elapsedBucket(45_000))
  })

  test('second mode uses a single duration unit and preserves refresh boundaries', () => {
    expect(liveElapsed(0, 'second')).toEqual({ label: '0s', nextDelayMs: LIVE_ELAPSED_SECOND_FOOTER_TICK_MS })
    expect(liveElapsed(999, 'second')).toEqual({ label: '0s', nextDelayMs: 1000 })
    expect(liveElapsed(1_500, 'second')).toEqual({ label: '1s', nextDelayMs: 1000 })
    expect(liveElapsed(45_000, 'second')).toEqual({ label: '45s', nextDelayMs: 1000 })
    expect(liveElapsed(60_000, 'second')).toEqual({ label: '60s', nextDelayMs: 1000 })
    expect(liveElapsed(90_000, 'second')).toEqual({ label: '90s', nextDelayMs: 1000 })
    // 边界:599_999ms 仍按秒(单一秒单位),600_000ms(整 10m)切档位。
    expect(liveElapsed(599_999, 'second')).toEqual({ label: '599s', nextDelayMs: 1000 })
    // 超 10m:不再按秒,改 5m 颗粒度档位(10m+ / 15m+ / 20m+…),只在 5m 边界 push;标签按分钟累加,不做小时换算。
    expect(liveElapsed(600_000, 'second')).toEqual({ label: '10m+', nextDelayMs: 300_000 })
    expect(liveElapsed(899_999, 'second')).toEqual({ label: '10m+', nextDelayMs: 1 })
    expect(liveElapsed(900_000, 'second')).toEqual({ label: '15m+', nextDelayMs: 300_000 })
    expect(liveElapsed(1_200_000, 'second')).toEqual({ label: '20m+', nextDelayMs: 300_000 })
    expect(liveElapsed(3_600_000, 'second')).toEqual({ label: '60m+', nextDelayMs: 300_000 })
    expect(liveElapsed(4_200_000, 'second')).toEqual({ label: '70m+', nextDelayMs: 300_000 })
    expect(liveElapsed(10_800_000, 'second')).toEqual({ label: '180m+', nextDelayMs: 300_000 })
  })
})

describe('applyBgTaskStarted — 白名单直入 active / 前台落 pending', () => {
  test('workflow 白名单直入 active 并标 isBackgrounded', () => {
    let s = emptyBgStore()
    s = applyBgTaskStarted(s, { task_id: 'w1', task_type: 'local_workflow', description: '跑 spec', workflow_name: 'spec' }, 1000)
    expect(s.active).toHaveLength(1)
    expect(s.pending).toHaveLength(0)
    expect(s.active[0]).toMatchObject({ id: 'w1', type: 'workflow', status: 'running', startedAt: 1000, workflowName: 'spec', isBackgrounded: true })
  })

  test('monitor 白名单直入 active', () => {
    const s = applyBgTaskStarted(emptyBgStore(), { task_id: 'm1', task_type: 'local_monitor', description: '盯盘' })
    expect(s.active[0].type).toBe('monitor')
    expect(s.active[0].isBackgrounded).toBe(true)
    expect(s.pending).toHaveLength(0)
  })

  test('前台 shell(Bash 命令)进 pending,active 空,不标 isBackgrounded', () => {
    const s = applyBgTaskStarted(emptyBgStore(), { task_id: 'b1', task_type: 'local_bash', description: 'build' })
    expect(s.active).toHaveLength(0)
    expect(s.pending).toHaveLength(1)
    expect(s.pending[0]).toMatchObject({ id: 'b1', type: 'shell', status: 'running' })
    expect(s.pending[0].isBackgrounded).toBeUndefined()
  })

  test('前台子 agent 直入 active 并标 isBackgrounded', () => {
    const s = applyBgTaskStarted(emptyBgStore(), { task_id: 'a1', description: '搜索', subagent_type: 'Explore' })
    expect(s.pending).toHaveLength(0)
    expect(s.active[0]).toMatchObject({ id: 'a1', type: 'subagent', subagentType: 'Explore', isBackgrounded: true })
  })

  test('DSH agent 类型直接显示为子 Agent', () => {
    const s = applyBgTaskStarted(emptyBgStore(), { task_id: 'dsh', task_type: 'agent', description: '检查' })
    expect(s.pending).toHaveLength(0)
    expect(s.active[0].type).toBe('subagent')
  })

  test('SDK 后补子 Agent 类型时立即从观察池展示', () => {
    const unknown = applyBgTaskStarted(emptyBgStore(), { task_id: 'child', description: '检查' })
    expect(unknown.pending).toHaveLength(1)
    const known = applyBgTaskStarted(unknown, { task_id: 'child', description: '检查', subagent_type: 'Explore' })
    expect(known.pending).toHaveLength(0)
    expect(known.active[0].type).toBe('subagent')
  })

  test('SDK task id 回填沿用启动工具的状态与步骤，续跑重新计时', () => {
    let s = applyBgTaskStarted(emptyBgStore(), { task_id: 'tool', tool_use_id: 'tool', task_type: 'subagent', description: '检查' }, 100)
    s = applyBgToolUse(s, 'tool', 'read', 'Read', { file_path: '/repo/a.ts' })
    s = applyBgTaskStarted(s, { task_id: 'sdk-task', tool_use_id: 'tool', description: '检查代码' }, 200)
    expect(s.active).toHaveLength(1)
    expect(s.active[0]).toMatchObject({ id: 'sdk-task', type: 'subagent', startedAt: 100 })
    expect(s.active[0].steps).toHaveLength(1)
    s = applyBgTaskSettled(s, { task_id: 'sdk-task', status: 'completed', summary: '已完成' }, 300)
    s = applyBgTaskStarted(s, { task_id: 'sdk-task', tool_use_id: 'tool', task_type: 'subagent', description: '续跑' }, 400)
    expect(s.active[0]).toMatchObject({ startedAt: 400, status: 'running', steps: [] })
    expect(s.active[0].endTime).toBeUndefined()
    expect(s.active[0].summary).toBeUndefined()
  })

  test('local_ 前缀归一化:local_bash→shell / local_agent→subagent / local_workflow→workflow', () => {
    expect(applyBgTaskStarted(emptyBgStore(), { task_id: 'b', task_type: 'local_bash', description: 'x' }).pending[0].type).toBe('shell')
    expect(applyBgTaskStarted(emptyBgStore(), { task_id: 'a', task_type: 'local_agent', description: 'x' }).active[0].type).toBe('subagent')
    expect(applyBgTaskStarted(emptyBgStore(), { task_id: 'w', task_type: 'local_workflow', description: 'x' }).active[0].type).toBe('workflow')
  })

  test('重复 task_id 不堆叠,补全字段但留在原池 + 保留 status/startedAt', () => {
    // pending 里的前台 task 再次收到 started:补全字段,不提升
    const s0: BgStore = {
      active: [],
      pending: [mk({ id: 't1', type: 'unknown', description: '旧', status: 'running', startedAt: 1000, usage: { total_tokens: 100, tool_uses: 2, duration_ms: 1000 } })],
    }
    const s = applyBgTaskStarted(s0, { task_id: 't1', task_type: 'shell', description: '新描述' }, 9999)
    expect(s.pending).toHaveLength(1)
    expect(s.active).toHaveLength(0)
    expect(s.pending[0].description).toBe('新描述')
    expect(s.pending[0].type).toBe('shell')
    expect(s.pending[0].startedAt).toBe(1000)  // 不被覆盖
    expect(s.pending[0].usage?.total_tokens).toBe(100)
  })
})

describe('applyBgTaskProgress — active/pending 双池刷新', () => {
  test('刷 active 里的 task', () => {
    const s0: BgStore = { active: [mk({ id: 't1', status: 'running', subagentType: 'Explore' })], pending: [] }
    const s = applyBgTaskProgress(s0, { task_id: 't1', usage: { total_tokens: 500, tool_uses: 3, duration_ms: 2000 }, last_tool_name: 'Grep', summary: '命中 3 处' })
    expect(s.active[0].usage?.total_tokens).toBe(500)
    expect(s.active[0].lastToolName).toBe('Grep')
    expect(s.active[0].summary).toBe('命中 3 处')
  })

  test('刷 pending 里的前台 task(提升前攒数据)', () => {
    const s0: BgStore = { active: [], pending: [mk({ id: 't1', status: 'running' })] }
    const s = applyBgTaskProgress(s0, { task_id: 't1', summary: '跑着' })
    expect(s.pending[0].summary).toBe('跑着')
  })

  test('pending → running 状态提升', () => {
    const s0: BgStore = { active: [], pending: [mk({ id: 't1', status: 'pending' })] }
    const s = applyBgTaskProgress(s0, { task_id: 't1' })
    expect(s.pending[0].status).toBe('running')
  })

  test('未知 task_id no-op', () => {
    const s: BgStore = { active: [mk({ id: 't1', status: 'running' })], pending: [] }
    expect(applyBgTaskProgress(s, { task_id: 'tX' })).toBe(s)
  })
})

describe('applyBgTaskUpdated — is_backgrounded 提升 + 原池 patch', () => {
  test('is_backgrounded:true 把 pending 前台 task 提升到 active,带 steps', () => {
    const s0: BgStore = {
      active: [],
      pending: [mk({ id: 't1', type: 'shell', toolUseId: 'p', description: 'build', status: 'running', steps: [{ toolUseId: 'tu', tool: 'Bash', brief: 'old' }] })],
    }
    const s = applyBgTaskUpdated(s0, { task_id: 't1', patch: { is_backgrounded: true } })
    expect(s.pending).toHaveLength(0)
    expect(s.active).toHaveLength(1)
    expect(s.active[0].isBackgrounded).toBe(true)
    expect(s.active[0].steps).toHaveLength(1)  // steps 带过来
  })

  test('已在 active 的 task 收 is_backgrounded:true 不重复添加(原地标记)', () => {
    const s0: BgStore = { active: [mk({ id: 't1', status: 'running' })], pending: [] }
    const s = applyBgTaskUpdated(s0, { task_id: 't1', patch: { is_backgrounded: true, status: 'paused', error: 'oom' } })
    expect(s.active).toHaveLength(1)
    expect(s.active[0].isBackgrounded).toBe(true)
    expect(s.active[0].status).toBe('paused')
    expect(s.active[0].error).toBe('oom')
  })

  test('pending 里的非提升 patch(改 status)不提升', () => {
    const s0: BgStore = { active: [], pending: [mk({ id: 't1', status: 'running' })] }
    const s = applyBgTaskUpdated(s0, { task_id: 't1', patch: { status: 'paused' } })
    expect(s.pending).toHaveLength(1)
    expect(s.active).toHaveLength(0)
    expect(s.pending[0].status).toBe('paused')
  })

  test('未知 task_id no-op(不凭空造)', () => {
    const s: BgStore = { active: [], pending: [] }
    expect(applyBgTaskUpdated(s, { task_id: 'tX', patch: { is_backgrounded: true } })).toBe(s)
  })
})

describe('applyBgTaskSettled — 前台丢弃 / active 结算墓碑', () => {
  test('pending 前台 task 结算 → 直接丢,不进 active', () => {
    const s0: BgStore = { active: [], pending: [mk({ id: 't1', status: 'running', startedAt: 1000 })] }
    const s = applyBgTaskSettled(s0, { task_id: 't1', status: 'completed' }, 8000)
    expect(s.active).toHaveLength(0)
    expect(s.pending).toHaveLength(0)
  })

  test('active 后台 task 结算 → 墓碑 + endTime', () => {
    const s0: BgStore = { active: [mk({ id: 't1', status: 'running', startedAt: 1000 })], pending: [] }
    const s = applyBgTaskSettled(s0, { task_id: 't1', status: 'completed', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 7000 } }, 8000)
    expect(s.active[0]).toMatchObject({ status: 'completed', endTime: 8000 })
    expect(s.active[0].usage?.duration_ms).toBe(7000)
  })

  test('failed/stopped → failed/killed', () => {
    const s0: BgStore = {
      active: [
        mk({ id: 't1', status: 'running', startedAt: 1000 }),
        mk({ id: 't2', status: 'running', startedAt: 1000 }),
      ],
      pending: [],
    }
    let s = applyBgTaskSettled(s0, { task_id: 't1', status: 'failed' }, 8000)
    s = applyBgTaskSettled(s, { task_id: 't2', status: 'stopped' }, 8000)
    expect(s.active.map(t => t.status)).toEqual(['failed', 'killed'])
  })

  test('未知 task 终态 no-op(不补建墓碑,避免冒充后台任务)', () => {
    const s: BgStore = { active: [], pending: [] }
    expect(applyBgTaskSettled(s, { task_id: 'tZ', status: 'completed', summary: 'done' }, 8000)).toBe(s)
  })
})

describe('applyBgToolUse / applyBgToolResult — 双池 steps 累积', () => {
  test('parentToolUseId 匹配的 task 追加 step;主线程(null)/不匹配跳过', () => {
    let s: BgStore = { active: [mk({ id: 't1', toolUseId: 'parent_1', status: 'running' })], pending: [] }
    s = applyBgToolUse(s, 'parent_1', 'tu_1', 'Grep', { pattern: 'auth', path: 'src' })
    expect(s.active[0].steps).toHaveLength(1)
    expect(s.active[0].steps[0]).toMatchObject({ toolUseId: 'tu_1', tool: 'Grep' })
    expect(s.active[0].steps[0].brief).toContain('auth')
    // 主线程工具(null)跳过
    expect(applyBgToolUse(s, null, 'tu_2', 'Bash', { command: 'ls' })).toBe(s)
    // 不匹配的 parent 跳过
    expect(applyBgToolUse(s, 'other_parent', 'tu_3', 'Read', { file_path: '/x' })).toBe(s)
  })

  test('pending 池的 task 也累积 steps(双池对称)', () => {
    let s: BgStore = { active: [], pending: [mk({ id: 't1', type: 'shell', toolUseId: 'p', status: 'running' })] }
    s = applyBgToolUse(s, 'p', 'tu_1', 'Grep', { pattern: 'auth', path: 'src' })
    expect(s.pending[0].steps).toHaveLength(1)
  })

  test('tool_result 按 tool_use_id 回填结果到对应 step(双池)', () => {
    let s: BgStore = { active: [], pending: [mk({ id: 't1', type: 'shell', toolUseId: 'p', status: 'running' })] }
    s = applyBgToolUse(s, 'p', 'tu_1', 'Grep', { pattern: 'auth', path: 'src' })
    s = applyBgToolResult(s, 'p', 'tu_1', '命中 3 处', false)
    expect(s.pending[0].steps[0].brief).toBe('Grep "auth" in src → 命中 3 处')
  })

  test('Bash step 的 brief 走 shell-command 解析:PowerShell 包装显示 desc 说明', () => {
    // Windows 子 agent 的命令被包进 powershell.exe -Command '...',steps 里
    // 应显示中文说明,不显示 powershell.exe 路径 / # desc 注释。
    let s: BgStore = { active: [mk({ id: 't1', toolUseId: 'p', status: 'running' })], pending: [] }
    s = applyBgToolUse(s, 'p', 'tu', 'Bash', {
      command: `'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -Command '# desc: 查看 xyq 项目模板状态\nGet-ChildItem "C:\\xyq" -Recurse'`,
    })
    expect(s.active[0].steps[0].brief).toBe('Bash 查看 xyq 项目模板状态')
    expect(s.active[0].steps[0].brief).not.toContain('powershell')
    expect(s.active[0].steps[0].brief).not.toContain('# desc')
  })

  test('tool_result 错误加 ❌', () => {
    let s: BgStore = { active: [mk({ id: 't1', toolUseId: 'p', status: 'running' })], pending: [] }
    s = applyBgToolUse(s, 'p', 'tu', 'Bash', { command: 'npm test' })
    s = applyBgToolResult(s, 'p', 'tu', 'tests failed', true)
    expect(s.active[0].steps[0].brief).toContain('❌')
    expect(s.active[0].steps[0].brief).toContain('tests failed')
  })

  test('DSH 结构化工具结果可在后台和观察池中显示，保留错误信息', () => {
    for (const pool of ['active', 'pending'] as const) {
      let s: BgStore = { active: [], pending: [] }
      s[pool] = [mk({ id: 'dsh-child', toolUseId: 'parent', status: 'running' })]
      s = applyBgToolUse(s, 'parent', 'bash', 'Bash', { command: 'echo child' })
      s = applyBgToolResult(s, 'parent', 'bash', [
        { type: 'text', text: 'started background job bash-1' },
        { type: 'text', text: 'second line' },
      ], false)
      expect(s[pool][0].steps[0].brief).toContain('started background job bash-1 second line')
      s = applyBgToolUse(s, 'parent', 'failed', 'Bash', { command: 'false' })
      s = applyBgToolResult(s, 'parent', 'failed', [{ type: 'text', text: 'command failed' }], true)
      expect(s[pool][0].steps[1].brief).toContain('❌ command failed')
    }
  })

  test('trim:steps 累积超 ~1000 字只留最新', () => {
    let s: BgStore = { active: [mk({ id: 't1', toolUseId: 'p', status: 'running' })], pending: [] }
    for (let i = 0; i < 50; i++) {
      s = applyBgToolUse(s, 'p', `tu_${i}`, 'Read', { file_path: `/very/long/path/to/file/number/${i}/source.ts` })
    }
    const totalBrief = s.active[0].steps.reduce((n, st) => n + st.brief.length + 5, 0)
    expect(totalBrief).toBeLessThanOrEqual(1100)
    expect(s.active[0].steps.length).toBeLessThan(50)
    expect(s.active[0].steps[s.active[0].steps.length - 1].brief).toContain('number/49')
  })

  test('端到端:前台子 agent started 直入 active,steps 直接落 active(后台化提升保留同一项)', () => {
    let s = emptyBgStore()
    s = applyBgTaskStarted(s, { task_id: 'a1', task_type: 'local_agent', description: '搜索', subagent_type: 'Explore', tool_use_id: 'p' })
    expect(s.active).toHaveLength(1)
    expect(s.pending).toHaveLength(0)
    s = applyBgToolUse(s, 'p', 'tu_1', 'Grep', { pattern: 'auth', path: 'src' })
    s = applyBgToolResult(s, 'p', 'tu_1', '命中', false)
    expect(s.active).toHaveLength(1)
    expect(s.active[0].steps).toHaveLength(1)
    // 后台化 → 提升,steps 带到 active
    s = applyBgTaskUpdated(s, { task_id: 'a1', patch: { is_backgrounded: true } })
    expect(s.active).toHaveLength(1)
    expect(s.active[0].steps).toHaveLength(1)
    expect(s.active[0].steps[0].brief).toBe('Grep "auth" in src → 命中')
  })
})

describe('端到端:前台命令全程不进 active(治「随便跑个命令就冒一项」)', () => {
  test('前台 Bash:started→pending,settled→丢,active 全程空,不建卡', () => {
    let s = emptyBgStore()
    s = applyBgTaskStarted(s, { task_id: 'b1', task_type: 'local_bash', description: 'echo hi' })
    expect(hasActiveBgTask(s.active)).toBe(false)  // active 空,不该建卡
    s = applyBgTaskSettled(s, { task_id: 'b1', status: 'completed' })
    expect(s.active).toHaveLength(0)
    expect(s.pending).toHaveLength(0)
    expect(hasActiveBgTask(s.active)).toBe(false)
  })

  test('前台命令被 Ctrl+B 后台化 → 入卡 → 结算墓碑', () => {
    let s = emptyBgStore()
    s = applyBgTaskStarted(s, { task_id: 'b2', task_type: 'local_bash', description: '长跑构建' })
    expect(hasActiveBgTask(s.active)).toBe(false)
    s = applyBgTaskUpdated(s, { task_id: 'b2', patch: { is_backgrounded: true } })
    expect(hasActiveBgTask(s.active)).toBe(true)  // 后台化后该建卡
    s = applyBgTaskSettled(s, { task_id: 'b2', status: 'completed' })
    expect(s.active[0].status).toBe('completed')
    expect(hasActiveBgTask(s.active)).toBe(false)  // 终态,不再活跃
  })

  test('workflow 天生后台:started 即入 active', () => {
    const s = applyBgTaskStarted(emptyBgStore(), { task_id: 'w1', task_type: 'local_workflow', description: 'spec', workflow_name: 'spec' })
    expect(hasActiveBgTask(s.active)).toBe(true)
  })
})

describe('summary 文案:🧭 子agent', () => {
  test('live 卡 summary 用「🧭 子agent」', () => {
    const card = backgroundLiveCard([mk({ id: 't1', type: 'subagent', subagentType: 'Explore', status: 'running' })]) as any
    expect(card.config.summary.content).toContain('🧭 子agent')
    expect(card.config.summary.content).not.toContain('后台任务')
  })

  test('history 卡 summary 用「🧭 子agent(历史)」', () => {
    const card = backgroundHistoryCard([mk({ id: 't1', type: 'subagent', status: 'completed', endTime: 5000 })]) as any
    expect(card.config.summary.content).toContain('🧭 子agent(历史)')
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

describe('任务面板：标题简洁，详情折叠', () => {
  test('短说明标题单行，展开保留错误、终态摘要及全部步骤', () => {
    const panel = backgroundTaskPanel(mk({
      id: 'long', status: 'failed', description: '检查认证流程', error: '读取失败', summary: '部分结果',
      steps: [1, 2, 3, 4].map(i => ({ toolUseId: String(i), tool: 'Read', brief: `检查步骤 ${i}` })),
    }), 1000) as any
    expect(panel.expanded).toBe(false)
    expect(panel.header.title.content).not.toContain('\n')
    expect(panel.header.title.content.length).toBeLessThan(60)
    const body = panel.elements[0].content
    expect(body).toContain('读取失败')
    expect(body).toContain('部分结果')
    expect(body).toContain('检查步骤 1')
    expect(body).toContain('检查步骤 4')
  })
})

describe('backgroundLiveSummary — 聊天列表预览全文(建卡与刷新共用)', () => {
  test('带 🧭 前缀 + 实时计数', () => {
    expect(backgroundLiveSummary([mk({ id: 'a', status: 'running' })])).toBe('🧭 子agent · 1 进行中')
    expect(backgroundLiveSummary([mk({ id: 'a', status: 'running' }), mk({ id: 'b', status: 'running' }), mk({ id: 'c', status: 'completed' })])).toBe('🧭 子agent · 2 进行中 · 1 已结束')
    expect(backgroundLiveSummary([])).toBe('🧭 子agent · 空')
  })
})

describe('任务 panel —— 标题状态+时长,展开详情', () => {
  test('running:header 写「责任人·描述 — 运行中 <档位>」,时长随 now', () => {
    const t = mk({ id: 't1', type: 'subagent', description: '搜索认证', status: 'running', startedAt: 0, subagentType: 'Explore' })
    const panel = backgroundTaskPanel(t, 45_000) as any
    expect(panel.tag).toBe('collapsible_panel')
    expect(panel.expanded).toBe(false)
    expect(panel.element_id).toBe(BG_ELEMENTS.panel('t1'))
    expect(panel.header.title.content).toContain('Explore')
    expect(panel.header.title.content).toContain('搜索认证')
    expect(panel.header.title.content).toContain('运行中')
    expect(panel.header.title.content).toContain('(<1m)')
  })

  test('running + second 模式:header 写精确秒数', () => {
    const t = mk({ id: 't1', type: 'subagent', description: '搜索认证', status: 'running', startedAt: 0, subagentType: 'Explore' })
    const panel = backgroundTaskPanel(t, 45_000, 'second') as any
    expect(panel.header.title.content).toContain('(45s)')
    expect(panel.header.title.content).not.toContain('<1m')
  })

  test('运行中详情不展示静止的计时数字', () => {
    const t = mk({ id: 't1', type: 'subagent', description: '搜索认证', status: 'running', startedAt: 0, subagentType: 'Explore' })
    const panel = backgroundTaskPanel(t, 45_000) as any
    // header 用随 tick 更新的档位标签;body 不冻结任何秒数。
    expect(panel.header.title.content).toContain('(<1m)')
    expect(panel.elements[0].content).not.toContain('45s')
  })

  test('shell:header 只显示 # desc 标题,不回显多行命令', () => {
    const command = [
      '# desc: 后台轮询READY后立即serialize Track C',
      'cd /Users/doge/svn/etmmo/Client',
      'for i in $(seq 1 28); do',
      '  sleep 15',
      'done',
    ].join('\n')
    const t = mk({ id: 't1', type: 'shell', description: command, status: 'running', startedAt: 0 })
    const panel = backgroundTaskPanel(t, 53000) as any
    const title = panel.header.title.content

    expect(title).toBe('⚙️ shell · 后台轮询READY后立即serialize Track C — 🟡 运行中 (<1m)')
    expect(title.split('\n')).toHaveLength(1)
    expect(title).not.toContain('# desc:')
    expect(title).not.toContain('cd /Users')
    expect(title).not.toContain('for i in')
  })

  test('shell:无 # desc 时生成单行脚本摘要,折叠汇总也不回显命令', () => {
    const command = 'cd /workspace\nset -e\nbun test src/cards/background.test.ts'
    const running = mk({ id: 't1', type: 'shell', description: command, status: 'running', startedAt: 0 })
    const title = (backgroundTaskPanel(running, 53000) as any).header.title.content
    expect(title).toContain('Shell 脚本 · 3 行 · bun test src/cards/background.test.ts')
    expect(title.split('\n')).toHaveLength(1)
    expect(title).not.toContain('cd /workspace')

    const completed = { ...running, status: 'completed' as const, endTime: 1000 }
    const foldBody = (backgroundFoldPanel([completed], 1000) as any).elements[0].content
    expect(foldBody).toContain('Shell 脚本 · 3 行 · bun test src/cards/background.test.ts')
    expect(foldBody).not.toContain('cd /workspace')
    expect(foldBody).not.toContain('set -e')
  })

  test('completed:header 写「用时 Ns」(用 usage.duration_ms)', () => {
    const t = mk({ id: 't1', type: 'shell', description: 'build', status: 'completed', startedAt: 0, usage: { total_tokens: 10, tool_uses: 1, duration_ms: 23000 } })
    const panel = backgroundTaskPanel(t, 999999) as any
    expect(panel.header.title.content).toContain('用时 23s')
  })

  test('完成任务在标题显示实际耗时', () => {
    const t = mk({ id: 't1', type: 'shell', description: 'build', status: 'completed', startedAt: 0, usage: { total_tokens: 10, tool_uses: 1, duration_ms: 10_800_000 } })
    const panel = backgroundTaskPanel(t, 999999) as any
    expect(panel.header.title.content).toContain('用时 3h')
  })

  test('失败状态与耗时在标题可见（body 精简不回显耗时）', () => {
    const t = mk({ id: 't1', status: 'failed', startedAt: 0, usage: { total_tokens: 1, tool_uses: 1, duration_ms: 12000 } })
    const panel = backgroundTaskPanel(t) as any
    expect(panel.header.title.content).toContain('失败')
    expect(panel.header.title.content).toContain('12s')
    expect(panel.elements[0].content).not.toContain('12s')
  })

  test('body 精简:不含用量/摘要,无 steps 时占位', () => {
    const t = mk({ id: 't1', type: 'subagent', description: 'd', status: 'running', subagentType: 'Explore', usage: { total_tokens: 1200, tool_uses: 8, duration_ms: 1000 }, summary: '命中 3 处' })
    const panel = backgroundTaskPanel(t, 1000) as any
    const body = panel.elements[0]
    expect(body.element_id).toBe('bgb_2alkgm') // bgb_ + shortIdHash('t1')
    expect(body.content).not.toContain('1.2K tok')
    expect(body.content).not.toContain('命中 3 处')
    expect(body.content).toContain('暂无执行记录')
  })

  test('详情包含任务说明和最近动作', () => {
    let s: BgStore = { active: [mk({ id: 't1', type: 'subagent', toolUseId: 'p', description: '搜索', status: 'running', subagentType: 'Explore', prompt: '找 auth 代码' })], pending: [] }
    s = applyBgToolUse(s, 'p', 'tu_1', 'Grep', { pattern: 'auth', path: 'src' })
    s = applyBgToolResult(s, 'p', 'tu_1', '命中 3 处', false)
    const panel = backgroundTaskPanel(s.active[0]) as any
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
    expect(card.config.summary.content).toBe('🧭 子agent · 1 进行中 · 1 已结束')
    const els = card.body.elements
    expect(els[0].tag).toBe('collapsible_panel')
    expect(els[0].element_id).toBe(BG_ELEMENTS.panel('t1'))
    expect(els[1].element_id).toBe(BG_ELEMENTS.panel('t2'))
    expect(els[0].element_id).not.toBe(els[1].element_id)
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
    expect(els[0].element_id).toBe(BG_ELEMENTS.panel('t2'))
    expect(els[0].header.title.content).toContain('完成的')
  })

  test('标题明确区分后台命令和子 Agent', () => {
    const processPanel = backgroundTaskPanel(mk({ id: 'shell', type: 'shell', description: '构建', status: 'failed' })) as any
    const childPanel = backgroundTaskPanel(mk({ id: 'child', type: 'subagent', description: '检查', status: 'failed' })) as any
    expect(processPanel.header.title.content).toContain('⚙️ shell · 构建')
    expect(childPanel.header.title.content).toContain('🟢 子agent · 检查')
  })

  test('终态摘要按 400 字截断展示，任务说明不入详情', () => {
    const panel = backgroundTaskPanel(mk({
      id: 'long-content', type: 'subagent', description: '检查', status: 'completed',
      prompt: `先检查 ${'任务细节 '.repeat(200)}任务末尾标记`,
      summary: `${'完整结果 '.repeat(1000)}结果末尾标记`,
    })) as any
    const body = panel.elements[0].content
    expect(body).toContain('📝 完整结果')
    expect(body).not.toContain('任务末尾标记')
    expect(body).not.toContain('结果末尾标记')
  })

  test('BG_ELEMENTS id 生成:panel/body 走短哈希,fold/foldBody 固定 id 不哈希', () => {
    // shortIdHash('t1') = '2alkgm'(FNV-1a 32bit → base36,稳定映射)
    expect(BG_ELEMENTS.panel('t1')).toBe('bg_2alkgm')
    expect(BG_ELEMENTS.body('t1')).toBe('bgb_2alkgm')
    // 本地折叠汇总 panel(dc55fa6)固定 id 保持原样 —— 天然合规,不参与哈希。
    expect(BG_ELEMENTS.fold).toBe('bg_fold')
    expect(BG_ELEMENTS.foldBody).toBe('bg_fold_body')
  })
})

describe('shortIdHash —— codex UUID element_id 合规化(飞书:字母开头 ≤20 字符)', () => {
  const uuid = '019904d6-9c37-7e73-b761-6bcfe222d2b9'

  test('相同输入稳定映射,不同输入不同哈希', () => {
    expect(shortIdHash(uuid)).toBe(shortIdHash(uuid))
    expect(shortIdHash('t1')).toBe('2alkgm') // 算法锁定:FNV-1a 32bit → base36
    expect(shortIdHash('t1')).not.toBe(shortIdHash('t2'))
  })

  test('输出 ≤7 字符 base36;UUID 拼前缀后整 id 字母开头且 ≤20 字符', () => {
    expect(shortIdHash(uuid)).toMatch(/^[a-z0-9]{1,7}$/)
    for (const el of [BG_ELEMENTS.panel(uuid), BG_ELEMENTS.body(uuid)]) {
      expect(el).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/)
      expect(el.length).toBeLessThanOrEqual(20)
    }
  })
})

describe('applySubagentStep —— codex 子 agent 过程步骤(按 thread_id 归属)', () => {
  const entry = (id: string) => mk({ id, type: 'subagent', description: 'd', status: 'running', isBackgrounded: true })

  test('started 追加新 step(brief 前缀工具名)', () => {
    let s: BgStore = { active: [entry('th-1')], pending: [] }
    s = applySubagentStep(s, 'th-1', 'item_1', 'Bash', 'started', 'bun test')
    expect(s.active[0].steps).toHaveLength(1)
    expect(s.active[0].steps[0]).toEqual({ toolUseId: 'item_1', tool: 'Bash', brief: 'Bash bun test' })
  })

  test('completed 按 item_id 回填结果段到同一 step', () => {
    let s: BgStore = { active: [entry('th-1')], pending: [] }
    s = applySubagentStep(s, 'th-1', 'item_1', 'Bash', 'started', 'bun test')
    s = applySubagentStep(s, 'th-1', 'item_1', 'Bash', 'completed', '→ 12 pass')
    expect(s.active[0].steps).toHaveLength(1)
    expect(s.active[0].steps[0].brief).toBe('Bash bun test → 12 pass')
  })

  test('completed 无对应 step(漏 started)且 brief 非空 → 补一步', () => {
    let s: BgStore = { active: [entry('th-1')], pending: [] }
    s = applySubagentStep(s, 'th-1', 'item_x', 'Bash', 'completed', '→ done')
    expect(s.active[0].steps).toHaveLength(1)
    expect(s.active[0].steps[0].brief).toBe('Bash → done')
  })

  test('completed 空 brief:既不改 step 也不补步', () => {
    let s: BgStore = { active: [entry('th-1')], pending: [] }
    s = applySubagentStep(s, 'th-1', 'item_1', 'FileChange', 'started', '改 2 个文件')
    s = applySubagentStep(s, 'th-1', 'item_1', 'FileChange', 'completed', '')
    expect(s.active[0].steps[0].brief).toBe('FileChange 改 2 个文件')
    s = applySubagentStep(s, 'th-1', 'item_y', 'FileChange', 'completed', '')
    expect(s.active[0].steps).toHaveLength(1)
  })

  test('双池同查:pending 池条目同样累积', () => {
    let s: BgStore = { active: [], pending: [entry('th-p')] }
    s = applySubagentStep(s, 'th-p', 'item_1', 'WebSearch', 'started', '"bun"')
    expect(s.pending[0].steps).toHaveLength(1)
  })

  test('无归属 thread → 返回原 store 引用', () => {
    const s: BgStore = { active: [entry('th-1')], pending: [] }
    expect(applySubagentStep(s, 'th-nope', 'item_1', 'Bash', 'started', 'x')).toBe(s)
  })
})

describe('subagentStepBrief —— 子 agent 步骤单行简报', () => {
  test('Bash started 显示命令,completed 显示输出首段', () => {
    expect(subagentStepBrief('Bash', { command: 'bun test' })).toBe('bun test')
    expect(subagentStepBrief('Bash', { command: 'bun test' }, ' 12 pass\n0 fail ')).toBe('→ 12 pass 0 fail')
    expect(subagentStepBrief('Bash', { command: 'x' }, '   ')).toBe('')
  })

  test('FileChange started 显示文件数,completed 归空(不重复 started 信息)', () => {
    expect(subagentStepBrief('FileChange', { changes: [{}, {}] })).toBe('改 2 个文件')
    expect(subagentStepBrief('FileChange', {})).toBe('文件变更')
    expect(subagentStepBrief('FileChange', { changes: [{}] }, '[{"path":"a"}]')).toBe('')
  })

  test('MCP / WebSearch / default 形态', () => {
    expect(subagentStepBrief('MCP', { server: 'srv', tool: 'do' })).toBe('srv/do')
    expect(subagentStepBrief('WebSearch', { query: 'bun test' })).toBe('"bun test"')
    expect(subagentStepBrief('Read', { file_path: '/a.ts' })).toBe('{"file_path":"/a.ts"}')
    expect(subagentStepBrief('Read', { file_path: '/a.ts' }, 'ok')).toBe('→ ok')
  })
})

describe('settle summary 墓碑 —— 终态 entry 的 summary 置顶渲染', () => {
  test('终态 + summary:body 首行 📝 摘要(≤400 字),steps 完整跟在后面', () => {
    let s: BgStore = { active: [mk({ id: 't1', type: 'subagent', toolUseId: 'p', description: 'd', status: 'running' })], pending: [] }
    s = applyBgToolUse(s, 'p', 'tu_1', 'Grep', { pattern: 'auth', path: 'src' })
    const done: BgTaskEntry = { ...s.active[0], status: 'completed', summary: '结论:全部通过', endTime: 1000, usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1000 } }
    const body = (backgroundTaskPanel(done, 2000) as any).elements[0]
    expect(body.content).toContain('📝 结论:全部通过')
    expect(body.content.indexOf('📝')).toBeLessThan(body.content.indexOf('Grep'))
  })

  test('summary 超 400 字截断', () => {
    const t = mk({ id: 't1', status: 'completed', summary: 'x'.repeat(500), usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1000 } })
    const body = (backgroundTaskPanel(t, 2000) as any).elements[0]
    expect(body.content).toContain('x'.repeat(400))
    expect(body.content).not.toContain('x'.repeat(401))
  })

  test('非终态 entry 的 summary 不渲染(running 时 body 仍精简)', () => {
    const t = mk({ id: 't1', status: 'running', summary: '中途摘要' })
    const body = (backgroundTaskPanel(t, 2000) as any).elements[0]
    expect(body.content).not.toContain('中途摘要')
    expect(body.content).not.toContain('📝')
  })
})

describe('折叠汇总 —— 更早已完成任务收进 bg_fold', () => {
  test('splitTerminal:终态 ≤ keep 全留 recent,older 空(不建 fold)', () => {
    const tasks = [
      mk({ id: 'r', status: 'running' }),
      mk({ id: 'a', status: 'completed', endTime: 1000 }),
      mk({ id: 'b', status: 'completed', endTime: 2000 }),
    ]
    const { recent, older } = splitTerminal(tasks)
    expect(older).toHaveLength(0)
    expect(recent).toHaveLength(2)
  })

  test('splitTerminal:终态 > keep 留最近 keep 条,其余进 older', () => {
    const tasks = [
      mk({ id: 'a', status: 'completed', endTime: 1000 }),
      mk({ id: 'b', status: 'completed', endTime: 2000 }),
      mk({ id: 'c', status: 'completed', endTime: 3000 }),
      mk({ id: 'd', status: 'completed', endTime: 4000 }),
    ]
    const { recent, older } = splitTerminal(tasks)
    expect(recent.map(t => t.id)).toEqual(['d', 'c'])   // 最近两条(endTime 降序)
    expect(older.map(t => t.id)).toEqual(['b', 'a'])
  })

  test('splitTerminal:endTime 缺失退回 startedAt', () => {
    const tasks = [
      mk({ id: 'a', status: 'completed', startedAt: 10, endTime: undefined }),
      mk({ id: 'b', status: 'completed', startedAt: 50, endTime: undefined }),
      mk({ id: 'c', status: 'completed', startedAt: 100, endTime: undefined }),
    ]
    const { recent } = splitTerminal(tasks)
    expect(recent.map(t => t.id)).toEqual(['c', 'b'])
  })

  test('backgroundFoldPanel:header「另有 N 项已完成」+ 折叠 + element_id', () => {
    const older = [
      mk({ id: 'a', type: 'shell', description: 'build', status: 'completed', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 33000 } }),
      mk({ id: 'b', type: 'shell', description: 'test', status: 'completed', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 12000 } }),
    ]
    const panel = backgroundFoldPanel(older, 999999) as any
    expect(panel.tag).toBe('collapsible_panel')
    expect(panel.expanded).toBe(false)
    expect(panel.element_id).toBe('bg_fold')
    expect(panel.header.title.content).toBe('📦 另有 2 项已完成')
    const body = panel.elements[0]
    expect(body.element_id).toBe('bg_fold_body')
    expect(body.content).toContain('build')
    expect(body.content).toContain('用时 33s')
    expect(body.content).toContain('test')
  })

  test('backgroundFoldPanel:含失败 → header 追加「· ❌ M 失败」', () => {
    const older = [
      mk({ id: 'a', status: 'completed', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1000 } }),
      mk({ id: 'b', status: 'failed', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 2000 } }),
    ]
    const panel = backgroundFoldPanel(older, 999999) as any
    expect(panel.header.title.content).toBe('📦 另有 2 项已完成 · ❌ 1 失败')
    expect(panel.elements[0].content).toContain('失败')
  })

  test('backgroundLiveCard:1 running + 3 终态 → running + 最近2 独立 + fold 末位', () => {
    const tasks = [
      mk({ id: 'r', type: 'subagent', description: '跑着', status: 'running', subagentType: 'Explore' }),
      mk({ id: 'a', type: 'shell', description: 'A', status: 'completed', endTime: 1000, usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1000 } }),
      mk({ id: 'b', type: 'shell', description: 'B', status: 'completed', endTime: 2000, usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1000 } }),
      mk({ id: 'c', type: 'shell', description: 'C', status: 'completed', endTime: 3000, usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1000 } }),
    ]
    const card = backgroundLiveCard(tasks, 999999) as any
    const els = card.body.elements
    expect(els).toHaveLength(4)
    expect(els[0].element_id).toBe(BG_ELEMENTS.panel('r'))          // running 在前
    expect(els[1].element_id).toBe(BG_ELEMENTS.panel('c'))          // 最近终态 c
    expect(els[2].element_id).toBe(BG_ELEMENTS.panel('b'))          // 次近 b
    expect(els[3].element_id).toBe('bg_fold')       // fold 恒末位
    expect(els[3].header.title.content).toBe('📦 另有 1 项已完成')   // 只剩 a 被折
  })

  test('backgroundHistoryCard:4 终态 → 最近2 独立 + fold,沉降不再铺开墓碑', () => {
    const tasks = [
      mk({ id: 'a', description: 'A', status: 'completed', endTime: 1000, usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1000 } }),
      mk({ id: 'b', description: 'B', status: 'completed', endTime: 2000, usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1000 } }),
      mk({ id: 'c', description: 'C', status: 'completed', endTime: 3000, usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1000 } }),
      mk({ id: 'd', description: 'D', status: 'completed', endTime: 4000, usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1000 } }),
    ]
    const card = backgroundHistoryCard(tasks, 999999) as any
    expect(card.config.streaming_mode).toBe(false)
    expect(card.config.summary.content).toBe('🧭 子agent(历史) · 4 已结束')
    const els = card.body.elements
    expect(els).toHaveLength(3)
    expect(els[0].element_id).toBe(BG_ELEMENTS.panel('d'))
    expect(els[1].element_id).toBe(BG_ELEMENTS.panel('c'))
    expect(els[2].element_id).toBe('bg_fold')
    expect(els[2].header.title.content).toBe('📦 另有 2 项已完成')
  })

  test('backgroundHistoryCard:单条终态(续跑墓碑)不建 fold', () => {
    const card = backgroundHistoryCard([mk({ id: 'a', status: 'completed', endTime: 1000 })], 999999) as any
    const els = card.body.elements
    expect(els).toHaveLength(1)
    expect(els[0].element_id).toBe(BG_ELEMENTS.panel('a'))
  })

  test('foldSignature:id 列表;成员变才变', () => {
    const a = mk({ id: 'a', status: 'completed' })
    const b = mk({ id: 'b', status: 'completed' })
    expect(foldSignature([a])).toBe('a')
    expect(foldSignature([a, b])).toBe('a,b')
    expect(foldSignature([a, b])).not.toBe(foldSignature([a]))
  })

  test('BG_FOLD_KEEP 默认 = 2', () => {
    expect(BG_FOLD_KEEP).toBe(2)
  })

  test('超长终态摘要按 400 字截断(卡片安全)', () => {
    const oversizedPanel = backgroundTaskPanel(mk({
      id: 'oversized-result', type: 'subagent', description: '检查', status: 'completed',
      summary: `${'完整结果 '.repeat(2000)}结果截断标记`,
    })) as any
    const oversizedBody = oversizedPanel.elements[0].content
    expect(oversizedBody).toContain('📝 完整结果')
    expect(oversizedBody).not.toContain('结果截断标记')
  })
})

describe('promotePendingOnAdvance — 主线程推进判后台', () => {
  test('pending 里的 shell task 在主线程推进时提升到 active,标 isBackgrounded', () => {
    const s0 = applyBgTaskStarted(emptyBgStore(), { task_id: 'b1', task_type: 'local_bash', description: 'codex 出图' })
    expect(s0.active).toHaveLength(0)
    expect(s0.pending).toHaveLength(1)
    const s1 = promotePendingOnAdvance(s0)
    expect(s1.pending).toHaveLength(0)
    expect(s1.active).toHaveLength(1)
    expect(s1.active[0]).toMatchObject({ id: 'b1', isBackgrounded: true, status: 'running' })
  })

  test('空 pending 返回原引用(无推进 no-op)', () => {
    const s = emptyBgStore()
    expect(promotePendingOnAdvance(s)).toBe(s)
  })

  test('多个 pending task 全部提升,active 原有保留', () => {
    let s = applyBgTaskStarted(emptyBgStore(), { task_id: 'b1', task_type: 'local_bash', description: 'a' })
    s = applyBgTaskStarted(s, { task_id: 'b2', task_type: 'local_agent', subagent_type: 'Explore', description: 'b' })
    const r = promotePendingOnAdvance(s)
    expect(r.active).toHaveLength(2)
    expect(r.pending).toHaveLength(0)
    expect(r.active.map(t => t.id).sort()).toEqual(['b1', 'b2'])
    expect(r.active.find(t => t.id === 'b1')?.isBackgrounded).toBe(true)
    expect(r.active.find(t => t.id === 'b2')?.type).toBe('subagent')
  })

  test('前台 task 先结算被从 pending 丢,推进时不会被提', () => {
    // 前台生命周期:started(pending) → settled(从 pending 丢);主线程推进时 pending 已空
    let s = applyBgTaskStarted(emptyBgStore(), { task_id: 'f1', task_type: 'local_bash', description: 'echo' })
    s = applyBgTaskSettled(s, { task_id: 'f1', status: 'completed' })
    expect(s.pending).toHaveLength(0)
    const r = promotePendingOnAdvance(s)
    expect(r.active).toHaveLength(0)
  })
})

describe('已结算 agent 档案 — warm-resume 复活(SendMessage 续跑不重发 task_started)', () => {
  // 2026-07-08 事故:pokemon 群 SendMessage 热续跑已完成的工程师,SDK 只在最终
  // 完成时来一条 task_notification;卡沉降清池后全命中 unknown no-op → 续跑全程
  // 隐形。档案在清池时留下 agent「名片」,unknown 事件命中档案即复活。
  test('archiveTerminalAgents 只收终态 subagent,shell/运行中不入', () => {
    const tasks: BgTaskEntry[] = [
      mk({ id: 'a1', status: 'completed', type: 'subagent', subagentType: 'client-engineer', toolUseId: 'tu1', description: '稀有度下沉' }),
      mk({ id: 'a2', status: 'running', type: 'subagent' }),
      mk({ id: 'b1', status: 'completed', type: 'shell' }),
    ]
    const archive = archiveTerminalAgents([], tasks)
    expect(archive).toHaveLength(1)
    expect(archive[0]).toMatchObject({ id: 'a1', toolUseId: 'tu1', subagentType: 'client-engineer', description: '稀有度下沉' })
  })

  test('同 id 去重取最新;超 cap 丢最旧', () => {
    let archive: BgArchiveEntry[] = [{ id: 'a1', description: '旧描述' }]
    archive = archiveTerminalAgents(archive, [mk({ id: 'a1', status: 'completed', type: 'subagent', description: '新描述' })])
    expect(archive).toHaveLength(1)
    expect(archive[0].description).toBe('新描述')

    const many = Array.from({ length: 5 }, (_, i) =>
      mk({ id: `t${i}`, status: 'completed', type: 'subagent', description: `d${i}` }))
    const capped = archiveTerminalAgents([], many, 3)
    expect(capped.map(a => a.id)).toEqual(['t2', 't3', 't4'])
  })

  test('resurrectRunning 命中 → resumed running 条目(保留 toolUseId 供 steps 归属);未命中 → null', () => {
    const archive: BgArchiveEntry[] = [{ id: 'a1', toolUseId: 'tu1', subagentType: 'client-engineer', description: '稀有度下沉' }]
    const entry = resurrectRunning(archive, 'a1', 5000)
    expect(entry).toMatchObject({
      id: 'a1', type: 'subagent', subagentType: 'client-engineer', toolUseId: 'tu1',
      status: 'running', startedAt: 5000, resumed: true, isBackgrounded: true, steps: [],
    })
    expect(resurrectRunning(archive, 'ghost', 5000)).toBeNull()
  })

  test('resurrectSettled 命中 → 终态墓碑(status 映射 + usage/summary);未命中 → null', () => {
    const archive: BgArchiveEntry[] = [{ id: 'a1', subagentType: 'client-engineer', description: '稀有度下沉' }]
    const usage = { total_tokens: 100, tool_uses: 3, duration_ms: 360_000 }
    const entry = resurrectSettled(archive, { task_id: 'a1', status: 'completed', usage, summary: '终版diff' }, 9000)
    expect(entry).toMatchObject({
      id: 'a1', type: 'subagent', status: 'completed', resumed: true,
      usage, summary: '终版diff', endTime: 9000,
    })
    expect(resurrectSettled(archive, { task_id: 'a1', status: 'failed' }, 9000)!.status).toBe('failed')
    expect(resurrectSettled(archive, { task_id: 'a1', status: 'stopped' }, 9000)!.status).toBe('killed')
    expect(resurrectSettled(archive, { task_id: 'ghost', status: 'completed' }, 9000)).toBeNull()
  })

  test('panel 标题给续跑条目标「(续跑)」', () => {
    const t = mk({ id: 'a1', status: 'running', type: 'subagent', subagentType: 'client-engineer', resumed: true })
    const panel = backgroundTaskPanel(t, 1000) as any
    expect(panel.header.title.content).toContain('client-engineer(续跑)')
  })
})

describe('briefResult 内容块归一(上游 722e45a:后台工具返回内容块不再 .replace 崩)', () => {
  test('字符串仍按空白归一(既有语义)', () => {
    let s: BgStore = { active: [mk({ id: 't1', toolUseId: 'p', status: 'running' })], pending: [] }
    s = applyBgToolUse(s, 'p', 'tu', 'Bash', { command: 'ls' })
    s = applyBgToolResult(s, 'p', 'tu', '  命中\n\t3   处  ', false)
    expect(s.active[0].steps[0].brief).toContain('→ 命中 3 处')
  })

  test('内容块数组:文本块拼接,非文本块退化为 JSON 摘要,不抛', () => {
    let s: BgStore = { active: [mk({ id: 't1', toolUseId: 'p', status: 'running' })], pending: [] }
    s = applyBgToolUse(s, 'p', 'tu', 'Read', { file_path: '/x' })
    s = applyBgToolResult(s, 'p', 'tu', [
      { type: 'text', text: 'DSH 内容块第一段' },
      { type: 'text', text: '第二段' },
    ], false)
    expect(s.active[0].steps[0].brief).toContain('DSH 内容块第一段 第二段')
  })

  test('非法形状(undefined/null/数字/对象)不抛且摘要非空', () => {
    const cases: unknown[] = [undefined, null, 42, { nested: { a: 1 } }, [{ type: 'image', source: { data: 'x' } }]]
    for (const content of cases) {
      let s: BgStore = { active: [mk({ id: 't1', toolUseId: 'p', status: 'running' })], pending: [] }
      s = applyBgToolUse(s, 'p', 'tu', 'Bash', { command: 'ls' })
      s = applyBgToolResult(s, 'p', 'tu', content as any, false)
      const brief = s.active[0].steps[0].brief
      expect(brief).toContain('→')
      expect(brief.split('→')[1]!.trim().length).toBeGreaterThan(0)
    }
  })

  test('错误态:内容块输入仍带 ❌ 前缀', () => {
    let s: BgStore = { active: [mk({ id: 't1', toolUseId: 'p', status: 'running' })], pending: [] }
    s = applyBgToolUse(s, 'p', 'tu', 'Bash', { command: 'ls' })
    s = applyBgToolResult(s, 'p', 'tu', [{ type: 'text', text: 'blocked by sandbox' }], true)
    expect(s.active[0].steps[0].brief).toContain('❌')
    expect(s.active[0].steps[0].brief).toContain('blocked by sandbox')
  })
})

describe('background element ids for UUID task ids', () => {
  test('codex agent thread UUID maps to cardkit-legal short element id (<=20 chars, stable)', () => {
    const uuid = '01a01228-ebc1-7593-95b3-3175513ed9a4'
    const panel = BG_ELEMENTS.panel(uuid)
    const body = BG_ELEMENTS.body(uuid)
    // 飞书规则:字母开头、字母数字下划线、<=20 字符
    expect(panel).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*$/)
    expect(panel.length).toBeLessThanOrEqual(20)
    expect(body.length).toBeLessThanOrEqual(20)
    // 稳定:同 id 同 hash;不同 id 不同 hash(此样本对)
    expect(BG_ELEMENTS.panel(uuid)).toBe(panel)
    expect(BG_ELEMENTS.panel('01a01228-ebc1-7593-95b3-3175513ed9a5')).not.toBe(panel)
  })
})
