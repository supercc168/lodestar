import { describe, expect, test } from 'bun:test'

import { AGY_DEFAULT_MODEL } from '../agy-task'
import { agyRepoElement, agyResultElement, agyTaskCard } from './agy'

const cleanGit = {
  ok: true,
  statusShort: '',
  diffShortStat: '',
  diffNameOnly: '',
}

describe('agy task card rendering', () => {
  test('renders prompt, stats, result placeholder, and repo panels', () => {
    const card = agyTaskCard({
      sessionName: 'probe',
      prompt: '审查一下项目代码',
      beforeGit: cleanGit,
      stats: {
        status: '⏳ agy 运行中',
        model: AGY_DEFAULT_MODEL,
        cwd: '/tmp/probe',
        command: 'agy --model "Gemini 3.1 Pro (High)" --dangerously-skip-permissions --print-timeout 180m0s -p <prompt>',
        startedAtMs: Date.UTC(2026, 0, 1, 0, 0, 0),
        elapsedSec: '0.0',
        stdoutBytes: 0,
        stderrBytes: 0,
      },
    }) as any

    expect(card.config.streaming_mode).toBe(true)
    expect(card.body.elements).toHaveLength(4)
    expect(card.body.elements[0].element_id).toBe('agy_prompt')
    expect(card.body.elements[0].tag).toBe('collapsible_panel')
    expect(card.body.elements[0].expanded).toBe(false)
    expect(card.body.elements[1].element_id).toBe('agy_stats')
    expect(card.body.elements[1].content).toContain('Gemini 3.1 Pro (High)')
    expect(card.body.elements[2].element_id).toBe('agy_result')
    expect(card.body.elements[2].content).toContain('等待 agy 返回')
    expect(card.body.elements[3].element_id).toBe('agy_repo')
    expect(card.body.elements[3].header.title.content).toContain('执行前干净')
  })

  test('repo panel warns when pre-existing changes were present', () => {
    const panel = agyRepoElement({
      before: {
        ok: true,
        statusShort: ' M src/session.ts',
        diffShortStat: '1 file changed, 2 insertions(+)',
        diffNameOnly: 'src/session.ts',
      },
      after: {
        ok: true,
        statusShort: ' M src/session.ts\n M README.md',
        diffShortStat: '2 files changed, 4 insertions(+)',
        diffNameOnly: 'README.md\nsrc/session.ts',
      },
    }) as any

    expect(panel.tag).toBe('collapsible_panel')
    expect(panel.elements[0].content).toContain('执行前已有未提交变更')
    expect(panel.elements[0].content).toContain('不能全部归因于本次 agy 执行')
  })

  test('result element marks long stdout as truncated', () => {
    const result = agyResultElement({
      status: '✅ agy 完成',
      stdout: 'x'.repeat(9000),
      stderr: '',
    }) as any

    expect(result.element_id).toBe('agy_result')
    expect(result.content).toContain('输出已截断')
    expect(result.content.length).toBeLessThan(8300)
  })
})
