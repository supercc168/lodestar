import { describe, expect, test } from 'bun:test'

import { parseHostAskPayload } from './session-host-ask'

describe('parseHostAskPayload', () => {
  test('parses the canonical multi-question payload', () => {
    const parsed = parseHostAskPayload(JSON.stringify({
      questions: [
        { question: 'Pick A?', options: ['A1', 'A2'] },
        { question: 'Pick B?', options: [{ label: 'B1' }, { label: 'B2', description: 'desc' }] },
      ],
    }))
    expect(parsed).not.toBeNull()
    expect(parsed!.questions).toHaveLength(2)
    expect(parsed!.questions[0]?.options.map(o => o.label)).toEqual(['A1', 'A2'])
    expect(parsed!.questions[1]?.options).toEqual([
      { label: 'B1' },
      { label: 'B2', description: 'desc' },
    ])
    expect(JSON.parse(parsed!.inputJson)).toEqual({
      questions: [
        { question: 'Pick A?', options: ['A1', 'A2'] },
        { question: 'Pick B?', options: ['B1', 'B2'] },
      ],
    })
  })

  test('accepts a bare single-question object without questions wrapper', () => {
    const parsed = parseHostAskPayload('{"question":"Pick?","options":["A","B","C"]}')
    expect(parsed).not.toBeNull()
    expect(parsed!.questions).toHaveLength(1)
    expect(parsed!.questions[0]?.question).toBe('Pick?')
    expect(parsed!.questions[0]?.options.map(o => o.label)).toEqual(['A', 'B', 'C'])
  })

  test('accepts questions written as a single object instead of an array', () => {
    const parsed = parseHostAskPayload('{"questions":{"question":"Only one?","options":["Yes","No"]}}')
    expect(parsed).not.toBeNull()
    expect(parsed!.questions).toHaveLength(1)
    expect(parsed!.questions[0]?.options.map(o => o.label)).toEqual(['Yes', 'No'])
  })

  test('repairs trailing commas in objects and arrays', () => {
    const parsed = parseHostAskPayload(
      '{"questions":[{"question":"Pick?","options":["A","B",],},]}',
    )
    expect(parsed).not.toBeNull()
    expect(parsed!.questions[0]?.options.map(o => o.label)).toEqual(['A', 'B'])
  })

  test('rejects payloads with fewer than two options', () => {
    expect(parseHostAskPayload('{"questions":[{"question":"Pick?","options":["Only"]}]}')).toBeNull()
    expect(parseHostAskPayload('{"question":"Pick?","options":[]}')).toBeNull()
  })

  test('rejects invalid JSON that cannot be repaired', () => {
    expect(parseHostAskPayload('{"questions":[')).toBeNull()
    expect(parseHostAskPayload('not-json')).toBeNull()
  })
})
