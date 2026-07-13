import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseClaudeModelProfile } from './config-parse'
import { DEFAULT_CODEX_WATCHDOG, parseWatchdogSettings } from './turn-watchdog'

interface FreshConfigResult {
  exitCode: number
  stdout: string
  stderr: string
}

function loadFreshConfig(extraToml = ''): FreshConfigResult {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-config-fresh-'))
  const configFile = join(root, 'config.toml')
  const minimumConfig = [
    '[feishu]',
    'app_id = "cli_test"',
    'app_secret = "secret"',
  ].join('\n')
  writeFileSync(configFile, `${minimumConfig}${extraToml ? `\n\n${extraToml.trim()}\n` : '\n'}`)

  try {
    const configModule = pathToFileURL(join(import.meta.dir, 'config.ts')).href
    const script = [
      `import { config } from ${JSON.stringify(configModule)}`,
      'process.stdout.write(JSON.stringify(config))',
    ].join('\n')
    const result = Bun.spawnSync({
      cmd: [process.execPath, '--eval', script],
      env: { ...process.env, LODESTAR_CONFIG: configFile },
    })

    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('parseClaudeModelProfile', () => {
  test('env_<NAME> 扁平标量收进 profile.env', () => {
    const profile = parseClaudeModelProfile({
      model: 'glm-5.2[1m]',
      base_url: 'https://open.bigmodel.cn/api/anthropic',
      auth_token: 'tok',
      effort: 'xhigh',
      env_ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2[1m]',
      env_ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5-turbo',
    })
    expect(profile.model).toBe('glm-5.2[1m]')
    expect(profile.base_url).toBe('https://open.bigmodel.cn/api/anthropic')
    expect(profile.env).toEqual({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2[1m]',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5-turbo',
    })
  })

  test('env_ 空值过滤、env_ 后无名为空不收、非 env_ 字段不受影响', () => {
    const profile = parseClaudeModelProfile({
      model: 'glm-5.2',
      env_ANTHROPIC_DEFAULT_HAIKU_MODEL: '', // 空值不收
      env_: 'nope', // env_ 后为空不收
      description: 'x',
    })
    expect(profile.env).toBeUndefined()
    expect(profile.description).toBe('x')
    expect(profile.model).toBe('glm-5.2')
  })
})

describe('Codex watchdog configuration', () => {
  test('derives parser fallbacks from DEFAULT_CODEX_WATCHDOG', () => {
    const savedDefaults = { ...DEFAULT_CODEX_WATCHDOG }
    try {
      Object.assign(DEFAULT_CODEX_WATCHDOG, {
        mode: 'warn',
        stallMs: 60_000,
        repeatNoopLimit: 3,
        silentWarnMs: 120_000,
        interruptGraceMs: 1_000,
      })

      expect(parseWatchdogSettings()).toEqual(DEFAULT_CODEX_WATCHDOG)
    } finally {
      Object.assign(DEFAULT_CODEX_WATCHDOG, savedDefaults)
    }
  })

  test('uses the fail-closed default policy', () => {
    const result = loadFreshConfig()

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout).watchdog).toEqual({
      codexMode: 'recover_once',
      stallMs: 900_000,
      repeatNoopLimit: 10,
      silentWarnMs: 1_800_000,
      interruptGraceMs: 10_000,
    })
  })

  test('treats explicitly empty watchdog settings as defaults', () => {
    const result = loadFreshConfig(`
      [watchdog]
      codex_mode = ''
      stall_seconds = ''
      repeat_noop_limit = ''
      silent_warn_seconds = ''
      interrupt_grace_seconds = ''
    `)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout).watchdog).toEqual({
      codexMode: 'recover_once',
      stallMs: 900_000,
      repeatNoopLimit: 10,
      silentWarnMs: 1_800_000,
      interruptGraceMs: 10_000,
    })
  })

  test('parses quoted global settings and a project mode override', () => {
    const result = loadFreshConfig(`
      [watchdog]
      codex_mode = 'warn'
      stall_seconds = '1200'
      repeat_noop_limit = '12'
      silent_warn_seconds = '2400'
      interrupt_grace_seconds = '15'

      [projects.pokemon]
      watchdog_mode = 'off'
    `)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    const loaded = JSON.parse(result.stdout)
    expect(loaded.watchdog).toEqual({
      codexMode: 'warn',
      stallMs: 1_200_000,
      repeatNoopLimit: 12,
      silentWarnMs: 2_400_000,
      interruptGraceMs: 15_000,
    })
    expect(loaded.projects.pokemon.watchdogMode).toBe('off')
  })

  test.each([
    ['invalid mode', "codex_mode = 'aggressive'", 'watchdog.codex_mode'],
    ['stall below minimum', "stall_seconds = '59'", 'watchdog.stall_seconds'],
    ['stall above maximum', "stall_seconds = '86401'", 'watchdog.stall_seconds'],
    ['fractional stall', "stall_seconds = '90.5'", 'watchdog.stall_seconds'],
    ['repeat limit below minimum', "repeat_noop_limit = '2'", 'watchdog.repeat_noop_limit'],
    ['repeat limit above maximum', "repeat_noop_limit = '101'", 'watchdog.repeat_noop_limit'],
    [
      'silent warning before stall',
      "stall_seconds = '900'\nsilent_warn_seconds = '899'",
      'watchdog.silent_warn_seconds',
    ],
    ['silent warning above maximum', "silent_warn_seconds = '172801'", 'watchdog.silent_warn_seconds'],
    ['interrupt grace below minimum', "interrupt_grace_seconds = '0'", 'watchdog.interrupt_grace_seconds'],
    ['interrupt grace above maximum', "interrupt_grace_seconds = '61'", 'watchdog.interrupt_grace_seconds'],
  ])('rejects %s', (_label, setting, field) => {
    const result = loadFreshConfig(`[watchdog]\n${setting}`)

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain(field)
  })

  test('rejects an invalid project override without falling back to the global mode', () => {
    const result = loadFreshConfig(`
      [watchdog]
      codex_mode = 'warn'

      [projects.pokemon]
      watchdog_mode = 'aggressive'
    `)

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('projects.pokemon.watchdog_mode')
  })
})

describe('configured project paths', () => {
  test('resolves relative projects_root and project cwd values to absolute paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-config-paths-'))
    const baseDir = join(root, 'daemon-cwd')
    const configDir = join(root, 'config')
    mkdirSync(baseDir)
    mkdirSync(configDir)
    const configFile = join(configDir, 'config.toml')
    writeFileSync(configFile, [
      '[feishu]',
      'app_id = "cli_test"',
      'app_secret = "secret"',
      '',
      '[runtime]',
      'projects_root = "feishu_robot"',
      '',
      '[projects.meme]',
      'cwd = "external/meme"',
      '',
      '[projects.home]',
      'cwd = "~/external/home-project"',
      '',
      '[projects.blank]',
      'cwd = "   "',
      '',
    ].join('\n'))

    try {
      const resolvedBaseDir = realpathSync(baseDir)
      const configModule = pathToFileURL(join(import.meta.dir, 'config.ts')).href
      const script = [
        `import { config } from ${JSON.stringify(configModule)}`,
        'process.stdout.write(JSON.stringify({',
        '  projectsRoot: config.runtime.projects_root,',
        '  projectCwd: config.projects.meme?.cwd,',
        '  homeProjectCwd: config.projects.home?.cwd,',
        '  blankProjectCwd: config.projects.blank?.cwd ?? null,',
        '}))',
      ].join('\n')
      const result = Bun.spawnSync({
        cmd: [process.execPath, '--eval', script],
        cwd: baseDir,
        env: { ...process.env, LODESTAR_CONFIG: configFile },
      })

      expect(result.exitCode).toBe(0)
      expect(result.stderr.toString()).toBe('')
      expect(JSON.parse(result.stdout.toString())).toEqual({
        projectsRoot: resolve(resolvedBaseDir, 'feishu_robot'),
        projectCwd: resolve(resolvedBaseDir, 'external/meme'),
        homeProjectCwd: resolve(homedir(), 'external/home-project'),
        blankProjectCwd: null,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
