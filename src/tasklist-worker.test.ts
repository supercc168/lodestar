import { describe, expect, test } from 'bun:test'

import type { TasklistSection, TaskSummary } from './feishu'
import {
  customSectionsForDesignSubtraction,
  localReviewRef,
  sanitizeTaskCommentContent,
  tasksOutsideCustomSections,
} from './tasklist-worker'

function task(guid: string): TaskSummary {
  return { guid, summary: guid }
}

function section(guid: string, name: string, isDefault = false): TasklistSection {
  return { guid, name, isDefault }
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

  test('does not subtract default or legacy design sections from design bucket', () => {
    expect(customSectionsForDesignSubtraction([
      section('default-design', '设计中', true),
      section('legacy-design', '设计中'),
      section('todo', '[AI]待执行'),
      section('doing', '[AI]执行中'),
      section('done', '已完成'),
    ])).toEqual([
      section('todo', '[AI]待执行'),
      section('doing', '[AI]执行中'),
      section('done', '已完成'),
    ])
  })
})

describe('tasklist worker local reviews', () => {
  test('formats local review refs as base-to-head diffs', () => {
    expect(localReviewRef('main', 'AI-AUTO')).toBe('local:main..AI-AUTO')
  })
})

describe('tasklist worker comments', () => {
  test('removes local markdown link targets while preserving valid URLs', () => {
    expect(sanitizeTaskCommentContent(
      'Changed [worker](/home/leviyuan/feishu/src/tasklist-worker.ts) and [task](https://example.com/task/1).',
    )).toBe('Changed worker and [task](https://example.com/task/1).')
  })
})
