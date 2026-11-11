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
  /** 不对外列出、不能开新 run 的身份；仅供续接历史原生会话（如旧的 claude-sub 非 Opus 会话）。 */
  resumeOnly?: AgentIdentity[]
}

/** Lodestar Agent 的 Claude 订阅只开放 Opus 别名（跟随最新 Opus），两档思维：medium / max。
 *  只作用于委派 Agent 身份目录，不改 claude-sub Token Source 本身，也不影响主会话模型面板。 */
export const CLAUDE_SUB_AGENT_MODEL = 'opus'
export const CLAUDE_SUB_AGENT_EFFORTS = ['medium', 'max'] as const satisfies readonly AgentReasoningEffort[]
export const CLAUDE_SUB_AGENT_DEFAULT_EFFORT: AgentReasoningEffort = 'medium'
export const CLAUDE_SUB_EFFORT_ERROR = 'claude-sub 仅支持 medium / max'

export function claudeSubOpusIdentityId(tokenSourceId = 'claude-sub'): string {
  return agentIdentityId(tokenSourceId, CLAUDE_SUB_AGENT_MODEL)
}

export function isClaudeSubAgentEffort(value: unknown): value is (typeof CLAUDE_SUB_AGENT_EFFORTS)[number] {
  return typeof value === 'string' && (CLAUDE_SUB_AGENT_EFFORTS as readonly string[]).includes(value)
}

export function claudeSubEffortError(effort: string): string {
  return `${CLAUDE_SUB_EFFORT_ERROR}（收到 ${effort}）`
}

function decodeAgentIdentityId(id: string): { tokenSourceId: string; model: string } | undefined {
  if (!/^agent:[A-Za-z0-9_-]+$/.test(id)) return undefined
  const parts = Buffer.from(id.slice('agent:'.length), 'base64url').toString('utf8').split('\u0000')
  if (parts.length !== 2) return undefined
  const [tokenSourceId, model] = parts as [string, string]
  return agentIdentityId(tokenSourceId, model) === id ? { tokenSourceId, model } : undefined
}

/** 新 run 指定了 claude-sub 的非 Opus 身份时给出明确拒绝原因；其他身份返回 undefined。 */
export function claudeSubNewRunRejection(id: string): string | undefined {
  const decoded = decodeAgentIdentityId(id)
  if (!decoded || !isClaudeSubscriptionSource(decoded.tokenSourceId) || decoded.model === CLAUDE_SUB_AGENT_MODEL) return undefined
  return `claude-sub 只开放 Opus：请改用 ${claudeSubOpusIdentityId(decoded.tokenSourceId)}（${decoded.model} 不再用于新任务，仅可续接旧会话）`
}

export function agentIdentityId(tokenSourceId: string, model: string): string {
  return `agent:${Buffer.from(`${tokenSourceId}${String.fromCharCode(0)}${model}`, 'utf8').toString('base64url')}`
}

function isClaudeSubscriptionSource(tokenSourceId: string): boolean {
  return ['claude-sub', 'claude-subscription'].includes(tokenSourceId.toLowerCase())
}

// local/agent-claude-sub: owner opted in to let Lodestar Agent use their own Claude subscription.
export function isClaudeSubscriptionSourceId(tokenSourceId: string): boolean {
  return isClaudeSubscriptionSource(tokenSourceId)
}

export function assertAgentSourceAllowed(_tokenSourceId: string): void {}

/** Only interpret canonical IDs emitted by agentIdentityId; other IDs retain normal not-found handling. */
export function assertAgentIdentityIdAllowed(id: string): void {
  const decoded = decodeAgentIdentityId(id)
  if (!decoded) return
  assertAgentSourceAllowed(decoded.tokenSourceId)
}

export function getAgentIdentityCatalog(codexAccountId = 'default'): AgentIdentityCatalog {
  return buildAgentIdentityCatalog(identitySources(codexAccountId))
}

/** Skill 目录与其他 Agent 入口共用过滤规则；不修改主会话来源，也不查询订阅额度。 */
export function getAgentSkillIdentityCatalog(codexAccountId = 'default'): Promise<AgentIdentityCatalog> {
  return buildAgentSkillIdentityCatalog(identitySources(codexAccountId))
}

function identitySources(codexAccountId: string): TokenSource[] {
  return listTokenSources().map(source => source.forAccount?.(codexAccountId) ?? source)
}

export async function buildAgentSkillIdentityCatalog(sources: TokenSource[]): Promise<AgentIdentityCatalog> {
  return buildAgentIdentityCatalog(sources)
}

export function buildAgentIdentityCatalog(sources: TokenSource[]): AgentIdentityCatalog {
  const identities: AgentIdentity[] = []
  const sourceFailures: AgentSourceFailure[] = []
  const resumeOnly: AgentIdentity[] = []
  for (const source of sources) collectSource(source, identities, sourceFailures, resumeOnly)
  return identityCatalog(identities, sourceFailures, resumeOnly)
}

function identityCatalog(
  identities: AgentIdentity[], sourceFailures: AgentSourceFailure[], resumeOnly: AgentIdentity[],
): AgentIdentityCatalog {
  return {
    catalogGeneration: createHash('sha256')
      .update(JSON.stringify({ identities, sourceFailures }))
      .digest('hex')
      .slice(0, 16),
    identities,
    sourceFailures,
    ...(resumeOnly.length ? { resumeOnly } : {}),
  }
}

/** claude-sub：Opus 别名收窄到 medium / max（默认 medium）；其余模型只留作续接旧会话。 */
function applyClaudeSubPolicy(identity: AgentIdentity): AgentIdentity {
  const supportedEfforts: AgentReasoningEffort[] = identity.supportedEfforts.filter(isClaudeSubAgentEffort)
  const defaultEffort = supportedEfforts.includes(CLAUDE_SUB_AGENT_DEFAULT_EFFORT)
    ? CLAUDE_SUB_AGENT_DEFAULT_EFFORT : supportedEfforts[0] ?? null
  const unavailable = identity.status === 'ready' && !supportedEfforts.length
  return {
    ...identity,
    supportedEfforts,
    defaultEffort,
    ...(unavailable ? { status: 'model_unavailable' as const, reason: `${CLAUDE_SUB_EFFORT_ERROR}，上游未声明这两档` } : {}),
  }
}

function collectSource(
  source: TokenSource,
  identities: AgentIdentity[],
  failures: AgentSourceFailure[],
  resumeOnly: AgentIdentity[],
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
  if (isClaudeSubscriptionSource(source.id)) {
    for (const model of source.models) {
      const identity = materializeIdentity(source, model, catalogState)
      if (model.model === CLAUDE_SUB_AGENT_MODEL) identities.push(applyClaudeSubPolicy(identity))
      else resumeOnly.push(identity)
    }
    if (source.enabled && catalogState === 'ready' && source.models.length > 0
      && !source.models.some(model => model.model === CLAUDE_SUB_AGENT_MODEL)) {
      failures.push({ tokenSourceId: source.id, display: source.display, status: 'models_miss', reason: '模型目录缺少 opus 别名' })
    }
    return
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
