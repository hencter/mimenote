/**
 * Vault 流程集成测试：打开 → 树 → 新建 → 删除（含二次确认） → 打开笔记。
 *
 * 这些是 M1 的验收闭环，用内存适配器跑，不需要 Tauri 运行时。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createNoteIn, deleteSelected, openNote } from '@/app/actions'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter, type MockAdapter } from '@/ipc/mock-adapter'
import { useConfirmStore } from '@/state/confirm-store'
import { useNoteStore } from '@/state/note-store'
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
  useConfirmStore.setState({ request: null, answer: null })
}

beforeEach(() => {
  adapter = createMockAdapter()
  setIpcAdapter(adapter)
  resetStores()
})

describe('打开 Vault', () => {
  it('一次调用即拿到条目表与树，且计数正确', async () => {
    const ok = await useVaultStore.getState().openVault('C:\\MockVault')
    expect(ok).toBe(true)

    const state = useVaultStore.getState()
    expect(state.status).toBe('ready')
    expect(state.info?.name).toBe('MockVault')
    expect(state.info?.noteCount).toBeGreaterThan(0)
    expect(state.entries.length).toBeGreaterThan(0)
    // 树里出现嵌套目录
    const diary = state.tree.find((node) => node.entry.relPath === '日记')
    expect(diary).toBeDefined()
    expect(diary?.children.length).toBeGreaterThan(0)
    // 非 markdown 附件也在条目表里（只是不可编辑）
    expect(state.entries.some((entry) => entry.relPath === '附件/说明.txt')).toBe(true)
  })

  it('首次打开默认展开顶层目录', async () => {
    await useVaultStore.getState().openVault('C:\\MockVault')
    const expanded = useVaultStore.getState().expanded
    expect(expanded.has('日记')).toBe(true)
    expect(expanded.has('日记/2025')).toBe(false)
  })

  it('展开/折叠与全部展开', async () => {
    await useVaultStore.getState().openVault('C:\\MockVault')
    useVaultStore.getState().toggleExpanded('日记')
    expect(useVaultStore.getState().expanded.has('日记')).toBe(false)
    useVaultStore.getState().expandAll()
    expect(useVaultStore.getState().expanded.has('项目/子项目')).toBe(true)
    useVaultStore.getState().collapseAll()
    expect(useVaultStore.getState().expanded.size).toBe(0)
  })

  it('revealPath 展开目标的所有祖先', async () => {
    await useVaultStore.getState().openVault('C:\\MockVault')
    useVaultStore.getState().revealPath('项目/子项目/细节.md')
    const expanded = useVaultStore.getState().expanded
    expect(expanded.has('项目')).toBe(true)
    expect(expanded.has('项目/子项目')).toBe(true)
  })

  it('打开失败时进入错误态并清空条目', async () => {
    setIpcAdapter({
      kind: 'test',
      invoke: () => Promise.reject({ code: 'NOT_FOUND', message: '目标不存在', detail: null, currentMtimeMs: null }),
    })
    const ok = await useVaultStore.getState().openVault('D:\\不存在的目录')
    expect(ok).toBe(false)
    const state = useVaultStore.getState()
    expect(state.status).toBe('error')
    expect(state.error?.code).toBe('NOT_FOUND')
    expect(state.entries).toEqual([])
  })
})

describe('打开笔记', () => {
  it('打开 Markdown：选中并载入编辑器内容', async () => {
    await useVaultStore.getState().openVault('C:\\MockVault')
    const ok = await openNote('README.md')
    expect(ok).toBe(true)
    expect(useNoteStore.getState().doc?.relPath).toBe('README.md')
    expect(useVaultStore.getState().selected).toBe('README.md')
  })

  it('非 Markdown 文件不会被打开', async () => {
    await useVaultStore.getState().openVault('C:\\MockVault')
    const ok = await openNote('附件/说明.txt')
    expect(ok).toBe(false)
    expect(useNoteStore.getState().doc).toBeNull()
  })
})

describe('新建笔记', () => {
  it('在指定目录创建、注册到树并自动打开', async () => {
    await useVaultStore.getState().openVault('C:\\MockVault')
    const relPath = await createNoteIn('项目', '新想法')

    expect(relPath).toBe('项目/新想法.md')
    const state = useVaultStore.getState()
    expect(state.entries.some((entry) => entry.relPath === '项目/新想法.md')).toBe(true)
    expect(state.selected).toBe('项目/新想法.md')
    expect(state.expanded.has('项目')).toBe(true)
    expect(useNoteStore.getState().doc?.relPath).toBe('项目/新想法.md')
  })

  it('重名自动避让（从「 1」开始，与宿主实现一致）', async () => {
    await useVaultStore.getState().openVault('C:\\MockVault')
    expect(await createNoteIn('项目', '重复')).toBe('项目/重复.md')
    expect(await createNoteIn('项目', '重复')).toBe('项目/重复 1.md')
    expect(await createNoteIn('项目', '重复')).toBe('项目/重复 2.md')
  })
})

describe('删除到回收站', () => {
  it('取消确认时什么也不做', async () => {
    await useVaultStore.getState().openVault('C:\\MockVault')
    const before = useVaultStore.getState().entries.length

    const pending = deleteSelected('README.md')
    await vi.waitFor(() => expect(useConfirmStore.getState().request).not.toBeNull())
    expect(useConfirmStore.getState().request?.danger).toBe(true)
    useConfirmStore.getState().respond(false)
    await pending

    expect(useVaultStore.getState().entries.length).toBe(before)
    expect(adapter.dump().some((note) => note.relPath === 'README.md')).toBe(true)
  })

  it('确认后条目从树中消失、文件进入回收站、打开的文档被关闭', async () => {
    await useVaultStore.getState().openVault('C:\\MockVault')
    await openNote('随手记.md')

    const pending = deleteSelected('随手记.md')
    await vi.waitFor(() => expect(useConfirmStore.getState().request).not.toBeNull())
    useConfirmStore.getState().respond(true)
    await pending

    const state = useVaultStore.getState()
    expect(state.entries.some((entry) => entry.relPath === '随手记.md')).toBe(false)
    expect(state.info?.noteCount).toBeLessThan(adapter.dump().length + 1)
    expect(adapter.dump().some((note) => note.relPath === '随手记.md')).toBe(false)
    expect(useNoteStore.getState().doc).toBeNull()
    expect(useVaultStore.getState().selected).toBeNull()
  })

  it('删除目录会连同后代一起从缓存移除', async () => {
    await useVaultStore.getState().openVault('C:\\MockVault')
    const before = useVaultStore.getState().entries.length

    useVaultStore.getState().registerDeletedEntry({
      id: 'x',
      originalRelPath: '项目/子项目',
      storedRelPath: '.mimenote/trash/x__子项目',
      deletedAtMs: Date.now(),
      sizeBytes: 10,
      isDir: true,
    })

    const state = useVaultStore.getState()
    expect(state.entries.length).toBeLessThan(before)
    expect(state.entries.some((entry) => entry.relPath.startsWith('项目/子项目'))).toBe(false)
    // 同级其他内容仍在
    expect(state.entries.some((entry) => entry.relPath === '项目/设计.md')).toBe(true)
  })
})

describe('重扫', () => {
  it('外部新增文件后重扫可见', async () => {
    await useVaultStore.getState().openVault('C:\\MockVault')
    adapter.simulateExternalEdit('README.md', '# 变更')
    await useVaultStore.getState().rescan()
    expect(useVaultStore.getState().status).toBe('ready')
    const entry = useVaultStore.getState().entries.find((item) => item.relPath === 'README.md')
    expect(entry?.sizeBytes).toBeGreaterThan(0)
  })
})

describe('启动 Vault（命令行参数）', () => {
  it('命令行指定的 Vault 优先于"上次打开"', async () => {
    // 上次打开的是 MockVault
    setIpcAdapter(createMockAdapter({ rootPath: 'C:\\LastVault' }))
    await useVaultStore.getState().openVault('C:\\LastVault')
    expect(useVaultStore.getState().info?.name).toBe('MockVault')

    // 换成"命令行指定了另一个 Vault"的宿主
    setIpcAdapter(
      createMockAdapter({ rootPath: 'C:\\ArgVault', startupVaultPath: 'C:\\ArgVault' }),
    )
    useVaultStore.setState({ info: null, entries: [], tree: [], selected: null })

    await useVaultStore.getState().restoreLastVault()
    expect(useVaultStore.getState().info?.rootPath).toBe('C:\\ArgVault')
  })

  it('命令行 Vault 打不开时回退到上次打开的 Vault', async () => {
    await useVaultStore.getState().openVault('C:\\MockVault')
    expect(useVaultStore.getState().info?.rootPath).toBe('C:\\MockVault')

    // 宿主声称有一个已被删除的启动 Vault；其余命令正常
    const missing = 'D:\\已经不在了'
    setIpcAdapter({
      kind: 'test',
      invoke: <T,>(method: string, args?: Record<string, unknown>): Promise<T> => {
        if (method === 'startup_vault') return Promise.resolve(missing as unknown as T)
        if (method === 'vault_open') {
          const path = String(args?.['path'] ?? '')
          if (path === missing) {
            return Promise.reject({
              code: 'NOT_FOUND',
              message: '目标不存在',
              detail: null,
              currentMtimeMs: null,
            })
          }
          return Promise.resolve({
            rootPath: path,
            name: 'LastVault',
            entries: [],
            noteCount: 0,
            folderCount: 0,
            truncated: false,
            skipped: 0,
            scanMs: 1,
            generatedAtMs: Date.now(),
          } as unknown as T)
        }
        return Promise.reject(new Error(`未预期的调用：${method}`))
      },
    })

    useVaultStore.setState({ info: null, entries: [], tree: [], selected: null })
    await useVaultStore.getState().restoreLastVault()

    // 启动 Vault 失败 → 回退到上次打开的 Vault，并且最终是可用状态
    const state = useVaultStore.getState()
    expect(state.status).toBe('ready')
    expect(state.info?.rootPath).toBe('C:\\MockVault')
  })

  it('没有启动 Vault 时沿用上次打开的 Vault', async () => {
    await useVaultStore.getState().openVault('C:\\MockVault')
    useVaultStore.setState({ info: null, entries: [], tree: [], selected: null })

    await useVaultStore.getState().restoreLastVault()
    expect(useVaultStore.getState().info?.rootPath).toBe('C:\\MockVault')
  })
})
