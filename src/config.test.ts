import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseClaudeModelProfile } from './config-parse'

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
