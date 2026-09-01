import { describe, expect, test, beforeEach } from 'bun:test'
import { spawn as spawnChild } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, rmSync } from 'node:fs'

import './feishu-test-mock'
import {
  resetFeishuMock,
  feishuMockState,
  listSectionTasksCalls,
  listTasklistSectionsCalls,
  listTasklistTasksCalls,
} from './feishu-test-mock'
import { deleteTasklist, enableTasklist, updateTasklistBinding, type TasklistBinding } from './tasklist'
import type { TaskComment, TasklistSection, TaskSummary } from './feishu'
import {
  automationTreeSupportWarning,
  customSectionsForDesignSubtraction,
  hasRecoveredAutomationRunForProject,
  isAutomationRunTracked,
  isManualMergeSignal,
  localReviewRef,
  parseSelectedTaskGuid,
  registerRecoveredAutomationRun,
  reviewDiffSpec,
  reviewHeadRef,
  roundRobinEntries,
  runTasklistWorkerOnce,
  sanitizeTaskCommentContent,
  scanTaskSections,
  shouldIncludeTaskComment,
  taskArtifactTag,
  tasksOutsideCustomSections,
  terminateUnixProcessGroup,
  unixProcessGroupExists,
} from './tasklist-worker'

function task(guid: string): TaskSummary {
  return { guid, summary: guid }
}

function section(guid: string, name: string, isDefault = false): TasklistSection {
  return { guid, name, isDefault }
}

describe('tasklist worker buckets', () => {
  test('treats tasks outside custom sections as design tasks', () => {
    expect(tasksOutsideCustomSections(
      [task('default-1'), task('todo-1'), task('default-2'), task('review-1')],
      [
        [task('todo-1')],
        [task('review-1')],
      ],
    )).toEqual([task('default-1'), task('default-2')])
  })

  test('does not subtract default or legacy design sections from design bucket', () => {
    expect(customSectionsForDesignSubtraction([
      section('default-design', '设计中', true),
      section('legacy-design', '设计中'),
      section('todo', '[AI]待执行'),
      section('doing', '[AI]执行中'),
      section('done', '已完成'),
    ])).toEqual([
      section('todo', '[AI]待执行'),
      section('doing', '[AI]执行中'),
      section('done', '已完成'),
    ])
  })
})

describe('tasklist worker scanTaskSections call budget', () => {
  beforeEach(() => resetFeishuMock())

  test('pulls each lodestar section exactly once (no double fetch)', async () => {
    // 稳态:5 个 section guid 齐全,远端无额外用户自建 section。
    // 旧版 listSectionTasks 会打 8 次(Promise.all 拉 4 个 custom + return 又拉 4 个固定,
    // 同一批 section 拉两遍)—— task v2 空转放大器。断言 4 次 = 每个 lodestar section
    // 只拉一遍;tasklist.tasks 全量 1 次;section.list 1 次(发现自建 section)。
    const binding: TasklistBinding = {
      guid: 'tl-1', name: 'n', url: '', projectName: 'p', ownerOpenId: 'ou',
      sections: { design: 's-design', aiTodo: 's-todo', aiDoing: 's-doing', aiReview: 's-review', done: 's-done' },
    }
    await scanTaskSections(binding)
    expect(listSectionTasksCalls.length).toBe(4)
    expect(listTasklistTasksCalls.length).toBe(1)
    expect(listTasklistSectionsCalls.length).toBe(1)
  })

  test('skips sections it has no guid for', async () => {
    const binding: TasklistBinding = {
      guid: 'tl-1', name: 'n', url: '', projectName: 'p', ownerOpenId: 'ou', sections: {},
    }
    await scanTaskSections(binding)
    expect(listSectionTasksCalls.length).toBe(0)
    expect(listTasklistTasksCalls.length).toBe(1)
    expect(listTasklistSectionsCalls.length).toBe(1)
  })
})

describe('tasklist worker local reviews', () => {
  test('uses task checkbox completion as the merge signal', () => {
    expect(isManualMergeSignal(task('open'))).toBe(false)
    expect(isManualMergeSignal({ ...task('blank'), completedAt: '   ' })).toBe(false)
    expect(isManualMergeSignal({ ...task('done'), completedAt: '2026-06-13T10:30:00Z' })).toBe(true)
  })

  test('formats local review refs as base-to-head diffs', () => {
    expect(localReviewRef('abc123', 'AI-AUTO/task-guid')).toBe('local:abc123..AI-AUTO/task-guid')
  })

  test('formats task artifact tags under AI-AUTO namespace', () => {
    expect(taskArtifactTag('task-guid')).toBe('AI-AUTO/task-guid')
  })

  test('extracts diff spec and head ref from local review refs', () => {
    const ref = 'local:abc123..AI-AUTO/task-guid'
    expect(reviewDiffSpec(ref)).toBe('abc123..AI-AUTO/task-guid')
    expect(reviewHeadRef(ref)).toBe('AI-AUTO/task-guid')
  })
})

describe('tasklist worker task selection (upstream ec149d7)', () => {
  test('accepts exactly one allowed task_guid from strict JSON', () => {
    expect(parseSelectedTaskGuid('{"task_guid":"task-2","reason":"ready"}', ['task-1', 'task-2'])).toBe('task-2')
  })

  test('does not guess from prose, echoed candidates, or unknown ids', () => {
    expect(parseSelectedTaskGuid('I considered task-1 and task-2', ['task-1', 'task-2'])).toBeNull()
    expect(parseSelectedTaskGuid('{"task_guid":"task-3"}', ['task-1', 'task-2'])).toBeNull()
    expect(parseSelectedTaskGuid('```json\n{"task_guid":"task-1"}\n```', ['task-1'])).toBeNull()
  })
})

describe('tasklist worker project fairness (upstream ec149d7)', () => {
  test('rotates the fixed binding order between scans', () => {
    expect(roundRobinEntries(['a', 'b', 'c', 'd'], 2)).toEqual([
      { value: 'c', index: 2 },
      { value: 'd', index: 3 },
      { value: 'a', index: 0 },
      { value: 'b', index: 1 },
    ])
  })

  test('caps concurrent project scans at 2 and queues the rest round-robin', async () => {
    const projects = ['rr-1', 'rr-2', 'rr-3']
    const gates = new Map<string, () => void>()
    for (const name of projects) mkdirSync(`/tmp/lodestar-projects/${name}`, { recursive: true })
    feishuMockState.listSectionTasks = (guid: string) => {
      const project = projects.find(name => guid.includes(`tl_${name}[lodestar]`))
      if (project && guid.startsWith('sec_[AI]待执行_') && !gates.has(project)) {
        return new Promise(resolve => { gates.set(project, () => resolve([])) })
      }
      return Promise.resolve([])
    }
    const guids: string[] = []
    try {
      for (const name of projects) {
        const binding = await enableTasklist(name, 'oc_chat')
        guids.push(binding.guid)
        updateTasklistBinding(name, b => {
          b.worker ??= {}
          b.worker.lastSectionEnsureAt = new Date().toISOString()
        })
      }
      const scannedProjects = () => new Set(
        listSectionTasksCalls
          .map(([guid]) => projects.find(name => guid.includes(`tl_${name}[lodestar]`)))
          .filter((name): name is string => !!name),
      )
      // tick 1:只允许 2 个项目进入扫描,第三个排队
      await runTasklistWorkerOnce()
      expect(scannedProjects().size).toBe(2)
      // tick 2:两个在途扫描挂起中,不重复启动、也不超上限
      await runTasklistWorkerOnce()
      expect(scannedProjects().size).toBe(2)
      // 释放一个在途扫描 → 槽位空出后,下一轮轮转启动第三个项目
      const [firstScanned] = [...scannedProjects()]
      gates.get(firstScanned)!()
      let launchedThird = false
      for (let attempt = 0; attempt < 100 && !launchedThird; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10))
        await runTasklistWorkerOnce()
        launchedThird = scannedProjects().size === 3
      }
      expect(launchedThird).toBe(true)
    } finally {
      for (const name of projects) gates.get(name)?.()
      // 等在途扫描收尾(每个完成的扫描会打一次 tasklist.tasks 全量拉取)
      for (let attempt = 0; attempt < 100; attempt++) {
        if (listTasklistTasksCalls.length >= projects.length) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      await new Promise(resolve => setTimeout(resolve, 20))
      feishuMockState.listSectionTasks = null
      for (let i = 0; i < projects.length; i++) {
        await deleteTasklist(projects[i], guids[i]).catch(() => {})
        rmSync(`/tmp/lodestar-projects/${projects[i]}`, { recursive: true, force: true })
      }
    }
  }, 15_000)
})

describe('tasklist worker process-tree supervision (upstream ec149d7)', () => {
  test('keeps the Windows limitation explicit without disabling task automation', () => {
    expect(automationTreeSupportWarning('win32')).toContain('Job Object')
    expect(automationTreeSupportWarning('linux')).toBeNull()
    expect(automationTreeSupportWarning('darwin')).toBeNull()
  })

  test('terminates descendants that outlive a closed Unix leader', async () => {
    if (process.platform === 'win32') return
    const leader = spawnChild(process.execPath, ['-e', [
      "const { spawn } = require('node:child_process')",
      "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })",
      'child.unref()',
    ].join(';')], { detached: true, stdio: 'ignore' })
    const pgid = leader.pid
    if (!pgid) throw new Error('test leader has no pid')
    try {
      await once(leader, 'close')
      expect(unixProcessGroupExists(pgid)).toBe(true)
      await terminateUnixProcessGroup(pgid, 2000)
      expect(unixProcessGroupExists(pgid)).toBe(false)
    } finally {
      try { process.kill(-pgid, 'SIGKILL') } catch {}
    }
  }, 10_000)

  test('adopts a validated persisted Unix run exactly once (pid+cmdline+pgid fingerprint)', async () => {
    if (process.platform === 'win32') return
    const leader = spawnChild(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      detached: true,
      stdio: 'ignore',
    })
    const pid = leader.pid
    if (!pid) throw new Error('test recovered leader has no pid')
    const record = {
      runId: `recovered-${pid}`,
      projectName: 'adopt-p',
      tasklistGuid: 'tl-1',
      kind: 'codex-plan' as const,
      pid,
      pgid: pid,
      command: [process.execPath],
      cwd: '/tmp',
      status: 'running' as const,
      startedAt: '2026-08-21T00:00:00Z',
    }
    try {
      let adopted = false
      for (let attempt = 0; attempt < 20 && !adopted; attempt++) {
        adopted = registerRecoveredAutomationRun(record)
        if (!adopted) await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(adopted).toBe(true)
      expect(registerRecoveredAutomationRun(record)).toBe(false)
      expect(isAutomationRunTracked(record.runId)).toBe(true)
      expect(hasRecoveredAutomationRunForProject('adopt-p')).toBe(true)
      // 认领拒绝:缺 pgid / 持久化 pgid 与内核当前 pgid 不符(指纹校验)
      expect(registerRecoveredAutomationRun({ ...record, runId: `nopgid-${pid}`, pgid: undefined })).toBe(false)
      expect(registerRecoveredAutomationRun({ ...record, runId: `wrongpgid-${pid}`, pgid: pid + 655360 })).toBe(false)
      await terminateUnixProcessGroup(pid, 2000)
      expect(unixProcessGroupExists(pid)).toBe(false)
    } finally {
      try { process.kill(-pid, 'SIGKILL') } catch {}
    }
  }, 10_000)
})

describe('tasklist worker comments', () => {
  test('removes local markdown link targets while preserving valid URLs', () => {
    expect(sanitizeTaskCommentContent(
      'Changed [worker](/home/leviyuan/feishu/src/tasklist-worker.ts) and [task](https://example.com/task/1).',
    )).toBe('Changed worker and [task](https://example.com/task/1).')
  })

  test('includes only user comments that are not already recorded automation output', () => {
    const ownCommentIds = new Set(['own'])
    expect(shouldIncludeTaskComment(comment('user', 'user'), ownCommentIds)).toBe(true)
    expect(shouldIncludeTaskComment(comment('app', 'app'), ownCommentIds)).toBe(false)
    expect(shouldIncludeTaskComment(comment('own', 'user'), ownCommentIds)).toBe(false)
    expect(shouldIncludeTaskComment({ id: 'unknown', content: 'missing creator' }, ownCommentIds)).toBe(false)
  })
})

function comment(id: string, creatorType: string): TaskComment {
  return { id, content: id, creator: { type: creatorType } }
}
