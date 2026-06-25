import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { localDayKey, logFileForDate, parseLogFileDate, pruneOldLogs } from './log'

describe('log day key', () => {
  test('localDayKey formats local date as YYYY-MM-DD', () => {
    // 月份参数 0-based:5 = 六月
    expect(localDayKey(new Date(2026, 5, 25))).toBe('2026-06-25')
    expect(localDayKey(new Date(2026, 0, 1))).toBe('2026-01-01')
    expect(localDayKey(new Date(2026, 11, 31))).toBe('2026-12-31')
  })

  test('logFileForDate builds daemon-YYYY-MM-DD.log in the given dir', () => {
    const dir = '/tmp/fake-lodestar'
    expect(logFileForDate(new Date(2026, 5, 25), dir)).toBe(join(dir, 'daemon-2026-06-25.log'))
  })
})

describe('parseLogFileDate', () => {
  test('parses daemon-YYYY-MM-DD.log', () => {
    const d = parseLogFileDate('daemon-2026-06-25.log')
    expect(d).not.toBeNull()
    expect(d!.getFullYear()).toBe(2026)
    expect(d!.getMonth()).toBe(5) // 六月
    expect(d!.getDate()).toBe(25)
  })

  test('rejects non-log / malformed names', () => {
    expect(parseLogFileDate('daemon.log')).toBeNull()
    expect(parseLogFileDate('daemon-2026-6-5.log')).toBeNull() // 未补零
    expect(parseLogFileDate('daemon-2026-06-25.txt')).toBeNull()
    expect(parseLogFileDate('session-chat-map.json')).toBeNull()
    expect(parseLogFileDate('')).toBeNull()
  })
})

describe('pruneOldLogs', () => {
  function makeDir(): string {
    return mkdtempSync(join(tmpdir(), 'lodestar-log-test-'))
  }
  function touch(dir: string, name: string): void {
    writeFileSync(join(dir, name), 'x')
  }

  test('removes logs >= 7 days old; keeps recent + non-logs (retains 7 calendar days incl. today)', () => {
    const dir = makeDir()
    const now = new Date(2026, 5, 25) // 2026-06-25
    touch(dir, 'daemon-2026-06-17.log') // 8 天前 → 删
    touch(dir, 'daemon-2026-06-18.log') // 7 天前 → 删(ageDays=7)
    touch(dir, 'daemon-2026-06-19.log') // 6 天前 → 留
    touch(dir, 'daemon-2026-06-25.log') // 今天 → 留
    touch(dir, 'daemon.pid')            // 非日志 → 不动
    touch(dir, 'session-chat-map.json') // 非日志 → 不动

    const removed = pruneOldLogs(dir, now, 7)

    expect(removed).toBe(2)
    expect(readdirSync(dir).sort()).toEqual([
      'daemon-2026-06-19.log',
      'daemon-2026-06-25.log',
      'daemon.pid',
      'session-chat-map.json',
    ])
  })

  test('future-dated files are preserved (clock skew safe)', () => {
    const dir = makeDir()
    const now = new Date(2026, 5, 25)
    touch(dir, 'daemon-2026-06-27.log') // 未来
    touch(dir, 'daemon-2026-06-25.log') // 今天
    expect(pruneOldLogs(dir, now, 7)).toBe(0)
    expect(readdirSync(dir).sort()).toEqual(['daemon-2026-06-25.log', 'daemon-2026-06-27.log'])
  })

  test('missing dir returns 0 without throwing', () => {
    expect(pruneOldLogs(join(tmpdir(), 'lodestar-no-such-dir-xyz'), new Date(2026, 5, 25))).toBe(0)
  })

  test('default retention is 7 days', () => {
    const dir = makeDir()
    const now = new Date(2026, 5, 25)
    touch(dir, 'daemon-2026-06-17.log') // 8 天前
    touch(dir, 'daemon-2026-06-18.log') // 7 天前
    expect(pruneOldLogs(dir, now)).toBe(2)
  })
})
