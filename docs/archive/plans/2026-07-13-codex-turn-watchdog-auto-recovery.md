# Codex Turn Watchdog Auto-Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect high-confidence Codex `text("ready")`-style no-op loops, interrupt them safely, and continue the same task once without losing queued human input or touching the Lodestar daemon.

**Architecture:** Add a pure `TurnWatchdog` state machine that consumes existing Session/app-server events and returns side-effect-free verdicts. `Session` owns timers, card updates, soft-interrupt settlement, same-thread recovery, and the one fallback agent-process resume; config defaults every Codex project to `recover_once`, while Claude remains unaffected.

**Tech Stack:** TypeScript, Bun test runner, Node `crypto`, existing `AgentProcess`/`Session` event model, Feishu Card Kit helpers, hand-written TOML config parser.

**Approved design:** `docs/superpowers/specs/2026-07-13-codex-turn-watchdog-auto-recovery-design.md`

---

## File Map

### Create

- `src/turn-watchdog.ts` — pure no-op recognizer, state machine, settings parser, verdicts.
- `src/turn-watchdog.test.ts` — deterministic fake-time coverage for recognition and verdicts.

### Modify

- `src/config.ts` / `src/config.test.ts` — global defaults, project override, validation.
- `src/session-types.ts` — `watchdog_resume`, backend turn identity, and live-footer warning state.
- `src/cards/turn.ts` / `src/cards/turn.test.ts` — recovery card contract.
- `src/session.ts` / `src/session-commands.ts` / `src/session-model.ts` / `src/session-util.ts` — observation, interruption, recovery, model-switch guard, queue-preserving restart, cleanup.
- `src/session-tools.ts` — submit main-thread tool start/result pairs to the watchdog.
- `src/agent-process.ts` / `src/codex-process.ts` / `src/codex-process.test.ts` — expose existing app-server sub-agent activity as a structured progress event without reading rollout files.
- `src/session.test.ts` / `src/feishu-test-mock.ts` — recovery races and project-policy fixtures.
- `README.md` / `docs/开发与调试指南.md` — configuration and safe verification.

### Preserve

- Do not add or expand a rollout JSONL tailer in `src/codex-process.ts`; the only permitted change there is mapping app-server events already received on stdio.
- Do not add Claude auto-recovery to `src/claude-agent-process.ts`.
- Do not edit user config or operate the live daemon.

## Safety Invariants

1. Pure silent reasoning warns only; it never auto-interrupts.
2. Only strict side-effect-free `exec -> text("literal")` calls can count as no-op.
3. Any queued human input wins over an internal recovery prompt.
4. One task chain gets one continuation; the next confirmed loop stops only.
5. Soft interrupt must settle through `result` or process exit before continuation.
6. `result` continues on the live process; `exit` immediately respawns/resumes; timeout tears down then resumes.
7. Resume failure stops visibly; it never creates a fresh conversation.
8. No task in this plan restarts or replaces the Lodestar daemon.
9. Every asynchronous recovery step revalidates the captured process, TurnState object, thread id, and turn id.

---

### Task 1: Pure no-op recognizer and watchdog state machine

**Files:**
- Create: `src/turn-watchdog.ts`
- Create: `src/turn-watchdog.test.ts`

- [ ] **Step 1: Write failing recognizer tests**

Create `src/turn-watchdog.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_CODEX_WATCHDOG,
  TurnWatchdog,
  matchesNoopExecResult,
  parseNoopExecCall,
  type WatchdogSafetySnapshot,
} from './turn-watchdog'

const safe: WatchdogSafetySnapshot = {
  currentTurn: true,
  eligibleTrigger: true,
  realToolRunning: false,
  backgroundWorkRunning: false,
  awaitingInput: false,
  compactionRunning: false,
  rotationRunning: false,
  agyRunning: false,
  queuedHumanWork: false,
  modelSwitchPending: false,
  recoveryActionInFlight: false,
}

describe('parseNoopExecCall', () => {
  test('accepts one side-effect-free text call', () => {
    const parsed = parseNoopExecCall('exec', 'text("ready");\n')
    expect(parsed?.literal).toBe('ready')
    expect(parsed?.fingerprintHash).toHaveLength(64)
  })

  test('accepts namespaced exec and distinguishes literals', () => {
    const a = parseNoopExecCall('functions.exec', 'text("ready");')
    const b = parseNoopExecCall('exec', 'text("dispatch A6 spec reviewer");')
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a?.fingerprintHash).not.toBe(b?.fingerprintHash)
  })

  test('rejects code that can perform work', () => {
    expect(parseNoopExecCall('exec', 'const r = await tools.exec_command({ cmd: "date" }); text(r.output);')).toBeNull()
    expect(parseNoopExecCall('exec', 'notify("ready")')).toBeNull()
    expect(parseNoopExecCall('exec', 'text("ready"); text("again");')).toBeNull()
    expect(parseNoopExecCall('Bash', 'text("ready");')).toBeNull()
    expect(parseNoopExecCall('exec', "text('ready');")).toBeNull()
  })
})

const execResult = (literal: string, type = 'inputText'): string => JSON.stringify([
  { type, text: 'Script completed\nWall time 0.0 seconds\nOutput:\n' },
  { type, text: literal },
])

describe('matchesNoopExecResult', () => {
  test('accepts the exact app-server dynamicToolCall output shape', () => {
    expect(matchesNoopExecResult(execResult('ready'), 'ready')).toBe(true)
  })

  test('rejects rollout-only snake_case, mismatched text, and extra content', () => {
    expect(matchesNoopExecResult(execResult('ready', 'input_text'), 'ready')).toBe(false)
    expect(matchesNoopExecResult(execResult('different'), 'ready')).toBe(false)
    expect(matchesNoopExecResult(JSON.stringify([
      { type: 'inputText', text: 'Script completed\nWall time 0.0 seconds\nOutput:\n' },
      { type: 'inputText', text: 'ready' },
      { type: 'inputImage', imageUrl: 'data:image/png;base64,x' },
    ]), 'ready')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test and verify the red state**

```bash
# desc: 验证 watchdog 模块尚未实现
bun test src/turn-watchdog.test.ts
```

Expected: FAIL with `Cannot find module './turn-watchdog'`.

- [ ] **Step 3: Implement strict recognition and output matching**

Create the public types and helpers in `src/turn-watchdog.ts`:

```ts
import { createHash } from 'node:crypto'

export type WatchdogMode = 'off' | 'warn' | 'recover_once'

export interface WatchdogSettings {
  mode: WatchdogMode
  stallMs: number
  repeatNoopLimit: number
  silentWarnMs: number
  interruptGraceMs: number
}

export const DEFAULT_CODEX_WATCHDOG: WatchdogSettings = {
  mode: 'recover_once',
  stallMs: 900_000,
  repeatNoopLimit: 10,
  silentWarnMs: 1_800_000,
  interruptGraceMs: 10_000,
}

export interface NoopExecCall {
  literal: string
  fingerprintHash: string
}

const TEXT_ONLY_EXEC = /^text\(\s*("(?:[^"\\]|\\.)*")\s*\)\s*;?$/

export function parseNoopExecCall(name: string, input: unknown): NoopExecCall | null {
  if (name !== 'exec' && name !== 'functions.exec') return null
  if (typeof input !== 'string') return null
  const normalized = input
    .split(/\r?\n/)
    .filter(line => !/^\s*\/\//.test(line))
    .join('\n')
    .trim()
  const match = normalized.match(TEXT_ONLY_EXEC)
  if (!match) return null
  let literal: unknown
  try { literal = JSON.parse(match[1]) }
  catch { return null }
  if (typeof literal !== 'string') return null
  return {
    literal,
    fingerprintHash: createHash('sha256').update(`exec:text\0${literal}`).digest('hex'),
  }
}

export function matchesNoopExecResult(content: unknown, literal: string): boolean {
  if (typeof content !== 'string') return false
  let items: unknown
  try { items = JSON.parse(content) }
  catch { return false }
  if (!Array.isArray(items) || items.length !== 2) return false
  const first = items[0] as { type?: unknown; text?: unknown }
  const second = items[1] as { type?: unknown; text?: unknown }
  return first.type === 'inputText'
    && typeof first.text === 'string'
    && /^Script completed\nWall time \d+(?:\.\d+)? seconds\nOutput:\n$/.test(first.text)
    && second.type === 'inputText'
    && second.text === literal
}
```

- [ ] **Step 4: Add failing threshold, warning, and budget tests**

Append:

```ts
function confirmNoop(watchdog: TurnWatchdog, id: string, literal: string, at: number): void {
  watchdog.observeToolStart(id, 'exec', `text(${JSON.stringify(literal)});`, at)
  watchdog.observeToolResult(id, execResult(literal), false, at)
}

describe('TurnWatchdog', () => {
  test('requires both 15 minutes and ten matching no-ops', () => {
    const watchdog = new TurnWatchdog(DEFAULT_CODEX_WATCHDOG)
    watchdog.beginTurn('turn-1', 'user_message', 0)
    for (let i = 0; i < 10; i++) confirmNoop(watchdog, `call-${i}`, 'ready', i)
    expect(watchdog.evaluate(899_999, safe)).toEqual({ type: 'none' })
    expect(watchdog.evaluate(900_000, safe)).toMatchObject({
      type: 'recover', idleMs: 900_000, repeatCount: 10,
    })
  })

  test('nine matching no-ops never meet the repeat threshold', () => {
    const watchdog = new TurnWatchdog(DEFAULT_CODEX_WATCHDOG)
    watchdog.beginTurn('turn-1', 'user_message', 0)
    for (let i = 0; i < 9; i++) confirmNoop(watchdog, `call-${i}`, 'ready', i)
    expect(watchdog.evaluate(900_000, safe)).toEqual({ type: 'none' })
  })

  test('does not count an unresolved, failed, mismatched, duplicate, or unknown result', () => {
    const watchdog = new TurnWatchdog({ ...DEFAULT_CODEX_WATCHDOG, stallMs: 1, repeatNoopLimit: 3 })
    watchdog.beginTurn('turn-1', 'user_message', 0)
    watchdog.observeToolStart('pending', 'exec', 'text("ready");', 1)
    expect(watchdog.evaluate(10, safe)).toEqual({ type: 'none' })
    watchdog.observeToolResult('pending', execResult('ready'), true, 2)
    watchdog.observeToolStart('mismatch', 'exec', 'text("ready");', 3)
    watchdog.observeToolResult('mismatch', execResult('different'), false, 4)
    watchdog.observeToolResult('unknown', execResult('ready'), false, 5)
    watchdog.observeToolResult('mismatch', execResult('ready'), false, 6)
    expect(watchdog.snapshot()).toMatchObject({ repeatCount: 0, pendingCandidateCount: 0 })
  })

  test('different fingerprints restart the consecutive sequence at one', () => {
    const watchdog = new TurnWatchdog({ ...DEFAULT_CODEX_WATCHDOG, stallMs: 1, repeatNoopLimit: 3 })
    watchdog.beginTurn('turn-1', 'user_message', 0)
    confirmNoop(watchdog, 'a', 'ready', 1)
    confirmNoop(watchdog, 'b', 'ready', 2)
    confirmNoop(watchdog, 'c', 'dispatch spec', 3)
    expect(watchdog.snapshot()).toMatchObject({ repeatCount: 1 })
    expect(watchdog.evaluate(10, safe)).toEqual({ type: 'none' })
  })

  test('real progress resets evidence and silent warning latch', () => {
    const watchdog = new TurnWatchdog(DEFAULT_CODEX_WATCHDOG)
    watchdog.beginTurn('turn-1', 'user_message', 0)
    expect(watchdog.evaluate(1_800_000, safe).type).toBe('silent_warn')
    expect(watchdog.evaluate(1_800_001, safe).type).toBe('none')
    watchdog.observeMeaningful(1_800_010, 'assistant_text')
    expect(watchdog.snapshot()).toMatchObject({ repeatCount: 0, lastMeaningfulLabel: 'assistant_text' })
  })

  test('warn mode reports once and never recovers', () => {
    const watchdog = new TurnWatchdog({ ...DEFAULT_CODEX_WATCHDOG, mode: 'warn', stallMs: 1 })
    watchdog.beginTurn('turn-1', 'user_message', 0)
    for (let i = 0; i < 10; i++) confirmNoop(watchdog, `warn-${i}`, 'ready', i)
    expect(watchdog.evaluate(10, safe).type).toBe('loop_warn')
    expect(watchdog.evaluate(11, safe).type).toBe('none')
    watchdog.observeMeaningful(12, 'assistant_text')
    for (let i = 0; i < 10; i++) confirmNoop(watchdog, `warn-next-${i}`, 'ready', 13 + i)
    expect(watchdog.evaluate(23, safe).type).toBe('loop_warn')
  })

  test('off mode never warns or recovers', () => {
    const watchdog = new TurnWatchdog({ ...DEFAULT_CODEX_WATCHDOG, mode: 'off', stallMs: 1, silentWarnMs: 2 })
    watchdog.beginTurn('turn-1', 'user_message', 0)
    for (let i = 0; i < 10; i++) confirmNoop(watchdog, `off-${i}`, 'ready', i)
    expect(watchdog.evaluate(10, safe)).toEqual({ type: 'none' })
  })

  test('recovery turn preserves the consumed budget', () => {
    const watchdog = new TurnWatchdog({ ...DEFAULT_CODEX_WATCHDOG, stallMs: 1, repeatNoopLimit: 3 })
    watchdog.beginTurn('turn-1', 'user_message', 0)
    for (let i = 0; i < 3; i++) confirmNoop(watchdog, `first-${i}`, 'ready', i)
    expect(watchdog.evaluate(3, safe).type).toBe('recover')
    watchdog.consumeRecovery()
    watchdog.beginTurn('turn-2', 'watchdog_resume', 4)
    for (let i = 0; i < 3; i++) confirmNoop(watchdog, `second-${i}`, 'ready', 5 + i)
    expect(watchdog.evaluate(8, safe).type).toBe('stop_exhausted')
  })

  test('background resume and unsafe snapshots do not recover', () => {
    const watchdog = new TurnWatchdog({ ...DEFAULT_CODEX_WATCHDOG, stallMs: 1, repeatNoopLimit: 3 })
    watchdog.beginTurn('turn-bg', 'bg_task_resume', 0)
    for (let i = 0; i < 3; i++) confirmNoop(watchdog, `bg-${i}`, 'ready', i)
    expect(watchdog.evaluate(3, safe).type).toBe('loop_warn')
    watchdog.beginTurn('turn-user', 'user_message', 4)
    for (let i = 0; i < 3; i++) confirmNoop(watchdog, `user-${i}`, 'ready', i)
    expect(watchdog.evaluate(8, { ...safe, backgroundWorkRunning: true })).toEqual({ type: 'none' })
  })

  test.each([
    'currentTurn', 'eligibleTrigger', 'realToolRunning', 'backgroundWorkRunning',
    'awaitingInput', 'compactionRunning', 'rotationRunning', 'agyRunning',
    'queuedHumanWork', 'modelSwitchPending', 'recoveryActionInFlight',
  ] as const)('suppresses action when safety guard %s fails', guard => {
    const watchdog = new TurnWatchdog({ ...DEFAULT_CODEX_WATCHDOG, stallMs: 1, repeatNoopLimit: 3 })
    watchdog.beginTurn('turn-1', 'user_message', 0)
    for (let i = 0; i < 3; i++) confirmNoop(watchdog, `${guard}-${i}`, 'ready', i)
    const blocked = guard === 'currentTurn' || guard === 'eligibleTrigger'
      ? { ...safe, [guard]: false }
      : { ...safe, [guard]: true }
    expect(watchdog.evaluate(10, blocked)).toEqual({ type: 'none' })
  })
})
```

- [ ] **Step 5: Implement the pure state machine**

Define `WatchdogTrigger`, `WatchdogSafetySnapshot`, `WatchdogVerdict`, and `TurnWatchdog`. Required behavior:

```ts
export type WatchdogTrigger = 'user_message' | 'bg_task_resume' | 'watchdog_resume'

export interface WatchdogSafetySnapshot {
  currentTurn: boolean
  eligibleTrigger: boolean
  realToolRunning: boolean
  backgroundWorkRunning: boolean
  awaitingInput: boolean
  compactionRunning: boolean
  rotationRunning: boolean
  agyRunning: boolean
  queuedHumanWork: boolean
  modelSwitchPending: boolean
  recoveryActionInFlight: boolean
}

export type WatchdogVerdict =
  | { type: 'none' }
  | { type: 'silent_warn'; idleMs: number }
  | { type: 'loop_warn'; idleMs: number; repeatCount: number; fingerprintHash: string }
  | { type: 'recover'; idleMs: number; repeatCount: number; fingerprintHash: string }
  | { type: 'stop_exhausted'; idleMs: number; repeatCount: number; fingerprintHash: string }

export interface WatchdogSnapshot {
  turnKey: string | null
  trigger: WatchdogTrigger | null
  lastMeaningfulAt: number
  lastMeaningfulLabel: string
  repeatCount: number
  fingerprintHash: string | null
  pendingCandidateCount: number
  activeRealToolCount: number
  recoveryAttempt: 0 | 1
}
```

Implement the state machine with the following public surface and state transitions; the
implementation never stores a raw prompt or raw tool input after `observeToolStart` returns:

```ts
export class TurnWatchdog {
  private turnKey: string | null = null
  private trigger: WatchdogTrigger | null = null
  private lastMeaningfulAt = 0
  private lastMeaningfulLabel = 'turn_start'
  private pendingCandidates = new Map<string, NoopExecCall>()
  private activeRealTools = new Set<string>()
  private fingerprintHash: string | null = null
  private repeatCount = 0
  private recoveryAttempt: 0 | 1 = 0
  private silentWarned = false
  private loopWarned = false

  constructor(private readonly settings: WatchdogSettings) {}

  beginTurn(turnKey: string, trigger: WatchdogTrigger, now: number): void {
    this.turnKey = turnKey
    this.trigger = trigger
    this.lastMeaningfulAt = now
    this.lastMeaningfulLabel = 'turn_start'
    this.pendingCandidates.clear()
    this.activeRealTools.clear()
    this.fingerprintHash = null
    this.repeatCount = 0
    this.silentWarned = false
    this.loopWarned = false
    if (trigger === 'user_message') this.recoveryAttempt = 0
  }

  endTurn(): void {
    this.turnKey = null
    this.trigger = null
    this.pendingCandidates.clear()
    this.activeRealTools.clear()
    this.fingerprintHash = null
    this.repeatCount = 0
    this.silentWarned = false
    this.loopWarned = false
  }

  observeMeaningful(now: number, label: string): void {
    if (!this.turnKey) return
    this.lastMeaningfulAt = now
    this.lastMeaningfulLabel = label
    this.fingerprintHash = null
    this.repeatCount = 0
    this.silentWarned = false
    this.loopWarned = false
  }

  observeToolStart(id: string, name: string, input: unknown, now: number): void {
    if (!this.turnKey) return
    this.pendingCandidates.delete(id)
    this.activeRealTools.delete(id)
    const candidate = parseNoopExecCall(name, input)
    if (candidate) {
      this.pendingCandidates.set(id, candidate)
      return
    }
    this.activeRealTools.add(id)
    this.observeMeaningful(now, `tool_use:${name}`)
  }

  observeToolResult(id: string, content: unknown, isError: boolean, now: number): void {
    const candidate = this.pendingCandidates.get(id)
    if (candidate) {
      this.pendingCandidates.delete(id)
      if (isError || !matchesNoopExecResult(content, candidate.literal)) {
        this.observeMeaningful(now, 'tool_result:exec')
        return
      }
      if (candidate.fingerprintHash === this.fingerprintHash) this.repeatCount++
      else {
        this.fingerprintHash = candidate.fingerprintHash
        this.repeatCount = 1
      }
      return
    }
    if (this.activeRealTools.delete(id)) this.observeMeaningful(now, 'tool_result')
  }

  consumeRecovery(): void {
    this.recoveryAttempt = 1
  }

  evaluate(now: number, safety: WatchdogSafetySnapshot): WatchdogVerdict {
    if (!this.turnKey || !this.trigger || this.settings.mode === 'off') return { type: 'none' }
    if (this.pendingCandidates.size > 0 || this.activeRealTools.size > 0) return { type: 'none' }
    if (
      !safety.currentTurn || !safety.eligibleTrigger || safety.realToolRunning ||
      safety.backgroundWorkRunning || safety.awaitingInput || safety.compactionRunning ||
      safety.rotationRunning || safety.agyRunning || safety.queuedHumanWork ||
      safety.modelSwitchPending || safety.recoveryActionInFlight
    ) return { type: 'none' }

    const idleMs = Math.max(0, now - this.lastMeaningfulAt)
    const loop = idleMs >= this.settings.stallMs &&
      this.repeatCount >= this.settings.repeatNoopLimit && !!this.fingerprintHash
    if (loop) {
      if (this.settings.mode === 'warn' || this.trigger === 'bg_task_resume') {
        if (this.loopWarned) return { type: 'none' }
        this.loopWarned = true
        return { type: 'loop_warn', idleMs, repeatCount: this.repeatCount, fingerprintHash: this.fingerprintHash! }
      }
      return this.recoveryAttempt === 0
        ? { type: 'recover', idleMs, repeatCount: this.repeatCount, fingerprintHash: this.fingerprintHash! }
        : { type: 'stop_exhausted', idleMs, repeatCount: this.repeatCount, fingerprintHash: this.fingerprintHash! }
    }
    if (idleMs >= this.settings.silentWarnMs && !this.silentWarned) {
      this.silentWarned = true
      return { type: 'silent_warn', idleMs }
    }
    return { type: 'none' }
  }

  snapshot(): Readonly<WatchdogSnapshot> {
    return {
      turnKey: this.turnKey,
      trigger: this.trigger,
      lastMeaningfulAt: this.lastMeaningfulAt,
      lastMeaningfulLabel: this.lastMeaningfulLabel,
      repeatCount: this.repeatCount,
      fingerprintHash: this.fingerprintHash,
      pendingCandidateCount: this.pendingCandidates.size,
      activeRealToolCount: this.activeRealTools.size,
      recoveryAttempt: this.recoveryAttempt,
    }
  }
}
```

- [ ] **Step 6: Run and commit Task 1**

```bash
# desc: 验证纯 watchdog 状态机
bun test src/turn-watchdog.test.ts

# desc: 提交纯 watchdog 状态机
git add src/turn-watchdog.ts src/turn-watchdog.test.ts
git commit -m "feat(watchdog): add pure Codex no-op detector"
```

Expected: tests PASS, then one focused commit.

---

### Task 2: Configuration defaults and project overrides

**Files:**
- Modify: `src/turn-watchdog.ts`
- Modify: `src/config.ts:29-118`
- Modify: `src/config.ts:160-286`
- Modify: `src/config.test.ts`

- [ ] **Step 1: Add a fresh-process config test helper**

Add to `src/config.test.ts`:

```ts
function loadConfigFrom(text: string): { exitCode: number; stdout: string; stderr: string } {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-watchdog-config-'))
  const configFile = join(root, 'config.toml')
  writeFileSync(configFile, text)
  try {
    const configModule = pathToFileURL(join(import.meta.dir, 'config.ts')).href
    const result = Bun.spawnSync({
      cmd: [process.execPath, '--eval', `import { config } from ${JSON.stringify(configModule)}; process.stdout.write(JSON.stringify(config))`],
      env: { ...process.env, LODESTAR_CONFIG: configFile },
    })
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const minimumConfig = [
  '[feishu]',
  'app_id = "cli_test"',
  'app_secret = "secret"',
].join('\n')
```

- [ ] **Step 2: Add failing default, override, and validation tests**

```ts
describe('watchdog config', () => {
  test('defaults Codex to conservative recover-once', () => {
    const result = loadConfigFrom(minimumConfig)
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout).watchdog).toEqual({
      codexMode: 'recover_once',
      stallMs: 900_000,
      repeatNoopLimit: 10,
      silentWarnMs: 1_800_000,
      interruptGraceMs: 10_000,
    })
  })

  test('parses global values and project override', () => {
    const result = loadConfigFrom([
      minimumConfig,
      '[watchdog]',
      'codex_mode = "warn"',
      'stall_seconds = "1200"',
      'repeat_noop_limit = "12"',
      'silent_warn_seconds = "2400"',
      'interrupt_grace_seconds = "15"',
      '[projects.pokemon]',
      'watchdog_mode = "off"',
    ].join('\n'))
    expect(result.exitCode).toBe(0)
    const loaded = JSON.parse(result.stdout)
    expect(loaded.watchdog).toEqual({
      codexMode: 'warn', stallMs: 1_200_000, repeatNoopLimit: 12,
      silentWarnMs: 2_400_000, interruptGraceMs: 15_000,
    })
    expect(loaded.projects.pokemon.watchdogMode).toBe('off')
  })

  test.each([
    ['codex_mode = "aggressive"', 'watchdog.codex_mode'],
    ['stall_seconds = "59"', 'watchdog.stall_seconds'],
    ['stall_seconds = "86401"', 'watchdog.stall_seconds'],
    ['stall_seconds = "90.5"', 'watchdog.stall_seconds'],
    ['repeat_noop_limit = "2"', 'watchdog.repeat_noop_limit'],
    ['repeat_noop_limit = "101"', 'watchdog.repeat_noop_limit'],
    ['stall_seconds = "900"\nsilent_warn_seconds = "899"', 'watchdog.silent_warn_seconds'],
    ['silent_warn_seconds = "172801"', 'watchdog.silent_warn_seconds'],
    ['interrupt_grace_seconds = "0"', 'watchdog.interrupt_grace_seconds'],
    ['interrupt_grace_seconds = "61"', 'watchdog.interrupt_grace_seconds'],
  ])('rejects unsafe value %s', (line, field) => {
    const result = loadConfigFrom([minimumConfig, '[watchdog]', line].join('\n'))
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain(field)
  })

  test('rejects an invalid project override without changing the global mode', () => {
    const result = loadConfigFrom([
      minimumConfig,
      '[projects.pokemon]',
      'watchdog_mode = "aggressive"',
    ].join('\n'))
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('projects.pokemon.watchdog_mode')
  })
})
```

- [ ] **Step 3: Run the tests and verify the red state**

```bash
# desc: 验证 watchdog 配置尚未接入
bun test src/config.test.ts
```

Expected: FAIL because `config.watchdog` does not exist.

- [ ] **Step 4: Add strict pure config parsing**

Export from `src/turn-watchdog.ts`:

```ts
export function parseWatchdogMode(
  raw: string | undefined,
  field: string,
  fallback: WatchdogMode,
): WatchdogMode {
  if (raw == null || raw === '') return fallback
  if (raw === 'off' || raw === 'warn' || raw === 'recover_once') return raw
  throw new Error(`lodestar: ${field} must be off|warn|recover_once, got "${raw}"`)
}

function parseWatchdogInteger(
  raw: string | undefined,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw == null || raw === '') return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`lodestar: ${field} must be an integer, got "${raw}"`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`lodestar: ${field} must be ${min}..${max}, got "${raw}"`)
  }
  return value
}

export function parseWatchdogSettings(section: Record<string, string> = {}): WatchdogSettings {
  const stallSeconds = parseWatchdogInteger(
    section.stall_seconds, 'watchdog.stall_seconds', DEFAULT_CODEX_WATCHDOG.stallMs / 1000, 60, 86_400,
  )
  const silentWarnSeconds = parseWatchdogInteger(
    section.silent_warn_seconds, 'watchdog.silent_warn_seconds', DEFAULT_CODEX_WATCHDOG.silentWarnMs / 1000,
    stallSeconds, 172_800,
  )
  return {
    mode: parseWatchdogMode(section.codex_mode, 'watchdog.codex_mode', DEFAULT_CODEX_WATCHDOG.mode),
    stallMs: stallSeconds * 1000,
    repeatNoopLimit: parseWatchdogInteger(
      section.repeat_noop_limit, 'watchdog.repeat_noop_limit', DEFAULT_CODEX_WATCHDOG.repeatNoopLimit, 3, 100,
    ),
    silentWarnMs: silentWarnSeconds * 1000,
    interruptGraceMs: parseWatchdogInteger(
      section.interrupt_grace_seconds, 'watchdog.interrupt_grace_seconds',
      DEFAULT_CODEX_WATCHDOG.interruptGraceMs / 1000, 1, 60,
    ) * 1000,
  }
}
```

The parser rejects non-integer strings, converts seconds to milliseconds exactly once, and
names the exact config field in every error.

- [ ] **Step 5: Wire settings into `config.ts`**

Import the parser/types, add `watchdog` to `LodestarConfig`, and add the project override:

```ts
import {
  parseWatchdogMode,
  parseWatchdogSettings,
  type WatchdogMode,
} from './turn-watchdog'

// In LodestarConfig:
watchdog: {
  codexMode: WatchdogMode
  stallMs: number
  repeatNoopLimit: number
  silentWarnMs: number
  interruptGraceMs: number
}

// In ProjectProfile:
watchdogMode?: WatchdogMode
```

In `projectSections()`, add the exact switch branch so invalid project modes fail closed:

```ts
case 'watchdog_mode':
  profile.watchdogMode = parseWatchdogMode(
    value,
    `projects.${name}.watchdog_mode`,
    configWatchdog.mode,
  )
  break
```

Compute `configWatchdog` before `projectSections()` is called, then include the global policy in
the returned config:

```ts
const configWatchdog = parseWatchdogSettings(t.watchdog)

return {
  feishu: { app_id: appId, app_secret: appSecret },
  runtime: { projects_root: projectsRoot },
  notify: { bind: notifyBind, port: notifyPort },
  watchdog: {
    codexMode: configWatchdog.mode,
    stallMs: configWatchdog.stallMs,
    repeatNoopLimit: configWatchdog.repeatNoopLimit,
    silentWarnMs: configWatchdog.silentWarnMs,
    interruptGraceMs: configWatchdog.interruptGraceMs,
  },
  codex: { env: codexEnv, models: codexModelSections() },
  claude: {
    bin: claudeBin,
    defaultModel: claudeDefaultModel,
    defaultSettingSources: claudeDefaultSettingSources,
    env: claudeEnv,
    models: claudeModelSections(),
  },
  projects: projectSections(),
}
```

Do not add a Claude mode or silently coerce invalid values. Because `projectSections()` closes
over `configWatchdog`, declare `configWatchdog` before that helper.

- [ ] **Step 6: Run and commit Task 2**

```bash
# desc: 验证 watchdog 配置解析
bun test src/turn-watchdog.test.ts src/config.test.ts

# desc: 提交 watchdog 配置
git add src/turn-watchdog.ts src/config.ts src/config.test.ts
git commit -m "feat(config): add Codex watchdog policy"
```

Expected: both files PASS, 0 failures, then one config commit.

---

### Task 3: Recovery card and turn identity contract

**Files:**
- Modify: `src/session-types.ts:10-125`
- Modify: `src/cards/turn.ts:229-302`
- Modify: `src/cards/turn.test.ts:13-100`

- [ ] **Step 1: Add failing recovery-card tests**

Extend the `./turn` imports in `src/cards/turn.test.ts` with
`watchdogFooterContent`, then add:

```ts
test('watchdog resume uses a recovery banner and never renders human input', () => {
  const card = mainConversationCard({
    sessionName: 'probe',
    turn: 2,
    kind: 'watchdog_resume',
    userInputs: ['must not be rendered'],
  }) as any

  expect(card.body.elements[0].content).toBe('🛟 自动恢复 1/1 · 从上次有效进展继续')
  expect(JSON.stringify(card)).not.toContain('📥 收到')
  expect(JSON.stringify(card)).not.toContain('must not be rendered')
  expect(card.body.elements.at(-1).element_id).toBe('footer')
})

test('watchdog footer states are stable and contain no raw tool text', () => {
  expect(watchdogFooterContent('silent_warn')).toBe('⚠️ 长时间无可见进展 · 仍在等待')
  expect(watchdogFooterContent('loop_warn')).toBe('⚠️ 检测到重复空调用 · 未自动中断')
  expect(watchdogFooterContent('recovering')).toBe('🛟 检测到无效循环 · 自动恢复 1/1')
  expect(watchdogFooterContent('interrupted', { idleMs: 900_000, repeatCount: 12 }))
    .toBe('🛟 已自动中断 · 无进展 15m · 重复空调用 x12')
  expect(watchdogFooterContent('exhausted')).toBe('⛔ 自动恢复后仍无进展 · 已停止')
  expect(watchdogFooterContent('failed')).toBe('❌ 自动恢复失败 · thread 恢复失败')
})
```

- [ ] **Step 2: Verify the card tests fail**

```bash
# desc: 验证 watchdog 恢复卡片契约尚未实现
bun test src/cards/turn.test.ts
```

Expected: FAIL because `watchdog_resume` and `watchdogFooterContent` do not exist.

- [ ] **Step 3: Extend `TurnState` with explicit identity and warning state**

Update `src/session-types.ts`:

```ts
export type TurnTrigger = 'user_message' | 'bg_task_resume' | 'watchdog_resume'

export interface TurnState {
  // Existing fields remain unchanged.
  trigger: TurnTrigger
  /** In-memory identity is the TurnState object itself; these backend IDs
   * reject stale app-server events after an async recovery boundary. */
  backendThreadId: string | null
  backendTurnId: string | null
  /** Sticky warning rendered by the normal footer ticker until meaningful progress. */
  footerStatusOverride: string | null
  /** Dedupe app-server compaction phase retries for watchdog progress accounting. */
  watchdogSeenCompactionPhases: Set<string>
}
```

Replace the inline trigger union with `TurnTrigger`; do not add recovery fields to
`AgentProcess` or `CodexProcess`.

- [ ] **Step 4: Implement the card banner and terminal text formatter**

In `src/cards/turn.ts`, extend `MainCardOpts.kind` to include `watchdog_resume`, suppress
inputs for that kind, and add the formatter:

```ts
export type WatchdogFooterState =
  | 'silent_warn'
  | 'loop_warn'
  | 'recovering'
  | 'interrupted'
  | 'exhausted'
  | 'failed'

export function watchdogFooterContent(
  state: WatchdogFooterState,
  detail: { idleMs?: number; repeatCount?: number } = {},
): string {
  switch (state) {
    case 'silent_warn': return '⚠️ 长时间无可见进展 · 仍在等待'
    case 'loop_warn': return '⚠️ 检测到重复空调用 · 未自动中断'
    case 'recovering': return '🛟 检测到无效循环 · 自动恢复 1/1'
    case 'interrupted': {
      const idleMinutes = Math.max(0, Math.floor((detail.idleMs ?? 0) / 60_000))
      return `🛟 已自动中断 · 无进展 ${idleMinutes}m · 重复空调用 x${detail.repeatCount ?? 0}`
    }
    case 'exhausted': return '⛔ 自动恢复后仍无进展 · 已停止'
    case 'failed': return '❌ 自动恢复失败 · thread 恢复失败'
  }
}

const banner = opts.kind === 'card_full'
  ? [{ tag: 'markdown', content: `📨 接续上一张（同一轮 ${providerLabel}，前卡写满或写入受限）` }]
  : opts.kind === 'bg_task_resume'
    ? [{ tag: 'markdown', content: `🔁 后台任务完成，${providerLabel} 继续处理结果 #${opts.turn}` }]
    : opts.kind === 'watchdog_resume'
      ? [{ tag: 'markdown', content: '🛟 自动恢复 1/1 · 从上次有效进展继续' }]
      : []
const inputs = opts.kind === 'watchdog_resume' ? [] : (opts.userInputs ?? [])
```

Keep the existing `user_message`, `card_full`, and `bg_task_resume` rendering unchanged.

- [ ] **Step 5: Update test turn fixtures, run, and commit**

Add these defaults to every central `turnState()` fixture in `src/session.test.ts` when Task 4
starts using the new fields:

```ts
backendThreadId: null,
backendTurnId: null,
footerStatusOverride: null,
watchdogSeenCompactionPhases: new Set(),
```

Then verify and commit the card-only slice:

```bash
# desc: 验证恢复卡片和既有 turn 卡片不回归
bun test src/cards/turn.test.ts

# desc: 提交 watchdog 恢复卡片契约
git add src/session-types.ts src/cards/turn.ts src/cards/turn.test.ts
git commit -m "feat(cards): add watchdog recovery turn states"
```

Expected: `src/cards/turn.test.ts` PASS and one focused commit.

---

### Task 4: Structured progress observation and Session safety snapshot

**Files:**
- Modify: `src/agent-process.ts:70-89`
- Modify: `src/codex-process.ts:547-583`
- Modify: `src/codex-process.test.ts:111-300`
- Modify: `src/session-types.ts:10-125`
- Modify: `src/session.ts:147-420`
- Modify: `src/session.ts:1907-2205`
- Modify: `src/session.ts:2630-3001`
- Modify: `src/session-tools.ts:33-230`
- Modify: `src/session-model.ts:284-340`
- Modify: `src/feishu-test-mock.ts:20-32`
- Modify: `src/session.test.ts`

- [ ] **Step 1: Characterize the real app-server dynamic tool and sub-agent payloads**

Add tests to `src/codex-process.test.ts` using the existing
`Object.create(CodexProcess.prototype)` pattern:

```ts
test('maps dynamic exec arguments and camelCase contentItems without normalization', () => {
  const proc = Object.create(CodexProcess.prototype) as any
  const events: Array<[string, any]> = []
  proc.opts = { workDir: '/tmp' }
  proc.emit = (event: string, payload: unknown) => { events.push([event, payload]); return true }

  proc.handleNotification('item/started', {
    threadId: 'thread-main', turnId: 'turn-main',
    item: { type: 'dynamicToolCall', id: 'call-1', tool: 'exec', arguments: 'text("ready");\n' },
  })
  proc.handleNotification('item/completed', {
    threadId: 'thread-main', turnId: 'turn-main',
    item: {
      type: 'dynamicToolCall', id: 'call-1', tool: 'exec', success: true,
      contentItems: [
        { type: 'inputText', text: 'Script completed\nWall time 0.0 seconds\nOutput:\n' },
        { type: 'inputText', text: 'ready' },
      ],
    },
  })

  expect(events).toEqual([
    ['tool_use', { id: 'call-1', name: 'exec', input: 'text("ready");\n' }],
    ['tool_result', {
      tool_use_id: 'call-1',
      content: JSON.stringify([
        { type: 'inputText', text: 'Script completed\nWall time 0.0 seconds\nOutput:\n' },
        { type: 'inputText', text: 'ready' },
      ], null, 2),
      is_error: false,
    }],
  ])
})

test('emits subAgentActivity as structured progress instead of raw noise', () => {
  const proc = Object.create(CodexProcess.prototype) as any
  const events: Array<[string, any]> = []
  proc.opts = { workDir: '/tmp' }
  proc.emit = (event: string, payload: unknown) => { events.push([event, payload]); return true }

  proc.handleNotification('item/started', {
    threadId: 'thread-main', turnId: 'turn-main',
    item: {
      type: 'subAgentActivity', id: 'activity-start', kind: 'started',
      agentThreadId: 'agent-thread-1', agentPath: '/root/worker-1',
    },
  })
  proc.handleNotification('item/completed', {
    threadId: 'thread-main', turnId: 'turn-main',
    item: {
      type: 'subAgentActivity', id: 'activity-interact', kind: 'interacted',
      agentThreadId: 'agent-thread-1', agentPath: '/root/worker-1',
    },
  })
  proc.handleNotification('item/completed', {
    threadId: 'thread-main', turnId: 'turn-main',
    item: {
      type: 'subAgentActivity', id: 'activity-stop', kind: 'interrupted',
      agentThreadId: 'agent-thread-1', agentPath: '/root/worker-1',
    },
  })

  expect(events).toEqual([
    ['subagent_activity', {
      activityId: 'activity-start', agentThreadId: 'agent-thread-1',
      agentPath: '/root/worker-1', kind: 'started',
    }],
    ['subagent_activity', {
      activityId: 'activity-interact', agentThreadId: 'agent-thread-1',
      agentPath: '/root/worker-1', kind: 'interacted',
    }],
    ['subagent_activity', {
      activityId: 'activity-stop', agentThreadId: 'agent-thread-1',
      agentPath: '/root/worker-1', kind: 'interrupted',
    }],
  ])
})

test('emits collab agent state snapshots alongside the normal tool result', () => {
  const proc = Object.create(CodexProcess.prototype) as any
  const events: Array<[string, any]> = []
  proc.opts = { workDir: '/tmp' }
  proc.emit = (event: string, payload: unknown) => { events.push([event, payload]); return true }
  const agentsStates = {
    agent1: { status: 'running' },
    agent2: { status: 'completed' },
  }

  proc.handleNotification('item/completed', {
    threadId: 'thread-main', turnId: 'turn-main',
    item: { type: 'collabAgentToolCall', id: 'agent-call-1', status: 'completed', agentsStates },
  })

  expect(events).toContainEqual([
    'collab_agent_state',
    { toolUseId: 'agent-call-1', agentsStates },
  ])
  expect(events.some(([event]) => event === 'tool_result')).toBe(true)
})
```

- [ ] **Step 2: Run protocol tests and confirm the sub-agent case is red**

```bash
# desc: 锁定 app-server dynamicToolCall 与 subAgentActivity 事件形状
bun test src/codex-process.test.ts
```

Expected: the dynamic tool characterization passes on existing code; the sub-agent activity
test fails because that item is currently unmapped.

- [ ] **Step 3: Expose sub-agent activity through the existing event emitter**

Add these event types to `AgentProcessEventMap` in `src/agent-process.ts`:

```ts
subagent_activity: {
  activityId: string
  agentThreadId: string
  agentPath: string | null
  kind: string
}
collab_agent_state: { toolUseId: string; agentsStates: Record<string, { status?: string }> }
```

In both `handleItemStarted` and `handleItemCompleted`, before the generic mapping, add:

```ts
if (item.type === 'subAgentActivity') {
  if (typeof item.id !== 'string' || typeof item.agentThreadId !== 'string') return
  this.emit('subagent_activity', {
    activityId: item.id,
    agentThreadId: item.agentThreadId,
    agentPath: typeof item.agentPath === 'string' ? item.agentPath : null,
    kind: typeof item.kind === 'string' ? item.kind : 'unknown',
  })
  return
}
```

In `handleItemCompleted`, emit the raw structured collab snapshot before the existing
`mapCompletedItem` call, while still allowing the normal `tool_result` to be emitted:

```ts
if (item.type === 'collabAgentToolCall' && item.agentsStates && typeof item.agentsStates === 'object') {
  this.emit('collab_agent_state', {
    toolUseId: item.id,
    agentsStates: item.agentsStates,
  })
}
```

This consumes only app-server stdio notifications already in memory. Do not call
`findCodexRolloutFile`, `readFileSync`, or add any polling path.

- [ ] **Step 4: Add failing Session observation, policy, and sticky-warning tests**

Extend `projectProfiles` in `src/feishu-test-mock.ts` to
`Map<string, { cwd?: string; watchdogMode?: WatchdogMode }>` and add the following focused
tests to `src/session.test.ts`:

```ts
describe('Session Codex watchdog observation', () => {
  test('fails closed until app-server binds both thread and turn identity', () => {
    const { session, proc } = wiredWatchdogSession('codex')
    expect(session.watchdogSafetySnapshot(session.watchdogContext).currentTurn).toBe(false)
    proc.emit('turn_started', { thread_id: 'thread-1', turn_id: 'turn-1' })
    expect(session.watchdogSafetySnapshot(session.watchdogContext).currentTurn).toBe(true)
  })

  test('turn_started arriving before card open is consumed by that new TurnState', () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-early')
    session.proc = proc
    session.selectedProvider = 'codex'
    session.openingTurn = true
    session.wireProc(proc)
    proc.emit('turn_started', { thread_id: 'thread-early', turn_id: 'turn-early' })
    const turn = turnState('card-early')
    session.currentTurn = turn
    session.beginWatchdogTurn(turn, proc, 0)
    expect(turn).toMatchObject({ backendThreadId: 'thread-early', backendTurnId: 'turn-early' })
    expect(session.pendingWatchdogIdentity).toBeNull()
  })

  test('cold Codex turn begins observation after start() creates the process', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-cold')
    session.selectedProvider = 'codex'
    session.start = async () => {
      session.proc = proc
      session.wireProc(proc)
      return true
    }
    await session.startColdUserTurn('cold prompt', 'cold prompt', 'ou_user')
    expect(session.currentTurn).not.toBeNull()
    expect(session.watchdogContext).toMatchObject({ proc, turn: session.currentTurn })
    expect(proc.sentTexts).toEqual(['cold prompt'])
  })

  test('records backend identity and counts only a matched no-op result', () => {
    const { session, proc, turn } = wiredWatchdogSession('codex')
    proc.emit('turn_started', { thread_id: 'thread-1', turn_id: 'turn-1' })
    proc.emit('tool_use', { id: 'noop-1', name: 'exec', input: 'text("ready");' })
    expect(session.watchdog.snapshot()).toMatchObject({ repeatCount: 0, pendingCandidateCount: 1 })
    proc.emit('tool_result', { tool_use_id: 'noop-1', content: execResult('ready'), is_error: false })
    expect(turn).toMatchObject({ backendThreadId: 'thread-1', backendTurnId: 'turn-1' })
    expect(session.watchdog.snapshot()).toMatchObject({ repeatCount: 1, pendingCandidateCount: 0 })
  })

  test('meaningful Session events reset no-op evidence', () => {
    const signals = [
      (p: any) => p.emit('assistant_text', { text: 'real answer' }),
      (p: any) => p.emit('tool_use', { id: 'bash-1', name: 'Bash', input: { command: 'pwd' } }),
      (p: any) => p.emit('turn_plan_updated', { explanation: null, plan: [{ step: 'do work', status: 'inProgress' }] }),
      (p: any) => p.emit('thread_goal_updated', { objective: 'ship', status: 'active', tokenBudget: null, tokensUsed: 1, timeUsedSeconds: 1 }),
      (p: any) => p.emit('context_compacted', { itemId: 'compact-1', phase: 'start' }),
      (p: any) => p.emit('subagent_activity', {
        activityId: 'activity-a1', agentThreadId: 'agent-a1',
        agentPath: '/root/a1', kind: 'interacted',
      }),
      (p: any) => p.emit('bg_task_started', { task_id: 'bg-1', task_type: 'workflow', description: 'working' }),
    ]
    for (const signal of signals) {
      const { session, proc } = wiredWatchdogSession('codex')
      confirmSessionNoop(session, proc, 'noop-1')
      signal(proc)
      expect(session.watchdog.snapshot().repeatCount).toBe(0)
    }
  })

  test('token metadata, process errors, and footer ticks do not reset evidence', () => {
    const { session, proc, turn } = wiredWatchdogSession('codex')
    confirmSessionNoop(session, proc, 'noop-1')
    proc.emit('token_usage', { usage: null, totalUsage: null, contextWindow: null })
    proc.emit('error', new Error('transport warning'))
    session.renderFooterStatus(turn, Date.now() + 1_000)
    expect(session.watchdog.snapshot().repeatCount).toBe(1)
  })

  test('Claude and project off policy never begin watchdog observation', () => {
    expect(wiredWatchdogSession('claude').session.watchdogContext).toBeNull()
    projectProfiles.set('probe', { watchdogMode: 'off' })
    expect(wiredWatchdogSession('codex').session.watchdogContext).toBeNull()
  })

  test('warning survives footer ticks and clears on meaningful progress', () => {
    const { session, proc, turn } = wiredWatchdogSession('codex')
    session.applyWatchdogWarning({ type: 'silent_warn', idleMs: 1_800_000 })
    session.renderFooterStatus(turn, Date.now() + 1_000)
    expect(turn.footerStatusOverride).toContain('长时间无可见进展')
    proc.emit('assistant_text', { text: 'progress' })
    expect(turn.footerStatusOverride).toBeNull()
  })

  test('running Codex collab agents block recovery until a terminal snapshot arrives', () => {
    const { session, proc } = wiredWatchdogSession('codex')
    proc.emit('collab_agent_state', {
      toolUseId: 'agent-call-1',
      agentsStates: { a1: { status: 'running' } },
    })
    expect(session.watchdogSafetySnapshot(session.watchdogContext).backgroundWorkRunning).toBe(true)
    proc.emit('collab_agent_state', {
      toolUseId: 'agent-call-1',
      agentsStates: { a1: { status: 'completed' } },
    })
    expect(session.watchdogSafetySnapshot(session.watchdogContext).backgroundWorkRunning).toBe(false)
  })

  test('sub-agent activity uses event identity for dedupe and thread identity for lifecycle', () => {
    const { session, proc } = wiredWatchdogSession('codex')
    const started = {
      activityId: 'activity-start', agentThreadId: 'agent-thread-1',
      agentPath: '/root/worker-1', kind: 'started',
    }
    proc.emit('subagent_activity', started)
    expect(session.watchdogSafetySnapshot(session.watchdogContext).backgroundWorkRunning).toBe(true)
    confirmSessionNoop(session, proc, 'noop-after-start')
    proc.emit('subagent_activity', started)
    expect(session.watchdog.snapshot().repeatCount).toBe(1)
    proc.emit('subagent_activity', {
      activityId: 'activity-interact', agentThreadId: 'agent-thread-1',
      agentPath: '/root/worker-1', kind: 'interacted',
    })
    expect(session.watchdog.snapshot().repeatCount).toBe(0)
    expect(session.watchdogSafetySnapshot(session.watchdogContext).backgroundWorkRunning).toBe(true)
    confirmSessionNoop(session, proc, 'noop-after-interact')
    proc.emit('subagent_activity', {
      activityId: 'activity-stop', agentThreadId: 'agent-thread-1',
      agentPath: '/root/worker-1', kind: 'interrupted',
    })
    expect(session.watchdogSafetySnapshot(session.watchdogContext).backgroundWorkRunning).toBe(false)
    expect(session.watchdog.snapshot().repeatCount).toBe(0)
  })

  test('duplicate background task state does not reset no-op evidence', () => {
    const { session, proc } = wiredWatchdogSession('codex')
    const event = { task_id: 'bg-1', task_type: 'workflow', description: 'working' }
    proc.emit('bg_task_started', event)
    confirmSessionNoop(session, proc, 'noop-after-bg')
    proc.emit('bg_task_started', event)
    expect(session.watchdog.snapshot().repeatCount).toBe(1)
  })

  test('duplicate compaction phase does not reset no-op evidence twice', () => {
    const { session, proc } = wiredWatchdogSession('codex')
    const notice = { itemId: 'compact-1', phase: 'start' }
    proc.emit('context_compacted', notice)
    confirmSessionNoop(session, proc, 'noop-after-compact')
    proc.emit('context_compacted', notice)
    expect(session.watchdog.snapshot().repeatCount).toBe(1)
  })

  test('stale events from a replaced process cannot reset current watchdog evidence', () => {
    const { session, proc: oldProc } = wiredWatchdogSession('codex')
    confirmSessionNoop(session, oldProc, 'noop-1')
    const currentProc = new FakeAgentProc('codex', 'thread-1')
    session.proc = currentProc
    session.watchdogContext.proc = currentProc
    session.wireProc(currentProc)
    oldProc.emit('assistant_text', { text: 'late old text' })
    oldProc.emit('tool_use', { id: 'late-tool', name: 'Bash', input: { command: 'pwd' } })
    oldProc.emit('turn_plan_updated', { explanation: null, plan: [{ step: 'late', status: 'completed' }] })
    expect(session.watchdog.snapshot().repeatCount).toBe(1)
  })
})
```

Add these local test helpers; they install no real process or timer:

```ts
const execResult = (literal: string): string => JSON.stringify([
  { type: 'inputText', text: 'Script completed\nWall time 0.0 seconds\nOutput:\n' },
  { type: 'inputText', text: literal },
])

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now()
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timeout')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function wiredWatchdogSession(provider: 'codex' | 'claude'): {
  session: any
  proc: FakeAgentProc
  turn: any
} {
  const session = new Session('probe', 'chat_id') as any
  const proc = new FakeAgentProc(provider, provider === 'codex' ? 'thread-1' : 'claude-1')
  const turn = turnState('card-watchdog')
  turn.startedAt = 0
  session.proc = proc
  session.selectedProvider = provider
  session.currentTurn = turn
  session.wireProc(proc)
  session.beginWatchdogTurn(turn, proc, 0)
  return { session, proc, turn }
}

function confirmSessionNoop(session: any, proc: FakeAgentProc, id: string): void {
  proc.emit('tool_use', { id, name: 'exec', input: 'text("ready");' })
  proc.emit('tool_result', { tool_use_id: id, content: execResult('ready'), is_error: false })
}
```

- [ ] **Step 5: Add Session watchdog fields, policy, identity, and safety helpers**

Import `config` and the watchdog types into `src/session.ts`, then add:

```ts
type WatchdogTurnContext = {
  proc: AgentProcess
  turn: TurnState
  threadId: string | null
  turnId: string | null
}

watchdog: TurnWatchdog
watchdogContext: WatchdogTurnContext | null = null
watchdogActionInFlight = false
watchdogTickHandle: ReturnType<typeof setInterval> | null = null
modelSwitchPending = false
codexCollabAgentStates = new Map<string, string>()
codexSubagentActivityIds = new Set<string>()
activeCodexSubagentActivities = new Set<string>()
pendingWatchdogIdentity: { proc: AgentProcess; threadId: string | null; turnId: string | null } | null = null

private configuredWatchdogSettings(): WatchdogSettings {
  const project = feishu.tempProjectName(this.sessionName) ?? this.sessionName
  const mode = feishu.projectProfile(project)?.watchdogMode ?? config.watchdog.codexMode
  return {
    mode,
    stallMs: config.watchdog.stallMs,
    repeatNoopLimit: config.watchdog.repeatNoopLimit,
    silentWarnMs: config.watchdog.silentWarnMs,
    interruptGraceMs: config.watchdog.interruptGraceMs,
  }
}

beginWatchdogTurn(turn: TurnState, proc: AgentProcess, now = Date.now()): void {
  this.endWatchdogTurn()
  const settings = this.configuredWatchdogSettings()
  if (proc.provider !== 'codex' || settings.mode === 'off') return
  this.watchdog.beginTurn(`turn:${this.turnCounter}`, turn.trigger, now)
  this.watchdogContext = {
    proc,
    turn,
    threadId: proc.sessionId,
    turnId: null,
  }
  if (this.pendingWatchdogIdentity?.proc === proc) {
    const pending = this.pendingWatchdogIdentity
    this.pendingWatchdogIdentity = null
    this.watchdogContext.threadId = pending.threadId
    this.watchdogContext.turnId = pending.turnId
    turn.backendThreadId = pending.threadId
    turn.backendTurnId = pending.turnId
  }
}

endWatchdogTurn(): void {
  this.watchdog.endTurn()
  this.watchdogContext = null
}

private watchdogContextIsCurrent(ctx: WatchdogTurnContext): boolean {
  return this.watchdogContext === ctx && this.currentTurn === ctx.turn && this.proc === ctx.proc &&
    (!ctx.threadId || ctx.proc.sessionId === ctx.threadId) &&
    (!ctx.turnId || ctx.turn.backendTurnId === ctx.turnId)
}

hasQueuedHumanWork(): boolean {
  // pendingUserMessageCount includes the input already running in the current turn.
  return this.pendingMidTurnMsgs.length > 0 || this.pendingTurnInputs.length > 0 || this.multiMsgBuffer !== null
}

watchdogSafetySnapshot(ctx: WatchdogTurnContext): WatchdogSafetySnapshot {
  const state = this.watchdog.snapshot()
  return {
    // Fail closed until app-server has identified both the primary thread and turn.
    currentTurn: this.watchdogContextIsCurrent(ctx) && !!ctx.threadId && !!ctx.turnId,
    eligibleTrigger: ctx.turn.trigger === 'user_message' || ctx.turn.trigger === 'watchdog_resume' || ctx.turn.trigger === 'bg_task_resume',
    realToolRunning: state.activeRealToolCount > 0 || state.pendingCandidateCount > 0,
    backgroundWorkRunning: cards.hasActiveBgTask(this.backgroundTasks) ||
      this.pendingBgTasks.some(t => !cards.isBgTerminal(t)) ||
      this.activeCodexSubagentActivities.size > 0 ||
      [...this.codexCollabAgentStates.values()].some(status => status === 'pendingInit' || status === 'running'),
    awaitingInput: this.pendingPermissions.size > 0 || this.pendingAsks.size > 0 || this.pendingHostAsks.size > 0,
    compactionRunning: ctx.turn.contextCompactionPending.size > 0,
    rotationRunning: ctx.turn.rotating !== null,
    agyRunning: this.startingAgy || this.runningAgy !== null,
    queuedHumanWork: this.hasQueuedHumanWork(),
    modelSwitchPending: this.modelSwitchPending,
    recoveryActionInFlight: this.watchdogActionInFlight,
  }
}
```

Initialize `watchdog = new TurnWatchdog(this.configuredWatchdogSettings())` exactly once in the
constructor after the model selection is restored. Reuse that object across
`user_message -> watchdog_resume` so `recoveryAttempt` survives; `beginTurn('user_message')`
is the only operation that resets the budget. In
`openTurnCard`, initialize `backendThreadId`, `backendTurnId`, `footerStatusOverride`, and
`watchdogSeenCompactionPhases`, count a
`watchdog_resume` banner in `initialElementCount`, then call `beginWatchdogTurn` only after
`currentTurn = turnState` and only when an agent process exists.

The cold path opens its card before `start()` creates the process. In `startColdUserTurn`, after
`start()` succeeds and before `startThinkingFooter` / `sendUserText`, add:

```ts
if (this.currentTurn && this.proc) {
  this.beginWatchdogTurn(this.currentTurn, this.proc)
}
```

This is the only deferred begin path; eager and drained warm turns still begin inside
`openTurnCard`.

- [ ] **Step 6: Wire meaningful progress at the existing event boundaries**

Add source-aware package-internal Session methods so stale events from a replaced process cannot
touch the new turn:

```ts
observeWatchdogToolStart(source: AgentProcess, id: string, name: string, input: unknown): void {
  const ctx = this.watchdogContext
  if (!ctx || ctx.proc !== source || this.proc !== source) return
  this.watchdog.observeToolStart(id, name, input, Date.now())
}

observeWatchdogToolResult(source: AgentProcess, id: string, content: unknown, isError: boolean): void {
  const ctx = this.watchdogContext
  if (!ctx || ctx.proc !== source || this.proc !== source) return
  this.watchdog.observeToolResult(id, content, isError, Date.now())
}

observeWatchdogMeaningful(source: AgentProcess, label: string): void {
  const ctx = this.watchdogContext
  if (!ctx || ctx.proc !== source || this.proc !== source || !this.watchdogContextIsCurrent(ctx)) return
  this.watchdog.observeMeaningful(Date.now(), label)
  if (ctx.turn.footerStatusOverride) {
    ctx.turn.footerStatusOverride = null
    this.renderFooterStatus(ctx.turn, Date.now())
  }
}
```

Pass `p` from every `wireProc(p)` callback. Change the only two tool helper call sites/signatures to
`sessionTools.addTool(this, p, ...)` and `sessionTools.completeTool(this, p, ...)`; the helpers
forward that source to the methods above before rendering.

Exact call sites:

- `sessionTools.addTool`: `observeWatchdogToolStart(source, id, name, input)` before card mutation.
- `sessionTools.completeTool`: `observeWatchdogToolResult(source, id, content, isError)` before lookup/render.
- nonblank `assistant_text`: `observeWatchdogMeaningful(p, 'assistant_text')` before `appendAssistant`.
- `turn_plan_updated`: pass `p` into the handler, compare old/new `{planSteps, planExplanation}`
  before mutation, and observe only on change.
- nonempty `plan_delta`: pass `p` and observe `plan_delta`.
- compaction start/end: pass `p`, dedupe `${compactionKey(notice)}:${notice.phase ?? 'event'}` in
  `turn.watchdogSeenCompactionPhases`, and observe `context_compaction:<phase>` only on first sight.
- goal update/clear: pass `p`; observe only after `goalDisplaySignature` changes or a real clear.
- `subagent_activity`: reject `p !== this.proc`, dedupe by the per-event `activityId`, use the
  stable `agentThreadId` for the active lifecycle set, and observe each new activity once.
- `bg_task_*`: reject `p !== this.proc`, dedupe the state signature, and observe only when the
  stored status/progress actually changes.
- `collab_agent_state`: merge each agent status into `codexCollabAgentStates`, delete terminal
  `interrupted|completed|errored|shutdown|notFound` entries, then observe `collab_agent_state`.

Use this exact listener for the collab state merge:

```ts
p.on('subagent_activity', ({ activityId, agentThreadId, kind }) => {
  if (this.proc !== p || this.watchdogContext?.proc !== p) return
  if (this.codexSubagentActivityIds.has(activityId)) return
  this.codexSubagentActivityIds.add(activityId)
  if (kind === 'started') this.activeCodexSubagentActivities.add(agentThreadId)
  if (kind === 'interrupted') this.activeCodexSubagentActivities.delete(agentThreadId)
  this.observeWatchdogMeaningful(p, `subagent_activity:${kind}`)
})

p.on('collab_agent_state', ({ agentsStates }) => {
  if (this.proc !== p || this.watchdogContext?.proc !== p) return
  const terminal = new Set(['interrupted', 'completed', 'errored', 'shutdown', 'notFound'])
  let changed = false
  for (const [agentId, state] of Object.entries(agentsStates)) {
    const status = typeof state?.status === 'string' ? state.status : 'notFound'
    if (terminal.has(status)) {
      changed = this.codexCollabAgentStates.delete(agentId) || changed
      changed = this.activeCodexSubagentActivities.delete(agentId) || changed
    }
    else if (this.codexCollabAgentStates.get(agentId) !== status) {
      this.codexCollabAgentStates.set(agentId, status)
      changed = true
    }
  }
  if (![...this.codexCollabAgentStates.values()].some(s => s === 'pendingInit' || s === 'running')) {
    if (this.activeCodexSubagentActivities.size > 0) changed = true
    this.activeCodexSubagentActivities.clear()
  }
  if (changed) this.observeWatchdogMeaningful(p, 'collab_agent_state')
})
```

For each `bg_task_*` listener, compare a stable state projection around the existing reducer and
observe only on change:

```ts
private backgroundWatchdogSignature(): string {
  return JSON.stringify([...this.pendingBgTasks, ...this.backgroundTasks].map(task => ({
    id: task.id,
    status: task.status,
    summary: task.summary ?? null,
    usage: task.usage ?? null,
    lastToolName: task.lastToolName ?? null,
    error: task.error ?? null,
    isBackgrounded: task.isBackgrounded ?? false,
    steps: task.steps,
    endTime: task.endTime ?? null,
  })))
}

const before = this.backgroundWatchdogSignature()
// Keep the existing applyBgStore/onBackgroundTaskChanged logic here.
const after = this.backgroundWatchdogSignature()
if (after !== before) this.observeWatchdogMeaningful(p, 'bg_task_progress')
```

Use the matching event label in each listener. Do not hash or log task descriptions/prompts.

Do not observe `token_usage`, `rate_limits_updated`, `error`, footer render, or duplicate goal state.

- [ ] **Step 7: Make footer warnings sticky and make model switching observable**

Extract the body of the existing footer closure into a package-internal renderer:

```ts
renderFooterStatus(turn: TurnState, now = Date.now()): void {
  if (turn.footerStatusHandle == null || !turn.footerStatusLabel) return
  const elapsedS = Math.max(0, Math.floor((now - turn.footerStatusStartedAt) / 1000))
  const content = turn.footerStatusOverride
    ?? `${turn.footerStatusLabel}(${elapsedS}s)`
  void this.replaceFooterContent(turn.cardId, this.withModel(content))
}

applyWatchdogWarning(verdict: Extract<WatchdogVerdict, { type: 'silent_warn' | 'loop_warn' }>): void {
  const turn = this.currentTurn
  if (!turn) return
  turn.footerStatusOverride = cards.watchdogFooterContent(verdict.type)
  this.renderFooterStatus(turn)
}
```

Have `startFooterStatus` call `renderFooterStatus` from its interval. In `session-model.ts`, wrap
the asynchronous `setModelSettings`/`applyModelSelection` section so the safety snapshot sees it:

```ts
s.modelSwitchPending = true
try {
  if (s.proc?.isAlive() && s.proc.provider === provider && !shouldRespawnIdleClaude) {
    await withTimeout(s.proc.setModelSettings(model, effort), 20_000, 'thread/settings/update')
  }
  await s.applyModelSelection(provider, model, effort)
  if (shouldRespawnIdleClaude) {
    await s.stopIdleCurrentProcess('Claude model profile changed; env will apply on next spawn')
  }
} finally {
  s.modelSwitchPending = false
}
```

- [ ] **Step 8: Record turn identity, verify, and commit**

Change the `turn_started` listener to accept its payload and bind it only to the same live process
and `TurnState`:

```ts
p.on('turn_started', ({ turn_id, thread_id }) => {
  this.persistResumableSessionId()
  const ctx = this.watchdogContext
  if (ctx && this.proc === p && this.currentTurn === ctx.turn) {
    ctx.threadId = thread_id ?? p.sessionId
    ctx.turnId = turn_id ?? null
    ctx.turn.backendThreadId = ctx.threadId
    ctx.turn.backendTurnId = ctx.turnId
  } else if (
    this.proc === p &&
    (this.openingTurn || this.pendingTurnInputs.length > 0 || this.pendingUserMessageCount > 0)
  ) {
    this.pendingWatchdogIdentity = {
      proc: p,
      threadId: thread_id ?? p.sessionId,
      turnId: turn_id ?? null,
    }
  }
  // Keep the existing usage-baseline logic below this block.
})
```

Run the focused suite and commit:

```bash
# desc: 验证 app-server 映射、Session 观察、安全守卫和 sticky warning
bun test src/turn-watchdog.test.ts src/codex-process.test.ts src/session.test.ts

# desc: 提交 Session watchdog 观察层
git add src/agent-process.ts src/codex-process.ts src/codex-process.test.ts src/session-types.ts src/session.ts src/session-tools.ts src/session-model.ts src/feishu-test-mock.ts src/session.test.ts
git commit -m "feat(watchdog): observe Codex turn progress"
```

Expected: all three files PASS; no timer, interrupt, or recovery side effect exists yet.

---

### Task 5: Shared interrupt primitive and turn-settlement waiter

**Files:**
- Modify: `src/session.ts:330-360`
- Modify: `src/session.ts:935-1082`
- Modify: `src/session.ts:1381-1385`
- Modify: `src/session.ts:2078-2205`
- Modify: `src/session-commands.ts:122-183`
- Modify: `src/session.test.ts`

- [ ] **Step 1: Lock the existing human `st` behavior before refactoring**

Add an `interruptCalls` counter and optional synchronous callback to `FakeAgentProc`:

```ts
interruptCalls = 0
onInterrupt: (() => void) | null = null

sendInterrupt(): void {
  this.interruptCalls++
  this.onInterrupt?.()
}
```

Then add this regression test:

```ts
test('human st still cancels queued work, interrupts once, and owns the stopped footer', async () => {
  const session = new Session('probe', 'chat_id') as any
  const proc = new FakeAgentProc('codex', 'thread-1')
  session.proc = proc
  session.currentTurn = turnState('card-stop')
  session.pendingMidTurnMsgs = [
    { text: 'queued', wireText: 'queued', userOpenId: 'ou_user', msgId: 'om_queued' },
  ]
  session.pendingReactionIds.set('om_queued', 'reaction-1')
  session.wireProc(proc)

  await session.runCommand('st')
  expect(proc.interruptCalls).toBe(1)
  expect(session.pendingMidTurnMsgs).toEqual([])
  expect(session.pendingReactionIds.size).toBe(0)
  expect(session.currentTurn).toBeNull()
  proc.emit('result', {})
  await Promise.resolve()
  expect(session.currentTurn).toBeNull()
})
```

Use the existing public `Session.runCommand` wrapper; do not call `runCommand` from
`session-commands.ts` directly in this characterization.

- [ ] **Step 2: Add failing waiter identity and timing tests**

Add:

```ts
describe('Session shared turn interrupt', () => {
  test('registers waiter before sendInterrupt and settles a synchronous result', async () => {
    const { session, proc, turn } = wiredWatchdogSession('codex')
    proc.onInterrupt = () => proc.emit('result', {})
    const interrupt = session.beginTurnInterrupt('watchdog_recover', session.watchdogContext)
    expect(interrupt).not.toBeNull()
    expect(await interrupt.promise).toMatchObject({ type: 'result', proc, turn })
    expect(proc.interruptCalls).toBe(1)
  })

  test('only matching proc and TurnState can settle the waiter', async () => {
    const { session, proc } = wiredWatchdogSession('codex')
    const interrupt = session.beginTurnInterrupt('watchdog_recover', session.watchdogContext)
    const stale = new FakeAgentProc('codex', 'thread-1')
    expect(session.settleTurnInterrupt(stale, 'result')).toBeNull()
    expect(session.settleTurnInterrupt(proc, 'result')).toBe(interrupt)
    expect(await interrupt.promise).toMatchObject({ type: 'result' })
  })

  test('timeout does not masquerade as result or exit', async () => {
    const { session } = wiredWatchdogSession('codex')
    const interrupt = session.beginTurnInterrupt('watchdog_recover', session.watchdogContext)
    expect(await session.waitForTurnSettlement(interrupt, 1)).toEqual({ type: 'timeout' })
  })

  test('duplicate interrupt calls reuse one context and send once', () => {
    const { session, proc } = wiredWatchdogSession('codex')
    const first = session.beginTurnInterrupt('watchdog_recover', session.watchdogContext)
    const second = session.beginTurnInterrupt('watchdog_recover', session.watchdogContext)
    expect(second).toBe(first)
    expect(proc.interruptCalls).toBe(1)
  })
})
```

- [ ] **Step 3: Verify the new tests fail**

```bash
# desc: 验证共享 interrupt waiter 尚未实现且真人 st 基线稳定
bun test src/session.test.ts
```

Expected: the human `st` characterization passes; the new waiter API tests fail.

- [ ] **Step 4: Replace `userInterrupted` with a source-aware interrupt context**

Add these package-internal types and field in `src/session.ts`:

```ts
type TurnInterruptSource = 'user' | 'watchdog_recover' | 'watchdog_exhausted'
type TurnSettlement =
  | { type: 'result'; proc: AgentProcess; turn: TurnState | null }
  | { type: 'exit'; proc: AgentProcess; turn: TurnState | null }
  | { type: 'cancelled'; reason: string }

type TurnInterruptContext = {
  source: TurnInterruptSource
  proc: AgentProcess
  turn: TurnState | null
  threadId: string | null
  turnId: string | null
  promise: Promise<TurnSettlement>
  resolve: (outcome: TurnSettlement) => void
  settled: boolean
}

activeTurnInterrupt: TurnInterruptContext | null = null
```

Remove `userInterrupted`; its semantics move to `activeTurnInterrupt.source === 'user'`.

- [ ] **Step 5: Implement the shared primitive before changing callers**

Add the following methods. The context is installed before `sendInterrupt`, so a synchronous
fake result and a very fast real app-server result cannot beat waiter registration:

```ts
beginTurnInterrupt(
  source: TurnInterruptSource,
  watchdogCtx: WatchdogTurnContext | null = null,
): TurnInterruptContext | null {
  const proc = this.proc
  const turn = this.currentTurn
  if (!proc) return null
  if (source !== 'user' && (!watchdogCtx || !turn || !this.watchdogContextIsCurrent(watchdogCtx))) return null
  if (this.activeTurnInterrupt) {
    const existing = this.activeTurnInterrupt
    return existing.proc === proc && existing.turn === turn && existing.source === source ? existing : null
  }
  let resolve!: (outcome: TurnSettlement) => void
  const promise = new Promise<TurnSettlement>(done => { resolve = done })
  const context: TurnInterruptContext = {
    source,
    proc,
    turn,
    threadId: turn?.backendThreadId ?? proc.sessionId,
    turnId: turn?.backendTurnId ?? null,
    promise,
    resolve,
    settled: false,
  }
  this.activeTurnInterrupt = context
  log(`session "${this.sessionName}": turn interrupt source=${source}`)
  proc.sendInterrupt()
  return context
}

settleTurnInterrupt(proc: AgentProcess, type: 'result' | 'exit'): TurnInterruptContext | null {
  const context = this.activeTurnInterrupt
  if (!context || context.settled || context.proc !== proc) return null
  // Human `st` closes its card immediately, so currentTurn is already null
  // when the matching result arrives. Watchdog owners keep the turn until settlement.
  if (context.source !== 'user' && context.turn && this.currentTurn !== context.turn) return null
  if (context.threadId && proc.sessionId !== context.threadId) return null
  if (context.turnId && context.turn?.backendTurnId !== context.turnId) return null
  context.settled = true
  this.activeTurnInterrupt = null
  context.resolve({ type, proc, turn: context.turn })
  return context
}

cancelTurnInterrupt(reason: string): void {
  const context = this.activeTurnInterrupt
  if (!context || context.settled) return
  context.settled = true
  this.activeTurnInterrupt = null
  context.resolve({ type: 'cancelled', reason })
}

async waitForTurnSettlement(
  context: TurnInterruptContext,
  graceMs: number,
): Promise<TurnSettlement | { type: 'timeout' }> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      context.promise,
      new Promise<{ type: 'timeout' }>(resolve => {
        timer = setTimeout(() => resolve({ type: 'timeout' }), graceMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
```

- [ ] **Step 6: Route `st`, `result`, and `exit` through the primitive**

In `session-commands.ts`, retain all current human queue cancellation, CrossMark, and footer
logic, but replace `s.userInterrupted = true; s.interrupt()` with:

```ts
const interrupt = s.beginTurnInterrupt('user')
if (!interrupt) {
  log(`session "${s.sessionName}": stop command found no live process`)
}
await s.closeTurnCard('🛑 打断')
```

At the very start of the `result` handler, before usage persistence or natural-result handling:

```ts
if (this.proc !== p && this.activeTurnInterrupt?.proc !== p) {
  log(`session "${this.sessionName}": ignore stale ${p.provider} result`)
  return
}
const interrupted = this.settleTurnInterrupt(p, 'result')
if (interrupted?.source === 'user') {
  this.discardOrphanAssistant()
  this.bgResumePending = false
  this.status = 'idle'
  return
}
if (interrupted?.source === 'watchdog_recover' || interrupted?.source === 'watchdog_exhausted') {
  // The recovery owner awaits context.promise, closes the card, and decides the next turn.
  return
}
```

At the start of the matching `exit` handler, settle first. For a watchdog-owned exit, set
`this.proc = null`, mark `stopped`, notify lifecycle, and return without clearing the captured
turn or human queues; Task 6 owns resume and card settlement. Human or natural exit keeps the
existing cleanup behavior.

Add `cancelTurnInterrupt('<reason>')` before destructive cleanup in `stop`, ordinary `restart`,
and `dispose`. A watchdog-specific restart in Task 6 will pass an internal preserve flag and must
not cancel its own context until timeout has been classified.

- [ ] **Step 7: Run and commit the shared primitive**

```bash
# desc: 验证真人 st 回归和 matching result/exit waiter
bun test src/session.test.ts

# desc: 提交共享 turn interrupt 原语
git add src/session.ts src/session-commands.ts src/session.test.ts
git commit -m "refactor(session): share turn interrupt settlement"
```

Expected: `src/session.test.ts` PASS; human `st` remains queue-destructive, while watchdog
interrupt itself does not mutate queued human work.

---

### Task 6: One-shot recovery, exit handling, and strict same-thread fallback

**Files:**
- Modify: `src/turn-watchdog.ts`
- Modify: `src/turn-watchdog.test.ts`
- Modify: `src/session-util.ts:13-20`
- Modify: `src/session.ts:107-145`
- Modify: `src/session.ts:987-1107`
- Modify: `src/session.ts:2281-2435`
- Modify: `src/session.ts:3030-3161`
- Modify: `src/session.test.ts`

- [ ] **Step 1: Add failing tests for the three settlement outcomes**

Add these tests; each replaces `session.restart` locally when it needs to count or control that
branch:

```ts
describe('Session watchdog recover-once action', () => {
  test('result continues on the live process without respawn', async () => {
    const { session, proc } = armedRecoverySession()
    let restartCalls = 0
    session.restart = async () => { restartCalls++; return true }
    proc.onInterrupt = () => proc.emit('result', {})
    await session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)

    expect(proc.killCalls).toBe(0)
    expect(restartCalls).toBe(0)
    expect(proc.sentTexts).toEqual([WATCHDOG_RECOVERY_PROMPT])
    expect(session.currentTurn.trigger).toBe('watchdog_resume')
    expect(session.watchdog.snapshot().recoveryAttempt).toBe(1)
  })

  test('process exit settles the old turn then immediately resumes the same thread', async () => {
    const { session, proc } = armedRecoverySession()
    const resumed = new FakeAgentProc('codex', 'thread-1')
    session.restart = async (resume: boolean, opts: any) => {
      expect(resume).toBe(true)
      expect(opts).toMatchObject({ requireResumeSession: true, preserveCurrentTurn: true, preserveQueuedHumanWork: true })
      session.proc = resumed
      return true
    }
    proc.onInterrupt = () => proc.emit('exit', { code: 0, signal: 'SIGTERM', expected: true })
    await session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)
    expect(resumed.sentTexts).toEqual([WATCHDOG_RECOVERY_PROMPT])
  })

  test('grace timeout cancels the waiter then tears down and resumes once', async () => {
    const { session } = armedRecoverySession({ interruptGraceMs: 1 })
    let resumes = 0
    session.restart = async () => {
      resumes++
      session.proc = new FakeAgentProc('codex', 'thread-1')
      return true
    }
    await session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)
    expect(resumes).toBe(1)
    expect(session.activeTurnInterrupt).toBeNull()
  })

  test('strict resume failure stops visibly and never sends a recovery prompt', async () => {
    const { session, proc } = armedRecoverySession({ interruptGraceMs: 1 })
    session.restart = async () => false
    await session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)
    expect(session.status).toBe('stopped')
    expect(proc.sentTexts).toEqual([])
    expect(sentCards.some(card => JSON.stringify(card).includes('自动恢复 1/1'))).toBe(false)
  })

  test('footer patch failure cannot prevent the soft interrupt', async () => {
    const { session, proc } = armedRecoverySession()
    session.replaceFooterContent = async () => { throw new Error('card unavailable') }
    const action = session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)
    await waitFor(() => proc.interruptCalls === 1)
    proc.emit('result', {})
    await action
  })
})
```

`armedRecoverySession` must create a Codex Session with one live `TurnState`, bind
`thread-1/turn-1`, install a short test watchdog setting when requested, and spy on restart
without spawning a real app-server. Keep the helper local to the test file; import the fixed
prompt for an exact assertion.

Use this concrete helper and verdict fixture:

```ts
const recoverVerdict = {
  type: 'recover',
  idleMs: 900_000,
  repeatCount: 10,
  fingerprintHash: 'a'.repeat(64),
} as const

function armedRecoverySession(
  override: Partial<WatchdogSettings> = {},
): { session: any; proc: FakeAgentProc; turn: any } {
  const { session, proc, turn } = wiredWatchdogSession('codex')
  const settings = { ...DEFAULT_CODEX_WATCHDOG, ...override }
  session.configuredWatchdogSettings = () => settings
  session.watchdog = new TurnWatchdog(settings)
  session.beginWatchdogTurn(turn, proc, 0)
  proc.emit('turn_started', { thread_id: 'thread-1', turn_id: 'turn-1' })
  return { session, proc, turn }
}
```

- [ ] **Step 2: Verify all recovery branches are red**

```bash
# desc: 验证 result、exit、timeout 和 resume failure 恢复分支尚未实现
bun test src/session.test.ts
```

Expected: FAIL because `runWatchdogRecovery` and the internal restart flags do not exist.

- [ ] **Step 3: Add fail-closed internal lifecycle options**

Extend `LifecycleProgressOpts` in `src/session-util.ts`:

```ts
/** Internal watchdog transaction flags; ordinary commands leave all false. */
requireResumeSession?: boolean
preserveCurrentTurn?: boolean
preserveQueuedHumanWork?: boolean
```

At the top of `restart`, before killing or clearing anything, fail closed when strict resume has
no persisted thread:

```ts
const prevSessionId = this.lastSessionId
if (resume && opts.requireResumeSession && !prevSessionId) {
  const message = '❌ 自动恢复失败:没有可恢复的 thread'
  opts.onStatus?.(message)
  log(`session "${this.sessionName}": watchdog strict resume rejected missing thread`)
  this.status = 'stopped'
  this.opts.onLifecycleChange?.()
  return false
}
```

Then gate only the existing destructive cleanup, without changing ordinary restart behavior:

```ts
if (!opts.preserveCurrentTurn) {
  this.stopFooterStatus(this.currentTurn)
  this.currentTurn = null
} else {
  this.stopFooterStatus(this.currentTurn)
}

this.pendingUserMessageCount = 0
if (!opts.preserveQueuedHumanWork) {
  this.clearMultiMsgBuffer('restart')
  this.pendingMidTurnMsgs = []
  this.pendingTurnInputs = []
  this.lastUserOpenId = ''
  this.releaseAllReactions()
}
```

Do not clear `watchdogContext`, `activeTurnInterrupt`, or `watchdogActionInFlight` inside the
preserving path. Ordinary `restart` still cancels them before cleanup.

- [ ] **Step 4: Keep queued reactions owned by the next human turn**

Extend `closeTurnCard` options:

```ts
opts: {
  forcePush?: boolean
  hasFreshResult?: boolean
  preservePendingReactions?: boolean
} = {}
```

At the reaction-release block, always release `currentBatchReactionIds`, but leave
`pendingReactionIds` untouched when recovery has queued human work:

```ts
const releaseEntries = [
  ...this.currentBatchReactionIds.entries(),
  ...(opts.preservePendingReactions ? [] : this.pendingReactionIds.entries()),
]
for (const [msgId, rid] of releaseEntries) {
  if (rid) void feishu.deleteReaction(msgId, rid)
}
this.currentBatchReactionIds = new Map()
if (!opts.preservePendingReactions) this.pendingReactionIds = new Map()
```

This preserves reaction ownership for `drainMidTurnAndOpen`, which moves those ids into the next
turn's `currentBatchReactionIds`.

- [ ] **Step 5: Add fixed prompt, safe logging, and identity helpers**

Add constants and a log helper near the other Session constants:

```ts
export const WATCHDOG_RECOVERY_PROMPT = `[Lodestar 自动恢复 1/1]
上一轮在最后一次有效进展后持续产生相同的无副作用空调用,已被中断。
请基于当前 thread 和工作区继续未完成任务。先核对现状和上次有效动作,
不要用空的 text(...) 调用代替实际派发、等待或结果汇报。
完成任务或遇到真实阻塞时直接给出明确结果。`

export type WatchdogLogEvent =
  | 'turn_watchdog_silent_warn'
  | 'turn_watchdog_loop_warn'
  | 'turn_watchdog_recover_start'
  | 'turn_watchdog_interrupt_settled'
  | 'turn_watchdog_resume_fallback'
  | 'turn_watchdog_recover_started'
  | 'turn_watchdog_exhausted'
  | 'turn_watchdog_recover_failed'

export interface WatchdogLogFields {
  session: string
  threadId: string | null
  turnId: string | null
  idleMs?: number
  repeatCount?: number
  fingerprintHash?: string
  attempt: 0 | 1
  outcome?: string
}

export function formatWatchdogLog(event: WatchdogLogEvent, fields: WatchdogLogFields): string {
  return [
    `event=${event}`,
    `session=${JSON.stringify(fields.session)}`,
    'provider=codex',
    `thread=${(fields.threadId ?? '-').slice(0, 8)}`,
    `turn=${(fields.turnId ?? '-').slice(0, 8)}`,
    `idle_s=${Math.floor((fields.idleMs ?? 0) / 1000)}`,
    `repeat=${fields.repeatCount ?? 0}`,
    `fingerprint=${fields.fingerprintHash ?? '-'}`,
    `attempt=${fields.attempt}`,
    `outcome=${fields.outcome ?? '-'}`,
  ].join(' ')
}

private logWatchdog(
  event: WatchdogLogEvent,
  ctx: WatchdogTurnContext,
  detail: { idleMs?: number; repeatCount?: number; fingerprintHash?: string; outcome?: string } = {},
): void {
  log(formatWatchdogLog(event, {
    session: this.sessionName,
    threadId: ctx.threadId,
    turnId: ctx.turnId,
    idleMs: detail.idleMs,
    repeatCount: detail.repeatCount,
    fingerprintHash: detail.fingerprintHash,
    attempt: this.watchdog.snapshot().recoveryAttempt,
    outcome: detail.outcome,
  }))
}
```

Put `WatchdogLogEvent`, `WatchdogLogFields`, and `formatWatchdogLog` in
`src/turn-watchdog.ts`; import the formatter into Session. Add a pure test that passes full
`thread-123456789` / `turn-123456789` ids and asserts only the first eight characters appear. Also
assert the formatted line does not contain `ready`, the fixed recovery prompt, `api_key`, or any
config environment variable. The formatter's type deliberately accepts none of those raw fields.

```ts
test('watchdog log formatter truncates identity and cannot carry raw task data', () => {
  const line = formatWatchdogLog('turn_watchdog_recover_start', {
    session: 'pokemon',
    threadId: 'thread-123456789',
    turnId: 'turn-123456789',
    idleMs: 900_000,
    repeatCount: 10,
    fingerprintHash: 'a'.repeat(64),
    attempt: 1,
    outcome: 'result',
  })
  expect(line).toContain('thread=thread-1')
  expect(line).toContain('turn=turn-123')
  expect(line).not.toContain('thread-123456789')
  expect(line).not.toContain('turn-123456789')
  expect(line).not.toMatch(/ready|Lodestar 自动恢复|api_key|OPENAI_API_KEY/)
})
```

Add an identity check that allows the process to be replaced only after strict resume:

```ts
private watchdogTurnStillOwned(ctx: WatchdogTurnContext): boolean {
  return this.currentTurn === ctx.turn &&
    (!ctx.threadId || ctx.turn.backendThreadId === ctx.threadId) &&
    (!ctx.turnId || ctx.turn.backendTurnId === ctx.turnId)
}

private watchdogGuardsPass(ctx: WatchdogTurnContext, ignoreActionLatch = false): boolean {
  const safety = this.watchdogSafetySnapshot(ctx)
  return safety.currentTurn && safety.eligibleTrigger && !safety.realToolRunning &&
    !safety.backgroundWorkRunning && !safety.awaitingInput && !safety.compactionRunning &&
    !safety.rotationRunning && !safety.agyRunning && !safety.queuedHumanWork &&
    !safety.modelSwitchPending && (ignoreActionLatch || !safety.recoveryActionInFlight)
}
```

- [ ] **Step 6: Open the internal recovery turn without touching the human queue**

Add:

```ts
private async startWatchdogResumeTurn(
  userOpenId: string,
): Promise<'started' | 'human_priority' | 'failed'> {
  if (!this.proc?.isAlive() || this.currentTurn || this.openingTurn || this.hasQueuedHumanWork()) return 'failed'
  this.openingTurn = true
  try {
    await this.openTurnCard(userOpenId, 'watchdog_resume')
    if (!this.currentTurn) return 'failed'
    // A human message can arrive during sendCard/id_convert. It must win even
    // though the recovery card has already been created.
    if (this.hasQueuedHumanWork()) {
      await this.closeTurnCard('🛟 自动恢复取消 · 真人消息优先', {
        preservePendingReactions: true,
      })
      if (this.pendingMidTurnMsgs.length > 0) await this.drainMidTurnAndOpen()
      else this.status = 'idle'
      return 'human_priority'
    }
    this.proc.sendUserText(WATCHDOG_RECOVERY_PROMPT, [])
    this.status = 'working'
    return 'started'
  } finally {
    this.openingTurn = false
  }
}
```

Do not push the fixed prompt into `pendingTurnInputs`, do not increment
`pendingUserMessageCount`, and do not render a `📥 收到` panel.

- [ ] **Step 7: Implement the recovery transaction**

Add this method, preserving the branch distinction required by the design:

```ts
async runWatchdogRecovery(
  ctx: WatchdogTurnContext,
  verdict: Extract<WatchdogVerdict, { type: 'recover' }>,
): Promise<void> {
  if (!this.watchdogGuardsPass(ctx)) return
  this.watchdogActionInFlight = true
  this.stopFooterStatus(ctx.turn)
  ctx.turn.footerStatusOverride = cards.watchdogFooterContent('recovering')
  try {
    try { await this.replaceFooterContent(ctx.turn.cardId, this.withModel(ctx.turn.footerStatusOverride)) }
    catch (e) { log(`session "${this.sessionName}": watchdog footer patch failed: ${messageOf(e)}`) }

    // Second guard is deliberately after the card await and immediately before interrupt.
    if (!this.watchdogGuardsPass(ctx, true)) {
      ctx.turn.footerStatusOverride = null
      this.startThinkingFooter(ctx.turn)
      return
    }
    this.watchdog.consumeRecovery()
    this.logWatchdog('turn_watchdog_recover_start', ctx, verdict)
    const interrupt = this.beginTurnInterrupt('watchdog_recover', ctx)
    if (!interrupt) return
    const outcome = await this.waitForTurnSettlement(interrupt, this.configuredWatchdogSettings().interruptGraceMs)
    this.logWatchdog('turn_watchdog_interrupt_settled', ctx, { ...verdict, outcome: outcome.type })

    let liveProcess = outcome.type === 'result' && this.proc === ctx.proc && this.proc.isAlive()
    if (outcome.type === 'timeout') {
      this.cancelTurnInterrupt('watchdog grace timeout')
      this.logWatchdog('turn_watchdog_resume_fallback', ctx, { ...verdict, outcome: 'timeout' })
    } else if (outcome.type === 'exit') {
      this.logWatchdog('turn_watchdog_resume_fallback', ctx, { ...verdict, outcome: 'exit' })
    } else if (outcome.type === 'cancelled') {
      return
    }

    if (!liveProcess) {
      if (!this.watchdogTurnStillOwned(ctx)) return
      const resumed = await this.restart(true, {
        announce: false,
        requireResumeSession: true,
        preserveCurrentTurn: true,
        preserveQueuedHumanWork: true,
      })
      if (!resumed || !this.proc?.isAlive() || (ctx.threadId && this.proc.sessionId !== ctx.threadId)) {
        await this.closeTurnCard(cards.watchdogFooterContent('failed'), {
          forcePush: true,
          preservePendingReactions: true,
        })
        this.status = 'stopped'
        this.logWatchdog('turn_watchdog_recover_failed', ctx, { ...verdict, outcome: 'resume_failed' })
        return
      }
      liveProcess = true
    }

    if (!this.watchdogTurnStillOwned(ctx) || !liveProcess) return
    await this.closeTurnCard(cards.watchdogFooterContent('interrupted', verdict), {
      forcePush: true,
      // New messages can arrive while closeTurnCard awaits Card Kit; their
      // reactions belong to the next human turn, never the old card.
      preservePendingReactions: true,
    })
    if (this.hasQueuedHumanWork()) {
      if (this.pendingMidTurnMsgs.length > 0) await this.drainMidTurnAndOpen()
      else this.status = 'idle'
      return
    }
    const start = await this.startWatchdogResumeTurn(ctx.turn.userOpenId)
    if (start === 'started') {
      this.logWatchdog('turn_watchdog_recover_started', ctx, verdict)
    } else if (start === 'failed') {
      this.status = 'stopped'
      await feishu.sendTextRaw(this.chatId, cards.watchdogFooterContent('failed'))
      this.logWatchdog('turn_watchdog_recover_failed', ctx, { ...verdict, outcome: 'open_failed' })
    }
  } finally {
    this.watchdogActionInFlight = false
  }
}
```

If `multiMsgBuffer` becomes non-null during recovery, close the old turn but do not send the
internal prompt; the normal `<<<` flush will later create the human turn.

- [ ] **Step 8: Run the recovery suite and commit**

```bash
# desc: 验证 soft result、process exit、timeout fallback 和 resume failure
bun test src/turn-watchdog.test.ts src/session.test.ts src/cards/turn.test.ts

# desc: 提交一次性同 thread 自动恢复事务
git add src/turn-watchdog.ts src/turn-watchdog.test.ts src/session-util.ts src/session.ts src/session.test.ts
git commit -m "feat(watchdog): recover one stalled Codex turn"
```

Expected: all targeted tests PASS. Neither tests nor implementation operate the Lodestar daemon.

---

### Task 7: Watchdog scheduler, human-message races, exhausted budget, and cleanup

**Files:**
- Modify: `src/session.ts`
- Modify: `src/session-commands.ts`
- Modify: `src/feishu-test-mock.ts`
- Modify: `src/session.test.ts`
- Modify: `src/turn-watchdog.test.ts`

- [ ] **Step 1: Add race tests before enabling the 15-second scheduler**

First extend the existing top-level `afterEach` so any recovery turn left open by a test cannot
leave a 15-second interval running into the next case:

```ts
afterEach(() => {
  for (const session of Session.all) {
    ;(session as any).clearWatchdogRuntime?.('test cleanup')
  }
})
```

Then add deterministic gates instead of sleeping:

```ts
test('human input after verdict but before interrupt cancels without consuming the budget', async () => {
  const { session, proc } = armedRecoverySession()
  let releasePatch!: () => void
  session.replaceFooterContent = () => new Promise<void>(resolve => { releasePatch = resolve })
  const action = session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)
  await session.onUserMessage('human wins', ['/tmp/a.png'], 'ou_human', 'om_human')
  releasePatch()
  await action
  expect(proc.interruptCalls).toBe(0)
  expect(session.watchdog.snapshot().recoveryAttempt).toBe(0)
  expect(session.pendingMidTurnMsgs[0].wireText).toBe('[file: /tmp/a.png]\nhuman wins')
})

test('human input during grace runs next and suppresses the internal prompt', async () => {
  const { session, proc } = armedRecoverySession()
  const action = session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)
  await waitFor(() => proc.interruptCalls === 1)
  await session.onUserMessage('first', ['/tmp/one.png'], 'ou_human', 'om_first')
  await session.onUserMessage('second', ['/tmp/two.png'], 'ou_human', 'om_second')
  proc.emit('result', {})
  await action

  expect(proc.sentTexts).toEqual([
    '[file: /tmp/one.png]\nfirst\n\n[file: /tmp/two.png]\nsecond',
  ])
  expect(proc.sentTexts).not.toContain(WATCHDOG_RECOVERY_PROMPT)
  expect(session.currentTurn.trigger).toBe('user_message')
  expect(session.currentTurn.userOpenId).toBe('ou_human')
  expect(deletedReactions).not.toContainEqual(['om_first', expect.any(String)])
})

test('human input arriving while strict resume waits is preserved on the resumed process', async () => {
  const { session } = armedRecoverySession({ interruptGraceMs: 1 })
  const resumed = new FakeAgentProc('codex', 'thread-1')
  let releaseResume!: () => void
  session.restart = async () => {
    await new Promise<void>(resolve => { releaseResume = resolve })
    session.proc = resumed
    session.wireProc(resumed)
    return true
  }
  const action = session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)
  await waitFor(() => typeof releaseResume === 'function')
  await session.onUserMessage('during resume', ['/tmp/r.txt'], 'ou_human', 'om_resume')
  releaseResume()
  await action
  expect(resumed.sentTexts).toEqual(['[file: /tmp/r.txt]\nduring resume'])
  expect(resumed.sentTexts).not.toContain(WATCHDOG_RECOVERY_PROMPT)
})

test('human input during recovery-card creation closes that empty card and wins', async () => {
  const { session, proc } = armedRecoverySession()
  const realOpen = session.openTurnCard.bind(session)
  let releaseRecoveryCard!: () => void
  session.openTurnCard = async (...args: any[]) => {
    if (args[1] === 'watchdog_resume') {
      await new Promise<void>(resolve => { releaseRecoveryCard = resolve })
    }
    return await realOpen(...args)
  }
  proc.onInterrupt = () => proc.emit('result', {})
  const action = session.runWatchdogRecovery(session.watchdogContext, recoverVerdict)
  await waitFor(() => typeof releaseRecoveryCard === 'function')
  await session.onUserMessage('wins during card open', [], 'ou_human', 'om_open')
  releaseRecoveryCard()
  await action
  expect(proc.sentTexts).toEqual(['wins during card open'])
  expect(proc.sentTexts).not.toContain(WATCHDOG_RECOVERY_PROMPT)
  expect(session.currentTurn.trigger).toBe('user_message')
})

test('two due ticks launch only one recovery action', async () => {
  const { session, proc } = dueWatchdogSession()
  session.evaluateWatchdogTick(900_000)
  session.evaluateWatchdogTick(900_000)
  await waitFor(() => proc.interruptCalls === 1)
  proc.emit('result', {})
  await waitFor(() => session.currentTurn?.trigger === 'watchdog_resume')
})

test('an open multi-message buffer suppresses recovery and survives watchdog restart options', () => {
  const { session, proc } = dueWatchdogSession()
  session.multiMsgBuffer = [{ text: 'part one', files: [], userOpenId: 'ou_human', msgId: 'om_part' }]
  session.evaluateWatchdogTick(900_000)
  expect(proc.interruptCalls).toBe(0)
  expect(session.multiMsgBuffer).toHaveLength(1)
})
```

Use this helper so the due timestamp is deterministic and does not depend on wall clock:

```ts
function dueWatchdogSession(
  opts: { recoveryAttempt?: 0 | 1 } = {},
): { session: any; proc: FakeAgentProc; turn: any } {
  const armed = armedRecoverySession()
  for (let i = 0; i < 10; i++) {
    armed.session.watchdog.observeToolStart(`noop-${i}`, 'exec', 'text("ready");', i)
    armed.session.watchdog.observeToolResult(`noop-${i}`, execResult('ready'), false, i)
  }
  if (opts.recoveryAttempt === 1) armed.session.watchdog.consumeRecovery()
  return armed
}
```

The attachment assertions use existing inline `[file: ...]` wire text; do not add a second file
transport.

- [ ] **Step 2: Add exhausted-budget and lifecycle cleanup tests**

```ts
test('a second confirmed loop interrupts and stops without a third turn', async () => {
  const { session, proc } = dueWatchdogSession({ recoveryAttempt: 1 })
  const before = sentCards.length
  session.evaluateWatchdogTick(900_000)
  proc.emit('result', {})
  await waitFor(() => session.currentTurn === null)
  expect(proc.interruptCalls).toBe(1)
  expect(proc.sentTexts).not.toContain(WATCHDOG_RECOVERY_PROMPT)
  expect(sentCards.length).toBe(before)
  expect(session.status).toBe('idle')
})

test('human input after exhausted interrupt is a new human chain, not auto continuation', async () => {
  const { session, proc } = dueWatchdogSession({ recoveryAttempt: 1 })
  session.evaluateWatchdogTick(900_000)
  await session.onUserMessage('new human task', [], 'ou_human', 'om_new')
  proc.emit('result', {})
  await waitFor(() => session.currentTurn?.trigger === 'user_message')
  expect(session.watchdog.snapshot().recoveryAttempt).toBe(0)
  expect(proc.sentTexts).toContain('new human task')
})

test('natural result and natural exit clear the watchdog turn', async () => {
  for (const terminal of ['result', 'exit'] as const) {
    const { session, proc } = armedRecoverySession()
    session.startWatchdogTick(session.watchdogContext)
    proc.emit(terminal, terminal === 'exit'
      ? { code: 1, signal: null, expected: false }
      : {})
    await waitFor(() => session.watchdogContext === null)
    expect(session.watchdogTickHandle).toBeNull()
    expect(session.activeTurnInterrupt).toBeNull()
  }
})

test('full stop, ordinary restart, and dispose cancel an outstanding waiter', async () => {
  const stopped = armedRecoverySession()
  stopped.session.startWatchdogTick(stopped.session.watchdogContext)
  stopped.session.beginTurnInterrupt('watchdog_recover', stopped.session.watchdogContext)
  await stopped.session.stop('test stop', { announce: false })
  expect(stopped.session.activeTurnInterrupt).toBeNull()
  expect(stopped.session.watchdogTickHandle).toBeNull()

  const restarted = armedRecoverySession()
  restarted.session.startWatchdogTick(restarted.session.watchdogContext)
  restarted.session.beginTurnInterrupt('watchdog_recover', restarted.session.watchdogContext)
  restarted.session.start = async () => true
  await restarted.session.restart(false, { announce: false })
  expect(restarted.session.activeTurnInterrupt).toBeNull()
  expect(restarted.session.watchdogTickHandle).toBeNull()

  const disposed = armedRecoverySession()
  disposed.session.startWatchdogTick(disposed.session.watchdogContext)
  disposed.session.beginTurnInterrupt('watchdog_recover', disposed.session.watchdogContext)
  disposed.session.dispose()
  expect(disposed.session.activeTurnInterrupt).toBeNull()
  expect(disposed.session.watchdogTickHandle).toBeNull()
})
```

Add the command-path assertion as well:

```ts
const killed = armedRecoverySession()
killed.session.startWatchdogTick(killed.session.watchdogContext)
killed.session.beginTurnInterrupt('watchdog_recover', killed.session.watchdogContext)
await killed.session.runCommand('kl')
expect(killed.session.activeTurnInterrupt).toBeNull()
expect(killed.session.watchdogTickHandle).toBeNull()
```

- [ ] **Step 3: Verify races and exhaustion are red**

```bash
# desc: 验证消息竞态、恢复耗尽和 watchdog 生命周期清理尚未完成
bun test src/turn-watchdog.test.ts src/session.test.ts
```

Expected: FAIL because no scheduler or exhausted action exists and recovery-time input is not yet
explicitly owned.

- [ ] **Step 4: Factor human queue/reaction ownership out of `onUserMessage`**

Move the local reaction closure to a package-internal method and reuse it everywhere:

```ts
trackQueuedReaction(msgId: string): void {
  if (!msgId) return
  this.pendingReactionIds.set(msgId, '')
  void (async () => {
    const rid = await feishu.addReaction(msgId, 'OneSecond')
    if (!rid) return
    if (this.pendingReactionIds.has(msgId)) this.pendingReactionIds.set(msgId, rid)
    else if (this.currentBatchReactionIds.has(msgId)) this.currentBatchReactionIds.set(msgId, rid)
    else void feishu.deleteReaction(msgId, rid)
  })()
}

private queueHumanMessage(
  text: string,
  wireText: string,
  userOpenId: string,
  msgId: string,
): void {
  this.lastUserOpenId = userOpenId
  this.pendingMidTurnMsgs.push({ text, wireText, userOpenId, msgId })
  this.trackQueuedReaction(msgId)
}
```

In `src/feishu-test-mock.ts`, add an `addedReactions` capture and `addReaction` mock returning a
stable id such as `reaction-${messageId}`; reset it in `resetFeishuMock`. This lets the race tests
prove the old card neither deletes nor duplicates the next turn's reaction.

Compute `filePrefix`/`wireText` near the start of `onUserMessage`. Before the normal process/cold
start branches, add:

```ts
if (this.watchdogActionInFlight || this.watchdogResumeFailed) {
  this.queueHumanMessage(text, wireText, userOpenId, msgId)
  if (this.watchdogResumeFailed) {
    await feishu.sendText(this.chatId, '⚠️ thread 自动恢复失败；这条消息已保留，修复后发送 restart 继续。')
  }
  return
}
```

Replace all existing `pendingMidTurnMsgs.push + trackReaction` pairs with
`queueHumanMessage`. This keeps messages arriving while `restart` temporarily sets `proc = null`
out of `startColdUserTurn`.

- [ ] **Step 5: Add the scheduler and warning dispatcher**

Add `WATCHDOG_TICK_MS = 15_000` and:

```ts
startWatchdogTick(ctx: WatchdogTurnContext): void {
  this.stopWatchdogTick()
  if (!this.watchdogContextIsCurrent(ctx)) return
  this.watchdogTickHandle = setInterval(() => this.evaluateWatchdogTick(), WATCHDOG_TICK_MS)
}

stopWatchdogTick(): void {
  if (this.watchdogTickHandle) clearInterval(this.watchdogTickHandle)
  this.watchdogTickHandle = null
}

evaluateWatchdogTick(now = Date.now()): void {
  const ctx = this.watchdogContext
  if (!ctx || !this.watchdogContextIsCurrent(ctx)) {
    this.stopWatchdogTick()
    return
  }
  const verdict = this.watchdog.evaluate(now, this.watchdogSafetySnapshot(ctx))
  if (verdict.type === 'none') return
  if (verdict.type === 'silent_warn' || verdict.type === 'loop_warn') {
    this.applyWatchdogWarning(verdict)
    this.logWatchdog(
      verdict.type === 'silent_warn' ? 'turn_watchdog_silent_warn' : 'turn_watchdog_loop_warn',
      ctx,
      verdict,
    )
    return
  }
  if (verdict.type === 'recover') {
    void this.runWatchdogRecovery(ctx, verdict)
    return
  }
  void this.runWatchdogExhausted(ctx, verdict)
}
```

Call `startWatchdogTick` at the end of `beginWatchdogTurn`. Do not create a tick for Claude,
project mode `off`, no current turn, or `bg_task_resume` mode `off`. The pure state machine keeps
`bg_task_resume` warning-only.

- [ ] **Step 6: Implement stop-only behavior after the recovery budget is exhausted**

```ts
async runWatchdogExhausted(
  ctx: WatchdogTurnContext,
  verdict: Extract<WatchdogVerdict, { type: 'stop_exhausted' }>,
): Promise<void> {
  if (!this.watchdogGuardsPass(ctx)) return
  this.watchdogActionInFlight = true
  this.stopFooterStatus(ctx.turn)
  try {
    if (!this.watchdogGuardsPass(ctx, true)) return
    const interrupt = this.beginTurnInterrupt('watchdog_exhausted', ctx)
    if (!interrupt) return
    const outcome = await this.waitForTurnSettlement(interrupt, this.configuredWatchdogSettings().interruptGraceMs)
    if (outcome.type === 'timeout') {
      this.cancelTurnInterrupt('watchdog exhausted timeout')
      const proc = this.proc
      if (proc === ctx.proc) {
        this.proc = null
        await proc.kill().catch(() => {})
      }
    } else if (outcome.type === 'cancelled') {
      return
    }

    await this.closeTurnCard(cards.watchdogFooterContent('exhausted'), {
      forcePush: true,
      preservePendingReactions: true,
    })
    this.logWatchdog('turn_watchdog_exhausted', ctx, { ...verdict, outcome: outcome.type })

    // A human message after interrupt starts a new task chain; it is not an automatic retry.
    if (this.hasQueuedHumanWork()) {
      if (!this.proc?.isAlive()) {
        const resumed = await this.restart(true, {
          announce: false,
          requireResumeSession: true,
          preserveQueuedHumanWork: true,
        })
        if (!resumed) {
          this.watchdogResumeFailed = true
          this.status = 'stopped'
          return
        }
      }
      if (this.pendingMidTurnMsgs.length > 0) await this.drainMidTurnAndOpen()
      return
    }
    this.status = this.proc?.isAlive() ? 'idle' : 'stopped'
  } finally {
    this.watchdogActionInFlight = false
  }
}
```

No branch in this method calls `startWatchdogResumeTurn` or sends
`WATCHDOG_RECOVERY_PROMPT`.

- [ ] **Step 7: Make cleanup explicit and preserve failed-recovery queues**

Add:

```ts
watchdogResumeFailed = false

clearWatchdogRuntime(reason: string): void {
  this.endWatchdogTurn()
  this.cancelTurnInterrupt(reason)
  this.codexCollabAgentStates.clear()
  this.codexSubagentActivityIds.clear()
  this.activeCodexSubagentActivities.clear()
  this.pendingWatchdogIdentity = null
}

endWatchdogTurn(): void {
  this.stopWatchdogTick()
  this.watchdog.endTurn()
  this.watchdogContext = null
}

dispose(): void {
  this.clearWatchdogRuntime('dispose')
  Session.all.delete(this)
}
```

Call `endWatchdogTurn` on natural `result`, human soft `st`, and synchronously at the start of
`closeTurnCard`; it must leave `activeTurnInterrupt` intact so the post-`st` result is still
recognized as user-owned. Call the stronger `clearWatchdogRuntime` on full `stop`/`kill`, ordinary
`restart`, non-watchdog process `exit`, and `dispose`. The preserving watchdog restart path skips
both until the old card closes. Neither helper resets `recoveryAttempt`.

When strict resume or recovery-card open fails, set `watchdogResumeFailed = true` in both
`resume_failed` and `open_failed` branches from Task 6. In the manual `restart` command,
pass `preserveQueuedHumanWork: s.watchdogResumeFailed` and `requireResumeSession:
s.watchdogResumeFailed`; after a successful resume, clear the latch and call a package-internal
`drainPreservedHumanWork()` that delegates to `drainMidTurnAndOpen`. This gives already-preserved
messages a recovery path without a fresh thread. Explicit `kill`/`clear` may still discard them
because those are human-authorized destructive commands.

Reset `watchdogResumeFailed` explicitly after successful manual resume, successful fresh start,
human `kill`/full `stop`, and `clear`. If a strict manual resume fails, keep it `true`. Add tests
for both transitions:

```ts
test('failed-recovery latch survives another failed strict resume but clears on success', async () => {
  const { session } = armedRecoverySession()
  session.watchdogResumeFailed = true
  session.restart = async () => false
  await session.resumeFailedWatchdogQueue()
  expect(session.watchdogResumeFailed).toBe(true)
  session.restart = async () => true
  await session.resumeFailedWatchdogQueue()
  expect(session.watchdogResumeFailed).toBe(false)
})

test('explicit full stop clears failed-recovery latch', async () => {
  const { session } = armedRecoverySession()
  session.watchdogResumeFailed = true
  await session.stop('user stop', { announce: false })
  expect(session.watchdogResumeFailed).toBe(false)
})
```

Implement `resumeFailedWatchdogQueue()` as the Session-owned helper used by the manual restart
command:

```ts
async resumeFailedWatchdogQueue(opts: LifecycleProgressOpts = {}): Promise<boolean> {
  const ok = await this.restart(true, {
    ...opts,
    requireResumeSession: true,
    preserveQueuedHumanWork: true,
  })
  if (!ok) {
    this.watchdogResumeFailed = true
    return false
  }
  this.watchdogResumeFailed = false
  if (this.pendingMidTurnMsgs.length > 0) await this.drainMidTurnAndOpen()
  return true
}
```

Keep the latch on failure and drain only after success.

In the pre-interrupt cancellation branch from Task 6, restore the footer only if
`this.currentTurn === ctx.turn`; a natural result may already have closed/disposed the card:

```ts
if (!this.watchdogGuardsPass(ctx, true)) {
  if (this.currentTurn === ctx.turn) {
    ctx.turn.footerStatusOverride = null
    this.startThinkingFooter(ctx.turn)
  }
  return
}
```

- [ ] **Step 8: Run race, cleanup, and exhaustion tests; commit**

```bash
# desc: 验证 watchdog 调度、真人优先、恢复耗尽和全生命周期清理
bun test src/turn-watchdog.test.ts src/session.test.ts src/cards/turn.test.ts

# desc: 提交 watchdog 有界调度和消息保全
git add src/session.ts src/session-commands.ts src/feishu-test-mock.ts src/session.test.ts src/turn-watchdog.test.ts
git commit -m "feat(watchdog): bound recovery and preserve human input"
```

Expected: all targeted tests PASS, no third automatic turn is created, and every queued human
message retains text, inline file hints, order, `msgId`, and reaction ownership.

---

### Task 8: Documentation, full regression, build, and final review

**Files:**
- Modify: `README.md:110-145`
- Modify: `README.md:208-246`
- Modify: `docs/开发与调试指南.md:152-213`
- Test: `src/turn-watchdog.test.ts`
- Test: `src/config.test.ts`
- Test: `src/codex-process.test.ts`
- Test: `src/session.test.ts`
- Test: `src/cards/turn.test.ts`

- [ ] **Step 1: Document the default and project override in README**

Add a `### Codex 卡死监控与一次性自动恢复` section after the Codex provider configuration.
State all of the following, without describing rollout JSONL as a production data source:

- Codex defaults to `recover_once`; Claude remains off.
- Recovery requires 15 minutes idle plus 10 successful identical no-op calls.
- Pure silent reasoning warns at 30 minutes and is never interrupted.
- Real tools, child agents, input waits, compaction, rotation, agy, model changes, and queued
  human messages suppress action.
- The task continues at most once on the same thread; a second loop stops.
- Only the current project's Codex agent process may be resumed; Lodestar daemon is never
  automatically restarted.

Include these exact examples:

```toml
[watchdog]
codex_mode = "recover_once"       # off | warn | recover_once
stall_seconds = "900"
repeat_noop_limit = "10"
silent_warn_seconds = "1800"
interrupt_grace_seconds = "10"
```

```toml
[projects.pokemon]
watchdog_mode = "warn"            # off | warn | recover_once
```

End the section with: `配置变更在 daemon 下次正常启动时生效；是否重启仍遵守本项目的 live-service 操作边界。`

- [ ] **Step 2: Document event semantics and safe verification in the developer guide**

Add a watchdog subsection under debugging with this exact contract:

```markdown
### Codex turn watchdog 调试

- 数据源只来自 `AgentProcess` / `Session` 已收到的结构化事件；生产判定禁止读取或 tail `~/.codex/sessions/**/*.jsonl`。
- 有效进展：非空 assistant 正文、真实主线程 tool start/result、变化后的 plan/goal、compaction 阶段变化、Codex sub-agent activity、Claude background task 状态变化。
- 非进展：footer 秒表、token/rate-limit/reasoning、transport warning、相同卡片刷新。
- 安全验证使用 `src/session.test.ts` 的 fake `AgentProcess` 和假时间；不要为了验证 watchdog 停止、shadow、切换或重启正在运行的 daemon。
- 结构化日志事件以 `turn_watchdog_` 开头，只含截断 thread/turn id、idle、repeat、hash、attempt 和 outcome，不含 prompt、空调用原文、凭据或配置环境变量。
```

Also add `[watchdog]` to the guide's config table and explicitly state that `Thinking...(Ns)` is a
Lodestar footer timer, not an agent heartbeat.

- [ ] **Step 3: Record the concrete release-note sentence without publishing**

Use this exact user-facing sentence in the eventual release/PR notes and final implementation
handoff:

```text
Codex 长任务现在会识别持续 15 分钟且重复至少 10 次的高置信度空调用循环，自动在原 thread 恢复一次；普通长推理只提示、不打断，Claude 行为不变。
```

Do not bump a version, tag, publish, push, or restart a service as part of this implementation plan.

- [ ] **Step 4: Run locked dependency and targeted verification**

```bash
# desc: 安装锁定依赖并验证 watchdog 全链路定向测试
bun install --frozen-lockfile
bun test src/turn-watchdog.test.ts src/config.test.ts src/codex-process.test.ts src/session.test.ts src/cards/turn.test.ts
```

Expected: install succeeds without lockfile changes; every targeted test passes with 0 failures.

- [ ] **Step 5: Run full regression and build**

```bash
# desc: 运行 Lodestar 全量测试
bun test

# desc: 构建发布产物验证 TypeScript 和打包入口
bun run build
```

Expected: full test suite passes and the build exits 0. If a pre-existing failure appears, prove it
against the base commit before reporting; do not relabel a new watchdog failure as pre-existing.

- [ ] **Step 6: Audit invariants and diff hygiene**

```bash
# desc: 检查 watchdog 实现没有引入生产 rollout 读取和敏感日志
if rg -n "\.codex/sessions|CODEX_SESSIONS_DIR|findCodexRolloutFile" src/turn-watchdog.ts src/session.ts src/session-tools.ts; then
  exit 1
fi
BASE=$(git merge-base origin/main HEAD)
if git diff --unified=0 "$BASE"..HEAD -- src/codex-process.ts \
  | sed -n '/^+++ /d; /^+/p' \
  | rg -n "\.codex/sessions|CODEX_SESSIONS_DIR|findCodexRolloutFile|readFileSync"; then
  exit 1
fi
for event in \
  turn_watchdog_silent_warn turn_watchdog_loop_warn turn_watchdog_recover_start \
  turn_watchdog_interrupt_settled turn_watchdog_resume_fallback \
  turn_watchdog_recover_started turn_watchdog_exhausted turn_watchdog_recover_failed
do
  rg -q "$event" src/session.ts || exit 1
done

# desc: 检查补丁格式和最终工作区范围
git diff --check "$(git merge-base origin/main HEAD)"..HEAD
git status --short
```

Expected: neither the direct source scan nor the new-line-only `src/codex-process.ts` diff scan
finds a watchdog rollout reader; the latter deliberately ignores that file's pre-existing image
lookup code. All eight event names are present; `git diff --check` is clean; status contains only
the intended watchdog source/tests/docs and normal build artifact changes already tracked by the
repository.

- [ ] **Step 7: Review the completed diff against every safety invariant**

Review the final diff in a fresh pass and explicitly verify:

1. `inputText` app-server fixtures are used; rollout-only `input_text` is rejected.
2. Pending candidates, active tools, Codex collab agents, Claude background tasks, asks,
   permissions, compaction, rotation, agy, model switching, multi-message input, and queued human
   work all suppress action.
3. `result`, `exit`, and `timeout` are distinct branches and each validates identity after awaits.
4. Strict resume cannot fresh-start and queue-preserving restart cannot clear text, inline file
   hints, order, `msgId`, or reaction ownership.
5. A human message before interrupt cancels recovery without consuming budget; after interrupt it
   runs before any internal prompt.
6. Recovery attempt is preserved across `watchdog_resume`, reset only by a new human turn, and a
   second loop never creates a third automatic turn.
7. Warning/footer failures cannot block interrupt, and all lifecycle paths clear timers/waiters.
8. No code restarts or otherwise operates the Lodestar daemon.

If any item cannot be proven by a named test, add that test before the final commit.

- [ ] **Step 8: Commit documentation and final verification evidence**

```bash
# desc: 提交 watchdog 文档与验证说明
git add README.md docs/开发与调试指南.md
git commit -m "docs: explain bounded Codex watchdog recovery"

# desc: 确认提交后工作区和最近提交
git status --short
git log -8 --oneline
```

Expected: documentation commit succeeds; no uncommitted watchdog change remains. Report targeted
tests, full test count, build result, and the explicit fact that no live daemon operation was run.
