const SEND_MARKER_RE = /\[\[send:[ \t]*([^\n]*?)[ \t]*\]\]/g
const ASKUSR_MARKER_RE = /\[\[askusr:[ \t]*([^\n]*?)[ \t]*\]\]/g

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

export function extractAskUsrMarkers(text: string): AskUsrMarker[] {
  const markers: AskUsrMarker[] = []
  for (const m of text.matchAll(ASKUSR_MARKER_RE)) {
    const raw = m[0]?.trim()
    const payload = m[1]?.trim()
    if (raw && payload) markers.push({ raw, payload })
  }
  return markers
}

export function stripAskUsrMarkers(text: string, replacement = ''): string {
  return text.replace(ASKUSR_MARKER_RE, replacement)
}
