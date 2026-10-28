import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { addedReactions, resetFeishuMock } from './feishu-test-mock'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  __setStoreFileForTest, register, get, loadCallbacks, buildNotifyResult, findPendingReply,
  pendingRepliesForChat, beginCallbackDispatch, setReplyState,
  type NotifyRegistration, type NotifyTextResponse, type DispatchResult,
} from './notify-callbacks'
import { handleNotifyRequest } from './notify'
import { createNotifyReplyRuntime, type NotifyReplyMessage } from './notify-replies'
import { PerKeyActor } from './card-action-runtime'
import { consumePendingTextInput } from './inbound-message'
import * as sessionAsk from './session-ask'
import * as cards from './cards'
import type { Session } from './session'

let dir: string
let file: string
beforeEach(() => {
  resetFeishuMock()
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
  return { chatId: 'oc_group', openId: 'ou_owner', messageId: 'om_input', text: '明天十点', createTime: Date.now(), ...overrides }
}

/** 假 deps:记录调用序列,不碰网络/飞书;`controls` 让用例按需注入失败。
 *  定型实现(本地)的 deps 不携带 onFailure 回调:sendCard/sendText 只回
 *  string|null,失败详情由实现侧从 Error.message(detailOf)取。 */
function harness() {
  const sent: Array<{ chatId: string; messageId: string; card: any }> = []
  const updated: Array<{ messageId: string; card: any }> = []
  const notices: string[] = []
  const uploads: string[] = []
  const delivered: Array<{ notifyId: string; response: NotifyTextResponse; openId: string }> = []
  const waitingChanged: string[] = []
  const logs: string[] = []
  const controls = {
    send: async (): Promise<boolean> => true,
    sendText: async (): Promise<boolean> => true,
    update: async (): Promise<void> => {},
    dispatch: async (): Promise<DispatchResult> => ({ ok: true, detail: '200', reply: '已安排部署' }),
    waitingChanged: (_chatId: string): void => {},
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
    sendText: async (_chatId: string, text: string): Promise<string | null> => {
      notices.push(text)
      return await controls.sendText() ? 'om_error' : null
    },
    dispatch: async (reg: NotifyRegistration, response: NotifyTextResponse, openId: string) => {
      delivered.push({ notifyId: reg.notifyId, response, openId })
      return controls.dispatch()
    },
    onWaitingChanged: (chatId: string) => {
      waitingChanged.push(chatId)
      controls.waitingChanged(chatId)
    },
    logError: (event: string, _error: unknown) => { logs.push(event) },
  }
  const runtime = createNotifyReplyRuntime(io)
  const open = (notifyId = 'nf_reply', openId = 'ou_owner', chatId = 'oc_group') => runtime.open(notifyId, chatId, openId)
  const request = async (body?: object, path = '/notify') => {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as IncomingMessage
    req.method = body === undefined ? 'GET' : 'POST'
    req.url = path
    req.headers = { host: 'localhost' }
    let raw = ''
    const res = { statusCode: 200, setHeader: () => {}, end: (text: string) => { raw = text } } as unknown as ServerResponse
    await handleNotifyRequest(req, res, {
      ...io, sanitizeSessionName: name => name, chatIdForSession: () => 'oc_group',
      uploadImageKey: async path => { uploads.push(path); return 'img_test' },
    })
    return { status: res.statusCode, raw }
  }
  // 等待卡是独立消息,标题即状态;通知原卡保留自己的 header,状态只进 body。
  const titleOf = (index: number) => updated[index]?.card?.header?.title?.content
  const bodyOf = (index: number) => JSON.stringify(updated[index]?.card?.body ?? {})
  return { ...io, runtime, open, request, sent, updated, notices, uploads, delivered, waitingChanged, logs, controls, titleOf, bodyOf }
}

function questionsFor(h: ReturnType<typeof harness>) {
  const permissionReplies: Array<{ id: string; answers: Record<string, string> }> = []
  const agentInputs: string[] = []
  const s = {
    sessionName: 'ops', chatId: 'oc_group', currentTurn: null, status: 'working',
    pendingAsks: new Map(), pendingPermissions: new Map(),
    proc: { sendPermissionResponse: (id: string, _decision: string, options: any) => {
      permissionReplies.push({ id, answers: options.updatedInput.answers })
    } },
    onUserMessage: async (text: string) => { agentInputs.push(text) },
  } as unknown as Session
  const add = (id: string, questionTexts: string[], requestId: string | null = `permission_${id}`) => {
    s.pendingAsks.set(id, {
      i: s.pendingAsks.size,
      questions: questionTexts.map(question => ({ question, options: [{ label: 'A' }, { label: 'B' }] })),
      answers: {}, answered: new Map(), currentIdx: 0,
      ...(requestId ? { requestId } : {}),
    })
    if (requestId) s.pendingPermissions.set(requestId, { toolUseId: id })
  }
  const panel = (id: string) => {
    const ask = s.pendingAsks.get(id)!
    return cards.askUserQuestionElement(ask.i, id, ask.questions, '🤔', sessionAsk.askRenderState(s, id)) as any
  }
  const route = async (message: NotifyReplyMessage) => {
    const consumed = await consumePendingTextInput({
      reply: () => h.runtime.consume(message),
      hasQuestion: () => sessionAsk.hasPendingAsk(s),
      answerQuestion: () => sessionAsk.onAskMessageAnswer(s, message.text, message.openId, message.messageId),
    })
    if (!consumed) await s.onUserMessage(message.text, [], message.openId, message.messageId)
  }
  h.controls.waitingChanged = () => sessionAsk.refreshPendingAsks(s)
  return { s, add, panel, route, permissionReplies, agentInputs }
}

describe('notification text reply workflow', () => {
  test('HTTP send → fixed reply button → waiting card → user text → callback receipt → GET result', async () => {
    const h = harness()
    const res = await h.request({ project: 'ops', text: '填写时间', images: ['/abs/schedule.png'], allow_reply: true, callback: 'http://localhost:9999/hook' })
    expect(res.status).toBe(200)
    const { notify_id, message_id } = JSON.parse(res.raw)
    expect(notify_id).toStartWith('nf_')
    const bottom = h.sent[0].card.body.elements.at(-1)
    expect(bottom.columns[0].elements[0].text.content).toBe('回复')
    expect(bottom.columns[0].elements[0].behaviors[0].value).toEqual({ kind: 'notify_reply', notify_id })
    expect((await h.open(notify_id)).ok).toBe(true)
    const prompt = h.sent[1]
    expect(prompt.card.header.title.content).toBe('等待用户输入')
    expect(JSON.stringify(prompt.card)).toContain('ou_owner')
    expect(h.delivered).toHaveLength(0)
    const text = '明天 **十点**\n<at id=all>所有人</at>'
    expect(await h.runtime.consume(incoming({ text }))).toBe(true)
    expect(h.delivered).toEqual([{
      notifyId: notify_id, openId: 'ou_owner',
      response: { text, message_id: 'om_input', prompt_message_id: prompt.messageId },
    }])
    expect(h.updated[0].messageId).toBe(prompt.messageId)
    expect(h.updated[0].card.header.title.content).toBe('正在发送回复')
    expect(h.updated[1].messageId).toBe(prompt.messageId)
    expect(h.updated[1].card.header.title.content).toBe('回复已送达')
    expect(JSON.stringify(h.updated[1].card)).toContain('已安排部署')
    expect(JSON.stringify(h.updated[1].card)).not.toContain('<at id=all>')
    expect(h.updated[2].messageId).toBe(message_id)
    expect(h.updated[2].card.body.elements).toContainEqual({ tag: 'img', img_key: 'img_test', alt: { tag: 'plain_text', content: 'screenshot' } })
    expect(h.uploads).toEqual(['/abs/schedule.png'])
    expect(JSON.stringify(h.updated[2].card)).not.toContain('notify_reply"')
    const result = JSON.parse((await h.request(undefined, `/notify/result/${notify_id}`)).raw)
    expect(result.resolved).toBe(true)
    expect(result.response).toEqual({ type: 'text', ...h.delivered[0].response })
    expect(result.button).toBeUndefined()
    expect(result.resolved_by).toBe('ou_owner')
    expect(result.reply.status).toBe('resolved')
  })

  test('HTTP validates allow_reply and keeps ordinary notifications noninteractive', async () => {
    const h = harness()
    for (const allow_reply of ['true', 1, null, {}]) {
      expect((await h.request({ project: 'ops', text: 'text', allow_reply })).status).toBe(400)
    }
    expect(h.sent).toHaveLength(0)
    const plain = await h.request({ project: 'ops', text: 'text', allow_reply: false })
    expect(JSON.parse(plain.raw).notify_id).toBeUndefined()
    expect(JSON.stringify(h.sent[0].card)).not.toContain('notify_reply')
  })

  test('all three HTTP card types retain image and markdown content with distinct controls', async () => {
    const h = harness()
    const cases = [
      { fields: {}, labels: [], interactive: false },
      { fields: { buttons: [{ id: 'approve', text: '通过' }] }, labels: ['通过'], interactive: true },
      { fields: { allow_reply: true }, labels: ['回复'], interactive: true },
    ]
    for (const entry of cases) {
      const result = await h.request({ project: 'ops', text: '**图文通知**', images: ['/abs/report.png'], ...entry.fields })
      expect(result.status).toBe(200)
      expect(!!JSON.parse(result.raw).notify_id).toBe(entry.interactive)
      const card = h.sent.at(-1)!.card
      const elements = card.body.elements as any[]
      expect(elements).toContainEqual({ tag: 'img', img_key: 'img_test', alt: { tag: 'plain_text', content: 'screenshot' } })
      expect(elements).toContainEqual({ tag: 'markdown', content: '**图文通知**' })
      const buttons = elements.filter(el => el.tag === 'column_set')
        .flatMap(el => el.columns.flatMap((column: any) => column.elements))
        .filter(el => el.tag === 'button')
      expect(buttons.map(button => button.text.content)).toEqual(entry.labels)
    }
    expect(h.uploads).toEqual(['/abs/report.png', '/abs/report.png', '/abs/report.png'])
  })

  test('HTTP rejects combining choice buttons and custom replies before uploading or sending', async () => {
    const h = harness()
    const result = await h.request({
      project: 'ops', text: '混合模式', images: ['/abs/report.png'], allow_reply: true,
      buttons: [{ id: 'yes', text: '可以' }],
    })
    expect(result.status).toBe(400)
    expect(result.raw).toContain('mutually exclusive')
    expect(h.uploads).toHaveLength(0)
    expect(h.sent).toHaveLength(0)
  })

  test('pull mode records text without invoking a callback', async () => {
    register(registration({ callbackUrl: '' }))
    const h = harness()
    await h.open()
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect(h.delivered).toHaveLength(0)
    expect(h.updated[1].card.header.title.content).toBe('回复已记录')
    expect(get('nf_reply')!.resolvedAt).toBeDefined()
    expect(buildNotifyResult(get('nf_reply')!)).toMatchObject({ resolved: true, response: { type: 'text', text: '明天十点' } })
  })

  test('only the clicker in this chat is captured; no pending prompt means normal routing', async () => {
    register(registration())
    const h = harness()
    expect(await h.runtime.consume(incoming())).toBe(false)
    await h.open()
    expect(await h.runtime.consume(incoming({ openId: 'ou_other' }))).toBe(false)
    expect(await h.runtime.consume(incoming({ chatId: 'oc_other' }))).toBe(false)
    expect(await h.runtime.consume(incoming({ text: '   ' }))).toBe(false)
    expect(await h.runtime.consume(incoming({ messageId: '' }))).toBe(false)
    expect(h.delivered).toHaveLength(0)
    expect(await h.runtime.consume(incoming())).toBe(true)
  })

  test('messages older than the prompt are not captured, while quoted messages still follow reply priority', async () => {
    register(registration())
    const h = harness()
    await h.open()
    const state = get('nf_reply')!.replyState!
    expect(await h.runtime.consume(incoming({ createTime: state.openedAt - 1 }))).toBe(false)
    expect(await h.runtime.consume(incoming({ parentId: 'om_agent_question' }))).toBe(true)
    expect(h.delivered[0].notifyId).toBe('nf_reply')
  })

  test('the latest reply replaces the old one for the entire chat, including another clicker', async () => {
    register(registration())
    register(registration({ notifyId: 'nf_other' }))
    const h = harness()
    const [one, duplicate] = await Promise.all([h.open(), h.open()])
    expect(one.ok).toBe(true)
    expect(duplicate.ok).toBe(false)
    expect((await h.open()).ok).toBe(false)
    expect((await h.open('nf_reply', 'ou_other')).ok).toBe(false)
    expect((await h.open('nf_other', 'ou_other')).ok).toBe(true)
    expect(h.sent).toHaveLength(2)
    expect(get('nf_reply')?.replyState?.status).toBe('cancelled')
    expect(get('nf_reply')!.replyState!.cancelReason).toBe('switched')
    expect(JSON.stringify(h.updated[0].card)).toContain('本次回复已放弃')
    expect(pendingRepliesForChat('oc_group').map(reg => reg.notifyId)).toEqual(['nf_other'])
    expect(findPendingReply('oc_group', 'ou_owner')).toBeUndefined()
    expect(await h.runtime.consume(incoming())).toBe(false)
    expect(await h.runtime.consume(incoming({ openId: 'ou_other' }))).toBe(true)
    expect(h.delivered[0].notifyId).toBe('nf_other')
    expect(h.delivered).toHaveLength(1)
  })

  test('switch failure leaves the old reply abandoned and never silently restores it', async () => {
    register(registration())
    register(registration({ notifyId: 'nf_other' }))
    const h = harness()
    await h.open()
    const old = get('nf_reply')!.replyState!
    h.controls.send = async () => false
    expect((await h.open('nf_other')).ok).toBe(false)
    expect(buildNotifyResult(get('nf_reply')!)).toMatchObject({
      resolved: false, reply: { status: 'cancelled', cancel_reason: 'switched' },
    })
    expect(pendingRepliesForChat('oc_group')).toHaveLength(0)
    expect(h.delivered).toHaveLength(0)
    expect((await h.runtime.cancel('nf_reply', old.id, 'oc_group', 'ou_owner')).ok).toBe(false)
  })

  test('a question arriving during a reply waits; successive texts go to reply, question, then Agent exactly once', async () => {
    register(registration())
    const h = harness()
    const q = questionsFor(h)
    await h.open()
    q.add('ask', ['选择部署区域'])
    expect(q.panel('ask').header.title.content).toBe('⏳ 等待通知回复完成')
    expect(JSON.stringify(q.panel('ask'))).not.toContain('interactive_container')
    expect(await sessionAsk.onAskAnswer(q.s, 'ask', 0, 0, 'ou_owner')).toBe(false)

    await q.route(incoming({ text: '通知的回复' }))
    expect(h.delivered[0].response.text).toBe('通知的回复')
    expect(q.permissionReplies).toHaveLength(0)
    expect(q.s.pendingAsks.get('ask')!.answers).toEqual({})
    expect(JSON.stringify(q.panel('ask'))).toContain('interactive_container')

    await q.route(incoming({ messageId: 'om_question_answer', text: '上海' }))
    expect(q.permissionReplies).toEqual([{ id: 'permission_ask', answers: { '选择部署区域': '上海' } }])
    expect(addedReactions).toEqual([['om_question_answer', 'CheckMark']])
    expect(q.agentInputs).toHaveLength(0)
    await q.route(incoming({ messageId: 'om_agent_input', text: '继续执行' }))
    expect(q.agentInputs).toEqual(['继续执行'])
    expect(h.delivered).toHaveLength(1)
  })

  test('switching reply targets keeps a queued question intact and never submits the abandoned reply', async () => {
    register(registration())
    register(registration({ notifyId: 'nf_other' }))
    const h = harness()
    const q = questionsFor(h)
    q.add('ask', ['部署哪一个服务'])
    await h.open()
    const previous = get('nf_reply')!.replyState!
    await h.open('nf_other')
    expect((await h.runtime.cancel('nf_reply', previous.id, 'oc_group', 'ou_owner')).ok).toBe(false)
    expect(q.panel('ask').header.title.content).toBe('⏳ 等待通知回复完成')
    await q.route(incoming({ text: '只回复最新通知', parentId: previous.promptMessageId }))
    expect(h.delivered.map(result => result.notifyId)).toEqual(['nf_other'])
    expect(q.permissionReplies).toHaveLength(0)
    await q.route(incoming({ messageId: 'om_ask', text: 'API 服务' }))
    expect(q.permissionReplies[0].answers).toEqual({ '部署哪一个服务': 'API 服务' })
  })

  test('cancelling notification input resumes the pending question immediately', async () => {
    register(registration())
    const h = harness()
    const q = questionsFor(h)
    q.add('ask', ['继续吗'])
    await h.open()
    expect(sessionAsk.askBlockReason(q.s, 'ask')).toContain('通知回复')
    await h.runtime.cancel('nf_reply', get('nf_reply')!.replyState!.id, 'oc_group', 'ou_owner')
    expect(sessionAsk.askBlockReason(q.s, 'ask')).toBeNull()
    await q.route(incoming({ text: '继续' }))
    expect(q.permissionReplies[0].answers).toEqual({ '继续吗': '继续' })
    expect(h.delivered).toHaveLength(0)
  })

  test('only one question is answerable, including multiple questions within one tool call', async () => {
    const h = harness()
    const q = questionsFor(h)
    q.add('first', ['第一题', '第二题'])
    q.add('second', ['第三题'])
    expect(q.panel('second').header.title.content).toBe('⏳ 提问排队中')
    expect(await sessionAsk.onAskAnswer(q.s, 'second', 0, 0, 'ou_owner')).toBe(false)
    await q.route(incoming({ messageId: 'om_q1', text: '答一' }))
    expect(q.s.pendingAsks.get('first')!.currentIdx).toBe(1)
    expect(sessionAsk.askBlockReason(q.s, 'second')).toContain('当前问题')
    await q.route(incoming({ messageId: 'om_q2', text: '答二' }))
    expect(sessionAsk.askBlockReason(q.s, 'second')).toBeNull()
    expect(JSON.stringify(q.panel('second'))).toContain('interactive_container')
    await q.route(incoming({ messageId: 'om_q3', text: '答三' }))
    expect(q.permissionReplies).toEqual([
      { id: 'permission_first', answers: { '第一题': '答一', '第二题': '答二' } },
      { id: 'permission_second', answers: { '第三题': '答三' } },
    ])
    expect(sessionAsk.hasPendingAsk(q.s)).toBe(false)
  })

  test('an answered question waiting for its backend handshake does not capture later input', async () => {
    const h = harness()
    const q = questionsFor(h)
    q.add('first', ['先回答'], null)
    q.add('second', ['再回答'])
    await q.route(incoming({ messageId: 'om_first', text: '第一份答案' }))
    expect(q.s.pendingAsks.has('first')).toBe(true)
    expect(sessionAsk.askBlockReason(q.s, 'second')).toBeNull()
    await q.route(incoming({ messageId: 'om_second', text: '第二份答案' }))
    expect(sessionAsk.hasPendingAsk(q.s)).toBe(false)
    await q.route(incoming({ messageId: 'om_next', text: '下一条指令' }))
    expect(q.agentInputs).toEqual(['下一条指令'])
    q.s.pendingAsks.get('first')!.requestId = 'late_permission'
    sessionAsk.finalizeAsk(q.s, 'first')
    expect(q.permissionReplies.at(-1)).toEqual({ id: 'late_permission', answers: { '先回答': '第一份答案' } })
  })

  test('owner can cancel and reopen; old cancel actions cannot close the new prompt', async () => {
    register(registration())
    const h = harness()
    await h.open()
    const previous = get('nf_reply')!.replyState!
    expect((await h.runtime.cancel('nf_reply', previous.id, 'oc_group', 'ou_other')).ok).toBe(false)
    expect((await h.runtime.cancel('nf_reply', previous.id, 'oc_group', 'ou_owner')).ok).toBe(true)
    expect(h.updated.at(-1)!.card.header.title.content).toBe('已取消回复')
    expect(await h.runtime.consume(incoming())).toBe(false)
    expect((await h.open()).ok).toBe(true)
    expect((await h.runtime.cancel('nf_reply', previous.id, 'oc_group', 'ou_owner')).ok).toBe(false)
    expect(findPendingReply('oc_group', 'ou_owner')?.replyState?.id).not.toBe(previous.id)
  })

  test('waiting input survives reload; a completed input remains deduplicated after reload', async () => {
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

  test('send failure returns the fixed retry message and does not reserve input', async () => {
    register(registration())
    const h = harness()
    h.controls.send = async () => false
    // 定型实现无 onFailure 通道:sendCard 返回 null 即固定文案(诊断留给日志/调用方)。
    expect(await h.open()).toEqual({
      ok: false, message: '等待输入卡片发送失败，未开始接收回复，请重新点击「回复」',
    })
    expect(findPendingReply('oc_group', 'ou_owner')).toBeUndefined()
    expect(pendingRepliesForChat('oc_group')).toHaveLength(0)
    expect(await h.runtime.consume(incoming())).toBe(false)
    expect(h.delivered).toHaveLength(0)
  })

  test('failure to persist a new prompt marks its visible card as failed without capturing input', async () => {
    register(registration())
    const h = harness()
    __setStoreFileForTest(join(file, 'bad.json'), false)
    const result = await h.open()
    expect(result.ok).toBe(false)
    expect(result.presented).toBe(true)
    expect(result.message).toContain('等待输入状态保存失败，未开始接收回复')
    expect(h.updated[0].card.header.title.content).toBe('回复发送失败')
    expect(findPendingReply('oc_group', 'ou_owner')).toBeUndefined()
    expect(pendingRepliesForChat('oc_group')).toHaveLength(0)
    expect(await h.runtime.consume(incoming())).toBe(false)
    expect(h.delivered).toHaveLength(0)
  })

  test('input persistence failure is visible and never dispatches', async () => {
    register(registration())
    const h = harness()
    await h.open()
    __setStoreFileForTest(join(file, 'bad.json'), false)
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect(h.notices[0]).toContain('保存失败，尚未回传')
    expect(h.notices.some(text => text.includes('回复保存失败，尚未回传'))).toBe(true)
    expect(get('nf_reply')!.replyState!.status).toBe('waiting')
    expect(h.delivered).toHaveLength(0)
  })

  test('callback failure is visible, releases input and requires an explicit new reply attempt', async () => {
    register(registration())
    const h = harness()
    await h.open()
    h.controls.dispatch = async () => ({ ok: false, detail: 'HTTP 503 unavailable' })
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect(h.updated[1].card.header.title.content).toBe('回复发送失败')
    expect(JSON.stringify(h.updated[1].card)).toContain('HTTP 503 unavailable')
    expect(findPendingReply('oc_group', 'ou_owner')).toBeUndefined()
    expect(buildNotifyResult(get('nf_reply')!)).toMatchObject({ resolved: false, reply: { status: 'failed', error: 'HTTP 503 unavailable' } })
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect(h.delivered).toHaveLength(1)
    expect((await h.open()).ok).toBe(true)
    // Reopening must not forget the prior input's durable dedupe identity.
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect(h.delivered).toHaveLength(1)
    h.controls.dispatch = async () => ({ ok: true, detail: '200' })
    expect(await h.runtime.consume(incoming({ messageId: 'om_second' }))).toBe(true)
    expect(h.delivered).toHaveLength(2)
    expect(get('nf_reply')!.resolvedAt).toBeDefined()
  })

  test('failure to update the input receipt before POST does not dispatch', async () => {
    register(registration())
    const h = harness()
    await h.open()
    h.controls.update = async () => { throw new Error('Feishu unavailable') }
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect(h.delivered).toHaveLength(0)
    expect(h.notices.join('\n')).toContain('Feishu unavailable')
    expect(get('nf_reply')!.replyState!.status).toBe('failed')
  })

  test('receipt failure preserves raw API diagnostics in both state and existing error notices', async () => {
    register(registration())
    const h = harness()
    await h.open()
    // 生产 feishu.ts 会把 SDK 错误包成 Error(message 含格式化诊断);定型实现经
    // detailOf(Error.message) 取诊断,这里用同形态 Error 复刻生产链路。
    const diagnostic = 'code=300121 message=Failed to replace element log_id=receipt-log'
    h.controls.update = async () => { throw new Error(diagnostic) }
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect(h.delivered).toHaveLength(0)
    expect(get('nf_reply')!.replyState!.error).toBe(diagnostic)
    expect(h.notices.every(text => text.includes(diagnostic))).toBe(true)
  })

  test('presentation failure after callback success stays resolved, reports error and never resends', async () => {
    register(registration())
    const h = harness()
    await h.open()
    h.controls.dispatch = async () => {
      h.controls.update = async () => { throw new Error('patch rejected') }
      return { ok: true, detail: '200' }
    }
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect(get('nf_reply')!.resolvedAt).toBeDefined()
    expect(h.notices.join('\n')).toContain('回复已送达，卡片更新失败')
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect((await h.open()).ok).toBe(false)
    expect(h.delivered).toHaveLength(1)
  })

  test('successful callback with persistence failure is unknown and stays nonretryable after reload', async () => {
    register(registration())
    const h = harness()
    await h.open()
    h.controls.dispatch = async () => {
      __setStoreFileForTest(join(file, 'bad.json'), false)
      return { ok: true, detail: '200' }
    }
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect(get('nf_reply')!.unknownAt).toBeDefined()
    expect(h.updated[1].card.header.title.content).toBe('回复送达状态未知')
    expect((await h.open()).ok).toBe(false)
    __setStoreFileForTest(file)
    const interrupted = loadCallbacks()
    expect(interrupted).toHaveLength(1)
    await h.runtime.recover(interrupted[0])
    expect(h.updated.at(-2)!.card.header.title.content).toBe('回复送达状态未知')
    expect(buildNotifyResult(get('nf_reply')!)).toMatchObject({ resolved: false, unknown: true, response: { text: '明天十点' } })
    expect((await h.open()).ok).toBe(false)
    expect(h.delivered).toHaveLength(1)
  })

  test('recovery freezes an interrupted button callback without claiming delivery or dispatching again', async () => {
    register(registration({ allowReply: false, buttons: [{ id: 'approve', text: '通过', type: 'primary' }] }))
    beginCallbackDispatch('nf_reply', 'approve', 'ou_owner')
    __setStoreFileForTest(file)
    const interrupted = loadCallbacks()
    const h = harness()
    await h.runtime.recover(interrupted[0])
    expect(h.updated).toHaveLength(1)
    expect(h.updated[0].messageId).toBe('om_notification')
    const card = JSON.stringify(h.updated[0].card)
    // 定型实现:按钮回调 unknown 用专属文案(外部回调已成功 ≠ 本地确认);
    // "送达状态未知,禁止自动重试"留给文字回复未知(notify.ts marker 分支)。
    expect(card).toContain('外部回调已成功，但本地确认状态未知，禁止自动重试')
    expect(card).not.toContain('✅')
    expect(card).not.toContain('已送达')
    expect(card).not.toContain('notify_callback')
    expect(h.delivered).toEqual([])
  })

  test('unsupported, wrong-chat and anonymous reply actions do not send waiting cards', async () => {
    register(registration({ allowReply: false }))
    const h = harness()
    expect(await h.open()).toEqual({ ok: false, message: '此通知未开启文字回复' })
    register(registration())
    expect(await h.open('nf_reply', 'ou_owner', 'oc_wrong')).toEqual({ ok: false, message: '通知不属于当前群，操作未执行' })
    expect(await h.open('nf_reply', '')).toEqual({ ok: false, message: '无法识别回复人，操作未执行' })
    expect(await h.open('missing')).toEqual({ ok: false, message: '通知已过期或已移除' })
    expect(h.sent).toHaveLength(0)
  })

  test('shared actor keeps an incoming answer behind prompt creation', async () => {
    register(registration())
    const h = harness()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    h.controls.send = async () => { await gate; return true }
    const actor = new PerKeyActor()
    const prompt = actor.enqueue('oc_group', () => h.open())
    const answer = actor.enqueue('oc_group', () => h.runtime.consume(incoming()))
    expect(h.delivered).toHaveLength(0)
    release()
    expect((await prompt).ok).toBe(true)
    expect(await answer).toBe(true)
    expect(h.delivered).toHaveLength(1)
  })
})

describe('notification reply local guards (本地定型语义)', () => {
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
    expect(h.bodyOf(2)).toContain('反馈已送达')
    expect(h.bodyOf(2)).not.toContain('notify_reply"')
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
    expect(h.titleOf(1)).toBe('回复发送失败')
    expect(h.bodyOf(1)).toContain('loopback 回调连接被拒')
    expect(h.bodyOf(2)).toContain('回调失败')
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
    expect(h.titleOf(1)).toBe('回复送达状态未知')
    expect(h.bodyOf(2)).toContain('送达状态未知，禁止自动重试')
    expect(h.logs.some(line => line.includes('notify.reply.unknown'))).toBe(true)
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
    expect(h.bodyOf(before + 1)).toContain('送达状态未知，禁止自动重试')
    expect(h.delivered).toHaveLength(1)
  })

  test('the newest reply replaces the previous one for the whole chat and abandons its input', async () => {
    register(registration())
    register(registration({ notifyId: 'nf_other' }))
    const h = harness()
    expect((await h.open()).ok).toBe(true)
    expect(await h.open()).toEqual({ ok: false, message: '此通知正在等待回复，请先在群里输入或由回复人取消' })
    // 另一条通知的「回复」放弃上一条(switched),同一个群里不并存两个等待态。
    expect((await h.open('nf_other', 'ou_other')).ok).toBe(true)
    expect(get('nf_reply')!.replyState!.status).toBe('cancelled')
    expect(get('nf_reply')!.replyState!.cancelReason).toBe('switched')
    expect(h.bodyOf(0)).toContain('本次回复已放弃')
    expect(pendingRepliesForChat('oc_group').map(reg => reg.notifyId)).toEqual(['nf_other'])
    // 被放弃的输入永远不被提交,也不再被捕获。
    expect(await h.runtime.consume(incoming())).toBe(false)
    expect(await h.runtime.consume(incoming({ openId: 'ou_other' }))).toBe(true)
    expect(h.delivered.map(entry => entry.notifyId)).toEqual(['nf_other'])
  })

  test('switching is refused while the previous reply is mid-dispatch', async () => {
    register(registration())
    register(registration({ notifyId: 'nf_other' }))
    const h = harness()
    await h.open()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    h.controls.dispatch = async () => { await gate; return { ok: true, detail: '200' } }
    const inFlight = h.runtime.consume(incoming())
    // consume 在首个 await 之前已把 sending 落盘并置 dispatching。
    expect(get('nf_reply')!.replyState!.status).toBe('sending')
    expect(await h.open('nf_other')).toEqual({ ok: false, message: '上一条通知回复正在发送，请稍后切换' })
    expect(h.sent).toHaveLength(1)
    release()
    expect(await inFlight).toBe(true)
    expect(h.delivered).toHaveLength(1)
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

  // ── 02-REVIEW WR-01:错误通道不得抛出,切换取消逐条 best-effort ──────────────
  test('错误提示本身发送失败时不再抛出:失败仍被消费,只留日志(WR-01)', async () => {
    register(registration())
    const h = harness()
    await h.open()
    __setStoreFileForTest(join(file, 'bad.json'), false)
    h.controls.sendText = async () => false
    // 修复前 report() 抛错会穿出 consume(),daemon 侧后续处理(host_ask / 缓冲 /
    // onUserMessage)整段被跳过 —— 这里锁定"提示发不出去"不等于"消费失败"。
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect(h.logs.some(text => text.includes('notify.reply.error_notice_failed'))).toBe(true)
    expect(get('nf_reply')!.replyState!.status).toBe('waiting')
    expect(h.delivered).toHaveLength(0)
  })

  test('切换时单条取消失败不中断循环:其余通知照常处理,新等待卡照发(WR-01)', async () => {
    register(registration())
    register(registration({ notifyId: 'nf_other' }))
    register(registration({ notifyId: 'nf_second' }))
    const h = harness()
    await h.open()
    // 同群两条等待态正是"半取消"缺陷留下的形态;落盘失败复刻单条取消失败。
    setReplyState('nf_other', {
      id: 'reply_other', openId: 'ou_owner', promptMessageId: 'om_other',
      openedAt: Date.now(), status: 'waiting',
    })
    __setStoreFileForTest(join(file, 'bad.json'), false)
    const result = await h.open('nf_second')
    // 取消两条都失败(各自日志一次,证明循环没在第一条就中断),新等待卡仍然发出。
    expect(h.logs.filter(text => text.includes('notify.reply.cancel_failed'))).toHaveLength(2)
    expect(h.logs.every(text => !text.includes('nf_reply') && !text.includes('nf_other'))).toBe(true)
    expect(h.sent).toHaveLength(2)
    // 取消失败的通知保留等待态(内存回滚),不会静默变成半取消。
    expect(get('nf_reply')!.replyState!.status).toBe('waiting')
    expect(get('nf_other')!.replyState!.status).toBe('waiting')
    expect(result).toEqual({
      ok: false, presented: true,
      message: expect.stringContaining('等待输入状态保存失败，未开始接收回复'),
    })
  })

  test('卡片更新失败且错误提示也发不出去时,open 仍完成切换(WR-01)', async () => {
    register(registration())
    register(registration({ notifyId: 'nf_other' }))
    const h = harness()
    await h.open()
    h.controls.update = async () => { throw new Error('card update failed') }
    h.controls.sendText = async () => false
    expect(await h.open('nf_other')).toEqual({
      ok: true, message: '等待输入卡片已发送，请在群里回复一条文字', presented: true,
    })
    expect(h.sent).toHaveLength(2)
    expect(h.logs.some(text => text.includes('notify.reply.error_notice_failed'))).toBe(true)
  })
})
