// @vitest-environment jsdom
/**
 * 布局树在 **store 层**的接线（ADR-0035）。
 *
 * 这一批做的是"树先成为活的落盘状态"，渲染与交互仍走旧的 `dockLayout`：
 *
 * 1. **迁移**：localStorage 里只有旧的 `dockLayout` ⇒ 恢复时转成树；已经有树就用树；
 * 2. **落盘**：树进 `mimenote.ui.v1`，而且**旧键不删**（回滚到旧版本时还能读到升级前那份）；
 * 3. **对账**：`tabs-store` 挂载后，打开/关闭笔记会反映到树上，而模块永远在树上；
 * 4. **不写盘**：对账没变化时 `setLayout` 直接返回（对账是每帧都可能调的路径）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_DOCK_LAYOUT } from '@/features/dock/dock-layout'
import { itemsOf, leafOfItem, noteItem } from '@/features/layout/tree-layout'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import { installTabsSync, useTabsStore } from '@/state/tabs-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

const STORAGE_KEY = 'mimenote.ui.v1'

/**
 * 重新加载 store 模块：`ui-store` 在**模块初始化**那一刻就读 localStorage，
 * 而 ES 模块是被缓存的 —— 想验"恢复"必须先 `vi.resetModules()` 再动态 import。
 *
 * 注意读回来的是一份**新的 store 实例**（与文件顶部那个静态 import 不是同一个对象），
 * 所以断言一律走返回值；localStorage 是共享的，两边看到的是同一份落盘数据。
 */
async function reloadUiStore(): Promise<typeof useUiStore> {
  vi.resetModules()
  const modules = await import('@/state/ui-store')
  return modules.useUiStore
}

function persisted(): Record<string, unknown> {
  return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>
}

beforeEach(() => {
  setIpcAdapter(createMockAdapter())
  window.localStorage.clear()
  useUiStore.setState({ layout: { kind: 'leaf', id: 'main', items: [], active: null } })
})

afterEach(() => {
  window.localStorage.clear()
})

describe('恢复：旧格式 → 树（迁移只发生一次，且在读盘那一刻）', () => {
  it('只有旧 dockLayout 时：恢复出来的树按三区迁移，四个模块都在', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ dockLayout: { left: ['tree', 'outline'], right: ['links'], bottom: ['tags'] } }),
    )
    const store = await reloadUiStore()
    const layout = store.getState().layout

    expect(leafOfItem(layout, 'tree')?.id).toBe('left-tree')
    expect(leafOfItem(layout, 'outline')?.id).toBe('left-outline')
    expect(leafOfItem(layout, 'links')?.id).toBe('right-links')
    expect(leafOfItem(layout, 'tags')?.id).toBe('bottom-tags')
  })

  it('全新安装：树 = **今天默认的停靠布局**迁移出来的样子（外观不变）', async () => {
    const store = await reloadUiStore()
    const layout = store.getState().layout
    // 一个空的主叶 + 四个模块各就各位（与 DEFAULT_DOCK_LAYOUT 等价）
    expect(leafOfItem(layout, 'tree')?.id).toBe('left-tree')
    expect(leafOfItem(layout, 'links')?.id).toBe('right-links')
    expect(leafOfItem(layout, 'tags')?.id).toBe('right-tags')
    expect(leafOfItem(layout, 'outline')?.id).toBe('right-outline')
    expect(itemsOf(layout)).toHaveLength(4)
  })

  it('已经有树时：**不**再按旧格式迁移（尊重用户拖过的布局）', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        dockLayout: DEFAULT_DOCK_LAYOUT,
        layout: {
          kind: 'split',
          id: 's',
          axis: 'column',
          ratio: 0.3,
          a: { kind: 'leaf', id: 'main', items: [noteItem('a.md')], active: noteItem('a.md') },
          b: { kind: 'leaf', id: 'left-tree', items: ['tree'], active: 'tree' },
        },
      }),
    )
    const store = await reloadUiStore()
    const layout = store.getState().layout
    // 自定义的结构被尊重：那一刀的比例还是 0.3（对账会往上补模块，但不会动已有的节点）
    let custom: { ratio: number } | null = null
    const find = (node: typeof layout): void => {
      if (node.kind !== 'split') return
      if (node.id === 's') custom = { ratio: node.ratio }
      find(node.a)
      find(node.b)
    }
    find(layout)
    expect(custom).toEqual({ ratio: 0.3 })
    expect(leafOfItem(layout, 'tree')?.id).toBe('left-tree')
    expect(leafOfItem(layout, noteItem('a.md'))?.id).toBe('main')
  })
})

describe('落盘：树进 ui 偏好，旧键保留一轮', () => {
  it('setLayout 写进 mimenote.ui.v1，且旧键 dockLayout 一字不动', () => {
    useUiStore.setState({ dockLayout: { left: ['tree'], right: [], bottom: [] } })
    useUiStore.getState().setLayout({
      kind: 'leaf',
      id: 'main',
      items: [noteItem('a.md')],
      active: noteItem('a.md'),
    })

    const saved = persisted()
    expect(saved['layout']).toMatchObject({ kind: 'leaf', id: 'main' })
    expect(saved['dockLayout']).toEqual({ left: ['tree'], right: [], bottom: [] })
  })

  it('结构没变时 setLayout **不写盘**（对账每帧都会调它）', () => {
    const layout = { kind: 'leaf' as const, id: 'main', items: [noteItem('a.md')], active: noteItem('a.md') }
    useUiStore.getState().setLayout(layout)
    const first = window.localStorage.getItem(STORAGE_KEY)

    // 同一结构、不同引用：不该再写一次
    window.localStorage.removeItem(STORAGE_KEY)
    useUiStore.getState().setLayout({ ...layout, items: [...layout.items] })
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(first).not.toBeNull()
  })
})

describe('对账：树随标签走（安装点接在 tabs-store 的同步里）', () => {
  it('打开一篇笔记 ⇒ 树上多一个标签；关掉 ⇒ 摘掉；模块始终在树上', async () => {
    await useVaultStore.getState().openVault('C:\\MockVault')
    const dispose = installTabsSync()
    try {
      useTabsStore.setState({ tabs: ['a.md', 'b.md'], active: 'a.md' })
      const added = useUiStore.getState().layout
      expect(itemsOf(added)).toContain(noteItem('a.md'))
      expect(itemsOf(added)).toContain(noteItem('b.md'))
      for (const module of ['tree', 'links', 'tags', 'outline']) {
        expect(leafOfItem(added, module as never), `${module} 应当始终在树上`).not.toBeNull()
      }

      useTabsStore.setState({ tabs: ['a.md'], active: 'a.md' })
      const removed = useUiStore.getState().layout
      expect(itemsOf(removed)).not.toContain(noteItem('b.md'))
      expect(itemsOf(removed)).toContain(noteItem('a.md'))
    } finally {
      dispose()
    }
  })

  it('未安装同步时不动作（副作用可逆）', () => {
    const before = useUiStore.getState().layout
    useTabsStore.setState({ tabs: ['x.md'], active: 'x.md' })
    expect(useUiStore.getState().layout).toBe(before)
  })
})
