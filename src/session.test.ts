import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_CODEX_WATCHDOG,
  TurnWatchdog,
  type WatchdogSettings,
} from './turn-watchdog'
import type { CodexUserTextSettlement, UserTextDispatch } from './agent-process'
import {
  addedReactions, boundResumes, deletedReactions, feishuMockState, projectProfiles, resetFeishuMock,
  sentCards, sentRawTexts, sentTexts, updatedCards, urgentPushes,
} from './feishu-test-mock'

const { Session, WATCHDOG_RECOVERY_PROMPT } = await import('./session')
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
  interruptCalls = 0
  onInterrupt: (() => void) | null = null
  setModelSettingsCalls: Array<[string, string]> = []
  alive = true
  dispatchFactory: ((text: string) => UserTextDispatch) | null = null
  dispatchCounter = 0

  constructor(
    readonly provider: 'codex' | 'claude',
    public sessionId: string | null = null,
  ) {
    super()
  }

  sendInitialize(): void {}

  sendUserText(text: string): UserTextDispatch {
    this.sentTexts.push(text)
    if (this.dispatchFactory) return this.dispatchFactory(text)
    if (this.provider === 'claude') return { kind: 'queued', provider: 'claude' }
    const deliveryId = String(++this.dispatchCounter)
    const threadId = this.sessionId ?? 'fake-codex-thread'
    return {
      kind: 'turn_start_pending',
      provider: 'codex',
      deliveryId,
      threadId,
      settlement: Promise.resolve({ kind: 'ack', deliveryId, threadId, turnId: null }),
    }
  }

  sendInterrupt(): void {
    this.interruptCalls++
    this.onInterrupt?.()
  }
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
    if (session.clearWatchdogRuntime) session.clearWatchdogRuntime('test cleanup')
    else session.endWatchdogTurn()
    session.stopFooterStatus(session.currentTurn)
    if (!session.clearWatchdogRuntime) {
      if (session.watchdogTickHandle) clearInterval(session.watchdogTickHandle)
      session.watchdogTickHandle = null
    }
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

function wiredWatchdogSession(
  provider: 'codex' | 'claude' = 'codex',
  mode: 'warn' | 'recover_once' = 'warn',
): {
  session: any
  proc: FakeAgentProc
  turn: any
} {
  const fixtureId = ++watchdogFixtureCount
  const sessionName = `watchdog-${provider}-${fixtureId}`
  projectProfiles.set(sessionName, { watchdogMode: mode })
  const session = new Session(sessionName, 'chat_id') as any
  const proc = new FakeAgentProc(provider, provider === 'codex' ? 'thread-1' : 'claude-thread-1')
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

const recoverVerdict = {
  type: 'recover', idleMs: 900_000, repeatCount: 10,
  fingerprintHash: 'a'.repeat(64),
} as const

function armedRecoverySession(override: Partial<WatchdogSettings> = {}) {
  // 生产一致性:recover 流程测试的 session 本身必须是 recover_once 档,
  // 而不是 warn 档 session 拿着注入的 verdict 硬跑(那种状态生产不可达)。
  const { session, proc, turn } = wiredWatchdogSession('codex', 'recover_once')
  const settings = { ...DEFAULT_CODEX_WATCHDOG, ...override }
  session.configuredWatchdogSettings = () => settings
  session.watchdog = new TurnWatchdog(settings)
  session.beginWatchdogTurn(turn, proc, 0)
  proc.emit('turn_started', { thread_id: 'thread-1', turn_id: 'turn-1' })
  return { session, proc, turn }
}

const WATCHDOG_DUE_AT = DEFAULT_CODEX_WATCHDOG.stallMs

function dueWatchdogSession(opts: { recoveryAttempt?: 0 | 1 } = {}) {
  const fixture = armedRecoverySession()
  for (let index = 0; index < DEFAULT_CODEX_WATCHDOG.repeatNoopLimit; index++) {
    const id = `due-noop-${index}`
    const startedAt = index * 2 + 1
    fixture.session.watchdog.observeToolStart(id, 'exec', 'text("ready")', startedAt)
    fixture.session.watchdog.observeToolResult(id, strictExecResult('ready'), false, startedAt + 1)
  }
  if (opts.recoveryAttempt === 1) fixture.session.watchdog.consumeRecovery()
  return fixture
}

function installFailedWatchdogRecovery(
  session: any,
  opts: {
    provider?: 'codex' | 'claude'
    threadId?: string
    turnId?: string
    proc?: FakeAgentProc
    turn?: any
  } = {},
): any {
  const provider = opts.provider ?? 'codex'
  const threadId = opts.threadId ?? 'thread-1'
  const turnId = opts.turnId ?? 'turn-1'
  const proc = opts.proc ?? new FakeAgentProc(provider, threadId)
  const turn = opts.turn ?? turnState(`card_failed_recovery_${++watchdogFixtureCount}`)
  turn.backendThreadId = threadId
  turn.backendTurnId = turnId
  const lease = session.beginLifecycle('watchdog-recovery')
  const recovery = {
    token: {},
    lease,
    provider,
    threadId,
    turn,
    turnId,
    recoveryAttempt: 1,
    phase: 'failed',
    replacementProc: null,
  }
  session.preservedWatchdogRecovery = recovery
  return recovery
}

function ownedFailedWatchdogRecoverySession(): {
  session: any
  proc: FakeAgentProc
  turn: any
  action: any
  recovery: any
} {
  const fixture = armedRecoverySession()
  const action = fixture.session.beginWatchdogAction(
    fixture.session.watchdogContext,
    'watchdog-recovery',
  )
  if (!action) throw new Error('failed to acquire watchdog action fixture')
  const recovery = fixture.session.preserveWatchdogRecovery(action)
  if (!recovery) throw new Error('failed to preserve watchdog recovery fixture')
  recovery.phase = 'failed'
  return { ...fixture, action, recovery }
}

function stoppedFailedRecoverySession(suffix: string): any {
  const session = new Session(`watchdog-stopped-cleanup-${suffix}`, 'chat_id') as any
  session.selectedProvider = 'codex'
  session.proc = null
  installFailedWatchdogRecovery(session)
  session.pendingUserMessageCount = 2
  session.pendingMidTurnMsgs = [{
    text: 'queued human',
    wireText: '[file: /tmp/queued.txt]\nqueued human',
    userOpenId: 'ou_queued_human',
    msgId: 'om_queued_human',
  }]
  session.pendingTurnInputs = ['queued turn input']
  session.lastUserOpenId = 'ou_queued_human'
  session.multiMsgBuffer = [{
    text: 'buffered segment', files: [],
    userOpenId: 'ou_buffered', msgId: 'om_buffered',
  }]
  session.multiMsgReactions = new Map([['om_buffered', 'reaction-buffered']])
  session.pendingReactionIds = new Map([['om_queued_human', 'reaction-queued']])
  session.currentBatchReactionIds = new Map([['om_current_batch', 'reaction-current']])
  return session
}

function expectStoppedFailedRecoveryQueueCleared(session: any): void {
  expect(session.watchdogResumeFailed).toBe(false)
  expect(session.pendingUserMessageCount).toBe(0)
  expect(session.pendingMidTurnMsgs).toEqual([])
  expect(session.pendingTurnInputs).toEqual([])
  expect(session.lastUserOpenId).toBe('')
  expect(session.multiMsgBuffer).toBeNull()
  expect(session.multiMsgReactions.size).toBe(0)
  expect(session.pendingReactionIds.size).toBe(0)
  expect(session.currentBatchReactionIds.size).toBe(0)
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('waitFor timeout')
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

test('human st still cancels queued work, interrupts once, and owns the stopped footer', async () => {
  const session = new Session('probe', 'chat_id') as any
  const proc = new FakeAgentProc('codex', 'thread-1')
  session.proc = proc
  session.currentTurn = turnState('card-stop')
  session.pendingMidTurnMsgs = [
    { text: 'queued', wireText: 'queued', userOpenId: 'ou_user', msgId: 'om_queued' },
  ]
  session.pendingReactionIds.set('om_queued', 'reaction-1')
  session.wireProc(proc)

  await session.runCommand('st')
  expect(proc.interruptCalls).toBe(1)
  expect(session.pendingMidTurnMsgs).toEqual([])
  expect(session.pendingReactionIds.size).toBe(0)
  expect(session.currentTurn).toBeNull()
  proc.emit('result', {})
  await Promise.resolve()
  expect(session.currentTurn).toBeNull()
})

describe('Session shared turn interrupt', () => {
  test('registers waiter before sendInterrupt and settles a synchronous result', async () => {
    const { session, proc, turn } = wiredWatchdogSession('codex')
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'turn-interrupt-sync' })
    proc.onInterrupt = () => proc.emit('result', {})
    const interrupt = session.beginTurnInterrupt('watchdog_recover', session.watchdogContext)
    expect(interrupt).not.toBeNull()
    expect(await interrupt.promise).toMatchObject({ type: 'result', proc, turn })
    expect(proc.interruptCalls).toBe(1)
  })

  test('only matching proc and TurnState can settle the waiter', async () => {
    const { session, proc } = wiredWatchdogSession('codex')
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'turn-interrupt-identity' })
    const interrupt = session.beginTurnInterrupt('watchdog_recover', session.watchdogContext)
    const stale = new FakeAgentProc('codex', 'thread-1')
    expect(session.settleTurnInterrupt(stale, 'result')).toBeNull()
    expect(session.settleTurnInterrupt(proc, 'result')).toBe(interrupt)
    expect(await interrupt.promise).toMatchObject({ type: 'result' })
  })

  test('timeout does not masquerade as result or exit', async () => {
    const { session, proc } = wiredWatchdogSession('codex')
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'turn-interrupt-timeout' })
    const interrupt = session.beginTurnInterrupt('watchdog_recover', session.watchdogContext)
    expect(await session.waitForTurnSettlement(interrupt, 1)).toEqual({ type: 'timeout' })
  })

  test('duplicate interrupt calls reuse one context and send once', () => {
    const { session, proc } = wiredWatchdogSession('codex')
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'turn-interrupt-duplicate' })
    const first = session.beginTurnInterrupt('watchdog_recover', session.watchdogContext)
    const second = session.beginTurnInterrupt('watchdog_recover', session.watchdogContext)
    expect(second).toBe(first)
    expect(proc.interruptCalls).toBe(1)
  })

  test('a stale result cancels its waiter without touching the replacement turn', async () => {
    const { session, proc } = wiredWatchdogSession('codex')
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'turn-interrupt-replaced' })
    const interrupt = session.beginTurnInterrupt('watchdog_recover', session.watchdogContext)
    const replacement = turnState('card-interrupt-replacement')
    session.currentTurn = replacement

    proc.emit('result', {})

    expect(session.currentTurn).toBe(replacement)
    expect(session.activeTurnInterrupt).toBeNull()
    expect(await interrupt.promise).toEqual({
      type: 'cancelled',
      reason: 'result no longer owns captured turn',
    })
  })

  test('human st takes ownership of an existing watchdog interrupt without sending twice', async () => {
    const { session, proc } = wiredWatchdogSession('codex')
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'turn-interrupt-user-takeover' })
    session.status = 'working'
    const interrupt = session.beginTurnInterrupt('watchdog_recover', session.watchdogContext)

    await session.runCommand('st')
    expect(session.activeTurnInterrupt).toBe(interrupt)
    expect(interrupt.source).toBe('user')
    expect(proc.interruptCalls).toBe(1)

    proc.emit('result', {})
    expect(session.status).toBe('idle')
  })

  test('rejects settlement when the captured watchdog thread identity is cleared', () => {
    const { session, proc, turn } = wiredWatchdogSession('codex')
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'turn-interrupt-thread-cleared' })
    const interrupt = session.beginTurnInterrupt('watchdog_recover', session.watchdogContext)
    turn.backendThreadId = null

    expect(session.settleTurnInterrupt(proc, 'result')).toBeNull()
    expect(session.activeTurnInterrupt).toBe(interrupt)
  })

  test('rejects a watchdog interrupt until both backend identities are confirmed', () => {
    const { session, proc } = wiredWatchdogSession('codex')
    proc.emit('turn_started', { thread_id: proc.sessionId })

    expect(session.beginTurnInterrupt('watchdog_recover', session.watchdogContext)).toBeNull()
    expect(proc.interruptCalls).toBe(0)
  })

  test('rejects a user settlement after process ownership is lost', () => {
    const session = new Session('interrupt-user-stale-proc', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-user-stale')
    session.proc = proc
    session.currentTurn = turnState('card-user-stale-proc')
    const interrupt = session.beginTurnInterrupt('user')
    session.currentTurn = null
    session.proc = null

    expect(session.settleTurnInterrupt(proc, 'result')).toBeNull()
    expect(session.activeTurnInterrupt).toBe(interrupt)
  })

  test('stop cancels an active waiter before its first await', async () => {
    const { session, proc } = wiredWatchdogSession('codex')
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'turn-interrupt-stop-cancel' })
    const interrupt = session.beginTurnInterrupt('watchdog_recover', session.watchdogContext)
    let interruptAtFirstAwait: unknown = undefined
    session.stopAgyTask = async () => {
      interruptAtFirstAwait = session.activeTurnInterrupt
      return false
    }

    await session.stop('test stop', { announce: false })

    expect(interruptAtFirstAwait).toBeNull()
    expect(await interrupt.promise).toEqual({ type: 'cancelled', reason: 'stop: test stop' })
  })

  test('restart cancels an active waiter before opening its status card', async () => {
    const { session, proc } = wiredWatchdogSession('codex')
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'turn-interrupt-restart-cancel' })
    const interrupt = session.beginTurnInterrupt('watchdog_recover', session.watchdogContext)
    session.lastSessionId = 'resume-thread'
    let interruptWhileOpeningStatus: unknown = undefined
    session.openStatusCard = async () => {
      interruptWhileOpeningStatus = session.activeTurnInterrupt
      throw new Error('stop after cancellation probe')
    }

    await expect(session.restart(true)).rejects.toThrow('stop after cancellation probe')

    expect(interruptWhileOpeningStatus).toBeNull()
    expect(await interrupt.promise).toEqual({ type: 'cancelled', reason: 'restart' })
  })

  test('a superseded restart cannot resume after a newer kill wins during status-card creation', async () => {
    const session = new Session('lifecycle-restart-kill-status-race', 'chat_id') as any
    const oldProc = new FakeAgentProc('codex', 'thread-restart-kill-race')
    const staleReplacement = new FakeAgentProc('codex', 'thread-restart-kill-race')
    const restartCardEntered = deferred<void>()
    const releaseRestartCard = deferred<void>()
    let cardCalls = 0
    let spawnCalls = 0
    session.selectedProvider = 'codex'
    session.lastSessionId = 'thread-restart-kill-race'
    session.proc = oldProc
    session.currentTurn = turnState('card_restart_kill_race')
    session.wireProc(oldProc)
    session.spawnAgent = () => {
      spawnCalls++
      return staleReplacement
    }
    staleReplacement.sendInitialize = () => {
      staleReplacement.emit('init', { session_id: 'thread-restart-kill-race' })
    }
    feishuMockState.sendCard = async () => {
      cardCalls++
      if (cardCalls === 1) {
        restartCardEntered.resolve()
        await releaseRestartCard.promise
      }
      return `om_lifecycle_race_${cardCalls}`
    }

    try {
      const restarting = session.runCommand('restart')
      await restartCardEntered.promise
      await session.runCommand('kill')
      releaseRestartCard.resolve()
      await restarting

      expect(spawnCalls).toBe(0)
      expect(staleReplacement.killCalls).toBe(0)
      expect(session.proc).toBeNull()
      expect(session.status).toBe('stopped')
    } finally {
      feishuMockState.sendCard = null
    }
  })

  test('dispose invalidates an in-flight start before it publishes idle', async () => {
    const session = new Session('lifecycle-dispose-start-race', 'chat_id') as any
    const proc = new FakeAgentProc('claude', null)
    const initializeEntered = deferred<void>()
    session.selectedProvider = 'claude'
    session.spawnAgent = () => proc
    proc.sendInitialize = () => { initializeEntered.resolve() }

    const starting = session.start({ announce: false })
    await initializeEntered.promise
    session.dispose()
    const ok = await starting

    expect(ok).toBe(false)
    expect(proc.killCalls).toBe(1)
    expect(session.proc).toBeNull()
    expect(session.status).not.toBe('idle')
  })

  test('running hi retains the same pending process when it supersedes start', async () => {
    const session = new Session('lifecycle-hi-retains-pending-start', 'chat_id') as any
    const proc = new FakeAgentProc('claude', null)
    const initializeEntered = deferred<void>()
    let consoleCalls = 0
    session.selectedProvider = 'claude'
    session.spawnAgent = () => proc
    session.showConsole = async () => { consoleCalls++ }
    proc.sendInitialize = () => { initializeEntered.resolve() }

    const starting = session.start({ announce: false })
    await initializeEntered.promise
    await session.runCommand('hi')
    const ok = await starting

    expect(ok).toBe(false)
    expect(consoleCalls).toBe(1)
    expect(proc.killCalls).toBe(0)
    expect(session.proc).toBe(proc)
  })

  test('a stale spawn still kills its local process after a newer pending spawn replaces the marker', async () => {
    const session = new Session('lifecycle-overlapping-pending-spawns', 'chat_id') as any
    const staleProc = new FakeAgentProc('codex', 'thread-stale-pending')
    const newerProc = new FakeAgentProc('codex', 'thread-newer-pending')
    const staleLease = session.beginLifecycle('start')
    session.pendingSpawnOwnership = { lease: staleLease, proc: staleProc }
    const newerLease = session.beginLifecycle('restart')
    session.pendingSpawnOwnership = { lease: newerLease, proc: newerProc }
    session.proc = newerProc

    await session.discardLocalProcess(staleLease, staleProc)

    expect(staleProc.killCalls).toBe(1)
    expect(newerProc.killCalls).toBe(0)
    expect(session.proc).toBe(newerProc)
    expect(session.pendingSpawnOwnership).toEqual({ lease: newerLease, proc: newerProc })
  })

  test('a stale start spawn exception cannot clear a newer process owner', async () => {
    const session = new Session('lifecycle-stale-start-spawn-throw', 'chat_id') as any
    const newerProc = new FakeAgentProc('claude', 'thread-newer-start-throw')
    let lifecycleChanges = 0
    session.selectedProvider = 'claude'
    session.opts.onLifecycleChange = () => { lifecycleChanges++ }
    session.spawnAgent = () => {
      session.beginLifecycle('hi')
      session.proc = newerProc
      session.status = 'working'
      throw new Error('stale start spawn failed')
    }

    const ok = await session.start({ announce: false })

    expect(ok).toBe(false)
    expect(session.proc).toBe(newerProc)
    expect(session.status).toBe('working')
    expect(lifecycleChanges).toBe(0)
  })

  test('a superseded kill cannot close its status card over a newer lifecycle owner', async () => {
    const session = new Session('lifecycle-stale-kill-status', 'chat_id') as any
    const oldProc = new FakeAgentProc('codex', 'thread-stale-kill')
    const newerProc = new FakeAgentProc('codex', 'thread-newer-owner')
    const statusCard = { cardId: 'card_stale_kill' }
    let closeCalls = 0
    session.selectedProvider = 'codex'
    session.proc = oldProc
    session.openStatusCard = async () => statusCard
    session.closeStatusCard = async () => { closeCalls++ }
    session.stop = async () => {
      session.beginLifecycle('hi')
      session.proc = newerProc
    }

    await session.runCommand('kill')

    expect(closeCalls).toBe(0)
    expect(session.proc).toBe(newerProc)
    expect(newerProc.killCalls).toBe(0)
  })

  test('a superseded idle soft stop cannot close a status card returned after losing its lease', async () => {
    const session = new Session('lifecycle-stale-soft-stop-card', 'chat_id') as any
    const openEntered = deferred<void>()
    const openRelease = deferred<void>()
    const statusCard = { cardId: 'card_stale_soft_stop' }
    let closeCalls = 0
    session.openStatusCard = async () => {
      openEntered.resolve()
      await openRelease.promise
      return statusCard
    }
    session.closeStatusCard = async () => { closeCalls++ }

    const stopping = session.runCommand('st')
    await openEntered.promise
    session.beginLifecycle('hi')
    openRelease.resolve()
    await stopping

    expect(closeCalls).toBe(0)
  })

  test('a superseded idle soft stop cannot send fallback text after a null status-card result', async () => {
    const session = new Session('lifecycle-stale-soft-stop-fallback', 'chat_id') as any
    const openEntered = deferred<void>()
    const openRelease = deferred<void>()
    session.openStatusCard = async () => {
      openEntered.resolve()
      await openRelease.promise
      return null
    }

    const stopping = session.runCommand('st')
    await openEntered.promise
    session.beginLifecycle('hi')
    openRelease.resolve()
    await stopping

    expect(sentTexts).not.toContain('⚪ 当前没有正在执行的 turn')
  })

  test('idle soft stop owns an explicit soft_stop lease while its status card opens', async () => {
    const session = new Session('lifecycle-soft-stop-kind', 'chat_id') as any
    const openEntered = deferred<void>()
    const openRelease = deferred<void>()
    let observedKind: unknown = null
    session.openStatusCard = async () => {
      observedKind = session.lifecycleOwner?.kind
      openEntered.resolve()
      await openRelease.promise
      return null
    }

    const stopping = session.runCommand('st')
    await openEntered.promise
    openRelease.resolve()
    await stopping

    expect(observedKind).toBe('soft_stop')
  })

  test('a superseded hi cannot publish a ready console over a newer lifecycle owner', async () => {
    const session = new Session('lifecycle-stale-hi-ready-status', 'chat_id') as any
    const newerProc = new FakeAgentProc('claude', 'thread-newer-hi-owner')
    const statusCard = { cardId: 'card_stale_hi' }
    let replaceCalls = 0
    session.selectedProvider = 'claude'
    session.openStatusCard = async () => statusCard
    session.replaceStatusCardWithConsole = async () => { replaceCalls++ }
    session.start = async () => {
      session.beginLifecycle('model')
      session.proc = newerProc
      session.status = 'working'
      return true
    }

    await session.runCommand('hi')

    expect(replaceCalls).toBe(0)
    expect(session.proc).toBe(newerProc)
    expect(session.status).toBe('working')
  })

  for (const [label, command, arrange] of [
    ['restart', 'restart', (session: any, supersede: () => void) => {
      session.currentTurn = turnState('card_stale_restart_status')
      session.lastSessionId = 'thread-stale-status'
      session.restart = async () => { supersede(); return false }
    }],
    ['strict retry', 'restart', (session: any, supersede: () => void) => {
      installFailedWatchdogRecovery(session, {
        proc: session.proc,
        threadId: 'thread-stale-status',
      })
      session.resumeFailedWatchdogQueue = async () => { supersede(); return false }
    }],
    ['clear', 'clear', (session: any, supersede: () => void) => {
      session.restart = async () => { supersede(); return false }
    }],
  ] as const) {
    test(`a superseded ${label} cannot close its status card over a newer lifecycle owner`, async () => {
      const session = new Session(`lifecycle-stale-${label.replaceAll(' ', '-')}-status`, 'chat_id') as any
      const oldProc = new FakeAgentProc('codex', 'thread-stale-status')
      const newerProc = new FakeAgentProc('codex', 'thread-newer-status-owner')
      const statusCard = { cardId: `card_stale_${label.replaceAll(' ', '_')}` }
      let closeCalls = 0
      session.selectedProvider = 'codex'
      session.proc = oldProc
      session.openStatusCard = async () => statusCard
      session.closeStatusCard = async () => { closeCalls++ }
      const supersede = () => {
        session.beginLifecycle('hi')
        session.proc = newerProc
      }
      arrange(session, supersede)

      await session.runCommand(command)

      expect(closeCalls).toBe(0)
      expect(session.proc).toBe(newerProc)
      expect(newerProc.killCalls).toBe(0)
    })
  }

  test('idle provider teardown cancels a stopped turn interrupt and the replacement can interrupt', async () => {
    const session = new Session('interrupt-idle-provider-switch', 'chat_id') as any
    const oldProc = new FakeAgentProc('codex', 'thread-idle-old')
    session.selectedProvider = 'codex'
    session.proc = oldProc
    session.currentTurn = turnState('card-idle-old')
    session.status = 'working'
    session.wireProc(oldProc)

    await session.runCommand('st')
    const oldInterrupt = session.activeTurnInterrupt
    expect(oldInterrupt?.source).toBe('user')
    let interruptAtKill: unknown = undefined
    oldProc.kill = async () => {
      interruptAtKill = session.activeTurnInterrupt
      oldProc.killCalls++
      oldProc.alive = false
      oldProc.emit('exit', { code: 0, signal: null, expected: true })
    }

    session.selectedProvider = 'claude'
    await session.stopIdleMismatchedProcess()

    expect(interruptAtKill).toBeNull()
    expect(session.activeTurnInterrupt).toBeNull()
    expect(await oldInterrupt.promise).toMatchObject({ type: 'cancelled' })

    const replacement = new FakeAgentProc('claude', 'thread-idle-replacement')
    session.proc = replacement
    session.currentTurn = turnState('card-idle-replacement')
    session.wireProc(replacement)

    expect(session.beginTurnInterrupt('user')).not.toBeNull()
    expect(replacement.interruptCalls).toBe(1)
  })

  test('idle current-process teardown cancels a stopped turn interrupt before kill', async () => {
    const session = new Session('interrupt-idle-current-stop', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'thread-idle-current')
    session.selectedProvider = 'claude'
    session.proc = proc
    session.currentTurn = turnState('card-idle-current')
    session.status = 'working'
    session.wireProc(proc)

    await session.runCommand('st')
    const interrupt = session.activeTurnInterrupt
    let interruptAtKill: unknown = undefined
    proc.kill = async () => {
      interruptAtKill = session.activeTurnInterrupt
      proc.killCalls++
      proc.alive = false
      proc.emit('exit', { code: 0, signal: null, expected: true })
    }

    await session.stopIdleCurrentProcess('model profile changed')

    expect(interruptAtKill).toBeNull()
    expect(session.activeTurnInterrupt).toBeNull()
    expect(await interrupt.promise).toEqual({
      type: 'cancelled',
      reason: 'idle process stop: model profile changed',
    })
  })

  test('an unmatched exit cancels the captured process interrupt before natural cleanup', async () => {
    const { session, proc, turn } = wiredWatchdogSession('codex')
    proc.emit('turn_started', { thread_id: proc.sessionId, turn_id: 'turn-interrupt-exit-mismatch' })
    const interrupt = session.beginTurnInterrupt('watchdog_recover', session.watchdogContext)
    turn.backendThreadId = 'thread-replaced-before-exit'

    proc.emit('exit', { code: 0, signal: null, expected: true })

    expect(session.activeTurnInterrupt).toBeNull()
    expect(await interrupt.promise).toEqual({
      type: 'cancelled',
      reason: 'process exit no longer owns captured turn',
    })
    expect(session.proc).toBeNull()
  })
})

describe('Session watchdog recover-once action', () => {
  test('result continues on the live process without respawn', async () => {
    const { session, proc } = armedRecoverySession()
    let restartCalls = 0
    session.restart = async () => { restartCalls++; return true }
    proc.onInterrupt = () => proc.emit('result', {})

    await session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)

    expect(proc.killCalls).toBe(0)
    expect(restartCalls).toBe(0)
    expect(proc.sentTexts).toEqual([WATCHDOG_RECOVERY_PROMPT])
    expect(session.currentTurn.trigger).toBe('watchdog_resume')
    expect(session.watchdog.snapshot().recoveryAttempt).toBe(1)
    expect(session.pendingTurnInputs).toEqual([])
    expect(session.pendingUserMessageCount).toBe(0)
    expect(JSON.stringify(sentCards.at(-1))).not.toContain('📥 收到')
  })

  test('recovery waits for its Codex receipt and fails visibly when rejected', async () => {
    const { session, proc } = armedRecoverySession()
    const control = controlCodexDispatch(proc)
    proc.onInterrupt = () => proc.emit('result', {})
    let finished = false
    const recovery = session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)
      .then(() => { finished = true })

    await control.started
    await Promise.resolve()
    expect(finished).toBe(false)
    control.reject(new Error('watchdog turn/start rejected'))
    await recovery

    expect(session.currentTurn).toBeNull()
    expect(session.status).toBe('stopped')
    expect(session.watchdogResumeFailed).toBe(true)
    expect(proc.sentTexts).toContain(WATCHDOG_RECOVERY_PROMPT)
  })

  test('recovery ACK cannot complete after its recovery turn owner is replaced', async () => {
    const { session, proc } = armedRecoverySession()
    const control = controlCodexDispatch(proc)
    proc.onInterrupt = () => proc.emit('result', {})
    const recovery = session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)

    await control.started
    const replacementTurn = turnState('card_watchdog_receipt_replacement')
    replacementTurn.trigger = 'user_message'
    session.currentTurn = replacementTurn
    session.status = 'starting'
    control.ack('turn-old-watchdog-recovery')
    await recovery

    expect(session.currentTurn).toBe(replacementTurn)
    expect(session.status).toBe('starting')
    expect(session.watchdogResumeFailed).toBe(true)
  })

  test('process exit settles the old turn then immediately resumes the same thread', async () => {
    const { session, proc } = armedRecoverySession()
    const resumed = new FakeAgentProc('codex', 'thread-1')
    session.restart = async (resume: boolean, opts: any) => {
      expect(resume).toBe(true)
      expect(opts).toMatchObject({
        requireResumeSession: true,
        preserveCurrentTurn: true,
        preserveQueuedHumanWork: true,
        announce: false,
      })
      session.proc = resumed
      return true
    }
    proc.onInterrupt = () => {
      // 模拟 ask/permission 恰好落在恢复 grace 窗口内、随后进程退出:
      // 早于 runWatchdogRecovery 播种会被人工介入 guard 拦下,不达本分支。
      session.pendingAsks.set('ask-interrupted-exit', { toolUseId: 'ask-interrupted-exit' })
      session.pendingHostAsks.set('hask-interrupted-exit', { requestId: 'hask-interrupted-exit' })
      session.pendingPermissions.set('perm-interrupted-exit', { requestId: 'perm-interrupted-exit' })
      proc.emit('exit', { code: 0, signal: 'SIGTERM', expected: true })
    }

    await session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)

    expect(resumed.sentTexts).toEqual([WATCHDOG_RECOVERY_PROMPT])
    // 死进程的问答状态不可能再被回答;真实 restart 会清,但这个分支
    // 自身也必须清 —— 恢复流程里 restart 可能被 mock/失败短路。
    expect(session.pendingAsks.size).toBe(0)
    expect(session.pendingHostAsks.size).toBe(0)
    expect(session.pendingPermissions.size).toBe(0)
  })

  test('Task 6 repair: stale ownership after awaited strict restart leaves the replacement human turn untouched', async () => {
    const { session, proc } = armedRecoverySession()
    const restartEntered = deferred<void>()
    const restartResult = deferred<boolean>()
    session.lastSessionId = 'thread-1'
    session.restart = async () => {
      restartEntered.resolve()
      return await restartResult.promise
    }
    proc.onInterrupt = () => proc.emit('exit', { code: 0, signal: 'SIGTERM', expected: true })

    const recovery = session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)
    await restartEntered.promise

    const replacementProc = new FakeAgentProc('codex', 'thread-replacement')
    const replacementTurn = turnState('card_watchdog_replacement_human')
    replacementTurn.trigger = 'user_message'
    replacementTurn.userOpenId = ''
    session.proc = replacementProc
    session.currentTurn = replacementTurn
    session.status = 'working'
    session.wireProc(replacementProc)
    session.beginWatchdogTurn(replacementTurn, replacementProc)
    replacementProc.emit('turn_started', {
      thread_id: replacementProc.sessionId,
      turn_id: 'turn-replacement',
    })
    cardkit.recordCardCreated(replacementTurn.cardId, 1)

    restartResult.resolve(false)
    await recovery

    expect(session.proc).toBe(replacementProc)
    expect(session.currentTurn).toBe(replacementTurn)
    expect(session.status).toBe('working')
    expect(sentRawTexts.some(text => text.includes('自动恢复失败'))).toBe(false)
  })

  test('Task 6 repair: a stale recovery-card open cannot stop or notify over a replacement human turn', async () => {
    const { session, proc, turn } = armedRecoverySession()
    const sendStarted = deferred<void>()
    const sendResult = deferred<string | null>()
    cardkit.recordCardCreated(turn.cardId, 1)
    proc.onInterrupt = () => proc.emit('result', {})
    feishuMockState.sendCard = async () => {
      sendStarted.resolve()
      return await sendResult.promise
    }

    try {
      const recovery = session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)
      await sendStarted.promise

      const replacementTurn = turnState('card_watchdog_open_replacement')
      replacementTurn.trigger = 'user_message'
      replacementTurn.backendThreadId = proc.sessionId
      replacementTurn.backendTurnId = 'turn-open-replacement'
      session.currentTurn = replacementTurn
      session.status = 'working'
      session.beginWatchdogTurn(replacementTurn, proc)

      sendResult.resolve('om_watchdog_stale_resume_open')
      await recovery

      expect(session.currentTurn).toBe(replacementTurn)
      expect(session.status).toBe('working')
      expect(sentRawTexts.some(text => text.includes('自动恢复失败'))).toBe(false)
    } finally {
      sendResult.resolve(null)
      feishuMockState.sendCard = null
    }
  })

  test('strict resume uses the captured thread when mutable lastSessionId no longer matches', async () => {
    const { session, proc, turn } = armedRecoverySession()
    const capturedThreadId = 'captured-thread-id-123456789'
    const currentThreadId = 'current-thread-id-987654321'
    const restartOptions: any[] = []
    proc.sessionId = capturedThreadId
    session.watchdogContext.threadId = capturedThreadId
    turn.backendThreadId = capturedThreadId
    session.lastSessionId = currentThreadId
    session.restart = async (_resume: boolean, opts: any) => {
      restartOptions.push(opts)
      return false
    }
    proc.onInterrupt = () => proc.emit('exit', { code: 0, signal: 'SIGTERM', expected: true })
    cardkit.recordCardCreated(turn.cardId, 1)
    await session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)

    expect(restartOptions).toHaveLength(1)
    expect(restartOptions[0].resumeIdentity).toEqual({
      provider: 'codex',
      threadId: capturedThreadId,
    })
    expect(session.lastSessionId).toBe(currentThreadId)
    expect(session.watchdogResumeFailed).toBe(true)
  })

  test('grace timeout cancels the waiter then tears down and resumes once', async () => {
    const { session } = armedRecoverySession({ interruptGraceMs: 1 })
    let resumes = 0
    session.restart = async () => {
      resumes++
      session.proc = new FakeAgentProc('codex', 'thread-1')
      return true
    }

    await session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)

    expect(resumes).toBe(1)
    expect(session.activeTurnInterrupt).toBeNull()
  })

  test('strict resume failure stops visibly and never sends a recovery prompt', async () => {
    const { session, proc } = armedRecoverySession({ interruptGraceMs: 1 })
    session.restart = async () => false

    await session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)

    expect(session.status).toBe('stopped')
    expect(session.watchdogResumeFailed).toBe(true)
    expect(proc.sentTexts).toEqual([])
    expect(sentCards.some(card => JSON.stringify(card).includes('自动恢复 1/1'))).toBe(false)
  })

  test('Task 6 repair: strict resume failure sends raw fallback even when CardKit close writes fail', async () => {
    const { session, proc, turn } = armedRecoverySession()
    const healthyFetch = globalThis.fetch
    session.lastSessionId = 'thread-1'
    session.restart = async () => false
    proc.onInterrupt = () => proc.emit('exit', { code: 0, signal: 'SIGTERM', expected: true })
    cardkit.recordCardCreated(turn.cardId, 1)
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 999,
      msg: 'forced CardKit write failure',
    }), {
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    try {
      await session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)

      expect(sentRawTexts.some(text => text.includes('自动恢复失败'))).toBe(true)
      expect(proc.sentTexts).not.toContain(WATCHDOG_RECOVERY_PROMPT)
    } finally {
      globalThis.fetch = healthyFetch
    }
  })

  test('Task 6 repair: recovery-card open exceptions become a visible failure without rejecting', async () => {
    const { session, proc, turn } = armedRecoverySession()
    proc.onInterrupt = () => proc.emit('result', {})
    cardkit.recordCardCreated(turn.cardId, 1)
    session.openTurnCard = async () => {
      throw new Error('forced recovery-card open exception')
    }

    await expect(
      session.runWatchdogRecovery(session.watchdogContext, recoverVerdict),
    ).resolves.toBeUndefined()

    expect(session.status).toBe('stopped')
    expect(session.watchdogResumeFailed).toBe(true)
    expect(sentRawTexts.some(text => text.includes('自动恢复失败'))).toBe(true)
    expect(proc.sentTexts).not.toContain(WATCHDOG_RECOVERY_PROMPT)
  })

  test('footer patch failure cannot prevent the soft interrupt', async () => {
    const { session, proc } = armedRecoverySession()
    session.replaceFooterContent = async () => { throw new Error('card unavailable') }
    const action = session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)

    await waitFor(() => proc.interruptCalls === 1)
    proc.emit('result', {})
    await action
  })

  test('strict resume without a captured thread fails before destructive cleanup', async () => {
    const { session, proc, turn } = armedRecoverySession()
    session.lastSessionId = null
    session.watchdogContext.threadId = null
    turn.backendThreadId = null
    session.pendingMidTurnMsgs = [{
      text: 'human queued', wireText: 'human queued', userOpenId: 'ou_human', msgId: 'om_human',
    }]
    session.start = async () => true

    const resumed = await session.restart(true, {
      announce: false,
      requireResumeSession: true,
      preserveCurrentTurn: true,
      preserveQueuedHumanWork: true,
    })

    expect(resumed).toBe(false)
    expect(proc.killCalls).toBe(0)
    expect(session.proc).toBe(proc)
    expect(session.currentTurn).toBe(turn)
    expect(session.pendingMidTurnMsgs).toHaveLength(1)
    expect(session.status).toBe('stopped')
  })

  test('watchdog restart preserves the captured turn, human queues, reactions, and context', async () => {
    const { session, proc, turn } = armedRecoverySession()
    const context = session.watchdogContext
    const resumed = new FakeAgentProc('codex', 'thread-1')
    session.lastSessionId = 'thread-1'
    session.pendingMidTurnMsgs = [{
      text: 'queued', wireText: 'queued', userOpenId: 'ou_human', msgId: 'om_queued',
    }]
    session.pendingTurnInputs = ['queued input']
    session.multiMsgBuffer = [{ text: 'part', files: [], userOpenId: 'ou_human', msgId: 'om_part' }]
    session.pendingReactionIds = new Map([['om_queued', 'reaction_queued']])
    session.currentBatchReactionIds = new Map([['om_old_batch', 'reaction_old_batch']])
    session.lastUserOpenId = 'ou_human'
    session.spawnAgent = (resumeSessionId?: string) => {
      expect(resumeSessionId).toBe('thread-1')
      return resumed
    }
    resumed.sendInitialize = () => resumed.emit('init', { session_id: 'thread-1' })

    const ok = await session.restart(true, {
      announce: false,
      requireResumeSession: true,
      preserveCurrentTurn: true,
      preserveQueuedHumanWork: true,
    })

    expect(ok).toBe(true)
    expect(proc.killCalls).toBe(1)
    expect(session.proc).toBe(resumed)
    expect(session.currentTurn).toBe(turn)
    expect(session.watchdogContext).toBe(context)
    expect(session.pendingUserMessageCount).toBe(0)
    expect(session.pendingMidTurnMsgs).toHaveLength(1)
    expect(session.pendingTurnInputs).toEqual(['queued input'])
    expect(session.multiMsgBuffer).toHaveLength(1)
    expect(session.pendingReactionIds).toEqual(new Map([['om_queued', 'reaction_queued']]))
    expect(session.currentBatchReactionIds).toEqual(new Map([['om_old_batch', 'reaction_old_batch']]))
    expect(session.lastUserOpenId).toBe('ou_human')
    expect(session.preservingRestartProc).toBe(resumed)
  })

  test('real strict restart init failure cannot mutate a newer process owner', async () => {
    const { session } = armedRecoverySession()
    const failedReplacement = new FakeAgentProc('codex', 'thread-1')
    const initStarted = deferred<void>()
    let lifecycleChanges = 0
    session.opts.onLifecycleChange = () => { lifecycleChanges++ }
    session.lastSessionId = 'thread-1'
    session.spawnAgent = () => failedReplacement
    failedReplacement.sendInitialize = () => initStarted.resolve()

    const restarting = session.restart(true, {
      announce: false,
      requireResumeSession: true,
      preserveCurrentTurn: true,
      preserveQueuedHumanWork: true,
    })
    await initStarted.promise

    const newerProc = new FakeAgentProc('codex', 'thread-newer-init-error')
    const newerTurn = turnState('card_newer_init_error')
    const newerQueued = [{
      text: 'newer queued text',
      wireText: '[file: /tmp/newer.txt]\nnewer queued text',
      userOpenId: 'ou_newer',
      msgId: 'om_newer_init_error',
    }]
    session.proc = newerProc
    session.currentTurn = newerTurn
    session.status = 'working'
    session.wireProc(newerProc)
    session.beginWatchdogTurn(newerTurn, newerProc)
    newerProc.emit('turn_started', {
      thread_id: newerProc.sessionId,
      turn_id: 'turn-newer-init-error',
    })
    newerProc.emit('subagent_activity', {
      activityId: 'activity-newer-init-error',
      agentThreadId: 'agent-newer-init-error',
      agentPath: '/root/newer-init-error',
      kind: 'started',
    })
    newerProc.emit('collab_agent_state', {
      toolUseId: 'tool-newer-init-error',
      agentsStates: { 'agent-newer-init-error': { status: 'running' } },
    })
    session.pendingMidTurnMsgs = newerQueued
    session.pendingTurnInputs = ['newer queued text']
    session.pendingReactionIds = new Map([
      ['om_newer_init_error', 'reaction_newer_init_error'],
    ])
    session.currentBatchReactionIds = new Map([
      ['om_newer_batch', 'reaction_newer_batch'],
    ])

    failedReplacement.emit('error', new Error('captured replacement init failed'))
    const ok = await restarting

    expect(ok).toBe(false)
    expect(failedReplacement.killCalls).toBe(1)
    expect(session.preservingRestartProc).toBeNull()
    expect(session.proc).toBe(newerProc)
    expect(session.currentTurn).toBe(newerTurn)
    expect(session.status).toBe('working')
    expect(session.codexCollabAgentStates).toEqual(new Map([
      ['agent-newer-init-error', 'running'],
    ]))
    expect(session.codexCollabAgentStatesByTool).toEqual(new Map([
      ['tool-newer-init-error', new Map([['agent-newer-init-error', 'running']])],
    ]))
    expect(session.codexSubagentActivityIds).toEqual(new Set(['activity-newer-init-error']))
    expect(session.activeCodexSubagentActivities).toEqual(new Set(['agent-newer-init-error']))
    expect(session.pendingMidTurnMsgs).toEqual(newerQueued)
    expect(session.pendingTurnInputs).toEqual(['newer queued text'])
    expect(session.pendingReactionIds).toEqual(new Map([
      ['om_newer_init_error', 'reaction_newer_init_error'],
    ]))
    expect(session.currentBatchReactionIds).toEqual(new Map([
      ['om_newer_batch', 'reaction_newer_batch'],
    ]))
    expect(lifecycleChanges).toBe(0)
  })

  test('real strict restart post-init ownership loss cannot stop a newer turn', async () => {
    const { session } = armedRecoverySession()
    const staleReplacement = new FakeAgentProc('codex', 'thread-1')
    const newerProc = new FakeAgentProc('codex', 'thread-newer-post-init')
    const newerTurn = turnState('card_newer_post_init')
    let lifecycleChanges = 0
    session.opts.onLifecycleChange = () => { lifecycleChanges++ }
    session.lastSessionId = 'thread-1'
    session.spawnAgent = () => staleReplacement
    staleReplacement.sendInitialize = () => {
      staleReplacement.once('init', () => {
        session.proc = newerProc
        session.currentTurn = newerTurn
        session.status = 'working'
        session.wireProc(newerProc)
        session.codexCollabAgentStates = new Map([['agent-newer-post-init', 'running']])
        session.codexCollabAgentStatesByTool = new Map([
          ['tool-newer-post-init', new Map([['agent-newer-post-init', 'running']])],
        ])
        session.codexSubagentActivityIds = new Set(['activity-newer-post-init'])
        session.activeCodexSubagentActivities = new Set(['agent-newer-post-init'])
        session.pendingMidTurnMsgs = [{
          text: 'post-init newer queue',
          wireText: 'post-init newer queue',
          userOpenId: 'ou_newer',
          msgId: 'om_newer_post_init',
        }]
        session.pendingReactionIds = new Map([
          ['om_newer_post_init', 'reaction_newer_post_init'],
        ])
      })
      staleReplacement.emit('init', { session_id: 'thread-1' })
    }

    const ok = await session.restart(true, {
      announce: false,
      requireResumeSession: true,
      preserveCurrentTurn: true,
      preserveQueuedHumanWork: true,
    })

    expect(ok).toBe(false)
    expect(staleReplacement.killCalls).toBe(1)
    expect(session.preservingRestartProc).toBeNull()
    expect(session.proc).toBe(newerProc)
    expect(session.currentTurn).toBe(newerTurn)
    expect(session.status).toBe('working')
    expect(session.codexCollabAgentStates).toEqual(new Map([
      ['agent-newer-post-init', 'running'],
    ]))
    expect(session.codexCollabAgentStatesByTool).toEqual(new Map([
      ['tool-newer-post-init', new Map([['agent-newer-post-init', 'running']])],
    ]))
    expect(session.codexSubagentActivityIds).toEqual(new Set(['activity-newer-post-init']))
    expect(session.activeCodexSubagentActivities).toEqual(new Set(['agent-newer-post-init']))
    expect(session.pendingMidTurnMsgs.map((msg: any) => msg.msgId)).toEqual([
      'om_newer_post_init',
    ])
    expect(session.pendingReactionIds).toEqual(new Map([
      ['om_newer_post_init', 'reaction_newer_post_init'],
    ]))
    expect(lifecycleChanges).toBe(0)
  })

  test('Task 6 repair: preserving restart ownership survives init through old-card close', async () => {
    const { session, proc, turn } = armedRecoverySession()
    const context = session.watchdogContext
    const resumed = new FakeAgentProc('codex', 'thread-1')
    const closeEntered = deferred<void>()
    const closeRelease = deferred<void>()
    const realCloseTurnCard = session.closeTurnCard.bind(session)
    session.lastSessionId = 'thread-1'
    session.spawnAgent = () => resumed
    session.closeTurnCard = async (...args: any[]) => {
      if (String(args[0] ?? '').includes('已自动中断')) {
        closeEntered.resolve()
        await closeRelease.promise
      }
      return await realCloseTurnCard(...args)
    }
    resumed.sendInitialize = () => {
      session.pendingMidTurnMsgs = [
        {
          text: 'first queued human',
          wireText: 'first queued human',
          userOpenId: 'ou_human',
          msgId: 'om_queued_first',
        },
        {
          text: 'second queued human',
          wireText: 'second queued human',
          userOpenId: 'ou_human',
          msgId: 'om_queued_second',
        },
      ]
      session.pendingTurnInputs = ['first queued human', 'second queued human']
      session.pendingReactionIds = new Map([
        ['om_queued_first', 'reaction_queued_first'],
        ['om_queued_second', 'reaction_queued_second'],
      ])
      session.currentBatchReactionIds = new Map([
        ['om_captured_turn', 'reaction_captured_turn'],
      ])
      resumed.emit('init', { session_id: 'thread-1' })
    }
    proc.onInterrupt = () => proc.emit('exit', { code: 0, signal: 'SIGTERM', expected: true })
    cardkit.recordCardCreated(turn.cardId, 1)

    const recovery = session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)
    await closeEntered.promise
    const markerDuringClose = session.preservingRestartProc

    resumed.alive = false
    resumed.emit('exit', { code: 9, signal: null, expected: false })
    const stateAfterReplacementExit = {
      turn: session.currentTurn,
      context: session.watchdogContext,
      queued: session.pendingMidTurnMsgs.map((msg: any) => [msg.text, msg.msgId]),
      inputs: [...session.pendingTurnInputs],
      pendingReactions: new Map(session.pendingReactionIds),
      batchReactions: new Map(session.currentBatchReactionIds),
    }
    closeRelease.resolve()
    await recovery

    expect(markerDuringClose).toBe(resumed)
    expect(stateAfterReplacementExit).toEqual({
      turn,
      context,
      queued: [
        ['first queued human', 'om_queued_first'],
        ['second queued human', 'om_queued_second'],
      ],
      inputs: ['first queued human', 'second queued human'],
      pendingReactions: new Map([
        ['om_queued_first', 'reaction_queued_first'],
        ['om_queued_second', 'reaction_queued_second'],
      ]),
      batchReactions: new Map([
        ['om_captured_turn', 'reaction_captured_turn'],
      ]),
    })
    expect(proc.sentTexts).not.toContain(WATCHDOG_RECOVERY_PROMPT)
    expect(resumed.sentTexts).not.toContain(WATCHDOG_RECOVERY_PROMPT)
    expect(session.preservingRestartProc).toBeNull()
    expect(session.proc).toBeNull()
    expect(session.watchdogResumeFailed).toBe(true)
    expect(session.status).toBe('stopped')

    let coldStarts = 0
    session.startColdUserTurn = async () => { coldStarts++ }
    await session.onUserMessage(
      'third human stays queued',
      ['/tmp/third-human.txt'],
      'ou_third_human',
      'om_third_human',
    )
    expect(coldStarts).toBe(0)
    expect(session.pendingMidTurnMsgs.map((msg: any) => msg.wireText)).toEqual([
      'first queued human',
      'second queued human',
      '[file: /tmp/third-human.txt]\nthird human stays queued',
    ])
    expect(sentTexts).toContain('⚠️ thread 自动恢复失败；这条消息已保留，修复后发送 restart 继续。')
  })

  test('Task 6 repair: ordinary resume restart never installs a preserving marker', async () => {
    const session = new Session('watchdog-ordinary-restart-marker', 'chat_id') as any
    const oldProc = new FakeAgentProc('codex', 'thread-ordinary')
    const resumed = new FakeAgentProc('codex', 'thread-ordinary')
    session.selectedProvider = 'codex'
    session.proc = oldProc
    session.lastSessionId = 'thread-ordinary'
    session.wireProc(oldProc)
    session.spawnAgent = () => resumed
    resumed.sendInitialize = () => resumed.emit('init', { session_id: 'thread-ordinary' })

    const ok = await session.restart(true, { announce: false })

    expect(ok).toBe(true)
    expect(session.proc).toBe(resumed)
    expect(session.preservingRestartProc).toBeNull()
  })

  test('strict resume init error preserves captured state through replacement exit', async () => {
    const { session, turn } = armedRecoverySession()
    const context = session.watchdogContext
    const resumed = new FakeAgentProc('codex', 'thread-1')
    session.lastSessionId = 'thread-1'
    session.pendingMidTurnMsgs = [{
      text: 'queued during resume',
      wireText: 'queued during resume',
      userOpenId: 'ou_human',
      msgId: 'om_resume_failure',
    }]
    session.pendingTurnInputs = ['queued input during resume']
    session.pendingReactionIds = new Map([
      ['om_resume_failure', 'reaction_resume_failure'],
    ])
    session.spawnAgent = () => resumed
    resumed.sendInitialize = () => resumed.emit('error', new Error('resume init failed'))
    let stateAfterReplacementExit: {
      turn: any
      context: any
      midTurn: any[]
      inputs: string[]
      reactions: Map<string, string>
    } | null = null
    resumed.kill = async () => {
      resumed.killCalls++
      resumed.alive = false
      resumed.emit('exit', { code: 1, signal: null, expected: true })
      stateAfterReplacementExit = {
        turn: session.currentTurn,
        context: session.watchdogContext,
        midTurn: [...session.pendingMidTurnMsgs],
        inputs: [...session.pendingTurnInputs],
        reactions: new Map(session.pendingReactionIds),
      }
    }

    const ok = await session.restart(true, {
      announce: false,
      requireResumeSession: true,
      preserveCurrentTurn: true,
      preserveQueuedHumanWork: true,
    })

    expect(ok).toBe(false)
    expect(resumed.killCalls).toBe(1)
    expect(stateAfterReplacementExit).toMatchObject({ turn, context })
    expect(stateAfterReplacementExit?.midTurn).toHaveLength(1)
    expect(stateAfterReplacementExit?.inputs).toEqual(['queued input during resume'])
    expect(stateAfterReplacementExit?.reactions).toEqual(new Map([
      ['om_resume_failure', 'reaction_resume_failure'],
    ]))
    expect(session.proc).toBeNull()
    expect(session.currentTurn).toBe(turn)
    expect(session.watchdogContext).toBe(context)
    expect(session.pendingMidTurnMsgs).toHaveLength(1)
    expect(session.pendingTurnInputs).toEqual(['queued input during resume'])
    expect(session.pendingReactionIds).toEqual(new Map([
      ['om_resume_failure', 'reaction_resume_failure'],
    ]))
  })

  test('strict resume direct init exit cannot run ordinary destructive cleanup', async () => {
    const { session, turn } = armedRecoverySession()
    const context = session.watchdogContext
    const resumed = new FakeAgentProc('codex', 'thread-1')
    session.lastSessionId = 'thread-1'
    session.pendingMidTurnMsgs = [{
      text: 'queued before init exit',
      wireText: 'queued before init exit',
      userOpenId: 'ou_human',
      msgId: 'om_init_exit',
    }]
    session.pendingReactionIds = new Map([['om_init_exit', 'reaction_init_exit']])
    session.spawnAgent = () => resumed
    const statuses: string[] = []
    let stateAfterReplacementExit: { turn: any; context: any; midTurnCount: number } | null = null
    resumed.sendInitialize = () => {
      resumed.alive = false
      resumed.emit('exit', { code: 1, signal: null, expected: true })
      stateAfterReplacementExit = {
        turn: session.currentTurn,
        context: session.watchdogContext,
        midTurnCount: session.pendingMidTurnMsgs.length,
      }
    }

    const ok = await session.restart(true, {
      announce: false,
      requireResumeSession: true,
      preserveCurrentTurn: true,
      preserveQueuedHumanWork: true,
      onStatus: status => statuses.push(status),
    })

    expect(ok).toBe(false)
    expect(stateAfterReplacementExit).toEqual({ turn, context, midTurnCount: 1 })
    expect(session.currentTurn).toBe(turn)
    expect(session.watchdogContext).toBe(context)
    expect(session.pendingMidTurnMsgs).toHaveLength(1)
    expect(session.pendingReactionIds).toEqual(new Map([
      ['om_init_exit', 'reaction_init_exit'],
    ]))
    expect(statuses.at(-1)).toContain('code=1')
    expect(statuses.at(-1)).toContain('signal=null')
    expect(statuses.at(-1)).toContain('expected=true')
    expect(statuses.at(-1)).not.toContain('[object Object]')
  })

  test('real strict resume failure closes the old card and preserves queued human work', async () => {
    const { session, proc, turn } = armedRecoverySession({ interruptGraceMs: 1 })
    const resumed = new FakeAgentProc('codex', 'thread-1')
    session.lastSessionId = 'thread-1'
    session.spawnAgent = () => resumed
    cardkit.recordCardCreated(turn.cardId, 1)
    let queuedHuman = Promise.resolve()
    resumed.sendInitialize = () => {
      queuedHuman = session.onUserMessage(
        'human survives failed resume',
        [],
        'ou_human',
        'om_human_survives',
      ).then(() => {
        session.pendingReactionIds.set('om_human_survives', 'reaction_human_survives')
        resumed.emit('error', new Error('resume init failed'))
      })
    }

    await session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)
    await queuedHuman

    const failedFooter = calls.find(call => {
      if (call.method !== 'PUT' || call.path !== `/cards/${turn.cardId}/elements/footer`) return false
      return String(JSON.parse(call.body.element).content).includes('自动恢复失败')
    })
    const closedSettings = calls.find(call => {
      if (call.method !== 'PATCH' || call.path !== `/cards/${turn.cardId}/settings`) return false
      const settings = JSON.parse(call.body.settings)
      return settings.config?.streaming_mode === false &&
        String(settings.config?.summary?.content).includes('自动恢复失败')
    })
    expect(failedFooter).toBeDefined()
    expect(closedSettings).toBeDefined()
    expect(session.status).toBe('stopped')
    expect(session.currentTurn).toBeNull()
    expect(session.watchdogContext).toBeNull()
    expect(session.pendingMidTurnMsgs.map((msg: any) => msg.text)).toEqual([
      'human survives failed resume',
    ])
    expect(session.pendingReactionIds).toEqual(new Map([
      ['om_human_survives', 'reaction_human_survives'],
    ]))
    expect(proc.sentTexts).not.toContain(WATCHDOG_RECOVERY_PROMPT)
    expect(resumed.sentTexts).not.toContain(WATCHDOG_RECOVERY_PROMPT)
  })

  test('closing an interrupted turn preserves pending reaction ownership only', async () => {
    const { session, turn } = armedRecoverySession()
    turn.userOpenId = ''
    session.pendingReactionIds = new Map([['om_pending', 'reaction_pending']])
    session.currentBatchReactionIds = new Map([['om_batch', 'reaction_batch']])
    cardkit.recordCardCreated(turn.cardId, 1)

    await session.closeTurnCard('🛟 已自动中断', { preservePendingReactions: true })

    expect(deletedReactions).toEqual([['om_batch', 'reaction_batch']])
    expect(session.currentBatchReactionIds).toEqual(new Map())
    expect(session.pendingReactionIds).toEqual(new Map([['om_pending', 'reaction_pending']]))
  })
})

describe('Session detached watchdog card terminalization', () => {
  /** 只让下一次 Card Kit HTTP 调用失败(返回指定 code),之后恢复本文件默认 mock。 */
  function failNextCardKitWrite(code: number): void {
    const previousFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      globalThis.fetch = previousFetch
      const url = new URL(String(input))
      calls.push({
        method: String(init?.method ?? 'GET'),
        path: url.pathname.replace('/open-apis/cardkit/v1', ''),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return new Response(JSON.stringify({ code, msg: `injected failure ${code}` }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch
  }

  function cardTerminalWrites(cardId: string): { footer: FetchCall | undefined; settings: FetchCall | undefined } {
    return {
      footer: calls.find(call => call.method === 'PUT' && call.path === `/cards/${cardId}/elements/footer`),
      settings: calls.find(call => call.method === 'PATCH' && call.path === `/cards/${cardId}/settings`),
    }
  }

  test('captured watchdog process exit closes only its old card', async () => {
    const { session, proc, turn } = armedRecoverySession()
    const action = session.beginWatchdogAction(session.watchdogContext, 'watchdog-recovery')
    expect(action).not.toBeNull()
    cardkit.recordCardCreated(turn.cardId, 1)
    session.pendingAsks.set('ask-watchdog-exit', { toolUseId: 'ask-watchdog-exit' })
    session.pendingHostAsks.set('hask-watchdog-exit', { requestId: 'hask-watchdog-exit' })
    session.pendingPermissions.set('perm-watchdog-exit', { requestId: 'perm-watchdog-exit' })

    proc.alive = false
    proc.emit('exit', { code: 1, signal: null, expected: false })

    expect(session.currentTurn).toBeNull()
    expect(session.status).toBe('stopped')
    expect(session.watchdogResumeFailed).toBe(true)
    expect(session.pendingAsks.size).toBe(0)
    expect(session.pendingHostAsks.size).toBe(0)
    expect(session.pendingPermissions.size).toBe(0)

    await waitFor(() => cardTerminalWrites(turn.cardId).settings !== undefined)
    const writes = cardTerminalWrites(turn.cardId)
    expect(JSON.parse(writes.footer?.body?.element ?? '{}').content)
      .toContain('自动恢复失败')
    expect(JSON.parse(writes.settings?.body?.settings ?? '{}'))
      .toMatchObject({ config: { streaming_mode: false } })
    // dispose 清掉卡状态(elementCount 归 0)后 fallback 决策已成定局,
    // 此时再断言"成功路径不发 raw 文本"才不会漏掉迟到的兜底发送。
    await waitFor(() => cardkit.getElementCount(turn.cardId) === 0)
    await Promise.resolve()
    expect(sentRawTexts.some(text => text.includes('自动恢复失败'))).toBe(false)
  })

  test('deferred old-card cleanup cannot mutate a replacement turn', async () => {
    const { session, proc, turn } = armedRecoverySession()
    const action = session.beginWatchdogAction(session.watchdogContext, 'watchdog-recovery')
    expect(action).not.toBeNull()
    cardkit.recordCardCreated(turn.cardId, 1)
    const rotating = deferred<void>()
    turn.rotating = rotating.promise

    proc.alive = false
    proc.emit('exit', { code: 1, signal: null, expected: false })
    expect(session.currentTurn).toBeNull()

    const replacementProc = new FakeAgentProc('codex', 'thread-replacement')
    const replacementTurn = turnState('card_watchdog_detached_replacement')
    const replacementReactions = new Map([['om_replacement', 'reaction-replacement']])
    session.proc = replacementProc
    session.currentTurn = replacementTurn
    session.status = 'working'
    session.pendingReactionIds = replacementReactions
    session.beginWatchdogTurn(replacementTurn, replacementProc, 0)
    const replacementContext = session.watchdogContext
    expect(replacementContext?.turn).toBe(replacementTurn)
    // 哨兵 footer 计时器:若清理误停 replacement 的 footer(读了可变
    // currentTurn),这个句柄会被清空。afterEach 的 stopFooterStatus 会回收。
    replacementTurn.footerStatusHandle = setInterval(() => {}, 60_000)

    rotating.resolve(undefined)
    await waitFor(() => cardTerminalWrites(turn.cardId).settings !== undefined)

    expect(session.proc).toBe(replacementProc)
    expect(session.currentTurn).toBe(replacementTurn)
    expect(session.status).toBe('working')
    expect(session.pendingReactionIds).toBe(replacementReactions)
    expect(session.watchdogContext).toBe(replacementContext)
    expect(replacementTurn.footerStatusHandle).not.toBeNull()
    expect(cardTerminalWrites('card_watchdog_detached_replacement').footer).toBeUndefined()
    expect(cardTerminalWrites('card_watchdog_detached_replacement').settings).toBeUndefined()
  })

  test('failed old-card terminal write sends one raw fallback', async () => {
    const { session, proc, turn } = armedRecoverySession()
    const action = session.beginWatchdogAction(session.watchdogContext, 'watchdog-recovery')
    expect(action).not.toBeNull()
    cardkit.recordCardCreated(turn.cardId, 1)
    failNextCardKitWrite(300317)

    proc.alive = false
    proc.emit('exit', { code: 1, signal: null, expected: false })

    await waitFor(() => sentRawTexts.some(text => text.includes('自动恢复失败')))
    // 等 dispose 落地(elementCount 归 0)再校验只发过一次兜底。
    await waitFor(() => cardkit.getElementCount(turn.cardId) === 0)
    await Promise.resolve()
    expect(sentRawTexts.filter(text => text.includes('自动恢复失败'))).toHaveLength(1)
  })
})

describe('Session watchdog human-priority races', () => {
  test('captured process exit before watchdog interrupt ownership preserves queued human work', async () => {
    const { session, proc, turn } = dueWatchdogSession()
    const resumed = new FakeAgentProc('codex', 'thread-1')
    const footerEntered = deferred<void>()
    const footerRelease = deferred<void>()
    session.lastSessionId = 'thread-1'
    session.spawnAgent = (resumeSessionId?: string) => {
      expect(resumeSessionId).toBe('thread-1')
      return resumed
    }
    resumed.sendInitialize = () => resumed.emit('init', { session_id: 'thread-1' })
    session.replaceFooterContent = async () => {
      footerEntered.resolve()
      await footerRelease.promise
    }

    const action = session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)
    await footerEntered.promise
    await session.onUserMessage(
      'first before interrupt exit',
      ['/tmp/first-before-exit.txt'],
      'ou_first_before_exit',
      'om_first_before_exit',
    )
    await session.onUserMessage(
      'second before interrupt exit',
      ['/tmp/second-a-before-exit.txt', '/tmp/second-b-before-exit.txt'],
      'ou_second_before_exit',
      'om_second_before_exit',
    )
    await waitFor(() => (
      session.pendingReactionIds.get('om_first_before_exit') === 'reaction-om_first_before_exit' &&
      session.pendingReactionIds.get('om_second_before_exit') === 'reaction-om_second_before_exit'
    ))

    proc.alive = false
    proc.emit('exit', { code: 1, signal: null, expected: false })
    footerRelease.resolve()
    await action

    expect(session.pendingMidTurnMsgs).toEqual([{
      text: 'first before interrupt exit',
      wireText: '[file: /tmp/first-before-exit.txt]\nfirst before interrupt exit',
      userOpenId: 'ou_first_before_exit',
      msgId: 'om_first_before_exit',
    }, {
      text: 'second before interrupt exit',
      wireText: '[file: /tmp/second-a-before-exit.txt] [file: /tmp/second-b-before-exit.txt]\nsecond before interrupt exit',
      userOpenId: 'ou_second_before_exit',
      msgId: 'om_second_before_exit',
    }])
    expect(session.pendingReactionIds).toEqual(new Map([
      ['om_first_before_exit', 'reaction-om_first_before_exit'],
      ['om_second_before_exit', 'reaction-om_second_before_exit'],
    ]))
    expect(deletedReactions).not.toContainEqual([
      'om_first_before_exit',
      'reaction-om_first_before_exit',
    ])
    expect(deletedReactions).not.toContainEqual([
      'om_second_before_exit',
      'reaction-om_second_before_exit',
    ])
    expect(session.proc).toBeNull()
    expect(session.watchdogResumeFailed).toBe(true)
    expect(session.status).toBe('stopped')

    expect(await session.resumeFailedWatchdogQueue({ announce: false })).toBe(true)
    expect(session.watchdogResumeFailed).toBe(false)
    expect(resumed.sentTexts).toEqual([
      '[file: /tmp/first-before-exit.txt]\nfirst before interrupt exit\n\n' +
      '[file: /tmp/second-a-before-exit.txt] [file: /tmp/second-b-before-exit.txt]\nsecond before interrupt exit',
    ])
    expect(session.pendingMidTurnMsgs).toEqual([])
    expect(session.pendingReactionIds).toEqual(new Map())
    expect(session.currentBatchReactionIds).toEqual(new Map([
      ['om_first_before_exit', 'reaction-om_first_before_exit'],
      ['om_second_before_exit', 'reaction-om_second_before_exit'],
    ]))
    expect(session.currentTurn).not.toBe(turn)
    expect(session.currentTurn).toMatchObject({
      trigger: 'user_message',
      userOpenId: 'ou_second_before_exit',
    })
  })

  test('multi-message flush after a captured exit strict retry starts on the resumed process', async () => {
    const { session, proc, turn } = dueWatchdogSession()
    const resumed = new FakeAgentProc('codex', 'thread-1')
    const footerEntered = deferred<void>()
    const footerRelease = deferred<void>()
    session.lastSessionId = 'thread-1'
    session.spawnAgent = (resumeSessionId?: string) => {
      expect(resumeSessionId).toBe('thread-1')
      return resumed
    }
    resumed.sendInitialize = () => resumed.emit('init', { session_id: 'thread-1' })
    session.replaceFooterContent = async () => {
      footerEntered.resolve()
      await footerRelease.promise
    }

    const action = session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)
    await footerEntered.promise
    expect(await session.onMultiMessageInbound(
      '>>>first buffered segment',
      ['/tmp/first-buffered-a.txt', '/tmp/first-buffered-b.txt'],
      'ou_first_buffered',
      'om_first_buffered',
    )).toBe(true)
    expect(await session.onMultiMessageInbound(
      'second buffered segment',
      ['/tmp/second-buffered.txt'],
      'ou_second_buffered',
      'om_second_buffered',
    )).toBe(true)
    await waitFor(() => (
      session.multiMsgReactions.get('om_first_buffered') === 'reaction-om_first_buffered' &&
      session.multiMsgReactions.get('om_second_buffered') === 'reaction-om_second_buffered'
    ))

    proc.alive = false
    proc.emit('exit', { code: 1, signal: null, expected: false })
    footerRelease.resolve()
    await action

    expect(session.watchdogResumeFailed).toBe(true)
    expect(session.multiMsgBuffer).toEqual([{
      text: 'first buffered segment',
      files: ['/tmp/first-buffered-a.txt', '/tmp/first-buffered-b.txt'],
      userOpenId: 'ou_first_buffered',
      msgId: 'om_first_buffered',
    }, {
      text: 'second buffered segment',
      files: ['/tmp/second-buffered.txt'],
      userOpenId: 'ou_second_buffered',
      msgId: 'om_second_buffered',
    }])
    expect(session.multiMsgReactions).toEqual(new Map([
      ['om_first_buffered', 'reaction-om_first_buffered'],
      ['om_second_buffered', 'reaction-om_second_buffered'],
    ]))

    expect(await session.resumeFailedWatchdogQueue({ announce: false })).toBe(true)
    expect(session.watchdogResumeFailed).toBe(false)
    expect(await session.onMultiMessageInbound(
      '<<<third buffered segment',
      ['/tmp/third-buffered.txt'],
      'ou_third_buffered',
      'om_third_buffered',
    )).toBe(true)

    expect(resumed.sentTexts).toEqual([
      '[file: /tmp/first-buffered-a.txt] [file: /tmp/first-buffered-b.txt]\nfirst buffered segment\n\n' +
      '[file: /tmp/second-buffered.txt]\nsecond buffered segment\n\n' +
      '[file: /tmp/third-buffered.txt]\nthird buffered segment',
    ])
    expect(session.pendingMidTurnMsgs).toEqual([])
    expect(session.pendingReactionIds).toEqual(new Map())
    expect(session.multiMsgBuffer).toBeNull()
    expect(session.multiMsgReactions).toEqual(new Map())
    expect(session.currentTurn).not.toBe(turn)
    expect(session.currentTurn).toMatchObject({
      trigger: 'user_message',
      userOpenId: 'ou_third_buffered',
    })
    expect(addedReactions).toEqual(expect.arrayContaining([
      ['om_first_buffered', 'Pin'],
      ['om_second_buffered', 'Pin'],
      ['om_third_buffered', 'Pin'],
    ]))
    expect(addedReactions).not.toContainEqual(['om_third_buffered', 'OneSecond'])
    expect(deletedReactions).toEqual(expect.arrayContaining([
      ['om_first_buffered', 'reaction-om_first_buffered'],
      ['om_second_buffered', 'reaction-om_second_buffered'],
      ['om_third_buffered', 'reaction-om_third_buffered'],
    ]))
  })

  test('manual retry after a captured exit without queued work detaches the stale turn', async () => {
    const { session, proc, turn } = dueWatchdogSession()
    const resumed = new FakeAgentProc('codex', 'thread-1')
    const footerEntered = deferred<void>()
    const footerRelease = deferred<void>()
    session.lastSessionId = 'thread-1'
    session.spawnAgent = (resumeSessionId?: string) => {
      expect(resumeSessionId).toBe('thread-1')
      return resumed
    }
    resumed.sendInitialize = () => resumed.emit('init', { session_id: 'thread-1' })
    session.replaceFooterContent = async () => {
      footerEntered.resolve()
      await footerRelease.promise
    }

    const action = session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)
    await footerEntered.promise
    proc.alive = false
    proc.emit('exit', { code: 1, signal: null, expected: false })
    footerRelease.resolve()
    await action

    expect(session.watchdogResumeFailed).toBe(true)

    expect(await session.resumeFailedWatchdogQueue({ announce: false })).toBe(true)
    expect(session.watchdogResumeFailed).toBe(false)
    expect(session.currentTurn).toBeNull()

    await session.onUserMessage(
      'first human after strict retry',
      ['/tmp/after-strict-retry.txt'],
      'ou_after_strict_retry',
      'om_after_strict_retry',
    )

    expect(resumed.sentTexts).toEqual([
      '[file: /tmp/after-strict-retry.txt]\nfirst human after strict retry',
    ])
    expect(session.pendingMidTurnMsgs).toEqual([])
    expect(session.currentTurn).not.toBe(turn)
    expect(session.currentTurn).toMatchObject({
      trigger: 'user_message',
      userOpenId: 'ou_after_strict_retry',
    })
  })

  test('captured process exit after watchdog settlement preserves later human work', async () => {
    const { session, proc, turn } = dueWatchdogSession()
    const closeRelease = deferred<void>()
    session.lastSessionId = 'thread-1'
    proc.onInterrupt = () => {
      turn.rotating = closeRelease.promise
      proc.emit('result', {})
    }

    const action = session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)
    await waitFor(() => session.currentTurn === null && session.watchdogActionInFlight)
    await session.onUserMessage(
      'human after settlement before exit',
      ['/tmp/after-settlement.txt'],
      'ou_after_settlement',
      'om_after_settlement',
    )
    await waitFor(() => (
      session.pendingReactionIds.get('om_after_settlement') === 'reaction-om_after_settlement'
    ))

    proc.alive = false
    proc.emit('exit', { code: 1, signal: null, expected: false })
    closeRelease.resolve()
    await action

    expect(session.pendingMidTurnMsgs).toEqual([{
      text: 'human after settlement before exit',
      wireText: '[file: /tmp/after-settlement.txt]\nhuman after settlement before exit',
      userOpenId: 'ou_after_settlement',
      msgId: 'om_after_settlement',
    }])
    expect(session.pendingReactionIds).toEqual(new Map([
      ['om_after_settlement', 'reaction-om_after_settlement'],
    ]))
    expect(deletedReactions).not.toContainEqual([
      'om_after_settlement',
      'reaction-om_after_settlement',
    ])
    expect(session.proc).toBeNull()
    expect(session.watchdogResumeFailed).toBe(true)
    expect(session.status).toBe('stopped')
  })

  test('human input before the recovery footer patch completes cancels without consuming budget', async () => {
    const { session, proc } = dueWatchdogSession()
    const ctx = session.watchdogContext
    const verdict = session.watchdog.evaluate(
      WATCHDOG_DUE_AT,
      session.watchdogSafetySnapshot(ctx),
    )
    expect(verdict.type).toBe('recover')
    if (verdict.type !== 'recover') return

    const footerEntered = deferred<void>()
    const footerRelease = deferred<void>()
    session.replaceFooterContent = async () => {
      footerEntered.resolve()
      await footerRelease.promise
    }

    const recovery = session.runWatchdogRecovery(ctx, verdict)
    await footerEntered.promise
    await session.onUserMessage(
      'human wins before interrupt',
      ['/tmp/watchdog-race.txt'],
      'ou_human',
      'om_before_interrupt',
    )
    footerRelease.resolve()
    await recovery
    await Promise.resolve()

    expect(proc.interruptCalls).toBe(0)
    expect(session.watchdog.snapshot().recoveryAttempt).toBe(0)
    expect(session.pendingMidTurnMsgs).toEqual([{
      text: 'human wins before interrupt',
      wireText: '[file: /tmp/watchdog-race.txt]\nhuman wins before interrupt',
      userOpenId: 'ou_human',
      msgId: 'om_before_interrupt',
    }])
    expect(addedReactions).toContainEqual(['om_before_interrupt', 'OneSecond'])
  })

  test('two human messages during interrupt grace become one ordered human turn', async () => {
    const { session, proc, turn } = dueWatchdogSession()
    const interrupted = deferred<void>()
    proc.onInterrupt = () => interrupted.resolve()
    cardkit.recordCardCreated(turn.cardId, 1)

    const recovery = session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)
    await interrupted.promise
    await session.onUserMessage('first human', ['/tmp/first.txt'], 'ou_first', 'om_first')
    await session.onUserMessage('second human', [], 'ou_second', 'om_second')
    await Promise.resolve()
    proc.emit('result', {})
    await recovery

    expect(proc.interruptCalls).toBe(1)
    expect(proc.sentTexts).toEqual([
      '[file: /tmp/first.txt]\nfirst human\n\nsecond human',
    ])
    expect(proc.sentTexts).not.toContain(WATCHDOG_RECOVERY_PROMPT)
    expect(session.currentTurn).toMatchObject({
      trigger: 'user_message',
      userOpenId: 'ou_second',
    })
    expect(deletedReactions).not.toContainEqual(['om_first', 'reaction-om_first'])
    expect(deletedReactions).not.toContainEqual(['om_second', 'reaction-om_second'])
  })

  test('human input while strict resume awaits init is sent on the resumed process', async () => {
    const { session, proc, turn } = dueWatchdogSession()
    const resumed = new FakeAgentProc('codex', 'thread-1')
    const initAwaited = deferred<void>()
    session.lastSessionId = 'thread-1'
    session.spawnAgent = () => resumed
    resumed.sendInitialize = () => initAwaited.resolve()
    proc.onInterrupt = () => proc.emit('exit', { code: 0, signal: 'SIGTERM', expected: true })
    cardkit.recordCardCreated(turn.cardId, 1)

    const recovery = session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)
    await initAwaited.promise
    await session.onUserMessage(
      'human while resume waits',
      ['/tmp/resume.txt'],
      'ou_resume_human',
      'om_resume_human',
    )
    resumed.emit('init', { session_id: 'thread-1' })
    await recovery

    expect(resumed.sentTexts).toEqual([
      '[file: /tmp/resume.txt]\nhuman while resume waits',
    ])
    expect(resumed.sentTexts).not.toContain(WATCHDOG_RECOVERY_PROMPT)
    expect(session.currentTurn).toMatchObject({
      trigger: 'user_message',
      userOpenId: 'ou_resume_human',
    })
  })

  test('human input during recovery-card creation closes the empty recovery card and wins', async () => {
    const { session, proc, turn } = dueWatchdogSession()
    const recoveryCardStarted = deferred<void>()
    const recoveryCardResult = deferred<string | null>()
    let sendCount = 0
    proc.onInterrupt = () => proc.emit('result', {})
    cardkit.recordCardCreated(turn.cardId, 1)
    feishuMockState.sendCard = async () => {
      sendCount++
      if (sendCount === 1) {
        recoveryCardStarted.resolve()
        return await recoveryCardResult.promise
      }
      return 'om_human_after_recovery_card'
    }

    try {
      const recovery = session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)
      await recoveryCardStarted.promise
      await session.onUserMessage(
        'human during recovery card',
        [],
        'ou_recovery_card_human',
        'om_recovery_card_human',
      )
      recoveryCardResult.resolve('om_empty_recovery_card')
      await recovery

      expect(proc.sentTexts).toEqual(['human during recovery card'])
      expect(proc.sentTexts).not.toContain(WATCHDOG_RECOVERY_PROMPT)
      expect(session.currentTurn).toMatchObject({
        trigger: 'user_message',
        userOpenId: 'ou_recovery_card_human',
      })
      expect(calls.some(call => {
        if (call.method !== 'PATCH' || !call.path.endsWith('/settings')) return false
        return String(call.body?.settings ?? '').includes('真人消息优先')
      })).toBe(true)
    } finally {
      recoveryCardResult.resolve(null)
      feishuMockState.sendCard = null
    }
  })

  test('failed recovery queues later human input instead of cold-starting', async () => {
    const session = new Session('watchdog-failed-queue', 'chat_id') as any
    let coldStarts = 0
    session.selectedProvider = 'codex'
    installFailedWatchdogRecovery(session)
    session.startColdUserTurn = async () => { coldStarts++ }

    await session.onUserMessage(
      'preserve after failed resume',
      ['/tmp/failed-resume.txt'],
      'ou_failed_resume',
      'om_failed_resume',
    )
    await Promise.resolve()

    expect(coldStarts).toBe(0)
    expect(session.pendingMidTurnMsgs).toEqual([{
      text: 'preserve after failed resume',
      wireText: '[file: /tmp/failed-resume.txt]\npreserve after failed resume',
      userOpenId: 'ou_failed_resume',
      msgId: 'om_failed_resume',
    }])
    expect(sentTexts).toContain('⚠️ thread 自动恢复失败；这条消息已保留，修复后发送 restart 继续。')
    expect(addedReactions).toContainEqual(['om_failed_resume', 'OneSecond'])
  })
})

describe('Session watchdog scheduler and exhausted budget', () => {
  test('arming the watchdog turn wires a live tick interval to the real evaluator', () => {
    // 不注入时间、不直接调 evaluateWatchdogTick:捕获 beginWatchdogTurn
    // 真正注册的 interval 回调并触发它,覆盖 setInterval 接线 + 默认
    // Date.now() 路径 —— 这条接线断了,449 个注入式测试全绿但生产永远不触发。
    const originalSetInterval = globalThis.setInterval
    const tickCallbacks: Array<() => void> = []
    globalThis.setInterval = ((handler: () => void, ms?: number, ...rest: unknown[]) => {
      tickCallbacks.push(handler)
      return (originalSetInterval as any)(() => {}, ms ?? 60_000, ...rest)
    }) as typeof setInterval
    try {
      const { session, turn } = wiredWatchdogSession('codex')
      expect(session.watchdogTickHandle).not.toBeNull()
      expect(tickCallbacks.length).toBeGreaterThan(0)
      expect(() => {
        for (const tick of tickCallbacks) tick()
      }).not.toThrow()
      // 刚开轮、无 idle:真实时间路径下不得产生任何告警/恢复副作用。
      expect(turn.footerStatusOverride ?? null).toBeNull()
      expect(session.watchdogActionInFlight).toBe(false)
    } finally {
      globalThis.setInterval = originalSetInterval
    }
  })

  test('stale watchdog recovery finally cannot clear a newer watchdog action token', async () => {
    const { session } = dueWatchdogSession()
    const footerEntered = deferred<void>()
    const footerRelease = deferred<void>()
    session.replaceFooterContent = async () => {
      footerEntered.resolve()
      await footerRelease.promise
    }

    const staleRecovery = session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)
    await footerEntered.promise
    const staleTransaction = session.watchdogAction
    session.beginLifecycle('hi')
    const newerTransaction = session.beginWatchdogAction(
      session.watchdogContext,
      'watchdog-recovery',
    )
    expect(newerTransaction).not.toBeNull()
    expect(newerTransaction).not.toBe(staleTransaction)

    footerRelease.resolve()
    await staleRecovery

    expect(session.watchdogAction).toBe(newerTransaction)
    expect(session.watchdogActionInFlight).toBe(true)
    session.finishWatchdogAction(newerTransaction)
  })

  test('two due ticks launch exactly one recovery interrupt', async () => {
    const { session, proc, turn } = dueWatchdogSession()
    expect(typeof session.evaluateWatchdogTick).toBe('function')
    const footerEntered = deferred<void>()
    const footerRelease = deferred<void>()
    session.replaceFooterContent = async () => {
      footerEntered.resolve()
      await footerRelease.promise
    }
    proc.onInterrupt = () => proc.emit('result', {})
    cardkit.recordCardCreated(turn.cardId, 1)

    session.evaluateWatchdogTick(WATCHDOG_DUE_AT)
    await footerEntered.promise
    session.evaluateWatchdogTick(WATCHDOG_DUE_AT)
    footerRelease.resolve()
    await waitFor(() => !session.watchdogActionInFlight)

    expect(proc.interruptCalls).toBe(1)
  })

  test('an open multi-message buffer suppresses recovery and survives a preserving restart', async () => {
    const { session, proc } = dueWatchdogSession()
    const resumed = new FakeAgentProc('codex', 'thread-1')
    const buffered = [{
      text: 'buffered segment', files: ['/tmp/buffered.txt'],
      userOpenId: 'ou_buffered', msgId: 'om_buffered',
    }]
    session.multiMsgBuffer = buffered
    session.lastSessionId = 'thread-1'
    session.spawnAgent = () => resumed
    resumed.sendInitialize = () => resumed.emit('init', { session_id: 'thread-1' })
    expect(typeof session.evaluateWatchdogTick).toBe('function')

    session.evaluateWatchdogTick(WATCHDOG_DUE_AT)
    await Promise.resolve()
    expect(proc.interruptCalls).toBe(0)

    const ok = await session.restart(true, {
      announce: false,
      requireResumeSession: true,
      preserveCurrentTurn: true,
      preserveQueuedHumanWork: true,
    })
    expect(ok).toBe(true)
    expect(session.multiMsgBuffer).toEqual(buffered)
  })

  test('the second confirmed loop interrupts and stops without a third turn', async () => {
    const { session, proc, turn } = dueWatchdogSession({ recoveryAttempt: 1 })
    const interrupted = deferred<void>()
    proc.onInterrupt = () => interrupted.resolve()
    cardkit.recordCardCreated(turn.cardId, 1)
    expect(typeof session.evaluateWatchdogTick).toBe('function')

    session.evaluateWatchdogTick(WATCHDOG_DUE_AT)
    await interrupted.promise
    proc.emit('result', {})
    await waitFor(() => !session.watchdogActionInFlight)

    expect(proc.interruptCalls).toBe(1)
    expect(proc.sentTexts).toEqual([])
    expect(proc.sentTexts).not.toContain(WATCHDOG_RECOVERY_PROMPT)
    expect(sentCards).toEqual([])
    expect(session.currentTurn).toBeNull()
    expect(session.status).toBe('idle')
  })

  test('human input after the exhausted interrupt starts a fresh human chain', async () => {
    const { session, proc, turn } = dueWatchdogSession({ recoveryAttempt: 1 })
    const interrupted = deferred<void>()
    proc.onInterrupt = () => interrupted.resolve()
    cardkit.recordCardCreated(turn.cardId, 1)
    expect(typeof session.evaluateWatchdogTick).toBe('function')

    session.evaluateWatchdogTick(WATCHDOG_DUE_AT)
    await interrupted.promise
    await session.onUserMessage(
      'human after exhausted interrupt',
      [],
      'ou_exhausted_human',
      'om_exhausted_human',
    )
    proc.emit('result', {})
    await waitFor(() => !session.watchdogActionInFlight)

    expect(proc.sentTexts).toEqual(['human after exhausted interrupt'])
    expect(proc.sentTexts).not.toContain(WATCHDOG_RECOVERY_PROMPT)
    expect(session.currentTurn).toMatchObject({
      trigger: 'user_message',
      userOpenId: 'ou_exhausted_human',
    })
    expect(session.watchdog.snapshot().recoveryAttempt).toBe(0)
  })

  test('exhausted settlement never drains queued human work into a replacement thread', async () => {
    const { session, proc, turn } = dueWatchdogSession({ recoveryAttempt: 1 })
    const replacement = new FakeAgentProc('codex', 'thread-replacement')
    const settlementEntered = deferred<void>()
    const settlementRelease = deferred<any>()
    cardkit.recordCardCreated(turn.cardId, 1)
    session.waitForTurnSettlement = async () => {
      settlementEntered.resolve()
      return await settlementRelease.promise
    }

    const action = session.runWatchdogExhausted(session.watchdogContext, {
      type: 'stop_exhausted', idleMs: 900_000, repeatCount: 10,
      fingerprintHash: 'b'.repeat(64),
    })
    await settlementEntered.promise
    session.proc = replacement
    session.wireProc(replacement)
    await session.onUserMessage(
      'human must stay on captured thread',
      [],
      'ou_wrong_thread_guard',
      'om_wrong_thread_guard',
    )
    settlementRelease.resolve({ type: 'result', proc, turn })
    await action

    expect(replacement.sentTexts).toEqual([])
    expect(replacement.sentTexts).not.toContain(WATCHDOG_RECOVERY_PROMPT)
    expect(session.pendingMidTurnMsgs.map((msg: any) => msg.text)).toEqual([
      'human must stay on captured thread',
    ])
    expect(session.watchdogResumeFailed).toBe(true)
    expect(session.status).toBe('stopped')
  })

  test('exhausted settlement never drains queued human work into a same-thread replacement process', async () => {
    const { session, proc, turn } = dueWatchdogSession({ recoveryAttempt: 1 })
    const replacement = new FakeAgentProc('codex', 'thread-1')
    const settlementEntered = deferred<void>()
    const settlementRelease = deferred<any>()
    cardkit.recordCardCreated(turn.cardId, 1)
    session.waitForTurnSettlement = async () => {
      settlementEntered.resolve()
      return await settlementRelease.promise
    }

    const action = session.runWatchdogExhausted(session.watchdogContext, {
      type: 'stop_exhausted', idleMs: 900_000, repeatCount: 10,
      fingerprintHash: 'c'.repeat(64),
    })
    await settlementEntered.promise
    session.proc = replacement
    session.wireProc(replacement)
    await session.onUserMessage(
      'human must stay on captured process',
      [],
      'ou_same_thread_guard',
      'om_same_thread_guard',
    )
    settlementRelease.resolve({ type: 'result', proc, turn })
    await action

    expect(proc.isAlive()).toBe(true)
    expect(replacement.isAlive()).toBe(true)
    expect(replacement.sentTexts).toEqual([])
    expect(replacement.sentTexts).not.toContain(WATCHDOG_RECOVERY_PROMPT)
    expect(session.pendingMidTurnMsgs.map((msg: any) => msg.text)).toEqual([
      'human must stay on captured process',
    ])
    expect(session.watchdogResumeFailed).toBe(true)
    expect(session.status).toBe('stopped')
  })

  test('exhausted timeout detaches then kills only the captured process', async () => {
    const { session, proc, turn } = dueWatchdogSession({ recoveryAttempt: 1 })
    const verdict = session.watchdog.evaluate(
      WATCHDOG_DUE_AT,
      session.watchdogSafetySnapshot(session.watchdogContext),
    )
    expect(verdict.type).toBe('stop_exhausted')
    expect(typeof session.runWatchdogExhausted).toBe('function')
    if (verdict.type !== 'stop_exhausted') return
    cardkit.recordCardCreated(turn.cardId, 1)
    session.waitForTurnSettlement = async () => ({ type: 'timeout' })
    let detachedAtKill = false
    proc.kill = async () => {
      proc.killCalls++
      detachedAtKill = session.proc === null
      proc.alive = false
      proc.emit('exit', { code: 0, signal: 'SIGTERM', expected: true })
    }

    await session.runWatchdogExhausted(session.watchdogContext, verdict)

    expect(detachedAtKill).toBe(true)
    expect(proc.killCalls).toBe(1)
    expect(session.proc).toBeNull()
    expect(session.status).toBe('stopped')
  })

  test('exhausted timeout kills the captured process without touching a replacement owner', async () => {
    const { session, proc, turn } = dueWatchdogSession({ recoveryAttempt: 1 })
    const replacement = new FakeAgentProc('codex', 'thread-replacement')
    const verdict = session.watchdog.evaluate(
      WATCHDOG_DUE_AT,
      session.watchdogSafetySnapshot(session.watchdogContext),
    )
    expect(verdict.type).toBe('stop_exhausted')
    if (verdict.type !== 'stop_exhausted') return
    cardkit.recordCardCreated(turn.cardId, 1)
    session.waitForTurnSettlement = async () => {
      session.proc = replacement
      session.wireProc(replacement)
      return { type: 'timeout' }
    }

    await session.runWatchdogExhausted(session.watchdogContext, verdict)

    expect(proc.killCalls).toBe(1)
    expect(replacement.killCalls).toBe(0)
    expect(session.proc).toBe(replacement)
  })
})

describe('Session watchdog runtime cleanup', () => {
  test('natural result closes the watchdog context and scheduler tick', async () => {
    const { session, proc, turn } = armedRecoverySession()
    const closed = deferred<void>()
    const realClose = session.closeTurnCard.bind(session)
    session.closeTurnCard = async (...args: any[]) => {
      await realClose(...args)
      closed.resolve()
    }
    cardkit.recordCardCreated(turn.cardId, 1)
    expect(session.watchdogTickHandle).not.toBeNull()

    proc.emit('result', {})
    await closed.promise

    expect(session.watchdogContext).toBeNull()
    expect(session.watchdogTickHandle).toBeNull()
    expect(session.activeTurnInterrupt).toBeNull()
  })

  test('natural exit clears watchdog state, waiter, and Codex activity ownership', async () => {
    const { session, proc } = armedRecoverySession()
    const interrupt = session.beginTurnInterrupt('user')
    session.codexCollabAgentStates.set('agent-1', 'running')
    session.codexCollabAgentStatesByTool.set('tool-1', new Map([['agent-1', 'running']]))
    session.codexSubagentActivityIds.add('activity-1')
    session.activeCodexSubagentActivities.add('agent-1')
    session.pendingWatchdogIdentity = {
      proc, threadId: 'thread-1', turnId: 'turn-1', turnCounter: 1,
    }
    expect(interrupt).not.toBeNull()
    expect(session.watchdogTickHandle).not.toBeNull()

    proc.alive = false
    proc.emit('exit', { code: 0, signal: null, expected: true })

    expect(session.watchdogContext).toBeNull()
    expect(session.watchdogTickHandle).toBeNull()
    expect(session.activeTurnInterrupt).toBeNull()
    expect(session.codexCollabAgentStates.size).toBe(0)
    expect(session.codexCollabAgentStatesByTool.size).toBe(0)
    expect(session.codexSubagentActivityIds.size).toBe(0)
    expect(session.activeCodexSubagentActivities.size).toBe(0)
    expect(session.pendingWatchdogIdentity).toBeNull()
  })

  test('soft stop ends watchdog observation but leaves its user waiter settleable', async () => {
    const { session, proc, turn } = armedRecoverySession()
    cardkit.recordCardCreated(turn.cardId, 1)

    await session.runCommand('st')
    const interrupt = session.activeTurnInterrupt

    expect(interrupt?.source).toBe('user')
    expect(session.watchdogContext).toBeNull()
    expect(session.watchdogTickHandle).toBeNull()
    proc.emit('result', {})
    expect(await interrupt.promise).toMatchObject({ type: 'result' })
    expect(session.activeTurnInterrupt).toBeNull()
  })

  test('soft stop preserves failed-recovery reaction ownership while closing the turn', async () => {
    const { session, proc, turn } = armedRecoverySession()
    installFailedWatchdogRecovery(session, { proc, turn })
    session.pendingMidTurnMsgs = [{
      text: 'preserved after st',
      wireText: 'preserved after st',
      userOpenId: 'ou_preserved_after_st',
      msgId: 'om_preserved_after_st',
    }]
    session.pendingReactionIds = new Map([
      ['om_preserved_after_st', 'reaction-preserved-after-st'],
    ])
    cardkit.recordCardCreated(turn.cardId, 1)

    await session.runCommand('st')

    expect(session.watchdogResumeFailed).toBe(true)
    expect(session.pendingMidTurnMsgs).toHaveLength(1)
    expect(session.pendingReactionIds).toEqual(new Map([
      ['om_preserved_after_st', 'reaction-preserved-after-st'],
    ]))
    expect(deletedReactions).not.toContainEqual([
      'om_preserved_after_st',
      'reaction-preserved-after-st',
    ])
  })

  for (const [label, action] of [
    ['full stop', async (session: any) => { await session.stop('cleanup test', { announce: false }) }],
    ['ordinary restart', async (session: any) => {
      session.start = async () => true
      await session.restart(false, { announce: false })
    }],
    ['dispose', async (session: any) => { session.dispose() }],
    ['kl command', async (session: any) => { await session.runCommand('kl') }],
  ] as const) {
    test(`${label} cancels the outstanding waiter and scheduler tick`, async () => {
      const { session } = armedRecoverySession()
      const interrupt = session.beginTurnInterrupt('user')
      expect(interrupt).not.toBeNull()
      expect(session.watchdogTickHandle).not.toBeNull()

      await action(session)

      expect(session.activeTurnInterrupt).toBeNull()
      expect(session.watchdogTickHandle).toBeNull()
      expect((await interrupt.promise).type).toBe('cancelled')
    })
  }

  test('failed resume latch survives a failed manual retry and clears after success', async () => {
    const { session, proc } = armedRecoverySession()
    session.currentTurn = null
    session.endWatchdogTurn()
    installFailedWatchdogRecovery(session, { proc, turn: turnState('card_manual_retry_latch') })
    session.pendingMidTurnMsgs = [{
      text: 'queued human', wireText: 'queued human',
      userOpenId: 'ou_queued', msgId: 'om_queued_human',
    }]
    const restartResults = [false, true]
    const restartOptions: any[] = []
    let drains = 0
    session.restart = async (resume: boolean, opts: any) => {
      expect(resume).toBe(true)
      restartOptions.push(opts)
      session.proc = proc
      proc.alive = true
      const result = restartResults.shift() ?? false
      if (result) session.preservedWatchdogRecovery.replacementProc = proc
      return result
    }
    session.drainMidTurnAndOpen = async () => {
      drains++
      session.pendingMidTurnMsgs = []
      return 'committed'
    }
    expect(typeof session.resumeFailedWatchdogQueue).toBe('function')

    expect(await session.resumeFailedWatchdogQueue({ announce: false })).toBe(false)
    expect(session.watchdogResumeFailed).toBe(true)
    expect(session.pendingMidTurnMsgs).toHaveLength(1)
    expect(drains).toBe(0)

    expect(await session.resumeFailedWatchdogQueue({ announce: false })).toBe(true)
    expect(session.watchdogResumeFailed).toBe(false)
    expect(session.preservingRestartProc).toBeNull()
    expect(drains).toBe(1)
    expect(restartOptions).toEqual([
      expect.objectContaining({
        requireResumeSession: true,
        preserveCurrentTurn: true,
        preserveQueuedHumanWork: true,
      }),
      expect.objectContaining({
        requireResumeSession: true,
        preserveCurrentTurn: true,
        preserveQueuedHumanWork: true,
      }),
    ])
  })

  test('manual failed-recovery retry commits its captured batch when newer input arrives during card open', async () => {
    const { session, proc } = armedRecoverySession()
    const cardOpenEntered = deferred<void>()
    const cardOpenResult = deferred<string | null>()
    const captured = {
      text: 'captured preserved input',
      wireText: '[file: /tmp/captured-preserved.txt]\ncaptured preserved input',
      userOpenId: 'ou_captured_preserved',
      msgId: 'om_captured_preserved',
    }
    session.currentTurn = null
    session.endWatchdogTurn()
    installFailedWatchdogRecovery(session, { proc, turn: turnState('card_manual_retry_batch') })
    session.pendingMidTurnMsgs = [captured]
    session.pendingReactionIds = new Map([
      ['om_captured_preserved', 'reaction-om_captured_preserved'],
    ])
    session.restart = async () => {
      session.proc = proc
      proc.alive = true
      session.preservedWatchdogRecovery.replacementProc = proc
      return true
    }
    feishuMockState.sendCard = async () => {
      cardOpenEntered.resolve()
      return await cardOpenResult.promise
    }

    let resumed = false
    try {
      const retry = session.resumeFailedWatchdogQueue({ announce: false })
      await cardOpenEntered.promise
      await session.onUserMessage(
        'newer input during captured open',
        ['/tmp/newer-during-open.txt'],
        'ou_newer_during_open',
        'om_newer_during_open',
      )
      await waitFor(() => (
        session.pendingReactionIds.get('om_newer_during_open') === 'reaction-om_newer_during_open'
      ))
      cardOpenResult.resolve('om_captured_preserved_card')
      resumed = await retry
    } finally {
      cardOpenResult.resolve(null)
      feishuMockState.sendCard = null
    }

    expect(resumed).toBe(true)
    expect(session.watchdogResumeFailed).toBe(false)
    expect(session.status).toBe('working')
    expect(proc.sentTexts).toEqual([
      '[file: /tmp/captured-preserved.txt]\ncaptured preserved input',
    ])
    expect(session.pendingMidTurnMsgs).toEqual([{
      text: 'newer input during captured open',
      wireText: '[file: /tmp/newer-during-open.txt]\nnewer input during captured open',
      userOpenId: 'ou_newer_during_open',
      msgId: 'om_newer_during_open',
    }])
    expect(session.currentBatchReactionIds).toEqual(new Map([
      ['om_captured_preserved', 'reaction-om_captured_preserved'],
    ]))
    expect(session.pendingReactionIds).toEqual(new Map([
      ['om_newer_during_open', 'reaction-om_newer_during_open'],
    ]))
  })

  for (const [label, recoveryAttempt] of [
    ['recovery', 0],
    ['exhausted', 1],
  ] as const) {
    test(`${label} keeps failed-resume ownership when the captured human batch card cannot open`, async () => {
      const { session, proc, turn } = dueWatchdogSession({ recoveryAttempt })
      const humanQueued = deferred<void>()
      session.lastSessionId = 'thread-1'
      cardkit.recordCardCreated(turn.cardId, 1)
      feishuMockState.sendCard = async () => null
      proc.onInterrupt = () => {
        void session.onUserMessage(
          `${label} captured human`,
          [`/tmp/${label}-captured.txt`],
          `ou_${label}_captured`,
          `om_${label}_captured`,
        ).then(() => {
          humanQueued.resolve()
          proc.emit('result', {})
        })
      }

      try {
        const action = recoveryAttempt === 0
          ? session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)
          : session.runWatchdogExhausted(session.watchdogContext, {
              type: 'stop_exhausted', idleMs: 900_000, repeatCount: 10,
              fingerprintHash: 'd'.repeat(64),
            })
        await humanQueued.promise
        await action
        await waitFor(() => (
          session.pendingReactionIds.get(`om_${label}_captured`) === `reaction-om_${label}_captured`
        ))

        expect(proc.sentTexts).toEqual([])
        expect(session.pendingMidTurnMsgs).toEqual([{
          text: `${label} captured human`,
          wireText: `[file: /tmp/${label}-captured.txt]\n${label} captured human`,
          userOpenId: `ou_${label}_captured`,
          msgId: `om_${label}_captured`,
        }])
        expect(session.pendingReactionIds).toEqual(new Map([
          [`om_${label}_captured`, `reaction-om_${label}_captured`],
        ]))
        expect(session.watchdogResumeFailed).toBe(true)
        expect(session.status).toBe('stopped')
        expect(sentRawTexts.some(text => text.includes('自动恢复失败'))).toBe(true)
      } finally {
        feishuMockState.sendCard = null
      }
    })
  }

  test('hi preserves the failed-resume latch and cannot run newer input ahead of the saved queue', async () => {
    const session = new Session('watchdog-hi-failed-resume', 'chat_id') as any
    const freshProc = new FakeAgentProc('codex', 'fresh-thread')
    let startCalls = 0
    let coldStarts = 0
    session.selectedProvider = 'codex'
    installFailedWatchdogRecovery(session)
    session.lastSessionId = 'thread-1'
    session.pendingMidTurnMsgs = [{
      text: 'preserved older input',
      wireText: '[file: /tmp/preserved-older.txt]\npreserved older input',
      userOpenId: 'ou_preserved_older',
      msgId: 'om_preserved_older',
    }]
    session.pendingReactionIds = new Map([
      ['om_preserved_older', 'reaction-om_preserved_older'],
    ])
    session.openStatusCard = async () => null
    session.closeStatusCard = async () => {}
    session.showConsole = async () => {}
    session.start = async () => {
      startCalls++
      session.proc = freshProc
      return true
    }
    session.startColdUserTurn = async () => { coldStarts++ }

    await session.runCommand('hi')
    await session.onUserMessage(
      'newer input after hi',
      ['/tmp/newer-after-hi.txt'],
      'ou_newer_after_hi',
      'om_newer_after_hi',
    )
    await waitFor(() => (
      session.pendingReactionIds.get('om_newer_after_hi') === 'reaction-om_newer_after_hi'
    ))

    expect(startCalls).toBe(0)
    expect(coldStarts).toBe(0)
    expect(session.proc).toBeNull()
    expect(freshProc.sentTexts).toEqual([])
    expect(session.watchdogResumeFailed).toBe(true)
    expect(session.pendingMidTurnMsgs).toEqual([{
      text: 'preserved older input',
      wireText: '[file: /tmp/preserved-older.txt]\npreserved older input',
      userOpenId: 'ou_preserved_older',
      msgId: 'om_preserved_older',
    }, {
      text: 'newer input after hi',
      wireText: '[file: /tmp/newer-after-hi.txt]\nnewer input after hi',
      userOpenId: 'ou_newer_after_hi',
      msgId: 'om_newer_after_hi',
    }])
    expect(sentTexts.some(text => text.includes('已保留') && text.includes('restart'))).toBe(true)
  })

  test('restart command routes a failed-recovery queue through strict resume helper', async () => {
    const session = new Session('watchdog-manual-retry', 'chat_id') as any
    installFailedWatchdogRecovery(session)
    session.pendingMidTurnMsgs = [{
      text: 'queued human', wireText: 'queued human',
      userOpenId: 'ou_queued', msgId: 'om_queued_human',
    }]
    let helperCalls = 0
    let ordinaryCalls = 0
    session.resumeFailedWatchdogQueue = async () => { helperCalls++; return false }
    session.restart = async () => { ordinaryCalls++; return false }
    session.openStatusCard = async () => null

    await session.runCommand('restart')

    expect(helperCalls).toBe(1)
    expect(ordinaryCalls).toBe(0)
  })

  test('manual retry keeps the latch when the preserved human card cannot open', async () => {
    const { session, proc } = armedRecoverySession()
    session.currentTurn = null
    session.endWatchdogTurn()
    installFailedWatchdogRecovery(session, { proc, turn: turnState('card_manual_retry_open_failure') })
    session.pendingMidTurnMsgs = [{
      text: 'still queued', wireText: 'still queued',
      userOpenId: 'ou_still_queued', msgId: 'om_still_queued',
    }]
    session.restart = async () => {
      session.proc = proc
      session.preservedWatchdogRecovery.replacementProc = proc
      return true
    }
    session.drainMidTurnAndOpen = async () => 'preserved'

    expect(await session.resumeFailedWatchdogQueue({ announce: false })).toBe(false)
    expect(session.watchdogResumeFailed).toBe(true)
    expect(session.preservingRestartProc).toBe(proc)
    expect(session.preservedWatchdogRecovery).toMatchObject({
      provider: 'codex',
      threadId: 'thread-1',
      phase: 'failed',
      replacementProc: proc,
    })
    expect(session.pendingMidTurnMsgs).toHaveLength(1)
  })

  test('explicit full stop clears the failed-recovery latch', async () => {
    const { session } = armedRecoverySession()
    installFailedWatchdogRecovery(session)

    await session.stop('explicit full stop', { announce: false })

    expect(session.watchdogResumeFailed).toBe(false)
  })

  test('full stop destructively clears failed-recovery human work while already stopped', async () => {
    const session = stoppedFailedRecoverySession('full-stop')

    await session.stop('discard failed recovery', { announce: false })

    expectStoppedFailedRecoveryQueueCleared(session)
  })

  test('full stop discards human work that arrives while agy stop is awaiting completion', async () => {
    const { session, proc } = wiredWatchdogSession('codex')
    const agyStopEntered = deferred<void>()
    const agyStopRelease = deferred<void>()
    session.stopAgyTask = async () => {
      agyStopEntered.resolve()
      await agyStopRelease.promise
      return true
    }

    const stopping = session.stop('discard agy-stop arrivals', { announce: false })
    await agyStopEntered.promise
    await session.onUserMessage(
      'human during agy stop',
      [],
      'ou_during_agy_stop',
      'om_during_agy_stop',
    )
    await session.onMultiMessageInbound(
      '>>>buffered during agy stop',
      [],
      'ou_multi_during_agy_stop',
      'om_multi_during_agy_stop',
    )
    session.pendingUserMessageCount = 1
    session.pendingTurnInputs = ['pending input during agy stop']
    session.currentBatchReactionIds.set(
      'om_batch_during_agy_stop',
      'reaction-om_batch_during_agy_stop',
    )
    await waitFor(() => (
      session.pendingReactionIds.get('om_during_agy_stop') === 'reaction-om_during_agy_stop' &&
      session.multiMsgReactions.get('om_multi_during_agy_stop') === 'reaction-om_multi_during_agy_stop'
    ))

    agyStopRelease.resolve()
    await stopping

    expect(proc.killCalls).toBe(1)
    expect(session.status).toBe('stopped')
    expectStoppedFailedRecoveryQueueCleared(session)
    expect(deletedReactions).toContainEqual([
      'om_during_agy_stop',
      'reaction-om_during_agy_stop',
    ])
    expect(deletedReactions).toContainEqual([
      'om_multi_during_agy_stop',
      'reaction-om_multi_during_agy_stop',
    ])
    expect(deletedReactions).toContainEqual([
      'om_batch_during_agy_stop',
      'reaction-om_batch_during_agy_stop',
    ])
  })

  test('kl destructively clears failed-recovery human work while already stopped', async () => {
    const session = stoppedFailedRecoverySession('kl')

    await session.runCommand('kl')

    expectStoppedFailedRecoveryQueueCleared(session)
  })

  test('clear explicitly discards a stopped failed-recovery queue without starting', async () => {
    const session = stoppedFailedRecoverySession('clear')
    let restartCalls = 0
    session.restart = async () => { restartCalls++; return true }

    await session.runCommand('clear')

    expect(restartCalls).toBe(0)
    expectStoppedFailedRecoveryQueueCleared(session)
  })

  for (const [label, action, preservesRecovery] of [
    ['public stop', async (session: any) => { await session.stop('superseding stop', { announce: false }) }, false],
    ['kl', async (session: any) => { await session.runCommand('kl') }, false],
    ['clear', async (session: any) => { await session.runCommand('clear') }, false],
    ['dispose', async (session: any) => { session.dispose() }, false],
    ['st', async (session: any) => { await session.runCommand('st') }, true],
  ] as const) {
    test(`${label} supersedes a strict retry before install and kills only its stale replacement`, async () => {
      const session = stoppedFailedRecoverySession(`strict-spawn-${label}`)
      const staleReplacement = new FakeAgentProc('codex', 'thread-1')
      const preservedQueue = [...session.pendingMidTurnMsgs]
      let superseding: Promise<void> | null = null
      session.spawnAgent = () => {
        superseding = Promise.resolve(action(session))
        return staleReplacement
      }

      const resumed = await session.resumeFailedWatchdogQueue({ announce: false })
      await superseding

      expect(resumed).toBe(false)
      expect(staleReplacement.killCalls).toBe(1)
      expect(session.proc).not.toBe(staleReplacement)
      if (preservesRecovery) {
        expect(session.preservedWatchdogRecovery).not.toBeNull()
        expect(session.watchdogResumeFailed).toBe(true)
        expect(session.pendingMidTurnMsgs).toEqual(preservedQueue)
      } else {
        expect(session.preservedWatchdogRecovery).toBeNull()
        expect(session.pendingMidTurnMsgs).toEqual([])
      }
    })
  }

  test('a stale strict replacement cleanup never kills a newer process owner', async () => {
    const session = stoppedFailedRecoverySession('strict-spawn-newer-owner')
    const staleReplacement = new FakeAgentProc('codex', 'thread-1')
    const newerProc = new FakeAgentProc('codex', 'thread-newer-owner')
    session.spawnAgent = () => {
      session.beginLifecycle('hi')
      session.proc = newerProc
      return staleReplacement
    }

    const resumed = await session.resumeFailedWatchdogQueue({ announce: false })

    expect(resumed).toBe(false)
    expect(staleReplacement.killCalls).toBe(1)
    expect(newerProc.killCalls).toBe(0)
    expect(session.proc).toBe(newerProc)
  })

  test('strict retry rejects a supplied identity mismatch before acquiring lifecycle ownership', async () => {
    const { session, proc, action, recovery } = ownedFailedWatchdogRecoverySession()
    const lifecycleEpoch = session.lifecycleEpoch
    const lifecycleOwner = session.lifecycleOwner
    const replacement = new FakeAgentProc('codex', 'thread-other')
    let spawnCalls = 0
    session.spawnAgent = () => {
      spawnCalls++
      return replacement
    }
    replacement.sendInitialize = () => replacement.emit('init', { session_id: 'thread-other' })

    const resumed = await session.restart(true, {
      announce: false,
      requireResumeSession: true,
      preserveCurrentTurn: true,
      preserveQueuedHumanWork: true,
      preservedRecoveryToken: recovery.token,
      resumeIdentity: { provider: 'codex', threadId: 'thread-other' },
    })

    expect(resumed).toBe(false)
    expect(spawnCalls).toBe(0)
    expect(session.proc).toBe(proc)
    expect(proc.killCalls).toBe(0)
    expect(session.lifecycleEpoch).toBe(lifecycleEpoch)
    expect(session.lifecycleOwner).toBe(lifecycleOwner)
    expect(session.preservedWatchdogRecovery).toBe(recovery)
    expect(recovery.phase).toBe('failed')
    expect(session.watchdogAction).toBe(action)
    expect(session.ownsWatchdogAction(action)).toBe(true)
  })

  test('strict retry accepts a matching replay identity but derives spawn identity from recovery', async () => {
    const { session, recovery } = ownedFailedWatchdogRecoverySession()
    const replacement = new FakeAgentProc('codex', recovery.threadId)
    const spawnArgs: Array<[string | undefined, string | undefined]> = []
    session.selectedProvider = 'claude'
    session.lastSessionId = 'mutable-wrong-thread'
    session.spawnAgent = (resumeSessionId?: string, provider?: string) => {
      spawnArgs.push([resumeSessionId, provider])
      return replacement
    }
    replacement.sendInitialize = () => replacement.emit('init', { session_id: recovery.threadId })

    const resumed = await session.restart(true, {
      announce: false,
      requireResumeSession: true,
      preserveCurrentTurn: true,
      preserveQueuedHumanWork: true,
      preservedRecoveryToken: recovery.token,
      resumeIdentity: { provider: recovery.provider, threadId: recovery.threadId },
    })

    expect(resumed).toBe(true)
    expect(spawnArgs).toEqual([[recovery.threadId, recovery.provider]])
    expect(session.proc).toBe(replacement)
    expect(session.preservedWatchdogRecovery).toBe(recovery)
  })

  test('strict retry uses the preserved Codex thread after mutable selection changes', async () => {
    const session = stoppedFailedRecoverySession('strict-immutable-identity')
    const replacement = new FakeAgentProc('codex', 'thread-1')
    const spawnArgs: Array<[string | undefined, string | undefined]> = []
    session.selectedProvider = 'claude'
    session.lastSessionId = 'mutable-wrong-thread'
    session.pendingMidTurnMsgs = []
    session.spawnAgent = (resumeSessionId?: string, provider?: string) => {
      spawnArgs.push([resumeSessionId, provider])
      return replacement
    }
    replacement.sendInitialize = () => replacement.emit('init', { session_id: 'thread-1' })

    const resumed = await session.resumeFailedWatchdogQueue({ announce: false })

    expect(resumed).toBe(true)
    expect(spawnArgs).toEqual([['thread-1', 'codex']])
    expect(session.proc).toBe(replacement)
    expect(session.preservedWatchdogRecovery).toBeNull()
  })

  for (const [label, replacement] of [
    ['wrong provider', new FakeAgentProc('claude', 'thread-1')],
    ['wrong thread', new FakeAgentProc('codex', 'thread-wrong')],
  ] as const) {
    test(`strict retry kills a ${label} replacement and never drains the batch`, async () => {
      const session = stoppedFailedRecoverySession(`strict-${label}`)
      let drains = 0
      session.selectedProvider = 'claude'
      session.lastSessionId = 'mutable-wrong-thread'
      session.spawnAgent = () => replacement
      replacement.alive = true
      replacement.sendInitialize = () => replacement.emit('init', { session_id: replacement.sessionId })
      session.drainMidTurnAndOpen = async () => { drains++; return 'committed' }

      const resumed = await session.resumeFailedWatchdogQueue({ announce: false })

      expect(resumed).toBe(false)
      expect(replacement.killCalls).toBe(1)
      expect(drains).toBe(0)
      expect(session.watchdogResumeFailed).toBe(true)
      expect(session.pendingMidTurnMsgs).toHaveLength(1)
    })
  }

  test('wrong-provider replacement cleanup cannot stop a newer lifecycle owner', async () => {
    const session = stoppedFailedRecoverySession('strict-wrong-provider-cleanup-race')
    const wrongProvider = new FakeAgentProc('claude', 'thread-1')
    const newerProc = new FakeAgentProc('codex', 'thread-newer-cleanup-owner')
    let lifecycleChanges = 0
    session.opts.onLifecycleChange = () => { lifecycleChanges++ }
    session.spawnAgent = () => wrongProvider
    wrongProvider.kill = async () => {
      wrongProvider.killCalls++
      wrongProvider.alive = false
      session.beginLifecycle('hi')
      session.proc = newerProc
      session.status = 'working'
    }

    const resumed = await session.resumeFailedWatchdogQueue({ announce: false })

    expect(resumed).toBe(false)
    expect(wrongProvider.killCalls).toBe(1)
    expect(session.proc).toBe(newerProc)
    expect(session.status).toBe('working')
    expect(lifecycleChanges).toBe(0)
  })

  test('a stale strict-retry spawn exception cannot stop a newer lifecycle owner', async () => {
    const session = stoppedFailedRecoverySession('strict-stale-spawn-throw')
    const newerProc = new FakeAgentProc('codex', 'thread-newer-strict-throw')
    let lifecycleChanges = 0
    session.opts.onLifecycleChange = () => { lifecycleChanges++ }
    session.spawnAgent = () => {
      session.beginLifecycle('hi')
      session.proc = newerProc
      session.status = 'working'
      throw new Error('stale strict retry spawn failed')
    }

    const resumed = await session.resumeFailedWatchdogQueue({ announce: false })

    expect(resumed).toBe(false)
    expect(session.proc).toBe(newerProc)
    expect(session.status).toBe('working')
    expect(lifecycleChanges).toBe(0)
  })
})

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

type ControlledCodexDispatch = {
  dispatch: Extract<UserTextDispatch, { kind: 'turn_start_pending' }>
  started: Promise<void>
  ack: (turnId?: string | null) => void
  reject: (error: Error) => void
}

let humanDeliveryFixtureCount = 0

type PreInitCodexDispatchControl = {
  dispatch: Extract<UserTextDispatch, { kind: 'turn_start_pending' }>
  started: Promise<void>
  bind: (threadId: string) => void
  ack: (turnId?: string | null) => void
  reject: (error: Error) => void
}

/** 模拟真实 pre-init CodexProcess:dispatch.threadId 起始为 null,
 *  init 后由 bind() 就地绑定(与 initializeAndStartThread 的行为一致)。 */
function controlPreInitCodexDispatch(
  proc: FakeAgentProc,
  deliveryId = `delivery-${++humanDeliveryFixtureCount}`,
): PreInitCodexDispatchControl {
  const record: { threadId: string | null } = { threadId: null }
  const settlement = deferred<CodexUserTextSettlement>()
  const started = deferred<void>()
  const dispatch = {
    kind: 'turn_start_pending' as const,
    provider: 'codex' as const,
    deliveryId,
    get threadId() {
      return record.threadId
    },
    settlement: settlement.promise,
  }
  proc.dispatchFactory = () => {
    started.resolve(undefined)
    return dispatch
  }
  return {
    dispatch,
    started: started.promise,
    bind: threadId => {
      record.threadId = threadId
    },
    ack: (turnId = null) => settlement.resolve({
      kind: 'ack', deliveryId, threadId: record.threadId!, turnId,
    }),
    reject: error => settlement.resolve({
      kind: 'rejected', deliveryId, threadId: record.threadId, error,
    }),
  }
}

function controlCodexDispatch(
  proc: FakeAgentProc,
  deliveryId = `delivery-${++humanDeliveryFixtureCount}`,
): ControlledCodexDispatch {
  const threadId = proc.sessionId ?? `thread-${humanDeliveryFixtureCount}`
  const settlement = deferred<CodexUserTextSettlement>()
  const started = deferred<void>()
  const dispatch = {
    kind: 'turn_start_pending' as const,
    provider: 'codex' as const,
    deliveryId,
    threadId,
    settlement: settlement.promise,
  }
  proc.dispatchFactory = () => {
    started.resolve(undefined)
    return dispatch
  }
  return {
    dispatch,
    started: started.promise,
    ack: (turnId = null) => settlement.resolve({
      kind: 'ack', deliveryId, threadId, turnId,
    }),
    reject: error => settlement.resolve({
      kind: 'rejected', deliveryId, threadId, error,
    }),
  }
}

function pendingHumanDrainFixture(provider: 'codex' | 'claude' = 'codex') {
  const id = ++humanDeliveryFixtureCount
  const session = new Session(`pending-human-delivery-${provider}-${id}`, 'chat_id') as any
  const proc = new FakeAgentProc(provider, `${provider}-thread-${id}`)
  const batch = [
    {
      text: 'first human input',
      wireText: '[file: /tmp/first-human.png]\nfirst human input',
      userOpenId: 'ou_first_human',
      msgId: 'om_first_human',
    },
    {
      text: 'second human input',
      wireText: '[file: /tmp/second-a.txt] [file: /tmp/second-b.txt]\nsecond human input',
      userOpenId: 'ou_second_human',
      msgId: 'om_second_human',
    },
  ]
  session.selectedProvider = provider
  session.proc = proc
  session.status = 'idle'
  session.pendingMidTurnMsgs = batch
  session.pendingReactionIds = new Map([
    ['om_first_human', 'reaction-first-human'],
    ['om_second_human', 'reaction-second-human'],
  ])
  session.wireProc(proc)
  const control = provider === 'codex' ? controlCodexDispatch(proc) : null
  return { session, proc, batch, control }
}

describe('Session pending human delivery', () => {
  test('Codex exit before ACK restores the exact drained batch and reactions once', async () => {
    const { session, proc, batch, control } = pendingHumanDrainFixture('codex')
    const draining = session.drainMidTurnAndOpen()
    await control!.started

    proc.alive = false
    proc.emit('exit', { code: 1, signal: null, expected: false })
    control!.reject(new Error('exited'))
    expect(await draining).toBe('preserved')

    expect(session.pendingMidTurnMsgs).toEqual(batch)
    expect(session.pendingMidTurnMsgs[0]).toBe(batch[0])
    expect(session.pendingMidTurnMsgs[1]).toBe(batch[1])
    expect(session.pendingReactionIds).toEqual(new Map([
      ['om_first_human', 'reaction-first-human'],
      ['om_second_human', 'reaction-second-human'],
    ]))
    expect(proc.sentTexts).toEqual([
      `${batch[0]!.wireText}\n\n${batch[1]!.wireText}`,
    ])
    expect(session.pendingUserMessageCount).toBe(0)

    proc.emit('exit', { code: 1, signal: null, expected: false })
    expect(session.pendingMidTurnMsgs).toEqual(batch)
  })

  test('an exit-restored batch stays ahead of the next cold-start message', async () => {
    const { session, proc, batch, control } = pendingHumanDrainFixture('codex')
    const draining = session.drainMidTurnAndOpen()
    await control!.started
    proc.alive = false
    proc.emit('exit', { code: 1, signal: null, expected: false })
    control!.reject(new Error('exited before ACK'))
    expect(await draining).toBe('preserved')

    const replacement = new FakeAgentProc('codex', 'thread-exit-retry')
    const retry = controlCodexDispatch(replacement)
    session.start = async () => {
      session.proc = replacement
      session.status = 'idle'
      session.wireProc(replacement)
      return true
    }
    const nextMessage = session.onUserMessage(
      'new cold-start input', ['/tmp/new-cold.txt'], 'ou_new_cold', 'om_new_cold',
    )
    await retry.started

    expect(replacement.sentTexts).toEqual([[
      batch[0]!.wireText,
      batch[1]!.wireText,
      '[file: /tmp/new-cold.txt]\nnew cold-start input',
    ].join('\n\n')])
    retry.ack('turn-exit-retry')
    await nextMessage
  })

  test('Codex ACK before exit commits once and never replays the drained batch', async () => {
    const { session, proc, control } = pendingHumanDrainFixture('codex')
    const draining = session.drainMidTurnAndOpen()
    await control!.started
    control!.ack('turn-acked')

    expect(await draining).toBe('committed')
    proc.alive = false
    proc.emit('exit', { code: 1, signal: null, expected: false })

    expect(session.pendingMidTurnMsgs).toEqual([])
    expect(session.pendingUserMessageCount).toBe(1)
    expect(proc.sentTexts).toHaveLength(1)
  })

  test('Codex RPC rejection before ACK restores the drained batch', async () => {
    const { session, proc, batch, control } = pendingHumanDrainFixture('codex')
    const draining = session.drainMidTurnAndOpen()
    await control!.started
    control!.reject(new Error('turn/start rejected'))

    expect(await draining).toBe('preserved')
    expect(session.currentTurn).toBeNull()
    expect(session.pendingMidTurnMsgs).toEqual(batch)
    expect(session.pendingUserMessageCount).toBe(0)

    const retry = controlCodexDispatch(proc)
    const nextMessage = session.onUserMessage(
      'newer human input', ['/tmp/newer.txt'], 'ou_newer', 'om_newer',
    )
    await retry.started
    expect(proc.sentTexts.at(-1)).toBe([
      batch[0]!.wireText,
      batch[1]!.wireText,
      '[file: /tmp/newer.txt]\nnewer human input',
    ].join('\n\n'))
    retry.ack('turn-retry')
    await nextMessage
  })

  test('synchronous human dispatch rejection closes its card and preserves FIFO retry order', async () => {
    const { session, proc, batch } = pendingHumanDrainFixture('claude')
    proc.dispatchFactory = () => ({
      kind: 'rejected',
      provider: 'claude',
      error: new Error('input queue closed'),
    })

    expect(await session.drainMidTurnAndOpen()).toBe('preserved')
    expect(session.currentTurn).toBeNull()
    expect(session.pendingMidTurnMsgs).toEqual(batch)

    proc.dispatchFactory = null
    await session.onUserMessage('newer sync input', [], 'ou_newer_sync', 'om_newer_sync')
    expect(proc.sentTexts.at(-1)).toBe([
      batch[0]!.wireText,
      batch[1]!.wireText,
      'newer sync input',
    ].join('\n\n'))
  })

  test('a rejected result immediately followed by exit cannot clear the restored batch', async () => {
    const { session, proc, batch, control } = pendingHumanDrainFixture('codex')
    const draining = session.drainMidTurnAndOpen()
    await control!.started

    control!.reject(new Error('app-server exited'))
    proc.emit('result', {
      subtype: 'codex_turn_start_failed',
      is_error: true,
      delivery_id: control!.dispatch.deliveryId,
      thread_id: control!.dispatch.threadId,
      turn_id: null,
    })
    expect(proc.sentTexts).toHaveLength(1)
    proc.alive = false
    proc.emit('exit', { code: 1, signal: null, expected: false })

    expect(await draining).toBe('preserved')
    expect(session.pendingMidTurnMsgs).toEqual(batch)
    expect(session.pendingReactionIds).toEqual(new Map([
      ['om_first_human', 'reaction-first-human'],
      ['om_second_human', 'reaction-second-human'],
    ]))
  })

  test('a matching result commits synchronously before the receipt continuation', async () => {
    const { session, proc, control } = pendingHumanDrainFixture('codex')
    let closeCalls = 0
    session.closeTurnCard = async () => { closeCalls++ }
    const draining = session.drainMidTurnAndOpen()
    await control!.started

    control!.ack('turn-result-first')
    proc.emit('result', {
      delivery_id: control!.dispatch.deliveryId,
      thread_id: control!.dispatch.threadId,
      turn_id: 'turn-result-first',
    })

    expect(session.pendingUserMessageCount).toBe(1)
    expect(session.pendingHumanDelivery).toBeNull()
    expect(session.ackedHumanDelivery).toBeNull()
    expect(closeCalls).toBe(1)
    expect(await draining).toBe('committed')
  })

  test('matching human completion releases its owner before a later system completion', async () => {
    const { session, proc, control } = pendingHumanDrainFixture('codex')
    const draining = session.drainMidTurnAndOpen()
    await control!.started
    control!.ack('turn-human-complete')
    proc.emit('result', {
      delivery_id: control!.dispatch.deliveryId,
      thread_id: control!.dispatch.threadId,
      turn_id: 'turn-human-complete',
    })
    expect(await draining).toBe('committed')
    expect(session.ackedHumanDelivery).toBeNull()

    const systemTurn = turnState('card_system_after_human')
    systemTurn.trigger = 'watchdog_resume'
    systemTurn.backendThreadId = proc.sessionId
    systemTurn.backendTurnId = 'turn-system-after-human'
    session.currentTurn = systemTurn
    session.status = 'working'

    proc.emit('result', {
      delivery_id: 'system-delivery-after-human',
      thread_id: proc.sessionId,
      turn_id: 'turn-system-after-human',
    })

    expect(session.currentTurn).toBeNull()
    expect(session.status).toBe('idle')
  })

  for (const [label, eventPatch] of [
    ['delivery ID', { delivery_id: 'delivery-stale' }],
    ['thread ID', { thread_id: 'thread-stale' }],
    ['turn ID', { turn_id: 'turn-stale' }],
  ] as const) {
    test(`a stale ${label} cannot commit or close the pending delivery`, async () => {
      const { session, proc, control } = pendingHumanDrainFixture('codex')
      let closeCalls = 0
      session.closeTurnCard = async () => { closeCalls++ }
      const draining = session.drainMidTurnAndOpen()
      await control!.started
      session.currentTurn.backendThreadId = control!.dispatch.threadId
      session.currentTurn.backendTurnId = 'turn-current'

      proc.emit('result', {
        delivery_id: control!.dispatch.deliveryId,
        thread_id: control!.dispatch.threadId,
        turn_id: 'turn-current',
        ...eventPatch,
      })

      expect(session.pendingHumanDelivery?.state).toBe('pending')
      expect(session.pendingUserMessageCount).toBe(0)
      expect(closeCalls).toBe(0)
      control!.reject(new Error('settle stale fixture'))
      expect(await draining).toBe('preserved')
    })
  }

  test('a stale process result cannot settle or close the replacement turn', async () => {
    const { session, proc, control } = pendingHumanDrainFixture('codex')
    let closeCalls = 0
    session.closeTurnCard = async () => { closeCalls++ }
    const draining = session.drainMidTurnAndOpen()
    await control!.started
    const replacement = new FakeAgentProc('codex', 'replacement-thread')
    const replacementTurn = turnState('card_replacement_delivery')
    session.proc = replacement
    session.currentTurn = replacementTurn
    session.status = 'starting'

    proc.emit('result', {
      delivery_id: control!.dispatch.deliveryId,
      thread_id: control!.dispatch.threadId,
      turn_id: 'turn-old',
    })

    expect(session.pendingHumanDelivery?.state).toBe('pending')
    expect(session.currentTurn).toBe(replacementTurn)
    expect(session.status).toBe('starting')
    expect(closeCalls).toBe(0)
    control!.reject(new Error('old owner rejected'))
    expect(await draining).toBe('preserved')
  })

  test('an ACK after process owner replacement does not mutate or replay into the replacement', async () => {
    const { session, batch, control } = pendingHumanDrainFixture('codex')
    const draining = session.drainMidTurnAndOpen()
    await control!.started
    const replacement = new FakeAgentProc('codex', 'replacement-ack-thread')
    const replacementTurn = turnState('card_replacement_ack')
    session.proc = replacement
    session.currentTurn = replacementTurn
    session.status = 'starting'

    control!.ack('turn-old-owner')
    expect(await draining).toBe('preserved')

    expect(session.pendingMidTurnMsgs).toEqual(batch)
    expect(session.pendingMidTurnMsgs[0]).toBe(batch[0])
    expect(session.pendingMidTurnMsgs[1]).toBe(batch[1])
    expect(session.pendingReactionIds).toEqual(new Map([
      ['om_first_human', 'reaction-first-human'],
      ['om_second_human', 'reaction-second-human'],
    ]))
    expect(session.pendingUserMessageCount).toBe(0)
    expect(session.currentTurn).toBe(replacementTurn)
    expect(session.status).toBe('starting')
  })

  test('an ACK after turn owner replacement restores the batch without closing the replacement', async () => {
    const { session, proc, batch, control } = pendingHumanDrainFixture('codex')
    const draining = session.drainMidTurnAndOpen()
    await control!.started
    const replacementTurn = turnState('card_replacement_ack_same_proc')
    session.currentTurn = replacementTurn
    session.status = 'starting'

    control!.ack('turn-old-owner')
    expect(await draining).toBe('preserved')

    expect(session.proc).toBe(proc)
    expect(session.currentTurn).toBe(replacementTurn)
    expect(session.status).toBe('starting')
    expect(session.pendingMidTurnMsgs).toEqual(batch)
    expect(session.pendingReactionIds).toEqual(new Map([
      ['om_first_human', 'reaction-first-human'],
      ['om_second_human', 'reaction-second-human'],
    ]))
  })

  test('an ACK after opening owner replacement cannot commit the old delivery', async () => {
    const { session, batch, control } = pendingHumanDrainFixture('codex')
    const draining = session.drainMidTurnAndOpen()
    await control!.started
    const replacementOpening = session.beginTurnOpening()
    session.status = 'starting'

    control!.ack('turn-old-owner')
    expect(await draining).toBe('preserved')

    expect(session.openingTurn).toBe(true)
    expect(session.openingTurnOwner).toBe(replacementOpening)
    expect(session.status).toBe('starting')
    expect(session.pendingMidTurnMsgs).toEqual(batch)
    session.finishTurnOpening(replacementOpening)
  })

  test('a second pre-init Codex message queues while the first receipt is pending', async () => {
    const session = new Session('pending-human-overlap', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-overlap')
    const control = controlCodexDispatch(proc)
    session.selectedProvider = 'codex'
    session.proc = proc
    session.status = 'starting'
    session.wireProc(proc)
    let firstDone = false
    const first = session.onUserMessage('first overlap', [], 'ou_first', 'om_first')
      .then(() => { firstDone = true })
    await control.started

    const second = session.onUserMessage('second overlap', ['/tmp/second.txt'], 'ou_second', 'om_second')
    await Promise.resolve()
    expect(firstDone).toBe(false)
    expect(proc.sentTexts).toEqual(['first overlap'])
    expect(session.pendingMidTurnMsgs).toEqual([{
      text: 'second overlap',
      wireText: '[file: /tmp/second.txt]\nsecond overlap',
      userOpenId: 'ou_second',
      msgId: 'om_second',
    }])

    control.ack('turn-overlap')
    await first
    await second
  })

  test('a delayed reaction ID stays owned by the pending delivery', async () => {
    const { session, control } = pendingHumanDrainFixture('codex')
    session.pendingReactionIds.set('om_first_human', '')
    session.trackQueuedReaction('om_first_human')
    const draining = session.drainMidTurnAndOpen()
    await control!.started
    await Promise.resolve()

    expect(session.pendingHumanDelivery?.reactions.get('om_first_human'))
      .toBe('reaction-om_first_human')
    expect(session.currentBatchReactionIds.has('om_first_human')).toBe(false)

    control!.reject(new Error('reaction fixture rejected'))
    expect(await draining).toBe('preserved')
  })

  test('cold-start Codex input commits only after its receipt ACK', async () => {
    const session = new Session('pending-human-cold-start', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-cold-start')
    const control = controlCodexDispatch(proc)
    session.selectedProvider = 'codex'
    session.start = async () => {
      session.proc = proc
      session.status = 'idle'
      session.wireProc(proc)
      return true
    }
    let finished = false
    const sending = session.onUserMessage(
      'cold input', ['/tmp/cold.png'], 'ou_cold', 'om_cold',
    ).then(() => { finished = true })
    await control.started
    await Promise.resolve()

    expect(finished).toBe(false)
    expect(session.pendingUserMessageCount).toBe(0)
    expect(session.pendingHumanDelivery?.batch).toEqual([{
      text: 'cold input',
      wireText: '[file: /tmp/cold.png]\ncold input',
      userOpenId: 'ou_cold',
      msgId: 'om_cold',
    }])

    control.ack('turn-cold')
    await sending
    expect(session.pendingUserMessageCount).toBe(1)
  })

  test('idle eager-open Codex input commits only after its receipt ACK', async () => {
    const session = new Session('pending-human-idle-eager', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-idle-eager')
    const control = controlCodexDispatch(proc)
    session.selectedProvider = 'codex'
    session.proc = proc
    session.status = 'idle'
    session.initCount = 1
    session.wireProc(proc)
    let finished = false
    const sending = session.onUserMessage('idle eager', [], 'ou_eager', 'om_eager')
      .then(() => { finished = true })
    await control.started
    await Promise.resolve()

    expect(finished).toBe(false)
    expect(session.pendingUserMessageCount).toBe(0)
    expect(session.pendingHumanDelivery?.turn).toBe(session.currentTurn)

    control.ack('turn-eager')
    await sending
    expect(session.pendingUserMessageCount).toBe(1)
  })

  test('cold-start receipt settlement cannot clear a replacement opening owner', async () => {
    const session = new Session('pending-human-cold-owner-replaced', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-cold-owner-replaced')
    const control = controlCodexDispatch(proc)
    session.selectedProvider = 'codex'
    session.start = async () => {
      session.proc = proc
      session.wireProc(proc)
      return true
    }
    const sending = session.onUserMessage('old cold owner', [], 'ou_old', 'om_old')
    await control.started
    const replacement = new FakeAgentProc('codex', 'thread-cold-replacement')
    const replacementTurn = turnState('card_cold_replacement')
    session.proc = replacement
    session.currentTurn = replacementTurn
    session.beginTurnOpening()
    session.status = 'starting'

    control.ack('turn-old-cold')
    await sending

    expect(session.proc).toBe(replacement)
    expect(session.currentTurn).toBe(replacementTurn)
    expect(session.openingTurn).toBe(true)
    expect(session.status).toBe('starting')
  })

  test('idle eager receipt settlement cannot clear a replacement opening owner', async () => {
    const session = new Session('pending-human-eager-owner-replaced', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-eager-owner-replaced')
    const control = controlCodexDispatch(proc)
    session.selectedProvider = 'codex'
    session.proc = proc
    session.status = 'idle'
    session.initCount = 1
    session.wireProc(proc)
    const sending = session.onUserMessage('old eager owner', [], 'ou_old', 'om_old')
    await control.started
    const replacement = new FakeAgentProc('codex', 'thread-eager-replacement')
    const replacementTurn = turnState('card_eager_replacement')
    session.proc = replacement
    session.currentTurn = replacementTurn
    session.beginTurnOpening()
    session.status = 'starting'

    control.ack('turn-old-eager')
    await sending

    expect(session.proc).toBe(replacement)
    expect(session.currentTurn).toBe(replacementTurn)
    expect(session.openingTurn).toBe(true)
    expect(session.status).toBe('starting')
  })

  test('pre-init bootstrap ACK commits before a card exists and later binds that card', async () => {
    const session = new Session('pending-human-bootstrap-ack', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-bootstrap-ack')
    const control = controlCodexDispatch(proc)
    session.selectedProvider = 'codex'
    session.proc = proc
    session.status = 'starting'
    session.wireProc(proc)
    const sending = session.onUserMessage('bootstrap input', [], 'ou_boot', 'om_boot')
    await control.started
    expect(session.currentTurn).toBeNull()
    expect(session.pendingHumanDelivery?.turn).toBeNull()

    control.ack('turn-bootstrap')
    await sending
    expect(session.pendingUserMessageCount).toBe(1)
    expect(session.currentTurn).toBeNull()

    proc.emit('init', { session_id: proc.sessionId })
    await waitFor(() => session.currentTurn !== null)
    expect(session.ackedHumanDelivery?.turn).toBe(session.currentTurn)
  })

  test('pre-init bootstrap exit restores the exact input before init', async () => {
    const session = new Session('pending-human-bootstrap-exit', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-bootstrap-exit')
    const control = controlCodexDispatch(proc)
    session.selectedProvider = 'codex'
    session.proc = proc
    session.status = 'starting'
    session.wireProc(proc)
    const sending = session.onUserMessage(
      'bootstrap exit', ['/tmp/bootstrap.txt'], 'ou_boot_exit', 'om_boot_exit',
    )
    await control.started

    proc.alive = false
    proc.emit('exit', { code: 1, signal: null, expected: false })
    control.reject(new Error('bootstrap exited'))
    await sending

    expect(session.pendingMidTurnMsgs).toEqual([{
      text: 'bootstrap exit',
      wireText: '[file: /tmp/bootstrap.txt]\nbootstrap exit',
      userOpenId: 'ou_boot_exit',
      msgId: 'om_boot_exit',
    }])
    expect(session.pendingUserMessageCount).toBe(0)
  })

  test('pre-init bootstrap card-open failure releases the ACKed delivery owner', async () => {
    const session = new Session('pending-human-bootstrap-open-failed', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-bootstrap-open-failed')
    const control = controlCodexDispatch(proc)
    session.selectedProvider = 'codex'
    session.proc = proc
    session.status = 'starting'
    session.wireProc(proc)
    const sending = session.onUserMessage('bootstrap open failure', [], 'ou_boot_fail', 'om_boot_fail')
    await control.started
    control.ack('turn-bootstrap-open-failed')
    await sending
    expect(session.ackedHumanDelivery).not.toBeNull()
    session.openTurnCard = async () => ({ kind: 'failed' })

    proc.emit('init', { session_id: proc.sessionId })
    await waitFor(() => session.openingTurn === false)

    expect(session.ackedHumanDelivery).toBeNull()
    expect(session.currentTurn).toBeNull()
    expect(session.status).toBe('idle')
  })

  test('a real pre-init bootstrap dispatch with an unbound thread is not synchronously rejected', async () => {
    const session = new Session('pending-human-bootstrap-preinit', 'chat_id') as any
    const proc = new FakeAgentProc('codex', null)
    const control = controlPreInitCodexDispatch(proc)
    session.selectedProvider = 'codex'
    session.proc = proc
    session.status = 'starting'
    session.wireProc(proc)
    let finished = false
    const sending = session.onUserMessage('preinit input', [], 'ou_pre', 'om_pre')
      .then(() => { finished = true })
    await control.started
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(finished).toBe(false)
    expect(session.pendingHumanDelivery).not.toBeNull()
    expect(session.pendingMidTurnMsgs).toEqual([])
    expect(session.pendingTurnInputs).toEqual(['preinit input'])

    proc.sessionId = 'thread-preinit'
    control.bind('thread-preinit')
    control.ack('turn-preinit')
    await sending
    expect(session.pendingUserMessageCount).toBe(1)
    expect(session.pendingMidTurnMsgs).toEqual([])
  })

  test('a synchronously rejected bootstrap dispatch rolls back its panel input', async () => {
    const session = new Session('pending-human-bootstrap-rollback', 'chat_id') as any
    const proc = new FakeAgentProc('codex', null)
    proc.dispatchFactory = () => ({
      kind: 'rejected',
      provider: 'codex',
      error: new Error('spawn failed'),
    })
    session.selectedProvider = 'codex'
    session.proc = proc
    session.status = 'starting'
    session.wireProc(proc)

    await session.onUserMessage('rollback input', [], 'ou_rb', 'om_rb')

    expect(session.pendingMidTurnMsgs).toEqual([{
      text: 'rollback input',
      wireText: 'rollback input',
      userOpenId: 'ou_rb',
      msgId: 'om_rb',
    }])
    expect(session.pendingTurnInputs).toEqual([])
  })

  test('bootstrap ACK after the init card opens commits without replay', async () => {
    const session = new Session('pending-human-bootstrap-late-ack', 'chat_id') as any
    const proc = new FakeAgentProc('codex', null)
    const control = controlPreInitCodexDispatch(proc)
    session.selectedProvider = 'codex'
    session.proc = proc
    session.status = 'starting'
    session.wireProc(proc)
    const sending = session.onUserMessage('late ack input', [], 'ou_late', 'om_late')
    await control.started

    proc.sessionId = 'thread-late-ack'
    control.bind('thread-late-ack')
    proc.emit('init', { session_id: 'thread-late-ack' })
    await waitFor(() => session.currentTurn !== null && session.openingTurn === false)
    expect(session.pendingHumanDelivery?.turn).toBe(session.currentTurn)

    control.ack('turn-late-ack')
    await sending

    expect(session.pendingHumanDelivery).toBeNull()
    expect(session.ackedHumanDelivery?.turn).toBe(session.currentTurn)
    expect(session.pendingMidTurnMsgs).toEqual([])
    expect(session.pendingUserMessageCount).toBe(1)
    expect(session.status).toBe('working')
    expect(proc.sentTexts).toEqual(['late ack input'])
  })

  test('a turn/completed result after the init card opens settles the bootstrap turn', async () => {
    const session = new Session('pending-human-bootstrap-result-first', 'chat_id') as any
    const proc = new FakeAgentProc('codex', null)
    const control = controlPreInitCodexDispatch(proc)
    session.selectedProvider = 'codex'
    session.proc = proc
    session.status = 'starting'
    session.wireProc(proc)
    const sending = session.onUserMessage('result first input', [], 'ou_rf', 'om_rf')
    await control.started

    proc.sessionId = 'thread-result-first'
    control.bind('thread-result-first')
    proc.emit('init', { session_id: 'thread-result-first' })
    await waitFor(() => session.currentTurn !== null && session.openingTurn === false)

    proc.lastResult.subtype = 'success'
    proc.emit('result', {
      subtype: 'success',
      is_error: false,
      delivery_id: control.dispatch.deliveryId,
      thread_id: 'thread-result-first',
      turn_id: 'turn-result-first',
    })
    control.ack('turn-result-first')
    await sending
    await waitFor(() => session.currentTurn === null)

    expect(session.status).toBe('idle')
    expect(session.pendingMidTurnMsgs).toEqual([])
    expect(session.ackedHumanDelivery).toBeNull()
    expect(proc.sentTexts).toEqual(['result first input'])
  })

  test('process exit with a preserved delivery clears zombie asks and permissions', async () => {
    const { session, proc, control } = pendingHumanDrainFixture('codex')
    const draining = session.drainMidTurnAndOpen()
    await control!.started
    session.pendingAsks.set('ask-zombie', { toolUseId: 'ask-zombie' })
    session.pendingHostAsks.set('hask-zombie', { requestId: 'hask-zombie' })
    session.pendingPermissions.set('perm-zombie', { requestId: 'perm-zombie' })
    session.currentBatchReactionIds.set('om_stale_batch', 'reaction-stale-batch')

    proc.alive = false
    proc.emit('exit', { code: 1, signal: null, expected: false })
    control!.reject(new Error('exited'))
    expect(await draining).toBe('preserved')

    expect(session.pendingAsks.size).toBe(0)
    expect(session.pendingHostAsks.size).toBe(0)
    expect(session.pendingPermissions.size).toBe(0)
    expect(session.pendingMidTurnMsgs).toHaveLength(2)
    // 残留的当轮批次 ⏳ 必须删除而非静默丢弃 —— 否则用户消息上的
    // 沙漏永远挂着(与普通 exit 路径的 delete-before-reset 对齐)。
    expect(session.currentBatchReactionIds.size).toBe(0)
    expect(deletedReactions).toContainEqual(['om_stale_batch', 'reaction-stale-batch'])
  })

  test('a message during a pending bootstrap delivery queues instead of eager-opening', async () => {
    const session = new Session('pending-human-eager-gate', 'chat_id') as any
    const proc = new FakeAgentProc('codex', null)
    const control = controlPreInitCodexDispatch(proc)
    session.selectedProvider = 'codex'
    session.proc = proc
    session.status = 'starting'
    session.wireProc(proc)
    const first = session.onUserMessage('first preinit', [], 'ou_first_gate', 'om_first_gate')
    await control.started

    session.openTurnCard = async () => ({ kind: 'failed' })
    proc.sessionId = 'thread-eager-gate'
    control.bind('thread-eager-gate')
    proc.emit('init', { session_id: 'thread-eager-gate' })
    await waitFor(() => session.initCount >= 1 && session.openingTurn === false)

    const second = session.onUserMessage('second while pending', [], 'ou_second_gate', 'om_second_gate')
    await Promise.resolve()
    await Promise.resolve()

    expect(session.pendingMidTurnMsgs).toEqual([{
      text: 'second while pending',
      wireText: 'second while pending',
      userOpenId: 'ou_second_gate',
      msgId: 'om_second_gate',
    }])
    expect(proc.sentTexts).toEqual(['first preinit'])
    expect(session.pendingTurnInputs).toEqual(['first preinit'])

    control.ack('turn-eager-gate')
    await first
    await second
  })

  test('Claude synchronous queued dispatch commits the drained batch', async () => {
    const { session, proc } = pendingHumanDrainFixture('claude')

    expect(await session.drainMidTurnAndOpen()).toBe('committed')
    const capturedTurn = session.currentTurn
    expect(proc.sentTexts).toHaveLength(1)
    expect(session.pendingMidTurnMsgs).toEqual([])
    expect(session.pendingUserMessageCount).toBe(1)
    expect(session.ackedHumanDelivery?.turn).toBe(capturedTurn)

    proc.emit('result', {})

    expect(session.ackedHumanDelivery).toBeNull()
    expect(session.currentTurn).toBeNull()
    expect(session.status).toBe('idle')
  })

  test('a stale Claude result cannot close a replacement turn or release its captured owner', async () => {
    const { session, proc } = pendingHumanDrainFixture('claude')
    expect(await session.drainMidTurnAndOpen()).toBe('committed')
    const capturedOwner = session.ackedHumanDelivery
    const replacementTurn = turnState('card_claude_replacement')
    session.currentTurn = replacementTurn
    session.status = 'starting'

    proc.emit('result', {})

    expect(session.ackedHumanDelivery).toBe(capturedOwner)
    expect(session.currentTurn).toBe(replacementTurn)
    expect(session.status).toBe('starting')
  })

  test('Claude synchronous rejection restores the drained batch without committing', async () => {
    const { session, proc, batch } = pendingHumanDrainFixture('claude')
    proc.dispatchFactory = () => ({
      kind: 'rejected',
      provider: 'claude',
      error: new Error('claude input closed'),
    })

    expect(await session.drainMidTurnAndOpen()).toBe('preserved')
    expect(session.pendingMidTurnMsgs).toEqual(batch)
    expect(session.pendingUserMessageCount).toBe(0)
  })
})

describe('Session system-owned Codex dispatch receipts', () => {
  test('host continuation rejects synchronously without claiming a started turn', async () => {
    const session = new Session('host-continuation-sync-rejected', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-host-sync-rejected')
    session.selectedProvider = 'codex'
    session.proc = proc
    session.status = 'idle'
    session.wireProc(proc)
    proc.dispatchFactory = () => ({
      kind: 'rejected',
      provider: 'codex',
      error: new Error('host continuation rejected'),
    })

    expect(await session.startHostAskContinuation('continue host ask', proc)).toBe('failed')
    expect(session.pendingUserMessageCount).toBe(0)
    expect(session.currentTurn).toBeNull()
    expect(session.status).toBe('idle')
  })

  test('host continuation waits for its Codex receipt before reporting started', async () => {
    const session = new Session('host-continuation-receipt-rejected', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-host-receipt-rejected')
    const control = controlCodexDispatch(proc)
    session.selectedProvider = 'codex'
    session.proc = proc
    session.status = 'idle'
    session.wireProc(proc)
    let finished = false
    const continuation = session.startHostAskContinuation('continue host ask', proc)
      .then((outcome: string) => {
        finished = true
        return outcome
      })
    await control.started
    await Promise.resolve()
    expect(finished).toBe(false)

    control.reject(new Error('host receipt rejected'))
    expect(await continuation).toBe('failed')
    expect(session.currentTurn).toBeNull()
    expect(session.pendingUserMessageCount).toBe(0)
  })

  test('host continuation becomes stale when its turn owner changes before ACK', async () => {
    const session = new Session('host-continuation-owner-replaced', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-host-owner-replaced')
    const control = controlCodexDispatch(proc)
    session.selectedProvider = 'codex'
    session.proc = proc
    session.status = 'idle'
    session.wireProc(proc)

    const continuation = session.startHostAskContinuation('continue host ask', proc)
    await control.started
    const replacementTurn = turnState('card_host_owner_replacement')
    session.currentTurn = replacementTurn
    session.status = 'starting'

    control.ack('turn-old-host-continuation')

    expect(await continuation).toBe('stale')
    expect(session.currentTurn).toBe(replacementTurn)
    expect(session.pendingUserMessageCount).toBe(0)
    expect(session.status).toBe('starting')
  })
})

function deferCardSettingsPatch(cardId: string): {
  entered: Promise<void>
  release: () => void
  restore: () => void
} {
  const entered = deferred<void>()
  const release = deferred<void>()
  const passthroughFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (
      String(init?.method ?? 'GET') === 'PATCH' &&
      url.pathname.endsWith(`/cards/${cardId}/settings`)
    ) {
      entered.resolve()
      await release.promise
    }
    return await passthroughFetch(input, init)
  }) as typeof fetch
  return {
    entered: entered.promise,
    release: () => release.resolve(),
    restore: () => {
      release.resolve()
      globalThis.fetch = passthroughFetch
    },
  }
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
  session.clearTurnOpening()
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
      thread_id: 'thread-1',
      turn_id: 'codex-turn-1',
    })

    expect(session.watchdogContext).toMatchObject({
      proc,
      turn,
      threadId: 'thread-1',
      turnId: 'codex-turn-1',
    })
    expect(turn.backendThreadId).toBe('thread-1')
    expect(turn.backendTurnId).toBe('codex-turn-1')
    expect(session.watchdogSafetySnapshot(session.watchdogContext).currentTurn).toBe(true)
  })

  test('a mismatched second turn_started cannot rewrite a bound recovery identity', () => {
    const { session, proc, turn } = wiredWatchdogSession()
    proc.emit('turn_started', {
      thread_id: 'thread-1',
      turn_id: 'codex-turn-bound',
    })
    const context = session.watchdogContext

    proc.emit('turn_started', {
      thread_id: 'thread-1',
      turn_id: 'codex-turn-conflict',
    })

    expect(session.watchdogContext).toBe(context)
    expect(context).toMatchObject({
      threadId: 'thread-1',
      turnId: 'codex-turn-bound',
      identityConflict: true,
    })
    expect(turn.backendThreadId).toBe('thread-1')
    expect(turn.backendTurnId).toBe('codex-turn-bound')
    expect(session.watchdogSafetySnapshot(context).currentTurn).toBe(false)
  })

  test('a preserved recovery provider and thread identity are runtime immutable', () => {
    const { session } = armedRecoverySession()
    const transaction = session.beginWatchdogAction(
      session.watchdogContext,
      'watchdog-recovery',
    )
    const recovery = session.preserveWatchdogRecovery(transaction)

    expect(Reflect.set(recovery, 'provider', 'claude')).toBe(false)
    expect(Reflect.set(recovery, 'threadId', 'thread-rewritten')).toBe(false)
    expect(recovery).toMatchObject({ provider: 'codex', threadId: 'thread-1' })
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
    const openingToken = session.beginTurnOpening()
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
      session.finishTurnOpening(openingToken)
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
    const openingToken = session.beginTurnOpening()
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
    session.finishTurnOpening(openingToken)

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
      return {
        kind: 'turn_start_pending',
        provider: 'codex',
        deliveryId: 'cold-order-delivery',
        threadId: 'codex-thread-cold',
        settlement: Promise.resolve({
          kind: 'ack',
          deliveryId: 'cold-order-delivery',
          threadId: 'codex-thread-cold',
          turnId: null,
        }),
      }
    }

    try {
      await session.startColdUserTurn('hello', 'hello', 'ou_user', '')

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
    expect(turn.backendThreadId).toBe('thread-1')
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
      session.clearTurnOpening()
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
      const nextOpeningToken = session.beginTurnOpening()
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
      session.finishTurnOpening(nextOpeningToken)
    } finally {
      feishuMockState.sendCard = null
      session.clearTurnOpening()
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
      session.clearTurnOpening()
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

  test('restores a drained batch ahead of later messages when card opening loses ownership', async () => {
    projectProfiles.set('watchdog-stale-drain-caller', { watchdogMode: 'warn' })
    const session = new Session('watchdog-stale-drain-caller', 'chat_id') as any
    const oldProc = new FakeAgentProc('codex', 'codex-thread-stale-drain-caller')
    const sendStarted = deferred<void>()
    const sendResult = deferred<string | null>()
    const capturedBatch = [
      {
        text: 'first queued prompt',
        wireText: '[file: /tmp/first.png]\nfirst queued prompt',
        userOpenId: 'ou_first',
        msgId: 'om_stale_drain_first',
      },
      {
        text: 'second queued prompt',
        wireText: '[file: /tmp/second-a.txt] [file: /tmp/second-b.txt]\nsecond queued prompt',
        userOpenId: 'ou_second',
        msgId: 'om_stale_drain_second',
      },
    ]
    const laterMessage = {
      text: 'later queued prompt',
      wireText: '[file: /tmp/later.txt]\nlater queued prompt',
      userOpenId: 'ou_later',
      msgId: 'om_stale_drain_later',
    }
    session.selectedProvider = 'codex'
    session.proc = oldProc
    session.pendingMidTurnMsgs = capturedBatch
    session.pendingReactionIds = new Map([
      ['om_stale_drain_first', 'reaction_stale_drain_first'],
      ['om_stale_drain_second', 'reaction_stale_drain_second'],
    ])
    session.wireProc(oldProc)
    feishuMockState.sendCard = async () => {
      sendStarted.resolve()
      return await sendResult.promise
    }

    try {
      const staleDrain = session.drainMidTurnAndOpen()
      await sendStarted.promise
      session.pendingMidTurnMsgs.push(laterMessage)
      session.pendingReactionIds.set('om_stale_drain_second', 'reaction_newer_second_owner')
      session.pendingReactionIds.set('om_stale_drain_later', 'reaction_stale_drain_later')
      const { nextProc, nextTurn } = replaceOpenProcess(session, 'drain-caller')
      session.currentBatchReactionIds.set('om_replacement_turn', 'reaction_replacement_turn')

      sendResult.resolve('om_stale_drain_caller')
      expect(await staleDrain).toBe('preserved')
      await Promise.resolve()

      expect(session.currentTurn).toBe(nextTurn)
      expect(oldProc.sentTexts).toEqual([])
      expect(nextProc.sentTexts).toEqual([])
      expect(session.pendingUserMessageCount).toBe(0)
      expect(session.status).toBe('starting')
      expectStaleCardClosed('card_status_1')
      expect(session.pendingMidTurnMsgs).toEqual([...capturedBatch, laterMessage])
      expect(session.pendingReactionIds).toEqual(new Map([
        ['om_stale_drain_second', 'reaction_newer_second_owner'],
        ['om_stale_drain_later', 'reaction_stale_drain_later'],
        ['om_stale_drain_first', 'reaction_stale_drain_first'],
      ]))
      expect(session.currentBatchReactionIds).toEqual(new Map([
        ['om_replacement_turn', 'reaction_replacement_turn'],
      ]))
      expect(deletedReactions).toEqual([])
    } finally {
      feishuMockState.sendCard = null
      session.clearTurnOpening()
      session.stopFooterStatus(session.currentTurn)
    }
  })

  test('does not send a drained prompt when its turn card fails to open', async () => {
    projectProfiles.set('watchdog-failed-drain-caller', { watchdogMode: 'warn' })
    const session = new Session('watchdog-failed-drain-caller', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-thread-failed-drain-caller')
    session.selectedProvider = 'codex'
    session.proc = proc
    const failedMessage = {
      text: 'failed drain prompt',
      wireText: '[file: /tmp/failed-drain.txt]\nfailed drain prompt',
      userOpenId: 'ou_old',
      msgId: 'om_failed_drain_reaction',
    }
    session.pendingMidTurnMsgs = [failedMessage]
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
      expect(await session.drainMidTurnAndOpen()).toBe('preserved')

      expect(proc.sentTexts).toEqual([])
      expect(session.pendingUserMessageCount).toBe(0)
      expect(session.currentTurn).toBeNull()
      expect(session.status).toBe(statusBefore)
      expect(session.pendingMidTurnMsgs).toEqual([failedMessage])
      expect(deletedReactions).toEqual([])
      expect(session.pendingReactionIds).toEqual(new Map([
        ['om_failed_drain_reaction', 'reaction_failed_drain'],
        ['om_unrelated_pending', 'reaction_unrelated_pending'],
      ]))
      expect(session.currentBatchReactionIds).toEqual(new Map([
        ['om_unrelated_batch', 'reaction_unrelated_batch'],
      ]))
    } finally {
      feishuMockState.sendCard = null
      session.clearTurnOpening()
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
      session.clearTurnOpening()
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
      session.clearTurnOpening()
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

    const modelLease = session.beginLifecycle('model')
    const modelSwitch = session.beginModelSwitch(modelLease)
    expect(modelSwitch).not.toBeNull()
    expect(session.watchdogSafetySnapshot(context).modelSwitchPending).toBe(true)
    session.finishModelSwitch(modelSwitch)
    expect(session.beginWatchdogAction(context, 'watchdog-recovery')).not.toBeNull()
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

  test('model selection rejects an existing preserved recovery before applying settings', async () => {
    const session = new Session('watchdog-model-preserved-before', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-model-preserved-before')
    session.selectedProvider = 'codex'
    session.selectedModel = null
    session.proc = proc
    installFailedWatchdogRecovery(session, {
      proc,
      threadId: 'thread-model-preserved-before',
    })

    const result = await session.onModelEffortSelect(
      'gpt-5.6-sol', 'ultra', '', 'ou_user', 'codex',
    )

    expect(result.ok).toBe(false)
    expect(result.message).toContain('自动恢复')
    expect(proc.setModelSettingsCalls).toEqual([])
    expect(session.selectedModel).toBeNull()
  })

  test('model selection rechecks preserved recovery after awaited settings', async () => {
    const session = new Session('watchdog-model-preserved-after', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-model-preserved-after')
    const settingsEntered = deferred<void>()
    const settingsRelease = deferred<void>()
    let applyCalls = 0
    session.selectedProvider = 'codex'
    session.proc = proc
    proc.setModelSettings = async () => {
      settingsEntered.resolve()
      await settingsRelease.promise
    }
    session.applyModelSelection = async () => { applyCalls++ }

    const selecting = session.onModelEffortSelect(
      'gpt-5.6-sol', 'ultra', '', 'ou_user', 'codex',
    )
    await settingsEntered.promise
    installFailedWatchdogRecovery(session, {
      proc,
      threadId: 'thread-model-preserved-after',
    })
    settingsRelease.resolve()
    const result = await selecting

    expect(result.ok).toBe(false)
    expect(result.message).toContain('自动恢复')
    expect(applyCalls).toBe(0)
  })

  test('a stale model selection cannot apply or clear a newer pending token', async () => {
    const session = new Session('watchdog-model-token-race', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-model-token-race')
    const firstEntered = deferred<void>()
    const firstRelease = deferred<void>()
    const secondEntered = deferred<void>()
    const secondRelease = deferred<void>()
    const applied: string[] = []
    let settingsCalls = 0
    session.selectedProvider = 'codex'
    session.proc = proc
    proc.setModelSettings = async () => {
      settingsCalls++
      if (settingsCalls === 1) {
        firstEntered.resolve()
        await firstRelease.promise
      } else {
        secondEntered.resolve()
        await secondRelease.promise
      }
    }
    session.applyModelSelection = async (_provider: string, model: string) => {
      applied.push(model)
    }

    const first = session.onModelEffortSelect(
      'gpt-5.6-sol', 'ultra', '', 'ou_first', 'codex',
    )
    await firstEntered.promise
    const second = session.onModelEffortSelect(
      'gpt-5.6-sol', 'ultra', '', 'ou_second', 'codex',
    )
    await secondEntered.promise
    firstRelease.resolve()
    const firstResult = await first

    expect(firstResult.ok).toBe(false)
    expect(applied).toEqual([])
    expect(session.modelSwitchPending).toBe(true)

    secondRelease.resolve()
    const secondResult = await second
    expect(secondResult.ok).toBe(true)
    expect(applied).toEqual(['gpt-5.6-sol'])
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

describe('Session preserved recovery guards for rollback and history selection', () => {
  test('startForked rejects preserved recovery before changing lifecycle or action ownership', async () => {
    const { session, action, recovery } = ownedFailedWatchdogRecoverySession()
    const lifecycleEpoch = session.lifecycleEpoch
    const lifecycleOwner = session.lifecycleOwner
    let spawnCalls = 0
    session.spawnAgent = () => {
      spawnCalls++
      return new FakeAgentProc('codex', 'forked-thread')
    }

    const started = await session.startForked('history-thread', 'assistant-anchor')

    expect(started).toBe(false)
    expect(spawnCalls).toBe(0)
    expect(session.lifecycleEpoch).toBe(lifecycleEpoch)
    expect(session.lifecycleOwner).toBe(lifecycleOwner)
    expect(session.preservedWatchdogRecovery).toBe(recovery)
    expect(recovery.phase).toBe('failed')
    expect(session.watchdogAction).toBe(action)
    expect(session.ownsWatchdogAction(action)).toBe(true)
  })

  for (const [label, action] of [
    ['model panel', async (session: any) => { await session.showModelPanel() }],
    ['model selection', async (session: any) => {
      await session.onModelSelect('gpt-5.6-sol', '', '', { provider: 'codex' })
    }],
    ['back command', async (session: any) => { await session.runCommand('bk') }],
    ['back selection', async (session: any) => { await session.onBackSelect(0) }],
    ['resume selection', async (session: any) => { await session.onResumeSelect('history-thread') }],
    ['rollback', async (session: any) => { await session.rollbackTo('history-thread', undefined) }],
  ] as const) {
    test(`${label} rejection does not supersede an active preserved recovery`, async () => {
      const session = new Session(`preserved-guard-${label.replaceAll(' ', '-')}`, 'chat_id') as any
      session.selectedProvider = 'codex'
      const recovery = installFailedWatchdogRecovery(session)
      recovery.phase = 'recovering'
      const lifecycleOwner = session.lifecycleOwner

      await action(session)

      expect(session.lifecycleOwner).toBe(lifecycleOwner)
      expect(session.preservedWatchdogRecovery).toBe(recovery)
      expect(recovery.phase).toBe('recovering')
    })
  }

  test('rollbackTo rejects preserved recovery before changing its target identity', async () => {
    const session = new Session('rollback-preserved-before', 'chat_id') as any
    session.selectedProvider = 'claude'
    session.lastSessionId = 'claude-original-thread'
    installFailedWatchdogRecovery(session)
    let restartCalls = 0
    session.restart = async () => { restartCalls++; return true }

    const ok = await session.rollbackTo('claude-new-thread', 'assistant-anchor')

    expect(ok).toBe(false)
    expect(restartCalls).toBe(0)
    expect(session.lastSessionId).toBe('claude-original-thread')
  })

  test('rollbackTo cannot commit after a newer preserved recovery wins during restart', async () => {
    const session = new Session('rollback-preserved-after', 'chat_id') as any
    const restartEntered = deferred<void>()
    const restartRelease = deferred<void>()
    session.selectedProvider = 'claude'
    session.lastSessionId = 'claude-original-thread'
    session.restart = async () => {
      restartEntered.resolve()
      await restartRelease.promise
      return true
    }

    const rollingBack = session.rollbackTo('claude-new-thread', 'assistant-anchor')
    await restartEntered.promise
    installFailedWatchdogRecovery(session)
    restartRelease.resolve()
    const ok = await rollingBack

    expect(ok).toBe(false)
    expect(session.lastSessionId).toBe('claude-original-thread')
  })

  test('back selection rejects preserved recovery before preliminary card work', async () => {
    const session = new Session('back-select-preserved', 'chat_id') as any
    session.selectedProvider = 'claude'
    installFailedWatchdogRecovery(session)
    let rollbackCalls = 0
    session.rollbackTo = async () => { rollbackCalls++; return true }

    await session.onBackSelect(0)

    expect(rollbackCalls).toBe(0)
    expect(sentTexts.at(-1)).toContain('自动恢复')
  })

  test('resume selection rejects preserved recovery before its preliminary message', async () => {
    const session = new Session('resume-select-preserved', 'chat_id') as any
    session.selectedProvider = 'claude'
    installFailedWatchdogRecovery(session)
    let rollbackCalls = 0
    session.rollbackTo = async () => { rollbackCalls++; return true }

    await session.onResumeSelect('claude-history-thread')

    expect(rollbackCalls).toBe(0)
    expect(sentTexts.at(-1)).toContain('自动恢复')
    expect(sentTexts.some(text => text.includes('在本群恢复会话'))).toBe(false)
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

    session.persistResumableSessionId(proc)

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
      // 模拟软停止:注册 user interrupt、封口卡片(currentTurn 置空)。
      session.beginTurnInterrupt('user')
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

  function installConcurrentBackgroundState(session: any, prefix: string): {
    tasks: any[]
    pending: any[]
    card: { messageId: string; cardId: string }
    details: Set<string>
    archive: Array<{ id: string; description: string }>
  } {
    const taskId = `${prefix}-completed`
    const pendingId = `${prefix}-pending`
    const tasks = [{
      ...makeRunningTask(taskId),
      type: 'subagent',
      subagentType: 'verifier',
      status: 'completed',
      endTime: Date.now(),
    }]
    const pending = [makeRunningTask(pendingId)]
    const card = { messageId: `om_bg_${prefix}`, cardId: `card_bg_${prefix}` }
    const details = new Set([taskId])
    const archive = [{ id: `${prefix}-archive`, description: `${prefix} archive` }]
    session.backgroundTasks = tasks
    session.pendingBgTasks = pending
    session.backgroundCard = card
    session.backgroundDetailAdded = details
    session.bgArchive = archive
    return { tasks, pending, card, details, archive }
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

  test('stop cleanup cannot clear background state installed by a newer lifecycle during old-card settlement', async () => {
    const session = new Session('background-stop-cleanup-race', 'chat_id') as any
    const oldProc = new FakeAgentProc('claude', 'old-background-session')
    const oldCardPatch = deferCardSettingsPatch('card_bg_old')
    session.proc = oldProc
    session.status = 'working'
    session.backgroundTasks = [{
      ...makeRunningTask('old-active'),
      type: 'subagent',
      subagentType: 'executor',
    }]
    session.pendingBgTasks = [makeRunningTask('old-pending')]
    session.backgroundCard = { messageId: 'om_bg_old', cardId: 'card_bg_old' }
    session.backgroundDetailAdded = new Set(['old-active'])
    session.bgArchive = [{ id: 'old-archive', description: 'old archive' }]
    cardkit.recordCardCreated('card_bg_old', 1)

    const stopping = session.stop('background cleanup race', { announce: false })
    try {
      await oldCardPatch.entered
      const newerLease = session.beginLifecycle('hi')
      const newerProc = new FakeAgentProc('claude', 'new-background-session')
      session.proc = newerProc
      session.status = 'working'
      const newer = installConcurrentBackgroundState(session, 'new')
      session.openingBackground = true

      oldCardPatch.release()
      await stopping

      expect(session.lifecycleOwner).toBe(newerLease)
      expect(session.proc).toBe(newerProc)
      expect(session.status).toBe('working')
      expect(session.backgroundTasks).toBe(newer.tasks)
      expect(session.backgroundTasks.map((task: any) => task.id)).toEqual(['new-completed'])
      expect(session.pendingBgTasks).toBe(newer.pending)
      expect(session.pendingBgTasks.map((task: any) => task.id)).toEqual(['new-pending'])
      expect(session.backgroundCard).toBe(newer.card)
      expect(session.backgroundDetailAdded).toBe(newer.details)
      expect(session.backgroundDetailAdded).toEqual(new Set(['new-completed']))
      expect(session.bgArchive).toBe(newer.archive)
      expect(session.bgArchive).toEqual([{ id: 'new-archive', description: 'new archive' }])
      expect(session.openingBackground).toBe(true)
    } finally {
      oldCardPatch.restore()
    }
  })

  test('natural old-card settlement cannot clear a concurrently installed background state', async () => {
    const session = new Session('background-natural-settle-race', 'chat_id') as any
    const oldCardPatch = deferCardSettingsPatch('card_bg_natural_old')
    session.backgroundTasks = [{
      ...makeRunningTask('old-completed'),
      type: 'subagent',
      subagentType: 'executor',
      status: 'completed',
      endTime: Date.now(),
    }]
    session.backgroundCard = { messageId: 'om_bg_natural_old', cardId: 'card_bg_natural_old' }
    session.backgroundDetailAdded = new Set(['old-completed'])
    session.bgArchive = [{ id: 'natural-old-archive', description: 'natural old archive' }]
    cardkit.recordCardCreated('card_bg_natural_old', 1)

    const settling = session.settleBackgroundCard()
    try {
      await oldCardPatch.entered
      const newer = installConcurrentBackgroundState(session, 'natural-new')

      oldCardPatch.release()
      await settling

      expect(session.backgroundTasks).toBe(newer.tasks)
      expect(session.backgroundTasks.map((task: any) => task.id)).toEqual(['natural-new-completed'])
      expect(session.pendingBgTasks).toBe(newer.pending)
      expect(session.pendingBgTasks.map((task: any) => task.id)).toEqual(['natural-new-pending'])
      expect(session.backgroundCard).toBe(newer.card)
      expect(session.backgroundDetailAdded).toBe(newer.details)
      expect(session.backgroundDetailAdded).toEqual(new Set(['natural-new-completed']))
      expect(session.bgArchive).toBe(newer.archive)
      expect(session.bgArchive).toEqual([{
        id: 'natural-new-archive',
        description: 'natural-new archive',
      }])
    } finally {
      oldCardPatch.restore()
    }
  })

  test('old-card settlement renders its captured killed tasks when flush overlaps newer background state', async () => {
    const session = new Session('background-captured-history-race', 'chat_id') as any
    const oldCardPatch = deferCardSettingsPatch('card_bg_captured_old')
    session.backgroundTasks = [{
      ...makeRunningTask('captured-old-active'),
      type: 'subagent',
      subagentType: 'executor',
    }]
    session.backgroundCard = {
      messageId: 'om_bg_captured_old',
      cardId: 'card_bg_captured_old',
    }
    session.backgroundDetailAdded = new Set(['captured-old-active'])
    cardkit.recordCardCreated('card_bg_captured_old', 1)
    const queuedPatch = cardkit.patchSettings('card_bg_captured_old', { config: {} })

    try {
      await oldCardPatch.entered
      const resetting = session.resetBackgroundTasks()
      const newer = installConcurrentBackgroundState(session, 'render-new')
      oldCardPatch.release()
      await queuedPatch
      await resetting

      const historyCard = updatedCards.find(([messageId]) => (
        messageId === 'om_bg_captured_old'
      ))?.[1]
      expect(JSON.stringify(historyCard)).toContain('captured-old-active')
      expect(JSON.stringify(historyCard)).not.toContain('render-new-completed')
      expect(session.backgroundTasks).toBe(newer.tasks)
      expect(session.backgroundCard).toBe(newer.card)
    } finally {
      oldCardPatch.restore()
    }
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
