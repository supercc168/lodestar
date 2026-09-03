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
import type { ConversationLaunch, ConversationRouting } from './conversation'
import type { TurnAnchor } from './feishu'
import {
  branchBaseBySession,
  resetFeishuMock,
  sentCards,
  turnAnchorsBySession,
} from './feishu-test-mock'
import {
  onBackSelect,
  onForkSelect,
  showBackList,
  showForkList,
} from './session-temp'

interface TempHarnessState {
  routing: ConversationRouting
  rollbackResult: boolean
  preservedRecovery: boolean
  leaseStolen: boolean
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
    isRunning: () => false,
    hasPreservedWatchdogRecovery: () => state.preservedRecovery,
    beginLifecycle: (kind: string) => {
      currentLease = Object.freeze({ kind })
      return currentLease
    },
    ownsLifecycle: (lease: object | null | undefined) =>
      !!lease && lease === currentLease && !state.leaseStolen,
    listCodexConversations: async () => [],
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
    const second = makeHarness('project', 'claude')
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
