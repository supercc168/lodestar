import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'

import type { Session } from './session'
import {
  CodexProcess,
  isCodexReasoningEffort,
  type CodexModel,
} from './codex-process'
import {
  CLAUDE_EFFORT,
  CLAUDE_REASONING_EFFORTS,
  agentProviderLabel,
  isClaudeReasoningEffort,
  providerFromModel,
  type AgentProvider,
  type AgentReasoningEffort,
  type ClaudeReasoningEffort,
} from './agent-process'
import { CHANNEL_INSTRUCTIONS } from './instructions'
import * as cards from './cards'
import * as feishu from './feishu'
import { log } from './log'
import { messageOf, withTimeout, type ModelActionResult } from './session-util'
import { claudeModelProfiles } from './claude-models'

export interface ModelPanelState {
  models: cards.ModelChoice[]
}

function modelListCwd(s: Session): string {
  if (existsSync(s.workDir)) return s.workDir
  if (existsSync(feishu.PROJECTS_ROOT)) return feishu.PROJECTS_ROOT
  return process.cwd()
}

async function listAvailableCodexModels(s: Session): Promise<CodexModel[]> {
  if (s.proc?.isAlive()) {
    if (s.proc.provider === 'codex') return await withTimeout(s.proc.listModels(), 20_000, 'model/list')
  }
  if (!feishu.isOpenAIChatGPTAuthenticated()) {
    throw new Error('Codex 未登录 ChatGPT 账号。请在服务器上运行 `codex login` 后再试。')
  }
  const proc = new CodexProcess({
    workDir: modelListCwd(s),
    effort: s.effortForSpawn(),
    appendSystemPrompt: CHANNEL_INSTRUCTIONS,
  })
  try {
    return await withTimeout(proc.listModels(), 20_000, 'model/list')
  } finally {
    await proc.kill(1000).catch(e => log(`session "${s.sessionName}": temp model-list proc kill failed: ${e}`))
  }
}

export async function showModelPanel(s: Session): Promise<void> {
  let codexModels: CodexModel[] = []
  let codexError: string | null = null
  try {
    codexModels = await listAvailableCodexModels(s)
  } catch (e) {
    codexError = messageOf(e)
    log(`session "${s.sessionName}": codex model list failed: ${codexError}`)
  }

  const panelId = randomUUID()
  const currentModel = s.currentModelLabel()
  const currentEffort = s.currentEffortLabel()
  const choices = [
    ...codexModelChoices(s, codexModels),
    ...claudeModelChoices(s),
  ]
  if (codexError) {
    await feishu.sendText(s.chatId, `⚠️ Codex 模型列表失败: ${codexError}\n仍可选择 Claude Code 后端。`)
  }
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

function codexModelChoices(s: Session, models: CodexModel[]): cards.ModelChoice[] {
  const seen = new Set<string>()
  const currentModel = s.currentModelLabel()
  const currentEffort = s.currentEffortLabel()
  const choices: cards.ModelChoice[] = []
  for (const m of models) {
    if (seen.has(m.model)) continue
    seen.add(m.model)
    choices.push({
      provider: 'codex',
      model: m.model,
      displayName: m.displayName,
      description: m.description,
      isDefault: m.isDefault,
      selected: currentModel === m.model,
      efforts: m.supportedReasoningEfforts.map(effort => ({
        effort: effort.reasoningEffort,
        description: effort.description,
        isDefault: m.defaultReasoningEffort === effort.reasoningEffort,
        selected: currentModel === m.model && currentEffort === effort.reasoningEffort,
      })),
    })
  }
  return choices
}

function claudeModelChoices(s: Session): cards.ModelChoice[] {
  const currentModel = s.currentModelLabel()
  const currentEffort = s.currentEffortLabel()
  const buildEfforts = () => CLAUDE_REASONING_EFFORTS.map(effort => ({
    effort,
    description: claudeEffortDescription(effort),
    isDefault: effort === CLAUDE_EFFORT,
    selected: s.currentProvider() === 'claude' && currentEffort === effort,
  }))
  return [{
    provider: 'claude',
    model: 'claude:default',
    displayName: 'Claude Code',
    description: '使用本机 Claude Code 当前配置，适合沿用默认模型路由。',
    isDefault: false,
    selected: s.currentProvider() === 'claude' && currentModel === 'claude:default',
    efforts: buildEfforts(),
  }, ...claudeModelProfiles().map(profile => ({
    provider: 'claude' as const,
    model: profile.key,
    displayName: profile.displayName,
    description: profile.description,
    isDefault: false,
    selected: s.currentProvider() === 'claude' && currentModel === profile.key,
    efforts: buildEfforts(),
  }))]
}

function claudeEffortDescription(effort: ClaudeReasoningEffort): string {
  switch (effort) {
    case 'low': return '低推理强度，响应更快。'
    case 'medium': return '中等推理强度。'
    case 'high': return '高推理强度。'
    case 'xhigh': return '更高推理强度，适合复杂实现。'
    case 'max': return '最高推理强度，适合长上下文或复杂改动。'
  }
}

function initialEffortForModel(s: Session, model: cards.ModelChoice): string | null {
  const currentEffort = s.currentEffortLabel()
  if (model.selected && model.efforts.some(effort => effort.effort === currentEffort)) return currentEffort
  return model.efforts.find(effort => effort.isDefault)?.effort ?? model.efforts[0]?.effort ?? null
}

function actionProvider(model: string, raw: any): AgentProvider {
  return raw?.provider === 'claude' || raw?.provider === 'codex'
    ? raw.provider
    : providerFromModel(model)
}

function modelChoiceFromAction(s: Session, model: string, raw: any): cards.ModelChoice | null {
  const effortsRaw = Array.isArray(raw?.efforts) ? raw.efforts : []
  const efforts: cards.ModelEffortChoice[] = effortsRaw
    .map((item: any) => ({
      effort: typeof item?.effort === 'string' ? item.effort : '',
      description: typeof item?.description === 'string' ? item.description : '',
      isDefault: item?.is_default === true,
    }))
    .filter((item: cards.ModelEffortChoice) => item.effort)
  if (efforts.length === 0) return null
  const provider = actionProvider(model, raw)
  return {
    provider,
    model,
    displayName: typeof raw?.display_name === 'string' && raw.display_name ? raw.display_name : model,
    description: '',
    isDefault: raw?.is_default === true,
    selected: s.currentProvider() === provider && s.currentModelLabel() === model,
    efforts,
  }
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
  const panelId = panelIdRaw.trim()
  const panel = s.modelPanels.get(panelId)
  const provider = actionProvider(model, actionValue)
  const choice = panel?.models.find(m => m.model === model && (m.provider ?? 'codex') === provider)
    ?? modelChoiceFromAction(s, model, actionValue)
  if (!choice) {
    return { ok: false, message: '模型不在当前面板列表中,请重新发送 model' }
  }
  const selectedEffort = initialEffortForModel(s, choice)
  return {
    ok: choice.efforts.length > 0,
    message: choice.efforts.length > 0 ? `已选择模型 ${model},请选择 effort` : '这个模型未返回可用 effort',
    card: cards.modelEffortCard({
      sessionName: s.sessionName,
      panelId,
      currentModel: s.currentModelLabel(),
      currentEffort: s.currentEffortLabel(),
      selectedModel: choice,
      selectedEffort,
    }),
  }
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
