// @vitest-environment jsdom
/**
 * Live Preview 里的 callout（`> [!note] 标题`）。
 *
 * 四层，与 `tests/live-preview-table.test.tsx` 同一思路：
 * 1. **判读层**（`live-preview/callout.ts` 的 `readCallout`）：一行源码里"标记从哪到哪、
 *    是哪种类型、标题是什么"。判据本身只有一份（`domain/callouts.ts` 的 `parseCallout`），
 *    这里钉的是**位置算术**：`>` 前缀、折叠符、嵌套引用的前缀都要算准 —— 算错一个字符，
 *    替换装饰就会吃掉用户写的标题；
 * 2. **装饰层**：callout 行换成 callout 类名（**不再**是 `mn-md-quote`）、标记换成图标 widget、
 *    标题文字保留为真文字、光标进入标记行则整行露原文、`[!note]-` 的正文整行收起；
 * 3. **fold 改写**（`foldChangeAt`）：纯函数决定"改哪个字符"，同样优先信**重新判读**的结果；
 * 4. **装配层**：真的建 `EditorView`，点图标 → 文档里多出 `-`，正文随之收起。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { ensureSyntaxTree } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView, type Decoration } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'

import { createAssetResolver } from '@/domain/assets'
import { buildLivePreviewDecorations } from '@/features/editor/cm/live-preview/build'
import {
  foldChangeAt,
  readCallout,
  type LiveCallout,
} from '@/features/editor/cm/live-preview/callout'
import { livePreviewThemeSpec, MD } from '@/features/editor/cm/live-preview/theme'
import type { LivePreviewContext } from '@/features/editor/cm/live-preview/types'
import { CalloutMarkerWidget } from '@/features/editor/cm/live-preview/widgets'
import { createEditorExtensions } from '@/features/editor/cm/setup'

// ---------------------------------------------------------------------------
// 工具（与 `live-preview-table.test.tsx` 同一套读装饰的方式）
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

function decosOf(state: EditorState): Deco[] {
  // 语法树有**时间预算**，机器忙时可能只解析了一部分（与表格那套同一个坑、同一个解法）
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

function widgetOf(item: Deco): unknown {
  return (item.value.spec as { widget?: unknown }).widget ?? null
}

function classOf(item: Deco): string {
  return String((item.value.spec as { class?: string }).class ?? '')
}

/** 行装饰（`point` 为 true 且 from == to）。 */
function lineClasses(items: readonly Deco[], lineFrom: number): string[] {
  return items
    .filter((item) => item.value.point && item.from === lineFrom && item.to === lineFrom)
    .map(classOf)
}

function markClasses(items: readonly Deco[]): string[] {
  return items.filter((item) => !item.value.point).map(classOf)
}

/** 所有 mark 装饰的类名拼在一起（一条装饰可能带好几个类名，逐个相等比对是错的判据）。 */
function markClassText(items: readonly Deco[]): string {
  return markClasses(items).join(' ')
}

function calloutWidgetOf(items: readonly Deco[]): CalloutMarkerWidget {
  const found = items.find((item) => widgetOf(item) instanceof CalloutMarkerWidget)
  const widget = found === undefined ? null : widgetOf(found)
  if (!(widget instanceof CalloutMarkerWidget)) throw new Error('没有找到 callout 标记 widget')
  return widget
}

function readOrThrow(text: string, from = 0): LiveCallout {
  const callout = readCallout(text, from)
  if (callout === null) throw new Error(`不是 callout 起始行：${text}`)
  return callout
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
})

// ---------------------------------------------------------------------------
// 判读层
// ---------------------------------------------------------------------------

describe('读出标记的位置与内容', () => {
  it('基本形态：标记区间是 `[!note]`，标题是标记之后的文字', () => {
    const callout = readOrThrow('> [!note] 标题')

    expect(callout.type).toBe('note')
    expect(callout.rawType).toBe('note')
    expect(callout.known).toBe(true)
    // `> ` 占两个字符，`[!note]` 占 7 个：2..9
    expect(callout.markerFrom).toBe(2)
    expect(callout.markerTo).toBe(9)
    expect(callout.label).toBe('标题')
    expect(callout.hasTitle).toBe(true)
    expect(callout.glyph).toBe('✎')
    expect(callout.accent).toBe('--mn-callout-note')
    expect(callout.fold).toBeNull()
  })

  it('别名与大小写不敏感（判据来自 `domain/callouts.ts`，这里只是透传）', () => {
    const callout = readOrThrow('> [!HINT] 提示一下')
    expect(callout.type).toBe('tip')
    expect(callout.rawType).toBe('HINT')
    expect(callout.known).toBe(true)
  })

  it('折叠符算进标记区间（否则它会留在标题前面）', () => {
    const callout = readOrThrow('> [!tip]- 可以收起')
    expect(callout.fold).toBe('-')
    expect(callout.markerFrom).toBe(2)
    // `[!tip]-` 共 7 个字符：2 + 7 = 9
    expect(callout.markerTo).toBe(9)
    expect(callout.label).toBe('可以收起')
  })

  it('没有标题：hasTitle 为假，label 退化成类型展示名（由图标 widget 补出来）', () => {
    const callout = readOrThrow('> [!warning]')
    expect(callout.hasTitle).toBe(false)
    expect(callout.label).toBe('警告')
    expect(callout.markerTo).toBe(12)
  })

  it('未知类型：样式回落成 note，但名字保留用户写的那一个', () => {
    const callout = readOrThrow('> [!摘录] 一段话')
    expect(callout.type).toBe('note')
    expect(callout.rawType).toBe('摘录')
    expect(callout.known).toBe(false)
    expect(callout.label).toBe('一段话')
    expect(callout.glyph).toBe('✎')
    expect(callout.accent).toBe('--mn-callout-note')
  })

  it('嵌套引用：标记位置要把两层 `>` 前缀都算进去', () => {
    const callout = readOrThrow('> > [!info] 内层')
    expect(callout.markerFrom).toBe(4)
    expect(callout.markerTo).toBe(11)
  })

  it('不是 callout 起始行的写法一律返回 null', () => {
    expect(readCallout('> 普通引用里的 [!note] 不算', 0)).toBeNull()
    expect(readCallout('> [note] 少了感叹号', 0)).toBeNull()
    expect(readCallout('[!note] 没有引用前缀', 0)).toBeNull()
    expect(readCallout('正文 [!note] 行中间', 0)).toBeNull()
  })

  it('前缀里的多余空白也算进位置（`>   [!note]`）', () => {
    const callout = readOrThrow('>   [!note] 标题')
    expect(callout.markerFrom).toBe(4)
    expect(callout.markerTo).toBe(11)
  })
})

// ---------------------------------------------------------------------------
// 装饰层
// ---------------------------------------------------------------------------

describe('框的边距与阅读视图对齐（"两个视图统一"的判据，用户报过"编辑区里没有边距"）', () => {
  /**
   * 直接从磁盘读 app.css（与 `tests/app-shell.test.tsx` 同一个理由与同一套候选路径：
   * vitest 的工作目录既可能是 `apps/desktop`，也可能是仓库根）。
   */
  function readAppCss(): string {
    const candidates = [
      resolve(process.cwd(), 'src/styles/app.css'),
      resolve(process.cwd(), 'apps/desktop/src/styles/app.css'),
    ]
    for (const candidate of candidates) {
      try {
        return readFileSync(candidate, 'utf8')
      } catch {
        // 换下一个候选路径
      }
    }
    throw new Error(`找不到 app.css（尝试过：${candidates.join('、')}）`)
  }

  /** 取某条规则的声明块。 */
  function ruleBody(css: string, selector: string): string {
    const start = css.indexOf(`\n${selector} {`)
    if (start === -1) throw new Error(`样式表里找不到规则：${selector}`)
    return css.slice(start, css.indexOf('}', start))
  }

  /** 声明块里某个属性值里的第一个 px 数字（简写取第一个分量）。 */
  function px(body: string, property: string): number {
    const matched = new RegExp(`${property}:\\s*([\\d.]+)px`, 'u').exec(body)
    if (matched === null) throw new Error(`声明块里找不到 ${property} 的 px 值：${body}`)
    return Number(matched[1])
  }

  it('首行/末行的内边距 = 阅读视图那张框的内边距（是加法关系，不是两边各抄一串数字）', () => {
    /*
      阅读视图的框是**块**：`.mn-callout { padding: 6px 14px 2px }` + 标题的 `margin: 4px 0`
      + `.mn-callout > *:last-child { margin-bottom: 8px }`。
      编辑器里一行是一个 `.cm-line`，**垂直 margin 会折叠出去**（见 theme.ts 表格那段），
      所以"框的内边距 + 标题的上下留白"只能全部由首行/末行的 `padding` 承担。
      这条用例把两边的**来源**钉在一起：谁改了一边而没有改另一边，红。
    */
    const css = readAppCss()
    const box = ruleBody(css, '.mn-callout')
    const title = ruleBody(css, '.mn-callout__title')
    const lastChild = ruleBody(css, '.mn-callout > *:last-child')

    const boxTop = px(box, 'padding')
    const boxX = Number(/padding:\s*[\d.]+px\s+([\d.]+)px/u.exec(box)?.[1] ?? Number.NaN)
    const boxBottom = Number(/padding:\s*[\d.]+px\s+[\d.]+px\s+([\d.]+)px/u.exec(box)?.[1] ?? Number.NaN)
    const titleTop = px(title, 'margin')
    const lastChildBottom = px(lastChild, 'margin-bottom')

    const base = livePreviewThemeSpec['.cm-line.mn-md-callout']
    const first = livePreviewThemeSpec['.cm-line.mn-md-callout--first']
    const last = livePreviewThemeSpec['.cm-line.mn-md-callout--last']
    expect(base?.paddingLeft).toBe(`${boxX}px`)
    expect(base?.paddingRight).toBe(`${boxX}px`)
    expect(first?.paddingTop).toBe(`${boxTop + titleTop}px`)
    expect(first?.paddingBottom).toBe(`${titleTop}px`)
    expect(last?.paddingBottom).toBe(`${boxBottom + lastChildBottom}px`)
  })
})

describe('装饰：行类名与图标', () => {
  // 光标放在块**外**（第三行）：标记行与正文行都进入"渲染态"
  const doc = '> [!note] 标题\n> 正文\n\n之后'
  const outside = doc.indexOf('之后')

  it('callout 行换成自己的类名，**不再**是引用行（两者是互斥的观感）', () => {
    const state = stateOf(doc, outside)
    const items = decosOf(state)
    const first = lineClasses(items, 0).join(' ')
    const second = lineClasses(items, state.doc.line(2).from).join(' ')

    expect(first).toContain(MD.callout)
    expect(first).toContain(`${MD.callout}--note`)
    // 强调色令牌的载体：类型 → 颜色只有 app.css 那一份表
    expect(first).toContain(`${MD.calloutAccent}note`)
    expect(first).toContain(MD.calloutFirst)
    expect(first).not.toContain(MD.quote)

    expect(second).toContain(`${MD.callout}--note`)
    expect(second).toContain(MD.calloutLast)
    expect(second).not.toContain(MD.quote)
    expect(second).not.toContain(MD.calloutFirst)
  })

  it('光杆标题：那一行同时是首行与末行（框要闭合，不能只有上半截）', () => {
    const solo = '> [!note] 只有标题\n\n之后'
    const state = stateOf(solo, solo.indexOf('之后'))
    const classes = lineClasses(decosOf(state), 0).join(' ')

    expect(classes).toContain(MD.calloutFirst)
    expect(classes).toContain(MD.calloutLast)
  })

  it('收起时**标记行就是框的底边**：藏起来的正文行不再带 last', () => {
    // 收起用的是"零高行"（`font-size: 0`），行元素还在，padding 照样参与布局 ——
    // 把圆角与下内边距留在一条看不见的行上，收起的提示框底下会多出一条空白。
    const folded = '> [!tip]- 收起\n> 正文一\n> 正文二\n\n之后'
    const state = stateOf(folded, folded.indexOf('之后'))
    const items = decosOf(state)

    const marker = lineClasses(items, 0).join(' ')
    expect(marker).toContain(MD.calloutFirst)
    expect(marker).toContain(MD.calloutLast)

    const collapsedBody = lineClasses(items, state.doc.line(2).from).join(' ')
    expect(collapsedBody).not.toContain(MD.calloutLast)
  })

  it('标记被换成图标 widget，标题仍是**真文字**（加粗上色，不是 HTML）', () => {
    const state = stateOf(doc, outside)
    const items = decosOf(state)
    const widget = calloutWidgetOf(items)

    // `[!note]` 只被替换，`> ` 照旧被隐藏（引用标记的统一处理）
    expect(
      items.some((item) => item.value.point && item.from === 2 && item.to === 9),
    ).toBe(true)

    expect(widget.toDOM().textContent).toBe('✎')
    expect(widget.toDOM().getAttribute('data-mn-callout-fold')).toBe('9')

    const title = items.find((item) => classOf(item) === MD.calloutTitle)
    expect(title?.from).toBe(10)
    expect(title?.to).toBe(12)
    expect(state.doc.sliceString(10, 12)).toBe('标题')
  })

  it('标题为空时由 widget 补出类型名（补的是推断，不是用户写的字）', () => {
    const source = '> [!warning]\n> 正文\n\n之后'
    const items = decosOf(stateOf(source, source.indexOf('之后')))
    const widget = calloutWidgetOf(items)
    expect(widget.toDOM().textContent).toBe('!警告')
  })

  it('折叠符显示成角标（静态渲染里的同一个说明）', () => {
    const source = '> [!note]- 标题\n> 正文\n\n之后'
    const items = decosOf(stateOf(source, source.indexOf('之后')))
    expect(calloutWidgetOf(items).toDOM().textContent).toBe('✎-')
  })

  it('标记行的 `[!note]` 被当作链接的写法不会再产出链接装饰（它已经不是链接了）', () => {
    const items = decosOf(stateOf(doc, outside))
    expect(markClassText(items)).not.toContain(MD.link)
  })

  it('光标在标记行：一个装饰都不挂（整行露原文，与其它语法同一条纪律）', () => {
    const items = decosOf(stateOf('> [!note] 标题\n> 正文', 0))
    expect(items.some((item) => widgetOf(item) instanceof CalloutMarkerWidget)).toBe(false)
    expect(markClassText(items)).not.toContain(MD.calloutTitle)
    // 光标在这一行，连 `>` 都留着
    expect(items.some((item) => item.value.point && item.from === 0 && item.to === 2)).toBe(false)
  })

  it('续行的 `>` 也隐藏、也套在同一个框里（`> 甲\\n> 乙` 是同一个段落）', () => {
    const source = '> [!note] 标题\n> 正文\n\n之后'
    const state = stateOf(source, source.indexOf('之后'))
    const items = decosOf(state)
    const second = state.doc.line(2).from
    // 第二行的 `>` 在 `Paragraph` 里（不是 Blockquote 的直接孩子）：递归找才隐藏得掉
    expect(items.some((item) => item.value.point && item.from === second && item.to === second + 1)).toBe(true)
  })
})

describe('装饰：折叠（`[!note]-`）', () => {
  // 光标放在块外：折叠才有意义（光标进到正文里时整块展开，见下一条）
  const doc = '> [!note]- 标题\n> **粗体** 与 [[链接]]\n> 更多\n\n之后'
  const outside = doc.indexOf('之后')

  it('正文行整行收起，行内语法一概不再产出装饰', () => {
    const state = stateOf(doc, outside)
    const items = decosOf(state)

    expect(lineClasses(items, state.doc.line(2).from)).toContain(MD.collapsedLine)
    expect(lineClasses(items, state.doc.line(3).from)).toContain(MD.collapsedLine)
    // 被收起的正文里：粗体不加粗、链接不可点 —— 零高的行里那些装饰既看不见又白算
    expect(markClassText(items)).not.toContain(MD.strong)
    expect(markClassText(items)).not.toContain(MD.wikilink)
    // 标题装饰只有一处，且在标记行上（正文里没有第二个"标题"）
    const titles = items.filter((item) => classOf(item) === MD.calloutTitle)
    expect(titles).toHaveLength(1)
    expect(titles[0]?.from).toBeLessThan(state.doc.line(2).from)
    // 标题行照常是 callout 的标题
    expect(lineClasses(items, 0).join(' ')).toContain(`${MD.callout}--note`)
    expect(calloutWidgetOf(items).toDOM().textContent).toBe('✎-')
  })

  it('`+` 与不写折叠符都不收起', () => {
    for (const marker of ['> [!note]+ 标题', '> [!note] 标题']) {
      const source = `${marker}\n> 正文\n\n之后`
      const state = stateOf(source, source.indexOf('之后'))
      const items = decosOf(state)
      expect(lineClasses(items, state.doc.line(2).from)).not.toContain(MD.collapsedLine)
    }
  })

  it('光标进到被收起的正文里：整块展开（否则会"点进去了却看不见"）', () => {
    const state = stateOf(doc, doc.indexOf('粗体'))
    const items = decosOf(state)
    expect(lineClasses(items, state.doc.line(2).from)).not.toContain(MD.collapsedLine)
    expect(markClassText(items)).toContain(MD.strong)
    expect(markClassText(items)).toContain(MD.wikilink)
  })
})

describe('装饰：与其它语法的边界', () => {
  it('普通引用一个字都不变（连类名都不加）', () => {
    const state = stateOf('> 只是引用', 0)
    const items = decosOf(state)
    const classes = lineClasses(items, 0).join(' ')
    expect(classes).toContain(MD.quote)
    expect(classes).not.toContain(MD.callout)
  })

  it('引用块里第二段出现 `[!note]` 不算 callout（判据只看首行）', () => {
    const state = stateOf('> 第一段\n>\n> [!note] 这里只是文字', 0)
    const items = decosOf(state)
    expect(items.some((item) => widgetOf(item) instanceof CalloutMarkerWidget)).toBe(false)
  })

  it('嵌套 callout：一行上只显示**最内层**的框（第 2 行属于内层的标记行）', () => {
    const source = '> [!note] 外层\n> > [!tip] 内层\n> 外层续\n\n之后'
    const state = stateOf(source, source.indexOf('之后'))
    const items = decosOf(state)
    const second = state.doc.line(2).from
    const third = state.doc.line(3).from

    const first = lineClasses(items, 0).join(' ')
    expect(first).toContain(`${MD.callout}--note`)
    expect(first).toContain(MD.calloutFirst)

    // 第 2 行是内层 callout 的标记行：显示内层的颜色，并多一级缩进
    const nested = lineClasses(items, second).join(' ')
    expect(nested).toContain(`${MD.callout}--tip`)
    expect(nested).toContain(MD.calloutNested)
    expect(nested).toContain(MD.calloutFirst)

    // 第 3 行（`> 外层续`）：两层都覆盖到它，最内层的框收尾
    const last = lineClasses(items, third).join(' ')
    expect(last).toContain(`${MD.callout}--tip`)
    expect(last).toContain(MD.calloutLast)

    // 两个标记各自有 widget（内外层各一个）
    expect(items.filter((item) => widgetOf(item) instanceof CalloutMarkerWidget)).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// fold 改写（纯函数）
// ---------------------------------------------------------------------------

describe('点击图标：改哪个字符', () => {
  it('没写折叠符 → 补一个 `-`（默认收起）', () => {
    expect(foldChangeAt(stateOf('> [!note] 标题'), 9)).toEqual({
      from: 9,
      to: 9,
      insert: '-',
    })
  })

  it('`-` ↔ `+` 互换', () => {
    expect(foldChangeAt(stateOf('> [!note]- 标题'), 10)).toEqual({
      from: 9,
      to: 10,
      insert: '+',
    })
    expect(foldChangeAt(stateOf('> [!note]+ 标题'), 10)).toEqual({
      from: 9,
      to: 10,
      insert: '-',
    })
  })

  it('位置漂移也不改错字符：按当前行重新判读', () => {
    // 传进来的位置是"上一轮装饰算的"，此刻行首已经多了两个字
    expect(foldChangeAt(stateOf('前缀\n> [!tip] 标题'), 20)).toEqual({
      from: 11,
      to: 11,
      insert: '-',
    })
  })

  it('不是 callout 的行：什么都不做', () => {
    expect(foldChangeAt(stateOf('> 普通引用'), 2)).toBeNull()
    expect(foldChangeAt(stateOf(''), 0)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 装配：真的落到编辑器 DOM 里
// ---------------------------------------------------------------------------

describe('装配到编辑器', () => {
  it('点图标 → 文档里多出 `-`，正文随之收起', () => {
    const doc = '> [!note] 标题\n> 正文\n\n之后'
    // 光标在块外的段落里：此时标记被换成了图标（光标在标记行上会整行露原文）
    const view = mountEditor(doc, doc.indexOf('之后'))

    const marker = view.dom.querySelector('.mn-md-callout-marker')
    expect(marker).not.toBeNull()
    marker?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))

    // 走的是**文档变更**（因此会被保存流水线看见），不是只改显示
    expect(view.state.doc.toString()).toBe('> [!note]- 标题\n> 正文\n\n之后')
    expect(view.dom.querySelector(`.${MD.collapsedLine}`)).not.toBeNull()
  })

  it('点第二次 → 变回 `+`，正文重新露出来', () => {
    const doc = '> [!note]- 标题\n> 正文\n\n之后'
    const view = mountEditor(doc, doc.indexOf('之后'))

    const marker = view.dom.querySelector('.mn-md-callout-marker')
    expect(marker).not.toBeNull()
    marker?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))

    expect(view.state.doc.toString()).toBe('> [!note]+ 标题\n> 正文\n\n之后')
    expect(view.dom.querySelector(`.${MD.collapsedLine}`)).toBeNull()
  })
})
