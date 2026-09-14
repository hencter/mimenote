// @vitest-environment jsdom
/**
 * 命令面板 / 快速切换（M2）。
 *
 * 覆盖：打开/关闭、过滤与空态、键盘选择与执行、打开笔记、未打开 Vault 的降级、
 * 焦点归还、以及"Esc 不冒泡给全局快捷键""编辑器聚焦时 Ctrl+K 仍能打开"两条
 * 容易回归的约束。
 *
 * 断言尽量落在**可观测的副作用**上（store 状态、DOM 结构），而不是实现细节：
 * 这里换实现（比如把匹配换成别的算法）不该让测试变红。
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '@/App'
import { openNote } from '@/app/actions'
import { registerBuiltinCommands } from '@/app/builtin-commands'
import { commands } from '@/app/commands'
import { isMarkdown } from '@/domain/paths'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import { useNoteStore } from '@/state/note-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

/** 按下 `Mod+<key>`（Windows/Linux = Ctrl）。`fireEvent` 自带 act 包裹。 */
function pressMod(key: string, target: Document | Element | Window = document.body): void {
  fireEvent.keyDown(target, { key, ctrlKey: true })
}

/** 派发一个"真实"的 Esc（返回事件对象，便于断言 preventDefault / 是否冒泡）。 */
function pressEscape(target: Element): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

async function openVault(): Promise<void> {
  await act(async () => {
    await useVaultStore.getState().openVault('C:\\MockVault')
  })
}

beforeEach(() => {
  setIpcAdapter(createMockAdapter())
  registerBuiltinCommands()
  window.localStorage.clear()
  useNoteStore.getState().close()
  useUiStore.setState({ paletteMode: null, linksPanelVisible: false, viewMode: 'edit' })
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
})

afterEach(() => {
  cleanup()
})

describe('命令面板', () => {
  it('Ctrl+K 打开、列出全部命令（名称 + 分组 + 快捷键）、Esc 关闭', async () => {
    render(<App />)

    pressMod('k')
    const dialog = await screen.findByRole('dialog', { name: '命令面板' })
    const input = within(dialog).getByRole('textbox')
    expect(document.activeElement).toBe(input)

    // 命令注册表就是数据源：不同分组、不同快捷键的命令都在
    expect(within(dialog).getByText('切换主题')).toBeTruthy()
    expect(within(dialog).getByText('打开 Vault…')).toBeTruthy()
    // 分组名：同一分类下的多条命令都会显示它
    expect(within(dialog).getAllByText('外观').length).toBeGreaterThan(0)
    // 快捷键提示按平台格式化（jsdom 不是 macOS → Mod 显示为 Ctrl）
    expect(within(dialog).getByText('Ctrl+Alt+T')).toBeTruthy()

    const escape = pressEscape(input)
    // 必须是"被吃掉"的事件：否则会漏给 app/keymap.ts 的全局快捷键
    expect(escape.defaultPrevented).toBe(true)
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })

  it('输入即模糊过滤（子序列匹配，命中字符高亮），无匹配时显示空态', async () => {
    render(<App />)
    pressMod('k')
    const dialog = await screen.findByRole('dialog', { name: '命令面板' })
    const input = within(dialog).getByRole('textbox')

    fireEvent.change(input, { target: { value: '主题' } })
    await waitFor(() => {
      expect(within(dialog).getAllByRole('option')).toHaveLength(1)
    })
    expect(within(dialog).getByRole('option').textContent).toContain('切换主题')

    // 命中字符要被高亮（连续命中合并成一段 <mark>）
    const marks = Array.from(dialog.querySelectorAll('mark.mn-palette__hit'))
    expect(marks.map((mark) => mark.textContent).join('')).toBe('主题')

    // 子序列匹配：'切主' 不是任何标题的子串，但仍然命中「切换主题」
    fireEvent.change(input, { target: { value: '切主' } })
    await waitFor(() => {
      expect(within(dialog).getByRole('option').textContent).toContain('切换主题')
    })

    fireEvent.change(input, { target: { value: 'zzz-不存在的命令' } })
    await waitFor(() => {
      expect(within(dialog).queryAllByRole('option')).toHaveLength(0)
    })
    expect(within(dialog).getByText('没有匹配的命令')).toBeTruthy()
  })

  it('↓ 选中下一条、Enter 执行并关闭面板（用视图状态变化验证真的执行了）', async () => {
    render(<App />)
    pressMod('k')
    const dialog = await screen.findByRole('dialog', { name: '命令面板' })
    const input = within(dialog).getByRole('textbox')

    fireEvent.change(input, { target: { value: '隐藏' } })
    const options = await waitFor(() => {
      const list = within(dialog).getAllByRole('option')
      expect(list).toHaveLength(5)
      return list
    })
    // 五条含「隐藏」的命令（侧栏 / 链接面板 / 标签面板 / 大纲面板 / 编辑器：显示·隐藏行号）。
    // 顺序由匹配分数决定，因此这里**只断言集合对得上**，再按标题定位"链接面板"那一条：
    // 加同类命令时受影响的只有上面那个数量，行为断（↓ 走过去 + Enter 执行）与名次无关。
    const labels = options.map((node) => node.textContent ?? '')
    for (const expected of ['侧栏', '链接面板', '标签面板', '大纲面板', '行号']) {
      expect(labels.some((text) => text.includes(expected))).toBe(true)
    }
    const linksIndex = labels.findIndex((text) => text.includes('链接面板'))
    expect(linksIndex).toBeGreaterThanOrEqual(0)
    expect(options[0]?.getAttribute('aria-selected')).toBe('true')
    expect(input.getAttribute('aria-activedescendant')).toBe('mn-palette-option-0')

    // 一路 ↓ 走到"链接面板"那一条
    for (let step = 0; step < linksIndex; step += 1) {
      fireEvent.keyDown(input, { key: 'ArrowDown' })
    }
    await waitFor(() => {
      expect(
        document.getElementById(`mn-palette-option-${linksIndex}`)?.getAttribute('aria-selected'),
      ).toBe('true')
    })
    // 焦点不离开输入框：高亮通过 aria-activedescendant 表达
    expect(input.getAttribute('aria-activedescendant')).toBe(`mn-palette-option-${linksIndex}`)

    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    expect(useUiStore.getState().linksPanelVisible).toBe(true)
  })

  it('鼠标点击也能执行命令', async () => {
    render(<App />)
    pressMod('k')
    const dialog = await screen.findByRole('dialog', { name: '命令面板' })
    const input = within(dialog).getByRole('textbox')

    fireEvent.change(input, { target: { value: '侧栏' } })
    const option = await waitFor(() => {
      const found = within(dialog).getByRole('option')
      expect(found.textContent).toContain('显示 / 隐藏侧栏')
      return found
    })
    expect(useUiStore.getState().sidebarVisible).toBe(true)

    fireEvent.click(option)
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    expect(useUiStore.getState().sidebarVisible).toBe(false)
  })

  it('置灰的命令点不动，也不关面板', async () => {
    render(<App />)
    pressMod('k')
    const dialog = await screen.findByRole('dialog', { name: '命令面板' })

    const rescan = dialog.querySelector('[data-palette-id="vault.rescan"]')
    expect(rescan).not.toBeNull()
    expect(rescan?.getAttribute('aria-disabled')).toBe('true')
    expect(rescan?.textContent).toContain('需要先打开 Vault')

    fireEvent.click(rescan as Element)
    expect(screen.queryByRole('dialog')).not.toBeNull()
  })
})

describe('快速切换', () => {
  it('Ctrl+P 只列 Markdown 笔记，过滤后 Enter 真的打开了那篇笔记', async () => {
    render(<App />)
    await openVault()

    pressMod('p')
    const dialog = await screen.findByRole('dialog', { name: '快速切换笔记' })

    // 只列笔记：目录与 .txt 附件都不出现（条目表 12 条 → 笔记 7 篇）
    const expectedNotes = useVaultStore
      .getState()
      .entries.filter((entry) => !entry.isDir && isMarkdown(entry.relPath))
    expect(within(dialog).getAllByRole('option')).toHaveLength(expectedNotes.length)

    const input = within(dialog).getByRole('textbox')
    fireEvent.change(input, { target: { value: '设计' } })
    const option = await waitFor(() => {
      const found = within(dialog).getByRole('option')
      expect(found.getAttribute('data-rel-path')).toBe('项目/设计.md')
      return found
    })
    // 相对路径上要有高亮
    expect(option.querySelectorAll('mark.mn-palette__hit').length).toBeGreaterThan(0)

    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(useNoteStore.getState().doc?.relPath).toBe('项目/设计.md')
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    // 走的是既有打开动作：文件树选中项也跟着走（不是自己 invoke IPC 的旁路）
    expect(useVaultStore.getState().selected).toBe('项目/设计.md')
  })

  it('未打开 Vault 时显示空态提示（而不是空白面板或毫无反应）', async () => {
    render(<App />)

    pressMod('p')
    const dialog = await screen.findByRole('dialog', { name: '快速切换笔记' })
    expect(within(dialog).getByText(/还没有打开 Vault/)).toBeTruthy()
    expect(within(dialog).queryAllByRole('option')).toHaveLength(0)
  })

  it('结果超过上限时只渲染前 50 条，并提示还有多少条未显示', async () => {
    // 用仓库既有的 Mock 适配器造一个"多到需要裁剪"的 Vault（不用 1 万条：
    // 这里测的是"只渲染前 N 条 + 报总数"这个契约，不是扫描性能）
    const notes = Array.from({ length: 60 }, (_, index) => ({
      relPath: `批量/笔记-${index}.md`,
      text: `# 笔记 ${index}\n`,
    }))
    setIpcAdapter(createMockAdapter({ notes }))
    render(<App />)
    await openVault()

    pressMod('p')
    const dialog = await screen.findByRole('dialog', { name: '快速切换笔记' })
    expect(within(dialog).getAllByRole('option')).toHaveLength(50)
    expect(within(dialog).getByText(/还有 10 条未显示/)).toBeTruthy()
  })
})

describe('焦点与键盘边界', () => {
  it('关闭面板后把焦点归还给打开前的元素', async () => {
    render(<App />)
    await openVault()

    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="链接面板"]')
    expect(trigger).not.toBeNull()
    trigger?.focus()
    expect(document.activeElement).toBe(trigger)

    pressMod('k')
    const dialog = await screen.findByRole('dialog', { name: '命令面板' })
    const input = within(dialog).getByRole('textbox')
    await waitFor(() => {
      expect(document.activeElement).toBe(input)
    })

    pressEscape(input)
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    expect(document.activeElement).toBe(trigger)
  })

  it('面板打开时 Esc 不冒泡给全局快捷键', async () => {
    const run = vi.fn()
    const dispose = commands.register({
      id: 'test.escape',
      title: '测试 Esc 命令',
      category: '测试',
      keybinding: 'Escape',
      run,
    })
    try {
      render(<App />)
      pressMod('k')
      const dialog = await screen.findByRole('dialog', { name: '命令面板' })

      // 派发到面板容器（而不是输入框）：全局快捷键只对"非输入元素"生效，
      // 这才是真正会漏的场景
      pressEscape(dialog)
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull()
      })
      expect(run).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })

  it('编辑器聚焦时 Ctrl+K 仍能打开面板，且不触发 CodeMirror 的 Ctrl+K（删除到行尾）', async () => {
    render(<App />)
    await openVault()
    await act(async () => {
      await openNote('README.md')
    })

    const content = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('.cm-content')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    const before = useNoteStore.getState().doc?.text ?? ''
    // jsdom 对 contenteditable 的焦点支持有限，这里不依赖焦点是否真的落在编辑器上：
    // 关键是事件的目标节点在编辑器内部（CodeMirror 的快捷键监听就装在这个节点上）
    content.focus()

    pressMod('k', content)
    await screen.findByRole('dialog', { name: '命令面板' })
    expect(useNoteStore.getState().doc?.text).toBe(before)
  })
})
