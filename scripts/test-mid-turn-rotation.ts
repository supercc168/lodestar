#!/usr/bin/env bun
/**
 * Reproducer for mid-turn rotation: M0 starts a long turn, M1 lands
 * mid-turn, expect old card → 📨 转交新卡 + new card opens for M1 batch,
 * then turn 2 completes naturally with ✅.
 *
 * This script reuses test1's daemon-managed session via the debug
 * inject socket — it does NOT spawn its own Session. All it does is
 * sequence inject calls + dump the relevant slice of daemon.log to a
 * result file. Designed to run from a systemd-run transient unit so
 * it survives `systemctl restart feishu-daemon` killing the originating
 * Codex subprocess.
 */
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { DEBUG_SOCK_FILE, LOG_FILE } from '../src/paths'

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

async function main() {
  const startLine = readFileSync(LOG_FILE, 'utf8').split('\n').length
  console.log(`[${new Date().toISOString()}] start_line=${startLine}`)

  // First inject `kill` to force a clean spawn (no resumed-turn leftover)
  // then a short wait + M0 to trigger first turn fresh.
  console.log(`[${new Date().toISOString()}] sending kill to flush test1`)
  await inject('kill'); await Bun.sleep(3000)
  console.log(`[${new Date().toISOString()}] M0 inject`)
  await inject('你好。请慢慢从1数到20,每个数字单独一行回复,每数字之间停顿1秒'); await Bun.sleep(8000)
  console.log(`[${new Date().toISOString()}] M1 inject (mid-turn)`)
  await inject('停下,告诉我你数到几了'); await Bun.sleep(45000)
  console.log(`[${new Date().toISOString()}] done waiting, dumping log slice`)

  const lines = readFileSync(LOG_FILE, 'utf8').split('\n').slice(startLine)
  const filtered = lines.filter(l =>
    /test1|debug:|SDK init|SDK result|openTurnCard|drainMidTurn|cardkit/.test(l))
  console.log('=== RELEVANT LOG ===')
  for (const l of filtered) console.log(l)
  console.log('=== END ===')
}

main().catch(e => { console.error('fatal:', e); process.exit(1) })
