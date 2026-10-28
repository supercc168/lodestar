/** Recursive delegation retains project/chat ancestry, native tools,
 * caller-owned delivery and the binding-specific input boundary.
 * Native SDK launch probes run in isolated local child processes. */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentIdentity, AgentIdentityCatalog } from './agent-identities'
import { AgentService, type AgentServiceDeps } from './agent-service'
import type { AgentWorkerHandle, AgentWorkerResult } from './agent-runner'
import { DELEGATED_AGENT_INSTRUCTIONS } from './agent-skill'
import { AGENT_RUNS_DIR } from './paths'

// ③ 的 codex 构造接线依赖(沿用本地原版动态引入形态)。
const { buildCodexAppServerArgs, CodexProcess } = await import('./codex-process')

/** 子进程 cwd 固定为仓库根:--preload ./src/test-preload.ts 与脚本内 import './src/...'
 *  都以它解析,不受调用目录影响。 */
const repoRoot = join(import.meta.dir, '..')

function runIsolated(script: string): any {
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: repoRoot, env: { ...process.env, NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString())
  return JSON.parse(result.stdout.toString().trim().split('\n').at(-1)!)
}

test('the Claude SDK retains native delegation while enforcing the invocation input policy', () => {
  const captured = runIsolated(`
    import { mock } from 'bun:test'
    const captured = []
    mock.module('@anthropic-ai/claude-agent-sdk', () => ({
      query: ({ options }) => {
        captured.push({ disallowedTools: options.disallowedTools ?? null, tools: options.tools, effort: options.effort,
          systemPrompt: options.systemPrompt })
        return { async *[Symbol.asyncIterator]() {}, close() {} }
      },
    }))
    const { ClaudeAgentProcess } = await import('./src/claude-agent-process')
    for (const policy of [{}, { allowUserInput: false }]) {
      const proc = new ClaudeAgentProcess({ workDir: process.cwd(), effort: 'high', appendSystemPrompt: 'current invocation policy', ...policy })
      const closed = new Promise(resolve => proc.once('exit', resolve))
      proc.sendInitialize()
      await closed
    }
    console.log(JSON.stringify(captured))
  `)
  expect(captured).toEqual([
    { disallowedTools: null, tools: { type: 'preset', preset: 'claude_code' }, effort: 'high',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'current invocation policy', snapshot: false } },
    { disallowedTools: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'], tools: { type: 'preset', preset: 'claude_code' }, effort: 'high',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'current invocation policy', snapshot: false } },
  ])
})

test('new and resumed workers use binding-specific delegation, caller-owned delivery and input policy across all backends', () => {
  const captured = runIsolated(`
    import { mock } from 'bun:test'
    import { EventEmitter } from 'node:events'
    const captured = []
    mock.module('./src/token-source', () => ({ listTokenSources: () => [], getTokenSourceForAccount: () => ({ id: 'test-source' }) }))
    mock.module('./src/agent-session-registry', () => ({ rememberAgentSession() {}, isAgentSession: () => false }))
    mock.module('./src/agent-launch', () => ({ createAgentProcess: options => {
      captured.push({ allowUserInput: options.allowUserInput, allowDelegation: options.allowDelegation,
        instructions: options.developerInstructions, role: options.hostEnv.LODESTAR_AGENT_ROLE, model: options.model,
        effort: options.effort, codexAccountId: options.codexAccountId, launch: options.launch })
      const proc = new EventEmitter()
      Object.assign(proc, { provider: options.provider, sessionId: 'test-session', alive: true,
        isAlive() { return this.alive }, sendInitialize() {},
        sendUserText() { queueMicrotask(() => this.emit('result', { is_error: false })) },
        async kill() { this.alive = false; this.emit('exit', { code: 0 }) },
      })
      return { process: proc }
    } }))
    const { startAgentWorker } = await import('./src/agent-runner')
    for (const provider of ['codex', 'claude', 'dsh']) {
      for (const projectBound of [false, true]) {
        for (const resumeSessionId of [undefined, 'test-session']) {
          await startAgentWorker({ identity: { id: 'agent:test', tokenSourceId: 'test-source', provider, model: 'worker-model', supportedEfforts: ['high'] },
            projectBound, resumeSessionId, effort: 'high', codexAccountId: 'named-work', workDir: process.cwd(),
            prompt: 'task', developerInstructions: 'project rule', hostEnv: { LODESTAR_AGENT_ROLE: 'main' } }).done
        }
      }
    }
    console.log(JSON.stringify(captured))
  `)
  expect(captured).toHaveLength(12)
  expect(captured.map((launch: any) => launch.allowUserInput)).toEqual([
    true, true, false, false, true, true, false, false, true, true, false, false,
  ])
  expect(captured.filter((launch: any) => launch.launch.kind === 'resume')).toHaveLength(6)
  for (const launch of captured) {
    // Both bindings retain native delegation unless explicitly opted out.
    expect(launch.allowDelegation).not.toBe(false)
    expect(launch.role).toBe('worker')
    expect(launch.model).toBe('worker-model')
    expect(launch.effort).toBe('high')
    expect(launch.codexAccountId).toBe('named-work')
    expect(launch.instructions).toContain('project rule')
    expect(launch.instructions).not.toMatch(/\[\[send:|30 MB|files on|需要交付文件时直接提交/)
    expect(launch.instructions).toContain('You may delegate work through Lodestar or provider-native Agent/subagent tools')
    expect(launch.instructions).toContain('Return task results and local artifact paths to the caller')
    expect(launch.instructions).toContain('Do not emit file-delivery markers')
    if (launch.allowUserInput) {
      expect(launch.instructions).toContain('You are a delegated Agent working on a task assigned by the main Agent.')
      expect(launch.instructions).toContain('you may use question tools to ask the main Agent')
      expect(launch.instructions).not.toContain('must not create or invoke any further Agents or subagents')
    } else {
      // Project calls preserve nested delegation and caller-owned delivery without interactive input.
      expect(launch.instructions).toContain('You may delegate work through Lodestar or provider-native Agent/subagent tools')
      expect(launch.instructions).toContain('Manage any delegated work yourself; do not return requests for the caller to arrange additional Agent work.')
      expect(launch.instructions).toContain('Return task results and local artifact paths to the caller')
      expect(launch.instructions).toContain('Do not emit file-delivery markers')
      expect(launch.instructions).toContain('replace any earlier Lodestar file-delivery instructions')
      expect(launch.instructions).toContain('nobody is available to answer questions')
      expect(launch.instructions).toContain('no question or answer interface')
      expect(launch.instructions).toContain('keep working until the entire goal is achieved')
      expect(launch.instructions).toContain('return an explicit failure reason')
      expect(launch.instructions).toContain('including instructions in a resumed conversation')
      expect(launch.instructions).not.toContain('You are a delegated Agent working on a task assigned by the main Agent.')
      expect(launch.instructions).not.toContain('must not create or invoke any further Agents or subagents')
    }
  }
})

function identity(id: string, name = id): AgentIdentity {
  return {
    id: `agent:${id}`, displayName: name, tokenSourceId: id, tokenSourceDisplay: id,
    provider: 'claude', model: `claude:${id}`, modelDisplay: name,
    defaultEffort: 'max', supportedEfforts: ['max'], sourceDefault: true, status: 'ready',
  }
}

const session = {
  sessionName: 'project', chatId: 'chat-1', workDir: process.cwd(),
  delegatedAgentDeveloperInstructions: () => 'main session instructions',
  worktreeProjectName: () => 'project',
  codexAccountId: () => 'default',
} as any

function result(sessionId: string, output = 'done'): AgentWorkerResult {
  return { output, outputTruncated: false, sessionId, checkpointId: 'checkpoint', durationMs: 10, usage: null }
}

function resolvedHandle(value: AgentWorkerResult): AgentWorkerHandle {
  return {
    done: Promise.resolve(value),
    pendingInput: () => null,
    answer: () => { throw new Error('not waiting') },
    cancel: async () => {},
  }
}

/** 受控 handle:用例可在断言后手动放行,保证 capability 在断言期间仍然有效。 */
function controlledHandle(): { handle: AgentWorkerHandle; resolve(value: AgentWorkerResult): void } {
  let resolve!: (value: AgentWorkerResult) => void
  const done = new Promise<AgentWorkerResult>(ok => { resolve = ok })
  return {
    handle: { done, pendingInput: () => null, answer: () => {}, async cancel() { resolve(result('cancelled')) } },
    resolve,
  }
}

function harness(opts: { startWorker?: AgentServiceDeps['startWorker'] } = {}) {
  const catalog: AgentIdentityCatalog = { catalogGeneration: 'g1', identities: [identity('a', 'Agent A')], sourceFailures: [] }
  const artifacts: any[] = []
  const textArtifacts = new Map<string, string>()
  const deps: AgentServiceDeps = {
    getCatalog: () => catalog,
    startWorker: opts.startWorker ?? (worker => resolvedHandle(result(`sid-${worker.identity.id}`, `output-${worker.identity.id}`))),
    sendCard: async () => 'message-1',
    sendTextRaw: async () => true,
    getChatTailMessageId: async () => null,
    getElementCount: () => 1,
    addElementResult: async () => ({ landed: true }),
    deleteElementChecked: async () => true,
    convertMessageToCard: async () => 'card-1',
    recordCardCreated: () => {},
    replaceElementResult: async () => ({ landed: true }),
    cancelSummary: () => {},
    patchSettingsChecked: async () => true,
    dispose: async () => {},
    writeArtifact: (_path, value) => { artifacts.push(JSON.parse(JSON.stringify(value))) },
    writeTextArtifact: (path, value) => { textArtifacts.set(path, value) },
    readTextArtifact: (name, label) => {
      const text = textArtifacts.get(join(AGENT_RUNS_DIR, name))
      if (text === undefined) throw new Error(`${label} is unreadable (${name})`)
      return text
    },
    loadArtifacts: () => [],
  }
  const service = new AgentService(deps)
  return { service, root: service.rootPrincipal(session), artifacts }
}

async function waitForStatus(
  service: InstanceType<typeof AgentService>,
  root: any,
  runId: string,
  status: string,
) {
  for (let i = 0; i < 200; i++) {
    const run = service.getRun(root, runId)
    if (run.status === status) return run
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error(`run ${runId} did not reach ${status}`)
}

/** 借父 run 的委派能力取回 worker principal(真实链路:capability → principal)。 */
async function delegatedWorker(makeHandle: () => AgentWorkerHandle) {
  let capability = ''
  const { service, root, artifacts } = harness({
    startWorker: opts => {
      capability = String(opts.hostEnv.LODESTAR_AGENT_CAPABILITY)
      return makeHandle()
    },
  })
  const parent = await service.startRun(root, { identityIds: ['agent:a'], prompt: 'parent', description: 'parent run' })
  for (let i = 0; i < 200 && !capability; i++) await new Promise(resolve => setTimeout(resolve, 1))
  expect(capability).not.toBe('')
  const worker = service.principalForCapability(capability)
  expect(worker).not.toBeNull()
  return { service, root, artifacts, parent, worker: worker! }
}

describe('recursive worker delegation and explicit native capability controls', () => {
  test('worker admission creates a bound descendant and cancellation reaches it', async () => {
    const controls: ReturnType<typeof controlledHandle>[] = []
    const { service, root, parent, worker } = await delegatedWorker(() => {
      const control = controlledHandle(); controls.push(control); return control.handle
    })
    try {
      const child = await service.startRun(worker, { identityIds: ['agent:a'], prompt: 'nested', description: 'nested run' })
      expect(child).toMatchObject({ parentRunId: parent.runId, parentKind: 'delegate', depth: 1, chatId: parent.chatId })
      await service.cancelRun(root, parent.runId, 'cancel descendants')
      expect(service.getRun(root, child.runId).status).toBe('cancelled')
    } finally { await service.shutdown('test cleanup') }
  })

  test('worker can follow up its completed descendant while retaining ancestry', async () => {
    const controls: ReturnType<typeof controlledHandle>[] = []
    const { service, root, parent, worker } = await delegatedWorker(() => {
      const control = controlledHandle(); controls.push(control); return control.handle
    })
    try {
      const child = await service.startRun(worker, { identityIds: ['agent:a'], prompt: 'nested', description: 'nested run' })
      for (let i = 0; i < 200 && controls.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 1))
      controls[1]!.resolve(result('sid-child'))
      await waitForStatus(service, root, child.runId, 'completed')
      const next = await service.followUp(worker, child.runId, { prompt: 'continue child', description: 'nested follow-up' })
      expect(next).toMatchObject({ parentRunId: parent.runId, parentKind: 'delegate', depth: 1, resumedFromRunId: child.runId })
      await service.cancelRun(root, parent.runId)
      expect(service.getRun(root, next.runId).status).toBe('cancelled')
    } finally { await service.shutdown('test cleanup') }
  })

  test('③ Codex 显式opt-out关闭委派，默认档保持原生能力', () => {
    const restrictedArgs = buildCodexAppServerArgs(['-c', 'model_provider="x"'], false)
    expect(restrictedArgs.slice(restrictedArgs.indexOf('--disable'), restrictedArgs.indexOf('--disable') + 2))
      .toEqual(['--disable', 'multi_agent'])
    expect(restrictedArgs.indexOf('--disable')).toBeLessThan(restrictedArgs.indexOf('--listen'))
    expect(buildCodexAppServerArgs(['-c', 'model_provider="x"'])).not.toContain('--disable')

    // threadParams 经原型构造即可观察(不 spawn 子进程)。
    const restricted = Object.create(CodexProcess.prototype) as any
    restricted.opts = { workDir: '/tmp', effort: 'high', serviceName: 'lodestar-agent', allowDelegation: false }
    expect(restricted.threadParams().config['features.multi_agent']).toBe(false)
    const normal = Object.create(CodexProcess.prototype) as any
    normal.opts = { workDir: '/tmp', effort: 'high', serviceName: 'lodestar-agent' }
    expect('features.multi_agent' in normal.threadParams().config).toBe(false)

    // 构造接线:CodexProcess 必须把 opts.allowDelegation 透传给参数拼装。
    const source = readFileSync(join(import.meta.dir, 'codex-process.ts'), 'utf8')
    expect(source).toContain('buildCodexAppServerArgs(opts.configArgs, opts.allowDelegation)')
  })

  test('④ Claude 显式opt-out关闭委派，默认档保持原生能力', () => {
    const captured = runIsolated(`
      import { mock } from 'bun:test'
      const captured = []
      mock.module('@anthropic-ai/claude-agent-sdk', () => ({
        query: ({ options }) => {
          captured.push({ disallowedTools: options.disallowedTools ?? null })
          return { async *[Symbol.asyncIterator]() {}, close() {} }
        },
      }))
      const { registerTokenSource } = await import('./src/token-source')
      registerTokenSource({ id: 'claude:fable', kind: 'api', agent: 'claude', display: 'Fable', enabled: true,
        models: [{ model: 'claude:fable', display: 'Fable', efforts: ['max'], defaultEffort: 'max' }],
        defaultModel: 'claude:fable', refreshModels: async () => {}, spawnEnv: env => env,
        resolveSpawnModel: model => model, readUsage: async () => ({ state: 'not_applicable', windows: [] }),
        modelCatalogState: { status: 'ready', updatedAt: Date.now() } })
      const { createAgentProcess } = await import('./src/agent-launch')
      for (const policy of [{}, { allowDelegation: false }]) {
        const { process: proc } = createAgentProcess({ provider: 'claude', workDir: process.cwd(),
          tokenSourceId: 'claude:fable', model: 'claude:fable', effort: 'max', ...policy })
        const closed = new Promise(resolve => proc.once('exit', resolve))
        proc.sendInitialize()
        await closed
      }
      console.log(JSON.stringify(captured))
    `)
    expect(captured).toEqual([{ disallowedTools: null }, { disallowedTools: ['Agent', 'Task'] }])
  })

  test('⑤ 主 Agent(session principal)仍可委派并审批 follow-up', async () => {
    const { service, root } = harness()
    const started = await service.startRun(root, { identityIds: ['agent:a'], prompt: 'main', description: 'main run' })
    expect(started.depth).toBe(0)
    expect(started.parentRunId).toBeUndefined()
    await waitForStatus(service, root, started.runId, 'completed')
    const followUp = await service.followUp(root, started.runId, { identityId: 'agent:a', prompt: 'continue', description: 'continue run' })
    expect(followUp).toMatchObject({ parentKind: 'follow_up', parentRunId: started.runId, depth: 0 })
    await waitForStatus(service, root, followUp.runId, 'completed')
    await service.shutdown('test cleanup')
  })

  test('⑥ worker 真实启动保留委派，仅项目归属禁用交互工具', () => {
    const captured = runIsolated(`
      import { mock } from 'bun:test'
      const captured = []
      mock.module('@anthropic-ai/claude-agent-sdk', () => ({
        query: ({ options }) => {
          captured.push({ disallowedTools: options.disallowedTools ?? null })
          return { async *[Symbol.asyncIterator]() {}, close() {} }
        },
      }))
      const { registerTokenSource } = await import('./src/token-source')
      registerTokenSource({ id: 'claude:fable', kind: 'api', agent: 'claude', display: 'Fable', enabled: true,
        models: [{ model: 'claude:fable', display: 'Fable', efforts: ['max'], defaultEffort: 'max' }],
        defaultModel: 'claude:fable', refreshModels: async () => {}, spawnEnv: env => env,
        resolveSpawnModel: model => model, readUsage: async () => ({ state: 'not_applicable', windows: [] }),
        modelCatalogState: { status: 'ready', updatedAt: Date.now() } })
      const { startAgentWorker } = await import('./src/agent-runner')
      for (const projectBound of [false, true]) {
        const handle = startAgentWorker({
          identity: { tokenSourceId: 'claude:fable', provider: 'claude', model: 'claude:fable',
            supportedEfforts: ['max'], displayName: 'Fable' },
          projectBound, effort: 'max', codexAccountId: 'default', workDir: process.cwd(),
          prompt: 'task', developerInstructions: 'project rule', hostEnv: {},
        })
        await handle.done.catch(() => {})
      }
      console.log(JSON.stringify(captured))
    `)
    expect(captured).toEqual([
      { disallowedTools: null },
      { disallowedTools: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'] },
    ])
  })

  test('⑦ worker 身份:ROLE/capability在 service 边界下发,指令注入点归 runner', async () => {
    const seen: Array<{
      developerInstructions?: string
      hostEnv: Record<string, string | undefined>
      allowDelegation?: boolean
      projectBound?: boolean
    }> = []
    const { service, root } = harness({
      startWorker: opts => {
        seen.push({ developerInstructions: opts.developerInstructions, hostEnv: opts.hostEnv, allowDelegation: opts.allowDelegation, projectBound: opts.projectBound })
        return resolvedHandle(result(`sid-${opts.identity.id}`))
      },
    })
    const started = await service.startRun(root, { identityIds: ['agent:a'], prompt: 'worker identity', description: 'worker identity' })
    await waitForStatus(service, root, started.runId, 'completed')
    await service.shutdown('test cleanup')

    expect(seen).toHaveLength(1)
    // service 边界只透传会话指令(worker 的 DELEGATED 文案由 runner 注入,见上文 12 连发用例
    // 对 projectBound 两分支的全文断言);此处若注入提前发生,捕获值会被污染。
    const instructions = seen[0].developerInstructions!
    expect(instructions).toBe('main session instructions')
    expect(instructions).not.toContain(DELEGATED_AGENT_INSTRUCTIONS)
    expect(seen[0].hostEnv.LODESTAR_AGENT_ROLE).toBe('worker')
    expect(seen[0].hostEnv.LODESTAR_AGENT_CAPABILITY).toBeTruthy()
    expect(seen[0].allowDelegation).not.toBe(false)
    expect(seen[0].projectBound).toBe(false)

    // 主 Agent 环境由 session.ts 写 ROLE='main'(与 worker 'worker' 对置):源码级钉住。
    const sessionSource = readFileSync(join(import.meta.dir, 'session.ts'), 'utf8')
    expect(sessionSource).toContain("LODESTAR_AGENT_ROLE: 'main'")
    expect(sessionSource).toContain('LODESTAR_AGENT_CAPABILITY')
  })
})
