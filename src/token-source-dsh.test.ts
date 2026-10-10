/**
 * DeepSeek Harness 凭据层单测(合并形态:上游 0.20.x factory 注册 + 本地档位语义)。
 *
 * 上游同名文件断言的是工厂注册与凭据隔离形态;本地 fork 的 dsh 语义(原生模型名、
 * 无 [1m] 后缀、DSH_DEFAULT_MODEL bootstrap 兜底、spawnEnv 双轨清洗顺序)在
 * factory().build() 产物上原样保留。不 spawn 任何子进程、不打真实网络
 * (余额用例走 fetch 替身)。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { readDeepseekBalance } from './claude-provider-usage'
import { tokenSourceFactories } from './token-source'
import { DSH_DEFAULT_MODEL, DSH_TOKEN_SOURCE_ID } from './token-source-dsh'

const factory = () => tokenSourceFactories().find(entry => entry.kind === 'deepseek-harness')!

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

describe('DeepSeek Harness source isolation (upstream)', () => {
  test('requires its own explicit credential and does not enable the legacy Claude source', async () => {
    const source = factory().build({})
    expect(source.agent).toBe('dsh')
    expect(source.enabled).toBe(false)
    await source.refreshModels()
    expect(source.modelCatalogState?.status).toBe('disabled')
    expect(source.models).toEqual([])
    expect(() => source.spawnEnv({ DEEPSEEK_API_KEY: 'ambient-key' })).toThrow('missing')
  })

  test('replaces account and Harness overrides while retaining the caller capability', () => {
    const source = factory().build({ api_key: 'configured-key', base_url: 'http://127.0.0.1:1234', bin: '/explicit/node' })
    const env = source.spawnEnv({ ANTHROPIC_API_KEY: 'old', ANTHROPIC_BASE_URL: 'old',
      DEEPSEEK_API_KEY: 'old', DSH_HOME: '/foreign/home', LODESTAR_AGENT_CAPABILITY: 'caller', PATH: '/bin' })
    expect(env).toEqual({ DEEPSEEK_API_KEY: 'configured-key', DEEPSEEK_BASE_URL: 'http://127.0.0.1:1234',
      LODESTAR_DSH_NODE: '/explicit/node', LODESTAR_DSH_PROVIDER: 'deepseek-official', LODESTAR_AGENT_CAPABILITY: 'caller', PATH: '/bin' })
  })

  test('registers the independent setup command', () => {
    expect(factory().setup?.commandSuffix).toBe('deepseek-harness')
    expect(factory().setup?.parseArgs('test-key')).toEqual({ config: { agent: 'dsh', api_key: 'test-key' } })
  })
})

describe('DeepSeek Harness 本地档位语义(factory 形态)', () => {
  test('DSH 原生常量:source id 与 bootstrap 默认档', () => {
    expect(DSH_TOKEN_SOURCE_ID).toBe('deepseek-harness')
    expect(DSH_DEFAULT_MODEL).toBe('deepseek-v4-pro')
    const source = factory().build({ api_key: 'k' })
    expect(source.id).toBe(DSH_TOKEN_SOURCE_ID)
    expect(source.kind).toBe('deepseek-harness')
    expect(source.modelCatalogState?.status).toBe('idle')
  })

  test('defaultModel 是 DSH 原生模型名,不带 [1m] 后缀语义', () => {
    expect(factory().build({}).defaultModel).toBe(DSH_DEFAULT_MODEL)
    const configured = factory().build({ api_key: 'k', model: 'deepseek-v4-flash' }).defaultModel
    expect(configured).toBe('deepseek-v4-flash')
    expect(configured).not.toContain('[1m]')
    expect(factory().build({ api_key: 'k' }).defaultModel).not.toContain('[1m]')
  })

  test('enabled 门控:缺 api_key 为假,空白键不算配置,填了为真', () => {
    expect(factory().build({}).enabled).toBe(false)
    expect(factory().build({ api_key: '   ' }).enabled).toBe(false)
    expect(factory().build({ api_key: 'k' }).enabled).toBe(true)
  })

  test('display 缺省为 DeepSeek Harness,配置段透传', () => {
    expect(factory().build({ api_key: 'k' }).display).toBe('DeepSeek Harness')
    expect(factory().build({ api_key: 'k', display: 'DSH 账号' }).display).toBe('DSH 账号')
  })

  test('spawnEnv 缺省回落官方 base_url,并注入 deepseek-official provider 标记', () => {
    const env = factory().build({ api_key: 'k' }).spawnEnv({})
    expect(env.DEEPSEEK_BASE_URL).toBe('https://api.deepseek.com')
    expect(env.LODESTAR_DSH_PROVIDER).toBe('deepseek-official')
  })

  test('未配置 bin 时不写 LODESTAR_DSH_NODE 逃生阀', () => {
    const env = factory().build({ api_key: 'k', bin: '' }).spawnEnv({ LODESTAR_DSH_NODE: '/foreign/node' })
    expect(env.LODESTAR_DSH_NODE).toBeUndefined()
  })

  test('未配置凭据时抛错而不是注入空值', () => {
    expect(() => factory().build({}).spawnEnv({}))
      .toThrow('DeepSeek Harness API key is missing')
  })

  test('spawnEnv(D-08 双轨隔离的单入口):先清洗再注入,调用方 capability/PATH 保留', () => {
    const env = factory().build({
      api_key: 'dsh-key',
      base_url: 'https://api.deepseek.com/anthropic',
      bin: '/opt/node/bin/node',
    }).spawnEnv({
      ANTHROPIC_API_KEY: 'stray-key',
      ANTHROPIC_AUTH_TOKEN: 'stray-token',
      ANTHROPIC_BASE_URL: 'https://stray.example',
      DSH_HOME: '/foreign/dsh-home',
      DSH_PERMISSION_MODE: 'danger-full-access',
      DEEPSEEK_API_KEY: 'ambient-old-key',
      DEEPSEEK_BASE_URL: 'https://ambient.example',
      LODESTAR_DSH_NODE: '/foreign/node',
      LODESTAR_AGENT_CAPABILITY: 'caller-capability',
      PATH: '/usr/bin',
    })

    expect(Object.keys(env).filter(key => key.startsWith('ANTHROPIC_'))).toEqual([])
    expect(env.DSH_HOME).toBeUndefined()
    expect(env.DEEPSEEK_API_KEY).toBe('dsh-key')
    expect(env.DEEPSEEK_BASE_URL).toBe('https://api.deepseek.com/anthropic')
    expect(env.LODESTAR_DSH_NODE).toBe('/opt/node/bin/node')
    expect(env.LODESTAR_DSH_PROVIDER).toBe('deepseek-official')
    expect(env.LODESTAR_AGENT_CAPABILITY).toBe('caller-capability')
    expect(env.PATH).toBe('/usr/bin')
  })
})

describe('DSH 余额通道(复用既有 deepseek_balance 解析)', () => {
  test('对 base_url 的 origin 拼 /user/balance 并解析为 ok 快照', async () => {
    const urls: string[] = []
    globalThis.fetch = (async (input: any) => {
      urls.push(String(input))
      return new Response(JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '0.00', topped_up_balance: '12.34' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const snapshot = await readDeepseekBalance('https://api.deepseek.com/anthropic', 'k', 'DeepSeek Harness')
    expect(urls).toEqual(['https://api.deepseek.com/user/balance'])
    expect(snapshot.state).toBe('ok')
    if (snapshot.state !== 'ok') throw new Error('unreachable')
    expect(snapshot.providerName).toBe('DeepSeek Harness')
    expect(snapshot.remaining).toBe('12.34')
    expect(snapshot.unit).toBe('CNY')
  })

  test('非 deepseek 主机不落入该分支,也不发请求', async () => {
    let called = 0
    globalThis.fetch = (async () => { called += 1; return new Response('{}') }) as unknown as typeof fetch
    const snapshot = await readDeepseekBalance('https://relay.example/anthropic', 'k', 'relay')
    expect(called).toBe(0)
    expect(snapshot.state).toBe('unavailable')
  })

  test('鉴权失败与限流按既有多态分类,不假数据', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
    expect((await readDeepseekBalance('https://api.deepseek.com', 'k', 'dsh')).state).toBe('unavailable')
    globalThis.fetch = (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch
    expect((await readDeepseekBalance('https://api.deepseek.com', 'k', 'dsh')).state).toBe('rate_limited')
  })
})
