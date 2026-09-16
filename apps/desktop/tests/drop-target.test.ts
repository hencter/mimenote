/**
 * 落点几何（`features/layout/drop-target.ts`）：手算坐标钉住两条判据 ——
 * 内容区的"边缘带切一刀 / 中央并入"，与标签条上的"插到第几位"。
 */

import { describe, expect, it } from 'vitest'

import { contentDropAt, EDGE_BAND, tabIndexAt } from '@/features/layout/drop-target'

describe('contentDropAt：内容区落点', () => {
  // 100×100、左上角在 (0,0) 的格子，后面的坐标都按它手算
  const rect = { left: 0, top: 0, width: 100, height: 100 }

  it('正中央 = 并入', () => {
    expect(contentDropAt(rect, 50, 50)).toEqual({ kind: 'merge' })
  })

  it('四条边带各切一刀，方向与边缘对应', () => {
    expect(contentDropAt(rect, 5, 50)).toEqual({ kind: 'split', edge: 'left' })
    expect(contentDropAt(rect, 95, 50)).toEqual({ kind: 'split', edge: 'right' })
    expect(contentDropAt(rect, 50, 5)).toEqual({ kind: 'split', edge: 'top' })
    expect(contentDropAt(rect, 50, 95)).toEqual({ kind: 'split', edge: 'bottom' })
  })

  it('边缘带的边界：恰好 EDGE_BAND 处算中央（带是"不足四分之一"）', () => {
    const at = EDGE_BAND * 100
    expect(contentDropAt(rect, at - 1, 50)).toEqual({ kind: 'split', edge: 'left' })
    expect(contentDropAt(rect, at, 50)).toEqual({ kind: 'merge' })
  })

  it('角落归到更近的那条边（不给角落单独定规则）', () => {
    expect(contentDropAt(rect, 2, 10)).toEqual({ kind: 'split', edge: 'left' })
    expect(contentDropAt(rect, 10, 2)).toEqual({ kind: 'split', edge: 'top' })
  })

  it('带子随格子缩放：窄格子里同样的绝对偏移可能是中央', () => {
    const narrow = { left: 0, top: 0, width: 20, height: 100 }
    // 20px 宽的格子：x=10 已经是最左 50%，不在带里
    expect(contentDropAt(narrow, 10, 50)).toEqual({ kind: 'merge' })
    expect(contentDropAt(narrow, 2, 50)).toEqual({ kind: 'split', edge: 'left' })
  })

  it('退化矩形（没有面积）一律并入', () => {
    expect(contentDropAt({ left: 0, top: 0, width: 0, height: 100 }, 0, 50)).toEqual({
      kind: 'merge',
    })
  })
})

describe('tabIndexAt：标签条插入下标', () => {
  it('落在某个标签中线左侧就插到它前面', () => {
    expect(tabIndexAt([30, 90, 150], 0)).toBe(0)
    expect(tabIndexAt([30, 90, 150], 59)).toBe(1)
    expect(tabIndexAt([30, 90, 150], 91)).toBe(2)
  })

  it('越过最后一个中线 = 追加到末尾；空条 = 0', () => {
    expect(tabIndexAt([30, 90], 999)).toBe(2)
    expect(tabIndexAt([], 40)).toBe(0)
  })
})
