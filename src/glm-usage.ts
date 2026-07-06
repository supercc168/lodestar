/**
 * GLM Coding Plan 用量快照 —— 给 `hi` console 面板的 claude/GLM 后端用。
 *
 * 数据源是 GLM 官方 `glm-plan-usage` 插件背后同一条 monitor API(逆向自
 * zai-org/zai-coding-plugins 的 query-usage.mjs),daemon 直接打,不走
 * plugin/agent/skill 那套(那是 Claude Code CLI 用的):
 *
 *   GET {baseDomain}/api/monitor/usage/quota/limit
 *
 * 鉴权凭据从 config.toml 的 [claude.models.glm] 档位拿 —— 经 claude-models.ts
 * 的 claudeModelProfile('claude:glm') 读出,与 spawn 子进程时注入的 env 同源
 * (base_url/auth_token → ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN),额度查询看
 * 到的就是实际跑会话用的那套配置:
 *   ANTHROPIC_AUTH_TOKEN → 裸 token,直接作 Authorization header(不带 Bearer)
 *   ANTHROPIC_BASE_URL   → 判定平台 host(open.bigmodel.cn=ZHIPU / api.z.ai=ZAI)
 *
 * 失败可见 (no_fallbacks):无凭据 / 非 GLM 后端 / 限流 / 网络各自显式标 MISS,
 * 绝不假数据。与 src/usage.ts(Codex 侧)的 snapshot 模式对齐。
 */

import { claudeModelProfile } from './claude-models'
import { log } from './log'

const API_TIMEOUT_MS = 10_000

export interface GlmUsageWindow {
  /** 0–100 已用百分比;未知为 null(MISS) */
  percent: number | null
  /** 下次重置;未知为 null */
  resetsAt: Date | null
}

export interface GlmMonthlyWindow extends GlmUsageWindow {
  /** 已用绝对值(调用次数);TIME_LIMIT 才有 */
  used?: number
  /** 周期总额度;TIME_LIMIT 才有 */
  total?: number
}

export type GlmUsageSnapshot =
  | { state: 'no_credentials' }
  | { state: 'not_glm'; baseUrl?: string }
  | { state: 'rate_limited' }
  | { state: 'network'; reason?: string }
  | {
      state: 'ok'
      /** 套餐档位(open.bigmodel.cn 的 level 字段:max / standard / …) */
      level?: string
      /** 5 小时 token 滚动窗口(TOKENS_LIMIT) */
      fiveHour: GlmUsageWindow | null
      /** 月度工具/MCP 用量(TIME_LIMIT) */
      monthly: GlmMonthlyWindow | null
      fetchedAt: number
    }

type GlmUsageSnapshotOk = Extract<GlmUsageSnapshot, { state: 'ok' }>

let cache: GlmUsageSnapshot | null = null
let inFlight: Promise<GlmUsageSnapshot> | null = null

/** 从 ANTHROPIC_BASE_URL 取 protocol//host;非法返回 null。 */
function baseDomain(baseUrl: string): string | null {
  try {
    const u = new URL(baseUrl)
    return `${u.protocol}//${u.host}`
  } catch {
    return null
  }
}

/** 判定是否 GLM 平台host,返回 domain 或 null(非 GLM)。 */
function glmDomain(baseUrl: string): string | null {
  if (!baseUrl) return null
  const domain = baseDomain(baseUrl)
  if (!domain) return null
  if (baseUrl.includes('open.bigmodel.cn') || baseUrl.includes('dev.bigmodel.cn')) return domain
  if (baseUrl.includes('api.z.ai')) return domain
  return null
}

function clampPct(v: unknown): number | null {
  return typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(100, v)) : null
}

function resetDate(ms: unknown): Date | null {
  return typeof ms === 'number' && isFinite(ms) && ms > 0 ? new Date(ms) : null
}

/** 解析 quota/limit 响应 → ok 快照;limits 缺字段按 null(MISS)渲染。 */
function parseQuotaLimit(data: any): GlmUsageSnapshotOk {
  const limits: any[] = Array.isArray(data?.limits) ? data.limits : []
  const tokens = limits.find(l => l?.type === 'TOKENS_LIMIT')
  const time = limits.find(l => l?.type === 'TIME_LIMIT')
  const fiveHour: GlmUsageWindow | null = tokens
    ? { percent: clampPct(tokens.percentage), resetsAt: resetDate(tokens.nextResetTime) }
    : null
  const monthly: GlmMonthlyWindow | null = time
    ? {
        percent: clampPct(time.percentage),
        resetsAt: resetDate(time.nextResetTime),
        ...(typeof time.currentValue === 'number' ? { used: time.currentValue } : {}),
        ...(typeof time.usage === 'number' ? { total: time.usage } : {}),
      }
    : null
  return {
    state: 'ok',
    level: typeof data?.level === 'string' && data.level ? data.level : undefined,
    fiveHour,
    monthly,
    fetchedAt: Date.now(),
  }
}

async function fetchGlmUsage(): Promise<GlmUsageSnapshot> {
  // 与 spawn 子进程同源:从 config.toml [claude.models.glm] 档位拿注入用的
  // ANTHROPIC_* env。读不到 token = 该档位未配置 → no_credentials。
  const env = claudeModelProfile('claude:glm')?.env ?? {}
  const token = env.ANTHROPIC_AUTH_TOKEN
  const baseUrl = env.ANTHROPIC_BASE_URL || ''
  if (!token) return { state: 'no_credentials' }

  const domain = glmDomain(baseUrl)
  if (!domain) return { state: 'not_glm', baseUrl: baseUrl || undefined }

  const url = `${domain}/api/monitor/usage/quota/limit`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US,en',
      },
      signal: controller.signal,
    })
    if (res.status === 429) return { state: 'rate_limited' }
    if (!res.ok) return { state: 'network', reason: `HTTP ${res.status}` }
    const json = await res.json()
    if (json?.success === false || (typeof json?.code === 'number' && json.code !== 200)) {
      return { state: 'network', reason: json?.msg ? String(json.msg) : `code ${json?.code}` }
    }
    const data = json?.data ?? json
    return parseQuotaLimit(data)
  } catch (e: any) {
    const reason = e?.name === 'AbortError' ? `timeout ${API_TIMEOUT_MS}ms` : (e?.message ?? String(e))
    log(`glm-usage: quota/limit fetch failed: ${reason}`)
    return { state: 'network', reason }
  } finally {
    clearTimeout(timer)
  }
}

export async function readGlmUsage(): Promise<GlmUsageSnapshot> {
  if (inFlight) return inFlight
  inFlight = fetchGlmUsage()
    .then(d => {
      inFlight = null
      // 网络态保留上次成功的 cache(若有),否则如实返回失败态 ——
      // 与 usage.ts 一致:绝不假数据。
      if (d.state === 'network') return cache ?? d
      cache = d
      return d
    })
    .catch(e => {
      log(`glm-usage: fetchGlmUsage threw: ${e}`)
      inFlight = null
      return cache ?? { state: 'network', reason: String(e) }
    })
  return inFlight
}
