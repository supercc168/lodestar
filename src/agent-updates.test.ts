/**
 * P2-04 agent 自动更新用例(上游 9a6209b / 91a8530 摘录,按合并后实现校准)。
 *
 * 全部用例 hermetic:安装根走注入的 mkdtemp 临时目录,metadata/install 全部注入,
 * 不触网、不调用真实 npm;定时器用 spy 假实现,不等真实 6 小时。
 * 「默认关 = 严格 no-op」是硬判据(D-06 / T-02-18)。
 * 失败语义随上游:current.json 只在成功提交时原子落盘 —— 失败不写失败态,
 * 失败经抛错 / timer report 可见。
 * 本地保留:锁获取宽限窗口、pid 落盘失败回滚(WR-02)、runtime-root 间接层
 * (agentRuntimeRoot 等五导出,测试期经 LODESTAR_TEST_AGENT_RUNTIME_ROOT 路由)。
 */
import { afterEach, expect, spyOn, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_UPDATE_INTERVAL_MS,
  agentRuntimeRoot,
  resolveAgentPackages,
  retryAgentFileOperation,
  startAgentAutoUpdates,
  updateAgentRuntime,
  updateAgentRuntimes,
  type AgentRuntimeState,
  type AgentUpdateOptions,
  type UpdatedAgent,
} from './agent-updates'
import { AgentInstallTerminationError } from './agent-install'

/** 子进程用例的 cwd 固定为仓库根:import './src/...' / 'src/version-cli.ts' 均相对它解析,不受调用目录影响。 */
const repoRoot = join(import.meta.dir, '..')

const temporary: string[] = []
afterEach(async () => {
  for (const path of temporary.splice(0)) await retryAgentFileOperation(() => rm(path, { recursive: true }))
})
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lodestar-agent-updates-test-'))
  temporary.push(root)
  return root
}
/** 假安装:按 staging package.json 的 overrides/dependencies 铺出 node_modules 清单。 */
async function install(directory: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  const family = Object.fromEntries(Object.entries(manifest.overrides ?? {}).filter(([name]) => name.startsWith('@deepseek-ai/dsh')))
  for (const [name, version] of Object.entries({ ...family, ...manifest.dependencies })) {
    const target = join(directory, 'node_modules', name)
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'package.json'), JSON.stringify({ name, version }))
  }
}
const fakeUpdate = (version = '1.0.0') => async (name: string): Promise<{ name: string; version: string }> => ({ name, version })

/** 假定时器:保留 setInterval/clearInterval 的真实契约 —— stop() 之后 tick 不得再触发。 */
function withTimerHarness() {
  const timers = new Map<number, () => void>()
  let nextId = 1
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
    const id = nextId++
    timers.set(id, callback)
    return { id, unref() {} } as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval)
  const clear = spyOn(globalThis, 'clearInterval').mockImplementation(((handle: { id?: number }) => {
    if (handle && handle.id !== undefined) timers.delete(handle.id)
  }) as typeof clearInterval)
  return {
    interval,
    pending: () => timers.size,
    tickAll: () => { for (const callback of [...timers.values()]) callback() },
    restore: () => { interval.mockRestore(); clear.mockRestore() },
  }
}
async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(5)
  }
  throw new Error('timed out waiting for condition')
}

test('auto-update is disabled by default and never checks or schedules at startup', () => {
  const interval = spyOn(globalThis, 'setInterval')
  let checks = 0
  try {
    const update = async (_agent: UpdatedAgent, _options?: AgentUpdateOptions): Promise<AgentRuntimeState> => {
      checks++
      return { checkedAt: 0 }
    }
    const omitted = startAgentAutoUpdates(() => {}, { update })
    const explicitFalse = startAgentAutoUpdates(() => {}, { enabled: { codex: false, claude: false, dsh: false }, update })
    expect(typeof omitted).toBe('function')
    expect(typeof explicitFalse).toBe('function')
    expect(checks).toBe(0)
    expect(interval).not.toHaveBeenCalled()
    // 默认关时返回的 stop 必须是安全 no-op(关停路径无条件调用)。
    omitted()
    explicitFalse()
  } finally { interval.mockRestore() }
})

test('enabled 只认严格 === true:字符串 / 缺项都不注册定时器(T-02-18)', () => {
  const timer = withTimerHarness()
  try {
    startAgentAutoUpdates(() => {}, {
      enabled: { claude: 'true', dsh: undefined } as unknown as Partial<Record<UpdatedAgent, boolean>>,
      update: fakeUpdate() as unknown as typeof updateAgentRuntime,
    })
    expect(timer.interval).not.toHaveBeenCalled()
    expect(timer.pending()).toBe(0)
  } finally { timer.restore() }
})

test.each(['codex', 'claude', 'dsh'] as const)('%s installs shared and runtime-specific security fixes without adding Agent-only libraries to the daemon', async agent => {
  const root = await scratch()
  let manifest: any
  const host = JSON.parse(await readFile(join(import.meta.dir, '../package.json'), 'utf8'))
  await updateAgentRuntime(agent, { root, metadata: async name => ({ name, version: '9.0.0' }),
    install: async directory => {
      manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      await install(directory)
    },
  })
  expect(manifest.overrides['@modelcontextprotocol/sdk']).toBe(host.overrides['@modelcontextprotocol/sdk'])
  expect(manifest.overrides['proxy-addr']).toBe(host.overrides['proxy-addr'])
  for (const name of ['@modelcontextprotocol/client', '@modelcontextprotocol/core']) {
    expect(host.dependencies[name]).toBeUndefined()
    expect(manifest.overrides[name]).toBe(agent === 'dsh' ? host.agentRuntimeOverrides.dsh[name] : undefined)
  }
})

test.each(['codex', 'claude', 'dsh'] as const)('%s auto-update alone starts at the six-hour tick, avoids overlap, and cancels on stop', async agent => {
  let tick!: () => void
  const handle = { unref() {} } as ReturnType<typeof setInterval>
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delay: number) => {
    expect(delay).toBe(AGENT_UPDATE_INTERVAL_MS)
    tick = callback
    return handle
  }) as typeof setInterval)
  const clear = spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
  let checks = 0
  let signal: AbortSignal | undefined
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  let stop: (() => void) | undefined
  try {
    stop = startAgentAutoUpdates(() => {}, { enabled: { [agent]: true }, update: async (updatedAgent, options) => {
      expect(updatedAgent).toBe(agent)
      checks++
      signal = options?.signal
      await done
      return { checkedAt: 0 }
    } })
    expect(interval).toHaveBeenCalledTimes(1)
    expect(checks).toBe(0)
    tick()
    tick()
    expect(checks).toBe(1)
    stop()
    expect(signal?.aborted).toBe(true)
    expect(clear).toHaveBeenCalledWith(handle)
  } finally {
    stop?.()
    finish()
    await done
    interval.mockRestore()
    clear.mockRestore()
  }
})

test('enabled 单档的六小时节拍:真实更新写入注入根,stop 后 tick 不再触发', async () => {
  const root = await scratch()
  const agent = 'codex'
  const timer = withTimerHarness()
  let checks = 0
  let signal: AbortSignal | undefined
  let stop: (() => void) | undefined
  try {
    stop = startAgentAutoUpdates(() => {}, {
      enabled: { [agent]: true },
      update: async (updatedAgent, options) => {
        expect(updatedAgent).toBe(agent)
        checks++
        signal = options?.signal
        // 安装根指向注入的临时目录:默认路径 AGENT_RUNTIMES_DIR 全程不被写。
        return await updateAgentRuntime(agent, { ...options, root, metadata: fakeUpdate(), install })
      },
    })
    expect(timer.interval).toHaveBeenCalledTimes(1)
    expect(timer.pending()).toBe(1)
    expect(checks).toBe(0)
    timer.tickAll()
    timer.tickAll()
    expect(checks).toBe(1)
    await waitFor(async () => {
      try { await readFile(join(root, agent, 'current.json'), 'utf8'); return true } catch { return false }
    })
    const state = JSON.parse(await readFile(join(root, agent, 'current.json'), 'utf8'))
    expect(state.directory.startsWith(root)).toBe(true)
    stop()
    expect(signal?.aborted).toBe(true)
    expect(timer.pending()).toBe(0)
    timer.tickAll()
    expect(checks).toBe(1)
  } finally { stop?.(); timer.restore() }
})

test('a pending Codex update and a failed Claude update do not block each other or enable DSH', async () => {
  const ticks: Array<() => void> = []
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
    ticks.push(callback)
    return { unref() {} } as ReturnType<typeof setInterval>
  }) as typeof setInterval)
  const clear = spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
  let finishCodex!: () => void
  const codexDone = new Promise<void>(resolve => { finishCodex = resolve })
  const checks: string[] = []
  const signals = new Map<string, AbortSignal>()
  const reports: string[] = []
  let stop: (() => void) | undefined
  try {
    stop = startAgentAutoUpdates(message => { reports.push(message) }, {
      enabled: { codex: true, claude: true, dsh: false },
      update: async (agent, options) => {
        checks.push(agent)
        signals.set(agent, options!.signal!)
        if (agent === 'codex') await codexDone
        else throw new Error('Claude registry failed')
        return { checkedAt: 0 }
      },
    })
    expect(ticks).toHaveLength(2)
    expect(checks).toEqual([])
    ticks[0]()
    ticks[1]()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(reports).toEqual(['claude 自动更新未完成: Claude registry failed'])
    ticks[0]()
    ticks[1]()
    expect(checks).toEqual(['codex', 'claude', 'claude'])
    expect(signals.get('codex')).not.toBe(signals.get('claude'))
    stop()
    expect(clear).toHaveBeenCalledTimes(2)
    expect([...signals.values()].every(signal => signal.aborted)).toBe(true)
  } finally {
    stop?.()
    finishCodex()
    await codexDone
    interval.mockRestore()
    clear.mockRestore()
  }
})

test('Windows file sharing violations retry the same operation and still surface final failure', async () => {
  let attempts = 0
  expect(await retryAgentFileOperation(async () => {
    if (++attempts < 3) throw Object.assign(new Error('temporarily locked'), { code: 'EPERM' })
    return 'published'
  }, 'win32')).toBe('published')
  expect(attempts).toBe(3)
  const error = Object.assign(new Error('file remains busy'), { code: 'EBUSY' })
  attempts = 0
  await expect(retryAgentFileOperation(async () => { attempts++; throw error }, 'win32')).rejects.toBe(error)
  expect(attempts).toBe(6)
  attempts = 0
  await expect(retryAgentFileOperation(async () => { attempts++; throw error }, 'linux')).rejects.toBe(error)
  expect(attempts).toBe(1)
})

test('unconfirmed installer termination preserves occupied staging files and reports the failure', async () => {
  const root = await scratch()
  let partial = ''
  await expect(updateAgentRuntime('codex', { root,
    metadata: async name => ({ name, version: '1.0.0' }),
    install: async directory => {
      partial = directory
      await writeFile(join(directory, 'installer-held.exe'), 'still owned by installer')
      throw new AgentInstallTerminationError(`installer PID 12345 termination unconfirmed; partial directory retained: ${directory}`)
    },
  })).rejects.toThrow('termination unconfirmed')
  expect(await readFile(join(partial, 'installer-held.exe'), 'utf8')).toBe('still owned by installer')
  // 失败不写失败态:本次从未成功提交过安装,current.json 不得凭空出现。
  expect(existsSync(join(root, 'codex/current.json'))).toBe(false)
})

test('updating while an old native executable is running never overwrites, moves, or deletes its runtime', async () => {
  const root = await scratch()
  // 上游用 node 二进制当"正在运行的 native 可执行体";本机 node 是 homebrew 动态链接
  // 版(@rpath/libnode.*.dylib),拷走后无法起。改用当前运行时自身的二进制(自包含)。
  const binary = process.execPath
  if (!binary) throw new Error('a self-contained runtime binary is required for the occupied-executable update test')
  let version = '1.0.0'
  const options = { root, metadata: async (name: string) => ({ name, version }),
    install: async (directory: string) => {
      await install(directory)
      await copyFile(binary, join(directory, 'agent.exe'))
      await chmod(join(directory, 'agent.exe'), 0o700)
    },
  }
  const first = await updateAgentRuntime('codex', options)
  const running = Bun.spawn([join(first.directory!, 'agent.exe'), '-e',
    'process.stdout.write("ready"); process.stdin.on("data", () => process.stdout.write("alive")); process.stdin.on("end", () => process.exit(0))',
  ], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  const reader = running.stdout.getReader()
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('ready')
    version = '2.0.0'
    const second = await updateAgentRuntime('codex', options)
    expect(second.directory).not.toBe(first.directory)
    await expect(updateAgentRuntime('codex', { ...options, metadata: async () => { throw new Error('registry offline') } })).rejects.toThrow('registry offline')
    running.stdin.write('ping')
    running.stdin.flush()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('alive')
    expect(running.exitCode).toBeNull()
    expect(JSON.parse(await readFile(join(first.directory!, 'node_modules/@openai/codex/package.json'), 'utf8')).version).toBe('1.0.0')
  } finally {
    running.stdin.end()
    await running.exited
    reader.releaseLock()
  }
}, 15_000)

test('Claude Code and both SDKs independently follow latest, including future major versions', async () => {
  const requests: string[] = []
  const packages = await resolveAgentPackages('claude', async (name, version) => {
    requests.push(`${name}@${version}`)
    return { name, version: name.endsWith('claude-code') ? '99.0.0' : '42.0.0' }
  })
  expect(requests).toEqual(['@anthropic-ai/claude-code@latest', '@anthropic-ai/claude-agent-sdk@latest', '@anthropic-ai/sdk@latest'])
  expect(packages['@anthropic-ai/claude-code']).toBe('99.0.0')
  expect(packages['@anthropic-ai/claude-agent-sdk']).toBe('42.0.0')
})

test('DSH discovers new dependency and peer packages from the latest release without a fixed package whitelist', async () => {
  const calls: string[] = []
  const packages = await resolveAgentPackages('dsh', async (name, version) => {
    calls.push(`${name}@${version}`)
    return { name, version: '9.0.0-rc.8', ...(name === '@deepseek-ai/dsh' ? {
      dependencies: { '@deepseek-ai/dsh-future': '^9.0.0-rc.8', 'ordinary-library': '^1' },
    } : name === '@deepseek-ai/dsh-future' ? { peerDependencies: { '@deepseek-ai/dsh-new-peer': '^9.0.0-rc.8' } } : {}) }
  })
  expect(packages['@deepseek-ai/dsh-future']).toBe('9.0.0-rc.8')
  expect(packages['@deepseek-ai/dsh-new-peer']).toBe('9.0.0-rc.8')
  expect(calls.filter(call => call.endsWith('@latest'))).toEqual(['@deepseek-ai/dsh@latest'])
  expect(calls.some(call => call.startsWith('ordinary-library'))).toBe(false)
})

test('DSH preserves upstream peer placement while keeping the resolved plugin family on one release', async () => {
  const root = await scratch()
  const version = '9.0.0-rc.8'
  const state = await updateAgentRuntime('dsh', { root, install, metadata: async name => ({ name, version,
    ...(name === '@deepseek-ai/dsh' ? { dependencies: { '@deepseek-ai/dsh-cmdline': `^${version}`,
      '@deepseek-ai/cordis': '4.0.2', '@deepseek-ai/cordis-plugin-loader': '1.0.3' } }
      : name === '@deepseek-ai/dsh-cmdline' ? { peerDependencies: { '@deepseek-ai/cordis': '4.0.2',
        '@deepseek-ai/cordis-plugin-loader': '1.0.3' } } : {}),
  }) })
  const manifest = JSON.parse(await readFile(join(state.directory!, 'package.json'), 'utf8'))
  expect(manifest.dependencies).toEqual({ '@deepseek-ai/dsh': version,
    '@deepseek-ai/dsh-llm-pi-ai': version, '@deepseek-ai/dsh-tool-ask-user': version })
  expect(manifest.overrides['@deepseek-ai/dsh-cmdline']).toBe(version)
  expect(manifest.overrides['@deepseek-ai/cordis']).toBeUndefined()
  expect(state.versions?.['@deepseek-ai/dsh-cmdline']).toBe(version)
  expect(JSON.parse(await readFile(join(state.directory!, 'node_modules/@deepseek-ai/dsh-cmdline/package.json'), 'utf8')).version).toBe(version)
})

test('successful installs activate immediately without compatibility gating and preserve the old process directory', async () => {
  const root = await scratch()
  let version = '1.0.0'
  const options = { root, install, metadata: async (name: string) => ({ name, version }) }
  const first = await updateAgentRuntime('codex', options)
  version = '99.0.0'
  const second = await updateAgentRuntime('codex', options)
  expect(second.directory).not.toBe(first.directory)
  expect(second.versions?.['@openai/codex']).toBe('99.0.0')
  const old = JSON.parse(await readFile(join(first.directory!, 'node_modules/@openai/codex/package.json'), 'utf8'))
  expect(old.version).toBe('1.0.0')
  // readState/writeState 往返:current.json 记录绝对目录 + 版本表 + 有限时间戳,失败字段不出现。
  const selected = JSON.parse(await readFile(join(root, 'codex/current.json'), 'utf8'))
  expect(selected.directory).toBe(second.directory)
  expect(selected.versions['@openai/codex']).toBe('99.0.0')
  expect(Number.isFinite(selected.checkedAt)).toBe(true)
  expect(selected.error).toBeUndefined()
})

test.each(['codex', 'claude', 'dsh'] as const)('%s installation failure retains the selected runtime and removes the partial install', async agent => {
  const root = await scratch()
  const selected = await updateAgentRuntime(agent, { root, install, metadata: async name => ({ name, version: '1.0.0' }) })
  await expect(updateAgentRuntime(agent, { root, metadata: async name => ({ name, version: '2.0.0' }),
    install: async () => { throw new Error('npm installation failed') } })).rejects.toThrow('npm installation failed')
  const state = JSON.parse(await readFile(join(root, agent, 'current.json'), 'utf8'))
  expect(state).toEqual(selected)
  expect((await readdir(join(root, agent))).some(name => name.startsWith('.install-') || name === 'update.lock')).toBe(false)
})

test('repeated registry failures leave the selected install unchanged until a successful update', async () => {
  const root = await scratch()
  const options = { root, install, metadata: async (name: string) => ({ name, version: '1.0.0' }) }
  const before = await updateAgentRuntime('codex', options)
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(updateAgentRuntime('codex', { ...options, metadata: async () => { throw new Error('registry offline') } })).rejects.toThrow('registry offline')
    const failed = JSON.parse(await readFile(join(root, 'codex/current.json'), 'utf8'))
    expect(failed).toEqual(before)
  }
  const after = await updateAgentRuntime('codex', options)
  expect(after.error).toBeUndefined()
  expect(after.directory).toBe(before.directory)
})

test('损坏的 current.json 不静默接受:读取即报错,失败不写回状态(T-02-19)', async () => {
  const root = await scratch()
  await mkdir(join(root, 'codex'), { recursive: true })
  const corrupted = { checkedAt: 'not-a-number', directory: 'relative/path' }
  await writeFile(join(root, 'codex/current.json'), JSON.stringify(corrupted))
  await expect(updateAgentRuntime('codex', { root, metadata: fakeUpdate(), install }))
    .rejects.toThrow('Invalid codex runtime state')
  // 失败不写失败态(上游语义):current.json 保持原文,不追加 error 字段、不残留锁目录。
  expect(JSON.parse(await readFile(join(root, 'codex/current.json'), 'utf8'))).toEqual(corrupted)
  expect((await readdir(join(root, 'codex'))).includes('update.lock')).toBe(false)
})

test('concurrent updater calls serialize and do not install the same release twice', async () => {
  const root = await scratch()
  let installed = 0
  const options = { root, metadata: async (name: string) => ({ name, version: '1.0.0' }),
    install: async (directory: string) => { installed++; await Bun.sleep(50); await install(directory) } }
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => updateAgentRuntime('codex', options)))
  const states = results.map(result => {
    if (result.status === 'rejected') throw result.reason
    return result.value
  })
  expect(installed).toBe(1)
  expect(new Set(states.map(state => state.directory)).size).toBe(1)
  expect((await readdir(join(root, 'codex'))).includes('update.lock')).toBe(false)
})

test('锁目录已建但 pid 尚未落盘的窗口不被误判为损坏锁', async () => {
  const root = await scratch()
  const directory = join(root, 'codex')
  // 复刻 mkdir 与 pid 落盘之间的真实窗口:进程已建锁目录,pid 还没写完。
  await mkdir(join(directory, 'update.lock'), { recursive: true })
  await writeFile(join(directory, 'update.lock', 'pid'), '')
  let settled: unknown
  const pending = updateAgentRuntime('codex', { root, metadata: fakeUpdate(), install })
    .then(state => state, error => { settled = error; return undefined })
  await Bun.sleep(300)
  // 仍在按节拍等锁,而不是毫秒级炸成 Invalid runtime update lock(并发更新会因此凭空失败)。
  expect(settled).toBeUndefined()
  await rm(join(directory, 'update.lock'), { recursive: true })
  expect((await pending)?.directory).toBeTruthy()
})

test('pid 落盘失败时回滚锁目录:同一 agent 的后续更新不会被锁楔死(WR-02)', async () => {
  const root = await scratch()
  const directory = join(root, 'codex')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  // 复刻"mkdir 成功、pid 落盘失败"的失败路径:umask 0o222 让新建锁目录可读可进入、
  // 但没有写权限(writeFile EACCES),且不阻碍回滚 rm(它只依赖父目录写权限)。
  const previousUmask = process.umask(0o222)
  try {
    await expect(updateAgentRuntime('codex', { root, metadata: fakeUpdate(), install }))
      .rejects.toMatchObject({ code: 'EACCES' })
  } finally {
    process.umask(previousUmask)
  }
  // 缺陷下空锁目录残留:后续每次尝试都 EEXIST → 读不到 pid → 5s 宽限后抛
  // Invalid runtime update lock,人工删目录前该 agent 的更新永久失败。
  expect(await readdir(directory)).not.toContain('update.lock')
  const state = await updateAgentRuntime('codex', { root, metadata: fakeUpdate(), install })
  expect(state.directory).toBeTruthy()
})

test('one Agent update failure does not prevent other Agents from getting their latest runtime', async () => {
  const root = await scratch()
  await expect(updateAgentRuntimes({ root, install, metadata: async name => {
    if (name.startsWith('@anthropic-ai/')) throw new Error('Claude registry failed')
    return { name, version: '7.0.0' }
  } })).rejects.toThrow('Claude registry failed')
  for (const agent of ['codex', 'dsh']) {
    expect(JSON.parse(await readFile(join(root, agent, 'current.json'), 'utf8')).directory).toBeTruthy()
  }
  // 失败不写失败态:失败的 claude 不留下任何选择记录(旧版会写 {checkedAt,error})。
  expect(existsSync(join(root, 'claude/current.json'))).toBe(false)
})

test('SDK loading ignores update failures and legacy diagnostics, while a missing installation still fails', async () => {
  const root = await scratch()
  const child = Bun.spawn([process.execPath, '-e', `
    import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
    import { join } from 'node:path'
    const { updateAgentRuntime, loadClaudeSdk, agentRuntimeRoot, agentRuntimeState } = await import('./src/agent-updates')
    let version = '1.0.0'
    const options = { metadata: async name => ({ name, version }), install: async directory => {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      for (const [name, version] of Object.entries(manifest.dependencies)) {
        const target = join(directory, 'node_modules', name)
        await mkdir(target, { recursive: true })
        await writeFile(join(target, 'package.json'), JSON.stringify({ name, version, type: 'module', main: 'sdk.mjs' }))
        await writeFile(join(target, 'sdk.mjs'), 'export const query = () => ' + JSON.stringify(version))
      }
    } }
    await updateAgentRuntime('claude', options)
    const first = await loadClaudeSdk()
    version = '99.0.0'
    await updateAgentRuntime('claude', options)
    const second = await loadClaudeSdk()
    if (first.query() !== '1.0.0' || second.query() !== '99.0.0') throw new Error('SDK module resolution did not follow runtime update')
    let updateFailure
    try { await updateAgentRuntime('claude', { ...options, metadata: async () => { throw new Error('registry failed') } }) }
    catch (error) { updateFailure = error.message }
    if (updateFailure !== 'registry failed') throw new Error('update failure was not surfaced')
    if ((await loadClaudeSdk()).query() !== '99.0.0') throw new Error('failed update prevented SDK loading')
    const retained = agentRuntimeRoot('claude')
    const selected = agentRuntimeState('claude')
    if (selected.error) throw new Error('failed update modified the selected installation')
    await writeFile(join(process.env.LODESTAR_DATA_DIR, 'agent-runtimes/claude/current.json'), JSON.stringify({ ...selected, error: 'legacy registry failure' }))
    if ((await loadClaudeSdk()).query() !== '99.0.0') throw new Error('legacy update failure prevented SDK loading')
    await rm(retained, { recursive: true })
    let failure
    try { agentRuntimeRoot('claude') } catch (error) { failure = error.message }
    if (!failure?.includes('安装目录不存在') || failure.includes('registry')) throw new Error('missing installation was not reported independently')
    console.log('runtime resolution passed')
  `], { cwd: repoRoot, env: { ...process.env, NODE_ENV: 'production', LODESTAR_DATA_DIR: root }, stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
  expect(stdout).toContain('runtime resolution passed')
})

test('a failed first install or a legacy error without a selected directory never guesses an installed runtime', async () => {
  const root = await scratch()
  const child = Bun.spawn([process.execPath, '-e', `
    import assert from 'node:assert/strict'
    import { mkdir, writeFile } from 'node:fs/promises'
    import { join } from 'node:path'
    const { updateAgentRuntime, agentRuntimeRoot, agentRuntimeState } = await import('./src/agent-updates')
    await assert.rejects(updateAgentRuntime('codex', {
      metadata: async () => { throw new Error('TLS disconnected') },
    }), /TLS disconnected/)
    assert.equal(agentRuntimeState('codex'), null)
    assert.throws(() => agentRuntimeRoot('codex'), /runtime 未安装.*lodestar-update --agents-only/)
    await writeFile(join(process.env.LODESTAR_DATA_DIR, 'agent-runtimes/codex/current.json'), JSON.stringify({ checkedAt: 1, error: 'TLS disconnected' }))
    // Old releases erased the selected path on failure. An unrelated directory is not a selection record.
    const unrelated = join(process.env.LODESTAR_DATA_DIR, 'agent-runtimes/codex/unselected/node_modules/@openai/codex')
    await mkdir(unrelated, { recursive: true })
    await writeFile(join(unrelated, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '1.0.0' }))
    assert.throws(() => agentRuntimeRoot('codex'), /runtime 未安装/)
  `], { cwd: repoRoot, env: { ...process.env, NODE_ENV: 'production', LODESTAR_DATA_DIR: root }, stdout: 'pipe', stderr: 'pipe' })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
})

test('lodestar-version displays only the selected installation, without update diagnostics or a failed exit code', async () => {
  const root = await scratch()
  const runtimeRoot = join(root, 'agent-runtimes')
  const selected = await updateAgentRuntime('codex', { root: runtimeRoot, install, metadata: async name => ({ name, version: '1.0.0' }) })
  await expect(updateAgentRuntime('codex', { root: runtimeRoot, metadata: async () => { throw new Error('TLS disconnected') } })).rejects.toThrow('TLS disconnected')
  await writeFile(join(runtimeRoot, 'codex/current.json'), JSON.stringify({ ...selected, error: 'legacy TLS disconnected' }))
  const child = Bun.spawn([process.execPath, 'src/version-cli.ts'], {
    cwd: repoRoot, env: { ...process.env, NODE_ENV: 'production', LODESTAR_DATA_DIR: root }, stdout: 'pipe', stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
  expect(stdout).toContain('codex: @openai/codex@1.0.0')
  expect(stdout).toContain(selected.directory!)
  expect(stdout).not.toContain('更新失败')
  expect(stdout).not.toContain('TLS disconnected')
  expect(stdout).not.toContain('codex: MISS')
})

test.each(['missing', 'mismatched'])('lodestar-version reports a %s installed package instead of a successful recorded version', async damage => {
  const root = await scratch()
  const selected = await updateAgentRuntime('codex', { root: join(root, 'agent-runtimes'), install, metadata: async name => ({ name, version: '1.0.0' }) })
  const manifest = join(selected.directory!, 'node_modules/@openai/codex/package.json')
  if (damage === 'missing') await rm(manifest)
  else await writeFile(manifest, JSON.stringify({ name: '@openai/codex', version: '0.0.0' }))
  const child = Bun.spawn([process.execPath, 'src/version-cli.ts'], {
    cwd: repoRoot, env: { ...process.env, NODE_ENV: 'production', LODESTAR_DATA_DIR: root }, stdout: 'pipe', stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(code).toBe(1)
  expect(stdout).not.toContain('codex: @openai/codex@1.0.0')
  expect(stderr).toContain('codex: MISS')
  expect(stderr).toContain(damage === 'missing' ? 'ENOENT' : '安装包与记录不一致')
})

test('a failed scheduled update keeps the current install and succeeds on the next scheduled check', async () => {
  const root = await scratch()
  const selected = await updateAgentRuntime('codex', { root, install, metadata: async name => ({ name, version: '1.0.0' }) })
  let tick!: () => void
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delay: number) => {
    expect(delay).toBe(AGENT_UPDATE_INTERVAL_MS)
    tick = callback
    return { unref() {} } as ReturnType<typeof setInterval>
  }) as typeof setInterval)
  const clear = spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
  let pending!: ReturnType<typeof updateAgentRuntime>
  let checks = 0
  const reports: string[] = []
  let stop: (() => void) | undefined
  try {
    stop = startAgentAutoUpdates(message => { reports.push(message) }, { enabled: { codex: true }, update: (agent, options) => {
      checks++
      return pending = updateAgentRuntime(agent, { ...options, root, install, metadata: async name => {
        if (checks === 1) throw new Error('temporary TLS failure')
        return { name, version: '2.0.0' }
      } })
    } })
    expect(checks).toBe(0)
    tick()
    await expect(pending).rejects.toThrow('temporary TLS failure')
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(checks).toBe(1)
    expect(JSON.parse(await readFile(join(root, 'codex/current.json'), 'utf8'))).toEqual(selected)
    expect(reports).toContain('codex 自动更新未完成: temporary TLS failure')
    tick()
    const updated = await pending
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(checks).toBe(2)
    expect(updated.versions?.['@openai/codex']).toBe('2.0.0')
    expect(updated.directory).not.toBe(selected.directory)
    expect(JSON.parse(await readFile(join(root, 'codex/current.json'), 'utf8'))).toEqual(updated)
  } finally {
    stop?.()
    interval.mockRestore()
    clear.mockRestore()
  }
})

test('D-06 反转:runtime-root 间接层以导出为契约,测试期经 LODESTAR_TEST_AGENT_RUNTIME_ROOT 路由', async () => {
  const module = await import('./agent-updates') as Record<string, unknown>
  // 合并树 spawn 入口(claude-agent-process / codex-process / dsh-runtime / version-cli)
  // 以这五个导出为依赖锚。
  for (const name of ['agentRuntimeRoot', 'agentRuntimeState', 'agentPackagePath', 'agentBin', 'loadClaudeSdk']) {
    expect(typeof module[name]).toBe('function')
  }
  // 测试进程由 test-preload 注入隔离依赖树:构造器只读该根,绝不落到真实 ~/.local/share。
  expect(agentRuntimeRoot('claude')).toBe(process.env.LODESTAR_TEST_AGENT_RUNTIME_ROOT!)
})

test('AGENT_RUNTIMES_DIR 与 AGENT_RUNS_DIR 同源(均在 LODESTAR_DATA_DIR 下)', async () => {
  const paths = await import('./paths')
  expect(paths.AGENT_RUNTIMES_DIR).toBe(join(paths.DATA_DIR, 'agent-runtimes'))
  expect(paths.AGENT_RUNTIMES_DIR.startsWith(process.env.LODESTAR_DATA_DIR ?? paths.DATA_DIR)).toBe(true)
})

// ── 接线回归锁(daemon 无单测宿主,用源码断言钉住 HEAD 语义与保护线)──────────────
test('daemon 接线 HEAD 语义:只挂定时器(默认关=零定时器),启动不主动更新', async () => {
  const source = await readFile(join(import.meta.dir, '..', 'daemon.ts'), 'utf8')
  // 导入 + boot 赋值 ≥2;关停清定时器(声明 + 调用 + 赋值)≥3。
  expect(source.match(/startAgentAutoUpdates/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  expect(source.match(/stopAgentAutoUpdates/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  // HEAD 语义:启动不调用主动更新(D-06 / T-02-18)。
  expect(source.includes('updateAgentRuntimes')).toBe(false)
  // 开关来自配置三开关对象,而不是硬编码 true。
  expect(source).toContain('startAgentAutoUpdates(log, { enabled: config.runtime.agent_auto_update })')
})

test('setup 模板与 postinstall 提示:自动更新默认关,--agents-only 为实际入口', async () => {
  const setup = await readFile(join(import.meta.dir, 'setup.ts'), 'utf8')
  expect(setup).toContain('[runtime.agent_auto_update]')
  expect(setup).toContain('codex = false')
  expect(setup).toContain('claude = false')
  expect(setup).toContain('dsh = false')

  const postinstall = await readFile(join(import.meta.dir, '..', 'scripts', 'postinstall.cjs'), 'utf8')
  expect(postinstall).toContain('启动时不检查或更新 Agent，自动更新默认关闭。')
  // 合并后 lodestar-update 已支持 --agents-only(update-cli.ts 解析;agent-updates.ts
  // 报错文案同源),postinstall 提示照上游 c55bb44 写该旗标。
  expect(postinstall).toContain('lodestar-update --agents-only')
})
