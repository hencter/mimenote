// @vitest-environment jsdom
/**
 * frontmatter 折叠边界：正文行首的 Backspace 不得再向前删。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import {
  frontmatterBodyStart,
  metadataFold,
  metadataFoldKeymap,
  protectFrontmatterBackspace,
} from '@/features/editor/cm/metadata-fold'

const views: EditorView[] = []

function mount(doc: string, cursor: number): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [metadataFold, metadataFoldKeymap],
    }),
  })
  views.push(view)
  return view
}

afterEach(() => {
  for (const view of views) view.destroy()
  views.length = 0
})

describe('frontmatterBodyStart', () => {
  it('指向闭合围栏下一行行首', () => {
    const state = EditorState.create({
      doc: '---\ncreated: x\n---\n\n标题\n',
    })
    const start = frontmatterBodyStart(state)
    expect(start).not.toBeNull()
    // 围栏后先有一空行，再是「标题」
    expect(state.doc.lineAt(start!).text).toBe('')
    expect(state.doc.lineAt(start!).number + 1).toBe(state.doc.lineAt(start! + 1).number)
    expect(state.doc.lineAt(start! + 1).text).toBe('标题')
  })

  it('没有 frontmatter 时返回 null', () => {
    expect(frontmatterBodyStart(EditorState.create({ doc: '# 标题\n' }))).toBeNull()
  })
})

describe('protectFrontmatterBackspace', () => {
  it('正文行首（含围栏后空行）拦下 Backspace，文档不变', () => {
    const doc = '---\ncreated: x\n---\n\n标题\n'
    const state = EditorState.create({ doc })
    const bodyStart = frontmatterBodyStart(state)!
    const view = mount(doc, bodyStart)
    expect(protectFrontmatterBackspace(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(doc)
  })

  it('正文行内照常放行（返回 false，交给默认退格）', () => {
    const doc = '---\ncreated: x\n---\n标题字\n'
    const state = EditorState.create({ doc })
    const bodyStart = frontmatterBodyStart(state)!
    // 「题」字上
    const view = mount(doc, bodyStart + 1)
    expect(protectFrontmatterBackspace(view)).toBe(false)
  })

  it('选区碰到 frontmatter 时拦下', () => {
    const doc = '---\na: 1\n---\n正文\n'
    const state = EditorState.create({ doc })
    const bodyStart = frontmatterBodyStart(state)!
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: bodyStart - 2, head: bodyStart + 2 },
        extensions: [metadataFold],
      }),
    })
    views.push(view)
    expect(protectFrontmatterBackspace(view)).toBe(true)
  })
})
