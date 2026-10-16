// @vitest-environment jsdom
/**
 * 命令面板 / 快速切换 / 全文搜索高亮（M2、ADR-0059）。
 *
 * 覆盖：打开/关闭、过滤与空态、键盘选择与执行、打开笔记、未打开 Vault 的降级、
 * 焦点归还、"Esc 不冒泡给全局快捷键""编辑器聚焦时 Ctrl+Shift+P 仍能打开"两条
 * 容易回归的约束，以及全文搜索**高亮**的两条口径（逐词展开、跟随 `settledQuery`）。
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
import {
  MAX_PALETTE_RESULTS,
  searchHighlightIndices,
  searchHighlightTerms,
} from '@/features/palette/match'
import { setIpcAdapter, type IpcAdapter } from '@/ipc/client'
import { createMockAdapter, type MockAdapter } from '@/ipc/mock-adapter'
import type { SearchResult } from '@/ipc/types'
import { useNoteStore } from '@/state/note-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

/** 按下 `Mod+<key>`（Windows/Linux = Ctrl）。`fireEvent` 自带 act 包裹。 */
function pressMod(key: string, target: Document | Element | Window = document.body): void {
  fireEvent.keyDown(target, { key, ctrlKey: true })
}

/**
 * 按下命令面板的呼出键（`Mod+Shift+P`）。
 *
 * ADR-0055 把命令面板从 `Mod+K` 挪到 `Mod+Shift+P`（`Mod+K` 归还给"插入链接"），
 * 于是这个动作在所有用例里都要走同一个 helper —— 将来再改键位只改这一行。
 */
function pressPalette(target: Document | Element | Window = document.body): void {
  fireEvent.keyDown(target, { key: 'p', ctrlKey: true, shiftKey: true })
}

/** 派发一个"真实"的 Esc（返回事件对象，便于断言 preventDefault / 是否冒泡）。 */
function pressEscape(target: Element): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

/** 派发 `Mod+Shift+<key>`（Windows/Linux = Ctrl）。`fireEvent` 自带 act 包裹。 */
function pressModShift(key: string, target: Document | Element | Window = document.body): void {
  fireEvent.keyDown(target, { key, ctrlKey: true, shiftKey: true })
}

/** 打开全文搜索面板（`Mod+Shift+F`）。 */
async function openSearchPanel(): Promise<{ dialog: HTMLElement; input: HTMLInputElement }> {
  pressModShift('f')
  const dialog = await screen.findByRole('dialog', { name: '全文搜索' })
  return { dialog, input: within(dialog).getByRole<HTMLInputElement>('textbox') }
}

/**
 * 让 `search_query` 悬停不返回，直到测试显式 settle。
 *
 * 与 `search.test.tsx` 的同名助手同一形状（那边用它造竞态与取消）。这里要的是
 * "请求在途、列表里还挂着上一次结果"这个窗口 —— 那是唯一能区分
 * "用产生结果的那次查询高亮"与"用输入框当前串高亮"的时刻。
 */
function deferredSearch(base: MockAdapter): {
  adapter: IpcAdapter
  pending: Array<{ query: string; settle: (outcome: SearchResult) => void }>
} {
  const pending: Array<{ query: string; settle: (outcome: SearchResult) => void }> = []
  const adapter: IpcAdapter = {
    kind: 'test',
    async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
      if (method !== 'search_query') return base.invoke<T>(method, args)
      return new Promise<T>((resolve) => {
        pending.push({
          query: String(args?.query ?? ''),
          settle: (outcome) => resolve(outcome as unknown as T),
        })
      })
    },
  }
  return { adapter, pending }
}

/**
 * 把下标数组还原成**被高亮的文字段**（连续下标合并成一段）。
 *
 * 断言落在"哪几段文字被标了"上，而不是"下标数组长什么样"：后者是实现细节，
 * 前者才是用户看得见的东西（也与 `CommandPalette` 的 `<Highlighted>` 同一套合并规则）。
 */
function markedRuns(text: string, indices: readonly number[]): string[] {
  const runs: string[] = []
  let start = -1
  let end = -2
  for (const index of indices) {
    if (start === -1) {
      start = index
      end = index
      continue
    }
    if (index === end + 1) {
      end = index
      continue
    }
    runs.push(text.slice(start, end + 1))
    start = index
    end = index
  }
  if (start !== -1) runs.push(text.slice(start, end + 1))
  return runs
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
  useNoteStore.getState().closeAll()
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
  it('Ctrl+Shift+P 打开、列出全部命令（名称 + 分组 + 快捷键）、Esc 关闭', async () => {
    render(<App />)

    pressPalette()
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
    pressPalette()
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
    pressPalette()
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
    pressPalette()
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
    pressPalette()
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

    pressPalette()
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
      pressPalette()
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

  it('编辑器聚焦时 Ctrl+Shift+P 仍能打开面板，且不触发 CodeMirror 的同类按键', async () => {
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

    pressPalette(content)
    await screen.findByRole('dialog', { name: '命令面板' })
    expect(useNoteStore.getState().doc?.text).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// 全文搜索高亮（ADR-0059）：纯函数口径 + 面板的 settledQuery 接线
// ---------------------------------------------------------------------------

describe('全文搜索高亮（纯函数口径）', () => {
  it('多词查询逐词展开：`天气 代码` 在同一片段里标出两处', () => {
    // 防的回归：旧实现把**整串**查询丢给 `indexOf`，而片段里几乎不可能出现连续的
    // "天气 代码" → 多词查询一个 `<mark>` 都没有，看起来像"搜到了却不知道命中在哪"。
    // 宿主的语义是逐词 AND（每个词各自匹配），高亮必须同口径。
    const snippet = '今天的天气不错，顺便写点代码'
    const indices = searchHighlightIndices(snippet, '天气 代码')

    expect(markedRuns(snippet, indices)).toEqual(['天气', '代码'])
    // `Highlighted` 靠"升序且不重复"才能把相邻下标合并成一个 mark：这里把它当契约钉住
    expect([...indices]).toEqual([...indices].sort((a, b) => a - b))
    expect(new Set(indices).size).toBe(indices.length)
  })

  it('大小写不敏感：`hello WORLD` 能标到 `Hello World` 的两处', () => {
    // 宿主用 `unicode61` 做大小写折叠，前端高亮必须跟着折叠，否则英文查询等于没有高亮。
    const snippet = 'Hello World'
    expect(markedRuns(snippet, searchHighlightIndices(snippet, 'hello WORLD'))).toEqual([
      'Hello',
      'World',
    ])
  })

  it('会改变长度的大小写折叠退回大小写敏感匹配，且下标永远不越界', () => {
    // 防的回归：'İ'（U+0130）的 `toLowerCase()` 是 'i̇'（**两个**码元），小写串与原文
    // 不再 1:1 对齐。如果照旧在小写串上算下标、再拿它去切原文，`<mark>` 会标在错误位置
    // （甚至切到字符串外面）。这里的口径是"宁可不命中，也不标错位置"。
    const text = 'İx'
    expect(searchHighlightIndices(text, 'X')).toEqual([])

    // 非 BMP 字符（代理对）必须整体对待：下标是码元下标，命中区间不能把代理对切一半，
    // 否则渲染出来的 <mark> 里会是一个孤立的高位代理（显示成 �）
    const emoji = '天气😀代码'
    const indices = searchHighlightIndices(emoji, '代码')
    expect(markedRuns(emoji, indices)).toEqual(['代码'])
    for (const index of indices) {
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(emoji.length)
    }
  })

  it('超过 16 个词只取前 16 个；标点 / emoji 这类不含字母数字的词被丢掉', () => {
    // 与宿主的 `MAX_QUERY_TERMS`（16）同口径：宿主根本不会拿第 17 个词去匹配，
    // 高亮器也不该为它多扫一遍片段（一次 `indexOf` 就是一趟 O(L)）。
    const terms = searchHighlightTerms(Array.from({ length: 20 }, (_, i) => `w${i}`).join(' '))
    expect(terms).toHaveLength(16)
    expect(terms[0]).toBe('w0')
    expect(terms[15]).toBe('w15')

    // 空查询 / 纯标点 / 纯 emoji 在宿主那边也不查库（`build_match_query` 返回 None），
    // 前端不该凭空造出高亮
    expect(searchHighlightTerms('((( 😀 天气')).toEqual(['天气'])
    expect(searchHighlightTerms('   ')).toEqual([])
    expect(searchHighlightIndices('任意文本', '')).toEqual([])
  })
})

describe('全文搜索高亮（面板接线）', () => {
  it('在途查询期间，旧结果仍按产生它的那次查询（settledQuery）高亮', async () => {
    // 防的回归：高亮曾经读的是输入框里的**当前**串。防抖 + 竞态丢弃保证旧结果不会被
    // 新响应覆盖，但旧结果在新查询在途期间仍留在列表里 —— 用新词去标旧片段，轻则
    // 一个 mark 都没有，重则把新词的偶发出现标在旧结果上。正确口径是 settledQuery。
    const notes = [{ relPath: '日记/天气.md', text: '今天天气不错\n' }]
    const base = createMockAdapter({ notes })
    const { adapter, pending } = deferredSearch(base)
    setIpcAdapter(adapter)
    render(<App />)
    await openVault()

    const { dialog, input } = await openSearchPanel()
    fireEvent.change(input, { target: { value: '天气' } })
    await waitFor(() => {
      expect(pending).toHaveLength(1)
    })
    await act(async () => {
      pending[0]?.settle(
        await base.invoke<SearchResult>('search_query', {
          query: '天气',
          limit: MAX_PALETTE_RESULTS,
        }),
      )
    })
    await waitFor(() => {
      expect(within(dialog).getAllByRole('option')).toHaveLength(1)
    })

    const marked = (): string[] =>
      Array.from(dialog.querySelectorAll('.mn-palette__hit')).map((node) => node.textContent ?? '')
    expect(marked()).toEqual(['天气'])

    // 输入下一个查询，但**不让它返回**：此时列表里挂着的仍是上一次的结果
    fireEvent.change(input, { target: { value: '代码' } })
    await waitFor(() => {
      expect(pending).toHaveLength(2)
    })
    expect(within(dialog).getByText('搜索中…')).toBeTruthy()

    // 用当前串（'代码'）去标：片段里没有它 → 一个 mark 都没有（这就是旧行为）。
    // 用 settledQuery（'天气'）标：命中仍在，且标在正确的位置上。
    expect(marked()).toEqual(['天气'])
    for (const node of dialog.querySelectorAll('.mn-palette__hit')) {
      expect(node.textContent).toBe('天气')
    }
  })
})
