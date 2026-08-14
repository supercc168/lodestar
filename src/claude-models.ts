import { config, type ClaudeModelConfig } from './config'
import { isClaudeReasoningEffort, type ClaudeReasoningEffort } from './agent-process'

export interface ClaudeModelProfile {
  key: string
  name: string
  displayName: string
  description: string
  sdkModel: string
  /** 'login' = 走用户的 Anthropic Claude 登录态,绝不注入 API key(官方
   * Fable 5/Opus);'api' = 第三方路由(GLM/Grok 等),需 base_url + token。 */
  route: 'login' | 'api'
  /** spawn 时注入的 ANTHROPIC_* env 覆盖。login 档位恒为空;api 档位配好
   * 后为 { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN[, ANTHROPIC_API_KEY] }。 */
  env: Record<string, string>
  /** login 恒 true;api 需 base_url + auth_token + model 都配好才 true。 */
  configured: boolean
}

// 内建默认档位:display_name/description 必填,model/route 可选。
// login 档位(缺省 route)走登录态;api 档位(route:'api',如 GLM/Grok)需配 token。
type DefaultClaudeModelConfig = Required<
  Pick<ClaudeModelConfig, 'display_name' | 'description'>
> & Pick<ClaudeModelConfig, 'model' | 'route'>

// 未在 config.toml [claude.models.*] 指定 model 时的默认档位。
// Fable 5 是 Anthropic 当前最强模型(1M ctx / 128K out),官方 API 路由可用;
// GLM 等第三方路由不认这个 id,需在 profile 里显式配 model 覆盖。
export const DEFAULT_CLAUDE_SDK_MODEL = 'claude-fable-5'
/** xAI 官方为 Grok 4.6 定义的最高 reasoning effort。
 * Grok 4.6 在 4.5 的 low/medium/high 之上新增官方 xhigh;无痕路由用官方最高 xhigh。 */
export const GROK_OFFICIAL_MAX_EFFORT = 'xhigh' as const
/** CatCodex 的 Anthropic 兼容层只有在 xhigh 下稳定兑现 Claude Code 工具调用。
 * 该网关 high 下会吞工具调用,故锁 xhigh;Grok 4.6 起 xhigh 也是官方档,两路同值不同理。 */
export const GROKCC_TOOL_COMPAT_EFFORT = 'xhigh' as const

/** Claude Code 在第三方 Grok Anthropic 路由上的稳定运行基线。档位显式
 * env_* 配置优先；这里只补缺省值，且只在完整 API 凭据就绪后注入。 */
const DEFAULT_GROK_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: '500000',
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: '450000',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
}

function isGrokModelId(model: string | null | undefined): boolean {
  return /^grok(?:[-_.]|$)/i.test(model?.trim() ?? '')
}

const DEFAULT_CLAUDE_MODELS: Record<string, DefaultClaudeModelConfig> = {
  // 第一方 Anthropic 档位:model id 直传 Claude Code(reclaude → --model),
  // 走用户的 Claude 登录态。飞书 model 面板从这里取名。
  fable: {
    display_name: 'Claude Code · Fable 5',
    description: 'Anthropic Fable 5,1M 上下文,当前最强通用模型。',
    model: 'claude-fable-5',
  },
  opus: {
    display_name: 'Claude Code · Opus 5',
    description: 'Anthropic Opus 5,擅长架构与深度分析。',
    model: 'claude-opus-5',
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
    display_name: 'Claude Code · Grok 4.6(无痕)',
    description: 'Grok 4.6 第三方路由 · 无痕 Anthropic Messages。需在 config.toml 配置 token。',
    route: 'api',
  },
  grokcc: {
    display_name: 'Claude Code · Grok 4.6(CatCodex)',
    description: 'Grok 4.6 第三方路由 · CatCodex Anthropic Messages。需在 config.toml 配置 token。',
    route: 'api',
  },
  deepseek: {
    display_name: 'Claude Code · DeepSeek V4',
    description: 'DeepSeek 第三方路由(官网 Anthropic 兼容端点,V4 Pro 主力,haiku/子 agent 走 V4 Flash)。需在 config.toml 配置 token。',
    route: 'api',
    // base_url / auth_token / model 由 [claude.models.deepseek] 提供,不写死
    // 在代码里(避免 token 入库 + 模型版本过期)。未配置时该档位在 picker 可见
    // 但选择被拦截,提示去 config.toml 设置。与 GLM 同构。
  },
}

// Claude Code/GSD 会按角色选择模型 alias。
// 第一方登录档：飞书当前选定模型当主力（Fable 5 或 Opus 5），light/haiku 固定
// Sonnet 5；选 Opus 时四个 alias 都不注入 Fable。
// 第三方 API 路由把 alias 锁回档位真实模型，避免官方 model id 泄漏到 GLM
// 等兼容端点；DeepSeek 例外 —— haiku 锁 V4 Flash（官方 Claude Code 接入
// 文档推荐，子 agent 便宜 ~1/3），其余三档锁主力。
export const CLAUDE_MODEL_ALIAS_KEYS = [
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const

/** 第一方 light/haiku 档固定 Sonnet 5（不随飞书主力切换）。 */
export const FIRST_PARTY_LIGHT_MODEL = 'claude-sonnet-5'

/** 飞书第一方主力 → 子 agent 四档 alias。主力占 fable/opus/sonnet；haiku=Sonnet 5。 */
export function firstPartyClaudeTierEnvForMain(
  mainModel: string,
): Record<(typeof CLAUDE_MODEL_ALIAS_KEYS)[number], string> {
  const main = mainModel.trim() || DEFAULT_CLAUDE_SDK_MODEL
  return {
    ANTHROPIC_DEFAULT_FABLE_MODEL: main,
    ANTHROPIC_DEFAULT_OPUS_MODEL: main,
    ANTHROPIC_DEFAULT_SONNET_MODEL: main,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: FIRST_PARTY_LIGHT_MODEL,
  }
}

/** GLM 档位默认 model id。2026-08-14 实测(open.bigmodel.cn Anthropic 兼容
 * 端点 /v1/messages 真请求):
 *   - glm-5.3      → 端点接受并正常响应(带 thinking 块);32K/49K thinking
 *                     budget 均兑现 → max 最高思维可用;~800K token 单请求
 *                     接受 → 1M 档上下文(与 5.2 同级)
 *   - glm-5.3[1m]  → 报 1214 modelCode 不存在 —— 5.3 不再认 [1m] 后缀,
 *                     1M 窗口改由 DEFAULT_GLM_ENV 的 CLAUDE_CODE_MAX_CONTEXT_TOKENS
 *                     注入(否则 Claude Code 把裸 id 当 200K,浪费窗口)
 * 未在 [claude.models.glm] 显式配 model 时回落到这里。 */
const DEFAULT_GLM_MODEL = 'glm-5.3'

/** GLM Anthropic 路由的稳定运行基线。裸 glm-5.3(无 [1m] 后缀)被 Claude Code
 * 判定为 200K 窗口(未知模型默认),这里显式注入 1M 对齐上游真实窗口 —— 与 Grok
 * 档的 CLAUDE_CODE_MAX_CONTEXT_TOKENS 同机制。档位显式 env_* 配置优先;只在完整
 * API 凭据就绪后注入。 */
const DEFAULT_GLM_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
}

/** DeepSeek 官网 Anthropic 兼容端点(https://api.deepseek.com/anthropic)的
 * 默认 model id。2026-08-13/14 实测(Anthropic /v1/messages 打真请求验证):
 *   - deepseek-v4-pro[1m] → V4 Pro 正式版(0813)1M 上下文;[1m] 后缀让 Claude Code
 *                           识别 1M ctx,端点接受并回显 deepseek-v4-pro。本档主力
 *   - deepseek-v4-pro     → 端点同样接受(不写 [1m] 时 Claude Code 不知道是 1M ctx)
 *   - deepseek-v4-flash   → V4 快速档(0731 起同样支持思考模式,便宜 ~1/3),
 *                           官方推荐给 haiku alias 与子 agent 用
 *   - deepseek-reasoner   → 独立推理模型别名(兼容)
 * 未在 [claude.models.deepseek] 显式配 model 时回落到这里。 */
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-pro[1m]'

/** DeepSeek 端点的快速档 model id(官方 Claude Code 接入文档同款)。 */
const DEFAULT_DEEPSEEK_FLASH_MODEL = 'deepseek-v4-flash'

/** DeepSeek Anthropic 路由的稳定运行基线(2026-08-13 官方 Claude Code 接入
 * 文档同款):子 agent 锁 V4 Flash,1M 上下文下 768K 触发自动压缩。档位显式
 * env_* 配置优先;这里只补缺省值,且只在完整 API 凭据就绪后注入。 */
const DEFAULT_DEEPSEEK_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_SUBAGENT_MODEL: DEFAULT_DEEPSEEK_FLASH_MODEL,
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432',
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
  // DeepSeek 与 GLM 同构:实际配了 token 才注入路由。alias 按官方 Claude Code
  // 接入文档拆分 —— 主力三档锁 profile.model(V4 Pro),haiku 锁 V4 Flash(便宜
  // ~1/3,0731 起同样支持思考模式)。(claudeModelTierEnv 的 api 路径对 deepseek
  // 同样拆分,这里显式锁是 defense-in-depth。)
  if (name === 'deepseek' && (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY)) {
    const selectedModel = raw.model?.trim() || DEFAULT_DEEPSEEK_MODEL
    env.ANTHROPIC_DEFAULT_FABLE_MODEL = selectedModel
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = selectedModel
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = selectedModel
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = DEFAULT_DEEPSEEK_FLASH_MODEL
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
  if (configured && route === 'api' && isGrokModelId(raw.model)) {
    for (const [key, value] of Object.entries(DEFAULT_GROK_ENV)) {
      if (!(key in env)) env[key] = value
    }
  }
  // DeepSeek 同理补缺省(子 agent Flash + 768K 自动压缩),档位 env_* 显式配置优先。
  if (configured && route === 'api' && name === 'deepseek') {
    for (const [key, value] of Object.entries(DEFAULT_DEEPSEEK_ENV)) {
      if (!(key in env)) env[key] = value
    }
  }
  // GLM 同理补缺省:裸 glm-5.3 无 [1m] 后缀,显式注入 1M 窗口对齐上游。
  if (configured && route === 'api' && name === 'glm') {
    for (const [key, value] of Object.entries(DEFAULT_GLM_ENV)) {
      if (!(key in env)) env[key] = value
    }
  }
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

/** Grok 档位统一走 Claude Agent SDK 的兼容启动参数。按真实上游 model id
 * 判断，而不是写死 profile slug，确保新增 [claude.models.*] Grok 渠道也生效。 */
export function claudeModelIsGrok(model: string | null | undefined): boolean {
  return isGrokModelId(resolveClaudeSdkModel(model))
}

/** spawn 时要为该档位注入的 ANTHROPIC_* env 覆盖。官方登录档位(Fable 5/
 * Opus)恒返回空对象 —— 它们绝不走 API key,只用用户的 Claude 登录态。
 * 只有配好 token 的第三方 API 路由才返回非空。 */
export function claudeModelEnv(model: string | null | undefined): Record<string, string> {
  return claudeModelProfile(model)?.env ?? {}
}

/** Resolve Claude Code child-agent aliases at the process boundary.
 * - First-party login: Feishu selection is the main model (Fable 5 or Opus 5)
 *   for fable/opus/sonnet aliases; haiku stays Sonnet 5. Selecting Opus never
 *   injects Fable; selecting Fable never injects Opus.
 * - API routes: every alias locks to the selected upstream model so no
 *   Anthropic id reaches a third-party endpoint.
 * - DeepSeek exception: haiku locks to V4 Flash (official Claude Code
 *   integration doc), the other three lock to the main model. */
export function claudeModelTierEnv(model: string | null | undefined): Record<string, string> {
  if (!claudeModelIsApiRoute(model)) {
    return firstPartyClaudeTierEnvForMain(resolveClaudeSdkModel(model) ?? DEFAULT_CLAUDE_SDK_MODEL)
  }
  const selected = resolveClaudeSdkModel(model)
  if (!selected) return {}
  if (claudeModelProfile(model)?.name === 'deepseek') {
    return {
      ANTHROPIC_DEFAULT_FABLE_MODEL: selected,
      ANTHROPIC_DEFAULT_OPUS_MODEL: selected,
      ANTHROPIC_DEFAULT_SONNET_MODEL: selected,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: DEFAULT_DEEPSEEK_FLASH_MODEL,
    }
  }
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
 * 值。无痕 Grok 用 xAI 官方最高 xhigh(Grok 4.6 新增)；CatCodex 因网关工具兼容同样锁 xhigh。 */
export function claudeModelEffort(model: string | null | undefined): ClaudeReasoningEffort | undefined {
  const profile = claudeModelProfile(model)
  if (!profile || profile.route !== 'api') return undefined
  if (claudeModelIsGrok(model)) {
    return profile.name === 'grokcc' ? GROKCC_TOOL_COMPAT_EFFORT : GROK_OFFICIAL_MAX_EFFORT
  }
  const raw = mergedConfig(profile.name).effort?.trim()
  return raw && isClaudeReasoningEffort(raw) ? raw : undefined
}
