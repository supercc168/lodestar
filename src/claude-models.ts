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
}

const DEFAULT_CLAUDE_MODELS: Record<string, Required<Pick<ClaudeModelConfig, 'display_name' | 'description' | 'opus' | 'sonnet' | 'haiku'>>> = {
  glm: {
    display_name: 'Claude Code · GLM',
    description: '使用 GLM 路由，适合中文交流和通用编码任务。',
    opus: '5.2',
    sonnet: '5.2',
    haiku: '4.7',
  },
  deepseek: {
    display_name: 'Claude Code · DeepSeek',
    description: '使用 DeepSeek 路由，适合代码推理和成本敏感任务。',
    opus: 'DeepSeekv4pro',
    sonnet: 'v4pro',
    haiku: 'v4flash',
  },
}

function mergedConfig(name: string): ClaudeModelConfig {
  return {
    ...(DEFAULT_CLAUDE_MODELS[name] ?? {}),
    ...(config.claude.models[name] ?? {}),
  }
}

function toProfile(name: string): ClaudeModelProfile | null {
  const raw = mergedConfig(name)
  const opus = raw.opus?.trim()
  const sonnet = (raw.sonnet ?? raw.sonet)?.trim()
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

export function resolveClaudeModelEnv(model: string | null | undefined): Record<string, string> {
  const profile = claudeModelProfile(model)
  if (!profile) return {}
  return {
    OMC_MODEL_HIGH: profile.opus,
    OMC_MODEL_MEDIUM: profile.sonnet,
    OMC_MODEL_LOW: profile.haiku,
    ANTHROPIC_DEFAULT_OPUS_MODEL: profile.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: profile.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: profile.haiku,
  }
}
