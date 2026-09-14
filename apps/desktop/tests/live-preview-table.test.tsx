// @vitest-environment jsdom
/**
 * Live Preview 里的 GFM 表格（`live-preview/table.ts` + `build.ts` 的 `emitTable` + `TableWidget`）。
 *
 * 分三层，与 `tests/editor-live-preview.test.tsx` 同一思路：
 * 1. **纯函数层**：一块源码能不能渲染、渲染成什么（对齐、缺列补齐/多列截断、转义竖线、图片占位、
 *    引用块与列表里的表格不渲染……）。这一层的判据**全部来自唯一那条渲染管线**
 *    （`domain/markdown.ts`），所以除了"该渲染 / 不该渲染"之外，断言一律写成"与 `renderMarkdown`
 *    的输出逐字相同" —— 证明编辑器与阅读视图不可能漂移，而不是复述一遍 markdown-it 的行为；
 * 2. **装饰层**：光标在外 → 一个 `TableWidget` + 源码行挂隐形类名；光标进入 → 一个装饰都不挂
 *    （整块露原文）。三条不变式：**不改 doc**、**不产出原子区间/替换**（源码文本留在 DOM 里）、
 *    视口外的表格不算；
 * 3. **装配层**：真的建 `EditorView`，验证 `<table>/<thead>/<tbody>/<th>/<td>` 落到 DOM、
 *    单元格里的链接贴上编辑器认的点击标记、图片的 click 让给灯箱。
 *
 * 最后一组是「格式化表格」的相互影响：格式化只改空白，**渲染结果必须逐字不变**，且撤销只有一步。
 */

import { undo } from '@codemirror/commands'
import { forceParsing, ensureSyntaxTree } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView, type Decoration } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createAssetResolver } from '@/domain/assets'
import { renderMarkdown } from '@/domain/markdown'
import { resetAssets } from '@/features/editor/cm/live-preview/assets'
import { buildLivePreview, buildLivePreviewDecorations } from '@/features/editor/cm/live-preview/build'
import {
  MAX_TABLE_LINES,
  isNestedTable,
  renderTableHtml,
  tableSourceWithinLimits,
} from '@/features/editor/cm/live-preview/table'
import { MD } from '@/features/editor/cm/live-preview/theme'
import type { LivePreviewContext } from '@/features/editor/cm/live-preview/types'
import { TableWidget } from '@/features/editor/cm/live-preview/widgets'
import { WIKI } from '@/features/editor/cm/wiki-complete/theme'
import { createEditorExtensions } from '@/features/editor/cm/setup'
import { formatTableCommand } from '@/features/editor/cm/table-format'
import { makeEntry, setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { useVaultStore } from '@/state/vault-store'

// ---------------------------------------------------------------------------
// 工具（与 `editor-live-preview.test.tsx` 同一套读装饰的方式）
// ---------------------------------------------------------------------------

interface Deco {
  from: number
  to: number
  value: Decoration
}

const LANGUAGE = markdown({ base: markdownLanguage })

function stateOf(doc: string, cursor?: number): EditorState {
  return EditorState.create({
    doc,
    selection: cursor === undefined ? undefined : { anchor: cursor },
    extensions: [LANGUAGE],
  })
}

function contextOf(overrides: Partial<LivePreviewContext> = {}): LivePreviewContext {
  return {
    noteRelPath: '笔记/测试.md',
    outbound: [],
    resolveAsset: createAssetResolver([]),
    resolveImage: () => ({ kind: 'placeholder' }),
    ...overrides,
  }
}

function decosOf(
  state: EditorState,
  context: LivePreviewContext = contextOf(),
  visible?: readonly { from: number; to: number }[],
): Deco[] {
  // 语法树解析有**时间预算**：机器忙（例如并行跑别的测试文件）时 `syntaxTree(state)` 可能只解析了
  // 一部分，表格节点根本还没进树 —— 那样用例的结果就取决于"这台机器当时有多忙"。
  // 这里先把它逼到完整；真实编辑器里视图本来就会把视口解析完再算装饰。
  //
  // 为什么要**循环**而不是调一次：`ensureSyntaxTree` 在预算内没解析完会返回 `null`，
  // 而它每次都从上一次的位置继续 —— 所以再喊几次就能推进（实测全量套件并行时有约 10% 的概率
  // 单次不够）。全都失败时必须**明确报错**：早先这里直接往下走，结果是
  // "Cannot read properties of undefined (reading 'value')" 这种看不懂的报错，
  // 排查的人会先去怀疑装饰逻辑，而真正的原因只是"树还没解析完"。
  if (state.doc.length > 0) {
    let parsed = ensureSyntaxTree(state, state.doc.length, 10_000)
    for (let attempt = 0; parsed === null && attempt < 5; attempt += 1) {
      parsed = ensureSyntaxTree(state, state.doc.length, 10_000)
    }
    if (parsed === null) throw new Error('语法树在预算内没有解析完，本用例无法继续')
  }
  const set = buildLivePreviewDecorations(state, context, visible)
  const items: Deco[] = []
  set.between(0, state.doc.length, (from, to, value: Decoration) => {
    items.push({ from, to, value })
  })
  return items
}

/** 装饰携带的 widget（`Decoration#widget` 不是公开字段，只能从 spec 里读）。 */
function widgetOf(item: Deco): unknown {
  return (item.value.spec as { widget?: unknown }).widget ?? null
}

/** 带 widget 的替换/插入装饰。 */
function widgets(items: readonly Deco[]): Deco[] {
  return items.filter((item) => widgetOf(item) !== null)
}

function marks(items: readonly Deco[]): Deco[] {
  return items.filter((item) => !item.value.point)
}

function classOf(item: Deco): string {
  return String((item.value.spec as { class?: string }).class ?? '')
}

/** 隐藏原文的替换装饰（表格刻意**不**产出它们，见文件头）。 */
function replaces(items: readonly Deco[]): Array<{ from: number; to: number }> {
  return items
    .filter((item) => item.value.point && item.from < item.to)
    .map((item) => ({ from: item.from, to: item.to }))
}

function tableWidgetOf(items: readonly Deco[]): TableWidget {
  const widget = widgetOf(widgets(items)[0] as Deco)
  if (!(widget instanceof TableWidget)) throw new Error('没有找到表格 widget')
  return widget
}

/** 表格 widget 渲染出来的 DOM（`toDOM` 不需要 view）。 */
function tableDom(widget: TableWidget): HTMLElement {
  return widget.toDOM()
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

/** 等一轮事件循环：图片授权是"IPC → 通知 → 重算"的异步链，微任务不够。 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  setIpcAdapter(createMockAdapter())
  resetAssets()
  useNoteStore.getState().close()
  useLinksStore.getState().clear()
  useVaultStore.setState({ status: 'idle', info: null, entries: [], tree: [], selected: null })
})

const placeholder = (): { kind: 'placeholder' } => ({ kind: 'placeholder' })

// ---------------------------------------------------------------------------
// 纯函数：一块源码渲染成什么
// ---------------------------------------------------------------------------

describe('表格渲染（复用唯一那条渲染管线）', () => {
  const basic = '| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |'

  it('表头进 thead、表体进 tbody，就是真表格', () => {
    const html = renderTableHtml(basic, placeholder)
    expect(html).not.toBeNull()
    expect(html).toContain('<table>')
    expect(html).toContain('<thead>')
    expect(html).toContain('<tbody>')
    expect(html).toContain('<th>甲</th>')
    expect(html).toContain('<td>1</td>')
  })

  it('与阅读视图**逐字相同**（同一个渲染入口，因此不可能漂移）', () => {
    const sources = [
      basic,
      '| a | b | c |\n| :--- | ---: | :---: |\n| 1 | 2 | 3 |',
      '| a | b |\n| --- | --- |\n| 1 |\n| 1 | 2 | 3 |',
      '| a | b |\n| --- | --- |\n|  | 2 |',
      '| a \\| b | c |\n| --- | --- |\n| x | y |',
      '| 名称 | desc |\n| --- | --- |\n| 中文与 English 混排 | 值 |',
    ]
    for (const source of sources) {
      expect(renderTableHtml(source, placeholder)).toBe(renderMarkdown(source).trim())
    }
  })

  it('分隔行的对齐标记决定对齐（`:---` / `:---:` / `---:`）', () => {
    const html = renderTableHtml('| a | b | c |\n| :--- | ---: | :---: |\n| 1 | 2 | 3 |', placeholder)
    expect(html).toContain('<th style="text-align:left">a</th>')
    expect(html).toContain('<th style="text-align:right">b</th>')
    expect(html).toContain('<th style="text-align:center">c</th>')
    expect(html).toContain('<td style="text-align:right">2</td>')
  })

  it('缺列的行补空单元格、多列的行截断（GFM 口径）', () => {
    const html = renderTableHtml('| a | b |\n| --- | --- |\n| 1 |\n| 1 | 2 | 3 |', placeholder)
    expect(html).not.toBeNull()
    const dom = document.createElement('div')
    dom.innerHTML = html ?? ''
    const rows = Array.from(dom.querySelectorAll('tr')).map((row) =>
      Array.from(row.querySelectorAll('th, td')).map((cell) => cell.textContent),
    )
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', ''],
      ['1', '2'],
    ])
  })

  it('空单元格渲染成空 td（不是缺一格）', () => {
    const html = renderTableHtml('| a | b |\n| --- | --- |\n|  | 2 |', placeholder)
    expect(html).toContain('<td></td>')
  })

  it('转义竖线属于内容，不算分隔符', () => {
    const html = renderTableHtml('| a \\| b | c |\n| --- | --- |\n| x | y |', placeholder)
    expect(html).toContain('<th>a | b</th>')
    expect(html).toContain('<th>c</th>')
  })

  it('代码跨度里的 `|` 与阅读视图一样：转义了才是内容', () => {
    const escaped = renderTableHtml('| a | c |\n| --- | --- |\n| `x\\|y` | z |', placeholder)
    expect(escaped).toContain('<code>x|y</code>')
    // 没转义就按 GFM 拆列（阅读视图也是这么拆的）—— 这条钉的是"两个视图同一口径"，
    // 不是"我们比 GFM 更聪明"
    const split = renderTableHtml('| a | c |\n| --- | --- |\n| `x|y` | z |', placeholder)
    expect(split).toBe(renderMarkdown('| a | c |\n| --- | --- |\n| `x|y` | z |').trim())
  })

  it('CJK 与西文混排不做任何特殊处理（列宽交给浏览器）', () => {
    const html = renderTableHtml('| 名称 | desc |\n| --- | --- |\n| 中文与 English 混排 | 值 |', placeholder)
    expect(html).toContain('<td>中文与 English 混排</td>')
    expect(html).toContain('<td>值</td>')
  })

  it('HTML 注入被同一条管线挡住（不引入第二个净化器）', () => {
    const html = renderTableHtml(
      '| a | b |\n| --- | --- |\n| <img src=x onerror=alert(1)> | <script>alert(2)</script> |',
      placeholder,
    )
    // `html: false` + DOMPurify：标签只会变成**文本**，不是元素
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
  })

  it('单元格里的行内语法（粗体 / 斜体 / 删除线 / 行内代码 / 链接 / wikilink）', () => {
    const source =
      '| a | b |\n| --- | --- |\n| **粗** *斜* ~~删~~ `码` | [文字](https://e.com) [[设计]] |'
    const html = renderTableHtml(source, placeholder) ?? ''
    expect(html).toContain('<strong>粗</strong>')
    expect(html).toContain('<em>斜</em>')
    // markdown-it 的 `~~删除线~~` 渲染成 `<s>`（阅读视图也是它，这里不另立一套）
    expect(html).toContain('<s>删</s>')
    expect(html).toContain('<code>码</code>')
    expect(html).toContain('href="https://e.com"')
    expect(html).toContain('data-target="设计"')
    // 标记一个都不该漏到用户眼前
    expect(html).not.toContain('**')
    expect(html).not.toContain('[[')
  })

  it('单元格里的图片：授权到位渲染 `<img class="mn-image">`（灯箱认它），没到位退成占位', () => {
    const source = '| a | b |\n| --- | --- |\n| ![图](图.png) | 2 |'

    const ready = renderTableHtml(source, () => ({
      kind: 'ready' as const,
      url: 'asset://localhost/x.png',
    }))
    expect(ready).toContain('class="mn-image"')
    expect(ready).toContain('src="asset://localhost/x.png"')

    const pending = renderTableHtml(source, placeholder) ?? ''
    expect(pending).toContain('mn-image-placeholder')
    expect(pending).not.toContain('<img')
    // 编辑器**不**走预览层那条"等授权"分支（`data-mn-asset` 骨架）：编辑器有自己的
    // 逐文件授权链路，两边都做会让同一张图被请求两遍
    expect(pending).not.toContain('data-mn-asset')
  })

  describe('刻意不渲染的情况（原样显示，绝不自己猜一个表格出来）', () => {
    const cases: ReadonlyArray<{ label: string; source: string }> = [
      { label: '没有分隔行', source: '| a | b |\n| 1 | 2 |' },
      { label: '表头与分隔行列数不一致', source: '| a | b |\n| --- |' },
      {
        label: '分隔行里混了普通单元格',
        source: '| a | b |\n| --- | 乙 |\n| 1 | 2 |',
      },
      { label: '只有一行含竖线的普通文本', source: '甲 | 乙' },
      { label: '缩进 4 空格（那是缩进代码块）', source: '    | a | b |\n    | --- | --- |' },
      { label: '引用块里的表格', source: '> | a | b |\n> | --- | --- |\n> | 1 | 2 |' },
      { label: '列表项里的表格', source: '- | a | b |\n  | --- | --- |\n  | 1 | 2 |' },
      { label: '前面紧贴正文（同一段里，分隔行不在第二行）', source: '前面正文\n| a | b |\n| --- | --- |' },
    ]

    for (const { label, source } of cases) {
      it(label, () => {
        expect(renderTableHtml(source, placeholder)).toBeNull()
      })
    }

    it('缩进 3 空格以内仍然是表格（GFM 允许）', () => {
      expect(renderTableHtml('   | a | b |\n   | --- | --- |', placeholder)).toContain('<table>')
    })
  })

  it('表格后面紧贴正文：那一行按 GFM 补成表体的一行（与阅读视图一致）', () => {
    const source = '| a | b |\n| --- | --- |\n| 1 | 2 |\n紧跟正文'
    const html = renderTableHtml(source, placeholder)
    // 与阅读视图逐字相同 —— 两边都把它当成表格的最后一行，而不是"表格 + 段落"
    expect(html).toBe(renderMarkdown(source).trim())
    expect(html).toContain('<td>紧跟正文</td>')
  })

  it('规模上限：异常大的"表格"不渲染（否则每次按键都要跑一遍全文渲染）', () => {
    expect(tableSourceWithinLimits(MAX_TABLE_LINES, '| a |')).toBe(true)
    expect(tableSourceWithinLimits(MAX_TABLE_LINES + 1, '| a |')).toBe(false)
    expect(tableSourceWithinLimits(3, 'x'.repeat(20_001))).toBe(false)
  })

  it('isNestedTable：引用块 / 列表项里的表格要被认出来（任意深度）', () => {
    const document_ = { name: 'Document', parent: null }
    const blockquote = { name: 'Blockquote', parent: document_ }
    const bulletList = { name: 'BulletList', parent: document_ }
    const listItem = { name: 'ListItem', parent: bulletList }

    expect(isNestedTable({ name: 'Table', parent: document_ })).toBe(false)
    expect(isNestedTable({ name: 'Table', parent: blockquote })).toBe(true)
    expect(isNestedTable({ name: 'Table', parent: listItem })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 装饰：光标在外渲染、光标进入露原文
// ---------------------------------------------------------------------------

describe('表格的装饰', () => {
  const source = ['前文', '', '| 甲 | 乙 |', '| --- | --- |', '| 1 | 2 |', '', '后文'].join('\n')
  const tableFrom = source.indexOf('| 甲')
  const tableTo = source.indexOf('\n\n后文')

  it('光标在外：整块换成一个 TableWidget，源码行挂隐形类名，文档一个字节都不改', () => {
    const state = stateOf(source, 0)
    const items = decosOf(state)

    expect(widgets(items)).toHaveLength(1)
    expect(tableWidgetOf(items)).toBeInstanceOf(TableWidget)
    // widget 挂在块首（`from === to`：它是**插入**的，不替换任何文本）
    const widget = widgets(items)[0]
    expect({ from: widget?.from, to: widget?.to }).toEqual({ from: tableFrom, to: tableFrom })

    // 三行源码各挂一个"隐形"类名（源码仍在 DOM 里，只是不显示，见 table.css）
    const hiddenLines = marks(items).filter((item) => classOf(item) === MD.tableSource)
    expect(hiddenLines).toHaveLength(3)
    expect(hiddenLines.map((item) => [item.from, item.to])).toEqual([
      [tableFrom, source.indexOf('| 甲 | 乙 |') + '| 甲 | 乙 |'.length],
      [source.indexOf('| ---'), source.indexOf('| ---') + '| --- | --- |'.length],
      [source.indexOf('| 1 |'), source.indexOf('| 1 |') + '| 1 | 2 |'.length],
    ])

    // **没有替换装饰**：源码文本留在 DOM 里（表格是唯一一处这样做的语法，见 build.ts）
    expect(replaces(items)).toEqual([])
    expect(state.doc.toString()).toBe(source)
  })

  it('不产出任何原子区间（源码始终在 DOM 里，光标走进来就整块露原文）', () => {
    const state = stateOf(source, 0)
    const result = buildLivePreview(state, contextOf())
    const atoms: Array<{ from: number; to: number }> = []
    result.atomicRanges.between(0, state.doc.length, (from, to) => {
      atoms.push({ from, to })
    })
    expect(atoms).toEqual([])
  })

  it('光标在表格里：整块露原文（表格自己一个装饰都不挂）', () => {
    const state = stateOf(source, tableFrom + 3)
    const items = decosOf(state)
    expect(widgets(items)).toEqual([])
    expect(marks(items).filter((item) => classOf(item) === MD.tableSource)).toEqual([])
  })

  it('光标在块首 / 块尾的边界上也算"在里面"（不会出现看不见的光标位置）', () => {
    for (const cursor of [tableFrom, tableTo]) {
      const items = decosOf(stateOf(source, cursor))
      expect(widgets(items)).toEqual([])
    }
  })

  it('选区与整块相交（哪怕只是一部分）也露原文', () => {
    const state = EditorState.create({
      doc: source,
      selection: { anchor: tableFrom - 2, head: tableFrom + 2 },
      extensions: [LANGUAGE],
    })
    expect(widgets(decosOf(state))).toEqual([])
  })

  it('光标在表格上一行 / 下一行：照常渲染', () => {
    const above = decosOf(stateOf(source, source.indexOf('前文') + 1))
    const below = decosOf(stateOf(source, source.indexOf('后文') + 1))
    expect(widgets(above)).toHaveLength(1)
    expect(widgets(below)).toHaveLength(1)
  })

  it('整块接管：露原文时单元格里的行内语法也不再被行内层动过', () => {
    // 单元格里的 `**粗体**` 与 `[[链接]]`：整块露原文时应当看到**原样**的 Markdown
    const doc = ['| a | b |', '| --- | --- |', '| **粗** | [[设计]] |'].join('\n')
    const items = decosOf(stateOf(doc, 0))
    const classes = marks(items).map(classOf)
    expect(classes).not.toContain(MD.strong)
    expect(classes).not.toContain(MD.wikilink)
    // 也没有"隐藏标记"的替换：星号与双方括号都原样可见
    expect(replaces(items)).toEqual([])
  })

  it('整块在视口外：不产出任何装饰（不白算 DOM）', () => {
    const items = decosOf(stateOf(source, 0), contextOf(), [
      { from: source.indexOf('后文'), to: source.length },
    ])
    expect(widgets(items)).toEqual([])
    expect(marks(items).filter((item) => classOf(item) === MD.tableSource)).toEqual([])
  })

  it('引用块 / 列表里的表格：不装饰、不崩（原样显示）', () => {
    for (const doc of [
      '> | a | b |\n> | --- | --- |\n> | 1 | 2 |',
      '- | a | b |\n  | --- | --- |\n  | 1 | 2 |',
    ]) {
      const items = decosOf(stateOf(doc, 0))
      expect(widgets(items)).toEqual([])
      expect(marks(items).filter((item) => classOf(item) === MD.tableSource)).toEqual([])
    }
  })

  it('一张"巨大的表"不渲染（护栏，避免 O(全文) 的每次按键开销）', () => {
    const lines = ['| a | b |', '| --- | --- |']
    for (let index = 0; index < MAX_TABLE_LINES; index += 1) lines.push(`| ${index} | x |`)
    const doc = lines.join('\n')
    expect(widgets(decosOf(stateOf(doc, 0)))).toEqual([])
  })

  it('装饰随光标移出而回来（同一份文档、两次构建，只差光标）', () => {
    const inside = decosOf(stateOf(source, tableFrom + 3))
    const outside = decosOf(stateOf(source, 0))
    expect(widgets(inside)).toEqual([])
    expect(widgets(outside)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// widget：DOM 与点击行为
// ---------------------------------------------------------------------------

describe('TableWidget', () => {
  /**
   * 文档**必须**有一行表格之外的文字：判据是"选区是否与整块相交"，光标在 0 就是表格的第一行，
   * 那属于"光标进入"（会露原文，于是没有 widget 可看）。这不是取巧，是这条纪律的直接后果。
   */
  const source = '前言\n\n| a | b |\n| --- | --- |\n| [文字](https://e.com) | 2 |'

  function widgetFor(context: LivePreviewContext = contextOf()): TableWidget {
    return tableWidgetOf(decosOf(stateOf(source, 0), context))
  }

  it('渲染出 table / thead / tbody / th / td 的层级', () => {
    const dom = tableDom(widgetFor())
    const table = dom.querySelector('table')
    expect(table).not.toBeNull()
    expect(table?.querySelector('thead th')?.textContent).toBe('a')
    expect(table?.querySelector('tbody td')?.textContent).toBe('文字')
    expect(dom.className).toBe(MD.table)
    expect(dom.querySelector(`.${MD.tableScroll}`)).not.toBeNull()
  })

  it('单元格里的链接贴上编辑器认的点击标记', () => {
    const dom = tableDom(widgetFor())
    const anchor = dom.querySelector('a')
    expect(anchor?.getAttribute('data-mn-link')).toBe('https://e.com')
    // 外链仍然带着预览那条管线的 target/rel（点它走的是"外部链接未在应用内打开"的提示）
    expect(anchor?.getAttribute('target')).toBe('_blank')
  })

  it('行内代码复用 `.mn-md-code` 的样式类（样式只定义一次）', () => {
    const doc = '前言\n\n| a |\n| --- |\n| `码` |'
    const dom = tableDom(tableWidgetOf(decosOf(stateOf(doc, 0))))
    expect(dom.querySelector('code')?.classList.contains(MD.code)).toBe(true)
  })

  it('wikilink：贴上目标与解析结果（悬空的标出 unresolved，解析到的标出相对路径）', () => {
    const doc = '前言\n\n| a | b |\n| --- | --- |\n| [[设计]] | [[不存在]] |'
    const context = contextOf({
      outbound: [
        {
          kind: 'wiki',
          rawTarget: '设计',
          display: '设计',
          alias: null,
          anchor: null,
          line: 3,
          resolvedRelPath: '项目/设计.md',
          ambiguous: false,
        },
      ],
    })
    const dom = tableDom(tableWidgetOf(decosOf(stateOf(doc, 0), context)))
    const links = Array.from(dom.querySelectorAll('a.mn-wikilink'))
    expect(links).toHaveLength(2)
    const resolved = links.find((link) => link.getAttribute('data-target') === '设计')
    expect(resolved?.getAttribute('data-mn-wikilink')).toBe('设计')
    expect(resolved?.getAttribute('data-mn-resolved')).toBe('项目/设计.md')
    const dangling = links.find((link) => link.getAttribute('data-target') === '不存在')
    // 少了这个标记，"索引还没回来"时点一个已存在的链接会被当成悬空链接去建笔记
    expect(dangling?.getAttribute('data-mn-resolved')).toBe('')
    expect(dangling?.classList.contains(MD.wikilinkUnresolved)).toBe(true)
  })

  it('`eq`：源码、图片授权状态、链接解析结果任一变化都要重建 DOM', () => {
    // 重算后源码没变 → 同一个 widget（HTML 与链接结果都一样）→ 复用旧 DOM，不重建
    expect(widgetFor().eq(widgetFor())).toBe(true)
    expect(
      widgetFor().eq(new TableWidget('<table><tbody><tr><td>别的</td></tr></tbody></table>', [])),
    ).toBe(false)

    // 图片授权回来的那一刻：HTML 从占位变成真图 → `eq` 为 false → 重建
    const doc = '前言\n\n| a |\n| --- |\n| ![图](图.png) |'
    const pending = tableWidgetOf(decosOf(stateOf(doc, 0)))
    const granted = tableWidgetOf(
      decosOf(
        stateOf(doc, 0),
        contextOf({ resolveImage: () => ({ kind: 'ready', url: 'asset://localhost/x.png' }) }),
      ),
    )
    expect(pending.eq(granted)).toBe(false)

    // 链接索引回来的那一刻：HTML 一样，但解析结果变了 → 也要重建（否则点击会用过期的解析结果）
    const withLink = (resolvedRelPath: string | null): TableWidget =>
      new TableWidget('<table></table>', [{ target: '设计', resolvedRelPath, ambiguous: false }])
    expect(withLink(null).eq(withLink('项目/设计.md'))).toBe(false)
    expect(withLink('项目/设计.md').eq(withLink('项目/设计.md'))).toBe(true)
  })

  it('图片上的事件让给灯箱，其它事件交给编辑器（点表格 = 把光标放进源码里）', () => {
    const widget = tableWidgetOf(
      decosOf(
        stateOf('前言\n\n| a |\n| --- |\n| ![图](图.png) |', 0),
        contextOf({
          resolveImage: () => ({ kind: 'ready', url: 'asset://localhost/x.png' }),
        }),
      ),
    )
    const dom = tableDom(widget)
    const image = dom.querySelector('img')
    const cell = dom.querySelector('td')

    const eventOn = (target: Element): MouseEvent => {
      const event = new MouseEvent('mousedown', { bubbles: true })
      target.dispatchEvent(event)
      return event
    }

    expect(image).not.toBeNull()
    expect(widget.ignoreEvent(eventOn(image as Element))).toBe(true)
    expect(widget.ignoreEvent(eventOn(cell as Element))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 装配：真的落到编辑器 DOM 里
// ---------------------------------------------------------------------------

describe('装配到编辑器', () => {
  it('渲染成真表格，且**源码仍然留在 DOM 里**（编辑器 DOM 文本 == 文档源码）', () => {
    const doc = ['# 标题', '', '| 甲 | 乙 |', '| --- | --- |', '| 1 | 2 |'].join('\n')
    const view = mountEditor(doc, 0)
    const content = view.dom.querySelector('.cm-content')

    expect(content?.querySelector(`.${MD.table} table`)).not.toBeNull()
    expect(content?.querySelectorAll('th')).toHaveLength(2)
    expect(content?.querySelectorAll('td')).toHaveLength(2)
    // DOM 文本里仍有原始 Markdown（`display: none` 只是不显示）—— 浏览器的查找、
    // 屏幕阅读器、以及"从 DOM 里读表格"的既有用法都不会因为表格被渲染了而失效
    expect(content?.textContent ?? '').toContain('| 甲 | 乙 |')
    expect(view.state.doc.toString()).toBe(doc)
  })

  it('光标进到表格里：widget 消失、原文照常显示（同一个 ViewPlugin 重算，不重建编辑器）', () => {
    const doc = ['# 标题', '', '| 甲 | 乙 |', '| --- | --- |', '| 1 | 2 |'].join('\n')
    const view = mountEditor(doc, 0)
    expect(view.dom.querySelector(`.${MD.table} table`)).not.toBeNull()

    view.dispatch({ selection: { anchor: doc.indexOf('甲') } })

    expect(view.dom.querySelector(`.${MD.table} table`)).toBeNull()
    expect(view.dom.querySelector(`.${MD.tableSource}`)).toBeNull()
    expect(view.state.doc.toString()).toBe(doc)
  })

  it('表格行里的 `[[` 补全照常弹（弹层与表格装饰互不干扰）', () => {
    // 候选来自 vault-store 的条目表（补全索引按数组身份缓存，这里给一张最小的表）
    useNoteStore.setState({
      doc: {
        relPath: '项目/设计.md',
        text: '',
        format: { bom: false, eol: '\n' },
        baseMtimeMs: 0,
        sizeBytes: 0,
        revision: 1,
        openedAt: 0,
      },
    })
    useVaultStore.setState({
      entries: [makeEntry({ relPath: '项目/设计.md' }), makeEntry({ relPath: '日记/设计.md' })],
    })

    const doc = '| 名称 | 备注 |\n| --- | --- |\n| 甲 | '
    const view = mountEditor(doc, doc.length)
    // 光标在表格里 → 整块露原文（没有 widget）。弹层贴着的正是这段可见的文本，
    // 这也是"弹层与表格装饰天然互斥"的原因（见 wiki-complete/plugin.ts 的模块文档）
    expect(view.dom.querySelector(`.${MD.table} table`)).toBeNull()

    for (const char of '[[设') {
      const range = view.state.selection.main
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: char },
        selection: { anchor: range.from + 1 },
        userEvent: 'input.type',
      })
    }

    const panel = view.dom.querySelector(`.${WIKI.panel}`)
    expect(panel).not.toBeNull()
    expect(panel?.textContent ?? '').toContain('设计')
    // 文档还是原样的 Markdown（补全没有偷偷写进去什么）
    expect(view.state.doc.toString()).toBe(`${doc}[[设`)
  })

  it('表格里的图片加载失败也降级成占位（不留裂图）', async () => {
    // 走完整的授权链路：stub 出 Tauri 运行时 → 插件在算完装饰后批量登记 → Mock 适配器授权
    ;(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {
      convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
    }
    try {
      useNoteStore.setState({
        doc: {
          relPath: '笔记/测试.md',
          text: '',
          format: { bom: false, eol: '\n' },
          baseMtimeMs: 0,
          sizeBytes: 0,
          revision: 1,
          openedAt: 0,
        },
      })
      useVaultStore.setState({
        info: {
          rootPath: 'C:\\Vault',
          name: 'Vault',
          entryCount: 0,
          noteCount: 0,
          folderCount: 0,
          truncated: false,
          skipped: 0,
          scanMs: 0,
        },
      })

      const doc = '前言\n\n| a |\n| --- |\n| ![图](附件/图.png) |'
      const view = mountEditor(doc, 0)
      await settle()

      const image = view.dom.querySelector<HTMLImageElement>(`.${MD.table} img.mn-image`)
      expect(image).not.toBeNull()

      // 模拟加载失败（作用域没覆盖到 / 文件被删）：插件必须让它降级成占位，而不是留个裂图
      image?.dispatchEvent(new Event('error'))
      await settle()

      expect(view.dom.querySelector(`.${MD.table} img.mn-image`)).toBeNull()
      expect(view.dom.querySelector(`.${MD.table} .mn-image-placeholder`)).not.toBeNull()
      // 文档始终没被碰过
      expect(view.state.doc.toString()).toBe(doc)
    } finally {
      delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__']
    }
  })
})

// ---------------------------------------------------------------------------
// 与「格式化表格」的相互影响（要求 3）
// ---------------------------------------------------------------------------

describe('与「格式化表格」命令共存', () => {
  // 前面那行正文同时是"光标在表格外"的落脚点（光标在 0 就落在表格里，会露原文）
  const source = ['前言', '', '| 名称 | 说明 |', '| --- | --- |', '| 甲 | short |'].join('\n')

  function mount(): EditorView {
    return mountEditor(source, 0)
  }

  it('格式化只改空白：渲染结果逐字不变，且撤销只有一步', () => {
    const view = mount()
    const before = tableWidgetOf(
      decosOf(view.state, contextOf(), [{ from: 0, to: view.state.doc.length }]),
    ).toDOM().innerHTML

    // 光标进表格 → 露原文（用户看得见他正在格式化的东西）
    view.dispatch({ selection: { anchor: source.indexOf('甲') } })
    expect(formatTableCommand(view)).toBe(true)

    // 源文本真的被对齐了（分隔行按列宽重建，只改空白）
    const lines = view.state.doc.toString().split('\n')
    expect(lines).toEqual([
      '前言',
      '',
      '| 名称 | 说明  |',
      '| ---- | ----- |',
      '| 甲   | short |',
    ])

    // 光标移出 → 渲染结果与格式化前**逐字相同**（只是源文本对齐了）
    view.dispatch({ selection: { anchor: 0 } })
    const after = tableWidgetOf(
      decosOf(view.state, contextOf(), [{ from: 0, to: view.state.doc.length }]),
    ).toDOM().innerHTML
    expect(after).toBe(before)

    // 一次撤销回到原文（表格装饰从不写文档，因此不会产生额外的撤销步骤）
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(source)
    expect(undo(view)).toBe(false)
  })

  it('表格的装饰本身不产生撤销步骤（只是选区移动也一样）', () => {
    const view = mount()
    // 光标来回进出表格：只改选区 + 重算装饰
    view.dispatch({ selection: { anchor: source.indexOf('甲') } })
    view.dispatch({ selection: { anchor: 0 } })
    view.dispatch({ selection: { anchor: source.length } })
    expect(undo(view)).toBe(false)
    expect(view.state.doc.toString()).toBe(source)
  })
})

// ---------------------------------------------------------------------------
// 性能：只算视口内的表格
// ---------------------------------------------------------------------------

describe('对视口的代价', () => {
  /**
   * 1 万行 / 200 张表：每张表 4 行 + 一行空行，表与表之间 44 行**纯文本**正文。
   *
   * 正文刻意不含行内标记：整篇文档的装饰代价里，只有"表格"这一项是我们这次要量的，
   * 八千多个 `**粗体**` 会把对照组的数字淹掉（那是既有行内装饰的开销，不是表格的）。
   *
   * 返回的 `cursorLine` 落在正文行上（不能是 0：0 就是第一张表的第一行，属于"光标进入"）。
   */
  function bigDocument(): { doc: string; tables: number[]; cursorLine: number } {
    const lines: string[] = []
    const tables: number[] = []
    for (let index = 0; index < 200; index += 1) {
      tables.push(lines.length)
      lines.push('| 列一 | 列二 |', '| --- | --- |', '| 甲 | 乙 |', '| 丙 | 丁 |', '')
      for (let filler = 0; filler < 44; filler += 1) {
        lines.push(`第 ${index} 段的第 ${filler} 行正文，用来把文档撑到一万行。`)
      }
      lines.push('')
    }
    return { doc: lines.join('\n'), tables, cursorLine: (tables[3] ?? 0) + 8 }
  }

  /**
   * 挂一篇大文档并把语法树**解析完**。
   *
   * 为什么必须解析完：装饰读的是 `syntaxTree(state)`，而大文档的语法树是增量解析的（编辑器里由
   * 视图驱动、按空闲时间推进）。不解析完，"第 101 张表"在树里根本还不存在，量到的会是空转。
   */
  function mountParsed(): { view: EditorView; tables: number[]; cursorLine: number } {
    const { doc, tables, cursorLine } = bigDocument()
    const view = mountEditor(doc, 0)
    let parsed = false
    for (let attempt = 0; attempt < 40 && !parsed; attempt += 1) {
      parsed = forceParsing(view, view.state.doc.length, 3_000)
    }
    expect(parsed).toBe(true)
    view.dispatch({ selection: { anchor: view.state.doc.line(cursorLine + 1).from } })
    return { view, tables, cursorLine }
  }

  it('视口只覆盖一张表时，只算那一张（不做全文扫描）', { timeout: 30_000 }, () => {
    const { view, tables } = mountParsed()
    expect(view.state.doc.lines).toBeGreaterThan(9_000)
    expect(tables).toHaveLength(200)

    const middle = tables[100] ?? 0
    const visible = [
      { from: view.state.doc.line(middle + 1).from, to: view.state.doc.line(middle + 4).to },
    ]
    // 视口里只有一张表 → 只产出那一个 widget（另外 199 张一个都不算，也不渲染它们的 DOM）
    expect(widgets(decosOf(view.state, contextOf(), visible))).toHaveLength(1)
    // 对照：不做视口裁剪时是全部 200 张 —— 这正是"只按视口算"这条纪律挡住的东西
    expect(widgets(decosOf(view.state, contextOf()))).toHaveLength(200)
  })

  /**
   * 这两条要**解析一万行**再反复量：单跑约 1~5 秒，但整套测试 50 多个文件并行时会被 CPU 挤到
   * 超过 vitest 默认的 5 秒上限（实测偶发 timeout 红灯）——所以显式放宽，别让它变成"看机器心情"的用例。
   */
  it('实测每次构建的耗时（视口内一张表 vs 整篇 200 张）', { timeout: 60_000 }, () => {
    const { view, tables } = mountParsed()
    const middle = tables[100] ?? 0
    const visible = [
      { from: view.state.doc.line(middle + 1).from, to: view.state.doc.line(middle + 20).to },
    ]

    const measure = (rounds: number, ranges?: readonly { from: number; to: number }[]): number => {
      const run = (): void => {
        buildLivePreviewDecorations(view.state, contextOf(), ranges)
      }
      run()
      let min = Number.POSITIVE_INFINITY
      for (let round = 0; round < rounds; round += 1) {
        const started = performance.now()
        run()
        const elapsed = performance.now() - started
        if (elapsed < min) min = elapsed
      }
      return min
    }

    const viewportMin = measure(20, visible)
    const wholeDocMin = measure(3)

    // 单张表的渲染成本（markdown-it + DOMPurify）：它决定"一屏里有几张表"就等于几次按键的额外代价
    const oneTable = '| 列一 | 列二 |\n| --- | --- |\n| 甲 | 乙 |\n| 丙 | 丁 |'
    renderTableHtml(oneTable, placeholder)
    let renderMin = Number.POSITIVE_INFINITY
    for (let round = 0; round < 50; round += 1) {
      const started = performance.now()
      renderTableHtml(oneTable, placeholder)
      const elapsed = performance.now() - started
      if (elapsed < renderMin) renderMin = elapsed
    }

    console.info(
      `[live-preview-table] 1 万行 / 200 张表：视口内一张表 ${viewportMin.toFixed(2)}ms / ` +
        `整篇 200 张 ${wholeDocMin.toFixed(2)}ms / 单张表渲染 ${renderMin.toFixed(3)}ms`,
    )
    // 预算：一次按键 ≤ 一帧（16ms）。实测在 1~2ms（见上面打出的数字），这里给**很宽**的上界：
    // CI/并行跑测试时机器负载会把单次耗时抬高几倍，这条断言只用来抓"退化成 O(文档长度²)"
    // 这类数量级的问题（整篇 200 张那个数字就在 600ms 量级，真要退化会立刻撞线）
    expect(viewportMin).toBeLessThan(60)
    // 整篇那条路（编辑器不会走）刻意只做对照，不断言绝对数字
    expect(wholeDocMin).toBeGreaterThan(viewportMin)
  })
})
