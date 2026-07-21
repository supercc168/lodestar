import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildImagegenSkillBodyForTest,
  buildImagegenWrapperBodyForTest,
  resolveImagegenAssetRoot,
} from './imagegen-skill'

describe('imagegen skill body', () => {
  test('CLI-first skill points at the wrapper and feishu send marker', () => {
    const body = buildImagegenSkillBodyForTest({
      wrapperPath: '/tmp/lodestar-imagegen',
      defaultModel: 'gpt-image-2',
      configured: true,
    })
    expect(body).toContain('name: imagegen')
    expect(body).toContain('/tmp/lodestar-imagegen generate')
    expect(body).toContain('[[send:')
    expect(body).toContain('gpt-image-2')
    expect(body).toContain('Configured channel is ready')
    // Must NOT prefer Codex built-in image_gen as default path for Lodestar.
    expect(body).not.toMatch(/built-in `image_gen` tool for normal/i)
  })

  test('unconfigured skill tells the agent to ask for [imagegen] config', () => {
    const body = buildImagegenSkillBodyForTest({
      wrapperPath: '/tmp/lodestar-imagegen',
      defaultModel: 'gpt-image-2',
      configured: false,
    })
    expect(body).toContain('NOT configured yet')
    expect(body).toContain('[imagegen]')
  })
})

describe('imagegen wrapper body', () => {
  test('exports key and optional base_url, default-injects --model', () => {
    const body = buildImagegenWrapperBodyForTest({
      scriptPath: '/skills/imagegen/scripts/image_gen.py',
      apiKey: 'sk-test-key',
      baseUrl: 'https://api.wuhen-ai.com',
      defaultModel: 'gpt-image-2',
    })
    expect(body.startsWith('#!/usr/bin/env bash')).toBe(true)
    expect(body).toContain("export OPENAI_API_KEY='sk-test-key'")
    expect(body).toContain("export OPENAI_BASE_URL='https://api.wuhen-ai.com'")
    expect(body).toContain('--model')
    expect(body).toContain('gpt-image-2')
    expect(body).toContain('VENV_PY=')
    expect(body).toContain('/tmp/imagegen-venv/bin/python')
  })

  test('shell-quotes single quotes inside the api key', () => {
    const body = buildImagegenWrapperBodyForTest({
      scriptPath: '/s.py',
      apiKey: "sk-foo'bar",
      defaultModel: 'gpt-image-2',
    })
    // POSIX: 'foo'"'"'bar'
    expect(body).toContain(`export OPENAI_API_KEY='sk-foo'\"'\"'bar'`)
    expect(body).toContain('unset OPENAI_BASE_URL')
  })

  test('wrapper is executable when written with mode 0700', () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-imagegen-wrap-'))
    try {
      const path = join(root, 'lodestar-imagegen')
      const body = buildImagegenWrapperBodyForTest({
        scriptPath: join(root, 'image_gen.py'),
        apiKey: 'sk-x',
        defaultModel: 'gpt-image-1.5',
      })
      writeFileSync(path, body, { mode: 0o700 })
      chmodSync(path, 0o700)
      expect(existsSync(path)).toBe(true)
      const text = readFileSync(path, 'utf8')
      expect(text).toContain('gpt-image-1.5')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('resolveImagegenAssetRoot', () => {
  test('finds vendored skills/imagegen next to the repo src/', () => {
    const root = resolveImagegenAssetRoot()
    expect(root).toBeTruthy()
    expect(existsSync(join(root!, 'scripts', 'image_gen.py'))).toBe(true)
    expect(existsSync(join(root!, 'scripts', 'remove_chroma_key.py'))).toBe(true)
  })
})

describe('imagegen config parse', () => {
  test('parses [imagegen] and defaults enabled from api_key presence', () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-imagegen-cfg-'))
    const configFile = join(root, 'config.toml')
    writeFileSync(
      configFile,
      [
        '[feishu]',
        'app_id = "cli_test"',
        'app_secret = "secret"',
        '',
        '[imagegen]',
        'api_key = "sk-from-test"',
        'base_url = "https://api.wuhen-ai.com"',
        'model = "gpt-image-1.5"',
      ].join('\n'),
    )

    try {
      const mod = pathToFileURL(join(import.meta.dir, 'config.ts')).href
      const script = [
        `import { config } from ${JSON.stringify(mod)}`,
        'process.stdout.write(JSON.stringify(config.imagegen))',
      ].join('\n')
      const result = Bun.spawnSync({
        cmd: [process.execPath, '--eval', script],
        env: { ...process.env, LODESTAR_CONFIG: configFile },
      })
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout.toString())).toEqual({
        enabled: true,
        baseUrl: 'https://api.wuhen-ai.com',
        apiKey: 'sk-from-test',
        model: 'gpt-image-1.5',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('enabled=false wins even when api_key is set', () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-imagegen-cfg-off-'))
    const configFile = join(root, 'config.toml')
    writeFileSync(
      configFile,
      [
        '[feishu]',
        'app_id = "cli_test"',
        'app_secret = "secret"',
        '',
        '[imagegen]',
        'enabled = "false"',
        'api_key = "sk-from-test"',
      ].join('\n'),
    )
    try {
      const mod = pathToFileURL(join(import.meta.dir, 'config.ts')).href
      const script = [
        `import { config } from ${JSON.stringify(mod)}`,
        'process.stdout.write(JSON.stringify(config.imagegen))',
      ].join('\n')
      const result = Bun.spawnSync({
        cmd: [process.execPath, '--eval', script],
        env: { ...process.env, LODESTAR_CONFIG: configFile },
      })
      expect(result.exitCode).toBe(0)
      const parsed = JSON.parse(result.stdout.toString())
      expect(parsed.enabled).toBe(false)
      expect(parsed.apiKey).toBe('sk-from-test')
      expect(parsed.model).toBe('gpt-image-2')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('absent [imagegen] stays disabled with default model', () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-imagegen-cfg-none-'))
    const configFile = join(root, 'config.toml')
    mkdirSync(root, { recursive: true })
    writeFileSync(
      configFile,
      ['[feishu]', 'app_id = "cli_test"', 'app_secret = "secret"', ''].join('\n'),
    )
    try {
      const mod = pathToFileURL(join(import.meta.dir, 'config.ts')).href
      const script = [
        `import { config } from ${JSON.stringify(mod)}`,
        'process.stdout.write(JSON.stringify(config.imagegen))',
      ].join('\n')
      const result = Bun.spawnSync({
        cmd: [process.execPath, '--eval', script],
        env: { ...process.env, LODESTAR_CONFIG: configFile },
      })
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout.toString())).toEqual({
        enabled: false,
        model: 'gpt-image-2',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
