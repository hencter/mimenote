// @vitest-environment jsdom
/**
 * 编辑器撤销 / 重做：历史栈可用，且 Windows 上也绑了 Mod-Shift-z（不只是 Mod-y）。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { undo, redo } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'

import { createEditorExtensions } from '@/features/editor/cm/setup'

const views: EditorView[] = []

function mount(doc: string): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: createEditorExtensions({}, false),
    }),
  })
  views.push(view)
  return view
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
})

describe('历史键位', () => {
  it('撤销后可以重做', () => {
    const view = mount('hello')
    view.dispatch({ changes: { from: 5, insert: '!' } })
    expect(view.state.doc.toString()).toBe('hello!')
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('hello')
    expect(redo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('hello!')
  })

  it('扩展里挂了全平台 Mod-Shift-z → redo（Windows 默认可恢复）', () => {
    const state = EditorState.create({
      doc: '',
      extensions: createEditorExtensions({}, false),
    })
    const bindings = state.facet(keymap).flat()
    expect(bindings.some((binding) => binding.key === 'Mod-Shift-z' && binding.run === redo)).toBe(
      true,
    )
  })
})
