#!/usr/bin/env bun
/**
 * Lodestar 2.0 smoke test.
 *
 * Drives the full Session pipeline (Codex app-server + cardkit streaming
 * card) against a real Feishu group, without standing up the WSClient.
 *
 * Usage:
 *   bun scripts/smoke.ts                           # list groups
 *   bun scripts/smoke.ts "<group name>"            # default prompt
 *   bun scripts/smoke.ts "<group name>" "你好…"    # custom prompt
 *
 * Sends a `[SMOKE]` preface message in the group so you can correlate
 * the run with what you see, then drives Session.onUserMessage directly
 * with the same prompt. All cardkit / codex-process activity logs to
 * stderr and to <data_dir>/daemon-YYYY-MM-DD.log.
 */

// Smoke imports the daemon modules directly; they auto-load config.toml
// from $LODESTAR_CONFIG / $LODESTAR_CONFIG_DIR / XDG default — exactly
// what the production daemon does, so smoke and daemon share one config.
import * as feishu from '../src/feishu'
import { Session } from '../src/session'
import { log } from '../src/log'

// ── Discover groups ───────────────────────────────────────────────────
await feishu.refreshChatList()
console.log(`\n[discovery] visible groups (${feishu.chatNameCache.size}):`)
for (const [id, name] of feishu.chatNameCache) console.log(`  • ${name}\t${id}`)

const targetName = process.argv[2]
if (!targetName) {
  console.log('\nusage: bun scripts/smoke.ts "<group name>" ["prompt text"]')
  process.exit(0)
}

let chatId: string | null = null
for (const [id, name] of feishu.chatNameCache) {
  if (name === targetName) { chatId = id; break }
}
if (!chatId) {
  console.error(`\nsmoke: group "${targetName}" not found among visible chats`)
  process.exit(1)
}

const userText = process.argv.slice(3).join(' ').trim()
  || '你好，简单介绍一下你自己，用三句话。'

const sessionName = feishu.sanitizeSessionName(targetName)
feishu.bindSessionToChat(sessionName, chatId)

console.log(`\n[smoke] target group: "${targetName}" (${chatId})`)
console.log(`[smoke] session name : "${sessionName}"`)
console.log(`[smoke] prompt       : ${userText}`)

// ── Pre-announce in the group so the human can correlate ──────────────
const previewMsgId = await feishu.sendText(
  chatId,
  `🧪 [SMOKE] Lodestar 2.0 测试，下面这条作为模拟用户输入注入：\n> ${userText}`,
)
log(`smoke: preface message_id=${previewMsgId ?? '(failed)'}`)

// ── Drive Session ─────────────────────────────────────────────────────
// Lodestar starts Codex with full access, so smoke can exercise tool calls
// without a separate permission listener.
const session = new Session(sessionName, chatId)
await session.onUserMessage(userText, [])

// ── Poll for completion ───────────────────────────────────────────────
const TIMEOUT_MS = 5 * 60_000
const start = Date.now()
while (Date.now() - start < TIMEOUT_MS) {
  await new Promise(r => setTimeout(r, 2_000))
  log(`smoke: status=${session.status} elapsed=${Math.round((Date.now() - start) / 1000)}s`)
  if (session.status === 'idle' || session.status === 'stopped') break
}

if (session.status === 'awaiting_permission') {
  log(`smoke: stuck on permission card — WS not running, no button click possible. Use a prompt that needs no tool calls, or run the full daemon.`)
}

// Give cardkit's outbound queue a moment to fully drain, then stop.
await new Promise(r => setTimeout(r, 2_000))
await session.stop('smoke 完成')
log('smoke: done')
process.exit(0)
