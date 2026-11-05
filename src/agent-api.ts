import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Session } from './session'
import { AgentRequestUncertainError, type AgentService, type AgentPrincipal, type AgentRequestSnapshot } from './agent-service'
import { agentPrincipalContext } from './agent-context'
import { getAgentIdentityCatalog, type AgentIdentityCatalog } from './agent-identities'
import {
  agentRunOwner,
  PROJECT_AGENT_INPUT_ERROR,
  parseAgentAnswerRequest,
  parseAgentFollowUpRequest,
  parseAgentRunRequest,
  type AgentRunSnapshot,
} from './agent-run-types'
import { configureRelay, reloadRelays, testRelay } from './relay-config'
import type { RelayConfig } from './config'

const MAX_BODY_BYTES = 4 * 1024 * 1024

export interface AgentApiContext {
  service: AgentService
  authorizeSession(capability: string): Session | null
  authorizeProject?(capability: string, project: string): AgentPrincipal | null
  authorizeOperator?(capability: string, project: string): AgentPrincipal | null
}

export async function handleAgentRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  context: AgentApiContext,
): Promise<boolean> {
  if (url.pathname !== '/agents' && !url.pathname.startsWith('/agents/')) return false
  const send = (status: number, value: object): true => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(value))
    return true
  }
  const capability = bearerToken(req.headers.authorization)
  if (!capability) return send(401, { error: 'missing bearer capability' })
  let principal: AgentPrincipal | null
  try {
    const projects = url.searchParams.getAll('project')
    if (projects.length > 1 || (projects.length && !projects[0].trim())) return send(400, { error: 'invalid project selector' })
    const operatorReconcile = req.method === 'POST'
      && /^\/agents\/requests\/[^/]+\/reconcile$/.test(url.pathname)
    if (operatorReconcile && projects.length !== 1) return send(403, { error: 'operator reconciliation requires explicit project scope' })
    principal = projects.length
      ? operatorReconcile
        ? context.authorizeOperator?.(capability, projects[0]) ?? null
        : context.authorizeProject?.(capability, projects[0]) ?? null
      : authorizePrincipal(context, capability)
  } catch (error) { return send(409, { error: messageOf(error) }) }
  if (!principal) return send(403, { error: 'invalid or stale agent capability' })

  // Relay maintenance is allowed only from a session-bound Agent capability;
  // project workers must not mutate the daemon's global configuration.
  if (url.pathname.startsWith('/agents/relays/')) {
    if (principal.kind !== 'session' && agentPrincipalContext(principal).owner.kind !== 'session') {
      return send(403, { error: 'relay configuration requires a session-bound Agent capability' })
    }
    try {
      if (req.method === 'POST' && url.pathname === '/agents/relays/test') {
        const input = parseRelayRequest(await readJsonBody(req))
        const tested = await testRelay(input.config)
        return send(200, { ok: true, site_id: input.siteId, protocol: tested.protocol,
          base_url: tested.base_url, models: tested.models.map(model => ({ id: model.id, display: model.display,
            ...(model.efforts ? { efforts: model.efforts } : {}), ...(model.defaultEffort ? { default_effort: model.defaultEffort } : {}) })) })
      }
      if (req.method === 'POST' && url.pathname === '/agents/relays/configure') {
        const input = parseRelayRequest(await readJsonBody(req))
        await configureRelay(input.siteId, input.config)
        return send(200, { ok: true, site_id: input.siteId, sources: await reloadRelays(input.siteId) })
      }
      if (req.method === 'POST' && url.pathname === '/agents/relays/reload') {
        const body = await readJsonBody(req)
        const siteId = body && typeof body === 'object' && !Array.isArray(body)
          && typeof (body as Record<string, unknown>).site_id === 'string'
          ? String((body as Record<string, unknown>).site_id).trim() : undefined
        return send(200, { ok: true, sources: await reloadRelays(siteId || undefined) })
      }
    } catch (error) {
      return send(409, { error: messageOf(error) })
    }
    return send(405, { error: 'unsupported relay endpoint' })
  }

  if (req.method === 'GET' && url.pathname === '/agents/identities') {
    return send(200, serializeCatalog(getAgentIdentityCatalog(agentPrincipalContext(principal).codexAccountId)))
  }
  if (req.method === 'GET' && url.pathname === '/agents/project-binding') {
    try {
      return send(200, context.service.getProjectBinding(principal))
    } catch (error) { return send(409, { error: messageOf(error) }) }
  }
  if (req.method === 'POST' && url.pathname === '/agents/runs') {
    try {
      const body = await readJsonBody(req)
      const expectedBinding = optionalExpectedBinding(body)
      if (expectedBinding) context.service.assertProjectBinding(principal, expectedBinding)
      const run = await context.service.startRun(principal, parseAgentRunRequest(body), expectedBinding
        ? { expectedBinding, requestBody: body }
        : undefined)
      return send(202, serializeRun(run))
    } catch (error) {
      return send(error instanceof AgentRequestUncertainError ? 503 : 409, { error: messageOf(error) })
    }
  }
  const requestMatch = url.pathname.match(/^\/agents\/requests\/([^/]+)(?:\/(reconcile))?$/)
  if (requestMatch) {
    const requestId = decodeRunId(requestMatch[1])
    if (!requestId) return send(400, { error: 'invalid agent request id encoding' })
    try {
      if (!requestMatch[2] && req.method === 'GET') {
        const expectedBinding = requiredExpectedBindingQuery(url)
        return send(200, serializeRequest(context.service.getRequest(principal, requestId, expectedBinding)))
      }
      if (!requestMatch[2] && req.method === 'DELETE') {
        const expectedBinding = requiredExpectedBindingQuery(url)
        return send(200, serializeRequest(await context.service.cancelRequest(principal, requestId, expectedBinding)))
      }
      if (requestMatch[2] === 'reconcile' && req.method === 'POST') {
        const body = reconcileBody(await readJsonBody(req))
        context.service.assertProjectBinding(principal, body.expectedBinding)
        return send(200, serializeRequest(context.service.reconcileRequest(principal, requestId, body.expectedBinding, {
          stopped: true,
          reason: body.reason,
        })))
      }
    } catch (error) {
      const message = messageOf(error)
      return send(message.startsWith('agent request not found:') ? 404 : 409, { error: message })
    }
    return send(405, { error: 'unsupported agent request endpoint' })
  }
  const match = url.pathname.match(/^\/agents\/runs\/([^/]+)(?:\/(follow-up|answer))?$/)
  if (!match) return send(405, { error: 'unsupported agent endpoint' })
  const runId = decodeRunId(match[1])
  if (!runId) return send(400, { error: 'invalid agent run id encoding' })
  const action = match[2]
  try {
    if (!action && req.method === 'GET') {
      return send(200, serializeRun(context.service.getRun(principal, runId)))
    }
    if (!action && req.method === 'DELETE') {
      const cancelled = await context.service.cancelRun(principal, runId, 'cancelled by agent client')
      return send(cancelled ? 200 : 409, cancelled
        ? { ok: true, run_id: runId }
        : { error: 'agent run is already terminal', run_id: runId })
    }
    if (action === 'follow-up' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const expectedBinding = optionalExpectedBinding(body)
      if (expectedBinding) context.service.assertProjectBinding(principal, expectedBinding)
      const run = await context.service.followUp(principal, runId, parseAgentFollowUpRequest(body), expectedBinding
        ? { expectedBinding, requestBody: body }
        : undefined)
      return send(202, serializeRun(run))
    }
    if (action === 'answer' && req.method === 'POST') {
      if (agentPrincipalContext(principal).owner.kind === 'project') return send(409, { error: PROJECT_AGENT_INPUT_ERROR })
      const run = await context.service.answer(principal, runId, parseAgentAnswerRequest(await readJsonBody(req)))
      return send(200, serializeRun(run))
    }
  } catch (error) {
    return send(error instanceof AgentRequestUncertainError ? 503 : 409, { error: messageOf(error) })
  }
  return send(405, { error: 'unsupported agent endpoint' })
}

function parseRelayRequest(value: unknown): { siteId: string; config: RelayConfig } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('relay request must be an object')
  const body = value as Record<string, unknown>
  const siteId = typeof body.site_id === 'string' ? body.site_id.trim() : ''
  const protocol = typeof body.protocol === 'string' ? body.protocol.trim().toLowerCase() : ''
  const baseUrl = typeof body.base_url === 'string' ? body.base_url.trim() : ''
  const apiKey = typeof body.api_key === 'string' ? body.api_key : ''
  if (!siteId || !/^[\w.-]{1,96}$/.test(siteId)) throw new Error('invalid relay site_id')
  if (protocol !== 'anthropic' && protocol !== 'openai') throw new Error('relay protocol must be anthropic or openai')
  if (!baseUrl || !apiKey) throw new Error('relay base_url and api_key are required')
  const balanceScript = typeof body.balance_script === 'string' ? body.balance_script.trim() : undefined
  const display = typeof body.display === 'string' ? body.display.trim() : undefined
  return { siteId, config: { protocol, base_url: baseUrl, api_key: apiKey,
    ...(display ? { display } : {}), ...(balanceScript ? { balance_script: balanceScript } : {}) } }
}

function authorizePrincipal(context: AgentApiContext, capability: string): AgentPrincipal | null {
  const session = context.authorizeSession(capability)
  if (session) return context.service.rootPrincipal(session)
  return context.service.principalForCapability(capability)
}

function decodeRunId(value: string): string | null {
  try { return decodeURIComponent(value) }
  catch { return null }
}

function bearerToken(header: string | undefined): string {
  return header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? ''
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let raw = ''
  req.setEncoding('utf8')
  for await (const chunk of req) {
    raw += chunk
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`)
  }
  try { return JSON.parse(raw || '{}') }
  catch { throw new Error('bad json') }
}

function serializeCatalog(catalog: AgentIdentityCatalog): object {
  return {
    catalog_generation: catalog.catalogGeneration,
    identities: catalog.identities.map(identity => ({
      id: identity.id,
      display_name: identity.displayName,
      token_source_id: identity.tokenSourceId,
      token_source_display: identity.tokenSourceDisplay,
      provider: identity.provider,
      model: identity.model,
      model_display: identity.modelDisplay,
      default_effort: identity.defaultEffort,
      supported_efforts: identity.supportedEfforts,
      source_default: identity.sourceDefault,
      status: identity.status,
      reason: identity.reason,
    })),
    source_failures: catalog.sourceFailures.map(failure => ({
      token_source_id: failure.tokenSourceId,
      display: failure.display,
      status: failure.status,
      reason: failure.reason,
    })),
  }
}

export function serializeAgentRun(run: AgentRunSnapshot): object {
  return serializeRun(run)
}

function serializeRequest(request: AgentRequestSnapshot): object {
  return {
    request_id: request.requestId,
    state: request.state,
    run_id: request.runId,
    ...(request.run ? { run: serializeRun(request.run) } : {}),
    ...(request.resolution ? { resolution: request.resolution } : {}),
  }
}

function optionalExpectedBinding(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = (raw as Record<string, unknown>).expected_binding
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f]/.test(value)) throw new Error('invalid expected_binding')
  return value.trim()
}

function requiredExpectedBindingQuery(url: URL): string {
  const values = url.searchParams.getAll('expected_binding')
  if (values.length !== 1 || !values[0]!.trim() || /[\x00-\x1f]/.test(values[0]!)) {
    throw new Error('expected_binding is required exactly once')
  }
  return values[0]!.trim()
}

function reconcileBody(raw: unknown): { expectedBinding: string; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('request reconciliation body must be an object')
  const value = raw as Record<string, unknown>
  const allowed = new Set(['expected_binding', 'stopped', 'reason'])
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('request reconciliation contains unknown fields')
  const expectedBinding = optionalExpectedBinding(value)
  if (!expectedBinding) throw new Error('request reconciliation requires expected_binding')
  if (value.stopped !== true) throw new Error('request reconciliation requires stopped=true')
  if (typeof value.reason !== 'string' || !value.reason.trim()) throw new Error('request reconciliation requires reason')
  return { expectedBinding, reason: value.reason }
}

function serializeRun(run: AgentRunSnapshot): object {
  return {
    run_id: run.runId,
    binding: agentRunOwner(run).kind,
    ...(agentRunOwner(run).kind === 'project' ? { project: agentRunOwner(run).name } : { session_name: run.sessionName }),
    ...(run.requestId ? { request_id: run.requestId } : {}),
    work_dir: run.workDir,
    prompt: run.prompt,
    description: run.description,
    parent_run_id: run.parentRunId,
    resumed_from_run_id: run.resumedFromRunId,
    parent_kind: run.parentKind,
    depth: run.depth,
    status: run.status,
    workers: run.workers.map(worker => ({
      identity_id: worker.identityId,
      identity_name: worker.identityName,
      token_source_id: worker.tokenSourceId,
      provider: worker.provider,
      model: worker.model,
      effort: worker.effort,
      status: worker.status,
      output: worker.output,
      ...(worker.finalOutput !== undefined ? { final_output: worker.finalOutput } : {}),
      output_truncated: worker.outputTruncated,
      session_id: worker.sessionId,
      checkpoint_id: worker.checkpointId,
      pending_input: worker.pendingInput && {
        request_id: worker.pendingInput.requestId,
        tool_use_id: worker.pendingInput.toolUseId,
        questions: worker.pendingInput.questions,
      },
      queued_reason: worker.queuedReason,
      steps: worker.steps,
      error: worker.error,
      started_at: worker.startedAt,
      finished_at: worker.finishedAt,
      duration_ms: worker.durationMs,
      usage: worker.usage,
    })),
    created_at: run.createdAt,
    finished_at: run.finishedAt,
    error: run.error,
    presentation_errors: run.presentationErrors,
    card_message_id: run.cardMessageId,
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
