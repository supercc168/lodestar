/**
 * Session — 1 Feishu chat ↔ 1 Codex app-server process ↔ 1 streaming card.
 *
 * Owns the CodexProcess lifecycle, the per-turn card state machine, and
 * the in-flight permission map.  Wires Codex app-server events into Card
 * Kit ops, and wires Feishu inbound (text + card-action callbacks) into
 * Codex turns.
 *
 * Tool tracking, AskUserQuestion flow, permission rendering, command
 * routing and model/task/wt/compact panels live in sibling
 * session-*.ts modules. Fields touched by those helpers carry no
 * `private` modifier — convention is "no modifier = package-internal,
 * only the session-*.ts helpers should touch it."
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { agentApiUrl } from './agent-runtime'
import {
  CODEX_EFFORT,
  CodexRpcResponseError,
  CodexProcess,
  diffUsageTotals,
  effectiveTurnTokens,
  isCodexReasoningEffort,
  type CanUseToolRequest,
  type CodexReasoningEffort,
  type CodexUsage,
  type CodexResultMeta,
  type ContextCompactedNotification,
  type HookCallbackRequest,
  type PlanDelta,
  type TokenUsageUpdated,
  type ThreadGoal,
  type TurnPlanUpdated,
} from './codex-process'
import { codexModelIsApiRoute, codexModelRequiresOpenaiAuth } from './codex-models'
import { DSH_DEFAULT_BASE_URL, DSH_DISPLAY_NAME, dshSourceFromConfig } from './token-source-dsh'
import { queryDshRuntime } from './dsh-runtime'
import { DshProcess } from './dsh-process'
import { fetchDeepseekBalance } from './token-source-deepseek'
import { isAgentSession } from './agent-session-registry'

import { processUsesClaudeTranslation } from './agent-process'
import { claudeTranslationModeEnabled } from './claude-translation-mode'
import { createAgentCards } from './agent-cards-runtime'
import type { AgentCards } from './agent-cards'
import { waitForLiveCodexUsage } from './codex-live-usage'
import { claudeAccounts, DEFAULT_CLAUDE_ACCOUNT, processClaudeAccount } from './claude-accounts'
import { enrollClaudeAccount } from './claude-account-selection'
import { countActiveClaudeSessions } from './session-activity'
import {
  validateConversationLaunch,
  type ConversationBranchBase,
  type ConversationCheckpoint,
  type ConversationLaunch,
  type ConversationRef,
  type ConversationRouting,
  type ConversationSummary,
  type PendingConversationLaunch,
} from './conversation'
import {
  CLAUDE_EFFORT,
  agentProviderLabel,
  isClaudeReasoningEffort,
  isDshReasoningEffort,
  type AgentProcess,
  type AgentProcessEventMap,
  type AgentProvider,
  type AgentReasoningEffort,
  type AgentResultEvent,
  type AgentTurnRetry,
  type ClaudeReasoningEffort,
  type CodexUserTextSettlement,
  type CollabAgentStates,
  type DshReasoningEffort,
  type UserTextDispatch,
  usageSourceForAgent,
} from './agent-process'
import { liveElapsed, type LiveElapsedMode } from './cards/format'
import { createAgentProcess } from './agent-launch'
import { getTokenSource, getTokenSourceForAccount, listEnabledTokenSourcesByAgent, tokenSourceProcessRevision, tokenSourceRuntimeModel, type TokenSource } from './token-source'
import { boundCodexAccount, codexAccounts, DEFAULT_CODEX_ACCOUNT, processCodexAccount } from './codex-accounts'
import { codexAccountCard } from './cards/codex-account'
import {
  claudeTranscriptPath,
  type BgTaskStartedEvent,
  type BgTaskProgressEvent,
  type BgTaskUpdatedEvent,
  type BgTaskSettledEvent,
  type ModelRefusalFallbackEvent,
  type ModelRefusalNoFallbackEvent,
} from './claude-agent-process'
import * as cardkit from './cardkit'
import * as cards from './cards'
import { watchdogFooterContent } from './cards/turn'
import * as feishu from './feishu'
import { formatFeishuError } from './feishu-errors'
import { logError, logDiagnostic } from './log'
import { MANAGED_CLAUDE_PLUGIN_DIR } from './paths'
import { readSysInfo } from './sysinfo'
import { readUsage, captureCodexUsageCache, type UsageSnapshot } from './usage'
import { readGlmUsage, type GlmUsageSnapshot } from './glm-usage'
import { readClaudeProviderUsage, readDeepseekBalance, type ClaudeProviderUsageSnapshot } from './claude-provider-usage'
import { codexCreditsSummary } from './cards/usage'
import { readAllAccountUsage } from './account-usage'
import { claudeWeeklyUsageWindow } from './claude-usage'
import {
  contextLimitFromAppServer,
  contextTokensFromUsage,
} from './context-window'
import { extractAskUsrMarkers, extractSendMarkerPaths, normalizeOutboundPath, stripAskUsrMarkers } from './outbound-markers'
import * as sessionMultimsg from './session-multimsg'
import * as mathRender from './math-render'
import type { TurnState, Status, SessionOpts, LastTurnDelta, CumStats } from './session-types'
import * as sessionAgy from './session-agy'
import * as sessionTools from './session-tools'
import * as sessionAsk from './session-ask'
import * as sessionHostAsk from './session-host-ask'
import * as sessionPermission from './session-permission'
import {
  diagnosticIdLabel,
  messageOf,
  type FooterTimer,
  type LifecycleKind,
  type LifecycleLease,
  type LifecycleProgressOpts,
  type ModelActionResult,
  type ResumeIdentity,
  type StatusCardHandle,
  type TasklistActionResult,
  type WorktreeActionResult,
} from './session-util'
import type { GsdActionResult } from './session-gsd'
import * as sessionCommands from './session-commands'
import * as sessionCompact from './session-compact'
import * as sessionModel from './session-model'
import * as sessionAgentIdentities from './session-agent-identities'
import * as sessionTasklist from './session-tasklist'
import * as sessionGsd from './session-gsd'
import * as sessionWorktree from './session-worktree'
import * as sessionTemp from './session-temp'
import { config } from './config'
import {
  DEFAULT_CODEX_WATCHDOG,
  TurnWatchdog,

  type WatchdogLogEvent,
  type WatchdogSafetySnapshot,
  type WatchdogSettings,
  type WatchdogVerdict,
} from './turn-watchdog'
import {
  ToolFailureLoopGuard,
  type ToolFailureLoopVerdict,
} from './tool-failure-loop'
import { createFileDelivery } from './file-delivery-runtime'
import type { FileDeliveryHandle } from './file-delivery-types'

export type { SessionOpts } from './session-types'

export const WATCHDOG_RECOVERY_PROMPT = `[Lodestar 自动恢复 1/1]
上一轮在最后一次有效进展后持续产生相同的无副作用空调用,已被中断。
请基于当前 thread 和工作区继续未完成任务。先核对现状和上次有效动作,
不要用空的 text(...) 调用代替实际派发、等待或结果汇报。
完成任务或遇到真实阻塞时直接给出明确结果。`

/** 同一 session 连续 capacity 重试上限:唯一调度权在进程层(上游 2e6e1e0,D-07),
 *  session 侧只按该阈值做一次性耗尽群通知,自身不排任何计时器。 */
export const CAPACITY_RETRY_MAX_ATTEMPTS = 10

export const WATCHDOG_TICK_MS = 15_000

/** Classify Codex overload / model-capacity failures for automatic retry. */
export function isCodexCapacityError(text: unknown): boolean {
  if (typeof text !== 'string' || !text) return false
  const lower = text.toLowerCase()
  return lower.includes('selected model is at capacity')
    || lower.includes('serveroverloaded')
    || (lower.includes('at capacity') && lower.includes('model'))
    || lower.includes('please try a different model')
}

export interface WatchdogTurnContext {
  proc: AgentProcess
  turn: TurnState
  threadId: string | null
  turnId: string | null
  identityConflict: boolean
}

export type PreservedWatchdogRecoveryPhase = 'recovering' | 'retrying' | 'draining' | 'failed'

export interface PreservedWatchdogRecovery extends ResumeIdentity {
  readonly token: object
  readonly turn: TurnState
  readonly turnId: string
  readonly recoveryAttempt: number
  lease: LifecycleLease
  phase: PreservedWatchdogRecoveryPhase
  replacementProc: AgentProcess | null
}

export interface WatchdogActionTransaction extends ResumeIdentity {
  readonly token: object
  readonly lease: LifecycleLease
  readonly proc: AgentProcess
  readonly turn: TurnState
  readonly turnId: string
  readonly recoveryAttempt: number
}

interface ToolFailureLoopAction {
  readonly lease: LifecycleLease
  readonly proc: AgentProcess
  readonly turn: TurnState
  readonly verdict: Extract<ToolFailureLoopVerdict, { type: 'stop' }>
}

const TOOL_FAILURE_QUEUE_PRESERVED_NOTICE =
  '⚠️ 工具失败循环已停止；排队消息仍保留，下一条普通消息会与它们一起投递。'

export interface ModelSwitchTransaction {
  readonly token: object
  readonly lease: LifecycleLease
}

type TurnInterruptSource = 'user' | 'watchdog_recover' | 'watchdog_exhausted' | 'tool_failure_loop'

type TurnSettlement =
  | { type: 'result'; proc: AgentProcess; turn: TurnState | null }
  | { type: 'exit'; proc: AgentProcess; turn: TurnState | null }
  | { type: 'cancelled'; reason: string }

type TurnInterruptContext = {
  source: TurnInterruptSource
  proc: AgentProcess
  turn: TurnState | null
  threadId: string | null
  turnId: string | null
  promise: Promise<TurnSettlement>
  resolve: (outcome: TurnSettlement) => void
  settled: boolean
}

interface PendingWatchdogIdentity {
  proc: AgentProcess
  threadId: string | null
  turnId: string | null
  turnCounter: number | null
  identityConflict?: boolean
}

type TurnCardOpenResult =
  | { kind: 'opened'; turn: TurnState }
  /** stage 记录失败发生段(合并调和,取舍):'send'=卡片消息都没发出去
   *  (sendCard null);'convert'=卡片消息已创建但 id_convert 失败。
   *  drainMidTurnAndOpen 对两段取不同恢复策略 —— 'send' 沿本地 restore
   *  (批次/回执保留待重试),'convert' 沿上游丢弃(提示重发)。 */
  | { kind: 'failed'; stage?: 'send' | 'convert' }
  | { kind: 'stale' }

/** 开卡窗口竞态的终态载荷(ff44afb TurnOpenOwner.terminalSuffix/terminalForcePush
 * 的最小等效,04-05 甄别 #13):挂在 opaque owner token 上,随 token 生命周期作废
 * (finishTurnOpening/clearTurnOpening 置 null 即弃)。不移植上游 owner 让位/
 * terminalize 整套语义——01-14 token 冲突即抛机制保持不变。 */
interface TurnOpenTerminalStash {
  terminalSuffix?: string
  terminalForcePush?: boolean
}

/** 上游开卡窗口 owner(承载调度的 wakeup/init 抢占):同一进程内一次只允许
 *  一个 open 事务,后续 open 等 done;进程换代(procEpoch 变化)即作废。
 *  与 TurnOpenTerminalStash 并存:watchdog/终态路径用 stash,常规开卡用本 owner。 */
interface TurnOpenOwner {
  token: number
  proc: AgentProcess | null
  procEpoch: number
  sawResult: boolean
  terminalSuffix?: string
  terminalForcePush: boolean
  pendingCompactions: ContextCompactedNotification[]
  /** True only when this card open was triggered by an SDK init for a turn
   * that is already running. Eager user/drain opens happen before input is
   * sent, so compaction events in that window belong to an older turn. */
  backendTurnStarted: boolean
  /** Resolves exactly once when this owner is released or invalidated. Same-
   * process follow-up opens await it instead of replacing openingTurnOwner. */
  done: Promise<void>
  resolveDone: () => void
}

/** 关卡快照(重置/轮换期间跨 await 的 turn 冻结视图)。 */
interface TurnCloseSnapshot {
  turn: TurnState
  proc: AgentProcess | null
  procEpoch: number
  contextTokens: number | null
  contextLimit: number | null
  lastTurnDelta: LastTurnDelta | null
  lastTurnUsage: CodexUsage | null
  tokenSourceId: string | null
  tokenSource: TokenSource | undefined
  codexUsage: ReturnType<typeof captureCodexUsageCache> | null
  currentBatchReactionIds: Map<string, string>
  pendingReactionIds: Map<string, string>
}

type MidTurnDrainOutcome = 'no_batch' | 'committed' | 'preserved'

type HumanBatchMessage = {
  text: string
  wireText: string
  userOpenId: string
  msgId: string
}

type PendingHumanDelivery = {
  readonly proc: AgentProcess
  readonly batch: HumanBatchMessage[]
  readonly reactions: Map<string, string>
  dispatch: Extract<UserTextDispatch, { kind: 'turn_start_pending' }> | null
  openingOwner: object | null
  turn: TurnState | null
  turnId: string | null
  state: 'pending' | 'acked' | 'restored' | 'refused'
}

function compactionKey(notice: ContextCompactedNotification): string {
  return notice.itemId || notice.turnId || '__latest__'
}

/** Cross-surface receipt aliases for one physical compaction: the same event
 * can arrive as an item notification and a generic turn notification in
 * either order (上游 4185808). */
function compactionReceiptKeys(notice: ContextCompactedNotification): string[] {
  const keys: string[] = []
  if (notice.itemId) keys.push(`item:${notice.itemId}`)
  if (notice.turnId) {
    keys.push(`turn:${notice.threadId ?? notice.sessionId ?? '-'}:${notice.turnId}`)
  }
  return keys
}

function latestPendingCompactionKey(turn: TurnState): string | null {
  let key: string | null = null
  for (const k of turn.contextCompactionPending.keys()) key = k
  return key
}

function mergeCompactionNotices(
  start: ContextCompactedNotification | undefined,
  end: ContextCompactedNotification,
): ContextCompactedNotification {
  if (!start) return end
  return { ...start, ...end, phase: 'end' }
}

function backgroundWatchdogSignature(active: cards.BgTaskEntry[], pending: cards.BgTaskEntry[]): string {
  return JSON.stringify([...active, ...pending]
    .map(task => ({
      id: task.id,
      status: task.status,
      summary: task.summary,
      usage: task.usage,
      lastToolName: task.lastToolName,
      error: task.error,
      isBackgrounded: task.isBackgrounded,
      steps: task.steps,
      endTime: task.endTime,
    }))
    .sort((a, b) => a.id.localeCompare(b.id)))
}

function collabAgentEntries(value: CollabAgentStates): Array<[string, string]> {
  return Object.entries(value).map(([id, state]) => [id, state.status ?? 'notFound'])
}

function stringMapSignature(value: Map<string, string>): string {
  return JSON.stringify([...value.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

function stringSetSignature(value: Set<string>): string {
  return JSON.stringify([...value].sort())
}

function collabAgentPoolsSignature(value: Map<string, Map<string, string>>): string {
  return JSON.stringify([...value.entries()]
    .map(([toolUseId, states]) => [toolUseId, stringMapSignature(states)] as const)
    .sort(([a], [b]) => a.localeCompare(b)))
}

function flattenCollabAgentStates(
  pools: Map<string, Map<string, string>>,
): Map<string, string> {
  const flattened = new Map<string, string>()
  for (const pool of pools.values()) {
    for (const [agentThreadId, status] of pool) {
      const previous = flattened.get(agentThreadId)
      const statusIsRunning = status === 'pendingInit' || status === 'running'
      const previousIsRunning = previous === 'pendingInit' || previous === 'running'
      if (!previous || statusIsRunning || !previousIsRunning) flattened.set(agentThreadId, status)
    }
  }
  return flattened
}

function removeCollabAgentsFromAllPools(
  pools: Map<string, Map<string, string>>,
  agentThreadIds: Iterable<string>,
): void {
  const terminalAgents = new Set(agentThreadIds)
  if (terminalAgents.size === 0) return
  for (const [toolUseId, pool] of pools) {
    for (const agentThreadId of terminalAgents) pool.delete(agentThreadId)
    if (pool.size === 0) pools.delete(toolUseId)
  }
}

/** 从任意错误结构里挖出 CodexRpcResponseError(4185808,挂账 #1):cause 链
 *  逐层下钻、AggregateError.errors 递归、seen 防循环引用死循环。唯一消费方
 *  是 invalidateMissingCodexResume 的 no-rollout 严判。 */
function findCodexRpcResponseError(
  error: unknown,
  seen = new Set<unknown>(),
): CodexRpcResponseError | null {
  if (error instanceof CodexRpcResponseError) return error
  if (!error || (typeof error !== 'object' && typeof error !== 'function') || seen.has(error)) return null
  seen.add(error)
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const found = findCodexRpcResponseError(nested, seen)
      if (found) return found
    }
  }
  if (error instanceof Error && error.cause !== undefined) {
    return findCodexRpcResponseError(error.cause, seen)
  }
  return null
}

const TERMINAL_COLLAB_AGENT_STATES = new Set([
  'interrupted',
  'completed',
  'errored',
  'shutdown',
  'notFound',
])

const FOOTER_THINKING_PREFIX = 'Thinking...'
const FOOTER_WRITING = 'Writing...'
const FOOTER_WORKING = 'Working...'
/** Final transaction guard: two 30s control RPCs plus a materialization read
 * of up to 10 minutes. Leave a minute for local lifecycle work so the exact
 * method timeout can surface before this outer guard. */
const CODEX_INIT_NOTICE_MS = 10_000
const CODEX_INIT_TIMEOUT_MS = 12 * 60_000
// 恢复路径 init 提示护栏原为独立常量 RESUME_INIT_NOTICE_MS(10s);上游会话
// 恢复优化后恢复与 start 同走 waitForCodexInitialization(其 notice 计时用
// CODEX_INIT_NOTICE_MS),常量已无引用,定点清理(TS6133)。语义不变:两侧
// notice 仍为 10s,超时仍由 CODEX_INIT_TIMEOUT_MS 兜底。
/** 提前换卡，为在途写入和复杂嵌套元素留出余量。
 * Feishu 的容量按卡片结构计数；实际 300305 容量错误另触发换卡。 */
const CARD_ELEMENT_SOFT_LIMIT = 50

/** Max mid-turn card rotations per turn. Past this we stop opening fresh
 * cards and fall back to log-only for the rest of the turn. Only confirmed
 * card-capacity failures enter this path (确认 300305 组件数上限/本地
 * 200860 体积上限); schema/content/network errors stay on the current card
 * because replaying the same mutation cannot repair them (上游 4185808).
 * The cap remains as a final guard against a malformed single element
 * that itself exceeds the capacity ceiling. Network transport blips and
 * footer ticks never consume this budget (see onCardWriteFailure). */
const MAX_MIDTURN_ROTATES = 5
// Cap a single assistant markdown element so one giant block can't alone
// push the card over Feishu's total size ceiling (200860). Excess stays in
// daemon logs / transcript; the card keeps a readable head.
const ASSISTANT_CARD_CHARS = 12_000
/** Bounded tombstone map for compaction receipts (item/turn aliases). */
const MAX_CONTEXT_COMPACTION_RECEIPTS = 256
/** Coalescing window for an anonymous duplicate of a just-completed
 * compaction arriving from a second protocol surface. */
const ANONYMOUS_COMPACTION_DEDUPE_MS = 10_000
/** Claude Agent SDK does not emit stream `init` until the first user input.
 * Still give synchronous/early startup failures a chance to surface before
 * presenting the session as ready. */
const CLAUDE_STARTUP_GRACE_MS = 250

function timedStatus(status: string, startedAt: number): string {
  return `${status} (${cards.liveElapsed(Date.now() - startedAt, config.runtime.live_elapsed).label})`
}

/** 本进程的后台/页脚耗时档位(bucket|second)。 */
function liveElapsedMode(): LiveElapsedMode {
  return config.runtime.live_elapsed
}

function cardFailureDetails(failures: cardkit.CardWriteFailure[]): string {
  return failures.length
    ? failures.map(failure => `${failure.operation}: ${formatFeishuError(failure)}`).join('\n')
    : formatFeishuError(undefined)
}

/** 本地会话路由快照的运行时扩面:slim ConversationRouting(temp session 传输/
 *  sameRouting 比对只用 provider/model/effort)+ 上游吸收的 token source /
 *  codex 账号归属字段。session-codex-accounts 冻结测试对
 *  conversationRouting()→applyConversationRouting 的运行时往返依赖这些字段
 *  在位(账号继承/自动回落),故保留富行为、只收窄类型声明。 */
type SessionConversationRouting = ConversationRouting & {
  tokenSourceId?: string | null
  codexAccountId?: string
  codexAccountAutomatic?: boolean
}



function backgroundFailureNotices(error: unknown): string[] {
  if (error instanceof AggregateError && error.errors.length) {
    return error.errors.flatMap(backgroundFailureNotices)
  }
  return [messageOf(error)]
}

export class Session {
  /** Process-wide registry of every Session ever constructed in this daemon.
   * Used by the `hi` console panel to enumerate sibling sessions across
   * Feishu groups. Sessions are never removed (matches the daemon's
   * `sessions` map lifecycle — one Session per chat for the daemon's
   * lifetime). Callers should filter on `isRunning()` when they only
   * want currently-alive Codex processes. */
  static readonly all: Set<Session> = new Set()

  // ── package-internal state (touched by session-*.ts helpers) ──
  proc: AgentProcess | null = null
  /** Lifecycle operations that can replace `proc` are serialized per Session.
   * The daemon deliberately dispatches Feishu messages concurrently so two
   * `restart` commands can overlap; without this gate both callers can observe
   * `proc === null` while the first kill is pending and each spawn a process. */
  private lifecycleTail: Promise<void> = Promise.resolve()
  /** Number of runLifecycle operations currently executing (queue depth
   *  already drained by `await previous`). Used by onUserMessage's narrow
   *  daemon-restore wait. */
  private lifecycleActive = 0
  /** user-message 操作当前是否在跑(含并发消息)。>0 时新的 onUserMessage 不经
   *  runLifecycle 队列直接并发执行 —— 本地收据系统要求第二条消息立即进
   *  pendingMidTurnMsgs,不能停在与第一条消息互等的队列尾巴上。 */
  private userMessageActive = 0
  /** 执行中的 stop()/stopUnlocked 事务计数。>0 时 onUserMessage 同样直进
   *  (合并调和,取舍):本地 main 无 lifecycle 队列,stop 在途时到达的消息
   *  在 stop 的 agy/kill 等待窗口内直接入队(随后被 stop 的 discard 清理
   *  掉);上游队列语义会把消息停到队尾 —— 本地冻结用例 'full stop discards
   *  human work that arrives while agy stop is awaiting completion' 的
   *  agy 门(测试先等消息返回、再放行门)会因此死锁。restart/model-select
   *  排队次序不变(上游 mutex 用例),仅 stop 窗口豁免。 */
  private stopLifecycleActive = 0
  /** Generation of the process currently owned by this Session. Event
   * listeners capture it at wire time so a late event from a killed/replaced
   * process cannot mutate the new process' turn, queue, usage, or cards. */
  private procEpoch = 0
  /** Process currently being stopped by a serialized lifecycle operation.
   * While set, every event except `exit` is ignored. */
  private stoppingProc: AgentProcess | null = null
  /** A stop/kill timed out while this process still reports alive. Keep the
   * handle attached and block all new input/spawns until a real exit arrives
   * or a later explicit stop/restart successfully confirms termination. */
  private blockedProc: AgentProcess | null = null
  private blockedProcReason: string | null = null
  agentCapability: string | null = null
  /** Spawn-affecting token-source revision captured for each owned process.
   * Same source id with rotated credentials/base URL must still replace the
   * idle child after the registry is rebuilt. Weak keys avoid lifecycle leaks. */
  private readonly procSourceRevisions = new WeakMap<AgentProcess, string | null>()
  currentTurn: TurnState | null = null
  /** Item-scoped compaction ownership survives a turn-card close so a late
   * completion cannot attach itself to the next turn. Completed receipts keep
   * no TurnState reference and are bounded as duplicate tombstones.
   * (上游 4185808 主题 C) */
  private contextCompactionReceipts = new Map<string, {
    ownerId: number | null
    completed: boolean
    completedAt: number
    completionKey?: string
    hasItemAlias: boolean
  }>()
  private contextCompactionOwnerIds = new WeakMap<TurnState, number>()
  private contextCompactionOwnerSequence = 0
  private lastManualContextCompactionCompletedAt = 0
  private lastManualContextCompactionWasAnonymous = false
  /** 已确认后台的任务(workflow/monitor 白名单,或收到 is_backgrounded:true 提升)。
   *  驱动后台游标卡渲染。以 task_id 为 key,跨 turn 累积 —— 后台任务生命周期
   *  不受 turn 边界约束。 */
  backgroundTasks: cards.BgTaskEntry[] = []
  pendingBgTasks: cards.BgTaskEntry[] = []
  /** 已结算 agent 任务档案:卡沉降/迁移清池时留下 subagent 的「名片」。SDK 热续跑
   *  (SendMessage 到刚完成的 agent)不重发 task_started,后续 unknown 事件命中
   *  档案即以「续跑」条目复活入卡;shell 不入档案,前台噪音 no-fallback 不回归。 */
  bgArchive: cards.BgArchiveEntry[] = []
  /** 后台游标卡句柄。null = 当前无活卡(从未建/已沉降/已固化)。活卡期间
   *  streaming 开,replaceElement body 刷新任务行。卡吸附在对话末尾,被新消息
   *  超越时沉降(updateCard),只在全部终态时固化留在原地。 */
  backgroundCard: { messageId: string; cardId: string } | null = null
  /** Single-flight transition that rewrites/disposes the live background card
   * before a new main card. While non-null, no refresh/settle mutation may be
   * queued against the old element tree.(上游 7c14677 迁移单飞) */
  migratingBackgroundCard: Promise<void> | null = null
  /** task_progress 风暴的刷新节流 timer。 */
  private backgroundRefreshTimer: ReturnType<typeof setTimeout> | null = null
  /** 后台卡档位 timer:在最近活跃任务的下一个耗时档位边界刷新 header。
   *  活跃任务集合变化时重算,卡沉降/迁移时清理。 */
  private backgroundRefreshTick: ReturnType<typeof setTimeout> | null = null
  /** openBackgroundCard 进行中标记 —— 防止并发 bg_task 事件在 await sendCard
   *  期间重复开卡(sendCard 未返回前 backgroundCard 仍 null,第二个事件会再开一张)。 */
  private openingBackground = false
  /** 后台开卡世代(ff44afb BackgroundOpenOwner 最小等效,04-05 甄别红例):
   *  reset/换代后晚到的旧开卡凭世代号自弃——终态化作废卡、不安装为活卡、
   *  不清新开卡的 openingBackground(完整 owner 结构不移植)。 */
  backgroundOpenGeneration = 0
  /** 已 addElement 到活卡的 task panel 的 task_id 集合。新任务 diff 出来才
   *  addElement(避免重复 add);已有任务 replaceElement 整个 panel。也承载 fold
   *  汇总 panel 的固定 key(BG_ELEMENTS.fold)—— 它与 task_id(UUID)不冲突。 */
  backgroundDetailAdded = new Set<string>()
  /** bg_fold 汇总 panel 最近一次写入的成员签名(id 列表)。终态任务冻结,成员集
   *  不变即内容不变;据此跳过 replaceElement,免得每个 tick / progress 风暴都
   *  重发同一份折叠明细。开卡 / 沉降 / 迁移时与 backgroundDetailAdded 一同复位。 */
  backgroundFoldSig: string | null = null
  /** 最近一次主线程 Task tool_use 的 id —— SDK 若在 task_started 里没填 tool_use_id,
   *  用它兜底关联子 agent 消息的 parent_tool_use_id 到对应 task。 */
  private lastMainTaskToolUseId: string | null = null
  /** onUserMessage 沉降旧卡后置位;主卡落地后据此重建后台卡(游标重回末尾)。 */
  private pendingRebuildBackgroundCard = false
  userInterrupted = false
  private nativeAgentTools = new Map<string, { confirmed: boolean; input: any; displayInput?: any }>()
  private readonly agentCards: AgentCards
  private backgroundOwner = randomBytes(16).toString('hex')
  private backgroundSync: Promise<void> | null = null
  private readonly backgroundWriteErrors = new Set<string>()
  /** turn 收尾后有后台任务结算 → SDK 会自发开一轮恢复轮(task_notification
   *  合并结果),该轮 init 没有伴随用户消息。置位后,下一个无用户批次的 init
   *  据此开 bg_task_resume 卡承接输出;任何 turn 开卡即消费(结算通知会被
   *  并入那一轮),避免陈旧标记把无关的空 init 误判成恢复轮。 */
  private bgResumePending = false
  /** 无 currentTurn 时到达的 assistant 正文(恢复轮开卡前的窗口期 / 开卡
   *  失败)。openTurnCard 落地时并入新卡;result/exit 时纯文本兜底推送。
   *  决不静默丢弃(2026-07-04 etmmo 终报告事故:恢复轮 6.6KB 合并终报告
   *  整轮无卡,appendAssistant 首行 return 全部丢光,飞书无痕)。
   *  只在"合法无卡窗口"缓冲(openingTurn 正在开卡 / bgResumeCardless 恢复轮
   *  开卡失败续窗);其余无卡场景(被打断的轮尾、kill 窗口残字)一律丢弃,
   *  否则会被错误推送或并入下一张不相干的卡。 */
  private orphanAssistantSegments: string[] = []
  private orphanAssistantCurrent = ''
  /** 恢复轮 openTurnCard 失败后置位:该轮此后再无卡,正文继续进孤儿缓冲直到
   *  result 纯文本兜底。区别于 openingTurn(仅开卡 await 窗口)。 */
  private bgResumeCardless = false
  /** result 抢在 openTurnCard 的 sendCard/id_convert await 窗口内到达 →
   *  置位;开卡 IIFE 落地后据此立即收尾,避免卡片永远悬挂、session 卡在
   *  working(旧代码对 user turn 也有此隐患,这里一并收口)。 */
  private sawResultWhileOpening = false
  pendingPermissions = new Map<string, { toolUseId: string; permissionSuggestions?: unknown }>()
  /** Open AskUserQuestion tool calls — keyed by tool_use_id. Codex and
   * Claude both route AskUserQuestion through the can_use_tool flow;
   * we have to thread the permission `requestId` through here so the
   * answer (option click OR custom text submit) can resolve the
   * permission with `updatedInput.answers` populated.
   * `deferredAnswer` covers the race where the user clicks/submits
   * BEFORE can_use_tool arrives (addTool fires on the assistant
   * message; can_use_tool is a separate control_request that lands
   * slightly later). */
  pendingAsks = new Map<string, {
    questions: cards.AskQuestion[]
    i: number
    requestId?: string
    /** 累计答案 — key 是 question 原文 (SDK 把这条 record 格式
     * 化进 tool_result), value 是用户选的 option label 或自定
     * 义文字。全部 question 都答完时一并塞进 updatedInput.answers
     * 发回 SDK。 */
    answers: Record<string, string>
    /** 已答详情 (按 question idx 索引)，用来给历史面板和 terminal
     * 状态画选中态。answers 同步累计，但这里多保留 customText /
     * optionIdx 字段以便 UI 区分两种回答路径。 */
    answered: Map<number, cards.AskAnswered>
    /** 当前展示的 question idx。undefined 表示全部答完 (terminal)
     * —— 这时若 requestId 已就位则 finalize；否则等 renderPermission
     * 一来立即 finalize。 */
    currentIdx?: number
    /** 仅在成为可答时推送一次手机通知;等待/排队期间回到 false 以便恢复后重推。 */
    announced?: boolean
    /** 推送代际计数,作废在途推送(等待/排队期间自增)。 */
    announcementVersion?: number
  }>()
  /** Host-side askusr cards triggered by assistant marker protocol.
   * Kept separate from SDK AskUserQuestion because there is no
   * can_use_tool/requestId handshake here — the host injects the
   * synthetic tool call/tool result into thread history after the user
   * answers, then starts a fresh continuation turn. */
  pendingHostAsks = new Map<string, {
    questions: cards.AskQuestion[]
    answered: Map<number, cards.AskAnswered>
    currentIdx?: number
    toolCallId: string
    inputJson: string
    cardId?: string
    messageId?: string
    creatingCard?: boolean
    resumeStarted?: boolean
  }>()
  /** Thread-scoped goal reported by Codex app-server. Pure progress
   * accounting updates refresh this snapshot without adding card elements;
   * only objective/status/budget changes are rendered. */
  currentGoal: cards.ThreadGoal | null = null
  status: Status = 'stopped'

  // ── strictly private state ──
  /** Number of daemon writes handed to the backend but not yet claimed by an
   * authoritative backend turn boundary (`init`/`turn_started`). Next-turn
   * batches use one `sendUserText`; native steering does not claim a new
   * turn, so production keeps this at 0 or 1. A boundary belonging
   * to an already eager-opened card must still consume the claim before the
   * currentTurn/openingTurn guard returns; otherwise the next Claude
   * task-notification init is misclassified as a user batch and opens an empty
   * `trigger=user_message inputs=0` card. */
  pendingUserMessageCount = 0
  /** Not yet submitted: drained into a native active turn when supported,
   * otherwise submitted together at the next turn boundary. */
  pendingMidTurnMsgs: Array<{ text: string; wireText: string; userOpenId: string; msgId: string }> = []
  private steeringSend: Promise<void> | null = null
  private steeringGeneration = 0
  private submittedSteering = new Map<string, {
    proc: AgentProcess; epoch: number; generation: number; turn: TurnState
    consumed: boolean
    batch: Array<{ text: string; wireText: string; userOpenId: string; msgId: string }>
    reactions: Map<string, string>
  }>()
  private steeringBoundary: {
    turn: TurnState; proc: AgentProcess; epoch: number; generation: number
    inputs: string[]; inputIds: string[]; collecting: boolean; start: () => void
    reactionOwners: Array<{ batch: Array<{ msgId: string }>; reactions: Map<string, string> }>
    events: Array<() => void>
  } | null = null
  /** 下一个 turn 的 user inputs 暂存区。所有 sendUserText 的 wireText 在
   * sendUserText 之前 push 这里;openTurnCard 创建 turn 时一次性取走 + clear。
   * mainConversationCard 把这些 wireText 渲染成顶部"📥 收到 (N)"折叠面板,
   * 让用户在卡片自己里就能看到这一轮触发了什么(不必滚群里找原消息)。
   * 已追加的消息触发续卡并显示在新卡顶部；仍待下一轮的消息由
   * drainMidTurnAndOpen 在开卡前统一 push。 */
  pendingTurnInputs: string[] = []
  /** 用户用 `>>>`(≥3 个 >)主动开启的多条消息缓冲。null = 当前不在多条
   *  收集模式;非 null = 正在累积,直到 `<<<`(≥3 个 <)收尾合并成一条
   *  onUserMessage。跟 pendingMidTurnMsgs 不同:后者是 turn 进行中被动到达
   *  的排队,这个是用户显式分段。状态机在 session-multimsg.ts,永不超时。*/
  multiMsgBuffer: sessionMultimsg.MultiMsgSegment[] | null = null
  /** multiMsgBuffer 里每条消息上挂的 📌 reaction_id('' = addReaction 还在
   *  飞)。flush 时释放 📌,clear 时换成 ❌。*/
  multiMsgReactions = new Map<string, string>()
  /** Most recent userOpenId seen via `onUserMessage`. Used only when a
   * merged batch fires its init event and the daemon needs *some* open_id
   * to scope the eventual `urgent_app` push — there's no obviously right
   * answer when N messages from possibly different users collapse into
   * one turn, and "the most recent sender" is a defensible default for
   * the single-user private-bot scenario this product targets. */
  lastUserOpenId = ''
  /** 进程层容量重试的本地镜像:最近一次 attempt(footer 诊断与耗尽阈值判定;
   *  调度权在进程层,session 不据此排任何计时器)。成功轮清零。 */
  private capacityRetryAttempts = 0
  /** 耗尽(attempt 超过 CAPACITY_RETRY_MAX_ATTEMPTS)群通知一次性 latch;
   *  进程层语义是持续退避,通知不取消重试,只保证不重复刷屏。 */
  private capacityRetryExhausted = false
  /** Feishu message_ids of user messages that arrived while the daemon
   * was busy (turn in flight or mid-open), mapped to the `reaction_id`
   * of the `OneSecond` reaction placed at arrival. The reaction_id is
   * removed when the supplemental card is successfully sent. Native
   * consumption and submit ACKs keep it visible while the card is pending.
   * Stop/exit and terminal cleanup also release their owned reactions.
   * User feedback (2026-05-15): replacing OneSecond with a second
   * CheckMark stacked two emojis on the same row; cleaner UX is
   * "queued → released" via removal, not "queued → done" via
   * stacking. */
  pendingReactionIds = new Map<string, string>()
  /** Snapshot of `pendingReactionIds` taken when the init handler
   * claims a merged batch — these are the Feishu messages whose
   * OneSecond reactions are the currently-open turn's responsibility
   * to clear (via deleteReaction). Empty for eager-opened solo turns. */
  currentBatchReactionIds = new Map<string, string>()
  private pendingHumanDelivery: PendingHumanDelivery | null = null
  private ackedHumanDelivery: PendingHumanDelivery | null = null
  private restoredHumanDelivery: PendingHumanDelivery | null = null
  /** Count of `system/init` events seen this subprocess. The first one is
   * the boot init (claimed by whichever user message lands first); later
   * ones can mark the start of SDK-driven queued user message draining.
   * Reset on stop/restart/exit
   * since `init` re-fires after every spawn. */
  private initCount = 0
  /** Sync guard set before any `await` in the eager-open path of
   * `onUserMessage`, cleared after `currentTurn` is set. Closes the race
   * where an SDK-emitted `init` event lands during the eager open's
   * Feishu API await — without this, the init handler would observe
   * `currentTurn === null && queue empty` (we've already shifted) and
   * incorrectly open a second card for the same user message. The flag
   * tells the init handler "an eager open is already
   * claiming the slot, stand down". */
  openingTurn = false
  /** 开卡事务 owner(统一两类凭据):上游 TurnOpenOwner(带 token/proc/
   *  procEpoch/done,本文件 beginTurnOpen 装配),或本地轻量
   *  TurnOpenTerminalStash(仅承载终态载荷)。两者互斥占用同一槽位 ——
   *  同进程内只允许一个开卡事务。 */
  private openingTurnOwner: TurnOpenOwner | TurnOpenTerminalStash | null = null
  /** Resolves when the current turn-open transaction releases. Same-process
   * follow-up opens await it instead of replacing openingTurnOwner.(上游
   * 7c14677 TurnOpenOwner.done 的本地 opaque-token 适配) */
  private openingTurnDone: { promise: Promise<void>; resolve: () => void } | null = null
  /** 在途 turn close 集合(ff44afb turnCloseInflight 最小集,04-05 甄别红例):
   * closeTurnCard 同步摘除 currentTurn 后其 flush/终态写仍在途;restart 在
   * spawn 前 waitForTurnCloses 等全部落地,防旧卡终态写与新进程新卡交错。
   * 哨兵 promise 只 resolve——close 自身错误已在其调用点捕获/记录。
   * stop/exit 未接线(首跑无红例,04-05 处置清单记差集)。 */
  private turnCloseInflight = new Set<Promise<void>>()
  private fileDeliveries = new Set<FileDeliveryHandle>()
  private turnCounter = 0
  /** 开卡事务序号(beginTurnOpen 的 token 来源,并发探测用)。 */
  private turnOpenSequence = 0
  private lifecycleEpoch = 0
  private lifecycleOwner: LifecycleLease | null = null
  private disposed = false
  private pendingSpawnOwnership: { lease: LifecycleLease; proc: AgentProcess } | null = null
  activeTurnInterrupt: TurnInterruptContext | null = null
  // Last known resumable thread id. Persisted once a turn starts, so
  // `restart` can resume an in-flight conversation even if the daemon
  // exits before the turn finishes.
  lastSessionId: string | null = null
  /** ConversationRef 形态的恢复目标(ff44afb):lastSessionId 的带 cwd 版。
   *  cwd:null = legacy 旧记录,resume 前须经 resolveLegacyResumeRef 权威升级。 */
  lastSessionRef: ConversationRef | null = null
  selectedProvider: AgentProvider = 'claude'
  selectedModel: string | null = null
  selectedEffort: AgentReasoningEffort | null = null
  /** 当前 token source id(账号)。token source 决定 agent + 凭据 + 模型 + 额度查询。
   *  null = 未配 token source,走旧路径(provider/model 自治)。 */
  selectedTokenSourceId: string | null = null
  modelPanels = new Map<string, sessionModel.ModelPanelState>()
  /** Feishu message id of the live GSD status panel (session-memory only). */
  gsdPanelMessageId: string | null = null
  /** Generation stamp for GSD panel buttons; actions must match or are stale. */
  gsdPanelGen = ''
  /** Until-ms for “new task name” capture; 0 = off. */
  gsdAwaitingNameUntil = 0
  /** Session-local selected GSD workstream; task status remains disk-backed. */
  gsdSelectedTaskSlug = ''
  /**
   * Session-local: this chat is currently executing GSD for `taskSlug`.
   * Set on GSD inject / `[Lodestar GSD]` user text; cleared on pause/complete/
   * stop, or when a non-GSD message opens its own turn. Not persisted.
   */
  gsdExecution: { taskSlug: string; source: 'inject' | 'message'; at: number } | null = null
  modelSettingsChange: sessionModel.ModelSettingsChange | null = null
  modelSettingsChangesClosed = false
  modelPanelRefreshEpoch = 0
  /** 补录应答态:点「➕ 补录模型」后置位,下一条群消息(裸词命令除外)作为
   *  模型名消费(校验/补录)。一次性,消费或取消即清。cardMessageId 是补录
   *  提示卡的消息 id —— 消费后原位更新它(通过→effort 卡;失败→红字),
   *  不单发群消息(和正常消息流混淆会产生"下条是否还是模型名"的歧义)。 */
  modelCustomPrompt: { sourceId: string, panelId: string, cardMessageId: string } | null = null
  private startedAt: number = 0
  private cumStats: CumStats = { tokens: 0, costUsd: 0, turns: 0 }
  private lastTurnDelta: LastTurnDelta | null = null
  private currentTurnUsageBaseline: CodexUsage | null = null
  private currentTurnUsageBaselineKnown = false
  private lastTurnUsage: CodexUsage | null = null
  /** Resume path can restore a historical thread without replaying its
   * absolute token totals into the new subprocess. Until we observe one
   * fresh absolute total snapshot, the next turn's baseline is unknown
   * and must not be guessed as zero. */
  private usageTotalsSeedUnknown = false
  /** materialization 失败诊断去重(4185808-D):同一错误文案只发一次群内
   *  可观测消息;成功持久化后清零,下一轮新错误重新可见。 */
  private resumePersistenceError: string | null = null
  /** A failed daemon recovery must not turn the next queued message into a
   * fresh conversation. Retain this intent until an explicit lifecycle action
   * or a successful recovery resolves it. */
  private daemonRestoreRequired = false
  /** Set while the `compact` command owns a status card for a standalone
   * compaction. Suppresses the generic no-turn compaction text alert;
   * command feedback is rendered on that status card instead. */
  manualContextCompactionPending = false
  runningAgy: sessionAgy.AgyTaskState | null = null
  startingAgy = false
  agyForwardPrompts = new Map<string, sessionAgy.AgyForwardRecord>()
  /** Claude Code Task 工具(TaskCreate/Update/List/Get)的累积任务板。codex
   * 的 TodoWrite 一次就带完整列表,直接渲染即可;但 Claude Code 把它拆成 4
   * 个单点工具,只有 TaskList 才有完整快照。这里跨 turn / rotate 累积一份
   * 以 task id 为 key 的 board(官方 todo-tracking 文档推荐的做法),每次 Task
   * 工具完成时由 session-tools.ts 调 applyTaskTool 更新,渲染整个 board 而非
   * 孤立的单条 —— 见 cards/task-board.ts。 */
  taskBoard: cards.TaskBoardEntry[] = []
  readonly watchdog: TurnWatchdog
  readonly watchdogSettings: WatchdogSettings
  readonly toolFailureLoop = new ToolFailureLoopGuard()
  toolFailureLoopTurn: TurnState | null = null
  toolFailureLoopAction: ToolFailureLoopAction | null = null
  watchdogContext: WatchdogTurnContext | null = null
  watchdogAction: WatchdogActionTransaction | null = null
  preservedWatchdogRecovery: PreservedWatchdogRecovery | null = null
  watchdogTickHandle: ReturnType<typeof setInterval> | null = null
  modelSwitchOperation: ModelSwitchTransaction | null = null
  codexCollabAgentStates = new Map<string, string>()
  codexCollabAgentStatesByTool = new Map<string, Map<string, string>>()
  codexSubagentActivityIds = new Set<string>()
  activeCodexSubagentActivities = new Set<string>()
  pendingWatchdogIdentity: PendingWatchdogIdentity | null = null
  watchdogOpeningTurnCounter: number | null = null
  watchdogOpeningProc: AgentProcess | null = null
  watchdogOpeningToken: object | null = null

  constructor(
    public readonly sessionName: string,
    public readonly chatId: string,
    public opts: SessionOpts = {},
  ) {
    this.agentCards = opts.agentCards ?? createAgentCards()
    Session.all.add(this)
    // 无持久化选择(全新群 / 从未切过 model)时,采用 config.toml [claude]
    // default_model 声明的默认档位 —— 让只订阅 GLM 的用户首条消息直接走 GLM,
    // 不必先手动切一次。未声明时保持 null,走下方 spawn 的硬编码登录默认(Fable 5)。
    // 合并调和(取舍):默认档(config.toml [claude] default_model)不含 token
    // source 信息,两个来源统一按 SessionModelSelection 收口 —— 下方
    // selection.tokenSourceId 的旧数据回退推导对缺省成员同样成立。
    const selection: feishu.SessionModelSelection | null = feishu.getSessionModelSelection(sessionName)
      ?? sessionModel.configuredDefaultSelection()
    this.selectedProvider = selection?.provider ?? 'claude'
    this.selectedModel = selection?.model ?? null
    this.selectedEffort = selection?.effort ?? null
    if (selection) {
      // 合并调和(取舍):持久化选择携带已注册 token source 时,模型 slug 归属
      // 该 source 的模型目录(上游「token source 持久化真实模型 slug,不能把
      // GLM-5.2 归一成 claude:glm」——反向同理:不得把面板选的 GLM-5.2/
      // 自定义目录档改写成固定项 claude:fable)。固定选项归一(本地语义)只作用
      // 于无 token source 的旧档位 key 持久化:codex:grok/grokcc 迁移、退役档位
      // 回落、无选择的默认态。
      const persistedSource = selection.tokenSourceId ? getTokenSource(selection.tokenSourceId)
        : selection.model === 'claude:glm' ? getTokenSource('glm')
        : selection.model?.startsWith('deepseek-') ? getTokenSource('deepseek') : undefined
      if (!persistedSource) {
        // 历史持久化的选择归一到当前固定选项集；旧 codex:grok/grokcc 迁到
        // 对应 Claude Agent SDK 档位。仅在有持久化选择时归一；无选择
        // (默认)保持 null,交给 spawn 默认逻辑。
        const norm = sessionModel.normalizePersistedModelSelection(
          this.selectedProvider, this.selectedModel, this.selectedEffort,
        )
        this.selectedProvider = norm.provider
        this.selectedModel = norm.model
        this.selectedEffort = norm.effort
      }
    }
    // 推导 tokenSourceId(账号):优先持久化值,否则从 provider/model 映射 registry 的 source。
    // 推导到 token source 后,以 ts.agent 校正 selectedProvider(token source 决定 agent)。
    this.selectedTokenSourceId = this.deriveTokenSourceId(selection
      ? { ...selection, provider: this.selectedProvider, model: this.selectedModel }
      : null)
    const derivedTs = getTokenSource(this.selectedTokenSourceId)
    if (derivedTs) {
      this.selectedProvider = derivedTs.agent
      // 仅迁移旧版固定 profile 键。新版 token source 持久化真实模型 slug，
      // 不能再把 GLM-5.2 归一成 claude:glm，否则重启会把错误模型名交给 SDK。
      if (derivedTs.id === 'glm' && this.selectedModel === 'claude:glm') {
        this.selectedModel = derivedTs.defaultModel
        this.selectedEffort = 'max'
      }
    }
    if (this.selectedModel) {
      logDiagnostic("session: restored selected")
    }
    const projectName = feishu.tempProjectName(sessionName) ?? sessionName
    const projectWatchdogMode = feishu.projectProfile(projectName)?.watchdogMode
    const configuredWatchdog = config.watchdog
    this.watchdogSettings = {
      mode: projectWatchdogMode ?? configuredWatchdog?.codexMode ?? DEFAULT_CODEX_WATCHDOG.mode,
      stallMs: configuredWatchdog?.stallMs ?? DEFAULT_CODEX_WATCHDOG.stallMs,
      repeatNoopLimit: configuredWatchdog?.repeatNoopLimit ?? DEFAULT_CODEX_WATCHDOG.repeatNoopLimit,
      silentWarnMs: configuredWatchdog?.silentWarnMs ?? DEFAULT_CODEX_WATCHDOG.silentWarnMs,
      interruptGraceMs: configuredWatchdog?.interruptGraceMs ?? DEFAULT_CODEX_WATCHDOG.interruptGraceMs,
    }
    this.watchdog = new TurnWatchdog(this.watchdogSettings)
    // Restore last-known thread/session id for the selected backend from
    // disk so a daemon restart (systemctl, crash, watchdog) doesn't
    // strand the user with a fresh conversation when they next type
    // `restart`.
    this.lastSessionRef = feishu.getSessionResumeRef(sessionName, this.selectedProvider)
    this.lastSessionId = this.lastSessionRef?.sessionId ?? null
    if (this.lastSessionId) {
      logDiagnostic("session: restored")
    }
    // pendingLaunch 恢复区(4185808 终态,挂账 #2):daemon 在 Claude fork 的
    // startup grace 内崩溃时,磁盘 intent 在下次构造复活。provider 已切 → 先清
    // (不 validate 异地 cwd);Claude → stillPending/materialized 判定,二者皆非
    // = 不一致绑定 fail-loud throw(不得静默 fresh 丢掉用户的分叉意图)。
    const pendingLaunch = feishu.getPendingConversationLaunch(sessionName)
    if (pendingLaunch) {
      if (this.selectedProvider !== 'claude') {
        feishu.replaceTurnAnchors(sessionName, [], null, null)
      } else {
        validateConversationLaunch(pendingLaunch.launch, 'claude', this.workDir)
        const stillPending = this.lastSessionId === pendingLaunch.previousSessionId
        const materializedRef = this.lastSessionRef
        const materialized = !stillPending
          && materializedRef?.provider === 'claude'
          && materializedRef.cwd === this.workDir
          && materializedRef.sessionId !== pendingLaunch.launch.source.sessionId
          && materializedRef.sessionId !== pendingLaunch.previousSessionId
        if (!stillPending && !materialized) {
          throw new Error(`pending Claude fork has inconsistent resume binding for session "${sessionName}"`)
        }
        this.pendingConversationMaterialization = pendingLaunch
      }
    }
  }

  /** Minimal cross-chat snapshot for the `hi` peer-list section.
   * `startedAt` stays private so this is the documented read path. */
  peerSnapshot(): { name: string; status: Status; uptimeMs?: number; codexAccountName?: string; claudeAccountName?: string } {
    return {
      name: this.sessionName,
      status: this.status,
      uptimeMs: this.startedAt ? (Date.now() - this.startedAt) : undefined,
      ...(this.proc?.isAlive() && this.proc.provider === 'codex'
        && !this.currentTokenSource()?.codexApiProvider
        && this.proc.codexAccountSelectionMode?.() !== null
        && !(this.proc.turnRetry?.reason === 'quota' && this.proc.turnRetry.phase === 'waiting')
        ? { codexAccountName: codexAccounts.get(processCodexAccount(this.proc)).name } : {}),
      ...(this.proc?.isAlive() && this.proc.tokenSourceId === 'claude-sub' && processClaudeAccount(this.proc)
        ? { claudeAccountName: claudeAccounts.get(processClaudeAccount(this.proc)!).name } : {}),
    }
  }

  get workDir(): string {
    // 临时群先剥 * 后缀,再按普通/工作树群名解析(经 worktreeSessionDir,上游
    // ff44afb):从 worktree 发起 btw/fk 仍落在原 worktree,而不是悄悄回主项目
    // 目录。本地 projectProfile override 分支保留(翻译表 #15):按剥后缀的完整
    // 群名(含 worktree 括号)查 [projects.<name>].cwd,命中即覆盖——普通群/
    // temp 子群的 override 解析零变化。
    const baseName = feishu.tempProjectName(this.sessionName) ?? this.sessionName
    const override = feishu.projectProfile(baseName)?.cwd
    if (override && override.trim()) return override
    return sessionWorktree.worktreeSessionDir(this)
  }
  isRunning(): boolean { return !!this.proc && this.proc.isAlive() }
  currentProvider(): AgentProvider { return this.selectedProvider }

  /** Work that makes replacing an otherwise idle process destructive. Keep
   * this as the single predicate for both the model picker and the final stop
   * boundary so newly-added queue/input states cannot drift between them. */
  private hasProcessMutationBlockingWork(): boolean {
    return this.status === 'starting' ||
      this.currentTurn !== null ||
      this.openingTurn ||
      this.pendingHumanDelivery !== null ||
      this.ackedHumanDelivery !== null ||
      this.restoredHumanDelivery !== null ||
      this.pendingUserMessageCount > 0 ||
      this.hasQueuedHumanWork() ||
      this.pendingPermissions.size > 0 ||
      this.pendingAsks.size > 0 ||
      this.pendingHostAsks.size > 0 ||
      this.manualContextCompactionPending ||
      this.backgroundTasks.some(task => !cards.isBgTerminal(task)) ||
      this.pendingBgTasks.some(task => !cards.isBgTerminal(task)) ||
      this.activeCodexSubagentActivities.size > 0 ||
      this.codexCollabAgentStates.size > 0 ||
      this.watchdogActionInFlight ||
      this.toolFailureLoopActionInFlight ||
      this.hasPreservedWatchdogRecovery() ||
      this.startingAgy ||
      this.runningAgy !== null
  }

  isModelSwitchBusy(): boolean {
    return this.modelSwitchPending || this.hasProcessMutationBlockingWork()
  }

  beginLifecycle(kind: LifecycleKind): LifecycleLease {
    const lease = Object.freeze({ epoch: ++this.lifecycleEpoch, kind })
    this.lifecycleOwner = lease
    if (this.preservedWatchdogRecovery && this.preservedWatchdogRecovery.lease !== lease) {
      this.preservedWatchdogRecovery.phase = 'failed'
    }
    return lease
  }

  ownsLifecycle(lease: LifecycleLease | null | undefined): lease is LifecycleLease {
    if (!lease || this.lifecycleOwner !== lease) return false
    return !this.disposed || lease.kind === 'dispose'
  }

  private lifecycleLease(kind: LifecycleKind, opts: LifecycleProgressOpts): LifecycleLease {
    return opts.lifecycleLease ?? this.beginLifecycle(kind)
  }

  private clearPendingSpawn(lease: LifecycleLease, proc: AgentProcess): void {
    if (this.pendingSpawnOwnership?.lease === lease && this.pendingSpawnOwnership.proc === proc) {
      this.pendingSpawnOwnership = null
    }
  }

  private async discardLocalProcess(lease: LifecycleLease, proc: AgentProcess): Promise<void> {
    this.clearPendingSpawn(lease, proc)
    if (this.proc === proc && !this.ownsLifecycle(lease)) return
    if (this.proc === proc) this.proc = null
    if (proc.isAlive()) await proc.kill(1_000).catch(() => {})
  }

  get watchdogActionInFlight(): boolean {
    return !!this.watchdogAction && this.ownsLifecycle(this.watchdogAction.lease)
  }

  get toolFailureLoopActionInFlight(): boolean {
    return !!this.toolFailureLoopAction && this.ownsLifecycle(this.toolFailureLoopAction.lease)
  }

  get watchdogActionProc(): AgentProcess | null {
    return this.watchdogActionInFlight ? this.watchdogAction?.proc ?? null : null
  }

  get watchdogResumeFailed(): boolean {
    return this.preservedWatchdogRecovery?.phase === 'failed'
  }

  get preservingRestartProc(): AgentProcess | null {
    return this.preservedWatchdogRecovery?.replacementProc ?? null
  }

  get modelSwitchPending(): boolean {
    return !!this.modelSwitchOperation && this.ownsLifecycle(this.modelSwitchOperation.lease)
  }

  beginModelSwitch(lease: LifecycleLease): ModelSwitchTransaction | null {
    if (!this.ownsLifecycle(lease) || this.hasPreservedWatchdogRecovery()) return null
    const transaction: ModelSwitchTransaction = Object.freeze({ token: {}, lease })
    this.modelSwitchOperation = transaction
    return transaction
  }

  ownsModelSwitch(transaction: ModelSwitchTransaction): boolean {
    return this.modelSwitchOperation === transaction && this.ownsLifecycle(transaction.lease)
  }

  finishModelSwitch(transaction: ModelSwitchTransaction): void {
    if (this.modelSwitchOperation === transaction) this.modelSwitchOperation = null
  }

  hasPreservedWatchdogRecovery(): boolean {
    return this.preservedWatchdogRecovery !== null
  }

  beginWatchdogAction(
    ctx: WatchdogTurnContext,
    kind: 'watchdog-recovery' | 'watchdog-exhausted',
  ): WatchdogActionTransaction | null {
    if (
      !ctx.threadId ||
      !ctx.turnId ||
      ctx.proc.provider !== 'codex' ||
      !this.watchdogContextIsCurrent(ctx) ||
      this.hasPreservedWatchdogRecovery()
    ) return null
    if (this.watchdogAction && this.ownsLifecycle(this.watchdogAction.lease)) return null
    const lease = this.beginLifecycle(kind)
    const transaction: WatchdogActionTransaction = Object.freeze({
      token: {},
      lease,
      proc: ctx.proc,
      turn: ctx.turn,
      provider: 'codex' as const,
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      recoveryAttempt: this.watchdog.snapshot().recoveryAttempt,
    })
    this.watchdogAction = transaction
    return transaction
  }

  ownsWatchdogAction(transaction: WatchdogActionTransaction): boolean {
    return this.watchdogAction === transaction && this.ownsLifecycle(transaction.lease)
  }

  finishWatchdogAction(transaction: WatchdogActionTransaction): void {
    if (this.watchdogAction === transaction) this.watchdogAction = null
  }

  private createPreservedWatchdogRecovery(input: {
    token: object
    lease: LifecycleLease
    provider: AgentProvider
    threadId: string
    turn: TurnState
    turnId: string
    recoveryAttempt: number
    phase: PreservedWatchdogRecoveryPhase
  }): PreservedWatchdogRecovery {
    const recovery: PreservedWatchdogRecovery = {
      ...input,
      replacementProc: null,
    }
    Object.defineProperties(recovery, {
      provider: { value: input.provider, enumerable: true, writable: false },
      threadId: { value: input.threadId, enumerable: true, writable: false },
    })
    return recovery
  }

  private watchdogActionTurnStillOwned(transaction: WatchdogActionTransaction): boolean {
    return this.currentTurn === transaction.turn &&
      transaction.turn.backendThreadId === transaction.threadId &&
      transaction.turn.backendTurnId === transaction.turnId
  }

  private watchdogActionProcessMatches(
    transaction: WatchdogActionTransaction,
    proc: AgentProcess | null | undefined,
  ): proc is AgentProcess {
    return !!proc && proc.isAlive() &&
      proc.provider === transaction.provider &&
      proc.sessionId === transaction.threadId
  }

  preserveWatchdogRecovery(transaction: WatchdogActionTransaction): PreservedWatchdogRecovery | null {
    if (!this.ownsWatchdogAction(transaction)) return null
    const existing = this.preservedWatchdogRecovery
    if (existing) {
      if (existing.provider !== transaction.provider || existing.threadId !== transaction.threadId) return null
      existing.lease = transaction.lease
      existing.phase = 'recovering'
      return existing
    }
    const recovery = this.createPreservedWatchdogRecovery({
      token: transaction.token,
      lease: transaction.lease,
      provider: transaction.provider,
      threadId: transaction.threadId,
      turn: transaction.turn,
      turnId: transaction.turnId,
      recoveryAttempt: transaction.recoveryAttempt,
      phase: 'recovering',
    })
    this.preservedWatchdogRecovery = recovery
    return recovery
  }

  beginPreservedWatchdogRetry(lease: LifecycleLease): PreservedWatchdogRecovery | null {
    const recovery = this.preservedWatchdogRecovery
    if (!recovery || !this.ownsLifecycle(lease)) return null
    recovery.lease = lease
    recovery.phase = 'retrying'
    recovery.replacementProc = null
    return recovery
  }

  ownsPreservedWatchdogRecovery(
    recovery: PreservedWatchdogRecovery,
    lease: LifecycleLease = recovery.lease,
  ): boolean {
    return this.preservedWatchdogRecovery === recovery &&
      recovery.lease === lease &&
      this.ownsLifecycle(lease)
  }

  markPreservedWatchdogRecoveryFailed(
    recovery: PreservedWatchdogRecovery,
    lease: LifecycleLease = recovery.lease,
  ): void {
    if (this.preservedWatchdogRecovery !== recovery || recovery.lease !== lease) return
    recovery.phase = 'failed'
  }

  completePreservedWatchdogRecovery(
    recovery: PreservedWatchdogRecovery,
    lease: LifecycleLease = recovery.lease,
  ): void {
    if (!this.ownsPreservedWatchdogRecovery(recovery, lease)) return
    this.preservedWatchdogRecovery = null
  }

  discardPreservedWatchdogRecovery(_reason: string): void {
    this.preservedWatchdogRecovery = null
  }

  private preserveCurrentWatchdogContext(lease: LifecycleLease): PreservedWatchdogRecovery | null {
    const context = this.watchdogContext
    if (
      !context ||
      !context.threadId ||
      !context.turnId ||
      context.proc.provider !== 'codex' ||
      !this.watchdogTurnStillOwned(context) ||
      !this.ownsLifecycle(lease)
    ) return null
    const recovery = this.createPreservedWatchdogRecovery({
      token: {},
      lease,
      provider: 'codex',
      threadId: context.threadId,
      turn: context.turn,
      turnId: context.turnId,
      recoveryAttempt: this.watchdog.snapshot().recoveryAttempt,
      phase: 'retrying',
    })
    this.preservedWatchdogRecovery = recovery
    return recovery
  }

  beginWatchdogTurn(turn: TurnState, proc: AgentProcess, now = Date.now()): void {
    this.endWatchdogTurn()
    if (
      proc.provider !== 'codex' ||
      !proc.isAlive() ||
      this.watchdogSettings.mode === 'off' ||
      this.proc !== proc ||
      this.currentTurn !== turn
    ) return

    this.watchdog.beginTurn(`turn:${this.turnCounter}`, turn.trigger, now)
    this.watchdogContext = {
      proc,
      turn,
      threadId: proc.sessionId,
      turnId: null,
      identityConflict: false,
    }
    const pending = this.pendingWatchdogIdentity
    if (
      pending?.proc === proc &&
      pending.turnCounter === this.turnCounter &&
      (!proc.sessionId || !pending.threadId || pending.threadId === proc.sessionId)
    ) {
      if (pending.identityConflict) this.watchdogContext.identityConflict = true
      else this.applyWatchdogIdentity(pending.threadId, pending.turnId)
    }
    this.pendingWatchdogIdentity = null
    this.startWatchdogTick(this.watchdogContext)
  }

  endWatchdogTurn(): void {
    this.stopWatchdogTick()
    this.watchdog.endTurn()
    this.watchdogContext = null
    if (!this.proc) this.clearCodexProcessActivityState()
  }

  startWatchdogTick(ctx: WatchdogTurnContext): void {
    this.stopWatchdogTick()
    if (
      this.watchdogContext !== ctx ||
      this.currentTurn !== ctx.turn ||
      this.proc !== ctx.proc ||
      !ctx.proc.isAlive() ||
      ctx.proc.provider !== 'codex' ||
      this.watchdogSettings.mode === 'off'
    ) return
    this.watchdogTickHandle = setInterval(() => {
      this.evaluateWatchdogTick()
    }, WATCHDOG_TICK_MS)
    ;(this.watchdogTickHandle as { unref?: () => void }).unref?.()
  }

  stopWatchdogTick(): void {
    if (this.watchdogTickHandle) clearInterval(this.watchdogTickHandle)
    this.watchdogTickHandle = null
  }

  clearWatchdogRuntime(reason: string): void {
    this.endWatchdogTurn()
    this.cancelTurnInterrupt(reason)
    this.watchdogAction = null
    this.pendingWatchdogIdentity = null
    this.watchdogOpeningTurnCounter = null
    this.watchdogOpeningProc = null
    this.watchdogOpeningToken = null
    this.clearCodexProcessActivityState()
  }

  evaluateWatchdogTick(now = Date.now()): void {
    const ctx = this.watchdogContext
    if (
      !ctx ||
      this.watchdogContext !== ctx ||
      this.currentTurn !== ctx.turn ||
      this.proc !== ctx.proc ||
      !ctx.proc.isAlive() ||
      ctx.proc.provider !== 'codex' ||
      this.watchdogSettings.mode === 'off'
    ) {
      this.stopWatchdogTick()
      return
    }

    const verdict = this.watchdog.evaluate(now, this.watchdogSafetySnapshot(ctx))
    if (verdict.type === 'none') return
    if (verdict.type === 'silent_warn' || verdict.type === 'loop_warn') {
      this.applyWatchdogWarning(verdict)
      this.logWatchdog(
        verdict.type === 'silent_warn'
          ? 'turn_watchdog_silent_warn'
          : 'turn_watchdog_loop_warn',
        ctx,
        verdict,
      )
      return
    }
    if (verdict.type === 'recover') {
      void this.runWatchdogRecovery(ctx, verdict).catch(_e => {
        logError("session: watchdog scheduler recovery rejected", _e)
      })
      return
    }
    void this.runWatchdogExhausted(ctx, verdict).catch(_e => {
      logError("session: watchdog scheduler exhausted action rejected", _e)
    })
  }

  private clearCodexProcessActivityState(): void {
    this.codexCollabAgentStates.clear()
    this.codexCollabAgentStatesByTool.clear()
    this.codexSubagentActivityIds.clear()
    this.activeCodexSubagentActivities.clear()
  }

  watchdogContextIsCurrent(ctx: WatchdogTurnContext): boolean {
    return !ctx.identityConflict && this.watchdogContext === ctx && this.currentTurn === ctx.turn && this.proc === ctx.proc && ctx.proc.isAlive() &&
      (!ctx.threadId || (ctx.proc.sessionId === ctx.threadId && ctx.turn.backendThreadId === ctx.threadId)) &&
      (!ctx.turnId || ctx.turn.backendTurnId === ctx.turnId)
  }

  private configuredWatchdogSettings(): WatchdogSettings {
    return this.watchdogSettings
  }

  private watchdogTurnStillOwned(ctx: WatchdogTurnContext): boolean {
    return !ctx.identityConflict && this.currentTurn === ctx.turn &&
      (!ctx.threadId || ctx.turn.backendThreadId === ctx.threadId) &&
      (!ctx.turnId || ctx.turn.backendTurnId === ctx.turnId)
  }

  private watchdogGuardsPass(ctx: WatchdogTurnContext, ignoreActionLatch = false): boolean {
    const safety = this.watchdogSafetySnapshot(ctx)
    return safety.currentTurn && safety.eligibleTrigger && !safety.realToolRunning &&
      !safety.backgroundWorkRunning && !safety.awaitingInput && !safety.compactionRunning &&
      !safety.rotationRunning && !safety.agyRunning && !safety.queuedHumanWork &&
      !safety.modelSwitchPending && (ignoreActionLatch || !safety.recoveryActionInFlight)
  }

  private logWatchdog(
    event: WatchdogLogEvent,
    _ctx: WatchdogTurnContext,
    _detail: {
      idleMs?: number
      repeatCount?: number
      fingerprintHash?: string
      outcome?: string
    } = {},
  ): void {
    switch (event) {
      case 'turn_watchdog_silent_warn': logDiagnostic('session: watchdog silent warning'); break
      case 'turn_watchdog_loop_warn': logDiagnostic('session: watchdog loop warning'); break
      case 'turn_watchdog_recover_start': logDiagnostic('session: watchdog recovery started'); break
      case 'turn_watchdog_interrupt_settled': logDiagnostic('session: watchdog interrupt settled'); break
      case 'turn_watchdog_resume_fallback': logDiagnostic('session: watchdog resume required'); break
      case 'turn_watchdog_recover_started': logDiagnostic('session: watchdog resumed'); break
      case 'turn_watchdog_exhausted': logDiagnostic('session: watchdog recovery exhausted'); break
      case 'turn_watchdog_recover_failed': logDiagnostic('session: watchdog recovery failed'); break
    }
  }

  hasQueuedHumanWork(): boolean {
    return this.pendingMidTurnMsgs.length > 0 ||
      this.pendingTurnInputs.length > 0 ||
      this.multiMsgBuffer !== null
  }

  watchdogSafetySnapshot(ctx: WatchdogTurnContext): WatchdogSafetySnapshot {
    const watchdog = this.watchdog.snapshot()
    const backgroundWorkRunning =
      this.backgroundTasks.some(task => !cards.isBgTerminal(task)) ||
      this.pendingBgTasks.some(task => !cards.isBgTerminal(task)) ||
      this.activeCodexSubagentActivities.size > 0 ||
      this.codexCollabAgentStates.size > 0
    return {
      currentTurn: this.watchdogContextIsCurrent(ctx) && !!ctx.threadId && !!ctx.turnId,
      eligibleTrigger: ['user_message', 'bg_task_resume', 'watchdog_resume'].includes(ctx.turn.trigger),
      realToolRunning: watchdog.pendingCandidateCount > 0 || watchdog.activeRealToolCount > 0,
      backgroundWorkRunning,
      awaitingInput: this.pendingPermissions.size > 0 || this.pendingAsks.size > 0 || this.pendingHostAsks.size > 0,
      compactionRunning: this.manualContextCompactionPending || ctx.turn.contextCompactionPending.size > 0,
      rotationRunning: ctx.turn.rotating !== null,
      agyRunning: this.startingAgy || this.runningAgy !== null,
      queuedHumanWork: this.hasQueuedHumanWork(),
      modelSwitchPending: this.modelSwitchPending,
      recoveryActionInFlight: this.watchdogActionInFlight,
    }
  }

  observeWatchdogToolStart(source: AgentProcess, id: string, name: string, input: unknown): void {
    const context = this.watchdogContext
    if (!context || context.proc !== source || this.proc !== source || !this.watchdogContextIsCurrent(context)) return
    if (this.watchdog.observeToolStart(id, name, input, Date.now())) {
      this.clearWatchdogFooterWarning(context)
    }
  }

  observeWatchdogToolResult(source: AgentProcess, id: string, content: unknown, isError: boolean): void {
    const context = this.watchdogContext
    if (!context || context.proc !== source || this.proc !== source || !this.watchdogContextIsCurrent(context)) return
    if (this.watchdog.observeToolResult(id, content, isError, Date.now())) {
      this.clearWatchdogFooterWarning(context)
    }
  }

  observeToolFailureLoop(
    source: AgentProcess,
    toolName: string,
    input: unknown,
    output: unknown,
    isError: boolean,
  ): void {
    const turn = this.currentTurn
    // 合并加固:上游测试组经适配注入的 source 可为 null(上游 completeTool
    // 原本无 source 参数,失败环观测是本地独有),null 即无从观测,直接返回。
    if (!turn || !source || this.proc !== source || !source.isAlive()) return
    if (this.toolFailureLoopTurn !== turn) {
      this.toolFailureLoop.reset()
      this.toolFailureLoopTurn = turn
    }
    if (!isError) {
      this.toolFailureLoop.observeSuccess()
      return
    }

    const verdict = this.toolFailureLoop.observeFailure(toolName, input, output)
    if (verdict.type === 'correct') {
      logDiagnostic("session: repeated tool failure correction tool")
      return
    }
    if (verdict.type !== 'stop' || this.toolFailureLoopActionInFlight) return
    if (this.toolFailureLoopAction && !this.toolFailureLoopActionInFlight) {
      this.toolFailureLoopAction = null
    }
    void this.runToolFailureLoopStop(source, turn, verdict).catch(_e => {
      logError("session: tool failure loop stop rejected", _e)
    })
  }

  clearToolFailureLoop(turn?: TurnState | null): void {
    if (turn && this.toolFailureLoopTurn && this.toolFailureLoopTurn !== turn) return
    this.toolFailureLoop.reset()
    this.toolFailureLoopTurn = null
  }

  private toolFailureLoopStatus(verdict: Extract<ToolFailureLoopVerdict, { type: 'stop' }>): string {
    const tool = verdict.toolName.replace(/\s+/g, ' ').trim().slice(0, 48) || '工具'
    return `🛑 已停止：${tool} 连续 ${verdict.repeatCount} 次相同失败`
  }

  private ownsToolFailureLoopAction(action: ToolFailureLoopAction): boolean {
    return this.toolFailureLoopAction === action && this.ownsLifecycle(action.lease)
  }

  async runToolFailureLoopStop(
    source: AgentProcess,
    turn: TurnState,
    verdict: Extract<ToolFailureLoopVerdict, { type: 'stop' }>,
  ): Promise<void> {
    if (
      this.toolFailureLoopActionInFlight ||
      this.proc !== source ||
      this.currentTurn !== turn ||
      !source.isAlive()
    ) return

    const lease = this.beginLifecycle('tool-failure-loop')
    const action: ToolFailureLoopAction = Object.freeze({ lease, proc: source, turn, verdict })
    this.toolFailureLoopAction = action
    const status = this.toolFailureLoopStatus(verdict)
    this.stopFooterStatus(turn)
    turn.footerStatusOverride = status
    logDiagnostic("session: tool failure loop stop tool")

    try {
      const interrupt = this.beginTurnInterrupt('tool_failure_loop')
      if (!interrupt) return
      const footerPatch = this.replaceFooterContent(turn.cardId, this.withModel(status, turn)).catch(_e => {
        logError("session: tool failure loop footer patch failed", _e)
      })
      const outcome = await this.waitForTurnSettlement(
        interrupt,
        this.configuredWatchdogSettings().interruptGraceMs,
      )
      await footerPatch
      if (!this.ownsToolFailureLoopAction(action) || outcome.type === 'cancelled') return

      if (outcome.type === 'timeout') {
        this.cancelTurnInterrupt('tool failure loop grace timeout')
        if (this.proc === source) this.proc = null
        if (source.isAlive()) {
          await source.kill(1_000).catch(_e => {
            logError("session: tool failure loop kill failed", _e)
          })
        }
        if (!this.ownsToolFailureLoopAction(action)) return
      }

      if (this.currentTurn === turn) {
        try {
          await this.closeTurnCard(status, {
            forcePush: true,
            preservePendingReactions: true,
          })
        } catch (e) {
          logError("session: tool failure loop card close failed", e)
          await feishu.sendTextRaw(this.chatId, status).catch(() => {})
        }
      }
      if (!this.ownsToolFailureLoopAction(action)) return
      if (this.currentTurn && this.currentTurn !== turn) return

      this.status = this.proc === source && source.isAlive() ? 'idle' : 'stopped'
      this.opts.onLifecycleChange?.()
      if (
        this.pendingMidTurnMsgs.length > 0 &&
        this.proc === source &&
        source.isAlive() &&
        !this.currentTurn
      ) {
        let drainOutcome: MidTurnDrainOutcome = 'preserved'
        try {
          drainOutcome = await this.drainMidTurnAndOpen()
        } catch (e) {
          logError("session: tool failure loop human drain failed", e)
        }
        if (!this.ownsToolFailureLoopAction(action)) return
        if (drainOutcome === 'preserved' && this.hasQueuedHumanWork()) {
          await feishu.sendTextRaw(this.chatId, TOOL_FAILURE_QUEUE_PRESERVED_NOTICE).catch(() => {})
        }
      } else if (this.hasQueuedHumanWork() && this.status === 'stopped') {
        await feishu.sendTextRaw(this.chatId, TOOL_FAILURE_QUEUE_PRESERVED_NOTICE).catch(() => {})
      }
    } finally {
      if (this.toolFailureLoopAction === action) this.toolFailureLoopAction = null
      if (this.toolFailureLoopTurn === turn) this.clearToolFailureLoop(turn)
    }
  }

  observeWatchdogMeaningful(source: AgentProcess, label: string): boolean {
    const context = this.watchdogContext
    if (this.proc !== source || context?.proc !== source || !this.watchdogContextIsCurrent(context)) return false
    this.watchdog.observeMeaningful(Date.now(), label)
    this.clearWatchdogFooterWarning(context)
    return true
  }

  private clearWatchdogFooterWarning(context: WatchdogTurnContext): void {
    if (!context.turn.footerStatusOverride) return
    context.turn.footerStatusOverride = null
    this.renderFooterStatus(context.turn)
  }

  applyWatchdogWarning(verdict: WatchdogVerdict): void {
    if (verdict.type !== 'silent_warn' && verdict.type !== 'loop_warn') return
    const context = this.watchdogContext
    if (!context || !this.watchdogContextIsCurrent(context)) return
    context.turn.footerStatusOverride = watchdogFooterContent(verdict.type)
    this.renderFooterStatus(context.turn)
  }

  private applyWatchdogIdentity(threadId: string | null, turnId: string | null): boolean {
    const context = this.watchdogContext
    if (!context || this.currentTurn !== context.turn || this.proc !== context.proc) return false
    if (context.identityConflict) return false
    const resolvedThreadId = threadId ?? context.proc.sessionId
    const threadConflict = !!(
      (context.threadId && resolvedThreadId && context.threadId !== resolvedThreadId) ||
      (context.turn.backendThreadId && resolvedThreadId && context.turn.backendThreadId !== resolvedThreadId)
    )
    const turnConflict = !!(
      (context.turnId && turnId && context.turnId !== turnId) ||
      (context.turn.backendTurnId && turnId && context.turn.backendTurnId !== turnId)
    )
    if (threadConflict || turnConflict) {
      context.identityConflict = true
      logDiagnostic("session: watchdog identity conflict; observation disabled")
      return false
    }
    if (!context.threadId && resolvedThreadId) context.threadId = resolvedThreadId
    if (!context.turnId && turnId) context.turnId = turnId
    if (!context.turn.backendThreadId && context.threadId) context.turn.backendThreadId = context.threadId
    if (!context.turn.backendTurnId && context.turnId) context.turn.backendTurnId = context.turnId
    return true
  }

  private finishWatchdogOpening(
    turnCounter: number,
    discardPending: boolean,
    openingProc: AgentProcess | null,
    openingToken: object,
  ): void {
    const ownsOpening =
      this.watchdogOpeningToken === openingToken &&
      this.watchdogOpeningTurnCounter === turnCounter &&
      (!openingProc || this.watchdogOpeningProc === openingProc)
    if (!ownsOpening) return
    this.watchdogOpeningTurnCounter = null
    this.watchdogOpeningProc = null
    this.watchdogOpeningToken = null
    if (
      discardPending &&
      this.pendingWatchdogIdentity?.turnCounter === turnCounter &&
      (!openingProc || this.pendingWatchdogIdentity.proc === openingProc)
    ) {
      this.pendingWatchdogIdentity = null
    }
  }

  /** Startup and queued/background work reserve once even before a visible main turn opens. */
  hasActiveConversationWork(): boolean {
    return this.status === 'starting' || this.status === 'working' || this.status === 'awaiting_permission'
      || Boolean(this.currentTurn || this.openingTurn || this.steeringSend
        || this.pendingUserMessageCount > 0 || this.pendingMidTurnMsgs.length > 0 || this.pendingTurnInputs.length > 0
        || cards.hasActiveBgTask(this.backgroundTasks) || this.pendingBgTasks.length > 0 || this.backgroundSync
        || this.bgResumeCardless || this.bgResumePending)
  }
  /** Running sessions normally revive after daemon restart. A process kept
   * only because the user's explicit stop could not yet be confirmed must not
   * undo that stop intent on the next boot. */
  shouldRevive(): boolean {
    return this.daemonRestoreRequired || (this.isRunning()
      && this.stoppingProc !== this.proc
      && this.blockedProc !== this.proc)
  }
  /** 保留显式账号；未选择时使用已启用来源，无可用 Claude 来源时明确失败。 */
  private deriveTokenSourceId(selection: { tokenSourceId?: string | null; provider?: string; model?: string | null } | null): string | null {
    const explicit = selection?.tokenSourceId
    // An explicit persisted account is part of the user's routing choice.
    // Preserve it even when temporarily disabled/missing so start() can expose
    // the concrete failure instead of silently billing/sending data through a
    // different account of the same provider.
    if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
    const provider: AgentProvider = (selection?.provider as AgentProvider) ?? this.selectedProvider
    const list = listEnabledTokenSourcesByAgent(provider)
    if (provider === 'claude' && selection?.model === 'claude:glm' && getTokenSource('glm')) return 'glm'
    if (provider === 'claude' && selection?.model?.startsWith('deepseek-') && getTokenSource('deepseek')) return 'deepseek'
    const configuredDefault = list.find(source => config.token_sources?.[source.id]?.default === true)
    if (configuredDefault) return configuredDefault.id
    // 没有可用 Claude 来源时仍保留订阅绑定并报错，不走无来源的本机透传路径。
    if (provider === 'claude' && !list.length && getTokenSource('claude-sub')) return 'claude-sub'
    // 不跨 provider 使用其他默认账号；无来源的 Codex 仍由原生认证处理，Claude 启动会拒绝。
    return list[0]?.id ?? null
  }

  /** 当前 token source(账号)；未配或已删除时返回 undefined。 */
  currentTokenSource(): TokenSource | undefined {
    return this.tokenSource(this.selectedTokenSourceId)
  }

  /** Pending account selection takes effect only after the old process exits. */
  private codexStartAccountOverride: string | undefined
  private claudeStartAccountOverride: string | undefined

  codexAccountId(): string {
    return this.proc?.isAlive() && this.proc.provider === 'codex'
      ? processCodexAccount(this.proc) : this.codexStartAccountOverride ?? codexAccounts.selected(this.sessionName)
  }

  tokenSource(id: string | null | undefined): TokenSource | undefined {
    const source = getTokenSource(id)
    if (!source?.forAccount) return source
    if (source.kind === 'claude-subscription') {
      const account = this.proc?.isAlive() && this.proc.tokenSourceId === id
        ? processClaudeAccount(this.proc) : this.claudeStartAccountOverride
      return account ? getTokenSourceForAccount(id, account) : source
    }
    return getTokenSourceForAccount(id, this.codexAccountId())
  }

  tokenSourceAccountId(id: string | null | undefined): string {
    if (getTokenSource(id)?.kind !== 'claude-subscription') return this.codexAccountId()
    return (this.proc?.isAlive() && this.proc.tokenSourceId === id ? processClaudeAccount(this.proc) : null)
      ?? this.claudeStartAccountOverride ?? DEFAULT_CLAUDE_ACCOUNT
  }

  /** Histories belong to the shared native store, regardless of the billing account. */
  claudeHistoryOptions(): { configDir: string } {
    return { configDir: claudeAccounts.sharedConfigDir() }
  }

  conversationRouting(): SessionConversationRouting {
    const apiCodex = !!this.currentTokenSource()?.codexApiProvider
    return {
      provider: this.selectedProvider,
      tokenSourceId: this.selectedTokenSourceId,
      model: this.selectedModel,
      effort: this.selectedEffort,
      ...(this.selectedTokenSourceId === 'claude-sub' && processClaudeAccount(this.proc)
        ? { claudeAccountId: processClaudeAccount(this.proc)! } : {}),
      ...(apiCodex || this.codexAccountId() === DEFAULT_CODEX_ACCOUNT ? {} : { codexAccountId: this.codexAccountId() }),
      ...(!apiCodex && codexAccounts.preferred(this.sessionName) === null ? { codexAccountAutomatic: true } : {}),
    }
  }

  /** Apply an inherited routing snapshot before a temporary Session starts. */
  applyConversationRouting(routing: SessionConversationRouting): void {
    if (this.isRunning() || this.currentTurn || this.openingTurn) {
      throw new Error('cannot change conversation routing while the session is running')
    }
    const source = getTokenSource(routing.tokenSourceId)
    if (routing.claudeAccountId) claudeAccounts.get(routing.claudeAccountId)
    if (routing.codexAccountId && !source?.codexApiProvider) codexAccounts.get(routing.codexAccountId)
    if (source && source.agent !== routing.provider) {
      throw new Error(`token source "${source.id}" belongs to ${source.agent}, not ${routing.provider}`)
    }
    if (this.selectedProvider !== routing.provider) {
      feishu.replaceTurnAnchors(this.sessionName, [], null, null)
      this.pendingConversationMaterialization = null
    }
    this.selectedProvider = routing.provider
    this.selectedTokenSourceId = routing.tokenSourceId ?? null
    this.selectedModel = routing.model
    this.selectedEffort = routing.effort
    this.claudeStartAccountOverride = routing.provider === 'claude' && routing.tokenSourceId === 'claude-sub'
      ? routing.claudeAccountId : undefined
    this.lastSessionRef = feishu.getSessionResumeRef(this.sessionName, routing.provider)
    this.lastSessionId = this.lastSessionRef?.sessionId ?? null
    feishu.bindSessionModelChecked(
      this.sessionName,
      routing.provider,
      routing.model,
      routing.effort,
      routing.tokenSourceId,
    )
    if (!source?.codexApiProvider) {
      const accountId = routing.codexAccountId ?? DEFAULT_CODEX_ACCOUNT
      if (routing.codexAccountAutomatic) codexAccounts.selectAuto(this.sessionName)
      else if (codexAccounts.selected(this.sessionName) !== accountId) codexAccounts.select(this.sessionName, accountId)
    }
  }

  async listDshConversations(): Promise<ConversationSummary[]> {
    if (this.selectedProvider !== 'dsh') throw new Error('DSH history requested under a different provider')
    // 合并调和(取舍):本地 dsh 是单档后端,源即 `[deepseek-harness]` 配置段
    // (上游形态经注册表 currentTokenSource;本地固定档位流程不绑定注册表)。
    // 未配置/未启用即 fail loud,不放行空凭据查询。
    const source = dshSourceFromConfig()
    if (!source.enabled) throw new Error('DSH token source is unavailable')
    const rows: ConversationSummary[] = await queryDshRuntime({ cwd: this.workDir,
      env: source.spawnEnv(process.env), profile: { loadProjectMcp: false } }, 'session/list', { cwd: this.workDir })
    return rows.filter(row => !isAgentSession('dsh', row.sessionId))
  }

  /** Query Codex history without attaching the catalog process to this Session. */
  async listCodexConversations(): Promise<ConversationSummary[]> {
    if (this.selectedProvider !== 'codex') throw new Error('Codex history requested for a non-Codex session')
    const raw = this.currentTokenSource()
    if (!raw?.codexApiProvider && !feishu.isOpenAIChatGPTAuthenticated(this.codexAccountId())) throw new Error('Codex 未登录 ChatGPT 账号')
    if (this.selectedTokenSourceId && (!raw || !raw.enabled)) {
      throw new Error(`token source "${this.selectedTokenSourceId}" 不可用，请重新配置或选择其他账号`)
    }
    const source = raw?.enabled ? raw : undefined
    const transformEnv = source
      ? (base: Record<string, string | undefined>) => source.spawnEnv(base)
      : undefined
    const proc = new CodexProcess({
      workDir: this.workDir,
      codexAccountId: this.codexAccountId(),
      launch: { kind: 'fresh' },
      tokenSourceId: source?.id ?? null,
      transformEnv,
      effort: this.effortForSpawn() ?? CODEX_EFFORT,
      ...(source?.codexApiProvider ? { apiProvider: source.codexApiProvider } : {}),
    })
    let conversations: ConversationSummary[] | null = null
    let queryError: unknown = null
    try {
      conversations = await proc.listConversations()
    } catch (error) {
      queryError = error
    }
    let closeError: unknown = null
    try { await proc.kill(2000) } catch (error) { closeError = error }
    if (queryError && closeError) {
      throw new AggregateError([queryError, closeError], `Codex history query and cleanup failed: ${messageOf(queryError)}; ${messageOf(closeError)}`)
    }
    if (queryError) throw queryError
    if (closeError) throw closeError
    return conversations ?? []
  }

  /** Upgrade a pre-cwd resume record from backend-authoritative metadata. */
  private async resolveLegacyResumeRef(ref: ConversationRef): Promise<ConversationRef> {
    if (ref.cwd !== null) return ref
    if (ref.provider !== this.selectedProvider) {
      throw new Error(`legacy resume provider mismatch: ${ref.provider} != ${this.selectedProvider}`)
    }
    let resolved: ConversationRef
    if (ref.provider === 'dsh') {
      throw new Error('DSH resume reference requires its original cwd')
    } else if (ref.provider === 'claude') {
      const transcript = claudeTranscriptPath(this.workDir, ref.sessionId, this.claudeHistoryOptions())
      if (!existsSync(transcript)) {
        throw new Error(`旧 Claude 会话不属于当前 cwd，或 transcript 不存在: ${diagnosticIdLabel(ref.sessionId)}`)
      }
      resolved = { ...ref, cwd: this.workDir }
    } else {
      const raw = this.currentTokenSource()
      if (!raw?.codexApiProvider && !feishu.isOpenAIChatGPTAuthenticated(this.codexAccountId())) throw new Error('Codex 未登录 ChatGPT 账号')
      if (this.selectedTokenSourceId && (!raw || !raw.enabled)) {
        throw new Error(`token source "${this.selectedTokenSourceId}" 不可用，请重新配置或选择其他账号`)
      }
      const source = raw?.enabled ? raw : undefined
      const proc = new CodexProcess({
        workDir: this.workDir,
        codexAccountId: this.codexAccountId(),
        launch: { kind: 'fresh' },
        tokenSourceId: source?.id ?? null,
        transformEnv: source ? base => source.spawnEnv(base) : undefined,
        effort: this.effortForSpawn() ?? CODEX_EFFORT,
        ...(source?.codexApiProvider ? { apiProvider: source.codexApiProvider } : {}),
      })
      let readError: unknown = null
      try { resolved = await proc.readConversationRef(ref.sessionId) }
      catch (error) { readError = error; resolved = ref }
      let closeError: unknown = null
      try { await proc.kill(2000) } catch (error) { closeError = error }
      if (readError && closeError) {
        throw new AggregateError(
          [readError, closeError],
          `Codex legacy resume lookup and cleanup failed: read=${messageOf(readError)}; cleanup=${messageOf(closeError)}`,
        )
      }
      if (readError) throw readError
      if (closeError) throw closeError
    }
    validateConversationLaunch({ kind: 'resume', source: resolved }, this.selectedProvider, this.workDir)
    feishu.bindSessionResumeChecked(this.sessionName, resolved)
    return resolved
  }

  hasRunningPeerSession(sessionName: string): boolean {
    return [...Session.all].some(s => s.sessionName === sessionName && s.isRunning())
  }

  private modelForSpawn(provider: AgentProvider = this.selectedProvider): string | undefined {
    return provider === this.selectedProvider ? this.selectedModel ?? undefined : undefined
  }

  effortForSpawn(): CodexReasoningEffort | undefined {
    // codex 有 token source(订阅):下发 effort(面板选,冷启动随面板,与 model 下发一致);
    // 无 ts 旧路径:走 ~/.codex/config.toml。
    // 热切换 setModelSettings 仍 no-op(thread/settings/update 踩坑避),需重启进程生效。
    if (this.selectedProvider === 'codex') {
      // 与 spawnAgent 一致只认 enabled source:disabled codex-sub(热重建后凭据失效)→ 不下发
      // effort,让 codex 走 ~/.codex/config.toml,避免「model 不下发但 effort 覆盖」的不一致。
      const ts = this.currentTokenSource()
      if (!ts || (!ts.enabled && ts.id !== 'codex-sub')) return undefined
      return isCodexReasoningEffort(this.selectedEffort) ? this.selectedEffort : CODEX_EFFORT
    }
    return CODEX_EFFORT
  }

  claudeEffortForSpawn(): ClaudeReasoningEffort {
    if (this.selectedProvider === 'claude' && isClaudeReasoningEffort(this.selectedEffort)) return this.selectedEffort
    const source = this.currentTokenSource()
    if (this.selectedProvider === 'claude' && source?.agent === 'claude') {
      const model = tokenSourceRuntimeModel(source, this.selectedModel ?? source.defaultModel)
      if (!isClaudeReasoningEffort(model?.defaultEffort)) throw new Error('Claude 默认 effort MISS，请通过 model 面板明确选择')
      return model.defaultEffort
    }
    return CLAUDE_EFFORT
  }

  /** DSH 档位解析(上游 dshEffortForSpawn 的本地形态):词表是 DSH 自己的
   *  off/low/high/max,数据源是 `[deepseek-harness]` 配置段(本地无上游的
   *  token source `models[]` 目录,不在这里查询子进程目录)。两处都取不到即
   *  **抛错**:绝不静默回落到 Codex 的 max(那会让 DSH 子进程拿到非法档位)。 */
  dshEffortForSpawn(provider: AgentProvider = this.selectedProvider): DshReasoningEffort {
    if (provider === 'dsh' && this.selectedProvider === provider && isDshReasoningEffort(this.selectedEffort)) {
      return this.selectedEffort
    }
    const configured = config.deepseek_harness?.effort
    if (isDshReasoningEffort(configured)) return configured
    throw new Error('DSH model reasoning effort is unavailable')
  }

  currentModelLabel(): string | null {
    if (this.modelSettingsChange?.proc === this.proc && this.modelSettingsChange.phase === 'failed') {
      return this.modelSettingsChange.confirmedModel
    }
    // 有 token source 时 fallback 到它声明的真实模型(ts.defaultModel 如 GLM-5.2[1m]),
    // 而非 proc.lastModel —— 那是 SDK alias(如 'opus'),用户看着像切错了模型。
    // 显示/比对统一出口:剥 claude: 前缀和 [1m] 记账后缀 —— 面板选中态比对
    // (session-model)用裸模型名,内部后缀不参与。
    const raw = this.selectedModel ?? this.currentTokenSource()?.defaultModel ?? this.proc?.lastModel ?? null
    return raw?.replace(/^claude:/i, '').replace(/\[1m\]$/i, '') ?? null
  }

  currentEffortLabel(): AgentReasoningEffort | null {
    if (this.modelSettingsChange?.proc === this.proc && this.modelSettingsChange.phase === 'failed') {
      return this.modelSettingsChange.confirmedEffort
    }
    const source = this.currentTokenSource()
    if (this.selectedProvider === 'claude' && source?.agent === 'claude') {
      return this.selectedEffort ?? tokenSourceRuntimeModel(source, this.selectedModel ?? source.defaultModel)?.defaultEffort ?? null
    }
    return this.selectedEffort
      // DSH 档位与 Codex/Claude 枚举不同(off/low/high/max):未显式选时按 DSH
      // 语义解析(取不到即抛,不静默回落 CODEX_EFFORT),否则面板选中标记 /
      // 当前档位展示 / selectionUnchanged 会把 DSH 会话当 Codex 渲染(03-03)。
      ?? (this.selectedProvider === 'dsh' ? this.dshEffortForSpawn() : undefined)
      ?? this.proc?.lastEffort
      ?? (this.selectedProvider === 'claude' ? CLAUDE_EFFORT : CODEX_EFFORT)
  }

  /** Actual process selection for cards and status text. selected* is the
   * persisted target; a still-running old process remains authoritative until
   * it is replaced. Profile keys win when they identify that same process so
   * source-specific routing (codex:<slug>/claude:glm) is not lost. */
  private runtimeModelSelection(): Pick<TurnState, 'provider' | 'model' | 'effort' | 'usageSource'> {
    const proc = this.proc?.isAlive() ? this.proc : null
    const provider = proc?.provider ?? this.selectedProvider
    if (proc && this.modelSettingsChange?.proc === proc && this.modelSettingsChange.phase === 'failed') {
      return {
        provider,
        model: this.modelSettingsChange.confirmedModel,
        effort: this.modelSettingsChange.confirmedEffort,
        usageSource: usageSourceForAgent(provider, this.modelSettingsChange.confirmedModel),
      }
    }
    const selectedMatchesProc = !proc || proc.provider === this.selectedProvider
    const model = selectedMatchesProc
      ? this.selectedModel ?? proc?.lastModel ?? null
      : proc?.lastModel ?? null
    // 合并调和(取舍):claude 的档位回落须经 token source 的模型目录(上游
    // 「source 默认 effort 权威;目录里缺省不得被 max 顶替」)——目录声明
    // defaultEffort: null 时留 null(footer/快照显示 MISS),不再冒充
    // CLAUDE_EFFORT;仅无 claude source(登录态)才回落常量。
    const claudeSource = provider === 'claude' ? this.currentTokenSource() : null
    const fallbackEffort: AgentReasoningEffort | null = provider === 'claude'
      ? claudeSource?.agent === 'claude'
        ? tokenSourceRuntimeModel(claudeSource, this.selectedModel ?? claudeSource.defaultModel)?.defaultEffort ?? null
        : CLAUDE_EFFORT
      : CODEX_EFFORT
    const effort = selectedMatchesProc
      ? this.selectedEffort
        ?? proc?.lastEffort
        ?? fallbackEffort
      : proc?.lastEffort ?? fallbackEffort
    return {
      provider,
      model,
      effort,
      // 额度数据源走 TokenSource 适配层(本地 resolveUsageSource 薄适配并入)。
      usageSource: usageSourceForAgent(provider, model),
    }
  }

  withModel(
    text: string,
    selection?: Pick<TurnState, 'provider' | 'model' | 'effort'>,
  ): string {
    const label = this.modelLine(selection)
    return text.includes(label) ? text : `${text} · ${label}`
  }

  private async replaceFooterContent(cardId: string, content: string): Promise<cardkit.CardWriteResult> {
    // Live timing is optional: Card Kit logs failures, and the timer pauses
    // without a user notice. Never mark the footer missing or rotate its card.
    // Terminal footer writes use their own checked transaction and still report.
    let failure: cardkit.CardWriteFailure | undefined
    const landed = await cardkit.replaceElementChecked(
      cardId,
      cards.ELEMENTS.footer,
      this.footerElement(content),
      { notifyCardFailure: false, onFailure: detail => { failure = detail } },
    )
    return { landed, failure }
  }

  private footerElement(content: string): object {
    return {
      tag: 'markdown',
      element_id: cards.ELEMENTS.footer,
      content: content.trim() || ' ',
    }
  }

  private modelLine(
    selection: Pick<TurnState, 'provider' | 'model' | 'effort'> = this.currentTurn ?? this.runtimeModelSelection(),
  ): string {
    return cards.footerModelLabel(selection.provider, selection.model, selection.effort)
  }

  backendLabel(provider: AgentProvider = this.selectedProvider): string {
    return agentProviderLabel(provider)
  }

  /** 一次性 launch intent(startForked/rollbackTo 设、spawnAgent 消费;上游
   *  pendingConversationLaunch 的本地 lease 化形态 —— lease 归属检查逐字保留。
   *  previousSessionId = intent 建立时的恢复绑定,persist 独立 id 校验用。 */
  private pendingConversationLaunch: {
    lease: LifecycleLease
    launch: ConversationLaunch
    previousSessionId: string | null
  } | null = null
  /** Durable Claude fork intent until first SDK init returns a new session id
   *  (4185808:precommit before spawn,daemon 崩溃窗口可恢复;首个 claude result
   *  经 consumePendingConversationMaterialization 消费——挂账 #2 归 Task 2 接线)。 */
  private codexQuotaWaitLaunch: Exclude<ConversationLaunch, { kind: 'fresh' }> | null = null
  private pendingConversationMaterialization: PendingConversationLaunch | null = null
  /** 最近一个 turn 的用户输入预览(首条文本,recordTurnAnchor 用;openTurnCard 时设)。 */
  private lastTurnUserPreview = ''
  /** A very fast Codex turn can complete before the asynchronous authoritative
   * materialization read returns. Retain its fully captured anchor until the
   * exact owning process becomes resumable instead of losing fk/bk history. */
  private pendingCodexTurnAnchors: Array<{
    proc: AgentProcess
    anchor: feishu.TurnAnchor
  }> = []

  /** 从 durable Claude fork intent 派生安全 launch(4185808,挂账 #2)。
   *  stillPending(绑定仍指 fork 前)→ 重放 fork intent;materialized(绑定已
   *  推进到独立新 id)→ resume 新 id;二者皆非/provider 不符 → fail-loud throw
   *  (inconsistent state 不得静默 fresh)。 */
  private pendingMaterializationLaunch(): ConversationLaunch | null {
    const pending = this.pendingConversationMaterialization
    if (!pending) return null
    validateConversationLaunch(pending.launch, 'claude', this.workDir)
    if (this.selectedProvider !== 'claude') {
      throw new Error('pending Claude fork cannot launch under a non-Claude provider')
    }
    if (this.lastSessionId === pending.previousSessionId) return pending.launch
    const materializedRef = this.lastSessionRef
    if (
      materializedRef?.provider === 'claude'
      && materializedRef.cwd === this.workDir
      && materializedRef.sessionId !== pending.launch.source.sessionId
      && materializedRef.sessionId !== pending.previousSessionId
    ) {
      return { kind: 'resume', source: materializedRef }
    }
    throw new Error('pending Claude fork has no safe launch target')
  }

  private spawnAgent(
    resumeRef?: ConversationRef,
    provider: AgentProvider = this.selectedProvider,
    lease?: LifecycleLease,
    explicitLaunch?: ConversationLaunch,
  ): AgentProcess {
    this.agentCapability = randomBytes(32).toString('base64url')
    const hostEnv = {
      // 全量 bun test 时字母序更早的 mock.module('./config') 可能不含 notify
      // 段(claude-agent-process/codex-models)；缺省与 config.ts 默认一致。
      LODESTAR_AGENT_URL: agentApiUrl(config.notify?.bind ?? '127.0.0.1', config.notify?.port ?? 9876),
      LODESTAR_AGENT_CAPABILITY: this.agentCapability,
      LODESTAR_AGENT_SESSION: this.sessionName,
      LODESTAR_AGENT_ROLE: 'main',
    }
    const pending = this.pendingConversationLaunch && (!lease || this.pendingConversationLaunch.lease === lease)
      ? this.pendingConversationLaunch
      : null
    // durable marker 优先于 plain resume(4185808):daemon 崩溃后复活的 Claude
    // fork intent 在下一次 spawn 兑现,而不是被旧绑定的 resume 悄悄顶掉。
    const launch: ConversationLaunch = explicitLaunch ?? pending?.launch
      ?? this.pendingMaterializationLaunch()
      ?? (resumeRef
        ? { kind: 'resume', source: resumeRef }
        : { kind: 'fresh' })
    validateConversationLaunch(launch, provider, this.workDir)
    // 只让 enabled source 参与 spawn。显式选择过但当前 disabled/missing 的
    // source 必须 fail closed；无来源的 Claude 同样由共享启动入口拒绝。
    if (provider === 'claude' && !this.selectedTokenSourceId && !this.selectedModel && getTokenSource('claude-sub')) this.selectedTokenSourceId = 'claude-sub'
    const raw = this.currentTokenSource()
    const codexPool = provider === 'codex' && this.selectedTokenSourceId === 'codex-sub'
    const claudePool = provider === 'claude' && this.selectedTokenSourceId === 'claude-sub'
    if (this.selectedTokenSourceId && (!raw || (!raw.enabled && !codexPool))) {
      throw new Error(raw?.modelCatalogState?.error
        ?? `token source "${this.selectedTokenSourceId}" 不可用，请重新配置或在 model 面板选择其他账号`)
    }
    const ts = raw?.enabled || codexPool ? raw : undefined
    // DSH 单档后端(上游 722e45a 构造分支的本地语义并入合并形态):本地固定档位
    // 流程从不绑定注册表 source(选择键就是 `[deepseek-harness]` 段)—— 未绑定
    // 时按配置段即时构建,与 session-model 的可见性门、dshEffortForSpawn 同源;
    // 绑定过注册表 source 的上游面板流程继续走 createAgentProcess 的 registry 闸
    // (ts 分支)。源缺失/未启用即 fail closed —— 绝不落到 codex fallthrough
    // (那会把 dsh 档位当作 Codex 跑,错误后端且凭据语义不符)。
    if (provider === 'dsh' && !ts) {
      const source = dshSourceFromConfig()
      if (!source.enabled) throw new Error('DSH token source is unavailable')
      const model = this.modelForSpawn(provider) ?? source.defaultModel
      const proc = new DshProcess({
        workDir: this.workDir,
        tokenSourceId: source.id,
        model,
        effort: this.dshEffortForSpawn(provider),
        launch,
        developerInstructions: this.spawnDeveloperInstructions(),
        profile: feishu.projectProfileForDirectory(this.workDir),
        ...(process.env.LODESTAR_DISABLE_SKILL_SYNC === '1' ? {} : { managedSkillPluginPath: MANAGED_CLAUDE_PLUGIN_DIR }),
        hostEnv,
        // 凭据单入口:先 scrub ANTHROPIC_*/DSH_* 再注入本档 DEEPSEEK_*(D-08 双轨),
        // 与注册表 readUsage/spawnEnv 同一 factory 实现。
        transformEnv: base => source.spawnEnv(base),
      })
      this.procSourceRevisions.set(proc, tokenSourceProcessRevision(source, model))
      return proc
    }
    // 固定首次启动选定的账号，避免仅落盘 resume 后按新的默认来源重选账号。
    // 使用 checked 写入且先于进程创建；失败不启动、也不把会话悄悄切到别的来源。
    if (this.selectedProvider === 'claude' && ts && !feishu.getSessionModelSelection(this.sessionName)?.tokenSourceId) {
      feishu.bindSessionModelChecked(this.sessionName, 'claude', this.selectedModel, this.selectedEffort, ts.id)
    }
    const created = createAgentProcess({
      provider,
      workDir: this.workDir,
      tokenSourceId: ts?.id ?? null,
      ...(provider === 'codex' ? { codexAccountId: codexAccounts.selected(this.sessionName) } : {}),
      ...(codexPool ? { codexAccountPreference: this.codexStartAccountOverride ?? codexAccounts.preferred(this.sessionName) } : {}),
      ...(claudePool ? { claudeAccountPreference: this.claudeStartAccountOverride ?? null,
        claudeActiveSessions: countActiveClaudeSessions(Session.all, { excludeChatId: this.chatId }) } : {}),
      model: ts ? (this.selectedModel ?? ts.defaultModel) : this.modelForSpawn(provider),
      effort: provider === 'dsh'
        ? this.dshEffortForSpawn(provider)
        : provider === 'claude' ? this.claudeEffortForSpawn() : this.effortForSpawn(),
      launch,
      developerInstructions: this.spawnDeveloperInstructions(),
      profile: feishu.projectProfileForDirectory(this.workDir),
      ...(process.env.LODESTAR_DISABLE_SKILL_SYNC === '1' ? {} : { managedSkillPluginPath: MANAGED_CLAUDE_PLUGIN_DIR }),
      hostEnv,
    })
    this.procSourceRevisions.set(created.process, created.sourceRevision)
    this.claudeStartAccountOverride = undefined
    return created.process
  }

  /** A named hi authorizes this launch only; automatic choice resumes next time. */
  async startWithClaudeAccount(name: string, opts: LifecycleProgressOpts = {}): Promise<boolean> {
    return this.runLifecycle('hi-claude-account', async () => {
      if (this.proc?.isAlive() && this.proc.tokenSourceId === 'claude-sub') {
        const running = processClaudeAccount(this.proc)
        const selected = running && claudeAccounts.get(running)
        let requested: string | undefined
        try { requested = claudeAccounts.find(name).id } catch { /* Unknown names are discovered below. */ }
        if (selected && selected.id === requested) {
          opts.onStatus?.(`✅ 正在使用 Claude 订阅「${selected.name}」`)
          return true
        }
      }
      if (this.currentTurn || this.openingTurn || this.pendingUserMessageCount > 0
        || this.pendingMidTurnMsgs.length > 0 || this.pendingTurnInputs.length > 0
        || cards.hasActiveBgTask(this.backgroundTasks) || this.modelSettingsChange?.phase === 'pending') {
        throw new Error('当前任务尚未结束；请结束或停止任务后再指定 Claude 账号')
      }
      const root = getTokenSource('claude-sub')
      if (!root) throw new Error('Claude 订阅来源尚未初始化')
      if (config.token_sources?.['claude-sub']?.enabled === false) {
        throw new Error('Claude 订阅已禁用；请先发送 claude-sub on')
      }
      opts.onStatus?.(`🔎 检查 Claude 订阅账号「${name}」`)
      const accountId = await enrollClaudeAccount(name, phase => opts.onStatus?.(phase === 'syncing'
        ? `⏳ Claude 订阅「${name}」已登录，正在完成首次同步`
        : `🔎 验证 Claude 订阅账号「${name}」`))
      const source = getTokenSourceForAccount('claude-sub', accountId)
      if (!source) throw new Error('Claude 账号目录未就绪')
      if (this.selectedProvider !== 'claude' || this.selectedTokenSourceId !== 'claude-sub') {
        await this.applyModelSelectionUnlocked('claude', source.defaultModel,
          tokenSourceRuntimeModel(source, source.defaultModel)?.defaultEffort ?? null, 'claude-sub')
      }
      this.claudeStartAccountOverride = accountId
      try {
        const resume = this.pendingConversationLaunch?.launch.kind !== 'fresh'
          && !!(this.proc?.isAlive() || this.lastSessionRef || this.pendingConversationLaunch)
        return resume ? await this.restartUnlocked(true, opts) : await this.startUnlocked(opts)
      } finally {
        this.claudeStartAccountOverride = undefined
      }
    })
  }

  async applyModelSelection(
    provider: AgentProvider,
    model: string,
    effort: AgentReasoningEffort | null,
    leaseOrTokenSourceId?: LifecycleLease | string,
  ): Promise<boolean | void> {
    // 上游调用面(持久化选择/面板/测试直调:第 4 参 tokenSourceId 字符串或省略)
    // 经 runLifecycle('apply-model-selection') 串行 —— 上游 17280「用户消息持锁
    // 期间不得改写 Session 状态」;体走上游 applyModelSelectionUnlocked(checked
    // 写,失败 throw;18614/11033 按 throw 断言)。
    if (typeof leaseOrTokenSourceId === 'string' || leaseOrTokenSourceId === undefined) {
      return await this.runLifecycle('apply-model-selection', () =>
        this.applyModelSelectionUnlocked(provider, model, effort, leaseOrTokenSourceId))
    }
    // 本地调用面(session-model.ts 模型切换事务,第 4 参 lease):返回值表「是否
    // 仍归属本事务」;事务已持 lease,不再进 runLifecycle 队列(防与外层互等)。
    const lease = leaseOrTokenSourceId
    if (lease && !this.ownsLifecycle(lease)) return false
    const previousProvider = this.selectedProvider
    if (previousProvider !== provider) {
      // Checked first(ff44afb 簇 4):写失败必须 throw,不得留下「内存 provider
      // 已切、durable Claude fork marker 仍在磁盘」的分叉态。
      feishu.replaceTurnAnchors(this.sessionName, [], null, null)
      this.pendingConversationMaterialization = null
    }
    this.selectedProvider = provider
    this.selectedModel = model
    this.selectedEffort = effort
    this.lastSessionRef = feishu.getSessionResumeRef(this.sessionName, provider)
    this.lastSessionId = this.lastSessionRef?.sessionId ?? null
    feishu.bindSessionModel(this.sessionName, provider, model, effort)
    await this.stopIdleMismatchedProcess(lease)
    return !lease || this.ownsLifecycle(lease)
  }

  async applyModelSelectionUnlocked(
    provider: AgentProvider,
    model: string,
    effort: AgentReasoningEffort | null,
    tokenSourceId?: string,
  ): Promise<void> {
    const previousProvider = this.selectedProvider
    const nextSourceId = tokenSourceId ?? this.selectedTokenSourceId
    const ts = getTokenSource(nextSourceId)
    const nextModel = ts ? model || null : provider === 'codex' ? null : model
    const nextEffort = ts
      ? effort ?? tokenSourceRuntimeModel(ts, model || ts.defaultModel)?.defaultEffort ?? null
      : provider === 'codex' ? null : effort

    // Keep both routing and its durable selection unchanged until the old
    // process has actually stopped. A failed close must remain retryable.
    await this.stopIdleMismatchedProcessUnlocked(provider, nextSourceId, nextModel, nextEffort)
    const previousConversation = previousProvider !== provider ? {
      anchors: feishu.getTurnAnchors(this.sessionName).slice(),
      base: feishu.getSessionBranchBase(this.sessionName),
      pending: feishu.getPendingConversationLaunch(this.sessionName),
    } : null
    if (previousConversation) feishu.replaceTurnAnchors(this.sessionName, [], null, null)
    try {
      feishu.bindSessionModelChecked(this.sessionName, provider, nextModel, nextEffort, nextSourceId)
    } catch (error) {
      if (previousConversation) {
        try {
          feishu.replaceTurnAnchors(this.sessionName, previousConversation.anchors,
            previousConversation.base, previousConversation.pending)
        } catch (restoreError) {
          throw new AggregateError([error, restoreError],
            `model selection write failed: ${messageOf(error)}; conversation state restore failed: ${messageOf(restoreError)}`)
        }
      }
      throw error
    }
    if (previousConversation) this.pendingConversationMaterialization = null
    if (provider !== 'codex' || nextSourceId !== 'codex-sub') this.codexQuotaWaitLaunch = null
    this.selectedProvider = provider
    this.selectedTokenSourceId = nextSourceId
    this.selectedModel = nextModel
    this.selectedEffort = nextEffort
    this.lastSessionRef = feishu.getSessionResumeRef(this.sessionName, provider)
    this.lastSessionId = this.lastSessionRef?.sessionId ?? null
  }

  processSourceMatches(source: TokenSource | undefined, model?: string | null): boolean {
    if (this.proc?.quotaWaitPromise && !this.proc.sessionId && this.proc.turnRetry?.reason === 'quota') return true
    if (this.proc?.sourceRevision) return this.proc.sourceRevision() === tokenSourceProcessRevision(source, model)
    return !this.proc || !this.procSourceRevisions.has(this.proc)
      || this.procSourceRevisions.get(this.proc) === tokenSourceProcessRevision(source, model)
  }

  modelSelectionNeedsProcessStop(
    provider = this.selectedProvider,
    tokenSourceId = this.selectedTokenSourceId,
    model = this.selectedModel,
    effort = this.selectedEffort,
  ): boolean {
    const proc = this.proc
    return !!proc?.isAlive() && (
      this.blockedProc === proc
      || proc.provider !== provider
      || proc.tokenSourceId !== tokenSourceId
      || provider === 'claude' && proc.provider === 'claude'
        && processUsesClaudeTranslation(proc) !== claudeTranslationModeEnabled(
          tokenSourceId, model ?? this.tokenSource(tokenSourceId)?.defaultModel,
        )
      || provider === 'claude' && proc.provider === 'claude' && effort !== null
        && ((proc.lastEffort ?? this.selectedEffort) === 'default') !== (effort === 'default')
      || !this.processSourceMatches(this.tokenSource(tokenSourceId), model)
    )
  }

  async stopIdleMismatchedProcess(lease?: LifecycleLease): Promise<void> {
    if (lease && !this.ownsLifecycle(lease)) return
    await this.stopIdleMismatchedProcessUnlocked()
  }

  private async stopIdleMismatchedProcessUnlocked(
    provider = this.selectedProvider,
    tokenSourceId = this.selectedTokenSourceId,
    model = this.selectedModel,
    effort = this.selectedEffort,
  ): Promise<void> {
    // provider 或 token source 任一变化 = 进程 env 不再匹配 → idle 时杀掉,下轮重 spawn 换 env。
    // 同 provider 跨 source(GLM↔DeepSeek↔Claude 订阅)env(base_url/凭据)不同也必须重启,
    // 否则热切换只改 model 不换 env → 模型名打到上一个 source 的 base_url(silent divergence)。
    if (!this.proc || !this.modelSelectionNeedsProcessStop(provider, tokenSourceId, model, effort)) return
    if (this.currentTurn || this.openingTurn || this.pendingUserMessageCount > 0 || this.pendingMidTurnMsgs.length > 0) return
    const proc = this.proc
    // 合并收口(main 同款,current-process 变体亦如此):进程即将被换掉,
    // 挂在其上的 turn interrupt 必须随之作废,cancel 在 kill 之前生效。
    this.cancelTurnInterrupt('idle provider switch')
    logDiagnostic("session: stop idle")
    this.beginProcStop(proc)
    this.initCount = 0
    // 进程换掉:恢复轮标记 / 孤儿缓冲随旧进程作废,否则会泄漏到新进程的
    // boot init,把一次干净启动误判成 bg_task_resume 轮开出幽灵卡。
    this.bgResumePending = false
    this.discardOrphanAssistant()
    this.currentTurnUsageBaseline = null
    this.currentTurnUsageBaselineKnown = false
    this.usageTotalsSeedUnknown = false
    this.status = 'stopped'
    let resumableStateError = await this.settleProcResumableState(proc)
    let killError: unknown = null
    // Use the backend's shutdown deadline: Claude SDK alone allows about 2 s
    // for graceful cleanup, so the former 1 s override reported false failures.
    try { await proc.kill() }
    catch (e) { killError = e }
    resumableStateError = await this.settleProcResumableState(proc)
    const confirmed = this.finishProcStop(proc, killError)
    this.opts.onLifecycleChange?.()
    const failures = [
      ...(killError ? [killError] : !confirmed ? [new Error(this.blockedProcReason ?? 'process stop unconfirmed')] : []),
      ...(resumableStateError ? [new Error(resumableStateError)] : []),
    ]
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, `idle process stop failed: ${failures.map(messageOf).join('; ')}`)
    }
  }

  async stopIdleCurrentProcess(reason: string, lease?: LifecycleLease): Promise<boolean> {
    if (lease && !this.ownsLifecycle(lease)) return false
    return await this.stopIdleCurrentProcessUnlocked(reason, lease)
  }

  private async stopIdleCurrentProcessUnlocked(reason: string, lease?: LifecycleLease): Promise<boolean> {
    if (!this.proc?.isAlive()) return false
    if (this.hasProcessMutationBlockingWork()) return false
    const proc = this.proc
    this.cancelTurnInterrupt(`idle process stop: ${reason}`)
    logDiagnostic("session: stop idle")
    this.beginProcStop(proc)
    this.clearCodexProcessActivityState()
    this.initCount = 0
    this.bgResumePending = false
    this.discardOrphanAssistant()
    this.currentTurnUsageBaseline = null
    this.currentTurnUsageBaselineKnown = false
    this.usageTotalsSeedUnknown = false
    this.status = 'stopped'
    let resumableStateError = await this.settleProcResumableState(proc)
    let killError: unknown = null
    try { await proc.kill() }
    catch (e) { killError = e }
    resumableStateError = await this.settleProcResumableState(proc)
    const confirmed = this.finishProcStop(proc, killError)
    this.opts.onLifecycleChange?.()
    if (lease && !this.ownsLifecycle(lease)) return false
    // A multi-message marker or another host-side interaction can arrive
    // while kill awaits without acquiring a lifecycle lease. Preserve it and
    // make the caller abort instead of following with a destructive restart.
    if (this.hasProcessMutationBlockingWork()) return false
    const failures = [
      ...(killError ? [killError] : !confirmed ? [new Error(this.blockedProcReason ?? 'process stop unconfirmed')] : []),
      ...(resumableStateError ? [new Error(resumableStateError)] : []),
    ]
    if (failures.length > 0) {
      logDiagnostic("session: idle process stop finished with failures")
      return false
    }
    return true
  }

  private startFooterTimer(
    cardId: string,
    initialStatus: string,
    renderContent: (status: string) => string = status => status,
  ): FooterTimer {
    const startedAt = Date.now()
    let status = initialStatus
    let stopped = false
    let pending = false
    let paused = false
    let dirty = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const render = (): void => {
      if (stopped) return
      if (pending) { dirty = true; return }
      pending = true
      dirty = false
      const writtenStatus = status
      void this.replaceFooterContent(cardId, renderContent(timedStatus(status, startedAt))).then(result => {
        pending = false
        if (stopped) return
        if (result.landed) {
          if (dirty) render()
          return
        }
        paused = true
        if (timer) clearTimeout(timer)
        timer = null
        if (dirty && status !== writtenStatus) render()
      })
    }
    // footer 显示「状态词 + 耗时」(见 timedStatus)。bucket 只在档位边界 push;
    // second 前 10m 固定 1s,之后按 5m 档位。setStatus 切换状态也立即 push。
    // elapsedSec 仍基于 startedAt,供 closeStatusCard 结束时显示总耗时。
    const scheduleNext = (): void => {
      if (stopped || paused) return
      const { nextDelayMs } = liveElapsed(Date.now() - startedAt, liveElapsedMode())
      timer = setTimeout(() => { render(); scheduleNext() }, Math.max(1, Math.ceil(nextDelayMs)))
    }
    render()
    scheduleNext()
    return {
      setStatus(next: string): void {
        if (next === status) return
        status = next
        render()
      },
      stop(): void {
        if (stopped) return
        stopped = true
        if (timer) clearTimeout(timer)
        timer = null
      },
      elapsedSec(): number {
        return (Date.now() - startedAt) / 1000
      },
    }
  }

  async openStatusCard(
    title: string,
    initialStatus: string,
    template: 'blue' | 'green' | 'orange' | 'red' | 'grey' | 'turquoise' = 'blue',
  ): Promise<StatusCardHandle | null> {
    const startedAt = Date.now()
    const card = cards.statusCard({
      sessionName: this.sessionName,
      title,
      status: timedStatus(initialStatus, startedAt),
      template,
    })
    let sendFailure: unknown
    const messageId = await feishu.sendCard(this.chatId, card, error => { sendFailure = error })
    if (!messageId) {
      logDiagnostic('session: status card send failed')
      await feishu.sendTextRaw(this.chatId, `❌ 创建状态卡片失败: ${title}\n${formatFeishuError(sendFailure)}`)
      return null
    }
    let cardId: string
    try { cardId = await cardkit.convertMessageToCard(messageId) }
    catch (e) {
      logError('session: status card id_convert failed', e)
      await feishu.sendTextRaw(this.chatId, `❌ 状态卡片初始化失败: ${title}\n${formatFeishuError(e)}`)
      return null
    }
    cardkit.recordCardCreated(cardId, 1)
    return {
      cardId,
      title,
      timer: this.startFooterTimer(
        cardId,
        initialStatus,
        status => cards.statusCardContent(title, status),
      ),
    }
  }

  setStatusCard(handle: StatusCardHandle | null, status: string): void {
    handle?.timer.setStatus(status)
  }

  async closeStatusCard(handle: StatusCardHandle | null, finalStatus: string): Promise<void> {
    if (!handle) return
    handle.timer.stop()
    const elapsed = handle.timer.elapsedSec()
    const content = cards.statusCardContent(handle.title, `${finalStatus} (${cards.formatDuration(elapsed)})`)
    await cardkit.flush(handle.cardId)
    const failures: cardkit.CardWriteFailure[] = []
    const onFailure = (failure: cardkit.CardWriteFailure) => { failures.push(failure) }
    const footerLanded = await cardkit.replaceElementChecked(
      handle.cardId,
      cards.ELEMENTS.footer,
      this.footerElement(content),
      { onFailure },
    )
    cardkit.cancelSummary(handle.cardId)
    const settingsLanded = await cardkit.patchSettingsChecked(handle.cardId, cards.streamingOffSettings({
      durationSec: elapsed,
      suffix: finalStatus,
    }), onFailure)
    if (footerLanded && settingsLanded) {
      await cardkit.dispose(handle.cardId)
    } else {
      const detail = `footer=${footerLanded ? 'ok' : 'MISS'}, settings=${settingsLanded ? 'ok' : 'MISS'}`
      logError('session: status card terminal transaction incomplete', detail)
      await feishu.sendTextRaw(this.chatId, `⚠️ 状态卡片终态写入失败 (${detail})：${finalStatus}\n${cardFailureDetails(failures)}`)
    }
  }

  private async runLifecycle<T>(_label: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTail
    let release!: () => void
    this.lifecycleTail = new Promise<void>(resolve => { release = resolve })
    await previous

    this.lifecycleActive++
    logDiagnostic('session: lifecycle operation started')
    try {
      return await operation()
    } finally {
      this.lifecycleActive--
      release()
    }
  }

  /** 上游开卡事务装配(owner 协议,经 as-any 测试与转向迁移保留;生产装配
   *  入口为本地 beginTurnOpening,两者共用 openingTurnOwner 槽位)。 */
  beginTurnOpen(
    proc: AgentProcess | null = this.proc,
    procEpoch = this.procEpoch,
    backendTurnStarted = false,
  ): TurnOpenOwner {
    if (this.openingTurnOwner) {
      throw new Error(
        `turn card open already owned by ${'token' in this.openingTurnOwner ? `token=${this.openingTurnOwner.token}` : 'terminal stash'}; ` +
        'same-process opens must wait for the current owner',
      )
    }
    let resolveDone!: () => void
    const done = new Promise<void>(resolve => { resolveDone = resolve })
    const owner: TurnOpenOwner = {
      token: ++this.turnOpenSequence,
      proc,
      procEpoch,
      sawResult: false,
      terminalForcePush: false,
      pendingCompactions: [],
      backendTurnStarted,
      done,
      resolveDone,
    }
    this.openingTurnOwner = owner
    this.openingTurn = true
    return owner
  }

  stopAgyTask(status = '🛑 agy 已打断'): Promise<boolean> {
    return sessionAgy.stopAgyTask(this, status)
  }

  beginAgyForwardToCodex(resultIdRaw: string, userOpenId = ''): ModelActionResult {
    return sessionAgy.beginAgyForwardToCodex(this, resultIdRaw, userOpenId)
  }

  runAgyCommand(prompt: string): Promise<void> {
    return sessionAgy.runAgyCommand(this, prompt)
  }

  private ownsTurnOpen(owner: TurnOpenOwner | TurnOpenTerminalStash): boolean {
    if (this.openingTurnOwner !== owner) return false
    if (!('proc' in owner)) return true
    return this.proc === owner.proc && this.procEpoch === owner.procEpoch
  }

  releaseTurnOpen(owner: TurnOpenOwner): void {
    if (this.openingTurnOwner !== owner) return
    this.openingTurnOwner = null
    this.openingTurn = false
    owner.resolveDone()
    this.steerPendingInputs()
  }

  private invalidateTurnOpen(): void {
    const owner = this.openingTurnOwner
    if (owner && 'resolveDone' in owner) owner.resolveDone()
    this.clearTurnOpening()
  }

  /** Wait for a same-process card-open transaction to finish(上游 7c14677 单飞:
   * TurnOpenOwner 与本地 TurnOpenTerminalStash 共用 openingTurnOwner 槽位,
   * 等待须覆盖两类凭据的唤醒 —— 本地轻量凭据的 done 在 openingTurnDone)。
   * Process replacement invalidates the old owner and fails this wait,
   * preserving the existing “new process supersedes old open” lifecycle while
   * prohibiting two opens in one process generation from migrating/rendering
   * concurrently. */
  private async waitForTurnOpenSlot(proc: AgentProcess, epoch: number = this.procEpoch): Promise<boolean> {
    while (this.openingTurnOwner) {
      const owner = this.openingTurnOwner
      const done = 'done' in owner ? owner.done : this.openingTurnDone?.promise
      if (!done) return false
      await done
      if (this.proc !== proc || this.procEpoch !== epoch || !proc.isAlive()) return false
    }
    return this.proc === proc && this.procEpoch === epoch && proc.isAlive()
  }

  private attachProc(proc: AgentProcess): void {
    this.submittedSteering.clear()
    this.steeringBoundary?.start()
    this.steeringBoundary = null
    this.modelSettingsChange?.cancel('原进程已更换')
    this.modelSettingsChange = null
    this.invalidateTurnOpen()
    this.stoppingProc = null
    this.blockedProc = null
    this.blockedProcReason = null
    this.proc = proc
    const epoch = ++this.procEpoch
    this.wireProc(proc, epoch)
  }

  private detachProc(proc: AgentProcess): boolean {
    if (this.proc !== proc) return false
    this.submittedSteering.clear()
    this.steeringBoundary?.start()
    this.steeringBoundary = null
    this.modelSettingsChange?.cancel('原进程已退出')
    this.modelSettingsChange = null
    this.invalidateTurnOpen()
    this.proc = null
    this.agentCapability = null
    if (this.stoppingProc === proc) this.stoppingProc = null
    if (this.blockedProc === proc) {
      this.blockedProc = null
      this.blockedProcReason = null
    }
    this.procEpoch++
    return true
  }

  private beginProcStop(proc: AgentProcess): void {
    this.steeringGeneration++
    this.submittedSteering.clear()
    this.steeringBoundary?.start()
    this.steeringBoundary = null
    if (this.modelSettingsChange?.proc === proc) {
      this.modelSettingsChange.cancel('原进程正在停止')
      this.modelSettingsChange = null
    }
    this.stoppingProc = proc
    this.agentCapability = null
  }

  /** Returns true only when process termination is confirmed. */
  private finishProcStop(proc: AgentProcess, error: unknown): boolean {
    if (this.stoppingProc === proc) this.stoppingProc = null
    if (!proc.isAlive()) {
      this.discardPendingCodexTurnAnchors(proc, 'confirmed process stop')
      this.detachProc(proc)
      return true
    }
    this.blockedProc = proc
    this.blockedProcReason = error ? messageOf(error) : 'kill returned while process still reports alive'
    logError('session: process stop unconfirmed; lifecycle blocked', this.blockedProcReason)
    return false
  }

  private blockedProcessMessage(): string | null {
    const proc = this.blockedProc
    if (!proc) return null
    if (!proc.isAlive()) {
      this.detachProc(proc)
      return null
    }
    return `旧 ${this.backendLabel(proc.provider)} 进程尚未确认退出，会话已阻断: ${this.blockedProcReason ?? '未知原因'}`
  }

  private async stopOwnedProc(proc: AgentProcess, timeoutMs: number): Promise<boolean> {
    if (this.proc !== proc) return !proc.isAlive()
    this.beginProcStop(proc)
    let error: unknown = null
    try { await proc.kill(timeoutMs) }
    catch (e) { error = e }
    return this.finishProcStop(proc, error)
  }

  /** Settle the exact process-owned Codex persistence transaction without
   * consulting mutable Session routing. Safe both before kill (barrier can
   * finish) and after close (late verified flag/failure is observable). */
  private async settleProcResumableState(proc: AgentProcess): Promise<string | null> {
    let materializationError: string | null = null
    const barrier = proc.conversationMaterializationBarrier?.()
    if (barrier) {
      try { await barrier }
      catch (error) {
        materializationError = `Codex 会话落盘确认失败: ${messageOf(error)}`
      }
    }
    const lateFailure = proc.conversationMaterializationFailure?.()
    if (lateFailure && proc.isConversationResumable?.() !== true) {
      materializationError = `Codex 会话落盘确认失败: ${messageOf(lateFailure)}`
    }
    const persistenceError = this.persistResumableSessionId(false, proc, false)
    return [materializationError, persistenceError].filter(Boolean).join('；') || null
  }

  acceptsAgentCapability(value: string): boolean {
    const expected = this.agentCapability
    if (!expected || !value || !this.proc?.isAlive()) return false
    const a = Buffer.from(expected)
    const b = Buffer.from(value)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  async cancelAgentRuns(reason = '用户取消'): Promise<void> {
    await this.opts.onCancelAgentRuns?.(this.sessionName, this.chatId, reason)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────
  private resetFreshConversationState(): void {
    this.daemonRestoreRequired = false
    this.codexQuotaWaitLaunch = null
    this.turnCounter = 0
    this.pendingConversationMaterialization = null
    // clear/全新会话 → 旧锚配不上新会话,清空;base 写显式 {kind:'fresh'}
    // (ff44afb:fresh 不再依赖空数组推断,与 legacy null 判别)。
    feishu.replaceTurnAnchors(this.sessionName, [], { kind: 'fresh' }, null)
    this.currentGoal = null
    this.cumStats = { tokens: 0, costUsd: 0, turns: 0 }
    this.lastTurnDelta = null
    this.currentTurnUsageBaseline = null
    this.currentTurnUsageBaselineKnown = false
    this.lastTurnUsage = null
    this.usageTotalsSeedUnknown = false
  }

  async start(opts: LifecycleProgressOpts = {}): Promise<boolean> {
    // 嵌套调用(调用方已持 lease,形如 startColdUserTurn 的冷启动首轮)不再进
    // runLifecycle 串行队列:该队列会 await 外层 lifecycle 的释放,嵌套 await
    // 即与外层互等死锁。带 lease 直进 startUnlocked = 本地 main 的嵌套语义。
    if (opts.lifecycleLease) return await this.startUnlocked(opts)
    return await this.runLifecycle('start', () => this.startUnlocked(opts))
  }

  /** hi <name> is an explicit, one-start account override. Native errors remain authoritative. */
  async startWithCodexAccount(accountId: string, opts: LifecycleProgressOpts = {}): Promise<boolean> {
    return this.runLifecycle('hi-account', async () => {
      codexAccounts.get(accountId)
      if (this.selectedProvider !== 'codex' || this.currentTokenSource()?.codexApiProvider) {
        if (this.proc?.isAlive()) await this.stopUnlocked('切换到 Codex', { ...opts, announce: false })
        const source = getTokenSourceForAccount('codex-sub', accountId)
        const model = source?.defaultModel || null
        feishu.replaceTurnAnchors(this.sessionName, [], null, null)
        feishu.bindSessionModelChecked(this.sessionName, 'codex', model, null, 'codex-sub')
        this.pendingConversationMaterialization = null
        this.selectedProvider = 'codex'
        this.selectedTokenSourceId = 'codex-sub'
        this.selectedModel = model
        this.selectedEffort = null
        this.lastSessionRef = feishu.getSessionResumeRef(this.sessionName, 'codex')
        this.lastSessionId = this.lastSessionRef?.sessionId ?? null
      }
      if (this.selectedTokenSourceId !== 'codex-sub') {
        feishu.bindSessionModelChecked(this.sessionName, 'codex', this.selectedModel, this.selectedEffort, 'codex-sub')
        this.selectedTokenSourceId = 'codex-sub'
      }
      this.codexStartAccountOverride = accountId
      const previousLaunch = this.pendingConversationLaunch
      let startupOpts = opts
      if (!this.pendingConversationLaunch && this.codexQuotaWaitLaunch) {
        const lease = this.lifecycleLease('restart', opts)
        this.pendingConversationLaunch = { lease, launch: this.codexQuotaWaitLaunch, previousSessionId: this.lastSessionId }
        startupOpts = { ...opts, lifecycleLease: lease }
      }
      const launchOwner = this.pendingConversationLaunch
      try {
        if (this.proc?.isAlive() && this.proc.provider === 'codex' && processCodexAccount(this.proc) === accountId
          && this.proc.turnRetry?.reason !== 'quota') {
          opts.onStatus?.(`✅ 正在使用「${codexAccounts.get(accountId).name}」`)
          return true
        }
        const resume = this.pendingConversationLaunch?.launch.kind !== 'fresh'
          && !!(this.proc?.isAlive() || this.lastSessionRef || this.pendingConversationLaunch)
        return resume ? await this.restartUnlocked(true, startupOpts) : await this.startUnlocked(startupOpts)
      } finally {
        if (this.pendingConversationLaunch === launchOwner) this.pendingConversationLaunch = previousLaunch
        this.codexStartAccountOverride = undefined
      }
    })
  }

  private async startUnlocked(opts: LifecycleProgressOpts = {}): Promise<boolean> {
    const lease = this.lifecycleLease('start', opts)
    if (!this.ownsLifecycle(lease)) return false
    if (this.hasPreservedWatchdogRecovery()) return false
    const provider = this.selectedProvider
    const announce = opts.announce ?? true
    const report = opts.onStatus
    const blocked = this.blockedProcessMessage()
    if (blocked) {
      this.status = 'stopped'
      report?.(`❌ ${blocked}`)
      if (announce) await feishu.sendText(this.chatId, `❌ ${blocked}。请重试 stop/restart，或等待旧进程退出。`)
      return false
    }
    if (this.proc && !this.proc.isAlive()) this.detachProc(this.proc)
    if (this.isRunning()) {
      if (this.proc?.provider === provider) {
        report?.(this.withModel(`✅ ${this.backendLabel()} 已运行`))
        return true
      }
      await this.stopIdleMismatchedProcess(lease)
      if (!this.ownsLifecycle(lease)) return false
      if (this.proc?.isAlive()) {
        report?.(`⚠️ 当前 ${this.backendLabel(this.proc.provider)} turn 尚未结束，模型切换将在后续新 turn 生效`)
        return true
      }
    }
    if (provider === 'codex') report?.('🔎 检查 Codex 登录')
    else report?.('🔎 检查 Claude Code')
    if (
      provider === 'codex' &&
      // 合并调和(取舍):登录预检取两侧豁免并集 —— 本地目录判定(自配 key 的
      // API 档位免登录、requires_openai_auth 档位保留)∧ 上游来源级豁免(API
      // 来源自带凭据免登录;codex-sub 走账号机制,由 native 报错权威)。
      this.selectedTokenSourceId !== 'codex-sub' &&
      (!codexModelIsApiRoute(this.selectedModel) || codexModelRequiresOpenaiAuth(this.selectedModel)) &&
      !this.currentTokenSource()?.codexApiProvider &&
      !feishu.isOpenAIChatGPTAuthenticated(this.codexAccountId())
    ) {
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      report?.('❌ Codex 未登录(ChatGPT 或 API key)')
      if (announce) {
        await feishu.sendText(this.chatId, '❌ Codex 未登录(ChatGPT 或 API key 均可)。\n请在服务器上运行 `codex login`(或配好 API key)后再试。')
        if (!this.ownsLifecycle(lease)) return false
      }
      return false
    }
    if (!existsSync(this.workDir)) {
      report?.(`🆕 创建项目目录 ~/${this.sessionName}`)
      if (announce) {
        await feishu.sendText(this.chatId, `🆕 目录 ~/${this.sessionName} 不存在，正在创建…`)
        if (!this.ownsLifecycle(lease)) return false
      }
      try { feishu.provisionProject(this.workDir) }
      catch (e) {
        this.status = 'stopped'
        this.opts.onLifecycleChange?.()
        report?.(`❌ 创建项目失败: ${e}`)
        if (announce) {
          await feishu.sendText(this.chatId, `❌ 创建项目失败: ${e}`)
          if (!this.ownsLifecycle(lease)) return false
        }
        return false
      }
    }

    // durable Claude fork marker 在位时跳过 fresh reset(4185808 startUnlocked 同位
    // guard):startForked 刚 precommit 的 pendingLaunch 不得被 reset 冲掉。
    if (!opts.freshConversationStateAlreadyReset && !this.pendingConversationMaterialization) {
      this.resetFreshConversationState()
    }
    this.status = 'starting'
    report?.(this.withModel(`🚀 启动 ${this.backendLabel()}`))
    let proc: AgentProcess
    try {
      proc = this.spawnAgent(undefined, provider, lease)
      this.pendingSpawnOwnership = { lease, proc }
    } catch (e) {
      const message = `${this.backendLabel()} 启动失败: ${messageOf(e)}`
      logError('session: Agent startup failed', e)
      if (!this.ownsLifecycle(lease)) return false
      report?.(`❌ ${message}`)
      if (!this.ownsLifecycle(lease)) return false
      if (announce) {
        await feishu.sendText(this.chatId, `❌ ${message}`)
        if (!this.ownsLifecycle(lease)) return false
      }
      this.proc = null
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      return false
    }
    if (!this.ownsLifecycle(lease)) {
      await this.discardLocalProcess(lease, proc)
      return false
    }
    this.attachProc(proc)
    const backend = this.backendLabel()
    // Claude can emit a synchronous startup error, so install its event
    // waiter before sendInitialize. Codex instead returns the exact readiness
    // Promise for initialize + thread/start; awaiting that transaction avoids
    // a shorter Session timer killing the process before its method-specific
    // RPC error can surface.
    const claudeInitWait = this.selectedProvider === 'claude'
      ? this.waitForProcEarlyFailure(proc, CLAUDE_STARTUP_GRACE_MS)
      : null
    report?.(this.selectedProvider === 'claude'
      ? `⏳ 检查 ${backend} 启动`
      : `⏳ 等待 ${backend} init`)
    let initialization: Promise<void> | undefined
    let initializeThrown: unknown = null
    try {
      proc.sendInitialize()
      initialization = proc.initializationPromise?.()
    } catch (error) {
      initialization = undefined
      initializeThrown = error
    }
    // Codex: 等 `system/init` 落地再认定 ready —— sendInitialize 只把 RPC
    // 写进 app-server 之前 proc.sessionId 还是 null,这时候 showConsole()
    // 看到 null 会 fallback 到磁盘上**上一次**会话的 lastSessionId,
    // 面板就把陈年 thread_id 当成"当前会话"贴出去。
    //
    // Claude: SDK 的 streaming-input 模式在第一条 user message 到达前
    // 不发 stream `init`。这里不能硬等 init,否则 `hi` 和冷启动首条消息
    // 都会超时;只短暂等待同步/早期 error 或 exit,首条输入触发的 init
    // 仍由 wireProc 正常处理。监听必须先于 sendInitialize 注册,否则
    // Claude wrapper 内同步暴露的启动失败会被错过。
    const init = initializeThrown
      ? { state: 'error' as const, error: initializeThrown }
      : this.selectedProvider === 'claude'
        ? initialization ? await this.waitForClaudeInitialization(initialization, claudeInitWait!) : await claudeInitWait!
        : await this.waitForCodexInitialization(
            this.requireCodexInitializationPromise(initialization),
            () => {
              report?.(this.withModel(`⏳ 仍在等待 ${backend} init 确认`))
            },
          )
    if (!this.ownsLifecycle(lease) || this.proc !== proc) {
      await this.discardLocalProcess(lease, proc)
      return false
    }
    if (init.state === 'error' || init.state === 'exit') {
      const detail = init.error ? messageOf(init.error) : init.state
      logError('session: init failed', detail)
      const stopConfirmed = await this.stopOwnedProc(proc, 1000)
      const cleanup = stopConfirmed
        ? ''
        : `；进程终止未确认: ${this.blockedProcReason ?? '未知原因'}`
      const failure = `❌ ${backend} 启动失败: ${detail}${cleanup}`
      report?.(failure)
      if (announce) await feishu.sendText(this.chatId, failure)
      if (!this.ownsLifecycle(lease)) return false
      this.clearCodexProcessActivityState()
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      return false
    }
    if (init.state === 'timeout') {
      const timeoutMs = this.selectedProvider === 'claude' ? 30_000 : CODEX_INIT_TIMEOUT_MS
      logDiagnostic('session: init wait timeout')
      const stopConfirmed = await this.stopOwnedProc(proc, 1000)
      const cleanup = stopConfirmed
        ? ''
        : `；进程终止未确认: ${this.blockedProcReason ?? '未知原因'}`
      const message = `❌ ${backend} 启动超时: ${timeoutMs / 1000} 秒内初始化事务未完成${cleanup}`
      report?.(message)
      if (announce) await feishu.sendText(this.chatId, message)
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      return false
    }
    if (this.proc !== proc || !proc.isAlive()) {
      const message = `${backend} 启动期间已退出`
      logDiagnostic('session: Agent exited during startup')
      report?.(`❌ ${message}`)
      if (announce) await feishu.sendText(this.chatId, `❌ ${message}`)
      this.detachProc(proc)
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      return false
    }

    // The native authentication gate may observe a manual CLI re-login during
    // startup. Capture that one verified revision now; later changes must
    // still invalidate this process instead of being silently absorbed.
    this.captureAuthenticatedClaudeRevision(proc)

    if (init.state === 'waiting_quota') {
      if (this.pendingConversationLaunch && this.pendingConversationLaunch.launch.kind !== 'fresh') {
        this.codexQuotaWaitLaunch = this.pendingConversationLaunch.launch
      }
      this.status = 'starting'
      this.startedAt = Date.now()
      this.opts.onLifecycleChange?.()
      report?.('⏳ 账号额度用尽 · 自动等待恢复，可用后继续')
      if (announce) await feishu.sendCard(this.chatId, codexAccountCard({ phase: 'checking', title: '等待额度恢复',
        message: '额度恢复后自动继续', hint: 'stop 可取消等待' }))
      return true
    }
    if (announce) {
      const modelLine = this.modelLine()
      await feishu.sendText(this.chatId, [
        this.withWorktreeInstructionNotice(`✅ Lodestar session "${this.sessionName}" 已就绪，发消息开始对话。`),
        modelLine,
      ].filter(Boolean).join('\n'))
      if (!this.ownsLifecycle(lease) || this.proc !== proc || !proc.isAlive()) {
        await this.discardLocalProcess(lease, proc)
        return false
      }
    }
    this.clearPendingSpawn(lease, proc)
    this.status = 'idle'
    this.startedAt = Date.now()
    this.daemonRestoreRequired = false
    this.opts.onLifecycleChange?.()
    report?.(this.withModel(this.withWorktreeInstructionNotice(`✅ ${this.backendLabel()} 已就绪`)))
    return true
  }

  private requireCodexInitializationPromise(value: Promise<void> | undefined): Promise<void> {
    if (!value || typeof value.then !== 'function') {
      return Promise.reject(new Error('Codex process did not expose its initialization transaction'))
    }
    return Promise.resolve(value)
  }

  private waitForClaudeInitialization(initialization: Promise<void>, early: Promise<{
    state: string; error?: unknown
  }>): Promise<{
    state: 'ready' | 'error' | 'exit' | 'timeout'; error?: unknown
  }> {
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve({ state: 'timeout' }), 30_000)
      // An immediate error/exit event can precede the readiness Promise.
      // The old grace period's successful expiry must never bypass auth.
      void early.then(result => {
        if (result.state === 'error' || result.state === 'exit') {
          clearTimeout(timer); resolve({ state: result.state, error: result.error })
        }
      })
      void initialization.then(
        () => { clearTimeout(timer); resolve({ state: 'ready' }) },
        error => { clearTimeout(timer); resolve({ state: 'error', error }) },
      )
    })
  }

  private captureAuthenticatedClaudeRevision(proc: AgentProcess): void {
    if (proc.provider === 'claude' && proc.tokenSourceId === 'claude-sub' && processClaudeAccount(proc)) {
      const source = getTokenSourceForAccount('claude-sub', processClaudeAccount(proc)!)
      this.procSourceRevisions.set(proc, tokenSourceProcessRevision(source, this.selectedModel))
    }
  }

  private async waitForCodexInitialization(
    initialization: Promise<void>,
    onStillWaiting?: () => void,
  ): Promise<{ state: 'init' | 'error' | 'timeout' | 'waiting_quota'; error?: unknown }> {
    return await new Promise(resolve => {
      let settled = false
      const finish = (state: 'init' | 'error' | 'timeout' | 'waiting_quota', error?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(noticeTimer)
        clearTimeout(timeoutTimer)
        resolve({ state, error })
      }
      const noticeTimer = setTimeout(() => {
        if (settled) return
        try { onStillWaiting?.() }
        catch (error) { finish('error', error) }
      }, CODEX_INIT_NOTICE_MS)
      const timeoutTimer = setTimeout(() => {
        finish('timeout', new Error(`codex init timed out after ${CODEX_INIT_TIMEOUT_MS / 1000}s`))
      }, CODEX_INIT_TIMEOUT_MS)
      void initialization.then(
        () => finish('init'),
        error => finish('error', error),
      )
      void this.proc?.quotaWaitPromise?.().then(() => finish('waiting_quota'), error => finish('error', error))
    })
  }

  private waitForProcEarlyFailure(
    proc: AgentProcess,
    graceMs: number,
  ): Promise<{ state: 'init' | 'error' | 'exit' | 'ready'; error?: unknown }> {
    return new Promise(resolve => {
      let settled = false
      const finish = (state: 'init' | 'error' | 'exit' | 'ready', error?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        proc.off('init', onInit)
        proc.off('error', onError)
        proc.off('exit', onExit)
        resolve({ state, error })
      }
      const timer = setTimeout(() => finish('ready'), graceMs)
      const onInit = () => finish('init')
      const onError = (e: unknown) => finish('error', e)
      const onExit = (e: unknown) => finish('exit', e)
      proc.once('init', onInit)
      proc.once('error', onError)
      proc.once('exit', onExit)
    })
  }


  /** Drop every ⏳ OneSecond reaction this session is currently holding
   * on user chat messages, then empty the two tracking maps. Used by
   * every tear-down path (proc exit, kill, restart) so reactions don't
   * outlive the conversation that placed them — without this, a Codex
   * crash / daemon SIGTERM leaves orphan ⏳ stuck on user messages until
   * Feishu's UI eventually GCs them (which it doesn't, in practice).
   * closeTurnCard has its own release pass (with the slightly-early
   * merged-batch trade-off documented there); this is the catastrophic-
   * exit pass. Direct `deleteReaction` calls are fire-and-forget and
   * swallow their own failures (see feishu.deleteReaction). */
  private releaseAllReactions(): void {
    for (const [msgId, rid] of [
      ...this.pendingReactionIds.entries(),
      ...this.currentBatchReactionIds.entries(),
    ]) {
      if (rid) void feishu.deleteReaction(msgId, rid)
    }
    this.pendingReactionIds = new Map()
    this.currentBatchReactionIds = new Map()
  }

  private beginTurnOpening(): TurnOpenTerminalStash {
    if (this.openingTurnOwner) {
      throw new Error('turn card open already owned; same-process opens must wait for the current owner')
    }
    const token: TurnOpenTerminalStash = {}
    this.openingTurnOwner = token
    this.openingTurn = true
    let resolve!: () => void
    const promise = new Promise<void>(r => { resolve = r })
    this.openingTurnDone = { promise, resolve }
    return token
  }

  private finishTurnOpening(token: object): void {
    if (this.openingTurnOwner !== token) return
    this.openingTurnOwner = null
    this.openingTurn = false
    const done = this.openingTurnDone
    this.openingTurnDone = null
    done?.resolve()
  }

  private clearTurnOpening(): void {
    this.openingTurnOwner = null
    this.openingTurn = false
    const done = this.openingTurnDone
    this.openingTurnDone = null
    done?.resolve()
  }

  discardQueuedHumanWork(reason: string): void {
    this.clearMultiMsgBuffer(reason)
    this.clearCapacityRetryState(`discardQueuedHumanWork:${reason}`)
    const pendingDelivery = this.pendingHumanDelivery
    if (pendingDelivery) {
      pendingDelivery.state = 'restored'
      for (const [msgId, reactionId] of pendingDelivery.reactions) {
        if (reactionId) void feishu.deleteReaction(msgId, reactionId)
      }
      this.pendingHumanDelivery = null
    }
    this.ackedHumanDelivery = null
    this.restoredHumanDelivery = null
    this.pendingUserMessageCount = 0
    this.pendingMidTurnMsgs = []
    this.pendingTurnInputs = []
    this.lastUserOpenId = ''
    this.releaseAllReactions()
  }

  private clearCapacityRetryState(_reason: string): void {
    if (this.capacityRetryAttempts !== 0) {
      logDiagnostic("session: clear capacity retry attempts")
    }
    this.capacityRetryAttempts = 0
    this.capacityRetryExhausted = false
  }

  /** 进程层 `turn_retry` 的本地外挂(D-07):调度权完全在进程层(2e6e1e0),
   *  session 只做三件事,且**不排任何计时器、不发起续作轮**:
   *  - footer:实际文案由 startFooterStatus 读 proc.turnRetry 覆盖,这里只重启一次
   *    footer 让状态立刻可见(重复事件仅刷新 footer,不产生第二次派发);
   *  - 耗尽通知:attempt 超过阈值后**一次性**群通知;进程层语义是持续退避,通知
   *    不取消重试;
   *  - drain 优先 / 忙时让路:退避等待期不阻塞已排队的真人中途消息;有 turn/开卡/
   *    工作中时本外挂不发起任何续作(真人消息路径与进程层重试是仅有的两个驱动)。 */
  private noteCapacityRetry(retry: AgentTurnRetry): void {
    this.capacityRetryAttempts = retry.attempt
    if (this.currentTurn) this.startThinkingFooter(this.currentTurn)
    if (retry.phase !== 'waiting') return
    if (retry.attempt > CAPACITY_RETRY_MAX_ATTEMPTS && !this.capacityRetryExhausted) {
      this.capacityRetryExhausted = true
      logDiagnostic("session: capacity retry exhausted attempts")
      void feishu.sendTextRaw(
        this.chatId,
        `⚠️ Codex 模型容量不足,已自动重试 ${CAPACITY_RETRY_MAX_ATTEMPTS} 次仍失败。请稍后再发一条消息,或切换其他模型。`,
      ).catch(() => {})
    }
    if (this.currentTurn || this.openingTurn || this.status === 'working' || this.status === 'starting') {
      logDiagnostic("session: capacity retry hook yielded — session busy")
      return
    }
    if (this.pendingMidTurnMsgs.length > 0) {
      logDiagnostic("session: capacity retry hook #")
      void this.drainMidTurnAndOpen().catch((_e) => {
        logError("session: capacity retry drain failed", _e)
      })
    }
  }

  clearStaleIdleQueueState(_reason: string): void {
    if (
      this.initCount < 1 ||
      this.currentTurn ||
      this.openingTurn ||
      this.pendingHumanDelivery ||
      this.ackedHumanDelivery?.turn === null ||
      this.pendingUserMessageCount === 0
    ) return
    logDiagnostic("session: clear stale pending queue before")
    this.pendingUserMessageCount = 0
    // Release stale ⏳ reactions left on the abandoned batch's chat
    // messages. addReaction callbacks still in flight will fall through
    // to the orphan path in onUserMessage's trackQueuedReaction helper.
    for (const [m, rid] of this.pendingReactionIds) {
      if (rid) void feishu.deleteReaction(m, rid)
    }
    this.pendingReactionIds = new Map()
  }

  async stop(reason = '已终止', opts: LifecycleProgressOpts = {}): Promise<void> {
    this.modelPanelRefreshEpoch++
    this.cancelFileDeliveries(reason)
    const lease = this.lifecycleLease('stop', opts)
    if (!this.ownsLifecycle(lease)) return
    this.discardPreservedWatchdogRecovery(`stop: ${reason}`)
    this.clearWatchdogRuntime(`stop: ${reason}`)
    this.toolFailureLoopAction = null
    this.clearToolFailureLoop()
    this.discardQueuedHumanWork('stop')
    // stop ends any in-session GSD execution signal (panel fine-progress gate).
    sessionGsd.clearGsdExecution(this)
    // 同上:带 lease 的嵌套 stop(回滚事务)直进,避免与外层 lifecycle 互等。
    // stopLifecycleActive 覆盖整个执行窗口(kill/agy 等待在内):在途消息直进
    // (见字段注释 + onUserMessage 豁免),stop 自身的 discard 照常吞掉它们。
    this.stopLifecycleActive++
    try {
      if (opts.lifecycleLease) {
        await this.stopUnlocked(reason, { ...opts, lifecycleLease: lease })
        return
      }
      await this.runLifecycle('stop', () => this.stopUnlocked(reason, { ...opts, lifecycleLease: lease }))
    } finally {
      this.stopLifecycleActive--
    }
  }

  cancelFileDeliveries(reason: string): boolean {
    let cancelled = false
    for (const delivery of this.fileDeliveries) cancelled = delivery.cancel(reason) || cancelled
    return cancelled
  }

  private async stopUnlocked(reason = '已终止', opts: LifecycleProgressOpts = {}): Promise<void> {
    this.cancelFileDeliveries(reason)
    const lease = this.lifecycleLease('stop', opts)
    if (!this.ownsLifecycle(lease)) return
    const announce = opts.announce ?? true
    const report = opts.onStatus
    this.daemonRestoreRequired = false
    const proc = this.proc
    // Close admission before delegated cancellation can await network/process
    // cleanup. The old main process must not create replacements during it.
    if (proc) this.beginProcStop(proc)
    let stoppedAgy = false
    let cancellationError: unknown = null
    try {
      stoppedAgy = await this.stopAgyTask(`🛑 ${reason}`)
      if (stoppedAgy) report?.(`✅ ${reason}`)
      await this.cancelAgentRuns(reason)
    } catch (error) { cancellationError = error }
    if (!this.ownsLifecycle(lease)) return
    this.discardQueuedHumanWork('stop')
    if (!proc) {
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      if (cancellationError) throw cancellationError
      report?.('⚪ session 当前未运行')
      if (announce) await feishu.sendText(this.chatId, `⚪ session "${this.sessionName}" 当前未运行`)
      return
    }
    // Close the tiny materialization→stop window: Codex sets its durable flag
    // before emitting conversation_materialized, so an immediately following
    // stop can still persist the exact process-owned resume point.
    let stopResumeError = this.persistResumableSessionId(false, proc, false)
    let stopMaterializationError: string | null = null
    report?.(`🛑 停止 ${this.backendLabel(proc.provider)}`)
    // Flip lifecycle state SYNCHRONOUSLY before awaiting kill — daemon's
    // SIGTERM cleanup snapshots `isRunning()` and if we're still mid-
    // `proc.kill()` await it'll see proc!=null and write us into the
    // alive marker, which makes the next boot auto-revive a session
    // the user explicitly killed. Reordering the null-out fixes that
    // race (bug observed 2026-05-15: `kill` immediately followed by
    // `systemctl restart` revived the killed session on boot).
    this.invalidateTurnOpen()
    this.stopFooterStatus(this.currentTurn)
    if (this.currentTurn) {
      void this.closeTurnCard(`🛑 ${reason}`).catch(e => {
        logError('session: stop current main-card close failed', e)
      })
    }
    const turnClose = this.waitForTurnCloses()
      .catch(e => logError('session: stop main-card close failed', e))
    this.beginProcStop(proc)
    this.status = 'stopped'
    const lifecycleErrors: unknown[] = []
    // Persist the user's stop intent before the first kill await. If the
    // daemon is hard-killed while the backend exits, the alive marker must
    // already exclude this Session.
    try { this.opts.onLifecycleChange?.() }
    catch (e) {
      lifecycleErrors.push(e)
      logError('session: stop intent lifecycle write failed', e)
    }
    const materializationBarrier = proc.conversationMaterializationBarrier?.()
    if (materializationBarrier) {
      try { await materializationBarrier }
      catch (error) {
        stopMaterializationError = `Codex 会话落盘确认失败: ${messageOf(error)}`
      }
      stopResumeError = this.persistResumableSessionId(false, proc, false)
    }
    this.clearMultiMsgBuffer('stop')
    this.pendingUserMessageCount = 0
    this.pendingMidTurnMsgs = []
    this.pendingTurnInputs = []
    this.lastUserOpenId = ''
    this.releaseAllReactions()
    this.initCount = 0
    this.invalidateTurnOpen()
    this.bgResumePending = false
    // 用户主动停止:孤儿缓冲随轮作废,不兜底推送。
    this.discardOrphanAssistant()
    this.pendingAsks.clear()
    this.pendingHostAsks.clear()
    this.pendingPermissions.clear()
    this.currentTurnUsageBaseline = null
    this.currentTurnUsageBaselineKnown = false
    this.usageTotalsSeedUnknown = false
    let killError: unknown = null
    try { await proc.kill() }
    catch (e) { killError = e }
    const lateMaterializationFailure = proc.conversationMaterializationFailure?.()
    if (lateMaterializationFailure && proc.isConversationResumable?.() !== true) {
      stopMaterializationError = `Codex 会话落盘确认失败: ${messageOf(lateMaterializationFailure)}`
    }
    // A turn may materialize while SIGTERM is in flight. wireProc deliberately
    // ignores ordinary events once stopping begins, but Codex flips its
    // verified resumable flag before emitting the event; persist that exact
    // owned process once more before detach.
    stopResumeError = this.persistResumableSessionId(false, proc, false)
    // Card cleanup is independent from process ownership. Never let a
    // Feishu/CardKit failure skip finishProcStop: that would leave
    // stoppingProc set without blockedProc and turn later inputs into a black
    // hole whose backend events are deliberately ignored.
    const cleanupResults = await Promise.allSettled([this.resetBackgroundTasks(lease), turnClose])
    const cleanupErrors = cleanupResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason)
    for (const error of cleanupErrors) {
      logError('session: stop terminal cleanup failed', error)
    }
    const confirmed = this.finishProcStop(proc, killError)
    try { this.opts.onLifecycleChange?.() }
    catch (e) {
      lifecycleErrors.push(e)
      logError('session: stop final lifecycle write failed', e)
    }
    if (!this.ownsLifecycle(lease)) return
    // 上游 stop 契约(合并吸收,替代本地旧「resolve + ❌ 回执」):失败必须 reject。
    // 冻结调用方 session-commands.ts kill 命令 / temp-session-runtime.ts 均已按
    // rejection 组装「未确认终止/会话已阻断/停止收尾失败」告警(上游 16923/16992/
    // 17062/17085/17110 同断言),resolve 会把告警吞成成功回执。失败时进程保留为
    // blockedProc(见 finishProcStop),shouldRevive() 据此排除 revive —— 本地
    // 「停止后 alive marker 不含它」语义由 blockedProc 承担,不再靠 proc=null 伪造。
    const failures: unknown[] = [
      ...(cancellationError ? [cancellationError] : []),
      ...(killError ? [killError] : []),
      ...(!confirmed && !killError ? [new Error(this.blockedProcReason ?? 'process stop unconfirmed')] : []),
      ...cleanupErrors,
      ...lifecycleErrors,
      ...(stopResumeError ? [new Error(stopResumeError)] : []),
      ...(stopMaterializationError && proc.isConversationResumable?.() !== true
        ? [new Error(stopMaterializationError)]
        : []),
    ]
    if (failures.length > 0) {
      const detail = failures.map(messageOf).join('; ')
      logDiagnostic("session: stop finished with failures")
      if (failures.length === 1) throw failures[0]
      throw new AggregateError(failures, `stop failed: ${detail}`)
    }
    report?.(`✅ ${reason}`)
    if (announce) await feishu.sendText(this.chatId, `🔴 ${reason} (session: ${this.sessionName})`)
  }

  async restart(
    resume = false,
    // onResumeInvalidated:上游 restartUnlocked 第三参的本地 opts 字段承接(挂账 #5
    // 接线)——restart 内 invalidateMissingCodexResume 确认旧 id 无 rollout 时回调,
    // rollbackTo restore 据此走清空分支不绑回幽灵 id。
    opts: LifecycleProgressOpts & { onResumeInvalidated?: (sessionId: string) => void } = {},
  ): Promise<boolean> {
    this.modelPanelRefreshEpoch++
    // 同上:带 lease 的嵌套 restart(watchdog / 回滚事务)直进,避免
    // runLifecycle 队列与外层 lifecycle 互等。
    if (opts.lifecycleLease) return await this.restartUnlocked(resume, opts)
    return await this.runLifecycle('restart', () => this.restartUnlocked(resume, opts))
  }

  requireDaemonRestore(): void {
    this.daemonRestoreRequired = true
  }

  async restoreAfterDaemonRestart(): Promise<boolean> {
    return await this.runLifecycle('daemon-restore', async () => {
      this.requireDaemonRestore()
      if (!this.lastSessionRef && !this.pendingMaterializationLaunch()) {
        const message = '❌ daemon 重启后没有可用的恢复点。请发送 rs 选择历史会话，或 hi 明确启动新会话。'
        this.status = 'stopped'
        this.opts.onLifecycleChange?.()
        await feishu.sendText(this.chatId, message)
        return false
      }
      return await this.restartUnlocked(true)
    })
  }

  /** Explicit local restart exception: one new continuation request on the
   * restored conversation, never a replay or an implicit fresh start. */
  async continueAfterDaemonRestart(): Promise<void> {
    await this.runLifecycle('daemon-continue', async () => {
      const proc = this.proc
      if (this.daemonRestoreRequired || this.status !== 'idle' || this.initCount < 1 || !proc?.isAlive()
        || !this.lastSessionRef || proc.sessionId !== this.lastSessionRef.sessionId
        || proc.provider !== this.lastSessionRef.provider || this.lastSessionId !== proc.sessionId
        || this.modelSelectionNeedsProcessStop()
        || this.currentTurn || this.openingTurn || this.steeringSend
        || this.pendingUserMessageCount > 0 || this.pendingMidTurnMsgs.length > 0) {
        throw new Error('原会话尚未恢复为空闲可用状态，未发送自动续接请求')
      }
      await this.onUserMessageUnlocked(
        '[宿主重启自动续接] daemon 已重启并恢复本会话。按用户已授权的范围继续尚未完成的工作，先核对已有执行结果，不要重复已完成的测试或操作。若工作已完成，直接报告结果。',
        [], '', '', false, proc,
      )
    })
  }

  private async restartUnlocked(
    resume = false,
    opts: LifecycleProgressOpts & { onResumeInvalidated?: (sessionId: string) => void } = {},
  ): Promise<boolean> {
    const strictResume = resume && opts.requireResumeSession === true
    const wantsPreservation = !!(opts.preserveCurrentTurn || opts.preserveQueuedHumanWork)
    const existingRecovery = strictResume ? this.preservedWatchdogRecovery : null
    if (
      existingRecovery &&
      opts.resumeIdentity &&
      (
        opts.resumeIdentity.provider !== existingRecovery.provider ||
        opts.resumeIdentity.threadId !== existingRecovery.threadId
      )
    ) return false
    const lease = this.lifecycleLease(opts.requireResumeSession ? 'strict-retry' : 'restart', opts)
    if (!this.ownsLifecycle(lease)) return false
    let recovery: PreservedWatchdogRecovery | null = null
    if (strictResume && wantsPreservation) {
      const existing = this.preservedWatchdogRecovery
      if (existing) {
        if (opts.preservedRecoveryToken !== existing.token) return false
        recovery = this.beginPreservedWatchdogRetry(lease)
      } else {
        recovery = this.preserveCurrentWatchdogContext(lease)
      }
      if (!recovery) return false
    } else if (wantsPreservation) {
      return false
    }

    const resumeIdentity: ResumeIdentity | null = strictResume
      ? (recovery
          ? { provider: recovery.provider, threadId: recovery.threadId }
          : (opts.resumeIdentity ?? null))
      : (resume
          ? (opts.resumeIdentity ?? (this.lastSessionId
              ? { provider: this.selectedProvider, threadId: this.lastSessionId }
              : null))
          : null)
    const provider = resumeIdentity?.provider ?? this.selectedProvider
    // let:上游 restart 前置密封的 refreshMaterializedCodexResume 在 kill 前/后
    // 会以进程自证落盘的 resume 点刷新这两个值(kill 窗口内 materialize 的轮
    // 仍以最新 thread 续卡/续起)。
    let prevSessionId = resumeIdentity?.threadId ?? null
    if (strictResume && (!recovery || !prevSessionId)) {
      const message = '❌ 自动恢复失败:没有可恢复的 thread'
      opts.onStatus?.(message)
      logDiagnostic("session: watchdog strict resume rejected missing")
      if (recovery) this.markPreservedWatchdogRecoveryFailed(recovery, lease)
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      return false
    }
    const preserveWatchdogTransaction = !!recovery &&
      recovery.provider === provider &&
      recovery.threadId === prevSessionId &&
      this.ownsPreservedWatchdogRecovery(recovery, lease)
    if (!preserveWatchdogTransaction) {
      this.discardPreservedWatchdogRecovery('ordinary restart')
      this.clearWatchdogRuntime('restart')
    }
    const announce = opts.announce ?? true
    let report = opts.onStatus
    // ── restart 前置三件(4185808 restartUnlocked 同位次序,簇 2) ──────────
    const statusBeforeResumeValidation = this.status
    // ① 显式 clear/fresh restart 取消 prepared fork:先持久清 pendingLaunch 再停
    //    进程;持久化失败(setPendingConversationLaunchChecked throw)直接上抛,
    //    routing 与现有进程均保持原样。rollbackTo 驱动的 fresh 带一次性 intent,
    //    不落此分支(其 pendingLaunch 归 rollback 事务 restore 管辖)。
    let cancelledPending: PendingConversationLaunch | null = null
    if (!resume && !this.pendingConversationLaunch && this.pendingConversationMaterialization) {
      cancelledPending = this.pendingConversationMaterialization
      feishu.setPendingConversationLaunchChecked(this.sessionName, null)
      this.pendingConversationMaterialization = null
    }
    // ② explicitLaunch:一次性 intent 或 durable Claude fork intent 在位时 resume
    //    语义由 launch 决定,legacy 升级不适用。
    const explicitLaunch = this.pendingConversationLaunch?.launch
      ?? (resume ? this.codexQuotaWaitLaunch : null)
      ?? this.pendingMaterializationLaunch()
    if (resume && explicitLaunch && explicitLaunch.kind !== 'fresh') {
      validateConversationLaunch(explicitLaunch, provider, this.workDir)
      prevSessionId = explicitLaunch.source.sessionId
    }
    // ③ legacy(cwd:null)记录在停进程前升级——校验失败拒绝 restart 且现有进程
    //    不被 kill(上游「前置不 kill」次序,04-03 接线差异 #1 收账)。
    if (
      resume && !explicitLaunch && prevSessionId
      && this.lastSessionRef?.provider === provider
      && this.lastSessionRef.sessionId === prevSessionId
      && this.lastSessionRef.cwd === null
    ) {
      try {
        const upgraded = await this.resolveLegacyResumeRef(this.lastSessionRef)
        if (!this.ownsLifecycle(lease)) return false
        this.lastSessionRef = upgraded
        this.lastSessionId = upgraded.sessionId
      } catch (error) {
        // legacy 升级(thread/read)确认无 rollout 时同样作废 ghost 绑定(挂账 #4)。
        const invalidation = this.invalidateMissingCodexResume(prevSessionId, error, opts.onResumeInvalidated)
        const status = invalidation
          ? `❌ 旧会话不可恢复: ${messageOf(error)}；${invalidation}`
          : `❌ 旧会话 cwd 校验失败: ${messageOf(error)}；请在进程已停时发送 rs 重新选择历史会话`
        logError("session: legacy resume upgrade failed before stop", error)
        if (!this.ownsLifecycle(lease)) return false
        this.status = this.proc?.isAlive() ? statusBeforeResumeValidation : 'stopped'
        report?.(status)
        if (announce) {
          await feishu.sendText(this.chatId, status)
        }
        return false
      }
    }
    let prevThreadLabel = prevSessionId ? prevSessionId.slice(0, 8) : ''
    let statusCard: StatusCardHandle | null = null
    if (!report && announce && resume && prevSessionId) {
      const initialStatus = this.proc
        ? this.withModel(`🔁 重启 ${this.backendLabel(this.proc.provider)}`)
        : this.withModel(`🔁 恢复上一会话 thread=${prevThreadLabel}`)
      statusCard = await this.openStatusCard('restart', initialStatus)
      if (!this.ownsLifecycle(lease)) return false
      if (statusCard) report = status => this.setStatusCard(statusCard, status)
    }
    const announceText = announce && !statusCard
    const closeInternalStatusCard = async (finalStatus: string): Promise<void> => {
      if (statusCard) await this.closeStatusCard(statusCard, finalStatus)
    }
    // ── 上游 restart 前置密封(4185808/ec149d7 簇 4「会话生命周期可靠性」)──
    // ① 旧进程是否仍有会话工作:决定「恢复点尚未落盘」时能否安全中止 kill
    //    (有在途工作就没有保进程的原位语义,只能停掉)。必须在任何队列清理前快照。
    const hadActiveConversationWork = Boolean(
      this.currentTurn
      || this.openingTurn
      || this.pendingUserMessageCount > 0
      || this.pendingMidTurnMsgs.length > 0
      || this.pendingTurnInputs.length > 0
      || cards.hasActiveBgTask(this.backgroundTasks)
      || this.pendingBgTasks.length > 0,
    )
    // ② 恢复点密封:beginProcStop 关闭事件门后、SIGTERM 前后各刷新一次进程自证
    //    落盘的 resume 点(Codex 先翻 durable flag 再 emit,而 wireProc 在
    //    stopping 期间故意忽略普通事件 —— 只有这里能把窗口内 materialize 的
    //    轮冻结成恢复点)。resumeRefreshError 非空 = 恢复点未安全落盘。
    //    本地适配:仅当 lastSessionRef 与 resumeIdentity provider 一致才回填
    //    prevSessionId(本地多 provider 路由下 lastSessionRef 可能是别的后端)。
    let resumeRefreshError: string | null = null
    const refreshMaterializedCodexResume = (current: AgentProcess | null = this.proc): void => {
      if (
        !resume
        || explicitLaunch
        || current?.provider !== 'codex'
        || current.isConversationResumable?.() !== true
      ) return
      resumeRefreshError = this.persistResumableSessionId(false, current, false)
      if (this.lastSessionRef?.provider === provider) {
        prevSessionId = this.lastSessionRef.sessionId
        prevThreadLabel = prevSessionId.slice(0, 8)
      }
    }
    // 主动重启:孤儿缓冲随轮作废,不兜底推送。必须在 kill 之前丢弃 ——
    // 否则 kill 触发的 exit 处理器会抢先把缓冲当作"进程崩溃残留"兜底推出去,
    // 违背 restart 的作废语义。旧 proc 不再预置 null(上游形态):beginProcStop
    // 的 stoppingProc 门让 killed 后的事件走「stopping exit」早退(stop() 同一
    // 模式),脱管统一由 finishProcStop/detachProc 判定 —— kill 未确认时进程
    // 保留为 blockedProc,而不是伪造成已脱管。
    this.bgResumePending = false
    this.invalidateTurnOpen()
    this.discardOrphanAssistant()
    for (const delivery of this.fileDeliveries) delivery.cancel('会话正在重启')
    if (this.currentTurn && !wantsPreservation) {
      void this.closeTurnCard('🔁 已中止，正在重启').catch(e => {
        logError('session: restart current main-card close failed', e)
      })
    }
    // ec149d7 主题 I 行为对齐:kill 与取消如实抛出(01-09)不得跳过下方轮作废
    // 清理;错误捕获后在清理收敛处统一判定 —— stop 未确认时不 spawn 新进程
    // (上游同语义:未确认死透的旧进程上叠 resume 重启,存在同 thread 双写风险)。
    let killError: unknown = null
    let cancellationError: unknown = null
    let stoppedProc: AgentProcess | null = null
    let stoppedProvider: AgentProvider | null = null
    if (this.proc) {
      const proc = this.proc
      report?.(`🛑 停止当前 ${this.backendLabel(proc.provider)}`)
      stoppedProc = proc
      stoppedProvider = proc.provider
      // Seal the old owner before awaiting materialization. Otherwise a result
      // in this window can drain queued user input into the branch we are
      // about to kill, then restart clears that queue as if it never ran.
      const previousCapability = this.agentCapability
      this.beginProcStop(proc)
      try { await this.cancelAgentRuns('会话正在重启') }
      catch (error) { cancellationError = error }
      const materializationBarrier = proc.conversationMaterializationBarrier?.()
      if (materializationBarrier) {
        try { await materializationBarrier }
        catch (error) {
          resumeRefreshError = `Codex 会话落盘确认失败: ${messageOf(error)}`
        }
      }
      // Freeze any verified materialization after the old owner's event gate
      // has closed but before the process is signalled.
      refreshMaterializedCodexResume(proc)
      if (
        resume
        && !explicitLaunch
        && resumeRefreshError
        && !cancellationError
        && !hadActiveConversationWork
        && proc.isAlive()
      ) {
        // 恢复点未安全落盘 + 无在途工作:不 kill,旧进程原位保留(上游 15933
        // 同款)—— 宁可留在旧会话,也不在无恢复点的情况下杀掉唯一进程。
        if (this.proc === proc && this.stoppingProc === proc) {
          this.stoppingProc = null
          this.agentCapability = previousCapability
        }
        this.status = statusBeforeResumeValidation
        logError('session: restart checkpoint refresh failed', resumeRefreshError)
        const finalStatus = `❌ ${this.backendLabel(proc.provider)} 恢复点尚未安全落盘，已保留当前进程: ${resumeRefreshError}`
        report?.(finalStatus)
        if (announceText) await feishu.sendText(this.chatId, finalStatus)
        await closeInternalStatusCard(finalStatus)
        return false
      }
      try { await proc.kill() }
      catch (e) { killError = e }
      // restart 作废旧进程:其延迟锚一并作废(挂账 #3 收尾口)。
      this.discardPendingCodexTurnAnchors(proc, 'restart discarded process')
      const lateMaterializationFailure = proc.conversationMaterializationFailure?.()
      if (lateMaterializationFailure && proc.isConversationResumable?.() !== true) {
        resumeRefreshError = `Codex 会话落盘确认失败: ${messageOf(lateMaterializationFailure)}`
      }
      // Also close the beginStop→process-exit window (see stopUnlocked).
      refreshMaterializedCodexResume(proc)
    } else {
      // A prior stop can leave a delegated process whose exit was not yet
      // confirmed. Do not launch a new owner until that cleanup succeeds.
      try { await this.cancelAgentRuns('会话正在重启') }
      catch (error) { cancellationError = error }
    }
    this.stopFooterStatus(this.currentTurn)
    if (!opts.preserveCurrentTurn) {
      this.currentTurn = null
      // Ordinary restart ends session-local GSD execution signal.
      sessionGsd.clearGsdExecution(this)
    }
    this.pendingUserMessageCount = 0
    if (!opts.preserveQueuedHumanWork) {
      this.clearMultiMsgBuffer('restart')
      this.pendingMidTurnMsgs = []
      this.pendingTurnInputs = []
      this.lastUserOpenId = ''
      this.releaseAllReactions()
    }
    this.initCount = 0
    this.clearTurnOpening()
    // bgResumePending / 孤儿缓冲已在 kill 前作废(见上)。
    this.pendingAsks.clear()
    this.pendingHostAsks.clear()
    this.pendingPermissions.clear()
    this.currentTurnUsageBaseline = null
    this.currentTurnUsageBaselineKnown = false
    // 后台任务随轮作废:旧 proc 的活跃 entry 不能带进新会话(会跨会话「复活」
    // 到新卡)。翻 killed 终态 + 活卡沉降,在 spawn 新 proc 之前清干净。
    // 在途 turn close 等待(ff44afb turnCloseInflight,04-05 甄别红例最小集):
    // close 可能已同步摘除 currentTurn 但 flush/终态写仍在途——spawn 前等全部
    // 落地,防旧卡终态写与新进程新卡交错(红例:restart waits for a close that
    // already removed currentTurn before spawning)。
    const turnClose = this.waitForTurnCloses()
      .catch(_e => logError("session: restart main-card close failed", _e))
    const cleanupResults = await Promise.allSettled([this.resetBackgroundTasks(lease), turnClose])
    const cleanupErrors = cleanupResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason)
    for (const error of cleanupErrors) {
      logError('session: restart terminal cleanup failed', error)
    }
    // 进程所有权收敛:cleanup/turnClose 失败不得跳过 finishProcStop,否则
    // stoppingProc 悬挂把后续输入变成黑洞(上游 stopFailures 同位次序)。
    const stopConfirmed = stoppedProc ? this.finishProcStop(stoppedProc, killError) : true
    const stopFailures = [
      ...(cancellationError ? [`agents=${messageOf(cancellationError)}`] : []),
      ...(killError ? [`kill=${messageOf(killError)}`] : []),
      ...(!stopConfirmed && !killError ? [`kill=${this.blockedProcReason ?? 'process stop unconfirmed'}`] : []),
      ...cleanupErrors.map(error => `cleanup=${messageOf(error)}`),
      ...(resumeRefreshError ? [`resume=${resumeRefreshError}`] : []),
    ]
    // stop 失败恢复 pending(4185808 stopFailures 同位):进程没停成,头部取消的
    // prepared fork 恢复原值——不留「磁盘已清、进程还活」的半取消态。
    if (stopFailures.length > 0 && cancelledPending) {
      try {
        feishu.setPendingConversationLaunchChecked(this.sessionName, cancelledPending)
        this.pendingConversationMaterialization = cancelledPending
      } catch (error) {
        stopFailures.push(`pendingRestore=${messageOf(error)}`)
      }
    }
    if (stopFailures.length > 0) {
      const finalStatus = `❌ 旧 ${this.backendLabel(stoppedProvider ?? undefined)} 进程停止/清理失败: ${stopFailures.join('; ')}`
      logDiagnostic("session: restart aborted, old process stop/cleanup failed")
      // 旧分支只在旧进程收不口(kill 未确认/取消失败)时烧掉 watchdog 事务;
      // cleanup-only 失败保留 recovery 供重试(本地语义收窄,防误判)。
      if (recovery && (killError || cancellationError)) {
        this.markPreservedWatchdogRecoveryFailed(recovery, lease)
      }
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      report?.(finalStatus)
      if (announceText) {
        await feishu.sendText(this.chatId, finalStatus)
        if (!this.ownsLifecycle(lease)) return false
      }
      await closeInternalStatusCard(finalStatus)
      return false
    }
    if (!this.ownsLifecycle(lease)) return false
    if (resume && prevSessionId) {
      if (recovery && !this.ownsPreservedWatchdogRecovery(recovery, lease)) return false
      this.status = 'starting'
      this.usageTotalsSeedUnknown = true
      report?.(this.withModel(`🔁 恢复上一会话 thread=${prevThreadLabel}`))
      let proc: AgentProcess
      try {
        // legacy(cwd:null)已在前置 ③ 升级(前置不 kill);此处 lastSessionRef
        // 命中即非 null cwd,否则以当前 workDir 合成(resumeIdentity 显式指定)。
        const resumeRef: ConversationRef =
          this.lastSessionRef?.provider === provider && this.lastSessionRef.sessionId === prevSessionId
            ? this.lastSessionRef
            : { provider, sessionId: prevSessionId, cwd: this.workDir }
        proc = this.spawnAgent(resumeRef, provider, lease, explicitLaunch ?? undefined)
        this.pendingSpawnOwnership = { lease, proc }
      } catch (e) {
        // legacy 升级(thread/read)确认无 rollout 时同样作废 ghost 绑定(挂账 #4)。
        const invalidation = this.invalidateMissingCodexResume(prevSessionId, e, opts.onResumeInvalidated)
        const finalStatus = invalidation
          ? `❌ ${this.backendLabel(provider)} 恢复失败: ${messageOf(e)}；${invalidation}`
          : `❌ ${this.backendLabel(provider)} 恢复失败: ${messageOf(e)}`
        logError("session: resume failed before spawn", e)
        if (!this.ownsLifecycle(lease)) return false
        report?.(finalStatus)
        if (!this.ownsLifecycle(lease)) return false
        if (announceText) {
          await feishu.sendText(this.chatId, finalStatus)
          if (!this.ownsLifecycle(lease)) return false
        }
        if (recovery) this.markPreservedWatchdogRecoveryFailed(recovery, lease)
        this.status = 'stopped'
        this.opts.onLifecycleChange?.()
        await closeInternalStatusCard(finalStatus)
        return false
      }
      if (!this.ownsLifecycle(lease)) {
        await this.discardLocalProcess(lease, proc)
        return false
      }
      if (proc.provider !== provider) {
        await this.discardLocalProcess(lease, proc)
        if (!this.ownsLifecycle(lease)) return false
        if (recovery) this.markPreservedWatchdogRecoveryFailed(recovery, lease)
        this.status = 'stopped'
        this.opts.onLifecycleChange?.()
        return false
      }
      this.proc = proc
      if (recovery) recovery.replacementProc = proc
      this.wireProc(proc)
      const cleanupFailedReplacement = async (): Promise<boolean> => {
        const ownedReplacement = this.proc === proc
        if (ownedReplacement) this.proc = null
        if (recovery?.replacementProc === proc) recovery.replacementProc = null
        this.clearPendingSpawn(lease, proc)
        if (proc.isAlive()) await proc.kill(1000).catch(() => {})
        return ownedReplacement && this.ownsLifecycle(lease) && this.proc === null
      }
      const backend = this.backendLabel(provider)
      const claudeInitWait = provider === 'claude'
        ? this.waitForProcEarlyFailure(proc, CLAUDE_STARTUP_GRACE_MS)
        : null
      report?.(provider === 'claude'
        ? `⏳ 检查 ${backend} 恢复启动`
        : `⏳ 等待 ${backend} init 确认`)
      let initialization: Promise<void> | undefined
      let initializeThrown: unknown = null
      try {
        proc.sendInitialize()
        initialization = proc.initializationPromise?.()
      } catch (error) {
        initialization = undefined
        initializeThrown = error
      }
      // 合并吸收(上游 session 恢复优化,2162-2183 同位):codex/dsh 恢复路径改走
      // waitForCodexInitialization —— 等 initialize+thread/start 事务 promise(含
      // quotaWaitPromise 收口),与 start 路径同一求值入口。main 的事件版
      // waitForProcResumeInit 退役:其 'exit' 快速失败面由「事务 promise reject →
      // state 'error'」与随后的 isAlive/身份校验覆盖;上游用例通过覆写
      // waitForCodexInitialization 模拟恢复传输失败,注册表链路才能一致收口。
      const init = initializeThrown
        ? { state: 'error' as const, error: initializeThrown }
        : provider === 'claude'
          ? initialization ? await this.waitForClaudeInitialization(initialization, claudeInitWait!) : await claudeInitWait!
          : await this.waitForCodexInitialization(
              this.requireCodexInitializationPromise(initialization),
              () => {
                logDiagnostic("session: resume init still pending after")
                report?.(this.withModel(`⏳ 仍在等待 ${backend} init 确认 thread=${prevThreadLabel}…`))
              },
            )
      if (!this.ownsLifecycle(lease)) {
        await this.discardLocalProcess(lease, proc)
        return false
      }
      if (this.proc !== proc && this.proc !== null) {
        await this.discardLocalProcess(lease, proc)
        return false
      }
      if (init.state === 'error' || init.state === 'exit' || init.state === 'timeout') {
        // app-server 确认 exact 绑定 id 无 rollout → checked 作废 ghost 绑定
        // (挂账 #4);其余失败保留绑定供诊断/重试。本地失败面 = waitForProcInit/
        // waitForProcResumeInit 与 sendInitialize catch 汇入的 init.error。
        const invalidation = init.state === 'error'
          ? this.invalidateMissingCodexResume(prevSessionId, init.error, opts.onResumeInvalidated)
          : null
        const detail = [init.error ? messageOf(init.error) : init.state, invalidation]
          .filter(Boolean)
          .join('；')
        logError('session: resume failed', detail)
        const stopConfirmed = await this.stopOwnedProc(proc, 1000)
        const cleanup = stopConfirmed
          ? ''
          : `；进程终止未确认: ${this.blockedProcReason ?? '未知原因'}`
        const finalStatus = init.state === 'timeout'
          ? `❌ ${backend} 恢复超时${cleanup}`
          : `❌ ${backend} 恢复失败: ${detail}${cleanup}`
        report?.(finalStatus)
        if (announceText) {
          await feishu.sendText(this.chatId, finalStatus)
          if (!this.ownsLifecycle(lease) || this.proc !== proc) {
            await this.discardLocalProcess(lease, proc)
            return false
          }
        }
        const mayMutateSession = await cleanupFailedReplacement()
        if (!mayMutateSession) {
          await closeInternalStatusCard(finalStatus)
          return false
        }
        if (recovery) this.markPreservedWatchdogRecoveryFailed(recovery, lease)
        this.clearCodexProcessActivityState()
        this.status = 'stopped'
        this.opts.onLifecycleChange?.()
        await closeInternalStatusCard(finalStatus)
        return false
      }
      if (
        this.proc !== proc ||
        !proc.isAlive() ||
        proc.provider !== provider ||
        (strictResume && proc.sessionId !== prevSessionId)
      ) {
        const finalStatus = `❌ ${backend} 恢复失败: replacement identity mismatch`
        logDiagnostic("session: resume lost replacement identity after init")
        report?.(finalStatus)
        if (announceText) {
          await feishu.sendText(this.chatId, finalStatus)
          if (!this.ownsLifecycle(lease) || this.proc !== proc) {
            await this.discardLocalProcess(lease, proc)
            return false
          }
        }
        const mayMutateSession = await cleanupFailedReplacement()
        if (!mayMutateSession) {
          await closeInternalStatusCard(finalStatus)
          return false
        }
        if (recovery) this.markPreservedWatchdogRecoveryFailed(recovery, lease)
        this.clearCodexProcessActivityState()
        this.status = 'stopped'
        this.opts.onLifecycleChange?.()
        await closeInternalStatusCard(finalStatus)
        return false
      }
      this.captureAuthenticatedClaudeRevision(proc)
      const msg = this.withModel(this.withWorktreeInstructionNotice(
        init.state === 'waiting_quota' ? '⏳ 账号额度用尽 · 等待后自动恢复原会话'
        : provider === 'claude' && init.state === 'ready'
          ? `✅ 已准备恢复上一会话 thread=${prevThreadLabel}…`
          : `✅ 已恢复上一会话 thread=${prevThreadLabel}…`,
      ))
      if (init.state === 'waiting_quota') {
        const launch = explicitLaunch ?? (this.lastSessionRef ? { kind: 'resume' as const, source: this.lastSessionRef } : null)
        if (launch && launch.kind !== 'fresh') this.codexQuotaWaitLaunch = launch
      }
      report?.(msg)
      if (announceText) await feishu.sendText(this.chatId, msg)
      if (!this.ownsLifecycle(lease) || this.proc !== proc || !proc.isAlive()) {
        await this.discardLocalProcess(lease, proc)
        return false
      }
      this.clearPendingSpawn(lease, proc)
      this.status = init.state === 'waiting_quota' ? 'starting' : 'idle'
      this.startedAt = Date.now()
      if (init.state !== 'waiting_quota') this.daemonRestoreRequired = false
      this.opts.onLifecycleChange?.()
      try { await closeInternalStatusCard(msg) } catch (error) {
        logError('session: restart succeeded but status-card close failed', error)
        await feishu.sendTextRaw(this.chatId, `⚠️ ${msg}\n状态卡收尾失败: ${messageOf(error)}`)
      }
      return true
    } else {
      // Resume requested but no prior session_id on file — surface it
      // explicitly rather than silently fresh-starting (the old behavior
      // hid the daemon-restart sessionId-loss bug for months).
      if (resume && !explicitLaunch) {
        report?.('⚠️ 没有可恢复的上一会话，将以新会话启动')
        if (announceText) {
          await feishu.sendText(this.chatId, '⚠️ 没有可恢复的上一会话，将以新会话启动')
          if (!this.ownsLifecycle(lease)) return false
        }
      }
      // Fresh conversation — drop cumulative stats and the visible turn
      // number so the next card starts from turn 1.
      this.resetFreshConversationState()
      return await this.start({ ...opts, lifecycleLease: lease, freshConversationStateAlreadyReset: true })
    }
  }

  async resumeFailedWatchdogQueue(opts: LifecycleProgressOpts = {}): Promise<boolean> {
    const lease = this.lifecycleLease('strict-retry', opts)
    if (!this.ownsLifecycle(lease)) return false
    const recovery = this.beginPreservedWatchdogRetry(lease)
    if (!recovery) return false
    const identity: ResumeIdentity = {
      provider: recovery.provider,
      threadId: recovery.threadId,
    }
    let resumed = false
    try {
      resumed = await this.restart(true, {
        ...opts,
        announce: opts.announce ?? false,
        lifecycleLease: lease,
        resumeIdentity: identity,
        preservedRecoveryToken: recovery.token,
        requireResumeSession: true,
        preserveCurrentTurn: true,
        preserveQueuedHumanWork: true,
      })
    } catch (e) {
      logError("session: failed watchdog queue resume rejected", e)
    }
    if (!this.ownsPreservedWatchdogRecovery(recovery, lease)) return false
    const replacement = recovery.replacementProc
    if (
      !resumed ||
      !replacement ||
      this.proc !== replacement ||
      !replacement.isAlive() ||
      replacement.provider !== recovery.provider ||
      replacement.sessionId !== recovery.threadId
    ) {
      if (replacement?.isAlive()) await this.discardLocalProcess(lease, replacement)
      if (this.ownsPreservedWatchdogRecovery(recovery, lease)) {
        this.markPreservedWatchdogRecoveryFailed(recovery, lease)
        this.status = 'stopped'
        this.opts.onLifecycleChange?.()
      }
      return false
    }

    recovery.phase = 'draining'
    let drainOutcome: MidTurnDrainOutcome = 'no_batch'
    if (this.pendingMidTurnMsgs.length > 0) {
      drainOutcome = 'preserved'
      try {
        drainOutcome = await this.drainMidTurnAndOpen({ proc: replacement, lease, recovery })
      } catch (e) {
        logError("session: preserved watchdog queue drain failed", e)
      }
    }
    if (!this.ownsPreservedWatchdogRecovery(recovery, lease)) return false
    if (drainOutcome === 'preserved') {
      this.markPreservedWatchdogRecoveryFailed(recovery, lease)
      if (this.proc === replacement) {
        this.status = 'stopped'
        this.opts.onLifecycleChange?.()
      }
      opts.onStatus?.('❌ thread 已恢复，但保留消息开卡失败')
      return false
    }

    recovery.replacementProc = null
    this.completePreservedWatchdogRecovery(recovery, lease)
    if (!this.currentTurn) this.status = 'idle'
    return true
  }

  /** Start a new Session process from a backend-native fork source(4185808 终态)。
   *  Claude fork 先 precommit pendingLaunch 再 spawn——startup grace 内 daemon
   *  崩溃仍可从磁盘 intent 恢复;失败恢复原 pending,恢复也失败 AggregateError
   *  上抛。复用 start 的 spawn+wire+init。本地守卫叠加(保护线):
   *  hasPreservedWatchdogRecovery 前置拒绝 + lease 归属,await 后复查。 */
  async startForked(
    launch: Extract<ConversationLaunch, { kind: 'fork' }>,
    opts: LifecycleProgressOpts = {},
  ): Promise<boolean> {
    return await this.startForkedLaunch(launch, opts)
  }

  private async startForkedLaunch(
    launch: Extract<ConversationLaunch, { kind: 'fork' }>,
    opts: LifecycleProgressOpts = {},
  ): Promise<boolean> {
    if (this.hasPreservedWatchdogRecovery()) return false
    const lease = this.lifecycleLease('fork', opts)
    if (!this.ownsLifecycle(lease) || this.hasPreservedWatchdogRecovery()) return false
    validateConversationLaunch(launch, this.selectedProvider, this.workDir)
    const previousPending = feishu.getPendingConversationLaunch(this.sessionName)
    const pendingMaterialization: PendingConversationLaunch | null = this.selectedProvider === 'claude'
      ? { launch, previousSessionId: this.lastSessionId }
      : null
    if (pendingMaterialization) {
      // Persist before spawning. A daemon crash during Claude's startup grace
      // must still leave enough intent for the next boot/message to fork the
      // selected source rather than silently starting fresh.
      feishu.setPendingConversationLaunchChecked(this.sessionName, pendingMaterialization)
      this.pendingConversationMaterialization = pendingMaterialization
    }
    const forkLaunch = { lease, launch, previousSessionId: this.lastSessionId }
    this.pendingConversationLaunch = forkLaunch
    try {
      const ok = await this.start({ ...opts, lifecycleLease: lease })
      if (!ok && pendingMaterialization && this.ownsLifecycle(lease)) {
        // 失败恢复原 pending(不留半提交态);失去 lease 时状态归新 owner,不写。
        feishu.setPendingConversationLaunchChecked(this.sessionName, previousPending)
        this.pendingConversationMaterialization = previousPending
      }
      return ok
    } catch (error) {
      if (!pendingMaterialization || !this.ownsLifecycle(lease)) throw error
      try {
        feishu.setPendingConversationLaunchChecked(this.sessionName, previousPending)
        this.pendingConversationMaterialization = previousPending
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `fork start and pending-intent restore failed: ${messageOf(error)}; ${messageOf(restoreError)}`,
        )
      }
      throw error
    } finally {
      if (this.pendingConversationLaunch === forkLaunch) this.pendingConversationLaunch = null
    }
  }

  /** 回滚当前会话:停当前 proc,绑定到显式新 launch 重启(4185808 终态补偿事务)。
   *  分支元数据只在替换后端就绪后 commit;checked 写失败则停替换进程并 restore
   *  旧 resume/分支快照后才上抛。次序红线(陷阱 9):restart 抛出后先停已 attach
   *  的替换进程,**停不掉绝不 restore**——旧 resume id 指回而新 fork 还活着
   *  = 两会话并存冲突。本地守卫叠加(保护线):lease 失效/preserved recovery
   *  出现时事务中止不写状态。 */
  async rollbackTo(
    launch: ConversationLaunch,
    branchState?: {
      anchors: feishu.TurnAnchor[]
      base: ConversationBranchBase
      pendingLaunch?: PendingConversationLaunch | null
    },
    opts: LifecycleProgressOpts = {},
  ): Promise<boolean> {
    return await this.rollbackToLaunch(launch, branchState, opts)
  }

  private async rollbackToLaunch(
    launch: ConversationLaunch,
    branchState: {
      anchors: feishu.TurnAnchor[]
      base: ConversationBranchBase
      pendingLaunch?: PendingConversationLaunch | null
    } | undefined,
    opts: LifecycleProgressOpts = {},
  ): Promise<boolean> {
    if (this.hasPreservedWatchdogRecovery()) return false
    const lease = this.lifecycleLease('back', opts)
    if (!this.ownsLifecycle(lease) || this.hasPreservedWatchdogRecovery()) return false
    validateConversationLaunch(launch, this.selectedProvider, this.workDir)
    const nextBranchState = branchState
      ? {
          anchors: branchState.anchors.slice(),
          base: branchState.base,
          pendingLaunch: branchState.pendingLaunch !== undefined
            ? branchState.pendingLaunch
            : this.selectedProvider === 'claude' && launch.kind === 'fork'
              ? { launch, previousSessionId: this.lastSessionId }
              : null,
        }
      : null
    // 八项快照:proc/lastSessionId/lastSessionRef/anchors/base/pendingLaunch/
    // turnCounter+goal/stats+usage 基线——restore 的完整素材。
    const previousProc = this.proc
    const previousLastSessionId = this.lastSessionId
    const previousLastSessionRef = this.lastSessionRef
    const previousAnchors = feishu.getTurnAnchors(this.sessionName).slice()
    const previousBranchBase: ConversationBranchBase = feishu.getSessionBranchBase(this.sessionName)
    const previousPendingLaunch = feishu.getPendingConversationLaunch(this.sessionName)
    const previousState = {
      codexQuotaWaitLaunch: this.codexQuotaWaitLaunch,
      turnCounter: this.turnCounter,
      currentGoal: this.currentGoal,
      cumStats: { ...this.cumStats },
      lastTurnDelta: this.lastTurnDelta ? { ...this.lastTurnDelta } : null,
      currentTurnUsageBaseline: this.currentTurnUsageBaseline ? { ...this.currentTurnUsageBaseline } : null,
      currentTurnUsageBaselineKnown: this.currentTurnUsageBaselineKnown,
      lastTurnUsage: this.lastTurnUsage ? { ...this.lastTurnUsage } : null,
      usageTotalsSeedUnknown: this.usageTotalsSeedUnknown,
    }
    let invalidatedPreviousResume = false
    const restore = (): void => {
      if (invalidatedPreviousResume) {
        // 挂账 #5:restart 过程已确认旧 id 无 rollout——清空绑定,不绑回幽灵 id。
        this.lastSessionId = null
        this.lastSessionRef = null
        feishu.clearSessionResumeChecked(this.sessionName, 'codex')
      } else {
        this.lastSessionId = previousLastSessionId
        this.lastSessionRef = previousLastSessionRef
        if (previousLastSessionRef) feishu.bindSessionResumeChecked(this.sessionName, previousLastSessionRef)
        else feishu.clearSessionResumeChecked(this.sessionName, this.selectedProvider)
      }
      feishu.replaceTurnAnchors(
        this.sessionName,
        previousAnchors,
        previousBranchBase,
        previousPendingLaunch,
      )
      this.pendingConversationMaterialization = previousPendingLaunch
      this.codexQuotaWaitLaunch = previousState.codexQuotaWaitLaunch
      this.turnCounter = previousState.turnCounter
      this.currentGoal = previousState.currentGoal
      this.cumStats = previousState.cumStats
      this.lastTurnDelta = previousState.lastTurnDelta
      this.currentTurnUsageBaseline = previousState.currentTurnUsageBaseline
      this.currentTurnUsageBaselineKnown = previousState.currentTurnUsageBaselineKnown
      this.lastTurnUsage = previousState.lastTurnUsage
      this.usageTotalsSeedUnknown = previousState.usageTotalsSeedUnknown
    }
    let pendingPrecommitted = false
    if (nextBranchState?.pendingLaunch) {
      // Claude does not emit the forked session id until first input. Commit
      // its launch intent before touching the process so a crash inside the
      // startup grace can be recovered on the next daemon boot.
      feishu.replaceTurnAnchors(
        this.sessionName,
        nextBranchState.anchors,
        nextBranchState.base,
        nextBranchState.pendingLaunch,
      )
      this.pendingConversationMaterialization = nextBranchState.pendingLaunch
      pendingPrecommitted = true
    }
    // fresh 也带 intent(上游同款):restart 的 cancelledPending 只取消「无 intent
    // 的显式 clear/fresh」,rollback 驱动的 fresh 由本事务的 restore 管辖 pending。
    const forkLaunch = { lease, launch, previousSessionId: previousLastSessionId }
    this.pendingConversationLaunch = forkLaunch
    const onResumeInvalidated = (sessionId: string): void => {
      invalidatedPreviousResume = previousLastSessionRef?.provider === 'codex'
        && previousLastSessionRef.sessionId === sessionId
    }
    try {
      let ok: boolean
      try {
        ok = launch.kind === 'fresh'
          ? await this.restart(false, { ...opts, lifecycleLease: lease, onResumeInvalidated })
          : await this.restart(true, {
              ...opts,
              lifecycleLease: lease,
              onResumeInvalidated,
              resumeIdentity: {
                provider: this.selectedProvider,
                threadId: launch.source.sessionId,
              },
            })
      } catch (error) {
        // restart can throw after a replacement has already been attached (for
        // example a ready/status callback failure). Never put the old resume id
        // back while that new fork is still alive(陷阱 9 candidate 判定序逐字)。
        let stopError: unknown = null
        const candidate = this.proc && this.proc !== previousProc ? this.proc : null
        if (candidate) {
          try {
            await this.stop('回滚启动事务失败', { announce: false, lifecycleLease: lease })
          } catch (candidateStopError) {
            stopError = candidateStopError
          }
        }
        const candidateStopped = !candidate || (this.proc !== candidate && !candidate.isAlive())
        if (!candidateStopped && !stopError) {
          stopError = new Error('replacement process stop was not confirmed')
        }
        let restoreError: unknown = null
        // 停成功才 restore;失去 lease/preserved recovery 出现同样不写(守卫叠加)。
        if (candidateStopped && this.ownsLifecycle(lease) && !this.hasPreservedWatchdogRecovery()) {
          try { restore() } catch (stateRestoreError) { restoreError = stateRestoreError }
        }
        const failures = [error, ...(stopError ? [stopError] : []), ...(restoreError ? [restoreError] : [])]
        if (failures.length === 1) throw error
        throw new AggregateError(
          failures,
          `rollback launch and cleanup failed: ${failures.map(messageOf).join('; ')}`,
        )
      }
      if (!this.ownsLifecycle(lease) || this.hasPreservedWatchdogRecovery()) return false
      if (!ok) {
        restore()
        return false
      }
      if (nextBranchState) {
        try {
          if (!pendingPrecommitted) {
            feishu.replaceTurnAnchors(
              this.sessionName,
              nextBranchState.anchors,
              nextBranchState.base,
              nextBranchState.pendingLaunch,
            )
          }
          this.pendingConversationMaterialization = nextBranchState.pendingLaunch
        } catch (commitError) {
          // commit 失败 = 分支元数据没换成:停替换进程 + restore,同型判定序。
          let stopError: unknown = null
          const candidate = this.proc
          try {
            await this.stop('回滚分支状态持久化失败', { announce: false, lifecycleLease: lease })
          } catch (error) {
            stopError = error
          }
          const candidateStopped = !candidate || (this.proc !== candidate && !candidate.isAlive())
          if (!candidateStopped && !stopError) {
            stopError = new Error('replacement process stop was not confirmed')
          }
          let restoreError: unknown = null
          if (candidateStopped && this.ownsLifecycle(lease) && !this.hasPreservedWatchdogRecovery()) {
            try { restore() } catch (error) { restoreError = error }
          }
          const failures = [commitError, ...(stopError ? [stopError] : []), ...(restoreError ? [restoreError] : [])]
          if (failures.length === 1) throw commitError
          throw new AggregateError(
            failures,
            `rollback branch commit failed: ${failures.map(messageOf).join('; ')}`,
          )
        }
      }
      return ok
    } finally {
      if (this.pendingConversationLaunch === forkLaunch) this.pendingConversationLaunch = null
    }
  }

  /** daemon 解散临时群(bye)时调:从 Session.all registry 移除,避免长期运行的 daemon
   *  因临时群不断建/散而累积孤立 Session 实例(sessions Map 已 delete,但 static all 不会)。 */
  dispose(): void {
    this.modelPanelRefreshEpoch++
    const lease = this.beginLifecycle('dispose')
    this.disposed = true
    this.lifecycleOwner = lease
    const pendingProc = this.pendingSpawnOwnership?.proc ?? null
    if (this.proc === pendingProc) this.proc = null
    this.pendingSpawnOwnership = null
    this.clearWatchdogRuntime('dispose')
    this.toolFailureLoopAction = null
    this.clearToolFailureLoop()
    this.discardPreservedWatchdogRecovery('dispose')
    this.discardQueuedHumanWork('dispose')
    this.status = 'stopped'
    Session.all.delete(this)
    if (pendingProc?.isAlive()) void pendingProc.kill(1_000).catch(() => {})
  }

  /** Clean result 时记 backend-native checkpoint + 用户输入预览 + 文件变更记录。
   *  fk/bk 靠它列"用户输入前的分界点";bk 回滚说明靠其中的 writes。(4185808 终态:
   *  三重归属校验 + materialization 未确认入延迟队列 —— 挂账 #3/陷阱 6) */
  private recordTurnAnchor(checkpoint: ConversationCheckpoint | null | undefined): string | null {
    const proc = this.proc
    if (!proc?.sessionId || !checkpoint) return null
    if (
      checkpoint.provider !== proc.provider
      || checkpoint.source.sessionId !== proc.sessionId
      || checkpoint.source.cwd !== this.workDir
    ) {
      const message = `拒绝了与当前会话不匹配的 checkpoint provider=${checkpoint.provider} source=${checkpoint.source.sessionId}`
      logDiagnostic('session: checkpoint ownership mismatch')
      this.lastTurnUserPreview = ''
      return message
    }
    const anchor: feishu.TurnAnchor = {
      checkpoint,
      preview: this.lastTurnUserPreview.slice(0, 80),
      ts: Date.now(),
      writes: this.collectTurnWrites(),
    }
    this.lastTurnUserPreview = ''
    if (proc.provider === 'codex' && proc.isConversationResumable?.() !== true) {
      const pendingForProc = this.pendingCodexTurnAnchors.filter(pending => pending.proc === proc).length
      if (pendingForProc >= 64) {
        const message = 'Codex rollout 长期未确认，延迟 checkpoint 队列已满'
        logDiagnostic('session: checkpoint confirmation queue exhausted')
        return message
      }
      this.pendingCodexTurnAnchors.push({ proc, anchor })
      return null
    }
    return this.appendTurnAnchor(anchor)
  }

  private appendTurnAnchor(anchor: feishu.TurnAnchor): string | null {
    try {
      feishu.appendTurnAnchorChecked(this.sessionName, anchor)
      return null
    } catch (error) {
      const message = `分叉 checkpoint 持久化失败: ${messageOf(error)}`
      logError('session: checkpoint persistence failed', error)
      return message
    }
  }

  private flushPendingCodexTurnAnchors(proc: AgentProcess): string | null {
    let failure: string | null = null
    const remaining: typeof this.pendingCodexTurnAnchors = []
    for (const pending of this.pendingCodexTurnAnchors) {
      if (pending.proc !== proc || failure) {
        remaining.push(pending)
        continue
      }
      failure = this.appendTurnAnchor(pending.anchor)
      if (failure) remaining.push(pending)
    }
    this.pendingCodexTurnAnchors = remaining
    return failure
  }

  private discardPendingCodexTurnAnchors(proc: AgentProcess, _reason: string): void {
    if (proc.provider !== 'codex') return
    this.pendingCodexTurnAnchors = this.pendingCodexTurnAnchors.filter(pending => pending.proc !== proc)
  }

  private collectTurnWrites(): feishu.TurnWrite[] {
    const turn = this.currentTurn
    if (!turn) return []
    const out: feishu.TurnWrite[] = []
    for (const t of turn.toolByUseId.values()) {
      out.push(...cards.writeLogEntriesFromToolInput(t.name, t.input))
    }
    return out
  }

  worktreeProjectName(): string {
    return sessionWorktree.worktreeProjectName(this)
  }

  worktreeProjectDir(): string {
    return sessionWorktree.worktreeProjectDir(this)
  }

  private spawnDeveloperInstructions(): string {
    return sessionWorktree.spawnDeveloperInstructions(this, this.currentProvider())
  }

  delegatedAgentDeveloperInstructions(provider: AgentProvider): string {
    return sessionWorktree.delegatedAgentDeveloperInstructions(this, provider)
  }

  worktreeInstructionLoadedNotice(): string | null {
    return sessionWorktree.worktreeInstructionLoadedNotice(this)
  }

  withWorktreeInstructionNotice(text: string): string {
    return sessionWorktree.withWorktreeInstructionNotice(this, text)
  }

  worktreeExtraInstruction(): string | null {
    return sessionWorktree.worktreeExtraInstruction(this)
  }

  runWorktreeCommand(arg: string, userOpenId: string): Promise<void> {
    return sessionWorktree.runWorktreeCommand(this, arg, userOpenId)
  }

  showWorktrees(): Promise<void> {
    return sessionWorktree.showWorktrees(this)
  }

  showTasklistPanel(): Promise<void> {
    return sessionTasklist.showTasklistPanel(this)
  }

  showAgentIdentityPanel(userOpenId = ''): Promise<void> {
    return sessionAgentIdentities.showAgentIdentityPanel(this, userOpenId)
  }

  onAgentIdentityPage(panelId: string, page: unknown, userOpenId: string): ModelActionResult {
    return sessionAgentIdentities.onAgentIdentityPage(panelId, page, userOpenId)
  }

  onTasklistEnable(): Promise<TasklistActionResult> {
    return sessionTasklist.onTasklistEnable(this)
  }

  onTasklistDeletePrompt(guidRaw: string): TasklistActionResult {
    return sessionTasklist.onTasklistDeletePrompt(this, guidRaw)
  }

  onTasklistDeleteConfirm(guidRaw: string): Promise<TasklistActionResult> {
    return sessionTasklist.onTasklistDeleteConfirm(this, guidRaw)
  }

  showGsdPanel(): Promise<void> {
    return sessionGsd.showGsdPanel(this)
  }

  onGsdRefresh(taskSlug: string, panelGen: string | null = null): Promise<GsdActionResult> {
    return sessionGsd.onGsdRefresh(this, taskSlug, panelGen)
  }

  onGsdSelect(taskSlug: string, panelGen: string | null = null): Promise<GsdActionResult> {
    return sessionGsd.onGsdSelect(this, taskSlug, panelGen)
  }

  onGsdContinue(taskSlug: string, panelGen: string | null = null): Promise<GsdActionResult> {
    return sessionGsd.onGsdContinue(this, taskSlug, panelGen)
  }

  onGsdPause(taskSlug: string, panelGen: string | null = null): Promise<GsdActionResult> {
    return sessionGsd.onGsdPause(this, taskSlug, panelGen)
  }

  onGsdComplete(taskSlug: string, panelGen: string | null = null): Promise<GsdActionResult> {
    return sessionGsd.onGsdComplete(this, taskSlug, panelGen)
  }

  onGsdNewPrompt(taskSlug: string, panelGen: string | null = null): Promise<GsdActionResult> {
    return sessionGsd.onGsdNewPrompt(this, taskSlug, panelGen)
  }

  maybeConsumeGsdTaskName(text: string): Promise<boolean> {
    return sessionGsd.maybeConsumeGsdTaskName(this, text)
  }

  refreshGsdPanelIfPresent(): Promise<void> {
    return sessionGsd.refreshGsdPanelIfPresent(this)
  }

  runCompactCommand(): Promise<void> {
    return sessionCompact.runCompactCommand(this)
  }

  showModelPanel(): Promise<void> {
    return sessionModel.showModelPanel(this)
  }

  finishModelSettingsChange(change: sessionModel.ModelSettingsChange, outcome: sessionModel.ModelSettingsOutcome): Promise<ModelActionResult> {
    return this.runLifecycle('model-settings-complete', () => sessionModel.finishModelSettingsChange(this, change, outcome))
  }

  closeModelSettingsChanges(): void {
    this.modelPanelRefreshEpoch++
    this.modelSettingsChangesClosed = true
    this.modelSettingsChange?.cancel('daemon 正在停止')
  }

  private modelSettingsBlockReason(): string | null {
    const change = this.modelSettingsChange
    if (!change || change.proc !== this.proc || !change.proc.isAlive()) return null
    return change.phase === 'pending'
      ? '模型设置仍在等待后端确认，请等待结果；取消切换请发 kill 或 restart。'
      : change.error ?? '模型设置未确认，请重新发送 md 选择模型。'
  }

  resumeInputAfterModelSettingsChange(): void {
    void this.drainMidTurnAndOpen().catch(async error => {
      const message = `模型设置已完成，但排队输入提交失败：${messageOf(error)}`
      logError('session: queued input submission failed', error)
      await feishu.sendTextRaw(this.chatId, `❌ ${message}`)
    })
  }

  onModelSelect(modelRaw: string, panelIdRaw = '', userOpenId = '', actionValue: any = null): Promise<ModelActionResult> {
    return this.runLifecycle('model-select', () =>
      sessionModel.onModelSelect(this, modelRaw, panelIdRaw, userOpenId, actionValue)
    )
  }

  onModelEffortSelect(modelRaw: string, effortRaw: string, panelIdRaw = '', userOpenId = '', providerRaw = ''): Promise<ModelActionResult> {
    // 合并调和(取舍):上游把 model-effort-select 挂进 runLifecycle(与 stop/
    // restart/user-message 串行);本地冻结用例 'rejects a second model selection
    // while the first idle rebuild is pending' 要求首个 idle 重建在途时第二次
    // 选择立即被拒 —— 排队到队尾会让第二次在第一个完成后照常执行(双提交本意
    // 是拒绝),且该用例 await second 会卡在队尾死等。折中:已有在途 model
    // switch 事务时绕过队列直入 session-model(其 modelSwitchPending 门 944 行
    // 返回同一 busy 文案),其余情况照常排队(上游 mutex 次序不变)。
    if (this.modelSwitchPending) {
      return sessionModel.onModelEffortSelect(this, modelRaw, effortRaw, panelIdRaw, userOpenId, providerRaw)
    }
    return this.runLifecycle('model-effort-select', () =>
      sessionModel.onModelEffortSelect(this, modelRaw, effortRaw, panelIdRaw, userOpenId, providerRaw)
    )
  }
  onProviderSelect(sourceIdRaw: string, panelIdRaw = '', refresh = false): Promise<ModelActionResult> {
    return sessionModel.onProviderSelect(this, sourceIdRaw, panelIdRaw, refresh)
  }
  onModelPage(panelId: string, sourceId: string, page: number): Promise<ModelActionResult> {
    return sessionModel.onModelPage(this, panelId, sourceId, page)
  }
  onModelAddOpen(panelId: string, sourceId: string, refresh = false): Promise<ModelActionResult> {
    return sessionModel.onModelAddOpen(this, panelId, sourceId, refresh)
  }
  onModelListEdit(panelId: string, sourceId: string, model: string, action: 'add' | 'remove' | 'delete'): Promise<ModelActionResult> {
    return this.runLifecycle('model-list-edit', () => sessionModel.onModelListEdit(this, panelId, sourceId, model, action))
  }
  onModelPanelCancel(panelIdRaw = ''): Promise<ModelActionResult> {
    return sessionModel.onModelPanelCancel(this, panelIdRaw)
  }
  onModelCustomPrompt(sourceIdRaw: string, panelIdRaw: string, cardMessageId = ''): Promise<ModelActionResult> {
    return sessionModel.onModelCustomPrompt(this, sourceIdRaw, panelIdRaw, cardMessageId)
  }
  consumeModelCustomMessage(text: string, user: string): Promise<boolean> {
    return sessionModel.consumeModelCustomMessage(this, text, user)
  }

  onWorktreeDisband(slugRaw: string): Promise<WorktreeActionResult> {
    return sessionWorktree.onWorktreeDisband(this, slugRaw)
  }

  // ── 临时会话 / fork / back / rs 恢复(委托 session-temp)──
  showForkList(userOpenId = ''): Promise<void> { return sessionTemp.showForkList(this, userOpenId) }
  showBackList(userOpenId = ''): Promise<void> { return sessionTemp.showBackList(this, userOpenId) }
  showResumeList(userOpenId = ''): Promise<void> { return sessionTemp.showResumeList(this, userOpenId) }
  runBtwCommand(userOpenId: string): Promise<void> { return sessionTemp.runBtwCommand(this, userOpenId) }
  runByeCommand(): Promise<void> { return sessionTemp.runByeCommand(this) }
  onForkSelect(panelId: string, choiceId: string, userOpenId = ''): Promise<sessionTemp.TempSelectionResult> { return sessionTemp.onForkSelect(this, panelId, choiceId, userOpenId) }
  onBackSelect(panelId: string, choiceId: string, userOpenId = ''): Promise<sessionTemp.TempSelectionResult> { return sessionTemp.onBackSelect(this, panelId, choiceId, userOpenId) }
  onResumeSelect(panelId: string, choiceId: string, userOpenId = ''): Promise<sessionTemp.TempSelectionResult> { return sessionTemp.onResumeSelect(this, panelId, choiceId, userOpenId) }

  /** Run a bare-text control command (`hi`, `stop`, `kill`, `restart`, `clear`, `compact`, `model`, `task`)
   * plus their two-letter aliases where applicable.
   * Returns true if the command was consumed (don't forward to Codex). */
  runCommand(raw: string, userOpenId = '', messageId?: string): Promise<boolean> {
    return sessionCommands.runCommand(this, raw, userOpenId, messageId)
  }

  /** Build the hi-panel data snapshot for this session.
   *
   * Passing `usage=undefined` paints the `_加载中…_` placeholder — the
   * caller is responsible for the async patch if the panel was sent. */
  async buildConsoleOpts(
    usage: UsageSnapshot | undefined,
    glmUsage?: GlmUsageSnapshot,
    providerUsage?: ClaudeProviderUsageSnapshot,
  ): Promise<cards.ConsoleOpts> {
    const runtime = this.runtimeModelSelection()
    const sysinfo = await readSysInfo()
    return {
      sessionName: this.sessionName,
      status: this.status,
      provider: runtime.provider,
      model: runtime.model ?? undefined,
      effort: runtime.effort ?? 'MISS',
      usageSource: runtime.usageSource,
      worktreeInstructionNotice: this.worktreeInstructionLoadedNotice(),
      peers: [...Session.all]
        .filter(s => s.isRunning())
        .map(s => ({
          ...s.peerSnapshot(),
          isCurrent: s === this,
        })),
      usage,
      glmUsage,
      providerUsage,
      accountUsages: await readAllAccountUsage(),
      sysinfo,
    }
  }

  async buildConsoleCard(usage: UsageSnapshot | undefined): Promise<object> {
    return cards.consoleCard(await this.buildConsoleOpts(usage))
  }

  private async patchConsoleUsage(cardId: string, snapshot: cards.ConsoleOpts): Promise<void> {
    // The card header and this quota row must come from the same runtime
    // selection. Clone the creation-time snapshot instead of re-reading the
    // mutable session after send/id-convert/network awaits.
    const opts: cards.ConsoleOpts = {
      ...snapshot,
      usage: undefined,
      glmUsage: undefined,
      providerUsage: undefined,
    }
    // 合并调和(取舍):snapshot 缺席账户聚合数据时才即时补读(上游 patchConsoleUsage
    // 无条件重读的形态;本地调用方经 buildConsoleOpts 冻结快照,已含 accountUsages,
    // 不会走到这里)。失败按上游口径落一条 error 行,面板不落回 markdown。
    if (opts.accountUsages === undefined) {
      try { opts.accountUsages = await readAllAccountUsage() }
      catch (error) {
        const reason = messageOf(error)
        logError("session: console usage MISS", error)
        opts.accountUsages = [{ id: 'error', label: '额度', usage: { state: 'network', windows: [], reason } }]
      }
    }
    if (opts.usageSource === 'glm') {
      opts.glmUsage = await readGlmUsage()
    } else if (opts.usageSource === 'codex') {
      opts.usage = await readUsage(opts.model)
    } else if (opts.usageSource === 'provider' && opts.model) {
      // DSH 与 claude 的 provider 余额是两个互不相读的凭据面(D-08 双轨):
      // dsh 读 `[deepseek-harness]` 并打 DeepSeek /user/balance,绝不落到
      // claude profile 查询(那会拿 claude:<key> 的 token 去问别的渠道)。
      if (opts.provider === 'dsh') {
        const section = config.deepseek_harness
        const displayName = section?.display?.trim() || DSH_DISPLAY_NAME
        const apiKey = section?.api_key?.trim() ?? ''
        const baseUrl = section?.base_url?.trim() || DSH_DEFAULT_BASE_URL
        // 合并调和(取舍):聚合面板在场(上游「全部账号额度」路线,见
        // cards/console.ts 双源注释)时 dsh 余额补进面板行 —— 本地
        // `[deepseek-harness]` 段不进 token source 注册表,聚合读数看不到它;
        // 面板行快照走 unified 同源查询(fetchDeepseekBalance 即注册表 readUsage
        // 的实现,同端点同凭据)。markdown 兼容层(accountUsages 缺席的旧调用方)
        // 保留本地 providerUsage 行。两条路线各自只查一次 /user/balance。
        if (opts.accountUsages !== undefined) {
          if (apiKey && !opts.accountUsages.some(row => row.id === 'deepseek-harness' || row.id === 'deepseek')) {
            opts.accountUsages = [...opts.accountUsages, {
              id: 'deepseek-harness', label: displayName,
              usage: await fetchDeepseekBalance(baseUrl, apiKey),
            }]
          }
        } else {
          opts.providerUsage = apiKey
            ? await readDeepseekBalance(baseUrl, apiKey, displayName)
            : { state: 'no_credentials', providerName: displayName }
        }
      } else {
        opts.providerUsage = await readClaudeProviderUsage(opts.model)
      }
    }
    let failure: cardkit.CardWriteFailure | undefined
    const landed = await cardkit.replaceElementChecked(
      cardId,
      cards.ELEMENTS.consoleUsage,
      cards.consoleUsageElement(opts),
      { notifyCardFailure: false, onFailure: detail => { failure = detail } },
    )
    if (!landed) throw new Error(`console usage element replace rejected: ${formatFeishuError(failure)}`)
  }

  /** Run a one-shot mutation on a static card, then close any streaming mode
   * that a 300309 recovery may have reopened. Only tombstone local state once
   * the close is confirmed; a failed close remains available for diagnosis or
   * a later repair instead of becoming an unwritable streaming orphan. */
  private async mutateStaticCard(
    cardId: string,
    label: string,
    mutation: () => Promise<void>,
  ): Promise<boolean> {
    let mutationLanded = true
    const failures: string[] = []
    try {
      await mutation()
    } catch (e) {
      mutationLanded = false
      failures.push(messageOf(e))
      logError('session: mutation failed', e)
    }
    let closed = false
    try {
      closed = await cardkit.patchSettingsChecked(cardId, { config: { streaming_mode: false } }, failure => {
        failures.push(formatFeishuError(failure))
      })
    } catch (e) {
      failures.push(formatFeishuError(e))
      logError('session: streaming-off failed', e)
    }
    if (!mutationLanded || !closed) {
      await feishu.sendTextRaw(this.chatId, `⚠️ 卡片更新失败 (${label})。\n${failures.join('\n') || formatFeishuError(undefined)}`)
      return false
    }
    try { await cardkit.dispose(cardId) }
    catch (e) {
      logError('session: dispose failed', e)
      return false
    }
    return mutationLanded
  }

  private patchConsoleUsageLater(cardId: string, snapshot: cards.ConsoleOpts): void {
    void (async () => {
      try {
        await this.patchConsoleUsage(cardId, snapshot)
      } catch (e) {
        logError("session: consoleUsage patch failed", e)
      } finally {
        try { await cardkit.dispose(cardId) }
        catch (e) { logError("session: console card dispose failed", e) }
      }
    })()
  }

  async replaceStatusCardWithConsole(handle: StatusCardHandle, finalStatus: string): Promise<void> {
    handle.timer.stop()
    const elapsed = handle.timer.elapsedSec()
    const consoleOpts = await this.buildConsoleOpts(undefined)
    await cardkit.flush(handle.cardId)
    const failures: cardkit.CardWriteFailure[] = []
    const onFailure = (failure: cardkit.CardWriteFailure) => { failures.push(failure) }
    const currentModelLanded = await cardkit.replaceElementChecked(
      handle.cardId,
      cards.ELEMENTS.footer,
      cards.consoleCurrentModelElement(consoleOpts, cards.ELEMENTS.footer),
      { onFailure },
    )
    const mainLanded = await cardkit.addElementChecked(
      handle.cardId,
      cards.consoleMainElement(consoleOpts),
      { type: 'insert_after', targetElementId: cards.ELEMENTS.footer, onFailure },
    )
    const hostLanded = await cardkit.addElementChecked(
      handle.cardId,
      cards.consoleHostElement(consoleOpts.sysinfo),
      { type: 'insert_after', targetElementId: cards.ELEMENTS.consoleProjects, onFailure },
    )
    const usageLanded = await cardkit.addElementChecked(
      handle.cardId,
      cards.consoleUsageElement(consoleOpts),
      { type: 'insert_after', targetElementId: cards.ELEMENTS.consoleHost, onFailure },
    )
    if (!currentModelLanded || !mainLanded || !hostLanded || !usageLanded) {
      await feishu.sendTextRaw(this.chatId, `⚠️ 控制台卡片结构写入失败，请重新发送 hi。\n${cardFailureDetails(failures)}`)
      await this.mutateStaticCard(handle.cardId, 'console structure', async () => {})
      return
    }
    cardkit.cancelSummary(handle.cardId)
    const closed = await cardkit.patchSettingsChecked(handle.cardId, cards.streamingOffSettings({
      durationSec: elapsed,
      suffix: finalStatus,
    }), onFailure)
    if (!closed) await feishu.sendTextRaw(this.chatId, `⚠️ 控制台卡片状态写入失败。\n${cardFailureDetails(failures)}`)
    this.patchConsoleUsageLater(handle.cardId, consoleOpts)
  }

  async showConsole(): Promise<void> {
    // Initial paint without usage → cards.ts renders the
    // `_加载中…_` placeholder in the consoleUsage element. We patch
    // it in below once readUsage() resolves; not worth blocking the
    // panel on the Codex account/rate-limit round trip.
    const consoleOpts = await this.buildConsoleOpts(undefined)
    const card = cards.consoleCard(consoleOpts)
    const messageId = await feishu.sendCard(this.chatId, card)
    if (!messageId) return
    // Patch the usage element asynchronously so the rest of the panel
    // stays responsive. We don't await; failures are logged and the
    // placeholder stays visible (no fallback fabrication).
    void (async () => {
      let cardId = ''
      try {
        cardId = await cardkit.convertMessageToCard(messageId)
        await this.patchConsoleUsage(cardId, consoleOpts)
      } catch (e) {
        logError("session: consoleUsage patch failed", e)
      } finally {
        if (cardId) {
          try { await cardkit.dispose(cardId) }
          catch (e) { logError("session: console card dispose failed", e) }
        }
      }
    })()
  }

  beginTurnInterrupt(
    source: TurnInterruptSource,
    watchdogCtx: WatchdogTurnContext | null = null,
  ): TurnInterruptContext | null {
    // 合并收口:上游 stop 命令经 interrupt() 作废 steering 世代 —— 在途
    // steerUserText 回执(哪怕是 rejected)不得再复活已随 stop 丢弃的追加
    // 消息(否则 finally 的 drainMidTurnAndOpen 会为它们重开新轮)。
    // 合并后 stop 命令(frozen session-commands.ts)改走本地
    // beginTurnInterrupt('user') 入口,'user' 即上游 interrupt() 的
    // stop/用户中断语义位;在此补齐同一作废(upper interrupt() 同款四连)。
    if (source === 'user') {
      this.steeringGeneration++
      this.submittedSteering.clear()
      this.steeringBoundary?.start()
      this.steeringBoundary = null
    }
    const proc = this.proc
    const turn = this.currentTurn
    if (!proc) return null
    const watchdogSource = source === 'watchdog_recover' || source === 'watchdog_exhausted'
    if (
      watchdogSource &&
      (!watchdogCtx || !turn || !watchdogCtx.threadId || !watchdogCtx.turnId || !this.watchdogContextIsCurrent(watchdogCtx))
    ) return null
    if (this.activeTurnInterrupt) {
      const existing = this.activeTurnInterrupt
      if (existing.proc !== proc || existing.turn !== turn) return null
      if (existing.source === source) return existing
      if (source === 'user') {
        existing.source = 'user'
        logDiagnostic("session: turn interrupt ownership")
        return existing
      }
      return null
    }
    let resolve!: (outcome: TurnSettlement) => void
    const promise = new Promise<TurnSettlement>(done => { resolve = done })
    const context: TurnInterruptContext = {
      source,
      proc,
      turn,
      threadId: turn?.backendThreadId ?? proc.sessionId,
      turnId: turn?.backendTurnId ?? null,
      promise,
      resolve,
      settled: false,
    }
    this.activeTurnInterrupt = context
    logDiagnostic("session: turn interrupt")
    proc.sendInterrupt()
    return context
  }

  settleTurnInterrupt(proc: AgentProcess, type: 'result' | 'exit'): TurnInterruptContext | null {
    const context = this.activeTurnInterrupt
    if (!context || context.settled || context.proc !== proc) return null
    const watchdogSource = context.source === 'watchdog_recover' || context.source === 'watchdog_exhausted'
    if (context.source === 'user') {
      if (this.proc !== proc || (this.currentTurn && this.currentTurn !== context.turn)) return null
    } else if (this.proc !== proc || this.currentTurn !== context.turn) {
      return null
    }
    if (context.threadId && proc.sessionId !== context.threadId) return null
    if (context.turn) {
      if (watchdogSource && context.threadId && context.turn.backendThreadId !== context.threadId) return null
      if (!watchdogSource && context.threadId && context.turn.backendThreadId && context.turn.backendThreadId !== context.threadId) return null
      if (context.turnId && context.turn.backendTurnId !== context.turnId) return null
    }
    context.settled = true
    this.activeTurnInterrupt = null
    context.resolve({ type, proc, turn: context.turn })
    return context
  }

  cancelTurnInterrupt(reason: string): TurnInterruptContext | null {
    const context = this.activeTurnInterrupt
    if (!context || context.settled) return null
    context.settled = true
    this.activeTurnInterrupt = null
    context.resolve({ type: 'cancelled', reason })
    return context
  }

  async waitForTurnSettlement(
    context: TurnInterruptContext,
    graceMs: number,
  ): Promise<TurnSettlement | { type: 'timeout' }> {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        context.promise,
        new Promise<{ type: 'timeout' }>(resolve => {
          timer = setTimeout(() => resolve({ type: 'timeout' }), Math.max(0, graceMs))
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private beginHumanDelivery(
    proc: AgentProcess,
    batch: HumanBatchMessage[],
    turn: TurnState | null,
  ): PendingHumanDelivery | null {
    if (this.pendingHumanDelivery) {
      this.pendingMidTurnMsgs = [...batch, ...this.pendingMidTurnMsgs]
      return null
    }
    this.restoredHumanDelivery = null
    const reactions = new Map<string, string>()
    for (const message of batch) {
      if (!message.msgId || !this.pendingReactionIds.has(message.msgId)) continue
      reactions.set(message.msgId, this.pendingReactionIds.get(message.msgId) ?? '')
      this.pendingReactionIds.delete(message.msgId)
    }
    const context: PendingHumanDelivery = {
      proc,
      batch,
      reactions,
      dispatch: null,
      openingOwner: this.openingTurnOwner,
      turn,
      turnId: null,
      state: 'pending',
    }
    this.pendingHumanDelivery = context
    return context
  }

  private humanDeliveryStillOwnsTurn(context: PendingHumanDelivery): boolean {
    if (this.proc !== context.proc) return false
    if (context.dispatch && context.proc.sessionId !== context.dispatch.threadId) return false
    if (context.openingOwner !== this.openingTurnOwner) return false
    if (context.turn) return this.currentTurn === context.turn
    // 认领了本投递的开卡窗口仍在进行中(bootstrap init 开卡):
    // openTurnCard 可能已装好 currentTurn 但尚未 bindHumanDeliveryTurn,
    // 窗口没结束前不算易主。
    if (context.openingOwner !== null) return true
    return this.currentTurn === null
  }

  private commitHumanDelivery(context: PendingHumanDelivery): boolean {
    if (this.pendingHumanDelivery !== context || context.state !== 'pending') return false
    context.state = 'acked'
    this.pendingHumanDelivery = null
    this.restoredHumanDelivery = null
    this.ackedHumanDelivery = context
    if (this.humanDeliveryStillOwnsTurn(context)) {
      this.pendingUserMessageCount++
      for (const [msgId, reactionId] of context.reactions) {
        this.currentBatchReactionIds.set(msgId, reactionId)
      }
      this.status = 'working'
    } else {
      for (const [msgId, reactionId] of context.reactions) {
        if (reactionId) void feishu.deleteReaction(msgId, reactionId)
      }
    }
    return true
  }

  interrupt(): void {
    this.steeringGeneration++
    this.submittedSteering.clear()
    this.steeringBoundary?.start()
    this.steeringBoundary = null
    if (!this.proc) return
    // Local translation has no native result to acknowledge this stop. Do not
    // consume the next actual task's result as a stale interrupt receipt.
    if (processUsesClaudeTranslation(this.proc) && this.proc.hasPendingNativeTurn?.() === false) {
      this.cancelTurnInterrupt('local translation interrupted before native input')
      this.userInterrupted = false
    }
    this.proc.sendInterrupt()
  }

  private disabledClaudeSourceMessage(sourceId = this.selectedTokenSourceId): string | null {
    const source = this.tokenSource(sourceId)
    return source?.kind === 'claude-subscription' && !source.enabled
      ? source.modelCatalogState?.error ?? 'Claude Code 订阅未启用，请发送 claude-sub 查看状态'
      : null
  }

  /** Register the SDK-input claim before the write. AgentProcess implementations
   * may emit init/turn_started synchronously in tests or immediately on their
   * read loop, so incrementing after sendUserText leaves a boundary race. */
  async sendClaimedUserText(proc: AgentProcess, text: string): Promise<boolean> {
    const settingsBlocked = this.modelSettingsBlockReason()
    if (settingsBlocked) throw new Error(settingsBlocked)
    // 其他群可能在开卡期间关闭全局开关；真正送入进程前再检查一次。
    const blocked = this.disabledClaudeSourceMessage(proc.tokenSourceId)
    if (blocked) {
      const message = `❌ ${blocked}。消息未送给 Agent，请启用后重发或通过 md 切换来源。`
      this.pendingTurnInputs = []
      if (this.currentTurn) await this.closeTurnCard(message)
      else await feishu.sendText(this.chatId, message)
      this.status = 'idle'
      return false
    }
    this.pendingUserMessageCount++
    try {
      proc.sendUserText(text, [])
    } catch (error) {
      this.pendingUserMessageCount = Math.max(0, this.pendingUserMessageCount - 1)
      throw error
    }
    return true
  }

  private restoreHumanDelivery(context: PendingHumanDelivery): boolean {
    if (this.pendingHumanDelivery !== context || context.state !== 'pending') return false
    context.state = 'restored'
    this.pendingHumanDelivery = null
    this.restoredHumanDelivery = context
    if (this.ackedHumanDelivery === context) this.ackedHumanDelivery = null
    this.pendingMidTurnMsgs = [...context.batch, ...this.pendingMidTurnMsgs]
    for (const [msgId, capturedReactionId] of context.reactions) {
      if (!this.pendingReactionIds.has(msgId)) {
        this.pendingReactionIds.set(msgId, capturedReactionId)
      }
    }
    return true
  }

  private async rejectHumanDelivery(
    context: PendingHumanDelivery,
  ): Promise<Exclude<MidTurnDrainOutcome, 'no_batch'>> {
    this.restoreHumanDelivery(context)
    const turn = context.turn
    if (turn && this.currentTurn === turn) {
      const ownsProcess = this.proc === context.proc
      const closing = this.closeTurnCard('⚠️ 消息未被后端接受，已保留待重试', {
        forcePush: true,
        preservePendingReactions: true,
      })
      if (ownsProcess && this.proc === context.proc) this.status = 'idle'
      await closing
    }
    return this.humanDeliveryOutcome(context)
  }

  private humanDeliveryOutcome(context: PendingHumanDelivery): Exclude<MidTurnDrainOutcome, 'no_batch'> {
    return context.state === 'acked' ? 'committed' : 'preserved'
  }

  private async dispatchHumanBatch(
    context: PendingHumanDelivery,
  ): Promise<Exclude<MidTurnDrainOutcome, 'no_batch'>> {
    if (this.pendingHumanDelivery !== context || context.state !== 'pending') {
      return this.humanDeliveryOutcome(context)
    }
    // 上游 sendClaimedUserText「真正送入进程前再检查一次」的合并落点(本地投递
    // 收据机为最终形态,开卡统一先于投递):开卡窗口里其他群可能关掉 Claude
    // 订阅/全局开关,此时必须拒投 —— 关卡告知并清空本批,绝不让文本进进程。
    // 不 restash 重投:消息未送达已在关卡文案里明示,等用户重发。
    const subscriptionBlocked = this.disabledClaudeSourceMessage(context.proc.tokenSourceId)
    if (subscriptionBlocked) {
      logDiagnostic("session: human dispatch blocked")
      const message = `❌ ${subscriptionBlocked}。消息未送给 Agent，请启用后重发或通过 md 切换来源。`
      this.pendingTurnInputs = []
      context.state = 'refused'
      if (this.pendingHumanDelivery === context) this.pendingHumanDelivery = null
      if (this.ackedHumanDelivery === context) this.ackedHumanDelivery = null
      for (const [msgId, reactionId] of context.reactions) {
        if (reactionId) void feishu.deleteReaction(msgId, reactionId)
      }
      context.reactions.clear()
      if (this.currentTurn) await this.closeTurnCard(message)
      else await feishu.sendText(this.chatId, message)
      this.status = 'idle'
      return this.humanDeliveryOutcome(context)
    }
    const merged = context.batch.map(message => message.wireText).join('\n\n')
    let dispatch: UserTextDispatch
    try {
      dispatch = context.proc.sendUserText(merged, [])
    } catch (cause) {

      logDiagnostic("session: human dispatch threw")
      return await this.rejectHumanDelivery(context)
    }
    if (this.pendingHumanDelivery !== context || context.state !== 'pending') {
      return this.humanDeliveryOutcome(context)
    }
    if (dispatch.kind === 'rejected') {
      logDiagnostic("session: human dispatch rejected")
      return await this.rejectHumanDelivery(context)
    }
    if (dispatch.kind === 'queued') {
      // claude 与 dsh 都是 fire-and-forget 投递(无 settlement):
      // 所有权/存活校验后即 commit。
      if (context.proc.provider !== 'claude' && context.proc.provider !== 'dsh') {
        logDiagnostic("session: reject mismatched queued dispatch from")
        return await this.rejectHumanDelivery(context)
      } else if (!this.humanDeliveryStillOwnsTurn(context)) {
        this.restoreHumanDelivery(context)
      } else {
        this.commitHumanDelivery(context)
      }
      return this.humanDeliveryOutcome(context)
    }
    context.dispatch = dispatch
    // threadId 为 null 只允许出现在真正的 pre-init 投递上(进程线程
    // 也还没建);其余场景必须与进程主线程一致。
    if (
      context.proc.provider !== 'codex' ||
      (dispatch.threadId === null
        ? context.proc.sessionId !== null
        : !!context.proc.sessionId && context.proc.sessionId !== dispatch.threadId)
    ) {
      logDiagnostic("session: reject mismatched Codex human dispatch")
      return await this.rejectHumanDelivery(context)
    }
    let settlement
    try {
      settlement = await dispatch.settlement
    } catch (cause) {
      logError("session: Codex human receipt unexpectedly rejected", cause)
      return await this.rejectHumanDelivery(context)
    }
    if (this.pendingHumanDelivery !== context || context.state !== 'pending') {
      return this.humanDeliveryOutcome(context)
    }
    if (
      settlement.deliveryId !== dispatch.deliveryId ||
      settlement.threadId !== dispatch.threadId
    ) {
      logDiagnostic("session: ignore mismatched Codex human receipt delivery")
      return await this.rejectHumanDelivery(context)
    }
    if (settlement.kind === 'rejected') {
      return await this.rejectHumanDelivery(context)
    }
    if (!this.humanDeliveryStillOwnsTurn(context)) {
      // 刻意的 at-least-once 取舍:ACK 到达时 turn/opening 所有权已易主
      // (进程与线程可能仍一致),后端也许已接受这份输入,但新 owner 的
      // 状态不能被旧回执改写 —— 宁可保留待重投(可能重复),不可静默丢失
      // 或污染 replacement。不要"修复"成 ACK 即提交。
      logDiagnostic("session: restore Codex human delivery after ACK lost its turn")
      this.restoreHumanDelivery(context)
      return this.humanDeliveryOutcome(context)
    }
    if (
      settlement.turnId &&
      context.turn?.backendTurnId &&
      context.turn.backendTurnId !== settlement.turnId
    ) {
      logDiagnostic("session: reject conflicting Codex human receipt")
      return await this.rejectHumanDelivery(context)
    }
    context.turnId = settlement.turnId
    this.commitHumanDelivery(context)
    return this.humanDeliveryOutcome(context)
  }

  private bindHumanDeliveryTurn(proc: AgentProcess, turn: TurnState): PendingHumanDelivery | null {
    const context = [this.pendingHumanDelivery, this.ackedHumanDelivery].find(candidate =>
      candidate?.proc === proc && candidate.turn === null && candidate.state !== 'restored',
    ) ?? null
    if (!context) return null
    if (context.dispatch) {
      if (
        context.dispatch.threadId !== proc.sessionId ||
        !context.dispatch.deliveryId
      ) return null
      if (turn.backendThreadId && turn.backendThreadId !== context.dispatch.threadId) return null
      if (!turn.backendThreadId) turn.backendThreadId = context.dispatch.threadId
    }
    if (context.turnId) {
      if (turn.backendTurnId && turn.backendTurnId !== context.turnId) return null
      if (!turn.backendTurnId) turn.backendTurnId = context.turnId
    }
    context.turn = turn
    return context
  }

  private matchingHumanDeliveryResult(
    proc: AgentProcess,
    event: AgentResultEvent,
  ): PendingHumanDelivery | null {
    if (proc.provider === 'claude' || proc.provider === 'dsh') {
      return [this.pendingHumanDelivery, this.ackedHumanDelivery].find(context =>
        context?.proc === proc &&
        context.dispatch === null &&
        context.turn === this.currentTurn,
      ) ?? null
    }
    const deliveryId = typeof event.delivery_id === 'string' && event.delivery_id
      ? event.delivery_id
      : null
    const threadId = typeof event.thread_id === 'string' && event.thread_id
      ? event.thread_id
      : null
    if (!deliveryId || !threadId) return null
    const turnId = typeof event.turn_id === 'string' && event.turn_id ? event.turn_id : null
    for (const context of [this.pendingHumanDelivery, this.ackedHumanDelivery]) {
      const dispatch = context?.dispatch
      if (!context || !dispatch || context.proc !== proc) continue
      if (dispatch.deliveryId !== deliveryId || dispatch.threadId !== threadId) continue
      if (context.turnId && turnId && context.turnId !== turnId) return null
      if (context.turn?.backendThreadId && context.turn.backendThreadId !== threadId) return null
      if (context.turn?.backendTurnId && turnId && context.turn.backendTurnId !== turnId) return null
      if (turnId && !context.turnId) context.turnId = turnId
      return context
    }
    return null
  }

  private resultOwnsCurrentHumanTurn(
    proc: AgentProcess,
    event: AgentResultEvent,
    matchingContext: PendingHumanDelivery | null,
  ): boolean {
    if (this.proc !== proc) return false
    if (proc.provider === 'claude' || proc.provider === 'dsh') {
      const currentOwner = [this.pendingHumanDelivery, this.ackedHumanDelivery]
        .find(context => context?.proc === proc && context.state !== 'restored') ?? null
      return currentOwner ? currentOwner === matchingContext : true
    }
    const carriesIdentity = event.delivery_id !== undefined ||
      event.thread_id !== undefined || event.turn_id !== undefined
    if (!carriesIdentity) return true
    const currentOwner = [this.pendingHumanDelivery, this.ackedHumanDelivery]
      .find(context => context?.proc === proc && context.state !== 'restored') ?? null
    if (currentOwner && currentOwner !== matchingContext) return false
    if (matchingContext) {
      if (matchingContext.state === 'pending') {
        return this.humanDeliveryStillOwnsTurn(matchingContext)
      }
      return matchingContext.turn === null
        ? this.currentTurn === null
        : this.currentTurn === matchingContext.turn
    }
    const turn = this.currentTurn
    if (!turn) return false
    const threadId = typeof event.thread_id === 'string' ? event.thread_id : null
    const turnId = typeof event.turn_id === 'string' && event.turn_id ? event.turn_id : null
    if (threadId && turn.backendThreadId && turn.backendThreadId !== threadId) return false
    if (threadId && !turn.backendThreadId && proc.sessionId !== threadId) return false
    if (turnId && turn.backendTurnId && turn.backendTurnId !== turnId) return false
    return true
  }

  private async startColdUserTurn(
    text: string,
    wireText: string,
    userOpenId: string,
    msgId: string,
    batch: HumanBatchMessage[] = [{ text, wireText, userOpenId, msgId }],
  ): Promise<void> {
    const lease = this.beginLifecycle('start')
    let startedProc: AgentProcess | null = null
    let batchTransferred = false
    // 冷启动首轮同样让位于 durable fork marker(4185808 startColdUserTurn 同位 guard)。
    // 合并调和(取舍):上游顺序 reset 先于 beginTurnOpening —— reset 抛错时
    // 不得遗留 opening owner(上游用例 'cold reset failure never leaves a
    // main-card opening owner behind':openingTurn=false、openingTurnOwner=null;
    // 本地旧序在 beginTurnOpening 之后 reset,异常会绕过 finally 的 finishTurnOpening)。
    if (!this.pendingConversationMaterialization) this.resetFreshConversationState()
    const openingToken = this.beginTurnOpening()
    this.pendingTurnInputs.push(...batch.map(message => message.text))
    try {
      const openResult = await this.openTurnCard(openingToken, userOpenId, 'user_message', {
        initialFooter: 'Waiting... (<30s)',
        startThinking: false,
        directStart: true,
      })
      if (!this.ownsLifecycle(lease)) return
      const opened = this.openedTurnOf(openResult)
      if (!opened.ok || opened.turn === null) return
      const turn = opened.turn
      if (this.currentTurn !== turn) return
      const bootTimer = this.startFooterTimer(
        turn.cardId,
        `🚀 启动 ${this.backendLabel()}`,
        status => this.withModel(status),
      )
      let lastBootStatus = `🚀 启动 ${this.backendLabel()}`
      // 走公共 start(本地 main 同位调用):测试经实例覆写 session.start
      // 拦截冷启动的接缝必须保留;带 lease 时 start() 直进 startUnlocked,
      // 既不再排队(user-message lifecycle 内嵌套)也不死锁。
      const ok = await this.start({
        announce: false,
        lifecycleLease: lease,
        freshConversationStateAlreadyReset: true,
        onStatus: status => {
          lastBootStatus = status
          bootTimer.setStatus(status)
        },
      })
      bootTimer.stop()
      if (this.currentTurn !== turn) {
        await this.settleCapturedStaleTurn(turn)
        return
      }
      startedProc = ok ? this.proc : null
      await cardkit.flush(turn.cardId)
      if (this.currentTurn !== turn) {
        await this.settleCapturedStaleTurn(turn)
        return
      }
      if (!ok) {
        this.pendingUserMessageCount = 0
        this.pendingTurnInputs = []
        await this.closeTurnCard(lastBootStatus.startsWith('❌') ? lastBootStatus : '❌ 启动失败', {
          forcePush: true,
          preservePendingReactions: true,
        })
        return
      }
      if (!startedProc || this.proc !== startedProc || !startedProc.isAlive()) {
        await this.settleCapturedStaleTurn(turn)
        return
      }
      this.beginWatchdogTurn(turn, startedProc)
      this.startThinkingFooter(turn)
      const delivery = this.beginHumanDelivery(startedProc, batch, turn)
      batchTransferred = true
      if (delivery) await this.dispatchHumanBatch(delivery)
    } finally {
      if (
        !batchTransferred &&
        this.ownsLifecycle(lease) &&
        (!startedProc || this.proc === startedProc || this.proc === null)
      ) {
        this.pendingMidTurnMsgs = [...batch, ...this.pendingMidTurnMsgs]
      }
      this.finishTurnOpening(openingToken)
    }
  }

  // ── Inbound from Feishu ────────────────────────────────────────────
  trackQueuedReaction(msgId: string): void {
    if (!msgId) return
    this.pendingReactionIds.set(msgId, '')
    void (async () => {
      try {
        const reactionId = await feishu.addReaction(msgId, 'OneSecond')
        if (!reactionId) return
        if (this.pendingReactionIds.has(msgId)) {
          this.pendingReactionIds.set(msgId, reactionId)
        } else if (
          this.pendingHumanDelivery?.state === 'pending' &&
          this.pendingHumanDelivery.reactions.has(msgId)
        ) {
          this.pendingHumanDelivery.reactions.set(msgId, reactionId)
        } else if (this.currentBatchReactionIds.has(msgId)) {
          this.currentBatchReactionIds.set(msgId, reactionId)
        } else {
          void feishu.deleteReaction(msgId, reactionId)
        }
      } catch (e) {
        logError("session: queued reaction failed msg", e)
      }
    })()
  }

  private queueHumanMessage(
    text: string,
    wireText: string,
    userOpenId: string,
    msgId: string,
  ): void {
    this.lastUserOpenId = userOpenId
    this.pendingMidTurnMsgs.push({ text, wireText, userOpenId, msgId })
    this.trackQueuedReaction(msgId)
  }

  /** Idle input starts a turn. Running Codex/Claude tasks receive native
   * steering input without interruption; opening/recovering processes and
   * backends without steering retain the explicit pending batch. */
  async onUserMessage(text: string, files: string[] = [], userOpenId = '', msgId = ''): Promise<void> {
    // 合并吸收(上游 onUserMessage 串行化,4185808)+ 本地并发消息语义调和:
    // ① 消息与 restart/model-select/gsd 等生命周期事务互斥排队(上游 17230
    //    'a user message owns the lifecycle mutex before a subsequently queued
    //    restart':重启不得在消息校验/开卡窗口里杀掉进程);
    // ② 并发用户消息之间不互相排队 —— 本地收据系统让首条消息 handler await 到
    //    回执结算才返回,第二条消息必须立即进 pendingMidTurnMsgs 而不是停在
    //    lifecycle 队列尾巴(session.test 'a second pre-init Codex message
    //    queues while the first receipt is pending'、'a message during a pending
    //    bootstrap delivery queues instead of eager-opening')。已有消息持锁时
    //    后续消息直进(并发执行);非消息操作在跑时消息照旧排队(上游次序)。
    // userMessageActive 在拿到队列执行权后才自增:紧随其后的第二条消息仍会
    // 排队(上游次序),而真实并发(前条已开始 await)才走直进。
    // stopLifecycleActive 同位豁免:stop 事务在途时消息直进(见字段注释)。
    if (this.userMessageActive > 0 || this.stopLifecycleActive > 0) {
      this.userMessageActive++
      try { await this.onUserMessageUnlocked(text, files, userOpenId, msgId) }
      finally { this.userMessageActive-- }
      return
    }
    await this.runLifecycle('user-message', async () => {
      this.userMessageActive++
      try { await this.onUserMessageUnlocked(text, files, userOpenId, msgId, true) }
      finally { this.userMessageActive-- }
    })
  }

  private async onUserMessageUnlocked(
    text: string,
    files: string[],
    userOpenId: string,
    msgId: string,
    /** true = 经 runLifecycle('user-message') 排队执行(计入 lifecycleActive,
     *  下方 daemon-restore 等待须扣除自身,防自等死锁);false = 并发直进路径。 */
    queuedInLifecycle = false,
    resumedProc?: AgentProcess,
  ): Promise<void> {
    const settingsBlocked = this.modelSettingsBlockReason()
    if (settingsBlocked) {
      await feishu.sendText(this.chatId, `⚠️ ${settingsBlocked} 本条消息未送给 Agent，请确认设置后重发。`)
      if (resumedProc) throw new Error(settingsBlocked)
      return
    }
    const subscriptionDisabled = this.disabledClaudeSourceMessage()
    if (subscriptionDisabled) {
      await feishu.sendText(this.chatId, `❌ ${subscriptionDisabled}。消息未送给 Agent，请启用后重发或通过 md 切换来源。`)
      if (resumedProc) throw new Error(subscriptionDisabled)
      return
    }
    const blocked = this.blockedProcessMessage()
    if (blocked) {
      await feishu.sendText(this.chatId, `❌ ${blocked}。请重试 stop/restart，或等待旧进程退出。`)
      if (resumedProc) throw new Error(blocked)
      return
    }
    if (this.daemonRestoreRequired) {
      // onUserMessage 已经过 runLifecycle('user-message') 串行(见 onUserMessage),
      // daemon 恢复事务在跑时本消息天然排在它之后;此处窄口径等待兜底并发直进
      // 场景(已有消息持锁时的直进路径不排队):恢复事务正在执行则等队列排空再判
      // ——恢复成功时 init 处理已清 daemonRestoreRequired(上游用例 'daemon
      // recovery finishes the saved thread initialization before delivering a
      // queued message');恢复失败(事务已结束、标记仍在)则照旧走下面的拒绝。
      while (this.daemonRestoreRequired && this.lifecycleActive > (queuedInLifecycle ? 1 : 0)) {
        await this.lifecycleTail
      }
    }
    if (this.daemonRestoreRequired) {
      await feishu.sendText(this.chatId, '❌ daemon 重启后的会话恢复尚未成功，这条消息未送给 Agent。请发送 rs 选择历史会话，或 hi 明确启动新会话，然后重发消息。')
      if (resumedProc) throw new Error('daemon 会话恢复尚未成功')
      return
    }

    // File hint **inline 在 wireText 内部**,而不是依赖 sendUserText 把
    // files 拼到 message 整体头部。原因:drainMidTurnAndOpen merge N 条
    // wireText 时,若 files 还按整体拼接 → 所有 file hint 全堆在 long
    // message 开头,模型分不清哪个文件配哪条。inline 后每条 sub-message
    // 自带 file hint,SDK side 所有 sendUserText 调用 files 一律传空。
    const filePrefix = files.length ? files.map(f => `[file: ${f}]`).join(' ') + '\n' : ''
    const wireText = filePrefix + text

    // Garbage-collect leftover state from a batch the SDK abandoned —
    // most commonly an AskUserQuestion mid-turn, which makes the SDK
    // emit `QUEUE remove × N` and drop every msg we'd already
    // sendText'd into its queue. The daemon doesn't see those remove
    // events, so `pendingUserMessageCount` and `pendingReactionIds`
    // stay stuck. If the SDK is idle right now (no turn, no eager-
    // open in flight) AND init has already fired at least once
    // (otherwise we'd be in the bootstrap race window where
    // leftover count IS valid — see wasBusy comment below), the
    // leftover count is stale and must be cleared BEFORE the
    // wasBusy computation — otherwise this fresh solo message is
    // misclassified as queued and its card closes with `📨 转交新卡`
    // instead of `✅`.
    this.clearStaleIdleQueueState('user_message')
    // 真人新消息优先:清空 capacity 重试的本地镜像;进程层在本次 sendUserText 内
    // 自行取消退避计时器(调度权在进程层,D-07),session 不越权取消。
    this.clearCapacityRetryState('user_message')
    // GSD “new task” name capture must run before agent forward when armed.
    // Only pure text (no files) is treated as a candidate name.
    if (!files.length && this.gsdAwaitingNameUntil > Date.now()) {
      if (await sessionGsd.maybeConsumeGsdTaskName(this, text)) return
    }
    // Inject templates may arm gsdExecution immediately. Do NOT clear
    // execution on early-return paths below (agy busy / watchdog hold) —
    // those messages never open a real superseding user turn.
    sessionGsd.noteGsdInjectIfAny(this, text)
    if (this.startingAgy || this.runningAgy) {
      await feishu.sendText(this.chatId, '⏳ agy 任务正在执行；请等待完成，或发送 stop 打断后再继续。')
      return
    }
    if (this.toolFailureLoopActionInFlight) {
      this.queueHumanMessage(text, wireText, userOpenId, msgId)
      return
    }
    if (this.watchdogActionInFlight || this.watchdogResumeFailed) {
      this.queueHumanMessage(text, wireText, userOpenId, msgId)
      if (this.watchdogResumeFailed) {
        await feishu.sendText(
          this.chatId,
          '⚠️ thread 自动恢复失败；这条消息已保留，修复后发送 restart 继续。',
        )
      }
      return
    }
    if (
      this.proc?.isAlive() &&
      !this.currentTurn &&
      !this.openingTurn &&
      !this.steeringSend &&
      this.pendingUserMessageCount === 0 &&
      this.pendingMidTurnMsgs.length === 0
    ) {
      await this.stopIdleMismatchedProcessUnlocked()
    }
    if (
      this.proc?.isAlive() &&
      !this.currentTurn &&
      !this.openingTurn &&
      !this.pendingHumanDelivery &&
      this.pendingMidTurnMsgs.length > 0
    ) {
      // Batch will open a new turn via drain — non-GSD text ends execution mark.
      sessionGsd.noteGsdUserMessage(this, text, { startsOwnTurn: true })
      this.queueHumanMessage(text, wireText, userOpenId, msgId)
      await this.drainMidTurnAndOpen()
      return
    }
    // Capture busy-state SYNC, before any state mutation — this decides
    // whether the message will visibly queue (gets the OneSecond → later
    // CheckMark lifecycle reactions on its Feishu chat message) or
    // eager-open its own card (no reaction needed; the card itself is
    // the acknowledgement).
    //
    // `pendingUserMessageCount > 0` catches the bootstrap race: daemon
    // just spawned, `initCount` is still 0 so no card is open yet, but
    // we've already sendText'd a previous user message into the SDK.
    // The next message lands in the SAME merged-batch SDK queue, so
    // it IS mid-flight from the SDK's perspective — without this
    // check, the daemon would mark it as solo (no ⏳ reaction) and
    // lose track of the queued turn.
    const wasBusy = this.currentTurn !== null || this.openingTurn
      || this.pendingUserMessageCount > 0 || this.pendingMidTurnMsgs.length > 0
    this.lastUserOpenId = userOpenId

    if (resumedProc && (this.proc !== resumedProc || !resumedProc.isAlive())) {
      throw new Error('原会话进程已退出，未发送自动续接请求，也未创建新会话')
    }
    if (!this.isRunning()) {
      if (this.openingTurn || this.currentTurn) {
        // Queued behind an in-flight open — not a superseding own turn yet.
        this.queueHumanMessage(text, wireText, userOpenId, msgId)
        return
      }
      // Cold start opens a real turn for this text.
      sessionGsd.noteGsdUserMessage(this, text, { startsOwnTurn: true })
      const message = { text, wireText, userOpenId, msgId }
      const batch = [...this.pendingMidTurnMsgs, message]
      this.pendingMidTurnMsgs = []
      await this.startColdUserTurn(text, wireText, userOpenId, msgId, batch)
      return
    }

    if (this.currentTurn !== null || this.steeringSend) {
      // Mid-turn — BUFFER instead of immediate sendUserText. The SDK polling
      // loop will not auto-dequeue queued type-ahead msgs after `result`
      // (we explicitly write again to wake the Codex app-server),
      // so writing here would leave the msg stuck until the next user msg
      // arrives. Drain happens in the `result` handler, which both wakes
      // the SDK and opens a fresh card for the new batch turn.
      // Do not clear gsdExecution: in-flight GSD may still be active.
      this.queueHumanMessage(text, wireText, userOpenId, msgId)
      this.steerPendingInputs()
      return
    }

    // No in-flight turn: send straight to SDK. This path handles
    //   - first message after spawn (init not yet fired)
    //   - bootstrap race (sibling msgs landing before init#1)
    //   - solo message after a prior turn has fully closed
    // Eager-open path: open the card BEFORE feeding SDK, so a card-open
    // failure doesn't strand the daemon with SDK processing a turn we
    // have nowhere to render. `!openingTurn` means no sibling is mid-
    // open; `initCount >= 1` means SDK boot init has fired (otherwise
    // the init handler owns turn opening and we just feed the queue
    // below); `!pendingHumanDelivery` means no earlier batch is still
    // awaiting its receipt — eager-opening over one would double-render
    // the input and make its later ACK look owner-lost (replay).
    if (!this.openingTurn && this.initCount >= 1 && !this.pendingHumanDelivery) {
      // This message owns the next turn card — non-GSD chat ends execution mark.
      sessionGsd.noteGsdUserMessage(this, text, { startsOwnTurn: true })
      const openingToken = this.beginTurnOpening()
      try {
        // openTurnCard 内部读 pendingTurnInputs 渲染 "📥 收到" panel,要在
        // 它之前 push;之后再 sendUserText 给 SDK,顺序无关紧要(panel 是
        // daemon 自渲染,跟 SDK input 流分离)。
        const proc = this.proc
        if (!proc) return
        this.pendingTurnInputs.push(text)
        const openResult = await this.openTurnCard(openingToken, userOpenId, 'user_message', { expectedProc: proc })
        const opened = this.openedTurnOf(openResult)
        if (
          !opened.ok ||
          opened.turn === null ||
          this.currentTurn !== opened.turn ||
          this.proc !== proc ||
          !proc.isAlive()
        ) {
          if (resumedProc) throw new Error('自动续接卡片未打开，未发送续接请求')
          return
        }
        const delivery = this.beginHumanDelivery(proc, [{
          text,
          wireText,
          userOpenId,
          msgId,
        }], opened.turn)
        if (delivery) {
          const result = await this.dispatchHumanBatch(delivery)
          if (resumedProc && result !== 'committed') throw new Error('自动续接请求提交失败，未重试')
        }
      } finally {
        this.finishTurnOpening(openingToken)
      }
      return
    }

    // Non-eager path 分两支:
    //   A) openingTurn=true 或 pendingUserMessageCount>0 — sibling 在
    //      openTurnCard,或者 cold-start 第一条 sendUserText 已经发出在
    //      等 SDK init#1。两种情况下直接 sendUserText 都会让 SDK
    //      把这条偷偷合并进 sibling 的 turn(或第一条触发的 cold-start
    //      turn),但 panel input 已经被 snapshot 决定 → "内容跟响应不
    //      一致"race(02:22 + 03:19 现场,以及 commit 2258af4 注释里的
    //      cold-start "first write lands in idle SDK" empirical 行为)。
    //      改成 mid-turn buffer 风格:不 sendUserText、不 push
    //      pendingTurnInputs,等 sibling turn close 后由 result handler
    //      的 midBuffer drain 走 merge 一致处理。
    //   B) cold start 第一条 (initCount===0 且 pendingCount===0) — init
    //      还没来,必须 sendUserText 喂 SDK 才能 wake;init handler 后续
    //      触发 openTurnCard 时一次性消费 pendingTurnInputs。
    if (this.openingTurn || this.pendingUserMessageCount > 0 || this.pendingHumanDelivery) {
      // Queued behind sibling open / cold batch — not a clear own-turn yet.
      this.queueHumanMessage(text, wireText, userOpenId, msgId)
      return
    }
    // Cold first write that wakes SDK — this text will own the turn after init.
    sessionGsd.noteGsdUserMessage(this, text, { startsOwnTurn: true })
    this.pendingTurnInputs.push(text)
    if (wasBusy && msgId) {
      // Bootstrap race / sibling-opening race: until a card is open,
      // the OneSecond ⏳ is the only ack the user gets. The init handler
      // inherits these via currentBatchReactionIds when it opens.
      this.trackQueuedReaction(msgId)
    }
    const proc = this.proc!
    const delivery = this.beginHumanDelivery(proc, [{ text, wireText, userOpenId, msgId }], null)
    if (delivery) {
      const outcome = await this.dispatchHumanBatch(delivery)
      if (outcome === 'preserved') {
        // 批次已回存 pendingMidTurnMsgs,面板快照必须同步回滚,
        // 否则之后重投时同一条输入会在卡片顶栏渲染两遍。
        const inputIndex = this.pendingTurnInputs.lastIndexOf(text)
        if (inputIndex >= 0) this.pendingTurnInputs.splice(inputIndex, 1)
      }
    }
  }

  // ── External API delegated to helpers ──────────────────────────────
  // Thin wrappers so daemon.ts keeps its `session.xxx(...)` call style;
  // bodies live in session-ask.ts / session-permission.ts.

  hasPendingAsk(): boolean {
    return sessionAsk.hasPendingAsk(this)
  }

  refreshPendingAsks(): void {
    sessionAsk.refreshPendingAsks(this)
  }

  askBlockReason(toolUseId: string): string | null {
    return sessionAsk.askBlockReason(this, toolUseId)
  }

  hasPendingHostAsk(): boolean {
    return sessionHostAsk.hasPendingHostAsk(this)
  }

  /** 多条消息缓冲入口(`>>>` 开始 / `<<<` 收尾 / 中段普通消息)。返回 true
   *  表示这条已被缓冲或已合并 flush,daemon 不应再调 onUserMessage。*/
  onMultiMessageInbound(text: string, files: string[], userOpenId: string, msgId: string): Promise<boolean> {
    return sessionMultimsg.onMultiMessageInbound(this, text, files, userOpenId, msgId)
  }

  /** 丢弃多条消息缓冲并给每条打 ❌。stop/kill/restart/clear/exit 调用。*/
  clearMultiMsgBuffer(reason: string): void {
    sessionMultimsg.clearMultiMsgBuffer(this, reason)
  }

  onAskMessageAnswer(text: string, user: string, msgId: string): Promise<void> {
    return sessionAsk.onAskMessageAnswer(this, text, user, msgId)
  }

  onHostAskMessageAnswer(text: string, user: string, msgId: string): Promise<void> {
    return sessionHostAsk.onHostAskMessageAnswer(this, text, user, msgId)
  }

  onAskAnswer(toolUseId: string, questionIdx: number, optionIdx: number, user: string): Promise<boolean> {
    return sessionAsk.onAskAnswer(this, toolUseId, questionIdx, optionIdx, user)
  }

  onHostAskAnswer(toolUseId: string, questionIdx: number, optionIdx: number, user: string): Promise<ModelActionResult> {
    return sessionHostAsk.onHostAskAnswer(this, toolUseId, questionIdx, optionIdx, user)
  }

  onAskCustomAnswer(toolUseId: string, questionIdx: number, customText: string, user: string): Promise<boolean> {
    return sessionAsk.onAskCustomAnswer(this, toolUseId, questionIdx, customText, user)
  }

  onHostAskCustomAnswer(toolUseId: string, questionIdx: number, customText: string, user: string): Promise<ModelActionResult> {
    return sessionHostAsk.onHostAskCustomAnswer(this, toolUseId, questionIdx, customText, user)
  }

  onPermissionDecision(requestId: string, decision: 'allow' | 'allow_always' | 'deny', user: string): Promise<{ ok: boolean; message: string }> {
    return sessionPermission.onPermissionDecision(this, requestId, decision, user)
  }

  async startHostAskContinuation(
    wireText: string,
    expectedProc: AgentProcess,
  ): Promise<'started' | 'stale' | 'failed'> {
    if (this.proc !== expectedProc || !expectedProc.isAlive()) return 'stale'
    if (this.currentTurn || this.openingTurn) throw new Error(`${this.backendLabel()} turn still active`)
    const openingToken = this.beginTurnOpening()
    try {
      const openResult = await this.openTurnCard(openingToken, '', 'user_message', { expectedProc })
      const opened = this.openedTurnOf(openResult)
      if (opened.failed) throw new Error('failed to open continuation turn card')
      if (
        !opened.ok ||
        opened.turn === null ||
        this.currentTurn !== opened.turn ||
        this.proc !== expectedProc ||
        !expectedProc.isAlive()
      ) return 'stale'
      const dispatch = await this.dispatchSystemUserText(
        expectedProc,
        wireText,
        opened.turn,
        openingToken,
      )
      if (dispatch !== 'accepted') {
        if (dispatch === 'rejected') {
          await this.closeRejectedSystemTurn(
            opened.turn,
            expectedProc,
            '⚠️ Codex 未接受继续请求',
          )
          return 'failed'
        }
        return 'stale'
      }
      if (this.proc === expectedProc && this.currentTurn === opened.turn) {
        this.pendingUserMessageCount++
        this.status = 'working'
      }
      return 'started'
    } finally {
      this.finishTurnOpening(openingToken)
    }
  }

  private async dispatchSystemUserText(
    proc: AgentProcess,
    text: string,
    turn: TurnState,
    openingOwner: object,
  ): Promise<'accepted' | 'rejected' | 'stale'> {
    let dispatch: UserTextDispatch
    try {
      dispatch = proc.sendUserText(text, [])
    } catch (cause) {
      logDiagnostic("session: system dispatch threw")
      return 'rejected'
    }
    if (dispatch.kind === 'rejected') {
      logDiagnostic("session: system dispatch rejected")
      return 'rejected'
    }
    if (dispatch.kind === 'queued') {
      // Claude / DSH:sendUserText 是 fire-and-forget(push 到 SDK / JSON-RPC 输入
      // 队列),无 settlement 同步点。校验所有权一致即视为 accepted;turn 卡已由
      // openTurnCard 开好,内容由后续 turn_started / assistant_text 事件填充。
      if (proc.provider !== 'claude' && proc.provider !== 'dsh') {
        logDiagnostic("session: system dispatch unexpected queued from")
        return 'rejected'
      }
      if (
        this.proc !== proc ||
        !proc.isAlive() ||
        this.currentTurn !== turn ||
        this.openingTurnOwner !== openingOwner
      ) return 'stale'
      return 'accepted'
    }
    if (dispatch.kind !== 'turn_start_pending' || proc.provider !== 'codex') {
      logDiagnostic("session: system dispatch returned unexpected")
      return 'rejected'
    }
    let settlement: CodexUserTextSettlement
    try {
      settlement = await dispatch.settlement
    } catch (cause) {
      logError("session: system dispatch receipt rejected", cause)
      return 'rejected'
    }
    if (
      settlement.deliveryId !== dispatch.deliveryId ||
      settlement.threadId !== dispatch.threadId ||
      settlement.kind === 'rejected'
    ) return 'rejected'
    if (
      this.proc !== proc ||
      !proc.isAlive() ||
      this.currentTurn !== turn ||
      this.openingTurnOwner !== openingOwner ||
      (settlement.turnId && turn.backendTurnId && settlement.turnId !== turn.backendTurnId)
    ) return 'stale'
    if (settlement.turnId && !turn.backendTurnId) turn.backendTurnId = settlement.turnId
    return 'accepted'
  }

  private async closeRejectedSystemTurn(
    turn: TurnState,
    proc: AgentProcess,
    suffix: string,
  ): Promise<void> {
    if (this.currentTurn !== turn) return
    const ownsProcess = this.proc === proc
    const closing = this.closeTurnCard(suffix, {
      forcePush: true,
      preservePendingReactions: true,
    })
    if (ownsProcess && this.proc === proc) this.status = 'idle'
    await closing
  }

  // ── Wiring Codex → Feishu ──────────────────────────────────────────
  /** A fresh Codex init only owns an in-memory thread id. Remove any older
   * selected Codex binding after the new process is ready so an idle stop or
   * daemon restart cannot revive either that ghost id or the pre-fresh
   * conversation. The checked write is part of the init transaction.(4185808,挂账 #4) */
  private clearResumeBindingForFreshCodex(proc: AgentProcess): void {
    if (proc.isConversationResumable?.()) {
      throw new Error('fresh Codex thread was unexpectedly marked resumable during init')
    }
    feishu.clearSessionResumeChecked(this.sessionName, 'codex')
    if (this.selectedProvider === 'codex') {
      this.lastSessionRef = null
      this.lastSessionId = null
    }
  }

  /** Migrate a ghost binding created by older Lodestar versions, but only
   * when the app-server explicitly confirms the exact bound Codex id has no
   * rollout. Other resume failures keep the binding for diagnosis/retry.
   * (4185808,挂账 #4;onInvalidated 回调供 04-04 rollbackTo restore 消费) */
  private invalidateMissingCodexResume(
    sessionId: string | null,
    error: unknown,
    onInvalidated?: (sessionId: string) => void,
  ): string | null {
    if (!sessionId || this.selectedProvider !== 'codex') return null
    const rpcError = findCodexRpcResponseError(error)
    if (
      !rpcError
      || !['thread/read', 'thread/resume', 'thread/fork'].includes(rpcError.method)
      || rpcError.serverCode !== -32600
      || rpcError.serverMessage !== `no rollout found for thread id ${sessionId}`
    ) return null
    const bound = feishu.getSessionResumeRef(this.sessionName, 'codex')
    if (!bound || bound.sessionId !== sessionId) return null
    try {
      feishu.clearSessionResumeChecked(this.sessionName, 'codex')
    } catch (clearError) {
      const failure = `已确认恢复点无 rollout，但作废失败: ${messageOf(clearError)}`
      logError('session: resume checkpoint invalidation failed', clearError)
      return failure
    }
    if (this.lastSessionRef?.provider === 'codex' && this.lastSessionRef.sessionId === sessionId) {
      this.lastSessionRef = null
      this.lastSessionId = null
    }
    onInvalidated?.(sessionId)
    const receipt = `已作废无 rollout 的恢复点 thread=${diagnosticIdLabel(sessionId)}`
    return receipt
  }

  private persistResumableSessionId(
    fatal = false,
    proc: AgentProcess | null = this.proc,
    notify = true,
  ): string | null {
    // durable Claude fork marker(4185808,挂账 #2):materialize 前的 persist
    // 判定要同时看它——fork 撞 id/缺 id 都不得推进绑定。
    const pendingMaterialization = proc?.provider === 'claude' ? this.pendingConversationMaterialization : null
    const sessionId = proc?.sessionId
    if (!proc) return null
    // codex materialization 门控(4185808-D):thread/start 先返回内存 id,
    // rollout 落盘经 thread/read 权威确认前不得写入恢复映射 —— 错序即把
    // 不可恢复的 id 绑进映射,重启后会话丢失。resume init 与
    // conversation_materialized 信号都在确认后才置 resumable。fail-closed:
    // 不实现该 hook 的 codex 进程一律视为未确认。
    if (proc.provider === 'codex' && proc.isConversationResumable?.() !== true) return null
    if (!sessionId) {
      if (!pendingMaterialization) return null
      const error = new Error('Claude pending fork did not provide a materialized session id')
      logError('session: fork checkpoint missing', error)
      if (fatal) throw error
      return error.message
    }
    // A replacement may have materialized the pending fork under a new
    // account. Its confirmed id supersedes the original waiting owner's intent.
    if (proc.provider === 'codex') this.codexQuotaWaitLaunch = null
    const ref: ConversationRef = { provider: proc.provider, sessionId, cwd: this.workDir }
    const recovery = this.preservedWatchdogRecovery
    if (recovery && (proc.provider !== recovery.provider || sessionId !== recovery.threadId)) return null
    // pending 独立 id 校验(4185808):fork 必须派生新 id —— 新 id 撞 fork 源或
    // intent 建立时的旧绑定,说明 fork 未真正派生,拒绝推进恢复绑定。一次性
    // intent(pendingConversationLaunch)与 durable marker 双通道。
    const pendingFork = this.pendingConversationLaunch
    if (
      pendingFork
      && pendingFork.launch.kind === 'fork'
      && pendingFork.launch.source.provider === proc.provider
      && (
        sessionId === pendingFork.launch.source.sessionId
        || (pendingFork.previousSessionId !== null && sessionId === pendingFork.previousSessionId)
      )
    ) {
      const error = new Error(`fork 未派生独立 session id (${sessionId})`)
      logDiagnostic("session: runtime state changed")
      if (fatal) throw error
      return error.message
    }
    if (
      pendingMaterialization
      && (
        sessionId === pendingMaterialization.launch.source.sessionId
        || (
          pendingMaterialization.previousSessionId !== null
          && sessionId === pendingMaterialization.previousSessionId
        )
      )
    ) {
      const error = new Error(`Claude fork did not materialize an independent session id (${sessionId})`)
      logError('session: fork checkpoint invalid', error)
      if (fatal) throw error
      return error.message
    }
    try {
      feishu.bindSessionResumeChecked(this.sessionName, ref)
    } catch (error) {
      const message = `会话恢复点持久化失败: ${messageOf(error)}`
      const firstReport = this.resumePersistenceError !== message
      this.resumePersistenceError = message
      // 进程本身仍可用:内存目标照常推进,只有 durable 绑定失败(daemon 重启前
      // 修不了本机状态目录的话会丢恢复点 —— 群内可观测,去重只报一次)。
      if (proc.provider === this.selectedProvider) {
        this.lastSessionRef = ref
        this.lastSessionId = sessionId
      }
      logError('session: resume checkpoint persistence failed', error)
      if (fatal) throw error
      if (firstReport && notify) {
        void feishu.sendTextRaw(this.chatId, `⚠️ ${message}；当前进程可继续，但 daemon 重启前请先解决本机状态目录写入问题。`)
      }
      return message
    }
    if (proc.provider === this.selectedProvider) {
      this.lastSessionRef = ref
      this.lastSessionId = sessionId
    }
    // 门通过的同一时刻排空延迟队列(挂账 #3):门与队列是同一 materialization
    // 窗口的两半 —— 只有绑定推进成功,延迟锚才有资格落盘。
    const anchorError = proc.provider === 'codex'
      ? this.flushPendingCodexTurnAnchors(proc)
      : null
    if (anchorError) {
      const firstReport = this.resumePersistenceError !== anchorError
      this.resumePersistenceError = anchorError
      if (fatal) throw new Error(anchorError)
      if (firstReport && notify) void feishu.sendTextRaw(this.chatId, `⚠️ ${anchorError}`)
      return anchorError
    }
    this.resumePersistenceError = null
    return null
  }

  /** The first Claude result proves the prepared fork has materialized and
   * completed its first turn. Until then the durable marker lets process exit
   * or daemon restart resume the new id (if init arrived) or retry the fork.
   * (4185808,挂账 #2 消费口) */
  private consumePendingConversationMaterialization(): string | null {
    const pending = this.pendingConversationMaterialization
    if (!pending) return null
    const ref = this.lastSessionRef
    if (
      ref?.provider !== 'claude'
      || ref.cwd !== this.workDir
      || ref.sessionId === pending.launch.source.sessionId
      || ref.sessionId === pending.previousSessionId
    ) {
      const message = 'Claude 待生成分支没有可验证的新会话恢复点，保留 pending marker'
      logDiagnostic('session: fork checkpoint unavailable')
      return message
    }
    try {
      feishu.setPendingConversationLaunchChecked(this.sessionName, null)
      this.pendingConversationMaterialization = null
      return null
    } catch (error) {
      const message = `Claude 待生成分支标记清除失败: ${messageOf(error)}`
      logError('session: fork marker cleanup failed', error)
      return message
    }
  }

  // ── 原生子 Agent / 后台任务 → 共享任务面板 ───────────────────────

  /** 当前双池快照 —— 喂给纯函数累积器的入参。 */
  private bgStore(): cards.BgStore {
    return { active: this.backgroundTasks, pending: this.pendingBgTasks }
  }

  /** 把 BgStore 双池结果写回 backgroundTasks(active)+ pendingBgTasks。
   *  bg_task_* 事件与子 agent tool_use/tool_result 累积的统一落点。 */
  private applyBgStore(next: cards.BgStore): void {
    this.backgroundTasks = next.active
    this.pendingBgTasks = next.pending
  }

  /** 主线程推进(新的主线程 tool_use / assistant 段定稿):pending 观察池里还没结算
   *  的 task 都没在阻塞主线程 —— 判为后台,提升到 active 入卡。治 run_in_background
   *  的 Bash 不发 is_backgrounded、永远卡 pending 不渲染。 */
  private onMainThreadAdvance(): void {
    if (this.pendingBgTasks.length === 0) return
    this.applyBgStore(cards.promotePendingOnAdvance(this.bgStore()))
    this.onBackgroundTaskChanged()
  }

  /** parentToolUseId 是否归属某个已知后台 task(active 入卡池或 pending 观察池)。
   *  子 agent 前台跑时在 pending,提升后在 active,两池都要认才能持续累积 steps。 */
  private bgTaskOwns(parentToolUseId: string): boolean {
    return this.backgroundTasks.some(t => t.toolUseId === parentToolUseId)
      || this.pendingBgTasks.some(t => t.toolUseId === parentToolUseId)
  }

  /** task_id 是否在双池(active 入卡池或 pending 观察池)中。 */
  private bgTaskKnown(taskId: string): boolean {
    return this.backgroundTasks.some(t => t.id === taskId)
      || this.pendingBgTasks.some(t => t.id === taskId)
  }

  /** 热续跑感知:SendMessage 续跑刚完成的 agent 时 SDK 不重发 task_started,运行期
   *  只可能来 progress/updated。未知 task 命中已结算 agent 档案 → 以「续跑」running
   *  条目复活入 active,活卡照常重开/刷新;未命中(前台命令等)no-op。 */
  private tryResurrectBgTask(taskId: string, _via: string): void {
    const known = this.backgroundTasks.find(task => task.id === taskId)
    if (known && !cards.isBgTerminal(known)) return
    if (!known && this.pendingBgTasks.some(task => task.id === taskId)) return
    if (known) {
      this.bgArchive = cards.archiveTerminalAgents(this.bgArchive, [known])
      this.backgroundTasks = this.backgroundTasks.filter(task => task !== known)
    }
    const entry = cards.resurrectRunning(this.bgArchive, taskId)
    if (!entry) return
    this.backgroundTasks = [...this.backgroundTasks, entry]
    logDiagnostic("session: bg resurrect via")
  }

  /** 热续跑全程零运行期事件、只来最终 task_notification:命中档案就补一张一次性
   *  墓碑卡(静态历史卡,不走活卡 streaming 生命周期),让「续跑已完成」在群里留痕。 */
  private async sendResumedAgentTombstone(e: BgTaskSettledEvent): Promise<void> {
    const entry = cards.resurrectSettled(this.bgArchive, { ...e, ...e.display })
    if (!entry) return
    this.backgroundTasks = [...this.backgroundTasks, entry]
    await this.refreshBackgroundCardFull()
  }

  hasPendingAgentTool(): boolean {
    return this.nativeAgentTools.size > 0
  }

  private onBackgroundTaskChanged(immediate = false): void {
    if (!this.backgroundTasks.length) return
    // Start and terminal states are published immediately; tool/progress bursts
    // coalesce within 1.5s. Titles have no ticking clock, so idle jobs need no timer.
    if (immediate) {
      if (this.backgroundRefreshTimer) clearTimeout(this.backgroundRefreshTimer)
      this.backgroundRefreshTimer = null
      void this.refreshBackgroundCardFull().catch(error => this.reportBackgroundWriteFailure(error))
    } else {
      this.scheduleBackgroundRefresh()
    }
  }

  private scheduleBackgroundRefresh(): void {
    if (this.backgroundRefreshTimer) return
    this.backgroundRefreshTimer = setTimeout(() => {
      this.backgroundRefreshTimer = null
      void this.refreshBackgroundCardFull().catch(error => this.reportBackgroundWriteFailure(error))
    }, 1500)
  }

  private refreshBackgroundCardFull(): Promise<void> {
    const owner = this.backgroundOwner
    const snapshot = [...this.backgroundTasks]
    const operation = this.agentCards.syncBackground(this.chatId, owner, snapshot)
    let guarded!: Promise<void>
    guarded = operation.then(() => {
      this.backgroundWriteErrors.clear()
      if (owner === this.backgroundOwner) this.bgArchive = cards.archiveTerminalAgents(this.bgArchive, snapshot)
    }).finally(() => {
      if (this.backgroundSync === guarded) this.backgroundSync = null
    })
    this.backgroundSync = guarded
    return guarded
  }

  private async reportBackgroundWriteFailure(error: unknown): Promise<void> {
    const messages = backgroundFailureNotices(error)
    logDiagnostic('session: task panel update failed')
    const notices = messages.filter(message => {
      // A new request id does not mean a new fault. Keep each original error
      // in the log, and show each cause once until the panel sync recovers.
      const key = message.replace(/\s+log_id=\S+/gi, '').replace(/\s+/g, ' ').trim()
      if (this.backgroundWriteErrors.has(key)) return false
      this.backgroundWriteErrors.add(key)
      return true
    })
    if (!notices.length) return
    await feishu.sendTextRaw(this.chatId, `⚠️ 运行任务面板更新失败：${notices.join('; ')}`)
  }

  /** Drain admitted writes and settle only this process's rows. The shared card
   * stays streaming while other delegated work is still running. */
  private async resetBackgroundTasks(lease?: LifecycleLease): Promise<void> {
    if (this.backgroundRefreshTimer) clearTimeout(this.backgroundRefreshTimer)
    this.backgroundRefreshTimer = null
    if (lease && !this.ownsLifecycle(lease)) return
    const owner = this.backgroundOwner
    const now = Date.now()
    this.backgroundTasks = this.backgroundTasks.map(task => cards.isBgTerminal(task)
      ? task : { ...task, status: 'killed', endTime: task.endTime ?? now })
    const tasksOwner = this.backgroundTasks
    this.pendingBgTasks = []
    // A previous write may have failed, but terminal cleanup still attempts its
    // own authoritative snapshot and propagates any final failure to stop().
    if (this.backgroundSync) {
      try { await this.backgroundSync }
      catch { /* The terminal refresh below retries the failed presentation. */ }
    }
    await this.refreshBackgroundCardFull()
    if (this.backgroundRefreshTimer) clearTimeout(this.backgroundRefreshTimer)
    this.backgroundRefreshTimer = null
    if ((lease && !this.ownsLifecycle(lease)) || owner !== this.backgroundOwner || this.backgroundTasks !== tasksOwner) return
    this.agentCards.releaseBackground(owner)
    this.backgroundOwner = randomBytes(16).toString('hex')
    this.backgroundTasks = []
    this.bgArchive = []
    this.nativeAgentTools.clear()
    this.lastMainTaskToolUseId = null
  }

  private migrateBackgroundCard(): Promise<void> { return this.refreshBackgroundCardFull() }
  async openBackgroundCard(): Promise<void> { await this.refreshBackgroundCardFull() }
  stopBackgroundRefreshTick(): void {
    if (this.backgroundRefreshTick) clearTimeout(this.backgroundRefreshTick)
    this.backgroundRefreshTick = null
  }

  /** Claude SDK Cron prompts are injected outside Lodestar's sendUserText
   * path, so they have neither a pending input claim nor a daemon-opened card.
   * Claim the turn as soon as the SDK exposes its meta user message; this puts
   * the open guard in place before assistant/tool events begin.(上游 7c14677;
   * 开卡失败走 bg-resume 同款 cardless 兜底,巡检输出不丢) */
  private startScheduledTurnCard(p: AgentProcess, text: string, _promptId: string | null): void {
    if (this.proc !== p || !p.isAlive()) return
    // If another visible owner already exists, the SDK has folded this prompt
    // into that turn and its output will render there. Never create a second
    // card over a live/opening user or background turn.(bootstrapDelivery 是
    // 本地 human-delivery 机制下 pendingCount 之外的另一种"已被认领"形态)
    const bootstrapDelivery = [this.pendingHumanDelivery, this.ackedHumanDelivery]
      .find(context => context?.proc === p && context.turn === null && context.state !== 'restored') ?? null
    if (
      this.currentTurn ||
      this.openingTurn ||
      this.pendingUserMessageCount > 0 ||
      this.bgResumePending ||
      bootstrapDelivery
    ) return

    let openingToken: TurnOpenTerminalStash
    try {
      openingToken = this.beginTurnOpening()
    } catch (error) {
      logError('session: scheduled turn-open ownership conflict', error)
      return
    }
    this.sawResultWhileOpening = false
    const preview = text.replace(/\s+/g, ' ').trim()
    this.lastTurnUserPreview = `⏰ ${preview.slice(0, 78)}`
    logDiagnostic("session: scheduled wakeup prompt")
    void (async () => {
      try {
        const openResult = await this.openTurnCard(openingToken, '', 'scheduled_wakeup', { expectedProc: p })
        const opened = this.openedTurnOf(openResult)
        if (this.proc !== p || opened.stale) return
        if (opened.failed) {
          // The scheduled turn is already executing inside the SDK. Preserve
          // its report via the same cardless buffer used by background resume
          // turns; result/exit will send an explicit raw-text fallback.
          this.bgResumeCardless = true
          if (this.sawResultWhileOpening) {
            this.sawResultWhileOpening = false
            logDiagnostic("session: scheduled open failed, result already arrived — flushing orphan now")
            this.flushOrphanAssistantToChat('scheduled open failed, result already arrived')
          } else {
            logDiagnostic('session: scheduled open failed')
          }
        } else if (!opened.ok || opened.turn === null || this.currentTurn !== opened.turn) {
          return
        } else if (this.sawResultWhileOpening) {
          const openedTurn = opened.turn
          this.sawResultWhileOpening = false
          logDiagnostic("session: scheduled result raced card-open — closing freshly-opened")
          await this.closeTurnCard(undefined, { hasFreshResult: true })
          if (this.proc !== p || (this.currentTurn !== null && this.currentTurn !== openedTurn)) return
          this.status = 'idle'
        } else {
          this.status = 'working'
        }
      } finally {
        this.finishTurnOpening(openingToken)
      }
    })().catch(error => {
      logError('session: scheduled turn-open handler failed', error)
    })
  }

  private wireProc(p: AgentProcess, wiredEpoch?: number): void {
    // Tests and a few package-internal probes historically call wireProc
    // directly. Treat that form as an explicit attach; production uses
    // attachProc() and passes the already-incremented generation.
    if (wiredEpoch === undefined) {
      this.invalidateTurnOpen()
    }
    const epoch = wiredEpoch ?? ++this.procEpoch
    if (wiredEpoch === undefined && this.proc !== p) this.proc = p
    const isCurrent = (): boolean => this.proc === p && this.procEpoch === epoch
    if (processUsesClaudeTranslation(p)) p.setTranslationPresentationPolicy?.(event => {
      if (!isCurrent() || this.stoppingProc === p || this.blockedProc === p) return 'hidden'
      if (event.kind === 'assistant_text' && event.parentToolUseId) return 'hidden'
      if ((event.kind === 'tool_input' || event.kind === 'tool_result')
        && event.parentToolUseId && this.bgTaskOwns(event.parentToolUseId)) return 'background'
      // The main question panel never renders the SDK receipt, including
      // validation errors raised before canUseTool created a question panel.
      if (event.kind === 'tool_result' && event.toolName === 'AskUserQuestion') return 'hidden'
      return 'main'
    })
    const on = <K extends keyof AgentProcessEventMap>(
      event: K,
      handler: (payload: AgentProcessEventMap[K], snapshot: { result: CodexResultMeta; totalUsage: CodexUsage | null }) => void,
    ): void => {
      p.on(event, (payload: AgentProcessEventMap[K]) => {
        const generation = this.steeringGeneration
        const snapshot = { result: { ...p.lastResult }, totalUsage: p.lastTotalUsage ? { ...p.lastTotalUsage } : null }
        const dispatch = (): void => {
          if (!isCurrent()) {
            return
          }
          if (generation !== this.steeringGeneration && event !== 'exit' && event !== 'error') return
          const boundary = this.steeringBoundary
          if (boundary && boundary.proc === p && boundary.epoch === epoch
            && event !== 'error' && !(event === 'exit' && (this.stoppingProc === p || this.blockedProc === p))) {
            if (event === 'user_input_consumed' && boundary.collecting) {
              handler(payload, snapshot)
              return
            }
            boundary.events.push(dispatch)
            // Native user items can span multiple stdio frames. Finish the
            // input run on actual Agent activity, never an elapsed debounce
            // interval, an RPC receipt, or a quota/usage notification.
            const mainThread = !payload || typeof payload !== 'object'
              || !('parentToolUseId' in payload) || !payload.parentToolUseId
            if (mainThread && (event === 'input_batch_end' || event === 'assistant_text' || event === 'assistant_block_stop'
              || event === 'tool_use' || event === 'tool_result' || event === 'can_use_tool'
              || event === 'hook_callback' || event === 'turn_retry' || event === 'codex_account_changed'
              || event === 'thinking_progress' || event === 'plan_delta' || event === 'turn_plan_updated'
              || event === 'context_compacted' || event === 'turn_started' || event === 'result' || event === 'exit')) {
              boundary.start()
            }
            return
          }
          if (event !== 'exit' && (this.stoppingProc === p || this.blockedProc === p)) {
            return
          }
          handler(payload, snapshot)
        }
        dispatch()
      })
    }

    this.clearCodexProcessActivityState()
    on('error', err => {
      logError('session: process error', err)
    })
    on('init', () => {
      if (p.provider === 'codex' && p.quotaWaitPromise) {
        this.daemonRestoreRequired = false
        if (this.status === 'starting') this.status = this.currentTurn ? 'working' : 'idle'
        this.opts.onLifecycleChange?.()
      }
      if (p.provider === 'codex' && p.launchKind === 'fresh') {
        // fresh init 只有内存 thread id:清 pre-fresh ghost 绑定(4185808 init
        // 事务一部分,挂账 #4);写失败向上抛,由 start 的 sendInitialize 捕获
        // 转启动失败 —— 不得静默留下新旧绑定并存。
        this.clearResumeBindingForFreshCodex(p)
      } else {
        this.persistResumableSessionId(false, p)
      }
      this.initCount++

      // Boot init (initCount === 1) is claimed by `onUserMessage`'s
      // eager-open path — if a user message landed before the init
      // arrived, it sits in `pendingUserMessageCount` and we drain it
      // below; otherwise the init opens nothing. Subsequent inits
      // (initCount >= 2) can mark the start of an SDK-initiated turn
      // when the SDK is draining the type-ahead queue we fed it via
      // `sendUserText` (isUserBatch).
      //
      // SDK-driven rotation puts the boundary HERE: the previous
      // turn's `result` already closed the in-flight card with
      // `📨 转交新卡` (because pendingUserMessageCount > 0). Now we
      // open a fresh card whose top panel shows the queued messages.
      // currentTurn should be null at this point (result null'd it);
      // the openingTurn guard catches the eager-open vs init race.
      // Eager/cold/drain paths open their card before feeding the SDK. Their
      // init therefore arrives with currentTurn/openingTurn already set;
      // consume the SDK-input claim here, but leave pending reactions alone
      // because those belong to later daemon-buffered messages, not this open
      // turn.(上游 7c14677:残留 claim 会让下一条 task-notification init 被
      // 误判成 user batch,开出 trigger=user_message inputs=0 空卡)
      if (this.currentTurn || this.openingTurn) {
        if (this.pendingUserMessageCount > 0) {
          this.pendingUserMessageCount = 0
        }
        this.steerPendingInputs()
        return
      }
      const bootstrapDelivery = [this.pendingHumanDelivery, this.ackedHumanDelivery]
        .find(context => context?.proc === p && context.turn === null && context.state !== 'restored') ?? null
      const isUserBatch = this.pendingUserMessageCount > 0 || bootstrapDelivery !== null
      // SDK 自发恢复轮:后台任务结算通知唤醒 SDK 合并结果,init 没有伴随
      // 用户消息。必须照样开卡,否则这一轮的全部正文会被 appendAssistant
      // 静默丢弃(2026-07-04 etmmo 终报告事故)。bgResumePending 只在
      // bg_task_settled 落在无活跃 turn 时置位,保证 probe/模型切换等
      // 无关的空 init 不受影响。
      const isBgResume = !isUserBatch && this.bgResumePending
      if (!isUserBatch && !isBgResume) return
      const userOpenId = this.lastUserOpenId
      let openingToken: TurnOpenTerminalStash
      try {
        openingToken = this.beginTurnOpening()
      } catch (error) {
        // Preserve pendingCount/bgResumePending/reactions so a later boundary
        // can still claim this turn. An invariant violation is visible in logs
        // but must not escape EventEmitter and tear down the whole SDK process.
        logError('session: init turn-open ownership conflict', error)
        return
      }
      this.bgResumePending = false
      if (isUserBatch) {
        this.pendingUserMessageCount = 0
        // Inherit the queued reaction_ids — this turn is collectively
        // responsible for releasing their OneSecond reactions when it
        // closes (via deleteReaction in closeTurnCard).
        if (!bootstrapDelivery) {
          this.currentBatchReactionIds = this.pendingReactionIds
          this.pendingReactionIds = new Map()
        }
      }
      if (bootstrapDelivery) bootstrapDelivery.openingOwner = openingToken
      this.sawResultWhileOpening = false // 本次开卡的竞态标记,落地时判定
      void (async () => {
        try {
          const openResult = await this.openTurnCard(
            openingToken,
            userOpenId,
            isUserBatch ? 'user_message' : 'bg_task_resume',
            { expectedProc: p },
          )
          const opened = this.openedTurnOf(openResult)
          if (this.proc !== p || opened.stale) return
          if (opened.ok && opened.turn !== null) this.bindHumanDeliveryTurn(p, opened.turn)
          if (opened.failed) {
            if (isUserBatch) {
              if (
                bootstrapDelivery?.state === 'acked' &&
                this.ackedHumanDelivery === bootstrapDelivery
              ) {
                this.ackedHumanDelivery = null
              }
              // SDK already started this turn (its `init` is what got us
              // here) but we have no card to render into. Interrupt so
              // assistant/tool events aren't silently dropped while the
              // model burns tokens. Release the reactions this batch
              // inherited (init handler moved them above) — otherwise
              // they stay ⏳ forever on the user's chat messages.
              logDiagnostic('session: init-path openTurnCard failed')
              this.proc?.sendInterrupt()
              this.releaseAllReactions()
              this.status = 'idle'
            } else {
              // 恢复轮开卡失败不打断 —— 打断会把正在合并的后台结果整轮
              // 作废。cardless 续窗:此后正文继续进孤儿缓冲。若 result 已在
              // 开卡窗口内到达(不会再有第二次),这里立即兜底,否则由
              // result 处理器 flush。
              this.bgResumeCardless = true
              if (this.sawResultWhileOpening) {
                this.sawResultWhileOpening = false
                logDiagnostic("session: bg-resume openTurnCard failed, result already arrived — flushing orphan now")
                this.flushOrphanAssistantToChat('bg-resume open failed, result already arrived')
              } else {
                logDiagnostic('session: bg-resume openTurnCard failed')
              }
            }
          } else if (opened.turn === null || this.currentTurn !== opened.turn) {
            return
          } else if (this.sawResultWhileOpening) {
            const openedTurn = opened.turn
            // 卡片开成了,但这一轮的 result 已在开卡 await 窗口内到达 ——
            // result 处理器当时 currentTurn 还是 null,closeTurnCard 空转了。
            // 这里补一次收尾,否则卡片 footer 永远计时、session 卡在 working。
            // deferred close 消费挂在 owner token 上的终态载荷(ff44afb
            // owner.terminalSuffix,04-05 甄别 #13):checkpoint 持久化失败等
            // stateError 不因竞态丢失,forcePush 语义一并携带。
            this.sawResultWhileOpening = false
            logDiagnostic("session: result raced card-open — closing freshly-opened turn card now")
            await this.closeTurnCard(openingToken.terminalSuffix, {
              forcePush: openingToken.terminalForcePush ?? false,
              hasFreshResult: true,
            })
            if (
              this.proc !== p ||
              (this.currentTurn !== null && this.currentTurn !== openedTurn)
            ) return
            this.status = 'idle'
          } else {
            this.status = 'working'
          }
        } finally {
          this.finishTurnOpening(openingToken)
          // 开卡窗口结束:释放 bootstrap 投递对该窗口的绑定,此后的
          // 所有权由已绑定的 turn(bindHumanDeliveryTurn)接管;否则
          // ACK/result 会把仍然同主的投递误判为易主(token ≠ null)。
          if (bootstrapDelivery && bootstrapDelivery.openingOwner === openingToken) {
            bootstrapDelivery.openingOwner = null
          }
        }
      })().catch(e => {
        logError('session: init turn-open handler failed', e)
      })
    })
    on('scheduled_turn_input', ({ text, displayText, promptId }) => {
      // claude 与 dsh 都上报调度轮输入;codex 走自己的 receipt 路径。
      if (p.provider !== 'claude' && p.provider !== 'dsh') return
      this.startScheduledTurnCard(p, displayText ?? text, promptId)
    })
    on('conversation_materialized', ({ session_id: sessionId }) => {
      if (p.provider !== 'codex') return
      if (p.sessionId !== sessionId) {
        return
      }
      this.persistResumableSessionId(false, p)
    })
    on('conversation_materialization_failed', ({ session_id: sessionId, error }) => {
      if (p.provider !== 'codex' || p.sessionId !== sessionId) return
      // 失败可观测但脱敏(01-12 诊断惯例):只内插 error.message 单行,
      // cause 链/raw payload/凭据不进任何用户可见通道;绑定不推进(门控
      // 由 persistResumableSessionId 的 isConversationResumable 检查承担)。
      const message = `Codex 会话落盘确认失败，未写恢复点: ${messageOf(error)}`
      const firstReport = this.resumePersistenceError !== message
      this.resumePersistenceError = message
      logError('session: checkpoint confirmation failed', error)
      if (firstReport) void feishu.sendTextRaw(this.chatId, `⚠️ ${message}`)
    })
    on('turn_retry', (retry: AgentTurnRetry) => {
      // 模型满载退避(上游 2e6e1e0):同一逻辑任务保持未终结,footer 换成
      // ⏳ 进度文案(actual 文案由 startFooterStatus 读 proc.turnRetry 覆盖)。
      // 调度权在进程层:schema 见 noteCapacityRetry(D-07)。
      if (this.currentTurn) this.startThinkingFooter(this.currentTurn)
      this.noteCapacityRetry(retry)
    })
    on('codex_account_changed', () => {
      this.pendingAsks.clear()
      this.pendingPermissions.clear()
      // Unused-account diagnostics remain available in explicit account inspection.
    })
    on('turn_started', (identity: { turn_id?: string | null; thread_id?: string | null; retry?: boolean }, snapshot) => {
      // Codex app-server emits init only at process startup, not for every
      // turn — turn_started is its authoritative claim for an input that was
      // already given an eager-opened card。claude 冷启动首轮的 init 先于
      // dispatch 到达(claim 当时还是 0),也靠这里认领。Claude 通常已在上面的
      // init 边界消费;this is an idempotent second boundary.(上游 7c14677)
      if ((this.currentTurn || this.openingTurn) && this.pendingUserMessageCount > 0) {
        this.pendingUserMessageCount = 0
      }
      this.persistResumableSessionId(false, p)
      this.steerPendingInputs()
      if (identity?.retry) {
        // 满载重试轮属于同一可见任务:保留原 usage 基线(容量错误之前已完成的
        // 工作仍计入),不重设 watchdog 身份/用量基准(上游 2e6e1e0)。
        if (this.currentTurn) this.startThinkingFooter(this.currentTurn)
        return
      }
      const threadId = typeof identity?.thread_id === 'string' ? identity.thread_id : p.sessionId
      const turnId = typeof identity?.turn_id === 'string' ? identity.turn_id : null
      const context = this.watchdogContext
      if (
        this.proc === p &&
        context?.proc === p &&
        context.turn === this.currentTurn
      ) {
        this.applyWatchdogIdentity(threadId, turnId)
      } else if (
        this.proc === p &&
        p.provider === 'codex' &&
        this.watchdogSettings.mode !== 'off' &&
        (this.openingTurn || this.pendingTurnInputs.length > 0 || this.pendingUserMessageCount > 0)
      ) {
        const pending = this.pendingWatchdogIdentity
        if (
          pending?.proc === p &&
          pending.turnCounter === this.watchdogOpeningTurnCounter
        ) {
          const conflicts = !!(
            (pending.threadId && threadId && pending.threadId !== threadId) ||
            (pending.turnId && turnId && pending.turnId !== turnId)
          )
          if (conflicts) pending.identityConflict = true
          else {
            if (!pending.threadId && threadId) pending.threadId = threadId
            if (!pending.turnId && turnId) pending.turnId = turnId
          }
        } else {
          this.pendingWatchdogIdentity = {
            proc: p,
            threadId,
            turnId,
            turnCounter: this.watchdogOpeningTurnCounter,
          }
        }
      }
      const total = snapshot.totalUsage
      if (this.usageTotalsSeedUnknown && !total) {
        this.currentTurnUsageBaseline = null
        this.currentTurnUsageBaselineKnown = false
        return
      }
      this.currentTurnUsageBaseline = total ? { ...total } : null
      this.currentTurnUsageBaselineKnown = true
    })
    on('turn_input_error', ({ error, displayError }) => {
      logError('session: native input processing failed', error)
      void feishu.sendTextRaw(this.chatId, `⚠️ ${this.backendLabel(p.provider)} 输入处理错误：${displayError ?? error}`)
    })
    on('user_input_consumed', ({ inputId }) => this.onSteeringInputConsumed(p, epoch, inputId))
    on('input_batch_end', () => {})
    on('thinking_progress', () => {})
    on('token_usage', ({ totalUsage }: TokenUsageUpdated) => {
      this.persistResumableSessionId(false, p)
      if (totalUsage) this.usageTotalsSeedUnknown = false
    })
    on('turn_plan_updated', (plan: TurnPlanUpdated) => {
      this.handleTurnPlanUpdated(p, plan)
    })
    on('plan_delta', (delta: PlanDelta) => {
      this.handlePlanDelta(p, delta)
    })
    on('context_compacted', (notice: ContextCompactedNotification) => {
      this.handleContextCompacted(p, notice)
    })
    // Native Codex owners publish quota-change signals to the shared live
    // reader. Rolling payloads never directly update the account snapshot.
    on('thread_goal_updated', (goal: ThreadGoal) => {
      this.handleThreadGoalUpdated(p, goal)
    })
    on('thread_goal_cleared', () => {
      this.handleThreadGoalCleared(p)
    })
    on('assistant_text', ({ text, displayText, parentToolUseId }: { text: string; displayText?: string; parentToolUseId: string | null }) => {
      // SDK/CLI 若转发子 Agent assistant 正文，会在 parentToolUseId 上标归属；
      // 其工具已进共享任务面板，正文同样不得泄漏进主对话卡。后台任务的可见进度/
      // 终稿由 task_progress/task_notification 权威事件承载。
      if (parentToolUseId) return
      if (text.trim()) this.observeWatchdogMeaningful(p, 'assistant_text')
      this.appendAssistant(displayText ?? text)
    })
    on('assistant_block_stop', ({ parentToolUseId }: { parentToolUseId: string | null }) => {
      if (parentToolUseId) return
      // 一段 content block 收尾(SSE content_block_stop)→ 把当前 assistant 段
      // 静态化成完整 markdown,然后 reset 段游标让下一段开新元素。这条 emit 在该段最后一个
      // text_delta 之后同步到达(codex-process 按 stdout 行序 emit),所以
      // appendAssistant 已把全量累进 currentAssistantText,这里定稿拿到的是完整段。
      this.finalizeCurrentAssistantSegment()
      // 主线程定稿一段 assistant = 主 agent 在继续说话、没在等 pending task → 提升后台入卡。
      this.onMainThreadAdvance()
    })
    on('tool_use', ({ id, name, input, displayInput, parentToolUseId }) => {
      const shownInput = displayInput ?? input
      // 子 agent 内的工具调用(parentToolUseId 非空)不上主卡 —— 只累积进对应后台
      // task 的 steps[](后台卡展开可见)。与 codex 侧 isSubagentThread 分流同构:
      // 主卡只承载主 agent,子 agent 过程不把主卡面板数刷爆。parentToolUseId 无
      // 归属 task(如 canUseTool 合成的 AskUserQuestion)不在此列,仍走主卡。
      if (parentToolUseId && this.bgTaskOwns(parentToolUseId)) {
        this.applyBgStore(cards.applyBgToolUse(
          { active: this.backgroundTasks, pending: this.pendingBgTasks },
          parentToolUseId, id, name, shownInput,
        ))
        this.onBackgroundTaskChanged()
        return
      }
      if (!parentToolUseId && (name === 'Task' || name === 'Agent'
        || p.provider === 'dsh' && (name === 'subagent' || name === 'subagent_fork'))) {
        const turn = this.currentTurn
        if (turn) {
          this.startWorkingFooter(turn)
          this.finalizeCurrentAssistantSegment()
          turn.openBatchI = null
          turn.taskCreateI = null
          turn.taskUpdateI = null
        }
        this.onMainThreadAdvance()
        this.nativeAgentTools.set(id, { confirmed: false, input, displayInput })
        // Codex exposes each child separately through collab lifecycle events.
        // Claude's native tool is itself the initial task until task_started
        // supplies its SDK id. Both paths keep launch details off the main card.
        if (p.provider === 'claude') {
          this.lastMainTaskToolUseId = id
          this.applyBgStore(cards.applyBgTaskStarted(this.bgStore(), {
            task_id: id, tool_use_id: id, task_type: 'subagent',
            description: shownInput?.description || shownInput?.name || '子 Agent',
            prompt: shownInput?.prompt, subagent_type: input?.subagent_type,
          }))
          this.onBackgroundTaskChanged(true)
        }
        return
      }
      sessionTools.addTool(this, p, id, name, input, displayInput)
      // 主线程发起新 tool_use = 主 agent 没在等 pending 里的 task → 它们是后台,提升入卡。
      // 前台 task 的 settled 先于主线程下一个 tool_use 到达,pending 已空,不会误提。
      if (!parentToolUseId) this.onMainThreadAdvance()
    })
    on('tool_result', ({ tool_use_id, content, displayContent, displayInput, is_error, parentToolUseId, input }: any) => {
      const shownContent = displayContent ?? content
      // 子 agent 内的工具结果同 tool_use:只回填后台 task steps,不上主卡面板。
      if (parentToolUseId && this.bgTaskOwns(parentToolUseId)) {
        this.applyBgStore(cards.applyBgToolResult(
          { active: this.backgroundTasks, pending: this.pendingBgTasks },
          parentToolUseId, tool_use_id, shownContent, is_error,
        ))
        this.onBackgroundTaskChanged()
        return
      }
      const nativeTool = !parentToolUseId && this.nativeAgentTools.get(tool_use_id)
      if (nativeTool) {
        this.nativeAgentTools.delete(tool_use_id)
        if (this.lastMainTaskToolUseId === tool_use_id) this.lastMainTaskToolUseId = null
        // A background launch receipt is not the child's result. Only an
        // unbound synchronous invocation or a failed launch settles here.
        if (is_error || p.provider === 'claude' && !nativeTool.confirmed && nativeTool.input?.run_in_background !== true) {
          const output = typeof shownContent === 'string' ? shownContent : Array.isArray(shownContent)
            ? shownContent.map((block: any) => typeof block?.text === 'string' ? block.text : JSON.stringify(block)).join('\n')
            : JSON.stringify(shownContent) ?? 'MISS'
          let task = this.backgroundTasks.find(entry => entry.toolUseId === tool_use_id)
          if (!task) {
            this.applyBgStore(cards.applyBgTaskStarted(this.bgStore(), {
              task_id: tool_use_id, tool_use_id, task_type: 'subagent',
              description: (nativeTool.displayInput ?? nativeTool.input)?.description || '子 Agent', prompt: (nativeTool.displayInput ?? nativeTool.input)?.prompt,
            }))
            task = this.backgroundTasks.find(entry => entry.toolUseId === tool_use_id)!
          }
          this.applyBgStore(cards.applyBgTaskSettled(this.bgStore(), {
            task_id: task.id, status: is_error ? 'failed' : 'completed', summary: output,
          }))
          this.onBackgroundTaskChanged(true)
        }
        sessionTools.startThinkingIfNoToolsRunning(this)
        return
      }
      sessionTools.completeTool(this, p, tool_use_id, content, is_error, input, displayContent, displayInput)
    })
    on('subagent_activity', (activity: {
      activityId: string
      agentThreadId: string
      agentPath: string | null
      kind: string
    }) => {
      const context = this.watchdogContext
      const contextIsCurrent = !!context && context.proc === p && this.watchdogContextIsCurrent(context)
      const terminal = activity?.kind === 'interrupted'
      if (
        this.proc !== p ||
        typeof activity?.activityId !== 'string' ||
        typeof activity?.agentThreadId !== 'string' ||
        (!contextIsCurrent && !terminal) ||
        this.codexSubagentActivityIds.has(activity.activityId)
      ) return
      this.codexSubagentActivityIds.add(activity.activityId)
      if (activity.kind === 'started') this.activeCodexSubagentActivities.add(activity.agentThreadId)
      if (terminal && !this.codexCollabAgentStates.has(activity.agentThreadId)) {
        this.activeCodexSubagentActivities.delete(activity.agentThreadId)
      }
      if (contextIsCurrent) this.observeWatchdogMeaningful(p, `subagent_activity:${activity.kind || 'unknown'}`)
    })
    on('collab_agent_state', ({ toolUseId, agentsStates }: { toolUseId: string; agentsStates: CollabAgentStates }) => {
      if (this.proc !== p || typeof toolUseId !== 'string' || !toolUseId) return
      const context = this.watchdogContext
      const contextIsCurrent = !!context && context.proc === p && this.watchdogContextIsCurrent(context)
      const entries = collabAgentEntries(agentsStates)
      if (!contextIsCurrent) {
        const terminalAgents = entries
          .filter(([, status]) => TERMINAL_COLLAB_AGENT_STATES.has(status))
          .map(([agentThreadId]) => agentThreadId)
        if (terminalAgents.length === 0) return
        removeCollabAgentsFromAllPools(this.codexCollabAgentStatesByTool, terminalAgents)
        this.codexCollabAgentStates = flattenCollabAgentStates(this.codexCollabAgentStatesByTool)
        for (const agentThreadId of terminalAgents) {
          if (!this.codexCollabAgentStates.has(agentThreadId)) {
            this.activeCodexSubagentActivities.delete(agentThreadId)
          }
        }
        return
      }
      const beforeMap = stringMapSignature(this.codexCollabAgentStates)
      const beforePools = collabAgentPoolsSignature(this.codexCollabAgentStatesByTool)
      const beforeActive = stringSetSignature(this.activeCodexSubagentActivities)
      const nextPool = new Map<string, string>()
      const terminalAgents = new Set<string>()
      for (const [agentThreadId, status] of entries) {
        if (TERMINAL_COLLAB_AGENT_STATES.has(status)) {
          terminalAgents.add(agentThreadId)
          continue
        }
        nextPool.set(agentThreadId, status)
      }
      if (nextPool.size > 0) this.codexCollabAgentStatesByTool.set(toolUseId, nextPool)
      else this.codexCollabAgentStatesByTool.delete(toolUseId)
      removeCollabAgentsFromAllPools(this.codexCollabAgentStatesByTool, terminalAgents)
      this.codexCollabAgentStates = flattenCollabAgentStates(this.codexCollabAgentStatesByTool)
      for (const agentThreadId of terminalAgents) {
        if (!this.codexCollabAgentStates.has(agentThreadId)) {
          this.activeCodexSubagentActivities.delete(agentThreadId)
        }
      }
      if (
        beforeMap !== stringMapSignature(this.codexCollabAgentStates) ||
        beforePools !== collabAgentPoolsSignature(this.codexCollabAgentStatesByTool) ||
        beforeActive !== stringSetSignature(this.activeCodexSubagentActivities)
      ) {
        this.observeWatchdogMeaningful(p, 'collab_agent_state')
      }
    })
    on('can_use_tool', (req: CanUseToolRequest) => {
      sessionPermission.renderPermission(this, req)
    })
    on('hook_callback', (req: HookCallbackRequest) => {
      // No hooks registered → fail-safe ack.
      this.proc?.sendHookResponse(req.request_id, {})
    })
    p.on('context_window_degraded', ({ routeKey, model, contextWindow }: {
      routeKey: string; model: string; contextWindow: number
    }) => {
      if (this.proc !== p) return
      // 爆窗/1214 自愈降级只发生一次(首次置位),用户可见告知回退语义;
      // 恢复 [1m] 记账需重启 daemon 重探。
      void feishu.sendTextRaw(
        this.chatId,
        `⚠️ ${routeKey} 触发爆窗/模型名降级:${model} 本轮报错,分母回 ${Math.round(contextWindow / 1000)}K,后续轮次自动回退裸名(重启 daemon 恢复 [1m] 记账)`,
      ).catch(() => {})
    })
    on('result', (result: any, snapshot) => {
      if (processUsesClaudeTranslation(p) && result?.subtype === 'claude_turn_start_failed') {
        // Async validation can reject before native init/turn_started consumes
        // the claim. Return it so the next native turn is not misattributed.
        this.pendingUserMessageCount = Math.max(0, this.pendingUserMessageCount - 1)
      }
      const event: AgentResultEvent = (result ?? {}) as AgentResultEvent
      this.releaseUnconsumedSteering(p)
      const deliveryContext = this.matchingHumanDeliveryResult(p, event ?? {})
      const ownsHumanTurn = this.resultOwnsCurrentHumanTurn(p, event ?? {}, deliveryContext)
      if (!ownsHumanTurn && this.activeTurnInterrupt?.proc !== p) {
        logDiagnostic("session: ignore stale")
        return
      }
      const rejectedHumanStart = deliveryContext?.state === 'pending' &&
        event?.subtype === 'codex_turn_start_failed'
      if (deliveryContext?.state === 'pending') {
        if (rejectedHumanStart) {
          this.restoreHumanDelivery(deliveryContext)
        } else {
          this.commitHumanDelivery(deliveryContext)
        }
      }
      if (
        !rejectedHumanStart &&
        deliveryContext?.state === 'acked' &&
        this.ackedHumanDelivery === deliveryContext
      ) {
        this.ackedHumanDelivery = null
      }
      if (rejectedHumanStart) {
        this.persistResumableSessionId(false, p)
        if (this.openingTurn) this.sawResultWhileOpening = true
        if (this.openingTurnOwner && 'sawResult' in this.openingTurnOwner) this.openingTurnOwner.sawResult = true
        const rejectDetail = [
          event?.error,
          event?.subtype,
          p.lastResult?.subtype,
        ].map(v => (typeof v === 'string' ? v : '')).join(' ')
        const capacityReject = isCodexCapacityError(rejectDetail)
        logDiagnostic("session: Codex human turn/start rejected; preserve batch without automatic drain capacity")
        // 文案只反映进程层给的节奏:容量拒绝路径由进程层排退避并在结算后 emit
        // turn_retry,这里读事件携带的 delayMs,不再自带固定 60s 承诺(D-07)。
        const retryDelayMs = p.turnRetry?.delayMs ?? null
        void this.closeTurnCard(
          capacityReject
            ? (retryDelayMs === null
                ? '⚠️ Codex 模型容量不足'
                : `⚠️ Codex 模型容量不足，${Math.round(retryDelayMs / 1000)}s 后自动重试`)
            : '⚠️ Codex 未接受消息，已保留待重试',
          {
            forcePush: true,
            hasFreshResult: true,
            preservePendingReactions: true,
          },
        )
        this.status = 'idle'
        // 不在此排重试:容量拒绝的退避由进程层在结算交付后排定(2e6e1e0,D-07)。
        return
      }
      const pendingInterrupt = this.activeTurnInterrupt
      const interrupted = this.settleTurnInterrupt(p, 'result')
      if (interrupted?.source === 'user') {
        this.discardOrphanAssistant()
        this.bgResumePending = false


        logDiagnostic("session: SDK result after user stop subtype")
        this.status = 'idle'
        return
      }
      if (
        interrupted?.source === 'watchdog_recover' ||
        interrupted?.source === 'watchdog_exhausted' ||
        interrupted?.source === 'tool_failure_loop'
      ) return
      if (pendingInterrupt?.proc === p) {
        if (this.activeTurnInterrupt === pendingInterrupt) {
          this.cancelTurnInterrupt('result no longer owns captured turn')
        }
        logDiagnostic("session: ignore unmatched")
        return
      }
      const resumePersistenceError = this.persistResumableSessionId(false, p)
      // 首个 claude result = fork materialize 成功证据(4185808,挂账 #2):绑定
      // 推进成功才消费 durable marker;推进失败保留 marker 供重启恢复。
      const pendingPersistenceError = resumePersistenceError || p.provider !== 'claude'
        ? null
        : this.consumePendingConversationMaterialization()
      const persistenceError = [resumePersistenceError, pendingPersistenceError].filter(Boolean).join('；') || null
      this.accumulateResultStats(snapshot)
      // 仅后端显式给出本轮 clean checkpoint 时记锚点;失败/中断/畸形 result
      // 不得复用上一轮 checkpoint(4185808:A checkpoint belongs to exactly
      // one clean turn)。
      const checkpointError = event?.is_error !== true
        ? this.recordTurnAnchor(event?.checkpoint as ConversationCheckpoint | null | undefined)
        : null
      if (event?.is_error === true) this.lastTurnUserPreview = ''
      // result 抢在 openTurnCard 的 await 窗口内到达:标记给开卡 IIFE,
      // 它落地后据此立即收尾(否则卡片悬挂、session 卡在 working)。
      if (this.openingTurn) this.sawResultWhileOpening = true
      if (this.openingTurnOwner && 'sawResult' in this.openingTurnOwner) this.openingTurnOwner.sawResult = true
      // 整轮无卡且不在开卡中(恢复轮开卡失败):孤儿正文纯文本兜底。开卡
      // 窗口内(openingTurn)不 flush —— 让 openTurnCard 把缓冲并入卡片,
      // 避免又推一遍。有卡的轮次已在开卡时并入,这里 flush 为 no-op。
      if (!this.currentTurn && !this.openingTurn) this.flushOrphanAssistantToChat('result with no turn card')
      const hasMidTurn = this.pendingMidTurnMsgs.length > 0
      const isError = snapshot.result.is_error === true
      const subtype = snapshot.result.subtype ?? 'success'
      const failureText = result?.displayError ?? result?.error
      const failureDetail = typeof failureText === 'string' && failureText.trim() ? failureText.trim() : subtype
      const hostAskFlowActive = this.pendingHostAsks.size > 0
      const capacityError = isError && (
        isCodexCapacityError(subtype)
        || isCodexCapacityError(event?.error)
        || isCodexCapacityError(event?.subtype)
      )

      let suffix: string | undefined
      let forcePush = false

      const backend = this.proc ? this.backendLabel(this.proc.provider) : this.backendLabel()
      // 恢复绑定/锚持久化失败优先于常规收尾文案(4185808):状态没落盘对用户
      // 是数据风险,必须在卡面可见并强推。
      const stateError = [persistenceError, checkpointError].filter(Boolean).join('；') || null
      if (stateError) {
        suffix = `⚠️ ${stateError}`
        forcePush = true
      } else if (hasMidTurn && !hostAskFlowActive) {
        suffix = isError
          ? (capacityError
            ? `⚠️ ${backend} 模型容量不足,用户已介入`
            : `⚠️ ${backend} ${failureDetail},用户已介入`)
          : '📨 转交新卡'
      } else if (isError) {
        // 容量文案只承诺进程层真实排定的节奏:能走到这条 result 说明进程层未接管
        // 退避(否则不发 result),proc.turnRetry 为空时不给 60s 幻觉(D-07)。
        const retryDelayMs = p.turnRetry?.delayMs ?? null
        suffix = capacityError
          ? (retryDelayMs === null
              ? `⚠️ ${backend} 模型容量不足`
              : `⚠️ ${backend} 模型容量不足，${Math.round(retryDelayMs / 1000)}s 后自动重试`)
          : `⚠️ ${backend} ${failureDetail}`
        forcePush = true
      }

      // result 落在开卡 await 窗口:suffix/forcePush 挂 owner token,开卡 IIFE
      // 的 deferred close 消费(ff44afb owner.terminalSuffix/terminalForcePush,
      // 04-05 甄别 #13 最小集)——下方 closeTurnCard 此刻对 null turn 空转,
      // 不挂载荷这份终态文案就随竞态丢失。
      if (this.openingTurnOwner) {
        this.openingTurnOwner.terminalSuffix = suffix
        this.openingTurnOwner.terminalForcePush = forcePush
      }

      if (stateError && !this.currentTurn && !this.openingTurn) {
        void feishu.sendTextRaw(this.chatId, `⚠️ ${stateError}`)
      }

      if (isError) logError('session: Agent turn failed', failureDetail)
      void this.closeTurnCard(suffix, { forcePush, hasFreshResult: true }).catch(e => {
        logError('session: result card close failed', e)
      })
      this.status = 'idle'
      sessionHostAsk.resumeAnsweredHostAsks(this)

      if (!isError) {
        // 干净成功 result:清掉 capacity 连续重试计数。
        this.clearCapacityRetryState('success_result')
      }

      if (hasMidTurn && !hostAskFlowActive) {
        // 用户已介入:真人消息优先;重试节奏归进程层(D-07),这里不再排任何计时器。
        if (capacityError) this.clearCapacityRetryState('user_midturn_priority')
        void this.drainMidTurnAndOpen().catch(e => {
          logError('session: mid-turn drain failed', e)
        })
      }
    })
    p.on('bg_task_started', (e: BgTaskStartedEvent) => {
      if (this.proc !== p) return
      const before = backgroundWatchdogSignature(this.backgroundTasks, this.pendingBgTasks)
      // SDK 若没填 tool_use_id,用最近的主线程 Task tool_use id 兜底 —— 子 agent 消息
      //  的 parent_tool_use_id 等于它,据此才能把 steps 关联到 task。
      const toolUseId = e.tool_use_id ?? (p.provider === 'claude' ? this.lastMainTaskToolUseId : null) ?? undefined
      const nativeTool = toolUseId ? this.nativeAgentTools.get(toolUseId) : undefined
      if (nativeTool) nativeTool.confirmed = true
      logDiagnostic("session: bg_task_started")
      this.applyBgStore(cards.applyBgTaskStarted(this.bgStore(), { ...e, ...e.display, tool_use_id: toolUseId }))
      if (before !== backgroundWatchdogSignature(this.backgroundTasks, this.pendingBgTasks)) {
        this.observeWatchdogMeaningful(p, 'bg_task_started')
      }
      this.onBackgroundTaskChanged(true)
    })
    p.on('bg_task_progress', (e: BgTaskProgressEvent) => {
      if (this.proc !== p) return
      const before = backgroundWatchdogSignature(this.backgroundTasks, this.pendingBgTasks)
      this.tryResurrectBgTask(e.task_id, 'progress')
      this.applyBgStore(cards.applyBgTaskProgress(this.bgStore(), { ...e, ...e.display }))
      if (before !== backgroundWatchdogSignature(this.backgroundTasks, this.pendingBgTasks)) {
        this.observeWatchdogMeaningful(p, 'bg_task_progress')
      }
      this.onBackgroundTaskChanged()
    })
    p.on('bg_task_updated', (e: BgTaskUpdatedEvent) => {
      if (this.proc !== p) return
      const before = backgroundWatchdogSignature(this.backgroundTasks, this.pendingBgTasks)
      logDiagnostic("session: bg_task_updated")
      this.tryResurrectBgTask(e.task_id, 'updated')
      this.applyBgStore(cards.applyBgTaskUpdated(this.bgStore(), { ...e, patch: { ...e.patch, ...e.display } }))
      if (before !== backgroundWatchdogSignature(this.backgroundTasks, this.pendingBgTasks)) {
        this.observeWatchdogMeaningful(p, 'bg_task_updated')
      }
      this.onBackgroundTaskChanged()
    })
    p.on('bg_task_settled', (e: BgTaskSettledEvent) => {
      if (this.proc !== p) return
      const before = backgroundWatchdogSignature(this.backgroundTasks, this.pendingBgTasks)
      logDiagnostic("session: bg_task_settled")
      if (!this.bgTaskKnown(e.task_id)) {
        // 双池都不认识的终态:热续跑全程零运行期事件,只来这一条 task_notification。
        // 命中档案 → 补一次性墓碑卡留痕;未命中(漏 started 的前台命令)维持 no-fallback。
        void this.sendResumedAgentTombstone(e).catch(error => { logError('session: resumed task presentation failed', error) })
      } else {
        this.applyBgStore(cards.applyBgTaskSettled(this.bgStore(), { ...e, ...e.display }))
        this.onBackgroundTaskChanged()
      }
      if (before !== backgroundWatchdogSignature(this.backgroundTasks, this.pendingBgTasks)) {
        this.observeWatchdogMeaningful(p, 'bg_task_settled')
      }
      // turn 已收尾后才结算的任务:Claude SDK 会自发开一轮恢复轮合并结果,
      // 标记给下一个无用户批次的 init 开卡。Codex 的 collab 子 agent 结果由
      // 主 turn 内的 wait 收编,app-server 不会自发开轮 —— 不置位(cf41941 #11)。
      if (p.provider === 'claude' && !this.currentTurn && !this.openingTurn && this.initCount >= 1) {
        this.bgResumePending = true
      }
    })
    p.on('subagent_step', (e: { thread_id: string; item_id: string; tool: string; phase: 'started' | 'completed'; brief: string }) => {
      if (this.proc !== p) return
      // Codex 子 agent 的过程步骤 → 后台卡 steps(主卡不承载,见 codex-process
      // isForeignThread 分流)。未知 thread(先于 started 到达的极早期)丢弃
      // (applySubagentStep 对无归属 thread 返回原 store 引用)。
      this.applyBgStore(cards.applySubagentStep(this.bgStore(), e.thread_id, e.item_id, e.tool, e.phase, e.brief))
      this.onBackgroundTaskChanged()
    })
    // ── 模型拒绝 / 降级(SDK system/model_refusal_*,仅 Claude 后端 emit)──────
    // 主模型 refusal 后:session=主线程换模型(整个会话);local=子agent/副问/后台
    // fork 局部降级,主会话模型不变。no_fallback=未配备用模型,本轮失败。
    p.on('model_refusal_fallback', (e: ModelRefusalFallbackEvent) => {
      if (this.proc !== p) return
      const turn = this.currentTurn
      if (!turn || turn.provider !== 'claude') {
        logDiagnostic("session: model_refusal_fallback with no active claude turn (scope")
        return
      }
      // 幂等:每 turn 只 surfaced 第一次,避免重复/噪音。
      if (turn.modelFallbackNotice) return
      const orig = e.original_model || '?'
      const fb = e.fallback_model || '?'
      const notice = e.scope === 'local'
        ? `🔄 子任务降级 ${orig}→${fb}`
        : `🔄 模型降级 ${orig}→${fb}`
      this.applyModelFallbackNotice(turn, notice)
    })
    p.on('model_refusal_no_fallback', (e: ModelRefusalNoFallbackEvent) => {
      if (this.proc !== p) return
      const turn = this.currentTurn
      if (!turn || turn.provider !== 'claude') {
        logDiagnostic("session: model_refusal_no_fallback with no active claude turn — ignored")
        return
      }
      if (turn.modelFallbackNotice) return
      const orig = e.original_model || '?'
      this.applyModelFallbackNotice(turn, `⚠️ ${orig} 拒绝,未降级`)
    })
    p.on('exit', ({ code, signal, expected }: any) => {
      logDiagnostic("session: exited")
      if (this.stoppingProc === p || this.blockedProc === p) {
        if (this.blockedProc === p) {
          const materializationFailure = p.conversationMaterializationFailure?.()
          const persistenceFailure = this.persistResumableSessionId(false, p, false)
          const lateStateFailure = [
            materializationFailure && p.isConversationResumable?.() !== true
              ? `Codex 会话落盘确认失败: ${messageOf(materializationFailure)}`
              : null,
            persistenceFailure,
          ].filter(Boolean).join('；')
          if (lateStateFailure) {
            void feishu.sendTextRaw(this.chatId, `⚠️ 旧进程退出后的恢复状态收尾失败: ${lateStateFailure}`)
          }
          this.discardPendingCodexTurnAnchors(p, 'blocked process finally exited')
        }
        logDiagnostic("session: blocked/stopping")
        // 合并调和(取舍):上游同位径直 status='stopped' + OLC。本地冻结语义
        // (main kill 前预置 proc=null → exit stale 早退,不写不报)要求在途
        // stop/restart 事务的 kill await 窗口内到达的 exit 不额外写状态/上报:
        // 事务收口自身必然写状态并触发 OLC(stop 3140/3240 两次;restart 成功
        // 3788 或失败 3600/3643/3745/3773),此处再报一次会让本地用例
        // 'real strict restart init failure cannot mutate a newer process owner'
        // / '...post-init ownership loss...' 的 lifecycleChanges===0 多计一次。
        // 真正滞后的确认退出(无在途 kill,blockedProc 已在位 —— 上游
        // 'stop clears visible state but keeps an unconfirmed process blocked
        // until its real exit' 场景)仍是无人代报的独立状态迁移,按上游写状态
        // 并上报。stoppingProc 在位 ⇔ beginProcStop 后 finishProcStop 未收口
        // (kill await 在途),detachProc 会清它,故先取快照。
        const killInFlight = this.stoppingProc === p
        this.detachProc(p)
        if (killInFlight) return
        this.status = 'stopped'
        this.opts.onLifecycleChange?.()
        return
      }
      // 进程已死:它的延迟锚永远无法经 persist→flush 落盘,立即丢弃防幽灵锚
      // (挂账 #3 收尾口;stop/restart 的 kill 路径亦有兜底 discard)。
      this.discardPendingCodexTurnAnchors(p, expected ? 'confirmed process exit' : 'unexpected process exit')
      void this.cancelAgentRuns(`${p.provider} process exited`).catch(error => {
        logError('session: cancel Agent runs after process exit failed', error)
      })
      const pendingDelivery = this.pendingHumanDelivery?.proc === p
        ? this.pendingHumanDelivery
        : null
      const alreadyRestoredDelivery = this.restoredHumanDelivery?.proc === p
        ? this.restoredHumanDelivery
        : null
      const restoredHumanDelivery = pendingDelivery
        ? this.restoreHumanDelivery(pendingDelivery)
        : alreadyRestoredDelivery !== null
      const ackedHumanDelivery = this.ackedHumanDelivery?.proc === p &&
        this.ackedHumanDelivery.state === 'acked'
        ? this.ackedHumanDelivery
        : null
      const preservedRecovery = this.preservedWatchdogRecovery
      if (preservedRecovery?.replacementProc === p) {
        preservedRecovery.replacementProc = null
        preservedRecovery.phase = 'failed'
        if (this.proc === p) {
          this.proc = null
          this.status = 'stopped'
          this.opts.onLifecycleChange?.()
          logDiagnostic("session: preserving restart replacement exit latched recovery failure")
        } else {
          logDiagnostic("session: ignore stale preserving restart replacement exit")
        }
        return
      }
      const pendingInterrupt = this.activeTurnInterrupt
      const interrupted = this.settleTurnInterrupt(p, 'exit')
      if (
        interrupted?.source === 'watchdog_recover' ||
        interrupted?.source === 'watchdog_exhausted' ||
        interrupted?.source === 'tool_failure_loop'
      ) {
        this.proc = null
        // 死进程的 ask/permission 定义上已死(见普通 exit 路径注释);
        // 恢复流程随后可能 restart,但 restart 可能失败或被测试 mock,
        // 这个分支自身必须完成清理。
        this.pendingAsks.clear()
        this.pendingHostAsks.clear()
        this.pendingPermissions.clear()
        this.status = 'stopped'
        this.opts.onLifecycleChange?.()
        return
      }
      if (!interrupted && pendingInterrupt?.proc === p && this.activeTurnInterrupt === pendingInterrupt) {
        this.cancelTurnInterrupt('process exit no longer owns captured turn')
      }
      const watchdogAction = this.watchdogAction
      if (watchdogAction && watchdogAction.proc === p && this.proc === p) {
        this.proc = null
        this.pendingAsks.clear()
        this.pendingHostAsks.clear()
        this.pendingPermissions.clear()
        const recovery = this.preserveWatchdogRecovery(watchdogAction)
        if (recovery) this.markPreservedWatchdogRecoveryFailed(recovery, watchdogAction.lease)
        this.status = 'stopped'
        this.opts.onLifecycleChange?.()
        logDiagnostic("session: captured watchdog process exit latched recovery failure")
        // 只终结本次 action 捕获的 turn(同步前缀立即摘下台面,卡片异步
        // 写终态);不得读可变 currentTurn —— replacement turn 归新 owner。
        void this.terminalizeDetachedTurn(watchdogAction.turn, {
          footerContent: watchdogFooterContent('failed'),
          settingsSuffix: watchdogFooterContent('failed'),
          rawFallback: watchdogFooterContent('failed'),
        }).catch(_e => logError("session: detached watchdog card terminalization failed", _e))
        return
      }
      if (this.proc !== p) {
        if (ackedHumanDelivery && this.ackedHumanDelivery === ackedHumanDelivery) {
          this.ackedHumanDelivery = null
        }
        if (this.restoredHumanDelivery?.proc === p) this.restoredHumanDelivery = null
        logDiagnostic("session: ignore stale")
        return
      }
      if (restoredHumanDelivery) {
        this.proc = null
        this.flushOrphanAssistantToChat('process exit with preserved human delivery')
        this.bgResumePending = false
        this.bgResumeCardless = false
        this.sawResultWhileOpening = false
        this.stopFooterStatus(this.currentTurn)
        this.currentTurn = null
        this.clearWatchdogRuntime('process exit with preserved human delivery')
        this.pendingUserMessageCount = 0
        this.pendingTurnInputs = []
        // 当轮批次的 ⏳ 先删再重置(与普通 exit 路径对齐)—— 保留的
        // pending 投递持有自己的 reactions,不在这个 map 里。
        for (const [msgId, reactionId] of this.currentBatchReactionIds) {
          if (reactionId) void feishu.deleteReaction(msgId, reactionId)
        }
        this.currentBatchReactionIds = new Map()
        this.initCount = 0
        this.clearTurnOpening()
        // 与普通 exit 路径同样必须清僵尸 ask/permission(见下方注释):
        // 保留的是真人消息,不是死进程的问答状态;不清的话恢复后每条
        // 消息都会被 onAskMessageAnswer 当僵尸答案吞掉。
        this.pendingAsks.clear()
        this.pendingHostAsks.clear()
        this.pendingPermissions.clear()
        this.currentTurnUsageBaseline = null
        this.currentTurnUsageBaselineKnown = false
        this.usageTotalsSeedUnknown = false
        this.status = 'stopped'
        if (this.restoredHumanDelivery?.proc === p) this.restoredHumanDelivery = null
        this.opts.onLifecycleChange?.()
        if (!expected && code !== 0 && signal !== 'SIGTERM') {
          void feishu.sendText(this.chatId, `⚠️ ${this.backendLabel(p.provider)} 异常退出 (code=${code}, signal=${signal})。真人消息已保留，回复任意消息将重新启动。`)
        }
        return
      }
      // (上游 4065 同位)意外退出必须把在途主卡终结到终态 footer/关流,
      // 不能停在 streaming 态。closeTurnCard 在首个 await 前同步摘掉
      // currentTurn,所以先启动再 detach;expected 退出同样收口('🛑 …已退出')。
      // 合并调和(取舍):本地旧路径只 stopFooterStatus + 摘 currentTurn,
      // 依赖上游用例 'unexpected exit terminalizes the main card…(code=0
      // SIGTERM)' 要求 footer/settings 落地,此处吸收上游收口。
      if (this.currentTurn) {
        const terminalSuffix = expected
          ? `🛑 ${this.backendLabel(p.provider)} 已退出`
          : `⚠️ ${this.backendLabel(p.provider)} 异常退出 (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
        void this.closeTurnCard(terminalSuffix).catch(e => {
          logError('session: process-exit current main-card close failed', e)
        })
      }
      // 在途 turn close 先等落地再走终态清理(上游 4075 同位);失败只记日志,
      // 不让 exit 清理被一张卡的收尾错误拖垮。
      const turnClose = this.waitForTurnCloses()
        .catch(e => {
          logError('session: process-exit main-card close failed', e)
        })
      this.proc = null
      // 进程死了,残留的孤儿正文再不兜底就永远丢了(非用户主动停止的崩溃
      // 路径;stop/restart 已在 kill 前 null 掉 this.proc,走上面的 stale
      // 早退不到这里)。
      this.flushOrphanAssistantToChat('process exit')
      this.bgResumePending = false
      this.bgResumeCardless = false
      this.sawResultWhileOpening = false
      this.stopFooterStatus(this.currentTurn)
      this.currentTurn = null
      this.clearWatchdogRuntime('process exit')
      this.clearMultiMsgBuffer('process exit')
      this.pendingUserMessageCount = ackedHumanDelivery
        ? Math.max(1, this.pendingUserMessageCount)
        : 0
      if (!ackedHumanDelivery) this.pendingMidTurnMsgs = []
      this.pendingTurnInputs = []
      if (!ackedHumanDelivery) {
        this.lastUserOpenId = ''
        this.releaseAllReactions()
      } else {
        for (const [msgId, reactionId] of this.currentBatchReactionIds) {
          if (reactionId) void feishu.deleteReaction(msgId, reactionId)
        }
        this.currentBatchReactionIds = new Map()
        if (this.ackedHumanDelivery === ackedHumanDelivery) this.ackedHumanDelivery = null
      }
      this.initCount = 0
      this.invalidateTurnOpen()
      // 进程没了 ⇒ 任何 pending ask 都不可能再收到 can_use_tool 或回传答案,
      // 定义上已死。不清的话 hasPendingAsk() 恒 true,后续每条消息都被
      // onAskMessageAnswer 当僵尸答案吞掉,session 焊死到下次 daemon 重启
      // (kill/restart 同样在上面补了这一清理)。
      this.pendingAsks.clear()
      this.pendingHostAsks.clear()
      this.pendingPermissions.clear()
      this.currentTurnUsageBaseline = null
      this.currentTurnUsageBaselineKnown = false
      this.usageTotalsSeedUnknown = false
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      void this.runLifecycle('process-exit-cleanup', async () => {
        const backend = this.backendLabel(p.provider)
        const exitDetail = `code=${code ?? 'null'}, signal=${signal ?? 'null'}`
        const settled = await Promise.allSettled([
          turnClose,
          this.resetBackgroundTasks(),
        ])
        for (const outcome of settled) {
          if (outcome.status === 'rejected') {
            logError('session: process-exit terminal cleanup failed', outcome.reason)
          }
        }
        // `expected` is the process wrapper's explicit contract. Every exit
        // it marks unexpected is user-visible, including code=0 or SIGTERM;
        // filtering those values hid real upstream shutdowns in the past.
        if (!expected) {
          await feishu.sendText(
            this.chatId,
            `⚠️ ${backend} 异常退出 (${exitDetail})。回复任意消息将重新启动。`,
          )
        }
      }).catch(e => {
        logError('session: process-exit cleanup rejected', e)
      })
    })
  }

  /** Pull per-turn numbers off `proc.lastResult` (set by CodexProcess when
   * the `result` message landed) and roll them into cumStats + the
   * "上一轮" delta. Turn usage uses absolute thread totals from
   * `thread/tokenUsage/updated.total` minus the baseline captured at
   * `turn_started`, so a multi-request turn is aggregated correctly
   * instead of inheriting only the final request's `last` snapshot.
   * Called exactly once per result event, right before closeTurnCard. */
  private accumulateResultStats(snapshot?: { result: CodexResultMeta; totalUsage: CodexUsage | null }): void {
    const r = snapshot?.result ?? this.proc?.lastResult
    if (!r) return
    // Claude result.usage is scoped to the just-finished SDK query; after a
    // resumed session starts with no local total baseline, this is the only
    // accurate per-turn figure we have.
    const u = this.currentTurnUsageBaselineKnown
      ? diffUsageTotals(snapshot ? snapshot.totalUsage : this.proc?.lastTotalUsage, this.currentTurnUsageBaseline)
      : this.proc?.provider === 'claude' && r.usage
        ? { ...r.usage }
        : null
    this.lastTurnUsage = u
    this.currentTurnUsageBaseline = null
    this.currentTurnUsageBaselineKnown = false
    // 有效 token = 真正喂进(input + 本轮新建缓存)+ 产出。故意不含
    // cache_read_input_tokens —— 那是把整段已缓存上下文又复读一遍的计费量,
    // 每轮几乎等于全窗口,计进来会让累计虚高一个量级。这里的 usage 是
    // 整个 turn 的绝对总量差值,不是最后一次模型请求的快照。
    const tokens = effectiveTurnTokens(u)
    // Claude subscription/router cost fields are not reliable enough to show
    // as billing. Keep Claude turns token-only even if the SDK sends dollars.
    const costUsd = this.proc?.provider === 'claude' ? 0 : r.cost_delta_usd ?? 0
    const durationMs = r.duration_ms ?? 0
    if (tokens != null) this.cumStats.tokens += tokens
    this.cumStats.costUsd += costUsd
    this.cumStats.turns += r.num_turns ?? 1
    this.lastTurnDelta = { tokens, costUsd, durationMs }
  }

  /** Current context-window occupancy. Claude 路径直接读 SDK modelUsage 算好
   * 的输入侧占用(proc.lastContextTokens = input+cache_read+cache_creation,
   * 不含 output);DSH 同语义(原生 usage 的输入侧占用)。Codex 路径继续用
   * lastUsage.total_tokens。 */
  private currentContextTokens(proc: AgentProcess | null = this.proc): number | null {
    if (proc?.provider === 'claude' || proc?.provider === 'dsh') {
      return proc.lastContextTokens ?? null
    }
    const u = proc?.lastUsage as CodexUsage | null | undefined
    return contextTokensFromUsage(u)
  }

  /** Display denominator for context percentage. Codex: app-server's
   * effective modelContextWindow;Claude: SDK modelUsage.contextWindow。 */
  private contextLimitForDisplay(proc: AgentProcess | null = this.proc): number | null {
    return contextLimitFromAppServer(proc?.lastContextWindow)
  }

  /** Submit without holding the actor: stop and tool answers stay available
   * while the backend acknowledges the write. A rejected/uncertain write is
   * reported, never replayed as a new task. */
  private steerPendingInputs(): void {
    const proc = this.proc
    const turn = this.currentTurn
    if (!proc?.steerUserText || !turn || this.openingTurn
      || this.steeringSend || this.pendingMidTurnMsgs.length === 0 || this.modelSettingsBlockReason()) return
    const epoch = this.procEpoch
    const generation = this.steeringGeneration
    const batch = this.pendingMidTurnMsgs.splice(0)
    const reactions = this.pendingReactionIds
    const inputId = randomUUID()
    const input = { proc, epoch, generation, turn, batch, reactions, consumed: false }
    this.submittedSteering.set(inputId, input)
    let retained = false
    let accepted = false
    const ownsInput = () => this.proc === proc && this.procEpoch === epoch
      && this.steeringGeneration === generation && proc.isAlive()
    const operation = Promise.resolve().then(async () => {
      if (!ownsInput()) return
      const blocked = this.disabledClaudeSourceMessage(proc.tokenSourceId)
      if (blocked) throw new Error(blocked)
      accepted = await proc.steerUserText!(batch.map(msg => msg.wireText).join('\n\n'), [], inputId)
      if (!ownsInput()) return
      if (!accepted) {
        // No request was sent (startup, quota recovery, or native turn ended
        // before dispatch). Preserve FIFO order for the next ready boundary.
        this.pendingMidTurnMsgs.unshift(...batch)
        this.submittedSteering.delete(inputId)
        retained = true
        return
      }
      // Only user_input_consumed owns the rendering boundary. The backend
      // can acknowledge a queued message well before the model sees it.
    }).catch(async error => {
      logError('session: steering input failed', error)
      await feishu.sendTextRaw(this.chatId, `❌ 追加消息${input.consumed ? '已确认进入执行流，但提交回执异常' : '提交未获确认，未自动重发'}：${messageOf(error)}`)
    }).finally(() => {
      turn.steeringInflight?.delete(operation)
      if (this.steeringSend === operation) this.steeringSend = null
      if (!ownsInput()) this.submittedSteering.delete(inputId)
      // Consumption transfers reaction ownership to the supplemental card.
      // A late submit ACK must not clear its waiting marker before that card.
      if (!retained && !input.consumed && !this.submittedSteering.has(inputId)) {
        this.releaseSteeringReactions(input)
      }
      if (!ownsInput()) return
      if (!this.currentTurn && !this.openingTurn && this.pendingMidTurnMsgs.length) {
        void this.drainMidTurnAndOpen().catch(error => logError('session: input drain failed', error))
      } else if (accepted) this.steerPendingInputs()
    })
    this.steeringSend = operation
    ;(turn.steeringInflight ??= new Set()).add(operation)
  }

  private releaseSteeringReactions(input: { batch: Array<{ msgId: string }>; reactions: Map<string, string> }): void {
    for (const msg of input.batch) {
      const rid = input.reactions.get(msg.msgId)
      input.reactions.delete(msg.msgId)
      if (rid) void feishu.deleteReaction(msg.msgId, rid)
    }
  }

  private releaseUnconsumedSteering(proc: AgentProcess): void {
    let count = 0
    for (const [id, input] of this.submittedSteering) {
      if (input.proc !== proc) continue
      this.submittedSteering.delete(id)
      this.releaseSteeringReactions(input)
      count += input.batch.length
    }
    if (count) {
      const message = `本轮已结束，但 ${count} 条追加消息缺少原生处理位置确认，未据此换卡或自动重发。`
      logDiagnostic('session: additional input consumption unconfirmed')
      void feishu.sendTextRaw(this.chatId, `⚠️ ${message}`)
    }
  }

  /** Freeze the presentation at the native input item, not at request ACK.
   * Events after this point retain FIFO order while Feishu creates the card. */
  private onSteeringInputConsumed(proc: AgentProcess, epoch: number, inputId: string): void {
    const input = this.submittedSteering.get(inputId)
    if (!input || input.proc !== proc || input.epoch !== epoch) return
    this.submittedSteering.delete(inputId)
    input.consumed = true
    const { turn, generation } = input
    if (this.currentTurn !== turn || generation !== this.steeringGeneration) {
      this.releaseSteeringReactions(input)
      return
    }
    const pending = this.steeringBoundary
    if (pending?.collecting && pending.turn === turn && pending.proc === proc && pending.epoch === epoch) {
      pending.inputs.push(...input.batch.map(msg => msg.text))
      pending.inputIds.push(inputId)
      pending.reactionOwners.push(input)
      return
    }
    let start!: () => void
    const batchEnd = new Promise<void>(resolve => { start = resolve })
    const boundary = { turn, proc, epoch, generation, events: [] as Array<() => void>,
      inputs: input.batch.map(msg => msg.text), inputIds: [inputId], collecting: true,
      reactionOwners: [input],
      start: () => { boundary.collecting = false; start() },
    }
    this.steeringBoundary = boundary
    const ownsBoundary = () => this.steeringBoundary === boundary && this.proc === proc
      && this.procEpoch === epoch && this.steeringGeneration === generation && this.currentTurn === turn
    // Finish the old segment before any following native delta can arrive.
    // An existing capacity rotation is allowed to finish first; its incoming
    // events are now fenced too, so this text still belongs before the input.
    if (!turn.rotating) this.finalizeCurrentAssistantSegment()
    const operation = Promise.resolve().then(async () => {
      await batchEnd
      if (turn.rotating) await turn.rotating
      if (!ownsBoundary()) return
      this.finalizeCurrentAssistantSegment()
      this.startMidTurnRotate(turn, {
        userInputs: boundary.inputs,
        onCardSent: () => {
          if (!ownsBoundary()) return
          for (const owner of boundary.reactionOwners) this.releaseSteeringReactions(owner)
        },
      })
      await turn.rotating
    }).catch(async error => {
      logError('session: input-boundary card handoff failed', error)
      await feishu.sendTextRaw(this.chatId, `⚠️ 追加消息已进入执行流，但换卡失败：${messageOf(error)}`)
    }).finally(() => {
      turn.steeringInflight?.delete(operation)
      if (this.steeringBoundary !== boundary) return
      this.steeringBoundary = null
      // Dispatch checks ownership again and will enqueue behind a later
      // boundary encountered in this same batch, preserving native order.
      for (const dispatch of boundary.events) dispatch()
    })
    ;(turn.steeringInflight ??= new Set()).add(operation)
  }

  /** Drain `pendingMidTurnMsgs` to the SDK and open a fresh card for the
   * resulting batch turn. Called from the `result` handler when buffered
   * mid-turn messages need to start their own turn. The `sendUserText`
   * calls wake the SDK polling loop (priority="now" semantics) and
   * comprise the input for the new turn. Opens the card here rather
   * than deferring to init because the init for this batch will arrive
   * with `currentTurn` already set and bail.
   *
   * N 条 wireText 用 `\n\n` join 成 **单条** sendUserText 发给 SDK,而不是
   * N 次独立写。背景:SDK polling loop 在 turn 边界一次只 dequeue 一条
   * user message 进 prompt,N 次独立写会让
   * SDK 把第 1 条单独开 turn、剩 N-1 条进下一 turn —— daemon 这边 panel
   * 在 openTurnCard 时已经 commit 了全部 N 条到 "前一个" turn,跟 SDK
   * 实际 turn 边界错位(03:19 现场 turn=5 panel 7 条 vs 模型只看到 1 条
   * "1 和 2 两条都收到了")。join 成单条后,SDK 看到 1 个 user message,
   * panel 跟模型实际 input 一致。
   *
   * pendingCount 一次 ++(对应一次 sendUserText)。因为 SDK 不再拆 turn,
   * commit 2258af4 当年用累加保护 spurious 第二 turn 的逻辑不再需要 —
   * SDK 不会自发开 user_batch 子 turn。 */
  private async drainMidTurnAndOpen(ownership?: {
    proc: AgentProcess
    lease: LifecycleLease
    recovery: PreservedWatchdogRecovery
  }): Promise<MidTurnDrainOutcome> {
    if (this.steeringSend) await this.steeringSend
    const validOwnership = (): boolean =>
      !ownership || (
        this.ownsPreservedWatchdogRecovery(ownership.recovery, ownership.lease) &&
        this.proc === ownership.proc &&
        ownership.proc.provider === ownership.recovery.provider &&
        ownership.proc.sessionId === ownership.recovery.threadId
      )
    if (!validOwnership()) return 'preserved'
    if (this.pendingMidTurnMsgs.length === 0) return 'no_batch'
    if (this.modelSettingsBlockReason()) return 'preserved'
    const proc = this.proc
    const epoch = this.procEpoch
    if (!proc?.isAlive()) return 'preserved'
    // A result may arrive while a bg-resume/scheduled card is still opening
    // and ask us to drain a user message buffered mid-window. Never replace
    // that owner: wait until it has attached+closed its own orphan output,
    // then open the user batch as a distinct turn.(上游 7c14677 单飞)
    if (!await this.waitForTurnOpenSlot(proc, epoch)) return 'preserved'
    if (!validOwnership()) return 'preserved'
    if (this.currentTurn || this.openingTurn) return 'preserved'
    if (this.pendingMidTurnMsgs.length === 0) return 'no_batch'
    const batch = this.pendingMidTurnMsgs
    this.pendingMidTurnMsgs = []
    const delivery = this.beginHumanDelivery(proc, batch, null)
    if (!delivery) return 'preserved'
    let openingToken: object
    try {
      openingToken = this.beginTurnOpening()
    } catch (error) {
      // Should be unreachable after waitForTurnOpenSlot, but an invariant
      // violation must never silently delete user input.
      logDiagnostic("session: mid-turn open ownership conflict")
      this.restoreHumanDelivery(delivery)
      return 'preserved'
    }
    delivery.openingOwner = openingToken
    try {
      // daemon-side panel state; wire delivery is one joined SDK input.
      for (const msg of batch) {
        this.pendingTurnInputs.push(msg.text)
      }
      const last = batch[batch.length - 1]
      const userOpenId = last?.userOpenId ?? this.lastUserOpenId
      const openResult = await this.openTurnCard(openingToken, userOpenId, 'user_message', { expectedProc: proc })
      const opened = this.openedTurnOf(openResult)
      if (
        !opened.ok ||
        opened.turn === null ||
        this.currentTurn !== opened.turn ||
        this.proc !== proc ||
        !proc.isAlive() ||
        (ownership && !this.ownsPreservedWatchdogRecovery(ownership.recovery, ownership.lease))
      ) {
        // 合并调和(取舍):两套「开卡失败」语义按失败段拆分 ——
        // ① stage='convert'(卡片消息已创建、id_convert 失败):沿上游
        //    「丢弃本批」——批次不 restore、held 回执立即释放、status 复位
        //    idle(上游用例 'opens a mid-turn card before feeding the
        //    buffered batch…drops input on card init failure')。
        // ② stage='send'(sendCard 连卡片消息都没发出)及其它非 opened:
        //    沿本地 restore —— 批次回存 pendingMidTurnMsgs、回执保留
        //    (本地用例 'does not send a drained prompt when its turn card
        //    fails to open':status 不变、pendingReactionIds 回存、
        //    deletedReactions 为空)。openTurnCard 抛异常(用例
        //    'restores queued input when opening its follow-up card throws')
        //    与投递被拒(dispatchHumanBatch → rejectHumanDelivery)同样走
        //    restore。
        if (opened.failed && !opened.stale && (openResult as { stage?: string } | null)?.stage === 'convert') {
          for (const [msgId, rid] of delivery.reactions) {
            if (rid) void feishu.deleteReaction(msgId, rid)
          }
          delivery.reactions.clear()
          delivery.state = 'restored'
          if (this.pendingHumanDelivery === delivery) this.pendingHumanDelivery = null
          this.status = 'idle'
          return 'preserved'
        }
        this.restoreHumanDelivery(delivery)
        return 'preserved'
      }
      delivery.turn = opened.turn
      return await this.dispatchHumanBatch(delivery)
    } catch (e) {
      this.restoreHumanDelivery(delivery)
      throw e
    } finally {
      this.finishTurnOpening(openingToken)
      // Messages that arrived while this card was opening belong to a later
      // batch. If this batch failed before creating a turn there will be no
      // SDK `result` event to trigger their drain, so hand them off now.
      // 合并调和:本地 restore 语义会把失败批次(同一批对象)回存
      // pendingMidTurnMsgs —— 无论 restore 发生在 drain 自身还是
      // dispatchHumanBatch→rejectHumanDelivery 内 —— 而上游这里只判 length>0。
      // 两者叠加后 openTurnCard/dispatch 持续失败会在 finally 里把同一批反复
      // 自旋 drain(session.test 'restores queued input when opening its
      // follow-up card throws' 与 'Codex RPC rejection before ACK restores …'
      // 的微任务死循环)。以对象身份判定:只有本批之外的新消息才交接,失败
      // 批次保持 queued 等下一次触发。
      const attempted = new Set(batch)
      if (
        !this.currentTurn &&
        this.pendingMidTurnMsgs.some(msg => !attempted.has(msg)) &&
        this.proc === proc &&
        this.procEpoch === epoch &&
        proc.isAlive()
      ) {
        void this.drainMidTurnAndOpen().catch(_e => {
          logError("session: mid-turn drain failed", _e)
        })
      }
    }
  }

  private async startWatchdogResumeTurn(
    userOpenId: string,
    proc: AgentProcess,
    transaction: WatchdogActionTransaction,
    recovery: PreservedWatchdogRecovery,
  ): Promise<'started' | 'human_priority' | 'human_priority_failed' | 'stale' | 'failed'> {
    if (
      !this.ownsWatchdogAction(transaction) ||
      !this.ownsPreservedWatchdogRecovery(recovery, transaction.lease) ||
      this.proc !== proc ||
      !this.watchdogActionProcessMatches(transaction, proc)
    ) return 'stale'
    if (this.currentTurn || this.openingTurn || this.hasQueuedHumanWork()) return 'stale'
    const openingToken = this.beginTurnOpening()
    try {
      let openResult: TurnCardOpenResult
      try {
        openResult = await this.openTurnCard(openingToken, userOpenId, 'watchdog_resume', {
          expectedProc: proc,
        })
      } catch (e) {
        logError("session: watchdog recovery-card open failed", e)
        return 'failed'
      }
      const opened = this.openedTurnOf(openResult)
      if (
        !this.ownsWatchdogAction(transaction) ||
        !this.ownsPreservedWatchdogRecovery(recovery, transaction.lease)
      ) return 'stale'
      if (opened.stale) return 'stale'
      if (opened.failed) return 'failed'
      if (
        opened.turn === null ||
        this.currentTurn !== opened.turn ||
        this.proc !== proc ||
        !proc.isAlive()
      ) return 'stale'

      if (this.hasQueuedHumanWork()) {
        await this.closeTurnCard('🛟 自动恢复取消 · 真人消息优先', {
          preservePendingReactions: true,
        })
        if (
          !this.ownsWatchdogAction(transaction) ||
          !this.ownsPreservedWatchdogRecovery(recovery, transaction.lease) ||
          this.proc !== proc ||
          !this.watchdogActionProcessMatches(transaction, proc)
        ) return 'stale'
        if (this.pendingMidTurnMsgs.length > 0) {
          // 恢复卡已关闭,本次 open 事务在此结束 —— 先释放 owner 再 drain,
          // 否则单飞 waitForTurnOpenSlot 会等在调用方自己身上(自锁)。
          this.finishTurnOpening(openingToken)
          let drainOutcome: MidTurnDrainOutcome = 'preserved'
          try {
            recovery.phase = 'draining'
            drainOutcome = await this.drainMidTurnAndOpen({
              proc,
              lease: transaction.lease,
              recovery,
            })
          } catch (e) {
            logError("session: watchdog human-priority drain failed", e)
          }
          if (drainOutcome === 'preserved') return 'human_priority_failed'
        } else this.status = 'idle'
        return 'human_priority'
      }

      const dispatch = await this.dispatchSystemUserText(
        proc,
        WATCHDOG_RECOVERY_PROMPT,
        opened.turn,
        openingToken,
      )
      if (dispatch !== 'accepted') {
        if (dispatch === 'rejected') {
          await this.closeRejectedSystemTurn(
            opened.turn,
            proc,
            '⚠️ Codex 未接受自动恢复请求',
          )
          return 'failed'
        }
        return 'stale'
      }
      if (this.proc === proc && this.currentTurn === opened.turn) this.status = 'working'
      return 'started'
    } finally {
      this.finishTurnOpening(openingToken)
    }
  }

  async runWatchdogRecovery(
    ctx: WatchdogTurnContext,
    verdict: Extract<WatchdogVerdict, { type: 'recover' }>,
  ): Promise<void> {
    if (!this.watchdogGuardsPass(ctx)) return
    const transaction = this.beginWatchdogAction(ctx, 'watchdog-recovery')
    if (!transaction) return
    this.stopFooterStatus(ctx.turn)
    ctx.turn.footerStatusOverride = watchdogFooterContent('recovering')
    let recovery: PreservedWatchdogRecovery | null = null
    const failRecovery = async (outcome: string): Promise<void> => {
      if (!this.ownsWatchdogAction(transaction)) return
      recovery ??= this.preserveWatchdogRecovery(transaction)
      if (!recovery || !this.ownsPreservedWatchdogRecovery(recovery, transaction.lease)) return
      this.markPreservedWatchdogRecoveryFailed(recovery, transaction.lease)
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      try {
        await this.closeTurnCard(watchdogFooterContent('failed'), {
          forcePush: true,
          preservePendingReactions: true,
        })
      } catch (e) {
        logError("session: watchdog failed-card close failed", e)
      }
      if (!this.ownsWatchdogAction(transaction)) return
      await feishu.sendTextRaw(this.chatId, watchdogFooterContent('failed')).catch(() => {})
      if (!this.ownsWatchdogAction(transaction)) return
      this.logWatchdog('turn_watchdog_recover_failed', ctx, { ...verdict, outcome })
    }
    try {
      try {
        await this.replaceFooterContent(
          ctx.turn.cardId,
          this.withModel(ctx.turn.footerStatusOverride, ctx.turn),
        )
      } catch (e) {
        logError("session: watchdog footer patch failed", e)
      }

      if (!this.ownsWatchdogAction(transaction)) return
      if (!this.watchdogGuardsPass(ctx, true)) {
        if (this.currentTurn === ctx.turn && this.watchdogContext === ctx) {
          ctx.turn.footerStatusOverride = null
          if (this.watchdogTurnStillOwned(ctx)) this.startThinkingFooter(ctx.turn)
        }
        return
      }

      this.watchdog.consumeRecovery()
      this.logWatchdog('turn_watchdog_recover_start', ctx, verdict)
      const interrupt = this.beginTurnInterrupt('watchdog_recover', ctx)
      if (!interrupt) return
      const outcome = await this.waitForTurnSettlement(
        interrupt,
        this.configuredWatchdogSettings().interruptGraceMs,
      )
      if (!this.ownsWatchdogAction(transaction)) return
      this.logWatchdog('turn_watchdog_interrupt_settled', ctx, {
        ...verdict,
        outcome: outcome.type,
      })

      let liveProcess = outcome.type === 'result' &&
        this.proc === ctx.proc && ctx.proc.isAlive() && this.watchdogTurnStillOwned(ctx)
      if (outcome.type === 'timeout') {
        this.cancelTurnInterrupt('watchdog grace timeout')
        this.logWatchdog('turn_watchdog_resume_fallback', ctx, {
          ...verdict,
          outcome: 'timeout',
        })
      } else if (outcome.type === 'exit') {
        this.logWatchdog('turn_watchdog_resume_fallback', ctx, {
          ...verdict,
          outcome: 'exit',
        })
      } else if (outcome.type === 'cancelled') {
        return
      }

      if (!liveProcess) {
        if (!this.watchdogActionTurnStillOwned(transaction)) return
        if (this.proc && this.proc !== transaction.proc) {
          recovery = this.preserveWatchdogRecovery(transaction)
          if (recovery) this.markPreservedWatchdogRecoveryFailed(recovery, transaction.lease)
          this.status = 'stopped'
          this.opts.onLifecycleChange?.()
          return
        }
        recovery = this.preserveWatchdogRecovery(transaction)
        if (!recovery) return
        const resumed = await this.restart(true, {
          announce: false,
          lifecycleLease: transaction.lease,
          resumeIdentity: {
            provider: transaction.provider,
            threadId: transaction.threadId,
          },
          preservedRecoveryToken: recovery.token,
          requireResumeSession: true,
          preserveCurrentTurn: true,
          preserveQueuedHumanWork: true,
        })
        if (
          !this.ownsWatchdogAction(transaction) ||
          !this.ownsPreservedWatchdogRecovery(recovery, transaction.lease)
        ) return
        if (!this.watchdogActionTurnStillOwned(transaction)) return
        let replacement = recovery.replacementProc
        if (!replacement && this.watchdogActionProcessMatches(transaction, this.proc)) {
          replacement = this.proc
          recovery.replacementProc = replacement
        }
        if (
          !resumed ||
          !replacement ||
          this.proc !== replacement ||
          !this.watchdogActionProcessMatches(transaction, replacement)
        ) {
          if (replacement?.isAlive()) await this.discardLocalProcess(transaction.lease, replacement)
          await failRecovery('resume_failed')
          return
        }
        liveProcess = true
      }

      if (
        !this.ownsWatchdogAction(transaction) ||
        !this.watchdogActionTurnStillOwned(transaction) ||
        !liveProcess
      ) return
      const recoveryProc = this.proc
      if (!this.watchdogActionProcessMatches(transaction, recoveryProc)) return
      try {
        await this.closeTurnCard(watchdogFooterContent('interrupted', verdict), {
          forcePush: true,
          preservePendingReactions: true,
        })
      } catch (e) {
        logError("session: watchdog interrupted-card close failed", e)
      }
      if (
        !this.ownsWatchdogAction(transaction) ||
        this.proc !== recoveryProc ||
        !this.watchdogActionProcessMatches(transaction, recoveryProc)
      ) return

      if (this.currentTurn?.trigger === 'user_message' || this.openingTurn) return
      if (this.hasQueuedHumanWork()) {
        recovery ??= this.preserveWatchdogRecovery(transaction)
        if (!recovery) return
        if (this.pendingMidTurnMsgs.length > 0) {
          let drainOutcome: MidTurnDrainOutcome = 'preserved'
          try {
            recovery.phase = 'draining'
            drainOutcome = await this.drainMidTurnAndOpen({
              proc: recoveryProc,
              lease: transaction.lease,
              recovery,
            })
          } catch (e) {
            logError("session: watchdog recovery human drain failed", e)
          }
          if (
            !this.ownsWatchdogAction(transaction) ||
            !this.ownsPreservedWatchdogRecovery(recovery, transaction.lease)
          ) return
          if (drainOutcome === 'preserved') {
            await failRecovery('human_priority_failed')
            return
          }
        } else this.status = 'idle'
        recovery.replacementProc = null
        this.completePreservedWatchdogRecovery(recovery, transaction.lease)
        return
      }

      recovery ??= this.preserveWatchdogRecovery(transaction)
      if (!recovery) return
      const start = await this.startWatchdogResumeTurn(
        transaction.turn.userOpenId,
        recoveryProc,
        transaction,
        recovery,
      )
      if (!this.ownsWatchdogAction(transaction)) return
      if (start === 'started') {
        this.logWatchdog('turn_watchdog_recover_started', ctx, verdict)
        recovery.replacementProc = null
        this.completePreservedWatchdogRecovery(recovery, transaction.lease)
      } else if (start === 'human_priority') {
        recovery.replacementProc = null
        this.completePreservedWatchdogRecovery(recovery, transaction.lease)
      } else if (start === 'human_priority_failed') {
        await failRecovery('human_priority_failed')
      } else if (start === 'failed') {
        if (
          this.proc !== recoveryProc ||
          !recoveryProc.isAlive() ||
          this.currentTurn ||
          this.openingTurn ||
          this.hasQueuedHumanWork()
        ) return
        await failRecovery('open_failed')
      } else if (start === 'stale') {
        // 恢复 turn 在 ACK 前被更新的 owner 顶替:替换方的 currentTurn/status/
        // 卡片必须原样保留,这里只把仍归本次 action 所有的保留记录标记为
        // failed,让用户之后能用 restart 恢复排队消息。
        if (this.ownsPreservedWatchdogRecovery(recovery, transaction.lease)) {
          this.markPreservedWatchdogRecoveryFailed(recovery, transaction.lease)
          this.logWatchdog('turn_watchdog_recover_failed', ctx, { ...verdict, outcome: 'stale_owner' })
        }
      }
    } catch (e) {
      logError("session: watchdog recovery action failed", e)
      if (this.ownsWatchdogAction(transaction)) await failRecovery('exception')
    } finally {
      this.finishWatchdogAction(transaction)
    }
  }

  async runWatchdogExhausted(
    ctx: WatchdogTurnContext,
    verdict: Extract<WatchdogVerdict, { type: 'stop_exhausted' }>,
  ): Promise<void> {
    if (!this.watchdogGuardsPass(ctx)) return
    const transaction = this.beginWatchdogAction(ctx, 'watchdog-exhausted')
    if (!transaction) return
    this.stopFooterStatus(ctx.turn)
    ctx.turn.footerStatusOverride = watchdogFooterContent('exhausted')
    let recovery: PreservedWatchdogRecovery | null = null
    const failQueuedRecovery = async (): Promise<void> => {
      if (!this.ownsWatchdogAction(transaction)) return
      recovery ??= this.preserveWatchdogRecovery(transaction)
      if (!recovery || !this.ownsPreservedWatchdogRecovery(recovery, transaction.lease)) return
      this.markPreservedWatchdogRecoveryFailed(recovery, transaction.lease)
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      await feishu.sendTextRaw(this.chatId, watchdogFooterContent('failed')).catch(() => {})
    }
    try {
      try {
        await this.replaceFooterContent(
          ctx.turn.cardId,
          this.withModel(ctx.turn.footerStatusOverride, ctx.turn),
        )
      } catch (e) {
        logError("session: watchdog exhausted footer patch failed", e)
      }

      if (!this.ownsWatchdogAction(transaction)) return
      if (!this.watchdogGuardsPass(ctx, true)) {
        if (this.currentTurn === ctx.turn && this.watchdogContext === ctx) {
          ctx.turn.footerStatusOverride = null
          if (this.watchdogTurnStillOwned(ctx)) this.startThinkingFooter(ctx.turn)
        }
        return
      }

      const interrupt = this.beginTurnInterrupt('watchdog_exhausted', ctx)
      if (!interrupt) return
      const outcome = await this.waitForTurnSettlement(
        interrupt,
        this.configuredWatchdogSettings().interruptGraceMs,
      )
      if (!this.ownsWatchdogAction(transaction)) return
      if (outcome.type === 'cancelled') return

      if (outcome.type === 'timeout') {
        this.cancelTurnInterrupt('watchdog exhausted grace timeout')
        if (this.proc === ctx.proc) this.proc = null
        if (ctx.proc.isAlive()) {
          await ctx.proc.kill(1_000).catch(_e => {
            logError("session: watchdog exhausted kill failed", _e)
          })
        }
        if (!this.ownsWatchdogAction(transaction)) return
      }

      if (this.proc && this.proc !== transaction.proc) {
        recovery = this.preserveWatchdogRecovery(transaction)
        if (recovery) await failQueuedRecovery()
        return
      }

      if (!this.watchdogActionTurnStillOwned(transaction)) return
      try {
        await this.closeTurnCard(watchdogFooterContent('exhausted'), {
          forcePush: true,
          preservePendingReactions: true,
        })
      } catch (e) {
        logError("session: watchdog exhausted-card close failed", e)
      }
      if (!this.ownsWatchdogAction(transaction)) return
      this.logWatchdog('turn_watchdog_exhausted', ctx, {
        ...verdict,
        outcome: outcome.type,
      })

      if (this.hasQueuedHumanWork()) {
        recovery = this.preserveWatchdogRecovery(transaction)
        if (!recovery) return
        if (
          this.proc?.isAlive() &&
          !this.watchdogActionProcessMatches(transaction, this.proc)
        ) {
          await failQueuedRecovery()
          return
        }
        if (!this.proc?.isAlive()) {
          const resumed = await this.restart(true, {
            announce: false,
            lifecycleLease: transaction.lease,
            resumeIdentity: {
              provider: transaction.provider,
              threadId: transaction.threadId,
            },
            preservedRecoveryToken: recovery.token,
            requireResumeSession: true,
            preserveCurrentTurn: true,
            preserveQueuedHumanWork: true,
          })
          if (
            !this.ownsWatchdogAction(transaction) ||
            !this.ownsPreservedWatchdogRecovery(recovery, transaction.lease)
          ) return
          if (!this.watchdogActionTurnStillOwned(transaction)) return
          let replacement = recovery.replacementProc
          if (!replacement && this.watchdogActionProcessMatches(transaction, this.proc)) {
            replacement = this.proc
            recovery.replacementProc = replacement
          }
          if (
            !resumed ||
            !replacement ||
            this.proc !== replacement ||
            !this.watchdogActionProcessMatches(transaction, replacement)
          ) {
            if (replacement?.isAlive()) await this.discardLocalProcess(transaction.lease, replacement)
            await failQueuedRecovery()
            return
          }
        }
        const recoveryProc = this.proc
        if (!this.watchdogActionProcessMatches(transaction, recoveryProc)) {
          await failQueuedRecovery()
          return
        }
        if (this.pendingMidTurnMsgs.length > 0) {
          let drainOutcome: MidTurnDrainOutcome = 'preserved'
          try {
            recovery.phase = 'draining'
            drainOutcome = await this.drainMidTurnAndOpen({
              proc: recoveryProc,
              lease: transaction.lease,
              recovery,
            })
          } catch (e) {
            logError("session: watchdog exhausted human drain failed", e)
          }
          if (
            !this.ownsWatchdogAction(transaction) ||
            !this.ownsPreservedWatchdogRecovery(recovery, transaction.lease)
          ) return
          if (drainOutcome === 'preserved') {
            await failQueuedRecovery()
            return
          }
        } else this.status = 'idle'
        recovery.replacementProc = null
        this.completePreservedWatchdogRecovery(recovery, transaction.lease)
        return
      }

      this.status = this.proc?.isAlive() ? 'idle' : 'stopped'
    } catch (e) {
      logError("session: watchdog exhausted action failed", e)
      if (this.hasQueuedHumanWork() && this.ownsWatchdogAction(transaction)) {
        await failQueuedRecovery()
      } else if (this.ownsWatchdogAction(transaction)) {
        await feishu.sendTextRaw(this.chatId, watchdogFooterContent('failed')).catch(() => {})
      }
    } finally {
      this.finishWatchdogAction(transaction)
    }
  }

  private staleOpenTerminalCard(): object {
    const status = '⚪ 本轮已取消 · 后端已切换'
    return {
      schema: '2.0',
      config: {
        streaming_mode: false,
        summary: { content: status },
      },
      body: {
        elements: [{
          tag: 'markdown',
          element_id: cards.ELEMENTS.footer,
          content: status,
        }],
      },
    }
  }

  /** 终结一个已(或即将)脱离归属的 turn 的旧卡片。同步前缀先把捕获的
   * turn 摘下台面(currentTurn / watchdog context 只在仍指向它时清理),
   * 第一个 await 之后只使用局部捕获值 —— 不得读写 replacement 的
   * currentTurn、进程、watchdog context、状态或全局 reaction 归属。
   * 任一终态卡片写失败(API 失败或 write-dead/dead-element 短路)且
   * 提供了 rawFallback 时,只发一次纯文本兜底。 */
  private async terminalizeDetachedTurn(
    turn: TurnState,
    opts: { footerContent: string; settingsSuffix: string; rawFallback?: string },
  ): Promise<void> {
    if (this.currentTurn === turn) {
      this.currentTurn = null
      if (this.watchdogContext?.turn === turn) this.endWatchdogTurn()
    }
    this.stopFooterStatus(turn)
    // rotating 拒绝也不能中止终结 —— 否则旧卡永远停在 streaming 态,
    // 这正是本 helper 要消除的症状;终态写自身的失败由 onFailure 兜底。
    if (turn.rotating) await turn.rotating.catch(() => {})
    this.stopFooterStatus(turn)

    const cardId = turn.cardId
    let writeFailed = false
    const onFailure = (): void => {
      writeFailed = true
    }
    await cardkit.flush(cardId)
    await cardkit.replaceElement(cardId, cards.ELEMENTS.footer, {
      tag: 'markdown',
      element_id: cards.ELEMENTS.footer,
      content: opts.footerContent,
    }, onFailure)
    cardkit.cancelSummary(cardId)
    await cardkit.patchSettings(
      cardId,
      cards.streamingOffSettings({ suffix: opts.settingsSuffix }),
      onFailure,
    )
    await cardkit.dispose(cardId)

    if (writeFailed && opts.rawFallback) {
      await feishu.sendTextRaw(this.chatId, opts.rawFallback).catch(() => {})
    }
  }

  private async settleCapturedStaleTurn(turn: TurnState): Promise<void> {
    await this.terminalizeDetachedTurn(turn, {
      footerContent: '⚪ 本轮已取消 · 后端已切换',
      settingsSuffix: '⚪ 后端已切换',
    })
  }

  private async cleanupStaleTurnOpen(opts: {
    openingTurnCounter: number
    openingProc: AgentProcess | null
    openingToken: object
    messageId?: string | null
    cardId?: string | null
    backgroundMigrated?: boolean
  }): Promise<void> {
    this.finishWatchdogOpening(opts.openingTurnCounter, true, opts.openingProc, opts.openingToken)

    const status = '⚪ 本轮已取消 · 后端已切换'
    if (opts.cardId) {
      await cardkit.replaceElement(opts.cardId, cards.ELEMENTS.footer, {
        tag: 'markdown',
        element_id: cards.ELEMENTS.footer,
        content: status,
      })
      cardkit.cancelSummary(opts.cardId)
      await cardkit.patchSettings(opts.cardId, cards.streamingOffSettings({ suffix: '⚪ 后端已切换' }))
      await cardkit.dispose(opts.cardId)
    } else if (opts.messageId) {
      try {
        await feishu.updateCard(opts.messageId, this.staleOpenTerminalCard())
      } catch (e) {
        logError("session: stale turn card terminal update failed message", e)
      }
    }

    if (
      opts.backgroundMigrated &&
      cards.hasActiveBgTask(this.backgroundTasks) &&
      !this.backgroundCard
    ) {
      this.pendingRebuildBackgroundCard = true
      if (this.currentTurn && !this.openingBackground) {
        this.openingBackground = true
        try {
          await this.openBackgroundCard()
          if (this.backgroundCard) this.pendingRebuildBackgroundCard = false
        } catch (e) {
          logError("session: stale open background rebuild failed", e)
        } finally {
          this.openingBackground = false
        }
      }
    }
  }

  /** A successful background migration sets a rebuild receipt that is normally
   * consumed after the new main card lands. If that main card cannot be sent or
   * converted, rebuild immediately so active/late-terminal tasks do not remain
   * cardless until some unrelated future event.(上游 7c14677) */
  private rebuildBackgroundAfterTurnOpenFailure(): void {
    if (!this.pendingRebuildBackgroundCard) return
    this.pendingRebuildBackgroundCard = false
    if (this.backgroundTasks.length === 0) return
    void this.openBackgroundCard().catch(_error => {
      logError("session: background rebuild after turn-open failure failed", _error)
    })
  }

  private async terminalizeSupersededCard(
    cardId: string,
    status: string,
    hasFooter: boolean,
  ): Promise<void> {
    const failures: cardkit.CardWriteFailure[] = []
    const onFailure = (failure: cardkit.CardWriteFailure) => { failures.push(failure) }
    const footerLanded = hasFooter
      ? await cardkit.replaceElementChecked(cardId, cards.ELEMENTS.footer, this.footerElement(status), { onFailure })
      : true
    cardkit.cancelSummary(cardId)
    const settingsLanded = await cardkit.patchSettingsChecked(
      cardId,
      cards.streamingOffSettings({ suffix: status }),
      onFailure,
    )
    if (footerLanded && settingsLanded) {
      await cardkit.dispose(cardId)
      return
    }
    const detail = `footer=${footerLanded ? 'ok' : 'MISS'}, settings=${settingsLanded ? 'ok' : 'MISS'}`
    logError('session: superseded card terminal transaction incomplete', detail)
    await feishu.sendTextRaw(this.chatId, `⚠️ 已作废卡片未能正常关闭 (${detail})。\n${cardFailureDetails(failures)}`)
  }

  /**
   * 合并返回面双消费归一。本地调用面按 TurnCardOpenResult
   * ({kind:'opened',turn} | {kind:'failed'} | {kind:'stale'}) 消费;
   * 上游调用面/测试覆写直接返回 raw TurnState(成功)或 null/undefined
   * (放弃)。真实 openTurnCard 已把两者合并到同一活对象(kind='opened'、
   * turn=自身),但测试覆写会替换该方法返回纯 raw —— 调用面必须两种形状
   * 都接受。无 kind 字段即视为上游 raw 形态:成功,turn 为自身。
   */
  private openedTurnOf(openResult: TurnCardOpenResult | TurnState | null | undefined): {
    ok: boolean
    failed: boolean
    stale: boolean
    turn: TurnState | null
  } {
    if (!openResult) return { ok: false, failed: true, stale: false, turn: null }
    const kind = (openResult as { kind?: string }).kind
    if (kind === 'opened') {
      return { ok: true, failed: false, stale: false, turn: (openResult as { turn: TurnState }).turn }
    }
    if (kind === 'failed') return { ok: false, failed: true, stale: false, turn: null }
    if (kind !== undefined) return { ok: false, failed: false, stale: true, turn: null }
    return { ok: true, failed: false, stale: false, turn: openResult as TurnState }
  }

  private async openTurnCard(
    owner: TurnOpenOwner | TurnOpenTerminalStash,
    userOpenId: string,
    trigger: TurnState['trigger'],
    opts: {
      initialFooter?: string
      startThinking?: boolean
      directStart?: boolean
      expectedProc?: AgentProcess
    } = {},
  ): Promise<TurnCardOpenResult> {
    // 调用形态归一:合并定稿签名取上游 owner 协议 (owner, userOpenId, trigger, opts);
    // 本地(main)调用面为 (userOpenId, trigger, opts) —— 生产装配已统一为上游四参,
    // 仅本地测试组经 as-any 直呼首参 string 的三参形态。首参 string 即按本地形态
    // 平移:owner 取当前开卡槽位(经 beginTurnOpening 装配;测试未装配则就地补一个,
    // 等价 main 无 owner 入口的整体语义 —— 入口门 ownsTurnOpen 与中途代际检查都以
    // 此 owner 判定),第三参(trigger 位)整体当 opts。
    if (typeof (owner as unknown as string) === 'string') {
      const localOpts = (trigger as unknown as typeof opts) ?? {}
      trigger = userOpenId as TurnState['trigger']
      userOpenId = owner as unknown as string
      owner = this.openingTurnOwner ?? this.beginTurnOpening()
      opts = localOpts
    }
    if (opts.expectedProc && this.proc !== opts.expectedProc) return { kind: 'stale' }
    if (!this.ownsTurnOpen(owner)) return { kind: 'stale' }
    const pendingCompactions = 'pendingCompactions' in owner ? owner.pendingCompactions : []
    const turnSelection = this.runtimeModelSelection()
    const watchdogOpeningTurnCounter = this.turnCounter + 1
    const watchdogOpeningProc = opts.expectedProc ?? this.proc
    const openingTurn = this.currentTurn
    const openingToken = {}
    const openingIsCurrent = (): boolean =>
      this.watchdogOpeningToken === openingToken &&
      this.proc === watchdogOpeningProc &&
      this.currentTurn === openingTurn
    this.watchdogOpeningTurnCounter = watchdogOpeningTurnCounter
    this.watchdogOpeningProc = watchdogOpeningProc
    this.watchdogOpeningToken = openingToken
    if (
      this.pendingWatchdogIdentity?.proc === this.proc &&
      this.pendingWatchdogIdentity.turnCounter === null
    ) {
      this.pendingWatchdogIdentity.turnCounter = watchdogOpeningTurnCounter
    }
    // 任何 turn 开卡都消费掉 pending 的恢复轮标记 —— 若用户消息抢在恢复轮
    // init 前开了卡,SDK 会把结算通知并入该轮,标记留着只会误伤后续空 init。
    this.bgResumePending = false
    // ── 后台游标卡迁移 ── 发新主卡前,先把旧后台卡沉降(终态墓碑/固定标识),
    // 主卡落地后(currentTurn 赋值处)重建后台卡重回末尾。迁移失败不阻塞主卡。
    let backgroundMigrated = false
    if (this.backgroundCard && cards.hasActiveBgTask(this.backgroundTasks)) {
      try {
        await this.migrateBackgroundCard()
        backgroundMigrated = true
        this.pendingRebuildBackgroundCard = true
      } catch (e) {
        logError("session: background migrate failed (non-blocking)", e)
      }
    }
    if (!openingIsCurrent()) {
      await this.cleanupStaleTurnOpen({
        openingTurnCounter: watchdogOpeningTurnCounter,
        openingProc: watchdogOpeningProc,
        openingToken,
        backgroundMigrated,
      })
      return { kind: 'stale' }
    }
    const turn = ++this.turnCounter
    // Snapshot+clear pendingTurnInputs synchronously here so concurrent
    // pushes between snapshot and the await don't sneak into THIS turn's
    // panel (they'll be picked up by the next turn's open).
    const userInputs = this.pendingTurnInputs
    this.pendingTurnInputs = []
    this.lastTurnUserPreview = userInputs[0]?.slice(0, 80) ?? this.lastTurnUserPreview
    const initialFooter = this.withModel(opts.initialFooter ?? 'Waiting...(0s)', turnSelection)
    const card = cards.mainConversationCard({
      sessionName: this.sessionName,
      turn,
      provider: turnSelection.provider,
      model: turnSelection.model ?? undefined,
      effort: turnSelection.effort ?? 'MISS',
      kind: trigger,
      userInputs,
      initialFooter,
      directStart: opts.directStart,
    })
    let messageId: string | null
    let sendFailure: unknown
    try {
      messageId = await feishu.sendCard(this.chatId, card, error => { sendFailure = error })
    } catch (e) {
      if (!openingIsCurrent()) {
        await this.cleanupStaleTurnOpen({
          openingTurnCounter: watchdogOpeningTurnCounter,
          openingProc: watchdogOpeningProc,
          openingToken,
          backgroundMigrated,
        })
        return { kind: 'stale' }
      }
      this.finishWatchdogOpening(watchdogOpeningTurnCounter, true, watchdogOpeningProc, openingToken)
      throw e
    }
    const staleAfterSend = !openingIsCurrent()
    if (!messageId) {
      if (staleAfterSend) {
        await this.cleanupStaleTurnOpen({
          openingTurnCounter: watchdogOpeningTurnCounter,
          openingProc: watchdogOpeningProc,
          openingToken,
          backgroundMigrated,
        })
        return { kind: 'stale' }
      }
      logDiagnostic("session: openTurnCard sendCard EXHAUSTED retries — surfacing via raw text")
      // sendCard already retried 3× through the SDK. If it still came back
      // null we're either on a sustained SDK-axios outage or a Feishu
      // business reject. Either way the user just sent us a message and
      // it's gone into a black hole — surface that explicitly so they
      // know to resend instead of waiting for a reply that won't come.
      // Use raw fetch (not sendText) because if the SDK is the broken
      // thing we'd be doomed to silence otherwise.
      // bg-resume 轮没有"用户这条消息",提示重发只会误导;其输出会走
      // 孤儿缓冲纯文本兜底,这里不必告警。
      try {
        if (trigger === 'user_message') {
          await feishu.sendTextRaw(
            this.chatId,
            `❌ 创建对话卡片失败。你这条消息尚未送给 ${this.backendLabel()},请稍后重发。\n${formatFeishuError(sendFailure)}`,
          )
        }
      } catch (e) {
        if (!openingIsCurrent()) {
          await this.cleanupStaleTurnOpen({
            openingTurnCounter: watchdogOpeningTurnCounter,
            openingProc: watchdogOpeningProc,
            openingToken,
            backgroundMigrated,
          })
        } else {
          this.finishWatchdogOpening(watchdogOpeningTurnCounter, true, watchdogOpeningProc, openingToken)
        }
        throw e
      }
      if (!openingIsCurrent()) {
        await this.cleanupStaleTurnOpen({
          openingTurnCounter: watchdogOpeningTurnCounter,
          openingProc: watchdogOpeningProc,
          openingToken,
          backgroundMigrated,
        })
        return { kind: 'stale' }
      }
      this.finishWatchdogOpening(watchdogOpeningTurnCounter, true, watchdogOpeningProc, openingToken)
      this.rebuildBackgroundAfterTurnOpenFailure()
      // currentTurn left null as the failure signal. Caller decides
      // whether to sendInterrupt: onUserMessage's eager-open path
      // hasn't fed SDK yet so doesn't need to; the init handler has
      // (SDK started the turn itself) and must.
      return { kind: 'failed', stage: 'send' }
    }
    let cardId: string
    try { cardId = await cardkit.convertMessageToCard(messageId) }
    catch (e) {
      if (staleAfterSend || !openingIsCurrent()) {
        await this.cleanupStaleTurnOpen({
          openingTurnCounter: watchdogOpeningTurnCounter,
          openingProc: watchdogOpeningProc,
          openingToken,
          messageId,
          backgroundMigrated,
        })
        return { kind: 'stale' }
      }
      this.finishWatchdogOpening(watchdogOpeningTurnCounter, true, watchdogOpeningProc, openingToken)
      this.rebuildBackgroundAfterTurnOpenFailure()
      logError('session: id_convert failed', e)
      if (trigger === 'user_message' && this.ownsTurnOpen(owner)) {
        await feishu.sendTextRaw(
          this.chatId,
          `❌ 对话卡片初始化失败。你这条消息尚未送给 ${this.backendLabel()},请稍后重发。\n${formatFeishuError(e)}`,
        )
      }
      return { kind: 'failed', stage: 'convert' }
    }
    // Tell cardkit how many elements the initial body already has so
    // its element-count tracker is correct from the first addElement
    // onwards (bg-resume banner + userInputPanel + footer).
    const initialElementCount =
      (trigger === 'bg_task_resume' || trigger === 'watchdog_resume' || trigger === 'scheduled_wakeup' ? 1 : 0) +
      (userInputs.length > 0 ? 1 : 0) +
      1
    if (staleAfterSend || !openingIsCurrent()) {
      // 合并调和(取舍):上游在同位(convert 后 !ownsTurnOpen)先
      // recordCardCreated 再 terminalizeSupersededCard —— 经测试绕过的
      // id_convert 返回时卡片不在 cardkit bookkeeping 里,patchSettingsChecked
      // 的 isDisposed 短路会吞掉终态 PATCH。本地 cleanupStaleTurnOpen 的
      // 终态写(footer『⚪ 本轮已取消』/settings/dispose)依赖同一注册,
      // 这里补注册(上游用例 'an obsolete main-card open cannot replace a
      // newer process turn…' 以 PATCH /cards/<old>/settings 判定)。
      cardkit.recordCardCreated(cardId, initialElementCount)
      await this.cleanupStaleTurnOpen({
        openingTurnCounter: watchdogOpeningTurnCounter,
        openingProc: watchdogOpeningProc,
        openingToken,
        messageId,
        cardId,
        backgroundMigrated,
      })
      return { kind: 'stale' }
    }
    if (!this.ownsTurnOpen(owner)) {
      cardkit.recordCardCreated(cardId, initialElementCount)
      await this.terminalizeSupersededCard(cardId, '⚠️ 会话已切换，本卡已作废', true)
      return { kind: 'stale' }
    }
    cardkit.recordCardCreated(
      cardId,
      initialElementCount,
      (code, meta) => this.onCardWriteFailure(cardId, code, meta),
      () => this.onCardWriteSuccess(cardId),
    )
    const turnState: TurnState = {
      cardId,
      ...turnSelection,
      messageId,
      userOpenId,
      trigger,
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
      modelFallbackNotice: null,
      modelFallbackOverrideTimer: null,
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
    this.clearToolFailureLoop()
    cardkit.recordCardCreated(
      cardId,
      initialElementCount,
      (code, meta) => this.onCardWriteFailure(cardId, code, meta),
      () => this.onCardWriteSuccess(cardId),
    )
    this.currentTurn = turnState
    if (this.proc) this.beginWatchdogTurn(turnState, this.proc)
    this.finishWatchdogOpening(watchdogOpeningTurnCounter, false, watchdogOpeningProc, openingToken)
    if (opts.startThinking !== false) this.startThinkingFooter(turnState)
    if (pendingCompactions.length > 0) {
      const buffered = pendingCompactions.splice(0)
      logDiagnostic("session: replay")
      for (const notice of buffered) this.handleContextCompacted(this.proc, notice)
    }
    // 开卡 await 窗口期(sendCard/id_convert)先到的 assistant 正文攒在
    // 孤儿缓冲里,现在有卡了,作为首段并入 —— 后续 delta 接着正常追加。
    const orphan = this.takeOrphanAssistantText()
    if (orphan) {
      this.appendAssistant(orphan)
      this.finalizeCurrentAssistantSegment()
    }
    // 主卡落地 → 若刚迁移过旧后台卡且仍有任务(含迁移窗口内新终态,须补墓碑),
    // 重建后台卡重回末尾(重建卡全终态时 openBackgroundCard 落地后自沉降)。
    if (this.pendingRebuildBackgroundCard) {
      this.pendingRebuildBackgroundCard = false
      if (this.backgroundTasks.length > 0) {
        void this.openBackgroundCard().catch(_e => {
          logError("session: background rebuild failed", _e)
        })
      }
    }
    // 合并返回面双消费:本地调用面按 TurnCardOpenResult({kind:'opened', turn})
    // 判别;上游测试组直呼 openTurnCard 后按 TurnState 消费返回值(turn.cardId /
    // turn.contextCompactionCompleted…)。把判别式字段挂回同一 turnState
    // (kind='opened'、turn=自身),两种消费面共享同一活对象 —— 上游用例 await
    // 之后继续驱动 turn 观察 replay 结果(replay 的完成写卡是异步的),副本
    // (spread)会停在返回时点,故必须同体。
    const opened = turnState as TurnState & { kind: 'opened'; turn: TurnState }
    opened.kind = 'opened'
    opened.turn = opened
    return opened
  }

  /** Cheap synchronous check called from stream handlers right before
   * they `addElement` a new tool / assistant segment / file-tool batch /
   * etc. If the current card is close to Feishu's element ceiling and
   * we haven't already kicked off a rotation, fire-and-forget start a
   * `startMidTurnRotate` and let it run async on its own. The current
   * stream handler still uses `turn.cardId` (the old card) for this
   * iteration — that's fine because (a) cardkit's per-card queue keeps
   * its writes ordered against the soft-close that's about to happen,
   * and (b) the soft limit (CARD_ELEMENT_SOFT_LIMIT=50) sits well under
   * the observed ~75 ceiling, so an in-flight add either fits or — if it
   * doesn't — trips onCardWriteFailure, which rotates reactively anyway. */
  maybeMidTurnRotate(): void {
    const turn = this.currentTurn
    if (!turn) return
    if (turn.rotateGivenUp) return
    if (turn.rotating) return
    // 开卡失败的重试不被元素软上限挡住(上游 378f4a4):这一轮的卡可能还很空,
    // 但上一张续卡没发出去,必须再试一次 —— 与"满卡主动换卡"是两个判据。
    if (!turn.cardRotationFailed && cardkit.getElementCount(turn.cardId) < CARD_ELEMENT_SOFT_LIMIT) return
    this.startMidTurnRotate(turn)
  }

  /** Reactive rotation is reserved for confirmed card-capacity failures:
   * a real 300305 component ceiling (possibly nested inside a generic
   * 300315 add wrapper) or the local 200860 card-size ceiling. `300315`
   * alone also carries duplicate-ID / invalid-schema failures — replaying
   * those (or a timeout/5xx) on a new card deterministically poisons every
   * replacement, so they stay on the current card and surface a once-per-
   * turn user diagnostic instead (上游 4185808, FIX-02 可观测验收点).
   * Pure network failures do NOT rotate, do NOT consume the cap and stay
   * silent — swapping cards cannot fix transport, and counting footer
   * `fetch failed` blips toward the cap is what flipped etmmo turns to
   * log-only (2026-07-25/26). Idempotent (a rotation already in flight is
   * left alone) and capped (MAX_MIDTURN_ROTATES) so a persistent capacity
   * failure can't spin forever. Successful addElement clears the streak
   * via onCardWriteSuccess. */
  private reportCardWriteFailure(
    turn: TurnState,
    code: number | undefined,
    failure: cardkit.CardWriteFailure | undefined,
    handling: string,
  ): void {
    const noticeKey = [turn.cardId, failure?.elementId ?? '-', failure?.operation ?? 'unknown', code ?? 'MISS'].join('|')
    if (turn.cardWriteFailureNotices.has(noticeKey)) return
    turn.cardWriteFailureNotices.add(noticeKey)
    const operation = failure?.operation ?? 'unknown operation'
    const element = failure?.elementId ? ` element=${failure.elementId}` : ''
    void feishu.sendTextRaw(this.chatId,
      `⚠️ 对话卡片写入失败(${operation}${element})。${handling}同类错误本轮合并提示，完整诊断保留在日志。\ncode=${code ?? 'MISS'}`)
  }

  onCardWriteFailure(
    failedCardId: string,
    code?: number,
    meta?: cardkit.CardWriteFailureMeta,
  ): void {
    const turn = this.currentTurn
    if (!turn || turn.cardId !== failedCardId) return
    if (turn.rotating) return
    if (turn.rotateGivenUp) return

    const kind = meta?.kind
      ?? (typeof code === 'number' ? 'api' : 'network')
    if (kind === 'network') {
      // Transport blip already retried inside cardkit. Stay on this card;
      // the next real content write either lands (onCardWriteSuccess) or
      // surfaces a true API code that can rotate.
      logDiagnostic("session: network write failure on")
      return
    }

    const failure = meta?.failure
    // 只有确认的容量失败才烧轮转预算:300305(或 300315 嵌套诊断点名容量)
    // 走组件数上限;200860 体积上限(含 300315 内嵌)是容量信号,保留轮转。
    // 其余 API 失败(schema/内容/duplicate-id/5xx)重放到新卡也修不好——
    // 留在当前卡,每 turn 一次用户可见诊断(FIX-02"投递失败路径可观测")。
    // 诊断文案只用失败分类摘要(错误码+操作类别+元素),绝不内插
    // failure.message/API 响应原文——那里可能回显凭据/raw payload。
    if (!cardkit.isCardCapacityFailure(code, failure)) {
      logError('session: card write failed', failure)
      this.reportCardWriteFailure(turn, code, failure,
        '该错误不是卡片元素上限，已停止无效换卡；其余输出继续处理。')
      return
    }

    // 指纹去重(上游 378f4a4):同一个被拒载荷换个卡也还是被拒 —— 不再烧换卡
    // 预算,只在第一次补一条用户通知。指纹缺失(网络类/老路径)时整段跳过,
    // 行为与今日完全一致。位置在 cap 比较之前:去重命中不该让预算继续涨。
    const fingerprint = failure?.capacityFingerprint
    if (fingerprint) {
      const notified = turn.cardCapacityFailures.get(fingerprint)
      if (notified !== undefined) {
        logError('session: unchanged content exceeds card capacity', failure)
        if (!notified) {
          turn.cardCapacityFailures.set(fingerprint, true)
          // 合并调和:本地前缀(code=/operation/element 摘要)保留,再拼上游
          // 378f4a4 的 formatFeishuError 尾(上游测试组钉住 'message=…' 字段;
          // 本地测试组只钉前缀与尾句,两者不冲突)。8529 体检分支的
          // "不内插 API 原文"约束属该分支自身面向非容量失败的凭据安全口径,
          // 本分支是容量拒写的已定型文案面。
          void feishu.sendTextRaw(
            this.chatId,
            `⚠️ 有一项内容换卡后仍超出飞书容量，写入失败(code=${code ?? 'MISS'}, ${failure.operation}, element=${failure.elementId ?? 'MISS'})；其余输出继续处理。\n${formatFeishuError({ ...failure, code })}`,
          )
        }
        return
      }
      turn.cardCapacityFailures.set(fingerprint, false)
    }
    if (turn.failureRotateCount >= MAX_MIDTURN_ROTATES) {
      turn.rotateGivenUp = true
      // log-only 要名副其实:停掉 footer 档位计时器,并把当前卡整卡标记
      // 拒写,否则 ticker + stream handler 会对着死卡刷到 turn 结束
      // (2026-07-04:11 分钟 663 条 300308)。
      this.stopFooterStatus(turn)
      cardkit.markCardWriteDead(turn.cardId)
      logDiagnostic("session: failure-rotate cap (")
      void feishu.sendTextRaw(this.chatId, this.failureRotateGiveUpText(code, failure))
      return
    }

    logDiagnostic("session: on")
    turn.failureRotateCount++
    this.startMidTurnRotate(turn)
  }

  /** Real content write landed on the active card — clear the failure-
   * rotate streak so a recovered card isn't one blip away from log-only.
   * Footer ticks deliberately do not call this (they fire every second). */
  onCardWriteSuccess(cardId: string): void {
    const turn = this.currentTurn
    if (!turn || turn.cardId !== cardId) return
    if (turn.rotateGivenUp || turn.rotating) return
    if (turn.failureRotateCount === 0) return
    logDiagnostic("session: card write recovered")
    turn.failureRotateCount = 0
  }

  /** User-facing give-up copy, branched by the last observed Feishu code. */
  private failureRotateGiveUpText(code?: number, failure?: cardkit.CardWriteFailure): string {
    const n = MAX_MIDTURN_ROTATES
    if (cardkit.isCardSizeLimitFailure(code, failure)) {
      return `⚠️ 卡片写入失败已触发 ${n} 次换卡仍未恢复(飞书卡片体积超限 code=${code}),本轮后续输出仅日志可见。`
    }
    if (cardkit.isElementLimitCode(code)) {
      return `⚠️ 卡片写入失败已触发 ${n} 次换卡仍未恢复(飞书元素超限 code=${code}),本轮后续输出仅日志可见。`
    }
    if (typeof code === 'number') {
      return `⚠️ 卡片写入失败已触发 ${n} 次换卡仍未恢复(飞书 API 拒绝 code=${code}),本轮后续输出仅日志可见。`
    }
    return `⚠️ 卡片写入失败已触发 ${n} 次换卡仍未恢复(疑似飞书故障),本轮后续输出仅日志可见。`
  }

  /** Open a fresh card under the **same** SDK turn number for additional
   * user guidance or Feishu's per-card size/element limit. The old card stays in the chat —
   * we flip its footer to "📨 已续至下一张卡", turn streaming off, and
   * dispose its cardkit state — but it never becomes the writable one
   * again. Turn state is reset so subsequent stream handlers wire up
   * against the new card cleanly; the still-live content is carried over
   * rather than dropped: the in-flight assistant segment (rebuilt and
   * continued) and any unfinished / failed tools (rebuildToolsOnRotate
   * moves them, file-tool batches split out), while already-finished tools stay on
   * the old card. */
  private startMidTurnRotate(turn: TurnState, opts: { userInputs?: string[]; onCardSent?: () => void } = {}): void {
    if (turn.rotating) return
    const forSteering = opts.userInputs !== undefined
    turn.rotateCount++
    const oldCardId = turn.cardId
    // 同步快照 tool 簿子 —— swap 会把这俩 Map 换成新的空 Map,旧对象仍被这俩
    // 引用持有(切卡 async 窗口里到达的新 tool 也继续 append 进旧 Map),
    // rebuildToolsOnRotate 用它们把"未完成/建失败"的 tool 搬到新卡。
    // assistant 段不在这里快照:它要带的是 swap 那一刻的最新全文(含切卡窗口期
    // 的 delta),所以放到 swap 时再读 —— 配合 appendAssistant onFailure 在
    // rotating 期间不 reset,这段会一直累积到 swap,窗口期的字一个不丢。
    const oldToolByUseId = turn.toolByUseId
    const oldBatches = turn.toolBatches
    // 新卡在 swap/rebuild 窗口里的写失败不能递归换卡;先记住第一个失败,
    // 释放本轮锁后合并触发一次(上游 4185808:卡片写串行,首个失败是根因,
    // 后续 target/duplicate 报错可能只是它的级联)。
    const deferredWriteFailure: {
      value: { code?: number; meta?: cardkit.CardWriteFailureMeta } | null
    } = { value: null }
    const rememberDeferredWriteFailure = (
      code?: number,
      meta?: cardkit.CardWriteFailureMeta,
    ): void => {
      if (!deferredWriteFailure.value) {
        deferredWriteFailure.value = { code, meta }
      }
    }
    turn.rotating = (async () => {
      try {
        const card = cards.mainConversationCard({
          sessionName: this.sessionName,
          turn: this.turnCounter,
          provider: turn.provider,
          model: turn.model ?? undefined,
          effort: turn.effort ?? 'MISS',
          kind: forSteering ? 'user_steering' : 'card_full',
          userInputs: opts.userInputs ?? [],
        })
        let sendFailure: unknown
        const newMessageId = await feishu.sendCard(this.chatId, card, error => { sendFailure = error })
        if (!newMessageId) {
          logDiagnostic('session: mid-turn rotate sendCard failed')
          if (!forSteering && this.currentTurn === turn) {
            if (turn.cardRotationFailed) {
              logDiagnostic("session: mid-turn rotate sendCard failed twice — giving up, rest of turn is log-only")
              turn.rotateGivenUp = true
              this.stopFooterStatus(turn)
              cardkit.markCardWriteDead(turn.cardId)
              await feishu.sendTextRaw(
                this.chatId,
                '⚠️ 续卡连续发送失败，本轮后续输出仅日志可见。',
              )
            } else {
              logDiagnostic("session: mid-turn rotate sendCard failed — retry on the next content event")
              turn.cardRotationFailed = true
              this.stopFooterStatus(turn)
              await feishu.sendTextRaw(
                this.chatId,
                '⚠️ 续卡发送失败，后续内容到达时会再次尝试。',
              )
            }
          } else if (forSteering) {
            await feishu.sendTextRaw(
              this.chatId,
              `⚠️ 追加消息已交给 Agent，但新卡片发送失败。\n${formatFeishuError(sendFailure)}`,
            )
          }
          return
        }
        // The new input panel is now visible in chat. Remove its waiting
        // reactions here, without waiting for conversion/migration/old close.
        opts.onCardSent?.()
        let newCardId: string
        try { newCardId = await cardkit.convertMessageToCard(newMessageId) }
        catch (e) {
          logError("session: mid-turn rotate id_convert failed", e)
          if (!forSteering && this.currentTurn === turn) {
            // 与 sendCard 分支同一两级阶梯:首次暂停重试、二次才 give-up。
            if (turn.cardRotationFailed) {
              logError("session: mid-turn rotate id_convert failed twice — giving up, rest of turn is log-only", e)
              turn.rotateGivenUp = true
              this.stopFooterStatus(turn)
              cardkit.markCardWriteDead(turn.cardId)
              await feishu.sendTextRaw(
                this.chatId,
                '⚠️ 续卡初始化连续失败，本轮后续输出仅日志可见。',
              )
            } else {
              turn.cardRotationFailed = true
              this.stopFooterStatus(turn)
              await feishu.sendTextRaw(
                this.chatId,
                '⚠️ 续卡已发送，但 Card Kit 初始化失败；后续内容到达时会再次尝试。',
              )
            }
          } else if (forSteering) {
            await feishu.sendTextRaw(
              this.chatId,
              `⚠️ 追加消息已交给 Agent，但新卡片初始化失败。\n${formatFeishuError(e)}`,
            )
          }
          return
        }
        // Capacity pages have a banner; steering pages have the new inputs.
        const initialElements = 1 + (forSteering ? (opts.userInputs!.length > 0 ? 1 : 0) : 1)
        cardkit.recordCardCreated(
          newCardId,
          initialElements,
          (code, meta) => {
            if (turn.rotating) {
              rememberDeferredWriteFailure(code, meta)
              return
            }
            this.onCardWriteFailure(newCardId, code, meta)
          },
          () => this.onCardWriteSuccess(newCardId),
        )
        // 先让旧卡上已经登记的 assistant raw 写入定局，再读取 deadElements、
        // 迁移失败段和 drain mathRenderInflight。rotating 期间 finalize 会早退，
        // 不会再新增旧卡 completed write；这一轮 drain 足以封住 swap 竞态。
        const oldAssistantWrites = turn.assistantWriteInflight?.get(oldCardId)
        if (oldAssistantWrites?.size) {
          await Promise.allSettled([...oldAssistantWrites])
        }
        // 同步 swap：从这一行起,后续 stream handler 看到的 turn.cardId
        // 是新卡。reset 所有 element-id 引用 (toolCount / assistantSegmentCount
        // 等),旧卡上的 element_id 在新卡里查不到,继续 PUT 会 300313。
        this.stopFooterStatus(turn)
        turn.cardId = newCardId
        // 同步复位开卡失败闩锁(上游 @@-4489):新卡已就位,footer 与推送恢复。
        turn.cardRotationFailed = false
        turn.messageId = newMessageId
        turn.toolCount = 0
        turn.toolByUseId = new Map()
        turn.toolBatches = new Map()
        turn.openBatchI = null
        turn.planUpdateCount = 0
        turn.goalUpdateCount = 0
        // swap 那一刻读当前正在写的段(含切卡 async 窗口里到达的全部 delta ——
        // onFailure 在 rotating 期间不 reset,所以这段一直累积到这里)。先读后清。
        const carrySegId = turn.currentAssistantSegmentId
        // 不 trim(上游 @@-4499):正文首尾空白是用户可见内容的一部分。
        const carryText = turn.currentAssistantText ?? ''
        const oldSegmentTexts = turn.segmentTexts
        turn.assistantSegmentCount = 0
        turn.currentAssistantSegmentId = null
        turn.currentAssistantText = ''
        turn.segmentTexts = new Map()
        // swap 同步点就地恢复 live buffer(上游 @@-4499):下面的迁移段有 await,
        // 窗口内到达的 delta 必须**追加**到这个 buffer,而不是被这份前置快照整体
        // 覆盖 —— 旧形态「等迁移跑完再恢复」会丢掉窗口里的字。
        if (carrySegId && carryText) {
          const reSegId = cards.ELEMENTS.assistant(turn.assistantSegmentCount++)
          turn.currentAssistantSegmentId = reSegId
          turn.currentAssistantText = carryText
          turn.segmentTexts.set(reSegId, carryText)
        }
        // 渲染状态按卡隔离(review #2):旧卡的 rendered/inflight 条目原样
        // 保留(下面旧卡收尾要 drain + 跳过),新卡从零开始 —— 段 id 重编号
        // 后同名段不会被旧卡标记误伤。
        if (carryText) this.startWritingFooter(turn)
        else this.startThinkingFooter(turn)
        // 先在新卡重建实时任务总览区(紧贴 footer)。必须在 assistant/tool 重建
        // 之前 —— 后者 insert_before taskLiveAnchor(turn),live 区没建就会指向
        // 不存在的 target 而写入失败。taskLiveInserted 是 turn 级 flag,swap 不重置,
        // 新卡照搬本 turn 是否建过实时区,保证换卡后任务总览不丢。
        if (turn.taskLiveInserted) {
          void cardkit.addElement(turn.cardId, cards.taskBoardLiveElement(this.taskBoard), {
            type: 'insert_before', targetElementId: cards.ELEMENTS.footer,
          })
        }
        // 实时计划区同样重建(任务总览正上、顺序与首建一致)。planLiveInserted
        // 同为 turn 级 flag,swap 不重置。
        if (turn.planLiveInserted) {
          void cardkit.addElement(turn.cardId, cards.planLiveElement(turn.planSteps, turn.planExplanation, cards.ELEMENTS.planLive), {
            type: 'insert_before', targetElementId: turn.taskLiveInserted ? cards.ELEMENTS.taskBoardLive : cards.ELEMENTS.footer,
          })
        }
        // A compaction can span the rotation window. Rebuild its in-progress
        // panel on the fresh card and move the pending receipt before the end
        // event arrives; otherwise completion would PUT the disposed old card
        // and leave the visible panel stuck at "压缩中" (上游 4185808)。
        for (const pending of turn.contextCompactionPending.values()) {
          if (pending.cardId !== oldCardId) continue
          pending.cardId = newCardId
          pending.created = false
          pending.createFailure = undefined
          const elementId = cards.ELEMENTS.contextCompact(pending.i)
          pending.createPromise = cardkit.addElementResult(
            newCardId,
            cards.contextCompactionElement(pending.i, pending.notice, elementId),
            {
              type: 'insert_before',
              targetElementId: sessionTools.taskLiveAnchor(turn),
            },
          ).then(result => {
            if (pending.cardId === newCardId) {
              pending.created = result.landed
              pending.createFailure = result.failure
            }
            return result.landed
          })
        }
        // 已完成但在旧卡插入失败的 assistant 段也要搬到新卡。正文现在是
        // block 完成后一次性 addElement；如果这个 addElement 撞上元素上限,
        // cardkit 会把旧元素标 dead 并触发轮转,这里负责补显示。
        for (const [segId, fullText] of oldSegmentTexts) {
          if (carrySegId && carryText && segId === carrySegId) continue
          if (!cardkit.isDeadElement(oldCardId, segId)) continue
          const ri = turn.assistantSegmentCount++
          const reSegId = cards.ELEMENTS.assistant(ri)
          turn.segmentTexts.set(reSegId, fullText)
          // 与主路径共用 checked 原文写入 + 原子公式替换；保留 task board
          // 和其他双后端轮转状态，不在这里复制一套公式事务。
          await this.addCompletedAssistantSegment(turn, reSegId, fullText)
        }
        // 把"还在跑 / 建失败"的 tool 搬到新卡(已完成的留旧卡),Read/Edit 批次切开重建。
        sessionTools.rebuildToolsOnRotate(this, oldCardId, newCardId, oldToolByUseId, oldBatches, turn)
        // A completed tool's old-card add may still be queued at swap time.
        // Once the card id/map have switched, no new handler can enqueue to
        // the old card; drain it, then run the idempotent rebuild pass again
        // so a late rejected add is not lost from both cards.(上游 @@-4565)
        await cardkit.flush(oldCardId)
        sessionTools.rebuildToolsOnRotate(this, oldCardId, newCardId, oldToolByUseId, oldBatches, turn)
        // Finished output left on the old page is real pagination progress,
        // even when later tools/paragraphs happen to contain identical text —
        // 旧卡留有非携带内容 = 换卡真的推进了,容量记账作废(新一轮预算)。
        const carriedIds = new Set<string>([
          cards.ELEMENTS.taskBoardLive,
          cards.ELEMENTS.planLive,
          ...[...turn.contextCompactionPending.values()].map(pending => cards.ELEMENTS.contextCompact(pending.i)),
        ])
        if (carrySegId) carriedIds.add(carrySegId)
        for (const meta of oldToolByUseId.values()) {
          if (meta.output == null) carriedIds.add(cards.ELEMENTS.tool(meta.i))
        }
        const retiredContent = cardkit.getWrittenContentElementIds(oldCardId)
          .some(id => !carriedIds.has(id))
        if (retiredContent) turn.cardCapacityFailures.clear()
        // Include queued tool/live-panel migration failures before releasing
        // the rotation lock(上游 @@-4565):释放锁之后再落地,失败会漏给新 card
        // 的 handler —— 先 flush 掉排队中的迁移写入。未决失败保留到旧卡留下
        // 内容为止:压缩完成只能在锁释放后重试,即使其起始面板已迁移成功。
        await cardkit.flush(newCardId)
        // 旧卡收尾:footer 红字 + streaming_off + dispose。放到 swap 后
        // 是因为这条链是 async,期间 cardkit 队列上还可能有 add/replace 等;
        // 让它们排在 footer 之前,视觉更连贯。
        try {
          // 旧卡 inflight 公式渲染先 drain(渲染 promise 只写捕获的
          // oldCardId,不会碰新卡)—— 不等的话下面原文 replace 会覆盖
          // 还没落地的渲染版,渲染晚到再写已被 dispose 拒绝(review #2)。
          await sessionTools.waitForImageDeliveries(turn, oldCardId)
          const oldInflight = turn.mathRenderInflight?.get(oldCardId)
          if (oldInflight?.size) {
            await Promise.allSettled([...oldInflight])
          }
          await cardkit.flush(oldCardId)
          // 旧卡上已完成的 assistant 段做最终替换。当前迁移中的半段尚未
          // 插入旧卡,直接跳过,避免同一段同时出现在两张卡上。已渲染段
          // 跳过 —— 原文重渲会把渲染版覆盖回 $$…$$ 降级(review #2)。
          const oldRendered = turn.mathRendered?.get(oldCardId)
          for (const [segId, fullText] of oldSegmentTexts) {
            if (carrySegId && carryText && segId === carrySegId) continue
            if (cardkit.isDeadElement(oldCardId, segId)) continue
            if (oldRendered?.has(segId)) continue
            await cardkit.replaceElement(
              oldCardId,
              segId,
              this.completedAssistantElement(segId, fullText),
            )
          }
          const compactNote = turn.contextCompactCount > 0
            ? ` · 🚨 压缩×${turn.contextCompactCount}`
            : ''
          const failures: cardkit.CardWriteFailure[] = []
          const onFailure = (failure: cardkit.CardWriteFailure) => { failures.push(failure) }
          const footerLanded = await cardkit.replaceElementChecked(
            oldCardId,
            cards.ELEMENTS.footer,
            this.footerElement(this.withModel(`📨 已续至下一张卡 ↓${compactNote}`)),
            { notifyCardFailure: false, onFailure },
          )
          cardkit.cancelSummary(oldCardId)
          const settingsLanded = await cardkit.patchSettingsChecked(oldCardId, cards.streamingOffSettings({ suffix: '📨 转下一张' }), onFailure)
          if (footerLanded && settingsLanded) await cardkit.dispose(oldCardId)
          else {
            logDiagnostic('session: rotate old-card terminal MISS')
            await feishu.sendTextRaw(
              this.chatId,
              `⚠️ 上一张对话卡未能正常关闭 (footer=${footerLanded ? 'ok' : 'MISS'}, settings=${settingsLanded ? 'ok' : 'MISS'})，本轮输出已续到新卡。\n${cardFailureDetails(failures)}`,
            )
          }
        } catch (e) {
          logError('session: mid-turn rotate close-old failed', e)
        }
      } finally {
        turn.rotating = null
        // 释放锁后补触发 swap/rebuild 窗口里记下的第一个新卡写失败;
        // 若 close 已捕获 turn,则由 close 的正文保全处理。
        const deferred = deferredWriteFailure.value
        if (deferred && this.currentTurn === turn) {
          this.onCardWriteFailure(turn.cardId, deferred.code, deferred.meta)
        }
      }
    })()
  }

  // Stream-event handlers are intentionally SYNCHRONOUS. Every cardkit op
  // is queued (per-card Promise chain in cardkit.ts), so we fire-and-
  // forget here and rely on enqueue source order — that way no `await`
  // can yield mid-handler and let `closeTurnCard` (or another event) race
  // and mutate `this.currentTurn` underfoot.

  private addPlanSnapshotOnCurrentTurn(): void {
    const turn = this.currentTurn
    if (!turn || turn.planSteps.length === 0) return
    this.maybeMidTurnRotate()
    const cardId = turn.cardId
    const elementId = cards.ELEMENTS.planUpdate(turn.planUpdateCount++)
    void cardkit.addElement(cardId, cards.planElement(turn.planSteps, turn.planExplanation, '', elementId), {
      type: 'insert_before',
      targetElementId: sessionTools.taskLiveAnchor(turn),
    })
  }

  private addGoalUpdateOnCurrentTurn(goal: cards.ThreadGoal): void {
    const turn = this.currentTurn
    if (!turn) return
    this.maybeMidTurnRotate()
    const elementId = cards.ELEMENTS.goalUpdate(turn.goalUpdateCount++)
    void cardkit.addElement(turn.cardId, cards.goalElement(goal, elementId), {
      type: 'insert_before',
      targetElementId: sessionTools.taskLiveAnchor(turn),
    })
  }

  private addGoalClearedOnCurrentTurn(): void {
    const turn = this.currentTurn
    if (!turn) return
    this.maybeMidTurnRotate()
    const elementId = cards.ELEMENTS.goalUpdate(turn.goalUpdateCount++)
    void cardkit.addElement(turn.cardId, {
      tag: 'markdown',
      element_id: elementId,
      content: '**🎯 当前目标**\n\n已清除',
    }, {
      type: 'insert_before',
      targetElementId: sessionTools.taskLiveAnchor(turn),
    })
  }

  private handleContextCompacted(
    source: AgentProcess | null,
    notice?: ContextCompactedNotification,
  ): void {
    // 合并兼容:上游事件面与上游测试组按单参 handleContextCompacted(notice)
    // 调用;本地(生产注册点 + 本地测试组)按两参 (source, notice)。定稿签名取
    // 本地两参,单参调用在此归一 —— 首参整体当作 notice,source=null(仅影响
    // watchdog 归属观察,单参面本就没有 source)。
    if (notice === undefined) {
      notice = source as unknown as ContextCompactedNotification
      source = null
    }
    if (!notice) return
    const receiptKeys = compactionReceiptKeys(notice)
    // Standalone `cm` owns its own status card and watcher. Even if a user
    // starts a new turn before that command finishes, its completion must not
    // leak into the new conversation card (上游 4185808).
    if (this.manualContextCompactionPending) {
      if (receiptKeys.length > 0) {
        this.rememberContextCompactionReceipt(
          receiptKeys,
          null,
          notice.phase !== 'start',
        )
      }
      if (notice.phase !== 'start') {
        this.lastManualContextCompactionCompletedAt = Date.now()
        this.lastManualContextCompactionWasAnonymous = receiptKeys.length === 0
      }
      return
    }
    if (notice.phase === 'start') {
      this.lastManualContextCompactionWasAnonymous = false
    } else if (
      (receiptKeys.length === 0 || this.lastManualContextCompactionWasAnonymous) &&
      Date.now() - this.lastManualContextCompactionCompletedAt < ANONYMOUS_COMPACTION_DEDUPE_MS
    ) {
      return
    }

    const turn = this.currentTurn
    const itemReceiptKey = notice.itemId ? `item:${notice.itemId}` : undefined
    const turnReceiptKey = receiptKeys.find(candidate => candidate.startsWith('turn:'))
    let receiptLookupKey = itemReceiptKey ?? turnReceiptKey
    let receipt = receiptLookupKey
      ? this.contextCompactionReceipts.get(receiptLookupKey)
      : undefined
    // The generic turn notification and item notification may arrive in
    // either order. A near-simultaneous completed turn alias closes the same
    // physical event; a later explicit item remains eligible as a new one.
    if (itemReceiptKey && !receipt && notice.phase !== 'start' && turnReceiptKey) {
      const turnReceipt = this.contextCompactionReceipts.get(turnReceiptKey)
      if (
        (!turnReceipt?.hasItemAlias && turnReceipt?.completed &&
          Date.now() - turnReceipt.completedAt < ANONYMOUS_COMPACTION_DEDUPE_MS) ||
        (!turnReceipt?.hasItemAlias && turnReceipt?.completionKey &&
          turn?.contextCompactionCompleting.has(turnReceipt.completionKey))
      ) {
        receiptLookupKey = turnReceiptKey
        receipt = turnReceipt
        // Claim this explicit item as the item-side alias of the generic
        // receipt. Later distinct items in the same turn must remain new.
        turnReceipt.hasItemAlias = true
        this.contextCompactionReceipts.delete(itemReceiptKey)
        this.contextCompactionReceipts.set(itemReceiptKey, turnReceipt)
      }
    }

    if (!turn) {
      const owner = this.openingTurnOwner
      if (owner && 'pendingCompactions' in owner && owner.backendTurnStarted) {
        owner.pendingCompactions.push(notice)
        logDiagnostic("session: buffer context compaction")
        return
      }
      if (receiptKeys.length > 0) {
        this.rememberContextCompactionReceipt(receiptKeys, null, notice.phase !== 'start')
      }
      // A terminal compaction notification may legally arrive after result.
      // It carries no assistant content and needs no user action.
      return
    }

    // 本地独有:watchdog 有意义进展观测(每 key:phase 一次)。放在 dedupe
    // 之前 —— 重复通知靠 watchdogSeenCompactionPhases 自身去重,不影响判定。
    const watchdogPhase = `${compactionKey(notice)}:${notice.phase ?? 'event'}`
    if (
      !turn.watchdogSeenCompactionPhases.has(watchdogPhase) &&
      source &&
      this.observeWatchdogMeaningful(source, `context_compaction:${notice.phase ?? 'event'}`)
    ) {
      turn.watchdogSeenCompactionPhases.add(watchdogPhase)
    }

    if (receiptLookupKey && receipt?.completed) {
      return
    }
    const ownerId = this.contextCompactionOwnerId(turn)
    if (receiptLookupKey && receipt && receipt.ownerId !== ownerId) {
      this.rememberContextCompactionReceipt(receiptKeys, null, true)
      return
    }
    if (
      receiptLookupKey &&
      receipt?.completionKey &&
      turn.contextCompactionCompleting.has(receipt.completionKey)
    ) {
      return
    }
    if (
      notice.phase !== 'start' &&
      receiptKeys.length > 0 &&
      turn.contextCompactionPending.size === 0 &&
      turn.contextCompactionCompleting.has('__anonymous__')
    ) {
      return
    }
    if (
      notice.phase !== 'start' &&
      receiptKeys.length > 0 &&
      turn.contextCompactionPending.size === 0 &&
      turn.lastContextCompactionWasAnonymous &&
      Date.now() - turn.lastContextCompactionCompletedAt < ANONYMOUS_COMPACTION_DEDUPE_MS
    ) {
      return
    }

    if (notice.phase === 'start') {
      const key = compactionKey(notice)
      if (turn.contextCompactionPending.has(key) || turn.contextCompactionCompleted.has(key)) {
        return
      }
      this.startWorkingFooter(turn)
      if (turn.currentAssistantSegmentId) this.finalizeCurrentAssistantSegment()
      turn.openBatchI = null
      this.maybeMidTurnRotate()
      turn.lastContextCompactionWasAnonymous = false
      if (receiptKeys.length > 0) {
        this.rememberContextCompactionReceipt(receiptKeys, ownerId, false)
      }
      const i = turn.contextCompactCount++
      const cardId = turn.cardId
      const elementId = cards.ELEMENTS.contextCompact(i)
      const pending = {
        i,
        cardId,
        notice,
        created: false,
        createFailure: undefined as cardkit.CardWriteFailure | undefined,
        createPromise: Promise.resolve(false),
      }
      pending.createPromise = cardkit.addElementResult(
        cardId,
        cards.contextCompactionElement(i, notice, elementId),
        {
          type: 'insert_before',
          targetElementId: sessionTools.taskLiveAnchor(turn),
        },
      ).then(result => {
        if (pending.cardId === cardId) {
          pending.created = result.landed
          pending.createFailure = result.failure
        }
        return result.landed
      })
      turn.contextCompactionPending.set(key, pending)
      cardkit.patchSummaryThrottled(turn.cardId, `🚨 压缩×${turn.contextCompactCount}`)
      return
    }

    if (
      !notice.itemId &&
      !notice.turnId &&
      turn.contextCompactionCompleting.size > 0
    ) {
      return
    }
    if (
      !notice.itemId &&
      !notice.turnId &&
      turn.contextCompactionPending.size === 0 &&
      Date.now() - turn.lastContextCompactionCompletedAt < ANONYMOUS_COMPACTION_DEDUPE_MS
    ) {
      return
    }
    const explicitKey = notice.itemId || notice.turnId
    if (explicitKey && turn.contextCompactionCompleted.has(explicitKey)) {
      return
    }
    const key = notice.itemId
      ? (turn.contextCompactionPending.has(notice.itemId) ? notice.itemId : null)
      : latestPendingCompactionKey(turn)
    const pending = key ? turn.contextCompactionPending.get(key) : undefined
    const completionKey = key ?? explicitKey ?? '__anonymous__'
    if (turn.contextCompactionCompleting.has(completionKey)) {
      return
    }

    this.startWorkingFooter(turn)
    if (turn.currentAssistantSegmentId) this.finalizeCurrentAssistantSegment()
    turn.openBatchI = null
    this.maybeMidTurnRotate()
    const merged = mergeCompactionNotices(pending?.notice, notice)
    const priorEndOnlyI = turn.contextCompactionEndOnly.get(completionKey)
    const i = pending?.i ?? priorEndOnlyI ?? turn.contextCompactCount++
    if (!pending && priorEndOnlyI === undefined) {
      turn.contextCompactionEndOnly.set(completionKey, i)
    }
    turn.contextCompactionCompleting.add(completionKey)
    const completionReceiptKeys = [...new Set([
      ...compactionReceiptKeys(pending?.notice ?? {}),
      ...receiptKeys,
    ])]
    if (completionReceiptKeys.length > 0) {
      this.rememberContextCompactionReceipt(
        completionReceiptKeys,
        ownerId,
        false,
        completionKey,
      )
    }
    const elementId = cards.ELEMENTS.contextCompact(i)
    const element = cards.contextCompactionElement(i, merged, elementId)
    void (async () => {
      let landed = false
      if (!pending) {
        for (let attempt = 0; attempt < MAX_MIDTURN_ROTATES + 2; attempt++) {
          const targetCardId = turn.cardId
          landed = await cardkit.addElementChecked(targetCardId, element, {
            type: 'insert_before',
            targetElementId: sessionTools.taskLiveAnchor(turn),
          })
          if (landed) break
          const rotation = turn.rotating
          if (rotation) {
            await rotation
            continue
          }
          if (turn.cardId !== targetCardId) continue
          break
        }
      } else {
        // A start add and rotation copy may still be in flight. Always finish
        // the latest authoritative card; a failed start is retried as an add
        // of the terminal element, not a PUT to a phantom id.
        for (let attempt = 0; attempt < MAX_MIDTURN_ROTATES + 2; attempt++) {
          const targetCardId = pending.cardId
          await pending.createPromise
          if (pending.cardId !== targetCardId) continue
          if (pending.created) {
            landed = await cardkit.replaceElementChecked(targetCardId, elementId, element)
          } else {
            if (cardkit.isDuplicateElementFailure(
              pending.createFailure?.code,
              pending.createFailure,
            )) {
              cardkit.clearDeadElementForReconcile(targetCardId, elementId)
              landed = await cardkit.replaceElementChecked(
                targetCardId,
                elementId,
                element,
                { notifyCardFailure: false },
              )
            }
            if (!landed) {
              landed = await cardkit.addElementChecked(targetCardId, element, {
                type: 'insert_before',
                targetElementId: sessionTools.taskLiveAnchor(turn),
              })
            }
          }
          if (pending.cardId !== targetCardId) continue
          if (landed) {
            pending.created = true
            break
          }
          const rotation = turn.rotating
          if (rotation) {
            await rotation
            continue
          }
          if (pending.cardId !== targetCardId) continue
          break
        }
      }
      turn.contextCompactionCompleting.delete(completionKey)
      if (!landed) {
        logDiagnostic('session: context compaction completion write failed')
        return
      }
      if (key && turn.contextCompactionPending.get(key) === pending) {
        turn.contextCompactionPending.delete(key)
      }
      turn.contextCompactionEndOnly.delete(completionKey)
      if (completionKey !== '__anonymous__') {
        turn.contextCompactionCompleted.add(completionKey)
      }
      turn.lastContextCompactionCompletedAt = Date.now()
      turn.lastContextCompactionWasAnonymous = completionKey === '__anonymous__'
      if (completionReceiptKeys.length > 0) {
        const claimedAliases = [...this.contextCompactionReceipts.entries()]
          .filter(([, candidate]) => candidate.completionKey === completionKey)
          .map(([alias]) => alias)
        this.rememberContextCompactionReceipt(
          [...new Set([...completionReceiptKeys, ...claimedAliases])],
          null,
          true,
        )
      }
    })().catch(error => {
      turn.contextCompactionCompleting.delete(completionKey)
      logError('session: context compaction completion transaction failed', error)
    })
    cardkit.patchSummaryThrottled(turn.cardId, `🚨 压缩×${turn.contextCompactCount}`)
  }

  private contextCompactionOwnerId(turn: TurnState): number {
    const current = this.contextCompactionOwnerIds.get(turn)
    if (current !== undefined) return current
    const id = ++this.contextCompactionOwnerSequence
    this.contextCompactionOwnerIds.set(turn, id)
    return id
  }

  private rememberContextCompactionReceipt(
    keys: string[],
    ownerId: number | null,
    completed: boolean,
    completionKey?: string,
  ): void {
    const receipt = {
      ownerId: completed ? null : ownerId,
      completed,
      completedAt: completed ? Date.now() : 0,
      ...(completed || !completionKey ? {} : { completionKey }),
      hasItemAlias: keys.some(key => key.startsWith('item:')),
    }
    for (const key of keys) {
      this.contextCompactionReceipts.delete(key)
      this.contextCompactionReceipts.set(key, receipt)
    }
    while (this.contextCompactionReceipts.size > MAX_CONTEXT_COMPACTION_RECEIPTS) {
      let victim: {
        ownerId: number | null
        completed: boolean
        completedAt: number
        completionKey?: string
        hasItemAlias: boolean
      } | undefined
      for (const candidate of this.contextCompactionReceipts.values()) {
        if (candidate.completed) { victim = candidate; break }
        victim ??= candidate
      }
      if (!victim) break
      // Aliases for one receipt are an atomic tombstone. Remove all together
      // so eviction never leaves item-only or turn-only half-state behind.
      for (const [key, candidate] of this.contextCompactionReceipts) {
        if (candidate === victim) this.contextCompactionReceipts.delete(key)
      }
    }
  }

  private handleTurnPlanUpdated(source: AgentProcess, update: TurnPlanUpdated): void {
    const turn = this.currentTurn
    if (!turn) {
      return
    }
    const previous = JSON.stringify({
      planSteps: turn.planSteps,
      planExplanation: turn.planExplanation,
    })
    this.startWorkingFooter(turn)
    if (turn.currentAssistantSegmentId) this.finalizeCurrentAssistantSegment()
    turn.openBatchI = null
    if (!Array.isArray(update.plan)) {
      logDiagnostic('session: turn/plan/updated missing plan array')
      turn.planSteps = []
    } else {
      turn.planSteps = update.plan.map(step => ({
        step: typeof step.step === 'string' && step.step ? step.step : 'MISS',
        status: typeof step.status === 'string' && step.status ? step.status : 'MISS',
      }))
    }
    turn.planExplanation = typeof update.explanation === 'string' ? update.explanation : null
    const current = JSON.stringify({
      planSteps: turn.planSteps,
      planExplanation: turn.planExplanation,
    })
    if (current !== previous) this.observeWatchdogMeaningful(source, 'turn_plan_updated')
    // 实时计划区:首次 plan 更新建立(任务总览正上),之后 replace 成最新快照 ——
    // codex 的 turn/plan/updated 每次都带完整计划,这里让卡片末尾永远是最新的,
    // 与 claude 侧任务总览(taskBoardLive)常驻语义一致。timeline 快照仍照旧插入
    // (过程变更记录)。空 plan(steps 为空/畸形数组)与 timeline 快照的守卫
    // (addPlanSnapshotOnCurrentTurn 跳过空 steps)对齐:不建立也不刷掉已建立的
    // —— 否则一次空更新会把 live 面板 replace 成 '--' 占位,刷掉上一次有效计划。
    if (turn.planSteps.length > 0) {
      if (!turn.planLiveInserted) {
        // 目标锚点先于置位计算:置位后 taskLiveAnchor 会返回 plan_live 自身。
        const target = turn.taskLiveInserted ? cards.ELEMENTS.taskBoardLive : cards.ELEMENTS.footer
        turn.planLiveInserted = true
        void cardkit.addElement(turn.cardId, cards.planLiveElement(turn.planSteps, turn.planExplanation, cards.ELEMENTS.planLive), {
          type: 'insert_before', targetElementId: target,
        })
      } else {
        // The following timeline snapshot carries the plan; this is its live mirror.
        void cardkit.replaceElementChecked(turn.cardId, cards.ELEMENTS.planLive,
          cards.planLiveElement(turn.planSteps, turn.planExplanation, cards.ELEMENTS.planLive),
          { notifyCardFailure: false })
      }
    }
    this.addPlanSnapshotOnCurrentTurn()
  }

  private handlePlanDelta(source: AgentProcess, delta: PlanDelta): void {
    if (typeof delta.delta !== 'string' || !delta.delta) {
      logDiagnostic('session: item/plan/delta missing delta text')
      return
    }
    this.observeWatchdogMeaningful(source, 'plan_delta')
    if (typeof delta.itemId !== 'string' || !delta.itemId) {
      logDiagnostic('session: item/plan/delta missing itemId')
    }
  }

  private handleThreadGoalUpdated(source: AgentProcess, goal: ThreadGoal): void {
    if (!goal || typeof goal.objective !== 'string') {
      logDiagnostic('session: thread/goal/updated missing objective')
      return
    }
    if (goal.tokenBudget != null && typeof goal.tokenBudget !== 'number') {
      logDiagnostic('session: thread/goal/updated invalid tokenBudget')
    }
    const previousGoal = this.currentGoal
    const currentGoal: cards.ThreadGoal = {
      objective: goal.objective,
      status: typeof goal.status === 'string' && goal.status ? goal.status : 'MISS',
      tokenBudget: typeof goal.tokenBudget === 'number'
        ? goal.tokenBudget
        : goal.tokenBudget === null
          ? null
          : Number.NaN,
      tokensUsed: typeof goal.tokensUsed === 'number' ? goal.tokensUsed : Number.NaN,
      timeUsedSeconds: typeof goal.timeUsedSeconds === 'number' ? goal.timeUsedSeconds : Number.NaN,
    }
    this.currentGoal = currentGoal
    if (
      previousGoal &&
      cards.goalDisplaySignature(previousGoal) === cards.goalDisplaySignature(currentGoal)
    ) {
      return
    }
    this.observeWatchdogMeaningful(source, 'thread_goal_updated')
    const turn = this.currentTurn
    if (turn) {
      this.startWorkingFooter(turn)
      if (turn.currentAssistantSegmentId) this.finalizeCurrentAssistantSegment()
      turn.openBatchI = null
    }
    this.addGoalUpdateOnCurrentTurn(currentGoal)
  }

  private handleThreadGoalCleared(source: AgentProcess): void {
    if (!this.currentGoal) return
    this.currentGoal = null
    this.observeWatchdogMeaningful(source, 'thread_goal_cleared')
    const turn = this.currentTurn
    if (!turn) return
    this.startWorkingFooter(turn)
    if (turn.currentAssistantSegmentId) this.finalizeCurrentAssistantSegment()
    turn.openBatchI = null
    this.addGoalClearedOnCurrentTurn()
  }

  private appendAssistant(delta: string): void {
    if (!this.currentTurn) {
      // 只在合法无卡窗口缓冲:正在开卡(openingTurn),或恢复轮开卡失败后
      // 的续窗(bgResumeCardless)。其余无卡场景(被打断的轮尾、进程 kill
      // 窗口的残字、轮间游离 delta)一律丢弃 —— 缓冲下来只会被错误推送或
      // 并入下一张不相干的卡(旧代码此处直接 return 丢弃,行为一致)。
      if (this.openingTurn || this.bgResumeCardless) this.orphanAssistantCurrent += delta
      return
    }
    const turn = this.currentTurn
    // 第一条 assistant text_delta 到达 → footer 切到 Writing 计时。
    // 正文自身只进入内存缓冲,等 agentMessage completed 后一次性插入卡片。
    this.startWritingFooter(turn)
    if (!turn.currentAssistantSegmentId) {
      // New assistant segment opens a visual break — any prior file-tool run
      // is now visually separated from future calls, so close the batch
      // window. Future file-tool calls will start a fresh batch at a new i.
      turn.openBatchI = null
      // Pre-empt the 300305 component-count cliff (which Card Kit may wrap
      // inside a generic 300315 add failure) —
      // if the card's element count is approaching Feishu's cap, fire-and-
      // forget kick off a mid-turn rotation onto a fresh card before this
      // buffered segment is eventually inserted. The rotation handler resets
      // turn state once the new card is up so subsequent stream handlers see
      // the new cardId.
      this.maybeMidTurnRotate()
      const i = turn.assistantSegmentCount++
      const segId = cards.ELEMENTS.assistant(i)
      turn.currentAssistantSegmentId = segId
      turn.currentAssistantText = ''
    }
    turn.currentAssistantText += delta
    const segId = turn.currentAssistantSegmentId
    if (!segId) return
    turn.segmentTexts.set(segId, turn.currentAssistantText)
    this.processOutboundMarkers(turn.currentAssistantText)
    this.processHostAskMarkers(turn.currentAssistantText, turn)
    const displayText = this.cleanAssistantTextForDisplay(turn.currentAssistantText)
    // Chat-list preview: head of the latest assistant text (~40 chars —
    // 开头即主题,流式期间稳定不闪;尾部截断会把 markdown 语法尾巴糊进列表行)。
    // Feishu truncates anyway. patchSummaryThrottled is rate-limited on its own.
    const head = displayText.slice(0, 40)
    cardkit.patchSummaryThrottled(turn.cardId, head)
  }

  /** 取走并清空孤儿 assistant 缓冲(定稿段 + 未定稿尾段,空行分隔)。 */
  private takeOrphanAssistantText(): string {
    const parts = [...this.orphanAssistantSegments]
    if (this.orphanAssistantCurrent.trim()) parts.push(this.orphanAssistantCurrent)
    this.orphanAssistantSegments = []
    this.orphanAssistantCurrent = ''
    return parts.join('\n\n').trim()
  }

  /** 丢弃孤儿缓冲并复位 cardless 续窗标记 —— 用户主动作废(打断/停止/重启)
   *  或进程被替换时调用,内容随轮作废不兜底。 */
  private discardOrphanAssistant(): void {
    this.orphanAssistantSegments = []
    this.orphanAssistantCurrent = ''
    this.bgResumeCardless = false
  }

  /** 无卡兜底:孤儿正文以纯文本消息推进聊天 —— 宁可丢排版,不可丢内容。 */
  private flushOrphanAssistantToChat(_reason: string): void {
    const text = this.takeOrphanAssistantText()
    if (!text) return
    const display = this.cleanAssistantTextForDisplay(text).trim()
    if (!display) return
    void feishu.sendText(this.chatId, `📄 后台轮输出(未能建卡,纯文本兜底):\n\n${display}`)
  }

  /** 渲染路径准入的唯一真相源(开放问题 1 落锁):含公式且清洗后长度不超
   *  ASSISTANT_CARD_CHARS(12k 截断上限)的段才走 column_set 渲染路径。
   *  超长含公式段整体退回普通截断路径 —— 公式经 sanitize→
   *  downgradeMathBlocksInProse 降级为代码块可见,不吞正文;渲染路径永不
   *  服务超长段,否则 replace 会把截断版换回全量 column_set,破 200860
   *  卡体积防线。completedAssistantElement 与 addCompletedAssistantSegment
   *  两个决策点必须共用本谓词,不得各自内联判定。 */
  private mathSegmentEligible(text: string): boolean {
    return mathRender.hasMathSpans(text)
      && this.cleanAssistantTextForDisplay(text).trim().length <= ASSISTANT_CARD_CHARS
  }

  private completedAssistantElement(segId: string, text: string): object {
    if (this.mathSegmentEligible(text)) {
      return this.mathAssistantContainer(segId, [{ type: 'markdown', text }])
    }
    const cleaned = this.cleanAssistantTextForDisplay(text).trim()
    const content = cleaned.length > ASSISTANT_CARD_CHARS
      ? `${cleaned.slice(0, ASSISTANT_CARD_CHARS).trimEnd()}\n\n_…正文已截断（卡片体积限制），完整内容见日志。_`
      : cleaned
    return {
      tag: 'markdown',
      element_id: segId,
      content: cards.sanitizeMarkdownForCardKit(content) || ' ',
    }
  }

  /** 公式段从 raw 到 rendered 始终保持同一个顶层 column_set tag；内部
   *  children 严格按源码顺序交错 markdown/img。这样一次 checked PUT 就能
   *  原子完成 A→公式→B→公式→C，不再把所有图片堆到整段末尾。 */
  private mathAssistantContainer(segId: string, blocks: mathRender.RenderedMathBlock[]): object {
    const elements = blocks.map(block => block.type === 'markdown'
      ? {
          tag: 'markdown',
          // 本地适配:markdown 子块与本地普通段同款清洗链(sanitize 含
          // downgradeMathBlocksInProse / 外链图片降级 / HTML 转义)——raw 态
          // $$…$$ 在子块上同样降级可见,01-11/01-12 图片中和与转义边界在
          // 子块上继续成立。结构化 img 子块不经此链(cardkit 注入点 sanitize
          // 只处理 tag==='markdown' 的 content,天然放行 tag:'img' 组件)。
          content: cards.sanitizeMarkdownForCardKit(this.cleanAssistantTextForDisplay(block.text).trim()) || ' ',
        }
      : { ...block.element })
    return {
      tag: 'column_set',
      element_id: segId,
      flex_mode: 'none',
      columns: [{
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: elements.length ? elements : [{ tag: 'markdown', content: ' ' }],
      }],
    }
  }

  /** 把 raw column_set 原子替换成严格原位交错的 markdown/image 子元素链。
   *  cardId 是调度时捕获的快照，不能在异步渲染后读取 turn.cardId。公式增强
   *  失败不触发整卡轮转：raw LaTeX 已经可见，保留它并暴露日志即可。 */
  private async replaceSegmentWithMathImgs(turn: TurnState, cardId: string, segId: string, text: string): Promise<void> {
    const rendered = await mathRender.renderMathInText(text)
    const okReplace = await cardkit.replaceElementChecked(
      cardId,
      segId,
      this.mathAssistantContainer(segId, rendered.blocks),
      { notifyCardFailure: false },
    )
    if (!okReplace) {
      return
    }

    turn.mathRendered ??= new Map()
    turn.mathRendered.get(cardId) ?? (turn.mathRendered.set(cardId, new Set()), undefined)
    turn.mathRendered.get(cardId)!.add(segId)
  }

  private addCompletedAssistantSegment(turn: TurnState, segId: string, text: string): Promise<boolean> {
    // 先确认原文容器真实落地，再启动公式渲染。checked 写入与公式 promise
    // 都按 cardId 分组登记，close 会依次 drain，避免幽灵元素和 dispose 竞态。
    const cardId = turn.cardId
    const targetElementId = sessionTools.taskLiveAnchor(turn)
    const write = (async (): Promise<boolean> => {
      const added = await cardkit.addElementChecked(
        cardId,
        this.completedAssistantElement(segId, text),
        { type: 'insert_before', targetElementId },
      )
      if (!added) {
        logDiagnostic('session: assistant text write failed')
        return false
      }

      if (this.mathSegmentEligible(text)) {
        const rp = this.replaceSegmentWithMathImgs(turn, cardId, segId, text)
          .catch(e => logError('session: math render failed', e))
        turn.mathRenderInflight ??= new Map()
        turn.mathRenderInflight.get(cardId) ?? (turn.mathRenderInflight.set(cardId, new Set()), undefined)
        turn.mathRenderInflight.get(cardId)!.add(rp)
        void rp.finally(() => turn.mathRenderInflight?.get(cardId)?.delete(rp))
      }
      return true
    })()
    turn.assistantWriteInflight ??= new Map()
    turn.assistantWriteInflight.get(cardId) ?? (turn.assistantWriteInflight.set(cardId, new Set()), undefined)
    turn.assistantWriteInflight.get(cardId)!.add(write)
    void write.finally(() => turn.assistantWriteInflight?.get(cardId)?.delete(write))
    return write
  }

  /** CardKit 正文写入失败时显式保全完整回复；不伪装卡片成功。 */
  private async sendAssistantTextFallback(text: string, reason: string): Promise<void> {
    const raw = text.trim()
    if (!raw) return
    const message = `⚠️ 对话卡片正文写入失败(${reason}),以下为 agent 原始回复:\n\n${raw}`
    const sent = await feishu.sendText(this.chatId, message)
    if (!sent) {
      logDiagnostic('session: assistant text preservation failed')
    }
  }

  /** 收尾当前 assistant 段:正文不再逐字流式输出,只在完整段收到后
   * 一次性插入静态 markdown,然后清空段游标。 */
  finalizeCurrentAssistantSegment(): void {
    const turn = this.currentTurn
    if (!turn) {
      // 无卡窗口的段边界:当前孤儿段定稿进列表,flush 时段间以空行分隔。
      if (this.orphanAssistantCurrent.trim()) this.orphanAssistantSegments.push(this.orphanAssistantCurrent)
      this.orphanAssistantCurrent = ''
      return
    }
    // 正在切卡:别动当前段 —— rotate 会在 swap 时读 currentAssistantText carry
    // 到新卡续写。这里若定稿/reset,过渡窗口里的当前段文字会被清空、carry 落空
    // (跟 appendAssistant onFailure 在 rotating 期间不 reset 同一个道理)。代价是
    // 切卡窗口恰好跨 block 边界时两段可能并作一段 —— 不丢内容,可接受。
    // 续卡失败挂起时,段边界就是一个天然的重试时机(上游 @@-5327):代价同上,
    // 收益是失败的开卡能被下一次内容事件收敛掉。守卫全在 maybeMidTurnRotate 内。
    if (turn.cardRotationFailed) this.maybeMidTurnRotate()
    if (turn.rotating) return
    const segId = turn.currentAssistantSegmentId
    const text = turn.currentAssistantText ?? ''
    if (segId && text.trim()) {
      void this.addCompletedAssistantSegment(turn, segId, text)
      this.startWorkingFooter(turn)
    }
    turn.currentAssistantSegmentId = null
    turn.currentAssistantText = ''
  }

  /** 从一段文字里找完整 [[send: /abs/path]] 标记,一看到就立即发。正文保留
   * 原标记不改,让用户知道触发了哪个文件路径。 */
  private processOutboundMarkers(text: string): void {
    for (const path of extractSendMarkerPaths(text)) {
      this.sendOutboundPath(path, 'send marker')
    }
  }

  private processHostAskMarkers(text: string, turn: TurnState): void {
    for (const marker of extractAskUsrMarkers(text)) {
      if (turn.hostAskMarkersSeen.has(marker.raw)) continue
      turn.hostAskMarkersSeen.add(marker.raw)
      sessionHostAsk.queueHostAskFromMarker(this, marker.payload, marker.raw)
    }
  }

  private cleanAssistantTextForDisplay(text: string): string {
    const replacement = this.proc?.provider === 'codex' || this.proc?.provider === 'claude'
      ? '\n\n_已发起澄清问题，请回答对应卡片。_'
      : ''
    // 只剥离 ask 标记;不做 HTML 转义/图片降级 —— 本函数同时服务纯文本
    // sink(聊天列表预览 patchSummaryThrottled、orphan 纯文本兜底
    // flushOrphanAssistantToChat)与卡片 markdown sink。sanitize 只在卡片
    // markdown 出口(completedAssistantElement / 旧卡段迁移 replaceElement)
    // 做,否则纯文本 sink 会把 &lt; &amp; 等实体原样显示给用户。
    return stripAskUsrMarkers(text, replacement)
  }

  sendOutboundPath(rawPath: string, _source: string): void {
    // 归一化 MSYS/Git Bash 风格路径(/c/Users/... → C:\Users\...);否则
    // Windows 上 statSync 把 /c 当成当前盘根下的相对路径,stat 成
    // C:\c\Users\... 而 ENOENT。
    const p = normalizeOutboundPath(rawPath.trim())
    if (!p) return
    const turn = this.currentTurn
    if (turn?.outboundSeenPaths.has(p)) return
    turn?.outboundSeenPaths.add(p)
    if (!isAbsolute(p)) {
      return
    }
    try {
      const stats = statSync(p)
      if (!stats.isFile()) throw new Error(`路径不是普通文件：${p}`)
      // The boundary is inclusive: exactly 30 MiB still uses chat attachments.
      if (stats.size <= feishu.MAX_UPLOAD_BYTES) {
        turn?.outboundSentPaths.add(p)
        void feishu.uploadAndSend(this.chatId, p)
        return
      }
      if (!turn) throw new Error('当前没有可关联的交付轮次')
      if (!turn.fileDelivery) {
        turn.fileDelivery = this.createFileDeliveryForTurn(turn)
        this.fileDeliveries.add(turn.fileDelivery)
      }
      turn.fileDelivery.add(p)
    } catch (error) {
      logError('session: file delivery rejected', error)
      void feishu.sendText(this.chatId, `❌ 文件交付失败：${messageOf(error)}`)
    }
  }

  createFileDeliveryForTurn(turn: TurnState) {
    return createFileDelivery({
      chatId: this.chatId,
      managerOpenId: turn.userOpenId,
      projectName: this.sessionName,
      createdAt: turn.startedAt,
    })
  }

  /** Start or switch the turn footer phase. It lives in the stable footer
   * element and uses replaceElement so status updates appear immediately
   * instead of invoking Feishu's typewriter. */
  renderFooterStatus(turn: TurnState | null, now: number = Date.now()): void {
    if (!turn?.footerStatusHandle || !turn.footerStatusLabel) return
    const elapsed = cards.liveElapsed(now - turn.footerStatusStartedAt, config.runtime.live_elapsed).label
    const content = turn.footerStatusOverride ?? `${turn.footerStatusLabel} (${elapsed})`
    void this.replaceFooterContent(turn.cardId, this.withModel(content, turn)).catch(_e => {
      logError("session: footer status patch failed", _e)
    })
  }

  private startFooterStatus(turn: TurnState, status: string): void {
    // log-only 之后 phase 切换(Thinking/Writing/Working)不再启动档位 timer ——
    // 卡已标记拒写,继续调度只会空转;续卡失败(停表等重试)同理。
    // 续卡失败时暂停定时刷新；后续真实内容触发重试，成功后恢复。
    if (turn.rotateGivenUp || turn.cardRotationFailed) return
    // 模型满载/连接中断退避进度(上游 2e6e1e0):进程层持有唯一重试节奏,footer 如实反映。
    const retry = turn.provider === 'codex' ? this.proc?.turnRetry : null
    if (retry) {
      const reason = retry.reason === 'stream_disconnected' ? '连接中断'
        : retry.reason === 'compact_connection_failed' ? '压缩连接中断'
        : retry.reason === 'transient_error' ? '服务暂时异常' : '模型满载'
      status = retry.reason === 'quota' ? `⏳ ${retry.message}` : retry.phase === 'waiting'
        ? `⏳ ${reason} · ${retry.delayMs / 1000}s 后重试 #${retry.attempt}`
        : `⏳ ${reason} · 正在重试 #${retry.attempt}`
    }
    // 合并调和(取舍):去重按 label 判定(上游)——不能带本地 handle 条件:卡
    // 写失败后 handle 已清、label 保留,同相位重复进入必须停在 dedupe,否则
    // 会把一次失败放大成多轮 checked 重试(上游用例要求失败后同相位零写入)。
    if (turn.footerStatusLabel === status) return
    this.stopFooterStatus(turn)
    turn.footerStatusLabel = status
    turn.footerStatusStartedAt = Date.now()
    // footer 显示「状态词 + 耗时」(见 cards/background.ts liveElapsed)。
    // bucket 只在档位边界 push;second 固定 1s。
    const render = (): void => {
      if (turn.footerStatusLabel !== status) return
      const cardId = turn.cardId
      // Slow requests/retries must not build a queue of obsolete clock ticks.
      // Phase changes share this gate; terminal writes bypass it and stay checked.
      if (turn.footerStatusWriteCardId === cardId) {
        turn.footerStatusPendingRender = render
        return
      }
      turn.footerStatusPendingRender = undefined
      const { label } = liveElapsed(Date.now() - turn.footerStatusStartedAt, liveElapsedMode())
      const thinking = status === FOOTER_THINKING_PREFIX ? this.proc?.lastThinkingTokens : null
      const progress = typeof thinking === 'number' ? ` · 约 ${thinking} tokens` : ''
      turn.footerStatusWriteCardId = cardId
      void this.replaceFooterContent(cardId, this.withModel(`${status}${progress} (${label})`)).then(result => {
        if (turn.footerStatusWriteCardId === cardId) turn.footerStatusWriteCardId = undefined
        if (turn.cardId !== cardId || turn.footerStatusLabel === null) return
        if (result.landed) {
          const latest = turn.footerStatusPendingRender
          turn.footerStatusPendingRender = undefined
          latest?.()
          return
        }
        turn.footerStatusFailedCardId = cardId
        if (turn.footerStatusHandle) clearTimeout(turn.footerStatusHandle)
        turn.footerStatusHandle = null
        const latest = turn.footerStatusPendingRender
        turn.footerStatusPendingRender = undefined
        if (turn.footerStatusLabel !== status) latest?.()
      })
    }
    const scheduleNext = (): void => {
      if (turn.footerStatusLabel !== status || turn.footerStatusFailedCardId === turn.cardId) return
      const { nextDelayMs } = liveElapsed(Date.now() - turn.footerStatusStartedAt, liveElapsedMode())
      turn.footerStatusHandle = setTimeout(() => { render(); scheduleNext() }, Math.max(1, Math.ceil(nextDelayMs)))
    }
    // 合并调和(取舍):相位切换的即时写也走 gated render(上游)——本地旧路径
    // this.renderFooterStatus(turn) 是无门闩直写,开卡后慢写未归位时每个相位
    // 切换都会新发一次请求,单飞合并失效(上游用例:20 轮相位切换只允许
    // initial + 终态两次写)。override(降级/watchdog 提示)仍由专用入口
    // renderFooterStatus/applyModelFallbackNotice 直写,不经此路径。
    render()
    scheduleNext()
  }

  startThinkingFooter(turn: TurnState): void {
    this.startFooterStatus(turn, FOOTER_THINKING_PREFIX)
  }

  startWritingFooter(turn: TurnState): void {
    this.startFooterStatus(turn, FOOTER_WRITING)
  }

  startWorkingFooter(turn: TurnState): void {
    this.startFooterStatus(turn, FOOTER_WORKING)
  }

  stopFooterStatus(turn: TurnState | null): void {
    if (!turn) return
    if (turn.footerStatusHandle) clearTimeout(turn.footerStatusHandle)
    if (turn.modelFallbackOverrideTimer) clearTimeout(turn.modelFallbackOverrideTimer)
    turn.footerStatusHandle = null
    turn.modelFallbackOverrideTimer = null
    turn.footerStatusStartedAt = 0
    turn.footerStatusLabel = null
    turn.footerStatusPendingRender = undefined
  }

  /** 模型降级/拒答瞬时通知显示时长,到期后让相位标签(Thinking/Writing/Working)恢复。 */
  private static readonly MODEL_FALLBACK_NOTICE_MS = 8_000

  /** 把模型降级/拒答提示同时落到:① 运行中卡的 footerStatusOverride(瞬时高亮,
   *  MODEL_FALLBACK_NOTICE_MS 后自动清回 null,不抢后续 watchdog/tool-failure 的 override);
   *  ② turn.modelFallbackNotice(持久,closeTurnCard 注入完成卡 footer line1)。 */
  private applyModelFallbackNotice(turn: TurnState, notice: string): void {
    turn.modelFallbackNotice = notice
    turn.footerStatusOverride = notice
    this.renderFooterStatus(turn)
    if (turn.modelFallbackOverrideTimer) clearTimeout(turn.modelFallbackOverrideTimer)
    turn.modelFallbackOverrideTimer = setTimeout(() => {
      turn.modelFallbackOverrideTimer = null
      // 只清自己设的 override;若期间 watchdog/tool-failure 设了别的 override,不抢。
      if (this.currentTurn === turn && turn.footerStatusOverride === notice) {
        turn.footerStatusOverride = null
        this.renderFooterStatus(turn)
      }
    }, Session.MODEL_FALLBACK_NOTICE_MS)
    logDiagnostic("session: model fallback surfaced notice")
  }

  /** 页脚只显示当前来源额度；Codex 刷新失败时按原格式展示同账号缓存。 */
  private async footerUsageSuffix(
    provider: AgentProvider,
    proc: AgentProcess | null,
    selectedTokenSourceId: string | null,
    ts: TokenSource | undefined,
    cachedCodexUsage: ReturnType<typeof captureCodexUsageCache> | null,
    model: string | null,
  ): Promise<string> {
    if (selectedTokenSourceId && (!ts || !ts.enabled || ts.agent !== provider)) return '  |  额度 MISS'
    if (ts?.agent === provider && ts.enabled && (provider === 'claude' || provider === 'dsh' || ts.codexApiProvider)) {
      const snap = await ts.readUsage()
      if (snap.state === 'ok' && snap.kind !== 'balance') {
        const fiveHour = snap.windows.find(w => w.kind === 'fiveHour')
        if (ts.kind === 'claude-subscription') {
          const weekly = claudeWeeklyUsageWindow(snap, model)
          const missing = { percent: null, resetsAt: null }
          return this.fmtDualWindowSuffix(fiveHour ?? missing, weekly ?? missing)
        }
        const weekly = snap.windows.find(w => w.kind === 'weekly')
        if (fiveHour || weekly) return this.fmtDualWindowSuffix(fiveHour ?? null, weekly ?? null)
      }
      return `  |  ${cards.unifiedUsageSummary(snap)}`
    }
    if (provider === 'codex') {
      const cache = cachedCodexUsage ?? (proc?.provider === 'codex' ? captureCodexUsageCache(processCodexAccount(proc)) : null)
      if (!cache) return '  |  额度 MISS'
      // The result may arrive before the native quota signal has been read.
      // Await a bounded same-account live read before formatting the final
      // footer; stopped/replaced processes keep the captured account cache.
      if (proc?.isAlive() && boundCodexAccount(proc) === cache.accountId) {
        await waitForLiveCodexUsage(cache.accountId)
      }
      const u = cache.read()
      if (!u) return '  |  额度 MISS'
      const credits = codexCreditsSummary(u.credits)
      return this.fmtDualWindowSuffix(u.fiveHour, u.weekly) + (credits ? ` · ${credits}` : '')
    }
    return '  |  额度 MISS'
  }

  /** 沿用原紧凑窗口格式：4.1h·7%·[6.9d·17%]；不添加周期标签或“已用”等文字。 */
  private fmtDualWindowSuffix(
    fiveHour: { percent: number | null; resetsAt: Date | null } | null,
    weekly: { percent: number | null; resetsAt: Date | null } | null,
  ): string {
    const segment = (window: { percent: number | null; resetsAt: Date | null } | null): string | null => {
      if (!window) return null
      if (window.percent == null) return 'MISS'
      const reset = window.resetsAt && window.resetsAt.getTime() > Date.now() ? cards.fmtResetIn(window.resetsAt) : ''
      const percent = `${Math.round(window.percent)}%`
      return reset ? `${reset}·${percent}` : percent
    }
    const five = segment(fiveHour)
    const week = segment(weekly)
    if (five && week) return `  |  ${five}·[${week}]`
    if (five) return `  |  ${five}`
    if (week) return `  |  [${week}]`
    return '  |  额度 MISS'
  }

  private waitForTurnCloses(): Promise<void> {
    const closes = [...this.turnCloseInflight]
    if (closes.length === 0) return Promise.resolve()
    return Promise.allSettled(closes).then(results => {
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason)
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) {
        throw new AggregateError(errors, `turn close failed: ${errors.map(messageOf).join('; ')}`)
      }
    })
  }

  private releaseTurnCloseReactions(snapshot: TurnCloseSnapshot): void {
    for (const [msgId, rid] of [
      ...snapshot.currentBatchReactionIds.entries(),
      ...snapshot.pendingReactionIds.entries(),
    ]) {
      if (rid) void feishu.deleteReaction(msgId, rid)
    }
  }

  closeTurnCard(
    suffix?: string,
    opts: {
      forcePush?: boolean
      hasFreshResult?: boolean
      preservePendingReactions?: boolean
    } = {},
  ): Promise<void> {
    // CRITICAL: capture-and-null in a single synchronous block at entry
    // so a parallel `closeTurnCard` (e.g. result event firing while
    // onUserMessage is awaiting an interrupt) can't double-process the
    // same turn — second caller observes null and bails. The promised
    // sync-handler invariant only protects callers that take the turn
    // off the table BEFORE their first await.
    const turn = this.currentTurn
    if (!turn) return this.waitForTurnCloses()
    if (this.steeringBoundary?.turn === turn) this.steeringBoundary.start()
    // A terminal label (including a queued-input handoff or Agent error) only
    // describes the conversation card. Admitted uploads keep their turn owner
    // and finish below; stop/restart cancel them through the session registry.
    // 无 suffix = 自然收尾;续卡失败挂起时在这里补一次重试(上游 @@-5517),
    // 插在 null-out 之前的同步块里 —— 后面 `await turn.rotating` 会等它落定。
    if (!suffix && turn.cardRotationFailed) this.maybeMidTurnRotate()
    this.currentTurn = null
    this.clearToolFailureLoop(turn)
    this.endWatchdogTurn()
    this.stopFooterStatus(turn)
    const proc = this.proc
    const snapshot: TurnCloseSnapshot = {
      turn,
      proc,
      procEpoch: this.procEpoch,
      contextTokens: this.currentContextTokens(proc),
      contextLimit: this.contextLimitForDisplay(proc),
      lastTurnDelta: this.lastTurnDelta ? { ...this.lastTurnDelta } : null,
      lastTurnUsage: this.lastTurnUsage ? { ...this.lastTurnUsage } : null,
      tokenSourceId: this.selectedTokenSourceId,
      tokenSource: proc?.provider === 'codex'
        ? getTokenSourceForAccount(proc.tokenSourceId ?? this.selectedTokenSourceId, processCodexAccount(proc))
        : proc?.provider === 'claude' && proc.tokenSourceId === 'claude-sub' && processClaudeAccount(proc)
          ? getTokenSourceForAccount('claude-sub', processClaudeAccount(proc)!)
        : this.currentTokenSource(),
      codexUsage: proc?.provider === 'codex' && !getTokenSource(proc.tokenSourceId)?.codexApiProvider
        ? captureCodexUsageCache(processCodexAccount(proc)) : null,
      currentBatchReactionIds: this.currentBatchReactionIds,
      pendingReactionIds: opts.preservePendingReactions ? new Map() : this.pendingReactionIds,
    }
    // Ownership of reactions transfers with the captured turn. New input can
    // now populate fresh maps while this close awaits rotation/CardKit/usage.
    this.currentBatchReactionIds = new Map()
    if (!opts.preservePendingReactions) this.pendingReactionIds = new Map()
    const close = this.finishTurnCardClose(snapshot, suffix, opts)
      .finally(() => this.releaseTurnCloseReactions(snapshot))
    this.turnCloseInflight.add(close)
    void close.then(
      () => { this.turnCloseInflight.delete(close) },
      () => { this.turnCloseInflight.delete(close) },
    )
    return close
  }

  private async finishTurnCardClose(
    snapshot: TurnCloseSnapshot,
    suffix?: string,
    opts: { forcePush?: boolean; hasFreshResult?: boolean; preservePendingReactions?: boolean } = {},
  ): Promise<void> {
    const { turn } = snapshot
    if (turn.steeringInflight?.size) await Promise.all([...turn.steeringInflight])
    // 竞态修复:mid-turn rotation 的 swap 阶段(sendCard / id_convert 的 await
    // 之后,见 startMidTurnRotate)会切 turn.cardId 到新卡并 startWritingFooter
    // 重启一个 footer 计时 interval。若 result 在那个 await 窗口里抢先到达,
    // 本函数会先终态化旧卡、置 currentTurn=null,随后 swap 才重启 interval ——
    // 该 interval 再没有路径会 stop(closeTurnCard 只跑一次;stop/kill/exit 的
    // stopFooterStatus(this.currentTurn) 拿到的是 null),新卡 footer 一直计时。
    // 首 turn 长输出触发 rotation 时必现(2026-06-26 turn=1 计时不止)。等
    // rotating 落定后再终态化:turn.cardId 此时是新卡,再 stop 一次清掉 swap
    // 重启的 interval,终态 footer 也写在新卡上。
    if (turn.rotating) await turn.rotating
    await sessionTools.waitForImageDeliveries(turn)
    if (turn.fileDelivery) {
      try {
        for (const path of await turn.fileDelivery.finish()) turn.outboundSentPaths.add(path)
      } catch (error) {
        logError('session: file delivery close failed', error)
        await feishu.sendTextRaw(this.chatId, `❌ 文件交付收尾失败：${messageOf(error)}`)
      } finally {
        this.fileDeliveries.delete(turn.fileDelivery)
      }
    }
    this.stopFooterStatus(turn)
    const elapsed = (Date.now() - turn.startedAt) / 1000
    const cardId = turn.cardId
    const segmentTexts = turn.segmentTexts
    await cardkit.flush(cardId)

    // Markers are admitted during deltas; their cloud uploads and separate
    // receipt have settled above. The remaining work finalizes conversation prose.
    // 如果最后一个 assistant 段没有等到 block_stop,这里先把内存缓冲的完整
    // 文本作为静态 markdown 插入卡片。
    const fallbackSegments = new Map<string, string>()
    if (turn.currentAssistantSegmentId && turn.currentAssistantText.trim()) {
      const segId = turn.currentAssistantSegmentId
      const text = turn.currentAssistantText
      const added = await this.addCompletedAssistantSegment(turn, segId, text)
      if (!added) fallbackSegments.set(segId, text)
      turn.currentAssistantSegmentId = null
      turn.currentAssistantText = ''
    }

    // block_stop handler 是同步 fire-and-forget；先等 raw 容器 checked 写完，
    // 才能完整看到随后登记的 mathRenderInflight，避免 close 抢先 dispose。
    const assistantWrites = turn.assistantWriteInflight?.get(cardId)
    if (assistantWrites?.size) {
      await Promise.allSettled([...assistantWrites])
    }

    // 等本卡全部 in-flight 公式渲染落地(渲染+上传是秒级 async,且有超时
    // 上限——math-render 上传 15s AbortController,不会无限挂)。不等的话
    // 下面的原文 replace 会先赢,把还没落地的渲染版覆盖回 $$…$$ 原码降级;
    // 渲染 promise 晚到再写就打在已 dispose 的卡上静默死 —— 这正是「公式
    // 图永远不出现、只见代码块」的病根。只 drain 本卡:rotation 期间登记
    // 的旧卡渲染由 rotation 自己 drain(review #2)。
    const inflight = turn.mathRenderInflight?.get(cardId)
    if (inflight?.size) {
      await Promise.allSettled([...inflight])
    }

    // 对每个 assistant 段 replaceElement 成最终内容。正文已经是静态 markdown,
    // 这里只是收尾清洗 askusr 标记和兜住异常路径 —— 但公式段例外:
    // replaceSegmentWithMathImgs 已经把段替换成摘出文本 + 紧贴插入公式图,
    // 这里再用原文重渲会把渲染版覆盖回 $$…$$ 原码降级(代码块占位),图也
    // 失去归属段。已渲染标记按卡隔离:本卡的段才跳过(rotation 重编号后
    // 新卡同名段不受旧卡标记影响)。
    const renderedHere = turn.mathRendered?.get(cardId)
    for (const [segId, fullText] of segmentTexts) {
      if (cardkit.isDeadElement(cardId, segId)) {
        fallbackSegments.set(segId, fullText)
        continue
      }
      if (renderedHere?.has(segId)) continue
      await cardkit.replaceElement(cardId, segId, this.completedAssistantElement(segId, fullText))
    }
    if (turn.rotateGivenUp || turn.cardRotationFailed) {
      for (const [segId, fullText] of segmentTexts) fallbackSegments.set(segId, fullText)
    }

    // State marker leads the footer (✅ for natural completion, or the
    // suffix verbatim for non-natural states like `🛑 打断`). The
    // trailing "done" word is gone — the ✅ already carries that
    // meaning. User-confirmed footer order 2026-05-16.
    const stateMark = suffix ? suffix : '✅'
    // Footer line 1 keeps the terminal status compact. Usage-derived
    // numbers only render when a fresh SDK result landed for THIS turn;
    // interrupts/boot failures would otherwise show stale prior-turn data.
    const line1Parts = [`${stateMark} ⏱ ${cards.formatDuration(elapsed)}`]
    if (opts.hasFreshResult) {
      // 读 close 入口快照,不读 live(next turn 可能已换数据——04-05 快照红例)。
      const ctxTokens = snapshot.contextTokens
      const ctxMax = snapshot.contextLimit
      // Claude 路径分母已是 SDK 实测窗口、分子是输入侧占用,走纯除法(baseline=0);
      // Codex 路径保留 12K baseline 扣减。
      const isClaude = turn.provider === 'claude'
      const ctxPercent = cards.footerContextPercentLabel(ctxTokens, ctxMax, isClaude ? 0 : undefined)
      if (ctxPercent) line1Parts.push(`🧠 ${ctxPercent}`)
      const cost = snapshot.lastTurnDelta?.costUsd ?? 0
      if (cost > 0) line1Parts.push(`💰 $${cost.toFixed(3)}`)
    }
    if (turn.contextCompactCount > 0) line1Parts.push(`🚨 压缩×${turn.contextCompactCount}`)
    if (turn.outboundSentPaths.size > 0) line1Parts.push(`📎 ${turn.outboundSentPaths.size}`)
    if (turn.modelFallbackNotice) line1Parts.push(turn.modelFallbackNotice)
    const modelLabel = this.modelLine(turn)
    if (modelLabel) line1Parts.push(modelLabel)
    const footerLine1 = line1Parts.join(' ｜ ')
    const footerLine2 = opts.hasFreshResult
      ? cards.footerTokenDetailLine(snapshot.lastTurnUsage) + (turn.rotateGivenUp || turn.cardRotationFailed
        ? ''
        : await this.footerUsageSuffix(
            turn.provider,
            snapshot.proc,
            snapshot.tokenSourceId,
            snapshot.tokenSource,
            snapshot.codexUsage,
            turn.model,
          ))
      : ''
    const footer = footerLine2 ? `${footerLine1}\n${footerLine2}` : footerLine1
    const failures: cardkit.CardWriteFailure[] = []
    const onFailure = (failure: cardkit.CardWriteFailure) => { failures.push(failure) }
    const footerLanded = await cardkit.replaceElementChecked(
      cardId,
      cards.ELEMENTS.footer,
      this.footerElement(footer),
      { onFailure },
    )
    // Final chat-list preview: clean finish shows "⏱ duration · NK tokens";
    // interrupted shows the suffix instead (no usage event landed).
    // cancelSummary kills any in-flight throttled write so a stale
    // in-flight summary update can't clobber this terminal summary.
    cardkit.cancelSummary(cardId)
    const settingsLanded = await cardkit.patchSettingsChecked(cardId, cards.streamingOffSettings({
      durationSec: elapsed,
      outputTokens: opts.hasFreshResult ? snapshot.lastTurnUsage?.output_tokens : undefined,
      suffix,
    }), onFailure)
    if (footerLanded && settingsLanded) {
      await cardkit.dispose(cardId)
    } else {
      // Keep CardKit state alive: disposing after a rejected terminal write
      // would make the in-memory state claim success while Feishu still shows
      // a streaming/running card, and would prevent any later repair attempt.
      const detail = `footer=${footerLanded ? 'ok' : 'MISS'}, settings=${settingsLanded ? 'ok' : 'MISS'}`
      logError('session: terminal card transaction incomplete', detail)
      await feishu.sendTextRaw(
        this.chatId,
        `⚠️ 对话卡片终态写入失败 (${detail})。本轮已结束: ${stateMark}\n${cardFailureDetails(failures)}`,
      )
    }

    for (const text of fallbackSegments.values()) {
      await this.sendAssistantTextFallback(text, 'CardKit 元素未落地')
    }

    // Phone push on clean turn close so the user knows Codex is done
    // even with the chat backgrounded. Skip on interrupts (no real
    // completion), when we don't know who to ping, and when the turn
    // wasn't kicked off by the user typing a message. `opts.forcePush`
    // overrides the suffix-gate when the backend reports a failed turn.
    // Fire-and-forget; urgent_app failures are non-fatal and already
    // logged in feishu.ts.
    // log-only 的 turn 已发过"仅日志可见"告警,用户知晓 —— 不再为
    // 一张写死的卡响手机推送(2026-07-04 review follow-up)。续卡仍失败时
    // 也已有失败提示,不推送旧卡的完成通知(上游 378f4a4)。
    if ((opts.forcePush || !suffix) && turn.userOpenId && turn.messageId
      && !turn.rotateGivenUp && !turn.cardRotationFailed) {
      void feishu.urgentApp(turn.messageId, [turn.userOpenId])
    }

    // After a natural/successful turn close, refresh the GSD panel if one is live.
    // Ignore errors — panel refresh must never block turn teardown.
    if (!suffix || opts.hasFreshResult) {
      void sessionGsd.refreshGsdPanelIfPresent(this)
    }

    // Release the OneSecond reactions on every queued Feishu message
    // this turn was responsible for. Two buckets:
    //   1. `currentBatchReactionIds` — msgs the init handler explicitly
    //      claimed (SDK dequeued them as a merged next-turn batch).
    //   2. `pendingReactionIds` — msgs whose fate is invisible to the
    //      daemon: the SDK either dequeued them as part of the
    //      JUST-CLOSED turn OR injected them mid-turn as
    //      `<system-reminder>` and silently removed them from the
    //      queue (common when the current turn had tool calls).
    //      Without visibility into queue-operation events the daemon
    //      can't tell which; the safe default is "the prior turn just
    //      ended, so the msg is at least *acknowledged* now —
    //      release the OneSecond and let it stop saying 'queued',
    //      instead of leaving it stuck permanently."
    //      For merged-batch follow-ups, this releases slightly early
    //      (before the merged turn actually runs), which is an
    //      acceptable trade vs. msgs stuck under OneSecond forever.
    // Reaction ownership was transferred into `snapshot` synchronously at
    // close entry and is released by the wrapper's finally. Never touch the
    // fresh maps that may already belong to the next turn here.
  }
}





