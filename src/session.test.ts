import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { writeJsonStateAtomic } from './state-store'
import {
  DEFAULT_CODEX_WATCHDOG,
  TurnWatchdog,
  type WatchdogSettings,
} from './turn-watchdog'
import { fileDeliveryAgentContext } from './instructions'
import { FileDeliveryBatch } from './file-delivery'
import { GroupFileDelivery } from './group-file-delivery'
import type { FileDeliverySnapshot } from './file-delivery-types'
import {
  NothingToCompactError,
  type AgentTurnRetry,
  type CodexUserTextSettlement,
  type UserTextDispatch,
} from './agent-process'
import { CodexProcess, CodexRpcResponseError } from './codex-process'
import {
  addedReactions, boundResumes, branchBaseBySession, clearedResumes, clearedTurnAnchors, deletedReactions,
  feishuMockState, modelSelections, pendingConversationLaunchBySession, projectProfiles, resetFeishuMock,
  resumeRefs, seededTurnAnchors, sentCards, sentRawTexts, sentTexts,
  setResumeWriteError, setTurnAnchorWriteError, truncatedTurnAnchors, turnAnchorsBySession, updatedCards, urgentPushes,
  sentImages, uploadedImages, sentLocalFiles, setImageUploadHandler,
} from './feishu-test-mock'
import type { ConversationCheckpoint, ConversationRef } from './conversation'
import { resetAgentSessionRegistryForTest } from './agent-session-registry'

// 主 Session 现在也会构造 DshProcess(上游 722e45a),而 DSH 后端在构造期就 spawn
// 子进程(03-01):用例只验接线面,故像 agent-launch.test.ts 一样用替身顶掉,并让
// 历史列表的只读目录查询走假实现(每次查询自行 spawn/reap 的语义不变)。
const dshCatalogQueries: Array<{ method: string; params: any }> = []
let dshCatalogRows: any[] = []
mock.module('./dsh-process', () => ({
  DshProcess: class FakeDshProcess {
    readonly provider = 'dsh'
    readonly opts: any
    constructor(opts: any) { this.opts = opts }
  },
}))
const actualDshRuntime = await import('./dsh-runtime')
mock.module('./dsh-runtime', () => ({
  DshRuntime: actualDshRuntime.DshRuntime,
  queryDshRuntime: async (_opts: any, method: string, params: any = {}) => {
    dshCatalogQueries.push({ method, params })
    return dshCatalogRows
  },
}))

const {
  Session,
  WATCHDOG_RECOVERY_PROMPT,
  CAPACITY_RETRY_MAX_ATTEMPTS,
  isCodexCapacityError,
} = await import('./session')
const cardkit = await import('./cardkit')
const sessionWorktree = await import('./session-worktree')
const mathRender = await import('./math-render')
const sessionTools = await import('./session-tools')
const sessionHostAsk = await import('./session-host-ask')
const { ClaudeAgentProcess } = await import('./claude-agent-process')
const { FeishuRecoveryWindow } = await import('./feishu-retry')
const feishu = await import('./feishu')
const { groupFileDelivery } = await import('./file-delivery-runtime')
const { getTokenSource, listTokenSources, registerTokenSource, refreshAllTokenSourceModels, resetTokenSourceRegistry, tokenSourceProcessRevision } = await import('./token-source')
const { buildTokenSourcesFromConfig } = await import('./token-source-builtins')
const {
  fixedModelChoices,
  normalizeFixedModelSelection,
  normalizePersistedModelSelection,
  configuredDefaultSelection,
} = await import('./session-model')
const { config } = await import('./config')
const { peekUsage, updateUsageFromRateLimits, refreshUsageFromConnection, invalidateCodexUsage } = await import('./usage')

interface FetchCall {
  method: string
  path: string
  body: any
}

const originalFetch = globalThis.fetch
let calls: FetchCall[] = []
let failureNotificationWait: { mockRestore(): void }

beforeEach(() => {
  // These tests cover UI state and callbacks; the full recovery deadline is
  // exercised with a virtual clock in cardkit-retry.test.ts.
  failureNotificationWait = spyOn(FeishuRecoveryWindow.prototype, 'waitUntilDeadline').mockResolvedValue(undefined)
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

describe('Session delegated-agent capability', () => {
  test('API Codex starts without ChatGPT login and uses its own quota in the footer', async () => {
    const session = new Session('packy-api-start', 'chat_id') as any
    const source = {
      id: 'packy-api-test', kind: 'packy-api-test', agent: 'codex', display: 'Packy', enabled: true,
      models: [{ model: 'kimi-k3', display: 'Kimi', efforts: ['medium'], defaultEffort: 'medium' }],
      defaultModel: 'kimi-k3', modelCatalogState: { status: 'ready', updatedAt: 1 },
      codexApiProvider: { id: 'packy', name: 'Packy', baseUrl: 'https://cf.api.fan/v1', envKey: 'PACKY_KEY' },
      readUsage: async () => ({ state: 'ok', kind: 'quota', windows: [], quota: { remaining: 2, limit: 5, currency: 'USD' } }),
    }
    const proc = new FakeAgentProc('codex', 'packy-native-thread') as any
    proc.tokenSourceId = source.id
    proc.launchKind = 'fresh'
    proc.conversationResumable = false
    proc.initializationPromise = () => Promise.resolve()
    proc.sendInitialize = () => proc.emit('init', { session_id: proc.sessionId })
    proc.readRateLimits = () => { throw new Error('must not read subscription limits') }
    session.selectedProvider = 'codex'
    session.selectedTokenSourceId = source.id
    session.selectedModel = 'kimi-k3'
    session.selectedEffort = 'medium'
    session.currentTokenSource = () => source
    session.spawnAgent = () => proc
    Object.defineProperty(session, 'workDir', { value: process.cwd() })
    const auth = spyOn(feishu, 'isOpenAIChatGPTAuthenticated').mockImplementation(() => { throw new Error('must not check ChatGPT auth') })
    try {
      expect(await session.start({ announce: false })).toBe(true)
      expect(auth).not.toHaveBeenCalled()
      expect(session.peerSnapshot().codexAccountName).toBeUndefined()
      expect(await session.footerUsageSuffix('codex', proc, source.id, source, null, 'kimi-k3')).toBe('  |  额度 $2.00 / $5.00')
      expect(session.conversationRouting().codexAccountId).toBeUndefined()
      expect(session.conversationRouting().codexAccountAutomatic).toBeUndefined()
    } finally {
      auth.mockRestore()
      await session.stop('API source test complete', { announce: false })
    }
  })

  test('accepts only the live process capability and delegates cancellation', async () => {
    const cancellations: Array<[string, string]> = []
    const session = new Session('agent-capability', 'chat_id', {
      onCancelAgentRuns: async (name: string, _chatId: string, reason: string) => { cancellations.push([name, reason]) },
    }) as any
    session.proc = { isAlive: () => true }
    session.agentCapability = 'secret-capability'

    expect(session.acceptsAgentCapability('secret-capability')).toBe(true)
    expect(session.acceptsAgentCapability('wrong')).toBe(false)
    session.proc = { isAlive: () => false }
    expect(session.acceptsAgentCapability('secret-capability')).toBe(false)

    await session.cancelAgentRuns('stop')
    expect(cancellations).toEqual([['agent-capability', 'stop']])
  })

  test('routes the global agents command to the identity panel', async () => {
    const session = new Session('agents-command', 'chat_id') as any
    let owner = ''
    session.showAgentIdentityPanel = async (userOpenId: string) => { owner = userOpenId }
    expect(await session.runCommand('agents', 'ou_owner')).toBe(true)
    expect(owner).toBe('ou_owner')
  })

  test('keeps the legacy no-source Codex effort delegated to config.toml', () => {
    const session = new Session('legacy-codex-effort', 'chat_id') as any
    session.selectedProvider = 'codex'
    session.selectedTokenSourceId = null
    session.currentTokenSource = () => undefined
    expect(session.effortForSpawn()).toBeUndefined()
  })
})

class FakeAgentProc extends EventEmitter {
  lastAssistantUuid = null
  lastModel: string | null = null
  lastEffort: string | null = null
  lastUsage: any = null
  lastTotalUsage: any = null
  lastResult: any = {
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
  /** codex materialization 门控(4185808-D):默认 true = 已确认落盘的进程,
   *  既有用例绑定行为不变;门控用例显式置 false 模拟未确认会话。 */
  conversationResumableState = true
  /** ConversationLaunch 面(ff44afb/4185808):三态 launchKind(默认 null =
   *  既有用例零行为差,init 分流只认显式 'fresh')+ codex checkpoint 采集字段。 */
  launchKind: 'fresh' | 'resume' | 'fork' | null | undefined = null
  lastCompletedTurnId: string | null = null
  /** 进程层容量退避快照(startFooterStatus 读它覆盖 footer,D-07):忠实替身
   *  由 emitTurnRetry 先落快照再 emit,与真实 CodexProcess.scheduleCapacityRetry
   *  的「先设置 this.turnRetry 再 emit('turn_retry')」顺序一致。 */
  turnRetry: AgentTurnRetry | null = null
  conversationResumable = true
  initialization: Promise<void> = Promise.resolve()
  materializationBarrier: Promise<void> | null = null

  /** 上游用例第三参传 tokenSourceId 字符串;本地 spawn 捕获用例传 opts 对象。 */
  readonly tokenSourceId: string | null
  constructor(
    readonly provider: 'codex' | 'claude' | 'dsh',
    public sessionId: string | null = null,
    /** 上游第三参 = tokenSourceId;本地 spawn 捕获暴露(ff44afb)第三参 = opts 对象。 */
    optsOrTokenSourceId: { launch?: unknown } | string | null = {},
  ) {
    super()
    this.opts = typeof optsOrTokenSourceId === 'string' || optsOrTokenSourceId === null ? {} : optsOrTokenSourceId
    this.tokenSourceId = typeof optsOrTokenSourceId === 'string' ? optsOrTokenSourceId : null
  }
  /** spawn 捕获暴露(ff44afb):监听 spawnAgent 侧翻译产物的用例经第三参喂入。 */
  readonly opts: { launch?: unknown } = {}

  isConversationResumable(): boolean {
    return this.conversationResumableState === true && this.conversationResumable
  }

  sendInitialize(): void {}

  initializationPromise(): Promise<void> {
    return this.initialization
  }

  conversationMaterializationBarrier(): Promise<void> | null {
    return this.materializationBarrier
  }

  sendUserText(text: string): UserTextDispatch {
    this.sentTexts.push(text)
    if (this.dispatchFactory) return this.dispatchFactory(text)
    if (this.provider === 'claude') return { kind: 'queued', provider: 'claude' }
    // DSH 与 claude 同属 fire-and-forget 投递:成功回执是 queued/dsh(03-01)。
    if (this.provider === 'dsh') return { kind: 'queued', provider: 'dsh' }
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
  async injectThreadItems(): Promise<void> {}
  sendHookResponse(requestId: string, output?: object): void {
    this.hookResponses.push([requestId, output])
  }

  isAlive(): boolean {
    return this.alive
  }

  emitTurnRetry(retry: AgentTurnRetry): void {
    this.turnRetry = retry
    this.emit('turn_retry', retry)
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
  async compactThread(): Promise<void> {}
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
  failureNotificationWait.mockRestore()
})

function turnState(
  cardId = 'card_session_turn',
  selection: Partial<{ provider: 'codex' | 'claude'; model: string | null; effort: string; usageSource: 'codex' | 'glm' | 'provider' | 'not_applicable' }> = {},
): any {
  return {
    cardId,
    provider: selection.provider ?? 'codex',
    model: selection.model === undefined ? 'gpt-5.6-sol' : selection.model,
    effort: selection.effort ?? 'max',
    usageSource: selection.usageSource ?? 'codex',
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
    contextCompactionCompleted: new Set(),
    contextCompactionCompleting: new Set(),
    contextCompactionEndOnly: new Map(),
    lastContextCompactionCompletedAt: 0,
    lastContextCompactionWasAnonymous: false,
    watchdogSeenCompactionPhases: new Set(),
    toolBatches: new Map(),
    openBatchI: null,
    taskCreateI: null,
    taskUpdateI: null,
    taskBoardResetThisTurn: false,
    taskLiveInserted: false,
    planLiveInserted: false,
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
    cardCapacityFailures: new Map(),
    cardWriteFailureNotices: new Set(),
    cardRotationFailed: false,
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

const DETERMINISTIC_FOOTER_HANDLE = -1 as unknown as ReturnType<typeof setTimeout>

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
  const turn = turnState(`card_${provider}_watchdog_${fixtureId}`, provider === 'claude'
    ? { provider: 'claude', model: 'claude:grokcc', effort: 'xhigh', usageSource: 'provider' }
    : { provider: 'codex' })
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

/** 从 panel 选择卡里按 preview 提取 {panelId, choiceId}(ff44afb opaque 形态;
 *  session-temp.test.ts pickerValue 同型)。 */
function pickerValueFromCard(card: any, preview: string): { panelId: string; choiceId: string } {
  for (const element of card?.body?.elements ?? []) {
    if (element?.tag !== 'column_set') continue
    const markdown = element.columns?.[0]?.elements?.[0]?.content
    if (!String(markdown ?? '').includes(preview)) continue
    const value = element.columns?.[1]?.elements?.[0]?.behaviors?.[0]?.value
    if (typeof value?.panel_id === 'string' && typeof value?.choice_id === 'string') {
      return { panelId: value.panel_id, choiceId: value.choice_id }
    }
  }
  throw new Error(`picker choice not found for preview: ${preview}`)
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

describe('Session repeated tool failure circuit breaker', () => {
  function emitFailedEdit(proc: FakeAgentProc, index: number): void {
    const id = `failed-edit-${index}`
    proc.emit('tool_use', {
      id,
      name: 'Edit',
      input: { file_path: '/tmp/a.ts', old_string: 'same', new_string: 'same' },
      parentToolUseId: null,
    })
    proc.emit('tool_result', {
      tool_use_id: id,
      content: 'No changes to make: old_string and new_string are exactly the same.',
      is_error: true,
      parentToolUseId: null,
    })
  }

  for (const provider of ['claude', 'codex'] as const) {
    test(`${provider} stops the turn on the third identical failure without replaying it`, async () => {
      const { session, proc, turn } = wiredWatchdogSession(provider)
      cardkit.recordCardCreated(turn.cardId, 1)
      proc.onInterrupt = () => proc.emit('result', {
        subtype: 'error_during_execution',
        is_error: true,
      })

      emitFailedEdit(proc, 1)
      emitFailedEdit(proc, 2)
      expect(proc.interruptCalls).toBe(0)

      emitFailedEdit(proc, 3)
      await waitFor(() => session.toolFailureLoopAction === null && session.currentTurn === null)

      expect(proc.interruptCalls).toBe(1)
      expect(proc.sentTexts).toEqual([])
      expect(session.status).toBe('idle')
      expect(JSON.stringify(calls)).toContain('Edit 连续 3 次相同失败')
    })
  }

  test('preserves and dispatches queued human input after stopping the failed turn', async () => {
    const { session, proc, turn } = wiredWatchdogSession('claude')
    cardkit.recordCardCreated(turn.cardId, 1)
    session.pendingMidTurnMsgs = [{
      text: 'use a different approach',
      wireText: 'use a different approach',
      userOpenId: 'ou_human',
      msgId: 'om_human',
    }]
    session.pendingReactionIds.set('om_human', 'reaction_human')
    proc.onInterrupt = () => proc.emit('result', {
      subtype: 'error_during_execution',
      is_error: true,
    })

    emitFailedEdit(proc, 1)
    emitFailedEdit(proc, 2)
    emitFailedEdit(proc, 3)
    await waitFor(() => proc.sentTexts.includes('use a different approach'))

    expect(proc.interruptCalls).toBe(1)
    expect(proc.sentTexts).toEqual(['use a different approach'])
    expect(proc.sentTexts).not.toContain(WATCHDOG_RECOVERY_PROMPT)
    expect(session.pendingMidTurnMsgs).toEqual([])
    expect(session.currentTurn).toMatchObject({ trigger: 'user_message', provider: 'claude' })
  })

  test('kills the captured process after the soft-interrupt grace timeout', async () => {
    const { session, proc, turn } = wiredWatchdogSession('claude')
    cardkit.recordCardCreated(turn.cardId, 1)
    session.waitForTurnSettlement = async () => ({ type: 'timeout' })
    session.pendingMidTurnMsgs = [{
      text: 'preserved after timeout',
      wireText: 'preserved after timeout',
      userOpenId: 'ou_timeout',
      msgId: 'om_timeout',
    }]

    emitFailedEdit(proc, 1)
    emitFailedEdit(proc, 2)
    emitFailedEdit(proc, 3)
    await waitFor(() => session.toolFailureLoopAction === null)

    expect(proc.interruptCalls).toBe(1)
    expect(proc.killCalls).toBe(1)
    expect(session.proc).toBeNull()
    expect(session.currentTurn).toBeNull()
    expect(session.status).toBe('stopped')
    expect(session.pendingMidTurnMsgs.map((message: any) => message.text)).toEqual([
      'preserved after timeout',
    ])
    expect(sentRawTexts).toContain(
      '⚠️ 工具失败循环已停止；排队消息仍保留，下一条普通消息会与它们一起投递。',
    )

    let coldBatch: any[] = []
    session.startColdUserTurn = async (...args: any[]) => { coldBatch = args[4] }
    await session.onUserMessage('next human message', [], 'ou_next', 'om_next')
    expect(coldBatch.map(message => message.text)).toEqual([
      'preserved after timeout',
      'next human message',
    ])
  })

  test('restores queued input when opening its follow-up card throws', async () => {
    const { session, proc, turn } = wiredWatchdogSession('claude')
    cardkit.recordCardCreated(turn.cardId, 1)
    session.pendingMidTurnMsgs = [{
      text: 'keep this input',
      wireText: 'keep this input',
      userOpenId: 'ou_keep',
      msgId: 'om_keep',
    }]
    proc.onInterrupt = () => proc.emit('result', {
      subtype: 'error_during_execution',
      is_error: true,
    })
    session.openTurnCard = async () => { throw new Error('card unavailable') }

    emitFailedEdit(proc, 1)
    emitFailedEdit(proc, 2)
    emitFailedEdit(proc, 3)
    await waitFor(() => session.toolFailureLoopAction === null)

    expect(session.pendingMidTurnMsgs.map((message: any) => message.text)).toEqual([
      'keep this input',
    ])
    expect(sentRawTexts).toContain(
      '⚠️ 工具失败循环已停止；排队消息仍保留，下一条普通消息会与它们一起投递。',
    )
  })

  test('queues human input that arrives after the failed card leaves the table', async () => {
    const { session, proc, turn } = wiredWatchdogSession('claude')
    cardkit.recordCardCreated(turn.cardId, 1)
    const closeEntered = deferred<void>()
    const closeRelease = deferred<void>()
    let coldStarts = 0
    let drains = 0
    session.closeTurnCard = async () => {
      session.currentTurn = null
      closeEntered.resolve()
      await closeRelease.promise
    }
    session.startColdUserTurn = async () => { coldStarts++ }
    session.drainMidTurnAndOpen = async () => {
      drains++
      session.pendingMidTurnMsgs = []
      session.status = 'working'
      return 'committed'
    }
    proc.onInterrupt = () => proc.emit('result', {
      subtype: 'error_during_execution',
      is_error: true,
    })

    emitFailedEdit(proc, 1)
    emitFailedEdit(proc, 2)
    emitFailedEdit(proc, 3)
    await closeEntered.promise
    await session.onUserMessage('arrived during close', [], 'ou_race', 'om_race')

    expect(coldStarts).toBe(0)
    expect(session.pendingMidTurnMsgs.map((message: any) => message.text)).toEqual([
      'arrived during close',
    ])
    closeRelease.resolve()
    await waitFor(() => session.toolFailureLoopAction === null)

    expect(drains).toBe(1)
    expect(session.status).toBe('working')
  })

  test('lets an explicit user stop take ownership without a second interrupt', async () => {
    const { session, proc, turn } = wiredWatchdogSession('claude')
    cardkit.recordCardCreated(turn.cardId, 1)

    emitFailedEdit(proc, 1)
    emitFailedEdit(proc, 2)
    emitFailedEdit(proc, 3)
    await waitFor(() => session.activeTurnInterrupt?.source === 'tool_failure_loop')

    await session.runCommand('st')
    expect(session.activeTurnInterrupt?.source).toBe('user')
    expect(proc.interruptCalls).toBe(1)
    expect(proc.killCalls).toBe(0)
    expect(session.currentTurn).toBeNull()

    proc.emit('result', { subtype: 'error_during_execution', is_error: true })
    await waitFor(() => session.toolFailureLoopAction === null)

    expect(session.status).toBe('idle')
    expect(JSON.stringify(calls)).toContain('🛑 打断')
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
    })) as unknown as typeof fetch

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
    session.spawnAgent = (resumeRef?: ConversationRef) => {
      expect(resumeRef?.sessionId).toBe('thread-1')
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
    // 合并调和(取舍):main 的事件版恢复网关(waitForProcResumeInit)已随上游
    // session 恢复优化退役,恢复失败改由 initialize 事务 promise 收口(与上游
    // 'confirmed no-rollout resume failure...' 用例同型注入)。本例语义不变:
    // init 失败 → 替换进程被杀,替换 exit 不得摧毁恢复捕获态。
    resumed.initialization = Promise.reject(new Error('resume init failed'))
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
    expect(stateAfterReplacementExit!.midTurn).toHaveLength(1)
    expect(stateAfterReplacementExit!.inputs).toEqual(['queued input during resume'])
    expect(stateAfterReplacementExit!.reactions).toEqual(new Map([
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
    // 合并调和(取舍):main 事件网关的时间文案 formatProcessExitDetail
    // ('process exited (code=…, signal=…, expected=…)') 已随 waitForProcResumeInit
    // 退役;恢复期 init 直接退出在真实进程层的形态 = 进程死亡 + initialize 事务
    // reject(app-server close 报错,codex-process.handleChildClose 的
    // 'codex app-server closed before thread/resume response')。用例语义不变:
    // 直接退出不得触发普通破坏性清理,失败详情必须上屏且不得出现 '[object
    // Object]';断言按新通道核对该 rejection 的 message。
    resumed.sendInitialize = () => {
      resumed.alive = false
      resumed.emit('exit', { code: 1, signal: null, expected: true })
      stateAfterReplacementExit = {
        turn: session.currentTurn,
        context: session.watchdogContext,
        midTurnCount: session.pendingMidTurnMsgs.length,
      }
      resumed.initialization = Promise.reject(
        new Error('codex app-server closed before thread/resume response (id=2)'),
      )
    }

    const ok = await session.restart(true, {
      announce: false,
      requireResumeSession: true,
      preserveCurrentTurn: true,
      preserveQueuedHumanWork: true,
      onStatus: (status: string) => statuses.push(status),
    })

    expect(ok).toBe(false)
    expect(stateAfterReplacementExit!).toEqual({ turn, context, midTurnCount: 1 })
    expect(session.currentTurn).toBe(turn)
    expect(session.watchdogContext).toBe(context)
    expect(session.pendingMidTurnMsgs).toHaveLength(1)
    expect(session.pendingReactionIds).toEqual(new Map([
      ['om_init_exit', 'reaction_init_exit'],
    ]))
    expect(statuses.at(-1)).toContain('codex app-server closed before thread/resume response (id=2)')
    expect(statuses.at(-1)).not.toContain('[object Object]')
  })

  test('real strict resume failure closes the old card and preserves queued human work', async () => {
    const { session, proc, turn } = armedRecoverySession({ interruptGraceMs: 1 })
    const resumed = new FakeAgentProc('codex', 'thread-1')
    session.lastSessionId = 'thread-1'
    session.spawnAgent = () => resumed
    cardkit.recordCardCreated(turn.cardId, 1)
    let queuedHuman = Promise.resolve()
    // 合并调和(取舍):恢复失败通道由事件版网关切换为 initialize 事务 promise
    // (上游 session 恢复优化)。保序语义不变:人类消息先入队,随后恢复失败经
    // rejection 上报(真实进程同型:init 期间进程死亡 → readyPromise reject)。
    resumed.sendInitialize = () => {
      queuedHuman = session.onUserMessage(
        'human survives failed resume',
        [],
        'ou_human',
        'om_human_survives',
      ).then(() => {
        session.pendingReactionIds.set('om_human_survives', 'reaction_human_survives')
      })
      resumed.initialization = queuedHuman.then(() => Promise.reject(new Error('resume init failed')))
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
    session.spawnAgent = (resumeRef?: ConversationRef) => {
      expect(resumeRef?.sessionId).toBe('thread-1')
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
    session.spawnAgent = (resumeRef?: ConversationRef) => {
      expect(resumeRef?.sessionId).toBe('thread-1')
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
    session.spawnAgent = (resumeRef?: ConversationRef) => {
      expect(resumeRef?.sessionId).toBe('thread-1')
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
    session.spawnAgent = (resumeRef?: ConversationRef, provider?: string) => {
      spawnArgs.push([resumeRef?.sessionId, provider])
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
    session.spawnAgent = (resumeRef?: ConversationRef, provider?: string) => {
      spawnArgs.push([resumeRef?.sessionId, provider])
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

function pendingHumanDrainFixture(provider: 'codex' | 'claude' | 'dsh' = 'codex') {
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

      // patch 故意覆盖同名身份字段(制造 stale 身份):spread 位于最后,运行时以
      // patch 为准;联合字面量中显式属性与 spread 同名会触发 TS2783,宽化仅为过检。
      proc.emit('result', {
        delivery_id: control!.dispatch.deliveryId,
        thread_id: control!.dispatch.threadId,
        turn_id: 'turn-current',
        ...(eventPatch as Record<string, string>),
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
    // 进程替换先作废旧 owner(生产为 exit/stop 路径 clearTurnOpening),
    // 新生命周期才 begin —— 7c14677 单飞后 begin 不再静默顶替。
    session.clearTurnOpening()
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
    session.clearTurnOpening() // 替换先作废旧 owner(单飞后 begin 不静默顶替)
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
    session.clearTurnOpening() // 替换先作废旧 owner(单飞后 begin 不静默顶替)
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

describe('Session system-owned Claude host-ask continuation', () => {
  test('claude host continuation accepts queued dispatch without awaiting settlement', async () => {
    const session = new Session('claude-host-continuation-queued', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'thread-claude-host-continuation')
    session.selectedProvider = 'claude'
    session.proc = proc
    session.status = 'idle'
    session.wireProc(proc)

    const outcome = await session.startHostAskContinuation('（用户回答）继续原任务', proc)
    expect(outcome).toBe('started')
    expect(proc.sentTexts).toContain('（用户回答）继续原任务')
    expect(session.currentTurn).not.toBeNull()
    expect(session.status).toBe('working')
    expect(session.pendingUserMessageCount).toBe(1)
  })

  test('claude host continuation fails when sendUserText is rejected', async () => {
    const session = new Session('claude-host-continuation-rejected', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'thread-claude-host-rejected')
    session.selectedProvider = 'claude'
    session.proc = proc
    session.status = 'idle'
    session.wireProc(proc)
    proc.dispatchFactory = () => ({
      kind: 'rejected',
      provider: 'claude',
      error: new Error('claude input closed'),
    })

    expect(await session.startHostAskContinuation('（用户回答）继续原任务', proc)).toBe('failed')
    expect(session.currentTurn).toBeNull()
    expect(session.status).toBe('idle')
    expect(session.pendingUserMessageCount).toBe(0)
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
    })) as unknown as typeof fetch
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
  test('schedules footer and background refreshes at elapsed-bucket boundaries', () => {
    const session = new Session('bucket-scheduling', 'chat_id') as any
    const turn = turnState('card_bucket_scheduling')
    const delays: number[] = []
    const renderFooterStatus = session.renderFooterStatus
    session.renderFooterStatus = () => {}
    const timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation((
      (_callback: (...args: any[]) => void, delay?: number) => {
        delays.push(Number(delay ?? 0))
        return DETERMINISTIC_FOOTER_HANDLE
      }
    ) as typeof setTimeout)

    try {
      session.startThinkingFooter(turn)
      expect(delays).toHaveLength(1)
      expect(delays[0]).toBeGreaterThanOrEqual(29_900)
      expect(delays[0]).toBeLessThanOrEqual(30_000)
      session.stopFooterStatus(turn)

      const now = Date.now()
      session.backgroundCard = { messageId: 'msg_bucket', cardId: 'card_bucket' }
      session.backgroundTasks = [{
        id: 'old', type: 'shell', description: 'old', status: 'running',
        startedAt: now - 300_001, steps: [],
      }]
      session.startBackgroundRefreshTick()
      expect(delays.at(-1)).toBeGreaterThanOrEqual(299_000)

      session.backgroundTasks.push({
        id: 'new', type: 'shell', description: 'new', status: 'running',
        startedAt: Date.now(), steps: [],
      })
      session.rescheduleBackgroundRefreshTick()
      expect(delays.at(-1)).toBeGreaterThanOrEqual(29_900)
      expect(delays.at(-1)).toBeLessThanOrEqual(30_000)
    } finally {
      session.stopFooterStatus(turn)
      session.stopBackgroundRefreshTick()
      session.renderFooterStatus = renderFooterStatus
      timeoutSpy.mockRestore()
    }
  })

  test('second live_elapsed mode uses 1s footer and 1s background ticks', async () => {
    const previous = config.runtime.live_elapsed
    config.runtime.live_elapsed = 'second'
    const session = new Session('second-scheduling', 'chat_id') as any
    const turn = turnState('card_second_scheduling')
    cardkit.recordCardCreated(turn.cardId, 1)
    const delays: number[] = []
    const renderFooterStatus = session.renderFooterStatus
    session.renderFooterStatus = () => {}
    const timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation((
      (_callback: (...args: any[]) => void, delay?: number) => {
        delays.push(Number(delay ?? 0))
        return DETERMINISTIC_FOOTER_HANDLE
      }
    ) as typeof setTimeout)

    try {
      session.startThinkingFooter(turn)
      expect(delays).toHaveLength(1)
      expect(delays[0]).toBe(1000)
      session.stopFooterStatus(turn)

      session.backgroundCard = { messageId: 'msg_second', cardId: 'card_second' }
      session.backgroundTasks = [{
        id: 'bg', type: 'shell', description: 'bg', status: 'running',
        startedAt: Date.now() - 300_001, steps: [],
      }]
      session.startBackgroundRefreshTick()
      expect(delays.at(-1)).toBe(1000)

      session.renderFooterStatus = renderFooterStatus
      turn.footerStatusHandle = DETERMINISTIC_FOOTER_HANDLE
      turn.footerStatusLabel = 'Writing...'
      turn.footerStatusStartedAt = Date.now() - 45_000
      session.renderFooterStatus(turn, turn.footerStatusStartedAt + 45_000)
      await cardkit.flush(turn.cardId)
      const footerWrites = calls
        .filter(call => call.method === 'PUT' && call.path === `/cards/${turn.cardId}/elements/footer`)
        .map(call => JSON.parse(call.body.element).content as string)
      expect(footerWrites.at(-1)).toContain('Writing... (45s)')
    } finally {
      session.stopFooterStatus(turn)
      session.stopBackgroundRefreshTick()
      session.renderFooterStatus = renderFooterStatus
      timeoutSpy.mockRestore()
      config.runtime.live_elapsed = previous
      await cardkit.dispose(turn.cardId)
    }
  })

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
      expect(footerWrites.at(-1)).toContain('Writing... (<30s)')
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

  test('rejects model selection while a turn is active before starting a rebuild', async () => {
    const session = new Session('watchdog-model-busy', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-thread-model')
    session.selectedProvider = 'codex'
    session.selectedModel = 'gpt-5.5'
    session.proc = proc
    session.currentTurn = turnState('card_watchdog_model_busy')

    const result = await session.onModelEffortSelect('gpt-5.6-sol', 'max', '', 'ou_user', 'codex')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('正在执行、启动或排队')
    expect(proc.setModelSettingsCalls).toEqual([])
    expect(session.modelSwitchPending).toBe(false)
  })

  test('uses one complete safety predicate for model selection and idle process stop', async () => {
    const blockers: Array<[string, (session: any) => void]> = [
      ['pending turn input', session => { session.pendingTurnInputs = ['queued input'] }],
      ['multi-message buffer', session => { session.multiMsgBuffer = [] }],
      ['SDK ask', session => { session.pendingAsks.set('ask-1', {}) }],
      ['host ask', session => { session.pendingHostAsks.set('host-ask-1', {}) }],
      ['permission', session => { session.pendingPermissions.set('permission-1', {}) }],
      ['manual compaction', session => { session.manualContextCompactionPending = true }],
      ['background task', session => { session.backgroundTasks = [{ status: 'running' }] }],
      ['active subagent', session => { session.activeCodexSubagentActivities.add('subagent-1') }],
    ]

    for (const [label, applyBlocker] of blockers) {
      const session = new Session(`model-busy-${label.replaceAll(' ', '-')}`, 'chat_id') as any
      const proc = new FakeAgentProc('codex', `thread-${label}`)
      session.selectedProvider = 'codex'
      session.selectedModel = 'gpt-5.5'
      session.proc = proc
      applyBlocker(session)

      expect(session.isModelSwitchBusy(), label).toBe(true)
      expect(await session.stopIdleCurrentProcess(`test ${label}`), label).toBe(false)
      const result = await session.onModelEffortSelect(
        'gpt-5.6-sol', 'max', '', 'ou_user', 'codex',
      )

      expect(result.ok, label).toBe(false)
      expect(proc.killCalls, label).toBe(0)
      expect(session.selectedModel, label).toBe('gpt-5.5')
    }
  })

  test('does not restart or persist a target selection when the final idle stop refuses', async () => {
    const session = new Session('model-stop-refused', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-model-stop-refused')
    let restartCalls = 0
    session.selectedProvider = 'codex'
    session.selectedModel = 'gpt-5.5'
    session.proc = proc
    session.stopIdleCurrentProcess = async () => {
      session.pendingTurnInputs.push('human work won the race')
      return false
    }
    session.restart = async () => {
      restartCalls++
      return true
    }

    const result = await session.onModelEffortSelect(
      'gpt-5.6-sol', 'max', '', 'ou_user', 'codex',
    )

    expect(result.ok).toBe(false)
    expect(result.message).toContain('停止过程中发生变化')
    expect(restartCalls).toBe(0)
    expect(session.selectedModel).toBe('gpt-5.5')
    expect(session.pendingTurnInputs).toEqual(['human work won the race'])
  })

  test('a newer lifecycle that arrives while idle kill awaits prevents model persistence and restart', async () => {
    const session = new Session('model-stop-lifecycle-race', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-model-stop-lifecycle-race')
    const killEntered = deferred<void>()
    const releaseKill = deferred<void>()
    let restartCalls = 0
    session.selectedProvider = 'codex'
    session.selectedModel = 'gpt-5.5'
    session.status = 'idle'
    session.proc = proc
    proc.kill = async () => {
      proc.killCalls++
      killEntered.resolve()
      await releaseKill.promise
      proc.alive = false
    }
    session.restart = async () => {
      restartCalls++
      return true
    }

    const switching = session.onModelEffortSelect(
      'gpt-5.6-sol', 'max', '', 'ou_user', 'codex',
    )
    await killEntered.promise
    session.beginLifecycle('start')
    releaseKill.resolve()
    const result = await switching

    expect(result.ok).toBe(false)
    expect(result.message).toContain('较新的会话操作')
    expect(restartCalls).toBe(0)
    expect(session.selectedModel).toBe('gpt-5.5')
  })

  test('holds modelSwitchPending across an idle process rebuild and resumes the same thread', async () => {
    const session = new Session('watchdog-model-success', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-thread-model')
    const stopEntered = deferred<void>()
    const releaseStop = deferred<void>()
    let restartArgs: any = null
    session.selectedProvider = 'codex'
    session.selectedModel = 'gpt-5.5'
    session.proc = proc
    session.stopIdleCurrentProcess = async () => {
      stopEntered.resolve()
      await releaseStop.promise
      proc.alive = false
      session.proc = null
      return true
    }
    session.restart = async (resume: boolean, opts: any) => {
      restartArgs = { resume, opts }
      return true
    }

    const resultPromise = session.onModelEffortSelect('gpt-5.6-sol', 'max', '', 'ou_user', 'codex')
    await stopEntered.promise
    expect(session.modelSwitchPending).toBe(true)
    expect(session.isModelSwitchBusy()).toBe(true)

    releaseStop.resolve()
    const result = await resultPromise
    expect(result.ok).toBe(true)
    expect(restartArgs).toMatchObject({
      resume: true,
      opts: { resumeIdentity: { provider: 'codex', threadId: 'codex-thread-model' } },
    })
    expect(proc.setModelSettingsCalls).toEqual([])
    expect(session.modelSwitchPending).toBe(false)
  })

  test('reports a saved selection when idle process rebuild fails', async () => {
    const session = new Session('watchdog-model-failure', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-thread-model')
    session.selectedProvider = 'codex'
    session.selectedModel = 'gpt-5.5'
    session.proc = proc
    session.stopIdleCurrentProcess = async () => {
      proc.alive = false
      session.proc = null
      return true
    }
    session.restart = async () => false

    const result = await session.onModelEffortSelect('gpt-5.6-sol', 'max', '', 'ou_user', 'codex')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('后端重建失败')
    expect(session.selectedModel).toBe('gpt-5.6-sol')
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
      'gpt-5.6-sol', 'max', '', 'ou_user', 'codex',
    )

    expect(result.ok).toBe(false)
    expect(result.message).toContain('自动恢复')
    expect(proc.setModelSettingsCalls).toEqual([])
    expect(session.selectedModel).toBeNull()
  })

  test('rejects a second model selection while the first idle rebuild is pending', async () => {
    const session = new Session('watchdog-model-token-race', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-model-token-race')
    const stopEntered = deferred<void>()
    const releaseStop = deferred<void>()
    session.selectedProvider = 'codex'
    session.selectedModel = 'gpt-5.5'
    session.proc = proc
    session.stopIdleCurrentProcess = async () => {
      stopEntered.resolve()
      await releaseStop.promise
      proc.alive = false
      session.proc = null
      return true
    }
    session.restart = async () => true

    const first = session.onModelEffortSelect(
      'gpt-5.6-sol', 'max', '', 'ou_first', 'codex',
    )
    await stopEntered.promise
    const second = await session.onModelEffortSelect(
      'gpt-5.6-sol', 'max', '', 'ou_second', 'codex',
    )
    expect(second.ok).toBe(false)
    expect(second.message).toContain('正在执行、启动或排队')

    releaseStop.resolve()
    expect((await first).ok).toBe(true)
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

describe('Session in-flight user guidance', () => {
  function running(provider: 'codex' | 'claude' | 'dsh' = 'codex') {
    const session = new Session('steering', 'chat_id') as any
    const proc = new FakeAgentProc(provider, 'steering-session') as any
    session.proc = proc
    session.selectedProvider = provider
    session.wireProc(proc)
    session.initCount = 1
    session.turnCounter = 1
    session.status = 'working'
    const turn = turnState('card_steering')
    turn.provider = provider
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 2)
    return { session, proc, turn }
  }

  for (const provider of ['codex', 'claude'] as const) {
    test(`${provider} waits for native consumption before changing the presentation card`, async () => {
      const { session, proc, turn } = running(provider)
      const steered: any[] = []
      proc.steerUserText = async (...args: any[]) => { steered.push(args); return true }
      try {
        await session.onUserMessage('请先检查这里', ['/tmp/context.txt'], 'ou_user', 'om_guidance')
        await session.steeringSend
        expect(steered).toEqual([['[file: /tmp/context.txt]\n请先检查这里', [], expect.any(String)]])
        expect(proc.sentTexts).toEqual([])
        expect(session.currentTurn).toBe(turn)
        expect(session.pendingMidTurnMsgs).toEqual([])
        expect(session.pendingUserMessageCount).toBe(0)
        expect(session.pendingReactionIds.size).toBe(1)
        expect(sentCards).toEqual([])
        expect(turn.cardId).toBe('card_steering')
        proc.emit('assistant_text', { text: '提交之后仍未消费的旧任务输出', parentToolUseId: null })
        proc.emit('user_input_consumed', { inputId: steered[0][2] })
        proc.emit('input_batch_end', { itemId: 'next-reasoning' })
        await waitUntil(() => session.steeringBoundary === null)
        expect(session.pendingReactionIds.size).toBe(0)
        expect(sentCards).toHaveLength(1)
        const nextCard = sentCards[0] as any
        expect(nextCard.body.elements[0].header.title.content).toBe('📥 追加 (1) #1')
        expect(JSON.stringify(nextCard)).toContain('请先检查这里')
        expect(JSON.stringify(nextCard)).not.toContain('前卡写满')
        expect(turn.cardId).not.toBe('card_steering')
        expect(cardkit.isDisposed('card_steering')).toBe(true)
        expect(session.turnCounter).toBe(1)
        expect(calls.some(call => call.path === '/cards/card_steering/elements/footer'
          && String(call.body.element).includes('已续至下一张'))).toBe(true)
        proc.emit('assistant_text', { text: '已根据补充调整', parentToolUseId: null })
        proc.emit('assistant_block_stop', { parentToolUseId: null })
        await cardkit.flush(turn.cardId)
        expect(calls.some(call => call.method === 'POST' && call.path === `/cards/${turn.cardId}/elements`
          && String(call.body.elements).includes('已根据补充调整'))).toBe(true)
        const oldWrites = JSON.stringify(calls.filter(call => call.path.startsWith('/cards/card_steering/elements')))
        const newWrites = JSON.stringify(calls.filter(call => call.path.startsWith(`/cards/${turn.cardId}/elements`)))
        expect(oldWrites).toContain('提交之后仍未消费的旧任务输出')
        expect(newWrites).not.toContain('提交之后仍未消费的旧任务输出')
      } finally { await session.closeTurnCard('测试收尾') }
    })
  }

  test('consumption before RPC receipt fences trailing events and closes the replacement exactly once', async () => {
    const { session, proc, turn } = running()
    let acknowledge!: (accepted: boolean) => void
    let inputId = ''
    proc.steerUserText = (_text: string, _files: string[], id: string) => {
      inputId = id
      return new Promise<boolean>(resolve => { acknowledge = resolve })
    }
    await session.onUserMessage('arriving at completion')
    await waitUntil(() => !!acknowledge)
    proc.emit('user_input_consumed', { inputId })
    proc.emit('assistant_text', { text: 'reply after the boundary', parentToolUseId: null })
    proc.emit('assistant_block_stop', { parentToolUseId: null })
    proc.emit('result', { is_error: false })
    expect(session.currentTurn).toBe(turn)
    acknowledge(true)
    await waitUntil(() => session.currentTurn === null)
    await session.waitForTurnCloses()
    expect(sentCards).toHaveLength(1)
    expect(JSON.stringify(sentCards[0])).toContain('arriving at completion')
    expect(turn.cardId).not.toBe('card_steering')
    expect(cardkit.isDisposed('card_steering')).toBe(true)
    expect(cardkit.isDisposed(turn.cardId)).toBe(true)
    expect(turn.footerStatusHandle).toBeNull()
    expect(calls.some(call => call.method === 'POST' && call.path === `/cards/${turn.cardId}/elements`
      && String(call.body.elements).includes('reply after the boundary'))).toBe(true)
    expect(proc.sentTexts).toEqual([])
    expect(session.pendingMidTurnMsgs).toEqual([])
  })

  test('supplemental waiting reactions clear together when the new card is sent, including consumption before ACK', async () => {
    const { session, proc, turn } = running()
    const ids: string[] = []
    let acknowledge!: (accepted: boolean) => void
    proc.steerUserText = (_text: string, _files: string[], inputId: string) => {
      ids.push(inputId)
      return ids.length === 1 ? new Promise<boolean>(resolve => { acknowledge = resolve }) : Promise.resolve(true)
    }
    let releaseSend!: () => void
    const sendGate = new Promise<void>(resolve => { releaseSend = resolve })
    let releaseConvert!: () => void
    const convertGate = new Promise<void>(resolve => { releaseConvert = resolve })
    let sending = false
    let converting = false
    const originalSend = feishu.sendCard
    const originalConvert = cardkit.convertMessageToCard
    const send = spyOn(feishu, 'sendCard').mockImplementation(async (...args: Parameters<typeof feishu.sendCard>) => {
      sending = true
      await sendGate
      return originalSend(...args)
    })
    const convert = spyOn(cardkit, 'convertMessageToCard').mockImplementation(async (...args: Parameters<typeof cardkit.convertMessageToCard>) => {
      converting = true
      await convertGate
      return originalConvert(...args)
    })
    try {
      await session.onUserMessage('first', [], 'ou_user', 'om_first')
      proc.emit('user_input_consumed', { inputId: ids[0] })
      expect(deletedReactions).toEqual([])
      acknowledge(true)
      await session.steeringSend
      expect(deletedReactions).toEqual([])
      await session.onUserMessage('second', [], 'ou_user', 'om_second')
      await session.steeringSend
      proc.emit('user_input_consumed', { inputId: ids[1] })
      expect([...session.pendingReactionIds.keys()]).toEqual(['om_first', 'om_second'])
      proc.emit('input_batch_end', { itemId: 'next-reasoning' })
      await waitUntil(() => sending)
      expect(sentCards).toEqual([])
      expect(deletedReactions).toEqual([])
      await session.onUserMessage('later batch', [], 'ou_user', 'om_later')
      await session.steeringSend
      releaseSend()
      await waitUntil(() => converting)
      expect(sentCards).toHaveLength(1)
      // 合并调和:上游替身 addReaction 返回计数式 'reaction_1/2';定型 mock
      // (feishu-test-mock.ts)为本地形态 `reaction-${messageId}`,断言随定型替身。
      expect(deletedReactions).toEqual([['om_first', 'reaction-om_first'], ['om_second', 'reaction-om_second']])
      expect([...session.pendingReactionIds.keys()]).toEqual(['om_later'])
      // Deletion does not wait for Card Kit setup or the old card's close.
      expect(turn.cardId).toBe('card_steering')
      releaseConvert()
      await waitUntil(() => session.steeringBoundary === null)
      expect(deletedReactions).toHaveLength(2)
    } finally {
      acknowledge?.(true)
      releaseSend(); releaseConvert()
      send.mockRestore(); convert.mockRestore()
      await session.closeTurnCard('测试收尾')
    }
  })

  test('late reaction creation stays waiting before card visibility and is removed if it arrives afterwards', async () => {
    const { session, proc } = running()
    const ids: string[] = []
    const created = new Map<string, (reactionId: string) => void>()
    proc.steerUserText = async (_text: string, _files: string[], inputId: string) => { ids.push(inputId); return true }
    const reaction = spyOn(feishu, 'addReaction').mockImplementation((msgId: string) => new Promise<string>(resolve => { created.set(msgId, resolve) }))
    let releaseSend!: () => void
    const gate = new Promise<void>(resolve => { releaseSend = resolve })
    const originalSend = feishu.sendCard
    const send = spyOn(feishu, 'sendCard').mockImplementation(async (...args: Parameters<typeof feishu.sendCard>) => { await gate; return originalSend(...args) })
    try {
      for (const msgId of ['om_early', 'om_late']) { await session.onUserMessage(msgId, [], 'ou_user', msgId); await session.steeringSend }
      for (const inputId of ids) proc.emit('user_input_consumed', { inputId })
      created.get('om_early')!('rid_early')
      await waitUntil(() => session.pendingReactionIds.get('om_early') === 'rid_early')
      expect(deletedReactions).toEqual([])
      proc.emit('input_batch_end', { itemId: 'next-reasoning' })
      releaseSend()
      await waitUntil(() => session.steeringBoundary === null)
      expect(deletedReactions).toEqual([['om_early', 'rid_early']])
      created.get('om_late')!('rid_late')
      await waitUntil(() => deletedReactions.length === 2)
      expect(deletedReactions).toEqual([['om_early', 'rid_early'], ['om_late', 'rid_late']])
      expect(session.pendingReactionIds.size).toBe(0)
    } finally { releaseSend(); send.mockRestore(); reaction.mockRestore(); await session.closeTurnCard('测试收尾') }
  })

  test('startup input stays pending until turn_started, then steers without waiting for result', async () => {
    const { session, proc } = running()
    const sent: string[] = []
    let nativeActive = false
    proc.steerUserText = async (text: string) => { if (!nativeActive) return false; sent.push(text); return true }
    try {
      await session.onUserMessage('during startup')
      await session.steeringSend
      expect(session.pendingMidTurnMsgs).toHaveLength(1)
      nativeActive = true
      proc.emit('turn_started', { turn_id: 'active' })
      await session.steeringSend
      expect(sent).toEqual(['during startup'])
      expect(session.pendingMidTurnMsgs).toEqual([])
      expect(proc.sentTexts).toEqual([])
    } finally { await session.closeTurnCard('测试收尾') }
  })

  test('uncertain steering failures are visible and are never replayed after result', async () => {
    const { session, proc } = running()
    proc.steerUserText = async () => { throw new Error('turn/steer response lost') }
    await session.onUserMessage('must execute once')
    await session.steeringSend
    expect(sentRawTexts.some(text => text.includes('turn/steer response lost') && text.includes('未自动重发'))).toBe(true)
    proc.emit('result', { is_error: false })
    await session.waitForTurnCloses()
    expect(session.pendingMidTurnMsgs).toEqual([])
    expect(proc.sentTexts).toEqual([])
    expect(session.currentTurn).toBeNull()
  })

  test('messages arriving during a steering request remain ordered and are coalesced once', async () => {
    const { session, proc } = running()
    const sent: string[] = []
    const ids: string[] = []
    let acknowledge!: (accepted: boolean) => void
    proc.steerUserText = (text: string, _files: string[], id: string) => {
      sent.push(text)
      ids.push(id)
      return sent.length === 1 ? new Promise<boolean>(resolve => { acknowledge = resolve }) : Promise.resolve(true)
    }
    try {
      await session.onUserMessage('first')
      await session.onUserMessage('second', ['/tmp/second.txt'])
      await session.onUserMessage('third')
      expect(sent).toEqual(['first'])
      acknowledge(true)
      await waitUntil(() => session.steeringSend === null && sent.length === 2)
      expect(sent).toEqual(['first', '[file: /tmp/second.txt]\nsecond\n\nthird'])
      expect(sentCards).toEqual([])
      proc.emit('user_input_consumed', { inputId: ids[0] })
      proc.emit('assistant_text', { text: 'between the inputs', parentToolUseId: null })
      proc.emit('assistant_block_stop', { parentToolUseId: null })
      proc.emit('user_input_consumed', { inputId: ids[1] })
      proc.emit('assistant_text', { text: 'after the second input', parentToolUseId: null })
      proc.emit('assistant_block_stop', { parentToolUseId: null })
      await waitUntil(() => session.steeringBoundary === null)
      expect(sentCards).toHaveLength(2)
      expect(JSON.stringify(sentCards[0])).toContain('first')
      expect(JSON.stringify(sentCards[1])).toContain('second')
      expect(JSON.stringify(sentCards[1])).toContain('third')
      expect(JSON.stringify(sentCards[1])).not.toContain('first')
    } finally { await session.closeTurnCard('测试收尾') }
  })

  for (const provider of ['codex', 'claude'] as const) {
    test(`${provider} combines the consecutive consumed 2–10 messages into one supplemental card`, async () => {
      const { session, proc, turn } = running(provider)
      const ids: string[] = []
      proc.steerUserText = async (_text: string, _files: string[], id: string) => { ids.push(id); return true }
      try {
        for (let n = 2; n <= 10; n++) {
          await session.onUserMessage(String(n))
          await session.steeringSend
        }
        expect(ids).toHaveLength(9)
        proc.emit('assistant_text', { text: '原消息 1 的回复', parentToolUseId: null })
        proc.emit('assistant_block_stop', { parentToolUseId: null })
        for (const inputId of ids) {
          proc.emit('user_input_consumed', { inputId })
          // Consumption frames may arrive separately with bookkeeping in
          // between; neither a timer nor usage traffic defines a new batch.
          proc.emit('token_usage', { usage: { total_tokens: 1 }, totalUsage: { total_tokens: 1 } })
          proc.emit('assistant_text', { text: '独立子任务输出', parentToolUseId: 'child-task' })
          await new Promise(resolve => setTimeout(resolve, 2))
          expect(sentCards).toEqual([])
        }
        if (provider === 'codex') proc.emit('input_batch_end', { itemId: 'reasoning-for-all-inputs' })
        proc.emit('assistant_text', { text: '收到，测试消息 1–10 均已接收。', parentToolUseId: null })
        proc.emit('assistant_block_stop', { parentToolUseId: null })
        await waitUntil(() => session.steeringBoundary === null)
        await cardkit.flush(turn.cardId)
        expect(sentCards).toHaveLength(1)
        const input = (sentCards[0] as any).body.elements[0]
        expect(input.header.title.content).toBe('📥 追加 (9) #1')
        expect(input.elements.map((item: any) => item.content)).toEqual(['2', '3', '4', '5', '6', '7', '8', '9', '10'])
        expect(turn.rotateCount).toBe(1)
        const newWrites = JSON.stringify(calls.filter(call => call.path.startsWith(`/cards/${turn.cardId}/elements`)))
        expect(newWrites).toContain('测试消息 1–10 均已接收')
        expect(newWrites).not.toContain('原消息 1 的回复')
      } finally { await session.closeTurnCard('测试收尾') }
    })
  }

  test('stop releases an input batch waiting for Agent activity without creating a card', async () => {
    const { session, proc } = running()
    proc.steerUserText = async () => true
    await session.onUserMessage('waiting input', [], 'ou_user', 'om_cancelled')
    await session.steeringSend
    proc.emit('user_input_consumed', { inputId: [...session.submittedSteering.keys()][0] })
    expect(session.steeringBoundary.collecting).toBe(true)
    expect(deletedReactions).toEqual([])
    await session.runCommand('stop')
    expect(session.steeringBoundary).toBeNull()
    expect(session.currentTurn).toBeNull()
    expect(sentCards).toEqual([])
    // 定型 mock 反应 id 为 `reaction-${messageId}` 形态(上游为计数式)。
    expect(deletedReactions).toEqual([['om_cancelled', 'reaction-om_cancelled']])
  })

  test('consecutive input runs remain separate across native Agent work while a card is opening', async () => {
    const { session, proc } = running()
    const ids: string[] = []
    proc.steerUserText = async (_text: string, _files: string[], inputId: string) => { ids.push(inputId); return true }
    try {
      for (let n = 2; n <= 7; n++) { await session.onUserMessage(String(n)); await session.steeringSend }
      for (const inputId of ids.slice(0, 2)) proc.emit('user_input_consumed', { inputId })
      proc.emit('input_batch_end', { itemId: 'reasoning-between-input-runs' })
      for (const inputId of ids.slice(2)) proc.emit('user_input_consumed', { inputId })
      proc.emit('assistant_text', { text: 'final output', parentToolUseId: null })
      proc.emit('assistant_block_stop', { parentToolUseId: null })
      await waitUntil(() => session.steeringBoundary === null)
      expect(sentCards).toHaveLength(2)
      expect(sentCards.map((card: any) => card.body.elements[0].header.title.content)).toEqual(['📥 追加 (2) #1', '📥 追加 (4) #1'])
      expect(sentCards.map((card: any) => card.body.elements[0].elements.map((item: any) => item.content))).toEqual([['2', '3'], ['4', '5', '6', '7']])
    } finally { await session.closeTurnCard('测试收尾') }
  })

  test('stop remains callable during an outstanding receipt and never requeues its message', async () => {
    const { session, proc } = running()
    let acknowledge!: (accepted: boolean) => void
    let interrupted = false
    proc.steerUserText = () => new Promise<boolean>(resolve => { acknowledge = resolve })
    proc.sendInterrupt = () => { interrupted = true }
    await session.onUserMessage('do not restart after stop')
    const stop = session.runCommand('stop')
    await waitUntil(() => interrupted)
    acknowledge(false)
    await stop
    expect(session.pendingMidTurnMsgs).toEqual([])
    expect(proc.sentTexts).toEqual([])
    expect(session.currentTurn).toBeNull()
  })

  test('duplicate and unknown consumption events cannot create additional cards', async () => {
    const { session, proc } = running()
    proc.steerUserText = async () => true
    try {
      await session.onUserMessage('one boundary')
      await session.steeringSend
      const inputId = [...session.submittedSteering.keys()][0]
      proc.emit('user_input_consumed', { inputId: 'unknown' })
      expect(sentCards).toEqual([])
      proc.emit('user_input_consumed', { inputId })
      proc.emit('user_input_consumed', { inputId })
      proc.emit('input_batch_end', { itemId: 'next-reasoning' })
      await waitUntil(() => session.steeringBoundary === null)
      expect(sentCards).toHaveLength(1)
    } finally { await session.closeTurnCard('测试收尾') }
  })

  test('a stopped input cannot rotate on a late native consumption notification', async () => {
    const { session, proc } = running()
    proc.steerUserText = async () => true
    await session.onUserMessage('cancel me')
    await session.steeringSend
    const inputId = [...session.submittedSteering.keys()][0]
    await session.runCommand('stop')
    proc.emit('user_input_consumed', { inputId })
    expect(session.steeringBoundary).toBeNull()
    expect(session.submittedSteering.size).toBe(0)
    expect(sentCards).toEqual([])
  })

  test('a terminal result without a consumption boundary reports missing confirmation and does not guess a cut', async () => {
    const { session, proc } = running()
    proc.steerUserText = async () => true
    await session.onUserMessage('no receipt')
    await session.steeringSend
    proc.emit('result', { is_error: false })
    await session.waitForTurnCloses()
    expect(sentCards).toEqual([])
    expect(session.submittedSteering.size).toBe(0)
    expect(sentRawTexts.some(text => text.includes('缺少原生处理位置确认'))).toBe(true)
  })

  test('backends without steering retain the existing next-turn input batch', async () => {
    const { session, proc } = running('dsh')
    try {
      await session.onUserMessage('next task')
      expect(session.pendingMidTurnMsgs.map((msg: any) => msg.text)).toEqual(['next task'])
      expect(proc.sentTexts).toEqual([])
    } finally { session.pendingMidTurnMsgs = []; await session.closeTurnCard('测试收尾') }
  })

  test('native consumption seals all earlier text and preserves later output across a slow card handoff', async () => {
    const { session, proc, turn } = running()
    proc.steerUserText = async () => true
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalSend = feishu.sendCard
    const send = spyOn(feishu, 'sendCard').mockImplementation(async (...args: Parameters<typeof feishu.sendCard>) => {
      await gate
      return originalSend(...args)
    })
    try {
      session.appendAssistant('已经完成的前文')
      session.finalizeCurrentAssistantSegment()
      await cardkit.flush(turn.cardId)
      session.appendAssistant('仍在生成的正文')
      turn.toolByUseId.set('ongoing-read', { i: 0, name: 'Read', input: { file_path: '/tmp/steering.txt' } })
      turn.toolCount = 1
      await session.onUserMessage('补充要求')
      await session.steeringSend
      expect(sentCards).toEqual([])
      expect(turn.currentAssistantText).toBe('仍在生成的正文')
      const inputId = [...session.submittedSteering.keys()][0]
      proc.emit('user_input_consumed', { inputId })
      proc.emit('tool_result', { tool_use_id: 'ongoing-read', content: '文件读取结果', is_error: false, parentToolUseId: null })
      proc.emit('assistant_text', { text: '从补充位置继续', parentToolUseId: null })
      proc.emit('assistant_block_stop', { parentToolUseId: null })
      await Promise.resolve()
      expect(turn.cardId).toBe('card_steering')
      expect(turn.toolByUseId.get('ongoing-read').output).toBeUndefined()
      release()
      await waitUntil(() => session.steeringBoundary === null)
      await cardkit.flush(turn.cardId)
      const newWrites = JSON.stringify(calls.filter(call => call.path.startsWith(`/cards/${turn.cardId}/elements`)))
      expect(newWrites).toContain('从补充位置继续')
      expect(newWrites).not.toContain('仍在生成的正文')
      const oldWrites = JSON.stringify(calls.filter(call => call.path.startsWith('/cards/card_steering/elements')))
      expect(oldWrites).toContain('仍在生成的正文')
      expect(oldWrites).not.toContain('从补充位置继续')
      expect(turn.toolByUseId.get('ongoing-read').output).toBe('文件读取结果')
      expect(calls.some(call => call.method === 'PUT' && call.path === `/cards/${turn.cardId}/elements/tool_0`
        && String(call.body.element).includes('✅'))).toBe(true)
      expect(newWrites).not.toContain('已经完成的前文')
    } finally { release(); send.mockRestore(); await session.closeTurnCard('测试收尾') }
  })

  test('a supplemental card failure reports the accepted input without resending it or starting capacity recovery', async () => {
    const { session, proc, turn } = running()
    const steered: string[] = []
    proc.steerUserText = async (text: string) => { steered.push(text); return true }
    const sendCard = spyOn(feishu, 'sendCard').mockResolvedValue(null)
    try {
      await session.onUserMessage('送达一次即可', [], 'ou_user', 'om_card_failed')
      await session.steeringSend
      proc.emit('user_input_consumed', { inputId: [...session.submittedSteering.keys()][0] })
      proc.emit('input_batch_end', { itemId: 'next-reasoning' })
      await waitUntil(() => session.steeringBoundary === null)
      expect(steered).toEqual(['送达一次即可'])
      expect(turn.cardId).toBe('card_steering')
      expect(turn.cardRotationFailed).toBe(false)
      expect(session.pendingMidTurnMsgs).toEqual([])
      expect(deletedReactions).toEqual([])
      expect(session.pendingReactionIds.has('om_card_failed')).toBe(true)
      expect(sentRawTexts.some(text => text.includes('追加消息已交给 Agent，但新卡片发送失败'))).toBe(true)
    } finally { sendCard.mockRestore(); await session.closeTurnCard('测试收尾') }
    // 定型 mock 反应 id 为 `reaction-${messageId}` 形态(上游为计数式)。
    expect(deletedReactions).toEqual([['om_card_failed', 'reaction-om_card_failed']])
  })
})

describe('Session cloud file receipts', () => {
  for (const provider of ['codex', 'claude', 'dsh'] as const) {
    test(`${provider} BTW uses its workspace mode and updates on the next input while WT stays separate`, async () => {
      const registry = new GroupFileDelivery({
        read: () => undefined, write: () => {}, workDirForChat: () => undefined,
        getChatName: async id => id,
        createFolder: async name => ({ token: name, url: `https://example.com/${name}` }),
        getFolder: async folder => ({ ...folder, name: folder.token }),
        renameFolder: async (folder, name) => ({ ...folder, name }),
        grantFolderAccess: async () => {},
      })
      const mode = spyOn(groupFileDelivery, 'mode').mockImplementation((chatId, workDir) => registry.mode(chatId, workDir))
      const main = new Session('workspace-modes', 'main')
      const btw = new Session('workspace-modes*0917-1234', 'btw') as any
      const wt = new Session('workspace-modes[feature]', 'wt')
      try {
        await registry.enable(main.chatId, main.workDir, 'user')
        expect(btw.getFileDeliveryMode()).toBe('drive')
        expect(wt.getFileDeliveryMode()).toBe('chat')
        const proc = new FakeAgentProc(provider)
        btw.procFileDeliveryModes.set(proc, 'drive')
        btw.sendClaimedUserText(proc, 'first')
        await registry.disable(main.chatId, main.workDir)
        btw.sendClaimedUserText(proc, 'second')
        btw.sendClaimedUserText(proc, 'third')
        expect(proc.sentTexts).toEqual(['first', `${fileDeliveryAgentContext('chat')}\n\nsecond`, 'third'])
      } finally { mode.mockRestore(); main.dispose(); btw.dispose(); wt.dispose() }
    })
  }

  test('keeps ordinary file and image messages as the default with no cloud card or upload', () => {
    const session = new Session('native-files', 'unconfigured-chat') as any
    const turn = turnState()
    session.currentTurn = turn
    session.createFileDeliveryForTurn = () => { throw new Error('cloud delivery must not be used by default') }
    expect(session.getFileDeliveryMode()).toBe('chat')
    session.sendOutboundPath('/tmp/report.pdf', 'send marker')
    session.sendOutboundPath('/tmp/image.png', 'send marker')
    expect(sentLocalFiles).toEqual([['unconfigured-chat', '/tmp/report.pdf'], ['unconfigured-chat', '/tmp/image.png']])
    expect(turn.fileDelivery).toBeUndefined()
    expect(turn.fileDeliveryMode).toBe('chat')
    expect(sentCards).toHaveLength(0)
  })

  test('switches only newly admitted batches, so one turn never mixes attachment and cloud delivery', () => {
    const session = new Session('file-mode-switch', 'chat') as any
    let mode = 'chat'
    const cloudPaths: string[] = []
    session.getFileDeliveryMode = () => mode
    session.createFileDeliveryForTurn = () => ({ add: (path: string) => cloudPaths.push(path), finish: async () => cloudPaths, cancel: () => false })
    session.currentTurn = turnState()
    session.sendOutboundPath('/tmp/first.pdf', 'send marker')
    mode = 'drive'
    session.sendOutboundPath('/tmp/second.pdf', 'send marker')
    expect(sentLocalFiles.map(([, path]) => path)).toEqual(['/tmp/first.pdf', '/tmp/second.pdf'])
    expect(cloudPaths).toEqual([])
    session.currentTurn = turnState()
    session.sendOutboundPath('/tmp/third.pdf', 'send marker')
    expect(cloudPaths).toEqual(['/tmp/third.pdf'])
  })

  test('updates delivery rules only when the group mode changes, without repeating startup rules', () => {
    const session = new Session('file-mode-context', 'chat') as any
    const proc = new FakeAgentProc('codex')
    let mode = 'drive'
    session.getFileDeliveryMode = () => mode
    session.procFileDeliveryModes.set(proc, mode)
    session.sendClaimedUserText(proc, '生成大文件')
    mode = 'chat'
    session.sendClaimedUserText(proc, '继续交付')
    session.sendClaimedUserText(proc, '生成报告')
    mode = 'drive'
    session.sendClaimedUserText(proc, '生成视频')
    expect(proc.sentTexts).toEqual([
      '生成大文件',
      `${fileDeliveryAgentContext('chat')}\n\n继续交付`,
      '生成报告',
      `${fileDeliveryAgentContext('drive')}\n\n生成视频`,
    ])
    expect(proc.sentTexts[3]).not.toMatch(/30|大小|压缩|分卷/)
  })

  test('freezes delivery before file generation so changing the group switch cannot invalidate the prepared file', () => {
    const session = new Session('file-mode-preparation', 'chat') as any
    const proc = new FakeAgentProc('codex')
    session.proc = proc
    let mode = 'drive'
    session.getFileDeliveryMode = () => mode
    session.procFileDeliveryModes.set(proc, mode)
    const cloudPaths: string[] = []
    session.createFileDeliveryForTurn = () => ({ add: (path: string) => cloudPaths.push(path), finish: async () => cloudPaths, cancel: () => false })
    session.currentTurn = turnState()
    session.sendClaimedUserText(proc, '生成视频')
    mode = 'chat'
    session.sendOutboundPath('/tmp/video.mp4', 'send marker')
    expect(cloudPaths).toEqual(['/tmp/video.mp4'])
    expect(sentLocalFiles).toEqual([])
    session.currentTurn = turnState()
    session.sendClaimedUserText(proc, '生成报告')
    session.sendOutboundPath('/tmp/report.pdf', 'send marker')
    expect(sentLocalFiles).toEqual([['chat', '/tmp/report.pdf']])
    expect(proc.sentTexts).toEqual(['生成视频', `${fileDeliveryAgentContext('chat')}\n\n生成报告`])
  })

  test('keeps the injected delivery mode if the backend opens its card after the group switch changed', () => {
    const session = new Session('file-mode-late-card', 'chat') as any
    const proc = new FakeAgentProc('codex')
    session.proc = proc
    let mode = 'drive'
    session.getFileDeliveryMode = () => mode
    session.procFileDeliveryModes.set(proc, mode)
    const cloudPaths: string[] = []
    session.createFileDeliveryForTurn = () => ({ add: (path: string) => cloudPaths.push(path), finish: async () => cloudPaths, cancel: () => false })
    session.sendClaimedUserText(proc, '生成视频')
    mode = 'chat'
    session.currentTurn = turnState()
    session.sendOutboundPath('/tmp/late-video.mp4', 'send marker')
    expect(cloudPaths).toEqual(['/tmp/late-video.mp4'])
    expect(sentLocalFiles).toEqual([])
  })

  test('retries a delivery-rule update after the backend rejects its input write', () => {
    const session = new Session('file-mode-write-error', 'chat') as any
    const proc = new FakeAgentProc('codex')
    session.procFileDeliveryModes.set(proc, 'drive')
    session.getFileDeliveryMode = () => 'chat'
    const send = proc.sendUserText.bind(proc)
    proc.sendUserText = () => { throw new Error('input closed') }
    expect(() => session.sendClaimedUserText(proc, '生成报告')).toThrow('input closed')
    expect(session.pendingUserMessageCount).toBe(0)
    expect(session.procFileDeliveryModes.get(proc)).toBe('drive')
    proc.sendUserText = send
    session.sendClaimedUserText(proc, '生成报告')
    expect(proc.sentTexts).toEqual([`${fileDeliveryAgentContext('chat')}\n\n生成报告`])
  })

  test('routes files commands to the current group settings without forwarding them to an Agent', async () => {
    const session = new Session('file-commands', 'chat') as any
    const calls: unknown[][] = []
    session.runFileDeliveryCommand = async (...args: unknown[]) => { calls.push(args) }
    for (const command of ['files', 'files on', 'FILES OFF']) expect(await session.runCommand(command, 'ou_user')).toBe(true)
    expect(calls).toEqual([['', 'ou_user'], ['on', 'ou_user'], ['OFF', 'ou_user']])
  })

  test('keeps one delivery across rotations, deduplicates markers, and waits for final publication', async () => {
    const session = new Session('files', 'chat_id') as any
    const turn = turnState('card_file_receipt')
    turn.fileDeliveryMode = 'drive'
    cardkit.recordCardCreated(turn.cardId, 1)
    session.currentTurn = turn
    const admitted: string[] = []
    let release!: (paths: string[]) => void
    let finishStarted = false
    const publication = new Promise<string[]>(resolve => { release = resolve })
    let factories = 0
    session.createFileDeliveryForTurn = (captured: any) => {
      expect(captured.userOpenId).toBe('ou_user')
      factories++
      return { add: (path: string) => { admitted.push(path) }, finish: () => { finishStarted = true; return publication } }
    }
    session.sendOutboundPath('/tmp/large.mp4', 'send marker')
    session.sendOutboundPath('/tmp/large.mp4', 'duplicate marker')
    session.sendOutboundPath('/tmp/report.pdf', 'send marker after rotation')
    expect(factories).toBe(1)
    expect(admitted).toEqual(['/tmp/large.mp4', '/tmp/report.pdf'])
    expect(turn.outboundSentPaths.size).toBe(0)
    expect(sentLocalFiles).toHaveLength(0)
    const closed = session.closeTurnCard()
    await waitUntil(() => finishStarted)
    expect(cardkit.isDisposed(turn.cardId)).toBe(false)
    release(['/tmp/large.mp4'])
    await closed
    expect(turn.outboundSentPaths.has('/tmp/large.mp4')).toBe(true)
    expect(turn.outboundSentPaths.has('/tmp/report.pdf')).toBe(false)
    expect(cardkit.isDisposed(turn.cardId)).toBe(true)
  })

  test.each([
    ['codex', 'success'], ['claude', 'success'], ['dsh', 'success'],
    ['codex', 'error_during_execution'], ['claude', 'error_during_execution'], ['dsh', 'error_during_execution'],
  ] as const)('%s keeps an upload running when a result hands queued input to a new card (result=%s)', async (provider, subtype) => {
    const isError = subtype !== 'success'
    const session = new Session('file-handoff', 'chat_id') as any
    const proc = new FakeAgentProc(provider)
    session.proc = proc
    session.selectedProvider = provider
    session.selectedEffort = 'high'
    session.getFileDeliveryMode = () => 'drive'
    session.procFileDeliveryModes.set(proc, 'drive')
    session.wireProc(proc)
    const turn = turnState(`card_file_handoff_${provider}_${isError}`)
    turn.provider = provider
    turn.fileDeliveryMode = 'drive'
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)
    const receipts: FileDeliverySnapshot[] = []
    const errors: string[] = []
    let uploadSignal: AbortSignal | undefined
    let release!: () => void
    const delivery = new FileDeliveryBatch({
      chatId: 'chat_id', managerOpenId: 'ou_user', projectName: 'file-handoff', createdAt: turn.startedAt,
    }, {
      resolveFolder: async () => ({ token: 'folder', url: 'https://example.feishu.cn/drive/folder/folder' }),
      uploadFile: async (path, _folder, onUploaded, signal) => {
        uploadSignal = signal
        await new Promise<void>((resolve, reject) => {
          release = resolve
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
        const file = { token: 'video', name: path, bytes: 40 * 1024 * 1024, url: 'https://example.feishu.cn/file/video' }
        onUploaded(file)
        return file
      },
      sendCard: async snapshot => { receipts.push(structuredClone(snapshot)); return 'om_receipt' },
      persist: () => {},
      reportError: async message => { errors.push(message) },
    })
    session.createFileDeliveryForTurn = () => delivery
    session.sendOutboundPath('/tmp/preview.mp4', 'send marker')
    await waitUntil(() => uploadSignal !== undefined)
    try {
      session.pendingMidTurnMsgs = [{
        text: '继续下一步', wireText: '继续下一步', userOpenId: 'ou_user', msgId: 'om_followup',
      }]
      proc.lastResult = { ...proc.lastResult, subtype, is_error: isError }
      proc.emit('result', { is_error: isError })
      await waitUntil(() => proc.sentTexts.includes('继续下一步'))
      const nextTurn = session.currentTurn
      expect(nextTurn).not.toBeNull()
      expect(nextTurn).not.toBe(turn)
      expect(uploadSignal!.aborted).toBe(false)
      expect(delivery.snapshot.files[0].status).toBe('pending')
      expect(receipts).toHaveLength(0)
      expect(cardkit.isDisposed(turn.cardId)).toBe(false)
      expect(session.fileDeliveries.has(delivery)).toBe(true)

      release()
      await session.waitForTurnCloses()
      expect(receipts).toHaveLength(1)
      expect(receipts[0].files.map(file => file.status)).toEqual(['ready'])
      expect(receipts[0].error).toBeUndefined()
      expect(errors).toEqual([])
      expect(turn.outboundSentPaths.has('/tmp/preview.mp4')).toBe(true)
      expect(cardkit.isDisposed(turn.cardId)).toBe(true)
      expect(session.fileDeliveries.size).toBe(0)
      expect(session.currentTurn).toBe(nextTurn)
      expect(nextTurn.outboundSentPaths.size).toBe(0)
      const footer = calls.find(call => call.method === 'PUT' && call.path === `/cards/${turn.cardId}/elements/footer`)
      expect(JSON.stringify(footer?.body)).toContain(isError ? '用户已介入' : '📨 转交新卡')
    } finally {
      release()
      await session.waitForTurnCloses()
      if (session.currentTurn) await session.closeTurnCard()
    }
  })

  test.each(['hard', 'soft'])('%s stop cancels file delivery after the agent finished and its turn was captured', async mode => {
    const session = new Session('closing-files', 'chat_id') as any
    const turn = turnState('card_closing_files')
    turn.fileDeliveryMode = 'drive'
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)
    let finishStarted = false
    let cancelled = ''
    let release!: (paths: string[]) => void
    const published = new Promise<string[]>(resolve => { release = resolve })
    session.createFileDeliveryForTurn = () => ({
      add: () => {},
      finish: () => { finishStarted = true; return published },
      cancel: (reason: string) => { cancelled = reason; release([]); return true },
    })
    session.sendOutboundPath('/tmp/large.mp4', 'send marker')
    const close = session.closeTurnCard()
    await waitUntil(() => finishStarted)
    expect(session.currentTurn).toBeNull()
    if (mode === 'hard') await session.stop('取消尚未完成的交付', { announce: false })
    else await session.runCommand('stop', 'ou_user')
    await close
    expect(cancelled).toBe(mode === 'hard' ? '取消尚未完成的交付' : '用户停止了任务')
    expect(cardkit.isDisposed(turn.cardId)).toBe(true)
    expect(session.fileDeliveries.size).toBe(0)
  })
})

describe('generated image delivery', () => {
  test('card rotation waits for the generated image on the old tool card', async () => {
    const session = new Session('image-rotation', 'chat_id') as any
    const oldCardId = 'card_image_rotation_old'
    const turn = turnState(oldCardId)
    session.currentTurn = turn
    cardkit.recordCardCreated(oldCardId, 1)
    let release!: (key: string) => void
    setImageUploadHandler(() => new Promise(resolve => { release = resolve }))
    try {
      sessionTools.addTool(session, session.proc, 'image-call', 'ImageGeneration', { revisedPrompt: 'Prompt before rotation' })
      sessionTools.completeTool(session, session.proc, 'image-call', '/tmp/rotated-image.png', false)
      await cardkit.flush(oldCardId)
      session.startMidTurnRotate(turn)
      await waitUntil(() => turn.cardId !== oldCardId)
      const rotating = turn.rotating
      expect(rotating).not.toBeNull()
      release('img_before_rotation')
      await rotating
      expect(calls.some(call => call.path === `/cards/${oldCardId}/elements/tool_0` && String(call.body?.element).includes('img_before_rotation'))).toBe(true)
      expect(sentImages).toEqual([])
      expect(turn.outboundSentPaths.has('/tmp/rotated-image.png')).toBe(true)
    } finally {
      release?.('img_before_rotation')
      if (turn.rotating) await turn.rotating
      session.stopFooterStatus(turn)
      await cardkit.dispose(oldCardId); await cardkit.dispose(turn.cardId); session.dispose()
    }
  })

  test('renders the completed prompt and picture in the tool fold without a separate image message', async () => {
    const session = new Session('image-fold', 'chat_id') as any
    const turn = turnState('card_image_fold')
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)
    try {
      sessionTools.addTool(session, session.proc, 'image-call', 'ImageGeneration', { status: 'inProgress', prompt: 'Original prompt' })
      sessionTools.completeTool(session, session.proc, 'image-call', '/tmp/generated.png', false, { status: 'completed', revisedPrompt: 'Actual image prompt' })
      await sessionTools.waitForImageDeliveries(turn)
      await cardkit.flush(turn.cardId)
      const update = calls.filter(call => call.method === 'PUT' && call.path.endsWith('/elements/tool_0')).at(-1)!
      const element = JSON.parse(update.body.element)
      expect(element.expanded).toBe(false)
      expect(element.header.title.content).not.toContain('Actual image prompt')
      expect(element.elements[0].content).toContain('Original prompt')
      expect(element.elements[0].content).toContain('Actual image prompt')
      expect(element.elements[1]).toMatchObject({ tag: 'img', img_key: 'img_generated', preview: true })
      expect(uploadedImages).toEqual(['/tmp/generated.png'])
      expect(sentImages).toEqual([])
      expect(turn.outboundSentPaths.has('/tmp/generated.png')).toBe(true)
      session.sendOutboundPath('/tmp/generated.png', 'duplicate marker')
      expect(sentLocalFiles).toEqual([])
    } finally { session.stopFooterStatus(turn); await cardkit.dispose(turn.cardId); session.dispose() }
  })

  test('a rejected inline image uses the already uploaded image as one standalone message', async () => {
    const session = new Session('image-separate', 'chat_id') as any
    const turn = turnState('card_image_separate')
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)
    const normalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT' && String(init.body).includes('img_generated')) {
        return Response.json({ code: 200570, msg: 'inline image rejected', error: { log_id: 'inline-image-log' } })
      }
      return normalFetch(input, init)
    }) as typeof fetch
    try {
      sessionTools.addTool(session, session.proc, 'image-call', 'ImageGeneration', { revisedPrompt: 'Prompt stays folded' })
      sessionTools.completeTool(session, session.proc, 'image-call', '/tmp/generated.png', false)
      await sessionTools.waitForImageDeliveries(turn)
      expect(sentImages).toEqual([['chat_id', 'img_generated']])
      expect(uploadedImages).toHaveLength(1)
      expect(sentLocalFiles).toEqual([])
      const update = calls.filter(call => call.method === 'PUT' && call.path.endsWith('/elements/tool_0')).at(-1)!
      expect(JSON.parse(update.body.element).elements[0].content).toContain('图片已单独发送')
      expect(JSON.parse(update.body.element).elements[0].content).toContain('code=200570 message=inline image rejected log_id=inline-image-log')
    } finally { globalThis.fetch = normalFetch; session.stopFooterStatus(turn); await cardkit.dispose(turn.cardId); session.dispose() }
  })

  test('turn close waits for image delivery before retiring its card', async () => {
    const session = new Session('image-close', 'chat_id') as any
    const turn = turnState('card_image_close')
    turn.userOpenId = ''
    session.currentTurn = turn
    session.selectedProvider = 'codex'; session.selectedTokenSourceId = null
    session.currentTokenSource = () => undefined
    cardkit.recordCardCreated(turn.cardId, 1)
    let release!: (key: string) => void
    setImageUploadHandler(() => new Promise(resolve => { release = resolve }))
    try {
      sessionTools.addTool(session, session.proc, 'image-call', 'ImageGeneration', { revisedPrompt: 'Delayed image' })
      sessionTools.completeTool(session, session.proc, 'image-call', '/tmp/delayed.png', false)
      let closed = false
      const close = session.closeTurnCard().then(() => { closed = true })
      await Bun.sleep(10)
      expect(closed).toBe(false)
      release('img_delayed')
      await close
      expect(closed).toBe(true)
      expect(turn.outboundSentPaths.has('/tmp/delayed.png')).toBe(true)
      expect(calls.some(call => call.method === 'PUT' && String(call.body?.element).includes('img_delayed'))).toBe(true)
      expect(sentImages).toEqual([])
    } finally { release?.('img_delayed'); await sessionTools.waitForImageDeliveries(turn); session.stopFooterStatus(turn); await cardkit.dispose(turn.cardId); session.dispose() }
  })

  test.each([true, false])('image status write failure only notifies when image delivery failed (sent: %s)', async sent => {
    const session = new Session('image-note-failure', 'chat_id') as any
    const turn = turnState('card_image_note_failure')
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)
    const send = sent ? null : spyOn(feishu, 'sendImage').mockImplementation(async (_chatId, _key, onFailure) => {
      onFailure?.({ code: 230001, msg: 'image send rejected', error: { log_id: 'image-send-log' } })
      return null
    })
    const normalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT' && String(input).endsWith('/elements/tool_0')) {
        const isImage = String(init.body).includes('img_generated')
        return Response.json({ code: 300121, msg: isImage ? 'image rejected' : 'note rejected',
          error: { log_id: isImage ? 'image-rejection-log' : 'note-rejection-log' } })
      }
      return normalFetch(input, init)
    }) as typeof fetch
    try {
      sessionTools.addTool(session, session.proc, 'image-call', 'ImageGeneration', { revisedPrompt: 'Prompt' })
      sessionTools.completeTool(session, session.proc, 'image-call', '/tmp/generated.png', false)
      await sessionTools.waitForImageDeliveries(turn)
      expect(sentImages).toEqual(sent ? [['chat_id', 'img_generated']] : [])
      expect(turn.outboundSentPaths.has('/tmp/generated.png')).toBe(sent)
      expect(sentRawTexts).toHaveLength(0)
      expect(sentTexts).toHaveLength(sent ? 0 : 1)
      if (!sent) {
        expect(sentTexts[0]).toContain('生成图片发送失败')
        expect(sentTexts[0]).toContain('code=230001 message=image send rejected log_id=image-send-log')
      }
    } finally { send?.mockRestore(); globalThis.fetch = normalFetch; session.stopFooterStatus(turn); await cardkit.dispose(turn.cardId); session.dispose() }
  })

  test('retains an upload rejection returned through the failure callback', async () => {
    const session = new Session('image-upload-failure', 'chat_id') as any
    const turn = turnState('card_image_upload_failure')
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)
    const upload = spyOn(feishu, 'uploadImageKey').mockImplementation(async (_path, onFailure) => {
      onFailure?.({ code: 230001, msg: 'upload rejected', error: { log_id: 'upload-log' } })
      return null
    })
    try {
      sessionTools.addTool(session, session.proc, 'image-call', 'ImageGeneration', { revisedPrompt: 'Prompt' })
      sessionTools.completeTool(session, session.proc, 'image-call', '/tmp/generated.png', false)
      await sessionTools.waitForImageDeliveries(turn)
      expect(sentLocalFiles).toEqual([['chat_id', '/tmp/generated.png']])
      const update = calls.filter(call => call.method === 'PUT' && call.path.endsWith('/elements/tool_0')).at(-1)!
      expect(JSON.parse(update.body.element).elements[0].content).toContain('code=230001 message=upload rejected log_id=upload-log')
    } finally { upload.mockRestore(); session.stopFooterStatus(turn); await cardkit.dispose(turn.cardId); session.dispose() }
  })
})

describe('Session fresh conversation state', () => {
  for (const provider of ['codex', 'claude'] as const) {
    test(`${provider} shows the backend's concrete error in the final card`, async () => {
      const session = new Session('backend-error-detail', 'chat_id') as any
      const proc = new FakeAgentProc(provider, 'error-session')
      const turn = turnState(`card_error_detail_${provider}`)
      turn.provider = provider
      turn.userOpenId = ''
      session.proc = proc
      session.currentTurn = turn
      session.footerUsageSuffix = async () => ''
      session.wireProc(proc)
      cardkit.recordCardCreated(turn.cardId, 1)
      proc.lastResult = { ...proc.lastResult, is_error: true, subtype: 'error_during_execution' }
      try {
        proc.emit('result', { is_error: true, error: 'Account quota exceeded: request was rejected' })
        await session.waitForTurnCloses()
        const footer = calls.find(call => call.method === 'PUT' && call.path === `/cards/${turn.cardId}/elements/footer`)
        expect(footer?.body.element).toContain('Account quota exceeded: request was rejected')
      } finally {
        session.stopFooterStatus(turn)
        await cardkit.dispose(turn.cardId)
      }
    })
  }

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

    const source = { provider: 'codex' as const, sessionId: 'history-thread', cwd: session.workDir }
    const started = await session.startForked({
      kind: 'fork',
      source,
      through: { provider: 'codex', kind: 'turn', id: 'assistant-anchor', source },
    })

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
    ['back selection', async (session: any) => { await session.onBackSelect('stale-panel', 'stale-choice', 'ou_user') }],
    ['resume selection', async (session: any) => { await session.onResumeSelect('stale-panel', 'stale-choice', 'ou_user') }],
    ['rollback', async (session: any) => {
      await session.rollbackTo({
        kind: 'fork',
        source: { provider: 'codex', sessionId: 'history-thread', cwd: session.workDir },
      })
    }],
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

    const ok = await session.rollbackTo({
      kind: 'fork',
      source: { provider: 'claude', sessionId: 'claude-new-thread', cwd: session.workDir },
    })

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

    const rollingBack = session.rollbackTo({
      kind: 'fork',
      source: { provider: 'claude', sessionId: 'claude-new-thread', cwd: session.workDir },
    })
    await restartEntered.promise
    installFailedWatchdogRecovery(session)
    restartRelease.resolve()
    const ok = await rollingBack

    expect(ok).toBe(false)
    expect(session.lastSessionId).toBe('claude-original-thread')
  })

  test('back selection rejects preserved recovery after claim(守卫叠加:claim 通过 ≠ lifecycle 可抢占)', async () => {
    const session = new Session('back-select-preserved', 'chat_id') as any
    session.selectedProvider = 'claude'
    session.lastSessionId = 'sid-current'
    const a1 = {
      checkpoint: {
        provider: 'claude' as const, kind: 'assistant-message' as const, id: 'u1',
        source: { provider: 'claude' as const, sessionId: 'sid-current', cwd: session.workDir },
      },
      preview: '保留输入', ts: 1, writes: [],
    }
    const a2 = { ...a1, checkpoint: { ...a1.checkpoint, id: 'u2' }, preview: '回退输入' }
    turnAnchorsBySession.set('back-select-preserved', [a1, a2])
    branchBaseBySession.set('back-select-preserved', { kind: 'fresh' })
    let rollbackCalls = 0
    session.rollbackTo = async () => { rollbackCalls++; return true }

    await session.showBackList('ou_user')
    const value = pickerValueFromCard(sentCards[0], '回退输入')
    installFailedWatchdogRecovery(session)
    const result = await session.onBackSelect(value.panelId, value.choiceId, 'ou_user')

    expect(result.ok).toBe(false)
    expect(rollbackCalls).toBe(0)
    expect(sentTexts.at(-1)).toContain('自动恢复')
  })

  test('resume selection rejects preserved recovery after claim(守卫叠加)', async () => {
    const session = new Session('resume-select-preserved', 'chat_id') as any
    session.selectedProvider = 'codex'
    session.lastSessionId = 'codex-current'
    session.listCodexConversations = async () => [{
      provider: 'codex' as const,
      sessionId: 'codex-history-thread',
      cwd: session.workDir,
      preview: '历史输入',
      ts: 1,
      status: 'idle',
    }]
    let rollbackCalls = 0
    session.rollbackTo = async () => { rollbackCalls++; return true }

    await session.showResumeList('ou_user')
    const value = pickerValueFromCard(sentCards[0], '历史输入')
    installFailedWatchdogRecovery(session)
    const result = await session.onResumeSelect(value.panelId, value.choiceId, 'ou_user')

    expect(result.ok).toBe(false)
    expect(rollbackCalls).toBe(0)
    expect(sentTexts.at(-1)).toContain('自动恢复')
    expect(sentTexts.some(text => text.includes('在本群恢复会话'))).toBe(false)
  })
})

describe('Session stop/restart kill-unconfirmed alignment (upstream ec149d7 主题 I)', () => {
  test('stop still settles background tasks and reports failure instead of success when kill throws', async () => {
    const session = new Session('stop-kill-unconfirmed', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'thread-stop-unconfirmed')
    session.selectedProvider = 'claude'
    session.proc = proc
    session.status = 'idle'
    proc.kill = async () => {
      proc.killCalls++
      throw new Error('claude process kill timed out after 8000ms; SDK query may still be running')
    }
    let resetCalls = 0
    const originalReset = session.resetBackgroundTasks.bind(session)
    session.resetBackgroundTasks = async (lease?: unknown) => {
      resetCalls++
      return originalReset(lease)
    }

    // 合并调和(取舍):本地旧契约「resolve + ❌ 回执」已并入上游 stop throw
    // 契约 —— 冻结调用方 session-commands.ts kill 命令 / temp-session-runtime.ts
    // 均按 rejection 组装「未确认终止/会话已阻断/停止收尾失败」告警(上游
    // 16923/16992/17062/17110 同断言),resolve 会把告警吞成成功回执。
    await expect(session.stop('已终止')).rejects.toThrow(
      'claude process kill timed out after 8000ms',
    )

    expect(proc.killCalls).toBe(1)
    // kill 抛错不得跳过后续确定性清理(上游 stopUnlocked 的 allSettled 语义)。
    expect(resetCalls).toBe(1)
    // 停不掉不脱管:进程保留为 blockedProc —— shouldRevive() 据此 false,
    // alive marker 不含它「revive 排除」语义由 blockedProc 承担,不再经 proc=null
    // 伪造脱管(上游 16923/17020 同断言)。
    expect(session.proc).toBe(proc)
    expect(session.blockedProc).toBe(proc)
    expect(session.shouldRevive()).toBe(false)
    expect(session.status).toBe('stopped')
    // 不伪造成功:不再发 🔴 终止回执,失败经 rejection 上抛由调用方收口。
    expect(sentTexts.some(text => text.includes('🔴 已终止'))).toBe(false)
  })

  test('restart aborts without spawning a replacement when the old process stop is unconfirmed', async () => {
    const session = new Session('restart-kill-unconfirmed', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-restart-unconfirmed')
    session.selectedProvider = 'codex'
    session.lastSessionId = 'thread-restart-unconfirmed'
    session.proc = proc
    session.status = 'idle'
    proc.kill = async () => {
      proc.killCalls++
      throw new Error('codex process did not exit after SIGKILL')
    }
    let spawnCalls = 0
    session.spawnAgent = () => {
      spawnCalls++
      return new FakeAgentProc('codex', 'thread-replacement')
    }

    const ok = await session.restart(true, { announce: false })

    expect(ok).toBe(false)
    // 上游同语义:stop 未确认不 spawn(同 thread resume 双写风险)。
    expect(spawnCalls).toBe(0)
    // 合并调和(取舍):停不掉不脱管 —— 旧 proc 保留为 blockedProc(上游 17020
    // 同断言),替代本地旧的「kill 前预置 proc=null」伪脱管;shouldRevive() 据此
    // 排除 revive,alive marker 语义不变。
    expect(session.proc).toBe(proc)
    expect(session.blockedProc).toBe(proc)
    expect(session.shouldRevive()).toBe(false)
    expect(session.status).toBe('stopped')
  })

  test('restart with a confirmed kill still spawns the replacement (regression guard)', async () => {
    const session = new Session('restart-kill-confirmed', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'thread-restart-confirmed')
    session.selectedProvider = 'claude'
    session.proc = proc
    session.status = 'idle'
    let spawnCalls = 0
    const replacement = new FakeAgentProc('claude', 'thread-replacement-ok')
    session.spawnAgent = () => {
      spawnCalls++
      return replacement
    }

    const ok = await session.restart(false, { announce: false })

    expect(ok).toBe(true)
    expect(proc.killCalls).toBe(1)
    expect(spawnCalls).toBe(1)
    expect(session.proc).toBe(replacement)
  })
})

describe('Session handler business receipts (upstream ec149d7 主题 I → ff44afb panel 形态)', () => {
  // V4 claude 锚(委托链走真实 session-temp panel 流程;cwd 必须匹配 session.workDir)
  const claudeAnchor = (session: any, id: string, preview: string) => ({
    checkpoint: {
      provider: 'claude' as const, kind: 'assistant-message' as const, id,
      source: { provider: 'claude' as const, sessionId: 'sid-current', cwd: session.workDir },
    },
    preview, ts: 1, writes: [],
  })

  test('onForkSelect returns failure result for an invalid selection instead of chat-text error', async () => {
    const session = new Session('receipt-fork-invalid', 'chat_id') as any
    session.selectedProvider = 'claude'
    session.opts.onCreateTempSession = async () => ({ ok: true })

    const result = await session.onForkSelect('missing-panel', 'missing-choice', 'ou_user')

    expect(result).toMatchObject({ ok: false, replaceCard: false })
    expect(String(result.message)).toContain('已过期')
  })

  test('onForkSelect origin success returns ok result and keeps origin semantics unchanged', async () => {
    const session = new Session('receipt-fork-origin', 'chat_id') as any
    session.selectedProvider = 'claude'
    session.lastSessionId = 'sid-current'
    turnAnchorsBySession.set('receipt-fork-origin', [claudeAnchor(session, 'u1', '起点输入')])
    branchBaseBySession.set('receipt-fork-origin', { kind: 'fresh' })
    let created: any = null
    session.opts.onCreateTempSession = async (opts: any) => { created = opts; return { ok: true } }

    await session.showForkList('ou_user')
    const value = pickerValueFromCard(sentCards[0], '起点输入')
    const result = await session.onForkSelect(value.panelId, value.choiceId, 'ou_user')

    expect(result.ok).toBe(true)
    expect(String(result.message)).toContain('已分叉到')
    // D-02 保护线:起点项 = 会话起点(fresh base),不带 resume 锚点 —— 语义零变化。
    expect(created.launch).toEqual({ kind: 'fresh' })
    expect(created.seedAnchors).toEqual([])
    // 进度提示仍走群消息(上游保留 🔱 preliminary text)。
    expect(sentTexts.some((text: string) => text.includes('分叉到'))).toBe(true)
  })

  test('onForkSelect create failure returns failure payload for the receipt path', async () => {
    const session = new Session('receipt-fork-fail', 'chat_id') as any
    session.selectedProvider = 'claude'
    session.lastSessionId = 'sid-current'
    turnAnchorsBySession.set('receipt-fork-fail', [claudeAnchor(session, 'u1', '失败输入')])
    branchBaseBySession.set('receipt-fork-fail', { kind: 'fresh' })
    session.opts.onCreateTempSession = async () => ({ ok: false, error: '建群超时' })

    await session.showForkList('ou_user')
    const value = pickerValueFromCard(sentCards[0], '失败输入')
    const result = await session.onForkSelect(value.panelId, value.choiceId, 'ou_user')

    expect(result.ok).toBe(false)
    expect(String(result.message)).toContain('分叉失败')
    expect(String(result.message)).toContain('建群超时')
  })

  test('onBackSelect success hands seed anchors to rollbackTo branchState(成功才换锚)', async () => {
    const session = new Session('receipt-back-ok', 'chat_id') as any
    session.selectedProvider = 'claude'
    session.lastSessionId = 'sid-current'
    const a1 = claudeAnchor(session, 'u1', '保留输入')
    const a2 = claudeAnchor(session, 'u2', '回退输入')
    turnAnchorsBySession.set('receipt-back-ok', [a1, a2])
    branchBaseBySession.set('receipt-back-ok', { kind: 'fresh' })
    let captured: any = null
    session.rollbackTo = async (launch: any, branchState: any) => { captured = { launch, branchState }; return true }

    await session.showBackList('ou_user')
    const value = pickerValueFromCard(sentCards[0], '回退输入')
    const result = await session.onBackSelect(value.panelId, value.choiceId, 'ou_user')

    expect(result.ok).toBe(true)
    // 截断语义换代:seedAnchors 经 rollbackTo branchState 原子换(不再走 truncate 壳)。
    expect(captured.branchState).toMatchObject({ anchors: [a1], base: { kind: 'fresh' } })
    expect(captured.launch).toEqual({ kind: 'fork', source: a1.checkpoint.source, through: a1.checkpoint })
    expect(truncatedTurnAnchors).toEqual([])
  })

  test('onBackSelect rollback failure keeps anchors untouched and returns failure result', async () => {
    const session = new Session('receipt-back-fail', 'chat_id') as any
    session.selectedProvider = 'claude'
    session.lastSessionId = 'sid-current'
    const a1 = claudeAnchor(session, 'u1', '保留输入')
    const a2 = claudeAnchor(session, 'u2', '回退输入')
    turnAnchorsBySession.set('receipt-back-fail', [a1, a2])
    branchBaseBySession.set('receipt-back-fail', { kind: 'fresh' })
    session.rollbackTo = async () => false

    await session.showBackList('ou_user')
    const value = pickerValueFromCard(sentCards[0], '回退输入')
    const result = await session.onBackSelect(value.panelId, value.choiceId, 'ou_user')

    expect(result.ok).toBe(false)
    expect(String(result.message)).toContain('回退失败')
    // D-02 判据:失败不动锚点,用户可重试不丢历史。
    expect(turnAnchorsBySession.get('receipt-back-fail')).toEqual([a1, a2])
    expect(truncatedTurnAnchors).toEqual([])
  })

  test('onResumeSelect rejects an invalid selection with a failure result', async () => {
    const session = new Session('receipt-resume-blank', 'chat_id') as any
    session.selectedProvider = 'claude'
    let rollbackCalls = 0
    session.rollbackTo = async () => { rollbackCalls++; return true }

    const result = await session.onResumeSelect('missing-panel', 'missing-choice', 'ou_user')

    expect(result).toMatchObject({ ok: false, replaceCard: false })
    expect(rollbackCalls).toBe(0)
  })

  test('onResumeSelect success clears anchors via branchState; failure leaves them alone', async () => {
    const session = new Session('receipt-resume-ok', 'chat_id') as any
    session.selectedProvider = 'codex'
    session.lastSessionId = 'current-thread'
    session.listCodexConversations = async () => [{
      provider: 'codex' as const, sessionId: 'hist-thread', cwd: session.workDir,
      preview: '历史输入', ts: 1, status: 'idle',
    }]
    let captured: any = null
    session.rollbackTo = async (launch: any, branchState: any) => {
      captured = { launch, branchState }
      session.lastSessionId = 'new-forked-thread'
      return true
    }

    await session.showResumeList('ou_user')
    const value = pickerValueFromCard(sentCards[0], '历史输入')
    const ok = await session.onResumeSelect(value.panelId, value.choiceId, 'ou_user')
    expect(ok.ok).toBe(true)
    expect(ok.resumePresentation?.bindingState).toBe('changed')
    expect(captured.branchState).toMatchObject({ anchors: [], base: captured.launch, pendingLaunch: null })

    resetFeishuMock()
    const failing = new Session('receipt-resume-fail', 'chat_id') as any
    failing.selectedProvider = 'codex'
    failing.lastSessionId = 'current-thread'
    failing.listCodexConversations = async () => [{
      provider: 'codex' as const, sessionId: 'hist-thread', cwd: failing.workDir,
      preview: '历史输入', ts: 1, status: 'idle',
    }]
    failing.rollbackTo = async () => false
    await failing.showResumeList('ou_user')
    const failValue = pickerValueFromCard(sentCards[0], '历史输入')
    const fail = await failing.onResumeSelect(failValue.panelId, failValue.choiceId, 'ou_user')
    expect(fail.ok).toBe(false)
    expect(fail.resumePresentation?.bindingState).toBe('unchanged')
    expect(clearedTurnAnchors).toEqual([])
  })

  test('onAskAnswer returns true for a live answer and false for stray/stale clicks', async () => {
    const session = new Session('receipt-ask', 'chat_id') as any
    session.pendingAsks.set('tool-1', {
      questions: [{ question: '选哪个?', options: [{ label: 'A' }, { label: 'B' }] }],
      i: 0,
      answers: {},
      answered: new Map(),
      currentIdx: 0,
    })

    expect(await session.onAskAnswer('tool-404', 0, 0, 'ou_user')).toBe(false)
    expect(await session.onAskAnswer('tool-1', 3, 0, 'ou_user')).toBe(false)
    expect(await session.onAskAnswer('tool-1', 0, 0, 'ou_user')).toBe(true)
    expect(session.pendingAsks.get('tool-1').answers['选哪个?']).toBe('A')
  })

  test('onAskCustomAnswer propagates advanceAsk outcome instead of unconditional true', async () => {
    const session = new Session('receipt-ask-custom', 'chat_id') as any
    session.pendingAsks.set('tool-1', {
      questions: [{ question: 'q1', options: [] }],
      i: 0,
      answers: {},
      answered: new Map(),
      currentIdx: 0,
    })

    expect(await session.onAskCustomAnswer('tool-1', 0, '自定义答案', 'ou_user')).toBe(true)
    expect(session.pendingAsks.has('tool-1')).toBe(true)
    expect(await session.onAskCustomAnswer('tool-1', 0, '', 'ou_user')).toBe(false)

    // 判别性用例:前置校验全过但 advanceAsk 记账失败(questions 越界)——
    // 旧实现无条件 true(❌ 假回执),新实现透传 advanceAsk 结果 false。
    const broken = new Session('receipt-ask-custom-broken', 'chat_id') as any
    broken.pendingAsks.set('tool-x', {
      questions: [],
      i: 0,
      answers: {},
      answered: new Map(),
      currentIdx: 0,
    })
    expect(await broken.onAskCustomAnswer('tool-x', 0, '答案', 'ou_user')).toBe(false)
  })

  test('onPermissionDecision commits only at protocol response (no proc / send failure keep pending)', async () => {
    const session = new Session('receipt-permission-commit', 'chat_id') as any
    session.pendingPermissions.set('req-1', { toolUseId: 'tu-1' })

    // 无进程:决定未送达,pending 不消费(协议响应为提交点)。
    session.proc = null
    const noProc = await session.onPermissionDecision('req-1', 'allow', 'ou_user')
    expect(noProc.ok).toBe(false)
    expect(session.pendingPermissions.has('req-1')).toBe(true)

    // 发送抛错:同样不消费,可重试。
    const throwing = new FakeAgentProc('claude', 'thread-perm')
    throwing.sendPermissionResponse = () => { throw new Error('stdin gone') }
    session.proc = throwing
    const sendFail = await session.onPermissionDecision('req-1', 'allow', 'ou_user')
    expect(sendFail.ok).toBe(false)
    expect(session.pendingPermissions.has('req-1')).toBe(true)

    // 协议响应落地:才消费 pending 并返回业务成功。
    const proc = new FakeAgentProc('claude', 'thread-perm-ok')
    session.proc = proc
    const done = await session.onPermissionDecision('req-1', 'deny', 'ou_user')
    expect(done.ok).toBe(true)
    expect(proc.permissionResponses).toEqual([['req-1', 'deny', undefined]])
    expect(session.pendingPermissions.has('req-1')).toBe(false)

    // 陈旧请求:失败结果而非静默。
    const stray = await session.onPermissionDecision('req-404', 'allow', 'ou_user')
    expect(stray.ok).toBe(false)
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
  for (const { reason, label, message } of [
    { reason: undefined, label: '模型满载', message: 'Selected model is at capacity' },
    { reason: 'capacity', label: '模型满载', message: 'Selected model is at capacity' },
    { reason: 'stream_disconnected', label: '连接中断', message: 'stream disconnected before completion: An error occurred while processing your request.' },
    { reason: 'compact_connection_failed', label: '压缩连接中断', message: 'Error running remote compact task: Connection failed: error sending request' },
    { reason: 'transient_error', label: '服务暂时异常', message: 'Server overloaded, please try again later.' },
  ] as const) {
    test(`${reason ?? 'legacy capacity'} backoff keeps the card open, renders retry phases and preserves usage before the retry`, async () => {
      const session = new Session('retry-card', 'chat_id') as any
      const proc = new FakeAgentProc('codex', 'retry-thread') as any
      const turn = turnState('card_retry')
      session.proc = proc
      session.currentTurn = turn
      session.status = 'working'
      session.wireProc(proc)
      cardkit.recordCardCreated(turn.cardId, 1)
      try {
        proc.lastTotalUsage = { total_tokens: 100, input_tokens: 80, output_tokens: 20 }
        proc.emit('turn_started', { turn_id: 'original-turn' })
        proc.lastTotalUsage = { total_tokens: 150, input_tokens: 110, output_tokens: 40 }
        proc.turnRetry = { phase: 'waiting', attempt: 1, delayMs: 5_000, message, reason }
        proc.emit('turn_retry', proc.turnRetry)
        session.startWorkingFooter(turn)
        await cardkit.flush(turn.cardId)
        expect(session.status).toBe('working')
        expect(session.currentTurn).toBe(turn)
        expect(turn.footerStatusLabel).toBe(`⏳ ${label} · 5s 后重试 #1`)
        expect(calls.some(call => call.method === 'PUT' && JSON.stringify(call.body).includes(`${label} · 5s 后重试 #1`))).toBe(true)

        proc.turnRetry = { ...proc.turnRetry, phase: 'retrying', delayMs: 0 }
        proc.emit('turn_retry', proc.turnRetry)
        session.startWorkingFooter(turn)
        await cardkit.flush(turn.cardId)
        expect(turn.footerStatusLabel).toBe(`⏳ ${label} · 正在重试 #1`)
        await waitUntil(() => calls.some(call => call.method === 'PUT' && JSON.stringify(call.body).includes(`${label} · 正在重试 #1`)))

        proc.turnRetry = null
        proc.emit('turn_started', { turn_id: 'retry-turn', retry: true })
        expect(turn.footerStatusLabel).not.toContain(label)
        expect(turn.footerStatusLabel).not.toContain('重试')
        proc.lastTotalUsage = { total_tokens: 200, input_tokens: 140, output_tokens: 60 }
        session.accumulateResultStats()
        expect(session.lastTurnUsage).toMatchObject({ total_tokens: 100, input_tokens: 60, output_tokens: 40 })
        expect(session.cumStats.turns).toBe(1)
      } finally {
        session.stopFooterStatus(turn)
        await cardkit.dispose(turn.cardId)
      }
    })

    test(`a card opened after ${reason ?? 'legacy capacity'} failure reads the current retry state`, async () => {
      const session = new Session('retry-card-opening', 'chat_id') as any
      const proc = new FakeAgentProc('codex', 'retry-thread') as any
      session.proc = proc
      session.wireProc(proc)
      proc.turnRetry = { phase: 'waiting', attempt: 1, delayMs: 5_000, message, reason }
      proc.emit('turn_retry', proc.turnRetry)
      const turn = turnState('card_retry_opening')
      session.currentTurn = turn
      cardkit.recordCardCreated(turn.cardId, 1)
      try {
        session.startThinkingFooter(turn)
        expect(turn.footerStatusLabel).toBe(`⏳ ${label} · 5s 后重试 #1`)
      } finally {
        session.stopFooterStatus(turn)
        await cardkit.dispose(turn.cardId)
      }
    })
  }

  test('buffers assistant deltas and inserts one completed markdown element without content streaming', async () => {
    // 本测断言 bucket 档位文案；显式钉死模式，隔离本机配置差异。
    const cfg = config as any
    const previousRuntime = cfg.runtime
    cfg.runtime = { ...(previousRuntime ?? {}), live_elapsed: 'bucket' }
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
      await waitUntil(() => !turn.footerStatusWriteCardId)

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
      expect(footerWrites.some(content => content.startsWith('Writing... (<30s)'))).toBe(true)
      expect(footerWrites.some(content => content.startsWith('Working... (<30s)'))).toBe(true)
      expect(calls.some(call => call.path.endsWith('/content'))).toBe(false)
    } finally {
      session.stopFooterStatus(turn)
      if (previousRuntime === undefined) delete cfg.runtime
      else cfg.runtime = previousRuntime
      await cardkit.dispose(turn.cardId)
    }
  })

  test('chat-list preview takes the head 40 chars of assistant text, not the tail (upstream 8de138c)', async () => {
    const session = new Session('probe', 'chat_id') as any
    const turn = turnState()
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)
    const previews: string[] = []
    const summarySpy = spyOn(cardkit, 'patchSummaryThrottled').mockImplementation(
      (_cardId: string, content: string) => { previews.push(content) },
    )

    try {
      // 100 字正文:头部 40 与尾部 60 无重叠,能区分新旧行为。
      const body = '预览主题在开头这里' + 'x'.repeat(91)
      session.appendAssistant(body)

      expect(previews.length).toBeGreaterThan(0)
      const preview = previews.at(-1)
      expect(preview).toBe(body.slice(0, 40))
      expect(preview).not.toBe(body.slice(-60))
    } finally {
      summarySpy.mockRestore()
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('routes askusr host markers to host-ask cards on Claude too', async () => {
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

      // Claude 现在也认 askusr 文本 marker:建 pendingHostAsks、弹 host_ask 卡。
      expect(session.pendingHostAsks.size).toBe(1)
      await waitFor(() => sentCards.length >= 1)
      const assistantAdd = calls.find(call =>
        call.method === 'POST' &&
        call.path === `/cards/${turn.cardId}/elements`
      )
      const elements = JSON.parse(assistantAdd?.body.elements ?? '[]')
      expect(elements[0]?.content).not.toContain('askusr')
      expect(elements[0]?.content).toContain('已发起澄清问题')
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })
})

describe('Session ordered formula rendering across providers', () => {
  const renderedBlocks = {
    blocks: [
      { type: 'markdown' as const, text: '前文' },
      {
        type: 'image' as const,
        element: {
          tag: 'img', img_key: 'img_v2_formula_x',
          alt: { tag: 'plain_text', content: 'x' }, size: '40px 20px',
        },
      },
      { type: 'markdown' as const, text: '中段' },
      {
        type: 'image' as const,
        element: {
          tag: 'img', img_key: 'img_v2_formula_y',
          alt: { tag: 'plain_text', content: 'y' }, size: '42px 20px',
        },
      },
      { type: 'markdown' as const, text: '后文' },
    ],
    formulaCount: 2,
    renderedImageCount: 2,
  }

  test('raw and rendered states keep one column_set element on both backends', async () => {
    const session = new Session('math-order', 'chat_id') as any
    const renderSpy = spyOn(mathRender, 'renderMathInText').mockResolvedValue(renderedBlocks as any)
    const replaceSpy = spyOn(cardkit, 'replaceElementChecked').mockResolvedValue(true)

    try {
      for (const provider of ['codex', 'claude'] as const) {
        const turn = turnState(`card_math_${provider}`)
        turn.provider = provider
        const raw = session.completedAssistantElement('assistant_0', '前文 $$x$$ 后文') as any
        expect(raw.tag).toBe('column_set')
        expect(raw.element_id).toBe('assistant_0')

        await session.replaceSegmentWithMathImgs(
          turn, turn.cardId, 'assistant_0', '前文 $$x$$ 中段 $$y$$ 后文',
        )
        const replacement = replaceSpy.mock.calls.at(-1)?.[2] as any
        expect(replacement.tag).toBe('column_set')
        expect(replacement.element_id).toBe('assistant_0')
        expect(replacement.columns[0].elements.map((element: any) => element.tag)).toEqual([
          'markdown', 'img', 'markdown', 'img', 'markdown',
        ])
        expect(replaceSpy.mock.calls.at(-1)?.[3]).toEqual({ notifyCardFailure: false })
        expect(turn.mathRendered.get(turn.cardId).has('assistant_0')).toBe(true)
      }
    } finally {
      renderSpy.mockRestore()
      replaceSpy.mockRestore()
    }
  })

  test('keeps visible raw LaTeX when the atomic formula enhancement fails', async () => {
    const session = new Session('math-raw', 'chat_id') as any
    const turn = turnState('card_math_raw')
    turn.provider = 'claude'
    const renderSpy = spyOn(mathRender, 'renderMathInText').mockResolvedValue(renderedBlocks as any)
    const replaceSpy = spyOn(cardkit, 'replaceElementChecked').mockResolvedValue(false)

    try {
      await session.replaceSegmentWithMathImgs(
        turn, turn.cardId, 'assistant_0', '前文 $$x$$ 中段 $$y$$ 后文',
      )
      expect(replaceSpy).toHaveBeenCalledTimes(1)
      expect(turn.mathRendered?.get(turn.cardId)?.has('assistant_0')).not.toBe(true)
    } finally {
      renderSpy.mockRestore()
      replaceSpy.mockRestore()
    }
  })

  test('preserves the complete reply if the final formula container was never created', async () => {
    const session = new Session('math-close-fallback', 'chat_id') as any
    const turn = turnState('card_math_close_fallback')
    const rawReply = '前文\n\n$$x^2+y^2=z^2$$\n\n后文'
    turn.provider = 'claude'
    turn.userOpenId = ''
    turn.currentAssistantSegmentId = 'assistant_0'
    turn.currentAssistantText = rawReply
    turn.segmentTexts.set('assistant_0', rawReply)
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      const failedBodyAdd = method === 'POST' && path === `/cards/${turn.cardId}/elements`
      return new Response(JSON.stringify(failedBodyAdd
        ? { code: 300308, msg: 'card element rejected' }
        : { code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    await session.closeTurnCard(undefined, { hasFreshResult: false })

    expect(sentTexts).toHaveLength(1)
    expect(sentTexts[0]).toContain('对话卡片正文写入失败')
    expect(sentTexts[0]).toContain(rawReply)
    expect(sentRawTexts).toHaveLength(0)
  })

  test('超长含公式段整体退回普通截断路径,公式降级可见且不进渲染管线(12k 锁定,开放问题 1)', async () => {
    const session = new Session('math-12k', 'chat_id') as any
    const turn = turnState('card_math_12k')
    turn.provider = 'claude'
    // 公式置于文本头部,保证截断后仍在可见窗内;清洗后总长 > 12k 触发普通截断路径。
    const longText = '$$x^2+y^2$$\n\n' + 'A'.repeat(13_000)

    // 断言点 1/2/3:非 column_set + 截断标记在位(200860 防线)+ 公式经
    // sanitize→downgradeMathBlocksInProse 降级为代码块可见,不静默消失。
    const element = session.completedAssistantElement('assistant_0', longText) as any
    expect(element.tag).toBe('markdown')
    expect(element.element_id).toBe('assistant_0')
    expect(element.content).toContain('正文已截断')
    expect(element.content).toContain('```\nx^2+y^2\n```')

    // 断言点 4:渲染准入与 completedAssistantElement 同源(mathSegmentEligible)
    // ——超长段 raw 落地成功也不登记渲染 promise。
    cardkit.recordCardCreated(turn.cardId, 1)
    try {
      const added = await session.addCompletedAssistantSegment(turn, 'assistant_0', longText)
      expect(added).toBe(true)
      expect(turn.mathRenderInflight?.get(turn.cardId)?.size ?? 0).toBe(0)
    } finally {
      await cardkit.dispose(turn.cardId)
    }
  })
})

describe('session-tools tool-stage chat-list preview (upstream 8de138c)', () => {
  function toolPreviewFixture(cardId: string) {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'sess-tool-preview')
    session.proc = proc
    const turn = turnState(cardId)
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)
    return { session, proc, turn }
  }

  test('普通工具进入渲染完成点后,预览同步为 🔧 工具名: 摘要', async () => {
    const { session, proc, turn } = toolPreviewFixture('card_tool_preview_1')
    const previews: Array<{ cardId: string; content: string }> = []
    const summarySpy = spyOn(cardkit, 'patchSummaryThrottled').mockImplementation(
      (cardId: string, content: string) => { previews.push({ cardId, content }) },
    )
    try {
      sessionTools.addTool(session, proc as any, 'tool-preview-1', 'Bash', { command: 'ls -la' })
      expect(previews).toEqual([{ cardId: turn.cardId, content: '🔧 Bash: ls -la' }])
    } finally {
      summarySpy.mockRestore()
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('摘要超 80 字时截断到 80 字加省略号', async () => {
    const { session, proc, turn } = toolPreviewFixture('card_tool_preview_2')
    const previews: Array<{ cardId: string; content: string }> = []
    const summarySpy = spyOn(cardkit, 'patchSummaryThrottled').mockImplementation(
      (cardId: string, content: string) => { previews.push({ cardId, content }) },
    )
    try {
      // write_stdin 的 session_id 在 summarizeToolInput 内部不截断 → raw 超 80 字,
      // 由 toolSummaryToPreview 自身的 80 字防御截断兜住(照上游实现)。
      const raw = `发送输入 ${'x'.repeat(100)}`
      sessionTools.addTool(session, proc as any, 'tool-preview-2', 'write_stdin', {
        session_id: 'x'.repeat(100), chars: 'abc',
      })
      expect(previews).toEqual([{ cardId: turn.cardId, content: `🔧 Bash: ${raw.slice(0, 80)}…` }])
    } finally {
      summarySpy.mockRestore()
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('非主 turn 卡路径不触发工具预览(无 currentTurn 直接丢弃;AskUserQuestion 保持专属 ❓ 预览)', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'sess-tool-preview-3')
    session.proc = proc
    const previews: string[] = []
    const summarySpy = spyOn(cardkit, 'patchSummaryThrottled').mockImplementation(
      (_cardId: string, content: string) => { previews.push(content) },
    )
    try {
      // 无 currentTurn(主 turn 卡不存在,如轮外/bg 场景):addTool 直接 return,
      // 不产生任何聊天列表预览。
      sessionTools.addTool(session, proc as any, 'tool-preview-3', 'Bash', { command: 'echo bg' })
      expect(previews).toEqual([])

      // AskUserQuestion 分支有专属 ❓ 预览(cancelSummary + 直接 patchSettings +
      // 加急推送),不得被 🔧 工具预览覆盖 —— 上游 4 个插入点同样不含该分支。
      const turn = turnState('card_ask_preview')
      session.currentTurn = turn
      cardkit.recordCardCreated(turn.cardId, 1)
      sessionTools.addTool(session, proc as any, 'ask-preview-1', 'AskUserQuestion', {
        questions: [{ question: 'Pick?', options: ['A', 'B'] }],
      })
      expect(previews).toEqual([])
      await waitFor(() => urgentPushes.length >= 1)
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    } finally {
      summarySpy.mockRestore()
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

  // 场景①(终态语义):transcript 不足时 compactThread 收到 "Not enough messages to compact"
  // 固定文案后 reject NothingToCompactError,runCompactCommand 显示 ⓘ 而非 ❌ 失败/超时。
  test('Claude /compact 上下文不足 → NothingToCompactError → ⓘ 无需压缩', async () => {
    class ClaudeFakeProc extends EventEmitter {
      readonly provider = 'claude' as const
      sessionId = 'claude_thread_compact'
      compactCalls = 0
      isAlive(): boolean { return true }
      async compactThread(): Promise<void> {
        this.compactCalls++
        // 终态:CLI 回 "Not enough messages to compact." 文案,compactThread 自身 reject
        throw new NothingToCompactError()
      }
    }

    const session = new Session('probe', 'chat_id') as any
    const proc = new ClaudeFakeProc()
    session.proc = proc
    session.status = 'idle'
    session.initCount = 1
    session.pendingUserMessageCount = 0

    await expect(session.runCommand('cm')).resolves.toBe(true)
    expect(proc.compactCalls).toBe(1)
    const footerWrites = calls
      .filter(call => call.method === 'PUT' && call.path.endsWith('/elements/footer'))
      .map(call => JSON.parse(call.body.element).content as string)
    expect(footerWrites.some(content => content.includes('ⓘ 上下文窗口充足，无需压缩'))).toBe(true)
    expect(footerWrites.some(content => content.includes('❌'))).toBe(false)
    expect(session.manualContextCompactionPending).toBe(false)
  })

  // 场景②(f8940bd 修的核心 bug,集成层钉扎):大上下文慢压缩时 result 先到、
  // compact_boundary 晚到 —— watch 不得再据 result 误报"无需压缩",必须等到 boundary 后 ✅。
  test('Claude /compact boundary 晚于 result 到达 → ✅ 正常完成,不误报无需压缩', async () => {
    class ClaudeFakeProc extends EventEmitter {
      readonly provider = 'claude' as const
      sessionId = 'claude_thread_slow_compact'
      turnId = 'turn_slow_compact'
      compactCalls = 0
      isAlive(): boolean { return true }
      async compactThread(): Promise<void> {
        this.compactCalls++
        // 慢压缩时序:result 先到(旧 onResult 兜底在此误报),boundary 迟到才是完成信号
        this.emit('result', { subtype: 'success', is_error: false, thread_id: this.sessionId })
        await new Promise(r => setTimeout(r, 30))
        this.emit('token_usage', {
          usage: { total_tokens: 12_000 },
          totalUsage: { total_tokens: 12_000 },
          contextWindow: 258_000,
          threadId: this.sessionId,
          turnId: this.turnId,
        })
        this.emit('context_compacted', {
          phase: 'end',
          threadId: this.sessionId,
          turnId: this.turnId,
        })
      }
    }

    const session = new Session('probe', 'chat_id') as any
    const proc = new ClaudeFakeProc()
    session.proc = proc
    session.status = 'idle'
    session.initCount = 1
    session.pendingUserMessageCount = 0

    await expect(session.runCommand('cm')).resolves.toBe(true)
    expect(proc.compactCalls).toBe(1)
    const footerWrites = calls
      .filter(call => call.method === 'PUT' && call.path.endsWith('/elements/footer'))
      .map(call => JSON.parse(call.body.element).content as string)
    expect(footerWrites.some(content => content.includes('✅ 上下文已压缩'))).toBe(true)
    expect(footerWrites.some(content => content.includes('无需压缩'))).toBe(false)
    expect(session.manualContextCompactionPending).toBe(false)
  })
})

describe('Claude model refusal fallback', () => {
  test('session-scope fallback sets 降级 notice + footer override', () => {
    const { session, proc, turn } = wiredWatchdogSession('claude')
    proc.emit('model_refusal_fallback', {
      trigger: 'refusal',
      direction: 'retry',
      original_model: 'claude-sonnet-4-5',
      fallback_model: 'claude-haiku-4-5',
      scope: 'session',
      request_id: 'r1',
      content: '',
      uuid: 'u1',
      session_id: proc.sessionId!,
    })
    expect(turn.modelFallbackNotice).toContain('降级')
    expect(turn.modelFallbackNotice).toContain('sonnet-4-5')
    expect(turn.modelFallbackNotice).toContain('haiku-4-5')
    expect(turn.footerStatusOverride).toBe(turn.modelFallbackNotice)
    session.stopFooterStatus(turn)
  })

  test('local-scope fallback labels 子任务降级', () => {
    const { session, proc, turn } = wiredWatchdogSession('claude')
    proc.emit('model_refusal_fallback', {
      trigger: 'refusal',
      direction: 'retry',
      original_model: 's',
      fallback_model: 'h',
      scope: 'local',
      request_id: 'r1',
      content: '',
      uuid: 'u1',
      session_id: proc.sessionId!,
    })
    expect(turn.modelFallbackNotice).toContain('子任务降级')
    session.stopFooterStatus(turn)
  })

  test('no_fallback sets 拒绝 notice', () => {
    const { session, proc, turn } = wiredWatchdogSession('claude')
    proc.emit('model_refusal_no_fallback', {
      original_model: 'claude-sonnet-4-5',
      request_id: 'r1',
      api_refusal_category: 'cyber',
      content: '',
      uuid: 'u1',
      session_id: proc.sessionId!,
    })
    expect(turn.modelFallbackNotice).toContain('拒绝')
    expect(turn.modelFallbackNotice).toContain('sonnet-4-5')
    session.stopFooterStatus(turn)
  })

  test('second fallback on the same turn is ignored (idempotent)', () => {
    const { session, proc, turn } = wiredWatchdogSession('claude')
    proc.emit('model_refusal_fallback', {
      trigger: 'refusal', direction: 'retry',
      original_model: 's', fallback_model: 'h', scope: 'session',
      request_id: 'r1', content: '', uuid: 'u1', session_id: proc.sessionId!,
    })
    const first = turn.modelFallbackNotice
    proc.emit('model_refusal_no_fallback', {
      original_model: 's', request_id: 'r2', content: '', uuid: 'u2', session_id: proc.sessionId!,
    })
    expect(turn.modelFallbackNotice).toBe(first)
    expect(turn.modelFallbackNotice).toContain('降级')
    session.stopFooterStatus(turn)
  })

  test('fallback with no active turn is ignored without throwing', () => {
    const { session, proc } = wiredWatchdogSession('claude')
    session.currentTurn = null
    expect(() => proc.emit('model_refusal_fallback', {
      trigger: 'refusal', direction: 'retry',
      original_model: 's', fallback_model: 'h', scope: 'session',
      request_id: 'r', content: '', uuid: 'u', session_id: 's',
    })).not.toThrow()
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
      glm: { model: 'glm-5.3', base_url: 'https://open.bigmodel.cn/api/anthropic', auth_token: 't', effort: 'xhigh' },
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
    ;(config.claude as any).models = { glm: { model: 'glm-5.3', base_url: 'https://x', auth_token: 't' } }
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

  test('未配置的 codex api 档位(缺 model)回落 gpt-5.6-sol/max', () => {
    const prev = config.codex.models
    ;(config.codex as any).models = { broken: { base_url: 'https://x', api_key: 'sk' } }
    try {
      const r = normalizeFixedModelSelection('codex', 'codex:broken', null)
      expect(r.model).toBe('gpt-5.6-sol')
      expect(r.effort).toBe('max')
    } finally {
      ;(config.codex as any).models = prev
    }
  })

  test('裸 gpt-5.6-sol 保持登录默认档', () => {
    expect(normalizeFixedModelSelection('codex', 'gpt-5.6-sol', null).model).toBe('gpt-5.6-sol')
  })

  test('legacy 裸 gpt-5.5(旧持久化)归一到 gpt-5.6-sol/max', () => {
    expect(normalizeFixedModelSelection('codex', 'gpt-5.5', 'xhigh'))
      .toEqual({ model: 'gpt-5.6-sol', effort: 'max' })
  })
})

describe('Grok routes through Claude', () => {
  test('旧 codex:grok/grokcc 持久选择迁到同名 Claude API 档位', () => {
    const prevClaude = config.claude.models
    const prevCodex = config.codex.models
    ;(config.claude as any).models = {
      grok: { model: 'grok-4.6', base_url: 'https://api.wuhen-ai.com', auth_token: 'w', effort: 'xhigh' },
      grokcc: { model: 'grok-4.6', base_url: 'https://catcodexapi.com', auth_token: 'c', effort: 'xhigh' },
    }
    ;(config.codex as any).models = {
      grok: {
        model: 'grok-4.6',
        base_url: 'https://api.wuhen-ai.com',
        wire_api: 'responses',
        api_key: 't',
        effort: 'xhigh',
      },
    }
    try {
      for (const name of ['grok', 'grokcc']) {
        const effort = 'xhigh'
        expect(normalizePersistedModelSelection('codex', `codex:${name}`, 'max')).toEqual({
          provider: 'claude',
          model: `claude:${name}`,
          effort,
        })
        expect(normalizePersistedModelSelection('claude', `claude:${name}`, 'max')).toEqual({
          provider: 'claude',
          model: `claude:${name}`,
          effort,
        })
      }
    } finally {
      ;(config.claude as any).models = prevClaude
      ;(config.codex as any).models = prevCodex
    }
  })

  test('没有 Claude Grok 凭据时旧 Codex Grok 回落 Claude Fable 而非继续启 Codex', () => {
    const prevClaude = config.claude.models
    const prevCodex = config.codex.models
    ;(config.claude as any).models = {}
    ;(config.codex as any).models = {
      grok: { model: 'grok-4.6', base_url: 'https://api.wuhen-ai.com', api_key: 't' },
    }
    try {
      expect(normalizePersistedModelSelection('codex', 'codex:grok', 'max')).toEqual({
        provider: 'claude',
        model: 'claude:fable',
        effort: 'max',
      })
    } finally {
      ;(config.claude as any).models = prevClaude
      ;(config.codex as any).models = prevCodex
    }
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
      expect(configuredDefaultSelection()).toEqual({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'max' })
      ;(config.claude as any).defaultModel = 'gpt-5.5'
      expect(configuredDefaultSelection()).toEqual({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'max' })
    } finally {
      ;(config.claude as any).defaultModel = prevDefault
    }
  })

  test('default_model=codex:grok 迁到 Claude，无前缀 grokcc 直接选 Claude', () => {
    const prevClaudeModels = config.claude.models
    const prevModels = config.codex.models
    const prevDefault = config.claude.defaultModel
    ;(config.claude as any).models = {
      grok: { model: 'grok-4.6', base_url: 'https://api.wuhen-ai.com', auth_token: 'w', effort: 'xhigh' },
      grokcc: { model: 'grok-4.6', base_url: 'https://catcodexapi.com', auth_token: 'c', effort: 'xhigh' },
    }
    ;(config.codex as any).models = {
      grok: {
        model: 'grok-4.6',
        base_url: 'https://api.wuhen-ai.com',
        wire_api: 'responses',
        api_key: 't',
        effort: 'high',
      },
    }
    try {
      ;(config.claude as any).defaultModel = 'codex:grok'
      expect(configuredDefaultSelection()).toEqual({
        provider: 'claude',
        model: 'claude:grok',
        effort: 'xhigh',
      })
      ;(config.claude as any).defaultModel = 'grokcc'
      expect(configuredDefaultSelection()).toEqual({
        provider: 'claude',
        model: 'claude:grokcc',
        effort: 'xhigh',
      })
    } finally {
      ;(config.claude as any).models = prevClaudeModels
      ;(config.codex as any).models = prevModels
      ;(config.claude as any).defaultModel = prevDefault
    }
  })
})

describe('新 session 默认档位来自 [claude] default_model', () => {
  test('default_model=glm(配好 token)→ 新群首条消息默认走 GLM', () => {
    const prevModels = config.claude.models
    const prevDefault = config.claude.defaultModel
    ;(config.claude as any).models = {
      glm: { model: 'glm-5.3', base_url: 'https://open.bigmodel.cn/api/anthropic', auth_token: 't', effort: 'xhigh' },
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

  test('keeps a CONFIGURED DeepSeek selection intact (deepseek 为活跃第三方档位)', () => {
    // 2026-08-13 deepseek 复活:走 [claude.models.deepseek] 官网 /anthropic 端点,
    // configured 时不再被当退役项回落(与 GLM 同构)。
    const prev = config.claude.models
    ;(config.claude as any).models = {
      deepseek: { model: 'deepseek-v4-pro', base_url: 'https://api.deepseek.com/anthropic', auth_token: 'tok', effort: 'xhigh' },
    }
    try {
      expect(normalizeFixedModelSelection('claude', 'claude:deepseek', 'high'))
        .toEqual({ model: 'claude:deepseek', effort: 'xhigh' })
    } finally {
      ;(config.claude as any).models = prev
    }
  })

  test('resets an unknown/retired Claude model to the Claude default', () => {
    expect(normalizeFixedModelSelection('claude', 'claude:retired-legacy', 'high'))
      .toEqual({ model: 'claude:fable', effort: 'max' })
  })

  test('normalizes any Codex selection to the fixed GPT-5.6 Sol / max', () => {
    expect(normalizeFixedModelSelection('codex', 'gpt-4', 'low'))
      .toEqual({ model: 'gpt-5.6-sol', effort: 'max' })
  })
})

describe('Session automatic context compaction events', () => {
  test('deduplicates repeated completion for the same compaction item', async () => {
    const session = new Session('compact-dedupe', 'chat_id') as any
    const turn = turnState('card_compact_dedupe')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)
    const start = {
      phase: 'start', threadId: 'thread_1', turnId: 'turn_1', itemId: 'compact_1',
    }
    const end = {
      phase: 'end', threadId: 'thread_1', turnId: 'turn_1', itemId: 'compact_1',
    }

    try {
      session.handleContextCompacted(start)
      session.handleContextCompacted(end)
      session.handleContextCompacted({ ...end, sourceMethod: 'rawResponseItem/completed' })
      // Same physical completion through a turn-only surface, then an
      // anonymous legacy surface, must both be coalesced even before the
      // first Card Kit write has landed.
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_1', turnId: 'turn_1',
      })
      session.handleContextCompacted({ phase: 'event' })
      await cardkit.flush(turn.cardId)
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_1'))

      expect(turn.contextCompactCount).toBe(1)
      expect(turn.contextCompactionPending.size).toBe(0)
      expect(turn.contextCompactionCompleted.has('compact_1')).toBe(true)
      const compactAdds = calls.filter(call =>
        call.method === 'POST' &&
        call.path === `/cards/${turn.cardId}/elements` &&
        JSON.parse(call.body.elements)[0]?.element_id === 'context_compact_0'
      )
      const compactReplaces = calls.filter(call =>
        call.method === 'PUT' &&
        call.path === `/cards/${turn.cardId}/elements/context_compact_0`
      )
      expect(compactAdds).toHaveLength(1)
      expect(compactReplaces).toHaveLength(1)
      expect(sentRawTexts).toHaveLength(0)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('treats a completion delivered after card close as a logged lifecycle event', () => {
    const session = new Session('compact-after-close', 'chat_id') as any

    session.handleContextCompacted({
      phase: 'end', threadId: 'thread_closed', turnId: 'turn_closed', itemId: 'compact_closed',
    })

    expect(sentRawTexts).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  test('deduplicates generic-turn completion followed by an item completion', async () => {
    const session = new Session('compact-alias-order', 'chat_id') as any
    const turn = turnState('card_compact_alias_order')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    try {
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_alias', turnId: 'turn_alias',
      })
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_alias', turnId: 'turn_alias', itemId: 'compact_alias',
      })
      await cardkit.flush(turn.cardId)
      await waitUntil(() => turn.contextCompactionCompleted.has('turn_alias'))

      expect(turn.contextCompactCount).toBe(1)
      let compactAdds = calls.filter(call =>
        call.method === 'POST' &&
        call.path === `/cards/${turn.cardId}/elements` &&
        JSON.parse(call.body.elements)[0]?.element_id?.startsWith('context_compact_')
      )
      expect(compactAdds).toHaveLength(1)
      // Once compact_alias claimed the generic turn receipt, a different
      // explicit item in the same turn must remain a new compaction.
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_alias', turnId: 'turn_alias', itemId: 'compact_alias_b',
      })
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_alias_b'))
      compactAdds = calls.filter(call =>
        call.method === 'POST' &&
        call.path === `/cards/${turn.cardId}/elements` &&
        JSON.parse(call.body.elements)[0]?.element_id?.startsWith('context_compact_')
      )
      expect(compactAdds).toHaveLength(2)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('deduplicates an anonymous completion followed by an identified alias', async () => {
    const session = new Session('compact-anonymous-alias', 'chat_id') as any
    const turn = turnState('card_compact_anonymous_alias')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    try {
      session.handleContextCompacted({ phase: 'event' })
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_anon', turnId: 'turn_anon', itemId: 'compact_anon',
      })
      await cardkit.flush(turn.cardId)
      await waitUntil(() => turn.lastContextCompactionWasAnonymous)

      expect(turn.contextCompactCount).toBe(1)
      const compactAdds = calls.filter(call =>
        call.method === 'POST' &&
        call.path === `/cards/${turn.cardId}/elements` &&
        JSON.parse(call.body.elements)[0]?.element_id?.startsWith('context_compact_')
      )
      expect(compactAdds).toHaveLength(1)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('a distinct explicit item in the same backend turn is not swallowed by the turn alias', async () => {
    const session = new Session('compact-distinct-items', 'chat_id') as any
    const turn = turnState('card_compact_distinct_items')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    try {
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_shared', turnId: 'turn_shared', itemId: 'compact_item_a',
      })
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_item_a'))
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_shared', turnId: 'turn_shared', itemId: 'compact_item_b',
      })
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_item_b'))

      expect(turn.contextCompactCount).toBe(2)
      const compactAdds = calls.filter(call =>
        call.method === 'POST' &&
        call.path === `/cards/${turn.cardId}/elements` &&
        JSON.parse(call.body.elements)[0]?.element_id?.startsWith('context_compact_')
      )
      expect(compactAdds).toHaveLength(2)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('an explicit unmatched item completion does not consume another pending item', async () => {
    const session = new Session('compact-item-owner', 'chat_id') as any
    const turn = turnState('card_compact_item_owner')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    try {
      session.handleContextCompacted({
        phase: 'start', threadId: 'thread_items', turnId: 'turn_items', itemId: 'compact_a',
      })
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_items', turnId: 'turn_items', itemId: 'compact_b',
      })
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_b'))

      expect(turn.contextCompactionPending.has('compact_a')).toBe(true)
      expect(turn.contextCompactCount).toBe(2)
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_items', turnId: 'turn_items', itemId: 'compact_a',
      })
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_a'))
      expect(turn.contextCompactionPending.size).toBe(0)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('does not attach an old turn compaction completion to a newer turn', async () => {
    const session = new Session('compact-owner', 'chat_id') as any
    const oldTurn = turnState('card_compact_owner_old')
    oldTurn.userOpenId = ''
    session.currentTurn = oldTurn
    cardkit.recordCardCreated(oldTurn.cardId, 1)
    session.handleContextCompacted({
      phase: 'start', threadId: 'thread_owner', turnId: 'turn_old', itemId: 'compact_owner',
    })
    await cardkit.flush(oldTurn.cardId)

    const newTurn = turnState('card_compact_owner_new')
    newTurn.userOpenId = ''
    session.currentTurn = newTurn
    cardkit.recordCardCreated(newTurn.cardId, 1)

    try {
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_owner', turnId: 'turn_old', itemId: 'compact_owner',
      })
      await cardkit.flush(newTurn.cardId)

      expect(newTurn.contextCompactCount).toBe(0)
      expect(newTurn.contextCompactionPending.size).toBe(0)
      expect(calls.some(call =>
        call.path === `/cards/${newTurn.cardId}/elements` &&
        call.method === 'POST' &&
        JSON.parse(call.body.elements)[0]?.element_id?.startsWith('context_compact_')
      )).toBe(false)
      expect(sentRawTexts).toHaveLength(0)
    } finally {
      session.stopFooterStatus(oldTurn)
      session.stopFooterStatus(newTurn)
      await cardkit.dispose(oldTurn.cardId)
      await cardkit.dispose(newTurn.cardId)
    }
  })

  test('buffers compaction events while the conversation card is opening', async () => {
    const session = new Session('compact-open-window', 'chat_id') as any
    session.pendingTurnInputs = ['hello']
    const owner = session.beginTurnOpen(null, 0, true)
    let signalConvertStarted: () => void = () => {}
    const convertStarted = new Promise<void>(resolve => { signalConvertStarted = resolve })
    let releaseConvert: () => void = () => {}
    const convertGate = new Promise<void>(resolve => { releaseConvert = resolve })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (path === '/cards/id_convert') {
        signalConvertStarted()
        await convertGate
        return new Response(JSON.stringify({ code: 0, data: { card_id: 'card_compact_opened' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const opening = session.openTurnCard(owner, '', 'user_message')
    await convertStarted
    session.handleContextCompacted({
      phase: 'start', threadId: 'thread_open', turnId: 'turn_open', itemId: 'compact_open',
    })
    session.handleContextCompacted({
      phase: 'end', threadId: 'thread_open', turnId: 'turn_open', itemId: 'compact_open',
    })
    expect(owner.pendingCompactions).toHaveLength(2)

    let turn: any = null
    try {
      releaseConvert()
      turn = await opening
      expect(turn?.cardId).toBe('card_compact_opened')
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_open'))
      expect(turn.contextCompactCount).toBe(1)
      expect(sentRawTexts).toHaveLength(0)
    } finally {
      releaseConvert()
      session.releaseTurnOpen(owner)
      if (turn) {
        session.stopFooterStatus(turn)
        await cardkit.dispose(turn.cardId)
      }
    }
  })

  test('an eager pre-input card open does not claim a late prior-turn compaction', () => {
    const session = new Session('compact-eager-open', 'chat_id') as any
    const owner = session.beginTurnOpen(null, 0, false)

    session.handleContextCompacted({
      phase: 'end', threadId: 'thread_prior', turnId: 'turn_prior', itemId: 'compact_prior',
    })

    expect(owner.pendingCompactions).toHaveLength(0)
    expect(sentRawTexts).toHaveLength(0)
    session.releaseTurnOpen(owner)
  })

  test('manual compact completion never leaks into a newly opened turn', async () => {
    const session = new Session('compact-manual-owner', 'chat_id') as any
    const turn = turnState('card_compact_manual_owner')
    session.currentTurn = turn
    session.manualContextCompactionPending = true
    cardkit.recordCardCreated(turn.cardId, 1)

    try {
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_manual', turnId: 'turn_manual', itemId: 'compact_manual',
      })
      session.manualContextCompactionPending = false
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_manual', turnId: 'turn_manual',
      })
      session.handleContextCompacted({ phase: 'event' })

      expect(turn.contextCompactCount).toBe(0)
      expect(turn.contextCompactionPending.size).toBe(0)
      expect(calls).toHaveLength(0)
    } finally {
      session.manualContextCompactionPending = false
      await cardkit.dispose(turn.cardId)
    }
  })

  test('an anonymous manual completion tombstones an immediate identified alias', async () => {
    const session = new Session('compact-manual-anonymous', 'chat_id') as any
    const turn = turnState('card_compact_manual_anonymous')
    session.currentTurn = turn
    session.manualContextCompactionPending = true
    cardkit.recordCardCreated(turn.cardId, 1)

    try {
      session.handleContextCompacted({ phase: 'event' })
      session.manualContextCompactionPending = false
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_manual_alias', turnId: 'turn_manual_alias', itemId: 'compact_manual_alias',
      })
      expect(turn.contextCompactCount).toBe(0)
      expect(calls).toHaveLength(0)
    } finally {
      session.manualContextCompactionPending = false
      await cardkit.dispose(turn.cardId)
    }
  })

  test('moves an in-progress compaction panel to the replacement card', async () => {
    const session = new Session('compact-rotate', 'chat_id') as any
    const turn = turnState('card_compact_old')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      const data = path === '/cards/id_convert' ? { card_id: 'card_compact_new' } : {}
      return new Response(JSON.stringify({ code: 0, data }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      session.handleContextCompacted({
        phase: 'start', threadId: 'thread_2', turnId: 'turn_2', itemId: 'compact_2',
      })
      await cardkit.flush(turn.cardId)
      session.startMidTurnRotate(turn)
      await turn.rotating

      expect(turn.cardId).toBe('card_compact_new')
      expect(turn.contextCompactionPending.get('compact_2')?.cardId).toBe('card_compact_new')
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_2', turnId: 'turn_2', itemId: 'compact_2',
      })
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_2'))
      await cardkit.flush(turn.cardId)

      expect(calls.some(call =>
        call.method === 'POST' &&
        call.path === '/cards/card_compact_new/elements' &&
        JSON.parse(call.body.elements)[0]?.element_id === 'context_compact_0'
      )).toBe(true)
      expect(calls.some(call =>
        call.method === 'PUT' &&
        call.path === '/cards/card_compact_new/elements/context_compact_0'
      )).toBe(true)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('commits completion receipts only after Card Kit lands and allows retry after MISS', async () => {
    const session = new Session('compact-write-retry', 'chat_id') as any
    const turn = turnState('card_compact_write_retry')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1, (code, failure) => {
      session.onCardWriteFailure(turn.cardId, code, failure)
    })
    let rejectCompletion = true
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (
        rejectCompletion &&
        method === 'PUT' &&
        path === `/cards/${turn.cardId}/elements/context_compact_0`
      ) {
        return new Response(JSON.stringify({ code: 300121, msg: 'temporary replace reject' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch
    const start = {
      phase: 'start', threadId: 'thread_retry', turnId: 'turn_retry', itemId: 'compact_retry',
    }
    const end = {
      phase: 'end', threadId: 'thread_retry', turnId: 'turn_retry', itemId: 'compact_retry',
    }

    try {
      session.handleContextCompacted(start)
      session.handleContextCompacted(end)
      await waitUntil(() => !turn.contextCompactionCompleting.has('compact_retry'))
      expect(turn.contextCompactionPending.has('compact_retry')).toBe(true)
      expect(turn.contextCompactionCompleted.has('compact_retry')).toBe(false)

      rejectCompletion = false
      session.handleContextCompacted(end)
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_retry'))
      expect(turn.contextCompactionPending.size).toBe(0)
      const completionPuts = calls.filter(call =>
        call.method === 'PUT' &&
        call.path === `/cards/${turn.cardId}/elements/context_compact_0`
      )
      expect(completionPuts).toHaveLength(2)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('a capacity failure while completing automatically retries on the replacement card', async () => {
    const session = new Session('compact-capacity-rotate', 'chat_id') as any
    const turn = turnState('card_compact_capacity_old')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1, (code, failure) => {
      session.onCardWriteFailure(turn.cardId, code, failure)
    })
    let rejectOldCompletion = true
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (path === '/cards/id_convert') {
        return new Response(JSON.stringify({ code: 0, data: { card_id: 'card_compact_capacity_new' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (
        rejectOldCompletion &&
        method === 'PUT' &&
        path === '/cards/card_compact_capacity_old/elements/context_compact_0'
      ) {
        rejectOldCompletion = false
        return new Response(JSON.stringify({ code: 300305, msg: 'number of card components exceeds 200' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      session.handleContextCompacted({
        phase: 'start', threadId: 'thread_capacity', turnId: 'turn_capacity', itemId: 'compact_capacity',
      })
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_capacity', turnId: 'turn_capacity', itemId: 'compact_capacity',
      })
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_capacity'))

      expect(turn.cardId).toBe('card_compact_capacity_new')
      expect(turn.rotateCount).toBe(1)
      expect(turn.failureRotateCount).toBe(1)
      expect(calls.some(call =>
        call.method === 'PUT' &&
        call.path === '/cards/card_compact_capacity_new/elements/context_compact_0'
      )).toBe(true)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  for (const withStart of [false, true]) {
    test(`an oversized compaction completion stops retrying unchanged content without blocking later output (start=${withStart})`, async () => {
      const session = new Session('compact-oversized', 'chat_id') as any
      const turn = turnState('card_compact_oversized_0')
      turn.userOpenId = ''
      session.currentTurn = turn
      let replacementCount = 0
      cardkit.recordCardCreated(turn.cardId, 1, (code, failure) => {
        session.onCardWriteFailure('card_compact_oversized_0', code, failure)
      })
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname.replace('/open-apis/cardkit/v1', '')
        const body = init?.body ? JSON.parse(String(init.body)) : null
        calls.push({ method: String(init?.method ?? 'GET'), path, body })
        const response = path === '/cards/id_convert'
          ? { code: 0, data: { card_id: `card_compact_oversized_${++replacementCount}` } }
          : String(body?.element ?? body?.elements).includes('✅ 🚨 上下文压缩')
            ? { code: 200860, msg: 'card over max size' }
            : { code: 0, data: {} }
        return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } })
      }) as typeof fetch
      const notice = { threadId: 'thread_oversized', turnId: 'turn_oversized', itemId: 'compact_oversized' }
      try {
        if (withStart) session.handleContextCompacted({ ...notice, phase: 'start' })
        session.handleContextCompacted({ ...notice, phase: 'end' })
        await waitUntil(() => !turn.contextCompactionCompleting.has('compact_oversized') && !turn.rotating)
        expect(replacementCount).toBe(1)
        expect(turn.contextCompactionCompleted.has('compact_oversized')).toBe(false)
        expect(turn.cardRotationFailed).toBe(false)
        expect(sentRawTexts).toHaveLength(1)
        expect(sentRawTexts[0]).toContain('换卡后仍超出飞书容量，写入失败')
        expect(sentRawTexts[0]).toContain('message=card over max size')
        expect(sentRawTexts[0]).toContain('log_id=MISS')
        expect(await cardkit.addElementChecked(turn.cardId, {
          tag: 'markdown', element_id: 'later_output', content: '后续回复仍可写入',
        })).toBe(true)
      } finally {
        if (turn.rotating) await turn.rotating
        session.stopFooterStatus(turn)
        for (let i = 0; i <= replacementCount; i++) await cardkit.dispose(`card_compact_oversized_${i}`)
      }
    })
  }

  test('a duplicate start-panel add reconciles with a terminal replace', async () => {
    const session = new Session('compact-start-add-retry', 'chat_id') as any
    const turn = turnState('card_compact_start_add_retry')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1, (code, failure) => {
      session.onCardWriteFailure(turn.cardId, code, failure)
    })
    let compactAddAttempt = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      const addedElement = method === 'POST' && path === `/cards/${turn.cardId}/elements`
        ? JSON.parse(calls.at(-1)?.body.elements ?? '[]')[0]
        : null
      if (addedElement?.element_id === 'context_compact_0' && ++compactAddAttempt === 1) {
        return new Response(JSON.stringify({ code: 300315, msg: 'Duplicate ID; code: 300301' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      session.handleContextCompacted({
        phase: 'start', threadId: 'thread_add_retry', turnId: 'turn_add_retry', itemId: 'compact_add_retry',
      })
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_add_retry', turnId: 'turn_add_retry', itemId: 'compact_add_retry',
      })
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_add_retry'))

      expect(compactAddAttempt).toBe(1)
      expect(calls.some(call =>
        call.method === 'PUT' &&
        call.path.endsWith('/elements/context_compact_0')
      )).toBe(true)
      expect(turn.contextCompactionPending.size).toBe(0)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })
})

describe('Session model settings completion', () => {
  let previousSources: ReturnType<typeof listTokenSources>
  beforeEach(() => { previousSources = listTokenSources() })
  afterEach(() => {
    resetTokenSourceRegistry()
    for (const source of previousSources) registerTokenSource(source)
  })

  function setup(provider: 'claude' | 'dsh' | 'codex' = 'claude') {
    const sourceId = `settings-${provider}`
    registerTokenSource({ id: sourceId, kind: 'test', agent: provider, display: sourceId, enabled: true,
      models: ['review-before', 'review-after'].map(model => ({ model, display: model,
        efforts: ['high', 'max'], defaultEffort: 'high' })),
      defaultModel: 'review-before', modelCatalogState: { status: 'ready', updatedAt: 1 },
      refreshModels: async () => {}, spawnEnv: env => env, resolveSpawnModel: model => model,
      readUsage: async () => ({ state: 'not_applicable', windows: [] }),
    })
    const session = new Session(`settings-${provider}`, 'chat_id') as any
    const proc = new FakeAgentProc(provider, 'settings-session', sourceId)
    proc.lastModel = 'review-before'; proc.lastEffort = 'high'
    Object.assign(session, { proc, selectedProvider: provider, selectedTokenSourceId: sourceId,
      selectedModel: 'review-before', selectedEffort: 'high', initCount: 1 })
    session.modelPanels.set('settings', { models: ['review-before', 'review-after'].map(model => ({
      provider, sourceId, model, displayName: model, efforts: [{ effort: 'high' }, { effort: 'max' }],
    })) })
    return { session, proc, sourceId }
  }

  function deferUpdate(proc: FakeAgentProc) {
    let release!: () => void
    let reject!: (error: Error) => void
    const gate = new Promise<void>((resolve, fail) => { release = resolve; reject = fail })
    proc.setModelSettings = async (model, effort) => {
      proc.setModelSettingsCalls.push([model, effort])
      await gate
      proc.lastModel = model; proc.lastEffort = effort
    }
    const original = globalThis.setTimeout
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: any, ms: number, ...args: any[]) =>
      original(callback, ms === 20_000 ? 5 : ms, ...args)) as any)
    return { release, reject, restore: () => { timer.mockRestore(); release() } }
  }

  test.each(['claude', 'dsh'] as const)('busy %s keeps the late acknowledgement and prevents overlapping selections', async provider => {
    const { session, proc } = setup(provider)
    session.currentTurn = { ...turnState(), provider }
    const deferred = deferUpdate(proc)
    const save = spyOn(feishu, 'bindSessionModelChecked')
    const model = provider === 'claude' ? 'review-before' : 'review-after'
    try {
      const pending = await session.onModelEffortSelect(model, 'max', 'settings', '', provider)
      expect(pending.pending).toBe(true)
      expect(pending.message).toContain('尚不能判断')
      expect(JSON.stringify(pending.card)).not.toContain('选择已保存')
      expect(save).not.toHaveBeenCalled()
      expect(session.selectedEffort).toBe('high')
      expect((await session.onModelEffortSelect('review-before', 'high', 'settings', '', provider)).message).toContain('本次选择未执行')
      await session.onUserMessage('new input while settings are unknown')
      expect(proc.sentTexts).toEqual([])
      expect(sentTexts.join('\n')).toContain('本条消息未送给 Agent')
      deferred.release()
      expect((await pending.completion).ok).toBe(true)
      expect(session.selectedModel).toBe(model)
      expect(session.selectedEffort).toBe('max')
      expect(save).toHaveBeenCalledTimes(1)
      expect(session.modelSettingsChange).toBeNull()
      expect(proc.setModelSettingsCalls).toHaveLength(1)
    } finally { deferred.restore(); save.mockRestore(); session.dispose() }
  })

  test('soft stop interrupts the task without claiming an uncancellable model update was cancelled', async () => {
    const { session, proc } = setup('dsh')
    session.currentTurn = { ...turnState(), provider: 'dsh' }
    const interrupt = spyOn(proc, 'sendInterrupt')
    const deferred = deferUpdate(proc)
    try {
      const pending = await session.onModelEffortSelect('review-after', 'max', 'settings', '', 'dsh')
      expect(await session.runCommand('stop')).toBe(true)
      expect(interrupt).toHaveBeenCalledTimes(1)
      expect(proc.isAlive()).toBe(true)
      expect(session.modelSettingsChange.phase).toBe('pending')
      expect(session.selectedModel).toBe('review-before')
      deferred.release()
      expect((await pending.completion).ok).toBe(true)
      expect(session.selectedModel).toBe('review-after')
    } finally { deferred.restore(); interrupt.mockRestore(); session.dispose() }
  })

  test('process stop cancels the pending selection and ignores an old process acknowledgement', async () => {
    const { session, proc } = setup()
    const deferred = deferUpdate(proc)
    const save = spyOn(feishu, 'bindSessionModelChecked')
    try {
      const pending = await session.onModelEffortSelect('review-after', 'max', 'settings', '', 'claude')
      expect(pending.pending).toBe(true)
      await session.stop('test stop', { announce: false })
      const replacement = new FakeAgentProc('claude', 'new-session', proc.tokenSourceId)
      session.proc = replacement
      deferred.release()
      const result = await pending.completion
      expect(result.ok).toBe(false)
      expect(result.message).toContain('原进程正在停止')
      expect(save).not.toHaveBeenCalled()
      expect(session.selectedModel).toBe('review-before')
      expect(session.proc).toBe(replacement)
    } finally { deferred.restore(); save.mockRestore(); session.dispose() }
  })

  test('shutdown settles an unanswered model update before draining card actions', async () => {
    const { session, proc } = setup()
    const deferred = deferUpdate(proc)
    try {
      const pending = await session.onModelEffortSelect('review-after', 'max', 'settings', '', 'claude')
      session.closeModelSettingsChanges()
      expect((await pending.completion).message).toContain('daemon 正在停止')
      expect(session.selectedModel).toBe('review-before')
      expect((await session.onModelEffortSelect('review-after', 'max', 'settings', '', 'claude')).message).toContain('本次模型选择未执行')
      expect(proc.setModelSettingsCalls).toHaveLength(1)
    } finally { deferred.restore(); session.dispose() }
  })

  test('a late rejection remains visible and reselecting the saved model actually reapplies it', async () => {
    const { session, proc } = setup()
    const deferred = deferUpdate(proc)
    try {
      const pending = await session.onModelEffortSelect('review-after', 'max', 'settings', '', 'claude')
      deferred.reject(new Error('backend control rejected'))
      const result = await pending.completion
      expect(result.ok).toBe(false)
      expect(result.message).toContain('backend control rejected')
      expect(session.currentModelLabel()).toBeNull()
      expect(session.currentEffortLabel()).toBeNull()
      await session.onUserMessage('must not reach an unconfirmed model')
      expect(proc.sentTexts).toEqual([])
      proc.setModelSettings = FakeAgentProc.prototype.setModelSettings.bind(proc)
      const retry = await session.onModelEffortSelect('review-before', 'high', 'settings', '', 'claude')
      expect(retry.ok).toBe(true)
      expect(retry.message).not.toContain('当前已是')
      expect(proc.setModelSettingsCalls.at(-1)).toEqual(['review-before', 'high'])
      expect(session.modelSettingsChange).toBeNull()
    } finally { deferred.restore(); session.dispose() }
  })

  test('partial Claude success shows the confirmed model and MISS effort until a successful retry', async () => {
    const { session, sourceId } = setup()
    const proc = new ClaudeAgentProcess({ workDir: session.workDir, tokenSourceId: sourceId,
      model: 'review-before', effort: 'high' }) as any
    session.proc = proc
    proc.started = true
    let actualModel = 'review-before'
    proc.query = { setModel: async (model: string) => { actualModel = model },
      applyFlagSettings: async () => { throw new Error('flag settings rejected') } }
    const save = spyOn(feishu, 'bindSessionModelChecked')
    try {
      const failed = await session.onModelEffortSelect('review-after', 'max', 'settings', '', 'claude')
      expect(failed.ok).toBe(false)
      expect(failed.message).toContain('模型已切换为 review-after')
      expect(failed.message).toContain('思考档位未确认')
      expect(failed.message).toContain('flag settings rejected')
      expect(actualModel).toBe('review-after')
      expect(session.currentModelLabel()).toBe('review-after')
      expect(session.currentEffortLabel()).toBeNull()
      // 合并调和(取舍):合并 runtimeModelSelection 为本地/上游合成形态,返回
      // {provider, model, effort, usageSource} 四字段;官方 Claude 档无第三方
      // 额度源 → usageSource 'not_applicable'(usageSourceForAgent 的既有口径)。
      expect(session.runtimeModelSelection()).toEqual({ provider: 'claude', model: 'review-after', effort: null, usageSource: 'not_applicable' })
      expect(save).not.toHaveBeenCalled()
      expect(session.selectedModel).toBe('review-before')
      proc.query.applyFlagSettings = async () => {}
      const retry = await session.onModelEffortSelect('review-after', 'max', 'settings', '', 'claude')
      expect(retry.ok).toBe(true)
      expect(session.currentEffortLabel()).toBe('max')
      expect(session.selectedModel).toBe('review-after')
      expect(save).toHaveBeenCalledTimes(1)
    } finally { save.mockRestore(); session.dispose() }
  })

  test('persistence failure after backend success preserves the confirmed runtime settings', async () => {
    const { session, proc } = setup()
    proc.setModelSettings = async (model, effort) => { proc.lastModel = model; proc.lastEffort = effort }
    const save = spyOn(feishu, 'bindSessionModelChecked').mockImplementation(() => { throw new Error('model fsync failed') })
    try {
      const result = await session.onModelEffortSelect('review-after', 'max', 'settings', '', 'claude')
      expect(result.ok).toBe(false)
      expect(result.message).toContain('模型和思考档位已应用，但保存选择失败')
      expect(result.message).toContain('model fsync failed')
      expect(session.selectedModel).toBe('review-before')
      // 合并调和(取舍):四字段形态(含 usageSource);官方 Claude 档 → 'not_applicable'。
      expect(session.runtimeModelSelection()).toEqual({ provider: 'claude', model: 'review-after', effort: 'max', usageSource: 'not_applicable' })
      save.mockImplementation(() => {})
      expect((await session.onModelEffortSelect('review-after', 'max', 'settings', '', 'claude')).ok).toBe(true)
      expect(session.selectedModel).toBe('review-after')
      expect(session.modelSettingsChange).toBeNull()
    } finally { save.mockRestore(); session.dispose() }
  })

  test('source configuration changes during confirmation cannot silently stop a process or save a stale selection', async () => {
    const { session, proc, sourceId } = setup()
    const source = getTokenSource(sourceId)!
    source.spawnRevision = 'before'
    session.procSourceRevisions.set(proc, tokenSourceProcessRevision(source, 'review-before'))
    const deferred = deferUpdate(proc)
    const save = spyOn(feishu, 'bindSessionModelChecked')
    try {
      const pending = await session.onModelEffortSelect('review-after', 'max', 'settings', '', 'claude')
      source.spawnRevision = 'changed'
      deferred.release()
      const result = await pending.completion
      expect(result.ok).toBe(false)
      expect(result.message).toContain('进程账号配置已变化')
      expect(proc.killCalls).toBe(0)
      expect(save).not.toHaveBeenCalled()
      expect(session.selectedModel).toBe('review-before')
      expect(session.currentModelLabel()).toBe('review-after')
    } finally { deferred.restore(); save.mockRestore(); session.dispose() }
  })

  test('queued input waits for model confirmation and resumes once using the selected model', async () => {
    const { session, proc } = setup('dsh')
    const deferred = deferUpdate(proc)
    session.currentTurn = { ...turnState(), provider: 'dsh' }
    session.pendingMidTurnMsgs.push({ text: 'queued request', wireText: 'queued request', userOpenId: 'ou_user', msgId: '' })
    try {
      const pending = await session.onModelEffortSelect('review-after', 'max', 'settings', '', 'dsh')
      session.currentTurn = null
      await session.drainMidTurnAndOpen()
      expect(session.pendingMidTurnMsgs).toHaveLength(1)
      expect(proc.sentTexts).toEqual([])
      deferred.release()
      expect((await pending.completion).ok).toBe(true)
      await waitUntil(() => proc.sentTexts.length === 1)
      expect(proc.sentTexts[0]).toContain('queued request')
      expect(session.currentTurn.model).toBe('review-after')
      expect(session.pendingMidTurnMsgs).toEqual([])
    } finally {
      deferred.restore()
      if (session.currentTurn) await session.closeTurnCard()
      session.dispose()
    }
  })

  test('busy Codex selection accurately says restart is required', async () => {
    const { session } = setup('codex')
    session.currentTurn = turnState()
    try {
      const result = await session.onModelEffortSelect('review-after', 'high', 'settings', '', 'codex')
      expect(result.ok).toBe(true)
      expect(JSON.stringify(result.card)).toContain('需重启进程生效')
      expect(JSON.stringify(result.card)).not.toContain('后续新 turn 使用')
    } finally { session.dispose() }
  })

  test('Codex persistence failure cannot claim that the running model was already changed', async () => {
    const { session } = setup('codex')
    session.currentTurn = turnState()
    const save = spyOn(feishu, 'bindSessionModelChecked').mockImplementation(() => { throw new Error('model fsync failed') })
    try {
      const result = await session.onModelEffortSelect('review-after', 'high', 'settings', '', 'codex')
      expect(result).toMatchObject({ ok: false, message: '模型切换失败: model fsync failed' })
      expect(session.selectedModel).toBe('review-before')
      // 合并调和(取舍):四字段形态(含 usageSource);codex 恒 'codex'。
      expect(session.runtimeModelSelection()).toEqual({ provider: 'codex', model: 'review-before', effort: 'high', usageSource: 'codex' })
      expect(session.modelSettingsChange).toBeNull()
    } finally { save.mockRestore(); session.dispose() }
  })
})

describe('Session provider switching', () => {
  function installSuccessfulIdleRebuild(session: any): any[] {
    const restartCalls: any[] = []
    session.restart = async (resume: boolean, opts: any) => {
      restartCalls.push({ resume, opts })
      session.proc = new FakeAgentProc(
        session.selectedProvider,
        opts?.resumeIdentity?.threadId ?? null,
      )
      return true
    }
    return restartCalls
  }

  beforeAll(() => {
    buildTokenSourcesFromConfig()
    // 切换用例从目录刷新成功后开始；只准备测试数据，不访问真实账号。
    const glm = getTokenSource('glm')!
    glm.enabled = true
    glm.models = [{ model: 'GLM-5.2', display: 'GLM-5.2', efforts: ['max'], defaultEffort: 'max' }]
    glm.defaultModel = 'GLM-5.2'
    glm.modelCatalogState = { status: 'ready', updatedAt: 1 }
    const deepseek = getTokenSource('deepseek')!
    deepseek.enabled = true
    deepseek.models = [{ model: 'deepseek-v4-pro', display: 'DeepSeek V4 Pro', efforts: ['high'], defaultEffort: 'high' }]
    deepseek.defaultModel = 'deepseek-v4-pro'
    deepseek.modelCatalogState = { status: 'ready', updatedAt: 1 }
  })
  afterAll(() => resetTokenSourceRegistry())

  test('uses provider-specific ask instructions', () => {
    const session = new Session('probe', 'chat_id') as any

    // codex 侧改走原生 request_user_input 工具指令(D3 三小件);
    // askusr marker 指令退役,但 marker 解析栈保留作违规兜底(291c34a)。
    session.selectedProvider = 'codex'
    const codexInstructions = session.spawnDeveloperInstructions()
    expect(codexInstructions).toContain('request_user_input')
    expect(codexInstructions).not.toContain('[[askusr:')

    session.selectedProvider = 'claude'
    const instructions = session.spawnDeveloperInstructions()
    expect(instructions).toContain('AskUserQuestion')
    expect(instructions).not.toContain('[[askusr:')

    // DSH 原生后端走自带 ask_user_question 工具(上游 722e45a DSH_CHANNEL_INSTRUCTIONS),
    // 不复用 Codex 的 request_user_input 文案。
    session.selectedProvider = 'dsh'
    const dshInstructions = session.spawnDeveloperInstructions()
    expect(dshInstructions).toContain('ask_user_question')
    expect(dshInstructions).not.toContain('request_user_input')
    expect(dshInstructions).not.toContain('AskUserQuestion')
    expect(dshInstructions).not.toContain('[[askusr:')
  })

  test('keeps selected provider resume id from being overwritten by stale backend events', () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-thread-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.lastSessionId = 'claude-session-1'

    // 合并调和(取舍):persist 签名为上游 (fatal, proc, notify),显式 proc 走第二参数。
    session.persistResumableSessionId(false, proc)

    expect(boundResumes).toEqual([['probe', 'codex-thread-1', 'codex']])
    expect(session.lastSessionId).toBe('claude-session-1')
  })

  test('fresh Codex init clears the old binding but never persists its unmaterialized thread id', () => {
    const session = new Session('codex-fresh-init', 'chat_id') as any
    const oldRef = { provider: 'codex' as const, sessionId: 'old-thread', cwd: session.workDir }
    resumeRefs.set(`${session.sessionName}:codex`, oldRef)
    session.selectedProvider = 'codex'
    session.lastSessionRef = oldRef
    session.lastSessionId = oldRef.sessionId
    const proc = new FakeAgentProc('codex', 'fresh-thread')
    proc.launchKind = 'fresh'
    proc.conversationResumable = false
    session.proc = proc

    session.wireProc(proc)
    proc.emit('init', { session_id: proc.sessionId })

    expect(boundResumes).toEqual([])
    expect(clearedResumes).toContainEqual([session.sessionName, 'codex'])
    expect(resumeRefs.has(`${session.sessionName}:codex`)).toBe(false)
    expect(session.lastSessionRef).toBeNull()
    expect(session.lastSessionId).toBeNull()
  })

  test('fresh Codex response-level turn_started stays unbound until materialization is confirmed', () => {
    const session = new Session('codex-materialized', 'chat_id') as any
    session.selectedProvider = 'codex'
    const proc = new FakeAgentProc('codex', 'fresh-thread')
    proc.launchKind = 'fresh'
    proc.conversationResumable = false
    session.proc = proc
    session.wireProc(proc)

    proc.emit('init', { session_id: proc.sessionId })
    proc.emit('turn_started', { turn_id: 'turn-1', thread_id: proc.sessionId })
    expect(boundResumes).toEqual([])

    proc.conversationResumable = true
    proc.emit('conversation_materialized', {
      session_id: proc.sessionId,
      source: 'turn/started notification',
    })
    expect(boundResumes).toEqual([[session.sessionName, 'fresh-thread', 'codex']])
    expect(session.lastSessionId).toBe('fresh-thread')
  })

  test('failed Codex materialization verification is visible and never writes a resume point', () => {
    const session = new Session('codex-materialize-fails', 'chat_id') as any
    session.selectedProvider = 'codex'
    const proc = new FakeAgentProc('codex', 'fresh-thread')
    proc.launchKind = 'fresh'
    proc.conversationResumable = false
    session.proc = proc
    session.wireProc(proc)
    proc.emit('init', { session_id: proc.sessionId })

    proc.emit('conversation_materialization_failed', {
      session_id: proc.sessionId,
      path: '/rollouts/rollout-fresh-thread.jsonl',
      source: 'turn/started notification',
      error: new Error('thread/read says not materialized'),
    })

    expect(boundResumes).toEqual([])
    expect(session.lastSessionId).toBeNull()
    expect(sentRawTexts.join('\n')).toContain('Codex 会话落盘确认失败，未写恢复点')
    expect(sentRawTexts.join('\n')).toContain('thread/read says not materialized')
  })

  test('a fast Codex result defers then commits its fork checkpoint after materialization', () => {
    const session = new Session('codex-fast-checkpoint', 'chat_id') as any
    session.selectedProvider = 'codex'
    const proc = new FakeAgentProc('codex', 'fresh-thread')
    proc.launchKind = 'fresh'
    proc.conversationResumable = false
    session.proc = proc
    session.wireProc(proc)
    session.lastTurnUserPreview = 'fast input'
    const checkpoint = {
      provider: 'codex' as const,
      kind: 'turn' as const,
      id: 'turn-fast',
      source: { provider: 'codex' as const, sessionId: 'fresh-thread', cwd: session.workDir },
    }

    proc.emit('result', { is_error: false, checkpoint })
    expect(turnAnchorsBySession.has(session.sessionName)).toBe(false)
    expect(session.pendingCodexTurnAnchors).toHaveLength(1)

    proc.conversationResumable = true
    proc.emit('conversation_materialized', {
      session_id: proc.sessionId,
      source: 'turn/started notification',
    })

    expect(session.pendingCodexTurnAnchors).toHaveLength(0)
    expect(turnAnchorsBySession.get(session.sessionName)).toEqual([{
      checkpoint,
      preview: 'fast input',
      ts: expect.any(Number),
      writes: [],
    }])
  })

  test('resumed Codex init can persist because the source rollout already exists', () => {
    const session = new Session('codex-resume-init', 'chat_id') as any
    session.selectedProvider = 'codex'
    const proc = new FakeAgentProc('codex', 'resumed-thread')
    proc.launchKind = 'resume'
    proc.conversationResumable = true
    session.proc = proc
    session.wireProc(proc)

    proc.emit('init', { session_id: proc.sessionId })

    expect(boundResumes).toEqual([[session.sessionName, 'resumed-thread', 'codex']])
  })

  test('fresh Codex init fails visibly when clearing the old resume binding cannot fsync', async () => {
    const session = new Session('codex-fresh-clear-fails', 'chat_id') as any
    const oldRef = { provider: 'codex' as const, sessionId: 'old-thread', cwd: session.workDir }
    resumeRefs.set(`${session.sessionName}:codex`, oldRef)
    session.selectedProvider = 'codex'
    session.lastSessionRef = oldRef
    session.lastSessionId = oldRef.sessionId
    const proc = new FakeAgentProc('codex', 'fresh-thread')
    proc.launchKind = 'fresh'
    proc.conversationResumable = false
    proc.sendInitialize = () => {
      proc.emit('init', { session_id: proc.sessionId })
    }
    session.spawnAgent = () => proc
    setResumeWriteError(new Error('resume-map clear fsync failed'))
    const statuses: string[] = []

    try {
      const ok = await session.start({
        announce: false,
        onStatus: (status: string) => statuses.push(status),
      })
      expect(ok).toBe(false)
      expect(proc.killCalls).toBe(1)
      expect(statuses.join('\n')).toContain('resume-map clear fsync failed')
      expect(resumeRefs.get(`${session.sessionName}:codex`)).toEqual(oldRef)
      expect(session.lastSessionId).toBe('old-thread')
    } finally {
      setResumeWriteError(null)
    }
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

  test('clears turn anchors only when the provider actually changes', async () => {
    const session = new Session('probe', 'chat_id') as any
    session.selectedProvider = 'claude'
    session.selectedModel = 'claude:fable'

    await session.applyModelSelection('claude', 'claude:opus', 'max')
    expect(clearedTurnAnchors).toEqual([])

    await session.applyModelSelection('codex', 'gpt-5.6-sol', 'max')
    expect(clearedTurnAnchors).toEqual(['probe'])
  })

  test('freezes provider, model, effort, and usage source on an opened turn', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-turn-snapshot')
    proc.lastModel = 'claude:glm'
    proc.lastEffort = 'xhigh'
    session.proc = proc
    session.selectedProvider = 'claude'
    session.selectedModel = 'claude:glm'
    session.selectedEffort = 'xhigh'

    const opened = await session.openTurnCard('ou_user', 'user_message', {
      expectedProc: proc,
      startThinking: false,
    })
    expect(opened.kind).toBe('opened')
    if (opened.kind !== 'opened') return
    const turn = opened.turn
    expect(turn).toMatchObject({
      provider: 'claude',
      model: 'claude:glm',
      effort: 'xhigh',
      usageSource: 'glm',
    })

    session.selectedProvider = 'codex'
    session.selectedModel = 'gpt-5.6-sol'
    session.selectedEffort = 'max'
    session.proc = new FakeAgentProc('codex', 'codex-thread-new')
    cardkit.recordCardCreated(turn.cardId, 1)
    setDeterministicFooterStatus(turn, 'Thinking...')
    session.renderFooterStatus(turn, turn.footerStatusStartedAt + 1_000)
    await cardkit.flush(turn.cardId)

    const footer = calls
      .filter(call => call.method === 'PUT' && call.path === `/cards/${turn.cardId}/elements/footer`)
      .map(call => JSON.parse(call.body.element).content as string)
      .at(-1)
    // 合并调和(取舍):合并后模型行统一走上游 footerModelLabel(provider 小写 +
    // MISS 口径),本地旧 modelEffortLabel('Claude · …')随合并退役。快照冻结
    // 语义不变:行内是 turn 开启时的 glm/xhigh,不是之后选择的 gpt-5.6-sol。
    expect(footer).toContain('claude · glm/xhigh')
    expect(footer).not.toContain('gpt-5.6-sol')

    session.stopFooterStatus(turn)
    await cardkit.dispose(turn.cardId)
  })

  test('patches a console quota row from the card creation snapshot after selection changes', async () => {
    const accountUsage = await import('./account-usage')
    const session = new Session('console-usage-snapshot', 'chat_id') as any
    session.selectedProvider = 'claude'
    session.selectedModel = 'claude:fable'
    session.selectedEffort = 'max'
    // 合并调和(取舍):合并后 console 额度行走上游「全部账号额度」聚合面板
    // (cards/console.ts 双源),元素从 markdown(content)变为 collapsible_panel。
    // 用例语义不变:补丁必须渲染卡创建时快照的那份聚合读数 —— 选择漂移后
    // 再读到的不同读数不得改写它。快照账户(创建期)vs 漂移账户(后读)差分。
    const readAllSpy = spyOn(accountUsage, 'readAllAccountUsage')
      .mockImplementation(async () => [{ id: 'claude-sub', label: '快照账户', usage: { state: 'ok', windows: [] } }] as any)
    const cardId = 'card_console_usage_snapshot'
    try {
      const snapshot = await session.buildConsoleOpts(undefined)
      session.selectedModel = 'claude:glm'
      session.selectedEffort = 'xhigh'
      readAllSpy.mockImplementation(async () => [{ id: 'claude-sub', label: '漂移账户', usage: { state: 'ok', windows: [] } }] as any)
      cardkit.recordCardCreated(cardId, 4)
      await session.patchConsoleUsage(cardId, snapshot)
      await cardkit.flush(cardId)

      const panel = calls
        .filter(call => call.method === 'PUT' && call.path === `/cards/${cardId}/elements/console_usage`)
        .map(call => JSON.parse(call.body.element))
        .at(-1)
      expect(panel.tag).toBe('collapsible_panel')
      expect(panel.element_id).toBe('console_usage')
      const rendered = panel.elements.map((el: any) => el.content ?? '').join('\n')
      expect(rendered).toContain('快照账户')
      expect(rendered).not.toContain('漂移账户')
    } finally {
      readAllSpy.mockRestore()
      await cardkit.dispose(cardId)
    }
  })

  test('consumes hyphenated DSH setup commands before they can reach the model', async () => {
    const session = new Session('probe', 'chat_id') as any
    expect(await session.runCommand('deepseek-harness-setup')).toBe(true)
    expect(await session.runCommand('DEEPSEEK-HARNESS-SETUP one two three')).toBe(true)
    expect(sentTexts.filter(text => text.includes('deepseek-harness-setup')).length).toBe(2)
  })

  test('OpenRouter setup is routed to the registered source without sending credentials to an Agent', async () => {
    const session = new Session('probe', 'chat_id') as any
    expect(await session.runCommand('openrouter-setup')).toBe(true)
    expect(sentTexts.some(text => text.includes('openrouter-setup <api_key>'))).toBe(true)
    expect(session.isRunning()).toBe(false)
  })

  test.each(['stopped', 'idle', 'working'])('disabled Claude subscription rejects new input while %s without stopping the process', async state => {
    const session = new Session('subscription-off', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'existing-conversation', 'claude-sub')
    session.selectedProvider = 'claude'
    session.selectedTokenSourceId = 'claude-sub'
    session.selectedModel = 'sonnet'
    session.selectedEffort = 'high'
    session.proc = state === 'stopped' ? null : proc
    session.currentTurn = state === 'working' ? turnState('running-subscription') : null
    session.status = state
    const turn = session.currentTurn
    session.tokenSource = () => ({ id: 'claude-sub', kind: 'claude-subscription', enabled: false,
      modelCatalogState: { status: 'disabled', error: 'Claude Code 订阅已禁用；发送 claude-sub on 启用' } })
    try {
      await session.onUserMessage('new task', [], 'ou_user', 'om_new')
      expect(sentTexts.at(-1)).toContain('claude-sub on')
      expect(sentTexts.at(-1)).toContain('消息未送给 Agent')
      expect(proc.sentTexts).toEqual([])
      expect(proc.killCalls).toBe(0)
      expect(session.currentTurn).toBe(turn)
      expect(session.pendingMidTurnMsgs).toEqual([])
      expect(session.status).toBe(state)
    } finally { session.currentTurn = null; session.dispose() }
  })

  test.each([false, true])('Claude subscription rechecks the switch after opening an input card (queued=%s)', async queued => {
    const session = new Session('subscription-race', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'existing-conversation', 'claude-sub')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.selectedTokenSourceId = 'claude-sub'
    session.selectedModel = 'sonnet'
    session.selectedEffort = 'high'
    session.initCount = 1
    const source = { id: 'claude-sub', kind: 'claude-subscription', agent: 'claude', enabled: true,
      modelCatalogState: { status: 'ready', error: 'Claude Code 订阅已禁用；发送 claude-sub on 启用' } }
    session.tokenSource = () => source
    const statuses: string[] = []
    session.openTurnCard = async () => {
      source.enabled = false
      const turn = turnState('switch-during-card-open')
      session.currentTurn = turn
      session.pendingTurnInputs = []
      return turn
    }
    session.closeTurnCard = async (status: string) => { statuses.push(status); session.currentTurn = null }
    try {
      if (queued) {
        session.pendingMidTurnMsgs = [{ text: 'queued task', wireText: 'queued task', userOpenId: '', msgId: '' }]
        await session.drainMidTurnAndOpen()
      } else await session.onUserMessage('new task')
      expect(proc.sentTexts).toEqual([])
      expect(proc.killCalls).toBe(0)
      expect(statuses.join('\n')).toContain('消息未送给 Agent')
      expect(session.pendingUserMessageCount).toBe(0)
      expect(session.pendingMidTurnMsgs).toEqual([])
      expect(session.currentTurn).toBeNull()
      expect(session.status).toBe('idle')
      source.enabled = true
      expect(await session.sendClaimedUserText(proc, 'enabled again')).toBe(true)
      expect(proc.sentTexts).toHaveLength(1)
      expect(proc.sentTexts[0]).toContain('enabled again')
      expect(proc.killCalls).toBe(0)
    } finally { session.dispose() }
  })

  test('MD uses cached models immediately and never waits for catalog I/O', async () => {
    const previous = listTokenSources()
    resetTokenSourceRegistry()
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    let refreshes = 0
    const models = Array.from({ length: 9 }, (_, i) => ({ model: `vendor/model-${i}`, display: `Model ${i}`, efforts: ['high' as const], defaultEffort: 'high' as const }))
    const source = { id: 'md-cache', kind: 'test', agent: 'codex' as const, display: 'Codex', enabled: true,
      models, defaultModel: models[0].model,
      modelCatalogState: { status: 'ready' as 'ready' | 'loading' | 'failed', updatedAt: 1, error: undefined as string | undefined },
      async refreshModels() { refreshes++; await pending },
      spawnEnv: (env: Record<string, string | undefined>) => env, resolveSpawnModel: (model: string) => model,
      readUsage: async () => ({ state: 'not_applicable' as const, windows: [] }),
    }
    registerTokenSource(source)
    const session = new Session('md-cache-test', 'chat_id')
    const background = refreshAllTokenSourceModels()
    try {
      expect(await session.runCommand('md')).toBe(true)
      expect(JSON.stringify(sentCards[0])).toContain('9 个模型')
      expect(refreshes).toBe(1)
      const panelId = [...session.modelPanels.keys()][0]
      expect(session.modelPanels.get(panelId)?.messageId).toBe('om_status_1')
      expect((await session.onProviderSelect(source.id, panelId)).ok).toBe(true)
      source.models = []
      source.modelCatalogState.status = 'loading'
      await session.showModelPanel()
      expect(JSON.stringify(sentCards.at(-1))).toContain('模型目录加载中')
      expect(JSON.stringify(sentCards.at(-1))).not.toContain('0 个模型')
      const loadingId = [...session.modelPanels.keys()].at(-1)!
      expect((await session.onProviderSelect(source.id, loadingId)).ok).toBe(false)
      source.modelCatalogState.status = 'failed'; source.modelCatalogState.error = 'HTTP 503'
      await session.showModelPanel()
      expect(JSON.stringify(sentCards.at(-1))).toContain('模型目录 MISS')
      expect(JSON.stringify(sentCards.at(-1))).toContain('HTTP 503')
      expect(refreshes).toBe(1)
    } finally {
      release(); await background; session.dispose(); resetTokenSourceRegistry()
      for (const entry of previous) registerTokenSource(entry)
    }
  })

  test('large model catalogs page through a snapshot and reject stale or cross-page choices', async () => {
    const previous = listTokenSources()
    const source = {
      id: 'openrouter', kind: 'openrouter', agent: 'claude' as const, display: 'OpenRouter', enabled: true,
      models: Array.from({ length: 45 }, (_, i) => ({ model: `vendor/model-${i}`, display: `Model ${i}`,
        efforts: ['high' as const], defaultEffort: 'high' as const })),
      defaultModel: '', modelCatalogState: { status: 'ready' as const, updatedAt: Date.now() },
      refreshModels: async () => {}, spawnEnv: (env: Record<string, string | undefined>) => env,
      resolveSpawnModel: (model: string) => model,
      readUsage: async () => ({ state: 'not_applicable' as const, windows: [] }),
    }
    registerTokenSource(source)
    try {
      const session = new Session('probe', 'chat_id') as any
      session.modelPanels.set('openrouter-page', { models: [] })
      const first = await session.onProviderSelect('openrouter', 'openrouter-page')
      expect(first.ok).toBe(true)
      expect(session.modelPanels.get('openrouter-page').models).toHaveLength(20)
      expect(JSON.stringify(first.card)).toContain('第 1 / 3 页')
      expect(JSON.stringify(first.card)).not.toContain('vendor/model-20')
      // 刷新后仍按本面板快照翻页，避免数组下标指到另一模型。
      source.models = []
      const last = await session.onModelPage('openrouter-page', 'openrouter', 2)
      expect(last.ok).toBe(true)
      expect(session.modelPanels.get('openrouter-page').models).toHaveLength(5)
      expect(JSON.stringify(last.card)).toContain('vendor/model-44')
      expect(JSON.stringify(last.card)).not.toContain('vendor/model-0')
      expect((await session.onModelSelect('vendor/model-0', 'openrouter-page', '', { provider: 'claude' })).ok).toBe(false)
      // 单档位会直接应用，因此也必须检查刷新后的真实目录，不能应用旧快照。
      expect((await session.onModelSelect('vendor/model-44', 'openrouter-page', '', { provider: 'claude' })).ok).toBe(false)
      expect((await session.onModelEffortSelect('vendor/model-44', 'high', 'openrouter-page', '', 'claude')).ok).toBe(false)
      for (const page of [-1, 3, 0.5, NaN]) expect((await session.onModelPage('openrouter-page', 'openrouter', page)).ok).toBe(false)
      expect((await session.onModelPage('openrouter-page', 'glm', 0)).ok).toBe(false)
      expect((await session.onModelPage('stale', 'openrouter', 0)).ok).toBe(false)
      expect((await session.onProviderSelect('openrouter', 'stale')).ok).toBe(false)
    } finally {
      resetTokenSourceRegistry()
      for (const item of previous) registerTokenSource(item)
    }
  })

  test('Claude source default efforts are authoritative and missing defaults are not replaced by max', () => {
    const previous = listTokenSources()
    registerTokenSource({ id: 'openrouter', kind: 'openrouter', agent: 'claude', display: 'OpenRouter', enabled: true,
      models: [{ model: 'vendor/known', display: 'Known', efforts: ['medium'], defaultEffort: 'medium' },
        { model: 'vendor/missing', display: 'Missing', efforts: ['high'], defaultEffort: null }],
      defaultModel: 'vendor/known', refreshModels: async () => {}, spawnEnv: env => env, resolveSpawnModel: model => model,
      readUsage: async () => ({ state: 'not_applicable', windows: [] }),
    })
    try {
      const session = new Session('probe', 'chat_id') as any
      session.selectedProvider = 'claude'
      session.selectedTokenSourceId = 'openrouter'
      session.selectedModel = 'vendor/known'
      session.selectedEffort = null
      expect(session.claudeEffortForSpawn()).toBe('medium')
      expect(session.currentEffortLabel()).toBe('medium')
      session.selectedModel = 'vendor/missing'
      expect(session.currentEffortLabel()).toBeNull()
      expect(session.withModel('ready')).toContain('claude · vendor/missing/MISS')
      expect(() => session.claudeEffortForSpawn()).toThrow('MISS')
    } finally {
      resetTokenSourceRegistry()
      for (const item of previous) registerTokenSource(item)
    }
  })

  test('selecting a native-default model skips effort and replaces only the idle process while preserving its resume id', async () => {
    const previous = listTokenSources()
    const source = { id: 'openrouter-env', kind: 'openrouter', agent: 'claude' as const, display: 'OpenRouter', enabled: true,
      spawnRevision: 'account', modelEnvironmentRevision: (model: string) => model === 'vendor/default' ? 'unset' : 'level',
      models: [{ model: 'vendor/level', display: 'Level', efforts: ['high' as const], defaultEffort: 'high' as const },
        { model: 'vendor/default', display: 'Default', efforts: ['default' as const], defaultEffort: 'default' as const }],
      defaultModel: '', modelCatalogState: { status: 'ready' as const, updatedAt: 1 },
      refreshModels: async () => {}, spawnEnv: (env: Record<string, string | undefined>) => env,
      resolveSpawnModel: (model: string) => model, readUsage: async () => ({ state: 'not_applicable' as const, windows: [] }),
    }
    registerTokenSource(source)
    const session = new Session('openrouter-env-switch', 'chat_id') as any
    try {
      const proc = new FakeAgentProc('claude', 'preserved-session', source.id)
      session.proc = proc
      session.procSourceRevisions.set(proc, tokenSourceProcessRevision(source, 'vendor/level'))
      session.selectedProvider = 'claude'; session.selectedTokenSourceId = source.id
      session.selectedModel = 'vendor/level'; session.selectedEffort = 'high'
      session.modelPanels.set('mode-panel', { models: [{ provider: 'claude', sourceId: source.id, model: 'vendor/default',
        displayName: 'Default', efforts: [{ effort: 'default' }] }] })
      const result = await session.onModelSelect('vendor/default', 'mode-panel', '', { provider: 'claude' })
      expect(result.ok).toBe(true)
      expect(JSON.stringify(result.card)).not.toContain('选择 effort')
      expect(session.selectedModel).toBe('vendor/default')
      expect(session.selectedTokenSourceId).toBe(source.id)
      expect(session.modelPanels.has('mode-panel')).toBe(false)
      expect(proc.setModelSettingsCalls).toEqual([])
      expect(proc.killCalls).toBe(1)
      expect(session.selectedEffort).toBe('default')
      expect(boundResumes).toContainEqual([session.sessionName, 'preserved-session', 'claude'])
    } finally {
      session.dispose()
      resetTokenSourceRegistry()
      for (const entry of previous) registerTokenSource(entry)
    }
  })

  test('selecting a newly registered DSH GLM model loads its new configuration and retains native history', async () => {
    const previous = listTokenSources()
    let catalogRevision = 'before-registration'
    const source = { id: 'dsh-glm-new-model', kind: 'dsh-glm', agent: 'dsh' as const, display: 'GLM Coding Plan', enabled: true,
      spawnRevision: 'account', modelEnvironmentRevision: () => catalogRevision,
      models: ['glm-5.3', 'glm-manual'].map(model => ({ model, display: model, efforts: ['high' as const], defaultEffort: 'high' as const })),
      defaultModel: 'glm-5.3', modelCatalogState: { status: 'ready' as const, updatedAt: 1 },
      refreshModels: async () => {}, spawnEnv: (env: Record<string, string | undefined>) => env,
      resolveSpawnModel: (model: string) => model, readUsage: async () => ({ state: 'not_applicable' as const, windows: [] }),
    }
    registerTokenSource(source)
    const session = new Session('dsh-glm-new-model', 'chat_id') as any
    try {
      const proc = new FakeAgentProc('dsh', 'preserved-dsh-session', source.id)
      session.proc = proc
      session.procSourceRevisions.set(proc, tokenSourceProcessRevision(source, 'glm-5.3'))
      session.selectedProvider = 'dsh'; session.selectedTokenSourceId = source.id
      session.selectedModel = 'glm-5.3'; session.selectedEffort = 'high'
      catalogRevision = 'after-registration'
      session.modelPanels.set('custom-model-panel', { models: [{ provider: 'dsh', sourceId: source.id, model: 'glm-manual',
        displayName: 'Manual', efforts: [{ effort: 'high' }] }] })
      const result = await session.onModelEffortSelect('glm-manual', 'high', 'custom-model-panel', '', 'dsh')
      expect(result.ok).toBe(true)
      expect(proc.setModelSettingsCalls).toEqual([])
      expect(proc.killCalls).toBe(1)
      expect(session.selectedModel).toBe('glm-manual')
      expect(boundResumes).toContainEqual([session.sessionName, 'preserved-dsh-session', 'dsh'])
    } finally {
      session.dispose()
      resetTokenSourceRegistry()
      for (const entry of previous) registerTokenSource(entry)
    }
  })

  test('the same Packy model can change default effort mode only by replacing its idle process', async () => {
    const previous = listTokenSources()
    const source = { id: 'packy-effort-test', kind: 'packy', agent: 'claude' as const, display: 'Packy', enabled: true,
      models: [{ model: 'mimo-v2.5-pro', display: 'MiMo', efforts: ['default' as const, 'high' as const], defaultEffort: 'default' as const }],
      defaultModel: 'mimo-v2.5-pro', modelCatalogState: { status: 'ready' as const, updatedAt: 1 },
      refreshModels: async () => {}, spawnEnv: (env: Record<string, string | undefined>) => env,
      resolveSpawnModel: (model: string) => model, readUsage: async () => ({ state: 'not_applicable' as const, windows: [] }),
    }
    registerTokenSource(source)
    const session = new Session('packy-effort-mode', 'chat_id') as any
    try {
      const proc = new FakeAgentProc('claude', 'packy-effort-session', source.id)
      session.proc = proc
      session.selectedProvider = 'claude'; session.selectedTokenSourceId = source.id
      session.selectedModel = 'mimo-v2.5-pro'; session.selectedEffort = 'default'
      proc.lastEffort = 'default'
      session.modelPanels.set('packy-effort-panel', { models: [{ provider: 'claude', sourceId: source.id,
        model: 'mimo-v2.5-pro', displayName: 'MiMo', efforts: [{ effort: 'default' }, { effort: 'high' }] }] })
      const result = await session.onModelEffortSelect('mimo-v2.5-pro', 'high', 'packy-effort-panel', '', 'claude')
      expect(result.ok).toBe(true)
      expect(proc.setModelSettingsCalls).toEqual([])
      expect(proc.killCalls).toBe(1)
      expect(session.selectedEffort).toBe('high')
      expect(boundResumes).toContainEqual([session.sessionName, 'packy-effort-session', 'claude'])
    } finally {
      session.dispose()
      resetTokenSourceRegistry()
      for (const entry of previous) registerTokenSource(entry)
    }
  })

  test('DSH model panel accepts off effort and updates the same native process', async () => {
    const previous = listTokenSources()
    registerTokenSource({ id: 'deepseek-harness', kind: 'deepseek-harness', agent: 'dsh', display: 'DeepSeek Harness', enabled: true,
      models: [{ model: 'deepseek-v4-flash', display: 'Flash', efforts: ['off', 'high'], defaultEffort: 'high' }],
      defaultModel: 'deepseek-v4-flash', modelCatalogState: { status: 'ready', updatedAt: Date.now() },
      refreshModels: async () => {}, spawnEnv: env => env, resolveSpawnModel: model => model,
      readUsage: async () => ({ state: 'not_applicable', windows: [] }),
    })
    try {
      const session = new Session('probe', 'chat_id') as any
      const proc = new FakeAgentProc('dsh', 'dsh-session', 'deepseek-harness')
      session.proc = proc
      session.selectedProvider = 'dsh'
      session.selectedTokenSourceId = 'deepseek-harness'
      session.selectedModel = 'deepseek-v4-flash'
      session.selectedEffort = 'high'
      session.modelPanels.set('panel-dsh', { models: [{ provider: 'dsh', sourceId: 'deepseek-harness', model: 'deepseek-v4-flash',
        displayName: 'Flash', efforts: [{ effort: 'off', isDefault: false }, { effort: 'high', isDefault: true }] }] })
      const result = await session.onModelEffortSelect('deepseek-v4-flash', 'off', 'panel-dsh', 'ou_user', 'dsh')
      expect(result.ok).toBe(true)
      expect(proc.setModelSettingsCalls).toEqual([['deepseek-v4-flash', 'off']])
      expect(proc.killCalls).toBe(0)
      expect(session.selectedProvider).toBe('dsh')
      expect(session.selectedEffort).toBe('off')
      expect(JSON.stringify(result.card)).toContain('DeepSeek Harness')
    } finally {
      resetTokenSourceRegistry()
      for (const source of previous) registerTokenSource(source)
    }
  })

  test('DSH cannot replace a busy Claude process', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session', 'glm')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.selectedTokenSourceId = 'glm'
    session.currentTurn = { ...turnState(), provider: 'claude' }
    session.modelPanels.set('panel-dsh', { models: [{ provider: 'dsh', sourceId: 'deepseek-harness', model: 'deepseek-v4-flash',
      displayName: 'Flash', efforts: [{ effort: 'off', isDefault: true }] }] })
    const result = await session.onModelEffortSelect('deepseek-v4-flash', 'off', 'panel-dsh', 'ou_user', 'dsh')
    expect(result.ok).toBe(false)
    expect(proc.killCalls).toBe(0)
    expect(session.selectedProvider).toBe('claude')
  })

  test('rejects cross-provider model switch while a turn is active', async () => {
    const session = new Session('probe', 'chat_id') as any
    session.proc = new FakeAgentProc('codex', 'codex-thread-1')
    session.selectedProvider = 'codex'
    session.currentTurn = turnState()

    const result = await session.onModelEffortSelect('claude:opus', 'max', '', 'ou_user', 'claude')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('正在执行、启动或排队')
    expect(boundResumes).toEqual([])
    expect(session.selectedProvider).toBe('codex')
  })

  test('respawns idle Claude process when selecting an env-backed model profile', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.selectedModel = 'claude:default'
    const restartCalls = installSuccessfulIdleRebuild(session)

    const result = await session.onModelEffortSelect('claude:opus', 'max', '', 'ou_user', 'claude')

    expect(result.ok).toBe(true)
    expect(session.selectedModel).toBe('claude:opus')
    expect(proc.killCalls).toBe(1)
    expect(session.proc).not.toBe(proc)   // 旧进程已杀;下轮 start 用 deepseek 的 base_url 重 spawn
    expect(proc.setModelSettingsCalls).toEqual([])
    expect(restartCalls).toHaveLength(1)
    expect(restartCalls[0]).toMatchObject({
      resume: true,
      opts: { resumeIdentity: { provider: 'claude', threadId: 'claude-session-1' } },
    })
    expect(result.card ? JSON.stringify(result.card) : '').toContain('下一轮开始使用')
  })

  test('model switching waits through Claude SDK cleanup before committing the new selection', async () => {
    const session = new Session('model-sdk-cleanup', 'chat_id') as any
    const previous = { provider: 'claude' as const, tokenSourceId: 'glm', model: 'GLM-5.2', effort: 'max' }
    Object.assign(session, { selectedProvider: previous.provider, selectedTokenSourceId: previous.tokenSourceId,
      selectedModel: previous.model, selectedEffort: previous.effort })
    const proc = new ClaudeAgentProcess({ workDir: session.workDir, effort: 'max', tokenSourceId: 'glm' }) as any
    proc.sessionId = 'claude-before-switch'
    proc.started = true
    let signalClose!: () => void
    const closing = new Promise<void>(resolve => { signalClose = resolve })
    proc.query = {
      close: signalClose,
      async *[Symbol.asyncIterator]() {
        await closing
        // SDK cleanup can spend about 2 s waiting for stdin EOF to finish.
        await new Promise(resolve => setTimeout(resolve, 1200))
      },
    }
    const readLoop = proc.readLoop(proc.query)
    session.proc = proc
    session.wireProc(proc)
    session.modelPanels.set('switch', { models: [{ provider: 'claude', sourceId: 'deepseek',
      model: 'deepseek-v4-pro', displayName: 'DeepSeek', efforts: [{ effort: 'high' }] }] })
    const save = spyOn(feishu, 'bindSessionModelChecked')
    try {
      const switching = session.onModelEffortSelect('deepseek-v4-pro', 'high', 'switch', '', 'claude')
      await closing
      const duringClose = session.conversationRouting()
      const writesDuringClose = save.mock.calls.length
      const result = await switching

      expect(duringClose).toMatchObject(previous)
      expect(writesDuringClose).toBe(0)
      expect(result.ok).toBe(true)
      expect(proc.isAlive()).toBe(false)
      expect(session.proc).toBeNull()
      expect(save).toHaveBeenCalledWith(session.sessionName, 'claude', 'deepseek-v4-pro', 'high', 'deepseek')
      expect(resumeRefs.get(`${session.sessionName}:claude`)?.sessionId).toBe('claude-before-switch')
    } finally {
      await readLoop
      save.mockRestore()
      session.dispose()
    }
  })

  test.each([
    { provider: 'codex' as const, sourceId: 'codex-sub', model: 'gpt-6-astra', effort: 'max' as const },
    { provider: 'claude' as const, sourceId: 'deepseek', model: 'deepseek-v4-pro', effort: 'high' as const },
  ])('failed switch to $sourceId keeps the old selection and retries without duplicate error messages', async target => {
    const source = getTokenSource(target.sourceId)!
    const sourceBefore = { enabled: source.enabled, models: source.models, modelCatalogState: source.modelCatalogState }
    source.enabled = true
    source.models = [{ model: target.model, display: target.model, efforts: [target.effort], defaultEffort: target.effort }]
    source.modelCatalogState = { status: 'ready', updatedAt: 1 }
    const session = new Session(`model-failed-${target.sourceId}`, 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-before-switch', 'glm')
    session.proc = proc
    session.selectedProvider = 'claude'; session.selectedTokenSourceId = 'glm'
    session.selectedModel = 'GLM-5.2'; session.selectedEffort = 'max'
    session.modelPanels.set('switch', { models: [{ ...target, displayName: target.model,
      efforts: [{ effort: target.effort }] }] })
    const save = spyOn(feishu, 'bindSessionModelChecked')
    let attempts = 0
    proc.kill = async () => { attempts++; throw new Error('SDK close timeout') }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await session.onModelEffortSelect(target.model, target.effort, 'switch', '', target.provider)
        expect(result).toMatchObject({ ok: false, message: '模型切换失败: SDK close timeout' })
        expect(session.conversationRouting()).toMatchObject({ provider: 'claude', tokenSourceId: 'glm',
          model: 'GLM-5.2', effort: 'max' })
        expect(session.proc).toBe(proc)
        expect(session.blockedProc).toBe(proc)
        expect(session.modelPanels.has('switch')).toBe(true)
      }
      expect(attempts).toBe(2)
      expect(save).not.toHaveBeenCalled()
      expect(sentTexts).toEqual([]) // The card-action dispatcher owns the visible failure receipt.

      proc.kill = FakeAgentProc.prototype.kill.bind(proc)
      const retry = await session.onModelEffortSelect(target.model, target.effort, 'switch', '', target.provider)
      expect(retry.ok).toBe(true)
      expect(session.proc).toBeNull()
      expect(save).toHaveBeenCalledTimes(1)
    } finally {
      Object.assign(source, sourceBefore)
      save.mockRestore()
      session.dispose()
    }
  })

  test('reselecting a previously saved target still stops the mismatched process', async () => {
    const session = new Session('model-stale-selection', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-before-switch', 'glm')
    session.proc = proc
    session.selectedProvider = 'claude'; session.selectedTokenSourceId = 'deepseek'
    session.selectedModel = 'deepseek-v4-pro'; session.selectedEffort = 'high'
    session.modelPanels.set('switch', { models: [{ provider: 'claude', sourceId: 'deepseek',
      model: 'deepseek-v4-pro', displayName: 'DeepSeek', efforts: [{ effort: 'high' }] }] })
    try {
      const result = await session.onModelEffortSelect('deepseek-v4-pro', 'high', 'switch', '', 'claude')
      expect(result.ok).toBe(true)
      expect(result.message).not.toContain('当前已是')
      expect(proc.killCalls).toBe(1)
      expect(proc.setModelSettingsCalls).toEqual([])
      expect(session.proc).toBeNull()
    } finally { session.dispose() }
  })

  test('reselecting the old model after an unconfirmed stop cannot report an unchanged healthy process', async () => {
    const session = new Session('model-blocked-selection', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-stopping', 'glm')
    session.proc = proc
    session.blockedProc = proc
    session.blockedProcReason = 'SDK close timeout'
    session.selectedProvider = 'claude'; session.selectedTokenSourceId = 'glm'
    session.selectedModel = 'GLM-5.2'; session.selectedEffort = 'max'
    session.modelPanels.set('switch', { models: [{ provider: 'claude', sourceId: 'glm',
      model: 'GLM-5.2', displayName: 'GLM', efforts: [{ effort: 'max' }] }] })
    proc.kill = async () => { throw new Error('SDK close timeout') }
    try {
      const result = await session.onModelEffortSelect('GLM-5.2', 'max', 'switch', '', 'claude')
      expect(result).toMatchObject({ ok: false, message: '模型切换失败: SDK close timeout' })
      expect(proc.setModelSettingsCalls).toEqual([])
    } finally { session.dispose() }
  })

  test('model selection write failure remains visible and does not change in-memory routing', async () => {
    const session = new Session('model-write-failure', 'chat_id') as any
    session.selectedProvider = 'claude'; session.selectedTokenSourceId = 'glm'
    session.selectedModel = 'GLM-5.2'; session.selectedEffort = 'max'
    session.modelPanels.set('switch', { models: [{ provider: 'claude', sourceId: 'deepseek',
      model: 'deepseek-v4-pro', displayName: 'DeepSeek', efforts: [{ effort: 'high' }] }] })
    const save = spyOn(feishu, 'bindSessionModelChecked').mockImplementation(() => { throw new Error('model map fsync failed') })
    try {
      const result = await session.onModelEffortSelect('deepseek-v4-pro', 'high', 'switch', '', 'claude')
      expect(result).toMatchObject({ ok: false, message: '模型切换失败: model map fsync failed' })
      expect(session.conversationRouting()).toMatchObject({ provider: 'claude', tokenSourceId: 'glm',
        model: 'GLM-5.2', effort: 'max' })
      expect(session.modelPanels.has('switch')).toBe(true)
    } finally {
      save.mockRestore()
      session.dispose()
    }
  })

  test.each([false, true])('provider switch preserves pending conversation state on write failure (restore failure: %s)', async restoreFails => {
    const session = new Session('model-pending-write-failure', 'chat_id') as any
    session.selectedProvider = 'claude'; session.selectedTokenSourceId = 'glm'
    session.selectedModel = 'GLM-5.2'; session.selectedEffort = 'max'
    const pending = { launch: { kind: 'fork' as const, source: {
      provider: 'claude' as const, sessionId: 'fork-source', cwd: session.workDir,
    } }, previousSessionId: 'previous-session' }
    session.pendingConversationMaterialization = pending
    pendingConversationLaunchBySession.set(session.sessionName, pending)
    branchBaseBySession.set(session.sessionName, { kind: 'fresh' })
    const save = spyOn(feishu, 'bindSessionModelChecked').mockImplementation(() => {
      if (restoreFails) setTurnAnchorWriteError(new Error('turn state restore failed'))
      throw new Error('model map fsync failed')
    })
    try {
      const switching = session.applyModelSelection('codex', 'gpt-6-astra', 'max', 'codex-sub')
      await expect(switching).rejects.toThrow(restoreFails
        ? 'model selection write failed: model map fsync failed; conversation state restore failed: turn state restore failed'
        : 'model map fsync failed')
      expect(session.selectedProvider).toBe('claude')
      expect(session.pendingConversationMaterialization).toBe(pending)
      if (!restoreFails) {
        expect(pendingConversationLaunchBySession.get(session.sessionName)).toEqual(pending)
        expect(branchBaseBySession.get(session.sessionName)).toEqual({ kind: 'fresh' })
      }
    } finally {
      setTurnAnchorWriteError(null)
      save.mockRestore()
      session.dispose()
    }
  })

  test('a confirmed process exit does not hide an SDK close error or commit the target model', async () => {
    const session = new Session('model-close-error', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-before-switch', 'glm')
    session.proc = proc
    session.selectedProvider = 'claude'; session.selectedTokenSourceId = 'glm'
    session.selectedModel = 'GLM-5.2'; session.selectedEffort = 'max'
    proc.kill = async () => { proc.alive = false; throw new Error('SDK close failed') }
    try {
      await expect(session.applyModelSelection('claude', 'deepseek-v4-pro', 'high', 'deepseek'))
        .rejects.toThrow('SDK close failed')
      expect(session.proc).toBeNull()
      expect(session.selectedTokenSourceId).toBe('glm')
      expect(session.selectedModel).toBe('GLM-5.2')
    } finally { session.dispose() }
  })

  test('reselecting the active GLM model and max effort is idempotent', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1', 'glm')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.selectedTokenSourceId = 'glm'
    session.selectedModel = 'GLM-5.2'
    session.selectedEffort = 'max'
    session.modelPanels.set('panel-glm', { models: [{
      provider: 'claude', sourceId: 'glm', model: 'GLM-5.2', displayName: 'GLM-5.2',
      efforts: [{ effort: 'max', isDefault: true, selected: true }],
    }] })

    const result = await session.onModelEffortSelect('GLM-5.2', 'max', 'panel-glm', 'ou_user', 'claude')

    expect(result.ok).toBe(true)
    expect(result.message).toContain('当前已是')
    expect(proc.setModelSettingsCalls).toEqual([])
    expect(proc.killCalls).toBe(0)
    expect(session.proc).toBe(proc)
  })

  test('fresh-rebuilds a same-provider process with no current id even when disk has an old resume id', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('codex', null)
    session.proc = proc
    session.selectedProvider = 'codex'
    session.selectedModel = 'gpt-5.5'
    session.lastSessionId = 'stale-codex-session-on-disk'
    const restartCalls = installSuccessfulIdleRebuild(session)

    const result = await session.onModelEffortSelect('gpt-5.6-sol', 'max', '', 'ou_user', 'codex')

    expect(result.ok).toBe(true)
    expect(proc.killCalls).toBe(1)
    expect(restartCalls).toHaveLength(1)
    expect(restartCalls[0].resume).toBe(false)
    expect(restartCalls[0].opts.resumeIdentity).toBeUndefined()
  })

  test('one real effort applies directly, while an empty effort catalog cannot change the selection', async () => {
    const session = new Session('single-effort', 'chat_id') as any
    try {
      session.selectedProvider = 'codex'; session.selectedTokenSourceId = 'codex-sub'
      session.selectedModel = 'gpt-6-astra'; session.selectedEffort = 'max'
      session.modelPanels.set('single', { models: [{ provider: 'claude', sourceId: 'glm', model: 'GLM-5.2',
        displayName: 'GLM-5.2', efforts: [{ effort: 'max' }] }] })
      const selected = await session.onModelSelect('GLM-5.2', 'single', '', { provider: 'claude' })
      expect(selected.ok).toBe(true)
      expect(session.selectedEffort).toBe('max')
      expect(JSON.stringify(selected.card)).not.toContain('选择 effort')
      session.modelPanels.set('empty', { models: [{ provider: 'claude', sourceId: 'glm', model: 'GLM-unknown',
        displayName: 'GLM-unknown', efforts: [] }] })
      const missing = await session.onModelSelect('GLM-unknown', 'empty', '', { provider: 'claude' })
      expect(missing).toMatchObject({ ok: false, message: '模型未返回 effort' })
      expect(session.selectedModel).toBe('GLM-5.2')
      expect(session.selectedEffort).toBe('max')
    } finally { session.dispose() }
  })

  test('preserves a persisted GLM-5.2 slug instead of rewriting it to a legacy profile key', () => {
    modelSelections.set('persisted-glm', {
      provider: 'claude', model: 'GLM-5.2', effort: 'max', tokenSourceId: 'glm',
    })

    const session = new Session('persisted-glm', 'chat_id') as any

    expect(session.selectedProvider).toBe('claude')
    expect(session.selectedTokenSourceId).toBe('glm')
    expect(session.selectedModel).toBe('GLM-5.2')
    expect(session.selectedEffort).toBe('max')
  })

  test('keeps an explicit unavailable source and fails closed instead of switching accounts', () => {
    modelSelections.set('missing-source', {
      provider: 'claude', model: 'model-x', effort: 'high', tokenSourceId: 'removed-account',
    })
    const session = new Session('missing-source', 'chat_id') as any

    expect(session.selectedTokenSourceId).toBe('removed-account')
    expect(() => session.spawnAgent()).toThrow('token source "removed-account" 不可用')
  })

  test('replaces an idle process when the same source id gets new spawn credentials', async () => {
    const source = getTokenSource('glm')!
    const prevEnabled = source.enabled
    const prevRevision = source.spawnRevision
    source.enabled = true
    source.spawnRevision = 'new-credentials'
    try {
      const session = new Session('probe', 'chat_id') as any
      const proc = new FakeAgentProc('claude', 'claude-session-1', 'glm')
      session.proc = proc
      session.selectedProvider = 'claude'
      session.selectedTokenSourceId = 'glm'
      session.procSourceRevisions.set(proc, 'old-credentials')

      await session.stopIdleMismatchedProcess()

      expect(proc.killCalls).toBe(1)
      expect(session.proc).toBeNull()
    } finally {
      source.enabled = prevEnabled
      source.spawnRevision = prevRevision
    }
  })

  test('idle provider switch settles Codex materialization and deferred checkpoint before kill', async () => {
    const session = new Session('idle-switch-materialize', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'fresh-thread')
    proc.launchKind = 'fresh'
    proc.conversationResumable = false
    session.selectedProvider = 'codex'
    session.proc = proc
    session.wireProc(proc)
    const checkpoint = {
      provider: 'codex' as const,
      kind: 'turn' as const,
      id: 'turn-fast',
      source: { provider: 'codex' as const, sessionId: 'fresh-thread', cwd: session.workDir },
    }
    proc.emit('result', { is_error: false, checkpoint })
    expect(session.pendingCodexTurnAnchors).toHaveLength(1)
    let releaseVerification: () => void = () => {}
    proc.materializationBarrier = new Promise<void>(resolve => { releaseVerification = resolve })
    session.selectedProvider = 'claude'

    const stopping = session.stopIdleMismatchedProcess()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(proc.killCalls).toBe(0)
    proc.conversationResumable = true
    releaseVerification()
    await stopping

    expect(proc.killCalls).toBe(1)
    expect(session.pendingCodexTurnAnchors).toHaveLength(0)
    expect(resumeRefs.get(`${session.sessionName}:codex`)?.sessionId).toBe('fresh-thread')
    expect(turnAnchorsBySession.get(session.sessionName)?.[0]?.checkpoint).toEqual(checkpoint)
  })

  test('rejects non-fixed Claude model outside the two fixed choices', async () => {
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

  test('accepts the first-party Claude Code choices (Opus 5 / Fable 5, max)', async () => {
    for (const model of ['claude:opus', 'claude:fable']) {
      const session = new Session('probe', 'chat_id') as any
      const proc = new FakeAgentProc('claude', 'claude-session-1')
      session.proc = proc
      session.selectedProvider = 'claude'
      session.selectedModel = 'claude:default'
      const restartCalls = installSuccessfulIdleRebuild(session)

      const result = await session.onModelEffortSelect(model, 'max', '', 'ou_user', 'claude')

      expect(result.ok).toBe(true)
      expect(session.selectedModel).toBe(model)
      expect(proc.killCalls).toBe(1) // model 变更 → 空闲 Claude 进程重生,新 env 下轮生效
      expect(restartCalls).toHaveLength(1)
      expect(session.proc).not.toBe(proc)
    }
  })

  test('model 选择器只通过 Claude 展示无痕与 CatCodex Grok', () => {
    const prevClaude = config.claude.models
    const prevCodex = config.codex.models
    ;(config.claude as any).models = {
      grok: { model: 'grok-4.6', base_url: 'https://api.wuhen-ai.com', auth_token: 'w', effort: 'xhigh' },
      grokcc: { model: 'grok-4.6', base_url: 'https://catcodexapi.com', auth_token: 'c', effort: 'xhigh' },
    }
    ;(config.codex as any).models = {
      grok: {
        display_name: 'Codex · Grok 4.6 · 无痕',
        description: 'Grok 4.6 · Codex Responses 工具链。',
        model: 'grok-4.6',
        base_url: 'https://api.wuhen-ai.com',
        wire_api: 'responses',
        api_key: 'grok-token',
        effort: 'xhigh', // Legacy Codex route is hidden; Claude normalizes Grok to official xhigh.
      },
    }
    try {
      const session = new Session('probe', 'chat_id') as any
      session.selectedProvider = 'claude'
      const choices = fixedModelChoices(session)
      const claudeModels = choices.filter((c: any) => c.provider === 'claude').map((c: any) => c.model)
      expect(claudeModels).toContain('claude:opus')
      expect(claudeModels).toContain('claude:fable')
      expect(claudeModels).toContain('claude:glm')
      expect(claudeModels).toContain('claude:grok')
      expect(claudeModels).toContain('claude:grokcc')
      for (const c of choices.filter((c: any) => c.provider === 'claude' && !c.model.includes('grok'))) {
        expect(c.efforts.map((e: any) => e.effort)).toEqual(['max'])
      }
      const glm = choices.find((c: any) => c.model === 'claude:glm')
      expect(glm!.description).toContain('[claude.models.glm]')
      expect(choices.some((c: any) => c.provider === 'codex' && c.model.includes('grok'))).toBe(false)
      expect(choices.find((c: any) => c.model === 'claude:grok')).toMatchObject({
        provider: 'claude', displayName: 'Claude · Grok 4.6 · 无痕',
        efforts: [{ effort: 'xhigh' }],
      })
      expect(choices.find((c: any) => c.model === 'claude:grokcc')).toMatchObject({
        provider: 'claude', displayName: 'Claude · Grok 4.6 · CatCodex',
        efforts: [{ effort: 'xhigh' }],
      })
    } finally {
      ;(config.claude as any).models = prevClaude
      ;(config.codex as any).models = prevCodex
    }
  })

  test('GLM 档位的 effort 跟随 config(xhigh)而非写死 max;官方档位仍 max', () => {
    const prev = config.claude.models
    ;(config.claude as any).models = {
      glm: { model: 'glm-5.3', base_url: 'https://open.bigmodel.cn/api/anthropic', auth_token: 't', effort: 'xhigh' },
    }
    try {
      const session = new Session('probe', 'chat_id') as any
      session.selectedProvider = 'claude'
      const choices = fixedModelChoices(session)
      const glm = choices.find((c: any) => c.model === 'claude:glm')
      expect(glm!.efforts.map((e: any) => e.effort)).toEqual(['xhigh'])
      const opus = choices.find((c: any) => c.model === 'claude:opus')
      expect(opus!.efforts.map((e: any) => e.effort)).toEqual(['max'])
    } finally {
      ;(config.claude as any).models = prev
    }
  })

  test('Codex Grok 配置不会出现在模型选择器', () => {
    const prev = config.codex.models
    ;(config.codex as any).models = {
      grok: {
        model: 'grok-4.6',
        base_url: 'https://api.wuhen-ai.com',
        wire_api: 'responses',
        api_key: 't',
        effort: 'xhigh',
      },
    }
    try {
      const session = new Session('probe', 'chat_id') as any
      session.selectedProvider = 'codex'
      const choices = fixedModelChoices(session)
      expect(choices.find((c: any) => c.model === 'codex:grok')).toBeUndefined()
      const sol = choices.find((c: any) => c.model === 'gpt-5.6-sol')
      expect(sol!.efforts.map((e: any) => e.effort)).toEqual(['max'])
    } finally {
      ;(config.codex as any).models = prev
    }
  })

  test('飞书点击两个 Grok 档位都持久为 provider=claude', async () => {
    const prev = config.claude.models
    ;(config.claude as any).models = {
      grok: { model: 'grok-4.6', base_url: 'https://api.wuhen-ai.com', auth_token: 'w', effort: 'xhigh' },
      grokcc: { model: 'grok-4.6', base_url: 'https://catcodexapi.com', auth_token: 'c', effort: 'xhigh' },
    }
    try {
      for (const model of ['claude:grok', 'claude:grokcc']) {
        const effort = 'xhigh'
        const session = new Session('probe', 'chat_id') as any
        session.selectedProvider = 'claude'
        session.selectedModel = 'claude:fable'
        session.selectedEffort = 'max'
        installSuccessfulIdleRebuild(session)
        const incompatible = await session.onModelEffortSelect(model, 'max', '', 'ou_user', 'claude')
        expect(incompatible.ok).toBe(false)
        const result = await session.onModelEffortSelect(model, effort, '', 'ou_user', 'claude')
        expect(result.ok).toBe(true)
        expect(session.selectedProvider).toBe('claude')
        expect(session.selectedModel).toBe(model)
        expect(session.selectedEffort).toBe(effort)
      }
    } finally {
      ;(config.claude as any).models = prev
    }
  })

  test('配好 xhigh 的 GLM:选 xhigh 通过,选 max 因不匹配被拒', async () => {
    const prev = config.claude.models
    ;(config.claude as any).models = {
      glm: { model: 'glm-5.3', base_url: 'https://open.bigmodel.cn/api/anthropic', auth_token: 't', effort: 'xhigh' },
    }
    try {
      const mk = () => {
        const s = new Session('probe', 'chat_id') as any
        s.proc = new FakeAgentProc('claude', 'claude-session-1')
        s.selectedProvider = 'claude'
        s.selectedModel = 'claude:fable'
        installSuccessfulIdleRebuild(s)
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

  test('未配置 Claude Grok token 时两个档位都被拦截', async () => {
    const prev = config.claude.models
    ;(config.claude as any).models = {}
    try {
      for (const model of ['claude:grok', 'claude:grokcc']) {
        const effort = 'xhigh'
        const session = new Session('probe', 'chat_id') as any
        const proc = new FakeAgentProc('claude', 'claude-session-1')
        session.proc = proc
        session.selectedProvider = 'claude'
        session.selectedModel = 'claude:fable'
        const result = await session.onModelEffortSelect(model, effort, '', 'ou_user', 'claude')
        expect(result.ok).toBe(false)
        expect(result.message).toContain(`[claude.models.${model.slice('claude:'.length)}]`)
        expect(session.selectedModel).toBe('claude:fable')
        expect(proc.killCalls).toBe(0)
      }
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
      onStatus: (status: string) => statuses.push(status),
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
      onStatus: (status: string) => statuses.push(status),
    })

    expect(ok).toBe(true)
    expect(initializeCalls).toBe(1)
    // 合并调和(取舍):模型行统一走上游 footerModelLabel(provider 小写;
    // 无模型显示 MISS),本地旧格式 '· Claude · max' 随合并退役。effort 部分
    // 不做精确 pin:构造器会按环境推导 enabled claude source(如本机 glm),
    // 档位取该 source 模型的 defaultEffort;无 source 时才回落 CLAUDE_EFFORT
    // → max(上游「source 默认 effort 权威」语义)。
    expect(statuses.some(s => s.includes('✅ Claude 已就绪 · claude · MISS/'))).toBe(true)
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

      // 合并调和(取舍):冷启动首发按本地语义直送用户原文;上游的
      // fileDeliveryAgentContext 首投注入不适用于本地投递 pin(与 main 的
      // ['hello'] 断言一致,spawn 时 developerInstructions 已给约定)。
      expect(proc.sentTexts).toEqual(['hello'])
      expect(session.currentTurn).not.toBeNull()
      expect(session.status).toBe('working')
    } finally {
      session.stopFooterStatus(session.currentTurn)
      if (session.currentTurn) await cardkit.dispose(session.currentTurn.cardId)
    }
  })

})

describe('Session starts from cached model catalogs', () => {
  for (const resume of [false, true]) {
    test(`${resume ? 'resume' : 'fresh start'} uses cached models without waiting for unrelated refresh and keeps its selection`, async () => {
      const previousSources = listTokenSources()
      resetTokenSourceRegistry()
      let releaseModels!: () => void
      const modelsGate = new Promise<void>(resolve => { releaseModels = resolve })
      const source: import('./token-source').TokenSource = {
        id: 'catalog-test', kind: 'test', agent: 'codex', display: 'Test Codex', enabled: true,
        models: [{ model: 'gpt-6-astra', display: 'Astra', efforts: ['max', 'ultra'], defaultEffort: 'max' }],
        defaultModel: 'gpt-6-astra', modelCatalogState: { status: 'ready', updatedAt: 1 },
        async refreshModels() {
          await modelsGate
          source.models = [{ model: 'gpt-6-astra', display: 'Astra', efforts: ['max', 'ultra'], defaultEffort: 'max' }]
          source.defaultModel = 'gpt-6-astra'
          source.modelCatalogState = { status: 'ready', updatedAt: Date.now() }
        },
        spawnEnv: env => env,
        resolveSpawnModel: model => model,
        readUsage: async () => ({ state: 'not_applicable', windows: [] }),
      }
      registerTokenSource(source)
      const refresh = refreshAllTokenSourceModels()
      const name = resume ? 'catalog-resume' : 'catalog-start'
      modelSelections.set(name, { provider: 'codex', model: 'gpt-6-astra', effort: 'ultra', tokenSourceId: source.id })
      const savedRef = { provider: 'codex' as const, sessionId: 'original-session', cwd: `/tmp/lodestar-projects/${name}` }
      if (resume) resumeRefs.set(`${name}:codex`, savedRef)
      const session = new Session(name, 'chat_id') as any
      const proc = new FakeAgentProc('codex', resume ? savedRef.sessionId : 'new-session', source.id)
      let spawns = 0
      session.spawnAgent = (ref?: typeof savedRef) => {
        spawns++
        expect(source.modelCatalogState?.status).toBe('ready')
        expect(session.selectedModel).toBe('gpt-6-astra')
        expect(session.selectedEffort).toBe('ultra')
        expect(ref).toEqual(resume ? savedRef : undefined)
        return proc
      }
      const opts = { announce: false, onStatus: () => {} }
      const starting = resume ? session.restart(true, opts) : session.start(opts)
      try {
        expect(await starting).toBe(true)
        expect(spawns).toBe(1)
        expect(session.proc).toBe(proc)
        if (resume) expect(session.lastSessionId).toBe(savedRef.sessionId)
      } finally {
        releaseModels()
        await refresh
        await starting
        await session.stop('test cleanup', { announce: false })
        resetTokenSourceRegistry()
        for (const item of previousSources) registerTokenSource(item)
      }
    })
  }
})

describe('Session turn close vs mid-turn rotation race', () => {
  const renderedFormula = {
    blocks: [
      { type: 'markdown' as const, text: '前文' },
      {
        type: 'image' as const,
        tex: 'x^2',
        index: 0,
        element: {
          tag: 'img', img_key: 'img_rotation_formula',
          alt: { tag: 'plain_text', content: 'x^2' },
          scale_type: 'crop_center', size: '48px 24px', preview: false,
        },
      },
      { type: 'markdown' as const, text: '后文' },
    ],
    formulaCount: 1,
    renderedImageCount: 1,
  }

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

  test('drains a pending old-card raw write before deciding which failed formula segment to migrate', async () => {
    const session = new Session('rotate-raw-failure', 'chat_id') as any
    const turn = turnState('card_rotate_raw_old')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    let signalOldPostStarted: () => void = () => {}
    const oldPostStarted = new Promise<void>(resolve => { signalOldPostStarted = resolve })
    let releaseOldPost: () => void = () => {}
    const oldPostGate = new Promise<void>(resolve => { releaseOldPost = resolve })
    const renderSpy = spyOn(mathRender, 'renderMathInText').mockResolvedValue(renderedFormula as any)
    let rotation: Promise<void> | null = null

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (path === '/cards/id_convert') {
        return new Response(JSON.stringify({ code: 0, data: { card_id: 'card_rotate_raw_new' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (method === 'POST' && path === '/cards/card_rotate_raw_old/elements') {
        signalOldPostStarted()
        await oldPostGate
        return new Response(JSON.stringify({ code: 300308, msg: 'old raw rejected' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      session.appendAssistant('前文 $$x^2$$ 后文')
      session.finalizeCurrentAssistantSegment()
      await oldPostStarted

      session.startMidTurnRotate(turn)
      rotation = turn.rotating
      expect(rotation).not.toBeNull()
      releaseOldPost()
      await rotation

      const newInflight = turn.mathRenderInflight?.get('card_rotate_raw_new')
      if (newInflight?.size) await Promise.allSettled([...newInflight])
      await cardkit.flush('card_rotate_raw_new')

      const migratedAdd = calls.find(call =>
        call.method === 'POST' && call.path === '/cards/card_rotate_raw_new/elements',
      )
      expect(migratedAdd).toBeDefined()
      const migrated = JSON.parse(migratedAdd!.body.elements)[0]
      expect(migrated.tag).toBe('column_set')
      expect(JSON.stringify(migrated)).toContain('前文')
      expect(JSON.stringify(migrated)).toContain('x^2')
      expect(JSON.stringify(migrated)).toContain('后文')
      expect(turn.cardId).toBe('card_rotate_raw_new')
      expect(cardkit.isDeadElement('card_rotate_raw_new', 'assistant_0')).toBe(false)
    } finally {
      releaseOldPost()
      if (rotation) await rotation.catch(() => {})
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
      renderSpy.mockRestore()
    }
  })

  test('rechecks completed tools after the old-card add queue settles', async () => {
    const session = new Session('rotate-late-tool-add', 'chat_id') as any
    const turn = turnState('card_tool_old')
    turn.userOpenId = ''
    turn.toolByUseId.set('tool_use_1', {
      i: 0,
      name: 'Read',
      input: { file_path: '/tmp/a.txt' },
      output: 'done',
      isError: false,
    })
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1, (code, failure) => {
      session.onCardWriteFailure('card_tool_old', code, failure)
    })

    let signalOldAddStarted: () => void = () => {}
    const oldAddStarted = new Promise<void>(resolve => { signalOldAddStarted = resolve })
    let releaseOldAdd: () => void = () => {}
    const oldAddGate = new Promise<void>(resolve => { releaseOldAdd = resolve })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (path === '/cards/id_convert') {
        return new Response(JSON.stringify({ code: 0, data: { card_id: 'card_tool_new' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (method === 'POST' && path === '/cards/card_tool_old/elements') {
        signalOldAddStarted()
        await oldAddGate
        return new Response(JSON.stringify({ code: 300305, msg: 'component count exceeds limit' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const oldAdd = cardkit.addElement(turn.cardId, {
      tag: 'collapsible_panel',
      element_id: 'tool_0',
      header: { title: { tag: 'plain_text', content: 'done' } },
      elements: [{ tag: 'markdown', content: 'done' }],
    })
    await oldAddStarted
    let rotation: Promise<void> | null = null
    try {
      session.startMidTurnRotate(turn)
      rotation = turn.rotating
      await waitUntil(() => turn.cardId === 'card_tool_new')
      expect(turn.toolByUseId.has('tool_use_1')).toBe(false)

      releaseOldAdd()
      await oldAdd
      await rotation
      await cardkit.flush('card_tool_new')

      expect(turn.toolByUseId.has('tool_use_1')).toBe(true)
      expect(calls.some(call =>
        call.method === 'POST' &&
        call.path === '/cards/card_tool_new/elements' &&
        JSON.parse(call.body.elements)[0]?.element_id === 'tool_0'
      )).toBe(true)
      expect(turn.rotateCount).toBe(1)
      expect(turn.failureRotateCount).toBe(0)
    } finally {
      releaseOldAdd()
      if (rotation) await rotation.catch(() => {})
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('the second tool rebuild pass is idempotent for unfinished regular and batch tools', async () => {
    for (const kind of ['regular', 'batch'] as const) {
      calls = []
      resetFeishuMock()
      const session = new Session(`rotate-idempotent-${kind}`, 'chat_id') as any
      const turn = turnState(`card_${kind}_old`)
      turn.userOpenId = ''
      const useId = `tool_${kind}_use`
      const input = { file_path: `/tmp/${kind}.txt` }
      turn.toolByUseId.set(useId, {
        i: 0,
        name: 'Read',
        input,
        ...(kind === 'batch' ? { batchSlot: 0 } : {}),
      })
      if (kind === 'batch') {
        turn.toolBatches.set(0, {
          kind: 'read',
          items: [{ toolUseId: useId, input, output: null, isError: false }],
        })
      }
      session.currentTurn = turn
      cardkit.recordCardCreated(turn.cardId, 1)
      const newCardId = `card_${kind}_new`
      globalThis.fetch = (async (inputArg: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(inputArg))
        const path = url.pathname.replace('/open-apis/cardkit/v1', '')
        const method = String(init?.method ?? 'GET')
        calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
        const data = path === '/cards/id_convert' ? { card_id: newCardId } : {}
        return new Response(JSON.stringify({ code: 0, data }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof fetch

      try {
        session.startMidTurnRotate(turn)
        await turn.rotating
        await cardkit.flush(newCardId)

        const newToolAdds = calls.filter(call =>
          call.method === 'POST' &&
          call.path === `/cards/${newCardId}/elements` &&
          JSON.parse(call.body.elements)[0]?.element_id?.startsWith('tool_')
        )
        expect(newToolAdds).toHaveLength(1)
        expect(turn.toolByUseId.size).toBe(1)
        expect(turn.toolCount).toBe(1)
      } finally {
        session.stopFooterStatus(turn)
        await cardkit.dispose(turn.cardId)
      }
    }
  })

  test('waits for formula rendering registered by a successful pending raw write before closing the old card', async () => {
    const session = new Session('rotate-slow-formula', 'chat_id') as any
    const turn = turnState('card_rotate_formula_old')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    let signalOldPostStarted: () => void = () => {}
    const oldPostStarted = new Promise<void>(resolve => { signalOldPostStarted = resolve })
    let releaseOldPost: () => void = () => {}
    const oldPostGate = new Promise<void>(resolve => { releaseOldPost = resolve })
    let signalRenderStarted: () => void = () => {}
    const renderStarted = new Promise<void>(resolve => { signalRenderStarted = resolve })
    let releaseRender: () => void = () => {}
    const renderGate = new Promise<typeof renderedFormula>(resolve => {
      releaseRender = () => resolve(renderedFormula)
    })
    const renderSpy = spyOn(mathRender, 'renderMathInText').mockImplementation(async () => {
      signalRenderStarted()
      return renderGate as any
    })
    let rotation: Promise<void> | null = null

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (path === '/cards/id_convert') {
        return new Response(JSON.stringify({ code: 0, data: { card_id: 'card_rotate_formula_new' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (method === 'POST' && path === '/cards/card_rotate_formula_old/elements') {
        signalOldPostStarted()
        await oldPostGate
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      session.appendAssistant('前文 $$x^2$$ 后文')
      session.finalizeCurrentAssistantSegment()
      await oldPostStarted

      session.startMidTurnRotate(turn)
      rotation = turn.rotating
      expect(rotation).not.toBeNull()
      let rotationDone = false
      void rotation!.then(() => { rotationDone = true })
      releaseOldPost()
      await renderStarted
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(rotationDone).toBe(false)
      expect(cardkit.isDisposed('card_rotate_formula_old')).toBe(false)

      releaseRender()
      await rotation

      const formulaPutIndex = calls.findIndex(call =>
        call.method === 'PUT' && call.path === '/cards/card_rotate_formula_old/elements/assistant_0',
      )
      const closePatchIndex = calls.findIndex(call =>
        call.method === 'PATCH' && call.path === '/cards/card_rotate_formula_old/settings',
      )
      expect(formulaPutIndex).toBeGreaterThanOrEqual(0)
      expect(closePatchIndex).toBeGreaterThan(formulaPutIndex)
      // 收尾 replace 跳过已渲染段(oldRendered):旧卡 assistant_0 只有渲染版这
      // 一次 PUT,原文不覆盖回 $$…$$ 降级。
      const oldSegPuts = calls.filter(call =>
        call.method === 'PUT' && call.path === '/cards/card_rotate_formula_old/elements/assistant_0',
      )
      expect(oldSegPuts).toHaveLength(1)
      expect(JSON.stringify(oldSegPuts[0]!.body)).toContain('img_rotation_formula')
      expect(cardkit.isDisposed('card_rotate_formula_old')).toBe(true)
      expect(turn.cardId).toBe('card_rotate_formula_new')
    } finally {
      releaseOldPost()
      releaseRender()
      if (rotation) await rotation.catch(() => {})
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
      renderSpy.mockRestore()
    }
  })

  test('does not replay a deterministic migration failure onto a third card', async () => {
    const session = new Session('rotate-deferred-retry', 'chat_id') as any
    const turn = turnState('card_deferred_old')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1, (code, failure) => {
      session.onCardWriteFailure('card_deferred_old', code, failure)
    })

    let signalFirstConvert: () => void = () => {}
    const firstConvertStarted = new Promise<void>(resolve => { signalFirstConvert = resolve })
    let convertCount = 0
    const renderSpy = spyOn(mathRender, 'renderMathInText').mockResolvedValue(renderedFormula as any)

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (path === '/cards/id_convert') {
        convertCount++
        if (convertCount === 1) {
          signalFirstConvert()
          return new Response(JSON.stringify({ code: 0, data: { card_id: 'card_deferred_second' } }), {
            headers: { 'Content-Type': 'application/json' },
          })
        }
        throw new Error('a deterministic payload failure must not open a third card')
      }
      if (method === 'POST' && path === '/cards/card_deferred_old/elements') {
        return new Response(JSON.stringify({
          code: 300305,
          msg: 'The number of card components exceeds 200',
        }), { headers: { 'Content-Type': 'application/json' } })
      }
      if (method === 'POST' && path === '/cards/card_deferred_second/elements') {
        return new Response(JSON.stringify({
          code: 300315,
          msg: 'Duplicate ID; inner code: 300301',
        }), { headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    let firstRotation: Promise<void> | null = null
    try {
      session.appendAssistant('前文 $$x^2$$ 后文')
      session.finalizeCurrentAssistantSegment()
      await firstConvertStarted
      firstRotation = turn.rotating
      expect(firstRotation).not.toBeNull()
      await firstRotation

      expect(convertCount).toBe(1)
      expect(turn.rotateCount).toBe(1)
      expect(turn.failureRotateCount).toBe(1)
      expect(turn.cardId).toBe('card_deferred_second')
      expect(turn.rotating).toBeNull()
      expect(sentRawTexts).toHaveLength(1)
      // 合并调和(取舍):上游非容量写失败通知走 reportCardWriteFailure(附
      // formatFeishuError 原文);本地冻结文案为凭据安全的分类摘要(main 原文
      // "该错误不是卡片元素上限,已停止无效换卡")。按合并实现对齐。
      expect(sentRawTexts[0]).toContain('不是卡片元素上限')
      expect(sentRawTexts[0]).toContain('300315')
      expect(sentTexts).toEqual([])
    } finally {
      if (firstRotation) await firstRotation.catch(() => {})
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
      renderSpy.mockRestore()
    }
  })

  test('does not start a deferred retry when close captures the turn during migration failure', async () => {
    const session = new Session('rotate-deferred-close', 'chat_id') as any
    const turn = turnState('card_deferred_close_old')
    const rawReply = '前文 $$x^2$$ 后文'
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1, (code, failure) => {
      session.onCardWriteFailure('card_deferred_close_old', code, failure)
    })

    let signalMigrationPost: () => void = () => {}
    const migrationPostStarted = new Promise<void>(resolve => { signalMigrationPost = resolve })
    let releaseMigrationPost: () => void = () => {}
    const migrationPostGate = new Promise<void>(resolve => { releaseMigrationPost = resolve })
    let convertCount = 0
    const renderSpy = spyOn(mathRender, 'renderMathInText').mockResolvedValue(renderedFormula as any)

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (path === '/cards/id_convert') {
        convertCount++
        return new Response(JSON.stringify({ code: 0, data: { card_id: 'card_deferred_close_new' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (method === 'POST' && path === '/cards/card_deferred_close_old/elements') {
        return new Response(JSON.stringify({ code: 300305, msg: 'component count exceeds limit' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (method === 'POST' && path === '/cards/card_deferred_close_new/elements') {
        signalMigrationPost()
        await migrationPostGate
        return new Response(JSON.stringify({ code: 300315, msg: 'Duplicate ID; inner code: 300301' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    let close: Promise<void> | null = null
    try {
      session.appendAssistant(rawReply)
      session.finalizeCurrentAssistantSegment()
      await migrationPostStarted
      expect(turn.rotating).not.toBeNull()
      expect(turn.cardId).toBe('card_deferred_close_new')

      close = session.closeTurnCard(undefined, { hasFreshResult: false })
      expect(session.currentTurn).toBeNull()
      releaseMigrationPost()
      await close

      expect(convertCount).toBe(1)
      expect(turn.rotateCount).toBe(1)
      expect(turn.failureRotateCount).toBe(1)
      expect(turn.rotating).toBeNull()
      expect(session.currentTurn).toBeNull()
      expect(renderSpy).not.toHaveBeenCalled()
      expect(sentTexts).toHaveLength(1)
      expect(sentTexts[0]).toContain(rawReply)
    } finally {
      releaseMigrationPost()
      if (close) await close.catch(() => {})
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
      renderSpy.mockRestore()
    }
  })
})

describe('Session card size capacity', () => {
  for (const provider of ['codex', 'claude'] as const) {
    test(`${provider} preserves live deltas and whitespace while earlier paragraphs migrate`, async () => {
      const session = new Session('rotate-live-buffer', 'chat_id') as any
      const turn = turnState('card_live_buffer_old')
      turn.provider = provider
      turn.userOpenId = ''
      session.proc = new FakeAgentProc(provider, 'buffer-session')
      session.currentTurn = turn
      let migrationStarted!: () => void
      let releaseMigration!: () => void
      const started = new Promise<void>(resolve => { migrationStarted = resolve })
      const gate = new Promise<void>(resolve => { releaseMigration = resolve })
      cardkit.recordCardCreated(turn.cardId, 1, (code, failure) => {
        session.onCardWriteFailure('card_live_buffer_old', code, failure)
      })
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname.replace('/open-apis/cardkit/v1', '')
        const method = String(init?.method ?? 'GET')
        const body = init?.body ? JSON.parse(String(init.body)) : null
        calls.push({ method, path, body })
        if (method === 'POST' && path === '/cards/card_live_buffer_new/elements'
          && String(body.elements).includes('earlier paragraph')) {
          migrationStarted()
          await gate
        }
        const response = method === 'POST' && path === '/cards/card_live_buffer_old/elements'
          ? { code: 200860, msg: 'card over max size' }
          : { code: 0, data: path === '/cards/id_convert' ? { card_id: 'card_live_buffer_new' } : {} }
        return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } })
      }) as typeof fetch
      try {
        session.appendAssistant('earlier paragraph')
        session.finalizeCurrentAssistantSegment()
        session.appendAssistant('hello ')
        await started
        session.appendAssistant('world')
        session.finalizeCurrentAssistantSegment()
        releaseMigration()
        await turn.rotating
        await session.closeTurnCard(undefined, { hasFreshResult: false })
        const paragraphs = calls.filter(call => call.method === 'POST' && call.path === '/cards/card_live_buffer_new/elements')
          .map(call => JSON.parse(call.body.elements)[0].content)
        expect(paragraphs).toEqual(['earlier paragraph', 'hello world'])
        expect(sentTexts).toEqual([])
      } finally {
        releaseMigration()
        if (turn.rotating) await turn.rotating
        session.stopFooterStatus(turn)
        await cardkit.dispose('card_live_buffer_old')
        await cardkit.dispose(turn.cardId)
      }
    })
  }

  for (const provider of ['codex', 'claude'] as const) {
    // 合并取舍:上游签名还覆盖 'footer'(footer 写失败也换卡);本地定型
    // cardkit 语义是 footer 写入永不上升 card-level onFailure(cardkit.ts:
    // tick 丢一次不烧换卡额度,src/cardkit.test.ts 'footer replaceElement
    // failures do not elevate to card-level onFailure' 钉住),即 footer 变体
    // 在上游语义下才有换卡路径,本地不存在该行为,故不再生成该变体。
    for (const operation of ['addElement', 'replaceElement'] as const) {
      test(`${provider} preserves tool output when ${operation} exceeds card size below the element count limit`, async () => {
        const session = new Session('card-size', 'chat_id') as any
        const oldCardId = `card_size_${provider}_${operation}_old`
        const newCardId = `card_size_${provider}_${operation}_new`
        const turn = turnState(oldCardId)
        turn.provider = provider
        turn.userOpenId = ''
        turn.toolByUseId.set('tool_use_size', {
          i: 0, name: 'Bash', input: { command: '# desc: 查看结果\nprintf result' },
          // 合并取舍(见上方 loop 收窄注释):footer 变体不再生成,原
          // `operation !== 'footer' ? {...} : {}` 分支已死,直接落 output。
          output: 'retained tool result', isError: false,
        })
        session.proc = new FakeAgentProc(provider, 'native-session')
        session.currentTurn = turn
        let rotation: Promise<void> | null = null
        cardkit.recordCardCreated(oldCardId, 2, (code, failure) => {
          session.onCardWriteFailure(oldCardId, code, failure)
          rotation = turn.rotating
        })
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const path = new URL(String(input)).pathname.replace('/open-apis/cardkit/v1', '')
          const method = String(init?.method ?? 'GET')
          calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
          const rejected = operation === 'addElement'
            ? method === 'POST' && path === `/cards/${oldCardId}/elements`
            : method === 'PUT' && path === `/cards/${oldCardId}/elements/tool_0`
          return new Response(JSON.stringify(rejected
            ? { code: 200860, msg: 'ErrMsg: card over max size;' }
            : { code: 0, data: path === '/cards/id_convert' ? { card_id: newCardId } : {} }), {
            headers: { 'Content-Type': 'application/json' },
          })
        }) as typeof fetch

        try {
          const landed = operation === 'addElement'
            ? await cardkit.addElementChecked(oldCardId, {
                tag: 'markdown', element_id: 'tool_0', content: 'retained tool result',
              }, { type: 'insert_before', targetElementId: 'footer' })
            : await cardkit.replaceElementChecked(oldCardId, 'tool_0', {
                tag: 'markdown', element_id: 'tool_0', content: 'retained tool result',
              })
          expect(landed).toBe(false)
          expect(rotation).not.toBeNull()
          await rotation
          await cardkit.flush(newCardId)

          expect(turn.cardId).toBe(newCardId)
          expect(turn.rotateCount).toBe(1)
          expect(turn.failureRotateCount).toBe(1)
          expect(turn.cardRotationFailed).toBe(false)
          expect(sentCards).toHaveLength(1)
          const migrated = calls.filter(call => call.path.startsWith(`/cards/${newCardId}/elements`))
          // 合并调和:上游断言工具结果原文进换后卡(上游 renderBashBody 全量渲染
          // output);本地定型卡面(src/cards/tool.ts,控 200860 体积)隐藏命令与
          // 输出。保留用例本意"迁移后工具面板在换后卡上仍在",改钉面板行本身
          // (工具标题 + 完成态)已重建。
          expect(JSON.stringify(migrated)).toContain('查看结果')
          expect(JSON.stringify(migrated)).toContain('已完成')
          expect(turn.toolByUseId.has('tool_use_size')).toBe(true)
          expect(sentRawTexts.join('\n')).not.toContain('未识别为卡片容量超限')
          expect(calls.filter(call => call.method === 'POST' && call.path === `/cards/${newCardId}/elements`)).toHaveLength(1)
        } finally {
          if (rotation) await rotation
          session.stopFooterStatus(turn)
          await cardkit.dispose(oldCardId)
          await cardkit.dispose(newCardId)
        }
      })
    }
  }

  test('an unchanged oversized tool reports its failure while later output stays writable', async () => {
    const session = new Session('card-size-persistent', 'chat_id') as any
    const turn = turnState('card_size_persistent_0')
    turn.userOpenId = ''
    session.currentTurn = turn
    let replacementCount = 0
    cardkit.recordCardCreated(turn.cardId, 2, (code, failure) => {
      session.onCardWriteFailure('card_size_persistent_0', code, failure)
    })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      const response = path === '/cards/id_convert'
        ? { code: 0, data: { card_id: `card_size_persistent_${++replacementCount}` } }
        : method === 'POST' && path.endsWith('/elements') && String(init?.body).includes('超大工具结果')
          ? { code: 200860, msg: 'ErrMsg: card over max size;' }
          : { code: 0, data: {} }
      return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    try {
      sessionTools.addTool(session, session.proc, 'oversized-tool', 'Bash', { command: '# desc: 超大工具结果\nprintf result' })
      await cardkit.flush('card_size_persistent_0')
      await waitUntil(() => replacementCount > 0 && !turn.rotating)
      expect(replacementCount).toBe(1)
      expect(turn.cardRotationFailed).toBe(false)
      expect(turn.failureRotateCount).toBe(1)
      expect(turn.footerStatusHandle).not.toBeNull()
      expect(sentRawTexts).toHaveLength(1)
      expect(sentRawTexts[0]).toContain('换卡后仍超出飞书容量，写入失败')
      expect(sentRawTexts[0]).toContain('其余输出继续处理')
      expect(await cardkit.addElementChecked(turn.cardId, {
        tag: 'markdown', element_id: 'after_failure', content: '后续正文',
      })).toBe(true)
      sessionTools.addTool(session, session.proc, 'later-tool', 'Bash', { command: '# desc: 后续工具\nprintf ok' })
      await cardkit.flush(turn.cardId)
      sessionTools.completeTool(session, session.proc, 'later-tool', '后续工具结果', false)
      await cardkit.flush(turn.cardId)
      // 合并调和:同 describe 前例 —— 上游钉工具结果原文进卡,本地定型卡面
      // 隐藏命令与输出;用例本意"容量失败后后续输出仍可写"由前述
      // addElementChecked 断言承担,这里改钉后续工具面板完成态落地。
      const laterPanel = JSON.stringify(calls.filter(call => call.path.startsWith(`/cards/${turn.cardId}/elements`)))
      expect(laterPanel).toContain('后续工具')
      expect(laterPanel).toContain('已完成')
      expect(replacementCount).toBe(1)
    } finally {
      if (turn.rotating) await turn.rotating
      session.stopFooterStatus(turn)
      for (let i = 0; i <= replacementCount; i++) await cardkit.dispose(`card_size_persistent_${i}`)
    }
  })
})

describe('Session project tasklist', () => {
  test('main, multiple worktrees and temporary groups share the project tasklist throughout its lifecycle', async () => {
    const tasklist = await import('./tasklist')
    const projectName = 'task-project'
    const shared = {
      projectName, guid: 'shared-tasklist', name: `${projectName}[lodestar]`,
      url: 'https://example.com/tasks/shared', ownerOpenId: 'owner',
    }
    let enabled = false
    let creations = 0
    const reads: string[] = []
    const enableCalls: Array<[string, string]> = []
    const deleteCalls: Array<[string, string]> = []
    const get = spyOn(tasklist, 'getTasklistBinding').mockImplementation(name => {
      reads.push(name)
      return name === projectName && enabled ? shared : null
    })
    const enable = spyOn(tasklist, 'enableTasklist').mockImplementation(async (name, chatId) => {
      enableCalls.push([name, chatId])
      if (name !== projectName) throw new Error('unexpected project')
      if (!enabled) creations++
      enabled = true
      return shared
    })
    const remove = spyOn(tasklist, 'deleteTasklist').mockImplementation(async (name, guid) => {
      deleteCalls.push([name, guid])
      if (name !== projectName || guid !== shared.guid) throw new Error('unexpected tasklist')
      enabled = false
      return shared
    })
    const sessions = [
      'task-project', 'task-project[feature-a]', 'task-project[feature-b]',
      'task-project*0917-1234', 'task-project[feature-b]*0917-1234',
    ].map((name, index) => new Session(name, `task-chat-${index}`))
    try {
      expect(new Set(sessions.map(session => session.workDir)).size).toBe(3)
      // Creating from WT must attach to the project's shared list as well.
      expect((await sessions[1].onTasklistEnable()).ok).toBe(true)
      for (const session of sessions) {
        expect((await session.onTasklistEnable()).ok).toBe(true)
        await session.runCommand('task')
        expect(session.onTasklistDeletePrompt(shared.guid).ok).toBe(true)
      }
      expect(creations).toBe(1)
      expect(enableCalls.map(([name]) => name)).toEqual(Array(6).fill(projectName))
      expect((await sessions[4].onTasklistDeleteConfirm(shared.guid)).ok).toBe(true)
      expect(deleteCalls).toEqual([[projectName, shared.guid]])
      for (const session of sessions) {
        expect(session.onTasklistDeletePrompt(shared.guid).ok).toBe(false)
      }
      expect([...new Set(reads)]).toEqual([projectName])
    } finally {
      get.mockRestore(); enable.mockRestore(); remove.mockRestore()
      for (const session of sessions) session.dispose()
    }
  })
})

describe('Session workDir project profile override', () => {
  test('uses profile cwd when present', () => {
    projectProfiles.set('withoverride', { cwd: '/abs/custom/dir' })
    const session = new Session('withoverride', 'oc_test_override')
    expect(session.workDir).toBe('/abs/custom/dir')
  })

  test('derives a worktree child session beside the profiled project root', () => {
    projectProfiles.set('withoverride', { cwd: '/abs/custom/dir' })
    const session = new Session('withoverride[feature-x]', 'oc_test_worktree_override')
    expect(session.workDir).toBe('/abs/custom/withoverride[feature-x]')
  })

  test('keeps a temporary session created from a worktree in that worktree cwd', () => {
    projectProfiles.set('withoverride', { cwd: '/abs/custom/dir' })
    const session = new Session('withoverride[feature-x]*0821-1337', 'oc_test_temp_worktree')
    expect(session.workDir).toBe('/abs/custom/withoverride[feature-x]')
  })

  test('refuses a persisted resume ref after the project profile cwd changes', () => {
    modelSelections.set('moved-project', { provider: 'codex', model: null, effort: null })
    resumeRefs.set('moved-project:codex', {
      provider: 'codex', sessionId: 'thread-from-old-cwd', cwd: '/abs/old/project',
    })
    projectProfiles.set('moved-project', { cwd: '/abs/new/project' })
    const session = new Session('moved-project', 'oc_moved_project') as any

    expect(() => session.spawnAgent(session.lastSessionRef)).toThrow('conversation launch cwd mismatch')
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

describe('Session card pagination', () => {
  for (const provider of ['codex', 'claude'] as const) {
    for (const code of [200860, 300305]) {
      test(`${provider} lands identical tool results on each fresh page until the failure-rotate cap turns the turn log-only (${code})`, async () => {
        const session = new Session('unlimited-pagination', 'chat_id') as any
        const turn = turnState('card_unlimited_0')
        turn.provider = provider
        turn.userOpenId = ''
        session.proc = new FakeAgentProc(provider, 'native-session')
        session.currentTurn = turn
        let replacementCount = 0
        const accepted = new Map<string, Set<string>>()
        cardkit.recordCardCreated(turn.cardId, 1, (failureCode, failure) => {
          session.onCardWriteFailure('card_unlimited_0', failureCode, failure)
        })
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const path = new URL(String(input)).pathname.replace('/open-apis/cardkit/v1', '')
          const method = String(init?.method ?? 'GET')
          const body = init?.body ? JSON.parse(String(init.body)) : null
          calls.push({ method, path, body })
          let response: any = { code: 0, data: {} }
          if (path === '/cards/id_convert') {
            response.data = { card_id: `card_unlimited_${++replacementCount}` }
          } else if (method === 'POST' && path.endsWith('/elements')) {
            const ids = accepted.get(path) ?? new Set<string>()
            if (ids.size >= 1) response = { code, msg: 'card capacity exceeded' }
            else {
              ids.add(JSON.parse(body.elements)[0].element_id)
              accepted.set(path, ids)
            }
          }
          return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } })
        }) as typeof fetch

        try {
          // Every page contains the same text; successful pagination must not
          // mistake a later, distinct tool call for a failed migration loop.
          // 合并调和(取舍):上游无 cap 分页设计下本用例驱动 10 页并要求末页仍见
          // 最终回复;合并实现保留本地冻结语义 MAX_MIDTURN_ROTATES=5 失败轮转
          // 上限(session.ts onCardWriteFailure give-up 阶梯,etmmo 2026-07-25/26
          // 起 log-only 止损)。用例本意按合并语义改写为两段:1) 相同内容逐页
          // 重放不被指纹去重误伤 —— 前 6 页(首卡 + 5 次失败换卡)每页工具面板
          // 与完成态落在各自新卡;2) 第 7 页再拒时达上限,进入 give-up log-only,
          // 后续输出不再写卡。
          for (let i = 0; i < 10; i++) {
            sessionTools.addTool(session, session.proc, `tool_use_${i}`, 'Bash', { command: '# desc: 查看结果\nprintf result' })
            await cardkit.flush(turn.cardId)
            await waitUntil(() => !turn.rotating)
            sessionTools.completeTool(session, session.proc, `tool_use_${i}`, '相同的工具结果', false)
            await cardkit.flush(turn.cardId)
          }
          expect(replacementCount).toBe(5)
          expect(turn.failureRotateCount).toBe(5)
          expect(turn.rotateCount).toBe(5)
          expect(turn.rotateGivenUp).toBe(true)
          expect(turn.cardRotationFailed).toBe(false)
          expect(sentRawTexts).toHaveLength(1)
          expect(sentRawTexts[0]).toContain('已触发 5 次换卡仍未恢复')
          for (let i = 0; i <= 5; i++) {
            const page = calls.filter(call => call.path.startsWith(`/cards/card_unlimited_${i}/elements`))
            expect(JSON.stringify(page)).toContain('查看结果')
            expect(page.filter(call => call.method === 'PUT' && call.path.endsWith('/tool_0'))).toHaveLength(1)
          }
          session.appendAssistant('完整的最终回复')
          session.finalizeCurrentAssistantSegment()
          await cardkit.flush(turn.cardId)
          await waitUntil(() => !turn.rotating)
          await session.closeTurnCard(undefined, { hasFreshResult: false })
          // give-up 后本轮 log-only:最终回复不会写进任何卡。
          expect(replacementCount).toBe(5)
          expect(JSON.stringify(calls)).not.toContain('完整的最终回复')
          const toolResults = calls.filter(call => call.method === 'PUT' && call.path.endsWith('/tool_0'))
          expect(toolResults).toHaveLength(6)
          // 合并取舍:本地定型卡面(cards/tool.ts)隐藏命令与输出,结果原文不上卡,
          // 面板完成态(工具标题 + 已完成)即"结果已落地"的可观测面。
          expect(toolResults.every(call => call.body.element.includes('已完成'))).toBe(true)
        } finally {
          if (turn.rotating) await turn.rotating
          session.stopFooterStatus(turn)
          for (let i = 0; i <= replacementCount; i++) await cardkit.dispose(`card_unlimited_${i}`)
        }
      })
    }
  }
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
      // Non-footer element: footer failures no longer elevate to card-level rotate.
      // 300305 = 确认容量失败(上游 4185808 收紧后唯一自动烧预算轮转的组件数信号)。
      if (init?.method === 'PUT' && path === `/cards/${failedCardId}/elements/assistant_0`) {
        return new Response(JSON.stringify({ code: 300305, msg: 'element exceeds the limit' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return await healthyFetch(input, init)
    }) as typeof fetch

    try {
      await cardkit.replaceElement(failedCardId, 'assistant_0', {
        tag: 'markdown', element_id: 'assistant_0', content: 'trigger current failure',
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

  // 2026-07-25/26 etmmo:footer 每秒 ticker 的 TypeError: fetch failed 被当成
  // 写失败换卡,5 次后 log-only。footer 失败必须降级,绝不换卡。
  test('footer replaceElement failure does not mid-turn rotate', async () => {
    const session = new Session('footer-no-rotate', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-thread-footer-no-rotate')
    session.selectedProvider = 'codex'
    session.proc = proc
    session.pendingTurnInputs = ['footer input']
    session.wireProc(proc)
    const openResult = await session.openTurnCard('ou_footer', 'user_message', { startThinking: false })
    if (openResult.kind !== 'opened') throw new Error('footer turn card did not open')
    const turn = openResult.turn
    const cardId = turn.cardId
    const healthyFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      if (init?.method === 'PUT' && path === `/cards/${cardId}/elements/footer`) {
        return new Response(JSON.stringify({ code: 300308, msg: 'footer reject' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return await healthyFetch(input, init)
    }) as typeof fetch

    try {
      await cardkit.replaceElement(cardId, 'footer', {
        tag: 'markdown', element_id: 'footer', content: 'Writing(1s)',
      })
      expect(turn.failureRotateCount).toBe(0)
      expect(turn.rotating).toBeNull()
      expect(turn.cardId).toBe(cardId)
      expect(turn.rotateGivenUp).toBe(false)
    } finally {
      globalThis.fetch = healthyFetch
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  // 上游 f7a4859：实时 footer 单次失败不升群告警。本地 cardkit 已按
  // elementId===footer 跳过 elevate；session 再显式传 notifyCardFailure:false，
  // 终态 footer 仍走 checked / 显式 onFailure。
  test('live footer ticks pass notifyCardFailure: false', async () => {
    // 合并调和(取舍):上游实时 footer 直调 replaceElement(通知开关在第五参);
    // 本地冻结 cardkit 的实时 footer 走 replaceElementChecked(第三参 opts 携带
    // notifyCardFailure/onFailure,内部再把开关传下去)。用例本意"实时 tick 不升
    // 群告警"不变,改钉 checked 封装的开关。
    const session = new Session('footer-notify-opt', 'chat_id') as any
    const replaceSpy = spyOn(cardkit, 'replaceElementChecked').mockResolvedValue(true)
    try {
      await session.replaceFooterContent('card_footer_opt', 'Writing(1s)')
      expect(replaceSpy).toHaveBeenCalledTimes(1)
      const args = replaceSpy.mock.calls[0]
      expect(args[0]).toBe('card_footer_opt')
      expect(args[1]).toBe('footer')
      expect((args[3] as any)?.notifyCardFailure).toBe(false)
      expect(typeof (args[3] as any)?.onFailure).toBe('function')
    } finally {
      replaceSpy.mockRestore()
    }
  })

  // 网络 fetch failed 重试耗尽后也不换卡、不烧 cap。
  test('network write failure does not rotate or consume the failure cap', async () => {
    const session = new Session('network-no-rotate', 'chat_id') as any
    session.proc = new FakeAgentProc('claude', 'claude-session-net')
    const turn = turnState('card_net')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(
      'card_net',
      1,
      (code, meta) => session.onCardWriteFailure('card_net', code, meta),
    )

    try {
      session.onCardWriteFailure('card_net', undefined, { kind: 'network' })
      expect(turn.failureRotateCount).toBe(0)
      expect(turn.rotating).toBeNull()
      expect(turn.rotateGivenUp).toBe(false)
      expect(turn.cardId).toBe('card_net')
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose('card_net')
    }
  })

  // 成功写入后清掉 failure 计数,避免一次抖动 burst 让整轮永久 log-only。
  test('successful content write resets failureRotateCount', async () => {
    const session = new Session('reset-failure-count', 'chat_id') as any
    session.proc = new FakeAgentProc('claude', 'claude-session-reset')
    const turn = turnState('card_reset')
    turn.userOpenId = ''
    turn.failureRotateCount = 3
    session.currentTurn = turn
    cardkit.recordCardCreated(
      'card_reset',
      1,
      (code, meta) => session.onCardWriteFailure('card_reset', code, meta),
      () => session.onCardWriteSuccess('card_reset'),
    )

    try {
      await cardkit.addElement('card_reset', {
        tag: 'markdown', element_id: 'assistant_recover', content: 'ok',
      })
      expect(turn.failureRotateCount).toBe(0)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose('card_reset')
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
      // 4185808 收紧后只有确认容量失败(300305/200860)走失败轮转路径,
      // 本测试意图不变:主动轮转不烧失败额度,容量失败仍可换卡。
      session.onCardWriteFailure('card_old', 300305, { kind: 'api' })

      expect(turn.cardRotationFailed).toBe(false)
      expect(turn.rotating).not.toBeNull()
      await turn.rotating
      expect(turn.cardId).not.toBe('card_old') // 真的换到了新卡
      expect(turn.failureRotateCount).toBe(1)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('replacement-card send failure pauses the footer without poisoning the current card', async () => {
    const session = new Session('probe', 'chat_id') as any
    session.proc = new FakeAgentProc('claude', 'claude-session-1')
    const turn = turnState('card_dead')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated('card_dead', 50)
    const sendSpy = spyOn(feishu, 'sendCard').mockResolvedValue(null)

    try {
      session.startWritingFooter(turn)
      expect(turn.footerStatusHandle).not.toBeNull()

      session.onCardWriteFailure('card_dead', 300305, { kind: 'api' })
      await turn.rotating

      expect(turn.cardRotationFailed).toBe(true)
      expect(turn.rotating).toBeNull() // 不再尝试换卡
      // 续卡失败时暂停 footer 定时刷新，真实输出到达后再恢复。
      expect(turn.footerStatusHandle).toBeNull()
      session.startWorkingFooter(turn)
      expect(turn.footerStatusHandle).toBeNull()
      // 续卡发送失败不证明旧卡全部不可写；新内容仍按实际写入结果处理。
      // 网络路由解析是异步的，先等待 startWritingFooter 已排入的写入完成。
      await cardkit.flush('card_dead')
      const before = calls.length
      await cardkit.replaceElement('card_dead', 'footer', { tag: 'markdown', element_id: 'footer', content: 'x' })
      await cardkit.addElement('card_dead', { tag: 'markdown', element_id: 'e_new', content: 'x' })
      expect(calls.length).toBe(before + 2)
      expect(sentRawTexts.length).toBe(1)
      expect(sentRawTexts[0]).toContain('续卡发送失败')
      expect(sentRawTexts[0]).toContain('后续内容到达时会再次尝试')
      expect(sentRawTexts[0]).not.toContain('连续 5 次写入失败')
    } finally {
      sendSpy.mockRestore()
      session.stopFooterStatus(turn)
      await cardkit.dispose('card_dead')
    }
  })

  for (const provider of ['codex', 'claude'] as const) {
    for (const trigger of ['tool_result', 'turn_close'] as const) {
      test(`${provider} recovers a failed replacement card on ${trigger}`, async () => {
        const session = new Session('rotate-send-retry', 'chat_id') as any
        const turn = turnState('card_rotate_send_retry')
        turn.provider = provider
        turn.userOpenId = ''
        session.proc = new FakeAgentProc(provider, 'native-session')
        session.currentTurn = turn
        turn.toolByUseId.set('running-tool', {
          i: 0, name: 'Bash', input: { command: '# desc: 运行任务\nprintf work' },
        })
        cardkit.recordCardCreated(turn.cardId, 50)
        const sendSpy = spyOn(feishu, 'sendCard').mockResolvedValueOnce(null).mockResolvedValue('om_retry')
        try {
          session.maybeMidTurnRotate()
          await turn.rotating
          expect(turn.cardRotationFailed).toBe(true)
          expect(turn.footerStatusHandle).toBeNull()
          expect(sentRawTexts).toHaveLength(1)
          if (trigger === 'tool_result') {
            sessionTools.completeTool(session, session.proc, 'running-tool', '恢复后完整的工具结果', false)
            await turn.rotating
            await cardkit.flush(turn.cardId)
            expect(turn.cardRotationFailed).toBe(false)
            // 合并调和:上游钉工具结果原文进卡(renderBashBody 全量渲染);本地
            // 定型卡面(cards/tool.ts)隐藏命令与输出。保留用例本意"续卡恢复后
            // 工具结果以完成态面板落地",改钉面板标题 + 完成态。
            const recovered = JSON.stringify(calls)
            expect(recovered).toContain('运行任务')
            expect(recovered).toContain('已完成')
          } else {
            turn.currentAssistantSegmentId = 'assistant_0'
            turn.currentAssistantText = '完整的最终回复'
            turn.segmentTexts.set('assistant_0', '完整的最终回复')
            await session.closeTurnCard(undefined, { hasFreshResult: false })
            expect(turn.cardRotationFailed).toBe(false)
            expect(JSON.stringify(calls.filter(call => call.path.startsWith(`/cards/${turn.cardId}/elements`))))
              .toContain('完整的最终回复')
            expect(sentTexts).toEqual([])
          }
          expect(sendSpy).toHaveBeenCalledTimes(2)
          expect(sentRawTexts).toHaveLength(1)
        } finally {
          if (turn.rotating) await turn.rotating
          sendSpy.mockRestore()
          session.stopFooterStatus(turn)
          await cardkit.dispose('card_rotate_send_retry')
          await cardkit.dispose(turn.cardId)
        }
      })
    }
  }

  test('give-up warning text branches for card size limit', async () => {
    const session = new Session('probe-size', 'chat_id') as any
    session.proc = new FakeAgentProc('claude', 'claude-session-size')
    const turn = turnState('card_size')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated('card_size', 1)
    turn.failureRotateCount = 5

    try {
      session.onCardWriteFailure('card_size', 200860, { kind: 'api' })
      expect(turn.rotateGivenUp).toBe(true)
      expect(sentRawTexts.length).toBe(1)
      expect(sentRawTexts[0]).toContain('卡片体积超限')
      expect(sentRawTexts[0]).toContain('200860')
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose('card_size')
    }
  })
})

describe('Session 轮转预算收紧与一次性诊断 (上游 4185808 主题 B)', () => {
  test('confirmed 300305 capacity failure burns failureRotateCount and rotates', async () => {
    const session = new Session('capacity-confirmed-rotate', 'chat_id') as any
    session.proc = new FakeAgentProc('claude', 'claude-capacity-confirmed')
    const turn = turnState('card_capacity_confirmed')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    try {
      session.onCardWriteFailure(turn.cardId, 300305, {
        kind: 'api',
        failure: {
          cardId: turn.cardId, operation: 'addElement', elementId: 'assistant_0',
          code: 300305, message: 'element exceeds the limit',
        },
      })
      expect(turn.failureRotateCount).toBe(1)
      expect(turn.rotating).not.toBeNull()
      await turn.rotating
      expect(turn.cardId).not.toBe('card_capacity_confirmed')
      expect(sentRawTexts).toHaveLength(0)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('300315 wrapping 300305 rotates; bare 300315 duplicate-id does not', async () => {
    const session = new Session('capacity-wrapped-rotate', 'chat_id') as any
    session.proc = new FakeAgentProc('claude', 'claude-capacity-wrapped')
    const wrapped = turnState('card_capacity_wrapped')
    wrapped.userOpenId = ''
    session.currentTurn = wrapped
    cardkit.recordCardCreated(wrapped.cardId, 1)

    try {
      session.onCardWriteFailure(wrapped.cardId, 300315, {
        kind: 'api',
        failure: {
          cardId: wrapped.cardId, operation: 'addElement',
          code: 300315, message: 'Failed to add element: inner code: 300305, element exceeds limit',
        },
      })
      expect(wrapped.failureRotateCount).toBe(1)
      expect(wrapped.rotating).not.toBeNull()
      await wrapped.rotating
    } finally {
      session.stopFooterStatus(wrapped)
      await cardkit.dispose(wrapped.cardId)
    }

    const bare = turnState('card_bare_duplicate')
    bare.userOpenId = ''
    session.currentTurn = bare
    cardkit.recordCardCreated(bare.cardId, 1)
    try {
      session.onCardWriteFailure(bare.cardId, 300315, {
        kind: 'api',
        failure: {
          cardId: bare.cardId, operation: 'addElement', elementId: 'ctx_dup',
          code: 300315, message: 'Duplicate ID; code: 300301',
        },
      })
      expect(bare.failureRotateCount).toBe(0)
      expect(bare.rotating).toBeNull()
      expect(bare.cardId).toBe('card_bare_duplicate')
      expect(sentRawTexts).toHaveLength(1)
      expect(sentRawTexts[0]).toContain('不是卡片元素上限')
    } finally {
      session.stopFooterStatus(bare)
      await cardkit.dispose(bare.cardId)
    }
  })

  test('300315 wrapping 200860 rotates as card-size capacity', async () => {
    const session = new Session('capacity-wrapped-size', 'chat_id') as any
    session.proc = new FakeAgentProc('claude', 'claude-capacity-wrapped-size')
    const turn = turnState('card_capacity_wrapped_size')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    try {
      session.onCardWriteFailure(turn.cardId, 300315, {
        kind: 'api',
        failure: {
          cardId: turn.cardId, operation: 'addElement',
          code: 300315, message: 'Failed to add element: inner code: 200860, card over max size',
        },
      })
      expect(turn.failureRotateCount).toBe(1)
      expect(turn.rotating).not.toBeNull()
      await turn.rotating
      expect(turn.cardId).not.toBe('card_capacity_wrapped_size')
      expect(sentRawTexts.join('\n')).not.toContain('不是卡片元素上限')
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('replaceElement 200860 marks the tool dead so rotate rebuilds the latest result', async () => {
    const session = new Session('card-size-tool-replace', 'chat_id') as any
    session.proc = new FakeAgentProc('codex', 'codex-card-size-tool')
    const oldCardId = 'card_size_tool_old'
    const newCardId = 'card_size_tool_new'
    const turn = turnState(oldCardId)
    turn.userOpenId = ''
    turn.toolCount = 1
    turn.toolByUseId.set('tool_use_size', {
      i: 0, name: 'Bash', input: { command: '# desc: 查看结果\nprintf result' },
    })
    session.currentTurn = turn
    cardkit.recordCardCreated(oldCardId, 2, (code, meta) => {
      session.onCardWriteFailure(oldCardId, code, meta)
    })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      const rejected = method === 'PUT' && path === `/cards/${oldCardId}/elements/tool_0`
      return new Response(JSON.stringify(rejected
        ? { code: 200860, msg: 'ErrMsg: card over max size;' }
        : { code: 0, data: path === '/cards/id_convert' ? { card_id: newCardId } : {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      sessionTools.completeTool(session, session.proc, 'tool_use_size', 'retained tool result', false)
      await cardkit.flush(oldCardId)
      const rotation = turn.rotating
      if (rotation) await rotation
      await cardkit.flush(newCardId)

      expect(turn.cardId).toBe(newCardId)
      expect(turn.failureRotateCount).toBe(1)
      const migrated = JSON.stringify(calls.filter(call =>
        call.method === 'POST' && call.path === `/cards/${newCardId}/elements`,
      ))
      // 本地 toolCallElement 隐藏命令/输出，只迁面板本身；重建即证明 dead 标记生效。
      expect(migrated).toContain('tool_0')
      expect(migrated).toContain('Bash')
      expect(turn.toolByUseId.has('tool_use_size')).toBe(true)
      expect(sentRawTexts.join('\n')).not.toContain('不是卡片元素上限')
    } finally {
      if (turn.rotating) await turn.rotating
      session.stopFooterStatus(turn)
      await cardkit.dispose(oldCardId)
      await cardkit.dispose(newCardId)
    }
  })

  test('repeated validation/content failures stay on the current card, each distinct failure warns once', async () => {
    const session = new Session('validation-no-rotate', 'chat_id') as any
    session.proc = new FakeAgentProc('claude', 'claude-validation-no-rotate')
    const turn = turnState('card_validation')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 2, (code, meta) => {
      session.onCardWriteFailure(turn.cardId, code, meta)
    })
    let attempt = 0
    const healthyFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      attempt++
      return new Response(JSON.stringify(attempt === 1
        ? {
            code: 300315,
            msg: 'elementID format error. It must start with an alphabet and not exceed 20 characters; code: 300301',
          }
        : { code: 200570, msg: 'invalid image keys; ErrorValue: image key img_key' }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      await cardkit.addElement(turn.cardId, {
        tag: 'markdown', element_id: 'bad_element_1', content: 'x',
      })
      await cardkit.addElement(turn.cardId, {
        tag: 'markdown', element_id: 'bad_element_2', content: 'x',
      })

      expect(attempt).toBe(2)
      expect(turn.rotating).toBeNull()
      expect(turn.rotateCount).toBe(0)
      expect(turn.failureRotateCount).toBe(0)
      expect(turn.rotateGivenUp).toBe(false)
      expect(sentCards).toHaveLength(0)
      expect(calls.some(call => call.path === '/cards/id_convert')).toBe(false)
      // 按键去重(上游 378f4a4):两个不同的失败(元素/错误码各不同)各自通知一次;
      // 旧的布尔模型只发第一条,会把后一条新故障吞掉。
      expect(sentRawTexts).toHaveLength(2)
      expect(sentRawTexts[0]).toContain('不是卡片元素上限')
      expect(sentRawTexts[1]).toContain('不是卡片元素上限')
    } finally {
      globalThis.fetch = healthyFetch
      await cardkit.dispose(turn.cardId)
    }
  })

  test('non-capacity diagnostic redacts credentials and raw API payload (哨兵负向断言)', async () => {
    const SENTINEL = 'SENTINEL_APP_SECRET_X'
    const session = new Session('diagnostic-redaction', 'chat_id') as any
    session.proc = new FakeAgentProc('claude', 'claude-diagnostic-redaction')
    const turn = turnState('card_redaction')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)
    // 全量跑时字母序更早的测试文件会 mock.module('./config') 成无 feishu 段的
    // 形状(01-01 已知泄漏);哨兵注入对两种形状都成立,注入/还原走同一引用。
    const feishuConfig = ((config as any).feishu ??= {}) as Record<string, unknown>
    const previousSecret = feishuConfig.app_secret
    feishuConfig.app_secret = SENTINEL
    const rawApiBody = `{"code":300315,"msg":"invalid payload; Authorization: Bearer ${SENTINEL}","data":{}}`

    try {
      session.onCardWriteFailure(turn.cardId, 300315, {
        kind: 'api',
        failure: {
          cardId: turn.cardId, operation: 'addElement', elementId: 'seg_1',
          code: 300315, httpStatus: 400, logId: 'log_redaction',
          message: `cardkit POST /cards/${turn.cardId}/elements: HTTP 400 code=300315 msg=invalid payload; Authorization: Bearer ${SENTINEL}; raw=${rawApiBody}`,
        },
      })
      // 第二次同 turn 非容量失败:元素/错误码不同 → 是新故障,按新键再通知一次
      session.onCardWriteFailure(turn.cardId, 200570, {
        kind: 'api',
        failure: {
          cardId: turn.cardId, operation: 'addElement', elementId: 'seg_2',
          code: 200570, message: `invalid image keys; secret=${SENTINEL}`,
        },
      })
      // 第三次:与第一条完全同键 → 不再重复
      session.onCardWriteFailure(turn.cardId, 300315, {
        kind: 'api',
        failure: {
          cardId: turn.cardId, operation: 'addElement', elementId: 'seg_1',
          code: 300315, httpStatus: 400, logId: 'log_redaction',
          message: `cardkit POST /cards/${turn.cardId}/elements: HTTP 400 code=300315 msg=invalid payload; Authorization: Bearer ${SENTINEL}; raw=${rawApiBody}`,
        },
      })

      expect(turn.rotating).toBeNull()
      expect(turn.failureRotateCount).toBe(0)
      expect(sentRawTexts).toHaveLength(2)
      const visible = sentRawTexts[0] ?? ''
      // 可观测:错误码 + 操作类别在列
      expect(visible).toContain('300315')
      expect(visible).toContain('addElement')
      // 凭据/raw payload 脱敏:哨兵串与完整 API 响应体不得出现(两条通知都不例外)
      for (const text of sentRawTexts) {
        expect(text).not.toContain(SENTINEL)
        expect(text).not.toContain(rawApiBody)
        expect(text).not.toContain('Authorization')
      }
      const cardJson = JSON.stringify([...sentCards, ...updatedCards])
      expect(cardJson).not.toContain(SENTINEL)
    } finally {
      if (previousSecret === undefined) delete feishuConfig.app_secret
      else feishuConfig.app_secret = previousSecret
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('network failure keeps the local skip-rotate path without user diagnostic', async () => {
    const session = new Session('network-silent-skip', 'chat_id') as any
    session.proc = new FakeAgentProc('claude', 'claude-network-silent')
    const turn = turnState('card_network_silent')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    try {
      session.onCardWriteFailure(turn.cardId, undefined, {
        kind: 'network',
        failure: {
          cardId: turn.cardId, operation: 'addElement', elementId: 'seg_net',
          message: 'TypeError: fetch failed',
        },
      })
      expect(turn.failureRotateCount).toBe(0)
      expect(turn.rotating).toBeNull()
      expect(turn.rotateGivenUp).toBe(false)
      expect(sentRawTexts).toHaveLength(0)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('a late failure for a retired card cannot rotate or notify the current turn', async () => {
    const session = new Session('stale-card-no-notify', 'chat_id') as any
    session.proc = new FakeAgentProc('claude', 'claude-stale-card')
    const turn = turnState('card_current_owner')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    try {
      session.onCardWriteFailure('card_retired_owner', 300305, {
        kind: 'api',
        failure: {
          cardId: 'card_retired_owner', operation: 'addElement',
          code: 300305, message: 'component count exceeds limit',
        },
      })
      expect(turn.cardId).toBe('card_current_owner')
      expect(turn.rotateCount).toBe(0)
      expect(turn.failureRotateCount).toBe(0)
      expect(turn.rotating).toBeNull()
      expect(sentRawTexts).toHaveLength(0)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('a replacement-card send failure only latches log-only after a second consecutive failure (上游 378f4a4 两级阶梯)', async () => {
    const session = new Session('rotate-send-failure', 'chat_id') as any
    session.proc = new FakeAgentProc('claude', 'claude-rotate-send-failure')
    const turn = turnState('card_rotate_send_failure')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 50)
    let sendCardAttempts = 0
    feishuMockState.sendCard = async () => {
      sendCardAttempts++
      return null
    }

    try {
      // 一级:暂停 footer 刷新与推送,等下一个内容事件再试 —— 还不 give-up
      session.maybeMidTurnRotate()
      await turn.rotating
      expect(turn.cardRotationFailed).toBe(true)
      expect(turn.rotateGivenUp).toBe(false)
      expect(sentRawTexts).toHaveLength(1)
      expect(sentRawTexts[0]).toContain('续卡发送失败，后续内容到达时会再次尝试')

      // 二级:重试再失败才落本地止损(旧卡此时才标死)
      session.maybeMidTurnRotate()
      await turn.rotating
      expect(turn.rotateGivenUp).toBe(true)
      expect(sentRawTexts).toHaveLength(2)
      expect(sentRawTexts[1]).toContain('续卡连续发送失败，本轮后续输出仅日志可见')

      const attempts = sendCardAttempts
      session.maybeMidTurnRotate()
      expect(sendCardAttempts).toBe(attempts)
    } finally {
      feishuMockState.sendCard = null
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })
})

async function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timeout')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('Session 压缩面板去重与失败追踪 (上游 4185808 主题 C)', () => {
  function compactionSession(name: string, cardId: string): { session: any; proc: FakeAgentProc; turn: any } {
    const session = new Session(name, 'chat_id') as any
    const proc = new FakeAgentProc('codex', `codex-${name}`)
    session.selectedProvider = 'codex'
    session.proc = proc
    const turn = turnState(cardId)
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1, (code, meta) => {
      session.onCardWriteFailure(turn.cardId, code, meta)
    })
    return { session, proc, turn }
  }

  test('deduplicates repeated completion for the same compaction item', async () => {
    const { session, proc, turn } = compactionSession('compact-dedupe', 'card_compact_dedupe')
    const start = {
      phase: 'start', threadId: 'thread_1', turnId: 'turn_1', itemId: 'compact_1',
    }
    const end = {
      phase: 'end', threadId: 'thread_1', turnId: 'turn_1', itemId: 'compact_1',
    }

    try {
      session.handleContextCompacted(proc, start)
      session.handleContextCompacted(proc, end)
      session.handleContextCompacted(proc, { ...end, sourceMethod: 'rawResponseItem/completed' })
      // 同一物理压缩经 turn-only 面 + 匿名遗留面到达,首次 Card Kit 写落地前
      // 也必须合并。
      session.handleContextCompacted(proc, {
        phase: 'end', threadId: 'thread_1', turnId: 'turn_1',
      })
      session.handleContextCompacted(proc, { phase: 'event' })
      await cardkit.flush(turn.cardId)
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_1'))

      expect(turn.contextCompactCount).toBe(1)
      expect(turn.contextCompactionPending.size).toBe(0)
      const compactAdds = calls.filter(call =>
        call.method === 'POST' &&
        call.path === `/cards/${turn.cardId}/elements` &&
        JSON.parse(call.body.elements)[0]?.element_id === 'context_compact_0'
      )
      const compactReplaces = calls.filter(call =>
        call.method === 'PUT' &&
        call.path === `/cards/${turn.cardId}/elements/context_compact_0`
      )
      expect(compactAdds).toHaveLength(1)
      expect(compactReplaces).toHaveLength(1)
      expect(sentRawTexts).toHaveLength(0)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('treats a completion delivered after card close as a logged lifecycle event', () => {
    const session = new Session('compact-after-close', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-compact-after-close')
    session.proc = proc

    session.handleContextCompacted(proc, {
      phase: 'end', threadId: 'thread_closed', turnId: 'turn_closed', itemId: 'compact_closed',
    })

    expect(sentRawTexts).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  test('deduplicates generic-turn completion followed by an item completion', async () => {
    const { session, proc, turn } = compactionSession('compact-alias-order', 'card_compact_alias_order')

    try {
      session.handleContextCompacted(proc, {
        phase: 'end', threadId: 'thread_alias', turnId: 'turn_alias',
      })
      session.handleContextCompacted(proc, {
        phase: 'end', threadId: 'thread_alias', turnId: 'turn_alias', itemId: 'compact_alias',
      })
      await cardkit.flush(turn.cardId)
      await waitUntil(() => turn.contextCompactionCompleted.has('turn_alias'))

      expect(turn.contextCompactCount).toBe(1)
      let compactAdds = calls.filter(call =>
        call.method === 'POST' &&
        call.path === `/cards/${turn.cardId}/elements` &&
        JSON.parse(call.body.elements)[0]?.element_id?.startsWith('context_compact_')
      )
      expect(compactAdds).toHaveLength(1)
      // compact_alias 认领 turn 别名后,同 turn 的另一个显式 item 仍是新压缩。
      session.handleContextCompacted(proc, {
        phase: 'end', threadId: 'thread_alias', turnId: 'turn_alias', itemId: 'compact_alias_b',
      })
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_alias_b'))
      compactAdds = calls.filter(call =>
        call.method === 'POST' &&
        call.path === `/cards/${turn.cardId}/elements` &&
        JSON.parse(call.body.elements)[0]?.element_id?.startsWith('context_compact_')
      )
      expect(compactAdds).toHaveLength(2)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('deduplicates an anonymous completion followed by an identified alias', async () => {
    const { session, proc, turn } = compactionSession('compact-anonymous-alias', 'card_compact_anonymous_alias')

    try {
      session.handleContextCompacted(proc, { phase: 'event' })
      session.handleContextCompacted(proc, {
        phase: 'end', threadId: 'thread_anon', turnId: 'turn_anon', itemId: 'compact_anon',
      })
      await cardkit.flush(turn.cardId)
      await waitUntil(() => turn.lastContextCompactionWasAnonymous)

      expect(turn.contextCompactCount).toBe(1)
      const compactAdds = calls.filter(call =>
        call.method === 'POST' &&
        call.path === `/cards/${turn.cardId}/elements` &&
        JSON.parse(call.body.elements)[0]?.element_id?.startsWith('context_compact_')
      )
      expect(compactAdds).toHaveLength(1)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('a distinct explicit item in the same backend turn is not swallowed by the turn alias', async () => {
    const { session, proc, turn } = compactionSession('compact-distinct-items', 'card_compact_distinct_items')

    try {
      session.handleContextCompacted(proc, {
        phase: 'end', threadId: 'thread_shared', turnId: 'turn_shared', itemId: 'compact_item_a',
      })
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_item_a'))
      session.handleContextCompacted(proc, {
        phase: 'end', threadId: 'thread_shared', turnId: 'turn_shared', itemId: 'compact_item_b',
      })
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_item_b'))

      expect(turn.contextCompactCount).toBe(2)
      const compactAdds = calls.filter(call =>
        call.method === 'POST' &&
        call.path === `/cards/${turn.cardId}/elements` &&
        JSON.parse(call.body.elements)[0]?.element_id?.startsWith('context_compact_')
      )
      expect(compactAdds).toHaveLength(2)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('an explicit unmatched item completion does not consume another pending item', async () => {
    const { session, proc, turn } = compactionSession('compact-item-owner', 'card_compact_item_owner')

    try {
      session.handleContextCompacted(proc, {
        phase: 'start', threadId: 'thread_items', turnId: 'turn_items', itemId: 'compact_a',
      })
      session.handleContextCompacted(proc, {
        phase: 'end', threadId: 'thread_items', turnId: 'turn_items', itemId: 'compact_b',
      })
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_b'))

      expect(turn.contextCompactionPending.has('compact_a')).toBe(true)
      expect(turn.contextCompactCount).toBe(2)
      session.handleContextCompacted(proc, {
        phase: 'end', threadId: 'thread_items', turnId: 'turn_items', itemId: 'compact_a',
      })
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_a'))
      expect(turn.contextCompactionPending.size).toBe(0)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('does not attach an old turn compaction completion to a newer turn', async () => {
    const session = new Session('compact-owner', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-compact-owner')
    session.proc = proc
    const oldTurn = turnState('card_compact_owner_old')
    oldTurn.userOpenId = ''
    session.currentTurn = oldTurn
    cardkit.recordCardCreated(oldTurn.cardId, 1)
    session.handleContextCompacted(proc, {
      phase: 'start', threadId: 'thread_owner', turnId: 'turn_old', itemId: 'compact_owner',
    })
    await cardkit.flush(oldTurn.cardId)

    const newTurn = turnState('card_compact_owner_new')
    newTurn.userOpenId = ''
    session.currentTurn = newTurn
    cardkit.recordCardCreated(newTurn.cardId, 1)

    try {
      session.handleContextCompacted(proc, {
        phase: 'end', threadId: 'thread_owner', turnId: 'turn_old', itemId: 'compact_owner',
      })
      await cardkit.flush(newTurn.cardId)

      expect(newTurn.contextCompactCount).toBe(0)
      expect(newTurn.contextCompactionPending.size).toBe(0)
      expect(calls.some(call =>
        call.path === `/cards/${newTurn.cardId}/elements` &&
        call.method === 'POST' &&
        JSON.parse(call.body.elements)[0]?.element_id?.startsWith('context_compact_')
      )).toBe(false)
      expect(sentRawTexts).toHaveLength(0)
    } finally {
      session.stopFooterStatus(oldTurn)
      session.stopFooterStatus(newTurn)
      await cardkit.dispose(oldTurn.cardId)
      await cardkit.dispose(newTurn.cardId)
    }
  })

  test('manual compact completion never leaks into a newly opened turn', async () => {
    const session = new Session('compact-manual-owner', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-compact-manual-owner')
    session.proc = proc
    const turn = turnState('card_compact_manual_owner')
    session.currentTurn = turn
    session.manualContextCompactionPending = true
    cardkit.recordCardCreated(turn.cardId, 1)

    try {
      session.handleContextCompacted(proc, {
        phase: 'end', threadId: 'thread_manual', turnId: 'turn_manual', itemId: 'compact_manual',
      })
      session.manualContextCompactionPending = false
      session.handleContextCompacted(proc, {
        phase: 'end', threadId: 'thread_manual', turnId: 'turn_manual',
      })
      session.handleContextCompacted(proc, { phase: 'event' })

      expect(turn.contextCompactCount).toBe(0)
      expect(turn.contextCompactionPending.size).toBe(0)
      expect(calls).toHaveLength(0)
    } finally {
      session.manualContextCompactionPending = false
      await cardkit.dispose(turn.cardId)
    }
  })

  test('an anonymous manual completion tombstones an immediate identified alias', async () => {
    const session = new Session('compact-manual-anonymous', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-compact-manual-anon')
    session.proc = proc
    const turn = turnState('card_compact_manual_anonymous')
    session.currentTurn = turn
    session.manualContextCompactionPending = true
    cardkit.recordCardCreated(turn.cardId, 1)

    try {
      session.handleContextCompacted(proc, { phase: 'event' })
      session.manualContextCompactionPending = false
      session.handleContextCompacted(proc, {
        phase: 'end', threadId: 'thread_manual_alias', turnId: 'turn_manual_alias', itemId: 'compact_manual_alias',
      })
      expect(turn.contextCompactCount).toBe(0)
      expect(calls).toHaveLength(0)
    } finally {
      session.manualContextCompactionPending = false
      await cardkit.dispose(turn.cardId)
    }
  })

  test('moves an in-progress compaction panel to the replacement card', async () => {
    const { session, proc, turn } = compactionSession('compact-rotate', 'card_compact_old')
    const healthyFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      const data = path === '/cards/id_convert' ? { card_id: 'card_compact_new' } : {}
      return new Response(JSON.stringify({ code: 0, data }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      session.handleContextCompacted(proc, {
        phase: 'start', threadId: 'thread_2', turnId: 'turn_2', itemId: 'compact_2',
      })
      await cardkit.flush(turn.cardId)
      session.startMidTurnRotate(turn)
      await turn.rotating

      expect(turn.cardId).toBe('card_compact_new')
      expect(turn.contextCompactionPending.get('compact_2')?.cardId).toBe('card_compact_new')
      session.handleContextCompacted(proc, {
        phase: 'end', threadId: 'thread_2', turnId: 'turn_2', itemId: 'compact_2',
      })
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_2'))
      await cardkit.flush(turn.cardId)

      expect(calls.some(call =>
        call.method === 'POST' &&
        call.path === '/cards/card_compact_new/elements' &&
        JSON.parse(call.body.elements)[0]?.element_id === 'context_compact_0'
      )).toBe(true)
      expect(calls.some(call =>
        call.method === 'PUT' &&
        call.path === '/cards/card_compact_new/elements/context_compact_0'
      )).toBe(true)
    } finally {
      globalThis.fetch = healthyFetch
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('commits completion receipts only after Card Kit lands and allows retry after MISS', async () => {
    const { session, proc, turn } = compactionSession('compact-write-retry', 'card_compact_write_retry')
    let rejectCompletion = true
    const healthyFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (
        rejectCompletion &&
        method === 'PUT' &&
        path === `/cards/${turn.cardId}/elements/context_compact_0`
      ) {
        return new Response(JSON.stringify({ code: 300308, msg: 'temporary replace reject' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch
    const start = {
      phase: 'start', threadId: 'thread_retry', turnId: 'turn_retry', itemId: 'compact_retry',
    }
    const end = {
      phase: 'end', threadId: 'thread_retry', turnId: 'turn_retry', itemId: 'compact_retry',
    }

    try {
      session.handleContextCompacted(proc, start)
      session.handleContextCompacted(proc, end)
      await waitUntil(() => !turn.contextCompactionCompleting.has('compact_retry'))
      expect(turn.contextCompactionPending.has('compact_retry')).toBe(true)
      expect(turn.contextCompactionCompleted.has('compact_retry')).toBe(false)

      rejectCompletion = false
      session.handleContextCompacted(proc, end)
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_retry'))
      expect(turn.contextCompactionPending.size).toBe(0)
      const completionPuts = calls.filter(call =>
        call.method === 'PUT' &&
        call.path === `/cards/${turn.cardId}/elements/context_compact_0`
      )
      expect(completionPuts).toHaveLength(2)
    } finally {
      globalThis.fetch = healthyFetch
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('a capacity failure while completing automatically retries on the replacement card', async () => {
    const { session, proc, turn } = compactionSession('compact-capacity-rotate', 'card_compact_capacity_old')
    let rejectOldCompletion = true
    const healthyFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (path === '/cards/id_convert') {
        return new Response(JSON.stringify({ code: 0, data: { card_id: 'card_compact_capacity_new' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (
        rejectOldCompletion &&
        method === 'PUT' &&
        path === '/cards/card_compact_capacity_old/elements/context_compact_0'
      ) {
        rejectOldCompletion = false
        return new Response(JSON.stringify({ code: 300305, msg: 'number of card components exceeds 200' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      session.handleContextCompacted(proc, {
        phase: 'start', threadId: 'thread_capacity', turnId: 'turn_capacity', itemId: 'compact_capacity',
      })
      session.handleContextCompacted(proc, {
        phase: 'end', threadId: 'thread_capacity', turnId: 'turn_capacity', itemId: 'compact_capacity',
      })
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_capacity'))

      expect(turn.cardId).toBe('card_compact_capacity_new')
      expect(turn.rotateCount).toBe(1)
      expect(turn.failureRotateCount).toBe(1)
      expect(calls.some(call =>
        call.method === 'PUT' &&
        call.path === '/cards/card_compact_capacity_new/elements/context_compact_0'
      )).toBe(true)
    } finally {
      globalThis.fetch = healthyFetch
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('a duplicate start-panel add reconciles with a terminal replace', async () => {
    const { session, proc, turn } = compactionSession('compact-start-add-retry', 'card_compact_start_add_retry')
    let compactAddAttempt = 0
    const healthyFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      const addedElement = method === 'POST' && path === `/cards/${turn.cardId}/elements`
        ? JSON.parse(calls.at(-1)?.body.elements ?? '[]')[0]
        : null
      if (addedElement?.element_id === 'context_compact_0' && ++compactAddAttempt === 1) {
        return new Response(JSON.stringify({ code: 300315, msg: 'Duplicate ID; code: 300301' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      session.handleContextCompacted(proc, {
        phase: 'start', threadId: 'thread_add_retry', turnId: 'turn_add_retry', itemId: 'compact_add_retry',
      })
      session.handleContextCompacted(proc, {
        phase: 'end', threadId: 'thread_add_retry', turnId: 'turn_add_retry', itemId: 'compact_add_retry',
      })
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_add_retry'))

      expect(compactAddAttempt).toBe(1)
      expect(calls.some(call =>
        call.method === 'PUT' &&
        call.path.endsWith('/elements/context_compact_0')
      )).toBe(true)
      expect(turn.contextCompactionPending.size).toBe(0)
    } finally {
      globalThis.fetch = healthyFetch
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
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

  test('an init already owned by an eager-open card consumes its SDK input claim without creating a later empty user turn', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.lastUserOpenId = 'ou_user'
    session.wireProc(proc)
    session.currentTurn = turnState('card_eager_user')
    session.pendingUserMessageCount = 1
    session.pendingReactionIds = new Map([['om_later_buffered', 'reaction_later']])

    proc.emit('init', { session_id: 'claude-session-1' })

    expect(session.pendingUserMessageCount).toBe(0)
    expect(session.pendingReactionIds).toEqual(new Map([['om_later_buffered', 'reaction_later']]))
    expect(session.currentBatchReactionIds.size).toBe(0)

    session.currentTurn = null
    proc.emit('bg_task_settled', { task_id: 't1', status: 'completed' })
    proc.emit('init', { session_id: 'claude-session-1' })
    await waitFor(() => session.currentTurn !== null)

    try {
      expect(session.currentTurn.trigger).toBe('bg_task_resume')
      expect(session.currentTurn.trigger).not.toBe('user_message')
    } finally {
      if (session.currentTurn) await session.closeTurnCard('测试收尾')
    }
  })

  test('defensive init owner conflict stays inside the Session and preserves the unclaimed input', () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.wireProc(proc)
    session.pendingUserMessageCount = 1
    session.pendingTurnInputs = ['still pending']
    // 合并调和(取舍):冲突注入点对齐合并实现 —— 上游开卡装配 beginTurnOpen
    // 合并后仅保留 as-any 调用面,生产装配入口是本地 beginTurnOpening(两者共用
    // openingTurnOwner 槽位);防御语义(冲突留在 Session 内、不吞未认领输入、
    // 不发卡)不变,故在同一槽位的组装点上注入 owner 冲突。
    session.beginTurnOpening = () => { throw new Error('forced owner conflict') }

    expect(() => proc.emit('init', { session_id: 'claude-session-1' })).not.toThrow()
    expect(proc.isAlive()).toBe(true)
    expect(session.pendingUserMessageCount).toBe(1)
    expect(session.pendingTurnInputs).toEqual(['still pending'])
    expect(sentCards).toHaveLength(0)
  })

  test('defensive drain owner conflict leaves the user batch and reactions queued', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.pendingMidTurnMsgs = [{
      text: 'must survive', wireText: 'must survive', userOpenId: 'ou_user', msgId: 'om_survive',
    }]
    session.pendingReactionIds = new Map([['om_survive', 'reaction_survive']])
    // 合并调和(取舍):同上,冲突注入点改到生产装配入口 beginTurnOpening ——
    // drain 的防御 catch 会 restoreHumanDelivery 回存批次与回执。
    session.beginTurnOpening = () => { throw new Error('forced owner conflict') }

    await session.drainMidTurnAndOpen()

    expect(session.pendingMidTurnMsgs.map((msg: any) => msg.text)).toEqual(['must survive'])
    expect(session.pendingReactionIds).toEqual(new Map([['om_survive', 'reaction_survive']]))
    expect(proc.sentTexts).toEqual([])
  })

  test('settle 后的自发 init 开 bg_task_resume 卡,终报告落卡、正常收尾并加急推送', async () => {
    const { session, proc } = wiredClaudeSession()
    expect(session.currentTurn).toBeNull()

    proc.emit('bg_task_settled', { task_id: 't1', status: 'completed' })
    proc.emit('init', { session_id: 'claude-session-1' }) // SDK 自发恢复轮
    await waitFor(() => session.currentTurn !== null)

    try {
      expect(session.currentTurn.trigger).toBe('bg_task_resume')
      expect(session.status).toBe('working')

      proc.emit('assistant_text', { text: '双盲 review 合并终报告', parentToolUseId: null })
      proc.emit('assistant_block_stop', { parentToolUseId: null })
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

  test('Cron scheduled input arriving after an empty init opens its own card and renders the report', async () => {
    const { session, proc } = wiredClaudeSession()

    proc.emit('init', { session_id: 'claude-session-1' })
    expect(session.currentTurn).toBeNull()
    proc.emit('scheduled_turn_input', {
      text: '【CrossEX 半小时运行巡检】检查服务并汇报。',
      promptId: 'cron-prompt-1',
    })
    await waitFor(() => session.currentTurn !== null)

    try {
      expect(session.currentTurn.trigger).toBe('scheduled_wakeup')
      expect(JSON.stringify(sentCards.at(-1))).toContain('定时任务触发')
      expect(JSON.stringify(sentCards.at(-1))).not.toContain('CrossEX 半小时运行巡检')

      proc.emit('assistant_text', { text: '**巡检 10:13**：服务正常，零异常。', parentToolUseId: null })
      proc.emit('assistant_block_stop', { index: 'assistant-cron-1', parentToolUseId: null })
      emitClaudeResult(proc)
      await waitFor(() => session.currentTurn === null)
      await cardkit.flush('card_status_1')

      expect(calls.some(call =>
        call.method === 'POST' &&
        /\/cards\/[^/]+\/elements$/.test(call.path) &&
        String(call.body?.elements ?? '').includes('巡检 10:13')
      )).toBe(true)
      expect(sentTexts.some(text => text.includes('后台轮输出'))).toBe(false)
    } finally {
      if (session.currentTurn) await session.closeTurnCard('测试收尾')
    }
  })

  test('开卡窗口期先到的 assistant 文本并入新卡,不丢', async () => {
    const { session, proc } = wiredClaudeSession()

    proc.emit('bg_task_settled', { task_id: 't1', status: 'completed' })
    proc.emit('init', { session_id: 'claude-session-1' })
    // openTurnCard 还在 await sendCard/id_convert,文本已经开始流 —— 事故里
    // 55ms 后模型就开写。这些字必须并入随后落地的卡。
    proc.emit('assistant_text', { text: '窗口期先到的段落', parentToolUseId: null })
    proc.emit('assistant_block_stop', { parentToolUseId: null })
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
      proc.emit('assistant_text', { text: '孤儿终报告内容', parentToolUseId: null })
      proc.emit('assistant_block_stop', { parentToolUseId: null })
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
      proc.emit('assistant_text', { text: '被取消的轮次尾巴', parentToolUseId: null })
      proc.emit('assistant_block_stop', { parentToolUseId: null })
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
    proc.emit('assistant_text', { text: '短恢复轮输出', parentToolUseId: null })
    proc.emit('assistant_block_stop', { parentToolUseId: null })
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

  test('用户消息撞上 bg-resume 开卡时排队等待,不抢 owner、不重复开卡、不把后台正文塞进用户卡', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.lastUserOpenId = 'ou_user'
    session.wireProc(proc)
    proc.emit('init', { session_id: 'claude-session-1' })

    let releaseOpen!: () => void
    const gate = new Promise<void>(resolve => { releaseOpen = resolve })
    const originalConvert = cardkit.convertMessageToCard
    let openCalls = 0
    const convert = spyOn(cardkit, 'convertMessageToCard').mockImplementation(async (messageId: string) => {
      openCalls++
      if (openCalls === 1) await gate
      return originalConvert(messageId)
    })

    try {
      session.bgResumePending = true
      proc.emit('init', { session_id: 'claude-session-1' })
      await waitFor(() => openCalls === 1 && session.openingTurn)

      proc.emit('assistant_text', { text: '上一轮后台结果', parentToolUseId: null })
      proc.emit('assistant_block_stop', { index: 'assistant_bg', parentToolUseId: null })
      await session.onUserMessage('请只讲直接结论', [], 'ou_user', '')
      expect(session.pendingMidTurnMsgs.map((msg: any) => msg.text)).toEqual(['请只讲直接结论'])

      emitClaudeResult(proc)
      await new Promise(resolve => setTimeout(resolve, 10))
      // result handler 只能等待既有 bg-resume owner；不能 beginTurnOpen 覆盖它，
      // 更不能让两条 openTurnCard 协程同时创建主卡。
      expect(openCalls).toBe(1)

      releaseOpen()
      await waitFor(() => session.currentTurn?.trigger === 'user_message' && !session.openingTurn)
      const userCardId = session.currentTurn.cardId
      await cardkit.flush(userCardId)

      // 合并调和(取舍):本地投递 pin 不承担上游 sendClaimedUserText 的
      // 「未登记 proc 首投」规则注入,断言用户原文(同 daemon-recovery 用例)。
      expect(proc.sentTexts).toEqual(['请只讲直接结论'])
      expect(sentTexts.some(text => text.includes('后台轮输出'))).toBe(false)
      expect(calls.some(call =>
        call.path === `/cards/${userCardId}/elements` &&
        String(call.body?.elements ?? '').includes('上一轮后台结果')
      )).toBe(false)
      expect(calls.some(call =>
        call.method === 'POST' &&
        /\/cards\/[^/]+\/elements$/.test(call.path) &&
        String(call.body?.elements ?? '').includes('上一轮后台结果')
      )).toBe(true)
    } finally {
      releaseOpen()
      if (session.currentTurn) await session.closeTurnCard('测试收尾')
      convert.mockRestore()
    }
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

describe('Session Claude SDK Cron 定时唤醒巡检卡(上游 7c14677 主题 A)', () => {
  // cron prompt 由 SDK 自主注入,不走 daemon sendUserText:没有 pending input
  // claim,也没有 daemon 开的卡。scheduled_turn_input 到达即认领开卡,否则整轮
  // 巡检输出会被 appendAssistant 静默丢弃(与 bg-resume 恢复轮同型风险)。
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
    proc.emit('init', { session_id: 'claude-session-1' }) // boot init,无用户批次不开卡
    return { session, proc }
  }

  test('scheduled_turn_input 到达空闲 session → 开 scheduled_wakeup 巡检卡', async () => {
    const { session, proc } = wiredClaudeSession()
    expect(session.currentTurn).toBeNull()

    proc.emit('scheduled_turn_input', { text: '巡检:扫描任务清单待办', promptId: 'cron-1' })
    await waitFor(() => session.currentTurn !== null)

    try {
      expect(session.currentTurn.trigger).toBe('scheduled_wakeup')
      expect(session.status).toBe('working')
      expect(sentCards.some(card => JSON.stringify(card).includes('⏰ 定时任务触发'))).toBe(true)
    } finally {
      session.stopFooterStatus(session.currentTurn)
      await cardkit.dispose(session.currentTurn.cardId)
    }
  })

  test('已有活跃 turn 时不开第二张卡(SDK 已把 prompt 并入该轮)', async () => {
    const { session, proc } = wiredClaudeSession()
    session.currentTurn = turnState('card_sched_guard', { provider: 'claude', model: 'claude:glm', usageSource: 'glm' })
    const cardsBefore = sentCards.length

    proc.emit('scheduled_turn_input', { text: '巡检 prompt', promptId: 'cron-2' })
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(sentCards.length).toBe(cardsBefore)
    expect(session.currentTurn.cardId).toBe('card_sched_guard')
    expect(session.openingTurn).toBe(false)
  })

  test('pendingUserMessageCount>0(用户输入待认领)不开巡检卡', async () => {
    const { session, proc } = wiredClaudeSession()
    session.pendingUserMessageCount = 1
    const cardsBefore = sentCards.length

    proc.emit('scheduled_turn_input', { text: '巡检 prompt', promptId: null })
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(sentCards.length).toBe(cardsBefore)
    expect(session.currentTurn).toBeNull()
    expect(session.openingTurn).toBe(false)
  })

  test('codex 进程的 scheduled_turn_input 不响应(Claude SDK 专属事件)', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-sched-1')
    session.proc = proc
    session.selectedProvider = 'codex'
    session.wireProc(proc)
    const cardsBefore = sentCards.length

    proc.emit('scheduled_turn_input', { text: '不该响应', promptId: null })
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(sentCards.length).toBe(cardsBefore)
    expect(session.currentTurn).toBeNull()
  })
})

describe('Session 开卡/迁移单飞与 SDK-input claims(上游 7c14677 主题 C)', () => {
  async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
    const t0 = Date.now()
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error('waitFor timeout')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }

  function emitClaudeResult(proc: any): void {
    proc.lastResult = {
      cost_usd: null, cost_delta_usd: null, duration_ms: 1000,
      num_turns: 1, usage: null, subtype: 'success', is_error: false,
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
    proc.emit('init', { session_id: 'claude-session-1' }) // boot init,无批次不开卡
    return { session, proc }
  }

  test('beginTurnOpening 单飞:owner 在位时第二次 begin 抛出而非静默顶替', () => {
    const session = new Session('probe', 'chat_id') as any
    const token = session.beginTurnOpening()
    expect(() => session.beginTurnOpening()).toThrow(/already owned/)
    session.finishTurnOpening(token)
    expect(session.openingTurn).toBe(false)
    const token2 = session.beginTurnOpening() // 释放后可再获取
    session.finishTurnOpening(token2)
    expect(session.openingTurn).toBe(false)
  })

  test('result 驱动的 mid-turn drain 等待 bg-resume 开卡释放,用户批次开为独立轮', async () => {
    const { session, proc } = wiredClaudeSession()

    proc.emit('bg_task_settled', { task_id: 't-race', status: 'completed' })
    proc.emit('init', { session_id: 'claude-session-1' }) // bg-resume 开卡(await 窗口)
    expect(session.openingTurn).toBe(true)
    // 开卡窗口内:用户消息 daemon 侧缓冲 + result 到达要求 drain
    session.pendingMidTurnMsgs = [{ text: '排队消息', wireText: '排队消息', userOpenId: 'ou_user', msgId: '' }]
    emitClaudeResult(proc)

    // drain 必须等 bg-resume owner 释放,再把用户批次开成独立 user_message 轮
    await waitFor(() => session.currentTurn?.trigger === 'user_message')
    try {
      expect(session.pendingMidTurnMsgs.length).toBe(0)
      // 两张卡按序落地:bg-resume 卡 + 用户轮卡(无并发顶替丢卡)
      expect(sentCards.length).toBe(2)
      expect(session.status).toBe('working')
    } finally {
      session.stopFooterStatus(session.currentTurn)
      await cardkit.dispose(session.currentTurn.cardId)
    }
  })

  test('迁移窗口内新终态 entry 不未画先删:快照在 flush 后取,只移除已画入历史的终态', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.wireProc(proc)
    const now = Date.now()
    session.backgroundTasks = [
      { id: 'painted', type: 'shell', description: 'done early', status: 'completed', startedAt: now - 9000, endTime: now - 1000, steps: [] },
      { id: 'late-terminal', type: 'shell', description: 'finishes mid-migration', status: 'running', startedAt: now - 5000, steps: [] },
    ]
    session.backgroundCard = { messageId: 'om_bg_migrate_race', cardId: 'card_bg_migrate_race' }
    session.backgroundDetailAdded = new Set(['painted', 'late-terminal'])
    cardkit.recordCardCreated('card_bg_migrate_race', 2)
    // 历史快照 updateCard 的 await 窗口内:活跃任务转终态
    feishuMockState.updateCard = async (messageId: string) => {
      if (messageId !== 'om_bg_migrate_race') return
      feishuMockState.updateCard = null
      proc.emit('bg_task_settled', { task_id: 'late-terminal', status: 'completed' })
    }

    await session.migrateBackgroundCard()

    // 已画入快照的 painted 被移除;窗口内新终态 late-terminal 保留(未画入,
    // 由重建卡补墓碑)——旧代码在这里把它连同快照外状态一起删掉
    expect(session.backgroundTasks.map((t: any) => t.id)).toEqual(['late-terminal'])
    expect(session.backgroundTasks[0].status).toBe('completed')
    // 迁移期冻结:settle 未对旧卡二次 updateCard(仅历史快照一次)
    expect(updatedCards.filter(([id]) => id === 'om_bg_migrate_race')).toHaveLength(1)
    // 冻结事件换来的重建收据在位(主卡落地/失败路径消费)
    expect(session.pendingRebuildBackgroundCard).toBe(true)
  })

  test('SDK-input claim 被 init 边界认领:task-notification init 不再开 inputs=0 空卡', async () => {
    const { session, proc } = wiredClaudeSession()
    // eager-open 轮:卡已在位(currentTurn),daemon 写入的 claim=1
    session.currentTurn = turnState('card_claims_eager', { provider: 'claude', model: 'claude:glm', usageSource: 'glm' })
    session.pendingUserMessageCount = 1

    proc.emit('init', { session_id: 'claude-session-1' }) // 该轮自己的边界
    expect(session.pendingUserMessageCount).toBe(0) // claim 已认领

    // 轮收尾后:后台任务通知伴随的 task-notification init(无用户消息、无 settle 置位)
    session.stopFooterStatus(session.currentTurn)
    session.currentTurn = null
    const cardsBefore = sentCards.length
    proc.emit('init', { session_id: 'claude-session-1' })
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(sentCards.length).toBe(cardsBefore) // 不再开出 trigger=user_message inputs=0 空卡
    expect(session.currentTurn).toBeNull()
  })

  test('turn_started 幂等认领 claim(codex 无每轮 init;claude 冷启动首轮靠它)', () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-claims-1')
    session.proc = proc
    session.selectedProvider = 'codex'
    session.wireProc(proc)
    session.currentTurn = turnState('card_claims_codex')
    session.pendingUserMessageCount = 1

    proc.emit('turn_started', { thread_id: 'thread-claims-1', turn_id: 'turn-claims-1' })

    expect(session.pendingUserMessageCount).toBe(0)
    session.stopFooterStatus(session.currentTurn)
    session.currentTurn = null
  })

  test('无 turn 时 count>0 的 init 仍按 user batch 开卡(SDK 轮换分类路径保留)', async () => {
    const { session, proc } = wiredClaudeSession()
    session.pendingUserMessageCount = 1

    proc.emit('init', { session_id: 'claude-session-1' })
    await waitFor(() => session.currentTurn !== null)

    try {
      expect(session.currentTurn.trigger).toBe('user_message')
      expect(session.pendingUserMessageCount).toBe(0)
    } finally {
      session.stopFooterStatus(session.currentTurn)
      await cardkit.dispose(session.currentTurn.cardId)
    }
  })
})

describe('Session claude 子 agent 工具调用不上主卡(上游 89a04d7)', () => {
  // 对齐 codex 侧 isSubagentThread 分流(cf41941):claude 子 agent 的工具调用按
  // parentToolUseId 归属后台 task,只累积进 steps(后台卡展开可见),不上主卡
  // 面板 —— 主卡只承载主 agent,多 agent 期间面板数不爆表。
  function claudeSubagentFixture(cardId: string): { session: any; proc: FakeAgentProc } {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.wireProc(proc)
    session.currentTurn = turnState(cardId, { provider: 'claude', model: 'claude:glm', usageSource: 'glm' })
    cardkit.recordCardCreated(cardId, 1)
    return { session, proc }
  }

  test('子 agent tool_use/tool_result 只进 bg steps,不 addTool/completeTool 上主卡', async () => {
    const { session, proc } = claudeSubagentFixture('card_subagent_iso')
    try {
      // 主线程 Task tool_use 触发子 agent → bg task 建立(toolUseId 关联)
      proc.emit('tool_use', { id: 'task_main_1', name: 'Task', input: { description: 'review' }, parentToolUseId: null })
      proc.emit('bg_task_started', { task_id: 't1', tool_use_id: 'task_main_1', description: 'review' })
      // 子 agent 内的工具调用:parentToolUseId 指向主线程 Task
      proc.emit('tool_use', { id: 'sub_read_1', name: 'Read', input: { file_path: '/tmp/a.ts' }, parentToolUseId: 'task_main_1' })
      proc.emit('tool_result', { tool_use_id: 'sub_read_1', content: 'file body', is_error: false, parentToolUseId: 'task_main_1' })

      // steps 已累积(含结果回填)
      const t1 = session.backgroundTasks.concat(session.pendingBgTasks).find((t: any) => t.id === 't1')
      expect(t1).toBeDefined()
      expect(t1.steps.length).toBe(1)
      expect(t1.steps[0].tool).toBe('Read')
      expect(t1.steps[0].brief).toContain('→ file body')
      // 主卡 toolByUseId 不含子 agent 工具 —— 没走 addTool/completeTool
      expect(session.currentTurn.toolByUseId.has('sub_read_1')).toBe(false)
      // 合并调和(取舍):合并实现并入上游 89a04d7 原生委派面板模型 —— 主线程
      // Task/Agent tool_use 直接建立委派 task(启动工具也归入委派面板,不上
      // 主卡),SDK task id 经 tool_use_id 回填合并后仍只有一项。本地旧接线
      // (Task 照常 addTool 上主卡)是 89a04d7 落地前的形态,已被上游语义取代。
      expect(session.currentTurn.toolByUseId.has('task_main_1')).toBe(false)
      expect(session.backgroundTasks).toHaveLength(1)
      await cardkit.flush('card_subagent_iso')
    } finally {
      session.stopFooterStatus(session.currentTurn)
      // 合并取舍:上游 closeChat 属 agentCards 共享卡子系统(未并入定型
      // session.ts);本地 resetBackgroundTasks 已清后台句柄,无需 closeChat。
      await session.resetBackgroundTasks()
      await cardkit.dispose('card_subagent_iso')
    }
  })

  test('DSH 子工具返回内容块时不抛异常，也不写入主对话卡', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('dsh', 'dsh-session')
    session.proc = proc
    session.wireProc(proc)
    session.currentTurn = turnState('card_dsh_child_blocks')
    cardkit.recordCardCreated('card_dsh_child_blocks', 1)
    try {
      proc.emit('bg_task_started', { task_id: 'child', tool_use_id: 'child', description: 'DSH child', task_type: 'agent' })
      proc.emit('tool_use', { id: 'child-bash', name: 'Bash', input: { command: 'echo child' }, parentToolUseId: 'child' })
      expect(() => proc.emit('tool_result', { tool_use_id: 'child-bash', content: [{ type: 'text', text: 'started background job bash-1' }],
        is_error: false, parentToolUseId: 'child' })).not.toThrow()
      const child = [...session.backgroundTasks, ...session.pendingBgTasks].find((entry: any) => entry.id === 'child')
      expect(child.steps[0].brief).toContain('started background job bash-1')
      expect(session.currentTurn.toolByUseId.has('child-bash')).toBe(false)
      expect(proc.isAlive()).toBe(true)
    } finally {
      session.stopFooterStatus(session.currentTurn)
      await session.resetBackgroundTasks()
      // 合并取舍:上游 closeChat 属 agentCards 共享卡子系统(未并入定型
      // session.ts);本地 resetBackgroundTasks 已清后台句柄,无需 closeChat。
      await cardkit.dispose('card_dsh_child_blocks')
    }
  })

  test('子 agent assistant text/block_stop 不进入主卡,主 agent 正文仍正常渲染', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.wireProc(proc)
    session.currentTurn = turnState('card_subagent_text_iso')
    cardkit.recordCardCreated('card_subagent_text_iso', 1)

    try {
      proc.emit('assistant_text', {
        text: '我将并行开展多轮搜索来收集证据。',
        parentToolUseId: 'task_main_1',
      })
      proc.emit('assistant_block_stop', {
        index: 'assistant_child_1',
        parentToolUseId: 'task_main_1',
      })

      expect(session.currentTurn.assistantSegmentCount).toBe(0)
      expect(session.currentTurn.segmentTexts.size).toBe(0)

      proc.emit('assistant_text', { text: '这是主 Agent 的结论。', parentToolUseId: null })
      proc.emit('assistant_block_stop', { index: 'assistant_main_1', parentToolUseId: null })
      await cardkit.flush('card_subagent_text_iso')

      expect(session.currentTurn.assistantSegmentCount).toBe(1)
      expect([...session.currentTurn.segmentTexts.values()]).toEqual(['这是主 Agent 的结论。'])
      expect(calls.some(call =>
        call.method === 'POST' &&
        call.path === '/cards/card_subagent_text_iso/elements' &&
        String(call.body?.elements ?? '').includes('我将并行开展多轮搜索')
      )).toBe(false)
    } finally {
      session.stopFooterStatus(session.currentTurn)
      await cardkit.dispose('card_subagent_text_iso')
    }
  })

  test('parentToolUseId 无归属 task 的 tool_use(如合成 AskUserQuestion)仍走主卡', async () => {
    const { session, proc } = claudeSubagentFixture('card_subagent_orphan')
    try {
      proc.emit('tool_use', { id: 'orphan_1', name: 'Bash', input: { command: 'echo hi' }, parentToolUseId: 'unknown_parent' })
      expect(session.currentTurn.toolByUseId.has('orphan_1')).toBe(true)
      // 孤儿 tool_result 也照常 completeTool 回填主卡面板
      proc.emit('tool_result', { tool_use_id: 'orphan_1', content: 'hi', is_error: false, parentToolUseId: 'unknown_parent' })
      expect(session.currentTurn.toolByUseId.get('orphan_1').output).toBe('hi')
      await cardkit.flush('card_subagent_orphan')
    } finally {
      session.stopFooterStatus(session.currentTurn)
      await cardkit.dispose('card_subagent_orphan')
    }
  })

  test('parentToolUseId 为 null 的主线程工具行为与现状一致(addTool/completeTool + Task id 记录)', async () => {
    const { session, proc } = claudeSubagentFixture('card_subagent_mainline')
    try {
      proc.emit('tool_use', { id: 'main_bash_1', name: 'Bash', input: { command: 'pwd' }, parentToolUseId: null })
      expect(session.currentTurn.toolByUseId.has('main_bash_1')).toBe(true)
      proc.emit('tool_result', { tool_use_id: 'main_bash_1', content: '/tmp', is_error: false, parentToolUseId: null })
      expect(session.currentTurn.toolByUseId.get('main_bash_1').output).toBe('/tmp')
      // 主线程 Task tool_use 记录 lastMainTaskToolUseId(task_started 缺 tool_use_id 时兜底关联)
      proc.emit('tool_use', { id: 'main_task_1', name: 'Task', input: { description: 'spawn' }, parentToolUseId: null })
      expect(session.lastMainTaskToolUseId).toBe('main_task_1')
      // 合并调和(取舍):合并实现并入上游原生委派面板模型 —— 主线程 Task
      // tool_use 即建立 subagent 委派项(toolUseId 关联,等 SDK task id 回填);
      // 普通主线程工具(Bash)不产生任何 bg 项,addTool/completeTool 行为不变。
      expect(session.backgroundTasks).toHaveLength(1)
      expect(session.backgroundTasks[0]).toMatchObject({
        id: 'main_task_1', toolUseId: 'main_task_1', type: 'subagent', isBackgrounded: true,
      })
      expect(session.pendingBgTasks).toEqual([])
      await cardkit.flush('card_subagent_mainline')
    } finally {
      session.stopFooterStatus(session.currentTurn)
      await session.resetBackgroundTasks()
      await cardkit.dispose('card_subagent_mainline')
    }
  })
})

describe('Session codex 子 agent 后台游标卡接线(上游 cf41941)', () => {
  function codexBgFixture(): { session: any; proc: FakeAgentProc } {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-session-1')
    session.proc = proc
    session.selectedProvider = 'codex'
    session.wireProc(proc)
    return { session, proc }
  }

  test('subagent_step 事件经 cards.applySubagentStep 更新 bg 池,步骤在游标卡可见', () => {
    const { session, proc } = codexBgFixture()
    // 预置活卡句柄:避免本测触发 openBackgroundCard 的 await 链在测试结束后
    // 撞原始 fetch(挂账第 2 项已知模式);本测只锁 store 累积语义。
    session.backgroundCard = { messageId: 'om_bg_steps', cardId: 'card_bg_steps' }
    proc.emit('bg_task_started', { task_id: 'sub-1', task_type: 'local_agent', description: 'worker' })
    proc.emit('bg_task_updated', { task_id: 'sub-1', patch: { is_backgrounded: true } })

    // wire 形态与 codex-process emitSubagentStep 一致:brief 不带工具名前缀
    // (applySubagentStep 在 started 时自己拼 `${tool} ${brief}`)。
    proc.emit('subagent_step', { thread_id: 'sub-1', item_id: 'cmd-1', tool: 'Bash', phase: 'started', brief: 'bun test' })
    proc.emit('subagent_step', { thread_id: 'sub-1', item_id: 'cmd-1', tool: undefined, phase: 'completed', brief: '→ 12 pass' })

    const t = session.backgroundTasks.find((x: any) => x.id === 'sub-1')
    expect(t).toBeDefined()
    expect(t.steps).toHaveLength(1)
    expect(t.steps[0].brief).toBe('Bash bun test → 12 pass')

    // 未知 thread(先于 started 到达的极早期)丢弃,不产生新 entry。
    proc.emit('subagent_step', { thread_id: 'sub-nope', item_id: 'x-1', tool: 'Bash', phase: 'started', brief: 'x' })
    expect(session.backgroundTasks.some((x: any) => x.id === 'sub-nope')).toBe(false)
    expect(session.pendingBgTasks).toEqual([])
    // 收尾:卸下预置句柄走纯内存清理分支,防 afterEach dispose 的 settle
    // continuation 在 fetch 复原后撞真实 API(挂账第 2 项既有模式,不新增)。
    session.backgroundCard = null
  })

  test('codex 子 agent bg_task_settled 不置位 bgResumePending(结果由主 turn 收编,不自发开轮)', () => {
    const { session, proc } = codexBgFixture()
    session.initCount = 1
    expect(session.currentTurn).toBeNull()

    proc.emit('bg_task_settled', { task_id: 'tx', status: 'completed' })

    expect(session.bgResumePending).toBe(false)
  })

  test('claude 子 agent bg_task_settled 行为不变:仍置位 bgResumePending(SDK 自发恢复轮)', () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.wireProc(proc)
    session.initCount = 1

    proc.emit('bg_task_settled', { task_id: 'tx', status: 'completed' })

    expect(session.bgResumePending).toBe(true)
  })

  test('开卡落地后复查:await 窗口内全部终态(短命 agent)→ 直接沉降,活卡不僵死(#9)', async () => {
    const { session, proc } = codexBgFixture()
    // start 与 settle 同批到达:settle 那刻 backgroundCard 还是 null(开卡在 await),
    // 沉降空转 —— 落地后必须复查,否则活卡带终态快照永不 settle。
    proc.emit('bg_task_started', { task_id: 'st-1', task_type: 'local_agent', description: 'short-lived' })
    proc.emit('bg_task_settled', { task_id: 'st-1', status: 'completed', summary: 'done' })

    await waitFor(() => session.backgroundCard === null && session.backgroundTasks.length === 0)
    expect(session.openingBackground).toBe(false)
  })
})

describe('Session usage cache cross-backend isolation', () => {
  test('a completed card retains the successful account cache when the latest query failed and the process exited', async () => {
    const { bindProcessCodexAccount } = await import('./codex-accounts')
    const accountId = 'closed-footer-cache'
    const session = new Session('closed-footer-cache', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'quota-session')
    bindProcessCodexAccount(proc, accountId)
    session.proc = proc
    session.selectedTokenSourceId = null
    const turn = { ...turnState('card_closed_footer_cache'), provider: 'codex', model: 'shared-model', effort: 'high', userOpenId: '' }
    session.currentTurn = turn
    session.lastTurnUsage = { input_tokens: 100, output_tokens: 10, total_tokens: 110 }
    cardkit.recordCardCreated(turn.cardId, 1)
    let quotaNow = Date.now()
    const quotaClock = spyOn(Date, 'now').mockImplementation(() => quotaNow)
    try {
      await refreshUsageFromConnection(async () => ({ rateLimits: {
        primary: { usedPercent: 12, windowDurationMins: 300 },
        secondary: { usedPercent: 34, windowDurationMins: 10080 },
        credits: { hasCredits: true, unlimited: false, balance: '62500' },
      } }), accountId)
      quotaNow += 60_000
      await refreshUsageFromConnection(async () => { throw new Error('quota read failed') }, accountId)
      expect(peekUsage(accountId)).toBeTruthy()
      proc.alive = false
      await session.closeTurnCard(undefined, { hasFreshResult: true })
      const footer = calls.find(call => call.method === 'PUT' && call.path === `/cards/${turn.cardId}/elements/footer`)
      const content = JSON.parse(footer?.body.element ?? '{}').content as string
      expect(content).toContain('12%·[34%]')
      expect(content).toContain('积分 62.5k')
      expect(content).not.toContain('缓存')
      expect(content).not.toContain('刷新失败')
      expect(content).not.toContain('MISS')
    } finally {
      quotaClock.mockRestore()
      invalidateCodexUsage(accountId)
      proc.emit('exit')
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('claude 的 rate_limit_event payload 不触碰 codex 用量缓存', async () => {
    // 用 read 端点形状经真实 cache 写入路径(refresh)播种缓存(模块级单例)。
    const seeded = await refreshUsageFromConnection(async () => ({
      rateLimits: {
        limitId: 'codex', planType: 'plus',
        primary: { usedPercent: 42, resetsAt: 1_700_000_000, windowDurationMins: 300 },
        secondary: null,
      },
    }))
    expect(seeded?.state).toBe('ok')

    const session = new Session('probe', 'chat_id') as any
    const claudeProc = new FakeAgentProc('claude')
    session.proc = claudeProc
    session.wireProc(claudeProc)
    // claude 的 rate_limit_info 形状(无 planType/primary/secondary):truthy 但
    // 与 codex 完全不同。新架构下通知一律不写 cache(rolling limitId 不可信),
    // claude 事件更不能。
    claudeProc.emit('rate_limits_updated', { status: 'allowed', unified_status: 'allowed' })

    // 缓存对象必须原封不动(恒等,而非结构相等)。
    expect(peekUsage()).toBe(seeded)
  })

  test('codex 的 rate_limits_updated 只观察不写缓存(权威在 read 端点)', () => {
    const session = new Session('probe', 'chat_id') as any
    const codexProc = new FakeAgentProc('codex')
    session.proc = codexProc
    session.wireProc(codexProc)
    codexProc.emit('rate_limits_updated', {
      planType: 'pro',
      primary: { usedPercent: 7, resetsAt: 1_700_000_000, windowDurationMins: 300 },
    })

    // rolling 通知不再驱动 cache —— 2026-08-20 源码核实 codex 解析器在
    // 上游缺 metered_limit_name 时把 limitId 强补 "codex",通知归属不可信;
    // turn 收尾由 closeTurnCard 在现有连接 read 端点整体刷新。
    const snap = peekUsage() as any
    expect(snap?.fiveHour?.percent).not.toBe(7)
  })

  test('额度后缀保留原紧凑倒计时与百分比格式，缺失值显示 MISS', () => {
    const session = new Session('probe', 'chat_id') as any
    const h = (ms: number) => new Date(Date.now() + ms)
    // 4.1h 后重置 5h 额度、已用 7%;6.9d 后重置周额度、已用 17%。
    const fiveHour = { percent: 7, resetsAt: h(4.1 * 3600_000) }
    const weekly = { percent: 17, resetsAt: h(6.9 * 24 * 3600_000) }
    expect(session.fmtDualWindowSuffix(fiveHour, weekly)).toBe('  |  4.1h·7%·[6.9d·17%]')
    expect(session.fmtDualWindowSuffix(fiveHour, null)).toBe('  |  4.1h·7%')
    expect(session.fmtDualWindowSuffix({ percent: null, resetsAt: h(3600_000) }, weekly)).toBe('  |  MISS·[6.9d·17%]')
    expect(session.fmtDualWindowSuffix(null, weekly)).toBe('  |  [6.9d·17%]')
    expect(session.fmtDualWindowSuffix({ percent: 7, resetsAt: new Date(Date.now() - 1000) }, weekly)).toBe('  |  7%·[6.9d·17%]')
    expect(session.fmtDualWindowSuffix(null, null)).toBe('  |  额度 MISS')
  })

  test('Claude 的 hi 展示全部窗口，footer 按当前模型选择周额度并保留 5h', async () => {
    const { claudeUsageSnapshot } = await import('./claude-usage')
    const accountUsage = await import('./account-usage')
    const session = new Session('claude-quota', 'chat_id') as any
    let snapshot = claudeUsageSnapshot({ subscription_type: 'max', rate_limits_available: true, rate_limits: {
      five_hour: { utilization: 7, resets_at: new Date(Date.now() + 4.1 * 3600_000).toISOString() },
      seven_day: { utilization: 17, resets_at: new Date(Date.now() + 6.9 * 86400_000).toISOString() },
      model_scoped: [{ display_name: 'Fable', utilization: 42, resets_at: null }],
    } })
    const source = { id: 'claude-sub', kind: 'claude-subscription', agent: 'claude', enabled: true, readUsage: async () => snapshot }
    session.selectedTokenSourceId = source.id
    session.currentTokenSource = () => source
    session.buildConsoleOpts = async () => ({ sessionName: 'claude-quota', status: 'idle', provider: 'claude' })
    const replaceSpy = spyOn(cardkit, 'replaceElementChecked').mockResolvedValue(true)
    const readAllSpy = spyOn(accountUsage, 'readAllAccountUsage').mockImplementation(async () => [
      { id: source.id, label: 'Claude 订阅', usage: snapshot },
    ])
    try {
      await session.patchConsoleUsage('quota-card')
      const panel = replaceSpy.mock.calls.at(-1)?.[2] as any
      expect(panel.element_id).toBe('console_usage')
      expect(panel.elements).toHaveLength(1)
      expect(panel.elements[0].content).toBe('**Claude 订阅**　5h 7%/4.1h · 周 17%/6.9d · Fable周 42%/MISS')
      expect(await session.footerUsageSuffix('claude', null, source.id, source, null, 'opus')).toBe('  |  4.1h·7%·[6.9d·17%]')
      // 合并调和(取舍):合并保留本地 resolveClaudeSdkModel('default') →
      // DEFAULT_CLAUDE_SDK_MODEL('claude-fable-5')映射(本地默认档),default
      // 因而落 Fable 家族 → 周额度取 model_scoped:Fable(42%),与 'opus'(非
      // Fable 家族)的双窗口径不同;上游该行的 'default'→opus 映射未吸收。
      expect(await session.footerUsageSuffix('claude', null, source.id, source, null, 'default')).toBe('  |  4.1h·7%·[42%]')
      expect(await session.footerUsageSuffix('claude', null, source.id, source, null, 'claude-fable-5-1[1m]')).toBe('  |  4.1h·7%·[42%]')
      snapshot.windows.find(window => window.kind === 'modelWeekly:Fable')!.percent = null
      expect(await session.footerUsageSuffix('claude', null, source.id, source, null, 'fable')).toBe('  |  4.1h·7%·[MISS]')
      expect(await session.footerUsageSuffix('claude', null, source.id, source, null, null)).toBe('  |  4.1h·7%·[MISS]')
      snapshot = { state: 'network', windows: [], reason: 'query failed' }
      await session.patchConsoleUsage('quota-card')
      expect((replaceSpy.mock.calls.at(-1)?.[2] as any).elements[0].content).toContain('MISS · query failed')
      expect(await session.footerUsageSuffix('claude', null, source.id, source, null)).toBe('  |  额度 MISS')
      expect(await session.footerUsageSuffix('codex', null, source.id, source, null)).toBe('  |  额度 MISS')
      expect(await session.footerUsageSuffix('claude', null, 'other-source', undefined, null)).toBe('  |  额度 MISS')
    } finally { replaceSpy.mockRestore(); readAllSpy.mockRestore() }
  })

  test('Claude 收尾查询等待期间切换模型，不改变旧回复的专属周额度', async () => {
    const { claudeUsageSnapshot } = await import('./claude-usage')
    const snapshot = claudeUsageSnapshot({ subscription_type: 'max', rate_limits_available: true, rate_limits: {
      five_hour: { utilization: 7, resets_at: null },
      seven_day: { utilization: 17, resets_at: null },
      model_scoped: [{ display_name: 'Fable', utilization: 42, resets_at: null }],
    } })
    const session = new Session('claude-quota-snapshot', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'quota-session', 'claude-sub')
    proc.lastModel = 'claude:fable'
    session.proc = proc
    session.selectedProvider = 'claude'
    session.selectedTokenSourceId = 'claude-sub'
    session.selectedModel = 'fable'
    const turn = { ...turnState('card_quota_snapshot'), provider: 'claude', model: 'fable', effort: 'high', userOpenId: '' }
    session.currentTurn = turn
    session.lastTurnUsage = { input_tokens: 100, output_tokens: 10, total_tokens: 110 }
    let signalStarted!: () => void
    const started = new Promise<void>(resolve => { signalStarted = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const source = { id: 'claude-sub', kind: 'claude-subscription', agent: 'claude', enabled: true,
      readUsage: async () => { signalStarted(); await gate; return snapshot } }
    session.currentTokenSource = () => source
    cardkit.recordCardCreated(turn.cardId, 1)
    const closing = session.closeTurnCard(undefined, { hasFreshResult: true })
    try {
      await started
      session.selectedModel = 'sonnet'
      proc.lastModel = 'claude:sonnet'
      release()
      await closing
      const footer = calls.find(call => call.method === 'PUT' && call.path === `/cards/${turn.cardId}/elements/footer`)
      const content = JSON.parse(footer?.body.element ?? '{}').content as string
      expect(content).toContain('claude · fable/high')
      expect(content).toContain('7%·[42%]')
      expect(content).not.toContain('17%')
    } finally {
      release()
      await closing
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })
})

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

describe('Session resetBackgroundTasks on kill/restart', () => {
  // 复现:SDK 子进程一死就不再发 task_settled,活跃 entry 永远卡 running,
  // backgroundRefreshTick(不归 SDK 管)还会继续跨档刷新「🟡 运行中」—— 卡片
  // 永不沉降,伪造「还在跑」。kill(stop)/restart 必须
  // 主动结算。回归:2026-07-06。

  test('stop() kills proc AND clears running background tasks (public kill path)', async () => {
    // 用户真实触发路径:kill 命令 → session.stop()。修复前 stop 只杀进程,
    // 不碰 backgroundTasks,running entry 留在内存 + refresh tick 继续伪造时长。
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.backgroundTasks = [makeRunningTask('t1'), makeRunningTask('t2')]
    session.pendingBgTasks = [makeRunningTask('foreground')]
    // 合并调和:上游经 refreshBackgroundCardFull 自动开共享卡;定型 session.ts
    // 开卡走本地 openBackgroundCard(refresh 只原地刷新既有卡)—— 显式 await
    // 本地开卡,等价上游「先建卡,再 stop」的编排意图。
    await session.openBackgroundCard()
    session.scheduleBackgroundRefresh()

    await session.stop('已终止', { announce: false })

    expect(proc.killCalls).toBe(1)
    expect(session.backgroundTasks).toEqual([])
    expect(session.pendingBgTasks).toEqual([])
    // 本地无上游 backgroundSync(共享卡写单飞);等价钉:句柄已随沉降清空。
    expect(session.backgroundCard).toBeNull()
    expect(session.backgroundRefreshTimer).toBeNull()
    expect(sentCards).toHaveLength(1)
    // 上游钉共享卡元素写(PUT body.element);本地终态经整卡墓碑
    // feishu.updateCard(updatedCards)落地,断言随本地通道迁移 —— 意图不变:
    // 墓碑含「已终止」、不泄漏 foreground 前台挂单。
    expect(updatedCards).toHaveLength(1)
    const tombstone = JSON.stringify(updatedCards[0]![1])
    expect(tombstone).toContain('已终止')
    expect(tombstone).not.toContain('foreground')
    const settings = calls.filter(call => call.path.endsWith('/settings')).at(-1)!
    expect(JSON.parse(settings.body.settings).config.streaming_mode).toBe(false)
  })

  test('a main message leaves running work in its original panel', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.backgroundTasks = [makeRunningTask('running')]
    // 合并调和:上游 refresh 自动开卡、运行期 summary 上共享卡;定型 session.ts
    // 显式 openBackgroundCard 开卡、refresh 原地 replaceElement(不重发、不整卡
    // 更新)——意图一致:主消息提交后,运行中的工作留在原卡。变化点改用
    // steps(本地运行期 panel 的可见通道;上游用 summary),元素写需 flush。
    await session.openBackgroundCard()
    await feishu.sendCard('chat_id', { schema: '2.0', body: { elements: [] } })
    session.backgroundTasks = [{ ...session.backgroundTasks[0], steps: [{ brief: '检查中' }] }]
    await session.refreshBackgroundCardFull()
    await cardkit.flush(session.backgroundCard.cardId)
    expect(sentCards).toHaveLength(2)
    expect(updatedCards).toHaveLength(0)
    expect(calls.some(call => call.method === 'PUT' && String(call.body.element).includes('检查中'))).toBe(true)
    await session.resetBackgroundTasks()
  })

  test('stop waits for an admitted open, settles it, and namespaces a later process', async () => {
    // 合并调和:上游为共享卡体系(reset await 在途 admitted open、同卡元素
    // 世代命名空间,开卡等待由 backgroundSync 单飞)。定型 session.ts 保留本地
    // 语义:开卡 fire-and-forget + 世代号作废 —— reset 不等开卡,在途旧开卡
    // 落地后自弃为「世代已切换」墓碑;后续同 id 进程开全新卡(新 message)不
    // 复用旧卡。意图保留:reset 与在途开卡互不污染、后到进程不撞旧卡状态。
    const session = new Session('background-open-generation', 'chat_id') as any
    session.backgroundTasks = [makeRunningTask('same-id')]
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const baseFetch = globalThis.fetch
    let converting = false
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname.endsWith('/cards/id_convert')) {
        converting = true
        await gate
      }
      return baseFetch(input, init)
    }) as typeof fetch
    try {
      // 生产同款接线(onBackgroundTaskChanged 开卡分支):世代化开卡不阻塞调用方。
      session.openingBackground = true
      const generation = ++session.backgroundOpenGeneration
      const opening = session.openBackgroundCard(generation).finally(() => {
        if (session.backgroundOpenGeneration === generation) session.openingBackground = false
      })
      await waitUntil(() => converting)
      const resetting = session.resetBackgroundTasks()
      release()
      await Promise.all([opening, resetting])
      expect(session.backgroundTasks).toEqual([])
      // 在途旧开卡未被 reset 收养为活卡;而是自弃为「世代已切换」墓碑。
      expect(session.backgroundCard).toBeNull()
      expect(calls.some(call => call.path.endsWith('/settings')
        && String(call.body.settings).includes('后台任务世代已切换'))).toBe(true)
      session.backgroundTasks = [makeRunningTask('same-id')]
      await session.openBackgroundCard()
      // 新世代开新卡(新 message):不复用旧卡即本地形态的「命名空间」。
      expect(sentCards).toHaveLength(2)
      expect(session.backgroundCard.messageId).not.toBe('om_status_1')
    } finally {
      release()
      await session.resetBackgroundTasks()
      globalThis.fetch = baseFetch
    }
  })

  test('a failed terminal update remains visible and can be retried without duplicate rows', async () => {
    // 合并调和:上游经 agentCards.deps.patchSettingsChecked 注入共享卡终态写
    // 失败;定型 session.ts 无 agentCards 子系统,终态写 = 整卡墓碑
    // feishu.updateCard(注入缝 feishuMockState.updateCard)。语义保留:reset
    // 抛出失败、任务先翻 killed;重试不重发卡(行不重复、失败卡仍在原地)。
    const session = new Session('background-update-failure', 'chat_id') as any
    session.backgroundTasks = [makeRunningTask('running')]
    await session.openBackgroundCard()
    feishuMockState.updateCard = async () => { throw new Error('terminal update MISS') }
    try {
      await expect(session.resetBackgroundTasks()).rejects.toThrow('terminal update MISS')
      expect(session.backgroundTasks[0].status).toBe('killed')
    } finally { feishuMockState.updateCard = null }
    await session.resetBackgroundTasks()
    expect(session.backgroundTasks).toEqual([])
    expect(sentCards).toHaveLength(1)
  })

  test('a failed launch is visible in the delegation panel without a main tool panel', async () => {
    const session = new Session('native-launch-failure', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session')
    session.proc = proc
    session.wireProc(proc)
    session.currentTurn = turnState('card_failed_child')
    cardkit.recordCardCreated('card_failed_child', 1)
    try {
      proc.emit('tool_use', { id: 'agent-tool', name: 'Agent', input: { description: '检查接口' }, parentToolUseId: null })
      proc.emit('tool_result', { tool_use_id: 'agent-tool', content: '无法启动子 Agent', is_error: true, parentToolUseId: null })
      await session.backgroundSync
      expect(session.currentTurn.toolByUseId.size).toBe(0)
      expect(session.backgroundTasks).toHaveLength(1)
      expect(session.backgroundTasks[0].status).toBe('failed')
      // 合并调和:上游共享卡把失败渲染到开卡卡上并钉 '"子 Agent失败"' 文案;
      // 定型本地背景卡为独立卡,失败经整卡墓碑(updatedCards)落地,header
      // 文案为本地 statusLabel '— ❌ 失败'。断言随本地通道,意图不变:失败与
      // 错误原文可见,且主轮卡上不出现 tool 面板(toolByUseId 保持 0)。
      await waitUntil(() => session.backgroundCard === null && updatedCards.length > 0)
      const tombstone = JSON.stringify(updatedCards.at(-1))
      expect(tombstone).toContain('❌ 失败')
      expect(tombstone).toContain('无法启动子 Agent')
    } finally {
      session.stopFooterStatus(session.currentTurn)
      await session.resetBackgroundTasks()
      // 合并取舍:上游 closeChat 属 agentCards 共享卡子系统(未并入定型
      // session.ts);本地 resetBackgroundTasks 已清后台句柄,无需 closeChat。
      await cardkit.dispose('card_failed_child')
    }
  })

  test('a successful async launch receipt leaves the child running until its native result', async () => {
    const session = new Session('native-background-receipt', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session')
    session.proc = proc
    session.wireProc(proc)
    session.currentTurn = turnState('card_async_child')
    cardkit.recordCardCreated('card_async_child', 1)
    try {
      proc.emit('tool_use', { id: 'agent-tool', name: 'Agent', input: { description: '检查接口', run_in_background: true }, parentToolUseId: null })
      expect(session.currentTurn.footerStatusLabel).toBe('Working...')
      proc.emit('tool_result', { tool_use_id: 'agent-tool', content: 'Agent launched', is_error: false, parentToolUseId: null })
      expect(session.currentTurn.footerStatusLabel).toBe('Thinking...')
      expect(session.backgroundTasks[0].status).toBe('running')
      proc.emit('bg_task_started', { task_id: 'native-id', tool_use_id: 'agent-tool', description: '检查接口', task_type: 'local_agent' })
      proc.emit('bg_task_settled', { task_id: 'native-id', status: 'completed', summary: '接口正常' })
      await session.backgroundSync
      expect(session.backgroundTasks).toHaveLength(1)
      expect(session.backgroundTasks[0].status).toBe('completed')
      expect(session.currentTurn.toolByUseId.size).toBe(0)
      expect(sentCards).toHaveLength(1)
      expect(calls.filter(call => call.method === 'POST' && call.path.endsWith('/elements'))).toHaveLength(0)
    } finally {
      session.stopFooterStatus(session.currentTurn)
      await session.resetBackgroundTasks()
      // 合并取舍:上游 closeChat 属 agentCards 共享卡子系统(未并入定型
      // session.ts);本地 resetBackgroundTasks 已清后台句柄,无需 closeChat。
      await cardkit.dispose('card_async_child')
    }
  })
})

describe('Session optional progress presentation', () => {
  test.each(['Bash', 'Read', 'Edit'].flatMap(name => [true, false].map(resultLands => ({ name, resultLands }))))(
    'a tool placeholder fails silently but its result stays checked (%p)', async ({ name, resultLands }) => {
    const session = new Session('optional-placeholder', 'chat_id') as any
    const turn = turnState('card_optional_placeholder')
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1, (code, failure) => session.onCardWriteFailure(turn.cardId, code, failure))
    const normalFetch = globalThis.fetch
    let finishing = false
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST' && String(init.body).includes('tool_0') && (!finishing || !resultLands)) {
        return Response.json({ code: 300121, msg: 'tool element rejected', error: { log_id: 'tool-write-log' } })
      }
      return normalFetch(input, init)
    }) as typeof fetch
    try {
      sessionTools.addTool(session, session.proc, 'ordinary-tool', name, { command: 'echo ready', file_path: '/tmp/source.ts' })
      await cardkit.flush(turn.cardId)
      expect(sentRawTexts).toHaveLength(0)
      expect(turn.cardWriteFailureNotices.size).toBe(0)
      expect(cardkit.isDeadElement(turn.cardId, 'tool_0')).toBe(true)
      finishing = true
      sessionTools.completeTool(session, session.proc, 'ordinary-tool', 'actual tool result', false)
      await cardkit.flush(turn.cardId)
      expect(cardkit.isDeadElement(turn.cardId, 'tool_0')).toBe(!resultLands)
      expect(sentRawTexts).toHaveLength(resultLands ? 0 : 1)
      if (resultLands) {
        const result = calls.find(call => call.method === 'POST' && String(call.body?.elements).includes('tool_0'))
        expect(result?.body.target_element_id).toBe('footer')
      } else {
        // 合并调和(取舍):上游非容量失败通知附 formatFeishuError 原文(log_id=…);
        // 本地冻结文案为分类摘要(main 原文,code+操作类别,绝不内插响应原文)。
        // 用例本意"失败以用户可见诊断上报"不变,按合并实现文案对齐。
        expect(sentRawTexts[0]).toContain('不是卡片元素上限')
        expect(sentRawTexts[0]).toContain('code=300121')
      }
    } finally { globalThis.fetch = normalFetch; session.stopFooterStatus(turn); await cardkit.dispose(turn.cardId); session.dispose() }
  })

  test.each(['plan', 'tasks'])('existing %s overview failures stay silent while timeline failures are reported', async kind => {
    const session = new Session('optional-overview', 'chat_id') as any
    const turn = turnState('card_optional_overview')
    const proc = new FakeAgentProc('codex', 'overview-thread')
    session.proc = proc
    session.wireProc(proc)
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1, (code, failure) => session.onCardWriteFailure(turn.cardId, code, failure))
    let revision = 0
    const update = () => {
      revision++
      if (kind === 'plan') {
        proc.emit('turn_plan_updated', { plan: [{ step: `step ${revision}`, status: 'inProgress' }] })
      } else {
        const name = revision === 1 ? 'TaskCreate' : 'TaskUpdate'
        sessionTools.addTool(session, session.proc, `task-${revision}`, name, { subject: 'work', taskId: '1', status: 'in_progress' })
        sessionTools.completeTool(session, session.proc, `task-${revision}`, JSON.stringify({ task: { id: '1', subject: 'work', status: 'in_progress' } }), false)
      }
    }
    const normalFetch = globalThis.fetch
    let rejectTimeline = false
    try {
      update()
      await cardkit.flush(turn.cardId)
      const overviewId = kind === 'plan' ? 'plan_live' : 'task_board_live'
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const overview = init?.method === 'PUT' && String(input).endsWith(`/elements/${overviewId}`)
        const timeline = kind === 'plan'
          ? init?.method === 'POST' && String(init.body).includes('plan_update_')
          : init?.method === 'PUT' && /\/elements\/tool_\d+$/.test(String(input))
        if (overview || (rejectTimeline && timeline)) return Response.json({ code: 300121, msg: 'snapshot rejected' })
        return normalFetch(input, init)
      }) as typeof fetch
      update()
      await cardkit.flush(turn.cardId)
      expect(sentRawTexts).toHaveLength(0)
      expect(turn.cardWriteFailureNotices.size).toBe(0)
      expect(cardkit.isDeadElement(turn.cardId, overviewId)).toBe(false)
      rejectTimeline = true
      update()
      await cardkit.flush(turn.cardId)
      expect(sentRawTexts).toHaveLength(1)
      // 合并调和(取舍):同前例 —— 上游通知附响应原文(snapshot rejected);
      // 本地冻结文案为分类摘要(code+操作类别),按合并实现对齐。
      expect(sentRawTexts[0]).toContain('不是卡片元素上限')
      expect(sentRawTexts[0]).toContain('code=300121')
    } finally { globalThis.fetch = normalFetch; session.stopFooterStatus(turn); await cardkit.dispose(turn.cardId); session.dispose() }
  })
})

describe('Session Claude task live panel (task_board_live)', () => {
  test('native SDK task calls render creation and every status update in one live panel', async () => {
    const session = new Session('claude-tasks', 'chat_id') as any
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'max' }) as any
    session.proc = proc
    session.wireProc(proc)
    session.currentTurn = turnState('card_claude_tasks')
    cardkit.recordCardCreated('card_claude_tasks', 1)
    let index = 0
    const task = async (name: string, input: any, content: string) => {
      const id = `task-call-${index++}`
      proc.handleMessage({ type: 'assistant', parent_tool_use_id: null,
        message: { content: [{ type: 'tool_use', id, name, input }] } })
      proc.handleMessage({ type: 'user', parent_tool_use_id: null,
        message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } })
      await cardkit.flush('card_claude_tasks')
      const writes = calls.filter(call => call.method === 'PUT'
        && call.path === '/cards/card_claude_tasks/elements/task_board_live')
      return JSON.parse(writes.at(-1)!.body.element)
    }
    try {
      await task('TaskCreate', { subject: '验证任务创建' }, 'Task #1 created successfully: 验证任务创建')
      const created = await task('TaskCreate', { subject: '验证任务完成' }, 'Task #2 created successfully: 验证任务完成')
      expect(created.expanded).toBe(true)
      expect(created.elements[0].content).toContain('- ⬜ 验证任务创建')
      expect(created.elements[0].content).toContain('- ⬜ 验证任务完成')

      const running = await task('TaskUpdate', { taskId: '1', status: 'in_progress' }, 'Updated task #1 status')
      expect(running.elements[0].content).toContain('- 🔄 验证任务创建')
      await task('TaskList', {}, '#1 [in_progress] 验证任务创建\n#2 [pending] 验证任务完成')
      await task('TaskUpdate', { taskId: '1', status: 'completed' }, 'Updated task #1 status')
      await task('TaskUpdate', { taskId: '2', status: 'in_progress' }, 'Updated task #2 status')
      const completed = await task('TaskUpdate', { taskId: '2', status: 'completed' }, 'Updated task #2 status')
      expect(completed.elements[0].content).toContain('- ✅ 验证任务创建')
      expect(completed.elements[0].content).toContain('- ✅ 验证任务完成')
      expect(session.taskBoard.map((entry: any) => entry.status)).toEqual(['completed', 'completed'])
      const liveAdds = calls.filter(call => call.method === 'POST'
        && call.path === '/cards/card_claude_tasks/elements'
        && String(call.body?.elements).includes('"task_board_live"'))
      expect(liveAdds).toHaveLength(1)
      expect(liveAdds[0].body.target_element_id).toBe('footer')
    } finally {
      session.stopFooterStatus(session.currentTurn)
      await cardkit.dispose('card_claude_tasks')
    }
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

describe('Session codex plan live panel (plan_live)', () => {
  test('turn/plan/updated 首次建立 plan_live(无任务总览 → footer 正前),后续原地 replace,最新计划始终在卡末', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-session-1')
    session.proc = proc
    session.wireProc(proc)
    session.currentTurn = turnState('card_plan_live')
    session.currentTurn.planLiveInserted = false
    cardkit.recordCardCreated('card_plan_live', 1)

    try {
      const plan1 = { explanation: '第一版', plan: [{ step: '探查', status: 'inProgress' }] }
      proc.emit('turn_plan_updated', plan1)
      await cardkit.flush('card_plan_live')

      // 首次:建立 plan_live(insert_before footer)+ timeline 快照 plan_update_0
      const addLive = calls.find(c =>
        c.method === 'POST' && c.path === '/cards/card_plan_live/elements' &&
        String(c.body?.elements ?? '').includes('"plan_live"'))
      expect(addLive).toBeDefined()
      expect(addLive?.body.target_element_id).toBe('footer')
      expect(session.currentTurn.planLiveInserted).toBe(true)

      const plan2 = { explanation: '第二版', plan: [
        { step: '探查', status: 'completed' },
        { step: '接入', status: 'inProgress' },
      ] }
      proc.emit('turn_plan_updated', plan2)
      await cardkit.flush('card_plan_live')

      // 后续:PUT 原地 replace plan_live(元素数不增),内容是最新的第二版
      const putLive = calls.filter(c =>
        c.method === 'PUT' && c.path === '/cards/card_plan_live/elements/plan_live')
      expect(putLive.length).toBe(1)
      const addLiveAll = calls.filter(c =>
        c.method === 'POST' && c.path === '/cards/card_plan_live/elements' &&
        String(c.body?.elements ?? '').includes('"plan_live"'))
      expect(addLiveAll).toHaveLength(1)
      const replaced = JSON.parse(putLive[0].body.element)
      expect(replaced.expanded).toBe(true)
      expect(replaced.elements[0].content).toContain('- ✅ 探查')
      expect(replaced.elements[0].content).toContain('- 🔄 接入')
      expect(replaced.header.title.content).toBe('📋 当前计划 · 2 项 · 1 进行中 · 1 完成')

      // timeline 快照照旧累积(过程记录),且 insert_before plan_live(不被顶走);
      // header 带更新序号的是快照,live 面板 header 无序号
      const snapshotAdds = calls.filter(c =>
        c.method === 'POST' && c.path === '/cards/card_plan_live/elements' &&
        String(c.body?.elements ?? '').includes('plan_update_'))
      expect(snapshotAdds).toHaveLength(2)
      expect(snapshotAdds.every(c => c.body.target_element_id === 'plan_live')).toBe(true)
    } finally {
      session.stopFooterStatus(session.currentTurn)
      await cardkit.dispose('card_plan_live')
    }
  })

  test('已有任务总览时首插 insert_before task_board_live(任务总览仍紧贴 footer),快照锚点指向 plan_live', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-session-1')
    session.proc = proc
    session.wireProc(proc)
    const turn = turnState('card_anchor')
    turn.taskLiveInserted = true
    session.currentTurn = turn
    cardkit.recordCardCreated('card_anchor', 1)

    try {
      proc.emit('turn_plan_updated', { explanation: null, plan: [{ step: 'x', status: 'pending' }] })
      await cardkit.flush('card_anchor')

      // 首插落在任务总览正上,不占 footer 正前(锚点链 [plan_live][task_board_live][footer])
      const addLive = calls.find(c =>
        c.method === 'POST' && c.path === '/cards/card_anchor/elements' &&
        String(c.body?.elements ?? '').includes('"plan_live"'))
      expect(addLive?.body.target_element_id).toBe('task_board_live')
      expect(turn.planLiveInserted).toBe(true)
      // 建立后锚点指向 plan_live:timeline 快照 insert_before plan_live
      const snapshotAdd = calls.find(c =>
        c.method === 'POST' && c.path === '/cards/card_anchor/elements' &&
        String(c.body?.elements ?? '').includes('plan_update_'))
      expect(snapshotAdd?.body.target_element_id).toBe('plan_live')
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose('card_anchor')
    }
  })

  test('空 plan 数组不建立 live 面板,也不把已建立的刷成占位', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-session-1')
    session.proc = proc
    session.wireProc(proc)
    session.currentTurn = turnState('card_plan_empty')
    cardkit.recordCardCreated('card_plan_empty', 1)

    try {
      // 首次就是空数组 → 不建立
      proc.emit('turn_plan_updated', { explanation: null, plan: [] })
      await cardkit.flush('card_plan_empty')
      expect(session.currentTurn.planLiveInserted).toBe(false)
      expect(calls.some(c =>
        c.method === 'POST' && c.path === '/cards/card_plan_empty/elements' &&
        String(c.body?.elements ?? '').includes('plan_live'))).toBe(false)

      // 畸形(非数组)plan 同样零动作
      proc.emit('turn_plan_updated', { explanation: null, plan: 'not-an-array' })
      await cardkit.flush('card_plan_empty')
      expect(session.currentTurn.planLiveInserted).toBe(false)

      // 空数组首次 → 未建立;有效更新 → 此时才建立(POST add,内容含有效步骤)
      proc.emit('turn_plan_updated', { explanation: '有效', plan: [{ step: '有效步骤', status: 'inProgress' }] })
      await cardkit.flush('card_plan_empty')
      expect(session.currentTurn.planLiveInserted).toBe(true)
      const addLive = calls.filter(c =>
        c.method === 'POST' && c.path === '/cards/card_plan_empty/elements' &&
        String(c.body?.elements ?? '').includes('"plan_live"'))
      expect(addLive).toHaveLength(1)
      expect(addLive[0].body.elements).toContain('有效步骤')

      // 建立后再来空更新 → 不 replace,上次有效计划保留(0 条 PUT)
      proc.emit('turn_plan_updated', { explanation: null, plan: [] })
      await cardkit.flush('card_plan_empty')
      const putLive = calls.filter(c =>
        c.method === 'PUT' && c.path === '/cards/card_plan_empty/elements/plan_live')
      expect(putLive).toHaveLength(0)
    } finally {
      session.stopFooterStatus(session.currentTurn)
      await cardkit.dispose('card_plan_empty')
    }
  })

  test('startMidTurnRotate 换卡后按 planLiveInserted 在新卡重建 plan_live(任务总览正上)', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-session-1')
    session.proc = proc
    session.wireProc(proc)
    const turn = turnState('card_rotate_live')
    turn.planLiveInserted = true
    turn.taskLiveInserted = true
    turn.planSteps = [{ step: '重建后仍在', status: 'inProgress' }]
    turn.planExplanation = '换卡重建'
    session.currentTurn = turn
    cardkit.recordCardCreated('card_rotate_live', 1)

    try {
      session.startMidTurnRotate(turn)
      await turn.rotating
      const newCardId = turn.cardId
      expect(newCardId).not.toBe('card_rotate_live')
      await cardkit.flush(newCardId)

      // 新卡重建:plan_live insert_before task_board_live(任务总览正上、顺序与首建一致)
      const rebuildLive = calls.filter(c =>
        c.method === 'POST' && c.path === `/cards/${newCardId}/elements` &&
        String(c.body?.elements ?? '').includes('"plan_live"'))
      expect(rebuildLive).toHaveLength(1)
      expect(rebuildLive[0].body.target_element_id).toBe('task_board_live')
      expect(rebuildLive[0].body.elements).toContain('重建后仍在')
      // flag 不因换卡重置,后续 plan 更新继续走 replace 路径
      expect(turn.planLiveInserted).toBe(true)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test.each([false, true])('a transient live footer failure recovers without pausing clocks (consumed UUID: %s)', async consumedUuid => {
    const session = new Session('footer-transient-miss', 'chat_id') as any
    const turn = turnState('card_footer_transient_miss')
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1, (code, failure) => {
      session.onCardWriteFailure(turn.cardId, code, failure)
    })
    const proxyEnv = Object.fromEntries([
      'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
    ].map(key => [key, process.env[key]]))
    // Keep the mocked fetch independent of system proxy discovery and Bun's direct dispatcher.
    for (const key of Object.keys(proxyEnv)) process.env[key] = /no_proxy/i.test(key) ? '*' : ''
    const retryDelays: number[] = []
    let now = Date.now()
    const clockSpy = spyOn(Date, 'now').mockImplementation(() => now)
    const originalSetTimeout = globalThis.setTimeout
    const timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: any, delay: number, ...args: any[]) => {
      if ([3000, 4000, 5000, 8000, 15000, 60000].includes(delay)) {
        retryDelays.push(delay)
        now += delay
        return originalSetTimeout(callback, 0, ...args)
      }
      return originalSetTimeout(callback, delay, ...args)
    }) as typeof setTimeout)
    let footerAttempts = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (method === 'PUT' && path === `/cards/${turn.cardId}/elements/footer`) {
        footerAttempts++
        if (footerAttempts === 1) {
          return new Response(JSON.stringify({ code: 300308, msg: 'Server Internal Error' }), {
            headers: { 'Content-Type': 'application/json' },
          })
        }
        if (consumedUuid && footerAttempts === 2) {
          return Response.json({ code: 200770, msg: 'ErrMsg: this UUID has been recently consumed;' })
        }
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      session.startThinkingFooter(turn)
      await cardkit.flush(turn.cardId)
      await waitUntil(() => !turn.footerStatusWriteCardId)
      expect(footerAttempts).toBe(consumedUuid ? 3 : 2)
      expect(retryDelays).toEqual(consumedUuid ? [3000, 8000] : [3000])
      expect(turn.footerStatusFailedCardId).not.toBe(turn.cardId)
      expect(turn.footerStatusHandle).not.toBeNull()
      expect(sentRawTexts).toHaveLength(0)
      expect(turn.cardWriteFailureNotices.size).toBe(0)

      session.startWritingFooter(turn)
      await cardkit.flush(turn.cardId)
      expect(footerAttempts).toBe(consumedUuid ? 4 : 3)
      expect(sentRawTexts).toHaveLength(0)
      expect(turn.cardWriteFailureNotices.size).toBe(0)
    } finally {
      session.stopFooterStatus(turn)
      try { await cardkit.dispose(turn.cardId) }
      finally {
        timeoutSpy.mockRestore()
        clockSpy.mockRestore()
        for (const [key, value] of Object.entries(proxyEnv)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
    }
  })
})

describe('Session card outage backpressure', () => {
  test('slow live writes coalesce phase changes and cannot queue behind a terminal footer', async () => {
    const session = new Session('slow-footer', 'chat_id') as any
    const turn = turnState('card_slow_footer')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)
    const baseFetch = globalThis.fetch
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let writes = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/elements/footer') && ++writes === 1) await gate
      return baseFetch(input, init)
    }) as typeof fetch
    try {
      session.startThinkingFooter(turn)
      await waitUntil(() => writes === 1)
      for (let i = 0; i < 20; i++) {
        session.startWorkingFooter(turn)
        session.startWritingFooter(turn)
      }
      const closed = session.closeTurnCard(undefined, { hasFreshResult: false })
      release()
      await closed
      expect(writes).toBe(2) // initial live write + final checked transaction
      expect(turn.footerStatusHandle).toBeNull()
      const footers = calls.filter(call => call.path.endsWith('/elements/footer'))
      expect(JSON.parse(footers.at(-1)!.body.element).content).toContain('✅')
      expect(cardkit.isDisposed(turn.cardId)).toBe(true)
    } finally {
      release()
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test.each([300308, 200770])('live footer failures stay silent without blocking body or final state (code: %s)', async code => {
    const cfg = config as any
    const previousRuntime = cfg.runtime
    cfg.runtime = { ...(previousRuntime ?? {}), live_elapsed: 'second' }
    const session = new Session('footer-outage', 'chat_id') as any
    const turn = turnState('card_footer_outage')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1, (code, failure) => session.onCardWriteFailure(turn.cardId, code, failure))
    const proxyEnv = Object.fromEntries([
      'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
    ].map(key => [key, process.env[key]]))
    // Keep the mocked fetch independent of system proxy discovery and Bun's direct dispatcher.
    for (const key of Object.keys(proxyEnv)) process.env[key] = /no_proxy/i.test(key) ? '*' : ''
    const retryDelays: number[] = []
    let now = Date.now()
    const clockSpy = spyOn(Date, 'now').mockImplementation(() => now)
    const originalSetTimeout = globalThis.setTimeout
    const timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: any, delay: number, ...args: any[]) => {
      if ([3000, 4000, 5000, 8000, 15000, 60000].includes(delay)) {
        retryDelays.push(delay)
        now += delay
        return originalSetTimeout(callback, 0, ...args)
      }
      return originalSetTimeout(callback, delay, ...args)
    }) as typeof setTimeout)
    const baseFetch = globalThis.fetch
    let rejectFooter = true
    let attempts = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/elements/footer')) {
        attempts++
        const consumed = code === 200770 && attempts % 2 === 0
        if (rejectFooter) return Response.json({
          code: consumed ? 200770 : 300308,
          msg: consumed ? 'this UUID has been recently consumed' : 'Server Internal Error',
        }, {
          headers: { 'x-tt-logid': `outage-${attempts}` },
        })
      }
      return baseFetch(input, init)
    }) as typeof fetch
    try {
      session.startThinkingFooter(turn)
      await cardkit.flush(turn.cardId)
      await waitUntil(() => turn.footerStatusFailedCardId === turn.cardId)
      const failedAttempts = 6
      expect(attempts).toBe(failedAttempts)
      expect(retryDelays).toEqual([3000, 8000, 15000, 15000, 15000, 4000])
      expect(turn.footerStatusHandle).toBeNull()
      expect(sentRawTexts).toHaveLength(0)
      expect(turn.cardWriteFailureNotices.size).toBe(0)
      session.startThinkingFooter(turn)
      await cardkit.flush(turn.cardId)
      expect(attempts).toBe(failedAttempts)
      expect(await cardkit.addElementChecked(turn.cardId, {
        tag: 'markdown', element_id: 'body_after_clock_failure', content: '正文仍然可以写入',
      })).toBe(true)
      rejectFooter = false
      session.startWorkingFooter(turn)
      await cardkit.flush(turn.cardId)
      await waitUntil(() => !turn.footerStatusWriteCardId)
      expect(attempts).toBe(failedAttempts + 1)
      expect(turn.footerStatusHandle).toBeNull()
      expect(JSON.parse(calls.filter(call => call.path.endsWith('/elements/footer')).at(-1)!.body.element).content)
        .toContain('Working...')
      await session.closeTurnCard(undefined, { hasFreshResult: false })
      expect(attempts).toBe(failedAttempts + 2)
      expect(cardkit.isDisposed(turn.cardId)).toBe(true)
      expect(sentRawTexts).toHaveLength(0)
    } finally {
      session.stopFooterStatus(turn)
      if (previousRuntime === undefined) delete cfg.runtime
      else cfg.runtime = previousRuntime
      try { await cardkit.dispose(turn.cardId) }
      finally {
        timeoutSpy.mockRestore()
        clockSpy.mockRestore()
        for (const [key, value] of Object.entries(proxyEnv)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
    }
  }, 15_000)

  test('a retired card clock failure cannot pause the replacement card', async () => {
    const session = new Session('retired-footer', 'chat_id') as any
    const turn = turnState('card_retired_footer')
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)
    cardkit.recordCardCreated('card_new_footer', 1)
    const baseFetch = globalThis.fetch
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let started = false
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/cards/card_retired_footer/elements/footer')) {
        started = true
        await gate
        return Response.json({ code: 300121, msg: 'element rejected' })
      }
      return baseFetch(input, init)
    }) as typeof fetch
    try {
      session.startThinkingFooter(turn)
      await waitUntil(() => started)
      session.stopFooterStatus(turn)
      turn.cardId = 'card_new_footer'
      session.startWorkingFooter(turn)
      await cardkit.flush(turn.cardId)
      release()
      await cardkit.flush('card_retired_footer')
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(turn.footerStatusFailedCardId).toBeUndefined()
      expect(turn.footerStatusLabel).toBe('Working...')
      expect(sentRawTexts).toHaveLength(0)
    } finally {
      release()
      session.stopFooterStatus(turn)
      await cardkit.dispose('card_retired_footer')
      await cardkit.dispose(turn.cardId)
    }
  })

  test('status card clocks pause silently after failure but still commit the final status', async () => {
    const session = new Session('status-footer-outage', 'chat_id') as any
    const baseFetch = globalThis.fetch
    let rejectFooter = true
    let attempts = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/elements/footer')) {
        attempts++
        if (rejectFooter) return Response.json({ code: 300121, msg: 'element rejected' })
      }
      return baseFetch(input, init)
    }) as typeof fetch
    const handle = await session.openStatusCard('状态操作', '进行中')
    try {
      await cardkit.flush(handle.cardId)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(sentRawTexts).toHaveLength(0)
      session.setStatusCard(handle, '进行中')
      await cardkit.flush(handle.cardId)
      expect(attempts).toBe(1)
      rejectFooter = false
      session.setStatusCard(handle, '新进度')
      await cardkit.flush(handle.cardId)
      expect(attempts).toBe(2)
      await session.closeStatusCard(handle, '完成')
      expect(attempts).toBe(3)
      expect(cardkit.isDisposed(handle.cardId)).toBe(true)
      expect(sentRawTexts).toHaveLength(0)
    } finally {
      handle.timer.stop()
      await cardkit.dispose(handle.cardId)
    }
  })
})

describe('Session lifecycle reliability', () => {
  test('daemon recovery finishes the saved thread initialization before delivering a queued message', async () => {
    const session = new Session('daemon-restore-input', 'chat_id') as any
    const ref = { provider: 'codex' as const, sessionId: 'saved-thread', cwd: session.workDir }
    session.selectedProvider = 'codex'
    // Match the source-less fake process, independently of registry test order.
    session.selectedTokenSourceId = null
    session.lastSessionRef = ref
    session.lastSessionId = ref.sessionId
    let releaseInit!: () => void
    let spawned!: () => void
    const spawnReady = new Promise<void>(resolve => { spawned = resolve })
    const proc = new FakeAgentProc('codex', ref.sessionId)
    proc.launchKind = 'resume'
    proc.initialization = new Promise<void>(resolve => { releaseInit = resolve })
    let spawnCount = 0
    session.spawnAgent = (source: unknown) => {
      expect(source).toEqual(ref)
      spawnCount++
      spawned()
      return proc
    }

    const restoration = session.restoreAfterDaemonRestart()
    await spawnReady
    const message = session.onUserMessage('重启期间收到的消息')
    await Promise.resolve()
    expect(proc.sentTexts).toEqual([])
    expect(session.shouldRevive()).toBe(true)
    proc.emit('init', { session_id: ref.sessionId })
    releaseInit()
    try {
      expect(await restoration).toBe(true)
      await message
      expect(spawnCount).toBe(1)
      expect(proc.killCalls).toBe(0)
      // 合并调和(取舍):本地投递 pin(dispatchHumanBatch)不承担上游
      // sendClaimedUserText 的「未登记 proc 首投」规则注入 — spawn 的
      // developerInstructions 已给约定,仅真实模式变更才注入更新。proc 由
      // 测试 spawnAgent 覆写直给,未 pre-seed,断言用户原文。
      expect(proc.sentTexts).toEqual(['重启期间收到的消息'])
      expect(session.lastSessionId).toBe(ref.sessionId)
    } finally {
      await session.stop('测试收尾', { announce: false })
    }
  })

  test.each(['codex', 'claude', 'dsh'] as const)('failed %s daemon recovery blocks queued input and preserves the resume point until an explicit retry', async provider => {
    const session = new Session(`daemon-restore-failure-${provider}`, 'chat_id') as any
    const ref = { provider, sessionId: 'saved-thread', cwd: session.workDir }
    session.selectedProvider = provider
    if (provider === 'dsh') session.selectedEffort = 'off'
    session.lastSessionRef = ref
    session.lastSessionId = ref.sessionId
    resumeRefs.set(`${session.sessionName}:${provider}`, ref)
    let fail = true
    let spawnCount = 0
    session.spawnAgent = () => { spawnCount++; return new FakeAgentProc(provider, ref.sessionId) }
    const init = async () => fail
      ? { state: 'error', error: new Error('resume transport failed') }
      : { state: 'init' }
    session.waitForCodexInitialization = init
    session.waitForProcEarlyFailure = init

    expect(await session.restoreAfterDaemonRestart()).toBe(false)
    expect(session.shouldRevive()).toBe(true)
    await session.onUserMessage('不得开启新会话')
    expect(spawnCount).toBe(1)
    expect(session.proc).toBeNull()
    expect(session.lastSessionId).toBe(ref.sessionId)
    expect(resumeRefs.get(`${session.sessionName}:${provider}`)).toEqual(ref)
    expect(sentTexts.join('\n')).toContain('这条消息未送给 Agent')
    expect(clearedResumes).toEqual([])

    fail = false
    expect(await session.restart(true, { announce: false })).toBe(true)
    expect(session.daemonRestoreRequired).toBe(false)
    expect(session.lastSessionId).toBe(ref.sessionId)
    await session.stop('测试收尾', { announce: false })
    expect(session.shouldRevive()).toBe(false)
  })

  test('daemon recovery without a resume point never creates a fresh conversation implicitly', async () => {
    const session = new Session('daemon-restore-missing', 'chat_id') as any
    let spawns = 0
    session.spawnAgent = () => { spawns++; return new FakeAgentProc('codex') }
    expect(await session.restoreAfterDaemonRestart()).toBe(false)
    await session.onUserMessage('不得创建新会话')
    expect(spawns).toBe(0)
    expect(session.shouldRevive()).toBe(true)
    await session.stop('用户明确停止', { announce: false })
    expect(session.shouldRevive()).toBe(false)
  })

  test('explicit fresh start clears a failed daemon recovery guard', async () => {
    const session = new Session('daemon-restore-fresh', 'chat_id') as any
    session.selectedProvider = 'codex'
    expect(await session.restoreAfterDaemonRestart()).toBe(false)
    const proc = new FakeAgentProc('codex', 'new-thread')
    proc.launchKind = 'fresh'
    session.spawnAgent = () => proc
    expect(await session.start({ announce: false })).toBe(true)
    expect(session.daemonRestoreRequired).toBe(false)
    await session.stop('测试收尾', { announce: false })
  })

  test('the outer initialization guard allows a ten-minute materialization read to finish', async () => {
    const session = new Session('daemon-restore-slow', 'chat_id') as any
    let now = 0
    let nextId = 1
    const timers = new Map<number, { due: number; callback: () => void }>()
    const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number) => {
      const id = nextId++
      timers.set(id, { due: now + delay, callback })
      return id as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout)
    const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(((id: number) => { timers.delete(id) }) as typeof clearTimeout)
    let ready!: () => void
    const initialization = new Promise<void>(resolve => { ready = resolve })
    let outcome: unknown = null
    let notices = 0
    try {
      const waiting = session.waitForCodexInitialization(initialization, () => { notices++ })
      void waiting.then((result: unknown) => { outcome = result })
      for (const elapsed of [120_000, 660_000]) {
        now = elapsed
        for (const [id, timer] of timers) {
          if (timer.due > now) continue
          timers.delete(id)
          timer.callback()
        }
        await Promise.resolve()
        expect(outcome).toBeNull()
      }
      ready()
      expect(await waiting).toEqual({ state: 'init', error: undefined })
      expect(notices).toBe(1)
      expect(timers.size).toBe(0)
    } finally {
      timeout.mockRestore()
      clear.mockRestore()
    }
  })

  test('Codex init timeout is a failed start and never reports ready', async () => {
    const session = new Session('codex-timeout', 'chat_id') as any
    const proc = new FakeAgentProc('codex', null)
    const statuses: string[] = []
    session.selectedProvider = 'codex'
    session.spawnAgent = () => proc
    session.waitForCodexInitialization = async () => ({ state: 'timeout' })

    const ok = await session.start({
      announce: false,
      onStatus: (status: string) => statuses.push(status),
    })

    expect(ok).toBe(false)
    expect(proc.killCalls).toBe(1)
    expect(session.proc).toBeNull()
    expect(session.status).toBe('stopped')
    expect(statuses.some(status => status.includes('启动超时'))).toBe(true)
    expect(statuses.some(status => status.includes('720 秒'))).toBe(true)
    expect(statuses.some(status => status.includes('已就绪'))).toBe(false)
  })

  test('Codex initialization rejection surfaces the method-specific error instead of the outer timeout', async () => {
    const session = new Session('codex-init-error', 'chat_id') as any
    const proc = new FakeAgentProc('codex', null)
    proc.initialization = Promise.reject(new Error(
      'codex app-server thread/start request timed out after 30000ms (id=2)',
    ))
    const statuses: string[] = []
    session.selectedProvider = 'codex'
    session.spawnAgent = () => proc

    const ok = await session.start({
      announce: false,
      onStatus: (status: string) => statuses.push(status),
    })

    expect(ok).toBe(false)
    expect(proc.killCalls).toBe(1)
    expect(statuses.join('\n')).toContain('thread/start request timed out after 30000ms (id=2)')
    expect(statuses.join('\n')).not.toContain('启动超时')
    expect(statuses.join('\n')).not.toContain('已就绪')
  })

  test('Codex init failure also exposes an unconfirmed process termination', async () => {
    const session = new Session('codex-init-kill-fails', 'chat_id') as any
    const proc = new FakeAgentProc('codex', null)
    proc.initialization = Promise.reject(new Error('thread/start transport failed'))
    proc.kill = async () => {
      proc.killCalls++
      throw new Error('kill timeout')
    }
    session.selectedProvider = 'codex'
    session.spawnAgent = () => proc
    const statuses: string[] = []

    const ok = await session.start({
      announce: false,
      onStatus: (status: string) => statuses.push(status),
    })

    expect(ok).toBe(false)
    expect(session.blockedProc).toBe(proc)
    expect(statuses.join('\n')).toContain('thread/start transport failed')
    expect(statuses.join('\n')).toContain('进程终止未确认: kill timeout')

    proc.alive = false
    proc.emit('exit', { code: null, signal: 'SIGKILL', expected: true })
  })

  test('confirmed no-rollout resume failure invalidates only the matching legacy ghost binding', async () => {
    const session = new Session('codex-ghost-resume', 'chat_id') as any
    const ghostId = '0198d6fa-1234-7000-8000-000000000001'
    const ghostRef = { provider: 'codex' as const, sessionId: ghostId, cwd: session.workDir }
    session.selectedProvider = 'codex'
    session.lastSessionRef = ghostRef
    session.lastSessionId = ghostRef.sessionId
    resumeRefs.set(`${session.sessionName}:codex`, ghostRef)
    const proc = new FakeAgentProc('codex', null)
    proc.launchKind = 'resume'
    proc.initialization = Promise.reject(new CodexRpcResponseError(
      'thread/resume', 2, -32600, `no rollout found for thread id ${ghostId}`,
    ))
    session.spawnAgent = () => proc
    const statuses: string[] = []

    const ok = await session.restart(true, {
      announce: false,
      onStatus: (status: string) => statuses.push(status),
    })

    expect(ok).toBe(false)
    expect(proc.killCalls).toBe(1)
    expect(clearedResumes).toContainEqual([session.sessionName, 'codex'])
    expect(resumeRefs.has(`${session.sessionName}:codex`)).toBe(false)
    expect(session.lastSessionRef).toBeNull()
    expect(session.lastSessionId).toBeNull()
    expect(statuses.join('\n')).toContain(`no rollout found for thread id ${ghostId}`)
    expect(statuses.join('\n')).toContain('已作废无 rollout 的恢复点')
  })

  test('unrelated or mismatched Codex resume errors never clear a binding', () => {
    const session = new Session('codex-resume-keep', 'chat_id') as any
    const currentId = '0198d6fa-1234-7000-8000-000000000010'
    const olderId = '0198d6fa-1234-7000-8000-000000000011'
    const ref = { provider: 'codex' as const, sessionId: currentId, cwd: session.workDir }
    session.selectedProvider = 'codex'
    session.lastSessionRef = ref
    session.lastSessionId = ref.sessionId
    resumeRefs.set(`${session.sessionName}:codex`, ref)

    expect(session.invalidateMissingCodexResume(
      ref.sessionId,
      new Error('codex app-server thread/resume failed: account unavailable'),
    )).toBeNull()
    expect(session.invalidateMissingCodexResume(
      ref.sessionId,
      new CodexRpcResponseError(
        'thread/resume', 2, -32600, `no rollout found for thread id ${olderId}`,
      ),
    )).toBeNull()
    expect(session.invalidateMissingCodexResume(
      ref.sessionId,
      new CodexRpcResponseError(
        'thread/resume', 3, -32000, `no rollout found for thread id ${currentId}`,
      ),
    )).toBeNull()
    expect(session.invalidateMissingCodexResume(
      ref.sessionId,
      new CodexRpcResponseError(
        'thread/resume', 4, -32600, `prefix: no rollout found for thread id ${currentId}`,
      ),
    )).toBeNull()

    expect(clearedResumes).toEqual([])
    expect(resumeRefs.get(`${session.sessionName}:codex`)).toEqual(ref)
    expect(session.lastSessionId).toBe(ref.sessionId)
  })

  test('legacy cwd-null ghost binding is invalidated during thread/read migration', async () => {
    const session = new Session('codex-legacy-ghost', 'chat_id') as any
    const ghostId = '0198d6fa-1234-7000-8000-000000000099'
    const ghostRef = { provider: 'codex' as const, sessionId: ghostId, cwd: null }
    session.selectedProvider = 'codex'
    session.lastSessionRef = ghostRef
    session.lastSessionId = ghostId
    resumeRefs.set(`${session.sessionName}:codex`, ghostRef)
    session.resolveLegacyResumeRef = async () => {
      const readError = new CodexRpcResponseError(
        'thread/read', 2, -32600, `no rollout found for thread id ${ghostId}`,
      )
      const cleanupError = new Error('catalog kill timeout')
      throw new AggregateError(
        [readError, cleanupError],
        `Codex legacy resume lookup and cleanup failed: read=${readError.message}; cleanup=${cleanupError.message}`,
      )
    }
    let spawnCalls = 0
    session.spawnAgent = () => { spawnCalls++; return new FakeAgentProc('codex') }
    const statuses: string[] = []

    const ok = await session.restart(true, {
      announce: false,
      onStatus: (status: string) => statuses.push(status),
    })

    expect(ok).toBe(false)
    expect(spawnCalls).toBe(0)
    expect(clearedResumes).toContainEqual([session.sessionName, 'codex'])
    expect(session.lastSessionRef).toBeNull()
    expect(session.lastSessionId).toBeNull()
    expect(statuses.join('\n')).toContain('旧会话不可恢复')
    expect(statuses.join('\n')).toContain('已作废无 rollout 的恢复点')
    expect(statuses.join('\n')).toContain('catalog kill timeout')
  })

  test('serializes concurrent restarts so a kill completes before either replacement spawn', async () => {
    const session = new Session('restart-race', 'chat_id') as any
    const initial = new FakeAgentProc('claude', 'session-initial')
    session.proc = initial
    session.selectedProvider = 'claude'
    session.waitForProcEarlyFailure = async () => ({ state: 'ready' })

    let releaseInitialKill: () => void = () => {}
    const initialKillGate = new Promise<void>(resolve => { releaseInitialKill = resolve })
    initial.kill = async () => {
      initial.killCalls++
      await initialKillGate
      initial.alive = false
      initial.emit('exit', { code: 0, signal: null, expected: true })
    }

    const spawned: FakeAgentProc[] = []
    const aliveAtSpawn: number[] = []
    session.spawnAgent = () => {
      aliveAtSpawn.push([initial, ...spawned].filter(proc => proc.alive).length)
      const proc = new FakeAgentProc('claude', `session-${spawned.length + 1}`)
      spawned.push(proc)
      return proc
    }

    const first = session.restart(false, { announce: false })
    const second = session.restart(false, { announce: false })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(initial.killCalls).toBe(1)
    expect(spawned).toHaveLength(0)
    releaseInitialKill()

    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(aliveAtSpawn).toEqual([0, 0])
    expect(spawned).toHaveLength(2)
    expect(spawned[0].killCalls).toBe(1)
    expect(spawned.filter(proc => proc.alive)).toEqual([spawned[1]])
    expect(session.proc).toBe(spawned[1])

    await session.stop('测试收尾', { announce: false })
  })

  test('restart freezes a Codex conversation that materializes while the old process is stopping', async () => {
    const session = new Session('restart-materialize-race', 'chat_id') as any
    session.selectedProvider = 'codex'
    const oldProc = new FakeAgentProc('codex', 'materialized-thread')
    oldProc.launchKind = 'fresh'
    oldProc.conversationResumable = false
    session.proc = oldProc
    session.wireProc(oldProc)
    oldProc.kill = async () => {
      oldProc.killCalls++
      oldProc.conversationResumable = true
      oldProc.emit('conversation_materialized', {
        session_id: oldProc.sessionId,
        source: 'turn/started notification',
      })
      oldProc.alive = false
      oldProc.emit('exit', { code: 0, signal: null, expected: true })
    }
    let resumedRef: any = null
    session.spawnAgent = (ref: any) => {
      resumedRef = ref
      const replacement = new FakeAgentProc('codex', ref?.sessionId ?? null)
      replacement.launchKind = 'resume'
      replacement.conversationResumable = true
      return replacement
    }

    const ok = await session.restart(true, { announce: false })

    expect(ok).toBe(true)
    expect(resumedRef).toEqual({
      provider: 'codex', sessionId: 'materialized-thread', cwd: session.workDir,
    })
    expect(session.lastSessionId).toBe('materialized-thread')
    expect(resumeRefs.get(`${session.sessionName}:codex`)?.sessionId).toBe('materialized-thread')
    await session.stop('测试收尾', { announce: false })
  })

  test('restart waits an in-flight Codex materialization verification before killing its owner', async () => {
    const session = new Session('restart-materialize-barrier', 'chat_id') as any
    session.selectedProvider = 'codex'
    const oldProc = new FakeAgentProc('codex', 'verified-thread')
    oldProc.launchKind = 'fresh'
    oldProc.conversationResumable = false
    let releaseVerification: () => void = () => {}
    oldProc.materializationBarrier = new Promise<void>(resolve => { releaseVerification = resolve })
    session.proc = oldProc
    session.wireProc(oldProc)
    let resumedRef: any = null
    session.spawnAgent = (ref: any) => {
      resumedRef = ref
      const replacement = new FakeAgentProc('codex', ref?.sessionId ?? null)
      replacement.launchKind = 'resume'
      return replacement
    }

    const restarting = session.restart(true, { announce: false })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(oldProc.killCalls).toBe(0)
    session.pendingMidTurnMsgs = [{
      text: 'must not drain', wireText: 'must not drain', userOpenId: '', msgId: '',
    }]
    oldProc.emit('result', { is_error: false, checkpoint: null })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(oldProc.sentTexts).toEqual([])
    expect(session.pendingMidTurnMsgs).toHaveLength(1)

    oldProc.conversationResumable = true
    releaseVerification()
    expect(await restarting).toBe(true)
    expect(oldProc.killCalls).toBe(1)
    expect(resumedRef?.sessionId).toBe('verified-thread')
    await session.stop('测试收尾', { announce: false })
  })

  test('restart preserves an idle fresh Codex process when its only resume point cannot be verified', async () => {
    const session = new Session('restart-materialize-fails-safe', 'chat_id') as any
    session.selectedProvider = 'codex'
    session.status = 'idle'
    const proc = new FakeAgentProc('codex', 'fresh-thread')
    proc.launchKind = 'fresh'
    proc.conversationResumable = false
    proc.materializationBarrier = Promise.reject(new Error('thread/read materialization timeout'))
    session.proc = proc
    session.wireProc(proc)
    session.agentCapability = 'retained-process-capability'
    let spawnCalls = 0
    session.spawnAgent = () => { spawnCalls++; return new FakeAgentProc('codex') }
    const statuses: string[] = []

    const ok = await session.restart(true, {
      announce: false,
      onStatus: (status: string) => statuses.push(status),
    })

    expect(ok).toBe(false)
    expect(proc.killCalls).toBe(0)
    expect(spawnCalls).toBe(0)
    expect(session.proc).toBe(proc)
    expect(session.stoppingProc).toBeNull()
    expect(session.status).toBe('idle')
    expect(session.acceptsAgentCapability('retained-process-capability')).toBe(true)
    expect(statuses.join('\n')).toContain('已保留当前进程')
    proc.materializationBarrier = null
    await session.stop('测试收尾', { announce: false })
  })

  test('stop persists a verified Codex materialization that lands during SIGTERM', async () => {
    const session = new Session('stop-materialize-race', 'chat_id') as any
    session.selectedProvider = 'codex'
    const proc = new FakeAgentProc('codex', 'materialized-thread')
    proc.launchKind = 'fresh'
    proc.conversationResumable = false
    session.proc = proc
    session.wireProc(proc)
    proc.kill = async () => {
      proc.killCalls++
      proc.conversationResumable = true
      proc.emit('conversation_materialized', {
        session_id: proc.sessionId,
        source: 'turn/started notification',
      })
      proc.alive = false
      proc.emit('exit', { code: 0, signal: null, expected: true })
    }

    await session.stop('测试停止', { announce: false })

    expect(session.lastSessionId).toBe('materialized-thread')
    expect(resumeRefs.get(`${session.sessionName}:codex`)?.sessionId).toBe('materialized-thread')
  })

  test('stop fails transparently when the final materialized Codex resume point cannot fsync', async () => {
    const session = new Session('stop-materialize-fsync-fails', 'chat_id') as any
    session.selectedProvider = 'codex'
    const proc = new FakeAgentProc('codex', 'materialized-thread')
    proc.launchKind = 'fresh'
    proc.conversationResumable = false
    session.proc = proc
    session.wireProc(proc)
    proc.kill = async () => {
      proc.killCalls++
      proc.conversationResumable = true
      proc.alive = false
      proc.emit('exit', { code: 0, signal: null, expected: true })
    }
    setResumeWriteError(new Error('final resume-map fsync failed'))

    try {
      await expect(session.stop('测试停止', { announce: false })).rejects.toThrow(
        'final resume-map fsync failed',
      )
      expect(session.status).toBe('stopped')
      expect(session.proc).toBeNull()
      expect(resumeRefs.has(`${session.sessionName}:codex`)).toBe(false)
      expect(sentRawTexts.some(text => text.includes('当前进程可继续'))).toBe(false)
    } finally {
      setResumeWriteError(null)
    }
  })

  test('a blocked Codex process that materializes before its late exit still commits resume and checkpoint', async () => {
    const session = new Session('blocked-late-materialize', 'chat_id') as any
    session.selectedProvider = 'codex'
    const proc = new FakeAgentProc('codex', 'fresh-thread')
    proc.launchKind = 'fresh'
    proc.conversationResumable = false
    session.proc = proc
    session.wireProc(proc)
    const checkpoint = {
      provider: 'codex' as const,
      kind: 'turn' as const,
      id: 'turn-fast',
      source: { provider: 'codex' as const, sessionId: 'fresh-thread', cwd: session.workDir },
    }
    proc.emit('result', { is_error: false, checkpoint })
    proc.kill = async () => {
      proc.killCalls++
      throw new Error('kill timeout')
    }

    await expect(session.stop('测试停止', { announce: false })).rejects.toThrow('kill timeout')
    expect(session.blockedProc).toBe(proc)
    proc.conversationResumable = true
    proc.alive = false
    proc.emit('exit', { code: null, signal: 'SIGKILL', expected: true })

    expect(session.proc).toBeNull()
    expect(resumeRefs.get(`${session.sessionName}:codex`)?.sessionId).toBe('fresh-thread')
    expect(turnAnchorsBySession.get(session.sessionName)?.[0]?.checkpoint).toEqual(checkpoint)
  })

  test('ignores late events from a replaced process generation', async () => {
    const session = new Session('stale-events', 'chat_id') as any
    const oldProc = new FakeAgentProc('claude', 'old-session')
    const currentProc = new FakeAgentProc('claude', 'current-session')
    session.attachProc(oldProc)
    session.attachProc(currentProc)
    session.initCount = 0

    oldProc.emit('init', { session_id: 'old-session' })
    oldProc.emit('assistant_text', { text: 'stale output', parentToolUseId: null })
    oldProc.emit('exit', { code: 0, signal: 'SIGTERM', expected: false })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(session.proc).toBe(currentProc)
    expect(session.initCount).toBe(0)
    expect(session.orphanAssistantCurrent).toBe('')
    expect(sentTexts.some(text => text.includes('异常退出'))).toBe(false)

    await session.stop('测试收尾', { announce: false })
  })

  test('an obsolete main-card open cannot replace a newer process turn or clear its opening owner', async () => {
    const session = new Session('stale-main-open', 'chat_id') as any
    const oldProc = new FakeAgentProc('claude', 'old-session')
    const newProc = new FakeAgentProc('claude', 'new-session')
    session.selectedProvider = 'claude'
    session.selectedTokenSourceId = null

    let releaseOldConvert: () => void = () => {}
    const oldConvertGate = new Promise<void>(resolve => { releaseOldConvert = resolve })
    let releaseNewConvert: () => void = () => {}
    const newConvertGate = new Promise<void>(resolve => { releaseNewConvert = resolve })
    let convertCount = 0
    const baseFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/cards/id_convert')) {
        const n = ++convertCount
        if (n === 1) await oldConvertGate
        if (n === 2) await newConvertGate
        return new Response(JSON.stringify({ code: 0, data: { card_id: n === 1 ? 'card_old_open' : 'card_new_open' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return baseFetch(input, init)
    }) as typeof fetch

    try {
      session.attachProc(oldProc)
      session.pendingUserMessageCount = 1
      session.pendingTurnInputs = ['old input']
      oldProc.emit('init', { session_id: 'old-session' })
      await waitUntil(() => convertCount === 1)

      session.attachProc(newProc)
      session.pendingUserMessageCount = 1
      session.pendingTurnInputs = ['new input']
      newProc.emit('init', { session_id: 'new-session' })
      await waitUntil(() => convertCount === 2)

      releaseOldConvert()
      await waitUntil(() => calls.some(call =>
        call.method === 'PATCH' && call.path === '/cards/card_old_open/settings'
      ))
      expect(session.currentTurn).toBeNull()
      expect(session.openingTurn).toBe(true)

      releaseNewConvert()
      await waitUntil(() => session.currentTurn?.cardId === 'card_new_open' && !session.openingTurn)
      expect(session.currentTurn.cardId).toBe('card_new_open')
      expect(session.proc).toBe(newProc)
    } finally {
      releaseOldConvert()
      releaseNewConvert()
      if (session.currentTurn) await session.closeTurnCard('测试收尾')
      globalThis.fetch = baseFetch
    }
  })

  test('cold reset failure never leaves a main-card opening owner behind', async () => {
    const session = new Session('cold-reset-failure', 'chat_id') as any
    session.resetFreshConversationState = () => { throw new Error('reset failed') }

    await expect(session.startColdUserTurn('hello', 'hello', 'ou_user')).rejects.toThrow('reset failed')

    expect(session.openingTurn).toBe(false)
    expect(session.openingTurnOwner).toBeNull()
    expect(sentCards).toHaveLength(0)
  })

  test('opens a mid-turn card before feeding the buffered batch and drops input on card init failure', async () => {
    const session = new Session('midturn-card-first', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.pendingMidTurnMsgs = [{
      text: 'queued input', wireText: 'queued input', userOpenId: 'ou_user', msgId: 'om_queued',
    }]
    session.pendingReactionIds = new Map([['om_queued', 'reaction_waiting']])

    const baseFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/cards/id_convert')) {
        return new Response(JSON.stringify({ code: 99, msg: 'convert failed' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return baseFetch(input, init)
    }) as typeof fetch

    try {
      await session.drainMidTurnAndOpen()

      expect(proc.sentTexts).toEqual([])
      expect(session.currentTurn).toBeNull()
      expect(session.status).toBe('idle')
      expect(sentRawTexts.join('\n')).toContain('尚未送给 Claude')
      expect(deletedReactions).toContainEqual(['om_queued', 'reaction_waiting'])
    } finally {
      globalThis.fetch = baseFetch
    }
  })

  test('unexpected exit terminalizes the main card, settles tasks, and alerts even for code=0 SIGTERM', async () => {
    const session = new Session('unexpected-exit', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'session-1')
    const turn = turnState('card_unexpected_exit')
    turn.userOpenId = ''
    session.currentTurn = turn
    session.backgroundTasks = [{
      id: 'bg-1', type: 'shell', description: 'still running', status: 'running',
      startedAt: Date.now(), steps: [],
    }]
    cardkit.recordCardCreated(turn.cardId, 1)
    session.attachProc(proc)

    proc.emit('exit', { code: 0, signal: 'SIGTERM', expected: false })
    await session.lifecycleTail

    expect(session.proc).toBeNull()
    expect(session.currentTurn).toBeNull()
    expect(session.backgroundTasks).toEqual([])
    expect(session.status).toBe('stopped')
    expect(sentTexts.some(text =>
      text.includes('异常退出') && text.includes('code=0') && text.includes('SIGTERM')
    )).toBe(true)
    const footerWrites = calls.filter(call =>
      call.method === 'PUT' && call.path === `/cards/${turn.cardId}/elements/footer`
    )
    expect(footerWrites.some(call => JSON.parse(call.body.element).content.includes('异常退出'))).toBe(true)
    expect(calls.some(call =>
      call.method === 'PATCH' && call.path === `/cards/${turn.cardId}/settings`
    )).toBe(true)
  })

  test('a three-hour turn uses hours in both the final footer and chat-list preview', async () => {
    const session = new Session('long-turn-duration', 'chat_id') as any
    const turn = turnState('card_long_turn_duration')
    turn.startedAt = Date.now() - 10_800_000
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)
    try {
      await session.closeTurnCard(undefined, { hasFreshResult: false })
      const footer = calls.find(call =>
        call.method === 'PUT' && call.path === `/cards/${turn.cardId}/elements/footer`
      )
      expect(JSON.parse(footer?.body.element ?? '{}').content).toContain('✅ ⏱ 3h')
      const settings = calls.find(call =>
        call.method === 'PATCH' && call.path === `/cards/${turn.cardId}/settings`
      )
      expect(JSON.parse(settings?.body.settings ?? '{}').config.summary.content).toBe('✅ · ⏱ 3h')
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
      session.dispose()
    }
  })

  test('keeps CardKit state and sends fallback when the terminal footer transaction misses', async () => {
    const session = new Session('terminal-miss', 'chat_id') as any
    const turn = turnState('card_terminal_miss')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    const baseFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      if (method === 'PUT' && path === `/cards/${turn.cardId}/elements/footer`) {
        calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
        return new Response(JSON.stringify({ code: 300121, msg: 'footer rejected' }), {
          headers: { 'Content-Type': 'application/json', 'x-tt-logid': 'terminal-footer-id' },
        })
      }
      return baseFetch(input, init)
    }) as typeof fetch

    try {
      await session.closeTurnCard()

      expect(sentRawTexts.join('\n')).toContain('终态写入失败')
      expect(sentRawTexts.join('\n')).toContain('footer=MISS')
      expect(sentRawTexts.join('\n')).toContain('message=footer rejected')
      expect(sentRawTexts.join('\n')).toContain('log_id=terminal-footer-id')
      // A disposed card returns false immediately. A successful repair PATCH
      // proves closeTurnCard deliberately retained the state after the miss.
      expect(await cardkit.patchSettingsChecked(turn.cardId, { config: { streaming_mode: false } })).toBe(true)
    } finally {
      globalThis.fetch = baseFetch
      await cardkit.dispose(turn.cardId)
    }
  })

  test('an old close snapshots usage and reactions without clearing the next turn', async () => {
    const session = new Session('close-snapshot', 'chat_id') as any
    const oldProc = new FakeAgentProc('codex', 'old-session')
    oldProc.lastUsage = { input_tokens: 100, output_tokens: 11, total_tokens: 111 }
    ;(oldProc as any).lastContextWindow = 1000
    session.proc = oldProc
    session.selectedProvider = 'codex'
    session.selectedTokenSourceId = null
    const oldTurn = turnState('card_close_snapshot_old')
    oldTurn.userOpenId = ''
    session.currentTurn = oldTurn
    session.lastTurnUsage = { input_tokens: 100, output_tokens: 11, total_tokens: 111 }
    session.lastTurnDelta = { tokens: 111, costUsd: 1.234, durationMs: 1000 }
    session.currentBatchReactionIds = new Map([['om_old_batch', 'rid_old_batch']])
    session.pendingReactionIds = new Map([['om_old_pending', 'rid_old_pending']])
    cardkit.recordCardCreated(oldTurn.cardId, 1)

    let signalFlushStarted: () => void = () => {}
    const flushStarted = new Promise<void>(resolve => { signalFlushStarted = resolve })
    let releaseFlush: () => void = () => {}
    const flushGate = new Promise<void>(resolve => { releaseFlush = resolve })
    const realFlush = cardkit.flush
    const flushSpy = spyOn(cardkit, 'flush').mockImplementation(async (cardId: string) => {
      if (cardId === oldTurn.cardId) {
        signalFlushStarted()
        await flushGate
      }
      await realFlush(cardId)
    })

    try {
      const closing = session.closeTurnCard(undefined, { hasFreshResult: true })
      await flushStarted

      const newProc = new FakeAgentProc('codex', 'new-session')
      newProc.lastUsage = { input_tokens: 9000, output_tokens: 999, total_tokens: 9999 }
      session.attachProc(newProc)
      const newTurn = turnState('card_close_snapshot_new')
      session.currentTurn = newTurn
      session.lastTurnUsage = { input_tokens: 9000, output_tokens: 999, total_tokens: 9999 }
      session.lastTurnDelta = { tokens: 9999, costUsd: 9.999, durationMs: 9000 }
      session.currentBatchReactionIds = new Map([['om_new_batch', 'rid_new_batch']])
      session.pendingReactionIds = new Map([['om_new_pending', 'rid_new_pending']])

      releaseFlush()
      await closing

      expect(session.currentTurn).toBe(newTurn)
      expect([...session.currentBatchReactionIds.entries()]).toEqual([['om_new_batch', 'rid_new_batch']])
      expect([...session.pendingReactionIds.entries()]).toEqual([['om_new_pending', 'rid_new_pending']])
      expect(deletedReactions).toContainEqual(['om_old_batch', 'rid_old_batch'])
      expect(deletedReactions).toContainEqual(['om_old_pending', 'rid_old_pending'])
      expect(deletedReactions).not.toContainEqual(['om_new_batch', 'rid_new_batch'])

      const footer = calls.find(call =>
        call.method === 'PUT' && call.path === `/cards/${oldTurn.cardId}/elements/footer`
      )
      const footerContent = JSON.parse(footer?.body.element ?? '{}').content as string
      expect(footerContent).toContain('$1.234')
      expect(footerContent).not.toContain('$9.999')
      const settingsCall = calls.find(call =>
        call.method === 'PATCH' && call.path === `/cards/${oldTurn.cardId}/settings`
      )
      const settings = JSON.parse(settingsCall?.body.settings ?? '{}')
      expect(settings.config.summary.content).toContain('📶 11')
      expect(settings.config.summary.content).not.toContain('999')
    } finally {
      releaseFlush()
      flushSpy.mockRestore()
      if (session.currentTurn) session.stopFooterStatus(session.currentTurn)
      session.currentTurn = null
      await cardkit.dispose(oldTurn.cardId)
    }
  })

  test('restart waits for a close that already removed currentTurn before spawning', async () => {
    const session = new Session('restart-close-owner', 'chat_id') as any
    const oldProc = new FakeAgentProc('claude', 'old-session')
    const oldTurn = turnState('card_restart_close_owner')
    oldTurn.provider = 'claude'
    oldTurn.userOpenId = ''
    session.proc = oldProc
    session.selectedProvider = 'claude'
    session.selectedTokenSourceId = null
    session.currentTurn = oldTurn
    cardkit.recordCardCreated(oldTurn.cardId, 1)

    let signalFlushStarted: () => void = () => {}
    const flushStarted = new Promise<void>(resolve => { signalFlushStarted = resolve })
    let releaseFlush: () => void = () => {}
    const flushGate = new Promise<void>(resolve => { releaseFlush = resolve })
    const realFlush = cardkit.flush
    const flushSpy = spyOn(cardkit, 'flush').mockImplementation(async (cardId: string) => {
      if (cardId === oldTurn.cardId) {
        signalFlushStarted()
        await flushGate
      }
      await realFlush(cardId)
    })
    const spawned: FakeAgentProc[] = []
    session.spawnAgent = () => {
      const proc = new FakeAgentProc('claude', `new-session-${spawned.length + 1}`)
      spawned.push(proc)
      return proc
    }
    session.waitForProcEarlyFailure = async () => ({ state: 'ready' })

    try {
      const oldClose = session.closeTurnCard('旧轮收尾')
      await flushStarted
      expect(session.currentTurn).toBeNull()

      const restarting = session.restart(false, { announce: false })
      await waitUntil(() => oldProc.killCalls === 1)
      expect(spawned).toHaveLength(0)

      releaseFlush()
      await oldClose
      expect(await restarting).toBe(true)
      expect(spawned).toHaveLength(1)
      expect(session.proc).toBe(spawned[0])
    } finally {
      releaseFlush()
      flushSpy.mockRestore()
      if (session.proc?.isAlive()) await session.stop('测试收尾', { announce: false })
      await cardkit.dispose(oldTurn.cardId)
    }
  })

  test('Claude pending precommit failure leaves the old binding untouched and never starts replacement', async () => {
    const session = new Session('rollback-anchor-commit', 'chat_id') as any
    session.selectedProvider = 'claude'
    session.selectedTokenSourceId = null
    session.lastSessionId = 'old-session'
    session.lastSessionRef = { provider: 'claude', sessionId: 'old-session', cwd: session.workDir }
    const oldAnchor = {
      checkpoint: {
        provider: 'claude', kind: 'assistant-message', id: 'assistant-old',
        source: { provider: 'claude', sessionId: 'old-session', cwd: session.workDir },
      },
      preview: 'old input', ts: 1, writes: [],
    } as any
    const nextAnchor = {
      checkpoint: {
        provider: 'claude', kind: 'assistant-message', id: 'assistant-next',
        source: { provider: 'claude', sessionId: 'source-session', cwd: session.workDir },
      },
      preview: 'next input', ts: 2, writes: [],
    } as any
    turnAnchorsBySession.set(session.sessionName, [oldAnchor])
    branchBaseBySession.set(session.sessionName, { kind: 'fresh' })

    const replacement = new FakeAgentProc('claude', 'replacement-session')
    session.restartUnlocked = async () => {
      session.proc = replacement
      session.lastSessionId = 'replacement-session'
      session.lastSessionRef = { provider: 'claude', sessionId: 'replacement-session', cwd: session.workDir }
      session.status = 'idle'
      return true
    }
    const realReplace = feishu.replaceTurnAnchors
    let replaceCalls = 0
    const replaceSpy = spyOn(feishu, 'replaceTurnAnchors').mockImplementation((sessionName, anchors, base) => {
      replaceCalls++
      if (replaceCalls === 1) throw new Error('turn-map fsync failed')
      return realReplace(sessionName, anchors, base)
    })

    try {
      await expect(session.rollbackTo(
        {
          kind: 'fork',
          source: { provider: 'claude', sessionId: 'source-session', cwd: session.workDir },
          through: nextAnchor.checkpoint,
        },
        { anchors: [nextAnchor], base: { kind: 'fresh' } },
        { announce: false },
      )).rejects.toThrow('turn-map fsync failed')

      expect(replacement.killCalls).toBe(0)
      expect(session.proc).toBeNull()
      expect(session.status).toBe('stopped')
      expect(session.lastSessionId).toBe('old-session')
      expect(turnAnchorsBySession.get(session.sessionName)).toEqual([oldAnchor])
      expect(branchBaseBySession.get(session.sessionName)).toEqual({ kind: 'fresh' })
      expect(boundResumes).not.toContainEqual([session.sessionName, 'old-session', 'claude'])
      expect(replaceCalls).toBe(1)
    } finally {
      replaceSpy.mockRestore()
    }
  })

  test('Codex rollback stops replacement and restores state when post-start branch commit fails', async () => {
    const session = new Session('codex-rollback-anchor-commit', 'chat_id') as any
    session.selectedProvider = 'codex'
    session.selectedTokenSourceId = null
    session.lastSessionId = 'old-thread'
    session.lastSessionRef = { provider: 'codex', sessionId: 'old-thread', cwd: session.workDir }
    const oldAnchor = {
      checkpoint: {
        provider: 'codex', kind: 'turn', id: 'turn-old',
        source: { provider: 'codex', sessionId: 'old-thread', cwd: session.workDir },
      },
      preview: 'old input', ts: 1, writes: [],
    } as any
    const nextAnchor = {
      checkpoint: {
        provider: 'codex', kind: 'turn', id: 'turn-next',
        source: { provider: 'codex', sessionId: 'source-thread', cwd: session.workDir },
      },
      preview: 'next input', ts: 2, writes: [],
    } as any
    turnAnchorsBySession.set(session.sessionName, [oldAnchor])
    branchBaseBySession.set(session.sessionName, { kind: 'fresh' })

    const replacement = new FakeAgentProc('codex', 'replacement-thread')
    session.restartUnlocked = async () => {
      session.proc = replacement
      session.lastSessionId = 'replacement-thread'
      session.lastSessionRef = { provider: 'codex', sessionId: 'replacement-thread', cwd: session.workDir }
      session.status = 'idle'
      return true
    }
    const realReplace = feishu.replaceTurnAnchors
    let replaceCalls = 0
    const replaceSpy = spyOn(feishu, 'replaceTurnAnchors').mockImplementation((sessionName, anchors, base, pending) => {
      replaceCalls++
      if (replaceCalls === 1) throw new Error('turn-map fsync failed')
      return realReplace(sessionName, anchors, base, pending)
    })

    try {
      await expect(session.rollbackTo(
        {
          kind: 'fork',
          source: { provider: 'codex', sessionId: 'source-thread', cwd: session.workDir },
          through: nextAnchor.checkpoint,
        },
        { anchors: [nextAnchor], base: { kind: 'fresh' } },
        { announce: false },
      )).rejects.toThrow('turn-map fsync failed')

      expect(replacement.killCalls).toBe(1)
      expect(session.proc).toBeNull()
      expect(session.status).toBe('stopped')
      expect(session.lastSessionId).toBe('old-thread')
      expect(turnAnchorsBySession.get(session.sessionName)).toEqual([oldAnchor])
      expect(branchBaseBySession.get(session.sessionName)).toEqual({ kind: 'fresh' })
      expect(boundResumes).toContainEqual([session.sessionName, 'old-thread', 'codex'])
      expect(replaceCalls).toBe(2)
    } finally {
      replaceSpy.mockRestore()
    }
  })

  test('rollback never resurrects a previous Codex binding that app-server confirmed has no rollout', async () => {
    const session = new Session('codex-rollback-ghost', 'chat_id') as any
    const ghostId = '0198d6fa-1234-7000-8000-000000000077'
    const ghostRef = { provider: 'codex' as const, sessionId: ghostId, cwd: session.workDir }
    session.selectedProvider = 'codex'
    session.selectedTokenSourceId = null
    session.lastSessionId = ghostId
    session.lastSessionRef = ghostRef
    resumeRefs.set(`${session.sessionName}:codex`, ghostRef)
    const oldAnchor = {
      checkpoint: {
        provider: 'codex', kind: 'turn', id: 'turn-old', source: ghostRef,
      },
      preview: 'old input', ts: 1, writes: [],
    } as any
    turnAnchorsBySession.set(session.sessionName, [oldAnchor])
    branchBaseBySession.set(session.sessionName, { kind: 'fresh' })
    const replacement = new FakeAgentProc('codex', null)
    replacement.launchKind = 'fork'
    replacement.initialization = Promise.reject(new CodexRpcResponseError(
      'thread/fork', 2, -32600, `no rollout found for thread id ${ghostId}`,
    ))
    session.spawnAgent = () => replacement

    const ok = await session.rollbackTo(
      { kind: 'fork', source: ghostRef },
      { anchors: [], base: { kind: 'fork', source: ghostRef } },
      { announce: false },
    )

    expect(ok).toBe(false)
    expect(replacement.killCalls).toBe(1)
    expect(resumeRefs.has(`${session.sessionName}:codex`)).toBe(false)
    expect(session.lastSessionRef).toBeNull()
    expect(session.lastSessionId).toBeNull()
    expect(turnAnchorsBySession.get(session.sessionName)).toEqual([oldAnchor])
    expect(branchBaseBySession.get(session.sessionName)).toEqual({ kind: 'fresh' })
  })

  test('rollback retains the prior binding when confirmed-ghost cleanup itself fails', async () => {
    const session = new Session('codex-rollback-ghost-clear-fails', 'chat_id') as any
    const ghostId = '0198d6fa-1234-7000-8000-000000000078'
    const ghostRef = { provider: 'codex' as const, sessionId: ghostId, cwd: session.workDir }
    session.selectedProvider = 'codex'
    session.selectedTokenSourceId = null
    session.lastSessionId = ghostId
    session.lastSessionRef = ghostRef
    resumeRefs.set(`${session.sessionName}:codex`, ghostRef)
    const replacement = new FakeAgentProc('codex', null)
    replacement.launchKind = 'fork'
    replacement.initialization = Promise.reject(new CodexRpcResponseError(
      'thread/fork', 2, -32600, `no rollout found for thread id ${ghostId}`,
    ))
    session.spawnAgent = () => replacement
    const clearSpy = spyOn(feishu, 'clearSessionResumeChecked').mockImplementation(() => {
      throw new Error('ghost cleanup fsync failed')
    })

    try {
      const ok = await session.rollbackTo(
        { kind: 'fork', source: ghostRef },
        { anchors: [], base: { kind: 'fork', source: ghostRef } },
        { announce: false },
      )

      expect(ok).toBe(false)
      expect(session.lastSessionRef).toEqual(ghostRef)
      expect(session.lastSessionId).toBe(ghostId)
      expect(resumeRefs.get(`${session.sessionName}:codex`)).toEqual(ghostRef)
    } finally {
      clearSpy.mockRestore()
    }
  })

  test('rollback stops an attached replacement when restart throws after it became ready', async () => {
    const session = new Session('rollback-ready-throw', 'chat_id') as any
    session.selectedProvider = 'claude'
    session.selectedTokenSourceId = null
    session.lastSessionId = 'old-session'
    session.lastSessionRef = { provider: 'claude', sessionId: 'old-session', cwd: session.workDir }
    const oldAnchor = {
      checkpoint: {
        provider: 'claude', kind: 'assistant-message', id: 'assistant-old',
        source: { provider: 'claude', sessionId: 'old-session', cwd: session.workDir },
      },
      preview: 'old input', ts: 1, writes: [],
    } as any
    turnAnchorsBySession.set(session.sessionName, [oldAnchor])
    branchBaseBySession.set(session.sessionName, { kind: 'fresh' })
    const replacement = new FakeAgentProc('claude', 'replacement-session')
    session.restartUnlocked = async () => {
      session.proc = replacement
      session.lastSessionId = 'replacement-session'
      session.lastSessionRef = { provider: 'claude', sessionId: 'replacement-session', cwd: session.workDir }
      session.status = 'idle'
      throw new Error('ready callback failed')
    }

    await expect(session.rollbackTo({
      kind: 'resume',
      source: { provider: 'claude', sessionId: 'source-session', cwd: session.workDir },
    })).rejects.toThrow('ready callback failed')

    expect(replacement.killCalls).toBe(1)
    expect(session.proc).toBeNull()
    expect(session.status).toBe('stopped')
    expect(session.lastSessionId).toBe('old-session')
    expect(turnAnchorsBySession.get(session.sessionName)).toEqual([oldAnchor])
    expect(branchBaseBySession.get(session.sessionName)).toEqual({ kind: 'fresh' })
  })

  test('Claude rs precommits pending fork intent before restart and restores it on failure', async () => {
    const session = new Session('pending-rollback', 'chat_id') as any
    session.selectedProvider = 'claude'
    session.lastSessionId = 'previous-session'
    session.lastSessionRef = {
      provider: 'claude', sessionId: 'previous-session', cwd: session.workDir,
    }
    const launch = {
      kind: 'fork' as const,
      source: { provider: 'claude' as const, sessionId: 'source-session', cwd: session.workDir },
    }
    let sawPrecommit = false
    session.restartUnlocked = async () => {
      sawPrecommit = pendingConversationLaunchBySession.get(session.sessionName)?.launch.source.sessionId === 'source-session'
      return false
    }

    const ok = await session.rollbackTo(launch, {
      anchors: [], base: launch,
    })

    expect(ok).toBe(false)
    expect(sawPrecommit).toBe(true)
    expect(pendingConversationLaunchBySession.has(session.sessionName)).toBe(false)
    expect(session.pendingConversationMaterialization).toBeNull()
  })

  test('Claude startForked persists pending intent before startup grace', async () => {
    const session = new Session('pending-start-forked', 'chat_id') as any
    session.selectedProvider = 'claude'
    session.lastSessionId = null
    const launch = {
      kind: 'fork' as const,
      source: { provider: 'claude' as const, sessionId: 'source-session', cwd: session.workDir },
    }
    let sawPrecommit = false
    session.startUnlocked = async () => {
      sawPrecommit = pendingConversationLaunchBySession.has(session.sessionName)
      return true
    }

    expect(await session.startForked(launch)).toBe(true)
    expect(sawPrecommit).toBe(true)
    expect(pendingConversationLaunchBySession.get(session.sessionName)).toEqual({
      launch,
      previousSessionId: null,
    })
  })

  test('constructor restores pending fork or materialized resume without silent fresh start', () => {
    const pendingName = 'pending-reload'
    const pendingCwd = `/tmp/lodestar-projects/${pendingName}`
    const pending = {
      launch: {
        kind: 'fork' as const,
        source: { provider: 'claude' as const, sessionId: 'source-session', cwd: pendingCwd },
      },
      previousSessionId: 'previous-session',
    }
    modelSelections.set(pendingName, {
      provider: 'claude', model: 'claude-opus-4-6', effort: 'high', tokenSourceId: 'claude-native',
    })
    resumeRefs.set(`${pendingName}:claude`, {
      provider: 'claude', sessionId: 'previous-session', cwd: pendingCwd,
    })
    pendingConversationLaunchBySession.set(pendingName, pending)
    const beforeInit = new Session(pendingName, 'chat_pending') as any
    expect(beforeInit.pendingMaterializationLaunch()).toEqual(pending.launch)

    const materializedName = 'pending-materialized-reload'
    const materializedCwd = `/tmp/lodestar-projects/${materializedName}`
    const materializedPending = {
      launch: {
        kind: 'fork' as const,
        source: { provider: 'claude' as const, sessionId: 'source-session', cwd: materializedCwd },
      },
      previousSessionId: 'previous-session',
    }
    modelSelections.set(materializedName, {
      provider: 'claude', model: 'claude-opus-4-6', effort: 'high', tokenSourceId: 'claude-native',
    })
    resumeRefs.set(`${materializedName}:claude`, {
      provider: 'claude', sessionId: 'new-materialized-session', cwd: materializedCwd,
    })
    pendingConversationLaunchBySession.set(materializedName, materializedPending)
    const afterInit = new Session(materializedName, 'chat_materialized') as any
    expect(afterInit.pendingMaterializationLaunch()).toEqual({
      kind: 'resume',
      source: {
        provider: 'claude', sessionId: 'new-materialized-session', cwd: materializedCwd,
      },
    })
  })

  test('Claude init binds the new id and first result consumes the durable pending marker', () => {
    const session = new Session('pending-materialize', 'chat_id') as any
    session.selectedProvider = 'claude'
    const launch = {
      kind: 'fork' as const,
      source: { provider: 'claude' as const, sessionId: 'source-session', cwd: session.workDir },
    }
    const pending = { launch, previousSessionId: 'previous-session' }
    session.lastSessionId = 'previous-session'
    session.lastSessionRef = {
      provider: 'claude', sessionId: 'previous-session', cwd: session.workDir,
    }
    session.pendingConversationMaterialization = pending
    pendingConversationLaunchBySession.set(session.sessionName, pending)
    session.proc = new FakeAgentProc('claude', 'new-session')

    expect(session.persistResumableSessionId(true)).toBeNull()
    expect(resumeRefs.get(`${session.sessionName}:claude`)?.sessionId).toBe('new-session')
    expect(pendingConversationLaunchBySession.has(session.sessionName)).toBe(true)
    expect(session.pendingMaterializationLaunch()).toEqual({
      kind: 'resume',
      source: { provider: 'claude', sessionId: 'new-session', cwd: session.workDir },
    })

    expect(session.consumePendingConversationMaterialization()).toBeNull()
    expect(pendingConversationLaunchBySession.has(session.sessionName)).toBe(false)
    expect(session.pendingConversationMaterialization).toBeNull()
  })

  test('Claude init rejects a fork that reuses source or previous session id', () => {
    const session = new Session('pending-same-id', 'chat_id') as any
    session.selectedProvider = 'claude'
    const launch = {
      kind: 'fork' as const,
      source: { provider: 'claude' as const, sessionId: 'source-session', cwd: session.workDir },
    }
    const pending = { launch, previousSessionId: 'source-session' }
    session.lastSessionId = 'source-session'
    session.pendingConversationMaterialization = pending
    pendingConversationLaunchBySession.set(session.sessionName, pending)
    session.proc = new FakeAgentProc('claude', 'source-session')

    expect(() => session.persistResumableSessionId(true)).toThrow('did not materialize an independent session id')
    expect(pendingConversationLaunchBySession.has(session.sessionName)).toBe(true)
  })

  test('Claude result without a session id keeps the durable fork intent', () => {
    const session = new Session('pending-missing-session-id', 'chat_id') as any
    session.selectedProvider = 'claude'
    const launch = {
      kind: 'fork' as const,
      source: { provider: 'claude' as const, sessionId: 'source-session', cwd: session.workDir },
    }
    const pending = { launch, previousSessionId: 'previous-session' }
    session.lastSessionId = 'previous-session'
    session.lastSessionRef = {
      provider: 'claude', sessionId: 'previous-session', cwd: session.workDir,
    }
    session.pendingConversationMaterialization = pending
    pendingConversationLaunchBySession.set(session.sessionName, pending)
    session.proc = new FakeAgentProc('claude', null)

    expect(session.persistResumableSessionId()).toContain('did not provide a materialized session id')
    expect(session.consumePendingConversationMaterialization()).toContain('保留 pending marker')
    expect(pendingConversationLaunchBySession.has(session.sessionName)).toBe(true)
  })

  test('Codex constructor clears stale Claude pending before validating its old cwd', () => {
    const sessionName = 'codex-clears-stale-claude-pending'
    modelSelections.set(sessionName, {
      provider: 'codex', model: 'gpt-5.6-sol', effort: 'low', tokenSourceId: 'codex-sub',
    })
    pendingConversationLaunchBySession.set(sessionName, {
      launch: {
        kind: 'fork',
        source: { provider: 'claude', sessionId: 'source-session', cwd: '/srv/old-claude-project' },
      },
      previousSessionId: null,
    })

    expect(() => new Session(sessionName, 'chat_id')).not.toThrow()
    expect(pendingConversationLaunchBySession.has(sessionName)).toBe(false)
  })

  test('explicit fresh and provider switch clear pending intent before changing routing', async () => {
    const session = new Session('pending-clear', 'chat_id') as any
    session.selectedProvider = 'claude'
    const launch = {
      kind: 'fork' as const,
      source: { provider: 'claude' as const, sessionId: 'source-session', cwd: session.workDir },
    }
    const pending = { launch, previousSessionId: null }
    session.pendingConversationMaterialization = pending
    pendingConversationLaunchBySession.set(session.sessionName, pending)
    session.startUnlocked = async () => true

    expect(await session.restartUnlocked(false, { announce: false })).toBe(true)
    expect(pendingConversationLaunchBySession.has(session.sessionName)).toBe(false)
    expect(session.pendingConversationMaterialization).toBeNull()

    session.selectedProvider = 'claude'
    session.pendingConversationMaterialization = pending
    pendingConversationLaunchBySession.set(session.sessionName, pending)
    setTurnAnchorWriteError(new Error('turn state fsync failed'))
    await expect(session.applyModelSelectionUnlocked('codex', 'gpt-5.6-sol', 'low', 'codex-sub'))
      .rejects.toThrow('turn state fsync failed')
    expect(session.selectedProvider).toBe('claude')
    expect(pendingConversationLaunchBySession.has(session.sessionName)).toBe(true)
    setTurnAnchorWriteError(null)
  })

  test('result still terminalizes the turn when resume-map persistence fails', async () => {
    const session = new Session('resume-write-result', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-current')
    session.selectedProvider = 'codex'
    session.proc = proc
    session.wireProc(proc)
    const turn = turnState('card_resume_write_result')
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)
    proc.lastResult = {
      cost_usd: null, cost_delta_usd: null, duration_ms: 1, num_turns: 1,
      usage: null, subtype: 'success', is_error: false,
    }
    setResumeWriteError(new Error('resume-map fsync failed'))

    proc.emit('result', {
      subtype: 'success', is_error: false, duration_ms: 1, usage: null,
      checkpoint: {
        provider: 'codex', kind: 'turn', id: 'turn-1',
        source: { provider: 'codex', sessionId: 'thread-current', cwd: session.workDir },
      },
    })

    await waitUntil(() => session.currentTurn === null)
    expect(session.status).toBe('idle')
    expect(session.lastSessionId).toBe('thread-current')
    expect(sentRawTexts.some(text => text.includes('resume-map fsync failed'))).toBe(true)
    setResumeWriteError(null)
  })

  test('result exposes checkpoint persistence failure and does not retain an in-memory-only anchor', async () => {
    const session = new Session('anchor-write-result', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-current')
    session.selectedProvider = 'codex'
    session.proc = proc
    session.wireProc(proc)
    proc.lastResult = {
      cost_usd: null, cost_delta_usd: null, duration_ms: 1, num_turns: 1,
      usage: null, subtype: 'success', is_error: false,
    }
    setTurnAnchorWriteError(new Error('turn-map fsync failed'))

    proc.emit('result', {
      subtype: 'success', is_error: false, duration_ms: 1, usage: null,
      checkpoint: {
        provider: 'codex', kind: 'turn', id: 'turn-1',
        source: { provider: 'codex', sessionId: 'thread-current', cwd: session.workDir },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(session.status).toBe('idle')
    expect(turnAnchorsBySession.has(session.sessionName)).toBe(false)
    expect(sentRawTexts.some(text => text.includes('turn-map fsync failed'))).toBe(true)
    setTurnAnchorWriteError(null)
  })

  test('result racing card open carries checkpoint persistence failure into deferred close', () => {
    const session = new Session('anchor-write-open-race', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-current')
    session.selectedProvider = 'codex'
    session.proc = proc
    session.wireProc(proc)
    proc.lastResult = {
      cost_usd: null, cost_delta_usd: null, duration_ms: 1, num_turns: 1,
      usage: null, subtype: 'success', is_error: false,
    }
    const owner = session.beginTurnOpen(proc, session.procEpoch)
    setTurnAnchorWriteError(new Error('turn-map race failed'))

    proc.emit('result', {
      subtype: 'success', is_error: false, duration_ms: 1, usage: null,
      checkpoint: {
        provider: 'codex', kind: 'turn', id: 'turn-race',
        source: { provider: 'codex', sessionId: 'thread-current', cwd: session.workDir },
      },
    })

    expect(owner.sawResult).toBe(true)
    expect(owner.terminalSuffix).toContain('turn-map race failed')
    expect(owner.terminalForcePush).toBe(true)
    session.releaseTurnOpen(owner)
    setTurnAnchorWriteError(null)
  })

  test('stop clears visible state but keeps an unconfirmed process blocked until its real exit', async () => {
    const session = new Session('stop-kill-failure', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'session-1')
    const lifecycleSnapshots: Array<{ shouldRevive: boolean; status: string }> = []
    session.opts.onLifecycleChange = () => {
      lifecycleSnapshots.push({ shouldRevive: session.shouldRevive(), status: session.status })
    }
    proc.kill = async () => {
      // The persisted alive marker callback must run before the first kill
      // await, while the explicit stop intent already excludes this process.
      expect(lifecycleSnapshots[0]).toEqual({ shouldRevive: false, status: 'stopped' })
      throw new Error('kill timeout')
    }
    session.proc = proc
    session.wireProc(proc)
    session.currentTurn = turnState('card_stop_kill_failure')
    session.pendingMidTurnMsgs = [{ text: 'queued', wireText: 'queued', userOpenId: '', msgId: '' }]
    session.backgroundTasks = [{
      id: 'bg', type: 'shell', description: 'running', status: 'running', startedAt: Date.now(), steps: [],
    }]

    await expect(session.stop('测试', { announce: false })).rejects.toThrow('kill timeout')
    expect(session.proc).toBe(proc)
    expect(session.blockedProc).toBe(proc)
    expect(session.shouldRevive()).toBe(false)
    expect(session.currentTurn).toBeNull()
    expect(session.pendingMidTurnMsgs).toEqual([])
    expect(session.backgroundTasks).toEqual([])
    expect(session.status).toBe('stopped')
    expect(lifecycleSnapshots.length).toBeGreaterThanOrEqual(2)
    await session.onUserMessage('must not spawn or feed')
    expect(proc.sentTexts).toEqual([])
    expect(sentTexts.some(text => text.includes('会话已阻断'))).toBe(true)

    proc.alive = false
    proc.emit('exit', { code: 0, signal: 'SIGKILL', expected: true })
    expect(session.proc).toBeNull()
    expect(session.blockedProc).toBeNull()
  })

  test.each(['stop', 'restart'] as const)('%s closes delegation admission before awaiting child cancellation', async action => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const cancelling = new Promise<void>(resolve => { entered = resolve })
    const session = new Session(`delegation-${action}`, 'chat_id', {
      onCancelAgentRuns: async () => { entered(); await gate },
    }) as any
    const proc = new FakeAgentProc('claude', 'session-1')
    session.proc = proc
    session.wireProc(proc)
    session.agentCapability = 'old-capability'
    let starts = 0
    session.startUnlocked = async () => { starts++; return true }

    expect(session.acceptsAgentCapability('old-capability')).toBe(true)
    const operation = action === 'stop'
      ? session.stop('cancel children', { announce: false })
      : session.restart(false, { announce: false })
    await cancelling
    expect(session.acceptsAgentCapability('old-capability')).toBe(false)
    expect(proc.killCalls).toBe(0)
    expect(starts).toBe(0)
    release()
    await operation
    expect(proc.killCalls).toBe(1)
    expect(starts).toBe(action === 'restart' ? 1 : 0)
  })

  test.each(['stop', 'restart'] as const)('%s still stops its main process and exposes delegated cancellation failure', async action => {
    const session = new Session(`delegation-failed-${action}`, 'chat_id', {
      onCancelAgentRuns: async () => { throw new Error('delegated process exit unconfirmed') },
    }) as any
    const proc = new FakeAgentProc('claude', 'session-1')
    session.proc = proc
    session.wireProc(proc)
    session.agentCapability = 'old-capability'
    let starts = 0
    session.startUnlocked = async () => { starts++; return true }
    const statuses: string[] = []

    if (action === 'stop') {
      await expect(session.stop('cancel children', { announce: false }))
        .rejects.toThrow('delegated process exit unconfirmed')
    } else {
      expect(await session.restart(false, {
        announce: false,
        onStatus: (status: string) => statuses.push(status),
      })).toBe(false)
      expect(statuses.join('\n')).toContain('agents=delegated process exit unconfirmed')
    }
    expect(proc.killCalls).toBe(1)
    expect(starts).toBe(0)
    expect(session.proc).toBeNull()
    expect(session.acceptsAgentCapability('old-capability')).toBe(false)
  })

  test('restart does not spawn after kill failure and still clears stale lifecycle state', async () => {
    const session = new Session('restart-kill-failure', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'session-1')
    proc.kill = async () => { throw new Error('kill timeout') }
    let spawnCalls = 0
    session.proc = proc
    session.wireProc(proc)
    session.currentTurn = turnState('card_restart_kill_failure')
    session.pendingUserMessageCount = 1
    session.spawnAgent = () => { spawnCalls++; return new FakeAgentProc('claude') }

    expect(await session.restart(false, { announce: false })).toBe(false)
    expect(spawnCalls).toBe(0)
    expect(session.proc).toBe(proc)
    expect(session.blockedProc).toBe(proc)
    expect(session.currentTurn).toBeNull()
    expect(session.pendingUserMessageCount).toBe(0)
    expect(session.status).toBe('stopped')

    expect(await session.start({ announce: false })).toBe(false)
    expect(spawnCalls).toBe(0)
    proc.alive = false
    proc.emit('exit', { code: 0, signal: 'SIGKILL', expected: true })
    expect(session.proc).toBeNull()
  })

  test('legacy resume cwd verification fails before an existing process is killed', async () => {
    const session = new Session('legacy-resume-cwd', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'running-thread')
    session.selectedProvider = 'codex'
    session.proc = proc
    session.status = 'idle'
    session.lastSessionId = 'legacy-thread'
    session.lastSessionRef = { provider: 'codex', sessionId: 'legacy-thread', cwd: null }
    session.resolveLegacyResumeRef = async () => { throw new Error('stored cwd mismatch') }

    expect(await session.restart(true, { announce: false })).toBe(false)
    expect(proc.killCalls).toBe(0)
    expect(session.proc).toBe(proc)
    expect(session.status).toBe('idle')
  })

  test('process ownership still becomes blocked when kill and terminal cleanup both fail', async () => {
    const session = new Session('stop-double-failure', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'session-1')
    proc.kill = async () => { throw new Error('kill timeout') }
    session.proc = proc
    session.wireProc(proc)
    session.resetBackgroundTasks = async () => { throw new Error('background cleanup failed') }

    await expect(session.stop('测试', { announce: false })).rejects.toThrow(
      /stop failed: kill timeout; background cleanup failed/,
    )

    expect(session.proc).toBe(proc)
    expect(session.stoppingProc).toBeNull()
    expect(session.blockedProc).toBe(proc)
    expect(session.shouldRevive()).toBe(false)
    await session.onUserMessage('must remain blocked')
    expect(proc.sentTexts).toEqual([])

    proc.alive = false
    proc.emit('exit', { code: 0, signal: 'SIGKILL', expected: true })
  })

  test('restart surfaces cleanup separately and never spawns after a failed stop transaction', async () => {
    const session = new Session('restart-double-failure', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'session-1')
    const statuses: string[] = []
    let spawnCalls = 0
    proc.kill = async () => { throw new Error('kill timeout') }
    session.proc = proc
    session.wireProc(proc)
    session.resetBackgroundTasks = async () => { throw new Error('background cleanup failed') }
    session.spawnAgent = () => { spawnCalls++; return new FakeAgentProc('claude') }

    expect(await session.restart(false, {
      announce: false,
      onStatus: (status: string) => statuses.push(status),
    })).toBe(false)

    expect(spawnCalls).toBe(0)
    expect(session.blockedProc).toBe(proc)
    expect(statuses.join('\n')).toContain('kill=kill timeout')
    expect(statuses.join('\n')).toContain('cleanup=background cleanup failed')

    proc.alive = false
    proc.emit('exit', { code: 0, signal: 'SIGKILL', expected: true })
  })

  test('kill command terminalizes its status card with the blocked-process failure', async () => {
    const session = new Session('kill-command-failure', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'session-1')
    proc.kill = async () => { throw new Error('kill timeout') }
    session.proc = proc
    session.wireProc(proc)

    await expect(session.runCommand('kill')).resolves.toBe(true)

    const footerContents = calls
      .filter(call => call.method === 'PUT' && call.path.includes('/elements/footer'))
      .map(call => JSON.parse(call.body.element).content as string)
    expect(footerContents.some(content =>
      content.includes('未确认终止') && content.includes('会话已阻断') && content.includes('kill timeout')
    )).toBe(true)
    const terminalSettings = calls
      .filter(call => call.method === 'PATCH' && call.path.endsWith('/settings'))
      .map(call => JSON.parse(call.body.settings))
    expect(terminalSettings.some(settings => settings?.config?.streaming_mode === false)).toBe(true)

    proc.alive = false
    proc.emit('exit', { code: 0, signal: 'SIGKILL', expected: true })
  })

  test('retains static card state when mutation reopens streaming and close also fails', async () => {
    const session = new Session('static-card-miss', 'chat_id') as any
    const cardId = 'card_static_miss'
    cardkit.recordCardCreated(cardId, 1)
    const baseFetch = globalThis.fetch
    let replaceAttempts = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      if (method === 'PUT' && path.includes('/elements/')) {
        replaceAttempts++
        return new Response(JSON.stringify(replaceAttempts === 1
          ? { code: 300309, msg: 'stream closed' }
          : { code: 300121, msg: 'replace rejected' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (method === 'PATCH' && path.endsWith('/settings')) {
        const body = init?.body ? JSON.parse(String(init.body)) : {}
        const settings = JSON.parse(String(body.settings ?? '{}'))
        const reopening = settings?.config?.streaming_mode === true
        return new Response(JSON.stringify(reopening
          ? { code: 0, data: {} }
          : { code: 300121, msg: 'close rejected' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return baseFetch(input, init)
    }) as typeof fetch

    try {
      const landed = await session.mutateStaticCard(cardId, 'test static', async () => {
        const replaced = await cardkit.replaceElementChecked(cardId, 'panel', {
          tag: 'markdown', element_id: 'panel', content: 'new',
        }, { notifyCardFailure: false })
        if (!replaced) throw new Error('replace failed')
      })
      expect(landed).toBe(false)
    } finally {
      globalThis.fetch = baseFetch
    }
    // A disposed/tombstoned card would return false without an HTTP call.
    expect(await cardkit.patchSettingsChecked(cardId, { config: { streaming_mode: false } })).toBe(true)
    await cardkit.dispose(cardId)
  })

  test('retains static card state when the checked mutation misses even if streaming-off lands', async () => {
    const session = new Session('static-mutation-miss', 'chat_id') as any
    const cardId = 'card_static_mutation_miss'
    cardkit.recordCardCreated(cardId, 1)

    expect(await session.mutateStaticCard(cardId, 'test static', async () => {
      throw new Error('mutation MISS')
    })).toBe(false)

    // A disposed card returns false immediately; true proves the failed
    // mutation retained repairable CardKit state.
    expect(await cardkit.patchSettingsChecked(cardId, { config: { streaming_mode: false } })).toBe(true)
    await cardkit.dispose(cardId)
  })

  test('hard stop terminalizes an active main card before releasing lifecycle ownership', async () => {
    const session = new Session('stop-active-card', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'session-1')
    const turn = turnState('card_stop_active')
    turn.userOpenId = ''
    session.proc = proc
    session.wireProc(proc)
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    await session.stop('测试停止', { announce: false })

    const footer = calls.find(call =>
      call.method === 'PUT' && call.path === `/cards/${turn.cardId}/elements/footer`
    )
    expect(JSON.parse(footer?.body.element ?? '{}').content).toContain('🛑 测试停止')
    expect(calls.some(call =>
      call.method === 'PATCH' && call.path === `/cards/${turn.cardId}/settings`
    )).toBe(true)
  })

  test('a user message owns the lifecycle mutex before a subsequently queued restart', async () => {
    const session = new Session('message-lifecycle-mutex', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.selectedTokenSourceId = null
    session.initCount = 1
    session.status = 'idle'

    let signalOpenStarted: () => void = () => {}
    const openStarted = new Promise<void>(resolve => { signalOpenStarted = resolve })
    let releaseOpen: () => void = () => {}
    const openGate = new Promise<void>(resolve => { releaseOpen = resolve })
    session.openTurnCard = async () => {
      signalOpenStarted()
      await openGate
      const turn = turnState('card_message_mutex')
      turn.userOpenId = ''
      session.currentTurn = turn
      cardkit.recordCardCreated(turn.cardId, 1)
      return turn
    }
    const spawned: FakeAgentProc[] = []
    session.spawnAgent = () => {
      const next = new FakeAgentProc('claude', `session-next-${spawned.length}`)
      spawned.push(next)
      return next
    }
    session.waitForProcEarlyFailure = async () => ({ state: 'ready' })

    const message = session.onUserMessage('first')
    await openStarted
    const restart = session.restart(false, { announce: false })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(proc.killCalls).toBe(0)

    releaseOpen()
    await message
    // 合并调和(取舍):上游真人投递经 sendClaimedUserText 对「未登记模式」的
    // proc 首投会注入 fileDeliveryAgentContext;本地投递 pin(dispatchHumanBatch)
    // 不承担首投规则注入 — spawn 的 developerInstructions 已给约定,仅真实模式
    // 变更才注入更新。本例 proc 为测试直挂(非 spawn,无 pre-seed),按本地
    // 语义断言用户原文。
    expect(proc.sentTexts).toEqual(['first'])
    expect(await restart).toBe(true)
    expect(proc.killCalls).toBe(1)
    expect(session.proc).toBe(spawned[0])
    await session.stop('测试收尾', { announce: false })
  })

  test('persisted model selection cannot mutate Session state while a user message owns lifecycle', async () => {
    const session = new Session('model-lifecycle-mutex', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.selectedTokenSourceId = null
    session.initCount = 1

    let signalOpenStarted: () => void = () => {}
    const openStarted = new Promise<void>(resolve => { signalOpenStarted = resolve })
    let releaseOpen: () => void = () => {}
    const openGate = new Promise<void>(resolve => { releaseOpen = resolve })
    session.openTurnCard = async () => {
      signalOpenStarted()
      await openGate
      const turn = turnState('card_model_mutex')
      turn.userOpenId = ''
      session.currentTurn = turn
      cardkit.recordCardCreated(turn.cardId, 1)
      return turn
    }

    const message = session.onUserMessage('first')
    await openStarted
    const selection = session.applyModelSelection('codex', 'gpt-5.6-sol', 'xhigh', 'codex-sub')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(session.selectedProvider).toBe('claude')

    releaseOpen()
    await message
    await selection
    expect(session.selectedProvider).toBe('codex')
    await session.stop('测试收尾', { announce: false })
  })

  test('card action helpers report stale, invalid, and internal failures explicitly', async () => {
    const session = new Session('action-outcomes', 'chat_id') as any

    expect(await session.onPermissionDecision('missing', 'allow', 'ou_user')).toEqual({
      ok: false,
      message: '此权限请求已失效或已处理',
    })
    const proc = new FakeAgentProc('claude', 'session-1')
    proc.sendPermissionResponse = () => { throw new Error('pipe closed') }
    session.proc = proc
    session.pendingPermissions.set('perm-1', { toolUseId: 'tool-1' })
    const failedPermission = await session.onPermissionDecision('perm-1', 'allow', 'ou_user')
    expect(failedPermission.ok).toBe(false)
    expect(failedPermission.message).toContain('pipe closed')
    expect(session.pendingPermissions.has('perm-1')).toBe(true)

    expect(await session.onAskAnswer('missing', 0, 0, 'ou_user')).toBe(false)
    session.pendingAsks.set('ask-1', {
      questions: [{ question: 'Pick?', options: [{ label: 'A' }] }],
      i: 0,
      answers: {},
      answered: new Map(),
      currentIdx: 0,
    })
    expect(await session.onAskAnswer('ask-1', 1, 0, 'ou_user')).toBe(false)
    expect(await session.onAskAnswer('ask-1', 0, 9, 'ou_user')).toBe(false)
    expect(await session.onAskAnswer('ask-1', 0, 0, 'ou_user')).toBe(true)

    session.selectedProvider = 'codex'
    expect((await session.onForkSelect(0, 'ou_user')).ok).toBe(false)
    expect((await session.onBackSelect(0)).ok).toBe(false)
    expect((await session.onResumeSelect('session-1')).ok).toBe(false)
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

  test('codex 空闲态也走 showResumeList(上游 ff44afb 门控解除;空闲判定保本地 no-turn)', async () => {
    // 上游 ff44afb 解除 rs 门的 codex 条件:双后端都列同 cwd 历史(Codex 走
    // thread/list)并从所选会话创建独立分支。此前 codex 空闲 fall-through
    // restart(true)(d9341b6 时代 claude-only 列表)。空闲判定仍保本地 no-turn
    // 三条件(陷阱 1:非 !isRunning(),进程 turn 间常驻保活)。
    const session = new Session('probe', 'chat_id') as any
    session.proc = { isAlive: () => true, provider: 'codex' }
    session.currentTurn = null
    session.pendingUserMessageCount = 0
    session.pendingMidTurnMsgs = []
    session.selectedProvider = 'codex'
    session.lastSessionId = 'codexsid12345678'
    session.runningAgy = false

    let listOpenId: string | null = null
    let restartCalled = false
    session.showResumeList = async (userOpenId: string) => { listOpenId = userOpenId }
    session.restart = async () => { restartCalled = true; return true }
    session.openStatusCard = async () => null
    session.closeStatusCard = async () => {}
    session.setStatusCard = () => {}
    session.withModel = (s: string) => s
    session.withWorktreeInstructionNotice = (s: string) => s
    session.backendLabel = () => 'codex'
    session.currentProvider = () => 'codex'

    await session.runCommand('rs', 'ou_user')

    expect(listOpenId!).toBe('ou_user')
    expect(restartCalled).toBe(false)
  })
})

describe('bk (back) — 命令阶段不预停(上游 ff44afb)', () => {
  test('bk 命令只弹列表不 stop 不取 lifecycle;点选校验后才 stop→fork', async () => {
    const session = new Session('bk-no-prestop', 'chat_id') as any
    session.selectedProvider = 'claude'
    session.proc = { isAlive: () => true, provider: 'claude' }
    session.currentTurn = null
    session.runningAgy = false
    session.startingAgy = false
    let stopCalls = 0
    session.stop = async () => { stopCalls++; return true }
    let listOpenId: string | null = null
    session.showBackList = async (userOpenId: string) => { listOpenId = userOpenId }
    const epochBefore = session.lifecycleEpoch

    await session.runCommand('bk', 'ou_user')

    // 「看完不点也被终止」修复:命令只展示列表,进程保持存活,不占 lifecycle。
    expect(stopCalls).toBe(0)
    expect(listOpenId!).toBe('ou_user')
    expect(session.lifecycleEpoch).toBe(epochBefore)
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

describe('isCodexCapacityError', () => {
  test('matches serverOverloaded capacity messages', () => {
    expect(isCodexCapacityError('Selected model is at capacity. Please try a different model.')).toBe(true)
    expect(isCodexCapacityError('serverOverloaded')).toBe(true)
    expect(isCodexCapacityError('model is at capacity')).toBe(true)
  })

  test('rejects unrelated errors', () => {
    expect(isCodexCapacityError('success')).toBe(false)
    expect(isCodexCapacityError('unexpected status 503')).toBe(false)
    expect(isCodexCapacityError('')).toBe(false)
    expect(isCodexCapacityError(null)).toBe(false)
  })
})

describe('Session Codex capacity 外挂(turn_retry 驱动,D-07)', () => {
  const CAPACITY_MESSAGE = 'Selected model is at capacity. Please try a different model.'

  function capacitySession(name: string, threadId: string): { session: any; proc: FakeAgentProc } {
    const session = new Session(name, 'chat_id') as any
    const proc = new FakeAgentProc('codex', threadId)
    session.selectedProvider = 'codex'
    session.proc = proc
    session.initCount = 1
    session.status = 'idle'
    session.lastUserOpenId = 'ou_user'
    useDeterministicFooterStatus(session)
    session.wireProc(proc)
    return { session, proc }
  }

  test('(a) turn_retry waiting → footer 文案含剩余秒数与 #attempt', async () => {
    const session = new Session('capacity-footer', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-capacity-footer')
    session.selectedProvider = 'codex'
    session.proc = proc
    session.initCount = 1
    session.status = 'working'
    session.lastUserOpenId = 'ou_user'
    session.wireProc(proc)
    const turn = turnState('card_capacity_footer')
    session.currentTurn = turn
    session.turnCounter = 1
    cardkit.recordCardCreated(turn.cardId, 1)
    // 真实 startFooterStatus 路径:只让计时器句柄确定化,不替换 footer 实现。
    const timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      (() => DETERMINISTIC_FOOTER_HANDLE) as unknown as typeof setTimeout,
    )

    try {
      proc.emitTurnRetry({ phase: 'waiting', attempt: 2, delayMs: 5_000, message: CAPACITY_MESSAGE })
      expect(turn.footerStatusLabel).toBe('⏳ 模型满载 · 5s 后重试 #2')
      session.renderFooterStatus(turn, turn.footerStatusStartedAt + 1_000)
      await cardkit.flush(turn.cardId)
      const footerWrites = calls
        .filter(call => call.method === 'PUT' && call.path === `/cards/${turn.cardId}/elements/footer`)
        .map(call => JSON.parse(call.body.element).content as string)
      expect(footerWrites.at(-1)).toContain('⏳ 模型满载 · 5s 后重试 #2')
      expect(session.capacityRetryAttempts).toBe(2)
    } finally {
      timeoutSpy.mockRestore()
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('(b) 唯一调度权在进程层:session 无自主计时器,重复 turn_retry 不产生第二次派发', async () => {
    const { session, proc } = capacitySession('capacity-single-driver', 'thread-capacity-single')
    // 结构断言:自主环入口已删除(T-02-14,不得双重重试)。
    expect((session as any).capacityRetryTimer).toBeUndefined()
    expect((session as any).scheduleCapacityRetry).toBeUndefined()
    expect((session as any).runCapacityRetry).toBeUndefined()
    expect((session as any).startCapacityContinueTurn).toBeUndefined()

    try {
      proc.emitTurnRetry({ phase: 'waiting', attempt: 1, delayMs: 5_000, message: CAPACITY_MESSAGE })
      proc.emitTurnRetry({ phase: 'waiting', attempt: 2, delayMs: 10_000, message: CAPACITY_MESSAGE })
      await waitFor(() => session.capacityRetryAttempts === 2)
      expect(proc.sentTexts).toHaveLength(0)
      expect(session.currentTurn).toBeNull()
      expect(session.status).toBe('idle')
    } finally {
      session.clearCapacityRetryState('test cleanup')
    }
  })

  test('(c) attempt 超上限 → 耗尽群通知恰好一次,且不取消进程层重试', async () => {
    const { session, proc } = capacitySession('capacity-exhausted', 'thread-capacity-exhausted')
    try {
      for (let i = 0; i < 3; i++) {
        proc.emitTurnRetry({
          phase: 'waiting',
          attempt: CAPACITY_RETRY_MAX_ATTEMPTS + i,
          delayMs: 60_000,
          message: CAPACITY_MESSAGE,
        })
      }
      await waitFor(() => sentRawTexts.some(text => text.includes('已自动重试')))
      expect(sentRawTexts.filter(text => text.includes('已自动重试'))).toHaveLength(1)
      // 外挂只通知不取消:进程层快照仍在,持续退避(上游语义)。
      expect(proc.turnRetry).not.toBeNull()
      expect(proc.sentTexts).toHaveLength(0)
    } finally {
      session.clearCapacityRetryState('test cleanup')
    }
  })

  test('(d) 退避等待期有排队中途消息 → 先 drain,不阻塞用户输入', async () => {
    const { session, proc } = capacitySession('capacity-drain-first', 'thread-capacity-drain')
    let drains = 0
    session.drainMidTurnAndOpen = async () => {
      drains++
      session.pendingMidTurnMsgs = []
      return 'committed'
    }
    session.pendingMidTurnMsgs.push({
      text: '中途消息',
      wireText: '中途消息',
      userOpenId: 'ou_user',
      msgId: 'om_mid',
    })

    try {
      proc.emitTurnRetry({ phase: 'waiting', attempt: 3, delayMs: 20_000, message: CAPACITY_MESSAGE })
      await waitFor(() => drains === 1)
      expect(drains).toBe(1)
      expect(session.pendingMidTurnMsgs).toHaveLength(0)
    } finally {
      session.clearCapacityRetryState('test cleanup')
    }
  })

  test('(e) 忙时 turn_retry 不触发续作也不抢轮', async () => {
    const { session, proc } = capacitySession('capacity-busy', 'thread-capacity-busy')
    const turn = turnState('card_capacity_busy')
    session.currentTurn = turn
    session.status = 'working'
    let drains = 0
    session.drainMidTurnAndOpen = async () => {
      drains++
      return 'preserved'
    }
    session.pendingMidTurnMsgs.push({
      text: '中途消息',
      wireText: '中途消息',
      userOpenId: 'ou_user',
      msgId: 'om_mid_busy',
    })

    try {
      proc.emitTurnRetry({ phase: 'waiting', attempt: 4, delayMs: 40_000, message: CAPACITY_MESSAGE })
      await waitFor(() => session.capacityRetryAttempts === 4)
      expect(drains).toBe(0)
      expect(proc.sentTexts).toHaveLength(0)
      expect(session.currentTurn).toBe(turn)
      expect(session.pendingMidTurnMsgs).toHaveLength(1)
    } finally {
      session.clearCapacityRetryState('test cleanup')
    }
  })

  test('success result clears capacity 镜像(attempts + 耗尽 latch)', async () => {
    const session = new Session('capacity-retry-clear', 'chat_capacity3') as any
    const proc = new FakeAgentProc('codex', 'thread-capacity-3')
    session.selectedProvider = 'codex'
    session.proc = proc
    session.initCount = 1
    session.status = 'working'
    session.capacityRetryAttempts = 2
    session.capacityRetryExhausted = true
    useDeterministicFooterStatus(session)
    session.wireProc(proc)
    session.currentTurn = turnState('card_capacity_clear')

    proc.lastResult = {
      ...proc.lastResult,
      subtype: 'success',
      is_error: false,
    }
    proc.emit('result', { subtype: 'success', is_error: false })
    expect(session.capacityRetryAttempts).toBe(0)
    expect(session.capacityRetryExhausted).toBe(false)
    expect(session.status).toBe('idle')
  })

  test('用户消息清空 capacity 本地镜像(不越权取消进程层计时器)', async () => {
    const { session, proc } = capacitySession('capacity-user-clears', 'thread-capacity-user')
    session.capacityRetryAttempts = 3
    session.capacityRetryExhausted = true
    session.currentTurn = turnState('card_capacity_user')

    try {
      await session.onUserMessage('人工重试', [], 'ou_user', 'om_manual')
      expect(session.capacityRetryAttempts).toBe(0)
      expect(session.capacityRetryExhausted).toBe(false)
      // 进程层快照不受 session 影响:退避计时器由进程层在 sendUserText 内自行取消。
      expect(proc.turnRetry).toBeNull()
    } finally {
      session.clearCapacityRetryState('test cleanup')
    }
  })
})

// ── 上游 4185808 主题 D:codex resume 绑定 materialization 门控 ──────────
// 未确认落盘的 codex 会话不得写入恢复映射;conversation_materialized 确认后
// 才推进绑定;失败路径可观测且脱敏(01-12 哨兵法);resume-state 原子写
// (01-03 state-store)半写崩溃不污染旧快照。
describe('Session codex resume 绑定 materialization 门控(上游 4185808 主题 D)', () => {
  test('conversation_materialized 前不写恢复映射;确认后推进绑定;错配 session_id 不推进', () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-thread-mat')
    proc.conversationResumableState = false // 未确认落盘的 fresh 线程
    session.proc = proc
    session.selectedProvider = 'codex'
    session.wireProc(proc)

    proc.emit('init', { session_id: 'codex-thread-mat' })
    proc.emit('turn_started', { turn_id: 't1', thread_id: 'codex-thread-mat' })
    proc.emit('token_usage', { usage: null, totalUsage: null, contextWindow: null })
    expect(boundResumes).toEqual([]) // 门控:未确认会话不进恢复映射
    expect(session.lastSessionId).toBeNull()

    // CodexProcess 在 emit conversation_materialized 前已置 resumable=true
    proc.conversationResumableState = true
    proc.emit('conversation_materialized', { session_id: 'codex-thread-mat', source: 'turn/started notification' })
    expect(boundResumes).toEqual([['probe', 'codex-thread-mat', 'codex']])
    expect(session.lastSessionId).toBe('codex-thread-mat')

    // 错配的迟到 materialized(旧代际线程)不得改写当前绑定
    proc.emit('conversation_materialized', { session_id: 'other-thread', source: 'turn/completed notification' })
    expect(boundResumes).toEqual([['probe', 'codex-thread-mat', 'codex']])
    expect(session.lastSessionId).toBe('codex-thread-mat')
  })

  test('claude 进程不受门控影响:init 即持久化(行为零变化)', () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-ungated')
    ;(proc as any).isConversationResumable = undefined // claude 不实现该 hook
    session.proc = proc
    session.selectedProvider = 'claude'
    session.wireProc(proc)

    proc.emit('init', { session_id: 'claude-session-ungated' })
    expect(boundResumes).toEqual([['probe', 'claude-session-ungated', 'claude']])
    expect(session.lastSessionId).toBe('claude-session-ungated')
  })

  test('conversation_materialization_failed:绑定不推进+同错误仅一次群内可观测,文案不含 cause/raw payload(哨兵)', () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-thread-fail')
    proc.conversationResumableState = false
    session.proc = proc
    session.selectedProvider = 'codex'
    session.wireProc(proc)

    const SENTINEL = 'SENTINEL_RAW_ROLLOUT_PAYLOAD_X'
    const failure = new Error(
      'codex turn/started notification rollout is not readable at /tmp/rollouts/codex-thread-fail.jsonl: ENOENT',
      { cause: new Error(`Authorization: Bearer ${SENTINEL}`) },
    )
    ;(failure as any).raw = `{"app_secret":"${SENTINEL}"}`

    proc.emit('conversation_materialization_failed', {
      session_id: 'codex-thread-fail',
      path: '/tmp/rollouts/codex-thread-fail.jsonl',
      source: 'turn/started notification',
      error: failure,
    })

    expect(boundResumes).toEqual([]) // 失败不推进绑定
    const visible = sentRawTexts.join('\n')
    expect(visible).toContain('落盘确认失败')
    expect(visible).toContain('rollout is not readable')
    // 哨兵负向断言(01-12 惯例):cause 链/raw payload/凭据不进任何用户可见通道
    expect(visible).not.toContain(SENTINEL)
    expect(JSON.stringify(sentCards)).not.toContain(SENTINEL)
    expect(JSON.stringify(updatedCards)).not.toContain(SENTINEL)

    // 同一错误重复到达(重验循环)不刷屏
    proc.emit('conversation_materialization_failed', {
      session_id: 'codex-thread-fail',
      path: '/tmp/rollouts/codex-thread-fail.jsonl',
      source: 'turn/started notification',
      error: failure,
    })
    expect(sentRawTexts).toHaveLength(1)

    // 新错误(内容不同)是新一次可观测
    proc.emit('conversation_materialization_failed', {
      session_id: 'codex-thread-fail',
      path: '/tmp/rollouts/codex-thread-fail.jsonl',
      source: 'turn/completed notification',
      error: new Error('codex turn/completed notification thread/read returned an invalid materialized thread'),
    })
    expect(sentRawTexts).toHaveLength(2)
  })

  test('resume-state 原子写:半写崩溃的 tmp 残留不污染旧完整快照(dead-man\'s switch 事务底座)', () => {
    // 现状绿锚:writeJsonStateAtomic(01-03 state-store)已承载 resume map 持久化,
    // 本用例锁定崩溃语义 + feishu 接线,防未来回退成裸 writeFileSync。
    const root = mkdtempSync(join(tmpdir(), 'lodestar-resume-state-'))
    try {
      const file = join(root, 'session-resume-map.json')
      writeJsonStateAtomic(file, { probe: { codex: 'thread-old-complete' } })
      // 模拟 writeStateFileAtomic 半写崩溃:tmp 兄弟文件写到一半、未 rename
      writeFileSync(`${file}.99999.deadbeef.tmp`, '{"probe":{"codex":"thread-ne')
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ probe: { codex: 'thread-old-complete' } })
      // 下一次完整事务照常原子替换
      writeJsonStateAtomic(file, { probe: { codex: 'thread-new' } })
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ probe: { codex: 'thread-new' } })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
    // 接线结构锚:真实 feishu.ts 的 resume map 落盘必须经 writeJsonStateAtomic
    const feishuSource = readFileSync(join(import.meta.dir, 'feishu.ts'), 'utf8')
    expect(feishuSource).toContain('writeJsonStateAtomic(SESSION_RESUME_MAP_FILE')
  })
})

describe('Session conversation launch 数据流(上游 ff44afb 簇 1)', () => {
  test('rollbackTo 派生 codex fork launch:restart 期间一次性 intent 四字段可见,收尾后清空', async () => {
    const session = new Session('rollback-codex-launch', 'chat_id') as any
    session.selectedProvider = 'codex'
    session.lastSessionId = 'previous-thread'
    let captured: any = 'not-captured'
    session.restart = async () => {
      captured = session.pendingConversationLaunch
      return true
    }

    const source = { provider: 'codex' as const, sessionId: 'source-thread', cwd: session.workDir }
    const ok = await session.rollbackTo({
      kind: 'fork',
      source,
      through: { provider: 'codex', kind: 'turn', id: 'turn-3', source },
    })

    expect(ok).toBe(true)
    expect(captured?.launch).toEqual({
      kind: 'fork',
      source,
      through: { provider: 'codex', kind: 'turn', id: 'turn-3', source },
    })
    expect(captured?.previousSessionId).toBe('previous-thread')
    expect(session.pendingConversationLaunch).toBeNull()
  })

  test('startForked 派生 claude fork launch 且 start 收尾后清空', async () => {
    const session = new Session('forked-claude-launch', 'chat_id') as any
    session.selectedProvider = 'claude'
    let captured: any = 'not-captured'
    session.start = async () => {
      captured = session.pendingConversationLaunch
      return true
    }

    const source = { provider: 'claude' as const, sessionId: 'history-session', cwd: session.workDir }
    const ok = await session.startForked({
      kind: 'fork',
      source,
      through: { provider: 'claude', kind: 'assistant-message', id: 'uuid-7', source },
    })

    expect(ok).toBe(true)
    expect(captured?.launch).toEqual({
      kind: 'fork',
      source,
      through: { provider: 'claude', kind: 'assistant-message', id: 'uuid-7', source },
    })
    expect(session.pendingConversationLaunch).toBeNull()
  })

  test('spawnAgent 将 claude fork launch 翻译为 resumeSessionId/resumeSessionAt/forkSession 三参', () => {
    const session = new Session('claude-fork-translate', 'chat_id') as any
    session.selectedProvider = 'claude'
    const source = { provider: 'claude', sessionId: 'source-session', cwd: session.workDir }
    session.pendingConversationLaunch = {
      lease: { kind: 'fork' },
      launch: {
        kind: 'fork',
        source,
        through: { provider: 'claude', kind: 'assistant-message', id: 'anchor-uuid', source },
      },
      previousSessionId: null,
    }

    const proc = session.spawnAgent(undefined, 'claude') as any

    expect(proc.opts.resumeSessionId).toBe('source-session')
    expect(proc.opts.resumeSessionAt).toBe('anchor-uuid')
    expect(proc.opts.forkSession).toBe(true)
  })

  test('spawnAgent 无 pending intent 时 fresh;lease 不符的 intent 不消费(lease 归属检查)', () => {
    const session = new Session('claude-launch-lease', 'chat_id') as any
    session.selectedProvider = 'claude'

    const fresh = session.spawnAgent(undefined, 'claude') as any
    expect(fresh.opts.resumeSessionId).toBeUndefined()
    // 合并调和(取舍):launch 装配(agent-launch.ts)按上游形态稀疏落键 ——
    // fresh 分支整体不产 resume/fork 键,与本地旧形态的显式 forkSession:false
    // 等价(进程层仅在 truthy 时向 SDK 转发,claude-agent-process:1095)。
    expect(fresh.opts.forkSession).toBeUndefined()

    const source = { provider: 'claude', sessionId: 'other-session', cwd: session.workDir }
    session.pendingConversationLaunch = {
      lease: { kind: 'fork' },
      launch: { kind: 'fork', source },
      previousSessionId: null,
    }
    const foreign = session.spawnAgent(undefined, 'claude', { kind: 'restart' }) as any
    expect(foreign.opts.forkSession).toBeUndefined()
    expect(foreign.opts.resumeSessionId).toBeUndefined()
  })

  test('spawnAgent 对 cwd 不匹配的 codex fork launch 在进程构造前拒绝', async () => {
    const session = new Session('codex-launch-cwd', 'chat_id') as any
    session.selectedProvider = 'codex'
    const source = { provider: 'codex', sessionId: 'thread-x', cwd: '/elsewhere/dir' }
    session.pendingConversationLaunch = {
      lease: { kind: 'back' },
      launch: { kind: 'fork', source },
      previousSessionId: null,
    }
    let leaked: any = null
    try {
      expect(() => { leaked = session.spawnAgent(undefined, 'codex') }).toThrow('conversation launch cwd mismatch')
    } finally {
      // RED 态防泄漏:未按预期抛出时把误 spawn 的进程杀掉。
      if (leaked?.kill) await leaked.kill(500).catch(() => {})
    }
  })

  test('legacy resume(cwd:null)先经 resolveLegacyResumeRef 升级再 spawn', async () => {
    const session = new Session('legacy-upgrade', 'chat_id') as any
    session.selectedProvider = 'codex'
    session.lastSessionId = 'legacy-thread'
    session.lastSessionRef = { provider: 'codex', sessionId: 'legacy-thread', cwd: null }
    const upgraded = { provider: 'codex', sessionId: 'legacy-thread', cwd: session.workDir }
    session.resolveLegacyResumeRef = async () => upgraded
    const spawnRefs: any[] = []
    session.spawnAgent = (resumeRef?: any) => {
      spawnRefs.push(resumeRef)
      const proc = new FakeAgentProc('codex', 'legacy-thread')
      proc.sendInitialize = () => proc.emit('init', { session_id: proc.sessionId })
      return proc
    }

    const ok = await session.restart(true, { announce: false })

    expect(ok).toBe(true)
    expect(spawnRefs).toEqual([upgraded])
    expect(session.lastSessionRef).toEqual(upgraded)
    await session.stop('测试收尾', { announce: false })
  })

  test('legacy 升级失败:restart 如实报错返回 false,不 spawn 不猜 cwd', async () => {
    const session = new Session('legacy-upgrade-fail', 'chat_id') as any
    session.selectedProvider = 'codex'
    session.lastSessionId = 'legacy-thread'
    session.lastSessionRef = { provider: 'codex', sessionId: 'legacy-thread', cwd: null }
    session.resolveLegacyResumeRef = async () => { throw new Error('stored cwd mismatch') }
    let spawnCalls = 0
    session.spawnAgent = () => {
      spawnCalls++
      return new FakeAgentProc('codex', 'x')
    }
    const statuses: string[] = []

    const ok = await session.restart(true, { announce: false, onStatus: (s: string) => statuses.push(s) })

    expect(ok).toBe(false)
    expect(spawnCalls).toBe(0)
    expect(statuses.join('\n')).toContain('stored cwd mismatch')
  })

  test('resolveLegacyResumeRef:claude transcript 缺失如实拒绝,provider 不符拒绝', async () => {
    const session = new Session('legacy-honest', 'chat_id') as any
    session.selectedProvider = 'claude'
    await expect(session.resolveLegacyResumeRef({ provider: 'claude', sessionId: 'missing-session', cwd: null }))
      .rejects.toThrow('旧 Claude 会话不属于当前 cwd')
    await expect(session.resolveLegacyResumeRef({ provider: 'codex', sessionId: 'x', cwd: null }))
      .rejects.toThrow('legacy resume provider mismatch')
    expect(boundResumes).toEqual([])
  })

  test('resolveLegacyResumeRef:dsh legacy ref(cwd:null)显式拒绝,不进 Codex catalog', async () => {
    // DSH 无「pre-cwd 时代」记录,legacy 形态是坏数据:fail closed 拒绝,
    // 不得把 DSH sessionId 拿去向 Codex catalog 查(上游 722e45a @@-686)。
    const session = new Session('legacy-dsh-reject', 'chat_id') as any
    session.selectedProvider = 'dsh'
    let catalogSpawns = 0
    session.spawnCodexCatalogProcess = () => {
      catalogSpawns++
      throw new Error('Codex catalog must not be consulted for dsh')
    }

    await expect(session.resolveLegacyResumeRef({ provider: 'dsh', sessionId: 'dsh-legacy-1', cwd: null }))
      .rejects.toThrow('DSH resume reference requires its original cwd')
    expect(catalogSpawns).toBe(0)
    expect(boundResumes).toEqual([])
  })

  test('rs 历史列表:DSH 会话走 listDshConversations,不落 Claude 本地目录(上游 722e45a)', async () => {
    const session = new Session('resume-dsh-history', 'chat_id') as any
    session.selectedProvider = 'dsh'
    let dshListCalls = 0
    session.listDshConversations = async () => {
      dshListCalls++
      return [{
        provider: 'dsh' as const,
        sessionId: 'dsh-history-session',
        cwd: session.workDir,
        preview: '原生历史输入',
        ts: 1,
        status: 'idle',
      }]
    }

    await session.showResumeList('ou_user')

    expect(dshListCalls).toBe(1)
    expect(JSON.stringify(sentCards.at(-1))).toContain('原生历史输入')
  })

  test('listCodexConversations:一次性 catalog 进程 spawn→list→kill,查询失败也不泄漏进程', async () => {
    const session = new Session('codex-history', 'chat_id') as any
    await expect(session.listCodexConversations()).rejects.toThrow('Codex history requested for a non-Codex session')

    session.selectedProvider = 'codex'
    const summary = { provider: 'codex' as const, sessionId: 't1', cwd: session.workDir, preview: 'hi', ts: 1 }
    // 合并调和(取舍):catalog 进程取上游形态 —— listCodexConversations 内联构造
    // CodexProcess(本地 spawnCodexCatalogProcess 接缝未并入),构造本身不 spawn;
    // 真实 spawn 只发生在 listConversations。替身钉原型 listConversations/kill:
    // 覆盖本次一次性进程的全部外部行为面(spawn→list→kill、失败也 kill)。
    let killCalls = 0
    const listSpy = spyOn(CodexProcess.prototype, 'listConversations')
      .mockImplementation(async () => [summary])
    const killSpy = spyOn(CodexProcess.prototype, 'kill')
      .mockImplementation(async () => { killCalls++ })
    try {
      expect(await session.listCodexConversations()).toEqual([summary])
      expect(killCalls).toBe(1)

      listSpy.mockImplementation(async () => { throw new Error('thread/list exploded') })
      await expect(session.listCodexConversations()).rejects.toThrow('thread/list exploded')
      expect(killCalls).toBe(2)
    } finally {
      listSpy.mockRestore()
      killSpy.mockRestore()
    }
  })

  test('conversationRouting 快照与 applyConversationRouting:运行中拒绝,provider 切换清锚换基线', () => {
    const session = new Session('routing-snapshot', 'chat_id') as any
    session.selectedProvider = 'claude'
    session.selectedModel = 'claude:glm'
    session.selectedEffort = 'max'
    // 合并调和(取舍):快照形状取上游(合并实现收窄类型声明、保留富行为)——
    // tokenSourceId 恒随快照(codex 账号/conversationRouting→apply 运行时往返
    // 依赖),codexAccountAutomatic 在未绑 API 来源且账号仍为 auto 时随行;
    // 本地 D-02 slim 三字段形态已被合并实现取代。
    expect(session.conversationRouting()).toEqual({
      provider: 'claude',
      tokenSourceId: null,
      model: 'claude:glm',
      effort: 'max',
      codexAccountAutomatic: true,
    })

    session.proc = new FakeAgentProc('claude', 's1')
    expect(() => session.applyConversationRouting({ provider: 'codex', model: null, effort: null }))
      .toThrow('cannot change conversation routing while the session is running')
    session.proc = null

    // 合并调和(取舍):本地 provider 白名单('unknown conversation routing
    // provider')未并入合并实现 —— apply 取上游形态,运行时只校验 token source
    // 归属(source.agent !== routing.provider),provider 合法性由
    // ConversationRouting.provider: AgentProvider 在编译期约束。


    // WR-01:dsh 路由必须放行(归一化走 session-model 的固定档位目录),否则
    // btw/fk 的临时群会走到「先建群再散群」。
    session.applyConversationRouting({ provider: 'dsh', model: 'deepseek-v4-pro', effort: 'high' })
    expect(session.selectedProvider).toBe('dsh')
    expect(session.selectedModel).toBe('deepseek-v4-pro')
    expect(session.selectedEffort).toBe('high')

    resumeRefs.set(`${session.sessionName}:codex`, { provider: 'codex', sessionId: 'codex-old', cwd: null })
    session.applyConversationRouting({ provider: 'codex', model: null, effort: null })
    expect(session.selectedProvider).toBe('codex')
    expect(clearedTurnAnchors).toContain(session.sessionName)
    expect(branchBaseBySession.get(session.sessionName)).toBeNull()
    expect(session.lastSessionId).toBe('codex-old')
    expect(session.lastSessionRef).toEqual({ provider: 'codex', sessionId: 'codex-old', cwd: null })
  })
})

// ── 上游 ff44afb/4185808 簇 2:rollbackTo/startForked 补偿事务 ──────────────
// 八项快照 → (Claude fork)precommit pendingLaunch → restart/start 经本地 lease
// 通道 → candidate/candidateStopped 判定序逐字(陷阱 9:停不掉绝不 restore)→
// 成功 commit branchState / 失败 restore(含挂账 #5 invalidatedPreviousResume
// 分支)。本地守卫叠加:lease 失效时事务中止不写状态。
describe('Session rollbackTo/startForked 补偿事务(4185808 终态,挂账 #5/陷阱 9)', () => {
  const claudeAnchor = (session: any, id: string, sessionId: string) => ({
    checkpoint: {
      provider: 'claude' as const, kind: 'assistant-message' as const, id,
      source: { provider: 'claude' as const, sessionId, cwd: session.workDir },
    },
    preview: 'old input', ts: 1, writes: [],
  })
  const codexAnchor = (session: any, id: string, sessionId: string) => ({
    checkpoint: {
      provider: 'codex' as const, kind: 'turn' as const, id,
      source: { provider: 'codex' as const, sessionId, cwd: session.workDir },
    },
    preview: 'old input', ts: 1, writes: [],
  })

  test('rollback stops an attached replacement when restart throws after it became ready', async () => {
    const session = new Session('rollback-ready-throw', 'chat_id') as any
    session.selectedProvider = 'claude'
    session.lastSessionId = 'old-session'
    session.lastSessionRef = { provider: 'claude', sessionId: 'old-session', cwd: session.workDir }
    resumeRefs.set(`${session.sessionName}:claude`, { provider: 'claude', sessionId: 'old-session', cwd: session.workDir })
    const oldAnchor = claudeAnchor(session, 'assistant-old', 'old-session')
    turnAnchorsBySession.set(session.sessionName, [oldAnchor])
    branchBaseBySession.set(session.sessionName, { kind: 'fresh' })
    const replacement = new FakeAgentProc('claude', 'replacement-session')
    session.restart = async () => {
      session.proc = replacement
      session.lastSessionId = 'replacement-session'
      session.lastSessionRef = { provider: 'claude', sessionId: 'replacement-session', cwd: session.workDir }
      session.status = 'idle'
      throw new Error('ready callback failed')
    }

    await expect(session.rollbackTo({
      kind: 'resume',
      source: { provider: 'claude', sessionId: 'source-session', cwd: session.workDir },
    })).rejects.toThrow('ready callback failed')

    // 替换进程被停,停成功才 restore 旧快照(resume 绑定/锚/base 全部回滚)
    expect(replacement.killCalls).toBe(1)
    expect(session.proc).toBeNull()
    expect(session.status).toBe('stopped')
    expect(session.lastSessionId).toBe('old-session')
    expect(session.lastSessionRef?.sessionId).toBe('old-session')
    expect(resumeRefs.get(`${session.sessionName}:claude`)?.sessionId).toBe('old-session')
    expect(turnAnchorsBySession.get(session.sessionName)).toEqual([oldAnchor])
    expect(branchBaseBySession.get(session.sessionName)).toEqual({ kind: 'fresh' })
  })

  test('rollback keeps replacement binding when the replacement cannot be stopped(停不掉绝不 restore,陷阱 9)', async () => {
    const session = new Session('rollback-stop-fail', 'chat_id') as any
    session.selectedProvider = 'claude'
    session.lastSessionId = 'old-session'
    session.lastSessionRef = { provider: 'claude', sessionId: 'old-session', cwd: session.workDir }
    resumeRefs.set(`${session.sessionName}:claude`, { provider: 'claude', sessionId: 'old-session', cwd: session.workDir })
    turnAnchorsBySession.set(session.sessionName, [claudeAnchor(session, 'assistant-old', 'old-session')])
    const replacement = new FakeAgentProc('claude', 'replacement-session')
    replacement.kill = async () => {
      replacement.killCalls++
      throw new Error('kill timeout') // alive 保持 true:停止未确认
    }
    session.restart = async () => {
      session.proc = replacement
      session.lastSessionId = 'replacement-session'
      session.lastSessionRef = { provider: 'claude', sessionId: 'replacement-session', cwd: session.workDir }
      throw new Error('ready callback failed')
    }

    await expect(session.rollbackTo({
      kind: 'resume',
      source: { provider: 'claude', sessionId: 'source-session', cwd: session.workDir },
    })).rejects.toThrow('rollback launch and cleanup failed')

    // 真失败路径:替换进程停不掉 → lastSessionRef/lastSessionId 未被改写回旧值,
    // 不发生任何 restore 写(旧 resume id 绝不指回,防两会话并存冲突)
    expect(replacement.isAlive()).toBe(true)
    expect(session.lastSessionId).toBe('replacement-session')
    expect(session.lastSessionRef?.sessionId).toBe('replacement-session')
    // 合并调和(取舍):上游 stop 在 kill 前/后会对仍 resumable 的进程幂等重绑
    // 其自身 id(会话生命周期可靠性簇 15965「stop persists a verified Codex
    // materialization that lands during SIGTERM」依赖该重绑,不可删)。断言收窄为
    // 核心不变量 —— 无任何把旧 id 绑回的 restore 写,替换自身的正向绑定保持:
    expect(boundResumes.filter(entry => entry[1] === 'old-session')).toEqual([])
    expect(boundResumes).toContainEqual([session.sessionName, 'replacement-session', 'claude'])
    expect(seededTurnAnchors).toEqual([])
  })

  test('rollback commits branch state atomically after the replacement is ready(成功才换)', async () => {
    const session = new Session('rollback-commit', 'chat_id') as any
    session.selectedProvider = 'codex'
    session.lastSessionId = 'previous-thread'
    const oldAnchor = codexAnchor(session, 'turn-old', 'previous-thread')
    turnAnchorsBySession.set(session.sessionName, [oldAnchor])
    session.restart = async () => true
    const source = { provider: 'codex' as const, sessionId: 'source-thread', cwd: session.workDir }
    const launch = {
      kind: 'fork' as const, source,
      through: { provider: 'codex' as const, kind: 'turn' as const, id: 'turn-3', source },
    }
    const seedAnchor = codexAnchor(session, 'turn-2', 'source-thread')

    const ok = await session.rollbackTo(launch, { anchors: [seedAnchor], base: launch })

    expect(ok).toBe(true)
    expect(turnAnchorsBySession.get(session.sessionName)).toEqual([seedAnchor])
    expect(branchBaseBySession.get(session.sessionName)).toEqual(launch)
    // codex fork 无 Claude pendingLaunch
    expect(pendingConversationLaunchBySession.has(session.sessionName)).toBe(false)
  })

  test('rollback branch commit failure stops the replacement and restores the resume snapshot', async () => {
    const session = new Session('rollback-commit-fail', 'chat_id') as any
    session.selectedProvider = 'codex'
    session.lastSessionId = 'old-thread'
    session.lastSessionRef = { provider: 'codex', sessionId: 'old-thread', cwd: session.workDir }
    resumeRefs.set(`${session.sessionName}:codex`, { provider: 'codex', sessionId: 'old-thread', cwd: session.workDir })
    const replacement = new FakeAgentProc('codex', 'forked-thread')
    session.restart = async () => {
      session.proc = replacement
      session.lastSessionId = 'forked-thread'
      session.lastSessionRef = { provider: 'codex', sessionId: 'forked-thread', cwd: session.workDir }
      // commit 阶段的 replaceTurnAnchors 写失败(restart 成功后才注入)
      setTurnAnchorWriteError(new Error('turn state fsync failed'))
      return true
    }
    const source = { provider: 'codex' as const, sessionId: 'source-thread', cwd: session.workDir }
    const launch = { kind: 'fork' as const, source }

    try {
      await expect(session.rollbackTo(launch, { anchors: [], base: launch }))
        .rejects.toThrow('rollback branch commit failed')
    } finally {
      setTurnAnchorWriteError(null)
    }

    // commit 失败 → 停替换进程 + restore(resume 绑定回滚;锚写通道已坏属 restoreError 上抛)
    expect(replacement.killCalls).toBe(1)
    expect(session.proc).toBeNull()
    expect(session.lastSessionId).toBe('old-thread')
    expect(session.lastSessionRef?.sessionId).toBe('old-thread')
    expect(resumeRefs.get(`${session.sessionName}:codex`)?.sessionId).toBe('old-thread')
  })

  test('Claude rs precommits pending fork intent before restart and restores it on failure', async () => {
    const session = new Session('pending-rollback', 'chat_id') as any
    session.selectedProvider = 'claude'
    session.lastSessionId = 'previous-session'
    session.lastSessionRef = { provider: 'claude', sessionId: 'previous-session', cwd: session.workDir }
    const launch = {
      kind: 'fork' as const,
      source: { provider: 'claude' as const, sessionId: 'source-session', cwd: session.workDir },
    }
    let sawPrecommit = false
    session.restart = async () => {
      sawPrecommit = pendingConversationLaunchBySession.get(session.sessionName)?.launch.source.sessionId === 'source-session'
      return false
    }

    const ok = await session.rollbackTo(launch, { anchors: [], base: launch })

    expect(ok).toBe(false)
    expect(sawPrecommit).toBe(true)
    expect(pendingConversationLaunchBySession.has(session.sessionName)).toBe(false)
    expect(session.pendingConversationMaterialization).toBeNull()
  })

  test('Claude startForked persists pending intent before startup grace,成功后 durable marker 保留', async () => {
    const session = new Session('pending-start-forked', 'chat_id') as any
    session.selectedProvider = 'claude'
    session.lastSessionId = null
    const launch = {
      kind: 'fork' as const,
      source: { provider: 'claude' as const, sessionId: 'source-session', cwd: session.workDir },
    }
    let sawPrecommit = false
    session.start = async () => {
      sawPrecommit = pendingConversationLaunchBySession.has(session.sessionName)
      return true
    }

    expect(await session.startForked(launch)).toBe(true)
    // precommit 先于 spawn(start);成功后 durable marker 保留到首个 result 消费
    expect(sawPrecommit).toBe(true)
    expect(pendingConversationLaunchBySession.has(session.sessionName)).toBe(true)
    expect(session.pendingConversationMaterialization?.launch).toEqual(launch)
    expect(session.pendingConversationLaunch).toBeNull()
  })

  test('Claude startForked start 失败恢复 pending intent 原值(不留半提交态)', async () => {
    const session = new Session('pending-start-forked-fail', 'chat_id') as any
    session.selectedProvider = 'claude'
    const launch = {
      kind: 'fork' as const,
      source: { provider: 'claude' as const, sessionId: 'source-session', cwd: session.workDir },
    }
    session.start = async () => false

    expect(await session.startForked(launch)).toBe(false)
    expect(pendingConversationLaunchBySession.has(session.sessionName)).toBe(false)
    expect(session.pendingConversationMaterialization).toBeNull()
  })

  test('restore clears an invalidated ghost binding instead of rebinding it(挂账 #5)', async () => {
    const session = new Session('rollback-ghost', 'chat_id') as any
    session.selectedProvider = 'codex'
    session.lastSessionId = 'ghost-thread'
    session.lastSessionRef = { provider: 'codex', sessionId: 'ghost-thread', cwd: session.workDir }
    resumeRefs.set(`${session.sessionName}:codex`, { provider: 'codex', sessionId: 'ghost-thread', cwd: session.workDir })
    session.restart = async (_resume: boolean, opts: any) => {
      // 模拟 restart 内 invalidateMissingCodexResume:app-server 确认 ghost 无 rollout
      resumeRefs.delete(`${session.sessionName}:codex`)
      session.lastSessionRef = null
      session.lastSessionId = null
      opts.onResumeInvalidated?.('ghost-thread')
      return false
    }
    const source = { provider: 'codex' as const, sessionId: 'ghost-thread', cwd: session.workDir }

    const ok = await session.rollbackTo({ kind: 'fork', source })

    expect(ok).toBe(false)
    // 幽灵 id 不得绑回:restore 走清空分支
    expect(session.lastSessionId).toBeNull()
    expect(session.lastSessionRef).toBeNull()
    expect(resumeRefs.has(`${session.sessionName}:codex`)).toBe(false)
    expect(clearedResumes).toContainEqual([session.sessionName, 'codex'])
  })

  test('restore rebinds the previous resume when invalidation targeted a different id(挂账 #5 负例)', async () => {
    const session = new Session('rollback-ghost-mismatch', 'chat_id') as any
    session.selectedProvider = 'codex'
    session.lastSessionId = 'old-thread'
    session.lastSessionRef = { provider: 'codex', sessionId: 'old-thread', cwd: session.workDir }
    resumeRefs.set(`${session.sessionName}:codex`, { provider: 'codex', sessionId: 'old-thread', cwd: session.workDir })
    session.restart = async (_resume: boolean, opts: any) => {
      opts.onResumeInvalidated?.('some-other-thread') // 与 previous 不匹配:不置位
      return false
    }
    const source = { provider: 'codex' as const, sessionId: 'source-thread', cwd: session.workDir }

    const ok = await session.rollbackTo({ kind: 'fork', source })

    expect(ok).toBe(false)
    expect(session.lastSessionId).toBe('old-thread')
    expect(session.lastSessionRef?.sessionId).toBe('old-thread')
    expect(resumeRefs.get(`${session.sessionName}:codex`)?.sessionId).toBe('old-thread')
  })

  test('rollback aborts without state writes when the lifecycle lease is lost during restart(本地守卫叠加)', async () => {
    const session = new Session('rollback-lease-lost', 'chat_id') as any
    session.selectedProvider = 'codex'
    session.lastSessionId = 'old-thread'
    session.lastSessionRef = { provider: 'codex', sessionId: 'old-thread', cwd: session.workDir }
    resumeRefs.set(`${session.sessionName}:codex`, { provider: 'codex', sessionId: 'old-thread', cwd: session.workDir })
    const oldAnchor = codexAnchor(session, 'turn-old', 'old-thread')
    turnAnchorsBySession.set(session.sessionName, [oldAnchor])
    session.restart = async () => {
      session.beginLifecycle('stop') // 并发 lifecycle 抢占
      return false
    }
    const source = { provider: 'codex' as const, sessionId: 'source-thread', cwd: session.workDir }

    const ok = await session.rollbackTo({ kind: 'fork', source }, { anchors: [], base: { kind: 'fresh' } })

    expect(ok).toBe(false)
    // 事务中止不写状态:无 restore 绑定写、无锚 replace 写、内存目标不回滚
    expect(boundResumes).toEqual([])
    expect(seededTurnAnchors).toEqual([])
    expect(turnAnchorsBySession.get(session.sessionName)).toEqual([oldAnchor])
    expect(session.lastSessionId).toBe('old-thread')
  })
})

// ── 上游 4185808 簇 2 后半:restart 前置三件 + constructor pendingLaunch 恢复区
// (挂账 #2)+ materialization 消费。显式 clear/fresh restart 先持久清 pendingLaunch
// 再停进程,stop 失败恢复;legacy(cwd:null)升级前置——校验失败不 kill 现有进程;
// daemon 崩溃后 Claude fork intent 从磁盘复活(provider 已切→清/stillPending→复活/
// materialized→resume 新 id/皆非→fail-loud throw);首个 claude result 消费 marker。
describe('Session restart 前置三件 + constructor 恢复区 + materialization 消费(4185808,挂账 #2)', () => {
  const claudeForkLaunch = (session: any, sourceId = 'source-session') => ({
    kind: 'fork' as const,
    source: { provider: 'claude' as const, sessionId: sourceId, cwd: session.workDir },
  })

  test('explicit fresh restart cancels the prepared Claude fork before any stop or reset', async () => {
    const session = new Session('cancel-pending', 'chat_id') as any
    session.selectedProvider = 'claude'
    const pending = { launch: claudeForkLaunch(session), previousSessionId: null }
    session.pendingConversationMaterialization = pending
    pendingConversationLaunchBySession.set(session.sessionName, pending)
    let pendingAtReset: boolean | null = null
    const origReset = session.resetFreshConversationState.bind(session)
    session.resetFreshConversationState = () => {
      pendingAtReset = pendingConversationLaunchBySession.has(session.sessionName)
      origReset()
    }
    session.start = async () => true

    expect(await session.restart(false, { announce: false })).toBe(true)

    // 取消发生在 restart 头部(fresh reset/停进程之前),持久态与内存 marker 双清
    expect(pendingAtReset!).toBe(false)
    expect(pendingConversationLaunchBySession.has(session.sessionName)).toBe(false)
    expect(session.pendingConversationMaterialization).toBeNull()
  })

  test('stop 失败恢复 pending:磁盘 pending 仍在,不留半取消态', async () => {
    const session = new Session('cancel-pending-stop-fail', 'chat_id') as any
    session.selectedProvider = 'claude'
    const proc = new FakeAgentProc('claude', 'live-session')
    let pendingAtKill: boolean | null = null
    proc.kill = async () => {
      proc.killCalls++
      pendingAtKill = pendingConversationLaunchBySession.has(session.sessionName)
      throw new Error('kill timeout')
    }
    session.proc = proc
    const pending = { launch: claudeForkLaunch(session), previousSessionId: null }
    session.pendingConversationMaterialization = pending
    pendingConversationLaunchBySession.set(session.sessionName, pending)

    expect(await session.restart(false, { announce: false })).toBe(false)

    // 先持久清再停进程;停失败(kill 抛出)→ 恢复 pending 原值
    expect(pendingAtKill!).toBe(false)
    expect(pendingConversationLaunchBySession.get(session.sessionName)).toEqual(pending)
    expect(session.pendingConversationMaterialization).toEqual(pending)
  })

  test('legacy resume cwd verification fails before an existing process is killed', async () => {
    const session = new Session('legacy-resume-cwd', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'running-thread')
    session.selectedProvider = 'codex'
    session.proc = proc
    session.status = 'idle'
    session.lastSessionId = 'legacy-thread'
    session.lastSessionRef = { provider: 'codex', sessionId: 'legacy-thread', cwd: null }
    session.resolveLegacyResumeRef = async () => { throw new Error('stored cwd mismatch') }
    const statuses: string[] = []

    expect(await session.restart(true, { announce: false, onStatus: (s: string) => statuses.push(s) })).toBe(false)

    // 校验失败拒绝 restart 且现有进程未被 kill(前置于停进程)
    expect(proc.killCalls).toBe(0)
    expect(session.proc).toBe(proc)
    expect(proc.isAlive()).toBe(true)
    expect(session.status).toBe('idle')
    expect(statuses.join('\n')).toContain('stored cwd mismatch')
  })

  test('constructor restores pending fork or materialized resume without silent fresh start', () => {
    const pendingName = 'pending-reload'
    const pendingCwd = `/tmp/lodestar-projects/${pendingName}`
    const pending = {
      launch: {
        kind: 'fork' as const,
        source: { provider: 'claude' as const, sessionId: 'source-session', cwd: pendingCwd },
      },
      previousSessionId: 'previous-session',
    }
    resumeRefs.set(`${pendingName}:claude`, { provider: 'claude', sessionId: 'previous-session', cwd: pendingCwd })
    pendingConversationLaunchBySession.set(pendingName, pending)
    const beforeInit = new Session(pendingName, 'chat_pending') as any
    // stillPending:lastSessionId === previousSessionId → fork intent 复活
    expect(beforeInit.pendingConversationMaterialization).toEqual(pending)
    expect(beforeInit.pendingMaterializationLaunch()).toEqual(pending.launch)

    const materializedName = 'pending-materialized-reload'
    const materializedCwd = `/tmp/lodestar-projects/${materializedName}`
    const materializedPending = {
      launch: {
        kind: 'fork' as const,
        source: { provider: 'claude' as const, sessionId: 'source-session', cwd: materializedCwd },
      },
      previousSessionId: 'previous-session',
    }
    resumeRefs.set(`${materializedName}:claude`, { provider: 'claude', sessionId: 'new-materialized-session', cwd: materializedCwd })
    pendingConversationLaunchBySession.set(materializedName, materializedPending)
    const afterInit = new Session(materializedName, 'chat_materialized') as any
    // materialized:绑定已推进到独立新 id → 以 resume 新 id 为安全 launch
    expect(afterInit.pendingMaterializationLaunch()).toEqual({
      kind: 'resume',
      source: { provider: 'claude', sessionId: 'new-materialized-session', cwd: materializedCwd },
    })
  })

  test('Codex constructor clears stale Claude pending before validating its old cwd', () => {
    const sessionName = 'codex-clears-stale-claude-pending'
    modelSelections.set(sessionName, { provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' })
    pendingConversationLaunchBySession.set(sessionName, {
      launch: {
        kind: 'fork',
        source: { provider: 'claude', sessionId: 'source-session', cwd: '/srv/old-claude-project' },
      },
      previousSessionId: null,
    })

    expect(() => new Session(sessionName, 'chat_id')).not.toThrow()
    expect(pendingConversationLaunchBySession.has(sessionName)).toBe(false)
  })

  test('constructor throws on a pending Claude fork with inconsistent resume binding(fail-loud)', () => {
    const brokenName = 'pending-inconsistent'
    const brokenCwd = `/tmp/lodestar-projects/${brokenName}`
    // 畸形持久态:绑定 id === fork 源 id(既非 stillPending 也非 materialized)
    resumeRefs.set(`${brokenName}:claude`, { provider: 'claude', sessionId: 'source-session', cwd: brokenCwd })
    pendingConversationLaunchBySession.set(brokenName, {
      launch: {
        kind: 'fork',
        source: { provider: 'claude', sessionId: 'source-session', cwd: brokenCwd },
      },
      previousSessionId: 'previous-session',
    })

    expect(() => new Session(brokenName, 'chat_broken')).toThrow('inconsistent resume binding')
  })

  test('Claude init binds the new id and first result consumes the durable pending marker', () => {
    const session = new Session('pending-materialize', 'chat_id') as any
    session.selectedProvider = 'claude'
    const launch = claudeForkLaunch(session)
    const pending = { launch, previousSessionId: 'previous-session' }
    session.lastSessionId = 'previous-session'
    session.lastSessionRef = { provider: 'claude', sessionId: 'previous-session', cwd: session.workDir }
    session.pendingConversationMaterialization = pending
    pendingConversationLaunchBySession.set(session.sessionName, pending)
    const proc = new FakeAgentProc('claude', 'new-session')
    session.proc = proc

    // 合并调和(取舍):persist 签名并入上游 (fatal, proc, notify)——本地
    // proc-first 形参退役;显式 proc 走第二参数,fatal 保持 false(非致命返回消息)。
    // persist 推进绑定但不清 durable marker(marker 归首个 result 消费)
    expect(session.persistResumableSessionId(false, proc)).toBeNull()
    expect(resumeRefs.get(`${session.sessionName}:claude`)?.sessionId).toBe('new-session')
    expect(pendingConversationLaunchBySession.has(session.sessionName)).toBe(true)
    expect(session.pendingMaterializationLaunch()).toEqual({
      kind: 'resume',
      source: { provider: 'claude', sessionId: 'new-session', cwd: session.workDir },
    })

    expect(session.consumePendingConversationMaterialization()).toBeNull()
    expect(pendingConversationLaunchBySession.has(session.sessionName)).toBe(false)
    expect(session.pendingConversationMaterialization).toBeNull()
  })

  test('首个 claude result 经 wireProc 接线消费 durable marker(materialize 成功证据)', () => {
    const session = new Session('pending-consume-result', 'chat_id') as any
    session.selectedProvider = 'claude'
    const launch = claudeForkLaunch(session)
    const pending = { launch, previousSessionId: 'previous-session' }
    session.lastSessionId = 'previous-session'
    session.lastSessionRef = { provider: 'claude', sessionId: 'previous-session', cwd: session.workDir }
    session.pendingConversationMaterialization = pending
    pendingConversationLaunchBySession.set(session.sessionName, pending)
    const proc = new FakeAgentProc('claude', 'new-session')
    session.proc = proc
    session.wireProc(proc)

    proc.emit('result', { subtype: 'success', is_error: false })

    expect(resumeRefs.get(`${session.sessionName}:claude`)?.sessionId).toBe('new-session')
    expect(pendingConversationLaunchBySession.has(session.sessionName)).toBe(false)
    expect(session.pendingConversationMaterialization).toBeNull()
  })

  test('Claude fork 未派生独立 id / 无 id:persist 拒绝推进,durable marker 保留', () => {
    const session = new Session('pending-same-id', 'chat_id') as any
    session.selectedProvider = 'claude'
    const launch = claudeForkLaunch(session)
    const pending = { launch, previousSessionId: 'source-session' }
    session.lastSessionId = 'source-session'
    session.pendingConversationMaterialization = pending
    pendingConversationLaunchBySession.set(session.sessionName, pending)
    const sameId = new FakeAgentProc('claude', 'source-session')
    session.proc = sameId
    // 合并调和(取舍):persist 签名为上游 (fatal, proc, notify);此断言验的是
    // 非致命路径返回消息,显式 proc 走第二参数、fatal=false。
    expect(session.persistResumableSessionId(false, sameId)).toContain('did not materialize an independent session id')
    expect(pendingConversationLaunchBySession.has(session.sessionName)).toBe(true)

    const noId = new FakeAgentProc('claude', null)
    session.proc = noId
    expect(session.persistResumableSessionId(false, noId)).toContain('did not provide a materialized session id')
    expect(session.consumePendingConversationMaterialization()).toContain('保留 pending marker')
    expect(pendingConversationLaunchBySession.has(session.sessionName)).toBe(true)
  })
})

// ── 上游 ff44afb 簇 4 清理:锚清空 checked 化(replaceTurnAnchors 换代)、fresh
// 显式 base、workDir 经 worktreeSessionDir(temp-of-worktree 修复)且本地
// projectProfile override 分支保留(翻译表 #15,语义等价三形态证明)。
describe('Session 簇 4 清理:checked 锚清空/显式 fresh base/workDir 委托(ff44afb)', () => {
  test('applyModelSelection provider 切换:锚清空经 checked replaceTurnAnchors,写失败 throw 且内存 provider 不变', async () => {
    const session = new Session('model-switch-checked', 'chat_id') as any
    session.selectedProvider = 'claude'
    const launch = {
      kind: 'fork' as const,
      source: { provider: 'claude' as const, sessionId: 'source-session', cwd: session.workDir },
    }
    session.pendingConversationMaterialization = { launch, previousSessionId: null }
    turnAnchorsBySession.set(session.sessionName, [{
      checkpoint: {
        provider: 'claude' as const, kind: 'assistant-message' as const, id: 'a1',
        source: { provider: 'claude' as const, sessionId: 's1', cwd: session.workDir },
      },
      preview: 'x', ts: 1, writes: [],
    }])

    setTurnAnchorWriteError(new Error('turn state fsync failed'))
    try {
      await expect(session.applyModelSelection('codex', 'gpt-5.6-sol', null))
        .rejects.toThrow('turn state fsync failed')
    } finally {
      setTurnAnchorWriteError(null)
    }
    // checked first:写失败不得留下「内存 provider 已切、磁盘 Claude fork marker 仍在」
    expect(session.selectedProvider).toBe('claude')
    expect((turnAnchorsBySession.get(session.sessionName) ?? []).length).toBe(1)

    await session.applyModelSelection('codex', 'gpt-5.6-sol', null)
    expect(session.selectedProvider).toBe('codex')
    expect(turnAnchorsBySession.get(session.sessionName) ?? []).toHaveLength(0)
    expect(session.pendingConversationMaterialization).toBeNull()
  })

  test('resetFreshConversationState 写显式 base {kind:\'fresh\'}(与 legacy null 判别)', () => {
    const session = new Session('fresh-base', 'chat_id') as any
    session.selectedProvider = 'claude'
    session.resetFreshConversationState()
    expect(branchBaseBySession.get(session.sessionName)).toEqual({ kind: 'fresh' })
    expect(turnAnchorsBySession.get(session.sessionName) ?? []).toHaveLength(0)
  })

  test('start 的 fresh reset 让位于 durable fork marker(precommit 不被冲掉)', async () => {
    const session = new Session('fresh-guard', 'chat_id') as any
    session.selectedProvider = 'claude'
    const pending = {
      launch: {
        kind: 'fork' as const,
        source: { provider: 'claude' as const, sessionId: 'source-session', cwd: session.workDir },
      },
      previousSessionId: null,
    }
    session.pendingConversationMaterialization = pending
    pendingConversationLaunchBySession.set(session.sessionName, pending)
    let resetCalls = 0
    const origReset = session.resetFreshConversationState.bind(session)
    session.resetFreshConversationState = () => { resetCalls++; origReset() }
    session.spawnAgent = () => { throw new Error('stop before spawn') }

    expect(await session.start({ announce: false })).toBe(false)

    expect(resetCalls).toBe(0)
    expect(pendingConversationLaunchBySession.has(session.sessionName)).toBe(true)
  })

  test('workDir 三形态等价:temp-of-worktree 留 worktree cwd;普通 temp 群与 profile override 群零变化', () => {
    // ① temp-of-worktree(修复目标):proj[wt]*0102-0304 剥 * 后缀后按 worktree 群名解析
    const wtTemp = new Session('proj[wt]*0102-0304', 'chat_wt_temp') as any
    expect(sessionWorktree.worktreeProjectName(wtTemp)).toBe('proj')
    expect(sessionWorktree.worktreeSessionDir(wtTemp)).toBe('/tmp/lodestar-projects/proj[wt]')
    expect(wtTemp.workDir).toBe('/tmp/lodestar-projects/proj[wt]')

    // ② 普通 temp 群:剥后缀回原项目目录(零变化)
    const plainTemp = new Session('proj*0102-0304', 'chat_plain_temp') as any
    expect(plainTemp.workDir).toBe('/tmp/lodestar-projects/proj')

    // ③ profile override 群:override 分支保留(删除即红——worktreeSessionDir 不查 profile)
    projectProfiles.set('evolving', { cwd: '/srv/custom/evolving' })
    const override = new Session('evolving', 'chat_override') as any
    expect(override.workDir).toBe('/srv/custom/evolving')
    const overrideTemp = new Session('evolving*0102-0304', 'chat_override_temp') as any
    expect(overrideTemp.workDir).toBe('/srv/custom/evolving')
  })
})

describe('Session turn 锚数据流(4185808 终态,挂账 #3)', () => {
  const codexCheckpoint = (session: any, id: string, sessionId = 'fresh-thread'): ConversationCheckpoint => ({
    provider: 'codex',
    kind: 'turn',
    id,
    source: { provider: 'codex', sessionId, cwd: session.workDir },
  })

  test('快 turn 锚延迟:未确认 resumable 入队不写盘,persist 成功路径 flush 落盘;persist 失败不 flush', () => {
    const session = new Session('codex-fast-checkpoint', 'chat_id') as any
    session.selectedProvider = 'codex'
    const proc = new FakeAgentProc('codex', 'fresh-thread')
    proc.launchKind = 'fresh'
    proc.conversationResumableState = false
    session.proc = proc
    session.wireProc(proc)
    session.lastTurnUserPreview = 'fast input'
    const checkpoint = codexCheckpoint(session, 'turn-fast')

    proc.emit('result', { is_error: false, checkpoint })
    expect(turnAnchorsBySession.has(session.sessionName)).toBe(false)
    expect(session.pendingCodexTurnAnchors).toHaveLength(1)

    // persist 失败路径不 flush(门与队列是同一窗口的两半:门没过队列必须原样保留)
    proc.conversationResumableState = true
    setResumeWriteError(new Error('resume-map fsync failed'))
    proc.emit('conversation_materialized', { session_id: proc.sessionId, source: 'turn/started notification' })
    expect(session.pendingCodexTurnAnchors).toHaveLength(1)
    expect(turnAnchorsBySession.has(session.sessionName)).toBe(false)
    setResumeWriteError(null)

    // persist 成功后同一时刻排空延迟队列
    proc.emit('conversation_materialized', { session_id: proc.sessionId, source: 'turn/started notification' })
    expect(session.pendingCodexTurnAnchors).toHaveLength(0)
    expect(turnAnchorsBySession.get(session.sessionName)).toEqual([{
      checkpoint,
      preview: 'fast input',
      ts: expect.any(Number),
      writes: [],
    }])
  })

  test('队列上限 64/进程:溢出拒绝新锚保留旧锚(上游终态形)', () => {
    const session = new Session('codex-anchor-cap', 'chat_id') as any
    session.selectedProvider = 'codex'
    const proc = new FakeAgentProc('codex', 'fresh-thread')
    proc.conversationResumableState = false
    session.proc = proc
    for (let i = 0; i < 64; i++) {
      expect(session.recordTurnAnchor(codexCheckpoint(session, `turn-${i}`))).toBeNull()
    }
    expect(session.pendingCodexTurnAnchors).toHaveLength(64)

    const overflow = session.recordTurnAnchor(codexCheckpoint(session, 'turn-64'))
    expect(overflow).toContain('延迟 checkpoint 队列已满')
    expect(session.pendingCodexTurnAnchors).toHaveLength(64)
    expect(session.pendingCodexTurnAnchors[0].anchor.checkpoint.id).toBe('turn-0')
  })

  test('confirmed stop 收尾 discard:队列锚不落幽灵', async () => {
    const session = new Session('codex-anchor-stop', 'chat_id') as any
    session.selectedProvider = 'codex'
    const proc = new FakeAgentProc('codex', 'fresh-thread')
    proc.conversationResumableState = false
    session.proc = proc
    session.wireProc(proc)
    session.recordTurnAnchor(codexCheckpoint(session, 'turn-a'))
    expect(session.pendingCodexTurnAnchors).toHaveLength(1)

    await session.stop('测试终止', { announce: false })

    expect(session.pendingCodexTurnAnchors).toHaveLength(0)
    expect(turnAnchorsBySession.has(session.sessionName)).toBe(false)
  })

  test('unexpected exit 收尾 discard:崩溃进程的延迟锚不落幽灵', () => {
    const session = new Session('codex-anchor-exit', 'chat_id') as any
    session.selectedProvider = 'codex'
    const proc = new FakeAgentProc('codex', 'fresh-thread')
    proc.conversationResumableState = false
    session.proc = proc
    session.wireProc(proc)
    session.recordTurnAnchor(codexCheckpoint(session, 'turn-b'))
    expect(session.pendingCodexTurnAnchors).toHaveLength(1)

    proc.alive = false
    proc.emit('exit', { code: 1, signal: null, expected: false })

    expect(session.pendingCodexTurnAnchors).toHaveLength(0)
    expect(turnAnchorsBySession.has(session.sessionName)).toBe(false)
  })

  test('result still terminalizes the turn when resume-map persistence fails', async () => {
    const session = new Session('resume-write-result', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-current')
    session.selectedProvider = 'codex'
    session.proc = proc
    session.wireProc(proc)
    const turn = turnState('card_resume_write_result')
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)
    setResumeWriteError(new Error('resume-map fsync failed'))

    proc.emit('result', {
      subtype: 'success', is_error: false, duration_ms: 1, usage: null,
      checkpoint: codexCheckpoint(session, 'turn-1', 'thread-current'),
    })

    await waitUntil(() => session.currentTurn === null)
    expect(session.status).toBe('idle')
    expect(session.lastSessionId).toBe('thread-current')
    expect(sentRawTexts.some(text => text.includes('resume-map fsync failed'))).toBe(true)
    setResumeWriteError(null)
  })

  test('锚写失败:turn 仍终态化,不留 in-memory-only 锚,错误可观测', async () => {
    const session = new Session('anchor-write-result', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-current')
    session.selectedProvider = 'codex'
    session.proc = proc
    session.wireProc(proc)
    setTurnAnchorWriteError(new Error('turn-map fsync failed'))

    proc.emit('result', {
      subtype: 'success', is_error: false, duration_ms: 1, usage: null,
      checkpoint: codexCheckpoint(session, 'turn-1', 'thread-current'),
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(session.status).toBe('idle')
    expect(turnAnchorsBySession.has(session.sessionName)).toBe(false)
    expect(sentRawTexts.some(text => text.includes('turn-map fsync failed'))).toBe(true)
    setTurnAnchorWriteError(null)
  })

  test('checkpoint 归属校验:provider/sessionId/cwd 三不符各自拒绝', () => {
    const session = new Session('anchor-ownership', 'chat_id') as any
    session.selectedProvider = 'codex'
    const proc = new FakeAgentProc('codex', 'thread-current')
    session.proc = proc

    const wrongProvider = session.recordTurnAnchor({
      provider: 'claude', kind: 'assistant-message', id: 'uuid-1',
      source: { provider: 'claude', sessionId: 'thread-current', cwd: session.workDir },
    })
    const wrongSession = session.recordTurnAnchor(codexCheckpoint(session, 'turn-1', 'other-thread'))
    const wrongCwd = session.recordTurnAnchor({
      provider: 'codex', kind: 'turn', id: 'turn-2',
      source: { provider: 'codex', sessionId: 'thread-current', cwd: '/elsewhere' },
    })

    for (const rejection of [wrongProvider, wrongSession, wrongCwd]) {
      expect(rejection).toContain('拒绝')
    }
    expect(turnAnchorsBySession.has(session.sessionName)).toBe(false)
    expect(session.pendingCodexTurnAnchors ?? []).toHaveLength(0)
  })

  test('persistResumableSessionId pending 独立 id 校验:新 id===source 或===previous 报错', () => {
    const session = new Session('persist-independent-id', 'chat_id') as any
    session.selectedProvider = 'codex'
    const lease = { kind: 'fork' }
    const source = { provider: 'codex', sessionId: 'src-1', cwd: session.workDir }

    const procSameAsSource = new FakeAgentProc('codex', 'src-1')
    session.proc = procSameAsSource
    session.pendingConversationLaunch = {
      lease, launch: { kind: 'fork', source }, previousSessionId: 'prev-1',
    }
    // 合并调和(取舍):persist 签名为上游 (fatal, proc, notify)——本地 proc-first
    // 形参退役;拒绝推进路径保持非致命,显式 proc 走第二参数、fatal=false。
    const sameAsSource = session.persistResumableSessionId(false, procSameAsSource)
    expect(sameAsSource).toContain('src-1')
    expect(boundResumes).toEqual([])

    const procSameAsPrevious = new FakeAgentProc('codex', 'prev-1')
    session.proc = procSameAsPrevious
    const sameAsPrevious = session.persistResumableSessionId(false, procSameAsPrevious)
    expect(sameAsPrevious).toContain('prev-1')
    expect(boundResumes).toEqual([])

    const procIndependent = new FakeAgentProc('codex', 'forked-new')
    session.proc = procIndependent
    expect(session.persistResumableSessionId(false, procIndependent)).toBeNull()
    expect(boundResumes).toEqual([['persist-independent-id', 'forked-new', 'codex']])
  })
})

describe('Session resume 绑定失效清理(4185808,挂账 #1/#4)', () => {
  const noRolloutError = (sessionId: string, method = 'thread/resume', code: number | null = -32600) =>
    new CodexRpcResponseError(method, 'req-1', code, `no rollout found for thread id ${sessionId}`)

  test('invalidateMissingCodexResume:直接实例/cause 链深处/AggregateError 内/循环 cause 四形态判定', () => {
    const session = new Session('invalidate-shapes', 'chat_id') as any
    session.selectedProvider = 'codex'
    const seed = () => {
      resumeRefs.set(`${session.sessionName}:codex`, { provider: 'codex', sessionId: 'ghost-1', cwd: null })
    }

    // 直接实例
    seed()
    expect(session.invalidateMissingCodexResume('ghost-1', noRolloutError('ghost-1')))
      .toContain('已作废无 rollout 的恢复点')
    expect(resumeRefs.has(`${session.sessionName}:codex`)).toBe(false)

    // cause 链深处
    seed()
    const nested = new Error('outer', { cause: new Error('mid', { cause: noRolloutError('ghost-1', 'thread/read') }) })
    expect(session.invalidateMissingCodexResume('ghost-1', nested)).toContain('已作废')
    expect(resumeRefs.has(`${session.sessionName}:codex`)).toBe(false)

    // AggregateError errors 数组内
    seed()
    const aggregate = new AggregateError([new Error('other'), noRolloutError('ghost-1', 'thread/fork')], 'combo')
    expect(session.invalidateMissingCodexResume('ghost-1', aggregate)).toContain('已作废')
    expect(resumeRefs.has(`${session.sessionName}:codex`)).toBe(false)

    // 循环 cause 不死循环:无 rpc error → 保留绑定
    seed()
    const a = new Error('a') as any
    const b = new Error('b') as any
    a.cause = b
    b.cause = a
    expect(session.invalidateMissingCodexResume('ghost-1', a)).toBeNull()
    expect(resumeRefs.has(`${session.sessionName}:codex`)).toBe(true)
  })

  test('invalidateMissingCodexResume 负例:message 差一字/其他 method/其他 code/绑定不匹配均保留', () => {
    const session = new Session('invalidate-negatives', 'chat_id') as any
    session.selectedProvider = 'codex'
    resumeRefs.set(`${session.sessionName}:codex`, { provider: 'codex', sessionId: 'ghost-1', cwd: null })

    // message 差一字(别的 thread id)
    expect(session.invalidateMissingCodexResume('ghost-1', noRolloutError('ghost-other'))).toBeNull()
    // 三列表之外的 method
    const wrongMethod = new CodexRpcResponseError('thread/start', 'req-2', -32600, 'no rollout found for thread id ghost-1')
    expect(session.invalidateMissingCodexResume('ghost-1', wrongMethod)).toBeNull()
    // 其他 serverCode
    expect(session.invalidateMissingCodexResume('ghost-1', noRolloutError('ghost-1', 'thread/resume', -32000))).toBeNull()
    // 绑定的 id 与失败 id 不匹配
    expect(session.invalidateMissingCodexResume('other-thread', noRolloutError('other-thread'))).toBeNull()
    expect(resumeRefs.get(`${session.sessionName}:codex`)?.sessionId).toBe('ghost-1')
    expect(clearedResumes).toEqual([])
  })

  test('codex resume 失败路径接线:确认无 rollout 的 ghost 绑定被作废且群内可观测', async () => {
    const session = new Session('invalidate-wiring', 'chat_id') as any
    session.selectedProvider = 'codex'
    session.lastSessionId = 'ghost-thread'
    session.lastSessionRef = { provider: 'codex', sessionId: 'ghost-thread', cwd: session.workDir }
    resumeRefs.set(`${session.sessionName}:codex`, { provider: 'codex', sessionId: 'ghost-thread', cwd: session.workDir })
    session.spawnAgent = () => {
      const proc = new FakeAgentProc('codex', null)
      proc.launchKind = 'resume'
      // 合并调和(取舍):no-rollout 失败改经 initialize 事务 promise 收口
      // (main 事件版恢复网关已随上游 session 恢复优化退役;上游 15694 号用例
      // 同型注入)。作废 ghost 绑定 + 群内可观测的语义不变。
      proc.initialization = Promise.reject(noRolloutError('ghost-thread'))
      return proc
    }
    const statuses: string[] = []

    const ok = await session.restart(true, { announce: false, onStatus: (s: string) => statuses.push(s) })

    expect(ok).toBe(false)
    expect(statuses.join('\n')).toContain('已作废无 rollout 的恢复点')
    expect(resumeRefs.has(`${session.sessionName}:codex`)).toBe(false)
    expect(session.lastSessionRef).toBeNull()
    expect(session.lastSessionId).toBeNull()
  })

  test('fresh Codex init 清 ghost 绑定:非 resumable 断言下经 checked 清理,resumable 即抛', () => {
    const session = new Session('codex-fresh-init', 'chat_id') as any
    const oldRef = { provider: 'codex' as const, sessionId: 'old-thread', cwd: session.workDir }
    resumeRefs.set(`${session.sessionName}:codex`, oldRef)
    session.selectedProvider = 'codex'
    session.lastSessionRef = oldRef
    session.lastSessionId = oldRef.sessionId
    const proc = new FakeAgentProc('codex', 'fresh-thread')
    proc.launchKind = 'fresh'
    proc.conversationResumableState = false
    session.proc = proc
    session.wireProc(proc)

    proc.emit('init', { session_id: proc.sessionId })

    expect(boundResumes).toEqual([])
    expect(clearedResumes).toContainEqual([session.sessionName, 'codex'])
    expect(resumeRefs.has(`${session.sessionName}:codex`)).toBe(false)
    expect(session.lastSessionRef).toBeNull()
    expect(session.lastSessionId).toBeNull()

    // resumable 的进程走 fresh 清理断言即抛(init 事务不含带 rollout 的进程)
    const resumable = new FakeAgentProc('codex', 'resumable-thread')
    resumable.launchKind = 'fresh'
    resumable.conversationResumableState = true
    session.proc = resumable
    expect(() => session.clearResumeBindingForFreshCodex(resumable))
      .toThrow('fresh Codex thread was unexpectedly marked resumable during init')
  })

  test('fresh 清理写失败可见:checked 清理抛出且绑定保留(04-02 回滚语义)', () => {
    const session = new Session('codex-fresh-clear-fails', 'chat_id') as any
    const oldRef = { provider: 'codex' as const, sessionId: 'old-thread', cwd: session.workDir }
    resumeRefs.set(`${session.sessionName}:codex`, oldRef)
    session.selectedProvider = 'codex'
    session.lastSessionRef = oldRef
    session.lastSessionId = oldRef.sessionId
    const proc = new FakeAgentProc('codex', 'fresh-thread')
    proc.launchKind = 'fresh'
    proc.conversationResumableState = false
    session.proc = proc
    session.wireProc(proc)
    setResumeWriteError(new Error('resume-map clear fsync failed'))

    try {
      expect(() => proc.emit('init', { session_id: proc.sessionId })).toThrow('resume-map clear fsync failed')
      expect(resumeRefs.get(`${session.sessionName}:codex`)).toEqual(oldRef)
      expect(session.lastSessionId).toBe('old-thread')
    } finally {
      setResumeWriteError(null)
    }
  })
})

describe('Session 簇 3 竞态甄别(上游 ff44afb 簇 3——五域代表例,04-05 首跑判决)', () => {
  // 甄别纪律(开放问题 1 锁定):五条上游竞态用例紧凑体适配本地 harness 首跑——
  // 绿=本地 01-14 opaque token / 03-03/03-04 close drain / cleanupStaleTurnOpen
  // 已等效覆盖,保留为防回归锚;红=只收使该用例转绿的最小 hunk。
  // 悬挂类 settlement 一律 settlementWithin race 包裹(01-09 patterns,bun 1.3.5
  // 悬挂 promise 忙旋 quirk)。
  //
  // ── 首跑判决(2026-09-03,基线 1427 之上)与收账裁决 ────────────────────
  // 1 TurnOpenOwner/#13    红→收 deferred close summary='✅ · ⏱ 0.0s',stateError
  //                          丢失 → suffix/forcePush 挂 owner token(#13 最小改法)
  // 2 TurnCloseSnapshot    红→收 旧 close 清 next turn reactions/读 live usage
  //                          → close 入口快照,不拆 finishTurnCardClose
  // 3 turnCloseInflight    红→收 在途 close 未完成 restart 已 spawn(spawned=1)
  //                          → 哨兵登记 + restart spawn 前 waitForTurnCloses
  // 4 BackgroundOpenOwner  红→收 旧 bg 开卡晚到复活为活卡,无终态化 PATCH
  //                          → backgroundOpenGeneration 世代化
  // 5 terminalizeSuperseded 绿→跳 01-14 owner token + cleanupStaleTurnOpen 等效
  //                          (⚪ 终态化 PATCH + 不清新 owner + currentTurn 落新卡)

  async function settlementWithin(promise: Promise<unknown>, timeoutMs = 3000): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        promise.then(() => 'resolved', (e: Error) => `rejected: ${e.message}`),
        new Promise<string>(resolve => {
          timer = setTimeout(() => resolve('hung'), timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  function makeRunningTask(id: string): any {
    return { id, type: 'shell', description: `bg ${id}`, status: 'running', startedAt: Date.now() - 5000, steps: [] }
  }

  // 红因(首跑):deferred close 走 closeTurnCard(undefined) — result handler 在
  // currentTurn=null 时算出的 '⚠️ 分叉 checkpoint 持久化失败' suffix/forcePush
  // 被丢弃,终态 summary 只有 '✅ · ⏱ 0.0s'。
  // 收账(Task 2):翻译表 #13 最小改法——suffix/forcePush 挂 owner token
  // (TurnOpenTerminalStash),deferred close 消费;转绿。
  test('result racing card open carries checkpoint persistence failure into deferred close(甄别来源=ff44afb 簇 3:TurnOpenOwner/翻译表 #13)', async () => {
    // 上游断言核心:result 抢在开卡 await 窗口内到达且 checkpoint 持久化失败时,
    // stateError 必须携带进 deferred close(owner.sawResult/terminalSuffix/
    // terminalForcePush)。本地无 owner 对象——行为化断言:deferred close 的终态
    // settings(streamingOff summary)携带持久化失败文案 + 强推仍发生。
    const session = new Session('anchor-write-open-race', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-current')
    session.selectedProvider = 'codex'
    session.proc = proc
    session.wireProc(proc)
    proc.lastResult = {
      cost_usd: null, cost_delta_usd: null, duration_ms: 1, num_turns: 1,
      usage: null, subtype: 'success', is_error: false,
    }

    let releaseConvert: () => void = () => {}
    const convertGate = new Promise<void>(resolve => { releaseConvert = resolve })
    let convertCount = 0
    const baseFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/cards/id_convert')) {
        convertCount++
        await convertGate
        return new Response(JSON.stringify({ code: 0, data: { card_id: 'card_open_race' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return baseFetch(input, init)
    }) as typeof fetch

    try {
      session.lastUserOpenId = 'ou_race_user'
      session.pendingUserMessageCount = 1
      session.pendingTurnInputs = ['race input']
      proc.emit('init', { session_id: 'thread-current' })
      await waitUntil(() => convertCount === 1)
      expect(session.openingTurn).toBe(true)

      setTurnAnchorWriteError(new Error('turn-map race failed'))
      proc.emit('result', {
        subtype: 'success', is_error: false, duration_ms: 1, usage: null,
        checkpoint: {
          provider: 'codex', kind: 'turn', id: 'turn-race',
          source: { provider: 'codex', sessionId: 'thread-current', cwd: session.workDir },
        },
      })
      // 上游 owner.sawResult 的本地等效:开卡窗口竞态标记已置。
      expect(session.sawResultWhileOpening).toBe(true)

      releaseConvert()
      // deferred close 收尾:终态 settings 必须携带持久化失败文案(上游
      // owner.terminalSuffix 等效),否则 ⚠️ 状态错误对用户不可见。
      await waitUntil(() => calls.some(c => c.method === 'PATCH' && c.path === '/cards/card_open_race/settings'))
      const settingsCall = calls.find(c => c.method === 'PATCH' && c.path === '/cards/card_open_race/settings')
      const summary = JSON.parse(settingsCall?.body.settings ?? '{}').config?.summary?.content ?? ''
      expect(summary).toContain('turn-map race failed')
      // 上游 owner.terminalForcePush 等效:带 ⚠️ suffix 的 deferred close 仍强推。
      expect(urgentPushes.length).toBeGreaterThan(0)
    } finally {
      setTurnAnchorWriteError(null)
      releaseConvert()
      globalThis.fetch = baseFetch
      if (session.currentTurn) await session.closeTurnCard('测试收尾')
    }
  })

  // 红因(首跑):closeTurnCard 收尾读 live 状态——flush 门后 footer/settings 读到
  // next turn 的 lastTurnDelta/lastTurnUsage,末段 release 清空的是 next turn 的
  // reactions 两 Map(currentBatchReactionIds 变 [])。
  // 收账(Task 2):close 入口同步快照(usage/context/reactions 所有权转移),终态
  // 写只读快照——不拆 finishTurnCardClose(陷阱 4);转绿。
  test('an old close snapshots usage and reactions without clearing the next turn(甄别来源=ff44afb 簇 3:TurnCloseSnapshot)', async () => {
    const session = new Session('close-snapshot', 'chat_id') as any
    const oldProc = new FakeAgentProc('codex', 'old-session')
    oldProc.lastUsage = { input_tokens: 100, output_tokens: 11, total_tokens: 111 } as any
    ;(oldProc as any).lastContextWindow = 1000
    session.proc = oldProc
    session.selectedProvider = 'codex'
    const oldTurn = turnState('card_close_snapshot_old')
    oldTurn.userOpenId = ''
    session.currentTurn = oldTurn
    session.lastTurnUsage = { input_tokens: 100, output_tokens: 11, total_tokens: 111 }
    session.lastTurnDelta = { tokens: 111, costUsd: 1.234, durationMs: 1000 }
    session.currentBatchReactionIds = new Map([['om_old_batch', 'rid_old_batch']])
    session.pendingReactionIds = new Map([['om_old_pending', 'rid_old_pending']])
    cardkit.recordCardCreated(oldTurn.cardId, 1)

    let signalFlushStarted: () => void = () => {}
    const flushStarted = new Promise<void>(resolve => { signalFlushStarted = resolve })
    let releaseFlush: () => void = () => {}
    const flushGate = new Promise<void>(resolve => { releaseFlush = resolve })
    const realFlush = cardkit.flush
    const flushSpy = spyOn(cardkit, 'flush').mockImplementation(async (cardId: string) => {
      if (cardId === oldTurn.cardId) {
        signalFlushStarted()
        await flushGate
      }
      await realFlush(cardId)
    })

    try {
      const closing = session.closeTurnCard(undefined, { hasFreshResult: true })
      await flushStarted

      // 本地 attachProc 等效:换 proc(无在途 open,无需 clearTurnOpening)。
      const newProc = new FakeAgentProc('codex', 'new-session')
      newProc.lastUsage = { input_tokens: 9000, output_tokens: 999, total_tokens: 9999 } as any
      session.proc = newProc
      const newTurn = turnState('card_close_snapshot_new')
      session.currentTurn = newTurn
      session.lastTurnUsage = { input_tokens: 9000, output_tokens: 999, total_tokens: 9999 }
      session.lastTurnDelta = { tokens: 9999, costUsd: 9.999, durationMs: 9000 }
      session.currentBatchReactionIds = new Map([['om_new_batch', 'rid_new_batch']])
      session.pendingReactionIds = new Map([['om_new_pending', 'rid_new_pending']])

      releaseFlush()
      expect(await settlementWithin(closing)).toBe('resolved')

      expect(session.currentTurn).toBe(newTurn)
      expect([...session.currentBatchReactionIds.entries()]).toEqual([['om_new_batch', 'rid_new_batch']])
      expect([...session.pendingReactionIds.entries()]).toEqual([['om_new_pending', 'rid_new_pending']])
      expect(deletedReactions).toContainEqual(['om_old_batch', 'rid_old_batch'])
      expect(deletedReactions).toContainEqual(['om_old_pending', 'rid_old_pending'])
      expect(deletedReactions).not.toContainEqual(['om_new_batch', 'rid_new_batch'])

      const footer = calls.find(call =>
        call.method === 'PUT' && call.path === `/cards/${oldTurn.cardId}/elements/footer`
      )
      const footerContent = JSON.parse(footer?.body.element ?? '{}').content as string
      expect(footerContent).toContain('$1.234')
      expect(footerContent).not.toContain('$9.999')
      const settingsCall = calls.find(call =>
        call.method === 'PATCH' && call.path === `/cards/${oldTurn.cardId}/settings`
      )
      const settings = JSON.parse(settingsCall?.body.settings ?? '{}')
      expect(settings.config.summary.content).toContain('📶 11')
      expect(settings.config.summary.content).not.toContain('999')
    } finally {
      releaseFlush()
      flushSpy.mockRestore()
      if (session.currentTurn) session.stopFooterStatus(session.currentTurn)
      session.currentTurn = null
      await cardkit.dispose(oldTurn.cardId)
    }
  })

  // 红因(首跑):restart 对已摘除 currentTurn 的在途 close 无感知,kill 后直接
  // spawn(50ms 调度窗内 spawned=1,旧卡 flush 仍被门控)。
  // 收账(Task 2):turnCloseInflight 哨兵登记 + restart spawn 前
  // waitForTurnCloses(stop/exit 未接线——首跑无红例,处置清单记差集);转绿。
  test('restart waits for a close that already removed currentTurn before spawning(甄别来源=ff44afb 簇 3:turnCloseInflight)', async () => {
    const session = new Session('restart-close-owner', 'chat_id') as any
    const oldProc = new FakeAgentProc('claude', 'old-session')
    const oldTurn = turnState('card_restart_close_owner', { provider: 'claude', model: null })
    oldTurn.userOpenId = ''
    session.proc = oldProc
    session.selectedProvider = 'claude'
    session.currentTurn = oldTurn
    cardkit.recordCardCreated(oldTurn.cardId, 1)

    let signalFlushStarted: () => void = () => {}
    const flushStarted = new Promise<void>(resolve => { signalFlushStarted = resolve })
    let releaseFlush: () => void = () => {}
    const flushGate = new Promise<void>(resolve => { releaseFlush = resolve })
    const realFlush = cardkit.flush
    const flushSpy = spyOn(cardkit, 'flush').mockImplementation(async (cardId: string) => {
      if (cardId === oldTurn.cardId) {
        signalFlushStarted()
        await flushGate
      }
      await realFlush(cardId)
    })
    const spawned: FakeAgentProc[] = []
    session.spawnAgent = () => {
      const proc = new FakeAgentProc('claude', `new-session-${spawned.length + 1}`)
      spawned.push(proc)
      return proc
    }
    session.waitForProcEarlyFailure = async () => ({ state: 'ready' })

    try {
      const oldClose = session.closeTurnCard('旧轮收尾')
      await flushStarted
      expect(session.currentTurn).toBeNull()

      const restarting = session.restart(false, { announce: false })
      await waitUntil(() => oldProc.killCalls === 1)
      // 上游 waitUntil 在 killCalls 置位前有真实 sleep 轮;本地 kill 同步完成,
      // 补一个有界调度窗:真等 close 的实现停在 flush 门上,不等的实现会在
      // 窗内 spawn——恢复上游断言的有效语义(spawn 不得先于在途 close 完成)。
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(spawned).toHaveLength(0)

      releaseFlush()
      expect(await settlementWithin(oldClose)).toBe('resolved')
      expect(await restarting).toBe(true)
      expect(spawned).toHaveLength(1)
      expect(session.proc).toBe(spawned[0])
    } finally {
      releaseFlush()
      flushSpy.mockRestore()
      if (session.proc?.isAlive?.()) await session.stop('测试收尾', { announce: false })
      await cardkit.dispose(oldTurn.cardId)
    }
  })

  // 红因(首跑):openBackgroundCard 落地无世代校验——reset 后晚到的旧 convert 把
  // card_bg_old 安装为活卡(日志 'background card opened cardId=card_bg_old
  // tasks=1'),其 finally 还清掉新开卡的 openingBackground 标记;旧卡永不终态化
  // (PATCH settings 等待超时)。
  // 收账(Task 2):backgroundOpenGeneration 世代化(开卡捕获/reset 作废/晚到自弃
  // 终态化,完整 owner 结构不移植);转绿。
  test('an old background open cannot revive after reset or clear a newer opening owner(甄别来源=ff44afb 簇 3:BackgroundOpenOwner)', async () => {
    const session = new Session('background-open-generation', 'chat_id') as any
    session.backgroundTasks = [makeRunningTask('old')]

    let releaseOldConvert: () => void = () => {}
    const oldConvertGate = new Promise<void>(resolve => { releaseOldConvert = resolve })
    let releaseNewConvert: () => void = () => {}
    const newConvertGate = new Promise<void>(resolve => { releaseNewConvert = resolve })
    let convertCount = 0
    const baseFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/cards/id_convert')) {
        const n = ++convertCount
        if (n === 1) await oldConvertGate
        if (n === 2) await newConvertGate
        return new Response(JSON.stringify({ code: 0, data: { card_id: n === 1 ? 'card_bg_old' : 'card_bg_new' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return baseFetch(input, init)
    }) as typeof fetch

    try {
      session.onBackgroundTaskChanged()
      await waitUntil(() => convertCount === 1)

      await session.resetBackgroundTasks()
      expect(session.backgroundCard).toBeNull()
      expect(session.openingBackground).toBe(false)

      session.backgroundTasks = [makeRunningTask('new')]
      session.onBackgroundTaskChanged()
      await waitUntil(() => convertCount === 2)

      releaseOldConvert()
      // 旧开卡晚到落地必须被终态化(streamingOff PATCH),不得复活为活卡。
      await waitUntil(() => calls.some(call =>
        call.method === 'PATCH' && call.path === '/cards/card_bg_old/settings'
      ))
      expect(session.backgroundCard).toBeNull()
      expect(session.openingBackground).toBe(true)

      releaseNewConvert()
      await waitUntil(() => session.backgroundCard?.cardId === 'card_bg_new' && !session.openingBackground)
      expect(session.backgroundTasks.map((task: any) => task.id)).toEqual(['new'])
    } finally {
      releaseOldConvert()
      releaseNewConvert()
      session.stopBackgroundRefreshTick()
      if (session.backgroundRefreshTimer) clearTimeout(session.backgroundRefreshTimer)
      session.backgroundRefreshTimer = null
      const cardId = session.backgroundCard?.cardId
      session.backgroundCard = null
      session.backgroundTasks = []
      if (cardId) await cardkit.dispose(cardId)
      globalThis.fetch = baseFetch
    }
  })

  test('an obsolete main-card open cannot replace a newer process turn or clear its opening owner(甄别来源=ff44afb 簇 3:terminalizeSupersededCard)', async () => {
    const session = new Session('stale-main-open', 'chat_id') as any
    const oldProc = new FakeAgentProc('claude', 'old-session')
    const newProc = new FakeAgentProc('claude', 'new-session')
    session.selectedProvider = 'claude'

    let releaseOldConvert: () => void = () => {}
    const oldConvertGate = new Promise<void>(resolve => { releaseOldConvert = resolve })
    let releaseNewConvert: () => void = () => {}
    const newConvertGate = new Promise<void>(resolve => { releaseNewConvert = resolve })
    let convertCount = 0
    const baseFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/cards/id_convert')) {
        const n = ++convertCount
        if (n === 1) await oldConvertGate
        if (n === 2) await newConvertGate
        return new Response(JSON.stringify({ code: 0, data: { card_id: n === 1 ? 'card_old_open' : 'card_new_open' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return baseFetch(input, init)
    }) as typeof fetch

    try {
      session.proc = oldProc
      session.wireProc(oldProc)
      session.lastUserOpenId = 'ou_user'
      session.pendingUserMessageCount = 1
      session.pendingTurnInputs = ['old input']
      oldProc.emit('init', { session_id: 'old-session' })
      await waitUntil(() => convertCount === 1)

      // 本地 attachProc 等效(上游 attachProc = invalidateTurnOpen + 换 proc +
      // wire;本地生产换代路径 stop/restart 均 clearTurnOpening 后再 spawn/wire):
      session.proc = newProc
      session.clearTurnOpening()
      session.wireProc(newProc)
      session.pendingUserMessageCount = 1
      session.pendingTurnInputs = ['new input']
      newProc.emit('init', { session_id: 'new-session' })
      await waitUntil(() => convertCount === 2)

      releaseOldConvert()
      await waitUntil(() => calls.some(call =>
        call.method === 'PATCH' && call.path === '/cards/card_old_open/settings'
      ))
      expect(session.currentTurn).toBeNull()
      expect(session.openingTurn).toBe(true)

      releaseNewConvert()
      await waitUntil(() => session.currentTurn?.cardId === 'card_new_open' && !session.openingTurn)
      expect(session.currentTurn.cardId).toBe('card_new_open')
      expect(session.proc).toBe(newProc)
    } finally {
      releaseOldConvert()
      releaseNewConvert()
      globalThis.fetch = baseFetch
      if (session.currentTurn) await session.closeTurnCard('测试收尾')
    }
  })
})

describe('agents command routing', () => {
  test('agents and agent route to showAgentIdentityPanel with userOpenId', async () => {
    const session = new Session('agents-panel-route', 'chat_id') as any
    const seen: string[] = []
    session.showAgentIdentityPanel = async (openId: string) => { seen.push(openId) }

    expect(await session.runCommand('agents', 'ou_op')).toBe(true)
    expect(await session.runCommand('agent', 'ou_op2')).toBe(true)
    expect(seen).toEqual(['ou_op', 'ou_op2'])
  })
})

describe('Session delegated-agent capability and cancel', () => {
  test('accepts only the live process capability and delegates cancellation', async () => {
    const cancellations: Array<[string, string, string]> = []
    const session = new Session('agent-capability', 'chat_id', {
      onCancelAgentRuns: async (name: string, chatId: string, reason: string) => {
        cancellations.push([name, chatId, reason])
      },
    }) as any
    session.proc = { isAlive: () => true }
    session.agentCapability = 'secret-capability'

    expect(session.acceptsAgentCapability('secret-capability')).toBe(true)
    expect(session.acceptsAgentCapability('wrong')).toBe(false)
    expect(session.acceptsAgentCapability('secret-capabilitx')).toBe(false)
    session.proc = { isAlive: () => false }
    expect(session.acceptsAgentCapability('secret-capability')).toBe(false)

    await session.cancelAgentRuns('stop')
    expect(cancellations).toEqual([['agent-capability', 'chat_id', 'stop']])
  })

  test('spawnAgent injects LODESTAR_AGENT_* hostEnv into Claude process', () => {
    const session = new Session('spawn-hostenv', 'chat_id') as any
    session.selectedProvider = 'claude'
    const proc = session.spawnAgent()
    expect(proc.opts.hostEnv.LODESTAR_AGENT_URL).toMatch(/^http:\/\//)
    expect(typeof proc.opts.hostEnv.LODESTAR_AGENT_CAPABILITY).toBe('string')
    expect(proc.opts.hostEnv.LODESTAR_AGENT_CAPABILITY.length).toBeGreaterThan(20)
    expect(proc.opts.hostEnv.LODESTAR_AGENT_SESSION).toBe('spawn-hostenv')
    expect(session.agentCapability).toBe(proc.opts.hostEnv.LODESTAR_AGENT_CAPABILITY)
  })

  test('stop with runningAgy still calls onCancelAgentRuns before stopAgyTask and does not kill the main process', async () => {
    const order: string[] = []
    let killed = false
    const session = new Session('stop-agy-cancel', 'chat_id', {
      onCancelAgentRuns: async () => { order.push('cancel') },
    }) as any
    session.runningAgy = { id: 'agy1' }
    session.proc = {
      provider: 'claude',
      isAlive: () => true,
      kill: async () => { killed = true },
    }
    session.stopAgyTask = async () => {
      order.push('agy')
      return true
    }
    session.openStatusCard = async () => null
    session.closeStatusCard = async () => {}
    session.closeTurnCard = async () => {}

    expect(await session.runCommand('stop')).toBe(true)
    expect(order[0]).toBe('cancel')
    expect(order).toContain('agy')
    expect(killed).toBe(false)
  })

  test('idle rs lists history and does not cancel delegated agent runs', async () => {
    let cancelCalls = 0
    let listCalled = false
    const session = new Session('idle-rs-no-cancel', 'chat_id', {
      onCancelAgentRuns: async () => { cancelCalls++ },
    }) as any
    session.proc = { isAlive: () => true, provider: 'claude' }
    session.currentTurn = null
    session.pendingUserMessageCount = 0
    session.pendingMidTurnMsgs = []
    session.runningAgy = false
    session.showResumeList = async () => { listCalled = true }
    session.restart = async () => { throw new Error('idle rs must not restart') }

    await session.runCommand('rs')
    expect(listCalled).toBe(true)
    expect(cancelCalls).toBe(0)
  })

  test('Session.stop cancels agent runs even when idle with no proc', async () => {
    const reasons: string[] = []
    const session = new Session('idle-stop-cancel', 'chat_id', {
      onCancelAgentRuns: async (_name: string, _chatId: string, reason: string) => {
        reasons.push(reason)
      },
    }) as any
    session.proc = null
    await session.stop('idle stop', { announce: false })
    expect(reasons).toEqual(['idle stop'])
  })

  test('in-progress restart cancels agent runs beside stopAgyTask', async () => {
    const order: string[] = []
    const session = new Session('restart-cancel', 'chat_id', {
      onCancelAgentRuns: async () => { order.push('cancel') },
    }) as any
    session.currentTurn = turnState('card-restart-cancel')
    session.pendingUserMessageCount = 1
    session.pendingMidTurnMsgs = []
    session.runningAgy = { id: 'agy' }
    session.proc = { isAlive: () => true, provider: 'claude' }
    session.stopAgyTask = async () => { order.push('agy'); return true }
    session.restart = async () => { order.push('restart'); return true }
    session.openStatusCard = async () => null
    session.closeStatusCard = async () => {}
    session.setStatusCard = () => {}
    session.withModel = (s: string) => s
    session.backendLabel = () => 'claude'
    session.currentProvider = () => 'claude'

    await session.runCommand('rs')
    expect(order[0]).toBe('cancel')
    expect(order).toContain('agy')
    expect(order).toContain('restart')
  })

  test('unexpected proc exit cancels agent runs', async () => {
    const reasons: string[] = []
    const session = new Session('exit-cancel', 'chat_id', {
      onCancelAgentRuns: async (_name: string, _chatId: string, reason: string) => {
        reasons.push(reason)
      },
    }) as any
    const proc = new FakeAgentProc('codex', 'thread-exit')
    session.proc = proc
    session.wireProc(proc)
    proc.emit('exit', { code: 1, signal: null, expected: false })
    await waitFor(() => reasons.length > 0)
    expect(reasons[0]).toMatch(/codex process exited/)
  })
})

describe('Session DSH backend wiring (upstream 722e45a)', () => {
  function withDshSection(section: any): () => void {
    const prev = (config as any).deepseek_harness
    ;(config as any).deepseek_harness = section
    return () => { (config as any).deepseek_harness = prev }
  }

  test('DSH human dispatch 走 queued/dsh 的 commit 路径而不是被判 mismatched 拒收', async () => {
    const { session, proc, batch } = pendingHumanDrainFixture('dsh')

    expect(await session.drainMidTurnAndOpen()).toBe('committed')
    expect(proc.sentTexts).toEqual([`${batch[0]!.wireText}\n\n${batch[1]!.wireText}`])
    expect(session.pendingMidTurnMsgs).toEqual([])
    expect(session.pendingUserMessageCount).toBe(1)
    expect(session.ackedHumanDelivery?.turn).toBe(session.currentTurn)
  })

  test('DSH system dispatch 接受 queued/dsh;codex 的 queued 仍被拒,所有者校验保持', async () => {
    const session = new Session('dsh-system-dispatch', 'chat_id') as any
    const proc = new FakeAgentProc('dsh', 'dsh-session')
    session.selectedProvider = 'dsh'
    session.proc = proc
    session.status = 'idle'
    session.wireProc(proc)

    expect(await session.startHostAskContinuation('（用户回答）继续原任务', proc)).toBe('started')
    expect(proc.sentTexts).toContain('（用户回答）继续原任务')
    expect(session.status).toBe('working')
    expect(session.pendingUserMessageCount).toBe(1)

    // 所有权校验保持:非当前进程 → stale,且不投递
    const foreign = new FakeAgentProc('dsh', 'dsh-session')
    expect(await session.startHostAskContinuation('（用户回答）继续原任务', foreign)).toBe('stale')
    expect(foreign.sentTexts).toEqual([])

    // 其它 provider 的 queued 分支逐字不变:codex 伪造 queued 仍被拒
    const codexSession = new Session('codex-queued-still-rejected', 'chat_id') as any
    const codexProc = new FakeAgentProc('codex', 'thread-codex-queued')
    codexSession.selectedProvider = 'codex'
    codexSession.proc = codexProc
    codexSession.status = 'idle'
    codexSession.wireProc(codexProc)
    // 伪造非法运行形态(queued 只允许 claude/dsh)以核对 session 侧拒绝分支,故宽化过检。
    codexProc.dispatchFactory = () =>
      ({ kind: 'queued', provider: 'codex' } as unknown as UserTextDispatch)
    expect(await codexSession.startHostAskContinuation('system input', codexProc)).toBe('failed')
  })

  test('DSH 不能替换忙碌中的 Claude 进程(上游同名用例意图)', async () => {
    const restore = withDshSection({ api_key: 'dsh-key', model: 'deepseek-v4-pro', effort: 'max' })
    try {
      const session = new Session('dsh-busy-claude', 'chat_id') as any
      const proc = new FakeAgentProc('claude', 'claude-session')
      session.proc = proc
      session.selectedProvider = 'claude'
      session.selectedModel = 'claude:fable'
      session.currentTurn = turnState('card-busy-claude', { provider: 'claude' })

      const result = await session.onModelEffortSelect('deepseek-v4-pro', 'max', '', 'ou_user', 'dsh')

      expect(result.ok).toBe(false)
      expect(proc.killCalls).toBe(0)
      expect(session.selectedProvider).toBe('claude')
      expect(session.selectedModel).not.toBe('deepseek-v4-pro')
    } finally { restore() }
  })

  test('dshEffortForSpawn 取 DSH 合法值;两处都取不到时抛错而不是回落 Codex effort', () => {
    const restore = withDshSection({ api_key: 'dsh-key', model: 'deepseek-v4-pro' })
    try {
      const session = new Session('dsh-effort', 'chat_id') as any
      session.selectedProvider = 'dsh'

      session.selectedEffort = 'off'
      expect(session.dshEffortForSpawn()).toBe('off')

      // 合并调和(取舍):合并后 DSH 词表 = 上游 7 档(off/minimal/low/medium/high/
      // xhigh/max,agent-process.ts 头注),xhigh 已属合法值 —— 非法探针换成
      // 7 档之外的 'ultra'。「取不到即抛、绝不回落 Codex 的 max」语义不变。
      session.selectedEffort = 'ultra'
      expect(() => session.dshEffortForSpawn()).toThrow('DSH model reasoning effort is unavailable')

      ;(config as any).deepseek_harness = { api_key: 'dsh-key', model: 'deepseek-v4-pro', effort: 'high' }
      expect(session.dshEffortForSpawn()).toBe('high')
    } finally { restore() }
  })

  test('currentContextTokens 对 dsh 读 input 侧占用,不落到 Codex 的 total_tokens', () => {
    const session = new Session('dsh-context-tokens', 'chat_id') as any
    session.proc = { provider: 'dsh', lastContextTokens: 12345, lastUsage: { total_tokens: 99999 } }
    expect(session.currentContextTokens()).toBe(12345)

    // codex 路径逐字不变:仍只认 lastUsage.total_tokens,不读 lastContextTokens
    session.proc = { provider: 'codex', lastContextTokens: 12345, lastUsage: null }
    expect(session.currentContextTokens()).toBeNull()
  })

  test('spawnAgent(undefined, "dsh") 构造 DshProcess;源缺失时 fail closed 不回落 codex', () => {
    const restore = withDshSection({ api_key: 'dsh-key', model: 'deepseek-v4-pro', effort: 'high' })
    try {
      const session = new Session('dsh-spawn-construct', 'chat_id') as any
      session.selectedProvider = 'dsh'
      session.selectedModel = 'deepseek-v4-pro'
      session.selectedEffort = 'high'

      const proc = session.spawnAgent(undefined, 'dsh') as any

      expect(proc.provider).toBe('dsh')
      expect(proc.opts.tokenSourceId).toBe('deepseek-harness')
      expect(proc.opts.model).toBe('deepseek-v4-pro')
      expect(proc.opts.effort).toBe('high')
      expect(proc.opts.workDir).toBe(session.workDir)
      expect(typeof proc.opts.transformEnv).toBe('function')
      const env = proc.opts.transformEnv({ ANTHROPIC_API_KEY: 'stray', DEEPSEEK_API_KEY: 'old' })
      expect(Object.keys(env).filter((key: string) => key.startsWith('ANTHROPIC_'))).toEqual([])
      expect(env.DEEPSEEK_API_KEY).toBe('dsh-key')
    } finally { restore() }

    const unconfigured = withDshSection(undefined)
    try {
      const session = new Session('dsh-spawn-unconfigured', 'chat_id') as any
      session.selectedProvider = 'dsh'
      session.selectedModel = 'deepseek-v4-pro'
      session.selectedEffort = 'high'
      expect(() => session.spawnAgent(undefined, 'dsh'))
        .toThrow('DSH token source is unavailable')
    } finally { unconfigured() }
  })

  test('listDshConversations 只在 dsh 会话下工作,并过滤 lodestar 自己的委派会话', async () => {
    const restore = withDshSection({ api_key: 'dsh-key', model: 'deepseek-v4-pro', effort: 'high' })
    dshCatalogRows = []
    dshCatalogQueries.length = 0
    try {
      const session = new Session('dsh-history', 'chat_id') as any
      session.selectedProvider = 'claude'
      await expect(session.listDshConversations())
        .rejects.toThrow('DSH history requested under a different provider')

      session.selectedProvider = 'dsh'
      session.selectedModel = 'deepseek-v4-pro'
      resetAgentSessionRegistryForTest(['dsh:delegated-1'])
      dshCatalogRows = [
        { provider: 'dsh', sessionId: 'delegated-1', cwd: session.workDir, preview: '委派会话', ts: 2 },
        { provider: 'dsh', sessionId: 'user-1', cwd: session.workDir, preview: '用户会话', ts: 1 },
      ]

      const rows = await session.listDshConversations()

      expect(rows.map((row: any) => row.sessionId)).toEqual(['user-1'])
      expect(dshCatalogQueries).toEqual([{ method: 'session/list', params: { cwd: session.workDir } }])
    } finally {
      resetAgentSessionRegistryForTest([])
      dshCatalogRows = []
      dshCatalogQueries.length = 0
      restore()
    }
  })

  test('dsh 控制台余额走 provider 通道的 DeepSeek /user/balance,不查 Claude profile', async () => {
    const restore = withDshSection({
      api_key: 'dsh-balance-key',
      base_url: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      effort: 'high',
    })
    const passthrough = globalThis.fetch
    const balanceRequests: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.host === 'api.deepseek.com') {
        balanceRequests.push(url.toString())
        return new Response(JSON.stringify({
          is_available: true,
          balance_infos: [{
            currency: 'CNY',
            total_balance: '66.88',
            granted_balance: '0.00',
            topped_up_balance: '66.88',
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return await passthrough(input, init)
    }) as typeof fetch
    try {
      const session = new Session('console-usage-dsh', 'chat_id') as any
      session.selectedProvider = 'dsh'
      session.selectedModel = 'deepseek-v4-pro'
      session.selectedEffort = 'high'
      const snapshot = await session.buildConsoleOpts(undefined)
      const cardId = 'card_console_usage_dsh'
      cardkit.recordCardCreated(cardId, 4)

      await session.patchConsoleUsage(cardId, snapshot)
      await cardkit.flush(cardId)

      expect(balanceRequests).toEqual(['https://api.deepseek.com/user/balance'])
      // 合并调和(取舍):合并后 console 额度元素走上游「全部账号额度」聚合面板
      // (accountUsages 在场时 markdown 行不再渲染,cards/console.ts 双源注释),
      // dsh 余额作为 deepseek-harness 行补进面板 —— 本地 `[deepseek-harness]`
      // 段不进注册表,聚合读数看不到它。核心语义不变:余额值上卡(¥ 66.88),
      // 且只查一次 DeepSeek /user/balance,不查 Claude profile。
      const panel = calls
        .filter(call => call.method === 'PUT' && call.path === `/cards/${cardId}/elements/console_usage`)
        .map(call => JSON.parse(call.body.element))
        .at(-1)
      expect(panel.tag).toBe('collapsible_panel')
      expect(panel.element_id).toBe('console_usage')
      expect(panel.elements.map((el: any) => el.content).join('\n')).toContain('余额 ¥ 66.88')
      await cardkit.dispose(cardId)
    } finally {
      globalThis.fetch = passthrough
      restore()
    }
  })
})

describe('Session DSH model panel and console (upstream 722e45a)', () => {
  function withDshSection(section: any): () => void {
    const prev = (config as any).deepseek_harness
    ;(config as any).deepseek_harness = section
    return () => { (config as any).deepseek_harness = prev }
  }

  test('DSH 档位进固定选项:off 可选中(effort 非 Codex 常量),medium/xhigh 被拒', async () => {
    const restore = withDshSection({ api_key: 'dsh-key', model: 'deepseek-v4-pro', effort: 'off' })
    try {
      const session = new Session('dsh-panel-off', 'chat_id') as any
      const dsh = fixedModelChoices(session).find(choice => choice.provider === 'dsh')

      expect(dsh).toBeDefined()
      expect(dsh!.model).toBe('deepseek-v4-pro')
      expect(dsh!.efforts[0]!.effort).toBe('off')

      // 合并调和(取舍):合并后 DSH 词表 = 上游 7 档(agent-process.ts 头注),
      // medium/xhigh 已是合法档位值 —— 仍被「固定选项二元锁死」拒绝(非该档位
      // 锁定的 effort),口径从词表错误改为「不在固定选项中」;词表门改用 7 档外
      // 的 'ultra' 覆盖(仍报 'DSH reasoning effort 无效')。
      const medium = await session.onModelEffortSelect('deepseek-v4-pro', 'medium', '', 'ou_user', 'dsh')
      expect(medium.ok).toBe(false)
      expect(medium.message).toBe('DeepSeek Harness · deepseek-v4-pro/medium 不在固定选项中')
      const xhigh = await session.onModelEffortSelect('deepseek-v4-pro', 'xhigh', '', 'ou_user', 'dsh')
      expect(xhigh.ok).toBe(false)
      expect(xhigh.message).toBe('DeepSeek Harness · deepseek-v4-pro/xhigh 不在固定选项中')
      const ultra = await session.onModelEffortSelect('deepseek-v4-pro', 'ultra', '', 'ou_user', 'dsh')
      expect(ultra.ok).toBe(false)
      expect(ultra.message).toBe('DSH reasoning effort 无效')

      const result = await session.onModelEffortSelect('deepseek-v4-pro', 'off', '', 'ou_user', 'dsh')

      expect(result.ok).toBe(true)
      expect(session.selectedProvider).toBe('dsh')
      expect(session.selectedModel).toBe('deepseek-v4-pro')
      expect(session.selectedEffort).toBe('off')
      expect(session.currentEffortLabel()).toBe('off')
      expect(JSON.stringify(result.card)).toContain('DeepSeek Harness')
    } finally { restore() }
  })

  test('未配置 DSH 时档位仍可见,选择被拦截且提示指向 [deepseek-harness]', async () => {
    const restore = withDshSection(undefined)
    try {
      const session = new Session('dsh-panel-unconfigured', 'chat_id') as any
      const dsh = fixedModelChoices(session).find(choice => choice.provider === 'dsh')

      expect(dsh).toBeDefined()
      expect(dsh!.model).toBe('deepseek-v4-pro')
      expect(String(dsh!.description)).toContain('[deepseek-harness]')

      const result = await session.onModelEffortSelect(
        'deepseek-v4-pro', dsh!.efforts[0]!.effort, '', 'ou_user', 'dsh',
      )

      expect(result.ok).toBe(false)
      expect(result.message).toContain('[deepseek-harness]')
      expect(session.selectedProvider).not.toBe('dsh')
    } finally { restore() }
  })

  test('currentEffortLabel 对 DSH 会话取 DSH 语义值,而不是 Codex 回落常量', () => {
    const restore = withDshSection({ api_key: 'dsh-key', model: 'deepseek-v4-pro', effort: 'low' })
    try {
      const session = new Session('dsh-effort-label', 'chat_id') as any
      session.selectedProvider = 'dsh'
      session.selectedModel = 'deepseek-v4-pro'
      session.selectedEffort = null

      expect(session.currentEffortLabel()).toBe('low')

      session.selectedEffort = 'off'
      expect(session.currentEffortLabel()).toBe('off')
    } finally { restore() }
  })

  test('控制台:DSH 余额占位、DeepSeek Harness 分组与 provider 标签', async () => {
    const cards = await import('./cards')

    const placeholder = cards.consoleUsageElement({
      sessionName: 'dsh-console', status: 'idle', provider: 'dsh', usageSource: 'provider',
    }) as any
    expect(placeholder.content).toContain('📊 余额')
    expect(placeholder.content).toContain('加载中')

    const panel = JSON.stringify(cards.modelSelectionPanelElement({
      sessionName: 'dsh-console',
      panelId: 'panel-dsh-console',
      currentModel: 'deepseek-v4-pro',
      currentEffort: 'off',
      models: [
        {
          provider: 'codex',
          model: 'gpt-5.6-sol',
          displayName: 'Codex · GPT-5.6 Sol',
          efforts: [{ effort: 'max', isDefault: true }],
        },
        {
          provider: 'dsh',
          model: 'deepseek-v4-pro',
          displayName: 'DeepSeek Harness · deepseek-v4-pro',
          efforts: [{ effort: 'off', isDefault: true }],
          isDefault: true,
        },
      ],
    }))
    expect(panel).toContain('DeepSeek Harness')
    expect(panel).toContain('DeepSeek Harness 默认')

    const result = JSON.stringify(cards.modelResultPanelElement({
      sessionName: 'dsh-console',
      provider: 'dsh',
      model: 'deepseek-v4-pro',
      effort: 'off',
      scope: '下一轮开始使用。',
    }))
    expect(result).toContain('DeepSeek Harness · deepseek-v4-pro/off')

    // 既有分组语义不变:两组仍按 provider 过滤渲染
    const claudeOnly = JSON.stringify(cards.modelSelectionPanelElement({
      sessionName: 'claude-console',
      panelId: 'panel-claude-console',
      currentModel: 'claude:fable',
      currentEffort: 'max',
      models: [{
        provider: 'claude',
        model: 'claude:fable',
        displayName: 'Claude · Fable 5',
        efforts: [{ effort: 'max', isDefault: true }],
      }],
    }))
    expect(claudeOnly).not.toContain('DeepSeek Harness')
  })
})


describe('Session 非容量失败通知按键去重 (上游 378f4a4)', () => {
  const nonCapacityMeta = (
    cardId: string,
    elementId: string,
    operation = 'addElement',
    code = 300315,
  ): any => ({
    kind: 'api',
    failure: {
      cardId, operation, elementId, code,
      message: 'elementID format error; code: 300301',
    },
  })

  test('同一非容量失败重复到达只通知一次', async () => {
    const session = new Session('notice-dedupe-same', 'chat_id') as any
    session.proc = new FakeAgentProc('claude', 'claude-notice-dedupe-same')
    const turn = turnState('card_notice_same')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    try {
      const meta = nonCapacityMeta(turn.cardId, 'ctx_dup')
      session.onCardWriteFailure(turn.cardId, 300315, meta)
      session.onCardWriteFailure(turn.cardId, 300315, meta)
      // 新对象、同四段键 —— 仍算同一个失败
      session.onCardWriteFailure(turn.cardId, 300315, nonCapacityMeta(turn.cardId, 'ctx_dup'))

      expect(sentRawTexts).toHaveLength(1)
      expect(turn.cardWriteFailureNotices.size).toBe(1)
      expect(turn.rotating).toBeNull()
      expect(turn.failureRotateCount).toBe(0)
      expect(turn.cardId).toBe('card_notice_same')
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('元素/操作/错误码任一不同即各自通知 —— 旧的布尔模型会吞掉后一个', async () => {
    const session = new Session('notice-dedupe-distinct', 'chat_id') as any
    session.proc = new FakeAgentProc('claude', 'claude-notice-dedupe-distinct')
    const turn = turnState('card_notice_distinct')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    try {
      session.onCardWriteFailure(turn.cardId, 300315, nonCapacityMeta(turn.cardId, 'seg_a'))
      session.onCardWriteFailure(turn.cardId, 300315, nonCapacityMeta(turn.cardId, 'seg_b'))
      session.onCardWriteFailure(turn.cardId, 300315, nonCapacityMeta(turn.cardId, 'seg_a', 'replaceElement'))
      session.onCardWriteFailure(turn.cardId, 200570, nonCapacityMeta(turn.cardId, 'seg_a', 'addElement', 200570))

      expect(sentRawTexts).toHaveLength(4)
      expect(turn.cardWriteFailureNotices.size).toBe(4)
      expect(turn.rotating).toBeNull()
      expect(turn.failureRotateCount).toBe(0)
      // 每次通知仍只用本地口径(错误码 + 操作类别),不内插 API 原文
      for (const text of sentRawTexts) {
        expect(text).toContain('不是卡片元素上限')
        expect(text).not.toContain('elementID format error')
      }
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })
})

describe('Session 容量指纹换卡与开卡失败两级阶梯 (上游 378f4a4)', () => {
  const jsonRes = (body: object): Response => new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  })

  const capacityMeta = (cardId: string, fingerprint?: string, code = 300305): any => ({
    kind: 'api',
    failure: {
      cardId,
      operation: 'addElement',
      elementId: 'assistant_0',
      code,
      message: 'number of card components exceeds the limit',
      ...(fingerprint === undefined ? {} : { capacityFingerprint: fingerprint }),
    },
  })

  function capacitySession(name: string, cardId: string): { session: any; turn: any } {
    const session = new Session(name, 'chat_id') as any
    session.proc = new FakeAgentProc('claude', `claude-${name}`)
    const turn = turnState(cardId)
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(cardId, 1)
    return { session, turn }
  }

  test('首次容量失败登记指纹并换卡;同一指纹再次到达不再烧预算', async () => {
    const { session, turn } = capacitySession('fp-dedupe', 'card_fp_old')
    try {
      session.onCardWriteFailure(turn.cardId, 300305, capacityMeta(turn.cardId, 'fp-same-payload'))
      expect(turn.cardCapacityFailures.get('fp-same-payload')).toBe(false)
      expect(turn.failureRotateCount).toBe(1)
      await turn.rotating
      const newCardId = turn.cardId
      expect(newCardId).not.toBe('card_fp_old')
      expect(sentRawTexts).toHaveLength(0)

      // 同一载荷在新卡上又被拒:不换卡、不递增预算,补一次用户通知
      session.onCardWriteFailure(newCardId, 300305, capacityMeta(newCardId, 'fp-same-payload'))
      expect(turn.failureRotateCount).toBe(1)
      expect(turn.rotating).toBeNull()
      expect(turn.cardId).toBe(newCardId)
      expect(turn.cardCapacityFailures.get('fp-same-payload')).toBe(true)
      expect(sentRawTexts).toHaveLength(1)
      expect(sentRawTexts[0]).toContain('仍超出飞书容量')
      expect(sentRawTexts[0]).toContain('300305')
      // 合并调和(取舍):合并实现在本分支采用上游 378f4a4 合成文案(本地前缀 +
      // formatFeishuError 诊断尾)。同套件上游用例(an oversized compaction
      // completion…,已钉 'message=…'/log_id=MISS)要求该尾在位,与本地旧断言
      // not.toContain(响应原文)互斥;按合并实现对齐。凭据安全口径仍由非容量
      // 分支承担(该分支只用失败分类摘要,绝不内插原文)。
      expect(sentRawTexts[0]).toContain('message=number of card components exceeds the limit')
      // 第三次同指纹:已经报过,不再重复通知
      session.onCardWriteFailure(newCardId, 300305, capacityMeta(newCardId, 'fp-same-payload'))
      expect(sentRawTexts).toHaveLength(1)
      expect(turn.failureRotateCount).toBe(1)
    } finally {
      if (turn.rotating) await turn.rotating
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('指纹未见的容量失败照旧换卡,不写容量记账', async () => {
    const { session, turn } = capacitySession('fp-absent', 'card_fp_absent')
    try {
      session.onCardWriteFailure(turn.cardId, 300305, capacityMeta(turn.cardId))
      expect(turn.cardCapacityFailures.size).toBe(0)
      expect(turn.failureRotateCount).toBe(1)
      await turn.rotating
      expect(turn.cardId).not.toBe('card_fp_absent')
    } finally {
      if (turn.rotating) await turn.rotating
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('换卡后旧卡留有非携带内容则清空容量记账', async () => {
    const { session, turn } = capacitySession('retired-clear', 'card_retired_old')
    try {
      // 旧卡上已有定稿正文(非携带段):换卡后它留在旧卡 = 真实分页进度
      session.appendAssistant('早已写好的段落')
      session.finalizeCurrentAssistantSegment()
      await cardkit.flush('card_retired_old')
      expect(cardkit.getWrittenContentElementIds('card_retired_old')).toContain('assistant_0')

      turn.cardCapacityFailures.set('fp-stale', false)
      session.startMidTurnRotate(turn)
      await turn.rotating

      expect(turn.cardId).not.toBe('card_retired_old')
      expect(turn.cardCapacityFailures.size).toBe(0)
    } finally {
      if (turn.rotating) await turn.rotating
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('开新卡失败先暂停重试(旧卡仍可写);重试再失败才 give-up 止损', async () => {
    const { session, turn } = capacitySession('rotate-open-fail', 'card_open_fail')
    feishuMockState.sendCard = async () => null
    try {
      session.onCardWriteFailure(turn.cardId, 300305, capacityMeta(turn.cardId, 'fp-open-fail'))
      await turn.rotating

      // 一级:暂停 footer + 用户提示,旧卡不写死、不进入最终 give-up
      expect(turn.cardRotationFailed).toBe(true)
      expect(turn.rotateGivenUp).toBe(false)
      expect(turn.footerStatusHandle).toBeNull()
      expect(sentRawTexts).toHaveLength(1)
      expect(sentRawTexts[0]).toContain('再次尝试')
      expect(sentRawTexts[0]).not.toContain('仅日志可见')
      const before = calls.length
      await cardkit.addElement('card_open_fail', {
        tag: 'markdown', element_id: 'probe_still_writable', content: 'x',
      })
      expect(calls.length).toBeGreaterThan(before)

      // 二级:重试仍失败 → 本地 give-up 止损(rotateGivenUp + markCardWriteDead)
      session.startMidTurnRotate(turn)
      await turn.rotating
      expect(turn.rotateGivenUp).toBe(true)
      expect(sentRawTexts).toHaveLength(2)
      expect(sentRawTexts[1]).toContain('仅日志可见')
      const after = calls.length
      await cardkit.addElement('card_open_fail', {
        tag: 'markdown', element_id: 'probe_dead', content: 'x',
      })
      expect(calls.length).toBe(after)
    } finally {
      feishuMockState.sendCard = null
      if (turn.rotating) await turn.rotating
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('cardRotationFailed 时无视元素软上限触发重试,成功后复位并可恢复 footer', async () => {
    const { session, turn } = capacitySession('retry-soft-limit', 'card_retry_soft')
    try {
      // 元素数远低于软上限(1 < 50):只有 cardRotationFailed 分支能放行
      expect(cardkit.getElementCount(turn.cardId)).toBeLessThan(50)
      turn.cardRotationFailed = true
      session.maybeMidTurnRotate()

      expect(turn.rotating).not.toBeNull()
      expect(turn.rotateCount).toBe(1)
      await turn.rotating

      expect(turn.cardId).not.toBe('card_retry_soft')
      expect(turn.cardRotationFailed).toBe(false)
      session.startThinkingFooter(turn)
      expect(turn.footerStatusHandle).not.toBeNull()
    } finally {
      if (turn.rotating) await turn.rotating
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('swap 同步点恢复 live buffer 并复位 cardRotationFailed;迁移窗口 delta 追加不丢', async () => {
    const session = new Session('rotate-sync-carry', 'chat_id') as any
    session.proc = new FakeAgentProc('claude', 'claude-rotate-sync-carry')
    const oldCardId = 'card_sync_old'
    const newCardId = 'card_sync_new'
    const turn = turnState(oldCardId)
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(oldCardId, 1)
    turn.cardRotationFailed = true

    let signalMigration: () => void = () => {}
    const migrationStarted = new Promise<void>(resolve => { signalMigration = resolve })
    let releaseMigration: () => void = () => {}
    const migrationGate = new Promise<void>(resolve => { releaseMigration = resolve })
    let migrationGated = false
    // POST /elements 的元素体在 body.elements(JSON 字符串)里,不是顶层字段
    const postedIds = (body: any): string[] => {
      try {
        return (JSON.parse(String(body?.elements ?? '[]')) as any[]).map(el => String(el?.element_id ?? ''))
      } catch { return [] }
    }

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      const body = init?.body ? JSON.parse(String(init.body)) : null
      calls.push({ method, path, body })
      if (path === '/cards/id_convert') return jsonRes({ code: 0, data: { card_id: newCardId } })
      // 旧卡上先放一个"创建失败"的段 → 迁移循环会 await 重建它 = 迁移窗口
      if (method === 'POST' && path === `/cards/${oldCardId}/elements` && postedIds(body).includes('assistant_0')) {
        return jsonRes({ code: 300315, msg: 'elementID format error; code: 300301' })
      }
      if (
        method === 'POST' && path === `/cards/${newCardId}/elements` &&
        postedIds(body).some(id => id.startsWith('assistant_')) && !migrationGated
      ) {
        migrationGated = true
        signalMigration()
        await migrationGate
      }
      return jsonRes({ code: 0, data: {} })
    }) as typeof fetch

    try {
      await cardkit.addElement(oldCardId, { tag: 'markdown', element_id: 'assistant_0', content: '旧卡坏段' })
      expect(cardkit.isDeadElement(oldCardId, 'assistant_0')).toBe(true)
      // 死段要有正文才进旧卡迁移循环(它是 swap 的 await 点 = 迁移窗口;
      // 携带段本身会被循环跳过,所以必须另有一段)
      turn.segmentTexts.set('assistant_0', '旧卡坏段')
      turn.assistantSegmentCount = 1

      session.appendAssistant('  前缀  ')
      expect(turn.currentAssistantSegmentId).toBe('assistant_1')

      session.startMidTurnRotate(turn)
      await migrationStarted

      // swap 已完成、迁移仍在 await:live buffer 必须已在同步区恢复(不是空),且未被 trim
      expect(turn.cardId).toBe(newCardId)
      expect(turn.currentAssistantSegmentId).not.toBeNull()
      expect(turn.currentAssistantText).toBe('  前缀  ')
      expect(turn.cardRotationFailed).toBe(false)

      session.appendAssistant('增量')
      releaseMigration()
      await turn.rotating

      expect(turn.currentAssistantText).toBe('  前缀  增量')
      expect(turn.segmentTexts.get(turn.currentAssistantSegmentId)).toBe('  前缀  增量')
    } finally {
      releaseMigration()
      if (turn.rotating) await turn.rotating.catch(() => {})
      session.stopFooterStatus(turn)
      await cardkit.dispose(oldCardId)
      await cardkit.dispose(newCardId)
    }
  })

  test('finalizeCurrentAssistantSegment 与 closeTurnCard 无 suffix 路径各触发一次换卡重试', async () => {
    const { session, turn } = capacitySession('retry-triggers', 'card_retry_finalize')
    try {
      turn.cardRotationFailed = true
      session.finalizeCurrentAssistantSegment()
      expect(turn.rotating).not.toBeNull()
      expect(turn.rotateCount).toBe(1)
      await turn.rotating
      expect(turn.cardId).not.toBe('card_retry_finalize')
    } finally {
      if (turn.rotating) await turn.rotating
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }

    const { session: session2, turn: turn2 } = capacitySession('retry-triggers-close', 'card_retry_close')
    try {
      turn2.cardRotationFailed = true
      const closing = session2.closeTurnCard()
      expect(turn2.rotating).not.toBeNull()
      await closing
      expect(turn2.cardId).not.toBe('card_retry_close')
    } finally {
      if (turn2.rotating) await turn2.rotating
      session2.stopFooterStatus(turn2)
      await cardkit.dispose(turn2.cardId)
    }
  })

  test('cardRotationFailed 暂停 footer 档位刷新与完成推送', async () => {
    const { session, turn } = capacitySession('rotate-failed-guards', 'card_guard_failed')
    try {
      // 把 userOpenId 填上,否则推送被"没有发起人"这条无关理由挡住 —— 就测不出守卫
      turn.userOpenId = 'ou_user'
      turn.cardRotationFailed = true
      session.startThinkingFooter(turn)
      session.startWritingFooter(turn)
      expect(turn.footerStatusHandle).toBeNull()

      await session.closeTurnCard('done', { forcePush: true })
      expect(urgentPushes).toHaveLength(0)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }

    // 正对照:同一路径在 cardRotationFailed 为假时仍然推送
    const { session: session2, turn: turn2 } = capacitySession('rotate-guard-control', 'card_guard_ok')
    try {
      turn2.userOpenId = 'ou_user'
      await session2.closeTurnCard('done', { forcePush: true })
      expect(urgentPushes).toHaveLength(1)
    } finally {
      session2.stopFooterStatus(turn2)
      await cardkit.dispose(turn2.cardId)
    }
  })
})

describe('Session 换卡支撑接线 (上游 378f4a4)', () => {
  function stubCardkitFetch(cardIdForConvert = 'card_stub_new'): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      return new Response(JSON.stringify({
        code: 0,
        data: path === '/cards/id_convert' ? { card_id: cardIdForConvert } : {},
      }), { headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
  }

  test('rebuildToolsOnRotate 以显式 owner 重建,不误用已换代的 currentTurn (上游 378f4a4)', async () => {
    const session = new Session('rotate-owner', 'chat_id') as any
    session.proc = new FakeAgentProc('claude', 'claude-rotate-owner')
    const owner = turnState('card_owner_target')
    const other = turnState('card_other_current')
    session.currentTurn = other
    const oldCardId = 'card_owner_old'
    cardkit.recordCardCreated(owner.cardId, 2)
    cardkit.recordCardCreated(other.cardId, 2)
    cardkit.recordCardCreated(oldCardId, 2)
    const oldToolByUseId = new Map<string, any>([
      ['tool_use_pending', { i: 0, name: 'Bash', input: { command: 'echo hi' } }],
    ])
    stubCardkitFetch()

    try {
      sessionTools.rebuildToolsOnRotate(session, oldCardId, owner.cardId, oldToolByUseId, new Map(), owner)
      await cardkit.flush(owner.cardId)

      // 重建必须落在 owner 上;函数体若读 s.currentTurn,这些会全落到 other
      expect([...owner.toolByUseId.keys()]).toEqual(['tool_use_pending'])
      expect(owner.toolCount).toBe(1)
      expect(other.toolByUseId.size).toBe(0)
      expect(other.toolCount).toBe(0)
      const posted = calls.filter(call => call.method === 'POST').map(call => call.path)
      expect(posted).toContain(`/cards/${owner.cardId}/elements`)
      expect(posted).not.toContain(`/cards/${other.cardId}/elements`)
    } finally {
      await cardkit.dispose(owner.cardId)
      await cardkit.dispose(other.cardId)
      await cardkit.dispose(oldCardId)
    }
  })

  test('rebuildToolsOnRotate 显式 owner=null 直接返回,不回退到 currentTurn (上游 378f4a4)', async () => {
    const session = new Session('rotate-owner-null', 'chat_id') as any
    session.proc = new FakeAgentProc('claude', 'claude-rotate-owner-null')
    const current = turnState('card_null_owner_current')
    session.currentTurn = current
    cardkit.recordCardCreated(current.cardId, 2)
    stubCardkitFetch()

    try {
      sessionTools.rebuildToolsOnRotate(
        session, 'card_null_owner_old', current.cardId,
        new Map<string, any>([['tool_use_x', { i: 0, name: 'Bash', input: {} }]]),
        new Map(), null,
      )
      await cardkit.flush(current.cardId)

      expect(current.toolByUseId.size).toBe(0)
      expect(current.toolCount).toBe(0)
      expect(calls.filter(call => call.method === 'POST')).toHaveLength(0)
    } finally {
      await cardkit.dispose(current.cardId)
    }
  })

  test('completeTool 落地时 cardRotationFailed 为真 → 触发换卡重试并复位 (上游 378f4a4)', async () => {
    const session = new Session('complete-tool-retry', 'chat_id') as any
    session.proc = new FakeAgentProc('codex', 'codex-complete-tool-retry')
    const oldCardId = 'card_ctr_old'
    const newCardId = 'card_ctr_new'
    const turn = turnState(oldCardId)
    turn.userOpenId = ''
    turn.cardRotationFailed = true
    turn.toolCount = 1
    turn.toolByUseId.set('tool_use_retry', { i: 0, name: 'Bash', input: { command: 'echo hi' } })
    session.currentTurn = turn
    // 元素数远低于软上限:重试必须靠 cardRotationFailed 放行
    cardkit.recordCardCreated(oldCardId, 2)
    stubCardkitFetch(newCardId)

    try {
      expect(turn.rotating).toBeNull()
      sessionTools.completeTool(session, session.proc, 'tool_use_retry', 'ok', false)

      const rotation = turn.rotating
      expect(rotation).not.toBeNull()
      if (rotation) await rotation
      await cardkit.flush(newCardId)

      expect(turn.cardId).toBe(newCardId)
      expect(turn.cardRotationFailed).toBe(false)
    } finally {
      if (turn.rotating) await turn.rotating
      session.stopFooterStatus(turn)
      await cardkit.dispose(oldCardId)
      await cardkit.dispose(newCardId)
    }
  })

  test('completeTool 在 cardRotationFailed 为假时不触发换卡 (上游 378f4a4)', async () => {
    const session = new Session('complete-tool-no-retry', 'chat_id') as any
    session.proc = new FakeAgentProc('codex', 'codex-complete-tool-no-retry')
    const cardId = 'card_ctnr'
    const turn = turnState(cardId)
    turn.userOpenId = ''
    turn.toolCount = 1
    turn.toolByUseId.set('tool_use_keep', { i: 0, name: 'Bash', input: { command: 'echo hi' } })
    session.currentTurn = turn
    cardkit.recordCardCreated(cardId, 2)
    stubCardkitFetch()

    try {
      sessionTools.completeTool(session, session.proc, 'tool_use_keep', 'ok', false)
      expect(turn.rotating).toBeNull()
      expect(turn.cardId).toBe(cardId)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(cardId)
    }
  })

  test('completeTool 的换卡重试服从 rotateGivenUp 止损(D-13 优先) (上游 378f4a4)', async () => {
    const session = new Session('complete-tool-given-up', 'chat_id') as any
    session.proc = new FakeAgentProc('codex', 'codex-complete-tool-given-up')
    const cardId = 'card_ctgu'
    const turn = turnState(cardId)
    turn.userOpenId = ''
    turn.cardRotationFailed = true
    turn.rotateGivenUp = true
    turn.toolCount = 1
    turn.toolByUseId.set('tool_use_given_up', { i: 0, name: 'Bash', input: { command: 'echo hi' } })
    session.currentTurn = turn
    cardkit.recordCardCreated(cardId, 2)
    stubCardkitFetch()

    try {
      sessionTools.completeTool(session, session.proc, 'tool_use_given_up', 'ok', false)
      expect(turn.rotating).toBeNull()
      expect(turn.cardId).toBe(cardId)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(cardId)
    }
  })
})
