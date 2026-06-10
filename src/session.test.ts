import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

mock.module('./feishu', () => ({
  PROJECTS_ROOT: '/tmp/lodestar-projects',
  getSessionResume: () => null,
  getSessionModelSelection: () => null,
  getTenantToken: async () => 'tenant-token',
  preferredChatForSession: new Map(),
}))

const { Session } = await import('./session')
const cardkit = await import('./cardkit')

interface FetchCall {
  method: string
  path: string
  body: any
}

const originalFetch = globalThis.fetch
let calls: FetchCall[] = []

beforeEach(() => {
  calls = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({
      method: String(init?.method ?? 'GET'),
      path: url.pathname.replace('/open-apis/cardkit/v1', ''),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    return new Response(JSON.stringify({ code: 0, data: {} }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function turnState(cardId = 'card_session_turn'): any {
  return {
    cardId,
    messageId: 'om_session_turn',
    userOpenId: 'ou_user',
    trigger: 'user_message',
    toolCount: 0,
    toolByUseId: new Map(),
    planSteps: [],
    planExplanation: null,
    planUpdateCount: 0,
    goalUpdateCount: 0,
    contextCompactCount: 0,
    contextCompactionPending: new Map(),
    readBatches: new Map(),
    openReadBatchI: null,
    assistantSegmentCount: 0,
    currentAssistantSegmentId: null,
    currentAssistantText: '',
    segmentTexts: new Map(),
    startedAt: Date.now(),
    footerStatusHandle: null,
    footerStatusStartedAt: 0,
    footerStatusLabel: null,
    rotating: null,
    rotateCount: 0,
    rotateGivenUp: false,
    outboundSeenPaths: new Set(),
    outboundSentPaths: new Set(),
    hostAskMarkersSeen: new Set(),
  }
}

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

describe('Session assistant rendering', () => {
  test('buffers assistant deltas and inserts one completed markdown element without content streaming', async () => {
    const session = new Session('probe', 'chat_id') as any
    const turn = turnState()
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    try {
      session.appendAssistant('Hello')
      session.appendAssistant(', world')
      await cardkit.flush(turn.cardId)

      expect(calls.some(call => call.path.endsWith('/content'))).toBe(false)
      expect(calls.some(call => call.method === 'POST' && call.path === `/cards/${turn.cardId}/elements`)).toBe(false)

      session.finalizeCurrentAssistantSegment()
      await cardkit.flush(turn.cardId)

      const assistantAdd = calls.find(call =>
        call.method === 'POST' &&
        call.path === `/cards/${turn.cardId}/elements`
      )
      expect(JSON.parse(assistantAdd?.body.elements ?? '[]')).toEqual([{
        tag: 'markdown',
        element_id: 'assistant_0',
        content: 'Hello, world',
      }])

      const footerWrites = calls
        .filter(call => call.method === 'PUT' && call.path === `/cards/${turn.cardId}/elements/footer`)
        .map(call => JSON.parse(call.body.element).content as string)
      expect(footerWrites.some(content => content.startsWith('Writing...(0s)'))).toBe(true)
      expect(footerWrites.some(content => content.startsWith('Working...(0s)'))).toBe(true)
      expect(calls.some(call => call.path.endsWith('/content'))).toBe(false)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })
})
