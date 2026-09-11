/**
 * provider 契约单测(03-02 Task 1,上游 722e45a 接入面)。
 *
 * 上游没有同名文件 —— 上游把这几条断言散在 dsh-process.test.ts 与 session 测试里,
 * 本地 `src/agent-process.ts` 的 provider 联合/标签/usage 源是本 plan 的落点(见
 * 03-02 PLAN Task 1),集中成文件后 D-09 接线点与三元联合的回归门是显式的。
 *
 * 本文件只做纯函数断言,不 spawn 任何子进程、不读真实凭据。
 */
import { describe, expect, test } from 'bun:test'
import {
  AGENT_PROVIDERS,
  agentProviderLabel,
  isAgentProvider,
  isDshReasoningEffort,
  providerFromModel,
  usageSourceForAgent,
} from './agent-process'
import { validateConversationLaunch, type ConversationLaunch } from './conversation'

describe('AgentProvider 三元联合', () => {
  test('AGENT_PROVIDERS 恰好三值且联合由其派生', () => {
    expect(AGENT_PROVIDERS).toEqual(['codex', 'claude', 'dsh'])
  })

  test('isAgentProvider 只认三元联合', () => {
    for (const provider of ['codex', 'claude', 'dsh'] as const) {
      expect(isAgentProvider(provider)).toBe(true)
    }
    for (const value of ['other', 'DSH', 'claude ', '', null, undefined, 1, {}, []]) {
      expect(isAgentProvider(value)).toBe(false)
    }
  })
})

describe('providerFromModel', () => {
  test('dsh: 前缀判为 dsh,不落回 codex', () => {
    expect(providerFromModel('dsh:deepseek-v4-pro')).toBe('dsh')
    expect(providerFromModel('dsh:deepseek-v4-flash')).toBe('dsh')
  })

  test('claude:/其余前缀语义不变', () => {
    expect(providerFromModel('claude:glm')).toBe('claude')
    expect(providerFromModel('gpt-5.6-sol')).toBe('codex')
    expect(providerFromModel(null)).toBe('codex')
    expect(providerFromModel(undefined)).toBe('codex')
  })
})

describe('agentProviderLabel', () => {
  test('三值映射:dsh 不再被误标为 Codex', () => {
    expect(agentProviderLabel('claude')).toBe('Claude')
    expect(agentProviderLabel('codex')).toBe('Codex')
    expect(agentProviderLabel('dsh')).toBe('DeepSeek Harness')
  })
})

describe('usageSourceForAgent(D-09 唯一接线点)', () => {
  test('dsh 走 provider 余额通道', () => {
    expect(usageSourceForAgent('dsh', 'dsh:anything')).toBe('provider')
    expect(usageSourceForAgent('dsh', null)).toBe('provider')
  })

  test('双轨保护线:claude 三条既有规则逐条不变', () => {
    expect(usageSourceForAgent('codex', 'gpt-5.6-sol')).toBe('codex')
    expect(usageSourceForAgent('claude', 'claude:glm')).toBe('glm')
    expect(usageSourceForAgent('claude', 'claude:grok')).toBe('provider')
    expect(usageSourceForAgent('claude', 'claude:deepseek')).toBe('provider')
    expect(usageSourceForAgent('claude', 'claude:fable')).toBe('not_applicable')
  })
})

describe('isDshReasoningEffort 守卫(复用 03-01 已落符号)', () => {
  test('off/low/high/max 为真,其余为假', () => {
    for (const effort of ['off', 'low', 'high', 'max'] as const) {
      expect(isDshReasoningEffort(effort)).toBe(true)
    }
    for (const value of ['medium', 'xhigh', 'ultra', 'none', 'minimal', '', null, undefined, 1, {}, []]) {
      expect(isDshReasoningEffort(value)).toBe(false)
    }
  })
})

describe('validateConversationLaunch 的 dsh checkpoint', () => {
  const source = { provider: 'dsh', sessionId: 'dsh-session-1', cwd: '/work' } as const

  test('数字事件序号通过', () => {
    const launch: ConversationLaunch = {
      kind: 'fork',
      source,
      through: { provider: 'dsh', kind: 'event', id: '42', source },
    }
    expect(() => validateConversationLaunch(launch, 'dsh', '/work')).not.toThrow()
  })

  test('非数字事件序号抛错', () => {
    const launch: ConversationLaunch = {
      kind: 'fork',
      source,
      through: { provider: 'dsh', kind: 'event', id: 'event-42', source },
    }
    expect(() => validateConversationLaunch(launch, 'dsh', '/work'))
      .toThrow('DSH checkpoint must be a non-negative event sequence')
  })

  test('负数与非安全整数抛错', () => {
    for (const id of ['-1', '9007199254740993', '1.5']) {
      const launch: ConversationLaunch = {
        kind: 'fork',
        source,
        through: { provider: 'dsh', kind: 'event', id, source },
      }
      expect(() => validateConversationLaunch(launch, 'dsh', '/work'))
        .toThrow('DSH checkpoint must be a non-negative event sequence')
    }
  })

  test('codex checkpoint 的非数字 id 语义不变(校验只对 dsh 生效)', () => {
    const codexSource = { provider: 'codex', sessionId: 'codex-session-1', cwd: '/work' } as const
    const launch: ConversationLaunch = {
      kind: 'fork',
      source: codexSource,
      through: { provider: 'codex', kind: 'turn', id: 'turn-7', source: codexSource },
    }
    expect(() => validateConversationLaunch(launch, 'codex', '/work')).not.toThrow()
  })
})
