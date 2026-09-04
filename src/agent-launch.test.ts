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
    expect(code).not.toContain('transformEnv')
    expect(code).not.toContain('settingSources')
    expect(code).not.toContain('managedSkillPluginPath')
  })
})
