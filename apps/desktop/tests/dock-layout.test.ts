/**
 * 停靠模型（`features/dock/dock-layout.ts`）的纯函数测试。
 *
 * 这一层是"拖拽落点 / 键盘搬运"的判据，出错的表现是**模块跑到奇怪的位置或凭空消失**，
 * 而那种问题在界面上很难复现（要先摆出一个特定的多模块排布）。所以这里用手算的数组钉死。
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_DOCK_LAYOUT,
  DOCK_SIDES,
  insertionIndexFor,
  isDockLayout,
  keyboardMove,
  moveDockModule,
  sideOfModule,
  type DockLayout,
} from '@/features/dock/dock-layout'

const BASE: DockLayout = { left: ['tree'], right: ['links', 'tags'], bottom: ['outline'] }

describe('isDockLayout（形状 + 不变式）', () => {
  it('接受缺省布局与任意合法布局', () => {
    expect(isDockLayout(DEFAULT_DOCK_LAYOUT)).toBe(true)
    expect(isDockLayout(BASE)).toBe(true)
    expect(isDockLayout({ left: [], right: [], bottom: [] })).toBe(true)
  })

  it('缺字段 / 类型不对 / 不认识的模块名都拒绝', () => {
    expect(isDockLayout(null)).toBe(false)
    expect(isDockLayout([])).toBe(false)
    expect(isDockLayout({ left: ['tree'], right: ['links'] })).toBe(false)
    expect(isDockLayout({ left: 'tree', right: [], bottom: [] })).toBe(false)
    expect(isDockLayout({ left: ['笔记'], right: [], bottom: [] })).toBe(false)
    expect(isDockLayout({ left: [1], right: [], bottom: [] })).toBe(false)
  })

  it('同一个模块出现两次 ⇒ 整份拒绝（那会让它被渲染两遍）', () => {
    expect(isDockLayout({ left: ['tree'], right: ['tree'], bottom: [] })).toBe(false)
    expect(isDockLayout({ left: ['tree', 'tree'], right: [], bottom: [] })).toBe(false)
  })
})

describe('moveDockModule', () => {
  it('搬到另一侧：追加到末尾，原位置不再有它', () => {
    const next = moveDockModule(BASE, 'tree', 'bottom')

    expect(next.left).toEqual([])
    expect(next.bottom).toEqual(['outline', 'tree'])
    expect(next.right).toEqual(['links', 'tags'])
    // 每个模块恰好一次（模型的不变式）
    expect([...next.left, ...next.right, ...next.bottom].sort()).toEqual([
      'links',
      'outline',
      'tags',
      'tree',
    ])
  })

  it('指定下标：插到那一位（索引是"移除自己之后"的口径）', () => {
    const next = moveDockModule(BASE, 'outline', 'right', 1)

    expect(next.bottom).toEqual([])
    expect(next.right).toEqual(['links', 'outline', 'tags'])
  })

  it('同侧内换位置：索引 ±1 就是"上移/下移一位"', () => {
    const next = moveDockModule(BASE, 'tags', 'right', 0)

    expect(next.right).toEqual(['tags', 'links'])
  })

  it('越界下标被夹进合法范围（拖到空白处常常给出一个略大的数）', () => {
    expect(moveDockModule(BASE, 'tree', 'right', 99).right).toEqual(['links', 'tags', 'tree'])
    expect(moveDockModule(BASE, 'tree', 'right', -5).right).toEqual(['tree', 'links', 'tags'])
  })

  it('搬到同一个位置 = 原样（幂等：拖动落在原地不该产生变化）', () => {
    expect(moveDockModule(BASE, 'tree', 'left', 0)).toEqual(BASE)
  })
})

describe('sideOfModule', () => {
  it('返回它在哪一区；没出现过返回 null', () => {
    expect(sideOfModule(BASE, 'tree')).toBe('left')
    expect(sideOfModule(BASE, 'outline')).toBe('bottom')
    expect(sideOfModule({ left: [], right: [], bottom: [] }, 'tree')).toBeNull()
  })
})

describe('insertionIndexFor（拖拽落点）', () => {
  const centers = [100, 300, 500]

  it('指针落在某个模块的前半段 ⇒ 插在它前面', () => {
    expect(insertionIndexFor(centers, 40)).toBe(0)
    expect(insertionIndexFor(centers, 99)).toBe(0)
    expect(insertionIndexFor(centers, 250)).toBe(1)
    expect(insertionIndexFor(centers, 450)).toBe(2)
  })

  it('指针落在最后一个模块之后 ⇒ 插到末尾', () => {
    expect(insertionIndexFor(centers, 500)).toBe(3)
    expect(insertionIndexFor(centers, 9999)).toBe(3)
  })

  it('没有模块时恒为 0（空区只能插第一个位置）', () => {
    expect(insertionIndexFor([], 123)).toBe(0)
  })
})

describe('keyboardMove（拖拽的键盘等价物）', () => {
  it('Alt+1/2/3 搬到左 / 右 / 底部', () => {
    expect(moveOf(keyboardMove(BASE, 'tree', 'Alt+2'), 'tree')).toBe('right')
    expect(moveOf(keyboardMove(BASE, 'tree', 'Alt+3'), 'tree')).toBe('bottom')
    expect(moveOf(keyboardMove(BASE, 'outline', 'Alt+1'), 'outline')).toBe('left')
  })

  it('已经在那一区 ⇒ 不动（返回 null，调用方据此不吞按键）', () => {
    expect(keyboardMove(BASE, 'tree', 'Alt+1')).toBeNull()
    expect(keyboardMove(BASE, 'outline', 'Alt+3')).toBeNull()
  })

  it('同区内用方向键换位置：左右区用 ↑↓、底部区用 ←→', () => {
    expect(moveOf(keyboardMove(BASE, 'tags', 'Alt+ArrowUp'), 'tags')).toBe('right')
    expect(keyboardMove(BASE, 'tags', 'Alt+ArrowUp')?.right).toEqual(['tags', 'links'])
    // 左/右区里的 ←→ 没有定义（那是"换区"的键形，见实现说明）→ 不动
    expect(keyboardMove(BASE, 'tags', 'Alt+ArrowLeft')).toBeNull()
    // 底部区里的 ↑↓ 同理
    expect(keyboardMove(BASE, 'outline', 'Alt+ArrowUp')).toBeNull()
  })

  it('到头了就不再动（第一个还想往前 / 最后一个还想往后）', () => {
    expect(keyboardMove(BASE, 'links', 'Alt+ArrowUp')).toBeNull()
    expect(keyboardMove(BASE, 'tree', 'Alt+ArrowDown')).toBeNull()
  })

  it('没定义过的按键返回 null', () => {
    expect(keyboardMove(BASE, 'tree', 'Alt+Tab')).toBeNull()
    expect(keyboardMove(BASE, 'tree', 'ArrowUp')).toBeNull()
  })

  it('三个区都在映射表里（DOCK_SIDES 与 Alt+1/2/3 一一对应）', () => {
    // ⚠️ 起点必须是"这个模块**不在**目标区"的布局：先把它搬过去再按同一个键，
    // 正确的行为是不动（见上一条），拿它当"映射对不对"的证据只会得到 null
    expect(DOCK_SIDES).toEqual(['left', 'right', 'bottom'])
    expect(moveOf(keyboardMove(BASE, 'outline', 'Alt+1'), 'outline')).toBe('left')
    expect(moveOf(keyboardMove(BASE, 'outline', 'Alt+2'), 'outline')).toBe('right')
    expect(keyboardMove(BASE, 'outline', 'Alt+3')).toBeNull() // 它本来就在底部
  })
})

/** 某个模块在某份布局里的区（`null` 说明它没出现过 —— 那种情况下断言应当失败）。 */
function moveOf(layout: DockLayout | null, id: 'tree' | 'links' | 'tags' | 'outline'): string | null {
  if (layout === null) return null
  return sideOfModule(layout, id)
}
