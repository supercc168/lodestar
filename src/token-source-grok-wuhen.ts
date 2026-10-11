/**
 * wuhen-ai Grok token source(Anthropic 兼容端点)—— fork 自建 provider 模块。
 *
 * 背景:v0.18+ Token Source 迁移后,旧 [claude.models.grok] 固定档位下线,
 * upstream 无 grok source 归宿(openrouter 有 host 白名单,不认 wuhen)。
 * 本模块给 wuhen-ai 的 Grok 系列开一个 claude agent source:
 *   - 模型 = OpenAI 风格 GET {origin}/v1/models 动态拉(实测标准 OpenAI 格式),
 *     过滤 grok-imagine-*(图像/视频生成,非交互 Agent 模型);
 *   - effort = 目录 reasoningEfforts[].value ∩ CLAUDE_EFFORTS(目录声明 low/
 *     medium/high/xhigh,映射到 lodestar 词表);未声明档位的模型(如 grok-4.3)
 *     给全套 CLAUDE_EFFORTS —— spawn 时 SDK 会下发,网关按自身能力忽略;
 *   - 认证 = Bearer(auth_token);额度 = wuhen 无公开余额接口,not_applicable;
 *   - enabled = config [token_source.grok-wuhen] 有 auth_token。
 * 模块加载时 registerTokenSourceFactory 声明式登记,与 glm/deepseek 同构。
 */

import type { TokenSourceConfig } from './config'
import {
  type TokenSource,
  type TokenSourceModel,
  type UsageSnapshotUnified,
  scrubAnthropicEnv,
  registerTokenSourceFactory,
} from './token-source'
import { CLAUDE_EFFORTS } from './token-source-models'
import { verifyModelExists } from './model-existence'
import { log } from './log'
import { fetchApiModelData } from './token-source-model-api'

type Env = Record<string, string | undefined>

/** wuhen 官方 Anthropic 兼容端点(实测 /v1/messages 可用,api.wuhen-ai.com)。 */
const DEFAULT_BASE_URL = 'https://api.wuhen-ai.com'

/** 交互 Agent 可用的模型前缀:grok-* 但排除 grok-imagine-*(图像/视频生成)。 */
function isAgentModel(id: string): boolean {
  return /^grok-/i.test(id) && !/^grok-imagine/i.test(id)
}

/** config models 键解析:逗号分隔 slug → 干净数组。 */
function parseModelList(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

/** 目录条目 → TokenSourceModel。reasoningEfforts 为 wuhen 私有扩展字段。 */
function toModel(entry: Record<string, unknown>): TokenSourceModel {
  const id = String(entry.id ?? '')
  const display = typeof entry.display_name === 'string' && entry.display_name
    ? entry.display_name
    : id
  const declared = Array.isArray(entry.reasoningEfforts)
    ? entry.reasoningEfforts
      .map(item => typeof item === 'object' && item !== null && 'value' in item
        ? String((item as Record<string, unknown>).value) : '')
      .filter(Boolean)
    : []
  const efforts = declared.length
    ? CLAUDE_EFFORTS.filter(effort => declared.includes(effort))
    : [...CLAUDE_EFFORTS]
  const declaredDefault = typeof entry.reasoningEffort === 'string' ? entry.reasoningEffort : undefined
  const defaultEffort = efforts.includes(declaredDefault as never)
    ? declaredDefault as TokenSourceModel['defaultEffort']
    : efforts[0] ?? null
  return { model: id, display, efforts, defaultEffort }
}

registerTokenSourceFactory({
  kind: 'grok-wuhen',
  configSectionId: 'grok-wuhen',
  build: (cfg: TokenSourceConfig, detected?: Partial<TokenSourceConfig> | null): TokenSource => {
    const baseUrl = cfg.base_url?.trim() || detected?.base_url?.trim() || DEFAULT_BASE_URL
    const token = cfg.auth_token?.trim() || detected?.auth_token?.trim() || ''
    const enabled = !!token
    const cfgDefaultModel = cfg.model?.trim() || undefined
    const ts: TokenSource = {
      id: 'grok-wuhen',
      kind: 'grok-wuhen',
      agent: 'claude',
      display: cfg.display?.trim() || 'Grok · wuhen',
      enabled,
      models: [],
      modelCatalogState: { status: enabled ? 'idle' : 'disabled', updatedAt: Date.now() },
      defaultModel: cfgDefaultModel ?? '',
      async refreshModels(): Promise<void> {
        if (!ts.enabled) {
          ts.models = []
          ts.modelCatalogState = { status: 'disabled', updatedAt: Date.now() }
          return
        }
        ts.modelCatalogState = { status: 'loading', updatedAt: null }
        try {
          const data = await fetchApiModelData(`${baseUrl.replace(/\/+$/, '')}/v1/models`, token, 'wuhen Grok models')
          const agentModels = data.filter(entry => isAgentModel(String(entry.id ?? '')))
          if (!agentModels.length) throw new Error('wuhen 目录中没有 Grok 文本模型')
          const fetched = agentModels.map(toModel)
          // config models/custom_models 键补充(上游列表滞后时手动补登),按 model 去重。
          const extra = [...new Set([...parseModelList(cfg.models), ...parseModelList(cfg.custom_models)])].filter(
            m => !fetched.some(f => f.model.toLowerCase() === m.toLowerCase()),
          )
          const extras: TokenSourceModel[] = extra.map(m => ({
            model: m, display: m, efforts: [...CLAUDE_EFFORTS], defaultEffort: 'max', origin: 'custom',
          }))
          ts.models = [...fetched, ...extras]
          if (!cfgDefaultModel) ts.defaultModel = ts.models[0]!.model
          ts.modelCatalogState = { status: 'ready', updatedAt: Date.now() }
        } catch (e: any) {
          catalogFailed(e)
        }
      },
      spawnEnv(base: Env): Env {
        // 与 glm 同构:scrub 后注入本 source 的路由/凭据,source 是唯一权威。
        const out = scrubAnthropicEnv(base)
        out.ANTHROPIC_BASE_URL = baseUrl
        out.ANTHROPIC_AUTH_TOKEN = token
        // Grok 系在 Claude Code 下的稳定运行基线(沿旧 [claude.models.grok] 档
        // DEFAULT_GROK_ENV):500K ctx / 450K 提前压缩 / 关非必要流量与归因头。
        out.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '500000'
        out.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '450000'
        out.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
        out.CLAUDE_CODE_ATTRIBUTION_HEADER = '0'
        return out
      },
      resolveSpawnModel(model: string): string | undefined {
        return model || undefined
      },
      async verifyModel(model: string) {
        return verifyModelExists(baseUrl, { Authorization: `Bearer ${token}` }, model)
      },
      async readUsage(): Promise<UsageSnapshotUnified> {
        // wuhen 无公开余额接口;额度面板如实显示"不适用"。
        return { state: 'not_applicable', windows: [] }
      },
    }
    function catalogFailed(e: unknown): void {
      log(`grok-wuhen refreshModels MISS: ${e instanceof Error ? e.message : String(e)}`)
      ts.models = []
      ts.modelCatalogState = { status: 'failed', updatedAt: Date.now(), error: e instanceof Error ? e.message : String(e) }
    }
    return ts
  },
  setup: {
    commandSuffix: 'grok-wuhen',
    hint: display => `配置 ${display}：发送 \`grok-wuhen-setup <api_key>\`。自建端点用 \`grok-wuhen-setup <base_url> <api_key>\`。`,
    parseArgs: args => {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      if (!parts.length || parts.length > 2 || /^https?:\/\//i.test(parts.at(-1)!)) {
        return { error: '用法:`grok-wuhen-setup <api_key>` 或 `grok-wuhen-setup <base_url> <api_key>`' }
      }
      const baseUrl = parts.length >= 2 ? parts[0] : undefined
      const apiKey = parts.length >= 2 ? parts[1] : parts[0]
      return { config: { agent: 'claude', ...(baseUrl ? { base_url: baseUrl } : {}), auth_token: apiKey } }
    },
    async validate(cfg) {
      await fetchApiModelData(`${(cfg.base_url ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/v1/models`, cfg.auth_token ?? '', 'wuhen Grok models')
    },
  },
  detect: {
    fromSettingsEnv(env) {
      const baseUrl = env.ANTHROPIC_BASE_URL?.trim() ?? ''
      if (!/wuhen-ai\.com$/i.test(hostOf(baseUrl))) return null
      const token = env.ANTHROPIC_AUTH_TOKEN?.trim() ?? ''
      return token ? { base_url: baseUrl, auth_token: token } : null
    },
  },
})

function hostOf(raw: string): string {
  try { return new URL(raw).hostname.toLowerCase() } catch { return '' }
}
