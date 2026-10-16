// @vitest-environment jsdom
/**
 * 分栏（Miller columns）模式的界面契约。
 *
 * 列链与过滤判据在 `tests/domain/columns.test.ts`（纯函数）里钉死；这里只钉**界面**上的事：
 *
 * 1. 模式切换真的换渲染路径（`.mn-tree--columns` ↔ 单栏的 `.mn-tree`）；
 * 2. 点一个目录会**推进一列**（列链多出一列，且不改 `expanded`）；
 * 3. 分栏的键盘模型（`↑/↓` 列内、`→`/`Enter` 推进、`←` 回退）作用在
 *    `vault-store.selected` 与焦点目录上，且**不回归**既有键（F2 / Escape）；
 * 4. 每列只有自己那一层的行（深层笔记不会被拉平到根那一列）。
 *
 * 偏好 `settings-store.treeLayout` 由 Lead 落地，本文件只通过它自己的 setter 与
 * `setState` 注入假值即可。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'

import { FileTree } from '@/features/vault/FileTree'
import { TreeToolbar } from '@/features/vault/TreeToolbar'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter, MOCK_VAULT_PATH } from '@/ipc/mock-adapter'
import { useNoteStore } from '@/state/note-store'
import { useSettingsStore } from '@/state/settings-store'
import { useTagFilterStore } from '@/state/tag-filter-store'
import { useVaultStore } from '@/state/vault-store'

/** 注入画法偏好（字段由 Lead 落地；这里按同一形状写，视图层读的就是它）。 */
function setLayout(treeLayout: 'single' | 'columns' | 'stack'): void {
  act(() => {
    useSettingsStore.setState({ treeLayout })
  })
}

async function openVault(): Promise<void> {
  await act(async () => {
    await useVaultStore.getState().openVault(MOCK_VAULT_PATH)
  })
}

function treeElement(): HTMLElement {
  const node = document.querySelector<HTMLElement>('.mn-tree')
  if (node === null) throw new Error('找不到文件树容器')
  return node
}

function columnPaths(): string[] {
  return [...document.querySelectorAll('[data-column-path]')].map(
    (node) => node.getAttribute('data-column-path') ?? '',
  )
}

beforeEach(() => {
  window.localStorage.clear()
  setIpcAdapter(createMockAdapter())
  useVaultStore.setState({
    status: 'idle',
    info: null,
    entries: [],
    tree: [],
    expanded: new Set<string>(),
    selected: null,
    filter: '',
    error: null,
  })
  useNoteStore.setState({ doc: null })
  useTagFilterStore.getState().clear()
  setLayout('single')
})

afterEach(() => {
  cleanup()
})

describe('单栏 ⇄ 分栏的渲染分派', () => {
  it('默认单栏：只有一个滚动容器（没有 `.mn-tree--columns`）', async () => {
    await openVault()
    render(<FileTree />)
    expect(document.querySelector('.mn-tree--columns')).toBeNull()
    expect(document.querySelectorAll('.mn-tree__spacer').length).toBe(1)
  })

  it('切到分栏：列容器出现，第一列是 Vault 根的内容', async () => {
    await openVault()
    setLayout('columns')
    render(<FileTree />)

    expect(document.querySelector('.mn-tree--columns')).not.toBeNull()
    const root = document.querySelector('[data-column-path=""]')
    expect(root).not.toBeNull()
    expect(root!.querySelector('[data-rel-path="README.md"]')).not.toBeNull()
    // 第一列里**没有**深层的行（分栏只列直接子项）
    expect(root!.querySelector('[data-rel-path="项目/设计.md"]')).toBeNull()
  })

  it('切换偏好会换渲染路径，且不改任何选中/展开状态', async () => {
    await openVault()
    render(<FileTree />)
    act(() => {
      useVaultStore.getState().select('项目/设计.md')
    })
    expect(document.querySelector('.mn-tree--columns')).toBeNull()

    setLayout('columns')
    expect(document.querySelector('.mn-tree--columns')).not.toBeNull()
    expect(useVaultStore.getState().selected).toBe('项目/设计.md')

    setLayout('single')
    expect(document.querySelector('.mn-tree--columns')).toBeNull()
    expect(useVaultStore.getState().selected).toBe('项目/设计.md')
  })
})

describe('工具栏的切换控件', () => {
  it('按钮三态循环：单栏 → 分栏 → 堆叠 → 单栏（`aria-pressed` = 非单栏）', async () => {
    await openVault()
    render(<TreeToolbar />)
    const button = document.querySelector<HTMLElement>(
      'button[aria-label^="切换文件树视图"]',
    )
    expect(button).not.toBeNull()
    expect(button!.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(button!)
    expect(useSettingsStore.getState().treeLayout).toBe('columns')
    expect(button!.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(button!)
    expect(useSettingsStore.getState().treeLayout).toBe('stack')
    expect(button!.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(button!)
    expect(useSettingsStore.getState().treeLayout).toBe('single')
    expect(button!.getAttribute('aria-pressed')).toBe('false')
  })
})

describe('列链：跟随选中项 vs 用户钻进去', () => {
  it('打开一篇深层笔记（外部定位）：列链自动铺到它所在的目录', async () => {
    await openVault()
    setLayout('columns')
    render(<FileTree />)
    act(() => {
      useVaultStore.getState().select('项目/子项目/细节.md')
    })

    expect(columnPaths()).toEqual(['', '项目', '项目/子项目'])
    const selected = document.querySelector('.mn-tree-row--selected')
    expect(selected?.getAttribute('data-rel-path')).toBe('项目/子项目/细节.md')
  })

  it('点一个目录：末列变成它的内容，而 `selected` **不动**（那一行保持高亮）', async () => {
    await openVault()
    setLayout('columns')
    render(<FileTree />)
    act(() => {
      useVaultStore.getState().select('项目/设计.md')
    })
    expect(columnPaths()).toEqual(['', '项目'])

    const folder = document.querySelector<HTMLElement>('[data-rel-path="项目/子项目"]')
    expect(folder).not.toBeNull()
    fireEvent.click(folder!)

    expect(columnPaths()).toEqual(['', '项目', '项目/子项目'])
    // Finder 的样子：被点的目录在左边那一列里仍然高亮，右边已经是它的内容
    expect(useVaultStore.getState().selected).toBe('项目/设计.md')
  })

  it('列链上的目录带路径高亮（末列选中文件后祖先列仍画出整条路径）', async () => {
    await openVault()
    setLayout('columns')
    render(<FileTree />)
    act(() => {
      useVaultStore.getState().select('项目/子项目/细节.md')
    })
    expect(columnPaths()).toEqual(['', '项目', '项目/子项目'])

    // 通向下一列的目录：根列 → 项目，项目列 → 子项目；末列文件是 selected
    expect(document.querySelector('[data-rel-path="项目"]')?.hasAttribute('data-path-highlight')).toBe(
      true,
    )
    expect(
      document.querySelector('[data-rel-path="项目/子项目"]')?.hasAttribute('data-path-highlight'),
    ).toBe(true)
    expect(
      document.querySelector('[data-rel-path="项目/子项目/细节.md"]')?.className,
    ).toContain('mn-tree-row--selected')
    // 底部路径条按段渲染，当前段加重
    const pathBar = document.querySelector('[data-columns-path="项目/子项目"]')
    expect(pathBar).not.toBeNull()
    expect(pathBar!.querySelector('.mn-tree__columns-path__seg--current')?.textContent).toBe(
      '子项目',
    )
  })

  it('点目录不改 `expanded`（分栏不拿展开状态表达层级）', async () => {
    await openVault()
    setLayout('columns')
    render(<FileTree />)
    const before = useVaultStore.getState().expanded
    fireEvent.click(document.querySelector<HTMLElement>('[data-rel-path="项目"]')!)
    expect(useVaultStore.getState().expanded).toBe(before)
  })

  it('焦点目录按 Vault 根持久化：重新打开文件树回到那一层（按 Vault 分桶）', async () => {
    await openVault()
    setLayout('columns')
    const first = render(<FileTree />)
    fireEvent.click(document.querySelector<HTMLElement>('[data-rel-path="项目"]')!)
    expect(columnPaths()).toEqual(['', '项目'])
    first.unmount()

    // 重新挂载（模拟重启）：焦点从 localStorage 恢复
    render(<FileTree />)
    expect(columnPaths()).toEqual(['', '项目'])

    // 记的是**这个 Vault 的**焦点：换一个根读不到它（键是 Vault 根）
    const saved = JSON.parse(window.localStorage.getItem('mimenote.tree.focus.v1') ?? '{}') as Record<
      string,
      string
    >
    expect(saved[MOCK_VAULT_PATH]).toBe('项目')
  })
})

describe('分栏的键盘', () => {
  it('↑/↓ 在焦点列内移动（不跨列）', async () => {
    await openVault()
    setLayout('columns')
    render(<FileTree />)
    const tree = treeElement()

    act(() => {
      useVaultStore.getState().select('项目')
    })
    const rootPaths = [...document.querySelectorAll('[data-column-path=""] .mn-tree-row')].map(
      (node) => node.getAttribute('data-rel-path'),
    )
    const index = rootPaths.indexOf('项目')
    expect(index).toBeGreaterThanOrEqual(0)

    fireEvent.keyDown(tree, { key: 'ArrowDown' })
    expect(useVaultStore.getState().selected).toBe(rootPaths[index + 1])
    fireEvent.keyDown(tree, { key: 'ArrowUp' })
    expect(useVaultStore.getState().selected).toBe('项目')
  })

  it('→ 在目录上推进一列；← 回退一列（并选中父目录）', async () => {
    await openVault()
    setLayout('columns')
    render(<FileTree />)
    const tree = treeElement()

    act(() => {
      useVaultStore.getState().select('项目')
    })
    fireEvent.keyDown(tree, { key: 'ArrowRight' })
    expect(columnPaths()).toEqual(['', '项目'])
    // 推进一列**不改**选中项
    expect(useVaultStore.getState().selected).toBe('项目')

    fireEvent.keyDown(tree, { key: 'ArrowLeft' })
    expect(columnPaths()).toEqual([''])
    // 回退一列时选中父目录（它在左边那一列里，位置因此稳定地留在眼前）
    expect(useVaultStore.getState().selected).toBe('')
  })

  it('Enter 打开笔记：进标签页（与单栏同一条动作）', async () => {
    await openVault()
    setLayout('columns')
    render(<FileTree />)
    act(() => {
      useVaultStore.getState().select('项目/设计.md')
    })
    fireEvent.keyDown(treeElement(), { key: 'Enter' })
    await act(async () => {})
    expect(useNoteStore.getState().doc?.relPath).toBe('项目/设计.md')
  })

  it('Enter 在目录上 = 推进一列', async () => {
    await openVault()
    setLayout('columns')
    render(<FileTree />)
    act(() => {
      useVaultStore.getState().select('项目')
    })
    fireEvent.keyDown(treeElement(), { key: 'Enter' })
    expect(columnPaths()).toEqual(['', '项目'])
  })

  it('既有键不回归：F2 仍触发重命名对话框', async () => {
    await openVault()
    setLayout('columns')
    render(<FileTree />)
    act(() => {
      useVaultStore.getState().select('项目/设计.md')
    })
    fireEvent.keyDown(treeElement(), { key: 'F2' })
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
  })

  it('Escape 仍清标签过滤（分栏下不兼做"回退一列"）', async () => {
    await openVault()
    setLayout('columns')
    render(<FileTree />)
    act(() => {
      useVaultStore.getState().select('项目/设计.md')
    })
    const before = columnPaths()
    fireEvent.keyDown(treeElement(), { key: 'Escape' })
    // 没有标签过滤时什么都不做 —— 尤其**不**回退一列
    expect(columnPaths()).toEqual(before)
  })

  it('点焦点列的列头 = 回退一列（与 `←` 同一条路径）', async () => {
    await openVault()
    setLayout('columns')
    render(<FileTree />)
    act(() => {
      useVaultStore.getState().select('项目/设计.md')
    })
    fireEvent.click(document.querySelector<HTMLElement>('[data-rel-path="项目"]')!)
    expect(columnPaths()).toEqual(['', '项目'])

    const header = document.querySelector<HTMLButtonElement>('[data-column-header="项目"]')
    expect(header).not.toBeNull()
    fireEvent.click(header!)
    expect(columnPaths()).toEqual([''])
    expect(useVaultStore.getState().selected).toBe('')
    // 根那一列的列头禁用（根没有上一级）
    expect(
      document.querySelector<HTMLButtonElement>('[data-column-header=""]')?.disabled,
    ).toBe(true)
  })
})

describe('堆叠卡片画法', () => {
  it('stack 布局挂上 mn-tree--stack，列仍按路径渲染', async () => {
    await openVault()
    setLayout('stack')
    render(<FileTree />)

    expect(document.querySelector('.mn-tree--stack')).not.toBeNull()
    expect(document.querySelector('[data-tree-stack]')).not.toBeNull()
    expect(document.querySelector('[data-column-path=""]')).not.toBeNull()
  })

  it('stack 下不放列宽拖动手柄', async () => {
    await openVault()
    setLayout('stack')
    render(<FileTree />)

    expect(document.querySelector('[data-column-resize]')).toBeNull()
  })
})

describe('列宽可拖', () => {
  it('每列右缘有分隔手柄；方向键改宽并落盘', async () => {
    await openVault()
    setLayout('columns')
    render(<FileTree />)

    const handle = document.querySelector<HTMLElement>('[data-column-resize=""]')
    expect(handle).not.toBeNull()
    expect(handle!.getAttribute('role')).toBe('separator')

    const root = document.querySelector<HTMLElement>('[data-column-path=""]')
    expect(root).not.toBeNull()
    expect(root!.style.width).toBe('240px')

    act(() => {
      fireEvent.keyDown(handle!, { key: 'ArrowRight' })
    })
    expect(root!.style.width).toBe('256px')
    expect(handle!.getAttribute('aria-valuenow')).toBe('256')
  })

  it('双击手柄恢复默认 240', async () => {
    await openVault()
    setLayout('columns')
    render(<FileTree />)
    const handle = document.querySelector<HTMLElement>('[data-column-resize=""]')!
    act(() => {
      fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true })
    })
    const root = document.querySelector<HTMLElement>('[data-column-path=""]')!
    expect(root.style.width).toBe('288px')

    act(() => {
      fireEvent.doubleClick(handle)
    })
    expect(root.style.width).toBe('240px')
  })
})
