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
 *
 * 解析（markdown-it + 我们自己的规则）在 `domain/markdown-core.ts`：那一层可以被 Web Worker 加载，
 * 这一层**不能** —— DOMPurify 的 ESM 入口在没有 `window` 的环境里 `isSupported === false`，
 * `DOMPurify.sanitize` 甚至没有被定义（在 Worker 里调用是直接抛 `TypeError`）。
 * 所以 Worker 只负责"正文 → 未净化 HTML"，净化与落地永远留在主线程；见 `features/preview/preview-worker.ts`。
 */

import DOMPurify from 'dompurify'

import { imageHtml, parseInline, parseMarkdown, type ImageSpec } from './markdown-core'

export type { ImageResolution, ImageResolver, ImageSpec, WikilinkResolver } from './markdown-core'
export { imageHtml, imageSpecFromElement } from './markdown-core'

/**
 * 图片占位元素的 HTML（渲染时与"加载失败回退"时共用，保证两种情况下结构与类名一致）。
 *
 * `src` 放在 `title` 上，让用户至少能看懂"这里原本应该显示什么"；
 * 传了 `assetRel` 就带上 `data-mn-asset`，预览层据此去宿主换取读权限。
 *
 * 这个三参数签名只留给"**没有**完整规格"的调用方（例如图片加载失败时的就地回退：
 * 那时只剩原始地址与 alt）。有完整规格时应当直接用 {@link imageHtml} ——
 * 两条路径最终拼 HTML 的只有它一个，理由见 `domain/markdown-core.ts` 的 `ImageSpec`。
 */
export function imagePlaceholderHtml(src: string, alt: string, assetRel?: string): string {
  const spec: ImageSpec = { src, alt, title: null, width: null, height: null, block: false, assetRel }
  return imageHtml(spec)
}

const PURIFY_CONFIG = {
  /**
   * 禁用标签：不给笔记内容（以及将来可能引入的渲染插件）留下任何"能骗到一次交互"的东西 ——
   * 脚本、样式、内嵌框架、以及**能提交数据的表单**。
   *
   * ⚠️ `input` 从这里被**单独放开**了（它是唯一一个例外），理由只有一个：任务列表的复选框。
   * 那不是"我们信任 `<input>`"，而是"这一条禁令无法表达我们真正要的那件事"：
   * 白名单只能表达"允许 input 出现"，表达不了"只允许 disabled 的 checkbox"。
   * 于是那条不变量交给下面的 {@link installDisabledCheckboxOnly} 钩子在同一次遍历里强制 ——
   * 也就是说，放开的仍然只是"**禁用的复选框**"这一个小格子，而不是 `<input>` 这个标签。
   */
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'button', 'link', 'meta', 'base'],
  FORBID_ATTR: ['srcset', 'formaction', 'ping', 'onerror', 'onload'],
  ALLOW_DATA_ATTR: false,
  // wikilink 的 data-* 与图片的 data-mn-* 是我们自己渲染的（ALLOW_DATA_ATTR=false 会一律剥掉，因此显式放行）。
  // `data-mn-src`/`-alt`/`-title`/`-width`/`-height`/`-block`/`-defer` 是**占位元素上的图片规格**：
  // 剥掉任意一个，补图时就只能靠猜（补出来的图与整篇渲染的图会长得不一样），因此必须逐个放行。
  ADD_ATTR: [
    'target',
    'rel',
    'data-target',
    'data-anchor',
    'data-mn-src',
    'data-mn-alt',
    'data-mn-title',
    'data-mn-width',
    'data-mn-height',
    'data-mn-block',
    'data-mn-defer',
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

/**
 * 把 `input` 的放行收窄到"**禁用的复选框**"这一种。
 *
 * 为什么需要这个钩子（而不是在 `PURIFY_CONFIG` 里配一下了事）：DOMPurify 的白名单是
 * "标签/属性允许出现吗"这种一维判断，表达不了"允许 input，但只有当它是
 * `<input type="checkbox" disabled>` 时"。而 `FORBID_TAGS` 里那条 `input` 禁令本来服务的是
 * **纵深防御** —— 挡住将来某个渲染插件（或一次手滑）产出表单控件。
 * 直接把它删掉，等于为了一行 Markdown 语法把这层防御整片撤掉。
 *
 * 所以这里把不变量**钉死**：凡是不是"禁用的复选框"的 `input`，当场从结果里移走。
 * 代价是一次 O(元素数) 的钩子调用（`nodeName` 一次比较，非 input 立即返回），
 * 换来的是"阅读视图里不存在任何可交互控件"这件事由净化器保证，而不是由渲染器的自觉保证。
 *
 * ⚠️ 钩子在 DOMPurify 上是**全局**的，模块加载时注册一次即可：
 * 本文件是 `sanitizeHtml` 的唯一入口，而且这条不变量对全应用的净化结果都成立。
 */
function installDisabledCheckboxOnly(): void {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName !== 'INPUT') return
    const interactive = node.getAttribute('type') !== 'checkbox' || !node.hasAttribute('disabled')
    if (interactive) node.remove()
  })
}

installDisabledCheckboxOnly()

/** 净化一段 HTML。 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, PURIFY_CONFIG)
}

/**
 * 渲染 Markdown 为**已净化**的 HTML。
 *
 * `env` 与 `markdown-core.parseMarkdown` 完全一致（`resolveImage` / `resolveWikilink` / `headingIds`）。
 * 应用内的阅读视图走这一条（同步、主线程）；大文档的解析可以由 Worker 代劳，
 * 但结果仍然要回到这里净化 —— 见 `features/preview/MarkdownPreview.tsx` 的渲染管线。
 */
export function renderMarkdown(source: string, env: Record<string, unknown> = {}): string {
  return sanitizeHtml(parseMarkdown(source, env))
}

/** 渲染行内 Markdown（标题、列表项等场景）。 */
export function renderInline(source: string): string {
  return sanitizeHtml(parseInline(source))
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
