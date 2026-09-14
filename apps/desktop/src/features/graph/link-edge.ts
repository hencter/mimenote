/**
 * 知识图谱 —— **连线从正文里那段 wiki link 文字处引出**。
 *
 * 用户的原话是："连接线不是凭空渲染在卡片边缘，需要通过虚线从对应的 wiki link 处到卡片边缘再转为实线。"
 * 卡片正面是**完整的笔记预览**，`[[甲]]` 那一段文字在卡片上有确切位置；一条边因此由两段组成：
 *
 * ```
 *        卡片 A（来源）                        卡片 B（目标）
 *   ┌──────────────────────┐
 *   │ 正文 …见 [[甲]] 与 … │                 ┌────────────┐
 *   │  ↑anchor             │                 │            │
 *   │  └┈┈┈┈┈exit          │  ~~~~~~~~~~~~~> │  entry     │
 *   └──────────────────────┘                 └────────────┘
 *      卡片内：虚线**直线**                     卡片外：实线**三次贝塞尔（张力曲线）**
 * ```
 *
 * ## 分界点（`exit`）是这一层的中心概念
 *
 * 用户的原话是"从 wiki 链接处虚线开始，卡片边缘处实线出连接到卡片"——两段的分界必须**正好在
 * 卡片边界那一点**上，所以本层给三条硬保证（都有测试钉住）：
 *
 * 1. `exit` 是"从 `anchor` 朝目标中心打射线"与**当前**卡片矩形的交点（`rayRectExit`），
 *    并贴回边界的精确数值 —— 卡片被拖动/改尺寸之后，它是新边界上的点；
 * 2. `leadPath` 的最后一个点与 `spanPath` 的第一个点**逐坐标相同**（都是 `exit`，都不取整）；
 * 3. 虚线的相位锚在 `exit` 那一端（见 `leadDash`）：最后一段实线正好在分界处收笔，
 *    不会在离卡边 1~3px 的地方断在空隙里。
 *
 * ## 这一层只消费排版结果，绝不自己重排
 *
 * `anchor` 的位置全部来自既有两处：
 * - `canvas/text-layout.ts` 的排版结果（每个块占多高、每行是哪些 run、run 的宽度就是画笔量出来的那个宽度）；
 * - `canvas/measure.ts` 的 `cardChrome(metrics)` 给出的正文起点（`padding` / `bodyTop`）。
 *
 * 任何一处自己算行高、自己猜内边距，都会让引线落在与文字错开几个像素的地方 —— 那正是这一层要修的毛病，
 * 所以宁可多 import 两个函数，也不在这里复述任何一个数字。
 *
 * ## 坐标口径（一对一，只有一套）
 *
 * - `findLinkAnchor` 的返回与 `cardLocalToWorld` 的入参是**卡片内坐标**：
 *   `x` 从卡片内容左边界（`rect.x + chrome.padding`）起算、`y` 从正文起点（`rect.y + chrome.bodyTop`）起算。
 * - 其余一切（`Rect` / `Point` / 两个路径的 `d`）都是**世界坐标**。
 * - **缩放不在这层出现**：与 `canvas/paint.ts` 一样，世界 → 屏幕的换算只在画笔里做一次。
 *
 * ## 为什么不用既有的 `edgeAnchors(from, to)`
 *
 * `layout.ts` 的 `edgeAnchors` 是按"两端中心的位移取主轴"来选边的（左右 or 上下），它服务的是
 * **中心对中心**的连线：起点在卡片边缘、方向大致是主轴方向，那个判据与它的形状是自洽的。
 * 一旦起点变成卡片里任意一个文字位置，主轴判据就可能选中一条**背对起点**的边（线会横穿目标卡片
 * 再绕回来）。所以这里换成"从起点朝对端中心打一条射线，取第一个交点"：
 * 交点天然面向对端，卡片怎么摆都不会穿。
 * （既有的 `buildEdgeVisuals` 继续用 `edgeAnchors` —— 那条路径没有文字锚点，两者不冲突。）
 *
 * ## 降级必须如实标注
 *
 * "找不到那段文字"不是异常，是常态（正文还没读到、卡片被截断、或者用户写的是
 * `[文字](路径.md)` 这种 Markdown 链接）。这时**不假装命中**：`fromLink = false`，
 * 引线退化成零长度、从卡片边界上朝目标的那一点出发。调用方据此可以换一种画法
 * （例如画成既有的边缘连线），而不是拿着一个错的 `anchor` 当真的用。
 */

import type { CardLayout } from './canvas/measure'
import { cardChrome } from './canvas/measure'
import type {
  FontSpec,
  LaidOutBlock,
  LaidOutLine,
  LayoutMetrics,
  MeasureText,
} from './canvas/text-layout'
import { DEFAULT_METRICS, fontFor, fontOfRun, lineHeightFor } from './canvas/text-layout'
import { centerOf, type Point, type Rect } from './layout'

/** 一条边在画布上的完整几何：卡片内的一段虚线引线 + 卡片外的一段张力曲线。 */
export interface LinkEdgeGeometry {
  /** 边在正文里对应的那段 wiki link 文字的**起点**（世界坐标，文字左侧、基线上）。 */
  anchor: Point
  /** 虚线引线的终点 = 卡片边界上的交点（世界坐标）。 */
  exit: Point
  /** 目标卡片边界上的入点（世界坐标）。 */
  entry: Point
  /** 卡片内那段（虚线）的 SVG path `d`。 */
  leadPath: string
  /** 卡片外那段（实线/张力曲线）的 SVG path `d`。 */
  spanPath: string
  /** 找没找到对应的 wiki link 文字：`false` = 退化成"从卡片边界出发"（见下面的降级规则）。 */
  fromLink: boolean
  /** 命中的文字（用于 tooltip / 调试）；没命中时是 `null`。 */
  matchedText: string | null
}

/**
 * 调用方不用传 `tension` 时的缺省张力。
 *
 * 0.35 ⇒ 控制点离弦 `0.35 × 0.25 = 8.75%` 的弦长。取值理由是两条界：
 * 低于 0.2 时"绷"得看不出来（与直线没区别，张力旋钮白给）；高于 0.6 时线会明显绕路，
 * 让读者以为中间还夹着一张卡片。0.35 在 400px 的跨度上鼓出约 35px，一眼能看出是曲线、
 * 又不会被误读成"绕过什么东西"。
 *
 * 刻意**不导出**：调用方要么自己定一个数（UI 上的旋钮），要么用这里这个缺省。
 * 导出常量会让人以为"这个数需要被同步"，而它其实只是"没人管的时候长什么样"。
 */
const DEFAULT_TENSION = 0.35

/** 张力 → 控制点偏离弦的系数（弦长的倍数）。0.25 是"看得见又不像绕路"的折中。 */
const TENSION_BULGE = 0.25

/**
 * 贴回容差（世界坐标像素）。
 *
 * 两处用它，都是为了"把浮点噪声挡在结果之外"：
 * 1. 求交时判断"这个参数还算正的"（`t <= 0` 的是回头解，`t = 1e-17` 的是数值噪声）；
 * 2. 把交点**贴回**边界的精确数值。`50 + 150 * (1/3)` 会算出 `100.00000000000001`，
 *    而"引线的终点正好在卡片边界上"这件事是**定义**，不是近似 —— 下游（裁剪判定、
 *    测试里的相等断言）都希望它就是 `100`。1e-9 远小于一个像素，不会掩盖真正的偏差。
 */
const EPSILON = 1e-9

/** 命中的一段 wiki link（`copies` 见 `repeatCount`：相邻同款链接会被 `blocks.ts` 合并成一条 run）。 */
interface RunMatch {
  /** 这一份链接的显示文字（合并 run 时是其中**一份**，例如 `甲甲` 里的一份是 `甲`）。 */
  key: string
  /** 这条 run 里含几份同样的链接（≥ 1）。 */
  copies: number
}

/** 归一化后的候选写法。 */
interface TargetText {
  /** 调用方给的原样（精确匹配用它，不做任何改动）。 */
  raw: string
  /** 归一化写法：去首尾空白、去 `.md`、小写（见 `normalizeLinkText`）。 */
  normalized: string
}

/** 卡片内的一个候选锚点（一份链接一个）。 */
interface AnchorCandidate {
  x: number
  y: number
  text: string
}

/**
 * 遍历时遇到的一段 wikilink run 的几何（**卡片内坐标**，口径与 `findLinkAnchor` 的返回一致）。
 *
 * 为什么把它做成独立的中间产物：`findLinkAnchor`（按目标文字找锚点）与 `linkZones`
 * （枚举全部 wikilink 的矩形，给"悬停高亮连线"做命中测试）走**同一套遍历与量宽** ——
 * 几何只有一份，两个功能才不会各自漂移（真实教训：这一层任何一处自己算行高/内边距，
 * 都会让引线落在与文字错开几个像素的地方）。
 */
interface WikiRunSpot {
  /** 文字左边界（相对卡片内容左边界）。 */
  x: number
  /** 行盒中线（相对正文起点）：画笔 `fillText` 的那条线（`textBaseline = 'middle'`）。 */
  centerY: number
  /** 行盒高度（热区的高度 = 整行可点，不只是字形本身）。 */
  height: number
  /** 这条 run 的像素宽度（与画笔逐段量宽同一来源）。 */
  width: number
  /** run 的字体（合并 run 拆份时量单份宽度要用，见 `findLinkAnchor`）。 */
  font: FontSpec
  /** run 所在的行（摊派估计需要它，见 `estimateAdvance`）。 */
  line: LaidOutLine
  text: string
  /** wikilink 的目标原文（`data-target`）；它是别名写法之外的另一条匹配线索。 */
  href: string | undefined
}

/** 一次遍历的上下文（访问者模式：几何在这里，"遇到一段 wikilink 做什么"由调用方给）。 */
interface WalkContext {
  metrics: LayoutMetrics
  measure: MeasureText | undefined
  visit: (spot: WikiRunSpot) => void
}

// ---------------------------------------------------------------------------
// 锚点：在排版结果里找"那段字"在哪
// ---------------------------------------------------------------------------

/**
 * 在卡片排版结果里找第 `occurrence` 个指向 `targets` 的 wiki link run，返回它在卡片内的位置。
 *
 * ## 返回值的口径
 *
 * `x` 是**文字左边界**（相对卡片内容左边界），`y` 是**画笔真正传给 `fillText` 的那条线**：
 * 相对正文起点、等于 `块顶 + 行号 × 行高 + 行高 / 2`。之所以是行盒中线而不是 CSS 意义上的
 * alphabetic baseline：`canvas/paint.ts` 画字用的是 `textBaseline = 'middle'`，
 * 它传给 `fillText` 的 y **就是**行盒中线 —— 锚点若取 alphabetic baseline，会比画出来的字
 * 低 3~4px，而这层引线往往只有十几像素长，4px 的偏差肉眼一眼就能看出"线没从字上出发"。
 *
 * ## `measure` 这个参数为什么在
 *
 * 排版结果 `LaidOutLine` 只记了**整行**的宽度，没有记每个 run 各自的宽度；而"这段字从哪开始"
 * 恰恰需要"它前面那些 run 有多宽"。要拿到这个数只有一条路：用**同一个**量宽函数、**同一个**字体
 * （`fontOfRun(fontFor(...))`）把前面的 run 再量一遍 —— 画笔逐段量宽用的就是这两个函数
 * （见 `paint.ts` 的 `drawRuns`），所以这里量出来的位置与画出来的位置逐像素一致。
 *
 * 不给 `measure` 也能用，但那时 `x` 是**按字符数摊派**的估计（`estimateAdvance`）：
 * 纯 CJK 的整行里每个字形等宽，摊派结果与真值相同；CJK 与拉丁混排时可能偏十几像素 ——
 * 这正是"引线看起来从旁边的字冒出来"的成因，所以生产路径**应当**把 `measure` 传进来。
 * `CardLayout` 本来就是用某个 `measure` 造出来的，调用方手里必然有它。
 *
 * ## `occurrence` 与顺序
 *
 * 候选按**阅读顺序**排（块 → 行 → run，提示框正文按容器内的顺序），`occurrence` 是 0 基下标。
 * 越界（调用方的槽位比实际链接数多 —— 上一次数据里 `count` 更大）时退回第 0 个而不是返回
 * `null`：把线画到第一个真实位置上，永远好过让它在卡片边缘凭空出现。
 */
export function findLinkAnchor(input: {
  layout: CardLayout
  /** 这条边可能对应的显示文字（原始目标写法、解析出来的文件名、别名…，见下面的匹配规则）。 */
  targets: readonly string[]
  /** 第几个（0 基）——同一条边 `count > 1` 时用它换一个位置，避免多条线挤在同一个点上。 */
  occurrence?: number
  metrics?: LayoutMetrics
  /**
   * 量宽函数（`canvas/measure.ts` 的 `MeasureText`，生产里用 `canvasMeasure(ctx2d)`）。
   * 不给也能命中，但 `x` 会退化成按字符数摊派的估计 —— 见函数说明。
   */
  measure?: MeasureText
}): { x: number; y: number; text: string } | null {
  const metrics = input.metrics ?? DEFAULT_METRICS
  const targets = compileTargets(input.targets)
  // 没有候选写法 ⇒ 直接按"没找到"处理：省一遍整棵排版树的遍历，也让"命中了谁"永远有据可查
  if (targets.length === 0) return null

  const found: AnchorCandidate[] = []
  walkBlocks(input.layout.blocks, 0, 0, {
    metrics,
    measure: input.measure,
    visit: (spot) => {
      const match = matchRun(spot, targets)
      if (match === null) return
      // 合并 run（`[[甲]][[甲]]` → `甲甲`）里每一份链接都要成为**独立**的候选：
      // 同一条边的第 0 / 第 1 个 `count` 因此能落到两个不同的点上，而不是叠在一起
      const advance = advanceOf(match.key, spot.font, spot.line, input.measure)
      for (let copy = 0; copy < match.copies; copy += 1) {
        found.push({ x: spot.x + copy * advance, y: spot.centerY, text: match.key })
      }
    },
  })
  if (found.length === 0) return null

  const occurrence = Math.max(0, Math.floor(input.occurrence ?? 0))
  // 越界 / NaN 都落到 found[0]（`found[NaN]` 是 undefined，所以这两条路是同一行代码）
  const hit = found[occurrence] ?? found[0]
  if (hit === undefined) return null
  return { x: hit.x, y: hit.y, text: hit.text }
}

/**
 * 卡片里**全部** wikilink 的矩形热区（卡片内坐标），给"悬停某段 `[[链接]]` 高亮对应连线"用。
 *
 * 与 `findLinkAnchor` 的分工：那一个按目标文字**找一个点**（画引线用），这一个**枚举所有段**
 * 的矩形（命中测试用）。两者共用同一套遍历（`walkBlocks` + `WikiRunSpot`），所以"悬停高亮的
 * 那段字"与"引线出发的那段字"必然是同一段 —— 不可能出现"高亮在甲处、线从乙处出发"。
 *
 * 合并 run（`[[甲]][[甲]]` → `甲甲`）在这里**不拆份**：悬停是"指向这段字"，整条 run 一个
 * 热区即可，拆开不会让体验更准确（两者指向同一条边）。
 */
export function linkZones(input: {
  layout: CardLayout
  metrics?: LayoutMetrics
  /** 量宽函数：给了热区宽度才逐像素准确（与 `findLinkAnchor` 同一约定）。 */
  measure?: MeasureText
}): LinkZone[] {
  const zones: LinkZone[] = []
  walkBlocks(input.layout.blocks, 0, 0, {
    metrics: input.metrics ?? DEFAULT_METRICS,
    measure: input.measure,
    visit: (spot) => {
      // 宽度为 0 的 run 画不出来也不该命中（空链接 `[[ ]]` 之类）
      if (spot.width <= 0 || spot.height <= 0) return
      zones.push({
        x: spot.x,
        // 热区从"行盒中线"翻成"行盒顶"：悬停命中的是整个行盒，不只是基线那一行像素
        y: spot.centerY - spot.height / 2,
        width: spot.width,
        height: spot.height,
        text: spot.text,
        ...(spot.href === undefined ? {} : { href: spot.href }),
      })
    },
  })
  return zones
}

/**
 * 引线那一段的 `d`（从链接文字到卡片边界上的某一点）。
 *
 * 导出它是因为**换锚点**的场合（环向走线把锚点从"朝目标"换成"朝外"，见 `edge-routing.ts`）
 * 需要按同一套口径重画这一段 —— 分界点必须逐坐标相同（ADR-0023 的硬保证），
 * 而"不取整 + 非有限值写 0"这两条纪律只有一份才不会分家。
 */
export function leadPathBetween(anchor: Point, exit: Point): string {
  return `M ${num(anchor.x)} ${num(anchor.y)} L ${num(exit.x)} ${num(exit.y)}`
}

/** 一段 wikilink 文字在卡片里的矩形热区（卡片内坐标，见 `linkZones`）。 */
export interface LinkZone {
  x: number
  y: number
  width: number
  height: number
  /** 显示文字（按 `normalizeLinkText` 归一化后与边的候选写法比对）。 */
  text: string
  /** wikilink 的目标原文（`data-target`）：显示文字是别名时，它是另一条匹配线索。 */
  href?: string
}

/**
 * 卡片内坐标 → 世界坐标（用 `cardChrome` 的 `padding`/`bodyTop`，不要自己猜内边距）。
 *
 * ⚠️ `metrics` 必须与**造这份 `CardLayout` 时用的那一份**一致：`bodyTop` 里含"标题折了几行"
 * 这种只有排版知道的事实，换一份 metrics 就会让整段引线上下平移（卡片底部多一块空白、
 * 或者最后一行被裁掉这类错位，最难归因的就是这种"两层各算了一遍同一个数"）。
 */
export function cardLocalToWorld(
  rect: Rect,
  point: Point,
  metrics: LayoutMetrics = DEFAULT_METRICS,
): Point {
  const chrome = cardChrome(metrics)
  return { x: rect.x + chrome.padding + point.x, y: rect.y + chrome.bodyTop + point.y }
}

// ---------------------------------------------------------------------------
// 遍历排版结果
// ---------------------------------------------------------------------------

/**
 * 按画笔的走法遍历顶层块（`y += height + gapAfter`，最后一块之后不加间距 ——
 * 与 `text-layout` 的 `totalHeight` 是同一套）。
 *
 * `left` 是这批块的**盒子左边界**（世界那侧的口径不变，这里只是卡片内坐标）；
 * 块自己的 `indent` 由 `walkOne` 加上去 —— 与 `layoutOne` 里
 * `indent = inset + indentFor(block)` 的口径一致。
 */
function walkBlocks(
  blocks: readonly LaidOutBlock[],
  left: number,
  top: number,
  ctx: WalkContext,
): void {
  let cursor = top
  blocks.forEach((item, index) => {
    walkOne(item, left, cursor, ctx)
    cursor += item.height
    if (index < blocks.length - 1) cursor += item.gapAfter
  })
}

/**
 * 一个块里的候选锚点。
 *
 * 提示框**单独一支**：它的正文是 `children`（另一棵树），位置由 `callout.bodyTop` 与
 * `metrics.calloutPadding` 给出（与 `paint.ts` 的 `drawCalloutBlock` 同一套）。
 * 这里**不下探提示框自己的 `lines`** —— 那是标题行（`calloutTitleRuns` 造的一条粗体 run，
 * 内容是"字形 + 标题"），它永远不含 wikilink；真要下探，y 还得走
 * `padding + 行号 × 标题行高` 那另一套公式，平白多一处会漂移的算式。
 *
 * 其余块**统一走 `item.lines`**，不按种类分支：`blocks.ts` 只在文字块里产出 `wikilink` run
 * （代码块是字面内容、表格单元格已被剥成纯文本、图片/分隔线没有文字），所以"这一段能不能当锚点"
 * 由 run 自己说了算 —— 将来多出一种带 wikilink run 的块，这里自动就覆盖到了。
 */
function walkOne(
  item: LaidOutBlock,
  left: number,
  top: number,
  ctx: WalkContext,
): void {
  if (item.block.kind === 'callout') {
    const geometry = item.callout
    if (geometry === undefined) return
    const children = item.children ?? []
    const childLeft = left + item.indent + ctx.metrics.calloutPadding
    let cursor = top + geometry.bodyTop
    children.forEach((child, index) => {
      walkOne(child, childLeft, cursor, ctx)
      cursor += child.height
      if (index < children.length - 1) cursor += child.gapAfter
    })
    return
  }

  // 文字左边界 = 块左边界 + 块自己的缩进 + 符号留白。
  //
  // `markerWidth` 这一笔与 `text-layout` 的 `markerGutter` 是同一条判据（列表项 / 引用才有）：
  // 那边折行时按 `width - indent - markerWidth` 算，这里若少加这一笔，锚点就会落在项目符号上。
  // 判据在这里写了第二份（两行），是因为 `markerGutter` 没有导出、而这一层不许改既有文件；
  // 值本身仍来自 `metrics.markerWidth`（唯一真源），所以改参数不会分家。
  //
  // ⚠️ 已知偏差（不在本文件能修的范围内）：`canvas/paint.ts` 的 `drawTextBlock` 目前**没有**加
  // `item.indent`（只加了符号留白）。于是 `depth ≥ 1` 的嵌套列表/引用里，这里按排版契约
  // （`text-layout` 的文档明确"文字画在 `x = indent + markerWidth`"）算出的锚点会比画出来的文字
  // 右移一个 `indent`。画笔那边补上 `item.indent` 之后两边自然对齐；顶层块（depth 0，绝大多数
  // 写法）两边完全一致。
  const markerGutter =
    item.block.kind === 'list-item' || item.block.kind === 'quote' ? ctx.metrics.markerWidth : 0
  const textLeft = left + item.indent + markerGutter
  const base = fontFor(item.block, ctx.metrics)
  const lineHeight = lineHeightFor(item.block, ctx.metrics)

  item.lines.forEach((line, lineIndex) => {
    const centerY = top + lineIndex * lineHeight + lineHeight / 2
    let cursor = textLeft
    for (const run of line.runs) {
      const font = fontOfRun(base, run)
      const width = advanceOf(run.text, font, line, ctx.measure)
      // 只有 `[[…]]`（含 `![[…]]` 嵌入）才有"正文里的位置"这回事（判据与 `matchRun` 的第一条
      // 同源）；这里的职责只到"算出几何并通知访问者"为止 —— "这段是不是这条边的锚点"
      // （findLinkAnchor）还是"这是一段可悬停的链接"（linkZones）由访问者各自决定。
      if (run.wikilink === true) {
        ctx.visit({
          x: cursor,
          centerY,
          height: lineHeight,
          width,
          font,
          line,
          text: run.text,
          href: run.href,
        })
      }
      cursor += width
    }
  })
}

/**
 * 一条 run 里的文字占多宽。
 *
 * 给了量宽函数就**逐像素**量，字体取 `fontOfRun(fontFor(block))` —— 与 `text-layout` 折行
 * 和 `paint.ts` 画字用的是同一个字体标识，所以这里算出来的位置与画出来的位置逐像素一致
 * （这也是 `text-layout` 把 `fontFor`/`fontOfRun` 导出来的原因）。
 * 没给就退化成按字符数摊派（见 `estimateAdvance`）。
 */
function advanceOf(
  text: string,
  font: FontSpec,
  line: LaidOutLine,
  measure: MeasureText | undefined,
): number {
  return measure === undefined ? estimateAdvance(text, line) : measure(text, font)
}

/**
 * 一条 run 是否就是这条边对应的那段 wiki link。
 *
 * 匹配顺序**先严后宽**，每一步命中就停 —— 顺序本身就是"为什么这么定"：
 *
 * 1. **逐字相等**：`run.text` 与 `targets` 的某一项一模一样。这是规范口径，也是绝大多数情形；
 * 2. **归一化后相等**：去首尾空白、去 `.md` 后缀、忽略大小写。它覆盖"`[[甲]]` 用 `甲.md` 命中"
 *    这类写法差异，代价是容忍度更大一点点（大小写不同在 Linux 上确实是两个文件，
 *    但"两个候选写法彼此只差大小写"这种情况在 targets 里本来就不该同时出现）；
 * 3. **整数份重复**：`run.text` 恰好是某个 target 的 `n`（≥2）份**逐字重复**。
 *    `blocks.ts` 会把**相邻且同样式**的 run 合并（`[[甲]][[甲]]` 合成一条 `甲甲`），
 *    不认这一点，一条真有位置的边会退化成"从卡片边缘出发"—— 正是用户抱怨的那个现象；
 * 4. **`href` 兜底**：`run.href` 是 wikilink 的 `data-target`，也就是笔记里**写下的目标原文**。
 *    `[[甲|别名]]` 的显示文字是别名，而 `GraphEdge.toRawTarget` 里没有别名 ——
 *    规范说"调用方应当把别名也放进 targets"，可调用方手里根本无从得知这个别名，
 *    所以这里用链接自己的目标兜底一次（`href` 是笔记原文，与 targets 里的目标写法同源）。
 *
 * **坚决不做"包含"匹配**：`[[甲虫]]` 不能被 `targets: ['甲']` 命中。一条边锚到一段与它无关的
 * 文字上，比"从卡片边缘出发"更糟 —— 线看起来是对的，实际指错了地方，而这种错没人会去查。
 * 上面四步没有一步是包含：1 / 2 / 4 是相等，3 要求整串**恰好**是整数份，所以 `甲虫` 既不是 `甲`
 * 的相等写法、也不是它的整数份重复。
 *
 * ⚠️ "这段 run 是不是 wikilink" 由**调用方**保证：`walkOne` 只为 `run.wikilink === true`
 * 的 run 调用访问者（`![[甲]]` 嵌入也带这个标记，因此天然被覆盖；Markdown 链接
 * `[文字](路径.md)` 的 run 只有 `link`，它连的是另一套东西，见降级规则）。
 * 这里再判一次不仅多余，而且**会悄悄废掉整条链路** —— 曾经真的这么错过：
 * 访问者收到的几何快照里没有 `wikilink` 字段，那句守卫于是恒真为 null，
 * 表现是所有引线一夜之间退回"从卡片边缘出发"。
 */
function matchRun(
  run: { text: string; href?: string | undefined },
  targets: readonly TargetText[],
): RunMatch | null {

  const text = run.text
  for (const target of targets) {
    if (target.raw === text) return { key: text, copies: 1 }
  }

  const normalized = normalizeLinkText(text)
  if (normalized !== '') {
    for (const target of targets) {
      if (target.normalized === normalized) return { key: text, copies: 1 }
    }
  }

  for (const target of targets) {
    const copies = repeatCount(text, target.raw)
    if (copies >= 2) return { key: target.raw, copies }
  }

  const href = run.href
  if (href !== undefined) {
    for (const target of targets) {
      if (target.raw === href) return { key: text, copies: 1 }
    }
  }

  return null
}

/**
 * 归一化：去首尾空白、去 `.md` 后缀、忽略大小写（顺序：先 trim 再摘后缀再 trim，`甲.md ` 才不会漏）。
 *
 * 导出它是因为"边的候选写法"与"悬停热区的文字"必须在**同一个**归一化口径下比对
 * （`GraphCanvas` 把热区映射回边时要逐字用这一套）—— 两份各自实现的归一化，
 * 迟早有一个边界（`甲.md` vs `甲`）对不上。
 */
export function normalizeLinkText(text: string): string {
  return text
    .trim()
    .replace(/\.md$/i, '')
    .trim()
    .toLowerCase()
}

/**
 * `text` 是 `unit` 的几份**逐字重复**（不是整数份就是 0）。
 *
 * 用 `length % unit.length` 先判整除、再 `repeat` 回来逐字比较：这样"重复"是个**结构**判据，
 * 而不是"前缀相同"——`甲虫` 的长度不是 `甲` 的整数倍（也不是它的重复），两种写法都返回 0。
 * `copies < 2` 一律返回 0：一份的重复就是"逐字相等"，那是第 1 步的事，不该在这里兜底
 * （否则一条 `[[甲]]` 会被数成"1 份重复"，两个入口给出同一个结果，读代码的人要为它停一下）。
 */
function repeatCount(text: string, unit: string): number {
  if (unit === '' || text === '') return 0
  if (text.length % unit.length !== 0) return 0
  const copies = text.length / unit.length
  if (copies < 2) return 0
  return text === unit.repeat(copies) ? copies : 0
}

/** 编译候选写法：空写法（悬空边的 `toRawTarget` 可能是空串）丢掉，否则它会与空文本互相命中。 */
function compileTargets(targets: readonly string[]): TargetText[] {
  const out: TargetText[] = []
  for (const raw of targets) {
    const normalized = normalizeLinkText(raw)
    if (normalized === '') continue
    out.push({ raw, normalized })
  }
  return out
}

/**
 * 没有量宽函数时的推进量估计：按**字符数**把整行宽度摊派给这段文字。
 *
 * 只在调用方拿不出 `MeasureText` 时使用（见 `findLinkAnchor` 的说明）。纯 CJK 的行里每个字形
 * 等宽，摊派结果与真值相同；CJK 混拉丁时可能偏十几像素。所以它是**估计**：一旦真的偏了，
 * 表现是"引线起点晚了/早了半个词"，而不是"线不知道从哪冒出来"—— 前者是精度问题，
 * 后者才是要修的那个毛病。返回值绝不为负（`line.width <= 0` 时是 0）。
 */
function estimateAdvance(text: string, line: LaidOutLine): number {
  const total = line.runs.reduce((sum, run) => sum + Array.from(run.text).length, 0)
  if (total === 0 || line.width <= 0) return 0
  return (line.width * Array.from(text).length) / total
}

// ---------------------------------------------------------------------------
// 世界坐标：射线与卡片边界的交点
// ---------------------------------------------------------------------------

/**
 * 从 `from` 朝 `to` 画一条射线，求它与矩形边界的交点（`from` 在矩形内时返回内侧交点）。
 *
 * 做法是"四条边各求一次交、取参数最小的那个正解"，而不是教科书式的 slab 算法（tNear/tFar）：
 * slab 给的是**轴对齐**射线的出点，而这里 `from` 可能在矩形外面、方向任意，
 * 逐个候选更容易说清"哪个才是第一个"，也天然覆盖了下面三种情形：
 *
 * - `from` 在矩形**内**：第一个正解就是**出去**的那个点（需求要的"内侧交点"）；
 * - `from` 在矩形**外**：第一个正解其实是**进来**的那个点 —— 但从外面朝里画时，引线本来就该在
 *   边界处收住，所以同一个结果两种场合都对；
 * - 射线**背离**矩形：一个正解都没有 ⇒ 原样返回 `from`（零长度引线）。调用方据此看到"没交点"，
 *   而不是拿到一个 NaN 再去猜。
 *
 * 退化方向（`to` 与 `from` 重合、或坐标本身不是有限数）给一个**确定的**方向（+x），
 * 而不是让 `0 / 0` 的 NaN 一路传到 SVG 的 `d` 里（见 `num`：一个 NaN 会让整条路径被浏览器丢掉）。
 *
 * 交点会**贴回**边界的精确数值（见 `EPSILON`）：由除法算出来的 `100.00000000000001` 会让
 * "引线终点正好在卡片边界上"这件事在相等断言里失败，而那是定义上必须成立的。
 */
export function rayRectExit(rect: Rect, from: Point, to: Point): Point {
  let dx = to.x - from.x
  let dy = to.y - from.y
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
    dx = 1
    dy = 0
  }

  const left = rect.x
  const right = rect.x + rect.width
  const top = rect.y
  const bottom = rect.y + rect.height
  const ts: number[] = []

  /** 同一个 t 既用于求交、也用于"交点是否落在这条边上"的判定（另一轴越界就说明这条边没被穿过）。 */
  const consider = (t: number): void => {
    if (!(t > EPSILON)) return
    const x = from.x + dx * t
    const y = from.y + dy * t
    if (x < left - EPSILON || x > right + EPSILON) return
    if (y < top - EPSILON || y > bottom + EPSILON) return
    ts.push(t)
  }

  if (dx !== 0) {
    consider((left - from.x) / dx)
    consider((right - from.x) / dx)
  }
  if (dy !== 0) {
    consider((top - from.y) / dy)
    consider((bottom - from.y) / dy)
  }
  if (ts.length === 0) return { x: from.x, y: from.y }

  const t = Math.min(...ts)
  return {
    x: snapTo(from.x + dx * t, left, right),
    y: snapTo(from.y + dy * t, top, bottom),
  }
}

/** 交点贴近某条边界时返回边界的精确值，否则原样返回（理由见 `EPSILON`）。 */
function snapTo(value: number, first: number, second: number): number {
  if (Math.abs(value - first) <= EPSILON) return first
  if (Math.abs(value - second) <= EPSILON) return second
  return value
}

// ---------------------------------------------------------------------------
// 一条边的完整几何
// ---------------------------------------------------------------------------

/**
 * 一条边的完整几何。找不到 wiki link 时降级（`fromLink: false`，引线退化成零长度）。
 *
 * 两段的分工（也是这一层的全部形状）：
 * - **卡片内（`leadPath`）**：从文字到卡片边界，一条**直线**。它只有十几到几十像素长，
 *   任何装饰（弧、圆角、箭头）在这个尺度上都是噪声；而且直线才能让人一眼看出
 *   "这条线是从**这段字**出发的"。
 * - **卡片外（`spanPath`）**：`tensionPath(exit, entry, tension)` 的三次贝塞尔，
 *   控制点沿弦的垂直方向偏移 —— 见那个函数的推导。
 *
 * `exit` / `entry` 的方向判据：都从"对端**中心**"出发打射线。
 * 不用"朝对方的 `entry` 打射线"是因为 `entry` 依赖 `exit`、两者互相依赖会绕成环；
 * 而"朝向对端中心"与既有 `edgeAnchors` 的判据同源（那边也是比较两端中心的位移）。
 *
 * 入参形状与 `GraphEdge` / 卡片盒子对齐（`count` / `toRelPath` / `title` 这一层用不到）：
 * 调用方因此可以整条边、整个盒子直传，不必挑字段 —— 少一次字段挑选就少一处"传错了哪一项"。
 * `toRawTarget` 也不在这一层做判断：目标写法该长什么样由调用方决定（`targets`）。
 *
 * 已知不覆盖的情形：**自环**（笔记链接到自己，`to.rect` 与 `from.rect` 是同一张卡片）。
 * 那时"从目标中心朝 `exit` 求入点"必然得到 `exit` 自己，`spanPath` 退化成零长度 ——
 * 需要绕圈的弧线请沿用 `layout.ts` 的 `edgeAnchors(loop)` 分支。
 */
export function linkEdgeGeometry(input: {
  edge: { toRawTarget: string; toRelPath: string | null; count: number }
  from: { rect: Rect; layout: CardLayout | null; title: string }
  to: { rect: Rect; title: string }
  /** 目标卡片在正文里可能被写成的几种样子（由调用方给，通常是 [toRawTarget, 文件名, relPath 主干]）。 */
  targets: readonly string[]
  occurrence?: number
  /** 0..1：张力，见 `tensionPath`；不给就用 `DEFAULT_TENSION`（0.35）。 */
  tension?: number
  metrics?: LayoutMetrics
  /** 量宽函数：给了锚点才逐像素准确（见 `findLinkAnchor` 的说明）。 */
  measure?: MeasureText
}): LinkEdgeGeometry {
  const metrics = input.metrics ?? DEFAULT_METRICS
  const fromCenter = centerOf(input.from.rect)
  const toCenter = centerOf(input.to.rect)

  const hit =
    input.from.layout === null
      ? null
      : findLinkAnchor({
          layout: input.from.layout,
          targets: input.targets,
          occurrence: input.occurrence ?? 0,
          metrics,
          measure: input.measure,
        })

  if (hit === null) {
    // 降级：从"朝目标卡片中心的那条边界"出发，引线长度 0（`leadPath: ''`）。
    // 用边界上那个点当 `anchor`（而不是卡片中心）是为了让调用方**不需要**分支就能画：
    // `anchor -> exit` 恒是一条可画的（可能零长的）线段，`exit -> entry` 恒是真的跨卡片段。
    // 这不是"假装命中"：`fromLink: false` 与 `matchedText: null` 把这件事说得清清楚楚。
    const exit = rayRectExit(input.from.rect, fromCenter, toCenter)
    const entry = rayRectExit(input.to.rect, toCenter, exit)
    return {
      anchor: exit,
      exit,
      entry,
      leadPath: '',
      spanPath: tensionPath(exit, entry, input.tension ?? DEFAULT_TENSION),
      fromLink: false,
      matchedText: null,
    }
  }

  const anchor = cardLocalToWorld(input.from.rect, { x: hit.x, y: hit.y }, metrics)
  const exit = rayRectExit(input.from.rect, anchor, toCenter)
  const entry = rayRectExit(input.to.rect, toCenter, exit)
  return {
    anchor,
    exit,
    entry,
    leadPath: `M ${num(anchor.x)} ${num(anchor.y)} L ${num(exit.x)} ${num(exit.y)}`,
    spanPath: tensionPath(exit, entry, input.tension ?? DEFAULT_TENSION),
    fromLink: true,
    matchedText: hit.text,
  }
}

// ---------------------------------------------------------------------------
// 张力曲线
// ---------------------------------------------------------------------------

/**
 * 张力曲线：`tension = 0` 时是直线，越大越"绷"（控制点离弦更远、方向沿垂直方向）。
 *
 * 形状：起点、终点，加两个控制点；控制点摆在**弦的 1/3 与 2/3 处**，再沿弦的垂直方向各偏移
 * `tension × 弦长 × TENSION_BULGE`。于是：
 * - `tension = 0`：两个控制点落在弦上（1/3、2/3 处），三次贝塞尔退化成**直线**（不只是共线：
 *   控制点在弦上时曲线本身处处在弦上），且参数化均匀 —— 张力滑到 0 时线不会"跳一下"；
 * - `tension = 1`：控制点离弦 `弦长的 1/4`，鼓出量约为它的 0.75 倍（三次贝塞尔中点偏移
 *   `3/4 × 控制点偏移`），够明显但不至于看起来像绕路。
 *
 * ## 为什么控制点要**沿弦**摆在 1/3 / 2/3，而不是"起点与终点各自垂直偏移"
 *
 * 只做垂直偏移（`c1 = start + 垂向 × 偏移`、`c2 = end + 垂向 × 偏移`）也对称、也能在
 * `tension = 0` 退化，但它在**起点处的切线是垂直于弦的**：连线会先横着冲一下再拐向目标，
 * 看起来像"从卡片侧面弹出去"。加上沿弦的 1/3、2/3 之后，端点切线 = 弦方向 + 一笔垂直偏移，
 * 于是"从 `exit` 朝目标发出去、中途鼓一点"这件事在几何上就成立了。两种摆法的"离弦距离"
 * 是同一个数（所以张力旋钮的手感一致），差别只在端点切线 —— 这是这里唯一真正的取舍。
 *
 * ## 为什么不用二次贝塞尔
 *
 * 二次贝塞尔只有一个控制点，形状被**完全**决定：要对称就必须把控制点放在弦的中点上、
 * 再整体垂直偏移，于是"离弦距离"与"端点切线"绑死成一个自由度 —— 张力想更大就必须让
 * 端点切线更垂直于弦（上面刚否定掉的那种观感）。三次贝塞尔把这两件事拆成两个自由度：
 * 偏移量管"绷多紧"，沿弦的位置管"从哪个方向离开发射点"。
 *
 * ## 鼓出方向
 *
 * 垂直方向取"把弦逆时针转 90°"。方向只由弦决定（不含任何时间/随机量），所以同一对端点、
 * 同一个张力每次算出来**逐字一致**：线不会在重算之间翻面（翻面看起来像在抖）。
 */
export function tensionPath(start: Point, end: Point, tension: number): string {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const chord = Math.hypot(dx, dy)
  // 弦退化成一个点（自环，或者两张卡片叠在一起）：给一条**零长度线段**而不是空串 ——
  // 空串在 SVG 里与"这条边不存在"不可分，而这里要表达的是"有这么一条边、它没有长度"。
  if (!(chord > 0)) {
    return `M ${num(start.x)} ${num(start.y)} L ${num(end.x)} ${num(end.y)}`
  }

  // 张力夹进 [0, 1]，坏值（NaN / 负数）一律按 0（直线）处理：张力是**观感**旋钮，
  // 坏值最合理的降级是"直一点"，而不是让线翻到弦的另一侧去（那看起来像换了一条边）。
  const safe = Number.isFinite(tension) ? Math.min(1, Math.max(0, tension)) : 0
  const amount = safe * chord * TENSION_BULGE

  // 弦的单位垂直方向（逆时针转 90°）
  const nx = -dy / chord
  const ny = dx / chord

  const c1x = start.x + dx / 3 + nx * amount
  const c1y = start.y + dy / 3 + ny * amount
  const c2x = start.x + (dx * 2) / 3 + nx * amount
  const c2y = start.y + (dy * 2) / 3 + ny * amount

  return (
    `M ${num(start.x)} ${num(start.y)} ` +
    `C ${num(c1x)} ${num(c1y)}, ${num(c2x)} ${num(c2y)}, ${num(end.x)} ${num(end.y)}`
  )
}

/**
 * 把一个坐标写进 SVG 的 `d` 里。
 *
 * 两条纪律：
 * 1. **不取整**（`layout.ts` 的 `edgePath` 会 `Math.round`，那是另一条路径）：`leadPath` /
 *    `spanPath` 的首尾点必须**逐字**等于 `anchor` / `exit` / `entry`。取了整，端点就各偏
 *    最多半像素，而"引线是不是从文字处出发"这件事就只能靠肉眼判断了 —— 测试也钉不住。
 * 2. **非有限值一律写 0**：`d` 里出现一个 `NaN`，浏览器会把**整条路径**判为非法并整条丢弃，
 *    表现是"某些连线凭空消失"。宁可让线出现在一个明显不对的地方（能被看见、能被报为 bug），
 *    也不要它静默消失 —— 后者的归因成本高一个数量级。
 */
function num(value: number): string {
  return Number.isFinite(value) ? String(value) : '0'
}

// ---------------------------------------------------------------------------
// 引线虚线的相位：分界处不能留缝
// ---------------------------------------------------------------------------

/** 引线虚线的实线段长度（用户单位 = 世界像素；观感与 `graph.css` 里原先那条 `3 3` 一致）。 */
const LEAD_DASH = 3

/** 引线虚线的空隙长度。 */
const LEAD_GAP = 3

/**
 * 引线虚线的 `stroke-dasharray` / `stroke-dashoffset`。
 *
 * ## 为什么要算相位，而不是照 CSS 里写一个 `stroke-dasharray: 3 3` 就完事
 *
 * SVG 的图案位置是 `p(s) = (s + strokeDashoffset) mod 周期`（`stroke-dashoffset` = "从图案的第
 * 几个像素开始画"），`p(s)` 落在 `[0, 实线段长度)` 的地方才有墨。照 CSS 那样取 `dashoffset = 0`
 * 的意思就是"从路径起点（= 链接文字）开始数虚线"，看起来最自然 —— 但它有一个必然的后果：
 * **引线长度 mod 周期** 不等于实线段长度时，路径末尾落在**空隙**里，虚线会在离卡片边界最多
 * `LEAD_GAP` 像素的地方就断掉。于是卡内那段虚线与卡外那条实线之间留出一道缝，而缝恰恰出现在
 * **分界点**上 —— 用户要的"卡片边缘处实线出连接到卡片"最忌讳的就是这个。
 *
 * ## 做法：相位反过来锚在**卡片边界**那一端
 *
 * 取 `strokeDashoffset = 实线段长度 − (引线长度 mod 周期)`，使 `p(L) = 实线段长度` ——
 * 最后一段实线**正好在 `exit` 处收笔**，卡边那一点必定有墨，分界处严丝合缝。
 * 代价是链接那一端最多空出 `LEAD_GAP`（3px）：它由引线起点那个半径 2 的圆点盖住（4px 的墨），
 * 所以两端看上去都是有墨的。两侧不能同时取到 0（图案是死的、长度是活的），这一取舍选了
 * **用户明确指名的那一端**。
 *
 * ## 被否掉的替代：让图案自适应长度
 *
 * 选一个周期使两端都正好落在实线段上（`L = n × 周期 + 实线段长度`）确实能两端都严丝合缝，
 * 但每条引线的虚实节奏都不一样（同一屏里有的 3/2、有的 3/4），而"所有引线看起来是同一种线"
 * 比"每条自己完美"更重要；而且极短的引线（< 7px）根本解不出合法的图案，还得再加一条
 * "太短就画实线"的分支。多一条分支换来肉眼看不见的收益，因此不取。
 *
 * 相位只由长度决定（不含时间/随机量）：同一条引线每次算出来逐位相同，重算不会让虚线跳动。
 * 长度不是有限正数（拿不到起点、退化成零长度）时按 0 处理，不给 SVG 送一个 `NaN`。
 */
export function leadDash(length: number): { dashArray: string; dashOffset: number } {
  const period = LEAD_DASH + LEAD_GAP
  const safe = Number.isFinite(length) && length > 0 ? length : 0
  // 结果恒在 [0, 周期) 内：负的 `stroke-dashoffset` 在不同渲染器里的解释更绕，不给自己找麻烦
  const dashOffset = (LEAD_DASH - (safe % period) + period) % period
  return { dashArray: `${LEAD_DASH} ${LEAD_GAP}`, dashOffset }
}
