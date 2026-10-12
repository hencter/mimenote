/**
 * 图谱画布的 **canvas API**：三个私有 hook —— 宿主 ref 与量字、坐标换算与命中测试、每帧绘制。
 *
 * 一句话职责：把"像素这一侧的脏活"收在一处 —— DOM 引用、离屏量字上下文、视口尺寸上报、
 * 屏幕 ↔ 世界坐标换算、命中测试、以及每帧重画与两份出口（几何给悬停命中、数字给诊断属性）。
 *
 * ## 为什么三件事在一个文件（ADR-0060 §3(a)）
 *
 * 它们必须在**同一个渲染顺序**里交接，而且都被"绘制与命中读同一份数据"这条纪律绑在一起：
 * - `useCanvasFrame`：`hostRef` / `canvasRef` / 量字上下文（离屏 canvas）+ 视口尺寸上报；
 * - `useCanvasHit`：`worldPointOf`（屏幕 → 世界）与 `hitCard`（世界 → 最上面的卡片）；
 * - `useCanvasPaint`：每帧重画，并留下"这一帧真画出来的线"（供悬停命中）与诊断数字。
 *
 * 拆到别的文件只会多几次穿针，而"命中的必须是**当前**矩形"（力场松弛/拖动之后的位置）
 * 这条判据会变得看不见 —— `hitCard` 的 `currentRect` 就是共享 `positionsRef` 的读端
 * （见 `use-force-sim.ts` 文件头）。
 *
 * ## 绘制顺序（ADR-0036，别改）
 *
 * 卡外连线 → 卡片 → 卡内引线，全在 `paintGraph` 的**一次**调用里按调用顺序完成
 * （见 `canvas/paint.ts` 入口注释）。这里不许为"看起来更清楚"拆成两次绘制：
 * 那会让卡片盖不住穿过它的线。
 *
 * ## 位置不进 React state
 *
 * 每帧都在变的位置不进 state（进 state 会让整棵画布跟着重渲染）：`paintNodes` 里每个
 * `rect` 都是当场从 `currentRect` 读的共享 ref，`tick` 只是"该重画了"的时钟。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'

import { bulgeRatio, type PaintedEdge } from './canvas/edge-paint'
import { canvasMeasure, createCardLayoutCache, type MeasureText } from './canvas/measure'
import { readPalette, type GraphPalette } from './canvas/palette'
import { paintGraph, type PaintNode } from './canvas/paint'
import { createTokenReader } from './canvas/probe'
import type { GraphEdgeVisual, GraphLayout, Rect } from '@/domain/graph/layout'
import type { GraphNode } from '@/ipc/types'
import { useGraphStore, type EgoSnapshot, type GraphMode } from '@/state/graph-store'

import { canvasSize, rectHit, toWorld, type ViewTransform } from '@/domain/graph/viewport'
import type { HoveredLink } from './use-card-links'
import type { EgoGeometry } from './use-force-sim'

/** 全库视图紧凑卡片里标签那一行最多显示几个字符（超出截断加省略号）。 */
const COMPACT_TAG_CHARS = 20

/** 全库视图紧凑卡片的附加行：目录、出入度、标签。 */
function compactLinesFor(node: GraphNode): string[] {
  const folder = node.folder === '' ? '（Vault 根）' : node.folder
  const degrees = `${node.outDegree} 出 · ${node.inDegree} 入`
  if (node.tags.length === 0) return [folder, degrees]
  const tags = node.tags.join(' ')
  return [
    folder,
    degrees,
    tags.length <= COMPACT_TAG_CHARS ? tags : `${tags.slice(0, COMPACT_TAG_CHARS)}…`,
  ]
}

// ---------------------------------------------------------------------------
// hook 1：宿主 ref、量字上下文、视口尺寸上报
// ---------------------------------------------------------------------------

function useCanvasFrame() {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  /**
   * 量字用的上下文（离屏 canvas）。
   *
   * 为什么单独一个：量宽只需要 `measureText`，与真正的画布无关；而**必须用同一个字族与字号**
   * （`fontString` 的缺省族），否则"量出来的宽度"与"画出来的字"会分家（换行位置因此偏移）。
   * 排版缓存也挂在这里：平移/缩放每帧都会问同一批卡片的排版，缓存让这条路只跑一次。
   */
  const layoutRef = useRef<{ measure: MeasureText; cache: ReturnType<typeof createCardLayoutCache> } | null>(
    null,
  )
  if (layoutRef.current === null && typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    layoutRef.current = {
      measure: context === null ? () => 0 : canvasMeasure(context),
      cache: createCardLayoutCache({ maxEntries: 400 }),
    }
  }
  const measure = layoutRef.current?.measure ?? null

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const sync = (): void => {
      const width = host.clientWidth
      const height = host.clientHeight
      // 尺寸为 0（首帧 / 无布局环境）时不上报：store 里的兜底尺寸比 0 有用得多
      if (width > 0 && height > 0) useGraphStore.getState().setViewport({ width, height })
    }
    sync()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', sync)
      return () => window.removeEventListener('resize', sync)
    }
    const observer = new ResizeObserver(sync)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  return { hostRef, canvasRef, layoutRef, measure }
}

// ---------------------------------------------------------------------------
// hook 2：坐标换算与命中测试（"命中的必须是当前矩形"）
// ---------------------------------------------------------------------------

function useCanvasHit(input: {
  hostRef: RefObject<HTMLDivElement | null>
  transform: ViewTransform
  mode: GraphMode
  egoLayout: EgoGeometry | null
  vaultLayout: GraphLayout | null
  currentRect: (relPath: string) => Rect | null
}) {
  const { hostRef, transform, mode, egoLayout, vaultLayout, currentRect } = input

  /** 屏幕点 → 世界坐标（命中测试的第一步）。 */
  const worldPointOf = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const host = hostRef.current
      if (host === null) return null
      const rect = host.getBoundingClientRect()
      return toWorld(transform, { x: clientX - rect.left, y: clientY - rect.top })
    },
    [transform],
  )

  /**
   * 世界坐标上最上面的卡片（后画的在上）。
   *
   * 焦点视图用 `cardAt`（同心环那层自带的命中判据）；全库视图用矩形索引，
   * 两者都带一点屏幕上的宽容度（缩到 25% 时卡片只有十几像素宽，纯矩形命中会点不中）。
   */
  const hitCard = useCallback(
    (point: { x: number; y: number }): { relPath: string; rect: Rect } | null => {
      const tolerance = 4 / transform.scale
      if (mode === 'focus') {
        const cards = egoLayout?.layout.cards ?? []
        // ⚠️ 命中的必须是**当前**矩形（力场松弛之后、或被用户拖过之后的位置），而不是
        // `card.rect`（同心环给的原始位置）。两者默认档下就差着大约三分之二的距离，
        // 用原始矩形命中的后果是"按在画着的那张卡片上，抓住的却是另一张"——
        // 拖动的表现是"按不住 / 一按就跳"，这正是"拖拽很僵硬"的一半来源。
        // 顺序与画笔一致（后画的在上），所以倒着找第一个命中的就是"最上面那张"。
        for (let index = cards.length - 1; index >= 0; index -= 1) {
          const card = cards[index]
          if (card === undefined) continue
          const rect = currentRect(card.relPath) ?? card.rect
          if (rectHit(rect, point, tolerance)) return { relPath: card.relPath, rect }
        }
        return null
      }
      const cards = vaultLayout?.cards ?? []
      for (let index = cards.length - 1; index >= 0; index -= 1) {
        const card = cards[index]
        if (card === undefined) continue
        if (rectHit(card, point, tolerance)) return { relPath: card.relPath, rect: card }
      }
      return null
    },
    [mode, egoLayout, vaultLayout, transform.scale, currentRect],
  )

  return { worldPointOf, hitCard }
}

// ---------------------------------------------------------------------------
// hook 3：每帧重画 + 画笔入参与两份出口
// ---------------------------------------------------------------------------

function useCanvasPaint(input: {
  hostRef: RefObject<HTMLDivElement | null>
  canvasRef: RefObject<HTMLCanvasElement | null>
  viewport: { width: number; height: number }
  transform: ViewTransform
  edgeVisuals: readonly GraphEdgeVisual[]
  visibleSet: ReadonlySet<string>
  mode: GraphMode
  selected: string | null
  hovered: string | null
  hoveredLink: HoveredLink | null
  themeId: string
  rootPath: string | null
  measure: MeasureText | null
  egoLayout: EgoGeometry | null
  ego: EgoSnapshot | null
  vaultLayout: GraphLayout | null
  currentRect: (relPath: string) => Rect | null
  /** 位置变化的时钟（漂浮每帧、落定、拖动都会推进它）—— 画笔据此重算卡片矩形。 */
  tick: number
  dragging: string | null
  titleOnly: boolean
}) {
  const {
    hostRef,
    canvasRef,
    viewport,
    transform,
    edgeVisuals,
    visibleSet,
    mode,
    selected,
    hovered,
    hoveredLink,
    themeId,
    rootPath,
    measure,
    egoLayout,
    ego,
    vaultLayout,
    currentRect,
    tick,
    dragging,
    titleOnly,
  } = input

  /** 上一帧真正画出来的卡片数（视口裁剪之后）—— 只用于诊断属性，不参与渲染决策。 */
  const [paintedCards, setPaintedCards] = useState(0)

  /**
   * 上一帧画出来的连线（含世界坐标命令）。悬停命中读它 ——
   * 于是"看到的线"与"命中的线"永远是同一份（见 `edge-paint.ts` 的 `PaintedEdge`）。
   */
  const paintedEdgesRef = useRef<readonly PaintedEdge[]>([])
  /**
   * 连线的诊断数字（只用于 `data-graph-*` 属性，不参与渲染决策）。
   *
   * 为什么是这些原始值而不是一份记录数组：这份状态每帧都可能被写（漂浮 60fps），
   * 而"写一个内容相同的新对象"会让 React 每次都想重渲染；原始值相等就 bail out，
   * 于是静止时不会因为诊断属性而多渲染一轮。
   *
   * 为什么需要这么几项：连线在 canvas 上没有 DOM 可查，这些数字是测试与 UI E2E **唯一的抓手**。
   * 它们逐条对着搬迁前那串 SVG 类名/元素（`--dashed` / `--highlight` / `--dim` / `--out` /
   * `<circle class="mn-graph-phantom">` / `path.mn-graph-edge--lead`）换过来 ——
   * 断言的性质没变，只是从"元素上有哪个类"变成"这一帧画出来几条什么样的线"
   * （见 `graph.test.tsx` 里那几条用例的注释）。
   */
  const [edgeStats, setEdgeStats] = useState({
    /** 卡外那段画了几条（= 有几何可画的边数）。 */
    span: 0,
    /** 其中画成虚线的（悬空边、或"被选中卡片提到"的入链）。 */
    dashed: 0,
    /** 与圆心/选中相关的（强调档）。 */
    highlight: 0,
    /** 强调且虚线的（"入链画虚线、出链实线"这一条就靠这两个数的差来断言）。 */
    highlightDashed: 0,
    /** 与圆心/选中无关而被淡化的（淡化不等于隐藏：上下文还在）。 */
    dim: 0,
    /** 其中走弧的（几何层的"同环走弧"，见 `edge-paint.ts` 的 `PaintedEdge.shape`）。 */
    arcs: 0,
    /** 三类语义色相各几条（出链 / 入链 / 环间），写成 `出,入,环间` —— ADR-0028 的分类抓手。 */
    hues: '0,0,0',
    /** 卡内那段引线画了几条（关掉「从正文链接引出」时应为 0）。 */
    leads: 0,
    /**
     * 卡外那些**曲线**的"鼓出比"（控制点到弦的距离 ÷ 弦长；`;` 连接，直线不参与）。
     *
     * 为什么值得单列：张力滑块是唯一一个连续量旋钮，而"滑块的值变了"和"曲线真的弯了"是两件事。
     * 这个比值与位置、缩放、漂浮全都无关（`tensionPath` 的定义 ⇒ 它恒等于 `tension ÷ 4`），
     * 是自动化唯一能逐字断言那个旋钮的抓手 —— 搬迁前它由 UI E2E 从 SVG 的 `d` 里现算。
     */
    bulges: '',
    /** 悬空边标出的目标名（`;` 连接；"这里缺一篇笔记"必须一眼看得见）。 */
    phantoms: '',
    /**
     * 画成**平行束**的边有几条（ADR-0052：同一对笔记之间有多条链接时画 2–3 条平行线）。
     * 与 `lines` 一起用来断言"束真的画出来了、而且只画了上限那么多"。
     */
    bundled: 0,
    /** 卡外那段一共画了几条**笔触**（= Σ 每条边的 `bundle`；没有束时与 `span` 相等）。 */
    lines: 0,
  })

  // -------------------------------------------------------------------------
  // 画笔的入参
  // -------------------------------------------------------------------------

  const paintNodes = useMemo<PaintNode[]>(() => {
    if (mode === 'focus') {
      if (egoLayout === null) return []
      const root = ego?.root ?? null
      const ordered =
        dragging === null
          ? egoLayout.layout.cards
          : // 拖动中的那张画在**最后**（最上层）：不这么做的话，把它拖到别的卡片上时会被盖住 ——
            // 用户看到的是"卡片没了"，而不是"我在搬它"（画布没有 z-index，顺序就是层级）。
            [
              ...egoLayout.layout.cards.filter((card) => card.relPath !== dragging),
              ...egoLayout.layout.cards.filter((card) => card.relPath === dragging),
            ]
      return ordered.map((card) => ({
        relPath: card.relPath,
        title: card.node.title,
        // 位置取**当前**（漂浮之后的）矩形；`tick` 是这里的刷新时钟
        rect: currentRect(card.relPath) ?? card.rect,
        hop: card.hop,
        isRoot: card.relPath === root,
        hasFocus: card.relPath === root || card.relPath === selected,
        layout: egoLayout.layouts.get(card.relPath) ?? null,
        // 纯标题模式：正文区整段留空（连"目录/度数"都不画 —— 这个档位要的就是"只有标题"）；
        // 否则正文读不到的那几篇退成紧凑卡片（标题 + 目录 + 度数），至少还能看出它是谁
        ...(titleOnly
          ? { compactLines: [] as readonly string[] }
          : egoLayout.layouts.has(card.relPath)
            ? {}
            : { compactLines: compactLinesFor(card.node) }),
      }))
    }
    if (vaultLayout === null || mode !== 'vault') return []
    return vaultLayout.cards.map((card) => ({
      relPath: card.relPath,
      title: card.node.title,
      rect: card,
      hop: 0,
      isRoot: false,
      hasFocus: card.relPath === selected,
      layout: null,
      compactLines: compactLinesFor(card.node),
    }))
  }, [mode, egoLayout, ego, vaultLayout, selected, currentRect, tick, dragging, titleOnly])

  const paletteRef = useRef<{
    key: string
    palette: GraphPalette
    token: (name: string) => string | null
  } | null>(null)

  /**
   * 重画一帧。
   *
   * 为什么不用 `requestAnimationFrame` 排队：所有会触发重画的输入（数据、缩放、平移、悬停）
   * 都已经由 React 的批处理合并过了，一帧最多跑一次；再加一层 rAF 只会让"拖动时卡片跟手"
   * 变成"慢一帧"（用户能看出来）。真正的开销在 `paintGraph` 里被视口裁剪挡住了。
   */
  useEffect(() => {
    const canvas = canvasRef.current
    const host = hostRef.current
    if (canvas === null || host === null) return
    if (viewport.width <= 0 || viewport.height <= 0) return

    /**
     * 调色板与令牌读取器：**按主题 + Vault 缓存**，不在每次重画时重读。
     *
     * 两个约束把做法夹在这里：
     * 1. 不能在渲染期读（第一次渲染时 ref 还没挂上 DOM，读到的是 null，而 memo 之后再也不会重算）；
     * 2. 不能每帧读 —— `getComputedStyle` 会强制一次样式计算，拖动时每帧一发就是白花的钱。
     * 于是"主题或 Vault 变了才重建"：主题切换本来就会改变所有卡片颜色，重读一次正合适。
     */
    const key = `${themeId}\u0000${rootPath ?? ''}`
    let palette = paletteRef.current
    if (palette === null || palette.key !== key) {
      palette = { key, palette: readPalette(host), token: createTokenReader(host) }
      paletteRef.current = palette
    }

    const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio
    const pixels = canvasSize({ width: viewport.width, height: viewport.height }, ratio)
    if (canvas.width !== pixels.width || canvas.height !== pixels.height) {
      canvas.width = pixels.width
      canvas.height = pixels.height
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
    }

    const context = canvas.getContext('2d')
    if (context === null) return
    // DPR 只在这一次换算里出现：之后画笔画的每个坐标都按 CSS 像素理解
    context.setTransform(pixels.dpr, 0, 0, pixels.dpr, 0, 0)
    // 每一帧都清空：卡片的数量随缩放/裁剪变化，残留的旧像素会让画布糊上一层
    context.clearRect(0, 0, viewport.width, viewport.height)

    const stats = paintGraph(context, {
      transform,
      nodes: paintNodes,
      // 连线（ADR-0036）：形状/色相/提亮都由上面那份 `edgeVisuals` 算好，画笔只负责画；
      // 画出来的每条线都在 `stats.edges` 里（悬停命中与诊断属性读的就是它）
      edgeVisuals,
      palette: palette.palette,
      measure: measure ?? (() => 0),
      mode,
      selected,
      hovered,
      // 悬停的那段 [[链接]]（卡片内坐标）：画笔给它描一个强调色的框，
      // 与"提亮对应连线"是同一个动作的两半
      hoveredLink:
        hoveredLink === null ? null : { relPath: hoveredLink.relPath, zone: hoveredLink.zone },
      visible: visibleSet,
      token: palette.token,
    })
    // 真正画出来的张数（视口裁剪之后）也报给宿主属性：它与"交给画笔的张数"是两件事，
    // 而"这一帧到底画了几张"是排查"画布怎么空了/卡了"时第一个想看的事实
    setPaintedCards(stats.cards)

    // 连线的两份出口：几何留给悬停命中（ref，不触发渲染），数字留给诊断属性（state，值相等就不重渲染）
    paintedEdgesRef.current = stats.edges
    const span = stats.edges.filter((edge) => edge.layer === 'span')
    const highlighted = span.filter((edge) => edge.highlight)
    const next = {
      span: span.length,
      dashed: span.filter((edge) => edge.dashed).length,
      highlight: highlighted.length,
      highlightDashed: highlighted.filter((edge) => edge.dashed).length,
      dim: span.filter((edge) => edge.dim).length,
      arcs: span.filter((edge) => edge.shape === 'arc').length,
      hues: (['out', 'in', 'context'] as const)
        .map((hue) => span.filter((edge) => edge.hue === hue).length)
        .join(','),
      leads: stats.edges.length - span.length,
      bulges: span
        .map((edge) => bulgeRatio(edge.commands))
        .filter((ratio): ratio is number => ratio !== null)
        // 4 位小数足够断言 `tension ÷ 4`（默认档 0.62 ⇒ 0.155），也压得住字符串长度
        .map((ratio) => ratio.toFixed(4))
        .join(';'),
      phantoms: span
        .map((edge) => edge.label)
        .filter((label): label is string => label !== null)
        .join(';'),
      bundled: span.filter((edge) => edge.bundle > 1).length,
      lines: span.reduce((total, edge) => total + edge.bundle, 0),
    }
    setEdgeStats((current) => {
      for (const key of Object.keys(next) as Array<keyof typeof next>) {
        if (current[key] !== next[key]) return next
      }
      return current
    })
  }, [
    viewport,
    transform,
    paintNodes,
    edgeVisuals,
    visibleSet,
    themeId,
    rootPath,
    measure,
    mode,
    selected,
    hovered,
    hoveredLink,
  ])

  return { paintNodes, paintedCards, edgeStats, paintedEdgesRef }
}

export { useCanvasFrame, useCanvasHit, useCanvasPaint }
