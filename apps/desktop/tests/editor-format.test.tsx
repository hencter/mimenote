// @vitest-environment jsdom
/**
 * 行内格式命令（`features/editor/cm/format.ts`，ADR-0055）。
 *
 * 断言围绕三件事，每一件都是"手感"的正确性问题：
 * 1. **切换语义**：加粗要能加也能减。只能加不能减时，用户会开始手工删星号 ——
 *    那正是这个功能想消灭的动作；
 * 2. **一次撤销**：包裹与摘除都是**一个**事务（`userEvent: 'input.format'`），
 *    撤销一次回到按键之前；
 * 3. **多光标**：每个选区各自处理，而不是只认主选区（"只有主选区生效"是很怪的半截行为）。
 */

import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'

import { insertLinkCommand, toggleInlineMarkCommand } from '@/features/editor/cm/format'

const views: EditorView[] = []

function mount(doc: string, range?: { from: number; to: number }): EditorView {
  const state = EditorState.create({
    doc,
    selection: range === undefined ? { anchor: 0 } : { anchor: range.from, head: range.to },
  })
  const view = new EditorView({ state })
  views.push(view)
  return view
}

function selectionOf(view: EditorView): { from: number; to: number } {
  const range = view.state.selection.main
  return { from: range.from, to: range.to }
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
})

describe('切换标记（加粗 / 斜体 / 行内代码 / 删除线）', () => {
  it('对选区加粗，并把选区留在文字上（不是留在星号上）', () => {
    const view = mount('这是重点字', { from: 2, to: 4 })
    expect(toggleInlineMarkCommand('bold')(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('这是**重点**字')
    expect(selectionOf(view)).toEqual({ from: 4, to: 6 })
  })

  it('再按一次摘掉（切换语义）', () => {
    const view = mount('这是重点字', { from: 2, to: 4 })
    toggleInlineMarkCommand('bold')(view)
    expect(toggleInlineMarkCommand('bold')(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('这是重点字')
    expect(selectionOf(view)).toEqual({ from: 2, to: 4 })
  })

  it('空光标插入成对标记，光标落在中间', () => {
    const view = mount('ab', { from: 1, to: 1 })
    toggleInlineMarkCommand('bold')(view)
    expect(view.state.doc.toString()).toBe('a****b')
    expect(selectionOf(view)).toEqual({ from: 3, to: 3 })
  })

  it('空光标正好落在成对标记之间 → 再按一次摘掉它', () => {
    const view = mount('a****b', { from: 3, to: 3 })
    toggleInlineMarkCommand('bold')(view)
    expect(view.state.doc.toString()).toBe('ab')
  })

  it('选区包含标记时，摘的是标记而不是往里再套一层', () => {
    const view = mount('**粗**', { from: 0, to: 5 })
    toggleInlineMarkCommand('bold')(view)
    expect(view.state.doc.toString()).toBe('粗')
    expect(selectionOf(view)).toEqual({ from: 0, to: 1 })
  })

  it('四种标记各自用对的字符', () => {
    const cases = [
      ['italic', '*'],
      ['code', '`'],
      ['strike', '~~'],
    ] as const
    for (const [name, marker] of cases) {
      const view = mount('文字', { from: 0, to: 2 })
      toggleInlineMarkCommand(name)(view)
      expect(view.state.doc.toString()).toBe(`${marker}文字${marker}`)
    }
  })

  it('多光标：每个选区各自包裹', () => {
    // 多选区必须在 state 上显式打开 `allowMultipleSelections` —— CodeMirror 默认**只保留主选区**，
    // 不开这个 facet 时 `EditorSelection.create` 的多条会被静默丢掉（第一次写这条用例就踩过）。
    // 被测命令走 `changeByRange`，因此它天然支持多选区；这里只是把那个能力打开。
    const view = new EditorView({
      state: EditorState.create({
        doc: 'aaa bbb',
        selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 7)]),
        extensions: [EditorState.allowMultipleSelections.of(true)],
      }),
    })
    views.push(view)
    expect(view.state.selection.ranges).toHaveLength(2)

    expect(toggleInlineMarkCommand('bold')(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('**aaa** **bbb**')
  })

  it('是一次撤销可以整体回退的事务（userEvent 为 input.format）', () => {
    const view = mount('文字', { from: 0, to: 2 })
    let userEvent: string | null = null
    const original = view.dispatch.bind(view)
    view.dispatch = ((...args: Parameters<EditorView['dispatch']>) => {
      const spec = args[0] as { userEvent?: string }
      if (typeof spec === 'object' && spec !== null && 'userEvent' in spec) {
        userEvent = spec.userEvent ?? null
      }
      return original(...args)
    }) as EditorView['dispatch']

    toggleInlineMarkCommand('bold')(view)
    expect(userEvent).toBe('input.format')
  })
})

describe('插入链接', () => {
  it('有选区 → `[文字](|)`，光标落在括号里等粘地址', () => {
    const view = mount('看这里', { from: 1, to: 3 })
    expect(insertLinkCommand(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('看[这里]()')
    expect(selectionOf(view)).toEqual({ from: 6, to: 6 })
  })

  it('空光标 → `[](|)`，光标落在方括号里等写文字', () => {
    const view = mount('', { from: 0, to: 0 })
    insertLinkCommand(view)
    expect(view.state.doc.toString()).toBe('[]()')
    expect(selectionOf(view)).toEqual({ from: 1, to: 1 })
  })

  it('选区已经是链接 → 摘成纯文字', () => {
    const source = '[文字](https://example.com)'
    const view = mount(source, { from: 0, to: source.length })
    insertLinkCommand(view)
    expect(view.state.doc.toString()).toBe('文字')
  })
})
