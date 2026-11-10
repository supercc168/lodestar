import { expect, test } from 'bun:test'
import { claudeQuotaSummary } from './agent-claude-account'

const hours = (h: number) => new Date(Date.now() + h * 3_600_000 + 60_000)

test('summarizes the chosen account quota in the chat footer format', () => {
  expect(claudeQuotaSummary({ state: 'ok', windows: [
    { kind: 'fiveHour', label: '5h', percent: 7.2, resetsAt: hours(4) },
    { kind: 'weekly', label: '周', percent: 17, resetsAt: hours(24 * 6) },
  ] }, 'sonnet')).toMatch(/^4\.0h·7%·\[6\.0d·17%\]$/)
})

test('weekly-only accounts and model-specific weekly buckets', () => {
  expect(claudeQuotaSummary({ state: 'ok', windows: [
    { kind: 'weekly', label: '周', percent: 40, resetsAt: hours(48) },
    { kind: 'seven_day_sonnet', label: 'Sonnet 周', percent: 3, resetsAt: hours(48) },
  ] }, 'sonnet')).toBe('[2.0d·3%]')
})

test('missing quota stays visibly MISS', () => {
  expect(claudeQuotaSummary(undefined, 'sonnet')).toBe('MISS')
  expect(claudeQuotaSummary({ state: 'error', reason: 'auth', windows: [] } as any, 'sonnet')).toBe('MISS(auth)')
  expect(claudeQuotaSummary({ state: 'ok', windows: [{ kind: 'fiveHour', label: '5h', percent: null, resetsAt: null }] }, 'sonnet'))
    .toBe('MISS·[MISS]')
})
