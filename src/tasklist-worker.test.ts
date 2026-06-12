import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

import type { TasklistSection, TaskSummary } from './feishu'
import { customSectionsForDesignSubtraction, resolveGitHubRemote, tasksOutsideCustomSections } from './tasklist-worker'

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

describe('tasklist worker GitHub remotes', () => {
  test('resolves GitHub remote named github when origin is absent', () => {
    const repo = mkdtempSync(join(tmpdir(), 'lodestar-tasklist-remote-'))
    try {
      git(repo, ['init'])
      git(repo, ['remote', 'add', 'github', 'git@github.com:leviyuan/lodestar.git'])

      expect(resolveGitHubRemote(repo)).toEqual({
        name: 'github',
        url: 'git@github.com:leviyuan/lodestar.git',
        repo: { owner: 'leviyuan', repo: 'lodestar' },
      })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
