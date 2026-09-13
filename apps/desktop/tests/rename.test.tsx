// @vitest-environment jsdom
/**
 * 重命名（含全库链接改写）集成测试。
 *
 * 覆盖两件事：
 * 1. **链路**：改名 → 宿主改写链接 → 前端状态收尾（条目表、选中项、正在编辑的文档）；
 * 2. **顺序约束**：重命名前必须先落盘 —— 否则磁盘上的链接改写会被随后到来的自动保存覆盖，
 *    或者编辑器的版本令牌失效（下次保存报假冲突）。这是最容易出错、也最难在界面上发现的地方。
 *
 * 用内存适配器跑，不需要 Tauri；Rust 侧的精确改写（字符 span、BOM/CRLF 保真）由
 * `cargo test -p mn-index` 与应用层 E2E 覆盖。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openNote, renameNote, renameSelected } from '@/app/actions'
import { requestRename } from '@/app/dom-events'
import { RenameDialog } from '@/features/vault/RenameDialog'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter, type MockAdapter } from '@/ipc/mock-adapter'
import { useNoteStore } from '@/state/note-store'
import { useToastStore } from '@/state/toast-store'
import { useVaultStore } from '@/state/vault-store'

let adapter: MockAdapter

function resetStores(): void {
  useNoteStore.getState().close()
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
  useToastStore.getState().clear()
}

function textOf(relPath: string): string | undefined {
  return adapter.dump().find((note) => note.relPath === relPath)?.text
}

beforeEach(async () => {
  adapter = createMockAdapter()
  setIpcAdapter(adapter)
  resetStores()
  await useVaultStore.getState().openVault('C:\\MockVault')
})

afterEach(() => {
  cleanup()
})

describe('重命名笔记', () => {
  it('改名成功并改写全库指向它的链接', async () => {
    // 预置：路线图里 `[[设计]]` 指向 项目/设计.md
    expect(textOf('项目/路线图.md')).toContain('[[设计]]')

    const outcome = await renameNote('项目/设计.md', '架构设计')

    expect(outcome).not.toBeNull()
    expect(outcome?.oldRelPath).toBe('项目/设计.md')
    expect(outcome?.newRelPath).toBe('项目/架构设计.md')
    expect(outcome?.newMtimeMs).toBeGreaterThan(0)

    // 文件真的改名了
    expect(textOf('项目/架构设计.md')).toBeDefined()
    expect(textOf('项目/设计.md')).toBeUndefined()
    // 链接真的被改写了（其余内容原样保留）
    expect(textOf('项目/路线图.md')).toContain('[[架构设计]]')
    expect(textOf('项目/路线图.md')).not.toContain('[[设计]]')
    expect(textOf('项目/路线图.md')).toContain('设计细节见')
    expect(outcome?.updatedLinks).toEqual([{ relPath: '项目/路线图.md', count: 1 }])
    expect(outcome?.updatedLinkCount).toBe(1)
  })

  it('条目表原地更新：旧路径消失、新路径出现、选中项跟随', async () => {
    useVaultStore.getState().select('项目/设计.md')
    await renameNote('项目/设计.md', '架构设计')

    const state = useVaultStore.getState()
    expect(state.entries.some((entry) => entry.relPath === '项目/设计.md')).toBe(false)
    const renamed = state.entries.find((entry) => entry.relPath === '项目/架构设计.md')
    expect(renamed?.name).toBe('架构设计.md')
    expect(state.selected).toBe('项目/架构设计.md')
    expect(state.tree.some((node) => node.entry.relPath === '项目')).toBe(true)
  })

  it('正在编辑的笔记被改名时换路径而不重载（保留光标与撤销历史）', async () => {
    const { openNote } = await import('@/app/actions')
    await openNote('项目/设计.md')
    const before = useNoteStore.getState().doc
    expect(before).not.toBeNull()

    const outcome = await renameNote('项目/设计.md', '架构设计')

    const after = useNoteStore.getState().doc
    expect(after?.relPath).toBe('项目/架构设计.md')
    expect(after?.baseMtimeMs).toBe(outcome?.newMtimeMs)
    // 内容没变 → 不应该走"重新读取"（revision 不增，撤销历史保留）
    expect(after?.text).toBe(before?.text)
    expect(after?.revision).toBe(before?.revision)
  })

  it('正在编辑的**其他**文件被改写链接时自动重新读取', async () => {
    const { openNote } = await import('@/app/actions')
    await openNote('项目/路线图.md')
    expect(useNoteStore.getState().doc?.text).toContain('[[设计]]')

    await renameNote('项目/设计.md', '架构设计')

    const doc = useNoteStore.getState().doc
    expect(doc?.relPath).toBe('项目/路线图.md')
    // 磁盘上的链接已变，编辑器必须跟着变 —— 否则下次保存会把改写覆盖回去
    expect(doc?.text).toContain('[[架构设计]]')
  })

  it('重命名前先落盘：未保存内容不会覆盖链接改写', async () => {
    const { openNote } = await import('@/app/actions')
    await openNote('项目/路线图.md')
    useNoteStore.getState().setText('新内容：设计细节见 [[设计]]。\n')
    expect(useNoteStore.getState().dirty).toBe(true)

    // 不等待自动保存（默认 600ms 防抖）直接改名
    await renameNote('项目/设计.md', '架构设计')

    const onDisk = textOf('项目/路线图.md')
    expect(onDisk).toContain('新内容')
    expect(onDisk).toContain('[[架构设计]]')
    expect(useNoteStore.getState().dirty).toBe(false)
  })

  it('updateLinks=false 时只改名、不动任何链接', async () => {
    const outcome = await renameNote('项目/设计.md', '架构设计', { updateLinks: false })

    expect(outcome?.updatedLinkCount).toBe(0)
    expect(outcome?.updatedLinks).toEqual([])
    expect(textOf('项目/架构设计.md')).toBeDefined()
    // 旧链接现在指向不存在目标（悬空），这是用户显式选择的结果
    expect(textOf('项目/路线图.md')).toContain('[[设计]]')
    expect(textOf('项目/路线图.md')).not.toContain('[[架构设计]]')
  })

  it('目标重名时返回 null 并保持现场不变', async () => {
    const outcome = await renameNote('项目/设计.md', '路线图')

    expect(outcome).toBeNull()
    expect(textOf('项目/设计.md')).toBeDefined()
    expect(textOf('项目/路线图.md')).toContain('[[设计]]')
    const errors = useToastStore.getState().toasts.filter((item) => item.kind === 'error')
    expect(errors.length).toBe(1)
  })

  it('非法文件名被拒绝，不产生任何改动', async () => {
    const outcome = await renameNote('项目/设计.md', '设计/子目录')

    expect(outcome).toBeNull()
    expect(textOf('项目/设计.md')).toBeDefined()
    expect(useToastStore.getState().toasts.some((item) => item.kind === 'error')).toBe(true)
  })

  it('自链接场景：正在编辑的笔记自身被改写时重新读取（并用旧路径上报）', async () => {
    adapter = createMockAdapter({
      notes: [{ relPath: '自链.md', text: '# 自链\n\n指向自己：[[自链]]。\n' }],
    })
    setIpcAdapter(adapter)
    await useVaultStore.getState().openVault('C:\\MockVault')
    await openNote('自链.md')
    expect(useNoteStore.getState().doc?.text).toContain('[[自链]]')

    const outcome = await renameNote('自链.md', '自链改')
    expect(outcome).not.toBeNull()

    // 宿主用**旧路径**上报"被改名文件自身也被改写"（前端据此判断要不要重读）
    expect(outcome?.updatedLinks).toEqual([{ relPath: '自链.md', count: 1 }])
    const doc = useNoteStore.getState().doc
    expect(doc?.relPath).toBe('自链改.md')
    expect(doc?.text).toContain('[[自链改]]')
  })

  it('目录重命名被明确拒绝（推迟到 M3）', async () => {
    useVaultStore.getState().select('项目')
    renameSelected()

    expect(useToastStore.getState().toasts.some((item) => item.message.includes('目录重命名'))).toBe(true)
    expect(textOf('项目/设计.md')).toBeDefined()
  })
})

describe('重命名对话框', () => {
  it('F2 请求 → 预填文件名 → 回车提交并改写链接', async () => {
    render(<RenameDialog />)
    useVaultStore.getState().select('项目/设计.md')

    requestRename('项目/设计.md')
    const input = await screen.findByLabelText('新文件名')
    // 输入框只装文件名（扩展名单独显示），并默认全选
    expect((input as HTMLInputElement).value).toBe('设计')
    expect(screen.getByText('.md')).toBeDefined()

    fireEvent.change(input, { target: { value: '架构设计' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(textOf('项目/架构设计.md')).toBeDefined()
    })
    expect(textOf('项目/路线图.md')).toContain('[[架构设计]]')
    // 成功后对话框关闭
    await waitFor(() => {
      expect(screen.queryByLabelText('新文件名')).toBeNull()
    })
  })

  it('取消（Esc）不改动任何文件', async () => {
    render(<RenameDialog />)
    requestRename('项目/设计.md')

    const input = await screen.findByLabelText('新文件名')
    fireEvent.change(input, { target: { value: '别的名字' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.queryByLabelText('新文件名')).toBeNull()
    expect(textOf('项目/设计.md')).toBeDefined()
    expect(textOf('项目/别的名字.md')).toBeUndefined()
  })
})
