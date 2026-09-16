/**
 * 容器切割树的键盘等价物（`features/layout/tree-keys.ts`）。
 *
 * 钉三件事：`Alt+1/2/3` 搬到主叶对应侧（含"已经在那里就不再切一刀"的幂等闸）、
 * `Alt+←/→` 在标签条里换位置、没用过的组合不吞键（返回 `null`）。
 */

import { describe, expect, it } from 'vitest'

import { migrateLayout } from '@/features/layout/layout-sync'
import { keyboardMoveItem } from '@/features/layout/tree-keys'
import {
  DEFAULT_MAIN_LEAF_ID,
  findLeaf,
  itemsOf,
  leafOfItem,
  leaves,
  moveItem,
  noteItem,
  type TreeLayout,
} from '@/features/layout/tree-layout'

/** 一棵带笔记的树：main 叶有 a/b 两篇笔记，四个模块各占一格（默认迁移形态）。 */
const base = (): TreeLayout => migrateLayout(undefined, { dock: null, notes: ['a.md', 'b.md'] })

/** 某个叶子在主叶的哪一侧（供"搬到哪儿"的断言复用）。 */
function sideOfMain(layout: TreeLayout, leafId: string): 'left' | 'right' | 'below' | null {
  const mainId = findLeaf(layout, DEFAULT_MAIN_LEAF_ID)?.id
  if (mainId === undefined) return null
  // 从主叶往上找：它的父 split 的另一半子树里有没有目标叶子
  const visit = (node: TreeLayout, trail: Array<{ axis: string; inA: boolean }>): null | 'left' | 'right' | 'below' => {
    if (node.kind === 'leaf') {
      if (node.id !== leafId || trail.length === 0) return null
      const last = trail[trail.length - 1]!
      if (last.axis === 'row') return last.inA ? 'left' : 'right'
      return last.inA ? null : 'below' // 主叶在上方（inA=false 表示目标在后半 = 下方）
    }
    const inA = visit(node.a, [...trail, { axis: node.axis, inA: true }])
    return inA ?? visit(node.b, [...trail, { axis: node.axis, inA: false }])
  }
  return visit(layout, [])
}

describe('Alt+1/2/3：搬到主叶的左 / 右 / 下', () => {
  it('Alt+3 把文件树搬到主叶下方', () => {
    const next = keyboardMoveItem(base(), 'tree', 'Alt+3')
    expect(next).not.toBeNull()
    const leaf = leafOfItem(next!, 'tree')
    expect(leaf).not.toBeNull()
    expect(leafOfItem(next!, noteItem('a.md'))?.id).toBe(DEFAULT_MAIN_LEAF_ID)
    // 整棵树仍然合法（每个标签恰好一次）
    expect(new Set(itemsOf(next!)).size).toBe(itemsOf(next!).length)
    expect(sideOfMain(next!, leaf!.id)).toBe('below')
  })

  it('Alt+1 / Alt+2 分别落到主叶左 / 右', () => {
    const left = keyboardMoveItem(base(), 'outline', 'Alt+1')
    expect(sideOfMain(left!, leafOfItem(left!, 'outline')!.id)).toBe('left')
    const right = keyboardMoveItem(base(), 'tree', 'Alt+2')
    expect(sideOfMain(right!, leafOfItem(right!, 'tree')!.id)).toBe('right')
  })

  it('笔记标签也能搬（树模型里模块与笔记是同一类东西）', () => {
    const next = keyboardMoveItem(base(), noteItem('b.md'), 'Alt+2')
    expect(next).not.toBeNull()
    expect(sideOfMain(next!, leafOfItem(next!, noteItem('b.md'))!.id)).toBe('right')
  })

  it('已经在主叶那一侧（独占一格）时返回 null：不再切一刀', () => {
    const moved = keyboardMoveItem(base(), 'tree', 'Alt+3')!
    // 再按一次 Alt+3：文件树已经独占一格挂在主叶下方 ⇒ 无操作
    expect(keyboardMoveItem(moved, 'tree', 'Alt+3')).toBeNull()
    // 但搬到另一侧仍然有效
    expect(keyboardMoveItem(moved, 'tree', 'Alt+1')).not.toBeNull()
  })

  it('与别的标签共处一格时不算"已经在那里"（照样搬）', () => {
    // 把 tags 并进 tree 的格子：tree 不再独占，Alt+3 应当照样执行
    let tree = base()
    tree = moveItem(tree, 'tags', { leafId: leafOfItem(tree, 'tree')!.id })
    expect(keyboardMoveItem(tree, 'tree', 'Alt+3')).not.toBeNull()
  })
})

describe('Alt+←/→：标签条内换位置', () => {
  it('右移一位 / 左移一位', () => {
    const tree = base() // main: [a.md, b.md]
    const right = keyboardMoveItem(tree, noteItem('a.md'), 'Alt+ArrowRight')
    expect(findLeaf(right!, DEFAULT_MAIN_LEAF_ID)?.items).toEqual([noteItem('b.md'), noteItem('a.md')])
    const back = keyboardMoveItem(right!, noteItem('a.md'), 'Alt+ArrowLeft')
    expect(findLeaf(back!, DEFAULT_MAIN_LEAF_ID)?.items).toEqual([noteItem('a.md'), noteItem('b.md')])
  })

  it('到头再按 = null（不吞键、不变树）', () => {
    const tree = base()
    expect(keyboardMoveItem(tree, noteItem('a.md'), 'Alt+ArrowLeft')).toBeNull()
    expect(keyboardMoveItem(tree, noteItem('b.md'), 'Alt+ArrowRight')).toBeNull()
  })

  it('独占一格的标签没有"换位置"可做', () => {
    expect(keyboardMoveItem(base(), 'tree', 'Alt+ArrowLeft')).toBeNull()
  })
})

describe('没定义的组合与边界', () => {
  it('Alt+↑/↓ 与无关键一律 null', () => {
    const tree = base()
    expect(keyboardMoveItem(tree, 'tree', 'Alt+ArrowUp')).toBeNull()
    expect(keyboardMoveItem(tree, 'tree', 'Alt+ArrowDown')).toBeNull()
    expect(keyboardMoveItem(tree, 'tree', 'ArrowLeft')).toBeNull()
    expect(keyboardMoveItem(tree, 'tree', 'Alt+4')).toBeNull()
  })

  it('不在树上的标签：null', () => {
    expect(keyboardMoveItem(base(), noteItem('ghost.md'), 'Alt+1')).toBeNull()
  })

  it('主叶不存在（极端自定义布局）时 Alt+数字 = null', () => {
    // 只有一格模块、没有 main 叶的树（规范化允许：至少一个叶子）
    const weird: TreeLayout = { kind: 'leaf', id: 'only', items: ['tree'], active: 'tree' }
    expect(keyboardMoveItem(weird, 'tree', 'Alt+3')).toBeNull()
    // 叶子总数 sanity check：base 里至少有 main + 四个模块
    expect(leaves(base()).length).toBeGreaterThanOrEqual(5)
  })
})
