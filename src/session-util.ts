export type FooterTimer = {
  setStatus(status: string): void
  stop(): void
  elapsedSec(): string
}

export type StatusCardHandle = {
  cardId: string
  title: string
  timer: FooterTimer
}

export type LifecycleKind =
  | 'start'
  | 'restart'
  | 'strict-retry'
  | 'hi'
  | 'soft_stop'
  | 'stop'
  | 'kill'
  | 'clear'
  | 'dispose'
  | 'model'
  | 'back'
  | 'resume'
  | 'fork'
  | 'watchdog-recovery'
  | 'watchdog-exhausted'

export type LifecycleLease = Readonly<{
  epoch: number
  kind: LifecycleKind
}>

export type ResumeIdentity = Readonly<{
  provider: import('./agent-process').AgentProvider
  threadId: string
}>

export type LifecycleProgressOpts = {
  announce?: boolean
  onStatus?: (status: string) => void
  /** Internal watchdog transaction flags; ordinary commands leave all false. */
  requireResumeSession?: boolean
  preserveCurrentTurn?: boolean
  preserveQueuedHumanWork?: boolean
  /** Internal: startColdUserTurn resets fresh state before opening the
   * first direct-start card, because the visible turn number is decided
   * before Codex starts. */
  freshConversationStateAlreadyReset?: boolean
  /** Internal: nested lifecycle operations retain the caller's lease. */
  lifecycleLease?: LifecycleLease
  /** Internal: strict recovery must use this immutable provider/thread. */
  resumeIdentity?: ResumeIdentity
  /** Internal: binds preserve flags to one identity-bearing recovery. */
  preservedRecoveryToken?: object
}

export type WorktreeActionResult = { ok: boolean; message: string; card: object }
export type TasklistActionResult = { ok: boolean; message: string; card: object }
export type ModelActionResult = { ok: boolean; message: string; card?: object }

export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
