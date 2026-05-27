import { describe, expect, test } from 'bun:test'

import { consoleCard } from './cards/console'
import {
  contextLimitForModel,
  contextPercent,
  contextTokensFromUsage,
} from './context-window'

describe('context window display', () => {
  test('uses latest input tokens as current occupancy', () => {
    expect(contextTokensFromUsage({
      input_tokens: 35_190,
      cache_read_input_tokens: 4_480,
      output_tokens: 21,
    })).toBe(35_190)
  })

  test('uses documented model window as denominator', () => {
    const limit = contextLimitForModel('gpt-5-codex')

    expect(limit).toBe(400_000)
    expect(contextPercent(35_190, limit)).toBe(9)
  })

  test('keeps unknown model limits unknown', () => {
    expect(contextLimitForModel('gpt-unknown')).toBeNull()
  })

  test('renders real window percentage in console cards', () => {
    const card = consoleCard({
      sessionName: 'probe',
      status: 'idle',
      contextTokens: 35_190,
      contextLimit: contextLimitForModel('gpt-5-codex'),
    })

    expect(JSON.stringify(card)).toContain('35K / 400K')
    expect(JSON.stringify(card)).toContain('(9%)')
  })
})
