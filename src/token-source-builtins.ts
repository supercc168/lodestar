/**
 * 两个固定 TokenSourceKind 的实现(代码内置,不再泛化 add):
 *
 *   codex-subscription — 本地 codex login 的 ChatGPT 订阅:
 *     模型 = app-server `model/list` 动态拉(per-model effort、过滤 hidden);
 *     额度 = account/rateLimits/read(真);enabled = ~/.codex/auth.json 在。
 *
 *   glm-coding-plan — GLM Coding Plan 订阅:
 *     模型 = 订阅固定覆盖内置(GLM-5.2[1m]/GLM-4.7;开放平台 /paas/v4/models 命名
 *     匹配不上 anthropic 端点要的大写+[1m],且是全集非 Coding Plan 覆盖,故不拉);
 *     额度 = quota/limit(真);enabled = config 有 base_url+token。
 *
 * daemon 启动调 buildTokenSourcesFromConfig() 注册这两枚 + 各自 refreshModels()
 * 拉模型填 models(失败留空 MISS)。model 面板据 enabled 显示可选 / 灰显「启用」。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { config, type TokenSourceConfig } from './config'
import {
  type TokenSource,
  type TokenSourceModel,
  type UsageSnapshotUnified,
  type UsageWindowUnified,
  registerTokenSource,
  resetTokenSourceRegistry,
  setDefaultTokenSource,
} from './token-source'
import { readUsage, type UsageSnapshot, type UsageWindow } from './usage'
import { readGlmUsage, type GlmUsageSnapshot, type GlmUsageWindow, type GlmMonthlyWindow } from './glm-usage'
import { fetchCodexModels } from './token-source-models'
import { log } from './log'
import type { AgentReasoningEffort } from './agent-process'

const CLAUDE_EFFORTS: AgentReasoningEffort[] = ['max', 'xhigh', 'high', 'medium', 'low']

const ANTHROPIC_ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
]

type Env = Record<string, string | undefined>

/** scrub 残留的 Anthropic 凭据 env(防 A 账号夹带 B 的 key)。 */
function scrubAnthropicEnv(base: Env): Env {
  const out: Env = { ...base }
  for (const k of ANTHROPIC_ENV_KEYS) delete out[k]
  return out
}

// ── GLM Coding Plan 订阅固定覆盖模型(内置;非动态拉,见文件头) ────────
const GLM_MODELS: TokenSourceModel[] = [
  { model: 'GLM-5.2[1m]', display: 'GLM-5.2 · 1M 上下文', efforts: CLAUDE_EFFORTS, defaultEffort: 'max' },
  { model: 'GLM-4.7', display: 'GLM-4.7', efforts: CLAUDE_EFFORTS, defaultEffort: 'max' },
]

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
  return { kind, label, percent: w.percent, resetsAt: w.resetsAt }
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

// ── codex-subscription(本地 ChatGPT login) ───────────────

/** codex 本地登录态:~/.codex/auth.json 存在即视为已配置(廉价同步信号;
 *  订阅是否有效在 account/rateLimits 查询时如实暴露 MISS)。 */
function codexLoggedIn(): boolean {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
  return existsSync(join(codexHome, 'auth.json'))
}

function buildCodexSubscriptionSource(): TokenSource {
  const enabled = codexLoggedIn()
  const ts: TokenSource = {
    id: 'codex-sub',
    kind: 'codex-subscription',
    agent: 'codex',
    display: 'Codex 订阅',
    capabilities: { resumeSessionAt: false, fork: false, hostAsk: true },
    enabled,
    models: [],
    defaultModel: 'gpt-5.5',
    async refreshModels(): Promise<void> {
      if (!ts.enabled) { ts.models = []; return }
      try {
        ts.models = await fetchCodexModels()
        if (ts.models.length) ts.defaultModel = ts.models[0].model
      } catch (e: any) {
        // MISS:拉取失败如实留空,绝不假数据。面板会显示空模型 + 失败态。
        log(`codex-sub refreshModels MISS: ${e?.message ?? e}`)
        ts.models = []
      }
    },
    spawnEnv(base: Env): Env {
      const out = scrubAnthropicEnv(base)
      Object.assign(out, config.codex.env)
      return out
    },
    resolveSpawnModel(model: string): string {
      // codex 下发具体 slug(取代 ~/.codex/config.toml 自治)
      return model
    },
    async readUsage(): Promise<UsageSnapshotUnified> {
      return codexUsageToUnified(await readUsage())
    },
  }
  return ts
}

// ── glm-coding-plan(第三方 anthropic 兼容端点) ──────────

function buildGlmCodingPlanSource(cfg: TokenSourceConfig): TokenSource {
  const baseUrl = cfg.base_url?.trim() || ''
  const token = cfg.auth_token?.trim() || ''
  const enabled = !!(baseUrl && token)
  const ts: TokenSource = {
    id: 'glm',
    kind: 'glm-coding-plan',
    agent: 'claude',
    display: 'GLM Coding Plan',
    capabilities: { resumeSessionAt: true, fork: true, hostAsk: false },
    enabled,
    models: enabled ? GLM_MODELS : [],
    defaultModel: 'GLM-5.2[1m]',
    async refreshModels(): Promise<void> {
      // Coding Plan 模型订阅固定覆盖,不动态拉(见文件头注释)。
      ts.models = ts.enabled ? GLM_MODELS : []
    },
    spawnEnv(base: Env): Env {
      const out = scrubAnthropicEnv(base)
      const merged = { ...config.claude.env }
      merged.ANTHROPIC_BASE_URL = baseUrl
      merged.ANTHROPIC_AUTH_TOKEN = token
      merged.ANTHROPIC_DEFAULT_OPUS_MODEL = 'GLM-5.2[1m]'
      merged.ANTHROPIC_DEFAULT_SONNET_MODEL = 'GLM-5.2[1m]'
      merged.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'GLM-4.7'
      return { ...out, ...merged }
    },
    resolveSpawnModel(_model: string): string | undefined {
      // claude 用 SDK alias('opus'),真实上游模型靠 spawnEnv 注入的 DEFAULT_*_MODEL。
      return 'opus'
    },
    async readUsage(): Promise<UsageSnapshotUnified> {
      // 额度查询走 ~/.claude/settings.json 的 GLM 凭据(glm-usage);
      // spawn 注入的 config.toml 凭据应与之保持同一份 token。
      return glmUsageToUnified(await readGlmUsage())
    },
  }
  return ts
}

// ── 从 config 构建并注册(固定两个 kind,无条件注册,enabled 决定面板态) ──

export function buildTokenSourcesFromConfig(): number {
  resetTokenSourceRegistry()
  const sources = [
    buildCodexSubscriptionSource(),
    buildGlmCodingPlanSource(config.token_sources['glm'] ?? {}),
  ]
  for (const s of sources) registerTokenSource(s)
  // default = 第一个 enabled 的(codex 优先);都未配置则保持 registry 默认(codex-sub)。
  const firstEnabled = sources.find(s => s.enabled)
  if (firstEnabled) setDefaultTokenSource(firstEnabled.id)
  return sources.length
}
