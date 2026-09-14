/**
 * Live Preview 的内联 widget。
 *
 * 只做 DOM、不做数据：能不能显示图片由装饰层决定（授权是异步的），
 * 这里只负责把"已授权的 URL"或"占位文本"变成元素。
 */

import { WidgetType } from '@codemirror/view'

import type { ImageSize } from '@/domain/assets'
import { normalizeLinkTarget } from '@/domain/links'

import { LINK_ATTR, MD, WIKILINK_ATTR, WIKILINK_RESOLVED_ATTR } from './theme'
// 表格的样式与 widget 属于同一件事：类名写在 `theme.ts` 的 MD 里，规则写在这个文件里，
// 两处成对维护（CSS 无法 import 常量，只能靠注释互相指认）
import './table.css'

/** 取一个人类可读的标签（说明文字优先，其次文件名）。 */
function labelFor(rel: string, alt: string): string {
  if (alt.trim() !== '') return alt.trim()
  const name = rel.split('/').pop()
  return name === undefined || name === '' ? rel : name
}

/**
 * 图片 widget：`![说明](路径)` 在光标不在该行时被它替换。
 *
 * 为什么 `url === null` 时要退成**文本**而不是空 `<img>`：没有授权、路径越界、
 * 文件被删、浏览器预览模式都会走到这里，留一个裂图比"没有图片"更糟
 * （与预览面板 `imagePlaceholderHtml` 的取舍一致）。
 *
 * 呈现上是**块级**的（见 `theme.ts` 里 `.mn-md-image-wrap` 的说明）：它在两行之间独占一行。
 * 这里只给类名，块级/尺寸全部归样式层 —— widget 是纯 DOM、不做布局决策。
 */
export class ImageWidget extends WidgetType {
  constructor(
    private readonly url: string | null,
    private readonly rel: string,
    private readonly alt: string,
    /**
     * `![[图.png|300]]` 的尺寸标记（Obsidian 约定）。`null` = 没写，按 CSS（`max-height` 等）呈现。
     *
     * 用 `width`/`height` **属性**而不是内联样式：只写宽度时浏览器按原图比例缩放，
     * 与预览层（`domain/markdown.ts` 里渲染成同名属性）完全一致 —— 两个视图对同一篇笔记
     * 必须给出同一个尺寸，否则"编辑器里好好的、切到阅读变了个大小"。
     */
    private readonly size: ImageSize | null = null,
  ) {
    super()
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof ImageWidget &&
      other.url === this.url &&
      other.rel === this.rel &&
      other.alt === this.alt &&
      other.size?.width === this.size?.width &&
      other.size?.height === this.size?.height
    )
  }

  override toDOM(): HTMLElement {
    if (this.url === null) {
      const placeholder = document.createElement('span')
      placeholder.className = 'mn-md-image-placeholder'
      placeholder.textContent = `▧ ${labelFor(this.rel, this.alt)}`
      placeholder.title = this.rel
      return placeholder
    }

    const wrap = document.createElement('span')
    wrap.className = 'mn-md-image-wrap'
    const image = document.createElement('img')
    // `mn-md-image` 是加载失敗事件的识别依据（插件在 contentDOM 上以捕获阶段监听 error）
    image.className = 'mn-md-image'
    image.src = this.url
    image.alt = this.alt
    image.loading = 'lazy'
    image.decoding = 'async'
    image.title = this.rel
    if (this.size !== null) {
      image.width = this.size.width
      if (this.size.height !== null) image.height = this.size.height
    }
    wrap.appendChild(image)
    return wrap
  }

  /**
   * 图片 widget 内部的点击**交给编辑器忽略**：点图片不该把光标塞进这一行源码里
   * （那会让图片立刻变回 `![说明](路径)`，看起来像"点一下就坏了"）。
   * 想编辑这一行，点它旁边的空白或文字即可 —— 块级盒子只占图片自身的宽度
   * （`.mn-md-image-wrap` 的 `width: fit-content`），右边的空白仍然是可点的一行。
   */
  override ignoreEvent(): boolean {
    return true
  }
}

/**
 * 任务列表复选框。
 *
 * 为什么不用真的 `<input type="checkbox">`：它位于 `contenteditable` 的正文里，
 * 焦点与编辑行为会互相打架。这里用 span + `role="checkbox"`，点击交给插件的
 * mousedown 处理（并写回文档，见 task.ts）。
 */
export class TaskCheckboxWidget extends WidgetType {
  constructor(
    private readonly checked: boolean,
    private readonly markerFrom: number,
  ) {
    super()
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof TaskCheckboxWidget &&
      other.checked === this.checked &&
      other.markerFrom === this.markerFrom
    )
  }

  override toDOM(): HTMLElement {
    const box = document.createElement('span')
    box.className = this.checked ? 'mn-md-task-box mn-md-task-box--checked' : 'mn-md-task-box'
    box.setAttribute('role', 'checkbox')
    box.setAttribute('aria-checked', String(this.checked))
    box.setAttribute('data-mn-task', String(this.markerFrom))
    box.setAttribute('title', this.checked ? '点击标记为未完成' : '点击标记为已完成')
    box.textContent = this.checked ? '✓' : ''
    return box
  }

  /**
   * 复选框的点击必须由插件处理，所以这里**不能**返回 true。
   *
   * CodeMirror 在派发事件前会先走 `eventBelongsToEditor`：只要事件路径上有一个
   * `ignoreEvent() === true` 的 widget，事件就被整个丢掉 —— 连插件自己的 mousedown 也收不到
   * （真实踩过：复选框点了没反应）。所以返回 false，并由处理器 `preventDefault()`
   * 挡掉编辑器默认的"移动光标"。
   */
  override ignoreEvent(): boolean {
    return false
  }
}

/**
 * callout 的标记（`[!note]` → 一个图标，可能带类型名与折叠角标）。
 *
 * 为什么标题**不**进 widget：标记行剩下的文字（`> [!note] 标题` 里的"标题"）是用户写的正文，
 * 留着它就是**可编辑的真文字**（只是加粗上色），少一次"DOM 文本 ≠ 文档源码"的例外。
 * 只有标题为空时才由这里补出类型名 —— 那时候补的是一份**推断**，不是用户写的东西。
 *
 * 点击它切换折叠标记（`-` ↔ `+`）：折叠在编辑器里会真的收起正文，于是"怎么展开"必须有一个
 * 看得见的入口 —— 只靠键盘把光标移进被收起的行里，没人猜得到。点击结果走**文档变更**
 * （`callout.ts` 的 `toggleCalloutFold`），因此自动进入保存流水线，与任务勾选框同一条路径。
 */
export class CalloutMarkerWidget extends WidgetType {
  constructor(
    private readonly glyph: string,
    /** 标题为空时的类型名（已知类型是展示名，未知类型是用户写的那一个）。 */
    private readonly label: string,
    /** 标记行没有标题文字 → 名字由 widget 补。 */
    private readonly showLabel: boolean,
    private readonly fold: '-' | '+' | null,
    /** 标记区间的终点（`]` 之后、含折叠符），点击时交给插件当"改哪里"的提示。 */
    private readonly markerEnd: number,
  ) {
    super()
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof CalloutMarkerWidget &&
      other.glyph === this.glyph &&
      other.label === this.label &&
      other.showLabel === this.showLabel &&
      other.fold === this.fold &&
      other.markerEnd === this.markerEnd
    )
  }

  override toDOM(): HTMLElement {
    const marker = document.createElement('span')
    marker.className = MD.calloutMarker
    marker.setAttribute('data-mn-callout-fold', String(this.markerEnd))
    marker.setAttribute('title', this.fold === '-' ? '点击展开' : '点击收起')

    const glyph = document.createElement('span')
    glyph.className = MD.calloutGlyph
    // 字形而不是 SVG：canvas 端画的是同一个字形（`CALLOUT_TYPES` 的 `glyph`），两边看起来一致
    glyph.textContent = this.glyph
    marker.appendChild(glyph)

    if (this.showLabel) {
      const label = document.createElement('span')
      label.className = MD.calloutLabel
      label.textContent = this.label
      marker.appendChild(label)
    }

    if (this.fold !== null) {
      const fold = document.createElement('span')
      fold.className = MD.calloutFold
      fold.textContent = this.fold
      marker.appendChild(fold)
    }
    return marker
  }

  /**
   * 与复选框同一个理由（见 {@link TaskCheckboxWidget.ignoreEvent}）：点击必须由插件的
   * mousedown 处理，返回 true 会把这次事件整个丢掉，连插件自己也收不到。
   */
  override ignoreEvent(): boolean {
    return false
  }
}

/** 分隔线 `---` 的 widget：一条真正的横线，而不是三个减号。 */
export class HorizontalRuleWidget extends WidgetType {
  override eq(other: WidgetType): boolean {
    return other instanceof HorizontalRuleWidget
  }

  override toDOM(): HTMLElement {
    const rule = document.createElement('span')
    rule.className = 'mn-md-hr'
    return rule
  }

  /** 点一下横线：交给编辑器放光标（于是这一行会露出 `---` 原文，方便改） */
  override ignoreEvent(): boolean {
    return false
  }
}

/** 表格里一个 `[[wikilink]]` 的解析结果（`data-target` → 宿主索引给出的目标笔记）。 */
export interface TableWidgetLink {
  /** 与渲染出来的 `<a data-target="…">` 逐字相同的原始目标。 */
  target: string
  /** 解析到的笔记相对路径；`null` = 悬空（点击会创建）。 */
  resolvedRelPath: string | null
  /** 同名多篇（宿主给的歧义标记）。 */
  ambiguous: boolean
}

/**
 * 表格 widget：光标不在这一块里时，整块 Markdown 表格换成一张真表。
 *
 * 三件事必须一起看：
 *
 * 1. **HTML 来自唯一那条渲染管线**（`domain/markdown.ts`：markdown-it + DOMPurify），
 *    由 `table.ts` 的 `renderTableHtml` 产出。这里只把它塞进 DOM，**不做二次净化** ——
 *    再净化一遍等于引入第二个净化器，还会让"编辑器看到的"与"阅读视图看到的"有机会不一致。
 * 2. **`eq` 只看 HTML 与链接解析结果**：CodeMirror 在重算后会用 `eq` 决定"旧的 widget 能不能
 *    接着用"。装饰是每次按键都重算的，所以这里必须便宜且准确：源码变了 → HTML 变 → 重建；
 *    图片授权回来（占位 → 真图）→ HTML 变 → 重建；宿主链接索引回来 → `linkKey` 变 → 重建。
 * 3. **点击行为**：默认**不**忽略事件 —— 点表格会把光标放进这一块源码里（于是整块露出原文，
 *    与分隔线 widget 同一个出口，也是"想改就点一下"的入口）。
 *    唯一的例外见 {@link ignoreEvent}：点在图片上时把事件让给灯箱。
 */
export class TableWidget extends WidgetType {
  /** 链接解析结果的指纹（`eq` 用它判断"要不要重建 DOM"，见类文档第 2 条）。 */
  private readonly linkKey: string

  constructor(
    private readonly html: string,
    private readonly links: readonly TableWidgetLink[],
  ) {
    super()
    this.linkKey = links
      .map(
        (link) =>
          `${normalizeLinkTarget(link.target)}\u0000${link.resolvedRelPath ?? ''}\u0000${
            link.ambiguous ? '1' : '0'
          }`,
      )
      .join('\u0001')
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof TableWidget && other.html === this.html && other.linkKey === this.linkKey
    )
  }

  override toDOM(): HTMLElement {
    const root = document.createElement('div')
    root.className = MD.table

    const scroll = document.createElement('div')
    scroll.className = MD.tableScroll
    // 已净化的 HTML（见类文档第 1 条）：`innerHTML` 在这里只负责"把字符串变成节点"
    scroll.innerHTML = this.html
    root.appendChild(scroll)

    applyTableMinimumWidth(scroll)
    applyTableLinks(root, this.links)
    return root
  }

  /**
   * 图片上的事件**让给灯箱**，其余交给编辑器。
   *
   * 为什么必须区分：灯箱是 document 级捕获监听（`features/lightbox`），而它认的是
   * `img.mn-image`——表格里的图片正是这个类名。但 mousedown 会先被编辑器处理成"把光标放进
   * 表格"，于是整块立刻露出原文、widget 连同那张图片一起被换掉，等到 click 事件派发时
   * 图片已经不在 DOM 里了——表现就是"表格里的图点不开"。这里对图片返回 true，
   * 编辑器整个忽略这次事件（widget 不会被撤掉），灯箱照常收到 click。
   * 代价：图片上按 Alt+点击也不能把光标放进表格；点表格的其它地方（文字、边框）仍然是那个出口。
   */
  override ignoreEvent(event: Event): boolean {
    const target = event.target
    return target instanceof Element && target.closest('img.mn-image') !== null
  }
}

/**
 * 给表格一个与列数相称的**最小宽度**（每列 ≈ 4 个汉字 + 内边距）。
 *
 * 为什么需要：表格本身是 `width: 100%`（与阅读视图一致），而单元格文本又允许拆词换行 ——
 * 于是**任何**表格都能被压进正文宽度：一张 16 列的表会变成"每列一个字、每格折十几行"，
 * 比横向滚动难读得多。列多时把表格顶宽，`.mn-md-table__scroll` 才会真的滚动；
 * 列少的普通表格的最小宽度远小于 100%，仍然是铺满宽度的（与阅读视图一致）。
 *
 * 为什么算在 widget 里而不是写进 CSS：`min-width` 写在**单元格**上会被浏览器的自动表格布局
 * 忽略（实测：16 列 × `min-width: 4em` 仍然被压进正文宽度），写在**表格**上才有效，
 * 而 CSS 里拿不到"这张表有几列"——列数是渲染出来的 HTML 的一部分，只有这里知道。
 */
function applyTableMinimumWidth(scroll: HTMLElement): void {
  const columns = scroll.querySelectorAll('thead th').length
  const table = scroll.querySelector('table')
  if (table === null || columns === 0) return
  // 与 `table.css` 里单元格的 `padding: 6px 10px`（左右各 10px）成对维护
  table.style.minWidth = `calc(${columns * 4}em + ${columns * 20}px)`
}

/**
 * 渲染出来的结构 → 编辑器认得的标记。
 *
 * 为什么需要：`domain/markdown.ts` 的产物是给**预览组件**消费的（那里用
 * `data-target` / `href`），而编辑器的点击处理器认的是 `data-mn-wikilink` / `data-mn-link`
 * （见 plugin.ts 的 `handleMouseDown`）。两边各改一套解析器就会漂移，所以在 widget 里做一次
 * **属性翻译**，点击行为与行内链接完全同源。
 *
 * 只改属性与类名，不碰文本、不碰结构 —— 输入是已经净化过的节点树。
 */
function applyTableLinks(root: HTMLElement, links: readonly TableWidgetLink[]): void {
  const byTarget = new Map(links.map((link) => [normalizeLinkTarget(link.target), link]))

  // 行内代码复用编辑器里的 `.mn-md-code`（样式在 `theme.ts` 定义一次，这里只贴类名）
  for (const code of Array.from(root.querySelectorAll('code'))) code.classList.add(MD.code)

  for (const anchor of Array.from(root.querySelectorAll('a'))) {
    const target = anchor.getAttribute('data-target')
    if (anchor.classList.contains(MD.wikilink) && target !== null) {
      const link = byTarget.get(normalizeLinkTarget(target))
      anchor.setAttribute(WIKILINK_ATTR, target)
      // 解析结果必须带上：点击处理器优先读 store，读不到时才用这个属性 —— 少了它，
      // "索引还没回来"时点一个**已存在**的链接会被当成悬空链接去创建笔记（真实后果：多出一篇空笔记）
      anchor.setAttribute(WIKILINK_RESOLVED_ATTR, link?.resolvedRelPath ?? '')
      if (link?.resolvedRelPath == null) anchor.classList.add(MD.wikilinkUnresolved)
      else if (link.ambiguous) anchor.classList.add(MD.wikilinkAmbiguous)
      continue
    }

    const href = anchor.getAttribute('href')
    // `#mn-wikilink` 是 `domain/markdown.ts` 给 wikilink 用的文内锚点，不是一个真地址
    if (href === null || href === '' || href === '#mn-wikilink') continue
    anchor.setAttribute(LINK_ATTR, href)
  }
}
