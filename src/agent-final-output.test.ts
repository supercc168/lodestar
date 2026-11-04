import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProcess } from './agent-process'
import { serializeAgentRun } from './agent-api'
import { AgentWorkerFailure, collectAgentTurn } from './agent-runner'
import { AgentService } from './agent-service'
import type { AgentRunSnapshot } from './agent-run-types'
import { AGENT_RUNS_DIR } from './paths'

class FakeProcess extends EventEmitter {
  provider: AgentProcess['provider'] = 'claude'
  tokenSourceId = 'glm'
  sessionId: string | null = 'native-final-output'
  lastAssistantUuid: string | null = null
  lastCompletedTurnId: string | null = null
  lastModel = 'test-model'
  lastEffort = 'max' as const
  lastUsage = null
  lastTotalUsage = null
  lastResult = { subtype: 'success', is_error: false } as any
  lastContextWindow = null
  lastContextTokens = null
  private alive = true

  sendInitialize() {}
  sendUserText() {}
  sendPermissionResponse() {}
  sendHookResponse() {}
  isAlive() { return this.alive }
  async kill() { this.alive = false; this.emit('exit', { code: 0, signal: null, expected: true }) }
}

function emitCompletedBlock(proc: FakeProcess, text: string, parentToolUseId: string | null = null): void {
  proc.emit('assistant_text', { text, parentToolUseId })
  proc.emit('assistant_block_stop', { parentToolUseId })
}

describe('durable Agent final output', () => {
  test('completed block whitespace is preserved byte-for-byte on success and failure', async () => {
    const exact = '  indented final block  \n'
    const successful = new FakeProcess()
    const success = collectAgentTurn(successful as any, 'work', {}, () => {})
    emitCompletedBlock(successful, exact)
    successful.emit('result', { is_error: false })
    await expect(success.done).resolves.toMatchObject({ finalOutput: exact })

    const failed = new FakeProcess()
    const failure = collectAgentTurn(failed as any, 'work', {}, () => {})
    emitCompletedBlock(failed, exact)
    failed.emit('result', { is_error: true, error: 'failed after final block' })
    await expect(failure.done).rejects.toMatchObject({ finalOutput: exact })
  })

  test.each(['codex', 'claude', 'dsh'] as const)('%s promotes only the last completed top-level assistant block', async provider => {
    const proc = new FakeProcess()
    proc.provider = provider
    const handle = collectAgentTurn(proc as any, 'work', {}, () => {})

    emitCompletedBlock(proc, 'first completed')
    emitCompletedBlock(proc, 'child output', 'child-tool')
    proc.emit('assistant_text', { text: 'second ', parentToolUseId: null })
    proc.emit('assistant_text', { text: 'completed', parentToolUseId: null })
    proc.emit('assistant_block_stop', { parentToolUseId: null })
    proc.emit('assistant_block_stop', { parentToolUseId: null })
    emitCompletedBlock(proc, '   ')
    proc.emit('assistant_text', { text: 'unterminated tail', parentToolUseId: null })
    proc.emit('result', { is_error: false })

    await expect(handle.done).resolves.toMatchObject({
      output: 'first completedsecond completed   unterminated tail',
      finalOutput: 'second completed',
    })
  })

  test('failure carries the last completed block without promoting an unterminated tail', async () => {
    const proc = new FakeProcess()
    const handle = collectAgentTurn(proc as any, 'work', {}, () => {})
    emitCompletedBlock(proc, 'authoritative failure result')
    proc.emit('assistant_text', { text: 'partial diagnostics', parentToolUseId: null })
    proc.emit('result', { is_error: true, error: 'worker failed' })

    const failure = await handle.done.catch(error => error)
    expect(failure).toBeInstanceOf(AgentWorkerFailure)
    expect(failure).toMatchObject({
      output: 'authoritative failure resultpartial diagnostics',
      finalOutput: 'authoritative failure result',
    })
  })

  test('serialized API exposes exact final_output and old snapshots do not synthesize it', () => {
    const snapshot = terminalSnapshot('agent_final_serialized')
    snapshot.workers[0]!.finalOutput = '  long non-JSON final\n```text\n{not-json}\n```  \n'
    const serialized = serializeAgentRun(snapshot) as any
    expect(serialized.workers[0].final_output).toBe(snapshot.workers[0]!.finalOutput)

    delete snapshot.workers[0]!.finalOutput
    const legacy = serializeAgentRun(snapshot) as any
    expect(legacy.workers[0]).not.toHaveProperty('final_output')
  })

  test('final output reloads independently from its artifact', () => {
    const snapshot = terminalSnapshot(`agent_final_reload_${Date.now()}`)
    const worker = snapshot.workers[0]!
    snapshot.promptArtifact = `${snapshot.runId}.prompt.txt`
    worker.outputArtifact = `${snapshot.runId}.output.txt`
    worker.finalOutputArtifact = `${snapshot.runId}.final-output.txt`
    const paths = [
      join(AGENT_RUNS_DIR, `${snapshot.runId}.json`),
      join(AGENT_RUNS_DIR, snapshot.promptArtifact),
      join(AGENT_RUNS_DIR, worker.outputArtifact),
      join(AGENT_RUNS_DIR, worker.finalOutputArtifact),
    ]
    mkdirSync(AGENT_RUNS_DIR, { recursive: true })
    writeFileSync(paths[0]!, JSON.stringify({ ...snapshot, prompt: '', workers: [{ ...worker, output: '', finalOutput: undefined }] }))
    writeFileSync(paths[1]!, snapshot.prompt)
    writeFileSync(paths[2]!, worker.output)
    writeFileSync(paths[3]!, '  completed after restart  \n')
    try {
      const service = new AgentService()
      const session = {
        sessionName: snapshot.sessionName, chatId: snapshot.chatId, workDir: snapshot.workDir,
        codexAccountId: () => 'default',
      } as any
      const reloaded = service.getRun(service.rootPrincipal(session), snapshot.runId)
      expect(reloaded.workers[0]).toMatchObject({
        output: 'cumulative output stays unchanged',
        finalOutput: '  completed after restart  \n',
      })
    } finally {
      for (const path of paths) rmSync(path, { force: true })
    }
  })

  test('a missing final-output artifact fails closed instead of falling back to cumulative output', () => {
    const snapshot = terminalSnapshot(`agent_final_missing_${Date.now()}`)
    const worker = snapshot.workers[0]!
    snapshot.promptArtifact = `${snapshot.runId}.prompt.txt`
    worker.outputArtifact = `${snapshot.runId}.output.txt`
    worker.finalOutputArtifact = `${snapshot.runId}.missing-final-output.txt`
    const paths = [
      join(AGENT_RUNS_DIR, `${snapshot.runId}.json`),
      join(AGENT_RUNS_DIR, snapshot.promptArtifact),
      join(AGENT_RUNS_DIR, worker.outputArtifact),
    ]
    mkdirSync(AGENT_RUNS_DIR, { recursive: true })
    writeFileSync(paths[0]!, JSON.stringify({ ...snapshot, prompt: '', workers: [{ ...worker, output: '', finalOutput: undefined }] }))
    writeFileSync(paths[1]!, snapshot.prompt)
    writeFileSync(paths[2]!, worker.output)
    try {
      expect(() => new AgentService()).toThrow(/final output.+is unreadable/)
    } finally {
      for (const path of paths) rmSync(path, { force: true })
    }
  })
})

function terminalSnapshot(runId: string): AgentRunSnapshot {
  return {
    runId,
    sessionName: 'final-output-project',
    chatId: 'final-output-chat',
    workDir: tmpdir(),
    prompt: 'preserve final output',
    description: '最终输出测试',
    depth: 0,
    status: 'completed',
    createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    workers: [{
      identityId: 'agent:test', identityName: 'Test Agent', tokenSourceId: 'glm',
      provider: 'claude', model: 'test-model', effort: 'max', status: 'completed',
      output: 'cumulative output stays unchanged', steps: [], sessionId: 'native-final-output',
    }],
  }
}
