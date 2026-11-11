import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentClaudeAccountRejection, agentRunLockKeys, claudeSubAgentLimits, findLockCollision, findUnityProjectRoot,
  formatLockKey, parseLockKey,
} from './agent-admission'
import { config } from './config'

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lodestar-agent-admission-')))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('claude-sub Agent limits', () => {
  test('defaults to 4 overall and 2 per account; [agent] config and env override, env first', () => {
    const saved = config.agent
    try {
      delete config.agent
      expect(claudeSubAgentLimits({})).toEqual({ global: 4, perAccount: 2, fiveHourMaxUsed: 80, weeklyMaxUsed: 90 })
      config.agent = { claude_sub_max_concurrent: 3, claude_sub_max_per_account: 1 }
      expect(claudeSubAgentLimits({})).toMatchObject({ global: 3, perAccount: 1 })
      expect(claudeSubAgentLimits({ LODESTAR_CLAUDE_SUB_MAX_CONCURRENT: '6', LODESTAR_CLAUDE_SUB_MAX_PER_ACCOUNT: '0' }))
        .toMatchObject({ global: 6, perAccount: 1 })
    } finally {
      if (saved) config.agent = saved
      else delete config.agent
    }
  })

  test('per-account cap and 5h / weekly thresholds exclude an account', () => {
    const limits = claudeSubAgentLimits({})
    expect(agentClaudeAccountRejection({ fiveHourUsed: 10, weeklyUsed: 20 }, 1, limits)).toBeNull()
    expect(agentClaudeAccountRejection({ fiveHourUsed: 10, weeklyUsed: 20 }, 2, limits)).toContain('每号上限 2')
    expect(agentClaudeAccountRejection({ fiveHourUsed: 79.9, weeklyUsed: 89.9 }, 0, limits)).toBeNull()
    expect(agentClaudeAccountRejection({ fiveHourUsed: 80, weeklyUsed: 0 }, 0, limits)).toContain('5h 已用 80%')
    expect(agentClaudeAccountRejection({ weeklyUsed: 90 }, 0, limits)).toContain('周额度已用 90%')
    expect(agentClaudeAccountRejection({ weeklyUsed: 10 }, 0, limits)).toBeNull()
  })
})

describe('collision lock keys', () => {
  test('work_dir, the Unity project root at or above it, and the evidence dir', () => {
    const unity = join(dir, 'game')
    mkdirSync(join(unity, 'Assets', 'Scripts'), { recursive: true })
    mkdirSync(join(unity, 'ProjectSettings'), { recursive: true })
    expect(findUnityProjectRoot(join(unity, 'Assets', 'Scripts'))).toBe(unity)
    expect(findUnityProjectRoot(dir)).toBeNull()
    expect(agentRunLockKeys(unity).map(formatLockKey)).toEqual([`workdir:${unity}`])
    const keys = agentRunLockKeys(join(unity, 'Assets', 'Scripts'), join(dir, 'evidence', 'not-yet'))
    expect(keys.map(formatLockKey)).toEqual([
      `workdir:${join(unity, 'Assets', 'Scripts')}`, `unity:${unity}`, `evidence:${join(dir, 'evidence', 'not-yet')}`,
    ])
    expect(keys.map(formatLockKey).map(parseLockKey)).toEqual(keys)
  })

  test('collisions are equality or ancestry, never a shared name prefix', () => {
    const at = (path: string) => [{ kind: 'workdir' as const, path }]
    expect(findLockCollision(at('/a/gate'), at('/a/gate'))).not.toBeNull()
    expect(findLockCollision(at('/a/gate'), at('/a/gate/ClientServer'))).not.toBeNull()
    expect(findLockCollision(at('/a/gate/ClientServer'), at('/a/gate'))).not.toBeNull()
    expect(findLockCollision(at('/a/gate'), at('/a/gate-2'))).toBeNull()
    expect(findLockCollision(at('/a/x'), at('/a/y'))).toBeNull()
  })
})

function isolated(script: string): void {
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
}

test('Agent account selection applies thresholds and caps and never falls back; the chat path keeps its fallback', () => {
  isolated(`
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    const accountsApi = await import('./src/claude-accounts')
    const accounts = [{ id: 'default', name: '默认', identity: 'id-default' }, { id: 'vale', name: 'vale', identity: 'id-vale' }]
    mock.module('./src/claude-accounts', () => ({ ...accountsApi, claudeAccounts: {
      list: () => accounts, assertReady: id => accounts.find(account => account.id === id),
    } }))
    const sources = new Map(accounts.map(account => [account.id, { id: 'claude-sub', account: account.id, enabled: true,
      modelCatalogState: { status: 'ready' }, defaultModel: 'opus' }]))
    const registry = await import('./src/token-source')
    mock.module('./src/token-source', () => ({ ...registry,
      getTokenSourceForAccount: (_id, accountId) => sources.get(accountId),
      tokenSourceRuntimeModel: () => ({ model: 'opus', efforts: ['medium', 'max'], defaultEffort: 'medium' }),
    }))
    const usage = new Map()
    const cache = await import('./src/token-source-cache')
    mock.module('./src/token-source-cache', () => ({ ...cache, peekTokenSourceUsage: source => usage.get(source.account) }))
    const { config } = await import('./src/config')
    config.token_sources = { ...config.token_sources, 'claude-sub': { enabled: true } }
    const { selectClaudeAccount } = await import('./src/claude-account-selection')
    const { claudeSubAgentLimits } = await import('./src/agent-admission')
    const later = hours => new Date(Date.now() + hours * 3600_000)
    const snap = (five, week) => ({ state: 'ok', windows: [
      { kind: 'fiveHour', label: '5h 窗口', percent: five, resetsAt: later(2) },
      { kind: 'weekly', label: '周额度', percent: week, resetsAt: later(48) },
    ] })
    const limits = claudeSubAgentLimits({})
    const agent = (runs = {}) => ({ runs: new Map(Object.entries(runs)), limits })

    usage.set('default', snap(10, 10)); usage.set('vale', snap(20, 20))
    assert.equal(selectClaudeAccount({ model: 'opus', effort: 'max', agent: agent() }), 'default')
    // Per-account cap reached on default: the reservation moves to vale.
    assert.equal(selectClaudeAccount({ model: 'opus', effort: 'max', agent: agent({ default: 2 }) }), 'vale')
    // 5h >= 80% is not eligible; weekly >= 90% is excluded.
    usage.set('default', snap(85, 10))
    assert.equal(selectClaudeAccount({ model: 'opus', effort: 'max', agent: agent() }), 'vale')
    usage.set('vale', snap(10, 92))
    assert.throws(() => selectClaudeAccount({ model: 'opus', effort: 'max', agent: agent() }),
      error => error.code === 'CLAUDE_SUB_FULL' && /5h 已用 85%/.test(error.message) && /周额度已用 92%/.test(error.message)
        && error.message.includes('agent:Y29kZXgtc3ViAGdwdC02LjEtc29s'))
    // Every account exhausted: the Agent path rejects, the chat path keeps the original-account fallback.
    usage.set('default', snap(100, 50)); usage.set('vale', snap(10, 100))
    assert.throws(() => selectClaudeAccount({ model: 'opus', effort: 'max', exhaustedFallbackAccountId: 'vale', agent: agent() }),
      error => error.code === 'CLAUDE_SUB_FULL')
    assert.equal(selectClaudeAccount({ model: 'opus', effort: 'max', exhaustedFallbackAccountId: 'vale' }), 'vale')
    // Chat path is unchanged by the Agent thresholds: accounts the Agent path excludes stay selectable there.
    usage.set('default', snap(85, 95)); usage.set('vale', snap(90, 10))
    assert.equal(selectClaudeAccount({ model: 'opus', effort: 'max' }), 'default')
    assert.throws(() => selectClaudeAccount({ model: 'opus', effort: 'max', agent: agent() }), error => error.code === 'CLAUDE_SUB_FULL')
  `)
})
