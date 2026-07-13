/**
 * 内置 TokenSource 实现 —— 从 config.toml [token_source.*] 构建 codex/glm source。
 *
 * 由 daemon 启动时调用 buildTokenSourcesFromConfig() 注册到 registry。
 * 飞书 config 命令改 token_source 后可重新调用(reload)。
 */

import { config, type TokenSourceConfig } from './config'
import {
  type TokenSource,
  type TokenSourceModel,
  type UsageSnapshotUnified,
  type UsageWindowUnified,
  registerTokenSource,
  resetTokenSourceRegistry,
} from './token-source'
import { readUsage, type UsageSnapshot, type UsageWindow } from './usage'
import { readGlmUsage, type GlmUsageSnapshot, type GlmUsageWindow, type GlmMonthlyWindow } from './glm-usage'
import type { AgentReasoningEffort } from './agent-process'

const CODEX_EFFORTS: AgentReasoningEffort[] = ['xhigh', 'high', 'medium', 'low', 'minimal', 'none']
const CLAUDE_EFFORTS: AgentReasoningEffort[] = ['max', 'xhigh', 'high', 'medium', 'low']

const ANTHROPIC_ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
]

type Env = Record<string, string | undefined>

/** scrub 残留的 Anthropic 凭据 env(防 A 账号夹带 B 的 key) */
function scrubAnthropicEnv(base: Env): Env {
  const out: Env = { ...base }
  for (const k of ANTHROPIC_ENV_KEYS) delete out[k]
  return out
}

/** 'opus=X,sonnet=Y,haiku=Z' → {opus:X, sonnet:Y, haiku:Z} */
function parseSlots(slots?: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!slots) return out
  for (const pair of slots.split(',')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const k = pair.slice(0, eq).trim()
    const v = pair.slice(eq + 1).trim()
    if (k && v) out[k] = v
  }
  return out
}

/** 'a,b,c' → ['a','b','c'] */
function parseList(list?: string): string[] {
  if (!list) return []
  return list.split(',').map(s => s.trim()).filter(Boolean)
}

// ── usage → unified 转换 ─────────────────────────────────

function codexUsageToUnified(s: UsageSnapshot): UsageSnapshotUnified {
  if (s.state !== 'ok') {
    return {
      state: s.state === 'auth_failed' ? 'no_credentials'
        : s.state === 'no_credentials' ? 'no_credentials'
        : s.state === 'rate_limited' ? 'rate_limited'
        : 'network',
      windows: [],
    }
  }
  const windows: UsageWindowUnified[] = []
  if (s.fiveHour) windows.push(windowToUnified(s.fiveHour, 'fiveHour', '5h 窗口'))
  if (s.weekly) windows.push(windowToUnified(s.weekly, 'weekly', '周配额'))
  return { state: 'ok', planLabel: s.subscriptionType, windows, fetchedAt: s.fetchedAt }
}

function windowToUnified(w: UsageWindow, kind: string, label: string): UsageWindowUnified {
  return { kind, label, percent: w.percent, resetsAt: w.resetsAt, ...(w.durationMins != null ? {} : {}) }
}

function glmUsageToUnified(s: GlmUsageSnapshot): UsageSnapshotUnified {
  if (s.state !== 'ok') {
    return {
      state: s.state === 'no_credentials' ? 'no_credentials'
        : s.state === 'not_glm' ? 'not_applicable'
        : s.state === 'rate_limited' ? 'rate_limited'
        : 'network',
      windows: [],
      ...(s.state === 'network' && s.reason ? { reason: s.reason } : {}),
    }
  }
  const windows: UsageWindowUnified[] = []
  if (s.fiveHour) windows.push(glmWindowToUnified(s.fiveHour, 'fiveHour', '5h 窗口'))
  if (s.monthly) windows.push(glmMonthlyToUnified(s.monthly))
  return {
    state: 'ok',
    planLabel: s.level ? `${s.level} 套餐` : undefined,
    windows,
    fetchedAt: s.fetchedAt,
  }
}

function glmWindowToUnified(w: GlmUsageWindow, kind: string, label: string): UsageWindowUnified {
  return { kind, label, percent: w.percent, resetsAt: w.resetsAt }
}

function glmMonthlyToUnified(w: GlmMonthlyWindow): UsageWindowUnified {
  return {
    kind: 'monthly', label: '月度工具', percent: w.percent, resetsAt: w.resetsAt,
    ...(w.used != null ? { used: w.used } : {}),
    ...(w.total != null ? { total: w.total } : {}),
  }
}

// ── codex TokenSource(订阅 / OpenAI key) ────────────────

function buildCodexSource(id: string, cfg: TokenSourceConfig): TokenSource {
  const defaultModel = cfg.model?.trim() || 'gpt-5.6-sol'
  const modelIds = parseList(cfg.models).length ? parseList(cfg.models) : [defaultModel]
  const defaultEffort: AgentReasoningEffort =
    (cfg.effort as AgentReasoningEffort) || 'xhigh'
  const models: TokenSourceModel[] = modelIds.map(m => ({
    model: m,
    display: m,
    efforts: CODEX_EFFORTS,
    defaultEffort,
  }))
  return {
    id,
    agent: 'codex',
    display: cfg.display?.trim() || `Codex · ${defaultModel}`,
    capabilities: { resumeSessionAt: false, fork: false, hostAsk: true },
    models,
    defaultModel,
    spawnEnv(base: Env): Env {
      // codex 不需要 Anthropic 凭据 —— scrub 掉残留(防上个 claude 会话的 env 串号)
      const out: Env = scrubAnthropicEnv(base)
      Object.assign(out, config.codex.env)
      if (cfg.api_key) out.OPENAI_API_KEY = cfg.api_key
      return out
    },
    resolveSpawnModel(model: string): string {
      // codex 恢复下发具体 slug(取代 ~/.codex/config.toml 自治)
      return model
    },
    async readUsage(): Promise<UsageSnapshotUnified> {
      if (cfg.usage === 'none') return { state: 'not_applicable', windows: [] }
      return codexUsageToUnified(await readUsage())
    },
  }
}

// ── claude TokenSource(GLM/DeepSeek/reclaude/官方) ───────

function buildClaudeSource(id: string, cfg: TokenSourceConfig): TokenSource {
  const slots = parseSlots(cfg.slots)
  const defaultModel = cfg.model?.trim() || slots.opus || 'opus'
  const modelIds = parseList(cfg.models).length
    ? parseList(cfg.models)
    : [...new Set(Object.values(slots).filter(Boolean))]
  const defaultEffort: AgentReasoningEffort = (cfg.effort as AgentReasoningEffort) || 'max'
  const models: TokenSourceModel[] = (modelIds.length ? modelIds : [defaultModel]).map(m => ({
    model: m,
    display: m,
    efforts: CLAUDE_EFFORTS,
    defaultEffort,
  }))
  const hasBin = !!cfg.bin
  return {
    id,
    agent: 'claude',
    display: cfg.display?.trim() || `Claude · ${defaultModel}`,
    capabilities: { resumeSessionAt: true, fork: true, hostAsk: false },
    models,
    defaultModel,
    spawnEnv(base: Env): Env {
      // reclaude(bin 包装器):不注入凭据 env,走 bin 自己的链路
      if (hasBin) return { ...base, ...config.claude.env }
      // 第三方(base_url + token):scrub 残留 + 注入本 source 凭据 + slots
      const out = scrubAnthropicEnv(base)
      const merged = { ...config.claude.env }
      if (cfg.base_url) merged.ANTHROPIC_BASE_URL = cfg.base_url
      if (cfg.auth_token) merged.ANTHROPIC_AUTH_TOKEN = cfg.auth_token
      if (cfg.api_key) merged.ANTHROPIC_API_KEY = cfg.api_key
      if (slots.opus) merged.ANTHROPIC_DEFAULT_OPUS_MODEL = slots.opus
      if (slots.sonnet) merged.ANTHROPIC_DEFAULT_SONNET_MODEL = slots.sonnet
      if (slots.haiku) merged.ANTHROPIC_DEFAULT_HAIKU_MODEL = slots.haiku
      return { ...out, ...merged }
    },
    resolveSpawnModel(_model: string): string | undefined {
      // claude 用 SDK alias('opus'),真实上游模型靠 spawnEnv 注入的 DEFAULT_*_MODEL slots。
      // reclaude 同理(参数透传)。
      return 'opus'
    },
    async readUsage(): Promise<UsageSnapshotUnified> {
      if (cfg.usage === 'none') return { state: 'not_applicable', windows: [] }
      // GLM coding plan 额度(glm-usage 读 ~/.claude/settings.json,后续收口到 config)
      if (cfg.usage === 'glm-coding-plan') return glmUsageToUnified(await readGlmUsage())
      return { state: 'not_applicable', windows: [] }
    },
  }
}

// ── 从 config 构建并注册 ─────────────────────────────────

export function buildTokenSourcesFromConfig(): number {
  resetTokenSourceRegistry()
  let n = 0
  for (const [id, cfg] of Object.entries(config.token_sources)) {
    const src = cfg.agent === 'codex' ? buildCodexSource(id, cfg) : buildClaudeSource(id, cfg)
    registerTokenSource(src, { default: cfg.default === true })
    n++
  }
  return n
}
