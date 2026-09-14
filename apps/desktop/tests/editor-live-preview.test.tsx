// @vitest-environment jsdom
/**
 * Live Preview（所见即所得）装饰层测试。
 *
 * 分两层：
 * 1. **纯函数层**：`buildLivePreview(state, context)` 只吃 `EditorState`，所以光标位置、
 *    隐藏区间、样式类名都能直接断言 —— 这是本文件的主体（"光标在外隐藏 / 光标进入露出"
 *    这条核心手感必须逐条钉死）；
 * 2. **装配层**：真的建一个 `EditorView`，验证装饰落到 DOM、原子区间不炸、宿主索引回来后
 *    悬空链接的类名会跟着变（不需要重建编辑器）。
 *
 * 图片授权链路（asset 协议）在**数据层**验证：`assets.ts` 是模块级缓存 + 批量登记，
 * 用 Mock 适配器数 IPC 次数比在 jsdom 里模拟真实 WebView 稳得多。
 */

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, type Decoration } from '@codemirror/view'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createAssetResolver } from '@/domain/assets'
import {
  flushAssets,
  lookupAsset,
  markAssetFailed,
  resetAssets,
  stageAsset,
} from '@/features/editor/cm/live-preview/assets'
import {
  buildLivePreview,
  buildLivePreviewDecorations,
} from '@/features/editor/cm/live-preview/build'
import { toggleTaskChange } from '@/features/editor/cm/live-preview/task'
import { MD, livePreviewThemeSpec } from '@/features/editor/cm/live-preview/theme'
import type { LivePreviewContext } from '@/features/editor/cm/live-preview/types'
import { ImageWidget } from '@/features/editor/cm/live-preview/widgets'
import { createEditorExtensions } from '@/features/editor/cm/setup'
import { setIpcAdapter, makeEntry } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { useVaultStore } from '@/state/vault-store'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

interface Deco {
  from: number
  to: number
  value: Decoration
}

/**
 * 与编辑器**同一套** Markdown 语言扩展。
 *
 * 装饰全部来自 `syntaxTree(state)`，而语法树由语言扩展提供 —— 裸的
 * `EditorState.create({doc})` 里树是空的，装饰会全部落空（第一次写这个测试就踩了）。
 */
const LANGUAGE = markdown({ base: markdownLanguage })

function stateOf(doc: string, cursor?: number): EditorState {
  return EditorState.create({
    doc,
    selection: cursor === undefined ? undefined : { anchor: cursor },
    extensions: [LANGUAGE],
  })
}

function stateWithSelection(doc: string, anchor: number, head: number): EditorState {
  return EditorState.create({ doc, selection: { anchor, head }, extensions: [LANGUAGE] })
}

/** 等一轮事件循环：图片授权是"IPC → 通知 → 重算"的异步链，微任务不够。 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function contextOf(overrides: Partial<LivePreviewContext> = {}): LivePreviewContext {
  return {
    noteRelPath: '笔记/测试.md',
    outbound: [],
    // 带上**真实**的全库索引解析器（`domain/assets.ts`），默认条目表为空：
    // 于是"文件确实存在"这条规则不生效，正好覆盖"只有相对解析"的老路径
    resolveAsset: createAssetResolver([]),
    resolveImage: () => ({ kind: 'placeholder' }),
    ...overrides,
  }
}

/** 带条目表的上下文（测 Obsidian 口径的"裸文件名全库兜底"）。 */
function contextWithEntries(
  entries: readonly { relPath: string; isDir?: boolean }[],
  overrides: Partial<LivePreviewContext> = {},
): LivePreviewContext {
  return contextOf({
    resolveAsset: createAssetResolver(entries.map((entry) => ({ ...entry, isDir: entry.isDir ?? false }))),
    ...overrides,
  })
}

function decosOf(
  state: EditorState,
  context: LivePreviewContext = contextOf(),
  visible?: readonly { from: number; to: number }[],
): Deco[] {
  // 语法树解析有**时间预算**：机器忙（例如全量套件并行）时 `syntaxTree(state)` 可能只解析了一部分，
  // 装饰就会少几条 —— 于是用例的结果取决于"这台机器当时有多忙"。真实编辑器里视图会把视口解析完
  // 再算装饰，这里先把它逼到完整（`live-preview-table.test.tsx` 的 `decosOf` 是同一套做法）。
  // 单次预算内没解析完时 `ensureSyntaxTree` 返回 `null` 并**下次从断点继续**，所以循环推进；
  // 全都失败就明确报错，而不是让断言以"少了一条装饰"这种看不懂的形式失败。
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

/** 行装饰（`from === to` 的点装饰）。 */
function lines(items: readonly Deco[]): Deco[] {
  return items.filter((item) => item.value.point && item.from === item.to)
}

/**
 * 装饰携带的 widget。
 *
 * 只能用 `spec.widget` 读：`Decoration#widget` 在类型上是内部字段（`@codemirror/view` 不公开它）。
 */
function widgetOf(item: Deco): unknown {
  return (item.value.spec as { widget?: unknown }).widget ?? null
}

/** 隐藏装饰（替换原文、但没有 widget）。 */
function hiddens(items: readonly Deco[]): Array<{ from: number; to: number }> {
  return items
    .filter((item) => item.value.point && item.from < item.to && widgetOf(item) === null)
    .map((item) => ({ from: item.from, to: item.to }))
}

/** 带 widget 的替换装饰。 */
function widgets(items: readonly Deco[]): Deco[] {
  return items.filter((item) => item.value.point && item.from < item.to && widgetOf(item) !== null)
}

/** 某个替换装饰挂的 widget 类名（断言"换成了哪一个 widget"）。 */
function widgetName(item: Deco | undefined): string | undefined {
  if (item === undefined) return undefined
  const widget = widgetOf(item)
  return widget instanceof Object ? widget.constructor.name : undefined
}

/** 取第一个图片 widget（断言占位/真图两条分支时用）。 */
function imageWidget(items: readonly Deco[]): ImageWidget {
  const widget = widgetOf(widgets(items)[0] as Deco)
  if (!(widget instanceof ImageWidget)) throw new Error('没有找到图片 widget')
  return widget
}

/** 样式装饰（mark）。 */
function marks(items: readonly Deco[]): Deco[] {
  return items.filter((item) => !item.value.point)
}

function classOf(item: Deco): string {
  return String((item.value.spec as { class?: string }).class ?? '')
}

function lineAt(items: readonly Deco[], from: number): Deco | undefined {
  return lines(items).find((item) => item.from === from)
}

/** `needle` 在 `doc` 里的位置（用它写断言比硬编码偏移可读得多）。 */
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

let ipcCalls = 0
/** 记录 `asset_authorize` 请求过的路径（断言"请求的是解析后的 rel"）。 */
let assetRequests: string[][] = []

/**
 * jsdom 没有实现 `Range.getClientRects`，而 CodeMirror 画光标/选区时会调用它
 * （缺了就会走 `logException` 打一堆堆栈）。这里补一个空实现，纯粹是让测试输出干净。
 */
beforeAll(() => {
  const proto = Range.prototype as unknown as { getClientRects?: () => DOMRectList }
  if (typeof proto.getClientRects !== 'function') {
    proto.getClientRects = () => [] as unknown as DOMRectList
  }
})

beforeEach(() => {
  ipcCalls = 0
  assetRequests = []
  const adapter = createMockAdapter()
  setIpcAdapter({
    kind: 'test',
    invoke: async <T,>(method: string, args?: Record<string, unknown>): Promise<T> => {
      ipcCalls += 1
      if (method === 'asset_authorize') {
        const requested = args?.['relPaths']
        if (Array.isArray(requested)) assetRequests.push(requested.map((item) => String(item)))
      }
      return adapter.invoke<T>(method, args)
    },
  })
  resetAssets()
  useNoteStore.getState().close()
  useLinksStore.getState().clear()
  useVaultStore.setState({ info: null, status: 'idle' })
})

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  resetAssets()
  document.body.innerHTML = ''
})

/** 让编辑器认为"当前笔记是这一篇"（上下文里的 noteRelPath 来自 note-store）。 */
function pretendOpenNote(relPath: string): void {
  useNoteStore.setState({
    doc: {
      relPath,
      text: '',
      format: { bom: false, eol: '\n' },
      baseMtimeMs: 0,
      sizeBytes: 0,
      revision: 1,
      openedAt: 0,
    },
  })
}

// ---------------------------------------------------------------------------
// 行内：Live Preview 的核心手感
// ---------------------------------------------------------------------------

describe('行内标记：光标在外隐藏，光标进入露出', () => {
  const doc = '前 **粗体** 后' // `**` 在 2..4 与 6..8，内容 4..6

  it('光标在范围外：标记被隐藏，内容带粗体类名', () => {
    const state = stateOf(doc, 0)
    const items = decosOf(state)

    expect(hiddens(items)).toEqual([
      { from: 2, to: 4 },
      { from: 6, to: 8 },
    ])
    const strong = marks(items).find((item) => classOf(item) === MD.strong)
    expect(strong).toBeDefined()
    expect({ from: strong?.from, to: strong?.to }).toEqual({ from: 4, to: 6 })
  })

  it('光标进入范围：不再有隐藏装饰（原文整段露出）', () => {
    const items = decosOf(stateOf(doc, 4))
    expect(hiddens(items)).toEqual([])
    // 样式还在：只是标记露出来了，不是"退回纯文本"
    expect(marks(items).some((item) => classOf(item) === MD.strong)).toBe(true)
  })

  it('光标贴在边界上也算"在里面"（否则贴边输入会看不到自己敲的字符）', () => {
    expect(hiddens(decosOf(stateOf(doc, 2)))).toEqual([])
    expect(hiddens(decosOf(stateOf(doc, 8)))).toEqual([])
  })

  it('选区与范围相交就露出（全选时整篇露出原文）', () => {
    const state = stateWithSelection(doc, 0, doc.length)
    expect(hiddens(decosOf(state))).toEqual([])
  })

  it('斜体 / 删除线 / 行内代码各自隐藏自己的标记', () => {
    const source = '*斜* 与 ~~删~~ 与 `码` 尾'
    const items = decosOf(stateOf(source, at(source, '尾')))

    const classes = marks(items).map(classOf)
    expect(classes).toContain(MD.emphasis)
    expect(classes).toContain(MD.strike)
    expect(classes).toContain(MD.code)

    // 三组标记都被隐藏：`*`、`~~`×2、`` ` ``×2
    expect(hiddens(items)).toContainEqual({ from: at(source, '*'), to: at(source, '*') + 1 })
    expect(hiddens(items)).toContainEqual({ from: at(source, '~~'), to: at(source, '~~') + 2 })
    expect(hiddens(items)).toContainEqual({ from: at(source, '`'), to: at(source, '`') + 1 })
  })

  it('行内代码里的 [[链接]] 不被当成 wikilink（与预览面板同一口径）', () => {
    const source = '看 `[[不是链接]]` 与 [[是链接]]'
    const items = decosOf(stateOf(source, 0))
    const wiki = marks(items).filter((item) => classOf(item).includes(MD.wikilink))

    expect(wiki).toHaveLength(1)
    // 注意 `不可能` 里含有 `可能` 这类子串：这里从行内代码之后开始找，避免张冠李戴
    expect(wiki[0]?.from).toBe(at(source, '是链接', source.indexOf('`', 4)))
  })

  it('围栏代码块里的标记与链接都不处理', () => {
    const source = '```\n**不是粗体** [[不是链接]]\n```'
    expect(marks(decosOf(stateOf(source, 0)))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 块级
// ---------------------------------------------------------------------------

describe('块级：标题 / 引用 / 列表 / 分隔线 / 代码块', () => {
  it('标题：行装饰带级别类名，`#` 在光标不在该行时隐藏', () => {
    const source = '# 一级\n\n正文'
    const state = stateOf(source, at(source, '正文'))
    const items = decosOf(state)

    expect(classOf(lineAt(items, 0) as Deco)).toContain(MD.h1)
    expect(hiddens(items)).toEqual([{ from: 0, to: 1 }])
  })

  it('标题：光标在这一行时露出 `#`（但行装饰保留）', () => {
    const items = decosOf(stateOf('# 一级\n\n正文', 3))
    expect(hiddens(items)).toEqual([])
    expect(classOf(lineAt(items, 0) as Deco)).toContain(MD.h1)
  })

  it('二级标题用 h2 类名，收尾的 `##` 也一起隐藏', () => {
    const source = '## 二级 ##\n\n正文'
    const items = decosOf(stateOf(source, at(source, '正文')))
    const closing = at(source, '##', 2)
    expect(classOf(lineAt(items, 0) as Deco)).toContain(MD.h2)
    expect(hiddens(items)).toEqual([
      { from: 0, to: 2 },
      { from: closing, to: closing + 2 },
    ])
  })

  it('setext 标题：正文行是标题，下划线行整行收起', () => {
    const source = '标题二\n-------\n\n正文'
    const items = decosOf(stateOf(source, at(source, '正文')))
    expect(classOf(lineAt(items, 0) as Deco)).toContain(MD.h2)
    const underline = lineAt(items, at(source, '-------'))
    expect(classOf(underline as Deco)).toContain(MD.collapsedLine)
  })

  it('引用：行装饰带竖线类名，`>` 隐藏；嵌套引用多一级', () => {
    const source = '> 甲\n> > 乙\n\n正文'
    const items = decosOf(stateOf(source, at(source, '正文')))

    expect(classOf(lineAt(items, 0) as Deco)).toBe(MD.quote)
    expect(classOf(lineAt(items, at(source, '> >')) as Deco)).toContain(MD.quoteNested)
    // 三个 `>`：第一行 1 个，第二行外层 1 个 + 内层 1 个，全部隐藏
    expect(hiddens(items)).toEqual([
      { from: 0, to: 1 },
      { from: 4, to: 5 },
      { from: 6, to: 7 },
    ])
  })

  it('列表符号退让：保留 `-` 但挂淡色类名（不隐藏）', () => {
    const source = '- 甲\n- 乙'
    const items = decosOf(stateOf(source, 1))

    expect(hiddens(items)).toEqual([])
    expect(marks(items).filter((item) => classOf(item) === MD.listMark)).toHaveLength(2)
  })

  it('分隔线渲染成一条线：整段换成 widget', () => {
    const source = '---\n\n正文'
    const items = decosOf(stateOf(source, at(source, '正文')))

    const rule = widgets(items).find((item) => item.from === 0)
    expect(rule).toBeDefined()
    expect(rule?.to).toBe(3)
    expect(widgetName(rule)).toBe('HorizontalRuleWidget')
    expect(classOf(lineAt(items, 0) as Deco)).toContain(MD.hrLine)
  })

  it('分隔线：光标在这一行时露原文', () => {
    expect(widgets(decosOf(stateOf('---\n\n正文', 1)))).toEqual([])
  })

  it('围栏代码块：围栏行收起、正文行有等宽底色类名', () => {
    const source = ['```js', 'const a = 1;', '```', '', '正文'].join('\n')
    const items = decosOf(stateOf(source, at(source, '正文')))

    const fence = at(source, '```js')
    const body = at(source, 'const a = 1;')
    const closing = at(source, '```', fence + 1)

    expect(classOf(lineAt(items, fence) as Deco)).toContain(MD.collapsedLine)
    expect(classOf(lineAt(items, closing) as Deco)).toContain(MD.collapsedLine)
    expect(classOf(lineAt(items, body) as Deco)).toContain(MD.codeLine)
    expect(hiddens(items)).toEqual([
      { from: fence, to: fence + '```js'.length },
      { from: closing, to: closing + 3 },
    ])
  })

  it('围栏代码块：光标在围栏行时只露出那一行（另一行照旧收起）', () => {
    const source = ['```js', 'const a = 1;', '```'].join('\n')
    const items = decosOf(stateOf(source, 1))

    const opening = at(source, '```js')
    const closing = at(source, '```', opening + 1)
    expect(hiddens(items)).toEqual([{ from: closing, to: closing + 3 }])
    // 光标所在的那一行连"收起"的行装饰都不加（它现在是普通一行源码）
    expect(lineAt(items, opening)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 任务列表
// ---------------------------------------------------------------------------

describe('任务列表', () => {
  const source = '- 甲\n- [ ] 未完成\n- [x] 已完成'

  it('光标不在该行：`- [ ]` 换成可点击复选框', () => {
    const items = decosOf(stateOf(source, at(source, '甲')))
    const boxes = widgets(items)

    expect(boxes).toHaveLength(2)
    const open = boxes[0]
    expect(open?.from).toBe(at(source, '[ ]'))
    expect(widgetName(open)).toBe('TaskCheckboxWidget')
    // `- ` 让位给复选框
    expect(hiddens(items)).toContainEqual({
      from: at(source, '- [ ]'),
      to: at(source, '- [ ]') + 1,
    })
    // 已完成的那一行整行淡出
    expect(classOf(lineAt(items, at(source, '- [x]')) as Deco)).toContain(MD.taskDone)
  })

  it('光标在该行：保留 `- [ ]` 原文（可编辑）', () => {
    const items = decosOf(stateOf(source, at(source, '未完成')))
    expect(widgets(items)).toHaveLength(1) // 只剩"已完成"那一行的复选框
  })

  it('点击切换写回 `- [x]`（纯函数 + state.update）', () => {
    const state = stateOf(source, 0)
    const marker = at(source, '[ ]')

    const change = toggleTaskChange(state, marker)
    expect(change).not.toBeNull()
    const next = state.update({ changes: change as NonNullable<typeof change> }).state
    expect(next.doc.line(2).text).toBe('- [x] 未完成')

    // 再切回来
    const back = toggleTaskChange(next, at(next.doc.toString(), '[x] 未完成'))
    expect(back).not.toBeNull()
    expect(
      next.update({ changes: back as NonNullable<typeof back> }).state.doc.line(2).text,
    ).toBe('- [ ] 未完成')
  })

  it('不是任务标记的位置不产生任何变更（绝不误改别处）', () => {
    const state = stateOf('普通一段文字', 0)
    expect(toggleTaskChange(state, 0)).toBeNull()
    expect(toggleTaskChange(state, 999)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 链接
// ---------------------------------------------------------------------------

describe('链接', () => {
  it('`[文字](地址)`：外侧只显示文字，`[` 与 `](地址)` 隐藏', () => {
    const source = '看 [设计文档](项目/设计.md) 收'
    const items = decosOf(stateOf(source, 0))
    const open = at(source, '[设计文档]')
    const text = at(source, '设计文档')

    expect(hiddens(items)).toEqual([
      { from: open, to: open + 1 },
      { from: text + '设计文档'.length, to: open + '[设计文档](项目/设计.md)'.length },
    ])
    const link = marks(items).find((item) => classOf(item) === MD.link)
    expect({ from: link?.from, to: link?.to }).toEqual({
      from: text,
      to: text + '设计文档'.length,
    })
  })

  it('`[文字](地址)`：光标进入时露出完整语法', () => {
    const source = '看 [设计文档](项目/设计.md) 收'
    expect(hiddens(decosOf(stateOf(source, at(source, '设计文档'))))).toEqual([])
  })

  it('wikilink：隐藏 `[[`/`]]` 与别名分隔符，显示别名', () => {
    const source = '见 [[设计|文档]] 吧'
    const items = decosOf(stateOf(source, 0))

    const open = at(source, '[[设计')
    const alias = at(source, '文档')
    expect(hiddens(items)).toEqual([
      { from: open, to: open + 2 }, // `[[`
      { from: open + 2, to: alias }, // `设计|`
      { from: alias + 2, to: alias + 4 }, // `]]`
    ])
    const wiki = marks(items).find((item) => classOf(item).includes(MD.wikilink))
    expect({ from: wiki?.from, to: wiki?.to }).toEqual({ from: alias, to: alias + 2 })
  })

  it('wikilink：没有别名时直接显示目标', () => {
    const source = '见 [[设计]] 吧'
    const items = decosOf(stateOf(source, 0))
    const wiki = marks(items).find((item) => classOf(item).includes(MD.wikilink))
    expect({ from: wiki?.from, to: wiki?.to }).toEqual({
      from: at(source, '设计'),
      to: at(source, '设计') + 2,
    })
  })

  it('wikilink：光标进入时露出 `[[ ]]`（但样式还在）', () => {
    const source = '见 [[设计|文档]] 吧'
    const items = decosOf(stateOf(source, at(source, '文档')))
    expect(hiddens(items)).toEqual([])
    expect(marks(items).some((item) => classOf(item).includes(MD.wikilink))).toBe(true)
  })

  it('解析结果来自宿主出链表：已解析 → 无 unresolved 类名并带目标路径', () => {
    const source = '见 [[设计]] 吧'
    const items = decosOf(
      stateOf(source, 0),
      contextOf({
        outbound: [
          {
            kind: 'wiki',
            rawTarget: '设计',
            display: '设计',
            alias: null,
            anchor: null,
            line: 1,
            resolvedRelPath: '项目/设计.md',
            ambiguous: false,
          },
        ],
      }),
    )
    const wiki = marks(items).find((item) => classOf(item).includes(MD.wikilink))

    expect(classOf(wiki as Deco)).not.toContain(MD.wikilinkUnresolved)
    expect((wiki?.value.spec as { attributes?: Record<string, string> }).attributes).toMatchObject({
      'data-mn-wikilink': '设计',
      'data-mn-resolved': '项目/设计.md',
    })
  })

  it('出链表里没有 / 解析为 null：加 unresolved 类名并提示"点击创建"', () => {
    const source = '见 [[还没写]] 吧'
    const items = decosOf(
      stateOf(source, 0),
      contextOf({
        outbound: [
          {
            kind: 'wiki',
            rawTarget: '还没写',
            display: '还没写',
            alias: null,
            anchor: null,
            line: 1,
            resolvedRelPath: null,
            ambiguous: false,
          },
        ],
      }),
    )
    const wiki = marks(items).find((item) => classOf(item).includes(MD.wikilink))
    const attributes = (wiki?.value.spec as { attributes?: Record<string, string> }).attributes

    expect(classOf(wiki as Deco)).toContain(MD.wikilinkUnresolved)
    expect(attributes?.['data-mn-resolved']).toBe('')
    expect(attributes?.title).toContain('点击创建')
  })

  it('锚点不隐藏但降调（`[[设计#小节]]`）', () => {
    const source = '见 [[设计#小节]] 吧'
    const items = decosOf(stateOf(source, 0))
    const anchor = marks(items).find((item) => classOf(item) === MD.linkAnchor)
    expect({ from: anchor?.from, to: anchor?.to }).toEqual({
      from: at(source, '#小节'),
      to: at(source, '#小节') + 3,
    })
  })

  it('转义的 `\\[[x]]` 不是链接（与宿主链接抽取同一口径）', () => {
    const source = '看 \\[[设计]] 吧'
    const items = decosOf(stateOf(source, 0))
    expect(marks(items).filter((item) => classOf(item).includes(MD.wikilink))).toEqual([])
  })

  it('frontmatter 只做淡色，不被当成标题/分隔线（lezer 会把它当 setext 标题）', () => {
    const source = ['---', 'tags: [设计, rust]', 'title: 标题', '---', '', '# 正文'].join('\n')
    const body = at(source, '# 正文')
    const items = decosOf(stateOf(source, body))

    // 四个 frontmatter 行（含首尾 `---`）：淡色，且**没有**分隔线 widget、没有 h2 行装饰
    expect(lines(items).map((item) => classOf(item))).toEqual([
      MD.frontmatter,
      MD.frontmatter,
      MD.frontmatter,
      MD.frontmatter,
      expect.stringContaining(MD.h1),
    ])
    expect(widgets(items)).toEqual([])
    // 正文里的标题照常渲染
    expect(classOf(lineAt(items, body) as Deco)).toContain(MD.h1)
  })

  it('frontmatter 里的 [[链接]] 不变成 wikilink', () => {
    const source = ['---', 'related: "[[设计]]"', '---', '', '正文'].join('\n')
    const items = decosOf(stateOf(source, at(source, '正文')))
    expect(marks(items).filter((item) => classOf(item).includes(MD.wikilink))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 图片
// ---------------------------------------------------------------------------

describe('图片（asset 逐文件授权的展示层）', () => {
  it('未授权/非 Tauri：`![说明](路径)` 退化成 ▧ 占位文本，绝不产出裂图', () => {
    const source = '![示例图](附件/图.png)\n\n正文'
    const seen: string[] = []
    const items = decosOf(
      stateOf(source, at(source, '正文')),
      contextOf({
        resolveImage: (rel) => {
          seen.push(rel)
          return { kind: 'placeholder' }
        },
      }),
    )

    const widget = imageWidget(items)
    expect(widget).toBeInstanceOf(ImageWidget)
    expect(seen).toEqual(['笔记/附件/图.png']) // 相对当前笔记解析

    const element = widget.toDOM()
    expect(element.tagName).toBe('SPAN')
    expect(element.querySelector('img')).toBeNull()
    expect(element.textContent).toBe('▧ 示例图')
  })

  it('授权到位：widget 渲染真的 <img>（src 是 asset URL）', () => {
    const source = '![示例图](附件/图.png)\n\n正文'
    const items = decosOf(
      stateOf(source, at(source, '正文')),
      contextOf({ resolveImage: () => ({ kind: 'ready', url: 'asset://localhost/图.png' }) }),
    )
    const widget = imageWidget(items)

    const element = widget.toDOM()
    const image = element.querySelector('img')
    expect(image?.getAttribute('src')).toBe('asset://localhost/图.png')
    expect(image?.getAttribute('alt')).toBe('示例图')
  })

  it('外链图片解析不出相对路径：给占位文本，且不发起授权请求', () => {
    const source = '![远端](https://example.com/x.png)\n\n正文'
    const seen: string[] = []
    const items = decosOf(
      stateOf(source, at(source, '正文')),
      contextOf({
        resolveImage: (rel) => {
          seen.push(rel)
          return { kind: 'placeholder' }
        },
      }),
    )
    expect(seen).toEqual([])
    expect(imageWidget(items)).toBeInstanceOf(ImageWidget)
  })

  it('光标在该行：露原文（否则没法改路径）', () => {
    const source = '![示例图](附件/图.png)\n\n正文'
    expect(widgets(decosOf(stateOf(source, at(source, '示例图'))))).toEqual([])
  })

  // ---- Obsidian 口径：裸文件名走全库索引（domain/assets.ts 的 createAssetResolver）----

  it('裸文件名 `![[图.png]]`：当前目录没有时按全库索引命中真正的文件', () => {
    const source = '![[图.png]]\n\n正文'
    const seen: string[] = []
    const items = decosOf(
      stateOf(source, at(source, '正文')),
      contextWithEntries(
        [
          { relPath: '笔记/测试.md' },
          { relPath: '附件/图.png' },
          { relPath: '附件', isDir: true },
        ],
        {
          resolveImage: (rel) => {
            seen.push(rel)
            return { kind: 'placeholder' }
          },
        },
      ),
    )

    expect(seen).toEqual(['附件/图.png'])
    expect(widgets(items)[0]?.value).toBeDefined()
  })

  it('裸文件名 `![说明](图.png)`：同一个解析器，同样能命中整库里的图', () => {
    const source = '![说明](图.png)\n\n正文'
    const seen: string[] = []
    decosOf(
      stateOf(source, at(source, '正文')),
      contextWithEntries([{ relPath: '图片/图.png' }], {
        resolveImage: (rel) => {
          seen.push(rel)
          return { kind: 'placeholder' }
        },
      }),
    )

    expect(seen).toEqual(['图片/图.png'])
  })

  it('相对写法命中时就近优先（全库兜底不抢）', () => {
    const source = '![[图.png]]\n\n正文'
    const seen: string[] = []
    decosOf(
      stateOf(source, at(source, '正文')),
      contextWithEntries([{ relPath: '笔记/图.png' }, { relPath: '附件/图.png' }], {
        resolveImage: (rel) => {
          seen.push(rel)
          return { kind: 'placeholder' }
        },
      }),
    )

    expect(seen).toEqual(['笔记/图.png'])
  })

  it('带路径的写法**不**做全库兜底（越界必须老老实实失败）', () => {
    const entries = [{ relPath: '附件/图.png' }]
    // 越界（根目录笔记的 `../`）→ 解析为 null → 占位，而且**不登记授权请求**
    const outOfBounds: string[] = []
    const outItems = decosOf(
      stateOf('![图](../图.png)\n\n正文', at('![图](../图.png)\n\n正文', '正文')),
      contextWithEntries(entries, {
        noteRelPath: '测试.md',
        resolveImage: (rel) => {
          outOfBounds.push(rel)
          return { kind: 'placeholder' }
        },
      }),
    )
    expect(outOfBounds).toEqual([])
    expect(imageWidget(outItems)).toBeInstanceOf(ImageWidget)
    expect(imageWidget(outItems).toDOM().textContent).toContain('▧')

    // 带路径但不存在 → 用相对解析的结果（而不是静默落到同名的 `附件/图.png`）
    const seen: string[] = []
    decosOf(
      stateOf('![图](子目录/图.png)\n\n正文', at('![图](子目录/图.png)\n\n正文', '正文')),
      contextWithEntries(entries, {
        resolveImage: (rel) => {
          seen.push(rel)
          return { kind: 'placeholder' }
        },
      }),
    )
    expect(seen).toEqual(['笔记/子目录/图.png'])
  })

  it('`![[图.png]]` 按图片渲染，`![[笔记.md]]` 按普通 wikilink 处理', () => {
    const source = '![[附件/图.png]]\n\n![[别的笔记]]\n\n正文'
    const items = decosOf(
      stateOf(source, at(source, '正文')),
      contextOf({ resolveImage: () => ({ kind: 'placeholder' }) }),
    )

    const image = widgets(items)[0]
    expect(imageWidget(items)).toBeInstanceOf(ImageWidget)
    expect({ from: image?.from, to: image?.to }).toEqual({
      from: at(source, '![[附件'),
      to: at(source, '![[附件') + '![[附件/图.png]]'.length,
    })

    // 非图片扩展名：按 wikilink 渲染（有链接样式，没有第二个图片 widget）
    expect(widgets(items)).toHaveLength(1)
    const wiki = marks(items).find((item) => classOf(item).includes(MD.wikilink))
    expect({ from: wiki?.from, to: wiki?.to }).toEqual({
      from: at(source, '别的笔记'),
      to: at(source, '别的笔记') + 4,
    })
  })

  it('非 Tauri 运行时不会调用 asset_authorize（授权请求根本不发出去）', () => {
    stageAsset('C:\\Vault', '附件/图.png')
    flushAssets()

    expect(ipcCalls).toBe(0)
    expect(lookupAsset('C:\\Vault', '附件/图.png')).toEqual({ kind: 'placeholder' })
  })

  it('同一路径只请求一次，授权结果按 `Vault 根 + 相对路径` 缓存', async () => {
    ;(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {
      convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
    }
    try {
      stageAsset('C:\\Vault', '附件/图.png')
      flushAssets()
      await settle()

      expect(ipcCalls).toBe(1)
      const resolution = lookupAsset('C:\\Vault', '附件/图.png')
      expect(resolution.kind).toBe('ready')

      // 再登记一次（例如滚动回到同一屏）：不会再发请求
      stageAsset('C:\\Vault', '附件/图.png')
      flushAssets()
      await settle()
      expect(ipcCalls).toBe(1)

      // 换了 Vault 根：同样的相对路径是另一条缓存
      expect(lookupAsset('D:\\别的Vault', '附件/图.png')).toEqual({ kind: 'placeholder' })

      // 图片加载失败 → 该 URL 就地降级为占位（下一次重算就会换成占位文本）
      if (resolution.kind === 'ready') markAssetFailed(resolution.url)
      expect(lookupAsset('C:\\Vault', '附件/图.png')).toEqual({ kind: 'placeholder' })
    } finally {
      delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__']
    }
  })
})

// ---------------------------------------------------------------------------
// 图片：块级呈现（在两行之间独占一行，但仍是"光标感知"的内联装饰）
// ---------------------------------------------------------------------------

describe('图片：块级呈现', () => {
  const placeholder = { resolveImage: () => ({ kind: 'placeholder' as const }) }

  it('整行只有一张图：挂"图片行"类名（用来收掉行盒多余的行距）', () => {
    const source = '![示例图](附件/图.png)\n\n正文'
    const items = decosOf(stateOf(source, at(source, '正文')), contextOf(placeholder))

    expect(widgets(items)).toHaveLength(1)
    expect(classOf(lineAt(items, 0) as Deco)).toContain(MD.imageLine)
  })

  it('图片夹在文字中间：仍然换成 widget，但不挂"图片行"（这一行还有文字要占正常行高）', () => {
    const source = '前文 ![示例图](附件/图.png) 后文\n\n尾巴'
    const items = decosOf(stateOf(source, at(source, '尾巴')), contextOf(placeholder))

    expect(widgets(items)).toHaveLength(1)
    expect(lines(items)).toEqual([])
  })

  it('光标进入该行：widget 与"图片行"类名一起撤掉，露出 Markdown 原文（ADR-0009 的铁律）', () => {
    const source = '![示例图](附件/图.png)\n\n正文'
    const items = decosOf(stateOf(source, at(source, '示例图')), contextOf(placeholder))

    expect(widgets(items)).toEqual([])
    expect(lines(items)).toEqual([])
  })

  it('视口外的图片不产出任何装饰（块级是"视觉"上的，计算仍然只在视口内）', () => {
    const source = ['![示例图](附件/图.png)', '', '正文', '', '尾巴'].join('\n')
    const state = stateOf(source, at(source, '尾巴'))
    const lastLine = state.doc.line(5)
    const items = decosOf(state, contextOf(placeholder), [
      { from: lastLine.from, to: lastLine.to },
    ])

    expect(widgets(items)).toEqual([])
    expect(lines(items)).toEqual([])
  })
})

describe('样式契约（装饰类名 ↔ CSS 规则）', () => {
  it('图片是块级呈现；"图片行"收掉行距；占位文本自带行高不会被压扁', () => {
    expect(livePreviewThemeSpec['.mn-md-image-wrap']?.display).toBe('block')
    expect(livePreviewThemeSpec['.mn-md-image-wrap']?.width).toBe('fit-content')
    expect(livePreviewThemeSpec['.mn-md-image']?.display).toBe('block')
    expect(livePreviewThemeSpec['.mn-md-image-placeholder']?.display).toBe('block')
    // 图片行是 `line-height: 0`：占位文本必须自己带行高，否则会被压成 0 高
    expect(livePreviewThemeSpec['.cm-line.mn-md-image-line']?.lineHeight).toBe('0')
    expect(livePreviewThemeSpec['.mn-md-image-placeholder']?.lineHeight).toBe('1.5')
  })
})

// ---------------------------------------------------------------------------
// 视口策略与装配
// ---------------------------------------------------------------------------

describe('视口策略与真实装配', () => {
  const source = ['# 标题', '', '第一段 **粗体**', '', '最后一段 **粗体二**'].join('\n')

  it('只对可视范围内的行产出装饰（滚动到大文档末尾不会去算开头）', () => {
    const state = stateOf(source, 0)
    const lastLine = state.doc.line(5)
    const items = decosOf(state, contextOf(), [{ from: lastLine.from, to: lastLine.to }])

    expect(lines(items)).toEqual([]) // 第 1 行的标题行装饰不在视口里
    expect(marks(items).filter((item) => classOf(item) === MD.strong)).toHaveLength(1)
  })

  it('装饰真的落到 DOM：标记被隐藏，且原子区间装配不报错', () => {
    // 光标放在最后一行 → 第一行的标题标记应当被隐藏
    const view = mountEditor(source, source.length - 1)
    const content = view.dom.querySelector('.cm-content')

    expect(content).not.toBeNull()
    expect(content?.querySelector('.mn-md-h1')).not.toBeNull()
    expect(content?.textContent ?? '').not.toContain('# 标题')
    expect(content?.textContent ?? '').toContain('标题')
  })

  it('宿主索引回来后，悬空类名跟着变（不重建编辑器）', async () => {
    const view = mountEditor('见 [[设计]] 吧\n\n尾巴', 0)
    const before = document.querySelector('.mn-wikilink')
    expect(before?.classList.contains(MD.wikilinkUnresolved)).toBe(true)

    useLinksStore.setState({
      links: {
        relPath: '笔记/测试.md',
        outbound: [
          {
            kind: 'wiki',
            rawTarget: '设计',
            display: '设计',
            alias: null,
            anchor: null,
            line: 1,
            resolvedRelPath: '项目/设计.md',
            ambiguous: false,
          },
        ],
        backlinks: [],
        unresolvedCount: 0,
      },
    })
    await settle()

    const after = document.querySelector('.mn-wikilink')
    expect(after?.classList.contains(MD.wikilinkUnresolved)).toBe(false)
    expect(after?.getAttribute('data-mn-resolved')).toBe('项目/设计.md')
    expect(view.state.doc.toString()).toBe('见 [[设计]] 吧\n\n尾巴')
  })

  it('原子区间覆盖所有被隐藏的标记（光标不会停在看不见的字符之间）', () => {
    const state = stateOf(source, source.length - 1)
    const result = buildLivePreview(state, contextOf())
    const atoms: Array<{ from: number; to: number }> = []
    result.atomicRanges.between(0, state.doc.length, (from, to) => {
      atoms.push({ from, to })
    })

    expect(atoms.length).toBeGreaterThan(0)
    // 原子区间必须与隐藏装饰一一对应
    const hidden = hiddens(decosOf(state))
    expect(atoms).toEqual(hidden)
  })
})

// ---------------------------------------------------------------------------
// 点击交互（插件在 contentDOM 上的 mousedown）
// ---------------------------------------------------------------------------

describe('点击交互', () => {
  it('点复选框 = 切换 `- [ ]` → `- [x]`，并且真的走编辑器的变更通道', () => {
    const source = '- [ ] 未完成\n- 别的'
    const view = mountEditor(source, source.length - 1)

    const box = view.dom.querySelector('.mn-md-task-box')
    expect(box).not.toBeNull()
    box?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))

    expect(view.state.doc.line(1).text).toBe('- [x] 未完成')
  })

  it('点 wikilink = 打开目标笔记（解析结果来自宿主出链表）', async () => {
    await useVaultStore.getState().openVault('C:\\MockVault')
    useLinksStore.setState({
      links: {
        relPath: '笔记/测试.md',
        outbound: [
          {
            kind: 'wiki',
            rawTarget: '设计',
            display: '设计',
            alias: null,
            anchor: null,
            line: 1,
            resolvedRelPath: '项目/设计.md',
            ambiguous: false,
          },
        ],
        backlinks: [],
        unresolvedCount: 0,
      },
    })

    const view = mountEditor('见 [[设计]] 吧\n\n尾巴', 0)
    const link = view.dom.querySelector('[data-mn-wikilink]')
    expect(link?.getAttribute('data-mn-resolved')).toBe('项目/设计.md')

    link?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    await settle()

    expect(useNoteStore.getState().doc?.relPath).toBe('项目/设计.md')
  })

  it('Alt+点击不跳转（把光标放进链接里编辑的出口）', async () => {
    await useVaultStore.getState().openVault('C:\\MockVault')
    useLinksStore.setState({
      links: {
        relPath: '笔记/测试.md',
        outbound: [
          {
            kind: 'wiki',
            rawTarget: '设计',
            display: '设计',
            alias: null,
            anchor: null,
            line: 1,
            resolvedRelPath: '项目/设计.md',
            ambiguous: false,
          },
        ],
        backlinks: [],
        unresolvedCount: 0,
      },
    })

    const view = mountEditor('见 [[设计]] 吧\n\n尾巴', 0)
    view.dom
      .querySelector('[data-mn-wikilink]')
      ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, altKey: true }))
    await settle()

    expect(useNoteStore.getState().doc).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 图片加载失败的 DOM 回退（插件在 contentDOM 上以捕获阶段监听 error）
// ---------------------------------------------------------------------------

describe('图片解析的真实装配（vault-store 条目表 → 全库索引解析器）', () => {
  function stubTauri(): void {
    ;(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {
      convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
    }
  }

  it('裸文件名 `![[图.png]]` 命中整库里的图，并且请求的是**解析后**的相对路径', async () => {
    stubTauri()
    try {
      pretendOpenNote('笔记/测试.md')
      useVaultStore.setState({
        info: {
          rootPath: 'C:\\Vault',
          name: 'Vault',
          entryCount: 2,
          noteCount: 1,
          folderCount: 1,
          truncated: false,
          skipped: 0,
          scanMs: 0,
        },
        entries: [
          makeEntry({ relPath: '笔记/测试.md' }),
          makeEntry({ relPath: '附件/图.png' }),
        ],
      })

      const source = '![[图.png]]\n\n尾巴'
      const view = mountEditor(source, source.length - 1)
      await settle()

      expect(assetRequests).toEqual([['附件/图.png']])
      expect(view.dom.querySelector('img.mn-md-image')).not.toBeNull()
    } finally {
      delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__']
    }
  })

  it('error 事件后该图片降级为占位（不留裂图）', async () => {
    stubTauri()
    try {
      pretendOpenNote('笔记/测试.md')
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

      const source = '![图](附件/图.png)\n\n尾巴'
      const view = mountEditor(source, source.length - 1)
      await settle()

      const image = view.dom.querySelector('img.mn-md-image')
      expect(image).not.toBeNull()

      // 模拟加载失败：真实的"裂图"就是这一步之后出现的，插件必须把它换掉
      image?.dispatchEvent(new Event('error'))
      await settle()

      expect(view.dom.querySelector('img.mn-md-image')).toBeNull()
      expect(view.dom.querySelector('.mn-md-image-placeholder')?.textContent).toContain('▧')
    } finally {
      delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__']
    }
  })
})
