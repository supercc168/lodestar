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
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { config } from './config'
import { log } from './log'

/** Locate the headless `claude` binary in a way that survives the
 * Linux dev box (~/.local/bin/claude pinned via `bun add -g`) AND a
 * Windows end-user install (claude.cmd dropped by `npm i -g
 * @anthropic-ai/claude-code` under %APPDATA%\npm). Linux/Mac keep the
 * pinned absolute path so spawn doesn't pay a PATH walk per turn; on
 * Windows (or if the pinned binary is gone) we fall back to Bun.which,
 * and finally to the bare name so spawn surfaces a clean ENOENT. */
export function resolveClaudeBin(): string {
  if (process.platform !== 'win32') {
    const pinned = join(homedir(), '.local', 'bin', 'claude')
    if (existsSync(pinned)) return pinned
  }
  return whichClaude() ?? 'claude'
}

/** Resolve HOW to spawn claude. On unix it's just the binary. On Windows the
 * npm-global `claude` is a `claude.cmd` shim, and Node — since the
 * CVE-2024-27980 fix (18.20.2+ / 20.12.2+) — throws `spawn EINVAL` on a
 * `.cmd`/`.bat` without `shell:true`; and `shell:true` would mangle our
 * multi-line --append-system-prompt and --mcp-config JSON via cmd.exe. So
 * resolve the shim to the REAL target and spawn that directly.
 * @anthropic-ai/claude-code 2.x ships a native `bin/claude.exe` (NOT a
 * cli.js) — spawning the .exe is fine (EINVAL only bites .cmd/.bat). We read
 * the package's package.json `bin` to find it (robust across versions / shim
 * formats); a .js entry (older/other layouts) is run via node instead.
 * Can't resolve → fall back to the raw .cmd (will EINVAL — surfaced in logs,
 * not silently mis-run). */
function resolveClaudeSpawn(): { file: string; prefixArgs: string[] } {
  const bin = resolveClaudeBin()
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const real = findWindowsClaudeTarget(bin)
    if (real) {
      log(`claude-process: resolved ${bin} → ${real.file}${real.prefixArgs.length ? ' ' + real.prefixArgs.join(' ') : ''}`)
      return real
    }
    log(`claude-process: 无法从 ${bin} 定位真实 claude 可执行,退回 .cmd(可能 EINVAL)`)
  }
  return { file: bin, prefixArgs: [] }
}

/** Find the real executable behind a Windows claude.cmd shim. Primary: the
 * claude-code package's package.json `bin` (npm-global layout
 * <prefix>\node_modules\@anthropic-ai\claude-code, prefix = the shim's dir).
 * Fallback: scrape the .cmd text for the path it invokes. Returns a spawn
 * target (.exe/.com → direct, .js/.mjs/.cjs → via node) or null. */
function findWindowsClaudeTarget(cmdPath: string): { file: string; prefixArgs: string[] } | null {
  const prefix = dirname(cmdPath)
  const pkgDir = join(prefix, 'node_modules', '@anthropic-ai', 'claude-code')
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    const rel = typeof pkg.bin === 'string'
      ? pkg.bin
      : (pkg.bin && typeof pkg.bin === 'object' ? (pkg.bin.claude ?? Object.values(pkg.bin)[0]) : undefined)
    if (typeof rel === 'string' && rel) {
      const hit = classifyClaudeTarget(join(pkgDir, rel))
      if (hit) return hit
      log(`claude-process: package.json bin "${rel}" 未解析到可 spawn 的入口`)
    }
  } catch (e) {
    log(`claude-process: 读 ${join(pkgDir, 'package.json')} 失败: ${e}`)
  }
  // Fallback: pull the exe/js path straight out of the shim text.
  try {
    const m = readFileSync(cmdPath, 'utf8').match(/"%~?dp0%?\\([^"]+?\.(?:exe|com|[mc]?js))"/i)
    if (m) {
      const hit = classifyClaudeTarget(join(prefix, m[1].replace(/\//g, '\\')))
      if (hit) return hit
    }
  } catch {}
  return null
}

/** A resolved bin path → spawn target: native .exe/.com spawns directly, a
 * .js/.mjs/.cjs entry runs via the current node. Missing file or unknown
 * kind → null so the caller can fall back. */
function classifyClaudeTarget(target: string): { file: string; prefixArgs: string[] } | null {
  if (!existsSync(target)) return null
  if (/\.(exe|com)$/i.test(target)) return { file: target, prefixArgs: [] }
  if (/\.[mc]?js$/i.test(target)) return { file: process.execPath, prefixArgs: [target] }
  return null
}

/** Tiny cross-runtime PATH walker — replaces `Bun.which('claude')` so
 * this module runs unchanged under both Bun (`bun daemon.ts` dev) and
 * Node (`npm i -g @leviyuan/lodestar` prod). On Windows we probe the
 * usual shim extensions in npm's preferred order. */
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

/** PATH for the spawned claude. On unix we hand-curate a minimal list
 * so even a barebones systemd PATH still finds claude + bun. On
 * Windows we just trust the user's PATH — npm-global puts claude.cmd
 * under %APPDATA%\npm which is on PATH out of the box, and force-
 * rewriting it with unix-style entries would just break things. */
function buildSpawnPath(): string {
  if (process.platform === 'win32') return process.env.PATH ?? ''
  return [
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.bun', 'bin'),
    join(homedir(), '.local', 'npm-global', 'bin'),
    '/usr/local/bin', '/usr/bin', '/bin',
  ].join(delimiter)
}

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

/** Subset of the SDK's `usage` object — only the fields the console
 * panel actually shows. Anthropic adds new ones (server_tool_use,
 * service_tier, iterations, …) without breaking existing readers. */
export interface ClaudeUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export interface ClaudeResultMeta {
  cost_usd: number | null
  duration_ms: number | null
  num_turns: number | null
  usage: ClaudeUsage | null
  /** SDK `result.subtype` — `success` on natural end_turn,
   * `error_max_turns` if --max-turns was reached, `error_during_execution`
   * for API-side failures (rate limit / 5xx / context overflow / refusal).
   * Session.wireProc uses this to drive auto-retry + suppress phone push
   * on aborted turns. */
  subtype: string | null
  /** Mirror of `subtype !== 'success'`; cached so callers don't have to
   * re-derive it from the (open-ended) subtype string. */
  is_error: boolean
}

export interface HookCallbackRequest {
  request_id: string
  callback_id: string
  input: any
  tool_use_id?: string
}

/** content_block_delta 子类型里我们主动忽略的那些 —— 不渲染也不告警。
 * - signature_delta: opus-4-7 redacted thinking 的加密签名,客户端用不上。
 * - input_json_delta: tool_use 的 input 流式片段,等 assistant message 整块再处理。
 * - citations_delta: 引用元数据,当前不渲染。
 * - thinking_delta: 明文 thinking 流 —— DeepSeek 等后端会逐 token 发(opus 的
 *   thinking 是 redacted、走 signature_delta,没有明文)。我们用顶部 ticker 补
 *   思考期的视觉空白、不逐 token 渲染 thinking,所以这里 silent skip;否则
 *   DeepSeek 一思考就把 "unhandled content_block_delta" 刷满日志。 */
const SILENT_DELTA_TYPES = new Set(['signature_delta', 'input_json_delta', 'citations_delta', 'thinking_delta'])

export class ClaudeProcess extends EventEmitter {
  private proc: ChildProcessByStdio<Writable, Readable, Readable>
  private stdoutBuf = ''
  private stderrBuf = ''
  private requestCounter = 0
  private alive = true
  private expectedExit = false
  sessionId: string | null = null
  lastAssistantUuid: string | null = null
  /** Model id (`claude-opus-4-7`, …) from the most recent assistant
   * message — surfaced in the console panel so the user sees what's
   * actually running, not whatever default we'd assume. */
  lastModel: string | null = null
  /** Usage from the most recent `assistant` message — input_tokens +
   * cache_* on the *latest* message is the best proxy for current
   * context-window occupancy, since each assistant turn replays the
   * accumulated conversation. */
  lastUsage: ClaudeUsage | null = null
  /** Result-level metadata from the most recent `result` message —
   * per-turn cost / wallclock / num_turns. Cleared to null only on
   * spawn; persists across turns so the console panel can show "last
   * turn" stats even while idle. */
  lastResult: ClaudeResultMeta = {
    cost_usd: null, duration_ms: null, num_turns: null, usage: null,
    subtype: null, is_error: false,
  }
  /** Context-window capacity of the model that ran the latest turn —
   * lifted from `result.modelUsage[model].contextWindow` so we don't
   * have to hardcode `[1m]` vs stock variants. `null` until the first
   * `result` event lands (spawn → first turn close gap). Callers that
   * render a percentage MUST treat null as "unknown" and drop the %
   * rather than substituting a default — past life of this field was a
   * 200K constant default which made fresh-spawn `hi` panels lie about
   * the limit on this project's opus-4-7[1m] (1M) pin. (no_fallbacks
   * rule applies: surface absence, don't fabricate.) */
  lastContextWindow: number | null = null

  constructor(opts: SpawnOpts) {
    super()
    const { file: spawnFile, prefixArgs } = resolveClaudeSpawn()
    const args = [
      '-p',
      '--input-format=stream-json',
      '--output-format=stream-json',
      // Partial messages 让 assistant text 走真正的 streaming delta(SSE
      // content_block_delta.text_delta),而不是等整个 assistant message 落地
      // 后一次性整块 emit。没有这个 flag 时飞书 typewriter 要 30 秒才打完
      // 一段长 assistant text,turn close 时 streaming_mode off 会让中段
      // 卡死;加了之后 token-level 同步流出,跟 TUI 体感一致。
      // 注:opus-4-7 的 extended thinking 是 redacted,客户端只拿得到
      // signature_delta 加密签名、没有 thinking_delta 明文,partial flag
      // 解不开;ticker 元素就是用来补这段视觉空白的。
      '--include-partial-messages',
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

    // Inject the daemon-hosted MCP server, scoped to this project via
    // the URL path. We use the project name (= workDir basename, which
    // mirrors session name) so each subprocess can only reach its own
    // schedules — see src/mcp-server.ts. `--mcp-config` accepts the
    // config as a JSON string directly, no temp file needed, which is
    // the whole point of this approach: zero disk-touching, the daemon
    // hands every spawned child the right wiring at spawn time. URL
    // path is encoded to survive Unicode group names (the project name
    // pipeline goes through sanitizeSessionName but kept as a defense
    // in depth in case the workDir contains unexpected chars).
    const project = basename(opts.workDir)
    const mcpConfig = {
      mcpServers: {
        lodestar: {
          type: 'http',
          url: `http://127.0.0.1:${config.notify.port}/mcp/${encodeURIComponent(project)}`,
        },
      },
    }
    args.push('--mcp-config', JSON.stringify(mcpConfig))

    log(`claude-process: spawn ${spawnFile}${prefixArgs.length ? ' ' + prefixArgs.join(' ') : ''} (cwd=${opts.workDir})`)
    // config.toml [claude.env] 节整段注入子进程 env(可选,向后兼容 / 高级
    // 用户配私有后端用)。注: setup 向导现在把 DeepSeek 这类第三方后端写到
    // claude 自己的 ~/.claude/settings.json 的 env 字段(claude 原生机制,
    // 终端直接跑也生效),默认不再往 config.toml [claude.env] 写;这条注入
    // 留给"只想让 lodestar spawn 的 claude 走某后端、不污染全局 claude 配置"
    // 的场景。展开顺序: 默认 env → 我们的 PATH/log → config.claude.env
    // (优先级最高,会覆盖前面同名 key)。
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      NPM_CONFIG_LOGLEVEL: 'error',
      PATH: buildSpawnPath(),
      ...config.claude.env,
    }
    this.proc = spawn(spawnFile, [...prefixArgs, ...args], {
      cwd: opts.workDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
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
    if (type === 'stream_event') {
      // --include-partial-messages 打开后,SDK 把 Anthropic SSE 的
      // content_block_delta 逐条转成 NDJSON 行,wrap 在 stream_event 类型
      // 里。我们只关心 text_delta —— tool_use 是整块 atomic 的,等 assistant
      // message 终态再 emit 才有 input 全文。
      // 只把 text_delta 当 assistant 正文流出 —— tool_use 是整块 atomic 的,
      // 等 assistant message 终态再 emit 才有 input 全文。其余已知子类型
      // (thinking_delta / signature_delta / …)在 SILENT_DELTA_TYPES 里 silent
      // skip,只有真正没见过的类型才落 unhandled 日志。
      const ev = msg.event
      if (ev?.type === 'content_block_delta') {
        const delta = ev.delta
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          this.emit('assistant_text', { uuid: msg.uuid, text: delta.text })
        } else if (delta?.type && !SILENT_DELTA_TYPES.has(delta.type)) {
          log(`claude-process: unhandled content_block_delta type=${delta.type}`)
        }
      } else if (ev?.type === 'content_block_stop') {
        // 一个 content block(通常是一段 assistant 正文)在 SSE 上收尾 —— 该段
        // 全文此刻已定。立即让上层把节流缓冲里的尾巴 flush 出去,不必再等
        // 120ms 节流窗口:否则段尾不足 FLUSH_MIN_DELTA 的那截会滞留,用户看到
        // 「写了一半」。tool_use block 收尾也会走到这里,flush 当前卡是幂等的
        // (去重 + 全量),无害。
        this.emit('assistant_block_stop', { index: ev.index })
      }
      return
    }
    if (type === 'assistant') {
      // partial 模式下 text 已经走 stream_event.text_delta 流过,这里只
      // 处理 tool_use(它没 partial delta,只在 message 终态出现完整 input)。
      // thinking block 的 thinking 字段也在 message 终态里,但 opus-4-7
      // 是 redacted 恒空,且即便有明文我们也不渲染(见 stream_event 的
      // thinking_delta 注释),直接 ignore。usage / model / uuid 仍然在
      // 这里记录 —— 它们是 message 终态字段,stream_event 不带。
      const content = msg.message?.content ?? []
      for (const block of content) {
        if (block.type === 'tool_use') {
          this.emit('tool_use', { uuid: msg.uuid, id: block.id, name: block.name, input: block.input })
        }
      }
      if (msg.message?.usage) this.lastUsage = msg.message.usage as ClaudeUsage
      if (typeof msg.message?.model === 'string') this.lastModel = msg.message.model
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
      const subtype = typeof msg.subtype === 'string' ? msg.subtype : null
      this.lastResult = {
        cost_usd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null,
        duration_ms: typeof msg.duration_ms === 'number' ? msg.duration_ms : null,
        num_turns: typeof msg.num_turns === 'number' ? msg.num_turns : null,
        usage: msg.usage ?? null,
        subtype,
        // Trust the SDK's own bool when present; otherwise derive from
        // subtype so a future error_* variant we haven't seen still flags
        // as error.
        is_error: typeof msg.is_error === 'boolean'
          ? msg.is_error
          : (subtype !== null && subtype !== 'success'),
      }
      // modelUsage maps "<model id>" → { contextWindow, maxOutputTokens, … }.
      // For mixed-model runs the SDK reports one entry per model used in
      // the turn; we take the one matching `lastModel` (the assistant's
      // latest model id) and fall back to any single entry if it's the
      // only one — covers the common single-model case.
      const mu = msg.modelUsage
      if (mu && typeof mu === 'object') {
        const entry = (this.lastModel && mu[this.lastModel])
          || (Object.keys(mu).length === 1 ? mu[Object.keys(mu)[0]!] : null)
        if (entry && typeof entry.contextWindow === 'number' && entry.contextWindow > 0) {
          this.lastContextWindow = entry.contextWindow
        }
      }
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

  /** Response schema for `can_use_tool` control_request (NOT the
   * PreToolUse-hook output shape that lives elsewhere in the SDK).
   *   allow → { behavior: 'allow', updatedInput: <record> }
   *   deny  → { behavior: 'deny',  message: <string> }
   * Sending the wrong shape gets Zod-rejected on the Claude side and
   * the decision never lands — the card visually flips to "resolved"
   * but Claude immediately re-fires the same can_use_tool, looking to
   * the user like a "flash back to original" bug. */
  sendPermissionResponse(
    requestId: string,
    decision: 'allow' | 'deny',
    payload?: { updatedInput?: Record<string, unknown>; denyMessage?: string },
  ): void {
    const response = decision === 'allow'
      ? { behavior: 'allow' as const, updatedInput: payload?.updatedInput ?? {} }
      : { behavior: 'deny' as const, message: payload?.denyMessage ?? 'denied by user' }
    this.write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response,
      },
    })
  }

  /** Feed a `tool_result` back to Claude as if a tool finished — used
   * by the daemon when WE (the client) own the tool's execution side,
   * e.g. AskUserQuestion: the SDK emits `tool_use` and waits for the
   * client to render UI, collect a choice, and supply the result here.
   * `content` is whatever the tool's contract says — for
   * AskUserQuestion this is a JSON string `{"answers": {...}}`.
   *
   * NOTE: this is the same `{type:'user'}` envelope as `sendUserText`,
   * just with a `tool_result` content block instead of plain text. The
   * SDK demultiplexes by `tool_use_id`. */
  sendToolResult(toolUseId: string, content: string, isError = false): void {
    this.write({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          ...(isError ? { is_error: true } : {}),
        }],
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
