// src/gsd-store.test.ts — key cases
import { expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import {
  createAndActivateTask,
  pauseActiveTask,
  completeActiveTask,
  resumeActiveTask,
  slugifyTaskName,
  parseStateProgress,
  readGsdSnapshot,
} from './gsd-store'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gsd-store-'))
  mkdirSync(join(root, '.gsd'), { recursive: true })
  writeFileSync(join(root, '.gsd', 'TRACKER.md'), `# GSD 任务跟踪

## 当前活跃任务

- 状态：无任务
- task_slug：
- 任务名称：
- 当前阶段：unknown
- 最后更新：
- planning_path：
- 备注：

## 任务索引

| task_slug | 名称 | 状态 | 创建时间 | 最后更新 |
|-----------|------|------|----------|----------|
`)
  execSync('git init', { cwd: join(root, '.gsd') })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

test('slugifyTaskName kebab', () => {
  expect(slugifyTaskName('Watchdog 恢复 边界')).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  expect(slugifyTaskName('Watchdog 恢复 边界')).toBe('watchdog')
  expect(slugifyTaskName('Hello World')).toBe('hello-world')
})

test('slugifyTaskName pure CJK uses stable t- hash slug', () => {
  const a = slugifyTaskName('飞书面板恢复')
  const b = slugifyTaskName('任务跟踪优化')
  expect(a).toMatch(/^t-[0-9a-f]{8}$/)
  expect(b).toMatch(/^t-[0-9a-f]{8}$/)
  expect(a).not.toBe(b)
  // Same name → same slug (collision-resistant identity, not random).
  expect(slugifyTaskName('飞书面板恢复')).toBe(a)
  // Must not collapse pure CJK to generic `task`.
  expect(a).not.toBe('task')
  expect(b).not.toBe('task')
})

test('createAndActivateTask sets running and bridge', () => {
  const snap = createAndActivateTask(root, 'Demo Task')
  expect(snap.status).toBe('运行中')
  expect(snap.taskSlug.length).toBeGreaterThan(0)
  expect(snap.bridge.ok).toBe(true)
  const tracker = readFileSync(join(root, '.gsd', 'TRACKER.md'), 'utf8')
  expect(tracker).toContain('状态：运行中')
  expect(readFileSync(join(root, '.gsd', snap.taskSlug, 'TASK.md'), 'utf8')).toContain('Demo Task')
})

test('second create pauses previous', () => {
  const a = createAndActivateTask(root, 'Alpha')
  const b = createAndActivateTask(root, 'Beta')
  expect(b.status).toBe('运行中')
  expect(b.taskSlug).not.toBe(a.taskSlug)
  const alphaTask = readFileSync(join(root, '.gsd', a.taskSlug, 'TASK.md'), 'utf8')
  expect(alphaTask).toMatch(/已暂停|暂停/)
})

test('pause and complete', () => {
  createAndActivateTask(root, 'X')
  expect(pauseActiveTask(root).status).toBe('已暂停')
  expect(completeActiveTask(root).status).toBe('已完成')
})

test('resume 已暂停 → 运行中; complete from 已暂停 allowed', () => {
  const created = createAndActivateTask(root, 'Resume Me')
  expect(pauseActiveTask(root).status).toBe('已暂停')

  const resumed = resumeActiveTask(root)
  expect(resumed.status).toBe('运行中')
  expect(resumed.taskSlug).toBe(created.taskSlug)
  expect(resumed.bridge.ok).toBe(true)

  expect(pauseActiveTask(root).status).toBe('已暂停')
  expect(completeActiveTask(root).status).toBe('已完成')
  // resume no-ops on completed
  expect(resumeActiveTask(root).status).toBe('已完成')
})

test('pause after complete does not rewrite to 已暂停', () => {
  const snap = createAndActivateTask(root, 'Done Task')
  expect(completeActiveTask(root).status).toBe('已完成')

  const afterPause = pauseActiveTask(root)
  expect(afterPause.status).toBe('已完成')
  expect(afterPause.taskSlug).toBe(snap.taskSlug)

  const tracker = readFileSync(join(root, '.gsd', 'TRACKER.md'), 'utf8')
  expect(tracker).toContain('状态：已完成')
  expect(tracker).not.toMatch(/状态：已暂停/)
  const task = readFileSync(join(root, '.gsd', snap.taskSlug, 'TASK.md'), 'utf8')
  expect(task).toMatch(/状态:\s*已完成/)
  expect(task).not.toMatch(/状态:\s*已暂停/)
})

test('parseStateProgress reads frontmatter plans, body scalars, and cursor', () => {
  const state = `---
gsd_state_version: '1.0'
status: in_progress
progress:
  total_phases: 3
  completed_phases: 1
  total_plans: 5
  completed_plans: 2
  percent: 40
---

# Project State

- current_phase: execute
- current_plan: 03-PLAN.md
- next_action: implement panel progress

## 单向执行游标

| 游标 | 项 | 状态 |
|------|----|------|
| 03/A | scaffold | GREEN |
| 03/B | wire card | 已验证 |
| 04/F | assert panel | RED |
| 05/A | docs | pending |
`

  const p = parseStateProgress(state)
  expect(p).toBeDefined()
  expect(p!.totalPlans).toBe(5)
  expect(p!.completedPlans).toBe(2)
  expect(p!.totalPhases).toBe(3)
  expect(p!.completedPhases).toBe(1)
  expect(p!.percent).toBe(40)
  expect(p!.currentPlan).toBe('03-PLAN.md')
  expect(p!.nextAction).toBe('implement panel progress')
  expect(p!.cursor).toEqual({
    cursor: '04/F',
    item: 'assert panel',
    status: 'RED',
  })
})

test('parseStateProgress body Plan of / Progress % fallbacks', () => {
  const state = `# Project State

Phase: 2 of 4 (Execute)
Plan: 3 of 7 in current phase
Status: In progress
Progress: [████░░░░░░] 40%
`
  const p = parseStateProgress(state)
  expect(p).toBeDefined()
  // "Plan 3 of 7" → completed ~2, total 7
  expect(p!.totalPlans).toBe(7)
  expect(p!.completedPlans).toBe(2)
  expect(p!.percent).toBe(40)
})

test('parseStateProgress returns undefined on empty state', () => {
  expect(parseStateProgress('# empty\n')).toBeUndefined()
})

test('parseStateProgress drops illegal plan counters', () => {
  const state = `---
progress:
  total_plans: 2
  completed_plans: 9
---
`
  const p = parseStateProgress(state)
  // illegal 9/2 dropped; no other fields → undefined
  expect(p).toBeUndefined()
})

test('readGsdSnapshot surfaces STATE progress via bridge', () => {
  const created = createAndActivateTask(root, 'Progress Panel')
  writeFileSync(
    join(root, '.gsd', created.taskSlug, '.planning', 'STATE.md'),
    `---
status: in_progress
progress:
  total_phases: 2
  completed_phases: 0
  total_plans: 4
  completed_plans: 1
  percent: 25
---

- current_phase: plan
- current_plan: 02-PLAN.md
- next_action: write tests

## 单向执行游标

| 游标 | 项 | 状态 |
|------|----|------|
| 02/A | draft | GREEN |
| 02/B | implement | RED |
`,
  )

  const snap = readGsdSnapshot(root)
  expect(snap.taskSlug).toBe(created.taskSlug)
  expect(snap.phaseHint).toBe('plan')
  expect(snap.progress).toBeDefined()
  expect(snap.progress!.completedPlans).toBe(1)
  expect(snap.progress!.totalPlans).toBe(4)
  expect(snap.progress!.percent).toBe(25)
  expect(snap.progress!.currentPlan).toBe('02-PLAN.md')
  expect(snap.progress!.cursor?.cursor).toBe('02/B')
  expect(snap.progress!.cursor?.status).toBe('RED')
})

test('create rolls back previous task when bridge switch fails', () => {
  const prev = createAndActivateTask(root, 'Keep Running')
  // Real non-link .planning forces switchActivePlanning to throw on Unix.
  rmSync(join(root, '.planning'), { recursive: true, force: true })
  mkdirSync(join(root, '.planning'), { recursive: true })
  writeFileSync(join(root, '.planning', 'STATE.md'), 'phase: blocked\n')

  expect(() => createAndActivateTask(root, 'Should Fail')).toThrow(
    /\.planning exists and is not a symlink/,
  )

  const tracker = readFileSync(join(root, '.gsd', 'TRACKER.md'), 'utf8')
  expect(tracker).toContain('状态：运行中')
  expect(tracker).toContain(`task_slug：${prev.taskSlug}`)
  expect(tracker).not.toContain('Should Fail')
  expect(tracker).not.toContain('should-fail')

  const prevTask = readFileSync(join(root, '.gsd', prev.taskSlug, 'TASK.md'), 'utf8')
  expect(prevTask).toMatch(/状态:\s*运行中/)
  expect(prevTask).not.toMatch(/状态:\s*已暂停/)

  // Incomplete new task dir must not remain after failed create.
  expect(existsSync(join(root, '.gsd', 'should-fail'))).toBe(false)
})
