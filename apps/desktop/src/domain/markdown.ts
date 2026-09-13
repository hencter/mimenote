/**
 * Markdown 渲染 + XSS 净化。
 *
 * 安全模型（见 `docs/architecture.md` §5）——两道防线缺一不可：
 * 1. `markdown-it` 关闭 raw HTML（`html: false`）：笔记里的 `<script>` 只会变成纯文本；
 * 2. DOMPurify 二次净化：即便未来开启 HTML 或引入渲染插件，也拦住 javascript: 之类的载荷。
 *
 * 另外：M1 不渲染本地图片（`asset:` 协议作用域需要按 Vault 动态注入，M2 提供），
 * 图片会渲染为可读的占位元素，避免出现"碎图标"。
 */

import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'

import { splitWikilink, wikilinkDisplayText } from './links'

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
})

/**
 * `[[wikilink]]` 行内规则。
 *
 * 渲染成带 `data-target` 的 `<a>`：**是否解析得到具体笔记由宿主索引决定**，
 * 预览层只负责渲染 + 挂载后按索引结果补类名（见 MarkdownPreview）。
 * `href` 用文内锚点是为了让它可聚焦、可键盘激活（`href="#"` 会被点击处理器拦截）。
 */
const WIKILINK_HREF = '#mn-wikilink'

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
    const parts = splitWikilink(inner)
    const display = wikilinkDisplayText(parts)
    const token = state.push('html_inline', '', 0)
    token.content =
      `<a class="mn-wikilink" href="${WIKILINK_HREF}"` +
      ` data-target="${escapeHtml(parts.target)}"` +
      ` data-anchor="${escapeHtml(parts.anchor ?? '')}">${escapeHtml(display)}</a>`
  }
  state.pos = end + 2
  return true
})

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
 * - `ready` → 渲染 `<img class="mn-image">`，并保留**原始地址**在 `data-mn-src` 上，
 *   加载失败时预览层据此回退成占位元素（失败即降级，绝不留裂图）；
 * - `unauthorized` → 带 `data-mn-asset` 的占位元素，等宿主授权；
 * - `null` → 普通占位元素（外部地址、越界路径、非 Tauri 运行时都会走这里）。
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

  return (
    `<img class="mn-image" src="${escapeHtml(resolution.url)}" alt="${escapeHtml(alt)}"` +
    ` data-mn-src="${escapeHtml(src)}" loading="lazy" decoding="async"` +
    (title === null ? '' : ` title="${escapeHtml(String(title))}"`) +
    ' />'
  )
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
