// @vitest-environment jsdom
/**
 * 目录重命名 / 目录移动（含整棵子树的链接改写）—— 前端集成测试。
 *
 * 覆盖四件事：
 * 1. **Mock 与宿主行为一致**：目录改名/移动在内存 Vault 里真的搬子树、全库指向子树里每一篇
 *    的链接真的被改写、条目表跟着换（否则 UI E2E 会给我们假绿）；
 * 2. **拖拽**：文件夹可以拖、拖到自己的后代 / 自己身上必须无效并说明原因、拖到空白 = 移到根；
 * 3. **F2 / F6 对话框**：文件夹改名预填目录名（不带扩展名）；移动时输入自己的后代按钮置灰；
 * 4. **store 收敛**：正在编辑的这一篇在子树里时**原地换路径**（保留光标与撤销历史），
 *    标签页整棵子树换前缀（顺序不乱），不在子树里的被改写文件自动重新读取。
 *
 * Rust 侧的原子搬迁、前缀映射、span 改写由 `cargo test -p mn-index / -p mimenote` 覆盖。
 */

import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { moveDirectory, moveEntry, openNote, openNoteInNewTab, renameDirectory, renameEntry } from '@/app/actions'
import { requestMove, requestRename } from '@/app/dom-events'
import { MoveDialog } from '@/features/vault/MoveDialog'
import { RenameDialog } from '@/features/vault/RenameDialog'
import { FileTree } from '@/features/vault/FileTree'
import { installTabsSync } from '@/state/tabs-store'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter, MOCK_VAULT_PATH, type MockAdapter } from '@/ipc/mock-adapter'
import { parentOf } from '@/domain/paths'
import { useMoveStore } from '@/state/move-store'
import { useNoteStore } from '@/state/note-store'
import { useRenameStore } from '@/state/rename-store'
import { useTabsStore } from '@/state/tabs-store'
import { useToastStore } from '@/state/toast-store'
import { useVaultStore } from '@/state/vault-store'

let adapter: MockAdapter

const NOTES = [
  { relPath: '项目/设计.md', text: '# 设计\n\n见 [[路线图]] 与 [[子/细节]]。\n' },
  { relPath: '项目/路线图.md', text: '# 路线图\n\n[[设计]]\n' },
  { relPath: '项目/子/细节.md', text: '# 细节\n\n![图](../附件/图.png)\n' },
  { relPath: '别的/引用.md', text: '见 [[项目/设计]]。\n' },
  { relPath: '归档/占位.md', text: '# 占位\n' },
  { relPath: '附件/图.png', text: 'png' },
]

function treePaths(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.mn-tree-row')).map(
    (node) => node.dataset['relPath'] ?? '',
  )
}

function treeRow(relPath: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`.mn-tree [data-rel-path="${relPath}"]`)
  if (node === null) throw new Error(`文件树里找不到：${relPath}`)
  return node
}

function onDisk(relPath: string): string | undefined {
  return adapter.dump().find((note) => note.relPath === relPath)?.text
}

function entryPaths(): string[] {
  return useVaultStore
    .getState()
    .entries.map((entry) => entry.relPath)
    .sort()
}

function toastTexts(kind?: string): string[] {
  return useToastStore
    .getState()
    .toasts.filter((item) => kind === undefined || item.kind === kind)
    .map((item) => `${item.message} ${item.detail ?? ''}`)
}

/**
 * 派发一次拖拽事件。
 *
 * 用 `createEvent` 而不是 `new DragEvent`：jsdom 没有全局的 `DragEvent` 构造器。
 * `dragover` / `drop` 必须**冒泡** —— React 的合成事件委托到根节点，不冒泡的事件会
 * **静默什么都不做**（这条坑过一次）。
 */
function fireDrag(node: HTMLElement, type: string, dataTransfer: unknown): void {
  const event = createEvent[eventNameFor(type)](node, { dataTransfer })
  fireEvent(node, event)
}

const eventNameFor = (type: string): 'dragStart' | 'dragOver' | 'drop' | 'dragEnd' => {
  if (type === 'dragstart') return 'dragStart'
  if (type === 'dragover') return 'dragOver'
  if (type === 'drop') return 'drop'
  return 'dragEnd'
}

/** 只悬停不放下（用来断言落点反馈）。 */
function hover(source: HTMLElement, target: HTMLElement): void {
  fireDrag(source, 'dragstart', { setData: () => {}, getData: () => '', effectAllowed: 'none' })
  fireDrag(target, 'dragover', { setData: () => {}, getData: () => '', effectAllowed: 'none' })
}

/** 一次完整的拖拽（`dragstart` → `dragover` → `drop` → `dragend`）。 */
function drag(source: HTMLElement, target: HTMLElement): void {
  const dataTransfer = { setData: () => {}, getData: () => '', effectAllowed: 'none' }
  fireDrag(source, 'dragstart', dataTransfer)
  fireDrag(target, 'dragover', dataTransfer)
  fireDrag(target, 'drop', dataTransfer)
  fireDrag(source, 'dragend', dataTransfer)
}

/** 确保树里某一行真的渲染出来（必要时先展开父目录）。用例之间不该互相依赖展开状态。 */
async function ensureTreeRow(relPath: string): Promise<void> {
  if (document.querySelector(`.mn-tree [data-rel-path="${relPath}"]`) !== null) return
  const parent = parentOf(relPath)
  if (parent !== '') {
    await ensureTreeRow(parent)
    await act(async () => {
      fireEvent.click(treeRow(parent))
    })
  }
  await waitFor(() => {
    expect(treePaths()).toContain(relPath)
  })
}

function resetStores(): void {
  // 对话框 store 是模块级单例，**跨用例残留**（改了 	arget 的 store 而组件还挂着，
  // 下一条用例就会看到一个不知道从哪来的对话框）
  useRenameStore.getState().close()
  useMoveStore.getState().close()
  useNoteStore.getState().close()
  useTabsStore.setState({ tabs: [], active: null, restoredRoot: null })
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

function useAdapter(notes = NOTES): void {
  adapter = createMockAdapter({ notes })
  setIpcAdapter(adapter)
  // 新适配器 = 一个新的 Vault：**条目表必须跟着清掉**，否则上一个用例的条目会留在树里
  //（"附件打不开改名框"这条用例 正是被上一个用例残留的选中项击中过）
  resetStores()
  useVaultStore.setState({ lastRoot: MOCK_VAULT_PATH })
}

beforeEach(() => {
  // jsdom 里容器高度恒为 0，虚拟列表只会挂 overscan 那几行。装一个"不回调"的 ResizeObserver：
  // 组件于是走 `FALLBACK_VIEWPORT_HEIGHT`，所有行都进 DOM（真实测量的活留给 UI E2E）
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  useAdapter()
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
})

/** 打开 Mock Vault（用例的动作都从"Vault 已经打开"开始）。 */
async function openVault(): Promise<void> {
  await useVaultStore.getState().openVault(MOCK_VAULT_PATH)
}

describe('目录搬迁：磁盘与条目表', () => {
  it('改名一个目录：子树跟着走，指向它的链接被改写成新位置', async () => {
    await openVault()

    const outcome = await renameDirectory('项目', '工程')

    expect(outcome).not.toBeNull()
    expect(outcome?.oldRelPath).toBe('项目')
    expect(outcome?.newRelPath).toBe('工程')
    expect(outcome?.updatedLinkCount).toBe(1)

    // 磁盘：整棵子树搬过去，一处不少
    expect(onDisk('工程/设计.md')).toBe('# 设计\n\n见 [[路线图]] 与 [[子/细节]]。\n')
    expect(onDisk('工程/路线图.md')).toBe('# 路线图\n\n[[设计]]\n')
    expect(onDisk('工程/子/细节.md')).toBe('# 细节\n\n![图](../附件/图.png)\n')
    expect(onDisk('项目/设计.md')).toBeUndefined()
    // 子树之外的引用改写成新位置
    expect(onDisk('别的/引用.md')).toBe('见 [[../工程/设计]]。\n')

    // 条目表：**整棵子树**换路径，一篇都不能少（少一篇 = 文件树空一片）
    const paths = entryPaths()
    expect(paths).toContain('工程/设计.md')
    expect(paths).toContain('工程/路线图.md')
    expect(paths).toContain('工程/子/细节.md')
    expect(paths).not.toContain('项目/设计.md')
    expect(useVaultStore.getState().tree.some((node) => node.entry.relPath === '工程')).toBe(true)
  })

  it('移动一个目录到另一个目录下，再移回 Vault 根', async () => {
    await openVault()

    const moved = await moveDirectory('项目', '归档')
    expect(moved?.newRelPath).toBe('归档/项目')
    expect(onDisk('归档/项目/设计.md')).toBeDefined()
    expect(onDisk('别的/引用.md')).toBe('见 [[../归档/项目/设计]]。\n')
    expect(entryPaths()).toContain('归档/项目/子/细节.md')

    const back = await moveDirectory('归档/项目', '')
    expect(back?.newRelPath).toBe('项目')
    expect(onDisk('项目/设计.md')).toBeDefined()
    expect(onDisk('别的/引用.md')).toBe('见 [[../项目/设计]]。\n')
  })

  it('搬到还不存在的目录：宿主创建它，条目表里立刻看得见', async () => {
    await openVault()

    await moveDirectory('项目', '新归档/2026')

    expect(onDisk('新归档/2026/项目/设计.md')).toBeDefined()
    const paths = entryPaths()
    expect(paths).toContain('新归档')
    expect(paths).toContain('新归档/2026')
    expect(paths).toContain('新归档/2026/项目/设计.md')
  })

  it('搬进自己的后代：被拒绝，一个字节都不动', async () => {
    await openVault()

    const outcome = await moveDirectory('项目', '项目/子')

    expect(outcome).toBeNull()
    expect(toastTexts('error').some((text) => text.includes('落点'))).toBe(true)
    expect(onDisk('项目/设计.md')).toBeDefined()
    expect(onDisk('别的/引用.md')).toBe('见 [[项目/设计]]。\n')
  })

  it('目标同名目录：拒绝（绝不合并两棵子树）', async () => {
    useAdapter([
      { relPath: '项目/设计.md', text: '# 设计\n' },
      { relPath: '归档/项目/设计.md', text: '# 归档里的设计\n' },
    ])
    await openVault()

    const outcome = await moveDirectory('项目', '归档')

    expect(outcome).toBeNull()
    expect(toastTexts('error').some((text) => text.includes('同名文件夹'))).toBe(true)
    expect(onDisk('项目/设计.md')).toBe('# 设计\n')
    expect(onDisk('归档/项目/设计.md')).toBe('# 归档里的设计\n')
  })

  it('按条目类型分派：笔记走单篇链路、文件夹走目录链路', async () => {
    await openVault()

    const renamed = await renameEntry('项目', '工程')
    expect(renamed?.newRelPath).toBe('工程')

    // 笔记走的是 `note_rename`（同目录改名，裸名链接仍是裸名）
    const note = await renameEntry('工程/路线图.md', '里程碑')
    expect(note?.newRelPath).toBe('工程/里程碑.md')

    // 移动：文件夹与笔记分别落到各自那条链路
    const dir = await moveEntry('工程', '归档')
    expect(dir?.newRelPath).toBe('归档/工程')
    const single = await moveEntry('归档/工程/里程碑.md', '')
    expect(single?.newRelPath).toBe('里程碑.md')
  })
})

describe('拖拽：文件夹拖动与无效落点', () => {
  it('把文件夹拖到另一个文件夹上：整棵子树搬过去', async () => {
    await openVault()
    render(<FileTree />)
    await ensureTreeRow('归档')

    // 文件夹现在是可拖的，且目录行本身就是合法落点
    expect(treeRow('项目').getAttribute('draggable')).toBe('true')

    hover(treeRow('项目'), treeRow('归档'))
    expect(treeRow('归档').dataset['dropState']).toBe('valid')
    drag(treeRow('项目'), treeRow('归档'))

    await waitFor(() => {
      expect(onDisk('归档/项目/设计.md')).toBeDefined()
    })
    expect(onDisk('项目/设计.md')).toBeUndefined()
    await waitFor(() => {
      expect(treePaths()).toContain('归档/项目/设计.md')
    })
  })

  it('把文件夹拖到自己的子目录上：悬停即标成无效并说明原因', async () => {
    await openVault()
    render(<FileTree />)
    await ensureTreeRow('项目/子')

    hover(treeRow('项目'), treeRow('项目/子'))
    expect(treeRow('项目/子').dataset['dropState']).toBe('invalid')
    expect(treeRow('项目/子').className).toContain('mn-tree-row--drop-invalid')

    // 落下也不发请求（只把原因告诉用户）
    drag(treeRow('项目'), treeRow('项目/子'))
    await waitFor(() => {
      expect(toastTexts('info').some((text) => text.includes('子目录'))).toBe(true)
    })
    expect(onDisk('项目/设计.md')).toBeDefined()
    expect(onDisk('项目/子/细节.md')).toBeDefined()
  })

  it('拖到自己的行上：无效（不能把文件夹移到它自己里面）', async () => {
    await openVault()
    render(<FileTree />)

    hover(treeRow('项目'), treeRow('项目'))
    expect(treeRow('项目').dataset['dropState']).toBe('invalid')
    fireEvent.dragEnd(treeRow('项目'))
  })

  it('把子目录拖到树的空白区域 = 搬到 Vault 根', async () => {
    await openVault()
    render(<FileTree />)
    const blank = document.querySelector<HTMLElement>('.mn-tree')
    expect(blank).not.toBeNull()
    if (blank === null) return
    await ensureTreeRow('项目/子')

    hover(treeRow('项目/子'), blank)
    expect(blank.dataset['dropRoot']).toBe('valid')
    drag(treeRow('项目/子'), blank)

    await waitFor(() => {
      expect(onDisk('子/细节.md')).toBeDefined()
    })
    expect(onDisk('项目/子/细节.md')).toBeUndefined()
  })

  it('已经在 Vault 根目录的文件夹拖到空白区域：无效（没变化）', async () => {
    await openVault()
    render(<FileTree />)
    const blank = document.querySelector<HTMLElement>('.mn-tree')
    if (blank === null) return

    hover(treeRow('项目'), blank)
    expect(blank.dataset['dropRoot']).toBe('invalid')
    fireEvent.dragEnd(treeRow('项目'))
  })
})

describe('键盘路径：F2 / F6 对话框', () => {
  it('F2：选中的是文件夹时预填目录名（不显示扩展名），回车后改名 + 改写链接', async () => {
    await openVault()
    render(<RenameDialog />)

    await act(async () => {
      requestRename('项目')
    })
    const input = await screen.findByLabelText('新文件名')
    expect((input as HTMLInputElement).value).toBe('项目')
    // 文件夹没有扩展名这回事
    expect(document.querySelector('.mn-rename__ext')).toBeNull()
    expect(screen.getByText('重命名文件夹')).toBeDefined()

    fireEvent.change(input, { target: { value: '工程' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(onDisk('工程/设计.md')).toBeDefined()
    })
    expect(onDisk('别的/引用.md')).toBe('见 [[../工程/设计]]。\n')
    await waitFor(() => {
      expect(screen.queryByLabelText('新文件名')).toBeNull()
    })
  })

  it('F2：笔记仍然预填文件名并单独显示扩展名', async () => {
    await openVault()
    render(<RenameDialog />)

    await act(async () => {
      requestRename('项目/设计.md')
    })
    const input = await screen.findByLabelText('新文件名')
    expect((input as HTMLInputElement).value).toBe('设计')
    expect(screen.getByText('.md')).toBeDefined()
    expect(screen.getByText('重命名笔记')).toBeDefined()
  })

  it('F6：把文件夹移动到另一个目录（输入框里是目标目录）', async () => {
    await openVault()
    render(<MoveDialog />)

    await act(async () => {
      requestMove('项目')
    })
    const input = await screen.findByLabelText('目标目录')
    expect(document.activeElement).toBe(input)
    expect(screen.getByText('移动文件夹到…')).toBeDefined()

    fireEvent.change(input, { target: { value: '归档' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(onDisk('归档/项目/设计.md')).toBeDefined()
    })
    expect(onDisk('项目/设计.md')).toBeUndefined()
  })

  it('F6：输入自己的后代时按钮置灰并说明原因（不等宿主报"找不到路径"）', async () => {
    await openVault()
    render(<MoveDialog />)

    await act(async () => {
      requestMove('项目')
    })
    const input = await screen.findByLabelText('目标目录')
    fireEvent.change(input, { target: { value: '项目/子' } })

    const confirm = screen.getByRole('button', { name: '移动' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(screen.getByText('不能把文件夹移动到它自己或它的子目录里。')).toBeDefined()

    // Esc 取消：什么都不会发生
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onDisk('项目/设计.md')).toBeDefined()
  })

  it('F2 的请求事件：附件（非 Markdown、非目录）不会打开对话框', async () => {
    useAdapter([...NOTES, { relPath: '附件/说明.txt', text: 'x' }])
    await openVault()
    render(<RenameDialog />)

    await act(async () => {
      requestRename('附件/说明.txt')
    })

    await waitFor(() => {
      expect(screen.queryByLabelText('新文件名')).toBeNull()
    })
  })
})

describe('目录搬迁：正在编辑的文档与标签页', () => {
  /** 标签页的对账（`installTabsSync`）原来由 TabBar 安装；TabBar 退役后直接挂这个效应。 */
  function Sync() {
    useEffect(() => installTabsSync(), [])
    return null
  }
  function Harness() {
    return (
      <>
        <FileTree />
        <Sync />
      </>
    )
  }

  /** 标签列表读 store（TabBar 退役后这些用例不挂标签组件，对账由上面的 Sync 安装）。 */
  function tabPaths(): string[] {
    return [...useTabsStore.getState().tabs]
  }

  it('正在编辑的这一篇在子树里：原地换路径（保留内容与撤销历史），标签跟着走', async () => {
    await openVault()
    render(<Harness />)
    await openNote('项目/设计.md')
    const before = useNoteStore.getState().doc
    expect(before).not.toBeNull()
    expect(tabPaths()).toEqual(['项目/设计.md'])

    await renameDirectory('项目', '工程')

    const after = useNoteStore.getState().doc
    expect(after?.relPath).toBe('工程/设计.md')
    // 正文没变 → 不该走"重新读取"（revision 不增，光标与撤销历史保留）
    expect(after?.text).toBe(before?.text)
    expect(after?.revision).toBe(before?.revision)
    await waitFor(() => {
      expect(tabPaths()).toEqual(['工程/设计.md'])
    })
    expect(useVaultStore.getState().selected).toBe('工程/设计.md')
  })

  it('多个标签里只有一部分在子树里：顺序不乱、其余标签照旧', async () => {
    await openVault()
    render(<Harness />)
    await openNote('项目/设计.md')
    await openNoteInNewTab('别的/引用.md')
    expect(tabPaths()).toEqual(['项目/设计.md', '别的/引用.md'])

    await renameDirectory('项目', '工程')

    await waitFor(() => {
      expect(tabPaths()).toEqual(['工程/设计.md', '别的/引用.md'])
    })
    expect(useNoteStore.getState().doc?.relPath).toBe('别的/引用.md')
  })

  it('正在编辑**子树之外**、但正文被改写的文件：自动重新读取', async () => {
    await openVault()
    render(<Harness />)
    await openNote('别的/引用.md')
    expect(useNoteStore.getState().doc?.text).toContain('[[项目/设计]]')

    await renameDirectory('项目', '工程')

    await waitFor(() => {
      expect(useNoteStore.getState().doc?.text).toContain('[[../工程/设计]]')
    })
    const doc = useNoteStore.getState().doc
    expect(doc?.relPath).toBe('别的/引用.md')
  })

  it('目录搬迁前先落盘：未保存内容不会把链接改写覆盖回去', async () => {
    await openVault()
    render(<Harness />)
    await openNote('别的/引用.md')
    useNoteStore.getState().setText('新内容：见 [[项目/设计]]。\n')
    expect(useNoteStore.getState().dirty).toBe(true)

    await renameDirectory('项目', '工程')

    const text = onDisk('别的/引用.md')
    expect(text).toContain('新内容')
    expect(text).toContain('[[../工程/设计]]')
    expect(useNoteStore.getState().dirty).toBe(false)
  })

  it('展开状态跟着换前缀（搬迁后原来展开的目录仍是展开的）', async () => {
    await openVault()
    render(<Harness />)
    useVaultStore.getState().setExpanded('项目', true)
    useVaultStore.getState().setExpanded('项目/子', true)

    await renameDirectory('项目', '工程')

    const expanded = useVaultStore.getState().expanded
    expect(expanded.has('工程')).toBe(true)
    expect(expanded.has('工程/子')).toBe(true)
    expect(expanded.has('项目')).toBe(false)
    await waitFor(() => {
      expect(treePaths()).toContain('工程/子/细节.md')
    })
  })
})
