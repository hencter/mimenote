/**
 * 连线的**渐细笔触**与**平行束**的几何（纯函数；画笔只消费，不自己发明）。
 *
 * ## 为什么单独一层
 * 这两件事都是"在一条折线上做文章"：把折线按弧长稀释成渐细的带、把同一条折线沿法向
 * 平移到一束。它们与画布无关（不碰 `PaintContext`）、与卡片无关，因此可以逐点手算断言
 * （`tests/graph-edge-taper.test.ts`），而画笔那一层只负责"把多边形填上颜色"。
 *
 * ## 一、渐细笔触取代箭头（ADR-0052）
 * 原来卡外那段的终点画一个**填充三角形**（SVG 版 `<marker>` 的等价物）。它的两个毛病：
 * ① 箭头大小是**线宽的倍数**（`markerUnits=strokeWidth`），而跳数权重让线宽在 1–3 倍之间
 *    变化 ⇒ 近处的箭头又粗又抢眼，远端的箭头小到看不见，同一个"方向"读出两种重量；
 * ② 它是一个**外挂的符号**：落在卡片边界上的三角形有一半压在卡片下面，看起来像被裁掉。
 *
 * 现在方向由**线自己的形状**表达：起点满宽，靠近终点的一段连续收窄到
 * [`TAPER_TIP_RATIO`]（默认 0.12，留一点点而不是收成一个零宽点 —— 收成 0 会在终点留下
 * 一道若隐若现的锯齿，抗锯齿在两条边几乎重合时的表现依驱动而异）。
 *
 * ## 二、同一对笔记的多条链接画成平行束
 * `GraphEdge.count` 记着"同一对笔记之间有几条链接"（同一对 `(from, to, kind)` 会合并成一条
 * 边），从前它只出现在 tooltip 里。现在按 `count` 画成 2–3 条平行线（上限
 * [`BUNDLE_MAX`]，再多也只画 3 条 —— 再多就糊成一团，剩余量与理由交给 tooltip）。
 *
 * **为什么束是"单侧"的（主笔触偏移恒为 0，其余向一侧排开）**：主笔触必须**逐坐标**落在
 * 几何层给的锚点上，否则卡内那段引线与卡外这段的交界就会出现缝（ADR-0023 的硬纪律）。
 * 对称分布（`−(n−1)/2 … +(n−1)/2`）在 `count` 为偶数时没有任何一条落在 0 上，
 * 交界处必然错开半个间距 —— 而一侧排开还能顺带表达"哪一条是主笔触"。
 *
 * ## NaN 纪律
 * 画布收到 `NaN` 不会抛错，只会整条线静默消失（而且很可能连带把 `globalAlpha` 之类
 * 状态搞脏）。所以这里所有出口都过一遍有限性检查：**退化输入返回空数组**，
 * 画笔拿到空数组就什么都不画（`edge-path.ts` 的"非有限值写 0，绝不给 SVG 送 NaN"同一条纪律）。
 */

import type { Point } from '../layout'

/** 收尖之后终点保留的线宽（相对起点，0 = 收成一个点）。 */
export const TAPER_TIP_RATIO = 0.12

/**
 * 从路径的哪一段开始收窄（0..1）。
 *
 * 0.5 意味着"前半段满宽、后半段收尖"：收得太早会让线看起来像一根针，
 * 收得太晚（0.9）则在终点附近出现一个突兀的急收。
 */
export const TAPER_START = 0.5

/** 收窄曲线的指数：> 1 时"先慢后快"，线更像被轻轻拖细，而不是均匀的锥形。 */
export const TAPER_CURVE = 1.6

/**
 * 虚线边末端那段实心笔尖的长度（世界像素）。
 *
 * 虚线代表"被动/缺席"（入链、悬空目标），这条语义不能丢；但虚线的末段原本会**随机地**
 * 停在卡片边界附近的某处（取决于图案相位），看着像"没画完"。补一个短笔尖，
 * 于是"到达"这件事由形状说清楚，虚线仍然说"被动"。
 */
export const TIP_LENGTH = 18

/** 束内相邻两条线的间距（世界像素）。 */
export const BUNDLE_GAP = 3.2

/** 束最多画几条（再多就糊成一团）。 */
export const BUNDLE_MAX = 3

/**
 * 这条边要画几条线。
 *
 * `count` 是非有限数或小于 2 时按 1 条处理：数据脏不该让画布多画或少画线，
 * 而"画一条"是与"这条边只有一个链接"完全等价的降级。
 */
export function bundleMembers(count: number): number {
  if (!Number.isFinite(count) || count < 2) return 1
  return Math.min(Math.floor(count), BUNDLE_MAX)
}

/**
 * 束内每一条相对**主笔触**的横向偏移（世界像素，恒有 `offsets[0] === 0`）。
 *
 * 偏移方向取"行进方向的右手侧"（见 [`normalAt`]）：方向由几何决定，
 * 与扫过顺序、视口、缩放都无关 —— 因此同一份数据反复画、平移缩放之后，
 * 哪一条在左边不会变（连线里没有随机量的那条纪律）。
 */
export function bundleOffsets(count: number): number[] {
  return Array.from({ length: bundleMembers(count) }, (_, index) => index * BUNDLE_GAP)
}

/** 实线笔触在 `t`（0..1）处的线宽系数：前半段满宽，之后按 [`TAPER_CURVE`] 收到 [`TAPER_TIP_RATIO`]。 */
export function taperFactor(t: number): number {
  if (!(t > TAPER_START)) return 1
  const k = Math.min(1, (t - TAPER_START) / (1 - TAPER_START))
  return 1 - (1 - TAPER_TIP_RATIO) * k ** TAPER_CURVE
}

/** 虚线边末端那个笔尖的线宽系数：从满宽一路收到 [`TAPER_TIP_RATIO`]（局部 `t`）。 */
export function tipFactor(t: number): number {
  const k = Math.min(1, Math.max(0, t))
  return 1 - (1 - TAPER_TIP_RATIO) * k
}

/** 点是否有限（画布的安全出口）。 */
function finite(point: Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y)
}

/**
 * 第 `index` 点处的单位切向。
 *
 * 用**相邻两点差分**（而不是曲线导数）：带子是画在采样折线上的，切向与实际画出来的
 * 那一小段一致才不会出现"法向与线段垂直方向差一点、带子扭一下"。
 * 两端各只有一个邻居，就用单侧差分；重合点（差分为 0）退化成 `(1, 0)` ——
 * 定一个确定的方向，好过让 `NaN` 顺着法向传进多边形。
 */
function tangentAt(points: readonly Point[], index: number): Point {
  const current = points[index]
  if (current === undefined) return { x: 1, y: 0 }
  const previous = points[index - 1]
  const next = points[index + 1]
  let dx: number
  let dy: number
  if (previous !== undefined && next !== undefined) {
    dx = next.x - previous.x
    dy = next.y - previous.y
  } else if (next !== undefined) {
    dx = next.x - current.x
    dy = next.y - current.y
  } else if (previous !== undefined) {
    dx = current.x - previous.x
    dy = current.y - previous.y
  } else {
    return { x: 1, y: 0 }
  }
  const length = Math.hypot(dx, dy)
  if (!(length > 0)) return { x: 1, y: 0 }
  return { x: dx / length, y: dy / length }
}

/** 行进方向的右手法向（切向逆时针转 90°）。 */
function normalAt(points: readonly Point[], index: number): Point {
  const tangent = tangentAt(points, index)
  return { x: -tangent.y, y: tangent.x }
}

/**
 * 折线沿法向平移 `offset`（世界像素，正数 = 右手侧）。
 *
 * `offset === 0` 时**原样返回**（连对象都不重建）：主笔触必须是几何层给的逐字那一条，
 * 平移一次再回来会引入浮点误差，而"分界处严丝合缝"是逐坐标的断言。
 */
export function offsetPolyline(points: readonly Point[], offset: number): Point[] {
  if (offset === 0) return [...points]
  return points.map((point, index) => {
    const normal = normalAt(points, index)
    return { x: point.x + normal.x * offset, y: point.y + normal.y * offset }
  })
}

/**
 * 折线 → 渐细带的多边形（左岸正向 + 右岸反向；画笔 `fill()` 它就完事）。
 *
 * `profile(t)` 给的是**线宽系数**（1 = 满宽），`halfWidth` 是满宽的一半（世界单位）。
 * 返回空数组的情况：点少于 2 个、半宽不是正数、算出来的任一点不是有限值。
 * 这是"绝不给画布送 NaN"那条纪律的落点 —— 退化输入宁可什么都不画。
 */
export function taperPolygon(
  points: readonly Point[],
  halfWidth: number,
  profile: (t: number) => number = taperFactor,
): Point[] {
  if (points.length < 2 || !(halfWidth > 0)) return []
  const left: Point[] = []
  const right: Point[] = []
  const last = points.length - 1
  for (let index = 0; index <= last; index += 1) {
    const point = points[index]
    if (point === undefined || !finite(point)) return []
    const normal = normalAt(points, index)
    const half = halfWidth * profile(index / last)
    if (!Number.isFinite(half)) return []
    left.push({ x: point.x + normal.x * half, y: point.y + normal.y * half })
    right.push({ x: point.x - normal.x * half, y: point.y - normal.y * half })
  }
  const polygon = [...left, ...right.reverse()]
  return polygon.every(finite) ? polygon : []
}

/**
 * 折线末尾按**弧长**取 `length` 那么长的一段（含逐坐标相同的终点）。
 *
 * 给虚线边的笔尖用：`length` 比整条线还长时返回整条折线（起点仍是折线的起点）——
 * 短线（悬空边那种）于是得到"整条都在收尖"，而不是一个没有长度可用的空数组。
 */
export function tailOf(points: readonly Point[], length: number): Point[] {
  if (points.length < 2 || !(length > 0)) return [...points]
  const tail: Point[] = [points[points.length - 1] as Point]
  let remaining = length
  for (let index = points.length - 1; index > 0; index -= 1) {
    const from = points[index]
    const to = points[index - 1]
    if (from === undefined || to === undefined) break
    const segment = Math.hypot(from.x - to.x, from.y - to.y)
    if (!(segment > 0)) continue
    if (segment >= remaining) {
      const ratio = remaining / segment
      tail.push({ x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio })
      break
    }
    remaining -= segment
    tail.push(to)
  }
  return tail.reverse()
}
