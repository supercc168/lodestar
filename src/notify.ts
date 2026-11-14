/**
 * Outbound notification HTTP endpoint — any local process can POST a
 * markdown message + project name and it lands in the matching Feishu
 * group as a one-shot interactive card (non-streaming).
 *
 * Default bind: 127.0.0.1:9876. No auth — the daemon trusts loopback
 * on the assumption that anything able to hit this port is already
 * owner-equivalent (same security tier as the bot's stdin and the
 * debug.sock). Do NOT bind 0.0.0.0 without adding your own front-end
 * auth.
 *
 *   POST /notify
 *     Content-Type: application/json
 *     { "project": "feishu",
 *       "text":    "**build done** 12 files",
 *       "title":   "build",                    // optional, default = project
 *       "level":   "info" | "warn" | "error"   // optional, default "info"
 *       "images":  ["/abs/a.png", ...],        // optional, uploaded + embedded
 *       "buttons": [                           // optional, one full-width row each
 *         {"id":"approve","text":"✅ 通过","type":"primary"},
 *         {"id":"gmgn","text":"GMGN","url":"https://gmgn.ai/..."}  // open_url
 *       ],
 *       "callback": "http://127.0.0.1:9999/hook"  // optional loopback URL (push; callback buttons only)
 *       "request_id": "hub:instance:card",         // optional durable idempotency key
 *       "version": 1                                // optional with request_id; default 1
 *     }
 *   For a text-reply card, omit buttons and set "allow_reply": true.
 *   For a plain notification, omit both. All three types support text/images.
 *   → 200 { ok: true, chat_id, message_id, notify_id? }
 *   → 400 bad/empty json or missing/invalid field
 *   → 404 project not bound to any Feishu group
 *   → 502 feishu sendCard failed (network / API rejection)
 *
 *   PUT /notify/<notify_id>
 *     body={project,version,...complete supported card fields}
 *     → patches the original message; never sends a replacement
 *     → 200 applied/current, 202 durable unknown, 409 identity/version conflict
 *
 *   GET /notify/result/<notify_id>
 *     → 200 {notify_id,project,message_id,resolved,button?,resolved_at?,resolved_by?}
 *     → 404 unknown notify_id
 *
 * Buttons turn the one-shot card into a two-way control that stays on
 * the host. The daemon bakes a `notify_id` into every button. Two ways
 * to read the click back, both loopback-only:
 *   • push — caller pledges a `callback` URL; on tap the daemon POSTs
 *     the choice there (see `notify-callbacks.ts`).
 *   • pull — `callback` omitted; the caller polls
 *     `GET /notify/result/<notify_id>` (or just reads the frozen card).
 *
 *   GET / → plain-text help (so a `curl` from the shell reports a
 *           live server instead of 404).
 *
 * "project" must match a Feishu group name that the daemon already
 * has a chat_id binding for — usually established by sending any
 * message in that group at least once after the daemon started. Run
 * `bun scripts/test-inject.ts "hi"` from the project root if you
 * need to seed the binding without leaving the keyboard.
 */

import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { log, logError } from './log'
import { isLoopback } from './network-proxy'
import * as feishu from './feishu'
import { formatFeishuError } from './feishu-errors'
import { FeishuRequestError } from './feishu-retry'
import { downgradeExternalImagesForCardKit, sanitizeMarkdownForCardKit } from './cards/elements'
import {
  buildNotifyResult,
  canonicalNotifyHash,
  canonicalNotifyRequestHash,
  get as getCallback,
  getByRequestId,
  isDispatching,
  mutateRegistration,
  NOTIFY_CREATE_RETRY_WINDOW_MS,
  register as registerCallback,
  withNotifyLock,
  type NotifyButton,
  type NotifyDesiredBody,
  type NotifyRegistration,
  type NotifyReplyState,
} from './notify-callbacks'

export type Level = 'info' | 'warn' | 'error'
const VALID_LEVELS: ReadonlySet<Level> = new Set(['info', 'warn', 'error'])

export type ButtonType = 'default' | 'primary' | 'danger'
const VALID_BUTTON_TYPES: ReadonlySet<ButtonType> = new Set(['default', 'primary', 'danger'])
/** Button id charset/length — kept tight so it survives round-tripping
 * through Feishu's `value` payload and is safe to echo in logs/toasts. */
const BUTTON_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/** Button label length cap. Generous (not 1-2 chars) because each button
 * owns its full-width row and may carry a short phrase; a paragraph-long
 * label is a caller mistake worth rejecting rather than rendering. */
const BUTTON_TEXT_MAX = 64
const MIXED_INTERACTION_ERROR = '"buttons" and "allow_reply":true are mutually exclusive; choose button selection or text reply'
const MAX_BODY_BYTES = 4 * 1024 * 1024
const REQUEST_ID_MAX = 200
const VERSIONED_FIELDS = new Set([
  'request_id', 'version', 'project', 'text', 'title', 'level', 'images', 'buttons', 'allow_reply', 'callback',
])

export interface ParsedButton {
  id: string
  text: string
  type: ButtonType
  /**
   * Optional https? URL. When set, the button uses Feishu `open_url`
   * behavior (native browser open) instead of a notify callback.
   * Pure open_url cards do not need `callback` / notify registration.
   */
  url?: string
}

/** Value payload baked into every notify button — routes the click back
 * to this notify's registration in `handleCardAction`. */
interface NotifyActionValue {
  kind: 'notify_callback'
  notify_id: string
  button_id: string
  version?: number
  project?: string
}

/** Post-click card state. The card transitions through these as a click
 * is processed, replacing the button row with a status marker:
 *   - `processing` (push mode only): click received, push in flight
 *   - `delivered`: push acked 2xx → final success marker
 *   - `failed`: push rejected/timeout → inline failure reason
 *   - `unknown`: external callback succeeded but durable local confirmation
 *                failed — freeze and forbid automatic retry
 *   - `done`: pull / display-only mode — no push, freeze on the verdict
 * `operatorOpenId` is carried in the callback payload for the caller's
 * audit; the card itself shows only the choice + status. */
export type NotifyResolutionStatus = 'processing' | 'delivered' | 'failed' | 'unknown' | 'done'
export interface NotifyResolution {
  status: NotifyResolutionStatus
  buttonId?: string
  kind?: 'text'
  text: string
  operatorOpenId: string
  /** Failure reason — only when `status === 'failed'`. */
  detail?: string
  /** Caller's reply (push mode, `delivered` only) — the text the caller
   * returned in its 2xx callback response. Rendered as its own line on
   * the final card so the caller can report an outcome. Feishu markdown
   * is allowed (caller can format). */
  reply?: string
}

export function buildNotifyCard(opts: {
  title: string
  text: string
  level: Level
  /** Uploaded images, in insertion order. `key==''` marks an upload
   * failure — rendered as an inline red error so the caller sees it. */
  images?: Array<{ key: string; src: string; error?: string }>
  /** Interactive buttons. Rendered as an equal-weight column_set row.
   * Requires `notifyId` so each button's `value` carries the routing
   * payload back to the click handler. */
  buttons?: ParsedButton[]
  /** Text-reply mode. Mutually exclusive with nonempty buttons. */
  allowReply?: boolean
  notifyId?: string
  project?: string
  /** Durable transport view. Included in callback values for new-mode cards. */
  version?: number
  /** Post-click status marker — replaces the button row. See
   * {@link NotifyResolutionStatus} for the transitions. */
  resolution?: NotifyResolution
}): object {
  if (opts.allowReply && opts.buttons?.length) throw new Error(MIXED_INTERACTION_ERROR)
  const template = opts.level === 'error' ? 'red'
    : opts.level === 'warn' ? 'yellow'
    : 'blue'
  const emoji = opts.level === 'error' ? '❌'
    : opts.level === 'warn' ? '⚠️'
    : '🔔'
  const hasButtons = !!(opts.buttons?.length)
  // Callback buttons need notifyId; pure open_url buttons do not.
  const hasCallbackButtons = !!(opts.buttons?.some((b) => !b.url) && opts.notifyId)
  const interactive = hasButtons || (!!opts.allowReply && !!opts.notifyId)
  const d = new Date()
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const elements: object[] = []
  for (const img of opts.images ?? []) {
    if (img.key) {
      // Card JSON 2.0 图片组件 tag 固定为 "img"(非 "image"),alt 为必填 struct。
      elements.push({ tag: 'img', img_key: img.key, alt: { tag: 'plain_text', content: 'screenshot' } })
    } else {
      // No silent fallback: surface the failed upload inline so the caller
      // knows which local image never made it onto the card.
      const detail = img.error ? `\n${sanitizeMarkdownForCardKit(img.error)}` : ''
      elements.push({ tag: 'markdown', content: `<font color='red'>📷 图片上传失败: ${img.src}${detail}</font>` })
    }
  }
  elements.push({ tag: 'markdown', content: downgradeExternalImagesForCardKit(opts.text ?? '') || '_（空消息）_' })

  if (opts.resolution) {
    // Post-click status marker normally replaces the button row: every
    // resolution state drops the choose buttons. A definite callback failure
    // is the one retryable terminal state, so an allowReply card keeps its
    // 「回复」 control via canAnswer below.
    const r = opts.resolution
    const choice = r.kind === 'text' ? '已回复' : `已选择:${r.text}`
    let marker: string
    if (r.status === 'processing') {
      marker = `<font color='blue'>⏳ ${choice} · 推送中…</font>`
    } else if (r.status === 'failed') {
      marker = `<font color='red'>⚠️ ${r.kind === 'text' ? choice : `已选:${r.text}`} · 回调失败:${sanitizeMarkdownForCardKit(r.detail ?? '未知')} · ${hhmm}</font>`
    } else if (r.status === 'delivered') {
      marker = `<font color='green'>✅ ${choice} · 反馈已送达 · ${hhmm}</font>`
    } else if (r.status === 'unknown') {
      // 外部回调已成功但本地墓碑未确认(ec149d7):冻结并禁止自动重试,
      // 与 daemon 侧 unknownAt 准入冻结(01-05)同一语义的可见终态。
      marker = `<font color='red'>⚠️ ${choice} · ${r.kind === 'text' ? '送达状态未知，禁止自动重试' : '外部回调已成功，但本地确认状态未知，禁止自动重试'} · ${hhmm}</font>`
    } else {
      // 'done' — pull / display-only mode (no push to acknowledge).
      marker = `<font color='green'>✅ ${choice} · ${hhmm}</font>`
    }
    elements.push({ tag: 'markdown', content: marker })
    // Caller's reply (push mode, delivered) — its own line below the
    // marker, so the caller can surface an outcome to the group. 与
    // opts.text 同一变体:reply 也是 notify 调用方文本,允许 <font> 彩色,
    // 只降级外链图片防炸卡(外链 url 被当 img_key 拒会让整次 update 失败)。
    if (r.status === 'delivered' && r.reply) {
      elements.push({ tag: 'markdown', content: downgradeExternalImagesForCardKit(r.reply) })
    }
  }
  // 明确回调失败是唯一可重试的终态(上游 ae411a6):回复按钮据此保留,
  // 其余终态(processing/delivered/done/unknown)不再可答。
  const canAnswer = interactive && (!opts.resolution || opts.resolution.status === 'failed')
  if ((!opts.resolution || opts.resolution.status === 'failed') && hasButtons) {
    // One full-width column whose elements stack vertically ⇒ each
    // button gets its own row. open_url buttons always render; callback
    // buttons require notifyId (otherwise they'd ship a dead value —
    // silently drop them, preserving pre-open_url safety).
    const rendered = opts.buttons!.flatMap((btn): object[] => {
      if (btn.url) {
        return [{
          tag: 'button',
          text: { tag: 'plain_text', content: btn.text },
          type: btn.type,
          behaviors: [{
            type: 'open_url' as const,
            default_url: btn.url,
            android_url: btn.url,
            ios_url: btn.url,
            pc_url: btn.url,
          }],
        }]
      }
      if (!opts.notifyId) return []
      return [{
        tag: 'button',
        text: { tag: 'plain_text', content: btn.text },
        type: btn.type,
        behaviors: [{
          type: 'callback' as const,
          value: {
            kind: 'notify_callback',
            notify_id: opts.notifyId,
            button_id: btn.id,
            ...(opts.version !== undefined ? { version: opts.version } : {}),
            ...(opts.project !== undefined ? { project: opts.project } : {}),
          } as NotifyActionValue,
        }],
      }]
    })
    if (rendered.length > 0) {
      elements.push({
        tag: 'column_set',
        columns: [{
          tag: 'column',
          width: 'weighted',
          weight: 1,
          elements: rendered,
        }],
      })
    }
  }

  elements.push({ tag: 'hr' })
  elements.push({ tag: 'markdown', content: `<font color='grey'>via notify · ${hhmm}</font>` })
  if (canAnswer && opts.allowReply) {
    // Text-reply cards have one fixed control at the bottom, after the footer.
    elements.push({ tag: 'column_set', columns: [{
      tag: 'column', width: 'weighted', weight: 1,
      elements: [{
        tag: 'button', text: { tag: 'plain_text', content: '回复' }, type: 'primary',
        behaviors: [{ type: 'callback', value: {
          kind: 'notify_reply', notify_id: opts.notifyId,
          ...(opts.version !== undefined ? { version: opts.version } : {}),
          ...(opts.project !== undefined ? { project: opts.project } : {}),
        } }],
      }],
    }] })
  }
  // update_multi only when the card can freeze for the whole group: callback
  // buttons or a text-reply reservation. Pure open_url cards are one-shot
  // navigation — no update.
  const groupUpdatable = hasCallbackButtons || (!!opts.allowReply && !!opts.notifyId)
  return {
    schema: '2.0',
    config: groupUpdatable ? { update_multi: true } : {},
    header: {
      title: { tag: 'plain_text', content: `${emoji} ${opts.title}` },
      template,
    },
    body: { elements },
  }
}

/** A separate message owns the input conversation; the notification itself
 * remains recognizable while this card changes from waiting to a receipt. */
export function buildNotifyReplyCard(
  reg: NotifyRegistration,
  state: NotifyReplyState,
  resolution?: { status: NotifyResolutionStatus; detail?: string; reply?: string },
): object {
  const status = resolution?.status ?? state.status
  const labels: Record<string, string> = {
    waiting: '等待用户输入', sending: '正在发送回复', processing: '正在发送回复',
    delivered: '回复已送达', done: '回复已记录', failed: '回复发送失败',
    cancelled: '已取消回复', unknown: '回复送达状态未知',
  }
  const elements: object[] = [{ tag: 'markdown', content: `通知：${sanitizeMarkdownForCardKit(reg.title)}` }]
  if (state.response) elements.push({ tag: 'markdown', content: sanitizeMarkdownForCardKit(state.response.text) })
  if (status === 'waiting') {
    elements.push({ tag: 'markdown', content: `<at id=${state.openId}></at> 请在群里发送一条文字消息作为回复。\n你的下一条文字优先用于这条通知，完成后再回答 Agent 的提问。点击其他通知的「回复」会放弃本次回复；群控制命令仍然优先。` })
    elements.push({ tag: 'button', text: { tag: 'plain_text', content: '取消回复' }, type: 'default',
      behaviors: [{ type: 'callback', value: {
        kind: 'notify_reply_cancel', notify_id: reg.notifyId, reply_id: state.id,
        ...(state.version !== undefined ? { version: state.version } : {}),
        ...(reg.requestId ? { project: reg.project } : {}),
      } }],
    })
  }
  if (status === 'cancelled' && state.cancelReason === 'switched') {
    elements.push({ tag: 'markdown', content: '已切换到另一条通知，本次回复已放弃。' })
  }
  const detail = resolution?.detail ?? state.error
  if (detail) elements.push({ tag: 'markdown', content: `<font color='red'>${sanitizeMarkdownForCardKit(detail)}</font>` })
  if (status === 'failed') elements.push({ tag: 'markdown', content: '请点击原通知的「回复」按钮后重新输入。' })
  if (status === 'unknown') elements.push({ tag: 'markdown', content: '无法确认是否已送达，请联系通知发起方核实；已禁止自动重试。' })
  if (resolution?.reply) elements.push({ tag: 'markdown', content: sanitizeMarkdownForCardKit(resolution.reply) })
  return {
    schema: '2.0', config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: labels[status] },
      template: status === 'failed' || status === 'unknown' ? 'red'
        : status === 'delivered' || status === 'done' ? 'green' : 'blue',
    },
    body: { elements },
  }
}

/** Validate the `buttons` array from the request body. Returns the
 * parsed buttons or a single `{error}` — never throws, never coerces
 * bad input into a "safe" default. Empty array ⇒ no buttons (caller
 * treats as absent). */
export function parseButtons(raw: unknown): { buttons?: ParsedButton[]; error?: string } {
  if (raw === undefined || raw === null) return { buttons: [] }
  if (!Array.isArray(raw)) return { error: '"buttons" must be an array' }
  if (raw.length === 0) return { buttons: [] }
  // No count cap: each button stacks on its own row, so any number the
  // caller supplies renders. (Feishu's own element-count limit, if a
  // pathological payload ever hits it, surfaces as a sendCard 502.)
  const seen = new Set<string>()
  const out: ParsedButton[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return { error: 'each button must be an object' }
    const id = String((entry as any).id ?? '').trim()
    const text = String((entry as any).text ?? '').trim()
    if (!BUTTON_ID_RE.test(id)) {
      return { error: `button id "${id.slice(0, 32)}" invalid (need ^[A-Za-z0-9_-]{1,64}$)` }
    }
    if (!text) return { error: `button "${id}" missing text` }
    if (text.length > BUTTON_TEXT_MAX) {
      return { error: `button "${id}" text > ${BUTTON_TEXT_MAX} chars` }
    }
    if (seen.has(id)) return { error: `button id "${id}" duplicated` }
    seen.add(id)
    const typeRaw = String((entry as any).type ?? 'default').toLowerCase()
    const type: ButtonType = VALID_BUTTON_TYPES.has(typeRaw as ButtonType)
      ? (typeRaw as ButtonType)
      : 'default'
    const urlRaw = (entry as any).url
    let url: string | undefined
    if (urlRaw !== undefined && urlRaw !== null && String(urlRaw).trim() !== '') {
      const u = String(urlRaw).trim()
      let parsed: URL
      try { parsed = new URL(u) } catch {
        return { error: `button "${id}" url is not a valid URL` }
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { error: `button "${id}" url must be http(s), got "${parsed.protocol}"` }
      }
      if (u.length > 2000) return { error: `button "${id}" url too long` }
      url = u
    }
    out.push(url ? { id, text, type, url } : { id, text, type })
  }
  return { buttons: out }
}

/** Validate the `callback` URL — must be loopback HTTP, matching the
 * "本机内的 http" contract. Non-loopback / https / garbage ⇒ `{error}`
 * with the actual reason; never silently widened. */
export function parseCallbackUrl(raw: unknown): { url?: string; error?: string } {
  if (raw === undefined || raw === null) return {}  // absent — caller decides if that's allowed
  const s = String(raw).trim()
  if (!s) return {}
  let u: URL
  try { u = new URL(s) } catch { return { error: `"callback" bad URL: "${s.slice(0, 64)}"` } }
  if (u.protocol !== 'http:') {
    return { error: `"callback" must be http (本机内), got "${u.protocol}"` }
  }
  // `URL.hostname` keeps the brackets for IPv6 ("[::1]"); strip them so
  // the loopback set matches the bare address.
  const h = u.hostname.replace(/^\[|]$/g, '')
  if (h !== '127.0.0.1' && h !== 'localhost' && h !== '::1') {
    return { error: `"callback" must be loopback (本机内), got "${u.hostname}"` }
  }
  return { url: s }
}

export interface NotifyOptions {
  bind: string
  port: number
  extraHandler?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>
}

/** Test/daemon seam: extraHandler true = already handled, skip /notify. */
export async function dispatchNotifyRequest(
  opts: NotifyOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Routing only needs the request target. Never let an untrusted Host
  // header escape the async error boundary and crash the HTTP listener.
  let url: URL
  try { url = new URL(req.url ?? '/', 'http://localhost') }
  catch {
    res.statusCode = 400
    res.end('bad request URL')
    return
  }
  // Reaching this port is treated as the owner's own request; a browser page must not
  // reach it (any page can POST to loopback). Reject cross-origin browser callers.
  if (isCrossOriginBrowserRequest(req.headers)) {
    log('notify.request.cross_origin_rejected')
    res.statusCode = 403
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end('cross-origin requests are not accepted')
    return
  }
  if (opts.extraHandler) {
    const handled = await opts.extraHandler(req, res, url)
    if (handled) return
  }
  await handleNotifyRequest(req, res)
}

/**
 * Reaching this port is treated as the owner's own request, and a browser breaks that:
 * any page can send a no-preflight POST to a loopback address. Browsers always attach
 * `Origin` to such a request, while the local callers this server exists for (curl,
 * scripts, agents, Node/Bun/Python clients) send none. A page served from loopback
 * itself remains a local caller.
 */
export function isCrossOriginBrowserRequest(headers: IncomingHttpHeaders): boolean {
  if (headers['sec-fetch-site'] === 'cross-site') return true
  const origin = headers.origin
  if (origin === undefined) return false
  // `null` (sandboxed frames, file: pages) and malformed values are not local origins.
  try { return !isLoopback(new URL(String(origin))) } catch { return true }
}

export function startNotifyServer(opts: NotifyOptions): Server | undefined {
  // node:http instead of Bun.serve so the same source runs on both
  // Bun (dev: `bun daemon.ts`) and Node (prod: `源码构建后 npm i -g .`).
  // Bun has full node:http compat so dev behavior is byte-for-byte preserved.
  try {
    const server = createServer((req, res) => {
      dispatchNotifyRequest(opts, req, res).catch((err: any) => {
        logError('notify.handler.failed', err)
        if (!res.headersSent) {
          res.statusCode = 500
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          res.end(err instanceof FeishuRequestError ? formatFeishuError(err) : 'internal error')
        } else {
          try { res.end() } catch {}
        }
      })
    })
    server.on('error', (err: Error) => {
      logError('notify.server.bind_failed', err)
    })
    server.listen(opts.port, opts.bind, () => {
      log('notify.server.ready')
    })
    return server
  } catch (e) {
    logError('notify.server.bind_failed', e)
  }
}

type NotifyTransport = Pick<typeof feishu,
  'sanitizeSessionName' | 'chatIdForSession' | 'uploadImageKey' | 'sendCard'>
  & Partial<Pick<typeof feishu, 'updateCard'>>

function parseVersion(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null
}

function failureCode(error: unknown): string | number | undefined {
  const value = error as any
  return value?.code ?? value?.response?.data?.code ?? value?.cause?.code
}

function normalizedVersionedBody(body: any): { desired?: NotifyDesiredBody; error?: string } {
  const project = typeof body.project === 'string' ? body.project.trim() : ''
  const text = typeof body.text === 'string' ? body.text : ''
  const titleRaw = typeof body.title === 'string' ? body.title.trim() : ''
  if (body.title !== undefined && typeof body.title !== 'string') return { error: '"title" must be a string' }
  if (body.level !== undefined && typeof body.level !== 'string') return { error: '"level" must be a string' }
  if (body.callback !== undefined && typeof body.callback !== 'string') return { error: '"callback" must be a string' }
  const levelRaw = (body.level ?? 'info').toLowerCase()
  if (!project) return { error: 'missing "project"' }
  if (!text) return { error: 'missing "text"' }
  if (body.allow_reply !== undefined && typeof body.allow_reply !== 'boolean') {
    return { error: '"allow_reply" must be a boolean' }
  }
  if (body.images !== undefined && !Array.isArray(body.images)) return { error: '"images" must be an array' }
  if (Array.isArray(body.images) && body.images.some((entry: unknown) => typeof entry !== 'string')) {
    return { error: 'each image must be a string path' }
  }
  const { buttons, error: buttonsError } = parseButtons(body.buttons)
  if (buttonsError) return { error: buttonsError }
  const { url: callbackUrl, error: callbackError } = parseCallbackUrl(body.callback)
  if (callbackError) return { error: callbackError }
  const allowReply = body.allow_reply === true
  if (allowReply && buttons?.length) return { error: MIXED_INTERACTION_ERROR }
  const images = (body.images ?? []).map((entry: unknown) => String(entry ?? '').trim()).filter(Boolean)
  return {
    desired: {
      project,
      title: titleRaw || project,
      text,
      level: (VALID_LEVELS.has(levelRaw as Level) ? levelRaw : 'info') as Level,
      images,
      buttons: buttons ?? [],
      allowReply,
      callbackUrl: callbackUrl ?? '',
    },
  }
}

async function uploadNotifyImages(
  desired: NotifyDesiredBody,
  transport: NotifyTransport,
): Promise<Array<{ key: string; src: string; error?: string }>> {
  const images: Array<{ key: string; src: string; error?: string }> = []
  for (const src of desired.images) {
    let failure: unknown
    const key = await transport.uploadImageKey(src, error => { failure = error })
    images.push({ key: key ?? '', src, ...(failure === undefined ? {} : { error: formatFeishuError(failure) }) })
  }
  return images
}

function transportResult(reg: NotifyRegistration, ok = reg.transportState === 'applied'): object {
  return {
    ok,
    chat_id: reg.chatId,
    ...(reg.messageId ? { message_id: reg.messageId } : {}),
    notify_id: reg.notifyId,
    request_id: reg.requestId,
    transport_state: reg.transportState,
    version: reg.desiredVersion,
    applied_version: reg.appliedVersion,
    ...(reg.transportDetail ? { detail: reg.transportDetail } : {}),
  }
}

function setTransportUnknown(reg: NotifyRegistration, detail: string): void {
  try {
    mutateRegistration(reg.notifyId, current => {
      current.transportState = 'unknown'
      current.transportDetail = detail
      current.unknownAt = Date.now()
      current.unknownReason = detail
      delete current.unknownBy
      current.updatedAt = Date.now()
    })
  } catch {
    // The successful/possibly-successful Feishu side effect already happened.
    // Retain the in-memory freeze even when the state file is unavailable.
    reg.transportState = 'unknown'
    reg.transportDetail = detail
    reg.unknownAt = Date.now()
    reg.unknownReason = detail
    delete reg.unknownBy
    reg.updatedAt = Date.now()
  }
}

function applyDesiredToRegistration(
  reg: NotifyRegistration,
  desired: NotifyDesiredBody,
  desiredHash: string,
  version: number,
  imageKeys?: Array<{ key: string; src: string; error?: string }>,
): void {
  reg.project = desired.project
  reg.title = desired.title
  reg.text = desired.text
  reg.level = desired.level
  reg.callbackUrl = desired.callbackUrl
  reg.buttons = desired.buttons
  reg.allowReply = desired.allowReply
  reg.imageKeys = imageKeys ?? desired.images.map(src => ({ key: '', src, error: 'upload pending' }))
  reg.desiredBody = desired
  reg.desiredHash = desiredHash
  reg.desiredVersion = version
  reg.transportState = 'pending'
  delete reg.transportDetail
  reg.updatedAt = Date.now()
}

export async function handleNotifyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  transport: NotifyTransport = feishu,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')

  const sendText = (status: number, body: string): void => {
    res.statusCode = status
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end(body)
  }
  const sendJson = (status: number, obj: object): void => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(obj))
  }

  if (req.method === 'GET' && url.pathname === '/') {
    return sendText(200,
      'lodestar notify\n' +
      'POST /notify        body={project,text,title?,level?,images?,buttons?,allow_reply?,callback?,request_id?,version?}  → push card to the project\'s bound conversation ID (chat_id)\n' +
      'PUT  /notify/<notify_id>  body={project,version,...complete card fields}  → update the original versioned message in place\n' +
      'GET  /notify/result/<notify_id>  → poll a button choice or text reply (pull mode, no callback server)\n' +
      'GET  /agents/identities; POST/GET/DELETE /agents/runs[/<id>]  → capability-protected delegated Agents\n' +
      'POST /agents/relays/test|configure|reload  → capability-protected relay validation and hot reload\n' +
      'levels: info|warn|error (default info); images=[/abs/*.png] uploaded + embedded\n' +
      'card types: plain (neither field), selection (buttons), text reply (allow_reply:true); do not combine buttons and allow_reply:true\n' +
      'all types support text + images; callback=http://127.0.0.1:PORT/path optional for selection/reply (push) — omit to poll\n')
  }
  // Pull mode: stateless callers retrieve a button card's verdict
  // without running a callback server. Returns resolved:false while
  // pending; the chosen button + operator once a click froze the card.
  if (req.method === 'GET' && url.pathname.startsWith('/notify/result/')) {
    let id: string
    try { id = decodeURIComponent(url.pathname.slice('/notify/result/'.length)).trim() }
    catch { return sendText(400, 'invalid notify_id encoding') }
    if (!id) return sendText(400, 'missing notify_id in path')
    const reg = getCallback(id)
    if (!reg) return sendJson(404, { error: 'unknown notify_id', notify_id: id })
    return sendJson(200, buildNotifyResult(reg))
  }
  const putPrefix = '/notify/'
  const isCreate = req.method === 'POST' && url.pathname === '/notify'
  const isUpdate = req.method === 'PUT' && url.pathname.startsWith(putPrefix)
  if (!isCreate && !isUpdate) return sendText(405, 'use POST /notify or PUT /notify/:notify_id')

  let raw = ''
  let bytes = 0
  // IncomingMessage's decoder preserves multibyte characters across chunks.
  req.setEncoding('utf8')
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk)
    if (bytes <= MAX_BODY_BYTES) raw += chunk
    else raw = ''
  }
  if (bytes > MAX_BODY_BYTES) return sendText(413, `request body exceeds ${MAX_BODY_BYTES} bytes`)
  let body: any = {}
  try { body = JSON.parse(raw) } catch { return sendText(400, 'bad json') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return sendText(400, 'body must be an object')

  if (isUpdate) {
    let notifyId = ''
    try { notifyId = decodeURIComponent(url.pathname.slice(putPrefix.length)).trim() }
    catch { return sendJson(400, { error: 'invalid_notify_id_encoding' }) }
    if (!notifyId || notifyId.includes('/')) return sendJson(400, { error: 'missing_notify_id' })
    const version = parseVersion(body.version)
    if (version === null) return sendJson(400, { error: 'invalid_version' })
    for (const key of Object.keys(body)) {
      if (!VERSIONED_FIELDS.has(key)) return sendJson(400, { error: 'unknown_field', field: key })
    }
    const parsed = normalizedVersionedBody(body)
    if (!parsed.desired) return sendJson(400, { error: 'invalid_notify', detail: parsed.error })
    const desired = parsed.desired
    const desiredHash = canonicalNotifyHash(desired)
    return await withNotifyLock(`notify:${notifyId}`, async () => {
      const reg = getCallback(notifyId)
      if (!reg?.requestId) return sendJson(404, { error: 'unknown_notify_id', notify_id: notifyId })
      if (body.request_id !== undefined && body.request_id !== reg.requestId) {
        return sendJson(409, { error: 'request_id_conflict', ...transportResult(reg, false) })
      }
      const sessionName = transport.sanitizeSessionName(desired.project)
      const currentChatId = transport.chatIdForSession(sessionName)
      if (desired.project !== reg.project || !currentChatId || currentChatId !== reg.chatId || !reg.messageId) {
        return sendJson(409, { error: 'notify_binding_changed', ...transportResult(reg, false) })
      }
      if (version < (reg.desiredVersion ?? 0)) return sendJson(200, transportResult(reg))
      if (version === reg.desiredVersion && desiredHash !== reg.desiredHash) {
        return sendJson(409, { error: 'version_conflict', ...transportResult(reg, false) })
      }
      if (version === reg.desiredVersion && reg.transportState === 'unknown') {
        return sendJson(202, transportResult(reg, false))
      }
      if (reg.resolvedAt || reg.unknownAt || reg.dispatchState
        || reg.replyState?.status === 'waiting' || reg.replyState?.status === 'sending'
        || isDispatching(reg.notifyId)) {
        return sendJson(409, { error: 'notify_closed_or_answering', ...transportResult(reg, false) })
      }
      if (version === reg.desiredVersion && reg.transportState === 'applied'
        && reg.appliedVersion === version) return sendJson(200, transportResult(reg))
      if (version > (reg.desiredVersion ?? 0)) {
        try {
          mutateRegistration(reg.notifyId, current => applyDesiredToRegistration(current, desired, desiredHash, version))
        } catch (error) {
          return sendJson(500, { error: 'notify_state_persist_failed', detail: String(error) })
        }
      }
      const images = await uploadNotifyImages(desired, transport)
      try {
        mutateRegistration(reg.notifyId, current => applyDesiredToRegistration(current, desired, desiredHash, version, images))
      } catch (error) {
        return sendJson(500, { error: 'notify_state_persist_failed', detail: String(error) })
      }
      const card = buildNotifyCard({
        title: desired.title,
        text: desired.text,
        level: desired.level,
        images,
        buttons: desired.buttons as ParsedButton[],
        allowReply: desired.allowReply,
        notifyId: reg.notifyId,
        version,
        project: desired.project,
      })
      try {
        mutateRegistration(reg.notifyId, current => {
          current.updateDispatch = { version, startedAt: Date.now() }
          current.updatedAt = Date.now()
        })
      } catch (error) {
        return sendJson(500, { error: 'notify_state_persist_failed', detail: String(error) })
      }
      try {
        if (transport.updateCard) await transport.updateCard(reg.messageId, card)
        else await feishu.updateCard(reg.messageId, card)
      } catch (error) {
        setTransportUnknown(reg, `Feishu card update outcome is unknown: ${formatFeishuError(error)}`)
        return sendJson(202, { error: 'feishu_update_unknown', ...transportResult(reg, false) })
      }
      try {
        mutateRegistration(reg.notifyId, current => {
          current.transportState = 'applied'
          current.appliedVersion = version
          current.appliedHash = desiredHash
          current.appliedBody = desired
          delete current.updateDispatch
          delete current.transportDetail
          current.updatedAt = Date.now()
        })
      } catch (error) {
        setTransportUnknown(reg, `card update succeeded but local confirmation failed: ${error instanceof Error ? error.message : error}`)
        return sendJson(202, transportResult(reg, false))
      }
      return sendJson(200, transportResult(reg))
    })
  }

  const requestIdRaw = body.request_id
  const requestId = requestIdRaw === undefined ? '' : (typeof requestIdRaw === 'string' ? requestIdRaw.trim() : '')
  if (requestIdRaw === undefined && body.version !== undefined) {
    return sendJson(400, { error: 'version_requires_request_id' })
  }
  if (requestIdRaw !== undefined) {
    if (!requestId || [...requestId].length > REQUEST_ID_MAX) {
      return sendJson(400, { error: 'invalid_request_id' })
    }
    for (const key of Object.keys(body)) {
      if (!VERSIONED_FIELDS.has(key)) return sendJson(400, { error: 'unknown_field', field: key })
    }
    const version = body.version === undefined ? 1 : parseVersion(body.version)
    if (version === null) return sendJson(400, { error: 'invalid_version' })
    const parsed = normalizedVersionedBody(body)
    if (!parsed.desired) return sendJson(400, { error: 'invalid_notify', detail: parsed.error })
    const desired = parsed.desired
    const desiredHash = canonicalNotifyHash(desired)
    const requestHash = canonicalNotifyRequestHash(version, desired)
    return await withNotifyLock(`request:${requestId}`, async () => {
      let reg = getByRequestId(requestId)
      if (reg) {
        if (reg.requestHash !== requestHash) {
          return sendJson(409, { error: 'request_id_conflict', ...transportResult(reg, false) })
        }
        if (reg.messageId || reg.transportState === 'applied') {
          return sendJson(reg.transportState === 'applied' ? 200 : 202, transportResult(reg))
        }
        if (reg.transportState === 'unknown') return sendJson(202, transportResult(reg, false))
        const currentChatId = transport.chatIdForSession(transport.sanitizeSessionName(desired.project))
        if (!currentChatId || currentChatId !== reg.chatId || desired.project !== reg.project) {
          return sendJson(409, { error: 'notify_binding_changed', ...transportResult(reg, false) })
        }
        if (reg.createAttemptedAt !== undefined
          && Date.now() - reg.createAttemptedAt >= NOTIFY_CREATE_RETRY_WINDOW_MS) {
          setTransportUnknown(reg, 'notification creation exceeded Feishu UUID dedupe window')
          return sendJson(202, transportResult(reg, false))
        }
      } else {
        const sessionName = transport.sanitizeSessionName(desired.project)
        const chatId = transport.chatIdForSession(sessionName)
        if (!chatId) {
          log('notify.binding_missing')
          return sendJson(404, { error: 'notify_binding_missing', project: desired.project })
        }
        reg = {
          notifyId: `nf_${randomUUID()}`,
          callbackUrl: desired.callbackUrl,
          chatId,
          messageId: '',
          project: desired.project,
          title: desired.title,
          text: desired.text,
          level: desired.level,
          imageKeys: desired.images.map(src => ({ key: '', src, error: 'upload pending' })),
          buttons: desired.buttons,
          allowReply: desired.allowReply,
          createdAt: Date.now(),
          requestId,
          requestHash,
          requestVersion: version,
          requestBody: desired,
          feishuUuid: randomUUID(),
          transportState: 'pending',
          desiredVersion: version,
          appliedVersion: 0,
          desiredHash,
          desiredBody: desired,
          updatedAt: Date.now(),
        }
        try { registerCallback(reg) }
        catch (error) {
          return sendJson(500, { error: 'notify_state_persist_failed', detail: String(error) })
        }
      }

      return await withNotifyLock(`notify:${reg.notifyId}`, async () => {
        const images = await uploadNotifyImages(desired, transport)
        try {
          mutateRegistration(reg.notifyId, current => applyDesiredToRegistration(current, desired, desiredHash, version, images))
        } catch (error) {
          return sendJson(500, { error: 'notify_state_persist_failed', detail: String(error) })
        }
        const card = buildNotifyCard({
          title: desired.title,
          text: desired.text,
          level: desired.level,
          images,
          buttons: desired.buttons as ParsedButton[],
          allowReply: desired.allowReply,
          notifyId: reg.notifyId,
          version,
          project: desired.project,
        })
        if (reg.createAttemptedAt === undefined) {
          try {
            mutateRegistration(reg.notifyId, current => {
              current.createAttemptedAt = Date.now()
              current.updatedAt = Date.now()
            })
          } catch (error) {
            return sendJson(500, { error: 'notify_state_persist_failed', detail: String(error) })
          }
        }
        let sendFailure: unknown
        const messageId = await transport.sendCard(
          reg.chatId,
          card,
          error => { sendFailure = error },
          reg.feishuUuid,
        )
        if (!messageId) {
          if (String(failureCode(sendFailure)) === '200770') {
            setTransportUnknown(reg, 'Feishu consumed the stable UUID without returning a recoverable message_id')
            return sendJson(202, transportResult(reg, false))
          }
          try {
            mutateRegistration(reg.notifyId, current => {
              current.transportState = 'pending'
              current.transportDetail = formatFeishuError(sendFailure)
              current.updatedAt = Date.now()
            })
          } catch {}
          return sendJson(502, { error: 'feishu_send_failed', ...transportResult(reg, false) })
        }
        try {
          mutateRegistration(reg.notifyId, current => {
            current.messageId = messageId
            current.transportState = 'applied'
            current.appliedVersion = version
            current.appliedHash = desiredHash
            current.appliedBody = desired
            delete current.transportDetail
            current.updatedAt = Date.now()
          })
        } catch (error) {
          setTransportUnknown(reg, `card send succeeded but local confirmation failed: ${error instanceof Error ? error.message : error}`)
          return sendJson(202, transportResult(reg, false))
        }
        return sendJson(200, transportResult(reg))
      })
    })
  }
  if (body.allow_reply !== undefined && typeof body.allow_reply !== 'boolean') {
    return sendText(400, '"allow_reply" must be a boolean')
  }
  const allowReply = body.allow_reply === true

  const project = String(body.project ?? '').trim()
  const text = String(body.text ?? '')
  const titleRaw = String(body.title ?? '').trim()
  const levelRaw = String(body.level ?? 'info').toLowerCase()
  if (!project) return sendText(400, 'missing "project"')
  if (!text)    return sendText(400, 'missing "text"')

  const { buttons, error: buttonsError } = parseButtons(body.buttons)
  if (buttonsError) return sendText(400, buttonsError)
  const { url: callbackUrl, error: callbackError } = parseCallbackUrl(body.callback)
  if (callbackError) return sendText(400, callbackError)
  // Buttons + callback is the push model (daemon POSTs the click).
  // Buttons without callback is the pull / display-only model: the
  // caller polls GET /notify/result/<id>, or just reads the frozen card.
  // Pure open_url buttons (url set) need neither registration nor notify_id.
  const hasButtons = !!(buttons && buttons.length)
  if (hasButtons && allowReply) return sendText(400, MIXED_INTERACTION_ERROR)
  const hasCallbackButtons = !!(buttons && buttons.some((b) => !b.url))
  // 本地:纯 open_url 卡没有回调面,不申请 notify_id、不落注册(上游此处
  // 无 open_url 概念);文本回复卡必须注册,否则回复态无处落盘。
  const notifiable = hasCallbackButtons || allowReply
  const callbackUrlOrDefault = callbackUrl ?? ''

  const level: Level = (VALID_LEVELS.has(levelRaw as Level) ? levelRaw : 'info') as Level
  const title = titleRaw || project

  const sessionName = transport.sanitizeSessionName(project)
  const chatId = transport.chatIdForSession(sessionName)
  if (!chatId) {
    log('notify.binding_missing')
    return sendText(404,
      `project "${project}" has no conversation ID (chat_id) binding — send a message in the intended Feishu conversation, then retry`)
  }

  const imageInputs = Array.isArray(body.images) ? body.images : []
  const images: Array<{ key: string; src: string; error?: string }> = []
  for (const entry of imageInputs) {
    const src = String(entry ?? '').trim()
    if (!src) continue
    let failure: unknown
    const key = await transport.uploadImageKey(src, error => { failure = error })
    images.push({ key: key ?? '', src, ...(failure === undefined ? {} : { error: formatFeishuError(failure) }) })
  }

  // notify_id is generated up-front so it can be baked into every button's
  // `value` payload (and the fixed reply button) BEFORE sendCard.
  const notifyId = notifiable ? `nf_${randomUUID()}` : ''
  const card = buildNotifyCard({ title, text, level, images, buttons, allowReply, notifyId })
  let sendFailure: unknown
  const messageId = await transport.sendCard(chatId, card, error => { sendFailure = error })
  if (!messageId) {
    logError('notify.card.send_failed', sendFailure)
    return sendText(502, `feishu sendCard failed: ${formatFeishuError(sendFailure)}`)
  }

  if (notifiable && notifyId) {
    const reg: NotifyRegistration = {
      notifyId,
      callbackUrl: callbackUrlOrDefault,
      chatId,
      messageId,
      project,
      title,
      text,
      level,
      imageKeys: images,
      // Persist callback buttons only (open_url need no freeze/rebuild).
      buttons: (buttons as NotifyButton[]).filter((b) => !(b as ParsedButton).url),
      allowReply,
      createdAt: Date.now(),
    }
    registerCallback(reg)
  }

  sendJson(200, {
    ok: true,
    chat_id: chatId,
    message_id: messageId,
    ...(notifyId ? { notify_id: notifyId } : {}),
  })
}

// Daemon-side handle to rebuild a post-click card from a stored
// registration without re-deriving the param shape.
export function buildNotifyCardFromReg(
  reg: NotifyRegistration,
  resolution: NotifyResolution,
): object {
  return buildNotifyCard({
    title: reg.title,
    text: reg.text,
    level: reg.level,
    images: reg.imageKeys,
    buttons: reg.buttons,
    allowReply: reg.allowReply,
    notifyId: reg.notifyId,
    version: reg.requestId ? reg.appliedVersion : undefined,
    project: reg.requestId ? reg.project : undefined,
    resolution,
  })
}
