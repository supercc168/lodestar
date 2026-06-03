import { describe, expect, test } from 'bun:test'

import { contextCompactionNoticeFromNotification } from './codex-process'

describe('codex process compaction notifications', () => {
  test('detects explicit thread compaction notifications', () => {
    const notice = contextCompactionNoticeFromNotification('thread/compacted', {
      threadId: 'thread-1',
      turnId: 'turn-1',
    })

    expect(notice?.sourceMethod).toBe('thread/compacted')
    expect(notice?.threadId).toBe('thread-1')
    expect(notice?.turnId).toBe('turn-1')
  })

  test('detects Codex event messages persisted as context_compacted', () => {
    const notice = contextCompactionNoticeFromNotification('event_msg', {
      type: 'context_compacted',
    })

    expect(notice?.sourceMethod).toBe('event_msg')
    expect(notice?.sourceType).toBe('context_compacted')
  })

  test('detects raw response compaction items', () => {
    const notice = contextCompactionNoticeFromNotification('rawResponseItem/completed', {
      item: {
        type: 'contextCompaction',
        id: 'item-1',
      },
      threadId: 'thread-2',
    })

    expect(notice?.sourceMethod).toBe('rawResponseItem/completed')
    expect(notice?.sourceType).toBe('contextCompaction')
    expect(notice?.itemId).toBe('item-1')
    expect(notice?.threadId).toBe('thread-2')
  })

  test('ignores unrelated notifications', () => {
    expect(contextCompactionNoticeFromNotification('thread/settings/updated', {
      threadSettings: { model: 'gpt-5' },
    })).toBeNull()
  })
})
