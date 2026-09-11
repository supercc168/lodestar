import type { AgentProcess, AgentReasoningEffort, AgentTurnRetry } from './agent-process'
import type { AgentIdentity } from './agent-identities'
import { createAgentProcess } from './agent-launch'
import { rememberAgentSession } from './agent-session-registry'
import type { AgentInputQuestion, AgentInputRequest, AgentStep } from './agent-run-types'
import type { ConversationLaunch } from './conversation'
import type { ProjectProfile } from './config'

const INPUT_TOOLS = new Set(['AskUserQuestion', 'request_user_input'])

export interface AgentWorkerResult {
  output: string
  outputTruncated: boolean
  sessionId: string
  checkpointId?: string
  durationMs: number
  usage: Record<string, number | undefined> | null
}

/** D-14:失败或取消时连同此前已生成的输出一起抛出 —— 失败不再吞掉正文。
 *  调用方(agent-service)据此把 output 落回 worker.output。 */
export class AgentWorkerFailure extends Error {
  constructor(cause: Error, readonly output: string, readonly sessionId: string | null) {
    super(cause.message, { cause })
    this.name = 'AgentWorkerFailure'
  }
}

export interface AgentWorkerCallbacks {
  onNeedsInput?(request: AgentInputRequest): void
  onProgress?(step: AgentStep): void
  onSession?(sessionId: string): void
}

export interface AgentWorkerHandle {
  done: Promise<AgentWorkerResult>
  /** 进程是否仍在:供「取消后进程是否真的退出」与并发槽位判定使用。 */
  isAlive?(): boolean
  pendingInput(): AgentInputRequest | null
  answer(requestId: string, answers: Record<string, string>): void
  cancel(reason?: string): Promise<void>
}

export function startAgentWorker(opts: {
  identity: AgentIdentity
  effort: AgentReasoningEffort
  workDir: string
  prompt: string
  resumeSessionId?: string
  developerInstructions?: string
  profile?: ProjectProfile
  hostEnv: Record<string, string | undefined>
  /** 原生工具层委派开关(D-11 口径 3)。worker 一律禁再委派,故缺省即 false;
   *  仅显式 true 才放开(当前无调用方)。 */
  allowDelegation?: boolean
  callbacks?: AgentWorkerCallbacks
}): AgentWorkerHandle {
  if (!opts.identity.supportedEfforts.includes(opts.effort)) {
    throw new Error(`${opts.identity.displayName} does not support effort ${opts.effort}`)
  }
  const launch: ConversationLaunch = opts.resumeSessionId
    ? { kind: 'resume', source: { provider: opts.identity.provider, sessionId: opts.resumeSessionId, cwd: opts.workDir } }
    : { kind: 'fresh' }
  const { process: proc } = createAgentProcess({
    provider: opts.identity.provider,
    workDir: opts.workDir,
    tokenSourceId: opts.identity.tokenSourceId,
    model: opts.identity.model,
    effort: opts.effort,
    launch,
    developerInstructions: opts.developerInstructions,
    profile: opts.profile,
    hostEnv: opts.hostEnv,
    serviceName: 'lodestar-agent',
    allowDelegation: opts.allowDelegation ?? false,
  })
  return collectAgentTurn(proc, opts.prompt, opts.callbacks)
}

export function collectAgentTurn(
  proc: AgentProcess,
  prompt: string,
  callbacks: AgentWorkerCallbacks = {},
  remember: typeof rememberAgentSession = rememberAgentSession,
): AgentWorkerHandle {
  const output: string[] = []
  let lastError: Error | null = null
  let settled = false
  let waiting: { request: AgentInputRequest; originalInput: Record<string, unknown> } | null = null
  let resolveDone!: (value: AgentWorkerResult) => void
  let rejectDone!: (error: Error) => void
  const startedAt = Date.now()
  const done = new Promise<AgentWorkerResult>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })

  const rememberSession = (sessionId: string | null | undefined): Error | null => {
    if (!sessionId) return null
    try {
      remember(proc.provider, sessionId)
      callbacks.onSession?.(sessionId)
      return null
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error))
    }
  }
  const cleanupListeners = () => {
    proc.off('assistant_text', onText)
    proc.off('tool_use', onToolUse)
    proc.off('tool_result', onToolResult)
    proc.off('subagent_step', onSubagentStep)
    proc.off('can_use_tool', onPermission)
    proc.off('hook_callback', onHook)
    proc.off('init', onInit)
    proc.off('error', onError)
    proc.off('turn_retry', onRetry)
    proc.off('result', onResult)
    proc.off('exit', onExit)
  }
  const finish = async (error?: Error, result?: { checkpoint?: any }): Promise<void> => {
    if (settled) return
    settled = true
    cleanupListeners()
    const registryError = rememberSession(proc.sessionId)
    let closeError: Error | null = null
    try { await proc.kill(3000) }
    catch (cause) { closeError = cause instanceof Error ? cause : new Error(String(cause)) }
    const failure = error ?? registryError ?? closeError
    const text = output.join('').trim()
    if (failure) {
      rejectDone(new AgentWorkerFailure(failure, text, proc.sessionId))
      return
    }
    const sessionId = proc.sessionId
    if (!sessionId) {
      rejectDone(new AgentWorkerFailure(
        new Error('delegated agent completed without a native session id'), text, null,
      ))
      return
    }
    const checkpointId = checkpointIdFrom(result?.checkpoint, proc)
    resolveDone({
      output: text,
      // D-14:截断退场。上游把输出体量保护交给卡片连续输出(本仓 03-04/03-05 已
      // 落地换卡与指纹去重),runner 不再按固定上限截断;字段保留但恒为 false,
      // 避免卡片层与既有调用方连锁改动。
      outputTruncated: false,
      sessionId,
      ...(checkpointId ? { checkpointId } : {}),
      durationMs: Date.now() - startedAt,
      usage: proc.lastUsage ? { ...proc.lastUsage } : null,
    })
  }
  const onText = (event: { text?: string; parentToolUseId?: string | null }) => {
    if (settled || event?.parentToolUseId || typeof event?.text !== 'string') return
    output.push(event.text)
  }
  const emitProgress = (step: AgentStep) => {
    try { callbacks.onProgress?.(step) }
    catch (error) { void finish(error instanceof Error ? error : new Error(String(error))) }
  }
  const onToolUse = (event: { name?: string }) => emitProgress({
    at: new Date().toISOString(), phase: 'started', tool: String(event?.name ?? 'tool'), detail: '',
  })
  const onToolResult = (event: { is_error?: boolean }) => emitProgress({
    at: new Date().toISOString(), phase: 'completed', tool: event?.is_error ? 'tool error' : 'tool result', detail: '',
  })
  const onSubagentStep = (event: { tool?: string; phase?: 'started' | 'completed' }) => emitProgress({
    at: new Date().toISOString(), phase: event?.phase ?? 'info', tool: String(event?.tool ?? 'subagent'), detail: '',
  })
  const onPermission = (request: {
    request_id: string | number
    tool_name?: string
    tool_use_id?: string
    input?: Record<string, unknown>
  }) => {
    if (!INPUT_TOOLS.has(String(request.tool_name ?? ''))) {
      try { proc.sendPermissionResponse(request.request_id, 'allow', { updatedInput: request.input ?? {} }) }
      catch (error) { void finish(error instanceof Error ? error : new Error(String(error))) }
      return
    }
    if (waiting) {
      void finish(new Error('delegated agent emitted multiple simultaneous input requests'))
      return
    }
    let normalized: AgentInputRequest
    try { normalized = normalizeInputRequest(request) }
    catch (error) {
      void finish(error instanceof Error ? error : new Error(String(error)))
      return
    }
    waiting = { request: normalized, originalInput: request.input ?? {} }
    try { callbacks.onNeedsInput?.(normalized) }
    catch (error) { void finish(error instanceof Error ? error : new Error(String(error))) }
  }
  const onHook = (request: { request_id: string | number }) => {
    try { proc.sendHookResponse(String(request.request_id), {}) }
    catch (error) { void finish(error instanceof Error ? error : new Error(String(error))) }
  }
  const onInit = (event: { session_id?: string }) => {
    const error = rememberSession(event?.session_id ?? proc.sessionId)
    if (error) void finish(error)
  }
  const onError = (error: unknown) => { lastError = error instanceof Error ? error : new Error(String(error)) }
  const onRetry = (retry: AgentTurnRetry) => {
    // 进程层满载退避只报进度(D-14 后无看门狗可布防);文案随事件携带的
    // delayMs/attempt(上游 2e6e1e0)。
    emitProgress({
      at: new Date().toISOString(), phase: 'info', tool: 'Codex 容量重试',
      detail: retry.phase === 'waiting'
        ? `${retry.message} · ${retry.delayMs / 1000}s 后重试 #${retry.attempt}`
        : `正在重试 #${retry.attempt}`,
    })
  }
  const onResult = (result: { is_error?: boolean; error?: unknown; subtype?: unknown; checkpoint?: unknown }) => {
    const error = result?.is_error
      ? new Error(String(result.error ?? result.subtype ?? proc.lastResult.subtype ?? 'delegated agent failed'))
      : undefined
    void finish(error, result)
  }
  const onExit = (event: { code?: number | null; signal?: string | null }) => {
    if (settled) return
    const detail = `code=${event?.code ?? 'null'} signal=${event?.signal ?? 'null'}`
    void finish(lastError ?? new Error(`delegated agent exited before result (${detail})`))
  }

  proc.on('assistant_text', onText)
  proc.on('tool_use', onToolUse)
  proc.on('tool_result', onToolResult)
  proc.on('subagent_step', onSubagentStep)
  proc.on('can_use_tool', onPermission)
  proc.on('hook_callback', onHook)
  proc.on('init', onInit)
  proc.on('error', onError)
  proc.on('turn_retry', onRetry)
  proc.on('result', onResult)
  proc.on('exit', onExit)
  try {
    proc.sendInitialize()
    proc.sendUserText(prompt)
  } catch (error) {
    void finish(error instanceof Error ? error : new Error(String(error)))
  }

  return {
    done,
    isAlive: () => proc.isAlive(),
    pendingInput: () => waiting?.request ?? null,
    answer(requestId: string, answers: Record<string, string>): void {
      if (!waiting) throw new Error('delegated agent is not waiting for input')
      if (waiting.request.requestId !== requestId) {
        throw new Error(`delegated agent input request mismatch: expected ${waiting.request.requestId}`)
      }
      const pending = waiting
      proc.sendPermissionResponse(requestId, 'allow', { updatedInput: { ...pending.originalInput, answers } })
      waiting = null
    },
    async cancel(reason = 'delegated agent cancelled'): Promise<void> {
      await finish(new Error(reason))
      await done.catch(() => {})
    },
  }
}

function normalizeInputRequest(request: {
  request_id: string | number
  tool_use_id?: string
  input?: Record<string, unknown>
}): AgentInputRequest {
  const input = request.input ?? {}
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [input]
  const questions = rawQuestions.map((raw, index) => normalizeQuestion(raw, index))
  if (questions.length === 0) throw new Error('delegated agent input request contains no questions')
  return {
    requestId: String(request.request_id),
    ...(request.tool_use_id ? { toolUseId: request.tool_use_id } : {}),
    questions,
  }
}

function normalizeQuestion(raw: unknown, index: number): AgentInputQuestion {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : { question: raw }
  const question = String(value.question ?? value.prompt ?? value.title ?? '').trim()
  if (!question) throw new Error(`delegated agent input question ${index + 1} is empty`)
  const id = String(value.id ?? question)
  const options = Array.isArray(value.options)
    ? value.options.map(option => {
        if (typeof option === 'string') return { label: option }
        const item = option && typeof option === 'object' ? option as Record<string, unknown> : {}
        return { label: String(item.label ?? item.value ?? ''), ...(item.description ? { description: String(item.description) } : {}) }
      }).filter(option => option.label)
    : []
  return { id, ...(value.header ? { header: String(value.header) } : {}), question, options }
}

function checkpointIdFrom(checkpoint: any, proc: AgentProcess): string | undefined {
  if (typeof checkpoint?.id === 'string' && checkpoint.id) return checkpoint.id
  // dsh 的 checkpoint 形如 { provider:'dsh', kind:'event', id:'<seq>' };事件序号由
  // DshProcess 从原生事件流取,与 codex 的 turn id 同属"后端原生锚点"语义。
  if ((proc.provider === 'codex' || proc.provider === 'dsh') && typeof proc.lastCompletedTurnId === 'string' && proc.lastCompletedTurnId) return proc.lastCompletedTurnId
  if (proc.provider === 'claude' && proc.lastAssistantUuid) return proc.lastAssistantUuid
  return undefined
}
