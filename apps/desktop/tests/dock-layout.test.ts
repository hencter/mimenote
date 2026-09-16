/**
 * 旧停靠格式（`features/dock/dock-layout.ts`）的**读取面**测试。
 *
 * 这个文件曾经覆盖整套停靠模型（搬移 / 键盘 / 落点下标）；那些操作已随渲染器退役，
 * 等价物在 `tree-layout.test.ts`（模型）与 `tree-keys.test.ts`（键盘）。
 * 这里只剩：旧格式的**形状校验**与**缺省值** —— 它们是迁移与回滚的输入契约
 * （`layout-sync.test.ts` 另有一组钉"旧默认布局 ↔ 模块默认落点"的一致性）。
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_DOCK_LAYOUT,
  DOCK_SIDES,
  isDockLayout,
  type DockLayout,
} from '@/features/dock/dock-layout'

describe('isDockLayout', () => {
  it('合法形状通过', () => {
    expect(isDockLayout(DEFAULT_DOCK_LAYOUT)).toBe(true)
    expect(isDockLayout({ left: [], right: [], bottom: [] })).toBe(true)
  })

  it('缺区 / 区不是数组 / 未知模块名：拒绝', () => {
    expect(isDockLayout({ left: ['tree'] })).toBe(false)
    expect(isDockLayout({ left: 'tree', right: [], bottom: [] })).toBe(false)
    expect(isDockLayout({ left: ['不认识'], right: [], bottom: [] })).toBe(false)
    expect(isDockLayout(null)).toBe(false)
    expect(isDockLayout(['tree'])).toBe(false)
  })

  it('同一个模块出现在两个区 = 会被渲染两遍：整份拒绝', () => {
    expect(isDockLayout({ left: ['tree'], right: ['tree'], bottom: [] })).toBe(false)
    expect(isDockLayout({ left: ['tree', 'tree'], right: [], bottom: [] })).toBe(false)
  })

  it('顺序保留（迁移要照抄它转成树的左右/上下关系）', () => {
    const value: DockLayout = { left: ['outline', 'tree'], right: ['tags'], bottom: ['links'] }
    expect(isDockLayout(value)).toBe(true)
    expect(value.left).toEqual(['outline', 'tree'])
  })
})

describe('DEFAULT_DOCK_LAYOUT', () => {
  it('覆盖全部三区与四个模块（迁移种子的完备性）', () => {
    for (const side of DOCK_SIDES) expect(Array.isArray(DEFAULT_DOCK_LAYOUT[side])).toBe(true)
    expect([
      ...DEFAULT_DOCK_LAYOUT.left,
      ...DEFAULT_DOCK_LAYOUT.right,
      ...DEFAULT_DOCK_LAYOUT.bottom,
    ].sort()).toEqual(['links', 'outline', 'tags', 'tree'])
  })
})
