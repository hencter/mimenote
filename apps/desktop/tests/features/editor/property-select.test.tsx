// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { PropertyInput } from '@/features/editor/PropertyInput'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import { useVaultStore } from '@/state/vault-store'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

it('单选直接输入创建，不需要配置选项', () => {
  localStorage.setItem('mimenote.property.config.v1:["","status"]', JSON.stringify({ type: 'single', options: ['草稿', '发布'] }))
  const change = vi.fn()
  render(<PropertyInput name="status" value="草稿" change={change}  />)
  expect(screen.queryByText('配置选项')).toBeNull()
  const input = screen.getByRole('combobox', { name: 'status' })
  fireEvent.change(input, { target: { value: '待终审' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(change).toHaveBeenCalledWith('待终审')
})

/**
 * 回归：候选值**不能**靠"逐个笔记问宿主"来凑。
 *
 * 最初的实现遍历 Vault 里的每一篇笔记、逐个调 `note_tags` —— 4267 篇的真实 Vault
 * 就是 4267 次 IPC（宿主每次都要读盘解析 frontmatter）。这条用例把"打开单选属性的
 * 面板一次 IPC 都不打"钉住：候选只来自本篇当前值 + 这个属性用过的值（localStorage）。
 */
it('打开单选属性的面板不打任何 IPC（候选只来自记忆值）', async () => {
  localStorage.setItem('mimenote.property.config.v1:["C:\\\\MockVault","status"]', JSON.stringify({ type: 'single', options: [] }))
  localStorage.setItem('mimenote.property.values.v1:["C:\\\\MockVault","status"]', JSON.stringify(['草稿']))
  const adapter = createMockAdapter()
  const methods: string[] = []
  setIpcAdapter({
    ...adapter,
    invoke: <T,>(method: string, args?: Record<string, unknown>): Promise<T> => {
      methods.push(method)
      return adapter.invoke<T>(method, args)
    },
  })
  useVaultStore.setState({
    status: 'ready',
    info: {
      rootPath: 'C:\\MockVault',
      name: 'MockVault',
      entryCount: 2,
      noteCount: 2,
      folderCount: 0,
      truncated: false,
      skipped: 0,
      scanMs: 0,
    },
    entries: [
      { relPath: '甲.md', name: '甲.md', isDir: false, sizeBytes: 64, mtimeMs: 1, ext: 'md' },
      { relPath: '乙.md', name: '乙.md', isDir: false, sizeBytes: 64, mtimeMs: 2, ext: 'md' },
    ],
  })

  render(<PropertyInput name="status" value="草稿" change={() => {}}  />)

  const input = screen.getByRole('combobox', { name: 'status' })
  fireEvent.focus(input)
  // 等一拍：老的实现是在 effect 里起一批异步 IPC，只断言"同步没调"会漏掉它
  await waitFor(() => { expect(screen.getByRole('combobox', { name: 'status' })).toBeTruthy() })
  expect(methods.filter((method) => method === 'note_tags')).toHaveLength(0)
  expect(methods).toHaveLength(0)
})
