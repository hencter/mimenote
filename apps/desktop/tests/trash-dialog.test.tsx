// @vitest-environment jsdom
/**
 * 回收站对话框（`features/trash/TrashDialog.tsx` + `state/trash-store.ts`）。
 *
 * 这一层要钉住的是**用户能不能把删掉的东西拿回来**，以及拿不回来时界面有没有如实说明：
 *
 * 1. 列出删过的条目，并能恢复到原位置（内容逐字回来）；
 * 2. 原位置被占用时**绝不覆盖**，而是指出「恢复为…」这条路；
 * 3. 「恢复为…」把东西放到指定路径，并如实汇报"顺手建了哪些目录"；
 * 4. 台账里的**孤儿记录**（文件被手工清理过）标出来并禁用恢复 —— 不让用户点两次才知道；
 * 5. 读台账失败时不假装空列表，而是给原因 + 重试。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TrashDialog } from '@/features/trash/TrashDialog'
import { openTrash } from '@/app/actions'
import { ipc, setIpcAdapter } from '@/ipc/client'
import { createMockAdapter, type MockAdapter } from '@/ipc/mock-adapter'
import type { ConfirmRequest } from '@/state/confirm-store'
import { useToastStore } from '@/state/toast-store'
import { resetTrashStore, useTrashStore } from '@/state/trash-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

const NOTES = [
  { relPath: '项目/设计.md', text: '# 设计\n\n这一行要被删掉再拿回来。\n' },
  { relPath: '项目/其它.md', text: '# 其它\n' },
  { relPath: '日记/2025-01-01.md', text: '# 日记\n' },
]

let adapter: MockAdapter

/** 真实的"删一篇笔记"链路（与界面上按 Delete 走同一条命令）。 */
async function deleteNote(relPath: string): Promise<string> {
  const record = await ipc.noteDelete(relPath, true)
  useVaultStore.getState().registerDeletedEntry(record)
  return record.id
}

beforeEach(async () => {
  adapter = createMockAdapter({ notes: NOTES })
  setIpcAdapter(adapter)
  window.localStorage.clear()
  useToastStore.getState().clear()
  useUiStore.setState({ trashDialogOpen: false })
  resetTrashStore()
  useTrashStore.setState({ entries: [], status: 'idle', error: null, restoringId: null })
  await useVaultStore.getState().openVault('C:\\MockVault')
})

afterEach(() => {
  cleanup()
})

describe('列出与空态', () => {
  it('没有删过东西时说清"回收站是空的"', async () => {
    render(<TrashDialog />)
    await openTrash()
    expect(await screen.findByText(/回收站是空的/)).toBeTruthy()
    expect(screen.getByText('还没有删过东西')).toBeTruthy()
  })

  it('删过之后列出来（名字、原路径、相对时间），并提供恢复入口', async () => {
    await deleteNote('项目/设计.md')
    render(<TrashDialog />)
    await openTrash()

    const row = await screen.findByText('设计.md')
    expect(row).toBeTruthy()
    expect(screen.getByText('项目/设计.md')).toBeTruthy()
    expect(screen.getByText('刚刚')).toBeTruthy()
    expect(screen.getByText(/1 条可恢复/)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '恢复' }).length).toBeGreaterThan(0)
  })
})

describe('恢复', () => {
  it('恢复到原位置：内容逐字回来、条目从列表消失、给出成功提示', async () => {
    await deleteNote('项目/设计.md')
    render(<TrashDialog />)
    await openTrash()

    fireEvent.click(await screen.findByRole('button', { name: '恢复' }))

    await waitFor(() => expect(useToastStore.getState().toasts.some((item) => item.kind === 'success')).toBe(true))
    const toast = useToastStore.getState().toasts.find((item) => item.kind === 'success')
    expect(toast?.message).toContain('已恢复到原来的位置')

    // 磁盘（Mock 的文件表）里内容逐字回来
    const note = await ipc.noteRead('项目/设计.md')
    expect(note.text).toBe('# 设计\n\n这一行要被删掉再拿回来。\n')
    // 列表里不该再有它
    await waitFor(() => expect(screen.queryByText('设计.md')).toBeNull())
  })

  it('原位置被占用时绝不覆盖，并指出「恢复为…」', async () => {
    await deleteNote('项目/设计.md')
    // 用户已经把一篇新笔记写到了同一个名字上
    await ipc.noteCreate('项目', '设计')

    render(<TrashDialog />)
    await openTrash()
    fireEvent.click(await screen.findByRole('button', { name: '恢复' }))

    await waitFor(() => {
      const error = useToastStore.getState().toasts.find((item) => item.kind === 'error')
      expect(error?.detail ?? '').toContain('恢复为')
    })
    // 记录仍在列表里（换名字再来）
    expect(screen.getByText('设计.md')).toBeTruthy()
  })

  it('「恢复为…」把东西放到指定路径，并如实汇报顺手建了哪些目录', async () => {
    await deleteNote('项目/设计.md')
    render(<TrashDialog />)
    await openTrash()

    fireEvent.click(await screen.findByRole('button', { name: '恢复为…' }))
    const input = await screen.findByLabelText(/恢复到哪个路径/)
    fireEvent.change(input, { target: { value: '归档/2025/设计.md' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      const toast = useToastStore.getState().toasts.find((item) => item.kind === 'success')
      expect(toast?.detail ?? '').toContain('顺手建了 2 个目录')
    })
    const note = await ipc.noteRead('归档/2025/设计.md')
    expect(note.text).toContain('这一行要被删掉再拿回来。')
  })
})

describe('异常与边界', () => {
  it('孤儿记录（文件已不在回收站）标出来并禁用恢复，而不是让用户点了才吃到 NOT_FOUND', async () => {
    const base = adapter
    setIpcAdapter({
      kind: 'test',
      invoke: (method: string, args?: Record<string, unknown>): Promise<never> => {
        if (method === 'trash_list') {
          return Promise.resolve([
            {
              id: 'gone-1',
              originalRelPath: '项目/已消失.md',
              storedRelPath: '.mimenote/trash/gone-1__已消失.md',
              deletedAtMs: Date.now() - 5000,
              sizeBytes: 12,
              isDir: false,
              present: false,
            },
          ]) as Promise<never>
        }
        return base.invoke(method, args) as Promise<never>
      },
    })

    render(<TrashDialog />)
    await openTrash()

    // 文案出现两处（计数行 + 该条记录自己），因此按**行**取，而不是按文本唯一匹配
    await waitFor(() => {
      expect(document.querySelectorAll('[data-trash-orphan="true"]').length).toBe(1)
    })
    expect(document.querySelector('[data-trash-count]')?.textContent ?? '').toContain('1 条文件已不在回收站')
    expect(document.querySelector('[data-trash-count]')?.textContent ?? '').toContain('0 条可恢复')
    const restore = screen.getAllByRole('button', { name: '恢复' })[0]!
    expect((restore as HTMLButtonElement).disabled).toBe(true)
  })

  it('读台账失败时给原因与重试，而不是假装空列表', async () => {
    const base = adapter
    let failNext = true
    setIpcAdapter({
      kind: 'test',
      invoke: (method: string, args?: Record<string, unknown>): Promise<never> => {
        if (method === 'trash_list' && failNext) {
          failNext = false
          return Promise.reject(new Error('boom')) as Promise<never>
        }
        return base.invoke(method, args) as Promise<never>
      },
    })

    render(<TrashDialog />)
    await openTrash()

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('读不到回收站台账')

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(await screen.findByText(/回收站是空的/)).toBeTruthy()
  })

  it('对话关闭后不残留状态（下次打开会重新拉一次台账）', async () => {
    await deleteNote('项目/设计.md')
    render(<TrashDialog />)
    await openTrash()
    await screen.findByText('设计.md')

    fireEvent.click(screen.getByRole('button', { name: '关闭回收站' }))
    expect(useUiStore.getState().trashDialogOpen).toBe(false)
    expect(screen.queryByText('设计.md')).toBeNull()
  })
})

describe('删除不再是单向动作', () => {
  it('删除确认框里说明了"可在回收站里恢复"（用户敢按删除，往往是因为知道能找回来）', async () => {
    const confirmStore = await import('@/state/confirm-store')
    const original = confirmStore.useConfirmStore.getState().ask
    const ask = vi.fn(async (_request: ConfirmRequest) => false)
    confirmStore.useConfirmStore.setState({ ask })

    const { deleteSelected } = await import('@/app/actions')
    useVaultStore.setState({ selected: '项目/其它.md' })
    await deleteSelected('项目/其它.md')

    expect(ask).toHaveBeenCalledTimes(1)
    const request = ask.mock.calls[0]![0]
    expect(request.message).toContain('.mimenote/trash')
    expect(request.message).toContain('回收站')
    expect(request.confirmLabel).toBe('移入回收站')

    confirmStore.useConfirmStore.setState({ ask: original })
  })
})
