import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentSkillBody,
  ensureLodestarAgentCommand,
  ensureLodestarAgentSkill,
  lodestarAgentWrapperPath,
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
