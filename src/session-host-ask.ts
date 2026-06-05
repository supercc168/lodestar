import { randomUUID } from 'node:crypto'

import type { Session } from './session'
import * as cardkit from './cardkit'
import * as cards from './cards'
import * as feishu from './feishu'
import { log } from './log'

type HostAskActionResult = { ok: boolean; message: string; card?: object }
type HostAskRecord = {
  questions: cards.AskQuestion[]
  answered: Map<number, cards.AskAnswered>
  currentIdx?: number
  toolCallId: string
  inputJson: string
  cardId?: string
  messageId?: string
  creatingCard?: boolean
  resumeStarted?: boolean
}

function hostAskState(ask: {
  answered: Map<number, cards.AskAnswered>
  currentIdx?: number
}): cards.AskState {
  return { currentIdx: ask.currentIdx, answered: ask.answered }
}

function firstUnansweredHostAsk(s: Session): [string, HostAskRecord] | null {
  for (const entry of s.pendingHostAsks.entries()) {
    if (entry[1].currentIdx !== undefined) return entry as [string, HostAskRecord]
  }
  return null
}

function normalizeAskOptions(rawOptions: unknown): Array<{ label: string; description?: string }> {
  const optionsRaw = Array.isArray(rawOptions) ? rawOptions : []
  return optionsRaw.flatMap((item): Array<{ label: string; description?: string }> => {
    if (typeof item === 'string') {
      const label = item.trim()
      return label ? [{ label }] : []
    }
    if (!item || typeof item !== 'object') return []
    const label = typeof (item as { label?: unknown }).label === 'string'
      ? (item as { label: string }).label.trim()
      : ''
    if (!label) return []
    const description = typeof (item as { description?: unknown }).description === 'string'
      ? (item as { description: string }).description.trim()
      : undefined
    return [{ label, ...(description ? { description } : {}) }]
  })
}

function normalizeAskQuestion(raw: unknown): cards.AskQuestion | null {
  if (!raw || typeof raw !== 'object') return null
  const question = typeof (raw as { question?: unknown }).question === 'string'
    ? (raw as { question: string }).question.trim()
    : ''
  if (!question) return null
  const header = typeof (raw as { header?: unknown }).header === 'string'
    ? (raw as { header: string }).header.trim()
    : undefined
  const options = normalizeAskOptions((raw as { options?: unknown }).options)
  return {
    question,
    ...(header ? { header } : {}),
    options,
  }
}

function formatHostAskInput(questions: cards.AskQuestion[]): string {
  const payload: Record<string, unknown> = {
    questions: questions.map(question => {
      const item: Record<string, unknown> = { question: question.question }
      if (question.header) item.header = question.header
      if (question.options.length > 0) {
        item.options = question.options.map(opt => (
          opt.description
            ? { label: opt.label, description: opt.description }
            : { label: opt.label }
        ))
      }
      return item
    }),
  }
  if (questions.length === 1) {
    const [question] = questions
    payload.question = question.question
    if (question.header) payload.header = question.header
    if (question.options.length > 0) {
      payload.options = question.options.map(opt => (
        opt.description
          ? { label: opt.label, description: opt.description }
          : { label: opt.label }
      ))
    }
  }
  return JSON.stringify(payload)
}

function parseHostAskPayload(payloadText: string): { questions: cards.AskQuestion[]; inputJson: string } | null {
  let raw: unknown
  try {
    raw = JSON.parse(payloadText)
  } catch (e) {
    log(`host ask: invalid askusr JSON: ${e}`)
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const questions = Array.isArray((raw as { questions?: unknown[] }).questions)
    ? (raw as { questions: unknown[] }).questions.map(normalizeAskQuestion).filter((q): q is cards.AskQuestion => q != null)
    : []
  if (questions.length > 0) return { questions, inputJson: formatHostAskInput(questions) }
  const single = normalizeAskQuestion(raw)
  if (!single) return null
  return { questions: [single], inputJson: formatHostAskInput([single]) }
}

function answerPayload(ask: HostAskRecord): { answers: Array<{ header: string; question: string; answer: string; user: string }> } | null {
  const answers = ask.questions.map((question, idx) => {
    const answered = ask.answered.get(idx)
    if (!answered) return null
    const answer = answered.customText
      ?? (answered.optionIdx !== undefined ? question.options[answered.optionIdx]?.label : undefined)
      ?? ''
    if (!answer) return null
    return {
      header: question.header?.trim() || `问题 ${idx + 1}`,
      question: question.question,
      answer,
      user: answered.user ?? '',
    }
  })
  if (answers.some(item => item == null)) return null
  return { answers: answers as Array<{ header: string; question: string; answer: string; user: string }> }
}

async function createOrUpdateHostAskCard(s: Session, askId: string): Promise<void> {
  const ask = s.pendingHostAsks.get(askId)
  if (!ask) return
  const card = cards.hostAskCard(askId, ask.questions, hostAskState(ask))
  if (ask.cardId) {
    await cardkit.replaceElement(
      ask.cardId,
      cards.ELEMENTS.tool(0),
      cards.askUserQuestionElement(0, askId, ask.questions, ask.currentIdx === undefined ? '✅' : '🤔', hostAskState(ask), 'host_ask'),
    )
    if (ask.currentIdx === undefined) {
      try { await cardkit.dispose(ask.cardId) }
      catch (e) { log(`session "${s.sessionName}": host ask card dispose failed: ${e}`) }
    }
    return
  }
  if (ask.creatingCard) return
  ask.creatingCard = true
  try {
    const messageId = await feishu.sendCard(s.chatId, card)
    if (!messageId) {
      log(`session "${s.sessionName}": host ask sendCard failed`)
      await feishu.sendText(s.chatId, '❌ 澄清问题卡片发送失败，当前轮次无法继续。')
      return
    }
    let cardId = ''
    try { cardId = await cardkit.convertMessageToCard(messageId) }
    catch (e) {
      log(`session "${s.sessionName}": host ask id_convert failed: ${e}`)
      await feishu.sendText(s.chatId, '❌ 澄清问题卡片初始化失败，当前轮次无法继续。')
      return
    }
    ask.messageId = messageId
    ask.cardId = cardId
    cardkit.recordCardCreated(cardId, 1)
    if (ask.currentIdx === undefined) {
      await cardkit.replaceElement(
        cardId,
        cards.ELEMENTS.tool(0),
        cards.askUserQuestionElement(0, askId, ask.questions, '✅', hostAskState(ask), 'host_ask'),
      )
      try { await cardkit.dispose(cardId) }
      catch (e) { log(`session "${s.sessionName}": host ask card dispose failed: ${e}`) }
    }
  } finally {
    const latest = s.pendingHostAsks.get(askId)
    if (latest) latest.creatingCard = false
  }
}

async function maybeContinueHostAsk(s: Session, askId: string): Promise<void> {
  const ask = s.pendingHostAsks.get(askId)
  if (!ask || ask.currentIdx !== undefined || ask.resumeStarted) return
  if (!s.isRunning() || s.currentTurn || s.status !== 'idle') return
  const result = answerPayload(ask)
  if (!result) return
  ask.resumeStarted = true
  try {
    await s.proc!.injectThreadItems([
      {
        type: 'custom_tool_call',
        call_id: ask.toolCallId,
        name: 'askusr',
        input: ask.inputJson,
      },
      {
        type: 'custom_tool_call_output',
        call_id: ask.toolCallId,
        name: 'askusr',
        output: JSON.stringify(result),
      },
    ])
    await s.startHostAskContinuation('Continue using the askusr tool result above.')
    s.pendingHostAsks.delete(askId)
  } catch (e) {
    ask.resumeStarted = false
    const message = e instanceof Error ? e.message : String(e)
    log(`session "${s.sessionName}": host ask continue failed: ${message}`)
    await feishu.sendText(s.chatId, `❌ askusr 续跑失败: ${message}`)
  }
}

export function resumeAnsweredHostAsks(s: Session): void {
  for (const askId of s.pendingHostAsks.keys()) {
    void maybeContinueHostAsk(s, askId)
  }
}

function advanceHostAsk(
  s: Session,
  askId: string,
  answer: { optionIdx?: number; customText?: string; user: string },
): HostAskActionResult {
  const ask = s.pendingHostAsks.get(askId)
  if (!ask || ask.currentIdx === undefined) return { ok: false, message: '问题已结束' }
  const question = ask.questions[ask.currentIdx]
  if (!question) return { ok: false, message: '问题不存在' }
  let value: string
  if (answer.customText !== undefined) {
    value = answer.customText
  } else if (answer.optionIdx !== undefined) {
    const opt = question.options[answer.optionIdx]
    if (!opt) return { ok: false, message: '选项不存在' }
    value = opt.label
  } else {
    return { ok: false, message: '无效答案' }
  }
  ask.answered.set(ask.currentIdx, {
    optionIdx: answer.optionIdx,
    customText: answer.customText,
    user: answer.user,
  })
  let nextIdx: number | undefined
  for (let idx = ask.currentIdx + 1; idx < ask.questions.length; idx++) {
    if (!ask.answered.has(idx)) {
      nextIdx = idx
      break
    }
  }
  ask.currentIdx = nextIdx
  const card = cards.hostAskCard(askId, ask.questions, hostAskState(ask))
  void createOrUpdateHostAskCard(s, askId)
  void maybeContinueHostAsk(s, askId)
  return { ok: true, message: '已回答', card }
}

export function hasPendingHostAsk(s: Session): boolean {
  return firstUnansweredHostAsk(s) != null
}

export function queueHostAskFromMarker(s: Session, payloadText: string, _rawMarker: string): void {
  if (s.pendingHostAsks.size > 0) {
    log(`session "${s.sessionName}": ignore askusr marker because another host ask is pending`)
    return
  }
  const parsed = parseHostAskPayload(payloadText)
  if (!parsed) {
    log(`session "${s.sessionName}": invalid askusr marker payload`)
    return
  }
  const askId = `host_ask_${randomUUID()}`
  s.pendingHostAsks.set(askId, {
    questions: parsed.questions,
    answered: new Map(),
    currentIdx: 0,
    toolCallId: `call_${randomUUID()}`,
    inputJson: parsed.inputJson,
    resumeStarted: false,
  })
  void createOrUpdateHostAskCard(s, askId)
}

export async function onHostAskMessageAnswer(s: Session, text: string, user: string, msgId: string): Promise<void> {
  const first = firstUnansweredHostAsk(s)
  if (!first) return
  const [askId, ask] = first
  if (ask.currentIdx === undefined) return
  const result = await onHostAskCustomAnswer(s, askId, ask.currentIdx, text, user)
  if (result.ok && msgId) void feishu.addReaction(msgId, 'CheckMark')
}

export async function onHostAskAnswer(
  s: Session,
  askId: string,
  questionIdx: number,
  optionIdx: number,
  user: string,
): Promise<HostAskActionResult> {
  const ask = s.pendingHostAsks.get(askId)
  if (!ask) return { ok: false, message: '问题不存在' }
  if (questionIdx !== ask.currentIdx) return { ok: false, message: '问题已过期' }
  return advanceHostAsk(s, askId, { optionIdx, user })
}

export async function onHostAskCustomAnswer(
  s: Session,
  askId: string,
  questionIdx: number,
  customText: string,
  user: string,
): Promise<HostAskActionResult> {
  const ask = s.pendingHostAsks.get(askId)
  if (!ask) return { ok: false, message: '问题不存在' }
  const trimmed = (customText ?? '').trim()
  if (!trimmed) return { ok: false, message: '请输入答案' }
  if (questionIdx !== ask.currentIdx) return { ok: false, message: '问题已过期' }
  return advanceHostAsk(s, askId, { customText: trimmed, user })
}
