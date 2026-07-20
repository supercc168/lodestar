import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import {
  GSD_BUSY_MSG,
  GSD_PANEL_STALE_MSG,
  bumpGsdPanelGen,
  clearGsdAwaitingName,
  clearGsdExecution,
  gsdContinueMayMutateStore,
  isGsdBareword,
  markGsdExecution,
  noteGsdUserMessage,
  onGsdContinue,
  onGsdPause,
  parseGsdTextCommand,
  shouldShowGsdProgress,
  validatePanelGen,
} from './session-gsd'
import {
  createAndActivateTask,
  pauseActiveTask,
  readGsdSnapshot,
} from './gsd-store'
import { buildGsdInjectPrompt } from './gsd-prompt'
import type { Session } from './session'

function fakeSession(panelGen: string): Session {
  return { gsdPanelGen: panelGen } as Session
}

describe('isGsdBareword / parseGsdTextCommand', () => {
  test('matches gsd and gsd status', () => {
    expect(isGsdBareword('gsd')).toBe(true)
    expect(isGsdBareword('GSD')).toBe(true)
    expect(isGsdBareword(' gsd ')).toBe(true)
    expect(isGsdBareword('gsd status')).toBe(true)
    expect(isGsdBareword('GSD STATUS')).toBe(true)
  })

  test('matches known subcommands', () => {
    expect(isGsdBareword('gsd continue')).toBe(true)
    expect(isGsdBareword('gsd go')).toBe(true)
    expect(isGsdBareword('gsd 继续')).toBe(true)
    expect(isGsdBareword('gsd pause')).toBe(true)
    expect(isGsdBareword('gsd done')).toBe(true)
    expect(isGsdBareword('gsd new')).toBe(true)
    expect(isGsdBareword('gsd start Wire panel')).toBe(true)
    expect(isGsdBareword('gsd help')).toBe(true)
  })

  test('rejects non-bareword forms', () => {
    expect(isGsdBareword('gsd foo')).toBe(false)
    expect(isGsdBareword('task')).toBe(false)
    expect(isGsdBareword('')).toBe(false)
    expect(isGsdBareword('gsdstatus')).toBe(false)
    expect(isGsdBareword('继续 gsd')).toBe(false)
  })

  test('parseGsdTextCommand shapes', () => {
    expect(parseGsdTextCommand('gsd')).toEqual({ kind: 'panel' })
    expect(parseGsdTextCommand('gsd status')).toEqual({ kind: 'panel' })
    expect(parseGsdTextCommand('gsd continue')).toEqual({ kind: 'continue' })
    expect(parseGsdTextCommand('gsd next')).toEqual({ kind: 'continue' })
    expect(parseGsdTextCommand('gsd 暂停')).toEqual({ kind: 'pause' })
    expect(parseGsdTextCommand('gsd complete')).toEqual({ kind: 'complete' })
    expect(parseGsdTextCommand('gsd new')).toEqual({ kind: 'new' })
    expect(parseGsdTextCommand('gsd start 飞书进度')).toEqual({
      kind: 'new',
      name: '飞书进度',
    })
    expect(parseGsdTextCommand('gsd help')).toEqual({ kind: 'help' })
    expect(parseGsdTextCommand('gsd unknown')).toBeNull()
  })
})

describe('validatePanelGen', () => {
  test('mismatch returns ok:false without throwing', () => {
    const s = fakeSession('gen-1')
    const result = validatePanelGen(s, 'gen-2')
    expect(result).toEqual({ ok: false, message: GSD_PANEL_STALE_MSG })
  })

  test('empty panel_gen is stale', () => {
    const s = fakeSession('gen-1')
    expect(validatePanelGen(s, '')).toEqual({ ok: false, message: GSD_PANEL_STALE_MSG })
  })

  test('match returns null', () => {
    const s = fakeSession('gen-1')
    expect(validatePanelGen(s, 'gen-1')).toBeNull()
  })
})

describe('gsdContinueMayMutateStore (busy-before-resume order)', () => {
  test('busy running session must not mutate store/bridge', () => {
    expect(
      gsdContinueMayMutateStore({ panelGenOk: true, isRunning: true, isBusy: true }),
    ).toBe(false)
  })

  test('stale panel never mutates', () => {
    expect(
      gsdContinueMayMutateStore({ panelGenOk: false, isRunning: false, isBusy: false }),
    ).toBe(false)
  })

  test('idle / not-running may mutate after validation', () => {
    expect(
      gsdContinueMayMutateStore({ panelGenOk: true, isRunning: true, isBusy: false }),
    ).toBe(true)
    expect(
      gsdContinueMayMutateStore({ panelGenOk: true, isRunning: false, isBusy: true }),
    ).toBe(true)
  })
})

describe('bumpGsdPanelGen anti double-continue', () => {
  test('old gen fails validate after bump', () => {
    const s = fakeSession('gen-old')
    const old = s.gsdPanelGen
    const next = bumpGsdPanelGen(s)
    expect(next).toBe(s.gsdPanelGen)
    expect(next).not.toBe(old)
    expect(validatePanelGen(s, old)).toEqual({ ok: false, message: GSD_PANEL_STALE_MSG })
    expect(validatePanelGen(s, next)).toBeNull()
  })
})

describe('clearGsdAwaitingName', () => {
  test('sets gsdAwaitingNameUntil to 0', () => {
    const s = { gsdAwaitingNameUntil: Date.now() + 300_000 } as Session
    clearGsdAwaitingName(s)
    expect(s.gsdAwaitingNameUntil).toBe(0)
  })

  test('is idempotent when already 0', () => {
    const s = { gsdAwaitingNameUntil: 0 } as Session
    clearGsdAwaitingName(s)
    expect(s.gsdAwaitingNameUntil).toBe(0)
  })
})

describe('session GSD execution detection', () => {
  test('shouldShowGsdProgress requires 运行中 + matching gsdExecution slug', () => {
    const base = {
      status: '运行中' as const,
      taskSlug: 'demo-task',
      taskName: 'Demo',
      phase: 'execute',
      updatedAt: '',
      planningPath: '',
      note: '',
      bridge: { ok: true, kind: 'symlink' as const, target: 'x' },
    }
    expect(shouldShowGsdProgress(base, null)).toBe(false)
    expect(
      shouldShowGsdProgress(base, {
        taskSlug: 'other',
        source: 'inject',
        at: 1,
      }),
    ).toBe(false)
    expect(
      shouldShowGsdProgress(base, {
        taskSlug: 'demo-task',
        source: 'inject',
        at: 1,
      }),
    ).toBe(true)
    expect(
      shouldShowGsdProgress(
        { ...base, status: '已暂停' },
        { taskSlug: 'demo-task', source: 'inject', at: 1 },
      ),
    ).toBe(false)
  })

  test('noteGsdUserMessage arms on inject and clears on own-turn chat', () => {
    const s = {
      workDir: '/tmp/unused',
      gsdExecution: null,
    } as unknown as Session

    const inject = buildGsdInjectPrompt({
      action: 'continue',
      taskSlug: 'wire-panel',
      taskName: 'Wire',
      provider: 'claude',
    })
    noteGsdUserMessage(s, inject, { startsOwnTurn: true })
    expect(s.gsdExecution?.taskSlug).toBe('wire-panel')
    expect(s.gsdExecution?.source).toBe('inject')

    // Mid-turn ordinary text must not clear (in-flight GSD may still run).
    noteGsdUserMessage(s, '顺手改一下注释', { startsOwnTurn: false })
    expect(s.gsdExecution?.taskSlug).toBe('wire-panel')

    // Own-turn ordinary chat clears execution.
    noteGsdUserMessage(s, '帮我看下登录 bug', { startsOwnTurn: true })
    expect(s.gsdExecution).toBeNull()
  })

  test('mark/clear helpers', () => {
    const s = { gsdExecution: null } as Session
    markGsdExecution(s, '  abc  ', 'message')
    expect(s.gsdExecution).toEqual({
      taskSlug: 'abc',
      source: 'message',
      at: expect.any(Number),
    })
    clearGsdExecution(s)
    expect(s.gsdExecution).toBeNull()
    markGsdExecution(s, '   ', 'inject')
    expect(s.gsdExecution).toBeNull()
  })
})

describe('onGsdContinue busy path (no resume side-effect)', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gsd-continue-'))
    mkdirSync(join(root, '.gsd'), { recursive: true })
    writeFileSync(
      join(root, '.gsd', 'TRACKER.md'),
      `# GSD 任务跟踪

## 当前活跃任务

- 状态：无任务
- task_slug：
- 任务名称：
- 当前阶段：unknown
- 最后更新：
- planning_path：
- 备注：

## 任务索引

| task_slug | 名称 | 状态 | 创建时间 | 最后更新 |
|-----------|------|------|----------|----------|
`,
    )
    execSync('git init', { cwd: join(root, '.gsd') })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  test('busy: returns busy without resuming 已暂停', async () => {
    createAndActivateTask(root, 'Busy Resume Guard')
    expect(pauseActiveTask(root).status).toBe('已暂停')

    const injectCalls: string[] = []
    const clearCalls: string[] = []
    const s = {
      workDir: root,
      sessionName: 't',
      gsdPanelGen: 'gen-1',
      gsdAwaitingNameUntil: 0,
      gsdPanelMessageId: '',
      gsdExecution: null,
      currentTurn: { id: 'turn-1' },
      openingTurn: null,
      pendingUserMessageCount: 0,
      pendingMidTurnMsgs: [],
      isRunning: () => true,
      currentProvider: () => 'claude' as const,
      clearStaleIdleQueueState(reason: string) {
        clearCalls.push(reason)
      },
      async onUserMessage(text: string) {
        injectCalls.push(text)
      },
    } as unknown as Session

    const result = await onGsdContinue(s, '', 'gen-1')
    expect(result.ok).toBe(false)
    expect(result.message).toBe(GSD_BUSY_MSG)
    expect(injectCalls).toEqual([])
    // Mid-turn: clearStaleIdleQueueIfSafe must not call (currentTurn set).
    expect(clearCalls).toEqual([])
    // Store must stay 已暂停 — resume was not applied.
    expect(readGsdSnapshot(root).status).toBe('已暂停')
  })

  test('idle inject bumps panel gen so second click with old gen is stale', async () => {
    const created = createAndActivateTask(root, 'Double Click Guard')
    const injectCalls: string[] = []
    const s = {
      workDir: root,
      sessionName: 't',
      gsdPanelGen: 'gen-1',
      gsdAwaitingNameUntil: 99,
      gsdPanelMessageId: '',
      gsdExecution: null,
      currentTurn: null,
      openingTurn: null,
      pendingUserMessageCount: 0,
      pendingMidTurnMsgs: [],
      isRunning: () => true,
      currentProvider: () => 'claude' as const,
      clearStaleIdleQueueState() {},
      async onUserMessage(text: string) {
        injectCalls.push(text)
      },
    } as unknown as Session

    // Capture gen before continue; after success resultWithCard rebuilds card and bumps again.
    const first = await onGsdContinue(s, created.taskSlug, 'gen-1')
    expect(first.ok).toBe(true)
    expect(injectCalls.length).toBe(1)
    // Old gen must no longer validate (bumped before inject and again in resultWithCard).
    expect(validatePanelGen(s, 'gen-1')).toEqual({
      ok: false,
      message: GSD_PANEL_STALE_MSG,
    })
    expect(s.gsdAwaitingNameUntil).toBe(0)
    // Continue arms session execution for fine progress.
    expect(s.gsdExecution?.taskSlug).toBe(created.taskSlug)

    const second = await onGsdContinue(s, created.taskSlug, 'gen-1')
    expect(second.ok).toBe(false)
    expect(second.message).toBe(GSD_PANEL_STALE_MSG)
    expect(injectCalls.length).toBe(1)
  })

  test('pause clears gsdExecution', async () => {
    const created = createAndActivateTask(root, 'Pause Clears Exec')
    const s = {
      workDir: root,
      sessionName: 't',
      gsdPanelGen: 'gen-1',
      gsdAwaitingNameUntil: 0,
      gsdPanelMessageId: '',
      gsdExecution: {
        taskSlug: created.taskSlug,
        source: 'inject' as const,
        at: Date.now(),
      },
      currentProvider: () => 'claude' as const,
    } as unknown as Session

    const result = await onGsdPause(s, created.taskSlug, 'gen-1')
    expect(result.ok).toBe(true)
    expect(s.gsdExecution).toBeNull()
    expect(readGsdSnapshot(root).status).toBe('已暂停')
  })

  test('text continue (panelGen null) arms execution without panel gen', async () => {
    const created = createAndActivateTask(root, 'Text Continue')
    const injectCalls: string[] = []
    const s = {
      workDir: root,
      sessionName: 't',
      gsdPanelGen: 'gen-stale',
      gsdAwaitingNameUntil: 0,
      gsdPanelMessageId: '',
      gsdExecution: null,
      currentTurn: null,
      openingTurn: null,
      pendingUserMessageCount: 0,
      pendingMidTurnMsgs: [],
      isRunning: () => true,
      currentProvider: () => 'claude' as const,
      clearStaleIdleQueueState() {},
      async onUserMessage(text: string) {
        injectCalls.push(text)
      },
    } as unknown as Session

    const result = await onGsdContinue(s, '', null)
    expect(result.ok).toBe(true)
    expect(injectCalls.length).toBe(1)
    expect(injectCalls[0]).toContain('[Lodestar GSD]')
    expect(s.gsdExecution?.taskSlug).toBe(created.taskSlug)
  })
})
