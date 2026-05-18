/**
 * AskUserQuestion flow split out of session.ts. The SDK routes
 * AskUserQuestion through can_use_tool even under bypass mode, so the
 * "answered" state lives across two SDK control messages — option
 * clicks/custom text land via Feishu callbacks first, then
 * can_use_tool arrives and we finalize with `updatedInput.answers`.
 */

import type { Session } from './session'
import * as cardkit from './cardkit'
import * as cards from './cards'
import { log } from './log'

/** True iff there's at least one open AskUserQuestion awaiting an
 * answer in this session. `daemon.handleMessage` uses this to
 * decide whether an inbound chat message should be a custom answer
 * (routed to onAskMessageAnswer) instead of opening a new turn. */
export function hasPendingAsk(s: Session): boolean {
  return s.pendingAsks.size > 0
}

/** Funnel an arbitrary chat message into the *current* question
 * of the oldest pending ask as a `customText` answer. Multi-
 * question semantics: from the user's perspective, the chat
 * input always answers whatever question is on screen right now
 * (`pending.currentIdx`), and a new question slides in after. */
export async function onAskMessageAnswer(s: Session, text: string, user: string): Promise<void> {
  const firstEntry = s.pendingAsks.entries().next()
  if (firstEntry.done) {
    log(`session "${s.sessionName}": onAskMessageAnswer with no pending — falling back to onUserMessage`)
    await s.onUserMessage(text)
    return
  }
  const [toolUseId, pending] = firstEntry.value
  if (pending.currentIdx === undefined) {
    log(`session "${s.sessionName}": pending ask ${toolUseId} already terminal — ignoring message`)
    return
  }
  await onAskCustomAnswer(s, toolUseId, pending.currentIdx, text, user)
}

/** Click handler for an option button. The click must target the
 * question currently on screen (`pending.currentIdx`); a stale
 * click (e.g. user clicked an older render before it swapped in
 * the next question) is logged and dropped — better than double-
 * answering. */
export async function onAskAnswer(
  s: Session,
  toolUseId: string,
  questionIdx: number,
  optionIdx: number,
  user: string,
): Promise<void> {
  const pending = s.pendingAsks.get(toolUseId)
  if (!pending) { log(`session "${s.sessionName}": stray ask answer for ${toolUseId}`); return }
  if (questionIdx !== pending.currentIdx) {
    log(`session "${s.sessionName}": stale ask click q=${questionIdx} current=${pending.currentIdx}`)
    return
  }
  advanceAsk(s, toolUseId, { optionIdx, user })
}

/** Custom-text branch. Same staleness rule as onAskAnswer; empty
 * input is silently ignored (panel stays pending). */
export async function onAskCustomAnswer(
  s: Session,
  toolUseId: string,
  questionIdx: number,
  customText: string,
  user: string,
): Promise<void> {
  const pending = s.pendingAsks.get(toolUseId)
  if (!pending) { log(`session "${s.sessionName}": stray ask custom for ${toolUseId}`); return }
  const trimmed = (customText ?? '').trim()
  if (!trimmed) { log(`session "${s.sessionName}": empty custom answer, ignoring`); return }
  if (questionIdx !== pending.currentIdx) {
    log(`session "${s.sessionName}": stale ask custom q=${questionIdx} current=${pending.currentIdx}`)
    return
  }
  advanceAsk(s, toolUseId, { customText: trimmed, user })
}

/** Record an answer for the current question, advance the state
 * machine, repaint. If every question is now answered, finalize
 * (or defer the finalize until can_use_tool lands — the race is
 * handled by renderPermission). */
export function advanceAsk(
  s: Session,
  toolUseId: string,
  answer: { optionIdx?: number; customText?: string; user: string },
): void {
  const pending = s.pendingAsks.get(toolUseId)
  if (!pending || pending.currentIdx === undefined) return
  const cur = pending.currentIdx
  const q = pending.questions[cur]
  if (!q) { log(`session "${s.sessionName}": advanceAsk currentIdx=${cur} out of range`); return }
  // Resolve the literal answer value — custom text wins if both set.
  let value: string
  if (answer.customText !== undefined) {
    value = answer.customText
  } else if (answer.optionIdx !== undefined) {
    const opt = q.options?.[answer.optionIdx]
    if (!opt) { log(`session "${s.sessionName}": advanceAsk option ${answer.optionIdx} out of range`); return }
    value = opt.label
  } else {
    log(`session "${s.sessionName}": advanceAsk with neither customText nor optionIdx`)
    return
  }
  pending.answers[q.question] = value
  pending.answered.set(cur, {
    optionIdx: answer.optionIdx,
    customText: answer.customText,
    user: answer.user,
  })
  // Next unanswered idx — linear from cur+1. Implementation
  // always moves forward; we don't currently let users revisit a
  // previous question (would need richer UI affordance for that).
  const total = pending.questions.length
  let nextIdx: number | undefined = undefined
  for (let i = cur + 1; i < total; i++) {
    if (!pending.answered.has(i)) { nextIdx = i; break }
  }
  pending.currentIdx = nextIdx

  const turn = s.currentTurn
  const meta = turn?.toolByUseId.get(toolUseId)
  if (turn && meta) {
    const el = cards.askUserQuestionElement(
      meta.i, toolUseId, pending.questions,
      nextIdx === undefined ? '✅' : '🤔',
      { currentIdx: nextIdx, answered: pending.answered },
    )
    void cardkit.replaceElement(turn.cardId, cards.ELEMENTS.tool(meta.i), el)
  }

  if (nextIdx === undefined) {
    // All done. Finalize iff we have the permission request id;
    // otherwise renderPermission will pick it up when it arrives.
    if (pending.requestId) finalizeAsk(s, toolUseId)
    else log(`session "${s.sessionName}": ask ${toolUseId} all answered, waiting for can_use_tool`)
  }
}

/** Settle a fully-answered AskUserQuestion: emit the SDK allow
 * with the full `answers` record folded into `updatedInput`,
 * drop bookkeeping, restore status. The terminal panel paint was
 * already done by the final advanceAsk; this is just protocol. */
export function finalizeAsk(s: Session, toolUseId: string): void {
  const pending = s.pendingAsks.get(toolUseId)
  if (!pending || !pending.requestId) return
  const meta = s.currentTurn?.toolByUseId.get(toolUseId)
  const originalInput = meta?.input ?? {}
  s.proc?.sendPermissionResponse(pending.requestId, 'allow', {
    updatedInput: { ...originalInput, answers: pending.answers },
  })
  s.pendingPermissions.delete(pending.requestId)
  if (meta) {
    meta.output = JSON.stringify({ answers: pending.answers })
    meta.isError = false
  }
  s.pendingAsks.delete(toolUseId)
  if (s.pendingPermissions.size === 0 && s.status === 'awaiting_permission') {
    s.status = 'working'
  }
  // 用户答完 → 球踢回 SDK,期望模型基于 answers 推理出后续动作。如果 SDK
  // bug 把 turn 直接 end_turn 不让模型 followup,result handler 看到这个
  // flag 还在(没被 assistant_text / tool_use 清掉)就自动 sendUserText('继续')
  // poke 一下。SDK 合成的 AskUserQuestion tool_result 不清这个 flag —— 它
  // 是 SDK 把答案塞给模型的回环,不算"模型已 followup"的证据。
  s.awaitingFollowup = 'ask'
}
