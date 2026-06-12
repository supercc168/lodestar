import { describe, expect, test } from 'bun:test'

import type { TaskComment, TasklistSection, TaskSummary } from './feishu'
import {
  customSectionsForDesignSubtraction,
  isManualMergeSignal,
  localReviewRef,
  reviewDiffSpec,
  reviewHeadRef,
  sanitizeTaskCommentContent,
  shouldIncludeTaskComment,
  taskArtifactTag,
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
  test('uses task checkbox completion as the merge signal', () => {
    expect(isManualMergeSignal(task('open'))).toBe(false)
    expect(isManualMergeSignal({ ...task('blank'), completedAt: '   ' })).toBe(false)
    expect(isManualMergeSignal({ ...task('done'), completedAt: '2026-06-13T10:30:00Z' })).toBe(true)
  })

  test('formats local review refs as base-to-head diffs', () => {
    expect(localReviewRef('abc123', 'AI-AUTO/task-guid')).toBe('local:abc123..AI-AUTO/task-guid')
  })

  test('formats task artifact tags under AI-AUTO namespace', () => {
    expect(taskArtifactTag('task-guid')).toBe('AI-AUTO/task-guid')
  })

  test('extracts diff spec and head ref from local review refs', () => {
    const ref = 'local:abc123..AI-AUTO/task-guid'
    expect(reviewDiffSpec(ref)).toBe('abc123..AI-AUTO/task-guid')
    expect(reviewHeadRef(ref)).toBe('AI-AUTO/task-guid')
  })
})

describe('tasklist worker comments', () => {
  test('removes local markdown link targets while preserving valid URLs', () => {
    expect(sanitizeTaskCommentContent(
      'Changed [worker](/home/leviyuan/feishu/src/tasklist-worker.ts) and [task](https://example.com/task/1).',
    )).toBe('Changed worker and [task](https://example.com/task/1).')
  })

  test('includes only user comments that are not already recorded automation output', () => {
    const ownCommentIds = new Set(['own'])
    expect(shouldIncludeTaskComment(comment('user', 'user'), ownCommentIds)).toBe(true)
    expect(shouldIncludeTaskComment(comment('app', 'app'), ownCommentIds)).toBe(false)
    expect(shouldIncludeTaskComment(comment('own', 'user'), ownCommentIds)).toBe(false)
    expect(shouldIncludeTaskComment({ id: 'unknown', content: 'missing creator' }, ownCommentIds)).toBe(false)
  })
})

function comment(id: string, creatorType: string): TaskComment {
  return { id, content: id, creator: { type: creatorType } }
}
