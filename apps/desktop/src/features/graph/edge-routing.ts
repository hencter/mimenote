/**
 * 连线的**走线**（把"两点一条曲线"换成"径向出 → 沿环走 → 径向入"）。
 *
 * ## 为什么需要它
 *
 * 环布局把"离中心几跳"变成半径（ADR-0021），但过去每条边都是两点之间的一条三次贝塞尔
 * （`tensionPath`）—— 于是**最拥挤的地方恰好是圆心周围**：同一环上相邻的卡片互相之间的线
 * 全都从中间横穿过去，看起来就是一张蜘蛛网。用户的原话是"用更优雅的线去关联这些关系"。
 *
 * 这一层给线**一条形状上的规矩**：
 *
 * ```
 *      同一环上的两张卡片                    跨环（两端跳数不同）
 *    ┌──────────────────────────┐        ┌────┐            ┌────┐
 *    │      ↗ 环外的弧 ↖         │        │ A  │⌒⌒⌒⌒⌒⌒⌒⌒⌒→│ B  │
 *    │   ┌────┐        ┌────┐    │        └────┘            └────┘
 *    │   │ A  │        │ B  │    │          两端都从**外缘**朝外射出，
 *    │   └────┘        └────┘    │          曲线走外侧，谁也不横穿圆心
 *    └──────────────────────────┘
 * ```
 *
 * ## 三条判据（都由端点位置算出来，不含随机量）
 *
 * 1. **同一环**（两端跳数相同且 ≥ 1）：径向出到**环外一点**，沿那条环走一段弧，再径向进入目标。
 *    这是"轨道图"观感的来源，也是把中间那块让出来的关键；
 * 2. **跳数不同**（且都不是圆心）：**径向切线**三次贝塞尔 —— 两个控制点沿各自的"朝外"方向偏移。
 *    两端都朝外，曲线自然走外侧；跳数不同的两张卡片若走直线，会从中间穿过去；
 * 3. **涉及圆心**（有一端就是当前笔记）：保持从前的 `tensionPath`。那条边本来就在径向上，
 *    形状与从前**逐像素一致** —— "以当前笔记为圆心"的读法因此没有被这次改动影响。
 *
 * ## 张力旋钮仍然说话
 *
 * 径向切线那一段的鼓出量由 `tension` 决定（`0` ⇒ 控制点落在弦上 ⇒ 直线）。
 * 同环的**弧是结构性走线**，不随张力变直：这个旋钮说的是"线有多绷"，不是"走不走环"；
 * 让它能把环拉直，等于把这一层的存在感绑在一个观感开关上。
 *
 * ## 坐标、圆心与环半径
 *
 * 全部是**世界坐标**，圆心（轨道中心）取世界原点：`layoutEgo` 把圆心那一篇固定在原点
 * （`fixed`，力场只动别人），所以原点就是"第 0 环"。
 *
 * 环半径取"两端**当前**到原点的距离"里较大的那个再加一点余量，而不是理论上的
 * `ringRadii[hop]`：漂浮与拖拽之后卡片并不精确落在理论环上（力场会把环收紧三分之一左右），
 * 用理论值会让弧从卡片身上穿过去。用当前距离 ⇒ 弧永远在两张卡片之外。
 *
 * ## 为什么调用方要先换锚点（`outerExit`）
 *
 * 弧在卡片**外侧**，而"朝目标"的那个锚点在两张卡片隔环相对时位于卡片**内侧** ——
 * 从内侧锚点连到弧，那条连接段会从卡片底下穿过去（卡片是不透明底，线段在它下面），
 * 看起来就是"线在卡片里断了"。所以调用方用 {@link outerExit} 把锚点换到卡片外缘，
 * 那段虚线引线也随之改画到外缘（`GraphCanvas` 这么做，并把引线一起重算）。
 */

import { centerOf, type Point, type Rect } from './layout'

/** 弧相对"最外侧那张卡片"再往外让多少（世界像素）：让线不贴着卡片边缘走。 */
const ARC_CLEARANCE = 26

/** 径向切线的控制点沿弦方向的基准比例（与 `tensionPath` 的 1/3 同源，观感一致）。 */
const RADIAL_TANGENT = 1 / 3

/** 把坐标写进 `d`（与 `link-edge.ts` 的 `num` 同一条纪律：非有限值写 0，绝不给 SVG 送 NaN）。 */
function num(value: number): string {
  return Number.isFinite(value) ? String(value) : '0'
}

/** 从原点到点的距离。 */
function radiusOf(point: Point): number {
  return Math.hypot(point.x, point.y)
}

/** 极坐标 → 世界坐标。 */
function polar(angle: number, radius: number): Point {
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}

/**
 * 卡片上离圆心**最远**的那个角到圆心的距离。
 *
 * 弧半径必须比这个数大，否则弧会从卡片身上穿过去 —— 而"卡片中心到圆心的距离 + 余量"
 * 是不够的：卡片有半宽半高（100×60 的卡片在半径 300 处，最远的角已经在 351 上）。
 * 这个坑第一次实现时就踩了：弧从卡片内部起步，视觉上是"线从卡片侧面钻出来"。
 */
function farthestCornerRadius(rect: Rect): number {
  const corners: Point[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x, y: rect.y + rect.height },
    { x: rect.x + rect.width, y: rect.y + rect.height },
  ]
  return corners.reduce((max, corner) => Math.max(max, radiusOf(corner)), 0)
}

/** 把角度差收进 (-π, π]：弧永远走**较短的那一侧**（绕大半圈会横穿别的卡片）。 */
function shortestDelta(delta: number): number {
  let value = delta
  while (value > Math.PI) value -= Math.PI * 2
  while (value <= -Math.PI) value += Math.PI * 2
  return value
}

/** 从圆心指向某点的单位向量（点在原点上时是零向量）。 */
function unitVector(point: Point): Point {
  const length = radiusOf(point)
  if (!(length > 0)) return { x: 0, y: 0 }
  return { x: point.x / length, y: point.y / length }
}

/**
 * 卡片**朝外**那一侧的锚点：从卡片中心朝"远离圆心"的方向打一条射线与卡片边界的交点。
 *
 * 为什么不用 `rayRectExit(rect, center, 目标中心)`（"朝目标"那个锚点）：见文件头最后一段 ——
 * 隔环相对时它落在内侧，连接段会被卡片挡住，看起来像断线。
 * `center` 是卡片中心（在矩形内部），射线朝外，因此交的是**外缘**那一条边。
 */
export function outerExit(rect: Rect): Point {
  const center = centerOf(rect)
  const outward = unitVector(center)
  // 圆心那一环（中心在原点）没有"朝外"可言：退回"朝目标"由调用方处理（这里给中心本身）
  if (outward.x === 0 && outward.y === 0) return center
  // 射线终点放到很远的地方：只需要方向，不要让数值溢出
  const far = { x: center.x + outward.x * 10_000, y: center.y + outward.y * 10_000 }
  return rayRectExitLocal(rect, center, far)
}

/**
 * 射线与矩形边界的交点（`link-edge.ts` 的 `rayRectExit` 在这里的本地副本）。
 *
 * ⚠️ 为什么是"副本"而不是 import：`link-edge.ts` 已经 import 了 `canvas/measure` 与
 * `canvas/text-layout`（排版层），而这一层只想算几何 —— 引一个只为这一个函数、
 * 却把排版层带进依赖图。这个函数十行、判据只有一条（取最小的正解），
 * 复制它的代价小于把两层绑在一起；两处的期望值都由测试钉着（`edge-routing.test.ts`
 * 断言锚点落在卡片边界上，`link-edge.test.ts` 管它自己那份）。
 */
function rayRectExitLocal(rect: Rect, from: Point, to: Point): Point {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const left = rect.x
  const right = rect.x + rect.width
  const top = rect.y
  const bottom = rect.y + rect.height
  const candidates: number[] = []

  const consider = (t: number): void => {
    if (!(t > 1e-9)) return
    const x = from.x + dx * t
    const y = from.y + dy * t
    if (x < left - 1e-9 || x > right + 1e-9) return
    if (y < top - 1e-9 || y > bottom + 1e-9) return
    candidates.push(t)
  }
  if (dx !== 0) {
    consider((left - from.x) / dx)
    consider((right - from.x) / dx)
  }
  if (dy !== 0) {
    consider((top - from.y) / dy)
    consider((bottom - from.y) / dy)
  }
  if (candidates.length === 0) return from
  const t = Math.min(...candidates)
  const point = { x: from.x + dx * t, y: from.y + dy * t }
  const snap = (value: number, a: number, b: number): number =>
    Math.abs(value - a) <= 1e-9 ? a : Math.abs(value - b) <= 1e-9 ? b : value
  return { x: snap(point.x, left, right), y: snap(point.y, top, bottom) }
}

/** 走线要用到的端点信息。 */
export interface RouteEndpoint {
  /** 卡片当前的世界矩形。 */
  rect: Rect
  /** 离圆心几跳（圆心自己是 0）。 */
  hop: number
}

export interface RouteEdgeInput {
  /** 卡片内那段引线的终点（卡片边界上的交点）—— 走线从这里开始。 */
  exit: Point
  /** 目标卡片边界上的入点 —— 走线在这里结束。 */
  entry: Point
  from: RouteEndpoint
  to: RouteEndpoint
  /** 0..1：张力（只作用于径向切线那一段的鼓出量，见文件头）。 */
  tension: number
}

/** 这条边该走哪一种形状（调用方据此决定要不要换锚点，见 `outerExit`）。 */
export type EdgeRoutingKind = 'arc' | 'radial' | 'straight-to-center'

/** 判据只有一份：形状由两端的跳数决定。 */
export function routingKind(from: RouteEndpoint, to: RouteEndpoint): EdgeRoutingKind {
  if (from.hop === 0 || to.hop === 0) return 'straight-to-center'
  return from.hop === to.hop ? 'arc' : 'radial'
}

/**
 * 一条边在卡片**外**的走线路径（`d`）。
 *
 * 首尾**逐坐标**等于 `exit` / `entry`（与 `link-edge.ts` 的契约一致：引线与卡外那段必须在
 * 同一个点上严丝合缝相接），这里绝不做取整。
 */
export function routeEdgePath(input: RouteEdgeInput): string | null {
  const { exit, entry, from, to, tension } = input
  const safeTension = Number.isFinite(tension) ? Math.min(1, Math.max(0, tension)) : 0
  const kind = routingKind(from, to)

  if (kind === 'arc') {
    return ringArcPath({
      exit,
      entry,
      fromRect: from.rect,
      toRect: to.rect,
      fromCenter: centerOf(from.rect),
      toCenter: centerOf(to.rect),
    })
  }
  if (kind === 'radial') {
    return radialTangentPath({
      exit,
      entry,
      fromCenter: centerOf(from.rect),
      toCenter: centerOf(to.rect),
      tension: safeTension,
    })
  }
  /*
   * 涉及圆心：**返回 null**，让调用方用它手里那条既有的曲线（`link-edge` 的 `tensionPath`）。
   *
   * 为什么不在这里重画一遍：那条边的形状被 ADR-0023 钉着（垂直于弦的鼓出 —— 张力旋钮在
   * 圆心那些边上"看得见效果"全靠它），而径向切线在径向的边上会退化成一条直线
   * （朝外方向 = 弦方向），张力旋钮就会看起来失灵。保持原样是这里唯一正确的选择，
   * 而"原样"只有一份实现，在 link-edge 里。
   */
  return null
}

/**
 * 同一环上的两张卡片：从各自的**外缘**径向出到环外的弧上，沿弧走，再径向进入目标。
 *
 * 弧半径取 `max(r1, r2) + 余量` —— 最外侧那张卡片之外，于是弧既不穿卡片、也不穿圆心；
 * 两端连接段的极角取**卡片中心**的极角，因此它们就是"卡片中心方向"的延长线，
 * 观感上"从这张卡片朝外射出去、沿环走一段、再扎进那一张"。
 */
function ringArcPath(input: {
  exit: Point
  entry: Point
  fromRect: Rect
  toRect: Rect
  fromCenter: Point
  toCenter: Point
}): string {
  const { exit, entry, fromRect, toRect, fromCenter, toCenter } = input
  const angleFrom = Math.atan2(fromCenter.y, fromCenter.x)
  const angleTo = Math.atan2(toCenter.y, toCenter.x)
  const delta = shortestDelta(angleTo - angleFrom)
  // 半径取"两张卡片最远的角"之外（见 `farthestCornerRadius` 的说明）
  const radius =
    Math.max(farthestCornerRadius(fromRect), farthestCornerRadius(toRect)) + ARC_CLEARANCE

  const arcStart = polar(angleFrom, radius)
  const arcEnd = polar(angleFrom + delta, radius)
  // SVG 的 y 轴朝下：角度增加 = 顺时针 = sweep 1
  const sweep = delta >= 0 ? 1 : 0
  const largeArc = Math.abs(delta) > Math.PI ? 1 : 0

  return (
    `M ${num(exit.x)} ${num(exit.y)} ` +
    `L ${num(arcStart.x)} ${num(arcStart.y)} ` +
    `A ${num(radius)} ${num(radius)} 0 ${largeArc} ${sweep} ${num(arcEnd.x)} ${num(arcEnd.y)} ` +
    `L ${num(entry.x)} ${num(entry.y)}`
  )
}

/**
 * **径向切线**的三次贝塞尔（跳数不同、或涉及圆心时用）。
 *
 * 两个控制点分别沿"从圆心指向端点、再朝外"的方向偏移 `tension × 弦长 × 1/3`：
 * 线从卡片**朝外射出**、从目标**外侧绕进来**，于是它天然走外侧，不会横穿圆心。
 * `tension = 0` 时两个控制点退回到弦的 1/3、2/3 处 ⇒ 直线（与 `tensionPath` 的退化一致）。
 *
 * 端点就在圆心上（半径 0）时没有"径向"可言：那一端不偏移，形状与从前的 `tensionPath` 一致。
 */
function radialTangentPath(input: {
  exit: Point
  entry: Point
  fromCenter: Point
  toCenter: Point
  tension: number
}): string {
  const { exit, entry, fromCenter, toCenter, tension } = input
  const dx = entry.x - exit.x
  const dy = entry.y - exit.y
  const chord = Math.hypot(dx, dy)
  if (!(chord > 0)) return `M ${num(exit.x)} ${num(exit.y)} L ${num(entry.x)} ${num(entry.y)}`

  const amount = tension * chord * RADIAL_TANGENT
  const outFrom = unitVector(fromCenter)
  const outTo = unitVector(toCenter)

  const c1 = { x: exit.x + dx / 3 + outFrom.x * amount, y: exit.y + dy / 3 + outFrom.y * amount }
  const c2 = { x: entry.x - dx / 3 + outTo.x * amount, y: entry.y - dy / 3 + outTo.y * amount }

  return (
    `M ${num(exit.x)} ${num(exit.y)} ` +
    `C ${num(c1.x)} ${num(c1.y)}, ${num(c2.x)} ${num(c2.y)}, ${num(entry.x)} ${num(entry.y)}`
  )
}
