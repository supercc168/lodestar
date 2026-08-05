#!/usr/bin/env bun
// 探针:验证 Claude Agent SDK streamInput 模式下,把 `/compact` 当 user 消息发送,
// CLI 是否把它当 local command 执行(emit compact_boundary / status=compacting),
// 还是当普通文本送给模型。结论决定 claude-agent-process 的 compactThread() 能否据此实现。
//
// 用法:bun scripts/claude-compact-probe.ts [claude:<slug>]   默认 claude:glm
// 需要:一个已配置且 enabled 的 Claude API 档位(走第三方端点,绕开 reclaude 包装器)。

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { claudeSdkReasoningOptions } from '../src/claude-agent-process'
import { claudeModelEffort } from '../src/claude-models'
import { resolveTokenSource } from '../src/token-source'

const rawSelection = process.argv[2]?.trim() || 'claude:glm'
const selection = rawSelection.startsWith('claude:') ? rawSelection : `claude:${rawSelection}`
const source = resolveTokenSource('claude', selection)
if (!source.enabled()) throw new Error(`${selection} 未配置/enabled`)
if (!source.isApiRoute()) throw new Error(`${selection} 不是 API 路由(探针需第三方端点)`)
const model = source.resolveSpawnModel()
if (!model) throw new Error(`${selection} 无 model id`)
const env = source.spawnEnv({ ...(process.env as Record<string, string>), PATH: process.env.PATH! })
const reasoningOptions = claudeSdkReasoningOptions(selection, claudeModelEffort(selection) ?? 'max')

// ── 最小可推送的 async 输入流(SDK 的 prompt 接受 AsyncIterable 即进入 streamInput 模式)
function makeInputStream() {
  const buffer: SDKUserMessage[] = []
  const waiters: Array<() => void> = []
  let closed = false
  return {
    push(msg: SDKUserMessage) { buffer.push(msg); for (const w of waiters.splice(0)) w() },
    close() { closed = true; for (const w of waiters.splice(0)) w() },
    stream: {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<SDKUserMessage>> {
            if (buffer.length > 0) return { value: buffer.shift()!, done: false }
            if (closed) return { value: undefined as any, done: true }
            await new Promise<void>(r => waiters.push(r))
            if (buffer.length > 0) return { value: buffer.shift()!, done: false }
            return { value: undefined as any, done: true }
          },
        }
      },
    } as AsyncIterable<SDKUserMessage>,
  }
}

const root = mkdtempSync(join(tmpdir(), 'lodestar-compact-probe-'))
const workDir = join(root, 'work')
mkdirSync(workDir)
const abortController = new AbortController()
const timeout = setTimeout(() => abortController.abort(new Error('probe 超时 120s')), 120_000)

const input = makeInputStream()
let sessionId = ''
let sawInit = false
let firstResultSeen = false
let pushedCompact = false
let compactBoundarySeen = false
let compactingStatusSeen = false
let postCompactAssistantText = ''
const trace: string[] = []

function userMsg(text: string): SDKUserMessage {
  return {
    type: 'user',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text }] },
    priority: 'now',
  } as SDKUserMessage
}

// 先造多轮上下文(让 /compact 有足够消息可压,跨过 CLI 的 "Not enough messages" 阈值),再 /compact
const preCompactPrompts = [
  'Tell me a very short joke.',
  'Tell me another short joke.',
  'Name three primary colors.',
  'What is the capital of France?',
  'Give me one short fun fact.',
]
let preIndex = 0
input.push(userMsg(preCompactPrompts[0]))

try {
  const messages = query({
    prompt: input.stream,
    options: {
      cwd: workDir,
      model,
      ...reasoningOptions,
      ...(reasoningOptions.thinking ? {} : { thinking: { type: 'adaptive' as const } }),
      env,
      abortController,
      settingSources: [],
      maxTurns: 20,
      permissionMode: 'default',
      canUseTool: async (_t: string, i: any) => ({ behavior: 'allow' as const, updatedInput: i }),
    },
  })

  for await (const message of messages as AsyncIterable<SDKMessage>) {
    const m = message as any
    if (typeof m.session_id === 'string' && m.session_id) sessionId = m.session_id
    const label = `${m.type}${m.subtype ? '/' + m.subtype : ''}${m.status ? ' status=' + m.status : ''}`
    trace.push(label)

    if (m.type === 'system' && m.subtype === 'init') sawInit = true
    if (m.type === 'system' && m.subtype === 'compact_boundary') compactBoundarySeen = true
    if (m.type === 'system' && m.subtype === 'status' && m.status === 'compacting') compactingStatusSeen = true

    // 收集 /compact 之后若被当文本,模型会生成的正文
    if (pushedCompact && m.type === 'assistant') {
      for (const block of m.message?.content ?? []) {
        if (block?.type === 'text' && typeof block.text === 'string') postCompactAssistantText += block.text
      }
    }

    // 每个 turn 结束(result):若还有预热消息就推下一条;否则推 /compact
    if (m.type === 'result') {
      firstResultSeen = true
      if (preIndex < preCompactPrompts.length - 1) {
        preIndex++
        input.push(userMsg(preCompactPrompts[preIndex]))
        trace.push(`>>> PUSHED pre-compact #${preIndex} <<<`)
      } else if (!pushedCompact) {
        input.push(userMsg('/compact'))
        pushedCompact = true
        trace.push('>>> PUSHED /compact <<<')
      }
    }
  }
} catch (e) {
  trace.push(`ERROR: ${e instanceof Error ? e.message : String(e)}`)
} finally {
  input.close()
  clearTimeout(timeout)
  rmSync(root, { recursive: true, force: true })
}

console.log('====== /compact streamInput 探针结论 ======')
console.log(`selection=${selection} model=${model}`)
console.log(`sawInit=${sawInit} firstResult=${firstResultSeen} pushedCompact=${pushedCompact}`)
console.log(`compact_boundary 命中=${compactBoundarySeen}`)
console.log(`status=compacting 命中=${compactingStatusSeen}`)
console.log(`/compact 后模型正文(前 200 字): ${JSON.stringify(postCompactAssistantText.slice(0, 200))}`)
console.log(`判定: ${compactBoundarySeen || compactingStatusSeen
  ? '✅ /compact 被 CLI 当 local command 执行了压缩(compactThread 可据此实现)'
  : '❌ /compact 未触发压缩(可能被当文本/不支持)'}`)
console.log('--- 事件轨迹 ---')
console.log(trace.join('\n'))
