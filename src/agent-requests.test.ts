import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRequestStore } from './agent-request-store'
import type { AgentIdentityCatalog } from './agent-identities'
import { AgentService, type AgentServiceDeps } from './agent-service'
import type { AgentExecutionContext } from './agent-context'
import type { AgentWorkerHandle, AgentWorkerResult } from './agent-runner'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'lodestar-agent-requests-')))
const projectRoot = join(root, 'project')
const otherRoot = join(root, 'other')
mkdirSync(projectRoot)
mkdirSync(otherRoot)
afterAll(() => rmSync(root, { recursive: true, force: true }))

const context = (name = 'project', chatId = 'chat-project', workDir = projectRoot): AgentExecutionContext => ({
  owner: { kind: 'project', name, chatId, workDir },
})

function completed(sessionId = 'native-request'): AgentWorkerResult {
  return { output: 'done', finalOutput: 'done', outputTruncated: false, sessionId, durationMs: 1, usage: null }
}

function resolvedHandle(value = completed()): AgentWorkerHandle {
  return { done: Promise.resolve(value), pendingInput: () => null, answer() {}, cancel: async () => {} }
}

function controlledHandle() {
  let resolve!: (value: AgentWorkerResult) => void
  let reject!: (error: Error) => void
  let alive = true
  const done = new Promise<AgentWorkerResult>((ok, fail) => { resolve = ok; reject = fail })
  return {
    handle: {
      done,
      pendingInput: () => null,
      answer() {},
      isAlive: () => alive,
      async cancel(reason = 'cancelled') {
        alive = false
        reject(new Error(reason))
        await done.catch(() => {})
      },
    } satisfies AgentWorkerHandle,
    resolve(value = completed()) { alive = false; resolve(value) },
  }
}

function harness(options: {
  storePath?: string
  sendCard?: AgentServiceDeps['sendCard']
  startWorker?: AgentServiceDeps['startWorker']
  loadArtifacts?: AgentServiceDeps['loadArtifacts']
  writeArtifact?: AgentServiceDeps['writeArtifact']
} = {}) {
  const storePath = options.storePath ?? join(root, `requests-${crypto.randomUUID()}.json`)
  const requestStore = new AgentRequestStore({ path: storePath })
  const catalog: AgentIdentityCatalog = { catalogGeneration: 'g1', sourceFailures: [], identities: [{
    id: 'agent:test', displayName: 'Test', tokenSourceId: 'glm', tokenSourceDisplay: 'GLM',
    provider: 'claude', model: 'GLM-5.3', modelDisplay: 'GLM', defaultEffort: 'max',
    supportedEfforts: ['max'], sourceDefault: true, status: 'ready',
  }] }
  const artifacts: any[] = []
  const texts = new Map<string, string>()
  const deps: AgentServiceDeps = {
    requestStore,
    getCatalog: () => catalog,
    startWorker: options.startWorker ?? (() => resolvedHandle()),
    sendCard: options.sendCard ?? (async () => 'message-request'),
    sendTextRaw: async () => true,
    getChatTailMessageId: async () => null,
    getElementCount: () => 1,
    addElementResult: async () => ({ landed: true }),
    deleteElementChecked: async () => true,
    convertMessageToCard: async () => 'card-request',
    recordCardCreated: () => {},
    replaceElementResult: async () => ({ landed: true }),
    cancelSummary: () => {},
    patchSettingsChecked: async () => true,
    dispose: async () => {},
    writeArtifact: options.writeArtifact ?? ((_path, value) => { artifacts.push(structuredClone(value)) }),
    writeTextArtifact: (path, value) => { texts.set(path, value) },
    readTextArtifact: (name, label) => {
      const value = [...texts].find(([path]) => path.endsWith(`/${name}`))?.[1]
      if (value === undefined) throw new Error(`${label} is unreadable (${name})`)
      return value
    },
    loadArtifacts: options.loadArtifacts ?? (() => []),
  }
  return { service: new AgentService(deps), requestStore, storePath, artifacts, catalog }
}

function request(requestId = 'request-1') {
  return { identityIds: ['agent:test'], description: '项目请求', prompt: 'perform work', requestId }
}

async function waitForRequest(service: AgentService, principal: ReturnType<AgentService['projectPrincipal']>, id: string, binding: string, state: string) {
  for (let i = 0; i < 200; i++) {
    const current = service.getRequest(principal, id, binding)
    if (current.state === state) return current
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error(`request ${id} did not reach ${state}`)
}

async function waitForRun(service: AgentService, principal: ReturnType<AgentService['projectPrincipal']>, runId: string, status: string) {
  for (let i = 0; i < 200; i++) {
    const current = service.getRun(principal, runId)
    if (current.status === status) return current
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error(`run ${runId} did not reach ${status}`)
}

async function waitForDurableState(h: ReturnType<typeof harness>, id: string, binding: string, state: string) {
  for (let i = 0; i < 200; i++) {
    const current = new AgentRequestStore({ path: h.storePath }).lookup(context().owner, id, binding)
    if (current?.state === state) return current
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error(`durable request ${id} did not reach ${state}`)
}

describe('project request binding and cancellation fence', () => {
  test.each(['lookup', 'replay'] as const)('%s repairs missing admission after storage recovers from worker completion failures', async observation => {
    let starts = 0
    let admissionWrites = 0
    const control = controlledHandle()
    const h = harness({ startWorker: () => { starts++; return control.handle } })
    const principal = h.service.projectPrincipal(context())
    const binding = h.service.getProjectBinding(principal).binding_id
    const id = `recover-completed-${observation}`
    const markAdmitted = h.requestStore.markAdmitted.bind(h.requestStore)
    h.requestStore.markAdmitted = () => { admissionWrites++; throw new Error('request storage unavailable') }
    await expect(h.service.startRun(principal, request(id), binding)).rejects.toThrow(/same request_id/)
    for (let i = 0; i < 200 && starts === 0; i++) await new Promise(resolve => setTimeout(resolve, 1))
    expect(starts).toBe(1)
    const originalRun = h.service.getRequest(principal, id, binding).run!
    const initialWrites = admissionWrites
    control.resolve(completed('native-confirmed-complete'))
    await waitForRun(h.service, principal, originalRun.runId, 'completed')
    for (let i = 0; i < 200 && admissionWrites === initialWrites; i++) await new Promise(resolve => setTimeout(resolve, 1))
    expect(admissionWrites).toBeGreaterThan(initialWrites)
    expect(control.handle.isAlive()).toBe(false)
    expect(h.service.getRequest(principal, id, binding)).toMatchObject({ state: 'pending', run: { status: 'completed' } })
    expect(new AgentRequestStore({ path: h.storePath }).lookup(context().owner, id, binding)?.run_id).toBeUndefined()

    h.requestStore.markAdmitted = markAdmitted
    if (observation === 'replay') {
      expect((await h.service.startRun(principal, request(id), binding)).runId).toBe(originalRun.runId)
    } else {
      expect(h.service.getRequest(principal, id, binding)).toMatchObject({ state: 'resolved', run: { runId: originalRun.runId } })
    }
    expect(new AgentRequestStore({ path: h.storePath }).lookup(context().owner, id, binding)).toMatchObject({
      state: 'resolved', run_id: originalRun.runId,
    })
    const terminal = h.service.getRun(principal, originalRun.runId)
    const reloaded = harness({ storePath: h.storePath, loadArtifacts: () => [structuredClone(terminal)],
      startWorker: () => { throw new Error('recovery must not start a second worker') } })
    expect(reloaded.service.getRequest(reloaded.service.projectPrincipal(context()), id, binding)).toMatchObject({
      state: 'resolved', run: { runId: originalRun.runId, status: 'completed', workers: [{ finalOutput: 'done' }] },
    })
    expect(starts).toBe(1)
  })

  test('a repeatedly failed admission write still exposes and cancels the same live native run', async () => {
    let starts = 0
    const control = controlledHandle()
    const h = harness({ startWorker: () => { starts++; return control.handle } })
    const principal = h.service.projectPrincipal(context())
    const binding = h.service.getProjectBinding(principal).binding_id
    const markAdmitted = h.requestStore.markAdmitted.bind(h.requestStore)
    h.requestStore.markAdmitted = () => { throw new Error('request storage unavailable') }
    await expect(h.service.startRun(principal, request('unwritten-admission'), binding)).rejects.toThrow(/same request_id/)
    for (let i = 0; i < 200 && starts === 0; i++) await new Promise(resolve => setTimeout(resolve, 1))
    const observed = h.service.getRequest(principal, 'unwritten-admission', binding)
    expect(observed).toMatchObject({ state: 'pending', runId: null, run: { requestId: 'unwritten-admission', status: 'running' } })
    const replay = await h.service.startRun(principal, request('unwritten-admission'), binding)
    expect(replay.runId).toBe(observed.run!.runId)
    expect(starts).toBe(1)
    h.requestStore.markAdmitted = markAdmitted
    const cancelled = await h.service.cancelRequest(principal, 'unwritten-admission', binding)
    expect(cancelled).toMatchObject({ state: 'cancelled', run: { runId: replay.runId, status: 'cancelled' } })
    expect(control.handle.isAlive()).toBe(false)
  })

  test('an action error after run creation retains request association and reports uncertainty', async () => {
    let starts = 0
    const h = harness({
      startWorker: () => { starts++; return resolvedHandle() },
      writeArtifact: () => { throw new Error('artifact storage unavailable') },
    })
    const principal = h.service.projectPrincipal(context())
    const binding = h.service.getProjectBinding(principal).binding_id
    await expect(h.service.startRun(principal, request('created-before-error'), binding)).rejects.toThrow(/same request_id/)
    const observed = h.service.getRequest(principal, 'created-before-error', binding)
    expect(observed.run?.requestId).toBe('created-before-error')
    expect(observed.state).toBe('admitted')
    const replay = await h.service.startRun(principal, request('created-before-error'), binding)
    expect(replay.runId).toBe(observed.run!.runId)
    expect(starts).toBe(0)
  })

  test('pre-admission rejection exposes a durable null runId without inventing a run', async () => {
    let starts = 0
    const h = harness({ startWorker: () => { starts++; return resolvedHandle() } })
    const principal = h.service.projectPrincipal(context())
    const binding = h.service.getProjectBinding(principal).binding_id
    await expect(h.service.startRun(principal, { ...request('known-unadmitted'), identityIds: ['agent:missing'] }, binding))
      .rejects.toThrow('agent identity not found')
    expect(h.service.getRequest(principal, 'known-unadmitted', binding)).toEqual({
      requestId: 'known-unadmitted', state: 'resolved', runId: null,
    })
    expect(starts).toBe(0)
  })

  test('binding response has the exact shared shape and installation identity survives restart', () => {
    const storePath = join(root, 'binding-persistence.json')
    const first = harness({ storePath })
    const principal = first.service.projectPrincipal(context())
    const binding = first.service.getProjectBinding(principal)
    expect(binding).toEqual({
      installation_id: expect.any(String), binding_id: expect.any(String),
      project: 'project', chat_id: 'chat-project', work_dir: projectRoot,
    })
    const reloaded = harness({ storePath })
    expect(reloaded.service.getProjectBinding(reloaded.service.projectPrincipal(context()))).toEqual(binding)
  })

  test('DELETE before POST durably fences the request and prevents a worker launch', async () => {
    let starts = 0
    const h = harness({ startWorker: () => { starts++; return resolvedHandle() } })
    const principal = h.service.projectPrincipal(context())
    const binding = h.service.getProjectBinding(principal).binding_id
    const cancelled = await h.service.cancelRequest(principal, 'cancel-first', binding)
    expect(cancelled.state).toBe('cancelled')
    await expect(h.service.startRun(principal, request('cancel-first'), binding)).rejects.toThrow(/cancel fence|cancelled/)
    expect(starts).toBe(0)
    expect(h.service.getRequest(principal, 'cancel-first', binding).state).toBe('cancelled')
  })

  test('DELETE concurrent with delayed admission drains creation without starting business work', async () => {
    let release!: () => void
    let entered!: () => void
    const cardEntered = new Promise<void>(resolve => { entered = resolve })
    const cardGate = new Promise<void>(resolve => { release = resolve })
    let starts = 0
    const h = harness({
      sendCard: async () => { entered(); await cardGate; return 'message-delayed' },
      startWorker: () => { starts++; return resolvedHandle() },
    })
    const principal = h.service.projectPrincipal(context())
    const binding = h.service.getProjectBinding(principal).binding_id
    const admitting = h.service.startRun(principal, request('lost-response'), binding)
    await cardEntered
    const cancelling = h.service.cancelRequest(principal, 'lost-response', binding)
    release()
    const [run, status] = await Promise.all([admitting, cancelling])
    expect(run.status).toBe('cancelled')
    expect(status.state).toBe('cancelled')
    expect(starts).toBe(0)
    expect((await waitForRequest(h.service, principal, 'lost-response', binding, 'cancelled')).run?.runId).toBe(run.runId)
  })

  test('another project owner cannot discover or cancel the original request', async () => {
    const control = controlledHandle()
    let cancelled = false
    let started = false
    const originalCancel = control.handle.cancel.bind(control.handle)
    control.handle.cancel = async reason => { cancelled = true; await originalCancel(reason) }
    const h = harness({ startWorker: () => { started = true; return control.handle } })
    const principal = h.service.projectPrincipal(context())
    const binding = h.service.getProjectBinding(principal).binding_id
    await h.service.startRun(principal, request('owner-isolated'), binding)
    for (let i = 0; i < 200 && !started; i++) await new Promise(resolve => setTimeout(resolve, 1))
    expect(started).toBe(true)

    const other = h.service.projectPrincipal(context('other', 'chat-other', otherRoot))
    const otherBinding = h.service.getProjectBinding(other).binding_id
    expect(() => h.service.getRequest(other, 'owner-isolated', otherBinding)).toThrow(/not found/)
    const otherFence = await h.service.cancelRequest(other, 'owner-isolated', otherBinding)
    expect(otherFence.state).toBe('cancelled')
    expect(cancelled).toBe(false)
    await h.service.cancelRequest(principal, 'owner-isolated', binding)
    expect(cancelled).toBe(true)
  })
})

describe('request recovery and operator attestation', () => {
  test('guarded operation envelopes retain the exact body and reject source changes across reconstruction', async () => {
    let starts = 0
    const first = harness({ startWorker: options => {
      starts++
      return resolvedHandle(completed(options.resumeSessionId ?? `native-source-${starts}`))
    } })
    const principal = first.service.projectPrincipal(context())
    const binding = first.service.getProjectBinding(principal).binding_id
    const sourceA = await first.service.startRun(principal, request('source-a'))
    const sourceB = await first.service.startRun(principal, request('source-b'))
    await waitForRun(first.service, principal, sourceA.runId, 'completed')
    await waitForRun(first.service, principal, sourceB.runId, 'completed')
    const input = { description: 'follow', prompt: 'continue', requestId: 'same-followup' }
    const body = { description: 'follow', prompt: 'continue', request_id: input.requestId, expected_binding: binding }
    const guard = { expectedBinding: binding, requestBody: body }
    const follow = await first.service.followUp(principal, sourceA.runId, input, guard)
    await waitForDurableState(first, input.requestId, binding, 'resolved')
    expect(first.requestStore.lookup(context().owner, input.requestId, binding)?.body).toEqual({
      operation: `follow-up:${sourceA.runId}`, requestBody: body,
    })
    await expect(first.service.followUp(principal, sourceB.runId, input, guard)).rejects.toThrow(/different input/)
    const snapshots = [sourceA, sourceB, follow].map(run => first.service.getRun(principal, run.runId))
    const reloaded = harness({ storePath: first.storePath, loadArtifacts: () => snapshots.map(snapshot => structuredClone(snapshot)),
      startWorker: () => { throw new Error('replay must not launch') } })
    const observer = reloaded.service.projectPrincipal(context())
    expect((await reloaded.service.followUp(observer, sourceA.runId, input, guard)).runId).toBe(follow.runId)
    await expect(reloaded.service.followUp(observer, sourceB.runId, input, guard)).rejects.toThrow(/different input/)
    await expect(reloaded.service.startRun(observer, { ...request(input.requestId), description: input.description, prompt: input.prompt }, guard)).rejects.toThrow(/different input/)
    expect(starts).toBe(3)
  })

  test('legacy guarded records without operation cannot replay by guessing their source', async () => {
    const h = harness()
    const principal = h.service.projectPrincipal(context())
    const binding = h.service.getProjectBinding(principal).binding_id
    const input = request('old-guard')
    const initial = await h.service.startRun(principal, { ...input, requestId: undefined })
    const snapshot = await waitForRun(h.service, principal, initial.runId, 'completed')
    const body = { expected_binding: binding, request_id: input.requestId, identity_ids: input.identityIds, description: input.description, prompt: input.prompt }
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    h.requestStore.prepareAdmission(context().owner, input.requestId, binding, hash, body)
    h.requestStore.markResolved(context().owner, input.requestId, initial.runId)
    await expect(h.service.startRun(principal, input, { expectedBinding: binding, requestBody: body })).rejects.toThrow(/different input/)
    const reloaded = harness({ storePath: h.storePath, loadArtifacts: () => [{ ...structuredClone(snapshot), requestId: input.requestId, requestHash: hash }] })
    const observer = reloaded.service.projectPrincipal(context())
    await expect(reloaded.service.startRun(observer, input, { expectedBinding: binding, requestBody: body })).rejects.toThrow(/different input/)
    expect(reloaded.requestStore.lookup(context().owner, input.requestId, binding)?.run_id).toBe(initial.runId)
  })

  test('failed snapshots with live native handles remain unknown after repeated restarts', async () => {
    const handle: AgentWorkerHandle = {
      done: Promise.reject(new Error('native turn and cleanup failed')),
      pendingInput: () => null, answer() {}, isAlive: () => true,
      cancel: async () => { throw new Error('native termination not confirmed') },
    }
    void handle.done.catch(() => {})
    const first = harness({ startWorker: () => handle })
    const principal = first.service.projectPrincipal(context())
    const binding = first.service.getProjectBinding(principal).binding_id
    const run = await first.service.startRun(principal, request('failed-alive'), binding)
    const snapshot = await waitForRun(first.service, principal, run.runId, 'failed')
    expect(first.service.getRequest(principal, 'failed-alive', binding).state).toBe('admitted')
    for (let i = 0; i < 2; i++) {
      const reloaded = harness({ storePath: first.storePath, loadArtifacts: () => [structuredClone(snapshot)] })
      const observer = reloaded.service.projectPrincipal(context())
      expect(reloaded.service.getRequest(observer, 'failed-alive', binding)).toMatchObject({
        state: 'unknown', run: { runId: run.runId, status: 'failed' },
      })
      expect((await reloaded.service.cancelRequest(observer, 'failed-alive', binding)).state).toBe('unknown')
      await expect(reloaded.service.startRun(observer, request('failed-alive'), binding)).rejects.toThrow(/unknown/)
    }
    expect(handle.isAlive!()).toBe(true)
  })

  test('a crash after failed cancellation snapshot but before unknown persistence cannot prove exit', async () => {
    let started = false
    const handle: AgentWorkerHandle = {
      done: new Promise(() => {}), pendingInput: () => null, answer() {}, isAlive: () => true,
      cancel: async () => { throw new Error('kill failed') },
    }
    const first = harness({ startWorker: () => { started = true; return handle } })
    const principal = first.service.projectPrincipal(context())
    const binding = first.service.getProjectBinding(principal).binding_id
    const run = await first.service.startRun(principal, request('cancel-crash'), binding)
    for (let i = 0; i < 200 && !started; i++) await new Promise(resolve => setTimeout(resolve, 1))
    expect(started).toBe(true)
    first.requestStore.markUnknown = () => { throw new Error('crash before unknown write') }
    await expect(first.service.cancelRequest(principal, 'cancel-crash', binding)).rejects.toThrow('crash before unknown write')
    expect(new AgentRequestStore({ path: first.storePath }).lookup(context().owner, 'cancel-crash', binding)?.state).toBe('cancel_requested')
    const snapshot = first.service.getRun(principal, run.runId)
    expect(snapshot.status).toBe('failed')
    const reloaded = harness({ storePath: first.storePath, loadArtifacts: () => [structuredClone(snapshot)] })
    expect(reloaded.service.getRequest(reloaded.service.projectPrincipal(context()), 'cancel-crash', binding).state).toBe('unknown')
    expect(handle.isAlive!()).toBe(true)
  })

  test.each(['pending', 'admitted', 'cancel_requested'] as const)('%s plus a terminal artifact is never an exit fact on recovery', async state => {
    const first = harness()
    const principal = first.service.projectPrincipal(context())
    const initial = await first.service.startRun(principal, request('template'))
    const template = await waitForRun(first.service, principal, initial.runId, 'completed')
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      const h = harness()
      const binding = h.service.getProjectBinding(h.service.projectPrincipal(context())).binding_id
      const id = `unresolved-${state}-${status}`
      h.requestStore.prepareAdmission(context().owner, id, binding, template.requestHash!, undefined)
      if (state !== 'pending') h.requestStore.markAdmitted(context().owner, id, template.runId)
      if (state === 'cancel_requested') h.requestStore.fenceCancellation(context().owner, id, binding)
      const snapshot = { ...structuredClone(template), requestId: id, status }
      const reloaded = harness({ storePath: h.storePath, loadArtifacts: () => [snapshot] })
      expect(reloaded.service.getRequest(reloaded.service.projectPrincipal(context()), id, binding)).toMatchObject({
        state: 'unknown', run: { runId: template.runId, status },
      })
    }
  })

  test.each(['pending', 'cancel_requested'] as const)('%s without an artifact remains unknown after restart', state => {
    const h = harness()
    const binding = h.service.getProjectBinding(h.service.projectPrincipal(context())).binding_id
    h.requestStore.prepareAdmission(context().owner, 'no-artifact', binding, 'hash', undefined)
    if (state === 'cancel_requested') h.requestStore.fenceCancellation(context().owner, 'no-artifact', binding)
    const reloaded = harness({ storePath: h.storePath })
    expect(reloaded.service.getRequest(reloaded.service.projectPrincipal(context()), 'no-artifact', binding).state).toBe('unknown')
  })

  test.each(['completed', 'failed', 'cancelled'] as const)('legacy %s artifacts without a request record import as unknown', async status => {
    const first = harness()
    const principal = first.service.projectPrincipal(context())
    const initial = await first.service.startRun(principal, request('legacy-record'))
    const snapshot = { ...await waitForRun(first.service, principal, initial.runId, 'completed'), status }
    const reloaded = harness({ loadArtifacts: () => [structuredClone(snapshot)] })
    const observer = reloaded.service.projectPrincipal(context())
    const binding = reloaded.service.getProjectBinding(observer).binding_id
    expect(reloaded.service.getRequest(observer, 'legacy-record', binding).state).toBe('unknown')
    await expect(reloaded.service.startRun(observer, request('legacy-record'))).rejects.toThrow(/unknown/)
  })

  test('confirmed native completion persists its request fact without a lookup and preserves final output on restart', async () => {
    const first = harness()
    const principal = first.service.projectPrincipal(context())
    const binding = first.service.getProjectBinding(principal).binding_id
    const run = await first.service.startRun(principal, request('autonomous-terminal'), binding)
    await waitForDurableState(first, 'autonomous-terminal', binding, 'resolved')
    const snapshot = first.service.getRun(principal, run.runId)
    const reloaded = harness({ storePath: first.storePath, loadArtifacts: () => [structuredClone(snapshot)] })
    expect(reloaded.service.getRequest(reloaded.service.projectPrincipal(context()), 'autonomous-terminal', binding)).toMatchObject({
      state: 'resolved', run: { status: 'completed', workers: [{ finalOutput: 'done' }] },
    })
  })

  test('request termination waits for all native descendants and is durable when the last child exits', async () => {
    const parent = controlledHandle()
    const child = controlledHandle()
    const capabilities: string[] = []
    const h = harness({ startWorker: options => {
      capabilities.push(options.hostEnv.LODESTAR_AGENT_CAPABILITY!)
      return capabilities.length === 1 ? parent.handle : child.handle
    } })
    const principal = h.service.projectPrincipal(context())
    const binding = h.service.getProjectBinding(principal).binding_id
    const rootRun = await h.service.startRun(principal, request('native-tree'), binding)
    for (let i = 0; i < 200 && capabilities.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 1))
    const workerPrincipal = h.service.principalForCapability(capabilities[0]!)!
    await h.service.startRun(workerPrincipal, { identityIds: ['agent:test'], description: 'child', prompt: 'child work' })
    for (let i = 0; i < 200 && capabilities.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 1))
    expect(capabilities).toHaveLength(2)
    parent.resolve()
    await waitForRun(h.service, principal, rootRun.runId, 'completed')
    expect(h.service.getRequest(principal, 'native-tree', binding).state).toBe('admitted')
    child.resolve(completed('native-child'))
    await waitForDurableState(h, 'native-tree', binding, 'resolved')
  })

  test.each(['resolved', 'cancelled'] as const)('trusted durable %s remains terminal even when its artifact is missing', state => {
    const h = harness()
    const binding = h.service.getProjectBinding(h.service.projectPrincipal(context())).binding_id
    h.requestStore.prepareAdmission(context().owner, 'trusted-terminal', binding, 'hash', undefined)
    if (state === 'resolved') h.requestStore.markResolved(context().owner, 'trusted-terminal', 'missing-run')
    else h.requestStore.markCancelled(context().owner, 'trusted-terminal', 'missing-run')
    const reloaded = harness({ storePath: h.storePath })
    expect(reloaded.service.getRequest(reloaded.service.projectPrincipal(context()), 'trusted-terminal', binding)).toEqual({
      requestId: 'trusted-terminal', state, runId: 'missing-run',
    })
  })

  test.each(['resolved', 'cancelled', 'operator_attested'] as const)('failed %s persistence never exposes an uncommitted terminal fact', terminal => {
    const h = harness()
    const binding = h.service.getProjectBinding(h.service.projectPrincipal(context())).binding_id
    const owner = context().owner
    h.requestStore.prepareAdmission(owner, 'store-failure', binding, 'hash', undefined)
    h.requestStore.markAdmitted(owner, 'store-failure', 'existing-run')
    if (terminal === 'operator_attested') h.requestStore.markUnknown(owner, 'store-failure', 'existing-run')
    const prior = h.requestStore.lookup(owner, 'store-failure', binding)
    const savedPath = `${h.storePath}.saved`
    renameSync(h.storePath, savedPath)
    mkdirSync(h.storePath)
    try {
      expect(() => {
        if (terminal === 'resolved') h.requestStore.markResolved(owner, 'store-failure', 'existing-run')
        else if (terminal === 'cancelled') h.requestStore.markCancelled(owner, 'store-failure', 'existing-run')
        else h.requestStore.reconcile(owner, 'store-failure', binding, { stopped: true, reason: 'operator checked' })
      }).toThrow()
      expect(h.requestStore.lookup(owner, 'store-failure', binding)).toEqual(prior)
    } finally { rmSync(h.storePath, { recursive: true }); renameSync(savedPath, h.storePath) }
    expect(new AgentRequestStore({ path: h.storePath }).lookup(owner, 'store-failure', binding)).toEqual(prior)
  })

  test('an admitted request whose durable run artifact is missing becomes unknown and never launches again', async () => {
    const storePath = join(root, 'request-missing-run.json')
    const control = controlledHandle()
    const first = harness({ storePath, startWorker: () => control.handle })
    const principal = first.service.projectPrincipal(context())
    const binding = first.service.getProjectBinding(principal).binding_id
    const admitted = await first.service.startRun(principal, request('missing-run'), binding)
    expect(first.service.getRequest(principal, 'missing-run', binding)).toMatchObject({
      state: 'admitted', run: { runId: admitted.runId },
    })

    let starts = 0
    const reloaded = harness({
      storePath,
      loadArtifacts: () => [],
      startWorker: () => { starts++; return resolvedHandle() },
    })
    const reloadedPrincipal = reloaded.service.projectPrincipal(context())
    expect(reloaded.service.getRequest(reloadedPrincipal, 'missing-run', binding)).toMatchObject({
      state: 'unknown',
    })
    await expect(reloaded.service.startRun(reloadedPrincipal, request('missing-run'), binding)).rejects.toThrow(/unknown/)
    const restartedAgain = harness({ storePath, loadArtifacts: () => [], startWorker: () => {
      starts++
      return resolvedHandle()
    } })
    const restartedPrincipal = restartedAgain.service.projectPrincipal(context())
    expect(restartedAgain.service.getRequest(restartedPrincipal, 'missing-run', binding).state).toBe('unknown')
    await expect(restartedAgain.service.startRun(restartedPrincipal, request('missing-run'), binding)).rejects.toThrow(/unknown/)
    expect(starts).toBe(0)
  })

  test('hashes, terminal lookup and duplicate conflicts survive service reconstruction', async () => {
    const storePath = join(root, 'request-replay.json')
    let starts = 0
    const first = harness({ storePath, startWorker: () => { starts++; return resolvedHandle() } })
    const principal = first.service.projectPrincipal(context())
    const binding = first.service.getProjectBinding(principal).binding_id
    const transportBody = {
      expected_binding: binding,
      request_id: 'durable-replay',
      identity_ids: ['agent:test'],
      description: '项目请求',
      prompt: 'perform work',
    }
    const guard = { expectedBinding: binding, requestBody: transportBody }
    const initial = await first.service.startRun(principal, request('durable-replay'), guard)
    const terminal = await waitForRun(first.service, principal, initial.runId, 'completed')
    expect((await first.service.startRun(principal, request('durable-replay'), guard)).runId).toBe(initial.runId)
    await expect(first.service.startRun(principal, request('durable-replay'), {
      expectedBinding: binding,
      requestBody: { ...transportBody, prompt: 'changed only on the transport' },
    }))
      .rejects.toThrow(/different input/)
    expect(first.service.getRequest(principal, 'durable-replay', binding)).toMatchObject({ state: 'resolved', run: { runId: initial.runId } })

    const reloaded = harness({ storePath, loadArtifacts: () => [structuredClone(terminal)], startWorker: () => {
      throw new Error('replay must not start business work')
    } })
    const reloadedPrincipal = reloaded.service.projectPrincipal(context())
    expect(reloaded.service.getProjectBinding(reloadedPrincipal).binding_id).toBe(binding)
    expect((await reloaded.service.startRun(reloadedPrincipal, request('durable-replay'), guard)).runId).toBe(initial.runId)
    expect(starts).toBe(1)
  })

  test('rebinding and replacement installation reject the old expected binding until the original tuple is restored', async () => {
    const storePath = join(root, 'request-rebinding.json')
    const h = harness({ storePath })
    const original = h.service.projectPrincipal(context())
    const oldBinding = h.service.getProjectBinding(original).binding_id
    const run = await h.service.startRun(original, request('binding-guard'), oldBinding)
    await waitForRun(h.service, original, run.runId, 'completed')

    const rebound = h.service.projectPrincipal(context('project', 'chat-rebound', otherRoot))
    const reboundBinding = h.service.getProjectBinding(rebound).binding_id
    expect(reboundBinding).not.toBe(oldBinding)
    expect(() => h.service.getRequest(rebound, 'binding-guard', reboundBinding)).toThrow(/project_binding_changed/)

    expect(h.service.getProjectBinding(original).binding_id).toBe(oldBinding)
    expect(h.service.getRequest(original, 'binding-guard', oldBinding).run?.runId).toBe(run.runId)

    const replacement = harness({ storePath: join(root, 'replacement-installation.json') })
    const replacementPrincipal = replacement.service.projectPrincipal(context())
    expect(replacement.service.getProjectBinding(replacementPrincipal).binding_id).not.toBe(oldBinding)
    expect(() => replacement.service.getRequest(replacementPrincipal, 'binding-guard', oldBinding)).toThrow(/project_binding_changed/)
  })

  test('restart keeps unconfirmed native termination unknown until explicit operator reconciliation', async () => {
    const storePath = join(root, 'request-unknown.json')
    const control = controlledHandle()
    const first = harness({ storePath, startWorker: () => control.handle })
    const principal = first.service.projectPrincipal(context())
    const binding = first.service.getProjectBinding(principal).binding_id
    const run = await first.service.startRun(principal, request('interrupted'), binding)
    const active = await waitForRun(first.service, principal, run.runId, 'running')

    let starts = 0
    const reloaded = harness({
      storePath,
      loadArtifacts: () => [structuredClone(active)],
      startWorker: () => { starts++; return resolvedHandle() },
    })
    const reloadedPrincipal = reloaded.service.projectPrincipal(context())
    const unknown = reloaded.service.getRequest(reloadedPrincipal, 'interrupted', binding)
    expect(unknown).toMatchObject({ state: 'unknown', run: { runId: run.runId, status: 'failed' } })
    await expect(reloaded.service.startRun(reloadedPrincipal, request('interrupted'), binding)).rejects.toThrow(/unknown/)
    const reconciled = reloaded.service.reconcileRequest(reloadedPrincipal, 'interrupted', binding, {
      stopped: true,
      reason: 'operator checked the native process table and stopped the work',
    })
    expect(reconciled).toMatchObject({
      state: 'resolved',
      resolution: { kind: 'operator_attested', binding_id: binding },
      run: { runId: run.runId },
    })
    expect(starts).toBe(0)
    expect(() => reloaded.service.reconcileRequest(reloadedPrincipal, 'interrupted', binding, {
      stopped: true, reason: 'duplicate',
    })).toThrow(/only unknown/)
    await first.service.cancelRequest(principal, 'interrupted', binding)
  })

  test('operator attestation remains visible if a late terminal result is observed and never launches work', async () => {
    const storePath = join(root, 'late-after-attestation.json')
    const control = controlledHandle()
    let starts = 0
    const h = harness({ storePath, startWorker: () => { starts++; return control.handle } })
    const principal = h.service.projectPrincipal(context())
    const binding = h.service.getProjectBinding(principal).binding_id
    const run = await h.service.startRun(principal, request('late-after-attestation'), binding)
    await waitForRun(h.service, principal, run.runId, 'running')
    h.requestStore.markUnknown(context().owner, 'late-after-attestation', run.runId)
    h.service.reconcileRequest(principal, 'late-after-attestation', binding, {
      stopped: true, reason: 'operator attested before a delayed terminal callback',
    })
    const active = h.service.getRun(principal, run.runId)
    const reloaded = harness({ storePath, loadArtifacts: () => [structuredClone(active)] })
    const reloadedPrincipal = reloaded.service.projectPrincipal(context())
    expect(reloaded.service.getRequest(reloadedPrincipal, 'late-after-attestation', binding)).toMatchObject({
      state: 'resolved', resolution: { kind: 'operator_attested' }, run: { status: 'failed' },
    })
    control.resolve(completed('native-late'))
    await waitForRun(h.service, principal, run.runId, 'completed')
    expect(h.service.getRequest(principal, 'late-after-attestation', binding)).toMatchObject({
      state: 'resolved',
      resolution: { kind: 'operator_attested' },
      run: { status: 'completed' },
    })
    expect(starts).toBe(1)
  })

  test('a native completion racing cancellation remains visible as a late outcome', async () => {
    let resolveDone!: (value: AgentWorkerResult) => void
    let alive = true
    let started = false
    const done = new Promise<AgentWorkerResult>(resolve => { resolveDone = resolve })
    const handle: AgentWorkerHandle = {
      done,
      pendingInput: () => null,
      answer() {},
      isAlive: () => alive,
      async cancel() {
        alive = false
        resolveDone({ ...completed('native-race'), output: 'actual late output', finalOutput: 'actual late output' })
        await done
      },
    }
    const h = harness({ startWorker: () => { started = true; return handle } })
    const principal = h.service.projectPrincipal(context())
    const binding = h.service.getProjectBinding(principal).binding_id
    const run = await h.service.startRun(principal, request('completion-race'), binding)
    await waitForRun(h.service, principal, run.runId, 'running')
    for (let i = 0; i < 200 && !started; i++) await new Promise(resolve => setTimeout(resolve, 1))
    expect(started).toBe(true)
    const cancelled = await h.service.cancelRequest(principal, 'completion-race', binding)
    expect(cancelled).toMatchObject({
      state: 'cancelled',
      run: { status: 'cancelled', workers: [{ status: 'completed', output: 'actual late output', finalOutput: 'actual late output' }] },
    })
  })

  test('catalog readiness changes do not block request lookup or cancellation', async () => {
    const control = controlledHandle()
    const h = harness({ startWorker: () => control.handle })
    const principal = h.service.projectPrincipal(context())
    const binding = h.service.getProjectBinding(principal).binding_id
    const run = await h.service.startRun(principal, request('catalog-change'), binding)
    await waitForRun(h.service, principal, run.runId, 'running')
    h.catalog.identities[0]!.status = 'source_disabled'
    h.catalog.identities[0]!.reason = 'temporarily unavailable'
    expect(h.service.getRequest(principal, 'catalog-change', binding).state).toBe('admitted')
    expect((await h.service.cancelRequest(principal, 'catalog-change', binding)).state).toBe('cancelled')
  })

  test('failed native cancellation remains unknown while the live handle is retained', async () => {
    let started = false
    const handle: AgentWorkerHandle = {
      done: new Promise(() => {}),
      pendingInput: () => null,
      answer() {},
      isAlive: () => true,
      async cancel() { throw new Error('native termination not confirmed') },
    }
    const h = harness({ startWorker: () => { started = true; return handle } })
    const principal = h.service.projectPrincipal(context())
    const binding = h.service.getProjectBinding(principal).binding_id
    const run = await h.service.startRun(principal, request('cancel-uncertain'), binding)
    await waitForRun(h.service, principal, run.runId, 'running')
    for (let i = 0; i < 200 && !started; i++) await new Promise(resolve => setTimeout(resolve, 1))
    const uncertain = await h.service.cancelRequest(principal, 'cancel-uncertain', binding)
    expect(uncertain).toMatchObject({ state: 'unknown', run: { runId: run.runId, status: 'failed' } })
    expect(h.service.getRequest(principal, 'cancel-uncertain', binding).state).toBe('unknown')
  })

  test('corrupt durable request state fails closed', () => {
    const storePath = join(root, 'corrupt-requests.json')
    writeFileSync(storePath, '{not-json')
    expect(() => new AgentRequestStore({ path: storePath })).toThrow(/unreadable/)
  })
})
