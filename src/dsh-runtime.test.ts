import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dshGatesOnConnectionChain, dshProviderPatches, profileProvidesAskUser } from './dsh-runtime'

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
