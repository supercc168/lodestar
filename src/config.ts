/**
 * Read config.toml — minimal hand-rolled parser sufficient for the
 * scalar-value-only schema we expect:
 *
 *   [feishu]
 *   app_id = "cli_..."
 *   app_secret = "..."
 *
 *   [runtime]
 *   projects_root = "~/"      # optional, defaults to $HOME
 *
 *   [notify]                  # all optional
 *   bind = "127.0.0.1"        # default 127.0.0.1 (loopback only)
 *   port = 9876               # default 9876
 *
 * Loaded synchronously at import time; downstream modules read the
 * exported `config` object directly.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { CONFIG_FILE } from './paths'

export interface LodestarConfig {
  feishu: {
    app_id: string
    app_secret: string
  }
  runtime: {
    projects_root: string
  }
  notify: {
    bind: string
    port: number
  }
  /** Env vars injected into the spawned `codex app-server` subprocess.
   * Empty record = no injection; Codex uses the user's ChatGPT login. */
  codex: {
    env: Record<string, string>
  }
  /** Env vars injected into the Claude Code subprocess used by
   * `@anthropic-ai/claude-agent-sdk`. Empty record = inherit the user's
   * local Claude Code configuration. */
  claude: {
    /** 显式指定 SDK spawn 的 Claude Code 可执行文件(如 reclaude 这类
     * 参数透传包装器)。未设置 = 自动查找。 */
    bin?: string
    env: Record<string, string>
    models: Record<string, ClaudeModelConfig>
  }
  /** Per-project launch profiles keyed by session name (= group name).
   * Empty record ⇒ every project runs with Lodestar defaults. */
  projects: Record<string, ProjectProfile>
}

export interface ClaudeModelConfig {
  display_name?: string
  description?: string
  model?: string
  /** 第三方路由(如 GLM)的接入配置。官方 Anthropic 档位(Fable 5/Opus)
   * 留空 —— 它们走用户的 Claude 登录态,绝不注入 API key。设置任一即视为
   * API 路由:spawn 时按档位注入对应 ANTHROPIC_* env(见 claude-models.ts
   * claudeModelEnv)。GLM 的 token 应放在 [claude.models.glm] 这个档位节里,
   * 不要放全局 [claude.env],否则会污染官方登录档位。 */
  base_url?: string
  auth_token?: string
  api_key?: string
  /** 显式声明路由类型;缺省时由是否配置了 base_url/auth_token 推断。 */
  route?: 'login' | 'api'
  /** 该档位在 model 面板锁死的思考强度(low/medium/high/xhigh/max)。第三方
   * 路由(GLM)用它复刻各自最优配置 —— 如 GLM-5.2 直连智谱走 xhigh 触发
   * extended thinking。官方档位不读此字段(锁 max)。非法值忽略、回落固定值。 */
  effort?: string
}

/** Per-project agent launch profile, sourced from `[projects.<name>].*`
 * sections in config.toml. Absent section ⇒ no override (Lodestar defaults:
 * `settingSources:['user']`, `claude_code` tool preset, no project MCP).
 * Lets an external project (e.g. evolving) run a clean, isolated Claude
 * session pointed at an arbitrary cwd with a restricted tool set and its
 * own `.mcp.json`, without touching any other project. */
export interface ProjectProfile {
  /** Absolute working directory. Falls back to `PROJECTS_ROOT/<name>`. */
  cwd?: string
  /** Comma-separated setting sources, e.g. `"project"` or `"user,project"`. */
  settingSources?: string
  /** Only use MCP servers loaded via `loadProjectMcp`; ignore user/global MCP. */
  strictMcp?: boolean
  /** Comma-separated built-in tool allow-list, e.g. `"Read,Write,Edit,Bash,Glob,Grep"`. */
  tools?: string
  /** Read `<cwd>/.mcp.json` and pass its servers to the SDK. */
  loadProjectMcp?: boolean
  /** Keep Lodestar's appended system instructions (card markers etc). Default true. */
  keepLodestarInstructions?: boolean
}

function expandTilde(v: string): string {
  return v.replace(/^~(?=\/|$)/, homedir())
}

function parseToml(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = { _: {} }
  let section = '_'
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|[^\\])#.*$/, '$1').trim()
    if (!line) continue
    const sec = line.match(/^\[([^\]]+)\]$/)
    if (sec) {
      section = sec[1].trim()
      out[section] ??= {}
      continue
    }
    const kv = line.match(/^([\w.-]+)\s*=\s*(.+)$/)
    if (kv) {
      let v = kv[2].trim()
      const dq = v.startsWith('"') && v.endsWith('"')
      const sq = v.startsWith("'") && v.endsWith("'")
      if (dq || sq) {
        v = v.slice(1, -1)
        // TOML basic strings (double-quoted) get \\, \" unescaped;
        // single-quoted literal strings stay raw per TOML spec.
        // Mirror escapeTomlString() in src/setup.ts.
        if (dq) v = v.replace(/\\([\\"])/g, '$1')
      }
      out[section][kv[1]] = v
    }
  }
  return out
}

function loadConfig(): LodestarConfig {
  let raw: string
  try {
    raw = readFileSync(CONFIG_FILE, 'utf8')
  } catch (e) {
    process.stderr.write(
      `lodestar: cannot read config at ${CONFIG_FILE}\n` +
      `  → 运行 \`lodestar-setup\` 走交互式向导生成 (Feishu / Codex / 工作目录)\n` +
      `  → 或手写: 设 LODESTAR_CONFIG=/path/to/config.toml 覆盖默认路径\n` +
      `    [feishu]\n    app_id = "cli_xxx"\n    app_secret = "xxx"\n\n`,
    )
    throw e
  }
  const t = parseToml(raw)
  const appId = t.feishu?.app_id
  const appSecret = t.feishu?.app_secret
  if (!appId || !appSecret) {
    throw new Error(`lodestar: ${CONFIG_FILE} is missing [feishu].app_id / [feishu].app_secret`)
  }
  const projectsRoot = expandTilde(t.runtime?.projects_root ?? homedir())
  const notifyBind = t.notify?.bind ?? '127.0.0.1'
  const notifyPortRaw = t.notify?.port ?? '9876'
  const notifyPort = Number.parseInt(notifyPortRaw, 10)
  if (!Number.isFinite(notifyPort) || notifyPort <= 0 || notifyPort > 65535) {
    throw new Error(`lodestar: [notify].port must be 1..65535, got "${notifyPortRaw}"`)
  }
  const envSection = (name: string): Record<string, string> => {
    const section = t[name] ?? {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(section)) {
      if (typeof v === 'string' && v.length > 0) out[k] = v
    }
    return out
  }
  const claudeModelSections = (): Record<string, ClaudeModelConfig> => {
    const out: Record<string, ClaudeModelConfig> = {}
    for (const [sectionName, section] of Object.entries(t)) {
      const prefix = 'claude.models.'
      if (!sectionName.startsWith(prefix)) continue
      const key = sectionName.slice(prefix.length).trim()
      if (!key) continue
      const profile: ClaudeModelConfig = {}
      for (const [rawKey, value] of Object.entries(section)) {
        if (typeof value !== 'string' || value.length === 0) continue
        const field = rawKey.trim()
        if (
          field === 'display_name' ||
          field === 'description' ||
          field === 'model' ||
          field === 'base_url' ||
          field === 'auth_token' ||
          field === 'api_key' ||
          field === 'route' ||
          field === 'effort'
        ) {
          ;(profile as Record<string, string>)[field] = value
        }
      }
      out[key] = profile
    }
    return out
  }
  // [projects.<name>] 节可选 —— 一个外部项目(如 evolving)想跑干净隔离的
  // Claude session:指定 cwd、限定内置工具、只挂自己的 .mcp.json。未配置的
  // 项目完全走 Lodestar 默认(settingSources:['user'] + claude_code 工具集)。
  const projectSections = (): Record<string, ProjectProfile> => {
    const out: Record<string, ProjectProfile> = {}
    const prefix = 'projects.'
    for (const [sectionName, section] of Object.entries(t)) {
      if (!sectionName.startsWith(prefix)) continue
      const name = sectionName.slice(prefix.length).trim()
      if (!name) continue
      const profile: ProjectProfile = {}
      for (const [rawKey, value] of Object.entries(section)) {
        if (typeof value !== 'string' || value.length === 0) continue
        switch (rawKey.trim()) {
          case 'cwd': profile.cwd = value; break
          case 'setting_sources': profile.settingSources = value; break
          case 'strict_mcp': profile.strictMcp = value === 'true'; break
          case 'tools': profile.tools = value; break
          case 'load_project_mcp': profile.loadProjectMcp = value === 'true'; break
          case 'keep_lodestar_instructions': profile.keepLodestarInstructions = value === 'true'; break
        }
      }
      out[name] = profile
    }
    return out
  }
  // [codex.env] / [claude.env] 节可选 —— 空 record 就维持各 CLI 自己的登录态。
  const codexEnv = envSection('codex.env')
  const claudeEnv = envSection('claude.env')
  const claudeBin = t.claude?.bin ? expandTilde(t.claude.bin) : undefined
  return {
    feishu: { app_id: appId, app_secret: appSecret },
    runtime: { projects_root: projectsRoot },
    notify: { bind: notifyBind, port: notifyPort },
    codex: { env: codexEnv },
    claude: { bin: claudeBin, env: claudeEnv, models: claudeModelSections() },
    projects: projectSections(),
  }
}

export const config = loadConfig()
