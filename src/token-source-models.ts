/**
 * Token source 模型列表拉取 —— codex 订阅走 `model/list`(真相源)。
 *
 * codex 订阅的可用模型由 app-server 的 `model/list` 返回:每个模型带
 * displayName / description / isDefault / per-model supportedReasoningEfforts /
 * hidden。这里过滤 hidden、映射 effort,产出 TokenSourceModel[]。零写死。
 *
 * glm Coding Plan 的模型是订阅固定覆盖(GLM-5.2[1m] / GLM-4.7),直接内置在
 * token-source-builtins.ts —— 因为 /paas/v4/models 返回的是开放平台全集、命名
 * (小写 glm-5.2)还匹配不上 anthropic 端点要的大写 GLM-5.2[1m],非 Coding Plan
 * 真相。额度仍动态拉(quota/limit)。
 */

import { AppServerOnce } from './usage'
import type { TokenSourceModel } from './token-source'
import type { AgentReasoningEffort } from './agent-process'

const TIMEOUT_MS = 10_000

function withTimeout<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

const CODEX_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
function codexEffort(e: unknown): AgentReasoningEffort | null {
  return typeof e === 'string' && (CODEX_EFFORTS as string[]).includes(e)
    ? e as AgentReasoningEffort
    : null
}

/**
 * 拉取 codex 订阅的可用模型(app-server `model/list`)。过滤 hidden,effort 用
 * 每个模型各自的 supportedReasoningEfforts(defaultReasoningEffort 落点)。
 * 失败抛错 —— 调用方(refreshModels)按 MISS 留空 models,绝不假数据。
 */
export async function fetchCodexModels(): Promise<TokenSourceModel[]> {
  const app = new AppServerOnce()
  try {
    await withTimeout(app.request('initialize', {
      clientInfo: { name: 'lodestar-models', version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }))
    const res = await withTimeout(app.request('model/list', {}))
    const data: any[] = Array.isArray(res?.data) ? res.data : []
    const out: TokenSourceModel[] = []
    for (const m of data) {
      if (!m || m.hidden || !m.id) continue
      const efforts = (Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : [])
        .map((e: any) => codexEffort(e?.reasoningEffort))
        .filter((e): e is AgentReasoningEffort => e !== null)
      if (!efforts.length) continue
      const defaultEffort = codexEffort(m.defaultReasoningEffort) ?? efforts[0]
      out.push({
        model: String(m.id),
        display: typeof m.displayName === 'string' && m.displayName ? String(m.displayName) : String(m.id),
        efforts,
        defaultEffort,
      })
    }
    return out
  } finally {
    await app.close()
  }
}
