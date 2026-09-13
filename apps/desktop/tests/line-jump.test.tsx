// @vitest-environment jsdom
/**
 * "跳到第 N 行"（全文搜索命中 / 反向链接来源行）。
 *
 * 三层，从纯到集成：
 *
 * 1. **纯函数**（`domain/line-target.ts`）：行号夹取与行首偏移。退化路径（0 / 负数 /
 *    NaN / 超出末行 / 空文档）在这里逐条钉死 —— 它们是"跳错地方"和"直接抛错"的分界线；
 * 2. **定位**（`features/editor/line-jump.ts` + `cm/flash-line.ts`）：派发的事务里到底有什么。
 *    先用**假 view + 真 `EditorState`** 逐字断言（jsdom 没有布局，滚动的像素结果不可观测，
 *    但"要求滚到视口正中"这条意图可以断言），再用真编辑器验 DOM、撤销历史与焦点；
 * 3. **接线**：搜索面板回车走的是"打开并定位"而不是"只打开"。断言落在可观测信号上
 *    （store 里的当前文档、编辑器里的光标行、DOM 上的闪烁类名、焦点位置），
 *    而不是实现细节（内部用了令牌还是定时器）。
 */

import { undo } from '@codemirror/commands'
import {
  EditorState,
  type Annotation,
  type StateEffect,
  type TransactionSpec,
} from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '@/App'
import { openNote, openNoteAt } from '@/app/actions'
import { registerBuiltinCommands } from '@/app/builtin-commands'
import { normalizeLineCount, clampLineNumber, resolveLineTarget } from '@/domain/line-target'
import { FLASH_LINE_CLASS, FLASH_LINE_MS, flashLineEffect } from '@/features/editor/cm/flash-line'
import { createEditorExtensions, replaceEditorText } from '@/features/editor/cm/setup'
import { findEditorView, jumpToLineWhenReady, locateLine, type LineJumpView } from '@/features/editor/line-jump'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter, MOCK_VAULT_PATH } from '@/ipc/mock-adapter'
import { configureAutosave, useNoteStore } from '@/state/note-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * 补上 jsdom 没实现的 `Range.getClientRects`。
 *
 * CodeMirror 在"编辑器没有布局高度"（jsdom 永远是 0）时会退化成"造一个临时行去量字宽"，
 * 那一步走的是 `Range.getClientRects` —— jsdom 只给 `Element` 实现了它。后果不是断言失败，
 * 而是一个**未捕获异常**（Vitest 会因此把整个文件判为失败）。
 * 本文件是这个缺口的第一处受害者：只有它需要在"编辑器还活着"的时候 await（等一帧、等定时器、
 * 等面板结果），而等的那段时间正好够 CodeMirror 跑完那次延迟测量。
 *
 * 补一个空实现：测量退化成 CodeMirror 自己的兜底值（字宽 7px，行高 0），
 * 而本文件关心的是选区、装饰与滚动意图，与像素无关。
 */
Range.prototype.getClientRects = (): DOMRectList => [] as unknown as DOMRectList

/** 派发 `Ctrl+Shift+<key>`（`fireEvent` 自带 act 包裹）。 */
function pressModShift(key: string, target: Document | Element = document.body): void {
  fireEvent.keyDown(target, { key, ctrlKey: true, shiftKey: true })
}

async function openVault(): Promise<void> {
  await act(async () => {
    await useVaultStore.getState().openVault(MOCK_VAULT_PATH)
  })
}

/** 打开面板并返回对话框与输入框。 */
async function openSearchPanel(): Promise<{ dialog: HTMLElement; input: HTMLInputElement }> {
  pressModShift('F')
  const dialog = await screen.findByRole('dialog', { name: '全文搜索' })
  return { dialog, input: within(dialog).getByRole<HTMLInputElement>('textbox') }
}

/**
 * 只实现 `locateLine` 用到的那三个成员的**假 view**（配真实的 `EditorState`）。
 *
 * 假 view 自己把事务应用到 state 上，于是"跳转之后光标在哪儿"也能断言；
 * 而"派发了什么"（选区、效果、注解）被完整记下来 —— 这是 jsdom 里唯一能验的滚动意图。
 */
function fakeEditor(doc: string): {
  view: LineJumpView
  specs: TransactionSpec[]
  focusCount: () => number
} {
  const specs: TransactionSpec[] = []
  let state = EditorState.create({ doc })
  let focused = 0
  const view: LineJumpView = {
    get state() {
      return state
    },
    dispatch(...next: TransactionSpec[]) {
      specs.push(...next)
      for (const spec of next) state = state.update(spec).state
    },
    focus() {
      focused += 1
    },
  }
  return { view, specs, focusCount: () => focused }
}

/** 真编辑器（与生产用同一套扩展：闪烁装饰装在里面）。 */
const mounted: EditorView[] = []

function mountEditor(doc: string): EditorView {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, extensions: createEditorExtensions({}, true) }),
  })
  mounted.push(view)
  return view
}

/** 光标当前所在行（1 起）。 */
function caretLine(view: EditorView): number {
  return view.state.doc.lineAt(view.state.selection.main.anchor).number
}

/** 把"单个或数组"统一成数组（`TransactionSpec` 的 effects / annotations 都是这种形状）。 */
function asArray<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? (value as readonly T[]) : [value as T]
}

/** 事务里的效果列表。 */
function effectsOf(spec: TransactionSpec): readonly StateEffect<unknown>[] {
  return asArray<StateEffect<unknown>>(spec.effects)
}

/** 事务的注解列表。 */
function annotationsOf(spec: TransactionSpec): readonly Annotation<unknown>[] {
  return asArray<Annotation<unknown>>(spec.annotations)
}

beforeEach(() => {
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
  for (const view of mounted.splice(0)) view.destroy()
  useNoteStore.getState().close()
  configureAutosave({ delayMs: 600 })
})

// ---------------------------------------------------------------------------
// 第一层：纯函数（行号夹取与行首偏移）
// ---------------------------------------------------------------------------

describe('行号夹取与行首偏移（纯函数）', () => {
  /** 每行 9 个字符 + 换行：第 n 行行首在第 (n-1)*10 个字符。 */
  const from = (line: number): number => (line - 1) * 10

  it('合法行号原样返回，且不标记为夹取', () => {
    expect(resolveLineTarget(1, 5, from)).toEqual({ line: 1, from: 0, clamped: false })
    expect(resolveLineTarget(5, 5, from)).toEqual({ line: 5, from: 40, clamped: false })
  })

  it('0 / 负数 / NaN / ±Infinity 一律退化为第 1 行（而不是抛错或算出负偏移）', () => {
    for (const bad of [0, -1, -999, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
      expect(resolveLineTarget(bad, 5, from)).toEqual({ line: 1, from: 0, clamped: true })
    }
  })

  it('超出末行夹到末行，且标记为夹取', () => {
    expect(resolveLineTarget(6, 5, from)).toEqual({ line: 5, from: 40, clamped: true })
    expect(resolveLineTarget(9_999, 5, from)).toEqual({ line: 5, from: 40, clamped: true })
  })

  it('空文档：按 1 行算，光标落在偏移 0（真实 CodeMirror 文档口径）', () => {
    const doc = EditorState.create({ doc: '' }).doc
    // CodeMirror 的文档永远至少有一行 —— "0 行"这条路径不存在，退化只有一条
    expect(doc.lines).toBe(1)
    expect(resolveLineTarget(3, doc.lines, (n) => doc.line(n).from)).toEqual({
      line: 1,
      from: 0,
      clamped: true,
    })
  })

  it('真实文档：行首偏移与 `doc.line(n).from` 逐字一致', () => {
    const doc = EditorState.create({ doc: '甲\n乙\n丙' }).doc
    expect(doc.lines).toBe(3)
    expect(resolveLineTarget(3, doc.lines, (n) => doc.line(n).from)).toEqual({
      line: 3,
      from: 4,
      clamped: false,
    })
  })

  it('行数本身脏（0 / NaN）时按 1 行处理；小数行号只取整、不算越界', () => {
    expect(normalizeLineCount(0)).toBe(1)
    expect(normalizeLineCount(Number.NaN)).toBe(1)
    expect(normalizeLineCount(3.7)).toBe(3)
    expect(clampLineNumber(2.9, 5)).toBe(2)
    // 取整不是越界：调用方不该因为"我给了 2.9"被告知发生了退化
    expect(resolveLineTarget(2.9, 5, from).clamped).toBe(false)
    expect(resolveLineTarget(7, 0, () => 0)).toEqual({ line: 1, from: 0, clamped: true })
  })
})

// ---------------------------------------------------------------------------
// 第二层：定位本身
// ---------------------------------------------------------------------------

describe('定位：派发的事务', () => {
  it('假 view：选区落在行首、滚动策略是视口正中、带上闪烁效果、且不进撤销历史', () => {
    const { view, specs, focusCount } = fakeEditor('一行\n二行\n三行')

    const target = locateLine(view, 3)

    // '一行\n' 与 '二行\n' 各 3 个字符 → 第 3 行行首在偏移 6
    expect(target).toEqual({ line: 3, from: 6, clamped: false })
    expect(specs).toHaveLength(1)
    const spec = specs[0]
    expect(spec?.selection).toEqual({ anchor: 6 })
    // 选区自己用 `nearest` 滚会贴边，所以必须显式关掉，滚动只走下面那条效果
    expect(spec?.scrollIntoView).toBe(false)

    const effects = effectsOf(spec as TransactionSpec)
    const flash = effects.find((effect) => effect.is(flashLineEffect))
    expect(flash?.value).toBe(3)

    // 滚动：CodeMirror 没有导出 `scrollIntoView` 效果的类型（只有 `EditorView.scrollIntoView`
    // 这个静态方法），所以按效果值的形状认它 —— `ScrollTarget` 带着 `y` 策略字段
    const scroll = effects.find(
      (effect) => typeof effect.value === 'object' && effect.value !== null && 'y' in effect.value,
    )
    expect(scroll).toBeDefined()
    expect(scroll?.value).toMatchObject({ y: 'center' })

    // 只改选区的事务默认会进撤销历史 —— 跳转必须显式排除
    const annotations = annotationsOf(spec as TransactionSpec)
    const history = annotations.find((annotation) => annotation.value === false)
    expect(history).toBeDefined()

    // 焦点交给编辑器（用户多半想直接改这一行）
    expect(focusCount()).toBe(1)
  })

  it('假 view：越界行号夹到末行；空文档退化为偏移 0', () => {
    const { view: big, specs: bigSpecs } = fakeEditor('甲\n乙\n丙')
    expect(locateLine(big, 999)).toEqual({ line: 3, from: 4, clamped: true })
    expect(bigSpecs[0]?.selection).toEqual({ anchor: 4 })

    const { view: empty, specs: emptySpecs } = fakeEditor('')
    expect(locateLine(empty, 5)).toEqual({ line: 1, from: 0, clamped: true })
    expect(emptySpecs[0]?.selection).toEqual({ anchor: 0 })
  })

  it('真编辑器：光标落在该行行首、该行被闪烁装饰标出来', () => {
    const view = mountEditor('# 标题\n\n第二行\n第三行\n')

    const target = locateLine(view, 3)

    expect(target.from).toBeGreaterThan(0)
    expect(view.state.selection.main.anchor).toBe(target.from)
    expect(caretLine(view)).toBe(3)
    // 装饰落在正确的**行**上（不是整个文档，也不是别的行）
    const flashed = view.dom.querySelectorAll(`.${FLASH_LINE_CLASS}`)
    expect(flashed).toHaveLength(1)
    expect(flashed[0]?.textContent).toBe('第二行')
    // 装饰只是装饰：文档一个字都没变
    expect(view.state.doc.toString()).toBe('# 标题\n\n第二行\n第三行\n')
  })

  it('真编辑器：闪烁在几百毫秒后自己摘掉（不残留、不重复播动画）', async () => {
    const view = mountEditor('甲\n乙\n')
    locateLine(view, 2)
    expect(view.dom.querySelector(`.${FLASH_LINE_CLASS}`)).not.toBeNull()

    await waitFor(
      () => {
        expect(view.dom.querySelector(`.${FLASH_LINE_CLASS}`)).toBeNull()
      },
      { timeout: FLASH_LINE_MS + 2_000 },
    )
  })

  it('真编辑器：整篇替换（切换笔记）时立刻摘掉高亮 —— 不在新文档上乱闪一行', () => {
    const view = mountEditor('甲\n乙\n')
    locateLine(view, 2)
    expect(view.dom.querySelector(`.${FLASH_LINE_CLASS}`)).not.toBeNull()

    // 切换笔记走的就是这个函数（`MarkdownEditor` 在 `revision` 变化的 effect 里调它）
    replaceEditorText(view, '丙\n丁\n')

    expect(view.state.doc.toString()).toBe('丙\n丁\n')
    expect(view.dom.querySelector(`.${FLASH_LINE_CLASS}`)).toBeNull()
  })

  it('真编辑器：跳转不污染撤销历史（Ctrl+Z 撤的是上一次真正的编辑）', () => {
    const view = mountEditor('一行\n二行\n三行\n')

    // 先做一次真实编辑（进历史）
    view.dispatch({ changes: { from: 0, insert: '改' } })
    locateLine(view, 3)

    expect(undo(view)).toBe(true)
    // 撤销的是那次编辑，而不是"把光标弹回跳转之前的位置"
    expect(view.state.doc.toString()).toBe('一行\n二行\n三行\n')
  })
})

// ---------------------------------------------------------------------------
// 第三层：接线（搜索面板 → 打开并定位）
// ---------------------------------------------------------------------------

describe('搜索面板与搜索命中的落点', () => {
  it('回车打开命中笔记并跳到命中行（同一篇笔记的多条命中各跳各的行）', async () => {
    setIpcAdapter(createMockAdapter())
    render(<App />)
    await openVault()

    // 第一条命中：`项目/路线图.md` 第 1 行
    const first = await openSearchPanel()
    fireEvent.change(first.input, { target: { value: '路线图' } })
    await waitFor(() => {
      expect(within(first.dialog).getAllByRole('option')).toHaveLength(2)
    })
    expect(within(first.dialog).getAllByRole('option')[0]?.getAttribute('data-line')).toBe('1')
    fireEvent.keyDown(first.input, { key: 'Enter' })

    await waitFor(() => {
      expect(useNoteStore.getState().doc?.relPath).toBe('项目/路线图.md')
    })
    await waitFor(() => {
      const view = findEditorView()
      expect(view).not.toBeNull()
      expect(caretLine(view as EditorView)).toBe(1)
    })

    // 第二条命中：同一关键词在 `项目/设计.md` 的第 3 行 —— 必须跳到那一行，而不是文档开头
    const second = await openSearchPanel()
    fireEvent.change(second.input, { target: { value: '路线图' } })
    await waitFor(() => {
      expect(within(second.dialog).getAllByRole('option')).toHaveLength(2)
    })
    fireEvent.keyDown(second.input, { key: 'ArrowDown' })
    await waitFor(() => {
      expect(
        document.getElementById('mn-palette-option-1')?.getAttribute('aria-selected'),
      ).toBe('true')
    })
    fireEvent.keyDown(second.input, { key: 'Enter' })

    await waitFor(() => {
      expect(useNoteStore.getState().doc?.relPath).toBe('项目/设计.md')
    })
    await waitFor(() => {
      const view = findEditorView()
      expect(view).not.toBeNull()
      expect(caretLine(view as EditorView)).toBe(3)
    })
    // 目标行被高亮，且焦点在编辑器里（可以立刻打字）
    expect(document.querySelector(`.${FLASH_LINE_CLASS}`)?.textContent).toContain('路线图')
    expect(document.activeElement?.closest('.cm-editor')).not.toBeNull()
    // 文件树选中项跟着走（打开动作仍然只有一条路径）
    expect(useVaultStore.getState().selected).toBe('项目/设计.md')
  })

  it('阅读视图下回车：先切回编辑视图再定位（阅读视图里没有光标可放）', async () => {
    setIpcAdapter(createMockAdapter())
    render(<App />)
    await openVault()
    // 起手就在阅读视图：主区域里没有编辑器
    useUiStore.setState({ viewMode: 'read' })

    const { dialog, input } = await openSearchPanel()
    fireEvent.change(input, { target: { value: 'CodeMirror' } })
    await waitFor(() => {
      // 必须限定在面板内：状态栏的主题 `<select>` 也带隐式的 `option` 角色
      expect(within(dialog).getAllByRole('option').length).toBeGreaterThan(0)
    })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(useUiStore.getState().viewMode).toBe('edit')
    })
    await waitFor(() => {
      const view = findEditorView()
      expect(view).not.toBeNull()
      // `日记/2025-01-02.md` 里 CodeMirror 出现在第 3 行
      expect(caretLine(view as EditorView)).toBe(3)
    })
  })

  it('跳转不改文档、不动未保存状态（是"看"，不是"打开新内容"）', async () => {
    setIpcAdapter(createMockAdapter())
    render(<App />)
    await openVault()
    // 本用例关心"跳转有没有顺手保存"，把自动保存的防抖拉到足够长，避免它自己触发
    configureAutosave({ delayMs: 60_000 })
    await act(async () => {
      await openNote('项目/设计.md')
    })
    await waitFor(() => {
      expect(findEditorView()).not.toBeNull()
    })
    const view = findEditorView() as EditorView

    // 制造未保存内容（走编辑器自己的 updateListener → note-store.setText → dirty）
    view.dispatch({ changes: { from: 0, insert: '未保存标记\n' } })
    await waitFor(() => {
      expect(useNoteStore.getState().dirty).toBe(true)
    })
    const saveCount = useNoteStore.getState().saveCount
    const before = useNoteStore.getState().doc?.text ?? ''

    await act(async () => {
      await openNoteAt('项目/设计.md', 4)
    })
    await waitFor(() => {
      expect(caretLine(view)).toBeGreaterThan(1)
    })

    // 内容与未保存状态都没被这条路径碰过，也没有因此产生一次额外的写盘
    expect(useNoteStore.getState().doc?.text).toBe(before)
    expect(useNoteStore.getState().doc?.text).toContain('未保存标记')
    expect(useNoteStore.getState().dirty).toBe(true)
    expect(useNoteStore.getState().saveCount).toBe(saveCount)
  })

  it('跳转会在下一帧落地：文档还没进编辑器时不会在旧文档上算位置', async () => {
    setIpcAdapter(createMockAdapter())
    render(<App />)
    await openVault()
    await act(async () => {
      await openNote('随手记.md')
    })

    // 目标笔记还没打开就排一次跳转：等它真的进编辑器之后才该生效
    const cancel = jumpToLineWhenReady('项目/路线图.md', 5, { timeoutMs: 3_000 })
    await act(async () => {
      await openNote('项目/路线图.md')
    })

    await waitFor(() => {
      const view = findEditorView()
      expect(view).not.toBeNull()
      expect(caretLine(view as EditorView)).toBe(5)
    })
    expect(findEditorView()?.state.doc.toString()).toContain('设计细节见')
    cancel()
  })

  it('等待超时后静默放弃：不会在用户已经开始打字之后把光标挪走', async () => {
    setIpcAdapter(createMockAdapter())
    render(<App />)
    await openVault()
    await act(async () => {
      await openNote('随手记.md')
    })
    const view = findEditorView() as EditorView
    const anchorBefore = view.state.selection.main.anchor

    // 目标路径永远不会进编辑器（这一篇根本不存在）→ 等一小会儿就放弃
    jumpToLineWhenReady('不存在的笔记.md', 9, { timeoutMs: 30 })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
    })

    expect(view.state.selection.main.anchor).toBe(anchorBefore)
    expect(caretLine(view)).toBe(1)
  })

  it('打开不存在的笔记时不留下任何待执行的跳转（打开失败即放弃）', async () => {
    setIpcAdapter(createMockAdapter())
    render(<App />)
    await openVault()
    let ok = true
    await act(async () => {
      ok = await openNoteAt('附件/说明.txt', 3)
    })
    expect(ok).toBe(false)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    // 非 Markdown 打不开 → 编辑器里没有文档，也没有任何"迟到的跳转"
    expect(useNoteStore.getState().doc).toBeNull()
    expect(findEditorView()).toBeNull()
  })

  it('反向链接点击跳到来源笔记的那一行（命中行号来自来源文件）', async () => {
    setIpcAdapter(createMockAdapter())
    render(<App />)
    await openVault()
    await act(async () => {
      await openNote('项目/设计.md')
    })
    useUiStore.setState({ linksPanelVisible: true })

    const selector = '[data-backlink-from="项目/路线图.md"]'
    await waitFor(() => {
      expect(document.querySelector(selector)).not.toBeNull()
    })
    const backlink = document.querySelector<HTMLButtonElement>(selector)
    // 提示里写的就是"第 N 行"，点下去必须真的落到那一行
    expect(backlink?.title).toContain('第 7 行')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    fireEvent.click(backlink as HTMLButtonElement)

    await waitFor(() => {
      expect(useNoteStore.getState().doc?.relPath).toBe('项目/路线图.md')
    })
    await waitFor(() => {
      const view = findEditorView()
      expect(view).not.toBeNull()
      // `项目/路线图.md` 里 `[[设计]]` 写在第 7 行
      expect(caretLine(view as EditorView)).toBe(7)
    })
  })
})
