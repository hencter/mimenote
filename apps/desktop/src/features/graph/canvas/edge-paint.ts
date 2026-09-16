/**
 * 连线的**画笔**（把连线画到 card 那一层 canvas 上）。
 *
 * 这一层是 ADR-0036 的主角：连线原先是一层 React 渲染的 `<svg>`（`GraphEdges.tsx`）。
 * 搬进 canvas 有三个直接后果，也正是这次搬迁的理由：
 *
 * 1. **漂浮能真到 60fps**：位置一变，卡片的 canvas 本来就要重画，连线跟着一起画是顺手的；
 *    留在 SVG 里则意味着"每帧一次 React 渲染"（`FLOAT_FPS` 因此被压在 20）。
 * 2. **图层关系变简单**：原先靠三层 DOM（连线 0 < 卡片 1 < 引线 2）凑出来，现在就是
 *    同一次绘制里的三段顺序 —— 见文件末尾"两层的分工"。
 * 3. **命中测试要自己来**：canvas 里没有"元素"可挂 `<title>`（顺带说明：SVG 那一版的
 *    tooltip 其实**从来没出现过** —— `.mn-graph__edges` 上写着 `pointer-events: none`，
 *    子元素继承它，鼠标永远落不到那条 path 上）。`PaintedEdge.commands` 就是给这件事用的：
 *    调用方拿它算"指针离线多远"，再决定悬停的是哪条边。
 *
 * ## 观感的口径：`graph.css` 是样式表，几何层是权重
 *
 * 每一档的粗细 / 不透明度 / 颜色都对着 `graph.css` 里那几条规则逐字复刻
 * （`tests/graph-edge-paint.test.ts` 会**读样式表**把它们钉住，改 CSS 忘了改这里会红）。
 * 唯一的例外是 `EdgeStyle.width` / `.opacity`：
 *
 * 在 SVG 那一版里，这两个字段是写在 path 上的**表现属性**，而任何 CSS 规则都能盖过表现属性
 * —— 于是 `graph.css` 的 `.mn-graph-edge { stroke-width: 1.6; opacity: .5 }` 一直赢，
 * "越远越细越淡"的跳数权重（`GraphCanvas.tsx` 的 `EDGE_WEIGHT_BY_HOP`）**从来没生效过**，
 * 而那段代码上方的注释恰恰在强调"不能替换、必须调制"。canvas 里没有这种优先级暗礁，
 * 所以这里按**写下来的意图**实现：
 *
 * - 给了 `width` / `opacity`（焦点视图）→ 就用它（跳数权重 × 强调/淡化的调制）；
 * - 没给（全库视图）→ 退到 `graph.css` 的那三档（1.6/0.5、2.2/0.95、1/0.16）。
 *
 * 两套语义各自完整，不互相猜 —— 与 `GraphEdges.tsx` 当年的注释所计划的一致，
 * 只是那时它没能真的做到。
 */

import type { EdgeStyle, GraphEdgeVisual, Point } from '../layout'
import { leadDash } from '../link-edge'
import { type PaintContext, screenPoint, type ViewOffset } from './context'
import {
  distanceToPath,
  endDirection,
  parsePathData,
  tracePath,
  type PathCommand,
} from './edge-path'
import type { GraphPalette } from './palette'

/** 画哪一层（见文件末尾"两层的分工"）。 */
export type EdgeLayer = 'span' | 'lead'

export interface EdgePaintInput {
  visuals: readonly GraphEdgeVisual[]
  /** 世界 → 屏幕（`screen = world × scale + offset`，与卡片层同一份）。 */
  transform: ViewOffset
  /** 安全化之后的缩放（调用方已经保证它是有限正数，见 `paint.ts` 的 `normalizeScale`）。 */
  scale: number
  palette: GraphPalette
}

/**
 * 一条边**这一帧被画成了什么样**。
 *
 * 为什么要把这些交回去：canvas 上没有 DOM 可以查，于是
 * 1. 悬停命中要用 `commands`（`distanceToPath`）；
 * 2. 自动化（测试与 UI E2E）要断言"提亮的边有几条、悬空边的目标名画了没有" ——
 *    它们读的就是这份记录，而不是去截图里数像素。
 *
 * 记录里的 `commands` 是**世界坐标**：与几何层同口径，缩放/平移怎么变都不用重算。
 */
export interface PaintedEdge {
  readonly key: string
  readonly layer: EdgeLayer
  readonly commands: readonly PathCommand[]
  /**
   * 这条线画成了什么形状（几何层给的那串路径里最高级的命令）。
   *
   * `'arc'` = 几何层用 `A` 画了**沿环的弧**（`edge-routing.ts` 的 `ringArcPath` 产生的）。
   * 为什么记录它：`A` 在解析时被展开成贝塞尔了（`edge-path.ts`），于是"这一条走的是弧"
   * 从命令序列上**看不出来** —— 而它是 ADR-0028 的一条语义（同环走弧、跨环朝外鼓），
   * 自动化（测试与 UI E2E）需要一个抓手。
   */
  readonly shape: 'line' | 'curve' | 'arc'
  readonly dashed: boolean
  readonly highlight: boolean
  readonly hue: 'out' | 'in' | 'context'
  /** 淡化档（与圆心/选中无关）—— "淡化不等于隐藏"这条语义靠它可断言。 */
  readonly dim: boolean
  /** 悬空边（目标笔记还不存在）：终点画了虚影小圆 + 目标名。 */
  readonly phantom: boolean
  /** 悬空边直接标在虚影旁的目标名（`null` = 没画）。 */
  readonly label: string | null
  /** tooltip 文案（与 SVG 那一版的 `<title>` 逐字相同）。 */
  readonly title: string
}

/**
 * 路径串里的形状（判据只有一处：几何层怎么写形状）。
 *
 * 为什么按**字符串**判而不是按展开后的命令判：`A` 已经被展开成贝塞尔了，
 * 命令序列上"弧"与"曲线"长得一样（都是 `cubic`）。判据因此只能是"几何层用了哪个字母"，
 * 而这三个字母的产地在 `layout.ts` / `edge-routing.ts` 里各只有一处。
 * 小写也一并认（相对命令虽然几何层不产出，但解析器已经按绝对坐标处理过 —— 这里只是分类）。
 */
function shapeOf(d: string): 'line' | 'curve' | 'arc' {
  if (/[Aa]/.test(d)) return 'arc'
  if (/[Cc]/.test(d)) return 'curve'
  return 'line'
}

// ---------------------------------------------------------------------------
// 样式常量（对着 graph.css 复刻，有测试钉住）
// ---------------------------------------------------------------------------

/** `.mn-graph-edge`：stroke 走色相，粗细与不透明度是全库视图的缺省。 */
const EDGE_DEFAULT = { width: 1.6, alpha: 0.5 }

/** `.mn-graph-edge--highlight`：与选中/圆心相关。 */
const EDGE_HIGHLIGHT = { width: 2.2, alpha: 0.95 }

/** `.mn-graph-edge--dim`：与选中/圆心无关（淡化但不隐藏）。 */
const EDGE_DIM = { width: 1, alpha: 0.16 }

/** `.mn-graph-edge--dashed { stroke-dasharray: 5 4 }`。 */
const EDGE_DASH: readonly [number, number] = [5, 4]

/**
 * 箭头（原 `<marker>` 的定义：`viewBox="0 0 10 10"` + `markerWidth/Height=6` + `refX=9`）。
 *
 * `markerUnits` 缺省是 `strokeWidth`，所以箭头的大小是**线宽的倍数**：
 * 长 = `10 × 6/10 = 6` 倍线宽、半宽 = `5 × 6/10 = 3` 倍线宽，箭尖落在路径终点上
 * （`refX=9` 的那一点对齐到终点）。搬进 canvas 时这几个倍数照抄，
 * 于是"线粗箭头也粗"的观感不变（跳数权重生效之后，近处的箭头会比以前大一点）。
 */
const ARROW = { lengthFactor: 6, halfWidthFactor: 3 }

/** `.mn-graph-arrow--default path` / `--dim` / 两个色相变体的 `opacity`。 */
const ARROW_ALPHA = { default: 0.6, dim: 0.2, hue: 0.9, highlight: 1 }

/** `.mn-graph-edge--lead` / `--lead--active` / `.mn-graph-edge-lead-dot`。 */
const LEAD = {
  width: 1.6,
  alpha: 0.85,
  activeWidth: 2,
  activeAlpha: 1,
  dotRadius: 2,
  dotAlpha: 0.9,
}

/** `.mn-graph-phantom` + `.mn-graph-phantom-label`。 */
const PHANTOM = {
  radius: 4,
  width: 1.4,
  dash: [2, 2] as readonly [number, number],
  labelSize: 10,
  labelDx: 8,
  /** 文字基线相对虚影圆心的纵向偏移（SVG 里那个 `y + 3.5`）。 */
  labelDy: 3.5,
  labelAlpha: 1,
}

// ---------------------------------------------------------------------------
// 样式判据
// ---------------------------------------------------------------------------

/** 一条边的线：颜色 / 线宽 / 不透明度 / 虚线图案（都是**世界单位**，画的时候再乘 scale）。 */
export interface EdgeLineStyle {
  readonly stroke: string
  readonly width: number
  readonly alpha: number
  readonly dash: readonly number[]
}

/** 色相 → 颜色（`graph.css` 的 `--out` / `--in` / `--context` 三条）。 */
function hueColor(hue: EdgeStyle['hue'], palette: GraphPalette): string {
  if (hue === 'out') return palette.edgeOut
  if (hue === 'in') return palette.edgeIn
  return palette.edge
}

/**
 * 线的样式。
 *
 * 判据顺序与 `graph.css` 里那几条规则的书写顺序**逐字对应**（同权重时后者胜）：
 * 色相 → 强调（accent 压过色相）→ 淡化（最强的两个信号各占一端）。
 * 强调与淡化在数据上互斥（`GraphCanvas` 里 `dim = !highlight`），这里不额外判一次 ——
 * 多一条"它们不可能同时为真"的保险，只会在将来真的同时为真时替调用方做一个静默的选择。
 */
export function edgeLineStyle(visual: GraphEdgeVisual, palette: GraphPalette): EdgeLineStyle {
  const { style } = visual
  const stroke = style.highlight ? palette.edgeActive : hueColor(style.hue, palette)
  const fallback = style.highlight ? EDGE_HIGHLIGHT : style.dim ? EDGE_DIM : EDGE_DEFAULT
  return {
    stroke,
    width: style.width ?? fallback.width,
    alpha: style.opacity ?? fallback.alpha,
    dash: style.dashed ? EDGE_DASH : [],
  }
}

/** 箭头的填充色与它自己那一档不透明度（元素的不透明度由调用方再乘一次）。 */
export function edgeArrowStyle(
  visual: GraphEdgeVisual,
  palette: GraphPalette,
): { fill: string; alpha: number } {
  const { style } = visual
  if (style.highlight) return { fill: palette.edgeActive, alpha: ARROW_ALPHA.highlight }
  if (style.dim) return { fill: palette.edge, alpha: ARROW_ALPHA.dim }
  // 只覆盖 default 那一档的色相（强调/淡化两档是中性的，见 graph.css 的注释）
  if (style.hue === 'out') return { fill: palette.edgeOut, alpha: ARROW_ALPHA.hue }
  if (style.hue === 'in') return { fill: palette.edgeIn, alpha: ARROW_ALPHA.hue }
  return { fill: palette.edge, alpha: ARROW_ALPHA.default }
}

// ---------------------------------------------------------------------------
// 绘制
// ---------------------------------------------------------------------------

/**
 * 画一层连线，返回这一层画出来的记录。
 *
 * 状态一律用 `save`/`restore` 包起来：`globalAlpha` / `strokeStyle` / `lineDash` 是画布的
 * **全局状态**，泄漏出去会让后面画的卡片变成半透明或带着虚线 —— 那类故障没有异常、
 * 只是"看起来不对"，是最难归因的一种（`paint.ts` 里卡片那段同样为此包了三件套）。
 */
export function paintEdgeLayer(
  context: PaintContext,
  input: EdgePaintInput,
  layer: EdgeLayer,
): PaintedEdge[] {
  const { transform, scale, palette } = input
  const painted: PaintedEdge[] = []
  const map = (point: Point): Point => screenPoint(point, transform, scale)

  for (const visual of input.visuals) {
    if (layer === 'lead') {
      const record = paintLead(context, visual, map, scale, palette)
      if (record !== null) painted.push(record)
      continue
    }
    painted.push(paintSpan(context, visual, map, scale, palette))
  }
  return painted
}

/**
 * 卡外那一段：张力曲线 + 箭头（+ 悬空边的虚影与目标名）。
 *
 * 端点是几何层给的 `exit` / `entry`（`visual.start` / `visual.end`）—— 这里**不做任何取整**：
 * 与卡内那段引线的分界点逐坐标相同是 ADR-0023 的硬纪律，少一个 `Math.round` 就少一道半像素的缝。
 */
function paintSpan(
  context: PaintContext,
  visual: GraphEdgeVisual,
  map: (point: Point) => Point,
  scale: number,
  palette: GraphPalette,
): PaintedEdge {
  const commands = parsePathData(visual.d)
  const style = edgeLineStyle(visual, palette)

  context.save()
  context.globalAlpha = style.alpha
  context.strokeStyle = style.stroke
  // 线宽与虚线图案都乘 scale：世界单位 → CSS 像素（SVG 那一版是 viewBox 替我们做的这件事）
  context.lineWidth = style.width * scale
  context.setLineDash(style.dash.map((segment) => segment * scale))
  context.lineDashOffset = 0
  context.beginPath()
  tracePath(context, commands, map)
  context.stroke()
  context.setLineDash([])

  // 箭头：位置在终点、朝向是终点的切向（与 `orient="auto"` 同一件事）
  const arrow = edgeArrowStyle(visual, palette)
  const direction = endDirection(commands)
  const tip = map(visual.end)
  const length = ARROW.lengthFactor * style.width * scale
  const half = ARROW.halfWidthFactor * style.width * scale
  const baseX = tip.x - direction.x * length
  const baseY = tip.y - direction.y * length
  context.globalAlpha = style.alpha * arrow.alpha
  context.fillStyle = arrow.fill
  context.beginPath()
  context.moveTo(tip.x, tip.y)
  context.lineTo(baseX - direction.y * half, baseY + direction.x * half)
  context.lineTo(baseX + direction.y * half, baseY - direction.x * half)
  context.closePath()
  context.fill()

  // 悬空边：虚影小圆 + 目标名（"这里缺一篇笔记"必须一眼看见，不能只靠 tooltip）
  const label = visual.phantom ? visual.edge.toRawTarget : ''
  if (visual.phantom) {
    const center = map(visual.end)
    context.globalAlpha = style.alpha
    context.fillStyle = palette.cardBg
    context.strokeStyle = palette.warning
    context.lineWidth = PHANTOM.width * scale
    context.setLineDash(PHANTOM.dash.map((segment) => segment * scale))
    context.beginPath()
    context.arc(center.x, center.y, PHANTOM.radius * scale, 0, Math.PI * 2)
    context.fill()
    context.stroke()
    context.setLineDash([])

    if (label !== '') {
      // 字号也乘 scale：SVG 的 `font-size: 10px` 是用户单位（= 世界单位），缩放时会一起长
      context.globalAlpha = PHANTOM.labelAlpha
      context.font = `${PHANTOM.labelSize * scale}px ${palette.uiFont}`
      context.textAlign = 'start'
      context.textBaseline = 'alphabetic'
      context.fillStyle = palette.muted
      context.fillText(label, center.x + PHANTOM.labelDx * scale, center.y + PHANTOM.labelDy * scale)
    }
  }

  context.restore()
  return {
    key: visual.key,
    layer: 'span',
    commands,
    shape: shapeOf(visual.d),
    dashed: visual.style.dashed,
    highlight: visual.style.highlight,
    dim: visual.style.dim,
    hue: visual.style.hue ?? 'context',
    phantom: visual.phantom,
    label: label === '' ? null : label,
    title: visual.title,
  }
}

/**
 * 卡内那一段：从正文里 `[[链接]]` 那处文字到卡片边界的虚线（+ 起点小圆点）。
 *
 * 虚线相位按 `leadFrom → start` 的长度算（`leadDash`）：最后一段实线正好收在卡片边界上，
 * 于是卡内虚线、卡外实线、箭头三者共用同一个点 —— 这一条在 SVG 那一版就是硬纪律，
 * canvas 版原样保留（`lineDashOffset` 与 `stroke-dashoffset` 是同一套相位语义）。
 */
function paintLead(
  context: PaintContext,
  visual: GraphEdgeVisual,
  map: (point: Point) => Point,
  scale: number,
  palette: GraphPalette,
): PaintedEdge | null {
  const d = visual.leadPath
  if (d === undefined || d === '') return null
  const commands = parsePathData(d)
  const active = visual.style.highlight
  const length =
    visual.leadFrom === undefined
      ? 0
      : Math.hypot(visual.start.x - visual.leadFrom.x, visual.start.y - visual.leadFrom.y)
  const dash = leadDash(length)

  context.save()
  context.globalAlpha = active ? LEAD.activeAlpha : LEAD.alpha
  context.strokeStyle = active ? palette.edgeActive : palette.muted
  context.lineWidth = (active ? LEAD.activeWidth : LEAD.width) * scale
  context.setLineDash(dash.segments.map((segment) => segment * scale))
  context.lineDashOffset = dash.offset * scale
  context.beginPath()
  tracePath(context, commands, map)
  context.stroke()
  context.setLineDash([])
  context.lineDashOffset = 0

  if (visual.leadFrom !== undefined) {
    const dot = map(visual.leadFrom)
    context.globalAlpha = active ? 1 : LEAD.dotAlpha
    context.fillStyle = active ? palette.edgeActive : palette.muted
    context.beginPath()
    context.arc(dot.x, dot.y, LEAD.dotRadius * scale, 0, Math.PI * 2)
    context.fill()
  }

  context.restore()
  return {
    key: visual.key,
    layer: 'lead',
    commands,
    shape: shapeOf(d),
    dashed: true,
    highlight: active,
    // 引线不分淡化档：它是"这条边从哪句话出来"的指示，跟卡外那段的档位无关
    dim: false,
    hue: visual.style.hue ?? 'context',
    phantom: false,
    label: null,
    title: visual.title,
  }
}

/**
 * 路径第一条三次贝塞尔的"鼓出比"：第一个控制点到弦（起点→终点）的距离 ÷ 弦长。
 *
 * 为什么把它做成公开的纯函数：这个量**与位置、缩放、漂浮全都无关**，是"张力滑块真的改变了
 * 连线几何"唯一能被逐字断言的判据（`tensionPath` 的定义就是"控制点沿弦的垂直方向偏移
 * `tension × 弦长 × 0.25`"，所以这个比值恒等于 `tension ÷ 4`）。
 * 连线搬进 canvas 之前，它是 UI E2E 从 SVG 的 `d` 字符串里现算的；`d` 不再出现在 DOM 里之后，
 * 宿主上的 `data-graph-edge-bulges` 由这里算出来交给自动化 —— 与 `data-graph-card-rects`
 * 同一个思路：把"这一帧到底画成了什么样"变成界面上读得到的事实，而不是让测试去截图猜像素。
 *
 * 没有三次贝塞尔（直线、自环的退化分支）时返回 `null`：那种线量不出"鼓出多少"。
 */
export function bulgeRatio(commands: readonly PathCommand[]): number | null {
  for (let index = 1; index < commands.length; index += 1) {
    const command = commands[index]!
    if (command.kind !== 'cubic') continue
    const previous = commands[index - 1]!
    const from = previous.to
    const chordX = command.to.x - from.x
    const chordY = command.to.y - from.y
    const chord = Math.hypot(chordX, chordY)
    if (!(chord > 0)) continue
    // 点到弦所在直线的距离：叉积 ÷ 弦长
    const cross = Math.abs(
      (command.c1.x - from.x) * chordY - (command.c1.y - from.y) * chordX,
    )
    return cross / chord / chord
  }
  return null
}

/**
 * 指针落在哪条边上（世界坐标，`null` = 不在任何一条上）。
 *
 * 判据是"到折线的距离 ≤ `slop`"，取**最近**的那一条：两条边在卡片附近可能只差几个像素，
 * 按绘制顺序返回第一条会让"悬停到的那条"随数组顺序变化 —— 那是用户看不见但能感觉到的怪
 * （同一处时而显示 A、时而显示 B）。并列时取更近的，仍并列时取先画的那条（确定性）。
 *
 * `layer` 缺省只找卡外那段：卡内那段整个在卡片矩形里，它上面的悬停归"正文里那段
 * `[[链接]]`"的热区管（`GraphCanvas` 的 `linkAt`），两条判据抢同一个像素只会互相抵消。
 */
export function edgeAt(
  painted: readonly PaintedEdge[],
  world: Point,
  slop: number,
  layer: EdgeLayer = 'span',
): PaintedEdge | null {
  let best: PaintedEdge | null = null
  let bestDistance = Infinity
  for (const edge of painted) {
    if (edge.layer !== layer) continue
    const distance = distanceToPath(edge.commands, world)
    if (distance > slop) continue
    // 严格更近才换：并列时留住**先画的那条**（数组顺序 = 绘制顺序 ⇒ 结果确定）
    if (distance < bestDistance) {
      best = edge
      bestDistance = distance
    }
  }
  return best
}
