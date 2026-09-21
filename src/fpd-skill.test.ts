import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureFpdSkill,
  fpdBinPath,
  fpdHelperBinPath,
  fpdShimBody,
  resolveFpdAssetRoot,
} from './fpd-skill'

/** 把仓库内容源拷进临时目录,测试可以随意改源而不碰真实 skill 文件。 */
function tempAssetRoot(): string {
  const src = resolveFpdAssetRoot()
  if (!src) throw new Error('repo fpd asset root missing (test precondition)')
  const dir = mkdtempSync(join(tmpdir(), 'fpd-asset-'))
  const dest = join(dir, 'fable-plan-dsh-exec')
  mkdirSync(join(dest, 'scripts'), { recursive: true })
  writeFileSync(join(dest, 'SKILL.md'), readFileSync(join(src, 'SKILL.md')))
  writeFileSync(join(dest, 'scripts', 'fpd.mjs'), readFileSync(join(src, 'scripts', 'fpd.mjs')))
  return dest
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'fpd-home-'))
}

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'fpd-data-'))
}

function cleanup(...dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
}

describe('resolveFpdAssetRoot', () => {
  test('finds vendored .agents/skills/fable-plan-dsh-exec next to the repo src/', () => {
    const root = resolveFpdAssetRoot()
    expect(root).toBeTruthy()
    expect(existsSync(join(root!, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(root!, 'scripts', 'fpd.mjs'))).toBe(true)
  })
})

describe('fpdShimBody', () => {
  test('shim carries only the runtime and helper path, no credentials', () => {
    const body = fpdShimBody('/usr/local/bin/node', '/data/bin/fpd.mjs')
    expect(body).toBe("#!/bin/sh\nexec '/usr/local/bin/node' '/data/bin/fpd.mjs' \"$@\"\n")
    expect(body).not.toMatch(/key|token|capability/i)
  })
})

describe('ensureFpdSkill', () => {
  test('syncs SKILL.md into both backends and installs the fpd command', () => {
    const asset = tempAssetRoot()
    const home = tempHome()
    const data = tempDataDir()
    try {
      ensureFpdSkill({ assetRoot: asset, homeDir: home, dataDir: data, runtime: '/usr/bin/node', env: {} })

      for (const backend of ['.codex', '.claude']) {
        const skillMd = join(home, backend, 'skills', 'fable-plan-dsh-exec', 'SKILL.md')
        expect(existsSync(skillMd)).toBe(true)
        expect(readFileSync(skillMd, 'utf8')).toBe(readFileSync(join(asset, 'SKILL.md'), 'utf8'))
        // helper 不进 skill 目录:单一副本在 DATA_DIR/bin。
        expect(existsSync(join(home, backend, 'skills', 'fable-plan-dsh-exec', 'scripts'))).toBe(false)
      }

      const helper = fpdHelperBinPath(data)
      expect(readFileSync(helper, 'utf8')).toBe(readFileSync(join(asset, 'scripts', 'fpd.mjs'), 'utf8'))
      const shim = fpdBinPath(data)
      expect(readFileSync(shim, 'utf8')).toBe(fpdShimBody('/usr/bin/node', helper))
      expect(statSync(shim).mode & 0o777).toBe(0o700)
      expect(statSync(helper).mode & 0o777).toBe(0o755)
    } finally {
      cleanup(asset, home, data)
    }
  })

  test('idempotent until the source changes, then updates in place', () => {
    const asset = tempAssetRoot()
    const home = tempHome()
    const data = tempDataDir()
    try {
      const env: NodeJS.ProcessEnv = {}
      ensureFpdSkill({ assetRoot: asset, homeDir: home, dataDir: data, runtime: 'node', env })
      const skillMd = join(home, '.claude', 'skills', 'fable-plan-dsh-exec', 'SKILL.md')
      const firstMtime = statSync(skillMd).mtimeMs
      // 第二次同源:内容不变,且不重写(mtime 不动)。
      ensureFpdSkill({ assetRoot: asset, homeDir: home, dataDir: data, runtime: 'node', env })
      expect(readFileSync(skillMd, 'utf8')).toBe(readFileSync(join(asset, 'SKILL.md'), 'utf8'))
      expect(statSync(skillMd).mtimeMs).toBe(firstMtime)
      // 源变化:重跑把新内容同步进两个后端。
      const edited = `${readFileSync(join(asset, 'SKILL.md'), 'utf8')}\n<!-- edited -->\n`
      writeFileSync(join(asset, 'SKILL.md'), edited)
      ensureFpdSkill({ assetRoot: asset, homeDir: home, dataDir: data, runtime: 'node', env })
      expect(readFileSync(skillMd, 'utf8')).toBe(edited)
      expect(readFileSync(join(home, '.codex', 'skills', 'fable-plan-dsh-exec', 'SKILL.md'), 'utf8')).toBe(edited)
    } finally {
      cleanup(asset, home, data)
    }
  })

  test('LODESTAR_DISABLE_SKILL_SYNC=1 installs nothing', () => {
    const asset = tempAssetRoot()
    const home = tempHome()
    const data = tempDataDir()
    try {
      ensureFpdSkill({
        assetRoot: asset,
        homeDir: home,
        dataDir: data,
        runtime: 'node',
        env: { LODESTAR_DISABLE_SKILL_SYNC: '1' },
      })
      expect(existsSync(join(home, '.claude', 'skills', 'fable-plan-dsh-exec'))).toBe(false)
      expect(existsSync(join(home, '.codex', 'skills', 'fable-plan-dsh-exec'))).toBe(false)
      expect(existsSync(join(data, 'bin', 'fpd'))).toBe(false)
      expect(existsSync(join(data, 'bin', 'fpd.mjs'))).toBe(false)
    } finally {
      cleanup(asset, home, data)
    }
  })

  test('missing asset root skips silently (registry installs)', () => {
    const home = tempHome()
    const data = tempDataDir()
    try {
      ensureFpdSkill({
        assetRoot: join(tmpdir(), 'fpd-does-not-exist'),
        homeDir: home,
        dataDir: data,
        runtime: 'node',
        env: {},
      })
      expect(existsSync(join(home, '.claude', 'skills', 'fable-plan-dsh-exec'))).toBe(false)
      expect(existsSync(join(data, 'bin'))).toBe(false)
    } finally {
      cleanup(home, data)
    }
  })

  test('fpd.mjs passes node --check (synced helper stays runnable)', () => {
    const root = resolveFpdAssetRoot()
    expect(root).toBeTruthy()
    const result = spawnSync('node', ['--check', join(root!, 'scripts', 'fpd.mjs')], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
  })
})
