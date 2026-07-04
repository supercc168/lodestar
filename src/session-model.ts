import { randomUUID } from 'node:crypto'

import type { Session } from './session'
import { isCodexReasoningEffort } from './codex-process'
import {
  agentProviderLabel,
  isClaudeReasoningEffort,
  providerFromModel,
  type AgentProvider,
  type AgentReasoningEffort,
} from './agent-process'
import * as cards from './cards'
import * as feishu from './feishu'
import { config } from './config'
import { claudeModelConfigured, claudeModelEffort, claudeModelIsApiRoute } from './claude-models'
import { log } from './log'
import { messageOf, withTimeout, type ModelActionResult } from './session-util'

export interface ModelPanelState {
  models: cards.ModelChoice[]
}

/** model 命令的固定选项:每项 effort 锁死,选了即生效(无 effort 二级面板)。
 * codex = gpt-5.5 / xhigh;claude 第一方档位 = Fable 5 / Opus 4.8,均 max
 * (ultracode 最高思考强度)。claude 的 max 由 ClaudeAgentProcess.setModelSettings
 * 强制 applyFlagSettings,不依赖 ~/.claude/settings.json 的 effortLevel。
 * 各 claude:<key> 的实际 SDK model id 由 claude-models.ts 的 profile 决定
 * (claude:fable→claude-fable-5,claude:opus→claude-opus-4-8),reclaude 透传
 * --model 到 Claude Code,走用户的 Anthropic 登录态。 */
const FIXED_MODEL_CHOICES = [
  {
    provider: 'codex' as const,
    model: 'gpt-5.5',
    displayName: 'Codex · GPT-5.5',
    description: 'GPT-5.5 · xhigh 推理强度。',
    effort: 'xhigh' as AgentReasoningEffort,
  },
  {
    provider: 'claude' as const,
    model: 'claude:fable',
    displayName: 'Claude · Fable 5',
    description: 'Fable 5 · max (ultracode) · 1M 上下文,当前最强通用模型。',
    effort: 'max' as AgentReasoningEffort,
  },
  {
    provider: 'claude' as const,
    model: 'claude:opus',
    displayName: 'Claude · Opus 4.8',
    description: 'Opus 4.8 · max (ultracode) · 1M 上下文,擅长架构与深度分析。',
    effort: 'max' as AgentReasoningEffort,
  },
  {
    // GLM 第三方路由:走 config.toml [claude.models.glm] 的 base_url + auth_token,
    // 不用官方登录态。未配置 token 时 picker 仍显示(描述提示去配置),但选择
    // 会被 onModelEffortSelect 拦截。
    provider: 'claude' as const,
    model: 'claude:glm',
    displayName: 'Claude · GLM',
    description: 'GLM 第三方路由 · max。',
    effort: 'max' as AgentReasoningEffort,
  },
]

/** provider 的默认固定档位(该 provider 的第一个固定项)。归一化未知/退役
 * 选择时回落到它。 */
function defaultFixedChoiceFor(provider: AgentProvider): typeof FIXED_MODEL_CHOICES[number] {
  return FIXED_MODEL_CHOICES.find(c => c.provider === provider) ?? FIXED_MODEL_CHOICES[0]
}

/** 档位实际锁死的 effort:第三方路由(GLM)优先用 config 声明的 effort
 * (如 xhigh 复刻智谱最高思维),否则回落到 FIXED_MODEL_CHOICES 的默认值。
 * picker 渲染、选择校验、归一化都走这里,保持三处一致。 */
function resolvedEffort(item: typeof FIXED_MODEL_CHOICES[number]): AgentReasoningEffort {
  if (item.provider === 'claude') {
    const configured = claudeModelEffort(item.model)
    if (configured) return configured
  }
  return item.effort
}

/** 把持久化的 (provider, model, effort) 归一到当前固定选项集。
 *   - 命中固定项 → 原样保留(强制该项锁死的 effort)。
 *   - legacy/退役 model(如 claude:glm、claude:deepseek)→ 回落到该 provider
 *     的默认固定项(claude→claude:fable,底层同为 claude-fable-5,行为不变,
 *     只是把误导性的 GLM 标签迁移成准确的 Fable 5)。
 * daemon 重启后 restoreModelSelection 用它,避免旧 map 把 session 带到已
 * 下线的档位或非锁死 effort。 */
export function normalizeFixedModelSelection(
  provider: AgentProvider,
  model: string | null | undefined,
  _effort: AgentReasoningEffort | null | undefined,
): { model: string; effort: AgentReasoningEffort } {
  const hit = FIXED_MODEL_CHOICES.find(c => c.provider === provider && c.model === model)
  // 第三方 API 路由(GLM)持久化了但当前未配置 token → 回落到该 provider 的
  // 登录默认档位(claude:fable)。否则启动 restore 会以未鉴权状态拉起该档位:
  // 既跑不通(resolveClaudeSdkModel 回落到官方 model id 打第三方端点),又
  // 绕过了 picker 的配置门槛(restore 不走 onModelEffortSelect)。配好 token
  // 的 GLM 正常保留 —— 满足"别丢 GLM 设置"。
  if (hit && provider === 'claude' && claudeModelIsApiRoute(model) && !claudeModelConfigured(model)) {
    const fallback = defaultFixedChoiceFor(provider)
    return { model: fallback.model, effort: resolvedEffort(fallback) }
  }
  const choice = hit ?? defaultFixedChoiceFor(provider)
  return { model: choice.model, effort: resolvedEffort(choice) }
}

/** 新 session(无持久化 model 选择)的默认档位,取自 config.toml 的
 * [claude] default_model。接受档位 key("glm")或固定项 model("claude:glm" /
 * "gpt-5.5")。未配置 / 无法识别 → null(调用方回落到硬编码登录默认 Fable 5)。
 * 返回的档位仍会经 Session 构造器的 normalizeFixedModelSelection —— 未配置
 * token 的 GLM 会在那里回落到 Fable 5,不会让新群默认就落到打不通的未鉴权
 * API 路由。让只订阅 GLM 的用户设 default_model="glm" 后首条消息直接走 GLM。 */
export function configuredDefaultSelection(): {
  provider: AgentProvider
  model: string
  effort: AgentReasoningEffort
} | null {
  const raw = config.claude.defaultModel?.trim()
  if (!raw) return null
  const wanted = raw.startsWith('claude:') || raw === 'gpt-5.5' ? raw : `claude:${raw}`
  const hit = FIXED_MODEL_CHOICES.find(c => c.model === wanted)
  if (!hit) return null
  return { provider: hit.provider, model: hit.model, effort: resolvedEffort(hit) }
}

/** 第三方 API 路由(GLM)未配 token 时的描述后缀,提示去 config.toml 设置。 */
function choiceDescription(item: typeof FIXED_MODEL_CHOICES[number]): string {
  if (item.provider === 'claude' && claudeModelIsApiRoute(item.model) && !claudeModelConfigured(item.model)) {
    return `${item.description}(未配置 · 需在 config.toml 的 [claude.models.glm] 填 base_url + auth_token)`
  }
  return item.description
}

export function fixedModelChoices(s: Session): cards.ModelChoice[] {
  const currentProvider = s.currentProvider()
  const currentModel = s.currentModelLabel()
  const currentEffort = s.currentEffortLabel()
  return FIXED_MODEL_CHOICES.map(item => {
    const selected = currentProvider === item.provider && currentModel === item.model
    const effort = resolvedEffort(item)
    return {
      provider: item.provider,
      model: item.model,
      displayName: item.displayName,
      description: choiceDescription(item),
      isDefault: false,
      selected,
      efforts: [{
        effort,
        description: '',
        isDefault: true,
        selected: selected && currentEffort === effort,
      }],
    }
  })
}

export async function showModelPanel(s: Session): Promise<void> {
  const panelId = randomUUID()
  const currentModel = s.currentModelLabel()
  const currentEffort = s.currentEffortLabel()
  const choices = fixedModelChoices(s)
  s.modelPanels.set(panelId, { models: choices })
  const messageId = await feishu.sendCard(s.chatId, cards.modelSelectionCard({
    sessionName: s.sessionName,
    panelId,
    currentModel,
    currentEffort,
    models: choices,
  }))
  if (!messageId) {
    s.modelPanels.delete(panelId)
    await feishu.sendTextRaw(s.chatId, '❌ 模型面板发送失败')
  }
}

function actionProvider(model: string, raw: any): AgentProvider {
  return raw?.provider === 'claude' || raw?.provider === 'codex'
    ? raw.provider
    : providerFromModel(model)
}

function modelSelectionScope(s: Session, provider: AgentProvider): string {
  if (s.currentTurn) return '当前 turn 不变,后续新 turn 使用。'
  if (s.proc?.isAlive() && s.proc.provider === provider) return '下一轮开始使用。'
  return `下次启动 ${agentProviderLabel(provider)} 时使用。`
}

export async function onModelSelect(
  s: Session,
  modelRaw: string,
  panelIdRaw = '',
  _userOpenId = '',
  actionValue: any = null,
): Promise<ModelActionResult> {
  const model = modelRaw.trim()
  if (!model) {
    const message = '模型为空'
    await feishu.sendText(s.chatId, `❌ ${message}`)
    return { ok: false, message }
  }
  const provider = actionProvider(model, actionValue)
  const choice = s.modelPanels.get(panelIdRaw.trim())?.models
    .find(m => m.model === model && (m.provider ?? 'codex') === provider)
    ?? fixedModelChoices(s).find(m => m.model === model && m.provider === provider)
  if (!choice) {
    return { ok: false, message: '模型不在当前选项中,请重新发送 model' }
  }
  // 二元选择:effort 锁死,选了直接应用,跳过 effort 二级面板。
  const effort = choice.efforts[0]?.effort
  if (!effort) return { ok: false, message: '模型未返回 effort' }
  return onModelEffortSelect(s, model, effort, panelIdRaw, _userOpenId, provider)
}

export async function onModelEffortSelect(
  s: Session,
  modelRaw: string,
  effortRaw: string,
  panelIdRaw = '',
  _userOpenId = '',
  providerRaw = '',
): Promise<ModelActionResult> {
  const model = modelRaw.trim()
  const effortValue = effortRaw.trim()
  if (!model) return { ok: false, message: '模型为空' }
  const panelId = panelIdRaw.trim()
  const panel = s.modelPanels.get(panelId)
  const provider: AgentProvider = providerRaw === 'claude' || providerRaw === 'codex'
    ? providerRaw
    : panel?.models.find(m => m.model === model)?.provider ?? providerFromModel(model)
  if (provider === 'claude') {
    if (!isClaudeReasoningEffort(effortValue)) return { ok: false, message: 'Claude reasoning effort 无效' }
  } else if (!isCodexReasoningEffort(effortValue)) {
    return { ok: false, message: 'Codex reasoning effort 无效' }
  }
  const effort = effortValue as AgentReasoningEffort
  // 二元锁死:只放行 FIXED_MODEL_CHOICES 的 (provider, model, effort) 组合,
  // 拒绝旧 effort 回调/伪造把 session 切到非固定项或非锁死 effort。
  const fixed = FIXED_MODEL_CHOICES.find(c => c.provider === provider && c.model === model)
  if (!fixed || resolvedEffort(fixed) !== effort) {
    return { ok: false, message: `${agentProviderLabel(provider)} · ${model}/${effort} 不在固定选项中` }
  }
  // 第三方 API 路由(GLM)必须先在 lodestar config 配好 token 才能切换 ——
  // 官方登录档位(Fable 5/Opus)无需配置。拦截未配置的 GLM,给出清晰指引。
  if (provider === 'claude' && claudeModelIsApiRoute(model) && !claudeModelConfigured(model)) {
    return {
      ok: false,
      message: `GLM(${model})未配置:请在 ~/.config/lodestar/config.toml 的 [claude.models.glm] 填写 base_url 和 auth_token 后重试(官方 Fable 5 / Opus 走登录态,无需配置)`,
    }
  }
  const choice = panel?.models.find(m => m.model === model && (m.provider ?? 'codex') === provider)
  if (choice && !choice.efforts.some(item => item.effort === effort)) {
    return { ok: false, message: 'reasoning effort 不属于该模型' }
  }
  if (
    s.proc?.isAlive() &&
    s.proc.provider !== provider &&
    (s.currentTurn || s.openingTurn || s.pendingUserMessageCount > 0 || s.pendingMidTurnMsgs.length > 0)
  ) {
    return {
      ok: false,
      message: `当前 ${s.backendLabel(s.proc.provider)} turn 正在执行或排队；请等结束或 stop 后再切换到 ${agentProviderLabel(provider)}`,
    }
  }
  const modelChanged = s.currentModelLabel() !== model
  const procBusy = !!(s.currentTurn || s.openingTurn || s.pendingUserMessageCount > 0 || s.pendingMidTurnMsgs.length > 0)
  if (
    provider === 'claude' &&
    s.proc?.isAlive() &&
    s.proc.provider === 'claude' &&
    modelChanged &&
    procBusy
  ) {
    return {
      ok: false,
      message: '当前 Claude turn 正在执行或排队；Claude 模型 profile 通过 env 生效，请等结束或 stop 后再切换',
    }
  }
  const shouldRespawnIdleClaude = provider === 'claude' &&
    s.proc?.isAlive() &&
    s.proc.provider === 'claude' &&
    modelChanged
  try {
    if (s.proc?.isAlive() && s.proc.provider === provider) {
      if (!shouldRespawnIdleClaude) {
        await withTimeout(s.proc.setModelSettings(model, effort), 20_000, 'thread/settings/update')
      }
    }
    await s.applyModelSelection(provider, model, effort)
    if (shouldRespawnIdleClaude) {
      await s.stopIdleCurrentProcess('Claude model profile changed; env will apply on next spawn')
    }
    const scope = modelSelectionScope(s, provider)
    s.modelPanels.delete(panelId)
    return {
      ok: true,
      message: `已选择 ${agentProviderLabel(provider)} · ${model} / ${effort}`,
      card: cards.modelResultCard({
        sessionName: s.sessionName,
        provider,
        model,
        effort,
        scope,
      }),
    }
  } catch (e) {
    const message = `模型切换失败: ${messageOf(e)}`
    log(`session "${s.sessionName}": set model settings failed: ${messageOf(e)}`)
    await feishu.sendText(s.chatId, `❌ ${message}`)
    return { ok: false, message }
  }
}
