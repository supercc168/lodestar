import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { execFileSync, spawn as spawnChild } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import './feishu-test-mock'
import {
  resetFeishuMock,
  feishuMockState,
  addedTaskComments,
  listSectionTasksCalls,
  listTasklistSectionsCalls,
  listTasklistTasksCalls,
  movedTasks,
} from './feishu-test-mock'
import {
  deleteTasklist,
  enableTasklist,
  getTasklistBinding,
  taskStateFor,
  updateTasklistBinding,
  type TasklistBinding,
} from './tasklist'
import type { TaskComment, TasklistSection, TaskSummary } from './feishu'
import { prepareAutomationWorktree } from './tasklist-worker-git'
import {
  automationTreeSupportWarning,
  customSectionsForDesignSubtraction,
  hasRecoveredAutomationRunForProject,
  isAutomationRunTracked,
  isManualMergeSignal,
  localReviewRef,
  parseSelectedTaskGuid,
  processCompletedReviewTask,
  processExecutingTask,
  registerRecoveredAutomationRun,
  reviewDiffSpec,
  reviewHeadRef,
  roundRobinEntries,
  runTasklistWorkerOnce,
  sanitizeTaskCommentContent,
  scanTaskSections,
  shouldIncludeTaskComment,
  startTasklistWorker,
  stopTasklistWorker,
  taskArtifactTag,
  tasklistWorkerActivityIsIdle,
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

describe('tasklist worker bounded shutdown (upstream ec149d7)', () => {
  beforeEach(() => resetFeishuMock())

  test('shutdown drain remains busy while deletion startup reconciliation is active', () => {
    expect(tasklistWorkerActivityIsIdle(0, 0, true)).toBe(false)
    expect(tasklistWorkerActivityIsIdle(0, 0, false)).toBe(true)
    expect(tasklistWorkerActivityIsIdle(1, 0, false)).toBe(false)
    expect(tasklistWorkerActivityIsIdle(0, 1, false)).toBe(false)
  })

  test('stopTasklistWorker waits for an in-flight startup deletion reconcile', async () => {
    let reconcileStarted!: () => void
    const started = new Promise<void>(resolve => { reconcileStarted = resolve })
    let releaseReconcile!: () => void
    const gate = new Promise<void>(resolve => { releaseReconcile = resolve })
    startTasklistWorker({
      bootDelayMs: 0,
      reconcileDeletions: async () => {
        reconcileStarted()
        await gate
      },
    })
    await started
    let stopped = false
    const stopping = stopTasklistWorker(500).then(() => { stopped = true })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(stopped).toBe(false)
    releaseReconcile()
    await stopping
    expect(stopped).toBe(true)
  })

  test('adopts a persisted run and stopTasklistWorker terminates its PGID within the bound', async () => {
    if (process.platform === 'win32') return
    const leader = spawnChild(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      detached: true,
      stdio: 'ignore',
    })
    const pid = leader.pid
    if (!pid) throw new Error('test recovered leader has no pid')
    const closed = once(leader, 'close')
    const record = {
      runId: `stop-recovered-${pid}`,
      projectName: 'stop-p',
      tasklistGuid: 'tl-stop',
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
      expect(isAutomationRunTracked(record.runId)).toBe(true)
      await stopTasklistWorker(2000)
      await closed
      expect(isAutomationRunTracked(record.runId)).toBe(false)
      expect(hasRecoveredAutomationRunForProject('stop-p')).toBe(false)
      expect(unixProcessGroupExists(pid)).toBe(false)
    } finally {
      try { process.kill(-pid, 'SIGKILL') } catch {}
    }
  }, 10_000)

  test('long boot delay still adopts recovered PGID synchronously before immediate stop', async () => {
    if (process.platform === 'win32') return
    const leader = spawnChild(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      detached: true,
      stdio: 'ignore',
    })
    const pid = leader.pid
    if (!pid) throw new Error('test pre-boot recovered leader has no pid')
    const closed = once(leader, 'close')
    const record = {
      runId: `preboot-recovered-${pid}`,
      projectName: 'preboot-project',
      tasklistGuid: 'tl-preboot',
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
      startTasklistWorker({
        bootDelayMs: 60_000,
        adoptPersistedRuns: () => { adopted = registerRecoveredAutomationRun(record) },
        reconcileDeletions: async () => {},
      })
      expect(adopted).toBe(true)
      expect(isAutomationRunTracked(record.runId)).toBe(true)
      await stopTasklistWorker(2000)
      await closed
      expect(isAutomationRunTracked(record.runId)).toBe(false)
      expect(unixProcessGroupExists(pid)).toBe(false)
    } finally {
      try { process.kill(-pid, 'SIGKILL') } catch {}
    }
  }, 10_000)

  test('after stopTasklistWorker the scheduler no longer scans bindings', async () => {
    const projectName = 'stop-sched'
    mkdirSync(`/tmp/lodestar-projects/${projectName}`, { recursive: true })
    const binding = await enableTasklist(projectName, 'oc_chat')
    updateTasklistBinding(projectName, b => {
      b.worker ??= {}
      b.worker.lastSectionEnsureAt = new Date().toISOString()
    })
    try {
      // 先 start 重置 stopping(前序关停用例留下的终态);boot 延迟拉长,tick 由测试手动驱动
      startTasklistWorker({ bootDelayMs: 60_000, adoptPersistedRuns: () => {}, reconcileDeletions: async () => {} })
      // 关停前:正常 tick 会扫到该 binding
      resetFeishuMock()
      await runTasklistWorkerOnce()
      for (let attempt = 0; attempt < 100 && listTasklistTasksCalls.length === 0; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(listSectionTasksCalls.length).toBeGreaterThan(0)
      // 关停后:调度短路,不再发起任何扫描
      await stopTasklistWorker(1000)
      resetFeishuMock()
      await runTasklistWorkerOnce()
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(listSectionTasksCalls.length).toBe(0)
      expect(listTasklistTasksCalls.length).toBe(0)
    } finally {
      await deleteTasklist(projectName, binding.guid).catch(() => {})
      rmSync(`/tmp/lodestar-projects/${projectName}`, { recursive: true, force: true })
    }
  }, 10_000)
})

describe('tasklist worker review crash-window recovery (upstream ec149d7)', () => {
  let roots: string[] = []

  beforeEach(() => resetFeishuMock())
  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
    roots = []
  })

  function gitCmd(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' })
  }

  function initTaskRepo(): { root: string; repo: string } {
    // realpathSync:macOS 的 /var → /private/var 符号链接会让 assertGitRepo 的
    // 路径等值判断失败(git rev-parse 返回物理路径)。
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'lodestar-tlw-')))
    roots.push(root)
    const repo = join(root, 'proj')
    mkdirSync(repo)
    gitCmd(repo, ['init'])
    gitCmd(repo, ['config', 'user.email', 'test@example.com'])
    gitCmd(repo, ['config', 'user.name', 'Test User'])
    writeFileSync(join(repo, 'README.md'), '# probe\n')
    gitCmd(repo, ['add', 'README.md'])
    gitCmd(repo, ['commit', '-m', 'init'])
    gitCmd(repo, ['branch', '-M', 'main'])
    return { root, repo }
  }

  test('prepareAutomationWorktree verifies the frozen base head before mounting', () => {
    const { root, repo } = initTaskRepo()
    const head = gitCmd(repo, ['rev-parse', 'HEAD']).trim()
    expect(() => prepareAutomationWorktree(repo, 'proj', 'AI-AUTO', '0'.repeat(40)))
      .toThrow('project HEAD changed before worktree prepare')
    expect(prepareAutomationWorktree(repo, 'proj', 'AI-AUTO', head)).toBe(join(root, 'proj[AI-AUTO]'))
  })

  test('recovers the review request from the artifact tag after a crash window', async () => {
    const projectName = 'rec-exec'
    const binding = await enableTasklist(projectName, 'oc_chat')
    const { repo } = initTaskRepo()
    const taskGuid = 'task-rec'
    const artifactTag = taskArtifactTag(taskGuid)
    const baseHead = gitCmd(repo, ['rev-parse', 'HEAD']).trim()
    writeFileSync(join(repo, 'work.txt'), 'automation output\n')
    gitCmd(repo, ['add', '-A'])
    gitCmd(repo, ['commit', '-m', 'AI-AUTO: work'])
    gitCmd(repo, ['tag', artifactTag])
    gitCmd(repo, ['reset', '--hard', baseHead])
    try {
      updateTasklistBinding(projectName, b => {
        const state = taskStateFor(b, taskGuid)
        // 崩溃窗:执行进程已退出、产物 tag 已创建,但 reviewRef 未落盘;
        // agyReview 置 exited 让恢复后的推进不 spawn 真进程(聚焦恢复写本身)。
        state.codexExecution = { runId: 'run-exec', status: 'exited' }
        state.agyReview = { runId: 'run-review', status: 'exited' }
      })
      const fresh = getTasklistBinding(projectName)!
      const handled = await processExecutingTask(projectName, repo, fresh, [{ guid: taskGuid, summary: 'crash recovery' }])
      expect(handled).toBe(true)
      const after = getTasklistBinding(projectName)!
      expect(after.tasks?.[taskGuid]?.reviewRef).toBe(`local:${baseHead}..${artifactTag}`)
      expect(after.tasks?.[taskGuid]?.executionTag).toBe(artifactTag)
      expect(after.tasks?.[taskGuid]?.sectionKey).toBe('aiReview')
      expect(movedTasks).toContainEqual([taskGuid, fresh.guid, fresh.sections!.aiReview!])
    } finally {
      await deleteTasklist(projectName, binding.guid).catch(() => {})
    }
  })

  test('fails visibly when the artifact tag is gone instead of silently absorbing the task', async () => {
    const projectName = 'rec-exec-miss'
    const binding = await enableTasklist(projectName, 'oc_chat')
    const { repo } = initTaskRepo()
    const taskGuid = 'task-miss'
    try {
      updateTasklistBinding(projectName, b => {
        const state = taskStateFor(b, taskGuid)
        state.codexExecution = { runId: 'run-exec', status: 'exited' }
      })
      const fresh = getTasklistBinding(projectName)!
      const handled = await processExecutingTask(projectName, repo, fresh, [{ guid: taskGuid, summary: 'missing tag' }])
      expect(handled).toBe(true)
      const after = getTasklistBinding(projectName)!
      expect(after.tasks?.[taskGuid]?.codexExecution?.status).toBe('failed')
      expect(after.tasks?.[taskGuid]?.codexExecution?.error).toContain('无法恢复本地审查请求')
      expect(addedTaskComments.some(([, content]) => content.includes('无法恢复本地审查请求'))).toBe(true)
      expect(movedTasks).toHaveLength(0)
    } finally {
      await deleteTasklist(projectName, binding.guid).catch(() => {})
    }
  })

  test('reconciles an exited merge from Git truth and moves the task to done without respawning', async () => {
    const projectName = 'rec-merge'
    const binding = await enableTasklist(projectName, 'oc_chat')
    const { repo } = initTaskRepo()
    const taskGuid = 'task-m'
    const artifactTag = taskArtifactTag(taskGuid)
    const baseHead = gitCmd(repo, ['rev-parse', 'HEAD']).trim()
    writeFileSync(join(repo, 'merged.txt'), 'merged output\n')
    gitCmd(repo, ['add', '-A'])
    gitCmd(repo, ['commit', '-m', 'AI-AUTO: merged work'])
    gitCmd(repo, ['tag', artifactTag])
    // HEAD 已包含 tag(合并已在崩溃前完成)
    try {
      updateTasklistBinding(projectName, b => {
        const state = taskStateFor(b, taskGuid)
        state.codexMerge = { runId: 'run-m', status: 'exited' }
        state.reviewRef = `local:${baseHead}..${artifactTag}`
      })
      const fresh = getTasklistBinding(projectName)!
      const handled = await processCompletedReviewTask(projectName, repo, fresh, [
        { guid: taskGuid, summary: 'merge me', completedAt: '2026-09-01T00:00:00Z' },
      ])
      expect(handled).toBe(true)
      const after = getTasklistBinding(projectName)!
      expect(after.tasks?.[taskGuid]?.sectionKey).toBe('done')
      expect(after.tasks?.[taskGuid]?.codexMerge?.status).toBe('exited')
      expect(movedTasks).toContainEqual([taskGuid, fresh.guid, fresh.sections!.done!])
      expect(addedTaskComments.some(([, content]) => content.includes('未确认合并'))).toBe(false)
    } finally {
      await deleteTasklist(projectName, binding.guid).catch(() => {})
    }
  })

  test('marks an exited merge failed when Git truth does not confirm the merge', async () => {
    const projectName = 'rec-merge-bad'
    const binding = await enableTasklist(projectName, 'oc_chat')
    const { repo } = initTaskRepo()
    const taskGuid = 'task-bad'
    const artifactTag = taskArtifactTag(taskGuid)
    const baseHead = gitCmd(repo, ['rev-parse', 'HEAD']).trim()
    gitCmd(repo, ['checkout', '-b', 'side'])
    writeFileSync(join(repo, 'side.txt'), 'unmerged output\n')
    gitCmd(repo, ['add', '-A'])
    gitCmd(repo, ['commit', '-m', 'AI-AUTO: unmerged work'])
    gitCmd(repo, ['tag', artifactTag])
    gitCmd(repo, ['checkout', 'main'])
    try {
      updateTasklistBinding(projectName, b => {
        const state = taskStateFor(b, taskGuid)
        state.codexMerge = { runId: 'run-mb', status: 'exited' }
        state.reviewRef = `local:${baseHead}..${artifactTag}`
      })
      const fresh = getTasklistBinding(projectName)!
      const handled = await processCompletedReviewTask(projectName, repo, fresh, [
        { guid: taskGuid, summary: 'not merged', completedAt: '2026-09-01T00:00:00Z' },
      ])
      expect(handled).toBe(true)
      const after = getTasklistBinding(projectName)!
      expect(after.tasks?.[taskGuid]?.codexMerge?.status).toBe('failed')
      expect(after.tasks?.[taskGuid]?.codexMerge?.error).toContain('未确认合并')
      expect(addedTaskComments.some(([, content]) => content.includes('未确认合并'))).toBe(true)
      expect(movedTasks).toHaveLength(0)
    } finally {
      await deleteTasklist(projectName, binding.guid).catch(() => {})
    }
  })
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
