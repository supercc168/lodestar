// src/gsd-store.test.ts — key cases
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import {
  createAndActivateTask,
  pauseActiveTask,
  completeActiveTask,
  readGsdSnapshot,
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
