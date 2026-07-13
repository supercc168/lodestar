import { createHash } from 'node:crypto'

export interface NoopExecCall {
  literal: string
  fingerprintHash: string
}

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

export function parseWatchdogMode(
  raw: string | undefined,
  field: string,
  fallback: WatchdogMode,
): WatchdogMode {
  if (raw === undefined || raw === '') return fallback
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
  const valueText = raw === undefined || raw === '' ? String(fallback) : raw
  if (!/^\d+$/.test(valueText)) {
    throw new Error(`lodestar: ${field} must be an integer in ${min}..${max}, got "${valueText}"`)
  }

  const value = Number(valueText)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`lodestar: ${field} must be an integer in ${min}..${max}, got "${valueText}"`)
  }
  return value
}

export function parseWatchdogSettings(
  section: Record<string, string> = {},
): WatchdogSettings {
  const mode = parseWatchdogMode(
    section.codex_mode,
    'watchdog.codex_mode',
    DEFAULT_CODEX_WATCHDOG.mode,
  )
  const stallSeconds = parseWatchdogInteger(
    section.stall_seconds,
    'watchdog.stall_seconds',
    DEFAULT_CODEX_WATCHDOG.stallMs / 1_000,
    60,
    86_400,
  )
  const repeatNoopLimit = parseWatchdogInteger(
    section.repeat_noop_limit,
    'watchdog.repeat_noop_limit',
    DEFAULT_CODEX_WATCHDOG.repeatNoopLimit,
    3,
    100,
  )
  const silentWarnSeconds = parseWatchdogInteger(
    section.silent_warn_seconds,
    'watchdog.silent_warn_seconds',
    DEFAULT_CODEX_WATCHDOG.silentWarnMs / 1_000,
    stallSeconds,
    172_800,
  )
  const interruptGraceSeconds = parseWatchdogInteger(
    section.interrupt_grace_seconds,
    'watchdog.interrupt_grace_seconds',
    DEFAULT_CODEX_WATCHDOG.interruptGraceMs / 1_000,
    1,
    60,
  )

  return {
    mode,
    stallMs: stallSeconds * 1_000,
    repeatNoopLimit,
    silentWarnMs: silentWarnSeconds * 1_000,
    interruptGraceMs: interruptGraceSeconds * 1_000,
  }
}

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
  | {
    type: 'loop_warn' | 'recover' | 'stop_exhausted'
    idleMs: number
    repeatCount: number
    fingerprintHash: string
  }

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

const NOOP_EXEC_RE = /^\s*text\s*\(\s*("(?:[^"\\\u0000-\u001f]|\\.)*")\s*\)\s*;?\s*$/
const EXEC_COMPLETION_RE = /^Script completed\nWall time \d+(?:\.\d+)? seconds\nOutput:\n$/

export function parseNoopExecCall(name: unknown, input: unknown): NoopExecCall | null {
  if ((name !== 'exec' && name !== 'functions.exec') || typeof input !== 'string') return null

  const candidate = input
    .split(/\r?\n/)
    .filter(line => !/^\s*\/\//.test(line))
    .join('\n')
  const match = NOOP_EXEC_RE.exec(candidate)
  if (!match) return null

  let literal: unknown
  try {
    literal = JSON.parse(match[1])
  } catch {
    return null
  }
  if (typeof literal !== 'string') return null

  return {
    literal,
    fingerprintHash: createHash('sha256')
      .update('exec:text\0')
      .update(Buffer.from(literal, 'utf16le'))
      .digest('hex'),
  }
}

function isExactInputText(value: unknown, text: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.length !== 2 || !keys.includes('type') || !keys.includes('text')) return false
  const item = value as { type?: unknown; text?: unknown }
  return item.type === 'inputText' && item.text === text
}

export function matchesNoopExecResult(content: unknown, literal: string): boolean {
  if (typeof content !== 'string') return false

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return false
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return false
  const completion = parsed[0]
  if (!completion || typeof completion !== 'object' || Array.isArray(completion)) return false
  const completionText = (completion as { text?: unknown }).text
  if (typeof completionText !== 'string' || !EXEC_COMPLETION_RE.test(completionText)) return false

  return isExactInputText(completion, completionText) && isExactInputText(parsed[1], literal)
}

export class TurnWatchdog {
  private readonly settings: WatchdogSettings
  private turnKey: string | null = null
  private trigger: WatchdogTrigger | null = null
  private lastMeaningfulAt = 0
  private lastMeaningfulLabel = 'turn_start'
  private repeatCount = 0
  private fingerprintHash: string | null = null
  private readonly pendingCandidates = new Map<string, NoopExecCall>()
  private readonly activeRealTools = new Set<string>()
  private readonly seenToolIds = new Set<string>()
  private readonly taintedToolIds = new Set<string>()
  private recoveryAttempt: 0 | 1 = 0
  private silentWarned = false
  private loopWarned = false

  constructor(settings: WatchdogSettings) {
    this.settings = { ...settings }
  }

  beginTurn(turnKey: string, trigger: WatchdogTrigger, now: number): void {
    this.clearTurnState()
    this.turnKey = turnKey
    this.trigger = trigger
    this.lastMeaningfulAt = now
    this.lastMeaningfulLabel = 'turn_start'
    if (trigger === 'user_message') this.recoveryAttempt = 0
  }

  endTurn(): void {
    this.clearTurnState()
  }

  observeMeaningful(now: number, label: string): void {
    if (this.turnKey === null) return
    this.lastMeaningfulAt = now
    this.lastMeaningfulLabel = label
    this.repeatCount = 0
    this.fingerprintHash = null
    this.silentWarned = false
    this.loopWarned = false
  }

  observeToolStart(id: string, name: string, input: unknown, now: number): void {
    if (this.turnKey === null) return
    const candidate = parseNoopExecCall(name, input)
    const reusedId = this.seenToolIds.has(id)
    this.seenToolIds.add(id)
    if (reusedId) {
      this.pendingCandidates.delete(id)
      this.activeRealTools.add(id)
      this.taintedToolIds.add(id)
      if (!candidate) this.observeMeaningful(now, `tool_use:${name}`)
      return
    }

    if (candidate) {
      this.pendingCandidates.set(id, candidate)
      return
    }

    this.activeRealTools.add(id)
    this.observeMeaningful(now, `tool_use:${name}`)
  }

  observeToolResult(id: string, content: unknown, isError: boolean, now: number): void {
    if (this.turnKey === null) return
    if (this.taintedToolIds.has(id)) return
    const candidate = this.pendingCandidates.get(id)
    if (candidate) {
      this.pendingCandidates.delete(id)
      if (isError || !matchesNoopExecResult(content, candidate.literal)) {
        this.observeMeaningful(now, 'tool_result:exec')
        return
      }

      if (this.fingerprintHash === candidate.fingerprintHash) this.repeatCount += 1
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
    if (this.turnKey === null || this.trigger === null || this.settings.mode === 'off') return { type: 'none' }
    if (this.pendingCandidates.size > 0 || this.activeRealTools.size > 0) return { type: 'none' }
    if (!isSafeToAct(safety)) return { type: 'none' }

    const idleMs = Math.max(0, now - this.lastMeaningfulAt)
    const loopDetected = idleMs >= this.settings.stallMs
      && this.repeatCount >= this.settings.repeatNoopLimit
      && this.fingerprintHash !== null

    if (loopDetected) {
      if (this.settings.mode === 'warn' || this.trigger === 'bg_task_resume') {
        if (this.loopWarned) return { type: 'none' }
        this.loopWarned = true
        return {
          type: 'loop_warn',
          idleMs,
          repeatCount: this.repeatCount,
          fingerprintHash: this.fingerprintHash!,
        }
      }

      return {
        type: this.recoveryAttempt === 0 ? 'recover' : 'stop_exhausted',
        idleMs,
        repeatCount: this.repeatCount,
        fingerprintHash: this.fingerprintHash!,
      }
    }

    if (idleMs >= this.settings.silentWarnMs && !this.silentWarned) {
      this.silentWarned = true
      return { type: 'silent_warn', idleMs }
    }

    return { type: 'none' }
  }

  snapshot(): WatchdogSnapshot {
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

  private clearTurnState(): void {
    this.turnKey = null
    this.trigger = null
    this.repeatCount = 0
    this.fingerprintHash = null
    this.pendingCandidates.clear()
    this.activeRealTools.clear()
    this.seenToolIds.clear()
    this.taintedToolIds.clear()
    this.silentWarned = false
    this.loopWarned = false
  }
}

function isSafeToAct(safety: WatchdogSafetySnapshot): boolean {
  return safety.currentTurn
    && safety.eligibleTrigger
    && !safety.realToolRunning
    && !safety.backgroundWorkRunning
    && !safety.awaitingInput
    && !safety.compactionRunning
    && !safety.rotationRunning
    && !safety.agyRunning
    && !safety.queuedHumanWork
    && !safety.modelSwitchPending
    && !safety.recoveryActionInFlight
}
