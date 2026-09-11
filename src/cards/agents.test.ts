import { describe, expect, test } from 'bun:test'
import type { AgentIdentity } from '../agent-identities'
import type { AgentRunSnapshot } from '../agent-run-types'
import { agentIdentityListCard, agentRunCard, agentRunSummary, agentWorkerElementId } from './agents'

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

  test('运行卡标题与摘要按 parentKind 与运行状态呈现,不再出现 depth', () => {
    const run: AgentRunSnapshot = {
      runId: 'agent_title', sessionName: 'project', chatId: 'chat', workDir: '/repo', prompt: 'go',
      parentKind: 'follow_up', depth: 2, status: 'running', createdAt: new Date().toISOString(),
      workers: [
        {
          identityId: identity.id, identityName: identity.displayName, tokenSourceId: 'claude:glm', provider: 'claude',
          model: identity.model, effort: 'max', status: 'running', output: '', steps: [],
        },
        {
          identityId: 'agent:b', identityName: 'B', tokenSourceId: 'claude:glm-flash', provider: 'claude',
          model: 'claude:glm-flash', effort: 'max', status: 'queued', output: '', steps: [],
        },
      ],
    }
    const card = JSON.stringify(agentRunCard(run))
    expect(card).toContain('继续委派任务')
    expect(card).toContain('2 位 Agent')
    expect(card).not.toContain('depth')
    expect(JSON.stringify(agentRunCard({ ...run, parentKind: 'delegate' }))).toContain('委派任务')

    expect(agentRunSummary(run)).toBe('⏳ 正在执行 · 0/2')
    expect(agentRunSummary({ ...run, status: 'queued' })).toBe('⏳ 等待执行 · 0/2')
    expect(agentRunSummary({ ...run, status: 'cancelled' })).toBe('🛑 委派已取消 · 0/2')
    expect(agentRunSummary({ ...run, status: 'completed' })).toBe('✅ 委派完成 · 0/2')
    expect(agentRunSummary(run)).not.toContain('depth')
  })

  test('worker 元素:失败/停止显示原因与已生成内容,排队显示原因,单 worker 完成默认展开', () => {
    const worker = (patch: Partial<AgentRunSnapshot['workers'][number]>): AgentRunSnapshot['workers'][number] => ({
      identityId: identity.id, identityName: identity.displayName, tokenSourceId: 'claude:glm', provider: 'claude',
      model: identity.model, effort: 'max', status: 'failed', output: '', steps: [], ...patch,
    })
    const base = {
      runId: 'agent_w', sessionName: 'project', chatId: 'chat', workDir: '/repo', prompt: 'go',
      depth: 1, createdAt: new Date(0).toISOString(),
    }

    const failed = JSON.stringify(agentRunCard({
      ...base, status: 'failed',
      workers: [worker({ status: 'failed', error: 'agent exited before result', output: '已完成一半的正文', durationMs: 65_000 })],
    }))
    expect(failed).toContain('失败原因')
    expect(failed).toContain('agent exited before result')
    expect(failed).toContain('已生成的内容')
    expect(failed).toContain('已完成一半的正文')
    expect(failed).toContain('用时 1 分 5 秒')
    expect(failed.indexOf('失败原因')).toBeLessThan(failed.indexOf('已生成的内容'))

    const cancelled = JSON.stringify(agentRunCard({
      ...base, status: 'cancelled',
      workers: [worker({ status: 'cancelled', error: 'stop tree', output: '部分结果' })],
    }))
    expect(cancelled).toContain('停止原因')
    expect(cancelled).toContain('已生成的内容')

    const queued = JSON.stringify(agentRunCard({
      ...base, status: 'queued',
      workers: [worker({ status: 'queued', queuedReason: '等待全局并发槽位 (8)' })],
    }))
    expect(queued).toContain('等待全局并发槽位 (8)')

    const single = JSON.parse(JSON.stringify(agentRunCard({
      ...base, status: 'completed', workers: [worker({ status: 'completed', output: 'done' })],
    })))
    expect(single.body.elements.find((el: any) => el.element_id === agentWorkerElementId(identity.id)).expanded).toBe(true)

    const dual = JSON.parse(JSON.stringify(agentRunCard({
      ...base, status: 'completed',
      workers: [worker({ status: 'completed', output: 'done' }), worker({ identityId: 'agent:b', status: 'completed', output: 'done too' })],
    })))
    expect(dual.body.elements.find((el: any) => el.element_id === agentWorkerElementId(identity.id)).expanded).toBe(false)
  })

  test('identityRow 在 defaultEffort 缺失时渲染 MISS 兜底(9020e11 展示层摘录)', () => {
    // 本地 defaultEffortFor 恒非空,此兜底为防御性摘录;用 null 走渲染路径锁定行为
    const noEffort = { ...identity, defaultEffort: null as any }
    const card = JSON.stringify(agentIdentityListCard({
      panelId: 'p', page: 0, totalPages: 1, catalog: [noEffort], failures: [],
    }))
    expect(card).toContain('默认 `MISS`')
  })
})

