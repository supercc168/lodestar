import { describe, expect, test } from 'bun:test'
import {
  MAX_AGENT_PROMPT_CHARS,
  parseAgentAnswerRequest,
  parseAgentFollowUpRequest,
  parseAgentRunRequest,
} from './agent-run-types'

describe('delegated-agent request parsing', () => {
  test('normalizes identities and preserves the raw prompt', () => {
    expect(parseAgentRunRequest({ identity_ids: ['a', 'a', 'b'], prompt: '  do it\n', effort: 'max' })).toEqual({
      identityIds: ['a', 'b'], prompt: '  do it\n', effort: 'max',
    })
  })

  test('parses follow-up and exact answer maps', () => {
    expect(parseAgentFollowUpRequest({ identity_id: 'a', prompt: 'next' })).toEqual({ identityId: 'a', prompt: 'next' })
    expect(parseAgentAnswerRequest({ request_id: 'r1', answers: { q1: 'yes' } })).toEqual({
      requestId: 'r1', answers: { q1: 'yes' },
    })
  })

  test('rejects empty tasks, too many identities, and oversized prompts', () => {
    expect(() => parseAgentRunRequest({ identity_ids: [], prompt: 'x' })).toThrow('identity_id')
    expect(() => parseAgentRunRequest({ identity_ids: ['a'], prompt: ' ' })).toThrow('prompt')
    expect(() => parseAgentRunRequest({
      identity_ids: Array.from({ length: 65 }, (_, i) => `id-${i}`),
      prompt: 'x',
    })).toThrow('64')
    expect(() => parseAgentRunRequest({
      identity_ids: ['a'],
      prompt: 'p'.repeat(MAX_AGENT_PROMPT_CHARS + 1),
    })).toThrow(String(MAX_AGENT_PROMPT_CHARS))
    expect(() => parseAgentAnswerRequest({ request_id: 'r', answers: {} })).toThrow('at least one')
  })
})
