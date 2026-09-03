import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { delimiter, join, posix, win32 } from 'node:path'
import { EventEmitter } from 'node:events'
import {
  query,
  type EffortLevel,
  type HookCallbackMatcher,
  type HookEvent,
  type HookInput,
  type HookJSONOutput,
  type McpServerConfig,
  type ModelInfo,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnOptions as ClaudeSdkSpawnOptions,
  type SpawnedProcess,
  type PermissionResult,
} from '@anthropic-ai/claude-agent-sdk'
import { config, type ProjectProfile } from './config'
import { log } from './log'
import {
  CLAUDE_EFFORT,
  isClaudeReasoningEffort,
  NothingToCompactError,
  type AgentReasoningEffort,
  type ClaudeReasoningEffort,
  type UserTextDispatch,
} from './agent-process'
import {
  CLAUDE_MODEL_ALIAS_KEYS,
  claudeModelEffort,
  claudeModelKey,
  claudeModelIsGrok,
  GROK_OFFICIAL_MAX_EFFORT,
  resolveClaudeSdkModel,
} from './claude-models'
import { resolveTokenSource } from './token-source'
import type {
  CanUseToolRequest,
  CodexModel,
  CodexResultMeta,
  CodexUsage,
  SpawnOpts,
} from './codex-process'
import { usageFromTokenUsagePayload } from './codex-usage'
import { ToolFailureLoopGuard } from './tool-failure-loop'

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

  /** 硬停:丢弃已排队项后关闭。被丢弃代的排队 turn 不得在 SDK abort 窗口内
   * 被 drain 执行(上游 ec149d7 硬停语义)。 */
  abort(): void {
    this.items = []
    this.close()
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

type PendingUserDialog = {
  kind: 'dialog'
  resolve: (value: PermissionResult) => void
  request: CanUseToolRequest
  cleanup?: () => void
}

/** Grok 使用档位已验证的兼容 effort；disabled 只关闭 Claude 专属 adaptive
 * thinking 控制，Grok 自身 reasoning 仍由模型执行。其它 Claude 档保持原语义。 */
export function claudeSdkReasoningOptions(
  model: string | null | undefined,
  effort: ClaudeReasoningEffort,
): { effort?: EffortLevel; thinking?: { type: 'disabled' } } {
  if (!claudeModelIsGrok(model)) return { effort: effort as EffortLevel }
  const compatibleEffort = claudeModelEffort(model) ?? GROK_OFFICIAL_MAX_EFFORT
  return { effort: compatibleEffort as EffortLevel, thinking: { type: 'disabled' } }
}

type PendingControl = PendingUserDialog

type PendingServerToolInput = {
  name: string
  input: unknown
}

const TOOL_FAILURE_CORRECTION_CONTEXT = [
  'The same tool call has failed twice with exactly the same input and error.',
  'Do not retry it unchanged. Re-read the current state and change the arguments or strategy.',
  'If no change is needed, stop calling the tool and explain that result to the user.',
].join(' ')

export interface ClaudeSpawnOpts extends SpawnOpts {
  model?: string
  effort: ClaudeReasoningEffort
  /** SDK resumeSessionAt:只 resume 到该 assistant 消息 uuid 为止(回到历史某点)。
   *  用于 fk/bk —— 不传则 resume 完整历史。Claude 专属(Codex 无此能力)。 */
  resumeSessionAt?: string
  /** SDK forkSession:true = resume 时派生新 session id,原 transcript 不动。
   *  fk/bk 都用它(避免破坏/污染原会话)。 */
  forkSession?: boolean
  /** Optional per-project launch profile from `[projects.<name>].*` in
   * config.toml. When present, overrides setting sources / tool set /
   * strict-mcp / project-mcp loading for an isolated session. Absent ⇒
   * Lodestar defaults (user sources, claude_code preset, no project MCP). */
  profile?: ProjectProfile
}

type ClaudePathLookup = {
  platform?: NodeJS.Platform
  pathEnv?: string
  homeDir?: string
  exists?: (path: string) => boolean
  /** undefined = 读 config.claude.bin;显式 null = 视为未配置(测试隔离 config 用)。 */
  configuredBin?: string | null
  /** 第三方 API 路由(GLM 一类)必须绕开 [claude].bin 包装器(如 reclaude):
   * reclaude 的 gateway 会把注入的 ANTHROPIC_BASE_URL 劫持回官方 Anthropic,
   * 第三方 model id(如 glm-5.3)会被官方 deployment 判为"模型不存在"而客户端
   * 直接报错。true 时忽略 configuredBin,解析裸 claude 二进制直连第三方端点;
   * 官方登录档位(Fable 5/Opus)仍走包装器以回收登录态额度。 */
  apiRoute?: boolean
}

type ClaudeExecutableConfig = {
  pathToClaudeCodeExecutable?: string
  spawnClaudeCodeProcess?: (options: ClaudeSdkSpawnOptions) => SpawnedProcess
  description: string
}

function pathDelimiterForPlatform(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':'
}

function joinForPlatform(platform: NodeJS.Platform, ...parts: string[]): string {
  return platform === 'win32' ? win32.join(...parts) : posix.join(...parts)
}

function windowsShellShim(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.endsWith('.cmd') || lower.endsWith('.bat')
}

function spawnWindowsShellShim(options: ClaudeSdkSpawnOptions): SpawnedProcess {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
    shell: true,
    signal: options.signal,
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  })
  if (!child.stdin || !child.stdout) {
    child.kill()
    throw new Error('failed to open stdio for Claude Code Windows shell shim')
  }
  return child as unknown as SpawnedProcess
}

function configuredBinIsReclaude(path: string, platform: NodeJS.Platform): boolean {
  const name = joinForPlatform(platform, path).split(platform === 'win32' ? '\\' : '/').at(-1)?.toLowerCase()
  return name === 'reclaude' || name === 'reclaude.exe'
}

/** reclaude injects its proxy/CA environment and then resolves `claude` from
 * PATH. Pin that lookup to the SDK-selected executable so the wrapper stays in
 * the route while dialog/control protocol support comes from the bundled SDK
 * native binary. This was verified against the configured reclaude binary on macOS. */
function spawnReclaudeWithSdkNative(wrapper: string): (options: ClaudeSdkSpawnOptions) => SpawnedProcess {
  return (options) => {
    const shimDir = mkdtempSync(join(tmpdir(), 'lodestar-claude-sdk-'))
    const cleanup = (): void => {
      try { rmSync(shimDir, { recursive: true, force: true }) }
      catch {}
    }
    try {
      const sdkCommand = options.command.includes('/') || options.command.includes('\\')
        ? options.command
        : process.execPath
      symlinkSync(sdkCommand, join(shimDir, 'claude'))
      const child = spawn(wrapper, options.args, {
        cwd: options.cwd,
        env: {
          ...(options.env as NodeJS.ProcessEnv),
          PATH: [shimDir, options.env.PATH].filter(Boolean).join(delimiter),
        },
        signal: options.signal,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      child.stderr?.on('data', chunk => {
        const text = String(chunk).trim()
        if (text) log(`claude-agent-process[stderr]: ${text}`)
      })
      child.once('exit', cleanup)
      child.once('error', cleanup)
      if (!child.stdin || !child.stdout) {
        child.kill()
        cleanup()
        throw new Error('failed to open stdio for reclaude SDK-native wrapper')
      }
      return child as unknown as SpawnedProcess
    } catch (error) {
      cleanup()
      throw error
    }
  }
}

export function resolveClaudeBin(): string {
  const found = findClaudeBin()
  if (found) return found
  throw new Error('Claude Code executable not found. Install Claude Code or add `claude` to PATH.')
}

function findClaudeBin(lookup: ClaudePathLookup = {}): string | null {
  const platform = lookup.platform ?? process.platform
  const exists = lookup.exists ?? existsSync
  const home = lookup.homeDir ?? homedir()
  if (platform !== 'win32') {
    const candidates = [
      joinForPlatform(platform, home, '.local', 'npm-global', 'bin', 'claude'),
      joinForPlatform(platform, home, '.local', 'bin', 'claude'),
    ]
    for (const candidate of candidates) if (exists(candidate)) return candidate
  }
  const found = whichClaude(lookup)
  if (found) return found
  return null
}

export function assertClaudeCodeAvailable(): void {
  // The Agent SDK ships platform-specific native Claude Code binaries as
  // optional dependencies. Do not reject startup just because no global
  // `claude` command is on PATH; if the SDK binary is missing, query() will
  // surface that concrete failure.
  findClaudeBin()
}

export function resolveClaudeExecutableConfig(lookup: ClaudePathLookup = {}): ClaudeExecutableConfig {
  const platform = lookup.platform ?? process.platform
  // 第三方 API 路由(GLM 一类)强制绕开包装器 bin(见 ClaudePathLookup.apiRoute):
  // reclaude 的 gateway 会劫持 ANTHROPIC_BASE_URL 打回官方 Anthropic,glm-5.3
  // 这类第三方 id 会被判为"模型不存在"。其它档位读 config.claude.bin
  // (显式 configuredBin 覆盖,供测试隔离 config)。
  const configured = lookup.apiRoute
    ? null
    : lookup.configuredBin === undefined
      ? config.claude.bin
      : lookup.configuredBin
  if (configured) {
    const exists = lookup.exists ?? existsSync
    // [claude].bin 配错时必须 fail fast:静默回退会让用户以为在烧包装器
    // (如 reclaude)的额度,实际走了别的 key。
    if (!exists(configured)) {
      throw new Error(`lodestar: [claude].bin not found: ${configured} (config.toml)`)
    }
    if (platform !== 'win32' && configuredBinIsReclaude(configured, platform)) {
      return {
        spawnClaudeCodeProcess: spawnReclaudeWithSdkNative(configured),
        description: `config-reclaude-sdk-native:${configured}`,
      }
    }
    if (platform === 'win32' && windowsShellShim(configured)) {
      return {
        pathToClaudeCodeExecutable: configured,
        spawnClaudeCodeProcess: spawnWindowsShellShim,
        description: `windows-shell-shim:${configured}`,
      }
    }
    return { pathToClaudeCodeExecutable: configured, description: `config:${configured}` }
  }
  const bin = findClaudeBin(lookup)
  if (!bin) return { description: 'sdk-default' }
  if (platform === 'win32' && windowsShellShim(bin)) {
    return {
      pathToClaudeCodeExecutable: bin,
      spawnClaudeCodeProcess: spawnWindowsShellShim,
      description: `windows-shell-shim:${bin}`,
    }
  }
  // 非 windows 且未配 [claude].bin:不设 pathToClaudeCodeExecutable,让 SDK 选择
  // bundled native binary。reclaude 配置也走 SDK native,但通过 custom spawn 包一层。
  return { description: 'sdk-default' }
}

function whichClaude(lookup: ClaudePathLookup = {}): string | null {
  const platform = lookup.platform ?? process.platform
  const PATH = lookup.pathEnv ?? process.env.PATH ?? ''
  if (!PATH) return null
  const exists = lookup.exists ?? existsSync
  const candidates = platform === 'win32'
    ? ['claude.exe', 'claude.cmd', 'claude.bat', 'claude']
    : ['claude']
  for (const dir of PATH.split(pathDelimiterForPlatform(platform))) {
    if (!dir) continue
    for (const name of candidates) {
      const p = joinForPlatform(platform, dir, name)
      if (exists(p)) return p
    }
  }
  return null
}

export function buildClaudeSpawnPath(): string {
  if (process.platform === 'win32') return process.env.PATH ?? ''
  const entries = [
    join(homedir(), '.local', 'npm-global', 'bin'),
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.bun', 'bin'),
    ...(process.env.PATH ?? '').split(delimiter),
    '/usr/local/bin', '/usr/bin', '/bin',
  ]
  return [...new Set(entries.filter(Boolean))].join(delimiter)
}

function usageFromSdk(raw: any): CodexUsage | null {
  const out = usageFromTokenUsagePayload(raw)
  if (!out) return null
  const summedTotal = (out.input_tokens ?? 0)
    + (out.output_tokens ?? 0)
    + (out.cache_creation_input_tokens ?? 0)
    + (out.cache_read_input_tokens ?? 0)
  const effectiveTotal = out.total_tokens ?? summedTotal
  if (effectiveTotal <= 0) return null
  if (out.total_tokens == null) out.total_tokens = summedTotal
  return out
}

/** Claude 路径上下文占用 = 输入侧 token(喂进模型的全部 input:未缓存新输入
 * + 缓存命中复读 + 本轮新建缓存),不含 output。与 Claude Code 底栏
 * context 占用同口径 = input_tokens + cache_read_input_tokens + cache_creation_input_tokens。
 * 调用方传 result.usage(单 turn query = 当前上下文);modelUsage 是会话累计、
 * assistant.message.usage 在 stream-json 下恒 0/0,都不能用。 */
function contextOccupancyFromUsage(usage: CodexUsage | null | undefined): number | null {
  if (!usage) return null
  const occ = (usage.input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0)
  return occ > 0 ? occ : null
}

/** Claude Code transcript 目录:~/.claude/projects/<cwd 编码>/。同 cwd 的所有会话
 *  jsonl 都在此 —— rs 历史列表扫这个目录,得到同工作目录的全部 claude 会话
 *  (worktree 不同 cwd → 不同编码目录,自然不混进来)。 */
export function claudeTranscriptDir(workDir: string): string {
  // 编码对齐 Claude Code SDK:cwd 非字母数字字符全 → -(不只 /,[ ] . _ - 等也 → -)。
  // 否则 workDir 含特殊字符(如 test[deepseek])时,SDK 实际 transcript dir 与本函数算出的
  // 不一致,readLastCallUsageFromTranscript 读不到 → lastContextTokens 恒 null → footer 无 🧠。
  const encoded = workDir.replace(/[^a-zA-Z0-9]/g, '-')
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(configDir, 'projects', encoded)
}

/** Claude Code session transcript 路径:~/.claude/projects/<cwd 编码>/<sid>.jsonl。 */
export function claudeTranscriptPath(workDir: string, sessionId: string): string {
  return join(claudeTranscriptDir(workDir), `${sessionId}.jsonl`)
}

/** 读 transcript jsonl,取最后一条 assistant message 的 usage —— 这是最后一次 API
 * call 的真实 per-call usage(transcript 是 claude CLI 写的,assistant 行带 finalize
 * 后的 usage;不像 stream-json 的 assistant event 恒 0/0)。= session 当前上下文快照,
 * 与 Claude Code 底栏 context 占用同口径。失败/空 → null。 */
export function readLastCallUsageFromTranscript(path: string): CodexUsage | null {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const lines = content.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const m = JSON.parse(line)
      if (m?.type === 'assistant' && m?.message?.usage) {
        const u = m.message.usage as CodexUsage
        // 跳过 synthetic 占位(SDK 对部分 turn 写 model='<synthetic>' usage 0/0,非真实 API call)
        const occ = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0)
        if (occ > 0) return u
      }
    } catch { /* skip malformed line */ }
  }
  return null
}

/** SDK contextWindow 历史 max,按 claude 路由 key 在 daemon 进程内全局共享。
 * context window 是模型路由属性(与 session 无关):任一 session 探测到的真实
 * 窗口(GLM-5.3[1m] → 1M,模型名 [1m] 钉法记账)锁定后,同路由所有 session 立即用作分母,不再各自
 * 首轮回落默认 200K。daemon 重启后重新探测(不持久化,重启不常发生)。 */
const contextWindowMaxByRoute = new Map<string, number>()

/** 1214/爆窗降级路由集。result 错误文本命中 CONTEXT_WINDOW_DEGRADE_RE 后置位:
 * 该路由分母强制 200K 且观测不再上调(防「下轮又见 1M 记账→升回→再爆」振荡),
 * 后续 spawn 的模型名与 env 值剥 [1m] 后缀回退裸名,实现自愈。daemon 重启后重探。 */
const degradedContextRoutes = new Set<string>()

/** 爆窗/模型名降级触发正则:上游通用窗口错误文本(1b65dad 同款)+ bigmodel 1214
 * 形态(2026-08-17 直连实测错误体 `[1214][modelCode：不存在][…]` 与 JSON `"code":"1214"`)。
 * 不用裸 modelCode 词(无边界易跨路由误伤),以 [1214]/"code":"1214" 精确钉。 */
const CONTEXT_WINDOW_DEGRADE_RE =
  /context.?window|prompt is too long|exceeds?.*(?:context|token)|too many (?:input )?tokens|\[1214\]|"code"\s*:\s*"?1214"?/i

const ONE_M_SUFFIX_RE = /\[1m\]$/i
const DEGRADED_CONTEXT_WINDOW = 200_000

function stripOneMSuffix(value: string): string {
  return value.replace(ONE_M_SUFFIX_RE, '')
}

/** 返回 true 表示本次为首次降级(调用方据此发一次用户可见通知)。 */
function degradeContextWindowForRoute(routeKey: string, reason: string): boolean {
  if (degradedContextRoutes.has(routeKey)) return false
  degradedContextRoutes.add(routeKey)
  contextWindowMaxByRoute.set(routeKey, DEGRADED_CONTEXT_WINDOW)
  log(`claude-agent-process: context window degraded to ${DEGRADED_CONTEXT_WINDOW} for ${routeKey}, future spawns strip [1m] (${reason.slice(0, 160)})`)
  return true
}

function claudeRouteKey(model: string | null | undefined): string {
  // opts.model 形如 'claude:glm' / 'claude:default';null 归一到 default。
  return model && model.trim() ? model : 'claude:default'
}

/** 仅供测试重置全局缓存,保证用例隔离。 */
export function resetClaudeContextWindowMaxCache(): void {
  contextWindowMaxByRoute.clear()
  degradedContextRoutes.clear()
}

function totalUsageFromModelUsage(modelUsage: any): { usage: CodexUsage | null; contextWindow: number | null } {
  if (!modelUsage || typeof modelUsage !== 'object') return { usage: null, contextWindow: null }
  const usage: CodexUsage = {}
  let contextWindow: number | null = null
  for (const value of Object.values(modelUsage)) {
    if (!value || typeof value !== 'object') continue
    const item = value as Record<string, unknown>
    usage.input_tokens = (usage.input_tokens ?? 0) + numberField(item.inputTokens ?? item.input_tokens)
    usage.output_tokens = (usage.output_tokens ?? 0) + numberField(item.outputTokens ?? item.output_tokens)
    usage.reasoning_output_tokens = (usage.reasoning_output_tokens ?? 0) + numberField(
      item.reasoningOutputTokens ?? item.reasoning_output_tokens,
    )
    usage.cache_read_input_tokens = (usage.cache_read_input_tokens ?? 0) + numberField(
      item.cacheReadInputTokens ?? item.cache_read_input_tokens,
    )
    usage.cache_creation_input_tokens = (usage.cache_creation_input_tokens ?? 0) + numberField(
      item.cacheCreationInputTokens ?? item.cache_creation_input_tokens,
    )
    const ctx = numberField(item.contextWindow ?? item.context_window)
    if (ctx > 0) contextWindow = Math.max(contextWindow ?? 0, ctx)
  }
  const total = (usage.input_tokens ?? 0)
    + (usage.output_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0)
  if (total <= 0) return { usage: null, contextWindow }
  usage.total_tokens = total
  return { usage, contextWindow }
}

function cloneUsage(usage: CodexUsage): CodexUsage {
  return { ...usage }
}

function objectKeys(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return []
  return Object.keys(raw as Record<string, unknown>).slice(0, 20)
}

function addUsageTotals(total: CodexUsage | null, delta: CodexUsage): CodexUsage {
  const out: CodexUsage = total ? { ...total } : {}
  const add = (key: keyof CodexUsage) => {
    const v = delta[key]
    if (typeof v !== 'number' || !Number.isFinite(v)) return
    out[key] = (out[key] ?? 0) + v
  }
  add('total_tokens')
  add('input_tokens')
  add('output_tokens')
  add('reasoning_output_tokens')
  add('cache_creation_input_tokens')
  add('cache_read_input_tokens')
  return out
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

function textFromServerToolResultContent(content: unknown): string {
  const text = textFromToolResultContent(content)
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) {
      const parts = parsed.map(item => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object' && typeof item.text === 'string') return item.text
        return JSON.stringify(item)
      }).filter(Boolean)
      if (parts.length > 0) return parts.join('\n')
    }
  } catch {
    // Provider server-tool output is often a JSON string array, but plain
    // text is valid too. Keep the original text when it is not JSON.
  }
  return text
}

function serverToolName(name: string): string {
  return `server_tool:${name}`
}

function serverToolInputFromScaffoldText(text: string): PendingServerToolInput | null {
  const name = text.match(/Built-in Tool:\s*([A-Za-z0-9_.:-]+)/)?.[1]
  if (!name) return null
  const inputText = text.match(/\*\*Input:\*\*\s*```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim()
  if (!inputText) return { name, input: {} }
  try {
    return { name, input: JSON.parse(inputText) }
  } catch {
    return { name, input: { raw: inputText } }
  }
}

function isServerToolScaffoldText(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.includes('Built-in Tool:')
    || (trimmed.startsWith('**Output:**') && trimmed.includes('_result'))
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

// default(非 bypassPermissions):AskUserQuestion 经 canUseTool 下发,host 才能
// 拦下渲染卡片。bypassPermissions 会 shadow 掉 canUseTool(SDK 警告
// CLAUDE_SDK_CAN_USE_TOOL_SHADOWED),AskUserQuestion 被秒批空答案、模型不等用户。
// 普通工具的"不弹审批"语义改由 canUseTool 内部秒放复刻。
export const CLAUDE_PERMISSION_MODE = 'default' as const

/** Default setting sources when no project profile overrides them.
 * Matches the bare `claude` CLI (user + project + local) so a project's
 * CLAUDE.md / skills / agents / settings.json are honored when claude runs
 * under lodestar — parity with launching claude directly in that dir. */
const DEFAULT_SETTING_SOURCES: readonly string[] = ['user', 'project', 'local']

/** Valid SDK setting sources; anything else in an explicit list is dropped. */
const VALID_SETTING_SOURCES = new Set(['user', 'project', 'local'])

/** Resolve SDK `settingSources`, first usable level wins:
 * project profile `setting_sources` → global `[claude].default_setting_sources`
 * → `['user','project','local']`. Both levels share the same grammar
 * (`auto` / comma list); a level whose value is blank or all-invalid falls
 * through to the next.
 *
 * Special value `auto` (exclusive — may appear in a list but ignores the rest):
 * if `<workDir>/.claude` or `<workDir>/CLAUDE.md` exists, expand to
 * `['user','project','local']` (parity with launching claude in that dir);
 * otherwise `['user']. Both branches keep `user`, so `auto` never triggers the
 * project-only "dropped ~/.claude/settings.json → hang" trap.
 *
 * Explicit lists are whitelist-filtered to valid sources; unknown tokens are
 * dropped (logged), never forwarded to the SDK. */
export function settingSourcesFromProfile(
  profile: ProjectProfile | undefined,
  workDir?: string,
): string[] {
  return parseSettingSources(profile?.settingSources, workDir)
    ?? parseSettingSources(config.claude.defaultSettingSources, workDir)
    ?? [...DEFAULT_SETTING_SOURCES]
}

/** One level of the settingSources chain; null = unset/unusable, fall through. */
function parseSettingSources(raw: string | undefined, workDir?: string): string[] | null {
  if (!raw) return null
  const tokens = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  if (tokens.length === 0) return null

  if (tokens.includes('auto')) {
    const extra = tokens.filter(t => t !== 'auto')
    if (extra.length) {
      log(`claude-agent-process: setting_sources "auto" is exclusive — ignoring [${extra.join(',')}]`)
    }
    const hasProjectConfig = !!workDir
      && (existsSync(join(workDir, '.claude')) || existsSync(join(workDir, 'CLAUDE.md')))
    return hasProjectConfig ? ['user', 'project', 'local'] : ['user']
  }

  const valid = tokens.filter(t => VALID_SETTING_SOURCES.has(t))
  const dropped = tokens.filter(t => !VALID_SETTING_SOURCES.has(t))
  if (dropped.length) {
    log(`claude-agent-process: setting_sources dropping unknown token(s) [${dropped.join(',')}]`)
  }
  return valid.length ? valid : null
}

/** 映射 settingSources → Claude Code 启动时实际加载的 settings.json 文件路径
 * (user=~/.claude/settings.json, project/local=<cwd>/.claude/settings[.local].json)。
 * CLAUDE_CONFIG_DIR 覆盖 user 目录,与 Claude Code 自身约定一致。 */
export function claudeSettingsFilesForSources(
  settingSources: readonly string[],
  workDir?: string,
): string[] {
  const userDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const files: string[] = []
  for (const src of settingSources) {
    if (src === 'user') files.push(join(userDir, 'settings.json'))
    else if (src === 'project' && workDir) files.push(join(workDir, '.claude', 'settings.json'))
    else if (src === 'local' && workDir) files.push(join(workDir, '.claude', 'settings.local.json'))
  }
  return files
}

/** 只读检测:给定 settings 文件的 env 块里是否含 ANTHROPIC_DEFAULT_*_MODEL —— 这些
 * key 会在 Claude Code 启动时覆盖 Lodestar 在 spawn 边界注入的 alias 锁回。纯函数,
 * 返回每个命中文件及其冲突 key 列表(按 CLAUDE_MODEL_ALIAS_KEYS 固定顺序)。 */
export function claudeSettingsAliasConflicts(
  settingSources: readonly string[],
  workDir?: string,
): { path: string; keys: string[] }[] {
  const out: { path: string; keys: string[] }[] = []
  for (const path of claudeSettingsFilesForSources(settingSources, workDir)) {
    if (!existsSync(path)) continue
    let parsed: any
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      continue // 解析不了就跳过,不打扰
    }
    const env = parsed?.env
    if (!env || typeof env !== 'object') continue
    const keys = CLAUDE_MODEL_ALIAS_KEYS.filter(k => typeof env[k] === 'string' && env[k].trim())
    if (keys.length) out.push({ path, keys })
  }
  return out
}

/** 第三方 api 路由 spawn 时:settings.json 的 env 若含 ANTHROPIC_DEFAULT_*_MODEL,
 * Claude Code 启动会覆盖 Lodestar 注入的 alias 锁回 → 官方 model id 泄漏到 GLM/Grok
 * 端点,子 agent 报 "There's an issue with the selected model (claude-fable-5). It
 * may not exist…"。best-effort 告警,绝不阻断 spawn;按 (path, keys) 签名去重避免
 * daemon 长进程反复 spawn 刷屏,用户清理后自然停报。 */
const reportedAliasConflictSigs = new Set<string>()
export function warnClaudeSettingsAliasConflict(
  settingSources: readonly string[],
  workDir?: string,
): void {
  try {
    const fresh = claudeSettingsAliasConflicts(settingSources, workDir).filter(c => {
      const sig = `${c.path}::${c.keys.join('|')}`
      if (reportedAliasConflictSigs.has(sig)) return false
      reportedAliasConflictSigs.add(sig)
      return true
    })
    if (!fresh.length) return
    const detail = fresh.map(c => `  ${c.path}\n    ${c.keys.join(', ')}`).join('\n')
    log(
      `claude-agent-process: ⚠ 第三方 API 路由下 settings.json 的 env 块含 ANTHROPIC_DEFAULT_*_MODEL,会覆盖 Lodestar 注入的 alias 锁回 → 子 agent 可能用官方 model id 打第三方端点报错。建议从 env 块删掉这些 key,交 Lodestar 动态注入:\n${detail}`,
    )
  } catch { /* best-effort,绝不阻断 spawn */ }
}

/** Resolve SDK `tools` from a project profile's comma-separated built-in
 * tool allow-list (e.g. `"Read,Write,Edit,Bash,Glob,Grep"`), falling back
 * to the `claude_code` preset. MCP tools are NOT listed here — they are
 * enabled separately via `mcpServers` and auto-join the tool set. */
export function toolsFromProfile(
  profile: ProjectProfile | undefined,
): string[] | { type: 'preset'; preset: 'claude_code' } {
  if (!profile?.tools) return { type: 'preset', preset: 'claude_code' }
  const list = profile.tools.split(',').map(s => s.trim()).filter(Boolean)
  return list.length ? list : { type: 'preset', preset: 'claude_code' }
}

/** Read `<workDir>/.mcp.json` and return its `mcpServers` map, or undefined
 * when missing / unreadable / malformed. Missing (ENOENT) is silent — it's
 * the common case (most projects ship no .mcp.json, and loadProjectMcp
 * defaults to true so every spawn probes once); other failures are logged
 * so the project knows its MCP didn't load. */
export function readProjectMcpServers(workDir: string): Record<string, McpServerConfig> | undefined {
  const mcpPath = join(workDir, '.mcp.json')
  let raw: string
  try {
    raw = readFileSync(mcpPath, 'utf8')
  } catch (e) {
    // 无 .mcp.json (ENOENT) 是常态 —— 多数项目没有,而 loadProjectMcp 默认 true
    // 时每次 spawn 都会探一次,静默跳过避免日志噪音;只在文件存在却读不了时才报警。
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`claude-agent-process: project .mcp.json not readable at ${mcpPath}: ${e}`)
    }
    return undefined
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.mcpServers && typeof parsed.mcpServers === 'object') {
      return parsed.mcpServers as Record<string, McpServerConfig>
    }
    log(`claude-agent-process: project .mcp.json has no mcpServers object at ${mcpPath}`)
    return undefined
  } catch (e) {
    log(`claude-agent-process: project .mcp.json parse failed at ${mcpPath}: ${e}`)
    return undefined
  }
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

// ── 后台任务 / 子 agent 生命周期事件 payload ─────────────────────────
// 对应 SDK 的 task_started / task_progress / task_updated / task_notification
// 四个 system subtype(见 handleSystemMessage 的 case 分支)。session 据此维护
// backgroundTasks 状态并驱动后台游标卡。之前这四个 subtype 全落 default 静默丢,
// 子 agent 启动后全程黑盒直到 tool_result 回来。

export type BgTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'paused'

export interface BgTaskUsage {
  total_tokens: number
  tool_uses: number
  duration_ms: number
}

export interface BgTaskStartedEvent {
  task_id: string
  tool_use_id?: string
  task_type?: string
  description: string
  subagent_type?: string
  workflow_name?: string
  prompt?: string
}

export interface BgTaskProgressEvent {
  task_id: string
  description?: string
  subagent_type?: string
  usage?: BgTaskUsage
  last_tool_name?: string
  summary?: string
}

export interface BgTaskUpdatedEvent {
  task_id: string
  patch: {
    status?: BgTaskStatus
    description?: string
    end_time?: number
    total_paused_ms?: number
    error?: string
    is_backgrounded?: boolean
  }
}

export interface BgTaskSettledEvent {
  task_id: string
  tool_use_id?: string
  status: 'completed' | 'failed' | 'stopped'
  summary?: string
  usage?: BgTaskUsage
}

// ── 模型拒绝 / 降级(system/model_refusal_*)─────────────────────────
// 主模型 stop_reason='refusal' 后:fallback = 已重试到备用模型;
// no_fallback = 未配 fallback,本轮直接失败。两者都 rare 但用户必须可见。
// scope 仅 fallback 有:'session'=主线程换模型(波及整个会话);'local'=子 agent /
// /btw 副问 / 后台 fork 用了 fallback,主会话模型不变。older CLI 缺省 → 'session'。
// direction 仅 SDK 仅 emit 'retry';revert/sticky 保留为 legacy,不再 emit。

export interface ModelRefusalFallbackEvent {
  trigger: 'refusal'
  direction: 'retry' | 'revert' | 'sticky'
  original_model: string
  fallback_model: string
  scope: 'session' | 'local'
  request_id: string | null
  api_refusal_category?: string | null
  api_refusal_explanation?: string | null
  content: string
  uuid: string
  session_id: string
}

export interface ModelRefusalNoFallbackEvent {
  original_model: string
  request_id: string | null
  api_refusal_category?: string | null
  api_refusal_explanation?: string | null
  content: string
  uuid: string
  session_id: string
}

export class ClaudeAgentProcess extends EventEmitter {
  readonly provider = 'claude' as const

  private opts: ClaudeSpawnOpts
  private input = new AsyncQueue<SDKUserMessage>()
  private query: Query | null = null
  private readonly abortController = new AbortController()
  private alive = true
  private expectedExit = false
  private readonly exitPromise: Promise<void>
  private resolveExit!: () => void
  private started = false
  private pendingPermissions = new Map<string, PendingControl>()
  private pendingInjectedContext: string[] = []
  private requestCounter = 0
  private cumulativeUsageFromResults: CodexUsage | null = null
  private turnActive = false
  private emittedToolUseIds = new Set<string>()
  private emittedToolResultIds = new Set<string>()
  private pendingServerToolInputs: PendingServerToolInput[] = []
  private readonly sdkToolFailureLoop = new ToolFailureLoopGuard()
  private readonly sdkToolFailureHooks = {
    PostToolUse: [{
      hooks: [async (input: HookInput): Promise<HookJSONOutput> => {
        if (input.hook_event_name === 'PostToolUse') this.sdkToolFailureLoop.observeSuccess()
        return {}
      }],
    }],
    PostToolUseFailure: [{
      hooks: [async (input: HookInput): Promise<HookJSONOutput> => this.handleSdkToolFailure(input)],
    }],
  } satisfies Partial<Record<HookEvent, HookCallbackMatcher[]>>

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
  lastContextTokens: number | null = null

  constructor(opts: ClaudeSpawnOpts) {
    super()
    this.on('error', () => {})
    this.exitPromise = new Promise(resolve => { this.resolveExit = resolve })
    this.opts = opts
    this.lastEffort = opts.effort
    this.lastModel = opts.model ? claudeModelKey(opts.model) : null
  }

  /** spawn 用的 env。基线 = process.env + PATH + [claude.env],再经 TokenSource
   * 适配层(token-source.ts)做 scrub →(api 才)注入 → tier alias + GSD_RUNTIME。
   * 行为与历史手写 scrub/inject 一致,入口统一便于后续挂更多自定义路由。
   * 注意:此 scrub 只作用于 spawn 进程的 env;若 ~/.claude/settings.json 的
   * env 块里配了 ANTHROPIC_BASE_URL/AUTH_TOKEN,Claude Code 仍会加载它 ——
   * 故第三方路由请一律走 [claude.models.*],不要写进 settings.json。 */
  private buildSpawnBaseEnv(): Record<string, string> {
    return {
      ...(process.env as Record<string, string>),
      PATH: buildClaudeSpawnPath(),
      ...config.claude.env,
    }
  }

  private buildSpawnEnv(): Record<string, string> {
    return resolveTokenSource('claude', this.opts.model).spawnEnv(this.buildSpawnBaseEnv())
  }

  sendInitialize(): void {
    if (this.started) return
    this.started = true
    // Resolve model, route, credentials, and aliases from the same Feishu
    // selection. This prevents a future profile change from sending one model
    // id while injecting another profile's route or tier aliases.
    const tokenSource = resolveTokenSource('claude', this.opts.model)
    // 降级路由剥 [1m] 回退裸名(1214/爆窗自愈的 spawn 半边;正常路由零变化)。
    const routeDegraded = degradedContextRoutes.has(claudeRouteKey(this.opts.model))
    const resolvedModel = tokenSource.resolveSpawnModel()
    const model = routeDegraded && resolvedModel ? stripOneMSuffix(resolvedModel) : resolvedModel
    const profile = this.opts.profile
    if (profile) {
      log(`claude-agent-process: project profile active — settingSources=${profile.settingSources ?? '-'} strictMcp=${profile.strictMcp ?? false} tools=${profile.tools ?? '-'} loadProjectMcp=${profile.loadProjectMcp ?? true}`)
    }
    const settingSources = settingSourcesFromProfile(profile, this.opts.workDir)
    const toolsOption = toolsFromProfile(profile)
    const strictMcpConfig = profile?.strictMcp === true
    // Default true (CLI parity): discover <cwd>/.mcp.json like bare `claude`.
    // readProjectMcpServers returns undefined when no .mcp.json is present, so
    // this is a no-op for projects without one. Opt out: load_project_mcp = "false".
    const mcpServers = profile?.loadProjectMcp !== false ? readProjectMcpServers(this.opts.workDir) : undefined
    try {
      // resolveClaudeExecutableConfig 在 [claude].bin 配错路径时同步抛出;
      // 必须在 try 内调用,确保错误走 error/exit 事件而非穿透到调用方。
      // api 判定走 TokenSource(与 claudeModelIsApiRoute 同源 profile)。
      const isApiRoute = tokenSource.isApiRoute()
      // 第三方 API 路由(GLM)绕开 reclaude 包装器,直连第三方端点;官方登录
      // 档位由 reclaude custom spawn 包住 SDK native binary,兼顾代理与 dialog。
      const executable = resolveClaudeExecutableConfig({ apiRoute: isApiRoute })
      let spawnEnv = tokenSource.spawnEnv(this.buildSpawnBaseEnv())
      if (routeDegraded) {
        spawnEnv = Object.fromEntries(
          Object.entries(spawnEnv).map(([k, v]) => [k, ONE_M_SUFFIX_RE.test(v) ? stripOneMSuffix(v) : v]),
        )
      }
      const routeLabel = isApiRoute ? 'api' : 'login'
      const reasoningOptions = claudeSdkReasoningOptions(this.opts.model, this.opts.effort)
      const reasoningLabel = reasoningOptions.thinking
        ? `grok-compat:${reasoningOptions.effort ?? '-'}`
        : this.opts.effort
      log(`claude-agent-process: spawn SDK query selection=${tokenSource.selectionModel} model=${model ?? 'default'} effort=${reasoningLabel} route=${routeLabel} cwd=${this.opts.workDir} settingSources=${settingSources.join('+')} executable=${executable.description}`)
      if (isApiRoute) warnClaudeSettingsAliasConflict(settingSources, this.opts.workDir)
      this.query = query({
        prompt: this.input,
        options: {
          cwd: this.opts.workDir,
          abortController: this.abortController,
          ...(model ? { model } : {}),
          ...reasoningOptions,
          resume: this.opts.resumeSessionId,
          ...(this.opts.resumeSessionAt ? { resumeSessionAt: this.opts.resumeSessionAt } : {}),
          ...(this.opts.forkSession ? { forkSession: true } : {}),
          ...(executable.pathToClaudeCodeExecutable
            ? { pathToClaudeCodeExecutable: executable.pathToClaudeCodeExecutable }
            : {}),
          ...(executable.spawnClaudeCodeProcess
            ? { spawnClaudeCodeProcess: executable.spawnClaudeCodeProcess }
            : {}),
          permissionMode: CLAUDE_PERMISSION_MODE,
          env: spawnEnv,
          settingSources,
          tools: toolsOption,
          ...(strictMcpConfig ? { strictMcpConfig: true } : {}),
          ...(mcpServers ? { mcpServers } : {}),
          toolConfig: {
            askUserQuestion: { previewFormat: 'markdown' },
          },
          canUseTool: (toolName, input, opts) => this.canUseTool(toolName, input, opts),
          hooks: this.sdkToolFailureHooks,
          includePartialMessages: false,
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            ...(this.opts.appendSystemPrompt ? { append: this.opts.appendSystemPrompt } : {}),
          },
          stderr: data => {
            const text = data.trim()
            if (text) log(`claude-agent-process[stderr]: ${text}`)
          },
        },
      })
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      this.emit('error', err)
      this.finishExit(1, null)
      return
    }
    void this.readLoop(this.query)
  }

  sendUserText(text: string, files: string[] = []): UserTextDispatch {
    if (!this.alive) {
      const error = new Error('claude agent process is not running')
      log(`claude-agent-process: sendUserText rejected: ${error.message}`)
      return { kind: 'rejected', provider: 'claude', error }
    }
    if (!this.started) this.sendInitialize()
    if (!this.alive) {
      return {
        kind: 'rejected',
        provider: 'claude',
        error: new Error('claude agent process failed to initialize'),
      }
    }
    const fileHints = files.length ? files.map(f => `[file: ${f}]`).join(' ') + '\n\n' : ''
    const injected = this.pendingInjectedContext.length
      ? this.pendingInjectedContext.splice(0).join('\n\n') + '\n\n'
      : ''
    try {
      // A newly queued user frame is a new turn even if an abnormal prior
      // interrupt never delivered its terminal result message.
      this.sdkToolFailureLoop.reset()
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
      return { kind: 'queued', provider: 'claude' }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      log(`claude-agent-process: sendUserText failed: ${err.message}`)
      return { kind: 'rejected', provider: 'claude', error: err }
    }
  }

  sendInterrupt(): void {
    void this.query?.interrupt().catch(e => log(`claude-agent-process: interrupt failed: ${e}`))
  }

  sendPermissionResponse(
    requestId: string | number,
    decision: 'allow' | 'deny',
    payload?: { updatedInput?: Record<string, unknown>; updatedPermissions?: unknown; denyMessage?: string },
  ): void {
    // default 模式下 canUseTool 是唯一权限入口;此方法同时服务于两条路:
    // AskUserQuestion(allow 回填 answers / deny 取消)和普通工具审批卡片。
    const pending = this.pendingPermissions.get(String(requestId))
    if (!pending) {
      log(`claude-agent-process: permission response for unknown request ${requestId}`)
      return
    }
    this.pendingPermissions.delete(String(requestId))
    pending.cleanup?.()
    if (decision === 'allow') {
      // allow 的 updatedInput 运行时必填(SDK Zod 校验,比 .d.ts 可选更严):给空=不改。
      pending.resolve({
        behavior: 'allow',
        updatedInput: payload?.updatedInput ?? {},
      })
    } else {
      // deny 的 message 同样必填;空字符串=无附加说明。
      pending.resolve({ behavior: 'deny', message: payload?.denyMessage ?? '' })
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
    this.denyPendingPermissions('claude process is stopping')
    // Hard process stop: queued user turns belong to the discarded process
    // generation and must never drain during the SDK abort window.
    this.input.abort()
    if (!this.started || !this.query) {
      this.finishExit(null, null)
      return
    }

    let closeError: Error | null = null
    try {
      this.query.close()
    } catch (e) {
      closeError = e instanceof Error ? e : new Error(String(e))
    }
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(closeError ?? new Error('claude process shutdown requested'))
    }

    // 上游 ec149d7:超时不再伪造 SIGKILL exit(SDK in-process query 本就杀不掉)——
    // 如实抛出让调用方知道进程仍活。session 侧调用点对齐随主题 I(01-10)收。
    if (!await this.waitForExit(timeoutMs)) {
      const error = new Error(
        `claude Agent SDK query did not exit within ${timeoutMs}ms after close/abort`,
        closeError ? { cause: closeError } : undefined,
      )
      log(`claude-agent-process: kill failed: ${error.message}`)
      throw error
    }
    if (closeError) {
      const error = new Error(`claude Agent SDK close failed: ${closeError.message}`, { cause: closeError })
      log(`claude-agent-process: kill failed: ${error.message}`)
      throw error
    }
  }

  async listModels(): Promise<CodexModel[]> {
    if (!this.started) this.sendInitialize()
    if (!this.query) throw new Error('claude-agent-process: SDK query not initialized (sendInitialize failed or not called)')
    const models = await this.query.supportedModels()
    return models.map(mapModelInfo)
  }

  async setModelSettings(model: string, effort: AgentReasoningEffort): Promise<void> {
    const claudeModel = resolveClaudeSdkModel(model)
    if (!isClaudeReasoningEffort(effort)) throw new Error(`invalid Claude effort: ${String(effort)}`)
    if (!this.started) this.sendInitialize()
    if (!this.query) throw new Error('claude-agent-process: SDK query not initialized (sendInitialize failed or not called)')
    if (claudeModel) await this.query.setModel(claudeModel)
    if (effort === 'max') {
      await this.query.applyFlagSettings({ ultracode: true, effortLevel: null })
    } else {
      await this.query.applyFlagSettings({ effortLevel: effort, ultracode: null })
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
    if (!this.alive) {
      throw new Error('claude agent process is not running')
    }
    if (!this.started) this.sendInitialize()
    if (!this.alive) {
      throw new Error('claude agent process failed to initialize')
    }
    // Claude SDK 无 compact 触发接口(0.3.222 仍未暴露);借 CLI 内建 /compact slash
    // command —— 其 supportsNonInteractive=true,streamInput 下作为 local command 执行。
    // push 一条内容为 /compact 的 user 消息,CLI 本地压缩,完成后 emit system/
    // compact_boundary → context_compacted(handleSystemMessage 接线)。
    //
    // 判定(上游 3e0468a→f8940bd→3b0ee26 终态,2026-08-04/05 实测确立):
    //   1. context_compacted → 真压缩完成 resolve(大上下文可能 >10min,死等)。
    //   2. assistant_text 含 "Not enough messages to compact" → transcript 不足,无需压缩。
    //   3. proc exit/error → reject(proc 死了才 fail,不靠固定时长)。
    // **不设 timeout** —— 大上下文压缩 >10min 正常,固定 timeout 会误杀(600s 超时报错);
    // 真挂起靠 proc exit/error 兜底,或用户 stop 命令中断。
    //
    // ⚠️ 之前用 onResult 兜底("result 到了没 boundary 就是无需压缩")是错的 —— 大上下文压缩
    // 极慢时 boundary 会晚于 result,被误判成"无需压缩"。只有 "Not enough" 这句固定文案才是
    // 明确的无需压缩信号。
    //
    // ⚠️ 文案耦合:"Not enough messages to compact" 是 claude code CLI 的固定输出文案,
    // CLI 升级若改了这句,transcript 不足时 watch 会永挂(仅 stop / proc exit 可解),升级需留意。
    this.input.push({
      type: 'user',
      session_id: this.sessionId ?? '',
      message: { role: 'user', content: [{ type: 'text', text: '/compact' }] },
      parent_tool_use_id: null,
      priority: 'now',
    } as SDKUserMessage)
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        this.off('context_compacted', onCompacted)
        this.off('assistant_text', onAssistantText)
        this.off('exit', onExit)
        this.off('error', onError)
      }
      const onCompacted = () => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      }
      const onAssistantText = (e: { text?: string } | undefined) => {
        // 只认 claude code /compact 在 transcript 不足时的固定输出文案。真压缩不会 emit
        // 这句(实测:真压缩 emit compact_boundary + 可选总结文本,无此句),所以不会误杀真压缩。
        if (settled) return
        const text = e?.text ?? ''
        if (text.includes('Not enough messages to compact')) {
          settled = true
          cleanup()
          reject(new NothingToCompactError())
        }
      }
      const onExit = () => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error('claude thread exited during /compact'))
      }
      const onError = (e: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(e instanceof Error ? e : new Error(String(e)))
      }
      this.on('context_compacted', onCompacted)
      this.on('assistant_text', onAssistantText)
      this.once('exit', onExit)
      this.once('error', onError)
    })
  }

  async injectThreadItems(items: any[]): Promise<void> {
    if (!Array.isArray(items) || items.length === 0) return
    this.pendingInjectedContext.push([
      'Host-injected prior tool context for this continuation:',
      JSON.stringify(items, null, 2),
    ].join('\n'))
  }

  private canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string },
  ): Promise<PermissionResult> {
    // 非 AskUserQuestion:秒放,复刻旧 bypassPermissions「不弹审批」语义。
    // default 模式下 canUseTool 对每个需权限的工具都会被调,这里只拦 AskUserQuestion。
    if (toolName !== 'AskUserQuestion') {
      return Promise.resolve({ behavior: 'allow', updatedInput: input })
    }
    // AskUserQuestion:SDK 把它当权限工具经 canUseTool 下发。host 渲染卡片、等用户
    // 点选,再以 allow + updatedInput.answers 回送,模型据此续跑。
    const questions = normalizeDialogQuestions(input)
    if (questions.length === 0) {
      log('claude-agent-process: AskUserQuestion 无有效 questions — allow 原样')
      return Promise.resolve({ behavior: 'allow', updatedInput: input })
    }
    const normalizedInput = { ...input, questions }
    const requestId = `claude_perm_${++this.requestCounter}`
    const toolUseId = options.toolUseID || requestId
    const req: CanUseToolRequest = {
      request_id: requestId,
      tool_name: 'AskUserQuestion',
      input: normalizedInput,
      tool_use_id: toolUseId,
    }
    const pending = new Promise<PermissionResult>(resolve => {
      const finish = (value: PermissionResult) => {
        options.signal.removeEventListener('abort', abort)
        resolve(value)
      }
      const abort = () => {
        if (!this.pendingPermissions.delete(requestId)) return
        finish({ behavior: 'deny', message: 'aborted' })
      }
      options.signal.addEventListener('abort', abort, { once: true })
      this.pendingPermissions.set(requestId, { kind: 'dialog', resolve: finish, request: req })
    })
    this.emitToolUseOnce(toolUseId, 'AskUserQuestion', normalizedInput, null)
    this.emit('can_use_tool', req)
    return pending
  }

  private handleSdkToolFailure(input: HookInput): HookJSONOutput {
    if (input.hook_event_name !== 'PostToolUseFailure') return {}
    const verdict = this.sdkToolFailureLoop.observeFailure(
      input.tool_name,
      input.tool_input,
      input.error,
    )
    if (verdict.type !== 'correct' && verdict.type !== 'stop') return {}
    log(`claude-agent-process: repeated tool failure tool=${input.tool_name} count=${verdict.repeatCount} fingerprint=${verdict.fingerprintHash.slice(0, 12)} action=${verdict.type}`)
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUseFailure',
        additionalContext: verdict.type === 'stop'
          ? `${TOOL_FAILURE_CORRECTION_CONTEXT} The host safety circuit breaker is stopping this turn now.`
          : TOOL_FAILURE_CORRECTION_CONTEXT,
      },
    }
  }

  private async readLoop(q: Query): Promise<void> {
    try {
      for await (const message of q) this.handleMessage(message)
      this.finishExit(null, null)
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      if (this.expectedExit && this.abortController.signal.aborted) {
        // 主动 kill 触发的 abort 会让 read loop 以异常收尾 —— 这是请求内的正常路径。
        log(`claude-agent-process: read loop stopped after requested shutdown: ${err.message}`)
        this.finishExit(null, null)
        return
      }
      log(`claude-agent-process: read loop failed: ${err.message}`)
      this.emit('error', err)
      this.finishExit(1, null)
    }
  }

  private finishExit(code: number | null, signal: string | null): void {
    if (!this.alive) return
    this.alive = false
    this.turnActive = false
    this.denyPendingPermissions('claude process exited')
    this.resolveExit()
    log(`claude-agent-process: exited code=${code} signal=${signal} expected=${this.expectedExit}`)
    this.emit('exit', { code, signal, expected: this.expectedExit })
  }

  /** 悬挂的 SDK 权限请求(AskUserQuestion 等)立即以合法 deny 解决,不再悬挂
   * 到超时。'cancelled' 不是 PermissionResult 的合法 behavior,SDK 侧会当
   * 畸形响应处理 —— 统一 deny + 原因文案(上游 ec149d7)。 */
  private denyPendingPermissions(message: string): void {
    for (const [id, pending] of this.pendingPermissions) {
      pending.cleanup?.()
      pending.resolve({ behavior: 'deny', message })
      this.pendingPermissions.delete(id)
    }
  }

  /** stop 后在超时窗口内解析进程退出:exitPromise 由 finishExit resolve,
   * 超时兜底按当时 alive 快照返回(01-13 exit-close-error 次序纪律的底座)。 */
  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (!this.alive) return true
    return new Promise(resolve => {
      let settled = false
      const finish = (exited: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve(exited)
      }
      const timeout = setTimeout(() => finish(!this.alive), Math.max(0, timeoutMs))
      void this.exitPromise.then(() => finish(true))
    })
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
        return
      case 'session_state_changed':
        if (raw.state === 'running' && !this.turnActive) {
          this.turnActive = true
          // A checkpoint belongs to exactly one clean turn. Clear the prior
          // assistant UUID at the authoritative SDK turn boundary.
          this.lastAssistantUuid = null
          this.emit('turn_started', { turn_id: raw.uuid, thread_id: this.sessionId })
        } else if (raw.state === 'idle') {
          this.turnActive = false
        }
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
      // ── 模型拒绝 / 降级(SDK system/model_refusal_*)──────────────────
      // 之前落 default 静默丢,模型拒答后用户在飞书卡上看不到任何降级信号。
      case 'model_refusal_fallback': {
        // SDK 仅 emit direction='retry';revert/sticky 是 legacy,防御性跳过避免噪音。
        if (typeof raw.direction === 'string' && raw.direction !== 'retry' && raw.direction !== undefined) return
        this.emit('model_refusal_fallback', {
          trigger: 'refusal',
          direction: typeof raw.direction === 'string' ? raw.direction : 'retry',
          original_model: String(raw.original_model ?? ''),
          fallback_model: String(raw.fallback_model ?? ''),
          scope: raw.scope === 'local' ? 'local' : 'session',
          request_id: raw.request_id ?? null,
          api_refusal_category: raw.api_refusal_category,
          api_refusal_explanation: raw.api_refusal_explanation,
          content: String(raw.content ?? ''),
          uuid: String(raw.uuid ?? ''),
          session_id: String(raw.session_id ?? ''),
        } satisfies ModelRefusalFallbackEvent)
        return
      }
      case 'model_refusal_no_fallback':
        this.emit('model_refusal_no_fallback', {
          original_model: String(raw.original_model ?? ''),
          request_id: raw.request_id ?? null,
          api_refusal_category: raw.api_refusal_category,
          api_refusal_explanation: raw.api_refusal_explanation,
          content: String(raw.content ?? ''),
          uuid: String(raw.uuid ?? ''),
          session_id: String(raw.session_id ?? ''),
        } satisfies ModelRefusalNoFallbackEvent)
        return
      // ── 后台任务 / 子 agent 生命周期(SDK 的 task_* 消息族,统一 type:'system')
      // 全部 emit 出去给 session 维护 backgroundTasks 状态 + 驱动后台游标卡。
      // 之前落 default 静默丢,子 agent 启动后全程黑盒直到 tool_result 回来。
      case 'task_started':
        this.emit('bg_task_started', {
          task_id: String(raw.task_id ?? ''),
          tool_use_id: typeof raw.tool_use_id === 'string' ? raw.tool_use_id : undefined,
          task_type: typeof raw.task_type === 'string' ? raw.task_type : undefined,
          description: String(raw.description ?? ''),
          subagent_type: typeof raw.subagent_type === 'string' ? raw.subagent_type : undefined,
          workflow_name: typeof raw.workflow_name === 'string' ? raw.workflow_name : undefined,
          prompt: typeof raw.prompt === 'string' ? raw.prompt : undefined,
        })
        return
      case 'task_progress':
        this.emit('bg_task_progress', {
          task_id: String(raw.task_id ?? ''),
          description: typeof raw.description === 'string' ? raw.description : undefined,
          subagent_type: typeof raw.subagent_type === 'string' ? raw.subagent_type : undefined,
          usage: raw.usage,
          last_tool_name: typeof raw.last_tool_name === 'string' ? raw.last_tool_name : undefined,
          summary: typeof raw.summary === 'string' ? raw.summary : undefined,
        })
        return
      case 'task_updated':
        this.emit('bg_task_updated', {
          task_id: String(raw.task_id ?? ''),
          patch: raw.patch && typeof raw.patch === 'object' ? raw.patch : {},
        })
        return
      case 'task_notification':
        // task_notification 是任务结算的权威信号:带终态 status + 最终 usage。
        // 协议校验(上游 ec149d7):缺 task_id / 未知终态不再强转 completed ——
        // 伪造终态会让 session 把仍在跑的任务提前墓碑化。
        if (typeof raw.task_id !== 'string' || !raw.task_id) {
          log('claude-agent-process: task_notification missing task_id')
          return
        }
        if (raw.status !== 'completed' && raw.status !== 'failed' && raw.status !== 'stopped') {
          log(`claude-agent-process: task_notification unknown status=${String(raw.status)} task=${raw.task_id}`)
          return
        }
        this.emit('bg_task_settled', {
          task_id: raw.task_id,
          tool_use_id: typeof raw.tool_use_id === 'string' ? raw.tool_use_id : undefined,
          status: raw.status,
          summary: typeof raw.summary === 'string' ? raw.summary : undefined,
          usage: raw.usage,
        })
        return
      default:
        log(`claude-agent-process: unhandled system subtype=${String(raw.subtype ?? 'unknown')}`)
        return
    }
  }

  private handleAssistantMessage(raw: any): void {
    const message = raw.message
    const parentToolUseId = typeof raw.parent_tool_use_id === 'string' && raw.parent_tool_use_id
      ? raw.parent_tool_use_id
      : null
    // SDK/CLI 在开启子 Agent 文本转发或部分兼容路由上会把子 Agent assistant
    // 消息送进主 query() stream。只有主线程 UUID 才是本会话可 fork 的
    // checkpoint；子 Agent UUID 属于另一份 transcript，不能污染 rs/fk 锚点。
    if (!parentToolUseId && typeof raw.uuid === 'string') this.lastAssistantUuid = raw.uuid
    if (typeof message?.model === 'string' && message.model) this.lastModel = claudeModelKey(message.model)
    const content = Array.isArray(message?.content) ? message.content : []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        const pendingServerToolInput = serverToolInputFromScaffoldText(block.text)
        if (pendingServerToolInput) {
          this.pendingServerToolInputs.push(pendingServerToolInput)
          if (this.pendingServerToolInputs.length > 20) this.pendingServerToolInputs.shift()
        }
        if (isServerToolScaffoldText(block.text)) continue
        const uuid = raw.uuid ?? message?.id
        this.emit('assistant_text', { uuid, text: block.text, parentToolUseId })
        this.emit('assistant_block_stop', { index: uuid, parentToolUseId })
      } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        this.emitToolUseOnce(block.id, block.name, block.input ?? {}, parentToolUseId)
      } else if (block.type === 'server_tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        this.emitToolUseOnce(block.id, serverToolName(block.name), {
          tool: block.name,
          input: this.serverToolInput(block.name, block.input ?? {}),
        }, parentToolUseId)
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        this.emitToolResultOnce(
          block.tool_use_id,
          textFromServerToolResultContent(block.content),
          block.is_error === true,
          parentToolUseId,
        )
      }
    }
  }

  private emitToolUseOnce(id: string, name: string, input: any, parentToolUseId: string | null): void {
    if (this.emittedToolUseIds.has(id)) return
    this.emittedToolUseIds.add(id)
    // parentToolUseId:子 agent 内的工具调用 = 触发它的 Task tool_use id;主线程为 null。
    // session 据此把子 agent 的逐步过程累积进对应后台 task 的 steps[]。
    this.emit('tool_use', { id, name, input, parentToolUseId })
  }

  private serverToolInput(name: string, rawInput: unknown): unknown {
    const structuredInput = rawInput
    if (
      structuredInput &&
      typeof structuredInput === 'object' &&
      !Array.isArray(structuredInput) &&
      Object.keys(structuredInput as Record<string, unknown>).length > 0
    ) {
      return structuredInput
    }
    const idx = this.pendingServerToolInputs.findIndex(item => item.name === name)
    if (idx >= 0) {
      const [item] = this.pendingServerToolInputs.splice(idx, 1)
      return item.input
    }
    return structuredInput
  }

  private emitToolResultOnce(toolUseId: string, content: string, isError: boolean, parentToolUseId: string | null): void {
    if (this.emittedToolResultIds.has(toolUseId)) return
    this.emittedToolResultIds.add(toolUseId)
    this.emit('tool_result', {
      tool_use_id: toolUseId,
      content,
      is_error: isError,
      parentToolUseId,
    })
  }

  private handleUserMessage(raw: any): void {
    const rawContent = raw.message?.content
    // CronCreate 的 SDK 定时唤醒实测形状:user + isMeta=true +
    // promptSource='sdk' + string content。手动输入是 text block 数组；图片
    // 结果虽也是 meta string，但没有 promptSource=sdk；task-notification 则
    // isMeta 为空。只认完整组合，避免普通 internal user 消息误开定时卡。
    if (
      raw.isMeta === true &&
      raw.promptSource === 'sdk' &&
      typeof rawContent === 'string' &&
      rawContent.trim()
    ) {
      this.emit('scheduled_turn_input', {
        text: rawContent,
        promptId: typeof raw.promptId === 'string' && raw.promptId ? raw.promptId : null,
      })
    }
    const content = Array.isArray(rawContent) ? rawContent : []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      const toolResult = raw.tool_use_result
      // 优先 block.content(tool_result 的标准结果文本 —— Claude Code 把 Task/
      // Read/WebSearch 等工具结果放这里);为空时才回退 tool_use_result.stdout/stderr
      // (codex 风格命令输出)。之前只看 stdout/stderr,非命令工具 output 全丢:
      // TaskCreate 的 "Task #N created" 丢失 → id 解析失败 → 任务板永远卡在待办。
      const contentText = textFromToolResultContent(block.content)
      const stdoutStderr = toolResult && typeof toolResult === 'object'
        ? [
            typeof toolResult.stdout === 'string' ? toolResult.stdout : '',
            typeof toolResult.stderr === 'string' ? toolResult.stderr : '',
          ].filter(Boolean).join('\n')
        : ''
      const output = contentText || stdoutStderr
      this.emitToolResultOnce(block.tool_use_id, output, block.is_error === true || toolResult?.interrupted === true, raw.parent_tool_use_id ?? null)
    }
  }

  private handleResultMessage(raw: any): void {
    this.sdkToolFailureLoop.reset()
    if (typeof raw.session_id === 'string' && raw.session_id) this.sessionId = raw.session_id
    this.turnActive = false
    const usage = usageFromSdk(raw.usage)
    const modelUsageRaw = raw.modelUsage ?? raw.model_usage
    const total = totalUsageFromModelUsage(modelUsageRaw)
    if (!usage && !total.usage) {
      log(`claude-agent-process: result usage missing rootKeys=${objectKeys(raw).join(',') || '-'} usageKeys=${objectKeys(raw.usage).join(',') || '-'} modelUsageKeys=${objectKeys(modelUsageRaw).join(',') || '-'}`)
    }
    this.lastUsage = usage
    if (total.usage) {
      this.cumulativeUsageFromResults = cloneUsage(total.usage)
      this.lastTotalUsage = cloneUsage(total.usage)
    } else if (usage) {
      this.cumulativeUsageFromResults = addUsageTotals(this.cumulativeUsageFromResults, usage)
      this.lastTotalUsage = cloneUsage(this.cumulativeUsageFromResults)
    } else {
      this.lastTotalUsage = this.cumulativeUsageFromResults ? cloneUsage(this.cumulativeUsageFromResults) : null
    }
    // 1214/爆窗自愈先行:错误 result 文本命中降级正则 → 该路由分母立即回 200K
    // (本轮 lastContextWindow 就取降级值),后续 spawn 剥 [1m] 回退裸名。
    // 触发门对齐上游最小面(仅 is_error===true);且只对 resolved model 带 [1m]
    // 后缀的路由生效——不带 [1m] 的路由分母本就是端点真实窗口,降级无意义,
    // 顺带把正则误伤面压缩到 [1m] 记账声明型路由。
    if (raw.is_error === true) {
      const resultText = typeof raw.result === 'string' ? raw.result : ''
      if (resultText && CONTEXT_WINDOW_DEGRADE_RE.test(resultText)) {
        const resolved = resolveTokenSource('claude', this.opts.model).resolveSpawnModel()
        if (resolved && ONE_M_SUFFIX_RE.test(resolved)) {
          const routeKey = claudeRouteKey(this.opts.model)
          if (degradeContextWindowForRoute(routeKey, resultText)) {
            this.emit('context_window_degraded', {
              routeKey,
              model: resolved,
              contextWindow: DEGRADED_CONTEXT_WINDOW,
            })
          }
        }
      }
    }
    // 分母 = 该路由的 SDK contextWindow 历史 max(daemon 全局,按路由 key 共享)。
    // context window 是模型路由属性,与 session 无关:任一 session 探测到的真实
    // 窗口(GLM-5.3[1m] → 1M,模型名 [1m] 钉法记账)全局锁定,所有 session 立即用作分母,不再各自首轮
    // 回落默认 200K。取 max 且单调不降,避免忽高忽低。SDK 从未上报 → null(--)。
    if (total.contextWindow != null) {
      const routeKey = claudeRouteKey(this.opts.model)
      // 已降级路由锁死 200K,不再随观测上调 —— CLI 对 [1m] 名仍会按 1M 记账,
      // 若这里放行会「升回 1M → 下轮再爆 → 再降」振荡;重启后重探。
      if (!degradedContextRoutes.has(routeKey)) {
        const prev = contextWindowMaxByRoute.get(routeKey) ?? 0
        if (total.contextWindow > prev) {
          contextWindowMaxByRoute.set(routeKey, total.contextWindow)
          log(`claude-agent-process: SDK contextWindow ${total.contextWindow} (global max for ${routeKey}, prev ${prev || '-'})`)
        } else if (total.contextWindow < (contextWindowMaxByRoute.get(routeKey) ?? 0)) {
          log(`claude-agent-process: SDK contextWindow ${total.contextWindow} ignored (global max ${contextWindowMaxByRoute.get(routeKey)} locked for ${routeKey})`)
        }
      }
    }
    this.lastContextWindow = contextWindowMaxByRoute.get(claudeRouteKey(this.opts.model)) ?? total.contextWindow ?? null
    // 上下文占用 = session 当前上下文 = 最后一次 API call 的输入侧 token。从 claude
    // session transcript 读最后一条 assistant 的 per-call usage(transcript 带 finalize
    // 后的真实值;stream-json 的 assistant event 恒 0/0、result.usage 是 turn 聚合、
    // modelUsage 是 session 累计,都不能代表当前上下文)。与 Claude Code 底栏
    // context 占用同口径。transcript 不可读 → null → footer 显 MISS。
    // transcript 读最后真实 assistant usage(跳 synthetic);文件存在但全 synthetic(DeepSeek 前 turn
    // SDK 只写占位)→ fallback result.usage 单 turn input;文件不存在(test / 新 session 首次)→ null(MISS)。
    const transcriptPath = claudeTranscriptPath(this.opts.workDir, this.sessionId ?? '')
    const transcriptUsage = readLastCallUsageFromTranscript(transcriptPath)
    this.lastContextTokens = contextOccupancyFromUsage(transcriptUsage)
      ?? (existsSync(transcriptPath) ? contextOccupancyFromUsage(usage) : null)
    if (this.lastTotalUsage || this.lastUsage) {
      this.emit('token_usage', {
        usage: this.lastUsage,
        totalUsage: this.lastTotalUsage,
        contextWindow: this.lastContextWindow,
        threadId: this.sessionId ?? undefined,
        turnId: raw.uuid,
      })
    }
    const subtype = typeof raw.subtype === 'string' ? raw.subtype : raw.is_error ? 'error' : 'success'
    this.lastResult = {
      cost_usd: null,
      cost_delta_usd: null,
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
      // turn-local Claude checkpoint(ff44afb):仅干净完成轮携带分叉锚。
      checkpoint: !this.lastResult.is_error && this.lastAssistantUuid && this.sessionId
        ? {
            provider: 'claude',
            kind: 'assistant-message',
            id: this.lastAssistantUuid,
            source: { provider: 'claude', sessionId: this.sessionId, cwd: this.opts.workDir },
          }
        : null,
    })
  }

}
