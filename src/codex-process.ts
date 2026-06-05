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

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { config } from './config'
import { log } from './log'

export function resolveCodexBin(): string {
  if (process.platform !== 'win32') {
    const pinned = join(homedir(), '.local', 'npm-global', 'bin', 'codex')
    if (existsSync(pinned)) return pinned
    const local = join(homedir(), '.local', 'bin', 'codex')
    if (existsSync(local)) return local
  }
  return whichCodex() ?? 'codex'
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

function buildSpawnPath(): string {
  if (process.platform === 'win32') return process.env.PATH ?? ''
  return [
    join(homedir(), '.local', 'npm-global', 'bin'),
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.bun', 'bin'),
    '/usr/local/bin', '/usr/bin', '/bin',
  ].join(delimiter)
}

export interface SpawnOpts {
  workDir: string
  resumeSessionId?: string
  model?: string
  effort: CodexReasoningEffort
  appendSystemPrompt?: string
}

export type CodexReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
export interface CodexReasoningEffortOption {
  reasoningEffort: CodexReasoningEffort
  description: string
}
export const CODEX_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
export const CODEX_EFFORT: CodexReasoningEffort = 'xhigh'

export function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return typeof value === 'string' && CODEX_REASONING_EFFORTS.includes(value as CodexReasoningEffort)
}

export interface CanUseToolRequest {
  request_id: string
  tool_name: string
  input: any
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
}

type ServerRequestState = {
  id: string | number
  method: string
  params: any
}

export class CodexProcess extends EventEmitter {
  private proc: ChildProcessByStdio<Writable, Readable, Readable>
  private stdoutBuf = ''
  private stderrBuf = ''
  private requestCounter = 0
  private pending = new Map<string | number, PendingRequest>()
  private serverRequests = new Map<string | number, ServerRequestState>()
  private alive = true
  private expectedExit = false
  private opts: SpawnOpts
  private readyPromise: Promise<void> | null = null
  private catalogInitPromise: Promise<void> | null = null
  private currentTurnId: string | null = null

  sessionId: string | null = null
  lastAssistantUuid: string | null = null
  lastModel: string | null = null
  lastEffort: CodexReasoningEffort | null = null
  lastUsage: CodexUsage | null = null
  lastTotalUsage: CodexUsage | null = null
  lastResult: CodexResultMeta = {
    cost_usd: null, cost_delta_usd: null, duration_ms: null, num_turns: null,
    usage: null, subtype: null, is_error: false,
  }
  lastContextWindow: number | null = null

  constructor(opts: SpawnOpts) {
    super()
    // EventEmitter treats unhandled `error` specially. We still expose it
    // for Session logging, but a direct utility script should not
    // crash before it can surface the app-server failure.
    this.on('error', () => {})
    this.opts = opts
    const codexBin = resolveCodexBin()
    const args = ['app-server', '--listen', 'stdio://']
    log(`codex-process: spawn ${codexBin} app-server (cwd=${opts.workDir})`)
    this.proc = spawn(codexBin, args, {
      cwd: opts.workDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: {
        ...(process.env as Record<string, string>),
        NPM_CONFIG_LOGLEVEL: 'error',
        PATH: buildSpawnPath(),
        ...config.codex.env,
      },
    }) as ChildProcessByStdio<Writable, Readable, Readable>

    this.proc.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk))
    this.proc.stderr.on('data', (chunk: Buffer) => this.onStderr(chunk))
    this.proc.on('exit', (code, signal) => {
      this.alive = false
      for (const [id, pending] of this.pending) {
        pending.reject(new Error(`codex app-server exited before ${pending.method} response (id=${id})`))
      }
      this.pending.clear()
      log(`codex-process: exited code=${code} signal=${signal} expected=${this.expectedExit}`)
      this.emit('exit', { code, signal, expected: this.expectedExit })
    })
    this.proc.on('error', err => {
      log(`codex-process: spawn error: ${err}`)
      this.emit('error', err)
    })
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuf += chunk.toString()
    let nl: number
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim()
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      if (!line) continue
      try {
        this.handleMessage(JSON.parse(line))
      } catch (e) {
        log(`codex-process: bad json: ${line.slice(0, 200)} (${e})`)
      }
    }
  }

  private onStderr(chunk: Buffer): void {
    this.stderrBuf += chunk.toString()
    let nl: number
    while ((nl = this.stderrBuf.indexOf('\n')) >= 0) {
      const line = this.stderrBuf.slice(0, nl)
      this.stderrBuf = this.stderrBuf.slice(nl + 1)
      if (line.trim()) log(`codex-process[stderr]: ${line}`)
    }
  }

  private handleMessage(msg: any): void {
    if (Object.prototype.hasOwnProperty.call(msg, 'id') && !msg.method) {
      const pending = this.pending.get(msg.id)
      if (!pending) {
        log(`codex-process: response for unknown id=${msg.id}`)
        return
      }
      this.pending.delete(msg.id)
      if (msg.error) {
        pending.reject(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)))
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
      const notice = this.withSessionId(compaction)
      logContextCompactionPayload(compaction.sourceMethod ?? 'raw_message', msg, notice)
      this.emit('context_compacted', notice)
      return
    }

    logUnhandledAppServerPayload('RAW_MESSAGE', msg)
    this.emit('raw', msg)
  }

  private handleNotification(method: string, params: any): void {
    const compaction = contextCompactionNoticeFromNotification(method, params)
    if (compaction) {
      const notice = this.withSessionId(compaction)
      logContextCompactionPayload(method, params, notice)
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
          log('codex-process: tokenUsage notification missing last breakdown')
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
        this.currentTurnId = params.turn?.id ?? null
        this.emit('turn_started', {
          turn_id: this.currentTurnId,
          thread_id: params.threadId ?? this.sessionId,
        })
        return
      }
      case 'turn/completed': {
        const turn = params.turn ?? {}
        const status = turn.status
        const isError = status === 'failed' || !!turn.error
        const subtype = isError ? (turn.error?.type ?? turn.error?.message ?? 'failed') : 'success'
        this.lastResult = {
          cost_usd: null,
          cost_delta_usd: null,
          duration_ms: typeof turn.durationMs === 'number' ? turn.durationMs : null,
          num_turns: 1,
          usage: this.lastUsage,
          subtype,
          is_error: isError,
        }
        this.currentTurnId = null
        this.emit('result', { subtype, is_error: isError, duration_ms: this.lastResult.duration_ms, usage: this.lastUsage })
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
          log('codex-process: thread/goal/updated missing goal')
        }
        return
      }
      case 'thread/goal/cleared': {
        this.emit('thread_goal_cleared', params)
        return
      }
      case 'item/agentMessage/delta': {
        if (typeof params.delta === 'string' && params.delta.length > 0) {
          this.emit('assistant_text', { uuid: params.itemId, text: params.delta })
        } else {
          logUnhandledAppServerPayload('AGENT_MESSAGE_DELTA_EMPTY', { method, params })
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
        log(`codex-process: mcp ${params.name} ${params.status}${params.error ? `: ${params.error}` : ''}`)
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
        log(`codex-process: ${method}: ${params.summary ?? params.message ?? JSON.stringify(params).slice(0, 200)}`)
        return
      }
      case 'error': {
        log(`codex-process: server error: ${JSON.stringify(params).slice(0, 500)}`)
        this.emit('error', new Error(params.message ?? params.summary ?? 'codex app-server error'))
        return
      }
    }
    logUnhandledAppServerPayload('NOTIFICATION', { method, params })
    this.emit('raw', { method, params })
  }

  private handleItemStarted(params: any): void {
    const item = params?.item
    if (!item?.id) {
      logUnhandledAppServerPayload('ITEM_STARTED_MISSING_ID', { method: 'item/started', params })
      return
    }
    const mapped = mapStartedItem(item, this.opts.workDir)
    if (!mapped) {
      logUnhandledAppServerPayload('ITEM_STARTED_UNMAPPED', { method: 'item/started', params })
      return
    }
    this.emit('tool_use', { id: item.id, name: mapped.name, input: mapped.input })
  }

  private handleItemCompleted(params: any): void {
    const item = params?.item
    if (!item?.id) {
      logUnhandledAppServerPayload('ITEM_COMPLETED_MISSING_ID', { method: 'item/completed', params })
      return
    }
    if (item.type === 'agentMessage') {
      this.lastAssistantUuid = item.id
      this.emit('assistant_block_stop', { index: item.id })
      return
    }
    const mapped = mapCompletedItem(item)
    if (!mapped) {
      logUnhandledAppServerPayload('ITEM_COMPLETED_UNMAPPED', { method: 'item/completed', params })
      return
    }
    this.emit('tool_result', {
      tool_use_id: item.id,
      content: mapped.output,
      is_error: mapped.isError,
    })
  }

  private withSessionId(notice: ContextCompactedNotification): ContextCompactedNotification {
    const sessionId = notice.sessionId ?? this.sessionId ?? undefined
    return sessionId ? { ...notice, sessionId } : notice
  }

  private handleServerRequest(req: any): void {
    const requestId = String(req.id)
    this.serverRequests.set(requestId, { id: req.id, method: req.method, params: req.params })
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
              : [{ label: '自定义回答', description: q.isSecret ? '请直接在群里回复' : '可直接在群里回复' }],
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
        logUnhandledAppServerPayload('SERVER_REQUEST_UNSUPPORTED', req)
        this.respondError(requestId, `unsupported server request: ${req.method}`)
      }
    }
  }

  private write(obj: object): void {
    if (!this.alive) {
      log(`codex-process: write to dead process: ${JSON.stringify(obj).slice(0, 200)}`)
      return
    }
    try {
      this.proc.stdin.write(JSON.stringify(obj) + '\n')
    } catch (e) {
      log(`codex-process: stdin write failed: ${e}`)
    }
  }

  private request(method: string, params: any): Promise<any> {
    const id = ++this.requestCounter
    this.write({ id, method, params })
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
    })
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
    this.write({ id: req?.id ?? id, error: { message } })
  }

  sendInitialize(): void {
    if (!this.readyPromise) {
      const ready = this.initializeAndStartThread()
      ready.catch(e => {
        log(`codex-process: initialize failed: ${e}`)
        this.emit('error', e)
      })
      this.readyPromise = ready
    }
  }

  private initializeParams(): Record<string, unknown> {
    return {
      clientInfo: { name: 'lodestar', version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }
  }

  private async ensureCatalogReady(): Promise<void> {
    if (this.readyPromise) {
      await this.readyPromise
      return
    }
    if (!this.catalogInitPromise) {
      this.catalogInitPromise = this.request('initialize', this.initializeParams()).then(() => {})
    }
    await this.catalogInitPromise
  }

  private async initializeAndStartThread(): Promise<void> {
    await this.request('initialize', this.initializeParams())

    const params = this.threadParams()
    const res = this.opts.resumeSessionId
      ? await this.request('thread/resume', {
          threadId: this.opts.resumeSessionId,
          ...params,
          excludeTurns: true,
          persistExtendedHistory: false,
        })
      : await this.request('thread/start', {
          ...params,
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        })
    const thread = res?.thread
    this.sessionId = thread?.id ?? this.opts.resumeSessionId ?? null
    if (res?.model) this.lastModel = res.model
    if (isCodexReasoningEffort(res?.reasoningEffort)) this.lastEffort = res.reasoningEffort
    else this.lastEffort = this.opts.effort
    log(`codex-process: thread=${this.sessionId}`)
    this.emit('init', { session_id: this.sessionId, thread })
  }

  private threadParams(): Record<string, unknown> {
    return {
      cwd: this.opts.workDir,
      runtimeWorkspaceRoots: [this.opts.workDir],
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ...(this.opts.model ? { model: this.opts.model } : {}),
      effort: this.opts.effort,
      ...(this.opts.appendSystemPrompt ? { developerInstructions: this.opts.appendSystemPrompt } : {}),
      serviceName: 'lodestar',
    }
  }

  sendUserText(text: string, files: string[] = []): void {
    const fileHints = files.length ? files.map(f => `[file: ${f}]`).join(' ') + '\n\n' : ''
    void this.startTurn(fileHints + text).catch(e => this.failTurnStart(e))
  }

  async listModels(): Promise<CodexModel[]> {
    await this.ensureCatalogReady()
    const models: CodexModel[] = []
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
      cursor = typeof res?.nextCursor === 'string' && res.nextCursor ? res.nextCursor : null
    } while (cursor)
    return models
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

  async setModelSettings(model: string, effort: CodexReasoningEffort): Promise<void> {
    if (!model.trim()) throw new Error('empty model')
    if (!isCodexReasoningEffort(effort)) throw new Error(`invalid reasoning effort: ${String(effort)}`)
    if (!this.readyPromise) throw new Error('codex thread not initialized')
    await this.readyPromise
    if (!this.sessionId) throw new Error('codex thread not initialized')
    await this.request('thread/settings/update', {
      threadId: this.sessionId,
      model,
      effort,
    })
    this.opts.model = model
    this.opts.effort = effort
    this.lastModel = model
    this.lastEffort = effort
  }

  async setModel(model: string): Promise<void> {
    await this.setModelSettings(model, this.opts.effort)
  }

  private failTurnStart(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e)
    log(`codex-process: turn/start failed: ${message}`)
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
    this.emit('result', {
      subtype: this.lastResult.subtype,
      is_error: true,
      duration_ms: null,
      usage: this.lastUsage,
      error: message,
    })
  }

  private async startTurn(text: string): Promise<void> {
    if (!this.readyPromise) this.sendInitialize()
    await this.readyPromise
    if (!this.sessionId) throw new Error('codex thread not initialized')
    await this.request('turn/start', {
      threadId: this.sessionId,
      input: [{ type: 'text', text, text_elements: [] }],
      cwd: this.opts.workDir,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
      ...(this.opts.model ? { model: this.opts.model } : {}),
      effort: this.opts.effort,
    })
  }

  sendInterrupt(): void {
    if (!this.sessionId || !this.currentTurnId) return
    void this.request('turn/interrupt', { threadId: this.sessionId, turnId: this.currentTurnId })
      .catch(e => log(`codex-process: interrupt failed: ${e}`))
  }

  sendPermissionResponse(
    requestId: string | number,
    decision: 'allow' | 'deny',
    payload?: { updatedInput?: Record<string, unknown>; denyMessage?: string },
  ): void {
    const req = this.serverRequests.get(String(requestId))
    if (!req) {
      log(`codex-process: permission response for unknown request ${requestId}`)
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
        logUnhandledAppServerPayload('APPROVAL_RESPONSE_UNSUPPORTED', {
          requestId,
          method: req.method,
          params: req.params,
          decision,
          payload,
        })
        this.respondError(requestId, payload?.denyMessage ?? 'unsupported approval request')
    }
  }

  sendToolResult(_toolUseId: string, _content: string, _isError = false): void {
    log('codex-process: sendToolResult ignored; Codex app-server server requests are answered via sendPermissionResponse')
  }

  sendHookResponse(requestId: string, output: object = {}): void {
    this.respond(requestId, output)
  }

  isAlive(): boolean { return this.alive }

  async kill(timeoutMs = 5000): Promise<void> {
    if (!this.alive) return
    this.expectedExit = true
    log(`codex-process: SIGTERM (timeout=${timeoutMs}ms)`)
    try { this.proc.kill('SIGTERM') } catch {}
    const start = Date.now()
    while (this.alive && Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 100))
    }
    if (this.alive) {
      log('codex-process: SIGKILL (graceful timeout)')
      try { this.proc.kill('SIGKILL') } catch {}
    }
  }
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function anyUsageValue(usage: CodexUsage): boolean {
  return Object.values(usage).some(v => typeof v === 'number' && Number.isFinite(v))
}

function nestedNumber(obj: Record<string, unknown> | null, key: string): number | undefined {
  return obj ? numberOrUndefined(obj[key]) : undefined
}

export function usageFromTokenUsagePayload(raw: unknown): CodexUsage | null {
  const obj = objectOrNull(raw)
  if (!obj) return null
  const inputDetails = objectOrNull(obj.inputTokensDetails) ?? objectOrNull(obj.input_tokens_details)
  const outputDetails = objectOrNull(obj.outputTokensDetails) ?? objectOrNull(obj.output_tokens_details)
  const usage: CodexUsage = {
    total_tokens: numberOrUndefined(obj.totalTokens ?? obj.total_tokens),
    input_tokens: numberOrUndefined(obj.inputTokens ?? obj.input_tokens),
    output_tokens: numberOrUndefined(obj.outputTokens ?? obj.output_tokens),
    reasoning_output_tokens: numberOrUndefined(
      obj.reasoningOutputTokens ??
      obj.reasoning_output_tokens ??
      nestedNumber(outputDetails, 'reasoningTokens') ??
      nestedNumber(outputDetails, 'reasoning_tokens'),
    ),
    cache_creation_input_tokens: numberOrUndefined(
      obj.cacheCreationInputTokens ?? obj.cache_creation_input_tokens,
    ),
    cache_read_input_tokens: numberOrUndefined(
      obj.cachedInputTokens ??
      obj.cached_input_tokens ??
      obj.cacheReadInputTokens ??
      obj.cache_read_input_tokens ??
      nestedNumber(inputDetails, 'cachedTokens') ??
      nestedNumber(inputDetails, 'cached_tokens'),
    ),
  }
  return anyUsageValue(usage) ? usage : null
}

export function diffUsageTotals(
  total: CodexUsage | null | undefined,
  baseline: CodexUsage | null | undefined,
): CodexUsage | null {
  const deltaField = (key: keyof CodexUsage): number | undefined => {
    const totalVal = numberOrUndefined(total?.[key])
    const baselineVal = numberOrUndefined(baseline?.[key])
    if (totalVal === undefined && baselineVal === undefined) return undefined
    return Math.max(0, (totalVal ?? 0) - (baselineVal ?? 0))
  }
  const usage: CodexUsage = {
    total_tokens: deltaField('total_tokens'),
    input_tokens: deltaField('input_tokens'),
    output_tokens: deltaField('output_tokens'),
    reasoning_output_tokens: deltaField('reasoning_output_tokens'),
    cache_creation_input_tokens: deltaField('cache_creation_input_tokens'),
    cache_read_input_tokens: deltaField('cache_read_input_tokens'),
  }
  return anyUsageValue(usage) ? usage : null
}

export function effectiveTurnTokens(usage: CodexUsage | null | undefined): number | null {
  if (!usage) return null
  return (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0)
}

const COMPACTION_METHODS = new Set([
  'thread/compacted',
  'context/compacted',
  'context_compacted',
  'contextCompacted',
])

const COMPACTION_TYPES = new Set([
  'compacted',
  'compaction',
  'compaction_trigger',
  'context_compacted',
  'context_compaction',
  'contextCompaction',
  'ContextCompaction',
])

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

function objectOrNull(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === 'object' ? v as Record<string, unknown> : null
}

const COMPACTION_LOG_JSON_CHARS = 200_000
const COMPACTION_LOG_STRING_CHARS = 50_000
const COMPACTION_LOG_PATHS = 400

function logValue(v: unknown): string {
  if (v == null || v === '') return '-'
  return String(v).replace(/\s+/g, ' ').slice(0, 300)
}

function formatKeyList(v: Record<string, unknown> | null): string {
  if (!v) return '[]'
  const keys = Object.keys(v)
  const shown = keys.slice(0, 80)
  const suffix = keys.length > shown.length ? `,...+${keys.length - shown.length}` : ''
  return `[${shown.join(',')}${suffix}]`
}

function formatPathList(paths: string[]): string {
  const shown = paths.slice(0, COMPACTION_LOG_PATHS)
  const suffix = paths.length > shown.length ? `,...+${paths.length - shown.length}` : ''
  return `[${shown.join(',')}${suffix}]`
}

function payloadItem(rawPayload: unknown): Record<string, unknown> | null {
  const root = objectOrNull(rawPayload)
  if (!root) return null
  const event = objectOrNull(root.event)
  const payload = objectOrNull(root.payload)
  return objectOrNull(root.item) ??
    objectOrNull(root.responseItem) ??
    objectOrNull(root.rawItem) ??
    objectOrNull(event?.item) ??
    objectOrNull(event?.responseItem) ??
    objectOrNull(event?.rawItem) ??
    objectOrNull(payload?.item) ??
    objectOrNull(payload?.responseItem) ??
    objectOrNull(payload?.rawItem) ??
    (compactionTypeOf(root.type) ? root : null) ??
    (event && compactionTypeOf(event.type) ? event : null) ??
    (payload && compactionTypeOf(payload.type) ? payload : null)
}

function keyPaths(rawPayload: unknown): string[] {
  const paths: string[] = []
  const seen = new WeakSet<object>()
  const visit = (value: unknown, path: string, depth: number) => {
    if (paths.length >= COMPACTION_LOG_PATHS || depth > 6) return
    if (Array.isArray(value)) {
      if (path) paths.push(`${path}[]`)
      if (value.length > 0) visit(value[0], path ? `${path}[]` : '[]', depth + 1)
      return
    }
    if (value == null || typeof value !== 'object') return
    if (seen.has(value)) return
    seen.add(value)
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (paths.length >= COMPACTION_LOG_PATHS) return
      const childPath = path ? `${path}.${key}` : key
      paths.push(childPath)
      visit((value as Record<string, unknown>)[key], childPath, depth + 1)
    }
  }
  visit(rawPayload, '', 0)
  return paths
}

function safeJsonForCompactionLog(value: unknown): string {
  const seen = new WeakSet<object>()
  let json: string
  try {
    json = JSON.stringify(value, (_key, v) => {
      if (typeof v === 'bigint') return `${v.toString()}n`
      if (typeof v === 'string' && v.length > COMPACTION_LOG_STRING_CHARS) {
        return `${v.slice(0, COMPACTION_LOG_STRING_CHARS)}...<truncated ${v.length - COMPACTION_LOG_STRING_CHARS} chars>`
      }
      if (v != null && typeof v === 'object') {
        if (seen.has(v)) return '[Circular]'
        seen.add(v)
      }
      return v
    }) ?? String(value)
  } catch (e) {
    json = `<unserializable: ${e}>`
  }
  if (json.length > COMPACTION_LOG_JSON_CHARS) {
    return `${json.slice(0, COMPACTION_LOG_JSON_CHARS)}...<truncated ${json.length - COMPACTION_LOG_JSON_CHARS} chars>`
  }
  return json
}

function logUnhandledAppServerPayload(reason: string, payload: unknown): void {
  const root = objectOrNull(payload)
  const params = root ? objectOrNull(root.params) : null
  const item = root ? objectOrNull(root.item) ?? objectOrNull(params?.item) : null
  const method = root ? stringOrUndefined(root.method) ?? '-' : '-'
  log([
    `codex-process: APP_SERVER_UNHANDLED_${reason}`,
    `method=${logValue(method)}`,
    `rootKeys=${formatKeyList(root)}`,
    `itemKeys=${formatKeyList(item)}`,
    `payload=${safeJsonForCompactionLog(payload)}`,
  ].join(' '))
}

function logContextCompactionPayload(
  method: string,
  rawPayload: unknown,
  notice: ContextCompactedNotification,
): void {
  const root = objectOrNull(rawPayload)
  const item = payloadItem(rawPayload)
  const base = [
    `phase=${logValue(notice.phase ?? 'event')}`,
    `method=${logValue(method)}`,
    `sourceMethod=${logValue(notice.sourceMethod)}`,
    `sourceType=${logValue(notice.sourceType)}`,
    `sessionId=${logValue(notice.sessionId)}`,
    `threadId=${logValue(notice.threadId)}`,
    `turnId=${logValue(notice.turnId)}`,
    `itemId=${logValue(notice.itemId)}`,
  ].join(' ')
  log(`codex-process: CONTEXT_COMPACTION_EVENT ${base} rootKeys=${formatKeyList(root)} itemKeys=${formatKeyList(item)}`)
  log(`codex-process: CONTEXT_COMPACTION_PATHS ${base} paths=${formatPathList(keyPaths(rawPayload))}`)
  if (item) {
    log(`codex-process: CONTEXT_COMPACTION_ITEM ${base} item=${safeJsonForCompactionLog(item)}`)
  }
  log(`codex-process: CONTEXT_COMPACTION_PAYLOAD ${base} payload=${safeJsonForCompactionLog(rawPayload)}`)
}

function compactionTypeOf(v: unknown): string | null {
  if (typeof v !== 'string') return null
  return COMPACTION_TYPES.has(v) ? v : null
}

function compactionPhase(sourceType: string | null, method: string): 'start' | 'end' | 'event' {
  if (method === 'item/started') return 'start'
  if (method === 'item/completed' || method === 'rawResponseItem/completed') return 'end'
  if (sourceType === 'compacted') return 'start'
  if (sourceType === 'context_compacted' || COMPACTION_METHODS.has(method)) return 'end'
  return 'event'
}

/** Codex exposes context compaction through more than one surface:
 * `thread/compacted` notifications in the app-server protocol, raw response
 * items in newer builds, and `event_msg {type:"context_compacted"}` in the
 * persisted rollout stream. Match only structured type/method fields; never
 * scan free-form text, because prompts and instructions may legitimately
 * mention compaction without an event having occurred. */
export function contextCompactionNoticeFromNotification(
  method: string,
  params: unknown,
): ContextCompactedNotification | null {
  return contextCompactionNoticeFromObject(method, objectOrNull(params) ?? {})
}

export function contextCompactionNoticeFromMessage(msg: unknown): ContextCompactedNotification | null {
  const root = objectOrNull(msg)
  if (!root) return null
  const method = stringOrUndefined(root.method) ?? stringOrUndefined(root.type) ?? 'raw_message'
  return contextCompactionNoticeFromObject(method, root)
}

function contextCompactionNoticeFromObject(
  method: string,
  root: Record<string, unknown>,
): ContextCompactedNotification | null {
  const payload = objectOrNull(root.payload)
  const candidates = [
    root,
    objectOrNull(root.event),
    payload,
    objectOrNull(root.item),
    objectOrNull(root.responseItem),
    objectOrNull(root.rawItem),
  ].filter((v): v is Record<string, unknown> => v != null)

  let sourceType: string | null = null
  for (const candidate of candidates) {
    sourceType = compactionTypeOf(candidate.type)
    if (sourceType) break
  }

  if (!COMPACTION_METHODS.has(method) && !sourceType) return null

  const rootItem = objectOrNull(root.item) ?? objectOrNull(root.responseItem) ?? objectOrNull(root.rawItem)
  const data = sourceType === 'compacted' && payload
    ? payload
    : rootItem && compactionTypeOf(rootItem.type)
      ? rootItem
      : root
  const item = objectOrNull(data.item) ?? objectOrNull(data.responseItem) ?? objectOrNull(data.rawItem) ?? rootItem ?? {}
  return {
    ...data,
    threadId:
      stringOrUndefined(data.threadId) ??
      stringOrUndefined(data.thread_id) ??
      stringOrUndefined(root.threadId) ??
      stringOrUndefined(root.thread_id),
    turnId:
      stringOrUndefined(data.turnId) ??
      stringOrUndefined(data.turn_id) ??
      stringOrUndefined(root.turnId) ??
      stringOrUndefined(root.turn_id),
    itemId:
      stringOrUndefined(data.itemId) ??
      stringOrUndefined(data.item_id) ??
      stringOrUndefined(item.id) ??
      stringOrUndefined(item.itemId) ??
      stringOrUndefined(item.item_id),
    timestamp: stringOrUndefined(root.timestamp) ?? stringOrUndefined(data.timestamp),
    recordType: stringOrUndefined(root.type),
    phase: compactionPhase(sourceType, method),
    sourceMethod: method,
    sourceType: sourceType ?? method,
  }
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
      return { name: 'ImageGeneration', input: { status: item.status, revisedPrompt: item.revisedPrompt } }
    case 'collabAgentToolCall':
      return { name: 'Agent', input: { tool: item.tool, prompt: item.prompt, model: item.model } }
  }
  return null
}

function mapCompletedItem(item: any): { output: string; isError: boolean } | null {
  switch (item.type) {
    case 'commandExecution':
      return {
        output: item.aggregatedOutput ?? '',
        isError: item.exitCode != null && item.exitCode !== 0,
      }
    case 'fileChange':
      return { output: JSON.stringify(item.changes ?? [], null, 2), isError: item.status === 'failed' }
    case 'mcpToolCall':
      return {
        output: item.error ? JSON.stringify(item.error, null, 2) : JSON.stringify(item.result ?? null, null, 2),
        isError: !!item.error,
      }
    case 'dynamicToolCall':
      return {
        output: JSON.stringify(item.contentItems ?? [], null, 2),
        isError: item.success === false,
      }
    case 'webSearch':
      return { output: JSON.stringify(item.action ?? {}, null, 2), isError: false }
    case 'imageGeneration':
      return { output: item.savedPath ?? item.result ?? '', isError: item.status === 'failed' }
    case 'collabAgentToolCall':
      return { output: JSON.stringify(item.agentsStates ?? {}, null, 2), isError: item.status === 'failed' }
  }
  return null
}
