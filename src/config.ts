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
// 纯类型/纯解析从 ./config-parse 引入并对外再导出(保持 './config' 公开 API 不变)。
// 拆分是为了让解析逻辑的单测可从 './config-parse' 导入,不受 mock.module('./config') 污染。
import { parseClaudeModelProfile, type ClaudeModelConfig } from './config-parse'
export { parseClaudeModelProfile, type ClaudeModelConfig }

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
    /** Per-slot 第三方 provider 档位,对应 `[codex.models.<slug>]`。空 record =
     * 只有内建 gpt-5.6-sol 登录/默认档。见 src/codex-models.ts。 */
    models: Record<string, CodexModelConfig>
  }
  /** Env vars injected into the Claude Code subprocess used by
   * `@anthropic-ai/claude-agent-sdk`. Empty record = inherit the user's
   * local Claude Code configuration. */
  claude: {
    /** 显式指定 SDK spawn 的 Claude Code 可执行文件(如 reclaude 这类
     * 参数透传包装器)。未设置 = 自动查找。 */
    bin?: string
    /** 新 session(无持久化 model 选择)的默认档位,取 [claude.models.*] /
     * 内建档位的 key(如 "glm")或固定项 model(如 "claude:glm" / "gpt-5.6-sol")。
     * 未设置 = 硬编码登录默认 Fable 5。只订阅 GLM 的用户设 "glm" 后,新群首条
     * 消息直接走 GLM,不必先手动切一次。 */
    defaultModel?: string
    /** 全局默认 setting_sources,兜底所有未在 [projects.<name>] 里显式配置
     * setting_sources 的项目。语法与项目级完全一致("auto" / 逗号列表),
     * 项目级优先。未设置 = 硬编码 "user"。设 "auto" 后新建项目(新群)自动
     * 按目录探测加载 .claude//CLAUDE.md —— 注意 auto 会整体加载项目 hooks,
     * 见 README「auto 档要点」。解析在 settingSourcesFromProfile。 */
    defaultSettingSources?: string
    env: Record<string, string>
    models: Record<string, ClaudeModelConfig>
  }
  /** Per-project launch profiles keyed by session name (= group name).
   * Empty record ⇒ every project runs with Lodestar defaults. */
  projects: Record<string, ProjectProfile>
}

/** 第三方 Codex provider(OpenAI 兼容端点)接入配置,对应 `[codex.models.<slug>]`。
 * 配了 base_url 即视为 API 路由:spawn 时用 `codex app-server -c` 覆盖注入一个
 * `lodestar_<slug>` provider,并把 api_key 注入 env。都不配 = 登录档,继承用户
 * 全局 `~/.codex/config.toml`。见 src/codex-models.ts。 */
export interface CodexModelConfig {
  display_name?: string
  description?: string
  model?: string
  base_url?: string
  /** `chat` | `responses`;缺省 `chat`。第三方 OpenAI 兼容端点多用 chat。 */
  wire_api?: string
  api_key?: string
  /** 覆盖装 key 的环境变量名(缺省 lodestar 生成 LODESTAR_CODEX_<SLUG>_KEY)。 */
  env_key?: string
  /** 走 codex 的 OpenAI auth(如无痕 wuhen);置 "true" 时可不配 api_key。 */
  requires_openai_auth?: string
  /** 显式声明路由;缺省由是否配了 base_url 推断。 */
  route?: 'login' | 'api'
  /** 该档位锁定的思考强度(none|minimal|low|medium|high|xhigh);缺省回落 xhigh。 */
  effort?: string
}

/** Per-project agent launch profile, sourced from `[projects.<name>].*`
 * sections in config.toml. Absent section ⇒ no override (Lodestar defaults:
 * `settingSources:['user','project','local']`, `claude_code` tool preset, project MCP auto-discovered).
 * Lets an external project (e.g. evolving) run a clean, isolated Claude
 * session pointed at an arbitrary cwd with a restricted tool set and its
 * own `.mcp.json`, without touching any other project. */
export interface ProjectProfile {
  /** Absolute working directory. Falls back to `PROJECTS_ROOT/<name>`. */
  cwd?: string
  /** Comma-separated setting sources, e.g. `"project"` or `"user,project"`.
   * Special value `"auto"`: auto-detect `<cwd>/.claude` or `<cwd>/CLAUDE.md` →
   * `['user','project','local']` if present, else `['user']`.
   * See `settingSourcesFromProfile` in claude-agent-process.ts. */
  settingSources?: string
  /** Only use MCP servers loaded via `loadProjectMcp`; ignore user/global MCP. */
  strictMcp?: boolean
  /** Comma-separated built-in tool allow-list, e.g. `"Read,Write,Edit,Bash,Glob,Grep"`. */
  tools?: string
  /** Read `<cwd>/.mcp.json` and pass its servers to the SDK. Default true
   * (parity with bare `claude`, which discovers project .mcp.json). */
  loadProjectMcp?: boolean
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
      out[key] = parseClaudeModelProfile(section)
    }
    return out
  }
  const codexModelSections = (): Record<string, CodexModelConfig> => {
    const out: Record<string, CodexModelConfig> = {}
    const prefix = 'codex.models.'
    for (const [sectionName, section] of Object.entries(t)) {
      if (!sectionName.startsWith(prefix)) continue
      const key = sectionName.slice(prefix.length).trim()
      if (!key) continue
      const profile: CodexModelConfig = {}
      for (const [rawKey, value] of Object.entries(section)) {
        if (typeof value !== 'string' || value.length === 0) continue
        const field = rawKey.trim()
        if (
          field === 'display_name' ||
          field === 'description' ||
          field === 'model' ||
          field === 'base_url' ||
          field === 'wire_api' ||
          field === 'api_key' ||
          field === 'env_key' ||
          field === 'requires_openai_auth' ||
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
  // 项目完全走 Lodestar 默认(settingSources:['user','project','local'] + claude_code 工具集 + 项目 .mcp.json 自动发现)。
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
          // 原样存储;`"auto"` 与白名单校验在 settingSourcesFromProfile 处理
          case 'setting_sources': profile.settingSources = value; break
          case 'strict_mcp': profile.strictMcp = value === 'true'; break
          case 'tools': profile.tools = value; break
          case 'load_project_mcp': profile.loadProjectMcp = value === 'true'; break
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
  const claudeDefaultModel = t.claude?.default_model?.trim() || undefined
  // 原样存储;"auto" 与白名单校验在 settingSourcesFromProfile 处理(与项目级同一套解析)
  const claudeDefaultSettingSources = t.claude?.default_setting_sources?.trim() || undefined
  return {
    feishu: { app_id: appId, app_secret: appSecret },
    runtime: { projects_root: projectsRoot },
    notify: { bind: notifyBind, port: notifyPort },
    codex: { env: codexEnv, models: codexModelSections() },
    claude: {
      bin: claudeBin,
      defaultModel: claudeDefaultModel,
      defaultSettingSources: claudeDefaultSettingSources,
      env: claudeEnv,
      models: claudeModelSections(),
    },
    projects: projectSections(),
  }
}

export const config = loadConfig()
