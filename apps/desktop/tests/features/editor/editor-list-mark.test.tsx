// @vitest-environment jsdom
/**
 * 列表标记的渲染（Live Preview）。
 *
 * ### 这个文件在钉什么
 * 用户报告"实时渲染中有序列表前面的符号都没有进行渲染"：当时的实现只是把源码里的 `-` / `1.`
 * 挂一个极淡的类名（"标记是结构、不是语法噪音"），于是看起来就是**没渲染**。
 * 现在的口径是**整段换成渲染出来的标记**（`ListMarkWidget`），这个文件把新口径逐条钉死：
 *
 * 1. 无序：`-` / `*` / `+` 都画成同一个项目符号，嵌套层级换字形（`•` / `◦` / `▪`）；
 * 2. 有序：序号按"**第一项写的数 + 第几项**"算，因此源码 `1. 1. 1.` 显示 `1. 2. 3.`，
 *    源码 `3.` 开头显示 `3. 4.`；序号栏在同一个列表里等宽（正文左边界齐平）；
 * 3. 光标在标记所在行 → 整行露原文（这是本层的通用手感，标记也要能改）；
 * 4. 任务项（`- [ ] x`）行为不变：仍是复选框 + 隐藏的 `- `，不画项目符号。
 *
 * ### 为什么断言讲"渲染出来的文本"而不是"挂了哪个类名"
 * 类名对了而字形是 `-`，正是这次要修的那个 bug。所以这里一律读 widget 真实产出的 DOM
 * （`toDOM().textContent`）：有序序号这种"文档里根本不存在的字符"只有这样才验得住。
 *
 * 另外一条：装饰只在**光标不在**该行时产出。绝大部分用例因此把光标放在别处（通常是文档末尾）。
 */

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, type Decoration } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'

import { createAssetResolver } from '@/domain/assets'
import { buildLivePreview, buildLivePreviewDecorations } from '@/features/editor/cm/live-preview/build'
import { MD, livePreviewThemeSpec } from '@/features/editor/cm/live-preview/theme'
import type { LivePreviewContext } from '@/features/editor/cm/live-preview/types'
import { ListMarkWidget } from '@/features/editor/cm/live-preview/widgets'
import { createEditorExtensions } from '@/features/editor/cm/setup'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

interface Deco {
  from: number
  to: number
  value: Decoration
}

/** 与编辑器**同一套** Markdown 语言扩展（树来自它；裸 state 里树是空的，装饰会全部落空）。 */
const LANGUAGE = markdown({ base: markdownLanguage })

function stateOf(doc: string, cursor?: number): EditorState {
  return EditorState.create({
    doc,
    selection: cursor === undefined ? undefined : { anchor: cursor },
    extensions: [LANGUAGE],
  })
}

function contextOf(): LivePreviewContext {
  return {
    noteRelPath: '笔记/测试.md',
    outbound: [],
    resolveAsset: createAssetResolver([]),
    resolveImage: () => ({ kind: 'placeholder' }),
  }
}

function decosOf(state: EditorState): Deco[] {
  // 语法树解析有时间预算：机器忙时 `syntaxTree(state)` 可能只解析了一部分，装饰就会少几条。
  // 真编辑器里视图会先把视口解析完再算装饰，这里显式把它逼到完整（与
  // `editor-live-preview.test.tsx` / `live-preview-table.test.tsx` 的 `decosOf` 同一套做法）。
  if (state.doc.length > 0) {
    let parsed = ensureSyntaxTree(state, state.doc.length, 10_000)
    for (let attempt = 0; parsed === null && attempt < 5; attempt += 1) {
      parsed = ensureSyntaxTree(state, state.doc.length, 10_000)
    }
    if (parsed === null) throw new Error('语法树在预算内没有解析完，本用例无法继续')
  }

  const set = buildLivePreviewDecorations(state, contextOf())
  const items: Deco[] = []
  set.between(0, state.doc.length, (from, to, value: Decoration) => {
    items.push({ from, to, value })
  })
  return items
}

/** 装饰携带的 widget（`Decoration#widget` 不是公开字段，只能从 `spec` 读）。 */
function widgetOf(item: Deco): unknown {
  return (item.value.spec as { widget?: unknown }).widget ?? null
}

/** 文档顺序的列表标记 widget（含它在文档里的位置）。 */
function listMarks(items: readonly Deco[]): Array<{ from: number; widget: ListMarkWidget }> {
  return items
    .filter((item) => widgetOf(item) instanceof ListMarkWidget)
    .map((item) => ({ from: item.from, widget: widgetOf(item) as ListMarkWidget }))
    .sort((a, b) => a.from - b.from)
}

/** 渲染出来的标记文本（`•` / `1.` …）：直接读 widget 产出的 DOM。 */
function markTexts(items: readonly Deco[]): string[] {
  return listMarks(items).map((entry) => entry.widget.toDOM().textContent ?? '')
}

/** 序号栏的宽度（`ch`；无序列表为空串）。 */
function markWidths(items: readonly Deco[]): string[] {
  return listMarks(items).map((entry) => entry.widget.toDOM().style.minWidth)
}

/** 隐藏装饰（替换原文、但没有 widget）：任务项的 `- ` 会出现在这里。 */
function hiddens(items: readonly Deco[]): Array<{ from: number; to: number }> {
  return items
    .filter((item) => item.value.point && item.from < item.to && widgetOf(item) === null)
    .map((item) => ({ from: item.from, to: item.to }))
}

/** 某个位置之后的第一次出现（写断言比硬编码偏移可读）。 */
function at(doc: string, needle: string, from = 0): number {
  const index = doc.indexOf(needle, from)
  if (index === -1) throw new Error(`文档里找不到 ${needle}`)
  return index
}

const views: EditorView[] = []

function mountEditor(doc: string, cursor?: number): EditorView {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: cursor === undefined ? undefined : { anchor: cursor },
      extensions: createEditorExtensions({}, true),
    }),
  })
  views.push(view)
  return view
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  document.body.innerHTML = ''
})

// ---------------------------------------------------------------------------
// 无序列表
// ---------------------------------------------------------------------------

describe('无序列表：标记渲染成项目符号', () => {
  it('`-` / `*` / `+` 三种写法渲染成同一个项目符号（不再是把符号本身染淡）', () => {
    const source = '- 甲\n* 乙\n+ 丙\n\n尾'
    const items = decosOf(stateOf(source, at(source, '尾')))

    expect(markTexts(items)).toEqual(['•', '•', '•'])
    // 原文的标记不再留在 DOM 里（这正是"没渲染"的观感来源）
    expect(hiddens(items)).toEqual([])
  })

  it('嵌套层级换字形：一层 `•`、二层 `◦`、三层及以上 `▪`', () => {
    const source = '- 一\n  - 二\n    - 三\n      - 四\n\n尾'
    const items = decosOf(stateOf(source, at(source, '尾')))

    expect(markTexts(items)).toEqual(['•', '◦', '▪', '▪'])
  })

  it('引用块里的列表仍然从第一层起算（引用有自己的竖线，不参与列表层级）', () => {
    const source = '> - 甲\n\n尾'
    expect(markTexts(decosOf(stateOf(source, at(source, '尾'))))).toEqual(['•'])
  })

  it('项目符号不设宽度栏（只有一个字形，正文左边界天然齐平）', () => {
    const source = '- 甲\n- 乙\n\n尾'
    expect(markWidths(decosOf(stateOf(source, at(source, '尾'))))).toEqual(['', ''])
  })
})

// ---------------------------------------------------------------------------
// 有序列表
// ---------------------------------------------------------------------------

describe('有序列表：序号按"第一项写的数 + 第几项"算', () => {
  it('源码写 `1. 1. 1.` → 显示 `1. 2. 3.`', () => {
    const source = '1. 甲\n1. 乙\n1. 丙\n\n尾'
    const items = decosOf(stateOf(source, at(source, '尾')))

    expect(markTexts(items)).toEqual(['1.', '2.', '3.'])
  })

  it('源码写 `3. 4.` → 显示 `3. 4.`（起始值由第一项决定）', () => {
    const source = '3. 甲\n4. 乙\n\n尾'
    expect(markTexts(decosOf(stateOf(source, at(source, '尾'))))).toEqual(['3.', '4.'])
  })

  it('后续项写的数不算数：`3. 9.` 仍然显示 `3. 4.`（与阅读视图的 `<ol start>` 递增一致）', () => {
    const source = '3. 甲\n9. 乙\n\n尾'
    expect(markTexts(decosOf(stateOf(source, at(source, '尾'))))).toEqual(['3.', '4.'])
  })

  it('有序嵌在无序里：内层是**另一个**列表，序号重新从 `1.` 起算', () => {
    const source = '3. 丙\n4. 丁\n\n- 一\n  1. 甲\n  1. 乙\n\n尾'
    const items = decosOf(stateOf(source, at(source, '尾')))

    // 文档顺序：第一个有序列表 `3. 4.` → 无序列表的项目符号 `•` → 嵌在它里面的有序列表 `1. 2.`
    expect(markTexts(items)).toEqual(['3.', '4.', '•', '1.', '2.'])
  })

  it('分隔符统一画 `.`：源码写 `1)` 也渲染成 `1.`（阅读视图里的 `<ol>` 同样是十进制点号）', () => {
    const source = '1) 甲\n1) 乙\n\n尾'
    expect(markTexts(decosOf(stateOf(source, at(source, '尾'))))).toEqual(['1.', '2.'])
  })

  it('起始值 `0.` 是合法的（CommonMark 允许从 0 起算），不会被当成"读不出数字"退回 1', () => {
    const source = '0. 甲\n0. 乙\n\n尾'
    expect(markTexts(decosOf(stateOf(source, at(source, '尾'))))).toEqual(['0.', '1.'])
  })
})

describe('有序列表：序号栏等宽（正文左边界齐平）', () => {
  it('同一个列表里所有项共用一条栏宽，宽度按最宽的那个序号算', () => {
    const lines = Array.from({ length: 10 }, (_, index) => `1. 第${index + 1}项`)
    const source = `${lines.join('\n')}\n\n尾`
    const widths = markWidths(decosOf(stateOf(source, at(source, '尾'))))

    // `1.` … `10.`：最宽是 3 个字符（两位数字 + 分隔符），于是**每一项**都用 3ch
    expect(widths).toEqual(Array.from({ length: 10 }, () => '3ch'))
  })

  it('只有一位数字的列表用 2ch（与源码原文等宽，观感上不额外缩进）', () => {
    const source = '1. 甲\n1. 乙\n\n尾'
    expect(markWidths(decosOf(stateOf(source, at(source, '尾'))))).toEqual(['2ch', '2ch'])
  })

  it('两个不同的列表各算各的栏宽（互不牵连）', () => {
    const lines = Array.from({ length: 10 }, (_, index) => `1. 第${index + 1}项`)
    // 中间必须夹一段正文：**空行并不会结束列表**（Markdown 的"松散列表"正是靠空行分项），
    // 那样两段编号会变成同一个列表的第 11、12 项（序号是 `11.` / `12.`，不是 `3.` / `4.`）
    const source = `${lines.join('\n')}\n\n中间一段\n\n3. 甲\n4. 乙\n\n尾`
    const items = decosOf(stateOf(source, at(source, '尾')))

    expect(markTexts(items)).toEqual([
      ...Array.from({ length: 10 }, (_, index) => `${index + 1}.`),
      '3.',
      '4.',
    ])
    expect(markWidths(items)).toEqual([
      ...Array.from({ length: 10 }, () => '3ch'),
      '2ch',
      '2ch',
    ])
  })
})

// ---------------------------------------------------------------------------
// 光标
// ---------------------------------------------------------------------------

describe('光标所在行露原文', () => {
  const source = '- 甲\n- 乙'

  it('光标在标记所在行：不产出 widget（整行原文露出来，标记才能改）', () => {
    const items = decosOf(stateOf(source, 1))

    // 第二行（光标不在）照常渲染；第一行整行露原文
    expect(markTexts(items)).toEqual(['•'])
    expect(listMarks(items)[0]?.from).toBe(at(source, '- 乙'))
  })

  it('光标在内容里也算"在这一行"（贴着标记编辑时不会看到自己的字符消失）', () => {
    expect(markTexts(decosOf(stateOf(source, at(source, '甲'))))).toEqual(['•'])
  })

  it('光标在别的行：两行都渲染', () => {
    const doc = `${source}\n\n尾`
    expect(markTexts(decosOf(stateOf(doc, at(doc, '尾'))))).toEqual(['•', '•'])
  })
})

// ---------------------------------------------------------------------------
// 任务项回归
// ---------------------------------------------------------------------------

describe('任务项行为不变（标记让给复选框）', () => {
  it('任务项仍然是复选框 + 隐藏的 `- `，不画项目符号', () => {
    const source = '- [ ] 未完成\n- 普通项\n\n尾'
    const items = decosOf(stateOf(source, at(source, '尾')))

    // 普通项是项目符号，任务项不是
    expect(markTexts(items)).toEqual(['•'])
    expect(listMarks(items)[0]?.from).toBe(at(source, '- 普通项'))
    // `- ` 被隐藏，让位给复选框
    expect(hiddens(items)).toEqual([{ from: at(source, '- [ ]'), to: at(source, '- [ ]') + 1 }])
    expect(widgetOf(items.find((item) => item.from === at(source, '[ ]')) as Deco)?.constructor.name)
      .toBe('TaskCheckboxWidget')
  })

  it('光标在该任务行：`- [ ]` 原样露出（不隐藏、也不画项目符号）', () => {
    const source = '- [ ] 未完成'
    const items = decosOf(stateOf(source, at(source, '未完成')))

    expect(markTexts(items)).toEqual([])
    expect(hiddens(items)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 原子区间与 eq（不改文档 + 不反复重建 DOM）
// ---------------------------------------------------------------------------

describe('原子区间与 widget 复用', () => {
  it('被替换的标记登记为原子区间（光标不会停在看不见的 `-` 中间）', () => {
    const source = '- 甲\n- 乙\n\n尾'
    const state = stateOf(source, source.length)
    const result = buildLivePreview(state, contextOf())
    const atoms: Array<{ from: number; to: number }> = []
    result.atomicRanges.between(0, state.doc.length, (from, to) => {
      atoms.push({ from, to })
    })

    expect(atoms).toEqual([
      { from: 0, to: 1 },
      { from: at(source, '- 乙'), to: at(source, '- 乙') + 1 },
    ])
    // 铁律：装饰层不改文档
    expect(state.doc.toString()).toBe(source)
  })

  it('`eq()` 只认"字形 + 栏宽"：内容一样就复用 DOM，栏宽变了才重建', () => {
    expect(new ListMarkWidget('•', null).eq(new ListMarkWidget('•', null))).toBe(true)
    expect(new ListMarkWidget('3.', 2).eq(new ListMarkWidget('3.', 2))).toBe(true)
    // 序号变了（上面插入/删掉了一项）→ 必须重建，否则显示的还是旧序号
    expect(new ListMarkWidget('1.', 2).eq(new ListMarkWidget('2.', 2))).toBe(false)
    // 列表里最宽的序号变了（`9.` → `10.`）→ 栏宽变化，也要重建，否则正文左边界会错开
    expect(new ListMarkWidget('1.', 2).eq(new ListMarkWidget('1.', 3))).toBe(false)
    // 项目符号与序号栏不能互相顶替
    expect(new ListMarkWidget('•', null).eq(new ListMarkWidget('•', 2))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 真实装配
// ---------------------------------------------------------------------------

describe('真实 EditorView：渲染出来的标记真的落到 DOM', () => {
  it('无序画项目符号、有序画算出来的序号，DOM 里不再有原文的 `-` / `1.`', () => {
    const source = '- 甲\n1. 乙\n1. 丙\n\n尾'
    const view = mountEditor(source, at(source, '尾'))
    const content = view.dom.querySelector('.cm-content')

    expect(content).not.toBeNull()
    const bullets = Array.from(view.dom.querySelectorAll(`.mn-md-list-mark.${MD.listBullet}`))
    expect(bullets.map((element) => element.textContent)).toEqual(['•'])

    const numbers = Array.from(view.dom.querySelectorAll(`.${MD.listNumber}`))
    expect(numbers.map((element) => element.textContent)).toEqual(['1.', '2.'])

    // 隐藏起来的只是语法标记：正文一个字都没少
    expect(content?.textContent ?? '').toContain('甲')
    expect(content?.textContent ?? '').toContain('丙')
    // 文档一个字节都没被改
    expect(view.state.doc.toString()).toBe(source)
  })

  it('光标进入列表行：widget 撤掉，整行 `- 甲` 原文回到 DOM（还能接着编辑）', () => {
    const source = '- 甲\n\n尾'
    const view = mountEditor(source, 1)

    expect(view.dom.querySelector(`.${MD.listMark}`)).toBeNull()
    expect(view.dom.querySelector('.cm-content')?.textContent ?? '').toContain('- 甲')
  })
})

// ---------------------------------------------------------------------------
// 样式契约（装饰类名 ↔ CSS 规则）
// ---------------------------------------------------------------------------

describe('样式契约', () => {
  it('标记颜色用看得见的 `--mn-fg-muted`（原先是几乎与背景同色的 `--mn-fg-subtle`）', () => {
    expect(livePreviewThemeSpec[`.${MD.listMark}`]?.color).toBe('var(--mn-fg-muted)')
  })

  it('序号栏右对齐 + 等宽数字 + 内联块：三者缺一，`9.` 与 `10.` 的正文左边界就会错开', () => {
    const rule = livePreviewThemeSpec[`.${MD.listNumber}`]
    expect(rule?.display).toBe('inline-block')
    expect(rule?.textAlign).toBe('right')
    expect(rule?.fontVariantNumeric).toBe('tabular-nums')
    expect(rule?.fontFamily).toBe('var(--mn-font-mono)')
  })

  it('项目符号不进选区（它在文档里没有对应文本，能选中只会让复制结果与看到的对不上）', () => {
    expect(livePreviewThemeSpec[`.${MD.listBullet}`]?.userSelect).toBe('none')
  })
})
