import { describe, expect, test } from 'bun:test'

import { config } from './config'
import { AppServerOnce, providerUsageSnapshotFromResponse, readUsage, updateUsageFromRateLimits } from './usage'

describe('AppServerOnce 管道加固(上游 ec149d7)', () => {
  // 用 bun -e 起假 app-server 测管道行为,不 spawn 真 codex(慢且依赖登录态)。
  // 构造器 bin/args 形参默认仍是 resolveCodexBin() + app-server,生产路径不变。

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
    const app = new AppServerOnce(process.execPath, ['-e', MUTE_SERVER])
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
    const app = new AppServerOnce('/nonexistent/lodestar-test-no-such-bin')
    await expect(app.request('initialize', {}, 3000)).rejects.toThrow()
    // error 事件已 settle → alive=false,后续请求同步拒绝
    await new Promise(resolve => setTimeout(resolve, 30))
    await expect(app.request('account/read', {}, 3000)).rejects.toThrow(/not alive/)
  })

  test('close:SIGTERM 未死升级 SIGKILL 并确认退出', async () => {
    if (skipSpawnUnderFullSuite) return
    const app = new AppServerOnce(process.execPath, ['-e', SIGTERM_PROOF_ECHO])
    // 握手:回包即证明 SIGTERM handler 已装好(同脚本第一行先执行)
    await expect(app.request('ping', {}, 5000)).resolves.toEqual({ ok: true })
    const t0 = Date.now()
    await app.close(300)  // SIGTERM 被忽略 → 300ms 后 SIGKILL;失败会 throw
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250)
    await expect(app.request('account/read', {}, 1000)).rejects.toThrow(/not alive/)
  }, 10_000)
})

describe('usage cache semantics', () => {
  test('keeps last live snapshot when a later live update payload is empty', () => {
    const snapshot = updateUsageFromRateLimits({
      planType: 'plus',
      primary: { usedPercent: 12.4, windowDurationMins: 300 },
      secondary: { usedPercent: 66.6, windowDurationMins: 10_080 },
    })

    expect(snapshot.state).toBe('ok')
    if (snapshot.state !== 'ok') throw new Error('expected ok snapshot')
    expect(snapshot.fiveHour?.percent).toBe(12.4)
    expect(snapshot.weekly?.percent).toBe(66.6)

    const kept = updateUsageFromRateLimits(null)
    expect(kept).toEqual(snapshot)
  })

  test('does not coerce missing usage percentages to 0', () => {
    const snapshot = updateUsageFromRateLimits({
      planType: 'pro',
      primary: { windowDurationMins: 300 },
      secondary: { windowDurationMins: 10_080 },
    })

    expect(snapshot.state).toBe('ok')
    if (snapshot.state !== 'ok') throw new Error('expected ok snapshot')
    expect(snapshot.fiveHour?.percent).toBeNull()
    expect(snapshot.weekly?.percent).toBeNull()
  })

  test('prolite 形态:唯一周窗口在 primary(secondary=null),按时长归类不按位置', () => {
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

  test('倒挂形态:primary=周、secondary=5h,按时长纠正归位', () => {
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
    globalThis.fetch = async () => new Response('<!doctype html><html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })

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
