import { config, type ClaudeModelConfig } from './config'

export interface ClaudeModelProfile {
  key: string
  name: string
  displayName: string
  description: string
  sdkModel: string
}

type DefaultClaudeModelConfig = Required<
  Pick<ClaudeModelConfig, 'display_name' | 'description'>
>

const DEFAULT_CLAUDE_MODELS: Record<string, DefaultClaudeModelConfig> = {
  glm: {
    display_name: 'Claude Code · GLM',
    description: '使用 GLM 路由，适合中文交流和通用编码任务。',
    // 模型名路由(GLM-5.2[1m] / GLM-4.7)完全靠 ~/.claude/settings.json 的
    // ANTHROPIC_DEFAULT_*_MODEL,lodestar 不再重复声明。上下文窗口分母纯信
    // SDK modelUsage 上报的 contextWindow,不在此声明假窗口。
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
  const key = `claude:${name}`
  return {
    key,
    name,
    displayName: raw.display_name?.trim() || `Claude Code · ${name}`,
    description: raw.description?.trim() || `使用 ${name} 路由运行 Claude Code 后端。`,
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
