import type { ProjectProfile } from './config'
import type {
  AgentProcess,
  AgentProvider,
  AgentReasoningEffort,
} from './agent-process'
import { isClaudeReasoningEffort } from './agent-process'
import { ClaudeAgentProcess, assertClaudeCodeAvailable } from './claude-agent-process'
import { CodexProcess, CODEX_EFFORT, isCodexReasoningEffort } from './codex-process'
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
