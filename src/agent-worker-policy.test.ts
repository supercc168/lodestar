/**
 * D-11 口径 3「单层委派」回归网(上游 378f4a4 摘录自实现)。
 *
 * 三层齐备,拒绝面各验其一:
 *  ① 策略层 —— worker principal 的 startRun/followUp 首行即拒,绝不建 run;
 *  ② 原生工具层 —— claude `disallowedTools` / codex `--disable multi_agent` + thread config;
 *  ③ 指令层 —— 见 agent-skill.test.ts(DELEGATED_AGENT_INSTRUCTIONS 已并入 worker developerInstructions)。
 * 深度/子树闸门只作源码级兜底:策略拒绝先行后执行不可达,故仅断言源码仍在
 * (与 D-11 口径 3 的 truth 措辞一致,不做"可达性"表演性用例)。
 */
import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentIdentity, AgentIdentityCatalog } from './agent-identities'
import type { AgentServiceDeps } from './agent-service'
import type { AgentWorkerHandle, AgentWorkerResult } from './agent-runner'

const NESTED_DELEGATION_ERROR = 'Delegated Agents cannot delegate again; ask the main Agent to assign additional work.'

// SDK 侧只记录 query options(claude 的进程内查询,不需要 spawn)。
// 注意:本文件**不** mock `node:child_process` —— 同进程全量 `bun test` 下
// 该 mock 会漂到 tasklist/executable 等真实 spawn 的用例上(实测 4+1 fail)。
const claudeSdkOptions: any[] = []

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (options: any) => {
    claudeSdkOptions.push(options)
    return { [Symbol.asyncIterator]: async function* () {}, close() {} }
  },
}))

const { createAgentProcess } = await import('./agent-launch')
const { AgentService } = await import('./agent-service')
const { startAgentWorker } = await import('./agent-runner')
const { buildCodexAppServerArgs, CodexProcess } = await import('./codex-process')
const { config } = await import('./config')

function identity(id: string, name = id): AgentIdentity {
  return {
    id: `agent:${id}`, displayName: name, tokenSourceId: id, tokenSourceDisplay: id,
    provider: 'claude', model: `claude:${id}`, modelDisplay: name,
    defaultEffort: 'max', supportedEfforts: ['max'], sourceDefault: true, status: 'ready',
  }
}

const session = { sessionName: 'project', chatId: 'chat-1', workDir: '/repo' } as any

function result(sessionId: string, output = 'done'): AgentWorkerResult {
  return { output, outputTruncated: false, sessionId, checkpointId: 'checkpoint', durationMs: 10, usage: null }
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

function harness(
  startWorker?: AgentServiceDeps['startWorker'],
  identities: AgentIdentity[] = [identity('a', 'Agent A')],
) {
  const catalog: AgentIdentityCatalog = { catalogGeneration: 'g1', identities, sourceFailures: [] }
  const artifacts: any[] = []
  const deps: AgentServiceDeps = {
    getCatalog: () => catalog,
    startWorker: startWorker ?? (worker => ({
      done: Promise.resolve(result(`sid-${worker.identity.id}`, `output-${worker.identity.id}`)),
      pendingInput: () => null,
      answer: () => {},
      cancel: async () => {},
    })),
    sendCard: async () => 'message-1',
    sendTextRaw: async () => true,
    convertMessageToCard: async () => 'card-1',
    recordCardCreated: () => {},
    replaceElementChecked: async () => true,
    patchSummaryThrottled: () => {},
    flush: async () => {},
    cancelSummary: () => {},
    patchSettingsChecked: async () => true,
    dispose: async () => {},
    writeArtifact: (_path, value) => { artifacts.push(JSON.parse(JSON.stringify(value))) },
    writeTextArtifact: () => {},
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
  const { service, root, artifacts } = harness(opts => {
    capability = String(opts.hostEnv.LODESTAR_AGENT_CAPABILITY)
    return makeHandle()
  })
  const parent = await service.startRun(root, { identityIds: ['agent:a'], prompt: 'parent' })
  for (let i = 0; i < 200 && !capability; i++) await new Promise(resolve => setTimeout(resolve, 1))
  expect(capability).not.toBe('')
  const worker = service.principalForCapability(capability)
  expect(worker).not.toBeNull()
  return { service, root, artifacts, parent, worker: worker!, capability }
}

describe('D-11 口径 3:单层委派(策略 + 原生工具两层拒绝)', () => {
  test('① worker principal 再委派在策略层被拒,深度/子树闸门仅作源码兜底', async () => {
    const control = controlledHandle()
    const { service, root, artifacts, parent, worker } = await delegatedWorker(() => control.handle)
    expect(worker.kind).toBe('worker')
    const before = artifacts.map(item => item.runId).filter(Boolean)
    await expect(service.startRun(worker, { identityIds: ['agent:a'], prompt: 'nested' }))
      .rejects.toThrow(NESTED_DELEGATION_ERROR)
    // 拒绝先于建 run:无任何新 run 落盘。
    expect(artifacts.map(item => item.runId).filter(Boolean)).toEqual(before)
    control.resolve(result('sid-child'))
    await waitForStatus(service, root, parent.runId, 'completed')
    await service.shutdown('test cleanup')

    const source = readFileSync(join(import.meta.dir, 'agent-service.ts'), 'utf8')
    expect(source).toContain('const MAX_DELEGATION_DEPTH = 8')
    expect(source).toContain('delegation depth ${depth} exceeds ${MAX_DELEGATION_DEPTH}')
    expect(source).toContain('const MAX_SUBTREE_ACTIVE_RUNS = 32')
    expect(source).toContain('Agent subtree has reached ${MAX_SUBTREE_ACTIVE_RUNS} active runs')
  })

  test('② worker principal 不能借 follow-up 曲线再委派', async () => {
    const control = controlledHandle()
    const { service, root, parent, worker } = await delegatedWorker(() => control.handle)
    await expect(service.followUp(worker, parent.runId, { identityId: 'agent:a', prompt: 'nested follow-up' }))
      .rejects.toThrow(NESTED_DELEGATION_ERROR)
    control.resolve(result('sid-child'))
    await waitForStatus(service, root, parent.runId, 'completed')
    await service.shutdown('test cleanup')
  })

  test('③ codex worker 的启动参数与 thread config 同时关闭委派,默认档不受影响', () => {
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

  test('④ claude worker 在 SDK 层禁用原生委派工具,主 Agent 不受影响', () => {
    const prevModels = config.claude.models
    ;(config.claude as any).models = {
      glm: { model: 'glm-5.3', base_url: 'https://glm.example/anthropic', auth_token: 'glm-tok' },
    }
    try {
      claudeSdkOptions.length = 0
      const { process: restricted } = createAgentProcess({
        provider: 'claude', workDir: '/tmp/claude-work', tokenSourceId: 'claude:glm',
        model: 'claude:glm', effort: 'max', allowDelegation: false,
      })
      ;(restricted as any).sendInitialize()
      expect(claudeSdkOptions.at(-1)?.options.disallowedTools).toEqual(['Agent', 'Task'])

      claudeSdkOptions.length = 0
      const { process: normal } = createAgentProcess({
        provider: 'claude', workDir: '/tmp/claude-work', tokenSourceId: 'claude:glm',
        model: 'claude:glm', effort: 'max',
      })
      ;(normal as any).sendInitialize()
      expect(claudeSdkOptions.at(-1)?.options.disallowedTools).toBeUndefined()
    } finally {
      ;(config.claude as any).models = prevModels
    }
  })

  test('⑤ 主 Agent(session principal)仍可委派并审批 follow-up', async () => {
    const { service, root } = harness()
    const started = await service.startRun(root, { identityIds: ['agent:a'], prompt: 'main' })
    expect(started.depth).toBe(0)
    expect(started.parentRunId).toBeUndefined()
    await waitForStatus(service, root, started.runId, 'completed')
    const followUp = await service.followUp(root, started.runId, { identityId: 'agent:a', prompt: 'continue' })
    expect(followUp).toMatchObject({ parentKind: 'follow_up', parentRunId: started.runId, depth: 0 })
    await waitForStatus(service, root, followUp.runId, 'completed')
    await service.shutdown('test cleanup')
  })

  test('⑦ worker 身份:指令文案、ROLE 环境与原生工具开关同帧下发,主 Agent 不附加', async () => {
    const { DELEGATED_AGENT_INSTRUCTIONS } = await import('./agent-skill')
    const { spawnDeveloperInstructions } = await import('./session-worktree')
    const seen: Array<{ developerInstructions?: string; hostEnv: Record<string, string | undefined>; allowDelegation?: boolean }> = []
    const { service, root } = harness(opts => {
      seen.push({ developerInstructions: opts.developerInstructions, hostEnv: opts.hostEnv, allowDelegation: opts.allowDelegation })
      return {
        done: Promise.resolve(result(`sid-${opts.identity.id}`)),
        pendingInput: () => null,
        answer: () => {},
        cancel: async () => {},
      }
    })
    const started = await service.startRun(root, { identityIds: ['agent:a'], prompt: 'worker identity' })
    await waitForStatus(service, root, started.runId, 'completed')
    await service.shutdown('test cleanup')

    expect(seen).toHaveLength(1)
    expect(seen[0].developerInstructions).toContain(DELEGATED_AGENT_INSTRUCTIONS)
    expect(seen[0].developerInstructions).toContain('You are a delegated Agent working on a task assigned by the main Agent.')
    expect(seen[0].developerInstructions).toContain('must not create or invoke any further Agents or subagents')
    expect(seen[0].hostEnv.LODESTAR_AGENT_ROLE).toBe('worker')
    expect(seen[0].hostEnv.LODESTAR_AGENT_CAPABILITY).toBeTruthy()
    expect(seen[0].allowDelegation).toBe(false)

    // 主 Agent 不附加该文案:主 Agent 指令由 session-worktree 构造,不含 worker 文案。
    expect(spawnDeveloperInstructions(session, 'claude')).not.toContain(DELEGATED_AGENT_INSTRUCTIONS)
    // 主 Agent 环境不含 worker role(主 Agent 走 session.ts 自有 hostEnv)。
    const sessionSource = readFileSync(join(import.meta.dir, 'session.ts'), 'utf8')
    const mainEnvBlock = sessionSource.slice(
      sessionSource.indexOf('const hostEnv = {'),
      sessionSource.indexOf("if (provider === 'claude')"),
    )
    expect(mainEnvBlock).toContain('LODESTAR_AGENT_CAPABILITY')
    expect(mainEnvBlock).not.toContain('LODESTAR_AGENT_ROLE')
  })

  test('⑥ 贯通:worker 真实启动链路(AgentService → runner → launch → SDK)禁用委派', async () => {
    const prevModels = config.claude.models
    ;(config.claude as any).models = {
      glm: { model: 'glm-5.3', base_url: 'https://glm.example/anthropic', auth_token: 'glm-tok' },
    }
    try {
      claudeSdkOptions.length = 0
      const { service, root } = harness(startAgentWorker, [{ ...identity('glm'), tokenSourceId: 'claude:glm' }])
      const started = await service.startRun(root, { identityIds: ['agent:glm'], prompt: 'delegate' })
      await waitForStatus(service, root, started.runId, 'failed')
      expect(claudeSdkOptions.at(-1)?.options.disallowedTools).toEqual(['Agent', 'Task'])
      await service.shutdown('test cleanup')
    } finally {
      ;(config.claude as any).models = prevModels
    }
  })
})
