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
  /*
    选中高亮（用户报："选中文本没有高亮，无法确认是否选中了"）。

    CM 把选区画在**内容下面**（`layer({ above: false })`），而正文里那些"渲染出来的块"
    —— callout、表格、代码块、图片 —— 都带不透明底色：往它们里面选字时高亮被整块盖住，
    屏幕上就只剩"选中了却看不出来"。

    两处一起改才成立：
    1. 把选区层抬到内容之上（`zIndex`）—— 否则它永远被块底盖住；
    2. 图案换成**半透明**（`color-mix(… 55%, transparent)`）—— 抬上来之后若还用不透明的色块，
       选中的字会被整个糊住；半透明才能既盖过块底、又让字读得出来（VS Code / Obsidian 就是这么做的）。

     颜色仍然只有一份来源：主题的 `--mn-selection`（`color-mix` 只是给它加透明度，
     没有引入第二个颜色令牌）。

     不透明度是 80% 而不是更淡：55% 在纸墨底（`#f9f4ea`）上几乎看不见
     （用户报的"选中了却看不出来"去而复返）—— 三套主题的 token 都是"浅底深字或
     深底浅字"的高对比组合，80% 既盖得过块底，又糊不住字。
   */
  '.cm-selectionLayer': { zIndex: 3 },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, var(--mn-selection) 80%, transparent)',
  },
  /* 内容里的**原生**选区（drawSelection 未启用、或选区落在被浏览器直接渲染的部分）用同一份颜色 */
  '.cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--mn-selection) 70%, transparent)',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--mn-active)' },
  '.cm-searchMatch': { backgroundColor: 'var(--mn-active)', outline: '1px solid var(--mn-accent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--mn-accent)' },
  '.cm-panels': {
    position: 'relative',
    backgroundColor: 'var(--mn-bg-elevated)',
    color: 'var(--mn-fg)',
    borderBottom: '1px solid var(--mn-border)',
    fontFamily: 'var(--mn-font-ui)',
    fontSize: 'var(--mn-font-size-ui)',
  },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--mn-border)', borderBottom: 'none' },
  /*
   * 搜索面板做成**悬浮卡**（VSCode 式右上浮层），而不是把编辑区往下顶一条：
   * 打开搜索时正文不动（不重排、不丢滚动位置），关掉也不回跳 —— 面板只是暂时盖住右上角。
   * `:only-child` 守卫：现在面板只有搜索在用；以后若有别的面板常驻顶部，
   * 这条"容器不画线"才需要重新评估（`:has` 需要 Chrome 105+，构建目标 chrome110 满足）。
   */
  '.cm-panels:has(> .cm-panel.cm-search:only-child)': {
    backgroundColor: 'transparent',
    borderBottom: 'none',
  },
  '.cm-panel.cm-search': {
    position: 'absolute',
    top: '8px',
    right: '12px',
    zIndex: '30',
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px 8px',
    alignItems: 'center',
    maxWidth: 'min(430px, calc(100% - 24px))',
    padding: '10px 12px',
    backgroundColor: 'var(--mn-bg-elevated)',
    border: '1px solid var(--mn-border)',
    borderRadius: 'calc(var(--mn-radius) + 2px)',
    boxShadow: 'var(--mn-shadow)',
  },
  '.cm-search input[type="checkbox"]': { accentColor: 'var(--mn-accent)' },
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
