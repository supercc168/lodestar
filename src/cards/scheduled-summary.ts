/**
 * Verbose (A) mode card for scheduled fires.
 *
 * Built as a single static card: assistant segments + tool panels +
 * result meta, all rendered in one pass after the turn closes. No
 * streaming_mode, no cardkit Promise queue, no sequence dance — just
 * `feishu.sendCard(chatId, scheduledSummaryCard(...))` once.
 *
 * Tool-panel rendering routes through the same `toolCallElement` /
 * `readBatchElement` helpers the streaming session uses, so a `Bash`
 * panel from a cron fire looks byte-for-byte identical to one from a
 * live user turn (header `⏳ 🔧 Bash: …`, JSON-input block, output
 * block, all collapsible). Read batches collapse the same way:
 * consecutive Read calls fold into one path-only panel, broken by
 * any non-Read tool or assistant text. The differences a reader can
 * spot are intentional — `⏰ <name>` header, collapsed prompt panel,
 * `via ⏰ schedule` footer — and limited to the surrounding chrome.
 */

import type { ClaudeResultMeta } from '../claude-process'
import type { ScheduleLevel } from '../schedule'
import * as cards from '../cards'

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

function escapeMd(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
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

function toolStatus(t: CollectedTool): '⏳' | '✅' | '❌' {
  if (t.output === null) return '⏳'
  return t.isError ? '❌' : '✅'
}

/** Render the collected tool list into card elements, mirroring the
 * streaming-session contract: consecutive `Read` calls fold into one
 * `readBatchElement`, broken by any non-Read tool or by an assistant
 * text segment in between. Assistant segments are interleaved at the
 * positions where the collector flushed them (segs[i] is whatever
 * landed before tools[i]; segs[N] is the trailing tail after the
 * last tool). */
function renderBody(
  segs: string[],
  tools: CollectedTool[],
): object[] {
  const out: object[] = []
  let batch: { i: number; items: Array<{ input: any; output: string | null; isError: boolean }> } | null = null
  const flushBatch = () => {
    if (!batch) return
    out.push(cards.readBatchElement(batch.i, batch.items))
    batch = null
  }
  const maxLen = Math.max(segs.length, tools.length)
  for (let i = 0; i < maxLen; i++) {
    const seg = segs[i]
    if (seg && seg.trim()) {
      flushBatch()
      out.push({ tag: 'markdown', content: seg })
    }
    const t = tools[i]
    if (!t) continue
    if (t.name === 'Read') {
      if (!batch) batch = { i, items: [] }
      batch.items.push({ input: t.input, output: t.output, isError: t.isError })
      continue
    }
    flushBatch()
    out.push(cards.toolCallElement(i, t.name, t.input, t.output, toolStatus(t)))
  }
  flushBatch()
  return out
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

  // 2) Body — interleaved assistant segments and tool panels in
  // collector order, with Read batching applied so the panel layout
  // matches a live streaming turn.
  const bodyElements = renderBody(opts.assistantSegs, opts.tools)
  if (bodyElements.length === 0) {
    elements.push({ tag: 'markdown', content: '_（无输出）_' })
  } else {
    elements.push(...bodyElements)
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
