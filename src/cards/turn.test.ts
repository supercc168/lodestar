import { describe, expect, test } from 'bun:test'

import { summarizeToolInput, toolCallElement, toolCallPermissionElement } from './turn'

describe('bash-like tool card rendering', () => {
  test('summarizes dynamic exec_command input from # desc', () => {
    const input = {
      cmd: '# desc: 查看当前分支和工作区状态\n git status --short --branch',
      workdir: '/home/leviyuan/feishu',
    }

    expect(summarizeToolInput('exec_command', input)).toBe('查看当前分支和工作区状态')

    const el = toolCallElement(0, 'exec_command', input, 'ok', '✅') as any
    expect(el.header.title.content).toBe('✅ 🔧 Bash: 查看当前分支和工作区状态')
    expect(el.elements[0].content).toContain('**cwd**: `/home/leviyuan/feishu`')
    expect(el.elements[0].content).toContain('git status --short --branch')
    expect(el.elements[0].content).not.toContain('# desc:')
  })

  test('renders namespaced exec_command as Bash in permission panels', () => {
    const input = {
      cmd: '# desc: 查看 Git 远端地址\ngit remote -v',
      workdir: '/home/leviyuan/feishu',
    }

    const el = toolCallPermissionElement(1, 'functions.exec_command', input, 'req-1') as any
    expect(el.header.title.content).toBe('🔐 等审批 · Bash: 查看 Git 远端地址')
    expect(el.elements[0].content).toContain('git remote -v')
    expect(el.elements[0].content).not.toContain('# desc:')
  })

  test('unwraps quoted unified exec desc commands', () => {
    const input = {
      command: '"# desc: 查看已跟踪文件中 Claude 或 OMC 遗留引用\nrg -n -i \\"claude|omc|anthropic|\\\\.claude\\" "\'$(git ls-files)\'',
      cwd: '/home/leviyuan/tradefi-shfe-hedge',
      source: 'unifiedExecStartup',
    }

    expect(summarizeToolInput('Bash', input)).toBe('查看已跟踪文件中 Claude 或 OMC 遗留引用')

    const el = toolCallElement(2, 'Bash', input, null, '✅') as any
    const body = el.elements[0].content

    expect(el.header.title.content).toBe('✅ 🔧 Bash: 查看已跟踪文件中 Claude 或 OMC 遗留引用')
    expect(body).toContain('**目的**: 查看已跟踪文件中 Claude 或 OMC 遗留引用')
    expect(body).toContain('rg -n -i "claude|omc|anthropic|\\.claude" $(git ls-files)')
    expect(body).not.toContain('"# desc:')
    expect(body).not.toContain('\\"claude')
    expect(body).not.toContain('"\'$(git ls-files)\'')
  })

  test('renders write_stdin shell session polling as Bash', () => {
    const input = {
      session_id: 97146,
      chars: '',
      yield_time_ms: 1000,
      max_output_tokens: 12000,
    }

    expect(summarizeToolInput('write_stdin', input)).toBe('读取会话输出 97146')

    const el = toolCallElement(2, 'write_stdin', input, 'poll output', '✅') as any
    expect(el.header.title.content).toBe('✅ 🔧 Bash: 读取会话输出 97146')
    expect(el.elements[0].content).toContain('**操作**: 读取会话输出')
    expect(el.elements[0].content).toContain('**session**: `97146`')
    expect(el.elements[0].content).not.toContain('"session_id"')
  })

  test('renders write_stdin interrupt as Bash input', () => {
    const input = {
      session_id: 97146,
      chars: '\u0003',
    }

    const el = toolCallElement(3, 'functions.write_stdin', input, 'stopped', '✅') as any
    expect(el.header.title.content).toBe('✅ 🔧 Bash: 中断会话 97146')
    expect(el.elements[0].content).toContain('^C')
  })
})

describe('file change card rendering', () => {
  test('summarizes and renders file diffs without duplicated JSON output', () => {
    const diff = [
      '@@ -1,3 +1,4 @@',
      ' import { ELEMENTS } from ./elements',
      '-const oldName = true',
      '+const newName = true',
      '+const extra = true',
    ].join('\n')
    const input = {
      cwd: '/home/leviyuan/feishu',
      status: 'completed',
      changes: [{
        path: '/home/leviyuan/feishu/src/cards/turn.ts',
        kind: { type: 'update', move_path: null },
        diff,
      }],
    }

    expect(summarizeToolInput('FileChange', input)).toBe('修改 src/cards/turn.ts · +2 -1')

    const output = JSON.stringify(input.changes, null, 2)
    const el = toolCallElement(0, 'FileChange', input, output, '✅') as any
    const body = el.elements[0].content

    expect(el.header.title.content).toBe('✅ 🔧 文件变更: 修改 src/cards/turn.ts · +2 -1')
    expect(body).toContain('**文件**: 1 个')
    expect(body).toContain('**修改** `src/cards/turn.ts` · +2 -1')
    expect(body).toContain('```diff')
    expect(body).toContain('-const oldName = true')
    expect(body).toContain('+const newName = true')
    expect(body).not.toContain('**output:**')
    expect(body).not.toContain('"changes"')
  })

  test('renders file change approval panels as readable permission details', () => {
    const input = {
      reason: '需要写入补丁',
      grantRoot: '/home/leviyuan/feishu',
    }

    const el = toolCallPermissionElement(1, 'FileChange', input, 'req-file') as any
    const body = el.elements[0].content

    expect(el.header.title.content).toBe('🔐 等审批 · 文件变更: 需要写入补丁 · /home/leviyuan/feishu')
    expect(body).toContain('**原因**: 需要写入补丁')
    expect(body).toContain('**范围**: `/home/leviyuan/feishu`')
    expect(body).not.toContain('"grantRoot"')
  })
})

describe('web search card rendering', () => {
  test('uses completed search queries from output instead of raw JSON', () => {
    const input = {
      query: '',
      action: { type: 'other' },
    }
    const output = JSON.stringify({
      type: 'search',
      query: null,
      queries: [
        'site:developers.openai.com/codex/use-cases "Save workflows as skills" "Create a skill Codex"',
        '"Save workflows as skills" "developers.openai.com/codex/use-cases"',
      ],
    }, null, 2)

    const el = toolCallElement(4, 'WebSearch', input, output, '✅') as any
    const body = el.elements[0].content

    expect(el.header.title.content).toBe('✅ 🔧 网页搜索: 2 条查询 · site:developers.openai.com/codex/use-cases "Save workflows as skills" "C…')
    expect(body).toContain('**动作**: 搜索')
    expect(body).toContain('- `site:developers.openai.com/codex/use-cases "Save workflows as skills" "Create a skill Codex"`')
    expect(body).toContain('- `"Save workflows as skills" "developers.openai.com/codex/use-cases"`')
    expect(body).not.toContain('"action"')
    expect(body).not.toContain('"queries"')
    expect(body).not.toContain('**output:**')
  })

  test('renders pending web search from input query', () => {
    const input = {
      query: 'OpenAI Codex skills',
      action: { type: 'search' },
    }

    const el = toolCallElement(5, 'WebSearch', input, null, '⏳') as any
    const body = el.elements[0].content

    expect(el.header.title.content).toBe('⏳ 🔧 网页搜索: OpenAI Codex skills')
    expect(body).toContain('**动作**: 搜索')
    expect(body).toContain('- `OpenAI Codex skills`')
  })
})

describe('other tool card rendering', () => {
  test('renders MCP calls with server, tool, arguments, and text result', () => {
    const input = {
      server: 'lodestar_schedule',
      tool: 'schedule_list',
      arguments: { project: 'feishu' },
    }
    const output = JSON.stringify({
      content: [{ type: 'text', text: 'No schedules configured.' }],
      structuredContent: { count: 0 },
    }, null, 2)

    expect(summarizeToolInput('MCP', input)).toBe('lodestar_schedule.schedule_list: feishu')

    const el = toolCallElement(6, 'MCP', input, output, '✅') as any
    const body = el.elements[0].content

    expect(el.header.title.content).toBe('✅ 🔧 MCP: lodestar_schedule.schedule_list: feishu')
    expect(body).toContain('**server**: `lodestar_schedule`')
    expect(body).toContain('**tool**: `schedule_list`')
    expect(body).toContain('"project": "feishu"')
    expect(body).toContain('No schedules configured.')
    expect(body).toContain('**structuredContent**')
  })

  test('renders image generation without generic JSON panels', () => {
    const input = {
      status: 'completed',
      revisedPrompt: 'A clean product photo of a status dashboard on a laptop.',
    }

    const el = toolCallElement(7, 'ImageGeneration', input, '/tmp/dashboard.png', '✅') as any
    const body = el.elements[0].content

    expect(el.header.title.content).toBe('✅ 🔧 图片生成: A clean product photo of a status dashboard on a laptop.')
    expect(body).toContain('**状态**: `completed`')
    expect(body).toContain('**提示词**')
    expect(body).toContain('A clean product photo of a status dashboard on a laptop.')
    expect(body).toContain('**输出**')
    expect(body).not.toContain('"revisedPrompt"')
  })

  test('renders agent calls with prompt and model labels', () => {
    const input = {
      tool: 'spawnAgents',
      prompt: 'Review the card rendering code.',
      model: 'gpt-5-codex',
    }
    const output = JSON.stringify({ reviewer: { status: 'completed' } }, null, 2)

    const el = toolCallElement(8, 'Agent', input, output, '✅') as any
    const body = el.elements[0].content

    expect(el.header.title.content).toBe('✅ 🔧 Agent: spawnAgents: Review the card rendering code.')
    expect(body).toContain('**tool**: `spawnAgents`')
    expect(body).toContain('**model**: `gpt-5-codex`')
    expect(body).toContain('**prompt**')
    expect(body).toContain('Review the card rendering code.')
    expect(body).toContain('"status": "completed"')
  })
})
