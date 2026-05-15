/**
 * Session — 1 Feishu chat ↔ 1 Claude headless process ↔ 1 streaming card.
 *
 * Owns the ClaudeProcess lifecycle, the per-turn card state machine, and
 * the in-flight permission map.  Wires Claude's stdout events into Card
 * Kit ops, and wires Feishu inbound (text + card-action callbacks) into
 * Claude's stdin.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ClaudeProcess, type CanUseToolRequest, type HookCallbackRequest, type ClaudeUsage } from './claude-process'
import { CHANNEL_INSTRUCTIONS } from './instructions'
import * as cardkit from './cardkit'
import * as cards from './cards'
import * as feishu from './feishu'
import { log } from './log'
import { INBOX_DIR } from './paths'

interface TurnState {
  cardId: string
  userText: string
  thinkingText: string
  toolCount: number
  /** `output` / `isError` are filled in by completeTool — kept on the
   * meta (instead of being thrown away after the first render) so a
   * later Task* op can re-render every prior Task* panel with the
   * latest todo mirror appended. */
  toolByUseId: Map<string, {
    i: number
    name: string
    input: any
    resolvedNote?: string
    output?: string
    isError?: boolean
  }>
  assistantSegmentCount: number
  currentAssistantSegmentId: string | null
  currentAssistantText: string
  // Per-assistant-segment cumulative text — used at turn close to strip
  // [[send: /path]] markers and replace each segment with a cleaned
  // version, then post the files as separate Feishu messages.
  segmentTexts: Map<string, string>
  startedAt: number
}

const SEND_MARKER_RE = /\[\[send:\s*([^\]\n]+?)\s*\]\]/g

type Status = 'idle' | 'working' | 'awaiting_permission' | 'starting' | 'stopped'

export interface SessionOpts {
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
}

/** Per-turn delta extracted from the SDK `result` message — feeds the
 * "上一轮" line in the console panel. */
interface LastTurnDelta {
  tokens: number      // input + cache_* + output for that turn
  costUsd: number
  durationMs: number
  inputTokens: number // input + cache_* (excludes output) — context-window estimate
}

/** Cumulative session counters. Reset on full restart (`clear`), preserved
 * across resume — but resumed conversations start counting from the
 * resume point, not the original turn 0; the SDK doesn't replay historical
 * usage. The session_id continuity is preserved separately by the resume
 * map; cumStats represents "since the current ClaudeProcess was spawned". */
interface CumStats {
  tokens: number
  costUsd: number
  turns: number
}

export class Session {
  private proc: ClaudeProcess | null = null
  private currentTurn: TurnState | null = null
  private pendingPermissions = new Map<string, { toolUseId: string }>()
  private turnCounter = 0
  // Last seen sessionId — preserved across `kill`/`stop` so a later
  // `restart` can resume the same Claude conversation even after the
  // child process is gone.
  private lastSessionId: string | null = null
  private startedAt: number = 0
  private cumStats: CumStats = { tokens: 0, costUsd: 0, turns: 0 }
  private lastTurnDelta: LastTurnDelta | null = null
  /** Local mirror of the SDK's task list — built incrementally from
   * TaskCreate / TaskUpdate input+output pairs and rendered as a footer
   * on every Task* panel. Lives for the lifetime of the Session
   * instance; daemon restart wipes it (the SDK doesn't replay history).
   * Not authoritative — Claude calling TaskList is still the source of
   * truth; this mirror is purely for the panel readout. */
  private currentTodos = new Map<number, cards.Todo>()
  status: Status = 'stopped'

  constructor(
    public readonly sessionName: string,
    public readonly chatId: string,
    private opts: SessionOpts = {},
  ) {
    // Restore last-known claude session_id from disk so a daemon restart
    // (systemctl, crash, watchdog) doesn't strand the user with a fresh
    // conversation when they next type `restart`.
    this.lastSessionId = feishu.getSessionResume(sessionName)
    if (this.lastSessionId) {
      log(`session "${sessionName}": restored lastSessionId=${this.lastSessionId.slice(0, 8)}…`)
    }
  }

  get workDir(): string { return join(feishu.PROJECTS_ROOT, this.sessionName) }
  isRunning(): boolean { return !!this.proc && this.proc.isAlive() }

  // ── Lifecycle ──────────────────────────────────────────────────────
  async start(): Promise<boolean> {
    if (this.isRunning()) return true
    if (!feishu.isAnthropicAuthenticated()) {
      await feishu.sendText(this.chatId, '❌ Claude 未登录 Anthropic 账号。\n请在服务器上运行 `claude auth login` 后再试。')
      return false
    }
    if (!existsSync(this.workDir)) {
      await feishu.sendText(this.chatId, `🆕 目录 ~/${this.sessionName} 不存在，正在创建…`)
      try { feishu.provisionProject(this.workDir) }
      catch (e) {
        await feishu.sendText(this.chatId, `❌ 创建项目失败: ${e}`)
        return false
      }
    }

    this.status = 'starting'
    this.proc = new ClaudeProcess({
      workDir: this.workDir,
      effort: 'max',
      permissionMode: this.opts.permissionMode ?? 'bypassPermissions',
      appendSystemPrompt: CHANNEL_INSTRUCTIONS,
    })
    this.wireProc(this.proc)
    this.proc.sendInitialize({})

    await feishu.sendText(this.chatId, `✅ Lodestar session "${this.sessionName}" 已就绪，发消息开始对话。`)
    this.status = 'idle'
    this.startedAt = Date.now()
    return true
  }

  async stop(reason = '已终止'): Promise<void> {
    if (!this.proc) {
      this.status = 'stopped'
      await feishu.sendText(this.chatId, `⚪ session "${this.sessionName}" 当前未运行`)
      return
    }
    this.lastSessionId = this.proc.sessionId ?? this.lastSessionId
    await this.proc.kill()
    this.proc = null
    this.currentTurn = null
    this.pendingPermissions.clear()
    this.status = 'stopped'
    await feishu.sendText(this.chatId, `🔴 ${reason} (session: ${this.sessionName})`)
  }

  async restart(resume = false): Promise<void> {
    const prevSessionId = this.proc?.sessionId ?? this.lastSessionId
    if (this.proc) {
      this.lastSessionId = this.proc.sessionId ?? this.lastSessionId
      await this.proc.kill()
      this.proc = null
    }
    this.currentTurn = null
    this.pendingPermissions.clear()
    if (resume && prevSessionId) {
      this.proc = new ClaudeProcess({
        workDir: this.workDir,
        effort: 'max',
        permissionMode: this.opts.permissionMode ?? 'bypassPermissions',
        resumeSessionId: prevSessionId,
        appendSystemPrompt: CHANNEL_INSTRUCTIONS,
      })
      this.wireProc(this.proc)
      this.proc.sendInitialize({})
      this.status = 'idle'
      this.startedAt = Date.now()
      await feishu.sendText(this.chatId, `🔁 已重启并恢复 session=${prevSessionId.slice(0, 8)}…`)
    } else {
      // Resume requested but no prior session_id on file — surface it
      // explicitly rather than silently fresh-starting (the old behavior
      // hid the daemon-restart sessionId-loss bug for months).
      if (resume) {
        await feishu.sendText(this.chatId, '⚠️ 没有可恢复的上一会话，将以新会话启动')
      }
      // Fresh conversation — drop cumulative stats so the next `hi` shows
      // zeroed counters instead of bleeding numbers from the prior chat.
      this.cumStats = { tokens: 0, costUsd: 0, turns: 0 }
      this.lastTurnDelta = null
      await this.start()
    }
  }

  /** Run a bare-text control command (`hi`, `kill`, `restart`, `clear`).
   * Returns true if the command was consumed (don't forward to Claude).
   * Exact match, case-insensitive, ignores trailing whitespace.
   *
   * Trade-off (user-confirmed 2026-05-15): the four words are reserved
   * globally — typing "hi" as a literal greeting will show the console
   * card instead of reaching Claude. The ergonomic win (no slash, no
   * shift key, one-handed phone use) outweighs the collision in this
   * product's private-bot use case. */
  async runCommand(raw: string): Promise<boolean> {
    switch (raw.trim().toLowerCase()) {
      case 'hi':
        if (!this.isRunning()) {
          const ok = await this.start()
          if (!ok) return true
        }
        await this.showConsole()
        return true
      case 'kill':
        await this.stop()
        return true
      case 'restart':
        await this.restart(true)
        return true
      case 'clear':
        await this.restart(false)
        return true
    }
    return false
  }

  async showConsole(): Promise<void> {
    const uptimeMs = this.startedAt ? (Date.now() - this.startedAt) : undefined
    // Strip the `claude-` prefix so the panel stays compact: `opus-4-7`
    // reads better than `claude-opus-4-7` in the small status header.
    const rawModel = this.proc?.lastModel ?? null
    const model = rawModel ? rawModel.replace(/^claude-/, '') : undefined
    const card = cards.consoleCard({
      sessionName: this.sessionName,
      status: this.status,
      model,
      effort: 'max',
      uptimeMs,
      contextTokens: this.currentContextTokens(),
      cumStats: this.cumStats,
      lastTurn: this.lastTurnDelta
        ? {
            tokens: this.lastTurnDelta.tokens,
            costUsd: this.lastTurnDelta.costUsd,
            durationMs: this.lastTurnDelta.durationMs,
          }
        : undefined,
      sessionId: this.proc?.sessionId ?? this.lastSessionId,
      hasSession: this.isRunning(),
    })
    await feishu.sendCard(this.chatId, card)
  }

  interrupt(): void {
    if (!this.proc) return
    log(`session "${this.sessionName}": interrupt`)
    this.proc.sendInterrupt()
  }

  // ── Inbound from Feishu ────────────────────────────────────────────
  async onUserMessage(text: string, files: string[] = []): Promise<void> {
    if (!this.isRunning()) {
      const ok = await this.start()
      if (!ok) return
    }
    if (this.currentTurn) {
      log(`session "${this.sessionName}": new turn arriving mid-flight, interrupting`)
      this.proc!.sendInterrupt()
      await this.closeTurnCard('🛑 用户打断')
    }
    await this.openTurnCard(text)
    this.proc!.sendUserText(text, files)
    this.status = 'working'
  }

  async onPermissionDecision(
    requestId: string,
    decision: 'allow' | 'allow_always' | 'deny',
    user: string,
  ): Promise<void> {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) { log(`session "${this.sessionName}": stray permission ${requestId}`); return }
    this.pendingPermissions.delete(requestId)

    // Update the tool element in the main turn card in place — the
    // permission decision lives on the same row as the tool call.
    const turn = this.currentTurn
    const meta = turn?.toolByUseId.get(pending.toolUseId)
    if (turn && meta) {
      const todos = this.isTaskWorkflow(meta.name) ? this.todosArray() : undefined
      if (decision === 'deny') {
        const el = cards.toolCallElement(meta.i, meta.name, meta.input, `🚫 已拒绝 by ${user || '匿名'}`, '❌', undefined, todos)
        void cardkit.replaceElement(turn.cardId, cards.ELEMENTS.tool(meta.i), el)
      } else {
        const label = decision === 'allow_always' ? '始终允许' : '已允许'
        meta.resolvedNote = `✅ **${label}** by ${user || '匿名'}`
        const el = cards.toolCallElement(meta.i, meta.name, meta.input, null, '⏳', meta.resolvedNote, todos)
        void cardkit.replaceElement(turn.cardId, cards.ELEMENTS.tool(meta.i), el)
      }
    }

    const claudeDecision = decision === 'deny' ? 'deny' : 'allow'
    this.proc?.sendPermissionResponse(requestId, claudeDecision)

    if (decision === 'allow_always') {
      this.proc?.sendSetPermissionMode('acceptEdits')
    }

    if (this.pendingPermissions.size === 0 && this.status === 'awaiting_permission') {
      this.status = 'working'
    }
  }

  async onConsoleAction(action: string): Promise<void> {
    log(`session "${this.sessionName}": console action=${action}`)
    switch (action) {
      case 'interrupt': this.interrupt(); break
      case 'clear':     await this.restart(false); break
      case 'stop':      await this.stop(); break
      case 'start':     await this.start(); break
      case 'resume':    await this.restart(true); break
      case 'refresh':   await this.showConsole(); break
      case 'ls':        await feishu.sendText(this.chatId, `📁 ${this.workDir}`); break
    }
  }

  // ── Wiring Claude → Feishu ─────────────────────────────────────────
  private wireProc(p: ClaudeProcess): void {
    p.on('init', () => {
      // Persist the freshly assigned session_id so a later daemon
      // restart can resume this conversation. Skip if unchanged to
      // avoid hammering the file on every init for resumed sessions.
      if (p.sessionId && p.sessionId !== this.lastSessionId) {
        this.lastSessionId = p.sessionId
        feishu.bindSessionResume(this.sessionName, p.sessionId)
      }
    })
    p.on('assistant_text', ({ text }: { text: string }) => {
      this.appendAssistant(text)
    })
    p.on('thinking', ({ text }: { text: string }) => {
      this.appendThinking(text)
    })
    p.on('tool_use', ({ id, name, input }: { id: string; name: string; input: any }) => {
      this.addTool(id, name, input)
    })
    p.on('tool_result', ({ tool_use_id, content, is_error }: any) => {
      this.completeTool(tool_use_id, content, is_error)
    })
    p.on('can_use_tool', (req: CanUseToolRequest) => {
      this.renderPermission(req)
    })
    p.on('hook_callback', (req: HookCallbackRequest) => {
      // No hooks registered → fail-safe ack.
      this.proc?.sendHookResponse(req.request_id, {})
    })
    p.on('result', () => {
      this.accumulateResultStats()
      void this.closeTurnCard()
      this.status = 'idle'
    })
    p.on('exit', ({ code, signal, expected }: any) => {
      log(`session "${this.sessionName}": claude exited code=${code} signal=${signal} expected=${expected}`)
      this.proc = null
      this.currentTurn = null
      this.status = 'stopped'
      if (!expected && code !== 0 && signal !== 'SIGTERM') {
        void feishu.sendText(this.chatId, `⚠️ Claude 异常退出 (code=${code}, signal=${signal})。回复任意消息将重新启动。`)
      }
    })
  }

  /** Pull per-turn numbers off `proc.lastResult` (set by ClaudeProcess when
   * the `result` message landed) and roll them into cumStats + the
   * "上一轮" delta. Called exactly once per result event, right before
   * closeTurnCard. */
  private accumulateResultStats(): void {
    const r = this.proc?.lastResult
    if (!r) return
    const u = r.usage ?? {}
    const inputTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
    const outputTokens = u.output_tokens ?? 0
    const tokens = inputTokens + outputTokens
    const costUsd = r.cost_usd ?? 0
    const durationMs = r.duration_ms ?? 0
    this.cumStats.tokens += tokens
    this.cumStats.costUsd += costUsd
    this.cumStats.turns += r.num_turns ?? 1
    this.lastTurnDelta = { tokens, costUsd, durationMs, inputTokens }
  }

  /** Current context-window occupancy estimate — uses the most recent
   * assistant `usage` (input + caches), since each assistant reply replays
   * the full conversation. Falls back to the last-turn delta when no
   * assistant message has streamed yet this process. */
  private currentContextTokens(): number {
    const u = this.proc?.lastUsage as ClaudeUsage | null | undefined
    if (u) {
      return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
    }
    return this.lastTurnDelta?.inputTokens ?? 0
  }

  private async openTurnCard(userText: string): Promise<void> {
    const turn = ++this.turnCounter
    const card = cards.mainConversationCard({
      sessionName: this.sessionName,
      turn,
      effort: 'max',
      userText,
    })
    const messageId = await feishu.sendCard(this.chatId, card)
    if (!messageId) { log(`session "${this.sessionName}": openTurnCard sendCard failed`); return }
    let cardId: string
    try { cardId = await cardkit.convertMessageToCard(messageId) }
    catch (e) { log(`session "${this.sessionName}": id_convert failed: ${e}`); return }
    this.currentTurn = {
      cardId,
      userText,
      thinkingText: '',
      toolCount: 0,
      toolByUseId: new Map(),
      assistantSegmentCount: 0,
      currentAssistantSegmentId: null,
      currentAssistantText: '',
      segmentTexts: new Map(),
      startedAt: Date.now(),
    }
  }

  // Stream-event handlers are intentionally SYNCHRONOUS. Every cardkit op
  // is queued (per-card Promise chain in cardkit.ts), so we fire-and-
  // forget here and rely on enqueue source order — that way no `await`
  // can yield mid-handler and let `closeTurnCard` (or another event) race
  // and mutate `this.currentTurn` underfoot.
  private appendAssistant(delta: string): void {
    if (!this.currentTurn) return
    if (!this.currentTurn.currentAssistantSegmentId) {
      const i = this.currentTurn.assistantSegmentCount++
      const segId = cards.ELEMENTS.assistant(i)
      this.currentTurn.currentAssistantSegmentId = segId
      this.currentTurn.currentAssistantText = ''
      void cardkit.addElement(this.currentTurn.cardId, cards.assistantSegmentElement(i), {
        type: 'insert_before', targetElementId: cards.ELEMENTS.footer,
      })
    }
    this.currentTurn.currentAssistantText += delta
    const segId = this.currentTurn.currentAssistantSegmentId
    this.currentTurn.segmentTexts.set(segId, this.currentTurn.currentAssistantText)
    cardkit.streamTextThrottled(
      this.currentTurn.cardId,
      segId,
      this.currentTurn.currentAssistantText,
    )
  }

  private appendThinking(delta: string): void {
    if (!this.currentTurn) return
    this.currentTurn.thinkingText += delta
    cardkit.streamTextThrottled(
      this.currentTurn.cardId,
      cards.ELEMENTS.thinking,
      this.currentTurn.thinkingText,
    )
  }

  private isTaskWorkflow(name: string): boolean {
    return name.startsWith('Task') && name !== 'Task'
  }

  private todosArray(): cards.Todo[] {
    return [...this.currentTodos.values()]
  }

  private addTool(toolUseId: string, name: string, input: any): void {
    if (!this.currentTurn) return
    // Close current assistant segment (if any) so the tool panel renders
    // AFTER it in card body order. Flush queues the segment's last
    // buffered delta before the tool element is inserted.
    if (this.currentTurn.currentAssistantSegmentId) {
      void cardkit.flush(this.currentTurn.cardId)
      this.currentTurn.currentAssistantSegmentId = null
      this.currentTurn.currentAssistantText = ''
    }
    const i = this.currentTurn.toolCount++
    this.currentTurn.toolByUseId.set(toolUseId, { i, name, input })
    // Pending Task* panels still show the *pre-op* todo mirror so users
    // can read the current state immediately, without waiting for the
    // tool to return.
    const todos = this.isTaskWorkflow(name) ? this.todosArray() : undefined
    const el = cards.toolCallElement(i, name, input, null, '⏳', undefined, todos)
    void cardkit.addElement(this.currentTurn.cardId, el, {
      type: 'insert_before',
      targetElementId: cards.ELEMENTS.footer,
    })
  }

  private completeTool(toolUseId: string, content: any, isError: boolean): void {
    if (!this.currentTurn) return
    const meta = this.currentTurn.toolByUseId.get(toolUseId)
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
    // Update the local todo mirror BEFORE rendering so the just-
    // completed panel shows the new state too (e.g. a TaskCreate panel
    // already lists the task it just created).
    if (!isError && this.isTaskWorkflow(meta.name)) {
      this.updateTodosFromTask(meta.name, meta.input, output)
    }
    const todos = this.isTaskWorkflow(meta.name) ? this.todosArray() : undefined
    const el = cards.toolCallElement(meta.i, meta.name, meta.input, output, isError ? '❌' : '✅', meta.resolvedNote, todos)
    void cardkit.replaceElement(this.currentTurn.cardId, cards.ELEMENTS.tool(meta.i), el)
    // Cascade the new mirror into every prior Task* panel in this turn
    // so any expanded panel reflects the latest state, not the snapshot
    // captured when that op ran.
    if (!isError && this.isTaskWorkflow(meta.name)) {
      this.refreshOtherTaskPanels(toolUseId)
    }
  }

  /** Roll a single Task* op into the local mirror — best-effort. Output
   * parsing is regex-based (the SDK returns plain text like "Task #7
   * created successfully: …"), so unexpected variants are skipped
   * silently rather than blowing up the panel render. */
  private updateTodosFromTask(name: string, input: any, output: string): void {
    switch (name) {
      case 'TaskCreate': {
        const m = output.match(/Task #(\d+) created/)
        if (!m) return
        const id = Number(m[1])
        this.currentTodos.set(id, {
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
        if (input.status === 'deleted') { this.currentTodos.delete(id); return }
        const cur = this.currentTodos.get(id) ?? { id, status: 'pending' as const }
        if (input.status)      cur.status = input.status
        if (input.subject)     cur.subject = input.subject
        if (input.description) cur.description = input.description
        if (input.owner)       cur.owner = input.owner
        if (input.activeForm)  cur.activeForm = input.activeForm
        this.currentTodos.set(id, cur)
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
  private refreshOtherTaskPanels(skipToolUseId: string): void {
    if (!this.currentTurn) return
    const todos = this.todosArray()
    for (const [id, meta] of this.currentTurn.toolByUseId) {
      if (id === skipToolUseId) continue
      if (!this.isTaskWorkflow(meta.name)) continue
      const status: '⏳' | '✅' | '❌' = meta.output === undefined
        ? '⏳'
        : (meta.isError ? '❌' : '✅')
      const el = cards.toolCallElement(
        meta.i, meta.name, meta.input, meta.output ?? null,
        status, meta.resolvedNote, todos,
      )
      void cardkit.replaceElement(this.currentTurn.cardId, cards.ELEMENTS.tool(meta.i), el)
    }
  }

  /** Merge the permission ask into the existing tool element in the
   * current turn card. The user sees one continuous timeline: ⏳ pending
   * → 🔐 awaiting approval (with buttons) → ⏳ allowed / ❌ denied → ✅
   * with output. No floating orange card.
   *
   * `tool_use` is emitted as part of the assistant message and lands on
   * our `addTool` handler BEFORE the SDK's `can_use_tool` control_request
   * arrives — so by the time we get here, `toolByUseId` already has the
   * entry we need to replace.
   *
   * Edge cases (no current turn / missing tool_use_id / unknown id) are
   * surfaced loudly and auto-denied. We don't fall back to a standalone
   * card — per the project's no-fallbacks rule, hidden anomalies are
   * worse than visible deny errors. */
  private renderPermission(req: CanUseToolRequest): void {
    const turn = this.currentTurn
    if (!turn) {
      log(`session "${this.sessionName}": can_use_tool with no current turn — auto-deny req=${req.request_id}`)
      this.proc?.sendPermissionResponse(req.request_id, 'deny', { denyMessage: 'no active turn' })
      return
    }
    const toolUseId = req.tool_use_id
    if (!toolUseId) {
      log(`session "${this.sessionName}": can_use_tool without tool_use_id — auto-deny req=${req.request_id}`)
      this.proc?.sendPermissionResponse(req.request_id, 'deny', { denyMessage: 'no tool_use_id' })
      return
    }
    const meta = turn.toolByUseId.get(toolUseId)
    if (!meta) {
      log(`session "${this.sessionName}": can_use_tool for unknown tool_use_id=${toolUseId} — auto-deny req=${req.request_id}`)
      this.proc?.sendPermissionResponse(req.request_id, 'deny', { denyMessage: 'unknown tool_use_id' })
      return
    }
    this.status = 'awaiting_permission'
    this.pendingPermissions.set(req.request_id, { toolUseId })
    const el = cards.toolCallPermissionElement(meta.i, meta.name, meta.input, req.request_id)
    void cardkit.replaceElement(turn.cardId, cards.ELEMENTS.tool(meta.i), el)
  }

  private async closeTurnCard(suffix?: string): Promise<void> {
    // CRITICAL: capture-and-null in a single synchronous block at entry
    // so a parallel `closeTurnCard` (e.g. result event firing while
    // onUserMessage is awaiting an interrupt) can't double-process the
    // same turn — second caller observes null and bails. The promised
    // sync-handler invariant only protects callers that take the turn
    // off the table BEFORE their first await.
    const turn = this.currentTurn
    if (!turn) return
    this.currentTurn = null
    const elapsed = ((Date.now() - turn.startedAt) / 1000).toFixed(1)
    const cardId = turn.cardId
    const thinkingText = turn.thinkingText
    const segmentTexts = turn.segmentTexts
    await cardkit.flush(cardId)

    // [[send: /abs/path]] markers — strip them from each assistant
    // segment and collect paths to upload after the card finalizes.
    const sendPaths: string[] = []
    for (const [segId, fullText] of segmentTexts) {
      let changed = false
      const cleaned = fullText.replace(SEND_MARKER_RE, (_m, p1) => {
        changed = true
        const p = String(p1).trim()
        if (p.startsWith('/')) sendPaths.push(p)
        else log(`session "${this.sessionName}": ignore non-absolute send path: ${p}`)
        return ''
      })
      if (changed) {
        const finalText = cleaned.trim() || ' '
        await cardkit.replaceElement(cardId, segId, {
          tag: 'markdown', element_id: segId, content: finalText,
        })
      }
    }

    if (thinkingText.trim()) {
      await cardkit.replaceElement(cardId, cards.ELEMENTS.thinking, cards.thinkingCollapsedPanel(thinkingText))
    }
    const sendNote = sendPaths.length ? ` · 📎 ${sendPaths.length}` : ''
    const footer = `⏱ ${elapsed}s${suffix ? ' · ' + suffix : ''}${sendNote} · ✅ done`
    await cardkit.streamText(cardId, cards.ELEMENTS.footer, footer)
    await cardkit.patchSettings(cardId, cards.STREAMING_OFF_SETTINGS)
    await cardkit.dispose(cardId)

    // Fire uploads sequentially AFTER the card is sealed so each file
    // posts as its own Feishu message below the conversation card.
    // Path gate: workDir (Claude's project sandbox), the inbox where
    // user-uploaded attachments land, and the /tmp/lodestar- namespace
    // for ad-hoc artifacts.  Anything outside is refused — see
    // feishu.isPathAllowed.
    const allowedRoots = [this.workDir, INBOX_DIR, '/tmp/lodestar-']
    for (const p of sendPaths) {
      await feishu.uploadAndSend(this.chatId, p, allowedRoots)
    }
  }
}
