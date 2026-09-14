/**
 * 知识图谱画布 —— **换行与高度**（纯函数：不 import React、不碰 DOM、不测量，测量函数由调用方注入）。
 *
 * 这一层回答两个问题，且只回答这两个：
 * 1. "这段文字在**卡片内容宽度**下折成几行、每行是哪些 run"；
 * 2. "这个块占多高"。
 *
 * 得到的 `LaidOutBlock[]` 就是画笔的绘制清单：`y` 从 0 开始，`y += height + gapAfter` 依次排下去，
 * 每一行的 `runs` 直接喂给 `fillText`（字体用 `fontOfRun(fontFor(block, metrics), run)`，
 * 与这里量宽时用的是**同一个**字体标识 —— 见下方"为什么字体标识要由本层给出"）。
 *
 * ## 为什么测量要注入，而不是在这里 `ctx.measureText`
 *
 * 1. **可测**：换行算法是整个"画布排版"里最容易出错的一段（CJK 逐字、超长词硬断、行内代码换字体），
 *    它必须能在 vitest 里用假测量逐字断言（见 `tests/graph-text-layout.test.ts`）。
 *    在 node 环境里 `canvas.measureText` 根本不存在，一旦写死就没法测。
 * 2. **不持有画布**：持有 `CanvasRenderingContext2D` 会顺带持有"字号是从哪个元素上读的"这类状态，
 *    而知识图谱是 1 万个节点规模的数据 —— 清单必须能脱离画布算出来（也才能在将来丢进 Worker）。
 *
 * ## 为什么字体标识（`FontSpec`）由本层给出
 *
 * 换行与绘制**必须**用同一个字体量/画：只要两边的字号或粗体判定差一点（比如这层忘了标题是粗体），
 * 就会出现"量出来正好放下、画出来溢出卡片"的错位，而那种错位在小卡片上极其显眼、又极难归因。
 * 所以 `fontFor`/`fontOfRun` 在这里导出，画笔只管把它翻成 canvas 的 `font` 字符串。
 *
 * ## 单位与缩进
 *
 * 一切都是**像素**，`metrics.width` 是"已经扣掉卡片内边距"的内容宽度（本层不关心卡片本身有多大）。
 * `indent` 是块内容的左偏移；列表项与引用还要再空出一个**符号留白**（项目符号 / 竖线），
 * 所以它们的可用文字宽度是 `width - indent - markerWidth`，画笔把符号画在 `x = indent`、
 * 把文字画在 `x = indent + markerWidth`（`markerWidth` 在 metrics 里，只有一个真源）。
 *
 * ## 提示框怎么画（`LaidOutBlock.callout` + `children`）
 *
 * 1. 在 `(x, y, callout.width, height)` 描一个圆角盒；左边缘内侧画一条
 *    `metrics.calloutBarWidth` 宽的类型色竖条，颜色取 `block.accent` 那个令牌
 *    （竖条落在内边距里，与文字不重叠，所以不需要额外的留白）；
 * 2. `lines`（标题行，已经含字形与折叠角标）画在 `x + metrics.calloutPadding`、
 *    `y + metrics.calloutPadding`，行高 `lineHeightFor(block, metrics)`；
 * 3. `children` 依次画在 `x + metrics.calloutPadding + child.indent`、
 *    `y + callout.bodyTop` 起按 `y += child.height + child.gapAfter` 累加 ——
 *    与顶层块**同一套**走法（`totalHeight(children)` 与这里的累加结果必然相等）。
 */

import {
  sameRunStyle,
  type CalloutBlock,
  type DrawBlock,
  type InlineRun,
  type TableAlign,
} from './blocks'

/** 字体标识（画笔那边会把它翻成 canvas 的 font 字符串）。 */
export interface FontSpec {
  size: number
  bold?: boolean
  italic?: boolean
  code?: boolean
}

/** 测量一段文字在某个字体下的宽度（测试里注入假实现，生产里用 canvas measureText）。 */
export type MeasureText = (text: string, font: FontSpec) => number

export interface LaidOutLine {
  runs: InlineRun[]
  /** 这一行的宽度 = 行内各 run 量出来的宽度之和（不含行首/行尾空白）。 */
  width: number
}

/** 表格单元格的换行结果。 */
export interface LaidOutTableCell {
  /** 单元格文字在列宽内折行后的结果（空单元格是空数组）。 */
  lines: LaidOutLine[]
  /** 这一列的对齐方式（画笔按它决定每行从列的哪一端起画）。 */
  align: TableAlign
  /** 单元格可用宽度 = 列宽 - 2 × `tableCellPadding`。 */
  width: number
}

/** 表格的几何结果（见 `layoutBlocks` 里关于"为什么表格要在这层算完"的说明）。 */
export interface LaidOutTable {
  /** 每列宽度（px），与 `block.aligns` 等长同序。 */
  columnWidths: number[]
  /** 表头行（与 `DrawBlock.table.header` 同形，GFM 实际只有一行）。 */
  headerRows: LaidOutTableCell[][]
  /** 数据行；每行都补齐到列数（短行补空单元格），画笔不必再判越界。 */
  rows: LaidOutTableCell[][]
  /** 每行高度（表头在前）= 该行最高的单元格行数 × 行高。 */
  rowHeights: number[]
}

/** 提示框容器的几何结果（画笔描边框、画左侧类型色竖条、摆正文用）。 */
export interface LaidOutCallout {
  /** 容器盒子的宽度（= 本块的可用宽度；画笔按 `(块原点 x, y, width, height)` 描这个盒子）。 */
  width: number
  /** 标题行占的高度（标题可能折成多行）。 */
  titleHeight: number
  /**
   * 正文（`children`）相对块顶部的偏移 = 内边距 + 标题高 +（有正文时的块间距）。
   *
   * 给出来是因为画笔要**按块累加**地摆子块，而这个偏移里含了"标题折了几行"这种
   * 只有排版知道的事实 —— 让画笔自己算就等于把换行结果再推一遍。
   */
  bodyTop: number
}

export interface LaidOutBlock {
  block: DrawBlock
  /** 块的换行结果；代码块按**原样**返回（一行一条，不折行），图片/分隔线/表格为空数组。 */
  lines: LaidOutLine[]
  /** 块自身的高度（不含 `gapAfter`）。提示框的高度**含**它的子块与容器内边距。 */
  height: number
  /** 内容左偏移（列表按 `depth`、引用按 `depth`）。 */
  indent: number
  /**
   * 这个块**下面**留的间距（= `metrics.blockGap`）。
   *
   * 为什么不放在 `totalHeight(layout, metrics)` 的第二个参数里：`totalHeight` 的签名只有 `layout`
   * 一个入参，让它去猜间距就会与"排版时真正用的那份 metrics"分家 —— 而卡片总高与块的排布必须同源，
   * 否则会出现"卡片高度按 8px 算、块按 4px 排"的错位（多出来/少掉的空隙最后表现为卡片底部被裁掉）。
   * 烙在块上之后，画笔只要 `y += height + gapAfter` 就与 `totalHeight` 的结果天然一致。
   */
  gapAfter: number
  /** 图片块的**实际盒子**（已按可用宽度等比缩放）；只有 `block.kind === 'image'` 时存在。 */
  image?: { width: number; height: number }
  /** 表格的列宽/行高/单元格换行；只有 `block.kind === 'table'` 时存在。 */
  table?: LaidOutTable
  /**
   * 提示框正文的子块（已按容器内边距与正文内缩排好）；只有 `block.kind === 'callout'` 时存在。
   *
   * 子块用的是**同一份** `LaidOutBlock`：画笔画它们与画顶层块走完全一样的代码路径
   * （`y += child.height + child.gapAfter`），表/图/代码/嵌套提示框都天然支持 ——
   * 这也是"不要开第二套排版"的落地方式。
   */
  children?: LaidOutBlock[]
  /** 提示框的容器几何；只有 `block.kind === 'callout'` 时存在。 */
  callout?: LaidOutCallout
}

export interface LayoutMetrics {
  /** 卡片内容宽度（px，已扣掉内边距）。 */
  width: number
  /** 正文字号。 */
  fontSize: number
  /** 正文行高。 */
  lineHeight: number
  /** 块之间的间距。 */
  blockGap: number
  /** 各级标题的字号倍率（1.6 表示 1.6 倍正文字号）；行高同步放大（见 `lineHeightFor`）。 */
  headingScale: Record<1 | 2 | 3 | 4 | 5 | 6, number>
  /** 每层嵌套的缩进（列表按 `depth`、引用按 `depth`）。 */
  indentPerLevel: number
  /**
   * 列表项目符号 / 引用竖线占的横向留白。
   *
   * 为什么单独一个字段、而不是把它算进 `indent`：`indent` 的口径是"（嵌套层级 × 每级缩进）"，
   * 顶层块（depth 0）的铁定是 0；可顶层列表项的**符号**仍然要占地方。
   * 把符号留白拆出来之后，"文字从 `indent + markerWidth` 起画"和"换行按 `width - indent - markerWidth` 折"
   * 才是同一份预算 —— 否则文字会从 indent 处起画、却按更宽的宽度折行，右边一律溢出符号那么多。
   */
  markerWidth: number
  /** 代码块的行高（等宽字体一行占多少；代码不折行，所以只需要这个数）。 */
  codeLineHeight: number
  /** 表格列宽下限（再窄就只剩竖线了）。 */
  minColumnWidth: number
  /** 表格列宽上限（一列吃掉整张卡片的宽度会让其它列挤成一条）。 */
  maxColumnWidth: number
  /** 单元格左右内边距（列宽里要先扣掉它才是文字可用宽度）。 */
  tableCellPadding: number
  /**
   * 提示框容器的内边距（四边统一）。
   *
   * 与 CSS 的 `padding: 6px 14px 2px` 不逐字对应：画布上容器的左右留白由"内边距 + 正文内缩"
   * 两笔构成（见 `calloutBodyInset`），四边统一之后上下留白正好与 `blockGap` 同量级 ——
   * 也就是"容器上下留出与段落间距相称的留白"。
   */
  calloutPadding: number
  /** 提示框左侧类型色竖条的宽度（对应 CSS 的 `border-left: 3px`）。 */
  calloutBarWidth: number
  /** 提示框正文相对容器内容区**再**内缩的量（左右各一份）。 */
  calloutBodyInset: number
  /** 每级嵌套提示框的缩进量。 */
  calloutIndentPerLevel: number
  /**
   * 嵌套提示框最多缩进的层级（再深就停在这一档）。
   *
   * 为什么要有上限：每多一层嵌套就同时多两笔横向开销（本层缩进 + 容器内边距），
   * 手写五层嵌套的那种笔记在 260px 宽的卡片上会把正文挤成一条竖线。
   * 上限管的是**本层缩进**这一笔；容器内边距是"画一个盒子"必须付的成本，不在其中
   * （见 `layoutOne` 的 callout 分支里关于"深度从哪来"的注释）。
   */
  calloutMaxDepth: number
}

/**
 * 默认几何参数。
 *
 * 这些数字**只有这里一份**：画笔、布局、将来图谱里"卡片该开多大"都读它。
 * 数值按 "卡片内容宽约 260px" 调过（正文 13px / 行高 19px，与阅读视图的正文观感接近），
 * 但本层不假设卡片一定这么大 —— 换一套 `LayoutMetrics` 就能给别的场景排版。
 */
export const DEFAULT_METRICS: LayoutMetrics = {
  width: 260,
  fontSize: 13,
  lineHeight: 19,
  blockGap: 8,
  headingScale: { 1: 1.6, 2: 1.4, 3: 1.2, 4: 1.1, 5: 1.05, 6: 1 },
  indentPerLevel: 14,
  markerWidth: 14,
  codeLineHeight: 16,
  minColumnWidth: 36,
  maxColumnWidth: 200,
  tableCellPadding: 6,
  calloutPadding: 8,
  calloutBarWidth: 3,
  calloutBodyInset: 8,
  calloutIndentPerLevel: 8,
  calloutMaxDepth: 2,
}

/** 只有宽度、没有高度时假设的宽高比（高 = 宽 × 它）。多数截图在 1.4~1.6 之间，取 1/1.5。 */
const DEFAULT_IMAGE_ASPECT = 0.66

// ---------------------------------------------------------------------------
// 字体 / 行高 / 缩进：画笔与排版共用的三个判据
// ---------------------------------------------------------------------------

/**
 * 块的基础字体。
 *
 * 标题**默认粗体**（阅读视图里 `h1~h6` 也是粗的）：这不是装饰，而是"量宽与绘制同源"的要求 ——
 * 若这里给正常体、画笔按粗体画，标题就有可能在右边溢出几个字。
 */
export function fontFor(block: DrawBlock, metrics: LayoutMetrics): FontSpec {
  switch (block.kind) {
    case 'heading': {
      return { size: metrics.fontSize * metrics.headingScale[block.level], bold: true }
    }
    case 'code': {
      return { size: metrics.fontSize, code: true }
    }
    default: {
      return { size: metrics.fontSize }
    }
  }
}

/**
 * 把基础字体叠上 run 自己的标志。
 *
 * 叠加方向是"**只多不少**"：标题（基础粗体）里的一段斜体应当是"粗 + 斜"，
 * 与阅读视图里 `<h1><em>` 的观感一致。行内代码不改字号 —— 等宽字体在天生更宽/更窄，
 * 由 `MeasureText` 去体现（假测量里刻意给等宽加宽，正是为了钉住"换行按 run 逐段累加"这件事）。
 */
export function fontOfRun(base: FontSpec, run: InlineRun): FontSpec {
  return {
    size: base.size,
    bold: run.bold === true || base.bold === true,
    italic: run.italic === true || base.italic === true,
    code: run.code === true || base.code === true,
  }
}

/** 块的行高：标题随字号一起放大，代码用等宽行高，其余是正文行高。 */
export function lineHeightFor(block: DrawBlock, metrics: LayoutMetrics): number {
  switch (block.kind) {
    case 'heading': {
      return metrics.lineHeight * metrics.headingScale[block.level]
    }
    case 'code': {
      return metrics.codeLineHeight
    }
    default: {
      return metrics.lineHeight
    }
  }
}

/**
 * 内容左偏移 = （层级 × 每级缩进）。
 *
 * 只有可能被嵌套的三种块有层级：列表项、引用、提示框。标题/代码/表格/分隔线即使写在列表项
 * 或引用**内部**，也按顶层块画（`DrawBlock` 里它们没有 `depth` 字段）—— 这是刻意的：
 * 为极罕见的嵌套写法给每种块都塞一个 depth，会让整份清单和画笔都要多判一次，
 * 而收益只是那几行不缩进。
 *
 * 提示框的层级**封顶**（`calloutMaxDepth`）：每多一层嵌套就同时多两笔横向开销
 * （本层缩进 + 容器内边距），不封顶的话五层嵌套在 260px 宽的卡片上会把正文挤成一条竖线。
 */
export function indentFor(block: DrawBlock, metrics: LayoutMetrics): number {
  switch (block.kind) {
    case 'list-item':
    case 'quote': {
      return Math.max(0, block.depth) * metrics.indentPerLevel
    }
    case 'callout': {
      const level = Math.min(Math.max(0, block.depth), metrics.calloutMaxDepth)
      return level * metrics.calloutIndentPerLevel
    }
    default: {
      return 0
    }
  }
}

/** 这个块是否需要为"符号"（项目符号 / 引用竖线）留出 `markerWidth`。 */
function markerGutter(block: DrawBlock, metrics: LayoutMetrics): number {
  return block.kind === 'list-item' || block.kind === 'quote' ? metrics.markerWidth : 0
}

/**
 * 提示框的标题行：`字形 + 标题`（写了折叠符再来一个角标）。
 *
 * 三件事的观感对着 app.css 的 `.mn-callout__title` / `__icon` / `__label` / `__fold`：
 * 它们都是强调色、都是半粗的，所以这里**一条 bold run** 就够，不额外标注等宽或行内代码
 * （`code: true` 在画笔那边意味着"等宽 + 背景色"，拿它表示字形会在图标后面画出一个底色方块）。
 *
 * 字形与标题之间的间隔用一个空格近似：CSS 的 `gap: 7px` 是"两个盒子之间的距离"，
 * 而画布这边的契约是"一条文字 run" —— 要精确复现就得给 run 之间发明一套间距机制，
 * 那比多半个角标字符的误差贵得多。
 */
function calloutTitleRuns(block: CalloutBlock): InlineRun[] {
  const fold = block.fold === null ? '' : ` ${block.fold}`
  return [{ text: `${block.glyph} ${block.title}${fold}`, bold: true }]
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 绘制块清单 → 每块的换行与高度。
 *
 * 表格、图片与提示框**都在这层算完**（各自产出一个几何结果），而不是留给画笔：
 * 它们的"占多高"取决于宽度预算（一列放多宽、图片缩到多少、正文还剩多少横向空间），
 * 而宽度预算正是本层的输入。若留给画笔，就会出现两份列宽/内缩算法（一份算高度、一份画格子），
 * 迟早算出不一样的表格或者撑破盒子的正文。
 */
export function layoutBlocks(
  blocks: readonly DrawBlock[],
  metrics: LayoutMetrics,
  measure: MeasureText,
): LaidOutBlock[] {
  return layoutWithin(blocks, metrics, measure, Math.max(1, metrics.width), 0)
}

/**
 * 在一个容器里排一批块。
 *
 * `width` 是这批块拿到的**可用宽度**（父容器的内容区宽度），`inset` 是它们相对该内容区
 * 的左内缩（提示框正文那一笔）。两者分开传而不是并成一个"内容宽度"，是因为右边界必须由
 * 二者一起决定：块的左边界 = 内容区左 + inset + 块自己的缩进，右边界恒为内容区右 ——
 * 只传一个数就得在每处再推一遍另一个。
 */
function layoutWithin(
  blocks: readonly DrawBlock[],
  metrics: LayoutMetrics,
  measure: MeasureText,
  width: number,
  inset: number,
): LaidOutBlock[] {
  return blocks.map((block) => layoutOne(block, metrics, measure, width, inset))
}

/**
 * 整份清单的总高（含块间距）。
 *
 * 间距取的是每个块自带的 `gapAfter`（见 `LaidOutBlock.gapAfter` 的说明），最后一块之后不加 ——
 * 卡片底部因此天然是最后一行文字的下沿，不会多出一条"看不见的尾巴"。
 */
export function totalHeight(layout: readonly LaidOutBlock[]): number {
  let total = 0
  layout.forEach((item, index) => {
    total += item.height
    if (index < layout.length - 1) total += item.gapAfter
  })
  return total
}

function layoutOne(
  block: DrawBlock,
  metrics: LayoutMetrics,
  measure: MeasureText,
  width: number,
  inset: number,
): LaidOutBlock {
  // `inset` 是容器给的（提示框正文），`indentFor` 是块类型自己的（列表/引用的层级）——
  // 两者相加才是内容的左偏移。上限夹在 `width - 1`：嵌套得再深也要留 1px 给文字，
  // 否则会出现零宽（甚至负宽）的正文，那种块画出来是一片空白却占着高度。
  const indent = Math.min(inset + indentFor(block, metrics), Math.max(0, width - 1))
  const contentWidth = Math.max(1, width - indent)
  const gapAfter = metrics.blockGap

  switch (block.kind) {
    case 'code': {
      const font = fontFor(block, metrics)
      // 代码**不折行**：折行会改变缩进与视觉结构（一行 YAML/JSON 折成两行就不再是同一份东西了），
      // 超出部分交给画笔裁切/省略号。这里只给出每行的宽度，画笔据此判断"要不要画省略号"。
      const lines: LaidOutLine[] = block.lines.map((text) => ({
        runs: text === '' ? [] : [{ text, code: true }],
        width: measure(text, font),
      }))
      const height = Math.max(1, lines.length) * metrics.codeLineHeight
      return { block, lines, height, indent, gapAfter }
    }

    case 'image': {
      const box = imageBox(block, contentWidth, metrics)
      return { block, lines: [], height: box.height, indent, gapAfter, image: box }
    }

    case 'hr': {
      // 零高度的分隔线会和上下两块贴在一起，看不出它是一条线；给它一行的高度，
      // 画笔在这一行里居中画横线（线宽用 contentWidth）。
      return { block, lines: [], height: metrics.lineHeight, indent, gapAfter }
    }

    case 'table': {
      const table = layoutTable(block, metrics, measure, contentWidth)
      const height = table.rowHeights.reduce((sum, value) => sum + value, 0)
      return { block, lines: [], height, indent, gapAfter, table }
    }

    case 'callout': {
      const padding = metrics.calloutPadding
      // 深度来自块自己（**不是**递归层数）：`> [!tip] A` 里再嵌一层引用时，内层提示框
      // 在块清单上是外层提示框的子块，递归层数确实会 +1；但"提示框套在普通引用里"
      // （`> > [!tip] B`）时它在清单上是**平级**的（普通引用不装子块），只有令牌流知道
      // 它深了几层 —— 所以深度在 `blocks.ts` 里定，`indentFor` 只负责按它缩进并封顶。
      const boxWidth = contentWidth
      const innerWidth = Math.max(1, boxWidth - padding * 2)

      const lines = wrapRuns(calloutTitleRuns(block), innerWidth, fontFor(block, metrics), measure)
      const titleHeight = Math.max(1, lines.length) * metrics.lineHeight

      // 正文：同一套 `layoutWithin`，所以段落/列表/代码/表格/图片/嵌套提示框全都自然支持。
      // 左右各内缩 `calloutBodyInset`，与阅读视图里正文比标题窄一点的观感对应。
      const children = layoutWithin(
        block.children,
        metrics,
        measure,
        innerWidth,
        metrics.calloutBodyInset,
      )
      // 子块之间的间距用它们各自的 `gapAfter`，正好由 `totalHeight` 一次算完 ——
      // 于是"容器高度 = 内边距 + 标题 + 子块之和 + 子块间距"与画笔累加子块的结果必然一致。
      // 标题与正文之间那一笔间距只在真有正文时才占位（空提示框不该多出一条空隙）。
      const bodyGap = children.length === 0 ? 0 : metrics.blockGap
      const bodyTop = padding + titleHeight + bodyGap
      const height = padding * 2 + titleHeight + bodyGap + totalHeight(children)

      return {
        block,
        lines,
        height,
        indent,
        gapAfter,
        children,
        callout: { width: boxWidth, titleHeight, bodyTop },
      }
    }

    default: {
      const font = fontFor(block, metrics)
      const lineHeight = lineHeightFor(block, metrics)
      const available = Math.max(1, contentWidth - markerGutter(block, metrics))
      const lines = wrapRuns(block.runs, available, font, measure)
      // 至少占一行：文字为空但块存在的场合（比如只有勾选框的任务项）不能是零高度，
      // 否则它会和下一块叠在同一行上。
      return {
        block,
        lines,
        height: Math.max(1, lines.length) * lineHeight,
        indent,
        gapAfter,
      }
    }
  }
}

/**
 * 图片的盒子：按可用宽度等比缩放。
 *
 * 三种输入对应三种精度（顺序即优先级）：
 * - 宽高都有（`![[图.png|300x200]]`）：等比缩到放得下，最准；
 * - 只有宽（`![[图.png|300]]`，阅读视图里由浏览器按原图比例缩放）：高按 `DEFAULT_IMAGE_ASPECT` 估；
 * - 都没有：给一个保守的占位盒（4 行正文高）。
 *
 * 为什么宁可**估**也不返回"等图片解码后再算"：整份清单的高度是累加出来的，任何一个块悄悄变高，
 * 它下面所有块的位置都要重排 —— 那会让卡片在图片陆续解码时不停地跳。宁可一开始就不太准。
 */
function imageBox(
  block: Extract<DrawBlock, { kind: 'image' }>,
  available: number,
  metrics: LayoutMetrics,
): { width: number; height: number } {
  if (block.width !== null && block.height !== null) {
    const scale = Math.min(1, available / block.width)
    return { width: block.width * scale, height: block.height * scale }
  }
  if (block.width !== null) {
    const width = Math.min(block.width, available)
    return { width, height: width * DEFAULT_IMAGE_ASPECT }
  }
  return { width: available, height: metrics.lineHeight * 4 }
}

// ---------------------------------------------------------------------------
// 表格
// ---------------------------------------------------------------------------

/**
 * 表格：列宽 + 每格折行 + 每行高度。
 *
 * 列宽算法（"内容优先，再向可用宽度收敛"）：
 * 1. 每列的**自然宽度** = 该列所有单元格（含表头）整段量出来的最大值；
 * 2. 自然宽度夹进 `[minColumnWidth, maxColumnWidth]`——窄列至少能放下一个汉字加内边距，
 *    宽列不吞掉整张卡片（一列占满会把其它列挤成一条竖线）；
 * 3. 总宽超过可用宽度：按比例等比收缩；**收缩后仍超**（每列都撞到下限）就等分 ——
 *    画布上放不下就是放不下，宁可每列都窄也不让表格横向溢出卡片；
 * 4. 总宽不足可用宽度：把余量**平均**补给每列（窄表格铺满内容宽度，与阅读视图里
 *    `table { width: 100% }` 的观感一致，也不会在卡片右侧留下一块奇怪的空白）。
 *
 * 为什么不等分宽度就完事：等分会让"一列是 `#`、一列是长句子"的两列一样宽 ——
 * 短列浪费、长列频繁折行，而表格的可读性几乎全靠列宽分配。
 */
function layoutTable(
  block: Extract<DrawBlock, { kind: 'table' }>,
  metrics: LayoutMetrics,
  measure: MeasureText,
  available: number,
): LaidOutTable {
  const columnCount = tableColumnCount(block)
  if (columnCount === 0) {
    return { columnWidths: [], headerRows: [], rows: [], rowHeights: [] }
  }

  const baseFont: FontSpec = { size: metrics.fontSize }
  const headerFont: FontSpec = { size: metrics.fontSize, bold: true }

  const natural: number[] = []
  for (let column = 0; column < columnCount; column += 1) {
    let widest = 0
    for (const row of block.header) {
      widest = Math.max(widest, measure(row[column] ?? '', headerFont))
    }
    for (const row of block.rows) {
      widest = Math.max(widest, measure(row[column] ?? '', baseFont))
    }
    natural.push(widest)
  }

  const widths = distributeColumns(natural, metrics, available)
  const cellWidth = (column: number): number =>
    Math.max(1, (widths[column] ?? available) - metrics.tableCellPadding * 2)

  const headerRows = block.header.length > 0 ? block.header : [[]]
  const bodyRows = block.rows

  const layoutRow = (cells: readonly string[], isHeader: boolean): LaidOutTableCell[] => {
    const out: LaidOutTableCell[] = []
    for (let column = 0; column < columnCount; column += 1) {
      const text = cells[column] ?? ''
      const run: InlineRun = isHeader ? { text, bold: true } : { text }
      const usable = cellWidth(column)
      out.push({
        // 表头单元格的 run 标 `bold`，与 `headerFont` 是同一件事 —— 量宽与绘制必须同一个字体
        lines: text === '' ? [] : wrapRuns([run], usable, baseFont, measure),
        align: block.aligns[column] ?? 'left',
        width: usable,
      })
    }
    return out
  }

  const laidOutHeader = headerRows.map((row) => layoutRow(row, true))
  const rows = bodyRows.map((row) => layoutRow(row, false))

  const headerRowHeight = (cells: readonly LaidOutTableCell[]): number =>
    Math.max(1, ...cells.map((cell) => cell.lines.length)) * metrics.lineHeight
  const rowHeights = [...laidOutHeader, ...rows].map(headerRowHeight)

  return { columnWidths: widths, headerRows: laidOutHeader, rows, rowHeights }
}

/** 列数：以对齐数组为准，同时兜住"数据行比表头更长"的脏数据。 */
function tableColumnCount(block: Extract<DrawBlock, { kind: 'table' }>): number {
  let count = block.aligns.length
  for (const row of block.header) count = Math.max(count, row.length)
  for (const row of block.rows) count = Math.max(count, row.length)
  return count
}

function distributeColumns(
  natural: readonly number[],
  metrics: LayoutMetrics,
  available: number,
): number[] {
  const count = natural.length
  if (count === 0) return []

  const clamped = natural.map((value) =>
    Math.min(metrics.maxColumnWidth, Math.max(metrics.minColumnWidth, value)),
  )
  const total = clamped.reduce((sum, value) => sum + value, 0)

  if (total > available) {
    // 按比例收缩后各列之和**正好**等于可用宽度，所以"逐列 `max(下限, 按比例)`"一定会让总宽超出卡片
    // （表格横向溢出）。收缩必须整体判定：只要有一列会被压到下限之下，就整体退到等分 ——
    // 宁可每列一样窄，也不让表格出界。等分仍可能低于下限，那说明列数太多、卡片本来就放不下，
    // 此时"一样窄"是最可预期的降级。
    const ratio = available / total
    if (clamped.every((value) => value * ratio >= metrics.minColumnWidth - COLUMN_EPSILON)) {
      return clamped.map((value) => value * ratio)
    }
    return new Array<number>(count).fill(available / count)
  }

  // 有余量：平均补给每列（窄表格铺满内容宽度，与阅读视图里 `table { width: 100% }` 的观感一致）
  const extra = (available - total) / count
  return clamped.map((value) => value + extra)
}

/** 浮点比较的容差：`x * (available / total)` 的和常常落在可用宽度上下一个 ulp，不该因此改变分支。 */
const COLUMN_EPSILON = 1e-6

// ---------------------------------------------------------------------------
// 换行
// ---------------------------------------------------------------------------

/** 拆行时最小的单元：一个词、一个汉字、一个标点，或一段空白。 */
interface Atom {
  text: string
  font: FontSpec
  /** 归属的 run（合并回行时要靠它还原样式）。 */
  run: InlineRun
  /** 空白：行首丢弃、行尾不占宽。 */
  space: boolean
  /** 强制换行（run 文本里的 `\n`，来自 `hardbreak`）。 */
  br: boolean
  /** 缓存量出来的宽度：同一个原子会被反复比较，而 canvas 的 `measureText` 并不便宜。 */
  width: number
}

/**
 * 把一组 run 折成若干行。
 *
 * 断行规则（两类文字、两种口径，混排时按**字符**依次判定，所以"中文里夹英文单词"两边都对）：
 * - **西文按词**：拉丁字母/数字/下划线（以及撇号）连成一个整体，不在词中间断 ——
 *   除非**单个词本身就比整行宽**（长 URL、长哈希），那时才逐字符硬断（否则它会永远溢出卡片）。
 * - **其它按字符**：CJK 没有空格，逐字符累加到超宽才断。
 *
 * 已知的简化（写出来是为了将来要精细时知道从哪改）：**不做避头尾（禁则）** ——
 * 行首可能落到 `，`、`。`、`)` 上。要做对需要一张"不能出现在行首/行尾"的字符表，
 * 而画布上的行宽本来就会被卡片裁切，先按纯宽度断行的收益/成本比更高。
 *
 * 连字符、斜杠这类字符算**独立原子**，因此 `well-known` 可以在连字符后断开 ——
 * 与浏览器的断行机会一致，代价是它可能被拆到两行（比"整词溢出才硬断"更接近阅读视图）。
 */
function wrapRuns(
  runs: readonly InlineRun[],
  available: number,
  base: FontSpec,
  measure: MeasureText,
): LaidOutLine[] {
  const atoms = atomize(runs, base, measure)
  const lines: LaidOutLine[] = []
  /** 已确定留在本行的原子。 */
  let kept: Atom[] = []
  /** 行尾待定的空白：后面还有原子放得下才算数（行尾空白不该占宽，也不该留在 run 文本里）。 */
  let pending: Atom[] = []
  let keptWidth = 0
  let pendingWidth = 0

  const flush = (): void => {
    lines.push(makeLine(kept, measure))
    kept = []
    pending = []
    keptWidth = 0
    pendingWidth = 0
  }

  for (let index = 0; index < atoms.length; index += 1) {
    const atom = atoms[index]
    if (atom === undefined) continue

    if (atom.br) {
      // 硬换行：即使本行还空着也要产出一行（连续两个硬换行 = 一个空行，
      // 直接丢弃会让用户在引用/列表里刻意留的间隔消失）
      flush()
      continue
    }

    if (atom.space) {
      if (kept.length === 0) continue // 行首空白不占位（否则每行都会莫名缩进一格）
      pending.push(atom)
      pendingWidth += atom.width
      continue
    }

    if (kept.length > 0 && keptWidth + pendingWidth + atom.width > available) {
      // 当前行放不下了：先把本行落地，再**回到这个原子重新判定** ——
      // 不能直接塞进新行：新行是空的，若这个原子本身超宽，还得走下面的硬断分支
      flush()
      index -= 1
      continue
    }

    if (kept.length === 0 && atom.width > available && atom.text.length > 1) {
      // 单个词比整行还宽：拆成单字符原子插回队列（`Array.from` 避免把代理对劈开），
      // 逐字符走同一套规则 —— 于是"硬断"不需要第二份实现
      const chars = Array.from(atom.text).map((char) =>
        makeAtom(char, atom.font, atom.run, false, measure),
      )
      atoms.splice(index, 1, ...chars)
      index -= 1
      continue
    }

    kept.push(...pending, atom)
    keptWidth += pendingWidth + atom.width
    pending = []
    pendingWidth = 0
  }

  // 末尾还有内容就落地；只剩 pending（行尾空白）则丢掉
  if (kept.length > 0) flush()
  return lines
}

function makeLine(atoms: readonly Atom[], measure: MeasureText): LaidOutLine {
  const runs: InlineRun[] = []
  let width = 0
  for (const atom of atoms) {
    const last = runs[runs.length - 1]
    // 同一行的相邻原子只要样式一致就合并回一条 run：清单更短，画笔也少切一次字体
    if (last !== undefined && sameRunStyle(last, atom.run)) last.text += atom.text
    else runs.push({ ...atom.run, text: atom.text })
    // 宽度按**原子**累加而不是事后 `measure(整行文本)`：等宽/粗体混排时逐段量才是真实宽度
    // （代价是与 canvas 的 kerning 有微小出入，而 kerning 在几百像素宽的卡片上可以忽略）
    width += measure(atom.text, atom.font)
  }
  return { runs, width }
}

/** run 串 → 原子串（run 文本里的 `\n` 变成强制换行原子）。 */
function atomize(runs: readonly InlineRun[], base: FontSpec, measure: MeasureText): Atom[] {
  const atoms: Atom[] = []
  for (const run of runs) {
    const font = fontOfRun(base, run)
    run.text.split('\n').forEach((piece, index) => {
      if (index > 0) atoms.push({ text: '', font, run, space: false, br: true, width: 0 })
      atoms.push(...atomizePiece(piece, font, run, measure))
    })
  }
  return atoms
}

function atomizePiece(text: string, font: FontSpec, run: InlineRun, measure: MeasureText): Atom[] {
  const atoms: Atom[] = []
  let word = ''

  const flushWord = (): void => {
    if (word === '') return
    atoms.push(makeAtom(word, font, run, false, measure))
    word = ''
  }

  for (const char of Array.from(text)) {
    // 制表符按一个空格算：markdown 里的对齐靠的是空白，画布上只关心"这里有个间隔"
    const ch = char === '\t' ? ' ' : char
    if (WORD_CHAR.test(ch)) {
      word += ch
      continue
    }
    flushWord()
    atoms.push(makeAtom(ch, font, run, ch === ' ', measure))
  }
  flushWord()
  return atoms
}

function makeAtom(
  text: string,
  font: FontSpec,
  run: InlineRun,
  space: boolean,
  measure: MeasureText,
): Atom {
  return { text, font, run, space, br: false, width: measure(text, font) }
}

/**
 * "不可断"的字符：拉丁字母、数字、下划线、撇号。
 *
 * `\p{Script=Latin}` 而不是 `[A-Za-z]`：带变音符号的欧洲语言（café、Straße）不该被逐字符拆开；
 * `\p{N}` 让 `abc123` 是一个词。**CJK 刻意不在其中** —— 汉字/假名没有空格，
 * 它们必须能逐字符断行，这正是 `wrapRuns` 两类口径的分界。
 */
const WORD_CHAR = /[\p{Script=Latin}\p{N}_'\u2019]/u
