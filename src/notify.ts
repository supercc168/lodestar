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
 *       "images":  ["/abs/a.png", ...]         // optional, uploaded + embedded
 *     }
 *   → 200 { ok: true, chat_id, message_id }
 *   → 400 bad/empty json or missing field
 *   → 404 project not bound to any Feishu group
 *   → 502 feishu sendCard failed (network / API rejection)
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

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { log } from './log'
import * as feishu from './feishu'

export type Level = 'info' | 'warn' | 'error'
const VALID_LEVELS: ReadonlySet<Level> = new Set(['info', 'warn', 'error'])

function notifyCard(opts: {
  title: string
  text: string
  level: Level
  /** Uploaded images, in insertion order. `key==''` marks an upload
   * failure — rendered as an inline red error so the caller sees it. */
  images?: Array<{ key: string; src: string }>
}): object {
  const template = opts.level === 'error' ? 'red'
    : opts.level === 'warn' ? 'yellow'
    : 'blue'
  const emoji = opts.level === 'error' ? '❌'
    : opts.level === 'warn' ? '⚠️'
    : '🔔'
  const d = new Date()
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const elements: object[] = []
  for (const img of opts.images ?? []) {
    if (img.key) {
      elements.push({ tag: 'image', img_key: img.key, alt: { tag: 'plain_text', content: 'screenshot' } })
    } else {
      // No silent fallback: surface the failed upload inline so the caller
      // knows which local image never made it onto the card.
      elements.push({ tag: 'markdown', content: `<font color='red'>📷 图片上传失败: ${img.src}</font>` })
    }
  }
  elements.push({ tag: 'markdown', content: opts.text || '_（空消息）_' })
  elements.push({ tag: 'hr' })
  elements.push({ tag: 'markdown', content: `<font color='grey'>via notify · ${hhmm}</font>` })
  return {
    schema: '2.0',
    config: {},
    header: {
      title: { tag: 'plain_text', content: `${emoji} ${opts.title}` },
      template,
    },
    body: { elements },
  }
}

export interface NotifyOptions {
  bind: string
  port: number
}

export function startNotifyServer(opts: NotifyOptions): void {
  // node:http instead of Bun.serve so the same source runs on both
  // Bun (dev: `bun daemon.ts`) and Node (prod: `npm i -g @leviyuan/lodestar`).
  // Bun has full node:http compat so dev behavior is byte-for-byte preserved.
  try {
    const server = createServer((req, res) => {
      handleNotifyRequest(req, res).catch((err: any) => {
        log(`notify: handler crash: ${err?.message ?? err}`)
        if (!res.headersSent) {
          res.statusCode = 500
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          res.end('internal error')
        } else {
          try { res.end() } catch {}
        }
      })
    })
    server.on('error', (err: Error) => {
      log(`notify: server bind failed (${opts.bind}:${opts.port}): ${err.message}`)
    })
    server.listen(opts.port, opts.bind, () => {
      log(`notify: HTTP listening at http://${opts.bind}:${opts.port}/notify`)
    })
  } catch (e) {
    log(`notify: server bind failed (${opts.bind}:${opts.port}): ${e}`)
  }
}

async function handleNotifyRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

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
      'POST /notify        body={project,text,title?,level?,images?}  → push card to group\n' +
      'levels: info|warn|error (default info); images=[/abs/*.png] uploaded + embedded\n')
  }
  if (req.method !== 'POST' || url.pathname !== '/notify') {
    return sendText(405, 'use POST /notify')
  }

  let raw = ''
  for await (const chunk of req) raw += chunk.toString()
  let body: any = {}
  try { body = JSON.parse(raw) } catch { return sendText(400, 'bad json') }

  const project = String(body.project ?? '').trim()
  const text = String(body.text ?? '')
  const titleRaw = String(body.title ?? '').trim()
  const levelRaw = String(body.level ?? 'info').toLowerCase()
  if (!project) return sendText(400, 'missing "project"')
  if (!text)    return sendText(400, 'missing "text"')

  const level: Level = (VALID_LEVELS.has(levelRaw as Level) ? levelRaw : 'info') as Level
  const title = titleRaw || project

  const sessionName = feishu.sanitizeSessionName(project)
  const chatId = feishu.chatIdForSession(sessionName)
  if (!chatId) {
    log(`notify: project "${project}" (sanitized "${sessionName}") has no chat binding → 404`)
    return sendText(404,
      `project "${project}" not bound — send any message in that Feishu group at least once after the daemon started, then retry`)
  }

  const imageInputs = Array.isArray(body.images) ? body.images : []
  const images: Array<{ key: string; src: string }> = []
  for (const entry of imageInputs) {
    const src = String(entry ?? '').trim()
    if (!src) continue
    const key = await feishu.uploadImageKey(src)
    images.push({ key: key ?? '', src })
  }

  const card = notifyCard({ title, text, level, images })
  const messageId = await feishu.sendCard(chatId, card)
  if (!messageId) {
    log(`notify: sendCard failed → 502 (project="${project}" chat=${chatId.slice(0, 8)}…)`)
    return sendText(502, 'feishu sendCard failed (see daemon log)')
  }
  log(`notify: → ${project} (${chatId.slice(0, 8)}…) level=${level} bytes=${text.length} images=${images.length} msg=${messageId}`)
  sendJson(200, { ok: true, chat_id: chatId, message_id: messageId })
}
