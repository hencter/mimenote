// @vitest-environment jsdom
/**
 * "最近" Vault 下拉（Base UI Select 版）。
 *
 * 手写摘要按钮 + `ul` 浮层的时代没有键盘走位、Esc 与焦点管理 —— 现在行为层是
 * Base UI（与设置页的下拉同一套），外观走 `ui-controls.css` 的 `mn-select*`
 * （token 映射只有一份）。这里钉：
 * 1. 选项只显示库名（完整路径走 Tooltip），当前库选中；固定「管理 Vault」在底部；
 * 2. 点别行真的切换 Vault；点「管理 Vault」关闭当前库回门闸；
 * 3. 空列表整块不渲染。
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RecentVaults } from '@/features/vault/RecentVaults'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import { useVaultStore, type RecentVaultEntry } from '@/state/vault-store'

const VAULTS: RecentVaultEntry[] = [
  { rootPath: 'C:\\VaultA', name: 'VaultA', openedAtMs: 2 },
  { rootPath: 'C:\\VaultB', name: 'VaultB', openedAtMs: 1 },
]

function setRecentVaults(entries: RecentVaultEntry[], current: string | null): void {
  useVaultStore.setState({
    status: 'idle',
    info:
      current === null
        ? null
        : {
            rootPath: current,
            name: current.split('\\').pop() ?? current,
            noteCount: 0,
            entryCount: 0,
            folderCount: 0,
            skipped: 0,
            scanMs: 0,
            truncated: false,
          },
    recentVaults: entries,
  })
}

beforeEach(() => {
  setIpcAdapter(createMockAdapter())
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
})

/** 真实鼠标点选项（见 `tests/components/ui-controls.test.tsx` 的同名 helper 注释）。 */
function clickOption(option: HTMLElement): void {
  fireEvent.pointerDown(option)
  fireEvent.click(option)
}

describe('最近 Vault 下拉', () => {
  it('空列表整块不渲染', () => {
    setRecentVaults([], null)
    const { container } = render(<RecentVaults />)
    expect(container.innerHTML).toBe('')
  })

  it('只有当前 Vault 时仍能展开 Select，并带固定管理项', async () => {
    setRecentVaults([VAULTS[0] as RecentVaultEntry], 'C:\\VaultA')
    render(<RecentVaults />)

    fireEvent.click(screen.getByRole('combobox', { name: /切换 Vault/ }))
    const options = await screen.findAllByRole('option')
    expect(options).toHaveLength(2)
    expect(options[0]?.getAttribute('aria-selected')).toBe('true')
    expect(options[0]?.textContent).toContain('VaultA')
    // 完整路径不进列表正文（悬停 Tooltip 才有）
    expect(options[0]?.textContent).not.toContain('C:\\VaultA')
    expect(options[1]?.textContent).toContain('管理 Vault')
  })

  it('触发器显示当前 Vault；弹层包含全部库、管理项，并标记当前选中项', async () => {
    setRecentVaults(VAULTS, 'C:\\VaultA')
    render(<RecentVaults />)

    expect(screen.getByRole('combobox', { name: /切换 Vault/ }).textContent).toContain('VaultA')

    fireEvent.click(screen.getByRole('combobox', { name: /切换 Vault/ }))
    const options = await screen.findAllByRole('option')
    expect(options).toHaveLength(3)
    expect(options[0]?.getAttribute('aria-selected')).toBe('true')
    expect(options[0]?.textContent).toContain('VaultA')
    expect(options[0]?.textContent).not.toContain('C:\\VaultA')
    expect(options[1]?.textContent).toContain('VaultB')
    expect(options[1]?.textContent).not.toContain('C:\\VaultB')
    expect(options[2]?.textContent).toContain('管理 Vault')
  })

  it('点别行切换 Vault', async () => {
    const opened: string[] = []
    const base = createMockAdapter()
    setIpcAdapter({
      kind: 'test',
      async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
        if (method === 'vault_open') opened.push(String(args?.['path'] ?? ''))
        return base.invoke<T>(method, args)
      },
    })
    setRecentVaults(VAULTS, 'C:\\VaultA')
    render(<RecentVaults />)

    fireEvent.click(screen.getByRole('combobox', { name: /切换 Vault/ }))
    const options = await screen.findAllByRole('option')
    clickOption(options[1] as HTMLElement)

    await act(async () => {
      await Promise.resolve()
    })
    // 调了 openVault 且是点的那一条（Mock 不认路径，所以不断 store 状态）
    expect(opened).toEqual(['C:\\VaultB'])
  })

  it('点「管理 Vault」关闭当前库（回门闸起始页）', async () => {
    const closed: string[] = []
    const base = createMockAdapter()
    setIpcAdapter({
      kind: 'test',
      async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
        if (method === 'vault_close') closed.push('ok')
        return base.invoke<T>(method, args)
      },
    })
    setRecentVaults(VAULTS, 'C:\\VaultA')
    render(<RecentVaults />)

    fireEvent.click(screen.getByRole('combobox', { name: /切换 Vault/ }))
    const options = await screen.findAllByRole('option')
    const manage = options.find((el) => el.textContent?.includes('管理 Vault'))
    expect(manage).toBeTruthy()
    clickOption(manage as HTMLElement)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(closed).toEqual(['ok'])
    expect(useVaultStore.getState().info).toBeNull()
  })

  it('当前库不在最近列表时，仍可选择所有最近的库与管理项', async () => {
    setRecentVaults(VAULTS, 'C:\\OtherVault')
    render(<RecentVaults />)

    fireEvent.click(screen.getByRole('combobox', { name: /切换 Vault/ }))
    expect(await screen.findAllByRole('option')).toHaveLength(3)
    expect(screen.queryByText('当前 Vault')).toBeNull()
    expect(screen.getByRole('option', { name: /管理 Vault/ })).toBeTruthy()
  })

  it('弹层不提供行内移除按钮', async () => {
    setRecentVaults(VAULTS, 'C:\\VaultA')
    render(<RecentVaults />)

    fireEvent.click(screen.getByRole('combobox', { name: /切换 Vault/ }))
    await screen.findAllByRole('option')
    expect(screen.queryByRole('button', { name: /从最近列表移除/ })).toBeNull()
  })
})
