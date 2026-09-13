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
  '.cm-scroller': {
    fontFamily: 'var(--mn-font-mono)',
    lineHeight: '1.72',
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

/** Markdown 语法高亮。 */
export const mnHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, color: 'var(--mn-heading)', fontWeight: '700', fontSize: '1.45em' },
  { tag: tags.heading2, color: 'var(--mn-heading)', fontWeight: '700', fontSize: '1.28em' },
  { tag: tags.heading3, color: 'var(--mn-heading)', fontWeight: '700', fontSize: '1.16em' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], color: 'var(--mn-heading)', fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700', color: 'var(--mn-editor-fg)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: 'var(--mn-fg-subtle)' },
  { tag: tags.link, color: 'var(--mn-link)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--mn-link)' },
  { tag: tags.monospace, color: 'var(--mn-success)', fontFamily: 'var(--mn-font-mono)' },
  { tag: tags.quote, color: 'var(--mn-fg-muted)', fontStyle: 'italic' },
  { tag: tags.list, color: 'var(--mn-accent)' },
  { tag: tags.contentSeparator, color: 'var(--mn-fg-subtle)' },
  { tag: tags.meta, color: 'var(--mn-fg-subtle)' },
  { tag: tags.processingInstruction, color: 'var(--mn-fg-subtle)' },
  { tag: tags.invalid, color: 'var(--mn-danger)' },
])
