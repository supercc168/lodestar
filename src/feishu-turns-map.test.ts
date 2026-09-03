/**
 * turns map V4 状态层测试(上游 ff44afb feishu-turns-map.test.ts 按本地承接)。
 *
 * Harness 说明(开放问题 3 例外通道,理由入 04-02-SUMMARY):bunfig [test].preload
 * 在任何测试文件加载前注册 feishu-test-mock 的 mock.module('./feishu'),进程内
 * 一切 './feishu' import 都拿到 mock —— 锚模式无法在本进程触达真实模块级 map。
 * 故采用上游同款子进程 fresh-state harness:Bun.spawnSync(bun --eval) + 临时
 * LODESTAR_DATA_DIR/LODESTAR_CONFIG(bun run 不加载 [test].preload,子进程拿到
 * 真实 feishu.ts;config 模板与 01-02 test-preload 本地 schema 一致)。
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateConversationLaunch } from './conversation'

interface FreshResult { exitCode: number; stdout: string; stderr: string }

function runFreshState(
  work: string,
  initialFiles: Record<string, unknown> = {},
): FreshResult {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-turns-map-'))
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  for (const [name, value] of Object.entries(initialFiles)) {
    writeFileSync(join(dataDir, name), JSON.stringify(value, null, 2) + '\n')
  }
  const configFile = join(root, 'config.toml')
  writeFileSync(configFile, [
    '[feishu]',
    'app_id = "t"',
    'app_secret = "t"',
    '',
    '[runtime]',
    `projects_root = "${root.replace(/\\/g, '\\\\')}"`,
    '',
  ].join('\n'))
  const feishuModule = pathToFileURL(join(import.meta.dir, 'feishu.ts')).href
  const script = `
    import * as feishu from ${JSON.stringify(feishuModule)}
    import { mkdirSync, readFileSync, rmSync } from 'node:fs'
    import { join } from 'node:path'
    const __dataDir = ${JSON.stringify(dataDir)}
    const __read = name => JSON.parse(readFileSync(join(__dataDir, name), 'utf8'))
    const __out = value => process.stdout.write('@@@' + JSON.stringify(value) + '@@@')
    ${work}
  `
  try {
    const result = Bun.spawnSync({
      cmd: [process.execPath, '--eval', script],
      env: { ...process.env, LODESTAR_DATA_DIR: dataDir, LODESTAR_CONFIG: configFile },
    })
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function extract(result: FreshResult): any {
  const marker = result.stdout.match(/@@@([\s\S]*?)@@@/)
  if (!marker) {
    throw new Error(
      `no @@@ marker (exitCode=${result.exitCode})\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    )
  }
  return JSON.parse(marker[1])
}

/** 剥 getTurnAnchors 的 V1 读投影字段(PHASE4-TRANSITION),得到纯 V4 形态 —— 用于
 *  断言磁盘持久化不被投影污染(uuid/sid 只存在于返回值,不落盘)。 */
function pure(anchor: any): any {
  const { uuid, sid, ...rest } = anchor
  return rest
}

describe('session turn checkpoint persistence', () => {
  test('loads V2 checkpoints with an unknown base and null legacy cwd', () => {
    const result = runFreshState(`
      feishu.loadSessionTurnsMap()
      __out({ base: feishu.getSessionBranchBase('project'), anchors: feishu.getTurnAnchors('project') })
    `, {
      'session-turns-map.json': {
        project: [
          {
            checkpoint: {
              provider: 'claude',
              kind: 'assistant-message',
              id: 'assistant-1',
              source: { provider: 'claude', sessionId: 'claude-session' },
            },
            preview: 'claude input',
            ts: 100,
            writes: [{ tool: 'Edit', path: '/tmp/a.ts', body: 'after' }],
          },
          {
            checkpoint: {
              provider: 'codex',
              kind: 'turn',
              id: 'turn-2',
              source: { provider: 'codex', sessionId: 'codex-thread' },
            },
            preview: 'codex input',
            ts: 200,
            writes: [],
          },
        ],
      },
    })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(extract(result)).toEqual({
      base: null,
      anchors: [
        {
          checkpoint: {
            provider: 'claude',
            kind: 'assistant-message',
            id: 'assistant-1',
            source: { provider: 'claude', sessionId: 'claude-session', cwd: null },
          },
          preview: 'claude input',
          ts: 100,
          writes: [{ tool: 'Edit', path: '/tmp/a.ts', body: 'after' }],
          uuid: 'assistant-1',
          sid: 'claude-session',
        },
        {
          checkpoint: {
            provider: 'codex',
            kind: 'turn',
            id: 'turn-2',
            source: { provider: 'codex', sessionId: 'codex-thread', cwd: null },
          },
          preview: 'codex input',
          ts: 200,
          writes: [],
          uuid: 'turn-2',
          sid: 'codex-thread',
        },
      ],
    })
  })

  test('migrates a whole legacy chain only for an unambiguous Claude-only resume key', () => {
    const result = runFreshState(`
      feishu.loadSessionResumeMap()
      feishu.loadSessionTurnsMap()
      __out({
        claude: feishu.getTurnAnchors('legacy-claude'),
        codex: feishu.getTurnAnchors('legacy-codex'),
        ambiguous: feishu.getTurnAnchors('legacy-ambiguous'),
      })
    `, {
      'session-resume-map.json': {
        'legacy-claude': { claude: 'different-current-session' },
        'legacy-codex': { codex: 'codex-current' },
        'legacy-ambiguous': { claude: 'shared-current', codex: 'shared-current' },
      },
      'session-turns-map.json': {
        'legacy-claude': [
          {
            uuid: 'assistant-old',
            sid: 'claude-ancestor',
            preview: 'old input',
            ts: 300,
            writes: [{ path: '/tmp/old.ts' }],
          },
          { uuid: 'assistant-older', sid: 'claude-other-ancestor', preview: 'older', ts: 301 },
          { uuid: 'missing-source', sid: '', preview: 'unsafe', ts: 301 },
          {
            checkpoint: {
              provider: 'codex',
              kind: 'assistant-message',
              id: 'not-a-turn',
              source: { provider: 'codex', sessionId: 'thread' },
            },
            uuid: 'must-not-fallback',
            sid: 'claude-session',
            ts: 302,
          },
        ],
        'legacy-codex': [{ uuid: 'agent-message-item', sid: 'codex-current', preview: 'unsafe', ts: 400 }],
        'legacy-ambiguous': [{ uuid: 'unknown-item', sid: 'shared-current', preview: 'unsafe', ts: 500 }],
      },
    })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(extract(result)).toEqual({
      claude: [
        {
          checkpoint: {
            provider: 'claude',
            kind: 'assistant-message',
            id: 'assistant-old',
            source: { provider: 'claude', sessionId: 'claude-ancestor', cwd: null },
          },
          preview: 'old input',
          ts: 300,
          writes: [{ tool: 'Write', path: '/tmp/old.ts', body: '' }],
          uuid: 'assistant-old',
          sid: 'claude-ancestor',
        },
        {
          checkpoint: {
            provider: 'claude', kind: 'assistant-message', id: 'assistant-older',
            source: { provider: 'claude', sessionId: 'claude-other-ancestor', cwd: null },
          },
          preview: 'older', ts: 301, writes: [],
          uuid: 'assistant-older',
          sid: 'claude-other-ancestor',
        },
      ],
      codex: [],
      ambiguous: [],
    })
    // rejected 路径真实驱动:codex 键在场/双键歧义/坏 checkpoint/缺 sid 共 4 条被丢弃且计数可观测
    expect(result.stderr).toContain('rejected 4 malformed turn anchors')
  })

  test('round-trips explicit fresh and full-fork bases with absolute cwd', () => {
    const result = runFreshState(`
      const cwd = '/srv/lodestar/project'
      const first = {
        checkpoint: {
          provider: 'codex', kind: 'turn', id: 'turn-1',
          source: { provider: 'codex', sessionId: 'forked-thread', cwd },
        },
        preview: 'first', ts: 1, writes: [],
      }
      feishu.setSessionBranchBase('fresh', { kind: 'fresh' })
      feishu.replaceTurnAnchors('forked', [first], {
        kind: 'fork',
        source: { provider: 'codex', sessionId: 'source-thread', cwd },
      })
      feishu.replaceTurnAnchors('cleared', [first], { kind: 'fresh' })
      // 04-04 壳收账:clearTurnAnchors → replaceTurnAnchors 空表(断言意图零变:
      // 清空后 base 回 null、anchors 空、round-trip 不残留)。
      feishu.replaceTurnAnchors('cleared', [], null, null)
      feishu.loadSessionTurnsMap()
      __out({
        fresh: feishu.getSessionBranchBase('fresh'),
        fullFork: feishu.getSessionBranchBase('forked'),
        anchors: feishu.getTurnAnchors('forked'),
        cleared: {
          base: feishu.getSessionBranchBase('cleared'),
          anchors: feishu.getTurnAnchors('cleared'),
        },
        persisted: __read('session-turns-map.json'),
      })
    `)

    expect(result.exitCode, result.stderr).toBe(0)
    const output = extract(result)
    expect(output.fresh).toEqual({ kind: 'fresh' })
    expect(output.fullFork).toEqual({
      kind: 'fork',
      source: { provider: 'codex', sessionId: 'source-thread', cwd: '/srv/lodestar/project' },
    })
    expect(output.anchors[0].checkpoint.source.cwd).toBe('/srv/lodestar/project')
    expect(output.cleared).toEqual({ base: null, anchors: [] })
    // base=null(cleared 会话已整体删除)与 {kind:'fresh'} 显式基线是两种语义:
    // null 绝不当 fresh,fresh 必须显式持久化。
    expect(output.persisted).toEqual({
      fresh: { base: { kind: 'fresh' }, anchors: [] },
      forked: { base: output.fullFork, anchors: output.anchors.map(pure) },
    })
  })

  test('advances the branch base through the discarded checkpoint at 201 anchors', () => {
    const result = runFreshState(`
      const cwd = '/srv/lodestar/project'
      feishu.setSessionBranchBase('project', { kind: 'fresh' })
      for (let i = 1; i <= 201; i++) {
        feishu.appendTurnAnchorChecked('project', {
          checkpoint: {
            provider: 'codex', kind: 'turn', id: 'turn-' + i,
            source: { provider: 'codex', sessionId: 'thread-1', cwd },
          },
          preview: 'input-' + i,
          ts: i,
          writes: [],
        })
      }
      __out({
        base: feishu.getSessionBranchBase('project'),
        anchors: feishu.getTurnAnchors('project'),
        persisted: __read('session-turns-map.json').project,
      })
    `)

    expect(result.exitCode, result.stderr).toBe(0)
    const output = extract(result)
    expect(output.anchors).toHaveLength(200)
    expect(output.anchors[0].checkpoint.id).toBe('turn-2')
    expect(output.anchors[199].checkpoint.id).toBe('turn-201')
    expect(output.base).toEqual({
      kind: 'fork',
      source: {
        provider: 'codex', sessionId: 'thread-1', cwd: '/srv/lodestar/project',
      },
      through: {
        provider: 'codex', kind: 'turn', id: 'turn-1',
        source: {
          provider: 'codex', sessionId: 'thread-1', cwd: '/srv/lodestar/project',
        },
      },
    })
    expect(output.persisted).toEqual({ base: output.base, anchors: output.anchors.map(pure) })
  })

  test('round-trips and clears a durable pending Claude fork without losing branch state', () => {
    const result = runFreshState(`
      const launch = {
        kind: 'fork',
        source: {
          provider: 'claude', sessionId: 'source-session', cwd: '/srv/lodestar/project',
        },
      }
      const pending = { launch, previousSessionId: 'previous-session' }
      feishu.replaceTurnAnchors('project', [], launch, pending)
      feishu.loadSessionTurnsMap()
      const loaded = feishu.getPendingConversationLaunch('project')
      feishu.setPendingConversationLaunchChecked('project', null)
      __out({
        loaded,
        base: feishu.getSessionBranchBase('project'),
        anchors: feishu.getTurnAnchors('project'),
        persisted: __read('session-turns-map.json').project,
      })
    `)

    expect(result.exitCode, result.stderr).toBe(0)
    expect(extract(result)).toEqual({
      loaded: {
        launch: {
          kind: 'fork',
          source: {
            provider: 'claude', sessionId: 'source-session', cwd: '/srv/lodestar/project',
          },
        },
        previousSessionId: 'previous-session',
      },
      base: {
        kind: 'fork',
        source: {
          provider: 'claude', sessionId: 'source-session', cwd: '/srv/lodestar/project',
        },
      },
      anchors: [],
      persisted: {
        base: {
          kind: 'fork',
          source: {
            provider: 'claude', sessionId: 'source-session', cwd: '/srv/lodestar/project',
          },
        },
        anchors: [],
      },
    })
  })

  test('rejects a persisted pending fork without an authoritative cwd', () => {
    const result = runFreshState(`
      feishu.loadSessionTurnsMap()
      __out({ pending: feishu.getPendingConversationLaunch('unsafe'), anchors: feishu.getTurnAnchors('unsafe') })
    `, {
      'session-turns-map.json': {
        unsafe: {
          base: null,
          anchors: [],
          pendingLaunch: {
            launch: {
              kind: 'fork',
              source: { provider: 'claude', sessionId: 'source-session', cwd: null },
            },
            previousSessionId: null,
          },
        },
      },
    })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(extract(result)).toEqual({ pending: null, anchors: [] })
    expect(result.stderr).toContain('rejected 1 malformed turn anchors')
  })

  test('append and ordinary replace preserve pending; explicit null consumes it', () => {
    const result = runFreshState(`
      const launch = {
        kind: 'fork',
        source: {
          provider: 'claude', sessionId: 'source-session', cwd: '/srv/lodestar/project',
        },
      }
      const pending = { launch, previousSessionId: 'previous-session' }
      feishu.replaceTurnAnchors('project', [], launch, pending)
      feishu.appendTurnAnchorChecked('project', {
        checkpoint: {
          provider: 'claude', kind: 'assistant-message', id: 'assistant-1',
          source: {
            provider: 'claude', sessionId: 'materialized-session', cwd: '/srv/lodestar/project',
          },
        },
        preview: 'first input', ts: 1, writes: [],
      })
      const afterAppend = feishu.getPendingConversationLaunch('project')
      feishu.replaceTurnAnchors('project', feishu.getTurnAnchors('project'), launch)
      const afterReplace = feishu.getPendingConversationLaunch('project')
      feishu.replaceTurnAnchors('project', feishu.getTurnAnchors('project'), launch, null)
      __out({
        afterAppend,
        afterReplace,
        afterExplicitClear: feishu.getPendingConversationLaunch('project'),
      })
    `)

    expect(result.exitCode, result.stderr).toBe(0)
    const output = extract(result)
    expect(output.afterAppend).toEqual(output.afterReplace)
    expect(output.afterAppend.previousSessionId).toBe('previous-session')
    expect(output.afterExplicitClear).toBeNull()
  })

  test('checked pending write failure restores the prior in-memory marker', () => {
    const result = runFreshState(`
      const launch = {
        kind: 'fork',
        source: {
          provider: 'claude', sessionId: 'source-session', cwd: '/srv/lodestar/project',
        },
      }
      const pending = { launch, previousSessionId: 'previous-session' }
      feishu.setPendingConversationLaunchChecked('project', pending)
      const statePath = join(__dataDir, 'session-turns-map.json')
      rmSync(statePath)
      mkdirSync(statePath)
      let error = ''
      try { feishu.setPendingConversationLaunchChecked('project', null) }
      catch (cause) { error = String(cause?.message ?? cause) }
      __out({ error, pending: feishu.getPendingConversationLaunch('project') })
    `)

    expect(result.exitCode, result.stderr).toBe(0)
    const output = extract(result)
    expect(output.error).not.toBe('')
    expect(output.pending.previousSessionId).toBe('previous-session')
    expect(output.pending.launch.source.sessionId).toBe('source-session')
  })

  test('checked append/replace write failure rolls back memory to the pre-write snapshot', () => {
    const result = runFreshState(`
      const cwd = '/srv/lodestar/project'
      const anchor = id => ({
        checkpoint: {
          provider: 'codex', kind: 'turn', id,
          source: { provider: 'codex', sessionId: 'thread-1', cwd },
        },
        preview: 'input-' + id, ts: 1, writes: [],
      })
      feishu.appendTurnAnchorChecked('project', anchor('turn-1'))
      const statePath = join(__dataDir, 'session-turns-map.json')
      rmSync(statePath)
      mkdirSync(statePath)
      let appendError = ''
      try { feishu.appendTurnAnchorChecked('project', anchor('turn-2')) }
      catch (cause) { appendError = String(cause?.message ?? cause) }
      const afterAppendFailure = feishu.getTurnAnchors('project')
      let replaceError = ''
      try { feishu.replaceTurnAnchors('project', [], null, null) }
      catch (cause) { replaceError = String(cause?.message ?? cause) }
      __out({
        appendError,
        replaceError,
        anchors: feishu.getTurnAnchors('project'),
        afterAppendFailure,
        base: feishu.getSessionBranchBase('project'),
      })
    `)

    expect(result.exitCode, result.stderr).toBe(0)
    const output = extract(result)
    expect(output.appendError).not.toBe('')
    expect(output.replaceError).not.toBe('')
    // 内存 === 写前快照(非仅断言 throw):失败的 append/replace 不残留、不丢失
    expect(output.afterAppendFailure.map((a: any) => a.checkpoint.id)).toEqual(['turn-1'])
    expect(output.anchors.map((a: any) => a.checkpoint.id)).toEqual(['turn-1'])
    expect(output.base).toBeNull()
  })

  test('getTurnAnchors projects uuid/sid for V1 consumers; projection stays out of the persisted V4 state', () => {
    // PHASE4-TRANSITION 读投影(删除责任 04-06——panel 状态机改读 checkpoint 后删):
    // getTurnAnchors 返回值投影 uuid/sid 供 V1 消费方(session-temp resumeAt 读
    // .uuid);磁盘保持纯 V4。appendTurnAnchor V1 输入壳已随 04-03 recordTurnAnchor
    // checked 化删除,写入一律 appendTurnAnchorChecked。
    const result = runFreshState(`
      feishu.appendTurnAnchorChecked('project', {
        checkpoint: {
          provider: 'claude', kind: 'assistant-message', id: 'assistant-1',
          source: { provider: 'claude', sessionId: 'claude-sid', cwd: null },
        },
        preview: 'first', ts: 1, writes: [],
      })
      feishu.appendTurnAnchorChecked('project', {
        checkpoint: {
          provider: 'claude', kind: 'assistant-message', id: 'assistant-2',
          source: { provider: 'claude', sessionId: 'claude-sid', cwd: null },
        },
        preview: 'second', ts: 2,
        writes: [{ tool: 'Edit', path: '/tmp/x.ts', body: 'b' }],
      })
      feishu.truncateTurnAnchors('project', 1)
      __out({
        anchors: feishu.getTurnAnchors('project'),
        base: feishu.getSessionBranchBase('project'),
        persisted: __read('session-turns-map.json').project,
      })
    `)

    expect(result.exitCode, result.stderr).toBe(0)
    const output = extract(result)
    expect(output.anchors).toEqual([
      {
        checkpoint: {
          provider: 'claude', kind: 'assistant-message', id: 'assistant-1',
          source: { provider: 'claude', sessionId: 'claude-sid', cwd: null },
        },
        preview: 'first', ts: 1, writes: [],
        uuid: 'assistant-1',
        sid: 'claude-sid',
      },
    ])
    expect(output.base).toBeNull()
    expect(output.persisted.anchors).toHaveLength(1)
    expect(output.persisted.anchors[0]).not.toHaveProperty('uuid')
    expect(output.persisted.anchors[0]).not.toHaveProperty('sid')
    expect(output.persisted.anchors[0].checkpoint.id).toBe('assistant-1')
  })
})

describe('session conversation state cleanup', () => {
  test('round-trips provider conversation refs with their absolute cwd', () => {
    const result = runFreshState(`
      feishu.bindSessionResume('project', {
        provider: 'codex', sessionId: 'codex-thread', cwd: '/srv/codex-project',
      })
      feishu.bindSessionResumeChecked('project', 'claude-session', 'claude', '/srv/claude-project')
      feishu.loadSessionResumeMap()
      __out({
        codexId: feishu.getSessionResume('project', 'codex'),
        claudeId: feishu.getSessionResume('project', 'claude'),
        codexRef: feishu.getSessionResumeRef('project', 'codex'),
        claudeRef: feishu.getSessionResumeRef('project', 'claude'),
        persisted: __read('session-resume-map.json'),
      })
    `)

    expect(result.exitCode, result.stderr).toBe(0)
    expect(extract(result)).toEqual({
      codexId: 'codex-thread',
      claudeId: 'claude-session',
      codexRef: {
        provider: 'codex', sessionId: 'codex-thread', cwd: '/srv/codex-project',
      },
      claudeRef: {
        provider: 'claude', sessionId: 'claude-session', cwd: '/srv/claude-project',
      },
      persisted: {
        project: {
          codex: {
            provider: 'codex', sessionId: 'codex-thread', cwd: '/srv/codex-project',
          },
          claude: {
            provider: 'claude', sessionId: 'claude-session', cwd: '/srv/claude-project',
          },
        },
      },
    })
  })

  test('rejects new resume bindings without an absolute cwd', () => {
    const result = runFreshState(`
      const errors = []
      for (const bind of [
        () => feishu.bindSessionResume('missing', {
          provider: 'codex', sessionId: 'thread', cwd: null,
        }),
        () => feishu.bindSessionResumeChecked('relative', 'session', 'claude', 'relative/project'),
      ]) {
        try { bind() } catch (error) { errors.push(String(error?.message ?? error)) }
      }
      __out({
        errors,
        missing: feishu.getSessionResumeRef('missing', 'codex'),
        relative: feishu.getSessionResumeRef('relative', 'claude'),
      })
    `)

    expect(result.exitCode, result.stderr).toBe(0)
    expect(extract(result)).toEqual({
      errors: [
        'cannot bind a conversation without an absolute cwd: null',
        'cannot bind a conversation without an absolute cwd: relative/project',
      ],
      missing: null,
      relative: null,
    })
  })

  test('keeps the legacy 3-arg string signature working with a null cwd (zero-change call sites)', () => {
    // 本地兼容通道(翻译表 #7):session.ts bindSessionResume(name, id, provider)
    // 不带 cwd —— 内部升 ConversationRef{cwd:null},不得按上游 fail-closed 抛错。
    const result = runFreshState(`
      feishu.bindSessionResume('project', 'codex-thread', 'codex')
      __out({
        ref: feishu.getSessionResumeRef('project', 'codex'),
        persisted: __read('session-resume-map.json'),
      })
    `)

    expect(result.exitCode, result.stderr).toBe(0)
    expect(extract(result)).toEqual({
      ref: { provider: 'codex', sessionId: 'codex-thread', cwd: null },
      persisted: {
        project: { codex: { provider: 'codex', sessionId: 'codex-thread', cwd: null } },
      },
    })
  })

  test('keeps legacy resume compatibility and clears only the requested provider', () => {
    const result = runFreshState(`
      feishu.loadSessionResumeMap()
      const legacyCodex = feishu.getSessionResume('legacy')
      const legacyClaude = feishu.getSessionResume('legacy-claude', 'claude')
      const legacyRef = feishu.getSessionResumeRef('legacy-ref', 'codex')
      feishu.clearSessionResume('target', 'codex')
      __out({
        legacyCodex,
        legacyClaude,
        legacyRef,
        legacyCodexRef: feishu.getSessionResumeRef('legacy'),
        legacyClaudeRef: feishu.getSessionResumeRef('legacy-claude', 'claude'),
        targetCodex: feishu.getSessionResume('target', 'codex'),
        targetClaude: feishu.getSessionResume('target', 'claude'),
        targetClaudeRef: feishu.getSessionResumeRef('target', 'claude'),
        persisted: __read('session-resume-map.json'),
      })
    `, {
      'session-resume-map.json': {
        legacy: 'old-codex-thread',
        'legacy-claude': { provider: 'claude', session_id: 'old-claude-session' },
        'legacy-ref': { provider: 'codex', sessionId: 'old-ref-thread' },
        target: { codex: 'target-thread', claude: 'target-session' },
      },
    })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(extract(result)).toEqual({
      legacyCodex: 'old-codex-thread',
      legacyClaude: 'old-claude-session',
      legacyCodexRef: {
        provider: 'codex', sessionId: 'old-codex-thread', cwd: null,
      },
      legacyClaudeRef: {
        provider: 'claude', sessionId: 'old-claude-session', cwd: null,
      },
      legacyRef: {
        provider: 'codex', sessionId: 'old-ref-thread', cwd: null,
      },
      targetCodex: null,
      targetClaude: 'target-session',
      targetClaudeRef: {
        provider: 'claude', sessionId: 'target-session', cwd: null,
      },
      persisted: {
        legacy: {
          codex: { provider: 'codex', sessionId: 'old-codex-thread', cwd: null },
        },
        'legacy-claude': {
          claude: { provider: 'claude', sessionId: 'old-claude-session', cwd: null },
        },
        'legacy-ref': {
          codex: { provider: 'codex', sessionId: 'old-ref-thread', cwd: null },
        },
        target: {
          claude: { provider: 'claude', sessionId: 'target-session', cwd: null },
        },
      },
    })
  })

  test('checked resume cleanup restores the full ref when persistence fails', () => {
    const result = runFreshState(`
      feishu.loadSessionResumeMap()
      const resumeFile = join(__dataDir, 'session-resume-map.json')
      rmSync(resumeFile)
      mkdirSync(resumeFile)
      let error = null
      try { feishu.clearSessionResumeChecked('target', 'codex') }
      catch (caught) { error = String(caught?.message ?? caught) }
      __out({ error, restored: feishu.getSessionResumeRef('target', 'codex') })
    `, {
      'session-resume-map.json': {
        target: {
          codex: {
            provider: 'codex', sessionId: 'target-thread', cwd: '/srv/target',
          },
        },
      },
    })

    expect(result.exitCode, result.stderr).toBe(0)
    const output = extract(result)
    expect(output.error).toBeString()
    expect(output.error.length).toBeGreaterThan(0)
    expect(output.restored).toEqual({
      provider: 'codex', sessionId: 'target-thread', cwd: '/srv/target',
    })
  })

  test('permanent cleanup removes exact session resume, model and turns only', () => {
    const result = runFreshState(`
      feishu.loadSessionResumeMap()
      feishu.loadSessionModelMap()
      feishu.loadSessionTurnsMap()
      feishu.clearSessionConversationState('target')
      __out({
        target: {
          codex: feishu.getSessionResume('target', 'codex'),
          claude: feishu.getSessionResume('target', 'claude'),
          model: feishu.getSessionModelSelection('target'),
          turns: feishu.getTurnAnchors('target'),
        },
        keep: {
          resume: feishu.getSessionResume('keep', 'codex'),
          model: feishu.getSessionModelSelection('keep'),
          turns: feishu.getTurnAnchors('keep'),
        },
        persisted: {
          resume: __read('session-resume-map.json'),
          model: __read('session-model-map.json'),
          turns: __read('session-turns-map.json'),
        },
      })
    `, {
      'session-resume-map.json': {
        target: { codex: 'target-thread', claude: 'target-session' },
        keep: { codex: 'keep-thread' },
      },
      'session-model-map.json': {
        target: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
        keep: { provider: 'codex', model: 'gpt-5.5', effort: 'medium' },
      },
      'session-turns-map.json': {
        target: [{
          checkpoint: {
            provider: 'codex', kind: 'turn', id: 'target-turn',
            source: { provider: 'codex', sessionId: 'target-thread' },
          },
          preview: 'target', ts: 1, writes: [],
        }],
        keep: [{
          checkpoint: {
            provider: 'codex', kind: 'turn', id: 'keep-turn',
            source: { provider: 'codex', sessionId: 'keep-thread' },
          },
          preview: 'keep', ts: 2, writes: [],
        }],
      },
    })

    expect(result.exitCode, result.stderr).toBe(0)
    const output = extract(result)
    expect(output.target).toEqual({ codex: null, claude: null, model: null, turns: [] })
    expect(output.keep.resume).toBe('keep-thread')
    expect(output.keep.model).toEqual({ provider: 'codex', model: 'gpt-5.5', effort: 'medium' })
    expect(output.keep.turns).toHaveLength(1)
    expect(output.persisted.resume).toEqual({
      keep: {
        codex: { provider: 'codex', sessionId: 'keep-thread', cwd: null },
      },
    })
    expect(output.persisted.model).toEqual({
      keep: { provider: 'codex', model: 'gpt-5.5', effort: 'medium' },
    })
    expect(output.persisted.turns).toEqual({
      keep: { base: null, anchors: output.keep.turns.map(pure) },
    })
  })

  test('mid-transaction persistence failure restores every map and raises an AggregateError', () => {
    // 五 map 事务清理中途失败(turns 文件被换成目录 → 第 4 个 save 抛):
    // 全量恢复内存 + AggregateError(原始错误 + 恢复期再失败)——不得留下
    // "部分 map 已删、部分还在"的撕裂状态。
    const result = runFreshState(`
      const name = 'target*0821-1337'
      feishu.loadSessionResumeMap()
      feishu.loadSessionModelMap()
      feishu.loadSessionTurnsMap()
      feishu.loadTempSessionLeases()
      const turnsFile = join(__dataDir, 'session-turns-map.json')
      rmSync(turnsFile)
      mkdirSync(turnsFile)
      let error = null
      try { feishu.clearSessionConversationState(name) }
      catch (caught) {
        error = {
          isAggregate: caught instanceof AggregateError,
          message: String(caught?.message ?? caught),
        }
      }
      __out({
        error,
        resume: feishu.getSessionResume(name, 'codex'),
        model: feishu.getSessionModelSelection(name),
        turns: feishu.getTurnAnchors(name).map(a => a.checkpoint.id),
        lease: feishu.hasTempSessionLease(name, 'oc_lease'),
      })
    `, {
      'session-resume-map.json': { 'target*0821-1337': { codex: 'target-thread' } },
      'session-model-map.json': { 'target*0821-1337': { provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' } },
      'session-turns-map.json': {
        'target*0821-1337': [{
          checkpoint: {
            provider: 'codex', kind: 'turn', id: 'target-turn',
            source: { provider: 'codex', sessionId: 'target-thread' },
          },
          preview: 'target', ts: 1, writes: [],
        }],
      },
      'temp-session-leases.json': {
        oc_lease: { sessionName: 'target*0821-1337', chatId: 'oc_lease', createdAt: 1 },
      },
    })

    expect(result.exitCode, result.stderr).toBe(0)
    const output = extract(result)
    expect(output.error).not.toBeNull()
    expect(output.error.isAggregate).toBe(true)
    expect(output.error.message).toContain('failed to clear and restore conversation state')
    // 内存五 map 全量恢复(含删除面内的 lease)
    expect(output.resume).toBe('target-thread')
    expect(output.model).toEqual({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' })
    expect(output.turns).toEqual(['target-turn'])
    expect(output.lease).toBe(true)
  })
})

describe('conversation cwd validation', () => {
  test('fails closed for missing or mismatched source cwd when a target cwd is expected', () => {
    const legacy = {
      kind: 'resume' as const,
      source: { provider: 'codex' as const, sessionId: 'thread', cwd: null },
    }
    expect(() => validateConversationLaunch(legacy, 'codex', '/srv/project')).toThrow('source cwd is missing')

    const mismatched = {
      kind: 'resume' as const,
      source: { provider: 'codex' as const, sessionId: 'thread', cwd: '/srv/other' },
    }
    expect(() => validateConversationLaunch(mismatched, 'codex', '/srv/project')).toThrow('cwd mismatch')

    expect(() => validateConversationLaunch({
      kind: 'resume',
      source: { provider: 'codex', sessionId: 'thread', cwd: '/srv/project' },
    }, 'codex', '/srv/project')).not.toThrow()
  })
})
