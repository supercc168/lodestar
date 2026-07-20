import { describe, expect, test } from 'bun:test'
import { buildGsdInjectPrompt } from './gsd-prompt'

test('prompt forces yiui-gsd and bans old planners', () => {
  const p = buildGsdInjectPrompt({
    action: 'continue',
    taskSlug: 'demo',
    taskName: 'Demo',
    provider: 'claude',
  })
  expect(p).toContain('[Lodestar GSD]')
  expect(p).toContain('yiui-gsd')
  expect(p).toContain('demo')
  expect(p).toMatch(/superpowers|OMC|ralplan/i)
  expect(p).toContain('TRACKER')
})

test('new-task-discuss action line differs from continue', () => {
  const cont = buildGsdInjectPrompt({
    action: 'continue',
    taskSlug: 'a',
    taskName: 'A',
    provider: 'codex',
  })
  const neu = buildGsdInjectPrompt({
    action: 'new-task-discuss',
    taskSlug: 'b',
    taskName: 'B',
    provider: 'codex',
  })
  expect(cont).toContain('当前动作: continue')
  expect(neu).toContain('当前动作: new-task-discuss')
  expect(neu).toContain('provider: codex')
  expect(neu).toContain('task_slug: b')
  expect(neu).toContain('任务名: B')
})
