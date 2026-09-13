/**
 * CodeMirror 6 扩展装配点。
 *
 * 这里是"编辑器可扩展"的落点（ADR-0005）：M4 的插件通过向
 * {@link createEditorExtensions} 的返回值追加 `Extension` 来增强编辑器。
 *
 * 注意：**不绑定 Tab**（不引入 `indentWithTab`），以保留键盘用户在编辑器与
 * 其他控件之间的 Tab 导航能力（可访问性优先于书写便利）。
 */

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'

import { mnEditorTheme, mnHighlightStyle } from './theme'

/** 允许运行时替换的扩展槽（明暗模式）。 */
export const appearanceCompartment = new Compartment()

export interface EditorCallbacks {
  /** 文档内容变化（每次输入都会调用，必须保持廉价：只写 store，不做 IO）。 */
  onDocChanged?: (text: string) => void
  /** 焦点变化。 */
  onFocusChanged?: (focused: boolean) => void
}

/** 组装编辑器扩展。 */
export function createEditorExtensions(callbacks: EditorCallbacks, isDark: boolean): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    crosshairCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(mnHighlightStyle),
    mnEditorTheme,
    appearanceCompartment.of(EditorView.darkTheme.of(isDark)),
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        callbacks.onDocChanged?.(update.state.doc.toString())
      }
      if (update.focusChanged) {
        callbacks.onFocusChanged?.(update.view.hasFocus)
      }
    }),
  ]
}

/** 运行时切换明暗（不重建编辑器）。 */
export function setEditorAppearance(view: EditorView, isDark: boolean): void {
  view.dispatch({
    effects: appearanceCompartment.reconfigure(EditorView.darkTheme.of(isDark)),
  })
}

/** 用整篇文本替换编辑器内容（切换文件 / 重新加载时使用）。 */
export function replaceEditorText(view: EditorView, text: string): void {
  if (view.state.doc.toString() === text) return
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: Math.min(view.state.selection.main.anchor, text.length) },
    scrollIntoView: false,
  })
}
