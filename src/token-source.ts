/**
 * Token Source 抽象层 —— agent 的额度/凭据来源管理。
 *
 * 三层架构(本项目只管 agent + 飞书对接,token source 是现在抽象的部分):
 *
 *   飞书层(model/config 命令) ─┐
 *                              ├→ TokenSource 层(本文件,唯一真相源)
 *   Agent 进程层(codex/claude) ┘    ↓ spawnEnv / resolveSpawnModel / readUsage
 *                                   下发给 CodexProcess / ClaudeAgentProcess
 *
 * 一个 TokenSource = 一个账号(凭据)+ 该账号下可选的模型 + spawn 下发 + 额度查询。
 * 加新账号 = 注册一个 TokenSource;加新模型 = 该 source 的 models 加一项。
 * agent 层(codex/claude 进程)固定不变,token source 是其上的「来源标签」。
 */

import type { AgentReasoningEffort } from './agent-process'

export type TokenSourceAgent = 'claude' | 'codex'

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
  /** 唯一 id,如 'codex-sub' / 'glm' / 'deepseek' / 'reclaude' */
  id: string
  /** 绑定哪个 agent 进程(协议强制:claude 走 Anthropic,codex 走 OpenAI/app-server) */
  agent: TokenSourceAgent
  /** 面板/卡片展示名 */
  display: string
  capabilities: TokenSourceCapabilities
  /** 该账号可选模型;空 = 该 source 不暴露模型切换(走进程默认) */
  models: TokenSourceModel[]
  /** 默认模型 id(必须在 models 里,或 models 为空时表示用进程默认) */
  defaultModel: string

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
