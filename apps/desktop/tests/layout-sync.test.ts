/**
 * 容器切割树的**迁移与对账**（ADR-0035 第 1 步「接线」的逻辑面）。
 *
 * 三条要点各有一组用例：读旧格式 → 转树（与 `tree-layout.ts` 的迁移口径一致）、
 * 与权威列表对账（**幂等**）、以及"隐藏 ≠ 移除"这条必须保住的旧语义。
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_MODULE_HOME,
  migrateLayout,
  reconcileLayout,
} from '@/features/layout/layout-sync'
import {
  attachItem,
  defaultLayout,
  fromDockLayout,
  itemsOf,
  leafOfItem,
  leaves,
  moveItem,
  noteItem,
  normalizeLayout,
  setActive,
  type TreeLayout,
  type ViewModuleId,
} from '@/features/layout/tree-layout'
import { DEFAULT_DOCK_LAYOUT } from '@/features/dock/dock-layout'

const ALL_MODULES: readonly ViewModuleId[] = ['tree', 'links', 'tags', 'outline']

/** 某个节点挂在哪个方向的 split 下面（断言"这一刀是横的还是竖的"）。 */
function parentOfAxis(layout: TreeLayout, childId: string): string | null {
  if (layout.kind === 'leaf') return null
  for (const child of [layout.a, layout.b]) {
    if (child.id === childId) return layout.axis
  }
  return parentOfAxis(layout.a, childId) ?? parentOfAxis(layout.b, childId)
}

describe('模块默认落点与停靠模型的默认布局一致（两处一旦漂移，迁移就会把面板搬错地方）', () => {
  it('tree 在左、links/tags/outline 在右（与 DEFAULT_DOCK_LAYOUT 逐字一致）', () => {
    for (const module of ALL_MODULES) {
      const home = DEFAULT_MODULE_HOME[module]
      const inLegacy = (['left', 'right', 'bottom'] as const).filter((side) =>
        DEFAULT_DOCK_LAYOUT[side].includes(module),
      )
      expect(inLegacy, `${module} 在旧默认布局里的落点`).toEqual([home])
    }
  })
})

describe('迁移：旧格式 → 树', () => {
  it('有 dockLayout 时按三区迁移，并补齐模块', () => {
    const tree = migrateLayout(undefined, {
      dock: { left: ['tree', 'outline'], right: ['links'], bottom: ['tags'] },
      notes: ['项目/设计.md', '随手记.md'],
    })

    // 两篇笔记都在主叶里（顺序保持）
    const main = leaves(tree).find((leaf) => leaf.id === 'main')
    expect(main?.items).toEqual([noteItem('项目/设计.md'), noteItem('随手记.md')])
    // 三个模块各占一个叶子；`outline` 旧格式里没有 ⇒ 按默认落点补出来（新切一格）
    for (const module of ALL_MODULES) {
      expect(leafOfItem(tree, module), `${module} 应当在树上`).not.toBeNull()
    }
    expect(leafOfItem(tree, 'tree')?.id).toBe('left-tree')
    expect(leafOfItem(tree, 'links')?.id).toBe('right-links')
    expect(leafOfItem(tree, 'outline')?.id).toBe('left-outline')
    // 同一区那条带的轴向：左/右区的多个模块是**上下叠**（column），底带挂在主区**下面**（column）
    expect(parentOfAxis(tree, 'left-tree')).toBe('column')
    expect(parentOfAxis(tree, 'bottom-tags')).toBe('column')
    // 整棵树最外面那一刀是竖的（左带 | 其余）
    expect(tree.kind === 'split' ? tree.axis : null).toBe('row')
  })

  it('没有任何旧格式时：默认叶 + 笔记 + 四个模块', () => {
    const tree = migrateLayout(undefined, { dock: null, notes: ['a.md'] })
    expect(leafOfItem(tree, noteItem('a.md'))).not.toBeNull()
    for (const module of ALL_MODULES) expect(leafOfItem(tree, module)).not.toBeNull()
  })

  it('已经是新格式（树）时：只规范化，**不**再做旧格式迁移', () => {
    // 一棵"把文件树拖到了下面"的树：迁移必须原样尊重它
    const custom: TreeLayout = {
      kind: 'split',
      id: 's',
      axis: 'column',
      ratio: 0.3,
      a: {
        kind: 'split',
        id: 's2',
        axis: 'row',
        ratio: 0.4,
        a: { kind: 'leaf', id: 'main', items: [noteItem('a.md')], active: noteItem('a.md') },
        b: { kind: 'leaf', id: 'right', items: ['links'], active: 'links' },
      },
      b: { kind: 'leaf', id: 'left-tree', items: ['tree'], active: 'tree' },
    }
    const migrated = migrateLayout(custom, { dock: null, notes: ['a.md'], modules: ['tree', 'links'] })
    expect(migrated).toEqual(normalizeLayout(custom))
  })

  it('与 `fromDockLayout` 同口径：同一份旧输入得到同一棵树', () => {
    const dock = { left: ['tree' as const], right: ['links' as const], bottom: [] as const }
    const viaSync = migrateLayout(undefined, { dock, notes: ['a.md'], modules: ['tree', 'links'] })
    const viaLayout = fromDockLayout(dock, ['a.md'])
    expect(viaSync).toEqual(normalizeLayout(viaLayout))
  })

  it('旧格式里出现未知模块名：丢掉而不是把界面卡死', () => {
    const tree = migrateLayout(undefined, {
      dock: {
        left: ['tree', '不认识' as ViewModuleId],
        right: [],
        bottom: [],
      },
      notes: [],
    })
    // 认不出的模块丢掉，四个已知模块一个不少
    expect([...itemsOf(tree)].sort()).toEqual([...ALL_MODULES].sort())
  })
})

describe('对账：树 ↔ 权威列表', () => {
  const base = (): TreeLayout => migrateLayout(undefined, { dock: null, notes: ['a.md'] })

  it('新打开的笔记挂到主叶末尾（已有标签的位置与顺序都不动）', () => {
    const tree = reconcileLayout(base(), { notes: ['a.md', 'b.md', 'c.md'] })
    expect(leaves(tree).find((leaf) => leaf.id === 'main')?.items).toEqual([
      noteItem('a.md'),
      noteItem('b.md'),
      noteItem('c.md'),
    ])
  })

  it('被关掉的笔记从树上摘掉；那一格空了就塌缩', () => {
    // 先把 b.md 拖到单独一格，再关掉它 ⇒ 那一格应当消失
    let tree = reconcileLayout(base(), { notes: ['a.md', 'b.md'] })
    tree = moveItem(tree, noteItem('b.md'), { leafId: 'main', edge: 'bottom' })
    expect(leaves(tree).length).toBeGreaterThan(2)

    const after = reconcileLayout(tree, { notes: ['a.md'] })
    expect(leafOfItem(after, noteItem('b.md'))).toBeNull()
    expect(itemsOf(after).filter((item) => item === noteItem('b.md'))).toHaveLength(0)
  })

  it('**幂等**：连着对账三次与一次相同（接线时每帧都可能调到它）', () => {
    const once = reconcileLayout(base(), { notes: ['a.md', 'b.md'] })
    expect(reconcileLayout(once, { notes: ['a.md', 'b.md'] })).toEqual(once)
    expect(reconcileLayout(reconcileLayout(once, { notes: ['a.md', 'b.md'] }), { notes: ['a.md', 'b.md'] })).toEqual(once)
  })

  it('用户拖过的位置不会被"打开一篇笔记"重置', () => {
    // 把文件树拖到主叶**下面**，然后打开一篇笔记：文件树必须还在下面
    let tree = reconcileLayout(base(), { notes: ['a.md'] })
    tree = moveItem(tree, 'tree', { leafId: 'main', edge: 'bottom' })
    const before = leafOfItem(tree, 'tree')?.id

    const after = reconcileLayout(tree, { notes: ['a.md', 'b.md'] })
    expect(leafOfItem(after, 'tree')?.id).toBe(before)
    expect(leafOfItem(after, noteItem('b.md'))).not.toBeNull()
  })

  it('**隐藏 ≠ 移除**：模块永远在树上（再打开要回原位）', () => {
    // `modules` 只传两个 ⇒ 另外两个"当前不存在"，但它们**已经**在树上就不该被摘掉
    const tree = reconcileLayout(base(), { notes: ['a.md'], modules: ['tree', 'links'] })
    for (const module of ALL_MODULES) {
      expect(leafOfItem(tree, module), `${module} 不该因为没传就消失`).not.toBeNull()
    }
  })

  it('模块缺失时按默认落点补（树是空的也能补出来）', () => {
    const empty = normalizeLayout({ kind: 'leaf', id: 'main', items: [noteItem('a.md')], active: noteItem('a.md') })
    const tree = reconcileLayout(empty, { notes: ['a.md'] })
    expect(leafOfItem(tree, 'tree')?.id).toBe('main~b')
    // links/tags/outline 补在右侧
    for (const module of ['links', 'tags', 'outline'] as const) {
      expect(leafOfItem(tree, module), `${module} 应当补出来`).not.toBeNull()
    }
  })

  it('对账后的树仍然满足六条不变式（交给 tree-layout 的规范化兜底）', () => {
    const tree = reconcileLayout(defaultLayout(), { notes: ['a.md', 'b.md'] })
    const seen = itemsOf(tree)
    expect(new Set(seen).size).toBe(seen.length)
    for (const leaf of leaves(tree)) expect(leaf.items.length).toBeGreaterThan(0)
    expect(leafOfItem(tree, noteItem('a.md'))?.active).not.toBeUndefined()
  })

  it('激活项落在被关掉的笔记上时，回退到同格里还活着的第一个', () => {
    let tree = reconcileLayout(base(), { notes: ['a.md', 'b.md'] })
    tree = setActive(tree, 'main', noteItem('b.md'))
    expect(leafOfItem(tree, noteItem('b.md'))?.active).toBe(noteItem('b.md'))

    const after = reconcileLayout(tree, { notes: ['a.md'] })
    expect(leafOfItem(after, noteItem('a.md'))?.active).toBe(noteItem('a.md'))
  })

  it('attachItem 的默认落点也用主叶（对账与手动挂载同一条路径）', () => {
    const tree = attachItem(base(), noteItem('z.md'))
    expect(leafOfItem(tree, noteItem('z.md'))?.id).toBe('main')
  })
})
