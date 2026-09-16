// @vitest-environment jsdom
/**
 * 容器切割树的渲染器（`features/layout/TreeHost.tsx` + `LeafTabs.tsx`）。
 *
 * 钉的是**可观测的结果**：哪个格子渲染了什么（模块面板 / 编辑器 / 只读预览）、
 * 隐藏面板那一格真的收缩、拖拽与键盘真的把标签搬了过去（`ui-store.layout` 变化）、
 * 分隔条真的改了比例。jsdom 没有布局引擎，矩形靠 mock `getBoundingClientRect` 给。
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { openNote, openNoteInNewTab } from '@/app/actions'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { TreeHost } from '@/features/layout/TreeHost'
import { useLayoutDrag } from '@/features/layout/layout-drag'
import {
  DEFAULT_MAIN_LEAF_ID,
  defaultLayout,
  findLeaf,
  leafOfItem,
  leaves,
  moveItem,
  noteItem,
  type TreeLayout,
} from '@/features/layout/tree-layout'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter, MOCK_VAULT_PATH, type MockAdapter } from '@/ipc/mock-adapter'
import { useConfirmStore } from '@/state/confirm-store'
import { useNoteStore } from '@/state/note-store'
import { useTabsStore } from '@/state/tabs-store'
import { useTagsStore } from '@/state/tags-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

let adapter: MockAdapter

function resetStores(): void {
  useNoteStore.getState().close()
  useTabsStore.setState({ tabs: [], active: null, restoredRoot: null })
  useConfirmStore.setState({ request: null, answer: null })
  useLayoutDrag.setState({ dragging: null })
  useUiStore.setState({
    layout: defaultLayout(),
    viewMode: 'edit',
    openedFile: null,
    sidebarVisible: true,
    linksPanelVisible: false,
    outlinePanelVisible: false,
  })
  useTagsStore.setState({ open: false })
  useVaultStore.setState({
    status: 'idle',
    info: null,
    entries: [],
    tree: [],
    expanded: new Set<string>(),
    selected: null,
    filter: '',
    error: null,
    lastRoot: null,
  })
}

function Harness() {
  return (
    <>
      <TreeHost />
      <ConfirmDialog />
    </>
  )
}

async function openVault(): Promise<void> {
  await act(async () => {
    await useVaultStore.getState().openVault(MOCK_VAULT_PATH)
  })
}

async function open(path: string): Promise<void> {
  await act(async () => {
    await openNote(path)
  })
}

/**
 * 在**新标签**里打开一篇笔记（`Ctrl/⌘ + 点击` 与中键走的就是这条路）。
 *
 * 默认的打开行为是"顶掉当前那条标签"（用户约定），所以"需要多于一条标签"的用例
 * 必须显式用它 —— 这也正是那些用例真正在测的东西（多标签机制本身并没有被删掉）。
 */
async function openNewTab(path: string): Promise<void> {
  await act(async () => {
    await openNoteInNewTab(path)
  })
}

function layout(): TreeLayout {
  return useUiStore.getState().layout
}

/** 某个叶子格子的 DOM（每次现取：重渲染后节点可能被换掉）。 */
function leafEl(leafId: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-leaf-id="${leafId}"]`)
  if (el === null) throw new Error(`没有这个格子：${leafId}（当前：${leafIds().join('、')}）`)
  return el
}

function leafIds(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-leaf-id]')).map(
    (node) => node.dataset.leafId ?? '',
  )
}

/** 模块标签节点。 */
function moduleTab(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-module-tab="${id}"]`)
  if (el === null) throw new Error(`没有模块标签：${id}`)
  return el
}

/** 笔记标签节点。 */
function noteTab(relPath: string): HTMLElement {
  for (const node of document.querySelectorAll<HTMLElement>('[data-tab-path]')) {
    if (node.dataset.tabPath === relPath) return node as HTMLElement
  }
  throw new Error(`没有笔记标签：${relPath}`)
}

/** 一个够用的假 DataTransfer（jsdom 没有真的；实现只写 setData / 读 effectAllowed）。 */
function fakeDataTransfer() {
  return { dropEffect: '', effectAllowed: '', setData: vi.fn(), getData: vi.fn(() => '') }
}

/*
 * jsdom 的 DragEvent 不带 clientX/clientY（fireEvent.dragOver 给的是 undefined）——
 * 落点几何需要真实坐标，所以改用 MouseEvent 构造（它认 clientX/clientY），
 * 再把 dataTransfer 作为属性挂上去（React 按事件 type 分发，dragover/drop 照常进处理器）。
 */
function dragEvent(type: 'dragover' | 'drop', x: number, y: number, dataTransfer: unknown): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  return event
}

/** 给 `.mn-leaf__content` 一个非零矩形（jsdom 全 0，落点几何需要真实尺寸）。 */
function mockContentRects(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList?.contains('mn-leaf__content')) {
      return { left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    }
    if (this.classList?.contains('mn-tree-split')) {
      return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    }
    return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  })
}

beforeEach(() => {
  adapter = createMockAdapter()
  setIpcAdapter(adapter)
  window.localStorage.clear()
  resetStores()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('渲染：格子与内容分派', () => {
  it('默认布局：文件树在左边那一格，主叶渲染主视图（编辑器空态），隐藏的模块整格收缩', async () => {
    render(<Harness />)
    await openVault()

    // 树上：文件树模块一格 + 空主叶；links/tags/outline 被隐藏 ⇒ 它们的格子不渲染
    await waitFor(() => {
      expect(document.querySelector('.mn-tree')).not.toBeNull()
    })
    const treeLeaf = leafOfItem(layout(), 'tree')
    expect(treeLeaf).not.toBeNull()
    expect(leafEl(treeLeaf!.id).querySelector('.mn-tree')).not.toBeNull()

    // 主叶：没有笔记时渲染主视图的空文档态（编辑器仍在，内容是空的）
    const main = leafEl(DEFAULT_MAIN_LEAF_ID)
    expect(main.querySelector('.mn-pane--editor')).not.toBeNull()

    // 隐藏的模块：格子收缩（DOM 里没有），但树里还在（再打开就回原位）
    expect(leafOfItem(layout(), 'links')).not.toBeNull()
    expect(document.querySelector('.mn-links')).toBeNull()
    expect(document.querySelector('.mn-tags')).toBeNull()
    expect(document.querySelector('.mn-outline')).toBeNull()
  })

  it('打开笔记：主叶出现标签条，编辑器显示那篇；图谱视图渲染在同一格里', async () => {
    render(<Harness />)
    await openVault()
    await open('README.md')

    const main = leafEl(DEFAULT_MAIN_LEAF_ID)
    expect(main.querySelector('[data-tab-path="README.md"]')).not.toBeNull()
    await waitFor(() => {
      expect(main.querySelector('.cm-editor')).not.toBeNull()
    })

    act(() => {
      useUiStore.getState().setViewMode('graph')
    })
    await waitFor(() => {
      expect(leafEl(DEFAULT_MAIN_LEAF_ID).querySelector('.mn-pane--graph')).not.toBeNull()
    })
  })

  it('非当前笔记的格子显示**只读预览**；点它的标签把它变成当前文档（编辑器搬过去）', async () => {
    render(<Harness />)
    await openVault()
    await open('README.md')
    await openNewTab('项目/设计.md') // 当前 = 设计

    // 把 README 拖到主叶下方独占一格：那一格的激活是 README，但当前文档是设计
    act(() => {
      useUiStore.getState().setLayout(
        moveItem(layout(), noteItem('README.md'), { leafId: DEFAULT_MAIN_LEAF_ID, edge: 'bottom' }),
      )
    })
    const readmeLeaf = leafOfItem(layout(), noteItem('README.md'))!
    expect(readmeLeaf.id).not.toBe(DEFAULT_MAIN_LEAF_ID)

    // 那一格渲染只读预览（StaticNotePreview：读盘 + 渲染），不是编辑器
    await waitFor(() => {
      const preview = leafEl(readmeLeaf.id).querySelector('.mn-leaf__preview .mn-preview__body')
      expect(preview).not.toBeNull()
    })
    await waitFor(() => {
      expect(leafEl(readmeLeaf.id).textContent).toContain('示例 Vault')
    })
    expect(leafEl(readmeLeaf.id).querySelector('.cm-editor')).toBeNull()
    // 主叶里仍是当前文档的编辑器
    expect(leafEl(DEFAULT_MAIN_LEAF_ID).querySelector('.cm-editor')).not.toBeNull()

    // 点 README 的标签 → 它成为当前文档，那一格变成编辑器
    fireEvent.click(noteTab('README.md'))
    await waitFor(() => {
      expect(useNoteStore.getState().doc?.relPath).toBe('README.md')
    })
    await waitFor(() => {
      expect(leafEl(readmeLeaf.id).querySelector('.cm-editor')).not.toBeNull()
    })
    // 而原来的主叶现在显示「设计」的只读预览（单文档模型：一格可写、其余可读）
    await waitFor(() => {
      expect(leafEl(DEFAULT_MAIN_LEAF_ID).querySelector('.mn-leaf__preview')).not.toBeNull()
    })
  })

  it('隐藏文件树（Ctrl+B 的那条开关）：格子收缩；再打开回到原位（树里什么都没变）', async () => {
    render(<Harness />)
    await openVault()
    const treeLeafId = leafOfItem(layout(), 'tree')!.id
    expect(leafIds()).toContain(treeLeafId)

    act(() => {
      useUiStore.getState().toggleSidebar()
    })
    await waitFor(() => {
      expect(leafIds()).not.toContain(treeLeafId)
    })
    expect(leafOfItem(layout(), 'tree')?.id).toBe(treeLeafId) // 树里没动

    act(() => {
      useUiStore.getState().toggleSidebar()
    })
    await waitFor(() => {
      expect(leafIds()).toContain(treeLeafId)
    })
  })
})

describe('拖拽标签', () => {
  it('拖到内容区边缘 = 切一刀（落点高亮 + 新叶出现）', async () => {
    mockContentRects()
    render(<Harness />)
    await openVault()
    await open('README.md')

    const main = leafEl(DEFAULT_MAIN_LEAF_ID)
    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(moduleTab('tree'), { dataTransfer })
    expect(useLayoutDrag.getState().dragging).toBe('tree')

    // 拖到主叶内容区的左边缘带（矩形 400×300，左带 = x < 100）
    fireEvent(main, dragEvent('dragover', 10, 150, dataTransfer))
    expect(main.querySelector('[data-drop-hint="left"]')).not.toBeNull()

    fireEvent(main, dragEvent('drop', 10, 150, dataTransfer))
    expect(useLayoutDrag.getState().dragging).toBeNull()
    // 文件树搬到了主叶左侧的新叶里
    const treeLeaf = leafOfItem(layout(), 'tree')!
    expect(treeLeaf.id).not.toBe(DEFAULT_MAIN_LEAF_ID)
    await waitFor(() => {
      expect(leafEl(treeLeaf.id).querySelector('.mn-tree')).not.toBeNull()
    })
    expect(document.querySelector('[data-drop-hint]')).toBeNull() // 高亮已清
  })

  it('拖到内容区中央 = 并入那一格的标签条', async () => {
    mockContentRects()
    render(<Harness />)
    await openVault()
    await open('README.md')

    const main = leafEl(DEFAULT_MAIN_LEAF_ID)
    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(moduleTab('tree'), { dataTransfer })
    fireEvent(main, dragEvent('dragover', 200, 150, dataTransfer))
    expect(main.querySelector('[data-drop-hint="merge"]')).not.toBeNull()

    fireEvent(main, dragEvent('drop', 200, 150, dataTransfer))
    // tree 成为主叶的一个标签，且被激活（并入即展示）
    const main2 = findLeaf(layout(), DEFAULT_MAIN_LEAF_ID)!
    expect(main2.items).toContain('tree')
    expect(main2.active).toBe('tree')
    await waitFor(() => {
      expect(leafEl(DEFAULT_MAIN_LEAF_ID).querySelector('.mn-tree')).not.toBeNull()
    })
  })

  it('拖到自己独占格子的边缘 = 无操作（不切出一格只装自己）', async () => {
    mockContentRects()
    render(<Harness />)
    await openVault()

    const treeLeafId = leafOfItem(layout(), 'tree')!.id
    const before = layout()
    const host = leafEl(treeLeafId)
    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(moduleTab('tree'), { dataTransfer })
    fireEvent(host, dragEvent('dragover', 10, 150, dataTransfer))
    fireEvent(host, dragEvent('drop', 10, 150, dataTransfer))

    expect(layout()).toBe(before) // 结构一个字没变
    expect(leafOfItem(layout(), 'tree')?.id).toBe(treeLeafId)
  })

  it('拖到另一格的标签条上 = 插到那一格的标签序列里（落点线出现）', async () => {
    mockContentRects()
    render(<Harness />)
    await openVault()
    await open('README.md')
    await openNewTab('项目/设计.md')

    const main = leafEl(DEFAULT_MAIN_LEAF_ID)
    const strip = main.querySelector('[data-leaf-tabs]') as HTMLElement
    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(moduleTab('tree'), { dataTransfer })
    // 条上的矩形是 0（jsdom），中线全 0 ⇒ 任何 x 都落在末尾；断言语义而不是下标
    fireEvent(strip, dragEvent('dragover', 300, 10, dataTransfer))
    expect(strip.querySelector('.mn-tabs__drop-line')).not.toBeNull()

    fireEvent(strip, dragEvent('drop', 300, 10, dataTransfer))
    const main2 = findLeaf(layout(), DEFAULT_MAIN_LEAF_ID)!
    expect(main2.items).toContain('tree')
    expect(main2.items.indexOf('tree')).toBe(2) // 两篇笔记之后
  })
})

describe('键盘与菜单', () => {
  it('Alt+3 把聚焦的模块搬到主叶下方；Alt+1 再搬回左侧', async () => {
    render(<Harness />)
    await openVault()

    fireEvent.keyDown(moduleTab('tree'), { key: '3', altKey: true })
    let treeLeaf = leafOfItem(layout(), 'tree')!
    expect(treeLeaf.id).not.toBe(DEFAULT_MAIN_LEAF_ID)
    await waitFor(() => {
      expect(leafEl(treeLeaf.id).querySelector('.mn-tree')).not.toBeNull()
    })

    fireEvent.keyDown(moduleTab('tree'), { key: '1', altKey: true })
    treeLeaf = leafOfItem(layout(), 'tree')!
    await waitFor(() => {
      expect(leafEl(treeLeaf.id).querySelector('.mn-tree')).not.toBeNull()
    })
    // 两次搬运之后树仍然合法（每个标签恰好一次）
    const items = leaves(layout()).flatMap((leaf) => leaf.items)
    expect(new Set(items).size).toBe(items.length)
  })

  it('Alt+←/→ 在标签条里换位置', async () => {
    render(<Harness />)
    await openVault()
    await open('README.md')
    await openNewTab('项目/设计.md')

    fireEvent.keyDown(noteTab('README.md'), { key: 'ArrowRight', altKey: true })
    expect(findLeaf(layout(), DEFAULT_MAIN_LEAF_ID)?.items).toEqual([
      noteItem('项目/设计.md'),
      noteItem('README.md'),
    ])
  })

  it('模块标签的右键菜单：搬到主区下方 / 隐藏这一块（置灰项不重复出现）', async () => {
    render(<Harness />)
    await openVault()

    fireEvent.contextMenu(moduleTab('tree'))
    const moveDown = await screen.findByText('搬到主区下方')
    fireEvent.click(moveDown)
    const treeLeaf = leafOfItem(layout(), 'tree')!
    expect(treeLeaf.id).not.toBe('left-tree') // 不在迁移时的原位了

    fireEvent.contextMenu(moduleTab('tree'))
    fireEvent.click(await screen.findByText('隐藏这一块'))
    await waitFor(() => {
      expect(useUiStore.getState().sidebarVisible).toBe(false)
    })
    expect(document.querySelector('.mn-tree')).toBeNull()
  })

  it('笔记标签的右键菜单与旧全局标签栏一致（关闭 / 关闭其他 / 关闭全部 / 在文件树中定位）', async () => {
    render(<Harness />)
    await openVault()
    await open('README.md')
    await openNewTab('项目/设计.md')

    fireEvent.contextMenu(noteTab('README.md'))
    expect(await screen.findByText('关闭其他')).toBeTruthy()
    expect(screen.getByText('关闭全部')).toBeTruthy()
    fireEvent.click(screen.getByText('在文件树中定位'))
    await waitFor(() => {
      expect(useVaultStore.getState().selected).toBe('README.md')
    })
  })
})

describe('分隔条', () => {
  it('双击分隔条均分两半；键盘方向键微调比例', async () => {
    mockContentRects() // split 容器 800×600（键盘微调的分母需要真实尺寸）
    render(<Harness />)
    await openVault()
    await open('README.md')

    // 制造一个 split：把文件树搬到主叶下方（隐藏的模块格在画面上收缩，
    // 所以可见的分隔条就是"主叶 vs 文件树"那一根）
    act(() => {
      useUiStore.getState().setLayout(
        moveItem(layout(), 'tree', { leafId: DEFAULT_MAIN_LEAF_ID, edge: 'bottom' }),
      )
    })
    const splitter = document.querySelector('.mn-splitter') as HTMLElement
    expect(splitter).not.toBeNull()
    const splitId = splitter.closest('[data-split-id]')?.getAttribute('data-split-id')
    expect(splitId).toBeTruthy()

    /** 模型里某个 split 的当前比例。 */
    const ratioOf = (id: string): number => {
      let found = -1
      const visit = (node: TreeLayout): void => {
        if (node.kind === 'leaf') return
        if (node.id === id) found = node.ratio
        visit(node.a)
        visit(node.b)
      }
      visit(layout())
      return found
    }
    expect(ratioOf(splitId!)).toBe(0.5)

    // 键盘微调：column split 的 ↓ = 前半增高（600px 的容器，一步 16px）
    fireEvent.keyDown(splitter, { key: 'ArrowDown' })
    expect(ratioOf(splitId!)).toBeCloseTo(0.5 + 16 / 600, 3)

    // 双击均分回 0.5
    fireEvent.doubleClick(splitter)
    expect(ratioOf(splitId!)).toBe(0.5)
  })
})

describe('装配职责（旧 TabBar 搬来的两件）', () => {
  it('打开笔记自动出现在树上（installTabsSync 由 TreeHost 安装），关闭后从树上摘掉', async () => {
    render(<Harness />)
    await openVault()
    await open('README.md')
    expect(leafOfItem(layout(), noteItem('README.md'))?.id).toBe(DEFAULT_MAIN_LEAF_ID)

    await act(async () => {
      await useTabsStore.getState().closeTab('README.md')
    })
    expect(leafOfItem(layout(), noteItem('README.md'))).toBeNull()
  })
})
