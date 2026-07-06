import { config, type CodexModelConfig } from './config'
import { CODEX_EFFORT, isCodexReasoningEffort, type CodexReasoningEffort } from './codex-process'

export interface CodexModelProfile {
  key: string            // 'codex:<slug>'
  name: string           // 原始 slug
  displayName: string
  description: string
  /** 发给 app-server thread/start 的真实模型 id。 */
  modelId: string
  route: 'login' | 'api'
  /** lodestar 注入的 provider id(model_provider 覆盖值);login 恒 ''。 */
  providerSlug: string
  /** spawn 注入的 env(装 key);login / 无 api_key 时为空。 */
  env: Record<string, string>
  /** spawn 追加的 `-c` 覆盖对(flat: '-c','k=v',…);login 恒 []。 */
  configArgs: string[]
  /** login 恒 true;api 需 base_url +(api_key 或 requires_openai_auth)+ model。 */
  configured: boolean
}

const DEFAULT_WIRE_API = 'chat'

/** slug 归一为合法的 provider id / env 片段:非 [A-Za-z0-9_] → '_'。 */
function sanitizeSlug(slug: string): string {
  return slug.trim().replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'slot'
}

/** lodestar 注入的 codex provider id,前缀隔离用户全局 [model_providers.*]。 */
export function codexProviderSlug(slug: string): string {
  return `lodestar_${sanitizeSlug(slug)}`
}

/** 装 api_key 的环境变量名。 */
export function codexEnvKeyName(slug: string): string {
  return `LODESTAR_CODEX_${sanitizeSlug(slug).toUpperCase()}_KEY`
}

function wireApiOf(raw: CodexModelConfig): string {
  const w = raw.wire_api?.trim()
  return w === 'responses' || w === 'chat' ? w : DEFAULT_WIRE_API
}

function requiresOpenaiAuth(raw: CodexModelConfig): boolean {
  return raw.requires_openai_auth?.trim() === 'true'
}

/** api_key → { envKey: key };没配(靠 requires_openai_auth)→ {}。 */
export function codexEnvFromConfig(raw: CodexModelConfig, slug: string): Record<string, string> {
  const key = raw.api_key?.trim()
  if (!key) return {}
  const envKey = raw.env_key?.trim() || codexEnvKeyName(slug)
  return { [envKey]: key }
}

/** 该档位追加的 `-c` 覆盖对(flat 数组:'-c','k=v','-c','k=v',…)。 */
export function codexConfigArgs(raw: CodexModelConfig, slug: string): string[] {
  const provider = codexProviderSlug(slug)
  const base = `model_providers.${provider}`
  const args: string[] = [
    '-c', `model_provider="${provider}"`,
    '-c', `${base}.name="${sanitizeSlug(slug)}"`,
  ]
  const baseUrl = raw.base_url?.trim()
  if (baseUrl) args.push('-c', `${base}.base_url="${baseUrl}"`)
  args.push('-c', `${base}.wire_api="${wireApiOf(raw)}"`)
  // env_key 只在真注入 api_key 时声明:codex 对"env_key 指向未设环境变量"会直接
  // 报 `Missing environment variable` 并中止,故 requires_openai_auth(走 codex 的
  // OpenAI 登录态、无独立 key)的档位绝不能声明 env_key。与 codexEnvFromConfig
  // 的 api_key 门槛保持一致。(2026-07-06 实测:无痕 wuhen 带 env_key 必报错。)
  const apiKey = raw.api_key?.trim()
  if (apiKey) args.push('-c', `${base}.env_key="${raw.env_key?.trim() || codexEnvKeyName(slug)}"`)
  if (requiresOpenaiAuth(raw)) args.push('-c', `${base}.requires_openai_auth=true`)
  return args
}

function routeOf(raw: CodexModelConfig): 'login' | 'api' {
  if (raw.route === 'api' || raw.route === 'login') return raw.route
  return raw.base_url?.trim() ? 'api' : 'login'
}

export function toCodexProfile(slug: string, raw: CodexModelConfig): CodexModelProfile | null {
  const name = slug.trim()
  if (!name) return null
  const route = routeOf(raw)
  const modelId = raw.model?.trim() || ''
  const env = route === 'api' ? codexEnvFromConfig(raw, slug) : {}
  const configArgs = route === 'api' ? codexConfigArgs(raw, slug) : []
  const configured =
    route === 'login' ||
    (!!raw.base_url?.trim() &&
      (!!raw.api_key?.trim() || requiresOpenaiAuth(raw)) &&
      !!modelId)
  return {
    key: `codex:${name}`,
    name,
    displayName: raw.display_name?.trim() || `Codex · ${name}`,
    description: raw.description?.trim() || `使用 ${name} 路由运行 Codex 后端。`,
    modelId,
    route,
    providerSlug: route === 'api' ? codexProviderSlug(slug) : '',
    env,
    configArgs,
    configured,
  }
}

export function codexModelProfiles(): CodexModelProfile[] {
  return Object.entries(config.codex.models)
    .map(([slug, raw]) => toCodexProfile(slug, raw))
    .filter((p): p is CodexModelProfile => p !== null)
}

export function codexModelProfile(model: string | null | undefined): CodexModelProfile | null {
  if (!model?.startsWith('codex:')) return null
  const name = model.slice('codex:'.length)
  if (!name) return null
  return codexModelProfiles().find(p => p.name === name || p.key === model) ?? null
}

/** 该档位是否第三方 API 路由(true = spawn 时注入 provider + key)。 */
export function codexModelIsApiRoute(model: string | null | undefined): boolean {
  return codexModelProfile(model)?.route === 'api'
}

/** 该档位是否依赖 codex 的 OpenAI/ChatGPT 登录态(requires_openai_auth="true")。
 * 这类 API 档位(如无痕 wuhen)不像自带 key 的档位,仍需 ChatGPT 登录,故 start()
 * 的登录预检对它们保留。 */
export function codexModelRequiresOpenaiAuth(model: string | null | undefined): boolean {
  const p = codexModelProfile(model)
  if (!p || p.route !== 'api') return false
  return config.codex.models[p.name]?.requires_openai_auth?.trim() === 'true'
}

/** 该档位是否可用:登录/未知档恒 true;API 路由需 base_url + key + model 配好。 */
export function codexModelConfigured(model: string | null | undefined): boolean {
  const p = codexModelProfile(model)
  return p ? p.configured : true
}

/** 该档位 config 声明的 effort(仅 API 路由);非法/未配 → undefined。 */
export function codexModelEffort(model: string | null | undefined): CodexReasoningEffort | undefined {
  const p = codexModelProfile(model)
  if (!p || p.route !== 'api') return undefined
  const raw = config.codex.models[p.name]?.effort?.trim()
  return raw && isCodexReasoningEffort(raw) ? raw : undefined
}

/** codex:<slug> → 真实 modelId;非档位 key(裸 gpt-5.5)原样;未知 codex: → undefined。 */
export function resolveCodexModelId(model: string | null | undefined): string | undefined {
  const p = codexModelProfile(model)
  if (p) return p.modelId || undefined
  if (model?.startsWith('codex:')) return undefined
  return model ?? undefined
}

/** spawn 时的 codex provider 覆盖。登录/未知档 → 空覆盖 + 原样 modelId,
 * 绝不误伤现有 gpt-5.5。 */
export function codexSpawnOverrides(model: string | null | undefined): {
  modelId: string | undefined
  configArgs: string[]
  env: Record<string, string>
} {
  const p = codexModelProfile(model)
  if (!p || p.route === 'login') {
    return { modelId: resolveCodexModelId(model), configArgs: [], env: {} }
  }
  return { modelId: p.modelId || undefined, configArgs: p.configArgs, env: p.env }
}

/** picker 用:每个配好的 codex API 档位一个选项(含未配置的,选择时再拦截)。 */
export function codexModelChoices(): Array<{
  provider: 'codex'
  model: string
  displayName: string
  description: string
  effort: CodexReasoningEffort
}> {
  return codexModelProfiles()
    .filter(p => p.route === 'api')
    .map(p => ({
      provider: 'codex' as const,
      model: p.key,
      displayName: p.displayName,
      description: p.description,
      effort: codexModelEffort(p.key) ?? CODEX_EFFORT,
    }))
}
