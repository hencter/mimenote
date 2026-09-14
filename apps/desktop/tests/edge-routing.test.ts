/**
 * 连线走线（`features/graph/edge-routing.ts`）的纯几何测试。
 *
 * 这一层决定"线长什么形状"，出错的表现是**线从卡片底下穿过、或者钻进圆心那块最挤的区域** ——
 * 都只有盯着画布才看得出来。所以这里用手算的坐标把它钉住：同一环走弧、跨环朝外鼓、
 * 涉及圆心保持原样，三条判据各一组。
 *
 * 期望值**不从实现里推导**：环半径、角度、控制点方向都在注释里算给你看。
 */

import { describe, expect, it } from 'vitest'

import { outerExit, routeEdgePath, routingKind, type RouteEndpoint } from '@/features/graph/edge-routing'
import type { Point, Rect } from '@/features/graph/layout'

/** 造一个以 `center` 为中心、给定尺寸的矩形（卡片）。 */
function card(center: Point, width = 100, height = 60): Rect {
  return { x: center.x - width / 2, y: center.y - height / 2, width, height }
}

function endpoint(center: Point, hop: number, size = { width: 100, height: 60 }): RouteEndpoint {
  return { rect: card(center, size.width, size.height), hop }
}

/** `d` 里的数字（路径形状的断言都从这些数算出来，而不是比较字符串）。 */
function numbersOf(d: string): number[] {
  return (d.match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g) ?? []).map(Number)
}

/** `d` 里出现的命令字母（`M`/`L`/`A`/`C`…）—— 用来断言"这条线是弧还是曲线"。 */
function commandsOf(d: string): string[] {
  return (d.match(/[MLACQZ]/g) ?? []).map((letter) => letter)
}

function distanceFromOrigin(point: Point): number {
  return Math.hypot(point.x, point.y)
}

describe('routingKind：形状由两端的跳数决定', () => {
  it('同一环（跳数相同且 ≥ 1）⇒ 弧', () => {
    expect(routingKind(endpoint({ x: 300, y: 0 }, 1), endpoint({ x: 0, y: 300 }, 1))).toBe('arc')
    expect(routingKind(endpoint({ x: 500, y: 0 }, 2), endpoint({ x: 0, y: 500 }, 2))).toBe('arc')
  })

  it('跳数不同 ⇒ 径向切线', () => {
    expect(routingKind(endpoint({ x: 300, y: 0 }, 1), endpoint({ x: 0, y: 600 }, 2))).toBe('radial')
  })

  it('涉及圆心（跳数 0）⇒ 保持从前的画法', () => {
    expect(routingKind(endpoint({ x: 0, y: 0 }, 0), endpoint({ x: 300, y: 0 }, 1))).toBe(
      'straight-to-center',
    )
    expect(routingKind(endpoint({ x: 300, y: 0 }, 1), endpoint({ x: 0, y: 0 }, 0))).toBe(
      'straight-to-center',
    )
  })
})

describe('同一环：沿环外弧走，不再直穿圆心', () => {
  /*
    手算：两张卡片分别在 (300, 0) 与 (-300, 0)（**隔着圆心相对**，这正是过去"直穿"最丑的情形），
    跳数都为 1。锚点取各自的朝外边缘：右卡的右边界 (350, 0)、左卡的左边界 (-350, 0)。
    弧半径 = max(300, 300) + 26 = 326。
  */
  const right = endpoint({ x: 300, y: 0 }, 1)
  const left = endpoint({ x: -300, y: 0 }, 1)
  const exit: Point = { x: 350, y: 0 }
  const entry: Point = { x: -350, y: 0 }
  const d = routeEdgePath({ exit, entry, from: right, to: left, tension: 0.35 }) ?? ''

  it('形状是"直线段 + 弧 + 直线段"', () => {
    expect(commandsOf(d)).toEqual(['M', 'L', 'A', 'L'])
  })

  it('首尾逐坐标等于两个锚点（分界处严丝合缝）', () => {
    const numbers = numbersOf(d)
    expect(numbers.slice(0, 2)).toEqual([exit.x, exit.y])
    expect(numbers.slice(-2)).toEqual([entry.x, entry.y])
  })

  it('弧半径取"两张卡片最远的角"之外（含卡片半宽，不是只算中心距离）', () => {
    const numbers = numbersOf(d)
    /*
      `d` 的形状是 `M exit L arcStart A rx ry rot large sweep arcEnd L entry`：
      下标 0..1 是 exit、2..3 是 arcStart、4..5 是弧半径、6..8 是三个 flag、
      9..10 是 arcEnd、11..12 是 entry。
      手算：卡片 100×60、中心在半径 300 处 ⇒ 最远的角 hypot(350, 30) ≈ 351.3，
      再加余量 26 ⇒ 半径 ≈ 377.3。
    */
    const radius = numbers[4] ?? Number.NaN
    expect(radius).toBeCloseTo(Math.hypot(350, 30) + 26, 6)

    // 弧的起点/终点都落在这条半径的圆上
    const arcStart = { x: numbers[2] ?? Number.NaN, y: numbers[3] ?? Number.NaN }
    const arcEnd = { x: numbers[9] ?? Number.NaN, y: numbers[10] ?? Number.NaN }
    expect(distanceFromOrigin(arcStart)).toBeCloseTo(radius, 6)
    expect(distanceFromOrigin(arcEnd)).toBeCloseTo(radius, 6)
    // 而且弧比卡片最远的角还要外 —— 否则它会从卡片身上穿过去（第一版就踩了这个坑）
    expect(radius).toBeGreaterThan(Math.hypot(350, 30))
  })

  it('对照：直线中点离圆心 ≈ 0，而这条弧整个在卡片之外', () => {
    // 直线（两点一条线）的中点在原点上 —— 这正是被用户说成"蜘蛛网"的那种走法
    const chordMidpoint = { x: (exit.x + entry.x) / 2, y: (exit.y + entry.y) / 2 }
    expect(distanceFromOrigin(chordMidpoint)).toBeLessThan(1)

    // 弧的极角中点（两侧相差 π ⇒ 落在 90° 方向）离圆心 = 弧半径，比任何一张卡片都远
    const radius = numbersOf(d)[4] ?? Number.NaN
    expect(radius).toBeGreaterThan(Math.hypot(350, 30))
  })

  it('弧走较短的那一侧（sweep 跟着角度差的方向）', () => {
    const clockwise = routeEdgePath({
      exit,
      entry,
      from: right,
      to: endpoint({ x: 0, y: 300 }, 1),
      tension: 0,
    }) ?? ''
    const counterClockwise = routeEdgePath({
      exit,
      entry,
      from: right,
      to: endpoint({ x: 0, y: -300 }, 1),
      tension: 0,
    }) ?? ''
    // sweep 位在 numbers[8]（`A rx ry rot large sweep x y`）
    const sweepOf = (path: string | null): number => numbersOf(path ?? '')[8] ?? Number.NaN
    expect(sweepOf(clockwise)).toBe(1)
    expect(sweepOf(counterClockwise)).toBe(0)
  })

  it('不产生 NaN（SVG 里一个 NaN 会让整条路径被丢掉）', () => {
    expect(d).not.toContain('NaN')
    expect(d).not.toContain('Infinity')
  })
})

describe('跳数不同：径向切线 —— 两端都朝外，曲线走外侧', () => {
  /*
    手算：内侧卡片在 (300, 0)（1 跳），外侧卡片在 (0, 600)（2 跳）。
    锚点取各自的朝外边缘：(350, 0) 与 (0, 650)。弦长 = hypot(350, 650) ≈ 738.6。
    张力 0.35 ⇒ 控制点沿"圆心 → 端点"方向各偏移 0.35 × 738.6 / 3 ≈ 86.2。
  */
  const inner = endpoint({ x: 300, y: 0 }, 1)
  const outer = endpoint({ x: 0, y: 600 }, 2)
  const exit: Point = { x: 350, y: 0 }
  const entry: Point = { x: 0, y: 650 }
  const d = routeEdgePath({ exit, entry, from: inner, to: outer, tension: 0.35 }) ?? ''

  it('形状是三次贝塞尔，首尾仍然逐坐标等于两个锚点', () => {
    expect(d).not.toBeNull()
    expect(commandsOf(d)).toEqual(['M', 'C'])
    const numbers = numbersOf(d)
    expect(numbers.slice(0, 2)).toEqual([exit.x, exit.y])
    expect(numbers.slice(-2)).toEqual([entry.x, entry.y])
  })

  it('两个控制点都**朝外**（离圆心比弦上的对应位置更远）', () => {
    const numbers = numbersOf(d)
    const c1 = { x: numbers[2] ?? Number.NaN, y: numbers[3] ?? Number.NaN }
    const c2 = { x: numbers[4] ?? Number.NaN, y: numbers[5] ?? Number.NaN }

    // 弦上 1/3、2/3 处（没有径向偏移时的控制点位置）
    const chord1 = { x: exit.x + (entry.x - exit.x) / 3, y: exit.y + (entry.y - exit.y) / 3 }
    const chord2 = { x: exit.x + ((entry.x - exit.x) * 2) / 3, y: exit.y + ((entry.y - exit.y) * 2) / 3 }

    expect(distanceFromOrigin(c1)).toBeGreaterThan(distanceFromOrigin(chord1))
    expect(distanceFromOrigin(c2)).toBeGreaterThan(distanceFromOrigin(chord2))
    // 而且偏移是"沿各自的径向"：控制点与端点的方向差不超过几度（用点积判）
    const outwardExit = { x: exit.x / distanceFromOrigin(exit), y: exit.y / distanceFromOrigin(exit) }
    const offset1 = { x: c1.x - chord1.x, y: c1.y - chord1.y }
    const dot = offset1.x * outwardExit.x + offset1.y * outwardExit.y
    expect(dot).toBeGreaterThan(0)
  })

  it('张力 0 ⇒ 两个控制点落回弦上 = 直线（这条旋钮的语义没有变）', () => {
    const straight = routeEdgePath({ exit, entry, from: inner, to: outer, tension: 0 }) ?? ''
    const numbers = numbersOf(straight)
    const c1 = { x: numbers[2] ?? Number.NaN, y: numbers[3] ?? Number.NaN }
    const c2 = { x: numbers[4] ?? Number.NaN, y: numbers[5] ?? Number.NaN }
    // 共线：两个控制点到弦的距离都为 0（叉积判据）
    const dx = entry.x - exit.x
    const dy = entry.y - exit.y
    const cross = (point: Point): number => Math.abs((point.x - exit.x) * dy - (point.y - exit.y) * dx)
    expect(cross(c1)).toBeLessThan(1e-9)
    expect(cross(c2)).toBeLessThan(1e-9)
  })
})

describe('涉及圆心：形状与从前一致', () => {
  const root = endpoint({ x: 0, y: 0 }, 0, { width: 320, height: 200 })
  const neighbour = endpoint({ x: 400, y: 0 }, 1)
  const exit: Point = { x: 160, y: 0 } // 圆心卡片的右边界
  const entry: Point = { x: 350, y: 0 } // 邻居卡片的左边界

  it('返回 null：让调用方用它手里那条既有曲线（圆心那些边的形状不变）', () => {
    /*
      为什么不在这里重画：圆心那些边本来就在径向上，而径向切线在径向的边上会退化成
      一条直线（朝外方向 = 弦方向）—— 张力旋钮在**最常见的那些边**上就会看起来失灵。
      形状的决定权因此留在 `link-edge` 的 `tensionPath`（ADR-0023 钉过它的退化行为）。
    */
    expect(routeEdgePath({ exit, entry, from: root, to: neighbour, tension: 0.35 })).toBeNull()
    expect(routeEdgePath({ exit, entry, from: neighbour, to: root, tension: 0.35 })).toBeNull()
  })
})

describe('outerExit：把锚点换到卡片**朝外**那一条边上', () => {
  it('锚点在卡片边界上，且比中心离圆心更远', () => {
    const rect = card({ x: 300, y: 0 })
    const point = outerExit(rect)

    expect(distanceFromOrigin(point)).toBeGreaterThan(distanceFromOrigin({ x: 300, y: 0 }))
    // 落在右边界上（卡片 100 宽、中心在 x=300 ⇒ 右边界 x=350）
    expect(point.x).toBeCloseTo(350, 6)
    expect(point.y).toBeCloseTo(0, 6)
  })

  it('斜方向上也落在边界上（不是"中心 + 半径"这种会跑到卡片外的假锚点）', () => {
    const rect = card({ x: 300, y: 300 })
    const point = outerExit(rect)

    const insideX = point.x >= rect.x - 1e-6 && point.x <= rect.x + rect.width + 1e-6
    const insideY = point.y >= rect.y - 1e-6 && point.y <= rect.y + rect.height + 1e-6
    expect(insideX).toBe(true)
    expect(insideY).toBe(true)
    // 至少有一条边被贴上（否则它不在边界上）
    const onEdge =
      Math.abs(point.x - rect.x) < 1e-6 ||
      Math.abs(point.x - (rect.x + rect.width)) < 1e-6 ||
      Math.abs(point.y - rect.y) < 1e-6 ||
      Math.abs(point.y - (rect.y + rect.height)) < 1e-6
    expect(onEdge).toBe(true)
  })

  it('圆心那一张（中心在原点）没有"朝外"可言：原样返回中心', () => {
    const rect = card({ x: 0, y: 0 })
    expect(outerExit(rect)).toEqual({ x: 0, y: 0 })
  })
})
