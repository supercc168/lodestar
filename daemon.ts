/**
 * Lodestar 2.0 daemon — Feishu (Lark) ↔ Codex app-server bridge.
 *
 * No source-file shebang on purpose:
 *   - `bun daemon.ts` and `systemctl --user start feishu-daemon` don't
 *     need it (they invoke the runtime explicitly).
 *   - `bun build --target=node --banner='#!/usr/bin/env node'` is the
 *     official entry; a duplicate shebang in source would survive into
 *     the bundle below the banner and break Node's parser (line-3
 *     shebang isn't recognized).
 *
 * Listens on Lark WebSocket for inbound messages and card-action
 * callbacks, routes each to a per-chat Session that owns a headless
 * `codex app-server` subprocess and a streaming Card Kit card.
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
import { ensureFeishuNotifySkill } from './src/notify-skill'
import { startScheduler, deleteSchedule, toggleScheduleMode, getSchedule } from './src/schedule'
import { config } from './src/config'
import { log } from './src/log'
import { DEBUG_CTX_FILE, DEBUG_SOCK_FILE, PID_FILE } from './src/paths'
import { checkPidGuard, writePidFile } from './src/pid-guard'

// ── PID guard ───────────────────────────────────────────────────────────
// dev 路径 (`bun daemon.ts` 直接跑) 不经过 cli.ts, 所以这里也守一道。
// 走 checkPidGuard 同一份逻辑: 校验 PID 文件里那个 pid 的 cmdline 包含
// 我们启动时记下的 marker, 避免 PID 被回收导致的假阳性把后续启动锁死。
{
  const guard = checkPidGuard(PID_FILE)
  if (guard.state === 'exit') {
    console.error(`lodestar-daemon: already running (pid ${guard.pid})`)
    process.exit(1)
  }
  if (existsSync(PID_FILE)) { try { unlinkSync(PID_FILE) } catch {} }
}

mkdirSync(dirname(PID_FILE), { recursive: true })
writePidFile(PID_FILE)

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
// Windows 没有 POSIX SIGTERM;NSSM/WinSW 这类 Windows service wrapper
// 在停服务时通常发 SIGBREAK (Ctrl-Break 的内核映射),让进程优雅退出。
// 仅在 Win32 上注册,避免 Linux/Mac 跑 listener-count 检查时多出一个
// 无关的信号 handler。
if (process.platform === 'win32') {
  process.on('SIGBREAK', () => { log('SIGBREAK'); cleanup(); process.exit(0) })
}
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
 * Codex resumes the saved thread id and the in-flight
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

// ── Feishu `post` (rich-text) → Markdown ────────────────────────────────
// 飞书客户端发 markdown 时,内容会被编码成 message_type='post' 的二维数组
// AST,不是 'text'。下面把它反向拼回 markdown 字符串(Codex 消化
// markdown 比拍平纯文本更结构化),并把内嵌图片/文件 key 抽出来交给
// `downloadAttachment` 走附件路径,跟原生 image/file 消息对齐。
//
// underline 故意不还原 —— markdown 无原生语法,而本项目用 <u>...</u> 标记
// "多条独立消息",一旦塞进 text 会被 Codex 当成消息边界误解。
interface PostElement {
  tag: string
  text?: string
  href?: string
  style?: string[]
  image_key?: string
  file_key?: string
  file_name?: string
  user_id?: string
  user_name?: string
}
function extractPostMarkdown(
  contentObj: any,
): { markdown: string; imageKeys: string[]; fileKeys: { key: string; name?: string }[] } {
  const imageKeys: string[] = []
  const fileKeys: { key: string; name?: string }[] = []
  const paragraphs: string[] = []
  const title = typeof contentObj?.title === 'string' ? contentObj.title.trim() : ''
  if (title) paragraphs.push(`# ${title}`)
  const blocks: PostElement[][] = Array.isArray(contentObj?.content) ? contentObj.content : []
  for (const para of blocks) {
    if (!Array.isArray(para)) continue
    const parts: string[] = []
    for (const el of para) {
      if (!el || typeof el !== 'object') continue
      switch (el.tag) {
        case 'text': {
          let t = String(el.text ?? '')
          const styles = Array.isArray(el.style) ? el.style : []
          if (styles.includes('bold')) t = `**${t}**`
          if (styles.includes('italic')) t = `*${t}*`
          if (styles.includes('lineThrough') || styles.includes('strikethrough')) t = `~~${t}~~`
          parts.push(t)
          break
        }
        case 'a': {
          const href = String(el.href ?? '')
          const t = String(el.text ?? href)
          parts.push(`[${t}](${href})`)
          break
        }
        case 'at': {
          const name = String(el.user_name ?? el.user_id ?? '')
          parts.push(`@${name}`)
          break
        }
        case 'code_inline':
          parts.push(`\`${String(el.text ?? '')}\``)
          break
        case 'hr':
          parts.push('---')
          break
        case 'img':
          if (el.image_key) imageKeys.push(String(el.image_key))
          break
        case 'media':
          if (el.file_key) fileKeys.push({ key: String(el.file_key), name: el.file_name })
          break
        case 'emotion':
          // 飞书表情没有合适的 markdown 还原,塞 `:key:` 反而像代码引用
          break
        default:
          if (typeof el.text === 'string') parts.push(el.text)
      }
    }
    const line = parts.join('')
    if (line.trim()) paragraphs.push(line)
  }
  return { markdown: paragraphs.join('\n\n'), imageKeys, fileKeys }
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
    // refreshChatList 走的 im.chat.list 是最终一致的：机器人刚被拉进一个
    // 新群时，群往往要过几秒才出现在列表里，而用户的第一条消息恰恰落在
    // 这个窗口。按 chat_id 直接点查 im.chat.get —— 同一数据源的更精确查询，
    // 拿得到列表还没刷出来的新群名，新群第一条消息就能接住。
    groupName = (await feishu.fetchChatName(chatId)) ?? undefined
  }
  if (!groupName) {
    log(`unknown chat ${chatId}, dropping message`)
    await feishu.sendText(chatId, '❌ 无法识别群名。请确认：① 机器人已被拉进本群；② 群已设置名称（未命名群拿不到群名，无法映射项目目录）。设置后再发一条消息即可。')
    return
  }
  const sessionName = feishu.sanitizeSessionName(groupName)
  feishu.bindSessionToChat(sessionName, chatId)
  const session = sessionFor(chatId, sessionName)

  let contentObj: any = {}
  try { contentObj = JSON.parse(message.content ?? '{}') } catch {}
  const msgType = message.message_type as string
  let text = ''
  const filePaths: string[] = []
  if (msgType === 'text') {
    text = (contentObj.text ?? '').trim()
  } else if (msgType === 'post') {
    // 飞书客户端 markdown 走 'post' 富文本通道,不是 'text'。反向拼回
    // markdown 给 Codex,内嵌图片/文件 key 走跟原生 image/file 一样的
    // downloadAttachment 路径。
    const post = extractPostMarkdown(contentObj)
    text = post.markdown.trim()
    for (const key of post.imageKeys) {
      const p = await feishu.downloadAttachment(message.message_id, key, 'image')
      if (p) filePaths.push(p)
    }
    for (const f of post.fileKeys) {
      const p = await feishu.downloadAttachment(message.message_id, f.key, 'file', f.name)
      if (p) filePaths.push(p)
    }
  }

  // Text-only control commands — intercept before any work that would
  // forward to Codex (download / spawn / interrupt). Exact match,
  // case-insensitive: `hi` `kill` `restart` `clear`. Bare words are
  // reserved globally by user request — typing "hi" as a literal
  // greeting will trigger the dashboard, not reach Codex. Post 富文本
  // 整段不可能正好等于这些 bare word,所以这里只对 text 触发。
  if (msgType === 'text' && text) {
    if (await session.runCommand(text)) return
  }

  // Pending AskUserQuestion: route the message as a custom answer
  // instead of opening a new turn. This is how custom-text answers
  // work in this version — Feishu schema 2.0 doesn't support form/
  // input elements, so the chat box itself is the input. Only applies
  // to text-only messages (post / 图片 / 文件附件都按一次新轮处理)。
  if (msgType === 'text' && text && session.hasPendingAsk()) {
    // ✅ 不在这里抢打 —— 只有 onAskMessageAnswer 真把这条文本记成 ask
    // 答案时才回 ✅。撞上僵尸 ask(can_use_tool 没来)时这条消息会被当
    // 普通新轮重处理,不该留"答案已收到"标记。msgId 透传下去:成功消费
    // 时用来打 ✅,兜底重处理时让消息走完整的普通 reaction 生命周期。
    await session.onAskMessageAnswer(text, userOpenId, msgId ?? '')
    return
  }

  if (msgType === 'image' && contentObj.image_key) {
    const p = await feishu.downloadAttachment(message.message_id, contentObj.image_key, 'image')
    if (p) filePaths.push(p)
  } else if (msgType === 'file' && contentObj.file_key) {
    const p = await feishu.downloadAttachment(message.message_id, contentObj.file_key, 'file', contentObj.file_name)
    if (p) filePaths.push(p)
    if (!text) text = `(file: ${contentObj.file_name})`
  }

  if (!text && filePaths.length === 0) {
    // Post 已经走 markdown 解码;还落到空,要么是不支持的 message_type
    // (sticker / share_chat / audio / ...),要么是 post 里只剩 emotion /
    // 未知 tag。留 log 防再有"静默 1.5h"那种 case 没法回溯。
    log(`drop empty message ${msgId} type=${msgType}`)
    return
  }
  await session.onUserMessage(text || '(empty)', filePaths, userOpenId, msgId ?? '')
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
    case 'schedule_delete': {
      // hi 面板是全局 dashboard,跨群删除允许。button payload 只带 id,
      // daemon 端按 id 查到 → 直接删。MCP path 那边的 schedule_delete
      // 仍然是 project-scoped(Codex 在 A 群没法删 B 群的),两个路径
      // 信任模型不同:hi 是 operator-only(只有你飞书账号能按),MCP 是
      // Codex-on-prompts(prompt 注入风险)。
      const id = String(value.id ?? '')
      if (!id) return { toast: { type: 'error', content: '缺 id' } }
      const sched = getSchedule(id)
      if (!sched) return { toast: { type: 'error', content: '任务不存在(可能已被删除)' } }
      deleteSchedule(id)
      const newCard = await session.buildConsoleCard(undefined)
      return {
        toast: { type: 'success', content: `已删除 ⏰ ${sched.name} (${sched.project})` },
        card: { type: 'raw', data: newCard },
      }
    }
    case 'schedule_toggle_mode': {
      const id = String(value.id ?? '')
      if (!id) return { toast: { type: 'error', content: '缺 id' } }
      const sched = getSchedule(id)
      if (!sched) return { toast: { type: 'error', content: '任务不存在' } }
      const updated = toggleScheduleMode(id)
      if (!updated) return { toast: { type: 'error', content: '切换失败' } }
      const newCard = await session.buildConsoleCard(undefined)
      return {
        toast: { type: 'success', content: `⏰ ${updated.name} (${updated.project}) → ${updated.mode}` },
        card: { type: 'raw', data: newCard },
      }
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
  if (process.platform === 'win32') {
    // Bun.serve({unix:...}) 在 Windows 上不支持,且 debug 注入是
    // dev-only 路径(scripts/test-inject.ts 用的),end user 不需要。
    // 想在 Windows 上 spike 这个,换成 loopback HTTP 即可。
    log('debug: inject socket skipped on Windows (dev-only feature)')
    return
  }
  if (typeof Bun === 'undefined') {
    // 走 npm 发布出去给 end user 时跑的是 node,Bun.serve 不在。
    // debug 注入纯 dev-only(scripts/test-inject.ts 才用),production
    // 直接跳过即可 —— 既不报错也不引入 node:http 的 socket-path 端口
    // 适配工作量。本机 `bun daemon.ts` 因为 Bun 是 defined 的,这条
    // 分支不进。
    log('debug: inject socket skipped (Bun runtime only — npm/Node build does not include it)')
    return
  }
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
        // 把 inject 内容**真发到目标群**,带"【自动化测试】"前缀让群成员
        // 一眼能区分。拿飞书返回的真 message_id 再构造 event 灌
        // handleMessage:
        //   - msg_id 是真的 → 后续 addReaction / 其它 outbound 不再因
        //     `om_DEBUG_*` 合成 id 报 99992354 污染飞书侧错误日志。
        //   - daemon 看到的 content.text 是**原始 text**(不含前缀),
        //     Codex 那头不会被"【自动化测试】"标签干扰。
        //   - bot 自己发的消息默认不通过 receive_v1 回环(飞书协议层防
        //     死循环),daemon 只通过这条 inject 路径看到一份消息,不会
        //     重复触发 handleMessage。
        const flaggedText = `【自动化测试】:${text}`
        const realMsgId = await feishu.sendText(ctx.chat_id, flaggedText)
        if (!realMsgId) {
          return new Response('sendText failed — see daemon log', { status: 502 })
        }
        const payload = {
          sender: { sender_id: { open_id: ctx.sender_open_id } },
          message: {
            message_id: realMsgId,
            chat_id: ctx.chat_id,
            message_type: 'text',
            content: JSON.stringify({ text }),
            create_time: String(Date.now()),
          },
        }
        log(`debug: inject text=${JSON.stringify(text).slice(0, 80)} msg_id=${realMsgId}`)
        // Don't await — match real WS dispatcher behavior (fire-and-forget per event).
        handleMessage(payload).catch(e => log(`debug: handleMessage rejected: ${e}`))
        return new Response(JSON.stringify({ ok: true, msg_id: realMsgId }), {
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

  // Lark WSClient sends pings every ~120s but doesn't verify pongs by default.
  // On a half-open TCP (NAT idle-kill, network blip) the socket stays OPEN and
  // 'close' never fires — we'd go silently deaf. SDK exposes `pingTimeout`:
  // after sending a ping, if no inbound frame arrives within the window the
  // socket is terminated, which triggers the 'close' handler and the SDK's
  // standard reconnect loop. The daemon process stays alive — every Codex
  // subprocess, ScheduleWakeup, card streaming state and setInterval is
  // preserved across the WS hiccup. We only let systemd restart us if the
  // SDK's own reconnect loop exhausts its retry budget (onError).
  const wsLogger = {
    error: (m: any[]) => log(`[ws-sdk error] ${fmt(m)}`),
    warn:  (m: any[]) => log(`[ws-sdk warn] ${fmt(m)}`),
    info:  (m: any[]) => log(`[ws-sdk] ${fmt(m)}`),
    debug: (_m: any[]) => { /* drop */ },
    trace: (_m: any[]) => { /* drop */ },
  }
  const dispatcher = new lark.EventDispatcher({})

  // ── connected-but-deaf self-heal ────────────────────────────────────────
  // Feishu 长连接是**集群模式**(官方文档原话:"同一应用部署多个 client,
  // 只有随机一个 client 收到消息",且每 app ≤50 连接)。SDK 自带的重连
  // (reConnect → 同一个 WSClient 复用 tryConnect)断线后会重新握手成功、
  // pong 照常收发、getConnectionStatus().state==='connected' —— 但服务端
  // gateway 有时仍把旧连接当成该 app 的活跃 client,把事件**随机路由到那条
  // 已死的旧连接**,新连接 connected 却永远收不到任何 im.message 事件。
  // 这是 lark 长连接生态公认、但官方至今未修的 bug(同症状见 openclaw
  // #11719 / hermes-agent #24807)。三道旧防线全看不到它:pingTimeout 因
  // pong 仍在流动不触发;state 一直是 connected;onError 不报。
  //
  // 解法:不信 SDK 的同-client 重连,也不信 close()+start() in-place revive
  // (底层还是同一个 tryConnect,可能拉回同样被服务端判死的状态)。每次重连
  // 后**整个换一个全新的 lark.WSClient(新 token、新连接),force-close 旧的**
  // —— 这复刻了"整进程重启之所以管用"的核心(gateway 只剩一条新连可认),
  // 但全程不碰任何 Codex 子进程、不退进程。lastEventAt 作为唯一可信的"事件
  // 通道还活着"信号(不信 state);活跃群在 rebuild 后还聋就退避重建,封顶后
  // 只打日志、绝不 process.exit。
  let lastEventAt = Date.now()        // 收到任意真实事件就刷新 = 通道存活铁证
  let consecRebuilds = 0
  let rebuilding = false
  let verifyTimer: ReturnType<typeof setTimeout> | null = null
  const SETTLE_MS = 1500              // 让 SDK 自身重连流程先落定再换 client
  const VERIFY_WINDOW_MS = 90_000     // rebuild 后等多久确认事件恢复
  const RECENT_ACTIVITY_MS = 10 * 60_000  // 重连前这段内有过事件 = 活跃群,值得重试
  const MAX_CONSEC_REBUILDS = 3       // 活跃群连续重建上限,到顶只告警不死循环

  const markEvent = () => {
    lastEventAt = Date.now()
    // 收到真实事件 = 通道确认健康:撤掉待验证、清零重建计数。
    consecRebuilds = 0
    if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = null }
  }

  dispatcher.register({
    'im.message.receive_v1': async (d: any) => {
      markEvent()
      // ⚠️ 不要 await handleMessage —— Lark WS 长连接对事件 ack 有 ~4s
      // 硬超时,handleMessage 内部可能触发 openTurnCard / spawn Codex /
      // sendInterrupt 等数百 ms~数秒的链路,任一组合超 4s 飞书侧就判投递
      // 失败把事件直接丢弃(后台 event log 里这一类 errorInfo=timeout,
      // costMills≈3760ms,用户侧表现就是"发的消息 daemon 完全没收到")。
      // 这里立刻 return 让 dispatcher 回 ack,实际处理后台跑;handleMessage
      // 入口已用 seenMessageIds 做了同 message_id 去重,fire-and-forget
      // 不会引入重复处理。
      handleMessage(d).catch(e => log(`handleMessage: ${e}`))
    },
  })
  dispatcher.register({
    'card.action.trigger': async (d: any) => {
      markEvent()
      try { return await handleCardAction(d) } catch (e) { log(`handleCardAction: ${e}`) }
    },
  })

  let ws: lark.WSClient

  const makeWs = (): lark.WSClient => new lark.WSClient({
    appId: config.feishu.app_id,
    appSecret: config.feishu.app_secret,
    loggerLevel: lark.LoggerLevel.info,
    logger: wsLogger,
    // MUST be < the SDK's 120s pingInterval. The pong-watchdog is re-armed on
    // every ping and (deliberately) NOT re-armed on inbound; it only fires if a
    // full pingTimeout window elapses with no inbound between two pings. With
    // pingTimeout ≥ 120 the next ping always re-arms it before it can expire, so
    // on a half-open/zombie socket it NEVER terminates — the whole
    // close→reConnect→onReconnected→rebuildWs self-heal chain below stays dead.
    // 60s leaves margin under the 120s interval so a dead link is killed within
    // ~60s of the next ping. (Earlier 180 silently disabled the watchdog.)
    wsConfig: { pingTimeout: 60 },
    // Without this, connect() awaits the 'open'/'error' event forever when
    // neither fires (wedged WS upgrade behind NAT/proxy) — start() deadlocks
    // silently: process alive, REST fine, but permanently deaf, no log and no
    // reconnect (the pingTimeout watchdog only arms AFTER 'open'). 10s cap →
    // fail-fast into the SDK's reconnect loop instead of hanging indefinitely.
    handshakeTimeoutMs: 10_000,
    onReconnecting: () => log('[ws] reconnecting — WS lost, SDK is retrying'),
    // SDK 自己重连成功了 —— 但这正是僵尸聋的高发点。不信它,延迟一拍后整个
    // 换新 client(见 onReconnectedHeal)。
    onReconnected:  () => onReconnectedHeal(),
    // SDK exhausted its own reconnect budget. Do NOT exit the process — that
    // SIGTERMs every Codex subprocess / scheduler / live card across all
    // groups. Rebuild a fresh WS client in place; the rest keeps running.
    onError: (err) => rebuildWs(`SDK onError: ${err?.message ?? err}`),
  })

  // Fresh-client rebuild: force-close the (possibly server-side-zombie) old
  // client, stand up a brand-new WSClient with a fresh token + connection, and
  // hand it the same dispatcher. Never touches Codex subprocesses, schedulers,
  // ScheduleWakeups or live cards; never exits the process. close({force}) does
  // removeAllListeners() before terminate(), so the old client fires no stray
  // reconnect. verifyAfter arms a post-rebuild check (only for active groups).
  const rebuildWs = (reason: string, verifyAfter = false) => {
    if (rebuilding) { log(`[ws] rebuild skipped (already rebuilding) — ${reason}`); return }
    rebuilding = true
    consecRebuilds++
    log(`[ws] rebuild #${consecRebuilds} (fresh WSClient) — ${reason}`)
    const old = ws
    try { old?.close({ force: true }) } catch (e) { log(`[ws] rebuild: old close failed: ${e}`) }
    ws = makeWs()
    void ws.start({ eventDispatcher: dispatcher })
    rebuilding = false
    if (verifyAfter) armVerify()
  }

  // After a rebuild, confirm events actually resumed. lastEventAt is the only
  // trustworthy signal (state lies). If nothing arrives in the window, the
  // rebuild also landed deaf → rebuild again with the same window as backoff,
  // capped at MAX_CONSEC_REBUILDS. Past the cap we stop and log loudly (no
  // process exit, no alert spam) — the last client stays up and a manual
  // `systemctl --user restart feishu-daemon` is the escape hatch.
  const armVerify = () => {
    if (verifyTimer) clearTimeout(verifyTimer)
    const armedAt = Date.now()
    verifyTimer = setTimeout(() => {
      verifyTimer = null
      if (lastEventAt >= armedAt) { consecRebuilds = 0; return }  // events resumed → healthy
      if (consecRebuilds >= MAX_CONSEC_REBUILDS) {
        log(`[ws] STILL deaf after ${MAX_CONSEC_REBUILDS} fresh rebuilds — auto-heal exhausted, ` +
            `leaving last client up (no process exit). Escape hatch: systemctl --user restart feishu-daemon`)
        consecRebuilds = 0
        return
      }
      rebuildWs(`verify: no event ${Math.round((Date.now() - armedAt) / 1000)}s after rebuild`, true)
    }, VERIFY_WINDOW_MS)
  }

  // Every reconnect (any client) → replace it with a fresh one. Cheap (~3s WS
  // blip, no subprocess loss) and reconnects are rare (~4×/day), so doing it
  // unconditionally has near-zero cost and zero false-positive risk. Only arm
  // the verify-and-retry loop for groups that were active just before the drop
  // — a dormant group's post-reconnect silence is normal, not deafness, so it
  // gets the single precautionary rebuild and no retry storm.
  const onReconnectedHeal = () => {
    const wasRecentlyActive = (Date.now() - lastEventAt) < RECENT_ACTIVITY_MS
    log(`[ws] reconnected — swapping in a fresh WSClient (cluster-routing precaution; ` +
        `recentlyActive=${wasRecentlyActive})`)
    consecRebuilds = 0
    setTimeout(() => rebuildWs('post-reconnect precaution', wasRecentlyActive), SETTLE_MS)
  }

  ws = makeWs()
  void ws.start({ eventDispatcher: dispatcher })
  log(`lodestar-daemon: WS started, watching ${feishu.chatNameCache.size} groups`)

  // Liveness watchdog for the OTHER failure mode the deaf-heal can't see: a
  // wedged handshake / zombie socket that leaves the client stuck OFF
  // 'connected' with no callback firing. Poll state every 60s; rebuild a fresh
  // client if it stays non-connected for 3 consecutive ticks (~3min) or
  // hard-fails. (connected-but-deaf is handled by the event-channel path above,
  // not here — state stays 'connected' in that case so this never sees it.)
  let wsUnhealthyTicks = 0
  setInterval(() => {
    const { state } = ws.getConnectionStatus()
    if (state === 'connected') { wsUnhealthyTicks = 0; return }
    if (state === 'failed') {
      wsUnhealthyTicks = 0
      rebuildWs('watchdog: state=failed')
      return
    }
    wsUnhealthyTicks++
    log(`[ws] watchdog: state=${state} (${wsUnhealthyTicks}/3)`)
    if (wsUnhealthyTicks >= 3) {
      wsUnhealthyTicks = 0
      rebuildWs(`watchdog: stuck in '${state}' ~3min`)
    }
  }, 60 * 1000)

  startDebugSocket()
  startNotifyServer({ bind: config.notify.bind, port: config.notify.port })

  // Sync the feishu-notify skill into ~/.codex/skills (idempotent).
  // Lets the user's main Codex session push to bound groups via
  // /notify without manually placing the skill file. Runs after
  // notify server is up so the port number we bake into the skill
  // body matches what's actually listening.
  ensureFeishuNotifySkill()

  // Bring up the scheduler — loads persisted schedules.json, starts
  // the per-minute tick, fires anything that came due while the
  // daemon was down. Independent of the sessions Map (each fire
  // spawns a fresh isolated CodexProcess via MCP), so order vs.
  // reviveAliveSessions does not matter for correctness.
  startScheduler()

  // Auto-revive sessions that were running when we last went down.
  // Runs AFTER the WS is up so any 🔁 revive message lands in the
  // right chat instead of disappearing into the void.
  await reviveAliveSessions()
}

boot().catch(e => { log(`boot fatal: ${e}`); process.exit(1) })
