/**
 * 导出件的 HTML / CSS 构建（**纯函数**，可单测）。
 *
 * 这个模块只做一件事：把"阅读视图看到的那篇笔记"变成一个**能脱离本应用打开**的 HTML 文档。
 * 三条硬性约束决定了它的形状：
 *
 * 1. **渲染必须复用既有净化管线**（`@/domain/markdown` 的 `renderMarkdown`）：导出件就是"另一台
 *    浏览器里的阅读视图"，另写一套 Markdown 渲染等于同时维护两份 XSS 防线与两套语法口径。
 * 2. **图片必须内嵌成 `data:` URL**：导出的文件是要离开这个应用的（发给别人、归档、拷到别的
 *    机器）。应用内的 `asset:` URL 只在当前 WebView 会话里有效（ADR-0007 的逐文件授权是会话级的），
 *    绝对路径换台机器就断 —— 只有把字节写进文件本身，单个 HTML 才"拿到任何地方都能看"。
 * 3. **样式必须内联且不含任何外部引用**：`<style>` 里的值全部是**当前主题的静态快照**
 *    （把 `applyTheme` 写进 `<html>` 的那些 CSS 变量取出来写死），不引 `app.css`、不引字体
 *    文件、不引任何 URL。导出件在无网、无本应用的浏览器里都要长得对。
 *
 * 图片字节由宿主提供（`asset_read_base64`），因此导出是**两遍渲染**：第一遍只为收集"这篇正文里
 * 到底引用了哪些 Vault 内图片"，拿到字节后再渲染第二遍。多渲染一遍换来的是"与阅读视图逐字一致的
 * 图片解析规则"（`createAssetResolver`）—— 换成在 Markdown 源码上跑正则预扫，就得自己复刻
 * markdown-it 的围栏代码块/转义规则，那种重复迟早会漂移。
 */

import { createAssetResolver, isImageAssetTarget, type AssetEntry } from '@/domain/assets'
import { renderMarkdown, type ImageResolution } from '@/domain/markdown'

/** 导出件的 `<body>` 类名（正文样式的挂载点，也是"这份文件是导出件"的标记）。 */
export const EXPORT_BODY_CLASS = 'mn-export-body'

/** 打印时用来承载正文的临时容器 id（见 `export-note.ts` 的 `printNote`）。 */
export const PRINT_ROOT_ID = 'mn-print-root'

/** 打印期间注入的 `<style>` 的 id。 */
export const PRINT_STYLE_ID = 'mn-print-style'

/** 导出件的页脚分隔符等固定文案里的来源说明。 */
const GENERATOR = 'Mimenote'

/**
 * 打印用的浅色令牌覆盖。
 *
 * 为什么打印要强制浅色（而不是沿用当前主题）：纸张/PDF 是"外部介质"，深色主题会吃掉大量墨粉，
 * 而且在多数打印预览里会变成一片灰黑底 —— 用户看到的是"打印坏了"。屏幕上的导出件仍然跟随主题，
 * 只有 `@media print` 这一段换成白底黑字。
 */
const PRINT_TOKEN_OVERRIDES: readonly (readonly [string, string])[] = [
  ['--mn-bg', '#ffffff'],
  ['--mn-bg-elevated', '#f6f6f6'],
  ['--mn-bg-sidebar', '#ffffff'],
  ['--mn-fg', '#000000'],
  ['--mn-fg-muted', '#3a3a3a'],
  ['--mn-fg-subtle', '#5a5a5a'],
  ['--mn-border', '#b5b5b5'],
  ['--mn-code-bg', '#f2f2f2'],
  ['--mn-quote-border', '#999999'],
  ['--mn-heading', '#000000'],
  ['--mn-link', '#000000'],
  ['--mn-hover', '#f0f0f0'],
  ['--mn-active', '#e8e8e8'],
  ['--mn-selection', '#d0d0d0'],
]

/** HTML 文本转义（标题、页脚等我们自己拼进文档的字符串）。 */
export function escapeExportHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** CSS 值/属性名里出现 `}`、`;` 会破坏样式表；令牌值来自主题 JSON（可信），仍做一次过滤。 */
function safeTokenValue(value: string): string {
  return value.replace(/[;}]/g, '')
}

function declarations(tokens: Readonly<Record<string, string>>): string {
  return Object.entries(tokens)
    .filter(([name]) => name.startsWith('--mn-'))
    .map(([name, value]) => `  ${name}: ${safeTokenValue(value)};`)
    .join('\n')
}

/**
 * 正文排版规则（**与 `styles/app.css` 的 `.mn-preview__body` 同口径**）。
 *
 * `scope` 让同一份规则既服务导出件（`.mn-export-body`），也服务应用内的打印容器
 * （`#mn-print-root`）—— 两处用同一份排版，才不会出现"导出件和打印出来长得不一样"。
 */
function contentRules(scope: string): string {
  const headings = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((tag) => `${scope} ${tag}`).join(',\n')
  return `
${scope} {
  margin: 0;
  background: var(--mn-bg);
  color: var(--mn-fg);
  font-family: var(--mn-font-ui);
  /* 与阅读视图同口径：导出件是给人**读**的，所以用"阅读视图字号"（设置页可单独调）。
     --mn-font-size-reading 不是主题令牌、可能没被写过，因此回落到编辑器字号 ——
     与 styles/app.css 的 .mn-preview__body 用的是同一条回落链。 */
  font-size: var(--mn-font-size-reading, var(--mn-font-size-editor));
  line-height: 1.78;
  word-wrap: break-word;
  -webkit-text-size-adjust: 100%;
}

.mn-export {
  max-width: 820px;
  margin: 0 auto;
  padding: 40px 28px 72px;
}

.mn-export__content > *:first-child {
  margin-top: 0;
}

${headings} {
  color: var(--mn-heading);
  line-height: 1.3;
  margin: 1.6em 0 0.6em;
  font-weight: 600;
}

${scope} h1 {
  font-size: 1.7em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--mn-border);
}

${scope} h2 {
  font-size: 1.4em;
}

${scope} h3 {
  font-size: 1.2em;
}

${scope} h4,
${scope} h5,
${scope} h6 {
  font-size: 1.05em;
}

${scope} a {
  color: var(--mn-link);
}

${scope} blockquote {
  margin: 1em 0;
  padding: 0.2em 1em;
  border-left: 3px solid var(--mn-quote-border);
  color: var(--mn-fg-muted);
}

/* Callout：与阅读视图同一份排版（类型 → 强调色），但**不能**依赖应用里的样式表 ——
   导出件与静态站点都可能在没有本应用的浏览器里打开，所以这一份必须自带。
   颜色写死在类型规则里（而不是像应用里那样读主题的 callout 变量）：导出件的令牌快照
   只带必需令牌，类型色不是主题的一部分。 */
${scope} .mn-callout {
  margin: 1em 0;
  padding: 6px 14px 2px;
  border-left: 3px solid var(--mn-callout-accent, var(--mn-quote-border));
  border-radius: var(--mn-radius);
  background: var(--mn-bg-elevated);
}

${scope} .mn-callout__title {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 4px 0;
  font-weight: 600;
  color: var(--mn-callout-accent, var(--mn-fg));
}

${scope} .mn-callout__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.15em;
  font-family: var(--mn-font-mono);
}

${scope} .mn-callout__label {
  flex: 1;
}

${scope} .mn-callout__fold {
  color: var(--mn-fg-subtle);
  font-family: var(--mn-font-mono);
  font-size: 0.85em;
}

${scope} .mn-callout > *:last-child {
  margin-bottom: 8px;
}

${scope} .mn-callout--note {
  --mn-callout-accent: #448aff;
}
${scope} .mn-callout--abstract,
${scope} .mn-callout--info {
  --mn-callout-accent: #00b8d4;
}
${scope} .mn-callout--todo {
  --mn-callout-accent: #448aff;
}
${scope} .mn-callout--tip {
  --mn-callout-accent: #00bfa5;
}
${scope} .mn-callout--success {
  --mn-callout-accent: #00c853;
}
${scope} .mn-callout--question {
  --mn-callout-accent: #64dd17;
}
${scope} .mn-callout--warning {
  --mn-callout-accent: #ff9100;
}
${scope} .mn-callout--failure {
  --mn-callout-accent: #ff5252;
}
${scope} .mn-callout--danger {
  --mn-callout-accent: #ff1744;
}
${scope} .mn-callout--bug {
  --mn-callout-accent: #f50057;
}
${scope} .mn-callout--example {
  --mn-callout-accent: #7c4dff;
}
${scope} .mn-callout--quote {
  --mn-callout-accent: var(--mn-quote-border);
}

${scope} code {
  padding: 0.16em 0.36em;
  border-radius: 4px;
  background: var(--mn-code-bg);
  font-family: var(--mn-font-mono);
  font-size: 0.9em;
}

${scope} pre {
  padding: 12px 14px;
  border: 1px solid var(--mn-border);
  border-radius: var(--mn-radius);
  background: var(--mn-code-bg);
  overflow-x: auto;
}

${scope} pre code {
  padding: 0;
  background: none;
  font-size: 0.9em;
}

${scope} table {
  border-collapse: collapse;
  width: 100%;
  margin: 1em 0;
}

${scope} th,
${scope} td {
  padding: 6px 10px;
  border: 1px solid var(--mn-border);
  text-align: left;
}

${scope} th {
  background: var(--mn-bg-elevated);
}

${scope} hr {
  border: none;
  border-top: 1px solid var(--mn-border);
  margin: 1.8em 0;
}

${scope} ul,
${scope} ol {
  padding-left: 1.6em;
}

${scope} li {
  margin: 0.24em 0;
}

/* 任务列表（- [ ] 待办 / - [x] 已完成）：**与 styles/app.css 里同名的那几条逐条相同** ——
   阅读视图、应用内打印、导出件、静态站点用的是同一条渲染管线，样式也只有一份口径。
   复选框本身是渲染层产出的原生 input[type=checkbox][disabled]（理由见
   domain/markdown-core.ts 的 taskCheckboxHtml）：导出件里没有可点的东西，
   所以连"看起来能点"的样子都不给它。 */
${scope} li.mn-task-item {
  list-style: none;
}

${scope} .mn-task-item__box {
  /* 负外边距把复选框推进"项目符号那一栏"（ul/ol 的 padding-left 是 1.6em，见上一条），
     文字于是与同级的普通条目对齐 */
  margin: 0 0.6em 0 -1.6em;
  width: 1em;
  height: 1em;
  accent-color: var(--mn-accent, var(--mn-link));
  vertical-align: middle;
  cursor: default;
}

/* 已完成：文字变暗 + 删除线（用户明确要求；复选框是替换元素，划不到它） */
${scope} li.mn-task-item--done {
  color: var(--mn-fg-muted);
  text-decoration: line-through;
}

/* 图片：导出件里没有灯箱可以放大，因此**不做高度封顶**（应用内封顶是为了配合点击看原图），
   只保证不撑破页面宽度；封顶反而会在纸上/窄窗口里把大图压成一条。 */
${scope} img.mn-image {
  display: block;
  margin: 0 auto;
  max-width: 100%;
  width: auto;
  height: auto;
  border-radius: var(--mn-radius);
}

${scope} .mn-figure {
  display: inline-block;
  max-width: 100%;
  vertical-align: bottom;
}

${scope} .mn-figure--block {
  display: block;
  width: fit-content;
  margin: 1em auto;
  text-align: center;
}

${scope} .mn-image__caption {
  display: block;
  margin-top: 4px;
  color: var(--mn-fg-muted);
  font-size: 0.86em;
  line-height: 1.5;
}

/* "点击查看原图"只对应用内的灯箱成立；导出件里它是错的指引，直接不显示 */
${scope} .mn-image__hint {
  display: none;
}

/* 没能内嵌的图片（超过宿主单张/单批上限、读取失败、浏览器预览模式）：退化成占位文字，
   与阅读视图的占位元素同一套类名，用户至少能看出"这里原本有张图、叫什么" */
${scope} .mn-image-placeholder {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px dashed var(--mn-border);
  border-radius: var(--mn-radius);
  background: var(--mn-bg-elevated);
  color: var(--mn-fg-muted);
  font-size: 0.92em;
}

${scope} .mn-image-placeholder__icon {
  color: var(--mn-fg-subtle);
}

/* wikilink：导出件是"只读快照"，没有库可供跳转，因此不做可点击的样子（虚线下划线 + 不换色），
   目标名仍留在 title 上，鼠标悬停能看出它指向谁 */
${scope} .mn-wikilink {
  color: inherit;
  text-decoration: none;
  border-bottom: 1px dotted var(--mn-fg-subtle);
  cursor: default;
}

${scope} .mn-wikilink__embed {
  border-bottom: 1px dashed currentColor;
}

.mn-export__footer {
  margin-top: 3em;
  padding-top: 1em;
  border-top: 1px solid var(--mn-border);
  color: var(--mn-fg-subtle);
  font-size: 12px;
  line-height: 1.7;
}

.mn-export__footer code {
  font-family: var(--mn-font-mono);
  font-size: 11px;
}
`.trim()
}

/**
 * 打印规则（导出件与应用内打印共用）。
 *
 * 白底黑字 + 不截断代码块 + 避免标题/表格/代码块被切在分页中间 —— 这三条是"打印出来能不能读"的
 * 全部要点。`.mn-export` 在打印时去掉限宽与内边距，把版面交给 `@page`。
 */
function printRules(scope: string): string {
  const overrides = PRINT_TOKEN_OVERRIDES.map(([name, value]) => `    ${name}: ${value};`).join('\n')
  return `@media print {
  :root {
${overrides}
  }

  html,
  body {
    background: #ffffff !important;
    color: #000000 !important;
  }

  /* 长代码行在纸上不会横向滚动 —— 只能换行，否则右边的内容直接消失 */
  ${scope} pre,
  ${scope} pre code {
    white-space: pre-wrap;
    word-break: break-word;
    overflow: visible;
  }

  ${scope} a {
    color: #000000;
    text-decoration: underline;
  }

  /* 复选框的填充色同样要强制变深：--mn-accent 来自**屏幕上的**主题（深色主题下常常是亮蓝），
     打到纸上会发灰，"勾没勾上"就看不出来了 */
  ${scope} .mn-task-item__box {
    accent-color: #000000;
  }

  ${scope} img.mn-image {
    max-height: none;
    break-inside: avoid;
  }

  ${scope} h1,
  ${scope} h2,
  ${scope} h3,
  ${scope} h4,
  ${scope} h5,
  ${scope} h6 {
    break-after: avoid;
  }

  ${scope} pre,
  ${scope} blockquote,
  ${scope} table,
  ${scope} tr,
  ${scope} img {
    break-inside: avoid;
  }

  ${scope} .mn-image__hint {
    display: none;
  }

  .mn-export {
    max-width: none;
    padding: 0;
  }

  .mn-export__footer {
    border-top-color: #b5b5b5;
  }

  @page {
    margin: 16mm;
  }
}`
}

/** 导出件的 `<style>` 内容：令牌快照 + 正文排版 + 打印规则。 */
export function buildExportCss(
  tokens: Readonly<Record<string, string>>,
  appearance: 'dark' | 'light',
): string {
  return [
    '/* Mimenote 导出样式：主题令牌已取成静态值，不含任何外部引用 */',
    `:root {\n${declarations(tokens)}\n  color-scheme: ${appearance};\n}`,
    contentRules(`.${EXPORT_BODY_CLASS}`),
    printRules(`.${EXPORT_BODY_CLASS}`),
  ].join('\n\n')
}

/**
 * 应用内打印时注入的样式：排版与导出件完全相同，只是作用域换成打印容器。
 *
 * ⚠️ 颜色令牌**刻意不沿用当前主题**：令牌一旦声明在 `#mn-print-root` 上，它就会覆盖
 * `@media print :root` 里的浅色值（自定义属性是就近生效的），打印出来又会变成深色块。
 * 因此这里只沿用**与颜色无关**的令牌（字体、字号、圆角 —— 它们来自用户的设置，必须保留），
 * 颜色一律用 {@link PRINT_TOKEN_OVERRIDES} 的静态浅色值。
 */
export function buildPrintCss(tokens: Readonly<Record<string, string>>): string {
  const forced = new Set(PRINT_TOKEN_OVERRIDES.map(([name]) => name))
  const typography = Object.fromEntries(
    Object.entries(tokens).filter(([name]) => !forced.has(name)),
  )
  return [
    '/* 打印视图：与导出件共用同一份排版规则（见 features/export/export-html.ts） */',
    `#${PRINT_ROOT_ID} {\n${declarations({ ...typography, ...Object.fromEntries(PRINT_TOKEN_OVERRIDES) })}\n}`,
    contentRules(`#${PRINT_ROOT_ID}`),
    printRules(`#${PRINT_ROOT_ID}`),
  ].join('\n\n')
}

/** 收集正文里引用到的 **Vault 内图片**（相对路径，按出现顺序去重）。 */
export function collectExportImages(input: {
  relPath: string
  body: string
  entries: readonly AssetEntry[]
}): string[] {
  const resolveAsset = createAssetResolver(input.entries)
  const found = new Set<string>()
  renderMarkdown(input.body, {
    resolveImage: (source: string): ImageResolution | null => {
      const rel = resolveAsset(input.relPath, source)
      // 外部地址、越界写法、`![[不是图片]]` 一律不算图片 —— 与阅读视图的分流完全一致
      if (rel === null || !isImageAssetTarget(rel)) return null
      found.add(rel)
      // 这一遍只为了"发现"，渲染结果会被丢掉；给一个占位结论即可
      return { kind: 'unauthorized', rel }
    },
  })
  return [...found]
}

/** 渲染正文 HTML（图片用已内嵌的 `data:` URL；没内嵌到的退化成占位元素）。 */
export function buildExportBodyHtml(input: {
  relPath: string
  body: string
  entries: readonly AssetEntry[]
  images: ReadonlyMap<string, string>
}): string {
  const resolveAsset = createAssetResolver(input.entries)
  return renderMarkdown(input.body, {
    resolveImage: (source: string): ImageResolution | null => {
      const rel = resolveAsset(input.relPath, source)
      if (rel === null || !isImageAssetTarget(rel)) return null
      const dataUrl = input.images.get(rel)
      return dataUrl === undefined ? null : { kind: 'ready', url: dataUrl }
    },
  })
}

export interface ExportDocumentInput {
  /** 文档标题（`<title>` 与页脚都显示它）。 */
  title: string
  /** 已净化的正文 HTML。 */
  bodyHtml: string
  /** 主题令牌的静态快照（键以 `--mn-` 开头）。 */
  tokens: Readonly<Record<string, string>>
  /** 明暗属性：写到 `<html data-appearance>`，让滚动条/原生控件配色跟随。 */
  appearance: 'dark' | 'light'
  /** 来源笔记的 Vault 相对路径（页脚说明"这份文件从哪来"）。 */
  sourceRelPath: string
  /** 导出时间（毫秒时间戳）。 */
  exportedAtMs: number
}

/**
 * 拼装完整的自包含 HTML 文档。
 *
 * 结构刻意只有四层：`html > body.mn-export-body > main.mn-export > (article + footer)`。
 * 越简单越不容易在别的浏览器里出意外；所有排版都挂在 `.mn-export-body` 这个作用域下，
 * 与用户的主题样式表（如果有）互不干扰。
 */
export function buildExportHtml(input: ExportDocumentInput): string {
  const title = escapeExportHtml(input.title)
  const source = escapeExportHtml(input.sourceRelPath)
  const exportedAt = escapeExportHtml(new Date(input.exportedAtMs).toLocaleString('zh-CN'))
  const css = buildExportCss(input.tokens, input.appearance)

  return `<!doctype html>
<html lang="zh-CN" data-appearance="${input.appearance}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="${GENERATOR}" />
<title>${title}</title>
<style>
${css}
</style>
</head>
<body class="${EXPORT_BODY_CLASS}">
<main class="mn-export">
<article class="mn-export__content">
${input.bodyHtml}
</article>
<footer class="mn-export__footer">
<span>${title}</span>
<span>来源：<code>${source}</code></span>
<span>导出于 ${exportedAt} · ${GENERATOR}</span>
</footer>
</main>
</body>
</html>
`
}
