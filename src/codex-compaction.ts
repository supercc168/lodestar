import type { ContextCompactedNotification } from './codex-process'
import { log } from './log'

const COMPACTION_METHODS = new Set([
  'thread/compacted',
  'context/compacted',
  'context_compacted',
  'contextCompacted',
])

const COMPACTION_TYPES = new Set([
  'compacted',
  'compaction',
  'compaction_trigger',
  'context_compacted',
  'context_compaction',
  'contextCompaction',
  'ContextCompaction',
])

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

function objectOrNull(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === 'object' ? v as Record<string, unknown> : null
}

const COMPACTION_LOG_JSON_CHARS = 200_000
const COMPACTION_LOG_STRING_CHARS = 50_000
const COMPACTION_LOG_PATHS = 400

function logValue(v: unknown): string {
  if (v == null || v === '') return '-'
  return String(v).replace(/\s+/g, ' ').slice(0, 300)
}

function formatKeyList(v: Record<string, unknown> | null): string {
  if (!v) return '[]'
  const keys = Object.keys(v)
  const shown = keys.slice(0, 80)
  const suffix = keys.length > shown.length ? `,...+${keys.length - shown.length}` : ''
  return `[${shown.join(',')}${suffix}]`
}

function formatPathList(paths: string[]): string {
  const shown = paths.slice(0, COMPACTION_LOG_PATHS)
  const suffix = paths.length > shown.length ? `,...+${paths.length - shown.length}` : ''
  return `[${shown.join(',')}${suffix}]`
}

function payloadItem(rawPayload: unknown): Record<string, unknown> | null {
  const root = objectOrNull(rawPayload)
  if (!root) return null
  const event = objectOrNull(root.event)
  const payload = objectOrNull(root.payload)
  return objectOrNull(root.item) ??
    objectOrNull(root.responseItem) ??
    objectOrNull(root.rawItem) ??
    objectOrNull(event?.item) ??
    objectOrNull(event?.responseItem) ??
    objectOrNull(event?.rawItem) ??
    objectOrNull(payload?.item) ??
    objectOrNull(payload?.responseItem) ??
    objectOrNull(payload?.rawItem) ??
    (compactionTypeOf(root.type) ? root : null) ??
    (event && compactionTypeOf(event.type) ? event : null) ??
    (payload && compactionTypeOf(payload.type) ? payload : null)
}

function keyPaths(rawPayload: unknown): string[] {
  const paths: string[] = []
  const seen = new WeakSet<object>()
  const visit = (value: unknown, path: string, depth: number) => {
    if (paths.length >= COMPACTION_LOG_PATHS || depth > 6) return
    if (Array.isArray(value)) {
      if (path) paths.push(`${path}[]`)
      if (value.length > 0) visit(value[0], path ? `${path}[]` : '[]', depth + 1)
      return
    }
    if (value == null || typeof value !== 'object') return
    if (seen.has(value)) return
    seen.add(value)
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (paths.length >= COMPACTION_LOG_PATHS) return
      const childPath = path ? `${path}.${key}` : key
      paths.push(childPath)
      visit((value as Record<string, unknown>)[key], childPath, depth + 1)
    }
  }
  visit(rawPayload, '', 0)
  return paths
}

function safeJsonForCompactionLog(value: unknown): string {
  const seen = new WeakSet<object>()
  let json: string
  try {
    json = JSON.stringify(value, (_key, v) => {
      if (typeof v === 'bigint') return `${v.toString()}n`
      if (typeof v === 'string' && v.length > COMPACTION_LOG_STRING_CHARS) {
        return `${v.slice(0, COMPACTION_LOG_STRING_CHARS)}...<truncated ${v.length - COMPACTION_LOG_STRING_CHARS} chars>`
      }
      if (v != null && typeof v === 'object') {
        if (seen.has(v)) return '[Circular]'
        seen.add(v)
      }
      return v
    }) ?? String(value)
  } catch (e) {
    json = `<unserializable: ${e}>`
  }
  if (json.length > COMPACTION_LOG_JSON_CHARS) {
    return `${json.slice(0, COMPACTION_LOG_JSON_CHARS)}...<truncated ${json.length - COMPACTION_LOG_JSON_CHARS} chars>`
  }
  return json
}

export function logUnhandledAppServerPayload(reason: string, payload: unknown): void {
  const root = objectOrNull(payload)
  const params = root ? objectOrNull(root.params) : null
  const item = root ? objectOrNull(root.item) ?? objectOrNull(params?.item) : null
  const method = root ? stringOrUndefined(root.method) ?? '-' : '-'
  log([
    `codex-process: APP_SERVER_UNHANDLED_${reason}`,
    `method=${logValue(method)}`,
    `rootKeys=${formatKeyList(root)}`,
    `itemKeys=${formatKeyList(item)}`,
    `payload=${safeJsonForCompactionLog(payload)}`,
  ].join(' '))
}

export function logContextCompactionPayload(
  method: string,
  rawPayload: unknown,
  notice: ContextCompactedNotification,
): void {
  const root = objectOrNull(rawPayload)
  const item = payloadItem(rawPayload)
  const base = [
    `phase=${logValue(notice.phase ?? 'event')}`,
    `method=${logValue(method)}`,
    `sourceMethod=${logValue(notice.sourceMethod)}`,
    `sourceType=${logValue(notice.sourceType)}`,
    `sessionId=${logValue(notice.sessionId)}`,
    `threadId=${logValue(notice.threadId)}`,
    `turnId=${logValue(notice.turnId)}`,
    `itemId=${logValue(notice.itemId)}`,
  ].join(' ')
  log(`codex-process: CONTEXT_COMPACTION_EVENT ${base} rootKeys=${formatKeyList(root)} itemKeys=${formatKeyList(item)}`)
  log(`codex-process: CONTEXT_COMPACTION_PATHS ${base} paths=${formatPathList(keyPaths(rawPayload))}`)
  if (item) {
    log(`codex-process: CONTEXT_COMPACTION_ITEM ${base} item=${safeJsonForCompactionLog(item)}`)
  }
  log(`codex-process: CONTEXT_COMPACTION_PAYLOAD ${base} payload=${safeJsonForCompactionLog(rawPayload)}`)
}

function compactionTypeOf(v: unknown): string | null {
  if (typeof v !== 'string') return null
  return COMPACTION_TYPES.has(v) ? v : null
}

function compactionPhase(sourceType: string | null, method: string): 'start' | 'end' | 'event' {
  if (method === 'item/started') return 'start'
  if (method === 'item/completed' || method === 'rawResponseItem/completed') return 'end'
  if (sourceType === 'compacted') return 'start'
  if (sourceType === 'context_compacted' || COMPACTION_METHODS.has(method)) return 'end'
  return 'event'
}

/** Codex exposes context compaction through more than one surface:
 * `thread/compacted` notifications in the app-server protocol, raw response
 * items in newer builds, and `event_msg {type:"context_compacted"}` in the
 * persisted rollout stream. Match only structured type/method fields; never
 * scan free-form text, because prompts and instructions may legitimately
 * mention compaction without an event having occurred. */
export function contextCompactionNoticeFromNotification(
  method: string,
  params: unknown,
): ContextCompactedNotification | null {
  return contextCompactionNoticeFromObject(method, objectOrNull(params) ?? {})
}

export function contextCompactionNoticeFromMessage(msg: unknown): ContextCompactedNotification | null {
  const root = objectOrNull(msg)
  if (!root) return null
  const method = stringOrUndefined(root.method) ?? stringOrUndefined(root.type) ?? 'raw_message'
  return contextCompactionNoticeFromObject(method, root)
}

function contextCompactionNoticeFromObject(
  method: string,
  root: Record<string, unknown>,
): ContextCompactedNotification | null {
  const payload = objectOrNull(root.payload)
  const candidates = [
    root,
    objectOrNull(root.event),
    payload,
    objectOrNull(root.item),
    objectOrNull(root.responseItem),
    objectOrNull(root.rawItem),
  ].filter((v): v is Record<string, unknown> => v != null)

  let sourceType: string | null = null
  for (const candidate of candidates) {
    sourceType = compactionTypeOf(candidate.type)
    if (sourceType) break
  }

  if (!COMPACTION_METHODS.has(method) && !sourceType) return null

  const rootItem = objectOrNull(root.item) ?? objectOrNull(root.responseItem) ?? objectOrNull(root.rawItem)
  const data = sourceType === 'compacted' && payload
    ? payload
    : rootItem && compactionTypeOf(rootItem.type)
      ? rootItem
      : root
  const item = objectOrNull(data.item) ?? objectOrNull(data.responseItem) ?? objectOrNull(data.rawItem) ?? rootItem ?? {}
  return {
    ...data,
    threadId:
      stringOrUndefined(data.threadId) ??
      stringOrUndefined(data.thread_id) ??
      stringOrUndefined(root.threadId) ??
      stringOrUndefined(root.thread_id),
    turnId:
      stringOrUndefined(data.turnId) ??
      stringOrUndefined(data.turn_id) ??
      stringOrUndefined(root.turnId) ??
      stringOrUndefined(root.turn_id),
    itemId:
      stringOrUndefined(data.itemId) ??
      stringOrUndefined(data.item_id) ??
      stringOrUndefined(item.id) ??
      stringOrUndefined(item.itemId) ??
      stringOrUndefined(item.item_id),
    timestamp: stringOrUndefined(root.timestamp) ?? stringOrUndefined(data.timestamp),
    recordType: stringOrUndefined(root.type),
    phase: compactionPhase(sourceType, method),
    sourceMethod: method,
    sourceType: sourceType ?? method,
  }
}
