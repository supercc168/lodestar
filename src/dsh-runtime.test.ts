import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as dshRuntimeModule from './dsh-runtime'
// dsh-process-unit 对 ./dsh-runtime 做了进程级 mock.module(替身类只在它构造时才开闸)，
// 这里取它暴露的真实类，保持与生产代码同一原型、import.meta.url 不变。
const { dshGatesOnConnectionChain, dshProviderPatches, profileProvidesAskUser } = dshRuntimeModule
const DshRuntime = ((dshRuntimeModule as any).__realDshRuntimeForTests ?? dshRuntimeModule.DshRuntime) as typeof dshRuntimeModule.DshRuntime
import * as logModule from './log'

const roots: string[] = []
function runtimeRoot(patch?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-dsh-profile-'))
  roots.push(root)
  writeFileSync(join(root, 'package.json'), '{"name":"runtime","private":true}')
  if (patch !== undefined) {
    const profile = join(root, 'node_modules', '@deepseek-ai', 'dsh-sdk-app')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), '{"name":"@deepseek-ai/dsh-sdk-app","version":"test"}')
    writeFileSync(join(profile, 'cordis.patch.yml'), patch)
  }
  return root
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('DSH ask-user profile detection', () => {
  test('recognises a profile that already registers the ask-user tool', () => {
    const patch = [
      '    - id: tool-present',
      "      name: '@deepseek-ai/dsh-tool-present'",
      '    - id: tool-ask-user',
      '      name: "@deepseek-ai/dsh-tool-ask-user"',
      '',
    ].join('\n')
    expect(profileProvidesAskUser(runtimeRoot(patch))).toBe(true)
  })

  test('older profiles still need the explicit insert', () => {
    expect(profileProvidesAskUser(runtimeRoot("- id: tool-present\n  name: '@deepseek-ai/dsh-tool-present'\n"))).toBe(false)
    expect(profileProvidesAskUser(runtimeRoot(''))).toBe(false)
    // A commented-out or differently spelled entry is not a provided plugin.
    expect(profileProvidesAskUser(runtimeRoot("# name: '@deepseek-ai/dsh-tool-ask-user'\n"))).toBe(false)
    expect(profileProvidesAskUser(runtimeRoot("  name: '@deepseek-ai/dsh-tool-ask-user-v2'\n"))).toBe(false)
  })

  test('missing profile packages keep the explicit insert instead of failing', () => {
    expect(profileProvidesAskUser(runtimeRoot())).toBe(false)
    expect(profileProvidesAskUser(join(tmpdir(), 'lodestar-missing-runtime-root'))).toBe(false)
  })
})

describe('DSH provider patches across runtime generations', () => {
  const chainIds = ['authorization', 'deepseek-account', 'connection', 'file-upload', 'schedule']
  const glm = { LODESTAR_DSH_PROVIDER: 'zai-coding-cn' }

  function withConnectionChain(root: string): string {
    const pkg = join(root, 'node_modules', '@deepseek-ai', 'dsh-connection')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), '{"name":"@deepseek-ai/dsh-connection","version":"0.2.2-rc.1"}')
    return root
  }

  test('0.2.0/0.2.1 runtimes keep their default chain', () => {
    const root = runtimeRoot()
    expect(dshGatesOnConnectionChain(root)).toBe(false)
    const ids = dshProviderPatches(glm).map((entry: any) => entry.id)
    for (const id of chainIds) expect(ids).not.toContain(id)
    expect(ids).toContain('llm-deepseek')
    expect(ids).toContain('llm-pi-ai')
  })

  test('0.2.2-rc.1 runtimes disable the chain under pi-ai providers', () => {
    const root = withConnectionChain(runtimeRoot())
    expect(dshGatesOnConnectionChain(root)).toBe(true)
    const patches = dshProviderPatches(glm, { disableDeepseekChain: dshGatesOnConnectionChain(root) }) as any[]
    for (const id of chainIds) {
      expect(patches).toContainEqual({ id, disabled: true })
    }
    // pi-ai 路由本身仍然启用，官方 DeepSeek 路由仍然关闭。
    expect(patches).toContainEqual({ id: 'llm-deepseek', disabled: true })
    expect(patches.find(entry => entry.id === 'llm-pi-ai').disabled).toBe(false)
  })

  test('the official DeepSeek provider never receives the pi-ai patches', () => {
    const root = withConnectionChain(runtimeRoot())
    expect(dshProviderPatches({ LODESTAR_DSH_PROVIDER: 'deepseek-official' }, {
      disableDeepseekChain: dshGatesOnConnectionChain(root),
    })).toEqual([])
  })
})

describe('DSH launch directory', () => {
  test('a launch that fails after the directory was created removes it and keeps the original error', () => {
    const root = runtimeRoot()
    const dsh = join(root, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(dsh, { recursive: true })
    writeFileSync(join(dsh, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"test","bin":{"dsh":"bin.js"}}')
    // The bridge directory cannot be created below a regular file.
    writeFileSync(join(root, '.lodestar-bridges'), '')
    const temp = join(root, 'tmp')
    mkdirSync(temp)
    const saved = { runtime: process.env.LODESTAR_TEST_AGENT_RUNTIME_ROOT, tmp: process.env.TMPDIR }
    process.env.LODESTAR_TEST_AGENT_RUNTIME_ROOT = root
    process.env.TMPDIR = temp
    try {
      expect(() => new DshRuntime({ cwd: root, env: {}, home: join(root, 'home') })).toThrow(/ENOTDIR|EEXIST/)
      expect(readdirSync(temp)).toEqual([])
    } finally {
      for (const [key, value] of [['LODESTAR_TEST_AGENT_RUNTIME_ROOT', saved.runtime], ['TMPDIR', saved.tmp]] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  test.skipIf(process.platform === 'win32')('a launch directory that cannot be removed on child close is logged, not thrown from the listener', async () => {
    const root = runtimeRoot()
    const dsh = join(root, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(dsh, { recursive: true })
    writeFileSync(join(dsh, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"test","bin":{"dsh":"bin.js"}}')
    const temp = join(root, 'tmp')
    mkdirSync(temp)
    const logged = spyOn(logModule, 'logError').mockImplementation(() => {})
    const saved = { runtime: process.env.LODESTAR_TEST_AGENT_RUNTIME_ROOT, tmp: process.env.TMPDIR }
    process.env.LODESTAR_TEST_AGENT_RUNTIME_ROOT = root
    process.env.TMPDIR = temp
    let launchDir = ''
    try {
      const runtime = new DshRuntime({ cwd: root, env: {}, home: join(root, 'home') })
      launchDir = (runtime as any).launchDir
      writeFileSync(join(launchDir, 'bridge.patch.yml'), '{}')
      // 直接让清理失败：不依赖 chmod/umask 的跨文件环境，凡是删除失败都必须只记日志。
      const failing = spyOn(runtime as any, 'removeLaunchDir').mockImplementation(() => {
        throw new Error('launch directory is busy')
      })
      try {
        // 触发真实的子进程 close 监听器；抛出的错误不得逃出事件回调。
        expect(() => (runtime as any).child.emit('close', 1, null)).not.toThrow()
        expect(logged).toHaveBeenCalledWith('dsh.launch_dir.cleanup_failed', expect.anything())
      } finally { failing.mockRestore() }
    } finally {
      if (launchDir) rmSync(launchDir, { recursive: true, force: true })
      logged.mockRestore()
      for (const [key, value] of [['LODESTAR_TEST_AGENT_RUNTIME_ROOT', saved.runtime], ['TMPDIR', saved.tmp]] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
