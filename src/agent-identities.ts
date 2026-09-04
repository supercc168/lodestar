import { createHash } from 'node:crypto'
import { CLAUDE_EFFORT, type AgentProvider, type AgentReasoningEffort } from './agent-process'
import {
  GROK_OFFICIAL_MAX_EFFORT,
  claudeModelEffort,
  claudeModelIsGrok,
} from './claude-models'
import { CODEX_EFFORT } from './codex-process'
import { codexModelEffort } from './codex-models'
import { listTokenSources, type TokenSource } from './token-source'

export type AgentIdentityStatus = 'ready' | 'source_disabled'

export interface AgentIdentity {
  id: string
  displayName: string
  tokenSourceId: string
  tokenSourceDisplay: string
  provider: AgentProvider
  model: string
  modelDisplay: string
  defaultEffort: AgentReasoningEffort
  supportedEfforts: AgentReasoningEffort[]
  sourceDefault: boolean
  status: AgentIdentityStatus
  reason?: string
}

export interface AgentSourceFailure {
  tokenSourceId: string
  display: string
  status: 'disabled' | 'models_miss'
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

export function getAgentIdentityCatalog(): AgentIdentityCatalog {
  return buildAgentIdentityCatalog(listTokenSources())
}

export function buildAgentIdentityCatalog(sources: TokenSource[]): AgentIdentityCatalog {
  const identities: AgentIdentity[] = []
  const sourceFailures: AgentSourceFailure[] = []
  for (const source of sources) collectSource(source, identities, sourceFailures)
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
  if (!source.enabled()) {
    failures.push({
      tokenSourceId: source.id,
      display: source.displayName,
      status: 'disabled',
      reason: '档位未配置凭据',
    })
  }
  identities.push(materializeIdentity(source))
}

function materializeIdentity(source: TokenSource): AgentIdentity {
  const model = source.selectionModel
  const defaultEffort = defaultEffortFor(source)
  const ready = source.enabled()
  return {
    id: agentIdentityId(source.id, model),
    displayName: source.displayName,
    tokenSourceId: source.id,
    tokenSourceDisplay: source.displayName,
    provider: source.provider,
    model,
    modelDisplay: source.resolveSpawnModel() ?? model,
    defaultEffort,
    supportedEfforts: [defaultEffort],
    sourceDefault: true,
    status: ready ? 'ready' : 'source_disabled',
    ...(ready ? {} : { reason: '所属档位未配置凭据' }),
  }
}

function defaultEffortFor(source: TokenSource): AgentReasoningEffort {
  if (source.provider === 'claude') {
    const configured = claudeModelEffort(source.selectionModel)
    if (configured) return configured
    if (claudeModelIsGrok(source.selectionModel) || /(?:^|:)grok/i.test(source.selectionModel)) {
      return GROK_OFFICIAL_MAX_EFFORT
    }
    return CLAUDE_EFFORT
  }
  const configured = codexModelEffort(source.selectionModel)
  if (configured) return configured
  return CODEX_EFFORT
}
