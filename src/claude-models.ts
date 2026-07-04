import { config, type ClaudeModelConfig } from './config'
import { isClaudeReasoningEffort, type ClaudeReasoningEffort } from './agent-process'

export interface ClaudeModelProfile {
  key: string
  name: string
  displayName: string
  description: string
  sdkModel: string
  /** 'login' = 走用户的 Anthropic Claude 登录态,绝不注入 API key(官方
   * Fable 5/Opus);'api' = 第三方路由(GLM),需 base_url + auth_token。 */
  route: 'login' | 'api'
  /** spawn 时注入的 ANTHROPIC_* env 覆盖。login 档位恒为空;api 档位配好
   * 后为 { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN[, ANTHROPIC_API_KEY] }。 */
  env: Record<string, string>
  /** login 恒 true;api 需 base_url + auth_token 都配好才 true。 */
  configured: boolean
}

// 内建默认档位:display_name/description 必填,model/route 可选。
// login 档位(缺省 route)走登录态;api 档位(route:'api',如 glm)需配 token。
type DefaultClaudeModelConfig = Required<
  Pick<ClaudeModelConfig, 'display_name' | 'description'>
> & Pick<ClaudeModelConfig, 'model' | 'route'>

// 未在 config.toml [claude.models.*] 指定 model 时的默认档位。
// Fable 5 是 Anthropic 当前最强模型(1M ctx / 128K out),官方 API 路由可用;
// GLM 等第三方路由不认这个 id,需在 profile 里显式配 model 覆盖。
export const DEFAULT_CLAUDE_SDK_MODEL = 'claude-fable-5'

const DEFAULT_CLAUDE_MODELS: Record<string, DefaultClaudeModelConfig> = {
  // 第一方 Anthropic 档位:model id 直传 Claude Code(reclaude → --model),
  // 走用户的 Claude 登录态。飞书 model 面板从这里取名。
  fable: {
    display_name: 'Claude Code · Fable 5',
    description: 'Anthropic Fable 5,1M 上下文,当前最强通用模型。',
    model: 'claude-fable-5',
  },
  opus: {
    display_name: 'Claude Code · Opus 4.8',
    description: 'Anthropic Opus 4.8,1M 上下文,擅长架构与深度分析。',
    model: 'claude-opus-4-8',
  },
  glm: {
    display_name: 'Claude Code · GLM',
    description: 'GLM 第三方路由(智谱等)。需在 config.toml 配置 token。',
    route: 'api',
    // GLM 的 base_url / auth_token / model 由 [claude.models.glm] 提供,
    // 不写死在代码里(避免 GLM 版本过期 + token 入库)。未配置时该档位
    // 在 picker 里可见但选择被拦截,提示去 config.toml 设置。
  },
}

function mergedConfig(name: string): ClaudeModelConfig {
  return {
    ...(DEFAULT_CLAUDE_MODELS[name] ?? {}),
    ...(config.claude.models[name] ?? {}),
  }
}

/** 从档位 config 拼 spawn 用的 ANTHROPIC_* env 覆盖。只在真配了值时才写入
 * 对应 key —— 空值不写,避免用空串顶掉登录态。 */
function envFromConfig(raw: ClaudeModelConfig): Record<string, string> {
  const env: Record<string, string> = {}
  const baseUrl = raw.base_url?.trim()
  const authToken = raw.auth_token?.trim()
  const apiKey = raw.api_key?.trim()
  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl
  if (authToken) env.ANTHROPIC_AUTH_TOKEN = authToken
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey
  return env
}

function toProfile(name: string): ClaudeModelProfile | null {
  const raw = mergedConfig(name)
  const key = `claude:${name}`
  const env = envFromConfig(raw)
  // route:显式 config > 内建默认 > 由是否配了接入信息推断。
  const route: 'login' | 'api' =
    raw.route === 'api' || raw.route === 'login'
      ? raw.route
      : Object.keys(env).length > 0 ? 'api' : 'login'
  // login 恒就绪;api 需 base_url + auth_token 都在(api_key 单独也算,GLM 用
  // auth_token,少数三方用 api_key)。
  const configured =
    route === 'login' ||
    (!!env.ANTHROPIC_BASE_URL && (!!env.ANTHROPIC_AUTH_TOKEN || !!env.ANTHROPIC_API_KEY))
  return {
    key,
    name,
    displayName: raw.display_name?.trim() || `Claude Code · ${name}`,
    description: raw.description?.trim() || `使用 ${name} 路由运行 Claude Code 后端。`,
    sdkModel: raw.model?.trim() || DEFAULT_CLAUDE_SDK_MODEL,
    route,
    env,
    configured,
  }
}

export function claudeModelProfiles(): ClaudeModelProfile[] {
  const names = new Set([
    ...Object.keys(DEFAULT_CLAUDE_MODELS),
    ...Object.keys(config.claude.models),
  ])
  return [...names]
    .map(toProfile)
    .filter((profile): profile is ClaudeModelProfile => profile !== null)
}

export function claudeModelProfile(model: string | null | undefined): ClaudeModelProfile | null {
  if (!model?.startsWith('claude:')) return null
  const name = model.slice('claude:'.length)
  if (!name || name === 'default') return null
  return claudeModelProfiles().find(profile => profile.name === name || profile.key === model) ?? null
}

export function claudeModelKey(model: string): string {
  return model.startsWith('claude:') ? model : `claude:${model}`
}

export function resolveClaudeSdkModel(model: string | null | undefined): string | undefined {
  if (!model) return DEFAULT_CLAUDE_SDK_MODEL
  const profile = claudeModelProfile(model)
  if (profile) return profile.sdkModel
  const stripped = model.startsWith('claude:') ? model.slice('claude:'.length) : model
  return stripped === 'default' ? DEFAULT_CLAUDE_SDK_MODEL : stripped
}

/** spawn 时要为该档位注入的 ANTHROPIC_* env 覆盖。官方登录档位(Fable 5/
 * Opus)恒返回空对象 —— 它们绝不走 API key,只用用户的 Claude 登录态。
 * 只有配好 token 的第三方路由(GLM)才返回非空。 */
export function claudeModelEnv(model: string | null | undefined): Record<string, string> {
  return claudeModelProfile(model)?.env ?? {}
}

/** 该档位是否为第三方 API 路由(GLM 一类)。true = 需要 token 且 spawn 时
 * 注入 env;false = 官方登录档位(默认档位也算 login)。 */
export function claudeModelIsApiRoute(model: string | null | undefined): boolean {
  return claudeModelProfile(model)?.route === 'api'
}

/** 该档位是否可用:登录档位恒 true;API 路由需 token 配好才 true。 */
export function claudeModelConfigured(model: string | null | undefined): boolean {
  const profile = claudeModelProfile(model)
  // 未知/默认档位当作登录态就绪。
  return profile ? profile.configured : true
}

/** 该档位在 config 里声明的思考强度(仅第三方 API 路由有意义,官方登录档位
 * 不配)。非法/未配返回 undefined,由调用方回落到 FIXED_MODEL_CHOICES 的锁死
 * 值。让 GLM 能复刻各自最优 effort(如 GLM-5.2 直连智谱走 xhigh)。 */
export function claudeModelEffort(model: string | null | undefined): ClaudeReasoningEffort | undefined {
  const profile = claudeModelProfile(model)
  if (!profile || profile.route !== 'api') return undefined
  const raw = mergedConfig(profile.name).effort?.trim()
  return raw && isClaudeReasoningEffort(raw) ? raw : undefined
}
