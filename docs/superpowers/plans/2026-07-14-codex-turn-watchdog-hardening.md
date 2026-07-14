# Codex Turn Watchdog Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four ownership races found in the final watchdog review so explicit lifecycle commands cannot be overtaken, preserved human input is committed only after Codex accepts it, failed recovery stays bound to its original provider/thread, and every detached watchdog card reaches a visible terminal state.

**Architecture:** Introduce a monotonic Session lifecycle lease and an immutable preserved-recovery record, then make strict retry use only that captured provider/thread. Change `AgentProcess.sendUserText` to return a provider-aware dispatch handle; Codex exposes an always-settling `turn/start` receipt while Claude remains synchronously queued, and Session keeps the exact human batch plus reactions until that receipt settles. Finally, make Card Kit write failure observable and terminalize only the captured detached `TurnState`, falling back to a raw Feishu message when the old card cannot be closed.

**Tech Stack:** TypeScript, Bun test runner, Node `EventEmitter`, existing Codex app-server JSON-RPC, existing Feishu Card Kit queue, existing `Session`/`AgentProcess` ownership model.

**Parent design:** `docs/superpowers/specs/2026-07-13-codex-turn-watchdog-auto-recovery-design.md`

**Parent implementation:** `docs/superpowers/plans/2026-07-13-codex-turn-watchdog-auto-recovery.md`

---

## File Map

### Modify

- `src/agent-process.ts` - provider-aware user-text dispatch contract.
- `src/codex-process.ts` / `src/codex-process.test.ts` - one receipt per primary-thread `turn/start`, exact identity on ACK/reject/result, and exit settlement.
- `src/claude-agent-process.ts` - preserve synchronous queue semantics while returning a `queued` dispatch handle.
- `src/session.ts` / `src/session.test.ts` - lifecycle leases, immutable recovery identity, pending human-delivery ownership, and detached-turn terminalization.
- `src/session-util.ts` - internal lease plumbing for nested lifecycle calls.
- `src/session-commands.ts` - invalidate stale lifecycle operations on `st`; destructively discard preserved recovery only for `kill`/`clear`.
- `src/session-model.ts` / `src/session-temp.ts` - reject identity-changing actions while preserved recovery exists.
- `src/cardkit.ts` / `src/cardkit.test.ts` - per-call failure observation for terminal `replaceElement` and `patchSettings` writes, including write-dead short circuits.
- `README.md` / `docs/开发与调试指南.md` - document the final operational contract after all code reviews pass.

### Preserve

- Do not change watchdog thresholds or default policy: Codex remains `recover_once`, 15 minutes plus 10 identical successful no-ops; pure silence warns at 30 minutes and is never interrupted.
- Do not add Claude auto-recovery or wait for Claude `turn_started` as an ACK.
- Do not add a watchdog rollout/JSONL reader. The existing image-generation rollout scan is unrelated and remains unchanged.
- Do not restart, stop, shadow, replace, or otherwise operate the live Lodestar daemon.
- Do not merge, push, publish, tag, release, or bump package version.

## Safety Invariants

1. Every start/restart/strict-retry operation owns a monotonic lease captured before its first `await`; a newer stop/kill/clear/dispose invalidates it before opening any status card or doing other preliminary work.
2. A stale operation may kill only a process it locally spawned or captured. It must never null, kill, publish success for, or mutate a newer owner.
3. Preserved recovery has immutable `{ provider, threadId }` identity and remains owned until its human batch is acknowledged or explicitly discarded.
4. Strict retry never falls back to a fresh thread and never follows mutable `selectedProvider` or `lastSessionId` after preservation begins.
5. Codex human input is committed only after the exact delivery's `turn/start` is accepted. Reject/exit before ACK restores the original message objects, order, attachments, `msgId`, `userOpenId`, and reactions exactly once.
6. ACK before exit commits exactly once and prevents duplicate replay. Stale ACK/result/exit events cannot settle another process, thread, delivery, or turn.
7. Claude input stays synchronously queued and does not depend on a later SDK event.
8. Detached-card cleanup acts only on the captured `TurnState`; after any `await` it cannot mutate a replacement `currentTurn`, process, watchdog context, status, or reaction owner.
9. A failed old-card terminal write produces one raw-text fallback and does not consume preserved human reactions.
10. An automatic watchdog action uses an immutable transaction snapshot and token; a stale action cannot have its target identity rewritten by a later `turn_started`, and its `finally` block cannot release a newer action's lock.

---

### Task 1: Lifecycle lease and immutable preserved-recovery identity

**Files:**
- Modify: `src/session.ts`
- Modify: `src/session.test.ts`
- Modify: `src/session-util.ts`
- Modify: `src/session-commands.ts`
- Modify: `src/session-model.ts`
- Modify: `src/session-temp.ts`

- [ ] **Step 1: Add deterministic RED tests for stale lifecycle operations**

Add a `Session lifecycle lease hardening` group to `src/session.test.ts`. Use deferred `kill()` and init promises so the old operation is paused while `proc === null`, then invoke each newer destructive action. The core assertions must follow this shape:

```ts
test.each(['stop', 'kill', 'clear', 'dispose'] as const)(
  '%s invalidates a strict restart before its replacement can install',
  async action => {
    const { session, oldProc, releaseKill, replacement } = strictRestartRaceFixture()
    const restarting = session.resumeFailedWatchdogQueue({ announce: false })
    await oldProc.killEntered.promise

    await invokeLifecycleAction(session, action)
    releaseKill.resolve()
    await restarting

    expect(session.proc).not.toBe(replacement)
    expect(replacement.killCalls).toBe(1)
    expect(session.status).toBe('stopped')
  },
)

test('a stale restart kills only its local late replacement', async () => {
  const { session, restarting, replacement, newerProc, releaseInstall } = lateInstallFixture()
  session.proc = newerProc
  releaseInstall.resolve()
  await restarting

  expect(replacement.killCalls).toBe(1)
  expect(newerProc.killCalls).toBe(0)
  expect(session.proc).toBe(newerProc)
})
```

Cover public `stop()`, command `kl`, command `clear`, `dispose()`, and soft command `st`. Pause command status-card creation before it resolves to prove invalidation happens at command entry, not later inside `Session.stop()`/`restart()`. `st` invalidates the stale spawn but preserves the recovery record and queued human work; the destructive actions discard both.

- [ ] **Step 2: Run the lifecycle race tests and verify RED**

```bash
# desc: 验证旧 restart 会越过新生命周期命令
bun test src/session.test.ts --test-name-pattern "lifecycle lease hardening"
```

Expected: FAIL because the late replacement is installed or the newer owner is mutated.

- [ ] **Step 3: Add lease and preserved-recovery types**

Add these types and fields near the current watchdog lifecycle types in `src/session.ts`:

```ts
type LifecycleKind = 'start' | 'restart' | 'strict_retry' | 'soft_stop' | 'stop' | 'clear' | 'dispose'

type LifecycleLease = Readonly<{
  epoch: number
  kind: LifecycleKind
}>

type ResumeIdentity = Readonly<{
  provider: AgentProvider
  threadId: string
}>

type PreservedWatchdogRecovery = {
  readonly target: ResumeIdentity
  phase: 'recovering' | 'failed'
  replacement: { proc: AgentProcess; epoch: number } | null
}

type WatchdogActionTransaction = Readonly<{
  token: object
  lease: LifecycleLease
  proc: AgentProcess
  turn: TurnState
  target: Readonly<{
    provider: 'codex'
    threadId: string
    turnId: string
  }>
  recoveryAttempt: number
}>

private lifecycleEpoch = 0
private disposed = false
private pendingSpawn: { proc: AgentProcess; epoch: number } | null = null
private preservedWatchdogRecovery: PreservedWatchdogRecovery | null = null
private watchdogActionToken: object | null = null
private modelSwitchToken: object | null = null
```

Add ownership helpers with no `await` inside them:

```ts
beginLifecycle(kind: LifecycleKind): LifecycleLease {
  return { epoch: ++this.lifecycleEpoch, kind }
}

ownsLifecycle(lease: LifecycleLease): boolean {
  return !this.disposed && lease.epoch === this.lifecycleEpoch
}

invalidateLifecycle(kind: LifecycleKind): LifecycleLease {
  return this.beginLifecycle(kind)
}

hasPreservedWatchdogRecovery(): boolean {
  return this.preservedWatchdogRecovery !== null
}

get watchdogResumeFailed(): boolean {
  return this.preservedWatchdogRecovery?.phase === 'failed'
}

get watchdogActionInFlight(): boolean {
  return this.watchdogActionToken !== null
}

get modelSwitchPending(): boolean {
  return this.modelSwitchToken !== null
}
```

Replace boolean assignments with explicit helpers that require a non-empty captured thread:

```ts
private preserveWatchdogRecovery(target: ResumeIdentity): PreservedWatchdogRecovery {
  const record: PreservedWatchdogRecovery = { target, phase: 'recovering', replacement: null }
  this.preservedWatchdogRecovery = record
  return record
}

private markPreservedRecoveryFailed(record: PreservedWatchdogRecovery): void {
  if (this.preservedWatchdogRecovery === record) record.phase = 'failed'
}

private completePreservedRecovery(record: PreservedWatchdogRecovery): void {
  if (this.preservedWatchdogRecovery === record) this.preservedWatchdogRecovery = null
}

discardPreservedRecovery(reason: string): void {
  if (this.preservedWatchdogRecovery) log(`session "${this.sessionName}": discard preserved recovery (${reason})`)
  this.preservedWatchdogRecovery = null
}
```

Update tests that directly assigned `watchdogResumeFailed` to install a real record with a helper fixture; do not add a permissive setter that can create an identity-free failed state.

At the start of `runWatchdogRecovery()` / `runWatchdogExhausted()`, copy the validated mutable `WatchdogTurnContext` into `WatchdogActionTransaction`. Every async checkpoint compares `watchdogActionToken === tx.token`; cleanup uses the same comparison before clearing. Never retain the mutable context as the recovery identity across an `await`:

```ts
const tx: WatchdogActionTransaction = {
  token: {},
  lease: this.beginLifecycle('strict_retry'),
  proc: ctx.proc,
  turn: ctx.turn,
  target: {
    provider: 'codex',
    threadId: ctx.threadId,
    turnId: ctx.turnId,
  },
  recoveryAttempt: this.watchdog.snapshot().recoveryAttempt,
}
this.watchdogActionToken = tx.token

private finishWatchdogAction(tx: WatchdogActionTransaction): void {
  if (this.watchdogActionToken === tx.token) this.watchdogActionToken = null
}
```

Call `finishWatchdogAction(tx)` from each action's `finally`; all recovery branches use `tx.proc`, `tx.turn`, and `tx.target` instead of rereading identity from `ctx` after an `await`.

Make `applyWatchdogIdentity()` single-assignment: it may fill missing IDs once or accept an identical replay, but a different thread/turn ID for an already-bound context must fail closed without mutating `WatchdogTurnContext` or `TurnState`. Add these RED tests to the same group:

```ts
test('a mismatched second turn_started cannot rewrite a bound recovery identity', () => {
  const { session, proc } = armedRecoverySession()
  proc.emit('turn_started', { thread_id: 'thread-1', turn_id: 'turn-1' })
  proc.emit('turn_started', { thread_id: 'thread-1', turn_id: 'turn-2' })
  expect(session.watchdogContext).toMatchObject({ threadId: 'thread-1', turnId: 'turn-1' })
})

test('stale watchdog finally cannot clear a newer action token', async () => {
  const { session, releaseOldAction, newerToken } = watchdogFinallyRaceFixture()
  session.watchdogActionToken = newerToken
  releaseOldAction.resolve()
  await session.oldAction
  expect(session.watchdogActionToken).toBe(newerToken)
})
```

- [ ] **Step 4: Make start/restart/strict retry lease-owned**

Change `spawnAgent` to accept an explicit provider for strict retry:

```ts
private spawnAgent(
  resumeSessionId?: string,
  provider: AgentProvider = this.selectedProvider,
): AgentProcess
```

At the synchronous entry of `start()`, `restart()`, and `resumeFailedWatchdogQueue()`, capture a lease. After every awaited card write, old-process kill, background reset, init wait, failure notification, and success notification, re-check both the lease and locally captured process. Install only a locally spawned process whose `pendingSpawn` still matches:

```ts
const replacement = this.spawnAgent(record.target.threadId, record.target.provider)
this.pendingSpawn = { proc: replacement, epoch: lease.epoch }
this.wireProc(replacement)
replacement.sendInitialize()
const init = await this.waitForProcResumeInit(replacement, onStillWaiting)

if (!this.ownsLifecycle(lease) || this.pendingSpawn?.proc !== replacement) {
  await replacement.kill(1000).catch(() => {})
  return false
}
if (init.state !== 'init' || replacement.provider !== record.target.provider || replacement.sessionId !== record.target.threadId) {
  await replacement.kill(1000).catch(() => {})
  this.markPreservedRecoveryFailed(record)
  return false
}

this.pendingSpawn = null
this.proc = replacement
record.replacement = { proc: replacement, epoch: lease.epoch }
```

Never call `this.proc?.kill()` after an `await`; kill the locally captured `oldProc` or `replacement`, and clear `this.proc` only when `this.proc === capturedProc`.

Extend `LifecycleProgressOpts` in `src/session-util.ts` with `lifecycleLease?: LifecycleLease` and `resumeSessionId?: string`. Nested `restart -> start`, strict retry, rollback/fork, and manual failed-recovery retry pass the same lease instead of silently minting a newer one. `preserveCurrentTurn` and `preserveQueuedHumanWork` are honored only when accompanied by the current preserved-recovery lease.

Change `persistResumableSessionId()` to accept the emitting process instead of rereading mutable `this.proc`. While a preserved record exists, persist only when the emitter provider and `sessionId` exactly match `record.target`; a wrong pre-validation init must not overwrite `lastSessionId` or the on-disk resume map:

```ts
private persistResumableSessionId(proc: AgentProcess): void {
  const sessionId = proc.sessionId
  if (!sessionId || this.proc !== proc) return
  const record = this.preservedWatchdogRecovery
  if (record && (proc.provider !== record.target.provider || sessionId !== record.target.threadId)) return
  feishu.bindSessionResume(this.sessionName, sessionId, proc.provider)
  if (proc.provider === this.selectedProvider) this.lastSessionId = sessionId
}
```

- [ ] **Step 5: Add RED tests for immutable retry identity and guards**

Add tests that mutate `selectedProvider` and `lastSessionId` after failure, then assert strict retry still targets the captured identity or fails closed without spawning:

```ts
test('manual retry uses the immutable captured provider and thread', async () => {
  const { session, record, spawned } = failedRecoveryFixture({ provider: 'codex', threadId: 'thread-captured' })
  session.selectedProvider = 'claude'
  session.lastSessionId = 'thread-mutated'

  await session.resumeFailedWatchdogQueue({ announce: false })

  expect(spawned).toEqual([{ provider: 'codex', resumeSessionId: 'thread-captured' }])
  expect(record.target).toEqual({ provider: 'codex', threadId: 'thread-captured' })
})
```

Also assert that model selection, `rollbackTo`, back-card selection, and resume-card selection reject before and after their preliminary awaited card/text operation while a record exists. Assert clear/kill/dispose discard the record and all queued human state.

- [ ] **Step 6: Implement identity-changing guards**

In `src/session-model.ts`, reject before settings mutation and re-check after `setModelSettings()` returns:

```ts
if (s.hasPreservedWatchdogRecovery()) {
  return { ok: false, message: '自动恢复仍有已保留消息；请先 restart 继续，或 clear/kill 明确丢弃后再切换模型' }
}
```

Replace the bare model pending boolean with a token. Its `finally` clears only its own token, so a stale model callback cannot release a newer model operation:

```ts
const token = {}
const lease = s.beginLifecycle('restart')
s.modelSwitchToken = token
try {
  if (s.proc?.isAlive() && s.proc.provider === provider && !shouldRespawnIdleClaude) {
    await withTimeout(s.proc.setModelSettings(model, effort), 20_000, 'thread/settings/update')
  }
  if (!s.ownsLifecycle(lease) || s.modelSwitchToken !== token) {
    return { ok: false, message: '模型切换已被更新的会话操作取消' }
  }
  await s.applyModelSelection(provider, model, effort, lease)
} finally {
  if (s.modelSwitchToken === token) s.modelSwitchToken = null
}
```

In `src/session-temp.ts`, guard `onBackSelect` and `onResumeSelect` before their first `await`, invalidate older lifecycle work before sending their preliminary text/Write card, and immediately re-check the same lease before `rollbackTo()`. Add the same defensive check at the start of `Session.rollbackTo()` and pass the lease through `startForked()`/nested restart work.

In `src/session-commands.ts`, acquire/invalidate the lifecycle lease synchronously before status-card awaits for `hi`, `st`, `kill`, failed-recovery `restart`, ordinary `restart`, and `clear`, then pass it into Session lifecycle methods. Call `discardPreservedRecovery(...)` only for full stop/kill/clear/dispose paths that already discard queued human work.

- [ ] **Step 7: Run lifecycle/identity tests and the existing watchdog suite**

```bash
# desc: 验证生命周期 lease 与恢复身份
bun test src/session.test.ts --test-name-pattern "lifecycle lease hardening|immutable captured provider|preserved recovery"

# desc: 验证完整会话回归
bun test src/session.test.ts
```

Expected: all selected tests pass, then the full `src/session.test.ts` file passes with zero failures.

- [ ] **Step 8: Create a fixup commit for Task 1**

```bash
# desc: 记录生命周期硬化 fixup
git add src/session.ts src/session.test.ts src/session-util.ts src/session-commands.ts src/session-model.ts src/session-temp.ts
git commit --fixup=fa45053
```

---

### Task 2: Codex dispatch receipt and pending human delivery

**Files:**
- Modify: `src/agent-process.ts`
- Modify: `src/codex-process.ts`
- Modify: `src/codex-process.test.ts`
- Modify: `src/claude-agent-process.ts`
- Modify: `src/session.ts`
- Modify: `src/session.test.ts`

- [ ] **Step 1: Add RED tests for Codex receipt settlement**

In `src/codex-process.test.ts`, construct a prototype-backed process with a controlled `request()` promise and verify each ordering:

```ts
test('turn/started ACK wins over a later RPC rejection', async () => {
  const { proc, rejectTurnStart } = pendingTurnStartFixture('thread-1')
  const dispatch = proc.sendUserText('hello')
  expect(dispatch.kind).toBe('turn_start_pending')

  proc.handleNotification('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } })
  rejectTurnStart(new Error('late reject'))

  await expect(dispatch.settlement).resolves.toEqual({
    kind: 'ack', deliveryId: dispatch.deliveryId, threadId: 'thread-1', turnId: 'turn-1',
  })
})

test('RPC rejection settles rejected without throwing from the receipt', async () => {
  const { proc, rejectTurnStart } = pendingTurnStartFixture('thread-1')
  const dispatch = proc.sendUserText('hello')
  rejectTurnStart(new Error('rejected'))
  await expect(dispatch.settlement).resolves.toMatchObject({
    kind: 'rejected', deliveryId: dispatch.deliveryId, threadId: 'thread-1',
  })
})

test('turn/completed before the RPC response ACKs once with the same delivery identity', async () => {
  const { proc, resolveTurnStart, resultEvents } = pendingTurnStartFixture('thread-1')
  const dispatch = proc.sendUserText('hello')
  proc.handleNotification('turn/completed', {
    threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' },
  })
  resolveTurnStart({ turn: { id: 'turn-1' } })

  await expect(dispatch.settlement).resolves.toMatchObject({ kind: 'ack', turnId: 'turn-1' })
  expect(resultEvents).toContainEqual(expect.objectContaining({
    delivery_id: dispatch.deliveryId, thread_id: 'thread-1', turn_id: 'turn-1',
  }))
})
```

- [ ] **Step 2: Run Codex receipt tests and verify RED**

```bash
# desc: 验证 Codex 尚无可等待的 turn-start 回执
bun test src/codex-process.test.ts --test-name-pattern "ACK wins|settles rejected|ACKs once"
```

Expected: FAIL because `sendUserText()` currently returns `void` and result events lack delivery identity.

- [ ] **Step 3: Define and implement the provider-aware dispatch contract**

Add to `src/agent-process.ts`:

```ts
export type CodexUserTextSettlement =
  | { kind: 'ack'; deliveryId: string; threadId: string; turnId: string | null }
  | { kind: 'rejected'; deliveryId: string; threadId: string; error: Error }

export type UserTextDispatch =
  | { kind: 'queued'; provider: 'claude' }
  | {
      kind: 'turn_start_pending'
      provider: 'codex'
      deliveryId: string
      threadId: string
      settlement: Promise<CodexUserTextSettlement>
    }

sendUserText(text: string, files?: string[]): UserTextDispatch
```

In `CodexProcess`, keep one active primary-thread delivery record. Its resolver must be idempotent and its `settlement` promise must never reject:

```ts
type PendingTurnStart = {
  deliveryId: string
  threadId: string
  turnId: string | null
  settled: boolean
  settle: (value: CodexUserTextSettlement) => void
}

private deliveryCounter = 0
private pendingTurnStart: PendingTurnStart | null = null
```

`sendUserText()` captures `sessionId`, creates `deliveryId = String(++this.deliveryCounter)`, stores the record, calls `startTurn`, and resolves `ack` on the first exact primary-thread RPC response, `turn/started`, or `turn/completed`. Keep the settled record until `turn/completed` so a prior RPC/notification ACK does not lose the delivery identity needed by the later result event. RPC reject or process exit before any ACK resolves `rejected`; a late RPC rejection after notification/completion ACK is logged and ignored, and must not emit a synthetic `codex_turn_start_failed` result. Add `delivery_id`, `thread_id`, and `turn_id` to both completion and genuine pre-ACK `codex_turn_start_failed` result payloads.

In `ClaudeAgentProcess.sendUserText()`, return `{ kind: 'queued', provider: 'claude' }` immediately after the existing synchronous `input.push(...)`; do not wait for `init`, `turn_started`, or `session_state_changed`.

- [ ] **Step 4: Add RED tests for exact human-batch ownership**

In `src/session.test.ts`, update `FakeAgentProc.sendUserText()` to return configurable dispatch handles. Add a `Session pending human delivery` group covering:

```ts
test('Codex exit before ACK restores the exact batch and reactions once', async () => {
  const { session, proc, dispatch, batch } = pendingDeliveryFixture()
  const draining = session.drainMidTurnAndOpen()
  await dispatch.started.promise

  proc.emit('exit', { code: 1, signal: null, expected: false })
  dispatch.reject(new Error('exited'))
  expect(await draining).toBe('preserved')

  expect(session.pendingMidTurnMsgs).toEqual(batch)
  expect(session.pendingReactionIds).toEqual(new Map([
    ['om-first', 'reaction-first'], ['om-second', 'reaction-second'],
  ]))
  expect(proc.sentTexts).toHaveLength(1)
  expect(session.pendingUserMessageCount).toBe(0)
})

test('Codex ACK before exit commits and cannot replay the batch', async () => {
  const { session, proc, dispatch } = pendingDeliveryFixture()
  const draining = session.drainMidTurnAndOpen()
  dispatch.ack('turn-1')
  expect(await draining).toBe('committed')
  proc.emit('exit', { code: 1, signal: null, expected: false })

  expect(session.pendingMidTurnMsgs).toEqual([])
  expect(session.pendingUserMessageCount).toBe(1)
})
```

Also cover: RPC reject before ACK; result-before-RPC-ACK; stale delivery ID; stale thread ID; stale process; ACK after owner replacement; late reaction arrival while the batch is pending; Claude synchronous commit; and exact preservation of two messages' `text`, `wireText` file hints, `userOpenId`, `msgId`, and order.

- [ ] **Step 5: Implement `PendingHumanDelivery` and commit only on ACK**

Add to `src/session.ts`:

```ts
type PendingHumanDelivery = {
  readonly token: object
  readonly proc: AgentProcess
  readonly turn: TurnState
  readonly dispatch: Extract<UserTextDispatch, { kind: 'turn_start_pending' }>
  readonly batch: Array<{ text: string; wireText: string; userOpenId: string; msgId: string }>
  readonly reactions: Map<string, string>
  state: 'pending' | 'acked' | 'restored'
}

private pendingHumanDelivery: PendingHumanDelivery | null = null
```

Refactor `drainMidTurnAndOpen()` so the batch remains owned by this context after the card opens. For Claude's `queued` handle, commit synchronously. For Codex, await the exact settlement and use idempotent helpers:

```ts
private commitHumanDelivery(ctx: PendingHumanDelivery): boolean {
  if (this.pendingHumanDelivery !== ctx || ctx.state !== 'pending') return false
  ctx.state = 'acked'
  this.pendingHumanDelivery = null
  this.pendingUserMessageCount++
  if (this.proc === ctx.proc && this.currentTurn === ctx.turn) {
    for (const [msgId, reactionId] of ctx.reactions) {
      this.currentBatchReactionIds.set(msgId, reactionId)
    }
    this.status = 'working'
  } else {
    for (const [msgId, reactionId] of ctx.reactions) {
      if (reactionId) void feishu.deleteReaction(msgId, reactionId)
    }
  }
  return true
}

private restoreHumanDelivery(ctx: PendingHumanDelivery): boolean {
  if (this.pendingHumanDelivery !== ctx || ctx.state !== 'pending') return false
  ctx.state = 'restored'
  this.pendingHumanDelivery = null
  this.pendingMidTurnMsgs = [...ctx.batch, ...this.pendingMidTurnMsgs]
  for (const [msgId, capturedRid] of ctx.reactions) {
    if (!this.pendingReactionIds.has(msgId)) {
      this.pendingReactionIds.set(msgId, capturedRid)
    }
  }
  return true
}
```

Move batch reactions from `pendingReactionIds` into `ctx.reactions`, not `currentBatchReactionIds`, before sending. Settlement must match the context's `proc`, `deliveryId`, and `threadId`. The process `exit` handler restores only when the exiting process is `ctx.proc` and the context is still pending; after restoration it must take the preserved-queue exit branch and return before ordinary exit cleanup clears human state. An ACKed context is never restored. Extend `trackQueuedReaction()` so a delayed reaction ID updates `pendingHumanDelivery.reactions` when that context currently owns the `msgId`.

Do not release `currentBatchReactionIds` while a pending delivery owns them. Do not update a replacement turn/status after any awaited receipt settles.

- [ ] **Step 6: Run dispatch and Session delivery tests**

```bash
# desc: 验证 Codex 投递回执
bun test src/codex-process.test.ts

# desc: 验证真人消息只在 ACK 后提交
bun test src/session.test.ts --test-name-pattern "pending human delivery|drained batch|Claude.*commit"

# desc: 验证完整相关回归
bun test src/codex-process.test.ts src/session.test.ts
```

Expected: all pass with zero failures and no unhandled rejection output.

- [ ] **Step 7: Create a fixup commit for Task 2**

```bash
# desc: 记录投递回执硬化 fixup
git add src/agent-process.ts src/codex-process.ts src/codex-process.test.ts src/claude-agent-process.ts src/session.ts src/session.test.ts
git commit --fixup=fa45053
```

---

### Task 3: Detached card terminalization and observable Card Kit failure

**Files:**
- Modify: `src/cardkit.ts`
- Modify: `src/cardkit.test.ts`
- Modify: `src/session.ts`
- Modify: `src/session.test.ts`

- [ ] **Step 1: Add RED tests for per-call terminal-write failures**

In `src/cardkit.test.ts`, test API rejection and write-dead short circuit for both operations:

```ts
test('replaceElement reports API failure and write-dead short circuit', async () => {
  const failures: Array<number | undefined> = []
  failNextCardKitCall(300313)
  await cardkit.replaceElement('card-fail', 'footer', footer(), code => failures.push(code))
  cardkit.markCardWriteDead('card-dead')
  await cardkit.replaceElement('card-dead', 'footer', footer(), code => failures.push(code))
  expect(failures).toEqual([300313, undefined])
})

test('patchSettings reports API failure and write-dead short circuit', async () => {
  const failures: Array<number | undefined> = []
  failNextCardKitCall(300317)
  await cardkit.patchSettings('card-fail', { config: {} }, code => failures.push(code))
  cardkit.markCardWriteDead('card-dead')
  await cardkit.patchSettings('card-dead', { config: {} }, code => failures.push(code))
  expect(failures).toEqual([300317, undefined])
})
```

- [ ] **Step 2: Run Card Kit tests and verify RED**

```bash
# desc: 验证终态卡片写失败目前不可观测
bun test src/cardkit.test.ts --test-name-pattern "reports API failure|write-dead short circuit"
```

Expected: FAIL because `replaceElement`/`patchSettings` do not accept callbacks and write-dead returns silently.

- [ ] **Step 3: Add observable failure callbacks without changing default semantics**

Use the same optional callback shape already used by `addElement`:

```ts
export function replaceElement(
  cardId: string,
  elementId: string,
  element: object,
  onFailure?: (code?: number) => void,
): Promise<void>

export function patchSettings(
  cardId: string,
  settings: object,
  onFailure?: (code?: number) => void,
): Promise<void>
```

If `writeDead` or `deadElements` prevents the requested write, invoke `onFailure?.()` exactly once. Pass the callback into `withReopenOnStreamingClosed` for `replaceElement`; in `patchSettings`, call it from the existing catch with the parsed Card Kit error code. Existing callers without a callback keep the current log-and-swallow behavior.

- [ ] **Step 4: Add RED tests for detached captured-turn cleanup**

In `src/session.test.ts`, add `Session detached watchdog card terminalization` tests:

```ts
test('captured watchdog process exit closes only its old card', async () => {
  const { session, proc, turn } = armedRecoverySession()
  proc.emit('exit', { code: 1, signal: null, expected: false })
  await cardkit.flush(turn.cardId)

  expect(session.currentTurn).toBeNull()
  expect(cardSettings(turn.cardId)).toMatchObject({ config: { streaming_mode: false } })
  expect(cardFooter(turn.cardId)).toContain('自动恢复失败')
})

test('deferred old-card cleanup cannot mutate a replacement turn', async () => {
  const { session, proc, turn, releaseOldWrite } = deferredDetachedCardFixture()
  proc.emit('exit', { code: 1, signal: null, expected: false })
  const replacement = installReplacementTurn(session)
  releaseOldWrite.resolve()
  await cardkit.flush(turn.cardId)

  expect(session.proc).toBe(replacement.proc)
  expect(session.currentTurn).toBe(replacement.turn)
  expect(session.pendingReactionIds).toEqual(replacement.pendingReactions)
  expect(session.watchdogContext).toBe(replacement.watchdogContext)
})

test('failed old-card terminal write sends one raw fallback', async () => {
  const { session, proc } = armedRecoverySession()
  failNextCardKitCall(300317)
  proc.emit('exit', { code: 1, signal: null, expected: false })
  await waitFor(() => sentRawTexts.some(text => text.includes('自动恢复失败')))
  expect(sentRawTexts.filter(text => text.includes('自动恢复失败'))).toHaveLength(1)
})
```

- [ ] **Step 5: Implement a captured `TurnState` terminalizer**

Add a helper that captures and detaches synchronously, then uses only local values after its first `await`:

```ts
private async terminalizeDetachedTurn(
  turn: TurnState,
  suffix: string,
): Promise<void> {
  if (this.currentTurn === turn) {
    this.currentTurn = null
    if (this.watchdogContext?.turn === turn) this.endWatchdogTurn()
  }
  this.stopFooterStatus(turn)
  if (turn.rotating) await turn.rotating
  this.stopFooterStatus(turn)

  const cardId = turn.cardId
  let writeFailed = false
  const onFailure = () => { writeFailed = true }
  await cardkit.flush(cardId)
  await cardkit.replaceElement(cardId, cards.ELEMENTS.footer, {
    tag: 'markdown', element_id: cards.ELEMENTS.footer, content: suffix,
  }, onFailure)
  cardkit.cancelSummary(cardId)
  await cardkit.patchSettings(cardId, cards.streamingOffSettings({ suffix }), onFailure)
  await cardkit.dispose(cardId)

  if (writeFailed) await feishu.sendTextRaw(this.chatId, suffix).catch(() => {})
}
```

The actual implementation may share footer-element construction with `replaceFooterContent`, but it must not call `closeTurnCard()` and must not temporarily install the old turn into `currentTurn`. It must not read, clear, or release global pending reactions after any `await`.

Call this helper from the captured-watchdog-process exit branches after synchronously taking the captured turn off the table. Keep lifecycle/status mutation outside the helper and guarded by the exact process/record ownership established in Tasks 1-2.

- [ ] **Step 6: Run Card Kit, detached-card, and full Session tests**

```bash
# desc: 验证 Card Kit 失败可观测
bun test src/cardkit.test.ts

# desc: 验证脱离 turn 的旧卡片正确终结
bun test src/session.test.ts --test-name-pattern "detached watchdog card terminalization|captured watchdog process exit"

# desc: 验证完整会话回归
bun test src/session.test.ts
```

Expected: all pass with zero failures; no timer leak or raw-fallback duplication appears.

- [ ] **Step 7: Create a fixup commit for Task 3**

```bash
# desc: 记录脱离卡片硬化 fixup
git add src/cardkit.ts src/cardkit.test.ts src/session.ts src/session.test.ts
git commit --fixup=fa45053
```

---

### Task 4: Squash hardening into Task 7 and repeat both review gates

**Files:**
- Review: all changes from `19e8bc6` through the rewritten Task 7 commit.

- [ ] **Step 1: Autosquash all hardening fixups into the original Task 7 commit**

```bash
# desc: 将硬化修复合并回 Task 7 提交
GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash fa45053^
```

Expected: the rewritten `feat(watchdog): bound recovery and preserve human input` retains exactly these four trailers:

```text
Constraint: Preserve human input priority and bound automatic recovery to one attempt
Rejected: Repeated automatic resume | could loop indefinitely and override human work
Confidence: high
Scope-risk: broad
```

- [ ] **Step 2: Run the focused Task 7 suite**

```bash
# desc: 运行 watchdog Task 7 聚焦回归
bun test src/turn-watchdog.test.ts src/config.test.ts src/cards/turn.test.ts src/codex-process.test.ts src/cardkit.test.ts src/session.test.ts

# desc: 检查补丁空白错误
git diff --check 19e8bc6..HEAD
```

Expected: all selected tests pass and `git diff --check` prints nothing.

- [ ] **Step 3: Run a fresh specification review**

Dispatch a fresh spec-review agent with the approved design, parent plan, this hardening plan, and exact base/head SHAs. Require an explicit `APPROVED` or ranked deviations with file/line evidence. Fix every deviation with a new RED test and a `fixup!` commit, autosquash again, and repeat until approved.

- [ ] **Step 4: Run a fresh code-quality review**

Only after spec approval, dispatch a fresh quality reviewer over the complete Task 7 diff. Require explicit coverage of lifecycle leases, stale-owner cleanup, receipt settlement ordering, reaction ownership, detached-card writes, and Claude non-regression. Fix every Critical/Important finding with RED-GREEN evidence and repeat review until none remain.

---

### Task 5: Documentation, full verification, and final audit

**Files:**
- Modify: `README.md`
- Modify: `docs/开发与调试指南.md`
- Review: `package.json`, `bun.lock`, all watchdog implementation files.

- [ ] **Step 1: Document the final behavior only after code reviews approve**

Document exactly:

```text
Codex 默认 recover_once。最后一次有效进展后持续 15 分钟，且确认至少 10 次完全相同、成功、无副作用的 text(...) 空调用时，Lodestar 才会在原 thread 自动恢复一次。纯静默推理只在 30 分钟后提示，不会自动打断；同一任务链第二次确认循环只停止，不再恢复。真人排队消息始终优先并保留附件、顺序与 reaction；Claude 不启用自动恢复。
```

Also state that code/config changes do not automatically restart the daemon and that live verification requires an explicit separate restart authorization.

- [ ] **Step 2: Install exactly the locked dependency graph**

```bash
# desc: 按锁文件安装依赖
bun install --frozen-lockfile
```

Expected: exit 0 and no `bun.lock` change.

- [ ] **Step 3: Run targeted tests, full tests, and build**

```bash
# desc: 运行 watchdog 全部聚焦测试
bun test src/turn-watchdog.test.ts src/config.test.ts src/cards/turn.test.ts src/codex-process.test.ts src/cardkit.test.ts src/session.test.ts

# desc: 运行完整测试
bun test

# desc: 构建全部发布入口
bun run build
```

Expected: zero test failures and build exit 0. If a previously known unrelated test fails, capture the exact output and prove it is unchanged from baseline before reporting a gap; do not claim full green.

- [ ] **Step 4: Audit prohibited behavior and repository cleanliness**

```bash
# desc: 确认 watchdog 没有新增 rollout JSONL 读取
git diff --unified=0 19e8bc6..HEAD -- src/codex-process.ts | rg "^\+.*(readFileSync|readdirSync|statSync|rollout|jsonl)"

# desc: 确认没有 live 服务操作落入代码或文档
git diff 19e8bc6..HEAD | rg "launchctl (kickstart|bootout)|systemctl --user (restart|stop)|lodestar-stop"

# desc: 检查最终补丁和工作树
git diff --check 19e8bc6..HEAD
git status --short
```

Expected: both prohibited-behavior searches return no matches, `git diff --check` is empty, and only the intended documentation changes remain before the documentation commit.

- [ ] **Step 5: Commit documentation**

```bash
# desc: 提交 watchdog 文档
git add README.md docs/开发与调试指南.md docs/superpowers/plans/2026-07-14-codex-turn-watchdog-hardening.md
git commit -m "docs(watchdog): document bounded recovery hardening" \
  -m "Constraint: Keep operational behavior explicit without deploying it" \
  -m "Confidence: high" \
  -m "Scope-risk: narrow"
```

- [ ] **Step 6: Run final full-diff review and verification-before-completion**

Dispatch a fresh final reviewer over `19e8bc6..HEAD`, then rerun the smallest commands needed to prove every final claim after any review fix. Do not restart, merge, push, publish, or deploy. The completion report must include the rewritten Task 7 SHA, documentation SHA, targeted/full test counts, build result, audit result, and explicit confirmation that the live daemon was untouched.
