import { homedir, tmpdir } from 'node:os'
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'node:fs'
import { delimiter, join, win32 } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

mock.module('./config', () => ({
  config: {
    // mock.module 是进程级的；补齐共享 runtime，避免污染同批运行的 Session 测试。
    runtime: {
      projects_root: homedir(),
      live_elapsed: 'bucket',
    },
    claude: {
      env: {},
      models: {},
    },
    codex: {
      env: {},
      models: {},
    },
  },
}))

const {
  buildClaudeSpawnPath,
  CLAUDE_PERMISSION_MODE,
  ClaudeAgentProcess,
  claudeSdkReasoningOptions,
  claudeTranscriptPath,
  readLastCallUsageFromTranscript,
  readProjectMcpServers,
  resetClaudeContextWindowCache,
  resolveClaudeExecutableConfig,
  settingSourcesFromProfile,
  claudeSettingsFilesForSources,
  claudeSettingsAliasConflicts,
  toolsFromProfile,
  claudeManagedSkillOptions,
} = await import('./claude-agent-process')
const {
  resolveClaudeSdkModel,
  claudeModelEnv,
  claudeModelIsApiRoute,
  claudeModelConfigured,
  claudeModelEffort,
} = await import('./claude-models')
const { NothingToCompactError } = await import('./agent-process')
const { config } = await import('./config')
const agentUpdates = await import('./agent-updates')

// context window 是 daemon 全局缓存(按路由 key 跨 session 共享),
// 每个用例前重置,避免互相污染。
beforeEach(() => resetClaudeContextWindowCache())

describe('Claude native steering', () => {
  function running() {
    const proc = new ClaudeAgentProcess({ workDir: tmpdir(), effort: 'high' }) as any
    proc.started = true
    const events: any[] = []
    proc.on('result', (result: any) => events.push(result))
    proc.handleMessage({ type: 'system', subtype: 'session_state_changed', state: 'running', uuid: 'turn-1' })
    return { proc, events }
  }
  function result(proc: any, ids: string[], extra = {}) {
    proc.handleMessage({ type: 'result', subtype: 'success', uuid: 'result',
      user_message_uuids: ids, queued_turn_count: 0,
      usage: { input_tokens: 10, output_tokens: 2 }, duration_ms: 100, num_turns: 1, ...extra })
  }

  test('streams guidance at the next native input boundary, with an independent input id', async () => {
    const { proc, events } = running()
    const consumed: any[] = []
    proc.on('user_input_consumed', (event: any) => consumed.push(event))
    expect(await proc.steerUserText('extra context', ['/tmp/input.txt'], 'input-1')).toBe(true)
    const { value } = await proc.input.next()
    expect(value.priority).toBe('next')
    expect(value.message.content).toEqual([{ type: 'text', text: '[file: /tmp/input.txt]\n\nextra context' }])
    expect(value.uuid).toBeString()
    expect(events).toEqual([])
    expect(consumed).toEqual([])
    proc.handleMessage({ type: 'command_lifecycle', command_uuid: value.uuid, state: 'queued' })
    expect(consumed).toEqual([])
    proc.handleMessage({ type: 'command_lifecycle', command_uuid: 'unknown-input', state: 'started' })
    proc.handleMessage({ type: 'command_lifecycle', command_uuid: value.uuid, state: 'started' })
    proc.handleMessage({ type: 'command_lifecycle', command_uuid: value.uuid, state: 'completed' })
    expect(consumed).toEqual([{ inputId: 'input-1' }])
    result(proc, [value.uuid])
    expect(events).toHaveLength(1)
    expect(proc.steeringInputs.size).toBe(0)
  })

  test('headless input can be steered without session_state_changed and lifecycle receipts consume every input', async () => {
    const proc = new ClaudeAgentProcess({ workDir: tmpdir(), effort: 'high' }) as any
    proc.started = true
    const events: any[] = []
    proc.on('result', (event: any) => events.push(event))
    proc.sendUserText('original request')
    await proc.input.next()
    expect(proc.turnActive).toBe(false)
    for (let i = 0; i < 65; i++) {
      expect(await proc.steerUserText(`guidance ${i}`)).toBe(true)
      const { value } = await proc.input.next()
      proc.handleMessage({ type: 'command_lifecycle', command_uuid: value.uuid, state: 'started' })
    }
    // Native result uuid lists are capped; per-command receipts must suffice.
    result(proc, [])
    expect(events).toHaveLength(1)
    expect(proc.steeringInputs.size).toBe(0)
  })

  test('a result preceding consumption keeps one logical task and aggregates native turns', async () => {
    const { proc, events } = running()
    const starts: any[] = []
    proc.on('turn_started', (event: any) => starts.push(event))
    await proc.steerUserText('arrived at boundary')
    const { value } = await proc.input.next()
    result(proc, ['original'], { queued_turn_count: 1 })
    expect(events).toEqual([])
    proc.handleMessage({ type: 'system', subtype: 'session_state_changed', state: 'running', uuid: 'turn-2' })
    expect(starts[0].retry).toBe(true)
    result(proc, [value.uuid])
    expect(events).toHaveLength(1)
    expect(events[0].duration_ms).toBe(200)
    expect(proc.lastUsage.input_tokens).toBe(20)
    expect(proc.lastResult.num_turns).toBe(2)
    expect(proc.steeringResults).toEqual([])
  })

  test('intermediate failures remain visible and cannot become a successful aggregate', async () => {
    const { proc, events } = running()
    const failures: any[] = []
    proc.on('turn_input_error', (event: any) => failures.push(event))
    await proc.steerUserText('follow-up')
    const { value } = await proc.input.next()
    result(proc, [], { is_error: true, subtype: 'error_during_execution', errors: ['upstream failed'] })
    expect(failures).toEqual([{ error: 'upstream failed' }])
    result(proc, [value.uuid])
    expect(events[0].is_error).toBe(true)
    expect(events[0].error).toBe('upstream failed')
  })

  test('stop clears unwritten guidance and requests native cancellation of queued inputs', async () => {
    const { proc, events } = running()
    const interruptions: any[] = []
    proc.query = { interrupt: async (options: any) => { interruptions.push(options); return { still_queued: [], cancelled: [] } } }
    await proc.steerUserText('must be cancelled')
    proc.sendInterrupt()
    expect(interruptions).toEqual([{ cancelQueued: true }])
    expect(proc.input.items).toEqual([])
    expect(proc.steeringInputs.size).toBe(0)
    result(proc, [], { is_error: true, subtype: 'interrupted' })
    expect(events).toHaveLength(1)
    expect(await proc.steerUserText('idle')).toBe(false)
    proc.alive = false
    await expect(proc.steerUserText('closed')).rejects.toThrow('已关闭')
  })

  test('an upstream cancellation after a deferred result fails visibly without waiting forever', async () => {
    const { proc, events } = running()
    const failures: any[] = []
    proc.on('turn_input_error', (event: any) => failures.push(event))
    await proc.steerUserText('cancelled upstream')
    const { value } = await proc.input.next()
    result(proc, [])
    expect(events).toEqual([])
    proc.handleMessage({ type: 'command_lifecycle', command_uuid: value.uuid, state: 'cancelled' })
    expect(events).toHaveLength(1)
    expect(events[0].is_error).toBe(true)
    expect(events[0].error).toContain('取消')
    expect(failures).toHaveLength(1)
    expect(proc.steeringInputs.size).toBe(0)
    expect(proc.steeringResults).toEqual([])
  })
})

describe('Claude model profiles', () => {
  test('shared config mock includes runtime elapsed defaults', () => {
    expect(config.runtime).toMatchObject({ live_elapsed: 'bucket' })
  })

  test('SDK launches opt into task tracking while preserving routing and project tool restrictions', async () => {
    const captured: any[] = []
    const sdk = spyOn(agentUpdates, 'loadClaudeSdk').mockResolvedValue({
      query: ({ options }: any) => {
        captured.push(options)
        return (async function* () {})()
      },
    } as any)
    try {
      for (const resumed of [false, true]) {
        const proc = new ClaudeAgentProcess({
          workDir: tmpdir(), model: resumed ? 'GLM-5.3-Flash' : 'claude-opus-5', effort: 'max',
          ...(resumed ? { resumeSessionId: 'task-session' } : {}),
          profile: resumed ? { tools: 'Read,TaskCreate,TaskUpdate,TaskList', loadProjectMcp: false } : { loadProjectMcp: false },
          settingSources: resumed ? ['project', 'local'] : ['user', 'project', 'local'],
          transformEnv: env => ({ ...env, CLAUDE_CODE_ENABLE_TODO_TOOLS: '0',
            ANTHROPIC_BASE_URL: 'https://provider.invalid', ANTHROPIC_AUTH_TOKEN: 'test-only' }),
        }) as any
        proc.sendInitialize()
        await proc.queryStart
        expect(captured).toHaveLength(resumed ? 2 : 1)
        const options = captured.at(-1)
        expect(options.env.CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('1')
        expect(options.env.ANTHROPIC_BASE_URL).toBe('https://provider.invalid')
        expect(options.env.ANTHROPIC_AUTH_TOKEN).toBe('test-only')
        expect(options.resume).toBe(resumed ? 'task-session' : undefined)
        expect(options.tools).toEqual(resumed
          ? ['Read', 'TaskCreate', 'TaskUpdate', 'TaskList']
          : { type: 'preset', preset: 'claude_code' })
      }
    } finally { sdk.mockRestore() }
  })

  test('thinking estimates update progress without changing billed usage', () => {
    const proc = new ClaudeAgentProcess({ workDir: tmpdir(), effort: 'high' }) as any
    const progress: unknown[] = []
    proc.on('thinking_progress', (event: unknown) => progress.push(event))
    proc.handleMessage({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 123, estimated_tokens_delta: 4 })
    expect(proc.lastThinkingTokens).toBe(123)
    expect(proc.lastUsage).toBeNull()
    expect(progress).toEqual([{ estimatedTokens: 123 }])
    proc.handleMessage({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: -1 })
    expect(proc.lastThinkingTokens).toBe(123)
  })

  test('an empty upstream tool name remains visible as MISS with its original tool id', () => {
    const proc = new ClaudeAgentProcess({ workDir: tmpdir(), effort: 'high' }) as any
    const uses: unknown[] = []
    proc.on('tool_use', (event: unknown) => uses.push(event))
    proc.handleMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'invalid-tool', name: '', input: {} }] } })
    expect(uses).toEqual([{ id: 'invalid-tool', name: 'MISS', input: {}, parentToolUseId: null }])
  })
  test('hot settings preserve explicit max and reject a change requiring a different process environment', async () => {
    const proc = new ClaudeAgentProcess({ workDir: tmpdir(), effort: 'high' }) as any
    const updates: unknown[] = []
    proc.started = true
    proc.query = { setModel: async () => {}, applyFlagSettings: async (settings: unknown) => { updates.push(settings) } }
    await proc.setModelSettings('moonshotai/kimi-k3', 'max')
    await expect(proc.setModelSettings('xiaomi/mimo-v2.5-pro', 'default')).rejects.toThrow('启动环境')
    await proc.setModelSettings('google/gemini-3.8-flash', 'high')
    expect(updates).toEqual([
      { effortLevel: 'max', ultracode: null },
      { effortLevel: 'high', ultracode: null },
    ])
    expect(proc.lastEffort).toBe('high')
    const nativeDefault = new ClaudeAgentProcess({ workDir: tmpdir(), effort: 'default' }) as any
    nativeDefault.started = true
    nativeDefault.query = proc.query
    await nativeDefault.setModelSettings('minimax/minimax-m3', 'default')
    expect(updates.at(-1)).toEqual({ effortLevel: null, ultracode: null })
  })
  test('a rejected model control does not attempt effort or report the old settings as confirmed', async () => {
    const proc = new ClaudeAgentProcess({ workDir: tmpdir(), model: 'old-model', effort: 'high' }) as any
    proc.started = true
    let flagCalls = 0
    proc.query = {
      setModel: async () => { throw new Error('model control transport closed') },
      applyFlagSettings: async () => { flagCalls++ },
    }
    await expect(proc.setModelSettings('new-model', 'max')).rejects.toMatchObject({
      confirmedModel: null, message: '模型设置未确认：model control transport closed',
    })
    expect(flagCalls).toBe(0)
    expect(proc.lastModel).toBeNull()
    expect(proc.lastEffort).toBeNull()
  })

  test('loads daemon-managed Skills as a plugin only when user settings are excluded', () => {
    expect(claudeManagedSkillOptions(['project', 'local'], '/data/lodestar-plugin')).toEqual({
      plugins: [{ type: 'local', path: '/data/lodestar-plugin', skipMcpDiscovery: true }],
      skills: 'all',
    })
    expect(claudeManagedSkillOptions(['user', 'project'], '/data/lodestar-plugin')).toEqual({})
  })
  test('uses SDK default executable when no global Claude command is found', () => {
    const executable = resolveClaudeExecutableConfig({
      platform: 'win32',
      pathEnv: '',
      configuredBin: null,
      exists: () => false,
    })

    expect(executable).toEqual({ description: 'sdk-default' })
  })

  test('Windows default uses the managed SDK even when an unrelated global npm shim exists', () => {
    const binDir = 'C:\\Users\\me\\AppData\\Roaming\\npm'
    const shim = win32.join(binDir, 'claude.cmd')
    const executable = resolveClaudeExecutableConfig({
      platform: 'win32',
      pathEnv: binDir,
      configuredBin: null,
      exists: path => path === shim,
    })

    expect(executable).toEqual({ description: 'sdk-default' })
  })

  test('win32 native exe falls through to SDK default entry (not passed directly, so dialog tools work)', () => {
    const binDir = 'C:\\Program Files\\ClaudeCode'
    const exe = win32.join(binDir, 'claude.exe')
    const shim = win32.join(binDir, 'claude.cmd')
    const executable = resolveClaudeExecutableConfig({
      platform: 'win32',
      pathEnv: binDir,
      configuredBin: null,
      exists: path => path === exe || path === shim,
    })

    // 走 SDK 默认入口(不显式传 pathToClaudeCodeExecutable):显式传会让 claude 走
    // CLI stream-json 模式,不下发 AskUserQuestion 等 dialog 工具。SDK 默认入口
    // 自己解析平台 native binary。见 resolveClaudeExecutableConfig 201-204 注释。
    expect(executable.pathToClaudeCodeExecutable).toBeUndefined()
    expect(executable.spawnClaudeCodeProcess).toBeUndefined()
    expect(executable.description).toBe('sdk-default')
  })

  test.skipIf(process.platform === 'win32')('keeps npm-global, local bins, and existing PATH in Claude spawn PATH', () => {
    const originalPath = process.env.PATH
    try {
      process.env.PATH = ['/opt/custom/bin', '/usr/bin'].join(delimiter)
      const entries = buildClaudeSpawnPath().split(delimiter)

      expect(entries).toContain(join(homedir(), '.local', 'npm-global', 'bin'))
      expect(entries).toContain(join(homedir(), '.local', 'bin'))
      expect(entries).toContain('/opt/custom/bin')
      expect(entries.filter(entry => entry === '/usr/bin')).toHaveLength(1)
    } finally {
      process.env.PATH = originalPath
    }
  })

  test('maps GLM and DeepSeek profiles to SDK model and env tiers', () => {
    expect(resolveClaudeSdkModel('claude:default')).toBe('claude-fable-5')
    expect(resolveClaudeSdkModel('claude:glm')).toBe('claude-fable-5')
  })

  test('maps first-party Claude Code profiles to their SDK model ids', () => {
    expect(resolveClaudeSdkModel('claude:opus')).toBe('claude-opus-5')
    expect(resolveClaudeSdkModel('claude:fable')).toBe('claude-fable-5')
  })

  test('official (login) Claude models inject no ANTHROPIC_* env and are not API routes', () => {
    expect(claudeModelEnv('claude:fable')).toEqual({})
    expect(claudeModelEnv('claude:opus')).toEqual({})
    expect(claudeModelIsApiRoute('claude:fable')).toBe(false)
    expect(claudeModelIsApiRoute('claude:opus')).toBe(false)
  })

  test('Grok uses route-specific compatible effort and disables Claude adaptive thinking', () => {
    const prev = config.claude.models
    ;(config.claude as any).models = {
      grok: { model: 'grok-4.6', base_url: 'https://grok.example', auth_token: 't' },
      grokcc: { model: 'grok-4.6', base_url: 'https://catcodexapi.com', auth_token: 't' },
    }
    try {
      expect(claudeSdkReasoningOptions('claude:grok', 'max')).toEqual({
        effort: 'xhigh',
        thinking: { type: 'disabled' },
      })
      expect(claudeSdkReasoningOptions('claude:grokcc', 'max')).toEqual({
        effort: 'xhigh',
        thinking: { type: 'disabled' },
      })
      expect(claudeSdkReasoningOptions('claude:fable', 'max')).toEqual({ effort: 'max' })
    } finally {
      ;(config.claude as any).models = prev
    }
  })

  test('GLM is an API route that stays unconfigured until a token is set in lodestar config', () => {
    // 默认(无 config)→ GLM 是 api 路由但未配置,env 为空。
    expect(claudeModelIsApiRoute('claude:glm')).toBe(true)
    expect(claudeModelConfigured('claude:glm')).toBe(false)
    expect(claudeModelEnv('claude:glm')).toEqual({})
  })

  test('API route profile without an explicit model stays unconfigured', () => {
    // 只配了接入信息、忘了 model:sdkModel 会回落官方 claude-fable-5,
    // 拿官方 model id 打第三方端点必然失败/误路由 —— 必须挡在 configured 门槛。
    const prev = config.claude.models
    ;(config.claude as any).models = {
      glm: {
        base_url: 'https://open.bigmodel.cn/api/anthropic',
        auth_token: 'glm-secret-token',
      },
      // 非内建档位同样适用:任意第三方 relay 忘配 model 也一样拦。
      relay: {
        base_url: 'https://relay.example/api',
        auth_token: 'relay-token',
      },
    }
    try {
      expect(claudeModelConfigured('claude:glm')).toBe(false)
      expect(claudeModelConfigured('claude:relay')).toBe(false)
    } finally {
      ;(config.claude as any).models = prev
    }
  })

  test('a configured GLM profile injects base_url + auth_token as ANTHROPIC_* env', () => {
    const prev = config.claude.models
    ;(config.claude as any).models = {
      glm: {
        model: 'glm-4.6',
        base_url: 'https://open.bigmodel.cn/api/anthropic',
        auth_token: 'glm-secret-token',
      },
    }
    try {
      expect(claudeModelConfigured('claude:glm')).toBe(true)
      expect(resolveClaudeSdkModel('claude:glm')).toBe('glm-4.6')
      expect(claudeModelEnv('claude:glm')).toEqual({
        ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'glm-secret-token',
        // 所有 GSD/Task tier alias 都锁到当前选择的同一个真实模型。
        ANTHROPIC_DEFAULT_FABLE_MODEL: 'glm-4.6',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.6',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.6',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.6',
        // 1M 记账走模型名 [1m] 钉法,不再有默认窗口 env 注入。
      })
      // 官方模型仍然干净,GLM 的 token 不外泄到登录态档位。
      expect(claudeModelEnv('claude:opus')).toEqual({})
    } finally {
      ;(config.claude as any).models = prev
    }
  })

  test('claudeModelEffort: GLM 档位读 config 里的 effort;缺省/官方档位返回 undefined', () => {
    const prev = config.claude.models
    ;(config.claude as any).models = {
      glm: { model: 'glm-5.3', base_url: 'https://open.bigmodel.cn/api/anthropic', auth_token: 't', effort: 'xhigh' },
    }
    try {
      expect(claudeModelEffort('claude:glm')).toBe('xhigh')
      expect(claudeModelEffort('claude:opus')).toBeUndefined() // 官方档位不从 config 取 effort
    } finally {
      ;(config.claude as any).models = prev
    }
  })

  test('claudeModelEffort: 非法 effort 值被忽略(返回 undefined,回落固定值)', () => {
    const prev = config.claude.models
    ;(config.claude as any).models = {
      glm: { model: 'glm-5.3', base_url: 'https://x', auth_token: 't', effort: 'turbo' },
    }
    try {
      expect(claudeModelEffort('claude:glm')).toBeUndefined()
    } finally {
      ;(config.claude as any).models = prev
    }
  })

  test('maps claude profiles to SDK model alias', () => {
    const previousModels = config.claude.models
    config.claude.models = {
      custom: { model: ' sonnet ' },
      empty: {},
      'real-model': { model: 'haiku' },
      default: { model: 'haiku' },
    }
    try {
      expect(resolveClaudeSdkModel(null)).toBe('claude-fable-5')
      expect(resolveClaudeSdkModel('claude:default')).toBe('claude-fable-5')
      expect(resolveClaudeSdkModel('claude:glm')).toBe('claude-fable-5')
      expect(resolveClaudeSdkModel('claude:custom')).toBe('sonnet')
      expect(resolveClaudeSdkModel('claude:empty')).toBe('claude-fable-5')
      expect(resolveClaudeSdkModel('claude:unlisted')).toBe('unlisted')
      expect(resolveClaudeSdkModel('real-model')).toBe('real-model')
      expect(resolveClaudeSdkModel('GLM-5.2[1m]')).toBe('GLM-5.2[1m]')
      config.claude.models.glm = { model: 'custom-glm' }
      expect(resolveClaudeSdkModel('claude:glm')).toBe('custom-glm')
    } finally {
      config.claude.models = previousModels
    }
  })
})

describe('Claude configured executable ([claude] bin)', () => {
  test('wraps configured reclaude around the SDK-native custom spawn', () => {
    const bin = '/home/me/.local/bin/reclaude'
    const executable = resolveClaudeExecutableConfig({
      platform: 'linux',
      configuredBin: bin,
      exists: path => path === bin,
    })

    expect(executable.pathToClaudeCodeExecutable).toBeUndefined()
    expect(typeof executable.spawnClaudeCodeProcess).toBe('function')
    expect(executable.description).toBe(`config-reclaude-sdk-native:${bin}`)
  })

  test('reclaude custom spawn resolves claude from PATH to the SDK command', async () => {
    if (process.platform === 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'lodestar-reclaude-test-'))
    const wrapper = join(dir, 'reclaude')
    writeFileSync(wrapper, '#!/bin/sh\nreadlink "$(command -v claude)"\n')
    chmodSync(wrapper, 0o755)
    try {
      const executable = resolveClaudeExecutableConfig({
        platform: process.platform,
        configuredBin: wrapper,
        exists: path => path === wrapper,
      })
      const child = executable.spawnClaudeCodeProcess!({
        command: '/bin/echo',
        args: [],
        cwd: dir,
        env: { PATH: '/usr/bin:/bin' },
        signal: new AbortController().signal,
      } as any) as any
      let stdout = ''
      child.stdout.on('data', (chunk: Buffer) => { stdout += String(chunk) })
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (exitCode: number | null) => resolve(exitCode))
      })

      expect(code).toBe(0)
      expect(stdout.trim()).toBe('/bin/echo')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('throws instead of silently falling back when configured bin is missing', () => {
    expect(() => resolveClaudeExecutableConfig({
      platform: 'linux',
      configuredBin: '/nope/claude-wrapper',
      exists: () => false,
    })).toThrow('/nope/claude-wrapper')
  })

  test('runs configured Windows .cmd bin through the shell shim spawn hook', () => {
    const bin = win32.join('C:\\Users\\me\\bin', 'claude-wrapper.cmd')
    const executable = resolveClaudeExecutableConfig({
      platform: 'win32',
      configuredBin: bin,
      exists: path => path === bin,
    })

    expect(executable.pathToClaudeCodeExecutable).toBe(bin)
    expect(typeof executable.spawnClaudeCodeProcess).toBe('function')
    expect(executable.description).toBe(`windows-shell-shim:${bin}`)
  })

  test('explicit null configuredBin falls back to auto discovery', () => {
    const executable = resolveClaudeExecutableConfig({
      platform: 'win32',
      pathEnv: '',
      configuredBin: null,
      exists: () => false,
    })

    expect(executable).toEqual({ description: 'sdk-default' })
  })

  test('sendInitialize 配错 bin 路径时走 error/exit 事件而非同步抛出', () => {
    // [claude].bin 指向不存在的路径 → resolveClaudeExecutableConfig 同步抛出;
    // 修复确保该抛出在 sendInitialize 的 try/catch 内被捕获,转为事件输出,
    // 调用方不会收到同步异常,session 层可通过 error/exit 事件做正常清理。
    const previousBin = config.claude.bin
    ;(config.claude as any).bin = '/nope/claude-wrapper'
    try {
      const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' })
      const errors: Error[] = []
      const exits: any[] = []
      proc.on('error', (err: Error) => errors.push(err))
      proc.on('exit', (ev: any) => exits.push(ev))

      // 不能同步抛出
      expect(() => proc.sendInitialize()).not.toThrow()

      // error 事件携带路径信息
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toContain('/nope/claude-wrapper')

      // exit 事件 code=1
      expect(exits).toHaveLength(1)
      expect(exits[0].code).toBe(1)
    } finally {
      if (previousBin === undefined) delete (config.claude as any).bin
      else config.claude.bin = previousBin
    }
  })

  test('原生目录、额度和设置查询保留初始化失败的原始错误', async () => {
    // sendInitialize 因配错 bin 走 catch → this.query 保持 undefined。
    // 旧实现此时调 listModels/setModelSettings 会抛模糊的
    // "Cannot read properties of undefined (reading 'supportedModels')";
    // 保留初始化的原始路径错误，不能用泛化的 SDK 错误掩盖原因。
    const previousBin = config.claude.bin
    ;(config.claude as any).bin = '/nope/claude-wrapper'
    try {
      const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' })
      proc.sendInitialize() // 走 catch,this.query 仍 undefined

      await expect(proc.listModels()).rejects.toThrow('[claude].bin not found: /nope/claude-wrapper')
      await expect(proc.readSubscriptionUsage()).rejects.toThrow('[claude].bin not found: /nope/claude-wrapper')
      await expect(proc.setModelSettings('opus', 'high')).rejects.toThrow('[claude].bin not found: /nope/claude-wrapper')
    } finally {
      if (previousBin === undefined) delete (config.claude as any).bin
      else config.claude.bin = previousBin
    }
  })
})

describe('Claude permission mode', () => {
  test('runs Claude Code in default mode so canUseTool can intercept AskUserQuestion', () => {
    // bypassPermissions 会 shadow canUseTool(SDK CLAUDE_SDK_CAN_USE_TOOL_SHADOWED),
    // AskUserQuestion 被秒批空答案;改 default 后 canUseTool 才能拦下渲染卡片。
    expect(CLAUDE_PERMISSION_MODE).toBe('default')
  })
})

// ── 上游 ec149d7 主题 G:确定性退出路径 ─────────────────────────────
// AbortController + exitPromise + waitForExit + denyPendingPermissions;
// 硬停语义 = 被丢弃代的排队 turn 不得在 SDK abort 窗口内 drain。
describe('Claude shutdown reliability', () => {
  test('drops queued user inputs when the process is killed', async () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    proc.input.push({ type: 'user', message: { role: 'user', content: [] } })

    await proc.kill()

    await expect(proc.input.next()).resolves.toEqual({ value: undefined, done: true })
  })

  test('resolves pending SDK permissions with a legal deny on exit', async () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const ac = new AbortController()
    const permission = proc.canUseTool(
      'AskUserQuestion',
      { question: 'Continue?', options: ['Yes', 'No'] },
      { signal: ac.signal, toolUseID: 'dialog-stop-1' },
    )

    proc.finishExit(0, null)

    await expect(permission).resolves.toEqual({ behavior: 'deny', message: 'claude process exited' })
    expect(proc.pendingPermissions.size).toBe(0)
  })

  test('uses SDK close and abort, then waits for the read loop exit', async () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const exits: any[] = []
    let closeCalls = 0
    proc.started = true
    proc.query = {
      close: () => {
        closeCalls++
        queueMicrotask(() => proc.finishExit(null, null))
      },
    }
    proc.on('exit', (event: any) => exits.push(event))

    await expect(proc.kill(20)).resolves.toBeUndefined()

    expect(closeCalls).toBe(1)
    expect(proc.abortController.signal.aborted).toBe(true)
    expect(exits).toEqual([{ code: null, signal: null, expected: true }])
  })

  test('does not fabricate SIGKILL success when SDK close/abort never exits', async () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const exits: any[] = []
    proc.started = true
    proc.query = { close: () => {} }
    proc.on('exit', (event: any) => exits.push(event))

    await expect(proc.kill(5)).rejects.toThrow('did not exit within 5ms')

    expect(proc.abortController.signal.aborted).toBe(true)
    expect(proc.alive).toBe(true)
    expect(exits).toEqual([])
  })

  test('surfaces SDK close errors even when abort completes shutdown', async () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    proc.started = true
    proc.query = {
      close: () => {
        queueMicrotask(() => proc.finishExit(null, null))
        throw new Error('close exploded')
      },
    }

    await expect(proc.kill(20)).rejects.toThrow('SDK close failed: close exploded')
    expect(proc.alive).toBe(false)
  })
})

describe('Claude background task protocol validation', () => {
  test('does not turn an unknown terminal status into completed', () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const settled: any[] = []
    proc.on('bg_task_settled', (event: any) => settled.push(event))

    proc.handleMessage({
      type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'future_status',
    })
    expect(settled).toEqual([])

    proc.handleMessage({
      type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed',
    })
    expect(settled).toEqual([{ task_id: 'task-1', status: 'completed', tool_use_id: undefined, summary: undefined, usage: undefined }])
  })

  test('缺 task_id 的 task_notification 不发 bg_task_settled', () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const settled: any[] = []
    proc.on('bg_task_settled', (event: any) => settled.push(event))

    proc.handleMessage({ type: 'system', subtype: 'task_notification', status: 'completed' })

    expect(settled).toEqual([])
  })
})

describe('AskUserQuestion options 畸形输入解析', () => {
  // 上游 ec149d7 主题 G 的 firstString 多字段解析 —— 本地已在 post-state 行为
  // (label/value/text/title、description/detail/preview 依序取首个 string),
  // 此用例为行为锁定:畸形 option(数字/null/嵌套对象/缺 label)不炸、静默跳过。
  test('label/description 多字段 firstString,畸形项跳过不炸', async () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const requests: any[] = []
    proc.on('can_use_tool', (req: any) => requests.push(req))
    const ac = new AbortController()

    const permission = proc.canUseTool(
      'AskUserQuestion',
      {
        question: 'Pick one',
        options: [
          'plain-string',
          { value: 'from-value', detail: 'detail-as-description' },
          { title: 'from-title' },
          { label: 42, value: { nested: true } },
          null,
          7,
          { description: 'no label at all' },
        ],
      },
      { signal: ac.signal, toolUseID: 'dialog-parse-1' },
    )

    expect(requests).toHaveLength(1)
    const options = (requests[0].input as any).questions[0].options
    expect(options).toEqual([
      { label: 'plain-string' },
      { label: 'from-value', description: 'detail-as-description' },
      { label: 'from-title' },
    ])

    proc.sendPermissionResponse(requests[0].request_id, 'deny', { denyMessage: 'test done' })
    await expect(permission).resolves.toEqual({ behavior: 'deny', message: 'test done' })
  })
})

describe('Claude repeated tool failure correction hook', () => {
  test('injects corrective context on repeat two and resets after success', async () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const failureHook = proc.sdkToolFailureHooks.PostToolUseFailure[0].hooks[0]
    const successHook = proc.sdkToolFailureHooks.PostToolUse[0].hooks[0]
    const options = { signal: new AbortController().signal }
    const failure = {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/a.ts', old_string: 'x', new_string: 'x' },
      tool_use_id: 'edit-1',
      error: 'No changes to make',
    }

    expect(await failureHook(failure, 'edit-1', options)).toEqual({})
    const correction = await failureHook({ ...failure, tool_use_id: 'edit-2' }, 'edit-2', options)
    expect(correction.hookSpecificOutput).toMatchObject({
      hookEventName: 'PostToolUseFailure',
    })
    expect(correction.hookSpecificOutput.additionalContext).toContain('Do not retry it unchanged')

    await successHook({ hook_event_name: 'PostToolUse' }, 'bash-1', options)
    expect(await failureHook({ ...failure, tool_use_id: 'edit-3' }, 'edit-3', options)).toEqual({})
  })

  test('marks the third identical failure as host-stopped context', async () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const failureHook = proc.sdkToolFailureHooks.PostToolUseFailure[0].hooks[0]
    const options = { signal: new AbortController().signal }
    const input = {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/a.ts', old_string: 'x', new_string: 'x' },
      error: 'No changes to make',
    }

    await failureHook({ ...input, tool_use_id: 'edit-1' }, 'edit-1', options)
    await failureHook({ ...input, tool_use_id: 'edit-2' }, 'edit-2', options)
    const stopped = await failureHook({ ...input, tool_use_id: 'edit-3' }, 'edit-3', options)
    expect(stopped.hookSpecificOutput.additionalContext).toContain('circuit breaker is stopping this turn')
  })

  test('starts a fresh failure sequence when a new user turn is queued', async () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    proc.started = true
    const failureHook = proc.sdkToolFailureHooks.PostToolUseFailure[0].hooks[0]
    const options = { signal: new AbortController().signal }
    const failure = {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/a.ts', old_string: 'x', new_string: 'x' },
      error: 'No changes to make',
    }

    await failureHook({ ...failure, tool_use_id: 'edit-1' }, 'edit-1', options)
    const correction = await failureHook({ ...failure, tool_use_id: 'edit-2' }, 'edit-2', options)
    expect(correction.hookSpecificOutput.additionalContext).toContain('Do not retry it unchanged')

    expect(proc.sendUserText('next turn')).toEqual({ kind: 'queued', provider: 'claude' })
    expect(await failureHook({ ...failure, tool_use_id: 'edit-3' }, 'edit-3', options)).toEqual({})
  })
})

describe('Claude user dialog bridge', () => {
  test('emits only SDK meta string prompts as scheduled turn input', () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const scheduled: any[] = []
    proc.on('scheduled_turn_input', (event: any) => scheduled.push(event))

    proc.handleMessage({
      type: 'user',
      isMeta: true,
      promptSource: 'sdk',
      promptId: 'cron-prompt-1',
      permissionMode: 'default',
      message: { role: 'user', content: '【CrossEX 半小时运行巡检】检查服务并汇报。' },
    })
    // 手动用户消息由 Lodestar 自己的 input claim/card 负责，不是 scheduled。
    proc.handleMessage({
      type: 'user',
      isMeta: false,
      promptSource: 'sdk',
      promptId: 'manual-prompt',
      permissionMode: 'default',
      message: { role: 'user', content: [{ type: 'text', text: '手动检查一下' }] },
    })
    // Claude 图片结果也是 meta string，但不是 SDK prompt，不能误开定时卡。
    proc.handleMessage({
      type: 'user',
      isMeta: true,
      promptId: 'image-result',
      message: { role: 'user', content: '[Image: original 1440x2400]' },
    })

    expect(scheduled).toEqual([{
      text: '【CrossEX 半小时运行巡检】检查服务并汇报。',
      promptId: 'cron-prompt-1',
    }])
  })

  test('marks subagent assistant text with its parent and never promotes its UUID to the main checkpoint', () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const texts: any[] = []
    const stops: any[] = []
    proc.on('assistant_text', (event: any) => texts.push(event))
    proc.on('assistant_block_stop', (event: any) => stops.push(event))

    proc.handleMessage({
      type: 'assistant',
      uuid: 'assistant-child',
      parent_tool_use_id: 'task-main-1',
      message: {
        model: 'opus',
        content: [{ type: 'text', text: '子 Agent 的阶段性独白' }],
      },
    })

    expect(texts).toEqual([{
      uuid: 'assistant-child',
      text: '子 Agent 的阶段性独白',
      parentToolUseId: 'task-main-1',
    }])
    expect(stops).toEqual([{
      index: 'assistant-child',
      parentToolUseId: 'task-main-1',
    }])
    expect(proc.lastAssistantUuid).toBeNull()

    proc.handleMessage({
      type: 'assistant',
      uuid: 'assistant-main',
      message: {
        model: 'opus',
        content: [{ type: 'text', text: '主 Agent 正文' }],
      },
    })

    expect(texts.at(-1)).toEqual({
      uuid: 'assistant-main',
      text: '主 Agent 正文',
      parentToolUseId: null,
    })
    expect(stops.at(-1)).toEqual({
      index: 'assistant-main',
      parentToolUseId: null,
    })
    expect(proc.lastAssistantUuid).toBe('assistant-main')
  })

  test('uses session_state_changed running as turn start boundary', () => {
    const proc = new ClaudeAgentProcess({
      workDir: '/tmp',
      effort: 'high',
    }) as any
    const inits: any[] = []
    const started: any[] = []
    proc.on('init', (event: any) => inits.push(event))
    proc.on('turn_started', (event: any) => started.push(event))

    proc.handleMessage({
      type: 'system',
      subtype: 'init',
      uuid: 'init-1',
      session_id: 'claude-session-1',
      model: 'sonnet',
    })
    expect(inits).toHaveLength(1)
    expect(started).toEqual([])

    proc.handleMessage({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'running',
      uuid: 'turn-1',
      session_id: 'claude-session-1',
    })
    proc.handleMessage({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'requires_action',
      uuid: 'turn-1-permission',
      session_id: 'claude-session-1',
    })
    proc.handleMessage({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'running',
      uuid: 'turn-1-resumed',
      session_id: 'claude-session-1',
    })
    expect(started).toEqual([{ turn_id: 'turn-1', thread_id: 'claude-session-1' }])

    proc.handleMessage({
      type: 'result',
      subtype: 'success',
      uuid: 'result-1',
      session_id: 'claude-session-1',
      is_error: false,
      duration_ms: 10,
      num_turns: 1,
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {},
    })
    proc.handleMessage({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'running',
      uuid: 'turn-2',
      session_id: 'claude-session-1',
    })
    expect(started).toEqual([
      { turn_id: 'turn-1', thread_id: 'claude-session-1' },
      { turn_id: 'turn-2', thread_id: 'claude-session-1' },
    ])
  })

  test('emits a turn-local Claude checkpoint and clears it at the next turn boundary', () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const results: any[] = []
    proc.on('result', (event: any) => results.push(event))
    proc.handleMessage({
      type: 'system', subtype: 'session_state_changed', state: 'running',
      uuid: 'turn-1', session_id: 'claude-session-1',
    })
    proc.handleMessage({
      type: 'assistant', uuid: 'assistant-1',
      message: { model: 'opus', content: [{ type: 'text', text: 'done' }] },
    })
    proc.handleMessage({
      type: 'result', subtype: 'success', session_id: 'claude-session-1',
      is_error: false, duration_ms: 1, usage: {}, modelUsage: {},
    })
    expect(results[0].checkpoint).toEqual({
      provider: 'claude', kind: 'assistant-message', id: 'assistant-1',
      source: { provider: 'claude', sessionId: 'claude-session-1', cwd: '/tmp' },
    })

    proc.handleMessage({
      type: 'system', subtype: 'session_state_changed', state: 'running',
      uuid: 'turn-2', session_id: 'claude-session-1',
    })
    expect(proc.lastAssistantUuid).toBeNull()
    proc.handleMessage({
      type: 'result', subtype: 'error', session_id: 'claude-session-1',
      is_error: true, duration_ms: 1, usage: {}, modelUsage: {},
    })
    expect(results[1].checkpoint).toBeNull()
  })

  test('routes AskUserQuestion through canUseTool permission flow', async () => {
    const proc = new ClaudeAgentProcess({
      workDir: '/tmp',
      effort: 'high',
    }) as any
    const toolUses: any[] = []
    const permissions: any[] = []
    proc.on('tool_use', (event: any) => toolUses.push(event))
    proc.on('can_use_tool', (event: any) => {
      permissions.push(event)
      proc.sendPermissionResponse(event.request_id, 'allow', {
        updatedInput: {
          ...event.input,
          answers: { 'Pick one?': 'A' },
        },
      })
    })

    const abortController = new AbortController()
    const resultPromise = proc.canUseTool(
      'AskUserQuestion',
      { question: 'Pick one?', options: ['A', 'B'] },
      { signal: abortController.signal, toolUseID: 'tool_dialog_1' },
    )

    expect(toolUses).toEqual([{
      id: 'tool_dialog_1',
      name: 'AskUserQuestion',
      input: {
        question: 'Pick one?',
        options: ['A', 'B'],
        questions: [{
          question: 'Pick one?',
          options: [{ label: 'A' }, { label: 'B' }],
        }],
      },
      parentToolUseId: null,
    }])
    expect(permissions).toHaveLength(1)
    expect(permissions[0].tool_name).toBe('AskUserQuestion')
    expect(permissions[0].tool_use_id).toBe('tool_dialog_1')

    await expect(resultPromise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: {
        question: 'Pick one?',
        options: ['A', 'B'],
        questions: [{
          question: 'Pick one?',
          options: [{ label: 'A' }, { label: 'B' }],
        }],
        answers: { 'Pick one?': 'A' },
      },
    })
  })

  test('canUseTool auto-allows non-AskUserQuestion tools (replicates bypass)', async () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const toolUses: any[] = []
    const permissions: any[] = []
    proc.on('tool_use', (event: any) => toolUses.push(event))
    proc.on('can_use_tool', (event: any) => permissions.push(event))
    const ac = new AbortController()
    const result = await proc.canUseTool(
      'Bash',
      { command: 'echo hi' },
      { signal: ac.signal, toolUseID: 'call_bash_1' },
    )
    // allow 分支 updatedInput 运行时必填(SDK Zod),回传原 input=不改
    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'echo hi' } })
    // 非 AskUserQuestion 不走卡片机器:不发 tool_use、不发 can_use_tool
    expect(toolUses).toEqual([])
    expect(permissions).toEqual([])
  })

  test('bridges provider server tools and suppresses scaffold text', () => {
    const proc = new ClaudeAgentProcess({
      workDir: '/tmp',
      effort: 'high',
    }) as any
    const events: Array<[string, any]> = []
    proc.on('assistant_text', (event: any) => events.push(['assistant_text', event]))
    proc.on('tool_use', (event: any) => events.push(['tool_use', event]))
    proc.on('tool_result', (event: any) => events.push(['tool_result', event]))

    proc.handleMessage({
      type: 'assistant',
      uuid: 'assistant-intro',
      message: {
        model: 'opus',
        content: [{ type: 'text', text: '我用视觉分析工具来看这两张图。' }],
      },
    })
    proc.handleMessage({
      type: 'assistant',
      uuid: 'assistant-server-tool-scaffold',
      message: {
        model: 'opus',
        content: [{
          type: 'text',
          text: '**🌐 Z.ai Built-in Tool: analyze_image**\n\n**Input:**\n```json\n{"imageSource":"https://signed.example/img","prompt":"识别截图内容"}\n```',
        }],
      },
    })
    proc.handleMessage({
      type: 'assistant',
      uuid: 'assistant-server-tool-use',
      message: {
        model: 'opus',
        content: [{
          type: 'server_tool_use',
          id: 'call_image_1',
          name: 'analyze_image',
          input: {},
        }],
      },
    })
    proc.handleMessage({
      type: 'assistant',
      uuid: 'assistant-server-tool-output-scaffold',
      message: {
        model: 'opus',
        content: [{
          type: 'text',
          text: '**Output:**\n**analyze_image_result_summary:** [{"text":"完整识图结果"}]',
        }],
      },
    })
    proc.handleMessage({
      type: 'assistant',
      uuid: 'assistant-server-tool-result',
      message: {
        model: 'opus',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_image_1',
          content: '["完整识图结果"]',
        }],
      },
    })

    expect(events).toEqual([
      ['assistant_text', {
        uuid: 'assistant-intro',
        text: '我用视觉分析工具来看这两张图。',
        parentToolUseId: null,
      }],
      ['tool_use', {
        id: 'call_image_1',
        name: 'server_tool:analyze_image',
        input: {
          tool: 'analyze_image',
          input: {
            imageSource: 'https://signed.example/img',
            prompt: '识别截图内容',
          },
        },
        parentToolUseId: null,
      }],
      ['tool_result', {
        tool_use_id: 'call_image_1',
        content: '完整识图结果',
        is_error: false,
        parentToolUseId: null,
      }],
    ])
  })
})

describe('Claude model refusal message handling', () => {
  test('emits model_refusal_fallback with scope passed through', () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const events: any[] = []
    proc.on('model_refusal_fallback', (e: any) => events.push(e))

    proc.handleMessage({
      type: 'system',
      subtype: 'model_refusal_fallback',
      trigger: 'refusal',
      direction: 'retry',
      original_model: 'claude-sonnet-4-5',
      fallback_model: 'claude-haiku-4-5',
      request_id: 'req-fb-1',
      scope: 'session',
      content: 'refused',
      uuid: 'rfu-1',
      session_id: 'claude-session-1',
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      original_model: 'claude-sonnet-4-5',
      fallback_model: 'claude-haiku-4-5',
      direction: 'retry',
      scope: 'session',
    })

    // scope 缺省(老 CLI)归一化为 'session'
    proc.handleMessage({
      type: 'system',
      subtype: 'model_refusal_fallback',
      trigger: 'refusal',
      direction: 'retry',
      original_model: 's',
      fallback_model: 'h',
      request_id: 'r2',
      content: 'x',
      uuid: 'u2',
      session_id: 'claude-session-1',
    })
    expect(events[1].scope).toBe('session')

    // local scope 透传
    proc.handleMessage({
      type: 'system',
      subtype: 'model_refusal_fallback',
      trigger: 'refusal',
      direction: 'retry',
      original_model: 's',
      fallback_model: 'h',
      request_id: 'r3',
      scope: 'local',
      content: 'x',
      uuid: 'u3',
      session_id: 'claude-session-1',
    })
    expect(events[2].scope).toBe('local')
  })

  test('drops legacy non-retry direction values', () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const events: any[] = []
    proc.on('model_refusal_fallback', (e: any) => events.push(e))

    proc.handleMessage({
      type: 'system',
      subtype: 'model_refusal_fallback',
      trigger: 'refusal',
      direction: 'revert',
      original_model: 's',
      fallback_model: 'h',
      request_id: 'r',
      scope: 'session',
      content: 'x',
      uuid: 'u',
      session_id: 'claude-session-1',
    })
    expect(events).toHaveLength(0)
  })

  test('emits model_refusal_no_fallback with category passed through', () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const events: any[] = []
    proc.on('model_refusal_no_fallback', (e: any) => events.push(e))

    proc.handleMessage({
      type: 'system',
      subtype: 'model_refusal_no_fallback',
      original_model: 'claude-sonnet-4-5',
      request_id: 'req-nf-1',
      api_refusal_category: 'cyber',
      api_refusal_explanation: 'blocked',
      content: 'refused',
      uuid: 'rfu-nf-1',
      session_id: 'claude-session-1',
    })
    expect(events).toHaveLength(1)
    expect(events[0].original_model).toBe('claude-sonnet-4-5')
    expect(events[0].api_refusal_category).toBe('cyber')
    expect(events[0].api_refusal_explanation).toBe('blocked')
  })
})

describe('Claude compactThread (/compact slash command)', () => {
  // 终态语义(上游 3e0468a→f8940bd→3b0ee26 叠加):push /compact 后死等四事件,无 timeout。
  const makeCompactProc = () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    proc.alive = true
    proc.started = true
    const pushed: any[] = []
    proc.input = { push: (m: any) => { pushed.push(m) } }
    return { proc, pushed }
  }

  // 场景③:boundary 先到 → resolve(同时钉住 /compact 消息形状)
  test('pushes /compact and resolves when context_compacted arrives first', async () => {
    const { proc, pushed } = makeCompactProc()
    const p = proc.compactThread()
    expect(pushed).toHaveLength(1)
    expect(pushed[0].type).toBe('user')
    expect(pushed[0].message.content[0].text).toBe('/compact')
    expect(pushed[0].priority).toBe('now')
    proc.emit('context_compacted', { phase: 'event', sourceType: 'compact_boundary' })
    await expect(p).resolves.toBeUndefined()
  })

  // 场景①:"Not enough messages to compact"(claude code CLI 固定文案)→ NothingToCompactError
  test('rejects NothingToCompactError on "Not enough messages to compact" assistant text', async () => {
    const { proc } = makeCompactProc()
    const p = proc.compactThread()
    proc.emit('assistant_text', { uuid: 'u1', text: 'Not enough messages to compact.' })
    await expect(p).rejects.toBeInstanceOf(NothingToCompactError)
  })

  // 场景②(本次移植的存在理由):大上下文慢压缩时 boundary 晚于 result 到达,
  // 不得误判为"无需压缩"—— result 与普通 assistant 文本都不 settle,死等 boundary 后 resolve。
  test('boundary arriving after result still resolves (no false NothingToCompact)', async () => {
    const { proc } = makeCompactProc()
    const p = proc.compactThread()
    let settledEarly = false
    p.then(() => { settledEarly = true }, () => { settledEarly = true })
    proc.emit('result', { subtype: 'success', is_error: false })
    proc.emit('assistant_text', { uuid: 'u2', text: '压缩进行中的普通总结文本' })
    await new Promise(r => setTimeout(r, 20))
    expect(settledEarly).toBe(false)
    proc.emit('context_compacted', { phase: 'event', sourceType: 'compact_boundary' })
    await expect(p).resolves.toBeUndefined()
  })

  // 场景④:proc exit → reject(死等的唯一硬兜底;error 同理)
  test('rejects when the proc exits during /compact', async () => {
    const { proc } = makeCompactProc()
    const p = proc.compactThread()
    proc.emit('exit', { code: 1, signal: null, expected: false })
    await expect(p).rejects.toThrow(/exited during \/compact/)
  })

  test('rejects when the proc errors during /compact', async () => {
    const { proc } = makeCompactProc()
    const p = proc.compactThread()
    proc.emit('error', new Error('sdk boom'))
    await expect(p).rejects.toThrow('sdk boom')
  })

  test('rejects when the process is not running', async () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    proc.alive = false
    await expect(proc.compactThread()).rejects.toThrow(/not running/)
  })
})

describe('Claude token accounting', () => {
  test('accumulates per-result usage when modelUsage totals are absent', () => {
    const proc = new ClaudeAgentProcess({
      workDir: '/tmp',
      effort: 'high',
    }) as any
    const usageEvents: any[] = []
    proc.on('token_usage', (event: any) => usageEvents.push(event))

    proc.handleMessage({
      type: 'result',
      subtype: 'success',
      uuid: 'result-1',
      session_id: 'claude-session-1',
      is_error: false,
      duration_ms: 10,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 2 },
      modelUsage: {},
    })
    proc.handleMessage({
      type: 'result',
      subtype: 'success',
      uuid: 'result-2',
      session_id: 'claude-session-1',
      is_error: false,
      duration_ms: 12,
      num_turns: 1,
      usage: {
        input_tokens: 7,
        output_tokens: 1,
        cache_creation_input_tokens: 1,
        cache_read_input_tokens: 3,
      },
      modelUsage: {},
    })

    expect(usageEvents).toHaveLength(2)
    expect(usageEvents[0].usage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
    })
    expect(usageEvents[0].totalUsage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
    })
    expect(usageEvents[1].usage).toEqual({
      input_tokens: 7,
      output_tokens: 1,
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 3,
      total_tokens: 12,
    })
    expect(usageEvents[1].totalUsage).toEqual({
      input_tokens: 17,
      output_tokens: 3,
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 3,
      total_tokens: 24,
    })
    expect(proc.lastTotalUsage).toEqual(usageEvents[1].totalUsage)
  })

  test('parses camelCase per-result usage fields', () => {
    const proc = new ClaudeAgentProcess({
      workDir: '/tmp',
      effort: 'high',
    }) as any
    const usageEvents: any[] = []
    proc.on('token_usage', (event: any) => usageEvents.push(event))

    proc.handleMessage({
      type: 'result',
      subtype: 'success',
      uuid: 'result-camel-usage',
      session_id: 'claude-session-1',
      is_error: false,
      duration_ms: 10,
      num_turns: 1,
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        cacheCreationInputTokens: 1,
        cacheReadInputTokens: 3,
      },
      modelUsage: {},
    })

    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0].usage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 3,
      total_tokens: 16,
    })
    expect(usageEvents[0].totalUsage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 3,
      total_tokens: 16,
    })
  })

  test('uses modelUsage as authoritative cumulative totals when present', () => {
    const proc = new ClaudeAgentProcess({
      workDir: '/tmp',
      effort: 'high',
    }) as any
    const usageEvents: any[] = []
    proc.on('token_usage', (event: any) => usageEvents.push(event))

    proc.handleMessage({
      type: 'result',
      subtype: 'success',
      uuid: 'result-1',
      session_id: 'claude-session-1',
      is_error: false,
      duration_ms: 10,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 2 },
      modelUsage: {
        opus: {
          inputTokens: 100,
          outputTokens: 20,
          cacheCreationInputTokens: 5,
          cacheReadInputTokens: 30,
          contextWindow: 200000,
          costUSD: 0.25,
        },
      },
    })
    expect(proc.lastResult.cost_usd).toBeNull()
    expect(proc.lastResult.cost_delta_usd).toBeNull()
    proc.handleMessage({
      type: 'result',
      subtype: 'success',
      uuid: 'result-2',
      session_id: 'claude-session-1',
      is_error: false,
      duration_ms: 12,
      num_turns: 1,
      usage: { input_tokens: 4, output_tokens: 1 },
      modelUsage: {
        glm: {
          input_tokens: 130,
          output_tokens: 25,
          cache_creation_input_tokens: 8,
          cache_read_input_tokens: 40,
          context_window: 258000,
          cost_usd: 0.31,
        },
      },
    })

    expect(usageEvents[0].usage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
    })
    expect(usageEvents[0].totalUsage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      reasoning_output_tokens: 0,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 30,
      total_tokens: 155,
    })
    expect(usageEvents[0].contextWindow).toBe(200000)

    expect(usageEvents[1].usage).toEqual({
      input_tokens: 4,
      output_tokens: 1,
      total_tokens: 5,
    })
    expect(usageEvents[1].totalUsage).toEqual({
      input_tokens: 130,
      output_tokens: 25,
      reasoning_output_tokens: 0,
      cache_creation_input_tokens: 8,
      cache_read_input_tokens: 40,
      total_tokens: 203,
    })
    expect(usageEvents[1].contextWindow).toBe(258000)
    // 占用从 transcript 读 per-call usage,test 环境无 transcript → null(MISS)。
    // (result.usage 是 turn 聚合、modelUsage 是 session 累计,都不代表当前上下文)
    expect(proc.lastContextTokens).toBeNull()
    expect(proc.lastResult.cost_usd).toBeNull()
    expect(proc.lastResult.cost_delta_usd).toBeNull()
  })

  test('uses model_usage alias as authoritative cumulative totals when present', () => {
    const proc = new ClaudeAgentProcess({
      workDir: '/tmp',
      effort: 'high',
    }) as any
    const usageEvents: any[] = []
    proc.on('token_usage', (event: any) => usageEvents.push(event))

    proc.handleMessage({
      type: 'result',
      subtype: 'success',
      uuid: 'result-snake-model-usage',
      session_id: 'claude-session-1',
      is_error: false,
      duration_ms: 10,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 2 },
      model_usage: {
        opus: {
          inputTokens: 100,
          outputTokens: 20,
          cacheCreationInputTokens: 5,
          cacheReadInputTokens: 30,
          contextWindow: 200000,
          costUSD: 0.25,
        },
      },
    })

    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0].usage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
    })
    expect(usageEvents[0].totalUsage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      reasoning_output_tokens: 0,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 30,
      total_tokens: 155,
    })
    expect(usageEvents[0].contextWindow).toBe(200000)
    expect(proc.lastResult.cost_usd).toBeNull()
    expect(proc.lastResult.cost_delta_usd).toBeNull()
  })

  test('single SDK context-window report becomes the locked denominator', () => {
    // 优先采用 SDK 当前明确上报的窗口。
    const proc = new ClaudeAgentProcess({
      workDir: '/tmp',
      effort: 'high',
      model: 'claude:glm',
    }) as any
    const usageEvents: any[] = []
    proc.on('token_usage', (event: any) => usageEvents.push(event))

    proc.handleMessage({
      type: 'result',
      subtype: 'success',
      uuid: 'result-glm-sdk-window',
      session_id: 'claude-session-1',
      is_error: false,
      duration_ms: 10,
      num_turns: 1,
      usage: { input_tokens: 87_000, output_tokens: 700 },
      modelUsage: {
        opus: {
          inputTokens: 87_000,
          outputTokens: 700,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          contextWindow: 100_000,
        },
      },
    })

    expect(usageEvents).toHaveLength(1)
    // SDK 实测 100K 优先于 profile 声明的 1M
    expect(usageEvents[0].contextWindow).toBe(100_000)
    expect(proc.lastContextWindow).toBe(100_000)
    // 占用从 transcript 读 per-call usage,test 无 transcript → null
    expect(proc.lastContextTokens).toBeNull()
  })

  test('context window follows fresh reports even when capacity decreases', () => {
    // 新上报的窗口无论变大还是变小，都不能被历史缓存覆盖。
    const proc = new ClaudeAgentProcess({
      workDir: '/tmp',
      effort: 'high',
      model: 'claude:glm',
    }) as any
    const events: any[] = []
    proc.on('token_usage', (e: any) => events.push(e))

    const result = (ctx: number) => proc.handleMessage({
      type: 'result',
      subtype: 'success',
      uuid: `r-${ctx}`,
      session_id: 'claude-session-1',
      is_error: false,
      duration_ms: 1,
      num_turns: 1,
      usage: { input_tokens: 1000, output_tokens: 10 },
      modelUsage: { opus: { inputTokens: 1000, outputTokens: 10, contextWindow: ctx } },
    })

    result(200_000)
    expect(events).toHaveLength(1)
    expect(proc.lastContextWindow).toBe(200_000)
    expect(events[0].contextWindow).toBe(200_000)
    result(1_000_000)
    expect(proc.lastContextWindow).toBe(1_000_000) // 升到真实窗口
    expect(events[1].contextWindow).toBe(1_000_000)
    result(200_000)
    expect(proc.lastContextWindow).toBe(200_000)
    expect(events[2].contextWindow).toBe(200_000)
    result(258_000)
    expect(proc.lastContextWindow).toBe(258_000)
  })

  test('1214 错误触发路由降级:仅 [1m] 路由生效,分母回 200K 锁死并发一次事件', () => {
    // 降级只对 resolved model 带 [1m] 的路由生效 → 用例需配 [1m] 档。
    const prevGlm = config.claude.models.glm
    ;(config.claude as any).models.glm = {
      model: 'glm-5.3[1m]',
      base_url: 'https://open.bigmodel.cn/api/anthropic',
      auth_token: 'glm-tok',
    }
    try {
      const proc = new ClaudeAgentProcess({
        workDir: '/tmp', effort: 'high', model: 'claude:glm',
      }) as any
      const degradedEvents: any[] = []
      proc.on('context_window_degraded', (e: any) => degradedEvents.push(e))
      const okResult = (uuid: string) => proc.handleMessage({
        type: 'result', subtype: 'success', uuid, session_id: 's-deg',
        is_error: false, duration_ms: 1, num_turns: 1,
        usage: { input_tokens: 1000, output_tokens: 10 },
        modelUsage: { opus: { inputTokens: 1000, outputTokens: 10, contextWindow: 1_000_000 } },
      })
      okResult('r-deg-1') // 正常轮:1M 记账
      expect(proc.lastContextWindow).toBe(1_000_000)
      // bigmodel 1214 真实错误体(2026-08-17 直连实测原文)命中降级正则([1214]/"code":"1214")
      const err1214 = 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","code":"1214","message":"[1214][modelCode：不存在][20260818022410ac860c924280487f]"},"request_id":"20260818022410ac860c924280487f"}'
      proc.handleMessage({
        type: 'result', subtype: 'error_during_execution', uuid: 'r-deg-2', session_id: 's-deg',
        is_error: true, duration_ms: 1, num_turns: 1, result: err1214,
      })
      expect(proc.lastContextWindow).toBe(200_000) // 降级立即生效
      okResult('r-deg-3') // CLI 对 [1m] 名仍报 1M 记账也不再上调(防振荡)
      expect(proc.lastContextWindow).toBe(200_000)
      // 用户可见事件只发一次(首次置位)
      proc.handleMessage({
        type: 'result', subtype: 'error_during_execution', uuid: 'r-deg-4', session_id: 's-deg',
        is_error: true, duration_ms: 1, num_turns: 1, result: err1214,
      })
      expect(degradedEvents).toHaveLength(1)
      // 路由 key 带来源前缀:本用例未传 tokenSourceId → 'no-source:claude:glm'。
      expect(degradedEvents[0]).toEqual({
        routeKey: 'no-source:claude:glm', model: 'glm-5.3[1m]', contextWindow: 200_000,
      })
    } finally {
      ;(config.claude as any).models.glm = prevGlm
    }
  })

  test('通用爆窗文本(prompt is too long)同样触发 [1m] 路由降级', () => {
    const prevGlm = config.claude.models.glm
    ;(config.claude as any).models.glm = {
      model: 'glm-5.3[1m]',
      base_url: 'https://open.bigmodel.cn/api/anthropic',
      auth_token: 'glm-tok',
    }
    try {
      const proc = new ClaudeAgentProcess({
        workDir: '/tmp', effort: 'high', model: 'claude:glm',
      }) as any
      proc.handleMessage({
        type: 'result', subtype: 'error_during_execution', uuid: 'r-deg-g1', session_id: 's-g',
        is_error: true, duration_ms: 1, num_turns: 1,
        result: 'API Error: 400 prompt is too long: 1048576 tokens > 200000 maximum',
      })
      proc.handleMessage({
        type: 'result', subtype: 'success', uuid: 'r-deg-g2', session_id: 's-g',
        is_error: false, duration_ms: 1, num_turns: 1,
        usage: { input_tokens: 1000, output_tokens: 10 },
        modelUsage: { opus: { inputTokens: 1000, outputTokens: 10, contextWindow: 1_000_000 } },
      })
      expect(proc.lastContextWindow).toBe(200_000) // 降级先行,后续 1M 观测被锁
    } finally {
      ;(config.claude as any).models.glm = prevGlm
    }
  })

  test('非 [1m] 路由不触发降级(裸名分母本就是端点真实窗口)', () => {
    const prevGlm = config.claude.models.glm
    ;(config.claude as any).models.glm = {
      model: 'glm-5.3', // 显式裸名档
      base_url: 'https://open.bigmodel.cn/api/anthropic',
      auth_token: 'glm-tok',
    }
    try {
      const proc = new ClaudeAgentProcess({
        workDir: '/tmp', effort: 'high', model: 'claude:glm',
      }) as any
      proc.handleMessage({
        type: 'result', subtype: 'success', uuid: 'r-nd-1', session_id: 's-nd',
        is_error: false, duration_ms: 1, num_turns: 1,
        usage: { input_tokens: 1000, output_tokens: 10 },
        modelUsage: { opus: { inputTokens: 1000, outputTokens: 10, contextWindow: 1_000_000 } },
      })
      proc.handleMessage({
        type: 'result', subtype: 'error_during_execution', uuid: 'r-nd-2', session_id: 's-nd',
        is_error: true, duration_ms: 1, num_turns: 1,
        result: 'API Error: 400 prompt is too long: 1048576 tokens > 200000 maximum',
      })
      expect(proc.lastContextWindow).toBe(1_000_000) // 未降级,观测 max 保持
    } finally {
      ;(config.claude as any).models.glm = prevGlm
    }
  })

  test('fresh context windows update their route without crossing sources', () => {
    // 同路由新的 SDK 上报可更新缓存，不同来源与路由仍然隔离。
    const proc1 = new ClaudeAgentProcess({
      workDir: '/tmp', effort: 'high', model: 'claude:glm', tokenSourceId: 'glm',
    }) as any
    proc1.handleMessage({
      type: 'result', subtype: 'success', uuid: 'r-global-1', session_id: 's1',
      is_error: false, duration_ms: 1, num_turns: 1,
      usage: { input_tokens: 1000, output_tokens: 10 },
      modelUsage: { opus: { inputTokens: 1000, outputTokens: 10, contextWindow: 1_000_000 } },
    })
    expect(proc1.lastContextWindow).toBe(1_000_000)

    // 同路由的新实例收到更小的明确数值，应采用该值。
    const proc2 = new ClaudeAgentProcess({
      workDir: '/tmp', effort: 'high', model: 'claude:glm', tokenSourceId: 'glm',
    }) as any
    proc2.handleMessage({
      type: 'result', subtype: 'success', uuid: 'r-global-2', session_id: 's2',
      is_error: false, duration_ms: 1, num_turns: 1,
      usage: { input_tokens: 1000, output_tokens: 10 },
      modelUsage: { opus: { inputTokens: 1000, outputTokens: 10, contextWindow: 200_000 } },
    })
    expect(proc2.lastContextWindow).toBe(200_000)

    // 不同路由不串扰:default 路由的探测独立于 glm 路由
    const proc3 = new ClaudeAgentProcess({
      workDir: '/tmp', effort: 'high', model: 'claude:default',
    }) as any
    proc3.handleMessage({
      type: 'result', subtype: 'success', uuid: 'r-global-3', session_id: 's3',
      is_error: false, duration_ms: 1, num_turns: 1,
      usage: { input_tokens: 1000, output_tokens: 10 },
      modelUsage: { opus: { inputTokens: 1000, outputTokens: 10, contextWindow: 200_000 } },
    })
    expect(proc3.lastContextWindow).toBe(200_000) // default 路由独立, 200K

    const proc4 = new ClaudeAgentProcess({
      workDir: '/tmp', effort: 'high', model: 'claude:glm', tokenSourceId: 'deepseek',
    }) as any
    proc4.handleMessage({
      type: 'result', subtype: 'success', uuid: 'r-global-4', session_id: 's4',
      is_error: false, duration_ms: 1, num_turns: 1,
      usage: { input_tokens: 1000, output_tokens: 10 },
      modelUsage: { opus: { inputTokens: 1000, outputTokens: 10, contextWindow: 200_000 } },
    })
    expect(proc4.lastContextWindow).toBe(200_000) // 同 model slug、不同 source 不串扰
  })

  test('context errors preserve the observed window and expose the actual SDK error list', async () => {
    const { observedContextWindow } = await import('./context-window-observe')
    const proc = new ClaudeAgentProcess({
      workDir: '/tmp', effort: 'high', model: 'audit-window[1m]', tokenSourceId: 'audit-window-source',
    }) as any
    const results: any[] = []
    proc.on('result', (result: any) => results.push(result))
    proc.handleMessage({
      type: 'result', subtype: 'success', session_id: 'window-session', is_error: false,
      modelUsage: { 'audit-window[1m]': { inputTokens: 100, outputTokens: 10, contextWindow: 1_000_000 } },
    })
    proc.handleMessage({
      type: 'result', subtype: 'error_during_execution', session_id: 'window-session', is_error: true,
      result: 'prompt is too long', errors: ['Request exceeds the context window', 'Reduce this request'],
      modelUsage: {},
    })
    expect(observedContextWindow('audit-window-source', 'audit-window')).toBe(1_000_000)
    expect(proc.opts.model).toBe('audit-window[1m]')
    expect(results.at(-1)).toMatchObject({
      is_error: true, error: 'Request exceeds the context window\nReduce this request',
    })
  })

  test('context window stays null when SDK does not report one', () => {
    // SDK 没上报 contextWindow → null,不为它兜底假窗口(no fallback)。
    const proc = new ClaudeAgentProcess({
      workDir: '/tmp',
      effort: 'high',
      model: 'claude:glm',
    }) as any
    const usageEvents: any[] = []
    proc.on('token_usage', (event: any) => usageEvents.push(event))

    proc.handleMessage({
      type: 'result',
      subtype: 'success',
      uuid: 'result-glm-no-sdk-window',
      session_id: 'claude-session-1',
      is_error: false,
      duration_ms: 10,
      num_turns: 1,
      usage: { input_tokens: 87_000, output_tokens: 700 },
      modelUsage: {
        opus: {
          inputTokens: 87_000,
          outputTokens: 700,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      },
    })

    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0].contextWindow).toBeNull()
    expect(proc.lastContextWindow).toBeNull()
  })
})

describe('Claude transcript context tokens', () => {
  test('claudeTranscriptPath encodes cwd slashes to dashes', () => {
    const p = claudeTranscriptPath('/home/leviyuan/feishu', 'sid-1')
    expect(p.endsWith('projects/-home-leviyuan-feishu/sid-1.jsonl')).toBe(true)
  })

  test('claudeTranscriptPath encodes all non-alphanumeric chars to dashes (对齐 SDK)', () => {
    // SDK 编码不只替换 /:[ ] . _ 等非字母数字字符全部 → -。否则 cwd 含特殊字符
    // (如 test[deepseek])时本函数算出的目录与 SDK 实际写入目录不一致 → 恒读不到。
    const p = claudeTranscriptPath('/tmp/test[deepseek]_v0.14', 'sid-2')
    expect(p.endsWith('projects/-tmp-test-deepseek--v0-14/sid-2.jsonl')).toBe(true)
  })

  test('readLastCallUsageFromTranscript skips synthetic placeholder rows', () => {
    // SDK 对部分 turn 写 synthetic 占位(model='<synthetic>' usage 全 0,非真实 API
    // call);跳过后取到最后一条真实 usage,修 DeepSeek 首轮 footer 无用量数据。
    const tmp = join(tmpdir(), `lodestar-syn-${Date.now()}.jsonl`)
    writeFileSync(tmp, [
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 30, cache_read_input_tokens: 41728, cache_creation_input_tokens: 0 } } }),
      JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } } }),
      JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } } }),
    ].join('\n'))
    expect(readLastCallUsageFromTranscript(tmp)).toEqual({ input_tokens: 30, cache_read_input_tokens: 41728, cache_creation_input_tokens: 0 })
    unlinkSync(tmp)
  })

  test('readLastCallUsageFromTranscript returns null when transcript is all synthetic', () => {
    // 全 synthetic → null(调用点见文件存在才 fallback result.usage;不假数据)
    const tmp = join(tmpdir(), `lodestar-syn-all-${Date.now()}.jsonl`)
    writeFileSync(tmp, [
      JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } } }),
    ].join('\n'))
    expect(readLastCallUsageFromTranscript(tmp)).toBeNull()
    unlinkSync(tmp)
  })

  test('readLastCallUsageFromTranscript returns the last assistant per-call usage', () => {
    const tmp = join(tmpdir(), `lodestar-t-${Date.now()}.jsonl`)
    writeFileSync(tmp, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 } } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 30, cache_read_input_tokens: 41728, cache_creation_input_tokens: 0 } } }),
    ].join('\n'))
    // 取最后一条 assistant 的 per-call usage(transcript finalize 后的真实值,
    // = session 当前上下文,与 Claude Code 底栏 context 占用同口径)
    expect(readLastCallUsageFromTranscript(tmp)).toEqual({ input_tokens: 30, cache_read_input_tokens: 41728, cache_creation_input_tokens: 0 })
    unlinkSync(tmp)
  })

  test('readLastCallUsageFromTranscript returns null when file missing', () => {
    expect(readLastCallUsageFromTranscript(join(tmpdir(), 'lodestar-no-such.jsonl'))).toBeNull()
  })
})

describe('Claude project profile overrides', () => {
  const ssTmpDirs: string[] = []
  function tmpProjectDir(entries: { claudeDir?: boolean; claudeMd?: boolean } = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'lodestar-ss-'))
    ssTmpDirs.push(dir)
    if (entries.claudeDir) mkdirSync(join(dir, '.claude'))
    if (entries.claudeMd) writeFileSync(join(dir, 'CLAUDE.md'), '# proj\n')
    return dir
  }
  afterAll(() => {
    for (const d of ssTmpDirs) rmSync(d, { recursive: true, force: true })
  })

  test('settingSourcesFromProfile falls back to CLI parity (user+project+local) when absent', () => {
    expect(settingSourcesFromProfile(undefined)).toEqual(['user', 'project', 'local'])
    expect(settingSourcesFromProfile({})).toEqual(['user', 'project', 'local'])
  })

  test('settingSourcesFromProfile splits and trims comma-separated sources', () => {
    expect(settingSourcesFromProfile({ settingSources: 'project' })).toEqual(['project'])
    expect(settingSourcesFromProfile({ settingSources: 'user, project' })).toEqual(['user', 'project'])
  })

  test('settingSourcesFromProfile falls back to CLI parity when only blanks given', () => {
    expect(settingSourcesFromProfile({ settingSources: '' })).toEqual(['user', 'project', 'local'])
    expect(settingSourcesFromProfile({ settingSources: ' , ' })).toEqual(['user', 'project', 'local'])
  })

  test('settingSourcesFromProfile auto detects project .claude → three sources', () => {
    const dir = tmpProjectDir({ claudeDir: true })
    expect(settingSourcesFromProfile({ settingSources: 'auto' }, dir)).toEqual(['user', 'project', 'local'])
  })

  test('settingSourcesFromProfile auto detects CLAUDE.md → three sources', () => {
    const dir = tmpProjectDir({ claudeMd: true })
    expect(settingSourcesFromProfile({ settingSources: 'auto' }, dir)).toEqual(['user', 'project', 'local'])
  })

  test('settingSourcesFromProfile auto with no project config → user', () => {
    const dir = tmpProjectDir()
    expect(settingSourcesFromProfile({ settingSources: 'auto' }, dir)).toEqual(['user'])
  })

  test('settingSourcesFromProfile auto without workDir → user', () => {
    expect(settingSourcesFromProfile({ settingSources: 'auto' })).toEqual(['user'])
  })

  test('settingSourcesFromProfile AUTO is case-insensitive', () => {
    const dir = tmpProjectDir({ claudeDir: true })
    expect(settingSourcesFromProfile({ settingSources: 'AUTO' }, dir)).toEqual(['user', 'project', 'local'])
  })

  test('settingSourcesFromProfile "auto,project" stays auto (never drops user)', () => {
    const hit = tmpProjectDir({ claudeDir: true })
    expect(settingSourcesFromProfile({ settingSources: 'auto,project' }, hit)).toEqual(['user', 'project', 'local'])
    const miss = tmpProjectDir()
    expect(settingSourcesFromProfile({ settingSources: 'auto,project' }, miss)).toEqual(['user'])
  })

  test('settingSourcesFromProfile drops unknown tokens via whitelist', () => {
    expect(settingSourcesFromProfile({ settingSources: 'user,bogus' })).toEqual(['user'])
  })

  test('settingSources 全局默认: [claude].default_setting_sources 兜底无 profile 的项目', () => {
    const prev = (config.claude as any).defaultSettingSources
    ;(config.claude as any).defaultSettingSources = 'user,project'
    try {
      expect(settingSourcesFromProfile(undefined)).toEqual(['user', 'project'])
      expect(settingSourcesFromProfile({})).toEqual(['user', 'project'])
    } finally {
      ;(config.claude as any).defaultSettingSources = prev
    }
  })

  test('settingSources 全局默认 "auto": 按各项目目录独立探测', () => {
    const prev = (config.claude as any).defaultSettingSources
    ;(config.claude as any).defaultSettingSources = 'auto'
    try {
      const hit = tmpProjectDir({ claudeDir: true })
      expect(settingSourcesFromProfile(undefined, hit)).toEqual(['user', 'project', 'local'])
      const miss = tmpProjectDir()
      expect(settingSourcesFromProfile(undefined, miss)).toEqual(['user'])
    } finally {
      ;(config.claude as any).defaultSettingSources = prev
    }
  })

  test('settingSources 全局默认: 项目级 setting_sources 优先于全局', () => {
    const prev = (config.claude as any).defaultSettingSources
    ;(config.claude as any).defaultSettingSources = 'auto'
    try {
      // 目录带 .claude/,auto 本会给三源 —— project 档生效才说明项目级赢了
      const hit = tmpProjectDir({ claudeDir: true })
      expect(settingSourcesFromProfile({ settingSources: 'project' }, hit)).toEqual(['project'])
    } finally {
      ;(config.claude as any).defaultSettingSources = prev
    }
  })

  test('settingSources 全局默认: 项目级空白值回落到全局默认', () => {
    const prev = (config.claude as any).defaultSettingSources
    ;(config.claude as any).defaultSettingSources = 'user,project'
    try {
      expect(settingSourcesFromProfile({ settingSources: ' , ' })).toEqual(['user', 'project'])
    } finally {
      ;(config.claude as any).defaultSettingSources = prev
    }
  })

  test('settingSources 全局默认: 非法值整体丢弃后回落内置默认(user+project+local)', () => {
    const prev = (config.claude as any).defaultSettingSources
    ;(config.claude as any).defaultSettingSources = 'bogus'
    try {
      expect(settingSourcesFromProfile(undefined)).toEqual(['user', 'project', 'local'])
    } finally {
      ;(config.claude as any).defaultSettingSources = prev
    }
  })

  test('settingSources 全局默认: 项目级全非法 token 时落回全局默认(非直接 user)', () => {
    // 钉住本次的唯一语义变化:旧实现项目级 'bogus' 直接回 ['user'],
    // 新实现视为"该层不可用"、穿透到全局默认层。
    const prev = (config.claude as any).defaultSettingSources
    ;(config.claude as any).defaultSettingSources = 'project'
    try {
      expect(settingSourcesFromProfile({ settingSources: 'bogus' })).toEqual(['project'])
    } finally {
      ;(config.claude as any).defaultSettingSources = prev
    }
  })

  test('toolsFromProfile falls back to claude_code preset when absent', () => {
    expect(toolsFromProfile(undefined)).toEqual({ type: 'preset', preset: 'claude_code' })
    expect(toolsFromProfile({})).toEqual({ type: 'preset', preset: 'claude_code' })
  })

  test('toolsFromProfile splits comma-separated built-in tool names', () => {
    expect(toolsFromProfile({ tools: 'Read,Write,Edit,Bash,Glob,Grep' })).toEqual([
      'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
    ])
  })

  test('toolsFromProfile falls back when only blanks given', () => {
    expect(toolsFromProfile({ tools: '' })).toEqual({ type: 'preset', preset: 'claude_code' })
    expect(toolsFromProfile({ tools: ' , ' })).toEqual({ type: 'preset', preset: 'claude_code' })
  })

  test('readProjectMcpServers reads <workDir>/.mcp.json mcpServers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lodestar-mcp-'))
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: { evolving: { command: '/bin/evolving', args: ['mcp-notify'] } },
    }))
    expect(readProjectMcpServers(dir)).toEqual({
      evolving: { command: '/bin/evolving', args: ['mcp-notify'] },
    })
  })

  test('readProjectMcpServers returns undefined when .mcp.json missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lodestar-mcp-'))
    expect(readProjectMcpServers(dir)).toBeUndefined()
  })

  test('readProjectMcpServers rejects malformed json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lodestar-mcp-'))
    writeFileSync(join(dir, '.mcp.json'), '{ not json')
    try { expect(() => readProjectMcpServers(dir)).toThrow('project .mcp.json parse failed') }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('readProjectMcpServers rejects missing and non-object mcpServers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lodestar-mcp-'))
    try {
      for (const value of [{ foo: 'bar' }, { mcpServers: [] }, { mcpServers: null }, null]) {
        writeFileSync(join(dir, '.mcp.json'), JSON.stringify(value))
        expect(() => readProjectMcpServers(dir)).toThrow('no valid mcpServers object')
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('readProjectMcpServers exposes filesystem errors instead of omitting configured tools', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lodestar-mcp-'))
    mkdirSync(join(dir, '.mcp.json'))
    try { expect(() => readProjectMcpServers(dir)).toThrow('project .mcp.json not readable') }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('invalid project MCP configuration fails initialization before the SDK starts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lodestar-mcp-'))
    writeFileSync(join(dir, '.mcp.json'), '{ not json')
    const sdk = spyOn(agentUpdates, 'loadClaudeSdk')
    const proc = new ClaudeAgentProcess({ workDir: dir, effort: 'high' })
    const errors: Error[] = []
    const exits: unknown[] = []
    proc.on('error', error => errors.push(error))
    proc.on('exit', event => exits.push(event))
    try {
      await expect(proc.listModels()).rejects.toThrow('project .mcp.json parse failed')
      expect(sdk).not.toHaveBeenCalled()
      expect(errors).toHaveLength(1)
      expect(exits).toEqual([{ code: 1, signal: null, expected: false }])
      expect(proc.isAlive()).toBe(false)
    } finally {
      sdk.mockRestore()
      await proc.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Claude executable: third-party API routes bypass the wrapper bin', () => {
  // 回归:GLM(route:api)绝不能走 reclaude 包装器 —— reclaude 的 gateway 会
  // 把注入的 ANTHROPIC_BASE_URL 劫持回官方 Anthropic,glm-5.3 这类第三方 id
  // 被官方 deployment 判为"模型不存在",客户端直接报
  // "There's an issue with the selected model"。apiRoute:true 强制绕开 wrapper，
  // 交给 SDK native 入口直连第三方端点并保留 dialog 工具。
  const wrapper = '/home/me/.local/bin/reclaude'
  const plain = '/home/me/.local/bin/claude'

  test('apiRoute:true ignores the configured wrapper bin and uses the SDK native entry', () => {
    const executable = resolveClaudeExecutableConfig({
      platform: 'linux',
      homeDir: '/home/me',
      configuredBin: wrapper,
      apiRoute: true,
      exists: path => path === wrapper || path === plain,
    })

    expect(executable.pathToClaudeCodeExecutable).toBeUndefined()
    expect(executable.description).toBe('sdk-default')
  })

  test('apiRoute:true still bypasses the wrapper even when no plain claude exists (sdk-default)', () => {
    const executable = resolveClaudeExecutableConfig({
      platform: 'linux',
      pathEnv: '',
      homeDir: '/home/me',
      configuredBin: wrapper,
      apiRoute: true,
      exists: path => path === wrapper, // wrapper present, but never selected for api routes
    })

    expect(executable).toEqual({ description: 'sdk-default' })
  })

  test('login routes (apiRoute:false) keep using the configured wrapper bin', () => {
    const executable = resolveClaudeExecutableConfig({
      platform: 'linux',
      homeDir: '/home/me',
      configuredBin: wrapper,
      apiRoute: false,
      exists: path => path === wrapper || path === plain,
    })

    expect(executable.pathToClaudeCodeExecutable).toBeUndefined()
    expect(typeof executable.spawnClaudeCodeProcess).toBe('function')
    expect(executable.description).toBe(`config-reclaude-sdk-native:${wrapper}`)
  })
})

describe('Claude settings.json alias conflict detection', () => {
  // 第三方 api 路由下,Claude Code 启动加载的 settings.json env 块若含
  // ANTHROPIC_DEFAULT_*_MODEL,会覆盖 Lodestar spawn 注入的 alias 锁回。
  let prevConfigDir: string | undefined
  beforeEach(() => {
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lodestar-cfg-'))
  })
  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
  })

  test('filesForSources: user/project/local path mapping respects CLAUDE_CONFIG_DIR', () => {
    const files = claudeSettingsFilesForSources(['user', 'project', 'local'], '/work')
    expect(files).toEqual([
      join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'),
      join('/work', '.claude', 'settings.json'),
      join('/work', '.claude', 'settings.local.json'),
    ])
  })

  test('filesForSources: drops project/local when no workDir given', () => {
    expect(claudeSettingsFilesForSources(['user', 'project', 'local']))
      .toEqual([join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json')])
  })

  test('aliasConflicts: flags ANTHROPIC_DEFAULT_*_MODEL, filters blank values', () => {
    writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-fable-5', ANTHROPIC_DEFAULT_HAIKU_MODEL: '   ' },
      model: 'claude-fable-5[1m]',
    }))
    const conflicts = claudeSettingsAliasConflicts(['user'])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].keys).toContain('ANTHROPIC_DEFAULT_SONNET_MODEL')
    expect(conflicts[0].keys).not.toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL')
  })

  test('aliasConflicts: env without alias keys → no conflicts', () => {
    writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify({
      env: { CLAUDE_CODE_EFFORT_LEVEL: 'max' },
      model: 'claude-fable-5[1m]',
    }))
    expect(claudeSettingsAliasConflicts(['user'])).toEqual([])
  })

  test('aliasConflicts: project-level settings.json is also detected', () => {
    const work = mkdtempSync(join(tmpdir(), 'lodestar-work-'))
    try {
      mkdirSync(join(work, '.claude'), { recursive: true })
      writeFileSync(join(work, '.claude', 'settings.json'), JSON.stringify({
        env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-fable-5' },
      }))
      writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify({ env: {} }))
      const conflicts = claudeSettingsAliasConflicts(['user', 'project'], work)
      expect(conflicts).toHaveLength(1)
      expect(conflicts[0].path).toBe(join(work, '.claude', 'settings.json'))
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('aliasConflicts: malformed JSON is skipped, never throws', () => {
    writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), '{ not json')
    expect(claudeSettingsAliasConflicts(['user'])).toEqual([])
  })
})

describe('Claude sendUserText dispatch contract', () => {
  function claudeSendFixture(): { proc: any; pushed: any[] } {
    const proc = Object.create(ClaudeAgentProcess.prototype) as any
    const pushed: any[] = []
    proc.alive = true
    proc.started = true
    proc.sessionId = 'claude-session-1'
    proc.pendingInjectedContext = []
    proc.sdkToolFailureLoop = { reset: () => {} }
    proc.input = {
      push: (message: unknown) => {
        pushed.push(message)
      },
    }
    return { proc, pushed }
  }

  test('a live process queues synchronously without waiting on SDK events', () => {
    const { proc, pushed } = claudeSendFixture()
    const dispatch = proc.sendUserText('hello claude', ['/tmp/a.txt'])

    expect(dispatch).toEqual({ kind: 'queued', provider: 'claude' })
    expect(pushed).toHaveLength(1)
    expect(pushed[0].message.content[0].text).toBe('[file: /tmp/a.txt]\n\nhello claude')
  })

  test('a dead process rejects without claiming the input was queued', () => {
    const { proc, pushed } = claudeSendFixture()
    proc.alive = false

    const dispatch = proc.sendUserText('hello claude')

    expect(dispatch).toMatchObject({ kind: 'rejected', provider: 'claude' })
    expect(pushed).toHaveLength(0)
  })

  test('a failed lazy initialize rejects instead of queueing', () => {
    const { proc, pushed } = claudeSendFixture()
    proc.started = false
    proc.sendInitialize = () => {
      proc.alive = false
    }

    const dispatch = proc.sendUserText('hello claude') as any

    expect(dispatch).toMatchObject({ kind: 'rejected', provider: 'claude' })
    expect(dispatch.error.message).toContain('failed to initialize')
    expect(pushed).toHaveLength(0)
  })

  test('an input.push throw rejects and never claims queued', () => {
    const { proc } = claudeSendFixture()
    proc.input = {
      push: () => {
        throw new Error('input stream closed')
      },
    }

    const dispatch = proc.sendUserText('hello claude') as any

    expect(dispatch).toMatchObject({ kind: 'rejected', provider: 'claude' })
    expect(dispatch.error.message).toBe('input stream closed')
  })
})

describe('Claude assistant 消息子 agent 隔离(上游 7c14677-B)', () => {
  // 子 agent 的 assistant 消息(parent_tool_use_id 非空)属于另一份 transcript:
  // 它的 uuid 不能污染 rs/fk 锚点(temp session 分叉/回滚以 lastAssistantUuid
  // 为 checkpoint,D-02 保护线),正文事件必须像工具事件一样保留归属。
  function assistantMessage(uuid: string, text: string, parentToolUseId?: string): any {
    return {
      type: 'assistant',
      uuid,
      session_id: 'claude-session-1',
      ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
      message: { content: [{ type: 'text', text }] },
    }
  }

  test('子 agent(parent_tool_use_id 非空)assistant 消息不更新 lastAssistantUuid', () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    proc.handleMessage(assistantMessage('main-uuid-1', '主线程正文'))
    proc.handleMessage(assistantMessage('sub-uuid-1', '子 agent 正文', 'task_tool_1'))

    // 子 agent uuid 不覆盖主线程锚点
    expect(proc.lastAssistantUuid).toBe('main-uuid-1')
  })

  test('主线程 assistant 消息正常更新 lastAssistantUuid', () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    proc.handleMessage(assistantMessage('main-uuid-1', '第一段'))
    expect(proc.lastAssistantUuid).toBe('main-uuid-1')
    proc.handleMessage(assistantMessage('main-uuid-2', '第二段'))
    expect(proc.lastAssistantUuid).toBe('main-uuid-2')
  })

  test('assistant_text/assistant_block_stop emit 携带 parentToolUseId(主线程 null,子 agent 归属 id)', () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const texts: any[] = []
    const stops: any[] = []
    proc.on('assistant_text', (e: any) => texts.push(e))
    proc.on('assistant_block_stop', (e: any) => stops.push(e))

    proc.handleMessage(assistantMessage('main-uuid-1', '主线程正文'))
    proc.handleMessage(assistantMessage('sub-uuid-1', '子 agent 正文', 'task_tool_1'))

    expect(texts).toEqual([
      { uuid: 'main-uuid-1', text: '主线程正文', parentToolUseId: null },
      { uuid: 'sub-uuid-1', text: '子 agent 正文', parentToolUseId: 'task_tool_1' },
    ])
    expect(stops).toEqual([
      { index: 'main-uuid-1', parentToolUseId: null },
      { index: 'sub-uuid-1', parentToolUseId: 'task_tool_1' },
    ])
  })
})

describe('Claude SDK Cron 定时唤醒识别(上游 7c14677 主题 A)', () => {
  // A1(RESEARCH):本地 SDK 0.3.222 runtime 是否对 cron 唤醒附带 promptSource='sdk'
  // 未实证——检测为防御式形状匹配,SDK 不发则功能休眠不误伤;此处注入上游实测
  // 形状(isMeta=true + promptSource='sdk' + string content)锁定行为。
  test('isMeta+promptSource=sdk+string content → emit scheduled_turn_input { text, promptId }', () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const scheduled: any[] = []
    proc.on('scheduled_turn_input', (e: any) => scheduled.push(e))

    proc.handleMessage({
      type: 'user',
      isMeta: true,
      promptSource: 'sdk',
      promptId: 'cron-prompt-1',
      message: { role: 'user', content: '巡检:检查任务清单待办' },
    })

    expect(scheduled).toEqual([{ text: '巡检:检查任务清单待办', promptId: 'cron-prompt-1' }])
  })

  test('promptId 缺失/非 string 归一为 null', () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const scheduled: any[] = []
    proc.on('scheduled_turn_input', (e: any) => scheduled.push(e))

    proc.handleMessage({
      type: 'user',
      isMeta: true,
      promptSource: 'sdk',
      message: { role: 'user', content: 'cron text' },
    })
    proc.handleMessage({
      type: 'user',
      isMeta: true,
      promptSource: 'sdk',
      promptId: 42,
      message: { role: 'user', content: 'cron text 2' },
    })

    expect(scheduled).toEqual([
      { text: 'cron text', promptId: null },
      { text: 'cron text 2', promptId: null },
    ])
  })

  test('三条件缺一不发:普通 internal user 消息不被误判', () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const scheduled: any[] = []
    proc.on('scheduled_turn_input', (e: any) => scheduled.push(e))

    // isMeta=true 但无 promptSource(图片结果 meta string 形态)
    proc.handleMessage({
      type: 'user',
      isMeta: true,
      message: { role: 'user', content: 'internal meta string' },
    })
    // promptSource 非 'sdk'
    proc.handleMessage({
      type: 'user',
      isMeta: true,
      promptSource: 'user',
      message: { role: 'user', content: 'not sdk source' },
    })
    // isMeta 缺失(task-notification 邻族形态)
    proc.handleMessage({
      type: 'user',
      promptSource: 'sdk',
      message: { role: 'user', content: 'no isMeta' },
    })
    // content 为 text block 数组(手动输入形状)
    proc.handleMessage({
      type: 'user',
      isMeta: true,
      promptSource: 'sdk',
      message: { role: 'user', content: [{ type: 'text', text: 'array content' }] },
    })
    // content 空白串(trim 后为空不认)
    proc.handleMessage({
      type: 'user',
      isMeta: true,
      promptSource: 'sdk',
      message: { role: 'user', content: '   ' },
    })

    expect(scheduled).toEqual([])
  })

  test('畸形形状静默走原路径:message 缺失不炸,tool_result 数组照常处理', () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const scheduled: any[] = []
    const results: any[] = []
    proc.on('scheduled_turn_input', (e: any) => scheduled.push(e))
    proc.on('tool_result', (e: any) => results.push(e))

    // message 整体缺失 → 不炸不 emit
    proc.handleMessage({ type: 'user', isMeta: true, promptSource: 'sdk' })
    // 既有 tool_result 数组路径零变化
    proc.handleMessage({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-sched-1', content: [{ type: 'text', text: 'ok' }] }],
      },
    })

    expect(scheduled).toEqual([])
    expect(results).toHaveLength(1)
    expect(results[0].tool_use_id).toBe('tool-sched-1')
  })
})

// ── 上游 ff44afb:claude turn-local checkpoint 边界 ──────────────────────
// A checkpoint belongs to exactly one clean turn:running 边界清 lastAssistantUuid,
// result 载荷仅 !is_error && lastAssistantUuid && sessionId 时携带。
describe('Claude turn-local checkpoint(上游 ff44afb)', () => {
  test('emits a turn-local Claude checkpoint and clears it at the next turn boundary', () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const results: any[] = []
    proc.on('result', (event: any) => results.push(event))

    proc.handleMessage({
      type: 'system', subtype: 'init', uuid: 'init-1',
      session_id: 'claude-session-ckpt', model: 'sonnet',
    })
    proc.handleMessage({
      type: 'system', subtype: 'session_state_changed', state: 'running',
      uuid: 'turn-1', session_id: 'claude-session-ckpt',
    })
    proc.handleMessage({
      type: 'assistant', uuid: 'assistant-uuid-1', session_id: 'claude-session-ckpt',
      message: { model: 'sonnet', content: [{ type: 'text', text: '第一轮答复' }] },
    })
    proc.handleMessage({
      type: 'result', subtype: 'success', uuid: 'result-1', session_id: 'claude-session-ckpt',
      is_error: false, duration_ms: 10, num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {},
    })

    expect(results.at(-1)?.checkpoint).toEqual({
      provider: 'claude',
      kind: 'assistant-message',
      id: 'assistant-uuid-1',
      source: { provider: 'claude', sessionId: 'claude-session-ckpt', cwd: '/tmp' },
    })

    // 下一 turn 的 running 边界清空:上轮 uuid 不得作为新轮的锚。
    proc.handleMessage({
      type: 'system', subtype: 'session_state_changed', state: 'running',
      uuid: 'turn-2', session_id: 'claude-session-ckpt',
    })
    expect(proc.lastAssistantUuid).toBeNull()

    // 失败 result 不携带 checkpoint(is_error 判定逐字)。
    proc.handleMessage({
      type: 'result', subtype: 'error_during_execution', uuid: 'result-2',
      session_id: 'claude-session-ckpt', is_error: true, duration_ms: 5, num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {},
    })
    expect(results.at(-1)?.checkpoint).toBeNull()
  })
})
