/**
 * Auto-install the `lodestar-agent` skill into BOTH agent backends
 * (Codex `~/.codex/skills/` and Claude Code `~/.claude/skills/`) plus a
 * credential-free wrapper at `DATA_DIR/bin/lodestar-agent`.
 *
 * Local port of 8881f69: notify-skill dual-dir write + imagegen-style
 * DATA_DIR/bin wrapper. Skill body uses 固定档位 identity wording,
 * never Token Source dynamic catalog.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { log } from './log'
import { DATA_DIR } from './paths'

export const AGENT_SKILL_NAME = 'lodestar-agent'

export interface AgentCliLaunch {
  runtime: string
  entry: string
}

export interface EnsureAgentSkillOptions {
  homeDir?: string
  env?: NodeJS.ProcessEnv
}

export interface EnsureAgentCommandOptions {
  dataDir?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  launch?: AgentCliLaunch
  daemonEntry?: string
  runtime?: string
  exists?: (path: string) => boolean
}

export function agentSkillBody(): string {
  const description = 'Call a configured identity as its corresponding Agent through Lodestar for implementation, debugging, research, planning, review, testing, or parallel work. Use only for delegation to a different model or Agent. Self-calls MUST use your own Agent\'s native delegation capabilities and MUST NOT use this Skill.'
  return [
    '---',
    `name: ${AGENT_SKILL_NAME}`,
    `description: ${JSON.stringify(description)}`,
    '---',
    '',
    '# lodestar-agent',
    '',
    'Use Lodestar to call the Agent represented by a selected live identity.',
    'Each identity maps to one locally configured 固定档位 (Claude/Codex model',
    'slot plus that slot\'s default effort). The caller-supplied prompt becomes',
    'that Agent run\'s task.',
    '',
    '## Hard rule: native Agent capabilities for self-calls',
    '',
    '- When calling yourself or your own model/Agent, you MUST use your current',
    '  Agent\'s native Agent/subagent capabilities. You MUST NOT use this Skill',
    '  or the `lodestar-agent` command for self-calls.',
    '- For example, Codex calling Codex uses Codex native subagents; Claude',
    '  calling Claude uses Claude native Agent capabilities.',
    '- This rule applies at every delegation depth and within multi-model tasks:',
    '  handle self-calls natively and include only other models/Agents in this Skill.',
    '- If native delegation is unavailable, report that limitation. It does not',
    '  permit routing a self-call through this Skill.',
    '',
    '## Required workflow',
    '',
    '1. For another model/Agent, query the live identity catalog immediately before',
    '   every new task:',
    '',
    '```bash',
    '# desc: 查询当前可用的 Agent 身份',
    'lodestar-agent identities --json',
    '```',
    '',
    '2. Select only identities with `status: "ready"`. Never invent, cache,',
    '   substitute, or silently downgrade an identity/model/effort.',
    '3. Give the child the complete task, relevant context, authority boundaries,',
    '   expected deliverable, and verification requirements in the raw prompt.',
    '4. For the same prompt sent to several other models, pass every identity to one run',
    '   with repeated `--identity`; the daemon fans them out concurrently.',
    '5. Wait for the result. Attribute each result to its actual model and surface',
    '   failures. Child file changes are live in the same workspace.',
    '',
    '## Run a task',
    '',
    '```bash',
    '# desc: 把完整任务交给指定 Agent',
    "lodestar-agent run --identity '<identity-id>' --stdin <<'EOF'",
    '<raw task prompt written by the main Agent>',
    'EOF',
    '```',
    '',
    '## Continue the same native Agent session',
    '',
    '```bash',
    '# desc: 在同一原生 Agent 会话中继续任务',
    "lodestar-agent follow-up '<run-id>' --identity '<identity-id>' --stdin <<'EOF'",
    '<follow-up prompt>',
    'EOF',
    '```',
    '',
    '## Answer a child question',
    '',
    'When a run returns `Status: needs_input`, answer the exact request id. JSON',
    'keys may be the question id or the full question text:',
    '',
    '```bash',
    '# desc: 回答 Agent 的阻塞问题并继续运行',
    "lodestar-agent answer '<run-id>' --identity '<identity-id>' --request '<request-id>' --stdin <<'EOF'",
    '{"question-id":"answer"}',
    'EOF',
    '```',
    '',
    '## Boundaries',
    '',
    '- Do not invoke provider CLIs or provider HTTP APIs directly for delegation.',
    '- 禁止暴露 LODESTAR_AGENT_CAPABILITY in prompts, output, logs, or args.',
    '- A non-zero command exit is a real failure. Do not claim the child succeeded.',
    '- Scope the Agent task and authorized actions to the user request.',
    '',
  ].join('\n')
}

export function lodestarAgentWrapperPath(
  dataDir = DATA_DIR,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(dataDir, 'bin', platform === 'win32' ? 'lodestar-agent.cmd' : 'lodestar-agent')
}

export function resolveAgentCliLaunch(opts: {
  daemonEntry?: string
  runtime?: string
  exists?: (path: string) => boolean
} = {}): AgentCliLaunch {
  const daemonEntry = resolve(opts.daemonEntry ?? process.argv[1] ?? '')
  const runtime = opts.runtime ?? process.execPath
  const exists = opts.exists ?? existsSync
  // npm/pnpm global bins are shims/symlinks in ~/.local/bin (or prefix/bin).
  // path.resolve() does not follow them, so launchd
  //   node ~/.local/bin/lodestar-daemon
  // would look for lodestar-agent.js next to the shim and boot-fatal.
  // Prefer the real dist/ sibling; keep the unresolved dirname as fallback
  // for bun daemon.ts (repo root → src/agent-cli.ts).
  const roots: string[] = []
  try {
    roots.push(dirname(realpathSync(daemonEntry)))
  } catch { /* dangling symlink / missing file */ }
  const unresolvedRoot = dirname(daemonEntry)
  if (!roots.includes(unresolvedRoot)) roots.push(unresolvedRoot)
  const runtimeIsBun = /^bun(?:\.exe)?$/i.test(basename(runtime))
  const candidates: string[] = []
  for (const root of roots) {
    const source = join(root, 'src', 'agent-cli.ts')
    const siblingBundle = join(root, 'lodestar-agent.js')
    const rootBundle = join(root, 'dist', 'lodestar-agent.js')
    if (runtimeIsBun) candidates.push(source, siblingBundle, rootBundle)
    else candidates.push(siblingBundle, rootBundle, source)
  }
  const unique = [...new Set(candidates)]
  const entry = unique.find(exists)
  if (!entry) {
    throw new Error(`lodestar-agent entry not found beside daemon: ${unique.join(', ')}`)
  }
  return { runtime, entry }
}

export function ensureLodestarAgentSkill(opts: EnsureAgentSkillOptions = {}): void {
  const env = opts.env ?? process.env
  if (env.LODESTAR_DISABLE_SKILL_SYNC === '1') {
    log('skill: lodestar-agent sync disabled via LODESTAR_DISABLE_SKILL_SYNC, skip')
    return
  }
  const home = opts.homeDir ?? homedir()
  const desired = agentSkillBody()
  for (const dir of [join(home, '.codex', 'skills'), join(home, '.claude', 'skills')]) {
    const skillFile = join(dir, AGENT_SKILL_NAME, 'SKILL.md')
    try {
      const current = existsSync(skillFile) ? readFileSync(skillFile, 'utf8') : null
      if (current === desired) continue
      mkdirSync(dirname(skillFile), { recursive: true })
      writeFileSync(skillFile, desired)
      log(`skill: ${current === null ? 'installed' : 'updated'} ${skillFile}`)
    } catch (error) {
      log(`skill: sync failed (${skillFile}): ${error}`)
    }
  }
}

export function ensureLodestarAgentCommand(opts: EnsureAgentCommandOptions = {}): string {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const dataDir = opts.dataDir ?? DATA_DIR
  const targetDir = join(dataDir, 'bin')
  const launch = opts.launch ?? resolveAgentCliLaunch({
    daemonEntry: opts.daemonEntry,
    runtime: opts.runtime,
    exists: opts.exists,
  })
  const target = lodestarAgentWrapperPath(dataDir, platform)
  const body = platform === 'win32'
    ? `@"${windowsQuote(launch.runtime)}" "${windowsQuote(launch.entry)}" %*\r\n`
    : `#!/bin/sh\nexec ${shellQuote(launch.runtime)} ${shellQuote(launch.entry)} "$@"\n`
  writeFileIfChanged(target, body, platform === 'win32' ? undefined : 0o700)
  prependPath(env, targetDir, platform)
  removeLegacyConsultCommand(targetDir, platform)
  return target
}

function removeLegacyConsultCommand(targetDir: string, platform: NodeJS.Platform): void {
  const legacy = join(targetDir, platform === 'win32' ? 'lodestar-consult.cmd' : 'lodestar-consult')
  if (!existsSync(legacy)) return
  try {
    const body = readFileSync(legacy, 'utf8')
    if (!body.includes('lodestar-consult') && !body.includes('consult-cli')) {
      log(`command: obsolete path preserved because ownership is unclear ${legacy}`)
      return
    }
    unlinkSync(legacy)
    log(`command: removed obsolete ${legacy}`)
  } catch (error) {
    log(`command: obsolete removal failed (${legacy}): ${error}`)
  }
}

function writeFileIfChanged(path: string, body: string, mode?: number): void {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null
  if (current === body) return
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, body)
  renameSync(tmp, path)
  if (mode != null && process.platform !== 'win32') {
    try { chmodSync(path, mode) } catch { /* best-effort */ }
  }
}

function prependPath(env: NodeJS.ProcessEnv, dir: string, platform: NodeJS.Platform): void {
  const sep = platform === 'win32' ? ';' : ':'
  const current = env.PATH ?? env.Path ?? ''
  const parts = current.split(sep).filter(Boolean)
  if (parts[0] === dir) return
  env.PATH = [dir, ...parts.filter(part => part !== dir)].join(sep)
  if (platform === 'win32') env.Path = env.PATH
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

function windowsQuote(value: string): string {
  return value.replace(/"/g, '""')
}
