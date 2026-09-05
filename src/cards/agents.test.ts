import { describe, expect, test } from 'bun:test'
import type { AgentIdentity } from '../agent-identities'
import type { AgentRunSnapshot } from '../agent-run-types'
import { agentIdentityListCard, agentRunCard, agentWorkerElementId } from './agents'

const identity: AgentIdentity = {
  id: 'agent:a',
  displayName: 'Claude · GLM-5.3',
  tokenSourceId: 'claude:glm',
  tokenSourceDisplay: 'Claude · GLM-5.3',
  provider: 'claude',
  model: 'claude:glm',
  modelDisplay: 'glm-5.3',
  defaultEffort: 'max',
  supportedEfforts: ['max'],
  sourceDefault: true,
  status: 'ready',
}

describe('delegated Agent cards', () => {
  test('renders the catalog as a read-only directory without reviewer or launch controls', () => {
    const card = JSON.stringify(agentIdentityListCard({
      panelId: 'p',
      page: 0,
      totalPages: 1,
      catalog: [identity],
      failures: [],
    }))
    expect(card).toContain('agent_identity_page')
    expect(card).toContain(identity.id)
    expect(card).toContain('claude:glm')
    expect(card).not.toContain('评审角色')
    expect(card).not.toContain('点此开跑')
  })

  test('renders needs_input metadata and a cancel button on non-terminal runs', () => {
    const run: AgentRunSnapshot = {
      runId: 'agent_r', sessionName: 'project', chatId: 'chat', workDir: '/repo', prompt: 'do it',
      depth: 1, status: 'needs_input', createdAt: new Date().toISOString(), workers: [{
        identityId: identity.id, identityName: identity.displayName, tokenSourceId: 'claude:glm', provider: 'claude',
        model: identity.model, effort: 'max', status: 'needs_input', output: '', sessionId: 'sid', steps: [],
        pendingInput: { requestId: 'req', questions: [{ id: 'q', question: 'Proceed?', options: [{ label: 'Yes' }] }] },
      }],
    }
    const card = JSON.stringify(agentRunCard(run))
    expect(card).toContain('等待主 Agent 回答')
    expect(card).toContain('Proceed?')
    expect(card).toContain(agentWorkerElementId(identity.id))
    expect(card).toContain('agent_run_cancel')
    expect(card).toContain('"run_id":"agent_r"')
    expect(card).toContain('取消委派')
    expect(card).toContain('column_set')
    expect(card).not.toMatch(/"tag":"action"/)
    expect(card).not.toContain('评审角色')
    const cancelValue = JSON.parse(card).body.elements.at(-1).columns[0].elements[0].behaviors[0].value
    expect(cancelValue).toEqual({ kind: 'agent_run_cancel', run_id: 'agent_r' })
  })

  test('queued dual-worker cancel is a schema 2.0 column_set at elements[4]', () => {
    const run: AgentRunSnapshot = {
      runId: 'agent_q', sessionName: 'project', chatId: 'chat', workDir: '/repo', prompt: 'pong',
      depth: 1, status: 'queued', createdAt: new Date().toISOString(),
      workers: [
        {
          identityId: identity.id, identityName: identity.displayName, tokenSourceId: 'claude:glm', provider: 'claude',
          model: identity.model, effort: 'max', status: 'queued', output: '', steps: [],
        },
        {
          identityId: 'agent:b', identityName: 'Claude · GLM-5.3 Flash', tokenSourceId: 'claude:glm-flash', provider: 'claude',
          model: 'claude:glm-flash', effort: 'max', status: 'queued', output: '', steps: [],
        },
      ],
    }
    const parsed = JSON.parse(JSON.stringify(agentRunCard(run)))
    expect(parsed.body.elements).toHaveLength(5)
    expect(parsed.body.elements[4].tag).toBe('column_set')
    expect(JSON.stringify(parsed)).not.toMatch(/"tag":"action"/)
    expect(JSON.stringify(parsed)).toContain('agent_run_cancel')
  })

  test('omits the cancel button on a terminal run', () => {
    const run: AgentRunSnapshot = {
      runId: 'agent_done', sessionName: 'project', chatId: 'chat', workDir: '/repo', prompt: 'done',
      depth: 1, status: 'completed', createdAt: new Date().toISOString(), workers: [{
        identityId: identity.id, identityName: identity.displayName, tokenSourceId: 'claude:glm', provider: 'claude',
        model: identity.model, effort: 'max', status: 'completed', output: 'ok', steps: [],
      }],
    }
    const card = JSON.stringify(agentRunCard(run))
    expect(card).not.toContain('agent_run_cancel')
  })

  test('bounds an oversized prompt in the card while preserving the snapshot body', () => {
    const prompt = 'Q'.repeat(108_772)
    const run: AgentRunSnapshot = {
      runId: 'agent-oversized', sessionName: 'project', chatId: 'chat', workDir: '/repo',
      prompt, depth: 1, status: 'completed', createdAt: new Date(0).toISOString(),
      workers: [{
        identityId: identity.id, identityName: identity.displayName,
        tokenSourceId: 'claude:glm', provider: 'claude', model: identity.model, effort: 'max',
        status: 'completed', output: 'O'.repeat(2_676), steps: [],
      }],
    }
    const json = JSON.stringify(agentRunCard(run))
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(64_000)
    expect(json).toContain('完整 prompt 已原样交给 Agent')
    expect(json).not.toContain(prompt)
    expect(run.prompt).toBe(prompt)
  })

  test('shares a bounded card preview budget across a large worker batch', () => {
    const workers = Array.from({ length: 24 }, (_, index) => ({
      identityId: `catalog:worker-${index}`,
      identityName: `Worker ${index}`,
      tokenSourceId: 'claude:glm', provider: 'claude' as const, model: 'claude:glm', effort: 'max',
      status: 'completed' as const, output: `worker-${index}-` + 'R'.repeat(20_000), steps: [],
    }))
    const run: AgentRunSnapshot = {
      runId: 'agent-many', sessionName: 'project', chatId: 'chat', workDir: '/repo',
      prompt: 'Q'.repeat(108_772), depth: 1, status: 'completed', createdAt: new Date(0).toISOString(),
      workers,
    }
    const json = JSON.stringify(agentRunCard(run))
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(96_000)
    expect(json.match(/卡片输出已截断/g)).toHaveLength(workers.length)
    expect(run.workers.every(worker => worker.output.length > 20_000)).toBe(true)
  })
})

