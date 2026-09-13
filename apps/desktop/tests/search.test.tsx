// @vitest-environment jsdom
/**
 * 全文搜索（M2）：**Mock 层的 `search_query`** + **面板的异步查询行为**。
 *
 * 分两层，与 `tags.test.tsx` 同样的思路：
 *
 * 1. **Mock 镜像**：Contract 形状（`hits` 排序、`total`、`snippet` 裁剪、空查询、非 Markdown
 *    不参与）—— 权威实现在 Rust 侧（SQLite FTS5），这里钉住的是"前端拿到什么"；
 * 2. **面板行为**：打开、防抖只发一次 IPC、结果渲染与子串高亮、↑↓/Enter、Esc、
 *    错误态，以及两条只有异步查询才会遇到的问题：**竞态丢弃**与**关闭即取消**。
 *
 * 断言尽量落在可观测的副作用上（发出了什么 IPC、store 状态、DOM 结构），
 * 而不是实现细节（内部用了序号还是 token），换实现不该让这些用例变红。
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '@/App'
import { registerBuiltinCommands } from '@/app/builtin-commands'
import { commands } from '@/app/commands'
import { MAX_PALETTE_RESULTS } from '@/features/palette/match'
import { ipc, setIpcAdapter, type IpcAdapter } from '@/ipc/client'
import { createMockAdapter, type MockAdapter } from '@/ipc/mock-adapter'
import { MimenoteError, type SearchResult } from '@/ipc/types'
import { useNoteStore } from '@/state/note-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

/** 与 Mock 适配器的 `MockNote` 结构一致（那个接口没有导出，测试侧自己声明一份）。 */
type MockNote = { relPath: string; text: string }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 派发 `Ctrl+Shift+<key>`（`fireEvent` 自带 act 包裹）。 */
function pressModShift(key: string, target: Document | Element = document.body): void {
  fireEvent.keyDown(target, { key, ctrlKey: true, shiftKey: true })
}

/** 派发 `Ctrl+<key>`（Windows/Linux 的 Mod）。 */
function pressMod(key: string, target: Document | Element = document.body): void {
  fireEvent.keyDown(target, { key, ctrlKey: true })
}

/** 派发一个"真实"的 Esc（返回事件对象，便于断言 preventDefault）。 */
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

/** 记录每次 `search_query` 的入参，其余命令原样转发给 Mock 适配器。 */
function spyOnSearch(base: MockAdapter): {
  adapter: IpcAdapter
  calls: Array<{ query: string; limit: number }>
} {
  const calls: Array<{ query: string; limit: number }> = []
  const adapter: IpcAdapter = {
    kind: 'test',
    async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
      if (method === 'search_query') {
        calls.push({ query: String(args?.query ?? ''), limit: Number(args?.limit ?? 0) })
      }
      return base.invoke<T>(method, args)
    },
  }
  return { adapter, calls }
}

interface PendingSearch {
  query: string
  /** 由测试决定何时返回、以什么顺序返回（竞态与错误态都靠它造出来）。 */
  settle: (outcome: SearchResult | Error) => void
}

/** 让 `search_query` 悬停不返回，直到测试显式 settle。 */
function deferredSearch(base: MockAdapter): { adapter: IpcAdapter; pending: PendingSearch[] } {
  const pending: PendingSearch[] = []
  const adapter: IpcAdapter = {
    kind: 'test',
    async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
      if (method !== 'search_query') return base.invoke<T>(method, args)
      const query = String(args?.query ?? '')
      return new Promise<T>((resolve, reject) => {
        pending.push({
          query,
          settle: (outcome) => {
            if (outcome instanceof Error) reject(outcome)
            else resolve(outcome as unknown as T)
          },
        })
      })
    },
  }
  return { adapter, pending }
}

/** 拿一份"真实"的 Mock 搜索结果，喂给可延迟的适配器。 */
async function mockResult(query: string): Promise<SearchResult> {
  return createMockAdapter().invoke<SearchResult>('search_query', {
    query,
    limit: MAX_PALETTE_RESULTS,
  })
}

/** 打开面板并返回对话框与输入框。 */
async function openSearchPanel(): Promise<{ dialog: HTMLElement; input: HTMLInputElement }> {
  pressModShift('F')
  const dialog = await screen.findByRole('dialog', { name: '全文搜索' })
  return { dialog, input: within(dialog).getByRole<HTMLInputElement>('textbox') }
}

beforeEach(() => {
  registerBuiltinCommands()
  window.localStorage.clear()
  useNoteStore.getState().close()
  useUiStore.setState({ paletteMode: null, linksPanelVisible: false, viewMode: 'split' })
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

// ---------------------------------------------------------------------------
// 第一层：Mock 的 `search_query`（Rust FTS5 的简化镜像）
// ---------------------------------------------------------------------------

describe('Mock 层的 search_query', () => {
  it('大小写不敏感的子串匹配，命中行号与片段就是命中所在一行', async () => {
    setIpcAdapter(createMockAdapter())

    const result = await ipc.searchQuery('CODEMIRROR')

    expect(result.query).toBe('CODEMIRROR')
    expect(result.hits.map((hit) => [hit.relPath, hit.line])).toEqual([['日记/2025-01-02.md', 3]])
    // 片段是原文（保留大小写）、已 trim、不含 Markdown 语法
    expect(result.hits[0]?.snippet).toBe('今天研究了 CodeMirror 6 的扩展机制。')
    expect(result.total).toBe(1)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('查询串首尾空白会被忽略，但回显的是原样查询串', async () => {
    setIpcAdapter(createMockAdapter())

    const result = await ipc.searchQuery('  设计  ')

    expect(result.query).toBe('  设计  ')
    expect(result.hits.map((hit) => hit.relPath)).toContain('项目/设计.md')
  })

  it('空查询（trim 后为空）返回空结果而不是报错', async () => {
    setIpcAdapter(createMockAdapter())

    const result = await ipc.searchQuery('   ')

    expect(result).toMatchObject({ hits: [], total: 0, elapsedMs: 0 })
  })

  it('无命中时返回空列表（total = 0）', async () => {
    setIpcAdapter(createMockAdapter())

    const result = await ipc.searchQuery('zzz这个词不存在zzz')

    expect(result.total).toBe(0)
    expect(result.hits).toEqual([])
  })

  it('非 Markdown 文件不参与搜索（与笔记计数同一口径）', async () => {
    // 这句只出现在 `附件/说明.txt` 里
    setIpcAdapter(createMockAdapter())

    const result = await ipc.searchQuery('不可编辑')

    expect(result.total).toBe(0)
  })

  it('snippet 去掉缩进，超长时以命中位置为中心裁剪并加省略号', async () => {
    const notes: MockNote[] = [
      { relPath: '缩进.md', text: '# 标题\n    这一行有缩进，中间是 关键词，后面还有字。\n' },
      { relPath: '长行.md', text: `${'前'.repeat(120)}关键词${'后'.repeat(120)}\n` },
    ]
    setIpcAdapter(createMockAdapter({ notes }))

    const result = await ipc.searchQuery('关键词')
    const byPath = new Map(result.hits.map((hit) => [hit.relPath, hit]))

    expect(byPath.get('缩进.md')?.snippet).toBe('这一行有缩进，中间是 关键词，后面还有字。')

    const long = byPath.get('长行.md')?.snippet ?? ''
    expect(long.length).toBeLessThanOrEqual(122) // 120 + 两侧省略号
    expect(long).toContain('关键词')
    expect(long.startsWith('…')).toBe(true)
    expect(long.endsWith('…')).toBe(true)
    // 命中点被保住（而不是从行首硬截）——这是"以命中为中心"的全部意义
    const at = long.indexOf('关键词')
    expect(at).toBeGreaterThan(40)
    expect(long.length - at).toBeGreaterThan(40)
  })

  it('多篇命中：按相关度降序，同分按 relPath / line 升序', async () => {
    const notes: MockNote[] = [
      // 出现 3 次：即使篇幅最长也排第一（Mock 的相关度近似 = 次数 / 篇幅）
      { relPath: '多.md', text: '关键词\n关键词\n关键词\n' },
      // 下面两篇内容完全相同 → 同分，靠 relPath 分先后
      { relPath: 'z/同分.md', text: '关键词\n关键词\n' },
      { relPath: 'a/同分.md', text: '关键词\n关键词\n' },
      // 只出现 1 次且篇幅不短 → 排最后
      { relPath: '少.md', text: '关键词\n' },
    ]
    setIpcAdapter(createMockAdapter({ notes }))

    const result = await ipc.searchQuery('关键词')

    expect(result.hits.map((hit) => `${hit.relPath}:${hit.line}`)).toEqual([
      '多.md:1',
      '多.md:2',
      '多.md:3',
      'a/同分.md:1',
      'a/同分.md:2',
      'z/同分.md:1',
      'z/同分.md:2',
      '少.md:1',
    ])
    // 分数确实递减（"仅用于排序、不展示给用户"）
    expect(result.hits[0]?.score).toBeGreaterThan(result.hits[result.hits.length - 1]?.score ?? 0)
  })

  it('每篇最多 5 条命中，但 total 是全部命中数；limit 再截断一次', async () => {
    const text = Array.from({ length: 8 }, (_, index) => `第 ${index + 1} 行有 关键词`).join('\n')
    setIpcAdapter(createMockAdapter({ notes: [{ relPath: '多行.md', text }] }))

    const result = await ipc.searchQuery('关键词', 50)
    expect(result.hits.map((hit) => hit.line)).toEqual([1, 2, 3, 4, 5])
    expect(result.total).toBe(8)

    const limited = await ipc.searchQuery('关键词', 2)
    expect(limited.hits).toHaveLength(2)
    expect(limited.total).toBe(8)
  })
})

// ---------------------------------------------------------------------------
// 第二层：面板行为
// ---------------------------------------------------------------------------

describe('全文搜索面板', () => {
  it('命令表入口：Ctrl+Shift+F 归全文搜索，文件树过滤框已让到 Ctrl+Shift+E', () => {
    expect(commands.get('search.open')?.keybinding).toBe('Mod+Shift+F')
    expect(commands.get('tree.focusFilter')?.keybinding).toBe('Mod+Shift+E')
    // 反查（面板的捕捉阶段监听就是靠它工作的）：一个组合键只对应一条面板命令
    expect(commands.byChord('Mod+Shift+F').map((command) => command.id)).toEqual(['search.open'])
    expect(commands.byChord('Mod+Shift+E').map((command) => command.id)).toEqual([
      'tree.focusFilter',
    ])
  })

  it('命令面板里也能进全文搜索：Ctrl+K → 输入「全文搜索」→ 回车', async () => {
    setIpcAdapter(createMockAdapter())
    render(<App />)
    await openVault()

    pressMod('k')
    const palette = await screen.findByRole('dialog', { name: '命令面板' })
    const input = within(palette).getByRole('textbox')
    fireEvent.change(input, { target: { value: '全文搜索' } })

    const option = await waitFor(() => {
      const list = within(palette).getAllByRole('option')
      expect(list).toHaveLength(1)
      return list[0]
    })
    expect(option?.textContent).toContain('Ctrl+Shift+F')

    fireEvent.keyDown(input, { key: 'Enter' })
    const dialog = (await screen.findByRole('dialog', { name: '全文搜索' })) as HTMLElement
    // 换模式时查询串必须清空：否则会拿着"命令名"去搜正文
    expect(within(dialog).getByRole<HTMLInputElement>('textbox').value).toBe('')
    expect(within(dialog).getByText('输入关键词，搜索当前 Vault 的正文内容')).toBeTruthy()
  })

  it('未打开 Vault 时给出空态提示（而不是空白面板或报错）', async () => {
    setIpcAdapter(createMockAdapter())
    render(<App />)

    const { dialog } = await openSearchPanel()
    expect(within(dialog).getByText(/还没有打开 Vault/)).toBeTruthy()
    expect(within(dialog).queryAllByRole('option')).toHaveLength(0)
  })

  it('打开后显示占位符与「还没输入」提示，输入前不打任何 IPC', async () => {
    const { adapter, calls } = spyOnSearch(createMockAdapter())
    setIpcAdapter(adapter)
    render(<App />)
    await openVault()

    const { dialog, input } = await openSearchPanel()

    expect(input.getAttribute('placeholder')).toBe('搜索正文内容…')
    expect(within(dialog).getByText('输入关键词，搜索当前 Vault 的正文内容')).toBeTruthy()
    // 空查询不调用宿主（宿主也会返回空结果，没必要打扰它）
    await sleep(200)
    expect(calls).toHaveLength(0)
  })

  it('输入防抖：连续输入只发一次 IPC，且发的是最后一次的查询串', async () => {
    const { adapter, calls } = spyOnSearch(createMockAdapter())
    setIpcAdapter(adapter)
    render(<App />)
    await openVault()

    const { dialog, input } = await openSearchPanel()
    // 三次输入落在同一个防抖窗口内（同一 tick 内派发，定时器不可能插进来）
    fireEvent.change(input, { target: { value: '路' } })
    fireEvent.change(input, { target: { value: '路线' } })
    fireEvent.change(input, { target: { value: '路线图' } })

    await waitFor(() => {
      expect(calls).toHaveLength(1)
    })
    expect(calls[0]).toEqual({ query: '路线图', limit: MAX_PALETTE_RESULTS })

    // 再等一个防抖窗口：确认没有"每个字符一条"的漏网请求
    await sleep(250)
    expect(calls).toHaveLength(1)
    expect(within(dialog).getAllByRole('option').length).toBeGreaterThan(0)
  })

  it('结果渲染：主行 relPath、副行「行号: 片段」，查询词在片段里高亮', async () => {
    setIpcAdapter(createMockAdapter())
    render(<App />)
    await openVault()

    const { dialog, input } = await openSearchPanel()
    fireEvent.change(input, { target: { value: '路线图' } })

    const options = await waitFor(() => {
      const found = within(dialog).getAllByRole('option')
      expect(found.length).toBe(2)
      return found
    })

    // 顺序：内容更短的《路线图》分数更高
    expect(options[0]?.getAttribute('data-rel-path')).toBe('项目/路线图.md')
    expect(options[0]?.getAttribute('data-line')).toBe('1')
    expect(options[1]?.getAttribute('data-rel-path')).toBe('项目/设计.md')
    expect(options[1]?.getAttribute('data-line')).toBe('3')

    // 副行是「行号: 片段」
    expect(options[1]?.querySelector('.mn-palette__item-sub')?.textContent).toBe(
      '3: 参考 [[路线图]] 与 [[细节]]。',
    )
    // 子串高亮：把查询串整段标出来（不是子序列的零散字符）
    const marks = Array.from(options[1]?.querySelectorAll('mark.mn-palette__hit') ?? [])
    expect(marks.map((mark) => mark.textContent)).toEqual(['路线图'])
  })

  it('↓ 选中下一条、Enter 打开那篇笔记（走 app/actions.openNote，不是自己 invoke IPC）', async () => {
    setIpcAdapter(createMockAdapter())
    render(<App />)
    await openVault()

    const { dialog, input } = await openSearchPanel()
    fireEvent.change(input, { target: { value: '路线图' } })
    await waitFor(() => {
      expect(within(dialog).getAllByRole('option')).toHaveLength(2)
    })

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    await waitFor(() => {
      expect(document.getElementById('mn-palette-option-1')?.getAttribute('aria-selected')).toBe(
        'true',
      )
    })

    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(useNoteStore.getState().doc?.relPath).toBe('项目/设计.md')
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    // 文件树选中项跟着走 —— 打开动作是"一件事"，不是在面板里另开一条路
    expect(useVaultStore.getState().selected).toBe('项目/设计.md')
  })

  it('Esc 关闭面板且不改动任何笔记', async () => {
    setIpcAdapter(createMockAdapter())
    render(<App />)
    await openVault()

    const { dialog, input } = await openSearchPanel()
    fireEvent.change(input, { target: { value: '路线图' } })
    await waitFor(() => {
      expect(within(dialog).getAllByRole('option').length).toBeGreaterThan(0)
    })

    const escape = pressEscape(input)
    // 必须被吃掉：否则会漏给 app/keymap.ts 的全局快捷键
    expect(escape.defaultPrevented).toBe(true)
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    expect(useUiStore.getState().paletteMode).toBeNull()
    expect(useNoteStore.getState().doc).toBeNull()
  })

  it('请求中显示「搜索中…」，失败时显示错误文案而不是静默空白', async () => {
    const { adapter, pending } = deferredSearch(createMockAdapter())
    setIpcAdapter(adapter)
    render(<App />)
    await openVault()

    const { dialog, input } = await openSearchPanel()
    fireEvent.change(input, { target: { value: '失败' } })
    await waitFor(() => {
      expect(pending).toHaveLength(1)
    })
    // 请求已发出但还没返回：不能是一片空白
    expect(within(dialog).getByText('搜索中…')).toBeTruthy()

    await act(async () => {
      pending[0]?.settle(
        new MimenoteError({ code: 'IO', message: '索引不可用', detail: null, currentMtimeMs: null }),
      )
    })

    await waitFor(() => {
      expect(within(dialog).getByText(/搜索失败/)).toBeTruthy()
    })
    // 错误态用警示色，与"没有结果"区分开
    expect(dialog.querySelector('.mn-palette__empty--error')).not.toBeNull()
    expect(within(dialog).queryAllByRole('option')).toHaveLength(0)
  })

  it('竞态丢弃：慢的旧请求后返回，不能覆盖新查询的结果', async () => {
    const { adapter, pending } = deferredSearch(createMockAdapter())
    setIpcAdapter(adapter)
    render(<App />)
    await openVault()

    const { dialog, input } = await openSearchPanel()
    fireEvent.change(input, { target: { value: '路' } })
    await waitFor(() => {
      expect(pending).toHaveLength(1)
    })
    fireEvent.change(input, { target: { value: '路线图' } })
    await waitFor(() => {
      expect(pending).toHaveLength(2)
    })

    // 先让"新"请求返回（正常顺序），再让"旧"请求姗姗来迟
    await act(async () => {
      pending[1]?.settle(await mockResult('路线图'))
    })
    await waitFor(() => {
      expect(within(dialog).getAllByRole('option')).toHaveLength(2)
    })

    await act(async () => {
      // 旧请求的响应是"路"的结果（命中更多）——若被采纳，列表会变成另一个样子
      pending[0]?.settle(await mockResult('路'))
    })
    await sleep(50)

    const options = within(dialog).getAllByRole('option')
    expect(options).toHaveLength(2)
    expect(options.map((option) => option.getAttribute('data-rel-path'))).toEqual([
      '项目/路线图.md',
      '项目/设计.md',
    ])
  })

  it('关闭面板即取消：在途请求返回后不再写进界面，重开是干净状态', async () => {
    const { adapter, pending } = deferredSearch(createMockAdapter())
    setIpcAdapter(adapter)
    render(<App />)
    await openVault()

    const { input } = await openSearchPanel()
    fireEvent.change(input, { target: { value: '路线图' } })
    await waitFor(() => {
      expect(pending).toHaveLength(1)
    })

    // 面板关闭 = 卸载（查询串与结果都不该留存）
    pressEscape(input)
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => {
      pending[0]?.settle(await mockResult('路线图'))
    })
    await sleep(50)
    // 卸载后 setState 不该产生任何告警（React 19 会打到 console.error）
    expect(errors).not.toHaveBeenCalled()

    const reopened = await openSearchPanel()
    expect(reopened.input.value).toBe('')
    expect(within(reopened.dialog).queryAllByRole('option')).toHaveLength(0)
    expect(within(reopened.dialog).getByText('输入关键词，搜索当前 Vault 的正文内容')).toBeTruthy()
    errors.mockRestore()
  })

  it('命中超过上限时只渲染前 50 条，并提示还有多少条未显示', async () => {
    // 12 篇 × 5 行 = 60 条命中（每篇 5 条刚好是 Mock 的每篇上限）
    const notes: MockNote[] = Array.from({ length: 12 }, (_, file) => ({
      relPath: `批量/第${file + 1}篇.md`,
      text: `${Array.from({ length: 5 }, (_, line) => `第 ${line + 1} 行有 关键词`).join('\n')}\n`,
    }))
    setIpcAdapter(createMockAdapter({ notes }))
    render(<App />)
    await openVault()

    const { dialog, input } = await openSearchPanel()
    fireEvent.change(input, { target: { value: '关键词' } })

    await waitFor(() => {
      expect(within(dialog).getAllByRole('option')).toHaveLength(MAX_PALETTE_RESULTS)
    })
    expect(within(dialog).getByText(/还有 10 条未显示/)).toBeTruthy()
  })
})
