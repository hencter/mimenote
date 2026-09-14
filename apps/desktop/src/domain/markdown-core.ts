/**
 * Markdown **解析**层：markdown-it 实例、我们自己的行内/嵌入/wikilink/图片规则，
 * 以及"图片该长成什么样"的唯一一份 HTML 生成器。
 *
 * 为什么要把这一层从 `domain/markdown.ts` 拆出来：整篇渲染里只有**解析**（markdown-it，
 * 1 MiB 文档实测约 674ms）能搬进 Web Worker；而同一份实测里净化（DOMPurify，3469ms）占了
 * 约 84%，它**搬不走** —— DOMPurify 的 ESM 入口在没有 `window` 的环境里
 * `isSupported === false`，连 `DOMPurify.sanitize` 都**没有被定义**（在 Worker 里调用是直接抛
 * `TypeError`，不是"慢一点"）。所以拆分的判据是"能不能进 Worker"，而不是"哪边代码多"：
 * 本文件**不 import DOMPurify**，也不碰 `window`/`document`，因此可以被 `render.worker.ts` 安全加载。
 *
 * 净化的那一道防线仍在 `domain/markdown.ts`（`sanitizeHtml`），
 * **任何**渲染结果都要先过它才能进 DOM —— 拆出本文件没有削弱两道防线里的任何一道。
 */

import MarkdownIt from 'markdown-it'

import { isImageAssetTarget, parseImageSize } from './assets'
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
 * `![[目标]]` → `<a>` 之外的**另一种出口**：整库导出静态站点时，链接要指向另一份 HTML。
 *
 * 由 `env.resolveWikilink` 提供：返回 href 就按它渲染 `<a>`，返回 `null` 表示这个目标**不存在**
 * （悬空链接）—— 那时渲染成不可点的 `<span>`，而不是一个点下去什么都不会发生的 `<a href="#mn-wikilink">`。
 *
 * 为什么做成 env 钩子而不是让导出侧去改渲染出来的 HTML 字符串：改写 HTML 要对"我们自己生成的
 * 属性顺序"做正则，那是把一份契约偷偷埋进字符串里；钩子让"链接指向哪"只有一处判断，
 * 而**规则本身**（谁能解析到谁）依然只有链接索引那一份 —— 这里拿到的已经是解析结果。
 */
export type WikilinkResolver = (target: string, anchor: string | null) => string | null

function resolveWikilinkHref(
  env: Record<string, unknown>,
  target: string,
  anchor: string | null,
): { href: string | null; resolved: boolean } {
  const resolver = (env as { resolveWikilink?: WikilinkResolver }).resolveWikilink
  if (typeof resolver !== 'function') return { href: WIKILINK_HREF, resolved: false }
  return { href: resolver(target, anchor), resolved: true }
}

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
function wikilinkAnchorHtml(
  inner: string,
  embed: boolean,
  env: Record<string, unknown> = {},
): string {
  const parts = splitWikilink(inner)
  const display = escapeHtml(wikilinkDisplayText(parts))
  const body = embed
    ? `<span class="mn-wikilink__embed" title="${NON_IMAGE_EMBED_TITLE}">${display}</span>`
    : display
  const { href, resolved } = resolveWikilinkHref(env, parts.target, parts.anchor ?? null)
  const data =
    ` data-target="${escapeHtml(parts.target)}"` +
    ` data-anchor="${escapeHtml(parts.anchor ?? '')}"` +
    (embed ? ` data-mn-embed="non-image" title="${NON_IMAGE_EMBED_TITLE}"` : '')

  // 悬空（解析器明确说"没有这个目标"）：渲染成不可点的文字，并把原因写在 title 上。
  // **只有**解析器在场时才这么做 —— 应用内的预览没有这个钩子，它靠索引异步补类名与跳转行为。
  if (resolved && href === null) {
    return (
      `<span class="mn-wikilink mn-wikilink--dangling"` +
      ` data-target="${escapeHtml(parts.target)}"` +
      ` title="还不存在的笔记：${escapeHtml(parts.target)}"` +
      `>${body}</span>`
    )
  }

  return `<a class="mn-wikilink" href="${escapeHtml(href ?? WIKILINK_HREF)}"${data}>${body}</a>`
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
    token.content = wikilinkAnchorHtml(inner, false, state.env as Record<string, unknown>)
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
      // 别名有两种含义（Obsidian 的约定）：`|300` / `|300x200` 是**尺寸**，
      // 其余是图注。尺寸走 `data-mn-*` 传给渲染规则 —— 那里才知道最终要不要出图注元素。
      const size = parseImageSize(parts.alias)
      if (size !== null) {
        token.attrs.push(['data-mn-width', String(size.width)])
        if (size.height !== null) token.attrs.push(['data-mn-height', String(size.height)])
      }
      // alt：有别名用别名（尺寸标记不算别名），没有就用文件名（`附件/图.png` → `图.png`）
      token.content = size === null ? (parts.alias ?? fileNameOf(parts.target)) : fileNameOf(parts.target)
      token.children = []
    } else {
      const token = state.push('html_inline', '', 0)
      token.content = wikilinkAnchorHtml(inner, true, state.env as Record<string, unknown>)
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
 * **不带 scheme** 的相对地址也放行（`assets/附件/图.png`、`../图.png`）。
 *
 * 为什么必须放行：整库导出的静态站点把图片**复制**进 `assets/`，页面里引的是相对路径 ——
 * 那是"这份目录拷到任何地方都能看"的唯一写法（内嵌 `data:` 会让同一张图在几千个页面里各存一份，
 * 见 ADR-0019）。安全上没有放松：这里拒绝任何 scheme（含 `javascript:`）与协议相对地址（`//host/x`），
 * 相对地址在浏览器里只可能解析到同一个目录树内，执行不了脚本。
 */
const RELATIVE_IMAGE_URL = /^(?!\s*\/\/)[^\\:?#]*$/i

/** 渲染层认可的图片地址：白名单 scheme，或"没有 scheme 的相对地址"。 */
function isSafeImageUrl(url: string): boolean {
  return SAFE_IMAGE_URL.test(url) || RELATIVE_IMAGE_URL.test(url)
}

/**
 * 图片解析结果。
 *
 * - `ready`：已拿到可用的 asset URL（或已经缓存过），直接渲染 `<img>`；
 * - `unauthorized`：路径解析成功但**还没获得宿主的逐文件授权**（ADR-0007）——
 *   先渲染带 `data-mn-asset` 标记的占位元素，预览层拿到授权后再把它**就地**换成真正的图片。
 */
export type ImageResolution =
  | { kind: 'ready'; url: string }
  | { kind: 'unauthorized'; rel: string }

/** 图片解析器（由预览层提供，`env.resolveImage`）。 */
export type ImageResolver = (source: string) => ImageResolution | null

/**
 * 图片的**渲染规格**：整篇渲染与"补图"两条路径共用同一份数据。
 *
 * 为什么要把规格做成一等公民（而不是让两条路径各自拼字符串）：图片元素的属性有七八个
 * （`data-mn-src` / `alt` / `title` / `width` / `height` / 外层容器是不是块级…），
 * 少一个、类名差一个，就会出现"授权后补出来的图"与"整篇渲染出来的图"长得不一样 ——
 * 而这两张图在**同一篇笔记**里会同时存在（有的图在缓存里、有的不在），
 * 灯箱与"加载失败回退"按属性判断时就会一半正常一半失效。
 *
 * 占位元素会把整份规格**搬到自己身上**（`data-mn-*`）：补图时唯一的依据就是它
 * （那时已经没有 markdown 令牌了），所以规格必须无损可读 —— 见 {@link imageSpecFromElement}。
 */
export interface ImageSpec {
  /** 原始地址（`data-mn-src`）：进 `title`、进灯箱、也是失败回退时的说明。 */
  src: string
  alt: string
  /** markdown 的 `"标题"`（`![](x.png "说明")`）；没有就是 `null`（与"空字符串标题"是两回事）。 */
  title: string | null
  width: number | null
  height: number | null
  /** 独占一段（块级居中）。补图时必须带上，否则换成 `<img>` 后容器会退化成行内。 */
  block: boolean
  /** Vault 相对路径：非空 = "目标已解析、等宿主授权"（渲染成带标记的骨架占位）。 */
  assetRel?: string | undefined
  /** 目标**还没解析**（Worker 里没有全库索引）：交给主线程补解析后再走授权。 */
  defer?: boolean | undefined
  /** 已授权的 asset URL：非空 → 出整块 `<img>`；空/不安全 → 出占位元素。 */
  url?: string | undefined
}

/**
 * 图片的 HTML：**整篇渲染**与**补图**唯一的生成器（`<img>` 整块与占位元素都出自这里）。
 *
 * 调用方只提供规格：`url` 有值就出 `<img>`，没有就出占位元素。占位/回退路径**不包** `.mn-figure`：
 * 预览层的失败回退与补图失败都是"就地换一个节点"，结构必须与这里渲染出来的占位完全一致
 * （否则"失败后"和"从没成功过"会长得不一样）。
 */
export function imageHtml(spec: ImageSpec): string {
  const url = spec.url
  if (url !== undefined && isSafeImageUrl(url)) return figureHtml(spec, url)
  return placeholderHtml(spec)
}

/**
 * `<img>` 整块（外层容器 + 图注 + "点击查看原图"提示）。
 *
 * 关于 `width`/`height`：写成**属性**（而不是内联样式）——DOMPurify 默认放行它们，
 * 而且只写宽度时浏览器会按比例缩放，与 Obsidian 的 `|宽x高` 语义一致。
 */
function figureHtml(spec: ImageSpec, url: string): string {
  // 图注：优先 alt（`![[图.png|图注]]` 的别名就走这里），没有 alt 才退到 title。
  // 写了尺寸标记时**不出图注** —— 那时的 alt 是我们补的文件名（为了无障碍），
  // 把它渲染成图注就是"图上多出一行 `图.png`"。
  const sized = spec.width !== null
  const caption = sized || spec.alt.trim() === '' ? (sized ? '' : String(spec.title ?? '')) : spec.alt
  const captionHtml =
    caption === '' ? '' : `<span class="mn-image__caption">${escapeHtml(caption)}</span>`

  return (
    `<span class="mn-figure${spec.block ? ' mn-figure--block' : ''}">` +
    `<img class="mn-image" src="${escapeHtml(url)}" alt="${escapeHtml(spec.alt)}"` +
    ` data-mn-src="${escapeHtml(spec.src)}" loading="lazy" decoding="async"` +
    (spec.width === null ? '' : ` width="${spec.width}"`) +
    (spec.height === null ? '' : ` height="${spec.height}"`) +
    (spec.title === null ? '' : ` title="${escapeHtml(spec.title)}"`) +
    ' />' +
    captionHtml +
    // 提示元素常驻、由 CSS 决定何时可见（悬停 / 被裁切时）：它只是文案，
    // 不该为了"只有大图才提示"而在渲染层猜尺寸 —— 解码后的尺寸只有浏览器知道。
    `<span class="mn-image__hint" aria-hidden="true">点击查看原图</span>` +
    '</span>'
  )
}

/**
 * 占位元素的 HTML。
 *
 * `src` 放在 `title` 上，让用户至少能看懂"这里原本应该显示什么"；
 * `assetRel` 非空就带 `data-mn-asset`，预览层据此去宿主换取读权限；
 * `defer` 表示"目标还没解析"（Worker 路径），主线程解析后再决定是授权还是终态占位。
 *
 * **待办**的占位（有 `assetRel` 或 `defer`）才把整份规格摊在 `data-mn-*` 上 —— 那时它是补图
 * 唯一的依据（见 {@link imageSpecFromElement}）。终态占位（外部地址、越界、拿不到授权、
 * 加载失败）不携带规格，理由有两条：
 * 1. "终态"就该与"从没成功过"长得**完全一样**（同一份规格去掉待办标记后也必须回到这个形状，
 *    否则"被拒绝的图"与"本来就显示不了的图"会在样式与调试信息上分叉）；
 * 2. 这些属性会一路走进整库导出的静态页面与 `dangerouslySetInnerHTML` 里，那里没有任何人读它，
 *    却多出一批要被净化白名单、HTML 正则与排查记忆同时照顾的属性名。
 *
 * ⚠️ 属性名与 {@link imageSpecFromElement} 是一份契约的读写两端，必须成对修改。
 */
function placeholderHtml(spec: ImageSpec): string {
  const label = spec.alt === '' ? spec.src : spec.alt
  const pending = spec.assetRel !== undefined || spec.defer === true
  const specAttrs = !pending
    ? ''
    : ` data-mn-src="${escapeHtml(spec.src)}"` +
      ` data-mn-alt="${escapeHtml(spec.alt)}"` +
      // 用"有没有这个属性"区分 `title: null` 与 `title: ''`：补图后要逐字节复现整篇渲染的结果
      (spec.title === null ? '' : ` data-mn-title="${escapeHtml(spec.title)}"`) +
      (spec.width === null ? '' : ` data-mn-width="${spec.width}"`) +
      (spec.height === null ? '' : ` data-mn-height="${spec.height}"`) +
      (spec.block ? ' data-mn-block="1"' : '')

  return (
    `<span class="mn-image-placeholder" title="${escapeHtml(spec.src)}"${specAttrs}` +
    (spec.assetRel === undefined ? '' : ` data-mn-asset="${escapeHtml(spec.assetRel)}"`) +
    (spec.defer === true ? ' data-mn-defer="1"' : '') +
    `>` +
    `<span class="mn-image-placeholder__icon" aria-hidden="true">▧</span>` +
    `<span class="mn-image-placeholder__alt">${escapeHtml(label)}</span>` +
    `</span>`
  )
}

/**
 * 从占位元素读回 {@link ImageSpec}（补图的输入）。
 *
 * 放在同一个文件里**就是为了不让属性名漂移**：写端（{@link placeholderHtml}）与读端
 * 各持一份字符串字面量的话，"补出来的图"迟早会和整篇渲染的图长得不一样。
 *
 * 读不出来的一律退化成"没有"（`null`/`false`/`undefined`）：这里宁可少一点信息，
 * 也不要凭猜测补一个属性上去 —— 那只会让补图结果与整篇渲染的结果不一致。
 */
export function imageSpecFromElement(element: Element): ImageSpec {
  const title = element.getAttribute('data-mn-title')
  const assetRel = element.getAttribute('data-mn-asset')
  return {
    src: element.getAttribute('data-mn-src') ?? '',
    alt: element.getAttribute('data-mn-alt') ?? '',
    // `data-mn-title=""` 与"没有这个属性"是两种不同的规格（见 placeholderHtml）
    title: title === null ? null : title,
    width: numericAttr(element.getAttribute('data-mn-width')),
    height: numericAttr(element.getAttribute('data-mn-height')),
    block: element.hasAttribute('data-mn-block'),
    assetRel: assetRel === null ? undefined : assetRel,
    defer: element.hasAttribute('data-mn-defer') ? true : undefined,
  }
}

/** 图片渲染规则。规格从令牌里取，HTML 一律交给 {@link imageHtml}。 */
md.renderer.rules.image = (tokens, idx, _options, env, _self) => {
  const token = tokens[idx]
  const src = String(token?.attrGet('src') ?? '')
  const alt = String(token?.content ?? '')
  // `attrGet` 的静态类型是 `string | number | null`（markdown-it 允许数字属性），
  // 而我们只认字符串：先收敛成 `string | null`，后面拼 HTML 的地方才不必处处转一次
  const titleAttr = token?.attrGet('title')
  const title = titleAttr === undefined || titleAttr === null ? null : String(titleAttr)
  // 尺寸标记（`![[图.png|300]]`）由嵌入规则写在 `data-mn-*` 上；`![](…)` 没有这两个属性
  const width = numericAttr(token?.attrGet('data-mn-width'))
  const height = numericAttr(token?.attrGet('data-mn-height'))
  const block = token !== undefined && isOnlyImageContent(tokens, idx)
  const options = env as { resolveImage?: ImageResolver; imageDefer?: boolean } | undefined
  const resolver = options?.resolveImage
  const resolution = typeof resolver === 'function' ? resolver(src) : null

  // `null` = "这张图不该由我出 `<img>`"：外部地址、越界路径、非 Tauri 运行时都会走这里。
  if (resolution === null) {
    // Worker 里没有全库索引（条目表可能上千条，而正文只有一份）：先出"待解析"占位，
    // 由主线程补解析 —— 否则大文档里的本地图片会永远停在"终态占位"上，一张都显示不出来。
    return imageHtml({ src, alt, title, width, height, block, defer: options?.imageDefer === true })
  }
  if (resolution.kind === 'unauthorized') {
    return imageHtml({ src, alt, title, width, height, block, assetRel: resolution.rel })
  }
  return imageHtml({ src, alt, title, width, height, block, url: resolution.url })
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

export function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** `data-mn-width="300"` 这样的属性值 → 正整数（拿不到或越界时返回 `null`）。 */
export function numericAttr(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 4000 ? parsed : null
}

/**
 * 标题锚点 id：`env.headingIds === true` 时给每个标题一个 `id`，让 `[[某篇#小节]]` 真的能跳。
 *
 * 为什么默认关：应用内的阅读视图**不需要**它（标题跳转走的是 `outline-scroll.ts` 按元素定位），
 * 而给每个标题塞一个 id 会让"渲染结果"多出一批与应用无关的属性；静态站点则需要它 ——
 * 否则那些带锚点的链接点下去只会停在页面顶部，看起来像"链接坏了"。
 *
 * id 取标题的**纯文本**（浏览器会把 `#%E5%B0%8F%E8%8A%82` 解码后再去对 id，所以无需在这里编码），
 * 同名标题按出现顺序追加 `-1`/`-2`（首个不带后缀）—— 与 Obsidian 的口径一致，
 * 也因此"重复标题的链接落到第一处"是可预期的。
 */
function installHeadingIds(env: Record<string, unknown>): void {
  const counted = new Map<string, number>()
  env['mn-heading-ids'] = counted
}

md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
  const counted = (env as Record<string, unknown>)['mn-heading-ids']
  if (counted instanceof Map) {
    const inline = tokens[idx + 1]
    const text = (inline?.content ?? '').trim()
    if (text !== '') {
      const seen = (counted.get(text) as number | undefined) ?? 0
      counted.set(text, seen + 1)
      const token = tokens[idx]
      if (token !== undefined) token.attrSet('id', seen === 0 ? text : `${text}-${seen}`)
    }
  }
  return self.renderToken(tokens, idx, options)
}

/**
 * 解析 Markdown 为 HTML（**未净化**）。
 *
 * `env` 会原样传给 markdown-it 规则，除了我们自己认的钩子之外（它们都不影响应用内的渲染）：
 * `resolveImage`（图片能不能显示，ADR-0007）、`resolveWikilink`（链接指向哪个 URL，整库导出用）、
 * `headingIds`（要不要给标题生成锚点 id，整库导出用）、`imageDefer`（图片目标交给主线程解析，Worker 路径用）。
 *
 * ⚠️ 返回值**必须**过一遍 `sanitizeHtml` 才能进 DOM（见 `domain/markdown.ts` 的两道防线）。
 */
export function parseMarkdown(source: string, env: Record<string, unknown> = {}): string {
  if (env['headingIds'] === true) installHeadingIds(env)
  return md.render(source, env)
}

/** 解析行内 Markdown（标题、列表项等场景）为 HTML（**未净化**）。 */
export function parseInline(source: string): string {
  return md.renderInline(source)
}
