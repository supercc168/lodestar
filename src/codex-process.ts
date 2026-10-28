/**
 * Headless Codex app-server subprocess + JSON-RPC control protocol.
 *
 * Spawned with:
 *   codex app-server --listen stdio://
 *
 * Stdin/stdout are line-delimited JSON-RPC-ish messages. Client requests
 * carry `{ id, method, params }`; server responses carry `{ id, result }`
 * or `{ id, error }`; notifications carry `{ method, params }`; server
 * requests carry `{ id, method, params }` and expect a client response.
 */

import type { ChildProcessByStdio } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { spawn as crossSpawn } from 'cross-spawn'
import { config } from './config'
import { logError, logDiagnostic } from './log'
import { agentBin } from './agent-updates'
import { prepareCodexInputPolicyCatalog, type CodexInputPolicyCatalog } from './codex-input-policy'
import {
  contextCompactionNoticeFromMessage,
  contextCompactionNoticeFromNotification,
  logUnhandledAppServerEvent,
} from './codex-compaction'
import { usageFromTokenUsagePayload } from './codex-usage'
import type {
  AgentReasoningEffort,
  AgentTurnRetry,
  CodexUserTextSettlement,
  CollabAgentStates,
  UserTextDispatch,
} from './agent-process'
import { diagnosticIdLabel } from './session-util'
import type {
  BgTaskSettledEvent,
  BgTaskStartedEvent,
  BgTaskUpdatedEvent,
} from './claude-agent-process'
import {
  validateConversationLaunch,
  type ConversationLaunch,
  type ConversationRef,
  type ConversationSummary,
} from './conversation'
import { isAgentSession } from './agent-session-registry'
import { subagentStepBrief } from './cards/background'
import { bindProcessCodexAccount, codexAccounts, DEFAULT_CODEX_ACCOUNT } from './codex-accounts'
import { isCodexQuotaError } from './codex-quota'

/** 拼 `codex app-server` 命令行:把 provider 覆盖 `-c` 对插在 `--listen` 之前。
 *  `allowDelegation === false` 时额外插 `--disable multi_agent`(等价
 *  `-c features.multi_agent=false`,codex-cli 0.144.1 `codex features list`
 *  有该 flag):被委派的 Agent 在原生层就拿不到多智能体/委派工具(D-11 口径 3)。 */
export function buildCodexAppServerArgs(configArgs: string[] = [], allowDelegation?: boolean): string[] {
  return [
    'app-server',
    ...configArgs,
    ...(allowDelegation === false ? ['--disable', 'multi_agent'] : []),
    '--listen',
    'stdio://',
  ]
}

/** 上游托管运行时优先(agentBin,含版本校验);fork 的钉目录兜底 —— 本机没有
 *  lodestar 托管 codex 时 agentBin 抛错(resolveCodexBin 不能再连带炸掉)。 */
export function resolveCodexBin(): string {
  try {
    return agentBin('codex', 'codex')
  } catch {
    // fall through to the fork's pinned locations
  }
  if (process.platform !== 'win32') {
    const pinned = join(homedir(), '.local', 'npm-global', 'bin', 'codex')
    if (existsSync(pinned)) return pinned
    const local = join(homedir(), '.local', 'bin', 'codex')
    if (existsSync(local)) return local
  }
  return whichCodex() ?? 'codex'
}

/** `codex login status` 的输出是否表示已认证 —— ChatGPT OAuth 或 API key 皆可。
 * codex 对 API key 登录输出 "Logged in using an API key - sk-…";ChatGPT 登录输出
 * "Logged in using ChatGPT"。第三方档位(无痕 wuhen 一类)与全局也走 key 的内建
 * gpt-5.6-sol 档都用 API key,若只认 ChatGPT 会把它们误判为未登录而拦掉。 */
export function codexLoginStatusAuthenticated(output: string): boolean {
  return /Logged in using ChatGPT/i.test(output) || /Logged in using an API key/i.test(output)
}

function whichCodex(): string | null {
  const PATH = process.env.PATH ?? ''
  if (!PATH) return null
  const candidates = process.platform === 'win32'
    ? ['codex.cmd', 'codex.bat', 'codex.exe', 'codex']
    : ['codex']
  for (const dir of PATH.split(delimiter)) {
    if (!dir) continue
    for (const name of candidates) {
      const p = join(dir, name)
      if (existsSync(p)) return p
    }
  }
  return null
}

/**
 * spawn codex 子进程用的 PATH。分三段拼接,兼顾「确定性工具解析」与「用对 node 版本」:
 *   1) 用户级 bin(npm-global/.local/.bun)—— prepend,保证 lodestar 自装的 codex/工具
 *      优先命中,不受用户 shell PATH 影响。
 *   2) 继承 PATH —— 紧随其后,让 homebrew/nvm 的现代 node 胜出。
 *   3) 系统兜底(/usr/local/bin、/usr/bin、/bin)—— 放最后,仅当前两段都没有 node 时兜底,
 *      避免整机唯一 node 只在 /usr/local/bin 时退出 127。
 *
 * 为何系统目录不能再 prepend:codex 启动器是 `#!/usr/bin/env node` 的 ESM,`env node` 取
 * PATH 首个命中。若 /usr/local/bin 排在继承 PATH 前面、而该目录存在陈旧 node(实测某机
 * /usr/local/bin/node = v10.20.1),就会抢在 homebrew/nvm 的新 node 前被选中,ESM 解析
 * 失败 → codex 退出 code=1(2026-07-07 实测无痕 wuhen 启动即撞)。此前只把系统目录 prepend,
 * 修的是「白名单里没有 node → 退出 127」,修不了这种「老 node 抢占 → 退出 1」。
 */
export function buildSpawnPath(inherited: string = process.env.PATH ?? ''): string {
  if (process.platform === 'win32') return inherited
  const userBins = [
    join(homedir(), '.local', 'npm-global', 'bin'),
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.bun', 'bin'),
  ]
  const systemFallback = ['/usr/local/bin', '/usr/bin', '/bin']
  return [...userBins, inherited, ...systemFallback].filter(Boolean).join(delimiter)
}

/** Environment passed to the Codex app-server. GSD Core resolves its runtime
 * from this child environment before persisted defaults; keep the lock last
 * so a stale Claude value cannot route a GPT Feishu session elsewhere. */
export function buildCodexSpawnEnv(
  providerEnv: Record<string, string> = {},
  hostEnv?: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NPM_CONFIG_LOGLEVEL: 'error',
    PATH: buildSpawnPath(),
    ...config.codex.env,
    ...providerEnv,
    GSD_RUNTIME: 'codex',
  }
  if (hostEnv) {
    for (const [key, value] of Object.entries(hostEnv)) {
      if (value !== undefined) env[key] = value
    }
  }
  return env
}

const CODEX_SESSIONS_DIR = join(codexAccounts.defaultHome, 'sessions')
const CODEX_GENERATED_IMAGES_DIR = join(codexAccounts.defaultHome, 'generated_images')
// app-server control requests return an acknowledgement, not the whole model
// turn. Bound them so a live PID with a dead transport cannot leak promises.
const CODEX_REQUEST_TIMEOUT_MS = 30_000
// materialization 验证(4185808):thread/read 确认 rollout 落盘的专用短超时。
const CODEX_MATERIALIZATION_VERIFY_TIMEOUT_MS = 10 * 60_000
// ── 自动重试引擎(上游 2e6e1e0;fork 把容量变体并入 codexTurnRetryReason)──────
const CODEX_TURN_RETRY_BASE_MS = 5_000
const CODEX_TURN_RETRY_MAX_MS = 60_000
const CODEX_TRANSIENT_RETRY_LIMIT = 10
// The failed turn already contains the user's input and any completed work.
// Continue that history instead of replaying the original task and file hints.
const CODEX_TURN_CONTINUATIONS = {
  capacity: '上一轮因模型暂时满载而中断。请基于当前会话继续完成用户尚未完成的任务，沿用已有进度；执行操作前先确认结果，避免重复已完成的操作。',
  stream_disconnected: '上一轮因响应流连接中断而未完成。请基于当前会话继续完成用户尚未完成的任务，沿用已有进度；执行操作前先确认结果，避免重复已完成的操作。',
  compact_connection_failed: '上一轮因远程压缩时连接失败而未完成。请基于当前会话继续完成用户尚未完成的任务，沿用已有进度；执行操作前先确认结果，避免重复已完成的操作。',
  transient_error: '上一轮因临时连接或服务错误而未完成。请基于当前会话继续完成用户尚未完成的任务，沿用已有进度；执行操作前先确认结果，避免重复已完成的操作。',
}

type CodexTurnRetryReason = keyof typeof CODEX_TURN_CONTINUATIONS

const CODEX_TRANSPORT_ERRORS = new Set([
  'httpConnectionFailed', 'responseStreamConnectionFailed',
  'responseStreamDisconnected', 'responseTooManyFailedAttempts',
])
const CODEX_TRANSIENT_HTTP_STATUSES = new Set([408, 500, 502, 503, 504])

/** 进程层容量判定(上游 2e6e1e0 + fork WR-03 宽度)。口径与 session.ts 的
 *  isCodexCapacityError(分类面)对齐:严格正则之外还认 serverOverloaded /
 *  "at capacity"+"model" / please try a different model(02-REVIEW WR-03)——
 *  session 自主重试环已删除,D-07 后进程层是唯一调度者,窄口径会让这些变体
 *  没有任何自动重试路径(相对基线是功能回退)。 */
function isModelCapacityError(message: unknown): boolean {
  if (typeof message !== 'string' || !message) return false
  const lower = message.toLowerCase()
  return /\bselected\s+model\s+is\s+at\s+capacity\b/.test(lower)
    || lower.includes('serveroverloaded')
    || (lower.includes('at capacity') && lower.includes('model'))
    || lower.includes('please try a different model')
}

function codexTurnRetryReason(error: unknown, routingTimedOut = false): CodexTurnRetryReason | null {
  if (!error || typeof error !== 'object') return null
  const { message, codexErrorInfo, additionalDetails } = error as { message?: unknown; codexErrorInfo?: unknown; additionalDetails?: unknown }
  if (typeof message !== 'string') return null
  if (isCodexQuotaError(error)) return null
  // fork 容量变体并轨(WR-03):上游原生只认 detail 层的 selected-model 文案;
  // 这里把 fork 的宽口径容量判定整体前置为 capacity(serverOverloaded /
  // "at capacity"+"model" / please try a different model 都由此接管)。
  if (isModelCapacityError(message)) return 'capacity'

  // Native network errors are tagged objects; tolerate legacy string tags,
  // but never turn unknown future variants or malformed payloads into retries.
  let kind: string | null = null
  if (typeof codexErrorInfo === 'string') kind = codexErrorInfo
  else if (codexErrorInfo != null) {
    if (typeof codexErrorInfo !== 'object' || Array.isArray(codexErrorInfo)) return null
    const entries = Object.entries(codexErrorInfo)
    if (entries.length !== 1) return null
    const [tag, details] = entries[0]!
    kind = tag
    if (!CODEX_TRANSPORT_ERRORS.has(kind) || !details || typeof details !== 'object' || Array.isArray(details)) return null
    const status = (details as { httpStatusCode?: unknown }).httpStatusCode
    if (status != null && (typeof status !== 'number' || !CODEX_TRANSIENT_HTTP_STATUSES.has(status))) return null
  }
  if (kind !== null && kind !== 'other' && kind !== 'serverOverloaded' && !CODEX_TRANSPORT_ERRORS.has(kind)) return null

  const compact = /^(?:Codex\s+)?Error running remote compact task:\s*/i.test(message)
  const detail = message.replace(/^(?:Codex\s+)?Error running remote compact task:\s*/i, '').replace(/^Codex\s+/i, '').trim()
  // Details can veto retry but cannot on their own broaden the allowed errors.
  // A generic transport tag must not override an explicit permanent diagnostic.
  for (const diagnostic of [detail, additionalDetails]) {
    if (typeof diagnostic !== 'string') continue
    if (isCodexQuotaError({ message: diagnostic })
      || /(?:^|:\s*)(?:unauthorized\b|forbidden\b|authentication failed\b|invalid (?:api key|request|argument)\b|(?:usage|rate|session budget) limit exceeded\b|context window exceeded\b)/i.test(diagnostic)) return null
    const status = /(?:^|:\s*)unexpected status (\d{3})\b/i.exec(diagnostic)
    if (status && !CODEX_TRANSIENT_HTTP_STATUSES.has(Number(status[1]))) return null
  }
  const renderedStatus = /(?:^|:\s*)unexpected status (\d{3})\b/i.exec(detail)
  if (/\bselected\s+model\s+is\s+at\s+capacity\b/i.test(detail)) return 'capacity'

  const knownConnectionFailure = /^Connection failed:\s*error sending request(?: for url \([^\r\n]+\))?\s*$/i.test(detail)
    || /^(?:request timed out|workspace routing discovery timed out)$/i.test(detail)
    // The generic discovery failure is ambiguous. Only a timeout observed in
    // this same turn authorizes continuation; never borrow a prior turn's cause.
    || (routingTimedOut && /^workspace routing discovery failed$/i.test(detail))
  const streamDisconnected = /^stream disconnected before completion\s*:/i.test(detail)
  if (CODEX_TRANSPORT_ERRORS.has(kind ?? '') || kind === 'serverOverloaded'
    || knownConnectionFailure || streamDisconnected || renderedStatus) {
    if (compact) return 'compact_connection_failed'
    if (kind === 'responseStreamDisconnected' || streamDisconnected) return 'stream_disconnected'
    return 'transient_error'
  }
  return null
}

export interface SpawnOpts {
  workDir: string
  codexAccountId?: string
  /** Explicit backend conversation lifecycle. */
  launch?: ConversationLaunch
  model?: string
  effort: CodexReasoningEffort
  appendSystemPrompt?: string
  /** 追加到 `codex app-server` 命令行的 `-c` 覆盖对(flat:'-c','k=v',…),
   * 由 codex API 档位注入自定义 provider。缺省 = 无覆盖(登录/默认档)。 */
  configArgs?: string[]
  /** 叠加进 spawn env 的 provider 接入变量(装 api_key)。缺省 = 无注入。 */
  providerEnv?: Record<string, string>
  allowUserInput?: boolean
  /** Host-owned environment injected before token-source credential routing. */
  hostEnv?: Record<string, string | undefined>
  /** token source 注入:对 spawn env 做 scrub+inject(防 A 账号夹带 B 凭据)。未传 = 走 config 默认。 */
  transformEnv?: (env: Record<string, string | undefined>) => Record<string, string | undefined>
  /** 该进程 spawn 时绑定的 token source id;stopIdleMismatchedProcess 据此判跨 source 重启。 */
  tokenSourceId?: string | null
  /** App-server conversation source label. Delegated agents use lodestar-agent
   * so their threads can be excluded from main rs/fk history. */
  serviceName?: string
  /** API provider credentials are supplied through env; never bind a subscription account. */
  apiProvider?: CodexApiProvider
  /** 原生工具层委派开关(D-11 口径 3):false 时 spawn 参数加 `--disable
   *  multi_agent`,threadParams 关 `features.multi_agent` —— 与 claude 的
   *  disallowedTools 同为「不靠提示词自觉」的硬约束。缺省 = 不限制。 */
  allowDelegation?: boolean
}

export interface CodexApiProvider {
  id: string
  name: string
  baseUrl: string
  envKey: string
}

export function codexApiProviderArgs(provider: CodexApiProvider): string[] {
  if (!/^[a-z][a-z0-9_-]*$/.test(provider.id) || ['openai', 'ollama', 'lmstudio'].includes(provider.id)) {
    throw new Error('Codex API provider id 无效或属于保留名称')
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(provider.envKey)) throw new Error('Codex API key 环境变量名无效')
  const prefix = `model_providers.${provider.id}`
  const definition: Record<string, string | boolean> = {
    name: provider.name, base_url: provider.baseUrl, env_key: provider.envKey,
    wire_api: 'responses', requires_openai_auth: false, supports_websockets: false,
  }
  // Replace the provider definition as one value: local same-name auth/header settings must not leak in.
  const table = `{${Object.entries(definition).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(',')}}`
  return ['-c', `model_provider=${JSON.stringify(provider.id)}`, '-c', `${prefix}=${table}`,
    // ChatGPT connectors require the subscription account; project MCP/skills remain native.
    '-c', 'features.apps=false']
}

export function codexAppServerArgs(): string[] {
  return ['app-server', '--listen', 'stdio://']
}

export function codexAppServerSpawnOptions(
  workDir: string,
  env: Record<string, string | undefined>,
): {
  cwd: string
  stdio: ['pipe', 'pipe', 'pipe']
  shell: false
  env: Record<string, string | undefined>
} {
  return { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'], shell: false, env }
}

// gpt-5.6 起服务端新增 max(单 agent 最深推理)与 ultra(多 agent 并行编排,默认 4 agent);
// per-model 实际支持集以 model/list 下发为准,这里只做全集枚举。
export type CodexReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
export interface CodexReasoningEffortOption {
  reasoningEffort: CodexReasoningEffort
  description: string
}
export const CODEX_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
/** codex 档位的回落默认 effort,与内建 GPT-5.6 Sol 档锁死值一致。
 * 2026-07-20:所有 GPT/Codex 档位统一 max(延长思维链预算);ultra(模型内多智能体)
 * 仍可在 [codex.models.*] 显式开启。旧模型端点请在档位节显式配 effort。 */
export const CODEX_EFFORT: CodexReasoningEffort = 'max'

export function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return typeof value === 'string' && CODEX_REASONING_EFFORTS.includes(value as CodexReasoningEffort)
}

export interface CanUseToolRequest {
  request_id: string
  tool_name: string
  input: any
  /** Native question payload when input contains a translated UI copy. */
  originalInput?: Record<string, unknown>
  permission_suggestions?: any
  blocked_paths?: string[]
  tool_use_id?: string
}

export interface HookCallbackRequest {
  request_id: string
  callback_id: string
  input: any
  tool_use_id?: string
}

export interface TurnPlanStep {
  step: string
  status: 'pending' | 'inProgress' | 'completed' | string
}

export interface TurnPlanUpdated {
  threadId?: string
  turnId?: string
  explanation: string | null
  plan: TurnPlanStep[]
}

export interface PlanDelta {
  threadId?: string
  turnId?: string
  itemId: string
  delta: string
}

export interface ContextCompactedNotification {
  threadId?: string
  turnId?: string
  itemId?: string
  sessionId?: string
  phase?: 'start' | 'end' | 'event'
  sourceMethod?: string
  sourceType?: string
  [key: string]: unknown
}

export interface ThreadGoal {
  threadId?: string
  objective: string
  status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete' | string
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
}

export interface CodexUsage {
  total_tokens?: number
  input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export interface TokenUsageUpdated {
  usage: CodexUsage | null
  totalUsage: CodexUsage | null
  contextWindow: number | null
  threadId?: string
  turnId?: string
}

export interface CodexResultMeta {
  cost_usd: number | null
  cost_delta_usd: number | null
  duration_ms: number | null
  num_turns: number | null
  usage: CodexUsage | null
  subtype: string | null
  is_error: boolean
}

export {
  contextCompactionNoticeFromMessage,
  contextCompactionNoticeFromNotification,
} from './codex-compaction'
export { diffUsageTotals, effectiveTurnTokens, usageFromTokenUsagePayload } from './codex-usage'

export interface CodexModel {
  id: string
  model: string
  displayName: string
  description: string
  hidden: boolean
  isDefault: boolean
  supportedReasoningEfforts: CodexReasoningEffortOption[]
  defaultReasoningEffort: CodexReasoningEffort | null
}

function parseReasoningEffortOptions(raw: unknown): CodexReasoningEffortOption[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<CodexReasoningEffort>()
  const options: CodexReasoningEffortOption[] = []
  for (const item of raw) {
    const effort = typeof item === 'string'
      ? item
      : typeof item === 'object' && item
        ? (item as { reasoningEffort?: unknown }).reasoningEffort
        : null
    if (!isCodexReasoningEffort(effort) || seen.has(effort)) continue
    seen.add(effort)
    const description = typeof item === 'object' && item && typeof (item as { description?: unknown }).description === 'string'
      ? (item as { description: string }).description
      : ''
    options.push({ reasoningEffort: effort, description })
  }
  return options
}

type PendingRequest = {
  resolve: (v: any) => void
  reject: (e: Error) => void
  method: string
  timeout: ReturnType<typeof setTimeout>
}

/** Structured JSON-RPC response failure. Lifecycle code must classify on
 * these fields rather than parsing a rendered Error string. */
export class CodexRpcResponseError extends Error {
  constructor(
    readonly method: string,
    readonly requestId: string | number,
    readonly serverCode: number | null,
    readonly serverMessage: string,
    readonly serverData?: unknown,
  ) {
    super(
      `codex app-server ${method} failed (id=${requestId}, code=${serverCode ?? 'MISS'}): ${serverMessage}`,
    )
    this.name = 'CodexRpcResponseError'
  }
}

type PendingTurnStart = {
  deliveryId: string
  // null = pre-init 投递,线程还没创建;init 成功后由
  // initializeAndStartThread 在 emit('init') 之前就地绑定。
  threadId: string | null
  turnId: string | null
  settled: boolean
  settle: (value: CodexUserTextSettlement) => void
  /** 本轮实际投递文本(含文件提示)。满载拒绝时按上游语义复用原始 input 重试。 */
  inputText?: string
  /** 中断已抢先于本轮的 turn/start 确认:迟到响应不得再 ACK/开轮。 */
  interrupted?: boolean
}

type ServerRequestState = {
  id: string | number
  method: string
  params: any
}


export class CodexProcess extends EventEmitter {
  readonly provider = 'codex' as const
  readonly tokenSourceId: string | null
  readonly launchKind: ConversationLaunch['kind']
  private proc: ChildProcessByStdio<Writable, Readable, Readable> | null = null
  private startupPromise: Promise<void> | null = null
  private inputPolicyAbort = new AbortController()
  private inputPolicyCatalog: CodexInputPolicyCatalog | null = null
  private stdoutBuf = ''
  private requestCounter = 0
  private pending = new Map<string | number, PendingRequest>()
  private serverRequests = new Map<string | number, ServerRequestState>()
  private stdinErrorListenerAttached = false
  private alive = true
  private expectedExit = false
  private exitEventEmitted = false
  private childExitCode: number | null = null
  private childExitSignal: NodeJS.Signals | null = null
  private readonly exitPromise: Promise<void>
  private resolveExit!: () => void
  private opts: SpawnOpts
  private usesCustomDefaultModeInstructions = false
  private readyPromise: Promise<void> | null = null
  private initializePromise: Promise<void> | null = null
  /** Fresh thread/start returns an id before Codex creates its rollout. A
   * resume/fork is already file-backed; a fresh thread becomes resumable only
   * after the persisted turn/started notification arrives. */
  private conversationResumable = false
  /** Exact rollout path returned by app-server for this thread. This is the
   * authority used for persistence checks; Lodestar never scans a second
   * index to decide whether a resume id is safe. */
  private conversationRolloutPath: string | null = null
  private conversationMaterializationVerification: Promise<void> | null = null
  private conversationMaterializationRetrySource: string | null = null
  private lastConversationMaterializationFailure: Error | null = null
  private currentTurnId: string | null = null
  private deliveryCounter = 0
  private pendingTurnStart: PendingTurnStart | null = null
  /** 轮流投递代际:每次 beginTurnStart 自增。旧代际的退避计时器不得触发新轮。 */
  private turnStartGeneration = 0
  /** 已终结 turn 的有界记忆:迟到的重复 turn/completed 不得改写已定的终态
   *  (上游 2e6e1e0;本地 Object.create 探针不跑字段初始化器,按上游取懒初始化)。 */
  private finishedTurnIds = new Set<string>()
  private steeringInputs = new Map<string, string>()
  private inputConsumptionOpen = false
  // ── 自动重试状态(上游 2e6e1e0 引擎;capacity 无限续作,transient 共享预算)──
  private turnRetryTimer: ReturnType<typeof setTimeout> | null = null
  private turnRetryCount = 0
  private transientRetryCount = 0
  private turnRetryHasStarted = false
  private turnRetryEnabled = true
  private turnError: { turnId: string; error: any } | null = null
  private routingTimeoutTurnId: string | null = null
  private rolloutFilePath: string | null = null
  private rolloutReadOffset = 0
  private rolloutLineRemainder = ''
  private rolloutDecoder = new StringDecoder('utf8')
  private emittedImageGenerationIds = new Set<string>()
  // ── Codex 多 agent(ultra 并行编排)状态机(cf41941)──────────────────
  // agentThreadId → 展示名(agentPath 末段,spawn 那刻从 subAgentActivity /
  // collabAgentToolCall 抓取)。仅用于 bg_task_* 事件的 description。
  private collabAgentNames = new Map<string, string>()
  // agentThreadId → 已 emit 的终态,防同一 agent 的多次 wait item 重复结算。
  private collabAgentSettled = new Set<string>()
  // agentThreadId → 是否见过 active(thread/status/changed)。子线程首个 idle 是
  // 创建态(spawn 后尚未开跑),见过 active 之后的 idle 才是「跑完回闲」。
  private collabAgentWasActive = new Set<string>()
  // agentThreadId → 子 agent 最终 agentMessage 文本(exec-cell 模式没有
  // agentsStates.message,它的末段答复是墓碑 summary 的唯一来源)。
  private collabAgentSummaries = new Map<string, string>()

  sessionId: string | null = null
  lastAssistantUuid: string | null = null
  /** Canonical app-server turn id from the latest main-thread turn/completed notification. */
  lastCompletedTurnId: string | null = null
  lastModel: string | null = null
  lastEffort: CodexReasoningEffort | null = null
  lastUsage: CodexUsage | null = null
  lastTotalUsage: CodexUsage | null = null
  lastResult: CodexResultMeta = {
    cost_usd: null, cost_delta_usd: null, duration_ms: null, num_turns: null,
    usage: null, subtype: null, is_error: false,
  }
  lastContextWindow: number | null = null
  lastContextTokens: number | null = null
  /** 模型满载退避快照(session/footer 拉取;无重试时为 null)。 */
  turnRetry: AgentTurnRetry | null = null

  constructor(opts: SpawnOpts) {
    super()
    // EventEmitter treats unhandled `error` specially. We still expose it
    // for Session logging, but a direct utility script should not
    // crash before it can surface the app-server failure.
    this.on('error', () => {})
    this.exitPromise = new Promise(resolve => { this.resolveExit = resolve })
    this.opts = opts
    this.tokenSourceId = opts.tokenSourceId ?? null
    this.launchKind = (opts.launch ?? { kind: 'fresh' }).kind
    const codexBin = resolveCodexBin()
    const providerArgs = opts.apiProvider ? codexApiProviderArgs(opts.apiProvider)
      : [...(opts.tokenSourceId === 'codex-sub' ? ['-c', 'model_provider="openai"'] : []),
        ...codexAccounts.cliArgs(opts.codexAccountId ?? DEFAULT_CODEX_ACCOUNT)]
    const baseEnv = buildCodexSpawnEnv(opts.providerEnv, opts.hostEnv)
    const routedEnv = opts.transformEnv ? opts.transformEnv(baseEnv) : baseEnv
    const spawnEnv = opts.apiProvider
      ? { ...routedEnv, CODEX_HOME: codexAccounts.defaultHome }
      : codexAccounts.env(opts.codexAccountId ?? DEFAULT_CODEX_ACCOUNT, routedEnv)
    const start = (catalog?: CodexInputPolicyCatalog) => {
      if (this.expectedExit) throw new Error('Codex startup cancelled')
      this.inputPolicyCatalog = catalog ?? null
      // fork 注入面(configArgs + D-11 --disable multi_agent)与上游 provider/
      // catalog 覆盖合流:统一插在 --listen 之前。
      const args = buildCodexAppServerArgs(opts.configArgs, opts.allowDelegation)
      const listenAt = args.indexOf('--listen')
      this.spawnNative(codexBin, [...args.slice(0, listenAt), ...providerArgs,
        ...(catalog ? ['-c', `model_catalog_json=${JSON.stringify(catalog.path)}`,
          ...catalog.disabledFeatures.flatMap(feature => ['--disable', feature])] : []),
        ...args.slice(listenAt)], spawnEnv)
    }
    if (opts.allowUserInput === false) {
      this.startupPromise = prepareCodexInputPolicyCatalog({ binary: codexBin, configArgs: providerArgs,
        env: spawnEnv, workDir: opts.workDir, signal: this.inputPolicyAbort.signal,
      }).then(async catalog => {
        if (this.expectedExit) { await catalog.dispose(); throw new Error('Codex startup cancelled') }
        start(catalog)
      }).catch(error => {
        this.alive = false
        this.emit('error', error instanceof Error ? error : new Error(String(error)))
        this.emitProcessExit(this.expectedExit ? null : 1, this.expectedExit ? 'SIGTERM' : null)
        throw error
      })
      void this.startupPromise.catch(() => {}) // initialization observes the original failure
    } else start()
    if (!opts.apiProvider) bindProcessCodexAccount(this, opts.codexAccountId ?? DEFAULT_CODEX_ACCOUNT)
  }

  private spawnNative(binary: string, args: string[], env: Record<string, string | undefined>): void {
    // cross-spawn resolves Windows .cmd shims without `shell:true`; keeping an
    // argv vector preserves quoted TOML values passed through --config.
    this.proc = crossSpawn(
      binary,
      args,
      codexAppServerSpawnOptions(this.opts.workDir, env),
    ) as ChildProcessByStdio<Writable, Readable, Readable>

    this.proc.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk))
    // Drain native stderr; upstream diagnostics may contain private payloads.
    this.proc.stderr.on('data', () => {})
    this.ensureStdinErrorListener()
    this.proc.on('exit', (code, signal) => this.handleChildExit(code, signal))
    this.proc.on('close', (code, signal) => this.handleChildClose(code, signal))
    this.proc.on('error', err => this.handleChildProcessError(err))
  }

  private handleStdinError(reason: unknown): void {
    const error = reason instanceof Error ? reason : new Error(String(reason))
    logError('codex-process: stdin failed', error)
    // Per-write callbacks reject the request whose bytes failed. Do not
    // blanket-reject every already-sent RPC here: an EPIPE during shutdown
    // can race valid responses still buffered in stdout, which close drains
    // before rejecting any genuinely unanswered request.
    if (!this.expectedExit) this.emit('error', error)
  }

  private handleChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (!this.alive) {
      return
    }
    this.alive = false
    this.cancelTurnRetry()
    this.childExitCode = code
    this.childExitSignal = signal
    // Do not reject pending RPCs here: Node's `exit` precedes stdio `close`,
    // and a final response may still be buffered in stdout. close drains that
    // tail first, then rejects only requests that truly received no response.
  }

  private handleChildClose(code: number | null, signal: NodeJS.Signals | null): void {
    this.alive = false
    this.cancelTurnRetry()
    this.flushStdoutTail()
    const finalCode = code ?? this.childExitCode
    const finalSignal = signal ?? this.childExitSignal
    // 本地 turn-watchdog 契约(98bb01d):进程死亡结算未 ACK 的投递回执。放在
    // tail drain 之后 —— 缓冲里的 turn/start 响应可能刚好 ACK 该投递。
    if (this.pendingTurnStart && !this.pendingTurnStart.settled) {
      this.rejectTurnStart(this.pendingTurnStart, new Error(
        `codex app-server exited code=${finalCode} signal=${finalSignal}`,
      ))
    }
    this.rejectPendingRequests((id, pending) => (
      new Error(`codex app-server closed before ${pending.method} response (id=${id})`)
    ))
    this.serverRequests.clear()
    const materializationBarrier = this.conversationMaterializationBarrier()
    if (materializationBarrier) {
      // A tail thread/read response resolves its Promise in flushStdoutTail,
      // but the verification/materialized continuations run as microtasks.
      // Delay public exit so Session can commit deferred anchors before its
      // exit handler drops process-owned pending state.
      void materializationBarrier.then(
        () => this.emitProcessExit(finalCode, finalSignal),
        () => this.emitProcessExit(finalCode, finalSignal),
      )
      return
    }
    this.emitProcessExit(finalCode, finalSignal)
  }

  private handleChildProcessError(err: Error): void {
    logError('codex-process: child process error', err)
    this.rejectPendingRequests((id, pending) => new Error(
      `codex app-server process failed before ${pending.method} response (id=${id}): ${err.message}`,
      { cause: err },
    ))
    // A spawn failure normally emits `error` without `exit`; leaving alive=true
    // would make Session's precise cleanup block forever on an OS process that
    // never existed. Other ChildProcess errors may still have a real PID and
    // must keep the ordinary exit/kill confirmation path.
    const spawnFailed = typeof this.proc?.pid !== 'number'
    let terminalized = false
    if (spawnFailed && this.alive) {
      this.alive = false
      this.cancelTurnRetry()
      this.serverRequests.clear()
      terminalized = true
    }
    this.emit('error', err)
    if (terminalized) {
      logDiagnostic('codex-process: spawn failed before pid assignment')
      if (this.pendingTurnStart && !this.pendingTurnStart.settled) {
        this.rejectTurnStart(this.pendingTurnStart, err)
      }
      this.emitProcessExit(null, null)
    }
  }

  private emitProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitEventEmitted) return
    this.exitEventEmitted = true
    this.resolveExit()
    if (!this.expectedExit) logDiagnostic('codex-process: unexpected process exit')
    this.emit('exit', { code, signal, expected: this.expectedExit })
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuf += chunk.toString()
    let nl: number
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim()
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      if (!line) continue
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch (e) {
        logError('codex-process: invalid protocol JSON', e)
        continue
      }
      try {
        this.handleMessage(msg)
      } catch (e) {
        // 分发异常(handler/emit listener 抛出)与坏 JSON 分开暴露:2026-08-18
        // 上游事故 —— cards barrel 漏导出 applySubagentStep,session listener 每个
        // subagent item 抛 TypeError,被这里误标成 bad json,整条消息分发中断,
        // 后台卡僵死、主卡混乱。解析与分发分离后,一条 item 的 handler 异常只
        // 丢自己,不连坐后续消息;异常照实记日志等修复。
        logError('codex-process: dispatch error', e)
      }
    }
  }

  /** Child `close` guarantees stdio has drained, but the final JSON record is
   * not required to end with a newline. Feed one synthetic delimiter so the
   * ordinary parser handles that last record before public exit/detach. */
  private flushStdoutTail(): void {
    if (!this.stdoutBuf) return
    this.onStdout(Buffer.from('\n'))
  }

  private handleMessage(msg: any): void {
    if (Object.prototype.hasOwnProperty.call(msg, 'id') && !msg.method) {
      const pending = this.pending.get(msg.id)
      if (!pending) {
        logDiagnostic('codex-process: response without pending request')
        return
      }
      this.pending.delete(msg.id)
      clearTimeout(pending.timeout)
      if (msg.error) {
        // RPC 响应错误结构化分类(4185808):生命周期代码按字段分类,不解析
        // 渲染后的 Error 字符串。传输错误(写失败)仍走原始 error(01-09 契约)。
        const serverCode = typeof msg.error?.code === 'number' ? msg.error.code : null
        const serverMessage = typeof msg.error === 'string'
          ? msg.error
          : typeof msg.error?.message === 'string'
            ? msg.error.message
            : JSON.stringify(msg.error)
        pending.reject(new CodexRpcResponseError(
          pending.method,
          msg.id,
          serverCode,
          serverMessage,
          msg.error?.data,
        ))
      } else {
        pending.resolve(msg.result)
      }
      return
    }

    if (Object.prototype.hasOwnProperty.call(msg, 'id') && msg.method) {
      this.handleServerRequest(msg)
      return
    }

    if (msg.method) {
      this.handleNotification(msg.method, msg.params ?? {})
      return
    }

    const compaction = contextCompactionNoticeFromMessage(msg)
    if (compaction) {
      if (this.isForeignThread(compaction.threadId)) {
        logDiagnostic('codex-process: child compaction event ignored')
        return
      }
      const notice = this.withSessionId(compaction)
      this.emit('context_compacted', notice)
      return
    }

    logUnhandledAppServerEvent('RAW_MESSAGE')
    this.emit('raw', msg)
  }

  private handleNotification(method: string, params: any): void {
    // A single app-server also reports collab/sub-agent threads. Only the
    // primary thread owns this process's Session card and turn lifecycle.
    const notificationThreadId = params?.threadId ?? params?.thread_id ??
      (method === 'thread/started' ? params?.thread?.id : undefined)
    if (this.isForeignThread(notificationThreadId)) {
      // 三个口子(cf41941):子线程状态与工具 item 改道后台游标卡 ——
      // thread/status/changed 喂 collab 状态机(exec-cell 唯一生命周期信号),
      // item/started|completed 转 subagent_step/summary 采集。其余
      // (delta/turn/usage/diff/plan)仍是子 agent 过程噪音:全吞掉且不落日志
      // (9aa98cf 日志经济性),不冒充主轮信号。
      if (method === 'thread/status/changed') {
        this.handleThreadStatusChanged(params)
        return
      }
      if (method === 'item/started') {
        this.handleSubagentItemStarted(params)
        return
      }
      if (method === 'item/completed') {
        this.handleSubagentItemCompleted(params)
        return
      }
      if (method === 'turn/started' || method === 'turn/completed') {
        logDiagnostic('codex-process: child notification ignored')
      }
      return
    }
    const compaction = contextCompactionNoticeFromNotification(method, params)
    if (compaction) {
      const notice = this.withSessionId(compaction)
      this.emit('context_compacted', notice)
      return
    }
    switch (method) {
      case 'thread/started': {
        const thread = params.thread
        if (thread?.id) this.sessionId = thread.id
        return
      }
      case 'thread/settings/updated': {
        const settings = params.threadSettings
        if (typeof settings?.model === 'string') this.lastModel = settings.model
        if (isCodexReasoningEffort(settings?.effort)) this.lastEffort = settings.effort
        if (settings?.collaborationMode) this.usesCustomDefaultModeInstructions = settings.collaborationMode.mode === 'default'
          && typeof settings.collaborationMode.settings?.developer_instructions === 'string'
        return
      }
      case 'thread/tokenUsage/updated': {
        // `last` is the latest model request and therefore the current
        // context-window footprint. `total` is cumulative across requests
        // in the thread and must not drive context-window percentages.
        const last = usageFromTokenUsagePayload(params.tokenUsage?.last)
        if (last) {
          this.lastUsage = last
          this.lastResult.usage = this.lastUsage
        } else {
          logDiagnostic('codex-process: token usage missing request breakdown')
        }
        this.lastTotalUsage = usageFromTokenUsagePayload(params.tokenUsage?.total)
        const ctx = params.tokenUsage?.modelContextWindow
        if (typeof ctx === 'number' && ctx > 0) this.lastContextWindow = ctx
        this.emit('token_usage', {
          usage: this.lastUsage,
          totalUsage: this.lastTotalUsage,
          contextWindow: this.lastContextWindow,
          threadId: params.threadId,
          turnId: params.turnId,
        } as TokenUsageUpdated)
        return
      }
      case 'turn/started': {
        const threadId = this.stringId(params.threadId) ?? this.sessionId
        const turnId = this.stringId(params.turn?.id)
        const delivery = this.pendingTurnStart
        if (!turnId) {
          logDiagnostic('codex-process: turn start missing identifier')
          return
        }
        // 迟到/重复 turn/started(上游 recordTurnStarted 的 finishedTurnIds 守卫):
        // 已终结的 turn id 不得再次夺取轮属主(否则下一轮真实 turn/started 会被
        // 冲突守卫误拒,整个逻辑任务悬挂)。
        if (this.finishedTurnIds?.has(turnId)) {
          logDiagnostic('codex-process: finished turn start ignored')
          return
        }
        if (this.currentTurnId && this.currentTurnId !== turnId) {
          logDiagnostic('codex-process: conflicting turn start ignored')
          return
        }
        // 中断抢在确认之前:本轮不得开轮/结算,只把迟到 turn 就地掐断
        //(上游 recordTurnStarted 的 owner.interrupted 分支)。delivery 留在
        // pendingTurnStart 上,由随后的 turn/completed 吞掉,避免重试被重启。
        if (delivery?.interrupted) {
          this.interruptTurn(turnId)
          return
        }
        if (delivery && threadId === delivery.threadId) {
          if (!this.ackTurnStart(delivery, turnId)) return
        }
        this.currentTurnId = turnId
        // 清空点(ff44afb):新 turn 开始,上一轮 checkpoint 不得跨入进行中的新轮。
        this.lastCompletedTurnId = null
        // 重试轮:本轮是同一逻辑任务的续作(上游 2e6e1e0 的 retry 标志);
        // 计时器若还在(native continuation 抢先)就地转为 retrying 并收口。
        const retrying = this.turnRetryHasStarted && this.turnRetryCount > 0
        this.turnRetryHasStarted = true
        if (this.turnRetryTimer && this.turnRetry) {
          const retry = { ...this.turnRetry, phase: 'retrying' as const, delayMs: 0 }
          this.cancelTurnRetry()
          this.emit('turn_retry', retry)
        }
        this.turnRetry = null
        // fresh 线程只有内存 id:persisted turn/started 是 rollout 可能已
        // 落盘的首个信号,触发权威验证(4185808 主题 D)。
        this.markConversationMaterialized('turn/started notification')
        this.emit('turn_started', {
          turn_id: turnId,
          thread_id: params.threadId ?? this.sessionId,
          ...(retrying ? { retry: true } : {}),
        })
        return
      }
      case 'turn/completed': {
        const turn = params.turn ?? {}
        const threadId = this.stringId(params.threadId) ?? this.sessionId
        const turnId = this.stringId(turn.id)
        const delivery = this.pendingTurnStart && this.pendingTurnStart.threadId === threadId
          ? this.pendingTurnStart
          : null
        if (turnId && this.finishedTurnIds?.has(turnId)) {
          // 重复终止通知:不得再走一遍结算/退避(上游 2e6e1e0)。
          logDiagnostic('codex-process: duplicate terminal event ignored')
          return
        }
        if (
          turnId &&
          (
            (this.currentTurnId && this.currentTurnId !== turnId) ||
            (delivery?.turnId && delivery.turnId !== turnId)
          )
        ) {
          logDiagnostic('codex-process: conflicting terminal event ignored')
          this.rememberFinishedTurn(turnId)
          return
        }
        // 中断抢先的轮:迟到终止不得结算交付(等价上游 finishedTurnIds 的单轮口径)。
        if (delivery && !delivery.interrupted) this.ackTurnStart(delivery, turnId)
        if (turnId) this.rememberFinishedTurn(turnId)
        this.flushRolloutImageGenerations()
        this.markConversationMaterialized('turn/completed notification')
        const status = turn.status
        const completedTurnId = turnId
        const notifiedError = status === 'failed' && this.turnError && this.turnError.turnId === completedTurnId
          ? this.turnError.error : null
        const error = turn.error && notifiedError && typeof turn.error.message === 'string'
          && turn.error.message === notifiedError.message
          ? {
              ...notifiedError, ...turn.error,
              codexErrorInfo: turn.error.codexErrorInfo ?? notifiedError.codexErrorInfo,
              additionalDetails: turn.error.additionalDetails ?? notifiedError.additionalDetails,
            }
          : turn.error ?? notifiedError
        this.turnError = null
        const isError = status === 'failed' || !!error
        const isCheckpointable = status === 'completed' && !isError && !!completedTurnId
        // Never leave a previous turn's checkpoint visible on a failed,
        // interrupted, or malformed terminal notification.
        this.lastCompletedTurnId = isCheckpointable ? completedTurnId : null
        this.currentTurnId = null
        this.inputConsumptionOpen = false
        if (delivery?.interrupted) {
          if (this.pendingTurnStart === delivery) this.pendingTurnStart = null
          return
        }
        // 模型满载/瞬时故障:本轮保持未终结 —— 不写 lastResult、不发 result,转入
        // 进程层统一退避(上游 2e6e1e0 引擎;容量变体并入 codexTurnRetryReason)。
        // delivery 已按 ack 结算(交付契约不悬挂);重试轮自带新 delivery。
        const retryReason = codexTurnRetryReason(error, !!completedTurnId && this.routingTimeoutTurnId === completedTurnId)
        this.routingTimeoutTurnId = null
        if (status === 'failed' && completedTurnId && retryReason
          && this.scheduleTurnRetry(error.message, CODEX_TURN_CONTINUATIONS[retryReason], retryReason)) {
          if (delivery && this.pendingTurnStart === delivery) this.pendingTurnStart = null
          return
        }
        this.cancelTurnRetry()
        this.turnRetryCount = 0
        this.transientRetryCount = 0
        this.turnRetryHasStarted = false
        const subtype = isError ? (error?.type ?? error?.message ?? 'failed') : 'success'
        this.lastResult = {
          cost_usd: null,
          cost_delta_usd: null,
          duration_ms: typeof turn.durationMs === 'number' ? turn.durationMs : null,
          num_turns: 1,
          usage: this.lastUsage,
          subtype,
          is_error: isError,
        }
        for (const [inputId, turnId] of this.steeringInputs ?? []) {
          if (turnId === completedTurnId) this.steeringInputs.delete(inputId)
        }
        this.emit('result', {
          subtype,
          is_error: isError,
          ...(isError && typeof error?.message === 'string' ? { error: error.message } : {}),
          ...(status === 'failed' && completedTurnId && isCodexQuotaError(error)
            ? { codexQuotaFailure: { accepted: true } } : {}),
          duration_ms: this.lastResult.duration_ms,
          usage: this.lastUsage,
          ...(delivery
            ? {
                delivery_id: delivery.deliveryId,
                thread_id: delivery.threadId,
                turn_id: turnId ?? delivery.turnId,
              }
            : { turn_id: completedTurnId }),
          checkpoint: isCheckpointable && this.sessionId
            ? {
                provider: 'codex',
                kind: 'turn',
                id: completedTurnId,
                source: { provider: 'codex', sessionId: this.sessionId, cwd: this.opts.workDir },
              }
            : null,
        })
        if (delivery && this.pendingTurnStart === delivery) this.pendingTurnStart = null
        return
      }
      case 'turn/plan/updated': {
        this.emit('turn_plan_updated', params as TurnPlanUpdated)
        return
      }
      case 'item/plan/delta': {
        this.emit('plan_delta', params as PlanDelta)
        return
      }
      case 'thread/goal/updated': {
        if (params.goal) {
          this.emit('thread_goal_updated', params.goal as ThreadGoal)
        } else {
          logDiagnostic('codex-process: goal notification missing goal')
        }
        return
      }
      case 'thread/goal/cleared': {
        this.emit('thread_goal_cleared', params)
        return
      }
      case 'thread/status/changed': {
        this.handleThreadStatusChanged(params)
        return
      }
      case 'item/agentMessage/delta': {
        if (typeof params.delta === 'string' && params.delta.length > 0) {
          this.emit('assistant_text', { uuid: params.itemId, text: params.delta, parentToolUseId: null })
        } else {
          logUnhandledAppServerEvent('AGENT_MESSAGE_DELTA_EMPTY')
        }
        return
      }
      case 'item/started': {
        this.handleItemStarted(params)
        return
      }
      case 'item/completed': {
        this.handleItemCompleted(params)
        return
      }
      case 'mcpServer/startupStatus/updated': {
        if (params.error) logError('codex-process: MCP startup failed', params.error)
        return
      }
      case 'account/rateLimits/updated': {
        this.emit('rate_limits_updated', params.rateLimits)
        return
      }
      case 'configWarning':
      case 'warning':
      case 'guardianWarning':
      case 'deprecationNotice': {
        logDiagnostic('codex-process: native configuration warning')
        return
      }
      case 'error': {
        logError('codex-process: server error', params.error ?? params)
        // App-server may nest the human message under params.error.message
        // (serverOverloaded / capacity). Prefer the nested string so session
        // can classify capacity retries; fall back to top-level / summary.
        const nested = params?.error
        const nestedMessage = nested && typeof nested === 'object' && typeof nested.message === 'string'
          ? nested.message
          : null
        const error = nested ?? params
        // 记下本轮的原始 error:turn/completed 可能只带 status=failed 而不重复
        // error 文本(上游 2e6e1e0);willRetry 且为 workspace routing 超时则登记
        // routingTimeoutTurnId,仅放行同轮的 discovery 续作。
        const errorOwner = typeof params?.turnId === 'string'
          && params.threadId === this.sessionId
          && !this.finishedTurnIds?.has(params.turnId)
          && (!this.pendingTurnStart?.turnId || this.pendingTurnStart.turnId === params.turnId)
          && (!this.currentTurnId || this.currentTurnId === params.turnId)
        if (errorOwner) {
          this.turnError = { turnId: params.turnId, error }
          if (params.willRetry === true && [error.message, error.additionalDetails]
            .some(value => typeof value === 'string' && /^workspace routing discovery timed out$/i.test(value.trim())
              && codexTurnRetryReason({ ...error, message: value,
                additionalDetails: value === error.additionalDetails ? error.message : error.additionalDetails }) !== null)) {
            this.routingTimeoutTurnId = params.turnId
          }
        }
        // Even willRetry=false precedes turn/completed. Never start a competing
        // turn here, particularly while app-server is doing its own retries.
        const message = nestedMessage
          ?? (typeof params?.message === 'string' ? params.message : null)
          ?? (typeof params?.summary === 'string' ? params.summary : null)
          ?? (typeof error.message === 'string' ? error.message : null)
          ?? (typeof error.summary === 'string' ? error.summary : null)
          ?? 'codex app-server error'
        this.emit('error', new Error(message))
        return
      }
      // 高频无消费通知:静默不落日志(曾占 launchd.err.log 3.3GB 的 96%)。
      // 事件流照常分发(raw 无监听时为零成本),仅不再逐条打 payload。
      // (thread/status/changed 已在上方改道 handleThreadStatusChanged。)
      case 'item/commandExecution/outputDelta':
      case 'hook/started':
      case 'hook/completed':
      case 'turn/diff/updated':
      case 'item/commandExecution/terminalInteraction':
      case 'turn/moderationMetadata':
      case 'item/reasoning/summaryTextDelta':
      case 'remoteControl/status/changed':
      case 'skills/changed':
      case 'item/reasoning/summaryPartAdded': {
        this.emit('raw', { method, params })
        return
      }
    }
    if (!['turn/moderationMetadata', 'turn/diff/updated', 'item/commandExecution/outputDelta',
      'item/commandExecution/terminalInteraction', 'thread/readState/changed',
      'remoteControl/status/changed', 'account/updated'].includes(method)) {
      logUnhandledAppServerEvent('NOTIFICATION')
    }
    this.emit('raw', { method, params })
  }

  private knownPrimaryThreadId(): string | null {
    if (this.sessionId) return this.sessionId
    // resume 的源 thread 就是主线程;fork 的新 thread id 直到 init 返回才存在,
    // source id 不是本进程主线程 —— 维持 null(与 fresh 同,init 前不过滤)。
    if (this.opts.launch?.kind === 'resume') return this.opts.launch.source.sessionId
    return null
  }

  private isForeignThread(threadId: unknown): threadId is string {
    const primaryThreadId = this.knownPrimaryThreadId()
    return typeof threadId === 'string' && !!threadId && !!primaryThreadId && threadId !== primaryThreadId
  }

  private handleItemStarted(params: any): void {
    const item = params?.item
    if (item?.type === 'subAgentActivity') {
      // 双通路(RESEARCH #12):subagent_activity 观测 emit 保留(本地独有
      // watchdog 喂养,src/session.ts observeWatchdogMeaningful),collab
      // 状态机同时翻译出 bg_task_*(游标卡)。
      const activity = mapSubAgentActivity(item)
      if (activity) this.emit('subagent_activity', activity)
      this.feedCollabItem(item, 'started')
      return
    }
    if (!item?.id) {
      logUnhandledAppServerEvent('ITEM_STARTED_MISSING_ID')
      return
    }
    if (item.type === 'userMessage') {
      const inputId = item.clientId
      if (typeof inputId === 'string' && params.threadId === this.sessionId
        && this.steeringInputs?.get(inputId) === params.turnId) {
        this.steeringInputs.delete(inputId)
        this.inputConsumptionOpen = true
        this.emit('user_input_consumed', { inputId })
      }
      return
    }
    if (this.inputConsumptionOpen && params.turnId === this.currentTurnId) {
      this.inputConsumptionOpen = false
      this.emit('input_batch_end', { itemId: item.id })
    }
    // 多 agent 编排 item 不走通用 tool_use 映射,先喂给 collab 状态机。
    if (this.feedCollabItem(item, 'started')) return
    const mapped = mapStartedItem(item, this.opts.workDir)
    if (!mapped) {
      if (!['reasoning', 'agentMessage', 'sleep'].includes(item.type)) logUnhandledAppServerEvent('ITEM_STARTED_UNMAPPED')
      return
    }
    this.emit('tool_use', { id: item.id, name: mapped.name, input: mapped.input })
  }

  /** 子 agent 线程的 item/started —— 入口分流后的专用通路,只转 subagent_step
   *  (后台卡 steps),collab 编排 item(subAgentActivity 等)仍走 feedCollabItem。 */
  private handleSubagentItemStarted(params: any): void {
    const item = params?.item
    if (!item?.id) return
    if (this.feedCollabItem(item, 'started')) return
    this.emitSubagentStep(item, 'started', params)
  }

  /** 子 agent 线程的 item/completed:工具 item 转 step;agentMessage 捕获末段
   *  文本作 idle 结算的 summary(exec-cell 模式没有 agentsStates message,
   *  子 agent 的最终答复是唯一信息源 —— 保留有界预览,墓碑不再「暂无执行记录」)。 */
  private handleSubagentItemCompleted(params: any): void {
    const item = params?.item
    if (!item?.id) return
    if (item.type === 'agentMessage') {
      const text = typeof item.text === 'string' ? item.text : ''
      if (text) {
        const threadId = typeof params?.threadId === 'string' ? params.threadId : ''
        this.collabAgentSummaries.set(threadId, text)
      }
      return
    }
    if (this.feedCollabItem(item, 'completed')) return
    this.emitSubagentStep(item, 'completed', params)
  }

  private handleItemCompleted(params: any): void {
    const item = params?.item
    if (item?.type === 'subAgentActivity') {
      // 双通路(RESEARCH #12):同 handleItemStarted —— 观测 emit + 状态机。
      const activity = mapSubAgentActivity(item)
      if (activity) this.emit('subagent_activity', activity)
      this.feedCollabItem(item, 'completed')
      return
    }
    const isCollabAgentToolCall = item?.type === 'collabAgentToolCall'
    if (!item?.id && !isCollabAgentToolCall) {
      logUnhandledAppServerEvent('ITEM_COMPLETED_MISSING_ID')
      return
    }
    if (item.type === 'userMessage') return
    if (item.type === 'agentMessage') {
      this.lastAssistantUuid = item.id
      this.emit('assistant_block_stop', { index: item.id, parentToolUseId: null })
      return
    }
    if (isCollabAgentToolCall && item.agentsStates != null) {
      // collab_agent_state 观测 emit(本地独有 watchdog 喂养,#12)保留 ——
      // 状态机消费(feedCollabItem)在其后,不取代观测通路。
      if (typeof item.id !== 'string' || item.id.length === 0) {
        logUnhandledAppServerEvent('COLLAB_AGENT_TOOL_ID_INVALID')
      } else if (isCollabAgentStates(item.agentsStates)) {
        this.emit('collab_agent_state', {
          toolUseId: item.id,
          agentsStates: item.agentsStates,
        })
      } else {
        logUnhandledAppServerEvent('COLLAB_AGENT_STATES_INVALID')
      }
    }
    // timeline 压缩(cf41941):collabAgentToolCall 由状态机消费,不再走
    // mapCompletedItem 炸 agentsStates JSON 面板(spawn 摘要面板在状态机内产出)。
    if (this.feedCollabItem(item, 'completed')) return
    const mapped = mapCompletedItem(item, this.opts.workDir, this.sessionId ?? undefined)
    if (!mapped) {
      if (!['reasoning', 'sleep'].includes(item.type)) logUnhandledAppServerEvent('ITEM_COMPLETED_UNMAPPED')
      return
    }
    this.emit('tool_result', {
      tool_use_id: item.id,
      content: mapped.output,
      is_error: mapped.isError,
      ...(item.type === 'imageGeneration' ? { input: imageGenerationInput(item) } : {}),
    })
    if (item.type === 'imageGeneration') this.emittedImageGenerationIds.add(item.id)
  }

  // ── Codex 多 agent(ultra)→ bg_task_* 翻译(cf41941)────────────────
  // Codex 的编排 item(app-server v2 协议):
  //  - subAgentActivity {kind, agentThreadId, agentPath}:子 agent 生命周期信号。
  //    kind=started 是子 agent 首个可靠信号(带 agentPath 任务名)→ bg_task_started。
  //  - collabAgentToolCall {tool, agentsStates}:编排调用(spawn/wait/…)。它的
  //    agentsStates 是每个 receiver agent 的最新状态 —— 每次到达都 diff 出
  //    running / 终态,终态(completed 带 message / errored)→ bg_task_settled。
  // phase 区分 started/completed 两条通路:spawn 面板 tool_use 只在 started 落,
  // tool_result 只在 completed 回 —— 同 id 两次到达不会重复渲染。
  // 入口线程判定用本地 isForeignThread(knownPrimaryThreadId,比上游
  // sessionId-only 更稳,差集 #1)—— 上游 isSubagentThread 不倒灌。

  /** thread/status/changed → 子 agent 生命周期。这是 exec-cell 编排(gpt-5.6-sol
   *  默认)下子 agent 的**唯一**终态信号 —— 该模式不发 collabAgentToolCall
   *  item,agentsStates 无从到达;子线程状态序列 idle(创建)→ active(跑)→
   *  idle(跑完)。见过 active 之后的 idle = 结算 completed。collab 工具编排
   *  (老路径)的子线程同样发这个通知,两条编排路径统一在这里兜底结算。 */
  private handleThreadStatusChanged(params: any): void {
    const threadId = typeof params?.threadId === 'string' ? params.threadId : ''
    const status = params?.status?.type
    if (!threadId || typeof status !== 'string') return
    // 只关心已知子 agent(名字表里有);主线程 / 未知线程(尚未 spawn 信号的)
    // 的状态变化不驱动后台卡。
    if (!this.collabAgentNames?.has(threadId)) return
    if (status === 'active') {
      this.collabAgentWasActive.add(threadId)
      // 翻活:collabAgentSettled 里的老终态(如 closeAgent 后线程又被重新拉起)
      // 在重新 active 时作废 —— 复用 translateAgentState 的翻活路径不合适
      // (它面向 agentsStates 形状),这里直接清标记 + running patch。
      if (this.collabAgentSettled.has(threadId)) {
        this.collabAgentSettled.delete(threadId)
        this.emit('bg_task_started', {
          task_id: threadId,
          task_type: 'local_agent',
          description: this.collabAgentNames.get(threadId) ?? diagnosticIdLabel(threadId),
        } satisfies BgTaskStartedEvent)
        this.emit('bg_task_updated', {
          task_id: threadId,
          patch: { is_backgrounded: true },
        } satisfies BgTaskUpdatedEvent)
      }
      this.emit('bg_task_updated', {
        task_id: threadId,
        patch: { status: 'running' },
      } satisfies BgTaskUpdatedEvent)
      return
    }
    if (status === 'idle' || status === 'systemError') {
      // systemError:子 agent 出错(独立于主线程),结算成 failed;后续 active
      // 仍可复活(followup 重试)。notLoaded 不算 —— 那是空闲卸载的正常回闲。
      // 首个 idle 是创建态(spawn 后未开跑)—— 没见过 active 不结算。
      if (!this.collabAgentWasActive.has(threadId)) return
      if (this.collabAgentSettled.has(threadId)) return
      this.collabAgentSettled.add(threadId)
      this.emit('bg_task_settled', {
        task_id: threadId,
        status: status === 'systemError' ? 'failed' : 'completed',
        summary: this.collabAgentSummaries.get(threadId) ?? undefined,
      } satisfies BgTaskSettledEvent)
    }
  }

  /** 子 agent 的过程 item → subagent_step 事件(session 据此累积进 bg task 的
   *  steps,后台卡展开可见),不进主卡。只转有信息量的工具类 item —— reasoning
   *  这类(mapStartedItem 不认识)每轮上百条,转成空 step 会把 steps 的 ~1000
   *  字符预算刷满,挤掉真正有用的 Bash/FileChange 记录(trimSteps 保新丢旧)。 */
  private emitSubagentStep(item: any, phase: 'started' | 'completed', params: any): void {
    const threadId = typeof params?.threadId === 'string' ? params.threadId : ''
    const mapped = phase === 'started'
      ? mapStartedItem(item, this.opts.workDir)
      : mapCompletedItem(item, this.opts.workDir, this.sessionId ?? undefined)
    if (!mapped) return // reasoning/agentMessage 等非工具 item:不出 step
    const output = 'output' in mapped && typeof mapped.output === 'string' ? mapped.output : undefined
    this.emit('subagent_step', {
      thread_id: threadId,
      item_id: item.id,
      tool: mapped.name,
      phase,
      brief: subagentStepBrief(mapped.name, mapped.input, output),
    })
  }

  private feedCollabItem(item: any, phase: 'started' | 'completed'): boolean {
    if (item.type === 'subAgentActivity') {
      const threadId = typeof item.agentThreadId === 'string' ? item.agentThreadId : ''
      if (!threadId) return true // 吞掉,不进通用映射也不进 UNHANDLED 噪音
      if (item.kind === 'started' && !this.collabAgentNames.has(threadId)) {
        const name = collabAgentDisplayName(item.agentPath, threadId)
        this.collabAgentNames.set(threadId, name)
        this.emit('bg_task_started', {
          task_id: threadId,
          task_type: 'local_agent',
          description: name,
        } satisfies BgTaskStartedEvent)
        // Codex ultra 编排的子 agent 生而并行(主 agent spawn 后自己继续跑),
        // 直接后台化入卡 —— 不等主线程推进信号。
        this.emit('bg_task_updated', {
          task_id: threadId,
          patch: { is_backgrounded: true },
        } satisfies BgTaskUpdatedEvent)
      } else if (item.kind === 'started') {
        // 已知 id(collabAgentToolCall 先落时占了「子 agent」占位名)—— agentPath
        // 才是真名,发一次 started 让 applyBgTaskStarted 的已知 id patch 补名。
        // 已 settle 的不发:沉降已清 entry,started 会被当新任务重新入池成
        // running 僵尸(晚到的纯元数据修正不该有生命周期语义)。
        const prev = this.collabAgentNames.get(threadId)
        const name = collabAgentDisplayName(item.agentPath, threadId)
        if (prev !== name && !this.collabAgentSettled.has(threadId)) {
          this.collabAgentNames.set(threadId, name)
          this.emit('bg_task_started', {
            task_id: threadId,
            task_type: 'local_agent',
            description: name,
          } satisfies BgTaskStartedEvent)
        }
      } else if (item.kind === 'interrupted') {
        // 打断等待新输入 → paused(计时停走),不冒充 running。
        this.emit('bg_task_updated', {
          task_id: threadId,
          patch: { status: 'paused' },
        } satisfies BgTaskUpdatedEvent)
      }
      return true
    }
    if (item.type === 'collabAgentToolCall') {
      const states = item.agentsStates
      if (states && typeof states === 'object') {
        for (const [threadId, state] of Object.entries(states)) {
          this.translateAgentState(threadId, state as any, item)
        }
      }
      // closeAgent 完成时 agentsStates 带的是关闭前快照(常见 running,见官方
      // close_agent.rs:subscribe_status 先取再 close)—— 收到的 receiver 无条件
      // 结算成 stopped,否则 agent 已关、后台卡还在跑计时。
      if (item.tool === 'closeAgent' && phase === 'completed' && item.status !== 'failed') {
        const ids = collabReceiverThreadIds(item)
        for (const threadId of ids) {
          if (this.collabAgentSettled.has(threadId)) continue
          this.collabAgentSettled.add(threadId)
          if (!this.collabAgentNames.has(threadId)) {
            this.collabAgentNames.set(threadId, collabAgentDisplayName(null, threadId))
          }
          this.emit('bg_task_settled', {
            task_id: threadId,
            status: 'stopped',
          } satisfies BgTaskSettledEvent)
        }
      }
      // spawn 在主卡 timeline 留一行「派生 agent」摘要面板(状态由后台卡承载);
      // 纯编排(wait/sendInput/resumeAgent/closeAgent)无独立信息量,不出面板。
      if (item.tool === 'spawnAgent') {
        if (phase === 'started') {
          this.emit('tool_use', {
            id: item.id,
            name: 'Agent',
            input: {
              tool: 'spawnAgent',
              // fork_turns=all 的 prompt 是服务端密文(gAAAAB…),渲染时归一成占位。
              prompt: collabPromptText(item.prompt),
              description: collabSpawnDescription(item),
              model: typeof item.model === 'string' ? item.model : undefined,
            },
          })
        } else if (item.status !== 'inProgress') {
          this.emit('tool_result', {
            tool_use_id: item.id,
            content: collabSpawnResult(item),
            is_error: item.status === 'failed',
          })
        }
      }
      return true
    }
    return false
  }

  /** agentsStates 单项 → bg_task_updated / bg_task_settled。 */
  private translateAgentState(threadId: string, state: any, item: any): void {
    const status = state?.status
    if (typeof status !== 'string') return
    // 已终态的 agent 又收到 running —— followup_task/interaction 重新激活:
    // 清 settled 标记并补 started+promote(bgStore 全终态沉降后可能已清空该
    // entry,updated 对未知 task 是 no-op —— 重新入池才能翻活)。其余情况
    // (终态快照重复到达)直接跳过 —— 防重复结算,唯一例外:权威终态纠正
    // (见下方分支)。
    if (this.collabAgentSettled.has(threadId)) {
      if (status !== 'running' && status !== 'pendingInit') {
        // 权威终态纠正:thread/status idle 兜底结算已写成 completed,随后
        // agentsStates 带真实终态到达 —— 不翻活,用 updated 把墓碑改成正确
        // 终态(errored→failed / shutdown·notFound→killed)。summary 通道
        // applyBgTaskUpdated 不支持,兜底结算已尽量带了子 agent 末段答复。
        if (status === 'errored' || status === 'shutdown' || status === 'notFound' || status === 'interrupted') {
          this.emit('bg_task_updated', {
            task_id: threadId,
            patch: {
              status: status === 'errored' ? 'failed' : 'killed',
              error: typeof state?.message === 'string' && state.message ? state.message : undefined,
            },
          } satisfies BgTaskUpdatedEvent)
        }
        return
      }
      this.collabAgentSettled.delete(threadId)
      const name = this.collabAgentNames.get(threadId) ?? collabAgentDisplayName(null, threadId)
      this.emit('bg_task_started', {
        task_id: threadId,
        task_type: 'local_agent',
        description: name,
      } satisfies BgTaskStartedEvent)
      this.emit('bg_task_updated', {
        task_id: threadId,
        patch: { is_backgrounded: true },
      } satisfies BgTaskUpdatedEvent)
    }
    if (!this.collabAgentNames.has(threadId)) {
      // 先于 subAgentActivity 到达(spawn 的 inProgress item 先落)。v2 wire 不带
      // receiverAgents,这里没有 agentPath —— 先用中性占位名入卡,subAgentActivity
      // (带 agentPath)到达时经 applyBgTaskStarted 的已知 id patch 补真名。
      const name = '子 agent'
      this.collabAgentNames.set(threadId, name)
      const started: BgTaskStartedEvent = {
        task_id: threadId,
        task_type: 'local_agent',
        description: name,
        prompt: collabPromptText(item.prompt),
      }
      this.emit('bg_task_started', started)
      const promoted: BgTaskUpdatedEvent = {
        task_id: threadId,
        patch: { is_backgrounded: true },
      }
      this.emit('bg_task_updated', promoted)
    }
    if (status === 'running' || status === 'pendingInit' || status === 'interrupted') {
      const updated: BgTaskUpdatedEvent = {
        task_id: threadId,
        // interrupted = 被打断等待新输入(可能 followup)→ paused 计时停走,
        // 不冒充 running。
        patch: { status: status === 'pendingInit' ? 'pending' : status === 'interrupted' ? 'paused' : 'running' },
      }
      this.emit('bg_task_updated', updated)
      return
    }
    // 终态:completed(message 即最终答复)/ errored / shutdown / notFound。
    // 同一 agent 的后续 wait item 会重复携带终态 —— settled 去重(顶部 guard 已滤)。
    // session 复用 alive 进程跨 turn,settled 随子 agent 数增长 —— 超上限清空
    // 重来:最坏后果是极老 agent 的重复终态快照多发一次 settled(store 对已终态
    // entry 幂等),比无界增长可接受。
    if (this.collabAgentSettled.size >= 5000) this.collabAgentSettled.clear()
    this.collabAgentSettled.add(threadId)
    const settled: BgTaskSettledEvent = {
      task_id: threadId,
      status: status === 'completed' ? 'completed' : status === 'errored' ? 'failed' : 'stopped',
      summary: typeof state?.message === 'string' && state.message ? state.message : undefined,
    }
    this.emit('bg_task_settled', settled)
  }

  private primeRolloutImageGenerationScan(): void {
    this.rolloutFilePath = null
    this.rolloutReadOffset = 0
    this.rolloutLineRemainder = ''
    this.rolloutDecoder = new StringDecoder('utf8')
    this.emittedImageGenerationIds.clear()
    if (!this.sessionId) return
    const filePath = findCodexRolloutFile(this.sessionId)
    if (!filePath) return
    this.rolloutFilePath = filePath
    try {
      this.rolloutReadOffset = statSync(filePath).size
    } catch (e) {
      logError('codex-process: image generation rollout stat failed', e)
      this.rolloutFilePath = null
      this.rolloutReadOffset = 0
    }
  }

  private flushRolloutImageGenerations(): void {
    if (!this.sessionId) return
    const filePath = this.rolloutFilePath ?? findCodexRolloutFile(this.sessionId)
    if (!filePath) {
      return
    }
    this.rolloutFilePath = filePath
    let buf: Buffer
    try {
      const size = statSync(filePath).size
      if (size <= this.rolloutReadOffset) return
      // 只读追加区间(不整文件读):大 rollout 每 flush 全量读会随会话线性变贵。
      const length = size - this.rolloutReadOffset
      buf = Buffer.allocUnsafe(length)
      const fd = openSync(filePath, 'r')
      let read = 0
      try {
        while (read < length) {
          const n = readSync(fd, buf, read, length - read, this.rolloutReadOffset + read)
          if (n === 0) break
          read += n
        }
      } finally {
        closeSync(fd)
      }
      buf = buf.subarray(0, read)
      this.rolloutReadOffset += read
    } catch (e) {
      logError('codex-process: image generation rollout read failed', e)
      return
    }

    // StringDecoder + remainder(ec149d7):写入方 append 的字节边界可能落在
    // 多字节 UTF-8 字符或 JSON 行中间 —— decoder 攒住半字符,remainder 攒住
    // 半行,下次 flush 拼接后再解析,分段读取不裂字不裂行。
    const text = this.rolloutLineRemainder + this.rolloutDecoder.write(buf)
    const lines = text.split(/\r?\n/)
    this.rolloutLineRemainder = text.endsWith('\n') ? '' : (lines.pop() ?? '')
    for (const line of lines) {
      if (!line.trim()) continue
      let record: any
      try {
        record = JSON.parse(line)
      } catch (e) {
        logError('codex-process: image generation rollout JSON parse failed', e)
        continue
      }
      const payload = record?.payload
      const type = payload?.type
      if (type !== 'image_generation_end' && type !== 'image_generation_call') continue
      this.emitRolloutImageGeneration(payload)
    }
  }

  private emitRolloutImageGeneration(payload: any): void {
    const callId = typeof payload?.call_id === 'string'
      ? payload.call_id
      : typeof payload?.id === 'string'
        ? payload.id
        : ''
    if (!callId || this.emittedImageGenerationIds.has(callId)) return
    const output = imageGenerationOutput(payload, this.sessionId ?? undefined)
    if (!output) return
    const isError = payload?.status === 'failed'
    const status = payload?.status === 'generating' && isAbsolute(output) ? 'completed' : payload?.status
    this.emittedImageGenerationIds.add(callId)
    this.emit('tool_use', {
      id: callId,
      name: 'ImageGeneration',
      input: imageGenerationInput({ ...payload, status }),
    })
    this.emit('tool_result', {
      tool_use_id: callId,
      content: output,
      is_error: isError,
    })
  }

  private withSessionId(notice: ContextCompactedNotification): ContextCompactedNotification {
    const sessionId = notice.sessionId ?? this.sessionId ?? undefined
    return sessionId ? { ...notice, sessionId } : notice
  }

  private handleServerRequest(req: any): void {
    const requestId = String(req.id)
    this.serverRequests.set(requestId, { id: req.id, method: req.method, params: req.params })
    const requestThreadId = req.params?.threadId ?? req.params?.thread_id
    if (this.isForeignThread(requestThreadId)) {
      logDiagnostic('codex-process: child control request rejected')
      this.respondError(requestId, 'server request belongs to a child thread')
      return
    }
    switch (req.method) {
      case 'item/commandExecution/requestApproval': {
        const p = req.params ?? {}
        this.emit('can_use_tool', {
          request_id: requestId,
          tool_name: 'Bash',
          input: { command: p.command, cwd: p.cwd, reason: p.reason },
          tool_use_id: p.itemId,
        } as CanUseToolRequest)
        return
      }
      case 'item/fileChange/requestApproval': {
        const p = req.params ?? {}
        this.emit('can_use_tool', {
          request_id: requestId,
          tool_name: 'FileChange',
          input: { reason: p.reason, grantRoot: p.grantRoot },
          tool_use_id: p.itemId,
        } as CanUseToolRequest)
        return
      }
      case 'item/tool/requestUserInput': {
        const p = req.params ?? {}
        const input = {
          questions: (p.questions ?? []).map((q: any) => ({
            id: q.id,
            header: q.header,
            question: q.question,
            options: Array.isArray(q.options) && q.options.length
              ? q.options.map((o: any) => ({ label: o.label, description: o.description }))
              : [{ label: '自定义回答', description: q.isSecret ? '请直接在当前对话中回复' : '可直接在当前对话中回复' }],
          })),
        }
        this.emit('tool_use', { id: p.itemId, name: 'AskUserQuestion', input })
        this.emit('can_use_tool', {
          request_id: requestId,
          tool_name: 'AskUserQuestion',
          input,
          tool_use_id: p.itemId,
        } as CanUseToolRequest)
        return
      }
      case 'item/permissions/requestApproval': {
        const p = req.params ?? {}
        this.emit('can_use_tool', {
          request_id: requestId,
          tool_name: 'PermissionProfile',
          input: { cwd: p.cwd, reason: p.reason, permissions: p.permissions },
          tool_use_id: p.itemId,
        } as CanUseToolRequest)
        return
      }
      case 'item/tool/call': {
        const p = req.params ?? {}
        this.emit('tool_use', {
          id: p.callId,
          name: p.namespace ? `${p.namespace}.${p.tool}` : p.tool,
          input: p.arguments,
        })
        this.respond(requestId, { contentItems: [{ type: 'inputText', text: 'Lodestar does not implement this dynamic tool.' }], success: false })
        return
      }
      case 'account/chatgptAuthTokens/refresh':
      case 'attestation/generate':
      case 'applyPatchApproval':
      case 'execCommandApproval':
      default: {
        logUnhandledAppServerEvent('SERVER_REQUEST_UNSUPPORTED')
        this.respondError(requestId, `unsupported server request: ${req.method}`)
      }
    }
  }

  private ensureStdinErrorListener(): void {
    if (this.stdinErrorListenerAttached) return
    const stdin = this.proc?.stdin as (Writable & { on?: Writable['on'] }) | undefined
    if (!stdin || typeof stdin.on !== 'function') return
    this.stdinErrorListenerAttached = true
    // 4185808 收紧:stdin error 不再连坐整张 pending 表 —— 各写各拒
    // (per-write 回调),已注册请求交给 close drain / 30s 超时兜底。
    stdin.on('error', error => this.handleStdinError(error))
  }

  private write(obj: object, onError?: (error: Error) => void): Error | null {
    if (!this.alive) {
      const error = new Error('codex app-server is not running')
      logDiagnostic('codex-process: write to closed process')
      return error
    }
    if (!this.proc || this.proc.stdin.destroyed || this.proc.stdin.writableEnded || !this.proc.stdin.writable) {
      const error = new Error('stdin is not writable')
      logError('codex-process: stdin write failed', error)
      return error
    }
    try {
      this.ensureStdinErrorListener()
      this.proc.stdin.write(JSON.stringify(obj) + '\n', error => {
        if (!error) return
        const writeError = error instanceof Error ? error : new Error(String(error))
        logError('codex-process: stdin write failed', writeError)
        onError?.(writeError)
      })
      return null
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e))
      logError('codex-process: stdin write failed', error)
      return error
    }
  }

  private request(method: string, params: any, timeoutMs = CODEX_REQUEST_TIMEOUT_MS): Promise<any> {
    const id = ++this.requestCounter
    return new Promise((resolve, reject) => {
      // 控制请求超时(ec149d7):响应/写失败/进程退出之外的第四条出路 ——
      // 传输 wedge(PID 活着但 stdio 断)时 30s 兜底拒绝,promise 不悬挂。
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        pending.reject(new Error(`codex app-server ${method} request timed out after ${timeoutMs}ms (id=${id})`))
      }, Math.max(0, timeoutMs))
      const entry: PendingRequest = { resolve, reject, method, timeout }
      this.pending.set(id, entry)
      const rejectWrite = (error: Error) => {
        if (this.pending.get(id) !== entry) {
          logDiagnostic('codex-process: late stdin failure ignored')
          return
        }
        this.pending.delete(id)
        clearTimeout(timeout)
        // 保留原始 error 对象拒绝(不包壳):receipt/熔断侧按 error.code(EPIPE 等)
        // 分类,包成新 Error 会丢 code —— 本地既有测试锁定该契约。
        entry.reject(error)
      }
      const writeError = this.write({ id, method, params }, rejectWrite)
      if (writeError) {
        rejectWrite(writeError)
      }
    })
  }

  private rejectPendingRequests(errorFor: (id: string | number, pending: PendingRequest) => Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout)
      pending.reject(errorFor(id, pending))
    }
    this.pending.clear()
  }

  private respond(id: string | number, result: any): void {
    const key = String(id)
    const req = this.serverRequests.get(key)
    this.serverRequests.delete(key)
    this.write({ id: req?.id ?? id, result })
  }

  private respondError(id: string | number, message: string): void {
    const key = String(id)
    const req = this.serverRequests.get(key)
    this.serverRequests.delete(key)
    // code 必填:app-server 的 JSONRPCMessage 反序列化只认带 code 的 error
    // 对象,只回 {message} 会 deserialize 失败、request 永久悬挂(上游 b839773
    // 2026-08-17 探针实测)。-32601 MethodNotFound 语义最接近"host 拒绝/不支持"。
    this.write({ id: req?.id ?? id, error: { code: -32601, message } })
  }

  sendInitialize(): void {
    if (!this.readyPromise) {
      this.readyPromise = this.initializeAndStartThread()
      void this.readyPromise.catch(e => {
        logError('codex-process: initialize failed', e)
        this.emit('error', e)
      })
    }
  }

  initializationPromise(): Promise<void> {
    if (!this.readyPromise) this.sendInitialize()
    return this.readyPromise!
  }

  isConversationResumable(): boolean {
    return this.conversationResumable
  }

  conversationMaterializationBarrier(): Promise<void> | null {
    return this.conversationMaterializationVerification
      ? this.drainConversationMaterialization()
      : null
  }

  conversationMaterializationFailure(): Error | null {
    return this.lastConversationMaterializationFailure
  }

  private async drainConversationMaterialization(): Promise<void> {
    while (this.conversationMaterializationVerification) {
      const active = this.conversationMaterializationVerification
      try { await active } catch { /* latest typed failure is stored by the owner */ }
      // The owner clears `active` and can install a queued completion retry in
      // its derived `finally` microtask. Yield so this loop observes the retry
      // rather than treating the first failed attempt as the final barrier.
      await Promise.resolve()
    }
    if (!this.conversationResumable && this.lastConversationMaterializationFailure) {
      throw this.lastConversationMaterializationFailure
    }
  }

  /** 在本进程的 app-server 连接上读账号额度(read 端点,权威多桶视图)。
   *  给 turn 收尾刷新 usage cache 用 —— rolling 通知 limitId 不可信
   *  (2026-08-20 源码核实:上游缺 meter 名时 codex 解析器强补 "codex"),
   *  额度状态只认 read。须在 initialize 之后调用。 */
  async readRateLimits(): Promise<any> {
    await this.ensureInitialized()
    return this.request('account/rateLimits/read', {})
  }

  private initializeParams(): Record<string, unknown> {
    return {
      clientInfo: { name: 'lodestar', version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }
  }

  /** Initialize this app-server transport exactly once, then complete the
   * JSON-RPC handshake before any catalog or thread request is sent. */
  private async ensureInitialized(): Promise<void> {
    if (this.startupPromise) await this.startupPromise
    if (!this.initializePromise) {
      this.initializePromise = this.request('initialize', this.initializeParams()).then(() => {
        if (this.write({ method: 'initialized' })) {
          throw new Error('codex app-server initialized notification write failed')
        }
      })
    }
    await this.initializePromise
  }

  private async initializeAndStartThread(): Promise<void> {
    const launch = this.conversationLaunch()
    await this.ensureInitialized()

    const params = this.threadParams()
    let method: 'thread/start' | 'thread/resume' | 'thread/fork'
    let res: any
    if (launch.kind === 'resume') {
      method = 'thread/resume'
      res = await this.request(method, {
        threadId: launch.source.sessionId,
        ...params,
        excludeTurns: true,
        persistExtendedHistory: false,
      })
    } else if (launch.kind === 'fork') {
      method = 'thread/fork'
      res = await this.request(method, {
        threadId: launch.source.sessionId,
        ...(launch.through ? { lastTurnId: launch.through.id } : {}),
        ...params,
        excludeTurns: true,
      })
    } else {
      method = 'thread/start'
      res = await this.request(method, {
        ...params,
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      })
    }
    const thread = res?.thread
    if (typeof thread?.id !== 'string' || !thread.id) {
      throw new Error(`codex app-server ${method} returned no thread.id`)
    }
    const returnedCwd = typeof thread.cwd === 'string'
      ? thread.cwd
      : typeof res?.cwd === 'string'
        ? res.cwd
        : null
    if (returnedCwd !== this.opts.workDir) {
      throw new Error(`codex app-server ${method} returned cwd=${returnedCwd ?? 'MISS'}, expected ${this.opts.workDir}`)
    }
    if (launch.kind === 'fork' && thread.id === launch.source.sessionId) {
      throw new Error(`codex app-server thread/fork returned source thread id ${thread.id}`)
    }
    if (launch.kind === 'resume' && thread.id !== launch.source.sessionId) {
      throw new Error(`codex app-server thread/resume returned thread id ${thread.id}, expected ${launch.source.sessionId}`)
    }
    // rollout 路径权威(4185808):app-server 返回的 thread.path 是持久化检查
    // 的唯一真相源,恢复安全性判定不扫第二索引。
    const rolloutPath = typeof thread.path === 'string' && thread.path ? thread.path : null
    if (!rolloutPath || !isAbsolute(rolloutPath) || !rolloutPath.endsWith(`${thread.id}.jsonl`)) {
      throw new Error(`codex app-server ${method} returned invalid thread.path=${rolloutPath ?? 'MISS'}`)
    }
    this.sessionId = thread.id
    this.conversationRolloutPath = rolloutPath
    // Resume requires an existing rollout and fork materializes its own rollout
    // before the RPC returns. Only fresh thread/start is still an in-memory id.
    this.conversationResumable = false
    if (launch.kind !== 'fresh') {
      await this.verifyConversationMaterialized(`${method} response`)
      this.conversationResumable = true
    }
    // pre-init 投递在这里绑定线程身份 —— 必须在 emit('init') 之前,
    // 让 Session 的 init 处理器读到已绑定的 dispatch.threadId。
    const preInitDelivery = this.pendingTurnStart
    if (preInitDelivery && preInitDelivery.threadId === null && this.sessionId) {
      preInitDelivery.threadId = this.sessionId
    }
    if (res?.model) this.lastModel = res.model
    this.usesCustomDefaultModeInstructions = res?.collaborationMode?.mode === 'default'
      && typeof res.collaborationMode.settings?.developer_instructions === 'string'
    if (isCodexReasoningEffort(res?.reasoningEffort)) this.lastEffort = res.reasoningEffort
    else this.lastEffort = this.opts.effort ?? null
    this.primeRolloutImageGenerationScan()
    this.emit('init', { session_id: this.sessionId, thread })
  }

  private markConversationMaterialized(source: string): void {
    if (this.conversationResumable) return
    if (!this.sessionId) {
      throw new Error(`codex ${source} arrived before thread initialization`)
    }
    if (this.conversationMaterializationVerification) {
      this.conversationMaterializationRetrySource = source
      return
    }
    const sessionId = this.sessionId
    const verification = this.verifyConversationMaterialized(source)
    this.conversationMaterializationVerification = verification
    void verification.then(() => {
      if (this.sessionId !== sessionId || this.conversationResumable) return
      this.lastConversationMaterializationFailure = null
      this.conversationResumable = true
      this.emit('conversation_materialized', { session_id: sessionId, source })
    }, cause => {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      this.lastConversationMaterializationFailure = error
      logError('codex-process: conversation materialization check failed', error)
      this.emit('conversation_materialization_failed', {
        session_id: sessionId,
        path: this.conversationRolloutPath,
        source,
        error,
      })
    }).finally(() => {
      if (this.conversationMaterializationVerification === verification) {
        this.conversationMaterializationVerification = null
      }
      const retrySource = this.conversationMaterializationRetrySource
      this.conversationMaterializationRetrySource = null
      if (!this.conversationResumable && retrySource) {
        this.markConversationMaterialized(retrySource)
      }
    })
  }

  private async verifyConversationMaterialized(source: string): Promise<void> {
    const sessionId = this.sessionId
    const path = this.conversationRolloutPath
    if (!sessionId || !path) throw new Error(`codex ${source} has no initialized rollout identity`)
    // On Codex 0.149 thread/read(includeTurns=true) explicitly rejects a fresh
    // in-memory thread as "not materialized yet". A successful read is the
    // app-server's authoritative persistence acknowledgement; the exact path
    // check then prevents a mismatched/foreign thread from being bound.
    const res = await this.request('thread/read', {
      threadId: sessionId,
      includeTurns: true,
    }, CODEX_MATERIALIZATION_VERIFY_TIMEOUT_MS)
    const thread = res?.thread
    if (
      thread?.id !== sessionId
      || thread.cwd !== this.opts.workDir
      || thread.path !== path
      || !Array.isArray(thread.turns)
    ) {
      throw new Error(`codex ${source} thread/read returned an invalid materialized thread`)
    }
    this.assertConversationRolloutMaterialized(source)
  }

  private assertConversationRolloutMaterialized(source: string): void {
    const path = this.conversationRolloutPath
    if (!path) throw new Error(`codex ${source} has no authoritative rollout path`)
    let stat: ReturnType<typeof statSync>
    try { stat = statSync(path) }
    catch (cause) {
      throw new Error(`codex ${source} rollout is not readable at ${path}: ${cause instanceof Error ? cause.message : cause}`, {
        cause,
      })
    }
    if (!stat.isFile()) throw new Error(`codex ${source} rollout path is not a file: ${path}`)
  }

  private conversationLaunch(): ConversationLaunch {
    const launch: ConversationLaunch = this.opts.launch ?? { kind: 'fresh' }
    validateConversationLaunch(launch, 'codex', this.opts.workDir)
    if (launch.kind !== 'fresh' && (typeof launch.source.sessionId !== 'string' || !launch.source.sessionId)) {
      throw new Error(`codex ${launch.kind} launch requires a source session id`)
    }
    if (launch.kind === 'fork' && launch.through) {
      if (launch.through.provider !== 'codex' || launch.through.kind !== 'turn') {
        throw new Error('codex fork through checkpoint must be a codex turn checkpoint')
      }
      if (typeof launch.through.id !== 'string' || !launch.through.id) {
        throw new Error('codex fork through checkpoint requires a turn id')
      }
    }
    return launch
  }

  private threadParams(): Record<string, unknown> {
    // request_user_input 工具默认只在 Plan mode 注册;开 flag 让 Default mode 也能用,
    // 澄清问题走原生阻塞式工具调用(0.144.1 钉版二进制含该 flag,上游 b839773 探针
    // 验证全链路)。answer 回包见 requestUserInput 分支;marker 栈保留作违规兜底。
    return {
      cwd: this.opts.workDir,
      runtimeWorkspaceRoots: [this.opts.workDir],
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      // config 键合并下发:request_user_input flag + 委派开关 + effort。effort 走
      // config.model_reasoning_effort —— codex 0.147 顶层 effort 参数是摆设
      // (下发任何值都被无视、回落 ~/.codex/config.toml),config 键才真生效
      // (2026-08-18 探针:effort=ultra 顶层回包 xhigh,config 路径回包 ultra)。
      config: {
        // The feature flag only controls whether the handler may run in Default
        // mode; the native tool switch controls exposure in the model's catalog.
        'tools.experimental_request_user_input.enabled': this.opts.allowUserInput !== false,
        'features.default_mode_request_user_input': this.opts.allowUserInput !== false,
        // 单层委派(D-11 口径 3):与被委派 worker 的 `--disable multi_agent`
        // 双保险 —— app-server 每次 thread 创建/恢复/分叉都带上关闭位。
        // 仅在显式 false(会话归属 worker)时设键;true/undefined(项目归属、
        // 主会话、直连)= 不设键,沿用原生配置。注意:codex-cli 0.162.1 实测
        // multi_agent_version 在 thread 创建时烘焙、对 thread id 不可逆 ——
        // 恢复/分叉已关闭线程时,显式 true 也无法还原(app-server 忽略),
        // 故此处不做无效回写(acceptance:session_to_project 按线程创建口径断言)。
        ...(this.opts.allowDelegation === false ? { 'features.multi_agent': false } : {}),
        ...(this.opts.effort ? { model_reasoning_effort: this.opts.effort } : {}),
      },
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...(this.opts.apiProvider ? { modelProvider: this.opts.apiProvider.id }
        : this.opts.tokenSourceId === 'codex-sub' ? { modelProvider: 'openai' } : {}),
      ...(this.opts.appendSystemPrompt ? { developerInstructions: this.opts.appendSystemPrompt } : {}),
      serviceName: this.opts.serviceName ?? 'lodestar',
    }
  }

  sendUserText(text: string, files: string[] = [], metadata?: { contextPrefix?: string }): UserTextDispatch {
    if (this.pendingTurnStart) {
      return {
        kind: 'rejected',
        provider: 'codex',
        error: new Error(`codex turn delivery ${this.pendingTurnStart.deliveryId} is still active`),
      }
    }
    // 真人输入接管:撤销退避与计数,满载重试序列从头开始(上游 2e6e1e0)。
    this.cancelTurnRetry()
    this.turnRetryCount = 0
    this.turnRetryHasStarted = false
    this.turnRetryEnabled = true
    this.turnError = null
    text = (metadata?.contextPrefix ?? '') + text
    const fileHints = files.length ? files.map(f => `[file: ${f}]`).join(' ') + '\n\n' : ''
    const { delivery, settlement } = this.beginTurnStart(fileHints + text)
    void this.launchTurnStart(delivery, fileHints + text)
    return {
      kind: 'turn_start_pending',
      provider: 'codex',
      deliveryId: delivery.deliveryId,
      get threadId() {
        return delivery.threadId
      },
      settlement,
    }
  }

  /** 建立本轮交付并推进投递代际。inputText 供满载拒绝路径原样重试使用。 */
  private beginTurnStart(inputText?: string): {
    delivery: PendingTurnStart
    settlement: Promise<CodexUserTextSettlement>
  } {
    const deliveryId = String(++this.deliveryCounter)
    this.turnStartGeneration = (this.turnStartGeneration ?? 0) + 1
    let settle!: (value: CodexUserTextSettlement) => void
    const settlement = new Promise<CodexUserTextSettlement>(resolve => {
      settle = resolve
    })
    const delivery: PendingTurnStart = {
      deliveryId,
      // pre-init(冷启动第一条)时为 null,init 成功后就地绑定;
      // dispatch.threadId getter 让 Session 始终读到绑定后的实时值。
      threadId: this.sessionId,
      turnId: null,
      settled: false,
      settle,
      ...(inputText !== undefined ? { inputText } : {}),
    }
    this.pendingTurnStart = delivery
    // 清空点(ff44afb):turn/start 传输失败也会 emit result;建 delivery 即清
    // (任何 await 之前),失败不得复用上一轮 checkpoint 作锚。
    this.lastCompletedTurnId = null
    return { delivery, settlement }
  }

  private async launchTurnStart(delivery: PendingTurnStart, text: string): Promise<void> {
    try {
      // 中断已抢先:不再发出 turn/start(上游 2e6e1e0 的 attempt.interrupted 早退),
      // 交付已在 sendInterrupt 就地结算,这里不再重复。
      if (delivery.interrupted) return
      if (!this.alive || this.expectedExit) {
        throw new Error(`codex app-server is not alive before turn/start (alive=${this.alive})`)
      }
      // 只有 pre-init 投递需要先等线程建立;已绑定线程的投递直接走
      // startTurn(其内部本就会等待 readyPromise)。
      if (delivery.threadId === null) {
        if (!this.readyPromise) this.sendInitialize()
        await this.readyPromise
      }
      const threadId = delivery.threadId
      if (!threadId || this.sessionId !== threadId) {
        throw new Error(
          `codex thread owner changed before turn/start: expected ${threadId ?? 'pending'}, got ${this.sessionId ?? 'none'}`,
        )
      }
      const result = await this.startTurn(text, threadId)
      const responseThreadId = this.stringId(result?.threadId ?? result?.thread?.id)
      if (responseThreadId && responseThreadId !== threadId) {
        this.rejectTurnStart(delivery, new Error(
          `codex turn/start response thread mismatch: expected ${threadId}, got ${responseThreadId}`,
        ))
        return
      }
      const turnId = this.stringId(result?.turn?.id ?? result?.turnId)
      // 等待响应期间被中断:本轮不得开轮,迟到 turn 就地掐断;delivery 留在
      // pendingTurnStart 上,由随后的 turn/completed 吞掉。
      if (delivery.interrupted) {
        if (turnId) this.interruptTurn(turnId)
        return
      }
      this.ackTurnStart(delivery, turnId)
    } catch (error) {
      this.rejectTurnStart(delivery, error)
    }
  }

  async steerUserText(text: string, files: string[] = [], inputId = randomUUID()): Promise<boolean> {
    if (!this.alive || this.expectedExit) throw new Error('Codex 进程已关闭')
    const turnId = this.currentTurnId
    if (!turnId) return false
    const fileHints = files.length ? files.map(f => `[file: ${f}]`).join(' ') + '\n\n' : ''
    this.steeringInputs ??= new Map()
    this.steeringInputs.set(inputId, turnId)
    let result: any
    try {
      result = await this.request('turn/steer', {
        threadId: this.sessionId,
        expectedTurnId: turnId,
        clientUserMessageId: inputId,
        input: [{ type: 'text', text: fileHints + text, text_elements: [] }],
      })
    } catch (error) {
      // A definite RPC rejection did not admit this input. A transport error
      // may still be followed by its authoritative item notification.
      if (error instanceof CodexRpcResponseError) this.steeringInputs.delete(inputId)
      throw error
    }
    if (result?.turnId !== turnId) throw new Error('Codex turn/steer 未确认目标回合，追加消息的接收状态未知')
    return true
  }

  async listModels(): Promise<CodexModel[]> {
    await this.ensureInitialized()
    const models: CodexModel[] = []
    const seenCursors = new Set<string>()
    let cursor: string | null = null
    do {
      const res = await this.request('model/list', {
        cursor,
        limit: 100,
        includeHidden: false,
      })
      if (!Array.isArray(res?.data)) {
        throw new Error('model/list returned no data array')
      }
      for (const raw of res.data) {
        if (typeof raw?.model !== 'string' || !raw.model) continue
        models.push({
          id: typeof raw.id === 'string' && raw.id ? raw.id : raw.model,
          model: raw.model,
          displayName: typeof raw.displayName === 'string' && raw.displayName ? raw.displayName : raw.model,
          description: typeof raw.description === 'string' ? raw.description : '',
          hidden: raw.hidden === true,
          isDefault: raw.isDefault === true,
          supportedReasoningEfforts: parseReasoningEffortOptions(raw.supportedReasoningEfforts),
          defaultReasoningEffort: isCodexReasoningEffort(raw.defaultReasoningEffort)
            ? raw.defaultReasoningEffort
            : null,
        })
      }
      const nextCursor = res?.nextCursor
      if (nextCursor !== null && typeof nextCursor !== 'string') {
        throw new Error('model/list returned an invalid nextCursor')
      }
      cursor = nextCursor || null
      if (cursor) {
        if (seenCursors.has(cursor)) throw new Error('model/list returned a repeated nextCursor')
        seenCursors.add(cursor)
      }
    } while (cursor)
    return models
  }

  /** List persisted Codex interactive conversations for this exact cwd.
   * App-server owns discovery and pagination; Lodestar does not scan rollouts
   * or substitute a second session index. `sourceKinds` is intentionally
   * omitted: current app-server can persist Lodestar-created threads as `vscode`,
   * and the protocol-defined default already selects interactive sources while
   * excluding sub-agent-only histories. */
  async listConversations(): Promise<ConversationSummary[]> {
    await this.ensureInitialized()
    const conversations: ConversationSummary[] = []
    const seenCursors = new Set<string>()
    let cursor: string | null = null
    do {
      const res = await this.request('thread/list', {
        cursor,
        limit: 100,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        cwd: this.opts.workDir,
      })
      if (!Array.isArray(res?.data)) {
        throw new Error('thread/list returned no data array')
      }
      for (const raw of res.data) {
        if (
          typeof raw?.id !== 'string' || !raw.id
          || typeof raw.preview !== 'string'
          || typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)
          || typeof raw.cwd !== 'string' || raw.cwd !== this.opts.workDir
        ) {
          throw new Error('thread/list returned an invalid thread summary')
        }
        const status = typeof raw.status === 'string'
          ? raw.status
          : typeof raw.status?.type === 'string'
            ? raw.status.type
            : undefined
        if (isAgentSession('codex', raw.id)) continue
        conversations.push({
          provider: 'codex',
          sessionId: raw.id,
          cwd: raw.cwd,
          preview: raw.preview,
          // app-server timestamps are Unix seconds; card/history callers use ms.
          ts: raw.updatedAt * 1000,
          ...(status ? { status } : {}),
        })
      }
      const nextCursor = res?.nextCursor
      if (nextCursor !== null && typeof nextCursor !== 'string') {
        throw new Error('thread/list returned an invalid nextCursor')
      }
      if (nextCursor && seenCursors.has(nextCursor)) {
        throw new Error(`thread/list repeated pagination cursor ${nextCursor}`)
      }
      if (nextCursor) seenCursors.add(nextCursor)
      cursor = nextCursor
    } while (cursor)
    return conversations
  }

  /** Resolve one legacy resume id to its authoritative stored cwd without loading it. */
  async readConversationRef(sessionId: string): Promise<ConversationRef> {
    if (!sessionId.trim()) throw new Error('thread/read requires a session id')
    await this.ensureInitialized()
    const res = await this.request('thread/read', { threadId: sessionId, includeTurns: false })
    const thread = res?.thread
    if (thread?.id !== sessionId || typeof thread.cwd !== 'string') {
      throw new Error('thread/read returned an invalid conversation reference')
    }
    return { provider: 'codex', sessionId, cwd: thread.cwd }
  }

  async injectThreadItems(items: any[]): Promise<void> {
    if (!Array.isArray(items) || items.length === 0) return
    if (!this.readyPromise) this.sendInitialize()
    await this.readyPromise
    if (!this.sessionId) throw new Error('codex thread not initialized')
    await this.request('thread/inject_items', {
      threadId: this.sessionId,
      items,
    })
  }

  async setModelSettings(model: string, effort: AgentReasoningEffort): Promise<void> {
    if (!model.trim()) throw new Error('empty model')
    if (!isCodexReasoningEffort(effort)) throw new Error(`invalid reasoning effort: ${String(effort)}`)
    throw new Error('codex app-server does not support live model settings; restart the process with new spawn options')
  }

  async setModel(model: string): Promise<void> {
    await this.setModelSettings(model, this.opts.effort)
  }

  async compactThread(): Promise<void> {
    if (!this.readyPromise) throw new Error('codex thread not initialized')
    await this.readyPromise
    if (!this.sessionId) throw new Error('codex thread not initialized')
    if (this.currentTurnId || this.turnRetry) {
      throw new Error('codex cannot manually compact while a task is active')
    }
    // Manual compaction has no unfinished user task to continue. A failed cm
    // must report its own error, never resurrect the last completed task.
    this.turnRetryEnabled = false
    await this.request('thread/compact/start', {
      threadId: this.sessionId,
    })
  }

  private stringId(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
  }

  private ackTurnStart(delivery: PendingTurnStart, turnId: string | null): boolean {
    if (this.pendingTurnStart !== delivery) return false
    const threadId = delivery.threadId
    if (!threadId) {
      logDiagnostic('codex-process: unbound delivery acknowledgment ignored')
      return false
    }
    if (turnId) {
      if (delivery.turnId && delivery.turnId !== turnId) {
        logDiagnostic('codex-process: conflicting delivery acknowledgment ignored')
        return false
      }
      delivery.turnId = turnId
      this.currentTurnId = turnId
    }
    if (delivery.settled) return true
    delivery.settled = true
    delivery.settle({
      kind: 'ack',
      deliveryId: delivery.deliveryId,
      threadId,
      turnId: delivery.turnId,
    })
    return true
  }

  private rejectTurnStart(delivery: PendingTurnStart, cause: unknown): boolean {
    if (this.pendingTurnStart !== delivery || delivery.settled) {
      logDiagnostic('codex-process: late turn start failure ignored')
      return false
    }
    const error = cause instanceof Error ? cause : new Error(String(cause))
    // 模型满载/瞬时故障拒绝:本轮不终结 —— 先按 ack(turnId=null)结算交付,再排
    // 进程层统一退避(上游 2e6e1e0 引擎;容量变体并入 codexTurnRetryReason)。严禁把
    // delivery 挂起到重试结果(session 的 await dispatch.settlement 会因此悬挂,
    // T-02-13)。settle 必须先于 turn_retry 事件/计时器排定。
    if (
      cause instanceof CodexRpcResponseError &&
      cause.method === 'turn/start' &&
      delivery.inputText !== undefined &&
      delivery.threadId !== null &&
      this.alive && !this.expectedExit && this.turnRetryEnabled && !this.turnRetryTimer && !this.currentTurnId
    ) {
      const retryReason = codexTurnRetryReason({
        ...(cause.serverData && typeof cause.serverData === 'object' ? cause.serverData : {}),
        message: cause.serverMessage,
      })
      const retryBudgetAvailable = retryReason === 'capacity'
        || (retryReason !== null && (this.transientRetryCount ?? 0) < CODEX_TRANSIENT_RETRY_LIMIT)
      if (retryReason && retryBudgetAvailable) {
        const threadId = delivery.threadId
        delivery.settled = true
        delivery.settle({ kind: 'ack', deliveryId: delivery.deliveryId, threadId, turnId: null })
        this.pendingTurnStart = null
        if (this.scheduleTurnRetry(cause.serverMessage, delivery.inputText, retryReason)) return true
        // 竞态失败(理论上不会到这):delivery 已按 ack 结算,下面走显式失败收口。
      }
    }
    delivery.settled = true
    delivery.settle({
      kind: 'rejected',
      deliveryId: delivery.deliveryId,
      threadId: delivery.threadId,
      error,
    })
    this.pendingTurnStart = null
    this.failTurnStart(error, delivery)
    return true
  }

  private failTurnStart(e: unknown, delivery: PendingTurnStart): void {
    const message = e instanceof Error ? e.message : String(e)
    logError('codex-process: turn/start failed', e)
    this.cancelTurnRetry()
    this.turnRetryCount = 0
    this.transientRetryCount = 0
    this.turnRetryHasStarted = false
    this.lastResult = {
      cost_usd: null,
      cost_delta_usd: null,
      duration_ms: null,
      num_turns: null,
      usage: this.lastUsage,
      subtype: 'codex_turn_start_failed',
      is_error: true,
    }
    this.currentTurnId = null
    // 清空点(ff44afb):turn 启动失败,上一轮 checkpoint 不可再作锚。
    this.lastCompletedTurnId = null
    this.emit('result', {
      subtype: this.lastResult.subtype,
      is_error: true,
      duration_ms: null,
      usage: this.lastUsage,
      error: message,
      delivery_id: delivery.deliveryId,
      thread_id: delivery.threadId ?? undefined,
      turn_id: delivery.turnId,
      ...(e instanceof CodexRpcResponseError && e.method === 'turn/start' && delivery.inputText !== undefined
        && (isCodexQuotaError(e.serverData) || isCodexQuotaError({ message: e.serverMessage }))
        ? { codexQuotaFailure: { accepted: false, rejectedInput: delivery.inputText } } : {}),
    })
  }

  private async startTurn(text: string, threadId?: string): Promise<any> {
    if (!this.readyPromise) this.sendInitialize()
    await this.readyPromise
    // 省略 threadId 时(直接调用/上游测试调用形态)按就绪后的属主线程落位。
    const targetThreadId = threadId ?? this.sessionId ?? ''
    if (this.sessionId !== targetThreadId) {
      throw new Error(`codex thread owner changed before turn/start: expected ${targetThreadId}, got ${this.sessionId ?? 'none'}`)
    }
    const refreshMode = this.opts.allowUserInput === false
      || (this.usesCustomDefaultModeInstructions && !!this.opts.appendSystemPrompt)
    const modeModel = this.opts.model ?? this.lastModel
    if (refreshMode && !modeModel) {
      throw new Error('Codex model is missing while applying the current invocation policy')
    }
    return await this.request('turn/start', {
      threadId: targetThreadId,
      input: [{ type: 'text', text, text_elements: [] }],
      cwd: this.opts.workDir,
      runtimeWorkspaceRoots: [this.opts.workDir],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
      // Services cannot inherit Plan mode. Returning to an interactive caller
      // must also replace a previous service's custom Default-mode instructions.
      // An interactive caller's existing Plan mode remains native.
      ...(refreshMode ? {
        collaborationMode: {
          mode: 'default',
          settings: {
            model: modeModel,
            reasoning_effort: this.opts.effort ?? this.lastEffort ?? null,
            developer_instructions: this.opts.appendSystemPrompt ?? null,
          },
        },
      } : {}),
      ...(this.opts.model ? { model: this.opts.model } : {}),
      effort: this.opts.effort,
    })
  }

  private rememberFinishedTurn(turnId: string): void {
    // Object.create(CodexProcess.prototype) test/probe harnesses do not run
    // class field initializers, so retain lazy initialization here.
    if (!this.finishedTurnIds) this.finishedTurnIds = new Set<string>()
    this.finishedTurnIds.add(turnId)
    if (this.finishedTurnIds.size <= 64) return
    const oldest = this.finishedTurnIds.values().next().value
    if (typeof oldest === 'string') this.finishedTurnIds.delete(oldest)
  }

  sendInterrupt(): void {
    this.inputConsumptionOpen = false
    this.steeringInputs?.clear()
    // 用户中断即放弃自动重试(上游 2e6e1e0)。
    this.turnRetryEnabled = false
    const wasWaiting = !!this.turnRetry && !this.currentTurnId
    this.cancelTurnRetry()
    const pendingStart = this.pendingTurnStart
    const interruptPendingStart = !!pendingStart && !pendingStart.settled
    if (interruptPendingStart) {
      pendingStart.interrupted = true
      // 交付模型适配:中断抢在 ACK 之前时,Session 的 await dispatch.settlement
      // 不得悬挂 —— 就地按 rejected 结算(不再 emit result,避免与下面的
      // interrupted result 重复)。delivery 留在 pendingTurnStart 上,由迟到
      // 的 turn/completed 吞掉(等价上游 finishedTurnIds 的单轮口径)。
      pendingStart.settled = true
      pendingStart.settle({
        kind: 'rejected',
        deliveryId: pendingStart.deliveryId,
        threadId: pendingStart.threadId,
        error: new Error('codex turn start interrupted'),
      })
    }
    if (this.currentTurnId) this.interruptTurn(this.currentTurnId)
    else if (wasWaiting || interruptPendingStart) {
      this.lastCompletedTurnId = null
      this.lastResult = {
        cost_usd: null, cost_delta_usd: null, duration_ms: null, num_turns: null,
        usage: this.lastUsage, subtype: 'interrupted', is_error: false,
      }
      this.emit('result', { ...this.lastResult, checkpoint: null })
    }
  }

  private interruptTurn(turnId: string): void {
    if (!this.sessionId) return
    void this.request('turn/interrupt', { threadId: this.sessionId, turnId })
      .catch(e => logError('codex-process: interrupt failed', e))
  }

  private cancelTurnRetry(): void {
    if (this.turnRetryTimer) clearTimeout(this.turnRetryTimer)
    this.turnRetryTimer = null
    this.turnRetry = null
  }

  private scheduleTurnRetry(message: string, inputText: string, reason: CodexTurnRetryReason): boolean {
    if (!this.alive || this.expectedExit || !this.turnRetryEnabled) return false
    if (this.turnRetryTimer) return true
    if (reason !== 'capacity') {
      if ((this.transientRetryCount ?? 0) >= CODEX_TRANSIENT_RETRY_LIMIT) {
        logError('codex-process: transient retry limit reached', message)
        return false
      }
      this.transientRetryCount = (this.transientRetryCount ?? 0) + 1
    }
    const attempt = (this.turnRetryCount ?? 0) + 1
    this.turnRetryCount = attempt
    const backoffAttempt = reason === 'capacity' ? attempt : this.transientRetryCount
    const delayMs = Math.min(CODEX_TURN_RETRY_BASE_MS * 2 ** Math.min(backoffAttempt - 1, 4), CODEX_TURN_RETRY_MAX_MS)
    const generation = this.turnStartGeneration ?? 0
    const notice: AgentTurnRetry = { phase: 'waiting', attempt, delayMs, message, reason }
    this.turnRetry = notice
    // Capacity retries continue until cancelled; transient failures share a budget.
    // Every failure stays visible in the log and UI.
    const timer = setTimeout(() => {
      if (this.turnRetryTimer !== timer) return
      this.turnRetryTimer = null
      if (!this.alive || this.expectedExit || !this.turnRetryEnabled
        || this.currentTurnId || generation !== (this.turnStartGeneration ?? 0)) return
      this.turnRetry = { ...notice, phase: 'retrying', delayMs: 0 }
      this.emit('turn_retry', this.turnRetry)
      // Event consumers can synchronously stop the worker or supply new input;
      // 重启前再校验一次代际。
      if (!this.alive || this.expectedExit || !this.turnRetryEnabled
        || generation !== (this.turnStartGeneration ?? 0)) return
      const { delivery } = this.beginTurnStart(inputText)
      void this.launchTurnStart(delivery, inputText)
    }, delayMs)
    this.turnRetryTimer = timer
    this.emit('turn_retry', notice)
    return true
  }

  sendPermissionResponse(
    requestId: string | number,
    decision: 'allow' | 'deny',
    payload?: { updatedInput?: Record<string, unknown>; updatedPermissions?: unknown; denyMessage?: string },
  ): void {
    const req = this.serverRequests.get(String(requestId))
    if (!req) {
      logDiagnostic('codex-process: permission response for unknown request')
      return
    }
    const allow = decision === 'allow'
    switch (req.method) {
      case 'item/commandExecution/requestApproval':
        this.respond(requestId, { decision: allow ? 'accept' : 'decline' })
        return
      case 'item/fileChange/requestApproval':
        this.respond(requestId, { decision: allow ? 'accept' : 'decline' })
        return
      case 'item/permissions/requestApproval':
        if (allow) {
          this.respond(requestId, {
            permissions: req.params?.permissions ?? {},
            scope: 'session',
          })
        } else {
          this.respondError(requestId, payload?.denyMessage ?? 'denied by user')
        }
        return
      case 'item/tool/requestUserInput': {
        if (!allow) {
          this.respondError(requestId, payload?.denyMessage ?? 'denied by user')
          return
        }
        const answersByQuestion = (payload?.updatedInput?.answers ?? {}) as Record<string, string>
        const answers: Record<string, { answers: string[] }> = {}
        for (const q of req.params?.questions ?? []) {
          const value = answersByQuestion[q.question] ?? answersByQuestion[q.id]
          if (value !== undefined) answers[q.id] = { answers: [String(value)] }
        }
        this.respond(requestId, { answers })
        return
      }
      default:
        logUnhandledAppServerEvent('APPROVAL_RESPONSE_UNSUPPORTED')
        this.respondError(requestId, payload?.denyMessage ?? 'unsupported approval request')
    }
  }

  sendHookResponse(requestId: string, output: object = {}): void {
    this.respond(requestId, output)
  }

  /** Session ownership remains live through child `close`, even after the OS
   * `exit` event, so no caller can detach while final stdout is still draining. */
  isAlive(): boolean { return !this.exitEventEmitted }

  async kill(timeoutMs = 5000): Promise<void> {
    this.turnRetryEnabled = false
    this.cancelTurnRetry()
    this.inputPolicyAbort?.abort(new Error('Codex process cancelled'))
    if (this.startupPromise) {
      this.expectedExit = true
      let startupTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          this.startupPromise.catch(() => {}), // startup error is reported by initialization/exit
          new Promise<never>((_resolve, reject) => {
            startupTimer = setTimeout(() => reject(new Error(`Codex model catalog preparation did not exit within ${timeoutMs * 2}ms`)), timeoutMs * 2)
          }),
        ])
      } finally { if (startupTimer) clearTimeout(startupTimer) }
    }
    // OS exit 已见但公开 exit(stdio close)未发:等 drain 完成,超时如实抛。
    if (!this.alive) {
      if (await this.waitForExit(timeoutMs)) { await this.disposeInputPolicy(); return }
      throw new Error(`codex app-server exited but stdio did not close within ${timeoutMs}ms`)
    }
    this.expectedExit = true
    const signalErrors: string[] = []
    this.sendSignal('SIGTERM', signalErrors)
    if (await this.waitForExit(timeoutMs)) { await this.disposeInputPolicy(); return }

    if (this.alive) this.sendSignal('SIGKILL', signalErrors)
    if (await this.waitForExit(timeoutMs)) { await this.disposeInputPolicy(); return }

    // 双杀都没等到公开 exit:如实抛出(ec149d7),不再静默返回假装已停 ——
    // materialization 的 exit-close-error 次序纪律依赖真实退出信号。
    const details = signalErrors.length ? `; ${signalErrors.join('; ')}` : ''
    const error = new Error(`codex app-server did not exit after SIGTERM and SIGKILL (${timeoutMs}ms each)${details}`)
    logError('codex-process: kill failed', error)
    throw error
  }

  private async disposeInputPolicy(): Promise<void> {
    if (!this.inputPolicyCatalog) return
    await this.inputPolicyCatalog.dispose()
    this.inputPolicyCatalog = null
  }

  private sendSignal(signal: NodeJS.Signals, errors: string[]): void {
    try {
      if (!this.proc?.kill(signal) && this.alive) errors.push(`${signal} was not delivered`)
    } catch (e) {
      errors.push(`${signal} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    // 以公开 exit(exitEventEmitted/exitPromise)为准:OS exit 后 stdio 未
    // close 不算退出完成(final response 可能还在 drain)。
    if (this.exitEventEmitted) return true
    return new Promise(resolve => {
      let settled = false
      const finish = (exited: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve(exited)
      }
      const timeout = setTimeout(() => finish(false), Math.max(0, timeoutMs))
      void this.exitPromise.then(() => finish(true))
    })
  }
}

function mapSubAgentActivity(item: any): {
  activityId: string
  agentThreadId: string
  agentPath: string | null
  kind: string
} | null {
  if (typeof item?.id !== 'string' || typeof item?.agentThreadId !== 'string') return null
  return {
    activityId: item.id,
    agentThreadId: item.agentThreadId,
    agentPath: typeof item.agentPath === 'string' ? item.agentPath : null,
    kind: typeof item.kind === 'string' ? item.kind : 'unknown',
  }
}

function isCollabAgentStates(value: unknown): value is CollabAgentStates {
  if (!isPlainObject(value)) return false
  return Object.values(value).every(state => {
    if (!isPlainObject(state)) return false
    const status = (state as { status?: unknown }).status
    return status === undefined || typeof status === 'string'
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function mapStartedItem(item: any, workDir: string): { name: string; input: any } | null {
  switch (item.type) {
    case 'commandExecution':
      return { name: 'Bash', input: { command: item.command, cwd: item.cwd, source: item.source } }
    case 'fileChange':
      return { name: 'FileChange', input: { changes: item.changes, status: item.status, cwd: workDir } }
    case 'mcpToolCall':
      return { name: 'MCP', input: { server: item.server, tool: item.tool, arguments: item.arguments } }
    case 'dynamicToolCall':
      return { name: item.namespace ? `${item.namespace}.${item.tool}` : item.tool, input: item.arguments }
    case 'webSearch':
      return { name: 'WebSearch', input: { query: item.query, action: item.action } }
    case 'imageGeneration':
      return { name: 'ImageGeneration', input: imageGenerationInput(item) }
    // collabAgentToolCall 由 feedCollabItem 状态机消费(cf41941 timeline 压缩),
    // 不再映射成 Agent JSON 面板。
  }
  return null
}

function imageGenerationRevisedPrompt(item: any): string | undefined {
  const prompt = item?.revisedPrompt ?? item?.revised_prompt
  return typeof prompt === 'string' && prompt ? prompt : undefined
}

function imageGenerationInput(item: any): object {
  return { status: item.status, revisedPrompt: imageGenerationRevisedPrompt(item),
    ...(typeof item?.prompt === 'string' && item.prompt ? { prompt: item.prompt } : {}) }
}

function findCodexRolloutFile(sessionId: string): string | null {
  if (!sessionId || !existsSync(CODEX_SESSIONS_DIR)) return null
  let best: { path: string; mtimeMs: number } | null = null
  const stack = [CODEX_SESSIONS_DIR]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      logError('codex-process: cannot scan Codex session dir', e)
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(path)
        continue
      }
      if (!entry.isFile()) continue
      if (!entry.name.startsWith('rollout-') || !entry.name.endsWith(`${sessionId}.jsonl`)) continue
      try {
        const mtimeMs = statSync(path).mtimeMs
        if (!best || mtimeMs > best.mtimeMs) best = { path, mtimeMs }
      } catch (e) {
        logError('codex-process: cannot stat Codex rollout', e)
      }
    }
  }
  return best?.path ?? null
}

export function imageGenerationOutput(
  item: any,
  threadId?: string,
  outputRoot = CODEX_GENERATED_IMAGES_DIR,
): string {
  const directPath = item?.savedPath ?? item?.saved_path
  if (typeof directPath === 'string' && directPath) return directPath

  const result = item?.result
  if (typeof result === 'string') {
    const materialized = materializeImageGenerationResult(item, threadId, outputRoot)
    if (materialized) return materialized
    if (result.length > 2048) {
      logDiagnostic('codex-process: image generation inline result could not be decoded')
      return `Image generation returned ${result.length} chars of inline data, but Lodestar could not materialize it as an image file.`
    }
    return result
  }
  if (result && typeof result === 'object') {
    const resultPath = result.savedPath ?? result.saved_path ?? result.path
    if (typeof resultPath === 'string' && resultPath) return resultPath
    return JSON.stringify(result, null, 2)
  }
  return ''
}

function materializeImageGenerationResult(item: any, threadId: string | undefined, outputRoot: string): string | null {
  const result = item?.result
  if (typeof result !== 'string') return null
  const decoded = imageBufferFromBase64Result(result)
  if (!decoded) return null

  const threadPart = sanitizeGeneratedImagePart(threadId ?? 'unknown-thread')
  const callPart = sanitizeGeneratedImagePart(imageGenerationCallId(item))
  const dir = join(outputRoot, threadPart)
  const path = join(dir, `${callPart}.${decoded.ext}`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, decoded.buffer)
    return path
  } catch (e) {
    logError('codex-process: failed to write image generation result', e)
    return null
  }
}

function imageGenerationCallId(item: any): string {
  const id = item?.callId ?? item?.call_id ?? item?.id
  return typeof id === 'string' && id ? id : `image-${Date.now()}`
}

function sanitizeGeneratedImagePart(part: string): string {
  const sanitized = part.trim().replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/^_+|_+$/g, '')
  return sanitized ? sanitized.slice(0, 140) : 'unknown'
}

function imageBufferFromBase64Result(result: string): { buffer: Buffer; ext: string } | null {
  const trimmed = result.trim()
  let base64 = trimmed
  let hintedExt: string | null = null
  const dataUrl = trimmed.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/s)
  if (dataUrl) {
    hintedExt = mimeSubtypeToExtension(dataUrl[1])
    base64 = dataUrl[2]
  } else {
    if (trimmed.length < 64) return null
    if (!/^[a-zA-Z0-9+/=_\-\s]+$/.test(trimmed)) return null
  }
  base64 = base64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  if (!base64 || base64.length % 4 === 1) return null

  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  let buffer: Buffer
  try {
    buffer = Buffer.from(padded, 'base64')
  } catch {
    return null
  }
  if (buffer.length < 12) return null

  const ext = detectImageExtension(buffer) ?? hintedExt
  if (!ext) return null
  return { buffer, ext }
}

function detectImageExtension(buffer: Buffer): string | null {
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) return 'png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg'
  const header = buffer.subarray(0, 6).toString('ascii')
  if (header === 'GIF87a' || header === 'GIF89a') return 'gif'
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  return null
}

function mimeSubtypeToExtension(subtype: string): string | null {
  const normalized = subtype.toLowerCase()
  if (normalized === 'jpeg' || normalized === 'jpg') return 'jpg'
  if (normalized === 'png') return 'png'
  if (normalized === 'gif') return 'gif'
  if (normalized === 'webp') return 'webp'
  return null
}

/** completed 映射并入 started 映射(ec149d7):同一 item 的 name/input 与 output
 * 一起返回,completed 消费方(subagent_step 等)不再丢工具名。两函数 case 集
 * 一致(commandExecution/fileChange/mcpToolCall/dynamicToolCall/webSearch/
 * imageGeneration),并入不会额外丢类型。 */
function mapCompletedItem(
  item: any,
  workDir: string,
  threadId?: string,
): { name: string; input: any; output: string; isError: boolean } | null {
  const started = mapStartedItem(item, workDir)
  if (!started) return null
  switch (item.type) {
    case 'commandExecution':
      return {
        ...started,
        output: item.aggregatedOutput ?? '',
        isError: item.exitCode != null && item.exitCode !== 0,
      }
    case 'fileChange':
      return { ...started, output: JSON.stringify(item.changes ?? [], null, 2), isError: item.status === 'failed' }
    case 'mcpToolCall':
      return {
        ...started,
        output: item.error ? JSON.stringify(item.error, null, 2) : JSON.stringify(item.result ?? null, null, 2),
        isError: !!item.error,
      }
    case 'dynamicToolCall':
      return {
        ...started,
        output: JSON.stringify(item.contentItems ?? [], null, 2),
        isError: item.success === false,
      }
    case 'webSearch':
      return { ...started, output: JSON.stringify(item.action ?? {}, null, 2), isError: false }
    case 'imageGeneration':
      return { ...started, output: imageGenerationOutput(item, threadId), isError: item.status === 'failed' }
    // collabAgentToolCall 由 feedCollabItem 状态机消费(cf41941 timeline 压缩),
    // 不再 dump agentsStates JSON;spawn 摘要 result 见 collabSpawnResult。
  }
  return null
}

// ── 多 agent 编排 item 的展示辅助(cf41941)──────────────────────────
// subagentStepBrief 在 src/cards/background.ts(纯展示函数与 briefInput 同族,
// barrel 导出防上游「漏导出放大成整流中断」事故)。

/** agentPath(如 "/root/order_schema/official_history_orders")末段作展示名;
 *  无 path 时退回 threadId 的诊断前缀。 */
function collabAgentDisplayName(agentPath: unknown, threadId: string): string {
  if (typeof agentPath === 'string' && agentPath) {
    const last = agentPath.split('/').filter(Boolean).pop()
    if (last) return last
  }
  return diagnosticIdLabel(threadId)
}

/** spawn/followup 的 prompt 文本:fork_turns=all 时是服务端 Fernet 密文
 *  (gAAAAAB…,2000 字乱码会糊满面板),归一成占位说明。 */
function collabPromptText(prompt: unknown): string | undefined {
  if (typeof prompt !== 'string' || !prompt) return undefined
  if (prompt.startsWith('gAAAA') && !/[一-鿿]/.test(prompt)) return '(继承主线程历史的密文任务书)'
  return prompt
}

/** v2 wire 的 receiver 线程 id 列表(receiverThreadIds;内部 proto 的
 *  receiver_agents 在 v2 转换时被丢弃,agentPath/nickname 不下发)。 */
function collabReceiverThreadIds(item: any): string[] {
  const ids = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []
  return ids.filter((id: unknown): id is string => typeof id === 'string' && !!id)
}

/** spawn 面板描述:receiver 线程数(wire 无名字,只有 id)。 */
function collabSpawnDescription(item: any): string {
  const ids = collabReceiverThreadIds(item)
  return ids.length > 0 ? `派生 ${ids.length} 个子 agent` : '派生子 agent'
}

/** spawn 面板完成态输出:agentsStates 的可读摘要(每 agent 一行「线程:状态」),
 *  替代旧的 agentsStates JSON dump。真名由后台卡(subAgentActivity agentPath)
 *  承载,这里只有线程 id 的诊断前缀。 */
function collabSpawnResult(item: any): string {
  const states = item.agentsStates
  if (!states || typeof states !== 'object') return ''
  const lines: string[] = []
  for (const [threadId, state] of Object.entries(states)) {
    const s = state as any
    const status = typeof s?.status === 'string' ? s.status : 'unknown'
    lines.push(`${diagnosticIdLabel(threadId)}: ${status}`)
  }
  return lines.join('\n')
}
