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
import { basename, delimiter, join } from 'node:path'
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
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
  appendSystemPrompt?: string
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

export interface CodexUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
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
  private currentTurnId: string | null = null

  sessionId: string | null = null
  lastAssistantUuid: string | null = null
  lastModel: string | null = null
  lastUsage: CodexUsage | null = null
  lastResult: CodexResultMeta = {
    cost_usd: null, cost_delta_usd: null, duration_ms: null, num_turns: null,
    usage: null, subtype: null, is_error: false,
  }
  lastContextWindow: number | null = null

  constructor(opts: SpawnOpts) {
    super()
    // EventEmitter treats unhandled `error` specially. We still expose it
    // for Session/schedule logging, but a direct utility script should not
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

    this.emit('raw', msg)
  }

  private handleNotification(method: string, params: any): void {
    switch (method) {
      case 'thread/started': {
        const thread = params.thread
        if (thread?.id) this.sessionId = thread.id
        return
      }
      case 'thread/settings/updated': {
        const settings = params.threadSettings
        if (typeof settings?.model === 'string') this.lastModel = settings.model
        return
      }
      case 'thread/tokenUsage/updated': {
        const total = params.tokenUsage?.last ?? params.tokenUsage?.total
        if (total) {
          this.lastUsage = {
            input_tokens: numberOrUndefined(total.inputTokens),
            output_tokens: numberOrUndefined(total.outputTokens),
            cache_read_input_tokens: numberOrUndefined(total.cachedInputTokens),
          }
          this.lastResult.usage = this.lastUsage
        }
        const ctx = params.tokenUsage?.modelContextWindow
        if (typeof ctx === 'number' && ctx > 0) this.lastContextWindow = ctx
        if (this.lastUsage) {
          this.emit('token_usage', {
            usage: this.lastUsage,
            contextWindow: this.lastContextWindow,
            threadId: params.threadId,
            turnId: params.turnId,
          })
        }
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
      case 'item/agentMessage/delta': {
        if (typeof params.delta === 'string' && params.delta.length > 0) {
          this.emit('assistant_text', { uuid: params.itemId, text: params.delta })
        }
        return
      }
      case 'item/started': {
        this.handleItemStarted(params.item)
        return
      }
      case 'item/completed': {
        this.handleItemCompleted(params.item)
        return
      }
      case 'mcpServer/startupStatus/updated': {
        log(`codex-process: mcp ${params.name} ${params.status}${params.error ? `: ${params.error}` : ''}`)
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
    this.emit('raw', { method, params })
  }

  private handleItemStarted(item: any): void {
    if (!item?.id) return
    const mapped = mapStartedItem(item, this.opts.workDir)
    if (!mapped) return
    this.emit('tool_use', { id: item.id, name: mapped.name, input: mapped.input })
  }

  private handleItemCompleted(item: any): void {
    if (!item?.id) return
    if (item.type === 'agentMessage') {
      this.lastAssistantUuid = item.id
      this.emit('assistant_block_stop', { index: item.id })
      return
    }
    const mapped = mapCompletedItem(item)
    if (!mapped) return
    this.emit('tool_result', {
      tool_use_id: item.id,
      content: mapped.output,
      is_error: mapped.isError,
    })
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
        log(`codex-process: unsupported server request ${req.method}; declining`)
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

  private async initializeAndStartThread(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'lodestar', version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })

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
    log(`codex-process: thread=${this.sessionId}`)
    this.emit('init', { session_id: this.sessionId, thread })
  }

  private threadParams(): Record<string, unknown> {
    const project = basename(this.opts.workDir)
    const effort = normalizeEffort(this.opts.effort)
    return {
      cwd: this.opts.workDir,
      runtimeWorkspaceRoots: [this.opts.workDir],
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'danger-full-access',
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...(effort ? { effort } : {}),
      ...(this.opts.appendSystemPrompt ? { developerInstructions: this.opts.appendSystemPrompt } : {}),
      config: {
        mcp_servers: {
          lodestar_schedule: {
            type: 'streamable_http',
            url: `http://127.0.0.1:${config.notify.port}/mcp/${encodeURIComponent(project)}`,
          },
        },
      },
      serviceName: 'lodestar',
    }
  }

  sendUserText(text: string, files: string[] = []): void {
    const fileHints = files.length ? files.map(f => `[file: ${f}]`).join(' ') + '\n\n' : ''
    void this.startTurn(fileHints + text).catch(e => this.failTurnStart(e))
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
    const effort = normalizeEffort(this.opts.effort)
    await this.request('turn/start', {
      threadId: this.sessionId,
      input: [{ type: 'text', text, text_elements: [] }],
      cwd: this.opts.workDir,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'dangerFullAccess' },
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...(effort ? { effort } : {}),
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
        this.respondError(requestId, payload?.denyMessage ?? 'unsupported approval request')
    }
  }

  sendToolResult(_toolUseId: string, _content: string, _isError = false): void {
    log('codex-process: sendToolResult ignored; Codex app-server server requests are answered via sendPermissionResponse')
  }

  sendHookResponse(requestId: string, output: object = {}): void {
    this.respond(requestId, output)
  }

  sendSetPermissionMode(_mode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'): void {
    // FullAccess migration uses approvalPolicy=never + dangerFullAccess for the thread.
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

function normalizeEffort(effort: SpawnOpts['effort']): 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  if (!effort) return undefined
  return effort === 'max' ? 'xhigh' : effort
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
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
