/**
 * 静态站点每一页的 HTML / CSS 构建（**纯函数**，可单测）。
 *
 * 与单篇导出（`export-html.ts`）的关系是"同一套排版、不同的外壳"：
 *
 * * **共用** `buildExportCss` 的令牌快照与正文排版 —— 导出件与站点必须长得一样，
 *   两处各写一份排版迟早会出现"导出的单页和站点里的同一页不一样"；
 * * 外壳不同：单篇导出是"一个文件拿到任何地方都能看"（样式内联、**没有可点的链接**），
 *   站点是"一个目录"（共享样式表 + 可点的相对链接 + 索引页 + 反向链接）。
 *
 * 三条硬性约束决定了它的形状：
 *
 * 1. **页面里不含时间戳**：同一个 Vault 导出两次必须逐字节相同。否则用户的同步盘会把
 *    几千个文件全部重传一遍，而"这次导出改了什么"也彻底看不出来（导出时间只写在标记文件里，
 *    `mimenote-export.json` 是元数据、不是页面）。
 * 2. **零 JavaScript**：站点要在 `file://` 下直接可用，而浏览器在 `file://` 下**禁止 `fetch()`**
 *    （任何"打开时加载一个 json"的设计恰好在这个场景里静默失灵）。所以折叠用 `<details>`、
 *    明暗用 `prefers-color-scheme`、搜索交给浏览器自带的 `Ctrl+F`。
 * 3. **所有链接都是相对路径**：目录可以整体拷到任何位置（U 盘、静态托管、内网共享），
 *    不依赖站点部署在域名根目录下。
 */

import { buildExportCss, escapeExportHtml } from './export-html'
import { SITE_ASSET_DIR, SITE_CSS_FILE, SITE_INDEX_FILE, siteRelativeHref } from '@/domain/site-paths'
import type { SitePage, SiteSkip } from '@/ipc/types'

/** 站点外壳的类名（页面里的导航/索引/反链都挂在它下面，便于主题覆盖）。 */
export const SITE_BODY_CLASS = 'mn-site-body'

/** 生成器标记（写进 `<meta name="generator">` 与页脚）。 */
const GENERATOR = 'Mimenote'

/** 索引页与页脚里最多逐条列出多少项（再多只报数量，没有用户会去读几百行）。 */
const MAX_LISTED = 50

/**
 * 站点样式表：单篇导出的那份（令牌快照 + 正文排版 + 打印规则）+ 站点外壳。
 *
 * 为什么共享一份样式表文件而不是每页内联（这是对 ADR-0011"样式内联、零外部引用"的**有意偏离**）：
 * 那条规则服务的是"单个 HTML 文件拿到任何地方都能看"；站点是目录，4000 个页面各内联一份 6 KB
 * 的样式就是 24 MB 的重复字节，而且改一次主题要重写 4000 个文件。偏离的代价是"单个页面文件
 * 离开站点目录后样式会丢"，这一点写进了 ADR-0019 的代价表。
 *
 * Vault CSS 片段（设置里的自定义样式）默认拼在后面：用户在应用里看到的样式，导出件里也该看到。
 * 每个片段前面加一行来源注释 —— 站点是要交给别人的，出问题时得看得出这段样式从哪来。
 */
export function buildSiteCss(
  tokens: Readonly<Record<string, string>>,
  appearance: 'dark' | 'light',
  snippets: readonly { name: string; content: string }[] = [],
): string {
  return [
    '/* Mimenote 静态站点样式：主题令牌已取成静态值，除本站文件外不含任何外部引用 */',
    buildExportCss(tokens, appearance),
    siteShellRules(),
    ...snippets.map(
      (snippet) => `/* 来自 Vault CSS 片段：${snippet.name} */\n${snippet.content}`,
    ),
  ].join('\n\n')
}

/** 站点外壳的规则（导航、索引页、反向链接、悬空链接、明暗自适应）。 */
function siteShellRules(): string {
  return `
/* 站点外壳：与正文排版同一套令牌，但多了一条"页面本身就是文档"的居中栏 */
.mn-site-nav {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px;
  max-width: 820px;
  margin: 0 auto;
  padding: 18px 28px 0;
  font-size: 13px;
  color: var(--mn-fg-muted);
}

.mn-site-nav a {
  color: var(--mn-link);
}

.mn-site-nav__crumbs code {
  font-family: var(--mn-font-mono);
  font-size: 12px;
}

.mn-site-nav__tags {
  margin-left: auto;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.mn-site-nav__tag {
  padding: 1px 8px;
  border: 1px solid var(--mn-border);
  border-radius: 999px;
  font-size: 12px;
  color: var(--mn-fg-muted);
}

/* 反向链接：与正文同宽的一节，用一条分隔线与正文分开（不做侧栏 —— 站点没有一个能放它的固定栏） */
.mn-site-backlinks {
  margin-top: 3em;
  padding-top: 1em;
  border-top: 1px solid var(--mn-border);
  font-size: 13px;
  color: var(--mn-fg-muted);
}

.mn-site-backlinks h2 {
  margin: 0 0 0.4em;
  font-size: 13px;
  font-weight: 600;
  color: var(--mn-fg-subtle);
  letter-spacing: 0.04em;
}

.mn-site-backlinks ul {
  margin: 0;
  padding-left: 1.2em;
}

/* 悬空链接（指向还不存在的笔记）：**不可点**，只是有颜色的文字 —— 让"点下去什么都不会发生"
   变成看得见的差异。站点是只读快照，没有"点击创建"这条路。 */
.mn-wikilink--dangling {
  color: var(--mn-fg-subtle);
  border-bottom: 1px dotted var(--mn-fg-subtle);
  cursor: help;
}

/* 索引页 */
.mn-site-index__stats {
  color: var(--mn-fg-muted);
  font-size: 14px;
}

.mn-site-index__group {
  margin: 1.2em 0;
}

.mn-site-index__group > summary {
  cursor: pointer;
  font-weight: 600;
  color: var(--mn-heading);
}

.mn-site-index__group ul {
  margin: 0.4em 0 0;
  padding-left: 1.4em;
}

.mn-site-index__note {
  color: var(--mn-fg-muted);
  font-size: 14px;
}

.mn-site-index__notes {
  margin-top: 2em;
  padding: 12px 14px;
  border: 1px dashed var(--mn-border);
  border-radius: var(--mn-radius);
  color: var(--mn-fg-muted);
  font-size: 13px;
}

.mn-site-index__notes ul {
  margin: 0.4em 0 0;
  padding-left: 1.2em;
}
`.trim()
}

/** 页面顶部的导航：回索引 + 面包屑目录 + 标签。 */
function navHtml(page: SitePage, vaultName: string): string {
  const segments = page.pagePath.split('/').slice(0, -1)
  // 面包屑显示完整目录路径（每一层都是纯文本，不做"每一层都可点" —— 站点里没有目录页）
  const crumbs = escapeExportHtml(
    segments.map((_, index) => segments.slice(0, index + 1).join('/')).join(' / '),
  )
  const tags =
    page.tags.length === 0
      ? ''
      : `<span class="mn-site-nav__tags">${page.tags
          .map((tag) => `<span class="mn-site-nav__tag">#${escapeExportHtml(tag)}</span>`)
          .join('')}</span>`

  return `<nav class="mn-site-nav">
<a href="${escapeExportHtml(siteRelativeHref(page.pagePath, SITE_INDEX_FILE))}">← ${escapeExportHtml(vaultName)}</a>
${crumbs === '' ? '' : `<span class="mn-site-nav__crumbs"><code>${crumbs}</code></span>`}
${tags}
</nav>`
}

/** 页脚：来源路径 + 生成器（**刻意不含时间戳**，理由见模块文档）。 */
function footerHtml(page: SitePage): string {
  return `<footer class="mn-export__footer">
<span>来源：<code>${escapeExportHtml(page.relPath)}</code></span>
<span>由 ${GENERATOR} 导出为静态站点</span>
</footer>`
}

/**
 * 反向链接一节。
 *
 * 为什么要做（单篇导出里没有它）：站点是"给没有这个应用的人读的"，反向链接是这套笔记里
 * 最有价值的信息之一，而数据已经在计划里（`SitePage.backlinks`）—— 成本只是渲染几个 `<a>`。
 */
function backlinksHtml(page: SitePage): string {
  if (page.backlinks.length === 0) return ''
  const items = page.backlinks
    .slice(0, MAX_LISTED)
    .map((fromRel) => {
      const fromPage = pageOfPage.get(fromRel)
      if (fromPage === undefined) return ''
      const label = titleOfPage.get(fromRel) ?? fromRel
      const href = siteRelativeHref(page.pagePath, fromPage)
      return `<li><a href="${escapeExportHtml(href)}">${escapeExportHtml(label)}</a></li>`
    })
    .filter((item) => item !== '')
  const more =
    page.backlinks.length > MAX_LISTED
      ? `<p class="mn-site-index__note">还有 ${page.backlinks.length - MAX_LISTED} 篇没有列出。</p>`
      : ''
  return `<section class="mn-site-backlinks">
<h2>反向链接（${page.backlinks.length}）</h2>
<ul>${items.join('')}</ul>
${more}
</section>`
}

/**
 * 渲染一页时需要的两张查表：**来源笔记 → 页面路径**与**来源笔记 → 标题**。
 *
 * 为什么用模块级的表而不是把两张表一路穿进参数：一页的反向链接只给了来源的相对路径，
 * 要变成链接与文字就得查表，而"一页 + 一点上下文"的签名比"一页 + 两张表 + …"好读得多。
 * 每次导出开始时由 {@link prepareSiteRender} 覆盖一次，导出在单线程里顺序执行 ——
 * 不存在并发读写的窗口，也不需要 store 或 React 状态。
 */
let pageOfPage: Map<string, string> = new Map()
let titleOfPage: Map<string, string> = new Map()

/** 准备一次导出的渲染上下文（页面路径与标题查表）；每次导出开始时调用一次。 */
export function prepareSiteRender(pages: readonly SitePage[]): void {
  pageOfPage = new Map(pages.map((page) => [page.relPath, page.pagePath]))
  titleOfPage = new Map(pages.map((page) => [page.relPath, page.title]))
}

export interface SitePageInput {
  page: SitePage
  /** 已净化的正文 HTML（图片与 wikilink 都已按站点形态渲染好）。 */
  bodyHtml: string
  vaultName: string
  tokens: Readonly<Record<string, string>>
  appearance: 'dark' | 'light'
}

/** 拼装一页笔记的完整 HTML 文档。 */
export function buildSitePageHtml(input: SitePageInput): string {
  const { page } = input
  const title = escapeExportHtml(page.title)
  const cssHref = escapeExportHtml(siteRelativeHref(page.pagePath, SITE_CSS_FILE))

  return `<!doctype html>
<html lang="zh-CN" data-appearance="${input.appearance}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="${GENERATOR}" />
<title>${title} · ${escapeExportHtml(input.vaultName)}</title>
<link rel="stylesheet" href="${cssHref}" />
</head>
<body class="${SITE_BODY_CLASS}">
${navHtml(page, input.vaultName)}
<main class="mn-export">
<article class="mn-export__content">
${input.bodyHtml}
</article>
${backlinksHtml(page)}
${footerHtml(page)}
</main>
</body>
</html>
`
}

export interface SiteIndexInput {
  vaultName: string
  pages: readonly SitePage[]
  /** 悬空链接的目标（去重后，用于"这些笔记还不存在"一节）。 */
  dangling: readonly string[]
  /** 没能导出的笔记（读失败/太大/非 UTF-8），如实列出。 */
  skipped: readonly SiteSkip[]
  /** 上次导出写过、这次没有的文件（宿主从不删除，如实列出）。 */
  stale: readonly string[]
  /** 同名笔记撞了页面路径、被改名的那几篇。 */
  renamed: readonly { relPath: string; pagePath: string }[]
  tokens: Readonly<Record<string, string>>
  appearance: 'dark' | 'light'
}

/**
 * 索引页：站点里唯一"不在计划里"的页面，由前端从页面表生成。
 *
 * 结构刻意只有三段：统计、按目录分组的列表、需要知道的问题清单（悬空/未导出/改名/残留）。
 * 最后一节是这套文档文化的一部分：**没有静默丢掉的东西** —— 导不出来的笔记、
 * 指向不存在笔记的链接、上次留下但这次没写的文件，都在这里点名。
 */
export function buildSiteIndexHtml(input: SiteIndexInput): string {
  const cssHref = escapeExportHtml(siteRelativeHref(SITE_INDEX_FILE, SITE_CSS_FILE))
  const groups = new Map<string, SitePage[]>()
  for (const page of input.pages) {
    const dir = page.pagePath.includes('/')
      ? page.pagePath.slice(0, page.pagePath.lastIndexOf('/'))
      : ''
    groups.set(dir, [...(groups.get(dir) ?? []), page])
  }
  const dirs = [...groups.keys()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))

  const linksByDir = dirs
    .map((dir) => {
      const pages = groups.get(dir) ?? []
      const heading = dir === '' ? '根目录' : dir
      const items = pages
        .map((page) => {
          const href = siteRelativeHref(SITE_INDEX_FILE, page.pagePath)
          return `<li><a href="${escapeExportHtml(href)}">${escapeExportHtml(page.title)}</a> <span class="mn-site-index__note">${escapeExportHtml(page.pagePath)}</span></li>`
        })
        .join('')
      return `<details class="mn-site-index__group" open>
<summary>${escapeExportHtml(heading)}（${pages.length}）</summary>
<ul>${items}</ul>
</details>`
    })
    .join('\n')

  const danglingSection =
    input.dangling.length === 0
      ? ''
      : `<section class="mn-site-index__notes">
<p>有链接指向${input.dangling.length}篇还不存在的笔记（页面里这些链接不可点）：</p>
<ul>${input.dangling
        .slice(0, MAX_LISTED)
        .map((target) => `<li>${escapeExportHtml(target)}</li>`)
        .join('')}</ul>
${input.dangling.length > MAX_LISTED ? `<p>还有 ${input.dangling.length - MAX_LISTED} 条没有列出。</p>` : ''}
</section>`

  const skippedSection =
    input.skipped.length === 0
      ? ''
      : `<section class="mn-site-index__notes">
<p>有 ${input.skipped.length} 篇没能导出（原因如实列出）：</p>
<ul>${input.skipped
        .slice(0, MAX_LISTED)
        .map(
          (skip) =>
            `<li><code>${escapeExportHtml(skip.relPath)}</code> —— ${escapeExportHtml(skip.reason)}：${escapeExportHtml(skip.message)}</li>`,
        )
        .join('')}</ul>
</section>`

  const renamedSection =
    input.renamed.length === 0
      ? ''
      : `<section class="mn-site-index__notes">
<p>有 ${input.renamed.length} 篇因为页面路径撞名换了地址：</p>
<ul>${input.renamed
        .map(
          (item) =>
            `<li><code>${escapeExportHtml(item.relPath)}</code> → <code>${escapeExportHtml(item.pagePath)}</code></li>`,
        )
        .join('')}</ul>
</section>`

  const staleSection =
    input.stale.length === 0
      ? ''
      : `<section class="mn-site-index__notes">
<p>上次导出留下的 ${input.stale.length} 个文件这次没有再写（导出不会删除任何文件）：</p>
<ul>${input.stale
        .slice(0, MAX_LISTED)
        .map((rel) => `<li><code>${escapeExportHtml(rel)}</code></li>`)
        .join('')}</ul>
</section>`

  const totalLinks = input.pages.reduce((sum, page) => sum + page.links.length, 0)

  return `<!doctype html>
<html lang="zh-CN" data-appearance="${input.appearance}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="${GENERATOR}" />
<title>${escapeExportHtml(input.vaultName)} · 静态站点</title>
<link rel="stylesheet" href="${cssHref}" />
</head>
<body class="${SITE_BODY_CLASS}">
<main class="mn-export mn-site-index">
<h1>${escapeExportHtml(input.vaultName)}</h1>
<p class="mn-site-index__stats">共 ${input.pages.length} 篇笔记 · ${totalLinks} 条链接 · ${input.dangling.length} 条指向还不存在的笔记</p>
${linksByDir}
${danglingSection}
${skippedSection}
${renamedSection}
${staleSection}
<footer class="mn-export__footer">
<span>由 ${GENERATOR} 导出为静态站点的索引页</span>
</footer>
</main>
</body>
</html>
`
}

/** 标记文件的文件名与内容形状（宿主据它判断"这个目录是我们导出的"）。 */
export interface SiteMarker {
  tool: 'mimenote'
  version: number
  vaultName: string
  exportedAtMs: number
  /** 这次写出去的全部站内文件（含索引页与样式表）—— 下次用于算出"残留文件"。 */
  files: string[]
}

/**
 * 标记文件的内容。
 *
 * 为什么需要它：输出目录是用户选的，可能是一个已经装满东西的目录（`D:\Documents`）。
 * "非空目录必须先证明是我们上次导出的"是唯一能挡住"几千个文件散进用户文档目录"的规则，
 * 而**唯一**的证据就是这个文件。`files` 同时让下次导出能算出哪些文件是上次留下的（我们从不删除）。
 */
export function buildSiteMarker(input: {
  vaultName: string
  exportedAtMs: number
  files: readonly string[]
}): string {
  const marker: SiteMarker = {
    tool: 'mimenote',
    version: 1,
    vaultName: input.vaultName,
    exportedAtMs: input.exportedAtMs,
    files: [...input.files].sort(),
  }
  return `${JSON.stringify(marker, null, 2)}\n`
}

/**
 * 从宿主的图片清单 / 计划里挑出**真正要复制的图片**（去重、按码元序）。
 *
 * 为什么要排序：图片的复制顺序会影响 `createdDirs` 之类的出参，而"两次导出结果一致"
 * 是这一块的硬要求（用户的同步盘按内容判断是否上传）。
 */
export function collectSiteAssets(paths: Iterable<string>): string[] {
  const unique = new Set<string>()
  for (const path of paths) {
    if (path.trim() !== '') unique.add(path)
  }
  return [...unique].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

/** 图片在站点里的落点（`assets/<原 Vault 相对路径>`），与宿主侧的映射逐字一致。 */
export function siteAssetPath(vaultRelPath: string): string {
  return `${SITE_ASSET_DIR}/${vaultRelPath}`
}
