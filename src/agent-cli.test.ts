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
