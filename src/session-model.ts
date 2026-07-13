import { randomUUID } from 'node:crypto'

import type { Session } from './session'
import { listTokenSources } from './token-source'
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

/** model 命令选项:从 token source registry 动态枚举(每个 source 一项 = 一个账号)。
 * effort 锁死(每个 source 默认 effort);选了 → applyModelSelection 传 tokenSourceId。 */
function tokenSourceChoices() {
  return listTokenSources().map(ts => ({
    provider: ts.agent as AgentProvider,
    // model 字段用 source.id 作面板/回调标识;spawn 走 ts.defaultModel(selectedModel 设 null)
    model: ts.id,
    displayName: ts.display,
    description: ts.agent === 'codex' ? 'Codex 订阅' : 'Claude 第三方',
    effort: ts.models[0]?.defaultEffort ?? (ts.agent === 'codex' ? 'xhigh' : 'max'),
  }))
}

function fixedModelChoices(s: Session): cards.ModelChoice[] {
  const currentProvider = s.currentProvider()
  const currentTs = s.currentTokenSource()
  const currentEffort = s.currentEffortLabel()
  return tokenSourceChoices().map(item => {
    // 有 token source 时比 source.id;否则比 provider(兼容未配 ts 的旧路径)
    const selected = currentTs ? currentTs.id === item.model : currentProvider === item.provider
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
  // 锁死:只放行 tokenSourceChoices 的 (provider, model=source.id, effort) 组合
  const fixed = tokenSourceChoices().find(c => c.provider === provider && c.model === model)
  if (!fixed || fixed.effort !== effort) {
    return { ok: false, message: `${agentProviderLabel(provider)} · ${model}/${effort} 不在选项中` }
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
    await s.applyModelSelection(provider, model, effort, model)
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
