import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const skillRoot = join(repoRoot, '.agents/skills/yiui-gsd')
const helper = join(skillRoot, 'scripts/yiui-gsd.mjs')

let root: string
let fakeGsdTools: string

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: join(root, '.gsd'),
    encoding: 'utf8',
  })
}

function runHelper(args: string[], timeout?: number) {
  return spawnSync('node', [
    helper,
    ...args,
    '--gsd-tools-path',
    fakeGsdTools,
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GSD_SESSION_KEY: 'yiui-gsd-test-session' },
    timeout,
  })
}

function expectOk(result: ReturnType<typeof runHelper>): void {
  expect(result.status, result.stderr || result.stdout).toBe(0)
}

function taskPath(slug: string): string {
  return join(root, '.gsd', slug, 'TASK.md')
}

function stageUnrelatedFile(): void {
  writeFileSync(join(root, '.gsd', 'manual.txt'), 'user staged content\n')
  git(['add', '--', 'manual.txt'])
}

function expectIndexGuard(result: ReturnType<typeof runHelper>): void {
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('GSD index must be empty')
}

function writePassingState(slug: string): void {
  const planning = join(root, '.gsd', slug, '.planning')
  mkdirSync(planning, { recursive: true })
  writeFileSync(join(planning, 'STATE.md'), [
    '---',
    'status: in_progress',
    'last_updated: "2026-07-21T00:00:00Z"',
    'progress:',
    '  total_plans: 2',
    '  completed_plans: 1',
    'finalization:',
    '  change_generation: 3',
    '  reviewed_generation: 3',
    '  scope_frozen: true',
    '  blocking_findings: 0',
    '  final_verified_generation: 3',
    '  final_verification_runs: 1',
    '---',
    '',
    '- current_phase: verify',
    '- current_plan: 02-PLAN.md',
    '- next_action: finish',
    '',
    '## 单向执行游标',
    '',
    '| 游标 | 项 | 状态 |',
    '|---|---|---|',
    '| 02/A | finish | RED |',
  ].join('\n'))
  writeFileSync(join(planning, '01-PLAN.md'), '# Plan 01: First\n')
  writeFileSync(join(planning, '02-PLAN.md'), '# Plan 02: Second\n')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'yiui-gsd-install-'))
  mkdirSync(join(root, '.gsd'), { recursive: true })
  git(['init', '-q'])
  git(['config', 'user.email', 'yiui-gsd-test@example.invalid'])
  git(['config', 'user.name', 'yiui-gsd Test'])
  fakeGsdTools = join(root, 'fake-gsd-tools.cjs')
  writeFileSync(fakeGsdTools, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    'const args = process.argv.slice(2)',
    "const cwdIndex = args.indexOf('--cwd')",
    "const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd()",
    "const state = path.join(cwd, '.fake-workstream')",
    "if (args[0] !== 'query') process.exit(2)",
    "if (args[1] === 'workstream.get') {",
    "  const active = fs.existsSync(state) ? fs.readFileSync(state, 'utf8').trim() : ''",
    "  console.log(JSON.stringify({ active: active || null, mode: 'flat' }))",
    "} else if (args[1] === 'workstream.set') {",
    "  const slug = args.includes('--clear') ? '' : String(args[2] || '')",
    "  fs.writeFileSync(state, slug)",
    "  console.log(JSON.stringify({ active: slug || null }))",
    '} else {',
    "  console.log('{}')",
    '}',
    '',
  ].join('\n'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('yiui-gsd cross-platform helper', () => {
  test('creates multiple running tasks and stable workstream routes', () => {
    expectOk(runHelper([
      'new-gsd-task',
      '--project-root', root,
      '--task-slug', 'alpha',
      '--task-name', 'Alpha',
      '--summary', 'first',
    ]))
    expectOk(runHelper([
      'new-gsd-task',
      '--project-root', root,
      '--task-slug', 'beta',
      '--task-name', 'Beta',
      '--summary', 'second',
    ]))

    expect(readFileSync(taskPath('alpha'), 'utf8')).toContain('- 状态: 运行中')
    expect(readFileSync(taskPath('beta'), 'utf8')).toContain('- 状态: 运行中')
    const tracker = readFileSync(join(root, '.gsd', 'TRACKER.md'), 'utf8')
    expect(tracker).toContain('| alpha | Alpha | generic | 运行中 |')
    expect(tracker).toContain('| beta | Beta | generic | 运行中 |')
    expect(tracker).not.toContain('## 当前活跃任务')
    expect(lstatSync(join(root, '.planning')).isSymbolicLink()).toBe(false)
    expect(existsSync(join(root, '.planning', 'workstreams', 'alpha'))).toBe(true)
    expect(existsSync(join(root, '.planning', 'workstreams', 'beta'))).toBe(true)
    expect(readFileSync(join(root, '.fake-workstream'), 'utf8')).toBe('beta')

    const canonical = statSync(join(root, '.gsd', 'PROJECT.md'))
    const route = statSync(join(root, '.planning', 'PROJECT.md'))
    expect(route.dev).toBe(canonical.dev)
    expect(route.ino).toBe(canonical.ino)
  })

  test('switch resumes only the selected paused task', () => {
    for (const slug of ['alpha', 'beta']) {
      expectOk(runHelper([
        'new-gsd-task',
        '--project-root', root,
        '--task-slug', slug,
        '--task-name', slug,
        '--summary', slug,
      ]))
    }
    expectOk(runHelper([
      'set-gsd-task-status',
      '--project-root', root,
      '--task-slug', 'alpha',
      '--status', '已暂停',
    ]))
    expectOk(runHelper([
      'switch-active-task',
      '--project-root', root,
      '--task-slug', 'alpha',
    ]))

    expect(readFileSync(taskPath('alpha'), 'utf8')).toContain('- 状态: 运行中')
    expect(readFileSync(taskPath('beta'), 'utf8')).toContain('- 状态: 运行中')
    expect(readFileSync(join(root, '.fake-workstream'), 'utf8')).toBe('alpha')
  })

  test('render uses explicit slug first and session workstream otherwise', () => {
    expectOk(runHelper([
      'new-gsd-task',
      '--project-root', root,
      '--task-slug', 'alpha',
      '--task-name', 'Alpha',
      '--summary', 'first',
    ]))
    writePassingState('alpha')
    expectOk(runHelper([
      'gsd-local-commit',
      '--project-root', root,
      '--task-slug', 'alpha',
      '--message', 'gsd(alpha): add plans',
    ]))

    for (const extra of [[], ['--task-slug', 'alpha']]) {
      const result = runHelper(['render-codex-plan', '--project-root', root, ...extra])
      expectOk(result)
      const output = JSON.parse(result.stdout)
      expect(output.task_slug).toBe('alpha')
      expect(output.current_phase).toBe('verify')
      expect(output.plan).toEqual([
        { step: '[GSD 01] First', status: 'completed' },
        { step: '[GSD 02/02/A] finish', status: 'in_progress' },
      ])
    }
  })

  test('completion is blocked until finalization passes, then leaves history only', () => {
    expectOk(runHelper([
      'new-gsd-task',
      '--project-root', root,
      '--task-slug', 'alpha',
      '--task-name', 'Alpha',
      '--summary', 'first',
    ]))
    const blocked = runHelper([
      'set-gsd-task-status',
      '--project-root', root,
      '--task-slug', 'alpha',
      '--status', '已完成',
    ])
    expect(blocked.status).not.toBe(0)
    expect(blocked.stderr).toMatch(/STATE\.md|门禁/)

    writePassingState('alpha')
    expectOk(runHelper([
      'set-gsd-task-status',
      '--project-root', root,
      '--task-slug', 'alpha',
      '--status', '已完成',
    ]))
    expect(readFileSync(taskPath('alpha'), 'utf8')).toContain('- 状态: 已完成')
    expect(readFileSync(join(root, '.gsd', 'TRACKER.md'), 'utf8')).not.toContain('| alpha |')
    expect(readFileSync(join(root, '.fake-workstream'), 'utf8')).toBe('')
  })

  test('scoped commit leaves another task working-tree change untouched', () => {
    for (const slug of ['alpha', 'beta']) {
      expectOk(runHelper([
        'new-gsd-task',
        '--project-root', root,
        '--task-slug', slug,
        '--task-name', slug,
        '--summary', slug,
      ]))
    }
    writeFileSync(taskPath('alpha'), readFileSync(taskPath('alpha'), 'utf8').replace('alpha\n\n##', 'local-only\n\n##'))
    expectOk(runHelper([
      'set-gsd-task-status',
      '--project-root', root,
      '--task-slug', 'beta',
      '--status', '已暂停',
    ]))

    expect(git(['status', '--short'])).toContain(' M alpha/TASK.md')
    expect(git(['show', 'HEAD:alpha/TASK.md'])).not.toContain('local-only')
    expect(readFileSync(join(root, '.gsd', 'TRACKER.md'), 'utf8')).not.toContain('local-only')
  })

  test('scoped commit keeps a different task deleted only in the working tree', () => {
    for (const slug of ['alpha', 'beta']) {
      expectOk(runHelper([
        'new-gsd-task',
        '--project-root', root,
        '--task-slug', slug,
        '--task-name', slug,
        '--summary', slug,
      ]))
    }
    rmSync(join(root, '.gsd', 'alpha'), { recursive: true })

    expectOk(runHelper([
      'set-gsd-task-status',
      '--project-root', root,
      '--task-slug', 'beta',
      '--status', '已暂停',
    ]))

    expect(readFileSync(join(root, '.gsd', 'TRACKER.md'), 'utf8')).toContain('| alpha | alpha |')
    expect(git(['status', '--short'])).toContain(' D alpha/TASK.md')
  })

  test('init rejects a pre-staged index before touching managed files', () => {
    expectOk(runHelper(['init-gsd-repo', '--project-root', root]))
    const gitignore = join(root, '.gsd', '.gitignore')
    writeFileSync(gitignore, 'user draft\n')
    stageUnrelatedFile()

    const result = runHelper(['init-gsd-repo', '--project-root', root])

    expectIndexGuard(result)
    expect(readFileSync(gitignore, 'utf8')).toBe('user draft\n')
  })

  test('init refuses to absorb unstaged managed-file drafts', () => {
    expectOk(runHelper(['init-gsd-repo', '--project-root', root]))
    const project = join(root, '.gsd', 'PROJECT.md')
    writeFileSync(project, '# user draft\n')

    const result = runHelper(['init-gsd-repo', '--project-root', root])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('managed files must be clean')
    expect(readFileSync(project, 'utf8')).toBe('# user draft\n')
    expect(git(['show', 'HEAD:PROJECT.md'])).not.toContain('user draft')
  })

  test('CLI lock-already-held flag bypasses nested lock acquisition', () => {
    expectOk(runHelper(['init-gsd-repo', '--project-root', root]))
    const lock = join(root, '.gsd', '.git', 'yiui-gsd-write.lock')
    mkdirSync(lock)
    try {
      expectOk(runHelper([
        'update-gsd-tracker',
        '--project-root', root,
        '--lock-already-held',
      ], 2_000))
    } finally {
      rmSync(lock, { recursive: true, force: true })
    }
  })

  test('reclaims an ownerless stale write lock after a crashed creator', () => {
    expectOk(runHelper(['init-gsd-repo', '--project-root', root]))
    const lock = join(root, '.gsd', '.git', 'yiui-gsd-write.lock')
    mkdirSync(lock)
    const stale = new Date(Date.now() - 60_000)
    utimesSync(lock, stale, stale)

    expectOk(runHelper(['update-gsd-tracker', '--project-root', root], 2_000))
    expect(existsSync(lock)).toBe(false)
  })

  test('task creation rejects a pre-staged index without leaving task files', () => {
    expectOk(runHelper(['init-gsd-repo', '--project-root', root]))
    stageUnrelatedFile()
    const trackerBefore = readFileSync(join(root, '.gsd', 'TRACKER.md'), 'utf8')

    const generic = runHelper([
      'new-gsd-task',
      '--project-root', root,
      '--task-slug', 'blocked-generic',
      '--task-name', 'Blocked generic',
      '--summary', 'must not be created',
    ])
    const autoui = runHelper([
      'bootstrap-autoui-task',
      '--project-root', root,
      '--task-slug', 'blocked-autoui',
      '--task-name', 'Blocked AutoUI',
      '--user-brief', 'must not be created',
    ])

    expectIndexGuard(generic)
    expectIndexGuard(autoui)
    expect(existsSync(join(root, '.gsd', 'blocked-generic'))).toBe(false)
    expect(existsSync(join(root, '.gsd', 'blocked-autoui'))).toBe(false)
    expect(readFileSync(join(root, '.gsd', 'TRACKER.md'), 'utf8')).toBe(trackerBefore)
  })

  test('status update rejects a pre-staged index before changing TASK or STATE', () => {
    expectOk(runHelper([
      'new-gsd-task',
      '--project-root', root,
      '--task-slug', 'alpha',
      '--task-name', 'Alpha',
      '--summary', 'first',
    ]))
    writePassingState('alpha')
    expectOk(runHelper([
      'gsd-local-commit',
      '--project-root', root,
      '--task-slug', 'alpha',
      '--message', 'gsd(alpha): add state',
    ]))
    stageUnrelatedFile()
    const taskBefore = readFileSync(taskPath('alpha'), 'utf8')
    const statePath = join(root, '.gsd', 'alpha', '.planning', 'STATE.md')
    const stateBefore = readFileSync(statePath, 'utf8')

    const result = runHelper([
      'set-gsd-task-status',
      '--project-root', root,
      '--task-slug', 'alpha',
      '--status', '已暂停',
    ])

    expectIndexGuard(result)
    expect(readFileSync(taskPath('alpha'), 'utf8')).toBe(taskBefore)
    expect(readFileSync(statePath, 'utf8')).toBe(stateBefore)
  })

  test('task switch rejects a pre-staged index before resume or session selection', () => {
    expectOk(runHelper([
      'new-gsd-task',
      '--project-root', root,
      '--task-slug', 'alpha',
      '--task-name', 'Alpha',
      '--summary', 'first',
    ]))
    writePassingState('alpha')
    expectOk(runHelper([
      'gsd-local-commit',
      '--project-root', root,
      '--task-slug', 'alpha',
      '--message', 'gsd(alpha): add state',
    ]))
    expectOk(runHelper([
      'set-gsd-task-status',
      '--project-root', root,
      '--task-slug', 'alpha',
      '--status', '已暂停',
    ]))
    expectOk(runHelper([
      'new-gsd-task',
      '--project-root', root,
      '--task-slug', 'beta',
      '--task-name', 'Beta',
      '--summary', 'second',
    ]))
    stageUnrelatedFile()
    const taskBefore = readFileSync(taskPath('alpha'), 'utf8')
    const statePath = join(root, '.gsd', 'alpha', '.planning', 'STATE.md')
    const stateBefore = readFileSync(statePath, 'utf8')
    const trackerBefore = readFileSync(join(root, '.gsd', 'TRACKER.md'), 'utf8')

    const result = runHelper([
      'switch-active-task',
      '--project-root', root,
      '--task-slug', 'alpha',
    ])

    expectIndexGuard(result)
    expect(readFileSync(taskPath('alpha'), 'utf8')).toBe(taskBefore)
    expect(readFileSync(statePath, 'utf8')).toBe(stateBefore)
    expect(readFileSync(join(root, '.gsd', 'TRACKER.md'), 'utf8')).toBe(trackerBefore)
    expect(readFileSync(join(root, '.fake-workstream'), 'utf8')).toBe('beta')
  })

  test('tracker rebuild rejects a pre-staged index before replacing TRACKER', () => {
    expectOk(runHelper(['init-gsd-repo', '--project-root', root]))
    const tracker = join(root, '.gsd', 'TRACKER.md')
    writeFileSync(tracker, 'user tracker draft\n')
    stageUnrelatedFile()

    const result = runHelper(['update-gsd-tracker', '--project-root', root])

    expectIndexGuard(result)
    expect(readFileSync(tracker, 'utf8')).toBe('user tracker draft\n')
  })

  test('migrates a legacy root planning link safely', () => {
    expectOk(runHelper(['init-gsd-repo', '--project-root', root]))
    mkdirSync(join(root, '.gsd', 'legacy', '.planning'), { recursive: true })
    writeFileSync(taskPath('legacy'), [
      '# Legacy',
      '',
      '- task_slug: legacy',
      '- 任务类型: generic',
      '- 状态: 运行中',
      '- 创建时间: old',
      '- 最后更新: old',
      '- 简述: old',
      '',
      '## 备注',
      '',
    ].join('\n'))
    writeFileSync(join(root, '.gsd', 'legacy', '.planning', 'STATE.md'), 'keep\n')
    symlinkSync(
      join(root, '.gsd', 'legacy', '.planning'),
      join(root, '.planning'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    expectOk(runHelper([
      'switch-active-task',
      '--project-root', root,
      '--task-slug', 'legacy',
    ]))
    expect(lstatSync(join(root, '.planning')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(root, '.gsd', 'legacy', '.planning', 'STATE.md'), 'utf8')).toBe('keep\n')
    expect(existsSync(join(root, '.planning', 'workstreams', 'legacy'))).toBe(true)
  })

  test('AutoUI bootstrap is Node-only and keeps headings at top level', () => {
    const result = runHelper([
      'bootstrap-autoui-task',
      '--project-root', root,
      '--task-slug', 'demo-ui',
      '--task-name', 'Demo UI',
      '--user-brief', 'portable',
    ])
    expectOk(result)
    const task = readFileSync(taskPath('demo-ui'), 'utf8')
    expect(task.indexOf('## AutoUI 初始范围')).toBeLessThan(task.indexOf('## 备注'))
    expect(task).toContain('- 状态: 运行中')
    expect(existsSync(join(skillRoot, 'scripts', 'bootstrap_autoui_task.py'))).toBe(false)
  })

  test('PowerShell entries are thin Node wrappers', () => {
    const wrappers = [
      'apply-codex-agent-policy.ps1',
      'assert-finalization-gate.ps1',
      'bootstrap-autoui-task.ps1',
      'gsd-local-commit.ps1',
      'init-gsd-repo.ps1',
      'new-gsd-task.ps1',
      'render-codex-plan.ps1',
      'set-gsd-task-status.ps1',
      'switch-active-task.ps1',
      'update-gsd-tracker.ps1',
    ]
    for (const name of wrappers) {
      const content = readFileSync(join(skillRoot, 'scripts', name), 'utf8')
      expect(content).toContain('yiui-gsd.mjs')
      expect(content.split(/\r?\n/).length).toBeLessThan(50)
    }
  })

  test('helper executes through a linked project skill', () => {
    const linkedSkill = join(root, '.agents/skills/yiui-gsd')
    mkdirSync(dirname(linkedSkill), { recursive: true })
    symlinkSync(skillRoot, linkedSkill, process.platform === 'win32' ? 'junction' : 'dir')
    const result = spawnSync('node', [join(linkedSkill, 'scripts/yiui-gsd.mjs'), 'unknown-command'], {
      encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('unknown yiui-gsd helper command')
  })

  test('shared PROJECT route rejects an independent conflicting file', () => {
    expectOk(runHelper([
      'new-gsd-task',
      '--project-root', root,
      '--task-slug', 'alpha',
      '--task-name', 'Alpha',
      '--summary', 'first',
    ]))
    const route = join(root, '.planning', 'PROJECT.md')
    rmSync(route)
    writeFileSync(route, '# conflict\n')
    const result = runHelper([
      'switch-active-task',
      '--project-root', root,
      '--task-slug', 'alpha',
    ])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('PROJECT.md differs')
  })

  test('Codex agent policy keeps every GSD role on Sol with tiered effort', () => {
    const codexHome = join(root, 'codex-home')
    const defaultsPath = join(root, 'gsd-defaults.json')
    mkdirSync(join(codexHome, 'gsd-core', 'bin', 'shared'), { recursive: true })
    mkdirSync(join(codexHome, 'agents'), { recursive: true })
    writeFileSync(join(codexHome, 'gsd-core', 'bin', 'shared', 'model-catalog.json'), JSON.stringify({
      agents: {
        'gsd-planner': { routingTier: 'heavy' },
        'gsd-doc-classifier': { routingTier: 'light' },
      },
    }))
    writeFileSync(defaultsPath, JSON.stringify({
      preserved: 'keep-me',
      workflow: {
        subagent_timeout: 300_000,
        pattern_mapper: true,
        post_planning_gaps: true,
        plan_bounce: true,
        plan_review_convergence: true,
        cross_ai_execution: true,
        code_review_command: 'external-review',
        inline_plan_threshold: 0,
        unrelated: 'keep-me-too',
      },
      claude_orchestration: {
        enabled: true,
        execution_backend: 'workflow',
        min_agent_sdk_version: '0.3.149',
      },
    }))
    for (const name of ['gsd-planner', 'gsd-doc-classifier']) {
      writeFileSync(join(codexHome, 'agents', `${name}.toml`), [
        'model = "stale-model"',
        'model_reasoning_effort = "low"',
        'service_tier = "flex"',
        'developer_instructions = "test"',
        '',
      ].join('\n'))
    }

    const apply = runHelper([
      'apply-agent-policy',
      '--runtime', 'codex',
      '--codex-home', codexHome,
      '--gsd-defaults-path', defaultsPath,
    ])
    expectOk(apply)
    expect(readFileSync(join(codexHome, 'agents', 'gsd-planner.toml'), 'utf8')).toContain('model_reasoning_effort = "high"')
    expect(readFileSync(join(codexHome, 'agents', 'gsd-doc-classifier.toml'), 'utf8')).toContain('model_reasoning_effort = "medium"')
    for (const name of ['gsd-planner', 'gsd-doc-classifier']) {
      const content = readFileSync(join(codexHome, 'agents', `${name}.toml`), 'utf8')
      expect(content).toContain('model = "gpt-5.6-sol"')
      expect(content).not.toContain('service_tier = "flex"')
    }
    expect(JSON.parse(readFileSync(defaultsPath, 'utf8'))).toMatchObject({
      preserved: 'keep-me',
      runtime: 'codex',
      subagent_timeout: 1_800_000,
      workflow: {
        subagent_timeout: 1_800_000,
        pattern_mapper: false,
        post_planning_gaps: false,
        plan_bounce: false,
        plan_review_convergence: false,
        cross_ai_execution: false,
        code_review_command: null,
        inline_plan_threshold: 2,
        unrelated: 'keep-me-too',
      },
      claude_orchestration: {
        enabled: false,
        execution_backend: 'inline',
        min_agent_sdk_version: '0.3.149',
      },
    })

    const defaultsMtime = statSync(defaultsPath).mtimeMs
    for (const name of ['gsd-planner', 'gsd-doc-classifier']) {
      expect(statSync(join(codexHome, 'agents', `${name}.toml`)).mtimeMs).toBeGreaterThanOrEqual(defaultsMtime)
    }

    expectOk(runHelper([
      'apply-agent-policy',
      '--runtime', 'codex',
      '--codex-home', codexHome,
      '--gsd-defaults-path', defaultsPath,
      '--verify-only',
    ]))

    // GSD 1.8 warns whenever defaults are newer than the oldest static Codex
    // agent TOML. Verify-only must expose that drift without mutating files;
    // apply mode then acknowledges the already-verified bake atomically.
    const old = new Date(Date.now() - 10_000)
    const fresh = new Date()
    for (const name of ['gsd-planner', 'gsd-doc-classifier']) {
      utimesSync(join(codexHome, 'agents', `${name}.toml`), old, old)
    }
    utimesSync(defaultsPath, fresh, fresh)
    const plannerMtimeBeforeVerify = statSync(join(codexHome, 'agents', 'gsd-planner.toml')).mtimeMs
    const staleVerify = runHelper([
      'apply-agent-policy',
      '--runtime', 'codex',
      '--codex-home', codexHome,
      '--gsd-defaults-path', defaultsPath,
      '--verify-only',
    ])
    expect(staleVerify.status).not.toBe(0)
    expect(JSON.parse(staleVerify.stdout).violations).toContain('agent bake timestamp')
    expect(statSync(join(codexHome, 'agents', 'gsd-planner.toml')).mtimeMs).toBe(plannerMtimeBeforeVerify)

    const rebake = runHelper([
      'apply-agent-policy',
      '--runtime', 'codex',
      '--codex-home', codexHome,
      '--gsd-defaults-path', defaultsPath,
    ])
    expectOk(rebake)
    expect(JSON.parse(rebake.stdout).bake_timestamps_synced).toBe(2)
    for (const name of ['gsd-planner', 'gsd-doc-classifier']) {
      expect(statSync(join(codexHome, 'agents', `${name}.toml`)).mtimeMs).toBeGreaterThanOrEqual(statSync(defaultsPath).mtimeMs)
    }
  })

  test('Claude agent policy forces every GSD role to inherit the selected Feishu model', () => {
    const claudeHome = join(root, 'claude-home')
    mkdirSync(join(claudeHome, 'gsd-core', 'bin', 'shared'), { recursive: true })
    mkdirSync(join(claudeHome, 'agents'), { recursive: true })
    writeFileSync(join(claudeHome, 'gsd-core', 'bin', 'shared', 'model-catalog.json'), '{"agents":{}}\n')
    writeFileSync(join(claudeHome, 'agents', 'gsd-planner.md'), [
      '---',
      'name: gsd-planner',
      'effort: high',
      '---',
      '',
      '# Planner',
      '',
    ].join('\n'))
    writeFileSync(join(claudeHome, 'agents', 'gsd-mempalace-curator.md'), [
      '---',
      'name: gsd-mempalace-curator',
      'model: sonnet',
      '---',
      '',
      '# Curator',
      '',
    ].join('\n'))

    const apply = spawnSync('node', [
      helper,
      'apply-agent-policy',
      '--claude-home', claudeHome,
    ], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GSD_RUNTIME: 'claude' },
    })
    expectOk(apply)
    for (const name of ['gsd-planner', 'gsd-mempalace-curator']) {
      const content = readFileSync(join(claudeHome, 'agents', `${name}.md`), 'utf8')
      expect(content.match(/^model:\s*inherit\s*$/gm)).toHaveLength(1)
    }
    expectOk(runHelper([
      'apply-agent-policy',
      '--runtime', 'claude',
      '--claude-home', claudeHome,
      '--verify-only',
    ]))
    expect(existsSync(join(claudeHome, 'gsd-user-files-backup'))).toBe(true)
  })
})
