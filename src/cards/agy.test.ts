import { describe, expect, test } from 'bun:test'

import { AGY_DEFAULT_MODEL } from '../agy-task'
import { agyForwardElement, agyRepoElement, agyResultElement, agyTaskCard } from './agy'

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
    expect(card.body.elements).toHaveLength(5)
    expect(card.body.elements[0].element_id).toBe('agy_prompt')
    expect(card.body.elements[0].tag).toBe('collapsible_panel')
    expect(card.body.elements[0].expanded).toBe(false)
    expect(card.body.elements[0].header.title.content).toBe('📥 agy收到')
    expect(card.body.elements[1].element_id).toBe('agy_stats')
    expect(card.body.elements[1].content).toBe('⏳ 执行中 · 0.0s · CPU -- · MEM --')
    expect(card.body.elements[2].element_id).toBe('agy_result')
    expect(card.body.elements[2].content).toContain('等待 agy 返回')
    expect(card.body.elements[3].element_id).toBe('agy_forward')
    expect(card.body.elements[4].element_id).toBe('agy_repo')
    expect(card.body.elements[4].header.title.content).toContain('执行前干净')
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

  test('result element strips terminal control sequences', () => {
    const result = agyResultElement({
      status: '✅ agy 完成',
      stdout: '旧内容\r最终结论\x1b[0m\n下一行',
      stderr: '\x1b[31merr\x1b[0m',
    }) as any

    expect(result.content).toContain('最终结论')
    expect(result.content).toContain('下一行')
    expect(result.content).toContain('err')
    expect(result.content).not.toContain('\x1b')
    expect(result.content).not.toContain('旧内容')
  })

  test('forward element renders a callback button', () => {
    const button = agyForwardElement('agy-result-1') as any

    expect(button.element_id).toBe('agy_forward')
    expect(button.columns[0].elements[0].text.content).toBe('转 Codex')
    expect(button.columns[0].elements[0].behaviors[0].value).toEqual({
      kind: 'agy_forward_codex',
      result_id: 'agy-result-1',
    })
  })
})
