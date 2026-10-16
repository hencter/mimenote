/** 虚拟列表窗口计算：文件树 60fps 的结构性保证，必须有测试。 */

import { describe, expect, it } from 'vitest'

import { computeWindow, scrollTopToReveal } from '@/domain/virtual-list'

describe('computeWindow', () => {
  it('空列表返回空窗口', () => {
    expect(computeWindow({ scrollTop: 0, viewportHeight: 400, rowHeight: 24, itemCount: 0 })).toEqual({
      start: 0,
      end: 0,
      totalHeight: 0,
      offsetY: 0,
    })
  })

  it('行高非法时安全退化', () => {
    expect(computeWindow({ scrollTop: 0, viewportHeight: 400, rowHeight: 0, itemCount: 10 })).toEqual({
      start: 0,
      end: 0,
      totalHeight: 0,
      offsetY: 0,
    })
  })

  it('顶部：从 0 开始渲染并包含 overscan', () => {
    const range = computeWindow({
      scrollTop: 0,
      viewportHeight: 260,
      rowHeight: 26,
      itemCount: 10_000,
      overscan: 8,
    })
    expect(range.start).toBe(0)
    // 可视 11 行 + 8 行 overscan
    expect(range.end).toBe(19)
    expect(range.offsetY).toBe(0)
    expect(range.totalHeight).toBe(260_000)
  })

  it('中部：窗口随滚动平移，行数 = 可视行 + 上下 overscan', () => {
    const range = computeWindow({
      scrollTop: 26_000,
      viewportHeight: 260,
      rowHeight: 26,
      itemCount: 10_000,
      overscan: 8,
    })
    expect(range.start).toBe(992)
    // 可视 11 行 + 上 8 行 + 下 8 行
    expect(range.end - range.start).toBe(27)
    expect(range.offsetY).toBe(992 * 26)
  })

  it('底部：不越界', () => {
    const range = computeWindow({
      scrollTop: 260_000,
      viewportHeight: 260,
      rowHeight: 26,
      itemCount: 10_000,
      overscan: 8,
    })
    expect(range.end).toBe(10_000)
    expect(range.start).toBeLessThan(10_000)
  })

  it('超出最大滚动量时按最大值收敛', () => {
    const range = computeWindow({
      scrollTop: 999_999,
      viewportHeight: 260,
      rowHeight: 26,
      itemCount: 100,
      overscan: 4,
    })
    expect(range.end).toBe(100)
    expect(range.totalHeight).toBe(2600)
  })

  it('负 scrollTop 视为 0', () => {
    const range = computeWindow({ scrollTop: -50, viewportHeight: 260, rowHeight: 26, itemCount: 100 })
    expect(range.start).toBe(0)
    expect(range.offsetY).toBe(0)
  })

  it('十万条目下窗口大小仍恒定（10 万行不渲染 10 万 DOM）', () => {
    const range = computeWindow({
      scrollTop: 1_300_000,
      viewportHeight: 800,
      rowHeight: 26,
      itemCount: 100_000,
      overscan: 10,
    })
    expect(range.end - range.start).toBeLessThan(60)
  })
})

describe('scrollTopToReveal', () => {
  const base = { viewportHeight: 260, rowHeight: 26, itemCount: 1000 }

  it('行在视口上方 → 顶对齐', () => {
    expect(scrollTopToReveal(3, 500, base.viewportHeight, base.rowHeight, base.itemCount)).toBe(78)
  })

  it('行在视口下方 → 底对齐', () => {
    expect(scrollTopToReveal(40, 0, base.viewportHeight, base.rowHeight, base.itemCount)).toBe(40 * 26 + 26 - 260)
  })

  it('行已可见 → 保持原位置', () => {
    expect(scrollTopToReveal(5, 130, base.viewportHeight, base.rowHeight, base.itemCount)).toBe(130)
  })

  it('不会滚过末尾', () => {
    const value = scrollTopToReveal(999, 0, base.viewportHeight, base.rowHeight, base.itemCount)
    expect(value).toBeLessThanOrEqual(1000 * 26 - 260)
  })
})
