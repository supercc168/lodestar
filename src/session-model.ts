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
import { log } from './log'
import { messageOf, withTimeout, type ModelActionResult } from './session-util'

export interface ModelPanelState {
  models: cards.ModelChoice[]
}

/** model 命令的二元固定选项:effort 锁死,选了即生效(无 effort 二级面板)。
 * codex = gpt-5.5 / xhigh;claude = claude:glm (GLM-5.2) / max (ultracode)。
 * claude 的 max 由 ClaudeAgentProcess.setModelSettings 强制 applyFlagSettings,
 * 不依赖 ~/.claude/settings.json 的 effortLevel。 */
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
    model: 'claude:glm',
    displayName: 'Claude · GLM-5.2',
    description: 'GLM-5.2 · max (ultracode) 推理强度。',
    effort: 'max' as AgentReasoningEffort,
  },
]

function fixedModelChoices(s: Session): cards.ModelChoice[] {
  const currentProvider = s.currentProvider()
  const currentModel = s.currentModelLabel()
  const currentEffort = s.currentEffortLabel()
  return FIXED_MODEL_CHOICES.map(item => {
    const selected = currentProvider === item.provider && currentModel === item.model
    return {
      provider: item.provider,
      model: item.model,
      displayName: item.displayName,
      description: item.description,
      isDefault: false,
      selected,
      efforts: [{
        effort: item.effort,
        description: '',
        isDefault: true,
        selected: selected && currentEffort === item.effort,
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
