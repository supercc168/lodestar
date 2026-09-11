import { describe, expect, mock, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

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
const {
  buildCodexSpawnEnv,
  CodexProcess,
} = await import('./codex-process')
const {
  delegatedAgentDeveloperInstructions,
  spawnDeveloperInstructions,
} = await import('./session-worktree')
const { CHANNEL_INSTRUCTIONS, CLAUDE_CHANNEL_INSTRUCTIONS } = await import('./instructions')
const { config } = await import('./config')
const worktree = await import('./worktree')

describe('createAgentProcess slim factory', () => {
  test('Claude constructor keeps selectionModel and never the SDK bare name', () => {
    const prev = config.claude.models
    ;(config.claude as any).models = {
      glm: { model: 'glm-5.3', base_url: 'https://glm.example/anthropic', auth_token: 'glm-tok' },
    }
    try {
      const { process: proc } = createAgentProcess({
        provider: 'claude',
        workDir: '/tmp/agent-work',
        tokenSourceId: 'claude:glm',
        model: 'claude:glm',
        effort: 'max',
        hostEnv: { LODESTAR_AGENT_CAPABILITY: 'cap-1' },
      })
      expect(proc).toBeInstanceOf(ClaudeAgentProcess)
      expect((proc as any).opts.model).toBe('claude:glm')
      expect((proc as any).opts.model).not.toBe('glm-5.3')
      expect((proc as any).opts.workDir).toBe('/tmp/agent-work')
      expect((proc as any).opts.hostEnv).toEqual({ LODESTAR_AGENT_CAPABILITY: 'cap-1' })
    } finally {
      ;(config.claude as any).models = prev
    }
  })

  test('unknown tokenSourceId throws', () => {
    expect(() => createAgentProcess({
      provider: 'claude',
      workDir: '/tmp',
      tokenSourceId: 'missing-source',
      model: 'claude:fable',
      effort: 'max',
    })).toThrow(/token source not found: missing-source/)
  })

  test('provider mismatch throws', () => {
    expect(() => createAgentProcess({
      provider: 'codex',
      workDir: '/tmp',
      tokenSourceId: 'claude:fable',
      model: 'gpt-5.6-sol',
      effort: 'max',
    })).toThrow(/belongs to claude, not codex/)
  })

  test('disabled token source throws', () => {
    expect(() => createAgentProcess({
      provider: 'claude',
      workDir: '/tmp',
      tokenSourceId: 'claude:glm',
      model: 'claude:glm',
      effort: 'max',
    })).toThrow(/token source disabled: claude:glm/)
  })

  test('Codex path carries configArgs/providerEnv and lodestar-agent serviceName', () => {
    const { process: proc } = createAgentProcess({
      provider: 'codex',
      workDir: '/tmp/codex-work',
      tokenSourceId: 'codex-login:gpt-5.6-sol',
      model: 'gpt-5.6-sol',
      effort: 'max',
      hostEnv: { LODESTAR_AGENT_URL: 'http://127.0.0.1:9876' },
      serviceName: 'lodestar-agent',
    })
    expect(proc).toBeInstanceOf(CodexProcess)
    const opts = (proc as any).opts
    expect(opts.workDir).toBe('/tmp/codex-work')
    expect(opts.serviceName).toBe('lodestar-agent')
    expect(opts.hostEnv).toEqual({ LODESTAR_AGENT_URL: 'http://127.0.0.1:9876' })
    expect(Array.isArray(opts.configArgs)).toBe(true)
    expect(opts.providerEnv).toBeDefined()
    expect(opts.model).not.toBe('claude:glm')
  })
})

describe('createAgentProcess dsh 分支(D-08 双轨:与 claude:deepseek 互不相读)', () => {
  function withDshConfig(section: { api_key?: string; model?: string; base_url?: string } | undefined): () => void {
    const prev = (config as any).deepseek_harness
    ;(config as any).deepseek_harness = section
    return () => { (config as any).deepseek_harness = prev }
  }

  test('DshProcess 已由替身顶掉:构造期不 spawn 真实子进程', async () => {
    const { DshProcess } = await import('./dsh-process')
    expect(DshProcess.name).toBe('FakeDshProcess')
  })

  test('凭据齐备时构造 dsh 进程,tokenSourceId 与 env 清洗都来自 DSH 源', () => {
    const restore = withDshConfig({ api_key: 'dsh-key', model: 'deepseek-v4-pro' })
    try {
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
      expect(typeof opts.transformEnv).toBe('function')

      const env = opts.transformEnv({
        ANTHROPIC_API_KEY: 'stray-key',
        ANTHROPIC_BASE_URL: 'https://stray.example',
        LODESTAR_AGENT_CAPABILITY: 'cap-dsh',
      })
      expect(Object.keys(env).filter((key: string) => key.startsWith('ANTHROPIC_'))).toEqual([])
      expect(env.DEEPSEEK_API_KEY).toBe('dsh-key')
      expect(env.DEEPSEEK_BASE_URL).toBe('https://api.deepseek.com')
      expect(env.LODESTAR_AGENT_CAPABILITY).toBe('cap-dsh')
    } finally {
      restore()
    }
  })

  test('allowDelegation:false 透传 DshProcess 构造(D-11 口径 3,与 claude/codex 同形)', () => {
    const restore = withDshConfig({ api_key: 'dsh-key', model: 'deepseek-v4-pro' })
    try {
      const base = {
        provider: 'dsh' as const,
        workDir: '/tmp/dsh-work',
        tokenSourceId: 'deepseek-harness',
        model: 'deepseek-v4-pro',
        effort: 'high' as const,
      }
      const restricted = createAgentProcess({ ...base, allowDelegation: false })
      expect((restricted.process as any).opts.allowDelegation).toBe(false)
      // 缺省(undefined)不限制:主 Agent 走同一构造入口,不得被误关。
      const main = createAgentProcess({ ...base })
      expect((main.process as any).opts.allowDelegation).toBeUndefined()
    } finally {
      restore()
    }
  })

  test('effort 非法(medium)或缺省时抛错,不静默回落', () => {
    const restore = withDshConfig({ api_key: 'dsh-key', model: 'deepseek-v4-pro' })
    try {
      const base = {
        provider: 'dsh' as const,
        workDir: '/tmp/dsh-work',
        tokenSourceId: 'deepseek-harness',
        model: 'deepseek-v4-pro',
      }
      expect(() => createAgentProcess({ ...base, effort: 'medium' }))
        .toThrow('DSH requires a configured source, model and valid effort')
      expect(() => createAgentProcess({ ...base }))
        .toThrow('DSH requires a configured source, model and valid effort')
    } finally {
      restore()
    }
  })

  test('源未启用或模型缺失时抛错', () => {
    const unconfigured = withDshConfig(undefined)
    try {
      expect(() => createAgentProcess({
        provider: 'dsh',
        workDir: '/tmp/dsh-work',
        tokenSourceId: 'deepseek-harness',
        model: 'deepseek-v4-pro',
        effort: 'high',
      })).toThrow(/token source disabled: deepseek-harness/)
    } finally {
      unconfigured()
    }
    const configured = withDshConfig({ api_key: 'dsh-key' })
    try {
      expect(() => createAgentProcess({
        provider: 'dsh',
        workDir: '/tmp/dsh-work',
        tokenSourceId: 'deepseek-harness',
        model: '',
        effort: 'high',
      })).toThrow('DSH requires a configured source, model and valid effort')
    } finally {
      configured()
    }
  })

  test('双轨不冲突:provider claude + claude:deepseek 仍走 ClaudeAgentProcess', () => {
    const prevModels = config.claude.models
    const restoreDsh = withDshConfig({ api_key: 'dsh-key', model: 'deepseek-v4-pro' })
    ;(config.claude as any).models = {
      deepseek: {
        model: 'deepseek-v4-pro[1m]',
        base_url: 'https://api.deepseek.com/anthropic',
        auth_token: 'claude-compat-token',
      },
    }
    try {
      const { process: proc } = createAgentProcess({
        provider: 'claude',
        workDir: '/tmp/claude-work',
        tokenSourceId: 'claude:deepseek',
        model: 'claude:deepseek',
        effort: 'max',
      })
      expect(proc).toBeInstanceOf(ClaudeAgentProcess)
      expect(proc.provider).toBe('claude')
      expect((proc as any).opts.model).toBe('claude:deepseek')
    } finally {
      ;(config.claude as any).models = prevModels
      restoreDsh()
    }
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
    const env = buildCodexSpawnEnv(
      { GSD_RUNTIME: 'claude', LODESTAR_TEST_PROVIDER_KEY: 'set' },
      { LODESTAR_AGENT_CAPABILITY: 'cap-secret' },
    )
    expect(env.GSD_RUNTIME).toBe('codex')
    expect(env.LODESTAR_TEST_PROVIDER_KEY).toBe('set')
    expect(env.LODESTAR_AGENT_CAPABILITY).toBe('cap-secret')
  })

  test('Codex threadParams uses opts.serviceName or lodestar', () => {
    const proc = Object.create(CodexProcess.prototype) as any
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
    expect(CLAUDE_CHANNEL_INSTRUCTIONS).toContain('AskUserQuestion')
    expect(CHANNEL_INSTRUCTIONS).toContain('request_user_input')
    expect(spawnDeveloperInstructions(s)).toContain('AskUserQuestion')
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

describe('agent-launch port discipline', () => {
  test('source calls resolveTokenSource and never the upstream registry lookup', () => {
    const src = readFileSync(join(import.meta.dir, 'agent-launch.ts'), 'utf8')
    const code = src
      .split('\n')
      .filter(line => !/^\s*\/\//.test(line))
      .join('\n')
    expect(code).toContain('resolveTokenSource')
    expect(code).not.toContain('getTokenSource')
    // dsh 分支经 TokenSource.spawnEnv 注入凭据(本地 slim 形态);上游的
    // sourceRevision 概念本地不存在,不得臆造。
    expect(code).toContain('isDshReasoningEffort')
    expect(code).not.toContain('sourceRevision')
    expect(code).not.toContain('settingSources')
    expect(code).not.toContain('managedSkillPluginPath')
  })
})
