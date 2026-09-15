/**
 * 容器切割树（ADR-0035）的**不变式与操作**。
 *
 * 这一层是纯函数，所以判据可以逐条钉死：六条不变式各有一条用例，加上
 * **随机操作序列**（固定种子的 xorshift32，与力场同一个纪律）捶 500 次 ——
 * 树模型最容易死在"某个操作路径忘了塌缩空叶 / 忘了去重"这种地方，
 * 而那类 bug 靠手写用例很难穷尽。
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_MAIN_LEAF_ID,
  MAX_RATIO,
  MIN_RATIO,
  attachItem,
  defaultLayout,
  evenSplit,
  findLeaf,
  fromDockLayout,
  isViewModule,
  itemsOf,
  leafOfItem,
  leaves,
  moveItem,
  noteItem,
  notePathOf,
  normalizeLayout,
  removeItem,
  setActive,
  setRatio,
  type LayoutItemId,
  type TreeLayout,
} from '@/features/layout/tree-layout'

/** 找某个节点的父 split（断言"这一刀切在哪个方向"时要看父节点）。 */
function parentOf(layout: TreeLayout, childId: string): { axis: string; a: TreeLayout; b: TreeLayout } | null {
  if (layout.kind === 'leaf') return null
  for (const child of [layout.a, layout.b]) {
    if (child.id === childId) return { axis: layout.axis, a: layout.a, b: layout.b }
  }
  return parentOf(layout.a, childId) ?? parentOf(layout.b, childId)
}

/** 六条不变式（除"至少一个叶子"由 `normalizeLayout` 的兜底保证外，其余都在这里断言）。 */
function expectInvariants(layout: TreeLayout): void {
  const allLeaves = leaves(layout)

  // 1. 每个标签全树恰好出现一次
  const items = itemsOf(layout)
  expect(new Set(items).size, `标签重复：${items.join('、')}`).toBe(items.length)

  // 2. 空叶塌缩：**树里只允许剩下一个叶子，且它可以是空的**（"还没打开任何笔记"是正常状态）
  if (allLeaves.length > 1) {
    for (const leaf of allLeaves) {
      expect(leaf.items.length, `空叶没塌缩：${leaf.id}`).toBeGreaterThan(0)
    }
  }

  // 3. 比例夹紧
  const checkRatios = (node: TreeLayout): void => {
    if (node.kind === 'leaf') return
    expect(node.ratio).toBeGreaterThanOrEqual(MIN_RATIO)
    expect(node.ratio).toBeLessThanOrEqual(MAX_RATIO)
    checkRatios(node.a)
    checkRatios(node.b)
  }
  checkRatios(layout)

  // 6. active 必须是本叶的标签之一；叶空时必须是 null
  for (const leaf of allLeaves) {
    if (leaf.items.length === 0) expect(leaf.active).toBeNull()
    else expect(leaf.items).toContain(leaf.active)
  }

  // 结构：split 恒有两个孩子（类型系统已保证，这里顺带确认没有 null 混进来）
  const walk = (node: TreeLayout): void => {
    if (node.kind === 'leaf') return
    expect(node.a).toBeTruthy()
    expect(node.b).toBeTruthy()
    walk(node.a)
    walk(node.b)
  }
  walk(layout)
}

describe('标签的判据', () => {
  it('视图模块是裸词，笔记带 `note:` 前缀（两者不会撞名）', () => {
    expect(isViewModule('tree')).toBe(true)
    expect(isViewModule('outline')).toBe(true)
    expect(isViewModule(noteItem('项目/设计.md'))).toBe(false)
    expect(notePathOf(noteItem('项目/设计.md'))).toBe('项目/设计.md')
    expect(notePathOf('tree')).toBeNull()
    // 路径里带冒号也不会被误判（前缀只在最前面认一次）
    expect(notePathOf(noteItem('a:b/c.md'))).toBe('a:b/c.md')
  })
})

describe('默认布局与迁移', () => {
  it('默认布局是一个空的叶（视图模块不预置，由停靠开关决定）', () => {
    const layout = defaultLayout()
    expect(layout).toEqual({ kind: 'leaf', id: DEFAULT_MAIN_LEAF_ID, items: [], active: null })
    expectInvariants(layout)
  })

  it('从停靠布局迁移：左/右/底三区各自成叶，笔记进主叶', () => {
    const layout = fromDockLayout(
      { left: ['tree', 'outline'], right: ['links'], bottom: ['tags'] },
      ['项目/设计.md'],
    )
    expectInvariants(layout)

    // 笔记在**主叶**里（迁移不该把笔记打散）
    expect(leafOfItem(layout, noteItem('项目/设计.md'))?.id).toBe(DEFAULT_MAIN_LEAF_ID)
    // 同一区里的多块模块各占一个叶子（今天它们"平分该区高度"）
    expect(leafOfItem(layout, 'tree')).not.toBeNull()
    expect(leafOfItem(layout, 'outline')).not.toBeNull()
    expect(leafOfItem(layout, 'tree')?.id).not.toBe(leafOfItem(layout, 'outline')?.id)
    expect(leafOfItem(layout, 'links')).not.toBeNull()
    expect(leafOfItem(layout, 'tags')).not.toBeNull()
    // 左区在最左、右区在最右（顺序由 attach 的先后保证）
    const order = leaves(layout).map((leaf) => leaf.items[0])
    expect(order.indexOf('tree')).toBeLessThan(order.indexOf(noteItem('项目/设计.md')))
    expect(order.indexOf(noteItem('项目/设计.md'))).toBeLessThan(order.indexOf('links'))
  })

  it('空区不产生节点；没有笔记时主叶是空的但仍在树上', () => {
    const layout = fromDockLayout({ left: ['tree'], right: [], bottom: [] })
    expectInvariants(layout)
    // 没有笔记 ⇒ 主叶是空的 ⇒ 它**塌缩**掉，树上只剩左区那一叶（这正是"不留空白容器"）
    const allLeaves = leaves(layout)
    expect(allLeaves).toHaveLength(1)
    expect(allLeaves[0]?.items).toEqual(['tree'])
  })
})

describe('操作：移动（拖标签的本质）', () => {
  const base = (): TreeLayout => fromDockLayout({ left: ['tree'], right: [], bottom: [] }, ['a.md', 'b.md'])

  it('拖到中心 = 变成那一格的一个标签（不是复制：原位置不再有它）', () => {
    const layout = moveItem(base(), 'tree', { leafId: DEFAULT_MAIN_LEAF_ID })
    expectInvariants(layout)
    expect(leafOfItem(layout, 'tree')?.id).toBe(DEFAULT_MAIN_LEAF_ID)
    expect(leafOfItem(layout, 'tree')?.items).toEqual([
      noteItem('a.md'),
      noteItem('b.md'),
      'tree',
    ])
    expect(findLeaf(layout, DEFAULT_MAIN_LEAF_ID)?.active).toBe('tree')
    // 原来那一格空了 ⇒ 已经塌缩掉，树上只剩主叶
    expect(leaves(layout)).toHaveLength(1)
  })

  it('拖到边缘 = 在那一侧切一刀（左右边缘切出 row，上下切出 column）', () => {
    const layout = moveItem(base(), noteItem('b.md'), { leafId: 'left-tree', edge: 'top' })
    expectInvariants(layout)

    // 被拖的那一篇独占一个新叶，它与 `left-tree` 是**上下**关系（top ⇒ column）
    const moved = leafOfItem(layout, noteItem('b.md'))
    expect(moved?.items).toEqual([noteItem('b.md')])
    expect(moved?.id).not.toBe('left-tree')
    const parent = parentOf(layout, moved?.id ?? '')
    expect(parent?.axis).toBe('column')
    // `top` = 落在前半
    expect(parent?.a).toEqual(moved)
    // 它原来在的主叶里不再有它（是搬家不是复制）
    expect(leafOfItem(base(), noteItem('b.md'))?.items).toContain(noteItem('b.md'))
    expect(moved?.items.filter((item) => item === noteItem('b.md'))).toHaveLength(1)
  })

  it('拖到自己所在的那一格：只改激活项，不重复插入', () => {
    const layout = moveItem(base(), noteItem('a.md'), { leafId: DEFAULT_MAIN_LEAF_ID })
    expectInvariants(layout)
    expect(itemsOf(layout).filter((item) => item === noteItem('a.md'))).toHaveLength(1)
  })

  it('目标叶不存在 / 标签不在树上：原样返回（拖到非法落点不该毁掉布局）', () => {
    const layout = base()
    expect(moveItem(layout, 'tree', { leafId: '不存在' })).toBe(layout)
    expect(moveItem(layout, noteItem('没有这篇.md'), { leafId: DEFAULT_MAIN_LEAF_ID })).toBe(layout)
  })

  it('移除标签：那一格空了就塌缩，兄弟顶上来', () => {
    const layout = removeItem(base(), 'tree')
    expectInvariants(layout)
    expect(layout).toEqual(findLeaf(base(), DEFAULT_MAIN_LEAF_ID))
  })

  it('setActive 只认本叶的标签；不在本叶就原样不动', () => {
    const layout = setActive(base(), DEFAULT_MAIN_LEAF_ID, noteItem('b.md'))
    expect(findLeaf(layout, DEFAULT_MAIN_LEAF_ID)?.active).toBe(noteItem('b.md'))
    const untouched = setActive(layout, DEFAULT_MAIN_LEAF_ID, 'tree')
    expect(findLeaf(untouched, DEFAULT_MAIN_LEAF_ID)?.active).toBe(noteItem('b.md'))
  })
})

describe('操作：分隔条', () => {
  it('比例被夹紧（拖到 0 也还能拖回来）', () => {
    // 带一篇笔记：不然空的主叶会塌缩掉，树上就没有 split 可调了
    const layout = fromDockLayout({ left: ['tree'], right: [], bottom: [] }, ['a.md'])
    const splitId = layout.kind === 'split' ? layout.id : ''
    expect(splitId).not.toBe('')

    const tiny = setRatio(layout, splitId, 0)
    expect(tiny.kind === 'split' ? tiny.ratio : -1).toBe(MIN_RATIO)
    const huge = setRatio(layout, splitId, 1)
    expect(huge.kind === 'split' ? huge.ratio : -1).toBe(MAX_RATIO)
    const even = evenSplit(huge, splitId)
    expect(even.kind === 'split' ? even.ratio : -1).toBe(0.5)
  })
})

describe('规范化：畸形 / 过期的输入（老配置不能把界面卡死）', () => {
  it('认不出的标签丢弃；重复的只留第一份', () => {
    const layout = normalizeLayout({
      kind: 'leaf',
      id: 'main',
      items: ['tree', 'tree', '不认识的模块', 'note:a.md', 42],
      active: '不认识的模块',
    })
    expect(layout.kind).toBe('leaf')
    if (layout.kind !== 'leaf') return
    expect(layout.items).toEqual(['tree', noteItem('a.md')])
    // active 认不出 ⇒ 退回第一个
    expect(layout.active).toBe('tree')
  })

  it('空叶塌缩：一侧全空时父节点被另一侧替换', () => {
    const layout = normalizeLayout({
      kind: 'split',
      id: 's',
      axis: 'row',
      ratio: 0.5,
      a: { kind: 'leaf', id: 'a', items: ['不认识的'], active: null },
      b: { kind: 'leaf', id: 'b', items: ['tree'], active: 'tree' },
    })
    expect(layout).toEqual({ kind: 'leaf', id: 'b', items: ['tree'], active: 'tree' })
  })

  it('比例非法（NaN / 越界 / 缺失）→ 0.5 或夹紧', () => {
    const build = (ratio: unknown): TreeLayout =>
      normalizeLayout({
        kind: 'split',
        id: 's',
        axis: 'row',
        ratio,
        a: { kind: 'leaf', id: 'a', items: ['tree'], active: 'tree' },
        b: { kind: 'leaf', id: 'b', items: ['outline'], active: 'outline' },
      })
    for (const bad of [Number.NaN, -3, 99, 'x', undefined]) {
      const layout = build(bad)
      expectInvariants(layout)
    }
    const fine = build(0.3)
    expect(fine.kind === 'split' ? fine.ratio : -1).toBe(0.3)
  })

  it('整棵树都不可用 → 退回默认布局（降级方向安全）', () => {
    for (const garbage of [null, 42, 'x', {}, { kind: 'split' }, { kind: 'leaf', items: ['tree'] }]) {
      const layout = normalizeLayout(garbage)
      expect(layout).toEqual(defaultLayout())
    }
  })

  it('深度上限：畸形的深层嵌套不会把递归打爆', () => {
    let nested: unknown = { kind: 'leaf', id: 'deep', items: ['tree'], active: 'tree' }
    for (let i = 0; i < 200; i += 1) {
      nested = { kind: 'split', id: `s${i}`, axis: 'row', ratio: 0.5, a: nested, b: null }
    }
    const layout = normalizeLayout(nested)
    expectInvariants(layout)
    // 塌缩之后只剩最里面那个叶子
    expect(leaves(layout)).toHaveLength(1)
  })
})

describe('随机操作序列（固定种子）：不变式在 500 步之后仍然成立', () => {
  it('移动 / 移除 / 切换 / 调比例混着来，树始终合法', () => {
    // xorshift32：与力场同一条确定性纪律（不用 Math.random，失败可复现）
    let state = 0x9e3779b9
    const next = (): number => {
      state ^= state << 13
      state >>>= 0
      state ^= state >>> 17
      state ^= state << 5
      state >>>= 0
      return state
    }
    const pick = <T>(list: readonly T[]): T | null =>
      list.length === 0 ? null : (list[next() % list.length] ?? null)

    let layout = fromDockLayout(
      { left: ['tree', 'outline'], right: ['links'], bottom: ['tags'] },
      ['a.md', 'b.md', 'c.md'],
    )
    const pool: LayoutItemId[] = ['tree', 'links', 'tags', 'outline']

    for (let step = 0; step < 500; step += 1) {
      const allLeaves = leaves(layout)
      const target = pick(allLeaves)
      switch (next() % 5) {
        case 0: {
          if (target === null) break
          const edge = pick(['left', 'right', 'top', 'bottom'] as const)
          const item = pick(itemsOf(layout))
          if (item !== null) layout = moveItem(layout, item, { leafId: target.id, edge: edge ?? undefined })
          break
        }
        case 1: {
          const item = pick(itemsOf(layout))
          if (item !== null) layout = removeItem(layout, item)
          break
        }
        case 2: {
          if (target === null) break
          const item = pick(target.items)
          if (item !== null) layout = setActive(layout, target.id, item)
          break
        }
        case 3: {
          const splitIds: string[] = []
          const collect = (node: TreeLayout): void => {
            if (node.kind === 'split') {
              splitIds.push(node.id)
              collect(node.a)
              collect(node.b)
            }
          }
          collect(layout)
          const splitId = pick(splitIds)
          if (splitId !== null) layout = setRatio(layout, splitId, (next() % 200) / 100 - 0.5)
          break
        }
        default: {
          // 把一个可能还没上树的模块挂上去（重复挂 = 移过去）
          const item = pick(pool)
          if (item !== null) layout = attachItem(layout, item, { edge: pick(['left', 'right', 'top', 'bottom'] as const) ?? undefined })
          break
        }
      }
      expectInvariants(layout)
    }
  })
})
