/**
 * Verbose (A) mode card for scheduled fires.
 *
 * Built as a single static card: assistant segments + tool panels +
 * result meta, all rendered in one pass after the turn closes. No
 * streaming_mode, no cardkit Promise queue, no sequence dance — just
 * `feishu.sendCard(chatId, scheduledSummaryCard(...))` once.
 *
 * Why a separate renderer instead of reusing src/cards.ts: that module
 * is wired into Session's streaming lifecycle (per-element id, in-place
 * mutation via cardkit PUT, ticker activity indicator, footer slot for
 * streamText). The scheduled fire path has none of that — it gets one
 * shot at rendering a finished transcript and is done. Sharing the
 * helpers would force every "render one tool call" function to handle
 * both modes; cheaper to duplicate ~50 lines.
 */

import type { ClaudeResultMeta } from '../claude-process'
import type { ScheduleLevel } from '../schedule'

export interface CollectedTool {
  id: string
  name: string
  input: any
  output: string | null
  isError: boolean
}

interface ScheduledSummaryOpts {
  name: string
  project: string
  prompt: string
  assistantSegs: string[]
  tools: CollectedTool[]
  elapsedMs: number
  meta: ClaudeResultMeta
  crashed: boolean
  level: ScheduleLevel
}

// Same character budget as cards.ts uses for the inline tool input summary.
const INPUT_SUMMARY_MAX = 80
// Feishu markdown elements have a ~2000-char practical ceiling per block
// before render starts misbehaving; tool output that big gets truncated
// with a clear marker.
const OUTPUT_TRUNC_AT = 1800

function escapeMd(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function summarizeInput(name: string, input: any): string {
  if (!input || typeof input !== 'object') return ''
  // Per-tool sensible-first picks; otherwise fall back to a generic JSON
  // squashed onto one line. Mirrors the spirit of cards.ts's
  // inputSummary without sharing code.
  const get = (k: string) => typeof input[k] === 'string' ? input[k] as string : null
  let summary = ''
  switch (name) {
    case 'Bash': case 'BashOutput':
      summary = get('command') ?? get('description') ?? '' ; break
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit':
      summary = get('file_path') ?? '' ; break
    case 'Glob': case 'Grep':
      summary = get('pattern') ?? '' ; break
    case 'WebFetch': case 'WebSearch':
      summary = get('url') ?? get('query') ?? '' ; break
    default:
      try { summary = JSON.stringify(input).slice(0, 200) } catch { summary = '' }
  }
  summary = summary.replace(/\s+/g, ' ').trim()
  if (summary.length > INPUT_SUMMARY_MAX) summary = summary.slice(0, INPUT_SUMMARY_MAX - 1) + '…'
  return summary
}

function toolPanel(t: CollectedTool, idx: number): object {
  const status = t.isError ? '❌' : (t.output === null ? '⏳' : '✅')
  const inputSummary = summarizeInput(t.name, t.input)
  const header = inputSummary
    ? `${status} **${t.name}** \`${escapeMd(inputSummary)}\``
    : `${status} **${t.name}**`
  const bodyParts: string[] = []
  // Input block
  let inputStr: string
  try { inputStr = JSON.stringify(t.input, null, 2) } catch { inputStr = String(t.input) }
  bodyParts.push(`**input**\n\`\`\`json\n${inputStr}\n\`\`\``)
  // Output block (truncated if needed)
  if (t.output !== null) {
    let out = t.output
    if (out.length > OUTPUT_TRUNC_AT) {
      out = out.slice(0, OUTPUT_TRUNC_AT) + `\n…（截断 ${t.output.length - OUTPUT_TRUNC_AT} 字符）`
    }
    bodyParts.push(`**output**${t.isError ? ' ❌' : ''}\n\`\`\`\n${out}\n\`\`\``)
  } else {
    bodyParts.push('_(无 output — turn 中途结束或工具未返回)_')
  }
  return {
    tag: 'collapsible_panel',
    header: { title: { tag: 'plain_text', content: `[${idx + 1}] ${header}` } },
    expanded: false,
    elements: bodyParts.map(content => ({ tag: 'markdown', content })),
  }
}

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${m}m${s}s`
}

function fmtTokens(meta: ClaudeResultMeta): string {
  const u = meta.usage
  if (!u) return ''
  const inT = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
  const outT = u.output_tokens ?? 0
  if (inT === 0 && outT === 0) return ''
  const fmtN = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)
  return `📥 ${fmtN(inT)} · 📤 ${fmtN(outT)}`
}

export function scheduledSummaryCard(opts: ScheduledSummaryOpts): object {
  const template = opts.crashed || opts.meta.is_error ? 'red'
    : opts.level === 'error' ? 'red'
    : opts.level === 'warn' ? 'yellow'
    : 'blue'
  const elements: object[] = []

  // 1) Prompt panel — collapsed by default; lets the reader confirm
  // *what was asked* without scrolling up to the schedule list.
  elements.push({
    tag: 'collapsible_panel',
    header: { title: { tag: 'plain_text', content: `📝 prompt` } },
    expanded: false,
    elements: [{ tag: 'markdown', content: escapeMd(opts.prompt) }],
  })

  // 2) Body — interleave assistant segments and tool panels in roughly
  // source order. We don't actually preserve perfect interleaving (the
  // collector flushes the current segment whenever a tool fires, so the
  // segs[i] / tools[i] pairing is the natural order). For a "summary"
  // card this fidelity is enough — anyone needing full step-by-step
  // ordering should use silent mode and trigger turns from a real
  // user-message session.
  const segs = opts.assistantSegs
  const tools = opts.tools
  // First: segments before tool 0
  const maxLen = Math.max(segs.length, tools.length)
  for (let i = 0; i < maxLen; i++) {
    const seg = segs[i]
    if (seg && seg.trim()) {
      elements.push({ tag: 'markdown', content: seg })
    }
    if (tools[i]) {
      elements.push(toolPanel(tools[i], i))
    }
  }
  if (segs.length === 0 && tools.length === 0) {
    elements.push({ tag: 'markdown', content: '_（无输出）_' })
  }

  // 3) Footer — elapsed + tokens + crashed indicator
  elements.push({ tag: 'hr' })
  const tokens = fmtTokens(opts.meta)
  const errSuffix = opts.crashed
    ? ` · <font color='red'>⚠️ 进程崩溃</font>`
    : (opts.meta.is_error
        ? ` · <font color='red'>⚠️ ${opts.meta.subtype ?? 'error'}</font>`
        : '')
  const footer = `<font color='grey'>⏱ ${fmtElapsed(opts.elapsedMs)}${tokens ? ' · ' + tokens : ''} · via ⏰ schedule</font>${errSuffix}`
  elements.push({ tag: 'markdown', content: footer })

  return {
    schema: '2.0',
    config: {},
    header: {
      title: { tag: 'plain_text', content: `⏰ ${opts.name}` },
      template,
    },
    body: { elements },
  }
}
