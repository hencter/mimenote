/**
 * `[[链接]]` 的悬停预览（Obsidian 的 hover preview）。
 *
 * ## 它解决什么
 *
 * 写法上 `[[设计]]` 只是四个字，读的时候却想先知道"那篇里写了什么"再决定要不要跳过去。
 * 点一下跳走＝把当前的位置丢掉（还得找回来），所以需要一个**不打断写作**的出口：
 * 鼠标停在链接上，短暂停留之后弹一张只读小卡片。
 *
 * ## 判据只有一份（这一条决定了很多"看起来绕"的写法）
 *
 * "鼠标底下这一块是不是 wikilink、目标是谁"**不是**在这里重新解析 Markdown，而是读
 * Live Preview 装饰已经算好的结果：
 *
 * - 装饰层（`live-preview/build.ts` 的 `emitWikilink`）把 `splitWikilink` 解析出来的
 *   原始目标写在 `data-mn-wikilink` 上，这里只读这个属性 —— 命中判据就是"鼠标底下有
 *   `[data-mn-wikilink]`"，于是 `[[别名|目标]]`、`![[嵌入]]`、代码块里的假链接、
 *   frontmatter 里的假链接全都天然与编辑器一致（那些地方根本没有这条属性）；
 * - "这个目标解析到了哪一篇"读 `links-store` 的出链（宿主索引算好的 `ResolvedLink`），
 *   匹配口径是 `normalizeLinkTarget`（`domain/links.ts`，与预览面板、与点击处理器同一套）。
 *   这里**不读**装饰上的 `data-mn-resolved`：装饰是"算的那一刻"的快照，而 store 里的可能
 *   刚被索引刷新过（点击处理器之所以两个都看，是为了在索引没回来时兜底；悬停预览不弹卡片
 *   没有后果，宁可等索引，也不弹一篇指错笔记的正文）。
 *
 * ## 悬空链接不弹（这是刻意的，不是没做）
 *
 * 目标不存在时弹出来的是一张空白卡片 —— 它比不弹更糟：用户会以为那篇笔记是空的，
 * 而实际上链接的语义恰恰相反（"点击即创建"，见 `live-preview/plugin.ts` 的 `handleMouseDown`）。
 * 所以 `resolvedRelPath` 为 `null` 时**根本不进入延迟**，鼠标停多久都不弹。
 *
 * ## 延迟为什么不是 0
 *
 * 鼠标扫过一行时会连续命中好几个链接；0 延迟的表现是"卡片跟着指针一路闪"，比不弹更烦。
 * {@link HOVER_DELAY_MS} 取的是一段"看起来是停留、而不是路过"的时间。
 *
 * ## 宽限为什么需要（而不是"移进卡片就立刻收起"）
 *
 * 卡片与链接之间隔着几像素，指针从链接走到卡片必然经过一段**不在链接上**的空隙。
 * 若在 `mousemove` 命不中链接时就立刻收起，卡片会在这段空隙里被关掉 ——
 * 用户永远滚不动它（这正是"移进卡片不应该立刻收起"要解决的问题）。
 * 办法是把"指针离开链接"这件事**推迟** {@link CLOSE_GRACE_MS} 再判定，
 * 期间只要重新命中（或指针落进卡片里）就取消这次关闭。
 *
 * 代价有两条，都写在这里而不是留给下一个人去猜：
 * 1. 指针停在链接旁边几像素处，卡片会多留 {@link CLOSE_GRACE_MS} 才消失（视觉上的"余韵"）；
 * 2. 卡片是 DOM 浮层，它的存在**不再只由命中决定**，所以消失必须有别的把守：
 *    文档变更、滚动/重排、点击别处、`Esc`、编辑器失焦、以及"卡片跟着的那个链接元素离开了 DOM"
 *    （见 {@link WikiHover.revalidate}）。少了最后一条，删掉 `[[` 之后卡片会留在原地，
 *    像是卡住了一样。
 *
 * ## 副作用可逆
 *
 * 事件监听走 `ViewPlugin` 的 `eventHandlers`（CodeMirror 自己把它们挂在**内容区**上、
 * 插件销毁时自己摘掉），**没有一处 `document` / `window` 级监听**：
 * 同屏多个编辑器时，只有指针真正所在的那个实例会收到 `mousemove`，
 * 于是"卡片弹在别的格子里"这件事在结构上就不可能发生。React 的那棵小树在
 * {@link WikiHover.destroy} 里卸载。
 *
 * 顺带一条踩过的坑：卡片是 `.cm-editor` 的孩子、**不是内容区的后代**，所以指针移到卡片上
 * 之后内容区再也收不到 `mousemove` —— "移进卡片不收起"只能靠 `mouseleave` 的
 * `relatedTarget` 判据来保证（见 {@link WikiHover.onMouseLeave}）。
 */

import type { Extension } from '@codemirror/state'
import { ViewPlugin, type EditorView, type PluginValue, type ViewUpdate } from '@codemirror/view'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'

import { normalizeLinkTarget } from '@/domain/links'
import { isMarkdown } from '@/domain/paths'
import type { ResolvedLink } from '@/ipc/types'
import { useLinksStore } from '@/state/links-store'

import { WikiHoverCard, WIKI_HOVER_CLASS } from './WikiHoverCard'
// 卡片样式与卡片属于同一件事：类名写在 WikiHoverCard.tsx 里，规则写在这里，
// 两处成对维护（CSS 无法 import 常量，只能靠注释互相指认）。
// 这条 import 也是 `tests/integration/stylesheets.test.ts` 的"没有孤儿样式表"门禁要的那条链接。
import './wiki-hover.css'

/** wikilink 的目标属性（装饰层写的；命中判据的唯一来源，见模块文档）。 */
const WIKILINK_ATTR = 'data-mn-wikilink'

/**
 * 悬停多久之后弹卡片（毫秒）。
 *
 * 220ms 落在"看起来是停留、而不是路过"这一段里：写字的间歇性停顿通常在 300ms 以上，
 * 而扫过一行里几个链接时，指针在单个链接上的停留普遍不到 150ms。取 0 会让卡片跟着指针闪，
 * 取到 500ms 以上又会被当成"没反应"（用户会再停一次）。
 */
export const HOVER_DELAY_MS = 220

/**
 * 指针离开链接之后，多久才真的收起卡片（毫秒）。
 *
 * 它只为"从链接走到卡片上"这段路存在（见模块文档）。120ms 够人手走完十几像素；
 * 再长会让"移开视线之后卡片还赖着"变得明显。
 */
export const CLOSE_GRACE_MS = 120

/**
 * 卡片的位置常量（**必须与 `wiki-hover.css` 里的 `.mn-wiki-hover` 逐字一致**）。
 *
 * 为什么要在 JS 里也写一份：夹取位置要按卡片的尺寸算（下/右放不下就翻到另一侧），
 * 而 `offsetWidth` 在卡片刚挂上去的那一帧还不可靠（样式表可能还没应用、浏览器也没排版），
 * 拿它夹取会在第一帧闪一下。两份数字的同步由 `tests/features/editor/wiki-hover.test.tsx` 的样式契约用例把守
 * ——那是本仓库对"类名 ↔ CSS 规则"这类隐藏契约的通行做法（见 `theme.ts` 的 `livePreviewThemeSpec`）。
 */
export const CARD_WIDTH_PX = 380
export const CARD_MAX_HEIGHT_PX = 320

/**
 * 卡片高度的下限（像素）—— 与 `wiki-hover.css` 的 `min-height` 成对。
 *
 * 为什么是 120：标题行（约 40px）加"至少两行正文"（13px × 1.78 × 2 ≈ 46px）再加内边距，
 * 小于这个数就只能看见一个标题，那还不如不弹。上下限撞在一起时（面板被压得很矮）取下限：
 * 宁可卡片从面板底部溢出去一点，也不要它变成一条缝。
 */
export const MIN_CARD_HEIGHT_PX = 120

/** 卡片与链接之间的留白（像素）：贴着放会让"指针下面那一行"看起来像是被卡片吃掉了。 */
const CARD_GAP_PX = 8

/**
 * 卡片宿主元素的定位方式。
 *
 * 卡片是绝对定位的，需要一个定位祖先，而 `.cm-editor` 自己的样式表里没有 `position`
 * （默认 `static`）。已经定位过就不动它 —— 从这里盖掉面板自己的规则只会出怪事。
 */
const hostStyle = { position: 'relative' } as const

/** 一次命中：鼠标底下的那个链接，以及它解析到的目标笔记。 */
interface HoverHit {
  /** 装饰出来的那个 `<span data-mn-wikilink>`（取位置、也用来判断"它还在不在"）。 */
  element: HTMLElement
  /** 装饰上的原始目标（`data-mn-wikilink` 的值，逐字来自 `splitWikilink`）。 */
  target: string
  /** 解析到的笔记相对路径。 */
  relPath: string
}

/**
 * 鼠标底下这个元素是不是一个**已解析到笔记**的 wikilink。
 *
 * 三条判据，缺一不可：
 * 1. 元素在 `[data-mn-wikilink]` 上 —— "这是不是 wikilink"只有装饰层说了算；
 * 2. 出链表里能找到它、且 `resolvedRelPath` 不是 `null` —— 悬空链接不弹（见模块文档）；
 * 3. 目标是 Markdown 笔记 —— `![[图.png]]` 走的是**图片**渲染（`emitImage`），
 *    而 `![[别的笔记]]` 会退回链接渲染，那时它就是一次合法的笔记引用，照常可以预览。
 */
function hitOf(element: Element | null): HoverHit | null {
  if (element === null) return null
  const span = element.closest<HTMLElement>(`[${WIKILINK_ATTR}]`)
  if (span === null) return null
  const target = span.getAttribute(WIKILINK_ATTR)
  if (target === null || target === '') return null

  const key = normalizeLinkTarget(target)
  if (key === '') return null
  const outbound: readonly ResolvedLink[] = useLinksStore.getState().links?.outbound ?? []
  const match = outbound.find((link) => normalizeLinkTarget(link.rawTarget) === key)
  const relPath = match?.resolvedRelPath ?? null
  if (relPath === null || relPath === '') return null
  if (!isMarkdown(relPath)) return null

  return { element: span, target, relPath }
}

/** 一个夹取结果：把卡片放到哪儿（与 DOM 无关，纯数字，方便直接断言）。 */
export interface CardPlacement {
  left: number
  top: number
  width: number
  maxHeight: number
}

/**
 * 算出卡片的位置（**夹在编辑器面板内**，超出右/下边界就翻到另一侧）。
 *
 * 规则逐条说明：
 * 1. 默认贴链接**下方**（`CARD_GAP_PX`）—— "不挡住光标所在那一行"是这一条的逆命题：
 *    挡住了就等于"看一眼预览、正文那一行看不见了"，而那一行恰恰是用户正在读的；
 * 2. 下方放不下（剩余空间 < 卡片最大高度）**且上方更宽裕**时翻到链接上方；
 * 3. 右侧放不下就左移贴住右缘；左侧也放不下（面板比卡片窄）就贴住左缘 ——
 *    `Math.max(0, …)` 是给"面板比卡片还窄"留的出路：卡片会被右缘裁掉一点，
 *    但左上角永远可见（与图谱浮窗 `clampToArea` 同一条取舍）；
 * 4. 高度取"面板里剩多少就多少"（`maxHeight`，下限 {@link MIN_CARD_HEIGHT_PX}）：
 *    卡片自己滚动，绝不把面板撑出一条滚动条。
 */
export function placement(
  anchor: { left: number; top: number; bottom: number },
  frame: { width: number; height: number },
): CardPlacement {
  const width = CARD_WIDTH_PX
  const below = anchor.bottom + CARD_GAP_PX
  const spaceBelow = frame.height - below - CARD_GAP_PX
  const spaceAbove = anchor.top - CARD_GAP_PX * 2
  const flip = spaceBelow < CARD_MAX_HEIGHT_PX && spaceAbove > spaceBelow
  const maxHeight = Math.max(
    MIN_CARD_HEIGHT_PX,
    Math.min(CARD_MAX_HEIGHT_PX, Math.floor(flip ? spaceAbove : spaceBelow)),
  )
  const top = flip ? anchor.top - CARD_GAP_PX - maxHeight : below
  const left = Math.min(Math.max(0, anchor.left), Math.max(0, frame.width - width))
  return { left: Math.round(left), top: Math.round(top), width, maxHeight }
}

/** 把夹取结果写进卡片的行内样式（宽度与最大高度是布局决策，类名管不了）。 */
function applyPlacement(card: HTMLElement, position: CardPlacement): void {
  card.style.left = `${position.left}px`
  card.style.top = `${position.top}px`
  card.style.width = `${position.width}px`
  card.style.maxHeight = `${position.maxHeight}px`
}

/** 一次指针移动里"命中什么"的判定结果（判定与副作用分开，读起来才看得清发生了什么）。 */
type HoverResolution = { kind: 'card' } | { kind: 'link'; hit: HoverHit } | { kind: 'other' }

class WikiHover implements PluginValue {
  /** 已经挂上去的卡片元素；`null` = 现在没弹。 */
  private card: HTMLElement | null = null
  private root: Root | null = null
  /** 卡片跟着的那个链接（文档变更之后用它重新判定"还该不该在"）。 */
  private hit: HoverHit | null = null
  /**
   * 正在**等延迟**的那个链接元素。
   *
   * 为什么单独记一份（而不复用 `hit`）：延迟没到时卡片还不存在，而"指针在同一个链接上
   * 抖动"必须能认出来 —— 认不出来就会每抖一下就重置计时器，用户在链接上微动鼠标反而
   * 永远等不到卡片。它同时是"这一次计时到底为了谁"的唯一凭据。
   */
  private pending: HTMLElement | null = null
  /** 延迟计时器（{@link HOVER_DELAY_MS} 与 {@link CLOSE_GRACE_MS} 共用一份：两者不会同时需要）。 */
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly view: EditorView) {
    if (getComputedStyle(view.dom).position === 'static') {
      Object.assign(view.dom.style, hostStyle)
    }
  }

  /**
   * 指针在编辑器里移动。
   *
   * 返回 `void`（不是 `true`）：这个处理器**什么都不吃掉** —— 选词、拖放、链接自身的
   * 点击路径一个字都不改。悬停预览最不该做的事，就是让"按住鼠标划一段文字"变得和以前不一样。
   */
  onMouseMove(event: MouseEvent): void {
    const element = this.elementAt(event)
    const resolution = this.resolve(element)

    // 指针在卡片里（用户正在读、正在滚）：保住它。真实浏览器里走到卡片上之后内容区
    // 已经收不到 `mousemove` 了（见 `onMouseLeave`），所以这一条是兜底
    if (resolution.kind === 'card') {
      this.cancelTimer()
      return
    }
    // 指针还在"卡片跟着的那个链接"上（气泡、子节点、同一段文字内移动）：什么都不做
    if (
      this.hit !== null &&
      resolution.kind === 'link' &&
      resolution.hit.element === this.hit.element
    ) {
      this.cancelTimer()
      return
    }
    // 已经弹着、指针去了别处：宽限之后收起（见模块文档里"宽限"那一段）
    if (this.card !== null) {
      this.schedule(CLOSE_GRACE_MS, () => this.close())
      return
    }
    // 还没弹：命中的还是**同一个**链接（指针在同一条链接上来回抖动）→ 计时不重置，
    // 否则"在一个链接上抖个不停"会永远等不到卡片
    if (resolution.kind === 'link' && this.pending === resolution.hit.element) return
    // 命中别的链接（或什么都没命中）：把上一次的计时取消，扫过一行不留尾巴
    this.cancelTimer()
    if (resolution.kind !== 'link') {
      this.pending = null
      return
    }
    const target = resolution.hit
    this.pending = target.element
    this.schedule(HOVER_DELAY_MS, () => {
      this.pending = null
      this.open(target)
    })
  }

  /**
   * 指针离开内容区（或离开文档）。
   *
   * 这里**不**走宽限，但要看 `relatedTarget`：指针走到卡片上时内容区同样会发 `mouseleave`
   * （卡片是 `.cm-editor` 的孩子，对内容区的监听来说仍然是"外面"）。
   * 少了这一条，鼠标从链接直接划到卡片上会先收到 `mouseleave`，卡片当场消失 ——
   * 那样宽限就白加了，因为这条路根本不经过 `mousemove`（踩过的坑，见模块文档）。
   */
  onMouseLeave(event: MouseEvent): void {
    const related = event.relatedTarget
    if (related instanceof Node && this.card !== null && this.card.contains(related)) {
      this.cancelTimer()
      return
    }
    this.cancelTimer()
    this.close()
  }

  /** `Esc` 收起。不 `preventDefault`：补全弹层、对话框该响应还是要响应。 */
  onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    if (this.card === null) return
    this.cancelTimer()
    this.close()
  }

  /** 点击编辑器别处：收起卡片（点卡片内部的事件在卡片自己被截住了，见 WikiHoverCard）。 */
  onMouseDown(event: MouseEvent): void {
    if (this.card === null) return
    const target = event.target
    if (target instanceof Node && this.card.contains(target)) return
    this.cancelTimer()
    this.close()
  }

  /**
   * 编辑器状态/几何变了。
   *
   * 这里**不**处理"文档变了"：`update` 跑在 CodeMirror 把新状态落进 DOM **之前**，
   * 那一刻旧的 `<span data-mn-wikilink>` 还在原地，重新判定会得出"卡片还好好的"这种
   * 假结论（真实踩过：把 `[[设计]]` 删成普通文字之后卡片留在屏幕上）。
   * 文档那条判据挂在 {@link docViewUpdate}（DOM 更新之后才跑）。
   *
   * 剩下两种情况：
   * - **滚动 / 换行 / 字体变化**（`geometryChanged`）：**收起**，不跟着挪。这是取舍：
   *   卡片锚在一个随文档滚动的位置上，跟着挪意味着每一帧都要重新夹取（贴着面板边缘时会
   *   左右横跳），而"滚动时还留着一张浮层"本身就会挡住用户正在找的地方 —— Obsidian 也是
   *   滚开就收。代价是"边滚边看预览"做不到，那件事该用分栏，而不是悬停；
   * - **焦点离开**：用户去点文件树 / 面板了，卡片留着就是一块飘在界面上的残留。
   */
  update(update: ViewUpdate): void {
    if (update.docChanged) {
      // 文档变了之后，原来那个 pending 元素可能已经被回收：留着它会让"新的同一个链接"
      // 被误判成"还在等同一个"，于是永远不弹（这里顺手清掉，代价只是一次计时重置）
      if (this.pending !== null && !this.pending.isConnected) this.pending = null
      return
    }
    if (this.card === null) return
    if (update.focusChanged && !update.view.hasFocus) {
      this.cancelTimer()
      this.close()
      return
    }
    if (update.geometryChanged) {
      this.cancelTimer()
      this.close()
    }
  }

  /**
   * 视图把新状态画进 DOM 之后：重新判定卡片还该不该在。
   *
   * 用这个钩子而不是 `update`，理由见 {@link update}：装饰的增删在这里才真的落到 DOM 上，
   * `isConnected` / `data-mn-wikilink` 也才反映新文档。
   */
  docViewUpdate(): void {
    if (this.card !== null) this.revalidate()
  }

  destroy(): void {
    this.cancelTimer()
    this.close()
  }

  /**
   * 文档变更之后重新判定"卡片还该不该在"。
   *
   * 判据是**那个元素还在不在文档里**：`[[` 被删掉时装饰消失、`<span>` 随视图更新被移除，
   * 于是 `isConnected` 立刻为 `false`。刻意**不**按位置重新读一遍文本再解析
   * （那就等于在悬停层重写一套 Markdown 判据，见模块文档）。
   * 元素还在、但解析结果变了的极端情况（同一行上敲出另一个同目标链接、装饰复用了同一个节点）
   * 里，卡片显示的目标恰好仍是对的 —— 因为判据就是"这个元素的目标 + 出链表"。
   */
  private revalidate(): void {
    if (this.card === null) return
    const hit = this.hit
    if (hit === null || !hit.element.isConnected) {
      this.close()
      return
    }
    if (hit.element.getAttribute(WIKILINK_ATTR) !== hit.target) {
      this.close()
      return
    }
    this.reposition()
  }

  /**
   * 打开卡片。
   *
   * 计时器到期时指针可能已经走了（`mousemove` 里的取消还没跑到），所以这里再确认一次
   * 元素还在。`flushSync`：卡片必须**同步**出现在 DOM 里，紧接着的那一次定位才有东西可夹
   * —— 它同时让测试不必猜"React 什么时候把它渲染出来"（jsdom 里没有真实事件循环）。
   */
  private open(hit: HoverHit): void {
    this.timer = null
    if (!hit.element.isConnected) return
    this.hit = hit

    const card = document.createElement('section')
    card.className = WIKI_HOVER_CLASS
    this.view.dom.append(card)
    this.card = card

    const root = createRoot(card)
    this.root = root
    flushSync(() => {
      root.render(<WikiHoverCard relPath={hit.relPath} />)
    })
    this.reposition()
  }

  private close(): void {
    this.cancelTimer()
    const card = this.card
    const root = this.root
    this.card = null
    this.root = null
    this.hit = null
    this.pending = null
    if (root !== null) {
      // 先卸载再摘 DOM：React 的清理函数里若还碰得到节点，摘早了会拿到"已经不在文档里"的元素
      flushSync(() => root.unmount())
    }
    card?.remove()
  }

  /** 把卡片放到链接旁边（夹在编辑器面板内，见 {@link placement}）。 */
  private reposition(): void {
    const card = this.card
    const hit = this.hit
    if (card === null || hit === null) return
    applyPlacement(
      card,
      placement(hit.element.getBoundingClientRect(), this.view.dom.getBoundingClientRect()),
    )
  }

  /** 这次指针移动命中了什么（判定全部收在这里，副作用留给调用方）。 */
  private resolve(element: Element | null): HoverResolution {
    if (element !== null && this.card !== null && this.card.contains(element)) {
      return { kind: 'card' }
    }
    const hit = hitOf(element)
    return hit === null ? { kind: 'other' } : { kind: 'link', hit }
  }

  /**
   * 指针底下的元素。
   *
   * 优先用坐标查（`elementFromPoint`）：命中的是**渲染后**的元素（链接文字有时会被
   * 高亮 span 包住，从它往上找 `[data-mn-wikilink]` 就行），而 `event.target` 在
   * "指针停在一个覆盖层上"时会指向那个覆盖层。
   * 缺了 `elementFromPoint`（jsdom 默认就没有、某些嵌入式 WebView 也可能缺）时退回
   * `event.target`：命中判定会粗一档，但绝不凭空猜位置、更不该让处理器抛异常
   * （处理器一抛，CodeMirror 会记一条错误日志，而用户什么也看不出来）。
   */
  private elementAt(event: MouseEvent): Element | null {
    if (
      typeof document.elementFromPoint === 'function' &&
      typeof event.clientX === 'number' &&
      typeof event.clientY === 'number'
    ) {
      const element = document.elementFromPoint(event.clientX, event.clientY)
      if (element !== null) return element
    }
    return event.target instanceof Element ? event.target : null
  }

  private schedule(delay: number, run: () => void): void {
    this.cancelTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      run()
    }, delay)
  }

  private cancelTimer(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }
}

const wikiHoverPlugin = ViewPlugin.fromClass(WikiHover, {
  eventHandlers: {
    mousemove(this: WikiHover, event) {
      this.onMouseMove(event)
    },
    mouseleave(this: WikiHover, event) {
      this.onMouseLeave(event)
    },
    mousedown(this: WikiHover, event) {
      this.onMouseDown(event)
    },
    keydown(this: WikiHover, event) {
      this.onKeyDown(event)
    },
  },
})

/** 悬停预览扩展（样式随模块 import 进来，见文件头的说明）。 */
export function wikiHoverExtensions(): readonly Extension[] {
  return [wikiHoverPlugin]
}