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
