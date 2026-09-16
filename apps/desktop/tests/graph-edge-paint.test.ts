/**
 * 连线的画笔（`features/graph/canvas/edge-paint.ts`）与它的几何底座（`edge-path.ts`）。
 *
 * ## 这些用例为什么在这里（ADR-0036 的搬迁台账）
 *
 * 连线原先是一层 React 渲染的 `<svg>`（`GraphEdges.tsx`），断言写在 DOM 上：类名
 * （`--dashed` / `--highlight` / `--dim` / `--out` / `--in`）、`d` 的坐标、`stroke-width`
 * 属性、`<circle class="mn-graph-phantom">`、`stroke-dasharray` / `stroke-dashoffset`。
 * 搬进 canvas 之后这些载体全部消失，于是那些判据按"能在哪一层被**直接读到**"重新安家：
 *
 * | 判据 | 现在住在哪 |
 * | --- | --- |
 * | 路径串的语法（M/L/C/A、隐式重复、写错要抛错） | 本文件的 `edge-path` 一组 |
 * | 两段首尾相接（分界点逐坐标相同） | 本文件的"分界处严丝合缝"（读 `PaintedEdge.commands`） |
 * | 引线的图案与相位、卡外那段不带图案 | 本文件的 `paintEdgeLayer` 两组 |
 * | 箭头只画在卡外那段的终点 | 同上（三个 `lineTo` + `fill` 的几何） |
 * | 悬空边的虚影圆与目标名 | 同上（`arc` + `fillText` 的坐标与字号） |
 * | 提亮 / 淡化 / 色相 / 跳数权重 | 本文件的样式判据一组（纯函数，逐档断言） |
 * | "画出来几条提亮的线"这类**接线**判据 | `tests/graph.test.tsx`（宿主上的 `data-graph-edge-*`） |
 *
 * 判据只有一份：这里断言的是"画笔按什么规则画"，`graph.test.tsx` 断言的是"组件把哪些边交给了画笔"。
 *
 * ## 断言的来源纪律（与 `graph-paint.test.ts` 同一套）
 *
 * 期望值只来自两处：**手算的字面量**（`1.6 × 2 = 3.2`、"箭尖在终点、两个底角关于轴线对称"），
 * 或**被依赖层公开的契约数字**（`leadDash()` 的返回值）。绝不从实现里反推期望值 ——
 * 那样的测试只能证明"实现没变"。
 */

import { describe, expect, it } from 'vitest'

import {
  edgeAt,
  edgeArrowStyle,
  edgeLineStyle,
  paintEdgeLayer,
  type PaintedEdge,
} from '@/features/graph/canvas/edge-paint'
import {
  distanceToPath,
  endDirection,
  parsePathData,
  samplePoints,
  tracePath,
  type PathCommand,
} from '@/features/graph/canvas/edge-path'
import { paletteFrom, type GraphPalette } from '@/features/graph/canvas/palette'
import type { PaintContext, ViewTransform } from '@/features/graph/canvas/paint'
import { leadDash } from '@/features/graph/link-edge'
import type { EdgeStyle, GraphEdgeVisual, Point } from '@/features/graph/layout'

// ---------------------------------------------------------------------------
// 记录型假上下文（与 tests/graph-paint.test.ts 同一套做法）
// ---------------------------------------------------------------------------

type Op =
  | { readonly op: 'prop'; readonly name: string; readonly value: string | number }
  | { readonly op: 'save' }
  | { readonly op: 'restore' }
  | { readonly op: 'beginPath' }
  | { readonly op: 'closePath' }
  | { readonly op: 'moveTo'; readonly x: number; readonly y: number }
  | { readonly op: 'lineTo'; readonly x: number; readonly y: number }
  | {
      readonly op: 'bezierCurveTo'
      readonly c1x: number
      readonly c1y: number
      readonly c2x: number
      readonly c2y: number
      readonly x: number
      readonly y: number
    }
  | {
      readonly op: 'arc'
      readonly x: number
      readonly y: number
      readonly radius: number
      readonly startAngle: number
      readonly endAngle: number
    }
  | { readonly op: 'fill' }
  | { readonly op: 'stroke' }
  | { readonly op: 'fillText'; readonly text: string; readonly x: number; readonly y: number }
  | { readonly op: 'setLineDash'; readonly segments: readonly number[] }

const INITIAL: Readonly<Record<string, string | number>> = {
  font: '10px sans-serif',
  fillStyle: '#000000',
  strokeStyle: '#000000',
  lineWidth: 1,
  globalAlpha: 1,
  textAlign: 'start',
  textBaseline: 'alphabetic',
  lineJoin: 'miter',
  lineDash: '',
  lineDashOffset: 0,
}

class RecordingContext implements PaintContext {
  readonly ops: Op[] = []
  private readonly props = new Map<string, Array<string | number>>()

  get font(): string {
    return this.stringProp('font')
  }
  set font(value: string) {
    this.record('font', value)
  }
  get fillStyle(): string {
    return this.stringProp('fillStyle')
  }
  set fillStyle(value: string) {
    this.record('fillStyle', value)
  }
  get strokeStyle(): string {
    return this.stringProp('strokeStyle')
  }
  set strokeStyle(value: string) {
    this.record('strokeStyle', value)
  }
  get lineWidth(): number {
    return this.numberProp('lineWidth')
  }
  set lineWidth(value: number) {
    this.record('lineWidth', value)
  }
  get globalAlpha(): number {
    return this.numberProp('globalAlpha')
  }
  set globalAlpha(value: number) {
    this.record('globalAlpha', value)
  }
  get textAlign(): string {
    return this.stringProp('textAlign')
  }
  set textAlign(value: string) {
    this.record('textAlign', value)
  }
  get textBaseline(): string {
    return this.stringProp('textBaseline')
  }
  set textBaseline(value: string) {
    this.record('textBaseline', value)
  }
  get lineJoin(): string {
    return this.stringProp('lineJoin')
  }
  set lineJoin(value: string) {
    this.record('lineJoin', value)
  }
  get lineDashOffset(): number {
    return this.numberProp('lineDashOffset')
  }
  set lineDashOffset(value: number) {
    this.record('lineDashOffset', value)
  }

  save(): void {
    this.ops.push({ op: 'save' })
  }
  restore(): void {
    this.ops.push({ op: 'restore' })
  }
  setTransform(): void {}
  clearRect(): void {}
  beginPath(): void {
    this.ops.push({ op: 'beginPath' })
  }
  closePath(): void {
    this.ops.push({ op: 'closePath' })
  }
  rect(): void {}
  clip(): void {}
  moveTo(x: number, y: number): void {
    this.ops.push({ op: 'moveTo', x, y })
  }
  lineTo(x: number, y: number): void {
    this.ops.push({ op: 'lineTo', x, y })
  }
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    this.ops.push({ op: 'bezierCurveTo', c1x, c1y, c2x, c2y, x, y })
  }
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void {
    this.ops.push({ op: 'arc', x, y, radius, startAngle, endAngle })
  }
  fill(): void {
    this.ops.push({ op: 'fill' })
  }
  stroke(): void {
    this.ops.push({ op: 'stroke' })
  }
  fillRect(): void {}
  strokeRect(): void {}
  fillText(text: string, x: number, y: number): void {
    this.ops.push({ op: 'fillText', text, x, y })
  }
  measureText(text: string): { width: number } {
    return { width: Array.from(text).length * 7 }
  }
  setLineDash(segments: number[]): void {
    this.ops.push({ op: 'setLineDash', segments: [...segments] })
  }

  /** 第 `index` 条 op **执行时**的画笔状态（把属性赋值按 save/restore 栈重放一遍）。 */
  stateAt(index: number): Readonly<Record<string, string | number>> {
    let state: Record<string, string | number> = { ...INITIAL }
    const stack: Array<Record<string, string | number>> = []
    for (let position = 0; position <= index; position += 1) {
      const op = this.ops[position]
      if (op === undefined) continue
      if (op.op === 'prop') state = { ...state, [op.name]: op.value }
      else if (op.op === 'setLineDash') state = { ...state, lineDash: op.segments.join(',') }
      else if (op.op === 'save') stack.push({ ...state })
      else if (op.op === 'restore') state = stack.pop() ?? state
    }
    return state
  }

  /** 每一次 `stroke()` 的位置。 */
  strokePositions(): number[] {
    return this.ops.flatMap((op, position) => (op.op === 'stroke' ? [position] : []))
  }

  /** 第 `index` 次 `stroke()` 时的状态。 */
  strokeState(index: number): Readonly<Record<string, string | number>> {
    const position = this.strokePositions()[index]
    if (position === undefined) throw new Error(`没有第 ${index} 次 stroke`)
    return this.stateAt(position)
  }

  /** 每一次 `fillText()` 的入参与坐标。 */
  texts(): Array<{ text: string; x: number; y: number }> {
    return this.ops.flatMap((op) =>
      op.op === 'fillText' ? [{ text: op.text, x: op.x, y: op.y }] : [],
    )
  }

  /** 每一次 `arc()`。 */
  arcs(): Array<{ x: number; y: number; radius: number }> {
    return this.ops.flatMap((op) =>
      op.op === 'arc' ? [{ x: op.x, y: op.y, radius: op.radius }] : [],
    )
  }

  /** 某一段路径的绘制调用（第 `index` 次 `stroke()` 那次 `beginPath` 之后的 moveTo/lineTo/…）。 */
  pathOfStroke(index: number): Op[] {
    const stroke = this.strokePositions()[index]
    if (stroke === undefined) throw new Error(`没有第 ${index} 次 stroke`)
    let start = stroke
    while (start > 0 && this.ops[start]!.op !== 'beginPath') start -= 1
    return this.ops.slice(start, stroke)
  }

  private record(name: string, value: string | number): void {
    this.ops.push({ op: 'prop', name, value })
    const list = this.props.get(name)
    if (list === undefined) this.props.set(name, [value])
    else list.push(value)
  }

  private last(name: string): string | number | undefined {
    return this.props.get(name)?.at(-1)
  }

  private stringProp(name: string): string {
    const value = this.last(name)
    return typeof value === 'string' ? value : ''
  }

  private numberProp(name: string): number {
    const value = this.last(name)
    return typeof value === 'number' ? value : 0
  }
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 哨兵色：断言里出现 `#11` 就一定是"出链的色相"，不可能是撞色。 */
const palette: GraphPalette = {
  background: '#01',
  cardBg: '#02',
  cardBorder: '#03',
  cardBorderFocus: '#04',
  title: '#05',
  text: '#06',
  muted: '#07',
  link: '#08',
  codeBg: '#09',
  codeText: '#0a',
  quoteBorder: '#0b',
  edge: '#0c',
  edgeActive: '#0d',
  edgeOut: '#11',
  edgeIn: '#12',
  warning: '#13',
  uiFont: '哨兵界面字体',
  imageBox: '#0e',
}

const VIEW: ViewTransform = { scale: 1, offsetX: 0, offsetY: 0, width: 800, height: 600 }

/** 一条连线（最小完整形态）。路径串用**直线**：端点坐标能在断言里逐字出现。 */
function visual(options: {
  from: Point
  to: Point
  key?: string
  leadFrom?: Point
  phantom?: boolean
  target?: string
  title?: string
  style?: Partial<EdgeStyle>
}): GraphEdgeVisual {
  const phantom = options.phantom === true
  const base: GraphEdgeVisual = {
    key: options.key ?? 'k',
    edge: {
      fromRelPath: 'a.md',
      toRelPath: phantom ? null : 'b.md',
      toRawTarget: options.target ?? (phantom ? '还不存在的笔记' : 'b'),
      kind: 'wiki',
      count: 1,
    },
    style: { dashed: false, dim: false, highlight: false, ...options.style },
    d: `M ${options.from.x} ${options.from.y} L ${options.to.x} ${options.to.y}`,
    start: options.from,
    end: options.to,
    phantom,
    title: options.title ?? '甲 → 乙',
  }
  if (options.leadFrom === undefined) return base
  return {
    ...base,
    leadPath: `M ${options.leadFrom.x} ${options.leadFrom.y} L ${options.from.x} ${options.from.y}`,
    leadFrom: options.leadFrom,
  }
}

function paint(
  visuals: readonly GraphEdgeVisual[],
  layer: 'span' | 'lead',
  transform: ViewTransform = VIEW,
): { context: RecordingContext; painted: PaintedEdge[] } {
  const context = new RecordingContext()
  const painted = paintEdgeLayer(
    context,
    { visuals, transform, scale: transform.scale, palette },
    layer,
  )
  return { context, painted }
}

// ---------------------------------------------------------------------------
// 路径模型
// ---------------------------------------------------------------------------

describe('edge-path：路径串 → 命令序列', () => {
  it('直线与三次贝塞尔解析成对应的命令', () => {
    expect(parsePathData('M 10 20 L 30 40')).toEqual([
      { kind: 'move', to: { x: 10, y: 20 } },
      { kind: 'line', to: { x: 30, y: 40 } },
    ])
    expect(parsePathData('M 0 0 C 1 2, 3 4, 5 6')).toEqual([
      { kind: 'move', to: { x: 0, y: 0 } },
      { kind: 'cubic', c1: { x: 1, y: 2 }, c2: { x: 3, y: 4 }, to: { x: 5, y: 6 } },
    ])
  })

  it('隐式重复：`M` 之后多出来的坐标对是 `L`（SVG 规范），不是第二个 `M`', () => {
    expect(parsePathData('M 0 0 10 0 20 5')).toEqual([
      { kind: 'move', to: { x: 0, y: 0 } },
      { kind: 'line', to: { x: 10, y: 0 } },
      { kind: 'line', to: { x: 20, y: 5 } },
    ])
    // 六元组重复 = 又一条三次贝塞尔
    const cubics = parsePathData('M 0 0 C 1 0, 2 0, 3 0 4 0, 5 0, 6 0')
    expect(cubics.filter((command) => command.kind === 'cubic')).toHaveLength(2)
  })

  it('几何层给的小数/负数/科学计数法都读得出来（`String(数字)` 的格式）', () => {
    const commands = parsePathData('M -12.5 1e-7 L 0.25 -3')
    expect(commands[0]).toEqual({ kind: 'move', to: { x: -12.5, y: 1e-7 } })
    expect(commands[1]).toEqual({ kind: 'line', to: { x: 0.25, y: -3 } })
  })

  it('写错的地方当场抛错，且错信息能定位（不猜、不近似）', () => {
    // 不认识的命令
    expect(() => parsePathData('M 0 0 Q 1 1 2 2')).toThrow(/Q/)
    // 小写相对坐标：几何层从不产出它，见到就是换了写法
    expect(() => parsePathData('m 0 0 l 1 1')).toThrow(/m/)
    // 数字个数不是参数个数的整数倍
    expect(() => parsePathData('M 0 0 C 1 2, 3 4')).toThrow(/3/)
    // 不以 M 开头
    expect(() => parsePathData('L 1 1')).toThrow(/M/)
  })

  it('椭圆弧（`A`）按规范换算圆心与扫角，并**精确**落在两端点上', () => {
    /*
      半径 10、从 (10,0) 到 (0,10)、`sweep = 1`（顺时针，SVG 的 y 轴朝下）：
      圆心因此是**原点**，弧走右上那一小段（largeArc = 0 ⇒ 走短的那一边）。
      每 90° 一段贝塞尔，因此这里应当只有一段（`ceil(90/90) = 1`）。
    */
    const commands = parsePathData('M 10 0 A 10 10 0 0 1 0 10')
    const cubics = commands.filter(
      (command): command is Extract<PathCommand, { kind: 'cubic' }> => command.kind === 'cubic',
    )
    expect(cubics).toHaveLength(1)
    // 终点**逐坐标**等于规范给的点（分界处的严丝合缝不能有浮点累计误差）
    expect(cubics[0]!.to).toEqual({ x: 0, y: 10 })
    // 每个采样点到圆心的距离都是 10，误差来自"每 90° 一段三次贝塞尔"的**已知**逼近偏差
    // （`4/3·tan(θ/4)` 的经典系数，量级 2/10000 半径 ⇒ 半径 10 时约 0.002）：
    // 它远小于线宽的一半，肉眼不可见，但这里如实量出来，免得后人以为解析错了
    for (const point of samplePoints(commands, 8)) {
      expect(Math.abs(Math.hypot(point.x, point.y) - 10)).toBeLessThan(0.003)
    }
    // 中点附近是 45° 方向（(10,0) → (0,10) 的短弧经过 (7.07, 7.07)）
    const middle = samplePoints(commands, 8)[4]!
    expect(middle.x).toBeCloseTo(10 * Math.SQRT1_2, 6)
    expect(middle.y).toBeCloseTo(10 * Math.SQRT1_2, 6)
  })

  it('弧的半径退化成 0 时按规范当作直线段', () => {
    expect(parsePathData('M 0 0 A 0 0 0 0 1 5 5')).toEqual([
      { kind: 'move', to: { x: 0, y: 0 } },
      { kind: 'line', to: { x: 5, y: 5 } },
    ])
  })

  it('采样：直线只给两端；曲线按 perCurve 给 perCurve + 1 个点', () => {
    expect(samplePoints(parsePathData('M 0 0 L 10 0'))).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ])
    const points = samplePoints(parsePathData('M 0 0 C 0 0, 10 0, 10 0'), 4)
    expect(points).toHaveLength(5)
    expect(points[0]).toEqual({ x: 0, y: 0 })
    expect(points.at(-1)).toEqual({ x: 10, y: 0 })
    // 控制点都在同一条直线上 ⇒ 曲线退化成直线，中点就是 (5, 0)
    expect(points[2]!.x).toBeCloseTo(5, 6)
    expect(points[2]!.y).toBeCloseTo(0, 6)
  })

  it('命中距离：点在线上为 0；离线 3 就是 3；曲线按采样折线近似', () => {
    const line = parsePathData('M 0 0 L 100 0')
    expect(distanceToPath(line, { x: 40, y: 0 })).toBe(0)
    expect(distanceToPath(line, { x: 40, y: 3 })).toBeCloseTo(3, 9)
    // 端点之外：距离按"到端点的距离"算（clamp 到线段），不是延伸到无限远
    expect(distanceToPath(line, { x: 130, y: 4 })).toBeCloseTo(Math.hypot(30, 4), 9)
    // 曲线：控制点拉到 ±40，t = 0.5 处是 (50, 30)（三次贝塞尔的权 1/8,3/8,3/8,1/8）
    const curve = parsePathData('M 0 0 C 0 40, 100 40, 100 0')
    const atMid = samplePoints(curve, 16)[8]!
    expect(atMid.x).toBeCloseTo(50, 6)
    expect(atMid.y).toBeCloseTo(30, 6)
    expect(distanceToPath(curve, atMid)).toBeCloseTo(0, 9)
    // 曲线外一点：距中点正上方 5 ⇒ 至少 5（采样折线只会让估计更保守）
    expect(distanceToPath(curve, { x: 50, y: 35 })).toBeCloseTo(5, 6)
  })

  it('终点切向：贝塞尔用"终点 − 第二个控制点"；退化时依次回退', () => {
    // 终点 (100, 100)、c2 = (0, 100) ⇒ 切向朝 +x
    expect(endDirection(parsePathData('M 0 0 C 0 50, 0 100, 100 100'))).toEqual({ x: 1, y: 0 })
    // c2 与终点重合 ⇒ 退到"终点 − c1"：c1 = (0,0) ⇒ 对角线方向
    const diagonal = endDirection(parsePathData('M 0 0 C 0 0, 100 100, 100 100'))
    expect(diagonal.x).toBeCloseTo(Math.SQRT1_2, 9)
    expect(diagonal.y).toBeCloseTo(Math.SQRT1_2, 9)
    // 全都退化 ⇒ 兜底 (1, 0)，不返回 NaN
    expect(endDirection(parsePathData('M 5 5 C 5 5, 5 5, 5 5'))).toEqual({ x: 1, y: 0 })
  })

  it('tracePath 把命令画到目标上，坐标经过世界 → 屏幕的映射', () => {
    const context = new RecordingContext()
    tracePath(context, parsePathData('M 10 20 L 30 40'), (point) => ({
      x: point.x * 2 + 100,
      y: point.y * 2 + 50,
    }))
    expect(context.ops).toEqual([
      { op: 'moveTo', x: 120, y: 90 },
      { op: 'lineTo', x: 160, y: 130 },
    ])
  })
})

// ---------------------------------------------------------------------------
// 样式判据
// ---------------------------------------------------------------------------

describe('edge-paint：线的样式判据', () => {
  it('色相三色：出链暖、入链冷、环间中性', () => {
    const at = (hue: 'out' | 'in' | 'context'): string =>
      edgeLineStyle(visual({ from: { x: 0, y: 0 }, to: { x: 10, y: 0 }, style: { hue } }), palette)
        .stroke
    expect(at('out')).toBe(palette.edgeOut)
    expect(at('in')).toBe(palette.edgeIn)
    expect(at('context')).toBe(palette.edge)
  })

  it('强调压过色相、淡化仍是色相色（与 graph.css 的书写顺序一致）', () => {
    const highlighted = edgeLineStyle(
      visual({ from: { x: 0, y: 0 }, to: { x: 10, y: 0 }, style: { hue: 'out', highlight: true } }),
      palette,
    )
    expect(highlighted.stroke).toBe(palette.edgeActive)
    const dimmed = edgeLineStyle(
      visual({ from: { x: 0, y: 0 }, to: { x: 10, y: 0 }, style: { hue: 'in', dim: true } }),
      palette,
    )
    expect(dimmed.stroke).toBe(palette.edgeIn)
  })

  it('两套语义：几何层给了 width / opacity 就用它（跳数权重），没给才退到缺省三档', () => {
    const base = { from: { x: 0, y: 0 }, to: { x: 10, y: 0 } }
    // 焦点视图：给什么用什么（这是"越远越细越淡"与"强调/淡化调制"的乘积）
    const weighted = edgeLineStyle(visual({ ...base, style: { width: 1.05, opacity: 0.216 } }), palette)
    expect(weighted.width).toBe(1.05)
    expect(weighted.alpha).toBe(0.216)
    // 全库视图：不给 ⇒ graph.css 那三档（普通 / 强调 / 淡化）
    const plain = edgeLineStyle(visual(base), palette)
    expect(plain.width).toBe(1.6)
    expect(plain.alpha).toBe(0.5)
    const highlight = edgeLineStyle(visual({ ...base, style: { highlight: true } }), palette)
    expect(highlight.width).toBe(2.2)
    expect(highlight.alpha).toBe(0.95)
    const dim = edgeLineStyle(visual({ ...base, style: { dim: true } }), palette)
    expect(dim.width).toBe(1)
    expect(dim.alpha).toBe(0.16)
  })

  it('虚线只有 dashed 那一条给图案（`graph.css` 的 `5 4`）', () => {
    const base = { from: { x: 0, y: 0 }, to: { x: 10, y: 0 } }
    expect(edgeLineStyle(visual({ ...base, style: { dashed: true } }), palette).dash).toEqual([5, 4])
    expect(edgeLineStyle(visual(base), palette).dash).toEqual([])
  })

  it('箭头四档的填充色与自己的不透明度（元素的不透明度由画笔再乘一次）', () => {
    const base = { from: { x: 0, y: 0 }, to: { x: 10, y: 0 } }
    const arrow = (style: Partial<EdgeStyle>): { fill: string; alpha: number } =>
      edgeArrowStyle(visual({ ...base, style }), palette)

    expect(arrow({ highlight: true })).toEqual({ fill: palette.edgeActive, alpha: 1 })
    expect(arrow({ dim: true })).toEqual({ fill: palette.edge, alpha: 0.2 })
    // 只覆盖 default 那一档的色相：出链/入链跟着线一起上色
    expect(arrow({ hue: 'out' })).toEqual({ fill: palette.edgeOut, alpha: 0.9 })
    expect(arrow({ hue: 'in' })).toEqual({ fill: palette.edgeIn, alpha: 0.9 })
    expect(arrow({ hue: 'context' })).toEqual({ fill: palette.edge, alpha: 0.6 })
  })
})

// ---------------------------------------------------------------------------
// 卡外那段
// ---------------------------------------------------------------------------

describe('paintEdgeLayer：卡外那段（span）', () => {
  const base = { from: { x: 0, y: 0 }, to: { x: 100, y: 0 } }

  it('线宽与虚线图案都乘缩放（世界单位 → CSS 像素，与 SVG 的 viewBox 同口径）', () => {
    const visualAt = visual({ ...base, style: { dashed: true, width: 1.6 } })
    const { context } = paint([visualAt], 'span', {
      scale: 2,
      offsetX: 10,
      offsetY: 20,
      width: 800,
      height: 600,
    })

    // 第 0 次 stroke 是那条线：线宽 1.6 × 2 = 3.2，图案 (5,4) × 2 = (10,8)
    expect(context.strokeState(0).lineWidth).toBeCloseTo(3.2, 9)
    expect(context.strokeState(0).lineDash).toBe('10,8')
    expect(context.strokeState(0).globalAlpha).toBe(0.5)
    expect(context.strokeState(0).strokeStyle).toBe(palette.edge)
    // 路径坐标也换算过：世界 (0,0) → 屏幕 (10,20)；(100,0) → (210,20)
    expect(context.pathOfStroke(0)).toEqual([
      { op: 'beginPath' },
      { op: 'moveTo', x: 10, y: 20 },
      { op: 'lineTo', x: 210, y: 20 },
    ])
  })

  it('箭头是一个填充三角形：箭尖在终点、两个底角关于轴线对称', () => {
    // 线宽 1.6（缺省）⇒ 箭头长 6×1.6 = 9.6、半宽 3×1.6 = 4.8（原 marker 的 markerUnits=strokeWidth）
    const { context } = paint([visual(base)], 'span')

    const arrowFill = context.ops.findIndex((op) => op.op === 'fill')
    expect(arrowFill).toBeGreaterThan(0)
    const path = context.ops
      .slice(0, arrowFill)
      .filter((op): op is Extract<Op, { op: 'moveTo' | 'lineTo' }> => op.op === 'moveTo' || op.op === 'lineTo')
      .slice(-3)
    // 箭尖 = 路径终点 (100, 0)
    expect(path[0]).toEqual({ op: 'moveTo', x: 100, y: 0 })
    // 底边中点在 (100 − 9.6, 0) = (90.4, 0)，两个底角关于轴线对称（在 y 上 ±4.8，顺序不参与断言）
    expect(path[1]!.x).toBeCloseTo(90.4, 9)
    expect(path[2]!.x).toBeCloseTo(90.4, 9)
    const corners = [path[1]!.y, path[2]!.y].sort((a, b) => a - b)
    expect(corners[0]).toBeCloseTo(-4.8, 9)
    expect(corners[1]).toBeCloseTo(4.8, 9)
    // 箭头颜色跟着状态走（缺省档用中性的边色，元素不透明度 × 箭头不透明度）
    expect(context.stateAt(arrowFill).fillStyle).toBe(palette.edge)
    expect(context.stateAt(arrowFill).globalAlpha).toBeCloseTo(0.5 * 0.6, 9)
  })

  it('悬空边：虚影小圆（虚线圆环）+ 直接标出目标名，字号也乘缩放', () => {
    const { context, painted } = paint(
      [visual({ ...base, to: { x: 200, y: 100 }, phantom: true, target: '还不存在的笔记' })],
      'span',
      { scale: 2, offsetX: 0, offsetY: 0, width: 800, height: 600 },
    )

    // 虚影圆：半径 4 × 2 = 8，圆心是换算后的终点 (400, 200)
    const phantom = context.arcs().find((arc) => Math.abs(arc.radius - 8) < 1e-9)
    expect(phantom).toEqual({ x: 400, y: 200, radius: 8 })
    // 目标名：画在圆心右 8×2 = 16、下 3.5×2 = 7 处，字号 10×2 = 20
    const label = context.texts()[0]
    expect(label).toEqual({ text: '还不存在的笔记', x: 416, y: 207 })
    const textPosition = context.ops.findIndex((op) => op.op === 'fillText')
    expect(String(context.stateAt(textPosition).font)).toBe(`20px ${palette.uiFont}`)
    expect(context.stateAt(textPosition).fillStyle).toBe(palette.muted)

    // 记录里如实带上"画了哪个名字"
    expect(painted[0]).toMatchObject({ phantom: true, label: '还不存在的笔记' })
  })

  it('返回的记录带着调用方要的全部事实（诊断属性与悬停命中都读它）', () => {
    const visualAt = visual({
      ...base,
      key: 'a→b',
      style: { dashed: true, highlight: true, hue: 'out', width: 2.2, opacity: 1 },
      title: '甲 → 乙',
    })
    const { painted } = paint([visualAt], 'span')

    expect(painted).toHaveLength(1)
    expect(painted[0]).toMatchObject({
      key: 'a→b',
      layer: 'span',
      shape: 'line', // 直线路径
      dashed: true,
      highlight: true,
      dim: false,
      hue: 'out',
      phantom: false,
      label: null,
      title: '甲 → 乙',
    })
    // 命令是**世界坐标**（与几何层同口径）：缩放怎么变都不用重算
    expect(painted[0]!.commands).toEqual([
      { kind: 'move', to: { x: 0, y: 0 } },
      { kind: 'line', to: { x: 100, y: 0 } },
    ])
  })

  it('形状如实记下"走的是弧"（`A` 在解析时已展开成贝塞尔，命令序列上看不出来）', () => {
    const arcVisual: GraphEdgeVisual = {
      ...visual(base),
      d: 'M 10 0 A 10 10 0 0 0 0 10',
    }
    const { painted } = paint([arcVisual], 'span')
    expect(painted[0]!.shape).toBe('arc')
    const curveVisual: GraphEdgeVisual = { ...visual(base), d: 'M 0 0 C 10 10, 20 10, 30 0' }
    expect(paint([curveVisual], 'span').painted[0]!.shape).toBe('curve')
  })
})

// ---------------------------------------------------------------------------
// 卡内那段引线
// ---------------------------------------------------------------------------

describe('paintEdgeLayer：卡内那段引线（lead）', () => {
  it('只画有引线的边；相位按 `leadFrom → start` 的长度算', () => {
    const withLead = visual({
      from: { x: 100, y: 0 },
      to: { x: 200, y: 0 },
      key: 'with-lead',
      leadFrom: { x: 40, y: 0 },
    })
    const withoutLead = visual({ from: { x: 0, y: 0 }, to: { x: 50, y: 0 }, key: 'no-lead' })
    const { context, painted } = paint([withLead, withoutLead], 'lead')

    expect(painted.map((edge) => edge.key)).toEqual(['with-lead'])
    // 引线长 60 ⇒ 图案 (3,3)、相位 (3 − 60 % 6 + 6) % 6 = 3（`leadDash` 的契约）
    const expected = leadDash(60)
    expect(context.strokeState(0).lineDash).toBe(expected.segments.join(','))
    expect(Number(context.strokeState(0).lineDashOffset)).toBeCloseTo(expected.offset, 9)
    // 引线的线宽/颜色/不透明度与卡外那段**刻意**不同（它是指示，不是边本身）
    expect(context.strokeState(0).lineWidth).toBeCloseTo(1.6, 9)
    expect(context.strokeState(0).strokeStyle).toBe(palette.muted)
    expect(context.strokeState(0).globalAlpha).toBeCloseTo(0.85, 9)
  })

  it('提亮时改成强调色 + 更粗（与卡外那段的高亮同一份判据）', () => {
    const { context } = paint(
      [
        visual({
          from: { x: 100, y: 0 },
          to: { x: 200, y: 0 },
          leadFrom: { x: 40, y: 0 },
          style: { highlight: true },
        }),
      ],
      'lead',
    )
    expect(context.strokeState(0).strokeStyle).toBe(palette.edgeActive)
    expect(context.strokeState(0).lineWidth).toBeCloseTo(2, 9)
    expect(context.strokeState(0).globalAlpha).toBe(1)
  })

  it('起点画一个小圆点（半径 2），并且**不画箭头**', () => {
    const { context, painted } = paint(
      [visual({ from: { x: 100, y: 0 }, to: { x: 200, y: 0 }, leadFrom: { x: 40, y: 0 } })],
      'lead',
    )

    expect(context.arcs()).toEqual([{ x: 40, y: 0, radius: 2 }])
    // 一次 fill（圆点）之外没有别的填充：箭头只属于卡外那段
    expect(context.ops.filter((op) => op.op === 'fill')).toHaveLength(1)
    expect(context.ops.filter((op) => op.op === 'lineTo')).toHaveLength(1) // 引线自己那一段
    expect(painted[0]).toMatchObject({ layer: 'lead', dashed: true, phantom: false, shape: 'line' })
  })

  it('分界处严丝合缝：引线的终点与卡外那段的起点逐坐标相同（ADR-0023 的硬纪律）', () => {
    /*
      两段共用同一个 `exit` 点：卡内那段的终点 = 卡外那段的起点。这条性质以前在 DOM 上验
      （配对两个 `<svg>` 里的 path），现在直接读记录 —— 一份记录里同时有两条命令序列，
      配对不再需要靠 `data-edge` 属性。
    */
    const shared = { x: 123.456789, y: -7.5 }
    const visualAt = visual({
      from: shared,
      to: { x: 300, y: 100 },
      key: 'pair',
      leadFrom: { x: 60.25, y: -7.5 },
    })
    const span = paint([visualAt], 'span').painted[0]!
    const lead = paint([visualAt], 'lead').painted[0]!

    const spanStart = span.commands[0]!
    const leadEnd = lead.commands.at(-1)!
    expect(spanStart.kind).toBe('move')
    expect(leadEnd.to).toEqual(spanStart.to)
    // 而且**不取整**：两边都是几何层给的那个原始小数
    expect(leadEnd.to).toEqual(shared)
  })
})

// ---------------------------------------------------------------------------
// 状态卫生与确定性
// ---------------------------------------------------------------------------

describe('paintEdgeLayer：状态与确定性', () => {
  it('每条边 save / restore 各一次，画完不留下任何状态残留', () => {
    const { context } = paint(
      [
        visual({ from: { x: 0, y: 0 }, to: { x: 50, y: 0 }, key: 'a', style: { dashed: true } }),
        visual({ from: { x: 0, y: 10 }, to: { x: 50, y: 10 }, key: 'b', phantom: true }),
      ],
      'span',
    )

    expect(context.ops.filter((op) => op.op === 'save')).toHaveLength(2)
    expect(context.ops.filter((op) => op.op === 'restore')).toHaveLength(2)
    // 一帧结束时状态必须复位（留在 0.5 的不透明度会让后面画的卡片整张半透明）
    const last = context.ops.length - 1
    expect(context.stateAt(last)).toEqual({ ...INITIAL, lineDash: '' })
  })

  it('确定性：同一份输入画两次，调用序列逐字相同（连线里没有任何随机量）', () => {
    const visuals = [
      visual({ from: { x: 0, y: 0 }, to: { x: 120, y: 40 }, key: 'a', style: { hue: 'out' } }),
      visual({
        from: { x: 120, y: 40 },
        to: { x: 240, y: 0 },
        key: 'b',
        phantom: true,
        leadFrom: { x: 60, y: 20 },
      }),
    ]
    expect(paint(visuals, 'span').context.ops).toEqual(paint(visuals, 'span').context.ops)
    expect(paint(visuals, 'lead').context.ops).toEqual(paint(visuals, 'lead').context.ops)
  })

  it('空输入不画任何东西（也不会抛）', () => {
    const span = paint([], 'span')
    expect(span.painted).toEqual([])
    expect(span.context.ops).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 悬停命中
// ---------------------------------------------------------------------------

describe('edgeAt：指针落在哪条边上', () => {
  const spanOf = (key: string, y: number): PaintedEdge =>
    paint([visual({ from: { x: 0, y }, to: { x: 100, y }, key })], 'span').painted[0]!

  it('距离 ≤ 容差算命中，> 容差不命中', () => {
    const edges = [spanOf('a', 0)]
    expect(edgeAt(edges, { x: 50, y: 0 }, 5)?.key).toBe('a')
    expect(edgeAt(edges, { x: 50, y: 4 }, 5)?.key).toBe('a')
    expect(edgeAt(edges, { x: 50, y: 6 }, 5)).toBeNull()
    // 端点之外的延长线不算命中（判据是"到线段"的距离，不是到无限延长线）
    expect(edgeAt(edges, { x: 130, y: 0 }, 5)).toBeNull()
  })

  it('两条边都在容差里时取更近的那条（并列时取先画的那条，确定性）', () => {
    const edges = [spanOf('远', 5), spanOf('近', 1)]
    expect(edgeAt(edges, { x: 50, y: 0 }, 10)?.key).toBe('近')
    // 并列：先画的那条（数组顺序 = 绘制顺序）
    expect(edgeAt(edges, { x: 50, y: 3 }, 10)?.key).toBe('远')
  })

  it('缺省只在卡外那段里找：卡内引线不参与连线悬停（它归正文热区管）', () => {
    const withLead = visual({
      from: { x: 100, y: 0 },
      to: { x: 200, y: 0 },
      key: 'pair',
      leadFrom: { x: 40, y: 0 },
    })
    const span = paint([withLead], 'span').painted[0]!
    const lead = paint([withLead], 'lead').painted[0]!

    // 引线上的一点（引线从 (40,0) 到 (100,0)）：只给引线记录时**缺省也命不中**（layer 过滤），
    // 显式要 lead 才命中；而同一个点在卡外那段（从 (100,0) 到 (200,0)）之外 ⇒ 给 span 也命不中
    const onLead = { x: 60, y: 0 }
    expect(edgeAt([lead], onLead, 5)).toBeNull()
    expect(edgeAt([lead], onLead, 5, 'lead')?.key).toBe('pair')
    expect(edgeAt([span], onLead, 5, 'span')).toBeNull()
    // 卡外那段上的一点（150, 0）：缺省命中
    expect(edgeAt([span], { x: 150, y: 0 }, 5)?.key).toBe('pair')
  })
})

// ---------------------------------------------------------------------------
// 与调色板的接口
// ---------------------------------------------------------------------------

describe('edge-paint 与调色板的接口', () => {
  it('色相色走可选令牌，读不到时退到 `--mn-warning` / `--mn-link`（与 graph.css 的兜底链一致）', () => {
    const fallback = paletteFrom(() => null)
    expect(fallback.edgeOut).toBe(fallback.warning)
    expect(fallback.edgeIn).toBe(fallback.link)

    const themed = paletteFrom((name) => {
      if (name === '--mn-edge-out') return '#aa0000'
      if (name === '--mn-edge-in') return '#00aa00'
      return ''
    })
    expect(themed.edgeOut).toBe('#aa0000')
    expect(themed.edgeIn).toBe('#00aa00')
  })
})
