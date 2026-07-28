#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  query,
  type EffortLevel,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { claudeSdkReasoningOptions } from '../src/claude-agent-process'
import { claudeModelEffort } from '../src/claude-models'
import { resolveTokenSource } from '../src/token-source'

const rawSelection = process.argv[2]?.trim() || 'claude:glm'
const selection = rawSelection.startsWith('claude:') ? rawSelection : `claude:${rawSelection}`
const source = resolveTokenSource('claude', selection)
const requestedModel = source.resolveSpawnModel()
const reasoningOptions = claudeSdkReasoningOptions(selection, claudeModelEffort(selection) ?? 'max')
const reasoningMode = process.argv[3]?.trim() || 'production'
const grokCompatibility = reasoningOptions.thinking?.type === 'disabled'

function probeReasoningOptions(): {
  effort?: EffortLevel
  thinking?: { type: 'disabled' | 'adaptive' }
} {
  if (!grokCompatibility || reasoningMode === 'production') return reasoningOptions
  switch (reasoningMode) {
    case 'xhigh':
      return { effort: 'xhigh', thinking: { type: 'disabled' } }
    case 'max':
      return { effort: 'max', thinking: { type: 'disabled' } }
    case 'xhigh-adaptive':
      return { effort: 'xhigh', thinking: { type: 'adaptive' } }
    case 'max-adaptive':
      return { effort: 'max', thinking: { type: 'adaptive' } }
    default:
      throw new Error('reasoning mode must be production, xhigh, max, xhigh-adaptive, or max-adaptive')
  }
}

const queryReasoningOptions = probeReasoningOptions()
const allowsNoThinking = queryReasoningOptions.thinking?.type === 'disabled'

if (!source.isApiRoute()) {
  throw new Error(`${selection} is not a Claude API route`)
}
if (!source.enabled()) {
  throw new Error(`${selection} is not configured`)
}
if (!requestedModel) {
  throw new Error(`${selection} has no configured model`)
}

const root = mkdtempSync(join(tmpdir(), 'lodestar-claude-stream-probe-'))
const workDir = join(root, 'work')
const claudeConfigDir = join(root, 'claude-config')
mkdirSync(workDir)
mkdirSync(claudeConfigDir)

const abortController = new AbortController()
const timeout = setTimeout(() => abortController.abort(new Error('probe timed out')), 120_000)

type StreamSummary = {
  selection: string
  requestedModel: string
  reasoningMode: string
  queryEffort: string | null
  queryThinking: string | null
  initModel: string | null
  initModelMatchesRequested: boolean
  assistantModels: string[]
  assistantModelRemapped: boolean
  rawHttpStatus: number | null
  rawResponseModel: string | null
  rawToolChoiceHonored: boolean
  rawProtocolErrors: string[]
  rawRuntimeError: string | null
  sawThinking: boolean
  sawText: boolean
  sawToolUse: boolean
  sawToolResult: boolean
  sawStartMarker: boolean
  sawDoneMarker: boolean
  observedEffort: string | null
  resultSubtype: string | null
  resultIsError: boolean | null
  protocolErrors: string[]
  runtimeError: string | null
  rawPassed: boolean
  sdkPassed: boolean
  passed: boolean
}

const summary: StreamSummary = {
  selection: source.selectionModel,
  requestedModel,
  reasoningMode,
  queryEffort: queryReasoningOptions.effort ?? null,
  queryThinking: queryReasoningOptions.thinking?.type ?? null,
  initModel: null,
  initModelMatchesRequested: false,
  assistantModels: [],
  assistantModelRemapped: false,
  rawHttpStatus: null,
  rawResponseModel: null,
  rawToolChoiceHonored: false,
  rawProtocolErrors: [],
  rawRuntimeError: null,
  sawThinking: false,
  sawText: false,
  sawToolUse: false,
  sawToolResult: false,
  sawStartMarker: false,
  sawDoneMarker: false,
  observedEffort: null,
  resultSubtype: null,
  resultIsError: null,
  protocolErrors: [],
  runtimeError: null,
  rawPassed: false,
  sdkPassed: false,
  passed: false,
}

const startedBlocks = new Map<number, string>()
const stoppedBlocks = new Set<number>()
const assistantModels = new Set<string>()

function messagesEndpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, '')
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`
}

async function runRawToolProbe(env: Record<string, string>): Promise<void> {
  const baseUrl = env.ANTHROPIC_BASE_URL
  const token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY
  if (!baseUrl || !token) throw new Error('raw probe has no base URL or token')

  const response = await fetch(messagesEndpoint(baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: requestedModel,
      max_tokens: 1024,
      stream: true,
      messages: [{ role: 'user', content: 'Call lodestar_probe with value GROK_TOOL_OK.' }],
      tools: [{
        name: 'lodestar_probe',
        description: 'Transport compatibility probe.',
        input_schema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      }],
      tool_choice: { type: 'tool', name: 'lodestar_probe' },
    }),
    signal: abortController.signal,
  })
  summary.rawHttpStatus = response.status
  const body = await response.text()
  if (!response.ok) throw new Error(`raw probe HTTP ${response.status}`)

  const started = new Map<number, string>()
  const stopped = new Set<number>()
  for (const frame of body.split(/\n\n+/)) {
    const dataLines = frame.split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice('data:'.length).trimStart())
    if (dataLines.length === 0) continue
    let event: any
    try {
      event = JSON.parse(dataLines.join('\n'))
    } catch {
      summary.rawProtocolErrors.push('invalid SSE JSON')
      continue
    }
    const index = typeof event.index === 'number' ? event.index : null
    if (event.type === 'message_start') {
      summary.rawResponseModel = typeof event.message?.model === 'string' ? event.message.model : null
    } else if (event.type === 'content_block_start') {
      if (index === null) {
        summary.rawProtocolErrors.push('raw content_block_start missing index')
        continue
      }
      if (started.has(index) && !stopped.has(index)) {
        summary.rawProtocolErrors.push(`raw duplicate content_block_start index=${index}`)
      }
      const type = String(event.content_block?.type ?? 'unknown')
      started.set(index, type)
      stopped.delete(index)
      if (type === 'tool_use' || type === 'server_tool_use') summary.rawToolChoiceHonored = true
    } else if (event.type === 'content_block_delta') {
      if (index === null || !started.has(index)) {
        summary.rawProtocolErrors.push(`raw content_block_delta without start index=${String(index)}`)
      }
    } else if (event.type === 'content_block_stop') {
      if (index === null || !started.has(index)) {
        summary.rawProtocolErrors.push(`raw content_block_stop without start index=${String(index)}`)
      } else {
        stopped.add(index)
      }
    }
  }
}

function inspectStreamEvent(message: SDKMessage): void {
  if (message.type !== 'stream_event') return
  const event = message.event as any
  const index = typeof event.index === 'number' ? event.index : null
  switch (event.type) {
    case 'content_block_start': {
      if (index === null) {
        summary.protocolErrors.push('content_block_start missing index')
        return
      }
      if (startedBlocks.has(index) && !stoppedBlocks.has(index)) {
        summary.protocolErrors.push(`duplicate content_block_start index=${index}`)
      }
      const type = String(event.content_block?.type ?? 'unknown')
      startedBlocks.set(index, type)
      stoppedBlocks.delete(index)
      if (type === 'thinking' || type === 'redacted_thinking') summary.sawThinking = true
      if (type === 'text') summary.sawText = true
      if (type === 'tool_use' || type === 'server_tool_use') summary.sawToolUse = true
      return
    }
    case 'content_block_delta': {
      if (index === null || !startedBlocks.has(index)) {
        summary.protocolErrors.push(`content_block_delta without start index=${String(index)}`)
        return
      }
      const type = String(event.delta?.type ?? '')
      if (type === 'thinking_delta' || type === 'signature_delta') summary.sawThinking = true
      if (type === 'text_delta') summary.sawText = true
      if (type === 'input_json_delta') summary.sawToolUse = true
      return
    }
    case 'content_block_stop':
      if (index === null || !startedBlocks.has(index)) {
        summary.protocolErrors.push(`content_block_stop without start index=${String(index)}`)
        return
      }
      stoppedBlocks.add(index)
      return
  }
}

function inspectMessage(message: SDKMessage): void {
  inspectStreamEvent(message)
  if (message.type === 'system' && message.subtype === 'init') {
    summary.initModel = message.model
    return
  }
  if (message.type === 'assistant') {
    if (message.message.model) assistantModels.add(message.message.model)
    for (const block of message.message.content as any[]) {
      if (block?.type === 'thinking' || block?.type === 'redacted_thinking') summary.sawThinking = true
      if (block?.type === 'text' && block.text) {
        summary.sawText = true
        summary.sawStartMarker ||= block.text.includes('PROBE_START')
        summary.sawDoneMarker ||= block.text.includes('PROBE_DONE')
      }
      if (block?.type === 'tool_use' || block?.type === 'server_tool_use') summary.sawToolUse = true
    }
    return
  }
  if (message.type === 'user') {
    const content = Array.isArray(message.message.content) ? message.message.content : []
    for (const block of content as any[]) {
      if (block?.type !== 'tool_result') continue
      summary.sawToolResult = true
      const resultText = typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content ?? '')
      const effort = resultText.match(/GROK_TOOL_OK:([a-z]+)/i)?.[1]
      if (effort) summary.observedEffort = effort.toLowerCase()
    }
    return
  }
  if (message.type === 'result') {
    summary.resultSubtype = message.subtype
    summary.resultIsError = message.is_error
  }
}

try {
  const env = source.spawnEnv({
    ...(process.env as Record<string, string>),
    CLAUDE_CONFIG_DIR: claudeConfigDir,
  })
  try {
    await runRawToolProbe(env)
  } catch (error) {
    summary.rawRuntimeError = error instanceof Error ? error.message : String(error)
  }
  const messages = query({
    prompt: [
      'This is a transport compatibility probe.',
      'First output exactly PROBE_START as ordinary assistant text.',
      'Then call Bash exactly once with: printf \'GROK_TOOL_OK:%s\' "$CLAUDE_EFFORT"',
      'After reading the tool result, output exactly PROBE_DONE and stop.',
      'Do not call any other tool.',
    ].join('\n'),
    options: {
      cwd: workDir,
      model: requestedModel,
      ...queryReasoningOptions,
      ...(queryReasoningOptions.thinking ? {} : { thinking: { type: 'adaptive' as const } }),
      env,
      abortController,
      settingSources: [],
      tools: ['Bash'],
      includePartialMessages: true,
      maxTurns: 4,
      permissionMode: 'default',
      canUseTool: async (_toolName, input) => ({
        behavior: 'allow',
        updatedInput: input,
      }),
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
      },
    },
  })

  for await (const message of messages) inspectMessage(message)
} catch (error) {
  summary.runtimeError = error instanceof Error ? error.message : String(error)
} finally {
  clearTimeout(timeout)
  summary.assistantModels = [...assistantModels]
  summary.initModelMatchesRequested = summary.initModel === requestedModel
  summary.assistantModelRemapped = summary.assistantModels.some(model => model !== requestedModel)
  summary.rawPassed = summary.rawHttpStatus === 200
    && summary.rawToolChoiceHonored
    && summary.rawProtocolErrors.length === 0
    && summary.rawRuntimeError === null
  summary.sdkPassed = summary.initModelMatchesRequested
    && (allowsNoThinking || summary.sawThinking)
    && summary.sawText
    && summary.sawToolUse
    && summary.sawToolResult
    // Some Grok Anthropic gateways invoke the requested tool before emitting
    // ordinary text. That ordering is valid as long as the tool/result chain
    // and terminal marker are complete.
    && (grokCompatibility || summary.sawStartMarker)
    && summary.sawDoneMarker
    && summary.resultSubtype === 'success'
    && summary.resultIsError === false
    && summary.protocolErrors.length === 0
    && summary.runtimeError === null
  summary.passed = summary.rawPassed && summary.sdkPassed
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  rmSync(root, { recursive: true, force: true })
}

process.exit(summary.passed ? 0 : 1)
