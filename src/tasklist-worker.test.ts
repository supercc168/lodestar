import { describe, expect, test } from 'bun:test'

import type { TaskSummary } from './feishu'
import { tasksOutsideCustomSections } from './tasklist-worker'

function task(guid: string): TaskSummary {
  return { guid, summary: guid }
}

describe('tasklist worker buckets', () => {
  test('treats tasks outside custom sections as design tasks', () => {
    expect(tasksOutsideCustomSections(
      [task('default-1'), task('todo-1'), task('default-2'), task('review-1')],
      [
        [task('todo-1')],
        [task('review-1')],
      ],
    )).toEqual([task('default-1'), task('default-2')])
  })
})
