import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { EventEmitter } from 'node:events'
import {
  query,
  type EffortLevel,
  type ModelInfo,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type UserDialogRequest,
  type UserDialogResult,
} from '@anthropic-ai/claude-agent-sdk'
import { config } from './config'
import { log } from './log'
import {
  CLAUDE_EFFORT,
  isClaudeReasoningEffort,
  type AgentReasoningEffort,
  type ClaudeReasoningEffort,
} from './agent-process'
import {
  claudeModelKey,
  resolveClaudeModelEnv,
  resolveClaudeSdkModel,
} from './claude-models'
import type {
  CanUseToolRequest,
  CodexModel,
  CodexResultMeta,
  CodexUsage,
  SpawnOpts,
} from './codex-process'

type QueueWaiter<T> = (value: IteratorResult<T>) => void

class AsyncQueue<T> implements AsyncIterableIterator<T> {
  private items: T[] = []
  private waiters: QueueWaiter<T>[] = []
  private closed = false

  push(item: T): void {
    if (this.closed) throw new Error('input stream is closed')
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: item, done: false })
    else this.items.push(item)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    while (this.waiters.length) this.waiters.shift()?.({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this
  }

  next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) return Promise.resolve({ value: this.items.shift()!, done: false })
    if (this.closed) return Promise.resolve({ value: undefined, done: true })
    return new Promise(resolve => this.waiters.push(resolve))
  }
}

type PendingPermission = {
  kind: 'permission'
  resolve: (value: PermissionResult) => void
  request: CanUseToolRequest
}

type PendingUserDialog = {
  kind: 'dialog'
  resolve: (value: UserDialogResult) => void
  request: CanUseToolRequest
}

type PendingControl = PendingPermission | PendingUserDialog

export interface ClaudeSpawnOpts extends SpawnOpts {
  model?: string
  effort: ClaudeReasoningEffort
}

export function resolveClaudeBin(): string {
  if (process.platform !== 'win32') {
    const local = join(homedir(), '.local', 'bin', 'claude')
    if (existsSync(local)) return local
  }
  const found = whichClaude()
  if (found) return found
  throw new Error('Claude Code executable not found. Install Claude Code or add `claude` to PATH.')
}

export function assertClaudeCodeAvailable(): void {
  resolveClaudeBin()
}

function whichClaude(): string | null {
  const PATH = process.env.PATH ?? ''
  if (!PATH) return null
  const candidates = process.platform === 'win32'
    ? ['claude.cmd', 'claude.bat', 'claude.exe', 'claude']
    : ['claude']
  for (const dir of PATH.split(delimiter)) {
    if (!dir) continue
    for (const name of candidates) {
      const p = join(dir, name)
      if (existsSync(p)) return p
    }
  }
  return null
}

function buildSpawnPath(): string {
  if (process.platform === 'win32') return process.env.PATH ?? ''
  return [
    join(homedir(), '.local', 'npm-global', 'bin'),
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.bun', 'bin'),
    '/usr/local/bin', '/usr/bin', '/bin',
  ].join(delimiter)
}

function usageFromSdk(raw: any): CodexUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const out: CodexUsage = {}
  const fields: Array<[keyof CodexUsage, string]> = [
    ['input_tokens', 'input_tokens'],
    ['output_tokens', 'output_tokens'],
    ['cache_creation_input_tokens', 'cache_creation_input_tokens'],
    ['cache_read_input_tokens', 'cache_read_input_tokens'],
  ]
  for (const [key, rawKey] of fields) {
    const value = raw[rawKey]
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  const total = (out.input_tokens ?? 0)
    + (out.output_tokens ?? 0)
    + (out.cache_creation_input_tokens ?? 0)
    + (out.cache_read_input_tokens ?? 0)
  if (total <= 0) return null
  out.total_tokens = total
  return out
}

function totalUsageFromModelUsage(modelUsage: any): { usage: CodexUsage | null; contextWindow: number | null; cost: number | null } {
  if (!modelUsage || typeof modelUsage !== 'object') return { usage: null, contextWindow: null, cost: null }
  const usage: CodexUsage = {}
  let contextWindow: number | null = null
  let cost: number | null = null
  for (const value of Object.values(modelUsage)) {
    if (!value || typeof value !== 'object') continue
    const item = value as Record<string, unknown>
    usage.input_tokens = (usage.input_tokens ?? 0) + numberField(item.inputTokens)
    usage.output_tokens = (usage.output_tokens ?? 0) + numberField(item.outputTokens)
    usage.cache_read_input_tokens = (usage.cache_read_input_tokens ?? 0) + numberField(item.cacheReadInputTokens)
    usage.cache_creation_input_tokens = (usage.cache_creation_input_tokens ?? 0) + numberField(item.cacheCreationInputTokens)
    const ctx = numberField(item.contextWindow)
    if (ctx > 0) contextWindow = Math.max(contextWindow ?? 0, ctx)
    const itemCost = numberField(item.costUSD)
    if (itemCost > 0) cost = (cost ?? 0) + itemCost
  }
  const total = (usage.input_tokens ?? 0)
    + (usage.output_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0)
  if (total <= 0) return { usage: null, contextWindow, cost }
  usage.total_tokens = total
  return { usage, contextWindow, cost }
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function textFromToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(item => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
        return (item as { text: string }).text
      }
      return JSON.stringify(item)
    }).join('\n')
  }
  return content == null ? '' : JSON.stringify(content, null, 2)
}

function mapModelInfo(info: ModelInfo): CodexModel {
  const efforts = info.supportedEffortLevels && info.supportedEffortLevels.length > 0
    ? info.supportedEffortLevels
    : [CLAUDE_EFFORT]
  return {
    id: claudeModelKey(info.value),
    model: claudeModelKey(info.value),
    displayName: info.displayName || claudeModelKey(info.value),
    description: info.description || 'Claude Agent SDK backend',
    hidden: false,
    isDefault: false,
    supportedReasoningEfforts: efforts.map(effort => ({
      reasoningEffort: effort as any,
      description: '',
    })),
    defaultReasoningEffort: efforts.includes(CLAUDE_EFFORT) ? CLAUDE_EFFORT as any : efforts[0] as any,
  }
}

const CLAUDE_ASK_DIALOG_KINDS = [
  'ask_user_question',
  'askUserQuestion',
  'AskUserQuestion',
] as const

function normalizeAskDialogInput(request: UserDialogRequest): Record<string, unknown> | null {
  if (!CLAUDE_ASK_DIALOG_KINDS.includes(request.dialogKind as any)) return null
  const payload = request.payload && typeof request.payload === 'object' ? request.payload : {}
  const questions = normalizeDialogQuestions(payload)
  if (questions.length === 0) return null
  return { ...payload, questions }
}

function normalizeDialogQuestions(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const rawQuestions = payload.questions
  const items = Array.isArray(rawQuestions)
    ? rawQuestions
    : rawQuestions && typeof rawQuestions === 'object'
      ? [rawQuestions]
      : [payload]
  return items
    .map(item => normalizeDialogQuestion(item))
    .filter((item): item is Record<string, unknown> => item !== null)
}

function normalizeDialogQuestion(raw: unknown): Record<string, unknown> | null {
  const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : { question: raw }
  const question = firstString(item.question, item.prompt, item.title, item.message, item.text, item.label)
  if (!question) return null
  if (!question.trim()) return null
  const options = normalizeDialogOptions(item.options ?? item.choices ?? item.suggestions)
  return {
    ...item,
    question,
    options,
    ...(typeof item.header === 'string' ? { header: item.header } : {}),
    ...(typeof item.multiSelect === 'boolean' ? { multiSelect: item.multiSelect } : {}),
  }
}

function normalizeDialogOptions(raw: unknown): Array<Record<string, string>> {
  if (!Array.isArray(raw)) return []
  return raw
    .map(item => {
      if (typeof item === 'string') return { label: item }
      if (!item || typeof item !== 'object') return null
      const obj = item as Record<string, unknown>
      const label = firstString(obj.label, obj.value, obj.text, obj.title)
      if (!label?.trim()) return null
      const description = firstString(obj.description, obj.detail, obj.preview)
      return description ? { label, description } : { label }
    })
    .filter((item): item is Record<string, string> => item !== null)
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') return value
  }
  return undefined
}

export class ClaudeAgentProcess extends EventEmitter {
  readonly provider = 'claude' as const

  private opts: ClaudeSpawnOpts
  private input = new AsyncQueue<SDKUserMessage>()
  private query: Query | null = null
  private alive = true
  private expectedExit = false
  private started = false
  private pendingPermissions = new Map<string, PendingControl>()
  private pendingInjectedContext: string[] = []
  private requestCounter = 0
  private lastTotalCostUsd: number | null = null

  sessionId: string | null = null
  lastAssistantUuid: string | null = null
  lastModel: string | null = null
  lastEffort: ClaudeReasoningEffort | null = null
  lastUsage: CodexUsage | null = null
  lastTotalUsage: CodexUsage | null = null
  lastResult: CodexResultMeta = {
    cost_usd: null, cost_delta_usd: null, duration_ms: null, num_turns: null,
    usage: null, subtype: null, is_error: false,
  }
  lastContextWindow: number | null = null

  constructor(opts: ClaudeSpawnOpts) {
    super()
    this.on('error', () => {})
    this.opts = opts
    this.lastEffort = opts.effort
    this.lastModel = opts.model ? claudeModelKey(opts.model) : null
  }

  sendInitialize(): void {
    if (this.started) return
    this.started = true
    const model = resolveClaudeSdkModel(this.opts.model)
    log(`claude-agent-process: spawn SDK query model=${model ?? 'default'} effort=${this.opts.effort} cwd=${this.opts.workDir}`)
    try {
      this.query = query({
        prompt: this.input,
        options: {
          cwd: this.opts.workDir,
          ...(model ? { model } : {}),
          effort: this.opts.effort as EffortLevel,
          resume: this.opts.resumeSessionId,
          pathToClaudeCodeExecutable: resolveClaudeBin(),
          env: {
            ...(process.env as Record<string, string>),
            PATH: buildSpawnPath(),
            ...resolveClaudeModelEnv(this.opts.model),
            ...config.claude.env,
          },
          settingSources: ['user'],
          tools: { type: 'preset', preset: 'claude_code' },
          toolConfig: {
            askUserQuestion: { previewFormat: 'markdown' },
          },
          supportedDialogKinds: [...CLAUDE_ASK_DIALOG_KINDS],
          onUserDialog: (request, options) => this.onUserDialog(request, options),
          includePartialMessages: false,
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            ...(this.opts.appendSystemPrompt ? { append: this.opts.appendSystemPrompt } : {}),
          },
          canUseTool: (toolName, input, options) => this.onCanUseTool(toolName, input, options),
          stderr: data => {
            const text = data.trim()
            if (text) log(`claude-agent-process[stderr]: ${text}`)
          },
        },
      })
    } catch (e) {
      this.alive = false
      const err = e instanceof Error ? e : new Error(String(e))
      this.emit('error', err)
      this.emit('exit', { code: 1, signal: null, expected: this.expectedExit })
      return
    }
    void this.readLoop(this.query)
  }

  sendUserText(text: string, files: string[] = []): void {
    if (!this.alive) {
      log('claude-agent-process: sendUserText ignored on dead process')
      return
    }
    if (!this.started) this.sendInitialize()
    const fileHints = files.length ? files.map(f => `[file: ${f}]`).join(' ') + '\n\n' : ''
    const injected = this.pendingInjectedContext.length
      ? this.pendingInjectedContext.splice(0).join('\n\n') + '\n\n'
      : ''
    try {
      this.input.push({
        type: 'user',
        session_id: this.sessionId ?? '',
        message: {
          role: 'user',
          content: [{ type: 'text', text: injected + fileHints + text }],
        },
        parent_tool_use_id: null,
        priority: 'now',
      } as SDKUserMessage)
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      log(`claude-agent-process: sendUserText failed: ${err.message}`)
      this.failTurnStart(err)
    }
  }

  sendInterrupt(): void {
    void this.query?.interrupt().catch(e => log(`claude-agent-process: interrupt failed: ${e}`))
  }

  sendPermissionResponse(
    requestId: string | number,
    decision: 'allow' | 'deny',
    payload?: { updatedInput?: Record<string, unknown>; denyMessage?: string },
  ): void {
    const pending = this.pendingPermissions.get(String(requestId))
    if (!pending) {
      log(`claude-agent-process: permission response for unknown request ${requestId}`)
      return
    }
    this.pendingPermissions.delete(String(requestId))
    if (pending.kind === 'dialog') {
      if (decision === 'allow') {
        const updatedInput = payload?.updatedInput ?? {}
        pending.resolve({
          behavior: 'completed',
          result: 'answers' in updatedInput ? updatedInput.answers : updatedInput,
        })
      } else {
        pending.resolve({ behavior: 'cancelled' })
      }
      return
    }
    if (decision === 'allow') {
      pending.resolve({
        behavior: 'allow',
        updatedInput: payload?.updatedInput,
        toolUseID: pending.request.tool_use_id,
        decisionClassification: 'user_temporary',
      })
    } else {
      pending.resolve({
        behavior: 'deny',
        message: payload?.denyMessage ?? 'denied by user',
        toolUseID: pending.request.tool_use_id,
        decisionClassification: 'user_reject',
      })
    }
  }

  sendToolResult(_toolUseId: string, _content: string, _isError = false): void {
    log('claude-agent-process: sendToolResult ignored; Claude Agent SDK executes built-in tools internally')
  }

  sendHookResponse(_requestId: string, _output: object = {}): void {
    log('claude-agent-process: sendHookResponse ignored; hooks are handled by SDK callbacks')
  }

  isAlive(): boolean {
    return this.alive
  }

  async kill(timeoutMs = 5000): Promise<void> {
    if (!this.alive) return
    this.expectedExit = true
    this.input.close()
    try { this.query?.close() }
    catch {}
    const start = Date.now()
    while (this.alive && Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 100))
    }
    if (this.alive) {
      this.alive = false
      this.emit('exit', { code: null, signal: 'SIGKILL', expected: this.expectedExit })
    }
  }

  async listModels(): Promise<CodexModel[]> {
    if (!this.started) this.sendInitialize()
    const models = await this.query!.supportedModels()
    return models.map(mapModelInfo)
  }

  async setModelSettings(model: string, effort: AgentReasoningEffort): Promise<void> {
    const claudeModel = resolveClaudeSdkModel(model)
    if (!isClaudeReasoningEffort(effort)) throw new Error(`invalid Claude effort: ${String(effort)}`)
    if (!this.started) this.sendInitialize()
    if (claudeModel) await this.query!.setModel(claudeModel)
    if (effort === 'max') {
      await this.query!.applyFlagSettings({ ultracode: true })
    } else {
      await this.query!.applyFlagSettings({ effortLevel: effort, ultracode: null })
    }
    this.opts.model = model
    this.opts.effort = effort
    this.lastModel = claudeModel ? claudeModelKey(model) : 'claude:default'
    this.lastEffort = effort
  }

  async setModel(model: string): Promise<void> {
    await this.setModelSettings(model, this.opts.effort)
  }

  async compactThread(): Promise<void> {
    throw new Error('Claude Agent SDK backend does not support Lodestar compact yet')
  }

  async injectThreadItems(items: any[]): Promise<void> {
    if (!Array.isArray(items) || items.length === 0) return
    this.pendingInjectedContext.push([
      'Host-injected prior tool context for this continuation:',
      JSON.stringify(items, null, 2),
    ].join('\n'))
  }

  private onCanUseTool(
    toolName: string,
    input: Record<string, unknown>,
    options: { suggestions?: any; blockedPath?: string; toolUseID?: string; title?: string; description?: string },
  ): Promise<PermissionResult> {
    const requestId = `claude_perm_${++this.requestCounter}`
    const req: CanUseToolRequest = {
      request_id: requestId,
      tool_name: toolName,
      input: {
        ...input,
        ...(options.title ? { __lodestar_permission_title: options.title } : {}),
        ...(options.description ? { __lodestar_permission_description: options.description } : {}),
      },
      permission_suggestions: options.suggestions,
      blocked_paths: options.blockedPath ? [options.blockedPath] : undefined,
      tool_use_id: options.toolUseID,
    }
    const pending = new Promise<PermissionResult>(resolve => {
      this.pendingPermissions.set(requestId, { kind: 'permission', resolve, request: req })
    })
    this.emit('can_use_tool', req)
    return pending
  }

  private onUserDialog(
    request: UserDialogRequest,
    options: { signal: AbortSignal },
  ): Promise<UserDialogResult> {
    const input = normalizeAskDialogInput(request)
    if (!input) {
      log(`claude-agent-process: cancel unsupported user dialog kind=${request.dialogKind}`)
      return Promise.resolve({ behavior: 'cancelled' })
    }
    const requestId = `claude_dialog_${++this.requestCounter}`
    const toolUseId = request.toolUseID || requestId
    const req: CanUseToolRequest = {
      request_id: requestId,
      tool_name: 'AskUserQuestion',
      input,
      tool_use_id: toolUseId,
    }
    const pending = new Promise<UserDialogResult>(resolve => {
      const finish = (value: UserDialogResult) => {
        options.signal.removeEventListener('abort', abort)
        resolve(value)
      }
      const abort = () => {
        if (!this.pendingPermissions.delete(requestId)) return
        finish({ behavior: 'cancelled' })
      }
      options.signal.addEventListener('abort', abort, { once: true })
      this.pendingPermissions.set(requestId, { kind: 'dialog', resolve: finish, request: req })
    })
    this.emit('tool_use', { id: toolUseId, name: 'AskUserQuestion', input })
    this.emit('can_use_tool', req)
    return pending
  }

  private async readLoop(q: Query): Promise<void> {
    try {
      for await (const message of q) this.handleMessage(message)
      this.finishExit(null, null)
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      log(`claude-agent-process: read loop failed: ${err.message}`)
      this.emit('error', err)
      this.finishExit(1, null)
    }
  }

  private finishExit(code: number | null, signal: string | null): void {
    if (!this.alive) return
    this.alive = false
    for (const [id, pending] of this.pendingPermissions) {
      if (pending.kind === 'dialog') pending.resolve({ behavior: 'cancelled' })
      else pending.resolve({ behavior: 'deny', message: 'Claude backend exited before permission response', toolUseID: pending.request.tool_use_id })
      this.pendingPermissions.delete(id)
    }
    log(`claude-agent-process: exited code=${code} signal=${signal} expected=${this.expectedExit}`)
    this.emit('exit', { code, signal, expected: this.expectedExit })
  }

  private handleMessage(message: SDKMessage): void {
    const raw = message as any
    if (typeof raw.session_id === 'string' && raw.session_id) this.sessionId = raw.session_id
    switch (raw.type) {
      case 'system':
        this.handleSystemMessage(raw)
        return
      case 'assistant':
        this.handleAssistantMessage(raw)
        return
      case 'user':
        this.handleUserMessage(raw)
        return
      case 'result':
        this.handleResultMessage(raw)
        return
      case 'rate_limit_event':
        this.emit('rate_limits_updated', raw.rate_limit_info)
        return
      case 'stream_event':
        return
      default:
        log(`claude-agent-process: unhandled message type=${raw.type ?? 'unknown'} subtype=${raw.subtype ?? ''}`)
    }
  }

  private handleSystemMessage(raw: any): void {
    switch (raw.subtype) {
      case 'init':
        if (typeof raw.model === 'string' && raw.model) this.lastModel = claudeModelKey(raw.model)
        this.lastEffort = this.opts.effort
        this.emit('init', { session_id: this.sessionId, raw })
        this.emit('turn_started', { turn_id: raw.uuid, thread_id: this.sessionId })
        return
      case 'compact_boundary':
        this.emit('context_compacted', {
          threadId: raw.session_id ?? this.sessionId ?? undefined,
          sessionId: raw.session_id ?? this.sessionId ?? undefined,
          itemId: raw.uuid,
          phase: 'event',
          sourceMethod: 'claude_agent_sdk',
          sourceType: 'compact_boundary',
          preTokens: raw.compact_metadata?.pre_tokens,
          trigger: raw.compact_metadata?.trigger,
        })
        return
      case 'api_retry':
        log(`claude-agent-process: api retry attempt=${raw.attempt}/${raw.max_retries} status=${raw.error_status} error=${raw.error}`)
        return
      case 'permission_denied':
        log(`claude-agent-process: permission denied ${raw.tool_name} ${raw.tool_use_id}: ${raw.message}`)
        return
      default:
        return
    }
  }

  private handleAssistantMessage(raw: any): void {
    const message = raw.message
    if (typeof raw.uuid === 'string') this.lastAssistantUuid = raw.uuid
    if (typeof message?.model === 'string' && message.model) this.lastModel = claudeModelKey(message.model)
    const content = Array.isArray(message?.content) ? message.content : []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        const uuid = raw.uuid ?? message?.id
        this.emit('assistant_text', { uuid, text: block.text })
        this.emit('assistant_block_stop', { index: uuid })
      } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        this.emit('tool_use', { id: block.id, name: block.name, input: block.input ?? {} })
      }
    }
  }

  private handleUserMessage(raw: any): void {
    const content = Array.isArray(raw.message?.content) ? raw.message.content : []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      const toolResult = raw.tool_use_result
      const output = toolResult && typeof toolResult === 'object'
        ? [
            typeof toolResult.stdout === 'string' ? toolResult.stdout : '',
            typeof toolResult.stderr === 'string' ? toolResult.stderr : '',
          ].filter(Boolean).join('\n')
        : textFromToolResultContent(block.content)
      this.emit('tool_result', {
        tool_use_id: block.tool_use_id,
        content: output,
        is_error: block.is_error === true || toolResult?.interrupted === true,
      })
    }
  }

  private handleResultMessage(raw: any): void {
    if (typeof raw.session_id === 'string' && raw.session_id) this.sessionId = raw.session_id
    const usage = usageFromSdk(raw.usage)
    const total = totalUsageFromModelUsage(raw.modelUsage)
    this.lastUsage = usage
    this.lastTotalUsage = total.usage ?? usage
    this.lastContextWindow = total.contextWindow
    if (this.lastTotalUsage || this.lastUsage) {
      this.emit('token_usage', {
        usage: this.lastUsage,
        totalUsage: this.lastTotalUsage,
        contextWindow: this.lastContextWindow,
        threadId: this.sessionId ?? undefined,
        turnId: raw.uuid,
      })
    }
    const totalCost = typeof raw.total_cost_usd === 'number' && Number.isFinite(raw.total_cost_usd)
      ? raw.total_cost_usd
      : total.cost
    const costDelta = totalCost != null
      ? Math.max(0, totalCost - (this.lastTotalCostUsd ?? 0))
      : null
    if (totalCost != null) this.lastTotalCostUsd = totalCost
    const subtype = typeof raw.subtype === 'string' ? raw.subtype : raw.is_error ? 'error' : 'success'
    this.lastResult = {
      cost_usd: totalCost,
      cost_delta_usd: costDelta,
      duration_ms: typeof raw.duration_ms === 'number' ? raw.duration_ms : null,
      num_turns: typeof raw.num_turns === 'number' ? raw.num_turns : 1,
      usage: this.lastUsage,
      subtype,
      is_error: raw.is_error === true || subtype !== 'success',
    }
    this.emit('result', {
      subtype,
      is_error: this.lastResult.is_error,
      duration_ms: this.lastResult.duration_ms,
      usage: this.lastUsage,
    })
  }

  private failTurnStart(e: Error): void {
    this.lastResult = {
      cost_usd: null,
      cost_delta_usd: null,
      duration_ms: null,
      num_turns: null,
      usage: this.lastUsage,
      subtype: 'claude_turn_start_failed',
      is_error: true,
    }
    this.emit('result', {
      subtype: this.lastResult.subtype,
      is_error: true,
      duration_ms: null,
      usage: this.lastUsage,
      error: e.message,
    })
  }
}
