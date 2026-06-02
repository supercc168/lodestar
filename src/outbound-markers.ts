const SEND_MARKER_RE = /\[\[send:[ \t]*([^\n]*?)[ \t]*\]\]/g

export function extractSendMarkerPaths(text: string): string[] {
  const paths: string[] = []
  for (const m of text.matchAll(SEND_MARKER_RE)) {
    const path = m[1]?.trim()
    if (path) paths.push(path)
  }
  return paths
}
