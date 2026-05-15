import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { LOG_FILE } from './paths'

try { mkdirSync(dirname(LOG_FILE), { recursive: true }) } catch {}

export function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  process.stderr.write(line)
  try { appendFileSync(LOG_FILE, line) } catch {}
}
