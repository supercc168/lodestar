import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

import {
  ensureProjectWorktree,
  listProjectWorktrees,
  readWorktreeInstructionsForManagedBranch,
  removeProjectWorktreeIfClean,
  worktreeInstructionsPathForManagedBranch,
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
      state: 'active',
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

  test('rebases archived branches to latest project head when reactivated', () => {
    const { repo } = initRepo()
    const first = ensureProjectWorktree(repo, 'feishu', 'archived-work')
    git(first.worktreePath, ['commit', '--allow-empty', '-m', 'feature'])
    git(repo, ['merge', '--no-ff', 'work/archived-work', '-m', 'merge feature'])
    removeProjectWorktreeIfClean(repo, 'feishu', 'archived-work')
    git(repo, ['commit', '--allow-empty', '-m', 'main moves after archive'])

    const latestProjectHead = git(repo, ['rev-parse', 'HEAD']).trim()
    const reactivated = ensureProjectWorktree(repo, 'feishu', 'archived-work')

    expect(reactivated.createdBranch).toBe(false)
    expect(reactivated.createdWorktree).toBe(true)
    expect(git(repo, ['rev-parse', 'work/archived-work']).trim()).toBe(latestProjectHead)
    expect(git(reactivated.worktreePath, ['rev-parse', 'HEAD']).trim()).toBe(latestProjectHead)
  })

  test('marks merged and stale work branches', () => {
    const { repo } = initRepo()
    ensureProjectWorktree(repo, 'feishu', 'merged-work')
    git(join(repo, '..', 'feishu[merged-work]'), ['commit', '--allow-empty', '-m', 'feature'])
    git(repo, ['merge', '--no-ff', 'work/merged-work', '-m', 'merge feature'])

    ensureProjectWorktree(repo, 'feishu', 'stale-work')
    git(repo, ['commit', '--allow-empty', '-m', 'main moves'])

    const entries = listProjectWorktrees(repo, 'feishu')
    expect(entries.find(e => e.slug === 'merged-work')?.state).toBe('merged')

    const stalePath = join(repo, '..', 'feishu[stale-work]')
    writeFileSync(join(stalePath, 'stale.txt'), 'branch work\n')
    git(stalePath, ['add', 'stale.txt'])
    git(stalePath, ['commit', '-m', 'branch work'])
    git(repo, ['commit', '--allow-empty', '-m', 'main moves again'])

    const updated = listProjectWorktrees(repo, 'feishu')
    expect(updated.find(e => e.slug === 'stale-work')?.state).toBe('stale')
  })

  test('finds slug-specific AGENTS file for managed worktree branches', () => {
    const { repo } = initRepo()
    const result = ensureProjectWorktree(repo, 'feishu', 'prompt-work')
    writeFileSync(join(result.worktreePath, 'AGENTS.prompt-work.md'), '# extra rules\n')

    expect(
      worktreeInstructionsPathForManagedBranch(result.worktreePath, repo, 'feishu'),
    ).toBe(join(result.worktreePath, 'AGENTS.prompt-work.md'))
  })

  test('reads slug-specific AGENTS content for managed worktree branches', () => {
    const { repo } = initRepo()
    const result = ensureProjectWorktree(repo, 'feishu', 'prompt-work')
    writeFileSync(join(result.worktreePath, 'AGENTS.prompt-work.md'), '# extra rules\n- be loud\n')

    expect(
      readWorktreeInstructionsForManagedBranch(result.worktreePath, repo, 'feishu'),
    ).toEqual({
      path: join(result.worktreePath, 'AGENTS.prompt-work.md'),
      content: '# extra rules\n- be loud',
      slug: 'prompt-work',
    })
  })

  test('skips mismatched slug-specific AGENTS files', () => {
    const { repo } = initRepo()
    const result = ensureProjectWorktree(repo, 'feishu', 'prompt-work')
    writeFileSync(join(result.worktreePath, 'AGENTS.other-work.md'), '# extra rules\n')

    expect(worktreeInstructionsPathForManagedBranch(result.worktreePath, repo, 'feishu')).toBeNull()
  })

  test('skips slug-specific AGENTS files outside managed worktree branches', () => {
    const { repo } = initRepo()
    writeFileSync(join(repo, 'AGENTS.main.md'), '# extra rules\n')

    expect(worktreeInstructionsPathForManagedBranch(repo, repo, 'feishu')).toBeNull()
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
