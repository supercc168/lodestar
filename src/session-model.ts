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
type SourceModelChoice = {
  provider: AgentProvider
  sourceId: string
  model: string
  displayName: string
  description: string
  enabled: boolean
  efforts: AgentReasoningEffort[]
  defaultEffort: AgentReasoningEffort
}

/** 面板选项:每个 enabled source 展开成它的每个模型(订阅模型列表);未配置 source 占位一项(灰显+启用)。 */
function tokenSourceChoices(): SourceModelChoice[] {
  const out: SourceModelChoice[] = []
  for (const ts of listTokenSources()) {
    if (!ts.enabled || !ts.models.length) {
      out.push({
        provider: ts.agent as AgentProvider,
        sourceId: ts.id,
        model: ts.id,
        displayName: ts.display,
        description: '未配置 · 点「启用」',
        enabled: false,
        efforts: [],
        defaultEffort: ts.agent === 'codex' ? 'xhigh' : 'max',
      })
      continue
    }
    for (const m of ts.models) {
      out.push({
        provider: ts.agent as AgentProvider,
        sourceId: ts.id,
        model: m.model,
        displayName: m.display,
        description: ts.display,
        enabled: true,
        efforts: m.efforts,
        defaultEffort: m.defaultEffort,
      })
    }
  }
  return out
}

function fixedModelChoices(s: Session): cards.ModelChoice[] {
  const currentTs = s.currentTokenSource()
  const currentModel = s.currentModelLabel()
  const currentEffort = s.currentEffortLabel()
  return tokenSourceChoices().map(item => {
    const selected = item.enabled && currentTs?.id === item.sourceId && currentModel === item.model
    return {
      provider: item.provider,
      sourceId: item.sourceId,
      model: item.model,
      displayName: item.displayName,
      description: item.description,
      enabled: item.enabled,
      isDefault: false,
      selected,
      efforts: item.enabled
        ? item.efforts.map(e => ({
            effort: e,
            description: '',
            isDefault: e === item.defaultEffort,
            selected: selected && currentEffort === e,
          }))
        : [],
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
  if (choice.enabled === false) {
    return { ok: false, message: `${choice.displayName} 未配置,请先点「启用」` }
  }
  // effort 锁死该模型 default effort;要换 effort 重发 model 选。
  const effort = choice.efforts.find(e => e.isDefault)?.effort ?? choice.efforts[0]?.effort
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
  // 锁死:只放行 tokenSourceChoices 里该模型支持的 effort(per-model)
  const fixed = tokenSourceChoices().find(c => c.provider === provider && c.model === model)
  if (!fixed || !fixed.efforts.includes(effort)) {
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
    await s.applyModelSelection(provider, model, effort, choice?.sourceId)
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
