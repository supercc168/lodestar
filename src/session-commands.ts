import type { Session } from './session'
import * as feishu from './feishu'
import { formatFeishuError } from './feishu-errors'
import { log, logError } from './log'
import { clearGsdAwaitingName, isGsdBareword, runGsdTextCommand } from './session-gsd'
import { diagnosticIdLabel, messageOf } from './session-util'

type ControlCommand = 'hi' | 'stop' | 'kill' | 'restart' | 'clear' | 'compact' | 'model'

const CONTROL_COMMAND_ALIASES = new Map<string, ControlCommand>([
  ['hi', 'hi'],
  ['stop', 'stop'], ['st', 'stop'],
  ['kill', 'kill'], ['kl', 'kill'],
  ['restart', 'restart'], ['rs', 'restart'],
  ['clear', 'clear'], ['cl', 'clear'],
  ['compact', 'compact'], ['cm', 'compact'],
  ['model', 'model'], ['md', 'model'],
])

/**
 * True when `raw` is a reserved control bareword (or wt/agy with args) that
 * runCommand will consume. Used so awaiting_name is cancelled before the
 * control side-effects run.
 */
function isControlCommandText(raw: string): boolean {
  const t = raw.trim()
  if (!t) return false
  if (/^(?:wt|worktree)(?:\s+.*)?$/i.test(t)) return true
  if (/^btw$/i.test(t)) return true
  if (/^bye$/i.test(t)) return true
  if (/^(?:fk|fork)$/i.test(t)) return true
  if (/^(?:bk|back)$/i.test(t)) return true
  if (/^agy(?:\s+[\s\S]*)?$/i.test(t)) return true
  if (/^(?:agents|agent)$/i.test(t)) return true
  if (t.toLowerCase() === 'task') return true
  if (isGsdBareword(t)) return true
  return CONTROL_COMMAND_ALIASES.has(t.toLowerCase())
}

const sourceCommandWork = new Set<Promise<void>>()

function backgroundSourceCommand(s: Session, work: Promise<void>): void {
  const tracked = work.catch(async error => {
    const message = `账号操作或结果呈现失败：${messageOf(error)}`
    logError('session-commands: account operation failed', error)
    await feishu.sendTextRaw(s.chatId, `❌ ${message}`)
    throw error
  })
  sourceCommandWork.add(tracked)
  void tracked.finally(() => sourceCommandWork.delete(tracked)).catch(error => logError('session-commands: account operation result delivery failed', error))
}

export function pendingSourceCommands(): Promise<void>[] { return [...sourceCommandWork] }

/** Run a bare-text control command (`hi`, `stop`, `kill`, `restart`, `clear`, `compact`, `model`, `task`)
 * plus their two-letter aliases where applicable.
 * Returns true if the command was consumed (don't forward to Codex).
 * Exact match, case-insensitive, ignores trailing whitespace.
 *
 * Trade-off (user-confirmed 2026-05-15): these words are reserved
 * globally — typing "hi" as a literal greeting will show the console
 * card instead of reaching Codex. The ergonomic win (no slash, no
 * shift key, one-handed phone use) outweighs the collision in this
 * product's private-bot use case. `stop` was added 2026-05-15 once
 * auto-interrupt on mid-turn user messages was removed (matching
 * Codex's native type-ahead behavior) — explicit barge-out
 * needed a knob and `kill` (full subprocess teardown) is too heavy. */
export async function runCommand(s: Session, raw: string, userOpenId = '', messageId?: string): Promise<boolean> {
  // Spec: explicit non-task control commands cancel awaiting_name.
  // Daemon routes controls here before onUserMessage / maybeConsumeGsdTaskName,
  // so clear on every consumed control (including bare `gsd` panel open).
  if (isControlCommandText(raw)) {
    clearGsdAwaitingName(s)
  }

  const namedHi = raw.trim().match(/^hi[ \t]+([^\r\n]+)$/i)
  if (namedHi) {
    if (s.currentProvider() === 'claude') {
      const { runClaudeNamedHi } = await import('./session-claude-accounts')
      backgroundSourceCommand(s, runClaudeNamedHi(s, namedHi[1].trim()))
      return true
    }
    const { runCodexNamedHi } = await import('./session-codex-accounts')
    await runCodexNamedHi(s, namedHi[1].trim())
    return true
  }
  const accountCommand = raw.trim().match(/^codex-(login-cancel|login|accounts|account-delete|account|auto|reset)(?:[ \t]+([^\r\n]+))?$/i)
  if (accountCommand) {
    const { runCodexAccountCommand } = await import('./session-codex-accounts')
    const command = accountCommand[1].toLowerCase()
    const work = runCodexAccountCommand(s, command, (accountCommand[2] ?? '').trim(), userOpenId, messageId)
    if (command === 'login' || command === 'reset') backgroundSourceCommand(s, work)
    else await work
    return true
  }
  const subscription = raw.trim().match(/^claude-sub(?:[ \t]+([^\r\n]+))?$/i)
  if (subscription) {
    const { runClaudeSubscriptionCommand } = await import('./token-source-setup')
    await runClaudeSubscriptionCommand(s, (subscription[1] ?? '').trim().toLowerCase())
    return true
  }
  const wt = raw.trim().match(/^(?:wt|worktree)(?:\s+(.+))?$/i)
  if (wt) {
    // 本地守卫保留(上游随 agy 系统移除而删,本地 agy 仍在):agy 独占期拒绝 wt。
    if (s.startingAgy || s.runningAgy) {
      await feishu.sendText(s.chatId, '⏳ agy 任务正在执行；请等待完成，或发送 stop 打断后再使用 wt。')
      return true
    }
    await s.runWorktreeCommand((wt[1] ?? '').trim(), userOpenId)
    return true
  }
  // btw = 开临时会话(同目录,自动启动);bye = 散临时群;fk/fork = 列当前会话 turn 分叉;
  // bk/back = 列 turn;点选并通过 owner/stale 校验后才终止并切到新分支(上游 ff44afb)。
  if (raw.trim().match(/^btw$/i)) {
    // 本地守卫保留(同 wt):agy 独占期拒绝 btw。
    if (s.startingAgy || s.runningAgy) { await feishu.sendText(s.chatId, '⏳ agy 任务正在执行；请等待完成，或发送 stop 打断后再使用 btw。'); return true }
    await s.runBtwCommand(userOpenId)
    return true
  }
  if (raw.trim().match(/^bye$/i)) {
    await s.runByeCommand()
    return true
  }
  if (raw.trim().match(/^(?:fk|fork)$/i)) {
    if (s.startingAgy || s.runningAgy) { await feishu.sendText(s.chatId, '⏳ agy 任务正在执行；请等待完成，或发送 stop 打断后再使用 fk。'); return true }
    await s.showForkList(userOpenId)
    return true
  }
  if (raw.trim().match(/^(?:bk|back)$/i)) {
    // 本地守卫保留:watchdog 保留恢复期与 agy 独占期拒绝 bk(叠加在上游语义之上)。
    if (s.hasPreservedWatchdogRecovery()) {
      await feishu.sendText(s.chatId, '⚠️ thread 自动恢复尚未完成，暂不能回滚。请先发送 restart 恢复，或 clear/kill 丢弃。')
      return true
    }
    if (s.startingAgy || s.runningAgy) { await feishu.sendText(s.chatId, '⏳ agy 任务正在执行；请等待完成，或发送 stop 打断后再使用 bk。'); return true }
    // 只展示选择卡,不取 lifecycle;真正的 stop→fork 在点击具体锚点并通过
    // owner/provider/cwd 校验之后发生,避免用户看完不点也被提前终止(上游 ff44afb)。
    await s.showBackList(userOpenId)
    return true
  }
  const agy = raw.trim().match(/^agy(?:\s+([\s\S]+))?$/i)
  if (agy) {
    await s.runAgyCommand((agy[1] ?? '').trim())
    return true
  }
  if (raw.trim().match(/^(?:agents|agent)$/i)) {
    await s.showAgentIdentityPanel(userOpenId)
    return true
  }
  if (raw.trim().toLowerCase() === 'task') {
    await s.showTasklistPanel()
    return true
  }
  if (isGsdBareword(raw)) {
    await runGsdTextCommand(s, raw)
    return true
  }
  const relaySetup = raw.trim().match(/^relay-setup(?:\s+([\s\S]+))?$/i)
  if (relaySetup) {
    const { runRelaySetup } = await import('./relay-setup')
    backgroundSourceCommand(s, runRelaySetup(s, (relaySetup[1] ?? '').trim()))
    return true
  }
  const relayBalanceSetup = raw.trim().match(/^relay-balance-setup(?:\s+([\s\S]+))?$/i)
  if (relayBalanceSetup) {
    const { runRelayBalanceSetup } = await import('./relay-setup')
    backgroundSourceCommand(s, runRelayBalanceSetup(s, (relayBalanceSetup[1] ?? '').trim()))
    return true
  }
  // <source>-setup <args> —— 启用某 token source(generic:路由到 source factory 的 setup.parseArgs,
  // 加新 source 不改本文件 —— 在 token-source-<name>.ts 声明 setup 字段即自动接入)。
  const tsSetup = raw.trim().match(/^([\w-]+)-setup(?:\s+([\s\S]+))?$/i)
  if (tsSetup) {
    const { runTokenSourceSetup } = await import('./token-source-setup')
    backgroundSourceCommand(s, runTokenSourceSetup(s, tsSetup[1].trim().toLowerCase(), (tsSetup[2] ?? '').trim()))
    return true
  }
  const command = CONTROL_COMMAND_ALIASES.get(raw.trim().toLowerCase())
  if (!command) return false
  // 本地守卫保留(上游随 agy 系统移除而删,本地 agy 仍在):agy 独占期只放行白名单控制命令。
  if ((s.startingAgy || s.runningAgy) && !['stop', 'kill', 'restart', 'hi', 'model'].includes(command)) {
    await feishu.sendText(s.chatId, `⏳ agy 任务正在执行；请等待完成，或发送 stop 打断后再执行 ${command}。`)
    return true
  }
  switch (command) {
    case 'model':
      await s.showModelPanel()
      return true
    case 'compact':
      await s.runCompactCommand()
      return true
    case 'hi':
      {
        const lease = s.beginLifecycle('hi')
        if (s.watchdogResumeFailed) {
          await feishu.sendText(
            s.chatId,
            '⚠️ thread 自动恢复失败，消息仍已保留。发送 restart 恢复同一 thread；发送 clear 或 kill 可主动丢弃。',
          )
          return true
        }
        const needsStart = !s.isRunning()
        const backend = s.backendLabel()
        const statusCard = needsStart
          ? await s.openStatusCard('hi', s.withModel(`🚀 启动 ${backend}`))
          : null
        if (!s.ownsLifecycle(lease)) return true
        let lastStatus = s.withModel(`🚀 启动 ${backend}`)
        const ok = needsStart
          ? await s.start({
              announce: !statusCard,
              lifecycleLease: lease,
              onStatus: status => {
                lastStatus = status
                s.setStatusCard(statusCard, status)
              },
            })
          : true
        if (!s.ownsLifecycle(lease)) return true
        if (!ok) {
          await s.closeStatusCard(statusCard, lastStatus.startsWith('❌') ? lastStatus : '❌ 启动失败')
          return true
        }
        if (s.proc?.turnRetry?.reason === 'quota') {
          const waiting = '⏳ 等待额度恢复 · 可用后自动启动，stop 可取消'
          if (statusCard) await s.closeStatusCard(statusCard, waiting)
          else {
            const { codexAccountCard } = await import('./cards/codex-account')
            let failure: unknown
            if (!await feishu.sendCard(s.chatId, codexAccountCard({ phase: 'checking', title: '等待额度', message: waiting }), error => { failure = error })) {
              throw new Error(`额度等待卡片发送失败\n${formatFeishuError(failure)}`)
            }
          }
          return true
        }
        if (statusCard) {
          await s.replaceStatusCardWithConsole(
            statusCard,
            s.withModel(s.withWorktreeInstructionNotice(`✅ ${s.backendLabel()} 已就绪`)),
          )
          return true
        }
        if (needsStart) {
          await s.closeStatusCard(
            statusCard,
            s.withModel(s.withWorktreeInstructionNotice(`✅ ${s.backendLabel()} 已就绪`)),
          )
        }
        if (s.ownsLifecycle(lease)) await s.showConsole()
      }
      return true
    case 'stop':
      {
      const lease = s.beginLifecycle('soft_stop')
      const preserveRecovery = s.hasPreservedWatchdogRecovery()
      const cancelledFiles = s.cancelFileDeliveries('用户停止了任务')
      if (s.runningAgy) {
        await s.cancelAgentRuns('stop command')
        await s.stopAgyTask('🛑 agy 已打断')
        return true
      }
      await s.cancelAgentRuns('stop command')
      if (s.proc?.turnRetry?.reason === 'quota') {
        const card = await s.openStatusCard('stop', '🛑 停止额度等待')
        try {
          await s.stop('已取消额度恢复', { announce: !card, onStatus: value => s.setStatusCard(card, value) })
          await s.closeStatusCard(card, '🛑 已取消额度恢复')
        } catch (error) { await s.closeStatusCard(card, `❌ ${messageOf(error)}`); throw error }
        return true
      }
      // Soft barge-out: interrupt the current turn (if any) AND drop
      // the pending-message count so a stack of type-ahead doesn't
      // refire after the interrupt. Subprocess stays alive. Note: the
      // SDK keeps its OWN internal queue of the user-text frames we
      // already sendText'd — interrupt should also flush that side,
      // but the daemon can't reach into it directly; in practice the
      // sendInterrupt() control_request causes the SDK to discard
      // queued input alongside the in-flight call.
      if (!preserveRecovery) {
        s.clearStaleIdleQueueState('stop')
        s.clearMultiMsgBuffer('stop command')
      }
      if (preserveRecovery && !s.currentTurn) {
        await feishu.sendText(s.chatId, '🛑 已停止自动恢复尝试；原 thread 和排队消息仍保留，可发送 restart 继续。')
        return true
      }
      if (!s.currentTurn && s.pendingUserMessageCount === 0 && s.pendingMidTurnMsgs.length === 0) {
        if (cancelledFiles) {
          await s.closeTurnCard('🛑 已取消未完成的文件上传')
          await feishu.sendText(s.chatId, '🛑 已取消未完成的文件上传，已上传文件保留')
          return true
        }
        const statusCard = await s.openStatusCard('stop', '⚪ 当前没有正在执行的 turn', 'grey')
        if (!s.ownsLifecycle(lease)) return true
        if (statusCard) {
          await s.closeStatusCard(statusCard, '⚪ 无正在执行的 turn')
        } else {
          await feishu.sendText(s.chatId, '⚪ 当前没有正在执行的 turn')
        }
        if (!s.ownsLifecycle(lease)) return true
        return true
      }
      // Cancelled queued msgs: remove the OneSecond (no longer waiting)
      // and stamp a CrossMark (explicit cancelled state, distinct from
      // a natural release where reactions just disappear). Cancelled
      // mid-batch msgs get the same treatment.
      // 用 `seen` Set 去重 —— mid-turn buffer 跟 pendingReactionIds 的
      // msgId 重叠(onUserMessage 进 buffer 时同时 trackReaction),
      // 两次 addReaction(CrossMark) 会在飞书侧渲染两个 ❌ (P0-1)。
      if (!preserveRecovery) {
        const seen = new Set<string>()
        for (const [msgId, rid] of [
          ...s.pendingReactionIds.entries(),
          ...s.currentBatchReactionIds.entries(),
        ]) {
          if (rid) void feishu.deleteReaction(msgId, rid)
          void feishu.addReaction(msgId, 'CrossMark')
          seen.add(msgId)
        }
        // Mid-turn buffer never reached SDK — cancel those too.
        for (const msg of s.pendingMidTurnMsgs) {
          if (msg.msgId && !seen.has(msg.msgId)) void feishu.addReaction(msg.msgId, 'CrossMark')
        }
        s.pendingUserMessageCount = 0
        s.pendingMidTurnMsgs = []
        s.pendingTurnInputs = []
        s.lastUserOpenId = ''
        s.pendingReactionIds = new Map()
        s.currentBatchReactionIds = new Map()
      }
      const interrupt = s.beginTurnInterrupt('user')
      if (!interrupt) log('session-commands.stop_no_live_process')
      // 主动封口,把 footer 改成 🛑 打断、停止 footer 状态计时、把 streaming_mode
      // 翻回 false,否则卡片会僵在运行中状态。SDK 的 post-interrupt
      // result 也会进 closeTurnCard,但 currentTurn 已被这里置空,那条
      // 路径会 early-return,不会重画 footer。
      await s.closeTurnCard('🛑 打断', { preservePendingReactions: preserveRecovery })
      return true
      }
    case 'kill':
      {
        const lease = s.beginLifecycle('kill')
        if (s.runningAgy) await s.stopAgyTask('🛑 agy 已终止')
        if (!s.ownsLifecycle(lease)) return true
        const wasRunning = s.isRunning()
        const backend = s.backendLabel(s.proc?.provider ?? s.currentProvider())
        const initialStatus = wasRunning ? `🛑 停止 ${backend}` : '⚪ session 当前未运行'
        const statusCard = await s.openStatusCard('kill', initialStatus, wasRunning ? 'red' : 'grey')
        if (!s.ownsLifecycle(lease)) return true
        let stopError: unknown = null
        let finalStatus = wasRunning ? `✅ ${backend} 已终止` : `⚪ ${backend} 未运行`
        try {
          await s.stop('已终止', {
            announce: !statusCard,
            lifecycleLease: lease,
            onStatus: status => {
              s.setStatusCard(statusCard, status)
            },
          })
        } catch (e) {
          stopError = e
          finalStatus = s.isRunning()
            ? `❌ ${backend} 未确认终止: ${messageOf(e)}；会话已阻断，请重试 kill/restart 或等待旧进程退出`
            : `❌ ${backend} 停止收尾失败: ${messageOf(e)}`
        }
        if (!s.ownsLifecycle(lease)) return true
        try {
          await s.closeStatusCard(statusCard, finalStatus)
        } catch (e) {
          logError('session-commands.kill_card_close_failed', e)
          await feishu.sendTextRaw(s.chatId, `${finalStatus}\n⚠️ kill 状态卡片终态写入失败: ${messageOf(e)}`)
        }
        // openStatusCard already provides the visible failure when present. If
        // card creation failed, stop() had no chance to announce after throwing,
        // so preserve error transparency with a raw text receipt.
        if (stopError && !statusCard) await feishu.sendTextRaw(s.chatId, finalStatus)
      }
      return true
    case 'restart':
      {
      const lease = s.beginLifecycle(s.watchdogResumeFailed ? 'strict-retry' : 'restart')
      // rs 双模式:会话进行中 = 打断 + 弃后台 + 恢复(走下面 restart(true));空闲 =
      // 双后端列同 cwd 历史并从所选会话创建独立分支(上游 ff44afb 门控解除:
      // Claude 扫 transcript,Codex 走 thread/list;plain resume→history fork)。
      // 空闲判定用「无进行中 turn」语义,与上面 stop 命令对齐 —— 不能用
      // !isRunning():isRunning() 判的是进程存活,而 claude 进程 turn 间常驻保活
      // (stop 故意 "Subprocess stays alive"),stop 后仍为 true,会让列表分支永远
      // 不可达(实测踩中,见 session.test.ts)。port of upstream d9341b6 idle 语义
      // (非 !isRunning(),陷阱 1)+ ff44afb 双后端列表。
      if (s.watchdogResumeFailed) {
        const initialStatus = '🔁 恢复失败 thread 并发送已保留消息'
        const statusCard = await s.openStatusCard('restart', initialStatus)
        if (!s.ownsLifecycle(lease)) return true
        let lastStatus = initialStatus
        const ok = await s.resumeFailedWatchdogQueue({
          announce: !statusCard,
          lifecycleLease: lease,
          onStatus: status => {
            lastStatus = status
            s.setStatusCard(statusCard, status)
          },
        })
        if (!s.ownsLifecycle(lease)) return true
        await s.closeStatusCard(
          statusCard,
          ok
            ? s.withModel('✅ thread 已恢复，已保留消息开始执行')
            : (lastStatus.startsWith('❌') ? lastStatus : '❌ thread 恢复失败，消息仍已保留'),
        )
        return true
      }
      if (
        !s.currentTurn
        && s.pendingUserMessageCount === 0
        && s.pendingMidTurnMsgs.length === 0
      ) {
        await s.showResumeList(userOpenId)
        return true
      }
      // 进行中:resume the prior conversation — kills the current proc and
      // spawns a new one with `--resume <lastSessionId>`(放弃后台进程)。
      {
        const resumeThreadLabel = s.lastSessionId ? diagnosticIdLabel(s.lastSessionId) : ''
        const backend = s.backendLabel(s.proc?.provider ?? s.currentProvider())
        const initialStatus = s.isRunning()
          ? s.withModel(`🔁 重启 ${backend}`)
          : resumeThreadLabel
            ? s.withModel(`🔁 恢复上一会话 thread=${resumeThreadLabel}`)
            : s.withModel(`🔁 启动 ${backend}`)
        const statusCard = await s.openStatusCard('restart', initialStatus)
        if (!s.ownsLifecycle(lease)) return true
        await s.cancelAgentRuns('restart command')
        if (s.runningAgy) {
          s.setStatusCard(statusCard, '🛑 restart 前终止 agy')
          await s.stopAgyTask('🛑 restart 前已终止 agy')
          if (!s.ownsLifecycle(lease)) return true
        }
        let lastStatus = initialStatus
        const ok = await s.restart(true, {
          announce: !statusCard,
          lifecycleLease: lease,
          onStatus: status => {
            lastStatus = status
            s.setStatusCard(statusCard, status)
          },
        })
        if (!s.ownsLifecycle(lease)) return true
        const finalStatus = ok
          ? (
              lastStatus.startsWith('✅')
                ? lastStatus
                : s.withWorktreeInstructionNotice(resumeThreadLabel ? '✅ 已恢复上一会话' : `✅ ${s.backendLabel()} 已就绪`)
            )
          : (lastStatus.startsWith('❌') ? lastStatus : '❌ 重启失败')
        await s.closeStatusCard(statusCard, ok ? s.withModel(finalStatus) : finalStatus)
      }
      return true
      }
    case 'clear':
      {
      const lease = s.beginLifecycle('clear')
      // "throw away current conversation, start a new one". By design
      // this only makes sense when there IS a current conversation:
      // calling clear from stopped state is a no-op (user-confirmed
      // 2026-05-16) — we don't want a stray `clear` to silently spawn
      // a fresh session the user didn't ask for. To start from cold,
      // use `hi`.
      if (!s.isRunning()) {
        if (s.watchdogResumeFailed) {
          s.discardPreservedWatchdogRecovery('clear command')
          s.discardQueuedHumanWork('clear command')
          s.status = 'stopped'
          s.opts.onLifecycleChange?.()
          const statusCard = await s.openStatusCard('clear', '🧹 清除已保留消息', 'orange')
          if (!s.ownsLifecycle(lease)) return true
          if (statusCard) {
            await s.closeStatusCard(statusCard, '✅ 已清除自动恢复失败后保留的消息')
          } else {
            await feishu.sendText(s.chatId, '✅ 已清除自动恢复失败后保留的消息')
          }
          return true
        }
        s.status = 'stopped'
        s.opts.onLifecycleChange?.()
        const statusCard = await s.openStatusCard('clear', '⚪ session 当前未运行', 'grey')
        if (!s.ownsLifecycle(lease)) return true
        if (statusCard) {
          await s.closeStatusCard(statusCard, `⚪ ${s.backendLabel()} 未运行，clear 无效`)
        } else {
          await feishu.sendText(s.chatId, `⚪ session "${s.sessionName}" 当前未运行,clear 无效;用 \`hi\` 启动或 \`restart\` 恢复上一会话`)
        }
        return true
      }
      {
        const statusCard = await s.openStatusCard('clear', '🧹 清空并启动新会话', 'orange')
        if (!s.ownsLifecycle(lease)) return true
        let lastStatus = '🧹 清空并启动新会话'
        const ok = await s.restart(false, {
          announce: !statusCard,
          lifecycleLease: lease,
          onStatus: status => {
            lastStatus = status
            s.setStatusCard(statusCard, status)
          },
        })
        if (!s.ownsLifecycle(lease)) return true
        await s.closeStatusCard(
          statusCard,
          ok
            ? s.withModel(s.withWorktreeInstructionNotice('✅ 已清空并启动新会话'))
            : (lastStatus.startsWith('❌') ? lastStatus : '❌ 清空失败'),
        )
      }
      return true
      }
  }
}
