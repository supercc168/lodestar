import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  boundResumes, deletedReactions, feishuMockState, projectProfiles, resetFeishuMock,
  sentCards, sentRawTexts, sentTexts, updatedCards, urgentPushes,
} from './feishu-test-mock'

const { Session } = await import('./session')
const cardkit = await import('./cardkit')
const sessionHostAsk = await import('./session-host-ask')
const { fixedModelChoices, normalizeFixedModelSelection, configuredDefaultSelection } = await import('./session-model')
const { config } = await import('./config')
const { peekUsage, updateUsageFromRateLimits } = await import('./usage')

interface FetchCall {
  method: string
  path: string
  body: any
}

const originalFetch = globalThis.fetch
let calls: FetchCall[] = []

beforeEach(() => {
  calls = []
  resetFeishuMock()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const path = url.pathname.replace('/open-apis/cardkit/v1', '')
    calls.push({
      method: String(init?.method ?? 'GET'),
      path,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    const data = path === '/cards/id_convert'
      ? { card_id: `card_status_${calls.length}` }
      : {}
    return new Response(JSON.stringify({ code: 0, data }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
})

class FakeAgentProc extends EventEmitter {
  lastAssistantUuid = null
  lastModel = null
  lastEffort = null
  lastUsage = null
  lastTotalUsage = null
  lastResult = {
    cost_usd: null,
    cost_delta_usd: null,
    duration_ms: null,
    num_turns: null,
    usage: null,
    subtype: null,
    is_error: false,
  }
  lastContextWindow = null
  sentTexts: string[] = []
  permissionResponses: Array<[string | number, 'allow' | 'deny', unknown]> = []
  hookResponses: Array<[string, object | undefined]> = []
  killCalls = 0
  setModelSettingsCalls: Array<[string, string]> = []
  alive = true

  constructor(
    readonly provider: 'codex' | 'claude',
    public sessionId: string | null = null,
  ) {
    super()
  }

  sendInitialize(): void {}

  sendUserText(text: string): void {
    this.sentTexts.push(text)
  }

  sendInterrupt(): void {}
  sendPermissionResponse(
    requestId: string | number,
    decision: 'allow' | 'deny',
    payload?: unknown,
  ): void {
    this.permissionResponses.push([requestId, decision, payload])
  }
  sendToolResult(): void {}
  sendHookResponse(requestId: string, output?: object): void {
    this.hookResponses.push([requestId, output])
  }

  isAlive(): boolean {
    return this.alive
  }

  async kill(): Promise<void> {
    this.killCalls++
    this.alive = false
    this.emit('exit', { code: 0, signal: null, expected: true })
  }

  async listModels(): Promise<any[]> {
    return []
  }

  async setModelSettings(model: string, effort: string): Promise<void> {
    this.setModelSettingsCalls.push([model, effort])
  }
  async setModel(): Promise<void> {}
  async compactThread(): Promise<void> {}
  async injectThreadItems(): Promise<void> {}
}

afterEach(() => {
  for (const session of Session.all as Set<any>) {
    session.endWatchdogTurn()
    session.stopFooterStatus(session.currentTurn)
    if (session.watchdogTickHandle) clearInterval(session.watchdogTickHandle)
    session.watchdogTickHandle = null
    session.dispose()
  }
  globalThis.fetch = originalFetch
})

function turnState(cardId = 'card_session_turn'): any {
  return {
    cardId,
    messageId: 'om_session_turn',
    userOpenId: 'ou_user',
    trigger: 'user_message',
    backendThreadId: null,
    backendTurnId: null,
    toolCount: 0,
    toolByUseId: new Map(),
    planSteps: [],
    planExplanation: null,
    planUpdateCount: 0,
    goalUpdateCount: 0,
    contextCompactCount: 0,
    contextCompactionPending: new Map(),
    watchdogSeenCompactionPhases: new Set(),
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
    footerStatusOverride: null,
    rotating: null,
    rotateCount: 0,
    failureRotateCount: 0,
    rotateGivenUp: false,
    outboundSeenPaths: new Set(),
    outboundSentPaths: new Set(),
    hostAskMarkersSeen: new Set(),
  }
}

function strictExecResult(literal = 'ready'): string {
  return JSON.stringify([
    { type: 'inputText', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
    { type: 'inputText', text: literal },
  ], null, 2)
}

let watchdogFixtureCount = 0

const DETERMINISTIC_FOOTER_HANDLE = -1 as unknown as ReturnType<typeof setInterval>

function setDeterministicFooterStatus(turn: any, label: string): void {
  turn.footerStatusHandle = DETERMINISTIC_FOOTER_HANDLE
  turn.footerStatusStartedAt = Date.now()
  turn.footerStatusLabel = label
}

function useDeterministicFooterStatus(session: any): void {
  const start = (turn: any, label: string): void => {
    setDeterministicFooterStatus(turn, label)
    session.renderFooterStatus(turn)
  }
  session.startThinkingFooter = (turn: any) => start(turn, 'Thinking...')
  session.startWritingFooter = (turn: any) => start(turn, 'Writing...')
  session.startWorkingFooter = (turn: any) => start(turn, 'Working...')
}

function wiredWatchdogSession(provider: 'codex' | 'claude' = 'codex'): {
  session: any
  proc: FakeAgentProc
  turn: any
} {
  const fixtureId = ++watchdogFixtureCount
  const sessionName = `watchdog-${provider}-${fixtureId}`
  projectProfiles.set(sessionName, { watchdogMode: 'warn' })
  const session = new Session(sessionName, 'chat_id') as any
  const proc = new FakeAgentProc(provider, `${provider}-thread-1`)
  const turn = turnState(`card_${provider}_watchdog_${fixtureId}`)
  session.selectedProvider = provider
  session.proc = proc
  session.currentTurn = turn
  session.turnCounter = 1
  useDeterministicFooterStatus(session)
  session.wireProc(proc)
  session.beginWatchdogTurn(turn, proc)
  return { session, proc, turn }
}

function confirmSessionNoop(
  proc: FakeAgentProc,
  id = 'noop-1',
  literal = 'ready',
): void {
  proc.emit('tool_use', {
    id,
    name: 'exec',
    input: `text(${JSON.stringify(literal)});\n`,
    parentToolUseId: null,
  })
  proc.emit('tool_result', {
    tool_use_id: id,
    content: strictExecResult(literal),
    is_error: false,
    parentToolUseId: null,
  })
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

async function waitForHostAskAttempt(ask: { resumeStarted?: boolean }, session: any): Promise<void> {
  const deadline = Date.now() + 2_000
  while (session.pendingHostAsks.has('host-ask-race') && ask.resumeStarted !== false) {
    if (Date.now() >= deadline) throw new Error('host ask continuation did not settle')
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

function answeredHostAsk(): any {
  return {
    questions: [{ question: 'Pick?', options: [{ label: 'A' }, { label: 'B' }] }],
    answered: new Map([[0, { optionIdx: 0, user: 'ou_user' }]]),
    currentIdx: undefined,
    toolCallId: 'call_host_ask_race',
    inputJson: '{"questions":[{"question":"Pick?","options":["A","B"]}]}',
    resumeStarted: false,
  }
}

function staleInitOpenFixture(sessionName: string): {
  session: any
  oldProc: FakeAgentProc
  start: () => void
  openPromise: () => Promise<void>
} {
  const session = new Session(sessionName, 'chat_id') as any
  const oldProc = new FakeAgentProc('codex', `${sessionName}-old-thread`)
  session.selectedProvider = 'codex'
  session.proc = oldProc
  session.pendingUserMessageCount = 1
  session.pendingTurnInputs = ['old queued input']
  session.lastUserOpenId = 'ou_old'
  session.pendingWatchdogIdentity = {
    proc: oldProc,
    threadId: oldProc.sessionId,
    turnId: 'old-turn',
    turnCounter: null,
  }
  session.wireProc(oldProc)

  const realOpenTurnCard = session.openTurnCard.bind(session)
  let pendingOpen: Promise<void> | null = null
  session.openTurnCard = (...args: any[]) => {
    pendingOpen = realOpenTurnCard(...args)
    return pendingOpen
  }
  return {
    session,
    oldProc,
    start: () => oldProc.emit('init', { session_id: oldProc.sessionId }),
    openPromise: () => {
      if (!pendingOpen) throw new Error('stale init open did not start')
      return pendingOpen
    },
  }
}

function replaceOpenProcess(session: any, suffix: string): {
  nextProc: FakeAgentProc
  nextTurn: any
} {
  const nextProc = new FakeAgentProc('codex', `codex-thread-${suffix}`)
  const nextTurn = turnState(`card_watchdog_${suffix}`)
  session.proc = nextProc
  session.currentTurn = nextTurn
  session.openingTurn = false
  session.status = 'starting'
  session.wireProc(nextProc)
  return { nextProc, nextTurn }
}

function expectStaleCardClosed(cardId: string): void {
  const footerCall = calls.find(call => {
    if (call.method !== 'PUT' || call.path !== `/cards/${cardId}/elements/footer`) return false
    const footer = JSON.parse(String(call.body?.element ?? '{}'))
    return String(footer.content ?? '').includes('后端已切换')
  })
  expect(footerCall).toBeDefined()
  const footer = JSON.parse(String(footerCall?.body?.element ?? '{}'))
  expect(footer.content).toContain('后端已切换')

  const settingsCall = calls.find(call => {
    if (call.method !== 'PATCH' || call.path !== `/cards/${cardId}/settings`) return false
    const settings = JSON.parse(String(call.body?.settings ?? '{}'))
    return String(settings.config?.summary?.content ?? '').includes('后端已切换')
  })
  expect(settingsCall).toBeDefined()
  const settings = JSON.parse(String(settingsCall?.body?.settings ?? '{}'))
  expect(settings.config?.streaming_mode).toBe(false)
  expect(settings.config?.summary?.content).toContain('后端已切换')
}

describe('Session Codex watchdog turn identity', () => {
  test('fails closed until the active Codex thread and turn identity are confirmed', () => {
    const { session, proc, turn } = wiredWatchdogSession()

    expect(session.watchdogSafetySnapshot(session.watchdogContext).currentTurn).toBe(false)

    proc.emit('turn_started', {
      thread_id: 'codex-thread-1',
      turn_id: 'codex-turn-1',
    })

    expect(session.watchdogContext).toMatchObject({
      proc,
      turn,
      threadId: 'codex-thread-1',
      turnId: 'codex-turn-1',
    })
    expect(turn.backendThreadId).toBe('codex-thread-1')
    expect(turn.backendTurnId).toBe('codex-turn-1')
    expect(session.watchdogSafetySnapshot(session.watchdogContext).currentTurn).toBe(true)
  })

  test('uses the exact supplied timestamp when beginning a watchdog turn', () => {
    projectProfiles.set('watchdog-fixed-time', { watchdogMode: 'warn' })
    const session = new Session('watchdog-fixed-time', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-thread-fixed-time')
    const turn = turnState('card_watchdog_fixed_time')
    session.selectedProvider = 'codex'
    session.proc = proc
    session.currentTurn = turn
    session.turnCounter = 1
    session.wireProc(proc)

    session.beginWatchdogTurn(turn, proc, 0)

    expect(session.watchdog.snapshot()).toMatchObject({
      turnKey: 'turn:1',
      lastMeaningfulAt: 0,
      lastMeaningfulLabel: 'turn_start',
    })
  })

  test('rejects a stale captured context after the active turn is replaced', () => {
    const { session, proc } = wiredWatchdogSession()
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'codex-turn-stale' })
    const staleContext = session.watchdogContext
    const replacementTurn = turnState('card_watchdog_replacement')
    replacementTurn.backendThreadId = proc.sessionId
    replacementTurn.backendTurnId = 'codex-turn-replacement'
    session.currentTurn = replacementTurn
    session.watchdogContext = {
      proc,
      turn: replacementTurn,
      threadId: proc.sessionId,
      turnId: 'codex-turn-replacement',
    }

    expect(session.watchdogContextIsCurrent(session.watchdogContext)).toBe(true)
    expect(session.watchdogContextIsCurrent(staleContext)).toBe(false)
    expect(session.watchdogSafetySnapshot(staleContext).currentTurn).toBe(false)
  })

  test('rejects a captured context when the bound process loses its session id', () => {
    const { session, proc } = wiredWatchdogSession()
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'codex-turn-lost-session' })
    const capturedContext = session.watchdogContext
    proc.sessionId = null

    expect(session.watchdogContextIsCurrent(capturedContext)).toBe(false)
    expect(session.watchdogSafetySnapshot(capturedContext).currentTurn).toBe(false)
  })

  test('requires a live process and the captured backend thread on TurnState', () => {
    const { session, proc, turn } = wiredWatchdogSession()
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'codex-turn-live-thread' })
    const capturedContext = session.watchdogContext

    turn.backendThreadId = null
    expect(session.watchdogContextIsCurrent(capturedContext)).toBe(false)
    turn.backendThreadId = proc.sessionId
    expect(session.watchdogContextIsCurrent(capturedContext)).toBe(true)
    turn.backendThreadId = 'codex-thread-replaced'
    expect(session.watchdogContextIsCurrent(capturedContext)).toBe(false)
    turn.backendThreadId = proc.sessionId
    proc.alive = false
    expect(session.watchdogContextIsCurrent(capturedContext)).toBe(false)
  })

  test('does not begin watchdog observation for a dead Codex process', () => {
    projectProfiles.set('watchdog-dead-process', { watchdogMode: 'warn' })
    const session = new Session('watchdog-dead-process', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-thread-dead')
    const turn = turnState('card_watchdog_dead_process')
    proc.alive = false
    session.selectedProvider = 'codex'
    session.proc = proc
    session.currentTurn = turn
    session.turnCounter = 1

    session.beginWatchdogTurn(turn, proc, 0)

    expect(session.watchdogContext).toBeNull()
    expect(session.watchdog.snapshot().turnKey).toBeNull()
  })

  test('caches an early turn identity while the card is opening and consumes it for the new turn', async () => {
    projectProfiles.set('watchdog-opening', { watchdogMode: 'warn' })
    const session = new Session('watchdog-opening', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-thread-opening')
    session.selectedProvider = 'codex'
    session.proc = proc
    session.openingTurn = true
    session.pendingTurnInputs = ['hello']
    session.wireProc(proc)

    proc.emit('turn_started', {
      thread_id: 'codex-thread-opening',
      turn_id: 'codex-turn-opening',
    })

    expect(session.pendingWatchdogIdentity).toEqual({
      proc,
      threadId: 'codex-thread-opening',
      turnId: 'codex-turn-opening',
      turnCounter: null,
    })

    try {
      await session.openTurnCard('ou_user', 'user_message', { startThinking: false })

      expect(session.currentTurn).not.toBeNull()
      expect(session.watchdogContext).toMatchObject({
        proc,
        turn: session.currentTurn,
        threadId: 'codex-thread-opening',
        turnId: 'codex-turn-opening',
      })
      expect(session.currentTurn.backendThreadId).toBe('codex-thread-opening')
      expect(session.currentTurn.backendTurnId).toBe('codex-turn-opening')
      expect(session.pendingWatchdogIdentity).toBeNull()
    } finally {
      session.stopFooterStatus(session.currentTurn)
      if (session.currentTurn) await cardkit.dispose(session.currentTurn.cardId)
    }
  })

  test('does not carry an early identity from a failed card open into the next turn', async () => {
    projectProfiles.set('watchdog-opening-failure', { watchdogMode: 'warn' })
    const session = new Session('watchdog-opening-failure', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-thread-opening-failure')
    session.selectedProvider = 'codex'
    session.proc = proc
    session.openingTurn = true
    session.pendingTurnInputs = ['first']
    session.wireProc(proc)
    proc.emit('turn_started', {
      thread_id: 'codex-thread-opening-failure',
      turn_id: 'stale-turn-id',
    })

    const healthyFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: 99, msg: 'boom' }), {
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
    await session.openTurnCard('ou_user', 'user_message', { startThinking: false })
    expect(session.currentTurn).toBeNull()

    globalThis.fetch = healthyFetch
    session.pendingTurnInputs = ['second']
    await session.openTurnCard('ou_user', 'user_message', { startThinking: false })

    try {
      expect(session.currentTurn).not.toBeNull()
      expect(session.currentTurn.backendTurnId).toBeNull()
      expect(session.watchdogContext?.turnId).toBeNull()
      expect(session.watchdogSafetySnapshot(session.watchdogContext).currentTurn).toBe(false)
    } finally {
      session.stopFooterStatus(session.currentTurn)
      if (session.currentTurn) await cardkit.dispose(session.currentTurn.cardId)
    }
  })

  test('begins a cold Codex observation only after start succeeds and before footer or user text', async () => {
    projectProfiles.set('watchdog-cold', { watchdogMode: 'warn' })
    const session = new Session('watchdog-cold', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-thread-cold')
    const order: string[] = []
    session.selectedProvider = 'codex'
    session.start = async () => {
      order.push('start')
      session.proc = proc
      session.wireProc(proc)
      return true
    }
    session.startThinkingFooter = () => {
      order.push(session.watchdogContext ? 'footer:observed' : 'footer:unobserved')
    }
    proc.sendUserText = (text: string) => {
      order.push(session.watchdogContext ? `send:observed:${text}` : `send:unobserved:${text}`)
    }

    try {
      await session.startColdUserTurn('hello', 'hello', 'ou_user')

      expect(order).toEqual(['start', 'footer:observed', 'send:observed:hello'])
      expect(session.watchdogContext).toMatchObject({
        proc,
        turn: session.currentTurn,
        threadId: 'codex-thread-cold',
        turnId: null,
      })
    } finally {
      session.stopFooterStatus(session.currentTurn)
      if (session.currentTurn) await cardkit.dispose(session.currentTurn.cardId)
    }
  })

  test('does not begin observation for Claude or a project with watchdog off', () => {
    const { session: claudeSession } = wiredWatchdogSession('claude')
    expect(claudeSession.watchdog.snapshot().turnKey).toBeNull()
    expect(claudeSession.watchdogContext).toBeNull()

    projectProfiles.set('watchdog-off', { watchdogMode: 'off' })
    const offSession = new Session('watchdog-off', 'chat_id') as any
    const offProc = new FakeAgentProc('codex', 'codex-thread-off')
    const offTurn = turnState('card_watchdog_off')
    offSession.selectedProvider = 'codex'
    offSession.proc = offProc
    offSession.currentTurn = offTurn
    offSession.turnCounter = 1
    offSession.wireProc(offProc)
    offSession.beginWatchdogTurn(offTurn, offProc)

    expect(offSession.watchdog.snapshot().turnKey).toBeNull()
    expect(offSession.watchdogContext).toBeNull()
  })
})

describe('Session Codex watchdog progress observation', () => {
  test('counts only a matched exec start/result pair and records backend identity', () => {
    const { session, proc, turn } = wiredWatchdogSession()
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'codex-turn-progress' })

    confirmSessionNoop(proc)

    expect(session.watchdog.snapshot()).toMatchObject({
      repeatCount: 1,
      pendingCandidateCount: 0,
      activeRealToolCount: 0,
    })
    expect(turn.backendThreadId).toBe('codex-thread-1')
    expect(turn.backendTurnId).toBe('codex-turn-progress')
  })

  test('clears no-op evidence for each meaningful in-memory Codex progress event', () => {
    const { session, proc, turn } = wiredWatchdogSession()
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'codex-turn-meaningful' })
    let noopIndex = 0
    const seed = (): void => {
      confirmSessionNoop(proc, `noop-${++noopIndex}`)
      expect(session.watchdog.snapshot().repeatCount).toBe(1)
    }
    const expectCleared = (label: string): void => {
      expect(session.watchdog.snapshot()).toMatchObject({
        repeatCount: 0,
        fingerprintHash: null,
        lastMeaningfulLabel: label,
      })
    }

    try {
      seed()
      proc.emit('assistant_text', { text: 'visible progress' })
      expectCleared('assistant_text')

      seed()
      proc.emit('tool_use', { id: 'bash-1', name: 'Bash', input: { command: 'pwd' }, parentToolUseId: null })
      expectCleared('tool_use:Bash')
      proc.emit('tool_result', { tool_use_id: 'bash-1', content: 'done', is_error: false, parentToolUseId: null })

      seed()
      proc.emit('turn_plan_updated', {
        plan: [{ step: 'Inspect', status: 'inProgress' }],
        explanation: 'Start here',
      })
      expectCleared('turn_plan_updated')

      seed()
      proc.emit('plan_delta', { itemId: 'plan-1', delta: 'Drafting next step' })
      expectCleared('plan_delta')

      seed()
      proc.emit('thread_goal_updated', {
        objective: 'Ship the watchdog',
        status: 'active',
        tokenBudget: 10_000,
        tokensUsed: 100,
        timeUsedSeconds: 2,
      })
      expectCleared('thread_goal_updated')

      seed()
      proc.emit('thread_goal_cleared', {})
      expectCleared('thread_goal_cleared')

      seed()
      proc.emit('context_compacted', { itemId: 'compact-1', phase: 'start' })
      expectCleared('context_compaction:start')
    } finally {
      session.stopFooterStatus(turn)
    }
  })

  test('does not clear no-op evidence for telemetry, blank text, or duplicate structured state', () => {
    const { session, proc, turn } = wiredWatchdogSession()
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'codex-turn-duplicates' })
    proc.emit('turn_plan_updated', {
      plan: [{ step: 'Inspect', status: 'inProgress' }],
      explanation: 'Start here',
    })
    proc.emit('thread_goal_updated', {
      objective: 'Ship the watchdog',
      status: 'active',
      tokenBudget: 10_000,
      tokensUsed: 100,
      timeUsedSeconds: 2,
    })
    proc.emit('context_compacted', { itemId: 'compact-duplicate', phase: 'start' })
    confirmSessionNoop(proc, 'duplicate-evidence')

    proc.emit('assistant_text', { text: '   \n' })
    proc.emit('token_usage', { totalUsage: null })
    proc.emit('rate_limits_updated', {})
    proc.emit('error', new Error('diagnostic only'))
    proc.emit('plan_delta', { itemId: 'plan-empty', delta: '' })
    proc.emit('turn_plan_updated', {
      plan: [{ step: 'Inspect', status: 'inProgress' }],
      explanation: 'Start here',
    })
    proc.emit('thread_goal_updated', {
      objective: 'Ship the watchdog',
      status: 'active',
      tokenBudget: 10_000,
      tokensUsed: 999,
      timeUsedSeconds: 99,
    })
    proc.emit('context_compacted', { itemId: 'compact-duplicate', phase: 'start' })

    expect(session.watchdog.snapshot().repeatCount).toBe(1)
    session.stopFooterStatus(turn)
  })

  test('ignores every side-effecting event from a replaced process', async () => {
    const first = wiredWatchdogSession()
    first.proc.emit('turn_started', { thread_id: first.proc.sessionId, turn_id: 'turn-old' })

    const nextProc = new FakeAgentProc('codex', 'codex-thread-new')
    nextProc.lastTotalUsage = {
      input_tokens: 500,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 50,
    } as any
    nextProc.lastResult = {
      cost_usd: 1,
      cost_delta_usd: 0.5,
      duration_ms: 500,
      num_turns: 1,
      usage: null,
      subtype: 'success',
      is_error: false,
    }
    const nextTurn = turnState('card_watchdog_new')
    first.session.proc = nextProc
    first.session.currentTurn = nextTurn
    first.session.turnCounter = 2
    first.session.wireProc(nextProc)
    first.session.beginWatchdogTurn(nextTurn, nextProc)
    nextProc.emit('turn_started', { thread_id: 'codex-thread-new', turn_id: 'turn-new' })
    confirmSessionNoop(nextProc, 'current-evidence')
    await cardkit.flush(nextTurn.cardId)

    const stableGoal = {
      objective: 'Keep the current turn intact',
      status: 'active',
      tokenBudget: 20_000,
      tokensUsed: 200,
      timeUsedSeconds: 3,
    }
    first.session.currentGoal = stableGoal
    nextTurn.planSteps = [{ step: 'Current', status: 'inProgress' }]
    nextTurn.planExplanation = 'Current process plan'
    nextTurn.currentAssistantSegmentId = 'assistant_current'
    nextTurn.currentAssistantText = 'current assistant text'
    nextTurn.segmentTexts.set('assistant_previous', 'previous assistant text')
    first.session.initCount = 7
    first.session.currentTurnUsageBaseline = {
      input_tokens: 400,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 40,
    }
    first.session.currentTurnUsageBaselineKnown = true
    first.session.usageTotalsSeedUnknown = true
    first.session.cumStats = { tokens: 10, costUsd: 0.25, turns: 2 }
    first.session.lastTurnDelta = { tokens: 5, costUsd: 0.1, durationMs: 100 }
    first.session.pendingMidTurnMsgs = [{
      text: 'current queued message',
      wireText: 'current queued message',
      userOpenId: 'ou_current',
      msgId: 'om_current',
    }]
    first.session.status = 'working'

    const seededUsage = updateUsageFromRateLimits({
      planType: 'stable',
      primary: { usedPercent: 17, resetsAt: 1_700_000_000, windowDurationMins: 300 },
    })
    const planBefore = JSON.stringify({
      steps: nextTurn.planSteps,
      explanation: nextTurn.planExplanation,
      count: nextTurn.planUpdateCount,
    })
    const toolsBefore = JSON.stringify([...nextTurn.toolByUseId.entries()])
    const assistantBefore = {
      segmentCount: nextTurn.assistantSegmentCount,
      segmentId: nextTurn.currentAssistantSegmentId,
      text: nextTurn.currentAssistantText,
      segments: JSON.stringify([...nextTurn.segmentTexts.entries()]),
    }
    const compactionBefore = {
      count: nextTurn.contextCompactCount,
      pending: JSON.stringify([...nextTurn.contextCompactionPending.entries()]),
    }
    const usageBaselineBefore = { ...first.session.currentTurnUsageBaseline }
    const identityBefore = {
      backendThreadId: nextTurn.backendThreadId,
      backendTurnId: nextTurn.backendTurnId,
      watchdogThreadId: first.session.watchdogContext.threadId,
      watchdogTurnId: first.session.watchdogContext.turnId,
    }
    const statsBefore = JSON.stringify({
      cumStats: first.session.cumStats,
      lastTurnDelta: first.session.lastTurnDelta,
    })
    const boundResumesBefore = JSON.stringify(boundResumes)
    const lastSessionIdBefore = first.session.lastSessionId
    const cardWritesBefore = calls.length
    let closeCalls = 0
    let closePromise: Promise<void> | null = null
    let drainCalls = 0
    const realCloseTurnCard = first.session.closeTurnCard.bind(first.session)
    first.session.closeTurnCard = (...args: any[]) => {
      closeCalls++
      closePromise = realCloseTurnCard(...args)
      return closePromise
    }
    first.session.drainMidTurnAndOpen = async () => {
      drainCalls++
    }

    first.proc.emit('init', { session_id: first.proc.sessionId })
    first.proc.emit('turn_started', { thread_id: first.proc.sessionId, turn_id: 'late-turn' })
    first.proc.emit('token_usage', {
      totalUsage: {
        input_tokens: 900,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 90,
      },
    })
    first.proc.emit('rate_limits_updated', {
      planType: 'stale',
      primary: { usedPercent: 99, resetsAt: 1_800_000_000, windowDurationMins: 300 },
    })
    first.proc.emit('assistant_text', { text: 'late assistant' })
    first.proc.emit('assistant_block_stop', {})
    first.proc.emit('tool_use', { id: 'late-bash', name: 'Bash', input: { command: 'pwd' }, parentToolUseId: null })
    first.proc.emit('tool_result', { tool_use_id: 'late-bash', content: 'late', is_error: false, parentToolUseId: null })
    first.proc.emit('turn_plan_updated', {
      plan: [{ step: 'Stale', status: 'completed' }],
      explanation: 'old process',
    })
    first.proc.emit('plan_delta', { itemId: 'late-plan', delta: 'late delta' })
    first.proc.emit('context_compacted', { itemId: 'late-compact', phase: 'start' })
    first.proc.emit('thread_goal_updated', {
      objective: 'Stale process goal',
      status: 'completed',
      tokenBudget: 1,
      tokensUsed: 1,
      timeUsedSeconds: 1,
    })
    first.proc.emit('thread_goal_cleared', {})
    first.proc.emit('can_use_tool', {
      request_id: 'late-permission',
      tool_use_id: 'late-bash',
      tool_name: 'Bash',
      input: { command: 'pwd' },
      permission_suggestions: [],
    })
    first.proc.emit('hook_callback', { request_id: 'late-hook', hook_name: 'PostToolUse' })
    first.proc.emit('bg_task_started', {
      task_id: 'late-background',
      task_type: 'workflow',
      description: 'late background event',
    })
    first.proc.emit('result', {})

    if (closePromise) await closePromise
    else await cardkit.flush(nextTurn.cardId)

    expect(first.session.currentTurn).toBe(nextTurn)
    expect(JSON.stringify({
      steps: nextTurn.planSteps,
      explanation: nextTurn.planExplanation,
      count: nextTurn.planUpdateCount,
    })).toBe(planBefore)
    expect(first.session.currentGoal).toBe(stableGoal)
    expect(JSON.stringify([...nextTurn.toolByUseId.entries()])).toBe(toolsBefore)
    expect({
      segmentCount: nextTurn.assistantSegmentCount,
      segmentId: nextTurn.currentAssistantSegmentId,
      text: nextTurn.currentAssistantText,
      segments: JSON.stringify([...nextTurn.segmentTexts.entries()]),
    }).toEqual(assistantBefore)
    expect({
      count: nextTurn.contextCompactCount,
      pending: JSON.stringify([...nextTurn.contextCompactionPending.entries()]),
    }).toEqual(compactionBefore)
    expect(calls.length).toBe(cardWritesBefore)
    expect(first.session.pendingPermissions.size).toBe(0)
    expect(first.proc.permissionResponses).toEqual([])
    expect(nextProc.permissionResponses).toEqual([])
    expect(first.proc.hookResponses).toEqual([])
    expect(nextProc.hookResponses).toEqual([])
    expect(closeCalls).toBe(0)
    expect(drainCalls).toBe(0)
    expect(first.session.initCount).toBe(7)
    expect(first.session.currentTurnUsageBaseline).toEqual(usageBaselineBefore)
    expect(first.session.currentTurnUsageBaselineKnown).toBe(true)
    expect(first.session.usageTotalsSeedUnknown).toBe(true)
    expect({
      backendThreadId: nextTurn.backendThreadId,
      backendTurnId: nextTurn.backendTurnId,
      watchdogThreadId: first.session.watchdogContext.threadId,
      watchdogTurnId: first.session.watchdogContext.turnId,
    }).toEqual(identityBefore)
    expect(peekUsage()).toBe(seededUsage)
    expect(JSON.stringify({
      cumStats: first.session.cumStats,
      lastTurnDelta: first.session.lastTurnDelta,
    })).toBe(statsBefore)
    expect(JSON.stringify(boundResumes)).toBe(boundResumesBefore)
    expect(first.session.lastSessionId).toBe(lastSessionIdBefore)
    expect(first.session.status).toBe('working')
    expect(first.session.watchdog.snapshot().repeatCount).toBe(1)
    expect(first.session.backgroundTasks).toEqual([])
    expect(first.session.pendingBgTasks).toEqual([])
    expect(first.session.watchdogSafetySnapshot(first.session.watchdogContext).backgroundWorkRunning).toBe(false)
    first.session.stopFooterStatus(nextTurn)
  })

  test('cleans stale opening markers and rebuilds an active background card after migration', async () => {
    const fixture = staleInitOpenFixture('watchdog-stale-after-bg-migrate')
    const { session } = fixture
    session.backgroundTasks = [{
      id: 'bg-still-running',
      type: 'subagent',
      description: 'still running',
      status: 'running',
      startedAt: Date.now(),
      steps: [],
    }]
    session.backgroundCard = { messageId: 'om_bg_old', cardId: 'card_bg_old' }
    cardkit.recordCardCreated('card_bg_old', 1)

    const migrateRequestStarted = deferred<void>()
    const migrateRequest = deferred<Response>()
    const healthyFetch = globalThis.fetch
    let holdFirstRequest = true
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (holdFirstRequest) {
        holdFirstRequest = false
        migrateRequestStarted.resolve()
        return await migrateRequest.promise
      }
      return await healthyFetch(input, init)
    }) as typeof fetch

    try {
      fixture.start()
      await migrateRequestStarted.promise
      expect(session.watchdogOpeningTurnCounter).toBe(1)
      expect(session.pendingWatchdogIdentity?.turnCounter).toBe(1)

      const { nextProc, nextTurn } = replaceOpenProcess(session, 'after-bg-migrate')
      migrateRequest.resolve(new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      }))
      await fixture.openPromise()
      await Promise.resolve()

      expect(session.proc).toBe(nextProc)
      expect(session.currentTurn).toBe(nextTurn)
      expect(session.watchdogOpeningTurnCounter).toBeNull()
      expect(session.pendingWatchdogIdentity).toBeNull()
      expect(session.pendingRebuildBackgroundCard).toBe(false)
      expect(session.backgroundCard).not.toBeNull()
      expect(session.backgroundTasks.map((task: any) => task.id)).toEqual(['bg-still-running'])
    } finally {
      globalThis.fetch = healthyFetch
      session.openingTurn = false
      await session.resetBackgroundTasks()
    }
  })

  test('closes a stale main card after sendCard and preserves new opening markers', async () => {
    const fixture = staleInitOpenFixture('watchdog-stale-after-send-card')
    const { session } = fixture
    const sendStarted = deferred<void>()
    const sendResult = deferred<string | null>()
    feishuMockState.sendCard = async () => {
      sendStarted.resolve()
      return await sendResult.promise
    }

    try {
      fixture.start()
      await sendStarted.promise
      const staleCounter = session.watchdogOpeningTurnCounter
      const { nextProc, nextTurn } = replaceOpenProcess(session, 'after-send-card')
      session.openingTurn = true
      session.watchdogOpeningTurnCounter = staleCounter
      session.watchdogOpeningProc = nextProc
      session.pendingWatchdogIdentity = {
        proc: nextProc,
        threadId: nextProc.sessionId,
        turnId: 'new-turn',
        turnCounter: staleCounter,
      }

      sendResult.resolve('om_stale_after_send')
      await fixture.openPromise()
      await Promise.resolve()

      expect(session.proc).toBe(nextProc)
      expect(session.currentTurn).toBe(nextTurn)
      expect(session.openingTurn).toBe(true)
      expect(session.watchdogOpeningTurnCounter).toBe(staleCounter)
      expect(session.watchdogOpeningProc).toBe(nextProc)
      expect(session.pendingWatchdogIdentity?.proc).toBe(nextProc)
      expectStaleCardClosed('card_status_1')
    } finally {
      feishuMockState.sendCard = null
      session.openingTurn = false
      session.stopFooterStatus(session.currentTurn)
    }
  })

  test('falls back to message update when stale card conversion fails', async () => {
    const fixture = staleInitOpenFixture('watchdog-stale-during-convert')
    const { session } = fixture
    const convertStarted = deferred<void>()
    const convertResult = deferred<Response>()
    const healthyFetch = globalThis.fetch
    let holdFirstRequest = true
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (holdFirstRequest) {
        holdFirstRequest = false
        convertStarted.resolve()
        return await convertResult.promise
      }
      return await healthyFetch(input, init)
    }) as typeof fetch

    try {
      fixture.start()
      await convertStarted.promise
      expect(session.watchdogOpeningTurnCounter).toBe(1)
      expect(session.pendingWatchdogIdentity?.turnCounter).toBe(1)
      const { nextProc, nextTurn } = replaceOpenProcess(session, 'during-convert')

      convertResult.resolve(new Response(JSON.stringify({ code: 99, msg: 'convert failed' }), {
        headers: { 'Content-Type': 'application/json' },
      }))
      await fixture.openPromise()
      await Promise.resolve()

      expect(session.proc).toBe(nextProc)
      expect(session.currentTurn).toBe(nextTurn)
      expect(session.watchdogOpeningTurnCounter).toBeNull()
      expect(session.pendingWatchdogIdentity).toBeNull()
      expect(updatedCards).toHaveLength(1)
      expect(updatedCards[0]?.[0]).toBe('om_status_1')
      const terminalCard = updatedCards[0]?.[1] as any
      expect(terminalCard?.config?.streaming_mode).toBe(false)
      expect(JSON.stringify(terminalCard)).toContain('后端已切换')
    } finally {
      globalThis.fetch = healthyFetch
      session.stopFooterStatus(session.currentTurn)
    }
  })

  test('settles an eager stale open without expectedProc after process replacement', async () => {
    projectProfiles.set('watchdog-stale-eager-no-expected-proc', { watchdogMode: 'warn' })
    const session = new Session('watchdog-stale-eager-no-expected-proc', 'chat_id') as any
    const oldProc = new FakeAgentProc('codex', 'codex-thread-stale-eager')
    const sendStarted = deferred<void>()
    const sendResult = deferred<string | null>()
    session.selectedProvider = 'codex'
    session.proc = oldProc
    session.pendingTurnInputs = ['stale eager input']
    session.wireProc(oldProc)
    feishuMockState.sendCard = async () => {
      sendStarted.resolve()
      return await sendResult.promise
    }

    try {
      const staleOpen = session.openTurnCard('ou_old', 'user_message', { startThinking: false })
      await sendStarted.promise
      const { nextProc, nextTurn } = replaceOpenProcess(session, 'eager-no-expected-proc')

      sendResult.resolve('om_stale_eager_no_expected_proc')
      await staleOpen
      await Promise.resolve()

      expect(session.proc).toBe(nextProc)
      expect(session.currentTurn).toBe(nextTurn)
      expectStaleCardClosed('card_status_1')
    } finally {
      feishuMockState.sendCard = null
      session.stopFooterStatus(session.currentTurn)
    }
  })

  test('does not continue an eager user turn after its card open loses ownership', async () => {
    projectProfiles.set('watchdog-stale-eager-caller', { watchdogMode: 'warn' })
    const session = new Session('watchdog-stale-eager-caller', 'chat_id') as any
    const oldProc = new FakeAgentProc('codex', 'codex-thread-stale-eager-caller')
    const sendStarted = deferred<void>()
    const sendResult = deferred<string | null>()
    session.selectedProvider = 'codex'
    session.proc = oldProc
    session.initCount = 1
    session.wireProc(oldProc)
    feishuMockState.sendCard = async () => {
      sendStarted.resolve()
      return await sendResult.promise
    }

    try {
      const staleMessage = session.onUserMessage('stale prompt', [], 'ou_old')
      await sendStarted.promise
      const { nextProc, nextTurn } = replaceOpenProcess(session, 'eager-caller')

      sendResult.resolve('om_stale_eager_caller')
      await staleMessage
      await Promise.resolve()

      expect(session.currentTurn).toBe(nextTurn)
      expect(nextProc.sentTexts).toEqual([])
      expect(session.status).toBe('starting')
      expectStaleCardClosed('card_status_1')
    } finally {
      feishuMockState.sendCard = null
      session.openingTurn = false
      session.stopFooterStatus(session.currentTurn)
    }
  })

  test('does not send a cold-start prompt after its opened turn is replaced', async () => {
    projectProfiles.set('watchdog-stale-cold-caller', { watchdogMode: 'warn' })
    const session = new Session('watchdog-stale-cold-caller', 'chat_id') as any
    const startedProc = new FakeAgentProc('codex', 'codex-thread-stale-cold-caller')
    const startEntered = deferred<void>()
    const startResult = deferred<void>()
    let staleTurn: any = null
    session.selectedProvider = 'codex'
    session.start = async () => {
      session.proc = startedProc
      session.wireProc(startedProc)
      startEntered.resolve()
      await startResult.promise
      return true
    }

    try {
      const staleMessage = session.onUserMessage('cold stale prompt', [], 'ou_old')
      await startEntered.promise
      staleTurn = session.currentTurn
      const { nextProc, nextTurn } = replaceOpenProcess(session, 'cold-caller')

      startResult.resolve()
      await staleMessage

      expect(session.currentTurn).toBe(nextTurn)
      expect(startedProc.sentTexts).toEqual([])
      expect(nextProc.sentTexts).toEqual([])
      expect(session.status).toBe('starting')
      expectStaleCardClosed(staleTurn.cardId)
    } finally {
      startResult.resolve()
      session.stopFooterStatus(staleTurn)
      session.stopFooterStatus(session.currentTurn)
    }
  })

  test('settles a cold-start card replaced while its queued writes flush', async () => {
    projectProfiles.set('watchdog-stale-cold-flush', { watchdogMode: 'warn' })
    const session = new Session('watchdog-stale-cold-flush', 'chat_id') as any
    const startedProc = new FakeAgentProc('codex', 'codex-thread-stale-cold-flush')
    const footerWriteStarted = deferred<void>()
    const footerWriteResult = deferred<Response>()
    const healthyFetch = globalThis.fetch
    let heldFooterWrite = false
    let staleTurn: any = null
    session.selectedProvider = 'codex'
    session.start = async () => {
      session.proc = startedProc
      session.wireProc(startedProc)
      return true
    }
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      if (!heldFooterWrite && init?.method === 'PUT' && path.endsWith('/elements/footer')) {
        heldFooterWrite = true
        footerWriteStarted.resolve()
        return await footerWriteResult.promise
      }
      return await healthyFetch(input, init)
    }) as typeof fetch

    try {
      const staleMessage = session.onUserMessage('cold flush stale prompt', [], 'ou_old')
      await footerWriteStarted.promise
      staleTurn = session.currentTurn
      await new Promise(resolve => setTimeout(resolve, 0))
      const { nextProc, nextTurn } = replaceOpenProcess(session, 'cold-flush')

      footerWriteResult.resolve(new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      }))
      await staleMessage

      expect(session.currentTurn).toBe(nextTurn)
      expect(startedProc.sentTexts).toEqual([])
      expect(nextProc.sentTexts).toEqual([])
      expect(session.status).toBe('starting')
      expectStaleCardClosed(staleTurn.cardId)
    } finally {
      footerWriteResult.resolve(new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      }))
      globalThis.fetch = healthyFetch
      session.stopFooterStatus(staleTurn)
      session.stopFooterStatus(session.currentTurn)
    }
  })

  test('clears the captured cold-start turn when only its process owner changes during flush', async () => {
    projectProfiles.set('watchdog-stale-cold-same-turn', { watchdogMode: 'warn' })
    const session = new Session('watchdog-stale-cold-same-turn', 'chat_id') as any
    const startedProc = new FakeAgentProc('codex', 'codex-thread-stale-cold-same-turn')
    const footerWriteStarted = deferred<void>()
    const footerWriteResult = deferred<Response>()
    const healthyFetch = globalThis.fetch
    let heldFooterWrite = false
    let staleTurn: any = null
    session.selectedProvider = 'codex'
    session.start = async () => {
      session.proc = startedProc
      session.wireProc(startedProc)
      return true
    }
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      if (!heldFooterWrite && init?.method === 'PUT' && path.endsWith('/elements/footer')) {
        heldFooterWrite = true
        footerWriteStarted.resolve()
        return await footerWriteResult.promise
      }
      return await healthyFetch(input, init)
    }) as typeof fetch

    try {
      const staleMessage = session.onUserMessage('cold same-turn stale prompt', [], 'ou_old')
      await footerWriteStarted.promise
      staleTurn = session.currentTurn
      await new Promise(resolve => setTimeout(resolve, 0))
      session.beginWatchdogTurn(staleTurn, startedProc)
      startedProc.emit('turn_started', {
        thread_id: startedProc.sessionId,
        turn_id: 'codex-turn-stale-cold-same-turn',
      })
      expect(session.watchdogContext?.turn).toBe(staleTurn)

      const nextProc = new FakeAgentProc('codex', 'codex-thread-stale-cold-same-turn-next')
      session.proc = nextProc
      session.wireProc(nextProc)
      footerWriteResult.resolve(new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      }))
      await staleMessage

      expect(session.proc).toBe(nextProc)
      expect(session.currentTurn).toBeNull()
      expect(session.watchdogContext).toBeNull()
      expectStaleCardClosed(staleTurn.cardId)

      await session.onUserMessage('next owner work', [], 'ou_next')
      expect(nextProc.sentTexts).toEqual(['next owner work'])
      expect(session.pendingMidTurnMsgs).toEqual([])
    } finally {
      footerWriteResult.resolve(new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      }))
      globalThis.fetch = healthyFetch
      session.stopFooterStatus(staleTurn)
      session.stopFooterStatus(session.currentTurn)
    }
  })

  test('does not restore working status after a drained turn open loses ownership', async () => {
    projectProfiles.set('watchdog-stale-drain-caller', { watchdogMode: 'warn' })
    const session = new Session('watchdog-stale-drain-caller', 'chat_id') as any
    const oldProc = new FakeAgentProc('codex', 'codex-thread-stale-drain-caller')
    const sendStarted = deferred<void>()
    const sendResult = deferred<string | null>()
    session.selectedProvider = 'codex'
    session.proc = oldProc
    session.pendingMidTurnMsgs = [{
      text: 'queued stale prompt',
      wireText: 'queued stale prompt',
      userOpenId: 'ou_old',
      msgId: 'om_stale_drain_reaction',
    }]
    session.pendingReactionIds = new Map([
      ['om_stale_drain_reaction', 'reaction_stale_drain'],
    ])
    session.wireProc(oldProc)
    feishuMockState.sendCard = async () => {
      sendStarted.resolve()
      return await sendResult.promise
    }

    try {
      const staleDrain = session.drainMidTurnAndOpen()
      await sendStarted.promise
      const { nextProc, nextTurn } = replaceOpenProcess(session, 'drain-caller')
      session.currentBatchReactionIds.set('om_replacement_turn', 'reaction_replacement_turn')

      sendResult.resolve('om_stale_drain_caller')
      await staleDrain
      await Promise.resolve()

      expect(session.currentTurn).toBe(nextTurn)
      expect(oldProc.sentTexts).toEqual([])
      expect(nextProc.sentTexts).toEqual([])
      expect(session.pendingUserMessageCount).toBe(0)
      expect(session.status).toBe('starting')
      expectStaleCardClosed('card_status_1')
      expect(deletedReactions).toEqual([
        ['om_stale_drain_reaction', 'reaction_stale_drain'],
      ])
      expect(session.pendingReactionIds.has('om_stale_drain_reaction')).toBe(false)
      expect(session.currentBatchReactionIds).toEqual(new Map([
        ['om_replacement_turn', 'reaction_replacement_turn'],
      ]))
    } finally {
      feishuMockState.sendCard = null
      session.openingTurn = false
      session.stopFooterStatus(session.currentTurn)
    }
  })

  test('does not send a drained prompt when its turn card fails to open', async () => {
    projectProfiles.set('watchdog-failed-drain-caller', { watchdogMode: 'warn' })
    const session = new Session('watchdog-failed-drain-caller', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-thread-failed-drain-caller')
    session.selectedProvider = 'codex'
    session.proc = proc
    session.pendingMidTurnMsgs = [{
      text: 'failed drain prompt',
      wireText: 'failed drain prompt',
      userOpenId: 'ou_old',
      msgId: 'om_failed_drain_reaction',
    }]
    session.pendingReactionIds = new Map([
      ['om_failed_drain_reaction', 'reaction_failed_drain'],
      ['om_unrelated_pending', 'reaction_unrelated_pending'],
    ])
    session.currentBatchReactionIds = new Map([
      ['om_unrelated_batch', 'reaction_unrelated_batch'],
    ])
    session.wireProc(proc)
    feishuMockState.sendCard = async () => null
    const statusBefore = session.status

    try {
      await session.drainMidTurnAndOpen()

      expect(proc.sentTexts).toEqual([])
      expect(session.pendingUserMessageCount).toBe(0)
      expect(session.currentTurn).toBeNull()
      expect(session.status).toBe(statusBefore)
      expect(deletedReactions).toEqual([
        ['om_failed_drain_reaction', 'reaction_failed_drain'],
      ])
      expect(session.pendingReactionIds).toEqual(new Map([
        ['om_unrelated_pending', 'reaction_unrelated_pending'],
      ]))
      expect(session.currentBatchReactionIds).toEqual(new Map([
        ['om_unrelated_batch', 'reaction_unrelated_batch'],
      ]))
    } finally {
      feishuMockState.sendCard = null
      session.openingTurn = false
      session.stopFooterStatus(session.currentTurn)
    }
  })

  test('does not mark a replacement idle after a raced open close settles', async () => {
    projectProfiles.set('watchdog-raced-open-close', { watchdogMode: 'warn' })
    const session = new Session('watchdog-raced-open-close', 'chat_id') as any
    const oldProc = new FakeAgentProc('codex', 'codex-thread-raced-open-close')
    const openedTurn = turnState('card_watchdog_raced_open_close')
    const closeStarted = deferred<void>()
    const closeRelease = deferred<void>()
    const closeReturned = deferred<void>()
    session.selectedProvider = 'codex'
    session.proc = oldProc
    session.pendingUserMessageCount = 1
    session.pendingTurnInputs = ['raced close input']
    session.wireProc(oldProc)
    session.openTurnCard = async () => {
      session.currentTurn = openedTurn
      session.sawResultWhileOpening = true
      return { kind: 'opened', turn: openedTurn }
    }
    session.closeTurnCard = async () => {
      expect(session.currentTurn).toBe(openedTurn)
      session.currentTurn = null
      closeStarted.resolve()
      await closeRelease.promise
      closeReturned.resolve()
    }

    try {
      oldProc.emit('init', { session_id: oldProc.sessionId })
      await closeStarted.promise
      const { nextProc, nextTurn } = replaceOpenProcess(session, 'raced-open-close')

      closeRelease.resolve()
      await closeReturned.promise
      await Promise.resolve()

      expect(session.proc).toBe(nextProc)
      expect(session.currentTurn).toBe(nextTurn)
      expect(session.status).toBe('starting')
    } finally {
      closeRelease.resolve()
      session.openingTurn = false
      session.stopFooterStatus(session.currentTurn)
    }
  })

  test('settles an older same-process open after a newer open generation wins', async () => {
    projectProfiles.set('watchdog-stale-open-generation', { watchdogMode: 'warn' })
    const session = new Session('watchdog-stale-open-generation', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-thread-open-generation')
    const firstSendStarted = deferred<void>()
    const firstSendResult = deferred<string | null>()
    let sendCount = 0
    session.selectedProvider = 'codex'
    session.proc = proc
    session.pendingTurnInputs = ['older input']
    session.wireProc(proc)
    feishuMockState.sendCard = async () => {
      sendCount++
      if (sendCount === 1) {
        firstSendStarted.resolve()
        return await firstSendResult.promise
      }
      return 'om_newer_open_generation'
    }

    try {
      const olderOpen = session.openTurnCard('ou_old', 'user_message', { startThinking: false })
      await firstSendStarted.promise
      session.pendingTurnInputs = ['newer input']
      await session.openTurnCard('ou_new', 'user_message', { startThinking: false })
      const newerTurn = session.currentTurn
      expect(newerTurn?.messageId).toBe('om_newer_open_generation')

      firstSendResult.resolve('om_stale_open_generation')
      await olderOpen
      await Promise.resolve()

      expect(session.currentTurn).toBe(newerTurn)
      expectStaleCardClosed('card_status_2')
    } finally {
      feishuMockState.sendCard = null
      session.stopFooterStatus(session.currentTurn)
    }
  })
})

describe('Session host ask continuation ownership', () => {
  test('retains the answered ask when the process changes during thread item injection', async () => {
    const session = new Session('host-ask-inject-race', 'chat_id') as any
    const oldProc = new FakeAgentProc('codex', 'codex-thread-host-ask-old')
    const injectionStarted = deferred<void>()
    const injectionResult = deferred<void>()
    const ask = answeredHostAsk()
    oldProc.injectThreadItems = async () => {
      injectionStarted.resolve()
      await injectionResult.promise
    }
    session.selectedProvider = 'codex'
    session.proc = oldProc
    session.status = 'idle'
    session.pendingHostAsks.set('host-ask-race', ask)
    session.wireProc(oldProc)

    sessionHostAsk.resumeAnsweredHostAsks(session)
    await injectionStarted.promise
    expect(ask.resumeStarted).toBe(true)

    const nextProc = new FakeAgentProc('codex', 'codex-thread-host-ask-next')
    session.proc = nextProc
    session.wireProc(nextProc)
    injectionResult.resolve()
    await waitForHostAskAttempt(ask, session)

    expect(oldProc.sentTexts).toEqual([])
    expect(nextProc.sentTexts).toEqual([])
    expect(session.pendingHostAsks.get('host-ask-race')).toBe(ask)
    expect(ask.resumeStarted).toBe(false)
  })

  test('retains the answered ask when the process changes during continuation card open', async () => {
    const session = new Session('host-ask-open-race', 'chat_id') as any
    const oldProc = new FakeAgentProc('codex', 'codex-thread-host-ask-open-old')
    const sendStarted = deferred<void>()
    const sendResult = deferred<string | null>()
    const ask = answeredHostAsk()
    session.selectedProvider = 'codex'
    session.proc = oldProc
    session.status = 'idle'
    session.pendingHostAsks.set('host-ask-race', ask)
    session.wireProc(oldProc)
    feishuMockState.sendCard = async () => {
      sendStarted.resolve()
      return await sendResult.promise
    }

    try {
      sessionHostAsk.resumeAnsweredHostAsks(session)
      await sendStarted.promise
      expect(ask.resumeStarted).toBe(true)

      const nextProc = new FakeAgentProc('codex', 'codex-thread-host-ask-open-next')
      session.proc = nextProc
      session.wireProc(nextProc)
      sendResult.resolve('om_host_ask_stale_open')
      await waitForHostAskAttempt(ask, session)

      expect(oldProc.sentTexts).toEqual([])
      expect(nextProc.sentTexts).toEqual([])
      expect(session.pendingHostAsks.get('host-ask-race')).toBe(ask)
      expect(ask.resumeStarted).toBe(false)
    } finally {
      sendResult.resolve(null)
      feishuMockState.sendCard = null
      session.openingTurn = false
      session.stopFooterStatus(session.currentTurn)
    }
  })
})

describe('Session Codex watchdog structured activity and safety', () => {
  test('keeps active child-agent state and activity dedupe across watchdog turn boundaries', () => {
    const { session, proc } = wiredWatchdogSession()
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'turn-agent-boundary-1' })
    const startedActivity = {
      activityId: 'activity-boundary-start',
      agentThreadId: 'agent-boundary',
      agentPath: '/root/agent-boundary',
      kind: 'started',
    }
    proc.emit('subagent_activity', startedActivity)
    proc.emit('collab_agent_state', {
      toolUseId: 'collab-boundary',
      agentsStates: { 'agent-boundary': { status: 'running' } },
    })

    session.endWatchdogTurn()
    expect(session.codexCollabAgentStates).toEqual(new Map([['agent-boundary', 'running']]))
    expect(session.codexCollabAgentStatesByTool).toEqual(new Map([
      ['collab-boundary', new Map([['agent-boundary', 'running']])],
    ]))
    expect(session.codexSubagentActivityIds).toEqual(new Set(['activity-boundary-start']))
    expect(session.activeCodexSubagentActivities).toEqual(new Set(['agent-boundary']))

    const nextTurn = turnState('card_watchdog_agent_boundary_2')
    session.currentTurn = nextTurn
    session.turnCounter = 2
    session.beginWatchdogTurn(nextTurn, proc, 123)
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'turn-agent-boundary-2' })

    expect(session.watchdogSafetySnapshot(session.watchdogContext).backgroundWorkRunning).toBe(true)
    confirmSessionNoop(proc, 'boundary-noop')
    proc.emit('subagent_activity', startedActivity)
    expect(session.watchdog.snapshot().repeatCount).toBe(1)

    proc.emit('collab_agent_state', {
      toolUseId: 'collab-boundary',
      agentsStates: { 'agent-boundary': { status: 'completed' } },
    })
    expect(session.watchdogSafetySnapshot(session.watchdogContext).backgroundWorkRunning).toBe(false)
  })

  test('accepts cross-tool terminal child-agent cleanup from the current process between turns', () => {
    const { session, proc } = wiredWatchdogSession()
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'turn-agent-cleanup-1' })
    proc.emit('subagent_activity', {
      activityId: 'activity-cleanup-a-start',
      agentThreadId: 'agent-cleanup-a',
      agentPath: '/root/agent-cleanup-a',
      kind: 'started',
    })
    proc.emit('subagent_activity', {
      activityId: 'activity-cleanup-b-start',
      agentThreadId: 'agent-cleanup-b',
      agentPath: '/root/agent-cleanup-b',
      kind: 'started',
    })
    proc.emit('collab_agent_state', {
      toolUseId: 'collab-cleanup-b-running',
      agentsStates: { 'agent-cleanup-b': { status: 'running' } },
    })
    session.endWatchdogTurn()
    const watchdogAfterEnd = session.watchdog.snapshot()

    proc.emit('subagent_activity', {
      activityId: 'activity-cleanup-a-stop',
      agentThreadId: 'agent-cleanup-a',
      agentPath: '/root/agent-cleanup-a',
      kind: 'interrupted',
    })
    proc.emit('collab_agent_state', {
      toolUseId: 'collab-cleanup-b-terminal',
      agentsStates: { 'agent-cleanup-b': { status: 'completed' } },
    })

    expect(session.activeCodexSubagentActivities.size).toBe(0)
    expect(session.codexCollabAgentStates.size).toBe(0)
    expect(session.codexCollabAgentStatesByTool.size).toBe(0)
    expect(session.watchdog.snapshot()).toEqual(watchdogAfterEnd)
  })

  test('ignores nonterminal child-agent events without a current watchdog turn', () => {
    const { session, proc } = wiredWatchdogSession()
    session.endWatchdogTurn()
    const watchdogAfterEnd = session.watchdog.snapshot()

    proc.emit('subagent_activity', {
      activityId: 'activity-no-turn-start',
      agentThreadId: 'agent-no-turn',
      agentPath: '/root/agent-no-turn',
      kind: 'started',
    })
    proc.emit('collab_agent_state', {
      toolUseId: 'collab-no-turn',
      agentsStates: { 'agent-no-turn': { status: 'waiting' } },
    })

    expect(session.codexSubagentActivityIds.size).toBe(0)
    expect(session.activeCodexSubagentActivities.size).toBe(0)
    expect(session.codexCollabAgentStates.size).toBe(0)
    expect(session.codexCollabAgentStatesByTool.size).toBe(0)
    expect(session.watchdog.snapshot()).toEqual(watchdogAfterEnd)
  })

  test('clears process-owned child-agent state on process replacement and exit', () => {
    const first = wiredWatchdogSession()
    first.proc.emit('turn_started', { thread_id: first.proc.sessionId, turn_id: 'turn-process-owner-1' })
    first.proc.emit('subagent_activity', {
      activityId: 'activity-old-process',
      agentThreadId: 'agent-old-process',
      agentPath: '/root/agent-old-process',
      kind: 'started',
    })
    first.proc.emit('collab_agent_state', {
      toolUseId: 'collab-old-process',
      agentsStates: { 'agent-old-process': { status: 'running' } },
    })

    const nextProc = new FakeAgentProc('codex', 'codex-thread-next-process')
    first.session.proc = nextProc
    first.session.wireProc(nextProc)
    expect(first.session.codexSubagentActivityIds.size).toBe(0)
    expect(first.session.activeCodexSubagentActivities.size).toBe(0)
    expect(first.session.codexCollabAgentStates.size).toBe(0)
    expect(first.session.codexCollabAgentStatesByTool.size).toBe(0)

    const nextTurn = turnState('card_watchdog_next_process')
    first.session.currentTurn = nextTurn
    first.session.turnCounter = 2
    first.session.beginWatchdogTurn(nextTurn, nextProc, 0)
    nextProc.emit('turn_started', { thread_id: nextProc.sessionId, turn_id: 'turn-process-owner-2' })
    nextProc.emit('subagent_activity', {
      activityId: 'activity-next-process',
      agentThreadId: 'agent-next-process',
      agentPath: '/root/agent-next-process',
      kind: 'started',
    })
    nextProc.emit('collab_agent_state', {
      toolUseId: 'collab-next-process',
      agentsStates: { 'agent-next-process': { status: 'running' } },
    })

    nextProc.emit('exit', { code: 1, signal: null, expected: true })
    expect(first.session.codexSubagentActivityIds.size).toBe(0)
    expect(first.session.activeCodexSubagentActivities.size).toBe(0)
    expect(first.session.codexCollabAgentStates.size).toBe(0)
    expect(first.session.codexCollabAgentStatesByTool.size).toBe(0)
  })

  test('deduplicates activity ids while tracking sub-agent lifetime by agent thread id', () => {
    const { session, proc } = wiredWatchdogSession()
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'turn-subagent' })
    confirmSessionNoop(proc, 'subagent-seed-1')

    proc.emit('subagent_activity', {
      activityId: 'activity-start',
      agentThreadId: 'agent-thread-1',
      agentPath: '/root/worker-1',
      kind: 'started',
    })
    expect(session.watchdog.snapshot()).toMatchObject({ repeatCount: 0, lastMeaningfulLabel: 'subagent_activity:started' })
    expect(session.activeCodexSubagentActivities).toEqual(new Set(['agent-thread-1']))
    expect(session.watchdogSafetySnapshot(session.watchdogContext).backgroundWorkRunning).toBe(true)

    confirmSessionNoop(proc, 'subagent-seed-2')
    proc.emit('subagent_activity', {
      activityId: 'activity-start',
      agentThreadId: 'agent-thread-1',
      agentPath: '/root/worker-1',
      kind: 'started',
    })
    expect(session.watchdog.snapshot().repeatCount).toBe(1)

    proc.emit('subagent_activity', {
      activityId: 'activity-interact',
      agentThreadId: 'agent-thread-1',
      agentPath: '/root/worker-1',
      kind: 'interacted',
    })
    expect(session.watchdog.snapshot()).toMatchObject({ repeatCount: 0, lastMeaningfulLabel: 'subagent_activity:interacted' })
    expect(session.activeCodexSubagentActivities).toEqual(new Set(['agent-thread-1']))

    confirmSessionNoop(proc, 'subagent-seed-3')
    proc.emit('subagent_activity', {
      activityId: 'activity-stop',
      agentThreadId: 'agent-thread-1',
      agentPath: '/root/worker-1',
      kind: 'interrupted',
    })
    expect(session.watchdog.snapshot()).toMatchObject({ repeatCount: 0, lastMeaningfulLabel: 'subagent_activity:interrupted' })
    expect(session.activeCodexSubagentActivities.size).toBe(0)
    expect(session.watchdogSafetySnapshot(session.watchdogContext).backgroundWorkRunning).toBe(false)
  })

  test('tracks changed collab states and clears terminal or residual active agents', () => {
    const { session, proc } = wiredWatchdogSession()
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'turn-collab' })
    confirmSessionNoop(proc, 'collab-seed-1')

    proc.emit('collab_agent_state', {
      toolUseId: 'collab-1',
      agentsStates: {
        'agent-running': { status: 'running' },
        'agent-done': { status: 'completed' },
      },
    })
    expect(session.watchdog.snapshot()).toMatchObject({ repeatCount: 0, lastMeaningfulLabel: 'collab_agent_state' })
    expect(session.codexCollabAgentStates).toEqual(new Map([['agent-running', 'running']]))
    expect(session.watchdogSafetySnapshot(session.watchdogContext).backgroundWorkRunning).toBe(true)

    confirmSessionNoop(proc, 'collab-seed-2')
    proc.emit('collab_agent_state', {
      toolUseId: 'collab-1',
      agentsStates: {
        'agent-running': { status: 'running' },
        'agent-done': { status: 'completed' },
      },
    })
    expect(session.watchdog.snapshot().repeatCount).toBe(1)

    session.activeCodexSubagentActivities.add('agent-running')
    proc.emit('collab_agent_state', {
      toolUseId: 'collab-1',
      agentsStates: {
        'agent-running': { status: 'completed' },
        'agent-done': { status: 'shutdown' },
      },
    })
    expect(session.watchdog.snapshot()).toMatchObject({ repeatCount: 0, lastMeaningfulLabel: 'collab_agent_state' })
    expect(session.codexCollabAgentStates.size).toBe(0)
    expect(session.activeCodexSubagentActivities.size).toBe(0)
    expect(session.watchdogSafetySnapshot(session.watchdogContext).backgroundWorkRunning).toBe(false)
  })

  test('fails closed while any nonterminal collab status remains', () => {
    const { session, proc } = wiredWatchdogSession()
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'turn-collab-unknown-status' })

    proc.emit('collab_agent_state', {
      toolUseId: 'collab-unknown-status',
      agentsStates: { 'agent-waiting': { status: 'waiting' } },
    })

    expect(session.codexCollabAgentStates).toEqual(new Map([['agent-waiting', 'waiting']]))
    expect(session.watchdogSafetySnapshot(session.watchdogContext).backgroundWorkRunning).toBe(true)
  })

  test('treats an omitted collab status as notFound terminal state', () => {
    const { session, proc } = wiredWatchdogSession()
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'turn-collab-missing-status' })
    proc.emit('subagent_activity', {
      activityId: 'agent-missing-started',
      agentThreadId: 'agent-missing-status',
      agentPath: '/root/agent-missing-status',
      kind: 'started',
    })
    confirmSessionNoop(proc, 'collab-missing-seed')

    proc.emit('collab_agent_state', {
      toolUseId: 'collab-missing-status',
      agentsStates: { 'agent-missing-status': {} },
    })

    expect(session.watchdog.snapshot()).toMatchObject({
      repeatCount: 0,
      lastMeaningfulLabel: 'collab_agent_state',
    })
    expect(session.codexCollabAgentStatesByTool.size).toBe(0)
    expect(session.codexCollabAgentStates.size).toBe(0)
    expect(session.activeCodexSubagentActivities.size).toBe(0)
    expect(session.watchdogSafetySnapshot(session.watchdogContext).backgroundWorkRunning).toBe(false)

    confirmSessionNoop(proc, 'collab-missing-duplicate-seed')
    proc.emit('collab_agent_state', {
      toolUseId: 'collab-missing-status',
      agentsStates: { 'agent-missing-status': {} },
    })
    expect(session.watchdog.snapshot().repeatCount).toBe(1)
  })

  test('isolates concurrent collab snapshots by tool use id', () => {
    const { session, proc } = wiredWatchdogSession()
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'turn-collab-concurrent' })

    proc.emit('collab_agent_state', {
      toolUseId: 'tool-a',
      agentsStates: { 'agent-a': { status: 'running' } },
    })
    proc.emit('collab_agent_state', {
      toolUseId: 'tool-b',
      agentsStates: { 'agent-b': { status: 'running' } },
    })
    proc.emit('subagent_activity', {
      activityId: 'agent-b-started',
      agentThreadId: 'agent-b',
      agentPath: '/root/agent-b',
      kind: 'started',
    })

    expect(session.codexCollabAgentStates).toEqual(new Map([
      ['agent-a', 'running'],
      ['agent-b', 'running'],
    ]))
    expect(session.codexCollabAgentStatesByTool).toEqual(new Map([
      ['tool-a', new Map([['agent-a', 'running']])],
      ['tool-b', new Map([['agent-b', 'running']])],
    ]))
    expect(session.watchdogSafetySnapshot(session.watchdogContext).backgroundWorkRunning).toBe(true)

    confirmSessionNoop(proc, 'collab-concurrent-seed')
    proc.emit('collab_agent_state', {
      toolUseId: 'tool-a',
      agentsStates: { 'agent-a': { status: 'running' } },
    })
    expect(session.watchdog.snapshot().repeatCount).toBe(1)

    proc.emit('collab_agent_state', {
      toolUseId: 'tool-a',
      agentsStates: { 'agent-a': { status: 'completed' } },
    })
    expect(session.codexCollabAgentStates).toEqual(new Map([['agent-b', 'running']]))
    expect(session.activeCodexSubagentActivities).toEqual(new Set(['agent-b']))
    expect(session.watchdogSafetySnapshot(session.watchdogContext).backgroundWorkRunning).toBe(true)

    proc.emit('collab_agent_state', {
      toolUseId: 'tool-b',
      agentsStates: { 'agent-b': { status: 'completed' } },
    })
    expect(session.codexCollabAgentStatesByTool.size).toBe(0)
    expect(session.codexCollabAgentStates.size).toBe(0)
    expect(session.activeCodexSubagentActivities.size).toBe(0)
    expect(session.watchdogSafetySnapshot(session.watchdogContext).backgroundWorkRunning).toBe(false)
  })

  test('removes terminal agents from every collab tool pool during an active turn', () => {
    const { session, proc } = wiredWatchdogSession()
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'turn-collab-shared-agent' })
    const running = { 'agent-shared': { status: 'running' } }

    proc.emit('collab_agent_state', { toolUseId: 'tool-running', agentsStates: running })

    expect(session.watchdog.snapshot()).toMatchObject({
      repeatCount: 0,
      lastMeaningfulLabel: 'collab_agent_state',
    })
    expect(session.codexCollabAgentStatesByTool).toEqual(new Map([
      ['tool-running', new Map([['agent-shared', 'running']])],
    ]))
    expect(session.watchdogSafetySnapshot(session.watchdogContext).backgroundWorkRunning).toBe(true)

    confirmSessionNoop(proc, 'collab-shared-terminal-pool')
    proc.emit('collab_agent_state', {
      toolUseId: 'tool-terminal',
      agentsStates: { 'agent-shared': { status: 'completed' } },
    })

    expect(session.watchdog.snapshot()).toMatchObject({
      repeatCount: 0,
      lastMeaningfulLabel: 'collab_agent_state',
    })
    expect(session.codexCollabAgentStatesByTool.size).toBe(0)
    expect(session.codexCollabAgentStates.size).toBe(0)
    expect(session.watchdogSafetySnapshot(session.watchdogContext).backgroundWorkRunning).toBe(false)
  })

  test('observes only real background task projection changes', () => {
    const { session, proc } = wiredWatchdogSession()
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'turn-background' })
    session.onBackgroundTaskChanged = () => {}
    const started = {
      task_id: 'bg-1',
      task_type: 'workflow',
      description: 'Run workflow',
    }

    confirmSessionNoop(proc, 'bg-seed-1')
    proc.emit('bg_task_started', started)
    expect(session.watchdog.snapshot()).toMatchObject({ repeatCount: 0, lastMeaningfulLabel: 'bg_task_started' })
    expect(session.watchdogSafetySnapshot(session.watchdogContext).backgroundWorkRunning).toBe(true)

    confirmSessionNoop(proc, 'bg-seed-2')
    proc.emit('bg_task_started', { ...started, description: 'Description-only update is excluded' })
    expect(session.watchdog.snapshot().repeatCount).toBe(1)

    proc.emit('bg_task_progress', { task_id: 'bg-1', summary: 'Halfway' })
    expect(session.watchdog.snapshot()).toMatchObject({ repeatCount: 0, lastMeaningfulLabel: 'bg_task_progress' })

    confirmSessionNoop(proc, 'bg-seed-3')
    proc.emit('bg_task_progress', { task_id: 'bg-1', summary: 'Halfway' })
    expect(session.watchdog.snapshot().repeatCount).toBe(1)

    proc.emit('bg_task_settled', { task_id: 'bg-1', status: 'completed', summary: 'Done' })
    expect(session.watchdog.snapshot()).toMatchObject({ repeatCount: 0, lastMeaningfulLabel: 'bg_task_settled' })
    expect(session.watchdogSafetySnapshot(session.watchdogContext).backgroundWorkRunning).toBe(false)

    confirmSessionNoop(proc, 'bg-seed-4')
    proc.emit('bg_task_settled', { task_id: 'bg-1', status: 'completed', summary: 'Done' })
    expect(session.watchdog.snapshot().repeatCount).toBe(1)
  })

  test('reports every unsafe state and excludes the current input count from queued human work', () => {
    const { session, proc, turn } = wiredWatchdogSession()
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'turn-safety' })
    const context = session.watchdogContext
    expect(session.watchdogSafetySnapshot(context)).toEqual({
      currentTurn: true,
      eligibleTrigger: true,
      realToolRunning: false,
      backgroundWorkRunning: false,
      awaitingInput: false,
      compactionRunning: false,
      rotationRunning: false,
      agyRunning: false,
      queuedHumanWork: false,
      modelSwitchPending: false,
      recoveryActionInFlight: false,
    })

    proc.emit('tool_use', { id: 'pending-noop', name: 'exec', input: 'text("ready")', parentToolUseId: null })
    expect(session.watchdogSafetySnapshot(context).realToolRunning).toBe(true)
    proc.emit('tool_result', { tool_use_id: 'pending-noop', content: strictExecResult(), is_error: false, parentToolUseId: null })

    session.pendingPermissions.set('permission-1', { toolUseId: 'tool-1' })
    expect(session.watchdogSafetySnapshot(context).awaitingInput).toBe(true)
    session.pendingPermissions.clear()

    turn.contextCompactionPending.set('compact', { i: 0, cardId: turn.cardId, notice: {} })
    expect(session.watchdogSafetySnapshot(context).compactionRunning).toBe(true)
    turn.contextCompactionPending.clear()

    turn.rotating = Promise.resolve()
    expect(session.watchdogSafetySnapshot(context).rotationRunning).toBe(true)
    turn.rotating = null

    session.startingAgy = true
    expect(session.watchdogSafetySnapshot(context).agyRunning).toBe(true)
    session.startingAgy = false

    session.pendingUserMessageCount = 1
    expect(session.watchdogSafetySnapshot(context).queuedHumanWork).toBe(false)
    session.pendingTurnInputs = ['next']
    expect(session.watchdogSafetySnapshot(context).queuedHumanWork).toBe(true)
    session.pendingTurnInputs = []
    session.pendingMidTurnMsgs = [{ text: 'next', wireText: 'next', userOpenId: 'ou', msgId: 'om' }]
    expect(session.watchdogSafetySnapshot(context).queuedHumanWork).toBe(true)
    session.pendingMidTurnMsgs = []
    session.multiMsgBuffer = []
    expect(session.watchdogSafetySnapshot(context).queuedHumanWork).toBe(true)
    session.multiMsgBuffer = null

    session.modelSwitchPending = true
    expect(session.watchdogSafetySnapshot(context).modelSwitchPending).toBe(true)
    session.modelSwitchPending = false
    session.watchdogActionInFlight = true
    expect(session.watchdogSafetySnapshot(context).recoveryActionInFlight).toBe(true)
  })

  test('reuses one watchdog instance and recovery budget across a watchdog resume turn', () => {
    const { session, proc } = wiredWatchdogSession()
    const watchdog = session.watchdog
    session.watchdog.consumeRecovery()
    session.endWatchdogTurn()

    const resumed = turnState('card_watchdog_resumed')
    resumed.trigger = 'watchdog_resume'
    session.currentTurn = resumed
    session.turnCounter = 2
    session.beginWatchdogTurn(resumed, proc)

    expect(session.watchdog).toBe(watchdog)
    expect(session.watchdog.snapshot()).toMatchObject({
      turnKey: 'turn:2',
      trigger: 'watchdog_resume',
      recoveryAttempt: 1,
    })
  })
})

describe('Session Codex watchdog warning and model guard', () => {
  test('renders footer status only while both its timer and label are active', async () => {
    const { session, turn } = wiredWatchdogSession()
    cardkit.recordCardCreated(turn.cardId, 1)
    const footerWrites = (): FetchCall[] => calls.filter(call =>
      call.method === 'PUT' && call.path === `/cards/${turn.cardId}/elements/footer`)

    try {
      turn.footerStatusStartedAt = Date.now()
      turn.footerStatusLabel = 'Thinking...'
      turn.footerStatusHandle = null
      session.renderFooterStatus(turn, turn.footerStatusStartedAt + 1_000)
      await cardkit.flush(turn.cardId)
      expect(footerWrites()).toHaveLength(0)

      turn.footerStatusLabel = null
      turn.footerStatusHandle = DETERMINISTIC_FOOTER_HANDLE
      session.renderFooterStatus(turn, turn.footerStatusStartedAt + 2_000)
      await cardkit.flush(turn.cardId)
      expect(footerWrites()).toHaveLength(0)

      turn.footerStatusLabel = 'Thinking...'
      session.renderFooterStatus(turn, turn.footerStatusStartedAt + 3_000)
      await cardkit.flush(turn.cardId)
      expect(footerWrites()).toHaveLength(1)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('keeps a watchdog warning sticky across footer ticks and clears it on valid progress', async () => {
    const { session, proc, turn } = wiredWatchdogSession()
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'turn-warning' })
    cardkit.recordCardCreated(turn.cardId, 1)
    session.startThinkingFooter(turn)

    try {
      session.applyWatchdogWarning({ type: 'silent_warn', idleMs: 3_600_000 })
      session.renderFooterStatus(turn, turn.footerStatusStartedAt + 10_000)
      await cardkit.flush(turn.cardId)

      let footerWrites = calls
        .filter(call => call.method === 'PUT' && call.path === `/cards/${turn.cardId}/elements/footer`)
        .map(call => JSON.parse(call.body.element).content as string)
      expect(turn.footerStatusOverride).toBe('⚠️ 长时间无可见进展 · 仍在等待')
      expect(footerWrites.at(-1)).toContain('⚠️ 长时间无可见进展 · 仍在等待')

      proc.emit('assistant_text', { text: 'real progress' })
      await cardkit.flush(turn.cardId)

      footerWrites = calls
        .filter(call => call.method === 'PUT' && call.path === `/cards/${turn.cardId}/elements/footer`)
        .map(call => JSON.parse(call.body.element).content as string)
      expect(turn.footerStatusOverride).toBeNull()
      expect(footerWrites.at(-1)).toContain('Writing...(0s)')
      expect(footerWrites.at(-1)).not.toContain('长时间无可见进展')
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('clears sticky warnings for real tools but preserves matched no-op evidence', async () => {
    const { session, proc, turn } = wiredWatchdogSession()
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'turn-warning-tools' })
    cardkit.recordCardCreated(turn.cardId, 1)
    session.startThinkingFooter(turn)

    try {
      session.applyWatchdogWarning({ type: 'silent_warn', idleMs: 3_600_000 })
      confirmSessionNoop(proc, 'warning-matched-noop')
      expect(turn.footerStatusOverride).toBe('⚠️ 长时间无可见进展 · 仍在等待')
      expect(session.watchdog.snapshot().repeatCount).toBe(1)

      proc.emit('tool_use', {
        id: 'warning-real-tool',
        name: 'Bash',
        input: { command: 'pwd' },
        parentToolUseId: null,
      })
      await cardkit.flush(turn.cardId)
      expect(turn.footerStatusOverride).toBeNull()
      expect(session.watchdog.snapshot()).toMatchObject({
        repeatCount: 0,
        lastMeaningfulLabel: 'tool_use:Bash',
      })

      session.applyWatchdogWarning({ type: 'silent_warn', idleMs: 3_600_000 })
      proc.emit('tool_result', {
        tool_use_id: 'warning-real-tool',
        content: 'real tool result',
        is_error: false,
        parentToolUseId: null,
      })
      await cardkit.flush(turn.cardId)
      expect(turn.footerStatusOverride).toBeNull()
      expect(session.watchdog.snapshot().lastMeaningfulLabel).toBe('tool_result')
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('applies only silent or loop warnings and a footer render does not clear evidence', async () => {
    const { session, proc, turn } = wiredWatchdogSession()
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'turn-warning-types' })
    cardkit.recordCardCreated(turn.cardId, 1)
    session.startThinkingFooter(turn)
    confirmSessionNoop(proc, 'warning-seed')

    try {
      session.applyWatchdogWarning({
        type: 'recover',
        idleMs: 900_000,
        repeatCount: 10,
        fingerprintHash: 'hash',
      })
      session.renderFooterStatus(turn, turn.footerStatusStartedAt + 2_000)
      expect(turn.footerStatusOverride).toBeNull()
      expect(session.watchdog.snapshot().repeatCount).toBe(1)

      session.applyWatchdogWarning({
        type: 'loop_warn',
        idleMs: 900_000,
        repeatCount: 10,
        fingerprintHash: 'hash',
      })
      await cardkit.flush(turn.cardId)
      expect(turn.footerStatusOverride).toBe('⚠️ 检测到重复空调用 · 未自动中断')
      expect(session.watchdog.snapshot().repeatCount).toBe(1)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('sets modelSwitchPending during async settings and clears it after success', async () => {
    projectProfiles.set('watchdog-model-success', { watchdogMode: 'warn' })
    const session = new Session('watchdog-model-success', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-thread-model')
    const turn = turnState('card_watchdog_model_success')
    const settingsEntered = deferred<void>()
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    proc.setModelSettings = async () => {
      settingsEntered.resolve()
      await gate
    }
    session.selectedProvider = 'codex'
    session.proc = proc
    session.currentTurn = turn
    session.turnCounter = 1
    session.beginWatchdogTurn(turn, proc, 0)

    const resultPromise = session.onModelEffortSelect('gpt-5.6-sol', 'ultra', '', 'ou_user', 'codex')
    await settingsEntered.promise
    expect(session.watchdogSafetySnapshot(session.watchdogContext).modelSwitchPending).toBe(true)

    release()
    const result = await resultPromise
    expect(result.ok).toBe(true)
    expect(session.modelSwitchPending).toBe(false)
  })

  test('clears modelSwitchPending when model settings throw', async () => {
    const session = new Session('watchdog-model-failure', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-thread-model')
    let sawPending = false
    proc.setModelSettings = async () => {
      sawPending = session.modelSwitchPending
      throw new Error('settings failed')
    }
    session.selectedProvider = 'codex'
    session.proc = proc

    const result = await session.onModelEffortSelect('gpt-5.6-sol', 'ultra', '', 'ou_user', 'codex')

    expect(result.ok).toBe(false)
    expect(sawPending).toBe(true)
    expect(session.modelSwitchPending).toBe(false)
  })

  test('ends the active observation when the turn card closes', async () => {
    const { session, proc, turn } = wiredWatchdogSession()
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'turn-close' })
    turn.userOpenId = ''
    cardkit.recordCardCreated(turn.cardId, 1)

    try {
      await session.closeTurnCard()

      expect(session.watchdogContext).toBeNull()
      expect(session.watchdog.snapshot().turnKey).toBeNull()
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })
})

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

describe('Session token accounting', () => {
  test('uses Claude result usage when resumed totals baseline is unknown', () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.currentTurnUsageBaseline = null
    session.currentTurnUsageBaselineKnown = false
    session.usageTotalsSeedUnknown = true
    proc.lastResult = {
      cost_usd: 0.03,
      cost_delta_usd: 0.03,
      duration_ms: 1200,
      num_turns: 1,
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: 3,
        total_tokens: 15,
      },
      subtype: 'success',
      is_error: false,
    }
    proc.lastTotalUsage = {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      total_tokens: 150,
    }

    session.accumulateResultStats()

    expect(session.lastTurnUsage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 3,
      total_tokens: 15,
    })
    expect(session.lastTurnDelta).toEqual({
      tokens: 12,
      costUsd: 0,
      durationMs: 1200,
    })
    expect(session.cumStats).toEqual({
      tokens: 12,
      costUsd: 0,
      turns: 1,
    })
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

  test('treats askusr host markers as Codex-only', async () => {
    const session = new Session('probe', 'chat_id') as any
    const turn = turnState()
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    try {
      session.appendAssistant('Before [[askusr: {"questions":[{"question":"Pick?","options":["A","B"]}]}]] after')
      session.finalizeCurrentAssistantSegment()
      await cardkit.flush(turn.cardId)

      expect(session.pendingHostAsks.size).toBe(0)
      expect(sentCards.length).toBe(0)
      const assistantAdd = calls.find(call =>
        call.method === 'POST' &&
        call.path === `/cards/${turn.cardId}/elements`
      )
      const elements = JSON.parse(assistantAdd?.body.elements ?? '[]')
      expect(elements[0]?.content).not.toContain('askusr')
      expect(elements[0]?.content).not.toContain('已发起澄清问题')
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })
})

describe('Session compact command', () => {
  test('clears stale idle pending count before rejecting active turns', async () => {
    class FakeProc extends EventEmitter {
      sessionId = 'thread_stale_pending'
      turnId = 'turn_compact'
      compactCalls = 0

      isAlive(): boolean {
        return true
      }

      async compactThread(): Promise<void> {
        this.compactCalls++
        queueMicrotask(() => {
          this.emit('token_usage', {
            usage: { total_tokens: 5_361 },
            totalUsage: { total_tokens: 5_361 },
            contextWindow: 258_000,
            threadId: this.sessionId,
            turnId: this.turnId,
          })
          this.emit('context_compacted', {
            phase: 'end',
            threadId: this.sessionId,
            turnId: this.turnId,
          })
        })
      }
    }

    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeProc()
    session.proc = proc
    session.status = 'idle'
    session.initCount = 1
    session.pendingUserMessageCount = 1
    session.pendingReactionIds = new Map([['om_user_msg', 'reaction_one_second']])

    await expect(session.runCommand('cm')).resolves.toBe(true)

    expect(proc.compactCalls).toBe(1)
    expect(session.pendingUserMessageCount).toBe(0)
    expect(deletedReactions).toEqual([['om_user_msg', 'reaction_one_second']])
    expect(sentTexts.some(text => text.includes('先 `stop`'))).toBe(false)
    expect(sentRawTexts.some(text => text.includes('先 `stop`'))).toBe(false)
    const footerWrites = calls
      .filter(call => call.method === 'PUT' && call.path.endsWith('/elements/footer'))
      .map(call => JSON.parse(call.body.element).content as string)
    expect(footerWrites.some(content =>
      content.includes('✅ 上下文已压缩') && content.includes('🧠 2% (5.4K/258K)')
    )).toBe(true)
  })
})

describe('configuredDefaultSelection ([claude] default_model)', () => {
  test('未设 default_model → null(回落硬编码登录默认 Fable 5)', () => {
    const prev = config.claude.defaultModel
    ;(config.claude as any).defaultModel = undefined
    try {
      expect(configuredDefaultSelection()).toBeNull()
    } finally {
      ;(config.claude as any).defaultModel = prev
    }
  })

  test('default_model="glm" + 配好 token → 默认档位 claude:glm(effort 跟随 config)', () => {
    const prevModels = config.claude.models
    const prevDefault = config.claude.defaultModel
    ;(config.claude as any).models = {
      glm: { model: 'glm-5.2', base_url: 'https://open.bigmodel.cn/api/anthropic', auth_token: 't', effort: 'xhigh' },
    }
    ;(config.claude as any).defaultModel = 'glm'
    try {
      expect(configuredDefaultSelection()).toEqual({ provider: 'claude', model: 'claude:glm', effort: 'xhigh' })
    } finally {
      ;(config.claude as any).models = prevModels
      ;(config.claude as any).defaultModel = prevDefault
    }
  })

  test('接受完整形式 "claude:glm";effort 未配则回落固定 max', () => {
    const prevModels = config.claude.models
    const prevDefault = config.claude.defaultModel
    ;(config.claude as any).models = { glm: { model: 'glm-5.2', base_url: 'https://x', auth_token: 't' } }
    ;(config.claude as any).defaultModel = 'claude:glm'
    try {
      expect(configuredDefaultSelection()).toEqual({ provider: 'claude', model: 'claude:glm', effort: 'max' })
    } finally {
      ;(config.claude as any).models = prevModels
      ;(config.claude as any).defaultModel = prevDefault
    }
  })

  test('无法识别的 default_model → null', () => {
    const prev = config.claude.defaultModel
    ;(config.claude as any).defaultModel = 'nope'
    try {
      expect(configuredDefaultSelection()).toBeNull()
    } finally {
      ;(config.claude as any).defaultModel = prev
    }
  })
})

describe('normalizeFixedModelSelection ([codex.models.*] api 档位)', () => {
  test('配好的 codex api 档位保留 + 跟随 config effort', () => {
    const prev = config.codex.models
    ;(config.codex as any).models = {
      kimi: { base_url: 'https://api.moonshot.cn/v1', api_key: 'sk', model: 'kimi-k2', effort: 'high' },
    }
    try {
      expect(normalizeFixedModelSelection('codex', 'codex:kimi', null)).toEqual({ model: 'codex:kimi', effort: 'high' })
    } finally {
      ;(config.codex as any).models = prev
    }
  })

  test('未配置的 codex api 档位(缺 model)回落 gpt-5.6-sol/ultra', () => {
    const prev = config.codex.models
    ;(config.codex as any).models = { broken: { base_url: 'https://x', api_key: 'sk' } }
    try {
      const r = normalizeFixedModelSelection('codex', 'codex:broken', null)
      expect(r.model).toBe('gpt-5.6-sol')
      expect(r.effort).toBe('ultra')
    } finally {
      ;(config.codex as any).models = prev
    }
  })

  test('裸 gpt-5.6-sol 保持登录默认档', () => {
    expect(normalizeFixedModelSelection('codex', 'gpt-5.6-sol', null).model).toBe('gpt-5.6-sol')
  })

  test('legacy 裸 gpt-5.5(旧持久化)归一到 gpt-5.6-sol/ultra', () => {
    expect(normalizeFixedModelSelection('codex', 'gpt-5.5', 'xhigh'))
      .toEqual({ model: 'gpt-5.6-sol', effort: 'ultra' })
  })
})

describe('configuredDefaultSelection ([codex] api 档位)', () => {
  test('default_model="codex:kimi" + 配好 → 默认档位 codex:kimi(effort 跟随 config)', () => {
    const prevModels = config.codex.models
    const prevDefault = config.claude.defaultModel
    ;(config.codex as any).models = {
      kimi: { base_url: 'https://api.moonshot.cn/v1', api_key: 'sk', model: 'kimi-k2', effort: 'high' },
    }
    ;(config.claude as any).defaultModel = 'codex:kimi'
    try {
      expect(configuredDefaultSelection()).toEqual({ provider: 'codex', model: 'codex:kimi', effort: 'high' })
    } finally {
      ;(config.codex as any).models = prevModels
      ;(config.claude as any).defaultModel = prevDefault
    }
  })

  test('default_model 裸 gpt-5.6-sol → 内建 codex 档;legacy 裸 gpt-5.5 自动迁移', () => {
    const prevDefault = config.claude.defaultModel
    try {
      ;(config.claude as any).defaultModel = 'gpt-5.6-sol'
      expect(configuredDefaultSelection()).toEqual({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'ultra' })
      ;(config.claude as any).defaultModel = 'gpt-5.5'
      expect(configuredDefaultSelection()).toEqual({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'ultra' })
    } finally {
      ;(config.claude as any).defaultModel = prevDefault
    }
  })
})

describe('新 session 默认档位来自 [claude] default_model', () => {
  test('default_model=glm(配好 token)→ 新群首条消息默认走 GLM', () => {
    const prevModels = config.claude.models
    const prevDefault = config.claude.defaultModel
    ;(config.claude as any).models = {
      glm: { model: 'glm-5.2', base_url: 'https://open.bigmodel.cn/api/anthropic', auth_token: 't', effort: 'xhigh' },
    }
    ;(config.claude as any).defaultModel = 'glm'
    try {
      const s = new Session('probe', 'chat_id') as any
      expect(s.selectedProvider).toBe('claude')
      expect(s.selectedModel).toBe('claude:glm')
      expect(s.selectedEffort).toBe('xhigh')
    } finally {
      ;(config.claude as any).models = prevModels
      ;(config.claude as any).defaultModel = prevDefault
    }
  })

  test('default_model=glm 但未配 token → 构造器 normalize 回落 Fable 5(不落到打不通的路由)', () => {
    const prevModels = config.claude.models
    const prevDefault = config.claude.defaultModel
    ;(config.claude as any).models = {}
    ;(config.claude as any).defaultModel = 'glm'
    try {
      const s = new Session('probe', 'chat_id') as any
      expect(s.selectedModel).toBe('claude:fable')
      expect(s.selectedEffort).toBe('max')
    } finally {
      ;(config.claude as any).models = prevModels
      ;(config.claude as any).defaultModel = prevDefault
    }
  })

  test('无 default_model → selectedModel 保持 null(交给 spawn 硬编码登录默认)', () => {
    const prev = config.claude.defaultModel
    ;(config.claude as any).defaultModel = undefined
    try {
      const s = new Session('probe', 'chat_id') as any
      expect(s.selectedProvider).toBe('claude')
      expect(s.selectedModel).toBeNull()
    } finally {
      ;(config.claude as any).defaultModel = prev
    }
  })
})

describe('Fixed model selection normalization', () => {
  test('keeps valid first-party Claude choices intact', () => {
    expect(normalizeFixedModelSelection('claude', 'claude:opus', 'max'))
      .toEqual({ model: 'claude:opus', effort: 'max' })
    expect(normalizeFixedModelSelection('claude', 'claude:fable', 'max'))
      .toEqual({ model: 'claude:fable', effort: 'max' })
  })

  test('falls an UNCONFIGURED GLM selection back to the login default (Fable 5)', () => {
    // 无 token 配置时,持久化的 claude:glm 回落到 claude:fable(登录态),
    // 避免启动以未鉴权状态拉起、且绕过 picker 门槛。
    // 隔离 config:测试机可能已配 GLM(reclaude/GLM 环境),强制未配置态。
    const prev = config.claude.models
    ;(config.claude as any).models = {}
    try {
      expect(normalizeFixedModelSelection('claude', 'claude:glm', 'max'))
        .toEqual({ model: 'claude:fable', effort: 'max' })
    } finally {
      ;(config.claude as any).models = prev
    }
  })

  test('keeps a CONFIGURED GLM selection intact (不丢用户设好的 GLM)', () => {
    const prev = config.claude.models
    ;(config.claude as any).models = {
      glm: { model: 'glm-4.6', base_url: 'https://glm.example/anthropic', auth_token: 'tok' },
    }
    try {
      expect(normalizeFixedModelSelection('claude', 'claude:glm', 'max'))
        .toEqual({ model: 'claude:glm', effort: 'max' })
    } finally {
      ;(config.claude as any).models = prev
    }
  })

  test('resets an unknown/retired Claude model to the Claude default', () => {
    expect(normalizeFixedModelSelection('claude', 'claude:deepseek', 'high'))
      .toEqual({ model: 'claude:fable', effort: 'max' })
  })

  test('normalizes any Codex selection to the fixed GPT-5.6 Sol / ultra', () => {
    expect(normalizeFixedModelSelection('codex', 'gpt-4', 'low'))
      .toEqual({ model: 'gpt-5.6-sol', effort: 'ultra' })
  })
})

describe('Session provider switching', () => {
  test('uses provider-specific ask instructions', () => {
    const session = new Session('probe', 'chat_id') as any

    session.selectedProvider = 'codex'
    expect(session.spawnDeveloperInstructions()).toContain('[[askusr:')

    session.selectedProvider = 'claude'
    const instructions = session.spawnDeveloperInstructions()
    expect(instructions).toContain('AskUserQuestion')
    expect(instructions).not.toContain('[[askusr:')
  })

  test('keeps selected provider resume id from being overwritten by stale backend events', () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-thread-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.lastSessionId = 'claude-session-1'

    session.persistResumableSessionId()

    expect(boundResumes).toEqual([['probe', 'codex-thread-1', 'codex']])
    expect(session.lastSessionId).toBe('claude-session-1')
  })

  test('persists selected Claude resume id from init before a turn boundary', () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-init')
    session.proc = proc
    session.selectedProvider = 'claude'

    session.wireProc(proc)
    proc.emit('init', { session_id: 'claude-session-init' })

    expect(boundResumes).toEqual([['probe', 'claude-session-init', 'claude']])
    expect(session.lastSessionId).toBe('claude-session-init')
  })

  test('persists selected Claude resume id from result if turn_started was missed', () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-result')
    session.proc = proc
    session.selectedProvider = 'claude'

    session.wireProc(proc)
    proc.emit('result', {})

    expect(boundResumes).toEqual([['probe', 'claude-session-result', 'claude']])
    expect(session.lastSessionId).toBe('claude-session-result')
  })

  test('rejects cross-provider model switch while a turn is active', async () => {
    const session = new Session('probe', 'chat_id') as any
    session.proc = new FakeAgentProc('codex', 'codex-thread-1')
    session.selectedProvider = 'codex'
    session.currentTurn = turnState()

    const result = await session.onModelEffortSelect('claude:opus', 'max', '', 'ou_user', 'claude')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('正在执行或排队')
    expect(boundResumes).toEqual([])
    expect(session.selectedProvider).toBe('codex')
  })

  test('respawns idle Claude process when selecting an env-backed model profile', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.selectedModel = 'claude:default'

    const result = await session.onModelEffortSelect('claude:opus', 'max', '', 'ou_user', 'claude')

    expect(result.ok).toBe(true)
    expect(session.selectedModel).toBe('claude:opus')
    expect(proc.killCalls).toBe(1)
    expect(session.proc).toBeNull()
    expect(proc.setModelSettingsCalls).toEqual([])
    expect(result.card ? JSON.stringify(result.card) : '').toContain('下次启动 Claude')
  })

  test('rejects non-fixed Claude model outside the fixed choices', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.selectedModel = 'claude:default'

    const result = await session.onModelEffortSelect('claude:deepseek', 'high', '', 'ou_user', 'claude')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('不在固定选项中')
    expect(session.selectedModel).toBe('claude:default')
    expect(proc.killCalls).toBe(0)
  })

  test('accepts the first-party Claude Code choices (Opus 4.8 / Fable 5, max)', async () => {
    for (const model of ['claude:opus', 'claude:fable']) {
      const session = new Session('probe', 'chat_id') as any
      const proc = new FakeAgentProc('claude', 'claude-session-1')
      session.proc = proc
      session.selectedProvider = 'claude'
      session.selectedModel = 'claude:default'

      const result = await session.onModelEffortSelect(model, 'max', '', 'ou_user', 'claude')

      expect(result.ok).toBe(true)
      expect(session.selectedModel).toBe(model)
      expect(proc.killCalls).toBe(1) // model 变更 → 空闲 Claude 进程重生,新 env 下轮生效
      expect(session.proc).toBeNull()
    }
  })

  test('model 选择器展示 Opus 4.8 / Fable 5 官方档位 + GLM 第三方档位', () => {
    // 隔离 config:GLM description 的「未配置」提示只在 config 无 glm 时出现,
    // 测试机可能已配 GLM(reclaude/GLM 环境),强制未配置态。
    const prev = config.claude.models
    ;(config.claude as any).models = {}
    try {
      const session = new Session('probe', 'chat_id') as any
      session.selectedProvider = 'claude'
      const choices = fixedModelChoices(session)
      const claudeModels = choices.filter((c: any) => c.provider === 'claude').map((c: any) => c.model)
      expect(claudeModels).toContain('claude:opus')
      expect(claudeModels).toContain('claude:fable')
      expect(claudeModels).toContain('claude:glm')
      // 每个 Claude 档位锁死 max 最高思考强度
      for (const c of choices.filter((c: any) => c.provider === 'claude')) {
        expect(c.efforts.map((e: any) => e.effort)).toEqual(['max'])
      }
      // GLM 未配置 token 时,描述提示需要设置。
      const glm = choices.find((c: any) => c.model === 'claude:glm')
      expect(glm.description).toContain('配置')
    } finally {
      ;(config.claude as any).models = prev
    }
  })

  test('GLM 档位的 effort 跟随 config(xhigh)而非写死 max;官方档位仍 max', () => {
    const prev = config.claude.models
    ;(config.claude as any).models = {
      glm: { model: 'glm-5.2', base_url: 'https://open.bigmodel.cn/api/anthropic', auth_token: 't', effort: 'xhigh' },
    }
    try {
      const session = new Session('probe', 'chat_id') as any
      session.selectedProvider = 'claude'
      const choices = fixedModelChoices(session)
      const glm = choices.find((c: any) => c.model === 'claude:glm')
      expect(glm.efforts.map((e: any) => e.effort)).toEqual(['xhigh'])
      const opus = choices.find((c: any) => c.model === 'claude:opus')
      expect(opus.efforts.map((e: any) => e.effort)).toEqual(['max'])
    } finally {
      ;(config.claude as any).models = prev
    }
  })

  test('配好 xhigh 的 GLM:选 xhigh 通过,选 max 因不匹配被拒', async () => {
    const prev = config.claude.models
    ;(config.claude as any).models = {
      glm: { model: 'glm-5.2', base_url: 'https://open.bigmodel.cn/api/anthropic', auth_token: 't', effort: 'xhigh' },
    }
    try {
      const mk = () => {
        const s = new Session('probe', 'chat_id') as any
        s.proc = new FakeAgentProc('claude', 'claude-session-1')
        s.selectedProvider = 'claude'
        s.selectedModel = 'claude:fable'
        return s
      }
      const ok = await mk().onModelEffortSelect('claude:glm', 'xhigh', '', 'ou_user', 'claude')
      expect(ok.ok).toBe(true)
      const bad = await mk().onModelEffortSelect('claude:glm', 'max', '', 'ou_user', 'claude')
      expect(bad.ok).toBe(false)
      expect(bad.message).toContain('不在固定选项中')
    } finally {
      ;(config.claude as any).models = prev
    }
  })

  test('未配置 token 时选 GLM 被拦截并提示去 config.toml 设置', async () => {
    // 隔离 config:拦截只在 GLM 未配置时触发;测试机可能已配 GLM,强制未配置态。
    const prev = config.claude.models
    ;(config.claude as any).models = {}
    try {
      const session = new Session('probe', 'chat_id') as any
      const proc = new FakeAgentProc('claude', 'claude-session-1')
      session.proc = proc
      session.selectedProvider = 'claude'
      session.selectedModel = 'claude:fable'

      const result = await session.onModelEffortSelect('claude:glm', 'max', '', 'ou_user', 'claude')

      expect(result.ok).toBe(false)
      expect(result.message).toContain('GLM')
      expect(result.message).toMatch(/配置|config/)
      expect(session.selectedModel).toBe('claude:fable') // 未切换
      expect(proc.killCalls).toBe(0)
    } finally {
      ;(config.claude as any).models = prev
    }
  })

  test('catches synchronous Claude init failure before reporting ready', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', null)
    const statuses: string[] = []
    session.selectedProvider = 'claude'
    session.spawnAgent = () => proc
    proc.sendInitialize = () => {
      proc.emit('error', new Error('Claude auth failed'))
    }

    const ok = await session.start({
      announce: false,
      onStatus: status => statuses.push(status),
    })

    expect(ok).toBe(false)
    expect(statuses).toContain('❌ Claude 启动失败: Claude auth failed')
    expect(proc.killCalls).toBe(1)
    expect(session.proc).toBeNull()
    expect(session.status).toBe('stopped')
  })

  test('does not require Claude stream init before reporting ready', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', null)
    const statuses: string[] = []
    let initializeCalls = 0
    session.selectedProvider = 'claude'
    session.spawnAgent = () => proc
    proc.sendInitialize = () => {
      initializeCalls++
    }

    const ok = await session.start({
      announce: false,
      onStatus: status => statuses.push(status),
    })

    expect(ok).toBe(true)
    expect(initializeCalls).toBe(1)
    expect(statuses).toContain('✅ Claude 已就绪 · max')
    expect(proc.killCalls).toBe(0)
    expect(session.proc).toBe(proc)
    expect(session.status).toBe('idle')
  })

  test('sends cold-start Claude user text before stream init exists', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', null)
    session.selectedProvider = 'claude'
    session.spawnAgent = () => proc

    try {
      await session.startColdUserTurn('hello', 'hello', 'ou_user')

      expect(proc.sentTexts).toEqual(['hello'])
      expect(session.currentTurn).not.toBeNull()
      expect(session.status).toBe('working')
    } finally {
      session.stopFooterStatus(session.currentTurn)
      if (session.currentTurn) await cardkit.dispose(session.currentTurn.cardId)
    }
  })

})

describe('Session turn close vs mid-turn rotation race', () => {
  test('closeTurnCard awaits in-flight rotation so the swap-restarted footer interval is cleared (no orphan timer)', async () => {
    const session = new Session('probe', 'chat_id') as any
    session.proc = new FakeAgentProc('claude', 'claude-session-1')
    const turn = turnState('card_old')
    turn.userOpenId = '' // 跳过 closeTurnCard 末尾 urgentApp(feishu mock 无此方法)
    session.currentTurn = turn
    cardkit.recordCardCreated('card_old', 1)

    // 复现竞态:result 在 startMidTurnRotate 的 sendCard/id_convert await 窗口
    // 里抢先到达 → closeTurnCard 先跑;swap 随后才落定,切 turn.cardId 到新卡
    // 并 startWritingFooter 重启一个 footer 计时 interval。修复前这个 interval
    // 再没有路径会 stop(closeTurnCard 只跑一次;stop/kill/exit 的
    // stopFooterStatus(this.currentTurn) 拿到 null),新卡 footer 一直计时
    // (2026-06-26 turn=1 计时不止)。
    let swapRan = false
    let releaseSwap: () => void = () => {}
    turn.rotating = new Promise<void>(r => { releaseSwap = r }).then(() => {
      // swap 同步块(真实代码 startMidTurnRotate 1927/1932/1949)
      cardkit.recordCardCreated('card_new', 2)
      turn.cardId = 'card_new'
      session.startWritingFooter(turn)
      swapRan = true
    })

    try {
      const closed = session.closeTurnCard(undefined, { hasFreshResult: false })
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
      releaseSwap() // rotation 的 swap 现在落定
      await closed

      expect(swapRan).toBe(true)
      // swap 重启的 interval 必须被清掉,否则新卡 footer 一直计时
      expect(turn.footerStatusHandle).toBeNull()
      // 终态 footer 写到 swap 切换后的新卡,不是旧卡
      const newCardFooter = calls.filter(c => c.method === 'PUT' && c.path === '/cards/card_new/elements/footer')
      expect(newCardFooter.length).toBeGreaterThan(0)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })
})

describe('Session workDir project profile override', () => {
  test('uses profile cwd when present', () => {
    projectProfiles.set('withoverride', { cwd: '/abs/custom/dir' })
    const session = new Session('withoverride', 'oc_test_override')
    expect(session.workDir).toBe('/abs/custom/dir')
  })

  test('falls back to PROJECTS_ROOT/<name> without profile', () => {
    const session = new Session('plainproject', 'oc_test_plain')
    expect(session.workDir).toBe('/tmp/lodestar-projects/plainproject')
  })

  test('ignores a blank cwd override', () => {
    projectProfiles.set('blankcwd', { cwd: '   ' })
    const session = new Session('blankcwd', 'oc_test_blank')
    expect(session.workDir).toBe('/tmp/lodestar-projects/blankcwd')
  })
})

describe('Session rotate cap counts only failure-triggered rotations', () => {
  test('ignores a stale card callback without mutating the replacement turn', async () => {
    const session = new Session('stale-card-write-failure', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-thread-stale-card-write-failure')
    session.selectedProvider = 'codex'
    session.proc = proc
    session.pendingTurnInputs = ['old card input']
    session.wireProc(proc)
    const openResult = await session.openTurnCard('ou_old', 'user_message', { startThinking: false })
    if (openResult.kind !== 'opened') throw new Error('old turn card did not open')
    const oldTurn = openResult.turn
    const replacementTurn = turnState('card_replacement_write_failure')
    session.currentTurn = replacementTurn
    cardkit.recordCardCreated(replacementTurn.cardId, 1)
    const healthyFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      if (init?.method === 'PUT' && path === `/cards/${oldTurn.cardId}/elements/footer`) {
        return new Response(JSON.stringify({ code: 300308, msg: 'stale card rejected' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return await healthyFetch(input, init)
    }) as typeof fetch
    feishuMockState.sendCard = async () => null

    try {
      await cardkit.replaceElement(oldTurn.cardId, 'footer', {
        tag: 'markdown', element_id: 'footer', content: 'settle stale card',
      })

      expect(session.currentTurn).toBe(replacementTurn)
      expect(replacementTurn.cardId).toBe('card_replacement_write_failure')
      expect(replacementTurn.failureRotateCount).toBe(0)
      expect(replacementTurn.rotateCount).toBe(0)
      expect(replacementTurn.rotating).toBeNull()
      expect(replacementTurn.rotateGivenUp).toBe(false)
    } finally {
      const rotation = replacementTurn.rotating
      if (rotation) await rotation
      feishuMockState.sendCard = null
      globalThis.fetch = healthyFetch
      session.stopFooterStatus(oldTurn)
      session.stopFooterStatus(replacementTurn)
      await cardkit.dispose(oldTurn.cardId)
      await cardkit.dispose(replacementTurn.cardId)
    }
  })

  test('still rotates when the active card callback reports a write failure', async () => {
    const session = new Session('current-card-write-failure', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-thread-current-card-write-failure')
    session.selectedProvider = 'codex'
    session.proc = proc
    session.pendingTurnInputs = ['current card input']
    session.wireProc(proc)
    const openResult = await session.openTurnCard('ou_current', 'user_message', { startThinking: false })
    if (openResult.kind !== 'opened') throw new Error('current turn card did not open')
    const turn = openResult.turn
    const failedCardId = turn.cardId
    const healthyFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      if (init?.method === 'PUT' && path === `/cards/${failedCardId}/elements/footer`) {
        return new Response(JSON.stringify({ code: 300308, msg: 'current card rejected' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return await healthyFetch(input, init)
    }) as typeof fetch

    try {
      await cardkit.replaceElement(failedCardId, 'footer', {
        tag: 'markdown', element_id: 'footer', content: 'trigger current failure',
      })
      const rotation = turn.rotating

      expect(turn.failureRotateCount).toBe(1)
      expect(rotation).not.toBeNull()
      if (rotation) await rotation
      expect(turn.cardId).not.toBe(failedCardId)
    } finally {
      globalThis.fetch = healthyFetch
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  // 2026-07-04 03:46 事故:turn 2 里 5 次正常满卡轮转(elementCount=50)把
  // rotateCount 耗光,第 2 次真实写失败(300308)一来就撞 cap 放弃。cap 的
  // 设计意图(session-types.ts)是只约束失败路径 —— 主动满卡轮转被真实输出
  // 天然节流,不该消耗失败额度。
  test('proactive full-card rotations do not consume the failure cap', async () => {
    const session = new Session('probe', 'chat_id') as any
    session.proc = new FakeAgentProc('claude', 'claude-session-1')
    const turn = turnState('card_old')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated('card_old', 1)
    turn.rotateCount = 5 // 5 次主动满卡轮转已发生,但从未因写失败换过卡

    try {
      session.onCardWriteFailure('card_old', 300308)

      expect(turn.rotateGivenUp).toBe(false)
      expect(turn.rotating).not.toBeNull()
      await turn.rotating
      expect(turn.cardId).not.toBe('card_old') // 真的换到了新卡
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('give-up stops the footer ticker, blocks its restart, and kills card writes', async () => {
    const session = new Session('probe', 'chat_id') as any
    session.proc = new FakeAgentProc('claude', 'claude-session-1')
    const turn = turnState('card_dead')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated('card_dead', 1)
    turn.failureRotateCount = 5 // 失败额度已耗尽

    try {
      session.startWritingFooter(turn)
      expect(turn.footerStatusHandle).not.toBeNull()

      session.onCardWriteFailure('card_dead', 300308)

      expect(turn.rotateGivenUp).toBe(true)
      expect(turn.rotating).toBeNull() // 不再尝试换卡
      // 事故根因 1:log-only 后 footer 每秒 ticker 没停,对死卡刷了 11 分钟
      // 663 条 300308。放弃时必须停表,且 phase 切换不能把它拉起来。
      expect(turn.footerStatusHandle).toBeNull()
      session.startWorkingFooter(turn)
      expect(turn.footerStatusHandle).toBeNull()
      // log-only 语义:本轮剩余对该卡的写全部短路,不再打飞书。
      const before = calls.length
      await cardkit.replaceElement('card_dead', 'footer', { tag: 'markdown', element_id: 'footer', content: 'x' })
      await cardkit.addElement('card_dead', { tag: 'markdown', element_id: 'e_new', content: 'x' })
      expect(calls.length).toBe(before)
      // 告警文案说的是真实语义(换卡耗尽),不是「连续 N 次写入失败」
      expect(sentRawTexts.length).toBe(1)
      expect(sentRawTexts[0]).toContain('换卡')
      expect(sentRawTexts[0]).toContain('仅日志可见')
      expect(sentRawTexts[0]).not.toContain('连续 5 次写入失败')
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose('card_dead')
    }
  })
})

describe('Session SDK-initiated bg-task resume turns', () => {
  // 2026-07-04 事故:reviewer 后台 agent 完成 → SDK 自发恢复轮(init 无用户
  // 消息)合并出终报告,但 init handler 因 pendingUserMessageCount=0 不开卡,
  // appendAssistant 无 currentTurn 直接丢字 —— 6.6KB 终报告只存在于
  // transcript,飞书全程无痕。恢复轮必须开卡;开不了卡也必须纯文本兜底。
  async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
    const t0 = Date.now()
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error('waitFor timeout')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }

  function emitClaudeResult(proc: any): void {
    proc.lastResult = {
      cost_usd: null,
      cost_delta_usd: null,
      duration_ms: 1000,
      num_turns: 1,
      usage: null,
      subtype: 'success',
      is_error: false,
    }
    proc.emit('result', {})
  }

  function wiredClaudeSession(): { session: any; proc: any } {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.lastUserOpenId = 'ou_user'
    session.wireProc(proc)
    proc.emit('init', { session_id: 'claude-session-1' }) // boot init,无用户批次,不开卡
    return { session, proc }
  }

  test('settle 后的自发 init 开 bg_task_resume 卡,终报告落卡、正常收尾并加急推送', async () => {
    const { session, proc } = wiredClaudeSession()
    expect(session.currentTurn).toBeNull()

    proc.emit('bg_task_settled', { task_id: 't1', status: 'completed' })
    proc.emit('init', { session_id: 'claude-session-1' }) // SDK 自发恢复轮
    await waitFor(() => session.currentTurn !== null)

    try {
      expect(session.currentTurn.trigger).toBe('bg_task_resume')
      expect(session.status).toBe('working')

      proc.emit('assistant_text', { text: '双盲 review 合并终报告' })
      proc.emit('assistant_block_stop', {})
      emitClaudeResult(proc)
      await waitFor(() => session.currentTurn === null)
      // closeTurnCard 是 fire-and-forget:等终态 settings patch 落地再断言
      await waitFor(() => calls.some(c => c.method === 'PATCH' && c.path.includes('/settings')))

      const wroteReport = calls.some(c =>
        c.method === 'POST' &&
        /\/cards\/[^/]+\/elements$/.test(c.path) &&
        String(c.body?.elements ?? '').includes('终报告'),
      )
      expect(wroteReport).toBe(true)
      expect(session.status).toBe('idle')
      expect(urgentPushes.length).toBe(1)
      expect(sentTexts).toEqual([]) // 走了卡,不该触发纯文本兜底
    } finally {
      if (session.currentTurn) {
        session.stopFooterStatus(session.currentTurn)
        await cardkit.dispose(session.currentTurn.cardId)
      }
    }
  })

  test('开卡窗口期先到的 assistant 文本并入新卡,不丢', async () => {
    const { session, proc } = wiredClaudeSession()

    proc.emit('bg_task_settled', { task_id: 't1', status: 'completed' })
    proc.emit('init', { session_id: 'claude-session-1' })
    // openTurnCard 还在 await sendCard/id_convert,文本已经开始流 —— 事故里
    // 55ms 后模型就开写。这些字必须并入随后落地的卡。
    proc.emit('assistant_text', { text: '窗口期先到的段落' })
    proc.emit('assistant_block_stop', {})
    await waitFor(() => session.currentTurn !== null)

    try {
      emitClaudeResult(proc)
      await waitFor(() => session.currentTurn === null)
      await waitFor(() => calls.some(c => c.method === 'PATCH' && c.path.includes('/settings')))

      const wrote = calls.some(c =>
        c.method === 'POST' &&
        /\/cards\/[^/]+\/elements$/.test(c.path) &&
        String(c.body?.elements ?? '').includes('窗口期先到的段落'),
      )
      expect(wrote).toBe(true)
    } finally {
      if (session.currentTurn) {
        session.stopFooterStatus(session.currentTurn)
        await cardkit.dispose(session.currentTurn.cardId)
      }
    }
  })

  test('没有 settle 的空 init 不开卡(probe/模型切换等场景不受影响)', async () => {
    const { session, proc } = wiredClaudeSession()

    proc.emit('init', { session_id: 'claude-session-1' }) // 无 settle、无用户批次
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(session.currentTurn).toBeNull()
    expect(sentCards.length).toBe(0)
  })

  test('恢复轮开卡失败(id_convert 报错)时,输出纯文本兜底不丢', async () => {
    const { session, proc } = wiredClaudeSession()
    // 让本轮 id_convert 报错 → openTurnCard 拿不到 cardId → 开卡失败。
    const base = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/cards/id_convert')) {
        return new Response(JSON.stringify({ code: 99, msg: 'boom' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return base(input, init)
    }) as typeof fetch

    try {
      proc.emit('bg_task_settled', { task_id: 't1', status: 'completed' })
      proc.emit('init', { session_id: 'claude-session-1' })
      // 开卡在 await 中就会失败;这些字必须仍被兜住(开卡窗口 + cardless 续窗)。
      proc.emit('assistant_text', { text: '孤儿终报告内容' })
      proc.emit('assistant_block_stop', {})
      await waitFor(() => session.bgResumeCardless === true || session.currentTurn !== null)
      emitClaudeResult(proc)
      await waitFor(() => sentTexts.length > 0)

      expect(sentTexts.join('\n')).toContain('孤儿终报告内容')
      expect(session.currentTurn).toBeNull()
    } finally {
      globalThis.fetch = base
    }
  })

  test('用户打断后,残留的 post-interrupt 正文被丢弃,不推送 📄 兜底消息', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.wireProc(proc)
    const turn = turnState('card_live')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated('card_live', 1)

    try {
      // 模拟软停止:置 userInterrupted、封口卡片(currentTurn 置空)。
      session.userInterrupted = true
      await session.closeTurnCard('🛑 打断')
      expect(session.currentTurn).toBeNull()

      // interrupt 落地前 SDK 仍在流式:这些 delta 到达时已无卡。旧行为是
      // 静默丢弃 —— 修复后必须仍然丢弃,不能变成 📄 纯文本兜底。
      proc.emit('assistant_text', { text: '被取消的轮次尾巴' })
      proc.emit('assistant_block_stop', {})
      emitClaudeResult(proc)
      await new Promise(resolve => setTimeout(resolve, 30))

      expect(sentTexts.join('\n')).not.toContain('被取消的轮次尾巴')
      expect(sentTexts.some(t => t.includes('📄'))).toBe(false)
      expect(session.status).toBe('idle')
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose('card_live')
    }
  })

  test('result 抢在 bg-resume 开卡 await 窗口内到达:不重复兜底,卡片正常收尾,不卡在 working', async () => {
    const { session, proc } = wiredClaudeSession()

    proc.emit('bg_task_settled', { task_id: 't1', status: 'completed' })
    proc.emit('init', { session_id: 'claude-session-1' }) // 开始开卡(await sendCard/id_convert)
    proc.emit('assistant_text', { text: '短恢复轮输出' })
    proc.emit('assistant_block_stop', {})
    // 开卡还没落地(openingTurn 仍 true)就来 result —— 竞态窗口。
    emitClaudeResult(proc)

    await waitFor(() => session.currentTurn === null && session.openingTurn === false)
    await waitFor(() => calls.some(c => c.method === 'PATCH' && c.path.includes('/settings')))

    // 文本进了卡(不是纯文本兜底),且只出现一次。
    expect(sentTexts.some(t => t.includes('📄'))).toBe(false)
    const inCard = calls.some(c =>
      c.method === 'POST' &&
      /\/cards\/[^/]+\/elements$/.test(c.path) &&
      String(c.body?.elements ?? '').includes('短恢复轮输出'),
    )
    expect(inCard).toBe(true)
    // 卡片已收尾(有终态 settings patch),session 不卡在 working。
    expect(session.status).toBe('idle')
  })

  test('切换 provider 停旧进程时清掉 bgResumePending,新进程 boot init 不误开恢复卡', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'codex' // 与 proc.provider 不一致 → 视为 idle mismatched
    session.bgResumePending = true

    await session.stopIdleMismatchedProcess()

    expect(session.bgResumePending).toBe(false)
    expect(session.proc).toBeNull()
  })

  test('非开卡/非恢复窗口的游离正文被丢弃,不进孤儿缓冲', () => {
    const session = new Session('probe', 'chat_id') as any
    // 无 currentTurn、无 openingTurn、无 bgResumeCardless:任何游离 delta 都该丢。
    session.appendAssistant('进程 kill 窗口的残字')
    session.finalizeCurrentAssistantSegment()

    expect(session.orphanAssistantSegments).toEqual([])
    expect(session.orphanAssistantCurrent).toBe('')
  })
})

describe('Session usage cache cross-backend isolation', () => {
  test('claude 的 rate_limit_event payload 不得覆盖 codex 用量缓存', () => {
    // 先用一条 codex 形状的 payload 播种缓存(模块级单例)。
    const seeded = updateUsageFromRateLimits({
      planType: 'plus',
      primary: { usedPercent: 42, resetsAt: 1_700_000_000, windowDurationMins: 300 },
    })
    expect(seeded.state).toBe('ok')

    const session = new Session('probe', 'chat_id') as any
    const claudeProc = new FakeAgentProc('claude')
    session.proc = claudeProc
    session.wireProc(claudeProc)
    // claude 的 rate_limit_info 形状(无 planType/primary/secondary):
    // truthy 但与 codex 完全不同,穿过共享 handler 会被包成空窗口 ok 快照。
    claudeProc.emit('rate_limits_updated', { status: 'allowed', unified_status: 'allowed' })

    // 缓存对象必须原封不动(恒等,而非结构相等)。
    expect(peekUsage()).toBe(seeded)
  })

  test('codex 的 rate_limits_updated 照常更新用量缓存', () => {
    const session = new Session('probe', 'chat_id') as any
    const codexProc = new FakeAgentProc('codex')
    session.proc = codexProc
    session.wireProc(codexProc)
    codexProc.emit('rate_limits_updated', {
      planType: 'pro',
      primary: { usedPercent: 7, resetsAt: 1_700_000_000, windowDurationMins: 300 },
    })

    const snap = peekUsage() as any
    expect(snap?.state).toBe('ok')
    expect(snap?.subscriptionType).toBe('pro')
    expect(snap?.fiveHour?.percent).toBe(7)
  })
})

describe('Session resetBackgroundTasks on kill/restart', () => {
  // 复现:SDK 子进程一死就不再发 task_settled,活跃 entry 永远卡 running,
  // backgroundRefreshTick(setInterval,不归 SDK 管)还在每 tick 把「🟡 运行中
  // Ns」时长往上推 —— 卡片永不沉降,伪造「还在跑」。kill(stop)/restart 必须
  // 主动结算。回归:2026-07-06。
  function makeRunningTask(id: string): any {
    return { id, type: 'shell', description: `bg ${id}`, status: 'running', startedAt: Date.now() - 5000, steps: [] }
  }

  test('stop() kills proc AND clears running background tasks (public kill path)', async () => {
    // 用户真实触发路径:kill 命令 → session.stop()。修复前 stop 只杀进程,
    // 不碰 backgroundTasks,running entry 留在内存 + refresh tick 继续伪造时长。
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.backgroundTasks = [makeRunningTask('t1'), makeRunningTask('t2')]
    session.pendingBgTasks = [makeRunningTask('p1')]
    session.backgroundCard = null // 无活卡 → 走纯内存清理分支(避开 feishu.updateCard)
    session.openingBackground = true

    await session.stop('已终止', { announce: false })

    expect(proc.killCalls).toBe(1) // 进程被杀
    expect(session.backgroundTasks).toEqual([]) // running entry 不再残留
    expect(session.pendingBgTasks).toEqual([])
    expect(session.openingBackground).toBe(false)
  })

  test('live card: flips running tasks to killed terminal BEFORE settling (so the tombstone shows 💀 已终止)', async () => {
    // 有活卡路径:先翻 killed,再 settleBackgroundCard 用终态 entry 渲染墓碑
    // (用户看到「💀 已终止 Ns」而非「🟡 运行中」)。settle 内部 feishu.updateCard
    // 在测试 mock 里不存在,stub 掉以聚焦本次修复边界(settle 老逻辑另有覆盖)。
    const session = new Session('probe', 'chat_id') as any
    const completedTask = { id: 't0', type: 'subagent', description: 'done', status: 'completed', startedAt: 0, endTime: 1000, steps: [] }
    session.backgroundTasks = [makeRunningTask('t1'), completedTask]
    session.backgroundCard = { messageId: 'om_bg', cardId: 'card_bg' }
    let settleCalls = 0
    let statusesAtSettle = ''
    session.settleBackgroundCard = async function () {
      settleCalls++
      statusesAtSettle = JSON.stringify(this.backgroundTasks.map((t: any) => t.status))
    }

    await session.resetBackgroundTasks()

    expect(settleCalls).toBe(1) // 有卡 → 沉降被调
    // 活跃 entry 在 settle 之前已翻 killed(供墓碑渲染);已终态的保持原状。
    expect(statusesAtSettle).toBe('["killed","completed"]')
    expect(session.pendingBgTasks).toEqual([])
  })

  test('no live card: clears tasks + pending pool + refresh timer + detail set', async () => {
    const session = new Session('probe', 'chat_id') as any
    session.backgroundTasks = [makeRunningTask('t1')]
    session.pendingBgTasks = [makeRunningTask('p1')]
    session.backgroundCard = null
    const liveTimer = setTimeout(() => {}, 100000)
    session.backgroundRefreshTimer = liveTimer
    session.backgroundDetailAdded = new Set(['t1'])
    session.openingBackground = true

    await session.resetBackgroundTasks()

    expect(session.backgroundTasks).toEqual([])
    expect(session.pendingBgTasks).toEqual([])
    expect(session.backgroundRefreshTimer).toBeNull() // timer 引用已清
    expect(session.backgroundDetailAdded.size).toBe(0)
    expect(session.openingBackground).toBe(false)
  })
})

describe('rs (restart) — 双模式列表分支', () => {
  test('空闲态(proc 存活但无进行中 turn)应走 showResumeList,而非恢复上一会话', async () => {
    const session = new Session('probe', 'chat_id') as any
    // 复现 stop 后状态:进程保活(isRunning()=true)但无进行中 turn —— stop 注释明说
    // "Subprocess stays alive",只 interrupt 不杀进程。这是用户实测踩中的场景。
    session.proc = { isAlive: () => true, provider: 'claude' }
    session.currentTurn = null
    session.pendingUserMessageCount = 0
    session.pendingMidTurnMsgs = []
    session.selectedProvider = 'claude'
    session.lastSessionId = 'aaaaaaaabbbbcccc'
    session.runningAgy = false

    let listCalled = false
    let restartCalled = false
    session.showResumeList = async () => { listCalled = true }
    session.restart = async () => { restartCalled = true; return true }
    // 恢复分支(修复前会走)依赖这些 —— stub 掉避免真发卡/报错,聚焦分支选择断言
    session.openStatusCard = async () => null
    session.closeStatusCard = async () => {}
    session.withModel = (s: string) => s
    session.withWorktreeInstructionNotice = (s: string) => s
    session.backendLabel = () => 'claude'

    await session.runCommand('rs')

    // 修复前(!isRunning() 判定):isRunning=true → 走恢复分支 → listCalled=false、restartCalled=true → FAIL
    // 修复后(无 turn 判定):走 showResumeList → listCalled=true、restartCalled=false → PASS
    expect(listCalled).toBe(true)
    expect(restartCalled).toBe(false)
  })
})

describe('Session warm-resume 工程师续跑感知(已结算 agent 档案复活)', () => {
  // 2026-07-08 事故:pokemon 群主 agent 用 SendMessage 热续跑刚完成的工程师
  // ("was stopped (completed); resumed it"),SDK 不重发 task_started,只在最终
  // 完成时来一条 task_notification。卡沉降已清池 → unknown no-op → 续跑 6 分钟
  // 全程飞书无任何状态。冷续跑("resumed from transcript")会重发 task_started,
  // 不受影响。
  async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
    const t0 = Date.now()
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error('waitFor timeout')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }

  function wiredClaudeSession(): { session: any; proc: any } {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.wireProc(proc)
    return { session, proc }
  }

  /** 走完一轮正常生命周期:started → 开卡 → settled → 卡沉降清池(档案应留名片)。 */
  async function runAgentToSettled(session: any, proc: any): Promise<void> {
    proc.emit('bg_task_started', {
      task_id: 'ag1', task_type: 'local_agent', subagent_type: 'client-engineer',
      tool_use_id: 'tu1', description: '稀有度钳制下沉实施',
    })
    await waitFor(() => session.backgroundCard !== null)
    proc.emit('bg_task_settled', { task_id: 'ag1', status: 'completed' })
    await waitFor(() => session.backgroundTasks.length === 0 && session.backgroundCard === null)
  }

  test('卡沉降清池后档案留有 agent 名片;热续跑只来终态 → 补发一次性墓碑卡', async () => {
    const { session, proc } = wiredClaudeSession()
    await runAgentToSettled(session, proc)

    expect(session.bgArchive).toHaveLength(1)
    expect(session.bgArchive[0]).toMatchObject({ id: 'ag1', subagentType: 'client-engineer' })

    const cardsBefore = sentCards.length
    // 热续跑:运行期零事件,只有最终 task_notification
    proc.emit('bg_task_settled', {
      task_id: 'ag1', status: 'completed',
      usage: { total_tokens: 100, tool_uses: 5, duration_ms: 360_000 },
    })
    await waitFor(() => sentCards.length === cardsBefore + 1)

    const tombstone = JSON.stringify(sentCards[sentCards.length - 1])
    expect(tombstone).toContain('client-engineer(续跑)')
    expect(tombstone).toContain('已结束')
    // 一次性卡不留活卡句柄、不占池
    expect(session.backgroundCard).toBeNull()
    expect(session.backgroundTasks).toEqual([])
  })

  test('未知且不在档案的 settle 维持 no-fallback(前台噪音不回归)', async () => {
    const { session, proc } = wiredClaudeSession()
    proc.emit('bg_task_settled', { task_id: 'ghost', status: 'completed' })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(sentCards.length).toBe(0)
    expect(session.backgroundTasks).toEqual([])
  })

  test('热续跑运行期来了 task_updated → 以「续跑」running 条目复活并重开活卡,再 settle 走正常沉降', async () => {
    const { session, proc } = wiredClaudeSession()
    await runAgentToSettled(session, proc)

    const cardsBefore = sentCards.length
    proc.emit('bg_task_updated', { task_id: 'ag1', patch: { status: 'running' } })
    await waitFor(() => session.backgroundCard !== null)

    expect(session.backgroundTasks).toHaveLength(1)
    expect(session.backgroundTasks[0]).toMatchObject({ id: 'ag1', status: 'running', resumed: true, type: 'subagent' })
    const liveCard = JSON.stringify(sentCards[sentCards.length - 1])
    expect(sentCards.length).toBe(cardsBefore + 1)
    expect(liveCard).toContain('client-engineer(续跑)')

    // 复活后的正常结算:走已知 task 沉降路径,不再发一次性卡
    proc.emit('bg_task_settled', { task_id: 'ag1', status: 'completed' })
    await waitFor(() => session.backgroundTasks.length === 0 && session.backgroundCard === null)
    expect(sentCards.length).toBe(cardsBefore + 1)
    // 再次清池后名片仍在档案里,支持同一工程师第二次续跑
    expect(session.bgArchive.some((a: any) => a.id === 'ag1')).toBe(true)
  })
})
