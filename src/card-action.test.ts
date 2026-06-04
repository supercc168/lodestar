import { describe, expect, test } from 'bun:test'

import { updateActionCard, type ActionCardUpdateDeps } from './card-action'

function deps(overrides: Partial<ActionCardUpdateDeps> = {}) {
  const calls: string[] = []
  const sent: Array<{ chatId: string; text: string }> = []
  const logs: string[] = []
  const base: ActionCardUpdateDeps = {
    updateCard: async (messageId, card) => {
      calls.push(`update:${messageId}:${String(card === testCard)}`)
    },
    sendText: async (chatId, text) => {
      sent.push({ chatId, text })
    },
    log: message => {
      logs.push(message)
    },
  }
  return { calls, sent, logs, deps: { ...base, ...overrides } }
}

const testCard = { schema: '2.0', body: { elements: [] } }

describe('card action active update response', () => {
  test('patches the original card without returning a callback body', async () => {
    const state = deps()

    const result = await updateActionCard('om_1', 'oc_1', testCard, '选择推理强度', state.deps)

    expect(result).toBeUndefined()
    expect(state.calls).toEqual(['update:om_1:true'])
    expect(state.sent).toEqual([])
    expect(state.logs).toEqual([])
  })

  test('reports patch failures in chat and still returns no callback body', async () => {
    const state = deps({
      updateCard: async () => {
        throw new Error('patch boom')
      },
    })

    const result = await updateActionCard('om_bad', 'oc_1', testCard, '选择推理强度', state.deps)

    expect(result).toBeUndefined()
    expect(state.sent).toHaveLength(1)
    expect(state.sent[0].chatId).toBe('oc_1')
    expect(state.sent[0].text).toContain('卡片更新失败: patch boom')
    expect(state.sent[0].text).toContain('选择推理强度')
    expect(state.logs).toEqual(['card action update failed message=om_bad: patch boom'])
  })

  test('reports missing message id in chat and still returns no callback body', async () => {
    const state = deps()

    const result = await updateActionCard('', 'oc_1', testCard, '选择推理强度', state.deps)

    expect(result).toBeUndefined()
    expect(state.calls).toEqual([])
    expect(state.sent).toHaveLength(1)
    expect(state.sent[0].chatId).toBe('oc_1')
    expect(state.sent[0].text).toContain('缺少 message_id')
    expect(state.sent[0].text).toContain('选择推理强度')
    expect(state.logs).toEqual([])
  })
})
