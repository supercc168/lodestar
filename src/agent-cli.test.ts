import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parsePromptArgs } from './agent-cli'

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('lodestar-agent CLI args', () => {
  test('parses a parallel full-Agent run', () => {
    expect(parsePromptArgs([
      '--identity', 'a', '--identity', 'b', '--identity', 'a', '--effort', 'max', '--stdin', '--no-wait',
    ], true)).toEqual({
      identityIds: ['a', 'b'], identityId: '', effort: 'max', prompt: '', noWait: true, readStdin: true,
    })
  })

  test('parses a single-session follow-up', () => {
    expect(parsePromptArgs(['--identity', 'a', 'continue here'], false)).toEqual({
      identityIds: [], identityId: 'a', effort: '', prompt: 'continue here', noWait: false, readStdin: false,
    })
  })

  test('requires an identity for a new run', () => {
    expect(() => parsePromptArgs(['task'], true)).toThrow('--identity')
  })
})

describe('lodestar-agent host env', () => {
  test('cliContext refuses missing URL or capability', async () => {
    const { main } = await import('./agent-cli')
    const prevUrl = process.env.LODESTAR_AGENT_URL
    const prevCap = process.env.LODESTAR_AGENT_CAPABILITY
    delete process.env.LODESTAR_AGENT_URL
    delete process.env.LODESTAR_AGENT_CAPABILITY
    try {
      await expect(main(['identities'])).rejects.toThrow(/Lodestar-managed Agent session/)
    } finally {
      if (prevUrl === undefined) delete process.env.LODESTAR_AGENT_URL
      else process.env.LODESTAR_AGENT_URL = prevUrl
      if (prevCap === undefined) delete process.env.LODESTAR_AGENT_CAPABILITY
      else process.env.LODESTAR_AGENT_CAPABILITY = prevCap
    }
  })
})

describe('lodestar-agent DSH delegation context', () => {
  const DSH_CONTEXT = 'DSH_LODESTAR_AGENT_CONTEXT'
  const LEGACY_URL = 'LODESTAR_AGENT_URL'
  const LEGACY_CAPABILITY = 'LODESTAR_AGENT_CAPABILITY'
  const savedEnv = new Map<string, string | undefined>()

  function setEnv(values: Record<string, string | undefined>): void {
    for (const [key, value] of Object.entries(values)) {
      if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    savedEnv.clear()
  })

  test('合法上下文优先于旧 env,baseUrl 去掉尾部斜杠', async () => {
    const { cliContext } = await import('./agent-cli')
    setEnv({
      [DSH_CONTEXT]: JSON.stringify({ baseUrl: 'http://127.0.0.1:9876//', capability: 'dsh-cap' }),
      [LEGACY_URL]: 'http://127.0.0.1:1',
      [LEGACY_CAPABILITY]: 'legacy-cap',
    })
    expect(cliContext()).toEqual({ baseUrl: 'http://127.0.0.1:9876', capability: 'dsh-cap' })
  })

  test('非法上下文抛错,不回落到旧 env,也不回显 capability 明文', async () => {
    const { cliContext } = await import('./agent-cli')
    setEnv({ [LEGACY_URL]: 'http://127.0.0.1:1', [LEGACY_CAPABILITY]: 'legacy-cap' })
    const broken = [
      // JSON 截断:JSON.parse 的原始报错会把含 capability 的串回显出来,必须折叠。
      `{"baseUrl":"http://127.0.0.1:1","capability":"dsh-secret-cap"`,
      'not-json',
      '{}',
      JSON.stringify({ baseUrl: '', capability: 'dsh-secret-cap' }),
      JSON.stringify({ baseUrl: 'http://127.0.0.1:1', capability: '   ' }),
      JSON.stringify({ baseUrl: 42, capability: 'dsh-secret-cap' }),
    ]
    for (const value of broken) {
      setEnv({ [DSH_CONTEXT]: value })
      expect(() => cliContext()).toThrow('invalid DSH Lodestar delegation context')
      let message = ''
      try { cliContext() } catch (error) { message = error instanceof Error ? error.message : String(error) }
      expect(message).not.toContain('dsh-secret-cap')
      expect(message).not.toContain('legacy-cap')
    }
  })

  test('缺省时旧 LODESTAR_AGENT_URL / CAPABILITY 路径逐字不变', async () => {
    const { cliContext } = await import('./agent-cli')
    setEnv({ [DSH_CONTEXT]: undefined, [LEGACY_URL]: 'http://127.0.0.1:7777/', [LEGACY_CAPABILITY]: 'legacy-cap' })
    expect(cliContext()).toEqual({ baseUrl: 'http://127.0.0.1:7777', capability: 'legacy-cap' })
    setEnv({ [LEGACY_URL]: undefined, [LEGACY_CAPABILITY]: undefined })
    expect(() => cliContext())
      .toThrow('lodestar-agent must run inside a Lodestar-managed Agent session (missing capability)')
  })
})

describe('lodestar-agent main-module guard', () => {
  test('follows an npm-style symlink to the bundle for --help', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lodestar-agent-cli-'))
    temps.push(dir)
    const bundle = join(dir, 'lodestar-agent.js')
    const built = spawnSync('bun', [
      'build', 'src/agent-cli.ts', '--target=node', '--outfile', bundle,
    ], { cwd: join(import.meta.dir, '..'), encoding: 'utf8' })
    expect(built.status).toBe(0)
    const shim = join(dir, 'lodestar-agent')
    symlinkSync(bundle, shim)
    const viaShim = spawnSync('node', [shim, '--help'], { encoding: 'utf8' })
    expect(viaShim.status).toBe(0)
    expect(viaShim.stdout).toContain('Usage:')
    const viaBundle = spawnSync('node', [bundle, '--help'], { encoding: 'utf8' })
    expect(viaBundle.status).toBe(0)
    expect(viaBundle.stdout).toContain('Usage:')
  })
})
