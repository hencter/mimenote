/**
 * 知识图谱画布 —— **画笔**（把已经算好的几何与排版画到 `<canvas>` 上）。
 *
 * 这一层是整条链路唯一"有副作用"的地方：它不解析 markdown（`blocks.ts` 负责）、
 * 不折行不量宽（`text-layout.ts` 负责）、不算卡片位置（`layout-ego.ts` / `layout.ts` 负责）。
 * 它的输入是一份**已经定好坐标与行**的清单，输出是 canvas 的绘制调用序列 ——
 * 因此它是可测的：喂一个记录调用的假上下文，就能把"先画边后画卡片""代码行补省略号"
 * 这类**顺序与状态**的契约钉死（见 `tests/graph-paint.test.ts`）。
 *
 * ## 坐标系：屏幕空间，且不碰 `setTransform`
 *
 * `transform` 描述的是"世界 → CSS 像素"（`screen = world × scale + offset`，与
 * `GraphCanvas.tsx` 那层容器的 `translate(...) scale(...)` 同形）。本层**全程在屏幕空间作画**：
 * 每张卡片的矩形、字号、行高、缩进都先在屏幕空间算好再画。
 *
 * 为什么不在世界空间里画、靠 `ctx.setTransform` 一把缩放：
 * 1. **DPR 归调用方管**。调用方为了在高分屏上不糊，会自己做 `canvas.width = cssW * dpr` 与
 *    `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`。画笔若也去设 `setTransform`，就会把调用方那一次
 *    覆盖掉 —— 表现为"高分屏上整幅图缩到左上角四分之一"。所以本层**一次都不调 `setTransform`**，
 *    这条纪律由测试兜着。
 * 2. **线宽与字号**在世界空间里是"缩放前的值"，`setTransform` 会把描边也一起放大（这是想要的），
 *    但 `lineWidth = 1` 在 DPR 缩放下会变成半像素、糊成灰边。屏幕空间里自己乘 `scale`
 *    就能把"1px 的卡片边框"实际画成 1 个 CSS 像素 —— 与 DOM 那套 `transform: scale()` 的观感一致。
 *
 * ⚠️ 唯一被世界坐标"卡"住的量是 `metrics.width`（折行用的内容宽度）：它来自排版层，
 * 画内容右边界（省略号落点）时也用它 —— 用卡片宽度会让省略号落在文字实际占宽之外。
 *
 * ## 输入接口里那三个可选字段（对任务书的**加法**，理由在此）
 *
 * - `metrics?`：画笔要按 `headingScale` 算标题字号、按 `markerWidth` 摆项目符号、按
 *   `codeLineHeight` 排代码行 —— 这些都是 `LayoutMetrics` 里的数字。任务书给的 `PaintInput`
 *   没有它，但同一份契约又说"heading 的字号来自 metrics 的 headingScale"，所以这里补一个
 *   可选字段，缺省 `DEFAULT_METRICS`（与 `layoutCard` 的缺省一致）。
 *   ⚠️ 调用方给 `layoutCard` 传了自定义 metrics 时**必须**把同一份交给画笔，否则就是
 *   "按 A 套数字折行、按 B 套数字画字"，卡片右边会溢出。
 * - `token?`：callout 的强调色只能通过"令牌 → 颜色"问出来（颜色只有 app.css 一份），
 *   而 `PaintInput` 里没有别的地方能拿到令牌读取器。缺省时退到 `palette.quoteBorder` ——
 *   与 app.css 里 `var(--mn-callout-accent, var(--mn-quote-border))` 的兜底逐字一致。
 * - （第三个可选字段一个都没有了：`mode` / `hop` / `isRoot` 都按任务书给的原样收下，
 *   见各自字段上的说明。）
 *
 * ## 确定性
 *
 * 同一份输入必须得到**逐字相同**的绘制序列：不读时钟、不用随机数、不读全局状态或 `document`。
 * 这不是洁癖 —— 图谱的"空间记忆"（同一篇笔记每次打开在同一个位置）与"看起来一样"都建立在
 * "同一份数据画出同一幅图"之上，而任何一处隐式随机都会让它在不同机器上看起来不同。
 * 本文件里所有分支都只依赖入参。
 */

import type { Point, Rect } from '../layout'
import type { InlineRun } from './blocks'
import type { CardLayout, MeasureText } from './measure'
import { CARD_PADDING, CARD_TITLE_SCALE, cardChrome, fontString } from './measure'
import { calloutAccent, type GraphPalette } from './palette'
import {
  DEFAULT_METRICS,
  fontFor,
  fontOfRun,
  lineHeightFor,
  type FontSpec,
  type LaidOutBlock,
  type LaidOutLine,
  type LayoutMetrics,
} from './text-layout'

/**
 * 我们用到的那一小撮 2D 上下文。
 *
 * 为什么是结构类型而不是 `CanvasRenderingContext2D`：测试要喂一个"记录每次调用与属性赋值"的
 * 假上下文，而 node 里没有画布（装 jsdom + node-canvas 只为了这点断言不成比例）。
 * 结构类型让真上下文与假上下文**同一份签名**都过：真实 `CanvasRenderingContext2D` 可以直接传进来
 * （它的 `fillStyle` 是 `string | CanvasGradient | CanvasPattern`，比这里的 `string` 宽，赋值方向对得上）。
 *
 * `setTransform` / `arc` / `strokeRect` 这几个成员本层基本不用（或一次都不用），
 * 留着是因为"我需要什么就声明什么"比"抄一份完整接口"更安全：多声明一个不用的成员没有代价，
 * 少声明一个就会让真调用方在这里编译不过。
 */
export interface PaintContext {
  font: string
  /**
   * 这两个属性的类型**故意**写成联合类型（而不是 `string`）：真实的
   * `CanvasRenderingContext2D.fillStyle` 就是 `string | CanvasGradient | CanvasPattern`。
   * 写成 `string` 时，`getContext('2d')` 的返回值不能直接传进来（缺的那一支让它不满足本接口），
   * 调用方就只能加一个 `as` 或包一层转发 —— 那是把类型系统当障碍物绕，而不是用它描述事实。
   * 画笔自己只会赋字符串，这里宽一点没有任何损失。
   */
  fillStyle: string | CanvasGradient | CanvasPattern
  strokeStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  globalAlpha: number
  textAlign: string
  textBaseline: string
  lineJoin: string
  save(): void
  restore(): void
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
  beginPath(): void
  closePath(): void
  rect(x: number, y: number, width: number, height: number): void
  clip(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void
  fill(): void
  stroke(): void
  fillRect(x: number, y: number, width: number, height: number): void
  strokeRect(x: number, y: number, width: number, height: number): void
  fillText(text: string, x: number, y: number): void
  measureText(text: string): { width: number }
  setLineDash(segments: number[]): void
}

/** 视口与缩放：`screen = world × scale + offset`；`width`/`height` 是画布尺寸（CSS 像素）。 */
export interface ViewTransform {
  scale: number
  offsetX: number
  offsetY: number
  width: number
  height: number
}

export interface PaintNode {
  relPath: string
  title: string
  /** 卡片在世界坐标下的外框（与 `EgoCardBox.rect` 同口径）。 */
  rect: Rect
  /**
   * 离中心几跳。
   *
   * ⚠️ 画笔**不用**它：距离已经由**位置**（环半径）表达了，再在卡片上画一遍是重复信息。
   * 字段留着是因为它与布局层是同一份数据 —— 让调用方为了画笔再映射一遍只会多一层可能漂移的拷贝。
   */
  hop: number
  /** 中心那张卡片。同上：位置已经说明了它是谁，画笔不再单独标记。 */
  isRoot: boolean
  hasFocus: boolean
  /** ego 模式：整篇 markdown 的排版结果；全库模式为 `null`（此时只画紧凑卡片）。 */
  layout: CardLayout | null
  /** 全库模式的紧凑卡片内容（标题 + 前几行纯文本，已折好行）。 */
  compactLines?: readonly string[]
}

/** 一条边：两个**世界坐标**端点。 */
export interface PaintEdge {
  from: Point
  to: Point
  /** 虚线（`layout.ts` 的 `EdgeStyle.muted`）：跨文件夹/弱关联的边弱化显示。 */
  muted: boolean
}

export interface PaintInput {
  transform: ViewTransform
  nodes: readonly PaintNode[]
  edges: readonly PaintEdge[]
  palette: GraphPalette
  measure: MeasureText
  mode: 'focus' | 'vault'
  selected: string | null
  hovered: string | null
  /** 只在世界坐标视口内的节点才画（由调用方用 `visibleCards` 算好也可以留空）。 */
  visible?: ReadonlySet<string>
  /** 排版用的几何参数；**必须**与 `layoutCard` 收到的那一份是同一份（见文件顶部的说明）。 */
  metrics?: LayoutMetrics
  /** 读主题令牌（callout 强调色需要它）；缺省时退到 `palette.quoteBorder`。 */
  token?: (name: string) => string | null
}

export interface PaintStats {
  /** 真正画出来的卡片数。 */
  cards: number
  /** 真正画出来的边数。 */
  edges: number
  /** 因为不在视口内（或不在 `visible` 里）而跳过的卡片数。 */
  culled: number
}

// ---------------------------------------------------------------------------
// 常量（几何魔法数字只有这一份）
// ---------------------------------------------------------------------------

/** 卡片圆角（与 `--mn-radius` 的观感对应）。 */
const CARD_RADIUS = 6
/** 行内代码 / 代码块 / 图片占位框的圆角。 */
const CODE_RADIUS = 3
const IMAGE_RADIUS = 4
/** 行内代码底色相对文字左右各多出来的宽（对应 CSS 里 `code { padding: 0 .36em }` 的观感）。 */
const INLINE_CODE_PAD = 2
/** 中文省略号。用 `…` 而不是 `...`：它在 CJK 字体里就是一个字宽，不会自己折行。 */
const ELLIPSIS = '…'
/** 省略号左边的底色补丁多盖这么宽，免得行尾最后一个字的边缘从省略号后面露出来。 */
const ELLIPSIS_PAD = 2
/** 普通边的不透明度（`graph.css` 的边本来就该"退到背景里"，卡片才是主体）。 */
const EDGE_ALPHA = 0.45
const EDGE_DASH: readonly [number, number] = [5, 4]
/** 下划线：实线给普通链接、虚线给 `[[wikilink]]`（与阅读视图的 `border-bottom: dashed` 一致）。 */
const LINK_DASH: readonly [number, number] = [2, 2]
/** 项目符号右缘与文字之间留的缝（在排版层留出来的 `markerWidth` 里）。 */
const MARKER_GAP = 3
/** 引用竖线宽度（对应 `blockquote { border-left: 3px }`）。 */
const QUOTE_BAR_WIDTH = 3
/** 下划线相对行盒底部抬起来的量。 */
const UNDERLINE_LIFT = 1.5
/** callout 容器框的圆角。 */
const CALLOUT_RADIUS = 4

/**
 * callout 强调色缺省时用来兜底的令牌名。
 *
 * `--mn-quote-border` 而不是某个写死的颜色：app.css 里 callout 的左边框正是
 * `3px solid var(--mn-callout-accent, var(--mn-quote-border))` —— 强调色缺失时阅读视图画的也是这条竖线。
 * 调色板里已经有这个令牌读出来的值（`palette.quoteBorder`），直接复用，不重复读一次 DOM。
 */
const QUOTE_BORDER_TOKEN = '--mn-quote-border'

/** app.css 里那条"只声明 `--mn-callout-accent`"的规则所赋值的变量名（见 `tokenReader`）。 */
const CALLOUT_ACCENT_TOKEN = '--mn-callout-accent'

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 画一帧。
 *
 * 顺序是**硬契约**（见下），并且不受输入顺序影响：
 * 1. 先边后卡片 —— 卡片是不透明底，后画才能盖住穿过它的线段（反过来画，边会横穿卡片）；
 * 2. 卡片按 `nodes` 的数组顺序画，**数组最后一个在最上面** —— 与 `layout-ego.ts` 的 `cardAt`
 *    （从后往前找第一张命中）逐字对应：绘制顺序与命中判据必须是同一个顺序，
 *    否则会出现"点到的卡片不是看到的那张"。
 *
 * `mode` 刻意**不参与任何分支**：真正的判据是 `node.layout === null`。
 * 两个判据（"当前是哪个模式"与"这张卡有没有排版结果"）同时参与，就会出现互相矛盾的组合
 * （vault 模式却带着排版结果）需要额外解释；只留一处真源，读代码的人不必去猜哪个优先。
 * 字段仍然收下：调用方用它决定要不要去排版正文，画笔留下它，"两边看的是同一份输入"在类型上才成立。
 */
export function paintGraph(context: PaintContext, input: PaintInput): PaintStats {
  const scale = normalizeScale(input.transform.scale)
  const metrics = input.metrics ?? DEFAULT_METRICS
  const env: PaintEnv = {
    transform: input.transform,
    scale,
    palette: input.palette,
    measure: input.measure,
    metrics,
    focused: focusedPaths(input),
    accentOf: (type) => calloutAccent(tokenReader(input), type),
  }

  const edges = drawEdges(context, input, env)

  let cards = 0
  let culled = 0
  for (const node of input.nodes) {
    // `visible` 是调用方用 `visibleCards` 预先筛过的集合（世界坐标视口）。它缺席时**仍然**
    // 逐张做屏幕矩形相交判定 —— "筛过"不代表"筛得对"，而把屏幕外的卡片也画一遍是
    // 10 万节点规模下最容易发生的性能事故（一次 fillText 就是一次字体整形）。
    if (input.visible !== undefined && !input.visible.has(node.relPath)) {
      culled += 1
      continue
    }
    if (!insideViewport(screenRect(node.rect, env.transform, scale), env.transform)) {
      culled += 1
      continue
    }
    drawCard(context, node, env)
    cards += 1
  }

  return { cards, edges, culled }
}

// ---------------------------------------------------------------------------
// 绘制环境
// ---------------------------------------------------------------------------

/** 一帧里所有绘制函数共用的东西（省掉每个函数一串参数，也保证它们看的是同一份数字）。 */
interface PaintEnv {
  transform: ViewTransform
  scale: number
  palette: GraphPalette
  measure: MeasureText
  metrics: LayoutMetrics
  /** `hasFocus` / `selected` / `hovered` 三类"当前活跃"的 relPath 合集。 */
  focused: ReadonlySet<string>
  /** callout 类型 → 强调色（见 `PaintInput.token` 与 `palette.calloutAccent`）。 */
  accentOf: (type: string) => string
}

/**
 * 缩放的安全化。
 *
 * `scale` 为 0 / 负数 / NaN 时所有坐标都是 0 或 NaN，canvas 会**静默地什么都不画**
 * （NaN 的路径被整条忽略），表现为"卡片全都不见了"而控制台一句错都没有。
 * 退回 1 是"至少画得出来"的降级：缩放控件坏掉时用户还能看到图，而不是一片空白。
 */
function normalizeScale(scale: number): number {
  return Number.isFinite(scale) && scale > 0 ? scale : 1
}

/**
 * 当前活跃的 relPath 集合。
 *
 * 三样东西合成一份：`hasFocus`（数据层说这张卡在焦点里，比如搜索结果）、`selected`
 * （用户点中的那张）、`hovered`（鼠标悬停）。画笔不区分它们 —— 观感上"这一张是当前那张"
 * 是一件事，区分开只会让 `PaintInput` 多两个开关而没有任何一处会用到差别。
 */
function focusedPaths(input: PaintInput): ReadonlySet<string> {
  const focused = new Set<string>()
  for (const node of input.nodes) {
    if (node.hasFocus || node.relPath === input.selected || node.relPath === input.hovered) {
      focused.add(node.relPath)
    }
  }
  return focused
}

/**
 * callout 强调色的令牌读取器。
 *
 * 调用方给了 `token` 就用它（那是真实现：元素上读 `getComputedStyle`）。
 * 没给的时候只回答两个名字，都答"引用竖线色"：
 *
 * - `--mn-quote-border` → 它就是 `palette.quoteBorder` 本身；
 * - `--mn-callout-accent` → app.css 里这个变量缺失时的兜底正是 `var(--mn-quote-border)`，
 *   所以"这一帧的强调色 = 引用竖线色"在语义上就是 app.css 那条兜底链的结论。
 *
 * 于是 `calloutAccent` 的降级链在"没有令牌读取器"这一档上落在**调用方给的调色板**上，
 * 而不是落在 `palette.ts` 里的常量上 —— 调色板才是这一帧真正的主题来源
 * （写死常量会让"调用方自己给了一套调色板"的场合出现两种颜色混用）。
 */
function tokenReader(input: PaintInput): (name: string) => string | null {
  const provided = input.token
  if (provided !== undefined) return provided
  const quoteBorder = input.palette.quoteBorder
  return (name) =>
    name === QUOTE_BORDER_TOKEN || name === CALLOUT_ACCENT_TOKEN ? quoteBorder : null
}

// ---------------------------------------------------------------------------
// 坐标换算
// ---------------------------------------------------------------------------

function screenPoint(point: Point, transform: ViewTransform, scale: number): Point {
  return { x: point.x * scale + transform.offsetX, y: point.y * scale + transform.offsetY }
}

function screenRect(rect: Rect, transform: ViewTransform, scale: number): Rect {
  return {
    x: rect.x * scale + transform.offsetX,
    y: rect.y * scale + transform.offsetY,
    // 宽高**也**要乘 scale：世界坐标里 260 宽的卡片在 2 倍缩放下占 520 个 CSS 像素。
    // 忘了这一笔的后果是"卡片框在原地、文字却按缩放后的字号画出来"（文字溢出卡片）。
    width: rect.width * scale,
    height: rect.height * scale,
  }
}

/**
 * 与视口有交集吗（边界相接不算：`>` 而不是 `>=`）。
 *
 * 边界判定取严格不等，是为了让"正好贴着画布边缘的卡片"被跳过 —— 它的可见部分宽度为 0，
 * 画它只是白白调一堆绘制 API。这正是 `culled` 想统计的那一类。
 */
function insideViewport(rect: Rect, transform: ViewTransform): boolean {
  return (
    rect.x + rect.width > 0 &&
    rect.x < transform.width &&
    rect.y + rect.height > 0 &&
    rect.y < transform.height
  )
}

/** 字体标识跟着整体缩放：量宽与画字用的是同一个（缩放后的）字体串。 */
function scaleFont(font: FontSpec, scale: number): FontSpec {
  return { size: font.size * scale, bold: font.bold, italic: font.italic, code: font.code }
}

// ---------------------------------------------------------------------------
// 边
// ---------------------------------------------------------------------------

/**
 * 画所有边，返回画了几条。
 *
 * 这里**不做视口裁剪**：`edges` 由调用方给出（它已经按子图/深度筛过一轮），
 * 而边是两个点、没有"卡片矩形"可判；真要按视口裁线段属于另一层（几何裁剪），
 * 在这一层顺手做一个半吊子的版本只会让它看起来"已经裁过了"。
 *
 * 活跃判定只能用**几何**："两端任一 hasFocus，或与 hovered/selected 相连"要成立，
 * 需要知道"这条边连着谁"，而 `PaintEdge` 只有两个点（没有 relPath）。
 * 判据因此是"端点落在哪张卡片的矩形里"—— 端点由调用方放在卡片上（中心或边框锚点），
 * 这与 `layout-ego.ts` 的 `cardAt` 是同一套命中口径（从后往前找，与绘制顺序一致）。
 */
function drawEdges(context: PaintContext, input: PaintInput, env: PaintEnv): number {
  let drawn = 0
  for (const edge of input.edges) {
    const from = screenPoint(edge.from, env.transform, env.scale)
    const to = screenPoint(edge.to, env.transform, env.scale)
    const active =
      env.focused.has(pathAt(input.nodes, edge.from)) || env.focused.has(pathAt(input.nodes, edge.to))

    context.globalAlpha = active ? 1 : EDGE_ALPHA
    context.strokeStyle = active ? env.palette.edgeActive : env.palette.edge
    // 线宽也跟着缩放（与卡片、文字同一个整体缩放）；不缩的话缩小时边会比卡片还粗
    context.lineWidth = (active ? 2 : 1.6) * env.scale
    context.lineJoin = 'round'
    context.setLineDash(edge.muted ? [...EDGE_DASH] : [])
    context.beginPath()
    context.moveTo(from.x, from.y)
    context.lineTo(to.x, to.y)
    context.stroke()
    drawn += 1
  }
  // 收尾复位：后面的卡片会自己设颜色与虚线，但 `globalAlpha` 若留在 0.45，整张卡会变半透明
  context.globalAlpha = 1
  context.setLineDash([])
  return drawn
}

/** 世界坐标点落在哪张卡片上（后画的在上，与 `cardAt` 一致）；没有命中返回空串。 */
function pathAt(nodes: readonly PaintNode[], point: Point): string {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (node === undefined) continue
    const { rect } = node
    if (
      point.x >= rect.x &&
      point.x <= rect.x + rect.width &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.height
    ) {
      return node.relPath
    }
  }
  return ''
}

// ---------------------------------------------------------------------------
// 卡片
// ---------------------------------------------------------------------------

/**
 * 画一张卡片：圆角底 + 边框 + 标题行 + 分隔细线 + 正文。
 *
 * `save`/`clip`/`restore` 三件套围绕**整张卡片**，理由是正文里最长的东西是代码行 ——
 * 代码**不折行**（折行会改变缩进与视觉结构，见 `text-layout` 的说明），所以溢出是常态。
 * 唯一的处置办法是把它裁到卡片里。裁剪必须包在 `save`/`restore` 之间：
 * `clip` 是状态的一部分，泄漏出去会把**后面所有卡片**一起裁没，而"整幅图空了"是最难查的一类故障
 * （没有任何异常，只是什么都没画出来）。
 */
function drawCard(context: PaintContext, node: PaintNode, env: PaintEnv): void {
  const { palette, scale, metrics } = env
  const rect = screenRect(node.rect, env.transform, scale)
  const chrome = cardChrome(metrics)
  const focused = env.focused.has(node.relPath)
  const contentLeft = rect.x + CARD_PADDING * scale
  // 内容宽度取**排版层那一个**（`metrics.width`），不是 `rect.width - 2*padding`：
  // 折行就是按这个数算的，拿卡片宽度当右边界会让省略号落在文字实际占宽之外
  // （或者相反：明明放不下却没有省略号）。两者的差就是"排版用了别的 metrics"这个信号。
  const contentWidth = metrics.width * scale

  context.globalAlpha = 1
  context.setLineDash([])
  context.save()
  context.beginPath()
  context.rect(rect.x, rect.y, rect.width, rect.height)
  context.clip()

  // 底与边框：同一个圆角路径描两次（先填后描），所以边框压在填充之上、不会被底色吃掉半个像素
  context.fillStyle = palette.cardBg
  roundRectPath(context, rect, CARD_RADIUS * scale)
  context.fill()
  context.strokeStyle = focused ? palette.cardBorderFocus : palette.cardBorder
  context.lineWidth = (focused ? 2 : 1) * scale
  roundRectPath(context, rect, CARD_RADIUS * scale)
  context.stroke()

  // 标题行：单独一行、加粗、主题的标题色。标题**不折行**（折行会让标题行高变成"看内容而定"，
  // 于是同一屏的卡片标题带高低不齐）；太长就由卡片自己的 clip 裁掉 ——
  // 这是已知的简化：标题的省略号要在每张卡片上多量一次宽度，收益不抵那一笔。
  context.setLineDash([])
  context.font = fontString(scaleFont({ size: metrics.fontSize * CARD_TITLE_SCALE, bold: true }, scale))
  context.fillStyle = palette.title
  context.textAlign = 'left'
  context.textBaseline = 'middle'
  context.fillText(node.title, contentLeft, rect.y + (chrome.padding + chrome.titleHeight / 2) * scale)

  // 标题与正文之间的细线：卡片上"标题"与"正文"是两段不同性质的内容，一条线比一片留白更清楚
  const separatorY = rect.y + chrome.separatorY * scale
  drawLine(context, contentLeft, separatorY, contentLeft + contentWidth, separatorY, palette.cardBorder, false)

  const bodyTop = rect.y + chrome.bodyTop * scale
  const layout = node.layout
  if (layout === null) {
    drawCompactBody(context, node, contentLeft, bodyTop, env)
  } else {
    drawBody(context, layout.blocks, contentLeft, bodyTop, env)
  }

  context.restore()
}

/**
 * 正文：按 `y += height + gapAfter` 累加。
 *
 * 与 `text-layout` 的 `totalHeight` 是同一套走法（最后一块之后不加间距），
 * 所以"卡片高度"与"画出来的内容边界"必然一致 —— 差一个间距就会表现为卡片底部
 * 多出或少掉一条 8px 的空白，这种错位肉眼能看出但很难定位到是哪一层。
 */
function drawBody(
  context: PaintContext,
  blocks: readonly LaidOutBlock[],
  left: number,
  top: number,
  env: PaintEnv,
): void {
  let cursor = top
  blocks.forEach((item, index) => {
    drawBlock(context, item, left, cursor, env)
    cursor += item.height * env.scale
    if (index < blocks.length - 1) cursor += item.gapAfter * env.scale
  })
}

/**
 * 紧凑卡片（全库模式）：标题 + 调用方折好行的纯文本。
 *
 * 壳（圆角底、边框、标题行、分隔线）与 ego 模式**完全一样** —— 两种模式的区别只有"正文从哪来"。
 * 让壳保持一致是有意的：用户在两个视图之间切换时，卡片的大小关系与标题位置不变，
 * 变的只有正文的详细程度（那正是"全库看结构、ego 看内容"想要的效果）。
 */
function drawCompactBody(
  context: PaintContext,
  node: PaintNode,
  left: number,
  top: number,
  env: PaintEnv,
): void {
  const lineHeight = env.metrics.lineHeight * env.scale
  const lines = node.compactLines ?? []
  context.font = fontString(scaleFont({ size: env.metrics.fontSize }, env.scale))
  context.fillStyle = env.palette.text
  context.textAlign = 'left'
  context.textBaseline = 'middle'
  context.setLineDash([])
  lines.forEach((text, index) => {
    context.fillText(text, left, top + index * lineHeight + lineHeight / 2)
  })
}

// ---------------------------------------------------------------------------
// 块
// ---------------------------------------------------------------------------

/**
 * 画一个块。
 *
 * `default` 分支是**必须**有的降级：`DrawBlock` 正在长新种类（另一个 agent 在加 `callout`，
 * 将来还会有别的），而画笔是从宿主/缓存里读数据的一方 —— 遇到不认识的种类**绝不能抛**。
 * 一抛的代价极端不成比例：一篇笔记里出现一句新语法，整张卡片（乃至整帧）就画不出来，
 * 而画布是只读预览，"少画一点"永远好过"整块空白"。
 *
 * 降级做法是**按 `item.lines` 当段落画**，而不是去读 `block.runs`：一来排版层对不认识的种类
 * 就是按段落折行的（`layoutOne` 的 default 分支），画出来与它一致；二来在这个分支里
 * `block` 的类型已经被穷尽收窄成 `never`，去读它的字段等于在猜新种类长什么样 ——
 * 那种代码会在下一次类型检查时以最含糊的方式失败。
 */
function drawBlock(
  context: PaintContext,
  item: LaidOutBlock,
  left: number,
  top: number,
  env: PaintEnv,
): void {
  switch (item.block.kind) {
    case 'code': {
      drawCodeBlock(context, item, left, top, env)
      break
    }
    case 'hr': {
      // 分隔线占一行的高度（排版层给的），线画在这一行的中间 —— 顶在上沿会看起来像贴着上一块
      const ruleY = top + (item.height * env.scale) / 2
      const ruleRight = left + (env.metrics.width - item.indent) * env.scale
      drawLine(context, left, ruleY, ruleRight, ruleY, env.palette.cardBorder, false)
      break
    }
    case 'image': {
      drawImageBlock(context, item, left, top, env)
      break
    }
    case 'table': {
      drawTableBlock(context, item, left, top, env)
      break
    }
    case 'callout': {
      drawCalloutBlock(context, item, left, top, env)
      break
    }
    case 'heading':
    case 'paragraph':
    case 'list-item':
    case 'quote': {
      drawTextBlock(context, item, left, top, env)
      break
    }
    default: {
      // 未知种类：按段落画它**已经折好的行**（理由见函数注释）
      drawTextBlock(context, item, left, top, env)
      break
    }
  }
}

/**
 * 文字块（标题 / 段落 / 列表项 / 引用，以及不认识的种类）。
 *
 * 四种块共用一条绘制路径，差别只有三样：**字体**（标题更大更粗）、**颜色**（标题色 / 正文色 /
 * 引用偏灰）、**前缀**（项目符号、引用竖线）。共用而不是各写一份，是因为它们的纵向排布
 * 完全一样（第一行的中心在 `lineHeight / 2`），分开写就要把这句话抄四遍 ——
 * 抄错一遍的表现是"列表项的第一行比段落低 2px"，几乎不可能被 review 出来。
 */
function drawTextBlock(
  context: PaintContext,
  item: LaidOutBlock,
  left: number,
  top: number,
  env: PaintEnv,
): void {
  const { metrics, palette, scale } = env
  const block = item.block
  const base = fontFor(block, metrics)
  const lineHeight = lineHeightFor(block, metrics) * scale

  let color = palette.text
  // 文字左边界 = 块左边界 + 符号留白。**必须**是排版层留出来的 `markerWidth`：
  // 折行是按 `width - indent - markerWidth` 算的，画笔若从小一点的地方起画，
  // 最后几个字就会越过卡片右边被裁掉（"看起来只是有点挤"的溢出最难发现）
  let textLeft = left
  let marker: string | null = null

  switch (block.kind) {
    case 'heading': {
      color = palette.title
      break
    }
    case 'list-item': {
      marker = listMarker(block)
      textLeft = left + metrics.markerWidth * scale
      break
    }
    case 'quote': {
      // 竖线画在符号留白那一栏的左端（`indent` 处），与 CSS 的 `border-left: 3px` 对应
      context.setLineDash([])
      context.fillStyle = palette.quoteBorder
      context.fillRect(left, top, QUOTE_BAR_WIDTH * scale, item.height * scale)
      color = palette.muted
      textLeft = left + metrics.markerWidth * scale
      break
    }
    default: {
      // 段落与未知种类：没有前缀、用正文色
      break
    }
  }

  if (marker !== null) {
    context.font = fontString(scaleFont(base, scale))
    context.fillStyle = palette.muted
    // 右对齐：有序列表的 `10.` 比 `9.` 宽，右对齐才能让文字左边界看起来是齐的
    context.textAlign = 'right'
    context.textBaseline = 'middle'
    context.fillText(marker, textLeft - MARKER_GAP * scale, top + lineHeight / 2)
  }

  item.lines.forEach((line, index) => {
    const centerY = top + index * lineHeight + lineHeight / 2
    drawRuns(context, line, { x: textLeft, centerY, lineHeight, base, color }, env)
  })
}

/**
 * 列表项的前缀符号。
 *
 * 三档与 `blocks.ts` 的判定一一对应：任务项画勾选框（`[ ]` 在阅读视图里是字面的方括号，
 * 画布上把它画成框是刻意的差异，见 `blocks.ts` 的 `stripTaskMarker`）、有序列表画**实际序号**
 * （从 `start` 起算，所以 `3.` 开头的那一列不会从 `1.` 重新数）、其余画圆点。
 *
 * `•` / `☐` / `☑` 都是普通字符而不是图形：它们与文字共用同一套字体与基线，
 * 用 `arc` 自己画圆点则要单独对基线（而且要额外处理缩放），得不偿失。
 */
function listMarker(block: Extract<LaidOutBlock['block'], { kind: 'list-item' }>): string {
  if (block.checked !== undefined) return block.checked ? '☑' : '☐'
  if (block.ordered) return `${block.index}.`
  return '•'
}

/**
 * 画一行的 runs。
 *
 * 宽度用 `measure(run.text, 字体)` **逐段**量，而不是拿 `line.width` 平摊：
 * 一段行里可能有普通体、粗体、等宽、链接四段，它们的宽度各不相同；平分会让后面每一段
 * 都偏移一点，累积到行尾就是几个字的错位。逐段量也保证与换行时用的是同一个字体标识
 * ——这正是 `text-layout` 把 `fontOfRun` 导出来的原因。
 *
 * 装饰（下划线 / 删除线）：
 * - 链接画**一条**下划线，`[[wikilink]]` 用虚线（与阅读视图 `a.mn-wikilink { border-bottom: 1px dashed }`
 *   一致）。`blocks.ts` 明确要求"不要为同一条 run 画两条下划线" —— 所以这里是一处 `if`
 *   而不是"链接一次、wikilink 再一次"。
 * - 删除线画在文字中线上；少了它，`~~删掉的话~~` 在卡片上就完全看不出被删过（画布没有 `<s>`）。
 */
function drawRuns(
  context: PaintContext,
  line: LaidOutLine,
  target: { x: number; centerY: number; lineHeight: number; base: FontSpec; color: string },
  env: PaintEnv,
): void {
  const { palette, scale } = env
  let cursor = target.x

  for (const run of line.runs) {
    const font = scaleFont(fontOfRun(target.base, run), scale)
    const width = env.measure(run.text, font)
    const color = runColor(run, target.color, palette)

    if (run.code === true) {
      // 行内代码：底色是**圆角小方块**而不是整行的一条背景带（阅读视图里 `code` 只有文字那么宽），
      // 高度取整个行盒，于是相邻两行的代码底色自然不会连成一片
      context.setLineDash([])
      context.fillStyle = palette.codeBg
      roundRectPath(
        context,
        {
          x: cursor - INLINE_CODE_PAD * scale,
          y: target.centerY - target.lineHeight / 2,
          width: width + INLINE_CODE_PAD * 2 * scale,
          height: target.lineHeight,
        },
        CODE_RADIUS * scale,
      )
      context.fill()
    }

    context.font = fontString(font)
    context.fillStyle = color
    context.textAlign = 'left'
    context.textBaseline = 'middle'
    context.fillText(run.text, cursor, target.centerY)

    if (run.strikethrough === true) {
      drawLine(context, cursor, target.centerY, cursor + width, target.centerY, color, false)
    }
    if (run.link === true) {
      const underlineY = target.centerY + target.lineHeight / 2 - UNDERLINE_LIFT * scale
      drawLine(context, cursor, underlineY, cursor + width, underlineY, color, run.wikilink === true)
    }

    cursor += width
  }
}

/**
 * 一段 run 的颜色。
 *
 * 优先级：行内代码 > 链接 > 块自己的颜色。
 * 代码底色属于"这是一段代码"那一笔，文字若用链接色就会与底色对不上（真实笔记里
 * `[`代码里的链接`]` 极少，但确实存在，必须有个确定的结果而不是"看哪个 if 写在前面"）。
 */
function runColor(run: InlineRun, fallback: string, palette: GraphPalette): string {
  if (run.code === true) return palette.codeText
  if (run.link === true) return palette.link
  return fallback
}

// ---------------------------------------------------------------------------
// 代码块
// ---------------------------------------------------------------------------

/**
 * 代码块：整块底色 + 每行等宽文字，**不折行**，放不下的行补 `…`。
 *
 * 为什么内边距是 0（底色贴着文字）：块高是 `行数 × 代码行高` **精确**算出来的（排版层的口径），
 * 再加内边距就会顶出块高度、压到下一块上；左右也是一样 —— "这行放不下吗"的判据是按整块宽度算的，
 * 而文字从内边距之后起画就等于偷偷缩小了可用宽度，会出现"明明放得下却显示省略号"。
 *
 * 省略号画法：先把整行裁到块宽度内画出来，再用底色补一小块盖住行尾，最后写 `…`。
 * 直接写 `…` 而不盖一块底色的话，行尾的半个字会从省略号后面透出来（`fillText` 不会擦除已有内容）。
 * 裁剪用的是**嵌套的** `save`/`clip`/`restore`：外层是卡片那一层，这里多一层只为了这一行代码。
 */
function drawCodeBlock(
  context: PaintContext,
  item: LaidOutBlock,
  left: number,
  top: number,
  env: PaintEnv,
): void {
  const { metrics, palette, scale } = env
  const blockWidth = (metrics.width - item.indent) * scale
  const lineHeight = metrics.codeLineHeight * scale
  const font = scaleFont(fontFor(item.block, metrics), scale)

  context.setLineDash([])
  context.fillStyle = palette.codeBg
  roundRectPath(
    context,
    { x: left, y: top, width: blockWidth, height: item.height * scale },
    CODE_RADIUS * scale,
  )
  context.fill()

  item.lines.forEach((line, index) => {
    const lineTop = top + index * lineHeight
    const overflows = line.width * scale > blockWidth

    if (overflows) {
      context.save()
      context.beginPath()
      context.rect(left, lineTop, blockWidth, lineHeight)
      context.clip()
    }

    drawRuns(
      context,
      line,
      { x: left, centerY: lineTop + lineHeight / 2, lineHeight, base: font, color: palette.codeText },
      env,
    )

    if (overflows) {
      context.restore()
      const ellipsisWidth = env.measure(ELLIPSIS, font)
      const patchX = left + blockWidth - ellipsisWidth - ELLIPSIS_PAD * scale
      context.setLineDash([])
      context.fillStyle = palette.codeBg
      context.fillRect(patchX, lineTop, ellipsisWidth + ELLIPSIS_PAD * scale, lineHeight)
      context.font = fontString(font)
      context.fillStyle = palette.codeText
      context.textAlign = 'left'
      context.textBaseline = 'middle'
      context.fillText(ELLIPSIS, patchX, lineTop + lineHeight / 2)
    }
  })
}

// ---------------------------------------------------------------------------
// 图片
// ---------------------------------------------------------------------------

/**
 * 图片：**只画占位框**，绝不尝试解码图片。
 *
 * 为什么不解码：图谱是几千张卡片的只读预览，解码意味着把 vault 里所有图片读进内存
 * （还要处理"文件不存在""格式不支持""几百兆的大图"），而卡片上的图片只有几十像素高、
 * 根本看不清内容。占位框 + alt 文字 + 实际尺寸反而让人一眼知道"这里是一张多大的图"。
 * 结构性保证：`PaintContext` 里**没有** `drawImage` —— 想画也画不了，这条纪律不必靠人来守。
 *
 * `item.image` 在类型上是可选的（`kind === 'image'` 时排版层一定会给），缺了就按块自己的
 * 高度与可用宽度兜一个盒子：静默跳过会让"这里本来有张图"消失，而那是用户的正文内容。
 */
function drawImageBlock(
  context: PaintContext,
  item: LaidOutBlock,
  left: number,
  top: number,
  env: PaintEnv,
): void {
  const { metrics, palette, scale } = env
  const block = item.block
  const box = item.image ?? {
    width: metrics.width - item.indent,
    height: item.height,
  }
  const rect = { x: left, y: top, width: box.width * scale, height: box.height * scale }

  context.globalAlpha = 1
  context.fillStyle = palette.imageBox
  roundRectPath(context, rect, IMAGE_RADIUS * scale)
  context.fill()

  // 虚线边框对应 CSS 里 `.mn-image-placeholder { border: 1px dashed }`：
  // 实线会被误认成"真的画了张图"，虚线才读得出"这是个占位"
  context.setLineDash([4 * scale, 3 * scale])
  context.strokeStyle = palette.cardBorder
  context.lineWidth = 1 * scale
  roundRectPath(context, rect, IMAGE_RADIUS * scale)
  context.stroke()
  context.setLineDash([])

  const label = imageLabel(block.kind === 'image' ? block.alt : '', box)
  context.save()
  context.beginPath()
  context.rect(rect.x, rect.y, rect.width, rect.height)
  context.clip()
  context.font = fontString(scaleFont({ size: metrics.fontSize }, scale))
  context.fillStyle = palette.muted
  context.textAlign = 'left'
  context.textBaseline = 'middle'
  context.fillText(label, rect.x + 6 * scale, rect.y + rect.height / 2)
  context.restore()
}

/**
 * 占位框里的文字：`alt`（没有就写"图片"）+ 实际占的尺寸。
 *
 * 尺寸取**盒子**的宽高（已经按卡片宽度等比缩过）而不是 `data-mn-width` 上的原始值：
 * 画布上"能看出是横图还是竖图、占多宽"才是有用的信息，原始像素值在几十像素的框里没人会读。
 * 四舍五入到整数：`233.99999999999997×150` 这种数字只会让人怀疑渲染坏了。
 */
function imageLabel(alt: string, box: { width: number; height: number }): string {
  const size = `${Math.round(box.width)}×${Math.round(box.height)}`
  const text = alt.trim()
  return text === '' ? `图片 ${size}` : `${text} ${size}`
}

// ---------------------------------------------------------------------------
// 表格
// ---------------------------------------------------------------------------

/**
 * 表格：按排版层给的 `columnWidths` / `rowHeights` 画网格与单元格文字。
 *
 * 为什么一行代码都不重排：列宽分配（含"内容优先、再向可用宽度收敛"的收缩）与每格折行
 * 都已经在 `text-layout` 里算完（`LaidOutTable`）。画笔若再算一次列宽，两张宽度不同的
 * 表格迟早会算出不一样的列宽 —— 而"一行文字越过竖线"这种错位在小卡片上极其显眼。
 *
 * 单元格文字用 `line.width`（排版时量好的）而不是重新 `measure`：同一份文本同一个字体，
 * 再量一次只会多一次（可能不准的）计算，而且居中对齐对宽度的偏差最敏感。
 *
 * 表头行在 `LaidOutTable.rowHeights` 里排在**最前**（与 `headerRows` 拼接后的顺序一致），
 * 所以 `rowHeights[行下标]` 可以直接用；`?? 0` 与 `?? []` 是 `noUncheckedIndexedAccess`
 * 下的边界兜底（数据由排版层保证，兜底只是让越界退化成"少画一行"而不是整帧崩掉）。
 */
function drawTableBlock(
  context: PaintContext,
  item: LaidOutBlock,
  left: number,
  top: number,
  env: PaintEnv,
): void {
  const table = item.table
  if (table === undefined) return

  const { metrics, palette, scale } = env
  const lineHeight = metrics.lineHeight * scale
  const cellPadding = metrics.tableCellPadding * scale
  const rows = [...table.headerRows, ...table.rows]

  const columns: number[] = []
  let cursorX = left
  for (const width of table.columnWidths) {
    columns.push(cursorX)
    cursorX += width * scale
  }
  const tableWidth = cursorX - left

  const rowTops: number[] = []
  let cursorY = top
  for (const height of table.rowHeights) {
    rowTops.push(cursorY)
    cursorY += height * scale
  }
  const tableHeight = cursorY - top

  // 网格：横线画表头与每一行之间（含上下边框），竖线画每一列的边界（含左右边界）
  context.setLineDash([])
  context.strokeStyle = palette.cardBorder
  context.lineWidth = 1 * scale
  for (const y of [...rowTops, top + tableHeight]) {
    drawLine(context, left, y, left + tableWidth, y, palette.cardBorder, false)
  }
  for (const x of [...columns, left + tableWidth]) {
    drawLine(context, x, top, x, top + tableHeight, palette.cardBorder, false)
  }

  rows.forEach((cells, rowIndex) => {
    const rowTop = rowTops[rowIndex] ?? top
    const rowHeight = table.rowHeights[rowIndex] ?? 0
    cells.forEach((cell, columnIndex) => {
      const cellX = columns[columnIndex] ?? left
      // 文字整体在行内**垂直居中**：一个两行的单元格与一个一行的单元格并排时，
      // 顶对齐会让短的那一格看起来"浮"在上面
      const linesHeight = cell.lines.length * lineHeight
      const firstCenter = rowTop + (rowHeight * scale - linesHeight) / 2 + lineHeight / 2

      cell.lines.forEach((line, lineIndex) => {
        const textWidth = line.width * scale
        // 对齐按**单元格可用宽度**算（`cell.width` 已经扣掉了左右内边距），
        // 于是"居中"是真正在格子里居中，而不是在"格子减内边距"之后再居中
        const offset =
          cell.align === 'center'
            ? cellPadding + Math.max(0, (cell.width * scale - textWidth) / 2)
            : cell.align === 'right'
              ? cellPadding + Math.max(0, cell.width * scale - textWidth)
              : cellPadding
        drawRuns(
          context,
          line,
          {
            x: cellX + offset,
            centerY: firstCenter + lineIndex * lineHeight,
            lineHeight,
            base: fontFor(item.block, metrics),
            color: palette.text,
          },
          env,
        )
      })
    })
  })
}

// ---------------------------------------------------------------------------
// callout
// ---------------------------------------------------------------------------

/**
 * 提示框：左侧强调色竖条 + 标题行（强调色）+ 子块（同一条块绘制路径）。
 *
 * 几何全部来自 `LaidOutBlock.callout`（`width` / `titleHeight` / `bodyTop`）与 `item.children`：
 * 子块的 `indent` 里已经含了 `calloutBodyInset`，所以这里只把"容器内容区原点"交给 `drawBlock`，
 * 不需要（也不该）知道内缩是怎么算的 —— 一旦画笔自己算一遍内缩，容器高度与子块位置就会用两套数字。
 *
 * 强调色**不在这里定**：颜色只有 app.css 一份，`accentOf` 按类型去问令牌（见 `palette.calloutAccent`）。
 * 未知类型（用户手写 `[!摘录]`）在 `blocks.ts` 里已经回落成 `note`，这里不会拿到没见过的类型名。
 */
function drawCalloutBlock(
  context: PaintContext,
  item: LaidOutBlock,
  left: number,
  top: number,
  env: PaintEnv,
): void {
  const geometry = item.callout
  if (geometry === undefined) return

  const { metrics, palette, scale } = env
  const rect = { x: left, y: top, width: geometry.width * scale, height: item.height * scale }
  const block = item.block
  const accent = env.accentOf(block.kind === 'callout' ? block.type : '')

  context.globalAlpha = 1
  context.setLineDash([])
  // 容器底与边框：底色与卡片同色（app.css 里 callout 的背景就是 `--mn-bg-elevated`），
  // 靠边框 + 竖条把它与正文分开 —— 画一个"更深/更亮"的底会引入一份新的颜色来源
  context.fillStyle = palette.cardBg
  roundRectPath(context, rect, CALLOUT_RADIUS * scale)
  context.fill()
  context.strokeStyle = palette.cardBorder
  context.lineWidth = 1 * scale
  roundRectPath(context, rect, CALLOUT_RADIUS * scale)
  context.stroke()

  // 竖条：贴着容器的左边缘内侧（宽度取排版层的 `calloutBarWidth` —— 它落在内边距里，
  // 所以画多宽都不会挤到文字）
  context.fillStyle = accent
  context.fillRect(rect.x, rect.y, metrics.calloutBarWidth * scale, rect.height)

  const padding = metrics.calloutPadding * scale
  const titleLineHeight = lineHeightFor(block, metrics) * scale
  item.lines.forEach((line, index) => {
    drawRuns(
      context,
      line,
      {
        x: rect.x + padding,
        centerY: rect.y + padding + index * titleLineHeight + titleLineHeight / 2,
        lineHeight: titleLineHeight,
        base: fontFor(block, metrics),
        color: accent,
      },
      env,
    )
  })

  const children = item.children ?? []
  let cursor = rect.y + geometry.bodyTop * scale
  children.forEach((child, index) => {
    drawBlock(context, child, rect.x + padding, cursor, env)
    cursor += child.height * scale
    if (index < children.length - 1) cursor += child.gapAfter * scale
  })
}

// ---------------------------------------------------------------------------
// 基础绘制（每个都显式设状态：这些状态是全局的，靠"上一步刚好设对了"迟早出错）
// ---------------------------------------------------------------------------

/** 一条 1px 直线（分隔线、下划线、表格网格共用）。虚线由 `dashed` 决定。 */
function drawLine(
  context: PaintContext,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  dashed: boolean,
): void {
  context.strokeStyle = color
  context.lineWidth = 1
  context.setLineDash(dashed ? [...LINK_DASH] : [])
  context.beginPath()
  context.moveTo(x1, y1)
  context.lineTo(x2, y2)
  context.stroke()
  // 用完就复位：`setLineDash` 是状态而不是参数，留给下一个绘制调用会让它莫名变成虚线
  context.setLineDash([])
}

/**
 * 圆角矩形路径（`beginPath` 已包含，调用方接着 `fill()` / `stroke()`）。
 *
 * 用 `arc` 而不是 `quadraticCurveTo`：四分之一圆在 canvas 里 `arc` 是最直接、最不容易画错的表达
 * （二次贝塞尔的半径补偿系数 0.5523 抄错一位就会看起来"圆角有点尖"，而这里没有理由冒那个险）。
 *
 * 半径夹在 `min(radius, 宽/2, 高/2)`：极扁的卡片（内容只有一行时高度可能不到半径的两倍）
 * 若半径过大，弧的圆心会跑到矩形外面，画出来是一个凸出去的花形 —— 夹一下就不必再想这件事。
 */
function roundRectPath(context: PaintContext, rect: Rect, radius: number): void {
  const r = Math.max(0, Math.min(radius, rect.width / 2, rect.height / 2))
  const right = rect.x + rect.width
  const bottom = rect.y + rect.height

  context.beginPath()
  context.moveTo(rect.x + r, rect.y)
  context.lineTo(right - r, rect.y)
  context.arc(right - r, rect.y + r, r, -Math.PI / 2, 0)
  context.lineTo(right, bottom - r)
  context.arc(right - r, bottom - r, r, 0, Math.PI / 2)
  context.lineTo(rect.x + r, bottom)
  context.arc(rect.x + r, bottom - r, r, Math.PI / 2, Math.PI)
  context.lineTo(rect.x, rect.y + r)
  context.arc(rect.x + r, rect.y + r, r, Math.PI, (Math.PI * 3) / 2)
  context.closePath()
}
