import { describe, expect, mock, test } from 'bun:test'

mock.module('./feishu', () => ({
  PROJECTS_ROOT: '/tmp/lodestar-projects',
  getSessionResume: () => null,
  getSessionModelSelection: () => null,
  getTenantToken: async () => 'tenant-token',
  preferredChatForSession: new Map(),
}))

const { Session } = await import('./session')

describe('Session fresh conversation state', () => {
  test('resets visible turn numbering and per-conversation counters', () => {
    const session = new Session('probe', 'chat_id') as any
    session.turnCounter = 7
    session.currentGoal = { objective: 'old goal', status: 'in_progress' }
    session.cumStats = { tokens: 123, costUsd: 1.25, turns: 4 }
    session.lastTurnDelta = { tokens: 12, costUsd: 0.25, durationMs: 900 }
    session.currentTurnUsageBaseline = { total_tokens: 100 }
    session.currentTurnUsageBaselineKnown = true
    session.lastTurnUsage = { total_tokens: 120 }
    session.usageTotalsSeedUnknown = true

    session.resetFreshConversationState()

    expect(session.turnCounter).toBe(0)
    expect(session.currentGoal).toBeNull()
    expect(session.cumStats).toEqual({ tokens: 0, costUsd: 0, turns: 0 })
    expect(session.lastTurnDelta).toBeNull()
    expect(session.currentTurnUsageBaseline).toBeNull()
    expect(session.currentTurnUsageBaselineKnown).toBe(false)
    expect(session.lastTurnUsage).toBeNull()
    expect(session.usageTotalsSeedUnknown).toBe(false)
  })
})
