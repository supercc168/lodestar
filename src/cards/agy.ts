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
  cpuPercent?: number | null
  memBytes?: number | null
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
        agyForwardPlaceholderElement(),
        agyRepoElement({ before: opts.beforeGit }),
      ],
    },
  }
}

export function agyPromptElement(prompt: string): object {
  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.agyPrompt,
    header: { title: { tag: 'plain_text', content: '📥 agy收到' } },
    expanded: false,
    elements: [{ tag: 'markdown', content: escapeMarkdown(prompt).trim() || '_空_' }],
  }
}

export function agyStatsElement(stats: AgyStats): object {
  return {
    tag: 'markdown',
    element_id: ELEMENTS.agyStats,
    content: [
      statusLabel(stats.status),
      `${stats.elapsedSec}s`,
      `CPU ${formatPercent(stats.cpuPercent)}`,
      `MEM ${formatBytes(stats.memBytes)}`,
    ].join(' · '),
  }
}

export function agyResultElement(opts: { status: string; stdout: string; stderr: string; notice?: string; cardTruncated?: boolean }): object {
  const stdout = cleanAgyOutputText(opts.stdout).trim()
  const stderr = cleanAgyOutputText(opts.stderr).trim()
  const lines = [`**${escapeMarkdown(opts.status)}**`]
  const notice = cleanAgyOutputText(opts.notice ?? '').trim()
  if (notice) {
    lines.push('')
    lines.push(escapeMarkdown(notice))
  }
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

export function agyForwardPlaceholderElement(): object {
  return {
    tag: 'markdown',
    element_id: ELEMENTS.agyForward,
    content: ' ',
  }
}

export function agyForwardElement(resultId: string): object {
  return {
    tag: 'column_set',
    element_id: ELEMENTS.agyForward,
    columns: [{
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [{
        tag: 'button',
        text: { tag: 'plain_text', content: '转 Codex' },
        type: 'primary',
        behaviors: [{ type: 'callback', value: { kind: 'agy_forward_codex', result_id: resultId } }],
      }],
    }],
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
  lines.push(gitDirty(snapshot) ? 'dirty' : 'clean')
  if (snapshot.diffShortStat) lines.push(`diff: ${inlineCode(snapshot.diffShortStat)}`)
  if (snapshot.statusShort) {
    lines.push('')
    lines.push(fence(escapeMarkdown(snapshot.statusShort)))
  }
  if (snapshot.diffNameOnly) {
    lines.push('')
    lines.push('files')
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

function statusLabel(status: string): string {
  if (/完成/.test(status)) return '✅ 完成'
  if (/运行中|等待|正在停止/.test(status)) return '⏳ 执行中'
  return '❌ 出错'
}

function formatPercent(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}%` : '--'
}

function formatBytes(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--'
  if (value < 1024) return `${value}B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = value / 1024
  for (const unit of units) {
    if (n < 1024 || unit === units[units.length - 1]) return `${n.toFixed(n >= 10 ? 0 : 1)}${unit}`
    n /= 1024
  }
  return `${value}B`
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

export function cleanAgyOutputText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B[=>]/g, '')
    .split('\n')
    .map(line => {
      const parts = line.split('\r')
      return parts[parts.length - 1] ?? ''
    })
    .join('\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
}
