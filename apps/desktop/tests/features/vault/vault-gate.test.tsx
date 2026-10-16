// @vitest-environment jsdom
/**
 * Vault 门闸：主题色品牌 + 最近库管理（打开 / 从列表移除）。
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { VaultGate } from '@/features/vault/VaultGate'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import { useVaultStore, type RecentVaultEntry } from '@/state/vault-store'

const VAULTS: RecentVaultEntry[] = [
  { rootPath: 'C:\\VaultA', name: 'VaultA', openedAtMs: 2 },
  { rootPath: 'C:\\VaultB', name: 'VaultB', openedAtMs: 1 },
]

beforeEach(() => {
  setIpcAdapter(createMockAdapter())
  window.localStorage.clear()
  useVaultStore.setState({
    status: 'idle',
    info: null,
    recentVaults: VAULTS,
    error: null,
    lastRoot: null,
  })
})

afterEach(() => {
  cleanup()
})

describe('Vault 门闸', () => {
  it('品牌 mark 是内联 svg，颜色类挂在 mn-gate__logo', () => {
    render(<VaultGate />)
    const logo = screen.getByRole('img', { name: 'Mimenote Logo' })
    expect(logo.tagName).toBe('svg')
    expect(logo.classList.contains('mn-gate__logo')).toBe(true)
  })

  it('列出最近库；点行打开；点移除只删列表项', async () => {
    const opened: string[] = []
    const base = createMockAdapter()
    setIpcAdapter({
      kind: 'test',
      async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
        if (method === 'vault_open') opened.push(String(args?.['path'] ?? ''))
        return base.invoke<T>(method, args)
      },
    })

    render(<VaultGate />)
    expect(screen.getByRole('heading', { name: '管理 Vault' })).toBeTruthy()
    expect(screen.getByText('VaultA')).toBeTruthy()
    expect(screen.getByText('VaultB')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /从最近列表移除 VaultB/ }))
    expect(useVaultStore.getState().recentVaults.map((item) => item.name)).toEqual(['VaultA'])
    expect(opened).toEqual([])

    fireEvent.click(screen.getByTitle('C:\\VaultA'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(opened).toEqual(['C:\\VaultA'])
  })

  it('空列表时给出引导文案', () => {
    useVaultStore.setState({ recentVaults: [] })
    render(<VaultGate />)
    expect(screen.getByText(/还没有最近打开的库/)).toBeTruthy()
  })
})
