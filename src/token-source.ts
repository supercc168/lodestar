/**
 * Token Source 抽象层 —— agent 的额度/凭据来源管理。
 *
 * 三层架构:
 *
 *   飞书层(model 面板 = 唯一入口) ─┐
 *                                   ├→ TokenSource 层(本文件,唯一真相源)
 *   Agent 进程层(codex/claude)     ┘    ↓ spawnEnv / resolveSpawnModel / readUsage
 *                                        下发给 CodexProcess / ClaudeAgentProcess
 *
 * 固定几种 TokenSourceKind(代码实现,不再泛化 add):
 *   - codex-subscription:本地 codex login 的 ChatGPT 订阅(model/list 拉模型、rateLimits 拉额度)
 *   - glm-coding-plan:GLM Coding Plan 订阅(/paas/v4/models 拉模型、quota/limit 拉额度)
 * 每种一个实例,差异只是 enabled(配没配凭据)。model 面板列全部 kind:
 * 已启用=可选+真实模型/额度;未配置=灰显+就地启用。config 命令已移除。
 */

import type { AgentReasoningEffort } from './agent-process'

export type TokenSourceAgent = 'claude' | 'codex'

/** 固定的 token source 种类(代码实现,非用户泛化 add)。加新种类 = 新增一枚 + 实现它的拉模型/额度。 */
export type TokenSourceKind = 'codex-subscription' | 'glm-coding-plan'

export interface TokenSourceCapabilities {
  /** 支持 resumeSessionAt / fork(claude=true, codex=false —— codex 无此能力) */
  resumeSessionAt: boolean
  fork: boolean
  /** host-ask marker(codex=true 走 askusr;claude 走 SDK AskUserQuestion) */
  hostAsk: boolean
}

/** 该账号下可选的具体模型(codex 订阅 7 个、glm 账号多个) */
export interface TokenSourceModel {
  /** 下发给进程或映射到 slot 的 model id,如 'gpt-5.6-sol' / 'glm-5.2[1m]' */
  model: string
  display: string
  efforts: AgentReasoningEffort[]
  defaultEffort: AgentReasoningEffort
}

// ── 统一用量(codex 5h/weekly、glm 5h/monthly、claude weekly 归一) ────────

export interface UsageWindowUnified {
  /** 'fiveHour' | 'weekly' | 'monthly' | ... */
  kind: string
  /** 展示标签:'5h 窗口' / '周配额' / '月度工具' */
  label: string
  percent: number | null
  resetsAt: Date | null
  /** 月度绝对值(TIME_LIMIT 才有) */
  used?: number
  total?: number
}

export type UsageStateUnified =
  | 'ok'
  | 'no_credentials'
  | 'not_applicable'   // 该 source 无额度查询(如 deepseek/reclaude)
  | 'rate_limited'
  | 'network'

export interface UsageSnapshotUnified {
  state: UsageStateUnified
  /** 套餐/计划标签:'ChatGPT Pro' / 'GLM Max 套餐' */
  planLabel?: string
  windows: UsageWindowUnified[]
  reason?: string
  fetchedAt?: number
}

// ── TokenSource 接口 ─────────────────────────────────────

export interface TokenSource {
  /** 固定种类的实例 id('codex-sub' / 'glm') */
  id: string
  /** 固定种类(决定模型/额度怎么拉、凭据怎么配) */
  kind: TokenSourceKind
  /** 绑定哪个 agent 进程(协议强制:claude 走 Anthropic,codex 走 OpenAI/app-server) */
  agent: TokenSourceAgent
  /** 面板/卡片展示名 */
  display: string
  capabilities: TokenSourceCapabilities
  /** 配没配凭据(面板据此决定可选 vs 灰显「启用」)。廉价同步信号:
   *  codex 看 ~/.codex 登录态;glm 看 config 有没有 token。精确有效性在 spawn/查额度时暴露。 */
  enabled: boolean
  /** 该账号可选模型(面板枚举用)。启动 refreshModels() 拉网填充;拉前/失败为空 → 面板 MISS。 */
  models: TokenSourceModel[]
  /** 默认模型 id(models 为空时表示用进程默认) */
  defaultModel: string

  /** 启动/刷新时拉模型填 models。失败如实留空(MISS),绝不假数据。 */
  refreshModels(): Promise<void>

  /**
   * 构造 spawn 子进程 env:先 scrub 残留凭据 env(防串号 —— 绝不让 A 账号夹带 B 的 key),
   * 再注入本 source 的凭据。base 通常是 {...process.env, PATH}。
   */
  spawnEnv(base: Record<string, string | undefined>): Record<string, string | undefined>
  /**
   * 下发给进程的 model。
   * codex: 具体 slug(如 'gpt-5.6-sol')下发到 threadParams;
   * claude: SDK alias(如 'opus'),真实上游模型靠 spawnEnv 注入的 DEFAULT_*_MODEL slots。
   * undefined = 不下发(走进程原生配置)。
   */
  resolveSpawnModel(model: string): string | undefined

  /** 查额度,归一 unified;查不到如实 MISS(no_fallbacks,绝不假数据) */
  readUsage(): Promise<UsageSnapshotUnified>
}

// ── Registry ─────────────────────────────────────────────

const registry = new Map<string, TokenSource>()
let defaultId: string | null = null

export function registerTokenSource(s: TokenSource, opts?: { default?: boolean }): void {
  registry.set(s.id, s)
  if (opts?.default || defaultId === null) defaultId = s.id
}

export function getTokenSource(id: string | null | undefined): TokenSource | undefined {
  return id ? registry.get(id) : undefined
}

export function listTokenSources(): TokenSource[] {
  return [...registry.values()]
}

export function listTokenSourcesByAgent(agent: TokenSourceAgent): TokenSource[] {
  return listTokenSources().filter(s => s.agent === agent)
}

export function defaultTokenSourceId(): string | null {
  return defaultId
}

export function setDefaultTokenSource(id: string): void {
  if (registry.has(id)) defaultId = id
}

/** 仅供测试重置全局 registry,保证用例隔离。 */
export function resetTokenSourceRegistry(): void {
  registry.clear()
  defaultId = null
}
