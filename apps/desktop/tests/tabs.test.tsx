// @vitest-environment jsdom
/**
 * 多标签页（M3；ADR-0035 之后标签住在容器切割树的叶子里）。
 *
 * 覆盖四件事：
 * 1. **开/切/关**：打开笔记产生标签、点标签切回正确的那篇、关闭当前标签激活相邻项、
 *    全关回到空态；
 * 2. **不丢内容**：有未保存内容时切走必须落盘（走 `openNote` 的既有顺序约束）；
 *    关闭有未保存内容的标签要先二次确认，确认后才丢弃，拒绝则标签与内容都还在；
 * 3. **持久化**：按 Vault 根存 localStorage、重开同一个 Vault 恢复（含失效路径丢弃）、
 *    换 Vault 清空；
 * 4. **契约**：DOM/ARIA 形状（`tablist`/`tab`/`aria-selected`/roving tabindex）、
 *    `Delete` 不误关标签、以及样式契约（横向滚动 + 标签最小宽度 + 颜色只走令牌）。
 *
 * 断言尽量落在**可观测的副作用**上（store 状态、DOM、localStorage、Mock 适配器里的
 * "磁盘"内容），而不是实现细节 —— 换实现不该让这些用例变红。
 *
 * Harness 直接挂**真实的 `TreeHost`**（容器切割树渲染器）：标签的对账
 * （`installTabsSync`）与光标记忆器都由它装配，测试因此永远钉的是真实接线。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { EditorView } from '@codemirror/view'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { openNote } from '@/app/actions'
import { registerBuiltinCommands } from '@/app/builtin-commands'
import { commands } from '@/app/commands'
import { useGlobalKeymap } from '@/app/keymap'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { TreeHost } from '@/features/layout/TreeHost'
import { defaultLayout, leafOfItem, moveItem, noteItem } from '@/features/layout/tree-layout'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter, MOCK_VAULT_PATH, type MockAdapter } from '@/ipc/mock-adapter'
import { useConfirmStore } from '@/state/confirm-store'
import { useNoteStore } from '@/state/note-store'
import { loadTabsFor, persistTabsFor, setCaretMemory, useTabsStore } from '@/state/tabs-store'
import { useTagsStore } from '@/state/tags-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

/** 容器切割树 + 确认框（标签的"未保存 → 关闭"要走真实的确认流程）。 */
function Harness() {
  return (
    <>
      <TreeHost />
      <ConfirmDialog />
    </>
  )
}

let adapter: MockAdapter

function resetStores(): void {
  useNoteStore.getState().close()
  useTabsStore.setState({ tabs: [], active: null, restoredRoot: null })
  useConfirmStore.setState({ request: null, answer: null })
  // 布局树回到"只有空主叶"：四个模块由挂载时的对账补出来（与真实启动同一条路）
  useUiStore.setState({
    layout: defaultLayout(),
    viewMode: 'edit',
    openedFile: null,
    sidebarVisible: true,
    linksPanelVisible: false,
    outlinePanelVisible: false,
  })
  useTagsStore.setState({ open: false })
  useVaultStore.setState({
    status: 'idle',
    info: null,
    entries: [],
    tree: [],
    expanded: new Set<string>(),
    selected: null,
    filter: '',
    error: null,
    lastRoot: null,
  })
}

async function openVault(path = MOCK_VAULT_PATH): Promise<void> {
  await act(async () => {
    await useVaultStore.getState().openVault(path)
  })
}

async function open(path: string): Promise<void> {
  await act(async () => {
    await openNote(path)
  })
}

/** 当前所有**笔记**标签的路径（按显示顺序；模块标签不在此列）。 */
function tabPaths(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-tab-path]')).map(
    (node) => node.dataset.tabPath ?? '',
  )
}

/** 按路径取标签节点（用 data 属性而不是选择器转义，路径里可能有 `/` 等字符）。 */
function tabNode(relPath: string): HTMLElement {
  for (const node of document.querySelectorAll<HTMLElement>('[data-tab-path]')) {
    if (node.dataset.tabPath === relPath) return node
  }
  throw new Error(`标签里找不到：${relPath}（当前：${tabPaths().join('、')}）`)
}

/** 某个标签上的 `×` 按钮。 */
function closeButton(relPath: string): HTMLElement {
  return screen.getByRole('button', { name: `关闭 ${relPath}` })
}

/** Mock 适配器里的"磁盘内容"（`dump()` 就是唯一的事实来源）。 */
function onDisk(relPath: string): string | undefined {
  return adapter.dump().find((note) => note.relPath === relPath)?.text
}

beforeEach(() => {
  adapter = createMockAdapter()
  setIpcAdapter(adapter)
  window.localStorage.clear()
  setCaretMemory(null)
  resetStores()
})

afterEach(() => {
  cleanup()
})

describe('打开与切换', () => {
  it('打开笔记产生标签（落在主叶），再开一篇是两个标签且激活项跟着变', async () => {
    render(<Harness />)
    await openVault()

    // 没有打开的笔记 → 主叶没有标签条（空态就是主视图的空文档态，布局零变化）
    expect(tabPaths()).toEqual([])
    expect(document.querySelector('[data-leaf-tabs="main"]')).toBeNull()

    await open('README.md')
    expect(tabPaths()).toEqual(['README.md'])
    // 标签住在**主叶**的标签条里（容器切割树：不再有全局标签栏）
    expect(document.querySelector('[data-leaf-tabs="main"]')).not.toBeNull()
    expect(tabNode('README.md').closest('[data-leaf-id]')?.getAttribute('data-leaf-id')).toBe('main')
    expect(tabNode('README.md').getAttribute('aria-selected')).toBe('true')
    // 标签上显示的是文件名（完整路径在 title 里），且不带 `.md`（ADR-0030）
    expect(tabNode('README.md').querySelector('.mn-tabs__label')?.textContent).toBe('README')

    await open('项目/设计.md')
    expect(tabPaths()).toEqual(['README.md', '项目/设计.md'])
    expect(tabNode('README.md').getAttribute('aria-selected')).toBe('false')
    expect(tabNode('项目/设计.md').getAttribute('aria-selected')).toBe('true')
    // 标签上的可见文字不带 .md（ADR-0030）；**身份**仍然由 data-tab-path 承载（上面那两行）
    expect(tabNode('项目/设计.md').querySelector('.mn-tabs__label')?.textContent).toBe('设计')
    expect(tabNode('项目/设计.md').getAttribute('title')).toBe('项目/设计.md')
  })

  it('点标签切回：note-store 的当前文档与文件树选中项都跟着走', async () => {
    render(<Harness />)
    await openVault()
    await open('README.md')
    await open('项目/设计.md')

    fireEvent.click(tabNode('README.md'))

    await waitFor(() => {
      expect(useNoteStore.getState().doc?.relPath).toBe('README.md')
    })
    // 走的是 app/actions.openNote：文件树选中项也要同步（不是绕过动作直接改 store）
    expect(useVaultStore.getState().selected).toBe('README.md')
    expect(tabNode('README.md').getAttribute('aria-selected')).toBe('true')
    // 切回不改变列表顺序
    expect(tabPaths()).toEqual(['README.md', '项目/设计.md'])
  })

  it('快速切换/预览里打开的新笔记也会自动成为标签（订阅 note-store，不靠调用点记得加）', async () => {
    render(<Harness />)
    await openVault()

    // 模拟"从别的入口打开"：直接调用高层动作（文件树、wikilink、快速切换都走它）
    await open('项目/路线图.md')
    await open('日记/2025-01-01.md')

    expect(tabPaths()).toEqual(['项目/路线图.md', '日记/2025-01-01.md'])
    expect(tabNode('日记/2025-01-01.md').getAttribute('aria-selected')).toBe('true')
  })

  it('wikilink 打开一篇"标签在树上但那格停在别处"的笔记时，那一格会翻回它（activeNote 对账）', async () => {
    render(<Harness />)
    await openVault()
    await open('README.md')
    await open('项目/设计.md')

    // 把「设计」拖出主叶、再把「路线图」并进它那一格并停在上面
    await open('项目/路线图.md')
    act(() => {
      const ui = useUiStore.getState()
      let tree = moveItem(ui.layout, noteItem('项目/设计.md'), { leafId: 'main', edge: 'bottom' })
      tree = moveItem(tree, noteItem('项目/路线图.md'), {
        leafId: leafOfItem(tree, noteItem('项目/设计.md'))!.id,
      })
      ui.setLayout(tree)
    })
    expect(
      leafOfItem(useUiStore.getState().layout, noteItem('项目/设计.md'))?.active,
    ).toBe(noteItem('项目/路线图.md'))

    // 打开「设计」：对账必须把它所在的格子翻回它（否则编辑器无处可显示）
    await open('项目/设计.md')
    expect(
      leafOfItem(useUiStore.getState().layout, noteItem('项目/设计.md'))?.active,
    ).toBe(noteItem('项目/设计.md'))
  })
})

/** 模型操作直接引自 `tree-layout`（测试钉的是真实实现，不另造一套）。 */

describe('切换标签不丢未保存内容', () => {
  it('输入后立刻切走：那次编辑必须先落盘（openNote 的既有顺序约束）', async () => {
    render(<Harness />)
    await openVault()
    await open('README.md')
    await open('项目/设计.md')

    // 编辑器输入路径就是 setText（只写内存 + 调度防抖保存）
    act(() => {
      useNoteStore.getState().setText('# 改过的设计\n')
    })
    expect(useNoteStore.getState().dirty).toBe(true)
    expect(onDisk('项目/设计.md')).not.toBe('# 改过的设计\n')

    // 立刻切走
    fireEvent.click(tabNode('README.md'))

    await waitFor(() => {
      expect(useNoteStore.getState().doc?.relPath).toBe('README.md')
    })
    // 切走前的落盘真的发生了：内容既在磁盘上，也不会随着激活标签变化消失
    expect(onDisk('项目/设计.md')).toBe('# 改过的设计\n')
    expect(useNoteStore.getState().dirty).toBe(false)
  })

  it('切回带未保存内容的标签时内容还在（自动保存期间来回切也不丢）', async () => {
    render(<Harness />)
    await openVault()
    await open('README.md')
    await open('项目/设计.md')

    act(() => {
      useNoteStore.getState().setText('# 还没写完\n')
    })
    fireEvent.click(tabNode('README.md'))
    await waitFor(() => {
      expect(useNoteStore.getState().doc?.relPath).toBe('README.md')
    })

    fireEvent.click(tabNode('项目/设计.md'))
    await waitFor(() => {
      expect(useNoteStore.getState().doc?.relPath).toBe('项目/设计.md')
    })
    expect(useNoteStore.getState().doc?.text).toBe('# 还没写完\n')
  })
})

describe('关闭标签', () => {
  it('关闭当前标签 → 激活相邻项（优先右边）', async () => {
    render(<Harness />)
    await openVault()
    await open('README.md')
    await open('项目/设计.md')
    await open('项目/路线图.md')

    // 把中间的「设计」设为当前，再关掉它 → 应该切到右边的「路线图」
    fireEvent.click(tabNode('项目/设计.md'))
    await waitFor(() => {
      expect(useNoteStore.getState().doc?.relPath).toBe('项目/设计.md')
    })

    fireEvent.click(closeButton('项目/设计.md'))
    await waitFor(() => {
      expect(tabPaths()).toEqual(['README.md', '项目/路线图.md'])
    })
    await waitFor(() => {
      expect(useNoteStore.getState().doc?.relPath).toBe('项目/路线图.md')
    })
    expect(tabNode('项目/路线图.md').getAttribute('aria-selected')).toBe('true')
  })

  it('关闭最后一个位置的当前标签 → 没有右边就激活左边', async () => {
    render(<Harness />)
    await openVault()
    await open('README.md')
    await open('项目/设计.md')

    // 当前是列表最后一项
    fireEvent.click(closeButton('项目/设计.md'))
    await waitFor(() => {
      expect(tabPaths()).toEqual(['README.md'])
    })
    await waitFor(() => {
      expect(useNoteStore.getState().doc?.relPath).toBe('README.md')
    })
  })

  it('关闭非当前标签不影响编辑器里的文档', async () => {
    render(<Harness />)
    await openVault()
    await open('README.md')
    await open('项目/设计.md')

    fireEvent.click(closeButton('README.md'))
    await waitFor(() => {
      expect(tabPaths()).toEqual(['项目/设计.md'])
    })
    expect(useNoteStore.getState().doc?.relPath).toBe('项目/设计.md')
  })

  it('全部关闭 → 回到"没有打开的笔记"空态（主叶标签条消失）', async () => {
    render(<Harness />)
    await openVault()
    await open('README.md')
    await open('项目/设计.md')

    fireEvent.click(closeButton('README.md'))
    fireEvent.click(closeButton('项目/设计.md'))

    await waitFor(() => {
      expect(tabPaths()).toEqual([])
    })
    await waitFor(() => {
      expect(useNoteStore.getState().doc).toBeNull()
    })
    expect(useTabsStore.getState().tabs).toEqual([])
    expect(document.querySelector('[data-leaf-tabs="main"]')).toBeNull()
  })

  it('有未保存内容时关闭要先确认：拒绝 → 标签与内容都还在；确认 → 丢弃修改并激活相邻项', async () => {
    render(<Harness />)
    await openVault()
    await open('README.md')
    await open('项目/设计.md')

    act(() => {
      useNoteStore.getState().setText('# 还没写完\n')
    })
    expect(useNoteStore.getState().dirty).toBe(true)

    fireEvent.click(closeButton('项目/设计.md'))
    await waitFor(() => {
      expect(useConfirmStore.getState().request).not.toBeNull()
    })
    expect(useConfirmStore.getState().request?.title).toContain('关闭')
    expect(useConfirmStore.getState().request?.danger).toBe(true)

    // 拒绝：标签还在，编辑内容一个字都没丢
    act(() => {
      useConfirmStore.getState().respond(false)
    })
    await waitFor(() => {
      expect(useConfirmStore.getState().request).toBeNull()
    })
    expect(tabPaths()).toEqual(['README.md', '项目/设计.md'])
    expect(useNoteStore.getState().doc?.text).toBe('# 还没写完\n')

    // 确认：丢弃修改、关掉标签、切到相邻标签
    fireEvent.click(closeButton('项目/设计.md'))
    await waitFor(() => {
      expect(useConfirmStore.getState().request).not.toBeNull()
    })
    act(() => {
      useConfirmStore.getState().respond(true)
    })
    await waitFor(() => {
      expect(tabPaths()).toEqual(['README.md'])
    })
    await waitFor(() => {
      expect(useNoteStore.getState().doc?.relPath).toBe('README.md')
    })
    // 确认框说的是"丢弃"，那就不能悄悄写回磁盘
    expect(onDisk('项目/设计.md')).not.toBe('# 还没写完\n')
  })

  it('列表被剪过（当前文档不在标签里）时命令仍然关得掉，而不是按下去没反应', async () => {
    render(<Harness />)
    await openVault()
    await open('README.md')

    // 模拟条目表被外部改掉：标签被剪掉，但编辑器里的文档还在
    act(() => {
      useVaultStore.setState({ entries: [] })
    })
    expect(tabPaths()).toEqual([])

    await act(async () => {
      await useTabsStore.getState().closeCurrent()
    })
    expect(useNoteStore.getState().doc).toBeNull()
  })

  it('命令背后的动作：closeCurrent / cycle / activateIndex', async () => {
    render(<Harness />)
    await openVault()
    await open('README.md')
    await open('项目/设计.md')
    await open('项目/路线图.md')

    // Mod+W：关闭当前（路线图）→ 激活左边的设计
    await act(async () => {
      await useTabsStore.getState().closeCurrent()
    })
    expect(tabPaths()).toEqual(['README.md', '项目/设计.md'])
    expect(useNoteStore.getState().doc?.relPath).toBe('项目/设计.md')

    // Mod+Alt+←/→：循环切换（从设计往后 → README）
    await act(async () => {
      await useTabsStore.getState().cycle(1)
    })
    expect(useNoteStore.getState().doc?.relPath).toBe('README.md')
    await act(async () => {
      await useTabsStore.getState().cycle(-1)
    })
    expect(useNoteStore.getState().doc?.relPath).toBe('项目/设计.md')

    // Ctrl+1..9：跳到第 N 个（越界是空操作）
    await act(async () => {
      await useTabsStore.getState().activateIndex(0)
    })
    expect(useNoteStore.getState().doc?.relPath).toBe('README.md')
    await act(async () => {
      expect(await useTabsStore.getState().activateIndex(9)).toBe(false)
    })
    expect(useNoteStore.getState().doc?.relPath).toBe('README.md')

    // 标签数 < 2 时循环切换什么都不做（命令的 when 条件之外再兜一层）
    await act(async () => {
      await useTabsStore.getState().closeCurrent()
    })
    expect(tabPaths()).toEqual(['项目/设计.md'])
    await act(async () => {
      expect(await useTabsStore.getState().cycle(1)).toBe(false)
    })
    expect(useNoteStore.getState().doc?.relPath).toBe('项目/设计.md')
  })

  it('命令表把 Ctrl+1..9 接到 activateIndex，并按标签数置灰', async () => {
    const dispose = registerBuiltinCommands()
    try {
      render(<Harness />)
      await openVault()
      await open('README.md')
      await open('项目/设计.md')

      // 注册表才是快捷键的唯一事实来源：按下去必须真的切标签，
      // 而不是"store 里有个没人调的方法"
      const third = commands.byChord('Mod+3')[0]
      expect(third?.id).toBe('tabs.activate3')
      expect(commands.byChord('Mod+2')[0]?.id).toBe('tabs.activate2')

      await act(async () => {
        await commands.execute('tabs.activate2')
      })
      expect(useNoteStore.getState().doc?.relPath).toBe('项目/设计.md')

      // 只有两个标签时第 3 条必须不可执行（命令面板会显示原因，而不是按下去没反应）
      expect(third?.when?.()).toBe(false)
      expect(await commands.execute('tabs.activate3')).toBe(false)
      expect(useNoteStore.getState().doc?.relPath).toBe('项目/设计.md')
    } finally {
      dispose()
    }
  })
})

describe('持久化（按 Vault 根）', () => {
  it('重新挂载后从 localStorage 恢复同一个 Vault 的标签列表与激活项', async () => {
    const first = render(<Harness />)
    await openVault()
    await open('README.md')
    await open('项目/设计.md')

    // 落盘了一份"按 Vault 根"的列表
    expect(loadTabsFor(MOCK_VAULT_PATH)).toEqual({
      tabs: ['README.md', '项目/设计.md'],
      active: '项目/设计.md',
    })

    // 模拟重启：卸载组件 + 清空内存状态，但保留 localStorage
    first.unmount()
    resetStores()

    render(<Harness />)
    await openVault()

    expect(tabPaths()).toEqual(['README.md', '项目/设计.md'])
    // 上次激活的那篇会被重新打开（"回到上次的工作现场"）
    await waitFor(() => {
      expect(useNoteStore.getState().doc?.relPath).toBe('项目/设计.md')
    })
    expect(tabNode('项目/设计.md').getAttribute('aria-selected')).toBe('true')
  })

  it('换 Vault 清空标签（旧根的列表还在，切回去仍能恢复）', async () => {
    const OTHER_VAULT = 'D:\\另一个Vault'
    render(<Harness />)
    await openVault()
    await open('README.md')
    await open('项目/设计.md')

    // 换到另一个 Vault：条目表也换成新根的那份
    setIpcAdapter(createMockAdapter({ rootPath: OTHER_VAULT }))
    await openVault(OTHER_VAULT)

    expect(useVaultStore.getState().info?.rootPath).toBe(OTHER_VAULT)
    expect(useTabsStore.getState().tabs).toEqual([])
    expect(tabPaths()).toEqual([])
    // 上一篇笔记属于旧根，不能留着（否则下一次保存会写进新 Vault 的同名路径）
    expect(useNoteStore.getState().doc).toBeNull()
    // 旧根的列表没被删掉
    expect(loadTabsFor(MOCK_VAULT_PATH).tabs).toEqual(['README.md', '项目/设计.md'])

    // 切回原来的 Vault：列表恢复
    setIpcAdapter(createMockAdapter())
    await openVault(MOCK_VAULT_PATH)
    expect(useTabsStore.getState().tabs).toEqual(['README.md', '项目/设计.md'])
  })

  it('恢复时静默丢弃已经不存在的路径（含失效的激活项）', async () => {
    persistTabsFor(
      MOCK_VAULT_PATH,
      ['README.md', '已经不存在的笔记.md'],
      '已经不存在的笔记.md',
    )

    render(<Harness />)
    await openVault()

    expect(tabPaths()).toEqual(['README.md'])
    // 给一拍时间：失效的激活项不该被自动打开
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(useNoteStore.getState().doc).toBeNull()
    // 剪枝后的列表写回磁盘，避免陈旧数据长期堆积
    expect(loadTabsFor(MOCK_VAULT_PATH)).toEqual({ tabs: ['README.md'], active: null })
  })

  it('删除条目表里的笔记后，指向它的标签被剪掉（不留点开就报错的死标签）', async () => {
    render(<Harness />)
    await openVault()
    await open('README.md')
    await open('项目/设计.md')

    // 模拟外部删除（deleteSelected 会更新条目表；这里只验证标签的对账）
    const entries = useVaultStore
      .getState()
      .entries.filter((entry) => entry.relPath !== '项目/设计.md')
    act(() => {
      useVaultStore.setState({ entries })
    })

    expect(useTabsStore.getState().tabs).toEqual(['README.md'])
  })
})

describe('DOM / 可访问性契约', () => {
  it('tablist + tab + aria-selected + roving tabindex', async () => {
    render(<Harness />)
    await openVault()
    await open('README.md')
    await open('项目/设计.md')

    // 每格一条标签条（容器切割树）：主叶那条里是两个笔记标签
    const strips = screen.getAllByRole('tablist')
    expect(strips.length).toBeGreaterThan(0)
    expect(screen.getAllByRole('tab').length).toBeGreaterThanOrEqual(2)
    // roving tabindex：Tab 键只落在"那一格正在显示"的标签上，其余为 -1
    expect(tabNode('项目/设计.md').getAttribute('tabindex')).toBe('0')
    expect(tabNode('README.md').getAttribute('tabindex')).toBe('-1')
    // 未保存时标签的无障碍名里带提示，避免"看着一样却少了内容"
    act(() => {
      useNoteStore.getState().setText('# 改了\n')
    })
    expect(tabNode('项目/设计.md').getAttribute('aria-label')).toBe('项目/设计.md（未保存）')
    expect(tabNode('项目/设计.md').textContent).toContain('●')
  })

  it('Delete / Backspace 不会误关标签；中键可以关', async () => {
    render(<Harness />)
    await openVault()
    await open('README.md')
    await open('项目/设计.md')

    fireEvent.keyDown(tabNode('项目/设计.md'), { key: 'Delete' })
    fireEvent.keyDown(tabNode('项目/设计.md'), { key: 'Backspace' })
    expect(tabPaths()).toEqual(['README.md', '项目/设计.md'])
    // 没有被"误关"，也没有弹确认框
    expect(useConfirmStore.getState().request).toBeNull()

    // 中键关闭（jsdom 的 fireEvent 没有 auxClick 快捷方法，直接派发原生事件）
    fireEvent(tabNode('项目/设计.md'), new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    await waitFor(() => {
      expect(tabPaths()).toEqual(['README.md'])
    })
  })

  it('方向键在标签之间移动焦点并切换', async () => {
    render(<Harness />)
    await openVault()
    await open('README.md')
    await open('项目/设计.md')

    const active = tabNode('项目/设计.md')
    active.focus()
    fireEvent.keyDown(active, { key: 'ArrowLeft' })

    await waitFor(() => {
      expect(useNoteStore.getState().doc?.relPath).toBe('README.md')
    })
    expect(document.activeElement).toBe(tabNode('README.md'))
  })
})

describe('布局与样式契约（E2E 的高度断言不能因此变化）', () => {
  const tabsCss = readTabsCss()

  it('标签条不再动主区域的布局方向，也没有全局标签栏时代的残留规则', () => {
    /*
      这条契约**改过两次**，原因都写下来免得后人以为测试写错了：
      1. 标签栏原来挂在 `.mn-main` 里，靠 `.mn-main:has(> .mn-tabs)` 把主区域改成列方向；
         搬到窗口顶部之后那条规则删掉了；
      2. 容器切割树（ADR-0035）之后标签住进每格自己的标签条，全局标签栏退役 ——
         顶行拖动 filler（`.mn-tabs__filler`）也随之删掉。
      断言的是"规则不存在"，不是"这段文字不存在"：注释里仍会提到旧写法（给后人看的来龙去脉）。
    */
    expect(tabsCss).not.toMatch(/\.mn-main:has\(> \.mn-tabs\)\s*\{/)
    expect(tabsCss).not.toMatch(/\.mn-tabs__filler\s*\{/)
    // 仍然不改公共样式表里的类（这里不该出现 .mn-body 的规则）
    expect(tabsCss).not.toContain('.mn-body {')
  })

  it('标签过多时横向滚动，而不是被压扁', () => {
    expect(tabsCss).toContain('overflow-x: auto')
    expect(tabsCss).toContain('min-width: 104px')
    expect(tabsCss).toContain('flex: 0 0 auto')
  })

  it('颜色 / 圆角只走 --mn-* 变量', () => {
    const declarations = tabsCss.match(/(color|background|border[\w-]*|border-radius|box-shadow):[^;]+;/g) ?? []
    expect(declarations.length).toBeGreaterThan(5)
    for (const declaration of declarations) {
      if (declaration.includes('transparent')) continue
      if (declaration.includes('none')) continue
      if (declaration.startsWith('border-radius')) {
        expect(declaration).toMatch(/var\(--mn-radius\)/)
        continue
      }
      expect(declaration).toMatch(/var\(--mn-/)
    }
  })
})

/**
 * 直接从磁盘读样式表（不用 `import '...css?raw'`：vitest 默认不处理 CSS 导入，
 * 拿到的可能是空串，会让契约断言"永远通过"——比没有测试更糟）。
 */
function readTabsCss(): string {
  const candidates = [
    resolve(process.cwd(), 'src/features/tabs/tabs.css'),
    resolve(process.cwd(), 'apps/desktop/src/features/tabs/tabs.css'),
  ]
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, 'utf8')
    } catch {
      // 换下一个候选路径
    }
  }
  throw new Error(`找不到 tabs.css（尝试过：${candidates.join('、')}）`)
}

describe('光标位置记忆（可选增强，行为通过注入的适配器验证）', () => {
  it('切走前 capture 旧文档，新文档载入后 restore —— 组件不碰 CodeMirror', async () => {
    render(<Harness />)
    await openVault()
    await open('README.md')

    // 组件挂载时注册的是真实实现；这里换成探针，验证"时机"这一契约
    const capture = vi.fn()
    const restore = vi.fn()
    setCaretMemory({ capture, restore })

    await act(async () => {
      await useTabsStore.getState().activate('项目/设计.md')
    })

    expect(capture).toHaveBeenCalledWith('README.md')
    expect(restore).toHaveBeenCalledWith('项目/设计.md')
  })

  it('已经是当前标签时不做任何多余动作（不重新读盘、不动光标）', async () => {
    render(<Harness />)
    await openVault()
    await open('README.md')

    const capture = vi.fn()
    const restore = vi.fn()
    setCaretMemory({ capture, restore })

    await act(async () => {
      expect(await useTabsStore.getState().activate('README.md')).toBe(true)
    })
    expect(tabPaths()).toEqual(['README.md'])
    expect(capture).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
  })
})

/**
 * 接线形态 + 真实编辑器。
 *
 * 这一组用**真实 CodeMirror**（而不是直接 `setText`）跑，并直接挂真实的 `TreeHost` ——
 * 它同时是接线说明书：标签条住在**每个叶子格子自己的顶部**（ADR-0035 的容器切割树），
 * 主视图渲染在"当前文档所在的那一格"里；挂错容器（例如又造一条全局标签栏）
 * 会让这里的结构与真实应用不一致。
 */
describe('接线形态与真实编辑器', () => {
  /** 与 App.tsx 一致：全局键map + 容器切割树。 */
  function Shell() {
    useGlobalKeymap()
    return (
      <>
        <TreeHost />
        <ConfirmDialog />
      </>
    )
  }

  function currentView(): EditorView {
    const host = document.querySelector<HTMLElement>('.cm-editor')
    expect(host).not.toBeNull()
    const view = host === null ? null : EditorView.findFromDOM(host)
    expect(view).not.toBeNull()
    if (view === null) throw new Error('编辑器实例没有创建')
    return view
  }

  it('标签条与编辑器在同一格里共存：编辑器里改动 → 切标签 → 内容真的落盘', async () => {
    render(<Shell />)
    await openVault()
    // 没有笔记标签时主叶没有标签条（主视图的空文档态仍然在）
    expect(document.querySelector('[data-leaf-tabs="main"]')).toBeNull()

    await open('README.md')
    await open('项目/设计.md')
    // 标签条在主叶里，编辑器那一面（.mn-pane--editor）也在主叶里
    const mainLeaf = document.querySelector('[data-leaf-id="main"]')
    expect(mainLeaf?.querySelector('.mn-tabs')).not.toBeNull()
    expect(mainLeaf?.querySelector('.mn-pane--editor')).not.toBeNull()
    // 全局标签栏退役：标题栏里不该再有标签条
    expect(document.querySelector('.mn-titlebar .mn-tabs')).toBeNull()

    const view = currentView()
    act(() => {
      view.dispatch({ changes: { from: 0, insert: '# 编辑过\n' } })
    })
    expect(useNoteStore.getState().dirty).toBe(true)

    fireEvent.click(tabNode('README.md'))
    await waitFor(() => {
      expect(useNoteStore.getState().doc?.relPath).toBe('README.md')
    })
    // 编辑器走的是 updateListener → setText，切走时由 openNote 落盘
    expect(onDisk('项目/设计.md')).toContain('# 编辑过')
  })

  it('真实编辑器：切走再切回，光标与滚动位置被恢复', async () => {
    render(<Shell />)
    await openVault()
    await open('README.md')
    await open('项目/设计.md')

    const view = currentView()
    act(() => {
      view.dispatch({ selection: { anchor: 5 }, scrollIntoView: false })
    })
    act(() => {
      view.scrollDOM.scrollTop = 42
    })

    await act(async () => {
      await useTabsStore.getState().activate('README.md')
    })
    await act(async () => {
      await useTabsStore.getState().activate('项目/设计.md')
    })

    // restore 用 rAF 等编辑器把新文档写进去之后再落地，所以这里等一拍
    await waitFor(() => {
      expect(view.state.selection.main.anchor).toBe(5)
    })
    expect(view.scrollDOM.scrollTop).toBe(42)
  })

  it('命令接线（Mod+W / Mod+Alt+←→）能把按键送到标签动作上，编辑器里也生效', async () => {
    // 直接装**真实的**命令表：手抄一份映射会让"命令表改了但测试还在测旧映射"永远发现不了
    const dispose = registerBuiltinCommands()

    try {
      render(<Shell />)
      await openVault()
      await open('README.md')
      await open('项目/设计.md')
      await open('项目/路线图.md')

      // 下一个（右）/ 上一个（左）
      fireEvent.keyDown(window, { key: 'ArrowLeft', ctrlKey: true, altKey: true })
      await waitFor(() => {
        expect(useNoteStore.getState().doc?.relPath).toBe('项目/设计.md')
      })
      fireEvent.keyDown(window, { key: 'ArrowRight', ctrlKey: true, altKey: true })
      await waitFor(() => {
        expect(useNoteStore.getState().doc?.relPath).toBe('项目/路线图.md')
      })

      // 关闭当前（路线图）→ 激活相邻的左边（设计）
      fireEvent.keyDown(window, { key: 'w', ctrlKey: true })
      await waitFor(() => {
        expect(useNoteStore.getState().doc?.relPath).toBe('项目/设计.md')
      })
      expect(tabPaths()).toEqual(['README.md', '项目/设计.md'])

      // 编辑器里按 Mod+W 也要生效（CodeMirror 不占用这个键）
      currentView().contentDOM.focus()
      fireEvent.keyDown(document.querySelector('.cm-content') as HTMLElement, {
        key: 'w',
        ctrlKey: true,
      })
      await waitFor(() => {
        expect(tabPaths()).toEqual(['README.md'])
      })
      expect(useNoteStore.getState().doc?.relPath).toBe('README.md')
    } finally {
      dispose()
    }
  })
})
