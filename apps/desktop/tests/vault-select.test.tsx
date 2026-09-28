// @vitest-environment jsdom
/**
 * "最近" Vault 下拉（Base UI Select 版）。
 *
 * 手写摘要按钮 + `ul` 浮层的时代没有键盘走位、Esc 与焦点管理 —— 现在行为层是
 * Base UI（与设置页的下拉同一套），外观走 `ui-controls.css` 的 `mn-select*`
 * （token 映射只有一份）。这里钉三件事：
 * 1. 两行选项（名 + 路径）与当前行禁用；
 * 2. 点别行真的切换 Vault，点 × 只删除不切换；
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

/** 真实鼠标点选项（见 `tests/ui-controls.test.tsx` 的同名 helper 注释）。 */
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

  it('触发器显示当前 Vault 名；列表只显示名、路径悬停看；当前行禁用且打勾', async () => {
    setRecentVaults(VAULTS, 'C:\\VaultA')
    render(<RecentVaults />)

    expect(screen.getByRole('combobox', { name: /切换 Vault/ }).textContent).toContain('VaultA')

    fireEvent.click(screen.getByRole('combobox', { name: /切换 Vault/ }))
    const options = await screen.findAllByRole('option')
    expect(options).toHaveLength(2)
    // 只显示名（路径只进 title，悬停才看 —— 同名 Vault 靠悬停区分）
    expect(options[0]?.textContent).toContain('VaultA')
    expect(options[0]?.textContent).not.toContain('C:\\')
    expect(options[0]?.getAttribute('title')).toBe('C:\\VaultA')
    // 当前行禁用（重开同一个只会白白重扫一次）且挂着选中勾
    expect(options[0]?.getAttribute('aria-disabled')).toBe('true')
    expect(options[0]?.querySelector('.mn-select__indicator svg')).not.toBeNull()
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

  it('点 × 只删除不切换；删空后整块消失', async () => {
    setRecentVaults(VAULTS, 'C:\\VaultA')
    render(<RecentVaults />)

    fireEvent.click(screen.getByRole('combobox', { name: /切换 Vault/ }))
    await screen.findAllByRole('option')

    // 删掉非当前那一条：当前 Vault 不动，列表少一条
    fireEvent.click(screen.getByRole('button', { name: '从最近列表移除 VaultB' }))
    expect(useVaultStore.getState().info?.rootPath).toBe('C:\\VaultA')
    expect(useVaultStore.getState().recentVaults.map((item) => item.name)).toEqual(['VaultA'])

    // 删掉最后一条：整块消失（空区域比灰入口诚实）
    fireEvent.click(screen.getByRole('button', { name: '从最近列表移除 VaultA' }))
    expect(document.querySelector('.mn-recent-vaults')).toBeNull()
  })
})
