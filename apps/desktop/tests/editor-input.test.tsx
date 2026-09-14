// @vitest-environment jsdom
/**
 * 编辑器**输入层**测试：列表续行、空项退出、缩进升降、Backspace 去标记、Tab 宽度接线。
 *
 * 分两层：
 * 1. **纯函数层**（本文件主体）：`continueList` / `changeIndent` / `deleteListMarkerBackward`
 *    只吃 `EditorState`，返回 `{ changes, selection }`。把结果喂回 `state.update()` 就能拿到
 *    新文档，于是一条断言 = "按一下键之后文件里到底是什么"；
 * 2. **装配层**：真的建 `EditorView` 派发 keydown，验证 keymap 真的接上了、并且
 *    "Tab 宽度"是通过 Compartment 重配置（不重建编辑器）生效的。
 *
 * 为什么不用"模拟键盘"作为主要手段：keymap 只能证明"某个绑定被调用了"，
 * 证明不了"边界情况生成的文本对不对"（空项、嵌套、编号不连续、制表符缩进……）。
 */

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MarkdownEditor } from '@/features/editor/MarkdownEditor'
import {
  changeIndent,
  continueList,
  deleteListMarkerBackward,
  parseListMarker,
  type ListInputEdit,
} from '@/features/editor/cm/list-input'
import { createEditorExtensions, setEditorTabSize } from '@/features/editor/cm/setup'
import { useNoteStore } from '@/state/note-store'
import { useSettingsStore } from '@/state/settings-store'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * 与编辑器**同一套** Markdown 语言扩展。
 *
 * 输入层要靠语法树判断"这一段是不是代码"，裸的 `EditorState.create({doc})` 里树是空的，
 * 于是围栏代码块里的 `- 甲` 会被当成真的列表项 —— 测试必须用同一套扩展才测得准。
 */
const LANGUAGE = markdown({ base: markdownLanguage })

function stateOf(doc: string, cursor: number, tabSize?: number): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: tabSize === undefined ? [LANGUAGE] : [LANGUAGE, EditorState.tabSize.of(tabSize)],
  })
}

/** 把一次编辑结果应用到状态上，返回新文档。 */
function after(state: EditorState, edit: ListInputEdit | null): string {
  if (edit === null) throw new Error('预期产生一次编辑，实际得到 null')
  return state.update({ changes: edit.changes, selection: edit.selection }).state.doc.toString()
}

/** 编辑后的光标位置。 */
function cursorAfter(state: EditorState, edit: ListInputEdit | null): number {
  if (edit === null) throw new Error('预期产生一次编辑，实际得到 null')
  return state.update({ changes: edit.changes, selection: edit.selection }).state.selection.main
    .anchor
}

/** `needle` 在 `doc` 里的位置（避免硬编码偏移）。 */
function at(doc: string, needle: string, from = 0): number {
  const index = doc.indexOf(needle, from)
  if (index === -1) throw new Error(`文档里找不到 ${needle}`)
  return index
}

/** 往真实编辑器派发一次 keydown，返回"是否被命令吃掉"。 */
function pressKey(view: EditorView, key: string, shift = false): boolean {
  const event = new KeyboardEvent('keydown', {
    key,
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  })
  view.contentDOM.dispatchEvent(event)
  return event.defaultPrevented
}

const views: EditorView[] = []

function mountEditor(doc: string, cursor: number, tabWidth?: number): EditorView {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: createEditorExtensions({}, true, tabWidth),
    }),
  })
  views.push(view)
  return view
}

beforeEach(() => {
  useNoteStore.getState().close()
})

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  cleanup()
  document.body.innerHTML = ''
  useSettingsStore.getState().setTabWidth(4)
})

// ---------------------------------------------------------------------------
// 1. Enter：续行
// ---------------------------------------------------------------------------

describe('Enter：列表续行', () => {
  it('无序列表：插入同缩进、同符号的新项', () => {
    const state = stateOf('- 甲', 3)
    expect(after(state, continueList(state))).toBe('- 甲\n- ')
  })

  it('`*` / `+` 各自保留自己的符号（不统一成 `-`）', () => {
    expect(after(stateOf('* 甲', 3), continueList(stateOf('* 甲', 3)))).toBe('* 甲\n* ')
    expect(after(stateOf('+ 甲', 3), continueList(stateOf('+ 甲', 3)))).toBe('+ 甲\n+ ')
  })

  it('有序列表：编号 +1，分隔符照原样（`1.` / `3)`）', () => {
    expect(after(stateOf('1. 甲', 4), continueList(stateOf('1. 甲', 4)))).toBe('1. 甲\n2. ')
    expect(after(stateOf('3) 丙', 4), continueList(stateOf('3) 丙', 4)))).toBe('3) 丙\n4) ')
  })

  it('有序列表：紧跟其后的连续编号一起顺延（不留重号）', () => {
    const doc = '1. 甲\n2. 乙\n3. 丙'
    const state = stateOf(doc, 4)
    expect(after(state, continueList(state))).toBe('1. 甲\n2. \n3. 乙\n4. 丙')
  })

  it('有序列表：编号本来就不连续时不动后面的项（与上游 renumber 同一口径）', () => {
    const doc = '1. 甲\n3. 丙'
    const state = stateOf(doc, 4)
    expect(after(state, continueList(state))).toBe('1. 甲\n2. \n3. 丙')
  })

  it('任务项：新项继承 `- [ ] `，已勾选的一项也不会沿用 `[x]`', () => {
    expect(after(stateOf('- [ ] 甲', 7), continueList(stateOf('- [ ] 甲', 7)))).toBe(
      '- [ ] 甲\n- [ ] ',
    )
    expect(after(stateOf('- [x] 甲', 7), continueList(stateOf('- [x] 甲', 7)))).toBe(
      '- [x] 甲\n- [ ] ',
    )
  })

  it('嵌套列表：缩进原样带到新项', () => {
    const doc = '- 甲\n  - 乙'
    const state = stateOf(doc, doc.length)
    expect(after(state, continueList(state))).toBe('- 甲\n  - 乙\n  - ')
  })

  it('行尾空白被一起吃掉（不会留下 `- 甲   `）', () => {
    const state = stateOf('- 甲   ', 6)
    expect(after(state, continueList(state))).toBe('- 甲\n- ')
  })

  it('光标在内容中间：不接管（交给下游做"拆分这一项"）', () => {
    const doc = '- 甲乙'
    const state = stateOf(doc, at(doc, '乙'))
    expect(continueList(state)).toBeNull()
  })

  it('普通段落 / 引用 / 非列表行：不接管（保持原来的换行语义）', () => {
    expect(continueList(stateOf('普通一段文字', 6))).toBeNull()
    expect(continueList(stateOf('> - 甲', 5))).toBeNull()
    expect(continueList(stateOf('# 标题', 4))).toBeNull()
  })

  it('松散列表（兄弟项之间有空行）：不接管，避免破坏空行排版', () => {
    const doc = '- 甲\n\n- 乙'
    expect(continueList(stateOf(doc, 3))).toBeNull()
  })

  it('围栏代码块里的 `- 甲` 不是列表（靠语法树判断，不是靠行首字符）', () => {
    const doc = '```\n- 甲\n```'
    expect(continueList(stateOf(doc, at(doc, '甲') + 1))).toBeNull()
  })

  it('缩进列数按 `state.tabSize` 展开制表符（一个 `\\t` = Tab 宽度列）', () => {
    const markerAt = (tabSize: number) => {
      const state = stateOf('\t- 甲', 0, tabSize)
      return parseListMarker(state, state.doc.line(1))
    }
    expect(markerAt(4)?.indentColumns).toBe(4)
    expect(markerAt(8)?.indentColumns).toBe(8)
  })
})

// ---------------------------------------------------------------------------
// 2. Enter：空列表项 → 结束列表
// ---------------------------------------------------------------------------

describe('Enter：空列表项结束列表', () => {
  it('顶级空项：删掉标记变成空行（这一行不再是列表）', () => {
    const doc = '- 甲\n- '
    const state = stateOf(doc, doc.length)
    expect(after(state, continueList(state))).toBe('- 甲\n')
  })

  it('光标落到空行的行首（继续打字就是普通段落）', () => {
    const doc = '- 甲\n- '
    const state = stateOf(doc, doc.length)
    expect(cursorAfter(state, continueList(state))).toBe(at(doc, '- ', 3))
  })

  it('整篇只有一个空项：整行清空', () => {
    expect(after(stateOf('- ', 2), continueList(stateOf('- ', 2)))).toBe('')
  })

  it('嵌套空项：退到上级缩进并保留标记', () => {
    const doc = '- 甲\n  - '
    const state = stateOf(doc, doc.length)
    expect(after(state, continueList(state))).toBe('- 甲\n- ')
  })

  it('有序列表的空项同样退出（不留空号）', () => {
    const doc = '1. 甲\n2. '
    const state = stateOf(doc, doc.length)
    expect(after(state, continueList(state))).toBe('1. 甲\n')
  })

  it('任务项的空项退出：`- [ ] ` 整段删掉', () => {
    expect(after(stateOf('- [ ] ', 6), continueList(stateOf('- [ ] ', 6)))).toBe('')
  })

  it('第三项为空时退出，但前面的项一个都不动', () => {
    const doc = '- 甲\n- 乙\n- '
    const state = stateOf(doc, doc.length)
    expect(after(state, continueList(state))).toBe('- 甲\n- 乙\n')
  })

  it('绝不删上一行的换行：只清空本行内容', () => {
    const doc = '- 甲\n- '
    const state = stateOf(doc, doc.length)
    const next = state.update({
      changes: continueList(state)?.changes ?? [],
      selection: continueList(state)?.selection,
    }).state
    expect(next.doc.lines).toBe(2)
    expect(next.doc.line(1).text).toBe('- 甲')
    expect(next.doc.line(2).text).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 3. Tab / Shift+Tab：升降一级
// ---------------------------------------------------------------------------

describe('Tab / Shift+Tab：缩进升降', () => {
  it('列表项升一级：在行首插入"Tab 宽度"个空格', () => {
    const state = stateOf('- 甲', 3, 4)
    expect(after(state, changeIndent(state, 1))).toBe('    - 甲')
  })

  it('Tab 宽度真的决定缩进宽度（2 / 8 各来一次）', () => {
    const two = stateOf('- 甲', 3, 2)
    expect(after(two, changeIndent(two, 1))).toBe('  - 甲')

    const eight = stateOf('- 甲', 3, 8)
    expect(after(eight, changeIndent(eight, 1))).toBe('        - 甲')
  })

  it('嵌套列表项降一级：去掉一级缩进，回到上级列表', () => {
    const doc = '- 甲\n  - 乙'
    const state = stateOf(doc, doc.length, 4)
    expect(after(state, changeIndent(state, -1))).toBe('- 甲\n- 乙')
  })

  it('降级量按"列"算：6 空格缩进在 Tab 宽度 4 / 2 下退到 2 / 4 空格', () => {
    const doc = '- 甲\n      - 乙'
    const four = stateOf(doc, doc.length, 4)
    expect(after(four, changeIndent(four, -1))).toBe('- 甲\n  - 乙')

    const two = stateOf(doc, doc.length, 2)
    expect(after(two, changeIndent(two, -1))).toBe('- 甲\n    - 乙')
  })

  it('顶级列表项降级：返回 null（把按键让回默认行为，不做无变化的吞键）', () => {
    expect(changeIndent(stateOf('- 甲', 3, 4), -1)).toBeNull()
  })

  it('普通行 Tab：在光标处插入一级缩进', () => {
    const state = stateOf('甲乙', 1, 4)
    expect(after(state, changeIndent(state, 1))).toBe('甲    乙')
  })

  it('普通行 Shift+Tab：删掉光标前的一级空白', () => {
    const state = stateOf('甲    乙', 5, 4)
    expect(after(state, changeIndent(state, -1))).toBe('甲乙')
  })

  it('普通行 Shift+Tab：光标前没有空白 → null', () => {
    expect(changeIndent(stateOf('甲乙', 1, 4), -1)).toBeNull()
  })

  it('光标位置跟随缩进移动（升降级后还停在原来的内容位置）', () => {
    const up = stateOf('- 甲', 3, 4)
    expect(cursorAfter(up, changeIndent(up, 1))).toBe(7)

    const nested = '- 甲\n  - 乙'
    const down = stateOf(nested, nested.length, 4)
    expect(cursorAfter(down, changeIndent(down, -1))).toBe(nested.length - 2)
  })
})

// ---------------------------------------------------------------------------
// 4. Backspace：退出列表
// ---------------------------------------------------------------------------

describe('Backspace：去掉"只剩标记"的标记', () => {
  it('顶级空项：标记整段删掉，光标回到行首', () => {
    const doc = '- 甲\n- '
    const state = stateOf(doc, doc.length)
    expect(after(state, deleteListMarkerBackward(state))).toBe('- 甲\n')
    expect(cursorAfter(state, deleteListMarkerBackward(state))).toBe(at(doc, '- ', 3))
  })

  it('整篇只有一个空项：整行清空', () => {
    expect(after(stateOf('- ', 2), deleteListMarkerBackward(stateOf('- ', 2)))).toBe('')
  })

  it('嵌套空项：退一级并保留标记', () => {
    const doc = '- 甲\n  - '
    const state = stateOf(doc, doc.length)
    expect(after(state, deleteListMarkerBackward(state))).toBe('- 甲\n- ')
  })

  it('任务项的空标记同样退出', () => {
    expect(after(stateOf('1. [ ] ', 7), deleteListMarkerBackward(stateOf('1. [ ] ', 7)))).toBe('')
  })

  it('内容非空：不接管（那就是普通的删一个字符）', () => {
    const doc = '- 甲'
    expect(deleteListMarkerBackward(stateOf(doc, doc.length))).toBeNull()
  })

  it('光标停在标记中间：不接管（交给默认的逐字符删除）', () => {
    expect(deleteListMarkerBackward(stateOf('- 甲\n- ', 3 + 2))).toBeNull()
  })

  it('绝不跨过上一行的换行：只清空本行', () => {
    const doc = '- 甲\n- '
    const state = stateOf(doc, doc.length)
    const next = state.update({ changes: deleteListMarkerBackward(state)?.changes ?? [] }).state
    expect(next.doc.toString()).toBe('- 甲\n')
  })
})

// ---------------------------------------------------------------------------
// 5. 装配：真实 EditorView + keymap + Tab 宽度 Compartment
// ---------------------------------------------------------------------------

describe('真实装配（EditorView + keymap）', () => {
  it('Enter 在列表项上续行（真的走 keymap，不是直接调函数）', () => {
    const view = mountEditor('- 甲', 3)
    expect(pressKey(view, 'Enter')).toBe(true)
    expect(view.state.doc.toString()).toBe('- 甲\n- ')
  })

  it('Enter 在空列表项上结束列表（这条是本次修复的核心手感）', () => {
    const doc = '- 甲\n- '
    const view = mountEditor(doc, doc.length)
    expect(pressKey(view, 'Enter')).toBe(true)
    expect(view.state.doc.toString()).toBe('- 甲\n')
  })

  it('Backspace 在空列表项上去掉标记，而不是删掉换行', () => {
    const doc = '- 甲\n- '
    const view = mountEditor(doc, doc.length)
    expect(pressKey(view, 'Backspace')).toBe(true)
    expect(view.state.doc.toString()).toBe('- 甲\n')
  })

  it('Tab 与 Shift+Tab 互逆：顶级列表项升一级之后能原样退回来', () => {
    // CommonMark 里"缩进一级的列表项"与"缩进代码块"是同一段文本，
    // 所以缩进命令刻意不做代码区间判定 —— 否则第一次 Tab 之后 Shift+Tab 就失效了
    const view = mountEditor('- 甲', 3, 4)
    expect(pressKey(view, 'Tab')).toBe(true)
    expect(view.state.doc.toString()).toBe('    - 甲')
    expect(pressKey(view, 'Tab', true)).toBe(true)
    expect(view.state.doc.toString()).toBe('- 甲')
  })

  it('普通行按 Tab 插入缩进（既有语义：未绑定时 Tab 会移走焦点）', () => {
    const view = mountEditor('甲', 1, 4)
    expect(pressKey(view, 'Tab')).toBe(true)
    expect(view.state.doc.toString()).toBe('甲    ')
  })

  it('多光标：我们的命令让路，Enter 仍旧由兜底的 markdownKeymap 续行（功能不丢）', () => {
    const doc = '- 甲\n- 乙'
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc,
        selection: EditorSelection.create([EditorSelection.cursor(3), EditorSelection.cursor(7)]),
        extensions: createEditorExtensions({}, true, 4),
      }),
    })
    views.push(view)

    expect(pressKey(view, 'Enter')).toBe(true)
    expect(view.state.doc.toString().split('\n')).toEqual(['- 甲', '- ', '- 乙', '- '])
  })

  it('引用行上的 Enter 仍然由兜底的 markdownKeymap 续 `>`（既有语义没被改坏）', () => {
    const view = mountEditor('> 甲', 3)
    expect(pressKey(view, 'Enter')).toBe(true)
    expect(view.state.doc.toString()).toBe('> 甲\n> ')
  })

  it('围栏代码块里的 Enter 还是普通换行（输入层不误判代码）', () => {
    const doc = '```\n- 甲\n```'
    const view = mountEditor(doc, at(doc, '甲') + 1)
    pressKey(view, 'Enter')
    expect(view.state.doc.toString()).toBe('```\n- 甲\n\n```')
  })

  it('setEditorTabSize 走 Compartment：state.tabSize 变化，编辑器实例与文档都不动', () => {
    const view = mountEditor('- 甲', 3, 4)
    const dom = view.dom
    const before = view.state

    setEditorTabSize(view, 8)

    expect(view.state.tabSize).toBe(8)
    // 不重建：同一个 EditorView / 同一个 DOM 根，文档与选择原样
    expect(view.dom).toBe(dom)
    expect(view.state.doc.toString()).toBe(before.doc.toString())
    expect(view.state.selection.main.anchor).toBe(3)
  })

  it('重新配置之后，缩进命令用的就是新的 Tab 宽度（同一个值的两处消费者）', () => {
    const view = mountEditor('- 甲', 3, 4)
    setEditorTabSize(view, 8)
    pressKey(view, 'Tab')
    expect(view.state.doc.toString()).toBe('        - 甲')
  })

  it('setEditorTabSize 幂等：值没变时不派发事务（state 引用保持不变）', () => {
    const view = mountEditor('- 甲', 3, 4)
    const before = view.state
    setEditorTabSize(view, 4)
    expect(view.state).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// 6. 接线：设置页的 Tab 宽度真的作用到编辑器上
// ---------------------------------------------------------------------------

function pretendOpenNote(relPath: string, text: string): void {
  useNoteStore.setState({
    doc: {
      relPath,
      text,
      format: { bom: false, eol: '\n' },
      baseMtimeMs: 0,
      sizeBytes: text.length,
      revision: 1,
      openedAt: 0,
    },
  })
}

describe('设置页的「Tab 宽度」接线', () => {
  it('编辑器创建时用当前设置值；设置变化后只重配置，不重建编辑器', () => {
    useSettingsStore.getState().setTabWidth(2)
    pretendOpenNote('笔记/测试.md', '- 甲')

    render(<MarkdownEditor />)

    const content = document.querySelector<HTMLElement>('.cm-content')
    expect(content).not.toBeNull()
    const view = content === null ? null : EditorView.findFromDOM(content)
    expect(view).not.toBeNull()
    expect(view?.state.tabSize).toBe(2)

    const dom = view?.dom
    act(() => {
      useSettingsStore.getState().setTabWidth(8)
    })

    expect(view?.state.tabSize).toBe(8)
    // 同一个编辑器实例 / 同一个 DOM：改的是 facet，不是重建
    expect(view?.dom).toBe(dom)
    expect(view?.state.doc.toString()).toBe('- 甲')
  })
})

// ---------------------------------------------------------------------------
// 7. 接线：设置页的「显示行号」真的作用到编辑器上
// ---------------------------------------------------------------------------

describe('设置页的「显示行号」接线', () => {
  it('默认显示行号；关掉即隐藏，且**不重建编辑器**（光标与文档都在）', () => {
    /*
      为什么值得单独一条：行号是"随手开关"的显示偏好，而最容易写错的做法是
      "重建编辑器"——那会把光标、选区、撤销历史全部清零。这里同时钉住两件事：
      ① gutter 真的消失/回来；② 实例、DOM、文档、光标一个都没变。
    */
    useSettingsStore.getState().setEditorLineNumbers(true)
    pretendOpenNote('笔记/测试.md', '- 甲\n- 乙')
    render(<MarkdownEditor />)

    const content = document.querySelector<HTMLElement>('.cm-content')
    expect(content).not.toBeNull()
    const view = content === null ? null : EditorView.findFromDOM(content)
    expect(view).not.toBeNull()
    expect(document.querySelector('.cm-gutters')).not.toBeNull()

    // 把光标放到第二行：关掉行号之后它必须还在原处
    act(() => {
      view?.dispatch({ selection: { anchor: view.state.doc.line(2).from + 2 } })
    })
    const headBefore = view?.state.selection.main.head ?? -1
    const domBefore = view?.dom

    act(() => {
      useSettingsStore.getState().setEditorLineNumbers(false)
    })

    expect(document.querySelector('.cm-gutters')).toBeNull()
    expect(EditorView.findFromDOM(content as HTMLElement)).toBe(view)
    expect(view?.dom).toBe(domBefore)
    expect(view?.state.doc.toString()).toBe('- 甲\n- 乙')
    expect(view?.state.selection.main.head).toBe(headBefore)

    // 再打开：行号回来，光标依旧在原处
    act(() => {
      useSettingsStore.getState().setEditorLineNumbers(true)
    })
    expect(document.querySelector('.cm-gutters')).not.toBeNull()
    expect(view?.state.selection.main.head).toBe(headBefore)
  })

  it('创建时就用当前设置值（关着行号时挂载，第一次渲染起就没有 gutter）', () => {
    useSettingsStore.getState().setEditorLineNumbers(false)
    pretendOpenNote('笔记/测试.md', '正文')

    render(<MarkdownEditor />)

    expect(document.querySelector('.cm-content')).not.toBeNull()
    expect(document.querySelector('.cm-gutters')).toBeNull()
  })
})
