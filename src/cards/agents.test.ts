import { describe, expect, test } from 'bun:test'
import type { AgentIdentity } from '../agent-identities'
import { agentIdentityListCard } from './agents'

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
})
