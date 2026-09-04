import { describe, expect, test } from 'bun:test'
import { parsePromptArgs } from './agent-cli'

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
