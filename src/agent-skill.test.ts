import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DELEGATED_AGENT_INSTRUCTIONS,
  PROJECT_AGENT_INSTRUCTIONS,
  agentSkillBody,
  ensureLodestarAgentCommand,
  ensureLodestarAgentSkill,
  lodestarAgentWrapperPath,
  resolveAgentCliLaunch,
} from './agent-skill'

const temps: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('lodestar-agent skill body', () => {
  test('describes a selected identity as its corresponding Agent call', () => {
    const body = agentSkillBody()
    expect(body).toContain('selected live identity')
    expect(body).toContain('provider Agent backend')
    expect(body).toContain("caller-supplied prompt becomes that Agent run's task")
    expect(body).toContain('Both session-bound and project-bound Agents return results and local artifact paths to the caller')
    expect(body).toContain('Agent output markers do not upload files or grant sharing permissions')
    expect(body).toContain('lodestar-agent follow-up')
    expect(body).toContain("lodestar-agent run --session '<session-id>'")
    expect(body).toContain('workers[].session_id')
    expect(body).toContain('workers[].output')
    expect(body).toContain('lodestar-agent answer')
    expect(body.toLowerCase()).not.toContain('reviewer')
    expect(body.toLowerCase()).not.toContain('read-only')
  })

  test('uses fixed-slot identity wording and never Token Source / consult protocol names', () => {
    const body = agentSkillBody()
    expect(body).toContain('name: lodestar-agent')
    expect(body).toContain('固定档位')
    expect(body).toContain('禁止暴露 LODESTAR_AGENT_CAPABILITY')
    expect(body).toContain('lodestar-agent identities')
    expect(body).not.toMatch(/Token Source/)
    expect(body).not.toContain('lodestar-consult')
    expect(body).not.toContain('reviewers')
    expect(body).not.toMatch(/question\/review\/critique/)
    expect(body).not.toContain('managed-skills')
    expect(body).toContain('Main Agents, delegated Agents and native subagents may delegate further')
    expect(body).toContain('Lodestar does not impose a delegation depth limit')
    expect(body).toContain('Nested calls inherit the project, conversation ID (chat_id), interaction policy')
    for (const instructions of [DELEGATED_AGENT_INSTRUCTIONS, PROJECT_AGENT_INSTRUCTIONS]) {
      expect(instructions).toContain('You may delegate work through Lodestar or provider-native Agent/subagent tools')
      expect(instructions).toContain('replaces earlier Lodestar instructions prohibiting further delegation')
    }
  })

  test('allows self-calls and recursive work while preserving caller delivery ownership', () => {
    const body = agentSkillBody()
    expect(body).toContain('Calling your own model or Agent through `lodestar-agent` is allowed')
    expect(body).toContain('Claude subscription source')
    expect(body).toContain('## Recursive delegation')
    expect(body).not.toContain('Only the main Agent may delegate work')
    expect(body).not.toContain('without further delegation')
    expect(DELEGATED_AGENT_INSTRUCTIONS).toContain('you may use question tools to ask the main Agent')
    for (const instructions of [DELEGATED_AGENT_INSTRUCTIONS, PROJECT_AGENT_INSTRUCTIONS]) {
      expect(instructions).toContain('Return task results and local artifact paths to the caller')
      expect(instructions).toContain('Do not emit file-delivery markers')
    }
    expect(PROJECT_AGENT_INSTRUCTIONS).toContain('nobody is available to answer questions')
  })

})

describe('ensureLodestarAgentSkill', () => {
  test('writes the same SKILL.md into Codex and Claude skill dirs', () => {
    const home = tempDir('lodestar-agent-skill-home-')
    ensureLodestarAgentSkill({ homeDir: home, env: {} })
    const codex = join(home, '.codex', 'skills', 'lodestar-agent', 'SKILL.md')
    const claude = join(home, '.claude', 'skills', 'lodestar-agent', 'SKILL.md')
    expect(existsSync(codex)).toBe(true)
    expect(existsSync(claude)).toBe(true)
    const body = readFileSync(codex, 'utf8')
    expect(body).toBe(readFileSync(claude, 'utf8'))
    expect(body).toBe(agentSkillBody())
    expect(body).toContain('固定档位')
    expect(body).toContain('禁止暴露 LODESTAR_AGENT_CAPABILITY')
  })

  test('LODESTAR_DISABLE_SKILL_SYNC=1 skips writing skill files', () => {
    const home = tempDir('lodestar-agent-skill-disabled-')
    ensureLodestarAgentSkill({
      homeDir: home,
      env: { LODESTAR_DISABLE_SKILL_SYNC: '1' },
    })
    expect(existsSync(join(home, '.codex', 'skills', 'lodestar-agent', 'SKILL.md'))).toBe(false)
    expect(existsSync(join(home, '.claude', 'skills', 'lodestar-agent', 'SKILL.md'))).toBe(false)
  })
})

describe('lodestar-agent wrapper', () => {
  test('installs DATA_DIR/bin/lodestar-agent without credentials and prepends PATH', () => {
    const dataDir = tempDir('lodestar-agent-data-')
    const entry = join(tempDir('lodestar-agent-src-'), 'src', 'agent-cli.ts')
    mkdirSync(join(entry, '..'), { recursive: true })
    writeFileSync(entry, 'export {}\n')
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    const wrapper = ensureLodestarAgentCommand({
      dataDir,
      platform: 'darwin',
      env,
      launch: { runtime: '/usr/bin/node', entry },
    })
    expect(wrapper).toBe(lodestarAgentWrapperPath(dataDir, 'darwin'))
    expect(wrapper).toBe(join(dataDir, 'bin', 'lodestar-agent'))
    const body = readFileSync(wrapper, 'utf8')
    expect(body).toContain('/usr/bin/node')
    expect(body).toContain(entry)
    expect(body).toContain('exec')
    expect(body).not.toMatch(/LODESTAR_AGENT_CAPABILITY/)
    expect(body).not.toMatch(/token/i)
    expect(body).not.toMatch(/capability/i)
    expect(env.PATH?.startsWith(`${join(dataDir, 'bin')}:`)).toBe(true)
  })

  test('win32 wrapper uses .cmd and does not embed credentials', () => {
    const dataDir = tempDir('lodestar-agent-win-')
    const entry = join(dataDir, 'lodestar-agent.js')
    writeFileSync(entry, 'export {}\n')
    const wrapper = ensureLodestarAgentCommand({
      dataDir,
      platform: 'win32',
      env: { PATH: 'C:\\Windows' },
      launch: { runtime: 'C:\\node.exe', entry },
    })
    expect(wrapper).toBe(join(dataDir, 'bin', 'lodestar-agent.cmd'))
    const body = readFileSync(wrapper, 'utf8')
    expect(body).toContain('C:\\node.exe')
    expect(body).not.toMatch(/LODESTAR_AGENT_CAPABILITY/)
    expect(body).not.toMatch(/token/i)
  })

  test('follows npm global bin symlink to dist/lodestar-agent.js', () => {
    const pkg = tempDir('lodestar-agent-pkg-')
    const dist = join(pkg, 'dist')
    mkdirSync(dist)
    writeFileSync(join(dist, 'lodestar.js'), 'export {}\n')
    writeFileSync(join(dist, 'lodestar-agent.js'), 'export {}\n')
    const binDir = tempDir('lodestar-agent-npmbin-')
    const shim = join(binDir, 'lodestar-daemon')
    symlinkSync(join(dist, 'lodestar.js'), shim)
    const launch = resolveAgentCliLaunch({
      daemonEntry: shim,
      runtime: '/usr/bin/node',
    })
    expect(launch.entry).toBe(join(realpathSync(dist), 'lodestar-agent.js'))
  })

  test('bun daemon.ts still resolves src/agent-cli.ts beside the repo root', () => {
    const repo = tempDir('lodestar-agent-repo-')
    mkdirSync(join(repo, 'src'))
    writeFileSync(join(repo, 'daemon.ts'), 'export {}\n')
    writeFileSync(join(repo, 'src', 'agent-cli.ts'), 'export {}\n')
    const launch = resolveAgentCliLaunch({
      daemonEntry: join(repo, 'daemon.ts'),
      runtime: '/usr/bin/bun',
    })
    expect(launch.entry).toBe(join(realpathSync(repo), 'src', 'agent-cli.ts'))
  })

  test('legacy lodestar-consult unlink is a no-op when absent and removes an owned leftover', () => {
    const dataDir = tempDir('lodestar-agent-legacy-')
    const bin = join(dataDir, 'bin')
    mkdirSync(bin, { recursive: true })
    const entry = join(dataDir, 'src', 'agent-cli.ts')
    mkdirSync(join(dataDir, 'src'), { recursive: true })
    writeFileSync(entry, 'export {}\n')
    ensureLodestarAgentCommand({
      dataDir,
      platform: 'darwin',
      env: { PATH: '/usr/bin' },
      launch: { runtime: '/usr/bin/node', entry },
    })
    expect(existsSync(join(bin, 'lodestar-consult'))).toBe(false)

    writeFileSync(join(bin, 'lodestar-consult'), '#!/bin/sh\nexec node consult-cli.ts "$@"\n')
    ensureLodestarAgentCommand({
      dataDir,
      platform: 'darwin',
      env: { PATH: '/usr/bin' },
      launch: { runtime: '/usr/bin/node', entry },
    })
    expect(existsSync(join(bin, 'lodestar-consult'))).toBe(false)
  })
})
