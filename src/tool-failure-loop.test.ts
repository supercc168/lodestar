import { describe, expect, test } from 'bun:test'
import {
  ToolFailureLoopGuard,
  toolFailureFingerprint,
} from './tool-failure-loop'

describe('ToolFailureLoopGuard', () => {
  test('canonicalizes object keys before fingerprinting', () => {
    expect(toolFailureFingerprint('Edit', { b: 2, a: 1 }, 'same error')).toBe(
      toolFailureFingerprint('Edit', { a: 1, b: 2 }, 'same error'),
    )
  })

  test('corrects on the second identical failure and stops on the third', () => {
    const guard = new ToolFailureLoopGuard()
    const input = { file_path: '/tmp/a.ts', old_string: 'x', new_string: 'x' }

    expect(guard.observeFailure('Edit', input, 'No changes').type).toBe('none')
    expect(guard.observeFailure('Edit', input, 'No changes')).toMatchObject({
      type: 'correct',
      repeatCount: 2,
      toolName: 'Edit',
    })
    expect(guard.observeFailure('Edit', input, 'No changes')).toMatchObject({
      type: 'stop',
      repeatCount: 3,
      toolName: 'Edit',
    })
    expect(guard.observeFailure('Edit', input, 'No changes')).toMatchObject({
      type: 'none',
      repeatCount: 4,
    })
  })

  test('success, changed input, and changed error break the sequence', () => {
    const guard = new ToolFailureLoopGuard()

    guard.observeFailure('Bash', { command: 'false' }, 'exit 1')
    guard.observeSuccess()
    expect(guard.observeFailure('Bash', { command: 'false' }, 'exit 1').repeatCount).toBe(1)

    expect(guard.observeFailure('Bash', { command: 'false --verbose' }, 'exit 1').repeatCount).toBe(1)
    expect(guard.observeFailure('Bash', { command: 'false --verbose' }, 'exit 2').repeatCount).toBe(1)
  })
})
