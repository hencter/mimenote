/**
 * Markdown → 绘制块清单（`features/graph/canvas/blocks.ts`）。
 *
 * 这一层是"知识图谱节点画成 Markdown 预览"的第一步，所以测试的口径是**语义**而不是像素：
 * 标题几级、列表从第几号开始、哪几个字是粗体、图片的尺寸属性读没读到。
 * 像素（换行与高度）在 `tests/graph-text-layout.test.ts` 里断言，两边分开，
 * 任何一边红了都能立刻知道是"解析错了"还是"排版错了"。
 *
 * 期望值全部写成**字面量**（而不是从实现里导出的常量）：这些清单是画笔与测试之间的契约，
 * 改动实现让测试跟着变就等于没有测试。
 */

import { describe, expect, it } from 'vitest'

import {
  toDrawBlocks,
  type CalloutBlock,
  type DrawBlock,
  type InlineRun,
} from '@/features/graph/canvas/blocks'

/** 取第一个块（大多数用例只关心一个块，写出来比 `[0]` 加断言更短且失败信息更清楚）。 */
function first(markdown: string): DrawBlock {
  const block = toDrawBlocks(markdown)[0]
  if (block === undefined) throw new Error(`没有产出任何块：${JSON.stringify(markdown)}`)
  return block
}

/** 取第一个段落块的行内 run。 */
function paragraphRuns(markdown: string): InlineRun[] {
  const block = first(markdown)
  if (block.kind !== 'paragraph') throw new Error(`期望段落块，实际是 ${block.kind}`)
  return block.runs
}

/**
 * 列表项的期望值。
 *
 * 用构造器而不是每次都写全 `{ kind, ordered, index, depth, runs, checked }`：一行会超 100 列，
 * 拆行又会让"这一条到底断言了哪几个字段"变得难读。这里只把**默认值**写一次，
 * 每条用例只写它真正关心的字段（默认值恰好就是"无序、第 0 层、非任务项"）。
 */
function item(overrides: Partial<Extract<DrawBlock, { kind: 'list-item' }>> = {}): DrawBlock {
  return {
    kind: 'list-item',
    ordered: false,
    index: 0,
    depth: 0,
    runs: [],
    checked: undefined,
    ...overrides,
  }
}

describe('标题', () => {
  it('ATX 标题的 1–6 级各自成为一个 heading 块', () => {
    const levels = [1, 2, 3, 4, 5, 6] as const
    const source = levels.map((level) => `${'#'.repeat(level)} 第${level}级`).join('\n')

    expect(toDrawBlocks(source)).toEqual(
      levels.map((level) => ({ kind: 'heading', level, runs: [{ text: `第${level}级` }] })),
    )
  })

  it('setext 标题（下划线写法）也是标题，且级别由下划线决定', () => {
    // `===` 是一级、`---` 是二级 —— 后者最容易踩坑：`---` 单独一行是分隔线，
    // 紧跟在文字下面才是二级标题（markdown-it 的 block 规则顺序决定了这件事）
    expect(toDrawBlocks('标题\n===')).toEqual([
      { kind: 'heading', level: 1, runs: [{ text: '标题' }] },
    ])
    expect(toDrawBlocks('标题\n---')).toEqual([
      { kind: 'heading', level: 2, runs: [{ text: '标题' }] },
    ])
  })

  it('标题里的行内样式照常保留（标题不是纯文本）', () => {
    const block = first('## 带 **粗体** 的标题')
    expect(block).toEqual({
      kind: 'heading',
      level: 2,
      runs: [{ text: '带 ' }, { text: '粗体', bold: true }, { text: ' 的标题' }],
    })
  })
})

describe('段落与软换行', () => {
  it('同一段里的换行是**空格**（breaks: false，与阅读视图同口径）', () => {
    // 与 `renderMarkdown` 的口径必须一致：那边是 `<p>第一行 第二行</p>`，
    // 画布这边就不能变成两行 —— 否则同一篇笔记在两个视图里段落数都不一样
    expect(toDrawBlocks('第一行\n第二行')).toEqual([
      { kind: 'paragraph', runs: [{ text: '第一行 第二行' }] },
    ])
  })

  it('空行分段，多余的空行不产生空块', () => {
    expect(toDrawBlocks('第一段\n\n\n\n第二段')).toEqual([
      { kind: 'paragraph', runs: [{ text: '第一段' }] },
      { kind: 'paragraph', runs: [{ text: '第二段' }] },
    ])
  })

  it('空输入 / 纯空白不产出任何块（否则画布上会多出莫名的缝隙）', () => {
    expect(toDrawBlocks('')).toEqual([])
    expect(toDrawBlocks('\n\n   \n\n')).toEqual([])
  })

  it('行尾两个空格是**硬**换行（与阅读视图的 <br> 对应）', () => {
    expect(paragraphRuns('上  \n下')).toEqual([{ text: '上\n下' }])
  })
})

describe('行内样式', () => {
  it('粗体 / 斜体 / 行内代码 / 删除线各自带上标志', () => {
    expect(paragraphRuns('这是 **粗体** 与 *斜体* 与 `代码` 与 ~~删除~~')).toEqual([
      { text: '这是 ' },
      { text: '粗体', bold: true },
      { text: ' 与 ' },
      { text: '斜体', italic: true },
      { text: ' 与 ' },
      { text: '代码', code: true },
      { text: ' 与 ' },
      { text: '删除', strikethrough: true },
    ])
  })

  it('嵌套的样式是**叠加**的（粗体里的斜体两样都真）', () => {
    expect(paragraphRuns('**粗 *粗斜* 粗**')).toEqual([
      { text: '粗 ', bold: true },
      { text: '粗斜', bold: true, italic: true },
      { text: ' 粗', bold: true },
    ])
  })

  it('行内代码里也保留外层样式（对应阅读视图的 <strong><code>）', () => {
    expect(paragraphRuns('**`code`**')).toEqual([{ text: 'code', code: true, bold: true }])
  })

  it('转义与实体都还原成文字', () => {
    expect(paragraphRuns('a \\* b &amp; c')).toEqual([{ text: 'a * b & c' }])
  })
})

describe('链接与 wikilink', () => {
  it('Markdown 链接：文字带 link 标志，href 留作诊断', () => {
    expect(paragraphRuns('[文档](guide.md)')).toEqual([
      { text: '文档', link: true, href: 'guide.md' },
    ])
  })

  it('链接里的粗体既保留样式也保留链接标志', () => {
    expect(paragraphRuns('[**粗**](x.md)')).toEqual([
      { text: '粗', link: true, href: 'x.md', bold: true },
    ])
  })

  it('`[[…]]` 是 wikilink：按链接画（link 也为真）但虚线由 wikilink 决定', () => {
    // `link: true` 一定伴随 `wikilink: true` —— 这是给画笔的显式契约（见 InlineRun 的注释），
    // 因为阅读视图里 `a.mn-wikilink` 的样式就是"链接着色 + 虚线下划线"
    expect(paragraphRuns('见 [[另一篇]]')).toEqual([
      { text: '见 ' },
      { text: '另一篇', wikilink: true, link: true, href: '另一篇' },
    ])
  })

  it('wikilink 的别名与锚点：显示文本用别名，href 用目标', () => {
    expect(paragraphRuns('[[某篇#小节|小节标题]]')).toEqual([
      { text: '小节标题', wikilink: true, link: true, href: '某篇' },
    ])
  })

  it('`![[非图片目标]]` 的嵌入形状（包了一层 span）也解析出显示文本', () => {
    // ⚠️ 这里钉的是 domain/markdown-core.ts 的 `wikilinkAnchorHtml` 产出的**第二种形状**：
    // `<a class="mn-wikilink"><span class="mn-wikilink__embed">文本</span></a>`。
    // 那条规则改形状，这个用例会立刻红 —— 那正是它的存在意义
    expect(paragraphRuns('![[某笔记]]')).toEqual([
      { text: '某笔记', wikilink: true, link: true, href: '某笔记' },
    ])
    expect(paragraphRuns('![[某笔记|别名]]')).toEqual([
      { text: '别名', wikilink: true, link: true, href: '某笔记' },
    ])
  })

  it('`![[图.png]]` 是**图片**而不是链接（与阅读视图同一套分流规则）', () => {
    expect(first('![[附件/图.png]]')).toEqual({
      kind: 'image',
      alt: '图.png',
      src: '附件/图.png',
      width: null,
      height: null,
    })
  })

  it('linkify 出来的裸网址也是链接（token 来源与我们自己写的链接是同一条路径）', () => {
    expect(paragraphRuns('见 https://example.com 吧')).toEqual([
      { text: '见 ' },
      { text: 'https://example.com', link: true, href: 'https://example.com' },
      { text: ' 吧' },
    ])
  })
})

describe('列表', () => {
  it('有序列表的**起始序号**从属性里读（不是从 1 数起）', () => {
    expect(toDrawBlocks('3. 三\n4. 四')).toEqual([
      item({ ordered: true, index: 3, runs: [{ text: '三' }] }),
      item({ ordered: true, index: 4, runs: [{ text: '四' }] }),
    ])
  })

  it('无序列表：index 恒为 0（画笔只在 ordered 为真时才画序号）', () => {
    expect(toDrawBlocks('- a\n- b')).toEqual([
      item({ runs: [{ text: 'a' }] }),
      item({ runs: [{ text: 'b' }] }),
    ])
  })

  it('嵌套列表用 depth 表示层级（每一层都在自己的栈帧里数序号）', () => {
    expect(toDrawBlocks('3. 三\n   - 子项\n     1. 孙项')).toEqual([
      item({ ordered: true, index: 3, runs: [{ text: '三' }] }),
      item({ depth: 1, runs: [{ text: '子项' }] }),
      item({ ordered: true, index: 1, depth: 2, runs: [{ text: '孙项' }] }),
    ])
  })

  it('任务列表识别 `[ ]` / `[x]`，并把标记从文字里去掉', () => {
    // markdown-it 默认 preset **没有** task-list 插件，`[ ]` 在 token 里就是普通文字；
    // 这里主动识别它（有意的差异：卡片上的清单要读起来像清单）
    expect(toDrawBlocks('- [ ] 未完成\n- [x] 已完成\n- [X] 大写也算')).toEqual([
      item({ runs: [{ text: '未完成' }], checked: false }),
      item({ runs: [{ text: '已完成' }], checked: true }),
      item({ runs: [{ text: '大写也算' }], checked: true }),
    ])
  })

  it('用户手写的方括号文字不会被当成任务标记', () => {
    // 第一个 run 是**粗体**，所以即使它长得像 `[x]` 也不认（用户手写的方括号是有含义的文字）；
    // 接下来那一段普通文字属于同一个条目，因此照样留在文字里
    expect(toDrawBlocks('- **[x]** 这是手写文字')).toEqual([
      item({ runs: [{ text: '[x]', bold: true }, { text: ' 这是手写文字' }] }),
    ])
  })

  it('只有勾选框、没有文字的任务项仍然产出一个块（扔掉它等于删掉用户的待办）', () => {
    expect(toDrawBlocks('- [ ]')).toEqual([item({ checked: false })])
  })

  it('完全没有内容的列表项不产块（`-` 后面什么都没有）', () => {
    expect(toDrawBlocks('- \n- b')).toEqual([item({ runs: [{ text: 'b' }] })])
  })

  it('父条目在子列表**之前**落地（嵌套列表不会吞掉父条目）', () => {
    // markdown-it 的 token 顺序是"先开内层、后关外层"，所以这一步必须显式收尾父条目；
    // 不这么做的话父条目的文字会被内层抢走（表现为"一有嵌套列表，父条目就消失"）
    expect(toDrawBlocks('- a\n  - b\n- c')).toEqual([
      item({ runs: [{ text: 'a' }] }),
      item({ depth: 1, runs: [{ text: 'b' }] }),
      item({ runs: [{ text: 'c' }] }),
    ])
  })

  it('任务项的勾选框留在父条目上（子列表不受影响）', () => {
    expect(toDrawBlocks('- [x] 父任务\n  - 子项')).toEqual([
      item({ runs: [{ text: '父任务' }], checked: true }),
      item({ depth: 1, runs: [{ text: '子项' }] }),
    ])
  })

  it('松散列表项里的第二段用强制换行接在同一条目上（不重复项目符号）', () => {
    expect(toDrawBlocks('- 第一段\n\n  第二段')).toEqual([
      item({ runs: [{ text: '第一段' }, { text: '\n' }, { text: '第二段' }] }),
    ])
  })

  it('列表项里的行内样式照常保留', () => {
    const block = first('- 带 `代码` 的条目')
    if (block.kind !== 'list-item') throw new Error(`期望列表项，实际是 ${block.kind}`)
    expect(block.runs).toEqual([
      { text: '带 ' },
      { text: '代码', code: true },
      { text: ' 的条目' },
    ])
  })
})

describe('引用', () => {
  it('单层引用 depth 为 0（depth 是**嵌套层级**，符号由画笔画在 indent 处）', () => {
    expect(toDrawBlocks('> 引用文字')).toEqual([
      { kind: 'quote', depth: 0, runs: [{ text: '引用文字' }] },
    ])
  })

  it('嵌套引用逐层加深', () => {
    expect(toDrawBlocks('> 外层\n>\n> > 内层')).toEqual([
      { kind: 'quote', depth: 0, runs: [{ text: '外层' }] },
      { kind: 'quote', depth: 1, runs: [{ text: '内层' }] },
    ])
  })

  it('引用里的多段各自成一个引用块（每段都带自己的竖线，与 <blockquote><p><p> 一致）', () => {
    expect(toDrawBlocks('> 第一段\n>\n> 第二段')).toEqual([
      { kind: 'quote', depth: 0, runs: [{ text: '第一段' }] },
      { kind: 'quote', depth: 0, runs: [{ text: '第二段' }] },
    ])
  })

  it('引用里的列表是列表（层级从引用里重新起算）', () => {
    expect(toDrawBlocks('> - a\n> - b')).toEqual([
      item({ runs: [{ text: 'a' }] }),
      item({ runs: [{ text: 'b' }] }),
    ])
  })
})

describe('代码块', () => {
  it('围栏代码块的语言取自 info，行按原样返回', () => {
    expect(toDrawBlocks('```ts\nconst a = 1\nconst b = 2\n```')).toEqual([
      { kind: 'code', language: 'ts', lines: ['const a = 1', 'const b = 2'] },
    ])
  })

  it('没写语言时 language 是空串（不是 undefined —— 画笔据此决定要不要画语言标签）', () => {
    expect(toDrawBlocks('```\nplain\n```')).toEqual([
      { kind: 'code', language: '', lines: ['plain'] },
    ])
  })

  it('info 里除语言之外的标记不算语言（```ts {1} 的语言是 ts）', () => {
    expect(first('```ts {1}\nx\n```')).toEqual({ kind: 'code', language: 'ts', lines: ['x'] })
  })

  it('代码块内容结尾的换行不产生一个多余的空行', () => {
    expect(first('```\nonly\n```')).toEqual({ kind: 'code', language: '', lines: ['only'] })
  })

  it('缩进式代码块（四个空格）也算代码块，语言为空', () => {
    expect(first('    indented\n    code')).toEqual({
      kind: 'code',
      language: '',
      lines: ['indented', 'code'],
    })
  })

  it('未闭合的围栏仍然是代码块（解析到流末尾）', () => {
    expect(first('```ts\nx')).toEqual({ kind: 'code', language: 'ts', lines: ['x'] })
  })

  it('代码块里的 `**` 不会被当成粗体', () => {
    expect(first('```\n**不是粗体**\n```')).toEqual({
      kind: 'code',
      language: '',
      lines: ['**不是粗体**'],
    })
  })
})

describe('分隔线', () => {
  it('`---` 单独成块（它不折行、也没有文字）', () => {
    expect(toDrawBlocks('a\n\n---\n\nb')).toEqual([
      { kind: 'paragraph', runs: [{ text: 'a' }] },
      { kind: 'hr' },
      { kind: 'paragraph', runs: [{ text: 'b' }] },
    ])
  })
})

describe('图片', () => {
  it('尺寸只从我们自己的 `data-mn-width/height` 读（`![](…)` 没有 ⇒ null）', () => {
    expect(first('![](photo.png)')).toEqual({
      kind: 'image',
      alt: '',
      src: 'photo.png',
      width: null,
      height: null,
    })
  })

  it('`![](…)` 的非 ASCII 路径保持 markdown-it 的百分号编码（与阅读视图同源）', () => {
    // 阅读视图里 `attrGet('src')` 拿到的也是这个编码后的字符串（宿主的 `resolveVaultAssetRel`
    // 会先解码再解析）。这里**不**替它解码：两边各解一次码，同一张图就可能解析到不同文件
    expect(first('![](图.png)')).toEqual({
      kind: 'image',
      alt: '',
      src: encodeURI('图.png'),
      width: null,
      height: null,
    })
  })

  it('`![[图.png|300x200]]` 的尺寸读得到，alt 退化成文件名（与阅读视图一致）', () => {
    expect(first('![[附件/图.png|300x200]]')).toEqual({
      kind: 'image',
      alt: '图.png',
      src: '附件/图.png',
      width: 300,
      height: 200,
    })
  })

  it('`![[图.png|300]]` 只有宽度（高度按原图比例，画布那层再估）', () => {
    expect(first('![[图.png|300]]')).toEqual({
      kind: 'image',
      alt: '图.png',
      src: '图.png',
      width: 300,
      height: null,
    })
  })

  it('非数字的别名是**图注**，不是尺寸', () => {
    expect(first('![[图.png|一张图]]')).toEqual({
      kind: 'image',
      alt: '一张图',
      src: '图.png',
      width: null,
      height: null,
    })
  })

  it('夹在文字里的图片会把段落切成三段（图片自己是一个盒子）', () => {
    expect(toDrawBlocks('前面 ![](photo.png) 后面')).toEqual([
      { kind: 'paragraph', runs: [{ text: '前面 ' }] },
      { kind: 'image', alt: '', src: 'photo.png', width: null, height: null },
      { kind: 'paragraph', runs: [{ text: ' 后面' }] },
    ])
  })

  it('一行里连续两张图是两块（顺序保持不变）', () => {
    const kinds = toDrawBlocks('![](a.png)![](b.png)').map((block) => block.kind)
    expect(kinds).toEqual(['image', 'image'])
  })
})

describe('GFM 表格', () => {
  it('表头 / 数据行 / 每列对齐都从 token 上取', () => {
    expect(first('| 名称 | 数量 |\n|:-----|-----:|\n| a | 1 |')).toEqual({
      kind: 'table',
      header: [['名称', '数量']],
      rows: [['a', '1']],
      aligns: ['left', 'right'],
    })
  })

  it('没有对齐标记的列按左对齐（markdown-it 连 style 都不写）', () => {
    expect(first('| a | b |\n| --- | --- |\n| 1 | 2 |')).toEqual({
      kind: 'table',
      header: [['a', 'b']],
      rows: [['1', '2']],
      aligns: ['left', 'left'],
    })
  })

  it('居中与右对齐', () => {
    expect(first('| a | b | c |\n|:--:|--:|:--|\n| 1 | 2 | 3 |')).toEqual({
      kind: 'table',
      header: [['a', 'b', 'c']],
      rows: [['1', '2', '3']],
      aligns: ['center', 'right', 'left'],
    })
  })

  it('单元格降级成纯文本：样式被拍平、链接只留文字', () => {
    // 卡片上的表格本来就窄，每格再逐格排版内联样式收益极小；
    // 真正要算的是"整表宽度预算"（列宽怎么分、每格折几行）—— 这条取舍写在类型的字段形状里
    expect(first('| **粗** | [链接](x.md) |\n| --- | --- |\n| `code` | 普通 |')).toEqual({
      kind: 'table',
      header: [['粗', '链接']],
      rows: [['code', '普通']],
      aligns: ['left', 'left'],
    })
  })

  it('单元格里的 wikilink 也只剩下显示文本', () => {
    // ⚠️ 表格里不能写 `[[目标|别名]]`：那个 `|` 在 GFM 表格里是**单元格分隔符**，
    // 会先把这一格切成两格（要写字面竖线得写 `\|`），所以这里用没有别名的形式
    expect(first('| a |\n| --- |\n| [[目标]] |')).toEqual({
      kind: 'table',
      header: [['a']],
      rows: [['目标']],
      aligns: ['left'],
    })
  })

  it('多行表格 + 表格后面的段落照常接上', () => {
    expect(toDrawBlocks('| a |\n| --- |\n| 1 |\n| 2 |\n\n结尾')).toEqual([
      { kind: 'table', header: [['a']], rows: [['1'], ['2']], aligns: ['left'] },
      { kind: 'paragraph', runs: [{ text: '结尾' }] },
    ])
  })
})

describe('提示框（`> [!note] 标题`）', () => {
  /** 取第一个块并要求它是提示框（写出来比到处 `if` 短，失败信息也更清楚）。 */
  function calloutOf(markdown: string): CalloutBlock {
    const block = first(markdown)
    if (block.kind !== 'callout') throw new Error(`期望提示框块，实际是 ${block.kind}`)
    return block
  }

  it('已知类型：字形与颜色令牌都来自唯一那份类型表', () => {
    // 观感对齐 app.css 的 `.mn-callout--tip` / `CALLOUT_TYPES.tip`：
    // 画布不另立一套类型名或颜色，`accent` 就是那条 CSS 规则里的令牌名
    expect(calloutOf('> [!tip] 提示语')).toEqual({
      kind: 'callout',
      type: 'tip',
      known: true,
      glyph: '★',
      accent: '--mn-callout-tip',
      title: '提示语',
      fold: null,
      depth: 0,
      children: [],
    })
  })

  it('别名与大小写都规范化到同一个类型（判据只有 parseCallout 那一份）', () => {
    expect(calloutOf('> [!HINT] x')).toMatchObject({ type: 'tip', accent: '--mn-callout-tip' })
    expect(calloutOf('> [!Danger] x')).toMatchObject({ type: 'danger' })
    expect(calloutOf('> [!tldr] x')).toMatchObject({ type: 'abstract', glyph: '≡' })
  })

  it('正文进 children：同段里的换行也算正文（Obsidian 的写法）', () => {
    // `> [!tip] 标题` 与 `> 正文` 之间只有软换行时，CommonMark 认为它们是**同一个段落**，
    // 核心规则因此把正文切出来重排成一段 —— 画布这边看到的就是"标题 + 一个段落子块"
    expect(calloutOf('> [!tip] 提示语\n> 正文文字').children).toEqual([
      { kind: 'paragraph', runs: [{ text: '正文文字' }] },
    ])
  })

  it('正文多段各自成块（空行分隔）', () => {
    expect(calloutOf('> [!note] 标题\n>\n> 第一段\n>\n> 第二段').children).toEqual([
      { kind: 'paragraph', runs: [{ text: '第一段' }] },
      { kind: 'paragraph', runs: [{ text: '第二段' }] },
    ])
  })

  it('正文里的列表 / 代码块走既有块种类（不另开一套）', () => {
    expect(calloutOf('> [!note] 标题\n> - a\n> - b').children).toEqual([
      item({ runs: [{ text: 'a' }] }),
      item({ runs: [{ text: 'b' }] }),
    ])
    expect(calloutOf('> [!note] 标题\n> ```ts\n> x = 1\n> ```').children).toEqual([
      { kind: 'code', language: 'ts', lines: ['x = 1'] },
    ])
  })

  it('正文里的行内样式与 wikilink 照常保留', () => {
    expect(calloutOf('> [!tip] t\n> 见 **粗体** 与 [[另一篇]]').children).toEqual([
      {
        kind: 'paragraph',
        runs: [
          { text: '见 ' },
          { text: '粗体', bold: true },
          { text: ' 与 ' },
          { text: '另一篇', wikilink: true, link: true, href: '另一篇' },
        ],
      },
    ])
  })

  it('无标题时标题退化成类型标签', () => {
    expect(calloutOf('> [!tip]')).toMatchObject({ title: '提示', glyph: '★' })
    expect(calloutOf('> [!danger]')).toMatchObject({ title: '危险' })
    expect(calloutOf('> [!note]')).toMatchObject({ title: '笔记' })
  })

  it('未知类型仍然渲染，颜色/字形退化到 note，标题保留用户写的名字', () => {
    // 未知类型**不当错误**（与 callouts.ts 的口径一致）：颜色/字形退化到 `note`，
    // 但标题必须是用户写的那个词 —— 那正是阅读视图里看到的东西
    // （`calloutTitle` 在"标题为空"时对未知类型返回的是**原始类型名**）
    expect(calloutOf('> [!摘录]')).toMatchObject({
      type: 'note',
      // `known: false` 来自核心规则补的 `mn-callout--unknown` 类名 —— 没有那个痕迹时
      // `[!摘录]` 与 `[!note]` 在 token 里逐字相同，"未知类型"就不可判定了
      known: false,
      glyph: '✎',
      accent: '--mn-callout-note',
      title: '摘录',
    })
    expect(calloutOf('> [!摘录] 一段说明')).toMatchObject({
      type: 'note',
      known: false,
      glyph: '✎',
      accent: '--mn-callout-note',
      title: '一段说明',
    })
    // 认识的类型不带那个痕迹
    expect(calloutOf('> [!note] 我的笔记')).toMatchObject({ known: true, title: '我的笔记' })
  })

  it('折叠角标（`-` / `+`）读得出来，没写是 null', () => {
    expect(calloutOf('> [!note]- 标题')).toMatchObject({ fold: '-' })
    expect(calloutOf('> [!note]+ 标题')).toMatchObject({ fold: '+' })
    expect(calloutOf('> [!note] 标题')).toMatchObject({ fold: null })
  })

  it('标题里的实体被反转义（核心规则写进标题栏时做过 escapeHtml）', () => {
    expect(calloutOf('> [!note] a & b <c>')).toMatchObject({ title: 'a & b <c>' })
  })

  it('提示框后面接的段落回到顶层（盒子只包自己的正文）', () => {
    expect(toDrawBlocks('> [!note] 标题\n> 正文\n\n后面的段落')).toEqual([
      {
        kind: 'callout',
        type: 'note',
        known: true,
        glyph: '✎',
        accent: '--mn-callout-note',
        title: '标题',
        fold: null,
        depth: 0,
        children: [{ kind: 'paragraph', runs: [{ text: '正文' }] }],
      },
      { kind: 'paragraph', runs: [{ text: '后面的段落' }] },
    ])
  })

  it('提示框里再套提示框：内层是外层的子块，深度 +1', () => {
    const outer = calloutOf('> [!note] 外层\n> > [!tip] 内层')
    expect(outer.depth).toBe(0)
    expect(outer.children).toHaveLength(1)
    const inner = outer.children[0]
    if (inner?.kind !== 'callout') throw new Error(`期望内层是提示框，实际是 ${inner?.kind}`)
    expect(inner.depth).toBe(1)
    expect(inner.title).toBe('内层')
    expect(inner.accent).toBe('--mn-callout-tip')
  })

  it('提示框套在**普通引用**里：深度按引用栈算（> > [!tip]）', () => {
    // 外层引用不是提示框（核心规则遇到嵌套引用就停手），所以块清单上只有一层提示框；
    // 但它是"第二层引用"，深度必须记下来，否则布局会让它贴到卡片左边
    expect(toDrawBlocks('> > [!tip] B')).toEqual([
      {
        kind: 'callout',
        type: 'tip',
        known: true,
        glyph: '★',
        accent: '--mn-callout-tip',
        title: 'B',
        fold: null,
        depth: 1,
        children: [],
      },
    ])
  })

  it('提示框正文里的引用仍然是引用（depth 从提示框内部重新起算）', () => {
    expect(calloutOf('> [!note] 标题\n> > 引文').children).toEqual([
      { kind: 'quote', depth: 0, runs: [{ text: '引文' }] },
    ])
  })

  it('提示框里塞满各种块也不抛，且全都进了 children（顺序不变）', () => {
    const source = [
      '> [!warning] 注意',
      '> 正文在标记行的下一行（同一个段落）',
      '>',
      '> - a',
      '> - [x] 完成',
      '>',
      '> ```ts',
      '> x = 1',
      '> ```',
      '>',
      '> | a | b |',
      '> | --- | --- |',
      '> | 1 | 2 |',
    ].join('\n')

    const block = calloutOf(source)
    expect(block.children.map((child) => child.kind)).toEqual([
      'paragraph',
      'list-item',
      'list-item',
      'code',
      'table',
    ])
    expect(block.accent).toBe('--mn-callout-warning')
    expect(block.children[2]).toMatchObject({ checked: true, runs: [{ text: '完成' }] })
  })

  it('普通引用**不**被当成提示框', () => {
    expect(toDrawBlocks('> 普通引用')).toEqual([
      { kind: 'quote', depth: 0, runs: [{ text: '普通引用' }] },
    ])
    // 句子中间出现 `[!note]` 不是标记（`parseCallout` 的判据是"引用块首行以它**开头**"）
    expect(toDrawBlocks('> 我觉得 [!note] 挺好')).toEqual([
      { kind: 'quote', depth: 0, runs: [{ text: '我觉得 [!note] 挺好' }] },
    ])
    // 标记必须出现在引用块的**第一段**：前面先写一段就不是提示框了
    // （与阅读视图同口径 —— 那边核心规则看的也是第一个段落）
    expect(toDrawBlocks('> 前言\n>\n> [!note] 标题')).toEqual([
      { kind: 'quote', depth: 0, runs: [{ text: '前言' }] },
      { kind: 'quote', depth: 0, runs: [{ text: '[!note] 标题' }] },
    ])
    // 半截的方括号不是标记
    expect(toDrawBlocks('> [!note 标题')).toEqual([
      { kind: 'quote', depth: 0, runs: [{ text: '[!note 标题' }] },
    ])
  })

  it('`![!x]` 这种"图片 + 方括号"不算提示框', () => {
    expect(toDrawBlocks('> ![!note]')).toEqual([
      { kind: 'quote', depth: 0, runs: [{ text: '![!note]' }] },
    ])
  })

  it('写在列表项里的提示框按顶层块画（盒子完整，项目符号不包住它）', () => {
    // 与"标题/代码块写在列表项里"同一条取舍：块清单里没有"列表项的子块"这种表达
    // （给每种块都加一个 depth 只为极罕见的写法，代价远大于收益）
    expect(toDrawBlocks('- > [!note] 标题').map((block) => block.kind)).toEqual(['callout'])
  })
})

describe('容错', () => {
  it('提示框正文一定不会丢（哪怕标题栏形状变了）', () => {
    // 这条只守一件事：画布上不能凭空少一段正文。提示框的**形状**由上面「提示框」那组用例钉住，
    // 这条留在容错里，是为了让"核心规则改了标题栏形状"时还有一条不依赖形状的底线
    const blocks = toDrawBlocks('> [!note] 提示标题\n> 正文文字')
    const calloutBlock = blocks[0]
    expect(calloutBlock?.kind).toBe('callout')
    const text =
      calloutBlock?.kind === 'callout'
        ? calloutBlock.children
            .map((child) =>
              child.kind === 'paragraph' ? child.runs.map((run) => run.text).join('') : '',
            )
            .join('')
        : ''
    expect(text).toContain('正文文字')
  })

  it('原始 HTML 被关掉（html: false）⇒ 变成文字，不会变成 HTML 块', () => {
    const runs = paragraphRuns('<div>原始 HTML</div>')
    expect(runs).toEqual([{ text: '<div>原始 HTML</div>' }])
  })

  it('半截 / 空的 wikilink 字面保留（规则不认就退回普通文字）', () => {
    expect(paragraphRuns('[[ ]] 与 [[abc')).toEqual([{ text: '[[ ]] 与 [[abc' }])
  })

  it('我们不认识的语法一律**不抛**，最多是少画一个块', () => {
    // 这些输入会走到 walkTokens 的 default 分支（或者被行内层跳过）。
    // 画布是只读预览：一篇笔记里出现一句插件语法，不该让整张卡片变成空白
    const weird = [
      '<div>原始 HTML</div>',
      'a \\* b &amp; c',
      '[[ ]] 与 [[abc',
      '```ts\n未闭合',
      '| a |\n| --- |\n| 1 | 2 |',
      '> - 引用里的列表\n>   1. 还是列表',
      '- # 列表里的标题',
      'term\n: 定义列表（我们没有这个语法）',
      '[^1]: 脚注（同上）\n\n正文[^1]',
      '$$数学公式$$',
      '###',
      '\u0000',
      '---',
      '- [ ]',
    ]

    for (const source of weird) {
      expect(Array.isArray(toDrawBlocks(source))).toBe(true)
    }
    // 顺手证明上面不是"永远返回空数组"：其中一条确实画出了文字
    expect(paragraphRuns('$$数学公式$$')).toEqual([{ text: '$$数学公式$$' }])
  })
})
