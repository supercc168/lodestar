import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'

import type { Session } from './session'
import {
  CodexProcess,
  isCodexReasoningEffort,
  type CodexModel,
  type CodexReasoningEffort,
} from './codex-process'
import { CHANNEL_INSTRUCTIONS } from './instructions'
import * as cards from './cards'
import * as feishu from './feishu'
import { log } from './log'
import { messageOf, withTimeout, type ModelActionResult } from './session-util'

export interface ModelPanelState {
  models: cards.ModelChoice[]
}

function modelListCwd(s: Session): string {
  if (existsSync(s.workDir)) return s.workDir
  if (existsSync(feishu.PROJECTS_ROOT)) return feishu.PROJECTS_ROOT
  return process.cwd()
}

async function listAvailableModels(s: Session): Promise<CodexModel[]> {
  if (s.proc?.isAlive()) {
    return await withTimeout(s.proc.listModels(), 20_000, 'model/list')
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
  let models: CodexModel[]
  try {
    models = await listAvailableModels(s)
  } catch (e) {
    const message = `❌ 模型列表失败: ${messageOf(e)}`
    log(`session "${s.sessionName}": model list failed: ${messageOf(e)}`)
    await feishu.sendText(s.chatId, message)
    return
  }

  const panelId = randomUUID()
  const currentModel = s.currentModelLabel()
  const currentEffort = s.currentEffortLabel()
  const choices = modelChoices(s, models)
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

function modelChoices(s: Session, models: CodexModel[]): cards.ModelChoice[] {
  const seen = new Set<string>()
  const currentModel = s.currentModelLabel()
  const currentEffort = s.currentEffortLabel()
  const choices: cards.ModelChoice[] = []
  for (const m of models) {
    if (seen.has(m.model)) continue
    seen.add(m.model)
    choices.push({
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

function initialEffortForModel(s: Session, model: cards.ModelChoice): string | null {
  const currentEffort = s.currentEffortLabel()
  if (model.selected && model.efforts.some(effort => effort.effort === currentEffort)) return currentEffort
  return model.efforts.find(effort => effort.isDefault)?.effort ?? model.efforts[0]?.effort ?? null
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
  return {
    model,
    displayName: typeof raw?.display_name === 'string' && raw.display_name ? raw.display_name : model,
    description: '',
    isDefault: raw?.is_default === true,
    selected: s.currentModelLabel() === model,
    efforts,
  }
}

function modelSelectionScope(s: Session): string {
  return s.currentTurn
    ? '当前 turn 不变,下一轮开始使用。'
    : s.proc?.isAlive()
      ? '下一轮开始使用。'
      : '下次启动 Codex 时使用。'
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
  const choice = panel?.models.find(m => m.model === model) ?? modelChoiceFromAction(s, model, actionValue)
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
): Promise<ModelActionResult> {
  const model = modelRaw.trim()
  const effortValue = effortRaw.trim()
  if (!model) return { ok: false, message: '模型为空' }
  if (!isCodexReasoningEffort(effortValue)) return { ok: false, message: 'reasoning effort 无效' }
  const effort: CodexReasoningEffort = effortValue
  const panelId = panelIdRaw.trim()
  const panel = s.modelPanels.get(panelId)
  const choice = panel?.models.find(m => m.model === model)
  if (choice && !choice.efforts.some(item => item.effort === effort)) {
    return { ok: false, message: 'reasoning effort 不属于该模型' }
  }
  try {
    if (s.proc?.isAlive()) {
      await withTimeout(s.proc.setModelSettings(model, effort), 20_000, 'thread/settings/update')
    }
    s.selectedModel = model
    s.selectedEffort = effort
    feishu.bindSessionModel(s.sessionName, model, effort)
    const scope = modelSelectionScope(s)
    s.modelPanels.delete(panelId)
    return {
      ok: true,
      message: `已选择 ${model} / ${effort}`,
      card: cards.modelResultCard({
        sessionName: s.sessionName,
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
