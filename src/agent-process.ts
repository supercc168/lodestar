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

export type AgentProvider = 'codex' | 'claude'
export type ClaudeReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type AgentReasoningEffort = CodexReasoningEffort | ClaudeReasoningEffort
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
  | { kind: 'queued'; provider: 'claude' }
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
  [key: string]: unknown
}

export const CLAUDE_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const CLAUDE_EFFORT: ClaudeReasoningEffort = 'max'

export function isClaudeReasoningEffort(value: unknown): value is ClaudeReasoningEffort {
  return typeof value === 'string' && CLAUDE_REASONING_EFFORTS.includes(value as ClaudeReasoningEffort)
}

export function providerFromModel(model: string | null | undefined): AgentProvider {
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
  const m = model ?? ''
  if (/^claude:glm(?:$|[-_])/i.test(m)) return 'glm'
  // grok / grokcc / grok-*：Claude-only 第三方 Grok 路由，有独立余额接口。
  if (/^claude:grok/i.test(m)) return 'provider'
  // deepseek：官网 Anthropic 兼容端点,走官方 /user/balance 余额接口。
  if (/^claude:deepseek/i.test(m)) return 'provider'
  return 'not_applicable'
}

export function agentProviderLabel(provider: AgentProvider): string {
  return provider === 'claude' ? 'Claude' : 'Codex'
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

export interface AgentProcess extends EventEmitter {
  readonly provider: AgentProvider
  sessionId: string | null
  lastAssistantUuid: string | null
  lastModel: string | null
  lastEffort: AgentReasoningEffort | null
  lastUsage: CodexUsage | null
  lastTotalUsage: CodexUsage | null
  lastResult: CodexResultMeta
  lastContextWindow: number | null
  /** Claude 路径的当前上下文占用 = 输入侧 token(input + cache_read +
   * cache_creation,不含 output),直接取自 SDK modelUsage。Codex 路径不用,
   * 恒 null(继续走 lastUsage.total_tokens)。 */
  lastContextTokens: number | null

  sendInitialize(): void
  sendUserText(text: string, files?: string[]): UserTextDispatch
  sendInterrupt(): void
  sendPermissionResponse(
    requestId: string | number,
    decision: 'allow' | 'deny',
    payload?: { updatedInput?: Record<string, unknown>; updatedPermissions?: unknown; denyMessage?: string },
  ): void
  sendToolResult(toolUseId: string, content: string, isError?: boolean): void
  sendHookResponse(requestId: string, output?: object): void
  isAlive(): boolean
  kill(timeoutMs?: number): Promise<void>

  listModels(): Promise<CodexModel[]>
  setModelSettings(model: string, effort: AgentReasoningEffort): Promise<void>
  setModel(model: string): Promise<void>
  compactThread(): Promise<void>
  injectThreadItems(items: any[]): Promise<void>
}

export type AgentProcessEventMap = {
  error: Error
  init: any
  turn_started: { turn_id?: string | null; thread_id?: string | null }
  token_usage: TokenUsageUpdated
  turn_plan_updated: TurnPlanUpdated
  plan_delta: PlanDelta
  context_compacted: ContextCompactedNotification
  rate_limits_updated: any
  thread_goal_updated: ThreadGoal
  thread_goal_cleared: any
  assistant_text: { uuid?: string; text: string }
  assistant_block_stop: { index?: string }
  tool_use: { id: string; name: string; input: any }
  tool_result: { tool_use_id: string; content: any; is_error: boolean }
  subagent_activity: {
    activityId: string
    agentThreadId: string
    agentPath: string | null
    kind: string
  }
  collab_agent_state: { toolUseId: string; agentsStates: CollabAgentStates }
  can_use_tool: CanUseToolRequest
  hook_callback: HookCallbackRequest
  result: AgentResultEvent
  exit: { code: number | null; signal: string | null; expected: boolean }
}
