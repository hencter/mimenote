/**
 * Live Preview 装饰计算（**纯函数**，可脱离 EditorView 单测）。
 *
 * ### 为什么用装饰而不是"渲染 HTML"
 * 编辑器里的字符就是文件里的字符 —— 光标、撤销历史、选区、搜索、IME、防抖保存，
 * 全都建立在"文档没有被动过"这一条上。所见即所得如果靠"把 Markdown 换成 HTML 再重渲染"，
 * 就必须反向往回映射源码，光标与撤销会立刻失真。所以这里只做**展示层**：
 * 不改 `doc`，只挂样式、把光标不在处的语法标记隐藏起来（`Decoration.replace`）。
 *
 * ### 为什么按视口算
 * 语法树遍历只走 `view.visibleRanges`（滚动/折叠时 CM 会给出新的范围），
 * 所以代价是 O(可视行 + 可视节点)，而不是 O(全文)。几千行的笔记滚动、输入都不受影响。
 *
 * ### 为什么光标进入必须露出原文
 * 隐藏的是**语法标记**，不是内容。用户贴着标记编辑时看到的必须是他自己写的字符 ——
 * 例如在 `**粗体**` 里再敲一个 `*`，如果标记一直藏着，他会以为输入丢了。
 * 所以判据是"选区与整个节点范围相交"就整段露出（块级用"光标是否在该行"）。
 */

import { syntaxTree } from '@codemirror/language'
import { RangeSet, RangeSetBuilder, type EditorState, type Range } from '@codemirror/state'
import { Decoration, type DecorationSet } from '@codemirror/view'

import { isImageAssetTarget, parseImageSize, type ImageSize } from '@/domain/assets'
import { frontmatterRegion } from '@/domain/frontmatter'
import { normalizeLinkTarget, splitWikilink } from '@/domain/links'
import type { ResolvedLink } from '@/ipc/types'

import { LINK_ATTR, MD, WIKILINK_ATTR, WIKILINK_RESOLVED_ATTR, mdHeadingClass } from './theme'
import { calloutLineClass, readCallout, type CalloutLinePosition, type LiveCallout } from './callout'
import { isNestedTable, renderTableHtml, tableSourceWithinLimits } from './table'
import type { LivePreviewContext, LivePreviewDecorationResult, ImageResolution, VisibleRange } from './types'
import {
  CalloutMarkerWidget,
  HorizontalRuleWidget,
  ImageWidget,
  ListMarkWidget,
  TableWidget,
  TaskCheckboxWidget,
  type TableWidgetLink,
} from './widgets'

type TreeLike = ReturnType<typeof syntaxTree>
/** 语法树节点（`@lezer/common` 不是本包的直接依赖，因此用索引访问拿到类型而不 import 它）。 */
type SyntaxNodeLike = TreeLike['topNode']

/** 隐藏一段原文（不留任何 DOM），并登记为原子区间。 */
const HIDDEN = Decoration.replace({})

const HEADING_LEVELS: Readonly<Record<string, number>> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
  SetextHeading1: 1,
  SetextHeading2: 2,
}

/** 块级节点：行装饰、行内标记隐藏、整行替换都在这一组里处理。 */
const BLOCK_NODES = new Set([
  ...Object.keys(HEADING_LEVELS),
  'Blockquote',
  'ListMark',
  'TaskMarker',
  'HorizontalRule',
  'FencedCode',
  'Table',
])

/** 行内节点：样式 + 隐藏首尾标记。 */
const INLINE_NODES = new Set([
  'StrongEmphasis',
  'Emphasis',
  'Strikethrough',
  'InlineCode',
  'Link',
  'Image',
])

/**
 * 代码容器：内部的一切都不当成 Markdown（与预览面板的口径一致 ——
 * markdown-it 不解析代码里的 `[[链接]]`，这里也不该把它变成可点的链接）。
 */
const CODE_CONTAINERS = new Set(['FencedCode', 'InlineCode', 'CodeText', 'Comment'])

/** frontmatter 扫描的行数上限（它必然在文档最开头；超过这个长度就按普通正文处理）。 */
const FRONTMATTER_SCAN_LINES = 200

/**
 * wikilink / 嵌入。
 *
 * 为什么用**行级正则**而不是语法树节点：`[[双链|别名]]` 会被 lezer 拆成
 * "一个孤立的 `[` + 一个 `Link` 节点"，锚点与别名的边界也不在节点上。
 * 宿主索引侧同样是正则口径（`mn-core::links`），这里保持一致比"硬凑节点"更可靠。
 */
const WIKILINK_PATTERN = /(!?)\[\[([^[\]\n]+)\]\]/g

interface Collected {
  name: string
  from: number
  to: number
  node: SyntaxNodeLike
}

interface WikiMatch {
  from: number
  to: number
  inner: string
  embed: boolean
}

/** 一次构建过程中的共享状态。 */
interface Build {
  state: EditorState
  context: LivePreviewContext
  collection: DecorationCollector
  /** 视口范围（块级展开到多行时用来裁掉视口外的行）。 */
  visible: readonly VisibleRange[]
  /** 代码区间（wikilink 扫描时要跳过）。 */
  codeRanges: VisibleRange[]
  /**
   * 每行的引用层数（行号 → 层数）。
   *
   * 必须**跨节点**累加：嵌套引用是嵌套的 Blockquote，两层各覆盖内层那几行一次，
   * 只按"某一行里有几个 `>`"数就会把 `> > 乙` 与 `> > > 丙` 的第三行算成同一级。
   */
  quoteDepth: Map<number, number>
  /**
   * callout 的**行**（行号 → 这一行在 callout 里的位置）。
   *
   * 为什么与 `quoteDepth` 分开：行类名要等**所有**引用块都数完深度才定得下来（嵌套引用的
   * 内层节点在外层之后处理），而这里记的是"这一行属于哪个 callout"，与顺序无关。
   */
  callouts: Map<number, { callout: LiveCallout; position: CalloutLinePosition }>
  /**
   * 折叠起来（`[!note]-`）的正文行。
   *
   * 这些行的**一切**装饰都要跳过：它们被 `MD.collapsedLine` 压成零高，再往里塞 widget
   * 或原子区间，既不显示又会白白参与命中与测量（表格 / 图片 widget 是块级的，零高根本压不住它）。
   */
  collapsed: Set<number>
  /** 文档开头的 frontmatter 行区间（1 起、闭区间）；那里的 Markdown 语法不渲染。 */
  frontmatter: { first: number; last: number } | null
  /**
   * 有序列表的编号表（键 = `OrderedList` 节点的起点）。
   *
   * 为什么缓存：算一个列表的编号要沿它的 `ListItem` 走一遍（见 {@link orderedNumbering}），
   * 而同一屏里一个列表会命中好几个标记 —— 一次重算里每个列表只算一次。
   */
  listNumbering: Map<number, ListNumbering>
}

/**
 * 装饰收集器。
 *
 * 为什么最后才排序：`Decoration.set(.., true)` 会自己排，但 `RangeSetBuilder`
 * 要求"按 `from`、同位置按 `startSide` 升序"，而这里的装饰来自三类规则
 * （行装饰 startSide = -2e8、replace = -2、mark = -1），手写插入顺序很容易踩错。
 * 统一攒起来再排一次，代价是 O(k log k)（k = 视口内装饰数，通常几十到几百）。
 */
class DecorationCollector {
  private readonly ranges: Array<Range<Decoration>> = []
  private readonly hidden: Array<Range<Decoration>> = []
  private readonly claims: VisibleRange[] = []

  /** 挂一条装饰（不改原文）。 */
  add(from: number, to: number, value: Decoration): void {
    if (to < from) return
    this.ranges.push(value.range(from, to))
  }

  /** 用装饰**替换**一段原文（隐藏或换成 widget），并把它登记为原子区间。 */
  replace(from: number, to: number, value: Decoration): void {
    if (to <= from) return
    const range = value.range(from, to)
    this.ranges.push(range)
    this.hidden.push(range)
    this.claims.push({ from, to })
  }

  /**
   * 只登记"这一段已经被接管"，**不产出任何装饰**。
   *
   * 用途是表格：整块换成 widget 之后，单元格里的行内语法不该再各自产出装饰
   * （那些文字在渲染态是 `display: none`，再往里塞 replace/原子区间只是白算，
   * 还会让"藏起来的文本被二次替换"）。与 {@link replace} 共用同一份 `claims`，
   * 因此 `isClaimed` 的判据只有一处。
   */
  claim(from: number, to: number): void {
    if (to <= from) return
    this.claims.push({ from, to })
  }

  /**
   * 这段原文是否已经被更外层的规则接管。
   *
   * 例：`![[图.png]]` 整段换成图片 widget 之后，语法树里嵌在里面的 `Image`/`Link`
   * 节点就不该再各自产出装饰（否则会出现重叠的 replace，渲染层会打架）。
   */
  isClaimed(from: number, to: number): boolean {
    return this.claims.some((claim) => claim.from < to && claim.to > from)
  }

  build(): LivePreviewDecorationResult {
    const sorted = [...this.ranges].sort(
      (a, b) => a.from - b.from || a.value.startSide - b.value.startSide,
    )
    const builder = new RangeSetBuilder<Decoration>()
    for (const range of sorted) builder.add(range.from, range.to, range.value)
    return {
      decorations: builder.finish(),
      atomicRanges: RangeSet.of(this.hidden, true),
    }
  }
}

/**
 * 计算 Live Preview 装饰。
 *
 * @param state 编辑器状态（只读；本函数不派发任何事务）
 * @param context 当前笔记 / 出链 / 图片解析器
 * @param visibleRanges 视口范围；不传 = 全文（测试与调试用）
 */
export function buildLivePreview(
  state: EditorState,
  context: LivePreviewContext,
  visibleRanges?: readonly VisibleRange[],
): LivePreviewDecorationResult {
  const doc = state.doc
  const visible: readonly VisibleRange[] =
    visibleRanges === undefined ? [{ from: 0, to: doc.length }] : visibleRanges

  const build: Build = {
    state,
    context,
    collection: new DecorationCollector(),
    visible,
    codeRanges: [],
    quoteDepth: new Map<number, number>(),
    callouts: new Map<number, { callout: LiveCallout; position: CalloutLinePosition }>(),
    collapsed: new Set<number>(),
    frontmatter: frontmatterLines(state),
    listNumbering: new Map<number, ListNumbering>(),
  }

  const blocks: Collected[] = []
  const inlines: Collected[] = []
  const seen = new Set<SyntaxNodeLike>()

  if (doc.length > 0) {
    const tree = syntaxTree(state)
    for (const range of visible) {
      if (range.to <= range.from) continue
      tree.iterate({
        from: range.from,
        to: range.to,
        enter: (node) => {
          const name = node.name
          // 同一个节点可能被多个可视区各访问一次（折叠会把视口切成几段）：
          // 记录一次即可，但**不能**提前 return false 掐掉子树 —— 另一段里可能还有没访问到的孩子。
          const first = !seen.has(node.node)
          if (first) {
            seen.add(node.node)
            if (BLOCK_NODES.has(name)) blocks.push({ name, from: node.from, to: node.to, node: node.node })
            else if (INLINE_NODES.has(name)) inlines.push({ name, from: node.from, to: node.to, node: node.node })
            if (CODE_CONTAINERS.has(name)) {
              build.codeRanges.push({ from: node.from, to: node.to })
              return false
            }
          } else if (CODE_CONTAINERS.has(name)) {
            return false
          }
          return undefined
        },
      })
    }
  }

  // 顺序有讲究：块级（会"接管"整行/整段）→ wikilink 扫描 → 行内样式。
  // 后两步都要靠 `isClaimed` 避开已经被接管的区间。
  for (const entry of blocks) emitBlock(build, entry)
  emitQuoteLines(build)
  emitWikilinks(build)
  for (const entry of inlines) emitInline(build, entry)
  emitFrontmatterLines(build)

  return build.collection.build()
}

/** 便捷包装：只要装饰集（调用方不关心原子区间时用）。 */
export function buildLivePreviewDecorations(
  state: EditorState,
  context: LivePreviewContext,
  visibleRanges?: readonly VisibleRange[],
): DecorationSet {
  return buildLivePreview(state, context, visibleRanges).decorations
}

// ---------------------------------------------------------------------------
// 块级
// ---------------------------------------------------------------------------

function emitBlock(build: Build, entry: Collected): void {
  if (inFrontmatter(build, entry.from)) return
  // 折叠起来的 callout 正文：块级装饰（行类名、widget）一概不产出（理由见 Build.collapsed）
  if (collapsedAt(build, entry.from)) return
  const level = HEADING_LEVELS[entry.name]
  if (level !== undefined) {
    emitHeading(build, entry, level)
    return
  }
  switch (entry.name) {
    case 'Blockquote':
      emitBlockquote(build, entry)
      return
    case 'ListMark':
      emitListMark(build, entry)
      return
    case 'TaskMarker':
      emitTaskMarker(build, entry)
      return
    case 'HorizontalRule':
      emitHorizontalRule(build, entry)
      return
    case 'FencedCode':
      emitFencedCode(build, entry)
      return
    case 'Table':
      emitTable(build, entry)
      return
    default:
      return
  }
}

function emitHeading(build: Build, entry: Collected, level: number): void {
  const doc = build.state.doc
  const firstLine = doc.lineAt(entry.from)
  if (!lineVisible(build, firstLine)) return

  // 字号/字重走**行装饰**（见 theme.ts 的说明：高亮的 tag 在内层，两层 em 会相乘）
  build.collection.add(firstLine.from, firstLine.from, Decoration.line({ class: mdHeadingClass(level) }))

  const setext = entry.name.startsWith('Setext')
  for (const mark of childrenNamed(entry.node, 'HeaderMark')) {
    const line = doc.lineAt(mark.from)
    if (cursorOnLine(build.state, mark.from)) continue // 光标在这一行：露出 `#` / `====`
    if (!lineVisible(build, line)) continue
    build.collection.replace(mark.from, mark.to, HIDDEN)
    if (setext) {
      // setext 的下划线整行只由 `====` 构成：不整行收起会留下一条空白行
      build.collection.add(line.from, line.from, Decoration.line({ class: MD.collapsedLine }))
    }
  }
}

function emitBlockquote(build: Build, entry: Collected): void {
  const doc = build.state.doc
  // 块覆盖到的行：**按节点范围取**，而不是按 `QuoteMark` 的个数。两种不听话的形状都真实存在：
  // `> 甲\n> 乙` 里第二行的 `>` 是 `Paragraph` 的孩子（同一个段落，软换行），
  // 懒续行（`> 甲\n乙`）干脆没有 `>` —— 而它们都属于这个引用块，观感上必须是同一个框。
  const firstLine = doc.lineAt(entry.from)
  const lastLine = doc.lineAt(Math.max(entry.from, entry.to - 1))
  const lines: number[] = []
  for (let number = firstLine.number; number <= lastLine.number; number += 1) lines.push(number)

  // 深度 = **这一层覆盖到的每一行**各加一：嵌套引用是嵌套的 Blockquote，两层都会覆盖内层那几行，
  // 于是内层行自然多一级（原先按 `QuoteMark` 数会在"续行的 `>` 藏在段落里"时少数一层）
  for (const number of lines) {
    build.quoteDepth.set(number, (build.quoteDepth.get(number) ?? 0) + 1)
  }

  for (const mark of quoteMarksOf(entry.node)) {
    const line = doc.lineAt(mark.from)
    if (cursorOnLine(build.state, mark.from)) continue
    if (!lineVisible(build, line)) continue
    build.collection.replace(mark.from, mark.to, HIDDEN)
  }

  const first = lines[0]
  const last = lines[lines.length - 1]
  if (first === undefined || last === undefined) return
  const markerLine = doc.line(first)
  if (!lineVisible(build, markerLine)) return

  // callout：判据只有一份（`domain/callouts.ts`），这里只负责"哪一行、标记在哪"
  const callout = readCallout(markerLine.text, markerLine.from)
  if (callout === null) return

  /*
   * 折叠（`[!note]-`）：正文行整行收起，直到光标（或选区）进入这一块。
   * 逐行挂零高类名，而不是"一个跨行的 replace" —— 后者在 ViewPlugin 里被直接禁止
   * （跨换行的替换装饰会抛 "Decorations that replace line breaks may not be specified via plugins"），
   * 与表格藏源码是同一个约束、同一个解法（见 emitTable 的第 3 条）。
   *
   * `collapsed` 要在挂位置之前算出来：收起时**标记行就是框的底边**（正文那些行零高藏起来，
   * 把圆角与下内边距挂在它们身上等于看不见），所以它是 `only` 而不是 `first`。
   */
  const collapsed = callout.fold === '-' && !selectionTouches(build.state, markerLine.from, lastLine.to)

  // 只有标记行时也是 `only`（光杆标题的提示框同样需要一个封闭的框）
  build.callouts.set(first, {
    callout,
    position: collapsed || first === last ? 'only' : 'first',
  })
  for (const number of lines) {
    if (number === first) continue
    // 内层 callout 后写、覆盖外层：一行上只能有一条左边框，显示**最内层**的那个框
    // （`> [!note] 外\n> > [!tip] 内` 的第二行是内层 callout 的标记行）
    build.callouts.set(number, { callout, position: number === last ? 'last' : 'middle' })
  }

  if (collapsed) {
    for (const number of lines) {
      if (number === first) continue
      const line = doc.line(number)
      build.collapsed.add(number)
      build.collection.add(line.from, line.from, Decoration.line({ class: MD.collapsedLine }))
    }
  }

  // 标记行：光标不在这一行时，`[!note]`（含折叠符）换成图标 widget；光标进入则**整行**露原文
  if (!cursorOnLine(build.state, first)) emitCalloutMarker(build, callout, markerLine)
}

/**
 * 引用块**这一层**的 `QuoteMark`。
 *
 * 必须递归：续行的 `>` 长在 `Paragraph` 里（见 `emitBlockquote` 的说明），只找直接孩子会漏掉
 * 除首行以外的**所有** `>`（真实踩过：多行引用只有第一行被隐藏，第二行还挂着原文的 `>`）。
 * 但**不进**内层 `Blockquote`：那些标记属于内层自己那一次遍历，两层各算各的，
 * 深度才能在 `quoteDepth` 里正确累加。
 */
function quoteMarksOf(node: SyntaxNodeLike): SyntaxNodeLike[] {
  const result: SyntaxNodeLike[] = []
  const walk = (parent: SyntaxNodeLike): void => {
    for (let child = parent.firstChild; child !== null; child = child.nextSibling) {
      if (child.name === 'Blockquote') continue
      if (child.name === 'QuoteMark') {
        result.push(child)
        continue
      }
      walk(child)
    }
  }
  walk(node)
  return result
}

/**
 * 把 `[!note]` 换成图标 widget，并给标记行剩下的标题文字上色加粗。
 *
 * 只替换**标记本身**：标题是用户写的正文，让它继续当文档里的真文字 —— 于是"编辑器的 DOM 文本
 * 等于文档源码"这条前提在这一处也成立（唯一的例外是表格，理由见 `table.css`）。
 */
function emitCalloutMarker(build: Build, callout: LiveCallout, line: { from: number; to: number }): void {
  build.collection.replace(
    callout.markerFrom,
    callout.markerTo,
    Decoration.replace({
      widget: new CalloutMarkerWidget(
        callout.glyph,
        callout.label,
        !callout.hasTitle,
        callout.fold,
        callout.markerTo,
      ),
    }),
  )

  // 标记与标题之间的空白不算标题（否则加粗会从空格开始，观感上像是缩进了一格）
  let titleFrom = callout.markerTo
  const doc = build.state.doc
  while (titleFrom < line.to && /\s/u.test(doc.sliceString(titleFrom, titleFrom + 1))) titleFrom += 1
  if (titleFrom < line.to) {
    build.collection.add(titleFrom, line.to, Decoration.mark({ class: MD.calloutTitle }))
  }
}

/** 引用行的行装饰：左侧竖线 + 淡色；多级再缩进一级；callout 行换成自己的类名（见 callout.ts）。 */
function emitQuoteLines(build: Build): void {
  const doc = build.state.doc
  for (const [number, depth] of build.quoteDepth) {
    const line = doc.line(number)
    if (!lineVisible(build, line)) continue
    // 被折叠的正文行已经有了"零高"的行装饰，再叠一层行类名没有意义
    if (build.collapsed.has(number)) continue
    const callout = build.callouts.get(number)
    if (callout !== undefined) {
      build.collection.add(
        line.from,
        line.from,
        Decoration.line({ class: calloutLineClass(callout.callout, depth, callout.position) }),
      )
      continue
    }
    const classes = depth > 1 ? `${MD.quote} ${MD.quoteNested}` : MD.quote
    build.collection.add(line.from, line.from, Decoration.line({ class: classes }))
  }
}

/**
 * 列表标记：把 `-` / `*` / `+` 换成项目符号、把 `1.` 换成**算出来的**序号。
 *
 * 三件事写在这里，改之前先读：
 *
 * 1. **整段替换，而不是给原文挂类名**。这里曾经只是给标记区间挂一个淡色（"标记是结构"），
 *    结果就是用户看到的那一幕：实时渲染里的列表符号"没有被渲染"，只是源码里的 `-` 被染淡了。
 *    项目符号与序号在**文档里根本不存在**，只能由 widget 画出来（见 `ListMarkWidget`）。
 * 2. **有序序号按"第一项写的数 + 第几项"算**，而不是照抄源码里的数字：源码写
 *    `1. 1. 1.` 要显示成 `1. 2. 3.`，写 `3.` 开头的要显示 `3. 4. 5.` ——
 *    这与阅读视图完全一致（markdown-it 只把起始值写进 `<ol start>`，浏览器按项递增）。
 *    分隔符统一画 `.`：阅读视图里的 `<ol>` 也是浏览器画的十进制点号。
 * 3. **任务项（`- [ ] x`）本函数一概不管**（照旧只把标记让给复选框）。任务项的语义是
 *    "待办"，它的标记已经由 `TaskCheckboxWidget` 承担；再画一个项目符号是两套标记打架。
 */
function emitListMark(build: Build, entry: Collected): void {
  const doc = build.state.doc
  const line = doc.lineAt(entry.from)
  if (!lineVisible(build, line)) return

  const item = entry.node.parent
  const list = item === null ? null : item.parent
  const isTask = item !== null && item.getChild('Task') !== null
  if (isTask) {
    // 任务项：`- ` 让位给复选框（复选框由 emitTaskMarker 负责）
    if (cursorOnLine(build.state, entry.from)) return
    build.collection.replace(entry.from, entry.to, HIDDEN)
    return
  }

  // 光标在这一行（或选中了这一行）：不给 widget，**整行**露原文。
  // 这一条对本层是通用的（见文件头的说明），对列表尤其必要：标记本身就是要编辑的东西
  // （`-` ↔ `1.`、改层级），藏起来等于不让人改。
  if (cursorOnLine(build.state, entry.from)) return

  let text: string
  let minWidthCh: number | null
  if (list !== null && list.name === 'OrderedList') {
    const numbering = orderedNumbering(build, list)
    // 兜底取源码里的数字：正常情况下编号表里一定有这一项（同一个列表的标记不会凭空出现）
    const number =
      numbering.numbers.get(entry.from) ?? parseOrderedStart(doc.sliceString(entry.from, entry.to))
    text = `${number}.`
    minWidthCh = numbering.widthCh
  } else {
    // 层级只数**列表祖先**：引用块里的列表仍然是一层（引用有自己的竖线，不参与列表层级）
    text = bulletGlyph(listDepth(entry.node))
    minWidthCh = null
  }

  build.collection.replace(
    entry.from,
    entry.to,
    Decoration.replace({ widget: new ListMarkWidget(text, minWidthCh) }),
  )
}

/** 项目符号：一层 `•`、二层 `◦`、三层及以上 `▪`（再深也不换字形，靠缩进区分层级）。 */
const BULLETS = ['•', '◦', '▪'] as const

function bulletGlyph(depth: number): string {
  const index = Math.min(Math.max(depth, 1), BULLETS.length) - 1
  return BULLETS[index] ?? '•'
}

/**
 * 列表的嵌套层级（最外层是 1）：数祖先里有几个 `BulletList` / `OrderedList`。
 *
 * 从 `ListMark` 往上数就够：`ListMark → ListItem → BulletList/OrderedList → …`，
 * 嵌套列表是**内层 ListItem 的孩子**，于是内层的标记自然多一个列表祖先。
 */
function listDepth(node: SyntaxNodeLike): number {
  let depth = 0
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (parent.name === 'BulletList' || parent.name === 'OrderedList') depth += 1
  }
  return depth
}

/** 一个有序列表的编号（见 {@link orderedNumbering}）。 */
interface ListNumbering {
  /**
   * 序号栏的宽度（单位 `ch`）。
   *
   * 取这个列表里**最宽**的那个序号，于是列表内每一项的序号栏一样宽 —— 这正是
   * "正文左边界齐平"的前提（只右对齐、栏宽还随内容变，`9.` 与 `10.` 的内容照样错开）。
   */
  widthCh: number
  /**
   * `ListMark` 起点 → 显示序号。
   *
   * 键用**位置**而不是节点对象：`SyntaxNode` 是语法树上的游标视图，同一个节点在不同时刻
   * 取到的对象不保证是全等的，拿它当键会静默失配（表现就是"偶尔又退回源码里的数字"）。
   */
  numbers: Map<number, number>
}

/**
 * 算出一个有序列表的显示序号。
 *
 * 只走**这个列表自己的孩子**（`ListItem`，数量与该列表的项数同阶）：`ListMark` 的坐标
 * 是现成的，不需要为了拿编号而解析一遍文档 —— 那会把"装饰只按视口算"（O(可视)）变成 O(全文)。
 * 同一个列表在一次重算里只算一次，因此整篇的代价是 O(视口内出现过的列表的项数之和)。
 */
function orderedNumbering(build: Build, list: SyntaxNodeLike): ListNumbering {
  const cached = build.listNumbering.get(list.from)
  if (cached !== undefined) return cached

  const doc = build.state.doc
  const numbers = new Map<number, number>()
  let start = 1
  let count = 0
  for (let item = list.firstChild; item !== null; item = item.nextSibling) {
    if (item.name !== 'ListItem') continue
    const mark = item.firstChild
    if (mark === null || mark.name !== 'ListMark') continue
    // 起始值只有**第一项**说了算；之后一律按"第几项"递增（理由见 emitListMark 第 2 条）
    if (count === 0) start = parseOrderedStart(doc.sliceString(mark.from, mark.to))
    count += 1
    numbers.set(mark.from, start + count - 1)
  }

  const numbering: ListNumbering = {
    numbers,
    // `count` 为 0 只可能出现在"树被截断、一个 ListItem 都没读到"的极端情况：
    // 那时按一位数字给宽度，至少不会画出一个比内容窄的栏
    widthCh: String(start + Math.max(count, 1) - 1).length + 1,
  }
  build.listNumbering.set(list.from, numbering)
  return numbering
}

/**
 * 有序列表标记里的起始序号（`3.` → 3、`0.` → 0）；读不出数字时按 CommonMark 的默认值 1。
 *
 * 为什么不读 `OrderedList` 的属性：`@lezer/markdown`（1.7）把起始值只喂给了上下文的 hash
 * （`CompositeBlock.value`），**没有**挂成 `NodeProp`，节点上取不到。
 * 于是退回"第一项的 `ListMark` 文本"——它就在同一棵树里，坐标现成。
 */
function parseOrderedStart(mark: string): number {
  const digits = /^(\d{1,9})/u.exec(mark)?.[1]
  if (digits === undefined) return 1
  const value = Number(digits)
  // `0.` 是合法的起始值（CommonMark 允许从 0 起算），所以判据是 `>= 0` 而不是 `> 0`
  return Number.isInteger(value) && value >= 0 ? value : 1
}

function emitTaskMarker(build: Build, entry: Collected): void {
  const doc = build.state.doc
  const line = doc.lineAt(entry.from)
  if (!lineVisible(build, line)) return

  const checked = /\[[xX]\]/.test(doc.sliceString(entry.from, entry.to))

  // 光标在这一行：保持 `- [ ]` 原文（可编辑；勾选后也会立刻看到文本变化）
  if (cursorOnLine(build.state, entry.from)) return

  build.collection.replace(
    entry.from,
    entry.to,
    Decoration.replace({ widget: new TaskCheckboxWidget(checked, entry.from) }),
  )
  build.collection.add(
    line.from,
    line.from,
    Decoration.line({ class: checked ? `${MD.task} ${MD.taskDone}` : MD.task }),
  )
  // 已完成：给**文字**加删除线。只圈标记之后的区间 —— 挂在行上会把复选框里的 ✓ 一起划掉，
  // 而 `text-decoration` 的传播无法被子元素豁免（详见 theme.ts 的 MD.taskDoneText）
  if (checked && entry.to < line.to) {
    build.collection.add(entry.to, line.to, Decoration.mark({ class: MD.taskDoneText }))
  }
}

function emitHorizontalRule(build: Build, entry: Collected): void {
  const doc = build.state.doc
  const line = doc.lineAt(entry.from)
  if (!lineVisible(build, line)) return

  // 光标在这一行：露原文（`---` 也好改）
  if (cursorOnLine(build.state, entry.from)) return

  build.collection.replace(entry.from, entry.to, Decoration.replace({ widget: new HorizontalRuleWidget() }))
  build.collection.add(line.from, line.from, Decoration.line({ class: MD.hrLine }))
}

function emitFencedCode(build: Build, entry: Collected): void {
  const doc = build.state.doc
  // `to` 是开区间：减 1 才不会在"节点正好结束在行首"时多算一行
  const endLine = doc.lineAt(Math.max(entry.from, entry.to - 1))
  const marks = childrenNamed(entry.node, 'CodeMark')
  const opening = marks[0]
  const closing = marks.length > 1 ? marks[marks.length - 1] : undefined

  const openingLine = opening === undefined ? doc.lineAt(entry.from) : doc.lineAt(opening.from)
  const closingLine = closing === undefined ? null : doc.lineAt(closing.from)
  const bodyFirst = openingLine.number + 1
  const bodyLast = closingLine === null ? endLine.number : closingLine.number - 1

  for (let number = bodyFirst; number <= bodyLast; number += 1) {
    const line = doc.line(number)
    if (!lineVisible(build, line)) continue
    const classes: string[] = [MD.codeLine]
    if (number === bodyFirst) classes.push(MD.codeLineFirst)
    if (number === bodyLast) classes.push(MD.codeLineLast)
    build.collection.add(line.from, line.from, Decoration.line({ class: classes.join(' ') }))
  }

  // 围栏行：光标不在时整行收起（含 ``` 与语言标记），避免代码块上下多出两条空白行
  for (const fenceLine of [openingLine, closingLine]) {
    if (fenceLine === null) continue
    if (cursorOnLine(build.state, fenceLine.from)) continue
    if (!lineVisible(build, fenceLine)) continue
    build.collection.replace(fenceLine.from, fenceLine.to, HIDDEN)
    build.collection.add(fenceLine.from, fenceLine.from, Decoration.line({ class: MD.collapsedLine }))
  }
}

// ---------------------------------------------------------------------------
// 表格
// ---------------------------------------------------------------------------

/**
 * GFM 表格：光标不在这一块里时整块渲染成真表格，光标（或选区）进入时整块露原文。
 *
 * 三处取舍写在这里，改之前先读：
 *
 * 1. **判据是"整块"**：一张渲染出来的表是一个 `<table>`，列宽由所有行共享 ——
 *    "只露光标那一行"在结构上做不到（那要拆成"每行一张小表"，列宽就不再共享，竖线全对不上），
 *    而且会让行高/列宽随光标上下移动反复跳动，读者的视线每次都要重新找位置。
 *    所以这里与标题/加粗是同一条纪律（进入即露原文），只是粒度从"一行/一个范围"放大到"一整块"，
 *    做法与 Obsidian 一致：进则整块原样。
 * 2. **整块接管（`claim`）**：块内的行内语法（`**粗体**`、`[[链接]]`、`![[图.png]]`）不再产出
 *    Live Preview 的行内装饰。渲染态它们本来就看不见（源码被 CSS 藏起来，见第 3 条）；
 *    露原文时用户要看的正是**原样的 Markdown**（连 `[[ ]]` 都在，也就不需要原子区间去挡光标）。
 *    单元格里的行内语法由**渲染管线**负责（`renderTableHtml` → `domain/markdown.ts`），
 *    不在这里再实现一套。
 * 3. **藏源码用 CSS（`display: none`）而不是 `Decoration.replace`**（本模块唯一一处例外）：
 *    ViewPlugin **不允许** replace 跨越换行 —— CodeMirror 会直接抛
 *    "Decorations that replace line breaks may not be specified via plugins"，而一块表最少也是
 *    两三行。逐行 replace 当然能绕开这条限制，但那样源码就从 DOM 里消失了，而
 *    "编辑器的 DOM 文本 == 文档源码"是既有工具与用例的前提（完整理由见 `table.css`）。
 *    于是改为：每一行整行文字挂一个 `display: none` 的 mark，表格 widget 挂在块首。
 */
function emitTable(build: Build, entry: Collected): void {
  const doc = build.state.doc
  // 整块都在视口外：什么都不做（与其它块级一致 —— widget 的真实高度只有浏览器知道，
  // 为视口外的东西算 DOM 是纯粹的浪费）
  if (!visible(build, entry.from, entry.to)) return
  if (inFrontmatter(build, entry.from)) return
  // 引用块 / 列表项里的表格：原样显示（理由见 table.ts 的 isNestedTable）
  if (isNestedTable(entry.node)) return

  // `to` 是开区间：减 1 才不会在"节点正好结束在行首"时多算一行（与 emitFencedCode 同一处理）
  const firstLine = doc.lineAt(entry.from)
  const lastLine = doc.lineAt(Math.max(entry.from, entry.to - 1))
  const source = doc.sliceString(firstLine.from, lastLine.to)
  if (!tableSourceWithinLimits(lastLine.number - firstLine.number + 1, source)) return

  // 先接管：接下来无论是渲染还是露原文，块内都不该再有行内装饰（理由见函数头第 2 条）
  build.collection.claim(firstLine.from, lastLine.to)

  // 光标 / 选区落在块内：整块露原文（一个装饰都不挂）。
  // 这一条刻意排在渲染**之前**：正在表格里打字是最热的那条路径，而这时根本不需要 widget ——
  // 少掉的是一次 markdown-it + DOMPurify（实测单张表约 1ms），按键路径上不值得付
  if (selectionTouches(build.state, firstLine.from, lastLine.to)) return

  const html = renderTableHtml(source, (src) => resolveTableImage(build, src))
  // 渲染管线不认它是一张表（列数不齐、只解析出前半截…）：原样显示，绝不自己猜一个表格出来
  if (html === null) return

  for (let number = firstLine.number; number <= lastLine.number; number += 1) {
    const line = doc.line(number)
    build.collection.add(line.from, line.to, Decoration.mark({ class: MD.tableSource }))
  }

  // widget 挂在块首（`side: -1` = 排在同一位置上的文本之前）。它自身是块级外观
  // （`.mn-md-table` 的 `display: block`）：被藏起来的源码行不占高度，于是整张表出现在第一行的位置上
  build.collection.add(
    firstLine.from,
    firstLine.from,
    Decoration.widget({
      widget: new TableWidget(html, tableLinks(build, source)),
      side: -1,
    }),
  )
}

/**
 * 单元格里的图片：与行内图片**同一条**解析链（`![[图.png]]` 的裸文件名要靠全库索引兜底）。
 *
 * 必须先 `resolveAsset` 再查授权缓存：`domain/markdown.ts` 交给我们的是源码里那个**原始**地址
 * （可能是裸文件名），而授权缓存与宿主按 Vault 相对路径记账 —— 顺序反了就会拿裸文件名当相对路径
 * 去请求，永远拿不到授权（表现是"行内图片好好的，表格里的图一直是占位"）。
 */
function resolveTableImage(build: Build, src: string): ImageResolution {
  const rel = resolveAsset(build, src)
  return rel === null ? { kind: 'placeholder' } : build.context.resolveImage(rel)
}

/**
 * 表格源码里的 wikilink 解析结果（widget 据此给渲染出来的 `<a>` 补上点击标记）。
 *
 * 为什么在装饰层算、而不是让 widget 自己去查 store：这里已经拿着"当前笔记的出链"这份快照，
 * 与行内 wikilink 走的是**同一个** `resolveOutbound`（含同一套 `normalizeLinkTarget` 口径）。
 * 两处各查一次，迟早会出现"行内链接点得开、表格里的点不开"这种漂移。
 */
function tableLinks(build: Build, source: string): TableWidgetLink[] {
  const links: TableWidgetLink[] = []
  const seen = new Set<string>()
  for (const match of source.matchAll(WIKILINK_PATTERN)) {
    const inner = match[2] ?? ''
    if (inner.trim() === '') continue
    const offset = match.index ?? 0
    // 转义的 `\[[x]]` 不是链接（与宿主链接抽取、与行内装饰同一口径）
    if (offset > 0 && source[offset - 1] === '\\') continue
    const parts = splitWikilink(inner)
    if (parts.target === '') continue
    const key = normalizeLinkTarget(parts.target)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    const resolved = resolveOutbound(build, parts.target)
    links.push({
      // 与 `domain/markdown.ts` 渲染出来的 `data-target` 逐字相同（两边都是 `splitWikilink` 的结果）
      target: parts.target,
      resolvedRelPath: resolved?.resolvedRelPath ?? null,
      ambiguous: resolved?.ambiguous === true,
    })
  }
  return links
}

// ---------------------------------------------------------------------------
// wikilink / 嵌入
// ---------------------------------------------------------------------------

function emitWikilinks(build: Build): void {
  const doc = build.state.doc
  if (doc.length === 0) return

  for (const range of build.visible) {
    if (range.to <= range.from) continue
    const first = doc.lineAt(range.from).number
    const last = doc.lineAt(Math.min(range.to, doc.length)).number
    for (let number = first; number <= last; number += 1) {
      const line = doc.line(number)
      // frontmatter 是元数据：里面的 `[[…]]` 不该变成可点的链接（宿主也不从那里抽链接）
      if (inFrontmatter(build, line.from)) continue
      const text = line.text
      // 折叠起来的 callout 正文：行内的链接 / 图片 / 粗体都不该再产出装饰（理由见 Build.collapsed）
      if (collapsedAt(build, line.from)) continue
      // `matchAll` 会克隆正则，不会污染模块级 `lastIndex`
      for (const match of text.matchAll(WIKILINK_PATTERN)) {
        const offset = match.index ?? 0
        const from = line.from + offset
        const to = from + match[0].length
        const inner = match[2] ?? ''
        if (inner.trim() === '') continue
        // 转义的 `\[[x]]` 不是链接（宿主侧链接抽取也是这个口径）
        if (offset > 0 && text[offset - 1] === '\\') continue
        if (overlaps(build.codeRanges, from, to)) continue
        if (build.collection.isClaimed(from, to)) continue
        emitWikilink(build, { from, to, inner, embed: match[1] === '!' })
      }
    }
  }
}

function emitWikilink(build: Build, match: WikiMatch): void {
  const doc = build.state.doc
  const innerStart = match.from + (match.embed ? 3 : 2) // 跳过 `[[` / `![[`
  const parts = splitWikilink(match.inner)
  const pipeIndex = match.inner.indexOf('|')
  const target = parts.target
  if (target === '' && parts.alias === null) return

  // `![[图.png]]`：与 `![](图.png)` 用同一套渲染（光标不在该行时才换成 widget）
  if (match.embed) {
    const rel = resolveAsset(build, target)
    // 分流按**扩展名**（与宿主白名单逐字一致）：`![[别的笔记]]` 不是图片 → 退回 wikilink 渲染
    if (isImageAssetTarget(rel ?? target)) {
      // 别名是**尺寸**时（`![[图.png|300]]`，Obsidian 约定）不当图注：尺寸交给 widget，
      // 图注退回到文件名 —— 与预览层（`domain/markdown.ts`）同一套判据，两处不能各判一套
      const size = parseImageSize(parts.alias)
      const alt = size === null ? (parts.alias ?? '') : ''
      emitImage(build, match.from, match.to, target, alt, rel, size)
      return
    }
  }

  // 展示范围：有别名就显示别名（并把"目标 + `|`"一并藏掉），否则显示目标本身
  const aliased = parts.alias !== null && pipeIndex !== -1
  let displayFrom = aliased ? innerStart + pipeIndex + 1 : innerStart
  const displayTo = match.to - 2 // `]]` 之前
  while (displayFrom < displayTo && doc.sliceString(displayFrom, displayFrom + 1) === ' ') {
    displayFrom += 1
  }

  const resolved = resolveOutbound(build, target)
  const resolvedRel = resolved?.resolvedRelPath ?? null
  const classes: string[] = [MD.link, MD.wikilink]
  if (resolvedRel === null) classes.push(MD.wikilinkUnresolved)
  if (resolved?.ambiguous === true) classes.push(MD.wikilinkAmbiguous)

  if (displayTo > displayFrom) {
    build.collection.add(
      displayFrom,
      displayTo,
      Decoration.mark({
        class: classes.join(' '),
        attributes: {
          [WIKILINK_ATTR]: target,
          [WIKILINK_RESOLVED_ATTR]: resolvedRel ?? '',
          title:
            resolvedRel === null
              ? `${target}（还不存在，点击创建）`
              : `${resolvedRel}（Alt+点击可编辑）`,
        },
      }),
    )
  }

  // 光标/选区落在链接里：整段露出 `[[ ]]`，方便改目标
  if (selectionTouches(build.state, match.from, match.to)) return

  // 隐藏 `![[` / `[[`
  if (innerStart > match.from) build.collection.replace(match.from, innerStart, HIDDEN)
  // 隐藏"目标 + `|`"（有别名时），以及 `]]`
  if (aliased) build.collection.replace(innerStart, displayFrom, HIDDEN)
  build.collection.replace(displayTo, match.to, HIDDEN)

  // 锚点（`#小节` / `^块`）不隐藏但降调：它是链接的一部分，只是不是"读的时候要看的东西"
  if (!aliased) {
    const anchorAt = anchorOffset(match.inner)
    if (anchorAt !== -1) {
      build.collection.add(
        displayFrom + anchorAt,
        displayTo,
        Decoration.mark({ class: MD.linkAnchor }),
      )
    }
  }
}

// ---------------------------------------------------------------------------
// frontmatter
// ---------------------------------------------------------------------------

/**
 * 文档开头的 frontmatter 区块（1 起、闭区间行号）；没有则 `null`。
 *
 * 为什么装饰层要单独处理它：lezer 不认识 frontmatter，`---\n键: 值\n---` 会被解析成
 * `HorizontalRule` + **`SetextHeading2`**（最后一行的 `---` 恰好是 setext 下划线）——
 * 照规则渲染出来就是"一条横线 + 一个巨大的加粗标题"，与预览（先剥掉 frontmatter）
 * 完全对不上。它是元数据（属性面板已经展示），所以这里只做**淡色**，不做语法渲染。
 *
 * 判定复用 `domain/frontmatter.frontmatterRegion`（与预览、与 Rust 同一口径），
 * 但只把它喂给文档开头的**一小段**：整篇 `doc.toString() + split` 是 O(全文)，
 * 而装饰必须保持 O(可视)。超长（> 200 行）的"疑似 frontmatter"按普通正文处理 —— 宁可原样显示。
 */
function frontmatterLines(state: EditorState): { first: number; last: number } | null {
  const doc = state.doc
  const head = doc.line(1).text.replace(/^\u{feff}/u, '').trimEnd()
  if (head !== '---') return null

  const limit = Math.min(doc.lines, FRONTMATTER_SCAN_LINES)
  const region = frontmatterRegion(doc.sliceString(0, doc.line(limit).to))
  if (region === null) return null
  return { first: region.startLine + 1, last: Math.min(region.endLine + 1, limit) }
}

function inFrontmatter(build: Build, pos: number): boolean {  const region = build.frontmatter
  if (region === null) return false
  const line = build.state.doc.lineAt(Math.min(Math.max(pos, 0), build.state.doc.length)).number
  return line >= region.first && line <= region.last
}

/** frontmatter 行的淡色装饰（内容原样显示，只是"退到背景里"）。 */
function emitFrontmatterLines(build: Build): void {
  const region = build.frontmatter
  if (region === null) return
  const doc = build.state.doc
  for (let number = region.first; number <= region.last; number += 1) {
    const line = doc.line(number)
    if (!lineVisible(build, line)) continue
    build.collection.add(line.from, line.from, Decoration.line({ class: MD.frontmatter }))
  }
}

// ---------------------------------------------------------------------------
// 行内
// ---------------------------------------------------------------------------

function emitInline(build: Build, entry: Collected): void {
  // 已被外层规则接管（例如 `![[图]]` 整体换成了 widget）：内部节点不再单独处理
  if (build.collection.isClaimed(entry.from, entry.to)) return
  if (!visible(build, entry.from, entry.to)) return
  if (inFrontmatter(build, entry.from)) return
  if (collapsedAt(build, entry.from)) return

  switch (entry.name) {
    case 'StrongEmphasis':
      emitWrapped(build, entry, MD.strong, 'EmphasisMark')
      return
    case 'Emphasis':
      emitWrapped(build, entry, MD.emphasis, 'EmphasisMark')
      return
    case 'Strikethrough':
      emitWrapped(build, entry, MD.strike, 'StrikethroughMark')
      return
    case 'InlineCode':
      emitWrapped(build, entry, MD.code, 'CodeMark')
      return
    case 'Link':
      emitLink(build, entry)
      return
    case 'Image':
      emitImageNode(build, entry)
      return
    default:
      return
  }
}

/**
 * 首尾成对标记的行内语法（粗体 / 斜体 / 删除线 / 行内代码）：
 * 内容加样式，标记只在**光标不在范围内**时隐藏。
 */
function emitWrapped(build: Build, entry: Collected, className: string, markName: string): void {
  const marks = childrenNamed(entry.node, markName)
  const content = contentRange(entry.from, entry.to, marks)
  if (content !== null) {
    build.collection.add(content.from, content.to, Decoration.mark({ class: className }))
  }
  if (selectionTouches(build.state, entry.from, entry.to)) return
  for (const mark of marks) {
    if (!lineVisible(build, build.state.doc.lineAt(mark.from))) continue
    build.collection.replace(mark.from, mark.to, HIDDEN)
  }
}

function emitLink(build: Build, entry: Collected): void {
  const doc = build.state.doc
  const url = entry.node.getChild('URL')
  // 引用式链接（`[文字][引用]`）与自动链接（`<http://…>`）保持原样，见报告里的"未做"
  if (url === null) return

  const href = doc.sliceString(url.from, url.to)
  const marks = childrenNamed(entry.node, 'LinkMark')
  const content = contentRange(entry.from, entry.to, marks)

  if (content !== null) {
    build.collection.add(
      content.from,
      content.to,
      Decoration.mark({ class: MD.link, attributes: { [LINK_ATTR]: href } }),
    )
  }
  if (selectionTouches(build.state, entry.from, entry.to)) return

  // 隐藏 `[` 与 `](地址)`，留下可读的链接文字
  const contentFrom = content?.from ?? entry.from
  const contentTo = content?.to ?? entry.from
  build.collection.replace(entry.from, contentFrom, HIDDEN)
  build.collection.replace(contentTo, entry.to, HIDDEN)
}

function emitImageNode(build: Build, entry: Collected): void {
  const doc = build.state.doc
  const url = entry.node.getChild('URL')
  if (url === null) return

  const href = doc.sliceString(url.from, url.to)
  const marks = childrenNamed(entry.node, 'LinkMark')
  const content = contentRange(entry.from, entry.to, marks)
  const alt = content === null ? '' : doc.sliceString(content.from, content.to)
  emitImage(build, entry.from, entry.to, href, alt, resolveAsset(build, href))
}

/**
 * 资源地址 → Vault 相对路径。
 *
 * `domain/assets.ts` 的 `createAssetResolver` 带全库索引：Obsidian 用户写的裸文件名
 * `![[图.png]]` 即使不在当前目录也能命中（同名的多张按"路径更短 → 字典序"）。
 * 带路径的写法**不做**全库兜底（越界的 `../图.png` 必须老老实实失败）。
 */
function resolveAsset(build: Build, href: string): string | null {
  const noteRelPath = build.context.noteRelPath
  return noteRelPath === null ? null : build.context.resolveAsset(noteRelPath, href)
}

/**
 * 图片：**光标不在该行时**整段换成 widget。
 *
 * 授权（asset 协议）是异步的，所以这里只读缓存：
 * - 已授权 → 真的 `<img>`；
 * - 未授权 / 解析失败（外部地址、越界、非图片扩展名）/ 浏览器预览模式 → 等宽占位文本，
 *   并且**只在路径能解析时才登记授权请求**（越界路径绝不该走到 IPC）。
 *
 * `rel` 由调用方解析好传进来（`![[…]]` 要先知道它到底是不是图片才能分流），
 * 但**授权登记**只发生在视口内、且光标不在该行的图片上。
 *
 * 呈现上图片是**块级**的（`theme.ts` 里 `display: block`）：它会独占一行，
 * 而不是像以前那样把所在行的行高撑得忽大忽小。这一点**不改变**"光标进入即露原文"——
 * 光标一旦落到这一行，整个 widget（连同下面那条行装饰）都会被撤掉，露出 `![说明](路径)`。
 */
function emitImage(
  build: Build,
  from: number,
  to: number,
  href: string,
  alt: string,
  rel: string | null,
  size: ImageSize | null = null,
): void {
  const line = build.state.doc.lineAt(from)
  // 视口外：不产出装饰，也不登记授权请求（"只请求当前屏里出现过的图片"）
  if (!lineVisible(build, line)) return
  // 光标在这张图所在行：露原文（`![说明](路径)` / `![[图.png]]`），方便改路径
  if (cursorOnLine(build.state, from)) return

  const resolution = rel === null ? { kind: 'placeholder' as const } : build.context.resolveImage(rel)

  build.collection.replace(
    from,
    to,
    Decoration.replace({
      widget: new ImageWidget(
        resolution.kind === 'ready' ? resolution.url : null,
        rel ?? href,
        alt,
        size,
      ),
    }),
  )

  // 整行只有这一张图（其余只有空白）→ 挂"图片行"类名，收掉行盒自己的行距。
  // 行内还有文字时不挂：那种行会被块级元素拆成"文字 / 图片 / 文字"，文字行仍需正常行高。
  if (isWholeLine(build, line, from, to)) {
    build.collection.add(line.from, line.from, Decoration.line({ class: MD.imageLine }))
  }
}

/** `from..to` 之外的部分只有空白（即这一行是"图片行"）。 */
function isWholeLine(
  build: Build,
  line: { from: number; to: number },
  from: number,
  to: number,
): boolean {
  const doc = build.state.doc
  return (
    isBlankSlice(doc.sliceString(line.from, from)) && isBlankSlice(doc.sliceString(to, line.to))
  )
}

function isBlankSlice(text: string): boolean {
  return /^[ \t]*$/u.test(text)
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 选区（含折叠光标）与 `from..to` 是否相交 —— Live Preview "露出原文"的判据。 */
function selectionTouches(state: EditorState, from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    if (range.to >= from && range.from <= to) return true
  }
  return false
}

/** 光标/选区是否落在某一行上（块级元素的判据）。 */
function cursorOnLine(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(Math.min(Math.max(pos, 0), state.doc.length))
  return selectionTouches(state, line.from, line.to)
}

function lineVisible(build: Build, line: { from: number; to: number }): boolean {
  return visible(build, line.from, line.to)
}

/** 位置所在的行是否属于"被折叠起来的 callout 正文"（见 {@link Build.collapsed}）。 */
function collapsedAt(build: Build, pos: number): boolean {
  if (build.collapsed.size === 0) return false
  const doc = build.state.doc
  if (doc.length === 0) return false
  return build.collapsed.has(doc.lineAt(Math.min(Math.max(pos, 0), doc.length)).number)
}

function visible(build: Build, from: number, to: number): boolean {
  return overlaps(build.visible, from, to)
}

function overlaps(ranges: readonly VisibleRange[], from: number, to: number): boolean {
  return ranges.some((range) => range.from <= to && range.to >= from)
}

function childrenNamed(node: SyntaxNodeLike, name: string): SyntaxNodeLike[] {
  const result: SyntaxNodeLike[] = []
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    if (child.name === name) result.push(child)
  }
  return result
}

/**
 * 去掉首尾标记之后的内容范围。
 *
 * 只取**前两个**标记：`[文字](地址)` 这类节点有四个 LinkMark（`[`、`]`、`(`、`)`），
 * 取最后一个当"收尾标记"会把 `](地址` 也算进内容里（真实踩过：链接文字变成"文字](地址"）。
 */
function contentRange(
  from: number,
  to: number,
  marks: readonly SyntaxNodeLike[],
): VisibleRange | null {
  const open = marks[0]
  const close = marks.length >= 2 ? marks[1] : undefined
  const start = open === undefined ? from : open.to
  const end = close === undefined ? to : close.from
  return end > start ? { from: start, to: end } : null
}

/** 锚点 `#小节` / `^块` 在内部文本里的偏移（找不到返回 -1）。 */
function anchorOffset(inner: string): number {
  const hash = inner.indexOf('#')
  const caret = inner.indexOf('^')
  if (hash === -1) return caret
  if (caret === -1) return hash
  return Math.min(hash, caret)
}

/**
 * 出链匹配：与预览面板**同一套口径**（`normalizeLinkTarget` 比 `rawTarget`）。
 * 链接的权威解析在宿主（`mn-index`），前端只负责把结果贴回来。
 */
function resolveOutbound(build: Build, rawTarget: string): ResolvedLink | null {
  const key = normalizeLinkTarget(rawTarget)
  if (key === '') return null
  return build.context.outbound.find((link) => normalizeLinkTarget(link.rawTarget) === key) ?? null
}
