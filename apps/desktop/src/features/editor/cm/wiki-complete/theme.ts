/**
 * `[[` 补全弹层的类名与样式。
 *
 * 与 live-preview 的 `theme.ts` 同一套约定：
 * 1. **颜色一律走主题令牌**（`theme/tokens.ts` 的 `--mn-*`），切主题只是 CSS 变量变化，
 *    弹层不需要重建、也不需要重算；
 * 2. 类名只在这里定义一次（见 {@link WIKI}）—— 装饰层/插件层与样式层共用同一份契约，
 *    类名写错在运行时只会表现为"没样式"，类型检查抓不到；
 * 3. 样式通过 `EditorView.theme` 注入（而不是往 `app.css` 里加规则）：弹层是**编辑器内部
 *    的可选扩展**，它的样式应当随扩展一起装配、随扩展一起卸载（architecture.md §2 第 6 条）。
 *    另外 `EditorView.theme` 的每条规则都会被自动加上编辑器实例的样式类前缀，
 *    而弹层挂在 `.cm-editor` 下，正好落在作用域里。
 */

import { EditorView } from '@codemirror/view'

/** 弹层的类名（插件与样式层唯一的契约）。 */
export const WIKI = {
  panel: 'mn-wiki-complete',
  /** 滚动容器，同时也是 `role="listbox"` 那一个（页脚在它**外面**，不污染列表语义）。 */
  list: 'mn-wiki-complete__list',
  item: 'mn-wiki-complete__item',
  itemActive: 'mn-wiki-complete__item--active',
  name: 'mn-wiki-complete__name',
  path: 'mn-wiki-complete__path',
  badge: 'mn-wiki-complete__badge',
  highlight: 'mn-wiki-complete__mark',
  footer: 'mn-wiki-complete__footer',
} as const

/**
 * 弹层样式。
 *
 * 定位方式是**绝对定位的兄弟节点**（挂在 `.cm-editor` 下，`left/top` 由插件按光标坐标给）：
 * CodeMirror 只拥有 `.cm-scroller` / `.cm-content` 这些自己的子节点，额外的兄弟节点它不会碰；
 * 反过来，把弹层塞进 `.cm-content` 会被它当成文档内容参与排版与测量（光标、行高全会乱）。
 *
 * `z-index: 100`：与 CodeMirror 自带 tooltip 同档，足以盖住正文与行号栏；
 * 它不会超出编辑器自身边界之外的层（模态面板、命令面板），那是刻意的 ——
 * 补全弹层本来就不该盖住模态层。
 */
export const wikiCompleteThemeSpec: { [selector: string]: { [property: string]: string } } = {
  '.mn-wiki-complete': {
    position: 'absolute',
    zIndex: '100',
    boxSizing: 'border-box',
    minWidth: '12rem',
    maxWidth: '34rem',
    padding: '4px',
    border: '1px solid var(--mn-border)',
    borderRadius: 'var(--mn-radius)',
    background: 'var(--mn-bg-elevated)',
    boxShadow: 'var(--mn-shadow)',
    fontFamily: 'var(--mn-font-ui)',
    fontSize: 'var(--mn-font-size-ui)',
    color: 'var(--mn-fg)',
    // 弹层跟着光标走，拖动/选中它毫无意义，反而会挡住正文
    userSelect: 'none',
    cursor: 'pointer',
  },
  /* 列表自己滚动（而不是整个面板）：页脚与边框始终留在视野里 */
  '.mn-wiki-complete__list': {
    maxHeight: '13.5rem',
    overflowY: 'auto',
  },
  '.mn-wiki-complete__item': {
    display: 'flex',
    alignItems: 'baseline',
    gap: '0.5em',
    padding: '3px 6px',
    borderRadius: '4px',
  },
  '.mn-wiki-complete__item:hover': { background: 'var(--mn-hover)' },
  '.mn-wiki-complete__item--active': { background: 'var(--mn-active)' },
  '.mn-wiki-complete__name': { flex: '0 1 auto', whiteSpace: 'nowrap' },
  /* 路径是"辅助信息"：淡色 + 可截断，长路径不该把名字挤没 */
  '.mn-wiki-complete__path': {
    flex: '1 1 auto',
    minWidth: '0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'var(--mn-fg-subtle)',
    fontSize: '0.9em',
  },
  '.mn-wiki-complete__badge': {
    flex: '0 0 auto',
    padding: '0 5px',
    border: '1px solid var(--mn-border)',
    borderRadius: '999px',
    color: 'var(--mn-fg-muted)',
    fontSize: '0.82em',
  },
  '.mn-wiki-complete__mark': { color: 'var(--mn-accent)', fontWeight: '600' },
  '.mn-wiki-complete__footer': {
    padding: '3px 6px',
    borderTop: '1px solid var(--mn-border)',
    marginTop: '3px',
    color: 'var(--mn-fg-subtle)',
    fontSize: '0.85em',
  },
}

/** 弹层的 `EditorView.theme` 扩展（随扩展装配，随编辑器销毁卸载）。 */
export const wikiCompleteTheme = EditorView.theme(wikiCompleteThemeSpec)
