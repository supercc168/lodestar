/**
 * DeepSeek Harness 凭据层单测(03-02 Task 2,上游 722e45a 的本地 slim 重写)。
 *
 * 上游同名文件断言的是工厂注册与目录拉取形态。本地 token-source 是函数式 slim
 * 适配层(项目铁律:不得引入 [token_source.*] 注册表、双层 model 面板、source 级
 * 目录刷新),故本文件断言的是 `dshSourceFromConfig()` 这一个纯工厂的凭据面:
 * env 清洗顺序 → 注入 → 门控 → 余额通道。不 spawn 任何子进程、不打真实网络。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { readDeepseekBalance } from './claude-provider-usage'
import { dshSourceFromConfig } from './token-source-dsh'

const FULL = {
  api_key: 'dsh-key',
  base_url: 'https://api.deepseek.com/anthropic',
  model: 'deepseek-v4-pro',
  bin: '/opt/node/bin/node',
  display: 'DSH 账号',
}

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

describe('dshSourceFromConfig 源形状', () => {
  test('id/provider/kind/usageSource/isApiRoute 与 provider 语义一致', () => {
    const source = dshSourceFromConfig(FULL)
    expect(source.id).toBe('deepseek-harness')
    expect(source.provider).toBe('dsh')
    expect(source.kind).toBe('api')
    expect(source.usageSource()).toBe('provider')
    expect(source.isApiRoute()).toBe(true)
    expect(source.displayName).toBe('DSH 账号')
  })

  test('selectionModel 是 DSH 原生模型名,不带 [1m] 后缀语义', () => {
    const source = dshSourceFromConfig({ ...FULL, model: 'deepseek-v4-flash' })
    expect(source.selectionModel).toBe('deepseek-v4-flash')
    expect(source.resolveSpawnModel()).toBe('deepseek-v4-flash')
    expect(source.selectionModel).not.toContain('[1m]')
    expect(source.resolveSpawnModel()).not.toContain('[1m]')
  })

  test('未配置段时可见但 disabled,不写默认凭据', () => {
    const source = dshSourceFromConfig(undefined)
    expect(source.enabled()).toBe(false)
    expect(source.selectionModel).toBe('deepseek-v4-pro')
    expect(source.resolveSpawnModel()).toBe('deepseek-v4-pro')
  })

  test('spawnOverrides 对 dsh 无语义,返回空覆盖', () => {
    expect(dshSourceFromConfig(FULL).spawnOverrides()).toEqual({ modelId: undefined, configArgs: [], env: {} })
  })
})

describe('enabled() 门控', () => {
  test('缺 api_key 为假(不抛),填了为真;空白键不算配置', () => {
    expect(dshSourceFromConfig({}).enabled()).toBe(false)
    expect(dshSourceFromConfig({ api_key: '   ' }).enabled()).toBe(false)
    expect(dshSourceFromConfig(undefined).enabled()).toBe(false)
    expect(dshSourceFromConfig({ api_key: 'k' }).enabled()).toBe(true)
  })
})

describe('spawnEnv(D-08 双轨隔离的单入口)', () => {
  test('先清洗 ANTHROPIC_* / DSH_* / DEEPSEEK_* / LODESTAR_DSH_NODE,再注入两条 DeepSeek 变量', () => {
    const env = dshSourceFromConfig(FULL).spawnEnv({
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
    expect(env.LODESTAR_AGENT_CAPABILITY).toBe('caller-capability')
    expect(env.PATH).toBe('/usr/bin')
  })

  test('base_url 缺省回落官方 https://api.deepseek.com', () => {
    const env = dshSourceFromConfig({ api_key: 'k' }).spawnEnv({})
    expect(env.DEEPSEEK_BASE_URL).toBe('https://api.deepseek.com')
  })

  test('未配置 bin 时不写 LODESTAR_DSH_NODE 逃生阀', () => {
    const env = dshSourceFromConfig({ api_key: 'k', bin: '' }).spawnEnv({ LODESTAR_DSH_NODE: '/foreign/node' })
    expect(env.LODESTAR_DSH_NODE).toBeUndefined()
  })

  test('未配置凭据时抛错而不是注入空值', () => {
    expect(() => dshSourceFromConfig(undefined).spawnEnv({}))
      .toThrow('DeepSeek Harness API key is missing')
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
    globalThis.fetch = (async () => { called += 1; return new Response('{}') }) as typeof fetch
    const snapshot = await readDeepseekBalance('https://relay.example/anthropic', 'k', 'relay')
    expect(called).toBe(0)
    expect(snapshot.state).toBe('unavailable')
  })

  test('鉴权失败与限流按既有多态分类,不假数据', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 401 })) as typeof fetch
    expect((await readDeepseekBalance('https://api.deepseek.com', 'k', 'dsh')).state).toBe('unavailable')
    globalThis.fetch = (async () => new Response('{}', { status: 429 })) as typeof fetch
    expect((await readDeepseekBalance('https://api.deepseek.com', 'k', 'dsh')).state).toBe('rate_limited')
  })
})
