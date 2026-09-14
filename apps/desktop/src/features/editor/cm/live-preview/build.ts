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
import type { LivePreviewContext, LivePreviewDecorationResult, VisibleRange } from './types'
import { HorizontalRuleWidget, ImageWidget, TaskCheckboxWidget } from './widgets'

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
   * 每行的引用深度（行号 → `>` 个数）。
   *
   * 必须**跨节点**累加：嵌套引用是嵌套的 Blockquote，各自只看得见自己那一层的 `>`，
   * 只按单个节点数就会把 `> > 乙` 当成一级引用。
   */
  quoteDepth: Map<number, number>
  /** 文档开头的 frontmatter 行区间（1 起、闭区间）；那里的 Markdown 语法不渲染。 */
  frontmatter: { first: number; last: number } | null
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
    frontmatter: frontmatterLines(state),
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
  const marks = childrenNamed(entry.node, 'QuoteMark')

  for (const mark of marks) {
    const line = doc.lineAt(mark.from)
    // 深度是**跨节点**累加的（见 Build.quoteDepth）：嵌套引用是嵌套的 Blockquote
    build.quoteDepth.set(line.number, (build.quoteDepth.get(line.number) ?? 0) + 1)

    if (cursorOnLine(build.state, mark.from)) continue
    if (!lineVisible(build, line)) continue
    build.collection.replace(mark.from, mark.to, HIDDEN)
  }
}

/** 引用行的行装饰：左侧竖线 + 淡色；多级再缩进一级。 */
function emitQuoteLines(build: Build): void {
  const doc = build.state.doc
  for (const [number, depth] of build.quoteDepth) {
    const line = doc.line(number)
    if (!lineVisible(build, line)) continue
    const classes = depth > 1 ? `${MD.quote} ${MD.quoteNested}` : MD.quote
    build.collection.add(line.from, line.from, Decoration.line({ class: classes }))
  }
}

function emitListMark(build: Build, entry: Collected): void {
  const doc = build.state.doc
  const line = doc.lineAt(entry.from)
  if (!lineVisible(build, line)) return

  const parent = entry.node.parent
  const isTask = parent !== null && parent.getChild('Task') !== null
  if (!isTask) {
    // 普通列表：符号**退让**（淡色）而不是隐藏 —— 它是结构，不是语法噪音
    build.collection.add(entry.from, entry.to, Decoration.mark({ class: MD.listMark }))
    return
  }

  // 任务项：`- ` 让位给复选框（复选框由 emitTaskMarker 负责）
  if (cursorOnLine(build.state, entry.from)) return
  build.collection.replace(entry.from, entry.to, HIDDEN)
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

function inFrontmatter(build: Build, pos: number): boolean {
  const region = build.frontmatter
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
