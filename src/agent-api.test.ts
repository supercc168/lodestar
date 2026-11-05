import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { handleAgentRequest } from './agent-api'
import { buildAgentIdentityCatalog } from './agent-identities'
import { listTokenSources, registerTokenSource, resetTokenSourceRegistry, type TokenSource } from './token-source'
import { AgentService, type AgentServiceDeps } from './agent-service'
import { AgentRequestStore } from './agent-request-store'
import type { AgentRunSnapshot } from './agent-run-types'
import type { AgentWorkerHandle, AgentWorkerResult } from './agent-runner'

let server: Server | null = null
afterEach(() => { server?.close(); server = null })

const durableRoot = realpathSync(mkdtempSync(join(tmpdir(), 'lodestar-agent-api-')))
afterAll(() => rmSync(durableRoot, { recursive: true, force: true }))

async function serveDurable(startWorker: AgentServiceDeps['startWorker']) {
  const storePath = join(durableRoot, `${crypto.randomUUID()}.json`)
  const requestStore = new AgentRequestStore({ path: storePath })
  const artifacts = new Map<string, AgentRunSnapshot>()
  const deps: AgentServiceDeps = {
    requestStore,
    getCatalog: () => ({ catalogGeneration: 'test', sourceFailures: [], identities: [{
      id: 'agent:test', displayName: 'Test', tokenSourceId: 'glm', tokenSourceDisplay: 'GLM',
      provider: 'claude', model: 'GLM-5.3', modelDisplay: 'GLM', defaultEffort: 'max',
      supportedEfforts: ['max'], sourceDefault: true, status: 'ready',
    }] }),
    startWorker,
    sendCard: async () => 'message-test', sendTextRaw: async () => true,
    getChatTailMessageId: async () => null, getElementCount: () => 1,
    addElementResult: async () => ({ landed: true }), deleteElementChecked: async () => true,
    convertMessageToCard: async () => 'card-test', recordCardCreated: () => {},
    replaceElementResult: async () => ({ landed: true }), cancelSummary: () => {},
    patchSettingsChecked: async () => true, dispose: async () => {},
    writeArtifact: (path, value) => { artifacts.set(path, structuredClone(value) as AgentRunSnapshot) },
    writeTextArtifact: () => {}, readTextArtifact: () => '', loadArtifacts: () => [],
  }
  let service = new AgentService(deps)
  const projectContext = { owner: { kind: 'project' as const, name: 'project', chatId: 'chat', workDir: durableRoot } }
  let principal = service.projectPrincipal(projectContext)
  const binding = service.getProjectBinding(principal).binding_id
  server = createServer((req, res) => {
    void handleAgentRequest(req, res, new URL(req.url!, `http://${req.headers.host}`), {
      service, authorizeSession: () => null,
      authorizeProject: (token, project) => token === 'project-secret' && project === 'project' ? principal : null,
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  const base = `http://127.0.0.1:${address.port}`
  const headers = { authorization: 'Bearer project-secret', 'content-type': 'application/json' }
  const post = (path: string, body: object) => fetch(`${base}${path}?project=project`, { method: 'POST', headers, body: JSON.stringify(body) })
  const lookup = (id: string) => fetch(`${base}/agents/requests/${id}?project=project&expected_binding=${binding}`, { headers })
  const reload = () => {
    service = new AgentService({ ...deps, requestStore: new AgentRequestStore({ path: storePath }),
      loadArtifacts: () => [...artifacts.values()].map(snapshot => structuredClone(snapshot)) })
    principal = service.projectPrincipal(projectContext)
  }
  return { get service() { return service }, get principal() { return principal },
    binding, requestStore, storePath, artifacts, deps, post, lookup, reload }
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('condition did not become true')
}

describe('durable Agent HTTP admission', () => {
  test('request run_id stays durably null while an unrecorded native run is alive', async () => {
    let starts = 0
    let alive = true
    let finish!: (value: AgentWorkerResult) => void
    const done = new Promise<AgentWorkerResult>(resolve => { finish = resolve })
    const h = await serveDurable(() => {
      starts++
      return { done, pendingInput: () => null, answer() {}, isAlive: () => alive,
        cancel: async () => { alive = false; finish({ output: 'stopped', outputTruncated: false, sessionId: 'native-unrecorded', durationMs: 1, usage: null }) } }
    })
    const markAdmitted = h.requestStore.markAdmitted.bind(h.requestStore)
    h.requestStore.markAdmitted = () => { throw new Error('admission storage unavailable') }
    let status = 0
    let observed: any
    let nativeStillAlive = false
    try {
      const response = await h.post('/agents/runs', { description: 'unrecorded run', prompt: 'work', identity_ids: ['agent:test'],
        request_id: 'unrecorded-live', expected_binding: h.binding })
      status = response.status
      await until(() => starts === 1)
      observed = await (await h.lookup('unrecorded-live')).json()
      nativeStillAlive = alive
    } finally {
      h.requestStore.markAdmitted = markAdmitted
      await h.service.cancelRequest(h.principal, 'unrecorded-live', h.binding)
    }
    expect(status).toBe(503)
    expect(observed).toMatchObject({ request_id: 'unrecorded-live', state: 'pending', run_id: null,
      run: { run_id: expect.any(String), status: 'running' } })
    expect(nativeStillAlive).toBe(true)
    expect(starts).toBe(1)
  })

  test('request run_id identifies admitted terminal work even when its artifact is missing', async () => {
    let starts = 0
    const h = await serveDurable(() => {
      starts++
      return { done: Promise.resolve({ output: 'done', outputTruncated: false, sessionId: 'native-terminal', durationMs: 1, usage: null }),
        pendingInput: () => null, answer() {}, cancel: async () => {} }
    })
    const response = await h.post('/agents/runs', { description: 'terminal run', prompt: 'work', identity_ids: ['agent:test'],
      request_id: 'missing-terminal-artifact', expected_binding: h.binding })
    const run = await response.json() as any
    expect(response.status).toBe(202)
    await until(() => h.service.getRequest(h.principal, 'missing-terminal-artifact', h.binding).state === 'resolved')
    h.artifacts.clear()
    h.reload()
    const observed = await (await h.lookup('missing-terminal-artifact')).json() as any
    expect(observed).toEqual({ request_id: 'missing-terminal-artifact', state: 'resolved', run_id: run.run_id })
    expect(starts).toBe(1)
  })

  test('request run_id is explicitly null for a durable pre-admission rejection', async () => {
    let starts = 0
    const h = await serveDurable(() => { starts++; throw new Error('invalid identity must not launch') })
    const response = await h.post('/agents/runs', { description: 'invalid identity', prompt: 'work', identity_ids: ['agent:missing'],
      request_id: 'known-unadmitted', expected_binding: h.binding })
    expect(response.status).toBe(409)
    expect((await response.json() as any).error).toContain('agent identity not found')
    for (let i = 0; i < 2; i++) {
      const observed = await (await h.lookup('known-unadmitted')).json()
      expect(observed).toEqual({ request_id: 'known-unadmitted', state: 'resolved', run_id: null })
      h.reload()
    }
    expect(starts).toBe(0)
  })

  test('guarded follow-up hashes include source and operation while exact retries survive restart', async () => {
    let starts = 0
    const h = await serveDurable(options => ({
      done: Promise.resolve({ output: 'done', outputTruncated: false, sessionId: options.resumeSessionId ?? `native-${++starts}`, durationMs: 1, usage: null }),
      pendingInput: () => null, answer() {}, cancel: async () => {},
    }))
    const sourceBody = { description: 'source', prompt: 'source', identity_ids: ['agent:test'] }
    const sourceA = await (await h.post('/agents/runs', sourceBody)).json() as any
    const sourceB = await (await h.post('/agents/runs', sourceBody)).json() as any
    await until(() => [sourceA, sourceB].every(source => h.service.getRun(h.principal, source.run_id).status === 'completed'))
    const body = { description: 'continue source', prompt: 'next', identity_ids: ['agent:test'], request_id: 'source-aware', expected_binding: h.binding }
    const pathA = `/agents/runs/${sourceA.run_id}/follow-up`
    const first = await h.post(pathA, body)
    expect(first.status).toBe(202)
    const admitted = await first.json() as any
    await until(() => h.service.getRequest(h.principal, 'source-aware', h.binding).state === 'resolved')
    const replay = await h.post(pathA, body)
    expect(replay.status).toBe(202)
    expect((await replay.json() as any).run_id).toBe(admitted.run_id)
    const otherSource = await h.post(`/agents/runs/${sourceB.run_id}/follow-up`, body)
    expect(otherSource.status).toBe(409)
    expect((await otherSource.json() as any).error).toContain('different input')
    expect((await h.post('/agents/runs', body)).status).toBe(409)
    expect((await h.post(pathA, { ...body, prompt: 'different' })).status).toBe(409)
    h.reload()
    const recovered = await h.post(pathA, body)
    expect(recovered.status).toBe(202)
    expect((await recovered.json() as any).run_id).toBe(admitted.run_id)
    expect((await h.post(`/agents/runs/${sourceB.run_id}/follow-up`, body)).status).toBe(409)
    expect(h.artifacts.size).toBe(3)
  })

  test.each(['run', 'follow-up'] as const)('%s returns 503 after real admission rename failure and reuses its original request', async operation => {
    let starts = 0
    let alive = true
    let finish!: (value: AgentWorkerResult) => void
    const done = new Promise<AgentWorkerResult>(resolve => { finish = resolve })
    const handle: AgentWorkerHandle = { done, isAlive: () => alive, pendingInput: () => null, answer() {}, cancel: async () => {} }
    const h = await serveDurable(() => {
      starts++
      if (operation === 'follow-up' && starts === 1) return {
        ...handle, isAlive: () => false, done: Promise.resolve({ output: 'source', outputTruncated: false, sessionId: 'native-source', durationMs: 1, usage: null }),
      }
      return handle
    })
    let path = '/agents/runs'
    if (operation === 'follow-up') {
      const source = await h.post(path, { description: 'source', prompt: 'source', identity_ids: ['agent:test'] })
      const body = await source.json() as any
      await until(() => h.service.getRun(h.principal, body.run_id).status === 'completed')
      path = `/agents/runs/${body.run_id}/follow-up`
    }
    const original = h.requestStore.markAdmitted.bind(h.requestStore)
    h.requestStore.markAdmitted = (...args) => {
      h.requestStore.markAdmitted = original
      const savedPath = `${h.storePath}.saved`
      renameSync(h.storePath, savedPath)
      mkdirSync(h.storePath)
      try { return original(...args) }
      finally { rmSync(h.storePath, { recursive: true }); renameSync(savedPath, h.storePath) }
    }
    const body = { description: 'admission failure', prompt: 'work', request_id: 'uncertain', expected_binding: h.binding,
      ...(operation === 'run' ? { identity_ids: ['agent:test'] } : {}) }
    const response = await h.post(path, body)
    await until(() => starts === (operation === 'run' ? 1 : 2))
    const observed = await (await h.lookup('uncertain')).json() as any
    const replay = await h.post(path, body)
    const replayed = await replay.json() as any
    const nativeStillAlive = alive
    alive = false
    finish({ output: 'done', outputTruncated: false, sessionId: 'native-source', durationMs: 1, usage: null })
    expect(response.status).toBe(503)
    expect(nativeStillAlive).toBe(true)
    expect((await response.json() as any).error).toContain('same request_id')
    expect(observed.state).not.toBe('resolved')
    expect(observed.run.status).toBe('running')
    expect(replay.status).toBe(202)
    expect(replayed.run_id).toBe(observed.run.run_id)
    expect(starts).toBe(operation === 'run' ? 1 : 2)
  })
})

async function serve(onStart?: (request: any) => void, projectMode = false) {
  const session = { sessionName: 'project', chatId: 'chat', workDir: '/repo', codexAccountId: () => 'default' } as any
  let current: any = null
  const service = {
    rootPrincipal: () => ({ kind: 'session', session, depth: -1 }),
    principalForCapability: () => null,
    async startRun(principal: any, request: any) {
      onStart?.(request)
      current = {
        ...(principal.kind === 'project' ? { owner: principal.context.owner } : {}),
        runId: 'agent_1', sessionName: 'project', chatId: 'chat', workDir: request.workDir ?? '/repo', description: request.description, prompt: request.prompt,
        depth: 0, status: 'running', createdAt: new Date().toISOString(), workers: [{
          identityId: 'agent:a', status: 'running', sessionId: request.sessionId, output: request.prompt,
          finalOutput: `  final:${request.prompt}  \n`, steps: [],
        }],
      }
      return current
    },
    getRun: () => current,
    async followUp(_principal: any, runId: string, request: any) {
      return { ...current, runId: 'agent_2', parentRunId: runId, parentKind: 'follow_up', description: request.description, prompt: request.prompt }
    },
    async answer() { return { ...current, status: 'running' } },
    async cancelRun() { current.status = 'cancelled'; return true },
    getProjectBinding() {
      return { installation_id: 'installation-test', binding_id: 'binding-test', project: 'project', chat_id: 'chat', work_dir: '/repo' }
    },
    assertProjectBinding(_principal: any, expected: string) {
      if (expected !== 'binding-test') throw new Error('project_binding_changed')
    },
    getRequest(_principal: any, requestId: string) {
      if (requestId === 'missing') throw new Error(`agent request not found: ${requestId}`)
      return { requestId, state: 'admitted', runId: 'agent_1', run: current }
    },
    async cancelRequest(_principal: any, requestId: string) {
      return { requestId, state: 'cancelled', runId: 'agent_1', run: current }
    },
    reconcileRequest(_principal: any, requestId: string, expected: string, input: any) {
      return { requestId, state: 'resolved', runId: 'agent_1', run: current,
        resolution: { kind: 'operator_attested', reason: input.reason, at: new Date().toISOString(), binding_id: expected } }
    },
  }
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const projectPrincipal = (project: string) => ({ kind: 'project' as const, depth: -1 as const,
      context: { owner: { kind: 'project' as const, name: project, chatId: 'chat', workDir: '/repo' } } })
    void handleAgentRequest(req, res, url, {
      service: service as any,
      authorizeSession: token => token === 'secret' ? session : null,
      ...(projectMode ? { authorizeProject: (token: string, project: string) => {
        if (token !== 'project-secret') return null
        if (project !== 'project') throw new Error('unknown project')
        return projectPrincipal(project)
      }, authorizeOperator: (token: string, project: string) => {
        if (token !== 'operator-secret') return null
        if (project !== 'project') throw new Error('unknown project')
        return projectPrincipal(project)
      } } : {}),
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return `http://127.0.0.1:${address.port}`
}

describe('delegated Agent HTTP API', () => {
  test('non-agents paths return false', async () => {
    const handled = await new Promise<boolean>((resolve, reject) => {
      const req = { method: 'GET', headers: {}, url: '/notify' } as any
      const res = {
        statusCode: 0,
        setHeader() {},
        end() { reject(new Error('should not write')) },
      } as any
      void handleAgentRequest(req, res, new URL('http://127.0.0.1/notify'), {
        service: {} as any,
        authorizeSession: () => null,
      }).then(resolve, reject)
    })
    expect(handled).toBe(false)
  })

  test('session-bound Agents can test a relay without saving or restarting the daemon', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('http://127.0.0.1:')) return originalFetch(input, init)
      expect(String(input)).toBe('https://gateway.test/v1/models')
      return Response.json({ data: [{ id: 'model-a', name: 'Model A' }] })
    }) as unknown as typeof fetch
    try {
      const base = await serve()
      const response = await fetch(`${base}/agents/relays/test`, {
        method: 'POST',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: JSON.stringify({ site_id: 'demo', protocol: 'openai', base_url: 'https://gateway.test/v1', api_key: 'relay-key' }),
      })
      const value = await response.json() as any
      expect(response.status).toBe(200)
      expect(value).toMatchObject({ ok: true, site_id: 'demo', protocol: 'openai', base_url: 'https://gateway.test',
        models: [{ id: 'model-a', display: 'Model A' }] })
    } finally { globalThis.fetch = originalFetch }
  })

  test('project-bound Agents cannot mutate the global relay registry', async () => {
    const base = await serve(undefined, true)
    const response = await fetch(`${base}/agents/relays/test?project=project`, {
      method: 'POST',
      headers: { authorization: 'Bearer project-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ site_id: 'demo', protocol: 'openai', base_url: 'https://gateway.test/v1', api_key: 'relay-key' }),
    })
    expect(response.status).toBe(403)
  })

  test.each(['session', 'project'] as const)('%s preserves inputs beyond the former character and HTTP body limits', async kind => {
    const projectMode = kind === 'project'
    const base = await serve(undefined, projectMode)
    const query = projectMode ? '?project=project' : ''
    const headers = { authorization: `Bearer ${projectMode ? 'project-secret' : 'secret'}`, 'content-type': 'application/json' }
    const prompt = `  开始\n${'输入🎉'.repeat(419_000)}\n结束  `
    expect(prompt.length).toBeGreaterThan(800_000)
    for (const [path, fields] of [
      ['/agents/runs', { identity_ids: ['agent:a'] }],
      ['/agents/runs', { session_id: 'native-sid' }],
      ['/agents/runs/agent_1/follow-up', {}],
    ] as const) {
      const body = JSON.stringify({ description: '完整传入大任务', prompt, ...fields })
      // 本地 fork 给请求体加了 4 MiB 上限(见 src/agent-api.ts):贴近上限但不超限,内容必须逐字保留。
      expect(Buffer.byteLength(body)).toBeGreaterThan(4_000_000)
      expect(Buffer.byteLength(body)).toBeLessThan(4 * 1024 * 1024)
      const response = await fetch(`${base}${path}${query}`, { method: 'POST', headers, body })
      const value = await response.json() as any
      expect(response.status, value.error).toBe(202)
      expect(value.prompt === prompt).toBe(true)
    }
  })

  test('accepts a request body exactly at the 4 MiB cap and rejects one byte more', async () => {
    // 合成请求流:确定性验证「等于 4 MiB 放行、多一字节按实现文案拒绝」。
    const cap = 4 * 1024 * 1024
    const fields = { description: '边界请求体', identity_ids: ['agent:a'], prompt: '' }
    const fill = cap - Buffer.byteLength(JSON.stringify(fields))
    const payload = (prompt: string) => Buffer.from(JSON.stringify({ ...fields, prompt }))
    expect(payload('x'.repeat(fill))).toHaveLength(cap)
    expect(payload('x'.repeat(fill + 1))).toHaveLength(cap + 1)
    const session = { sessionName: 'project', chatId: 'chat', workDir: '/repo', codexAccountId: () => 'default' } as any
    const started: any[] = []
    const service = {
      rootPrincipal: () => ({ kind: 'session', session, depth: -1 }),
      async startRun(_principal: any, request: any) {
        started.push(request)
        return {
          runId: 'agent_1', sessionName: 'project', chatId: 'chat', workDir: request.workDir ?? '/repo',
          description: request.description, prompt: request.prompt, depth: 0, status: 'running',
          createdAt: new Date().toISOString(), workers: [],
        }
      },
    }
    const invoke = async (body: Buffer) => {
      const req = Readable.from([body]) as any
      req.method = 'POST'
      req.url = '/agents/runs'
      req.headers = { authorization: 'Bearer secret', 'content-type': 'application/json', host: '[' }
      let text = ''
      const res = { statusCode: 200, setHeader() {}, end(value: string) { text = value } } as any
      const handled = await handleAgentRequest(req, res, new URL('http://127.0.0.1/agents/runs'), {
        service: service as any,
        authorizeSession: token => token === 'secret' ? session : null,
      })
      expect(handled).toBe(true)
      return { status: res.statusCode, value: JSON.parse(text) as any }
    }
    const accepted = await invoke(payload('x'.repeat(fill)))
    expect(accepted.status).toBe(202)
    expect(started).toHaveLength(1)
    expect(started[0].prompt).toBe('x'.repeat(fill))
    const rejected = await invoke(payload('x'.repeat(fill + 1)))
    expect(rejected.status).toBe(409)
    expect(rejected.value.error).toBe('request body exceeds 4194304 bytes')
    expect(started).toHaveLength(1)
  })

  test.each(['session', 'project'] as const)('%s accepts more than 64 identities in one request', async kind => {
    const requests: any[] = []
    const projectMode = kind === 'project'
    const base = await serve(value => requests.push(value), projectMode)
    const identityIds = Array.from({ length: 129 }, (_, index) => `agent:${index}`)
    const response = await fetch(`${base}/agents/runs${projectMode ? '?project=project' : ''}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${projectMode ? 'project-secret' : 'secret'}`, 'content-type': 'application/json' },
      body: JSON.stringify({ description: '多身份并行调用', identity_ids: identityIds, prompt: 'work' }),
    })
    expect(response.status).toBe(202)
    await response.json()
    expect(requests).toHaveLength(1)
    expect(requests[0].identityIds).toEqual(identityIds)
  })

  test('preserves Chinese task input split inside a UTF-8 character', async () => {
    const requests: any[] = []
    const base = await serve(value => requests.push(value))
    const body = Buffer.from(JSON.stringify({ description: '任务说明', identity_ids: ['agent:a'], prompt: '处理中文 🎉' }))
    const boundary = body.indexOf(Buffer.from('任务')) + 1
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/agents/runs`, { method: 'POST', headers: {
        authorization: 'Bearer secret', 'content-type': 'application/json',
      } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)) })
      req.on('error', reject)
      req.write(body.subarray(0, boundary))
      setTimeout(() => req.end(body.subarray(boundary)), 10)
    })
    expect(status).toBe(202)
    expect(requests).toMatchObject([{ description: '任务说明', prompt: '处理中文 🎉' }])
  })

  test('requires a live capability', async () => {
    const base = await serve()
    expect((await fetch(`${base}/agents/identities`)).status).toBe(401)
    expect((await fetch(`${base}/agents/identities`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(403)
  })

  test('GET identities returns catalog_generation and selectionModel identities', async () => {
    const base = await serve()
    const res = await fetch(`${base}/agents/identities`, { headers: { authorization: 'Bearer secret' } })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(typeof body.catalog_generation).toBe('string')
    expect(Array.isArray(body.identities)).toBe(true)
    expect(JSON.stringify(body)).not.toContain('pendingTokenSourceModelRefresh')
    for (const identity of body.identities) {
      expect(identity.model).not.toBe('glm-5.3')
      if (identity.provider === 'claude') expect(String(identity.model)).toMatch(/^claude:/)
    }
  })

  test('passes work_dir to the service and reports the selected directory in run and status responses', async () => {
    const requests: any[] = []
    const base = await serve(request => requests.push(request))
    const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' }
    const response = await fetch(`${base}/agents/runs`, {
      method: 'POST', headers,
      body: JSON.stringify({ description: '指定目录', identity_ids: ['agent:a'], prompt: 'work', work_dir: '/repo/packages/app' }),
    })
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ run_id: 'agent_1', work_dir: '/repo/packages/app' })
    expect(requests[0]).toMatchObject({ workDir: '/repo/packages/app' })
    const status = await fetch(`${base}/agents/runs/agent_1`, { headers })
    expect(await status.json()).toMatchObject({ work_dir: '/repo/packages/app' })
    const invalid = await fetch(`${base}/agents/runs`, {
      method: 'POST', headers,
      body: JSON.stringify({ description: '目录非法', identity_ids: ['agent:a'], prompt: 'work', work_dir: '' }),
    })
    expect(invalid.status).toBe(409)
    expect(await invalid.json()).toMatchObject({ error: expect.stringContaining('work_dir') })
    expect(requests).toHaveLength(1)
  })

  test.each(['session', 'project'] as const)('%s discovery excludes subscriptions and preserves third-party Claude models without usage queries', async kind => {
    const previousSources = listTokenSources()
    let checks = 0
    const subscription: TokenSource = {
      id: 'claude-sub', kind: 'claude-subscription', agent: 'claude', display: 'Claude Code 订阅', enabled: true,
      models: [{ model: 'sonnet', display: 'Sonnet', efforts: ['high'], defaultEffort: 'high' }],
      defaultModel: 'sonnet', modelCatalogState: { status: 'ready', updatedAt: 1 },
      refreshModels: async () => {}, spawnEnv: env => env, resolveSpawnModel: model => model,
      readUsage: async () => { checks++; throw new Error('discovery must not query usage') },
    }
    const mixed: TokenSource = { ...subscription,
      id: 'packy', kind: 'packy', display: 'Packy', defaultModel: 'MiniMax-M3',
      models: [
        { model: 'claude-opus-5-5', display: 'Claude Opus', efforts: ['high'], defaultEffort: 'high' },
        { model: 'MiniMax-M3', display: 'MiniMax M3', efforts: ['default'], defaultEffort: 'default' },
      ],
    }
    resetTokenSourceRegistry()
    registerTokenSource(subscription)
    registerTokenSource(mixed)
    try {
      const before = buildAgentIdentityCatalog([subscription, mixed])
      const base = await serve(undefined, kind === 'project')
      const headers = { authorization: `Bearer ${kind === 'project' ? 'project-secret' : 'secret'}` }
      const path = `/agents/identities${kind === 'project' ? '?project=project' : ''}`
      const response = await fetch(`${base}${path}`, { headers })
      expect(response.status).toBe(200)
      const catalog = await response.json() as any
      expect(catalog.identities).toMatchObject([
        { token_source_id: 'packy', model: 'claude-opus-5-5', provider: 'claude', status: 'ready' },
        { token_source_id: 'packy', model: 'MiniMax-M3', provider: 'claude', status: 'ready' },
      ])
      expect(catalog.identities).toHaveLength(2)
      expect(catalog.source_failures).toEqual([])
      expect(buildAgentIdentityCatalog([subscription, mixed])).toEqual(before)
      expect(subscription.enabled).toBe(true)
      expect(subscription.models).toHaveLength(1)
      expect(mixed.models).toHaveLength(2)

      subscription.models.push({ model: 'future-model', display: 'Future', efforts: ['high'], defaultEffort: 'high' })
      mixed.models.push({ model: 'opaque-model', display: 'Claude Fable', efforts: ['high'], defaultEffort: 'high' })
      const refreshed = await fetch(`${base}${path}`, { headers })
      expect(refreshed.status).toBe(200)
      const refreshedCatalog = await refreshed.json() as any
      expect(refreshedCatalog.identities.map((identity: any) => identity.model)).toEqual(['claude-opus-5-5', 'MiniMax-M3', 'opaque-model'])
      expect(refreshedCatalog.identities.every((identity: any) => identity.token_source_id === 'packy')).toBe(true)
      expect(refreshedCatalog.source_failures).toEqual([])
      expect(checks).toBe(0)
    } finally {
      resetTokenSourceRegistry()
      for (const source of previousSources) registerTokenSource(source)
    }
  })

  test('creates, reads, follows up, answers, and cancels Agent runs', async () => {
    const base = await serve()
    const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' }
    const created = await fetch(`${base}/agents/runs`, {
      method: 'POST', headers, body: JSON.stringify({ description: '任务说明', identity_ids: ['agent:a'], prompt: 'do it' }),
    })
    expect(created.status).toBe(202)
    const createdBody = await created.json() as any
    expect(createdBody.run_id).toBe('agent_1')
    expect(createdBody.workers[0]).toMatchObject({ output: 'do it', final_output: '  final:do it  \n' })
    const status = await fetch(`${base}/agents/runs/agent_1`, { headers })
    expect(status.status).toBe(200)
    expect((await status.json() as any).workers[0].final_output).toBe('  final:do it  \n')

    const follow = await fetch(`${base}/agents/runs/agent_1/follow-up`, {
      method: 'POST', headers, body: JSON.stringify({ description: '继续任务', prompt: 'continue' }),
    })
    expect(follow.status).toBe(202)
    expect((await follow.json() as any)).toMatchObject({ run_id: 'agent_2', parent_kind: 'follow_up' })

    const answer = await fetch(`${base}/agents/runs/agent_1/answer`, {
      method: 'POST', headers, body: JSON.stringify({ request_id: 'r', answers: { q: 'a' } }),
    })
    expect(answer.status).toBe(200)
    expect((await fetch(`${base}/agents/runs/agent_1`, { method: 'DELETE', headers })).status).toBe(200)
  })

  test('accepts session_id plus new input and serializes the resumable session and content', async () => {
    const requests: any[] = []
    const base = await serve(request => requests.push(request))
    const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' }
    const response = await fetch(`${base}/agents/runs`, {
      method: 'POST', headers, body: JSON.stringify({ description: '任务说明', session_id: 'native-sid', prompt: '  next\n' }),
    })
    expect(response.status).toBe(202)
    expect(requests).toEqual([{ description: '任务说明', identityIds: [], sessionId: 'native-sid', prompt: '  next\n' }])
    expect(await response.json()).toMatchObject({
      description: '任务说明', workers: [{ session_id: 'native-sid', output: '  next\n' }],
    })
    const invalid = await fetch(`${base}/agents/runs`, {
      method: 'POST', headers, body: JSON.stringify({ description: '任务说明', identity_ids: ['agent:a'], session_id: '', prompt: 'next' }),
    })
    expect(invalid.status).toBe(409)
    expect(requests).toHaveLength(1)
  })

  test('project binding and request lifecycle routes enforce expected_binding before admission', async () => {
    const requests: any[] = []
    const base = await serve(value => requests.push(value), true)
    const headers = { authorization: 'Bearer project-secret', 'content-type': 'application/json' }
    const bindingResponse = await fetch(`${base}/agents/project-binding?project=project`, { headers })
    expect(bindingResponse.status).toBe(200)
    expect(await bindingResponse.json()).toEqual({
      installation_id: 'installation-test', binding_id: 'binding-test', project: 'project', chat_id: 'chat', work_dir: '/repo',
    })

    const rejected = await fetch(`${base}/agents/runs?project=project`, {
      method: 'POST', headers,
      body: JSON.stringify({ expected_binding: 'wrong', request_id: 'guarded', description: '绑定校验', identity_ids: ['agent:a'], prompt: 'work' }),
    })
    expect(rejected.status).toBe(409)
    expect((await rejected.json() as any).error).toBe('project_binding_changed')
    expect(requests).toHaveLength(0)

    const admitted = await fetch(`${base}/agents/runs?project=project`, {
      method: 'POST', headers,
      body: JSON.stringify({ expected_binding: 'binding-test', request_id: 'guarded', description: '绑定校验', identity_ids: ['agent:a'], prompt: 'work' }),
    })
    expect(admitted.status).toBe(202)
    expect(requests[0]).not.toHaveProperty('expectedBinding')
    expect(requests[0]).not.toHaveProperty('expected_binding')

    expect((await fetch(`${base}/agents/requests/guarded?project=project`, { headers })).status).toBe(409)
    const lookup = await fetch(`${base}/agents/requests/guarded?project=project&expected_binding=binding-test`, { headers })
    expect(await lookup.json()).toMatchObject({ request_id: 'guarded', state: 'admitted', run: { run_id: 'agent_1' } })
    const cancelled = await fetch(`${base}/agents/requests/guarded?project=project&expected_binding=binding-test`, { method: 'DELETE', headers })
    expect(await cancelled.json()).toMatchObject({ request_id: 'guarded', state: 'cancelled' })
    const missing = await fetch(`${base}/agents/requests/missing?project=project&expected_binding=binding-test`, { headers })
    expect(missing.status).toBe(404)

    const refused = await fetch(`${base}/agents/requests/guarded/reconcile?project=project`, {
      method: 'POST', headers,
      body: JSON.stringify({ expected_binding: 'binding-test', stopped: true, reason: 'operator verified stop' }),
    })
    expect(refused.status).toBe(403)
    const reconciled = await fetch(`${base}/agents/requests/guarded/reconcile?project=project`, {
      method: 'POST', headers: { ...headers, authorization: 'Bearer operator-secret' },
      body: JSON.stringify({ expected_binding: 'binding-test', stopped: true, reason: 'operator verified stop' }),
    })
    expect(await reconciled.json()).toMatchObject({
      request_id: 'guarded', state: 'resolved', resolution: { kind: 'operator_attested', binding_id: 'binding-test' },
    })
    expect((await fetch(`${base}/agents/project-binding?project=project`, {
      headers: { authorization: 'Bearer operator-secret' },
    })).status).toBe(403)
  })
})

test('project API authenticates independently and never upgrades session or worker credentials', async () => {
  const base = await serve(undefined, true)
  const request = { description: '独立项目任务', identity_ids: ['agent:a'], prompt: 'work' }
  const headers = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })
  for (const token of ['secret', 'wrong']) {
    expect((await fetch(`${base}/agents/runs?project=project`, { method: 'POST', headers: headers(token), body: JSON.stringify(request) })).status).toBe(403)
  }
  expect((await fetch(`${base}/agents/identities`, { headers: headers('project-secret') })).status).toBe(403)
  expect((await fetch(`${base}/agents/identities?project=`, { headers: headers('project-secret') })).status).toBe(400)
  expect((await fetch(`${base}/agents/identities?project=project&project=other`, { headers: headers('project-secret') })).status).toBe(400)
  expect((await fetch(`${base}/agents/identities?project=unknown`, { headers: headers('project-secret') })).status).toBe(409)
  const created = await fetch(`${base}/agents/runs?project=project`, { method: 'POST', headers: headers('project-secret'), body: JSON.stringify(request) })
  expect(created.status).toBe(202)
  const value = await created.json() as any
  expect(value).toMatchObject({ binding: 'project', project: 'project', work_dir: '/repo' })
  expect(value.session_name).toBeUndefined()
  for (const action of ['follow-up', 'answer']) {
    const response = await fetch(`${base}/agents/runs/agent_1/${action}?project=project`, {
      method: 'POST', headers: headers('project-secret'),
      body: JSON.stringify(action === 'follow-up' ? { description: '继续', prompt: 'next' } : { request_id: 'q', answers: { q: 'yes' } }),
    })
    expect(response.status).toBe(action === 'follow-up' ? 202 : 409)
    if (action === 'answer') expect((await response.json() as any).error).toContain('non-interactive')
  }
  expect((await fetch(`${base}/agents/runs/agent_1?project=project`, { method: 'DELETE', headers: headers('project-secret') })).status).toBe(200)
})
