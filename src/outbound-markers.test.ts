import { describe, expect, test } from 'bun:test'

import { extractAskUsrMarkers, extractSendMarkerPaths, stripAskUsrMarkers } from './outbound-markers'

describe('outbound send markers', () => {
  test('extracts paths that contain square brackets', () => {
    const text = '[[send: /home/leviyuan/mmo[avatar]/client/assets/avatar_demo/avatar_contact_sheet.png]]'

    expect(extractSendMarkerPaths(text)).toEqual([
      '/home/leviyuan/mmo[avatar]/client/assets/avatar_demo/avatar_contact_sheet.png',
    ])
  })

  test('extracts multiple markers and trims marker padding', () => {
    const text = [
      'first [[send:  /tmp/a.png  ]]',
      'second [[send: /tmp/out[1].jpg]]',
    ].join('\n')

    expect(extractSendMarkerPaths(text)).toEqual([
      '/tmp/a.png',
      '/tmp/out[1].jpg',
    ])
  })

  test('does not match markers split across lines', () => {
    expect(extractSendMarkerPaths('[[send: /tmp/a.png\n]]')).toEqual([])
  })
})

describe('host askusr markers', () => {
  test('extracts askusr payloads as raw marker and payload text', () => {
    const text = 'before [[askusr: {"question":"A?","options":[{"label":"Yes"}]}]] after'

    expect(extractAskUsrMarkers(text)).toEqual([
      {
        raw: '[[askusr: {"question":"A?","options":[{"label":"Yes"}]}]]',
        payload: '{"question":"A?","options":[{"label":"Yes"}]}',
      },
    ])
  })

  test('strips askusr markers without touching surrounding text', () => {
    const text = 'a [[askusr: {"question":"A?"}]] b'

    expect(stripAskUsrMarkers(text, '[ASK]')).toBe('a [ASK] b')
  })

  test('does not match askusr markers split across lines', () => {
    expect(extractAskUsrMarkers('[[askusr: {"question":"A?"}\n]]')).toEqual([])
  })

  test('tolerates a missing final closing bracket', () => {
    // 模型常输出 `[[askusr: {...]}]`（只关一层），旧正则要求 `]]` 会整段失败。
    const text = 'before [[askusr: {"questions":[{"question":"Pick?","options":["A","B"]}]}]] after'
    // 上面是正确形态；下面故意少一个 ]
    const broken = 'before [[askusr: {"questions":[{"question":"Pick?","options":["A","B"]}]}] after'

    expect(extractAskUsrMarkers(text)).toHaveLength(1)
    expect(extractAskUsrMarkers(broken)).toEqual([
      {
        raw: '[[askusr: {"questions":[{"question":"Pick?","options":["A","B"]}]}]',
        payload: '{"questions":[{"question":"Pick?","options":["A","B"]}]}',
      },
    ])
    expect(stripAskUsrMarkers(broken, '[ASK]')).toBe('before [ASK] after')
  })

  test('extracts when option labels contain ]] sequences', () => {
    const text = '[[askusr: {"questions":[{"question":"x","options":["a]]b","c d"]}]}]]'
    const markers = extractAskUsrMarkers(text)
    expect(markers).toHaveLength(1)
    expect(markers[0]?.payload).toBe('{"questions":[{"question":"x","options":["a]]b","c d"]}]}')
    expect(stripAskUsrMarkers(text, '')).toBe('')
  })

  test('does not match until at least one closing bracket arrives', () => {
    expect(extractAskUsrMarkers('[[askusr: {"question":"A?","options":["A","B"]}}')).toEqual([])
  })

  test('accepts the real-world missing-bracket multi-question payload', () => {
    const text = [
      '可以执行，但当前不能诚实地称为“545 项全部重导”：',
      '',
      '- 5 个仍被技能引用的 NP 资源标记了 IgnoreScan=1。',
      '',
      '[[askusr: {"questions":[{"question":"5 个标记 IgnoreScan=1、但仍被技能配置引用的 NP 资源如何处理？","options":["保留现有产物，不强制重导（推荐；尊重忽略标记，并纳入全量回读）","明确强制重导这 5 项（风险较高，会覆盖显式忽略标记）"]},{"question":"Box2D 的 2 个缺失产物和 5 个无源历史产物如何处理？","options":["生成缺失的 2 个并保留无源的 5 个（推荐；非破坏，最终 547 项）","生成缺失的 2 个并删除无源的 5 个（严格按源收敛，最终 542 项）","维持现有 545 项，不生成也不删除（不能称为源全集已导出）"]}]}]',
    ].join('\n')

    const markers = extractAskUsrMarkers(text)
    expect(markers).toHaveLength(1)
    const payload = JSON.parse(markers[0]!.payload) as {
      questions: Array<{ question: string; options: string[] }>
    }
    expect(payload.questions).toHaveLength(2)
    expect(payload.questions[0]?.options).toHaveLength(2)
    expect(payload.questions[1]?.options).toHaveLength(3)
    expect(stripAskUsrMarkers(text, '_ASK_')).toContain('_ASK_')
    expect(stripAskUsrMarkers(text, '_ASK_')).not.toContain('[[askusr:')
  })
})
