import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { config } from './config'
import { readGlmUsage } from './glm-usage'
import { consoleGlmUsageContent } from './cards/console'

// 凭据走本地读法:fetchGlmUsage 内部经 claudeModelProfile('claude:glm')?.env
// 拿 config.toml [claude.models.glm] 档位注入的 ANTHROPIC_*(与 spawn 同源)。
// 与 claude-models.test.ts 同手法:直接改真实 config 单例的 glm 档位,
// afterEach 原样恢复;不用 mock.module(bun 无法 restore,会跨文件泄漏)。
const GLM_PROFILE = {
  model: 'glm-5.3',
  base_url: 'https://open.bigmodel.cn/api/anthropic',
  auth_token: 'test-token',
}

const FIVE_HOUR = { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 1, nextResetTime: 1786900000000 }
const WEEKLY = { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 17, nextResetTime: 1787500000000 }
const MONTHLY = { type: 'TIME_LIMIT', percentage: 10, currentValue: 412, usage: 4000, nextResetTime: 1787000000000 }

describe('glm quota/limit 窗口解析(TOKENS_LIMIT 双条按 unit/number 区分)', () => {
  let prevGlm: unknown
  let prevFetch: typeof globalThis.fetch

  beforeEach(() => {
    prevGlm = config.claude.models.glm
    ;(config.claude as any).models.glm = { ...GLM_PROFILE }
    prevFetch = globalThis.fetch
  })

  afterEach(() => {
    ;(config.claude as any).models.glm = prevGlm
    globalThis.fetch = prevFetch
  })

  const mockQuotaLimit = (limits: unknown[]): void => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      success: true,
      data: { level: 'max', limits },
    }), { status: 200 })) as any
  }

  test('无周限额账号:只有一条 TOKENS_LIMIT(unit=3),weekly 落 null', async () => {
    mockQuotaLimit([FIVE_HOUR, MONTHLY])
    const snap = await readGlmUsage()
    expect(snap.state).toBe('ok')
    if (snap.state !== 'ok') throw new Error('expected ok')
    expect(snap.fiveHour?.percent).toBe(1)
    expect(snap.weekly).toBeNull()
    expect(snap.monthly?.used).toBe(412)
  })

  test('有周限额账号:两条 TOKENS_LIMIT 并存,旧的 find-第一条 会丢周窗口,现在都解析', async () => {
    mockQuotaLimit([FIVE_HOUR, WEEKLY, MONTHLY])
    const snap = await readGlmUsage()
    expect(snap.state).toBe('ok')
    if (snap.state !== 'ok') throw new Error('expected ok')
    expect(snap.fiveHour?.percent).toBe(1)
    expect(snap.weekly?.percent).toBe(17)
    expect(snap.monthly?.percent).toBe(10)
  })

  test('console 周额度行:weekly 在则渲染「周额度」,无周限额账号不渲染', async () => {
    mockQuotaLimit([FIVE_HOUR, WEEKLY, MONTHLY])
    const withWeekly = await readGlmUsage()
    expect(withWeekly.state).toBe('ok')
    expect(consoleGlmUsageContent(withWeekly)).toContain('周额度')

    mockQuotaLimit([FIVE_HOUR, MONTHLY])
    const noWeekly = await readGlmUsage()
    expect(noWeekly.state).toBe('ok')
    expect(consoleGlmUsageContent(noWeekly)).not.toContain('周额度')
  })
})
