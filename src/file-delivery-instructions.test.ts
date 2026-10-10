import { expect, test } from 'bun:test'

test('main Agent launches select the directory delivery rules for Codex, Claude and DSH', () => {
  // Isolate module mocks so no real Agent or Feishu service is started.
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', `
    import { mock } from 'bun:test'
    import './src/feishu-test-mock'
    const launches = []
    mock.module('./src/agent-launch', () => ({ createAgentProcess: options => {
      const entry = { provider: options.provider, instructions: options.developerInstructions, inputs: [] }
      launches.push(entry)
      return { sourceRevision: null, process: {
        provider: options.provider,
        sendUserText(text) { entry.inputs.push(text) },
      } }
    } }))
    // 合并语义:dsd 档位直连 DshProcess(本地 D-08 双轨),不走 agent-launch ——
    // 构造与 agent-launch mock 同口径计入 launches,不真起 DSH 子进程。
    mock.module('./src/dsh-process', () => ({ DshProcess: class {
      constructor(options) {
        const entry = { provider: 'dsh', instructions: options.developerInstructions, inputs: [] }
        launches.push(entry)
        this.entry = entry
      }
      sendUserText(text) { this.entry.inputs.push(text) }
    } }))
    const { Session } = await import('./src/session')
    for (const provider of ['codex', 'claude', 'dsh']) {
      for (const mode of ['chat', 'drive']) {
        const session = new Session('launch-' + provider + '-' + mode, 'chat-' + mode)
        session.selectedProvider = provider
        session.selectedTokenSourceId = null
        session.selectedModel = 'test-model'
        session.selectedEffort = 'high'
        session.getFileDeliveryMode = () => mode
        const proc = session.spawnAgent()
        session.sendClaimedUserText(proc, '生成报告')
        session.sendClaimedUserText(proc, '继续')
      }
    }
    const broken = new Session('broken-delivery-config', 'chat-broken')
    broken.getFileDeliveryMode = () => { throw new Error('group config unreadable') }
    let error
    try { broken.spawnAgent() } catch (e) { error = e.message }
    console.log(JSON.stringify({ launches, error }))
  `], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString())
  const { launches, error } = JSON.parse(result.stdout.toString().trim().split('\n').at(-1)!)
  expect(error).toBe('group config unreadable')
  expect(launches).toHaveLength(6)
  for (const [index, launch] of launches.entries()) {
    expect(launch.instructions).toContain('[[send: /abs/path]]')
    expect(launch.inputs).toEqual(['生成报告', '继续'])
    if (index % 2 === 0) {
      expect(launch.instructions).toContain('30 × 1024 × 1024')
      expect(launch.instructions).toContain('交付前检查文件大小')
    } else {
      expect(launch.instructions).not.toMatch(/30|大小|压缩|分卷|分片/)
    }
    const questionTool = { codex: 'request_user_input', claude: 'AskUserQuestion', dsh: 'ask_user_question' }[launch.provider as 'codex' | 'claude' | 'dsh']
    expect(launch.instructions).toContain(questionTool)
  }
})

test('BTW launches first with migrated directory settings; WT launches with its own profile and delivery rules', () => {
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', `
    import { mock } from 'bun:test'
    import { writeFileSync } from 'node:fs'
    import { join } from 'node:path'
    import { projectProfiles } from './src/feishu-test-mock'
    const feishu = await import('./src/feishu')
    const { FILE_DELIVERY_GROUPS_FILE } = await import('./src/paths')
    const mainDir = join(process.env.LODESTAR_DATA_DIR, 'repo')
    const wtDir = join(process.env.LODESTAR_DATA_DIR, 'project[feature]')
    projectProfiles.set('project', { cwd: mainDir, tools: 'Read', loadProjectMcp: false })
    projectProfiles.set('feature-profile', { cwd: wtDir, tools: 'Read,Edit', loadProjectMcp: true })
    feishu.preferredChatForSession.set('project', 'main-chat')
    writeFileSync(FILE_DELIVERY_GROUPS_FILE, JSON.stringify({ version: 1, groups: {
      'main-chat': { enabled: true, folder: { token: 'old', name: 'project', url: 'https://example.com/folder/old' } },
    } }))
    const launches = []
    mock.module('./src/agent-launch', () => ({ createAgentProcess: options => {
      launches.push(options)
      return { sourceRevision: null, process: { provider: options.provider } }
    } }))
    // 合并语义:dsd 档位直连 DshProcess,构造同口径计入 launches(见上一个用例)。
    mock.module('./src/dsh-process', () => ({ DshProcess: class {
      constructor(options) { launches.push(options) }
    } }))
    const { Session } = await import('./src/session')
    for (const provider of ['codex', 'claude', 'dsh']) {
      for (const name of ['project*0917-1234', 'project[feature]*0917-1234', 'project']) {
        const session = new Session(name, name === 'project' ? 'main-chat' : name)
        session.selectedProvider = provider
        session.selectedTokenSourceId = null
        session.selectedModel = 'test-model'
        session.selectedEffort = 'high'
        session.spawnAgent()
      }
    }
    console.log(JSON.stringify({ launches, mainDir, wtDir }))
  `], { env: { ...process.env, NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe' })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  const { launches, mainDir, wtDir } = JSON.parse(result.stdout.toString().trim().split('\n').at(-1)!)
  expect(launches).toHaveLength(9)
  for (const [index, launch] of launches.entries()) {
    const wt = index % 3 === 1
    expect(launch.workDir).toBe(wt ? wtDir : mainDir)
    expect(launch.profile.tools).toBe(wt ? 'Read,Edit' : 'Read')
    expect(launch.profile.loadProjectMcp).toBe(wt)
    expect(launch.developerInstructions.includes('30 × 1024 × 1024')).toBe(wt)
  }
})
