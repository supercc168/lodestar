import { describe, expect, test } from 'bun:test'

import {
  contextCompactionNoticeFromMessage,
  contextCompactionNoticeFromNotification,
} from './codex-process'

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
    expect(notice?.phase).toBe('end')
  })

  test('detects raw compacted records with replacement history', () => {
    const notice = contextCompactionNoticeFromMessage({
      timestamp: '2026-06-03T16:03:16.331Z',
      type: 'compacted',
      payload: {
        message: '',
        replacement_history: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: '旧消息' }] },
        ],
      },
    })

    expect(notice?.sourceMethod).toBe('compacted')
    expect(notice?.sourceType).toBe('compacted')
    expect(notice?.phase).toBe('start')
    expect(notice?.timestamp).toBe('2026-06-03T16:03:16.331Z')
    expect(notice?.replacement_history).toHaveLength(1)
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
    expect(notice?.phase).toBe('end')
    expect(notice?.itemId).toBe('item-1')
    expect(notice?.threadId).toBe('thread-2')
  })

  test('marks live app-server context compaction item start and completion', () => {
    const started = contextCompactionNoticeFromNotification('item/started', {
      item: {
        type: 'contextCompaction',
        id: 'compact-1',
      },
      threadId: 'thread-3',
      turnId: 'turn-3',
    })
    const completed = contextCompactionNoticeFromNotification('item/completed', {
      item: {
        type: 'contextCompaction',
        id: 'compact-1',
        replacementHistory: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: '旧消息' }] },
        ],
      },
      threadId: 'thread-3',
      turnId: 'turn-3',
    })

    expect(started?.phase).toBe('start')
    expect(started?.itemId).toBe('compact-1')
    expect(started?.threadId).toBe('thread-3')
    expect(completed?.phase).toBe('end')
    expect(completed?.itemId).toBe('compact-1')
    expect(completed?.replacementHistory).toHaveLength(1)
  })

  test('ignores unrelated notifications', () => {
    expect(contextCompactionNoticeFromNotification('thread/settings/updated', {
      threadSettings: { model: 'gpt-5' },
    })).toBeNull()
  })
})
