/**
 * Markdown 渲染 + XSS 净化。
 *
 * 安全模型（见 `docs/architecture.md` §5）——两道防线缺一不可：
 * 1. `markdown-it` 关闭 raw HTML（`html: false`）：笔记里的 `<script>` 只会变成纯文本；
 * 2. DOMPurify 二次净化：即便未来开启 HTML 或引入渲染插件，也拦住 javascript: 之类的载荷。
 *
 * 另外：本地图片走 `![说明](相对路径)` 或 Obsidian 风格的 `![[附件/图.png]]`，
 * 能不能显示由宿主的逐文件授权决定（ADR-0007）；拿不到授权或加载失败都会**回退成占位元素**，
 * 而不是留下裂图。
 */

import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'

import { isImageAssetTarget } from './assets'
import { splitWikilink, wikilinkDisplayText } from './links'

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
})

/**
 * wikilink 的 `href`：用文内锚点，是为了让它可聚焦、可键盘激活（`href="#"` 会被点击处理器拦截）。
 * **是否解析得到具体笔记由宿主索引决定**，预览层只负责渲染 + 挂载后按索引结果补类名。
 */
const WIKILINK_HREF = '#mn-wikilink'

/** `![[目标]]` 指向的不是图片时的说明（放在 `title` 上，鼠标悬停能看懂"为什么这里是个链接"）。 */
const NON_IMAGE_EMBED_TITLE = '嵌入非图片目标，按链接显示'

/**
 * wikilink → `<a>` 的 HTML（`[[…]]` 与 `![[…]]` 共用）。
 *
 * 为什么嵌入非图片目标要复用这一段：`![[另一篇笔记]]` 的**下游行为**必须与 `[[另一篇笔记]]`
 * 完全一致（同样带 `data-target`，同样由预览层按索引补类名、点击跳转、悬空即创建）——
 * 各写一遍迟早会漂移。差别只在两处：说明性 `title`，以及把展示文本包一层 `<span>`。
 *
 * 为什么要包 `<span>`：预览层会给每个 `a.mn-wikilink` **重写** `title`（已解析 → 相对路径，
 * 悬空 → "还不存在，点击创建"），直接写在 `<a>` 上的说明会被覆盖；包一层内层元素后，
 * 鼠标停在内层文本上读到的是"嵌入非图片目标，按链接显示"，停在别处才是跳转提示。
 */
function wikilinkAnchorHtml(inner: string, embed: boolean): string {
  const parts = splitWikilink(inner)
  const display = escapeHtml(wikilinkDisplayText(parts))
  const body = embed
    ? `<span class="mn-wikilink__embed" title="${NON_IMAGE_EMBED_TITLE}">${display}</span>`
    : display
  return (
    `<a class="mn-wikilink" href="${WIKILINK_HREF}"` +
    ` data-target="${escapeHtml(parts.target)}"` +
    ` data-anchor="${escapeHtml(parts.anchor ?? '')}"` +
    (embed ? ` data-mn-embed="non-image" title="${NON_IMAGE_EMBED_TITLE}"` : '') +
    `>${body}</a>`
  )
}

/**
 * `[[wikilink]]` 行内规则：渲染成带 `data-target` 的 `<a>`。
 *
 * 不带 `!` 的 `[[x]]` 一律走这里；`![[x]]` 由下面的 `mn_embed` 规则接走（两者互不干扰）。
 */
md.inline.ruler.before('link', 'mn_wikilink', (state, silent) => {
  const start = state.pos
  const source = state.src
  if (source.charCodeAt(start) !== 0x5b /* [ */ || source.charCodeAt(start + 1) !== 0x5b) {
    return false
  }
  const end = source.indexOf(']]', start + 2)
  if (end === -1) return false

  const inner = source.slice(start + 2, end)
  if (inner.trim() === '' || inner.includes('\n')) return false

  if (!silent) {
    const token = state.push('html_inline', '', 0)
    token.content = wikilinkAnchorHtml(inner, false)
  }
  state.pos = end + 2
  return true
})

/**
 * `![[目标]]` / `![[目标|别名]]` 行内规则（Obsidian 风格的嵌入）。
 *
 * 分流规则：
 * - 目标是图片扩展名（名单见 `domain/assets.ts`，与宿主白名单一致）→ 压一个**标准 `image` 令牌**，
 *   交给下面同一个渲染规则。嵌入图片与 `![](…)` 必须只有一条路径，否则"占位 → 授权 → `<img>` →
 *   失败回退"这套约定要在两处各写一遍，两边一漂移就会出现"Markdown 图片能显示、嵌入图片不能"。
 * - 其它目标（`![[另一篇笔记]]`）→ 与普通 wikilink 完全相同的链接元素，只是多一个说明性 `title`。
 *
 * `[[x]]`（不带 `!`）不受影响：本规则第一件事就是检查前导 `!`。
 */
md.inline.ruler.before('mn_wikilink', 'mn_embed', (state, silent) => {
  const start = state.pos
  const source = state.src
  if (source.charCodeAt(start) !== 0x21 /* ! */) return false
  if (source.charCodeAt(start + 1) !== 0x5b || source.charCodeAt(start + 2) !== 0x5b) return false

  // 从 `![[` 之后（start + 3）开始找结束标记，别把位置看错
  const end = source.indexOf(']]', start + 3)
  if (end === -1) return false

  const inner = source.slice(start + 3, end)
  if (inner.trim() === '' || inner.includes('\n')) return false

  const parts = splitWikilink(inner)
  if (!silent) {
    if (isImageAssetTarget(parts.target)) {
      const token = state.push('image', 'img', 0)
      // 目标**原样**作为 src：与 `![](…)` 走同一个解析器（`resolveVaultAssetRel`）与同一套
      // 占位/授权约定，`data-mn-src` 上留给用户的也是他自己写下的那个地址。
      token.attrs = [['src', parts.target]]
      // alt：有别名用别名，没有就用文件名（`附件/图.png` → `图.png`）
      token.content = parts.alias ?? fileNameOf(parts.target)
      token.children = []
    } else {
      const token = state.push('html_inline', '', 0)
      token.content = wikilinkAnchorHtml(inner, true)
    }
  }
  state.pos = end + 2
  return true
})

/** 取路径最后一段（`附件/图.png` → `图.png`）；两种分隔符都认。 */
function fileNameOf(target: string): string {
  const segments = target.trim().split(/[\\/]/)
  return segments[segments.length - 1] ?? target
}

/**
 * 这个图片是不是"独占一段"（同一段里除了它只有空白）。
 *
 * 用来决定外层容器是块级还是行内：块级才能整块居中；行内不该把 `文字 ![](x.png) 文字`
 * 这种写法拆成两行。**注意只用 `display` 区分，两种情况都是 `<span>`** ——
 * 在 `<p>` 里塞一个真正的 `<figure>` 是非法嵌套，浏览器会把段落切开、留下空 `<p>`。
 */
function isOnlyImageContent(tokens: readonly { type: string; content: string }[], idx: number): boolean {
  for (let i = 0; i < tokens.length; i += 1) {
    if (i === idx) continue
    const token = tokens[i]
    if (token === undefined) continue
    if (token.type === 'text' && token.content.trim() === '') continue
    return false
  }
  return true
}

/**
 * 解析结果只允许这几种 scheme。
 *
 * 解析器是我们自己的代码（只会产出 asset URL），但仍然做一次白名单 —— 渲染层是安全边界，
 * 不该假设上游永远正确；不匹配就退回占位元素，绝不让可疑 URL 进到 `<img src>`。
 */
const SAFE_IMAGE_URL = /^(?:https?:\/\/|asset:\/\/|blob:|data:image\/)/i

/**
 * 图片解析结果。
 *
 * - `ready`：已拿到可用的 asset URL（或已经缓存过），直接渲染 `<img>`；
 * - `unauthorized`：路径解析成功但**还没获得宿主的逐文件授权**（ADR-0007）——
 *   先渲染带 `data-mn-asset` 标记的占位元素，预览层拿到授权后再重渲染成真正的图片。
 */
export type ImageResolution =
  | { kind: 'ready'; url: string }
  | { kind: 'unauthorized'; rel: string }

/** 图片解析器（由预览层提供，`env.resolveImage`）。 */
export type ImageResolver = (source: string) => ImageResolution | null

/**
 * 图片渲染。
 *
 * "这张图能不能显示"由调用方决定（`env.resolveImage`，见 ADR-0007）：
 * - `ready` → 渲染 `<img class="mn-image">`，外面包一层 `.mn-figure`（承载图注与"点击查看原图"），
 *   并保留**原始地址**在 `data-mn-src` 上，加载失败时预览层据此回退成占位元素；
 * - `unauthorized` → 带 `data-mn-asset` 的占位元素，等宿主授权；
 * - `null` → 普通占位元素（外部地址、越界路径、非 Tauri 运行时都会走这里）。
 *
 * 占位/回退路径**不包** `.mn-figure`：预览层的失败回退是把 `<img>` 原地换成占位元素，
 * 结构必须与这里渲染出来的占位完全一致（否则"失败后"和"从没成功过"会长得不一样）。
 */
md.renderer.rules.image = (tokens, idx, _options, env, _self) => {
  const token = tokens[idx]
  const src = String(token?.attrGet('src') ?? '')
  const alt = String(token?.content ?? '')
  const title = token?.attrGet('title') ?? null
  const resolver = (env as { resolveImage?: ImageResolver } | undefined)?.resolveImage
  const resolution = typeof resolver === 'function' ? resolver(src) : null

  if (resolution === null) return imagePlaceholderHtml(src, alt)
  if (resolution.kind === 'unauthorized') {
    return imagePlaceholderHtml(src, alt, resolution.rel)
  }
  if (!SAFE_IMAGE_URL.test(resolution.url)) return imagePlaceholderHtml(src, alt)

  // 图注：优先 alt（`![[图.png|图注]]` 的别名就走这里），没有 alt 才退到 title
  const caption = alt.trim() === '' ? String(title ?? '') : alt
  const captionHtml =
    caption === '' ? '' : `<span class="mn-image__caption">${escapeHtml(caption)}</span>`
  const standalone = token !== undefined && isOnlyImageContent(tokens, idx)

  return (
    `<span class="mn-figure${standalone ? ' mn-figure--block' : ''}">` +
    `<img class="mn-image" src="${escapeHtml(resolution.url)}" alt="${escapeHtml(alt)}"` +
    ` data-mn-src="${escapeHtml(src)}" loading="lazy" decoding="async"` +
    (title === null ? '' : ` title="${escapeHtml(String(title))}"`) +
    ' />' +
    captionHtml +
    // 提示元素常驻、由 CSS 决定何时可见（悬停 / 被裁切时）：它只是文案，
    // 不该为了"只有大图才提示"而在渲染层猜尺寸 —— 解码后的尺寸只有浏览器知道。
    `<span class="mn-image__hint" aria-hidden="true">点击查看原图</span>` +
    '</span>'
  )
}

// 外链一律新窗口 + noopener，避免 window.opener 劫持。
// wikilink（`href="#mn-wikilink"`）是文内链接，不加 target/rel。
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  if (token !== undefined) {
    const href = token.attrGet('href') ?? ''
    const isWikilink = href === WIKILINK_HREF || token.attrGet('class') === 'mn-wikilink'
    if (!isWikilink) {
      token.attrSet('target', '_blank')
      token.attrSet('rel', 'noopener noreferrer nofollow')
    }
  }
  return defaultLinkOpen(tokens, idx, options, env, self)
}

/**
 * 图片占位元素的 HTML（渲染时与"加载失败回退"时共用，保证两种情况下结构与类名一致）。
 *
 * `src` 放在 `title` 上，让用户至少能看懂"这里原本应该显示什么"；
 * 传了 `assetRel` 就带上 `data-mn-asset`，预览层据此去宿主换取读权限。
 */
export function imagePlaceholderHtml(src: string, alt: string, assetRel?: string): string {
  const label = alt === '' ? src : alt
  const marker = assetRel === undefined ? '' : ` data-mn-asset="${escapeHtml(assetRel)}"`
  return (
    `<span class="mn-image-placeholder" title="${escapeHtml(src)}"${marker}>` +
    `<span class="mn-image-placeholder__icon" aria-hidden="true">▧</span>` +
    `<span class="mn-image-placeholder__alt">${escapeHtml(label)}</span>` +
    `</span>`
  )
}

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const PURIFY_CONFIG = {
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'link', 'meta', 'base'],
  FORBID_ATTR: ['srcset', 'formaction', 'ping', 'onerror', 'onload'],
  ALLOW_DATA_ATTR: false,
  // wikilink 的 data-* 与图片的 data-mn-* 是我们自己渲染的（ALLOW_DATA_ATTR=false 会一律剥掉，因此显式放行）
  ADD_ATTR: [
    'target',
    'rel',
    'data-target',
    'data-anchor',
    'data-mn-src',
    'data-mn-asset',
    'data-mn-embed',
    'loading',
    'decoding',
  ],
  // 默认白名单里没有 `asset:`（macOS/Linux 上 asset URL 就是 `asset://…`）；不加这一条会出现
  // "Windows 正常、macOS 图片全被净化掉"的平台差异（Windows 上是 http://asset.localhost）。
  ALLOWED_URI_REGEXP:
    /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|asset):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
}

/** 净化一段 HTML。 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, PURIFY_CONFIG)
}

/** 渲染 Markdown 为**已净化**的 HTML。`env` 会原样传给 markdown-it 规则（例如 `resolveImage`）。 */
export function renderMarkdown(source: string, env: Record<string, unknown> = {}): string {
  return sanitizeHtml(md.render(source, env))
}

/** 渲染行内 Markdown（标题、列表项等场景）。 */
export function renderInline(source: string): string {
  return sanitizeHtml(md.renderInline(source))
}

/** 提取纯文本（用于统计/摘要，不渲染 HTML）。 */
export function renderPlainText(source: string): string {
  return source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_>~-]/g, ' ')
}
