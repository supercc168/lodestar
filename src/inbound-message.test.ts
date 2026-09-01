import { describe, expect, test } from 'bun:test'
import { isStaleAtReceipt } from './inbound-message'

describe('inbound message freshness', () => {
  test('a fresh accepted message stays fresh even when FIFO processing starts much later', () => {
    const receivedAt = 1_000_000
    const createTime = receivedAt - 1_000

    expect(isStaleAtReceipt(createTime, receivedAt, 30_000)).toBe(false)
    // Processing time is intentionally absent from the API; a 120s queue wait
    // cannot age an already-accepted message into a replay.
  })

  test('rejects a message that was already stale when accepted', () => {
    const receivedAt = 1_000_000
    expect(isStaleAtReceipt(receivedAt - 30_001, receivedAt, 30_000)).toBe(true)
  })

  // 本地补测(pitfall 4 反例数值化):准入时 25s 龄的消息在 30s 阈值下不过期。
  // 若误用"处理时刻"口径,同 chat FIFO 排队几秒就会把这类消息误杀——本用例
  // 锁定 receivedAt 口径下它必须存活。
  test('a message aged 25s at receipt survives the 30s threshold (queue delay cannot kill it)', () => {
    const receivedAt = 1_000_000
    expect(isStaleAtReceipt(receivedAt - 25_000, receivedAt, 30_000)).toBe(false)
  })

  test('createTime <= 0 (missing) is never treated as stale', () => {
    expect(isStaleAtReceipt(0, 1_000_000, 30_000)).toBe(false)
    expect(isStaleAtReceipt(-1, 1_000_000, 30_000)).toBe(false)
  })
})
