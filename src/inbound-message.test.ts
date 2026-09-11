import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  acceptsPendingQuestionText,
  acceptsPendingReplyText,
  consumePendingTextInput,
  inboundMessageResource,
  inboundResourceDownloadFailureText,
  isStaleAtReceipt,
} from './inbound-message'

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

describe('inbound native message resources', () => {
  test('maps a video media message to its downloadable file resource', () => {
    expect(inboundMessageResource('media', {
      duration: 35_003,
      file_key: 'file_v2_video',
      file_name: 'clip.mp4',
      image_key: 'img_v2_thumbnail',
    })).toEqual({
      key: 'file_v2_video',
      type: 'file',
      name: 'clip.mp4',
      displayText: '(video: clip.mp4)',
    })
  })

  test('preserves existing image and file resource mappings', () => {
    expect(inboundMessageResource('image', { image_key: 'img_v2_photo' })).toEqual({
      key: 'img_v2_photo',
      type: 'image',
      displayText: '',
    })
    expect(inboundMessageResource('file', {
      file_key: 'file_v2_document',
      file_name: 'notes.pdf',
    })).toEqual({
      key: 'file_v2_document',
      type: 'file',
      name: 'notes.pdf',
      displayText: '(file: notes.pdf)',
    })
  })

  test('rejects unsupported or keyless resources', () => {
    expect(inboundMessageResource('audio', { file_key: 'file_v2_audio' })).toBeNull()
    expect(inboundMessageResource('media', { file_name: 'clip.mp4' })).toBeNull()
  })

  test('explains the 100 MB Feishu download limit without claiming it is the only cause', () => {
    expect(inboundResourceDownloadFailureText('media')).toBe(
      '❌ 收到的视频下载失败，未转交给 Agent。备注：可能是视频超过飞书消息资源 100 MB 下载上限。',
    )
  })
})

describe('pending text input priority(上游 ae411a6)', () => {
  test('a hit on the pending reply consumes the text:question path never runs', async () => {
    const calls: string[] = []
    const consumed = await consumePendingTextInput({
      reply: async () => { calls.push('reply'); return true },
      hasQuestion: () => { calls.push('hasQuestion'); return true },
      answerQuestion: async () => { calls.push('answerQuestion') },
    })

    expect(consumed).toBe(true)
    expect(calls).toEqual(['reply'])
  })

  test('a miss on reply falls back to the pending question', async () => {
    const calls: string[] = []
    const consumed = await consumePendingTextInput({
      reply: async () => { calls.push('reply'); return false },
      hasQuestion: () => { calls.push('hasQuestion'); return true },
      answerQuestion: async () => { calls.push('answerQuestion') },
    })

    expect(consumed).toBe(true)
    expect(calls).toEqual(['reply', 'hasQuestion', 'answerQuestion'])
  })

  test('neither pending reply nor pending question leaves the text to Agent routing', async () => {
    const calls: string[] = []
    const consumed = await consumePendingTextInput({
      reply: async () => { calls.push('reply'); return false },
      hasQuestion: () => { calls.push('hasQuestion'); return false },
      answerQuestion: async () => { calls.push('answerQuestion') },
    })

    expect(consumed).toBe(false)
    expect(calls).toEqual(['reply', 'hasQuestion'])
  })

  test('a throwing reply propagates instead of silently falling through', async () => {
    let answered = false
    await expect(consumePendingTextInput({
      reply: async () => { throw new Error('store unavailable') },
      hasQuestion: () => true,
      answerQuestion: async () => { answered = true },
    })).rejects.toThrow('store unavailable')
    expect(answered).toBe(false)
  })
})

// 02-REVIEW WR-04:新消费点曾把 post 纳入提问分支,与紧邻的保留注释
// 「post / 图片 / 文件 / 视频附件都按一次新轮处理」相互矛盾。门控拆成纯函数后,
// post 只走通知回复,提问回答仍严格 text-only。
describe('pending text routing gates(上游 ae411a6 / 02-REVIEW WR-04)', () => {
  test('post 富文本可消费通知回复,但永不作为提问答案被消费', () => {
    expect(acceptsPendingReplyText('post', '明天十点', false)).toBe(true)
    expect(acceptsPendingQuestionText('post', '明天十点')).toBe(false)
  })

  test('text 两条通道都是候选:回复优先由 consumePendingTextInput 的调用顺序保证', () => {
    expect(acceptsPendingReplyText('text', '明天十点', false)).toBe(true)
    expect(acceptsPendingQuestionText('text', '明天十点')).toBe(true)
  })

  test('带附件 post / 非文本消息 / 空文本都不进任何消费通道', () => {
    expect(acceptsPendingReplyText('post', '看这张图', true)).toBe(false)
    for (const type of ['image', 'file', 'media', 'audio', 'sticker']) {
      expect(acceptsPendingReplyText(type, 'x', false)).toBe(false)
      expect(acceptsPendingQuestionText(type, 'x')).toBe(false)
    }
    expect(acceptsPendingReplyText('text', '', false)).toBe(false)
    expect(acceptsPendingReplyText('text', undefined, false)).toBe(false)
    expect(acceptsPendingQuestionText('text', '')).toBe(false)
    expect(acceptsPendingQuestionText('text', undefined)).toBe(false)
  })

  test('daemon 接线:提问分支走 text-only 门控,不再内联 text||post 条件(WR-04)', async () => {
    const source = await readFile(join(import.meta.dir, '..', 'daemon.ts'), 'utf8')
    expect(source).toMatch(/if \(acceptsPendingQuestionText\(msgType, text\) && session\.hasPendingAsk\(\)\)/)
    expect(source).toContain('acceptsPendingReplyText(msgType, text, postHasAttachments)')
    // 回归形态:提问分支曾被 (msgType === 'text' || msgType === 'post') 覆盖。
    expect(source).not.toMatch(/\|\| msgType === 'post'\)[^\n]*\n[^\n]*await consumePendingTextInput/)
  })
})
