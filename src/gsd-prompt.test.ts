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
    model: 'claude:glm',
    effort: 'xhigh',
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
  expect(p).toContain('provider=claude')
  expect(p).toContain('model=claude:glm')
  expect(p).toContain('effort=xhigh')
  expect(p).toContain('禁止切换 provider')
  expect(p).toContain('第一方 heavy/standard=飞书当前主力')
  expect(p).toContain('light=Sonnet 5')
  expect(p).toContain('选 Opus 不注入 Fable')
  expect(p).toContain('第三方 API 路由的所有 alias 锁回当前 model=claude:glm')
  expect(p).toContain('外部 AI CLI')
  expect(p).toContain('不要在收到 research/planner/checker 报告后完整重做')
  expect(p).toContain('不启动 executor 子 agent')
  expect(p).toContain('不得因超时重复派发')
})

test('new-task-discuss action line differs from continue', () => {
  const cont = buildGsdInjectPrompt({
    action: 'continue',
    taskSlug: 'a',
    taskName: 'A',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'max',
  })
  const neu = buildGsdInjectPrompt({
    action: 'new-task-discuss',
    taskSlug: 'b',
    taskName: 'B',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'max',
  })
  expect(cont).toContain('当前动作: continue')
  expect(neu).toContain('当前动作: new-task-discuss')
  expect(neu).toContain('provider: codex')
  expect(neu).toContain('model: gpt-5.6-sol')
  expect(neu).toContain('effort: max')
  expect(neu).toContain('task_slug: b')
  expect(neu).toContain('任务名: B')
  expect(neu).toContain('Codex 子 agent 按 yiui-gsd 分层 bake')
  expect(neu).toContain('gpt-5.6-sol+max')
  expect(neu).toContain('gpt-5.6-terra+high')
  expect(neu).toContain('gpt-5.6-luna+medium')
})

test('isGsdInjectPrompt / parseGsdInjectTaskSlug', () => {
  const p = buildGsdInjectPrompt({
    action: 'continue',
    taskSlug: 'wire-panel',
    taskName: 'Wire',
    provider: 'claude',
    model: 'claude:opus',
    effort: 'max',
  })
  expect(isGsdInjectPrompt(p)).toBe(true)
  expect(isGsdInjectPrompt(`  ${p}`)).toBe(true)
  expect(isGsdInjectPrompt('继续 gsd')).toBe(false)
  expect(isGsdInjectPrompt('')).toBe(false)
  expect(parseGsdInjectTaskSlug(p)).toBe('wire-panel')
  expect(parseGsdInjectTaskSlug('no slug here')).toBe('')
})
