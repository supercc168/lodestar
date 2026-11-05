import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { AgentRunOwner, AgentRunSnapshot } from './agent-run-types'
import { agentOwnerKey } from './agent-run-types'
import { AGENT_REQUESTS_FILE } from './paths'
import { writeJsonStateAtomic } from './state-store'

const STORE_VERSION = 1

export type AgentRequestState = 'pending' | 'admitted' | 'cancel_requested' | 'cancelled' | 'unknown' | 'resolved'

export interface AgentProjectBinding {
  installation_id: string
  binding_id: string
  project: string
  chat_id: string
  work_dir: string
}

export interface AgentOperatorResolution {
  kind: 'operator_attested'
  reason: string
  at: string
  binding_id: string
}

export interface AgentRequestRecord {
  request_id: string
  binding_id: string
  owner_key: string
  project: string
  chat_id: string
  work_dir: string
  state: AgentRequestState
  body_hash?: string
  body?: unknown
  run_id?: string
  resolution?: AgentOperatorResolution
  created_at: string
  updated_at: string
}

interface AgentRequestStoreState {
  version: typeof STORE_VERSION
  installation_id: string
  bindings: Record<string, AgentProjectBinding>
  requests: Record<string, AgentRequestRecord>
}

export class AgentRequestStore {
  private readonly path: string | null
  private readonly state: AgentRequestStoreState

  constructor(options: { path?: string | null; installationId?: string } = {}) {
    this.path = options.path === undefined ? AGENT_REQUESTS_FILE : options.path
    if (this.path && existsSync(this.path)) {
      this.state = readStore(this.path)
      if (options.installationId && options.installationId !== this.state.installation_id) {
        throw new Error('agent request installation id does not match durable state')
      }
      return
    }
    this.state = {
      version: STORE_VERSION,
      installation_id: options.installationId ?? `installation_${randomUUID()}`,
      bindings: {},
      requests: {},
    }
    this.persist()
  }

  static memory(): AgentRequestStore {
    return new AgentRequestStore({ path: null })
  }

  getProjectBinding(owner: AgentRunOwner): AgentProjectBinding {
    assertProjectOwner(owner)
    const next = bindingFor(this.state.installation_id, owner)
    const previous = this.state.bindings[owner.name]
    if (!previous || previous.binding_id !== next.binding_id) {
      this.state.bindings[owner.name] = next
      try { this.persist() }
      catch (error) {
        if (previous) this.state.bindings[owner.name] = previous
        else delete this.state.bindings[owner.name]
        throw error
      }
    }
    return { ...next }
  }

  assertExpectedBinding(owner: AgentRunOwner, expectedBinding: string): AgentProjectBinding {
    if (!expectedBinding || expectedBinding.length > 200 || /[\x00-\x1f]/.test(expectedBinding)) throw new Error('invalid expected_binding')
    const binding = this.getProjectBinding(owner)
    if (binding.binding_id !== expectedBinding) throw projectBindingChanged()
    return binding
  }

  prepareAdmission(
    owner: AgentRunOwner,
    requestId: string,
    expectedBinding: string | undefined,
    bodyHash: string,
    body: unknown,
  ): { binding: AgentProjectBinding; record: AgentRequestRecord; created: boolean } {
    assertRequestId(requestId)
    const binding = expectedBinding
      ? this.assertExpectedBinding(owner, expectedBinding)
      : this.getProjectBinding(owner)
    const existing = this.findForProject(owner.name, requestId)
    if (existing) {
      this.assertRecordBinding(existing, binding)
      if (existing.body_hash !== undefined && existing.body_hash !== bodyHash) {
        throw new Error('request_id was already used with different input')
      }
      return { binding, record: cloneRecord(existing), created: false }
    }
    const now = new Date().toISOString()
    const record: AgentRequestRecord = {
      request_id: requestId,
      binding_id: binding.binding_id,
      owner_key: agentOwnerKey(owner),
      project: binding.project,
      chat_id: binding.chat_id,
      work_dir: binding.work_dir,
      state: 'pending',
      body_hash: bodyHash,
      body,
      created_at: now,
      updated_at: now,
    }
    this.insertRecord(record)
    return { binding, record: cloneRecord(record), created: true }
  }

  lookup(owner: AgentRunOwner, requestId: string, expectedBinding: string): AgentRequestRecord | null {
    assertRequestId(requestId)
    const binding = this.assertExpectedBinding(owner, expectedBinding)
    const record = this.findForProject(owner.name, requestId)
    if (!record) return null
    this.assertRecordBinding(record, binding)
    return cloneRecord(record)
  }

  fenceCancellation(owner: AgentRunOwner, requestId: string, expectedBinding: string): AgentRequestRecord {
    assertRequestId(requestId)
    const binding = this.assertExpectedBinding(owner, expectedBinding)
    const existing = this.findForProject(owner.name, requestId)
    if (existing) {
      this.assertRecordBinding(existing, binding)
      if (existing.state === 'pending' || existing.state === 'admitted') {
        return this.updateRecord(existing, record => { record.state = 'cancel_requested' })
      }
      return cloneRecord(existing)
    }
    const now = new Date().toISOString()
    const record: AgentRequestRecord = {
      request_id: requestId,
      binding_id: binding.binding_id,
      owner_key: agentOwnerKey(owner),
      project: binding.project,
      chat_id: binding.chat_id,
      work_dir: binding.work_dir,
      state: 'cancelled',
      created_at: now,
      updated_at: now,
    }
    this.insertRecord(record)
    return cloneRecord(record)
  }

  markAdmitted(owner: AgentRunOwner, requestId: string, runId: string): AgentRequestRecord {
    const record = this.requireOwned(owner, requestId)
    return this.updateRecord(record, next => {
      next.run_id = runId
      if (next.state === 'pending') next.state = 'admitted'
    })
  }

  markCancelled(owner: AgentRunOwner, requestId: string, runId?: string): AgentRequestRecord {
    const record = this.requireOwned(owner, requestId)
    return this.updateRecord(record, next => {
      if (runId) next.run_id = runId
      next.state = 'cancelled'
    })
  }

  markUnknown(owner: AgentRunOwner, requestId: string, runId?: string): AgentRequestRecord {
    const record = this.requireOwned(owner, requestId)
    if (record.resolution || record.state === 'resolved' || record.state === 'cancelled') return cloneRecord(record)
    return this.updateRecord(record, next => {
      if (runId) next.run_id = runId
      next.state = 'unknown'
    })
  }

  markResolved(owner: AgentRunOwner, requestId: string, runId?: string): AgentRequestRecord {
    const record = this.requireOwned(owner, requestId)
    return this.updateRecord(record, next => {
      if (runId) next.run_id = runId
      next.state = 'resolved'
    })
  }

  reconcile(
    owner: AgentRunOwner,
    requestId: string,
    expectedBinding: string,
    input: { stopped: true; reason: string },
  ): AgentRequestRecord {
    const record = this.lookup(owner, requestId, expectedBinding)
    if (!record) throw new Error(`agent request not found: ${requestId}`)
    if (record.state !== 'unknown') throw new Error('only unknown Agent requests can be reconciled')
    if (input.stopped !== true) throw new Error('request reconciliation requires stopped=true')
    const reason = input.reason.trim()
    if (!reason || [...reason].length > 2_000) throw new Error('request reconciliation requires a reason of at most 2000 characters')
    const mutable = this.requireOwned(owner, requestId)
    return this.updateRecord(mutable, next => {
      next.state = 'resolved'
      next.resolution = {
        kind: 'operator_attested',
        reason,
        at: new Date().toISOString(),
        binding_id: expectedBinding,
      }
    })
  }

  blocksAdmission(owner: AgentRunOwner, requestId: string): boolean {
    const record = this.findForProject(owner.name, requestId)
    if (!record || record.owner_key !== agentOwnerKey(owner)) return false
    return record.state === 'cancel_requested' || record.state === 'cancelled'
  }

  importRun(snapshot: AgentRunSnapshot): void {
    if (!snapshot.requestId || !snapshot.requestHash) return
    const owner = snapshot.owner
    if (!owner || owner.kind !== 'project') return
    const binding = this.getProjectBinding(owner)
    const existing = this.findForProject(owner.name, snapshot.requestId)
    if (existing) {
      if (existing.binding_id !== binding.binding_id || existing.owner_key !== agentOwnerKey(owner)) return
      if (!existing.run_id) {
        this.updateRecord(existing, next => { next.run_id = snapshot.runId })
      }
      return
    }
    const now = new Date().toISOString()
    // Artifacts describe a result, not native process termination. Old runs
    // without a durable request fact must not gain an invented exit fact.
    this.insertRecord({
      request_id: snapshot.requestId,
      binding_id: binding.binding_id,
      owner_key: agentOwnerKey(owner),
      project: owner.name,
      chat_id: owner.chatId,
      work_dir: owner.workDir,
      state: 'unknown',
      body_hash: snapshot.requestHash,
      run_id: snapshot.runId,
      created_at: snapshot.createdAt,
      updated_at: snapshot.finishedAt ?? now,
    })
  }

  allRecords(): AgentRequestRecord[] {
    return Object.values(this.state.requests).map(cloneRecord)
  }

  private findForProject(project: string, requestId: string): AgentRequestRecord | undefined {
    return Object.values(this.state.requests).find(record => record.project === project && record.request_id === requestId)
  }

  private requireOwned(owner: AgentRunOwner, requestId: string): AgentRequestRecord {
    const record = this.findForProject(owner.name, requestId)
    if (!record || record.owner_key !== agentOwnerKey(owner)) throw new Error(`agent request not found: ${requestId}`)
    return record
  }

  private assertRecordBinding(record: AgentRequestRecord, binding: AgentProjectBinding): void {
    if (record.binding_id !== binding.binding_id
      || record.chat_id !== binding.chat_id
      || record.work_dir !== binding.work_dir) throw projectBindingChanged()
  }

  private insertRecord(record: AgentRequestRecord): void {
    const key = requestKey(record.binding_id, record.request_id)
    this.state.requests[key] = record
    try { this.persist() }
    catch (error) { delete this.state.requests[key]; throw error }
  }

  private updateRecord(record: AgentRequestRecord, update: (next: AgentRequestRecord) => void): AgentRequestRecord {
    const previous = cloneRecord(record)
    update(record)
    record.updated_at = new Date().toISOString()
    try { this.persist() }
    catch (error) {
      // Readers may only see committed facts, especially resolved/cancelled
      // and operator attestation. A failed rename leaves the old fact intact.
      this.state.requests[requestKey(record.binding_id, record.request_id)] = previous
      throw error
    }
    return cloneRecord(record)
  }

  private persist(): void {
    if (this.path) writeJsonStateAtomic(this.path, this.state)
  }
}

function bindingFor(installationId: string, owner: AgentRunOwner): AgentProjectBinding {
  assertProjectOwner(owner)
  const bindingId = `binding_${createHash('sha256')
    .update(JSON.stringify([installationId, owner.name, owner.chatId, owner.workDir]))
    .digest('base64url')}`
  return {
    installation_id: installationId,
    binding_id: bindingId,
    project: owner.name,
    chat_id: owner.chatId,
    work_dir: owner.workDir,
  }
}

function assertProjectOwner(owner: AgentRunOwner): asserts owner is AgentRunOwner & { kind: 'project' } {
  if (owner.kind !== 'project') throw new Error('project binding requires explicit project mode')
}

function requestKey(bindingId: string, requestId: string): string {
  return createHash('sha256').update(JSON.stringify([bindingId, requestId])).digest('hex')
}

function assertRequestId(requestId: string): void {
  if (!requestId || [...requestId].length > 200 || /[\x00-\x1f]/.test(requestId)) throw new Error('invalid request_id')
}

function cloneRecord(record: AgentRequestRecord): AgentRequestRecord {
  return structuredClone(record)
}

function projectBindingChanged(): Error {
  return new Error('project_binding_changed')
}

function readStore(path: string): AgentRequestStoreState {
  let value: unknown
  try { value = JSON.parse(readFileSync(path, 'utf8')) }
  catch (error) { throw new Error(`agent request state is unreadable (${path}): ${messageOf(error)}`) }
  if (!isStoreState(value)) throw new Error(`agent request state is invalid: ${path}`)
  return value
}

function isStoreState(value: unknown): value is AgentRequestStoreState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const state = value as Partial<AgentRequestStoreState>
  if (state.version !== STORE_VERSION || typeof state.installation_id !== 'string' || !state.installation_id
    || !plainObject(state.bindings) || !plainObject(state.requests)) return false
  return Object.entries(state.bindings).every(([project, binding]) => validBinding(binding)
      && binding.project === project && binding.installation_id === state.installation_id)
    && Object.entries(state.requests).every(([key, record]) => validRecord(record)
      && key === requestKey(record.binding_id, record.request_id)
      && record.owner_key === agentOwnerKey({
        kind: 'project', name: record.project, chatId: record.chat_id, workDir: record.work_dir,
      })
      && (record.body_hash === undefined || record.body === undefined
        || createHash('sha256').update(JSON.stringify(record.body)).digest('hex') === record.body_hash)
      && (record.resolution === undefined || record.resolution.binding_id === record.binding_id))
}

function validBinding(value: unknown): value is AgentProjectBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const binding = value as Partial<AgentProjectBinding>
  return ['installation_id', 'binding_id', 'project', 'chat_id', 'work_dir']
    .every(key => typeof binding[key as keyof AgentProjectBinding] === 'string'
      && !!binding[key as keyof AgentProjectBinding])
}

function validRecord(value: unknown): value is AgentRequestRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<AgentRequestRecord>
  return typeof record.request_id === 'string' && !!record.request_id
    && typeof record.binding_id === 'string' && !!record.binding_id
    && typeof record.owner_key === 'string' && typeof record.project === 'string'
    && typeof record.chat_id === 'string' && typeof record.work_dir === 'string'
    && ['pending', 'admitted', 'cancel_requested', 'cancelled', 'unknown', 'resolved'].includes(String(record.state))
    && typeof record.created_at === 'string' && typeof record.updated_at === 'string'
    && (record.body_hash === undefined || typeof record.body_hash === 'string')
    && (record.run_id === undefined || typeof record.run_id === 'string')
    && (record.resolution === undefined || !!record.resolution && record.resolution.kind === 'operator_attested'
      && typeof record.resolution.reason === 'string' && typeof record.resolution.at === 'string'
      && typeof record.resolution.binding_id === 'string')
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
