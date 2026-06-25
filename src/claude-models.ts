import { config, type ClaudeModelConfig } from './config'

export interface ClaudeModelProfile {
  key: string
  name: string
  displayName: string
  description: string
  opus: string
  sonnet: string
  haiku: string
  sdkModel: string
  contextWindow: number | null
}

type DefaultClaudeModelConfig = Required<
  Pick<ClaudeModelConfig, 'display_name' | 'description' | 'opus' | 'sonnet' | 'haiku'>
> & Pick<ClaudeModelConfig, 'context_window'>

const DEFAULT_CLAUDE_MODELS: Record<string, DefaultClaudeModelConfig> = {
  glm: {
    display_name: 'Claude Code · GLM',
    description: '使用 GLM 路由，适合中文交流和通用编码任务。',
    // 智谱 Anthropic 兼容端点要求模型名用官方完整名(GLM-5.2)并带 [1m]
    // 后缀才放开 1M 上下文;简写名(5.2)或无后缀只给 200K。haiku 同理
    // 用完整名 GLM-4.7(轻量档不加 [1m])。
    opus: 'GLM-5.2[1m]',
    sonnet: 'GLM-5.2[1m]',
    haiku: 'GLM-4.7',
    // GLM-5.2[1m] 真实窗口 1M;SDK 经 Claude Code→GLM 链路实测的 contextWindow
    // 系统性偏低(100K~200K 波动,见 daemon.log),不可信,故此值优先覆盖实测。
    context_window: '1000000',
  },
}

function mergedConfig(name: string): ClaudeModelConfig {
  return {
    ...(DEFAULT_CLAUDE_MODELS[name] ?? {}),
    ...(config.claude.models[name] ?? {}),
  }
}

function parseContextWindow(value: string | undefined): number | null {
  if (!value) return null
  const normalized = value.trim().replace(/_/g, '')
  if (!normalized) return null
  const n = Number.parseInt(normalized, 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

function toProfile(name: string): ClaudeModelProfile | null {
  const raw = mergedConfig(name)
  const opus = raw.opus?.trim()
  const sonnet = raw.sonnet?.trim()
  const haiku = raw.haiku?.trim()
  if (!opus || !sonnet || !haiku) return null
  const key = `claude:${name}`
  return {
    key,
    name,
    displayName: raw.display_name?.trim() || `Claude Code · ${name}`,
    description: raw.description?.trim() || `使用 ${name} 路由运行 Claude Code 后端。`,
    opus,
    sonnet,
    haiku,
    sdkModel: raw.model?.trim() || 'opus',
    contextWindow: parseContextWindow(raw.context_window),
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
  if (!model) return 'opus'
  const profile = claudeModelProfile(model)
  if (profile) return profile.sdkModel
  const stripped = model.startsWith('claude:') ? model.slice('claude:'.length) : model
  return stripped === 'default' ? 'opus' : stripped
}

export function resolveClaudeContextWindow(model: string | null | undefined): number | null {
  return claudeModelProfile(model)?.contextWindow ?? null
}
