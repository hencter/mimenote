// @vitest-environment jsdom
/**
 * 停靠区（`features/dock/DockHost.tsx`）：渲染、搬运（拖拽 + 键盘）、模块菜单。
 *
 * 用户的要求是"每个视图模块都要能拖拽到编辑器里的任意区域占位"，所以这一组用例守的是
 * **位置真的变了**（DOM 里模块落到哪个区、`dockLayout` 里怎么记）与**两条操作路径都通**
 * （鼠标拖拽、键盘），而不只是"菜单里有一项叫移到右侧"。
 *
 * 夹具用 Mock Vault（打开 Vault → 文件树有内容），只渲染停靠宿主本身 ——
 * 完整外壳（标签栏在顶部、`.mn-center` 的存在）另有一条 `App` 级用例。
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { App } from '@/App'
import { DockHost } from '@/features/dock/DockHost'
import { DEFAULT_DOCK_LAYOUT } from '@/features/dock/dock-layout'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import { useTagsStore } from '@/state/tags-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

const VAULT_ROOT = 'C:\\MockVault'

/** 极简的 `DataTransfer` 替身：HTML5 拖拽在 jsdom 里没有实现，事件里带的就是这个对象。 */
function fakeDataTransfer(): {
  setData: (type: string, value: string) => void
  getData: (type: string) => string
  effectAllowed: string
  dropEffect: string
  readonly types: string[]
  readonly files: File[]
} {
  const store = new Map<string, string>()
  return {
    setData: (type, value) => store.set(type, value),
    getData: (type) => store.get(type) ?? '',
    effectAllowed: '',
    dropEffect: '',
    get types() {
      return [...store.keys()]
    },
    get files() {
      return []
    },
  }
}

/** 某个停靠区里的模块（按 DOM 顺序）。 */
function modulesIn(side: string): string[] {
  const dock = document.querySelector(`[data-dock="${side}"]`)
  if (dock === null) return []
  return Array.from(dock.querySelectorAll('[data-dock-module]')).map(
    (node) => node.getAttribute('data-dock-module') ?? '',
  )
}

function headerOf(id: string): HTMLElement {
  const header = document.querySelector<HTMLElement>(`[data-dock-module-header="${id}"]`)
  if (header === null) throw new Error(`没有 ${id} 的标题头`)
  return header
}

beforeEach(async () => {
  window.localStorage.clear()
  setIpcAdapter(createMockAdapter({ rootPath: VAULT_ROOT }))
  useUiStore.setState({
    dockLayout: DEFAULT_DOCK_LAYOUT,
    sidebarVisible: true,
    linksPanelVisible: false,
    outlinePanelVisible: false,
    bottomDockHeight: 220,
  })
  useTagsStore.setState({ open: false })
  await act(async () => {
    await useVaultStore.getState().openVault(VAULT_ROOT)
  })
})

afterEach(() => {
  cleanup()
})

describe('渲染', () => {
  it('缺省布局：文件树在左，右/底两个区没有可见模块 ⇒ 整区不渲染', () => {
    render(<DockHost side="left" />)
    expect(modulesIn('left')).toEqual(['tree'])

    cleanup()
    render(
      <>
        <DockHost side="right" />
        <DockHost side="bottom" />
      </>,
    )
    // 链接/标签/大纲都在右侧但**都收起着**：整区一个节点都不渲染（与引入停靠之前一致）
    expect(modulesIn('right')).toEqual([])
    expect(modulesIn('bottom')).toEqual([])
  })

  it('打开一块面板 ⇒ 它出现在自己被停靠的那一区', async () => {
    useUiStore.setState({ dockLayout: { left: ['tree'], right: ['tags'], bottom: ['links'] } })
    useTagsStore.setState({ open: true })
    useUiStore.setState({ linksPanelVisible: true })

    render(
      <>
        <DockHost side="right" />
        <DockHost side="bottom" />
      </>,
    )

    expect(modulesIn('right')).toEqual(['tags'])
    expect(modulesIn('bottom')).toEqual(['links'])
  })

  it('左停靠区保留 `mn-sidebar` 这个类（侧栏宽度与 Ctrl+B 的既有断言靠它）', () => {
    render(<DockHost side="left" />)
    expect(document.querySelector('[data-dock="left"]')?.className).toContain('mn-sidebar')
  })
})

describe('拖拽搬运', () => {
  it('把文件树从左侧拖到底部：位置真的变了，原区不再有它', async () => {
    render(
      <>
        <DockHost side="left" />
        <DockHost side="bottom" />
      </>,
    )
    const dataTransfer = fakeDataTransfer()

    // 拖动期间：空的底部区会先出现一条"能放"的轨道（用户要有地方可落）
    fireEvent.dragStart(headerOf('tree'), { dataTransfer })
    await waitFor(() => {
      expect(document.querySelector('[data-dock-rail="bottom"]')).not.toBeNull()
    })

    fireEvent.dragOver(document.querySelector('[data-dock="bottom"]') as HTMLElement, { dataTransfer })
    fireEvent.drop(document.querySelector('[data-dock="bottom"]') as HTMLElement, { dataTransfer })

    await waitFor(() => {
      expect(useUiStore.getState().dockLayout.bottom).toEqual(['tree'])
    })
    expect(useUiStore.getState().dockLayout.left).toEqual([])
    expect(modulesIn('bottom')).toEqual(['tree'])
    // 拖动结束：轨道收起，底部区变成真的有一块模块
    expect(document.querySelector('[data-dock-rail="bottom"]')).toBeNull()
  })

  it('拖到**同一侧**的末尾：顺序真的变了', async () => {
    /*
      ⚠️ 落点判据用的是**真实矩形**（jsdom 里 `getBoundingClientRect` 恒为 0，
      在实例上覆盖它并不生效），所以这里选一个"无论矩形是多少结论都一样"的落点：
      把指针放到远超所有模块的位置 ⇒ 插入下标必然是末尾。
      落点→下标的换算本身（含中线判定）由 `tests/dock-layout.test.ts` 用手算数字钉死。
    */
    useUiStore.setState({
      dockLayout: { left: ['tree', 'outline'], right: ['links'], bottom: [] },
      outlinePanelVisible: true,
    })
    render(<DockHost side="left" />)
    expect(modulesIn('left')).toEqual(['tree', 'outline'])

    const dataTransfer = fakeDataTransfer()
    const dock = document.querySelector('[data-dock="left"]') as HTMLElement
    fireEvent.dragStart(headerOf('tree'), { dataTransfer })
    fireEvent.dragOver(dock, { dataTransfer, clientY: 10_000 })
    fireEvent.drop(dock, { dataTransfer, clientY: 10_000 })

    await waitFor(() => {
      expect(useUiStore.getState().dockLayout.left).toEqual(['outline', 'tree'])
    })
    expect(modulesIn('left')).toEqual(['outline', 'tree'])
  })
})

describe('键盘搬运与模块菜单', () => {
  it('Alt+3 把文件树搬到最底部；Alt+1 再搬回来', async () => {
    render(
      <>
        <DockHost side="left" />
        <DockHost side="bottom" />
      </>,
    )
    const header = headerOf('tree')
    header.focus()

    fireEvent.keyDown(header, { key: '3', altKey: true })
    await waitFor(() => {
      expect(useUiStore.getState().dockLayout.bottom).toEqual(['tree'])
    })

    const moved = headerOf('tree')
    moved.focus()
    fireEvent.keyDown(moved, { key: '1', altKey: true })
    await waitFor(() => {
      expect(useUiStore.getState().dockLayout.left).toEqual(['tree'])
    })
  })

  it('回车打开模块菜单：能搬运、能隐藏，且已经在的那一侧被置灰', async () => {
    // 两个区都渲染：把模块搬到"没人渲染的那一区"会让它从 DOM 里消失，
    // 后续断言就变成"元素不存在"，而不是"搬运生效"（这条用例要的是后者）
    render(
      <>
        <DockHost side="left" />
        <DockHost side="bottom" />
      </>,
    )
    const header = headerOf('tree')
    header.focus()
    fireEvent.keyDown(header, { key: 'Enter' })

    const menu = await screen.findByRole('menu', { name: /文件 面板的位置菜单/ })
    expect(menu).toBeTruthy()
    const toLeft = screen.getByRole('menuitem', { name: '移到左侧' }) as HTMLButtonElement
    expect(toLeft.disabled).toBe(true) // 已经在左侧

    fireEvent.click(screen.getByRole('menuitem', { name: '移到底部' }))
    await waitFor(() => {
      expect(useUiStore.getState().dockLayout.bottom).toEqual(['tree'])
    })

    // 隐藏：走的仍然是 Ctrl+B 那条开关（停靠模型只记位置，不管可见性）
    const headerAgain = headerOf('tree')
    fireEvent.keyDown(headerAgain, { key: ' ' })
    fireEvent.click(await screen.findByRole('menuitem', { name: '隐藏这一块' }))
    expect(useUiStore.getState().sidebarVisible).toBe(false)
  })

  it('标题头上的 × 直接隐藏这一块', async () => {
    render(<DockHost side="left" />)
    fireEvent.click(screen.getByRole('button', { name: '隐藏文件面板' }))
    expect(useUiStore.getState().sidebarVisible).toBe(false)
    await waitFor(() => {
      expect(modulesIn('left')).toEqual([])
    })
  })
})

describe('完整外壳（标签栏在窗口顶部）', () => {
  it('标签栏挂在 `.mn-app` 上、横跨全宽；主体里有停靠区与中间列', async () => {
    render(<App />)
    await waitFor(() => {
      expect(document.querySelector('.mn-tree-row')).not.toBeNull()
    })

    // 标签栏：没有打开的笔记时不渲染；打开一篇之后它是 `.mn-app` 的直接子节点
    expect(document.querySelector('.mn-app > .mn-tabs')).toBeNull()
    await act(async () => {
      await useVaultStore.getState().select('README.md')
    })
    const { openNote } = await import('@/app/actions')
    await act(async () => {
      await openNote('README.md')
    })
    await waitFor(() => {
      expect(document.querySelector('.mn-app > .mn-tabs')).not.toBeNull()
    })
    // 它不再挂在主区域里（那条 `:has` 规则已经删掉）
    expect(document.querySelector('.mn-main > .mn-tabs')).toBeNull()

    expect(document.querySelector('.mn-center')).not.toBeNull()
    expect(document.querySelector('[data-dock="left"]')).not.toBeNull()
  })
})
