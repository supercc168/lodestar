import { describe, expect, test } from 'bun:test'

import { consoleBodyElements, consoleUsageContent, modelEffortCard, modelEffortPanelElement, modelResultCard, modelResultPanelElement, modelSelectionCard, statusCard, streamingOffSettings } from './console'
import {
  askUserQuestionElement,
  contextCompactionElement,
  footerContextPercentLabel,
  footerTokenDetailLine,
  goalElement,
  goalDisplaySignature,
  hostAskCard,
  mainConversationCard,
  planElement,
  summarizeToolInput,
  toolCallElement,
  toolCallPermissionElement,
} from './turn'

describe('main conversation card rendering', () => {
  test('starts with a stable footer status element and no disposable ticker', () => {
    const card = mainConversationCard({
      sessionName: 'probe',
      turn: 1,
      effort: 'xhigh',
      kind: 'user_message',
      userInputs: [],
    }) as any

    const ids = card.body.elements.map((el: any) => el.element_id).filter(Boolean)
    expect(ids).toEqual(['footer'])
    expect(card.body.elements[0].content).toBe('Waiting...(0s)')
    expect(card.header).toBeUndefined()
    expect(JSON.stringify(card)).not.toContain('ticker')
  })

  test('marks bare prompt cold starts in the user input panel header', () => {
    const card = mainConversationCard({
      sessionName: 'probe',
      turn: 1,
      kind: 'user_message',
      userInputs: ['直接做一下'],
      directStart: true,
    }) as any

    expect(card.header).toBeUndefined()
    expect(card.body.elements[0].header.title.content).toBe('📥 收到 (1) 🚀')
  })

  test('shows the turn number for non-cold-start user turns', () => {
    const card = mainConversationCard({
      sessionName: 'probe',
      turn: 2,
      kind: 'user_message',
      userInputs: ['继续做一下'],
    }) as any

    expect(card.header).toBeUndefined()
    expect(card.body.elements[0].header.title.content).toBe('📥 收到 (1) #2')
  })

  test('status cards render one visible status line without a header', () => {
    const card = statusCard({
      sessionName: 'probe',
      title: 'restart',
      status: '🔁 重启 Codex (0s)',
    }) as any

    expect(card.header).toBeUndefined()
    expect(card.body.elements[0].element_id).toBe('footer')
    expect(card.body.elements[0].content).toBe('🔁 重启 Codex (0s)')
    expect(card.body.elements[0].content).not.toContain('restart')
  })

  test('console body can replace a status card footer in place', () => {
    const elements = consoleBodyElements({
      sessionName: 'probe',
      status: 'idle',
      model: 'gpt-5-codex',
      effort: 'xhigh',
      worktreeInstructionNotice: '已载入wt特殊约定',
      peers: [{
        name: 'probe',
        isCurrent: true,
        status: 'working',
        uptimeMs: 65_000,
      }],
      sysinfo: {
        cpu: { cores: 8, load1: 0.42, load5: 0.37, load15: 0.29 },
        mem: {
          totalBytes: 16 * 1024 * 1024 * 1024,
          availBytes: 6 * 1024 * 1024 * 1024,
          usedBytes: 10 * 1024 * 1024 * 1024,
          percent: 63,
        },
        disks: [],
        services: [{
          name: 'codex-probe-runner',
          active: 'active',
          sub: 'running',
          lastActiveAgoSec: 120,
          stateAgoSec: 120,
        }],
        servicesError: null,
      },
      usage: undefined,
    }, 'footer') as any[]

    expect(elements).toHaveLength(4)
    expect(elements[0].element_id).toBe('footer')
    expect(elements[0].tag).toBe('markdown')
    expect(elements[0].content).toContain('**🤖 当前模型**')
    expect(elements[0].content).toContain('`gpt-5-codex/xhigh`')
    expect(elements[0].content).toContain('已载入wt特殊约定')

    expect(elements[1].element_id).toBe('console_projects')
    expect(elements[1].tag).toBe('collapsible_panel')
    expect(elements[1].expanded).toBe(false)
    expect(elements[1].header.title.content).toBe('🗂 活跃项目 (1)')
    expect(elements[1].elements[0].content).toContain('`probe` · 工作中 · 1m · 当前')
    expect(elements[1].elements[0].content).not.toContain('gpt-5-codex')

    expect(elements[2].element_id).toBe('console_host')
    expect(elements[2].tag).toBe('collapsible_panel')
    expect(elements[2].expanded).toBe(false)
    expect(elements[2].header.title.content).toBe('🖥 主机 · L0.42 · M63% · S1')
    expect(elements[2].elements[0].content).toContain('**负载**')
    expect(elements[2].elements[0].content).toContain('**内存**')
    expect(elements[2].elements[0].content).toContain('**服务**')
    expect(elements[2].elements[0].content).not.toContain('**💽 磁盘**')

    expect(elements[3].element_id).toBe('console_usage')
    expect(elements[3].content).toContain('加载中')

    const body = JSON.stringify(elements)
    expect(body).not.toContain('活跃上下文')
    expect(body).not.toContain('上一轮')
    expect(body).not.toContain('累计')
    expect(body).not.toContain('thread')
  })

  test('model command card keeps model and effort selection in one replaceable panel', () => {
    const currentModel = {
      model: 'gpt-5-codex',
      displayName: 'GPT-5 Codex',
      description: 'coding model',
      selected: true,
      efforts: [
        { effort: 'high', selected: true },
        { effort: 'xhigh', isDefault: true },
      ],
    }
    const card = modelSelectionCard({
      sessionName: 'probe',
      panelId: 'panel-1',
      currentModel: 'gpt-5-codex',
      currentEffort: 'high',
      models: [currentModel],
    }) as any

    const panel = card.body.elements[0]
    expect(panel.element_id).toBe('model_panel')
    expect(panel.elements[0].content).toContain('`gpt-5-codex/high`')
    expect(panel.elements[1].columns[1].elements[0].text.content).toBe('选')
    expect(panel.elements[1].columns[1].elements[0].text.content).toHaveLength(1)
    expect(panel.elements[1].columns[1].elements[0].behaviors[0].value).toEqual({
      kind: 'model_select',
      panel_id: 'panel-1',
      model: 'gpt-5-codex',
      display_name: 'GPT-5 Codex',
      is_default: false,
      efforts: [
        { effort: 'high', description: '', is_default: false },
        { effort: 'xhigh', description: '', is_default: true },
      ],
    })

    const effortPanel = modelEffortPanelElement({
      sessionName: 'probe',
      panelId: 'panel-1',
      currentModel: 'gpt-5-codex',
      currentEffort: 'high',
      selectedModel: currentModel,
      selectedEffort: 'xhigh',
    }) as any
    expect(effortPanel.element_id).toBe('model_panel')
    expect(effortPanel.elements[2].columns[1].elements[0].text.content).toBe('选')
    expect(effortPanel.elements[2].columns[1].elements[0].text.content).toHaveLength(1)
    expect(effortPanel.elements[2].columns[1].elements[0].behaviors[0].value).toEqual({
      kind: 'model_effort_select',
      panel_id: 'panel-1',
      model: 'gpt-5-codex',
      effort: 'xhigh',
    })

    const resultPanel = modelResultPanelElement({
      sessionName: 'probe',
      model: 'gpt-5-codex',
      effort: 'xhigh',
      scope: '下一轮开始使用。',
    }) as any
    expect(resultPanel.element_id).toBe('model_panel')
    expect(resultPanel.elements[0].content).toContain('`gpt-5-codex/xhigh`')

    const effortCard = modelEffortCard({
      sessionName: 'probe',
      panelId: 'panel-1',
      currentModel: 'gpt-5-codex',
      currentEffort: 'high',
      selectedModel: currentModel,
      selectedEffort: 'xhigh',
    }) as any
    expect(effortCard.body.elements[0].header.title.content).toBe('选择推理强度')

    const savedCard = modelResultCard({
      sessionName: 'probe',
      model: 'gpt-5-codex',
      effort: 'xhigh',
      scope: '下一轮开始使用。',
    }) as any
    expect(savedCard.header.template).toBe('green')
    expect(savedCard.body.elements[0].header.title.content).toBe('选择已保存')
  })

  test('chat-list summary uses a symbol for turn output', () => {
    const settings = streamingOffSettings({
      durationSec: '12.4',
      outputTokens: 420,
    }) as any

    expect(settings.config.summary.content).toBe('✅ · ⏱ 12.4s · 📶 420')
  })

  test('usage panel shows MISS for missing percentages and no stale badge', () => {
    const content = consoleUsageContent({
      state: 'ok',
      subscriptionType: 'Pro',
      fiveHour: {
        percent: null,
        resetsAt: new Date(Date.now() + 60 * 60 * 1000),
        durationMins: 300,
      },
      weekly: {
        percent: 0,
        resetsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        durationMins: 7 * 24 * 60,
      },
      fetchedAt: Date.now() - 10 * 60 * 1000,
    })

    expect(content).toContain('ChatGPT Pro')
    expect(content).toContain('5h　MISS')
    expect(content).toContain('7d　0%')
    expect(content).not.toContain('缓存')
    expect(content).not.toContain('~')
  })
})

describe('plan and goal rendering', () => {
  test('formats footer context as a percentage', () => {
    expect(footerContextPercentLabel(35_211, 258_000)).toBe('9%')
    expect(footerContextPercentLabel(35_211, null)).toBe('--')
    expect(footerContextPercentLabel(null, 258_000)).toBeNull()
  })

  test('formats compact footer token detail line', () => {
    expect(footerTokenDetailLine({
      input_tokens: 4_900,
        cache_read_input_tokens: 4_400,
      output_tokens: 420,
    })).toBe('└ 入 4.9k ｜ 缓 4.4k ｜ 出 420')
  })

  test('shows placeholders when footer token detail fields are missing', () => {
    expect(footerTokenDetailLine(null)).toBe('└ 入 -- ｜ 缓 -- ｜ 出 --')
  })

  test('renders context compaction pending panel', () => {
    const el = contextCompactionElement(1, {
      threadId: 'thread-123',
      turnId: 'turn-456',
      itemId: 'item-789',
      phase: 'start',
      sourceMethod: 'item/started',
      sourceType: 'contextCompaction',
    }, 'context_compact_1') as any

    expect(el.element_id).toBe('context_compact_1')
    expect(el.tag).toBe('collapsible_panel')
    expect(el.expanded).toBe(false)
    expect(el.header.title.content).toContain('⏳ 🚨 上下文压缩 #2')
    const body = el.elements[0].content
    expect(body).toBe('压缩中...')
  })

  test('renders completed compaction with duration and no summary placeholder', () => {
    const el = contextCompactionElement(0, {
      phase: 'end',
      sourceType: 'contextCompaction',
      startedAtMs: 1780541325287,
      completedAtMs: 1780541433236,
    }, 'context_compact_0') as any

    expect(el.header.title.content).toContain('✅ 🚨 上下文压缩 #1 · 耗时 1m 48s')
    expect(el.header.title.content).not.toContain('结束压缩')
    expect(el.elements[0].content).toBe('暂无有效摘要信息')
  })

  test('renders completed compaction without summary fields explicitly', () => {
    const el = contextCompactionElement(0, {
      phase: 'end',
      sourceType: 'contextCompaction',
      itemId: 'compact-1',
    }, 'context_compact_0') as any

    const body = el.elements[0].content
    expect(el.header.title.content).toContain('✅ 🚨 上下文压缩 #1')
    expect(body).toBe('暂无有效摘要信息')
    expect(body).not.toContain('MISS')
  })

  test('renders authoritative turn plan statuses', () => {
    const el = planElement([
      { step: '读取 app-server 协议', status: 'completed' },
      { step: '接入 plan 通知', status: 'inProgress' },
      { step: '补测试', status: 'pending' },
    ], '按当前协议渲染。', '', 'plan_update_0') as any

    const body = el.elements[0].content
    expect(el.element_id).toBe('plan_update_0')
    expect(el.tag).toBe('collapsible_panel')
    expect(el.expanded).toBe(false)
    expect(el.header.title.content).toBe('📋 计划更新 · 3 项 · 1 进行中 · 1 完成 · 1 待办')
    expect(body).toContain('**📋 当前计划**')
    expect(body).toContain('按当前协议渲染。')
    expect(body).toContain('- ✅ 读取 app-server 协议')
    expect(body).toContain('- 🔄 接入 plan 通知')
    expect(body).toContain('- ☐ 补测试')

    const timelineEl = planElement([{ step: '同步显示更新', status: 'inProgress' }], null, '', 'plan_update_3') as any
    expect(timelineEl.element_id).toBe('plan_update_3')
  })

  test('renders plan draft before authoritative plan lands', () => {
    const el = planElement([], null, '1. 探查代码\n2. 修改卡片', 'plan_update_draft') as any
    const body = el.elements[0].content

    expect(el.element_id).toBe('plan_update_draft')
    expect(el.tag).toBe('collapsible_panel')
    expect(el.expanded).toBe(false)
    expect(el.header.title.content).toBe('📋 计划草稿')
    expect(body).toContain('正在生成计划草稿')
    expect(body).toContain('1. 探查代码')
    expect(body).toContain('2. 修改卡片')
  })

  test('renders thread goal status and budget', () => {
    const el = goalElement({
      objective: '完成 Lodestar plan 展示迁移',
      status: 'active',
      tokenBudget: 12000,
      tokensUsed: 3456,
      timeUsedSeconds: 125,
    }, 'goal_update_0') as any

    const body = el.elements[0].content
    expect(el.element_id).toBe('goal_update_0')
    expect(el.tag).toBe('collapsible_panel')
    expect(el.expanded).toBe(false)
    expect(el.header.title.content).toBe('🎯 目标更新 · 进行中: 完成 Lodestar plan 展示迁移')
    expect(body).toContain('**🎯 当前目标** · 进行中')
    expect(body).toContain('完成 Lodestar plan 展示迁移')
    expect(body).toContain('- 用量: 3456 / 12000 tokens')
    expect(body).toContain('- 用时: 2m 5s')

    const timelineEl = goalElement({
      objective: '目标更新位置可见',
      status: 'complete',
      tokenBudget: null,
      tokensUsed: 500,
      timeUsedSeconds: 9,
    }, 'goal_update_1') as any
    expect(timelineEl.element_id).toBe('goal_update_1')
  })

  test('keeps goal progress-only accounting out of display signature', () => {
    const base = {
      objective: '完成 Lodestar plan 展示迁移',
      status: 'active',
      tokenBudget: 12000,
      tokensUsed: 3456,
      timeUsedSeconds: 125,
    }

    expect(goalDisplaySignature({
      ...base,
      tokensUsed: 9999,
      timeUsedSeconds: 3600,
    })).toBe(goalDisplaySignature(base))
    expect(goalDisplaySignature({
      ...base,
      status: 'complete',
      tokensUsed: 9999,
      timeUsedSeconds: 3600,
    })).not.toBe(goalDisplaySignature(base))
  })
})

describe('ask card rendering', () => {
  test('shows progress in the header and keeps every question title visible', () => {
    const state = {
      currentIdx: 1,
      answered: new Map<number, { optionIdx?: number; customText?: string }>([
        [0, { customText: '第一个答案' }],
      ]),
    }
    const el = askUserQuestionElement(0, 'host_ask_demo', [
      { header: '背景', question: '先确认背景', options: [] },
      { header: '目标', question: '你要哪个目标？', options: [{ label: 'A' }, { label: 'B' }] },
      { header: '期限', question: '什么时候要？', options: [] },
    ], '🤔', state as any, 'host_ask') as any

    expect(el.header.title.content).toBe('🤔 AskUserQuestion · 2/3')
    const body = JSON.stringify(el.elements)
    expect(body).toContain('✅ 1/3 · 先确认背景')
    expect(body).toContain('**回答**：第一个答案')
    expect(body).toContain('🤔 2/3 · 你要哪个目标？')
    expect(body).toContain('⏳ 3/3 · 什么时候要？')
    expect(body).toContain('也可以直接在群里回复你的答案')
  })

  test('host ask card summary carries current progress', () => {
    const card = hostAskCard('host_ask_demo', [
      { header: '背景', question: '先确认背景', options: [] },
      { header: '目标', question: '你要哪个目标？', options: [{ label: 'A' }] },
    ], {
      currentIdx: 0,
      answered: new Map(),
    }) as any

    expect(card.config.summary.content).toContain('1/2')
    expect(card.body.elements).toHaveLength(1)
  })
})

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

  test('limits long bash output in tool panels', () => {
    const input = {
      cmd: '# desc: 读取大文件\nsed -n "1,400p" big.log',
      workdir: '/home/leviyuan/feishu',
    }
    const output = 'A'.repeat(300) + 'TAIL'

    const el = toolCallElement(1, 'exec_command', input, output, '✅') as any
    const body = el.elements[0].content

    expect(body).toContain('_已截断: 仅显示前 300 / 304 字符。_')
    expect(body).toContain('... output 已截断 ...')
    expect(body).not.toContain('TAIL')
  })

  test('unwraps quoted unified exec desc commands', () => {
    const input = {
      command: '"# desc: 查看已跟踪文件中旧关键词引用\nrg -n -i \\"legacy|deprecated|old\\" "\'$(git ls-files)\'',
      cwd: '/home/leviyuan/tradefi-shfe-hedge',
      source: 'unifiedExecStartup',
    }

    expect(summarizeToolInput('Bash', input)).toBe('查看已跟踪文件中旧关键词引用')

    const el = toolCallElement(2, 'Bash', input, null, '✅') as any
    const body = el.elements[0].content

    expect(el.header.title.content).toBe('✅ 🔧 Bash: 查看已跟踪文件中旧关键词引用')
    expect(body).toContain('**目的**: 查看已跟踪文件中旧关键词引用')
    expect(body).toContain('rg -n -i "legacy|deprecated|old" $(git ls-files)')
    expect(body).not.toContain('"# desc:')
    expect(body).not.toContain('\\"legacy')
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
      server: 'external_toolbox',
      tool: 'lookup',
      arguments: { query: 'feishu' },
    }
    const output = JSON.stringify({
      content: [{ type: 'text', text: 'Lookup complete.' }],
      structuredContent: { count: 1 },
    }, null, 2)

    expect(summarizeToolInput('MCP', input)).toBe('external_toolbox.lookup: feishu')

    const el = toolCallElement(6, 'MCP', input, output, '✅') as any
    const body = el.elements[0].content

    expect(el.header.title.content).toBe('✅ 🔧 MCP: external_toolbox.lookup: feishu')
    expect(body).toContain('**server**: `external_toolbox`')
    expect(body).toContain('**tool**: `lookup`')
    expect(body).toContain('"query": "feishu"')
    expect(body).toContain('Lookup complete.')
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
