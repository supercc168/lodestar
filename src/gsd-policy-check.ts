import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { log } from './log'

/**
 * GSD Codex 子 agent 分层策略一致性检查(harness 规则)。
 * 调用 yiui-gsd.mjs check-policy(只读):defaults 受管键 + 静态 TOML 分层 +
 * flex 残留 + bake 时间戳。任何漂移 → ok:false,由 session-gsd 在注入前
 * 把告警块写进 GSD 注入提示,主 agent 先自愈再推进。
 */

export interface GsdPolicyCheckResult {
  ok: boolean
  drift: string[]
  /** 脚本缺失/执行异常时放行(不阻塞 GSD 注入),仅记日志。 */
  skipped: boolean
}

const CHECK_CACHE_MS = 30_000

let cached: { at: number; result: GsdPolicyCheckResult } | null = null

/** 定位 yiui-gsd 策略脚本:repo 布局优先(dev/installed),env 可覆盖。 */
function gsdPolicyScriptPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.env.LODESTAR_GSD_POLICY_SCRIPT,
    // dev: src/gsd-policy-check.ts → ../.agents/skills/yiui-gsd/scripts
    join(here, '..', '.agents', 'skills', 'yiui-gsd', 'scripts', 'yiui-gsd.mjs'),
    // cwd fallback(daemon 从 repo 根启动等)
    join(process.cwd(), '.agents', 'skills', 'yiui-gsd', 'scripts', 'yiui-gsd.mjs'),
  ].filter((p): p is string => !!p)
  return candidates.find((p) => existsSync(p)) ?? null
}

/** 解析 check-policy 的 JSON 输出,解析失败返回 null。 */
function parseCheckOutput(stdout: string): { ok: boolean; drift: string[] } | null {
  try {
    const parsed = JSON.parse(stdout) as { ok?: unknown; drift?: unknown }
    if (typeof parsed.ok !== 'boolean' || !Array.isArray(parsed.drift)) return null
    return {
      ok: parsed.ok,
      drift: parsed.drift.filter((d): d is string => typeof d === 'string'),
    }
  } catch {
    return null
  }
}

/**
 * 检查 GSD Codex 分层策略是否与 yiui-gsd bake 一致。
 * 结果缓存 30s,避免连续 continue/new 重复起进程;脚本缺失或执行异常按
 * 放行处理(不阻塞 GSD 注入),只记日志。
 */
export function checkGsdCodexPolicy(): GsdPolicyCheckResult {
  const now = Date.now()
  if (cached && now - cached.at < CHECK_CACHE_MS) return cached.result
  const script = gsdPolicyScriptPath()
  if (!script) {
    const result = { ok: true, drift: [], skipped: true }
    cached = { at: now, result }
    return result
  }
  try {
    const res = spawnSync(process.execPath, [script, 'check-policy', '--runtime', 'codex'], {
      timeout: 10_000,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    })
    let result: GsdPolicyCheckResult
    if (res.error) {
      log(`gsd codex policy check error: ${res.error.message}`)
      result = { ok: true, drift: [], skipped: true }
    } else if (res.status === 0) {
      result = { ok: true, drift: [], skipped: false }
    } else {
      const parsed = parseCheckOutput(res.stdout)
      result = parsed
        ? { ok: parsed.ok, drift: parsed.drift, skipped: false }
        : { ok: false, drift: [`check-policy exit ${res.status} unparseable output`], skipped: false }
    }
    cached = { at: now, result }
    return result
  } catch (error) {
    log(`gsd codex policy check failed: ${error instanceof Error ? error.message : String(error)}`)
    return { ok: true, drift: [], skipped: true }
  }
}

/** 测试用:重置检查缓存。 */
export function resetGsdPolicyCheckCacheForTests(): void {
  cached = null
}
