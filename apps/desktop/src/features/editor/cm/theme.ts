/** 编辑器主题：全部颜色取自 CSS 变量，因此切换主题无需重建编辑器实例。 */

import { EditorView } from '@codemirror/view'
import { HighlightStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'

/** 编辑器外观（引用 `--mn-*` 令牌，见 theme/tokens.ts）。 */
export const mnEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--mn-font-size-editor)',
    color: 'var(--mn-editor-fg)',
    backgroundColor: 'var(--mn-editor-bg)',
  },
  /*
   * 正文用**界面字体**（与预览面板 `.mn-preview__body` 同一套排版）。
   *
   * Live Preview 的目标是"写的时候看到的就是最终排版"，等宽字体只留给代码
   * （行内代码与围栏代码块由 live-preview/theme.ts 单独指定 `--mn-font-mono`）——
   * 否则"隐藏语法标记"只是在源码上贴样式，读起来仍是代码而不是文章。
   */
  '.cm-scroller': {
    fontFamily: 'var(--mn-font-ui)',
    lineHeight: '1.78',
    overflow: 'auto',
  },
  '.cm-content': {
    caretColor: 'var(--mn-accent)',
    padding: '14px 0',
  },
  '.cm-line': {
    padding: '0 16px',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--mn-editor-gutter-bg)',
    color: 'var(--mn-editor-gutter-fg)',
    border: 'none',
    paddingRight: '6px',
    userSelect: 'none',
  },
  '.cm-activeLine': { backgroundColor: 'var(--mn-active-line)' },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--mn-active-line)',
    color: 'var(--mn-fg-muted)',
  },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-cursor, .cm-cursor': { borderLeftColor: 'var(--mn-accent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--mn-selection)',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--mn-active)' },
  '.cm-searchMatch': { backgroundColor: 'var(--mn-active)', outline: '1px solid var(--mn-accent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--mn-accent)' },
  '.cm-panels': {
    backgroundColor: 'var(--mn-bg-elevated)',
    color: 'var(--mn-fg)',
    borderBottom: '1px solid var(--mn-border)',
    fontFamily: 'var(--mn-font-ui)',
    fontSize: 'var(--mn-font-size-ui)',
  },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--mn-border)', borderBottom: 'none' },
  '.cm-textfield': {
    backgroundColor: 'var(--mn-bg)',
    color: 'var(--mn-fg)',
    border: '1px solid var(--mn-border)',
    borderRadius: 'var(--mn-radius)',
    padding: '3px 6px',
  },
  '.cm-button': {
    backgroundColor: 'var(--mn-hover)',
    backgroundImage: 'none',
    color: 'var(--mn-fg)',
    border: '1px solid var(--mn-border)',
    borderRadius: 'var(--mn-radius)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--mn-bg-elevated)',
    border: '1px solid var(--mn-border)',
    color: 'var(--mn-fg)',
  },
  '.cm-matchingBracket': {
    backgroundColor: 'var(--mn-active)',
    outline: '1px solid var(--mn-accent)',
  },
  '.cm-placeholder': { color: 'var(--mn-fg-subtle)' },
})

/**
 * Markdown 语法高亮。
 *
 * ⚠️ 这里**不设字号**：高亮的 tag 落在标题文本的**内层** span 上，而 Live Preview 的标题
 * 字号挂在 `.cm-line` 的行装饰上，两层 `em` 会相乘（1.62em × 1.45em ≈ 2.3em）。
 * 标题字号统一归 `live-preview/theme.ts` 管理，这里只负责颜色与字重。
 *
 * 同理，行内代码/代码块的颜色交给 Live Preview：预览面板里的代码是正文色 + 底色，
 * 如果这里继续染成 `--mn-success`，代码块会变成正文里的一块绿斑。
 */
export const mnHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, color: 'var(--mn-heading)', fontWeight: '700' },
  { tag: tags.heading2, color: 'var(--mn-heading)', fontWeight: '700' },
  { tag: tags.heading3, color: 'var(--mn-heading)', fontWeight: '700' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], color: 'var(--mn-heading)', fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700', color: 'var(--mn-editor-fg)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: 'var(--mn-fg-subtle)' },
  { tag: tags.link, color: 'var(--mn-link)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--mn-link)' },
  { tag: tags.monospace, color: 'var(--mn-editor-fg)', fontFamily: 'var(--mn-font-mono)' },
  { tag: tags.quote, color: 'var(--mn-fg-muted)' },
  { tag: tags.list, color: 'var(--mn-fg-subtle)' },
  { tag: tags.contentSeparator, color: 'var(--mn-fg-subtle)' },
  { tag: tags.meta, color: 'var(--mn-fg-subtle)' },
  { tag: tags.processingInstruction, color: 'var(--mn-fg-subtle)' },
  { tag: tags.invalid, color: 'var(--mn-danger)' },
])
