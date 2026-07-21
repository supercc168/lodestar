import { expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const helper = join(repoRoot, '.agents/skills/yiui-gsd/scripts/yiui-gsd.mjs')

function tempProject() {
  const root = mkdtempSync(join(tmpdir(), 'yiui-gsd-test-'))
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function runHelper(args: string[], cwd?: string) {
  return spawnSync('node', [helper, ...args], {
    cwd: cwd || repoRoot,
    encoding: 'utf8',
    env: { ...process.env },
  })
}

function initGsdGit(root: string) {
  mkdirSync(join(root, '.gsd'), { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: join(root, '.gsd') })
  execFileSync('git', ['config', 'user.email', 'yiui-gsd-test@example.invalid'], { cwd: join(root, '.gsd') })
  execFileSync('git', ['config', 'user.name', 'yiui-gsd-test'], { cwd: join(root, '.gsd') })
}

test('init and switch helpers preserve existing tracker and create a relative Unix bridge', () => {
  const fixture = tempProject()
  try {
    initGsdGit(fixture.root)
    const tracker = join(fixture.root, '.gsd', 'TRACKER.md')
    writeFileSync(tracker, '# preserved tracker\n')
    mkdirSync(join(fixture.root, '.gsd', 'demo'), { recursive: true })

    expect(runHelper(['init-gsd-repo', '--project-root', fixture.root]).status).toBe(0)
    expect(readFileSync(tracker, 'utf8')).toBe('# preserved tracker\n')
    expect(runHelper(['switch-active-task', '--project-root', fixture.root, '--task-slug', 'demo']).status).toBe(0)
    expect(lstatSync(join(fixture.root, '.planning')).isSymbolicLink()).toBe(true)
    if (process.platform !== 'win32') {
      expect(readlinkSync(join(fixture.root, '.planning'))).toBe('.gsd/demo/.planning')
    }
  } finally {
    fixture.cleanup()
  }
})

test('switch rejects a real planning directory instead of deleting it', () => {
  const fixture = tempProject()
  try {
    mkdirSync(join(fixture.root, '.gsd', 'demo'), { recursive: true })
    mkdirSync(join(fixture.root, '.planning'), { recursive: true })
    writeFileSync(join(fixture.root, '.planning', 'keep.txt'), 'keep')
    const result = runHelper(['switch-active-task', '--project-root', fixture.root, '--task-slug', 'demo'])
    expect(result.status).not.toBe(0)
    expect(existsSync(join(fixture.root, '.planning', 'keep.txt'))).toBe(true)
  } finally {
    fixture.cleanup()
  }
})

test('helper executes when invoked through a linked project skill', () => {
  const fixture = tempProject()
  try {
    const linkedSkill = join(fixture.root, '.agents/skills/yiui-gsd')
    mkdirSync(dirname(linkedSkill), { recursive: true })
    symlinkSync(join(repoRoot, '.agents/skills/yiui-gsd'), linkedSkill, process.platform === 'win32' ? 'junction' : 'dir')
    const result = spawnSync('node', [join(linkedSkill, 'scripts/yiui-gsd.mjs'), 'unknown-command'], {
      encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('unknown yiui-gsd helper command')
  } finally {
    fixture.cleanup()
  }
})

test('policy helper detects drift in VerifyOnly mode and repairs it from the catalog', () => {
  const fixture = tempProject()
  try {
    const codexHome = join(fixture.root, '.codex')
    const defaultsPath = join(fixture.root, '.gsd', 'defaults.json')
    const agents = join(codexHome, 'agents')
    const catalog = join(codexHome, 'gsd-core/bin/shared/model-catalog.json')
    mkdirSync(agents, { recursive: true })
    mkdirSync(dirname(catalog), { recursive: true })
    mkdirSync(dirname(defaultsPath), { recursive: true })
    writeFileSync(catalog, JSON.stringify({
      agents: {
        'gsd-planner': { routingTier: 'heavy' },
        'gsd-pattern-mapper': { routingTier: 'light' },
      },
    }))
    writeFileSync(join(agents, 'gsd-planner.toml'), 'model = "old"\nmodel_reasoning_effort = "low"\nservice_tier = "flex"\ndeveloper_instructions = "x"\n')
    writeFileSync(join(agents, 'gsd-pattern-mapper.toml'), 'model = "old"\nmodel_reasoning_effort = "high"\ndeveloper_instructions = "x"\n')
    writeFileSync(defaultsPath, '{"legacy":true}\n')

    const verifyBefore = runHelper([
      'apply-agent-policy', '--verify-only', '--codex-home', codexHome, '--gsd-defaults-path', defaultsPath,
    ])
    expect(verifyBefore.status).toBe(1)
    expect(readFileSync(defaultsPath, 'utf8')).toBe('{"legacy":true}\n')

    const applied = runHelper([
      'apply-agent-policy', '--codex-home', codexHome, '--gsd-defaults-path', defaultsPath,
    ])
    expect(applied.status).toBe(0)
    const verifyAfter = runHelper([
      'apply-agent-policy', '--verify-only', '--codex-home', codexHome, '--gsd-defaults-path', defaultsPath,
    ])
    expect(verifyAfter.status).toBe(0)
    expect(readFileSync(join(agents, 'gsd-planner.toml'), 'utf8')).toContain('model_reasoning_effort = "high"')
    expect(readFileSync(join(agents, 'gsd-pattern-mapper.toml'), 'utf8')).toContain('model_reasoning_effort = "medium"')
    expect(readFileSync(join(agents, 'gsd-planner.toml'), 'utf8')).not.toContain('service_tier')
  } finally {
    fixture.cleanup()
  }
})

test('render helper preserves plan status and the first unfinished cursor', () => {
  const fixture = tempProject()
  try {
    const planning = join(fixture.root, '.gsd/demo/.planning')
    mkdirSync(planning, { recursive: true })
    writeFileSync(join(fixture.root, '.gsd/TRACKER.md'), [
      '# GSD 任务跟踪', '', '## 当前活跃任务', '', '- 状态：运行中', '- task_slug：demo', '- 任务名称：Demo',
      '- 当前阶段：plan', '- 最后更新：', '- planning_path：.gsd/demo/.planning/', '- 备注：', '', '## 任务索引', '',
      '| task_slug | 名称 | 状态 | 创建时间 | 最后更新 |', '|-----------|------|------|----------|----------|',
    ].join('\n'))
    writeFileSync(join(planning, 'STATE.md'), [
      '---', 'progress:', '  total_plans: 2', '  completed_plans: 1', '---',
      '- current_plan: 02-PLAN.md', '- current_phase: plan', '- next_action: check plan', '',
      '## 单向执行游标', '', '| 游标 | 项目 | 状态 |', '|---|---|---|', '| 02/A | Plan 02：Second | RED |',
    ].join('\n'))
    writeFileSync(join(planning, '01-PLAN.md'), '# Plan 01: First\n')
    writeFileSync(join(planning, '02-PLAN.md'), '# Plan 02: Second\n')

    const result = runHelper(['render-codex-plan', '--project-root', fixture.root])
    expect(result.status).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output.plan).toEqual([
      { step: '[GSD 01] First', status: 'completed' },
      { step: '[GSD 02/02/A] Second', status: 'in_progress' },
    ])
    expect(output.current_cursor.cursor).toBe('02/A')
    expect(output.diagnostics).toEqual([])
  } finally {
    fixture.cleanup()
  }
})

test('AutoUI bootstrap works through Node without Python or PowerShell', () => {
  const fixture = tempProject()
  try {
    initGsdGit(fixture.root)
    writeFileSync(join(fixture.root, '.gsd/.gitignore'), '**/.planning/config.json\n')
    writeFileSync(join(fixture.root, '.gsd/TRACKER.md'), [
      '# GSD 任务跟踪', '', '## 当前活跃任务', '', '- 状态：无任务', '- task_slug：', '- 任务名称：',
      '- 当前阶段：unknown', '- 最后更新：', '- planning_path：', '- 备注：', '', '## 任务索引', '',
      '| task_slug | 名称 | 状态 | 创建时间 | 最后更新 |', '|-----------|------|------|----------|----------|',
    ].join('\n'))
    execFileSync('git', ['add', '.'], { cwd: join(fixture.root, '.gsd') })
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: join(fixture.root, '.gsd') })

    const result = runHelper([
      'bootstrap-autoui-task', '--project-root', fixture.root, '--task-slug', 'demo-ui',
      '--task-name', 'Demo UI', '--user-brief', 'portable',
    ])
    expect(result.status).toBe(0)
    expect(existsSync(join(fixture.root, '.gsd/demo-ui/TASK.md'))).toBe(true)
    expect(lstatSync(join(fixture.root, '.planning')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(fixture.root, '.gsd/TRACKER.md'), 'utf8')).toContain('demo-ui')
  } finally {
    fixture.cleanup()
  }
})

test('AutoUI bootstrap replaces a CRLF active section and pauses the previous task', () => {
  const fixture = tempProject()
  try {
    initGsdGit(fixture.root)
    mkdirSync(join(fixture.root, '.gsd/old'), { recursive: true })
    writeFileSync(join(fixture.root, '.gsd/.gitignore'), '**/.planning/config.json\r\n')
    writeFileSync(join(fixture.root, '.gsd/old/TASK.md'), [
      '# Old', '', '- 状态: 运行中', '- 最后更新: old', '',
    ].join('\r\n'))
    writeFileSync(join(fixture.root, '.gsd/TRACKER.md'), [
      '# GSD 任务跟踪', '', '## 当前活跃任务', '', '- 状态：运行中', '- task_slug：old', '- 任务名称：Old',
      '- 任务类型：generic', '- 当前阶段：execute', '- 最后更新：old', '- planning_path：.gsd/old/.planning/',
      '- 备注：old', '', '## 任务索引', '', '| task_slug | 名称 | 状态 | 创建时间 | 最后更新 |',
      '|-----------|------|------|----------|----------|', '| old | Old | 运行中 | old | old |', '',
    ].join('\r\n'))
    execFileSync('git', ['add', '.'], { cwd: join(fixture.root, '.gsd') })
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: join(fixture.root, '.gsd') })

    const result = runHelper([
      'bootstrap-autoui-task', '--project-root', fixture.root, '--task-slug', 'demo-ui',
      '--task-name', 'Demo UI', '--user-brief', 'portable',
    ])
    expect(result.status).toBe(0)
    const tracker = readFileSync(join(fixture.root, '.gsd/TRACKER.md'), 'utf8')
    expect(tracker.match(/^## 当前活跃任务$/gm)).toHaveLength(1)
    expect(tracker).toContain('| old | Old | 已暂停 |')
    expect(readFileSync(join(fixture.root, '.gsd/old/TASK.md'), 'utf8')).toContain('- 状态: 已暂停')
  } finally {
    fixture.cleanup()
  }
})
