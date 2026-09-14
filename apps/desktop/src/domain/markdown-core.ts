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
import { CALLOUT_TYPES, calloutTitle, parseCallout } from './callouts'
import { splitWikilink, wikilinkDisplayText } from './links'
import {
  TASK_CHECKED_ATTR,
  parseTaskMarker,
  taskCheckedFromAttr,
  taskCheckedValue,
} from './task-list'

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
})

/**
 * 解析成 **markdown-it 的 token 流**（不生成 HTML）。
 *
 * 为什么需要它：知识图谱的节点要**画在 canvas 上**（ADR-0021），而 canvas 没有 HTML ——
 * 只能拿着 token 自己排字。这里直接复用同一个 `md` 实例，于是"语法口径"仍然只有一份：
 * 标题/列表/引用/代码块的判定、以及我们自己的 wikilink 与嵌入规则，与阅读视图逐字一致
 * （差别只在最后一步：那边把 token 交给渲染器变 HTML，这边交给 canvas 排版）。
 *
 * ⚠️ 返回的是**内部对象**：调用方只许读，不许改（token 会被 markdown-it 复用）。
 */
export function parseMarkdownTokens(source: string, env: Record<string, unknown> = {}): MarkdownToken[] {
  return md.parse(source, env) as unknown as MarkdownToken[]
}

/** 一行 token 的宽松形状（只声明我们真的会读的字段，避免把 markdown-it 的类型泄漏出去）。 */
export interface MarkdownToken {
  type: string
  tag: string
  content: string
  children: MarkdownToken[] | null
  /** 块级 token 的层级（`bullet_list_open` → `list_item_open` …）。 */
  level: number
  /** 列表是否有序（`ordered_list_open` 上为 true）。 */
  hidden?: boolean
  attrs?: Array<[string, string]> | null
  markup?: string
  info?: string
  attrGet?: (name: string) => string | null
  /** 列表起始序号（`ordered_list_open`）。 */
  attrIndex?: (name: string) => number
}

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

/**
 * 引用块渲染：**其中一类引用是 callout**（`> [!note] 标题`），其余照旧是普通引用。
 *
 * 实现方式是"改写开闭令牌的标签与类名"，而不是把整块内容拿出来自己拼 HTML：
 * 引用块内部可能有一整个子文档（列表、代码块、表格、嵌套引用），自己拼就等于把
 * markdown-it 已经算好的块级结构再实现一遍。这里只做三件事：
 *
 * 1. 判定这**是不是** callout：看块内第一个 `paragraph_open` 后面那个 `inline` 令牌的
 *    内容是否是 `[!type]…`（判定只有一份，在 `domain/callouts.ts` 的 `parseCallout`）；
 * 2. 是的话把 `<blockquote>` 换成 `<div class="mn-callout mn-callout--type">`，
 *    并把那个"标记段落"替换成标题栏（图标 + 标题），正文部分原样留在里面；
 * 3. 不是的话一切照旧（连类名都不加，既有观感一个字不变）。
 *
 * 折叠（`[!note]-` / `[!note]+`）在**静态渲染**里不折叠：阅读视图与导出件是"读"的地方，
 * 收起正文会让读者以为内容不存在。折叠的意思是"编辑器里默认收起"，因此它只体现在所见即所得
 * 那一侧（见 `features/editor/cm/live-preview/callout.ts`）。这条取舍写进 ADR-0022。
 */
md.core.ruler.push('mn_callout', (state) => {
  const tokens = state.tokens
  for (let index = 0; index < tokens.length; index += 1) {
    const open = tokens[index]
    if (open === undefined || open.type !== 'blockquote_open') continue
    // 找到块内第一个 inline：`[!type]` 必须出现在**段落的开头**
    let paragraph = -1
    let inline = -1
    for (let probe = index + 1; probe < tokens.length; probe += 1) {
      const token = tokens[probe]
      if (token === undefined) break
      if (token.type === 'blockquote_close' && token.level === open.level) break
      // 块里的第一个孩子又是一层引用：`> > [!tip]` 的标记属于**内层**引用，外层不能也认领它 ——
      // 否则同一段会被两层各改一次（外层先改，内层的 `[!tip]` 已经被换成标题栏 HTML，判据随之失效），
      // 结果是"两层引用变成两层 callout"这种没人想要的嵌套。
      if (token.type === 'blockquote_open') break
      if (token.type === 'paragraph_open' && paragraph < 0) {
        paragraph = probe
        continue
      }
      if (paragraph >= 0 && token.type === 'inline') {
        inline = probe
        break
      }
    }
    if (inline < 0) continue
    const marker = parseCallout(tokens[inline]?.content ?? '')
    if (marker === null) continue

    open.tag = 'div'
    // `mn-callout--unknown` 是给**下游**留的痕迹：类型被规范化进类名之后，"用户写的是不是
    // 系统认识的类型"在渲染流里就无法恢复了（`[!摘录]` 与 `[!note]` 的类名逐字相同）。
    // 画布那张卡片想如实说出这件事，就只能靠这里多写一个类名（见 features/graph/canvas/blocks.ts）。
    // 它不影响观感：没有任何样式挂在这个类名上，未知类型照旧按 `note` 的样子渲染。
    open.attrSet(
      'class',
      marker.known
        ? `mn-callout mn-callout--${marker.type}`
        : `mn-callout mn-callout--${marker.type} mn-callout--unknown`,
    )
    const close = tokens.findLastIndex(
      (token, at) => at > index && token.type === 'blockquote_close' && token.level === open.level,
    )
    if (close > index) {
      const closing = tokens[close]
      if (closing !== undefined) closing.tag = 'div'
    }

    // 标记那一段变成标题栏：图标 + 标题（标题为空时用类型展示名；未知类型用用户写的名字）。
    // 段落内容可能是 "[!note] 标题\n正文"（CommonMark 里相邻两行引用是**同一个段落**），
    // 因此这里还要把正文切出来重新排成一段 —— 直接整段塞进标题栏会把正文也变成标题。
    const title = calloutTitle(marker)
    const definition = CALLOUT_TYPES[marker.type]
    const heading = state.tokens[paragraph]
    const titleToken = state.tokens[inline]
    if (heading === undefined || titleToken === undefined) continue

    // 先把这一段的闭合标签也对齐（`paragraph_close` 默认是 `</p>`，与开标签必须成对）
    const paragraphClose = tokens.findIndex(
      (token, at) =>
        at > inline && token.type === 'paragraph_close' && token.level === heading.level,
    )
    if (paragraphClose > inline) {
      const closing = tokens[paragraphClose]
      if (closing !== undefined) closing.tag = 'div'
    }
    heading.tag = 'div'
    heading.attrSet('class', 'mn-callout__title')

    // 折叠标记在静态渲染里只作为**说明**出现（不真的收起），让读者知道作者写了它
    const foldHint =
      marker.fold === null
        ? ''
        : `<span class="mn-callout__fold" aria-hidden="true">${marker.fold}</span>`
    // 图标只用**字形**：`data-*` 会被净化器剥掉（ALLOW_DATA_ATTR 关着，见 domain/markdown.ts），
    // 而字形在导出件里不依赖字体或脚本 —— 多一个属性只会多一处要被放行的白名单。
    titleToken.type = 'html_block'
    titleToken.content =
      `<span class="mn-callout__icon" aria-hidden="true">${definition.glyph}</span>` +
      `<span class="mn-callout__label">${escapeHtml(title)}</span>` +
      foldHint
    titleToken.children = null

    if (marker.body !== '') {
      // 正文重新走一遍**行内解析**（粗体/链接/wikilink 都要照常），排成标记栏之后的段落。
      // 用 `md.parseInline` 而不是自己拼字符串：拼接会丢掉行内规则与转义口径。
      const bodyChildren = md.parseInline(marker.body, state.env)[0]?.children ?? []
      const bodyTokens = [
        new state.Token('paragraph_open', 'p', 1),
        Object.assign(new state.Token('inline', '', 0), {
          content: marker.body,
          children: bodyChildren,
        }),
        new state.Token('paragraph_close', 'p', -1),
      ]
      // 插在标记段的闭合标签之后，这样正文与标题栏是同级兄弟
      const at = paragraphClose > inline ? paragraphClose + 1 : inline + 1
      tokens.splice(at, 0, ...bodyTokens)
    }
  }
})

/**
 * 任务列表：`- [ ] 待办` / `- [x] 已完成` → 真正带复选框的列表项。
 *
 * markdown-it 的默认 preset **没有** task-list 插件（我们也不引第三方依赖），所以在这条规则之前，
 * `- [ ] 待办` 在 token 流里就是一个普通列表项、正文是纯文本 `[ ] 待办` ——
 * 阅读视图据此画出来的是"项目符号 + 字面的方括号"，也就是用户报的那个问题。
 *
 * 判据只有一份（`domain/task-list.ts` 的 `parseTaskMarker`），这里只做三件事：
 * 1. 认出**任务项**（看下面两个 `continue` 处的说明）；
 * 2. 把标记从文字里**去掉**（否则复选框旁边还会再留一份 `[ ]`）；
 * 3. 把结论写到 `list_item_open` 上 —— 渲染器据此出复选框，知识图谱画布据此画勾选框
 *    （`features/graph/canvas/blocks.ts` 只读 token，看不到 HTML），两边读同一个属性。
 *
 * ⚠️ 只改 token、不拼 HTML 字符串：与 `mn_callout` 同一条纪律 —— 自己拼 HTML 就等于把
 * markdown-it 已经算好的块级结构再实现一遍（引用块里可能有整篇子文档，列表项也一样）。
 */
md.core.ruler.push('mn_task_list', (state) => {
  const tokens = state.tokens
  for (let index = 0; index < tokens.length; index += 1) {
    const item = tokens[index]
    if (item === undefined || item.type !== 'list_item_open') continue

    // 标记必须出现在**这一项第一段的开头**。markdown-it 保证：段落若是列表项的第一个块，
    // 它就紧跟在 `list_item_open` 后面，而段落里恒有且只有一个 `inline`。
    // 为什么不"往下找第一个段落"：`- 前言\n\n  - [x] 子项` 里内层的 `list_item_open`
    // 会被同一趟循环各判一次（各看各的第一段），往下搜会让**父条目**认领子条目的标记。
    const paragraph = tokens[index + 1]
    const inline = tokens[index + 2]
    if (paragraph === undefined || paragraph.type !== 'paragraph_open') continue
    if (inline === undefined || inline.type !== 'inline') continue

    // 第一个行内 token 必须是**普通文字**：`- **[x]** 手写` 的第一个孩子是 `strong_open`，
    // 那说明方括号被用户写进了粗体（或任何别的行内元素）里 —— 那是有含义的正文，不是标记。
    // 同理 `- [[链接]] [x] 后面` 的第一个孩子是 `html_inline`（wikilink），也不算。
    const first = inline.children?.[0]
    if (first === undefined || first.type !== 'text') continue

    // ⚠️ 判据喂的是**段落原文**（`inline.content`），不是已解析出来的文字：
    // `- \[x\] 不是任务` 里 markdown-it 已经把 `\[` 变成了普通文字 `[`，
    // 只看文字的话"它本来带反斜杠"这件事已经无从分辨，会把用户**显式转义**的方括号认成任务项。
    const marker = parseTaskMarker(inline.content)
    if (marker === null) continue
    // 同一份判据再用在文字上：只有确认这个 token 真的以标记开头，才知道从哪儿切。
    // 两个结果必然一致（看的是同一段开头）；不一致只可能出在"token 流被别的规则改过"上，
    // 那种情况下什么都不做 —— 少画一个复选框远好过把用户的文字切掉一截。
    const leading = parseTaskMarker(first.content)
    if (leading === null) continue

    first.content = leading.rest
    item.attrSet(TASK_CHECKED_ATTR, taskCheckedValue(marker.checked))
  }
})

/** 任务项的类名（与 `styles/app.css` / 导出样式里的选择器是同一份契约）。 */
const TASK_ITEM_CLASS = 'mn-task-item'
/** 已完成的修饰类名（"文字变暗"挂在这个类名上，不是挂在复选框上）。 */
const TASK_ITEM_DONE_CLASS = 'mn-task-item--done'

/**
 * 任务列表里那个复选框的 HTML。
 *
 * 为什么用真的 `<input type="checkbox" disabled>` 而不是画一个 `<span>`：
 *
 * 1. **没有样式表也长得对**。静态站点是"一个目录"（ADR-0019）：某个页面被单独拷出去、
 *    `assets/site.css` 没跟上时，`<span>` 画法会**整个消失**（它只是一块背景色/边框），
 *    而原生复选框由浏览器绘制，样式全丢也照样看得出"这里有个勾选框、勾没勾上"。
 * 2. **读屏软件原生认识它**。`role="checkbox"` 挂在一个不可聚焦的 `<span>` 上是 ARIA 滥用
 *    （它宣称自己是个可操作控件，用户却点不动它）；而原生 input 的"复选框，已选中，已禁用"
 *    是浏览器与读屏软件之间早就有的约定，不需要我们自己编一套。
 *
 * `disabled` 是**语义的一部分**，不是图省事：阅读视图 / 导出件 / 打印 / 静态站点都是**只读**的，
 * 勾选意味着改文档，而改文档的唯一通道是编辑器（那边的复选框是另一套实现，
 * 见 `features/editor/cm/live-preview/widgets.ts` 的 `TaskCheckboxWidget`）。
 * 一个点得动的复选框在这里只会让人以为"点了就会存下来"，而它点下去什么都不发生。
 * 这条不变量在 `domain/markdown.ts` 的净化钩子里还会被**再钉一遍**（任何不是"禁用复选框"的
 * `input` 一律移除）—— 因为净化器的白名单只能表达"允许 input 出现"，表达不了"必须是禁用的"。
 *
 * `aria-label` 说的是**状态**：禁用的表单控件在部分读屏软件的浏览模式下会被跳过，
 * 那时至少让"已完成/未完成"这几个字作为文本读得出来。
 */
function taskCheckboxHtml(checked: boolean): string {
  return (
    '<input type="checkbox" class="mn-task-item__box" disabled' +
    (checked ? ' checked' : '') +
    ` aria-label="${checked ? '已完成' : '未完成'}" />`
  )
}

/**
 * 任务项的 `<li>` 与它开头那个复选框。
 *
 * 复选框由**渲染器**追加在 `<li>` 之后，而不是塞一个 `html_inline` 令牌进段落里：
 * 复选框属于"列表项"这件结构，不属于段落的行内内容 —— 塞进 children 会让所有读 token 的人
 * （画布就是其中之一）在自己的行内循环里遇到一个与文字无关的令牌。
 *
 * `self.renderToken` 负责拼 `<li>` 本身（属性转义由它保证，这里不自己拼字符串），
 * 本规则只做两件它不会做的事：写状态类名、在后面接上复选框。
 */
md.renderer.rules.list_item_open = (tokens, idx, options, _env, self) => {
  const token = tokens[idx]
  // `attrGet` 的静态类型把数字也算了进来（markdown-it 给 `ordered_list_open` 的 `start` 返回的就是数字），
  // 而这个属性只有 `'1'`/`'0'` 两种写法：先收敛成字符串再交给读端
  const raw = token?.attrGet(TASK_CHECKED_ATTR)
  const checked = raw === undefined || raw === null ? undefined : taskCheckedFromAttr(String(raw))
  if (token === undefined || checked === undefined) return self.renderToken(tokens, idx, options)

  // ⚠️ 内部属性到此为止：它是"token 消费者之间"的通信，不该出现在 HTML 里。
  // 渲染规则改 token 是允许的（上面的 `link_open` 也在改，markdown-it 自己的规则同样如此），
  // 而且每个 token 流只服务一次渲染（`md.render` 每次重新解析）。
  token.attrs = (token.attrs ?? []).filter(([name]) => name !== TASK_CHECKED_ATTR)
  token.attrSet('class', checked ? `${TASK_ITEM_CLASS} ${TASK_ITEM_DONE_CLASS}` : TASK_ITEM_CLASS)
  return self.renderToken(tokens, idx, options) + taskCheckboxHtml(checked)
}

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
