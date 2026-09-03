/**
 * 临时会话 / fork / back / rs 历史分支。
 *
 * 控制面只持有 provider-neutral ConversationLaunch。Claude/Codex 的具体
 * fork 参数由 Session.spawnAgent 翻译；选择卡只携带 panel/choice opaque id
 * (上游 ff44afb 安全修复:panel/choice 状态机取代 anchorIdx 下标信任,真相源
 * 在 Session 侧 panel state,卡片载荷不可伪造定位真实资源)。
 *
 * 本地守卫叠加(保护线,04-CONTEXT):claim 通过 ≠ lifecycle 可抢占——
 * hasPreservedWatchdogRecovery/beginLifecycle 守卫保留在动作体内,叠加在
 * 上游 claim 校验之上,不是替换。
 *
 * **rs 历史列表**:Claude 扫 claude code transcript 目录(~/.claude/projects/
 * <encoded-cwd>/*.jsonl,同 cwd 会话天然同目录);Codex 走 app-server
 * thread/list(Session.listCodexConversations,app-server owns discovery)。
 */

import type { Session } from './session'
import * as feishu from './feishu'
import * as cards from './cards'
import { log } from './log'
import { claudeTranscriptDir } from './claude-agent-process'
import {
  validateConversationLaunch,
  type ConversationBranchBase,
  type ConversationLaunch,
  type ConversationRouting,
  type ConversationSummary,
} from './conversation'
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const DAY_MS = 24 * 60 * 60 * 1000
const PANEL_TTL_MS = 30 * 60 * 1000
const CONSUMED_PANEL_TTL_MS = 60 * 60 * 1000
const HISTORY_CARD_MAX = 40

/** 卡片按钮 handler 的业务结果(上游 ec149d7):daemon 据此发回执/渲染
 *  selectionResultCard 终态卡,失败载荷进入失败回执路径(__businessOk 收紧)。 */
export interface TempSelectionResult {
  ok: boolean
  message: string
  /** false means validation never claimed the panel; keep the shared picker intact. */
  replaceCard?: boolean
  /** Trusted rs selection/result snapshot for replacing the consumed picker. */
  resumePresentation?: ResumeSelectionPresentation
}

export interface ResumeSelectionPresentation {
  projectName: string
  provider: 'claude' | 'codex'
  selectedPreview: string
  selectedTs: number
  sourceSessionId: string
  sourceStatus?: string
  previousSessionId: string | null
  newSessionId: string | null
  bindingState: 'changed' | 'prepared' | 'unchanged' | 'unknown'
}

type PanelMode = 'fork' | 'back' | 'resume'

interface ForkChoice {
  kind: 'fork' | 'back'
  launch: ConversationLaunch
  branchBase: ConversationBranchBase
  seedAnchors: feishu.TurnAnchor[]
  writes: feishu.TurnWrite[]
}

interface ResumeChoice {
  kind: 'resume'
  launch: Extract<ConversationLaunch, { kind: 'fork' }>
  sourcePreview: string
  sourceTs: number
  sourceStatus?: string
}

type TempPanelChoice = ForkChoice | ResumeChoice

interface TempPanelState {
  id: string
  mode: PanelMode
  requesterOpenId: string
  provider: 'claude' | 'codex'
  sourceSessionId: string | null
  workDir: string
  baseName: string
  routing: ConversationRouting
  createdAt: number
  status: 'open' | 'processing' | 'consumed'
  consumedAt?: number
  choices: Map<string, TempPanelChoice>
}

const panelsBySession = new WeakMap<Session, Map<string, TempPanelState>>()
const reservedTempChatNames = new Set<string>()

/** 临时群 baseName:只剥 * 临时后缀,保留 [slug] worktree 后缀(上游 ff44afb:
 *  temp-of-worktree 留在 worktree cwd,群名/子临时群名随 worktree 走)。 */
function baseSessionName(s: Session): string {
  return feishu.tempProjectName(s.sessionName) ?? s.sessionName
}

function reserveTempChatName(baseName: string): string {
  const name = feishu.tempChatName(baseName, reservedTempChatNames)
  reservedTempChatNames.add(name)
  return name
}

function releaseTempChatName(name: string): void {
  reservedTempChatNames.delete(name)
}

function panelMap(s: Session): Map<string, TempPanelState> {
  let panels = panelsBySession.get(s)
  if (!panels) {
    panels = new Map()
    panelsBySession.set(s, panels)
  }
  const now = Date.now()
  for (const [id, panel] of panels) {
    const ttl = panel.status === 'consumed' ? CONSUMED_PANEL_TTL_MS : PANEL_TTL_MS
    const since = panel.consumedAt ?? panel.createdAt
    if (now - since > ttl) panels.delete(id)
  }
  return panels
}

/** 路由一致性比较(D-02 slim 层裁剪:本地 ConversationRouting 无 token source
 *  registry 字段,上游对应比较项随字段一并裁剪)。 */
function sameRouting(a: ConversationRouting, b: ConversationRouting): boolean {
  return a.provider === b.provider
    && a.model === b.model
    && a.effort === b.effort
}

function createPanel(
  s: Session,
  mode: PanelMode,
  requesterOpenId: string,
  choices: Map<string, TempPanelChoice>,
): TempPanelState {
  const panel: TempPanelState = {
    id: randomUUID(),
    mode,
    requesterOpenId,
    provider: s.selectedProvider,
    sourceSessionId: s.lastSessionId,
    workDir: s.workDir,
    baseName: baseSessionName(s),
    routing: s.conversationRouting(),
    createdAt: Date.now(),
    status: 'open',
    choices,
  }
  panelMap(s).set(panel.id, panel)
  return panel
}

/** 五重拒绝(上游 ff44afb 安全修复本体):过期/mode、非 owner、非 open(防重复
 *  点击)、provider/workDir/source/routing stale、choiceId 无效。拒绝一律不消费
 *  选择卡(replaceCard:false 由调用方带上),owner 稍后仍可重试。 */
function claimPanelChoice(
  s: Session,
  mode: PanelMode,
  panelId: string,
  choiceId: string,
  userOpenId: string,
): { panel: TempPanelState; choice: TempPanelChoice } | { error: string } {
  const panel = panelMap(s).get(panelId)
  if (!panel || panel.mode !== mode) return { error: '这张选择卡已过期，请重新发送命令' }
  if (!userOpenId || panel.requesterOpenId !== userOpenId) {
    return { error: '只有打开这张选择卡的用户可以执行；请自行发送命令重新打开' }
  }
  if (panel.status !== 'open') return { error: '这张选择卡已执行或正在处理，请勿重复点击' }
  if (
    panel.provider !== s.selectedProvider
    || panel.workDir !== s.workDir
    || panel.sourceSessionId !== s.lastSessionId
    || !sameRouting(panel.routing, s.conversationRouting())
  ) {
    return { error: '这张卡对应的 provider、目录或源会话已经变化，请重新发送命令' }
  }
  const choice = panel.choices.get(choiceId)
  if (!choice) return { error: '无效的选择项，这张卡可能已过期' }
  panel.status = 'processing'
  return { panel, choice }
}

function consumePanel(panel: TempPanelState): void {
  panel.status = 'consumed'
  panel.consumedAt = Date.now()
}

function forkLaunch(checkpoint: feishu.TurnAnchor['checkpoint']): Extract<ConversationLaunch, { kind: 'fork' }> {
  return { kind: 'fork', source: checkpoint.source, through: checkpoint }
}

/** fk/bk 锚列表:只列当前 provider + cwd 匹配的 checkpoint(跨后端/跨目录的
 *  锚不可用作当前会话的分叉点)。 */
function eligibleAnchors(s: Session): feishu.TurnAnchor[] {
  return feishu.getTurnAnchors(s.sessionName)
    .filter(anchor => anchor.checkpoint.provider === s.selectedProvider && anchor.checkpoint.source.cwd === s.workDir)
}

function usableBranchBase(s: Session): ConversationBranchBase {
  const base = feishu.getSessionBranchBase(s.sessionName)
  if (base === null || base.kind === 'fresh') return base
  try {
    validateConversationLaunch(base, s.selectedProvider, s.workDir)
    return base
  } catch {
    return null
  }
}

// ── PHASE4-TRANSITION 旧 btw 需要的两个 helper(T3 随 btw 换代删除) ───

/** 当前群对应的项目名(剥 *ts 临时后缀 / [slug] worktree 后缀)。 */
function projectName(s: Session): string {
  return feishu.tempProjectName(s.sessionName) ?? s.worktreeProjectName() ?? s.sessionName
}

/** 主群当前 model 选择,供 btw/fk 创建的临时群继承。selectedModel 为空(主群未显式选过
 *  档位、走默认)时返回 undefined —— 此时临时群也走自己的默认,结果一致,无需特判。 */
function inheritSelection(s: Session): feishu.SessionModelSelection | undefined {
  return s.selectedModel
    ? { provider: s.selectedProvider, model: s.selectedModel, effort: s.selectedEffort }
    : undefined
}

// ── Claude stopped-session history catalog ───────────────────────────

function listClaudeSessions(workDir: string): ConversationSummary[] {
  const dir = claudeTranscriptDir(workDir)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (error: any) {
    if (error?.code === 'ENOENT') return []
    throw new Error(`读取 Claude 会话目录失败: ${error?.message ?? error}`)
  }
  const all: ConversationSummary[] = []
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const full = join(dir, name)
    let mtime: number
    try { mtime = statSync(full).mtimeMs } catch (error: any) {
      throw new Error(`读取 Claude 会话元数据失败 (${name}): ${error?.message ?? error}`)
    }
    all.push({
      provider: 'claude',
      sessionId: name.slice(0, -6),
      cwd: workDir,
      preview: firstUserSummary(full),
      ts: mtime,
    })
  }
  return all.sort((a, b) => b.ts - a.ts)
}

/** 24h 内优先,不足 10 条补更早的到 10 条,上限 40 条(卡片体积)。 */
function recentHistory(entries: ConversationSummary[]): ConversationSummary[] {
  const ordered = entries.slice().sort((a, b) => b.ts - a.ts)
  const cutoff = Date.now() - DAY_MS
  const withinCount = ordered.filter(entry => entry.ts >= cutoff).length
  return ordered.slice(0, Math.min(HISTORY_CARD_MAX, Math.max(10, withinCount)))
}

/** 从 transcript 提取首条用户输入(会话主题)。优先 queue-operation 的 enqueue
 *  content(用户原始输入);fallback 首条 user message 的 text。只读前 64KB ——
 *  首条用户输入总在文件开头,避免对大 transcript 全量读。 */
function firstUserSummary(path: string): string {
  let text = ''
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const b = Buffer.alloc(65536)
    const n = readSync(fd, b, 0, 65536, 0)
    text = b.subarray(0, n).toString('utf8')
  } catch (error: any) {
    throw new Error(`读取 Claude 会话摘要失败 (${path}): ${error?.message ?? error}`)
  } finally {
    if (fd !== null) closeSync(fd)
  }
  let fallback = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let data: any
    try { data = JSON.parse(line) } catch { continue }
    if (data.type === 'queue-operation' && data.operation === 'enqueue' && typeof data.content === 'string') {
      const content = data.content.trim()
      if (content) return content.slice(0, 80)
    }
    if (!fallback && data.type === 'user' && data.message) {
      const userText = userMessageText(data.message)
      if (userText) fallback = userText
    }
  }
  return fallback.slice(0, 80)
}

function userMessageText(message: any): string {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') return part.text
  }
  return ''
}

// ── Picker cards ─────────────────────────────────────────────────────

async function showTurnList(s: Session, mode: 'fork' | 'back', userOpenId: string): Promise<void> {
  if (!userOpenId) {
    await feishu.sendText(s.chatId, '❌ 找不到发起人，无法创建安全选择卡。')
    return
  }
  const anchors = eligibleAnchors(s)
  const branchBase = usableBranchBase(s)
  const choices = new Map<string, TempPanelChoice>()
  const entries: cards.TurnListEntry[] = []
  for (let index = 0; index < anchors.length; index++) {
    const anchor = anchors[index]
    // Legacy/unknown baseline cannot prove that the first retained prompt was
    // truly at conversation origin. Omit only that destructive choice; later
    // prompts can still fork through their previous canonical checkpoint.
    if (index === 0 && branchBase === null) continue
    const choiceId = randomUUID()
    const launch: ConversationLaunch = index === 0
      ? branchBase!
      : forkLaunch(anchors[index - 1].checkpoint)
    choices.set(choiceId, {
      kind: mode,
      launch,
      branchBase,
      seedAnchors: anchors.slice(0, index),
      writes: anchors.slice(index).flatMap(item => item.writes),
    })
    entries.push({ choiceId, preview: anchor.preview, ts: anchor.ts })
  }
  entries.reverse()
  const panel = createPanel(s, mode, userOpenId, choices)
  const card = cards.turnListCard({
    projectName: baseSessionName(s),
    panelId: panel.id,
    mode,
    entries,
  })
  let messageId: string | null
  try { messageId = await feishu.sendCard(s.chatId, card) } catch (error) {
    panelMap(s).delete(panel.id)
    throw error
  }
  if (!messageId) {
    panelMap(s).delete(panel.id)
    await feishu.sendTextRaw(s.chatId, `❌ ${mode === 'fork' ? 'fk' : 'bk'} 列表发送失败`)
  }
}

export function showForkList(s: Session, userOpenId: string): Promise<void> {
  return showTurnList(s, 'fork', userOpenId)
}

export function showBackList(s: Session, userOpenId: string): Promise<void> {
  return showTurnList(s, 'back', userOpenId)
}

export async function showResumeList(s: Session, userOpenId: string): Promise<void> {
  if (!userOpenId) {
    await feishu.sendText(s.chatId, '❌ 找不到发起人，无法创建安全选择卡。')
    return
  }
  // PHASE4-TRANSITION(T3 删,门控表第 2 处):双后端历史目录接通前保留 Claude 硬门。
  if (s.selectedProvider !== 'claude') {
    await feishu.sendText(
      s.chatId,
      '❌ 历史会话列表仅支持 Claude 后端(transcript 是 Claude 的)。Codex 请直接 rs 恢复上一会话,或发 model 切到 Claude。',
    )
    return
  }
  let history: ConversationSummary[]
  try {
    history = s.selectedProvider === 'codex'
      ? await s.listCodexConversations()
      : listClaudeSessions(s.workDir)
  } catch (error) {
    await feishu.sendTextRaw(s.chatId, `❌ 历史会话读取失败: ${error instanceof Error ? error.message : error}`)
    return
  }
  const choices = new Map<string, TempPanelChoice>()
  const entries = recentHistory(history).map(summary => {
    const choiceId = randomUUID()
    choices.set(choiceId, {
      kind: 'resume',
      launch: { kind: 'fork', source: { provider: summary.provider, sessionId: summary.sessionId, cwd: summary.cwd } },
      sourcePreview: summary.preview,
      sourceTs: summary.ts,
      sourceStatus: summary.status,
    })
    return { choiceId, preview: summary.preview, ts: summary.ts }
  })
  const panel = createPanel(s, 'resume', userOpenId, choices)
  const card = cards.resumeListCard({ projectName: baseSessionName(s), panelId: panel.id, entries })
  let messageId: string | null
  try { messageId = await feishu.sendCard(s.chatId, card) } catch (error) {
    panelMap(s).delete(panel.id)
    throw error
  }
  if (!messageId) {
    panelMap(s).delete(panel.id)
    await feishu.sendTextRaw(s.chatId, '❌ rs 历史列表发送失败')
  }
}

// ── btw / bye ─────────────────────────────────────────────────────────
// PHASE4-TRANSITION(T3 换代):btw 双后端 launch{fresh}+reserveTempChatName、
// bye 先 stop 再解散归 Task 3;此处保持旧体,门控表第 1 处(btw Claude 硬门)随换代删。

export async function runBtwCommand(s: Session, userOpenId: string): Promise<void> {
  if (!userOpenId) { await feishu.sendText(s.chatId, '❌ 找不到发起人,无法建临时群。'); return }
  if (!s.opts.onCreateTempSession) { await feishu.sendText(s.chatId, '❌ 临时群能力未就绪(daemon 未注入回调)。'); return }
  if (s.selectedProvider !== 'claude') {
    await feishu.sendText(s.chatId, '❌ 临时会话/fork/back 暂只支持 Claude 后端(Codex 无 resumeSessionAt 能力)。群里发 model 切到 Claude 再试。')
    return
  }
  const chatName = feishu.tempChatName(projectName(s))
  await feishu.sendText(s.chatId, `🚀 开临时会话 ${chatName}(同目录,自动启动)…`)
  const r = await s.opts.onCreateTempSession({ chatName, userOpenId, inheritModel: inheritSelection(s) })
  if (!r.ok) await feishu.sendText(s.chatId, `❌ 建临时会话失败: ${r.error ?? '未知'}`)
}

export async function runByeCommand(s: Session): Promise<void> {
  if (!feishu.tempProjectName(s.sessionName)) {
    await feishu.sendText(s.chatId, '❌ bye 只能在临时会话群(*开头的群)里用。')
    return
  }
  if (!s.opts.onDisbandTempSession) { await feishu.sendText(s.chatId, '❌ 解散能力未就绪(daemon 未注入回调)。'); return }
  if (s.isRunning()) { await feishu.sendText(s.chatId, '⏳ 当前会话还在跑,先 stop/kill 再 bye。'); return }
  await feishu.sendText(s.chatId, `👋 解散临时会话 ${s.sessionName}…`)
  const r = await s.opts.onDisbandTempSession(s.sessionName)
  if (!r.ok) await feishu.sendText(s.chatId, `❌ 解散失败: ${r.error ?? '未知'}`)
}

// ── Picker actions(claim 校验最前;本地 watchdog/lease 守卫叠加其后) ──

export async function onForkSelect(s: Session, panelId: string, choiceId: string, userOpenId: string): Promise<TempSelectionResult> {
  const claimed = claimPanelChoice(s, 'fork', panelId, choiceId, userOpenId)
  if ('error' in claimed) return { ok: false, message: claimed.error, replaceCard: false }
  const { panel, choice } = claimed
  try {
    if (choice.kind !== 'fork') return { ok: false, message: '选择项类型不匹配' }
    // PHASE4-TRANSITION(T3 删,门控表第 3 处):双后端门控解除前保留 Claude 硬门。
    if (s.selectedProvider !== 'claude') return { ok: false, message: 'fork 暂只支持 Claude 后端，请先在 model 面板切换' }
    if (!s.opts.onCreateTempSession) return { ok: false, message: '临时群能力未就绪' }
    const chatName = reserveTempChatName(panel.baseName)
    log(`session-temp: fork ${s.sessionName} → ${chatName} (${choice.launch.kind})`)
    await feishu.sendText(s.chatId, `🔱 正在分叉到 ${chatName}…`)
    let result
    try {
      result = await s.opts.onCreateTempSession({
        chatName,
        userOpenId,
        workDir: panel.workDir,
        routing: panel.routing,
        launch: choice.launch,
        branchBase: choice.branchBase,
        seedAnchors: choice.seedAnchors,
      })
    } finally {
      releaseTempChatName(chatName)
    }
    if (!result.ok) return { ok: false, message: `分叉失败: ${result.error ?? '未知'}` }
    return { ok: true, message: `已分叉到 ${chatName}；原会话和磁盘文件未回滚` }
  } catch (error) {
    return { ok: false, message: `分叉失败: ${error instanceof Error ? error.message : error}` }
  } finally {
    consumePanel(panel)
  }
}

export async function onBackSelect(s: Session, panelId: string, choiceId: string, userOpenId: string): Promise<TempSelectionResult> {
  const claimed = claimPanelChoice(s, 'back', panelId, choiceId, userOpenId)
  if ('error' in claimed) return { ok: false, message: claimed.error, replaceCard: false }
  const { panel, choice } = claimed
  try {
    if (choice.kind !== 'back') return { ok: false, message: '选择项类型不匹配' }
    // 本地守卫叠加(保护线):claim 通过 ≠ lifecycle 可抢占。watchdog 保留恢复
    // 期拒绝回退——thread 恢复与回滚互斥,零删除。
    if (s.hasPreservedWatchdogRecovery()) {
      await feishu.sendText(s.chatId, '⚠️ thread 自动恢复尚未完成，暂不能回退。请先发送 restart 恢复，或 clear/kill 丢弃。')
      return { ok: false, message: 'thread 自动恢复尚未完成，暂不能回退' }
    }
    const lease = s.beginLifecycle('back')
    // PHASE4-TRANSITION(T3 删,门控表第 4 处):双后端门控解除前保留 Claude 硬门。
    if (s.selectedProvider !== 'claude') return { ok: false, message: 'back 暂只支持 Claude 后端，请先在 model 面板切换' }
    let writeLogWarning = ''
    try {
      const messageId = await feishu.sendCard(s.chatId, cards.writeLogCard({ projectName: panel.baseName, entries: choice.writes }))
      if (!messageId) writeLogWarning = '；文件变更记录卡发送失败'
    } catch (error) {
      writeLogWarning = `；文件变更记录卡发送失败: ${error instanceof Error ? error.message : error}`
    }
    if (!s.ownsLifecycle(lease) || s.hasPreservedWatchdogRecovery()) {
      return { ok: false, message: '回退被更新的会话操作打断，未执行' }
    }
    log(`session-temp: back ${s.sessionName} (${choice.launch.kind}, writes=${choice.writes.length})`)
    const ok = await s.rollbackTo(choice.launch, {
      anchors: choice.seedAnchors,
      base: choice.branchBase,
    }, { lifecycleLease: lease })
    if (!s.ownsLifecycle(lease) || s.hasPreservedWatchdogRecovery()) {
      return { ok: false, message: '回退流程被更新的会话操作接管' }
    }
    if (!ok) return { ok: false, message: `回退失败；原会话绑定未改，请检查日志后重试${writeLogWarning}` }
    if (panel.routing.provider === 'claude') {
      return {
        ok: true,
        message: `本群已准备 Claude 新分支；发送下一条消息时生成并接入，旧会话未删除，磁盘文件未回滚${writeLogWarning}`,
      }
    }
    const thread = s.lastSessionId ? ` ${s.lastSessionId.slice(0, 8)}…` : ''
    return { ok: true, message: `本群已改接新会话${thread}；旧会话未删除，磁盘文件未回滚${writeLogWarning}` }
  } catch (error) {
    return { ok: false, message: `回退失败: ${error instanceof Error ? error.message : error}` }
  } finally {
    consumePanel(panel)
  }
}

export async function onResumeSelect(s: Session, panelId: string, choiceId: string, userOpenId: string): Promise<TempSelectionResult> {
  const claimed = claimPanelChoice(s, 'resume', panelId, choiceId, userOpenId)
  if ('error' in claimed) return { ok: false, message: claimed.error, replaceCard: false }
  const { panel, choice } = claimed
  if (choice.kind !== 'resume') {
    consumePanel(panel)
    throw new Error('resume panel contained a non-resume choice')
  }
  const sourceId = choice.launch.source.sessionId
  const previousSessionId = s.lastSessionId
  const presentation = (
    newSessionId: string | null,
    bindingState: ResumeSelectionPresentation['bindingState'],
  ): ResumeSelectionPresentation => ({
    projectName: panel.baseName,
    provider: choice.launch.source.provider,
    selectedPreview: choice.sourcePreview,
    selectedTs: choice.sourceTs,
    sourceSessionId: sourceId,
    ...(choice.sourceStatus ? { sourceStatus: choice.sourceStatus } : {}),
    previousSessionId,
    newSessionId,
    bindingState,
  })
  const finish = (
    ok: boolean,
    message: string,
    bindingState: ResumeSelectionPresentation['bindingState'],
    newSessionId: string | null = null,
  ): TempSelectionResult => ({
    ok,
    message,
    resumePresentation: presentation(newSessionId, bindingState),
  })
  try {
    // 陷阱 1 选型(上游 isRunning 拒绝不采):本地 claude 进程 turn 间常驻保活,
    // isRunning() 恒 true(d9341b6 适配决策),照抄会让 claude idle 选历史永拒。
    // 维持本地既有语义——rollbackTo 内部 restart 本就作废当前 proc,与上游
    // 「防误杀新进程」出发点不同但一致于本地既有 Claude 行为(保护线)。
    if (choice.sourceStatus === 'active') {
      return finish(false, '所选 Codex 会话仍在运行；请先在原位置停止后再创建完整分支', 'unchanged')
    }
    // 本地守卫叠加(保护线):watchdog 保留恢复期拒绝历史分支,零删除。
    if (s.hasPreservedWatchdogRecovery()) {
      await feishu.sendText(s.chatId, '⚠️ thread 自动恢复尚未完成，暂不能选择历史会话。请先发送 restart 恢复，或 clear/kill 丢弃。')
      return finish(false, 'thread 自动恢复尚未完成，暂不能选择历史会话', 'unchanged')
    }
    const lease = s.beginLifecycle('resume')
    // PHASE4-TRANSITION(T3 删,门控表第 5 处):双后端门控解除前保留 Claude 硬门。
    if (s.selectedProvider !== 'claude') {
      return finish(false, '历史会话恢复只支持 Claude 后端，请先在 model 面板切换', 'unchanged')
    }
    if (!s.ownsLifecycle(lease) || s.hasPreservedWatchdogRecovery()) {
      return finish(false, '历史分支被更新的会话操作打断，未执行', 'unchanged')
    }
    log(`session-temp: history fork ${s.sessionName} ← ${choice.launch.source.provider} ${sourceId.slice(0, 8)}`)
    const ok = await s.rollbackTo(choice.launch, {
      anchors: [],
      base: choice.launch,
      pendingLaunch: choice.launch.source.provider === 'claude'
        ? { launch: choice.launch, previousSessionId }
        : null,
    }, { lifecycleLease: lease })
    if (!s.ownsLifecycle(lease) || s.hasPreservedWatchdogRecovery()) {
      return finish(false, '历史分支流程被更新的会话操作接管', 'unknown')
    }
    if (!ok) return finish(false, '历史分支创建失败；原会话绑定未改，请检查日志后重试', 'unchanged')
    if (choice.launch.source.provider === 'claude') {
      return finish(true, 'Claude 独立分支已准备；首条消息时生成并接入新会话', 'prepared')
    }
    const newSessionId = s.lastSessionId
    if (!newSessionId) {
      return finish(false, '历史分支已启动，但后端没有返回新会话 id', 'unknown')
    }
    if (newSessionId === sourceId || (previousSessionId && newSessionId === previousSessionId)) {
      return finish(false, '后端没有返回独立的新会话 id；为避免误判，本次不标记为恢复成功', 'unknown', newSessionId)
    }
    return finish(true, '已创建并接入独立分支；源会话未修改', 'changed', newSessionId)
  } catch (error) {
    return finish(false, `历史分支创建失败: ${error instanceof Error ? error.message : error}`, 'unknown')
  } finally {
    consumePanel(panel)
  }
}
