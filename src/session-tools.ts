/**
 * Tool-tracking helpers split out of session.ts. Free functions taking
 * a Session; fields they touch are package-internal (no `private`
 * modifier on the class side). Cross-file boundary lets the main
 * session.ts stay under Claude Code's per-read token budget.
 */

import type { Session } from './session'
import * as cardkit from './cardkit'
import * as cards from './cards'
import * as feishu from './feishu'

export function isTaskWorkflow(name: string): boolean {
  return name.startsWith('Task') && name !== 'Task'
}

export function todosArray(s: Session): cards.Todo[] {
  return [...s.currentTodos.values()]
}

export function addTool(s: Session, toolUseId: string, name: string, input: any): void {
  if (!s.currentTurn) return
  // 模型出第一个工具 → 顶部 ticker 活体指示完成使命,清掉;footer 切到
  // `⏳ working…` 接力做"还在干活"的指示。stopTicker 后续调用 handle
  // null 时短路,所以多次 tool_use 安全。footer 同样写入由 cardkit 的
  // lastSent 自然去重,只会 PUT 一次。
  s.stopTicker(s.currentTurn)
  cardkit.streamTextThrottled(s.currentTurn.cardId, cards.ELEMENTS.footer, '⏳ working…')
  // Close current assistant segment (if any) so the tool panel renders
  // AFTER it in card body order. Flush queues the segment's last
  // buffered delta before the tool element is inserted.
  if (s.currentTurn.currentAssistantSegmentId) {
    void cardkit.flush(s.currentTurn.cardId)
    s.currentTurn.currentAssistantSegmentId = null
    s.currentTurn.currentAssistantText = ''
  }
  // Consecutive Read merger: if a Read run is already open, append to
  // its batch and re-render the panel instead of inserting a new one.
  // Any other tool name closes the run (handled below).
  if (name === 'Read' && s.currentTurn.openReadBatchI !== null) {
    const batchI = s.currentTurn.openReadBatchI
    const batch = s.currentTurn.readBatches.get(batchI)!
    const slot = batch.items.length
    batch.items.push({ toolUseId, input, output: null, isError: false })
    s.currentTurn.toolByUseId.set(toolUseId, { i: batchI, name, input, readBatchSlot: slot })
    const el = cards.readBatchElement(batchI, batch.items)
    void cardkit.replaceElement(s.currentTurn.cardId, cards.ELEMENTS.tool(batchI), el)
    return
  }
  if (name !== 'Read') s.currentTurn.openReadBatchI = null
  const i = s.currentTurn.toolCount++
  if (name === 'Read') {
    // First Read of a potential run — render the existing single-tool
    // panel (which keeps the full file-contents dump on completion). If
    // a second Read arrives, completeTool/addTool will switch it to
    // `readBatchElement`.
    s.currentTurn.openReadBatchI = i
    s.currentTurn.readBatches.set(i, {
      items: [{ toolUseId, input, output: null, isError: false }],
    })
    s.currentTurn.toolByUseId.set(toolUseId, { i, name, input, readBatchSlot: 0 })
    const el = cards.toolCallElement(i, name, input, null, '⏳', undefined, undefined)
    void cardkit.addElement(s.currentTurn.cardId, el, {
      type: 'insert_before', targetElementId: cards.ELEMENTS.footer,
    })
    return
  }
  s.currentTurn.toolByUseId.set(toolUseId, { i, name, input })
  // AskUserQuestion is a client-side tool — daemon renders the choice
  // UI in-line and supplies the tool_result itself once the user
  // clicks. Branch BEFORE the generic toolCallElement so we never
  // fall through to a JSON dump or, worse, get clobbered by the
  // permission flow (which would render 🔐 three-button buttons that
  // don't match the actual N options).
  if (name === 'AskUserQuestion') {
    const questions = Array.isArray(input?.questions) ? input.questions as cards.AskQuestion[] : []
    const startIdx = questions.length > 0 ? 0 : undefined
    const answered = new Map<number, cards.AskAnswered>()
    s.pendingAsks.set(toolUseId, {
      questions,
      i,
      answers: {},
      answered,
      currentIdx: startIdx,
    })
    const el = cards.askUserQuestionElement(i, toolUseId, questions, '🤔', {
      currentIdx: startIdx,
      answered,
    })
    void cardkit.addElement(s.currentTurn.cardId, el, {
      type: 'insert_before',
      targetElementId: cards.ELEMENTS.footer,
    })
    // Phone push — user has to come back and answer before Claude can
    // continue. Set summary to the question text so the lock-screen
    // notification preview shows what the user needs to answer.
    if (s.currentTurn.userOpenId && s.currentTurn.messageId) {
      const turn = s.currentTurn
      const q0 = questions[0]?.question?.trim() ?? ''
      const truncated = q0.length > 40 ? q0.slice(0, 40) + '…' : q0
      const summary = questions.length > 1
        ? `❓ 待回答 ${questions.length} 题${truncated ? `: ${truncated}` : ''}`
        : truncated
          ? `❓ ${truncated}`
          : '❓ 等你回答问题'
      void (async () => {
        cardkit.cancelSummary(turn.cardId)
        await cardkit.patchSettings(turn.cardId, { config: { summary: { content: summary } } })
        await feishu.urgentApp(turn.messageId, [turn.userOpenId])
      })()
    }
    return
  }
  // Pending Task* panels still show the *pre-op* todo mirror so users
  // can read the current state immediately, without waiting for the
  // tool to return.
  const todos = isTaskWorkflow(name) ? todosArray(s) : undefined
  const el = cards.toolCallElement(i, name, input, null, '⏳', undefined, todos)
  void cardkit.addElement(s.currentTurn.cardId, el, {
    type: 'insert_before',
    targetElementId: cards.ELEMENTS.footer,
  })
}

export function completeTool(s: Session, toolUseId: string, content: any, isError: boolean): void {
  if (!s.currentTurn) return
  const meta = s.currentTurn.toolByUseId.get(toolUseId)
  if (!meta) return
  const output = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c: any) => c?.text ?? JSON.stringify(c)).join('\n')
      : JSON.stringify(content)
  // Stash on the meta — every Task* op coming after this point may
  // need to re-render this panel with a fresher todo footer, so we
  // can't discard the output after the first paint.
  meta.output = output
  meta.isError = isError
  // AskUserQuestion already had its final panel painted by resolveAsk
  // (✅ + the chosen option marked, others dimmed). The tool_result
  // arriving here is just the SDK's synthesised echo — re-rendering
  // via toolCallElement would clobber the nice option-row layout
  // with a generic JSON dump. Bail out; the panel is done.
  if (meta.name === 'AskUserQuestion') return
  // Read batch path: update this row's status in the shared batch then
  // re-render. Single-item batches keep the original full-output panel
  // (file-contents dump); 2+ items switch to the compact `Read · N 次`
  // listing, which overwrites whatever was last drawn at this i.
  if (meta.name === 'Read' && meta.readBatchSlot != null) {
    const batch = s.currentTurn.readBatches.get(meta.i)
    if (batch) {
      const row = batch.items[meta.readBatchSlot]
      if (row) { row.output = output; row.isError = isError }
      const el = batch.items.length >= 2
        ? cards.readBatchElement(meta.i, batch.items)
        : cards.toolCallElement(meta.i, meta.name, meta.input, output, isError ? '❌' : '✅', meta.resolvedNote, undefined)
      void cardkit.replaceElement(s.currentTurn.cardId, cards.ELEMENTS.tool(meta.i), el)
    }
    return
  }
  // Update the local todo mirror BEFORE rendering so the just-
  // completed panel shows the new state too (e.g. a TaskCreate panel
  // already lists the task it just created).
  if (!isError && isTaskWorkflow(meta.name)) {
    updateTodosFromTask(s, meta.name, meta.input, output)
  }
  const todos = isTaskWorkflow(meta.name) ? todosArray(s) : undefined
  const el = cards.toolCallElement(meta.i, meta.name, meta.input, output, isError ? '❌' : '✅', meta.resolvedNote, todos)
  void cardkit.replaceElement(s.currentTurn.cardId, cards.ELEMENTS.tool(meta.i), el)
  // Cascade the new mirror into every prior Task* panel in this turn
  // so any expanded panel reflects the latest state, not the snapshot
  // captured when that op ran.
  if (!isError && isTaskWorkflow(meta.name)) {
    refreshOtherTaskPanels(s, toolUseId)
  }
}

/** Roll a single Task* op into the local mirror — best-effort. Output
 * parsing is regex-based (the SDK returns plain text like "Task #7
 * created successfully: …"), so unexpected variants are skipped
 * silently rather than blowing up the panel render. */
export function updateTodosFromTask(s: Session, name: string, input: any, output: string): void {
  switch (name) {
    case 'TaskCreate': {
      const m = output.match(/Task #(\d+) created/)
      if (!m) return
      const id = Number(m[1])
      s.currentTodos.set(id, {
        id,
        subject: input.subject,
        description: input.description,
        activeForm: input.activeForm,
        status: 'pending',
      })
      return
    }
    case 'TaskUpdate': {
      const id = Number(input.taskId)
      if (!Number.isFinite(id)) return
      // status=deleted is the SDK's tombstone — drop from the mirror
      // so the readout doesn't carry it forever. Server still keeps
      // it; the mirror is just for the panel footer.
      if (input.status === 'deleted') { s.currentTodos.delete(id); return }
      const cur = s.currentTodos.get(id) ?? { id, status: 'pending' as const }
      if (input.status)      cur.status = input.status
      if (input.subject)     cur.subject = input.subject
      if (input.description) cur.description = input.description
      if (input.owner)       cur.owner = input.owner
      if (input.activeForm)  cur.activeForm = input.activeForm
      s.currentTodos.set(id, cur)
      return
    }
    // TaskList / TaskGet / TaskStop / TaskOutput / TaskDelete:
    // read-only or parse-heavy — skip mirror update. The panel will
    // still render the SDK's textual result below the operation
    // block, which is enough to disambiguate.
  }
}

/** Re-render every Task* panel in the current turn (except the one
 * that just landed — already up-to-date) so they all show the latest
 * todo mirror in their footers. Cheap: ELEMENTS.tool(i) replace is
 * queued through the per-card Promise chain like any other op. */
export function refreshOtherTaskPanels(s: Session, skipToolUseId: string): void {
  if (!s.currentTurn) return
  const todos = todosArray(s)
  for (const [id, meta] of s.currentTurn.toolByUseId) {
    if (id === skipToolUseId) continue
    if (!isTaskWorkflow(meta.name)) continue
    const status: '⏳' | '✅' | '❌' = meta.output === undefined
      ? '⏳'
      : (meta.isError ? '❌' : '✅')
    const el = cards.toolCallElement(
      meta.i, meta.name, meta.input, meta.output ?? null,
      status, meta.resolvedNote, todos,
    )
    void cardkit.replaceElement(s.currentTurn.cardId, cards.ELEMENTS.tool(meta.i), el)
  }
}
