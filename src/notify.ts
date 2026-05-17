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

import { log } from './log'
import * as feishu from './feishu'

type Level = 'info' | 'warn' | 'error'
const VALID_LEVELS: ReadonlySet<Level> = new Set(['info', 'warn', 'error'])

function notifyCard(opts: { title: string; text: string; level: Level }): object {
  const template = opts.level === 'error' ? 'red'
    : opts.level === 'warn' ? 'yellow'
    : 'blue'
  const emoji = opts.level === 'error' ? '❌'
    : opts.level === 'warn' ? '⚠️'
    : '🔔'
  const d = new Date()
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return {
    schema: '2.0',
    config: {},
    header: {
      title: { tag: 'plain_text', content: `${emoji} ${opts.title}` },
      template,
    },
    body: {
      elements: [
        { tag: 'markdown', content: opts.text || '_（空消息）_' },
        { tag: 'hr' },
        { tag: 'markdown', content: `<font color='grey'>via notify · ${hhmm}</font>` },
      ],
    },
  }
}

export interface NotifyOptions {
  bind: string
  port: number
}

export function startNotifyServer(opts: NotifyOptions): void {
  try {
    Bun.serve({
      hostname: opts.bind,
      port: opts.port,
      fetch: async (req: Request) => {
        const url = new URL(req.url)
        if (req.method === 'GET' && url.pathname === '/') {
          return new Response(
            'lodestar notify\n' +
            'POST /notify  body={project,text,title?,level?}\n' +
            'levels: info|warn|error (default info)\n',
            { headers: { 'content-type': 'text/plain; charset=utf-8' } },
          )
        }
        if (req.method !== 'POST' || url.pathname !== '/notify') {
          return new Response('use POST /notify', { status: 405 })
        }

        let body: any = {}
        try { body = await req.json() } catch {
          return new Response('bad json', { status: 400 })
        }
        const project = String(body.project ?? '').trim()
        const text = String(body.text ?? '')
        const titleRaw = String(body.title ?? '').trim()
        const levelRaw = String(body.level ?? 'info').toLowerCase()
        if (!project) return new Response('missing "project"', { status: 400 })
        if (!text)    return new Response('missing "text"', { status: 400 })

        const level: Level = (VALID_LEVELS.has(levelRaw as Level) ? levelRaw : 'info') as Level
        const title = titleRaw || project

        const sessionName = feishu.sanitizeSessionName(project)
        const chatId = feishu.chatIdForSession(sessionName)
        if (!chatId) {
          log(`notify: project "${project}" (sanitized "${sessionName}") has no chat binding → 404`)
          return new Response(
            `project "${project}" not bound — send any message in that Feishu group at least once after the daemon started, then retry`,
            { status: 404 },
          )
        }

        const card = notifyCard({ title, text, level })
        const messageId = await feishu.sendCard(chatId, card)
        if (!messageId) {
          log(`notify: sendCard failed → 502 (project="${project}" chat=${chatId.slice(0, 8)}…)`)
          return new Response('feishu sendCard failed (see daemon log)', { status: 502 })
        }
        log(`notify: → ${project} (${chatId.slice(0, 8)}…) level=${level} bytes=${text.length} msg=${messageId}`)
        return Response.json({ ok: true, chat_id: chatId, message_id: messageId })
      },
      error: (err: Error) => {
        log(`notify: handler crash: ${err.message}`)
        return new Response('internal error', { status: 500 })
      },
    })
    log(`notify: HTTP listening at http://${opts.bind}:${opts.port}/notify`)
  } catch (e) {
    log(`notify: server bind failed (${opts.bind}:${opts.port}): ${e}`)
  }
}
