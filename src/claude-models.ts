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
  /** login 恒 true;api 需 base_url + auth_token + model 都配好才 true。 */
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
  grok: {
    display_name: 'Claude Code · Grok 4.5(无痕 wuhen)',
    description: 'xAI Grok 4.5 第三方路由 · 无痕(wuhen-ai,Anthropic 兼容端点)。需在 config.toml 配置 token。',
    route: 'api',
    // 与 glm 同构:base_url / auth_token / model 由 [claude.models.grok] 提供,
    // 不写死(避免 token 入库 + 模型 id 过期)。配好 token 后 DEFAULT_GROK_ENV
    // 注入 500K 上下文窗口 + 450K auto-compact 阈值 + CLAUDE_CODE_* flag,
    // 四档 tier 别名回落 profile.model,防止辅助调用打到官方 claude id。
  },
  grokcc: {
    display_name: 'Claude Code · Grok 4.5(CatCodex)',
    description: 'xAI Grok 4.5 第三方路由 · CatCodex(catcodexapi,Anthropic 兼容端点)。需在 config.toml 配置 token。',
    route: 'api',
    // 第二个 grok 渠道,与 grok(无痕 wuhen)同构,走 [claude.models.grokcc]。
    // 同样不写死 token/model;displayName 带渠道名,与 grok(无痕)在 picker 区分。
    // catcodex 是 new-api 网关,/v1/messages + Bearer 实测可用(回显 grok-4.5-build)。
    // 默认 env 与 grok 共享 DEFAULT_GROK_ENV(500K ctx / 450K compact)。
  },
}

// Claude Code/GSD 会按角色选择模型 alias。Lodestar 将四个 alias 都绑定到
// 飞书当前选择的真实模型，避免同一 GLM/Grok/Claude 任务按 tier 混用模型。
/** Claude Code can use these aliases when GSD/Task tools create a child
 * agent.  They are deliberately kept as one selected model; tier-specific
 * aliases would silently route a GLM/Grok session to a different model. */
export const CLAUDE_MODEL_ALIAS_KEYS = [
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const

const DEFAULT_GLM_MODEL = 'glm-5.2[1m]'

// Grok 第三方路由(无痕 / CatCodex)上下文默认。
// Claude Code 对非 claude-* 模型默认 context window = 200K($$t);wuhen/catcodex
// 的 grok-4.5 实际上限是 500K。不注入 MAX_CONTEXT 时,长会话会在客户端以为
// 仍在 200K 档、auto-compact 阈值偏低/失配的情况下,把请求撑到 >500K 被上游
// 直接 400 拒绝(`maximum prompt length is 500000`)。
// AUTO_COMPACT_WINDOW 留 50K 余量给本轮 tool/thinking,避免压线撞硬限。
// CLAUDE_CODE_* flag 与 config.toml 惯例一致:关掉非必要流量与 attribution 头。
// 四档 tier 别名在 toProfile 里按 profile.model 动态填(不写死 grok-4.5)。
const DEFAULT_GROK_ENV: Record<string, string> = {
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: '500000',
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: '450000',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
}

const GROK_ROUTE_NAMES = new Set(['grok', 'grokcc'])
const GROK_TIER_ENV_KEYS = CLAUDE_MODEL_ALIAS_KEYS

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
  // per-档位 env 注入(GLM 用它映射 opus/sonnet/fable 别名到 GLM 真实模型;
  // 官方登录档位 raw.env 恒空 → 不注入)。trim + 非空过滤,与上面三字段一致。
  for (const [k, v] of Object.entries(raw.env ?? {})) {
    const sv = v?.trim()
    if (sv) env[k] = sv
  }
  return env
}

function toProfile(name: string): ClaudeModelProfile | null {
  const raw = mergedConfig(name)
  const key = `claude:${name}`
  const env = envFromConfig(raw)
  // GLM 仅在实际配置接入 token 时注入路由；四个模型 alias 无条件收敛到
  // profile.model。未配置 token 时保持 env 空，由 picker 拦截该档位。
  if (name === 'glm' && (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY)) {
    const selectedModel = raw.model?.trim() || DEFAULT_GLM_MODEL
    for (const key of CLAUDE_MODEL_ALIAS_KEYS) env[key] = selectedModel
  }
  // grok / grokcc:同 glm 的"配好 token 才注入默认"语义。上下文窗口 + auto-compact
  // 阈值对齐上游 500K 硬限;tier 别名回落 profile.model,防止辅助调用打到官方 id。
  if (GROK_ROUTE_NAMES.has(name) && (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY)) {
    for (const [k, v] of Object.entries(DEFAULT_GROK_ENV)) {
      if (!(k in env)) env[k] = v
    }
    const tierModel = raw.model?.trim()
    if (tierModel) for (const key of GROK_TIER_ENV_KEYS) env[key] = tierModel
  }
  // route:显式 config > 内建默认 > 由是否配了接入信息推断。
  const route: 'login' | 'api' =
    raw.route === 'api' || raw.route === 'login'
      ? raw.route
      : Object.keys(env).length > 0 ? 'api' : 'login'
  // login 恒就绪;api 需 base_url + auth_token 都在(api_key 单独也算,GLM 用
  // auth_token,少数三方用 api_key),且必须显式配 model —— 缺 model 时 sdkModel
  // 回落官方 DEFAULT_CLAUDE_SDK_MODEL,拿官方 model id 打第三方端点必然误路由。
  const configured =
    route === 'login' ||
    (!!env.ANTHROPIC_BASE_URL &&
      (!!env.ANTHROPIC_AUTH_TOKEN || !!env.ANTHROPIC_API_KEY) &&
      !!raw.model?.trim())
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

/** Lock every Claude Code tier alias to the model selected by Lodestar.  This
 * is applied at the child-process boundary, after profile-specific routing
 * env, so an inherited shell/settings alias cannot create a mixed-model GSD
 * graph.  An omitted model resolves to Lodestar's explicit login default. */
export function claudeModelTierEnv(model: string | null | undefined): Record<string, string> {
  const selected = resolveClaudeSdkModel(model)
  if (!selected) return {}
  return Object.fromEntries(CLAUDE_MODEL_ALIAS_KEYS.map(key => [key, selected]))
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
