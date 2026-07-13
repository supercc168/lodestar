import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_CODEX_WATCHDOG,
  TurnWatchdog,
  matchesNoopExecResult,
  parseNoopExecCall,
  type WatchdogSafetySnapshot,
  type WatchdogSettings,
  type WatchdogVerdict,
} from './turn-watchdog'

function execResult(literal: string, wallTime = '0.1'): string {
  return JSON.stringify([
    {
      type: 'inputText',
      text: `Script completed\nWall time ${wallTime} seconds\nOutput:\n`,
    },
    { type: 'inputText', text: literal },
  ])
}

function expectedFingerprint(literal: string): string {
  return createHash('sha256')
    .update('exec:text\0')
    .update(Buffer.from(literal, 'utf16le'))
    .digest('hex')
}

const START = 1_000_000

const SAFE: WatchdogSafetySnapshot = {
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

function settings(overrides: Partial<WatchdogSettings> = {}): WatchdogSettings {
  return { ...DEFAULT_CODEX_WATCHDOG, ...overrides }
}

function addMatchedNoops(watchdog: TurnWatchdog, count: number, literal = 'ready'): void {
  for (let index = 0; index < count; index += 1) {
    const id = `noop-${literal}-${index}`
    watchdog.observeToolStart(id, 'exec', `text(${JSON.stringify(literal)})`, START + index)
    watchdog.observeToolResult(id, execResult(literal), false, START + index)
  }
}

function verdictType(verdict: WatchdogVerdict): WatchdogVerdict['type'] {
  return verdict.type
}

describe('parseNoopExecCall', () => {
  test('accepts an exact text literal and hashes only the decoded literal', () => {
    expect(parseNoopExecCall('exec', 'text("ready")')).toEqual({
      literal: 'ready',
      fingerprintHash: expectedFingerprint('ready'),
    })
  })

  test('accepts namespaced exec, pure comment lines, whitespace, and a trailing semicolon', () => {
    expect(parseNoopExecCall(
      'functions.exec',
      '  // orchestration note\n\n text("line\\nvalue") ; \n // done',
    )).toEqual({
      literal: 'line\nvalue',
      fingerprintHash: expectedFingerprint('line\nvalue'),
    })
  })

  test('uses different fingerprints for different literals', () => {
    const first = parseNoopExecCall('exec', 'text("ready")')
    const second = parseNoopExecCall('exec', 'text("done")')

    expect(first?.fingerprintHash).not.toBe(second?.fingerprintHash)
  })

  test('keeps unpaired UTF-16 surrogates distinct from each other and replacement text', () => {
    const hashes = [
      parseNoopExecCall('exec', 'text("\\ud800")')!.fingerprintHash,
      parseNoopExecCall('exec', 'text("\\ud801")')!.fingerprintHash,
      parseNoopExecCall('exec', 'text("\\udfff")')!.fingerprintHash,
      parseNoopExecCall('exec', 'text("\\ufffd")')!.fingerprintHash,
    ]

    expect(new Set(hashes).size).toBe(4)
  })

  test('uses one fingerprint for different JSON spellings of the same decoded literal', () => {
    const plain = parseNoopExecCall('exec', 'text("ready")')
    const escaped = parseNoopExecCall('functions.exec', 'text("\\u0072eady")')

    expect(plain?.literal).toBe(escaped?.literal)
    expect(plain?.fingerprintHash).toBe(escaped?.fingerprintHash)
  })

  test.each([
    ['unsupported tool name', 'Bash', 'text("ready")'],
    ['non-string input', 'exec', { code: 'text("ready")' }],
    ['executable statement', 'exec', 'const value = 1; text("ready")'],
    ['notify call', 'exec', 'notify("ready")'],
    ['multiple text calls', 'exec', 'text("one"); text("two")'],
    ['shell command', 'exec', 'Bash("pwd")'],
    ['single-quoted literal', 'exec', "text('ready')"],
    ['inline comment', 'exec', 'text("ready") // trailing'],
    ['invalid JSON escape', 'exec', 'text("\\x41")'],
  ])('rejects %s', (_label, name, input) => {
    expect(parseNoopExecCall(name, input)).toBeNull()
  })
})

describe('matchesNoopExecResult', () => {
  test('accepts the exact two-element camelCase inputText result', () => {
    expect(matchesNoopExecResult(execResult('ready'), 'ready')).toBe(true)
    expect(matchesNoopExecResult(execResult('', '12'), '')).toBe(true)
  })

  test.each([
    ['rollout-only input_text', JSON.stringify([
      { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
      { type: 'input_text', text: 'ready' },
    ])],
    ['literal mismatch', execResult('different')],
    ['extra image element', JSON.stringify([
      { type: 'inputText', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
      { type: 'inputText', text: 'ready' },
      { type: 'image', image_url: 'data:image/png;base64,AA==' },
    ])],
    ['wrong completion text', JSON.stringify([
      { type: 'inputText', text: 'Script completed\nWall time 0.1 seconds\nOutput: ready\n' },
      { type: 'inputText', text: 'ready' },
    ])],
    ['extra object field', JSON.stringify([
      { type: 'inputText', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n', extra: true },
      { type: 'inputText', text: 'ready' },
    ])],
    ['invalid JSON', '{'],
  ])('rejects %s', (_label, content) => {
    expect(matchesNoopExecResult(content, 'ready')).toBe(false)
  })

  test('rejects non-string content', () => {
    expect(matchesNoopExecResult([], 'ready')).toBe(false)
  })
})

describe('TurnWatchdog loop thresholds and evidence', () => {
  test('requires both ten consecutive no-ops and fifteen idle minutes to recover', () => {
    const watchdog = new TurnWatchdog(settings())
    watchdog.beginTurn('turn-1', 'user_message', START)
    addMatchedNoops(watchdog, 10)

    expect(watchdog.evaluate(START + 900_000 - 1, SAFE)).toEqual({ type: 'none' })
    expect(watchdog.evaluate(START + 900_000, SAFE)).toEqual({
      type: 'recover',
      idleMs: 900_000,
      repeatCount: 10,
      fingerprintHash: parseNoopExecCall('exec', 'text("ready")')!.fingerprintHash,
    })
  })

  test('does not trigger a loop action after only nine no-ops', () => {
    const watchdog = new TurnWatchdog(settings())
    watchdog.beginTurn('turn-1', 'user_message', START)
    addMatchedNoops(watchdog, 9)

    expect(watchdog.evaluate(START + 900_000, SAFE)).toEqual({ type: 'none' })
  })

  test('leaves an unresolved candidate pending and blocks evaluation', () => {
    const watchdog = new TurnWatchdog(settings({ repeatNoopLimit: 1, stallMs: 0 }))
    watchdog.beginTurn('turn-1', 'user_message', START)
    watchdog.observeToolStart('pending', 'functions.exec', 'text("ready")', START)

    expect(watchdog.snapshot().pendingCandidateCount).toBe(1)
    expect(watchdog.snapshot().repeatCount).toBe(0)
    expect(watchdog.evaluate(START, SAFE)).toEqual({ type: 'none' })
  })

  test('a pending candidate blocks action even after prior evidence reached the limit', () => {
    const watchdog = new TurnWatchdog(settings())
    watchdog.beginTurn('turn-1', 'user_message', START)
    addMatchedNoops(watchdog, 10)
    watchdog.observeToolStart('pending', 'exec', 'text("ready")', START + 20)

    expect(watchdog.evaluate(START + 900_000, SAFE)).toEqual({ type: 'none' })
  })

  test('failed, mismatched, unknown, and duplicate results do not add evidence', () => {
    const watchdog = new TurnWatchdog(settings())
    watchdog.beginTurn('turn-1', 'user_message', START)

    watchdog.observeToolResult('unknown', execResult('ready'), false, START + 1)
    expect(watchdog.snapshot().repeatCount).toBe(0)

    watchdog.observeToolStart('matched', 'exec', 'text("ready")', START + 2)
    watchdog.observeToolResult('matched', execResult('ready'), false, START + 3)
    watchdog.observeToolResult('matched', execResult('ready'), false, START + 4)
    expect(watchdog.snapshot().repeatCount).toBe(1)

    watchdog.observeToolStart('failed', 'exec', 'text("ready")', START + 5)
    watchdog.observeToolResult('failed', execResult('ready'), true, START + 6)
    expect(watchdog.snapshot()).toMatchObject({
      repeatCount: 0,
      fingerprintHash: null,
      lastMeaningfulLabel: 'tool_result:exec',
    })

    watchdog.observeToolStart('mismatch', 'exec', 'text("ready")', START + 7)
    watchdog.observeToolResult('mismatch', execResult('different'), false, START + 8)
    expect(watchdog.snapshot()).toMatchObject({
      repeatCount: 0,
      fingerprintHash: null,
      lastMeaningfulAt: START + 8,
    })
  })

  test('a different fingerprint restarts the consecutive count at one', () => {
    const watchdog = new TurnWatchdog(settings())
    watchdog.beginTurn('turn-1', 'user_message', START)
    addMatchedNoops(watchdog, 3, 'ready')

    const id = 'different'
    watchdog.observeToolStart(id, 'exec', 'text("done")', START + 10)
    watchdog.observeToolResult(id, execResult('done'), false, START + 11)

    expect(watchdog.snapshot()).toMatchObject({
      repeatCount: 1,
      fingerprintHash: parseNoopExecCall('exec', 'text("done")')!.fingerprintHash,
    })
  })

  test('real tool progress clears loop evidence and blocks while the tool is active', () => {
    const watchdog = new TurnWatchdog(settings({ repeatNoopLimit: 1, stallMs: 0 }))
    watchdog.beginTurn('turn-1', 'user_message', START)
    addMatchedNoops(watchdog, 1)

    watchdog.observeToolStart('real', 'Bash', 'pwd', START + 10)
    expect(watchdog.snapshot()).toMatchObject({
      repeatCount: 0,
      fingerprintHash: null,
      activeRealToolCount: 1,
      lastMeaningfulLabel: 'tool_use:Bash',
    })
    expect(watchdog.evaluate(START + 10, SAFE)).toEqual({ type: 'none' })

    watchdog.observeToolResult('real', 'result', false, START + 20)
    expect(watchdog.snapshot()).toMatchObject({
      activeRealToolCount: 0,
      lastMeaningfulAt: START + 20,
      lastMeaningfulLabel: 'tool_result',
    })
  })

  test('taints candidate-to-real id reuse so a late candidate result cannot unblock evaluation', () => {
    const watchdog = new TurnWatchdog(settings({ repeatNoopLimit: 1, stallMs: 0 }))
    watchdog.beginTurn('turn-1', 'user_message', START)
    watchdog.observeToolStart('same', 'exec', 'text("ready")', START)
    watchdog.observeToolStart('same', 'Bash', 'pwd', START + 1)
    expect(watchdog.snapshot()).toMatchObject({ pendingCandidateCount: 0, activeRealToolCount: 1 })

    watchdog.observeToolResult('same', execResult('ready'), false, START + 2)
    expect(watchdog.snapshot()).toMatchObject({
      pendingCandidateCount: 0,
      activeRealToolCount: 1,
      repeatCount: 0,
    })
    expect(watchdog.evaluate(START + 2, SAFE)).toEqual({ type: 'none' })
  })

  test('taints real-to-candidate id reuse so a late real result cannot unblock evaluation', () => {
    const watchdog = new TurnWatchdog(settings({ repeatNoopLimit: 1, stallMs: 0 }))
    watchdog.beginTurn('turn-1', 'user_message', START)
    watchdog.observeToolStart('same', 'Bash', 'pwd', START)
    watchdog.observeToolStart('same', 'exec', 'text("ready")', START + 1)

    watchdog.observeToolResult('same', 'real result', false, START + 2)
    expect(watchdog.snapshot()).toMatchObject({
      pendingCandidateCount: 0,
      activeRealToolCount: 1,
      repeatCount: 0,
    })
    expect(watchdog.evaluate(START + 2, SAFE)).toEqual({ type: 'none' })
  })

  test('taints a settled candidate id when a later real call reuses it', () => {
    const watchdog = new TurnWatchdog(settings({ repeatNoopLimit: 1, stallMs: 0 }))
    watchdog.beginTurn('turn-1', 'user_message', START)
    watchdog.observeToolStart('same', 'exec', 'text("ready")', START)
    watchdog.observeToolResult('same', execResult('ready'), false, START + 1)
    expect(watchdog.snapshot()).toMatchObject({ activeRealToolCount: 0, repeatCount: 1 })

    watchdog.observeToolStart('same', 'Bash', 'pwd', START + 2)
    watchdog.observeToolResult('same', execResult('ready'), false, START + 3)
    expect(watchdog.snapshot()).toMatchObject({
      pendingCandidateCount: 0,
      activeRealToolCount: 1,
      repeatCount: 0,
    })
    expect(watchdog.evaluate(START + 3, SAFE)).toEqual({ type: 'none' })
  })

  test('taints a settled real id when a later candidate reuses it', () => {
    const watchdog = new TurnWatchdog(settings({ repeatNoopLimit: 1, stallMs: 0 }))
    watchdog.beginTurn('turn-1', 'user_message', START)
    watchdog.observeToolStart('same', 'Bash', 'pwd', START)
    watchdog.observeToolResult('same', 'real result', false, START + 1)
    expect(watchdog.snapshot().activeRealToolCount).toBe(0)

    watchdog.observeToolStart('same', 'exec', 'text("ready")', START + 2)
    watchdog.observeToolResult('same', 'real result', false, START + 3)
    expect(watchdog.snapshot()).toMatchObject({
      pendingCandidateCount: 0,
      activeRealToolCount: 1,
      repeatCount: 0,
    })
    expect(watchdog.evaluate(START + 3, SAFE)).toEqual({ type: 'none' })
  })

  test('clears tainted tool ids only at a turn boundary', () => {
    const watchdog = new TurnWatchdog(settings())
    watchdog.beginTurn('turn-1', 'user_message', START)
    watchdog.observeToolStart('same', 'exec', 'text("ready")', START)
    watchdog.observeToolStart('same', 'Bash', 'pwd', START + 1)
    watchdog.beginTurn('turn-2', 'user_message', START + 10)
    expect(watchdog.snapshot().activeRealToolCount).toBe(0)

    watchdog.observeToolStart('same', 'exec', 'text("ready")', START + 11)
    watchdog.observeToolStart('same', 'Bash', 'pwd', START + 12)
    watchdog.endTurn()
    expect(watchdog.snapshot().activeRealToolCount).toBe(0)

    watchdog.beginTurn('turn-3', 'user_message', START + 20)
    watchdog.observeToolStart('same', 'exec', 'text("ready")', START + 21)
    watchdog.observeToolResult('same', execResult('ready'), false, START + 22)
    expect(watchdog.snapshot()).toMatchObject({ activeRealToolCount: 0, repeatCount: 1 })
  })
})

describe('TurnWatchdog warning and recovery modes', () => {
  test('warn mode emits one loop warning per progress segment and never recovers', () => {
    const watchdog = new TurnWatchdog(settings({ mode: 'warn' }))
    watchdog.beginTurn('turn-1', 'user_message', START)
    addMatchedNoops(watchdog, 10)

    expect(verdictType(watchdog.evaluate(START + 900_000, SAFE))).toBe('loop_warn')
    expect(watchdog.evaluate(START + 900_001, SAFE)).toEqual({ type: 'none' })
    expect(watchdog.evaluate(START + 9_000_000, SAFE)).toEqual({ type: 'none' })
    expect(watchdog.snapshot().recoveryAttempt).toBe(0)
  })

  test('off mode emits neither loop nor silent verdicts', () => {
    const watchdog = new TurnWatchdog(settings({ mode: 'off' }))
    watchdog.beginTurn('turn-1', 'user_message', START)
    addMatchedNoops(watchdog, 10)

    expect(watchdog.evaluate(START + 900_000, SAFE)).toEqual({ type: 'none' })
    expect(watchdog.evaluate(START + 9_000_000, SAFE)).toEqual({ type: 'none' })
  })

  test('pure silence warns once and never consumes or requests recovery', () => {
    const watchdog = new TurnWatchdog(settings())
    watchdog.beginTurn('turn-1', 'user_message', START)

    expect(watchdog.evaluate(START + 1_800_000, SAFE)).toEqual({
      type: 'silent_warn',
      idleMs: 1_800_000,
    })
    expect(watchdog.evaluate(START + 9_000_000, SAFE)).toEqual({ type: 'none' })
    expect(watchdog.snapshot().recoveryAttempt).toBe(0)
  })

  test('real progress clears the silent warning latch', () => {
    const watchdog = new TurnWatchdog(settings())
    watchdog.beginTurn('turn-1', 'user_message', START)
    expect(verdictType(watchdog.evaluate(START + 1_800_000, SAFE))).toBe('silent_warn')
    expect(watchdog.evaluate(START + 1_800_001, SAFE)).toEqual({ type: 'none' })

    watchdog.observeToolStart('real', 'Bash', 'pwd', START + 1_800_010)
    watchdog.observeToolResult('real', 'ok', false, START + 1_800_020)

    expect(watchdog.evaluate(START + 3_600_020, SAFE)).toEqual({
      type: 'silent_warn',
      idleMs: 1_800_000,
    })
  })

  test('watchdog resume preserves a consumed budget and stops on the second loop', () => {
    const watchdog = new TurnWatchdog(settings())
    watchdog.beginTurn('turn-1', 'user_message', START)
    addMatchedNoops(watchdog, 10)
    expect(verdictType(watchdog.evaluate(START + 900_000, SAFE))).toBe('recover')
    watchdog.consumeRecovery()

    watchdog.endTurn()
    watchdog.beginTurn('turn-2', 'watchdog_resume', START + 2_000_000)
    addMatchedNoops(watchdog, 10)

    expect(watchdog.evaluate(START + 2_900_000, SAFE)).toEqual({
      type: 'stop_exhausted',
      idleMs: 900_000,
      repeatCount: 10,
      fingerprintHash: parseNoopExecCall('exec', 'text("ready")')!.fingerprintHash,
    })
    expect(watchdog.snapshot().recoveryAttempt).toBe(1)

    watchdog.beginTurn('turn-3', 'user_message', START + 4_000_000)
    expect(watchdog.snapshot().recoveryAttempt).toBe(0)
  })

  test('background task resumes only warn even in recover_once mode', () => {
    const watchdog = new TurnWatchdog(settings())
    watchdog.beginTurn('turn-bg', 'bg_task_resume', START)
    addMatchedNoops(watchdog, 10)

    expect(verdictType(watchdog.evaluate(START + 900_000, SAFE))).toBe('loop_warn')
    expect(watchdog.evaluate(START + 900_001, SAFE)).toEqual({ type: 'none' })
    expect(watchdog.snapshot().recoveryAttempt).toBe(0)
  })
})

describe('TurnWatchdog safety and snapshots', () => {
  test.each([
    'currentTurn',
    'eligibleTrigger',
    'realToolRunning',
    'backgroundWorkRunning',
    'awaitingInput',
    'compactionRunning',
    'rotationRunning',
    'agyRunning',
    'queuedHumanWork',
    'modelSwitchPending',
    'recoveryActionInFlight',
  ] as const)('%s independently blocks a watchdog action', guard => {
    const watchdog = new TurnWatchdog(settings({ repeatNoopLimit: 1, stallMs: 0 }))
    watchdog.beginTurn('turn-1', 'user_message', START)
    addMatchedNoops(watchdog, 1)
    const unsafe = { ...SAFE }
    if (guard === 'currentTurn' || guard === 'eligibleTrigger') unsafe[guard] = false
    else unsafe[guard] = true

    expect(watchdog.evaluate(START, unsafe)).toEqual({ type: 'none' })
  })

  test('snapshot exposes counters and hashes without raw tool input or literals', () => {
    const watchdog = new TurnWatchdog(settings())
    watchdog.beginTurn('turn-sensitive', 'user_message', START)
    watchdog.observeToolStart(
      'pending',
      'functions.exec',
      '// private orchestration prompt\ntext("sensitive literal")',
      START + 1,
    )
    watchdog.observeToolStart('real', 'Bash', 'secret shell command', START + 2)

    const snapshot = watchdog.snapshot()
    expect(snapshot).toEqual({
      turnKey: 'turn-sensitive',
      trigger: 'user_message',
      lastMeaningfulAt: START + 2,
      lastMeaningfulLabel: 'tool_use:Bash',
      repeatCount: 0,
      fingerprintHash: null,
      pendingCandidateCount: 1,
      activeRealToolCount: 1,
      recoveryAttempt: 0,
    })
    expect(JSON.stringify(snapshot)).not.toContain('private orchestration prompt')
    expect(JSON.stringify(snapshot)).not.toContain('sensitive literal')
    expect(JSON.stringify(snapshot)).not.toContain('secret shell command')
  })

  test('endTurn clears turn evidence but preserves progress metadata and recovery budget', () => {
    const watchdog = new TurnWatchdog(settings())
    watchdog.beginTurn('turn-1', 'user_message', START)
    watchdog.observeMeaningful(START + 10, 'agent_message')
    watchdog.observeToolStart('noop', 'exec', 'text("ready")', START + 11)
    watchdog.observeToolResult('noop', execResult('ready'), false, START + 12)
    expect(watchdog.snapshot().repeatCount).toBe(1)
    watchdog.consumeRecovery()
    watchdog.endTurn()

    expect(watchdog.snapshot()).toEqual({
      turnKey: null,
      trigger: null,
      lastMeaningfulAt: START + 10,
      lastMeaningfulLabel: 'agent_message',
      repeatCount: 0,
      fingerprintHash: null,
      pendingCandidateCount: 0,
      activeRealToolCount: 0,
      recoveryAttempt: 1,
    })
    expect(watchdog.evaluate(START + 9_000_000, SAFE)).toEqual({ type: 'none' })
  })

  test('meaningful observations outside an active turn are ignored', () => {
    const watchdog = new TurnWatchdog(settings())
    watchdog.observeMeaningful(START, 'outside')

    expect(watchdog.snapshot()).toMatchObject({
      lastMeaningfulAt: 0,
      lastMeaningfulLabel: 'turn_start',
    })
  })
})
