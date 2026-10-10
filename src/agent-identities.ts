import { createHash } from 'node:crypto'
import {
  CLAUDE_EFFORT,
  DSH_BOOTSTRAP_EFFORT,
  isDshReasoningEffort,
  type AgentProvider,
  type AgentReasoningEffort,
} from './agent-process'
import {
  GROK_OFFICIAL_MAX_EFFORT,
  claudeModelEffort,
  claudeModelIsGrok,
} from './claude-models'
import { CODEX_EFFORT } from './codex-process'
import { codexModelEffort } from './codex-models'
import { config } from './config'
import { log } from './log'
import { listTokenSources, type TokenSource, type TokenSourceModel } from './token-source'

export type AgentIdentityStatus =
  | 'ready'
  | 'source_disabled'
  | 'catalog_loading'
  | 'catalog_failed'
  | 'model_unavailable'

export interface AgentIdentity {
  id: string
  displayName: string
  tokenSourceId: string
  tokenSourceDisplay: string
  provider: AgentProvider
  model: string
  modelDisplay: string
  defaultEffort: AgentReasoningEffort | null
  supportedEfforts: AgentReasoningEffort[]
  sourceDefault: boolean
  status: AgentIdentityStatus
  reason?: string
  spawnRevision?: string
}

export interface AgentSourceFailure {
  tokenSourceId: string
  display: string
  status: 'disabled' | 'loading' | 'failed' | 'models_miss'
  reason: string
}

export interface AgentIdentityCatalog {
  catalogGeneration: string
  identities: AgentIdentity[]
  sourceFailures: AgentSourceFailure[]
}

export function agentIdentityId(tokenSourceId: string, model: string): string {
  return `agent:${Buffer.from(`${tokenSourceId}${String.fromCharCode(0)}${model}`, 'utf8').toString('base64url')}`
}

export function getAgentIdentityCatalog(codexAccountId = 'default'): AgentIdentityCatalog {
  return buildAgentIdentityCatalog(identitySources(codexAccountId))
}

/** Skill 发现身份时惰性校验订阅；不修改 MD 使用的来源、模型目录或启用状态。 */
export function getAgentSkillIdentityCatalog(codexAccountId = 'default'): Promise<AgentIdentityCatalog> {
  return buildAgentSkillIdentityCatalog(identitySources(codexAccountId))
}

function identitySources(codexAccountId: string): TokenSource[] {
  return listTokenSources().map(source => source.forAccount?.(codexAccountId) ?? source)
}

export async function buildAgentSkillIdentityCatalog(sources: TokenSource[]): Promise<AgentIdentityCatalog> {
  const catalog = buildAgentIdentityCatalog(sources)
  const checks = await Promise.all(sources.filter(source => source.kind === 'claude-subscription').map(async source => {
    const existingFailure = catalog.sourceFailures.find(failure => failure.tokenSourceId === source.id)
    if (existingFailure) return existingFailure
    const reason = await subscriptionFailure(source)
    return reason === null ? null : { tokenSourceId: source.id, display: source.display, status: 'failed' as const, reason }
  }))
  const failures = checks.filter((failure): failure is AgentSourceFailure => failure !== null)
  const unavailable = new Set(failures.map(failure => failure.tokenSourceId))
  return identityCatalog(
    catalog.identities.filter(identity => !unavailable.has(identity.tokenSourceId)),
    [...catalog.sourceFailures.filter(failure => !unavailable.has(failure.tokenSourceId)), ...failures],
  )
}

function subscriptionFailure(source: TokenSource): Promise<string | null> {
  return readSubscriptionFailure(source)
}

async function readSubscriptionFailure(source: TokenSource): Promise<string | null> {
  let reason: string
  try {
    // accountInfo / supportedModels 可由本机登录信息返回；原生额度接口才实际检查当前订阅。
    const usage = await source.readUsage()
    if (usage.state === 'ok') return null
    reason = usage.reason ?? `订阅可用性查询失败：${usage.state}`
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error)
  }
  log(`agent identities ${source.id} MISS: ${reason}`)
  return reason
}

export function buildAgentIdentityCatalog(sources: TokenSource[]): AgentIdentityCatalog {
  const identities: AgentIdentity[] = []
  const sourceFailures: AgentSourceFailure[] = []
  for (const source of sources) collectSource(source, identities, sourceFailures)
  return identityCatalog(identities, sourceFailures)
}

function identityCatalog(identities: AgentIdentity[], sourceFailures: AgentSourceFailure[]): AgentIdentityCatalog {
  return {
    catalogGeneration: createHash('sha256')
      .update(JSON.stringify({ identities, sourceFailures }))
      .digest('hex')
      .slice(0, 16),
    identities,
    sourceFailures,
  }
}

function collectSource(
  source: TokenSource,
  identities: AgentIdentity[],
  failures: AgentSourceFailure[],
): void {
  const catalogState = source.modelCatalogState?.status
    ?? (!source.enabled ? 'disabled' : source.models.length > 0 ? 'ready' : 'idle')
  if (!source.enabled) {
    failures.push({ tokenSourceId: source.id, display: source.display, status: 'disabled', reason: '账号未启用' })
  } else if (catalogState === 'loading' || catalogState === 'idle') {
    failures.push({ tokenSourceId: source.id, display: source.display, status: 'loading', reason: '模型目录正在刷新' })
  } else if (catalogState === 'failed') {
    failures.push({
      tokenSourceId: source.id,
      display: source.display,
      status: 'failed',
      reason: source.modelCatalogState?.error ?? '模型目录刷新失败',
    })
  } else if (source.models.length === 0) {
    failures.push({ tokenSourceId: source.id, display: source.display, status: 'models_miss', reason: '模型目录为空' })
  }
  for (const model of source.models) identities.push(materializeIdentity(source, model, catalogState))
}

function materializeIdentity(source: TokenSource, model: TokenSourceModel, catalogState: string): AgentIdentity {
  let status: AgentIdentityStatus = 'ready'
  let reason: string | undefined
  if (!source.enabled) {
    status = 'source_disabled'
    reason = '所属 Token Source 未启用'
  } else if (catalogState === 'loading' || catalogState === 'idle') {
    status = 'catalog_loading'
    reason = '模型目录正在刷新'
  } else if (catalogState === 'failed') {
    status = 'catalog_failed'
    reason = source.modelCatalogState?.error ?? '模型目录刷新失败'
  } else if (model.unavailableReason || !model.efforts.length) {
    status = 'model_unavailable'
    reason = model.unavailableReason ?? 'effort MISS：上游未声明该后端支持的推理档位'
  }
  return {
    id: agentIdentityId(source.id, model.model),
    displayName: `${source.display} · ${model.display}`,
    tokenSourceId: source.id,
    tokenSourceDisplay: source.display,
    provider: source.agent,
    model: model.model,
    modelDisplay: model.display,
    defaultEffort: model.defaultEffort ?? defaultEffortFor(source, model),
    supportedEfforts: [...model.efforts],
    sourceDefault: comparableModel(source.defaultModel) === comparableModel(model.model),
    status,
    ...(reason ? { reason } : {}),
    spawnRevision: source.spawnRevision,
  }
}

/** 本地档位语义(与 session-model.ts 的主会话档位目录同源):目录未给默认档时
 *  按 fork 的档位约定补一个 —— DSH 取 `[deepseek-harness].effort`,缺省复用
 *  bootstrap 档(绝不静默回落到 Codex 的 max,避免委派 worker 与模型面板双标);
 *  grok 锁 GROK_OFFICIAL_MAX_EFFORT;其余 claude / codex 取 profile 档
 *  (claudeModelEffort / codexModelEffort),缺省 CLAUDE_EFFORT / CODEX_EFFORT。
 *  只在候选档落在该模型声明的 effort 词表内时才补(supportedEfforts 与
 *  defaultEffort 必须自洽);否则保持 null 交面板手动选择,不造词表外的档。 */
function defaultEffortFor(source: TokenSource, model: TokenSourceModel): AgentReasoningEffort | null {
  if (source.agent === 'dsh') {
    const configured = config.deepseek_harness?.effort
    if (isDshReasoningEffort(configured) && model.efforts.includes(configured)) return configured
    return model.efforts.includes(DSH_BOOTSTRAP_EFFORT) ? DSH_BOOTSTRAP_EFFORT : null
  }
  const candidate = source.agent === 'claude'
    ? claudeModelEffort(model.model)
      ?? (claudeModelIsGrok(model.model) || /(?:^|:)grok/i.test(model.model) ? GROK_OFFICIAL_MAX_EFFORT : CLAUDE_EFFORT)
    : codexModelEffort(model.model) ?? CODEX_EFFORT
  return model.efforts.includes(candidate) ? candidate : null
}

function comparableModel(value: string): string {
  return value.replace(/\[1m\]$/i, '').toLowerCase()
}
