/**
 * 静态站点的**路径与 URL 算术**（纯函数，可单测）。
 *
 * 这四条规则（页面命名、URL 编码、相对 href、页面路径的分组）是整库导出的骨架，
 * 而且**宿主侧也有同一份**（`crates/mn-core/src/site.rs`）—— 宿主算链接的 href，
 * 前端算索引页/反向链接/样式表的 href。刻意接受这一次重复，理由是两边的职责不同：
 *
 * * 宿主那份出现在"计划"里（每页每条的 href 都是它算好的），前端拿到的就已经是结果；
 * * 前端这份是**给目录树用的**（`index.html` → 每一页、每页 → 它的反链、每页 → 共享样式表），
 *   这些链接不在计划里（计划只描述笔记之间的链接），让宿主为它们再算一遍要么多一列数据，
 *   要么多一次往返。
 *
 * 边界因此画得很清楚：**"谁指向谁"只有链接索引那一份**（语义规则，漂移了就会两处不一致），
 * 而"从 A 到 B 的相对路径怎么写"是一段十行的纯算术（`../` 数层数 + 逐段编码），两边各自成立。
 * 编码规则与命名规则**必须逐字一致**，否则会出现"页面里的链接指向一个不存在的文件名"。
 */

/** 站内页面扩展名（源笔记 `.md` → 页面 `.html`）。 */
export const SITE_PAGE_EXTENSION = '.html'
/** 图片在站点里的固定目录（`assets/<原 Vault 相对路径>`，O(1) 映射、永不碰撞）。 */
export const SITE_ASSET_DIR = 'assets'
/** 共享样式表（整站一份，页面按自身深度引用它 —— 4000 份内联样式是几十 MB 的重复字节）。 */
export const SITE_CSS_FILE = 'assets/site.css'
/** 索引页。 */
export const SITE_INDEX_FILE = 'index.html'
/** 标记文件：证明"这个目录是我们导出的"，也是"上次写过哪些文件"的依据。 */
export const SITE_MARKER_FILE = 'mimenote-export.json'

/** URL 编码时原样保留的字符（RFC 3986 的 unreserved 集合）。 */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/

/**
 * 一个路径段的百分号编码（**大写十六进制**）。
 *
 * 为什么不用 `encodeURIComponent`：它会放过 `!'()*` 这四个字符，而它们在 Markdown/wiki
 * 链接里是**语法字符**（`![[…]]`、`[[x|别名]]`）；放行它们会让"文件名里带 `!`"的笔记
 * 在页面里生成一个需要再转义一次的链接。这里只保留 unreserved 集合，多编几个字符没有代价。
 */
export function encodeUrlSegment(segment: string): string {
  const bytes = new TextEncoder().encode(segment)
  let out = ''
  for (const byte of bytes) {
    const char = String.fromCharCode(byte)
    out += UNRESERVED.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

/** 逐段编码一条站内路径（保留 `/`）。 */
export function encodeUrlPath(path: string): string {
  return path.split('/').map(encodeUrlSegment).join('/')
}

/** 锚点的编码（与路径段同一套规则）。 */
export function encodeAnchor(anchor: string): string {
  return encodeUrlSegment(anchor)
}

/**
 * 一篇笔记在站点里的页面路径（`项目/设计.md` → `项目/设计.html`）；不是 Markdown 笔记返回 `null`。
 *
 * 为什么**镜像目录树**而不是把标题 slug 化：中文笔记 slug 化之后地址栏变成一串拼音或哈希，
 * 而且 URL 不再是源路径的纯函数（要额外维护一张"标题 → 文件名"的表，重名还得再消歧）；
 * 镜像目录树则天然 O(1)、可预测，用户想找某一篇直接按目录找过去就行。
 */
export function pagePathForNote(relPath: string): string | null {
  const dot = relPath.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = relPath.slice(dot + 1).toLowerCase()
  if (ext !== 'md' && ext !== 'markdown') return null
  return `${relPath.slice(0, dot)}${SITE_PAGE_EXTENSION}`
}

/** 页面路径所在目录（根目录 = `''`）。 */
export function pageDir(pagePath: string): string {
  const at = pagePath.lastIndexOf('/')
  return at <= 0 ? '' : pagePath.slice(0, at)
}

/**
 * 分配页面路径：同名笔记（`设计.md` 与 `设计.markdown`）会撞到同一个 `.html`，
 * 按**入参顺序**第一份保留原名，其余追加 `-2`、`-3`。
 *
 * 返回改名清单（`relPath → pagePath` 的差异），让界面能如实说出"这两篇撞名字了、第二篇换了地址"。
 */
export function assignPagePaths(notes: readonly string[]): {
  pageOf: Map<string, string>
  renamed: Array<{ relPath: string; pagePath: string }>
} {
  const pageOf = new Map<string, string>()
  const renamed: Array<{ relPath: string; pagePath: string }> = []
  const taken = new Set<string>()
  for (const relPath of notes) {
    const base = pagePathForNote(relPath)
    if (base === null) continue
    const dot = base.lastIndexOf('.')
    const stem = base.slice(0, dot)
    let candidate = base
    let suffix = 2
    while (taken.has(candidate)) {
      candidate = `${stem}-${suffix}${base.slice(dot)}`
      suffix += 1
    }
    taken.add(candidate)
    pageOf.set(relPath, candidate)
    if (candidate !== base) renamed.push({ relPath, pagePath: candidate })
  }
  return { pageOf, renamed }
}

/**
 * 从 `fromPage` 指向 `toPage` 的相对链接（`../` 算术 + 逐段编码 + 可选锚点）。
 *
 * 同页且带锚点时退化成 `#片段`（浏览器不会重新加载页面）；同页且没有锚点时返回**文件名本身**
 * （而不是 `#`）：`#` 会让浏览器跳到页面顶部，而"指向自己这一页"的链接跳顶是没人想要的。
 */
export function siteRelativeHref(fromPage: string, toPage: string, anchor?: string | null): string {
  const fragment = anchor === undefined || anchor === null || anchor === '' ? '' : `#${encodeAnchor(anchor)}`
  if (fromPage === toPage && fragment !== '') return fragment

  const fromParts = pageDir(fromPage) === '' ? [] : pageDir(fromPage).split('/')
  const toParts = toPage.split('/')
  const target = toParts[toParts.length - 1] ?? toPage
  const targetDir = toParts.slice(0, -1)

  let common = 0
  while (
    common < fromParts.length &&
    common < targetDir.length &&
    fromParts[common] === targetDir[common]
  ) {
    common += 1
  }
  const segments = [
    ...Array.from({ length: fromParts.length - common }, () => '..'),
    ...targetDir.slice(common),
    target,
  ]
  return segments.map(encodeUrlSegment).join('/') + fragment
}

/**
 * 从某一页指向站内图片的相对地址（`assets/<原 Vault 相对路径>`）。
 *
 * 图片**不内嵌成 `data:`**：单个自包含 HTML 必须内嵌（ADR-0011），但静态站是一个目录 ——
 * 同一张图在几千个页面里各存一份 base64 既撑大体积、又让浏览器完全没法缓存。
 */
export function siteAssetHref(fromPage: string, vaultRelPath: string): string {
  return siteRelativeHref(fromPage, `${SITE_ASSET_DIR}/${vaultRelPath}`)
}
