/**
 * TokenSource 适配层(Phase 1 slim)——把本地已验证的 claude-models / codex-models
 * 收敛成统一的「凭据 + 模型 + spawn 注入」入口,不引入上游 [token_source.*] TOML,
 * 不改飞书 model 面板 UX。
 *
 * 真相源仍是:
 *   - [claude.models.*] → claude-models.ts profiles
 *   - [codex.models.*]  → codex-models.ts profiles
 *   - 内建 login 档(fable/opus / gpt-5.6-sol)
 *
 * 本层职责:
 *   resolveTokenSource(provider, selection) → TokenSource
 *   source.spawnEnv / spawnOverrides / resolveSpawnModel / usageSource
 *
 * Claude spawn 语义与 ClaudeAgentProcess.buildSpawnEnv 历史行为一致:
 *   scrub ANTHROPIC_* + tier alias →(api 才)注入 profile env → tier env + GSD_RUNTIME。
 * Codex spawn 语义委托 codexSpawnOverrides(登录空覆盖 / api 注入 provider+key)。
 */

import type { AgentProvider, AgentUsageSource } from './agent-process'
import { usageSourceForAgent } from './agent-process'
import {
  CLAUDE_MODEL_ALIAS_KEYS,
  claudeModelConfigured,
  claudeModelEnv,
  claudeModelIsApiRoute,
  claudeModelProfile,
  claudeModelProfiles,
  claudeModelTierEnv,
  resolveClaudeSdkModel,
  type ClaudeModelProfile,
} from './claude-models'
import {
  codexModelConfigured,
  codexModelProfile,
  codexModelProfiles,
  codexSpawnOverrides,
  resolveCodexModelId,
  type CodexModelProfile,
} from './codex-models'

export type TokenSourceKind = 'login' | 'api'

/** spawn 侧 codex 覆盖(与 codexSpawnOverrides 同形)。 */
export interface TokenSourceCodexOverrides {
  modelId: string | undefined
  configArgs: string[]
  env: Record<string, string>
}

/**
 * 一个可选的「模型 + 凭据路由」槽位。id/selectionModel 与飞书面板 key 对齐
 * (claude:fable / claude:glm / gpt-5.6-sol / codex:<slug>)。
 */
export interface TokenSource {
  id: string
  kind: TokenSourceKind
  provider: AgentProvider
  displayName: string
  description: string
  /** 飞书 model 选择用的 key(与 FIXED_MODEL_CHOICES / codexModelChoices 一致)。 */
  selectionModel: string
  /** 是否已配好凭据(login 恒 true;api 看 profile.configured)。 */
  enabled(): boolean
  /** 发给 agent 进程的真实 model id(claude SDK / codex app-server)。 */
  resolveSpawnModel(): string | undefined
  /**
   * Claude:在 base env 上 scrub 后按 kind 注入,并锁 tier + GSD_RUNTIME。
   * Codex:合并 providerEnv + GSD_RUNTIME(完整 PATH/config 仍由 buildCodexSpawnEnv 叠)。
   */
  spawnEnv(base: Record<string, string>): Record<string, string>
  /** Codex 专用:configArgs + providerEnv + modelId。Claude 返回空覆盖。 */
  spawnOverrides(): TokenSourceCodexOverrides
  /** 控制台额度数据源(codex / glm / not_applicable)。 */
  usageSource(): AgentUsageSource
  /** Claude API 路由需绕开 reclaude 包装器;login 走 [claude] bin。 */
  isApiRoute(): boolean
}

const ANTHROPIC_SCRUB_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  ...CLAUDE_MODEL_ALIAS_KEYS,
] as const

/** 抹掉 ANTHROPIC 路由凭据与四档 tier alias,防 A 档残留夹带到 B 档。 */
export function scrubAnthropicEnv(base: Record<string, string>): Record<string, string> {
  const out = { ...base }
  for (const key of ANTHROPIC_SCRUB_KEYS) delete out[key]
  return out
}

function claudeSourceFromProfile(profile: ClaudeModelProfile): TokenSource {
  const selectionModel = profile.key
  return {
    id: profile.key,
    kind: profile.route,
    provider: 'claude',
    displayName: profile.displayName,
    description: profile.description,
    selectionModel,
    enabled: () => profile.configured,
    resolveSpawnModel: () => resolveClaudeSdkModel(selectionModel),
    spawnEnv(base) {
      const env = scrubAnthropicEnv(base)
      if (profile.route === 'api') Object.assign(env, claudeModelEnv(selectionModel))
      Object.assign(env, claudeModelTierEnv(selectionModel), { GSD_RUNTIME: 'claude' })
      return env
    },
    spawnOverrides: () => ({ modelId: undefined, configArgs: [], env: {} }),
    usageSource: () => usageSourceForAgent('claude', selectionModel),
    isApiRoute: () => profile.route === 'api',
  }
}

/** 未知/空 selection 的 Claude 回落:登录默认 Fable 5(与 resolveClaudeSdkModel 一致)。 */
function claudeFallbackSource(model: string | null | undefined): TokenSource {
  const selectionModel =
    model?.startsWith('claude:') && model !== 'claude:default' ? model : 'claude:fable'
  const kind: TokenSourceKind = claudeModelIsApiRoute(selectionModel) ? 'api' : 'login'
  return {
    id: selectionModel,
    kind,
    provider: 'claude',
    displayName: `Claude Code · ${selectionModel.replace(/^claude:/, '')}`,
    description: '',
    selectionModel,
    enabled: () => claudeModelConfigured(selectionModel),
    resolveSpawnModel: () => resolveClaudeSdkModel(selectionModel),
    spawnEnv(base) {
      const env = scrubAnthropicEnv(base)
      if (claudeModelIsApiRoute(selectionModel)) Object.assign(env, claudeModelEnv(selectionModel))
      Object.assign(env, claudeModelTierEnv(selectionModel), { GSD_RUNTIME: 'claude' })
      return env
    },
    spawnOverrides: () => ({ modelId: undefined, configArgs: [], env: {} }),
    usageSource: () => usageSourceForAgent('claude', selectionModel),
    isApiRoute: () => claudeModelIsApiRoute(selectionModel),
  }
}

function codexSourceFromProfile(profile: CodexModelProfile): TokenSource {
  const selectionModel = profile.key
  return {
    id: profile.key,
    kind: profile.route,
    provider: 'codex',
    displayName: profile.displayName,
    description: profile.description,
    selectionModel,
    enabled: () => profile.configured,
    resolveSpawnModel: () => profile.modelId || undefined,
    spawnEnv(base) {
      const overrides = codexSpawnOverrides(selectionModel)
      return { ...base, ...overrides.env, GSD_RUNTIME: 'codex' }
    },
    spawnOverrides: () => codexSpawnOverrides(selectionModel),
    usageSource: () => 'codex',
    isApiRoute: () => profile.route === 'api',
  }
}

/** 内建 / 裸 model id(gpt-5.6-sol 等)的 codex login source。 */
function codexLoginSource(model: string | null | undefined): TokenSource {
  const selectionModel = model?.trim() || 'gpt-5.6-sol'
  const id = selectionModel.startsWith('codex:') ? selectionModel : `codex-login:${selectionModel}`
  return {
    id,
    kind: 'login',
    provider: 'codex',
    displayName: `Codex · ${selectionModel}`,
    description: 'Codex 登录/默认档(无独立 [codex.models] 节)。',
    selectionModel,
    enabled: () => true,
    resolveSpawnModel: () => resolveCodexModelId(selectionModel),
    spawnEnv(base) {
      return { ...base, GSD_RUNTIME: 'codex' }
    },
    spawnOverrides: () => codexSpawnOverrides(selectionModel),
    usageSource: () => 'codex',
    isApiRoute: () => false,
  }
}

/**
 * 按当前会话 (provider, selectedModel) 解析 TokenSource。
 * 未命中 profile 时回落 login 默认,行为与 normalizeFixedModelSelection 一致:
 * 不会静默把未配置 api 档当成已鉴权。
 */
export function resolveTokenSource(
  provider: AgentProvider,
  model: string | null | undefined,
): TokenSource {
  if (provider === 'claude') {
    const profile = claudeModelProfile(model)
    if (profile) return claudeSourceFromProfile(profile)
    return claudeFallbackSource(model)
  }
  const profile = codexModelProfile(model)
  if (profile) return codexSourceFromProfile(profile)
  return codexLoginSource(model)
}

/** 当前配置下全部已知 source(claude 全 profiles + codex api profiles + 内建 login sol)。 */
export function listTokenSources(): TokenSource[] {
  const claude = claudeModelProfiles().map(claudeSourceFromProfile)
  const codexApi = codexModelProfiles().map(codexSourceFromProfile)
  const sol = codexLoginSource('gpt-5.6-sol')
  // sol 与可能的 codex:gpt-5.6-sol 去重
  const seen = new Set<string>()
  const out: TokenSource[] = []
  for (const s of [...claude, sol, ...codexApi]) {
    if (seen.has(s.id)) continue
    seen.add(s.id)
    out.push(s)
  }
  return out
}

/** Claude spawn 单入口:scrub + inject + tier + GSD_RUNTIME(供 ClaudeAgentProcess 调)。 */
export function resolveClaudeSpawnEnv(
  model: string | null | undefined,
  base: Record<string, string>,
): Record<string, string> {
  return resolveTokenSource('claude', model).spawnEnv(base)
}

/** Codex spawn 覆盖单入口(供 session.spawnAgent 调)。 */
export function resolveCodexSpawnOverrides(
  model: string | null | undefined,
): TokenSourceCodexOverrides {
  return resolveTokenSource('codex', model).spawnOverrides()
}

/** 与 usageSourceForAgent 对齐的便捷包装(会话/console 可统一走 source)。 */
export function resolveUsageSource(
  provider: AgentProvider,
  model: string | null | undefined,
): AgentUsageSource {
  return resolveTokenSource(provider, model).usageSource()
}
