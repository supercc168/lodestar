import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resetFeishuMock, sentTexts, urgentPushes } from './feishu-test-mock'
import * as cardkit from './cardkit'
import * as feishu from './feishu'
import { ELEMENTS } from './cards'
import { addTool } from './session-tools'
import { renderPermission } from './session-permission'
import { askBlockReason, askRenderState, onAskAnswer, onAskMessageAnswer, refreshPendingAsks } from './session-ask'
import { __setPendingReplyForTest, __setStoreFileForTest, get, register, setReplyState } from './notify-callbacks'
import type { Session } from './session'

let dir: string
let panels: Map<string, any>
let restore: Array<() => void>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lodestar-ask-priority-'))
  __setStoreFileForTest(join(dir, 'callbacks.json'))
  resetFeishuMock()
  panels = new Map()
  const add = spyOn(cardkit, 'addElement').mockImplementation(async (_id: string, element: any) => {
    panels.set(element.element_id, element)
  })
  const replace = spyOn(cardkit, 'replaceElement').mockImplementation(async (_id: string, elementId: string, element: any) => {
    panels.set(elementId, element)
  })
  const settings = spyOn(cardkit, 'patchSettings').mockResolvedValue(undefined)
  const summary = spyOn(cardkit, 'cancelSummary').mockImplementation(() => {})
  __setPendingReplyForTest('oc_ask', false)
  restore = [() => add.mockRestore(), () => replace.mockRestore(), () => settings.mockRestore(), () => summary.mockRestore()]
})
afterEach(async () => {
  await new Promise<void>(resolve => setImmediate(resolve))
  __setPendingReplyForTest('oc_ask', false)
  for (const undo of restore.reverse()) undo()
  __setStoreFileForTest(join(dir, 'callbacks.json'))
  rmSync(dir, { recursive: true, force: true })
})

function harness(provider: 'codex' | 'claude' | 'dsh' = 'codex') {
  const answers: Array<{ requestId: string; decision: string; options: any }> = []
  const userMessages: Array<{ text: string; user: string; msgId: string }> = []
  const s = {
    chatId: 'oc_ask', sessionName: 'ask-priority', status: 'working',
    pendingAsks: new Map(), pendingPermissions: new Map(),
    currentTurn: {
      cardId: 'card_ask', messageId: 'om_turn', userOpenId: 'ou_owner', provider,
      toolCount: 0, toolByUseId: new Map(), toolBatches: new Map(), openBatchI: null,
    },
    observeWatchdogToolStart: () => {},
    maybeMidTurnRotate: () => {},
    startWorkingFooter: () => {},
    finalizeCurrentAssistantSegment: () => {},
    proc: {
      provider,
      sendPermissionResponse: (requestId: string, decision: string, options: any) => {
        answers.push({ requestId, decision, options })
      },
    },
    onUserMessage: async (text: string, _files: any[], user: string, msgId: string) => {
      userMessages.push({ text, user, msgId })
    },
  } as unknown as Session
  const add = (id: string, text: string) => {
    const input = { questions: [{ question: text, options: [{ label: 'A' }, { label: 'B' }] }] }
    addTool(s, {} as any, id, 'AskUserQuestion', input)
    renderPermission(s, { request_id: `permission_${id}`, tool_use_id: id, tool_name: 'AskUserQuestion', input })
  }
  return { s, answers, userMessages, add }
}

function startReply() {
  register({
    notifyId: 'nf_ask_priority', callbackUrl: '', chatId: 'oc_ask', messageId: 'om_notify',
    project: 'ops', title: '回复', text: '请输入', level: 'info', imageKeys: [], buttons: [], allowReply: true,
    createdAt: Date.now(), replyState: {
      id: 'reply', openId: 'ou_owner', promptMessageId: 'om_prompt', openedAt: Date.now(), status: 'waiting',
    },
  })
}

function endReply() {
  setReplyState('nf_ask_priority', { ...get('nf_ask_priority')!.replyState!, status: 'cancelled' })
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve))
const flushAnnouncements = flush

describe('AskUserQuestion 输入优先级(ae411a6 拆摘)', () => {
  test('排队中的提问不可作答,队首答完后恢复可交互', async () => {
    const h = harness()
    h.add('first', '先选择区域')
    h.add('second', '再选择环境')
    await flush()
    expect(panels.get(ELEMENTS.tool(1)).header.title.content).toBe('⏳ 提问排队中')
    expect(await onAskAnswer(h.s, 'second', 0, 1, 'ou_owner')).toBe(false)
    expect(h.answers).toHaveLength(0)
    expect(await onAskAnswer(h.s, 'first', 0, 0, 'ou_owner')).toBe(true)
    await flush()
    expect(panels.get(ELEMENTS.tool(0)).header.title.content).toBe('✅ 已回答 · 1/1')
    expect(JSON.stringify(panels.get(ELEMENTS.tool(1)))).toContain('interactive_container')
    expect(h.answers[0]).toMatchObject({ requestId: 'permission_first', decision: 'allow' })
  })

  test('askRenderState/askBlockReason 区分队首与排队,排队面板收起', async () => {
    const h = harness()
    h.add('first', '先选择区域')
    h.add('second', '再选择环境')
    await flush()
    expect(askRenderState(h.s, 'first').waitingFor).toBeUndefined()
    expect(askRenderState(h.s, 'second').waitingFor).toBe('question')
    expect(askBlockReason(h.s, 'first')).toBeNull()
    expect(askBlockReason(h.s, 'second')).toContain('请先回答当前问题')
    const panel = panels.get(ELEMENTS.tool(1)) as any
    expect(panel.expanded).toBe(false)
    expect(JSON.stringify(panel)).not.toContain('interactive_container')
  })

  test('通知回复进行中,文本落到提问上回明确提示且不记账', async () => {
    const h = harness()
    h.add('first', '继续吗')
    __setPendingReplyForTest('oc_ask', true)
    await onAskMessageAnswer(h.s, 'hello', 'ou_owner', 'om_x')
    expect(sentTexts).toContain('请先完成或取消通知回复，再回答 Agent 的提问。这条文字未提交，请稍后重新发送。')
    const pending = [...h.s.pendingAsks.values()][0] as any
    expect(pending.answers).toEqual({})
    expect(pending.answered.size).toBe(0)
  })

  test('requestId 缺失的僵尸 ask 被丢弃并把消息当普通 user message 重处理', async () => {
    const h = harness()
    h.s.pendingAsks.set('zombie', {
      questions: [{ question: 'q', options: [] }], i: 0,
      answers: {}, answered: new Map(), currentIdx: undefined,
    })
    await onAskMessageAnswer(h.s, 'hello', 'ou_owner', 'om_z')
    expect(h.s.pendingAsks.has('zombie')).toBe(false)
    expect(h.userMessages).toHaveLength(1)
    expect(h.userMessages[0].text).toBe('hello')
  })

  test('requestId 已 park 的瞬态 ask 被忽略(不删不重处理)', async () => {
    const h = harness()
    h.s.pendingAsks.set('parked', {
      questions: [{ question: 'q', options: [] }], i: 0, requestId: 'req_1',
      answers: {}, answered: new Map(), currentIdx: undefined,
    })
    await onAskMessageAnswer(h.s, 'hello', 'ou_owner', 'om_z')
    expect(h.s.pendingAsks.has('parked')).toBe(true)
    expect(h.userMessages).toHaveLength(0)
  })

  test('队首已答完未 finalize、后方有活提问时,文本落活提问而非误判僵尸(WR-01)', async () => {
    const h = harness()
    // 先加 first,不走 renderPermission —— 模拟快点击窗口:can_use_tool 还没来
    const input1 = { questions: [{ question: '先选择区域', options: [{ label: 'A' }, { label: 'B' }] }] }
    addTool(h.s, {} as any, 'first', 'AskUserQuestion', input1)
    await flush()
    expect(await onAskAnswer(h.s, 'first', 0, 0, 'ou_owner')).toBe(true)
    // 后方再来一条活提问
    const input2 = { questions: [{ question: '再选择环境', options: [{ label: 'A' }, { label: 'B' }] }] }
    addTool(h.s, {} as any, 'second', 'AskUserQuestion', input2)
    await flush()
    // 文本应落到 second,而不是把队首当僵尸删掉重处理
    await onAskMessageAnswer(h.s, 'hello', 'ou_owner', 'om_x')
    expect(h.s.pendingAsks.has('first')).toBe(true)
    expect(h.userMessages).toHaveLength(0)
    const second = h.s.pendingAsks.get('second') as any
    expect(second.answers['再选择环境']).toBe('hello')
  })

  test('通知回复进行中提问整体等待且不推送(先置回复中、再加提问)', async () => {
    const h = harness()
    __setPendingReplyForTest('oc_ask', true)
    h.add('first', '继续吗')
    await flush()
    refreshPendingAsks(h.s)
    await flush()
    expect(panels.get(ELEMENTS.tool(0)).header.title.content).toBe('⏳ 等待通知回复完成')
    expect(JSON.stringify([...panels.values()])).not.toContain('interactive_container')
    expect(urgentPushes).toHaveLength(0)
  })

  test('回复结束后恢复可交互并恰好推送一次', async () => {
    const h = harness()
    __setPendingReplyForTest('oc_ask', true)
    h.add('first', '继续吗')
    await flush()
    __setPendingReplyForTest('oc_ask', false)
    refreshPendingAsks(h.s)
    await flush()
    expect(JSON.stringify(panels.get(ELEMENTS.tool(0)))).toContain('interactive_container')
    expect(urgentPushes).toHaveLength(1)
  })

  test('延迟推送不越过回复、不重复推(announcementVersion 作废在途)', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    spyOn(cardkit, 'patchSettings').mockImplementation(async () => { await gate })
    const h = harness()
    h.add('first', '继续吗')
    __setPendingReplyForTest('oc_ask', true)
    refreshPendingAsks(h.s)
    __setPendingReplyForTest('oc_ask', false)
    refreshPendingAsks(h.s)
    release()
    await flush()
    expect(urgentPushes).toHaveLength(1)
  })

  test('每题只在成为可答时推送一次,重复刷新不重复推', async () => {
    const h = harness()
    h.add('first', '先选择区域')
    h.add('second', '再选择环境')
    await flush()
    expect(urgentPushes).toHaveLength(1)
    refreshPendingAsks(h.s)
    await flush()
    expect(urgentPushes).toHaveLength(1)
    expect(await onAskAnswer(h.s, 'first', 0, 0, 'ou_owner')).toBe(true)
    await flush()
    expect(urgentPushes).toHaveLength(2)
  })
})

describe('question presentation and backend handshakes', () => {
  test('a blocked-answer notice failure retains Feishu diagnostics without submitting the answer', async () => {
    const h = harness('codex')
    startReply()
    h.add('first', '先选择区域')
    const send = spyOn(feishu, 'sendText').mockImplementation(async (_chatId, _text, onFailure) => {
      onFailure?.({ code: 230002, msg: 'message rejected', log_id: 'ask-notice-log' })
      return null
    })
    restore.push(() => send.mockRestore())
    await expect(onAskMessageAnswer(h.s, '回答', 'ou_owner', 'om_answer'))
      .rejects.toThrow('code=230002 message=message rejected log_id=ask-notice-log')
    expect(h.answers).toHaveLength(0)
    expect(h.s.pendingAsks.get('first')!.currentIdx).toBe(0)
  })

  for (const provider of ['codex', 'claude', 'dsh'] as const) {
    test(`${provider}: notification input defers question controls and alerts; completion activates one question at a time`, async () => {
      const h = harness(provider)
      startReply()
      h.add('first', '先选择区域')
      h.add('second', '再选择环境')
      await flushAnnouncements()
      expect(panels.get(ELEMENTS.tool(0)).header.title.content).toBe('⏳ 等待通知回复完成')
      expect(JSON.stringify([...panels.values()])).not.toContain('interactive_container')
      expect(urgentPushes).toHaveLength(0)
      expect(await onAskAnswer(h.s, 'first', 0, 0, 'ou_owner')).toBe(false)
      expect(h.answers).toHaveLength(0)

      endReply()
      refreshPendingAsks(h.s)
      await flushAnnouncements()
      expect(JSON.stringify(panels.get(ELEMENTS.tool(0)))).toContain('interactive_container')
      expect(panels.get(ELEMENTS.tool(1)).header.title.content).toBe('⏳ 提问排队中')
      expect(urgentPushes).toHaveLength(1)
      expect(await onAskAnswer(h.s, 'second', 0, 1, 'ou_owner')).toBe(false)

      expect(await onAskAnswer(h.s, 'first', 0, 0, 'ou_owner')).toBe(true)
      await flushAnnouncements()
      expect(panels.get(ELEMENTS.tool(0)).header.title.content).toBe('✅ 已回答 · 1/1')
      expect(JSON.stringify(panels.get(ELEMENTS.tool(1)))).toContain('interactive_container')
      expect(urgentPushes).toHaveLength(2)
      expect(h.answers[0]).toMatchObject({ requestId: 'permission_first', decision: 'allow', options: {
        updatedInput: { questions: [{ question: '先选择区域' }], answers: { '先选择区域': 'A' } },
      } })
    })
  }

  test('opening a reply suspends an already visible question and later restores it', async () => {
    const h = harness('codex')
    h.add('first', '继续吗')
    await flushAnnouncements()
    expect(urgentPushes).toHaveLength(1)
    startReply()
    refreshPendingAsks(h.s)
    expect(panels.get(ELEMENTS.tool(0)).header.title.content).toBe('⏳ 等待通知回复完成')
    endReply()
    refreshPendingAsks(h.s)
    await flushAnnouncements()
    expect(JSON.stringify(panels.get(ELEMENTS.tool(0)))).toContain('interactive_container')
    expect(urgentPushes).toHaveLength(2)
  })

  test('a delayed question alert cannot overtake a reply or duplicate the resumed alert', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    spyOn(cardkit, 'patchSettings').mockImplementation(async () => { await gate })
    const h = harness('codex')
    h.add('first', '继续吗')
    startReply()
    refreshPendingAsks(h.s)
    endReply()
    refreshPendingAsks(h.s)
    release()
    await flushAnnouncements()
    expect(urgentPushes).toHaveLength(1)
  })
})
