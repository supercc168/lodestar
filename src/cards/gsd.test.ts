import { describe, expect, test } from 'bun:test'

import type { GsdSnapshot } from '../gsd-store'
import { gsdPanelCard } from './gsd'
import { ELEMENTS } from './elements'

function snap(partial: Partial<GsdSnapshot> = {}): GsdSnapshot {
  return {
    status: '运行中',
    taskSlug: 'demo-task',
    taskName: 'Demo Task',
    phase: 'execute',
    updatedAt: '2026-07-20T00:00:00.000Z',
    planningPath: '.gsd/demo-task/.planning/',
    note: '',
    bridge: { ok: true, kind: 'symlink', target: '.gsd/demo-task/.planning' },
    ...partial,
  }
}

describe('gsd panel card rendering', () => {
  test('renders status fields, provider, and all gsd_* kinds', () => {
    const card = gsdPanelCard({
      snapshot: snap(),
      providerLabel: 'claude',
      panelGen: 'gen-1',
    }) as any

    const json = JSON.stringify(card)
    expect(card.schema).toBe('2.0')
    expect(card.config.update_multi).toBe(true)
    expect(json).toContain('Demo Task')
    expect(json).toContain('demo-task')
    expect(json).toContain('运行中')
    expect(json).toContain('execute')
    expect(json).toContain('claude')
    expect(json).toContain(ELEMENTS.gsdPanel)
    expect(json).toContain('gsd_refresh')
    expect(json).toContain('gsd_continue')
    expect(json).toContain('gsd_pause')
    expect(json).toContain('gsd_complete')
    expect(json).toContain('gsd_new_prompt')
    expect(json).toContain('进度')
    expect(json).toContain('继续')
    expect(json).toContain('暂停')
    expect(json).toContain('完成')
    expect(json).toContain('新任务')
    expect(json).toContain('gen-1')
    expect(json).toContain('OK')
  })

  test('includes notice and awaitingName prompt', () => {
    const card = gsdPanelCard({
      snapshot: snap({ status: '无任务', taskSlug: '', taskName: '' }),
      providerLabel: 'codex',
      panelGen: 'gen-2',
      notice: { type: 'info', content: '请发送任务名' },
      awaitingName: true,
    }) as any

    const json = JSON.stringify(card)
    expect(json).toContain('请发送任务名')
    expect(json).toContain('等待任务名')
    expect(json).toContain('无任务')
    expect(json).toContain('gsd_new_prompt')
  })

  test('reports bridge unhealthy', () => {
    const card = gsdPanelCard({
      snapshot: snap({
        bridge: { ok: false, kind: 'missing' },
      }),
      providerLabel: 'claude',
      panelGen: 'gen-3',
    }) as any

    const json = JSON.stringify(card)
    expect(json).toContain('缺失')
  })

  test('renders plan progress bar, current plan, and cursor when showProgress', () => {
    const card = gsdPanelCard({
      snapshot: snap({
        phase: 'execute',
        phaseHint: 'execute',
        progress: {
          completedPlans: 2,
          totalPlans: 5,
          completedPhases: 1,
          totalPhases: 3,
          percent: 40,
          currentPlan: '03-PLAN.md — wire GSD panel',
          nextAction: 'run bun test src/cards/gsd.test.ts',
          cursor: {
            cursor: '04/F',
            item: 'assert panel progress lines',
            status: 'RED',
          },
        },
      }),
      providerLabel: 'claude',
      panelGen: 'gen-4',
      showProgress: true,
    }) as any

    const json = JSON.stringify(card)
    expect(json).toContain('2/5')
    expect(json).toContain('40%')
    expect(json).toContain('1/3')
    expect(json).toContain('03-PLAN.md')
    expect(json).toContain('[GSD 04/F]')
    expect(json).toContain('RED')
    expect(json).toContain('下一步')
    // phaseHint equal to phase should not be duplicated
    expect(json).not.toMatch(/execute` \/ `execute/)
  })

  test('omits progress lines when snapshot has no progress', () => {
    const card = gsdPanelCard({
      snapshot: snap({ progress: undefined }),
      providerLabel: 'claude',
      panelGen: 'gen-5',
      showProgress: true,
    }) as any
    const json = JSON.stringify(card)
    expect(json).not.toContain('计划：')
    expect(json).not.toContain('游标：')
    expect(json).not.toContain('下一步：')
  })

  test('hides plan/cursor detail unless showProgress and status is 运行中', () => {
    const progress = {
      completedPlans: 2,
      totalPlans: 5,
      completedPhases: 1,
      totalPhases: 3,
      percent: 40,
      currentPlan: '03-PLAN.md',
      nextAction: 'wire panel',
      cursor: { cursor: '04/F', item: 'assert', status: 'RED' },
    }

    // Disk running but session not executing GSD → no fine progress.
    const idleRunning = gsdPanelCard({
      snapshot: snap({ status: '运行中', progress }),
      providerLabel: 'claude',
      panelGen: 'gen-idle-running',
      showProgress: false,
    }) as any
    expect(JSON.stringify(idleRunning)).not.toContain('2/5')
    expect(JSON.stringify(idleRunning)).not.toContain('[GSD 04/F]')

    for (const status of ['已暂停', '已完成', '无任务'] as const) {
      const card = gsdPanelCard({
        snapshot: snap({ status, progress }),
        providerLabel: 'claude',
        panelGen: `gen-${status}`,
        showProgress: true,
      }) as any
      const json = JSON.stringify(card)
      expect(json).toContain(status)
      expect(json).not.toContain('2/5')
      expect(json).not.toContain('计划：')
      expect(json).not.toContain('游标：')
      expect(json).not.toContain('下一步：')
      expect(json).not.toContain('[GSD 04/F]')
    }

    const running = gsdPanelCard({
      snapshot: snap({ status: '运行中', progress }),
      providerLabel: 'claude',
      panelGen: 'gen-running',
      showProgress: true,
    }) as any
    const runningJson = JSON.stringify(running)
    expect(runningJson).toContain('2/5')
    expect(runningJson).toContain('[GSD 04/F]')
  })
})
