/**
 * Feishu (Lark) primitives: Lark client, tenant token cache, chat
 * directory, sendText/sendCard, reactions, attachment download, project
 * provisioning, and Anthropic-auth check.
 *
 * Higher layers (cardkit / session / daemon) build on this.
 */

import * as lark from '@larksuiteoapi/node-sdk'
import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { config } from './config'
import { DATA_DIR, INBOX_DIR, SESSION_CHAT_MAP_FILE } from './paths'
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

// ── Outbound: text + card ──────────────────────────────────────────────
export async function sendText(chatId: string, text: string): Promise<string | null> {
  try {
    const res: any = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
    })
    if (res?.code && res.code !== 0) {
      log(`feishu: sendText rejected chat=${chatId} code=${res.code} msg=${res.msg}`)
      return null
    }
    return res?.data?.message_id ?? null
  } catch (e) { log(`feishu: sendText failed chat=${chatId}: ${e}`); return null }
}

export async function sendCard(chatId: string, card: object): Promise<string | null> {
  try {
    const res: any = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
    })
    if (res?.code && res.code !== 0) {
      log(`feishu: sendCard rejected chat=${chatId} code=${res.code} msg=${res.msg}`)
      return null
    }
    return res?.data?.message_id ?? null
  } catch (e) { log(`feishu: sendCard failed chat=${chatId}: ${e}`); return null }
}

// PATCH a regular interactive message (i.e. a card NOT promoted to a
// cardkit entity). Used for permission cards that flip allow/deny once.
export async function patchCardMessage(messageId: string, card: object): Promise<void> {
  try {
    const token = await getTenantToken()
    const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: JSON.stringify(card) }),
    })
    const data = await res.json() as any
    if (data?.code && data.code !== 0) {
      log(`feishu: patchCardMessage ${messageId} code=${data.code} msg=${data.msg}`)
    }
  } catch (e) { log(`feishu: patchCardMessage ${messageId} failed: ${e}`) }
}

// ── Reactions ──────────────────────────────────────────────────────────
export async function addReaction(messageId: string, emojiType: string): Promise<void> {
  if (!messageId) return
  try {
    await client.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    })
  } catch (e) { log(`feishu: addReaction ${emojiType} on ${messageId} failed: ${e}`) }
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
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'])

function looksLikeImage(filePath: string): boolean {
  const ext = filePath.toLowerCase().split('.').pop() ?? ''
  return IMAGE_EXTS.has(ext)
}

async function uploadImageMultipart(filePath: string): Promise<string | null> {
  const token = await getTenantToken()
  const file = Bun.file(filePath)
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
  const file = Bun.file(filePath)
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
 * chat.  Type is inferred from extension.  Returns true on success.  All
 * failures (missing file, oversize, upload reject, send reject) log and
 * surface an inline error message in the chat so the user knows. */
export async function uploadAndSend(chatId: string, filePath: string): Promise<boolean> {
  try {
    const stats = statSync(filePath)
    if (!stats.isFile()) {
      await sendText(chatId, `❌ 出站文件: 路径不是文件 — ${filePath}`)
      return false
    }
    if (stats.size > MAX_UPLOAD_BYTES) {
      await sendText(chatId, `❌ 出站文件: ${basename(filePath)} 超过 30 MB (${Math.round(stats.size / 1024 / 1024)} MB)`)
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

export function isAnthropicAuthenticated(): boolean {
  try {
    const out = execSync(`${join(homedir(), '.local', 'bin', 'claude')} auth status 2>&1`, { timeout: 10_000 }).toString()
    const status = JSON.parse(out)
    return status.loggedIn === true && status.apiProvider === 'firstParty'
  } catch { return false }
}

export function sanitizeSessionName(raw: string): string {
  return raw.replace(/[^\w一-鿿\-]/g, '_').slice(0, 64)
}
