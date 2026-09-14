/**
 * 视口换算（`features/graph/viewport.ts`）。
 *
 * 这一层没有 UI，但它是 canvas 化之后最容易出错的地方：卡片在 canvas 上（屏幕空间）、
 * 连线与文件夹标题在 DOM 里（CSS transform），两套坐标差一点就表现为"点不中卡片"。
 * 所以这里钉的是**不变量**，而不是某一次的具体数字：
 * 往返一致、与 `layout.ts` 的 `worldViewport` 同一条口径、DPR 只影响像素尺寸。
 */

import { describe, expect, it } from 'vitest'

import { MAX_ZOOM, MIN_ZOOM, worldViewport, type GraphView } from '@/features/graph/layout'
import {
  canvasSize,
  hitTolerance,
  rectHit,
  screenRect,
  toScreen,
  toWorld,
  transformOf,
  visibleWorld,
  worldRect,
} from '@/features/graph/viewport'

const VIEWPORT = { width: 1000, height: 600 }

function view(overrides: Partial<GraphView> = {}): GraphView {
  return { x: 0, y: 0, zoom: 1, ...overrides }
}

describe('世界 ↔ 屏幕', () => {
  it('平移只加偏移，缩放只乘系数（与 CSS `transform-origin: 0 0` 同一套）', () => {
    const transform = transformOf(view({ x: 30, y: -12, zoom: 2 }), VIEWPORT)

    expect(toScreen(transform, { x: 10, y: 10 })).toEqual({ x: 50, y: 8 })
    expect(toWorld(transform, { x: 50, y: 8 })).toEqual({ x: 10, y: 10 })
  })

  it('往返一致（缩放与偏移任意组合）', () => {
    for (const zoom of [0.35, 1, 1.7, 2.5]) {
      for (const point of [
        { x: 0, y: 0 },
        { x: -1234.5, y: 987.25 },
        { x: 42, y: -42 },
      ]) {
        const transform = transformOf(view({ x: -17, y: 33, zoom }), VIEWPORT)
        const back = toWorld(transform, toScreen(transform, point))
        expect(back.x).toBeCloseTo(point.x, 6)
        expect(back.y).toBeCloseTo(point.y, 6)
      }
    }
  })

  it('缩放被夹在 0.25..2.5，与 DOM 层同一条口径（否则 canvas 与 DOM 会错位）', () => {
    expect(transformOf(view({ zoom: 99 }), VIEWPORT).scale).toBe(MAX_ZOOM)
    expect(transformOf(view({ zoom: 0.001 }), VIEWPORT).scale).toBe(MIN_ZOOM)
  })

  it('矩形换算：宽高也乘缩放，往返一致', () => {
    const transform = transformOf(view({ x: 5, y: 5, zoom: 1.5 }), VIEWPORT)
    const rect = { x: 10, y: 20, width: 100, height: 40 }

    expect(screenRect(transform, rect)).toEqual({ x: 20, y: 35, width: 150, height: 60 })
    expect(worldRect(transform, screenRect(transform, rect))).toEqual(rect)
  })

  it('可见世界区域与 `layout.ts` 的 `worldViewport`（无 overscan）逐字一致', () => {
    // 这两处的口径**必须**一致：卡片按前者裁剪、DOM 层按后者渲染，差一点就会
    // "连线还在、卡片消失"（或反过来）。所以这里逐字比对，而不是各算各的。
    for (const zoom of [0.25, 1, 2.5]) {
      for (const offset of [0, -240.5, 88]) {
        const state = view({ x: offset, y: -offset, zoom })
        const mine = visibleWorld(transformOf(state, VIEWPORT))
        const theirs = worldViewport(state, VIEWPORT, 0)
        expect(mine.x).toBeCloseTo(theirs.x, 6)
        expect(mine.y).toBeCloseTo(theirs.y, 6)
        expect(mine.width).toBeCloseTo(theirs.width, 6)
        expect(mine.height).toBeCloseTo(theirs.height, 6)
      }
    }
  })

  it('overscan 按缩放折算：屏幕上的 240px 在任何缩放下都是 240px', () => {
    const transform = transformOf(view({ zoom: 2 }), VIEWPORT)
    const plain = visibleWorld(transform)
    const padded = visibleWorld(transform, 240)

    expect(padded.width - plain.width).toBeCloseTo(240, 6)
    expect(padded.x).toBeCloseTo(plain.x - 120, 6)
  })
})

describe('canvas 像素尺寸', () => {
  it('物理像素 = CSS 尺寸 × DPR，DPR 交回给调用方设置 transform', () => {
    expect(canvasSize({ width: 800, height: 600 }, 2)).toEqual({ width: 1600, height: 1200, dpr: 2 })
  })

  it('DPR 封顶 3（4K 屏上 4 倍像素只是白烧 GPU），非法值退成 1', () => {
    expect(canvasSize({ width: 100, height: 100 }, 4).dpr).toBe(3)
    expect(canvasSize({ width: 100, height: 100 }, Number.NaN)).toEqual({
      width: 100,
      height: 100,
      dpr: 1,
    })
    expect(canvasSize({ width: 100, height: 100 }, 0).dpr).toBe(1)
  })
})

describe('命中判定', () => {
  it('宽容度按屏幕像素给：缩得越小，世界里给的余量越大', () => {
    expect(hitTolerance(transformOf(view({ zoom: 0.25 }), VIEWPORT), 4)).toBe(16)
    expect(hitTolerance(transformOf(view({ zoom: 2 }), VIEWPORT), 4)).toBe(2)
  })

  it('矩形命中：边界算命中，宽容度向外扩', () => {
    const rect = { x: 0, y: 0, width: 10, height: 10 }

    expect(rectHit(rect, { x: 5, y: 5 })).toBe(true)
    expect(rectHit(rect, { x: 0, y: 10 })).toBe(true)
    expect(rectHit(rect, { x: 10.5, y: 5 })).toBe(false)
    expect(rectHit(rect, { x: 10.5, y: 5 }, 1)).toBe(true)
    expect(rectHit(rect, { x: -2, y: 5 }, 1)).toBe(false)
  })
})
