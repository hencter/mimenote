/**
 * Live Preview 的类名与样式。
 *
 * 两个约定：
 * 1. **颜色一律走主题令牌**（`theme/tokens.ts` 的 `--mn-*`），因此切换主题只是 CSS 变量变化，
 *    不需要重算装饰、更不需要重建编辑器实例；
 * 2. 装饰层与样式层共用同一份类名（见 {@link MD}）—— 类名写错在运行时只会表现为"没样式"，
 *    不会被类型检查抓住，所以只允许在这里定义一次。
 */

import { EditorView } from '@codemirror/view'

/** 装饰使用的类名（装饰层与样式层的唯一契约）。 */
export const MD = {
  h1: 'mn-md-h1',
  h2: 'mn-md-h2',
  h3: 'mn-md-h3',
  h4: 'mn-md-h4',
  h5: 'mn-md-h5',
  h6: 'mn-md-h6',
  quote: 'mn-md-quote',
  quoteNested: 'mn-md-quote--nested',
  listMark: 'mn-md-list-mark',
  task: 'mn-md-task',
  taskDone: 'mn-md-task--done',
  collapsedLine: 'mn-md-collapsed-line',
  codeLine: 'mn-md-code-line',
  codeLineFirst: 'mn-md-code-line--first',
  codeLineLast: 'mn-md-code-line--last',
  strong: 'mn-md-strong',
  emphasis: 'mn-md-emphasis',
  strike: 'mn-md-strike',
  code: 'mn-md-code',
  frontmatter: 'mn-md-frontmatter',
  link: 'mn-md-link',
  linkAnchor: 'mn-md-link-anchor',
  hrLine: 'mn-md-hr-line',
  wikilink: 'mn-wikilink',
  wikilinkUnresolved: 'mn-wikilink--unresolved',
  wikilinkAmbiguous: 'mn-wikilink--ambiguous',
} as const

const HEADING_CLASSES = [MD.h1, MD.h2, MD.h3, MD.h4, MD.h5, MD.h6] as const

/** 标题级别 → 行装饰类名（越界按最接近的级别处理，避免产出空类名）。 */
export function mdHeadingClass(level: number): string {
  const index = Math.min(Math.max(Math.round(level), 1), HEADING_CLASSES.length) - 1
  return HEADING_CLASSES[index] ?? MD.h6
}

/** 链接/图片的解析状态标记（挂在 mark 装饰的 `attributes` 上，点击时由插件读取）。 */
export const LINK_ATTR = 'data-mn-link'
/** wikilink 的原始目标（与预览面板的 `data-target` 对齐，值为 `parts.target`）。 */
export const WIKILINK_ATTR = 'data-mn-wikilink'
/** wikilink 是否已解析到具体笔记（空串 = 悬空）。 */
export const WIKILINK_RESOLVED_ATTR = 'data-mn-resolved'

/**
 * Live Preview 样式。
 *
 * 排版口径**对齐预览面板**（app.css 的 `.mn-preview__body`）：正文用界面字体、标题按级别放大、
 * 行内代码与代码块用等宽字体 + 底色、引用是左侧竖线 + 淡色。这样"编辑器就是唯一的写作面"
 * 时，看到的排版与最终渲染不会两套。
 */
export const livePreviewTheme = EditorView.theme({
  /* ── 标题：字号由**行装饰**统一负责 ──
     为什么不在语法高亮里给字号：高亮的 tag 会落在标题文本的**内层** span 上，
     行与文本两层 `em` 会相乘（1.6em × 1.45em = 2.3em），级别越高越离谱。
     所以 `mnHighlightStyle` 只留颜色与字重，字号全部归这里。 */
  '.cm-line.mn-md-h1': {
    fontSize: '1.62em',
    fontWeight: '700',
    lineHeight: '1.35',
    paddingBottom: '0.12em',
    borderBottom: '1px solid var(--mn-border)',
  },
  '.cm-line.mn-md-h2': { fontSize: '1.4em', fontWeight: '700', lineHeight: '1.4' },
  '.cm-line.mn-md-h3': { fontSize: '1.22em', fontWeight: '700', lineHeight: '1.45' },
  '.cm-line.mn-md-h4': { fontSize: '1.1em', fontWeight: '700' },
  '.cm-line.mn-md-h5': { fontSize: '1.04em', fontWeight: '700' },
  '.cm-line.mn-md-h6': { fontSize: '1em', fontWeight: '700', color: 'var(--mn-fg-muted)' },

  /* ── 引用：左侧竖线 + 淡色（连续行各画一段，视觉上连成一条） ── */
  '.cm-line.mn-md-quote': {
    borderLeft: '3px solid var(--mn-quote-border)',
    color: 'var(--mn-fg-muted)',
  },
  '.cm-line.mn-md-quote--nested': { paddingLeft: '30px' },

  /* ── 列表：符号"退让"（淡色、不加粗），让正文和标题说话 ── */
  '.mn-md-list-mark': { color: 'var(--mn-fg-subtle)', fontWeight: '400' },

  /* 已勾选的任务：整行淡出（用 opacity 而不是 color，否则行内的粗体/链接会各自保留颜色） */
  '.cm-line.mn-md-task--done': { opacity: '0.62' },
  '.mn-md-task-box': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '1.05em',
    height: '1.05em',
    marginRight: '0.45em',
    border: '1px solid var(--mn-border)',
    borderRadius: '3px',
    background: 'var(--mn-bg-elevated)',
    color: 'var(--mn-accent-fg)',
    fontSize: '0.82em',
    lineHeight: '1',
    verticalAlign: '-0.14em',
    cursor: 'pointer',
    userSelect: 'none',
  },
  '.mn-md-task-box--checked': {
    background: 'var(--mn-accent)',
    borderColor: 'var(--mn-accent)',
  },
  '.mn-md-task-box:hover': { borderColor: 'var(--mn-accent)' },

  /* ── 代码块 ──
     `.mn-md-collapsed-line` 用于"围栏行 / setext 下划线行"在光标不在时整行收起：
     只隐藏行内文字会留下一条空白行，代码块上下就会多出两道缝。 */
  '.cm-line.mn-md-collapsed-line': { fontSize: '0', lineHeight: '0', overflow: 'hidden' },
  '.cm-line.mn-md-code-line': {
    background: 'var(--mn-code-bg)',
    fontFamily: 'var(--mn-font-mono)',
    fontSize: '0.94em',
  },
  '.cm-line.mn-md-code-line--first': { borderTopLeftRadius: '6px', borderTopRightRadius: '6px' },
  '.cm-line.mn-md-code-line--last': {
    borderBottomLeftRadius: '6px',
    borderBottomRightRadius: '6px',
  },

  /* ── frontmatter：元数据，不做语法渲染，只淡色（见 build.ts 的说明） ── */
  '.cm-line.mn-md-frontmatter': {
    color: 'var(--mn-fg-subtle)',
    fontFamily: 'var(--mn-font-mono)',
    fontSize: '0.88em',
  },

  /* ── 行内 ── */
  '.mn-md-strong': { fontWeight: '700' },
  '.mn-md-emphasis': { fontStyle: 'italic' },
  '.mn-md-strike': { textDecoration: 'line-through', color: 'var(--mn-fg-subtle)' },
  '.mn-md-code': {
    fontFamily: 'var(--mn-font-mono)',
    background: 'var(--mn-code-bg)',
    borderRadius: '4px',
    padding: '0.1em 0.34em',
    fontSize: '0.92em',
  },
  '.mn-md-link': {
    color: 'var(--mn-link)',
    textDecoration: 'underline',
    cursor: 'pointer',
  },
  /* wikilink 与预览面板同一个类名与同一套观感（虚线下边框而不是下划线）：
     `[[ ]]` 是我们自己的语义，样式上也不该和标准 Markdown 链接混在一起 */
  '.cm-content .mn-wikilink': {
    color: 'var(--mn-link)',
    textDecoration: 'none',
    borderBottom: '1px dashed var(--mn-link)',
    cursor: 'pointer',
  },
  /* 悬空链接：警告色 + 点线（与预览面板一致，提示"点击创建"） */
  '.cm-content .mn-wikilink--unresolved': {
    color: 'var(--mn-warning)',
    borderBottomColor: 'var(--mn-warning)',
    borderBottomStyle: 'dotted',
  },
  '.cm-content .mn-wikilink--ambiguous': { borderBottomStyle: 'double' },
  '.mn-md-link-anchor': { color: 'var(--mn-fg-subtle)' },

  /* ── 分隔线 / 图片 ── */
  '.cm-line.mn-md-hr-line': { paddingTop: '6px', paddingBottom: '6px' },
  '.mn-md-hr': {
    display: 'inline-block',
    width: '100%',
    height: '0',
    borderTop: '1px solid var(--mn-border)',
    verticalAlign: 'middle',
  },
  '.mn-md-image-wrap': { display: 'inline-block', maxWidth: '100%' },
  '.mn-md-image': {
    maxWidth: '100%',
    maxHeight: '420px',
    borderRadius: 'var(--mn-radius)',
    verticalAlign: 'middle',
  },
  '.mn-md-image-placeholder': {
    fontFamily: 'var(--mn-font-mono)',
    fontSize: '0.88em',
    color: 'var(--mn-fg-subtle)',
    background: 'var(--mn-code-bg)',
    borderRadius: '4px',
    padding: '0.1em 0.4em',
  },
})
