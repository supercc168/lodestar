import { describe, expect, test } from 'bun:test'

import {
  diffUsageTotals,
  effectiveTurnTokens,
  contextCompactionNoticeFromMessage,
  contextCompactionNoticeFromNotification,
  CodexProcess,
  usageFromTokenUsagePayload,
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

  test('unmapped app-server notifications are logged without breaking message handling', () => {
    const proc = Object.create(CodexProcess.prototype) as any
    const raw: unknown[] = []
    const compacted: unknown[] = []
    proc.opts = { workDir: '/tmp' }
    proc.emit = (event: string, payload: unknown) => {
      if (event === 'raw') raw.push(payload)
      if (event === 'context_compacted') compacted.push(payload)
      return true
    }

    expect(() => proc.handleNotification('item/started', {
      item: { type: 'contextCompaction', id: 'compact-2' },
      threadId: 'thread-4',
      turnId: 'turn-4',
    })).not.toThrow()
    expect(() => proc.handleNotification('thread/status/changed', {
      threadId: 'thread-4',
      status: { type: 'idle' },
    })).not.toThrow()
    expect(() => proc.handleNotification('item/started', {
      item: { type: 'reasoning', id: 'rs-1', summary: [], content: [] },
      threadId: 'thread-4',
      turnId: 'turn-4',
    })).not.toThrow()
    expect(raw).toHaveLength(1)
    expect(compacted).toHaveLength(1)
  })
})

describe('codex token usage helpers', () => {
  test('parses app-server token usage payloads for last and total snapshots', () => {
    expect(usageFromTokenUsagePayload({
      totalTokens: 1200,
      inputTokens: 900,
      outputTokens: 300,
      reasoningOutputTokens: 220,
      cachedInputTokens: 400,
    })).toEqual({
      total_tokens: 1200,
      input_tokens: 900,
      output_tokens: 300,
      reasoning_output_tokens: 220,
      cache_creation_input_tokens: undefined,
      cache_read_input_tokens: 400,
    })
  })

  test('computes turn aggregate from absolute thread totals', () => {
    const usage = diffUsageTotals(
      {
        total_tokens: 10_000,
        input_tokens: 7_000,
        output_tokens: 3_000,
        reasoning_output_tokens: 1_200,
        cache_read_input_tokens: 2_800,
      },
      {
        total_tokens: 4_000,
        input_tokens: 3_100,
        output_tokens: 900,
        reasoning_output_tokens: 500,
        cache_read_input_tokens: 1_200,
      },
    )

    expect(usage).toEqual({
      total_tokens: 6000,
      input_tokens: 3900,
      output_tokens: 2100,
      reasoning_output_tokens: 700,
      cache_creation_input_tokens: undefined,
      cache_read_input_tokens: 1600,
    })
    expect(effectiveTurnTokens(usage)).toBe(6000)
    expect(effectiveTurnTokens({ total_tokens: 1234 })).toBe(1234)
    expect(effectiveTurnTokens(null)).toBeNull()
  })

  test('clamps negative deltas and treats missing totals as unknown', () => {
    expect(diffUsageTotals(
      { input_tokens: 100, output_tokens: 20 },
      { input_tokens: 120, output_tokens: 10 },
    )).toEqual({
      total_tokens: undefined,
      input_tokens: 0,
      output_tokens: 10,
      reasoning_output_tokens: undefined,
      cache_creation_input_tokens: undefined,
      cache_read_input_tokens: undefined,
    })
    expect(diffUsageTotals(null, null)).toBeNull()
  })
})
