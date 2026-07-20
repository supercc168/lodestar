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
import {
  codexModelChoices,
  codexModelConfigured,
  codexModelEffort,
  codexModelIsApiRoute,
} from './codex-models'
import { log } from './log'
import {
  messageOf,
  withTimeout,
  type LifecycleLease,
  type ModelActionResult,
} from './session-util'

export interface ModelPanelState {
  models: cards.ModelChoice[]
}

/** model 命令的固定选项:每项 effort 锁死,选了即生效(无 effort 二级面板)。
 * codex = gpt-5.6-sol / max(2026-07-20 起所有 GPT 档统一 max);
 * claude 第一方档位 = Fable 5 / Opus 4.8,均 max(ultracode 最高思考强度)。
 * claude 的 max 由 ClaudeAgentProcess.setModelSettings 强制 applyFlagSettings,
 * 不依赖 ~/.claude/settings.json 的 effortLevel。
 * 各 claude:<key> 的实际 SDK model id 由 claude-models.ts 的 profile 决定
 * (claude:fable→claude-fable-5,claude:opus→claude-opus-4-8),reclaude 透传
 * --model 到 Claude Code,走用户的 Anthropic 登录态。 */
const FIXED_MODEL_CHOICES = [
  {
    provider: 'codex' as const,
    model: 'gpt-5.6-sol',
    displayName: 'Codex · GPT-5.6 Sol',
    description: 'GPT-5.6 Sol · max 推理强度 · 1.5M 上下文。',
    effort: 'max' as AgentReasoningEffort,
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
  {
    // Grok 第三方路由 · 无痕(wuhen-ai,Anthropic 兼容端点):与 GLM 同构,走
    // config.toml [claude.models.grok] 的 base_url + auth_token + model。
    // effort 锁死值由 config 的 effort 覆盖(第三方中转惯例 xhigh,见
    // resolvedEffort);未配置时 picker 仍显示,选择被 onModelEffortSelect 拦截。
    provider: 'claude' as const,
    model: 'claude:grok',
    displayName: 'Claude · Grok 4.5 · 无痕',
    description: 'Grok 4.5 · 无痕(wuhen-ai,Anthropic 兼容端点)。',
    effort: 'max' as AgentReasoningEffort,
  },
  {
    // Grok 第三方路由 · CatCodex(catcodexapi):第二个 grok 渠道,走
    // [claude.models.grokcc]。与 grok(无痕)同构;displayName 带渠道名以便区分。
    provider: 'claude' as const,
    model: 'claude:grokcc',
    displayName: 'Claude · Grok 4.5 · CatCodex',
    description: 'Grok 4.5 · CatCodex(catcodexapi,Anthropic 兼容端点)。',
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
  if (item.provider === 'codex') {
    const configured = codexModelEffort(item.model)
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
  const all = [...FIXED_MODEL_CHOICES, ...codexModelChoices()]
  const hit = all.find(c => c.provider === provider && c.model === model)
  // 第三方 API 路由(claude GLM / codex 自定义 provider)持久化了但当前未配置 →
  // 回落到该 provider 的登录默认档(claude→claude:fable,codex→gpt-5.6-sol)。否则
  // restore 会以未鉴权状态拉起该档位:既跑不通,又绕过 picker 的配置门槛。
  const unconfiguredApiRoute =
    (provider === 'claude' && claudeModelIsApiRoute(model) && !claudeModelConfigured(model)) ||
    (provider === 'codex' && codexModelIsApiRoute(model) && !codexModelConfigured(model))
  if (hit && unconfiguredApiRoute) {
    const fallback = defaultFixedChoiceFor(provider)
    return { model: fallback.model, effort: resolvedEffort(fallback) }
  }
  const choice = hit ?? defaultFixedChoiceFor(provider)
  return { model: choice.model, effort: resolvedEffort(choice) }
}

/** 新 session(无持久化 model 选择)的默认档位,取自 config.toml 的
 * [claude] default_model。接受档位 key("glm")或固定项 model("claude:glm" /
 * "gpt-5.6-sol";legacy 裸 "gpt-5.5" 自动迁移到 gpt-5.6-sol)。未配置 / 无法
 * 识别 → null(调用方回落到硬编码登录默认 Fable 5)。
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
  // legacy:内建 codex 档从 gpt-5.5 升级到 gpt-5.6-sol(2026-07-09),旧 config
  // 写的裸 "gpt-5.5" 迁移到新内建档,不让老配置静默退回 Fable 5。
  const bare = raw === 'gpt-5.5' ? 'gpt-5.6-sol' : raw
  const wanted = bare.startsWith('claude:') || bare.startsWith('codex:') || bare === 'gpt-5.6-sol'
    ? bare
    : `claude:${bare}`
  const hit = [...FIXED_MODEL_CHOICES, ...codexModelChoices()].find(c => c.model === wanted)
  if (!hit) return null
  return { provider: hit.provider, model: hit.model, effort: resolvedEffort(hit) }
}

/** 第三方 API 路由(GLM/Grok)未配 token 时的描述后缀,提示去 config.toml 设置。
 * section 名按 model 推导(claude:glm → [claude.models.glm]),不再写死 glm。 */
function choiceDescription(item: typeof FIXED_MODEL_CHOICES[number]): string {
  if (item.provider === 'claude' && claudeModelIsApiRoute(item.model) && !claudeModelConfigured(item.model)) {
    const section = item.model.startsWith('claude:') ? item.model.slice('claude:'.length) : item.model
    return `${item.description}(未配置 · 需在 config.toml 的 [claude.models.${section}] 填 base_url + auth_token + model)`
  }
  if (item.provider === 'codex' && codexModelIsApiRoute(item.model) && !codexModelConfigured(item.model)) {
    return `${item.description}(未配置 · 需在 config.toml 的 [codex.models.<slug>] 填 base_url + api_key(或 requires_openai_auth)+ model)`
  }
  return item.description
}

export function fixedModelChoices(s: Session): cards.ModelChoice[] {
  const currentProvider = s.currentProvider()
  const currentModel = s.currentModelLabel()
  const currentEffort = s.currentEffortLabel()
  return [...FIXED_MODEL_CHOICES, ...codexModelChoices()].map(item => {
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
  if (s.hasPreservedWatchdogRecovery()) {
    await feishu.sendText(s.chatId, '⚠️ thread 自动恢复尚未完成，暂不能切换模型。请先发送 restart 恢复，或 clear/kill 丢弃。')
    return
  }
  const lease = s.beginLifecycle('model')
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
  if (!s.ownsLifecycle(lease) || s.hasPreservedWatchdogRecovery()) {
    s.modelPanels.delete(panelId)
    return
  }
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
  if (s.hasPreservedWatchdogRecovery()) return interruptedModelSelection(s)
  const lease = s.beginLifecycle('model')
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
  return onModelEffortSelect(s, model, effort, panelIdRaw, _userOpenId, provider, lease)
}

function interruptedModelSelection(s: Session): ModelActionResult {
  return s.hasPreservedWatchdogRecovery()
    ? { ok: false, message: 'thread 自动恢复尚未完成，暂不能切换模型' }
    : { ok: false, message: '模型切换已被较新的会话操作取代' }
}

export async function onModelEffortSelect(
  s: Session,
  modelRaw: string,
  effortRaw: string,
  panelIdRaw = '',
  _userOpenId = '',
  providerRaw = '',
  lifecycleLease?: LifecycleLease,
): Promise<ModelActionResult> {
  if (s.hasPreservedWatchdogRecovery()) return interruptedModelSelection(s)
  const lease = lifecycleLease ?? s.beginLifecycle('model')
  if (!s.ownsLifecycle(lease)) {
    return interruptedModelSelection(s)
  }
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
  const fixed = [...FIXED_MODEL_CHOICES, ...codexModelChoices()]
    .find(c => c.provider === provider && c.model === model)
  if (!fixed || resolvedEffort(fixed) !== effort) {
    return { ok: false, message: `${agentProviderLabel(provider)} · ${model}/${effort} 不在固定选项中` }
  }
  // 第三方 API 路由(GLM/Grok)必须先在 lodestar config 配好 token 才能切换 ——
  // 官方登录档位(Fable 5/Opus)无需配置。拦截未配置的第三方档位,给出清晰指引。
  // label/section 按 model 推导(claude:glm → GLM / [claude.models.glm]),不再写死 GLM。
  if (provider === 'claude' && claudeModelIsApiRoute(model) && !claudeModelConfigured(model)) {
    const name = model.startsWith('claude:') ? model.slice('claude:'.length) : model
    return {
      ok: false,
      message: `${name.toUpperCase()}(${model})未配置:请在 ~/.config/lodestar/config.toml 的 [claude.models.${name}] 填写 base_url、auth_token 和 model 后重试(官方 Fable 5 / Opus 走登录态,无需配置)`,
    }
  }
  if (provider === 'codex' && codexModelIsApiRoute(model) && !codexModelConfigured(model)) {
    return {
      ok: false,
      message: `Codex API 档位(${model})未配置:请在 ~/.config/lodestar/config.toml 的 [codex.models.<slug>] 填写 base_url、api_key(或 requires_openai_auth)和 model 后重试(内建 gpt-5.6-sol 走全局 codex 配置,无需配置)`,
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
  const operation = s.beginModelSwitch(lease)
  if (!operation) return interruptedModelSelection(s)
  const settingsProc = s.proc
  try {
    if (settingsProc?.isAlive() && settingsProc.provider === provider) {
      if (!shouldRespawnIdleClaude) {
        await withTimeout(settingsProc.setModelSettings(model, effort), 20_000, 'thread/settings/update')
      }
    }
    if (
      !s.ownsModelSwitch(operation) ||
      s.hasPreservedWatchdogRecovery() ||
      (settingsProc && s.proc !== settingsProc)
    ) return interruptedModelSelection(s)
    const applied = await s.applyModelSelection(provider, model, effort, lease)
    if (applied === false || !s.ownsModelSwitch(operation) || s.hasPreservedWatchdogRecovery()) {
      return interruptedModelSelection(s)
    }
    if (shouldRespawnIdleClaude) {
      await s.stopIdleCurrentProcess('Claude model profile changed; env will apply on next spawn', lease)
      if (!s.ownsModelSwitch(operation) || s.hasPreservedWatchdogRecovery()) {
        return interruptedModelSelection(s)
      }
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
    if (!s.ownsModelSwitch(operation) || s.hasPreservedWatchdogRecovery()) {
      return interruptedModelSelection(s)
    }
    const message = `模型切换失败: ${messageOf(e)}`
    log(`session "${s.sessionName}": set model settings failed: ${messageOf(e)}`)
    await feishu.sendText(s.chatId, `❌ ${message}`)
    return { ok: false, message }
  } finally {
    s.finishModelSwitch(operation)
  }
}
