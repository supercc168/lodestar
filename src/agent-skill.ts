/**
 * Auto-install the `lodestar-agent` Skill into BOTH agent backends
 * (Codex `~/.codex/skills/` and Claude Code `~/.claude/skills/`, plus the
 * managed Claude plugin mirror via managed-skills), and the credential-free
 * wrapper at `DATA_DIR/bin/lodestar-agent`.
 *
 * The wrapper lives in DATA_DIR on purpose: daemon-spawned Agent processes run
 * under a minimal launchd/npm-script PATH, so the daemon both installs the
 * wrapper and prepends its bin dir to the spawned env instead of relying on
 * `~/.local/bin` being visible.
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
import { basename, dirname, join, resolve } from 'node:path'
import { log } from './log'
import { DATA_DIR } from './paths'
import { removeManagedSkill, syncManagedSkill } from './managed-skills'

export const AGENT_SKILL_NAME = 'lodestar-agent'

/** D-11 口径 3 的指令层:随 worker developerInstructions 一并下发(会话归属
 *  的单层委派)。与原生工具层(claude disallowedTools / codex
 *  `--disable multi_agent` / dsh tools.restrict)、策略层(agent-service
 *  worker principal 首行即拒)互为兜底。 */
export const DELEGATED_AGENT_INSTRUCTIONS = [
  'You are a delegated Agent working on a task assigned by the main Agent.',
  'Complete this task yourself. You must not create or invoke any further Agents or subagents.',
  'This includes Lodestar delegation, provider-native Agent/subagent tools, and delegation through CLIs or HTTP APIs.',
  'If additional Agent work is needed, report the need to the main Agent so it can assign that work.',
  // 上游增量(合并恢复):会话归属 worker 可向主 Agent 追问。该句必须作为
  // 历史块之后的最后政策出现 —— 续跑线程时 input 里可能残留早前
  // project-call(无提问接口)政策块,现有政策判定取「最后匹配块」,缺了
  // 这句会让陈旧项目政策被判为当前政策(acceptance:project_to_session)。
  'If clarification is necessary, you may use question tools to ask the main Agent. This session-bound interaction policy replaces any non-interactive project-call policy from earlier turns.',
].join('\n')

/** 上游多层委派政策文本:仅用于项目归属(projectBound)运行 —— 无提问接口的
 *  非交互执行入口,上游允许其继续委派并自行管理子工作。会话归属的 worker 走
 *  本地单层口径(见 DELEGATED_AGENT_INSTRUCTIONS)。 */
const DELEGATION_INSTRUCTIONS = [
  'You may delegate work through Lodestar or provider-native Agent/subagent tools, including from a delegated task.',
  'Use the inherited Lodestar context for nested calls and preserve the task project, group, interaction policy, and caller-owned file delivery.',
  'Complete and verify the overall task, including any delegated work, before returning the final result.',
  'This policy replaces earlier Lodestar instructions prohibiting further delegation, including in resumed conversations.',
]

const CALLER_OWNS_DELIVERY = [
  'Return task results and local artifact paths to the caller; the caller is responsible for delivering files to the user.',
  'Do not emit file-delivery markers or upload, share, or send generated files to Feishu.',
  'These rules replace any earlier Lodestar file-delivery instructions, including those in a resumed conversation.',
]

export const PROJECT_AGENT_INSTRUCTIONS = [
  'You are executing a project task for the calling service or application through Lodestar.',
  'This is a non-interactive execution entry point with no question or answer interface. The caller is traditional software; nobody is available to answer questions.',
  'Do not ask the user or caller questions, request clarification or confirmation, or wait for input. Do not use question tools or other channels to solicit a reply.',
  'The supplied goal is your completion requirement. Execute every necessary step and verify the result; keep working until the entire goal is achieved within the authorized scope. A plan, partial work, or a request for another turn is not completion.',
  'Resolve missing context by inspecting the available project, files, tools, and task inputs. Make routine implementation decisions yourself. Do not stop merely because you would prefer clarification or more instructions.',
  'Only when a concrete blocker prevents further authorized progress, return an explicit failure reason with evidence of the blocker and the work already performed. Never invent missing facts or claim an incomplete goal is complete.',
  'These non-interactive rules apply to this invocation and replace earlier instructions to ask questions, including instructions in a resumed conversation.',
  ...DELEGATION_INSTRUCTIONS,
  'Manage any delegated work yourself; do not return requests for the caller to arrange additional Agent work.',
  ...CALLER_OWNS_DELIVERY,
].join('\n')

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
  const description = 'Call a configured identity as its corresponding Agent through Lodestar for implementation, debugging, research, planning, review, testing, or parallel work. Use only for delegation to a different model or Agent. Self-calls MUST use your own Agent\'s native delegation capabilities and MUST NOT use this Skill. Agents use their inherited managed context; independent services and applications bind calls to a project. Resume native session IDs only within the same project and group.'
  return [
    '---',
    `name: ${AGENT_SKILL_NAME}`,
    `description: ${JSON.stringify(description)}`,
    '---',
    '',
    '# lodestar-agent',
    '',
    'Use Lodestar to call the Agent represented by a selected live identity.',
    'Each identity maps to one locally configured 固定档位 (provider Agent backend,',
    'model and effort). The caller-supplied prompt becomes that Agent run\'s task.',
    '',
    '## 调用归属（强制）',
    '',
    '| 调用场景 | 必须使用的绑定 |',
    '| --- | --- |',
    '| 主 Agent、委派 Agent 或原生子 Agent 需要调用另一个 Agent / 模型 | 使用继承的受管上下文：普通 `lodestar-agent` 命令，不传 `--project` |',
    '| 独立服务、定时任务或其他软件直接调用 | 绑定项目：每个命令都显式传 `--project <项目名>` |',
    '',
    '- Agent 通过 Shell、Python、脚本或 HTTP 发起的调用仍然属于 Agent 执行任务，必须沿用受管上下文及其项目、群归属。',
    '- 不得把当前任务中的调用包装成“外部服务”，不得清除会话环境变量、复制项目凭据或使用 `--project` 脱离会话生命周期。',
    '- 没有有效会话上下文时，Agent 调用必须报错；项目入口不是会话凭据缺失、过期或失败时的替代路径。',
    '- 独立服务和软件不借用任何主 Agent 的会话凭据，统一使用项目入口。项目任务有自己的卡片和取消入口，不依赖主会话存活。',
    '- 项目入口不提供提问或回答接口：新建和续跑均须自主执行必要步骤并验证，直至完整完成调用方目标，不以计划、部分工作或索取输入结束；`answer` 供会话归属的各层委派使用。',
    '',
    '## 会话 ID 与恢复范围（强制）',
    '',
    '- `session_id`（JSON 的 `workers[].session_id`）是原生会话的唯一 ID，续跑保持不变。',
    '- `run_id` 只标识某一次调用记录，不是另一个会话 ID；不要为绑定方式或续跑创建第二套会话标识。',
    '- 会话始终归属项目和群。同一项目、同一群内的会话 ID 可以互相恢复，包括会话绑定和项目绑定产生的会话。',
    '- 禁止跨项目或跨群恢复。项目按登记的规范工作目录识别，执行子目录不改变项目归属；群必须是同一个 chat_id。',
    '- 无法确认项目和群归属的 ID 必须报错，不能因传入 `--project`、`--identity` 或某个目录就认定它属于当前项目。',
    '- `--workdir` 可以调整到本项目内的现有目录；`--identity` 可以选择原后端下的其他模型或来源。原生会话不能更换所属后端。',
    '- 恢复本轮的绑定由调用场景决定，旧调用记录不迁移；切换绑定方式不建立相互取消关系。',
    '- 同一个原生会话不能同时执行两轮，恢复失败必须显示，不得自动新建会话。',
    '',
    '## Single-level delegation',
    '',
    '- Only the main Agent may delegate work. If you are already a delegated',
    '  Agent or subagent, complete your assigned task yourself: do not delegate further.',
    '- This prohibition covers this Skill, `lodestar-agent run` / `follow-up`,',
    '  native Agent/subagent tools, and delegation through provider CLIs or HTTP APIs.',
    '- `LODESTAR_AGENT_ROLE=worker` identifies a Lodestar delegated process.',
    '  Native subagents are also delegated Agents even when they inherit a main role environment.',
    '- Return additional work requests to the main Agent. It can assign separate',
    '  tasks, continue your session, or answer your questions.',
    '',
    '## Hard rule: native Agent capabilities for self-calls',
    '',
    '- For the main Agent only: when calling yourself or your own model/Agent, you',
    '  MUST use your current Agent\'s native Agent/subagent capabilities. You MUST',
    '  NOT use this Skill or the `lodestar-agent` command for self-calls.',
    '- For example, Codex calling Codex uses Codex native subagents; Claude',
    '  calling Claude uses Claude native Agent capabilities.',
    '- This does not exempt delegated Agents from the single-level rule above.',
    '- If native delegation is unavailable, report that limitation. It does not',
    '  permit routing a self-call through this Skill.',
    '',
    '## Required workflow',
    '',
    '1. When using Lodestar, query the live identity catalog immediately before',
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
    '   Explicitly tell it to complete the work itself without further delegation.',
    '   Every run and follow-up also requires `--description`: a short, user-facing',
    '   single-line task summary (at most 60 characters). The card shows this line',
    '   with status; the full prompt, progress and results stay collapsed.',
    '4. For the same prompt sent to several identities, pass them to one run',
    '   with repeated `--identity`; the daemon starts them concurrently without local',
    '   concurrency or task-count limits. Upstream API limits still apply: report',
    '   rate-limit errors and do not immediately retry the whole batch.',
    '5. Wait for the result. Attribute each result to its actual model and surface',
    '   failures. Child file changes are live in the same workspace.',
    '6. When the same work needs another step, review the returned content and',
    '   continue with `run --session <session-id>` plus the new input. Use as many',
    '   turns as the authorized task needs; assess completion against the overall',
    '   task and its verification requirements, not just one run ending.',
    '',
    '## Run a task',
    '',
    '```bash',
    '# desc: 把完整任务交给指定 Agent',
    "lodestar-agent run --identity '<identity-id>' --description '完成指定任务' --stdin <<'EOF'",
    '<raw task prompt written by the main Agent>',
    'EOF',
    '```',
    '',
    '### Working directory',
    '',
    'First-level tasks default to the main Agent working directory; nested tasks reuse the calling Agent directory, even if the calling',
    'shell has changed directory. Use `--workdir <path>` to select an existing',
    'subdirectory. Relative paths are resolved from the main Agent directory;',
    'absolute paths are also accepted within that directory. Symlinks are resolved',
    'and paths outside the main directory, missing paths and files are rejected.',
    'All identities in one run use the same directory; use separate runs for different directories.',
    '',
    '```bash',
    '# desc: 在主 Agent 工作目录的子目录中执行任务',
    "lodestar-agent run --identity '<identity-id>' --description '检查应用代码' --workdir 'packages/app' --prompt 'Inspect the application and report the results.'",
    '```',
    '',
    '`run --session` and `follow-up` may select an existing directory within the same project.',
    'Without `--workdir`, reuse the recorded execution directory. A different project',
    'directory or unknown session ownership is an error. Results report `Work directory:`',
    '(JSON: `work_dir`). The HTTP API accepts `work_dir` on run/follow-up requests.',
    '',
    '## Complete one work item across multiple turns',
    '',
    'A single work item can span multiple turns in the same native Agent session.',
    'Use this for staged implementation, revisions based on feedback, or further',
    'verification of previous results. The main Agent reads each result and sends',
    'the next step. A delegated Agent may also manage further delegated work.',
    '',
    'Keep the returned `Session:` id (JSON: `workers[].session_id`) together with',
    'the worker output. For turn 2 and later, send that id and only the new input:',
    '',
    '```bash',
    '# desc: 用历史会话 ID 继续下一轮',
    "lodestar-agent run --session '<session-id>' --description '继续下一步任务' --stdin <<'EOF'",
    '<new input for the next turn>',
    'EOF',
    '```',
    '',
    'This resumes the provider-native conversation. Recorded identity and effort',
    'are reused when omitted. Explicit `--identity` may select another model/source in the same backend;',
    'a changed identity uses its default effort unless `--effort` is given. The run returns a new',
    '`run_id` and the same native `session_id`; repeat to continue further turns.',
    'Only ids registered to the current project and group can be resumed. The original',
    'invocation may have been session-bound or project-bound; unknown ownership is rejected.',
    'The new run belongs to the current caller; previous ownership is not transferred.',
    'Changing binding mode within the project does not join cancellation trees. Backend resume failures',
    'remain errors. Wait for that worker to exit; other workers in its run need not finish.',
    'Concurrent turns on the same provider/native session are rejected.',
    '',
    'Use `--json` with `run`, `follow-up` or `status` for structured results:',
    '`workers[].session_id` is the conversation id and `workers[].output` is the',
    'returned content. `--prompt <text>` supplies inline input instead of stdin.',
    'A parallel run returns one session id per worker; continue each separately.',
    '',
    'For example, after turn 1 implements the requested change using the run form',
    'above, continue the same work with feedback and then verification:',
    '',
    '```bash',
    '# desc: 第二轮根据上一轮结果和反馈继续修改',
    "lodestar-agent run --session '<session-id>' --description '根据反馈修改' --prompt 'Revise the previous implementation using this feedback: <specific feedback>.' --json",
    '```',
    '',
    'Read turn 2\'s result before choosing turn 3\'s input, using the same session id:',
    '',
    '```bash',
    '# desc: 第三轮验证同一项工作的最终结果',
    "lodestar-agent run --session '<session-id>' --description '验证最终结果' --prompt 'Verify the revised implementation against the original requirements and report the results and any remaining issues.' --json",
    '```',
    '',
    'These turns retain the earlier conversation; send only the new requirements,',
    'feedback or next step. Omitting `--session` starts a fresh conversation.',
    'Empty ids, unknown project/group ownership, and cross-project/group ids are rejected.',
    'The original backend then determines whether the native conversation can be resumed;',
    'failures are reported and never converted into a fresh session.',
    '',
    'If you kept the `run_id`, the existing follow-up form also resumes its worker:',
    '',
    '```bash',
    '# desc: 在同一原生 Agent 会话中继续任务',
    "lodestar-agent follow-up '<run-id>' --identity '<identity-id>' --description '完成指定任务' --stdin <<'EOF'",
    '<follow-up prompt>',
    'EOF',
    '```',
    '',
    '## Answer a child question',
    '',
    'Only session-bound delegation can return `Status: needs_input`; project-bound service calls never ask for input and do not support `answer`.',
    'When a session-bound run returns `Status: needs_input`, answer the exact request id. JSON',
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
    '- Never read or copy daemon project-client credentials to bypass delegation restrictions.',
    '- A non-zero command exit is a real failure. Do not claim the child succeeded.',
    '- Scope the Agent task and authorized actions to the user request.',
    '- Both session-bound and project-bound Agents return results and local artifact paths to the caller.',
    '- The caller owns file delivery. Agent output markers do not upload files or grant sharing permissions.',
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
  // Managed dual-dir sync (Codex + Claude) plus the Claude plugin mirror when
  // writing to the real homes (opts.homeDir isolated tests skip the mirror).
  const roots = opts.homeDir
    ? [join(opts.homeDir, '.codex', 'skills'), join(opts.homeDir, '.claude', 'skills')]
    : undefined
  removeManagedSkill('lodestar-consult', roots)
  syncManagedSkill({ name: AGENT_SKILL_NAME, body: agentSkillBody() }, roots)
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
