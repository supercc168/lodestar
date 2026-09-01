import { test, expect } from 'bun:test'
import {
  writeBodyFromToolInput,
  turnListCard,
  resumeListCard,
  writeLogCard,
  selectionResultCard,
} from './temp'

/** 递归数元素树中 action 类元素(button / behaviors 回调):终态卡必须为 0。 */
function countActionElements(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((sum: number, item) => sum + countActionElements(item), 0)
  if (!node || typeof node !== 'object') return 0
  const record = node as Record<string, unknown>
  let count = 0
  if (record.tag === 'button') count++
  if (Array.isArray(record.behaviors) && record.behaviors.length > 0) count++
  for (const value of Object.values(record)) count += countActionElements(value)
  return count
}

test('writeBodyFromToolInput:Write 取 content', () => {
  expect(writeBodyFromToolInput('Write', { file_path: '/a', content: 'hello' })).toBe('hello')
})

test('writeBodyFromToolInput:Edit 取 new_string', () => {
  expect(writeBodyFromToolInput('Edit', { file_path: '/a', old_string: 'x', new_string: 'y' })).toBe('y')
})

test('writeBodyFromToolInput:MultiEdit 拼接所有 new_string', () => {
  expect(writeBodyFromToolInput('MultiEdit', { edits: [{ new_string: 'a' }, { new_string: 'b' }] })).toBe('a\n---\nb')
})

test('writeBodyFromToolInput:无可识别字段返回空串', () => {
  expect(writeBodyFromToolInput('Write', { file_path: '/a' })).toBe('')
  expect(writeBodyFromToolInput('Write', null as any)).toBe('')
})

test('turnListCard:fork 模式生成合法卡片结构 + 按钮 kind', () => {
  const card = turnListCard({
    projectName: 'feishu',
    mode: 'fork',
    entries: [{ idx: 0, preview: '帮我重构', ts: 1700000000000 }],
  }) as any
  expect(card.schema).toBe('2.0')
  expect(card.header.template).toBe('turquoise')
  const btn = card.body.elements.find((e: any) => e.tag === 'column_set')!.columns[1].elements[0]
  expect(btn.text.content).toBe('分叉')
  expect(btn.behaviors[0].value.kind).toBe('temp_fork_select')
  expect(btn.behaviors[0].value.anchorIdx).toBe(0)
})

test('turnListCard:back 模式按钮用 danger + temp_back_select', () => {
  const card = turnListCard({ projectName: 'p', mode: 'back', entries: [{ idx: 2, preview: 'x', ts: 1 }] }) as any
  const btn = card.body.elements.find((e: any) => e.tag === 'column_set')!.columns[1].elements[0]
  expect(btn.type).toBe('danger')
  expect(btn.behaviors[0].value.kind).toBe('temp_back_select')
  expect(card.header.template).toBe('orange')
})

test('turnListCard:无 entries 显示提示,不崩', () => {
  const card = turnListCard({ projectName: 'p', mode: 'fork', entries: [] }) as any
  expect(card.body.elements.some((e: any) => e.tag === 'markdown')).toBe(true)
})

test('resumeListCard:按钮带 sessionId', () => {
  const card = resumeListCard({
    projectName: 'p',
    entries: [{ sessionId: 'abc12345-aaaa-bbbb-cccc-dddddddddddd', preview: '修bug', ts: 1 }],
  }) as any
  const btn = card.body.elements.find((e: any) => e.tag === 'column_set')!.columns[1].elements[0]
  expect(btn.behaviors[0].value).toEqual({ kind: 'temp_resume_select', sessionId: 'abc12345-aaaa-bbbb-cccc-dddddddddddd' })
})

test('writeLogCard:entries 拼成代码块,空则占位', () => {
  const full = writeLogCard({ projectName: 'p', entries: [{ tool: 'Write', path: '/a', body: 'x' }] }) as any
  const codeEl = full.body.elements.find((e: any) => e.tag === 'markdown' && String(e.content).includes('```'))
  expect(codeEl.content).toContain('/a  (Write)')
  expect(codeEl.content).toContain('x')

  const empty = writeLogCard({ projectName: 'p', entries: [] }) as any
  const emptyCode = empty.body.elements.find((e: any) => String(e.content ?? '').includes('```'))!
  expect(emptyCode.content).toContain('无 Write 类操作')
})

test('writeLogCard:超长 body 截断', () => {
  const long = 'x'.repeat(2000)
  const card = writeLogCard({ projectName: 'p', entries: [{ tool: 'Write', path: '/a', body: long }] }) as any
  const codeEl = card.body.elements.find((e: any) => String(e.content).includes('```'))!
  expect(codeEl.content).toContain('…(截断)')
})

// ── selectionResultCard 终态卡(上游 ec149d7 主题 I:一次性选择卡的终态替换) ──

test('selectionResultCard:元素树中 action/button 类元素计数为 0(dedupe TTL 过期后不可再触发)', () => {
  for (const ok of [true, false]) {
    const card = selectionResultCard({ title: '🔱 会话分叉', message: '已分叉到 x*0000-0000', ok })
    expect(countActionElements(card)).toBe(0)
  }
  // 对照:源选择卡本身是有按钮的(否则计数器空转,断言无意义)。
  const source = turnListCard({
    projectName: 'p', mode: 'fork', entries: [{ idx: 0, preview: 'x', ts: 1 }],
  })
  expect(countActionElements(source)).toBeGreaterThan(0)
})

test('selectionResultCard:ok=true 绿头 ✅,ok=false 红头 ❌', () => {
  const okCard = selectionResultCard({ title: '⏪ 会话回滚', message: '已回滚到锚点 1', ok: true }) as any
  expect(okCard.schema).toBe('2.0')
  expect(okCard.header.template).toBe('green')
  expect(okCard.header.title.content).toBe('⏪ 会话回滚')
  expect(String(okCard.body.elements[0].content)).toStartWith('✅')

  const failCard = selectionResultCard({ title: '🔁 会话恢复', message: '恢复失败', ok: false }) as any
  expect(failCard.header.template).toBe('red')
  expect(String(failCard.body.elements[0].content)).toStartWith('❌')
})

test('selectionResultCard:message 尖括号/& 转义(防 markdown 注入)', () => {
  const card = selectionResultCard({ title: 't', message: 'a<b>&c', ok: true }) as any
  const content = String(card.body.elements[0].content)
  expect(content).toContain('a&lt;b&gt;&amp;c')
  expect(content).not.toContain('<b>')
})
