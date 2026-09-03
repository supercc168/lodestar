/**
 * session-temp panel 状态机测试(上游 ff44afb 安全修复:opaque panel/choice id
 * 取代 anchorIdx 下标信任)。harness 形态照上游 session-temp.test.ts:
 * feishu-test-mock(bunfig preload 已全局注册)+ 手写 session 桩(conversationRouting/
 * rollbackTo 捕获)。本地适配:ConversationRouting 无 tokenSourceId(D-02 slim,
 * routing stale 用 model 漂移驱动);本地 lease/watchdog 守卫桩(守卫叠加保护线)。
 *
 * 陷阱 7(reservedTempChatNames 模块级保留集):选型 = finally releaseTempChatName
 * 全路径覆盖(上游同款),并以「连续两用例同名不互撞 + 失败路径释放」测试锁定。
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import type { ConversationLaunch, ConversationRouting, ConversationSummary } from './conversation'
import type { TurnAnchor } from './feishu'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  branchBaseBySession,
  feishuMockState,
  resetFeishuMock,
  sentCards,
  sentTexts,
  turnAnchorsBySession,
} from './feishu-test-mock'
import {
  onBackSelect,
  onForkSelect,
  onResumeSelect,
  runBtwCommand,
  runByeCommand,
  showBackList,
  showForkList,
  showResumeList,
} from './session-temp'

interface TempHarnessState {
  routing: ConversationRouting
  rollbackResult: boolean
  preservedRecovery: boolean
  leaseStolen: boolean
  running: boolean
  history: ConversationSummary[]
}

interface TempHarness {
  session: any
  state: TempHarnessState
  createCalls: any[]
  rollbackCalls: ConversationLaunch[]
  rollbackStates: any[]
}

function makeHarness(sessionName = 'project', provider: 'claude' | 'codex' = 'codex'): TempHarness {
  const state: TempHarnessState = {
    routing: provider === 'codex'
      ? { provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' }
      : { provider: 'claude', model: 'claude-opus-4-6', effort: 'max' as any },
    rollbackResult: true,
    preservedRecovery: false,
    leaseStolen: false,
    running: false,
    history: [],
  }
  const createCalls: any[] = []
  const rollbackCalls: ConversationLaunch[] = []
  const rollbackStates: any[] = []
  let currentLease: object | null = null
  const session: any = {
    sessionName,
    chatId: `oc_${sessionName}`,
    selectedProvider: provider,
    lastSessionId: 'current-thread',
    workDir: '/workspace/project',
    opts: {
      onCreateTempSession: async (input: any) => {
        createCalls.push(input)
        return { ok: true }
      },
    },
    backendLabel: () => (provider === 'codex' ? 'Codex' : 'Claude'),
    conversationRouting: () => ({ ...state.routing }),
    isRunning: () => state.running,
    hasPreservedWatchdogRecovery: () => state.preservedRecovery,
    beginLifecycle: (kind: string) => {
      currentLease = Object.freeze({ kind })
      return currentLease
    },
    ownsLifecycle: (lease: object | null | undefined) =>
      !!lease && lease === currentLease && !state.leaseStolen,
    listCodexConversations: async () => state.history.slice(),
    rollbackTo: async (launch: ConversationLaunch, branchState?: { anchors: TurnAnchor[]; base: any }) => {
      rollbackCalls.push(launch)
      rollbackStates.push(branchState)
      if (state.rollbackResult) {
        session.lastSessionId = 'fork-result-thread'
        if (branchState) {
          turnAnchorsBySession.set(session.sessionName, branchState.anchors.slice())
          branchBaseBySession.set(session.sessionName, branchState.base)
        }
      }
      return state.rollbackResult
    },
  }
  return { session, state, createCalls, rollbackCalls, rollbackStates }
}

function anchorFor(
  provider: 'claude' | 'codex',
  preview: string,
  sourceSessionId: string,
  checkpointId: string,
  writes: TurnAnchor['writes'] = [],
  ts = Date.now(),
): TurnAnchor {
  return {
    checkpoint: provider === 'codex'
      ? {
          provider: 'codex',
          kind: 'turn',
          id: checkpointId,
          source: { provider: 'codex', sessionId: sourceSessionId, cwd: '/workspace/project' },
        }
      : {
          provider: 'claude',
          kind: 'assistant-message',
          id: checkpointId,
          source: { provider: 'claude', sessionId: sourceSessionId, cwd: '/workspace/project' },
        },
    preview,
    ts,
    writes,
  }
}

function pickerValue(card: any, preview: string): { panelId: string; choiceId: string } {
  for (const element of card?.body?.elements ?? []) {
    if (element?.tag !== 'column_set') continue
    const markdown = element.columns?.[0]?.elements?.[0]?.content
    if (!String(markdown ?? '').includes(preview)) continue
    const value = element.columns?.[1]?.elements?.[0]?.behaviors?.[0]?.value
    if (typeof value?.panel_id === 'string' && typeof value?.choice_id === 'string') {
      return { panelId: value.panel_id, choiceId: value.choice_id }
    }
  }
  throw new Error(`picker choice not found for preview: ${preview}`)
}

/** 给 harness 的 session 铺一条可分叉锚点链(base fresh,index 0 可见)。 */
function seedAnchors(h: TempHarness, provider: 'claude' | 'codex', previews: string[]): TurnAnchor[] {
  const anchors = previews.map((preview, i) =>
    anchorFor(provider, preview, i === 0 ? 'root-thread' : 'current-thread', `turn-${i}`))
  turnAnchorsBySession.set(h.session.sessionName, anchors)
  branchBaseBySession.set(h.session.sessionName, { kind: 'fresh' })
  return anchors
}

beforeEach(() => {
  resetFeishuMock()
})

// ── claim 五重拒绝(拒绝载荷 replaceCard:false,不消费选择卡) ──────────

describe('session-temp panel claim 五重拒绝', () => {
  test('第一重:panel 不存在(过期)与 mode 不符均拒绝', async () => {
    const h = makeHarness()
    const missing = await onForkSelect(h.session, 'missing-panel', 'any-choice', 'ou_owner')
    expect(missing).toMatchObject({ ok: false, replaceCard: false })
    expect(missing.message).toContain('已过期')

    seedAnchors(h, 'codex', ['guarded-input'])
    await showForkList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'guarded-input')
    // fork panel 用 back 入口点击 = mode 不符,同样按过期拒绝
    const wrongMode = await onBackSelect(h.session, value.panelId, value.choiceId, 'ou_owner')
    expect(wrongMode).toMatchObject({ ok: false, replaceCard: false })
    expect(wrongMode.message).toContain('已过期')
    expect(h.createCalls).toHaveLength(0)
    expect(h.rollbackCalls).toHaveLength(0)
  })

  test('第二重:非 requester 点击拒绝不消费,owner 随后仍可成功', async () => {
    const h = makeHarness('owner-guard', 'claude')
    seedAnchors(h, 'claude', ['owner-input'])
    await showForkList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'owner-input')

    const rejected = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_other')
    expect(rejected).toMatchObject({ ok: false, replaceCard: false })
    expect(rejected.message).toContain('只有打开这张选择卡的用户')
    expect(h.createCalls).toHaveLength(0)

    const accepted = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_owner')
    expect(accepted.ok).toBe(true)
    expect(h.createCalls).toHaveLength(1)
    expect(h.createCalls[0].chatName).toBe('owner-guard*0000-0000')
  })

  test('第三重:processing 中重复点击被拒(status 非 open 单向消费)', async () => {
    const h = makeHarness('double-click', 'claude')
    seedAnchors(h, 'claude', ['double-input'])
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    h.session.opts.onCreateTempSession = async (input: any) => {
      h.createCalls.push(input)
      entered()
      await gate
      return { ok: true }
    }

    await showForkList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'double-input')
    const firstRun = onForkSelect(h.session, value.panelId, value.choiceId, 'ou_owner')
    await started
    const second = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_owner')
    expect(second).toMatchObject({ ok: false, replaceCard: false })
    expect(second.message).toContain('请勿重复点击')
    release()
    const first = await firstRun
    expect(first.ok).toBe(true)
    expect(h.createCalls).toHaveLength(1)
  })

  test('第四重:provider/workDir 漂移拒绝且 panel 仍 open,恢复后可再点成功', async () => {
    const h = makeHarness('stale-guard', 'claude')
    seedAnchors(h, 'claude', ['stale-input'])
    await showForkList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'stale-input')

    h.session.selectedProvider = 'codex'
    const staleProvider = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_owner')
    expect(staleProvider).toMatchObject({ ok: false, replaceCard: false })
    expect(staleProvider.message).toContain('已经变化')
    h.session.selectedProvider = 'claude'

    h.session.workDir = '/workspace/elsewhere'
    const staleWorkDir = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_owner')
    expect(staleWorkDir).toMatchObject({ ok: false, replaceCard: false })
    expect(staleWorkDir.message).toContain('已经变化')
    h.session.workDir = '/workspace/project'

    expect(h.createCalls).toHaveLength(0)
    // stale 拒绝不消费:恢复现场后 owner 仍可成功(panel 仍 open)
    const accepted = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_owner')
    expect(accepted.ok).toBe(true)
    expect(h.createCalls).toHaveLength(1)
  })

  test('第四重(补):源会话与 routing(model) 漂移同样拒绝', async () => {
    const h = makeHarness('stale-rest')
    seedAnchors(h, 'codex', ['stale-rest-input'])
    await showForkList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'stale-rest-input')

    h.session.lastSessionId = 'replacement-thread'
    const staleSession = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_owner')
    expect(staleSession).toMatchObject({ ok: false, replaceCard: false })
    expect(staleSession.message).toContain('已经变化')
    h.session.lastSessionId = 'current-thread'

    // 本地 slim routing 无 tokenSourceId(D-02):stale 驱动改用 model 漂移
    h.state.routing.model = 'gpt-5.6-max'
    const staleRouting = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_owner')
    expect(staleRouting).toMatchObject({ ok: false, replaceCard: false })
    expect(staleRouting.message).toContain('已经变化')
    expect(h.createCalls).toHaveLength(0)
  })

  test('第五重:无效 choiceId 拒绝且不消费 panel', async () => {
    const h = makeHarness('bad-choice')
    seedAnchors(h, 'codex', ['bad-choice-input'])
    await showForkList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'bad-choice-input')

    const rejected = await onForkSelect(h.session, value.panelId, 'bogus-choice', 'ou_owner')
    expect(rejected).toMatchObject({ ok: false, replaceCard: false })
    expect(rejected.message).toContain('无效的选择项')
    expect(h.createCalls).toHaveLength(0)
  })
})

// ── TTL / consumed 状态(假时钟驱动) ─────────────────────────────────

describe('session-temp panel TTL 与 consumed 状态', () => {
  test('open panel 超 30min TTL 过期,claim 拒绝', async () => {
    const h = makeHarness('ttl-open')
    seedAnchors(h, 'codex', ['ttl-input'])
    const realNow = Date.now
    const base = realNow()
    try {
      Date.now = () => base
      await showForkList(h.session, 'ou_owner')
      const value = pickerValue(sentCards[0], 'ttl-input')
      Date.now = () => base + 31 * 60 * 1000
      const result = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_owner')
      expect(result).toMatchObject({ ok: false, replaceCard: false })
      expect(result.message).toContain('已过期')
    } finally {
      Date.now = realNow
    }
  })

  test('consumed panel 60min 内拒绝重复点击,超 60min 清理为过期', async () => {
    const h = makeHarness('ttl-consumed', 'claude')
    seedAnchors(h, 'claude', ['consumed-input'])
    const realNow = Date.now
    const base = realNow()
    try {
      Date.now = () => base
      await showForkList(h.session, 'ou_owner')
      const value = pickerValue(sentCards[0], 'consumed-input')
      const first = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_owner')
      expect(first.ok).toBe(true)

      Date.now = () => base + 59 * 60 * 1000
      const replay = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_owner')
      expect(replay).toMatchObject({ ok: false, replaceCard: false })
      expect(replay.message).toContain('请勿重复点击')

      Date.now = () => base + 61 * 60 * 1000
      const expired = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_owner')
      expect(expired).toMatchObject({ ok: false, replaceCard: false })
      expect(expired.message).toContain('已过期')
      expect(h.createCalls).toHaveLength(1)
    } finally {
      Date.now = realNow
    }
  })
})

// ── reserveTempChatName 保留集(陷阱 7:模块级状态测试间零泄漏) ────────

describe('session-temp reserveTempChatName 保留集', () => {
  test('并发创建同步预留临时群名,同分钟避让为 -2', async () => {
    const first = makeHarness('project', 'claude')
    // 第二个会话用临时后缀名(baseName 同解析为 project):撞名面相同,
    // 而锚点容器 key(sessionName)互不覆盖。
    const second = makeHarness('project*0101-0101', 'claude')
    seedAnchors(first, 'claude', ['first-concurrent'])
    seedAnchors(second, 'claude', ['second-concurrent'])
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    first.session.opts.onCreateTempSession = async (input: any) => {
      first.createCalls.push(input)
      entered()
      await gate
      return { ok: true }
    }

    await showForkList(first.session, 'ou_first')
    const firstValue = pickerValue(sentCards[0], 'first-concurrent')
    const firstRun = onForkSelect(first.session, firstValue.panelId, firstValue.choiceId, 'ou_first')
    await started
    await showForkList(second.session, 'ou_second')
    const secondValue = pickerValue(sentCards[1], 'second-concurrent')
    const secondResult = await onForkSelect(second.session, secondValue.panelId, secondValue.choiceId, 'ou_second')
    release()
    await firstRun

    expect(first.createCalls[0].chatName).toBe('project*0000-0000')
    expect(secondResult.ok).toBe(true)
    expect(second.createCalls[0].chatName).toBe('project*0000-0000-2')
  })

  test('保留集零泄漏:失败路径 finally 释放,前一用例的保留不残留', async () => {
    // 陷阱 7 锚:上一用例同 baseName('project')已 reserve 过——若保留集测试间
    // 泄漏,这里首次 reserve 会拿到 -2 而非基名。
    const h = makeHarness('project', 'claude')
    seedAnchors(h, 'claude', ['leak-input'])
    h.session.opts.onCreateTempSession = async () => {
      throw new Error('create blew up')
    }

    await showForkList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'leak-input')
    const failed = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_owner')
    expect(failed.ok).toBe(false)
    expect(failed.message).toContain('分叉失败')

    // 失败路径 finally 已释放:同名再次创建仍拿基名(不因残留避让成 -2)
    const retry = makeHarness('project', 'claude')
    seedAnchors(retry, 'claude', ['retry-input'])
    await showForkList(retry.session, 'ou_owner')
    const retryValue = pickerValue(sentCards[1], 'retry-input')
    const ok = await onForkSelect(retry.session, retryValue.panelId, retryValue.choiceId, 'ou_owner')
    expect(ok.ok).toBe(true)
    expect(retry.createCalls[0].chatName).toBe('project*0000-0000')
  })
})

// ═══ Task 3:五命令新语义(上游 ff44afb;门控解除后 Codex 三命令可达) ═══

/** Claude transcript 临时目录(上游 'Claude rs 成功' 同型:CLAUDE_CONFIG_DIR 覆盖)。 */
async function withClaudeHistory(
  sessions: Record<string, string>,
  run: () => Promise<void>,
): Promise<void> {
  const configDir = mkdtempSync(join(tmpdir(), 'lodestar-claude-rs-'))
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  const transcriptDir = join(configDir, 'projects', '/workspace/project'.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(transcriptDir, { recursive: true })
  for (const [sessionId, firstInput] of Object.entries(sessions)) {
    writeFileSync(join(transcriptDir, `${sessionId}.jsonl`), `${JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      content: firstInput,
    })}\n`)
  }
  process.env.CLAUDE_CONFIG_DIR = configDir
  try {
    await run()
  } finally {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    rmSync(configDir, { recursive: true, force: true })
  }
}

describe('session-temp Codex btw/fork(上游 ff44afb)', () => {
  test('btw 以当前 routing 和原 workDir 创建 fresh 会话(双后端)', async () => {
    const h = makeHarness()

    await runBtwCommand(h.session, 'ou_owner')

    expect(h.createCalls).toEqual([{
      chatName: 'project*0000-0000',
      userOpenId: 'ou_owner',
      workDir: '/workspace/project',
      routing: h.state.routing,
      launch: { kind: 'fresh' },
      branchBase: { kind: 'fresh' },
      seedAnchors: [],
    }])
    expect(sentTexts.some(text => text.includes('Codex'))).toBe(true)
    expect(sentTexts.at(-1)).toContain('已创建')
  })

  test('bye 不再要求先 stop:运行中也直接停止并解散,带 chatId 精确交给回调', async () => {
    const h = makeHarness('project*0101-0101')
    h.state.running = true
    const disbandCalls: Array<[string, string]> = []
    h.session.opts.onDisbandTempSession = async (name: string, chatId: string) => {
      disbandCalls.push([name, chatId])
      return { ok: true }
    }

    await runByeCommand(h.session)

    expect(disbandCalls).toEqual([['project*0101-0101', 'oc_project*0101-0101']])
    expect(sentTexts.some(text => text.includes('正在停止会话并解散'))).toBe(true)
    expect(sentTexts.some(text => text.includes('还在跑'))).toBe(false)
  })

  test('fork 第 0 条输入从 fresh 启动且不 seed 历史', async () => {
    const h = makeHarness()
    const first = anchorFor('codex', 'first-input', 'original-thread', 'turn-1')
    turnAnchorsBySession.set(h.session.sessionName, [first])
    branchBaseBySession.set(h.session.sessionName, { kind: 'fresh' })

    await showForkList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'first-input')
    const result = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_owner')

    expect(result.ok).toBe(true)
    expect(h.createCalls[0].launch).toEqual({ kind: 'fresh' })
    expect(h.createCalls[0].seedAnchors).toEqual([])
  })

  test('fork 后续输入使用前一 checkpoint 自带 source 并 seed 分叉前锚点', async () => {
    const h = makeHarness()
    const first = anchorFor('codex', 'first-input', 'root-thread', 'turn-root')
    const second = anchorFor('codex', 'second-input', 'nested-thread', 'turn-nested')
    const third = anchorFor('codex', 'third-input', 'current-thread', 'turn-current')
    turnAnchorsBySession.set(h.session.sessionName, [first, second, third])
    branchBaseBySession.set(h.session.sessionName, { kind: 'fresh' })

    await showForkList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'third-input')
    const result = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_owner')

    expect(result.ok).toBe(true)
    expect(h.createCalls[0].launch).toEqual({
      kind: 'fork',
      source: { provider: 'codex', sessionId: 'nested-thread', cwd: '/workspace/project' },
      through: second.checkpoint,
    })
    expect(h.createCalls[0].launch.source.sessionId).not.toBe(h.session.lastSessionId)
    expect(h.createCalls[0].seedAnchors).toEqual([first, second])
  })

  test('full-fork 历史后的第一条新输入沿用 branch base,不误退化成 fresh', async () => {
    const h = makeHarness('history-branch')
    const base: Extract<ConversationLaunch, { kind: 'fork' }> = {
      kind: 'fork',
      source: { provider: 'codex', sessionId: 'historical-root', cwd: '/workspace/project' },
    }
    const firstNew = anchorFor('codex', 'first-new-input', 'fork-result-thread', 'new-turn-1')
    turnAnchorsBySession.set(h.session.sessionName, [firstNew])
    branchBaseBySession.set(h.session.sessionName, base)

    await showForkList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'first-new-input')
    const result = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_owner')

    expect(result.ok).toBe(true)
    expect(h.createCalls[0].launch).toEqual(base)
    expect(h.createCalls[0].branchBase).toEqual(base)
  })

  test('legacy unknown branch base 不暴露最老输入为伪 fresh 起点', async () => {
    const h = makeHarness('legacy-unknown')
    turnAnchorsBySession.set(h.session.sessionName, [
      anchorFor('codex', 'unknown-origin-input', 'old-thread', 'old-turn'),
    ])
    branchBaseBySession.set(h.session.sessionName, null)

    await showForkList(h.session, 'ou_owner')

    expect(() => pickerValue(sentCards[0], 'unknown-origin-input')).toThrow('picker choice not found')
  })
})

describe('session-temp Codex back(上游 ff44afb)', () => {
  test('展示 bk 列表不触发 rollback,点击成功后才经 branchState 替换 anchors', async () => {
    const h = makeHarness()
    const first = anchorFor('codex', 'keep-input', 'root-thread', 'turn-keep')
    const second = anchorFor('codex', 'rollback-input', 'current-thread', 'turn-rollback', [
      { tool: 'FileChange', path: '/workspace/project/a.ts', body: '+changed' },
    ])
    turnAnchorsBySession.set(h.session.sessionName, [first, second])
    branchBaseBySession.set(h.session.sessionName, { kind: 'fresh' })

    await showBackList(h.session, 'ou_owner')

    expect(h.rollbackCalls).toHaveLength(0)
    expect(turnAnchorsBySession.get('project')).toEqual([first, second])
    const value = pickerValue(sentCards[0], 'rollback-input')

    const result = await onBackSelect(h.session, value.panelId, value.choiceId, 'ou_owner')

    expect(result.ok).toBe(true)
    expect(h.rollbackCalls).toEqual([{
      kind: 'fork',
      source: { provider: 'codex', sessionId: 'root-thread', cwd: '/workspace/project' },
      through: first.checkpoint,
    }])
    expect(h.rollbackStates[0]).toMatchObject({ anchors: [first], base: { kind: 'fresh' } })
    expect(turnAnchorsBySession.get('project')).toEqual([first])
  })

  test('rollback 失败时保留原 anchors,不执行 clear/seed', async () => {
    const h = makeHarness('failed-back')
    h.state.rollbackResult = false
    const first = anchorFor('codex', 'first-input', 'root-thread', 'turn-1')
    const second = anchorFor('codex', 'second-input', 'current-thread', 'turn-2')
    turnAnchorsBySession.set(h.session.sessionName, [first, second])
    branchBaseBySession.set(h.session.sessionName, { kind: 'fresh' })

    await showBackList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'second-input')
    const result = await onBackSelect(h.session, value.panelId, value.choiceId, 'ou_owner')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('原会话绑定未改')
    expect(h.rollbackCalls).toHaveLength(1)
    expect(turnAnchorsBySession.get('failed-back')).toEqual([first, second])
  })

  test('claim 通过后 lease 被并发抢占→动作拒绝不 rollback(本地守卫叠加锚)', async () => {
    const h = makeHarness('lease-steal', 'claude')
    const first = anchorFor('claude', 'steal-keep', 'root-session', 'uuid-keep')
    const second = anchorFor('claude', 'steal-input', 'current-thread', 'uuid-rollback')
    turnAnchorsBySession.set(h.session.sessionName, [first, second])
    branchBaseBySession.set(h.session.sessionName, { kind: 'fresh' })

    await showBackList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'steal-input')
    // writeLog 卡发送窗口内并发 lifecycle 抢占(claim 通过 ≠ lifecycle 可抢占)
    feishuMockState.sendCard = async () => {
      h.state.leaseStolen = true
      return 'om_writelog'
    }
    const result = await onBackSelect(h.session, value.panelId, value.choiceId, 'ou_owner')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('被更新的会话操作打断')
    expect(h.rollbackCalls).toHaveLength(0)
    expect(turnAnchorsBySession.get('lease-steal')).toEqual([first, second])
  })
})

describe('session-temp Codex stopped-session history(上游 ff44afb rs=history fork)', () => {
  test('rs 对所选历史 thread 创建不带 checkpoint 的 full fork', async () => {
    const h = makeHarness()
    const selectedTs = 1_787_350_000_000
    h.state.history = [{
      provider: 'codex',
      sessionId: 'historical-thread',
      cwd: '/workspace/project',
      preview: 'historical-input',
      ts: selectedTs,
      status: 'idle',
    }]
    turnAnchorsBySession.set(h.session.sessionName, [
      anchorFor('codex', 'old-local-input', 'current-thread', 'turn-old'),
    ])

    await showResumeList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'historical-input')
    const result = await onResumeSelect(h.session, value.panelId, value.choiceId, 'ou_owner')

    expect(result.ok).toBe(true)
    expect(h.rollbackCalls).toEqual([{
      kind: 'fork',
      source: { provider: 'codex', sessionId: 'historical-thread', cwd: '/workspace/project' },
    }])
    expect(Object.prototype.hasOwnProperty.call(h.rollbackCalls[0], 'through')).toBe(false)
    expect(turnAnchorsBySession.get('project')).toEqual([])
    expect(branchBaseBySession.get('project')).toEqual(h.rollbackCalls[0])
    expect(h.rollbackStates[0].pendingLaunch).toBeNull()
    expect(result.resumePresentation).toEqual({
      projectName: 'project',
      provider: 'codex',
      selectedPreview: 'historical-input',
      selectedTs,
      sourceSessionId: 'historical-thread',
      sourceStatus: 'idle',
      previousSessionId: 'current-thread',
      newSessionId: 'fork-result-thread',
      bindingState: 'changed',
    })
    expect(sentTexts.some(text => text.includes('正在从历史会话'))).toBe(false)
  })

  test('rs 所选 Codex 历史仍 active 时拒绝且不 rollback(源侧保护)', async () => {
    const h = makeHarness('active-source')
    h.state.history = [{
      provider: 'codex',
      sessionId: 'active-thread',
      cwd: '/workspace/project',
      preview: 'active-input',
      ts: Date.now(),
      status: 'active',
    }]

    await showResumeList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'active-input')
    const result = await onResumeSelect(h.session, value.panelId, value.choiceId, 'ou_owner')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('仍在运行')
    expect(result.resumePresentation?.bindingState).toBe('unchanged')
    expect(h.rollbackCalls).toHaveLength(0)
  })

  test('rs 非 owner 只 toast 且不消费 panel,owner 随后仍可成功', async () => {
    const h = makeHarness('resume-owner-guard')
    h.state.history = [{
      provider: 'codex',
      sessionId: 'owner-source-thread',
      cwd: '/workspace/project',
      preview: 'owner-guard-input',
      ts: Date.now(),
      status: 'idle',
    }]

    await showResumeList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'owner-guard-input')
    const rejected = await onResumeSelect(h.session, value.panelId, value.choiceId, 'ou_other')
    expect(rejected).toMatchObject({ ok: false, replaceCard: false })
    expect(rejected.resumePresentation).toBeUndefined()
    expect(h.rollbackCalls).toHaveLength(0)

    const accepted = await onResumeSelect(h.session, value.panelId, value.choiceId, 'ou_owner')
    expect(accepted.ok).toBe(true)
    expect(accepted.resumePresentation?.sourceSessionId).toBe('owner-source-thread')
    expect(h.rollbackCalls).toHaveLength(1)
  })

  test('rs rollback 失败仍返回带所选快照的红色终态信息', async () => {
    const h = makeHarness('resume-failure')
    h.state.rollbackResult = false
    h.state.history = [{
      provider: 'codex',
      sessionId: 'failed-source-thread',
      cwd: '/workspace/project',
      preview: 'failed-history-input',
      ts: 1_787_351_000_000,
      status: 'systemError',
    }]

    await showResumeList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'failed-history-input')
    const result = await onResumeSelect(h.session, value.panelId, value.choiceId, 'ou_owner')

    expect(result).toMatchObject({ ok: false })
    expect(result.replaceCard).not.toBe(false)
    expect(result.resumePresentation).toEqual({
      projectName: 'resume-failure',
      provider: 'codex',
      selectedPreview: 'failed-history-input',
      selectedTs: 1_787_351_000_000,
      sourceSessionId: 'failed-source-thread',
      sourceStatus: 'systemError',
      previousSessionId: 'current-thread',
      newSessionId: null,
      bindingState: 'unchanged',
    })
    expect(result.message).toContain('原会话绑定未改')
  })

  test('rs 后端声称成功但缺少独立新 id 时显式失败', async () => {
    const h = makeHarness('resume-missing-id')
    h.state.history = [{
      provider: 'codex',
      sessionId: 'missing-id-source',
      cwd: '/workspace/project',
      preview: 'missing-id-input',
      ts: Date.now(),
      status: 'idle',
    }]
    h.session.rollbackTo = async (launch: ConversationLaunch) => {
      h.rollbackCalls.push(launch)
      h.session.lastSessionId = null
      return true
    }

    await showResumeList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'missing-id-input')
    const result = await onResumeSelect(h.session, value.panelId, value.choiceId, 'ou_owner')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('没有返回新会话 id')
    expect(result.resumePresentation?.newSessionId).toBeNull()
    expect(result.resumePresentation?.previousSessionId).toBe('current-thread')
    expect(result.resumePresentation?.bindingState).toBe('unknown')
  })

  test('Claude rs 成功走 prepared 终态契约(pendingLaunch 随 branchState 提交)', async () => {
    const h = makeHarness('claude-project', 'claude')
    h.session.lastSessionId = 'current-claude-session'
    h.session.rollbackTo = async (launch: ConversationLaunch, branchState: any) => {
      h.rollbackCalls.push(launch)
      h.rollbackStates.push(branchState)
      // Claude SDK 首条输入才 materialize 新 session id:成功也不推进 lastSessionId
      return true
    }
    await withClaudeHistory({ 'historical-claude-session': 'claude-history-input' }, async () => {
      await showResumeList(h.session, 'ou_owner')
      const value = pickerValue(sentCards[0], 'claude-history-input')
      const result = await onResumeSelect(h.session, value.panelId, value.choiceId, 'ou_owner')

      expect(result.ok).toBe(true)
      expect(h.rollbackCalls).toEqual([{
        kind: 'fork',
        source: {
          provider: 'claude',
          sessionId: 'historical-claude-session',
          cwd: '/workspace/project',
        },
      }])
      expect(result.resumePresentation).toMatchObject({
        projectName: 'claude-project',
        provider: 'claude',
        selectedPreview: 'claude-history-input',
        sourceSessionId: 'historical-claude-session',
        previousSessionId: 'current-claude-session',
        newSessionId: null,
        bindingState: 'prepared',
      })
      expect(h.rollbackStates[0].pendingLaunch).toEqual({
        launch: h.rollbackCalls[0],
        previousSessionId: 'current-claude-session',
      })
      expect(result.message).toContain('首条消息时生成并接入')
    })
  })

  test('claude idle(proc 存活)选历史成功——陷阱 1 选型锚(不采上游 isRunning 拒绝)', async () => {
    // 本地 claude 进程 turn 间常驻保活(isRunning() 恒 true,d9341b6):照抄上游
    // running 拒绝会让 claude 空闲选历史永拒。本地语义 = rollbackTo 内部 restart
    // 作废当前 proc,选历史必须成功。
    const h = makeHarness('claude-idle', 'claude')
    h.state.running = true
    h.session.lastSessionId = 'current-claude-session'
    h.session.rollbackTo = async (launch: ConversationLaunch, branchState: any) => {
      h.rollbackCalls.push(launch)
      h.rollbackStates.push(branchState)
      return true
    }
    await withClaudeHistory({ 'idle-history-session': 'idle-history-input' }, async () => {
      await showResumeList(h.session, 'ou_owner')
      const value = pickerValue(sentCards[0], 'idle-history-input')
      const result = await onResumeSelect(h.session, value.panelId, value.choiceId, 'ou_owner')

      expect(result.ok).toBe(true)
      expect(result.resumePresentation?.bindingState).toBe('prepared')
      expect(h.rollbackCalls).toHaveLength(1)
    })
  })
})
