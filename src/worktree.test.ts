import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

import {
  ensureProjectWorktree,
  listProjectWorktrees,
  removeProjectWorktreeIfClean,
} from './worktree'

let roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

describe('project worktrees', () => {
  test('creates sibling worktree and lists it from work branches', () => {
    const { root, repo } = initRepo()
    const result = ensureProjectWorktree(repo, 'feishu', 'feature-worktree')

    expect(result.branch).toBe('work/feature-worktree')
    expect(result.chatName).toBe('feishu[feature-worktree]')
    expect(result.worktreePath).toBe(join(root, 'feishu[feature-worktree]'))

    const entries = listProjectWorktrees(repo, 'feishu')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      slug: 'feature-worktree',
      chatName: 'feishu[feature-worktree]',
      branch: 'work/feature-worktree',
      mounted: true,
      dirtyCount: 0,
    })
  })

  test('refuses to remove a dirty worktree', () => {
    const { repo } = initRepo()
    const result = ensureProjectWorktree(repo, 'feishu', 'dirty-work')
    writeFileSync(join(result.worktreePath, 'scratch.txt'), 'dirty\n')

    expect(() => removeProjectWorktreeIfClean(repo, 'feishu', 'dirty-work')).toThrow(/uncommitted/)
  })

  test('removes clean worktree directory but keeps branch discoverable', () => {
    const { repo } = initRepo()
    const result = ensureProjectWorktree(repo, 'feishu', 'clean-work')

    const removed = removeProjectWorktreeIfClean(repo, 'feishu', 'clean-work')
    expect(removed.removedWorktree).toBe(true)

    const entries = listProjectWorktrees(repo, 'feishu')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.slug).toBe('clean-work')
    expect(entries[0]?.mounted).toBe(false)
    expect(entries[0]?.worktreePath).toBeNull()
    expect(entries[0]?.expectedPath).toBe(result.worktreePath)
  })
})

function initRepo(): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-wt-'))
  roots.push(root)
  const repo = join(root, 'feishu')
  mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
  writeFileSync(join(repo, 'README.md'), '# probe\n')
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-m', 'init'])
  git(repo, ['branch', '-M', 'main'])
  return { root, repo }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
