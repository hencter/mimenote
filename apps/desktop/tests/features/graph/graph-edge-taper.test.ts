/**
 * 连线的渐细笔触与平行束的**纯几何**（`features/graph/canvas/taper.ts`，ADR-0052）。
 *
 * 期望值全部手算写死：这一层不做 IO、不碰画布，"半宽 0.8 收成 0.096"这类数字
 * 就是它唯一的契约。画笔那一侧（`tests/features/graph/graph-edge-paint.test.ts`）断言的是
 * "这些点多边形被填上了什么颜色"，两层分工不重叠。
 */

import { describe, expect, it } from 'vitest'

import {
  bundleMembers,
  bundleOffsets,
  BUNDLE_GAP,
  BUNDLE_MAX,
  offsetPolyline,
  tailOf,
  taperFactor,
  taperPolygon,
  tipFactor,
  TAPER_TIP_RATIO,
} from '@/features/graph/canvas/taper'
import type { Point } from '@/domain/graph/layout'

/** 折线的坐标快照（比较时用值，不用对象身份）。 */
const xy = (points: readonly Point[]): Array<[number, number]> =>
  points.map((point) => [point.x, point.y])

describe('平行束：几条、每条的偏移', () => {
  it('count < 2 或数据脏（NaN / 无穷）都按一条处理', () => {
    expect(bundleMembers(0)).toBe(1)
    expect(bundleMembers(1)).toBe(1)
    expect(bundleMembers(-3)).toBe(1)
    expect(bundleMembers(Number.NaN)).toBe(1)
    expect(bundleMembers(Number.POSITIVE_INFINITY)).toBe(1)
  })

  it('count = 2.7 取整数部分；超过上限就截到 BUNDLE_MAX', () => {
    expect(bundleMembers(2.7)).toBe(2)
    expect(bundleMembers(3)).toBe(3)
    expect(bundleMembers(99)).toBe(BUNDLE_MAX)
  })

  it('偏移从 0 开始等距排列：主笔触恒在 0（分界纪律靠它）', () => {
    expect(bundleOffsets(1)).toEqual([0])
    expect(bundleOffsets(3)).toEqual([0, BUNDLE_GAP, BUNDLE_GAP * 2])
    // 上限之外不产生更多条
    expect(bundleOffsets(99)).toHaveLength(BUNDLE_MAX)
  })
})

describe('收窄曲线', () => {
  it('实线：前半段满宽，之后单调收窄到 TAPER_TIP_RATIO', () => {
    expect(taperFactor(0)).toBe(1)
    expect(taperFactor(0.5)).toBe(1)
    expect(taperFactor(1)).toBeCloseTo(TAPER_TIP_RATIO, 12)
    // 单调不增，且始终夹在 [TIP, 1] 里
    let previous = taperFactor(0)
    for (let step = 1; step <= 20; step += 1) {
      const value = taperFactor(step / 20)
      expect(value).toBeLessThanOrEqual(previous + 1e-12)
      expect(value).toBeGreaterThanOrEqual(TAPER_TIP_RATIO - 1e-12)
      expect(value).toBeLessThanOrEqual(1)
      previous = value
    }
    // 超过 1 的 t 不再继续收（越界输入不该算出负宽度）
    expect(taperFactor(2)).toBeCloseTo(TAPER_TIP_RATIO, 12)
  })

  it('虚线笔尖：从满宽一路收到 TAPER_TIP_RATIO（与虚线末端同宽接得上）', () => {
    expect(tipFactor(0)).toBe(1)
    expect(tipFactor(1)).toBeCloseTo(TAPER_TIP_RATIO, 12)
    expect(tipFactor(0.5)).toBeCloseTo(1 - (1 - TAPER_TIP_RATIO) * 0.5, 12)
    // 越界输入夹在 [0,1]
    expect(tipFactor(-5)).toBe(1)
    expect(tipFactor(5)).toBeCloseTo(TAPER_TIP_RATIO, 12)
  })
})

describe('沿法向平移（束的成员）', () => {
  it('offset = 0 原样返回（主笔触必须是几何层那一条，不引入浮点误差）', () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]
    expect(xy(offsetPolyline(points, 0))).toEqual(xy(points))
  })

  it('向右行进时法向是 +y：正偏移把折线抬到上方（屏幕坐标里 y 增大）', () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]
    expect(xy(offsetPolyline(points, 2))).toEqual([
      [0, 2],
      [100, 2],
    ])
    expect(xy(offsetPolyline(points, -3.5))).toEqual([
      [0, -3.5],
      [100, -3.5],
    ])
  })

  it('竖直折线：法向水平', () => {
    const points: Point[] = [
      { x: 10, y: 0 },
      { x: 10, y: 50 },
    ]
    expect(xy(offsetPolyline(points, 1))).toEqual([
      [-1 + 10, 0],
      [-1 + 10, 50],
    ])
  })

  it('不修改入参（上一次绘制留下的坐标不能被下一次平移污染）', () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ]
    offsetPolyline(points, 5)
    expect(xy(points)).toEqual([
      [0, 0],
      [10, 10],
    ])
  })
})

describe('渐细带的多边形', () => {
  it('直线：左岸正向 + 右岸反向，起点满宽、终点半宽收到 TAPER_TIP_RATIO', () => {
    const polygon = taperPolygon(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      0.8,
    )
    // 手算：法向 (0,1)；起点半宽 0.8、终点半宽 0.8 × 0.12 = 0.096
    expect(xy(polygon)).toEqual([
      [0, 0.8],
      [100, 0.096],
      [100, -0.096],
      [0, -0.8],
    ])
  })

  it('自定义线宽系数：整条等宽时就是一个矩形（两条长边平行）', () => {
    const polygon = taperPolygon(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      2,
      () => 1,
    )
    expect(xy(polygon)).toEqual([
      [0, 2],
      [10, 2],
      [10, -2],
      [0, -2],
    ])
  })

  it('退化输入返回空数组（宁可什么都不画，也不给画布送 NaN）', () => {
    expect(taperPolygon([], 1)).toEqual([])
    expect(taperPolygon([{ x: 0, y: 0 }], 1)).toEqual([])
    expect(taperPolygon([{ x: 0, y: 0 }, { x: 1, y: 1 }], 0)).toEqual([])
    expect(taperPolygon([{ x: 0, y: 0 }, { x: 1, y: 1 }], -2)).toEqual([])
    expect(taperPolygon([{ x: 0, y: 0 }, { x: 1, y: 1 }], Number.NaN)).toEqual([])
    expect(taperPolygon([{ x: 0, y: 0 }, { x: Number.NaN, y: 1 }], 1)).toEqual([])
    expect(taperPolygon([{ x: 0, y: 0 }, { x: Number.POSITIVE_INFINITY, y: 1 }], 1)).toEqual([])
  })

  it('所有点重合（零长度折线）也不产生 NaN：退化成一条确定方向的带', () => {
    const polygon = taperPolygon(
      [
        { x: 5, y: 5 },
        { x: 5, y: 5 },
      ],
      1,
    )
    expect(polygon).toHaveLength(4)
    for (const point of polygon) {
      expect(Number.isFinite(point.x)).toBe(true)
      expect(Number.isFinite(point.y)).toBe(true)
    }
    // 切向退化成 (1,0) ⇒ 法向 (0,1)：两点各向 ±y 展开
    expect(xy(polygon)).toEqual([
      [5, 6],
      [5, 5 + TAPER_TIP_RATIO],
      [5, 5 - TAPER_TIP_RATIO],
      [5, 4],
    ])
  })

  it('同一份输入算两次逐字相同（连线里没有随机量）', () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 20, y: 40 },
      { x: 60, y: 30 },
    ]
    expect(xy(taperPolygon(points, 3))).toEqual(xy(taperPolygon(points, 3)))
  })
})

describe('末端取一段（虚线边的笔尖）', () => {
  it('按弧长从终点往回取，且终点逐坐标不变', () => {
    expect(
      xy(
        tailOf(
          [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
          ],
          18,
        ),
      ),
    ).toEqual([
      [82, 0],
      [100, 0],
    ])
  })

  it('跨折点取：插值点落在正确的那一段上', () => {
    expect(
      xy(
        tailOf(
          [
            { x: 0, y: 0 },
            { x: 50, y: 0 },
            { x: 50, y: 50 },
          ],
          20,
        ),
      ),
    ).toEqual([
      [50, 30],
      [50, 50],
    ])
  })

  it('要的比整条还长：返回整条折线（短线于是"整条都在收尖"）', () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]
    expect(xy(tailOf(points, 999))).toEqual(xy(points))
    expect(xy(tailOf(points, 0))).toEqual(xy(points))
    expect(xy(tailOf([{ x: 0, y: 0 }], 5))).toEqual([[0, 0]])
  })

  it('零长度分段被跳过，不会死循环或产生 NaN', () => {
    const tail = tailOf(
      [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 30 },
      ],
      10,
    )
    expect(xy(tail)).toEqual([
      [20, 20],
      [20, 30],
    ])
  })
})
