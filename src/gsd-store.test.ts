import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertGsdFinalizationComplete,
  completeGsdTask,
  createAndActivateTask,
  parseStateProgress,
  pauseGsdTask,
  readGsdSnapshot,
  readGsdTaskSummaries,
  resumeGsdTask,
  selectGsdTask,
  slugifyTaskName,
} from './gsd-store'

let root: string

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: join(root, '.gsd'),
    encoding: 'utf8',
  })
}

function initGsdGit(): void {
  mkdirSync(join(root, '.gsd'), { recursive: true })
  git(['init', '-q'])
  git(['config', 'user.email', 'gsd-store-test@example.invalid'])
  git(['config', 'user.name', 'GSD Store Test'])
}

function writePassingState(slug: string, phase = 'verify'): void {
  const planning = join(root, '.gsd', slug, '.planning')
  mkdirSync(planning, { recursive: true })
  writeFileSync(join(planning, 'STATE.md'), [
    '---',
    'status: in_progress',
    'last_updated: "2026-07-21T00:00:00Z"',
    'progress:',
    '  total_phases: 2',
    '  completed_phases: 2',
    '  total_plans: 2',
    '  completed_plans: 2',
    '  percent: 100',
    'finalization:',
    '  change_generation: 2',
    '  reviewed_generation: 2',
    '  scope_frozen: true',
    '  blocking_findings: 0',
    '  final_verified_generation: 2',
    '  final_verification_runs: 1',
    '---',
    '',
    '- current_phase: ' + phase,
    '- current_plan: 02-PLAN.md',
    '- next_action: complete task',
    '',
  ].join('\n'))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gsd-store-'))
  initGsdGit()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('slugifyTaskName keeps ASCII and hashes pure CJK deterministically', () => {
  expect(slugifyTaskName('Hello World')).toBe('hello-world')
  expect(slugifyTaskName('Watchdog 恢复 边界')).toBe('watchdog')
  const first = slugifyTaskName('飞书面板恢复')
  expect(first).toMatch(/^t-[0-9a-f]{8}$/)
  expect(slugifyTaskName('飞书面板恢复')).toBe(first)
  expect(slugifyTaskName('任务跟踪优化')).not.toBe(first)
})

test('multiple tasks remain running and selection is not stored in TRACKER', () => {
  const alpha = createAndActivateTask(root, 'Alpha')
  const beta = createAndActivateTask(root, 'Beta')

  expect(readGsdSnapshot(root).status).toBe('无任务')
  expect(readGsdSnapshot(root).taskSlug).toBe('')
  expect(readGsdTaskSummaries(root).map(task => [task.taskSlug, task.status])).toEqual([
    [beta.taskSlug, '运行中'],
    [alpha.taskSlug, '运行中'],
  ])
  expect(readGsdSnapshot(root, alpha.taskSlug).status).toBe('运行中')
  expect(readGsdSnapshot(root, beta.taskSlug).status).toBe('运行中')

  const tracker = readFileSync(join(root, '.gsd', 'TRACKER.md'), 'utf8')
  expect(tracker).toContain('## 未完成任务')
  expect(tracker).not.toContain('## 当前活跃任务')
  expect(tracker).toContain('| alpha | Alpha | generic | 运行中 |')
  expect(tracker).toContain('| beta | Beta | generic | 运行中 |')
})

test('selection creates stable workstream routes and a shared PROJECT hard link', () => {
  const alpha = createAndActivateTask(root, 'Alpha')
  const beta = createAndActivateTask(root, 'Beta')
  const selected = selectGsdTask(root, alpha.taskSlug)

  expect(selected.taskSlug).toBe(alpha.taskSlug)
  expect(selected.bridge.ok).toBe(true)
  expect(existsSync(join(root, '.planning', 'workstreams', alpha.taskSlug))).toBe(true)
  expect(existsSync(join(root, '.planning', 'workstreams', beta.taskSlug))).toBe(true)
  const canonical = statSync(join(root, '.gsd', 'PROJECT.md'))
  const route = statSync(join(root, '.planning', 'PROJECT.md'))
  expect(route.dev).toBe(canonical.dev)
  expect(route.ino).toBe(canonical.ino)
})

test('selection rejects an invalid client-supplied slug before store writes', () => {
  expect(existsSync(join(root, '.gsd', 'TRACKER.md'))).toBe(false)
  expect(() => selectGsdTask(root, '../outside')).toThrow(/invalid GSD task slug/)
  expect(existsSync(join(root, '.gsd', 'TRACKER.md'))).toBe(false)
  expect(existsSync(join(root, 'outside'))).toBe(false)
})

test('pause and resume mutate only the requested task', () => {
  const alpha = createAndActivateTask(root, 'Alpha')
  const beta = createAndActivateTask(root, 'Beta')

  expect(pauseGsdTask(root, alpha.taskSlug).status).toBe('已暂停')
  expect(readGsdSnapshot(root, beta.taskSlug).status).toBe('运行中')
  expect(resumeGsdTask(root, alpha.taskSlug).status).toBe('运行中')
  expect(readGsdSnapshot(root, beta.taskSlug).status).toBe('运行中')
})

test('completion requires finalization and removes only that task from TRACKER', () => {
  const alpha = createAndActivateTask(root, 'Alpha')
  const beta = createAndActivateTask(root, 'Beta')
  expect(() => completeGsdTask(root, alpha.taskSlug)).toThrow(/完成门禁|STATE\.md/)

  writePassingState(alpha.taskSlug)
  assertGsdFinalizationComplete(root, alpha.taskSlug)
  const completed = completeGsdTask(root, alpha.taskSlug)
  expect(completed.status).toBe('已完成')
  expect(readGsdSnapshot(root, beta.taskSlug).status).toBe('运行中')
  expect(existsSync(join(root, '.gsd', alpha.taskSlug, 'TASK.md'))).toBe(true)

  const tracker = readFileSync(join(root, '.gsd', 'TRACKER.md'), 'utf8')
  expect(tracker).not.toContain('| alpha |')
  expect(tracker).toContain('| beta |')
})

test('scoped commit does not absorb another task working-tree change', () => {
  const alpha = createAndActivateTask(root, 'Alpha')
  const beta = createAndActivateTask(root, 'Beta')
  const alphaTask = join(root, '.gsd', alpha.taskSlug, 'TASK.md')
  writeFileSync(alphaTask, readFileSync(alphaTask, 'utf8').replace('- 简述:', '- 简述: local-only'))

  pauseGsdTask(root, beta.taskSlug)

  expect(git(['status', '--short'])).toContain(' M alpha/TASK.md')
  expect(git(['show', 'HEAD:alpha/TASK.md'])).not.toContain('local-only')
  expect(readFileSync(join(root, '.gsd', 'TRACKER.md'), 'utf8')).not.toContain('local-only')
})

test('pre-staged files abort a targeted write before task mutation', () => {
  const alpha = createAndActivateTask(root, 'Alpha')
  const beta = createAndActivateTask(root, 'Beta')
  const alphaTask = join(root, '.gsd', alpha.taskSlug, 'TASK.md')
  writeFileSync(alphaTask, readFileSync(alphaTask, 'utf8').replace('- 简述:', '- 简述: staged'))
  git(['add', '--', alpha.taskSlug])

  expect(() => pauseGsdTask(root, beta.taskSlug)).toThrow(/index must be empty/)
  expect(readGsdSnapshot(root, beta.taskSlug).status).toBe('运行中')
})

test('reinitialization refuses to absorb an unstaged shared PROJECT draft', () => {
  const alpha = createAndActivateTask(root, 'Alpha')
  const project = join(root, '.gsd', 'PROJECT.md')
  writeFileSync(project, '# user draft\n')

  expect(() => selectGsdTask(root, alpha.taskSlug)).toThrow(/managed files must be clean/)
  expect(readFileSync(project, 'utf8')).toBe('# user draft\n')
  expect(git(['show', 'HEAD:PROJECT.md'])).not.toContain('user draft')
})

test('invalid task input is rejected before repository initialization', () => {
  rmSync(join(root, '.gsd'), { recursive: true, force: true })

  expect(() => createAndActivateTask(root, '   ')).toThrow(/任务名称/)
  expect(existsSync(join(root, '.gsd'))).toBe(false)
})

test('first write migrates a legacy active TRACKER to the aggregate schema', () => {
  const slug = 'legacy-task'
  mkdirSync(join(root, '.gsd', slug, '.planning'), { recursive: true })
  writeFileSync(join(root, '.gsd', slug, 'TASK.md'), [
    '# Legacy Task',
    '',
    '- task_slug: legacy-task',
    '- 任务类型: generic',
    '- 状态: 运行中',
    '- 创建时间: old',
    '- 最后更新: old',
    '- 简述: migrate me',
    '',
    '## 备注',
    '',
  ].join('\n'))
  writeFileSync(join(root, '.gsd', 'TRACKER.md'), [
    '# GSD 任务跟踪',
    '',
    '## 当前活跃任务',
    '',
    '- 状态：运行中',
    '- task_slug：legacy-task',
    '- 任务名称：Legacy Task',
    '- 当前阶段：execute',
    '- 最后更新：old',
    '- planning_path：.gsd/legacy-task/.planning/',
    '- 备注：',
    '',
    '## 任务索引',
    '',
    '| task_slug | 名称 | 状态 | 创建时间 | 最后更新 |',
    '|-----------|------|------|----------|----------|',
    '| legacy-task | Legacy Task | 运行中 | old | old |',
    '',
  ].join('\n'))
  git(['add', '.'])
  git(['commit', '-qm', 'legacy fixture'])

  expect(readGsdSnapshot(root).taskSlug).toBe(slug)
  pauseGsdTask(root, slug)
  const tracker = readFileSync(join(root, '.gsd', 'TRACKER.md'), 'utf8')
  expect(tracker).toContain('## 未完成任务')
  expect(tracker).not.toContain('## 当前活跃任务')
  expect(tracker).toContain('| legacy-task | Legacy Task | generic | 已暂停 |')
})

test('parseStateProgress reads frontmatter counters and first unfinished cursor', () => {
  const state = [
    '---',
    'progress:',
    '  total_phases: 3',
    '  completed_phases: 1',
    '  total_plans: 5',
    '  completed_plans: 2',
    '  percent: 40',
    '---',
    '',
    '- current_plan: 03-PLAN.md',
    '- next_action: implement panel',
    '',
    '## 单向执行游标',
    '',
    '| 游标 | 项 | 状态 |',
    '|---|---|---|',
    '| 03/A | scaffold | GREEN |',
    '| 03/B | wire card | RED |',
  ].join('\n')
  expect(parseStateProgress(state)).toEqual({
    completedPlans: 2,
    totalPlans: 5,
    completedPhases: 1,
    totalPhases: 3,
    percent: 40,
    currentPlan: '03-PLAN.md',
    nextAction: 'implement panel',
    cursor: { cursor: '03/B', item: 'wire card', status: 'RED' },
  })
})

test('parseStateProgress rejects illegal counters and supports body fallback', () => {
  expect(parseStateProgress([
    'Plan: 3 of 7 in current phase',
    'Status: In progress',
    'Progress: [xxxx] 40%',
  ].join('\n'))).toMatchObject({
    totalPlans: 7,
    completedPlans: 2,
    percent: 40,
  })
  expect(parseStateProgress([
    '---',
    'progress:',
    '  total_plans: 2',
    '  completed_plans: 9',
    '---',
  ].join('\n'))).toBeUndefined()
})
