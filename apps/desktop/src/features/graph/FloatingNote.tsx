/**
 * 浮动笔记面板（图谱上的"浮窗"，Obsidian 的 hover editor 那一种形态）。
 *
 * ## 它解决什么
 *
 * 卡片正面虽然就是正文预览，但它是 canvas 上的一帧：文字选不中、链接点不动。
 * 想"一边看着 A、一边顺着 A 里的链接读 B"，就需要一个真正的 DOM 阅读窗口。
 * 浮动面板允许**同时开好几个**这样的窗口：各自可拖动、可缩放，点一下置顶（`onRaise`），
 * `Esc` 关掉最上面那个。（它顶替的是曾经的停靠预览面板 `GraphPreview`，后者已随 ADR-0025 移除。）
 *
 * ## 它是**完全受控**的
 *
 * 位置与大小（`rect`）、层级（`zIndex`）、谁是"最上面"（`active`）全部来自 props，
 * 面板自己不持有这些状态。一次拖动里它按位移算出新 rect 并 `onMove` 上报，写不写回由调用方决定。
 *
 * 为什么不自己存一份、再想办法同步回去：那就有两个真相来源。调用方想"把浮窗吸附到网格"、
 * "换 Vault 时按新尺寸重排"、"记住上次的位置"时，都得先跟自己组件内部的状态打架。
 * 受控在这里只有一个约定：**调用方把它收到的那个 rect 写回**（拖动时按帧写回，
 * 面板才会跟着指针走）。唯一由组件内部持有的状态是"当前这一次按住"的起点快照（`gestureRef`）——
 * 它不需要跨渲染保留任何东西，也不该让父组件知道。
 *
 * ## 为什么不引 react-rnd / react-draggable / floating-ui
 *
 * 这一层要的只有三件事：按住标题栏改 x/y、拖右下角改 width/height、别跑出可视区域。
 * 自己写约一百行、没有隐藏语义；而上面那几家各自带着一整套事件模型（触摸手势、自己的
 * capture 策略、自动边界吸附、ResizeObserver、portal 挂载），要和本仓库**已经定下来的**
 * 画布指针约定（`data-mn-graph-nopan` + `setPointerCapture` 的 try/catch）对齐反而更费事，
 * 还多一条供应链与包体积的长期成本（见 `docs/dependencies.md` 开头那条原则：能用少量代码
 * 自己写对的，不引三方）。
 *
 * ## 与画布的三处接线
 *
 * 1. **根元素带 `data-mn-graph-nopan`**：`GraphCanvas.handlePointerDown` 靠它把"这一块不参与
 *    画布平移"筛出去。少了它，在面板上按下鼠标会**同时**开始平移画布 —— 浮窗跟着指针走、
 *    画布也跟着走，看起来像拖动"漏"了。
 * 2. **滚轮**：画布把滚轮监听装在宿主上（非被动 + `preventDefault`，见 `applyWheel`），
 *    它的排除名单里只有 `.mn-float-note`。面板自己会 `stopPropagation` 兜住这一条
 *    （见下面那个 effect）：不这么做，光标停在浮窗上滚滚轮会缩放画布，而且画布的
 *    `preventDefault` 会让正文**根本滚不动**。
 * 3. **`Esc`**：`keymap.isInsideModalLayer` 会把 `role="dialog"` 内部的按键整体让给对话框，
 *    因此面板里的 `Esc` 归它自己，不会和画布的 `graph.closePreview` 命令打架。
 *
 * ## 正文渲染为什么不是直接 `<MarkdownPreview />`
 *
 * `MarkdownPreview` 不接收 props：它渲染的是 `note-store.doc`，也就是"编辑器里当前打开的那一篇"
 * （并且带着大文档 Worker、图片授权那一整套管线）。浮窗要显示的是**用户点开的那一篇**，
 * 它未必是编辑器里打开的那篇 —— 挂上去只会渲染出另一篇的内容。
 * 所以这里复用的是与阅读视图**同一条**渲染链路，逐字对齐：
 * `ipc.noteRead` → `renderMarkdown(frontmatterBody(text))` → `mn-preview__body` 容器
 * （净化后的 HTML 才 `dangerouslySetInnerHTML`）→ 出链表补 wikilink 的已解析/悬空标注
 * → 点击走 `openNote`。三条路（加载中 / 出错 / 有正文）也照旧全部处理。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
// `JSX` 要从 react 显式取（React 19 的类型里去掉了全局命名空间）：与 `components/Icon.tsx` 同一写法
import type {
  JSX,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'

import { openNote } from '@/app/actions'
import { isTextEntryTarget } from '@/app/keymap'
import { Icon } from '@/components/Icon'
import { frontmatterBody } from '@/domain/frontmatter'
import { isInternalNoteHref, normalizeLinkTarget } from '@/domain/links'
import { renderMarkdown } from '@/domain/markdown'
import { ipc } from '@/ipc/client'
import { MimenoteError, describeError } from '@/ipc/types'
import type { ResolvedLink } from '@/ipc/types'
import { toast } from '@/state/toast-store'

export interface FloatingRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 最小宽度：**标题 + 至少两行正文还看得见**。
 *
 * 算法（按本文件同目录 `graph.css` 里的真实尺寸算，不是拍脑袋）：
 * 标题栏里两个 24px 的图标按钮 + 间距 + 左右内边距 ≈ 80px；正文两侧内边距 14px×2 = 28px；
 * 再留 8 个汉字（13px 字号 ≈ 104px）—— 加起来 ≈ 212px，取整到 220px 留几个像素余量。
 * 不取 "刚好" 的值：字体度量在不同平台会差几个像素，贴边会让"两行正文"变成"一行半"。
 */
export const MIN_FLOAT_WIDTH = 220

/**
 * 最小高度：**标题栏 + 两行正文**。
 *
 * 标题栏（13px 标题 + 10px 路径 + 上下 8px 内边距）≈ 50px；正文上内边距 10px + 两行 13px×1.6 ≈ 42px
 * —— 合计 ≈ 102px。取 140px 而不是 102px：标题栏那两行文字的行高由字体决定（中文字体行高
 * 普遍比拉丁字体高），贴边的最小值会让路径那一行被压掉。
 */
export const MIN_FLOAT_HEIGHT = 140

/** 把数字夹进区间（`Math.min/Math.max` 写两遍读起来更绕，这里统一命名）。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * 把 rect 夹进画布可用区域。
 *
 * 规则是**整块矩形都留在区域内**（放不下时退化成"左上角对齐"），它比"标题栏留在区域内"
 * 这个底线更强 —— 而"标题栏留在区域内"正是拖动时真正要守住的性质（标题栏在面板顶部，
 * 整块在区域内 ⇒ 标题栏在区域内）。为什么要更强的那个：用户把浮窗拖到右下角、只剩一条标题栏
 * 露在边上，接下来既看不清正文、又得猜把手在哪，还不如干脆拖不出去。
 *
 * `Math.max(0, …)` 是给"区域比面板还小"（窗口被缩得很小、或调用方给了个很小的尺寸）留的出路：
 * 那时两个方向都夹成 0，面板从左上角开始溢出，标题栏依然看得见。
 */
function clampToArea(rect: FloatingRect, area: { width: number; height: number }): FloatingRect {
  return {
    x: clamp(rect.x, 0, Math.max(0, area.width - rect.width)),
    y: clamp(rect.y, 0, Math.max(0, area.height - rect.height)),
    width: rect.width,
    height: rect.height,
  }
}

/**
 * 指针捕获：让指针离开元素之后仍然收到 `pointermove` / `pointerup`（不然快速拖动会"掉"）。
 *
 * 与 `GraphCanvas` 同一套兜法：jsdom **没有** `setPointerCapture`，某些 WebView 也可能没有，
 * 所以先判存在、再 try/catch。缺了它拖动仍然可用，只是指针移出面板后会丢事件。
 */
function capturePointer(element: Element, pointerId: number): void {
  if (typeof element.setPointerCapture !== 'function') return
  try {
    element.setPointerCapture(pointerId)
  } catch {
    // 环境不支持指针捕获：不影响拖动本身，只是指针移出元素后会断开
  }
}

/** 释放指针捕获（浏览器在 `pointerup` 之后通常会自动释放，显式释放让"取消拖动"也干净）。 */
function releasePointer(element: Element, pointerId: number): void {
  if (typeof element.releasePointerCapture !== 'function') return
  try {
    element.releasePointerCapture(pointerId)
  } catch {
    // 指针已经释放（或从来没捕获成功）
  }
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; html: string }
  | { kind: 'error'; message: string }

/**
 * 一次"按住"的快照：拖动与缩放共用（两者的差别只有回写哪个字段）。
 *
 * `origin` 是**按下的那一刻**的 rect，位移一律相对它算 —— 不相对"上一次 move 的位置"累加，
 * 因为调用方可能不写回（受控组件允许这样用），累加就会算出与实际指针不符的位置。
 */
interface Gesture {
  kind: 'drag' | 'resize'
  pointerId: number
  startX: number
  startY: number
  origin: FloatingRect
  /** 本次按住期间上报过的最后一个 rect（松手时再报一次用）。 */
  last: FloatingRect
  /** 是否真的移动过：没动过就不必在松手时重复上报（那只是一次普通点击）。 */
  moved: boolean
}

export interface FloatingNoteProps {
  relPath: string
  title: string
  /** 当前位置与大小（**受控**：拖动/缩放通过回调上报，由调用方决定是否写回）。 */
  rect: FloatingRect
  /** 层级：点一下面板会请求置顶（`onRaise`），由调用方决定 z。 */
  zIndex: number
  onRaise: () => void
  onMove: (rect: FloatingRect) => void
  onClose: () => void
  /** 「在编辑器中打开」：与停靠面板同一个动作。 */
  onOpenInEditor: (relPath: string) => void
  /** 画布可用区域（世界→屏幕无关，就是宿主元素的像素尺寸）：用于把面板夹在里面。 */
  area: { width: number; height: number }
  /** 是不是最上面那个（最上面那个才响应 `Esc`，也只有它有醒目的边框）。 */
  active: boolean
}

export function FloatingNote(props: FloatingNoteProps): JSX.Element {
  const { relPath, title, rect, zIndex, active, area, onRaise, onMove, onClose, onOpenInEditor } =
    props

  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  /** 这篇笔记的出链（解析用）；拿不到就退化成"链接一律当作悬空"，正文照常显示。 */
  const [outbound, setOutbound] = useState<readonly ResolvedLink[]>([])
  const rootRef = useRef<HTMLElement | null>(null)
  const articleRef = useRef<HTMLElement | null>(null)
  /**
   * 打开这个浮窗时"被取代"的那个元素：关闭后把焦点还回去。
   *
   * 与 `GraphPreview` / `RenameDialog` 同一套写法：捕获 `document.activeElement`，而不是按
   * `relPath` 去 DOM 里反查（浮窗是同一个画布上开出来的第 N 个，"谁打开的就还给谁"才是稳定语义）。
   */
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const gestureRef = useRef<Gesture | null>(null)

  // 打开时把焦点移进浮窗（`tabIndex={-1}`：可编程聚焦，但不占 Tab 序列的名额）
  useEffect(() => {
    const previous = typeof document === 'undefined' ? null : document.activeElement
    // body 不算"上一个焦点"：那只是"页面上没有别的东西聚焦"，还给 body 等于没还
    restoreFocusRef.current =
      previous instanceof HTMLElement && previous !== document.body ? previous : null
    rootRef.current?.focus()
    return () => {
      const target = restoreFocusRef.current
      restoreFocusRef.current = null
      if (target !== null && target.isConnected) target.focus()
    }
  }, [])

  /**
   * `Esc` 关掉**自己**——但只在 `active`（最上面那个）时监听。
   *
   * 为什么挂在 window 上而不是用 React 的 `onKeyDown`：浮窗被打开后焦点确实在面板里，
   * 但用户一点正文，焦点就可能落到 body（正文不是可聚焦元素）—— 那时 `Esc` 会莫名其妙失灵。
   * "关掉最上面那个"这件事不该依赖焦点偶然停在哪儿。
   *
   * 为什么只让 `active` 那个监听：三个浮窗同时监听就会一次 `Esc` 关掉三个；
   * "谁在最上面"是调用方知道的（`active` 就是为此存在），组件不猜。
   *
   * 输入框里不抢（`isTextEntryTarget`）：面板里的输入框按 `Esc` 的语义是"取消这次输入"，
   * 而且将来正文里若出现可编辑区域，一个 `Esc` 把整个浮窗关掉会直接丢掉用户刚看的位置。
   */
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (event.defaultPrevented || event.isComposing) return
      if (isTextEntryTarget(event.target)) return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [active, onClose])

  /**
   * 面板里的滚轮只滚正文，不要传到画布上去。
   *
   * 这是**补偿**，不是设计：画布的滚轮监听（`GraphCanvas.applyWheel`）挂在宿主上，
   * 而且它 `preventDefault()` 掉每一次滚轮（非被动监听），它现在的排除名单里只有
   * `.mn-graph-preview`。少了这一段，光标停在浮窗上滚滚轮会缩放画布，同时正文**滚不动**。
   * 等画布那边改成按 `data-mn-graph-nopan`（或加上 `.mn-float-note`）排除之后，这一段可以删掉。
   *
   * 用原生监听 + `stopPropagation`（不是 React 的 `onWheel`）：画布那个监听挂在宿主的
   * **原生**监听上，而 React 的 `onWheel` 是挂在 React 根容器上的（比宿主更高），
   * 事件冒泡到那里时画布早就先处理完了 —— 那时再 `stopPropagation` 已经来不及。
   */
  useEffect(() => {
    const root = rootRef.current
    if (root === null) return
    const onWheel = (event: WheelEvent): void => {
      event.stopPropagation()
    }
    root.addEventListener('wheel', onWheel)
    return () => {
      root.removeEventListener('wheel', onWheel)
    }
  }, [])

  useEffect(() => {
    // 与 `GraphPreview` 同一套"过期响应丢弃"策略：快速换一篇时只采纳最后一次的结果
    let disposed = false
    setState({ kind: 'loading' })

    void (async () => {
      try {
        const content = await ipc.noteRead(relPath)
        if (disposed) return
        // frontmatter 不渲染（它是元数据，渲染出来只是一条横线加几行 key: value）
        setState({ kind: 'ready', html: renderMarkdown(frontmatterBody(content.text)) })
      } catch (cause) {
        if (disposed) return
        setState({ kind: 'error', message: describeError(MimenoteError.from(cause), '无法预览') })
      }
    })()

    return () => {
      disposed = true
    }
  }, [relPath])

  // 出链表：与正文那次读盘是两次独立往返，但它不阻塞正文渲染（解析结果晚到也不会让浮窗闪白）
  useEffect(() => {
    let disposed = false
    setOutbound([])
    void (async () => {
      try {
        const links = await ipc.noteLinks(relPath)
        if (disposed) return
        setOutbound(links.outbound)
      } catch {
        // 索引还没建好（或旧宿主没有这个命令）：正文照常显示，只是链接点了没反应
      }
    })()
    return () => {
      disposed = true
    }
  }, [relPath])

  const html = state.kind === 'ready' ? state.html : ''
  const rendered = useMemo(() => ({ __html: html }), [html])

  /**
   * 把索引的解析结果"贴"到渲染出来的 wikilink 上（不重新渲染 HTML）。
   * 与 `GraphPreview` / `MarkdownPreview` 完全同一套做法（同样的类名、同样的 title），
   * 这样"已解析 / 悬空 / 有歧义"在三处视图里的外观与含义一致。
   */
  useEffect(() => {
    const root = articleRef.current
    if (root === null) return
    for (const element of Array.from(root.querySelectorAll('a.mn-wikilink'))) {
      const key = normalizeLinkTarget(element.getAttribute('data-target') ?? '')
      const match = outbound.find((link) => normalizeLinkTarget(link.rawTarget) === key)
      const resolved = match?.resolvedRelPath ?? null
      element.classList.toggle('mn-wikilink--unresolved', resolved === null)
      element.classList.toggle('mn-wikilink--ambiguous', match?.ambiguous === true)
      if (resolved === null) {
        element.removeAttribute('data-rel-path')
        element.setAttribute('title', `${element.getAttribute('data-target') ?? ''}（还不存在）`)
      } else {
        element.setAttribute('data-rel-path', resolved)
        element.setAttribute('title', resolved)
      }
    }
  }, [html, outbound])

  /**
   * 正文里的链接：`[[wikilink]]`（目标写在 `data-target` 上）与普通 Markdown 链接（`href`）。
   *
   * 口径与 `GraphPreview` / `MarkdownPreview` 一致：都用 `normalizeLinkTarget` 与出链表比对，
   * 否则"阅读视图里能点、浮窗里点了没反应"这种不一致会让人怀疑整条链接链坏了。
   *
   * 与停靠面板**唯一**的差别：这里只 `openNote`，不做 `useGraphStore.select()`。
   * 停靠面板跟随链接时还要把"画布上选中的那篇"切过去（那是它在画布上存在的意义）；
   * 浮窗是用户手动开出来的第 N 个阅读窗口，跟着链接改画布的选中项，会把他刚打开的另一篇挤掉
   * —— 而且 store 的接线（谁负责写回 `selected`）属于调用方。
   */
  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest('a')
      if (anchor === null) return

      // wikilink：已解析 → 打开那篇笔记；悬空 → 只提示（浮窗是只读的，不在这里建文件）
      if (anchor.classList.contains('mn-wikilink')) {
        event.preventDefault()
        const resolved = anchor.getAttribute('data-rel-path')
        if (resolved !== null) void openNote(resolved)
        else toast.info('目标笔记还不存在', anchor.getAttribute('data-target') ?? '')
        return
      }

      const href = anchor.getAttribute('href') ?? ''
      if (href === '' || href.startsWith('#')) return

      // Markdown 内部链接：同样用出链表判断指向哪一篇
      const key = normalizeLinkTarget(href)
      const match = outbound.find((link) => normalizeLinkTarget(link.rawTarget) === key)
      if (match?.resolvedRelPath != null) {
        event.preventDefault()
        void openNote(match.resolvedRelPath)
        return
      }

      event.preventDefault()
      if (isInternalNoteHref(href)) toast.info('目标笔记还不存在', href)
      // 外部链接：不让 WebView 直接跳走（会丢掉整个界面），与阅读视图同一处理
      else toast.info('外部链接未在应用内打开', `${href}（M2 之后接入系统浏览器打开）`)
    },
    [outbound],
  )

  /**
   * 按住开始一次拖动/缩放。
   *
   * 只认主键（`button === 0`）：中键在画布上是"平移"，右键将来要给菜单 —— 让它们在这里
   * 也变成"拖浮窗"会与画布的约定对不上。`event.currentTarget` 就是标题栏或把手本身，
   * 指针捕获挂在它身上（挂在根元素上会让"把手拖动"和"标题栏拖动"的 `pointermove` 分不清是谁的）。
   */
  const beginGesture = useCallback(
    (event: ReactPointerEvent<HTMLElement>, kind: Gesture['kind']): void => {
      if (event.button !== 0) return
      capturePointer(event.currentTarget, event.pointerId)
      gestureRef.current = {
        kind,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        origin: rect,
        last: rect,
        moved: false,
      }
    },
    [rect],
  )

  const handleHeaderPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      beginGesture(event, 'drag')
    },
    [beginGesture],
  )

  const handleHandlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      beginGesture(event, 'resize')
    },
    [beginGesture],
  )

  /**
   * 拖动/缩放过程中的实时上报。
   *
   * 每帧都报（而不是只在松手时报一次）：浮窗是受控的，父组件写回它才会跟着指针走 ——
   * "只在松手时报"的表现是拖一个空框，松手才跳过去。
   *
   * 缩放的上限是"当前区域里还剩多少地方"（`area.width - x`）：把把手往右拖到天边也只会顶到
   * 区域右缘。下限是那两个 `MIN_*` 常量；两者用 `Math.max(MIN_*, …)` 兜底，是为了"区域比最小尺寸
   * 还小"时不出现 min > max 的荒谬区间（那时以最小尺寸为准，超出的部分画布会裁掉）。
   */
  const handleGestureMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      const gesture = gestureRef.current
      if (gesture === null || gesture.pointerId !== event.pointerId) return
      const dx = event.clientX - gesture.startX
      const dy = event.clientY - gesture.startY
      if (dx === 0 && dy === 0) return

      const origin = gesture.origin
      const next =
        gesture.kind === 'drag'
          ? clampToArea({ ...origin, x: origin.x + dx, y: origin.y + dy }, area)
          : clampToArea(
              {
                ...origin,
                width: clamp(
                  origin.width + dx,
                  MIN_FLOAT_WIDTH,
                  Math.max(MIN_FLOAT_WIDTH, area.width - origin.x),
                ),
                height: clamp(
                  origin.height + dy,
                  MIN_FLOAT_HEIGHT,
                  Math.max(MIN_FLOAT_HEIGHT, area.height - origin.y),
                ),
              },
              area,
            )

      gesture.last = next
      gesture.moved = true
      onMove(next)
    },
    [area, onMove],
  )

  /** 松手（或指针被系统取消）：释放捕获，并把**最后一次**位置再上报一次收尾。 */
  const endGesture = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      const gesture = gestureRef.current
      if (gesture === null || gesture.pointerId !== event.pointerId) return
      gestureRef.current = null
      releasePointer(event.currentTarget, event.pointerId)
      // 移动过才补报：一次纯点击（按下就抬起）不该产生一次"位置变了"的上报 ——
      // 调用方很可能据此写 localStorage 或标记"布局已脏"。
      if (gesture.moved) onMove(gesture.last)
    },
    [onMove],
  )

  /**
   * 区域尺寸变化（窗口缩放、侧栏展开）之后重新夹一次。
   *
   * 依赖里含 `rect` 是必须的（它就是要夹的对象），含 `onMove` 是因为它每次渲染都可能换身份；
   * 三条都进依赖会不会死循环：**不会** —— 调用方写回的正是这里算出来的值，第二次跑
   * `clampToArea` 结果不变、直接 return。前提是调用方遵守受控约定（见文件头）。刻意不写成
   * `[area.width, area.height]` 那种"故意漏依赖"的写法：漏依赖的代价是夹取用的是**过期**的 rect
   * （用户刚拖完就缩窗口，会跳回老位置），而这里的重跑成本是一次几次减法的比较。
   */
  useEffect(() => {
    const next = clampToArea(rect, area)
    if (next.x === rect.x && next.y === rect.y) return
    onMove(next)
  }, [rect, area, onMove])

  return (
    <section
      className={`mn-float-note${active ? ' mn-float-note--active' : ''}`}
      // 画布靠它把这一块从"可以平移画布的区域"里排除（少了它 = 拖浮窗时画布一起动）
      data-mn-graph-nopan
      role="dialog"
      // 非模态：画布仍然可以点、可以拖（`aria-modal` 默认是 false，这里写出来是为了说明这是**有意**的）
      aria-modal={false}
      aria-label={`${title}（${relPath}）`}
      tabIndex={-1}
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        zIndex,
      }}
      ref={rootRef}
      // 任意处的 pointerdown 都置顶（含标题栏、正文里的链接、右下角把手）：
      // 用根元素上的一个处理器覆盖全部子节点，而不是在三处各写一遍 —— 少了任何一处，
      // 都会出现"点这里不置顶"的死角。置顶发生在 `pointerdown`，早于链接的 `click`
      // 与拖动的第一次 `pointermove`，"先置顶再处理"的顺序天然成立。
      onPointerDown={onRaise}
    >
      <header
        className="mn-float-note__header"
        // 拖动区同时是**可聚焦**的：键盘用户 Tab 进浮窗时有一个明确的落点，
        // 也是"这个浮窗现在有焦点"可见的证据（焦点环只在键盘操作时出现，见 graph.css）。
        tabIndex={0}
        aria-label={`${title}（${relPath}）：拖动这里可以移动浮窗`}
        title="拖动移动浮窗"
        onPointerDown={handleHeaderPointerDown}
        onPointerMove={handleGestureMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
      >
        <div className="mn-float-note__heading">
          <div className="mn-float-note__title" title={title}>
            {title}
          </div>
          <div className="mn-float-note__path" title={relPath}>
            {relPath}
          </div>
        </div>
        <button
          type="button"
          className="mn-icon-button"
          aria-label="在编辑器中打开"
          title="在编辑器中打开（与停靠预览同一个动作）"
          onClick={() => onOpenInEditor(relPath)}
        >
          <Icon name="pencil" size="sm" />
        </button>
        <button
          type="button"
          className="mn-icon-button"
          aria-label="关闭浮窗"
          title="关闭浮窗（Esc）"
          onClick={onClose}
        >
          <Icon name="x" size="sm" />
        </button>
      </header>

      {/* 滚的是这一层（面板本身 `overflow: hidden`），与停靠面板一致 */}
      <div className="mn-float-note__body">
        {state.kind === 'loading' && <p className="mn-empty__text">正在读取…</p>}
        {state.kind === 'error' && (
          <p className="mn-empty__text mn-float-note__error">{state.message}</p>
        )}
        {state.kind === 'ready' && (
          <article
            className="mn-preview__body mn-float-note__article"
            ref={articleRef}
            // html 已由 DOMPurify 净化（见 domain/markdown.ts 的两道防线）
            dangerouslySetInnerHTML={rendered}
            onClick={handleClick}
          />
        )}
      </div>

      {/*
        右下角的把手。用 `div` + `aria-hidden` 而不是 `button`：它只响应指针拖动，
        键盘用户 Tab 到一个"按下去没反应"的控件只会困惑；而缩小/放大浮窗纯属观感，
        面板在默认尺寸下已经完全可用（不构成"只能靠鼠标才能完成的任务"）。
        `data-float-resize` 是给测试与将来可能的 E2E 用的稳定钩子。
      */}
      <div
        className="mn-float-note__handle"
        data-float-resize=""
        aria-hidden="true"
        title="拖动调整大小"
        onPointerDown={handleHandlePointerDown}
        onPointerMove={handleGestureMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
      />
    </section>
  )
}
