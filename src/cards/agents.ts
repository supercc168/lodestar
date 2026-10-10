/**
 * Delegated-agent cards: identity directory + standalone run card (local layout)
 * ∪ shared-task-card row elements (upstream v0.20.x agent-cards flow).
 *
 * 合并要点:
 * - agentRunCard / agentWorkerElement / agentRunFooterElement / agentRunSummary
 *   维持本地语义(任务卡标题按 parentKind 区分并给出 worker 数、worker 折叠面板、
 *   取消委派按钮、本地状态/耗时文案),本地测试与 agent-service 刷 footer 依赖它们。
 * - 上游增量 agentRunElement / agentRunElementId / agentCardSummary /
 *   delegationCardSummary 原样纳入(agent-cards.ts 共享任务卡按行 patch 它们);
 *   agentRunElement 内部使用上游口径的私有 helper(状态词带任务 kind、
 *   耗时 formatDuration、结果 boundedResultContent、任务内容 compactTaskContent),
 *   不复用本地导出的同名函数,避免两套文案互相污染。
 * - identityRow 维持本地文案(ready / · default)。
 */
import { createHash } from 'node:crypto'
import type { AgentIdentity, AgentSourceFailure } from '../agent-identities'
import type { AgentRunSnapshot, AgentWorkerResult } from '../agent-run-types'
import { ELEMENTS, sanitizeMarkdownForCardKit } from './elements'
import { formatDuration } from './duration'
import {
  AGENT_CARD_TASK_KIND_ORDER,
  agentCardTaskKindIcon,
  agentCardTaskKindLabel,
  type AgentCardTaskKind,
} from './task-kind'
import { boundedResultContent, compactTaskContent } from './task-content'

export type { AgentCardTaskKind } from './task-kind'

const PROMPT_PREVIEW_CHARS = 10_000
const WORKER_TOTAL_PREVIEW_CHARS = 48_000
const WORKER_MAX_PREVIEW_CHARS = 8_000
const WORKER_MIN_PREVIEW_CHARS = 512

export interface AgentIdentityListCardOpts {
  panelId: string
  page: number
  totalPages: number
  catalog: AgentIdentity[]
  failures: AgentSourceFailure[]
}

export function agentIdentityListCard(opts: AgentIdentityListCardOpts): object {
  const elements: object[] = [{
    tag: 'markdown',
    element_id: ELEMENTS.agentIdentityPanel,
    content: [
      '**全局 Agent 身份**',
      // 本地目录语义(只读、不在此开跑)∪ 上游措辞(主 Agent 统一分配和汇总),
      // 两版测试的断言各取其可共存部分。
      '列出本机已配置的固定档位（一档一位）。目录只读，不能在此开跑；委派由主 Agent 统一分配和汇总（lodestar-agent）。',
      `目录第 ${opts.page + 1}/${opts.totalPages} 页`,
    ].join('\n'),
  }]
  if (opts.failures.length) {
    elements.push({
      tag: 'collapsible_panel',
      header: { title: { tag: 'plain_text', content: `MISS · ${opts.failures.length} 个账号` } },
      expanded: false,
      elements: [{
        tag: 'markdown',
        content: opts.failures.map(failure => `- **${escapeMarkdown(failure.display)}**：${escapeMarkdown(failure.reason)}`).join('\n'),
      }],
    })
  }
  elements.push(...opts.catalog.map(identityRow), pager(opts))
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: '🧠 agents' }, template: 'purple' },
    body: { elements },
  }
}

export function agentRunCard(run: AgentRunSnapshot): object {
  const previewChars = agentWorkerPreviewChars(run.workers.length)
  const elements: object[] = [
    {
      tag: 'collapsible_panel',
      header: { title: { tag: 'plain_text', content: run.parentKind === 'follow_up' ? '续跑 prompt' : '任务 prompt' } },
      expanded: false,
      elements: [{ tag: 'markdown', content: promptPreview(run.prompt) }],
    },
    ...run.workers.map(worker => agentWorkerElement(worker, previewChars, run.workers.length === 1)),
    agentRunFooterElement(run),
  ]
  if (!isTerminal(run.status)) elements.push(agentRunCancelElement(run.runId))
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      streaming_mode: !isTerminal(run.status),
      summary: { content: agentRunSummary(run) },
    },
    header: {
      // 标题按 parentKind 区分任务类型并直接给出 worker 数:内部调度层级不再
      // 出现在面向用户的标题里(快照字段本身保留,不删数据结构)。
      title: {
        tag: 'plain_text',
        content: `🧠 ${run.parentKind === 'follow_up' ? '继续委派任务' : '委派任务'} · ${run.workers.length} 位 Agent`,
      },
      template: run.status === 'failed' ? 'red' : run.status === 'completed' ? 'green' : run.status === 'needs_input' ? 'orange' : 'purple',
    },
    body: { elements },
  }
}

/** One visible line per invocation. Everything else stays inside this panel. */
export function agentRunElement(run: AgentRunSnapshot): object {
  const project = run.owner?.kind === 'project'
  return {
    tag: 'collapsible_panel',
    element_id: agentRunElementId(run.runId),
    header: { title: { tag: 'plain_text', content: elementSummary(run) } },
    expanded: false,
    elements: [{
      tag: 'markdown',
      content: [
        `**${escapeMarkdown(run.description ?? '说明 MISS')}**`,
        ...(project ? [`项目 ${inlineCode(run.owner!.name)} · ${inlineCode(run.runId)}`] : []),
        elementFooterContent(run),
        `**任务说明**\n${sanitizeMarkdownForCardKit(compactTaskContent(run.prompt))}`,
        ...run.workers.map(worker => inlineWorkerContent(worker, WORKER_MAX_PREVIEW_CHARS, project)),
      ].join('\n\n'),
    }, ...(project && !isTerminal(run.status) ? [{
      tag: 'button', text: { tag: 'plain_text', content: '停止本次任务' }, type: 'danger',
      behaviors: [{ type: 'callback', value: { kind: 'agent_project_cancel', run_id: run.runId } }],
    }] : [])],
  }
}

export function agentRunElementId(runId: string): string {
  return `ar_${createHash('sha256').update(runId).digest('hex').slice(0, 16)}`
}

export function agentCardSummary(runs: AgentRunSnapshot[]): string {
  return delegationCardSummary(runs.map(run => ({
    summary: elementSummary(run), status: run.status, terminal: isTerminal(run.status), kind: 'delegated',
  })))
}

export function delegationCardSummary(tasks: Array<{
  summary: string
  status: string
  terminal: boolean
  kind?: AgentCardTaskKind
}>): string {
  if (tasks.length === 1) return tasks[0]!.summary
  const done = tasks.filter(task => task.terminal).length
  const failed = tasks.filter(task => task.status === 'failed').length
  const waiting = tasks.filter(task => task.status === 'needs_input' || task.status === 'paused').length
  const kinds = new Set(tasks.map(task => task.kind ?? 'delegated'))
  const kindList = AGENT_CARD_TASK_KIND_ORDER.filter(kind => kinds.has(kind))
  const category = kindList.length === 1
    ? `${agentCardTaskKindIcon(kindList[0]!)} ${agentCardTaskKindLabel(kindList[0]!)}`
    : `🧩 运行任务 · ${kindList.map(kind => `${agentCardTaskKindLabel(kind)} ${tasks.filter(task => (task.kind ?? 'delegated') === kind).length}`).join(' · ')}`
  return `${category} · 已结束 ${done}/${tasks.length}${failed ? ` · 失败 ${failed}` : ''}${waiting ? ` · 待处理 ${waiting}` : ''}`
}

export function agentWorkerElement(
  worker: AgentWorkerResult,
  outputPreviewChars = WORKER_MAX_PREVIEW_CHARS,
  expandResult = false,
): object {
  const status = workerStatusLabel(worker)
  const body: string[] = [`**${escapeMarkdown(status)}**`]
  if (worker.durationMs != null) body.push(`用时 ${durationLabel(worker.durationMs)}`)
  if (worker.status === 'queued' && worker.queuedReason) body.push('', escapeMarkdown(worker.queuedReason))
  if (worker.pendingInput) {
    body.push('', '**等待主 Agent 回答**')
    for (const question of worker.pendingInput.questions) {
      body.push(`- ${escapeMarkdown(question.question)}`)
      if (question.options.length) body.push(`  选项：${question.options.map(option => inlineCode(option.label)).join(' / ')}`)
    }
    body.push(`request: ${inlineCode(worker.pendingInput.requestId)}`)
  }
  // 失败与取消都要给出"为什么停"以及"停之前生成了什么":先原因、后内容,
  // 保证 worker 失败不再吞掉已完成的正文。
  if (worker.error) {
    body.push('', worker.status === 'cancelled' ? '**停止原因**' : '**失败原因**', sanitizeMarkdownForCardKit(worker.error))
  }
  if (worker.output) {
    body.push(
      '',
      worker.status === 'failed' || worker.status === 'cancelled' ? '**已生成的内容**' : '**结果**',
      truncate(sanitizeMarkdownForCardKit(worker.output), outputPreviewChars),
    )
  }
  if (!worker.output && !worker.error && !worker.pendingInput) {
    body.push('', worker.status === 'completed' ? '_Agent 已完成，没有正文输出。_' : '_等待结果…_')
  }
  if (worker.steps.length) {
    body.push('', '**最近动作**')
    for (const step of worker.steps.slice(-8)) {
      const icon = step.phase === 'completed' ? '✓' : step.phase === 'started' ? '→' : '·'
      body.push(`- ${icon} ${inlineCode(step.tool)} ${escapeMarkdown(shortText(step.detail, 180))}`)
    }
  }
  body.push('', `${inlineCode(worker.tokenSourceId)} · ${inlineCode(worker.model)} · ${inlineCode(worker.effort)}`)
  if (worker.sessionId) body.push(`session: ${inlineCode(worker.sessionId)}`)
  return {
    tag: 'collapsible_panel',
    element_id: agentWorkerElementId(worker.identityId),
    header: { title: { tag: 'plain_text', content: `${status} · ${shortText(worker.identityName, 48)}` } },
    // 单 worker 且已完成且有正文时默认展开(结果就是这张卡的正文);多 worker
    // 保持折叠,避免一次性铺开所有结果。
    expanded: worker.status === 'failed'
      || worker.status === 'needs_input'
      || (expandResult && worker.status === 'completed' && !!worker.output),
    elements: [{ tag: 'markdown', content: body.join('\n') }],
  }
}

export function agentRunFooterElement(run: AgentRunSnapshot): object {
  const completed = run.workers.filter(item => item.status === 'completed').length
  const failed = run.workers.filter(item => item.status === 'failed').length
  const waiting = run.workers.filter(item => item.status === 'needs_input').length
  const running = run.workers.filter(item => item.status === 'running').length
  const queued = run.workers.filter(item => item.status === 'queued').length
  const cancelled = run.workers.filter(item => item.status === 'cancelled').length
  const counts = [
    running ? `执行中 ${running}` : '',
    queued ? `排队 ${queued}` : '',
    waiting ? `待答 ${waiting}` : '',
    failed ? `失败 ${failed}` : '',
    cancelled ? `已取消 ${cancelled}` : '',
  ].filter(Boolean)
  const duration = run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.createdAt) : null
  const lines = [
    `**${runStatusLabel(run)}** · 完成 ${completed}/${run.workers.length}`,
    ...(counts.length ? [counts.join(' · ')] : []),
    ...(duration != null && Number.isFinite(duration) ? [`⏱ 用时 ${durationLabel(duration)}`] : []),
    ...(run.error ? [escapeMarkdown(run.error)] : []),
  ]
  return {
    tag: 'markdown',
    element_id: ELEMENTS.agentRunFooter,
    content: lines.join('\n'),
  }
}

export function agentWorkerElementId(identityId: string): string {
  return `aw_${createHash('sha256').update(identityId).digest('hex').slice(0, 16)}`
}

export function agentWorkerPreviewChars(workerCount: number): number {
  // Keep the shared-card budget bounded when several workers finish together.
  const count = Math.max(1, Math.floor(workerCount))
  return Math.min(WORKER_MAX_PREVIEW_CHARS, Math.max(WORKER_MIN_PREVIEW_CHARS, Math.floor(WORKER_TOTAL_PREVIEW_CHARS / count)))
}

export function agentRunSummary(run: AgentRunSnapshot): string {
  const done = run.workers.filter(item => item.status === 'completed').length
  return `${runStatusLabel(run)} · ${done}/${run.workers.length}`
}

function identityRow(identity: AgentIdentity): object {
  const ready = identity.status === 'ready'
  const detail = ready ? 'ready' : `${identity.status}: ${identity.reason ?? 'MISS'}`
  return {
    tag: 'markdown',
    content: [
      `**${escapeMarkdown(identity.displayName)}** ${identity.sourceDefault ? '· default' : ''}`,
      `${inlineCode(identity.id)}\n${inlineCode(identity.model)} · 默认 ${inlineCode(identity.defaultEffort ?? 'MISS')} · ${escapeMarkdown(detail)}`,
    ].join('\n'),
  }
}

function pager(opts: AgentIdentityListCardOpts): object {
  return {
    tag: 'column_set',
    columns: [
      buttonColumn('上一页', { kind: 'agent_identity_page', panel_id: opts.panelId, page: Math.max(0, opts.page - 1) }),
      buttonColumn('刷新', { kind: 'agent_identity_page', panel_id: opts.panelId, page: opts.page }),
      buttonColumn('下一页', { kind: 'agent_identity_page', panel_id: opts.panelId, page: Math.min(opts.totalPages - 1, opts.page + 1) }),
    ],
  }
}

function agentRunCancelElement(runId: string): object {
  return {
    tag: 'column_set',
    columns: [
      buttonColumn('取消委派', { kind: 'agent_run_cancel', run_id: runId }, 'danger'),
    ],
  }
}

function buttonColumn(text: string, value: Record<string, unknown>, type = 'default'): object {
  return {
    tag: 'column', width: 'weighted', weight: 1,
    elements: [{
      tag: 'button',
      text: { tag: 'plain_text', content: text },
      type,
      behaviors: [{ type: 'callback', value }],
    }],
  }
}

function workerStatusLabel(worker: AgentWorkerResult): string {
  switch (worker.status) {
    case 'completed': return '✅ 完成'
    case 'failed': return '❌ 失败'
    case 'cancelled': return '🛑 取消'
    case 'needs_input': return '❓ 等待输入'
    case 'running': return '⏳ 运行中'
    default: return '⏳ 排队中'
  }
}

function isTerminal(status: AgentRunSnapshot['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

/** 面向用户的运行状态文案(标题摘要/页脚共用)。running 且全部 worker 已终结
 *  时是"正在收尾":子任务都停了,run 还在落盘/收尾。 */
function runStatusLabel(run: AgentRunSnapshot): string {
  switch (run.status) {
    case 'completed': return '✅ 委派完成'
    case 'failed': return '❌ 委派失败'
    case 'cancelled': return '🛑 委派已取消'
    case 'needs_input': return '❓ 等待主 Agent 回复'
    case 'queued': return '⏳ 等待执行'
    case 'running': return run.workers.length > 0 && run.workers.every(worker => isTerminal(worker.status))
      ? '⏳ 正在收尾' : '⏳ 正在执行'
  }
}

/** 上游口径的运行状态词(带任务 kind),仅共享任务卡行(agentRunElement)使用。 */
function elementStatusLabel(run: AgentRunSnapshot): string {
  const kindLabel = agentCardTaskKindLabel(run.owner?.kind === 'project' ? 'project' : 'delegated')
  switch (run.status) {
    case 'completed': return `✅ ${kindLabel}完成`
    case 'failed': return `❌ ${kindLabel}失败`
    case 'cancelled': return `🛑 ${kindLabel}已取消`
    case 'needs_input': return run.owner?.kind === 'project' ? '❗ 项目任务不支持交互提问' : `❓ ${kindLabel}等待主 Agent 回复`
    case 'queued': return `⏳ ${kindLabel}等待执行`
    case 'running': return run.workers.length > 0 && run.workers.every(worker => isTerminal(worker.status))
      ? `⏳ ${kindLabel}正在收尾` : `⏳ ${kindLabel}正在执行`
  }
}

/** 共享任务卡行的折叠标题(上游口径:描述 + 多 worker 时补 done/total)。 */
function elementSummary(run: AgentRunSnapshot): string {
  const done = run.workers.filter(item => item.status === 'completed').length
  return `${elementStatusLabel(run)} · ${shortText(run.description ?? '说明 MISS', 40)}${run.workers.length > 1 ? ` · ${done}/${run.workers.length}` : ''}`
}

/** 共享任务卡行内嵌的页脚行(上游口径:kind 状态词 + formatDuration)。 */
function elementFooterContent(run: AgentRunSnapshot): string {
  const completed = run.workers.filter(item => item.status === 'completed').length
  const failed = run.workers.filter(item => item.status === 'failed').length
  const waiting = run.workers.filter(item => item.status === 'needs_input').length
  const running = run.workers.filter(item => item.status === 'running').length
  const queued = run.workers.filter(item => item.status === 'queued').length
  const cancelled = run.workers.filter(item => item.status === 'cancelled').length
  const counts = [
    running ? `执行中 ${running}` : '',
    queued ? `排队 ${queued}` : '',
    waiting ? `待答 ${waiting}` : '',
    failed ? `失败 ${failed}` : '',
    cancelled ? `已取消 ${cancelled}` : '',
  ].filter(Boolean)
  const duration = run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.createdAt) : null
  return [
    `**${elementStatusLabel(run)}** · 完成 ${completed}/${run.workers.length}`,
    ...(counts.length ? [counts.join(' · ')] : []),
    ...(duration != null && Number.isFinite(duration) ? [`⏱ 用时 ${formatDuration(duration / 1000)}`] : []),
    ...(run.error ? [escapeMarkdown(run.error)] : []),
  ].join('\n')
}

/** 共享任务卡行内联的单个 worker 正文(上游口径:模型行 + bounded 结果 + 3 条最近动作)。 */
function inlineWorkerContent(worker: AgentWorkerResult, outputPreviewChars: number, project: boolean): string {
  const status = workerStatusLabel(worker)
  const body: string[] = [`模型 ${inlineCode(worker.model)} · 推理 ${inlineCode(worker.effort)}`]
  if (worker.durationMs != null) body.push(`用时 ${formatDuration(worker.durationMs / 1000)}`)
  if (worker.status === 'queued' && worker.queuedReason) body.push('', escapeMarkdown(worker.queuedReason))
  if (worker.pendingInput) {
    body.push('', project ? '**项目任务不支持交互提问**' : '**等待主 Agent 回答**')
    for (const question of worker.pendingInput.questions) {
      body.push(`- ${escapeMarkdown(question.question)}`)
      if (question.options.length) body.push(`  选项：${question.options.map(option => inlineCode(option.label)).join(' / ')}`)
    }
  }
  if (worker.error) body.push('', worker.status === 'cancelled' ? '**停止原因**' : '**失败原因**', sanitizeMarkdownForCardKit(worker.error))
  if (worker.output) body.push('', worker.status === 'failed' || worker.status === 'cancelled' ? '**已生成的内容**' : '**结果**', sanitizeMarkdownForCardKit(boundedResultContent(worker.output, outputPreviewChars)))
  if (!worker.output && !worker.error && !worker.pendingInput) {
    body.push('', worker.status === 'completed'
      ? '_任务已完成，没有正文输出。_'
      : worker.status === 'cancelled'
        ? '_任务已取消。_'
        : worker.status === 'queued' ? '_等待开始执行。_' : '_正在执行任务，结果会显示在这里。_')
  }
  if (worker.steps.length) {
    body.push('', '**最近动作**')
    for (const step of worker.steps.slice(-3)) {
      const icon = step.tool === 'tool error' ? '❌' : step.phase === 'completed' ? '✓' : step.phase === 'started' ? '→' : '·'
      const label = step.tool === 'tool error' ? '工具执行失败' : step.tool === 'tool result' ? '工具执行完成' : step.tool
      body.push(`- ${icon} ${inlineCode(label)} ${escapeMarkdown(shortText(step.detail, 180))}`)
    }
  }
  return [`**${status} · ${escapeMarkdown(worker.identityName)}**`, ...body].join('\n')
}

function durationLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

function promptPreview(value: string): string {
  const sanitized = sanitizeMarkdownForCardKit(value)
  if (sanitized.length <= PROMPT_PREVIEW_CHARS) return sanitized
  const receipt = '_卡片 prompt 预览已截断；完整 prompt 已原样交给 Agent 并持久化。_'
  return `${sanitized.slice(0, PROMPT_PREVIEW_CHARS - receipt.length - 2)}\n\n${receipt}`
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  const receipt = '_卡片输出已截断，完整结果由 CLI/API 返回。_'
  return `${value.slice(0, Math.max(0, max - receipt.length - 2))}\n\n${receipt}`
}

function inlineCode(value: string): string {
  return '`' + value.replace(/`/g, '\\`') + '`'
}

function escapeMarkdown(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function shortText(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
