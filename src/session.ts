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
import { ClaudeProcess, type CanUseToolRequest, type HookCallbackRequest } from './claude-process'
import { CHANNEL_INSTRUCTIONS } from './instructions'
import * as cardkit from './cardkit'
import * as cards from './cards'
import * as feishu from './feishu'
import { log } from './log'

interface TurnState {
  cardId: string
  userText: string
  thinkingText: string
  toolCount: number
  toolByUseId: Map<string, { i: number; name: string; input: any }>
  assistantSegmentCount: number
  currentAssistantSegmentId: string | null
  currentAssistantText: string
  // Per-assistant-segment cumulative text — used at turn close to strip
  // [[send: /path]] markers and replace each segment with a cleaned
  // version, then post the files as separate Feishu messages.
  segmentTexts: Map<string, string>
  pendingSends: string[]
  startedAt: number
}

const SEND_MARKER_RE = /\[\[send:\s*([^\]\n]+?)\s*\]\]/g

type Status = 'idle' | 'working' | 'awaiting_permission' | 'starting' | 'stopped'

export interface SessionOpts {
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
}

export class Session {
  private proc: ClaudeProcess | null = null
  private currentTurn: TurnState | null = null
  private pendingPermissions = new Map<string, { messageId: string; toolName: string }>()
  private turnCounter = 0
  // Last seen sessionId — preserved across `kill`/`stop` so a later
  // `restart` can resume the same Claude conversation even after the
  // child process is gone.
  private lastSessionId: string | null = null
  private startedAt: number = 0
  status: Status = 'stopped'

  constructor(
    public readonly sessionName: string,
    public readonly chatId: string,
    private opts: SessionOpts = {},
  ) {}

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
      permissionMode: this.opts.permissionMode ?? 'default',
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
    if (resume && prevSessionId) {
      this.proc = new ClaudeProcess({
        workDir: this.workDir,
        effort: 'max',
        permissionMode: 'default',
        resumeSessionId: prevSessionId,
        appendSystemPrompt: CHANNEL_INSTRUCTIONS,
      })
      this.wireProc(this.proc)
      this.proc.sendInitialize({})
      this.status = 'idle'
      this.startedAt = Date.now()
      await feishu.sendText(this.chatId, `🔁 已重启并恢复 session=${prevSessionId.slice(0, 8)}…`)
    } else {
      await this.start()
    }
  }

  /** Run a user-typed control command. Returns true if the command was
   * consumed (don't forward to Claude). Matched exactly, case-insensitive. */
  async runCommand(cmd: string): Promise<boolean> {
    switch (cmd.toLowerCase()) {
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
    const uptime = this.startedAt
      ? `${Math.round((Date.now() - this.startedAt) / 1000)}s`
      : undefined
    const card = cards.consoleCard({
      sessionName: this.sessionName,
      status: this.status,
      effort: 'max',
      uptime,
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

    const resolved = cards.permissionResolvedCard(pending.toolName, decision, user)
    await feishu.patchCardMessage(pending.messageId, resolved)

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
      case 'ls':        await feishu.sendText(this.chatId, `📁 ${this.workDir}`); break
    }
  }

  // ── Wiring Claude → Feishu ─────────────────────────────────────────
  private wireProc(p: ClaudeProcess): void {
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
      void this.renderPermission(req)
    })
    p.on('hook_callback', (req: HookCallbackRequest) => {
      // No hooks registered → fail-safe ack.
      this.proc?.sendHookResponse(req.request_id, {})
    })
    p.on('result', () => {
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
      pendingSends: [],
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
    const el = cards.toolCallElement(i, name, input, null, '⏳')
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
    const el = cards.toolCallElement(meta.i, meta.name, meta.input, output, isError ? '❌' : '✅')
    void cardkit.replaceElement(this.currentTurn.cardId, cards.ELEMENTS.tool(meta.i), el)
  }

  private async renderPermission(req: CanUseToolRequest): Promise<void> {
    this.status = 'awaiting_permission'
    const card = cards.permissionCard({
      sessionName: this.sessionName,
      toolName: req.tool_name,
      description: `工具 \`${req.tool_name}\` 想在 ~/${this.sessionName} 执行操作`,
      inputPreview: JSON.stringify(req.input ?? {}),
      requestId: req.request_id,
    })
    const messageId = await feishu.sendCard(this.chatId, card)
    if (!messageId) {
      log(`session "${this.sessionName}": permission card send failed; auto-deny`)
      this.proc?.sendPermissionResponse(req.request_id, 'deny')
      return
    }
    this.pendingPermissions.set(req.request_id, { messageId, toolName: req.tool_name })
  }

  private async closeTurnCard(suffix?: string): Promise<void> {
    if (!this.currentTurn) return
    const elapsed = ((Date.now() - this.currentTurn.startedAt) / 1000).toFixed(1)
    const cardId = this.currentTurn.cardId
    const thinkingText = this.currentTurn.thinkingText
    const segmentTexts = this.currentTurn.segmentTexts
    this.currentTurn = null
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
    for (const p of sendPaths) {
      await feishu.uploadAndSend(this.chatId, p)
    }
  }
}
