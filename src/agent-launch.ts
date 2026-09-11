import type { ProjectProfile } from './config'
import type {
  AgentProcess,
  AgentProvider,
  AgentReasoningEffort,
} from './agent-process'
import { isClaudeReasoningEffort, isDshReasoningEffort } from './agent-process'
import { ClaudeAgentProcess, assertClaudeCodeAvailable } from './claude-agent-process'
import { CodexProcess, CODEX_EFFORT, isCodexReasoningEffort } from './codex-process'
import { DshProcess } from './dsh-process'
import type { ConversationLaunch } from './conversation'
import { listTokenSources, resolveTokenSource } from './token-source'

export interface AgentLaunchOptions {
  provider: AgentProvider
  workDir: string
  tokenSourceId: string | null
  model?: string
  effort?: AgentReasoningEffort
  launch?: ConversationLaunch
  developerInstructions?: string
  profile?: ProjectProfile
  hostEnv?: Record<string, string | undefined>
  serviceName?: string
}

export interface CreatedAgentProcess {
  process: AgentProcess
}

/** Single source of truth for both the Feishu main Session and delegated
 * agents. Capability differences are expressed only by the caller's prompt;
 * this factory always launches the backend's full coding-agent surface.
 *
 * Local slim port of 8881f69: lookup via listTokenSources, spawn via
 * resolveTokenSource(provider, selectionModel). No upstream registry lookup. */
export function createAgentProcess(opts: AgentLaunchOptions): CreatedAgentProcess {
  const source = opts.tokenSourceId
    ? listTokenSources().find(entry => entry.id === opts.tokenSourceId)
    : undefined
  if (opts.tokenSourceId && !source) throw new Error(`token source not found: ${opts.tokenSourceId}`)
  if (source && !source.enabled()) throw new Error(`token source disabled: ${source.id}`)
  if (source && source.provider !== opts.provider) {
    throw new Error(`token source ${source.id} belongs to ${source.provider}, not ${opts.provider}`)
  }
  const selectionModel = opts.model ?? source?.selectionModel
  const resolved = resolveTokenSource(opts.provider, selectionModel)

  if (opts.provider === 'dsh') {
    // DSH 单档后端:模型与凭据同来自 [deepseek-harness],选择键就是该段派生的
    // source id。effort 词表来自子进程上报的 native 档位(off/low/high/max),
    // 与 Codex/Claude 档位不互通 —— 不合法即抛错,不静默换档。
    if (!source || !selectionModel || !isDshReasoningEffort(opts.effort)) {
      throw new Error('DSH requires a configured source, model and valid effort')
    }
    const dshSource = source
    return {
      process: new DshProcess({
        workDir: opts.workDir,
        tokenSourceId: dshSource.id,
        model: selectionModel,
        effort: opts.effort,
        launch: opts.launch,
        developerInstructions: opts.developerInstructions,
        profile: opts.profile,
        hostEnv: opts.hostEnv,
        // 凭据单入口(D-08 双轨隔离的本地点):先 scrub ANTHROPIC_* 与旧
        // DSH_*/DEEPSEEK_*,再注入本档 DEEPSEEK_*。TokenSource.spawnEnv 的入参
        // 收窄为 string 值,DshSpawnOptions.transformEnv 允许 undefined,
        // 故只在这一个边界做窄化,不引入第二套清洗逻辑。
        transformEnv: base => dshSource.spawnEnv(base as Record<string, string>),
      }),
    }
  }

  if (opts.provider === 'claude') {
    assertClaudeCodeAvailable()
    if (!isClaudeReasoningEffort(opts.effort)) throw new Error(`invalid Claude effort: ${opts.effort ?? 'MISS'}`)
    return {
      process: new ClaudeAgentProcess({
        workDir: opts.workDir,
        model: selectionModel,
        effort: opts.effort,
        ...(opts.launch?.kind === 'fresh' || !opts.launch
          ? {}
          : {
              resumeSessionId: opts.launch.source.sessionId,
              ...(opts.launch.kind === 'fork' ? { forkSession: true } : {}),
              ...(opts.launch.kind === 'fork' && opts.launch.through?.provider === 'claude'
                ? { resumeSessionAt: opts.launch.through.id }
                : {}),
            }),
        ...(opts.developerInstructions ? { appendSystemPrompt: opts.developerInstructions } : {}),
        ...(opts.profile ? { profile: opts.profile } : {}),
        hostEnv: opts.hostEnv,
      }),
    }
  }

  if (opts.effort !== undefined && !isCodexReasoningEffort(opts.effort)) {
    throw new Error(`invalid Codex effort: ${opts.effort}`)
  }
  const overrides = resolved.spawnOverrides()
  return {
    process: new CodexProcess({
      workDir: opts.workDir,
      model: overrides.modelId,
      effort: opts.effort ?? CODEX_EFFORT,
      launch: opts.launch,
      ...(opts.developerInstructions ? { appendSystemPrompt: opts.developerInstructions } : {}),
      configArgs: overrides.configArgs,
      providerEnv: overrides.env,
      hostEnv: opts.hostEnv,
      serviceName: opts.serviceName ?? 'lodestar-agent',
    }),
  }
}
