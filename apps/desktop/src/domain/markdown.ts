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

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
})

// 外链一律新窗口 + noopener，避免 window.opener 劫持。
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  if (token !== undefined) {
    token.attrSet('target', '_blank')
    token.attrSet('rel', 'noopener noreferrer nofollow')
  }
  return defaultLinkOpen(tokens, idx, options, env, self)
}

// 图片占位（M1 限制，见 docs/architecture.md §8.1）
md.renderer.rules.image = (tokens, idx, _options, _env, _self) => {
  const token = tokens[idx]
  const src = String(token?.attrGet('src') ?? '')
  const alt = String(token?.content ?? '')
  return (
    `<span class="mn-image-placeholder" title="M1 暂不渲染本地图片：${escapeHtml(src)}">` +
    `<span class="mn-image-placeholder__icon" aria-hidden="true">▧</span>` +
    `<span class="mn-image-placeholder__alt">${escapeHtml(alt === '' ? src : alt)}</span>` +
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
  ADD_ATTR: ['target', 'rel'],
}

/** 净化一段 HTML。 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, PURIFY_CONFIG)
}

/** 渲染 Markdown 为**已净化**的 HTML。 */
export function renderMarkdown(source: string): string {
  return sanitizeHtml(md.render(source))
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
