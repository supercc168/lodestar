/**
 * Feishu (Lark) primitives: Lark client, tenant token cache, chat
 * directory, sendText/sendCard, reactions, attachment download, project
 * provisioning, and Anthropic-auth check.
 *
 * Higher layers (cardkit / session / daemon) build on this.
 */

import * as lark from '@larksuiteoapi/node-sdk'
import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { config } from './config'
import { INBOX_DIR, SESSION_CHAT_MAP_FILE } from './paths'
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
    mkdirSync(STATE_DIR, { recursive: true })
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
