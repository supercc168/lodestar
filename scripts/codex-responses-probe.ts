#!/usr/bin/env bun

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentResultEvent } from '../src/agent-process'
import { codexModelEffort, codexModelIsGrok, codexModelProfile } from '../src/codex-models'
import { CODEX_EFFORT, CodexProcess } from '../src/codex-process'
import { resolveTokenSource } from '../src/token-source'

const rawSelection = process.argv[2]?.trim()
if (!rawSelection) {
  throw new Error('usage: bun scripts/codex-responses-probe.ts codex:<non-grok-responses-profile>')
}
const selection = rawSelection.startsWith('codex:') ? rawSelection : `codex:${rawSelection}`
if (codexModelIsGrok(selection)) {
  throw new Error('Grok profiles must use claude-stream-probe.ts through Claude Agent SDK')
}
const source = resolveTokenSource('codex', selection)
const profile = codexModelProfile(selection)
const overrides = source.spawnOverrides()
const effort = codexModelEffort(selection) ?? CODEX_EFFORT

if (!profile || !source.isApiRoute()) {
  throw new Error(`${selection} is not a Codex API route`)
}
if (!source.enabled()) {
  throw new Error(`${selection} is not configured`)
}
if (!overrides.modelId) {
  throw new Error(`${selection} has no configured model`)
}
const responsesConfig = overrides.configArgs.some(arg => arg.endsWith('.wire_api="responses"'))
if (!responsesConfig) {
  throw new Error(`${selection} must use wire_api="responses" for this probe`)
}

const root = mkdtempSync(join(tmpdir(), 'lodestar-codex-responses-probe-'))
const workDir = join(root, 'work')
mkdirSync(workDir)

const summary = {
  selection,
  requestedModel: overrides.modelId,
  effort,
  wireApi: 'responses',
  initialized: false,
  assistantText: false,
  toolNames: [] as string[],
  successfulToolResults: 0,
  processErrors: [] as string[],
  resultSubtype: null as string | null,
  resultIsError: null as boolean | null,
  runtimeError: null as string | null,
  passed: false,
}

let proc: CodexProcess | null = null
let finished = false

try {
  proc = new CodexProcess({
    workDir,
    model: overrides.modelId,
    effort,
    configArgs: overrides.configArgs,
    providerEnv: overrides.env,
  })

  const result = new Promise<AgentResultEvent>((resolve, reject) => {
    proc!.on('init', () => { summary.initialized = true })
    proc!.on('assistant_text', ({ text }: { text?: string }) => {
      if (text) summary.assistantText = true
    })
    proc!.on('tool_use', ({ name }: { name?: string }) => {
      if (name) summary.toolNames.push(name)
    })
    proc!.on('tool_result', ({ is_error }: { is_error?: boolean }) => {
      if (is_error === false) summary.successfulToolResults++
    })
    proc!.on('result', (event: AgentResultEvent) => {
      finished = true
      resolve(event)
    })
    // app-server 会把可重试的 response stream 断线也作为 error event 上报，
    // 同时在内部继续 1/5... 重试。探针记录它，但以最终 result/exit 为准。
    proc!.on('error', (error: Error) => {
      summary.processErrors.push(error.message)
    })
    proc!.on('exit', ({ code, signal, expected }) => {
      if (!finished && !expected) reject(new Error(`codex app-server exited code=${code} signal=${signal}`))
    })
  })

  const dispatch = proc.sendUserText([
    'This is a transport compatibility probe.',
    'Use the shell exactly once to run: printf CODEX_RESPONSES_TOOL_OK',
    'After the command succeeds, report its output in one sentence and stop.',
  ].join('\n'))
  if (dispatch.kind === 'rejected') throw dispatch.error
  if (dispatch.kind !== 'turn_start_pending') {
    throw new Error(`unexpected dispatch kind: ${dispatch.kind}`)
  }

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('probe timed out after 120 seconds')), 120_000)
  })
  const settlement = await Promise.race([dispatch.settlement, timeout])
  if (settlement.kind === 'rejected') throw settlement.error
  const completed = await Promise.race([result, timeout])
  summary.resultSubtype = completed.subtype ?? null
  summary.resultIsError = completed.is_error ?? false
  summary.passed = summary.initialized
    && summary.toolNames.some(name => name === 'Bash' || name === 'exec_command')
    && summary.successfulToolResults > 0
    && summary.resultSubtype === 'success'
    && summary.resultIsError === false
} catch (error) {
  summary.runtimeError = error instanceof Error ? error.message : String(error)
} finally {
  if (proc?.isAlive()) await proc.kill(5_000)
  rmSync(root, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
process.exit(summary.passed ? 0 : 1)
