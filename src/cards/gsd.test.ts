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
})
