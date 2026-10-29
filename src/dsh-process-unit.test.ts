/**
 * DshProcess 单测:注入假 runtime,不 spawn 真实 DSH 子进程。
 *
 * 上游 722e45a 的同名文件(集成形态:真实 Node 子进程 + 本地 HTTP/SSE 模型服务)
 * 按线保留在 src/dsh-process.test.ts;本地 03-01 wave 1 的单元契约移到本文件。
 *
 * bun 的 mock.module 是进程级、异步生效(bunfig.toml 对 ./feishu 有同样说明),
 * 所以这里的替身必须对整包其它文件保持中性:mock 返回的 DshRuntime 是一个按
 * 构造时开关分派的包装类——默认透传真实 DshRuntime(集成文件与其它测试文件
 * 一律走真实路径),只有本文件 processFor() 在构造瞬间开闸才产出
 * FakeDshRuntime。本文件自身的 DshProcess 走带 query 的一次性副本导入,
 * 不复用其它测试文件可能已先行加载(并快照真实 DshRuntime)的 './dsh-process'。
 *
 * 本文件覆盖 DshProcess 与本地 AgentProcess/UserTextDispatch 契约,以及上游在
 * 722e45a 内修掉的五处缺陷对应行为(setup/cancel/内容块/意外退出/图片 MIME 中
 * 与 daemon 侧直接相关的三项)。真实子进程路径由 Task 2 的 model/list 冒烟证明;
 * 真实会话验证由用户在 daemon 重启后按 docs/dsh-testing-report.md 执行。
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDshReasoningEffort } from './agent-process'
import { DSH_PROTOCOL_VERSION, DSH_VERSION } from './dsh-protocol'

const WORKDIR = process.cwd()
const SESSION_ID = 'dsh-session-1'
const MODEL_ID = 'deepseek-v4-flash'
const MODELS = [{
  model: MODEL_ID, display: 'DeepSeek-V4-Flash', efforts: ['off', 'low', 'high', 'max'],
  defaultEffort: 'high', contextWindow: 1_000_000, isDefault: true,
}]

type NativeRequest = { method: string, params: any }

/** 假 DSH runtime:记录 RPC 调用,并允许用例按方法脚本化返回/抛出。 */
class FakeDshRuntime extends EventEmitter {
  static created: FakeDshRuntime[] = []
  readonly options: any
  readonly requests: NativeRequest[] = []
  readonly scripts = new Map<string, (params: any) => any>()
  initialized = false
  closed = false
  private alive = true

  constructor(options: any) {
    super()
    this.options = options
    FakeDshRuntime.created.push(this)
  }
  static latest(): FakeDshRuntime {
    const runtime = FakeDshRuntime.created.at(-1)
    if (!runtime) throw new Error('fake DSH runtime was never constructed')
    return runtime
  }
  initialize(): Promise<void> { this.initialized = true; return Promise.resolve() }
  request(method: string, params: any = {}): Promise<any> {
    this.requests.push({ method, params })
    const script = this.scripts.get(method)
    if (script) return Promise.resolve(script(params))
    return Promise.resolve(defaultReply(method))
  }
  isAlive(): boolean { return this.alive }
  close(): Promise<void> { this.closed = true; this.alive = false; return Promise.resolve() }
  emitExit(event: { code: number | null, signal: string | null, expected: boolean }): void {
    this.alive = false
    this.emit('exit', event)
  }
  notify(method: string, params: any): void { this.emit('notification', { method, params }) }
}

function defaultReply(method: string): any {
  switch (method) {
    case 'initialize': return { protocolVersion: DSH_PROTOCOL_VERSION, runtimeVersion: DSH_VERSION }
    case 'session/open': return { sessionId: SESSION_ID, models: MODELS }
    case 'model/list': return MODELS
    default: return {}
  }
}

// 替身只换 DshRuntime 类,须保留模块的其余导出:mock.module 在 bun test 的
// 单进程里跨文件生效,而 session.ts(03-03 起)会 import 同模块的 queryDshRuntime,
// 少一个导出会让 session.test.ts 在整包跑时以 SyntaxError 崩掉。
// 先快照真实导出:mock 生效后原命名空间自身的属性也会被改写,包装类不能再
// 从命名空间上取 DshRuntime(否则拿到的是包装类自身,构造时无限递归)。
const actualDshRuntime = { ...(await import('./dsh-runtime')) }

// 中性包装(见文件头):仅本文件在构造瞬间开闸时才产出假 runtime。
let fakeArmed = false
class SwitchableDshRuntime extends EventEmitter {
  constructor(options: any) {
    super()
    if (fakeArmed) return new FakeDshRuntime(options) as unknown as SwitchableDshRuntime
    return new actualDshRuntime.DshRuntime(options) as unknown as SwitchableDshRuntime
  }
}
mock.module('./dsh-runtime', () => ({ ...actualDshRuntime, DshRuntime: SwitchableDshRuntime }))

// 带 query 的一次性副本:确保本文件拿到的是包装类,而不是其它测试文件先行
// 加载时快照下来的真实 DshRuntime(类型经 import() 类型查询静态获得)。
type DshProcessModule = typeof import('./dsh-process')
const unitProcessSpecifier = './dsh-process.ts?dsh-unit'
const { DshProcess } = await import(unitProcessSpecifier) as DshProcessModule

type DshSpawnOptions = ConstructorParameters<typeof DshProcess>[0]
type DshProcessInstance = InstanceType<typeof DshProcess>

const live: DshProcessInstance[] = []
let scratch = ''

function processFor(overrides: Partial<DshSpawnOptions> = {}): DshProcessInstance {
  const constructed = FakeDshRuntime.created.length
  fakeArmed = true
  let proc: DshProcessInstance
  try {
    proc = new DshProcess({
      workDir: WORKDIR, tokenSourceId: 'deepseek-harness', model: MODEL_ID, effort: 'high',
      allowDelegation: false, profile: { loadProjectMcp: false }, ...overrides,
    })
  } finally { fakeArmed = false }
  proc.on('error', () => {})
  live.push(proc)
  // 恰好新建一个假 runtime:证明开闸生效(开闸失败会静默落到真实 DshRuntime)。
  expect(FakeDshRuntime.created.length).toBe(constructed + 1)
  return proc
}

function prompts(runtime: FakeDshRuntime): NativeRequest[] {
  return runtime.requests.filter(request => request.method === 'session/prompt')
}

/** 复现 bridge 的正文帧序列:start → chunk…(revision/index 严格递增)。 */
function emitChunk(runtime: FakeDshRuntime, chunk: any, attemptId = 'attempt-1'): void {
  runtime.notify('assistant.frame', { sessionId: SESSION_ID, frame: { attemptId, type: 'start', revision: 0, index: 0 } })
  runtime.notify('assistant.frame', { sessionId: SESSION_ID, frame: { attemptId, type: 'chunk', revision: 1, index: 0, chunk } })
}

function emitTurnStart(runtime: FakeDshRuntime, seq: number, turn: number): void {
  runtime.notify('session.event', { sessionId: SESSION_ID, event: { type: 'turn/start', seq, data: { turn } } })
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await Bun.sleep(1)
  }
}

beforeAll(async () => { scratch = await mkdtemp(join(tmpdir(), 'lodestar-dsh-unit-')) })
afterEach(async () => { for (const proc of live.splice(0)) await proc.kill() })
afterAll(async () => {
  // 不调 mock.restore():mock 是进程级,restore 会连带撤掉 preload 的 ./feishu
  // 替身;包装类保持注册是中性且安全的(默认透传真实 DshRuntime)。
  await rm(scratch, { recursive: true, force: true })
})

describe('DshProcess 契约', () => {
  test('ambient LODESTAR_DSH_* 不透传子进程;hostEnv 显式值保留', () => {
    const ambient = {
      LODESTAR_DSH_PROVIDER: 'zai-coding-cn', LODESTAR_DSH_MODELS: '["glm-5.3"]',
      LODESTAR_DSH_BASE_URL: 'https://ambient.example', LODESTAR_DSH_DEFAULT_MODEL: 'glm-5.3',
    }
    const saved = Object.entries(ambient).map(([key]) => [key, process.env[key]] as const)
    try {
      Object.assign(process.env, ambient, { KEEP_ME: 'untouched' })
      // 不带 hostEnv:ambient 前缀整体剥离,无关变量原样保留。
      processFor()
      const stripped = FakeDshRuntime.latest().options.env
      for (const key of Object.keys(ambient)) expect(stripped[key]).toBeUndefined()
      expect(stripped.KEEP_ME).toBe('untouched')
      // hostEnv 显式提供值:在剥离之后合并,显式值是唯一真相源。
      processFor({ hostEnv: { LODESTAR_DSH_PROVIDER: 'deepseek-official' } })
      const explicit = FakeDshRuntime.latest().options.env
      expect(explicit.LODESTAR_DSH_PROVIDER).toBe('deepseek-official')
      expect(explicit.LODESTAR_DSH_MODELS).toBeUndefined()
    } finally {
      for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    }
  })

  test('成功投递返回 queued/dsh 派发,而不是 void', async () => {
    const proc = processFor()
    const runtime = FakeDshRuntime.latest()
    await proc.initializationPromise()
    const dispatch = proc.sendUserText('hello native')
    expect(dispatch).toEqual({ kind: 'queued', provider: 'dsh' })
    await waitFor(() => prompts(runtime).length === 1)
    expect(prompts(runtime)[0].params).toEqual({
      mode: 'auto', content: [{ type: 'text', text: 'hello native' }],
    })
  })

  test('传输关闭后投递返回 rejected/dsh 且不抛', async () => {
    const proc = processFor()
    const runtime = FakeDshRuntime.latest()
    await proc.initializationPromise()
    runtime.emitExit({ code: 0, signal: null, expected: true })
    const dispatch = proc.sendUserText('too late')
    expect(dispatch.kind).toBe('rejected')
    expect(dispatch).toMatchObject({ kind: 'rejected', provider: 'dsh' })
    expect((dispatch as any).error).toBeInstanceOf(Error)
  })

  test('allowDelegation 透传 session/open:显式 false 关闭,缺省放开', async () => {
    const restricted = processFor()
    await restricted.initializationPromise()
    const restrictedOpen = FakeDshRuntime.latest().requests.find(request => request.method === 'session/open')
    expect(restrictedOpen?.params.allowDelegation).toBe(false)

    const main = processFor({ allowDelegation: undefined })
    await main.initializationPromise()
    const mainOpen = FakeDshRuntime.latest().requests.find(request => request.method === 'session/open')
    expect(mainOpen?.params.allowDelegation).toBe(true)
  })

  test('相对路径文件输入被拒且不抛', async () => {
    const proc = processFor()
    await proc.initializationPromise()
    const dispatch = proc.sendUserText('with attachment', ['relative.png'])
    expect(dispatch).toMatchObject({ kind: 'rejected', provider: 'dsh' })
  })

  test('文本 [file: …] 先过绝对路径闸门:相对引用不按 daemon cwd 读取', async () => {
    const proc = processFor()
    const runtime = FakeDshRuntime.latest()
    await proc.initializationPromise()
    // repo 根的 promo.jpg 真实存在:相对引用若被读取会落进 content。
    proc.sendUserText('看看 [file: promo.jpg] 这张图')
    await waitFor(() => prompts(runtime).length === 1)
    expect(prompts(runtime)[0].params.content).toEqual([{ type: 'text', text: '看看 [file: promo.jpg] 这张图' }])
    expect(proc.isAlive()).toBe(true)
    expect((proc as any).pendingInputs).toBe(0)
  })

  test('文本 [file: …] 读失败降级为 skip/error,不杀会话', async () => {
    const proc = processFor()
    const runtime = FakeDshRuntime.latest()
    await proc.initializationPromise()
    const errors: Error[] = []
    proc.on('error', error => errors.push(error))
    const missing = join(scratch, 'missing-text-ref.png')
    const dispatch = proc.sendUserText(`引用已失效 [file: ${missing}]`)
    expect(dispatch.kind).toBe('queued')
    await waitFor(() => prompts(runtime).length === 1)
    expect(prompts(runtime)[0].params.content).toEqual([{ type: 'text', text: `引用已失效 [file: ${missing}]` }])
    expect(errors.map(error => error.message)).toEqual([`DSH image reference skipped: ${missing}`])
    expect(proc.isAlive()).toBe(true)
    expect((proc as any).pendingInputs).toBe(0)
    expect(proc.sendUserText('still here').kind).toBe('queued')
  })

  test('显式 files 读失败仍 fail loud,计数在 finally 归零', async () => {
    const proc = processFor()
    await proc.initializationPromise()
    const errors: Error[] = []
    proc.on('error', error => errors.push(error))
    proc.sendUserText('附件', [join(scratch, 'missing-explicit.png')])
    await waitFor(() => errors.length > 0)
    expect(errors[0].message).toContain('ENOENT')
    await waitFor(() => !proc.isAlive())
    expect((proc as any).pendingInputs).toBe(0)
    expect(proc.sendUserText('again').kind).toBe('rejected')
  })

  test('listModels 返回 AgentModel 形状(原生窗口与档位)', async () => {
    const proc = processFor()
    const models = await proc.listModels()
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      id: MODEL_ID, model: MODEL_ID, displayName: 'DeepSeek-V4-Flash', description: 'DeepSeek Harness',
      hidden: false, isDefault: true, defaultReasoningEffort: 'high',
    })
    expect(models[0].supportedReasoningEfforts.map(option => option.reasoningEffort)).toEqual(['off', 'low', 'high', 'max'])
  })

  test('setModelSettings 校验 DSH 档位并在空闲时立即生效', async () => {
    const proc = processFor()
    const runtime = FakeDshRuntime.latest()
    await proc.initializationPromise()
    // 7 档合并后 medium 是合法档位;非法档仍须被拒。
    await expect(proc.setModelSettings('deepseek-v4-pro', 'ultra' as any)).rejects.toThrow('invalid DSH effort')
    await proc.setModelSettings('deepseek-v4-pro', 'medium')
    await proc.setModelSettings('deepseek-v4-pro', 'off')
    expect(runtime.requests.at(-1)).toEqual({ method: 'session/model', params: { model: 'deepseek-v4-pro', effort: 'off' } })
    expect(proc.lastModel).toBe('deepseek-v4-pro')
    expect(proc.lastEffort).toBe('off')
  })

  test('原生压缩返回 null 时抛 NothingToCompactError', async () => {
    const proc = processFor()
    FakeDshRuntime.latest().scripts.set('session/compact', () => null)
    await proc.initializationPromise()
    await expect(proc.compactThread()).rejects.toThrow('无需压缩')
  })

  test('AgentProcess 不支持的三个成员显式抛错而不是缺席', async () => {
    const proc = processFor()
    expect(() => proc.sendToolResult('call-1', 'content')).toThrow('DSH does not support sendToolResult')
    await expect(proc.setModel('deepseek-v4-pro')).rejects.toThrow('DSH does not support setModel')
    await expect(proc.injectThreadItems([])).rejects.toThrow('DSH does not support injectThreadItems')
  })

  test('sendInterrupt 走 session/cancel', async () => {
    const proc = processFor()
    const runtime = FakeDshRuntime.latest()
    await proc.initializationPromise()
    proc.sendInterrupt()
    await waitFor(() => runtime.requests.some(request => request.method === 'session/cancel'))
  })
})

describe('DSH 事件映射', () => {
  test('settled 通知产出 id 为纯数字的 dsh checkpoint', async () => {
    const proc = processFor()
    const runtime = FakeDshRuntime.latest()
    await proc.initializationPromise()
    const results: any[] = []
    proc.on('result', value => results.push(value))
    emitTurnStart(runtime, 42, 1)
    runtime.notify('settled', { sessionId: SESSION_ID, event: { seq: 42, type: 'turn/end', data: { reason: { kind: 'completed' } } } })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ is_error: false, subtype: 'completed' })
    expect(results[0].checkpoint).toEqual({
      provider: 'dsh', kind: 'event', id: '42',
      source: { provider: 'dsh', sessionId: SESSION_ID, cwd: WORKDIR },
    })
    expect(/^\d+$/.test(results[0].checkpoint.id)).toBe(true)
    expect(proc.lastCompletedTurnId).toBe('42')
  })

  test('usage 帧产出 CodexUsage 形状,contextWindow 取原生目录窗口', async () => {
    const proc = processFor()
    const runtime = FakeDshRuntime.latest()
    await proc.initializationPromise()
    const usageEvents: any[] = []
    proc.on('token_usage', value => usageEvents.push(value))
    emitChunk(runtime, { type: 'usage', usage: {
      inputTokens: 100, outputTokens: 20, totalTokens: 120,
      cacheReadTokens: 30, cacheWriteTokens: 5, reasoningTokens: 7,
    } })
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0]).toMatchObject({
      usage: {
        input_tokens: 100, output_tokens: 20, total_tokens: 120,
        cache_read_input_tokens: 30, cache_creation_input_tokens: 5, reasoning_output_tokens: 7,
      },
      contextWindow: 1_000_000, threadId: SESSION_ID,
    })
    expect(proc.lastContextTokens).toBe(135)
    expect(proc.lastTotalUsage).toMatchObject({ input_tokens: 100, output_tokens: 20 })
  })

  test('原生工具名映射到共享别名,read/write/edit 补 file_path', async () => {
    const proc = processFor()
    const runtime = FakeDshRuntime.latest()
    await proc.initializationPromise()
    const names = new Map<string, string>()
    const inputs = new Map<string, any>()
    proc.on('tool_use', value => { names.set(value.id, value.name); inputs.set(value.id, value.input) })
    const aliases: Record<string, string> = { bash: 'Bash', read: 'Read', write: 'Write', edit: 'Edit', glob: 'Glob', grep: 'Grep' }
    for (const native of Object.keys(aliases)) {
      runtime.notify('session.event', { sessionId: SESSION_ID, event: { type: 'tool/call',
        data: { callId: `call-${native}`, name: native, arguments: JSON.stringify({ path: `${native}.ts` }) } } })
    }
    runtime.notify('session.event', { sessionId: SESSION_ID, event: { type: 'tool/call',
      data: { callId: 'call-native', name: 'job_output', arguments: '{}' } } })
    for (const [native, alias] of Object.entries(aliases)) expect(names.get(`call-${native}`)).toBe(alias)
    expect(names.get('call-native')).toBe('job_output')
    expect(inputs.get('call-read')).toMatchObject({ path: 'read.ts', file_path: 'read.ts' })
    expect(inputs.get('call-bash')).toEqual({ path: 'bash.ts' })
  })

  test('意外失败保留为非预期退出,不被干净的 exit/result 掩蔽', async () => {
    const proc = processFor()
    const runtime = FakeDshRuntime.latest()
    await proc.initializationPromise()
    const errors: Error[] = []
    const results: any[] = []
    const exits: any[] = []
    proc.on('error', error => errors.push(error))
    proc.on('result', value => results.push(value))
    proc.on('exit', value => exits.push(value))
    emitTurnStart(runtime, 1, 1)
    runtime.notify('failure', { message: 'DSH exited code=0 signal=null\nstderr tail: native protocol failed' })
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('stderr tail: native protocol failed')
    expect(results[0]).toMatchObject({ is_error: true, subtype: 'error' })
    runtime.emitExit({ code: 0, signal: null, expected: true })
    expect(exits).toEqual([{ code: 0, signal: null, expected: false }])
  })

  test('图片按字节嗅探 MIME,未知字节不臆断为图片', async () => {
    const proc = processFor()
    const runtime = FakeDshRuntime.latest()
    await proc.initializationPromise()
    const cases: Array<[string, Buffer, string]> = [
      ['png-download.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]), 'image/png'],
      ['jpeg-download.png', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), 'image/jpeg'],
      ['gif-download.png', Buffer.from('GIF87a-gif-payload', 'ascii'), 'image/gif'],
      ['webp-download.png', Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0x1a, 0x00, 0x00, 0x00]), Buffer.from('WEBP', 'ascii')]), 'image/webp'],
    ]
    for (const [name, bytes, mediaType] of cases) {
      const file = join(scratch, name)
      await writeFile(file, bytes)
      const expected = prompts(runtime).length + 1
      proc.sendUserText('inspect the attachment', [file])
      await waitFor(() => prompts(runtime).length === expected)
      const content = prompts(runtime).at(-1)!.params.content
      expect(content[0]).toMatchObject({ type: 'text' })
      expect(content[1]).toMatchObject({ type: 'image', mediaType, name })
    }
    const bad = join(scratch, 'unknown-download.png')
    await writeFile(bad, Buffer.from('definitely not an image'))
    const errors: Error[] = []
    proc.on('error', error => errors.push(error))
    proc.sendUserText('inspect the attachment', [bad])
    await waitFor(() => errors.length > 0)
    expect(errors[0].message).toContain('unsupported or invalid raster bytes')
    expect(prompts(runtime)).toHaveLength(cases.length)
  })
})

describe('isDshReasoningEffort', () => {
  test('接受七档 off/minimal/low/medium/high/xhigh/max', () => {
    for (const value of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) expect(isDshReasoningEffort(value)).toBe(true)
  })
  test('拒绝非 DSH 档位与非字符串值', () => {
    for (const value of ['ultra', 'none', '', null, undefined, 1, {}, []]) {
      expect(isDshReasoningEffort(value)).toBe(false)
    }
  })
})
