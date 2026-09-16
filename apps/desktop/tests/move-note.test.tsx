// @vitest-environment jsdom
/**
 * 跨目录移动（拖拽整理）—— 集成测试。
 *
 * 覆盖四件事：
 * 1. **拖拽落点的三种情形**（文件夹、另一篇笔记、树的空白区域）走完整组件链路，
 *    最终真的搬到目标目录（Mock Vault 的"磁盘"是唯一事实来源）；
 * 2. **同名冲突**：目标目录已有同名文件时给出可读提示，且一个字节都不改；
 * 3. **键盘路径**：命令面板的「移动到文件夹…」命令 + 对话框（纯拖拽对键盘用户不可用）；
 * 4. **store 收敛**：当前文档、标签页、条目表都跟着新路径走，不留"永远 NOT_FOUND 的标签"。
 *
 * 用内存适配器跑，不需要 Tauri；Rust 侧的原子搬迁、跨卷回退、字符 span 改写
 * 由 `cargo test -p mn-core/-p mn-index/-p mimenote` 与应用层 E2E 覆盖。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { moveNote, moveSelected, openNote, openNoteInNewTab } from '@/app/actions'
import { commands } from '@/app/commands'
import { registerBuiltinCommands } from '@/app/builtin-commands'
import { FileTree } from '@/features/vault/FileTree'
import { installTabsSync } from '@/state/tabs-store'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter, MOCK_VAULT_PATH, type MockAdapter } from '@/ipc/mock-adapter'
import { useNoteStore } from '@/state/note-store'
import { useTabsStore } from '@/state/tabs-store'
import { useToastStore } from '@/state/toast-store'
import { useVaultStore } from '@/state/vault-store'

let adapter: MockAdapter

/** 与 `.mn-tree` 里某一行的 DOM 对齐（选择器限定在树内，避免命中预览里的链接）。 */
function treeRow(relPath: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`.mn-tree [data-rel-path="${relPath}"]`)
  if (node === null) throw new Error(`文件树里找不到：${relPath}`)
  return node
}

function treePaths(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.mn-tree-row')).map(
    (node) => node.dataset['relPath'] ?? '',
  )
}

function onDisk(relPath: string): string | undefined {
  return adapter.dump().find((note) => note.relPath === relPath)?.text
}

function toastTexts(kind?: string): string[] {
  return useToastStore
    .getState()
    .toasts.filter((item) => kind === undefined || item.kind === kind)
    .map((item) => `${item.message} ${item.detail ?? ''}`)
}

/**
 * 模拟一次 HTML5 拖拽。
 *
 * jsdom 没有实现 `DataTransfer`，也没有真实拖拽；而组件刻意**不依赖**
 * `dragover` 阶段读 `dataTransfer`（浏览器在那里就是读不到的），
 * 所以这里只按事件顺序派发即可，行为与真实浏览器一致。
 */
function drag(source: HTMLElement, target: HTMLElement): void {
  const dataTransfer = { setData: () => {}, getData: () => '', effectAllowed: 'none' }
  fireEvent.dragStart(source, { dataTransfer })
  fireEvent.dragOver(target, { dataTransfer })
  fireEvent.drop(target, { dataTransfer })
  fireEvent.dragEnd(source, { dataTransfer })
}

/** 只悬停不放下（用来断言落点反馈）。 */
function hover(source: HTMLElement, target: HTMLElement): void {
  const dataTransfer = { setData: () => {}, getData: () => '', effectAllowed: 'none' }
  fireEvent.dragStart(source, { dataTransfer })
  fireEvent.dragOver(target, { dataTransfer })
}

function resetStores(): void {
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

beforeEach(() => {
  adapter = createMockAdapter()
  setIpcAdapter(adapter)
  // 标签页按 Vault 根持久化在 localStorage：「移动后标签收敛」的用例必须从干净状态开始
  window.localStorage.clear()
  resetStores()
})

afterEach(() => {
  cleanup()
})

/** 打开 Mock Vault 并渲染文件树（用例的动作都从"树已经画好"开始）。 */
async function renderTree(): Promise<void> {
  await useVaultStore.getState().openVault(MOCK_VAULT_PATH)
  render(<FileTree />)
  await waitFor(() => {
    expect(treePaths()).toContain('项目/设计.md')
  })
}

describe('拖拽移动：落点', () => {
  it('拖到文件夹行上：真的换了目录，指向它的链接被改写成相对路径，树跟着刷新', async () => {
    await renderTree()
    expect(treePaths()).toContain('日记')

    drag(treeRow('项目/设计.md'), treeRow('日记'))

    await waitFor(() => {
      expect(onDisk('日记/设计.md')).toBeDefined()
    })
    expect(onDisk('项目/设计.md')).toBeUndefined()
    // 链接被改写：`[[设计]]` → 相对新位置的 `[[../日记/设计]]`
    expect(onDisk('项目/路线图.md')).toContain('[[../日记/设计]]')
    expect(onDisk('项目/路线图.md')).not.toContain('[[设计]]')
    // 树：旧行消失、新行出现（条目表原地更新，不重扫）
    await waitFor(() => {
      expect(treePaths()).toContain('日记/设计.md')
    })
    expect(treePaths()).not.toContain('项目/设计.md')
  })

  it('拖到另一篇笔记上 = 移到那篇笔记所在的目录', async () => {
    await renderTree()

    drag(treeRow('项目/设计.md'), treeRow('日记/2025-01-01.md'))

    await waitFor(() => {
      expect(onDisk('日记/设计.md')).toBeDefined()
    })
    expect(onDisk('项目/设计.md')).toBeUndefined()
  })

  it('拖到树的空白区域 = 移到 Vault 根目录', async () => {
    await renderTree()
    const blank = document.querySelector<HTMLElement>('.mn-tree')
    expect(blank).not.toBeNull()
    if (blank === null) return

    drag(treeRow('项目/路线图.md'), blank)

    await waitFor(() => {
      expect(onDisk('路线图.md')).toBeDefined()
    })
    expect(onDisk('项目/路线图.md')).toBeUndefined()
    // 同目录的笔记里指向它的链接也要跟着改成相对路径
    expect(onDisk('项目/设计.md')).toContain('[[../路线图]]')
  })

  it('悬停时就给出落点反馈：可放置 vs 已经在该目录（不可放置）', async () => {
    await renderTree()

    // 同目录：`项目/设计.md` 拖到 `项目` 上没有任何变化 → 明确标成 invalid
    hover(treeRow('项目/设计.md'), treeRow('项目'))
    expect(treeRow('项目').dataset['dropState']).toBe('invalid')
    expect(treeRow('项目').className).toContain('mn-tree-row--drop-invalid')

    fireEvent.dragEnd(treeRow('项目/设计.md'))

    // 换个目录 → valid
    hover(treeRow('项目/设计.md'), treeRow('日记'))
    expect(treeRow('日记').dataset['dropState']).toBe('valid')
    expect(treeRow('日记').className).toContain('mn-tree-row--drop-valid')
  })

  it('落在"已经在该目录"的行上：不发请求、文件不动，只说明原因', async () => {
    await renderTree()

    drag(treeRow('项目/设计.md'), treeRow('项目'))

    expect(onDisk('项目/设计.md')).toBeDefined()
    await waitFor(() => {
      expect(toastTexts('info').some((text) => text.includes('已经'))).toBe(true)
    })
    // 没有改写任何链接
    expect(onDisk('项目/路线图.md')).toContain('[[设计]]')
  })

  it('目标目录已有同名文件：可读提示 + 一个字节都不改', async () => {
    adapter = createMockAdapter({
      notes: [
        { relPath: '项目/设计.md', text: '# 设计\n\n见 [[路线图]]。\n' },
        { relPath: '项目/路线图.md', text: '# 路线图\n\n[[设计]]\n' },
        { relPath: '日记/设计.md', text: '# 日记里的设计\n' },
      ],
    })
    setIpcAdapter(adapter)
    resetStores()
    await renderTree()

    drag(treeRow('项目/设计.md'), treeRow('日记'))

    await waitFor(() => {
      expect(toastTexts('error').some((text) => text.includes('同名'))).toBe(true)
    })
    expect(onDisk('项目/设计.md')).toBeDefined()
    expect(onDisk('日记/设计.md')).toBe('# 日记里的设计\n')
    expect(onDisk('项目/路线图.md')).toContain('[[设计]]')
    expect(treePaths()).toContain('项目/设计.md')
  })

  it('拖到另一篇笔记（落点是它的目录）时，冲突同样被拦住', async () => {
    adapter = createMockAdapter({
      notes: [
        { relPath: '项目/设计.md', text: '# 设计\n' },
        { relPath: '日记/随便.md', text: '# 随便\n' },
        { relPath: '日记/设计.md', text: '# 已存在\n' },
      ],
    })
    setIpcAdapter(adapter)
    resetStores()
    await renderTree()

    drag(treeRow('项目/设计.md'), treeRow('日记/随便.md'))

    await waitFor(() => {
      expect(toastTexts('error').some((text) => text.includes('同名'))).toBe(true)
    })
    expect(onDisk('项目/设计.md')).toBe('# 设计\n')
  })
})

describe('键盘路径（不依赖鼠标）', () => {
  // 内置命令表是**进程级单例**：注册一次即可（`registerBuiltinCommands` 幂等，
  // 而卸载会让后续用例拿不到命令 —— 所以这里刻意不 dispose）。
  beforeAll(() => {
    registerBuiltinCommands()
  })

  it('命令 + 对话框：F6 那条命令能打开「移动到…」，输入目录回车即移动', async () => {
    await renderTree()
    useVaultStore.getState().select('项目/设计.md')

    // 走的是命令表（文件树的 F6 与命令面板里的同一项都落到这里）
    expect(await commands.execute('note.move')).toBe(true)
    const dialog = await screen.findByRole('dialog', { name: '移动到' })
    expect(dialog).toBeDefined()

    const input = screen.getByLabelText('目标目录') as HTMLInputElement
    // 键盘路径的关键：打开即聚焦，不需要再点一下
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('')

    fireEvent.change(input, { target: { value: '日记' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(onDisk('日记/设计.md')).toBeDefined()
    })
    expect(onDisk('项目/设计.md')).toBeUndefined()
    // 成功后对话框关闭，焦点不会卡在已卸载的节点上
    await waitFor(() => {
      expect(screen.queryByLabelText('目标目录')).toBeNull()
    })
  })

  it('输入一个还不存在的目录：宿主创建它，并把它补进条目表（树里立刻看得见）', async () => {
    await renderTree()
    useVaultStore.getState().select('项目/设计.md')

    expect(await commands.execute('note.move')).toBe(true)
    const input = screen.getByLabelText('目标目录')
    fireEvent.change(input, { target: { value: '归档/2026' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(onDisk('归档/2026/设计.md')).toBeDefined()
    })
    await waitFor(() => {
      expect(treePaths()).toContain('归档/2026/设计.md')
    })
    // 新建的目录必须进了条目表，否则前端建树时会把笔记提升成根节点
    expect(treePaths()).toContain('归档')
    expect(treePaths()).toContain('归档/2026')
  })

  it('Esc 取消：不改动任何文件', async () => {
    await renderTree()
    useVaultStore.getState().select('项目/设计.md')

    await commands.execute('note.move')
    const input = screen.getByLabelText('目标目录')
    fireEvent.change(input, { target: { value: '日记' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.queryByLabelText('目标目录')).toBeNull()
    expect(onDisk('项目/设计.md')).toBeDefined()
    expect(onDisk('日记/设计.md')).toBeUndefined()
  })

  it('目录仍然不能移动：命令给出原因，而不是打开一个没用的对话框', async () => {
    await renderTree()
    useVaultStore.getState().select('项目')

    moveSelected()

    expect(toastTexts('warn').some((text) => text.includes('目录移动'))).toBe(true)
    expect(screen.queryByLabelText('目标目录')).toBeNull()
    expect(onDisk('项目/设计.md')).toBeDefined()
  })

  it('附件（非 Markdown）也不能移动', async () => {
    await renderTree()
    useVaultStore.getState().select('附件/说明.txt')

    moveSelected()

    expect(toastTexts('warn').some((text) => text.includes('Markdown'))).toBe(true)
    expect(onDisk('附件/说明.txt')).toBeDefined()
  })
})

describe('移动后的 store 收敛', () => {
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

  async function renderShell(expectVisible = '项目/设计.md'): Promise<void> {
    await useVaultStore.getState().openVault(MOCK_VAULT_PATH)
    render(<Harness />)
    await waitFor(() => {
      expect(treePaths()).toContain(expectVisible)
    })
  }

  /** 标签列表读 store（TabBar 退役后这些用例不挂标签组件，对账由上面的 Sync 安装）。 */
  function tabPaths(): string[] {
    return [...useTabsStore.getState().tabs]
  }

  it('被移动的正是当前文档：原地换路径（保留内容与撤销历史），标签跟着走', async () => {
    await renderShell()
    await openNote('项目/设计.md')
    const before = useNoteStore.getState().doc
    expect(before).not.toBeNull()
    expect(tabPaths()).toEqual(['项目/设计.md'])

    await moveNote('项目/设计.md', '日记')

    const after = useNoteStore.getState().doc
    expect(after?.relPath).toBe('日记/设计.md')
    // 内容没变 → 不该走"重新读取"（revision 不增，光标与撤销历史保留）
    expect(after?.text).toBe(before?.text)
    expect(after?.revision).toBe(before?.revision)
    // 标签页收敛到新路径，而不是留一个点开就 NOT_FOUND 的旧标签
    await waitFor(() => {
      expect(tabPaths()).toEqual(['日记/设计.md'])
    })
    expect(useVaultStore.getState().selected).toBe('日记/设计.md')
  })

  it('自链接的笔记被移动时重新读取（磁盘内容已变，继续用旧文本保存会覆盖改写）', async () => {
    adapter = createMockAdapter({
      notes: [{ relPath: '笔记/自链.md', text: '# 自链\n\n指向自己：[[自链]]。\n' }],
    })
    setIpcAdapter(adapter)
    resetStores()
    await renderShell('笔记/自链.md')
    await openNote('笔记/自链.md')

    await moveNote('笔记/自链.md', '归档')

    const doc = useNoteStore.getState().doc
    expect(doc?.relPath).toBe('归档/自链.md')
    expect(doc?.text).toContain('[[../归档/自链]]')
  })

  it('正在编辑**别的**笔记时：被改写的这篇自动重新读取', async () => {
    await renderShell()
    await openNote('项目/路线图.md')
    expect(useNoteStore.getState().doc?.text).toContain('[[设计]]')

    await moveNote('项目/设计.md', '日记')

    const doc = useNoteStore.getState().doc
    expect(doc?.relPath).toBe('项目/路线图.md')
    expect(doc?.text).toContain('[[../日记/设计]]')
  })

  it('被移动的不是当前文档：指向旧路径的后台标签被剪掉（不留死标签）', async () => {
    await renderShell()
    await openNote('项目/设计.md')
    await openNoteInNewTab('项目/路线图.md')
    expect(tabPaths()).toEqual(['项目/设计.md', '项目/路线图.md'])

    await moveNote('项目/设计.md', '日记')

    await waitFor(() => {
      expect(tabPaths()).toEqual(['项目/路线图.md'])
    })
    expect(useNoteStore.getState().doc?.relPath).toBe('项目/路线图.md')
  })

  it('移动前先落盘：未保存内容不会把链接改写覆盖回去', async () => {
    await renderShell()
    await openNote('项目/路线图.md')
    useNoteStore.getState().setText('新内容：设计细节见 [[设计]]。\n')
    expect(useNoteStore.getState().dirty).toBe(true)

    await moveNote('项目/设计.md', '日记')

    const text = onDisk('项目/路线图.md')
    expect(text).toContain('新内容')
    expect(text).toContain('[[../日记/设计]]')
    expect(useNoteStore.getState().dirty).toBe(false)
  })
})
