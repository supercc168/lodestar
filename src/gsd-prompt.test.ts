import { describe, expect, test } from 'bun:test'
import {
  buildGsdInjectPrompt,
  GSD_INJECT_PREFIX,
  isGsdInjectPrompt,
  parseGsdInjectTaskSlug,
} from './gsd-prompt'

test('prompt forces yiui-gsd and bans old planners', () => {
  const p = buildGsdInjectPrompt({
    action: 'continue',
    taskSlug: 'demo',
    taskName: 'Demo',
    provider: 'claude',
  })
  expect(p).toContain(GSD_INJECT_PREFIX)
  expect(p).toContain('yiui-gsd')
  expect(p).toContain('demo')
  expect(p).toMatch(/superpowers|OMC|ralplan/i)
  expect(p).toContain('TRACKER')
  expect(p).toContain('.gsd/demo/.planning/STATE.md')
  expect(p).toContain('.planning/workstreams/demo')
  expect(p).toContain('--ws demo')
  expect(p).toContain('聚合索引')
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

test('isGsdInjectPrompt / parseGsdInjectTaskSlug', () => {
  const p = buildGsdInjectPrompt({
    action: 'continue',
    taskSlug: 'wire-panel',
    taskName: 'Wire',
    provider: 'claude',
  })
  expect(isGsdInjectPrompt(p)).toBe(true)
  expect(isGsdInjectPrompt(`  ${p}`)).toBe(true)
  expect(isGsdInjectPrompt('继续 gsd')).toBe(false)
  expect(isGsdInjectPrompt('')).toBe(false)
  expect(parseGsdInjectTaskSlug(p)).toBe('wire-panel')
  expect(parseGsdInjectTaskSlug('no slug here')).toBe('')
})
