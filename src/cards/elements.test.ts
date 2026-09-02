import { describe, expect, test } from 'bun:test'

import {
  sanitizeMarkdownForCardKit,
  downgradeExternalImagesForCardKit,
  neutralizeMarkdownImagesInCard,
} from './elements'

describe('sanitizeMarkdownForCardKit', () => {
  test('降级 prose 里的外链图片,保留 alt + url', () => {
    const out = sanitizeMarkdownForCardKit('看 ![logo](https://res.mail.qq.com/x/y.png) 图')
    expect(out).not.toMatch(/!\[/) // 不残留会被 CardKit 解析成 image 的语法
    expect(out).toContain('https://res.mail.qq.com/x/y.png')
    expect(out).toContain('logo')
  })

  test('alt 为空时只保留 url', () => {
    const out = sanitizeMarkdownForCardKit('前置 ![](https://x/y.png) 后置')
    expect(out).not.toMatch(/!\[/)
    expect(out).toContain('https://x/y.png')
  })

  test('不按字符串外形信任图片 key,占位符和伪造 key 都降级', () => {
    // 防回归锚(上游 4185808):按 `img_...` 外形放行不能证明来自飞书上传,
    // 线上出现过占位符 `img_key` 被误放行触发 200570。Phase 3 落 TEX 公式图
    // 时也不得为此重新引入外形白名单(公式图走结构化 tag:'img',不经此路径)。
    for (const key of ['img_key', 'img_v2_fakeKey123']) {
      const out = sanitizeMarkdownForCardKit(`评分公式:\n\n![formula](${key})\n\n完`)
      expect(out).not.toContain('![formula]')
      expect(out).toContain(key)
    }
  })

  test('代码块内的图片语法原样保留(字面量,不解析也不转义)', () => {
    const src = '```\n![](https://x/y.png)\n```'
    expect(sanitizeMarkdownForCardKit(src)).toBe(src)
  })

  test('行内代码内的图片/特殊字符原样保留', () => {
    expect(sanitizeMarkdownForCardKit('运行 `a & b <c> ![](x)` 命令')).toBe('运行 `a & b <c> ![](x)` 命令')
  })

  test('prose 里的 HTML 特殊字符转义,防被 CardKit 当结构吞', () => {
    expect(sanitizeMarkdownForCardKit('a <b> & c > d')).toBe('a &lt;b&gt; &amp; c &gt; d')
  })

  test('代码块内的 & 与 <> 不被转义(字面量保真)', () => {
    expect(sanitizeMarkdownForCardKit('```\na & b < c > d\n```')).toBe('```\na & b < c > d\n```')
  })

  test('保留合法 markdown:粗体 / 文字链接 / 列表(<> 仍转义,引用块退化为字面 >)', () => {
    const src = '**粗体** [文字](https://x) - 列表项'
    expect(sanitizeMarkdownForCardKit(src)).toBe(src)
    // 行首 > 是引用语法,但 > 属 HTML 特殊字符会被转义 → 引用退化为字面
    // "> ..."(信息保留,仅样式丢失),换来 prose 里 <tag> 不被 CardKit 吞。
    expect(sanitizeMarkdownForCardKit('> 引用')).toBe('&gt; 引用')
  })

  test('文字链接 [text](url) 不被降级(只有 ! 开头的图片才降级)', () => {
    const src = '见 [文档](https://open.feishu.cn/x)'
    expect(sanitizeMarkdownForCardKit(src)).toBe(src)
  })

  test('混合:prose 图片降级,代码块内图片保留', () => {
    const out = sanitizeMarkdownForCardKit('图 ![](https://a/b.png) 代码\n```\n![](https://c/d.png)\n```')
    expect(out).not.toMatch(/!\[\]\(https:\/\/a\//) // prose 的已降级
    expect(out).toContain('🖼️ https://a/b.png')
    expect(out).toContain('![](https://c/d.png)') // 代码块内原样
  })

  test('空串安全', () => {
    expect(sanitizeMarkdownForCardKit('')).toBe('')
  })

  test('4+ 反引号 fence(fenceBlock 包裹含 ``` 的内容)内层 ``` 与 & < > 字面保留', () => {
    // tool.ts 的 fenceBlock 在内容含 ``` 时把 fence 扩到 4+ 反引号;
    // sanitize 必须用「同长反向引用」识别可变 fence,否则会把内层 ```
    // 当边界劈开 fence,把 fence 内的 & < > 当 prose 转义。
    const src = '````\nsee ```a < b & c``` here\n````'
    expect(sanitizeMarkdownForCardKit(src)).toBe(src)
  })

  test('tilde fence 与多反引号 inline code 内的公式保持字面量', () => {
    const src = '~~~tex\n$$x^2$$ & <tag>\n~~~\n``$$y^2$$ & <tag>``'
    expect(sanitizeMarkdownForCardKit(src)).toBe(src)
  })

  test('图片 url 含空格时保留完整(不截断到空白)', () => {
    const out = sanitizeMarkdownForCardKit('![diagram](https://example.com/my architecture.png)')
    expect(out).not.toMatch(/!\[/)
    expect(out).toContain('https://example.com/my architecture.png')
  })

  test('嵌套 alt/url 也不残留可解析的图片 opener', () => {
    for (const src of [
      '![](foo![x](img_key))',
      '![a [b]](img_key)',
    ]) {
      expect(sanitizeMarkdownForCardKit(src)).not.toContain('![')
    }
  })
})

describe('sanitizeMarkdownForCardKit —— LaTeX 定界符降级(飞书卡片不渲染数学)', () => {
  test('\\[..\\] display math → 代码块', () => {
    const out = sanitizeMarkdownForCardKit('推导:\\[ x^2 + y^2 = z^2 \\] 完毕')
    expect(out).not.toContain('\\[')
    expect(out).not.toContain('\\]')
    expect(out).toContain('```\nx^2 + y^2 = z^2\n```')
  })

  test('$$..$$ display math → 代码块', () => {
    const out = sanitizeMarkdownForCardKit('$$ E=mc^2 $$')
    expect(out).not.toContain('$$')
    expect(out).toContain('```\nE=mc^2\n```')
  })

  test('\\(..\\) inline math → 行内 code(定界符无歧义,直接降级)', () => {
    const out = sanitizeMarkdownForCardKit('其中 \\( a+b \\) 为和')
    expect(out).toBe('其中 `a+b` 为和')
  })

  test('$..$ 带数学特征(\\ 命令 / ^ / _ / =)才降级为行内 code', () => {
    expect(sanitizeMarkdownForCardKit('设 $x^2$ 为平方')).toBe('设 `x^2` 为平方')
    expect(sanitizeMarkdownForCardKit('令 $a=b$ 成立')).toBe('令 `a=b` 成立')
    expect(sanitizeMarkdownForCardKit('分数 $\\frac{1}{2}$ 表示')).toBe('分数 `\\frac{1}{2}` 表示')
  })

  test('美元金额不误伤:「价格 $5 和 $10」原样保留', () => {
    const src = '价格 $5 和 $10 之间'
    expect(sanitizeMarkdownForCardKit(src)).toBe(src)
  })

  test('代码块内的 LaTeX 定界符字面保留(不降级)', () => {
    const src = '```\n\\[ x^2 \\] $$y$$\n```'
    expect(sanitizeMarkdownForCardKit(src)).toBe(src)
  })
})

describe('downgradeExternalImagesForCardKit', () => {
  test('降级 prose 外链图片,代码块内图片原样保留', () => {
    const out = downgradeExternalImagesForCardKit('图 ![](https://x/y.png) 代码\n```\n![](https://c/d.png)\n```')
    expect(out).not.toMatch(/!\[\]\(https:\/\/x\//)
    expect(out).toContain('https://x/y.png')
    expect(out).toContain('![](https://c/d.png)')
  })

  test('保留 <font> 等 HTML 标签不转义(供 notify 调用方做彩色)', () => {
    expect(downgradeExternalImagesForCardKit("<font color='red'>构建失败</font>"))
      .toBe("<font color='red'>构建失败</font>")
  })

  test('prose 里的 & < > 不转义(与 sanitizeMarkdownForCardKit 的关键区别)', () => {
    expect(downgradeExternalImagesForCardKit('a < b & c > d')).toBe('a < b & c > d')
  })

  test('代码块内的图片语法与 HTML 标签原样保留(字面)', () => {
    const src = "```\n![](https://x/y.png)\n<font color='red'>x</font>\n```"
    expect(downgradeExternalImagesForCardKit(src)).toBe(src)
  })
})

describe('neutralizeMarkdownImagesInCard(卡片 JSON 最终边界,上游 4185808)', () => {
  test('顶层 markdown 元素中的 ![alt](key) 被中和,输入卡片零变异(深拷贝)', () => {
    const input = {
      body: {
        elements: [
          { tag: 'markdown', content: '结果 ![bad](img_key) 完' },
          { tag: 'markdown', content: '![](https://evil.example/x.png)' },
        ],
      },
    }
    const card = neutralizeMarkdownImagesInCard(input) as any
    for (const el of card.body.elements) expect(el.content).not.toContain('![')
    expect(card.body.elements[0].content).toContain('img_key')
    expect(card.body.elements[1].content).toContain('https://evil.example/x.png')
    // 无副作用:调用方持有的原卡(session 会复用/重投)不被就地改写
    expect(input.body.elements[0].content).toBe('结果 ![bad](img_key) 完')
  })

  test('递归覆盖嵌套容器(column_set/collapsible_panel)里的 markdown sink,保留结构化图片和 HTML', () => {
    const card = neutralizeMarkdownImagesInCard({
      body: {
        elements: [
          {
            tag: 'collapsible_panel',
            elements: [{ tag: 'markdown', content: "<font color='red'>x</font> ![bad](img_key)" }],
          },
          {
            tag: 'column_set',
            columns: [
              { tag: 'column', elements: [{ tag: 'markdown', content: '嵌 ![n](img_v2_fake)' }] },
            ],
          },
          { tag: 'img', img_key: 'img_v2_uploaded' },
        ],
      },
    }) as any

    const markdown = card.body.elements[0].elements[0].content
    expect(markdown).toContain("<font color='red'>x</font>")
    expect(markdown).not.toContain('![')
    expect(markdown).toContain('img_key')
    const columnMd = card.body.elements[1].columns[0].elements[0].content
    expect(columnMd).not.toContain('![')
    expect(columnMd).toContain('img_v2_fake')
    expect(card.body.elements[2]).toEqual({ tag: 'img', img_key: 'img_v2_uploaded' })
  })

  test('无图片语法的卡片 JSON 深度相等(无副作用),各类型节点透传', () => {
    const card = {
      config: { wide_screen_mode: true, update_multi: true },
      header: { title: { tag: 'plain_text', content: '标题' }, template: 'blue' },
      body: {
        elements: [
          { tag: 'markdown', content: '**粗体** [文字](https://x) `code` 与 <font>色</font>' },
          { tag: 'div', text: { tag: 'plain_text', content: '纯文本 ' } },
          {
            tag: 'action',
            actions: [
              { tag: 'button', text: { tag: 'plain_text', content: '选' }, value: { kind: 'ask', n: 1, ok: true, nil: null } },
            ],
          },
        ],
      },
    }
    const out = neutralizeMarkdownImagesInCard(card)
    expect(out).toEqual(card)
  })
})
