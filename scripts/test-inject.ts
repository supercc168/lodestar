#!/usr/bin/env bun
/**
 * Replay messages into the running daemon as if Feishu WS had
 * delivered them. The daemon's unix socket (DEBUG_SOCK_FILE) takes
 * `{text}` JSON and routes it through the real `handleMessage` path.
 *
 * One-time seeding: from the target Feishu group, send a single
 * `[DEBUG]hi` (or `[DEBUG]<anything>`). The daemon captures that
 * chat_id + sender_open_id to DEBUG_CTX_FILE; subsequent injections
 * reuse it without touching Feishu.
 *
 * Usage:
 *   bun scripts/test-inject.ts "hi"                  # one message
 *   bun scripts/test-inject.ts "1" "2" "3"           # 3 messages, default 200ms gap
 *   bun scripts/test-inject.ts --delay 50 "1" "2"    # custom gap (ms)
 *   bun scripts/test-inject.ts --delay 0 "a" "b"     # back-to-back
 */
import { request } from 'node:http'
import { DEBUG_SOCK_FILE } from '../src/paths'

function parseArgs(argv: string[]): { delay: number; texts: string[] } {
  let delay = 200
  const texts: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--delay') { delay = Number(argv[++i] ?? '200'); continue }
    texts.push(a)
  }
  return { delay, texts }
}

function inject(text: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ text })
    const req = request({
      socketPath: DEBUG_SOCK_FILE,
      method: 'POST',
      path: '/',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

const { delay, texts } = parseArgs(Bun.argv.slice(2))
if (texts.length === 0) {
  console.error('usage: bun scripts/test-inject.ts [--delay <ms>] <text>...')
  process.exit(1)
}

for (let i = 0; i < texts.length; i++) {
  const t = texts[i]
  try {
    const r = await inject(t)
    const ok = r.status >= 200 && r.status < 300
    console.log(`[${i + 1}/${texts.length}] ${ok ? 'ok' : `HTTP ${r.status}`}  text=${JSON.stringify(t)}  ${ok ? r.body : `body=${r.body}`}`)
    if (!ok) process.exit(2)
  } catch (e) {
    console.error(`[${i + 1}/${texts.length}] socket error: ${e}`)
    process.exit(3)
  }
  if (delay > 0 && i < texts.length - 1) await Bun.sleep(delay)
}
