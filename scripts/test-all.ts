#!/usr/bin/env bun
/**
 * Lodestar 2.0 — comprehensive smoke driver.
 *
 * Runs against a real Feishu group (default: test1).  Drives
 * Session.runCommand / Session.onUserMessage directly so the WS daemon
 * is NOT required (and must in fact be stopped to avoid one-chat-two-
 * sessions collision).  Each phase announces itself in the group with a
 * `🧪 [Test N/M]` preface so a human watching their phone can follow
 * along.
 *
 * Coverage:
 *   1.  kill on a stopped session            — should report "未运行"
 *   2.  hi                                   — start + console card
 *   3.  basic stream + thinking + tool call  — bypassPermissions
 *   4.  outbound [[send: /path]] marker      — Claude generates a file,
 *                                              daemon strips the marker
 *                                              from the card and ships
 *                                              the file as a separate msg
 *   5.  mid-flight interrupt                 — second user msg arrives
 *                                              while first turn is in
 *                                              progress
 *   6.  inbound image                        — synthetic PNG handed off
 *                                              as a [file: ...] hint
 *   7.  restart (resume)                     — keeps the prior session id
 *   8.  clear (fresh)                        — kills + starts new
 *
 * Permission-card flow needs a live WS to click buttons; this script
 * uses bypassPermissions, so the permission card itself is exercised
 * separately (manual / WS-based test, not here).
 */

import { existsSync, writeFileSync } from 'node:fs'
import * as feishu from '../src/feishu'
import { Session } from '../src/session'

const TARGET = process.argv[2] ?? 'test1'

await feishu.refreshChatList()
let chatId: string | null = null
for (const [id, name] of feishu.chatNameCache) {
  if (name === TARGET) { chatId = id; break }
}
if (!chatId) {
  console.error(`test-all: group "${TARGET}" not found among ${feishu.chatNameCache.size} chats`)
  process.exit(1)
}
const sessionName = feishu.sanitizeSessionName(TARGET)
feishu.bindSessionToChat(sessionName, chatId)

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const announce = (s: string) => feishu.sendText(chatId!, `🧪 ${s}`)

async function waitIdle(s: Session, maxMs: number, label = ''): Promise<void> {
  const start = Date.now()
  // Wait up to 5s for the session to actually leave idle/stopped — i.e.
  // verify a turn really started before we wait for it to finish.
  // Without this guard, a Claude turn that completes between
  // onUserMessage's `await` resolving and our first poll would let us
  // exit before observing any work at all.
  while (Date.now() - start < 5000) {
    if (s.status === 'working' || s.status === 'awaiting_permission' || s.status === 'starting') break
    await sleep(200)
  }
  while (Date.now() - start < maxMs) {
    if (s.status === 'idle' || s.status === 'stopped') return
    await sleep(1000)
  }
  console.warn(`waitIdle ${label}: timed out at status=${s.status}`)
}

function ensureSampleImage(): string {
  const path = '/tmp/lodestar-test-image.png'
  if (existsSync(path)) return path
  // 60x60 solid red PNG.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAADwAAAA8CAIAAAA+ZgKaAAAAGUlEQVR42u3BMQEAAADCoPVPbQwfoAAA' +
      'AOBNDQABbCzD4QAAAABJRU5ErkJggg==',
    'base64',
  )
  writeFileSync(path, png)
  return path
}

console.log(`\n[test-all] target="${TARGET}" chat_id=${chatId} session_name=${sessionName}\n`)

await announce('[全面测试 START] Lodestar 2.0 — 控制指令 + 流式 + 出站文件 + 入站图片')
await sleep(1500)

// ──────────────────────────────────────────────────────────────────────
// 1) kill on stopped session
await announce('[1/8] runCommand("kill") @ stopped — 期待 ⚪ 未运行')
const session = new Session(sessionName, chatId, { permissionMode: 'bypassPermissions' })
await session.runCommand('kill')
await sleep(2500)

// 2) hi → start + console card
await announce('[2/8] runCommand("hi") @ stopped — 期待 ✅ 启动 + 控制台卡片（含按钮）')
await session.runCommand('hi')
await sleep(4000)

// 3) basic stream + thinking + tool call
await announce('[3/8] 基础流：思考 + assistant + Bash 工具')
await session.onUserMessage('用 Bash 执行 `uname -a && uptime`，然后用一句话总结这台机器现在的状态。')
await waitIdle(session, 120_000, 'phase3')
await sleep(2000)

// 4) outbound [[send: /path]]
await announce('[4/8] 出站文件：让 Claude 生成 /tmp/lodestar-out.txt 并以 [[send: ...]] 发回群')
await session.onUserMessage(
  '用 Bash 执行 `echo "lodestar 2.0 outbound test — $(date)" > /tmp/lodestar-out.txt`，' +
  '然后用一句话告诉我已经写入，并在回复末尾**单独一行**加 [[send: /tmp/lodestar-out.txt]] 把文件发给我。',
)
await waitIdle(session, 120_000, 'phase4')
await sleep(3000)

// 5) mid-flight interrupt
await announce('[5/8] 中途打断：发一条慢任务，2s 后再发一条新任务')
const longRun = session.onUserMessage('请用中文逐字数 1 到 50（每个数字独立一行），慢慢说。')
await sleep(2000)
await session.onUserMessage('好了别数了，换个话题：用一句话告诉我今天日期。')
await Promise.allSettled([longRun])
await waitIdle(session, 90_000, 'phase5')
await sleep(2000)

// 6) inbound image
await announce('[6/8] 入站图片：模拟用户发图，传入合成的 60×60 红色 PNG')
const imgPath = ensureSampleImage()
await session.onUserMessage('帮我描述一下这张图的颜色和尺寸。', [imgPath])
await waitIdle(session, 120_000, 'phase6')
await sleep(2000)

// 7) restart (resume)
await announce('[7/8] runCommand("restart") — 期待 🔁 resume 同 session-id')
await session.runCommand('restart')
await sleep(5000)

// 8) clear (fresh — kills + starts new)
await announce('[8/8] runCommand("clear") — 期待 ⚪ kill + 🚀 启动新 session')
await session.runCommand('clear')
await sleep(5000)

await session.stop('测试结束')
await announce('[全面测试 END] ✅ 8/8 完成。请翻看群内所有卡片确认。')

console.log('\n[test-all] done')
process.exit(0)
