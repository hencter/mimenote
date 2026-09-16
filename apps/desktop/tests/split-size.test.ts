/**
 * 模块独占新格时的家尺寸比例（`features/layout/split-size.ts`）。
 *
 * 钉的是换算本身：像素 → 份额 →（按落边）前半占比；以及"量不到尺寸就保持 0.5"的降级。
 */

import { describe, expect, it } from 'vitest'

import { migrateLayout } from '@/features/layout/layout-sync'
import {
  adjustNewSplitRatio,
  MODULE_HOME_PX,
  parentSplitIdOf,
  preferredSplitRatio,
} from '@/features/layout/split-size'
import {
  DEFAULT_MAIN_LEAF_ID,
  leafOfItem,
  moveItem,
  noteItem,
  type TreeLayout,
} from '@/features/layout/tree-layout'

describe('preferredSplitRatio：像素 → 比例', () => {
  it('左/右落边按宽度，上/下落边按高度；落在后半时取 1 − 份额', () => {
    // 文件树家宽 288：1000px 的格子上切左边 ⇒ 前半 0.288
    expect(preferredSplitRatio('tree', 'left', 1000)).toBeCloseTo(0.288, 3)
    // 切右边 ⇒ 模块在后半 ⇒ 前半占 1 − 0.288
    expect(preferredSplitRatio('tree', 'right', 1000)!).toBeCloseTo(1 - 0.288, 3)
    // 底边按家高 220：400px 高的格子 ⇒ 前半 1 − 0.55
    expect(preferredSplitRatio('tree', 'bottom', 400)!).toBeCloseTo(1 - 220 / 400, 3)
  })

  it('份额夹进 [MIN_RATIO, MAX_RATIO]（小格子不会把模块拖死）', () => {
    expect(preferredSplitRatio('tree', 'left', 100)).toBeGreaterThanOrEqual(0.15)
    expect(preferredSplitRatio('tree', 'left', 10_000)).toBeLessThanOrEqual(0.85)
  })

  it('笔记没有家尺寸（null = 保持 0.5）；量不到尺寸同样是 null', () => {
    expect(preferredSplitRatio(noteItem('a.md'), 'left', 1000)).toBeNull()
    expect(preferredSplitRatio('tree', 'left', 0)).toBeNull()
    expect(preferredSplitRatio('tree', 'left', Number.NaN)).toBeNull()
  })
})

describe('adjustNewSplitRatio：搬完之后调新刀', () => {
  const base = (): TreeLayout => migrateLayout(undefined, { dock: null, notes: ['a.md'] })

  it('把新刀的比例调成模块家尺寸（左落边 = 前半是模块）', () => {
    let tree = base()
    tree = moveItem(tree, 'tree', { leafId: DEFAULT_MAIN_LEAF_ID, edge: 'left' })
    const adjusted = adjustNewSplitRatio({ layout: tree, item: 'tree', edge: 'left', extentPx: 1280 })
    const splitId = parentSplitIdOf(adjusted, leafOfItem(adjusted, 'tree')!.id)!
    // 找到新刀，比例 = 288/1280 ≈ 0.225（而不是 0.5）
    expect(splitId).not.toBeNull()
    const findRatio = (node: TreeLayout): number => {
      if (node.kind === 'leaf') return -1
      if (node.id === splitId) return node.ratio
      const a = findRatio(node.a)
      return a === -1 ? findRatio(node.b) : a
    }
    expect(findRatio(adjusted)).toBeCloseTo(MODULE_HOME_PX.tree.width / 1280, 3)
  })

  it('笔记切割 / 量不到尺寸：原样返回', () => {
    let tree = base()
    tree = moveItem(tree, noteItem('a.md'), { leafId: DEFAULT_MAIN_LEAF_ID, edge: 'right' })
    const adjusted = adjustNewSplitRatio({ layout: tree, item: noteItem('a.md'), edge: 'right', extentPx: 1280 })
    expect(adjusted).toBe(tree)
  })
})
