/**
 * Headless Claude Code subprocess + SDK control protocol over NDJSON.
 *
 * Spawned with:
 *   claude -p
 *     --input-format=stream-json
 *     --output-format=stream-json
 *     --verbose
 *     --permission-prompt-tool=stdio
 *     --permission-mode={mode}
 *     [--effort=max] [--model=...] [--append-system-prompt=...]
 *     [--resume <id> --resume-session-at <uuid>]
 *
 * Stdin / stdout are line-delimited JSON. Stdout flows assistant chunks,
 * tool_use, tool_result, control_request (can_use_tool / hook_callback)
 * and finally `result` per turn.  Stdin carries user messages and our
 * outbound control_responses + control_requests (Initialize / Interrupt /
 * SetPermissionMode).
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { log } from './log'

interface SpawnOpts {
  workDir: string
  resumeSessionId?: string
  resumeAtUuid?: string
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'max'
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

export class ClaudeProcess extends EventEmitter {
  private proc: ChildProcessByStdio<Writable, Readable, Readable>
  private stdoutBuf = ''
  private stderrBuf = ''
  private requestCounter = 0
  private alive = true
  private expectedExit = false
  sessionId: string | null = null
  lastAssistantUuid: string | null = null

  constructor(opts: SpawnOpts) {
    super()
    const claudeBin = join(homedir(), '.local', 'bin', 'claude')
    const args = [
      '-p',
      '--input-format=stream-json',
      '--output-format=stream-json',
      '--verbose',
      '--permission-prompt-tool=stdio',
      `--permission-mode=${opts.permissionMode ?? 'default'}`,
    ]
    if (opts.model) args.push('--model', opts.model)
    if (opts.effort) args.push('--effort', opts.effort)
    if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt)
    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId)
      if (opts.resumeAtUuid) args.push('--resume-session-at', opts.resumeAtUuid)
    }

    log(`claude-process: spawn ${claudeBin} (cwd=${opts.workDir})`)
    this.proc = spawn(claudeBin, args, {
      cwd: opts.workDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NPM_CONFIG_LOGLEVEL: 'error',
        PATH: [
          join(homedir(), '.local', 'bin'),
          join(homedir(), '.bun', 'bin'),
          join(homedir(), '.local', 'npm-global', 'bin'),
          '/usr/local/bin', '/usr/bin', '/bin',
        ].join(':'),
      },
    }) as ChildProcessByStdio<Writable, Readable, Readable>

    this.proc.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk))
    this.proc.stderr.on('data', (chunk: Buffer) => this.onStderr(chunk))
    this.proc.on('exit', (code, signal) => {
      this.alive = false
      log(`claude-process: exited code=${code} signal=${signal} expected=${this.expectedExit}`)
      this.emit('exit', { code, signal, expected: this.expectedExit })
    })
    this.proc.on('error', err => {
      log(`claude-process: spawn error: ${err}`)
      this.emit('error', err)
    })
  }

  // ── Stream parsers ─────────────────────────────────────────────────
  private onStdout(chunk: Buffer): void {
    this.stdoutBuf += chunk.toString()
    let nl: number
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim()
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        this.handleMessage(msg)
      } catch (e) {
        log(`claude-process: bad json: ${line.slice(0, 200)} (${e})`)
      }
    }
  }

  private onStderr(chunk: Buffer): void {
    this.stderrBuf += chunk.toString()
    let nl: number
    while ((nl = this.stderrBuf.indexOf('\n')) >= 0) {
      const line = this.stderrBuf.slice(0, nl)
      this.stderrBuf = this.stderrBuf.slice(nl + 1)
      if (line.trim()) log(`claude-process[stderr]: ${line}`)
    }
  }

  private handleMessage(msg: any): void {
    const type = msg.type
    if (type === 'system' && msg.subtype === 'init') {
      this.sessionId = msg.session_id ?? null
      log(`claude-process: session=${this.sessionId}`)
      this.emit('init', msg)
      return
    }
    if (type === 'control_request') {
      const req = msg.request
      if (req?.subtype === 'can_use_tool') {
        this.emit('can_use_tool', {
          request_id: msg.request_id,
          tool_name: req.tool_name,
          input: req.input,
          permission_suggestions: req.permission_suggestions,
          blocked_paths: req.blocked_paths,
          tool_use_id: req.tool_use_id,
        } as CanUseToolRequest)
        return
      }
      if (req?.subtype === 'hook_callback') {
        this.emit('hook_callback', {
          request_id: msg.request_id,
          callback_id: req.callback_id,
          input: req.input,
          tool_use_id: req.tool_use_id,
        } as HookCallbackRequest)
        return
      }
      log(`claude-process: unknown control_request subtype=${req?.subtype}`)
      return
    }
    if (type === 'control_response') {
      this.emit('control_response', msg)
      return
    }
    if (type === 'assistant') {
      const content = msg.message?.content ?? []
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          this.emit('assistant_text', { uuid: msg.uuid, text: block.text })
        } else if (block.type === 'tool_use') {
          this.emit('tool_use', { uuid: msg.uuid, id: block.id, name: block.name, input: block.input })
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          this.emit('thinking', { uuid: msg.uuid, text: block.thinking })
        }
      }
      if (msg.uuid) this.lastAssistantUuid = msg.uuid
      return
    }
    if (type === 'user') {
      const content = msg.message?.content ?? []
      for (const block of content) {
        if (block.type === 'tool_result') {
          this.emit('tool_result', {
            tool_use_id: block.tool_use_id,
            content: block.content,
            is_error: block.is_error ?? false,
          })
        }
      }
      return
    }
    if (type === 'result') {
      this.emit('result', msg)
      return
    }
    this.emit('raw', msg)
  }

  private write(obj: object): void {
    if (!this.alive) {
      log(`claude-process: write to dead process: ${JSON.stringify(obj).slice(0, 200)}`)
      return
    }
    try {
      this.proc.stdin.write(JSON.stringify(obj) + '\n')
    } catch (e) { log(`claude-process: stdin write failed: ${e}`) }
  }

  // ── Outbound control ────────────────────────────────────────────────
  sendInitialize(hooks: Record<string, any> = {}): void {
    this.write({
      type: 'control_request',
      request_id: `init-${++this.requestCounter}`,
      request: { subtype: 'initialize', hooks },
    })
  }

  sendUserText(text: string, files: string[] = []): void {
    const fileHints = files.length ? files.map(f => `[file: ${f}]`).join(' ') + '\n\n' : ''
    this.write({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: fileHints + text }],
      },
    })
  }

  sendInterrupt(): void {
    this.write({
      type: 'control_request',
      request_id: `int-${++this.requestCounter}`,
      request: { subtype: 'interrupt' },
    })
  }

  sendPermissionResponse(requestId: string, decision: 'allow' | 'deny', updatedInput?: any): void {
    this.write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision,
            ...(updatedInput ? { permissionDecisionInput: updatedInput } : {}),
          },
        },
      },
    })
  }

  sendHookResponse(requestId: string, output: object = {}): void {
    this.write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: output,
      },
    })
  }

  sendSetPermissionMode(mode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'): void {
    this.write({
      type: 'control_request',
      request_id: `mode-${++this.requestCounter}`,
      request: { subtype: 'set_permission_mode', mode },
    })
  }

  // ── Lifecycle ───────────────────────────────────────────────────────
  isAlive(): boolean { return this.alive }

  async kill(timeoutMs = 5000): Promise<void> {
    if (!this.alive) return
    this.expectedExit = true
    log(`claude-process: SIGTERM (timeout=${timeoutMs}ms)`)
    try { this.proc.kill('SIGTERM') } catch {}
    const start = Date.now()
    while (this.alive && Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 100))
    }
    if (this.alive) {
      log('claude-process: SIGKILL (graceful timeout)')
      try { this.proc.kill('SIGKILL') } catch {}
    }
  }
}
