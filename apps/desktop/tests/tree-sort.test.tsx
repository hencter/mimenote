// @vitest-environment jsdom
/**
 * 文件树排序偏好：持久化 / 恢复 / 变化时数据层重排。
 *
 * 判据本身（各 by/direction/foldersFirst 的组合）在 `tests/tree.test.ts` 钉死；
 * 这里只测**偏好链路**：ui-store 存取、模块重载后的读回、以及"改偏好 → 树重排"
 * 这条由 vault-store 的模块级订阅驱动的联动。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { DEFAULT_TREE_SORT, buildTree, makeEntryComparator } from '@/domain/tree'
import { TreeToolbar } from '@/features/vault/TreeToolbar'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

const UI_KEY = 'mimenote.ui.v1'

function resetStores(): void {
  useUiStore.setState({ treeSort: DEFAULT_TREE_SORT })
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
}

beforeEach(() => {
  window.localStorage.clear()
  setIpcAdapter(createMockAdapter())
  resetStores()
})

afterEach(() => {
  cleanup()
})

describe('排序偏好的持久化', () => {
  it('setTreeSort 部分合并当前值并落到 localStorage', () => {
    useUiStore.getState().setTreeSort({ by: 'mtime', direction: 'desc' })

    const expected = { by: 'mtime', direction: 'desc', foldersFirst: true }
    expect(useUiStore.getState().treeSort).toEqual(expected)
    const saved = JSON.parse(window.localStorage.getItem(UI_KEY) ?? '{}') as {
      treeSort?: unknown
    }
    expect(saved.treeSort).toEqual(expected)
  })

  it('重新载入模块后读回合法配置', async () => {
    window.localStorage.setItem(
      UI_KEY,
      JSON.stringify({ treeSort: { by: 'size', direction: 'desc', foldersFirst: false } }),
    )
    vi.resetModules()
    const fresh = await import('@/state/ui-store')
    expect(fresh.useUiStore.getState().treeSort).toEqual({
      by: 'size',
      direction: 'desc',
      foldersFirst: false,
    })
  })

  it('坏数据（缺字段 / 非法枚举值）整份退回默认', async () => {
    window.localStorage.setItem(UI_KEY, JSON.stringify({ treeSort: { by: 'date' } }))
    vi.resetModules()
    const garbage = await import('@/state/ui-store')
    expect(garbage.useUiStore.getState().treeSort).toEqual(DEFAULT_TREE_SORT)

    window.localStorage.setItem(
      UI_KEY,
      JSON.stringify({ treeSort: { by: 'name', direction: 'up', foldersFirst: true } }),
    )
    vi.resetModules()
    const badDirection = await import('@/state/ui-store')
    expect(badDirection.useUiStore.getState().treeSort).toEqual(DEFAULT_TREE_SORT)
  })
})

describe('排序与数据层联动', () => {
  it('打开 Vault 建树时就用当前偏好（不是默认排序）', async () => {
    useUiStore.getState().setTreeSort({ by: 'name', direction: 'desc' })
    await useVaultStore.getState().openVault('C:\\MockVault')

    const state = useVaultStore.getState()
    const roots = state.tree.map((node) => node.entry.relPath)
    // 与"用这份偏好直接建树"完全一致（基准不手写顺序：CJK 与拉丁字母的相对序由 ICU 决定，
    // 钉死逐字数组会让用例依赖本机 ICU 版本，见 tests/tree.test.ts 的文件头说明）
    const expected = buildTree(
      state.entries,
      makeEntryComparator({ by: 'name', direction: 'desc', foldersFirst: true }),
    ).map((node) => node.entry.relPath)
    expect(roots).toEqual(expected)
    // 且确实不是默认序（否则"用了偏好"这条根本没被验证到）
    expect(roots).not.toEqual(buildTree(state.entries).map((node) => node.entry.relPath))
  })

  it('改排序偏好 → 树被重建（新引用、新顺序），展开状态不动', async () => {
    await useVaultStore.getState().openVault('C:\\MockVault')
    const before = useVaultStore.getState().tree
    const expandedBefore = useVaultStore.getState().expanded

    useUiStore.getState().setTreeSort({ by: 'name', direction: 'desc' })

    const state = useVaultStore.getState()
    const after = state.tree
    // 必须换引用：就地排序会让 React 订阅者察觉不到变化（这也是 resortTree 重建而不是 sortTree 的原因）
    expect(after).not.toBe(before)
    expect(after.map((node) => node.entry.relPath)).toEqual(
      buildTree(
        state.entries,
        makeEntryComparator({ by: 'name', direction: 'desc', foldersFirst: true }),
      ).map((node) => node.entry.relPath),
    )
    expect(state.expanded).toBe(expandedBefore)
  })

  it('「目录在前」关掉后目录与文件混排', async () => {
    await useVaultStore.getState().openVault('C:\\MockVault')
    useUiStore.getState().setTreeSort({ by: 'name', direction: 'asc', foldersFirst: false })

    const roots = useVaultStore.getState().tree.map((node) => node.entry)
    const firstFileIndex = roots.findIndex((entry) => !entry.isDir)
    const lastDirIndex = roots.map((entry) => entry.isDir).lastIndexOf(true)
    // 混排的标志：不再是"所有目录排在所有文件之前"
    expect(lastDirIndex).toBeGreaterThan(firstFileIndex)
  })

  it('重复设置同一个值不触发重排（树引用不变）', async () => {
    await useVaultStore.getState().openVault('C:\\MockVault')
    const before = useVaultStore.getState().tree

    useUiStore.getState().setTreeSort({ by: 'name' })
    useUiStore.getState().setTreeSort({ by: 'name', direction: 'asc', foldersFirst: true })

    expect(useVaultStore.getState().tree).toBe(before)
  })
})

describe('工具栏排序菜单', () => {
  async function renderToolbar(): Promise<void> {
    await act(async () => {
      await useVaultStore.getState().openVault('C:\\MockVault')
    })
    render(<TreeToolbar />)
  }

  it('点击排序按钮弹出菜单；Esc 关闭；选「修改时间」后偏好与树一起变', async () => {
    await renderToolbar()
    const before = useVaultStore.getState().tree

    fireEvent.click(screen.getByRole('button', { name: '文件树排序' }))
    const menu = screen.getByRole('menu', { name: '文件树排序' })
    // 当前值被标出来（默认：名称升序 + 目录在前）
    expect(screen.getByRole('menuitemradio', { name: '名称' }).getAttribute('aria-checked')).toBe(
      'true',
    )
    expect(screen.getByLabelText<HTMLInputElement>('目录在前').checked).toBe(true)

    // 选中后不自动关菜单（排序常要连调几项）
    fireEvent.click(screen.getByRole('menuitemradio', { name: '修改时间' }))
    expect(useUiStore.getState().treeSort.by).toBe('mtime')
    expect(screen.getByRole('menu', { name: '文件树排序' })).toBeTruthy()
    // 数据层跟着重排了（订阅链路）
    expect(useVaultStore.getState().tree).not.toBe(before)
    expect(menu.isConnected).toBe(true)

    // Esc 关闭（键盘用户不需要鼠标就能退出）
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('点菜单外部关闭', async () => {
    await renderToolbar()
    fireEvent.click(screen.getByRole('button', { name: '文件树排序' }))
    expect(screen.queryByRole('menu')).not.toBeNull()

    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('「目录在前」开关直接改偏好', async () => {
    await renderToolbar()
    fireEvent.click(screen.getByRole('button', { name: '文件树排序' }))

    fireEvent.click(screen.getByLabelText('目录在前'))
    expect(useUiStore.getState().treeSort.foldersFirst).toBe(false)
  })
})
