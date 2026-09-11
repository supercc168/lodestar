import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { resetFeishuMock, sentTexts } from './feishu-test-mock'
import * as cardkit from './cardkit'
import { ELEMENTS } from './cards'
import { addTool } from './session-tools'
import { renderPermission } from './session-permission'
import { askBlockReason, askRenderState, onAskAnswer, onAskMessageAnswer } from './session-ask'
import { __setPendingReplyForTest } from './notify-callbacks'
import type { Session } from './session'

let panels: Map<string, any>
let restore: Array<() => void>
beforeEach(() => {
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
})

function harness() {
  const answers: Array<{ requestId: string; decision: string; options: any }> = []
  const userMessages: Array<{ text: string; user: string; msgId: string }> = []
  const s = {
    chatId: 'oc_ask', sessionName: 'ask-priority', status: 'working',
    pendingAsks: new Map(), pendingPermissions: new Map(),
    currentTurn: {
      cardId: 'card_ask', messageId: 'om_turn', userOpenId: 'ou_owner', provider: 'codex',
      toolCount: 0, toolByUseId: new Map(), toolBatches: new Map(), openBatchI: null,
    },
    observeWatchdogToolStart: () => {},
    maybeMidTurnRotate: () => {},
    startWorkingFooter: () => {},
    finalizeCurrentAssistantSegment: () => {},
    proc: {
      provider: 'codex',
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

const flush = () => new Promise<void>(resolve => setImmediate(resolve))

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
})
