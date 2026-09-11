/**
 * P2-04 agent 自动更新用例(上游 9a6209b / 91a8530 摘录)。
 *
 * 全部用例 hermetic:安装根走注入的 mkdtemp 临时目录,metadata/install 全部注入,
 * 不触网、不调用真实 npm;定时器用本地 harness 假实现,不等真实 6 小时。
 * 「默认关 = 严格 no-op」是本 plan 的硬判据(D-06 / T-02-18)。
 */
import { afterEach, expect, spyOn, test } from 'bun:test'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_UPDATE_INTERVAL_MS,
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

const temporary: string[] = []
afterEach(async () => {
  for (const path of temporary.splice(0)) await retryAgentFileOperation(() => rm(path, { recursive: true }))
})
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lodestar-agent-updates-test-'))
  temporary.push(root)
  return root
}
/** 假安装:按 staging package.json 的 dependencies 铺出 node_modules 清单。 */
async function install(directory: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  for (const [name, version] of Object.entries(manifest.dependencies)) {
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
      update: fakeUpdate() as unknown as typeof updateAgentRuntimes,
    })
    expect(timer.interval).not.toHaveBeenCalled()
    expect(timer.pending()).toBe(0)
  } finally { timer.restore() }
})

test.each(['codex', 'claude', 'dsh'] as const)('%s auto-update alone starts at the six-hour tick, avoids overlap, and cancels on stop', async agent => {
  const root = await scratch()
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
  const timer = withTimerHarness()
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
    expect(timer.pending()).toBe(2)
    expect(checks).toEqual([])
    timer.tickAll()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(reports).toEqual(['claude 自动更新未完成: Claude registry failed'])
    timer.tickAll()
    expect(checks).toEqual(['codex', 'claude', 'claude'])
    expect(signals.get('codex')).not.toBe(signals.get('claude'))
    stop()
    expect(timer.pending()).toBe(0)
    expect([...signals.values()].filter(signal => signal.aborted).length).toBe(2)
  } finally { stop?.(); finishCodex(); await codexDone; timer.restore() }
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

test('unconfirmed installer termination preserves occupied staging files and records the failure', async () => {
  const root = await scratch()
  let partial = ''
  await expect(updateAgentRuntime('codex', { root,
    metadata: fakeUpdate(),
    install: async directory => {
      partial = directory
      await writeFile(join(directory, 'installer-held.exe'), 'still owned by installer')
      throw new AgentInstallTerminationError(`installer PID 12345 termination unconfirmed; partial directory retained: ${directory}`)
    },
  })).rejects.toThrow('termination unconfirmed')
  expect(await readFile(join(partial, 'installer-held.exe'), 'utf8')).toBe('still owned by installer')
  const state = JSON.parse(await readFile(join(root, 'codex/current.json'), 'utf8'))
  expect(state.error).toContain(partial)
  expect(state.directory).toBeUndefined()
})

test('updating while an old native executable is running never overwrites, moves, or deletes its runtime', async () => {
  const root = await scratch()
  // 上游用 node 二进制当"正在运行的 native 可执行体";本地 node 是 homebrew 动态链接
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
  // readState/writeState 往返:current.json 记录绝对目录 + 版本表 + 有限时间戳。
  const selected = JSON.parse(await readFile(join(root, 'codex/current.json'), 'utf8'))
  expect(selected.directory).toBe(second.directory)
  expect(selected.versions['@openai/codex']).toBe('99.0.0')
  expect(Number.isFinite(selected.checkedAt)).toBe(true)
  expect(selected.error).toBeUndefined()
})

test('installation failure records an error, removes the partial install, and never selects the old runtime', async () => {
  const root = await scratch()
  await updateAgentRuntime('codex', { root, install, metadata: fakeUpdate() })
  await expect(updateAgentRuntime('codex', { root, metadata: fakeUpdate('2.0.0'),
    install: async () => { throw new Error('npm installation failed') } })).rejects.toThrow('npm installation failed')
  const state = JSON.parse(await readFile(join(root, 'codex/current.json'), 'utf8'))
  expect(state.error).toContain('npm installation failed')
  expect(state.directory).toBeUndefined()
  expect((await readdir(join(root, 'codex'))).some(name => name.startsWith('.install-') || name === 'update.lock')).toBe(false)
})

test('registry failure is visible even if a previous install exists; recovery rechecks latest', async () => {
  const root = await scratch()
  const options = { root, install, metadata: fakeUpdate() }
  const before = await updateAgentRuntime('codex', options)
  await expect(updateAgentRuntime('codex', { ...options, metadata: async () => { throw new Error('registry offline') } })).rejects.toThrow('registry offline')
  expect(JSON.parse(await readFile(join(root, 'codex/current.json'), 'utf8')).error).toContain('registry offline')
  const after = await updateAgentRuntime('codex', options)
  expect(after.error).toBeUndefined()
  expect(after.directory).toBe(before.directory)
})

test('损坏的 current.json 不静默接受:读取即报错并把失败写回状态(T-02-19)', async () => {
  const root = await scratch()
  await mkdir(join(root, 'codex'), { recursive: true })
  await writeFile(join(root, 'codex/current.json'), JSON.stringify({ checkedAt: 'not-a-number', directory: 'relative/path' }))
  await expect(updateAgentRuntime('codex', { root, metadata: fakeUpdate(), install }))
    .rejects.toThrow('Invalid codex runtime state')
  const state = JSON.parse(await readFile(join(root, 'codex/current.json'), 'utf8'))
  expect(state.error).toContain('Invalid codex runtime state')
  expect(state.directory).toBeUndefined()
})

test('concurrent updater calls serialize and do not install the same release twice', async () => {
  const root = await scratch()
  let installed = 0
  const options = { root, metadata: fakeUpdate(),
    install: async (directory: string) => { installed++; await Bun.sleep(50); await install(directory) } }
  const [one, two] = await Promise.all([updateAgentRuntime('codex', options), updateAgentRuntime('codex', options)])
  expect(installed).toBe(1)
  expect(one.directory).toBe(two.directory)
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
  expect(JSON.parse(await readFile(join(root, 'claude/current.json'), 'utf8')).error).toContain('Claude registry failed')
})

test('D-06: 不收 runtime-root 间接层,agent-updates 不导出 agentBin/agentRuntimeRoot/loadClaudeSdk', async () => {
  const module = await import('./agent-updates') as Record<string, unknown>
  expect(module.agentRuntimeRoot).toBeUndefined()
  expect(module.agentBin).toBeUndefined()
  expect(module.agentPackagePath).toBeUndefined()
  expect(module.loadClaudeSdk).toBeUndefined()
  // 安装能力仍经 agent-install 再导出,供 agent-updates 的默认 install 使用。
  expect(typeof module.installAgentPackages).toBe('function')
})

test('AGENT_RUNTIMES_DIR 与 AGENT_RUNS_DIR 同源(均在 LODESTAR_DATA_DIR 下)', async () => {
  const paths = await import('./paths')
  expect(paths.AGENT_RUNTIMES_DIR).toBe(join(paths.DATA_DIR, 'agent-runtimes'))
  expect(paths.AGENT_RUNTIMES_DIR.startsWith(process.env.LODESTAR_DATA_DIR ?? paths.DATA_DIR)).toBe(true)
})
