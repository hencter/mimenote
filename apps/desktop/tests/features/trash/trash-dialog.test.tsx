// @vitest-environment jsdom
/**
 * 回收站对话框（`features/trash/TrashDialog.tsx` + `state/trash-store.ts`）。
 *
 * 这一层要钉住的是**用户能不能把删掉的东西拿回来**、**能不能把不要的东西真的清掉**，
 * 以及两件事都做不到时界面有没有如实说明：
 *
 * 1. 列出删过的条目，并能恢复到原位置（内容逐字回来）；
 * 2. 原位置被占用时**绝不覆盖**，而是指出「恢复为…」这条路；
 * 3. 「恢复为…」把东西放到指定路径，并如实汇报"顺手建了哪些目录"；
 * 4. 台账里的**孤儿记录**（文件被手工清理过）标出来并禁用恢复 —— 不让用户点两次才知道；
 * 5. 读台账失败时不假装空列表，而是给原因 + 重试；
 * 6. **永久删除**：行内按钮 → 二次确认（说清"不能恢复"）→ 确认后调 `trash_delete`
 *    （`confirm: true`）→ 按逐条结果汇报、列表里不再有它；
 * 7. **清空回收站**：顶部按钮 → 二次确认 → `trash_empty` → "删了 N 项、释放 X"；
 * 8. 两条路的**取消都是零副作用**（不调任何命令、列表与磁盘都不动）；
 * 9. 孤儿记录的「永久删除」只清台账记录（进 `missing`、不释放空间），文案与按钮名都要说清。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import { TrashDialog } from '@/features/trash/TrashDialog'
import { openTrash } from '@/app/actions'
import { ipc, setIpcAdapter } from '@/ipc/client'
import { createMockAdapter, type MockAdapter } from '@/ipc/mock-adapter'
import { useConfirmStore } from '@/state/confirm-store'
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

/**
 * 确认框的替身：记下被问到的请求，按 `answer` 回答。
 *
 * 用替身而不是渲染真的 `ConfirmDialog`：这里要断言的是"**问对了没有**"
 * （文案说清不可恢复、`danger: true`、走的是同一个 `ask`），
 * 对话框本身的交互由它自己的用例覆盖。
 */
function stubConfirm(answer: boolean): Mock<(request: ConfirmRequest) => Promise<boolean>> {
  const spy = vi.fn(async (_request: ConfirmRequest) => answer)
  useConfirmStore.setState({ ask: spy, request: null, answer: null })
  return spy
}

let ask: Mock<(request: ConfirmRequest) => Promise<boolean>>
let originalAsk: (request: ConfirmRequest) => Promise<boolean>

beforeEach(() => {
  originalAsk = useConfirmStore.getState().ask
  // 缺省"用户点了取消"：任何一条用例若没显式摆好确认框，都不该悄悄删掉东西
  ask = stubConfirm(false)

  adapter = createMockAdapter({ notes: NOTES })
  setIpcAdapter(adapter)
  window.localStorage.clear()
  useToastStore.getState().clear()
  useUiStore.setState({ trashDialogOpen: false })
  resetTrashStore()
  useTrashStore.setState({
    entries: [],
    status: 'idle',
    error: null,
    restoringId: null,
    purgingId: null,
  })
  return useVaultStore.getState().openVault('C:\\MockVault')
})

afterEach(() => {
  // 把真的 `ask` 放回去：同一个文件里"删除确认框"那条用例要靠它，别的文件也一样
  useConfirmStore.setState({ ask: originalAsk, request: null, answer: null })
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

    // 名字与路径都不带 .md（ADR-0030）；悬浮提示里才是真实路径
    const row = await screen.findByText('设计')
    expect(row).toBeTruthy()
    expect(screen.getByText('项目/设计')).toBeTruthy()
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
    await waitFor(() => expect(screen.queryByText('设计')).toBeNull())
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
    expect(screen.getByText('设计')).toBeTruthy()
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
    await screen.findByText('设计')

    fireEvent.click(screen.getByRole('button', { name: '关闭回收站' }))
    expect(useUiStore.getState().trashDialogOpen).toBe(false)
    expect(screen.queryByText('设计')).toBeNull()
  })
})

describe('永久删除与清空', () => {
  it('行内「永久删除」：确认框说清不能恢复 → 确认 → 调 trash_delete(confirm) → 汇报并移除', async () => {
    await deleteNote('项目/设计.md')
    ask = stubConfirm(true)
    render(<TrashDialog />)
    await openTrash()

    fireEvent.click(await screen.findByRole('button', { name: '永久删除' }))

    await waitFor(() => {
      const toast = useToastStore.getState().toasts.find((item) => item.kind === 'success')
      expect(toast?.message ?? '').toContain('永久删除了 1 项')
    })
    const toast = useToastStore.getState().toasts.find((item) => item.kind === 'success')
    expect(toast?.message ?? '').toContain('释放')
    // 文案的核心：这是不可恢复的（与"删除到回收站"那种说法必须区分开）
    expect(toast?.message ?? '').not.toContain('可以恢复')
    // 真的调了宿主命令，而且带上了契约要求的 `confirm`
    expect(adapter.trashCalls).toEqual([{ method: 'trash_delete', id: expect.any(String), confirm: true }])

    // 列表里不再有它
    await waitFor(() => expect(screen.queryByText('设计')).toBeNull())
    expect(await ipc.trashList()).toHaveLength(0)
  })

  it('确认框出现，文案说明不可恢复（与"删除到回收站"的措辞区分开）', async () => {
    await deleteNote('项目/设计.md')
    render(<TrashDialog />)
    await openTrash()

    fireEvent.click(await screen.findByRole('button', { name: '永久删除' }))

    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1))
    const request = ask.mock.calls[0]![0]
    expect(request.title).toContain('永久删除')
    expect(request.message).toContain('不能恢复')
    expect(request.confirmLabel).toBe('永久删除')
    expect(request.danger).toBe(true)
  })

  it('拒绝确认：什么都没发生（不调任何命令、列表与磁盘都不动）', async () => {
    const id = await deleteNote('项目/设计.md')
    // `beforeEach` 已经把确认框设成"取消"
    render(<TrashDialog />)
    await openTrash()

    fireEvent.click(await screen.findByRole('button', { name: '永久删除' }))

    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1))
    expect(adapter.trashCalls).toHaveLength(0)
    expect(useToastStore.getState().toasts).toHaveLength(0)
    // 一样都没少：列表里还有它、台账里还有它、回收站里那份也还在（`present`）
    expect(screen.getByText('设计')).toBeTruthy()
    const remaining = await ipc.trashList()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.id).toBe(id)
    expect(remaining[0]!.present).toBe(true)
  })

  it('顶部「清空回收站」：确认 → trash_empty → 逐项汇报，列表清空', async () => {
    await deleteNote('项目/设计.md')
    await deleteNote('项目/其它.md')
    ask = stubConfirm(true)
    render(<TrashDialog />)
    await openTrash()

    fireEvent.click(await screen.findByRole('button', { name: '清空回收站' }))

    await waitFor(() =>
      expect(adapter.trashCalls).toEqual([{ method: 'trash_empty', confirm: true }]),
    )
    await waitFor(() => {
      const toast = useToastStore.getState().toasts.find((item) => item.kind === 'success')
      expect(toast?.message ?? '').toContain('永久删除了 2 项')
    })
    await waitFor(() => expect(screen.queryByText('设计')).toBeNull())
    expect(screen.queryByText('其它')).toBeNull()
    expect(await ipc.trashList()).toHaveLength(0)

    const request = ask.mock.calls[0]![0]
    expect(request.message).toContain('不能恢复')
    expect(request.danger).toBe(true)
  })

  it('清空被取消时：一条都不删（逐条都没发生）', async () => {
    await deleteNote('项目/设计.md')
    await deleteNote('项目/其它.md')
    render(<TrashDialog />)
    await openTrash()

    fireEvent.click(await screen.findByRole('button', { name: '清空回收站' }))

    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1))
    expect(adapter.trashCalls).toHaveLength(0)
    expect(await ipc.trashList()).toHaveLength(2)
    expect(screen.getByText('设计')).toBeTruthy()
    expect(screen.getByText('其它')).toBeTruthy()
  })

  it('孤儿记录的「永久删除」只清台账记录：进 missing、不释放空间、文案说清', async () => {
    const id = await deleteNote('项目/设计.md')
    // 用户在文件管理器里清掉了回收站里的那个文件（台账记录留着）
    adapter.simulateTrashFileGone(id)
    ask = stubConfirm(true)
    render(<TrashDialog />)
    await openTrash()

    const button = await screen.findByRole('button', { name: '清掉记录' })
    fireEvent.click(button)

    await waitFor(() => {
      const toast = [...useToastStore.getState().toasts].reverse().find((item) => item.kind === 'success')
      expect(toast?.message ?? '').toContain('永久删除了 0 项，释放 0 B')
    })
    const toast = useToastStore.getState().toasts.find((item) => item.kind === 'success')
    expect(toast?.message ?? '').toContain('另清掉 1 条「文件已不在回收站」的记录')
    expect(adapter.trashCalls).toEqual([{ method: 'trash_delete', id, confirm: true }])

    await waitFor(() => expect(screen.queryByText('设计')).toBeNull())
    expect(await ipc.trashList()).toHaveLength(0)
  })

  it('孤儿记录的确认文案说的是"清台账记录"，不是"删文件"', async () => {
    const id = await deleteNote('项目/设计.md')
    adapter.simulateTrashFileGone(id)
    render(<TrashDialog />)
    await openTrash()

    fireEvent.click(await screen.findByRole('button', { name: '清掉记录' }))

    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1))
    const request = ask.mock.calls[0]![0]
    expect(request.title).toBe('清掉这条记录？')
    expect(request.message).toContain('不会删任何文件')
    expect(request.confirmLabel).toBe('清掉记录')
    // 一个字节都没有可释放的，文案里也不该提"永久删除文件"
    expect(request.message).not.toContain('整棵内容一起')
  })

  it('被宿主拒绝的那条留在列表里，并把理由原话报出来（不假装清空了）', async () => {
    // 这一路只有宿主会走到（台账被手改过）。Mock 里造不出来，所以用桩适配器：
    // `trash_delete` 返回一份"1 条被拒"的汇报 —— 界面必须逐条说出来，并且**不**摘掉那一行
    await deleteNote('项目/设计.md')
    const base = adapter
    setIpcAdapter({
      kind: 'test',
      invoke: (method: string, args?: Record<string, unknown>): Promise<never> => {
        if (method === 'trash_delete') {
          return Promise.resolve({
            removed: [],
            missing: [],
            bytesFreed: 0,
            failed: [
              {
                id: 'tampered-1',
                originalRelPath: '项目/设计.md',
                reason: 'path-invalid',
                message: '台账记录指向的不是回收站目录下的条目',
              },
            ],
          }) as Promise<never>
        }
        return base.invoke(method, args) as Promise<never>
      },
    })
    ask = stubConfirm(true)
    render(<TrashDialog />)
    await openTrash()

    fireEvent.click(await screen.findByRole('button', { name: '永久删除' }))

    await waitFor(() => {
      const warn = useToastStore.getState().toasts.find((item) => item.kind === 'warn')
      expect(warn?.message ?? '').toContain('1 条未能删除')
    })
    const warn = useToastStore.getState().toasts.find((item) => item.kind === 'warn')
    expect(warn?.message ?? '').toContain('记录仍在列表里')
    expect(warn?.detail ?? '').toContain('项目/设计.md')
    expect(warn?.detail ?? '').toContain('拒绝执行')
    // 那一行必须还在（用户唯一还能看见"这条没清掉"的地方）
    expect(screen.getByText('设计')).toBeTruthy()
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
