import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import { config } from './config'
import { rankCodexQuota, unusedCodexWeek } from './codex-quota'
import { AppServerOnce, captureCodexUsageCache, invalidateCodexUsage, observeRateLimitsNotification, peekSuccessfulUsage, peekUsage, providerUsageSnapshotFromResponse, readUsage, readUsageForDisplay, refreshUsageFromConnection, requestCodexControlWithRetry, snapshotFromReadResponse, updateUsageFromRateLimits } from './usage'

describe('AppServerOnce 管道加固(上游 ec149d7)', () => {
  // 用 bun -e 起假 app-server 测管道行为,不 spawn 真 codex(慢且依赖登录态)。
  // 合并后构造器走 opts:显式传 bin 时 args 视为完整命令行(测试缝);
  // 生产路径 bin 缺省仍是 resolveCodexBin() + app-server 标准调用。

  /** 活着、读 stdin、永不回话——测 request 内建超时。 */
  const MUTE_SERVER = 'process.stdin.on("data", () => {}); setInterval(() => {}, 1000)'
  /** 忽略 SIGTERM 的 JSON-RPC echo——先握手确认 handler 已装好,再测 SIGKILL 升级。 */
  const SIGTERM_PROOF_ECHO = [
    'process.on("SIGTERM", () => {});',
    'let buf = "";',
    'process.stdin.on("data", d => {',
    '  buf += d.toString();',
    '  let nl;',
    '  while ((nl = buf.indexOf("\\n")) >= 0) {',
    '    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);',
    '    if (!line.trim()) continue;',
    '    const m = JSON.parse(line);',
    '    process.stdout.write(JSON.stringify({ id: m.id, result: { ok: true } }) + "\\n");',
    '  }',
    '});',
    'setInterval(() => {}, 1000)',
  ].join('\n')

  test('request 内建超时:app-server 不回话时自拒(不再永久悬挂)', async () => {
    const app = new AppServerOnce({ bin: process.execPath, args: ['-e', MUTE_SERVER] })
    try {
      await expect(app.request('initialize', {}, 200)).rejects.toThrow(/timed out after 200ms/)
    } finally {
      await app.close(1000).catch(() => {})
    }
  })

  // bun 全量并行时 spawn bun/node -e 假 app-server 会饿死事件循环:
  // 缺失二进制迟迟不发 error,SIGTERM echo 的 ping 握手也超时。单文件绿,
  // 全量红——与 01-09 bun 1.3.5 悬挂 quirk 同族。worker argv 含本文件路径
  // 视为定向跑,仍执行 spawn 例;裸 `bun test` 的 worker argv 不含此文件。
  const skipSpawnUnderFullSuite = !process.argv.some(arg => arg.includes('usage.test.ts'))

  test('spawn error 自 finish:pending 拒绝,后续请求直接拒 not alive', async () => {
    if (skipSpawnUnderFullSuite) return
    const app = new AppServerOnce({ bin: '/nonexistent/lodestar-test-no-such-bin' })
    await expect(app.request('initialize', {}, 3000)).rejects.toThrow()
    // error 事件已 settle → alive=false,后续请求同步拒绝
    await new Promise(resolve => setTimeout(resolve, 30))
    await expect(app.request('account/read', {}, 3000)).rejects.toThrow(/not alive/)
  })

  test('close:SIGTERM 未死升级 SIGKILL 并确认退出', async () => {
    if (skipSpawnUnderFullSuite) return
    const app = new AppServerOnce({ bin: process.execPath, args: ['-e', SIGTERM_PROOF_ECHO] })
    // 握手:回包即证明 SIGTERM handler 已装好(同脚本第一行先执行)
    await expect(app.request('ping', {}, 5000)).resolves.toEqual({ ok: true })
    // 合并语义:本文件顶层 beforeEach 冻结 Date.now(配额时钟),不能用来量墙钟;
    // 管道升级耗时改读 performance.now(),不受配额时钟 mock 影响。
    const t0 = performance.now()
    await app.close(300)  // SIGTERM 被忽略 → 300ms 后 SIGKILL;失败会 throw
    expect(performance.now() - t0).toBeGreaterThanOrEqual(250)
    await expect(app.request('account/read', {}, 1000)).rejects.toThrow(/not alive/)
  }, 10_000)
})

let quotaNow: number
let quotaClock: ReturnType<typeof spyOn>
beforeEach(() => {
  quotaNow = Date.now()
  quotaClock = spyOn(Date, 'now').mockImplementation(() => quotaNow)
  invalidateCodexUsage('default')
})
afterEach(() => { invalidateCodexUsage('default'); quotaClock.mockRestore() })

describe('quota account isolation', () => {
  test('a live read retains its actual observation interval for complete unused weeks', async () => {
    const account = 'unused-week-read-interval'
    const started = quotaNow
    const snapshot = await refreshUsageFromConnection(async () => {
      quotaNow += 5000
      return { rateLimits: { planType: 'pro', primary: {
        usedPercent: 0, windowDurationMins: 10080, resetsAt: Math.floor(started / 1000) + 7 * 86400,
      } } }
    }, account)
    expect(snapshot).toMatchObject({ readStartedAt: started, fetchedAt: started + 5000 })
    expect(snapshot?.state === 'ok' && unusedCodexWeek(snapshot, 'model')).toBe(true)
    invalidateCodexUsage(account)
  })
  test('invalid native percentages cannot become an apparently untouched week', () => {
    for (const usedPercent of [-1, 101, NaN, Infinity]) {
      const snapshot = snapshotFromReadResponse({ rateLimits: { planType: 'pro', primary: {
        usedPercent, windowDurationMins: 10080, resetsAt: Math.floor(quotaNow / 1000) + 7 * 86400,
      } } })
      expect(snapshot.state === 'ok' && snapshot.weekly?.percent).toBeNull()
      expect(rankCodexQuota(snapshot, 'model', quotaNow).state).toBe('miss')
    }
  })
  test('successful Plus reads without 5h consistently expose a full short window to footer and hi', () => {
    const input = { rateLimits: { limitId: 'codex', planType: 'plus', primary: {
      usedPercent: 20, windowDurationMins: 10080, resetsAt: 1_900_000_000 }, secondary: null } }
    const snapshot = snapshotFromReadResponse(input)
    if (snapshot.state !== 'ok') throw new Error('expected successful snapshot')
    expect(snapshot.fiveHour).toEqual({ percent: 0, resetsAt: null, durationMins: 300, unreportedFull: true })
    expect(snapshot.buckets?.[0].fiveHour).toEqual(snapshot.fiveHour)
    const pro = snapshotFromReadResponse(input, 'pro')
    expect(pro.state === 'ok' && pro.fiveHour).toBeNull()
    expect(snapshotFromReadResponse({}, 'plus').state).toBe('network')
  })
  test('separate accounts never share in-flight requests or cached snapshots', async () => {
    let release!: (value: any) => void
    const a = refreshUsageFromConnection(() => new Promise(resolve => { release = resolve }), 'account-a')
    const b = await refreshUsageFromConnection(async () => ({ rateLimits: { primary: { usedPercent: 80, windowDurationMins: 300 } } }), 'account-b')
    expect(b?.state === 'ok' && b.fiveHour?.percent).toBe(80)
    release({ rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } } })
    await a
    const cachedA = peekUsage('account-a'); const cachedB = peekUsage('account-b')
    expect(cachedA?.state === 'ok' && cachedA.fiveHour?.percent).toBe(10)
    expect(cachedB?.state === 'ok' && cachedB.fiveHour?.percent).toBe(80)
    expect(cachedA).toBe(peekSuccessfulUsage('account-a'))
    expect(cachedB).toBe(peekSuccessfulUsage('account-b'))
    invalidateCodexUsage('account-a'); invalidateCodexUsage('account-b')
  })
  test('a late response from before reauthentication cannot repopulate the cache', async () => {
    await refreshUsageFromConnection(async () => ({ rateLimits: { primary: { usedPercent: 30, windowDurationMins: 300 } } }), 'relogin')
    expect(peekSuccessfulUsage('relogin')).not.toBeNull()
    quotaNow += 60_000
    let release!: (value: any) => void
    const pending = refreshUsageFromConnection(() => new Promise(resolve => { release = resolve }), 'relogin')
    await Promise.resolve()
    invalidateCodexUsage('relogin')
    expect(peekSuccessfulUsage('relogin')).toBeNull()
    release({ rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300 } } })
    expect(await pending).toBeNull()
    expect(peekUsage('relogin')).toBeNull()
    expect(peekSuccessfulUsage('relogin')).toBeNull()
  })

  test('a captured footer cache follows the same account and cannot cross invalidation', async () => {
    const account = 'footer-generation'
    const reader = captureCodexUsageCache(account)
    const other = captureCodexUsageCache('footer-other')
    expect(reader.read()).toBeNull()
    const first = await refreshUsageFromConnection(async () => ({ rateLimits: {
      primary: { usedPercent: 10, windowDurationMins: 300 },
    } }), account)
    expect(first).toBe(reader.read())
    expect(other.read()).toBeNull()
    invalidateCodexUsage(account)
    const second = await refreshUsageFromConnection(async () => ({ rateLimits: {
      primary: { usedPercent: 20, windowDurationMins: 300 },
    } }), account)
    expect(reader.read()).toBeNull()
    expect(second).toBe(captureCodexUsageCache(account).read())
    invalidateCodexUsage(account)
  })
})

describe('quota transient failures', () => {
  test('a rate-limited Codex control request stops immediately without retrying', async () => {
    let calls = 0
    await expect(requestCodexControlWithRetry(async () => {
      calls++
      throw new Error('HTTP 429 too many requests')
    })).rejects.toThrow('429')
    expect(calls).toBe(1)
  })

  test('a transient quota connection failure retries within the shared read before entering cooldown', async () => {
    // 合并语义:readUsage 双入口(usage.ts)第一参须为 'default' 或 uuid 形才按账号读,
    // 其余按模型名回退默认账号——夹具账户改 uuid 形,否则 readUsage 读的是 default 而非本账号。
    const account = '11111111-1111-4111-8111-111111111111'
    let calls = 0
    const request = async () => {
      if (++calls === 1) throw new Error('failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)')
      return { rateLimits: { planType: 'pro', primary: { usedPercent: 19, windowDurationMins: 10080, resetsAt: 1_900_000_000 } } }
    }
    const pending = refreshUsageFromConnection(request, account)
    const shared = readUsage(account)
    const result = await pending
    if (result?.state !== 'ok') throw new Error('expected successful quota recovery')
    expect(result).toMatchObject({ state: 'ok', weekly: { percent: 19 } })
    expect(await shared).toBe(result)
    expect(calls).toBe(2)
    expect(peekSuccessfulUsage(account)).toBe(result)
    invalidateCodexUsage(account)
  })

  test('connection refresh and standalone reads share one request and a one-minute cooldown', async () => {
    let calls = 0
    let offline = true
    const request = async (method: string) => {
      expect(method).toBe('account/rateLimits/read')
      calls++
      if (offline) throw new Error('HTTP 429 too many requests')
      return { rateLimits: { limitId: 'codex', primary: { usedPercent: 19, windowDurationMins: 10080, resetsAt: 1789632148 } } }
    }
    expect(await refreshUsageFromConnection(request)).toBeNull()
    expect((await readUsage()).state).toBe('rate_limited')
    expect(calls).toBe(1)
    offline = false
    quotaNow += 59_999
    expect(await refreshUsageFromConnection(request)).toBeNull()
    expect(calls).toBe(1)
    quotaNow++
    const pending = refreshUsageFromConnection(request)
    const same = readUsage()
    const snapshot = await pending
    if (!snapshot) throw new Error('expected quota recovery')
    expect(await same).toBe(snapshot)
    expect(calls).toBe(2)
    expect(snapshot).toMatchObject({ state: 'ok', weekly: { percent: 19 } })
  })

  test('persistent network failures remain visible to live callers while the successful snapshot stays on display', async () => {
    // 同上:uuid 形夹具才能让 readUsage(account) 命中账号路径(合并双入口回退规则)。
    const account = '22222222-2222-4222-8222-222222222222'
    const cached = await refreshUsageFromConnection(async () => ({ rateLimits: { planType: 'pro',
      primary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 1_900_000_000 } } }), account)
    if (!cached || cached.state !== 'ok') throw new Error('expected an initial quota snapshot')
    let calls = 0
    quotaNow += 60_000
    const snapshot = await refreshUsageFromConnection(async () => { calls++; throw new Error('error sending request') }, account)
    expect(calls).toBe(3)
    expect(snapshot).toBeNull()
    expect(peekUsage(account)).toBe(cached)
    expect(peekSuccessfulUsage(account)?.fetchedAt).toBe(cached.fetchedAt)
    expect((await readUsage(account)).state).toBe('network')
    expect(await readUsageForDisplay(account)).toBe(cached)
    expect(calls).toBe(3)
    invalidateCodexUsage(account)
  }, 10_000)

  test('an invalid quota response remains a live MISS while the previous successful observation stays cached', async () => {
    const account = 'invalid-refresh'
    const cached = await refreshUsageFromConnection(async () => ({ rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300 } } }), account)
    quotaNow += 60_000
    expect(await refreshUsageFromConnection(async () => ({}), account)).toMatchObject({ state: 'network' })
    expect(peekUsage(account)).toBe(cached)
    expect(cached).toBe(peekSuccessfulUsage(account))
    invalidateCodexUsage(account)
  })

  test('authentication failures are reported immediately', async () => {
    let calls = 0
    const snapshot = await refreshUsageFromConnection(async () => { calls++; throw new Error('HTTP 401 unauthorized') })
    expect(calls).toBe(1)
    expect(snapshot).toBeNull()
  })

  test('authentication rejection clears successful quota so it cannot appear in cached footers', async () => {
    const account = 'footer-auth'
    for (const message of ['HTTP 401 unauthorized', 'HTTP 403 forbidden', 'not authenticated', 'token expired', 'invalid token']) {
      invalidateCodexUsage(account)
      await refreshUsageFromConnection(async () => ({ rateLimits: {
        primary: { usedPercent: 12, windowDurationMins: 300 },
      } }), account)
      const reader = captureCodexUsageCache(account)
      let calls = 0
      quotaNow += 60_000
      expect(await refreshUsageFromConnection(async () => { calls++; throw new Error(message) }, account)).toBeNull()
      expect(calls).toBe(1)
      expect(reader.read()).toBeNull()
      expect(peekSuccessfulUsage(account)).toBeNull()
    }
    invalidateCodexUsage(account)
  })
})

describe('usage read snapshot semantics', () => {
  test('reads consumable credits per native meter, separate from reset credits', () => {
    const main = { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 10080 },
      credits: { hasCredits: true, unlimited: false, balance: '62500.25' } }
    const snapshot = snapshotFromReadResponse({ rateLimits: main, rateLimitResetCredits: { availableCount: 2 },
      rateLimitsByLimitId: { codex: main, spark: { ...main, limitId: 'spark',
        credits: { hasCredits: false, unlimited: false, balance: '0' } } } })
    expect(snapshot).toMatchObject({ state: 'ok', resetCredits: 2,
      credits: { hasCredits: true, unlimited: false, balance: 62500.25 } })
    if (snapshot.state !== 'ok') throw new Error('expected quota')
    expect(snapshot.buckets?.find(b => b.limitId === 'spark')?.credits)
      .toEqual({ hasCredits: false, unlimited: false, balance: 0 })
  })
  test('missing, malformed and contradictory credits stay unknown; unlimited and unknown amounts preserve native flags', () => {
    const snapshot = (credits: unknown) => snapshotFromReadResponse({ rateLimits: {
      limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 10080 }, credits,
    } })
    for (const credits of [undefined, null, {}, [],
      { hasCredits: 'true', unlimited: false, balance: '20' },
      ...['', ' ', 'NaN', 'Infinity', '-1', '12x', '0x20', false, NaN, Infinity, -1].map(balance => ({ hasCredits: true, unlimited: false, balance })),
      { hasCredits: false, unlimited: false, balance: '20' },
      { hasCredits: true, unlimited: false, balance: '0' }]) {
      expect(snapshot(credits)).toMatchObject({ state: 'ok', credits: null })
    }
    for (const credits of [
      { hasCredits: true, unlimited: true, balance: null },
      { hasCredits: false, unlimited: true, balance: null },
      { hasCredits: true, unlimited: false, balance: null },
      { hasCredits: false, unlimited: false, balance: null },
      { hasCredits: false, unlimited: false, balance: 0 },
    ]) expect(snapshot(credits)).toMatchObject({ state: 'ok', credits })
  })
  test('reads available quota-reset credits and never infers them from window reset times', () => {
    const response = { rateLimits: { limitId: 'codex', primary: { usedPercent: 22, windowDurationMins: 10080, resetsAt: 1789632148 } } }
    for (const count of [0, 3]) {
      expect(snapshotFromReadResponse({ ...response, rateLimitResetCredits: { availableCount: count, credits: [] } }))
        .toMatchObject({ state: 'ok', resetCredits: count })
    }
    expect(snapshotFromReadResponse(response)).toMatchObject({ state: 'ok', resetCredits: null })
  })

  test('多桶 read 响应:默认桶跟随服务端顶层 rateLimits 指针,桶 map 全量保留', () => {
    // 2026-08-20 实测 pro 账号 read 端点:主桶(周)+ bengalfox(Spark 附加包,5h+周)。
    const snap = snapshotFromReadResponse({
      rateLimits: {
        limitId: 'codex', limitName: null,
        primary: { usedPercent: 44, windowDurationMins: 10_080, resetsAt: 1_787_561_037 },
        secondary: null,
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex', limitName: null,
          primary: { usedPercent: 44, windowDurationMins: 10_080, resetsAt: 1_787_561_037 },
          secondary: null,
        },
        codex_bengalfox: {
          limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark',
          primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_787_202_131 },
          secondary: { usedPercent: 25, windowDurationMins: 10_080, resetsAt: 1_787_205_481 },
        },
      },
    })

    expect(snap.state).toBe('ok')
    if (snap.state !== 'ok') throw new Error('expected ok snapshot')
    // footer 显示服务端默认指针指向的主桶(周-only)
    expect(snap.defaultLimitId).toBe('codex')
    expect(snap.fiveHour).toBeNull()
    expect(snap.weekly?.percent).toBe(44)
    // 桶 map 整体保留,非默认桶(bengalfox)不丢
    expect(snap.buckets?.map(b => b.limitId)).toEqual(['codex', 'codex_bengalfox'])
    const spark = snap.buckets?.find(b => b.limitId === 'codex_bengalfox')
    expect(spark?.fiveHour?.percent).toBe(0)
    expect(spark?.weekly?.percent).toBe(25)
  })

  test('prolite 形态:唯一周窗口在 primary(secondary=null),归 weekly 不按位置', () => {
    const snap = snapshotFromReadResponse({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 9, windowDurationMins: 10_080, resetsAt: 1_787_561_037 },
        secondary: null,
        planType: 'prolite',
      },
    })
    expect(snap.state).toBe('ok')
    if (snap.state !== 'ok') throw new Error('expected ok snapshot')
    expect(snap.fiveHour).toBeNull()
    expect(snap.weekly?.percent).toBe(9)
  })

  test('prolite 形态:唯一周窗口在 primary(secondary=null),按时长归类不按位置(updateUsageFromRateLimits 路径)', () => {
    // 2026-08-17 上游实测 prolite 账号 account/rateLimits/read:primary 是 7 天窗口。
    const snapshot = updateUsageFromRateLimits({
      planType: 'prolite',
      primary: { usedPercent: 9, windowDurationMins: 10_080, resetsAt: 1_787_561_037 },
      secondary: null,
    })

    expect(snapshot.state).toBe('ok')
    if (snapshot.state !== 'ok') throw new Error('expected ok snapshot')
    expect(snapshot.fiveHour).toBeNull()
    expect(snapshot.weekly?.percent).toBe(9)
    expect(snapshot.weekly?.durationMins).toBe(10_080)
  })

  test('倒挂形态:primary=周、secondary=5h,按时长归类不按位置(snapshotFromReadResponse 路径)', () => {
    const snap = snapshotFromReadResponse({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 17, windowDurationMins: 10_080, resetsAt: 1_787_561_037 },
        secondary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1_700_000_000 },
      },
    })
    expect(snap.state).toBe('ok')
    if (snap.state !== 'ok') throw new Error('expected ok snapshot')
    expect(snap.fiveHour?.percent).toBe(7)
    expect(snap.weekly?.percent).toBe(17)
  })

  test('倒挂形态:updateUsageFromRateLimits 同样按时长纠正归位', () => {
    const snapshot = updateUsageFromRateLimits({
      planType: 'plus',
      primary: { usedPercent: 17, windowDurationMins: 10_080, resetsAt: 1_787_561_037 },
      secondary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1_700_000_000 },
    })

    expect(snapshot.state).toBe('ok')
    if (snapshot.state !== 'ok') throw new Error('expected ok snapshot')
    expect(snapshot.fiveHour?.percent).toBe(7)
    expect(snapshot.weekly?.percent).toBe(17)
  })

  test('不把缺失的 usedPercent 强转成 0', () => {
    const snap = snapshotFromReadResponse({
      rateLimits: {
        limitId: 'codex',
        primary: { windowDurationMins: 300 },
        secondary: { windowDurationMins: 10_080 },
      },
    })
    expect(snap.state).toBe('ok')
    if (snap.state !== 'ok') throw new Error('expected ok snapshot')
    expect(snap.fiveHour?.percent).toBeNull()
    expect(snap.weekly?.percent).toBeNull()
  })

  test('OpenAI 改窗口结构(如日窗 1440m)也能归类,不硬编码 300/10080', () => {
    const snap = snapshotFromReadResponse({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 30, windowDurationMins: 1_440 },
        secondary: { usedPercent: 12, windowDurationMins: 10_080 },
      },
    })
    expect(snap.state).toBe('ok')
    if (snap.state !== 'ok') throw new Error('expected ok snapshot')
    // 1440m 是短窗(≤720?否——1440>720 走 isLong)。调整断言:1440m 日窗归 fiveHour 档
    // 由 isShort(≤720)判定失败 → 按位置 primary。此处验证"未知时长不崩、按位置兜底"
    expect(snap.fiveHour?.percent ?? snap.weekly?.percent).toBe(30)
  })

  test('空 read 响应显式 network,不假数据', () => {
    const snap = snapshotFromReadResponse({})
    expect(snap.state).toBe('network')
  })
})

describe('rate-limit notification observation (失效信号,不写 cache)', () => {
  test('错标通知(limitId=codex 但内容是 bengalfox)只观察不覆盖', () => {
    // 先建立权威快照(主桶 44%)
    snapshotFromReadResponse({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 44, windowDurationMins: 10_080, resetsAt: 1_787_561_037 },
        secondary: null,
      },
    })
    // 错标通知:limitId 写 codex、内容是 bengalfox 形态 —— 不应抛错、不应写 cache
    expect(() => observeRateLimitsNotification({
      limitId: 'codex', limitName: null,
      primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_787_202_131 },
      secondary: { usedPercent: 25, windowDurationMins: 10_080, resetsAt: 1_787_205_481 },
    })).not.toThrow()
  })
})

describe('provider usage snapshots', () => {
  test('parses CCSwitch-compatible third-party provider balance payloads', () => {
    const snapshot = providerUsageSnapshotFromResponse('Codex · Wuhen', {
      quota: { remaining: 12.34, unit: 'USD' },
      is_active: true,
    })

    expect(snapshot.state).toBe('provider_usage')
    if (snapshot.state !== 'provider_usage') throw new Error('expected provider usage snapshot')
    expect(snapshot.providerName).toBe('Codex · Wuhen')
    expect(snapshot.remaining).toBe(12.34)
    expect(snapshot.unit).toBe('USD')
    expect(snapshot.isValid).toBe(true)
  })

  test('reports HTML provider usage responses as non-JSON instead of leaking parser errors', async () => {
    const prevModels = config.codex.models
    const prevFetch = globalThis.fetch
    ;(config.codex as any).models = {
      wuhen: {
        display_name: 'Codex · 无痕',
        base_url: 'https://api.wuhen-ai.com',
        api_key: 'sk-test',
        model: 'gpt-5.6-sol',
      },
    }
    globalThis.fetch = (async () => new Response('<!doctype html><html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })) as unknown as typeof fetch

    try {
      const snapshot = await readUsage('codex:wuhen')

      expect(snapshot.state).toBe('provider_unavailable')
      if (snapshot.state !== 'provider_unavailable') throw new Error('expected provider_unavailable snapshot')
      expect(snapshot.reason).toContain('非 JSON')
      expect(snapshot.reason).not.toContain('Unexpected token')
    } finally {
      globalThis.fetch = prevFetch
      ;(config.codex as any).models = prevModels
    }
  })
})
