import { describe, expect, test } from 'bun:test'

import { updateUsageFromRateLimits } from './usage'

describe('usage cache semantics', () => {
  test('keeps last live snapshot when a later live update payload is empty', () => {
    const snapshot = updateUsageFromRateLimits({
      planType: 'plus',
      primary: { usedPercent: 12.4, windowDurationMins: 300 },
      secondary: { usedPercent: 66.6, windowDurationMins: 10_080 },
    })

    expect(snapshot.state).toBe('ok')
    if (snapshot.state !== 'ok') throw new Error('expected ok snapshot')
    expect(snapshot.fiveHour?.percent).toBe(12.4)
    expect(snapshot.weekly?.percent).toBe(66.6)

    const kept = updateUsageFromRateLimits(null)
    expect(kept).toEqual(snapshot)
  })

  test('does not coerce missing usage percentages to 0', () => {
    const snapshot = updateUsageFromRateLimits({
      planType: 'pro',
      primary: { windowDurationMins: 300 },
      secondary: { windowDurationMins: 10_080 },
    })

    expect(snapshot.state).toBe('ok')
    if (snapshot.state !== 'ok') throw new Error('expected ok snapshot')
    expect(snapshot.fiveHour?.percent).toBeNull()
    expect(snapshot.weekly?.percent).toBeNull()
  })
})
