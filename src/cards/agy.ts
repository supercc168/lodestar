import { ELEMENTS } from './elements'

export interface AgyGitSnapshot {
  ok: boolean
  statusShort: string
  diffShortStat: string
  diffNameOnly: string
  error?: string
}

export interface AgyStats {
  status: string
  model: string
  cwd: string
  command: string
  startedAtMs: number
  elapsedSec: string
  endedAtMs?: number
  exitCode?: number | null
  signal?: string | null
  stdoutBytes?: number
  stderrBytes?: number
  captureTruncated?: boolean
  cardTruncated?: boolean
  hostTimedOut?: boolean
}

export interface AgyTaskCardOpts {
  sessionName: string
  prompt: string
  stats: AgyStats
  beforeGit: AgyGitSnapshot
}

const RESULT_CARD_LIMIT = 8000
const STDERR_CARD_LIMIT = 2000
const GIT_CARD_LIMIT = 5000

export function agyTaskCard(opts: AgyTaskCardOpts): object {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      streaming_mode: true,
      summary: { content: `${opts.stats.status} · agy` },
    },
    body: {
      elements: [
        agyPromptElement(opts.prompt),
        agyStatsElement(opts.stats),
        agyResultElement({
          status: '⏳ 等待 agy 返回...',
          stdout: '',
          stderr: '',
        }),
        agyRepoElement({ before: opts.beforeGit }),
      ],
    },
  }
}

export function agyPromptElement(prompt: string): object {
  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.agyPrompt,
    header: { title: { tag: 'plain_text', content: `📥 agy 提示词 · ${shortLine(prompt, 42)}` } },
    expanded: false,
    elements: [{ tag: 'markdown', content: escapeMarkdown(prompt).trim() || '_空_' }],
  }
}

export function agyStatsElement(stats: AgyStats): object {
  const lines = [
    `**状态**: ${escapeMarkdown(stats.status)}`,
    `**模型**: ${inlineCode(stats.model)}`,
    `**工作目录**: ${inlineCode(stats.cwd)}`,
    `**命令**: ${inlineCode(stats.command)}`,
    `**开始**: ${inlineCode(iso(stats.startedAtMs))}`,
    `**已耗时**: ${inlineCode(`${stats.elapsedSec}s`)}`,
  ]
  if (stats.endedAtMs) lines.push(`**结束**: ${inlineCode(iso(stats.endedAtMs))}`)
  if (stats.exitCode !== undefined || stats.signal !== undefined) {
    lines.push(`**退出**: code=${inlineCode(String(stats.exitCode ?? '-'))} signal=${inlineCode(stats.signal ?? '-')}`)
  }
  if (stats.stdoutBytes !== undefined || stats.stderrBytes !== undefined) {
    lines.push(`**输出**: stdout ${inlineCode(`${stats.stdoutBytes ?? 0}B`)} · stderr ${inlineCode(`${stats.stderrBytes ?? 0}B`)}`)
  }
  const flags: string[] = []
  if (stats.hostTimedOut) flags.push('host timeout')
  if (stats.captureTruncated) flags.push('capture truncated')
  if (stats.cardTruncated) flags.push('card truncated')
  if (flags.length) lines.push(`**标记**: ${flags.map(inlineCode).join(' ')}`)

  return {
    tag: 'markdown',
    element_id: ELEMENTS.agyStats,
    content: lines.join('\n'),
  }
}

export function agyResultElement(opts: { status: string; stdout: string; stderr: string; cardTruncated?: boolean }): object {
  const stdout = opts.stdout.trim()
  const stderr = opts.stderr.trim()
  const lines = [`**${escapeMarkdown(opts.status)}**`]
  if (stdout) {
    const truncated = truncate(stdout, RESULT_CARD_LIMIT)
    lines.push('')
    lines.push(escapeMarkdown(truncated.text))
    if (truncated.didTruncate || opts.cardTruncated) {
      lines.push('')
      lines.push('_输出已截断，完整内容未全部写入卡片。_')
    }
  }
  if (stderr) {
    const truncatedErr = truncate(stderr, STDERR_CARD_LIMIT)
    lines.push('')
    lines.push('---')
    lines.push('**stderr**')
    lines.push(fence(escapeMarkdown(truncatedErr.text)))
    if (truncatedErr.didTruncate) lines.push('_stderr 已截断。_')
  }
  if (!stdout && !stderr) {
    lines.push('')
    lines.push('_暂无输出_')
  }
  return {
    tag: 'markdown',
    element_id: ELEMENTS.agyResult,
    content: lines.join('\n'),
  }
}

export function agyRepoElement(opts: { before: AgyGitSnapshot; after?: AgyGitSnapshot }): object {
  const beforeDirty = gitDirty(opts.before)
  const afterDirty = opts.after ? gitDirty(opts.after) : null
  const headerSuffix = opts.after
    ? (opts.after.ok
        ? (opts.after.diffShortStat || (afterDirty ? '有未提交变更' : '无未提交变更'))
        : '统计失败')
    : (opts.before.ok
        ? (beforeDirty ? '执行前已有变更' : '执行前干净')
        : '执行前统计失败')
  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.agyRepo,
    header: { title: { tag: 'plain_text', content: `📦 仓库变更 · ${shortLine(headerSuffix, 48)}` } },
    expanded: false,
    elements: [{ tag: 'markdown', content: repoBody(opts.before, opts.after) }],
  }
}

function repoBody(before: AgyGitSnapshot, after?: AgyGitSnapshot): string {
  const lines: string[] = []
  lines.push('**执行前**')
  lines.push(snapshotBody(before))
  if (after) {
    lines.push('')
    lines.push('**执行后**')
    lines.push(snapshotBody(after))
    if (gitDirty(before)) {
      lines.push('')
      lines.push('⚠️ 执行前已有未提交变更，以上结束状态不能全部归因于本次 agy 执行。')
    }
  }
  return truncate(lines.join('\n'), GIT_CARD_LIMIT).text
}

function snapshotBody(snapshot: AgyGitSnapshot): string {
  if (!snapshot.ok) {
    return `❌ Git 统计失败\n${fence(escapeMarkdown(snapshot.error ?? 'unknown error'))}`
  }
  const lines: string[] = []
  lines.push(gitDirty(snapshot) ? '状态: `dirty`' : '状态: `clean`')
  if (snapshot.diffShortStat) lines.push(`diff: ${inlineCode(snapshot.diffShortStat)}`)
  if (snapshot.statusShort) {
    lines.push('')
    lines.push('status:')
    lines.push(fence(escapeMarkdown(snapshot.statusShort)))
  }
  if (snapshot.diffNameOnly) {
    lines.push('')
    lines.push('files:')
    lines.push(fence(escapeMarkdown(snapshot.diffNameOnly)))
  }
  return lines.join('\n')
}

function gitDirty(snapshot: AgyGitSnapshot): boolean {
  return !!(snapshot.statusShort.trim() || snapshot.diffShortStat.trim() || snapshot.diffNameOnly.trim())
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function shortLine(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return '空'
  return normalized.length <= max ? normalized : normalized.slice(0, max - 1) + '…'
}

function truncate(text: string, max: number): { text: string; didTruncate: boolean } {
  if (text.length <= max) return { text, didTruncate: false }
  return { text: text.slice(0, Math.max(0, max - 1)) + '…', didTruncate: true }
}

function escapeMarkdown(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inlineCode(s: string): string {
  return '`' + s.replace(/`/g, '\\`') + '`'
}

function fence(s: string): string {
  return '```\n' + s.replace(/```/g, '`\\`\\`') + '\n```'
}
