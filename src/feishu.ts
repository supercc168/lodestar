/**
 * Feishu (Lark) primitives: Lark client, tenant token cache, chat
 * directory, sendText/sendCard, reactions, attachment download, project
 * provisioning, and Anthropic-auth check.
 *
 * Higher layers (cardkit / session / daemon) build on this.
 */

import * as lark from '@larksuiteoapi/node-sdk'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { config } from './config'
import { resolveClaudeBin } from './claude-process'
import { ALIVE_MARKER_FILE, DATA_DIR, INBOX_DIR, SESSION_CHAT_MAP_FILE, SESSION_RESUME_MAP_FILE } from './paths'
import { log } from './log'

const APP_ID = config.feishu.app_id
const APP_SECRET = config.feishu.app_secret
export const PROJECTS_ROOT = config.runtime.projects_root

export const client = new lark.Client({
  appId: APP_ID, appSecret: APP_SECRET, disableTokenCache: false,
})

// ── Tenant token (cached, used by raw fetch wrappers) ──────────────────
let cachedToken = ''
let tokenExpiry = 0
export async function getTenantToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  })
  const data = await res.json() as { tenant_access_token?: string; expire?: number }
  if (!data.tenant_access_token) throw new Error('feishu: failed to obtain tenant token')
  cachedToken = data.tenant_access_token
  tokenExpiry = Date.now() + ((data.expire ?? 7200) - 60) * 1000
  return cachedToken
}

// ── Chat directory ─────────────────────────────────────────────────────
export const chatNameCache = new Map<string, string>()
export const preferredChatForSession = new Map<string, string>()

export function loadSessionChatMap(): void {
  try {
    const obj = JSON.parse(readFileSync(SESSION_CHAT_MAP_FILE, 'utf8'))
    for (const [name, id] of Object.entries(obj)) {
      if (typeof id === 'string') preferredChatForSession.set(name, id)
    }
    log(`feishu: loaded ${preferredChatForSession.size} session→chat bindings`)
  } catch {}
}

function saveSessionChatMap(): void {
  try {
    const obj: Record<string, string> = {}
    for (const [k, v] of preferredChatForSession) obj[k] = v
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(SESSION_CHAT_MAP_FILE, JSON.stringify(obj, null, 2))
  } catch (e) { log(`feishu: save session-chat-map failed: ${e}`) }
}

export function bindSessionToChat(sessionName: string, chatId: string): void {
  if (preferredChatForSession.get(sessionName) === chatId) return
  const prev = preferredChatForSession.get(sessionName)
  preferredChatForSession.set(sessionName, chatId)
  saveSessionChatMap()
  log(`feishu: bound session "${sessionName}" → ${chatId}${prev ? ` (was ${prev})` : ''}`)
}

// ── Session resume map ────────────────────────────────────────────────
// `sessionName → last-known claude session_id`. Persisted so a daemon
// restart (systemctl, crash, watchdog) doesn't strand the user with a
// fresh conversation when they next type `restart`. Updated on every
// `system/init` from a claude subprocess.
const lastSessionIdByName = new Map<string, string>()

export function loadSessionResumeMap(): void {
  try {
    const obj = JSON.parse(readFileSync(SESSION_RESUME_MAP_FILE, 'utf8'))
    for (const [name, id] of Object.entries(obj)) {
      if (typeof id === 'string') lastSessionIdByName.set(name, id)
    }
    log(`feishu: loaded ${lastSessionIdByName.size} session→resume bindings`)
  } catch {}
}

function saveSessionResumeMap(): void {
  try {
    const obj: Record<string, string> = {}
    for (const [k, v] of lastSessionIdByName) obj[k] = v
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(SESSION_RESUME_MAP_FILE, JSON.stringify(obj, null, 2))
  } catch (e) { log(`feishu: save session-resume-map failed: ${e}`) }
}

export function bindSessionResume(sessionName: string, sessionId: string): void {
  if (lastSessionIdByName.get(sessionName) === sessionId) return
  lastSessionIdByName.set(sessionName, sessionId)
  saveSessionResumeMap()
}

export function getSessionResume(sessionName: string): string | null {
  return lastSessionIdByName.get(sessionName) ?? null
}

// ── Alive-on-shutdown marker ──────────────────────────────────────────
// Persists the list of session names that were still running when the
// daemon went down. Next boot reads + unlinks the file and auto-spawns
// (via session.restart(true)) only those — sessions that were already
// `stop`ped before shutdown are deliberately NOT in this list, so they
// stay stopped after restart.

export function writeAliveMarker(sessionNames: string[]): void {
  try {
    writeFileSync(ALIVE_MARKER_FILE, JSON.stringify(sessionNames, null, 2))
  } catch (e) { log(`feishu: write alive marker failed: ${e}`) }
}

/** Read + unlink in one shot — marker is single-use: revival should
 * happen exactly once per boot, not re-run on every subsequent crash
 * loop where systemd might keep re-launching us. */
export function readAndConsumeAliveMarker(): string[] {
  if (!existsSync(ALIVE_MARKER_FILE)) return []
  try {
    const raw = readFileSync(ALIVE_MARKER_FILE, 'utf8')
    try { unlinkSync(ALIVE_MARKER_FILE) } catch {}
    const data = JSON.parse(raw)
    return Array.isArray(data) ? data.filter((x: unknown): x is string => typeof x === 'string') : []
  } catch (e) {
    log(`feishu: read alive marker failed: ${e}`)
    try { unlinkSync(ALIVE_MARKER_FILE) } catch {}
    return []
  }
}

export function chatIdForSession(sessionName: string): string | null {
  const preferred = preferredChatForSession.get(sessionName)
  if (preferred && chatNameCache.get(preferred) === sessionName) return preferred
  const matches: string[] = []
  for (const [id, name] of chatNameCache) if (name === sessionName) matches.push(id)
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    log(`feishu: chatIdForSession("${sessionName}"): ${matches.length} candidates with no binding — [${matches.join(', ')}]`)
  }
  return null
}

export async function refreshChatList(): Promise<void> {
  try {
    let pageToken: string | undefined
    do {
      const res = await client.im.chat.list({
        params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
      })
      for (const chat of res.data?.items ?? []) {
        if (chat.chat_id && chat.name) chatNameCache.set(chat.chat_id, chat.name)
      }
      pageToken = res.data?.page_token
    } while (pageToken)
    log(`feishu: refreshed chat list — ${chatNameCache.size} groups`)
  } catch (e) { log(`feishu: refresh chat list failed: ${e}`) }
}

/** Resolve ONE chat's name by chat_id via `im.chat.get`, bypassing the
 * eventually-consistent `im.chat.list` that {@link refreshChatList} walks.
 * A group the bot was just added to can lag the list endpoint by several
 * seconds — exactly the window in which the user fires their first message
 * — so a direct point-lookup is what lets a freshly-created group resolve
 * on the first try instead of bouncing off "无法识别群名". Caches the name
 * on hit. Returns null when the API errors OR the chat genuinely has no
 * name (an unnamed group — the caller must surface that, since group-name
 * → project-dir is load-bearing and an empty name can't map anywhere).
 * Raw fetch + tenant token, same shape as urgentApp / sendTextRaw. */
export async function fetchChatName(chatId: string): Promise<string | null> {
  try {
    const token = await getTenantToken()
    const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const json = await res.json() as any
    if (json?.code !== 0) {
      log(`feishu: fetchChatName ${chatId} code=${json?.code} msg=${json?.msg}`)
      return null
    }
    const name = json.data?.name
    if (typeof name === 'string' && name) {
      chatNameCache.set(chatId, name)
      log(`feishu: fetchChatName ${chatId} → "${name}" (point lookup)`)
      return name
    }
    log(`feishu: fetchChatName ${chatId} — chat has no name (unnamed group?)`)
    return null
  } catch (e) {
    log(`feishu: fetchChatName ${chatId} failed: ${e}`)
    return null
  }
}

// ── Outbound: text + card ──────────────────────────────────────────────
/** Delay schedule for sendText/sendCard SDK retries. Three attempts total
 * (the leading 0 is the eager first try). Tuned for the bun+axios+lark-SDK
 * ECONNREFUSED transient we've been seeing — by ~5s the socket pool
 * usually recovers. Business errors (Feishu code != 0) are NOT retried;
 * only thrown network errors are. */
const SEND_RETRY_DELAYS_MS = [0, 1000, 4000]

async function sendViaSdkWithRetry(
  what: 'text' | 'card',
  chatId: string,
  msgType: 'text' | 'interactive',
  content: string,
): Promise<string | null> {
  // Same uuid across retries → Feishu dedupes on its side so a successful-
  // but-response-lost first attempt doesn't produce a duplicate message.
  const uuid = randomUUID()
  let lastErr: unknown = null
  for (let i = 0; i < SEND_RETRY_DELAYS_MS.length; i++) {
    if (SEND_RETRY_DELAYS_MS[i] > 0) {
      await new Promise(r => setTimeout(r, SEND_RETRY_DELAYS_MS[i]))
    }
    try {
      const res: any = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: msgType, content, uuid },
      })
      if (res?.code && res.code !== 0) {
        log(`feishu: send${what === 'text' ? 'Text' : 'Card'} rejected chat=${chatId} code=${res.code} msg=${res.msg}`)
        return null
      }
      return res?.data?.message_id ?? null
    } catch (e) {
      lastErr = e
      log(`feishu: send${what === 'text' ? 'Text' : 'Card'} attempt ${i + 1}/${SEND_RETRY_DELAYS_MS.length} chat=${chatId} failed: ${e}`)
    }
  }
  log(`feishu: send${what === 'text' ? 'Text' : 'Card'} chat=${chatId} EXHAUSTED ${SEND_RETRY_DELAYS_MS.length} retries: ${lastErr}`)
  return null
}

export async function sendText(chatId: string, text: string): Promise<string | null> {
  return sendViaSdkWithRetry('text', chatId, 'text', JSON.stringify({ text }))
}

export async function sendCard(chatId: string, card: object): Promise<string | null> {
  return sendViaSdkWithRetry('card', chatId, 'interactive', JSON.stringify(card))
}

/** Last-resort text send that bypasses the lark SDK and uses raw fetch
 * (which is what cardkit.ts uses and has never had stability issues on
 * this runtime). Used by callers that need to *surface a failure when
 * the SDK send path itself is the broken thing* — e.g. `openTurnCard`'s
 * `sendCard` exhausted retries on ECONNREFUSED and we still owe the
 * user a visible "your message was lost, please retry" notice. Do not
 * use this as a general-purpose send; it's the failure-surfacing
 * channel, not a silent fallback. */
export async function sendTextRaw(chatId: string, text: string): Promise<string | null> {
  try {
    const token = await getTenantToken()
    const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
    })
    const json = await res.json() as any
    if (json?.code !== 0) {
      log(`feishu: sendTextRaw rejected chat=${chatId} code=${json?.code} msg=${json?.msg}`)
      return null
    }
    return json.data?.message_id ?? null
  } catch (e) {
    log(`feishu: sendTextRaw chat=${chatId} failed: ${e}`)
    return null
  }
}

// ── Reactions ──────────────────────────────────────────────────────────
/** Add an emoji reaction. Returns the new reaction_id on success (needed
 * to delete the reaction later via {@link deleteReaction}) or null on
 * failure. Failures are logged and swallowed — reactions are non-load-
 * bearing UX, not worth bubbling errors. */
export async function addReaction(messageId: string, emojiType: string): Promise<string | null> {
  if (!messageId) return null
  try {
    const res: any = await client.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    })
    return res?.data?.reaction_id ?? null
  } catch (e) { log(`feishu: addReaction ${emojiType} on ${messageId} failed: ${e}`); return null }
}

/** Remove a previously-added reaction by its reaction_id (returned from
 * {@link addReaction}). Used for the "queued → released" lifecycle: the
 * OneSecond placed on arrival is *removed* when the daemon hands the
 * message off to the SDK's batch / system-reminder pipeline, instead of
 * stacking a second CheckMark on top — keeps the message's reaction row
 * uncluttered. Quiet on failure. */
export async function deleteReaction(messageId: string, reactionId: string): Promise<void> {
  if (!messageId || !reactionId) return
  try {
    await client.im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    })
  } catch (e) { log(`feishu: deleteReaction ${reactionId} on ${messageId} failed: ${e}`) }
}

// ── Urgent push ───────────────────────────────────────────────────────
/** Fire Feishu's "加急 — 应用内" push for an already-sent message.
 * Bypasses chat-level mute and pops a full-screen prompt on the
 * recipient's phone. Bot must be the original sender of the message
 * AND must still be a member of the chat.
 *
 * Endpoint:
 *   PATCH /open-apis/im/v1/messages/{message_id}/urgent_app
 *   ?user_id_type=open_id
 *   body: { user_id_list: ["ou_..."] }
 *
 * Required app scope (either one):
 *   - `im:message.urgent`            (「发送应用内加急消息」)
 *   - `im:message.urgent:app_send`   (「…（历史版本）」)
 *
 * Limits: 50 QPS app-wide; per-recipient cap is 200 unread urgent
 * messages (230023). No daily quota.
 *
 * Common error codes:
 *   230012 — message not sent by this bot
 *   230023 — recipient has 200 unread urgent already
 *   230052 — missing scope / chat restricts urgent */
export async function urgentApp(messageId: string, openIds: string[]): Promise<void> {
  if (!messageId) { log(`feishu: urgentApp skip — missing messageId`); return }
  if (openIds.length === 0) { log(`feishu: urgentApp skip — empty openIds (msg=${messageId})`); return }
  const token = await getTenantToken()
  const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/urgent_app?user_id_type=open_id`
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id_list: openIds }),
    })
    const json = await res.json() as any
    if (json?.code !== 0) {
      log(`feishu: urgentApp ${messageId} code=${json?.code} msg=${json?.msg}`)
      return
    }
    const invalid = json.data?.invalid_user_id_list ?? []
    const delivered = openIds.length - invalid.length
    log(`feishu: urgentApp ${messageId} ok — delivered=${delivered}${invalid.length ? ` invalid=${invalid.length}` : ''}`)
  } catch (e) { log(`feishu: urgentApp ${messageId} failed: ${e}`) }
}

// ── Attachment download (image/file) ───────────────────────────────────
export async function downloadAttachment(
  messageId: string, key: string, type: 'image' | 'file', name?: string,
): Promise<string | undefined> {
  try {
    const token = await getTenantToken()
    const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${key}?type=${type}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) {
      log(`feishu: download ${type} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return undefined
    }
    const buf = Buffer.from(await res.arrayBuffer())
    mkdirSync(INBOX_DIR, { recursive: true })
    const safeName = name
      ? name.replace(/[^a-zA-Z0-9._-]/g, '_')
      : `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`
    const path = join(INBOX_DIR, `${Date.now()}-${safeName}`)
    writeFileSync(path, buf)
    log(`feishu: downloaded ${type} ${path} (${buf.length}B)`)
    return path
  } catch (e) {
    log(`feishu: download ${type} failed: ${e instanceof Error ? e.message : e}`)
    return undefined
  }
}

// ── Outbound: upload + send file/image ────────────────────────────────
// Lark caps message images at ~30 MB; files vary by tenant (default 30 MB).
// We refuse anything above 30 MB up front rather than chasing per-tenant
// limits and surfacing opaque API errors mid-upload.
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'])

function looksLikeImage(filePath: string): boolean {
  return IMAGE_EXTS.has(extname(filePath).toLowerCase())
}

async function uploadImageMultipart(filePath: string): Promise<string | null> {
  const token = await getTenantToken()
  const file = new Blob([await readFile(filePath)])
  const form = new FormData()
  form.append('image_type', 'message')
  form.append('image', file, basename(filePath))
  const res = await fetch('https://open.feishu.cn/open-apis/im/v1/images', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  const data = await res.json() as any
  if (data?.code !== 0) {
    log(`feishu: uploadImage ${filePath} code=${data.code} msg=${data.msg}`)
    return null
  }
  return data.data?.image_key ?? null
}

async function uploadFileMultipart(filePath: string): Promise<string | null> {
  const token = await getTenantToken()
  const file = new Blob([await readFile(filePath)])
  const form = new FormData()
  // 'stream' is the catch-all type and works for arbitrary binaries.
  form.append('file_type', 'stream')
  form.append('file_name', basename(filePath))
  form.append('file', file, basename(filePath))
  const res = await fetch('https://open.feishu.cn/open-apis/im/v1/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  const data = await res.json() as any
  if (data?.code !== 0) {
    log(`feishu: uploadFile ${filePath} code=${data.code} msg=${data.msg}`)
    return null
  }
  return data.data?.file_key ?? null
}

export async function sendImage(chatId: string, imageKey: string): Promise<string | null> {
  try {
    const res: any = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'image', content: JSON.stringify({ image_key: imageKey }) },
    })
    if (res?.code && res.code !== 0) {
      log(`feishu: sendImage rejected chat=${chatId} code=${res.code} msg=${res.msg}`)
      return null
    }
    return res?.data?.message_id ?? null
  } catch (e) { log(`feishu: sendImage failed chat=${chatId}: ${e}`); return null }
}

export async function sendFile(chatId: string, fileKey: string): Promise<string | null> {
  try {
    const res: any = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'file', content: JSON.stringify({ file_key: fileKey }) },
    })
    if (res?.code && res.code !== 0) {
      log(`feishu: sendFile rejected chat=${chatId} code=${res.code} msg=${res.msg}`)
      return null
    }
    return res?.data?.message_id ?? null
  } catch (e) { log(`feishu: sendFile failed chat=${chatId}: ${e}`); return null }
}

/** Upload a local file and post it as an image or file message in the
 * chat.  Type is inferred from extension.  Returns true on success.
 * All failures (missing file, oversize, upload reject, send reject)
 * log and surface an inline error message in the chat so the user
 * knows. */
export async function uploadAndSend(chatId: string, filePath: string): Promise<boolean> {
  try {
    const stats = statSync(filePath)
    if (!stats.isFile()) {
      await sendText(chatId, `❌ 出站文件: 路径不是文件 — ${filePath}`)
      return false
    }
    if (stats.size > MAX_UPLOAD_BYTES) {
      await sendText(chatId, `❌ 出站文件: ${basename(filePath)} 超过 30 MB (${(stats.size / 1024 / 1024).toFixed(1)} MB)`)
      return false
    }
  } catch (e) {
    await sendText(chatId, `❌ 出站文件: 无法读取 ${filePath} (${e})`)
    return false
  }
  const isImage = looksLikeImage(filePath)
  try {
    if (isImage) {
      const key = await uploadImageMultipart(filePath)
      if (!key) { await sendText(chatId, `❌ 出站图片上传失败: ${basename(filePath)}`); return false }
      const msgId = await sendImage(chatId, key)
      return msgId != null
    } else {
      const key = await uploadFileMultipart(filePath)
      if (!key) { await sendText(chatId, `❌ 出站文件上传失败: ${basename(filePath)}`); return false }
      const msgId = await sendFile(chatId, key)
      return msgId != null
    }
  } catch (e) {
    log(`feishu: uploadAndSend ${filePath} failed: ${e}`)
    await sendText(chatId, `❌ 出站文件异常: ${basename(filePath)} — ${e}`)
    return false
  }
}

// ── Project provisioning ──────────────────────────────────────────────
// Bootstrap ~/{name}: create dir, mark as trusted in ~/.claude.json so
// Claude skips the trust dialog, and `git init` so the project starts as
// a real repo.
export function provisionProject(workDir: string): void {
  mkdirSync(workDir, { recursive: true })
  log(`feishu: provisioned ${workDir}`)
  const claudeJsonPath = join(homedir(), '.claude.json')
  try {
    let config: any = {}
    try { config = JSON.parse(readFileSync(claudeJsonPath, 'utf8')) } catch { config = {} }
    if (!config.projects || typeof config.projects !== 'object') config.projects = {}
    config.projects[workDir] = { ...(config.projects[workDir] ?? {}), hasTrustDialogAccepted: true }
    writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2))
  } catch (e) { log(`feishu: trust write failed for ${workDir}: ${e}`) }
  try { execSync('git init -q', { cwd: workDir, stdio: 'ignore' }) } catch {}
}

/** True when claude will hit a non-firstParty backend (DeepSeek / GLM / any
 * anthropic-compatible proxy) and therefore needs no `claude auth login`.
 * Such backends auth with ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY against a
 * custom ANTHROPIC_BASE_URL, so the firstParty probe is the wrong question —
 * Session.start() short-circuits on this so a configured DeepSeek user never
 * hits the bogus "未登录 Anthropic 账号" wall. Checks all three places those
 * vars can reach the spawned claude from:
 *   ① ~/.claude/settings.json `env` — claude's own config, where the setup
 *      wizard now writes DeepSeek (claude reads it natively, terminal too);
 *   ② config.toml [claude.env]    — spawn-time injection (back-compat);
 *   ③ this daemon's own process env — user `export`ed it, child inherits. */
export function hasCustomClaudeBackend(): boolean {
  const keys = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'] as const
  const cfgEnv = config.claude.env
  if (keys.some(k => cfgEnv[k])) return true
  if (keys.some(k => process.env[k])) return true
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'))
    const env = settings?.env
    if (env && typeof env === 'object' && keys.some(k => env[k])) return true
  } catch {}
  return false
}

export function isAnthropicAuthenticated(): boolean {
  try {
    // resolveClaudeBin() rather than a hard-wired ~/.local/bin/claude: an
    // end-user `npm i -g @anthropic-ai/claude-code` drops the binary under
    // the npm-global bin (NOT ~/.local/bin), where the old hard path
    // ENOENT'd → caught → reported "not logged in" even for a properly
    // logged-in firstParty user. Quote the path so a homedir with spaces
    // survives the shell.
    const out = execSync(`"${resolveClaudeBin()}" auth status 2>&1`, { timeout: 10_000 }).toString()
    const status = JSON.parse(out)
    return status.loggedIn === true && status.apiProvider === 'firstParty'
  } catch { return false }
}

export function sanitizeSessionName(raw: string): string {
  return raw.replace(/[^\w一-鿿\-]/g, '_').slice(0, 64)
}
