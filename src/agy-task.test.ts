import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

import { captureGitSnapshot } from './agy-task'

describe('agy git snapshots', () => {
  test('lists untracked files in an unborn repository without failing', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'lodestar-agy-git-'))
    git(repo, ['init'])
    writeFileSync(join(repo, 'report.md'), '# report\n')

    const snapshot = await captureGitSnapshot(repo)

    expect(snapshot.ok).toBe(true)
    expect(snapshot.statusShort).toContain('?? report.md')
  })
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
