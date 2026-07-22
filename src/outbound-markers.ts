const SEND_MARKER_RE = /\[\[send:[ \t]*([^\n]*?)[ \t]*\]\]/g
/** 只锚定 askusr 前缀；payload 用括号平衡扫描，避免选项文本里的 `]`/`]]`
 *  或模型少写一个闭合 `]` 时整段匹配失败。 */
const ASKUSR_OPEN_RE = /\[\[askusr:[ \t]*/g

export function extractSendMarkerPaths(text: string): string[] {
  const paths: string[] = []
  for (const m of text.matchAll(SEND_MARKER_RE)) {
    const path = m[1]?.trim()
    if (path) paths.push(path)
  }
  return paths
}

export interface AskUsrMarker {
  raw: string
  payload: string
}

interface AskUsrMarkerSpan extends AskUsrMarker {
  start: number
  end: number
}

/** 从 `start`（必须是 `{`）扫描一个完整 JSON object，字符串感知。
 *  命中换行则失败（askusr 要求单行）。返回 object 结束后的下标，失败返回 -1。 */
function scanJsonObjectEnd(text: string, start: number): number {
  if (text[start] !== '{') return -1
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '\n' || ch === '\r') return -1
    if (inString) {
      if (escape) {
        escape = false
        continue
      }
      if (ch === '\\') {
        escape = true
        continue
      }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      depth++
      continue
    }
    if (ch === '}') {
      depth--
      if (depth === 0) return i + 1
      if (depth < 0) return -1
    }
  }
  return -1
}

function extractAskUsrMarkerSpans(text: string): AskUsrMarkerSpan[] {
  const markers: AskUsrMarkerSpan[] = []
  ASKUSR_OPEN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ASKUSR_OPEN_RE.exec(text)) !== null) {
    const openStart = match.index
    let i = openStart + match[0].length
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++
    if (text[i] !== '{') {
      // 让下一次搜索从当前前缀之后继续，避免零宽死循环
      ASKUSR_OPEN_RE.lastIndex = openStart + 2
      continue
    }
    const jsonEnd = scanJsonObjectEnd(text, i)
    if (jsonEnd < 0) {
      ASKUSR_OPEN_RE.lastIndex = openStart + 2
      continue
    }
    let j = jsonEnd
    while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++
    // 规范是 `]]`；模型偶尔少写一个 `]`。至少吃掉一个 `]` 才认定完整，
    // 避免 JSON 刚闭合、`]` 还在后续 delta 时过早触发。
    let brackets = 0
    while (brackets < 2 && j < text.length && text[j] === ']') {
      j++
      brackets++
    }
    if (brackets < 1) {
      ASKUSR_OPEN_RE.lastIndex = openStart + 2
      continue
    }
    const payload = text.slice(i, jsonEnd).trim()
    if (!payload) {
      ASKUSR_OPEN_RE.lastIndex = j
      continue
    }
    markers.push({
      raw: text.slice(openStart, j),
      payload,
      start: openStart,
      end: j,
    })
    ASKUSR_OPEN_RE.lastIndex = j
  }
  return markers
}

export function extractAskUsrMarkers(text: string): AskUsrMarker[] {
  return extractAskUsrMarkerSpans(text).map(({ raw, payload }) => ({ raw, payload }))
}

export function stripAskUsrMarkers(text: string, replacement = ''): string {
  const markers = extractAskUsrMarkerSpans(text)
  if (markers.length === 0) return text
  let out = ''
  let last = 0
  for (const marker of markers) {
    out += text.slice(last, marker.start)
    out += replacement
    last = marker.end
  }
  out += text.slice(last)
  return out
}
