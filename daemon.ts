#!/usr/bin/env bun
/**
 * Lodestar 2.0 daemon — Feishu (Lark) ↔ Claude Code headless bridge.
 *
 * Listens on Lark WebSocket for inbound messages and card-action
 * callbacks, routes each to a per-chat Session that owns a headless
 * `claude` subprocess and a streaming Card Kit card.
 *
 * Run:   bun daemon.ts
 * Stop:  SIGTERM
 */

import * as lark from '@larksuiteoapi/node-sdk'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Session } from './src/session'
import * as feishu from './src/feishu'
import { startNotifyServer } from './src/notify'
import { config } from './src/config'
import { log } from './src/log'
import { DEBUG_CTX_FILE, DEBUG_SOCK_FILE, PID_FILE } from './src/paths'

// ── PID guard ───────────────────────────────────────────────────────────
try {
  const existing = readFileSync(PID_FILE, 'utf8').trim()
  try {
    process.kill(Number(existing), 0)
    console.error(`lodestar-daemon: already running (pid ${existing})`)
    process.exit(1)
  } catch {}
} catch {}

mkdirSync(dirname(PID_FILE), { recursive: true })
writeFileSync(PID_FILE, String(process.pid))

const cleanup = () => {
  // Snapshot which sessions are still alive so the next boot can
  // revive them — only the ones still running at shutdown, NOT
  // anything the user already `kill`-ed (those are absent from the
  // sessions Map filter below and stay stopped after restart).
  try {
    const alive: string[] = []
    for (const s of sessions.values()) if (s.isRunning()) alive.push(s.sessionName)
    feishu.writeAliveMarker(alive)
    if (alive.length > 0) log(`alive marker: [${alive.join(', ')}]`)
  } catch (e) { log(`alive marker write failed: ${e}`) }
  try { unlinkSync(PID_FILE) } catch {}
  try { unlinkSync(DEBUG_SOCK_FILE) } catch {}
}
process.on('exit', cleanup)
process.on('SIGTERM', () => { log('SIGTERM'); cleanup(); process.exit(0) })
process.on('SIGINT',  () => { log('SIGINT');  cleanup(); process.exit(0) })
process.on('unhandledRejection', e => log(`unhandledRejection: ${e}`))
process.on('uncaughtException',  e => log(`uncaughtException: ${e}`))

// ── Session registry ────────────────────────────────────────────────────
const sessions = new Map<string, Session>()  // key = chatId

function sessionFor(chatId: string, sessionName: string): Session {
  let s = sessions.get(chatId)
  if (!s) {
    s = new Session(sessionName, chatId)
    sessions.set(chatId, s)
  }
  return s
}

/** Auto-restart any session that was alive when the previous daemon
 * went down. Driven by the marker file written in `cleanup` — that
 * file ONLY lists sessions that were running, so anything the user
 * had explicitly `kill`-ed before shutdown is intentionally absent
 * and stays stopped. Each revived session is `restart(true)`-ed so
 * the SDK gets `--resume <claudeSessionId>` and the in-flight
 * conversation continues without the user typing anything. */
async function reviveAliveSessions(): Promise<void> {
  const names = feishu.readAndConsumeAliveMarker()
  if (names.length === 0) return
  log(`revive: ${names.length} session(s) marked alive on shutdown: ${names.join(', ')}`)
  for (const sessionName of names) {
    const chatId = feishu.chatIdForSession(sessionName)
    if (!chatId) {
      log(`revive: no chatId binding for "${sessionName}", skip`)
      continue
    }
    const session = sessionFor(chatId, sessionName)
    try {
      await session.restart(true)
      log(`revive: spawned "${sessionName}" (chat ${chatId.slice(0, 8)}…)`)
    } catch (e) {
      log(`revive: restart "${sessionName}" failed: ${e}`)
    }
  }
}

// ── Inbound message handler ─────────────────────────────────────────────
const STALE_THRESHOLD_MS = 5_000
const seenMessageIds = new Set<string>()

async function handleMessage(data: any): Promise<void> {
  const message = data?.message
  if (!message) return

  // Feishu's im.message.receive_v1 event puts `sender` at the event
  // root, sibling of `message` — NOT inside `message` (we had this
  // wrong before, which silently emptied userOpenId and skipped every
  // urgent_app push). Try root first, fall back to nested in case the
  // SDK wraps the payload differently.
  const senderId = data?.sender?.sender_id ?? data?.event?.sender?.sender_id ?? message?.sender?.sender_id
  const userOpenId: string = senderId?.open_id ?? ''

  const msgId = message.message_id as string | undefined
  if (msgId && seenMessageIds.has(msgId)) return
  if (msgId) {
    seenMessageIds.add(msgId)
    if (seenMessageIds.size > 200) {
      const arr = [...seenMessageIds]
      seenMessageIds.clear()
      for (const id of arr.slice(-100)) seenMessageIds.add(id)
    }
  }

  // Drop replays of stale messages (Lark redelivers unacked events on reconnect).
  const createTime = Number(message.create_time ?? 0)
  if (createTime > 0 && Date.now() - createTime > STALE_THRESHOLD_MS) {
    log(`drop stale message ${msgId} age=${Math.round((Date.now() - createTime) / 1000)}s`)
    if (msgId) void feishu.addReaction(msgId, 'CrossMark')
    return
  }

  const chatId = message.chat_id as string

  // `[DEBUG]` prefix — seed the inject context with the real chat/sender
  // captured from a live WS event, then strip the prefix and continue as
  // normal. The injector script (scripts/test-inject.ts) reads this
  // context to replay arbitrary messages without the user touching Feishu.
  let contentObjForDebug: any = {}
  try { contentObjForDebug = JSON.parse(message.content ?? '{}') } catch {}
  const debugTextRaw = (message.message_type === 'text' ? contentObjForDebug.text ?? '' : '')
  if (typeof debugTextRaw === 'string' && debugTextRaw.startsWith('[DEBUG]')) {
    try {
      writeFileSync(DEBUG_CTX_FILE, JSON.stringify({
        chat_id: chatId,
        sender_open_id: userOpenId,
        seeded_at: new Date().toISOString(),
        seeded_msg_id: msgId ?? '',
      }, null, 2))
      log(`debug: seeded inject context chat=${chatId.slice(0, 8)}… sender=${userOpenId.slice(0, 8)}…`)
    } catch (e) { log(`debug: seed context failed: ${e}`) }
    const stripped = debugTextRaw.slice('[DEBUG]'.length)
    contentObjForDebug.text = stripped
    message.content = JSON.stringify(contentObjForDebug)
  }

  let groupName = feishu.chatNameCache.get(chatId)
  if (!groupName) {
    await feishu.refreshChatList()
    groupName = feishu.chatNameCache.get(chatId)
  }
  if (!groupName) {
    log(`unknown chat ${chatId}, dropping message`)
    await feishu.sendText(chatId, '❌ 无法识别群名，请确认机器人已加入并稍后重试')
    return
  }
  const sessionName = feishu.sanitizeSessionName(groupName)
  feishu.bindSessionToChat(sessionName, chatId)
  const session = sessionFor(chatId, sessionName)

  let contentObj: any = {}
  try { contentObj = JSON.parse(message.content ?? '{}') } catch {}
  const msgType = message.message_type as string
  let text = (msgType === 'text' ? contentObj.text ?? '' : '').trim()

  // Text-only control commands — intercept before any work that would
  // forward to Claude (download / spawn / interrupt). Exact match,
  // case-insensitive: `hi` `kill` `restart` `clear`. Bare words are
  // reserved globally by user request — typing "hi" as a literal
  // greeting will trigger the dashboard, not reach Claude.
  if (msgType === 'text' && text) {
    if (await session.runCommand(text)) return
  }

  // Pending AskUserQuestion: route the message as a custom answer
  // instead of opening a new turn. This is how custom-text answers
  // work in this version — Feishu schema 2.0 doesn't support form/
  // input elements, so the chat box itself is the input. Only applies
  // to text-only messages (an image attachment opens a new turn as
  // usual). Bare-word commands have already been intercepted above.
  if (msgType === 'text' && text && session.hasPendingAsk()) {
    if (msgId) void feishu.addReaction(msgId, 'CheckMark')
    await session.onAskMessageAnswer(text, userOpenId)
    return
  }

  let filePath: string | undefined
  if (msgType === 'image' && contentObj.image_key) {
    filePath = await feishu.downloadAttachment(message.message_id, contentObj.image_key, 'image')
  } else if (msgType === 'file' && contentObj.file_key) {
    filePath = await feishu.downloadAttachment(message.message_id, contentObj.file_key, 'file', contentObj.file_name)
    if (!text) text = `(file: ${contentObj.file_name})`
  }

  if (!text && !filePath) return
  await session.onUserMessage(text || '(empty)', filePath ? [filePath] : [], userOpenId, msgId ?? '')
}

// ── Card action handler ────────────────────────────────────────────────
async function handleCardAction(data: any): Promise<any> {
  const action = data?.action
  const value = action?.value
  if (!value?.kind) return
  const chatId = data?.context?.open_chat_id ?? ''
  const userId = data?.operator?.open_id ?? ''
  const session = sessions.get(chatId)
  if (!session) return { toast: { type: 'error', content: '会话不存在，请先发消息启动' } }

  switch (value.kind) {
    case 'permission':
      await session.onPermissionDecision(value.request_id, value.decision, userId)
      return { toast: { type: value.decision === 'deny' ? 'error' : 'success', content: '已处理' } }
    case 'menu':
      await session.onUserMessage(`(menu choice ${value.choice + 1})`)
      return { toast: { type: 'success', content: 'OK' } }
    case 'ask': {
      // Custom-text branch: form submit packages the input under
      // `form_value`. Try a couple of plausible keys since the exact
      // shape can drift between Feishu schema versions; fall back to
      // empty (onAskCustomAnswer ignores blank).
      if (value.custom) {
        const fv = action?.form_value ?? action?.input ?? {}
        const customText: string = fv?.custom_answer ?? action?.input_value ?? ''
        await session.onAskCustomAnswer(value.tool_use_id, value.question_idx ?? 0, customText, userId)
        return { toast: { type: customText.trim() ? 'success' : 'error', content: customText.trim() ? '已回答' : '请输入答案' } }
      }
      await session.onAskAnswer(value.tool_use_id, value.question_idx ?? 0, value.option_idx, userId)
      return { toast: { type: 'success', content: '已回答' } }
    }
  }
  return { toast: { type: 'info', content: 'unknown action' } }
}

// ── WebSocket boot ─────────────────────────────────────────────────────
function fmt(m: any[]): string {
  return m.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')
}

// ── Debug message injection ─────────────────────────────────────────────
// Listens on a unix socket so scripts/test-inject.ts can replay messages
// through the same `handleMessage` path that real WS events take. Seeded
// by a one-time `[DEBUG]<anything>` from the real Feishu user; from then
// on the injector reuses that chat_id + sender_open_id.
function startDebugSocket(): void {
  try { if (existsSync(DEBUG_SOCK_FILE)) unlinkSync(DEBUG_SOCK_FILE) } catch {}
  try {
    Bun.serve({
      unix: DEBUG_SOCK_FILE,
      fetch: async (req: Request) => {
        if (req.method !== 'POST') return new Response('use POST', { status: 405 })
        let body: any = {}
        try { body = await req.json() } catch { return new Response('bad json', { status: 400 }) }
        if (!existsSync(DEBUG_CTX_FILE)) {
          return new Response('no debug context yet — send `[DEBUG]hi` from Feishu first', { status: 412 })
        }
        let ctx: any = {}
        try { ctx = JSON.parse(readFileSync(DEBUG_CTX_FILE, 'utf8')) } catch (e) {
          return new Response(`ctx read failed: ${e}`, { status: 500 })
        }
        const text: string = String(body.text ?? '')
        if (!text) return new Response('text required', { status: 400 })
        const fakeMsgId = `om_DEBUG_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
        const payload = {
          sender: { sender_id: { open_id: ctx.sender_open_id } },
          message: {
            message_id: fakeMsgId,
            chat_id: ctx.chat_id,
            message_type: 'text',
            content: JSON.stringify({ text }),
            create_time: String(Date.now()),
          },
        }
        log(`debug: inject text=${JSON.stringify(text).slice(0, 80)} fake_id=${fakeMsgId}`)
        // Don't await — match real WS dispatcher behavior (fire-and-forget per event).
        handleMessage(payload).catch(e => log(`debug: handleMessage rejected: ${e}`))
        return new Response(JSON.stringify({ ok: true, fake_msg_id: fakeMsgId }), {
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    try { chmodSync(DEBUG_SOCK_FILE, 0o600) } catch {}
    log(`debug: inject socket listening at ${DEBUG_SOCK_FILE}`)
  } catch (e) {
    log(`debug: socket bind failed: ${e}`)
  }
}

async function boot(): Promise<void> {
  log(`lodestar-daemon: pid ${process.pid} starting`)
  feishu.loadSessionChatMap()
  feishu.loadSessionResumeMap()
  await feishu.refreshChatList()
  setInterval(() => { void feishu.refreshChatList() }, 5 * 60 * 1000)

  // Lark WSClient sends pings every ~120s but doesn't verify pongs. On a
  // half-open TCP (NAT idle-kill, network blip) the socket stays OPEN and
  // 'close' never fires — we'd go silently deaf. Stamp every inbound pong
  // and exit(1) after 180s of silence so systemd reconnects us.
  let lastPongAt = Date.now()
  const wsLogger = {
    error: (m: any[]) => log(`[ws-sdk error] ${fmt(m)}`),
    warn:  (m: any[]) => log(`[ws-sdk warn] ${fmt(m)}`),
    info:  (m: any[]) => log(`[ws-sdk] ${fmt(m)}`),
    debug: (_m: any[]) => { /* drop */ },
    trace: (m: any[]) => {
      if (Array.isArray(m) && m[0] === '[ws]' && m[1] === 'receive pong') {
        lastPongAt = Date.now()
      }
    },
  }
  setInterval(() => {
    const idle = Date.now() - lastPongAt
    if (idle > 180_000) {
      log(`[watchdog] no WS pong for ${Math.round(idle / 1000)}s — exit for systemd restart`)
      process.exit(1)
    }
  }, 30_000)

  const ws = new lark.WSClient({
    appId: config.feishu.app_id,
    appSecret: config.feishu.app_secret,
    loggerLevel: lark.LoggerLevel.trace,
    logger: wsLogger,
  })
  const dispatcher = new lark.EventDispatcher({})
  dispatcher.register({
    'im.message.receive_v1': async (d: any) => {
      try { await handleMessage(d) } catch (e) { log(`handleMessage: ${e}`) }
    },
  })
  dispatcher.register({
    'card.action.trigger': async (d: any) => {
      try { return await handleCardAction(d) } catch (e) { log(`handleCardAction: ${e}`) }
    },
  })
  ws.start({ eventDispatcher: dispatcher })
  log(`lodestar-daemon: WS started, watching ${feishu.chatNameCache.size} groups`)

  startDebugSocket()
  startNotifyServer({ bind: config.notify.bind, port: config.notify.port })

  // Auto-revive sessions that were running when we last went down.
  // Runs AFTER the WS is up so any 🔁 revive message lands in the
  // right chat instead of disappearing into the void.
  await reviveAliveSessions()
}

boot().catch(e => { log(`boot fatal: ${e}`); process.exit(1) })
