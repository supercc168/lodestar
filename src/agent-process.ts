import type { EventEmitter } from 'node:events'
import type {
  CanUseToolRequest,
  CodexModel,
  CodexReasoningEffort,
  CodexResultMeta,
  CodexUsage,
  ContextCompactedNotification,
  HookCallbackRequest,
  PlanDelta,
  ThreadGoal,
  TokenUsageUpdated,
  TurnPlanUpdated,
} from './codex-process'
// type-only:claude-agent-process 运行时也 import 本模块(CLAUDE_EFFORT 等),
// 双向仅类型引用,无运行时环。
import type {
  BgTaskStartedEvent,
  BgTaskProgressEvent,
  BgTaskUpdatedEvent,
  BgTaskSettledEvent,
} from './claude-agent-process'
// type-only:conversation.ts 亦仅类型引用本模块,无运行时环。
import type { ConversationCheckpoint } from './conversation'

/** 后端协议联合(上游 722e45a):codex / claude / dsh 三元。联合由本数组派生,
 *  新后端只在数组上加一项;`isAgentProvider` 是会话/面板判定 provider 的唯一守卫。 */
export const AGENT_PROVIDERS = ['codex', 'claude', 'dsh'] as const
export type AgentProvider = typeof AGENT_PROVIDERS[number]
export function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === 'string' && (AGENT_PROVIDERS as readonly string[]).includes(value)
}
/** DSH(DeepSeek Harness)原生档位(上游 722e45a,7 档词表)。与 Codex/Claude 档位
 *  不互通:它是子进程 `model/list` 上报的 reasoning effort 词表
 *  (off/minimal/low/medium/high/xhigh/max)。token-source-dsh 的目录刷新按本表硬校验。 */
export type DshReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export function isDshReasoningEffort(value: unknown): value is DshReasoningEffort {
  return typeof value === 'string' && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)
}
/** DSH 配置段未声明 `[deepseek-harness].effort` 时的 bootstrap 档位(03-01 冒烟
 *  deepseek-v4-* 的默认档即 high)。主会话档位目录与委派身份目录共用这一个常量
 *  —— 两侧都不回落 Codex 的 max。 */
export const DSH_BOOTSTRAP_EFFORT: DshReasoningEffort = 'high'
/** default 表示模型没有 effort 选择器，SDK 不发送 effort 参数。 */
export type ClaudeReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'default'
export type AgentReasoningEffort = CodexReasoningEffort | ClaudeReasoningEffort | DshReasoningEffort

/** 控制台额度数据源。
 * - codex: ChatGPT 登录窗口或 Codex 第三方 /v1/usage
 * - glm: GLM Coding Plan quota/limit
 * - provider: Claude 第三方 API 渠道余额(Grok 无痕 /v1/usage、CatCodex /api/usage/token)
 * - not_applicable: 官方 Claude 登录档等无可查询源
 */
export type AgentUsageSource = 'codex' | 'glm' | 'provider' | 'not_applicable'
export type CollabAgentStates = Record<string, { status?: string }>

export type CodexUserTextSettlement =
  | { kind: 'ack'; deliveryId: string; threadId: string; turnId: string | null }
  | { kind: 'rejected'; deliveryId: string; threadId: string | null; error: Error }

export type UserTextDispatch =
  // dsh 与 claude 同形:fire-and-forget 投递,无 settlement 同步点。
  | { kind: 'queued'; provider: 'claude' | 'dsh' }
  | { kind: 'rejected'; provider: AgentProvider; error: Error }
  | {
      // threadId 为 null 表示 pre-init 投递:线程尚未创建,init 成功后
      // 由 CodexProcess 就地绑定(读取方看到的是绑定后的实时值)。
      kind: 'turn_start_pending'
      provider: 'codex'
      deliveryId: string
      readonly threadId: string | null
      settlement: Promise<CodexUserTextSettlement>
    }

export type AgentResultEvent = {
  subtype?: string | null
  is_error?: boolean
  duration_ms?: number | null
  usage?: CodexUsage | null
  error?: string
  delivery_id?: string
  thread_id?: string
  turn_id?: string | null
  /** Backend-native fork anchor for the just-completed turn. null on failed,
   * interrupted, or malformed terminals(ff44afb:A checkpoint belongs to
   * exactly one clean turn)。 */
  checkpoint?: ConversationCheckpoint | null
  [key: string]: unknown
}

/** A Codex retry keeps the logical task open while waiting or reconnecting. */
export interface AgentTurnRetry {
  phase: 'waiting' | 'retrying'
  attempt: number
  delayMs: number
  message: string
  reason?: 'capacity' | 'stream_disconnected' | 'compact_connection_failed' | 'transient_error' | 'quota'
}

export const CLAUDE_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'default'] as const
export const CLAUDE_EFFORT: ClaudeReasoningEffort = 'max'

export function isClaudeReasoningEffort(value: unknown): value is ClaudeReasoningEffort {
  return typeof value === 'string' && CLAUDE_REASONING_EFFORTS.includes(value as ClaudeReasoningEffort)
}

export function providerFromModel(model: string | null | undefined): AgentProvider {
  if (model?.startsWith('dsh:')) return 'dsh'
  return model?.startsWith('claude:') ? 'claude' : 'codex'
}

/** Quota source for the actual runtime profile. Claude login models and
 * non-GLM relays do not share GLM Coding Plan quota, so they must not inherit
 * the daemon-wide GLM snapshot merely because they use the Claude backend.
 * Grok 无痕/CatCodex 等 `claude:grok*` 走 provider 渠道余额。
 * TokenSource 适配层 resolveUsageSource 与此同规则(token-source.ts 委托本函数,
 * 避免 agent-process ↔ token-source 循环依赖)。 */
export function usageSourceForAgent(
  provider: AgentProvider,
  model: string | null | undefined,
): AgentUsageSource {
  if (provider === 'codex') return 'codex'
  // D-09:DSH 是本地 deepseek 余额通道在本函数的**唯一接线点** —— 它复用官方
  // /user/balance 快照;[1m] 路由记账(路由级最大窗口 / 爆窗降级闩锁)与其无共享
  // 状态,那套记账仍只活在 claude-agent-process.ts,本 plan 不迁移、不搬运。
  if (provider === 'dsh') return 'provider'
  const m = model ?? ''
  if (/^claude:glm(?:$|[-_])/i.test(m)) return 'glm'
  // grok / grokcc / grok-*：Claude-only 第三方 Grok 路由，有独立余额接口。
  if (/^claude:grok/i.test(m)) return 'provider'
  // deepseek：官网 Anthropic 兼容端点,走官方 /user/balance 余额接口。
  if (/^claude:deepseek/i.test(m)) return 'provider'
  return 'not_applicable'
}

export function agentProviderLabel(provider: AgentProvider): string {
  return { claude: 'Claude', codex: 'Codex', dsh: 'DeepSeek Harness' }[provider]
}

/** 主动 compact 时上下文不足、后端未触发压缩。这不是错误 —— 是"无需压缩"的正常
 *  情况,调用方(runCompactCommand)应显示 ⓘ 提示而非 ❌ 失败。claude 路由 /compact
 *  在 transcript 不足时返回 "Not enough messages to compact." 且不 emit compact_boundary,
 *  compactThread 据此抛出;codex 目前不发此错误。 */
export class NothingToCompactError extends Error {
  constructor(message = '上下文窗口充足，无需压缩') {
    super(message)
    this.name = 'NothingToCompactError'
  }
}

/** A multi-step backend update can acknowledge the model before effort fails.
 * Null means unconfirmed, never an instruction to use a default value. */
export class ModelSettingsUpdateError extends Error {
  constructor(message: string, readonly confirmedModel: string | null, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ModelSettingsUpdateError'
  }
}

export type AgentTranslationPresentationSurface = 'main' | 'background' | 'worker'
export interface AgentTranslationPresentationEvent {
  kind: 'assistant_text' | 'tool_input' | 'tool_result' | 'background' | 'scheduled_input'
  parentToolUseId?: string | null
  toolUseId?: string
  toolName?: string
  isError?: boolean
  taskId?: string
  subtype?: string
}
export type AgentTranslationPresentationPolicy = (
  event: AgentTranslationPresentationEvent,
) => AgentTranslationPresentationSurface | 'hidden'

export interface AgentProcess extends EventEmitter {
  readonly provider: AgentProvider
  /** 该进程 spawn 时绑定的 token source id(= spawnEnv 注入 env 的那个 source)。
   *  GLM/DeepSeek/Claude 订阅同为 provider='claude' 但 env(base_url/凭据)不同;
   *  stopIdleMismatchedProcess 据此判定跨 source 切换要杀进程换 env(同 provider 也要杀)。
   *  null 仅用于不绑定来源的底层协议或控制查询。 */
  readonly tokenSourceId: string | null
  /** Verified translation applies to this process's user-facing boundaries. */
  readonly translationEnabled?: boolean
  sessionId: string | null
  lastAssistantUuid: string | null
  /** Canonical completed turn id when the backend exposes turn-granular forks (Codex). */
  lastCompletedTurnId?: string | null
  lastModel: string | null
  lastEffort: AgentReasoningEffort | null
  /** 当前思考块的实时估计，不能用于计费或累计 token。 */
  lastThinkingTokens?: number | null
  lastUsage: CodexUsage | null
  lastTotalUsage: CodexUsage | null
  lastResult: CodexResultMeta
  lastContextWindow: number | null
  /** Claude 路径的当前上下文占用 = 输入侧 token(input + cache_read +
   * cache_creation,不含 output),直接取自 SDK modelUsage。Codex 路径不用,
   * 恒 null(继续走 lastUsage.total_tokens)。 */
  lastContextTokens: number | null
  /** Codex-only transient status; absent for other backends. */
  turnRetry?: AgentTurnRetry | null
  /** A managed Codex process can change account only after its native child has exited. */
  sourceRevision?(): string | null
  codexAccountSelectionMode?(): 'automatic' | 'manual' | null

  /** Start backend initialization. */
  sendInitialize(): void
  /** Backend readiness before accepting user input. Codex awaits its native
   * thread transaction; Claude awaits SDK setup and subscription validation,
   * without waiting for the stream init that requires the first input. */
  initializationPromise?(): Promise<void>
  /** Explicit waiting state releases the Session actor while quota resets; never claims native init. */
  quotaWaitPromise?(): Promise<void>
  /** Codex launch/persistence metadata. Claude does not use these hooks. */
  readonly launchKind?: 'fresh' | 'resume' | 'fork'
  isConversationResumable?(): boolean
  conversationMaterializationBarrier?(): Promise<void> | null
  conversationMaterializationFailure?(): Error | null
  sendUserText(text: string, files?: string[], metadata?: { contextPrefix?: string }): UserTextDispatch
  /** Append guidance without interrupting the running task. False means no
   * native turn can accept it yet and nothing was submitted. Rejections must
   * surface to the caller; an uncertain submission must never be replayed. */
  steerUserText?(text: string, files?: string[], inputId?: string): Promise<boolean>
  sendInterrupt(): void
  /** Distinguish local preprocessing from a submitted native turn on stop. */
  hasPendingNativeTurn?(): boolean
  /** Record verified text only after the consumer accepts it for display. */
  translateDisplayFields?(texts: string[], signal?: AbortSignal,
    acceptDisplay?: (translated: string[]) => boolean): Promise<string[]>
  /** Select what this consumer displays; never change native execution or events. */
  setTranslationPresentationPolicy?(policy: AgentTranslationPresentationPolicy): void
  sendPermissionResponse(
    requestId: string | number,
    decision: 'allow' | 'deny',
    payload?: { updatedInput?: Record<string, unknown>; updatedPermissions?: unknown; denyMessage?: string },
  ): void
  sendHookResponse(requestId: string, output?: object): void
  isAlive(): boolean
  /** Resolve only after the backend's real lifecycle has ended. Reject when
   *  TERM/KILL (Codex) or SDK close/abort (Claude) cannot confirm exit. */
  kill(timeoutMs?: number): Promise<void>

  listModels(): Promise<AgentModel[]>
  setModelSettings(model: string, effort: AgentReasoningEffort): Promise<void>
  compactThread(): Promise<void>
  /** Host ask 续作:把 tool result 塞回原生 thread(codex custom_tool_call_output);
   *  claude 侧为假注入(drain 成下一条 user frame 文本前缀)。 */
  injectThreadItems(items: any[]): Promise<void>
  /** codex:在现有 app-server 连接上读账号额度(read 端点,权威多桶);
   *  claude:无此通道,返回 null(session 的额度走 token source)。 */
  readRateLimits?(): Promise<any>
}

/** Display consumers follow the boundary attached to the actual process. */
export function processUsesClaudeTranslation(
  proc: Pick<AgentProcess, 'translationEnabled'>,
): boolean {
  return proc.translationEnabled === true
}

/** 跨后端模型目录条目:档位词表按后端放宽(Codex 的 none..ultra 与 DSH 的
 *  off..max 不共享),其余字段沿用 Codex 目录形状(上游 722e45a)。 */
export interface AgentModel extends Omit<CodexModel, 'supportedReasoningEfforts' | 'defaultReasoningEffort'> {
  supportedReasoningEfforts: Array<{ reasoningEffort: AgentReasoningEffort; description: string }>
  defaultReasoningEffort: AgentReasoningEffort | null
}

export type AgentProcessEventMap = {
  error: Error
  init: any
  /** The backend has durably materialized this conversation. For fresh Codex
   * threads this is later than thread/start + init. */
  conversation_materialized: { session_id: string; source: string }
  conversation_materialization_failed: {
    session_id: string
    path: string | null
    source: string
    error: Error
  }
  turn_started: { turn_id?: string | null; thread_id?: string | null; retry?: boolean }
  turn_retry: AgentTurnRetry
  /** Native input consumption, continuation, or cancellation failed. */
  turn_input_error: { error: string; displayError?: string }
  /** Native execution reached this submitted input. Emitted in output order;
   * the transport acknowledgement alone is not a consumption boundary. */
  user_input_consumed: { inputId: string }
  /** Local preprocessing finished and the initial input entered the native queue. */
  user_input_submitted: Record<string, never>
  /** The next native non-user item starts. Consecutive consumed inputs before
   * this boundary share one card, even when delivered in separate RPC frames. */
  input_batch_end: { itemId: string }
  thinking_progress: { estimatedTokens: number }
  /** Selection succeeded; diagnostics describe unused accounts and are for logs, not proactive alerts. */
  codex_account_changed: { accountId: string; previousAccountId: string | null; diagnostics: string[] }
  token_usage: TokenUsageUpdated
  turn_plan_updated: TurnPlanUpdated
  plan_delta: PlanDelta
  context_compacted: ContextCompactedNotification
  rate_limits_updated: any
  thread_goal_updated: ThreadGoal
  thread_goal_cleared: any
  /** A backend dequeued autonomous work (Claude Cron or a DSH continuation). Unlike a daemon user
   * write, this has no pending input claim, so Session must open its own card. */
  scheduled_turn_input: { text: string; displayText?: string; promptId: string | null }
  /** parentToolUseId 非空 = 子 agent 的正文块。它必须与子 agent 工具事件
   *  一样保留归属，Session 不得把它追加到主 Agent 对话卡。 */
  assistant_text: { uuid?: string; text: string; displayText?: string; parentToolUseId: string | null }
  assistant_block_stop: { index?: string; parentToolUseId: string | null }
  /** parentToolUseId 非空 = 子 agent 内的调用,session 只累积进后台 task steps,
   *  不上主卡(与 codex isSubagentThread 分流同构)。 */
  tool_use: { id: string; name: string; input: any; displayInput?: any; parentToolUseId: string | null }
  tool_result: { tool_use_id: string; content: any; displayContent?: string; displayInput?: any; is_error: boolean; parentToolUseId: string | null }
  subagent_activity: {
    activityId: string
    agentThreadId: string
    agentPath: string | null
    kind: string
  }
  collab_agent_state: { toolUseId: string; agentsStates: CollabAgentStates }
  can_use_tool: CanUseToolRequest
  hook_callback: HookCallbackRequest
  /** 后台任务/子 agent 生命周期(claude: SDK task_* 消息族;codex: collab 状态机
   *  翻译)。session 据此维护双池(active/pending)驱动后台游标卡。 */
  bg_task_started: BgTaskStartedEvent
  bg_task_progress: BgTaskProgressEvent
  bg_task_updated: BgTaskUpdatedEvent
  bg_task_settled: BgTaskSettledEvent
  /** 子 agent 过程步骤(codex: 子线程 item 按 thread_id 归属;claude 走
   *  tool_use/tool_result 的 parentToolUseId 路径,不发此事件)。 */
  subagent_step: { thread_id: string; item_id: string; tool: string; phase: 'started' | 'completed'; brief: string }
  result: AgentResultEvent
  exit: { code: number | null; signal: string | null; expected: boolean }
}
