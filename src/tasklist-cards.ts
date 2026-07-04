/**
 * 任务清单自动化状态卡的 I/O 生命周期(按活跃波次 · per-project)。
 *
 * 纯累积/渲染在 cards/automation.ts;这里持内存卡句柄、开卡/30s tick 刷新/
 * 沉降,调 feishu + cardkit 写飞书。核心不变式:内存 burst 是唯一真源,所有
 * 卡写都是尽力 reconcile;先改视图、再写卡;开卡未就绪时写卡跳过,靠开卡后
 * 全量重建兜底。所有卡写失败绝不阻塞 tasklist-worker。
 */

import * as cardkit from './cardkit'
import * as cards from './cards'
import * as feishu from './feishu'
import { log } from './log'
import * as tasklist from './tasklist'
import type { AutomationProcessRecord } from './tasklist'

const REFRESH_TICK_MS = 30_000

interface CardHandle {
  chatId: string
  messageId: string
  cardId: string
  /** 已 addElement 过 panel 的 runId(区分 add vs replace)。 */
  addedPanels: Set<string>
  refreshTimer: ReturnType<typeof setInterval> | null
  /** cardkit 写失败(recordCardCreated 回调置)后停止一切刷卡。 */
  cardWriteFailed: boolean
}

interface ProjectCard {
  projectName: string
  burst: cards.AutomationBurst
  handle: CardHandle | null
}

const cardsByProject = new Map<string, ProjectCard>()
const opening = new Set<string>()

function getOrInit(projectName: string): ProjectCard {
  let pc = cardsByProject.get(projectName)
  if (!pc) { pc = { projectName, burst: cards.emptyBurst(), handle: null }; cardsByProject.set(projectName, pc) }
  return pc
}

/** 测试清理:清空内存卡壳 + 停所有 tick timer(仅供 *.test.ts)。 */
export function __resetCardsForTest(): void {
  for (const pc of cardsByProject.values()) if (pc.handle?.refreshTimer) clearInterval(pc.handle.refreshTimer)
  cardsByProject.clear()
  opening.clear()
}

/** §6 chatId 解析(DI 纯):优先 binding.chatId,回退 lookup。lookup 注入以便单测。 */
export function resolveChatId(
  binding: { chatId?: string; projectName: string },
  lookup: (name: string) => string | null,
): string | null {
  return binding.chatId ?? lookup(binding.projectName)
}

/** §6 步骤2 决策(DI 纯):缺 chatId 时返回待落库 chatId,否则 null。 */
export function computeBackfill(
  binding: { chatId?: string; projectName: string } | null,
  lookup: (name: string) => string | null,
): string | null {
  if (!binding || binding.chatId) return null
  return lookup(binding.projectName)
}

/** §6 步骤2:旧 binding 缺 chatId 时 worker 每轮开头调一次,解析成功即持久化。 */
export function backfillChatId(projectName: string): void {
  const chatId = computeBackfill(tasklist.getTasklistBinding(projectName), feishu.chatIdForSession)
  if (!chatId) return
  try {
    tasklist.updateTasklistBinding(projectName, b => { b.chatId = chatId })
    log(`tasklist-cards: backfilled chatId for "${projectName}" → ${chatId}`)
  } catch (e) {
    log(`tasklist-cards: backfill chatId failed for "${projectName}": ${e}`)
  }
}

function taskSummaryFor(projectName: string, taskGuid: string | undefined): string {
  if (!taskGuid) return ''
  return tasklist.getTasklistBinding(projectName)?.tasks?.[taskGuid]?.summary ?? ''
}

// ── worker hook(先改视图,再尽力写卡) ─────────────────────────────────

export function onRunStart(record: AutomationProcessRecord): void {
  if (!cards.isCardedKind(record.kind)) return
  const pc = getOrInit(record.projectName)
  pc.burst = cards.burstAddRun(
    pc.burst, record.runId, record.kind, record.taskGuid,
    taskSummaryFor(record.projectName, record.taskGuid), Date.now(),
  )
  if (pc.handle) { renderRun(pc, record.runId); patchSummary(pc) }
  else if (!opening.has(record.projectName)) void openCard(record.projectName)
  // opening 中:仅落视图,openCard 完成后 reconcileAll 兜底。
}

export function onRunStdout(runId: string, projectName: string, tail: string): void {
  const pc = cardsByProject.get(projectName)
  if (!pc) return
  pc.burst = cards.burstUpdateStdout(pc.burst, runId, tail)
  // 不主动写卡;30s tick 统一重渲染 running panel。
}

export function onRunSettle(record: AutomationProcessRecord): void {
  if (!cards.isCardedKind(record.kind)) return
  const pc = cardsByProject.get(record.projectName)
  if (!pc) return
  const processStatus: 'exited' | 'failed' = record.status === 'exited' ? 'exited' : 'failed'
  pc.burst = cards.burstSettleRun(pc.burst, record.runId, processStatus, record.error, Date.now())
  if (pc.handle) { renderRun(pc, record.runId); patchSummary(pc) }
}

/** worker 每轮扫描末尾调一次:空闲计数 + 达阈值沉降。 */
export function settleIdleProjects(): void {
  for (const pc of [...cardsByProject.values()]) {
    const { burst, shouldSettle } = cards.burstMarkScan(pc.burst)
    pc.burst = burst
    if (!shouldSettle) continue
    if (pc.handle) void settleCard(pc.projectName)
    else cardsByProject.delete(pc.projectName) // 无卡空壳直接清
  }
}

// ── 内部 I/O ──────────────────────────────────────────────────────────

async function openCard(projectName: string): Promise<void> {
  opening.add(projectName)
  try {
    const pc = cardsByProject.get(projectName)
    if (!pc || pc.handle) return
    const binding = tasklist.getTasklistBinding(projectName)
    if (!binding) return
    const chatId = resolveChatId(binding, feishu.chatIdForSession)
    if (!chatId) { log(`tasklist-cards: no chatId for "${projectName}", skip card this burst`); return }
    const messageId = await feishu.sendCard(chatId, cards.automationLiveCard(projectName, pc.burst.runs))
    if (!messageId) { log(`tasklist-cards: sendCard failed for "${projectName}"`); return }
    let cardId: string
    try { cardId = await cardkit.convertMessageToCard(messageId) }
    catch (e) { log(`tasklist-cards: convertMessageToCard failed "${projectName}": ${e}`); return }
    const handle: CardHandle = {
      chatId, messageId, cardId,
      addedPanels: new Set(pc.burst.runs.map(r => r.runId)),
      refreshTimer: null, cardWriteFailed: false,
    }
    cardkit.recordCardCreated(cardId, pc.burst.runs.length, () => { handle.cardWriteFailed = true })
    pc.handle = handle
    // 开卡后全量重建:吸收异步开卡窗口内 settle/stdout 对视图的改动。
    reconcileAll(pc)
    handle.refreshTimer = setInterval(() => tick(projectName), REFRESH_TICK_MS)
  } catch (e) {
    log(`tasklist-cards: openCard error "${projectName}": ${e}`)
  } finally {
    opening.delete(projectName)
  }
}

/** 30s tick:只重渲染仍 running 的 panel(刷时长/tail)+ 刷 summary。 */
function tick(projectName: string): void {
  const pc = cardsByProject.get(projectName)
  if (!pc || !pc.handle || pc.handle.cardWriteFailed) return
  const now = Date.now()
  for (const run of pc.burst.runs) if (run.status === 'running') renderRun(pc, run.runId, now)
  patchSummary(pc)
}

/** 单 run 渲染:未加过 panel → addElement;加过 → replaceElement。cardkit 内部
 *  队列化 + 失败经 recordCardCreated 回调置 cardWriteFailed,故此处 void 即可。 */
function renderRun(pc: ProjectCard, runId: string, now: number = Date.now()): void {
  const handle = pc.handle
  if (!handle || handle.cardWriteFailed) return
  const run = pc.burst.runs.find(r => r.runId === runId)
  if (!run) return
  const panel = cards.automationRunPanel(run, now)
  if (handle.addedPanels.has(runId)) {
    void cardkit.replaceElement(handle.cardId, cards.AUTO_ELEMENTS.panel(runId), panel)
  } else {
    handle.addedPanels.add(runId)
    void cardkit.addElement(handle.cardId, panel)
  }
}

function reconcileAll(pc: ProjectCard): void {
  const now = Date.now()
  for (const run of pc.burst.runs) renderRun(pc, run.runId, now)
  patchSummary(pc)
}

function patchSummary(pc: ProjectCard): void {
  if (!pc.handle || pc.handle.cardWriteFailed) return
  cardkit.patchSummaryThrottled(pc.handle.cardId, `🧭 ${pc.projectName} 自动化 · ${cards.summarizeAutomation(pc.burst.runs)}`)
}

async function settleCard(projectName: string): Promise<void> {
  const pc = cardsByProject.get(projectName)
  cardsByProject.delete(projectName)
  if (!pc || !pc.handle) return
  if (pc.handle.refreshTimer) clearInterval(pc.handle.refreshTimer)
  try {
    await feishu.updateCard(pc.handle.messageId, cards.automationHistoryCard(projectName, pc.burst.runs))
  } catch (e) {
    log(`tasklist-cards: settleCard updateCard failed "${projectName}": ${e}`)
  }
}
