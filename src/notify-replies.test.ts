import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  __setStoreFileForTest,
  get,
  loadCallbacks,
  pendingRepliesForChat,
  register,
  type DispatchResult,
  type NotifyRegistration,
  type NotifyTextResponse,
} from './notify-callbacks'
import { createNotifyReplyRuntime, type NotifyReplyMessage } from './notify-replies'

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lodestar-notify-replies-'))
  file = join(dir, 'callbacks.json')
  __setStoreFileForTest(file)
})
afterEach(() => { __setStoreFileForTest(file); rmSync(dir, { recursive: true, force: true }) })

function registration(overrides: Partial<NotifyRegistration> = {}): NotifyRegistration {
  return {
    notifyId: 'nf_reply', callbackUrl: 'http://127.0.0.1:9999/hook',
    chatId: 'oc_group', messageId: 'om_notification', project: 'ops', title: '部署时间',
    text: '请填写部署时间', level: 'info', imageKeys: [], buttons: [], allowReply: true,
    createdAt: Date.now(), ...overrides,
  }
}

function incoming(overrides: Partial<NotifyReplyMessage> = {}): NotifyReplyMessage {
  return {
    chatId: 'oc_group', openId: 'ou_owner', messageId: 'om_input', text: '明天十点',
    createTime: Date.now(), ...overrides,
  }
}

/** 假 deps:记录调用序列,不碰网络/飞书;`controls` 让用例按需注入失败。 */
function harness() {
  const sent: Array<{ chatId: string; messageId: string; card: any }> = []
  const updated: Array<{ messageId: string; card: any }> = []
  const notices: string[] = []
  const delivered: Array<{ notifyId: string; response: NotifyTextResponse; openId: string }> = []
  const waitingChanged: string[] = []
  const logs: string[] = []
  const controls = {
    send: async (): Promise<boolean> => true,
    update: async (): Promise<void> => {},
    dispatch: async (): Promise<DispatchResult> => ({ ok: true, detail: '200', reply: '已安排部署' }),
  }
  const io = {
    sendCard: async (chatId: string, card: object) => {
      if (!await controls.send()) return null
      const messageId = `om_card_${sent.length + 1}`
      sent.push({ chatId, messageId, card })
      return messageId
    },
    updateCard: async (messageId: string, card: object) => {
      updated.push({ messageId, card })
      await controls.update()
    },
    sendText: async (_chatId: string, text: string): Promise<string | null> => { notices.push(text); return 'om_error' },
    dispatch: async (reg: NotifyRegistration, response: NotifyTextResponse, openId: string) => {
      delivered.push({ notifyId: reg.notifyId, response, openId })
      return controls.dispatch()
    },
    onWaitingChanged: (chatId: string) => { waitingChanged.push(chatId) },
    log: (text: string) => { logs.push(text) },
  }
  const runtime = createNotifyReplyRuntime(io)
  const open = (notifyId = 'nf_reply', openId = 'ou_owner', chatId = 'oc_group') => runtime.open(notifyId, chatId, openId)
  const titleOf = (index: number) => updated[index]?.card?.header?.title?.content
  return { ...io, runtime, open, sent, updated, notices, delivered, waitingChanged, logs, controls, titleOf }
}

describe('notification text reply runtime (上游 ae411a6)', () => {
  test('open sends the waiting card, consume posts once and freezes both cards as delivered', async () => {
    register(registration())
    const h = harness()
    expect(await h.open()).toEqual({ ok: true, message: '等待输入卡片已发送，请在群里回复一条文字', presented: true })
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].chatId).toBe('oc_group')
    expect(h.sent[0].card.header.title.content).toBe('等待用户输入')
    expect(JSON.stringify(h.sent[0].card)).toContain('ou_owner')

    expect(await h.runtime.consume(incoming())).toBe(true)
    expect(h.delivered).toEqual([{
      notifyId: 'nf_reply', openId: 'ou_owner',
      response: { text: '明天十点', message_id: 'om_input', prompt_message_id: 'om_card_1' },
    }])
    // 等待卡先转「正在发送回复」,再落「回复已送达」;通知卡也落到同一终态。
    expect(h.updated[0].messageId).toBe('om_card_1')
    expect(h.titleOf(0)).toBe('正在发送回复')
    expect(h.titleOf(1)).toBe('回复已送达')
    expect(JSON.stringify(h.updated[1].card)).toContain('已安排部署')
    expect(h.updated[2].messageId).toBe('om_notification')
    expect(h.titleOf(2)).toBe('回复已送达')
    expect(get('nf_reply')!.resolvedAt).toBeDefined()
    expect(pendingRepliesForChat('oc_group')).toHaveLength(0)
  })

  test('onWaitingChanged fires once per open and once per consume (IN-01 生产调用点)', async () => {
    register(registration())
    const h = harness()
    await h.open()
    expect(h.waitingChanged).toEqual(['oc_group'])
    await h.runtime.consume(incoming())
    expect(h.waitingChanged).toEqual(['oc_group', 'oc_group'])
    // 拒绝路径不发卡片也不触发刷新(无等待态变化)。
    h.waitingChanged.length = 0
    expect((await h.open('missing')).ok).toBe(false)
    expect(h.waitingChanged).toEqual([])
  })

  test('owner can cancel; the cancelled reply stops capturing input and only the clicker may cancel', async () => {
    register(registration())
    const h = harness()
    await h.open()
    const previous = get('nf_reply')!.replyState!
    expect((await h.runtime.cancel('nf_reply', previous.id, 'oc_group', 'ou_other')).ok).toBe(false)
    expect(await h.runtime.cancel('nf_reply', previous.id, 'oc_group', 'ou_owner')).toEqual({
      ok: true, message: '已取消回复', presented: true,
    })
    expect(h.titleOf(h.updated.length - 1)).toBe('已取消回复')
    expect(h.waitingChanged).toEqual(['oc_group', 'oc_group'])
    expect(get('nf_reply')!.replyState!.status).toBe('cancelled')
    expect(await h.runtime.consume(incoming())).toBe(false)
    expect(h.delivered).toHaveLength(0)
  })

  test('wrong chat, anonymous open and a reply-disabled notification never send a waiting card', async () => {
    register(registration({ allowReply: false }))
    const h = harness()
    expect(await h.open()).toEqual({ ok: false, message: '此通知未开启文字回复' })
    register(registration())
    expect(await h.open('nf_reply', 'ou_owner', 'oc_wrong')).toEqual({ ok: false, message: '通知不属于当前群，操作未执行' })
    expect(await h.open('nf_reply', '')).toEqual({ ok: false, message: '无法识别回复人，操作未执行' })
    expect(await h.open('missing')).toEqual({ ok: false, message: '通知已过期或已移除' })
    expect(h.sent).toHaveLength(0)
    // 归属校验同时只认点击「回复」的那个人与那个群。
    await h.open()
    expect(await h.runtime.consume(incoming({ openId: 'ou_other' }))).toBe(false)
    expect(await h.runtime.consume(incoming({ chatId: 'oc_other' }))).toBe(false)
    expect(await h.runtime.consume(incoming({ text: '   ' }))).toBe(false)
    expect(await h.runtime.consume(incoming({ messageId: '' }))).toBe(false)
    expect(h.delivered).toHaveLength(0)
  })

  test('a dispatch that throws is visible, releases input and is never auto-resent', async () => {
    register(registration())
    const h = harness()
    await h.open()
    h.controls.dispatch = async () => { throw new Error('loopback 回调连接被拒') }
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect(h.delivered).toHaveLength(1)
    expect(h.titleOf(h.updated.length - 1)).toBe('回复发送失败')
    expect(JSON.stringify(h.updated.map(entry => entry.card))).toContain('loopback 回调连接被拒')
    expect(get('nf_reply')!.replyState!.status).toBe('failed')
    expect(pendingRepliesForChat('oc_group')).toHaveLength(0)
    // 同一条输入不会因为重放而被二次 POST,也不会自动重发。
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect(h.delivered).toHaveLength(1)
    expect(get('nf_reply')!.resolvedAt).toBeUndefined()
    expect(get('nf_reply')!.unknownAt).toBeUndefined()
  })

  test('a successful callback whose tombstone cannot be persisted freezes as UNKNOWN and never resends', async () => {
    register(registration())
    const h = harness()
    await h.open()
    h.controls.dispatch = async () => {
      __setStoreFileForTest(join(file, 'bad.json'), false)
      return { ok: true, detail: '200' }
    }
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect(h.delivered).toHaveLength(1)
    expect(get('nf_reply')!.unknownAt).toBeDefined()
    expect(h.titleOf(h.updated.length - 1)).toBe('回复送达状态未知')
    expect(h.logs.some(line => line.includes('status=unknown'))).toBe(true)
    // 冻结后既不重开等待卡,也不重发。
    expect((await h.open()).ok).toBe(false)
    expect(await h.runtime.consume(incoming({ messageId: 'om_again' }))).toBe(false)
    expect(h.delivered).toHaveLength(1)
  })

  test('recover redraws the UNKNOWN receipt after a restart without dispatching again', async () => {
    register(registration())
    const h = harness()
    await h.open()
    h.controls.dispatch = async () => {
      __setStoreFileForTest(join(file, 'bad.json'), false)
      return { ok: true, detail: '200' }
    }
    await h.runtime.consume(incoming())
    __setStoreFileForTest(file)
    const interrupted = loadCallbacks()
    expect(interrupted).toHaveLength(1)
    const before = h.updated.length
    await h.runtime.recover(interrupted[0])
    expect(h.updated.length).toBe(before + 2)
    expect(h.titleOf(before)).toBe('回复送达状态未知')
    expect(h.titleOf(before + 1)).toBe('回复送达状态未知')
    expect(h.delivered).toHaveLength(1)
  })

  test('the newest reply replaces the previous one for the whole chat and abandons its input', async () => {
    register(registration())
    register(registration({ notifyId: 'nf_other' }))
    const h = harness()
    expect((await h.open()).ok).toBe(true)
    expect(await h.open()).toEqual({ ok: false, message: '此通知正在等待回复，请先在群里输入或由回复人取消' })
    expect(await h.open('nf_other')).toEqual({ ok: false, message: '上一条通知回复正在发送，请稍后切换' })
    expect((await h.open('nf_other', 'ou_other')).ok).toBe(true)
    expect(get('nf_reply')!.replyState!.status).toBe('cancelled')
    expect(get('nf_reply')!.replyState!.cancelReason).toBe('switched')
    expect(pendingRepliesForChat('oc_group').map(reg => reg.notifyId)).toEqual(['nf_other'])
    // 被放弃的输入永远不被提交,也不再被捕获。
    expect(await h.runtime.consume(incoming())).toBe(false)
    expect(await h.runtime.consume(incoming({ openId: 'ou_other' }))).toBe(true)
    expect(h.delivered.map(entry => entry.notifyId)).toEqual(['nf_other'])
  })

  test('pull mode (no callback URL) records the text without any dispatch', async () => {
    register(registration({ callbackUrl: '' }))
    const h = harness()
    await h.open()
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect(h.delivered).toHaveLength(0)
    expect(h.titleOf(1)).toBe('回复已记录')
    expect(get('nf_reply')!.resolvedAt).toBeDefined()
  })

  test('input older than the prompt and a duplicate message_id are not dispatched', async () => {
    register(registration())
    const h = harness()
    await h.open()
    const openedAt = get('nf_reply')!.replyState!.openedAt
    expect(await h.runtime.consume(incoming({ createTime: openedAt - 1 }))).toBe(false)
    expect(await h.runtime.consume(incoming())).toBe(true)
    // durable 去重:同一条飞书消息重放既不再 POST 也不变成新轮。
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect(h.delivered).toHaveLength(1)
  })

  test('the waiting state survives a reload and the consumed input stays deduplicated', async () => {
    register(registration())
    const h = harness()
    await h.open()
    __setStoreFileForTest(file)
    loadCallbacks()
    expect(await h.open()).toEqual({ ok: false, message: '此通知正在等待回复，请先在群里输入或由回复人取消' })
    expect(await h.runtime.consume(incoming())).toBe(true)
    __setStoreFileForTest(file)
    loadCallbacks()
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect(h.delivered).toHaveLength(1)
    expect((await h.open()).ok).toBe(false)
  })

  test('a failed waiting-card send never reserves input', async () => {
    register(registration())
    const h = harness()
    h.controls.send = async () => false
    expect(await h.open()).toEqual({
      ok: false, message: '等待输入卡片发送失败，未开始接收回复，请重新点击「回复」',
    })
    expect(pendingRepliesForChat('oc_group')).toHaveLength(0)
    expect(await h.runtime.consume(incoming())).toBe(false)
    expect(h.delivered).toHaveLength(0)
  })

  test('a waiting state that cannot be persisted marks its card failed and never captures input', async () => {
    register(registration())
    const h = harness()
    __setStoreFileForTest(join(file, 'bad.json'), false)
    const result = await h.open()
    expect(result.ok).toBe(false)
    expect(result.presented).toBe(true)
    expect(h.titleOf(0)).toBe('回复发送失败')
    expect(pendingRepliesForChat('oc_group')).toHaveLength(0)
    expect(await h.runtime.consume(incoming())).toBe(false)
    expect(h.delivered).toHaveLength(0)
  })

  test('input persistence failure is surfaced and never dispatches', async () => {
    register(registration())
    const h = harness()
    await h.open()
    __setStoreFileForTest(join(file, 'bad.json'), false)
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect(h.notices.some(text => text.includes('回复保存失败，尚未回传'))).toBe(true)
    expect(get('nf_reply')!.replyState!.status).toBe('waiting')
    expect(h.delivered).toHaveLength(0)
  })
})
