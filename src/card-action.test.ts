import { describe, expect, test } from 'bun:test'

import { actionCardResponse } from './card-action'

const testCard = { schema: '2.0', body: { elements: [] } }

describe('card action callback response', () => {
  test('wraps replacement cards in the documented card action response shape', () => {
    const result = actionCardResponse(testCard)

    expect(result).toEqual({ card: { type: 'raw', data: testCard } })
    expect(result.card.data).toBe(testCard)
    expect((result as any).schema).toBeUndefined()
    expect((result as any).toast).toBeUndefined()
  })
})
