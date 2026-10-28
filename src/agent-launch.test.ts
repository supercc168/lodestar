import { describe, expect, mock, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import * as codexProcess from './codex-process'
import type { TokenSource } from './token-source'
import './token-source-openrouter'

// codex-process 在本文件被 mock.module 顶替(构造期替身,见下)。prototype 级单测
// (threadParams 线格式)需要真实类,故在 mock 注册前捕获原始引用。
const RealCodexProcess = codexProcess.CodexProcess

// ── 子进程替身 ─────────────────────────────────────────────────────────
// 各后端都在构造期真实 spawn(app-server / dsh runtime / reclaude):用例只验
// agent-launch 的接线面,故用替身顶掉进程创建。spread 保留其余真实实现。
mock.module('node:child_process', () => {
  const actual = require('node:child_process') as typeof import('node:child_process')
  return {
    ...actual,
    spawn: () => {
      const child = new EventEmitter() as any
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.stdin = new PassThrough()
      child.pid = 4242
      child.kill = () => true
      return child
    },
  }
})

// CodexProcess 构造即拉起 app-server,且测试树内没有 codex runtime(resolveCodexBin
// 会抛):同上游用例的子进程替身只顶掉构造函数,其余导出(CODEX_* 常量)保持真实。
// 注意:bun 的 mock.module 在同 worker 内跨文件可见(session.test.ts 同 worker 时
// 其 listCodexConversations 用例会 spy 原型),Fake 需带同名方法面供 spyOn 正常钉。
mock.module('./codex-process', () => ({
  ...codexProcess,
  CodexProcess: class FakeCodexProcess extends EventEmitter {
    readonly provider = 'codex'
    readonly opts: any
    constructor(opts: any) { super(); this.opts = opts }
    isAlive() { return false }
    async listConversations(): Promise<never> { throw new Error('listConversations not mocked in agent-launch tests') }
    async kill(): Promise<void> {}
  },
}))

// DSH 后端在构造期就拉起子进程(dsh-runtime 的构造函数即 spawn node):用例只验
// 接线面,故像 dsh-process.test.ts 的假 runtime 一样用替身顶掉 DshProcess。
mock.module('./dsh-process', () => ({
  DshProcess: class FakeDshProcess {
    readonly provider = 'dsh'
    readonly opts: any
    constructor(opts: any) { this.opts = opts }
  },
}))

const { createAgentProcess } = await import('./agent-launch')
const { ClaudeAgentProcess } = await import('./claude-agent-process')
const { CodexProcess } = await import('./codex-process')
const {
  delegatedAgentDeveloperInstructions,
  spawnDeveloperInstructions,
} = await import('./session-worktree')
const { CHANNEL_INSTRUCTIONS, CLAUDE_CHANNEL_INSTRUCTIONS } = await import('./instructions')
const {
  listTokenSources,
  registerTokenSource,
  resetTokenSourceRegistry,
  scrubAnthropicEnv,
  tokenSourceFactories,
} = await import('./token-source')
await import('./token-source-dsh')
const worktree = await import('./worktree')

// session-worktree 的 spawnDeveloperInstructions 两侧签名不同(本地 1 参 / 上游
// 3 参且后参有默认语义)。断言只依赖返回值,按上游调用形(带 mode)执行、兼容两侧。
const spawnInstructions = spawnDeveloperInstructions as unknown as (s: unknown, mode?: unknown) => string
import { config } from './config'
test('Claude launches reject an unbound local-config route', () => {
  expect(() => createAgentProcess({ provider: 'claude', tokenSourceId: null,
    workDir: '/tmp', model: 'opus', effort: 'high' })).toThrow('Claude 账号来源未选择')
})

test.each([false, true])('main and delegated launches translate only explicitly enabled subscriptions (enabled=%s)', enabled => {
  const previous = listTokenSources()
  const previousSafeMode = config.claude.safe_mode
  config.claude.safe_mode = enabled ? { 'claude-sub': ['*'] } : {}
  try {
    for (const id of ['claude-sub', 'glm']) {
      const source: TokenSource = {
        id, kind: id === 'claude-sub' ? 'claude-subscription' : 'test', agent: 'claude', display: id, enabled: true,
        models: [{ model: 'test-model', display: 'Test', efforts: ['high'], defaultEffort: 'high' }],
        defaultModel: 'test-model', modelCatalogState: { status: 'ready', updatedAt: 1 },
        refreshModels: async () => {}, spawnEnv: env => ({ ...env, ANTHROPIC_BASE_URL: `https://${id}.test/api/anthropic` }),
        resolveSpawnModel: model => model,
        readUsage: async () => ({ state: 'not_applicable', windows: [] }),
      }
      registerTokenSource(source)
      for (const serviceName of [undefined, 'lodestar-agent']) {
        for (const profile of [undefined, { tools: 'Read' }]) {
          const created = createAgentProcess({ provider: 'claude', tokenSourceId: id, workDir: '/tmp',
            model: 'test-model', effort: 'high', serviceName, profile })
          const options = (created.process as any).opts
          const translated = enabled && id === 'claude-sub'
          expect(Boolean(options.translation)).toBe(translated)
          expect(Boolean(options.translationContext)).toBe(translated)
          expect(created.process.translationEnabled).toBe(translated)
          expect(created.process.tokenSourceId).toBe(id)
          expect(options.model).toBe('test-model')
          expect(options.effort).toBe('high')
          expect(options.transformEnv({}).ANTHROPIC_BASE_URL).toBe(`https://${id}.test/api/anthropic`)
          expect(options.appendSystemPrompt).toBeUndefined()
        }
      }
    }
  } finally {
    config.claude.safe_mode = previousSafeMode
    resetTokenSourceRegistry()
    for (const source of previous) registerTokenSource(source)
  }
})

test('configured GLM translation persists across main and delegated fresh, resumed and forked launches', () => {
  const previous = listTokenSources()
  const previousSafeMode = config.claude.safe_mode
  config.claude.safe_mode = { 'claude-sub': ['*'], glm: ['GLM-5.3'] }
  registerTokenSource({
    id: 'glm', kind: 'test', agent: 'claude', display: 'GLM', enabled: true,
    models: ['GLM-5.3', 'GLM-5.3-Flash'].map(model => ({ model, display: model, efforts: ['max'], defaultEffort: 'max' })),
    defaultModel: 'GLM-5.3', modelCatalogState: { status: 'ready', updatedAt: 1 },
    refreshModels: async () => {}, resolveSpawnModel: model => `${model}[1m]`,
    spawnEnv: env => ({ ...env, ANTHROPIC_BASE_URL: 'https://glm.test/api/anthropic' }),
    readUsage: async () => ({ state: 'not_applicable', windows: [] }),
  })
  try {
    const source = { provider: 'claude' as const, sessionId: 'old-session', cwd: '/tmp' }
    for (const serviceName of [undefined, 'lodestar-agent']) {
      for (const launch of [
        { kind: 'fresh' as const }, { kind: 'resume' as const, source },
        { kind: 'fork' as const, source, through: { provider: 'claude' as const, kind: 'assistant-message' as const,
          id: 'checkpoint', source } },
      ]) {
        for (const model of [undefined, 'GLM-5.3', 'GLM-5.3-Flash']) {
          const created = createAgentProcess({ provider: 'claude', tokenSourceId: 'glm', workDir: '/tmp',
            model, effort: 'max', launch, serviceName }).process as any
          const translated = model !== 'GLM-5.3-Flash'
          expect(created.translationEnabled).toBe(translated)
          expect(Boolean(created.opts.translation)).toBe(translated)
          expect(Boolean(created.opts.translationContext)).toBe(translated)
          expect(created.tokenSourceId).toBe('glm')
          expect(created.opts.model).toBe(`${model ?? 'GLM-5.3'}[1m]`)
          expect(created.opts.effort).toBe('max')
          expect(created.opts.transformEnv({}).ANTHROPIC_BASE_URL).toBe('https://glm.test/api/anthropic')
          expect(created.opts.appendSystemPrompt).toBeUndefined()
          expect(created.opts.resumeSessionId).toBe(launch.kind === 'fresh' ? undefined : source.sessionId)
          expect(created.opts.forkSession).toBe(launch.kind === 'fork' ? true : undefined)
          expect(created.opts.resumeSessionAt).toBe(launch.kind === 'fork' ? 'checkpoint' : undefined)
        }
      }
    }
  } finally {
    config.claude.safe_mode = previousSafeMode
    resetTokenSourceRegistry()
    for (const source of previous) registerTokenSource(source)
  }
})

test('an explicit empty subscription safety list disables the boundary for main and delegated launches', () => {
  const previous = listTokenSources()
  const previousSafeMode = config.claude.safe_mode
  config.claude.safe_mode = { 'claude-sub': [] }
  registerTokenSource({
    id: 'claude-sub', kind: 'claude-subscription', agent: 'claude', display: 'Claude', enabled: true,
    models: [{ model: 'opus', display: 'Opus', efforts: ['high'], defaultEffort: 'high' }],
    defaultModel: 'opus', modelCatalogState: { status: 'ready', updatedAt: 1 },
    refreshModels: async () => {}, resolveSpawnModel: model => model, spawnEnv: env => env,
    readUsage: async () => ({ state: 'not_applicable', windows: [] }),
  })
  try {
    for (const serviceName of [undefined, 'lodestar-agent']) {
      const created = createAgentProcess({ provider: 'claude', tokenSourceId: 'claude-sub', workDir: '/tmp',
        effort: 'high', serviceName }).process as any
      expect(created.translationEnabled).toBe(false)
      expect(created.opts.translation).toBeUndefined()
      expect(created.opts.translationContext).toBeUndefined()
      expect(created.tokenSourceId).toBe('claude-sub')
    }
  } finally {
    config.claude.safe_mode = previousSafeMode
    resetTokenSourceRegistry()
    for (const source of previous) registerTokenSource(source)
  }
})

test('API Codex launch does not consult or bind a subscription account', () => {
  const script = `
    import { mock } from 'bun:test'
    import { EventEmitter } from 'node:events'
    import assert from 'node:assert/strict'
    let child, captured
    const spawn = (bin, args, options) => {
      captured = { args, options }
      child = new EventEmitter()
      child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
      child.stdin.write = () => true
      return child
    }
    mock.module('cross-spawn', () => ({ default: spawn, spawn }))
    // 合并后的 codex-process 可能经 node spawn(本地侧)或 cross-spawn(上游侧):
    // 两侧都接到同一个捕获点,断言不变。
    mock.module('node:child_process', () => {
      const actual = require('node:child_process')
      return { ...actual, spawn }
    })
    const { registerTokenSource } = await import('./src/token-source')
    const { createAgentProcess } = await import('./src/agent-launch')
    const { codexAccountInUse } = await import('./src/codex-accounts')
    registerTokenSource({ id: 'api-test', kind: 'api-test', agent: 'codex', enabled: true,
      models: [{ model: 'kimi-k3', display: 'Kimi', efforts: ['high'], defaultEffort: 'high' }],
      defaultModel: 'kimi-k3', modelCatalogState: { status: 'ready', updatedAt: 1 },
      codexApiProvider: { id: 'packy', name: 'Packy', baseUrl: 'https://gateway.test/v1', envKey: 'TEST_PACKY_KEY' },
      spawnEnv: env => ({ ...env, TEST_PACKY_KEY: 'private-test-key' }), resolveSpawnModel: model => model })
    const { process: proc } = createAgentProcess({ provider: 'codex', tokenSourceId: 'api-test', workDir: '/repo',
      model: 'kimi-k3', effort: 'high', codexAccountId: 'nonexistent-subscription-account' })
    assert.ok(captured.args.includes('model_provider="packy"'))
    assert.ok(!captured.args.join(' ').includes('private-test-key'))
    assert.ok(!captured.args.join(' ').includes('forced_login_method'))
    assert.equal(captured.options.env.TEST_PACKY_KEY, 'private-test-key')
    assert.equal(codexAccountInUse('nonexistent-subscription-account'), false)
    child.emit('exit', 0, null); child.emit('close', 0, null)
  `
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe',
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})

test('manual Codex launch bypasses failed catalogs and model restrictions while automatic launch still rejects them', () => {
  const script = `
    import { mock } from 'bun:test'
    import { EventEmitter } from 'node:events'
    import assert from 'node:assert/strict'
    const captured = []
    mock.module('./src/codex-process', () => ({
      CodexProcess: class extends EventEmitter { constructor(opts) { super(); captured.push(opts) } isAlive() { return false } },
      isCodexReasoningEffort: value => value === 'ultra', resolveCodexBin: () => 'unused',
      // 本地链(codex-models 经 token-source/agent-launch 闭包)还消费这两个导出;
      // 上游三键 mock 在合并树上不完整,按合并实现默认值补齐。
      CODEX_EFFORT: 'max', CODEX_REASONING_EFFORTS: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    }))
    const { registerTokenSource } = await import('./src/token-source')
    registerTokenSource({ id: 'codex-sub', kind: 'codex-subscription', agent: 'codex', enabled: false,
      models: [], defaultModel: 'model', modelCatalogState: { status: 'failed', error: 'catalog unavailable' },
      spawnEnv: env => env, resolveSpawnModel: () => { throw new Error('must not resolve unavailable catalog') } })
    const { createAgentProcess } = await import('./src/agent-launch')
    const opts = { provider: 'codex', tokenSourceId: 'codex-sub', workDir: '/repo', model: 'uncatalogued-model', effort: 'ultra' }
    assert.throws(() => createAgentProcess(opts), /disabled/)
    createAgentProcess({ ...opts, codexManualAccount: true, codexAccountId: 'explicit-account' })
    assert.equal(captured.length, 1)
    assert.equal(captured[0].model, 'uncatalogued-model')
    assert.equal(captured[0].effort, 'ultra')
    assert.equal(captured[0].codexAccountId, 'explicit-account')
  `
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe',
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})

for (const status of ['idle', 'loading', 'failed', 'ready'] as const) {
  test(`launch reports ${status} catalog state without substituting a model`, () => {
    const previous = listTokenSources()
    resetTokenSourceRegistry()
    const source: TokenSource = {
      id: 'launch-test', kind: 'test', agent: 'codex', display: 'Test Codex', enabled: true,
      models: [], defaultModel: '', modelCatalogState: { status, updatedAt: null, error: 'catalog upstream unavailable' },
      refreshModels: async () => {},
      spawnEnv: env => env,
      resolveSpawnModel: model => model,
      readUsage: async () => ({ state: 'not_applicable', windows: [] }),
    }
    registerTokenSource(source)
    try {
      const expected = status === 'failed'
        ? 'model catalog refresh failed for launch-test: catalog upstream unavailable'
        : status === 'ready'
          ? 'model is not present in token source launch-test: gpt-6-astra'
          : `model catalog is not ready for launch-test: ${status}`
      expect(() => createAgentProcess({
        provider: 'codex', workDir: '/tmp', tokenSourceId: source.id, model: 'gpt-6-astra', effort: 'ultra',
      })).toThrow(expected)
    } finally {
      resetTokenSourceRegistry()
      for (const item of previous) registerTokenSource(item)
    }
  })
}

test('the shared Claude launch passes the selected OpenRouter slug to its role environment and rejects undeclared effort', () => {
  const previous = listTokenSources()
  const source = tokenSourceFactories().find(entry => entry.kind === 'openrouter')!.build({ api_key: 'launch-test-key' })
  source.models = [{ model: 'vendor/test', display: 'Test', efforts: ['medium'], defaultEffort: 'medium' }]
  source.modelCatalogState = { status: 'ready', updatedAt: 1 }
  registerTokenSource(source)
  try {
    const opts = { provider: 'claude' as const, workDir: '/tmp', tokenSourceId: 'openrouter', model: 'vendor/test', effort: 'medium' as const }
    const created = createAgentProcess(opts)
    const env = (created.process as any).opts.transformEnv({ ANTHROPIC_AUTH_TOKEN: 'previous-key' })
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('vendor/test')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('launch-test-key')
    expect((created.process as any).opts.settingSources).toEqual(['project', 'local'])
    expect(() => createAgentProcess({ ...opts, effort: 'max' })).toThrow('model effort unavailable')
  } finally {
    resetTokenSourceRegistry()
    for (const item of previous) registerTokenSource(item)
  }
})

// ── 本地 fork 用例(移植到上游 TokenSource 形状) ────────────────────────

// registry 夹具:重置 → 注册 → 运行 → 还原。
function withRegisteredSources(sources: TokenSource[], run: () => void): void {
  const previous = listTokenSources()
  resetTokenSourceRegistry()
  for (const item of sources) registerTokenSource(item)
  try {
    run()
  } finally {
    resetTokenSourceRegistry()
    for (const item of previous) registerTokenSource(item)
  }
}

function codexSource(): TokenSource {
  return {
    id: 'codex-login:gpt-5.6-sol', kind: 'codex-login', agent: 'codex', display: 'Codex · GPT-5.6 Sol', enabled: true,
    models: [{ model: 'gpt-5.6-sol', display: 'GPT-5.6 Sol', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' }],
    defaultModel: 'gpt-5.6-sol',
    refreshModels: async () => {},
    spawnEnv: env => env,
    resolveSpawnModel: model => model,
    readUsage: async () => ({ state: 'not_applicable', windows: [] }),
    modelCatalogState: { status: 'ready', updatedAt: Date.now() },
  }
}

function claudeCompatSource(): TokenSource {
  return {
    id: 'claude:deepseek', kind: 'api', agent: 'claude', display: 'Claude · DeepSeek 兼容', enabled: true,
    models: [{ model: 'claude:deepseek', display: 'deepseek-v4-pro[1m]', efforts: ['low', 'max'], defaultEffort: 'max' }],
    defaultModel: 'claude:deepseek',
    refreshModels: async () => {},
    spawnEnv: env => {
      const out = scrubAnthropicEnv(env)
      out.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
      out.ANTHROPIC_AUTH_TOKEN = 'claude-compat-token'
      return out
    },
    resolveSpawnModel: () => 'deepseek-v4-pro[1m]',
    readUsage: async () => ({ state: 'not_applicable', windows: [] }),
    modelCatalogState: { status: 'ready', updatedAt: Date.now() },
  }
}

// 真实 dsh factory + 手工目录:凭据与 env 语义都走 token-source-dsh 的本体。
function dshSource(apiKey: string): TokenSource {
  const factory = tokenSourceFactories().find(entry => entry.kind === 'deepseek-harness')!
  const source = factory.build({ api_key: apiKey, model: 'deepseek-v4-pro' })
  source.models = [{ model: 'deepseek-v4-pro', display: 'deepseek-v4-pro', efforts: ['off', 'low', 'high', 'max'], defaultEffort: null }]
  if (apiKey) source.modelCatalogState = { status: 'ready', updatedAt: Date.now() }
  return source
}

describe('createAgentProcess 源闸与选项透传', () => {
  test('unknown tokenSourceId throws', () => {
    withRegisteredSources([], () => {
      expect(() => createAgentProcess({
        provider: 'claude',
        workDir: '/tmp',
        tokenSourceId: 'missing-source',
        model: 'claude:fable',
        effort: 'max',
      })).toThrow(/token source not found: missing-source/)
    })
  })

  test('provider mismatch throws', () => {
    withRegisteredSources([claudeCompatSource()], () => {
      expect(() => createAgentProcess({
        provider: 'codex',
        workDir: '/tmp',
        tokenSourceId: 'claude:deepseek',
        model: 'gpt-5.6-sol',
        effort: 'high',
      })).toThrow(/belongs to claude, not codex/)
    })
  })

  test('disabled token source throws', () => {
    withRegisteredSources([dshSource('')], () => {
      expect(() => createAgentProcess({
        provider: 'dsh',
        workDir: '/tmp',
        tokenSourceId: 'deepseek-harness',
        model: 'deepseek-v4-pro',
        effort: 'high',
      })).toThrow(/token source disabled: deepseek-harness/)
    })
  })

  test('Codex path carries tokenSourceId/transformEnv and lodestar-agent serviceName', () => {
    withRegisteredSources([codexSource()], () => {
      const { process: proc } = createAgentProcess({
        provider: 'codex',
        workDir: '/tmp/codex-work',
        tokenSourceId: 'codex-login:gpt-5.6-sol',
        model: 'gpt-5.6-sol',
        effort: 'high',
        hostEnv: { LODESTAR_AGENT_URL: 'http://127.0.0.1:9876' },
        serviceName: 'lodestar-agent',
      })
      expect(proc).toBeInstanceOf(CodexProcess)
      const opts = (proc as any).opts
      expect(opts.workDir).toBe('/tmp/codex-work')
      expect(opts.serviceName).toBe('lodestar-agent')
      expect(opts.hostEnv).toEqual({ LODESTAR_AGENT_URL: 'http://127.0.0.1:9876' })
      expect(opts.tokenSourceId).toBe('codex-login:gpt-5.6-sol')
      expect(opts.codexAccountId).toBe('default')
      expect(opts.model).toBe('gpt-5.6-sol')
      expect(opts.effort).toBe('high')
      expect(typeof opts.transformEnv).toBe('function')
    })
  })
})

describe('createAgentProcess dsh 分支(D-08 双轨:与 claude:deepseek 互不相读)', () => {
  test('凭据齐备时构造 dsh 进程,凭据只经 DSH 源 spawnEnv 接线(transformEnv)', () => {
    withRegisteredSources([dshSource('dsh-key')], () => {
      const { process: proc } = createAgentProcess({
        provider: 'dsh',
        workDir: '/tmp/dsh-work',
        tokenSourceId: 'deepseek-harness',
        model: 'deepseek-v4-pro',
        effort: 'high',
        hostEnv: { LODESTAR_AGENT_CAPABILITY: 'cap-dsh' },
      })
      expect(proc.provider).toBe('dsh')
      const opts = (proc as any).opts
      expect(opts.tokenSourceId).toBe('deepseek-harness')
      expect(opts.model).toBe('deepseek-v4-pro')
      expect(opts.effort).toBe('high')
      expect(opts.workDir).toBe('/tmp/dsh-work')
      expect(opts.hostEnv).toEqual({ LODESTAR_AGENT_CAPABILITY: 'cap-dsh' })
      expect(typeof opts.transformEnv).toBe('function')

      const env = opts.transformEnv({
        ANTHROPIC_API_KEY: 'stray-key',
        ANTHROPIC_BASE_URL: 'https://stray.example',
        LODESTAR_AGENT_CAPABILITY: 'cap-dsh',
      })
      expect(Object.keys(env).filter((key: string) => key.startsWith('ANTHROPIC_'))).toEqual([])
      expect(env.DEEPSEEK_API_KEY).toBe('dsh-key')
      expect(env.DEEPSEEK_BASE_URL).toBeUndefined()
      expect(env.LODESTAR_DSH_PROVIDER).toBe('deepseek-official')
      expect(env.LODESTAR_AGENT_CAPABILITY).toBe('cap-dsh')
    })
  })

  test('effort 词表外先撞 effort 闸,effort 缺省撞 DSH 闸,不静默回落', () => {
    withRegisteredSources([dshSource('dsh-key')], () => {
      const base = {
        provider: 'dsh' as const,
        workDir: '/tmp/dsh-work',
        tokenSourceId: 'deepseek-harness',
        model: 'deepseek-v4-pro',
      }
      expect(() => createAgentProcess({ ...base, effort: 'medium' }))
        .toThrow('model effort unavailable: deepseek-harness/deepseek-v4-pro/medium')
      expect(() => createAgentProcess({ ...base }))
        .toThrow('DSH requires a configured source, model and valid effort')
    })
  })

  test('双轨不冲突:provider claude + claude:deepseek 走 ClaudeAgentProcess,spawn 名与 env 来自本档源', () => {
    withRegisteredSources([claudeCompatSource(), dshSource('dsh-key')], () => {
      const { process: proc } = createAgentProcess({
        provider: 'claude',
        workDir: '/tmp/claude-work',
        tokenSourceId: 'claude:deepseek',
        model: 'claude:deepseek',
        effort: 'max',
      })
      expect(proc).toBeInstanceOf(ClaudeAgentProcess)
      expect(proc.provider).toBe('claude')
      const opts = (proc as any).opts
      expect(opts.tokenSourceId).toBe('claude:deepseek')
      // 选中键经本档 resolveSpawnModel 解析成真实的 [1m] 记账名。
      expect(opts.model).toBe('deepseek-v4-pro[1m]')
      const env = opts.transformEnv({ ANTHROPIC_API_KEY: 'stray-key', ANTHROPIC_AUTH_TOKEN: 'previous' })
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('claude-compat-token')
      expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic')

      // 反向:DSH 档的 transformEnv 先 scrub ANTHROPIC_*,绝不夹带 claude:deepseek 凭据。
      const dshProc = createAgentProcess({
        provider: 'dsh',
        workDir: '/tmp/dsh-work',
        tokenSourceId: 'deepseek-harness',
        model: 'deepseek-v4-pro',
        effort: 'high',
      })
      const dshEnv = (dshProc.process as any).opts.transformEnv({ ANTHROPIC_AUTH_TOKEN: 'claude-compat-token' })
      expect(dshEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
      expect(dshEnv.DEEPSEEK_API_KEY).toBe('dsh-key')
    })
  })
})

describe('createAgentProcess allowDelegation 闸(D-11 口径 3:显式 false 才关)', () => {
  test('claude:allowDelegation:false 透传,缺省不限制', () => {
    withRegisteredSources([claudeCompatSource()], () => {
      const base = {
        provider: 'claude' as const,
        workDir: '/tmp/claude-work',
        tokenSourceId: 'claude:deepseek',
        model: 'claude:deepseek',
        effort: 'max' as const,
      }
      const restricted = createAgentProcess({ ...base, allowDelegation: false })
      expect((restricted.process as any).opts.allowDelegation).toBe(false)
      // 缺省(undefined)不限制:主 Agent 走同一构造入口,不得被误关。
      const main = createAgentProcess({ ...base })
      expect((main.process as any).opts.allowDelegation).toBeUndefined()
    })
  })

  test('codex:allowDelegation:false 透传,缺省不限制', () => {
    withRegisteredSources([codexSource()], () => {
      const base = {
        provider: 'codex' as const,
        workDir: '/tmp/codex-work',
        tokenSourceId: 'codex-login:gpt-5.6-sol',
        model: 'gpt-5.6-sol',
        effort: 'high' as const,
      }
      const restricted = createAgentProcess({ ...base, allowDelegation: false })
      expect((restricted.process as any).opts.allowDelegation).toBe(false)
      const main = createAgentProcess({ ...base })
      expect((main.process as any).opts.allowDelegation).toBeUndefined()
    })
  })

  test('dsh:allowDelegation:false 透传,缺省不限制', () => {
    withRegisteredSources([dshSource('dsh-key')], () => {
      const base = {
        provider: 'dsh' as const,
        workDir: '/tmp/dsh-work',
        tokenSourceId: 'deepseek-harness',
        model: 'deepseek-v4-pro',
        effort: 'high' as const,
      }
      const restricted = createAgentProcess({ ...base, allowDelegation: false })
      expect((restricted.process as any).opts.allowDelegation).toBe(false)
      const main = createAgentProcess({ ...base })
      expect((main.process as any).opts.allowDelegation).toBeUndefined()
    })
  })

  test('source 三后端同形显式 spread,本地 slim 接口不得复活', () => {
    const src = readFileSync(join(import.meta.dir, 'agent-launch.ts'), 'utf8')
    const code = src
      .split('\n')
      .filter(line => !/^\s*\/\//.test(line))
      .join('\n')
    const gates = code.match(/allowDelegation === false \? \{ allowDelegation: false \} : \{\}/g) ?? []
    expect(gates).toHaveLength(3)
    // dsh 分支经 TokenSource.spawnEnv 注入凭据;合并后走 registry 按 id 取源。
    expect(code).toContain('getTokenSourceForAccount')
    expect(code).toContain('isDshReasoningEffort')
    expect(code).not.toContain('resolveTokenSource')
  })
})

describe('hostEnv survives credential scrub', () => {
  test('Claude spawn env keeps hostEnv after ANTHROPIC_* scrub', () => {
    const prevKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'stray-official-key'
    try {
      const proc = new ClaudeAgentProcess({
        workDir: '/tmp',
        effort: 'max',
        model: 'claude:fable',
        // 合并架构:凭据清洗(ANTHROPIC_*)与 GSD_RUNTIME 基线在 launch 层注入的
        // transformEnv(token-source.spawnEnv)执行;seam 只保证 hostEnv 合并在其后
        // 且仅覆盖同名键 —— fake 里预置 'clobbered' 锁死这个顺序不变式。
        transformEnv: env => {
          const out = { ...env }
          delete out.ANTHROPIC_API_KEY
          out.GSD_RUNTIME = 'claude'
          out.LODESTAR_AGENT_CAPABILITY = 'clobbered'
          return out
        },
        hostEnv: {
          LODESTAR_AGENT_CAPABILITY: 'cap-secret',
          LODESTAR_AGENT_URL: 'http://127.0.0.1:9876',
        },
      })
      const env = (proc as any).buildSpawnEnv() as Record<string, string>
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(env.LODESTAR_AGENT_CAPABILITY).toBe('cap-secret')
      expect(env.LODESTAR_AGENT_URL).toBe('http://127.0.0.1:9876')
      expect(env.GSD_RUNTIME).toBe('claude')
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prevKey
    }
  })

  test('Codex spawn env merges hostEnv after provider env lock', () => {
    const env = codexProcess.buildCodexSpawnEnv(
      { GSD_RUNTIME: 'claude', LODESTAR_TEST_PROVIDER_KEY: 'set' },
      { LODESTAR_AGENT_CAPABILITY: 'cap-secret' },
    )
    expect(env.GSD_RUNTIME).toBe('codex')
    expect(env.LODESTAR_TEST_PROVIDER_KEY).toBe('set')
    expect(env.LODESTAR_AGENT_CAPABILITY).toBe('cap-secret')
  })

  test('Codex threadParams uses opts.serviceName or lodestar', () => {
    const proc = Object.create(RealCodexProcess.prototype) as any
    proc.opts = { workDir: '/tmp', effort: 'high', serviceName: 'lodestar-agent' }
    expect(proc.threadParams().serviceName).toBe('lodestar-agent')
    proc.opts = { workDir: '/tmp', effort: 'high' }
    expect(proc.threadParams().serviceName).toBe('lodestar')
  })
})

describe('delegatedAgentDeveloperInstructions', () => {
  test('omits channel protocol constants', () => {
    const s = {
      sessionName: 'demo',
      workDir: '/tmp/demo',
      currentProvider: () => 'claude' as const,
    } as any
    const text = delegatedAgentDeveloperInstructions(s, 'claude')
    expect(text).not.toContain('AskUserQuestion')
    expect(text).not.toContain('request_user_input')
    expect(text).not.toContain('[[send:')
    expect(CLAUDE_CHANNEL_INSTRUCTIONS).toContain('[[send:')
    expect(CHANNEL_INSTRUCTIONS).toContain('[[send:')
    expect(spawnInstructions(s, 'chat')).toContain('[[send:')
  })

  test('can include worktree extra without channel markers', () => {
    const spy = spyOn(worktree, 'readWorktreeInstructionsForManagedBranch').mockReturnValue({
      path: '/tmp/wt.md',
      content: 'keep the feature branch',
      slug: 'feat',
    })
    try {
      const s = {
        sessionName: 'demo',
        workDir: '/tmp/demo',
        currentProvider: () => 'codex' as const,
      } as any
      const text = delegatedAgentDeveloperInstructions(s, 'codex')
      expect(text).toContain('keep the feature branch')
      expect(text).not.toContain('AskUserQuestion')
      expect(text).not.toContain('request_user_input')
    } finally {
      spy.mockRestore()
    }
  })
})
