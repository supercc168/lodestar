import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { buildAgySpawnPath, resolveAgyBin, agyPrintArgs } from './agy-task'
import { resolveCodexBin } from './codex-process'
import * as feishu from './feishu'
import { log } from './log'
import * as tasklist from './tasklist'
import type {
  AutomationProcessRecord,
  TaskAutomationRunRef,
  TaskAutomationState,
  TasklistBinding,
  TasklistSectionKey,
} from './tasklist'

const TASKLIST_WORKER_INTERVAL_MS = 5 * 60 * 1000
const TASKLIST_WORKER_BOOT_DELAY_MS = 15_000
const PROCESS_OUTPUT_TAIL_LIMIT = 20_000
const COMMENT_OUTPUT_LIMIT = 15_000
const PLAN_TIMEOUT_MS = 60 * 60 * 1000
const EXEC_TIMEOUT_MS = 180 * 60 * 1000
const KILL_AFTER_MS = 5000
const CODEX_MODEL = process.env.LODESTAR_TASK_CODEX_MODEL ?? 'gpt-5.5'
const CODEX_REASONING_EFFORT = process.env.LODESTAR_TASK_CODEX_EFFORT ?? 'xhigh'
const AI_AUTO_BRANCH = 'AI-AUTO'
const AI_REVIEW_BRANCH = 'AI-REVIEW'

let timer: ReturnType<typeof setInterval> | null = null
let bootTimer: ReturnType<typeof setTimeout> | null = null
let running = false

export function startTasklistWorker(): void {
  if (timer || bootTimer) return
  bootTimer = setTimeout(() => {
    bootTimer = null
    void runTasklistWorkerOnce()
    timer = setInterval(() => { void runTasklistWorkerOnce() }, TASKLIST_WORKER_INTERVAL_MS)
  }, TASKLIST_WORKER_BOOT_DELAY_MS)
  log(`tasklist-worker: scheduled every ${TASKLIST_WORKER_INTERVAL_MS / 1000}s`)
}

export async function runTasklistWorkerOnce(): Promise<void> {
  if (running) {
    log('tasklist-worker: previous scan still running, skip')
    return
  }
  running = true
  try {
    for (const binding of tasklist.listTasklistBindings()) {
      await processTasklist(binding.projectName)
    }
  } catch (e) {
    log(`tasklist-worker: scan failed: ${messageOf(e)}`)
  } finally {
    running = false
  }
}

async function processTasklist(projectName: string): Promise<void> {
  const projectDir = join(feishu.PROJECTS_ROOT, projectName)
  try {
    if (!existsSync(projectDir)) throw new Error(`project directory does not exist: ${projectDir}`)
    const binding = await tasklist.ensureTasklistSections(projectName)
    const buckets = await scanTaskSections(binding)
    rememberScan(projectName, buckets)

    if (await processCompletedReviewTask(projectName, projectDir, binding, buckets.aiReview)) return
    if (await processDesignTask(projectName, projectDir, binding, buckets.design)) return
    if (await processReadyTask(projectName, projectDir, binding, buckets.aiTodo, buckets.aiDoing, buckets.aiReview)) return
    if (await processExecutingTask(projectName, projectDir, binding, buckets.aiDoing)) return
  } catch (e) {
    const msg = messageOf(e)
    log(`tasklist-worker: ${projectName} failed: ${msg}`)
    safeUpdate(projectName, binding => {
      binding.worker ??= {}
      binding.worker.lastScanAt = new Date().toISOString()
      binding.worker.lastScanError = msg
    })
  }
}

type TaskBuckets = Record<TasklistSectionKey, feishu.TaskSummary[]>

async function scanTaskSections(binding: TasklistBinding): Promise<TaskBuckets> {
  const sections = binding.sections ?? {}
  const allOpenTasks = await feishu.listTasklistTasks(binding.guid, false)
  const remoteSections = customSectionsForDesignSubtraction(await feishu.listTasklistSections(binding.guid))
  const openTasksByCustomSection = await Promise.all(
    remoteSections.map(section => feishu.listSectionTasks(section.guid, false)),
  )
  return {
    design: tasksOutsideCustomSections(allOpenTasks, openTasksByCustomSection),
    aiTodo: sections.aiTodo ? await feishu.listSectionTasks(sections.aiTodo, false) : [],
    aiDoing: sections.aiDoing ? await feishu.listSectionTasks(sections.aiDoing, false) : [],
    aiReview: sections.aiReview ? await feishu.listSectionTasks(sections.aiReview) : [],
    done: sections.done ? await feishu.listSectionTasks(sections.done) : [],
  }
}

export function customSectionsForDesignSubtraction(
  sections: feishu.TasklistSection[],
): feishu.TasklistSection[] {
  const designSectionName = tasklist.sectionNameForKey('design')
  return sections
    .filter(section => !section.isDefault)
    .filter(section => section.name !== designSectionName)
}

export function tasksOutsideCustomSections(
  allTasks: feishu.TaskSummary[],
  customSectionTasks: feishu.TaskSummary[][],
): feishu.TaskSummary[] {
  const customTaskGuids = new Set(customSectionTasks.flat().map(task => task.guid))
  return allTasks.filter(task => !customTaskGuids.has(task.guid))
}

function rememberScan(projectName: string, buckets: TaskBuckets): void {
  safeUpdate(projectName, binding => {
    const now = new Date().toISOString()
    binding.worker ??= {}
    binding.worker.lastScanAt = now
    binding.worker.lastScanError = undefined
    for (const [sectionKey, tasks] of Object.entries(buckets) as [TasklistSectionKey, feishu.TaskSummary[]][]) {
      for (const task of tasks) {
        const state = tasklist.taskStateFor(binding, task.guid)
        state.summary = task.summary
        state.sectionKey = sectionKey
        state.completedAt = task.completedAt
        state.lastSeenAt = now
      }
    }
  })
}

async function processDesignTask(
  projectName: string,
  projectDir: string,
  binding: TasklistBinding,
  tasks: feishu.TaskSummary[],
): Promise<boolean> {
  for (const task of tasks) {
    const full = await loadStructuredTask(binding, 'design', task.guid)
    const fingerprint = designFingerprint(full)
    const state = getTaskState(projectName, task.guid)
    if (state.codexPlan?.status === 'running' || state.agyPlan?.status === 'running') return true
    const codexSettled = state.codexPlan?.fingerprint === fingerprint && !!state.codexPlan.status
    const agySettled = state.agyPlan?.fingerprint === fingerprint && !!state.agyPlan.status
    if (codexSettled && agySettled) continue

    if (!codexSettled) {
      const run = await runCodexPlan(projectName, projectDir, binding, task.guid, full, fingerprint)
      if (run.status !== 'exited') return true
    }
    if (!agySettled) {
      await runAgyPlan(projectName, projectDir, binding, task.guid, full, fingerprint)
    }
    return true
  }
  return false
}

async function processReadyTask(
  projectName: string,
  projectDir: string,
  binding: TasklistBinding,
  todo: feishu.TaskSummary[],
  doing: feishu.TaskSummary[],
  review: feishu.TaskSummary[],
): Promise<boolean> {
  if (doing.length > 0 || review.length > 0 || todo.length === 0) return false
  const stateRunning = tasklist.listTasklistBindings()
    .find(b => b.projectName === projectName)
    ?.processes
  if (stateRunning && Object.values(stateRunning).some(p => p.status === 'running' && p.kind === 'codex-execute')) {
    return true
  }
  const selected = await runAgyPick(projectName, projectDir, binding, todo)
  if (!selected) return true
  const doingGuid = binding.sections?.aiDoing
  if (!doingGuid) throw new Error('missing [AI]执行中 section guid')
  await feishu.moveTaskToSection(selected, binding.guid, doingGuid)
  safeUpdate(projectName, b => {
    const state = tasklist.taskStateFor(b, selected)
    state.sectionKey = 'aiDoing'
    b.worker ??= {}
    b.worker.runningTaskGuid = selected
  })
  return true
}

async function processExecutingTask(
  projectName: string,
  projectDir: string,
  binding: TasklistBinding,
  doing: feishu.TaskSummary[],
): Promise<boolean> {
  if (doing.length === 0) return false
  const task = doing[0]
  const state = getTaskState(projectName, task.guid)
  if (state.codexExecution?.status === 'running') return true
  if (state.codexExecution?.status === 'failed') return true
  if (state.codexExecution?.status === 'exited') {
    return hasLocalReviewRequest(state)
      ? await reviewExecutedTask(projectName, projectDir, binding, task.guid)
      : true
  }

  const run = await runCodexExecution(projectName, projectDir, binding, task.guid)
  if (run.status !== 'exited') return true

  return await reviewExecutedTask(projectName, projectDir, binding, task.guid)
}

async function reviewExecutedTask(
  projectName: string,
  projectDir: string,
  binding: TasklistBinding,
  taskGuid: string,
): Promise<boolean> {
  const latest = getTaskState(projectName, taskGuid)
  if (!hasLocalReviewRequest(latest)) return true
  if (latest.agyReview?.status === 'running') return true
  if (latest.agyReview?.status === 'failed') return true
  if (latest.agyReview?.status !== 'exited') {
    const run = await runAgyReview(projectName, projectDir, binding, taskGuid, reviewRequestText(latest))
    if (run.status !== 'exited') return true
  }
  const reviewGuid = binding.sections?.aiReview
  if (!reviewGuid) throw new Error('missing [AI]待审核 section guid')
  await feishu.moveTaskToSection(taskGuid, binding.guid, reviewGuid)
  safeUpdate(projectName, b => {
    const state = tasklist.taskStateFor(b, taskGuid)
    state.sectionKey = 'aiReview'
    b.worker ??= {}
    b.worker.runningTaskGuid = undefined
  })
  return true
}

async function processCompletedReviewTask(
  projectName: string,
  projectDir: string,
  binding: TasklistBinding,
  reviewTasks: feishu.TaskSummary[],
): Promise<boolean> {
  for (const task of reviewTasks) {
    if (!task.completedAt) continue
    const state = getTaskState(projectName, task.guid)
    if (state.codexMerge?.status === 'running') return true
    if (state.codexMerge?.status === 'exited') continue
    if (state.codexMerge?.status === 'failed') return true
    if (!hasLocalReviewRequest(state)) {
      await commentAndStoreError(projectName, task.guid, '审核完成后无法合并：本地状态里没有本地审查请求。')
      return true
    }
    const run = await runCodexMerge(projectName, projectDir, binding, task.guid, reviewRequestText(state))
    if (run.status !== 'exited') return true
    if (!String(run.stdoutTail ?? '').includes('LODESTAR_MERGE_STATUS: MERGED')) {
      await commentAndStoreError(projectName, task.guid, 'Codex 合并进程未明确输出 `LODESTAR_MERGE_STATUS: MERGED`，任务保留在审核分组。')
      return true
    }
    const doneGuid = binding.sections?.done
    if (!doneGuid) throw new Error('missing 已完成 section guid')
    await feishu.moveTaskToSection(task.guid, binding.guid, doneGuid)
    safeUpdate(projectName, b => {
      const state = tasklist.taskStateFor(b, task.guid)
      state.sectionKey = 'done'
    })
    return true
  }
  return false
}

async function runCodexPlan(
  projectName: string,
  projectDir: string,
  binding: TasklistBinding,
  taskGuid: string,
  structured: unknown,
  fingerprint: string,
): Promise<TaskAutomationRunRef & { stdoutTail?: string }> {
  const prompt = [
    '你是 Lodestar 任务清单里的 Codex 规划审查 Agent。',
    '只输出可以直接发到飞书任务评论区的规划意见；不要修改文件，不要执行实现。',
    '重点说明需求理解、风险、建议拆分、验收点和需要人工确认的问题。',
    '',
    '任务完整结构化数据：',
    jsonBlock(structured),
  ].join('\n')
  const result = await runAgentProcess({
    projectName,
    tasklistGuid: binding.guid,
    taskGuid,
    kind: 'codex-plan',
    cwd: projectDir,
    command: [
      resolveCodexBin(),
      'exec',
      '-m', CODEX_MODEL,
      '-c', `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
      '-s', 'read-only',
      '-C', projectDir,
      prompt,
    ],
    timeoutMs: PLAN_TIMEOUT_MS,
    refKey: 'codexPlan',
    fingerprint,
  })
  if (result.status === 'exited' && result.exitCode === 0) {
    const commentId = await feishu.addTaskComment(taskGuid, agentComment('Codex 规划', result.stdoutTail ?? ''))
    markRunComment(projectName, taskGuid, 'codexPlan', commentId)
  } else {
    await commentAndStoreError(projectName, taskGuid, `Codex 规划失败：${processFailureText(result)}`)
  }
  return { runId: result.runId, status: result.status, fingerprint, stdoutTail: result.stdoutTail }
}

async function runAgyPlan(
  projectName: string,
  projectDir: string,
  binding: TasklistBinding,
  taskGuid: string,
  structured: unknown,
  fingerprint: string,
): Promise<TaskAutomationRunRef> {
  const prompt = [
    '你是 Lodestar 任务清单里的 agy 规划审查 Agent。',
    '只输出可以直接发到飞书任务评论区的看法；不要修改文件，不要执行实现。',
    '重点利用长上下文能力补充需求边界、方案选择、潜在遗漏和反对意见。',
    '',
    '任务完整结构化数据：',
    jsonBlock(structured),
  ].join('\n')
  const result = await runAgentProcess({
    projectName,
    tasklistGuid: binding.guid,
    taskGuid,
    kind: 'agy-plan',
    cwd: projectDir,
    command: [resolveAgyBin(), ...agyPrintArgs(prompt)],
    timeoutMs: PLAN_TIMEOUT_MS,
    refKey: 'agyPlan',
    fingerprint,
  })
  if (result.status === 'exited' && result.exitCode === 0) {
    const commentId = await feishu.addTaskComment(taskGuid, agentComment('agy 看法', result.stdoutTail ?? ''))
    markRunComment(projectName, taskGuid, 'agyPlan', commentId)
  } else {
    await commentAndStoreError(projectName, taskGuid, `agy 规划失败：${processFailureText(result)}`)
  }
  return { runId: result.runId, status: result.status, fingerprint }
}

async function runAgyPick(
  projectName: string,
  projectDir: string,
  binding: TasklistBinding,
  tasks: feishu.TaskSummary[],
): Promise<string | null> {
  const prompt = [
    '你是 Lodestar 的任务调度 Agent。',
    '从候选任务里选择最适合下一个自动执行的一个任务。',
    '只输出 JSON：{"task_guid":"...","reason":"..."}，不要输出其他文字。',
    '',
    jsonBlock({ projectName, tasks }),
  ].join('\n')
  const result = await runAgentProcess({
    projectName,
    tasklistGuid: binding.guid,
    kind: 'agy-pick',
    cwd: projectDir,
    command: [resolveAgyBin(), ...agyPrintArgs(prompt)],
    timeoutMs: PLAN_TIMEOUT_MS,
  })
  if (result.status !== 'exited' || result.exitCode !== 0) {
    log(`tasklist-worker: agy pick failed for ${projectName}: ${processFailureText(result)}`)
    return null
  }
  const selected = parseSelectedTaskGuid(result.stdoutTail ?? '', tasks.map(t => t.guid))
  if (!selected) {
    safeUpdate(projectName, b => {
      b.worker ??= {}
      b.worker.lastScanError = 'agy pick did not return a valid task_guid'
    })
    return null
  }
  markRunOnTask(projectName, selected, 'agyPick', result.runId, undefined, 'exited')
  return selected
}

async function runCodexExecution(
  projectName: string,
  projectDir: string,
  binding: TasklistBinding,
  taskGuid: string,
): Promise<AutomationProcessRecord> {
  const worktreePath = prepareAutomationWorktree(projectDir, projectName, AI_AUTO_BRANCH)
  const structured = await loadStructuredTask(binding, 'aiDoing', taskGuid)
  const prompt = [
    '你是 Lodestar 自动执行 Agent。',
    '根据飞书任务完成代码实现，直接在当前仓库工作区修改文件。',
    '完成后运行与改动风险匹配的验证。不要提交 git commit，不要操作 GitHub 或远端 PR。',
    'worker 会在你完成后生成本地审查请求。',
    '最终回复必须包含变更摘要和验证结果。',
    '',
    '任务完整结构化数据：',
    jsonBlock(structured),
  ].join('\n')
  const result = await runAgentProcess({
    projectName,
    tasklistGuid: binding.guid,
    taskGuid,
    kind: 'codex-execute',
    cwd: worktreePath,
    command: [
      resolveCodexBin(),
      'exec',
      '-m', CODEX_MODEL,
      '-c', `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
      '--dangerously-bypass-approvals-and-sandbox',
      '-C', worktreePath,
      prompt,
    ],
    timeoutMs: EXEC_TIMEOUT_MS,
    refKey: 'codexExecution',
  })
  if (result.status !== 'exited' || result.exitCode !== 0) {
    await commentAndStoreError(projectName, taskGuid, `Codex 执行失败：${processFailureText(result)}`)
    return result
  }

  try {
    const status = git(worktreePath, ['status', '--porcelain=v1']).trim()
    if (!status) {
      await commentAndStoreError(projectName, taskGuid, 'Codex 执行完成但没有产生仓库变更，未生成本地审查请求。')
      return markProcessFailed(projectName, result, 'Codex execution produced no repository changes')
    }
    const task = await feishu.getTask(taskGuid)
    const baseBranch = git(projectDir, ['branch', '--show-current']).trim()
    if (!baseBranch) throw new Error('cannot determine base branch from project directory')
    const commitMsg = commitTitle(task?.summary || taskGuid)
    git(worktreePath, ['add', '-A'])
    git(worktreePath, ['commit', '-m', commitMsg])
    const commitHash = git(worktreePath, ['rev-parse', 'HEAD']).trim()
    const reviewRef = localReviewRef(baseBranch, AI_AUTO_BRANCH)
    safeUpdate(projectName, b => {
      const state = tasklist.taskStateFor(b, taskGuid)
      state.executionBranch = AI_AUTO_BRANCH
      state.reviewBranch = AI_REVIEW_BRANCH
      state.reviewRef = reviewRef
    })
    try {
      await feishu.addTaskComment(taskGuid, agentComment('Codex 执行', [
        `本地 PR：${AI_AUTO_BRANCH} -> ${baseBranch}`,
        `Diff：${baseBranch}..${AI_AUTO_BRANCH}`,
        `提交：${commitHash.slice(0, 12)}`,
        '',
        '输出摘要：',
        tail(result.stdoutTail ?? '', 6000),
      ].join('\n')))
    } catch (e) {
      const msg = `Codex 执行评论写入失败：${messageOf(e)}`
      log(`tasklist-worker: ${msg}`)
      safeUpdate(projectName, b => {
        const state = tasklist.taskStateFor(b, taskGuid)
        state.lastError = msg
      })
    }
  } catch (e) {
    const msg = messageOf(e)
    await commentAndStoreError(projectName, taskGuid, `Codex 执行后生成本地审查请求失败：${msg}`)
    return markProcessFailed(projectName, result, msg)
  }
  return result
}

async function runAgyReview(
  projectName: string,
  projectDir: string,
  binding: TasklistBinding,
  taskGuid: string,
  reviewRequest: string,
): Promise<AutomationProcessRecord> {
  const worktreePath = prepareAutomationWorktree(projectDir, projectName, AI_REVIEW_BRANCH)
  const structured = await loadStructuredTask(binding, 'aiReview', taskGuid)
  const prompt = [
    '你是 Lodestar 自动审核 Agent。',
    `请审核本地审查请求：${reviewRequest}`,
    `当前工作区在 ${AI_REVIEW_BRANCH}，实现分支是 ${AI_AUTO_BRANCH}。`,
    `重点查看 git diff HEAD..${AI_AUTO_BRANCH}，输出可以直接发到飞书任务评论区的审核意见。`,
    '不要修改文件，不要合并，不要操作 GitHub 或远端 PR。',
    '',
    '任务完整结构化数据：',
    jsonBlock(structured),
  ].join('\n')
  const result = await runAgentProcess({
    projectName,
    tasklistGuid: binding.guid,
    taskGuid,
    kind: 'agy-review',
    cwd: worktreePath,
    command: [resolveAgyBin(), ...agyPrintArgs(prompt)],
    timeoutMs: PLAN_TIMEOUT_MS,
    refKey: 'agyReview',
  })
  if (result.status === 'exited' && result.exitCode === 0) {
    const commentId = await feishu.addTaskComment(taskGuid, agentComment('agy 审核', result.stdoutTail ?? ''))
    markRunComment(projectName, taskGuid, 'agyReview', commentId)
  } else {
    await commentAndStoreError(projectName, taskGuid, `agy 审核失败：${processFailureText(result)}`)
  }
  return result
}

async function runCodexMerge(
  projectName: string,
  projectDir: string,
  binding: TasklistBinding,
  taskGuid: string,
  reviewRequest: string,
): Promise<AutomationProcessRecord> {
  const prompt = [
    '你是 Lodestar 自动合并 Agent。',
    `任务已由人工在飞书清单中勾选完成。请合并本地审查请求：${reviewRequest}`,
    `只使用本地 Git，把 ${AI_AUTO_BRANCH} 合并到当前主工作区所在分支。`,
    `合并前确认工作区干净，并查看 git diff HEAD..${AI_AUTO_BRANCH}。`,
    '不要使用 GitHub、gh CLI、远端 PR 或 push。',
    '如发生冲突，按仓库约定解决并运行与风险匹配的验证。',
    '如果确认已经合并，最终输出一行：LODESTAR_MERGE_STATUS: MERGED',
    '如果不能合并，最终输出一行：LODESTAR_MERGE_STATUS: FAILED，并说明原因。',
  ].join('\n')
  const result = await runAgentProcess({
    projectName,
    tasklistGuid: binding.guid,
    taskGuid,
    kind: 'codex-merge',
    cwd: projectDir,
    command: [
      resolveCodexBin(),
      'exec',
      '-m', CODEX_MODEL,
      '-c', `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
      '--dangerously-bypass-approvals-and-sandbox',
      '-C', projectDir,
      prompt,
    ],
    timeoutMs: EXEC_TIMEOUT_MS,
    refKey: 'codexMerge',
  })
  const label = result.status === 'exited' && result.exitCode === 0 ? 'Codex 合并' : 'Codex 合并失败'
  await feishu.addTaskComment(taskGuid, agentComment(label, result.stdoutTail || processFailureText(result)))
  return result
}

type RunRefKey = 'codexPlan' | 'agyPlan' | 'agyPick' | 'codexExecution' | 'agyReview' | 'codexMerge'

async function runAgentProcess(opts: {
  projectName: string
  tasklistGuid: string
  taskGuid?: string
  kind: AutomationProcessRecord['kind']
  cwd: string
  command: string[]
  timeoutMs: number
  refKey?: RunRefKey
  fingerprint?: string
}): Promise<AutomationProcessRecord> {
  const runId = `${opts.kind}-${Date.now()}-${randomUUID().slice(0, 8)}`
  const startedAt = new Date().toISOString()
  let record: AutomationProcessRecord = {
    runId,
    projectName: opts.projectName,
    tasklistGuid: opts.tasklistGuid,
    taskGuid: opts.taskGuid,
    kind: opts.kind,
    command: displayCommand(opts.command),
    cwd: opts.cwd,
    status: 'running',
    startedAt,
  }
  const proc = spawn(opts.command[0], opts.command.slice(1), {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...(process.env as Record<string, string>), PATH: buildAgySpawnPath() },
    shell: process.platform === 'win32',
  })
  record = { ...record, pid: proc.pid || undefined }
  storeProcessRecord(opts.projectName, record)
  if (opts.taskGuid && opts.refKey) {
    markRunOnTask(opts.projectName, opts.taskGuid, opts.refKey, runId, opts.fingerprint, 'running')
  }
  log(`tasklist-worker: spawned ${opts.kind} run=${runId} pid=${record.pid ?? 'unknown'} cwd=${opts.cwd}`)

  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  let stdout = ''
  let stderr = ''
  proc.stdout.on('data', chunk => { stdout = tail(stdout + stdoutDecoder.write(chunk), PROCESS_OUTPUT_TAIL_LIMIT) })
  proc.stderr.on('data', chunk => { stderr = tail(stderr + stderrDecoder.write(chunk), PROCESS_OUTPUT_TAIL_LIMIT) })

  const finished = await waitForProcess(proc, opts.timeoutMs)
  stdout = tail(stdout + stdoutDecoder.end(), PROCESS_OUTPUT_TAIL_LIMIT)
  stderr = tail(stderr + stderrDecoder.end(), PROCESS_OUTPUT_TAIL_LIMIT)
  const status: AutomationProcessRecord['status'] = finished.error || finished.timedOut || finished.exitCode !== 0
    ? 'failed'
    : 'exited'
  const finalRecord: AutomationProcessRecord = {
    ...record,
    status,
    finishedAt: new Date().toISOString(),
    exitCode: finished.exitCode,
    signal: finished.signal,
    stdoutTail: stdout.trimEnd(),
    stderrTail: stderr.trimEnd(),
    error: finished.error ?? (finished.timedOut ? `${opts.kind} timed out after ${opts.timeoutMs / 1000}s` : undefined),
  }
  storeProcessRecord(opts.projectName, finalRecord)
  if (opts.taskGuid && opts.refKey) {
    markRunOnTask(opts.projectName, opts.taskGuid, opts.refKey, runId, opts.fingerprint, status, finalRecord.error)
  }
  return finalRecord
}

function waitForProcess(
  proc: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ exitCode: number | null; signal: string | null; timedOut?: boolean; error?: string }> {
  return new Promise(resolve => {
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | null = null
    const timeout = setTimeout(() => {
      if (settled) return
      proc.kill('SIGTERM')
      killTimer = setTimeout(() => {
        if (!settled) proc.kill('SIGKILL')
      }, KILL_AFTER_MS)
    }, timeoutMs)
    proc.on('error', err => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      resolve({ exitCode: null, signal: null, error: err.message })
    })
    proc.on('close', (code, signal) => {
      if (settled) return
      settled = true
      const timedOut = signal === 'SIGTERM' || signal === 'SIGKILL'
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      resolve({ exitCode: code, signal, timedOut })
    })
  })
}

async function loadStructuredTask(binding: TasklistBinding, sectionKey: TasklistSectionKey, taskGuid: string): Promise<unknown> {
  const task = await feishu.getTask(taskGuid)
  const comments = await feishu.listTaskComments(taskGuid)
  const ownCommentIds = ownRecordedCommentIds(getTaskState(binding.projectName, taskGuid))
  return {
    project: { name: binding.projectName, root: feishu.PROJECTS_ROOT },
    tasklist: {
      guid: binding.guid,
      name: binding.name,
      url: binding.url,
      section: tasklist.sectionNameForKey(sectionKey),
    },
    task,
    comments: comments.filter(comment => !ownCommentIds.has(comment.id)),
  }
}

function designFingerprint(structured: any): string {
  const task = structured?.task ?? {}
  return createHash('sha256')
    .update(JSON.stringify({
      summary: task.summary,
      description: task.description,
      due: task.due,
      members: task.members,
      comments: structured?.comments ?? [],
    }))
    .digest('hex')
}

function prepareAutomationWorktree(projectDir: string, projectName: string, branch: string): string {
  assertGitRepo(projectDir)
  const targetPath = join(dirname(projectDir), `${projectName}[${branch}]`)
  const baseHead = git(projectDir, ['rev-parse', 'HEAD']).trim()
  const mounted = parseWorktreeList(projectDir).get(branch) ?? null
  if (!hasBranch(projectDir, branch)) git(projectDir, ['branch', branch, 'HEAD'])
  if (mounted) {
    if (resolve(mounted) !== resolve(targetPath)) {
      throw new Error(`${branch} is already mounted at ${mounted}`)
    }
  } else {
    git(projectDir, ['worktree', 'add', targetPath, branch])
  }
  assertWorktreeBranch(targetPath, branch)
  assertCleanWorktree(targetPath)
  const unique = Number(git(targetPath, ['rev-list', '--count', `${baseHead}..HEAD`]).trim() || '0')
  if (unique > 0) {
    throw new Error(`${branch} has ${unique} commit(s) not reachable from project HEAD; merge or reset it before next automation run`)
  }
  git(targetPath, ['reset', '--hard', baseHead])
  return targetPath
}

function assertGitRepo(projectDir: string): void {
  const top = git(projectDir, ['rev-parse', '--show-toplevel']).trim()
  if (resolve(top) !== resolve(projectDir)) {
    throw new Error(`${projectDir} is not the git repository root (${top})`)
  }
}

function assertWorktreeBranch(worktreePath: string, branch: string): void {
  const actual = git(worktreePath, ['branch', '--show-current']).trim()
  if (actual !== branch) throw new Error(`${worktreePath} is on ${actual}, expected ${branch}`)
}

function assertCleanWorktree(worktreePath: string): void {
  const dirty = git(worktreePath, ['status', '--porcelain=v1']).split('\n').filter(Boolean)
  if (dirty.length > 0) throw new Error(`worktree has uncommitted changes:\n${dirty.slice(0, 8).join('\n')}`)
}

function hasBranch(projectDir: string, branch: string): boolean {
  try {
    git(projectDir, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

function parseWorktreeList(projectDir: string): Map<string, string> {
  const out = new Map<string, string>()
  let currentPath = ''
  for (const line of git(projectDir, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) currentPath = line.slice('worktree '.length)
    if (line.startsWith('branch refs/heads/') && currentPath) out.set(line.slice('branch refs/heads/'.length), currentPath)
  }
  return out
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    throw new Error(errorOutput(e))
  }
}

export function localReviewRef(baseBranch: string, headBranch: string): string {
  const base = baseBranch.trim()
  const head = headBranch.trim()
  if (!base) throw new Error('base branch is required for local review ref')
  if (!head) throw new Error('head branch is required for local review ref')
  return `local:${base}..${head}`
}

function hasLocalReviewRequest(state: TaskAutomationState): boolean {
  return Boolean(state.reviewRef || state.executionBranch)
}

function reviewRequestText(state: TaskAutomationState): string {
  if (state.reviewRef) return state.reviewRef
  if (state.executionBranch) return `local:HEAD..${state.executionBranch}`
  throw new Error('missing local review request')
}

function getTaskState(projectName: string, taskGuid: string): TaskAutomationState {
  const binding = tasklist.getTasklistBinding(projectName)
  if (!binding) throw new Error(`tasklist is not enabled for ${projectName}`)
  return binding.tasks?.[taskGuid] ?? { guid: taskGuid }
}

function safeUpdate(projectName: string, update: (binding: TasklistBinding) => void): void {
  try {
    tasklist.updateTasklistBinding(projectName, update)
  } catch (e) {
    log(`tasklist-worker: state update failed for ${projectName}: ${messageOf(e)}`)
  }
}

function storeProcessRecord(projectName: string, record: AutomationProcessRecord): void {
  safeUpdate(projectName, binding => {
    binding.processes ??= {}
    binding.processes[record.runId] = record
  })
}

function markProcessFailed(projectName: string, record: AutomationProcessRecord, error: string): AutomationProcessRecord {
  const failed: AutomationProcessRecord = {
    ...record,
    status: 'failed',
    error,
    finishedAt: record.finishedAt ?? new Date().toISOString(),
  }
  storeProcessRecord(projectName, failed)
  if (record.taskGuid) {
    const refKey = runRefKeyForProcess(record.kind)
    if (refKey) markRunOnTask(projectName, record.taskGuid, refKey, record.runId, undefined, 'failed', error)
  }
  return failed
}

function runRefKeyForProcess(kind: AutomationProcessRecord['kind']): RunRefKey | null {
  switch (kind) {
    case 'codex-plan': return 'codexPlan'
    case 'agy-plan': return 'agyPlan'
    case 'agy-pick': return 'agyPick'
    case 'codex-execute': return 'codexExecution'
    case 'agy-review': return 'agyReview'
    case 'codex-merge': return 'codexMerge'
  }
}

function markRunOnTask(
  projectName: string,
  taskGuid: string,
  key: RunRefKey,
  runId: string,
  fingerprint: string | undefined,
  status: AutomationProcessRecord['status'],
  error?: string,
): void {
  safeUpdate(projectName, binding => {
    const state = tasklist.taskStateFor(binding, taskGuid)
    state[key] = {
      ...(state[key] as TaskAutomationRunRef | undefined),
      runId,
      fingerprint,
      status,
      ...(status === 'running' ? { startedAt: new Date().toISOString() } : { finishedAt: new Date().toISOString() }),
      ...(error ? { error } : {}),
    }
  })
}

function markRunComment(projectName: string, taskGuid: string, key: RunRefKey, commentId: string): void {
  safeUpdate(projectName, binding => {
    const state = tasklist.taskStateFor(binding, taskGuid)
    const ref = state[key] as TaskAutomationRunRef | undefined
    if (ref) ref.commentId = commentId
  })
}

async function commentAndStoreError(projectName: string, taskGuid: string, error: string): Promise<void> {
  safeUpdate(projectName, binding => {
    const state = tasklist.taskStateFor(binding, taskGuid)
    state.lastError = error
  })
  const commentId = await feishu.addTaskComment(taskGuid, agentComment('Lodestar 自动化错误', error))
  safeUpdate(projectName, binding => {
    const state = tasklist.taskStateFor(binding, taskGuid)
    state.errorCommentIds = [...(state.errorCommentIds ?? []), commentId]
  })
}

function ownRecordedCommentIds(state: TaskAutomationState): Set<string> {
  const ids = [
    state.codexPlan?.commentId,
    state.agyPlan?.commentId,
    state.codexExecution?.commentId,
    state.agyReview?.commentId,
    state.codexMerge?.commentId,
    ...(state.errorCommentIds ?? []),
  ].filter((x): x is string => !!x)
  return new Set(ids)
}

function parseSelectedTaskGuid(output: string, allowed: string[]): string | null {
  try {
    const json = JSON.parse(output.trim())
    if (typeof json.task_guid === 'string' && allowed.includes(json.task_guid)) return json.task_guid
  } catch {}
  for (const guid of allowed) {
    if (output.includes(guid)) return guid
  }
  return null
}

function processFailureText(record: AutomationProcessRecord): string {
  return [
    record.error,
    `exit=${record.exitCode ?? 'null'} signal=${record.signal ?? 'null'} run=${record.runId} pid=${record.pid ?? 'unknown'}`,
    record.stderrTail ? `stderr:\n${tail(record.stderrTail, 4000)}` : '',
    record.stdoutTail ? `stdout:\n${tail(record.stdoutTail, 4000)}` : '',
  ].filter(Boolean).join('\n')
}

function displayCommand(command: string[]): string[] {
  if (command.length <= 1) return command
  return [...command.slice(0, -1), command[command.length - 1].length > 240 ? '<prompt>' : command[command.length - 1]]
}

function agentComment(title: string, content: string): string {
  return [
    `### ${title}`,
    '',
    trimForComment(content || '(empty)'),
  ].join('\n')
}

function trimForComment(content: string): string {
  const clean = sanitizeTaskCommentContent(content).trim()
  if (clean.length <= COMMENT_OUTPUT_LIMIT) return clean
  return `${clean.slice(0, COMMENT_OUTPUT_LIMIT)}\n\n[truncated ${clean.length - COMMENT_OUTPUT_LIMIT} chars]`
}

export function sanitizeTaskCommentContent(content: string): string {
  return content.replace(/\[([^\]\n]+)\]\(((?!https?:\/\/|applink:\/\/)[^)]+)\)/g, '$1')
}

function commitTitle(summary: string): string {
  const oneLine = summary.replace(/\s+/g, ' ').trim() || 'task'
  return `AI-AUTO: ${oneLine.slice(0, 80)}`
}

function jsonBlock(value: unknown): string {
  return fenced(JSON.stringify(value, null, 2), 'json')
}

function fenced(content: string, lang = ''): string {
  return '```' + lang + '\n' + content.replace(/```/g, '`\\`\\`') + '\n```'
}

function tail(s: string, limit: number): string {
  return s.length <= limit ? s : s.slice(s.length - limit)
}

function errorOutput(e: unknown): string {
  if (e && typeof e === 'object') {
    const any = e as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string }
    const stderr = any.stderr ? String(any.stderr).trim() : ''
    const stdout = any.stdout ? String(any.stdout).trim() : ''
    if (stderr) return stderr
    if (stdout) return stdout
    if (any.message) return any.message
  }
  return String(e)
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
