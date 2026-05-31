/**
 * Schema 2.0 turn-card templates: the main streaming card, the per-tool
 * collapsible panels, and the AskUserQuestion interactive panel. All
 * rendering for "the in-flight conversation card" lives here. Console
 * UI lives in console.ts; the shared element-id convention is in
 * elements.ts.
 */

import { isAbsolute, relative } from 'node:path'
import { ELEMENTS } from './elements'

export interface TurnPlanStep {
  step: string
  status: 'pending' | 'inProgress' | 'completed' | string
}

export interface ThreadGoal {
  objective: string
  status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete' | string
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
}

function planStatusIcon(s: string): string {
  switch (s) {
    case 'pending':     return '☐'
    case 'inProgress':  return '🔄'
    case 'completed':   return '✅'
    default:            return '·'
  }
}

function goalStatusLabel(s: string): string {
  switch (s) {
    case 'active':       return '进行中'
    case 'paused':       return '已暂停'
    case 'blocked':      return '受阻'
    case 'usageLimited': return '额度受限'
    case 'budgetLimited': return '预算受限'
    case 'complete':     return '已完成'
    default:             return s
  }
}

function formatGoalTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'MISS'
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const min = minutes % 60
  return min ? `${hours}h ${min}m` : `${hours}h`
}

function renderPlanContent(plan: TurnPlanStep[], explanation?: string | null, draftText = ''): string {
  const lines = ['**📋 当前计划**']
  const cleanExplanation = explanation?.trim()
  if (cleanExplanation) {
    lines.push('')
    lines.push(cleanExplanation)
  }
  if (plan.length > 0) {
    lines.push('')
    for (const item of plan) {
      lines.push(`- ${planStatusIcon(item.status)} ${item.step}`)
    }
  } else {
    const draft = draftText.trim()
    lines.push('')
    if (draft) {
      lines.push('正在生成计划草稿...')
      lines.push('')
      lines.push(draft)
    } else {
      lines.push('--')
    }
  }
  return lines.join('\n')
}

export function planElement(
  plan: TurnPlanStep[],
  explanation?: string | null,
  draftText = '',
  elementId = '',
): object {
  return {
    tag: 'markdown',
    element_id: elementId,
    content: renderPlanContent(plan, explanation, draftText),
  }
}

export function goalElement(goal: ThreadGoal, elementId = ''): object {
  const tokensUsed = Number.isFinite(goal.tokensUsed) ? String(goal.tokensUsed) : 'MISS'
  const tokenBudget = goal.tokenBudget == null
    ? ''
    : Number.isFinite(goal.tokenBudget)
      ? ` / ${goal.tokenBudget}`
      : ' / MISS'
  const lines = [
    `**🎯 当前目标** · ${goalStatusLabel(goal.status)}`,
    '',
    goal.objective,
    '',
    `- 用量: ${tokensUsed}${tokenBudget} tokens`,
    `- 用时: ${formatGoalTime(goal.timeUsedSeconds)}`,
  ]
  return {
    tag: 'markdown',
    element_id: elementId,
    content: lines.join('\n'),
  }
}

function isBashCommandTool(name: string): boolean {
  return name === 'Bash' || name === 'exec_command' || name.endsWith('.exec_command')
}

function isShellSessionTool(name: string): boolean {
  return name === 'write_stdin' || name.endsWith('.write_stdin')
}

function isBashTool(name: string): boolean {
  return isBashCommandTool(name) || isShellSessionTool(name)
}

function isFileChangeTool(name: string): boolean {
  return name === 'FileChange' || name === 'fileChange'
}

function isWebSearchTool(name: string): boolean {
  return name === 'WebSearch' || name === 'webSearch'
}

function isMcpTool(name: string): boolean {
  return name === 'MCP'
}

function isImageGenerationTool(name: string): boolean {
  return name === 'ImageGeneration' || name === 'imageGeneration'
}

function isAgentTool(name: string): boolean {
  return name === 'Agent'
}

function displayToolName(name: string): string {
  if (isFileChangeTool(name)) return '文件变更'
  if (isWebSearchTool(name)) return '网页搜索'
  if (isImageGenerationTool(name)) return '图片生成'
  return isBashTool(name) ? 'Bash' : name
}

/** Single-line summary used as a collapsible-panel header for a tool call. */
export function summarizeToolInput(name: string, input: any): string {
  if (!input || typeof input !== 'object') return ''
  const truncate = (s: string, n: number) => s.length > n ? s.slice(0, n) + '…' : s
  if (isBashCommandTool(name)) return summarizeBashInput(input)
  if (isShellSessionTool(name)) return summarizeShellSessionInput(input)
  if (isFileChangeTool(name)) return truncate(summarizeFileChangeInput(input), 80)
  if (isWebSearchTool(name)) return truncate(summarizeWebSearchInput(input), 80)
  if (isMcpTool(name)) return truncate(summarizeMcpInput(input), 80)
  if (isImageGenerationTool(name)) return truncate(summarizeImageGenerationInput(input), 80)
  if (isAgentTool(name)) return truncate(summarizeAgentInput(input), 80)
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit': return truncate(String(input.file_path ?? ''), 80)
    case 'Glob':       return truncate(String(input.pattern ?? ''), 80)
    case 'Grep':       return truncate(`${input.pattern ?? ''}${input.path ? ' in ' + input.path : ''}`, 80)
    case 'WebFetch':
    case 'WebSearch': return truncate(String(input.url ?? input.query ?? ''), 80)
    case 'Agent':
    case 'Task':       return truncate(String(input.description ?? input.subject ?? ''), 80)
    case 'Skill':      return truncate(String(input.skill ?? ''), 80)
  }
  // generic fallback: first string-valued field
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v) return truncate(v, 80)
  }
  return ''
}

function summarizeBashInput(input: any): string {
  const truncate = (s: string, n: number) => s.length > n ? s.slice(0, n) + '…' : s
  const info = bashPresentation(input)
  if (info.description) return truncate(info.description.replace(/\s+/g, ' '), 80)
  const command = info.command
  if (!command) return ''
  const oneLine = command.replace(/\s+/g, ' ')
  const lines = command.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines.length <= 1) return truncate(oneLine, 80)
  const firstMeaningful = lines.find(line =>
    !line.startsWith('#') &&
    !/^set\s+-/.test(line) &&
    !/^cd\s+/.test(line) &&
    !/^[A-Za-z_][A-Za-z0-9_]*=/.test(line) &&
    !/^cat\s+<<['"]?\w+['"]?/.test(line)
  ) ?? lines[0]
  return `Shell 脚本 · ${lines.length} 行 · ${truncate(firstMeaningful, 46)}`
}

function shellSessionAction(input: any): string {
  const chars = typeof input?.chars === 'string' ? input.chars : ''
  if (chars === '') return '读取会话输出'
  if (chars === '\u0003') return '中断会话'
  return '发送输入'
}

function summarizeShellSessionInput(input: any): string {
  const session = input?.session_id ?? input?.sessionId
  const suffix = session === undefined ? '' : ` ${session}`
  return `${shellSessionAction(input)}${suffix}`
}

function bashPresentation(input: any): { description: string; command: string } {
  const rawCommand = unwrapShellCommand(String(input?.command ?? input?.cmd ?? input?.script ?? ''))
  const firstLine = rawCommand.split('\n', 1)[0]?.trim() ?? ''
  const comment = firstLine.startsWith('#') && !firstLine.startsWith('#!')
    ? firstLine.replace(/^#\s*/, '').trim()
    : ''
  const commentDesc = comment.replace(/^(?:desc|dec|description|说明|目的|用途)\s*[:：]\s*/i, '').trim()
  const command = commentDesc
    ? rawCommand.split('\n').slice(1).join('\n').trimStart()
    : rawCommand
  const explicit = String(input?.description ?? input?.reason ?? '').trim()
  return { description: commentDesc || explicit, command: command || rawCommand }
}

function unwrapShellCommand(command: string): string {
  const normalized = command.replace(/\r\n/g, '\n').trim()
  const shell = normalized.match(/^(?:\/usr\/bin\/env\s+)?(?:\/[\w./-]+\/)?(?:ba|z|fi)?sh\s+-[A-Za-z]*c[A-Za-z]*\s+([\s\S]+)$/)
  if (!shell) return unwrapQuotedDescCommand(normalized)
  const inner = stripShellArgQuotes(shell[1])
  return unwrapQuotedDescCommand(inner || normalized)
}

function stripShellArgQuotes(arg: string): string {
  const s = arg.trim()
  if (s.length < 2) return s
  const pairs: Record<string, string> = { '"': '"', "'": "'", '“': '”' }
  const close = pairs[s[0]]
  if (!close || !s.endsWith(close)) return s
  const body = s.slice(1, -1)
  if (s[0] === "'") return body.replace(/'\\''/g, "'")
  return body.replace(/\\(["\\$`])/g, '$1').replace(/\\n/g, '\n')
}

function unwrapQuotedDescCommand(command: string): string {
  const s = command.trim()
  const quote = s[0]
  if (quote !== '"' && quote !== "'" && quote !== '“') return s
  const body = s.slice(1)
  if (!/^#\s*(?:desc|dec|description|说明|目的|用途)\s*[:：]/i.test(body)) return s
  if (quote !== '"') return body
  return body
    .replace(/\\(["\\$`])/g, '$1')
    .replace(/\\n/g, '\n')
    .replace(/\s*"\s*'\$\(([^)]*)\)'/g, (_m, inner) => ` $(${inner})`)
}

function fenceBlock(text: string, lang = ''): string {
  let fence = '```'
  while (text.includes(fence)) fence += '`'
  return `${fence}${lang}\n${text}\n${fence}`
}

function inlineCode(v: unknown): string {
  return '`' + String(v ?? '').replace(/`/g, "'") + '`'
}

function jsonBlock(value: unknown, max = 3000): string {
  return fenceBlock(JSON.stringify(value ?? null, null, 2).slice(0, max), 'json')
}

function firstStringField(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const obj = value as Record<string, unknown>
  for (const key of ['query', 'prompt', 'path', 'file_path', 'url', 'name', 'id']) {
    const v = obj[key]
    if (typeof v === 'string' && v.length > 0) return v
  }
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.length > 0) return v
  }
  return ''
}

function renderBashBody(input: any, output: string | null, resolvedNote?: string): string {
  const info = bashPresentation(input)
  const command = info.command
  const reason = info.description
  const lines: string[] = []
  if (reason) lines.push(`**目的**: ${reason}`)
  const cwd = input?.cwd ?? input?.workdir
  if (cwd) lines.push(`**cwd**: ${inlineCode(cwd)}`)
  if (input?.source) lines.push(`**source**: ${inlineCode(input.source)}`)
  if (lines.length > 0) lines.push('')
  lines.push('**命令**')
  lines.push(fenceBlock(command || '(空命令)', 'bash'))
  if (resolvedNote) {
    lines.push('')
    lines.push(resolvedNote)
  }
  if (output != null) {
    lines.push('')
    lines.push('---')
    lines.push('**output:**')
    lines.push(fenceBlock(output.slice(0, 3000)))
  }
  return lines.join('\n')
}

function renderShellSessionBody(input: any, output: string | null, resolvedNote?: string): string {
  const lines: string[] = []
  const session = input?.session_id ?? input?.sessionId
  lines.push(`**操作**: ${shellSessionAction(input)}`)
  if (session !== undefined) lines.push(`**session**: ${inlineCode(session)}`)
  if (typeof input?.chars === 'string' && input.chars.length > 0) {
    const shown = input.chars === '\u0003' ? '^C' : input.chars
    lines.push('')
    lines.push('**输入**')
    lines.push(fenceBlock(shown))
  }
  if (resolvedNote) {
    lines.push('')
    lines.push(resolvedNote)
  }
  if (output != null) {
    lines.push('')
    lines.push('---')
    lines.push('**output:**')
    lines.push(fenceBlock(output.slice(0, 3000)))
  }
  return lines.join('\n')
}

function fileChangeEntries(input: any): any[] {
  return Array.isArray(input?.changes) ? input.changes : []
}

function fileChangeRoot(input: any): string | undefined {
  const root = input?.cwd ?? input?.grantRoot
  return typeof root === 'string' && root.length > 0 ? root : undefined
}

function compactFilePath(path: unknown, root?: string): string {
  const raw = String(path ?? '')
  if (!raw) return '(无 path)'
  if (root && isAbsolute(raw) && isAbsolute(root)) {
    const rel = relative(root, raw)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel
  }
  return raw
}

function fileChangeKind(change: any): string {
  const kind = change?.kind
  if (typeof kind === 'string') return kind.toLowerCase()
  if (typeof kind?.type === 'string') return kind.type.toLowerCase()
  if (typeof change?.type === 'string') return change.type.toLowerCase()
  return ''
}

function fileChangeMovePath(change: any): unknown {
  return change?.kind?.move_path ?? change?.kind?.movePath ?? change?.move_path ?? change?.movePath
}

function fileChangeLabel(change: any): string {
  const kind = fileChangeKind(change)
  const moved = fileChangeMovePath(change)
  if (moved) return kind === 'update' ? '移动/修改' : '移动'
  switch (kind) {
    case 'add': return '新增'
    case 'delete': return '删除'
    case 'update': return '修改'
    default: return '变更'
  }
}

function fileChangeDiff(change: any): string {
  const diff = change?.diff ?? change?.unified_diff
  return typeof diff === 'string' ? diff : ''
}

function diffStats(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added++
    if (line.startsWith('-')) removed++
  }
  return { added, removed }
}

function addStats(a: { added: number; removed: number }, b: { added: number; removed: number }): { added: number; removed: number } {
  return { added: a.added + b.added, removed: a.removed + b.removed }
}

function formatDiffStats(stats: { added: number; removed: number }): string {
  return stats.added > 0 || stats.removed > 0 ? `+${stats.added} -${stats.removed}` : ''
}

function truncateDiff(diff: string): string {
  const max = 1800
  return diff.length > max ? diff.slice(0, max) + '\n... diff 已截断 ...' : diff
}

function summarizeFileChangeInput(input: any): string {
  const changes = fileChangeEntries(input)
  const root = fileChangeRoot(input)
  if (changes.length === 0) {
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : ''
    const grantRoot = input?.grantRoot ? compactFilePath(input.grantRoot) : ''
    if (reason && grantRoot) return `${reason} · ${grantRoot}`
    return reason || (grantRoot ? `申请修改 ${grantRoot}` : '')
  }

  const total = changes
    .map(change => diffStats(fileChangeDiff(change)))
    .reduce(addStats, { added: 0, removed: 0 })
  const stats = formatDiffStats(total)
  const labels = [...new Set(changes.map(fileChangeLabel))]
  const firstPath = compactFilePath(changes[0]?.path, root)
  const suffix = stats ? ` · ${stats}` : ''
  if (changes.length === 1) return `${labels[0]} ${firstPath}${suffix}`
  return `${changes.length} 个文件 · ${labels.join('/')} · ${firstPath} 等${suffix}`
}

function renderFileChangeBody(input: any, output: string | null, resolvedNote?: string): string {
  const changes = fileChangeEntries(input)
  const root = fileChangeRoot(input)
  const lines: string[] = []

  if (changes.length === 0) {
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : ''
    if (reason) lines.push(`**原因**: ${reason}`)
    if (input?.grantRoot) lines.push(`**范围**: ${inlineCode(compactFilePath(input.grantRoot))}`)
    if (resolvedNote) {
      lines.push('')
      lines.push(resolvedNote)
    }
    if (output != null) {
      lines.push('')
      lines.push('---')
      lines.push('**output:**')
      lines.push(fenceBlock(output.slice(0, 3000)))
    }
    return lines.length > 0 ? lines.join('\n') : fenceBlock(JSON.stringify(input ?? {}, null, 2).slice(0, 2000))
  }

  const total = changes
    .map(change => diffStats(fileChangeDiff(change)))
    .reduce(addStats, { added: 0, removed: 0 })
  const totalStats = formatDiffStats(total)
  lines.push(`**文件**: ${changes.length} 个`)
  if (totalStats) lines.push(`**行数**: ${totalStats}`)
  if (input?.status) lines.push(`**状态**: ${inlineCode(input.status)}`)

  const shown = changes.slice(0, 5)
  for (const change of shown) {
    const diff = fileChangeDiff(change)
    const stats = formatDiffStats(diffStats(diff))
    const path = compactFilePath(change?.path, root)
    const title = stats ? `**${fileChangeLabel(change)}** ${inlineCode(path)} · ${stats}` : `**${fileChangeLabel(change)}** ${inlineCode(path)}`
    lines.push('')
    lines.push(title)
    const movePath = fileChangeMovePath(change)
    if (movePath) lines.push(`来自 ${inlineCode(compactFilePath(movePath, root))}`)
    lines.push(diff ? fenceBlock(truncateDiff(diff), 'diff') : '_无 diff 内容_')
  }

  if (changes.length > shown.length) {
    lines.push('')
    lines.push(`还有 ${changes.length - shown.length} 个文件未展开显示。`)
  }
  if (resolvedNote) {
    lines.push('')
    lines.push(resolvedNote)
  }
  return lines.join('\n')
}

function parseJsonObject(text: string | null): any | null {
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function webSearchAction(input: any, output: string | null): any {
  return parseJsonObject(output) ?? input?.action ?? {}
}

function webSearchQueries(input: any, output: string | null): string[] {
  const action = webSearchAction(input, output)
  const queries = Array.isArray(action?.queries)
    ? action.queries.filter((q: unknown): q is string => typeof q === 'string' && q.length > 0)
    : []
  const query = typeof action?.query === 'string' && action.query.length > 0
    ? action.query
    : typeof input?.query === 'string' && input.query.length > 0
      ? input.query
      : ''
  return queries.length > 0 ? queries : (query ? [query] : [])
}

function webSearchUrl(input: any, output: string | null): string {
  const action = webSearchAction(input, output)
  return String(action?.url ?? input?.url ?? '')
}

function summarizeWebSearchInput(input: any): string {
  const queries = webSearchQueries(input, null)
  if (queries.length === 1) return queries[0]
  if (queries.length > 1) return `${queries.length} 条查询 · ${queries[0]}`
  const url = webSearchUrl(input, null)
  if (url) return url
  const type = input?.action?.type
  return typeof type === 'string' && type !== 'other' ? type : ''
}

function summarizeWebSearchOutput(input: any, output: string | null): string {
  const queries = webSearchQueries(input, output)
  if (queries.length === 1) return queries[0]
  if (queries.length > 1) return `${queries.length} 条查询 · ${queries[0]}`
  const url = webSearchUrl(input, output)
  if (url) return url
  return summarizeWebSearchInput(input)
}

function renderWebSearchBody(input: any, output: string | null, resolvedNote?: string): string {
  const action = webSearchAction(input, output)
  const queries = webSearchQueries(input, output)
  const url = webSearchUrl(input, output)
  const lines: string[] = []
  const type = typeof action?.type === 'string' ? action.type : ''

  if (type === 'search' || queries.length > 0) {
    lines.push(`**动作**: 搜索`)
    if (queries.length > 0) {
      lines.push('')
      lines.push('**查询**')
      for (const q of queries.slice(0, 6)) lines.push(`- ${inlineCode(q)}`)
      if (queries.length > 6) lines.push(`- 还有 ${queries.length - 6} 条未显示`)
    }
  } else if (type === 'open_page') {
    lines.push(`**动作**: 打开页面`)
    if (url) lines.push(`**URL**: ${inlineCode(url)}`)
  } else if (type === 'find_in_page') {
    lines.push(`**动作**: 页内查找`)
    if (url) lines.push(`**URL**: ${inlineCode(url)}`)
    if (action?.pattern) lines.push(`**关键词**: ${inlineCode(action.pattern)}`)
  } else {
    lines.push(`**动作**: ${type ? inlineCode(type) : '网页搜索'}`)
    if (url) lines.push(`**URL**: ${inlineCode(url)}`)
  }

  if (resolvedNote) {
    lines.push('')
    lines.push(resolvedNote)
  }
  if (lines.length === 1 && !queries.length && !url && output != null) {
    lines.push('')
    lines.push('---')
    lines.push('**output:**')
    lines.push(fenceBlock(output.slice(0, 3000), 'json'))
  }
  return lines.join('\n')
}

function summarizeMcpInput(input: any): string {
  const server = String(input?.server ?? '')
  const tool = String(input?.tool ?? '')
  const call = server && tool ? `${server}.${tool}` : (tool || server)
  const arg = firstStringField(input?.arguments)
  return arg && call ? `${call}: ${arg}` : call || arg
}

function renderMcpBody(input: any, output: string | null, resolvedNote?: string): string {
  const lines: string[] = []
  if (input?.server) lines.push(`**server**: ${inlineCode(input.server)}`)
  if (input?.tool) lines.push(`**tool**: ${inlineCode(input.tool)}`)
  const args = input?.arguments
  if (args && typeof args === 'object' && Object.keys(args).length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('**arguments**')
    lines.push(jsonBlock(args, 2000))
  }
  if (resolvedNote) {
    lines.push('')
    lines.push(resolvedNote)
  }
  if (output != null) {
    const parsed = parseJsonObject(output)
    lines.push('')
    lines.push('---')
    lines.push('**结果**')
    if (parsed && Array.isArray(parsed.content)) {
      const texts = parsed.content
        .map((c: any) => typeof c?.text === 'string' ? c.text : '')
        .filter(Boolean)
      if (texts.length > 0) lines.push(texts.join('\n').slice(0, 3000))
      if (parsed.structuredContent) {
        lines.push('')
        lines.push('**structuredContent**')
        lines.push(jsonBlock(parsed.structuredContent, 2000))
      }
      if (texts.length === 0 && !parsed.structuredContent) lines.push(jsonBlock(parsed, 3000))
    } else {
      lines.push(parsed ? jsonBlock(parsed, 3000) : fenceBlock(output.slice(0, 3000)))
    }
  }
  return lines.length > 0 ? lines.join('\n') : jsonBlock(input ?? {}, 2000)
}

function summarizeImageGenerationInput(input: any): string {
  const prompt = typeof input?.revisedPrompt === 'string' ? input.revisedPrompt : ''
  const status = typeof input?.status === 'string' ? input.status : ''
  return prompt || status
}

function renderImageGenerationBody(input: any, output: string | null, resolvedNote?: string): string {
  const lines: string[] = []
  if (input?.status) lines.push(`**状态**: ${inlineCode(input.status)}`)
  if (input?.revisedPrompt) {
    if (lines.length > 0) lines.push('')
    lines.push('**提示词**')
    lines.push(String(input.revisedPrompt).slice(0, 2000))
  }
  if (resolvedNote) {
    lines.push('')
    lines.push(resolvedNote)
  }
  if (output != null && output.trim()) {
    lines.push('')
    lines.push('---')
    lines.push('**输出**')
    lines.push(inlineCode(output.trim()))
  }
  return lines.length > 0 ? lines.join('\n') : jsonBlock(input ?? {}, 2000)
}

function summarizeAgentInput(input: any): string {
  const tool = typeof input?.tool === 'string' ? input.tool : ''
  const prompt = typeof input?.prompt === 'string' ? input.prompt : ''
  return tool && prompt ? `${tool}: ${prompt}` : (prompt || tool)
}

function renderAgentBody(input: any, output: string | null, resolvedNote?: string): string {
  const lines: string[] = []
  if (input?.tool) lines.push(`**tool**: ${inlineCode(input.tool)}`)
  if (input?.model) lines.push(`**model**: ${inlineCode(input.model)}`)
  if (input?.prompt) {
    if (lines.length > 0) lines.push('')
    lines.push('**prompt**')
    lines.push(String(input.prompt).slice(0, 2000))
  }
  if (resolvedNote) {
    lines.push('')
    lines.push(resolvedNote)
  }
  if (output != null) {
    lines.push('')
    lines.push('---')
    lines.push('**状态**')
    const parsed = parseJsonObject(output)
    lines.push(parsed ? jsonBlock(parsed, 3000) : fenceBlock(output.slice(0, 3000)))
  }
  return lines.length > 0 ? lines.join('\n') : jsonBlock(input ?? {}, 2000)
}

interface MainCardOpts {
  sessionName: string
  turn: number
  model?: string
  effort?: string
  /** What started this turn:
   *   'user_message' — user input batch(panel "📥 收到 (N)" 渲染原文)
   *   'card_full'    — 同一 Codex turn 的"续卡":前一张卡写满(element 数
   *                   触顶 ~75)或写入被飞书拒,session rotate 出来的新卡
   *                   (banner `📨 接续上一张`,无 panel,turn 号跟旧卡
   *                   相同) */
  kind?: 'user_message' | 'card_full'
  /** 本轮 Codex 收到的 user wireText 列表。boot turn 通常是 1 条;mid-turn
   * 用户连发的 N 条会在下一 turn 一并塞进。空数组 / undefined 时不渲染
   * userInput panel。 */
  userInputs?: string[]
  /** Initial stable footer text. Session replaces it with a live timer
   * after it has converted message_id → card_id, but this value is what
   * the user sees immediately when Feishu creates the card. */
  initialFooter?: string
}

/** Initial card sent at the start of each turn. Streaming on. */
export function mainConversationCard(opts: MainCardOpts): object {
  const banner = opts.kind === 'card_full'
    ? [{ tag: 'markdown', content: '📨 接续上一张(同一轮 Codex turn,前一张卡写满或写入受限)' }]
    : []
  const inputs = opts.userInputs ?? []
  const userInputPanel = inputs.length > 0
    ? [{
        tag: 'collapsible_panel',
        element_id: ELEMENTS.userInput,
        header: { title: { tag: 'plain_text', content: `📥 收到 (${inputs.length})` } },
        expanded: false,
        elements: inputs.map(text => ({
          tag: 'markdown',
          // Markdown 里 < > 这些字符在 Card Kit 渲染里会被解析,转一下避免
          // 用户输入里的 HTML 之类被当结构吞掉。
          content: text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        })),
      }]
    : []
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      summary: { content: '[Lodestar 正在生成…]' },
      streaming_config: {
        print_frequency_ms: { default: 60, android: 60, ios: 60, pc: 30 },
        print_step: { default: 2, android: 2, ios: 2, pc: 4 },
        print_strategy: 'fast',
      },
    },
    body: {
      // Initial body: [handoff banner?] + [userInput panel?] + footer.
      // Assistant segments and tool panels insert_before footer during
      // Codex streaming. The footer itself is the only live status element:
      // `Thinking...(Ns)` while the model is silent, `Working...` while
      // content/tools are visible, and the terminal line when the turn ends.
      elements: [
        ...banner,
        ...userInputPanel,
        { tag: 'markdown', element_id: ELEMENTS.footer, content: opts.initialFooter ?? 'Waiting...(0s)' },
      ],
    },
  }
}

/** Empty assistant segment to be inserted just before the footer. */
export function assistantSegmentElement(i: number): object {
  return { tag: 'markdown', element_id: ELEMENTS.assistant(i), content: ' ' }
}

/** Element to insert for each tool call. Expandable for big results.
 *
 * Header is a one-line summary: status + name + summarized input.
 * Body holds the full input + (after completion) the full output.
 * `resolvedNote` is an optional one-liner appended below the input —
 * used to surface "✅ 允许 by Alice" inline after a permission decision
 * lands but before the actual tool execution completes. */
export function toolCallElement(
  i: number,
  name: string,
  input: any,
  output: string | null,
  status: '⏳' | '✅' | '❌' = '⏳',
  resolvedNote?: string,
): object {
  const rawSummary = isWebSearchTool(name) && output != null
    ? summarizeWebSearchOutput(input, output)
    : summarizeToolInput(name, input)
  const summary = rawSummary.length > 80 ? rawSummary.slice(0, 80) + '…' : rawSummary
  const toolName = displayToolName(name)
  const headerText = summary
    ? `${status} 🔧 ${toolName}: ${summary}`
    : `${status} 🔧 ${toolName}`
  const noteBlock = resolvedNote ? `\n\n${resolvedNote}` : ''
  const body = isBashCommandTool(name)
    ? renderBashBody(input, output, resolvedNote)
    : isShellSessionTool(name)
      ? renderShellSessionBody(input, output, resolvedNote)
      : isFileChangeTool(name)
        ? renderFileChangeBody(input, output, resolvedNote)
        : isWebSearchTool(name)
          ? renderWebSearchBody(input, output, resolvedNote)
          : isMcpTool(name)
            ? renderMcpBody(input, output, resolvedNote)
            : isImageGenerationTool(name)
              ? renderImageGenerationBody(input, output, resolvedNote)
              : isAgentTool(name)
                ? renderAgentBody(input, output, resolvedNote)
                : '```\n' + JSON.stringify(input ?? {}, null, 2).slice(0, 2000) + '\n```'
                  + noteBlock
                  + (output != null ? '\n---\n**output:**\n```\n' + output.slice(0, 3000) + '\n```' : '')
  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.tool(i),
    header: { title: { tag: 'plain_text', content: headerText } },
    expanded: false,
    elements: [
      { tag: 'markdown', content: body },
    ],
  }
}

/** Panel for one or more `Read` tool calls in a row. Body lists file
 * paths only — never the contents, since piping repo source into a
 * Feishu group is the wrong default (chat history persists, the bot
 * runs as the user, so anything readable on disk is one tool-call away
 * from being archived in Lark). Header collapses to `Read: <path>` for
 * a single item and `Read · N 次` once a run has joined. */
export function readBatchElement(
  i: number,
  items: Array<{ input: any; output: string | null; isError: boolean }>,
): object {
  const n = items.length
  const anyError = items.some(it => it.isError)
  const allDone = items.every(it => it.output !== null)
  const status = anyError ? '❌' : allDone ? '✅' : '⏳'
  const headerText = n === 1
    ? (() => {
        const summary = summarizeToolInput('Read', items[0]?.input)
        return summary ? `${status} 🔧 Read: ${summary}` : `${status} 🔧 Read`
      })()
    : `${status} 🔧 Read · ${n} 次`
  const lines = items.map(it => `\`${String(it.input.file_path ?? '(无 path)')}\``)
  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.tool(i),
    header: { title: { tag: 'plain_text', content: headerText } },
    expanded: false,
    elements: [{ tag: 'markdown', content: lines.join('\n') }],
  }
}

/** Same tool panel as `toolCallElement`, but with the 🔐 status and
 * three inline action buttons (allow / allow_always / deny). Expanded
 * by default so the user can read the request without clicking through.
 * This is the "merge into tool panel" UX — the permission decision
 * lives on the same row as the tool call instead of as a separate
 * floating card. */
export function toolCallPermissionElement(
  i: number,
  name: string,
  input: any,
  requestId: string,
): object {
  const summary = summarizeToolInput(name, input)
  const toolName = displayToolName(name)
  const headerText = summary
    ? `🔐 等审批 · ${toolName}: ${summary}`
    : `🔐 等审批 · ${toolName}`
  const inputBlock = isBashCommandTool(name)
    ? renderBashBody(input, null)
    : isShellSessionTool(name)
      ? renderShellSessionBody(input, null)
      : isFileChangeTool(name)
        ? renderFileChangeBody(input, null)
        : isMcpTool(name)
          ? renderMcpBody(input, null)
          : isImageGenerationTool(name)
            ? renderImageGenerationBody(input, null)
            : isAgentTool(name)
              ? renderAgentBody(input, null)
              : '```\n' + JSON.stringify(input ?? {}, null, 2).slice(0, 2000) + '\n```'
  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.tool(i),
    header: { title: { tag: 'plain_text', content: headerText } },
    expanded: true,
    elements: [
      { tag: 'markdown', content: inputBlock },
      {
        tag: 'column_set',
        columns: [
          permissionButtonColumn('✅ 允许', 'primary', requestId, 'allow'),
          permissionButtonColumn('♾️ 始终允许', 'default', requestId, 'allow_always'),
          permissionButtonColumn('❌ 拒绝', 'danger', requestId, 'deny'),
        ],
      },
    ],
  }
}

function permissionButtonColumn(label: string, type: string, requestId: string, decision: string): object {
  return {
    tag: 'column', width: 'weighted', weight: 1,
    elements: [{
      tag: 'button',
      text: { tag: 'plain_text', content: label },
      type,
      behaviors: [{ type: 'callback', value: { kind: 'permission', request_id: requestId, decision } }],
    }],
  }
}

/** Schema of an AskUserQuestion question, projected to just the fields
 * the panel needs. Mirrors the SDK tool's input — kept loose since the
 * runtime guarantees it matches. */
export interface AskQuestion {
  question: string
  header?: string
  multiSelect?: boolean
  options: { label: string; description?: string }[]
}

/** Per-question final-state. Mutually-exclusive branches: option pick
 * vs. free-form custom text. */
export interface AskAnswered {
  optionIdx?: number
  customText?: string
  user?: string
}

/** State the panel renders against. `currentIdx` undefined → terminal
 * (every question answered). Otherwise it's the question currently on
 * screen; everything in `answered` is history. */
export interface AskState {
  currentIdx?: number
  answered: Map<number, AskAnswered>
}

/** Render one question's body — either as clickable interactive_container
 * rows (when picked === undefined) or as plain markdown summary
 * (already-answered, shown in history-panel context). */
function renderAskQuestionBody(
  q: AskQuestion,
  toolUseId: string,
  questionIdx: number,
  picked?: AskAnswered,
): any[] {
  const els: any[] = []
  els.push({ tag: 'markdown', content: `**${q.question}**` })
  for (let oi = 0; oi < q.options.length; oi++) {
    const opt = q.options[oi]
    const desc = opt.description ? `  ·  ${opt.description}` : ''
    if (picked) {
      const isPicked = picked.optionIdx === oi
      els.push({
        tag: 'markdown',
        content: isPicked
          ? `✅ **${opt.label}**${desc}`
          : `~~◯ ${opt.label}${desc}~~`,
      })
    } else {
      els.push({
        tag: 'interactive_container',
        background_style: 'default',
        has_border: true,
        corner_radius: '6px',
        padding: '8px 12px',
        margin: '4px 0px 4px 0px',
        behaviors: [{
          type: 'callback',
          value: {
            kind: 'ask',
            tool_use_id: toolUseId,
            question_idx: questionIdx,
            option_idx: oi,
          },
        }],
        elements: [{ tag: 'markdown', content: `**${opt.label}**${desc}` }],
      })
    }
  }
  if (picked?.customText) {
    els.push({ tag: 'markdown', content: `✏️ **自定义回答**：${picked.customText}` })
  }
  return els
}

/** Folded "📜 已答 N 题" panel — option C from the multi-question
 * design discussion. Returns null when there's no history to show. */
function renderAskHistoryPanel(
  questions: AskQuestion[],
  answered: Map<number, AskAnswered>,
): any | null {
  if (answered.size === 0) return null
  const lines: string[] = []
  const sortedIdx = [...answered.keys()].sort((a, b) => a - b)
  for (const idx of sortedIdx) {
    const q = questions[idx]
    const a = answered.get(idx)!
    const tag = q?.header ?? `Q${idx + 1}`
    const value = a.customText
      ?? (a.optionIdx !== undefined ? q?.options[a.optionIdx]?.label : undefined)
      ?? '?'
    lines.push(`- ✅ **${tag}**：${value}`)
  }
  return {
    tag: 'collapsible_panel',
    header: {
      title: { tag: 'plain_text', content: `📜 已答 ${answered.size} 题（点击展开）` },
    },
    expanded: false,
    elements: [{ tag: 'markdown', content: lines.join('\n') }],
  }
}

/** Tool-panel renderer for `AskUserQuestion` — Codex's structured
 * multiple-choice question. Daemon takes over the client-side role:
 * instead of letting the request fall through to the generic JSON
 * dump (or worse, the permission flow that misappropriates it), we
 * render each question with one button per option, callbacks tagged
 * `kind:'ask'` so the Lark handler can route the answer back as a
 * `tool_result`.
 *
 * Single-question is the common case; multi-question gets buttons on
 * the first question only and a text-only listing for the rest (an
 * acceptable limitation — these are rare in practice and we can lift
 * it once the UX is validated). */
export function askUserQuestionElement(
  i: number,
  toolUseId: string,
  questions: AskQuestion[],
  status: '🤔' | '✅' | '❌' = '🤔',
  state?: AskState,
): object {
  const total = questions.length
  const answered = state?.answered ?? new Map<number, AskAnswered>()
  const currentIdx = state?.currentIdx
  const isTerminal = currentIdx === undefined && answered.size > 0
  const bodyElements: any[] = []
  let headerText: string

  if (isTerminal) {
    // All questions resolved — collapse and roll up answers in header
    // + body. Single-question case keeps the old "已回答：xxx" header
    // style; multi-question gets a "已回答 · N 题" count and a flat
    // listing of Q→A pairs in the body.
    if (total === 1) {
      const q0 = questions[0]
      const a0 = answered.get(0)
      const value = a0?.customText
        ?? (a0?.optionIdx !== undefined ? q0?.options[a0.optionIdx]?.label : undefined)
        ?? '?'
      const headerTag = q0?.header ? ` · ${q0.header}` : ''
      headerText = `${status} 已回答${headerTag}：${value}`
    } else {
      headerText = `${status} 已回答 · ${total} 题`
    }
    const sortedIdx = [...answered.keys()].sort((a, b) => a - b)
    for (const idx of sortedIdx) {
      const q = questions[idx]
      const a = answered.get(idx)!
      const tag = q?.header ?? `Q${idx + 1}`
      const value = a.customText
        ?? (a.optionIdx !== undefined ? q?.options[a.optionIdx]?.label : undefined)
        ?? '?'
      bodyElements.push({
        tag: 'markdown',
        content: `**${tag}**：${value}`,
      })
    }
    const lastUser = [...answered.values()].reverse().find(a => a.user)?.user
    if (lastUser) {
      bodyElements.push({
        tag: 'markdown',
        content: `\n*— 由 ${lastUser} 回答*`,
      })
    }
  } else if (currentIdx !== undefined && questions[currentIdx]) {
    // In-progress: render current question + folded history above.
    // Progress tag in header lets the user see how many are left,
    // even with the history panel folded.
    const q = questions[currentIdx]
    const headerTag = q.header ? ` · ${q.header}` : ''
    const progress = total > 1 ? ` (${currentIdx + 1}/${total})` : ''
    headerText = `${status} 🤔 AskUserQuestion${headerTag}${progress}`
    const history = renderAskHistoryPanel(questions, answered)
    if (history) bodyElements.push(history)
    bodyElements.push(...renderAskQuestionBody(q, toolUseId, currentIdx))
    bodyElements.push({
      tag: 'markdown',
      content: '_💬 也可以直接在群里回复你的答案（裸词命令 `hi`/`stop`/`kill`/`restart`/`clear` 仍然优先）_',
    })
  } else {
    // Defensive fallback — neither answered nor a valid currentIdx.
    headerText = `${status} 🤔 AskUserQuestion`
    if (questions[0]) {
      bodyElements.push({ tag: 'markdown', content: `**${questions[0].question}**` })
    }
  }

  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.tool(i),
    header: { title: { tag: 'plain_text', content: headerText } },
    expanded: !isTerminal,
    elements: bodyElements,
  }
}
