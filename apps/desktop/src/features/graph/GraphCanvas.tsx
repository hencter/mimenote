/**
 * 知识图谱画布（M3 的核心功能，ADR-0021 起改为 canvas 渲染）。
 *
 * ## 两种视图
 *
 * - **焦点视图（默认）**：以**当前打开的笔记**为圆心，只画与它相关的子图，跳数可调（1..5，双向）。
 *   用户的原话是"进入后只有先关联的图谱，然后图谱深度是可以调节的"，并且"每个节点是完整的
 *   markdown 预览"—— 所以这一视图里每张卡片正面就是那篇笔记的正文（标题/段落/列表/引用/代码/
 *   表格/图片占位/提示框，与阅读视图同一套块清单），排版在 `canvas/` 那一层。
 * - **整个 Vault**：原来的全库视图（文件夹装箱 + 手工拖动 + 折叠容器），卡片是紧凑卡片。
 *   它没有被删掉，只是不再是默认入口 —— 几千张卡片适合"看结构"，不适合"看内容"。
 *
 * ## 为什么改成 canvas
 *
 * 原来每张卡片是一个 DOM 元素：整篇正文的富文本要变成几千个节点，浏览器排版一帧就要几十毫秒，
 * 于是只能做"虚拟化 + 卡片摘要"，而摘要恰恰是用户不满意的部分（他要的是完整预览）。
 * canvas 里画 300 张卡片是一串 `fillText`，量级是毫秒；缩放时文字**重新排版**而不是被放大成
 * 模糊的一团。代价是命中测试、光标、可访问性都要自己来 —— 见下面的"交互"与"键盘"两节。
 *
 * ## 三层各画什么（坐标只有一套）
 *
 * 1. **canvas**（`canvas/paint.ts`）：卡片本体与卡片里的正文；
 * 2. **SVG**（`GraphEdges`）：连线 —— 保留正交折线、箭头、悬空链接的虚影与目标名，
 *    这些都已经实现且更细腻，用 canvas 重画直线会是一种退步（所以画笔收到的 `edges` 是空数组）；
 * 3. **DOM**（文件夹容器标题）：全库视图里可点、可折叠的文件夹头，几百个 DOM 节点不是负担。
 *
 * 三层的坐标关系只有一条：`屏幕 = 世界 × zoom + 偏移`（`viewport.ts`），
 * canvas 自己算，SVG 与 DOM 走同一套 CSS `transform`（`transform-origin: 0 0`）。
 *
 * ## 交互（canvas 之后必须自己实现的那部分）
 *
 * - 命中的是**世界坐标**里的卡片矩形（`cardAt` / `rectIndex`），因此缩放与平移不影响点击；
 * - 空白处拖动 = 平移画布，空白处单击 = 关掉预览；
 * - 卡片上拖动 = 移动卡片（**只有全库视图**：焦点视图的位置就是"离中心几跳"，拖动会把它变成谎话）；
 * - 卡片上单击 = 选中并在右侧预览，双击 = 进编辑器打开；
 * - 焦点视图里"换圆心"不需要额外按钮：双击某张卡片就打开了它，圆心自然跟着当前笔记走。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

import { openNote } from '@/app/actions'
import { GRAPH_COMMAND_IDS } from '@/app/builtin-commands'
import { commands } from '@/app/commands'
import { isTextEntryTarget } from '@/app/keymap'
import { Icon } from '@/components/Icon'
import { describeError, type GraphNode } from '@/ipc/types'
import {
  MAX_EGO_DEPTH,
  MIN_EGO_DEPTH,
  startGraphAutoRefresh,
  useGraphStore,
} from '@/state/graph-store'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'
import { GraphEdges } from './GraphEdges'
import { GraphPreview } from './GraphPreview'
import { ancestorFolders, buildGraphFindIndex, findGraphMatches } from './find'
import {
  canvasMeasure,
  createCardLayoutCache,
  layoutCard,
  type CardLayout,
  type MeasureText,
} from './canvas/measure'
import { readPalette, type GraphPalette } from './canvas/palette'
import { paintGraph, type PaintNode } from './canvas/paint'
import { createTokenReader } from './canvas/probe'
import {
  OVERSCAN,
  applyManualPositions,
  buildEdgeVisuals,
  buildLayout,
  buildRectIndex,
  edgeAnchors,
  edgeKey,
  edgePath,
  queryIndex,
  queryViewport,
  type EdgeStyle,
  type GraphCardBox,
  type GraphEdgeVisual,
  type GraphFolderBox,
  type Rect,
} from './layout'
import {
  layoutEgo,
  visibleCards,
  type EgoCardBox,
  type EgoSize,
} from './layout-ego'
import {
  canvasSize,
  rectHit,
  toWorld,
  transformOf,
  visibleWorld,
} from './viewport'

import './graph.css'

/** 滚轮缩放的灵敏度（`factor = exp(-deltaY * k)`）。 */
const WHEEL_ZOOM_K = 0.0016

/** 平移拖动与"单击空白处关闭预览"之间的位移阈值。 */
const CLICK_SLOP_PX = 3

/** 焦点视图的卡片宽度（世界坐标）：一屏放得下 3~4 张，正文一行 ≈ 34 个汉字。 */
const EGO_CARD_WIDTH = 320

/**
 * 焦点视图卡片的高度上限。
 *
 * 为什么要有上限：一篇长笔记排完可能有两千像素高，一张卡片就能把整个环撑到屏幕外，
 * 于是"离中心几跳"这个唯一的信息反而看不见了。超出就按**块**截断（`layoutCard` 会在末尾补一行 `…`）。
 */
const EGO_CARD_MAX_HEIGHT = 420

/** 正文还没读到的节点（读失败、或刚好被删）用这个尺寸占位：比空白好，也不会让环半径乱跳。 */
const EGO_FALLBACK_SIZE: EgoSize = { width: EGO_CARD_WIDTH, height: 76 }

/** 全库视图紧凑卡片里标签那一行最多显示几个字符（超出截断加省略号）。 */
const COMPACT_TAG_CHARS = 20

/** 键盘上下左右选卡片时的最大搜索距离（世界坐标）。 */
const KEYBOARD_REACH = 2400

interface PointerState {
  pointerId: number | undefined
  button: number
  lastX: number
  lastY: number
  moved: boolean
  /** 按下的位置在**世界坐标**里的点（判断"点到了哪张卡片"）。 */
  startWorldX: number
  startWorldY: number
  /** 按在卡片上时：那张卡片的路径与"按下点相对卡片左上角"的偏移（拖动时保持不跳）。 */
  card: { relPath: string; grabX: number; grabY: number } | null
}

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

export function GraphCanvas() {
  const rootPath = useVaultStore((state) => state.info?.rootPath ?? null)
  /** 焦点视图的圆心：当前打开的笔记（换笔记 = 换圆心，不需要单独的"设为中心"按钮）。 */
  const focusRoot = useNoteStore((state) => state.doc?.relPath ?? null)
  const themeId = useUiStore((state) => state.themeId)

  const mode = useGraphStore((state) => state.mode)
  const depth = useGraphStore((state) => state.depth)
  const ego = useGraphStore((state) => state.ego)
  const egoStatus = useGraphStore((state) => state.egoStatus)
  const egoError = useGraphStore((state) => state.egoError)
  const texts = useGraphStore((state) => state.texts)
  const status = useGraphStore((state) => state.status)
  const data = useGraphStore((state) => state.data)
  const error = useGraphStore((state) => state.error)
  const selected = useGraphStore((state) => state.selected)
  const view = useGraphStore((state) => state.view)
  const collapsed = useGraphStore((state) => state.collapsed)
  const manual = useGraphStore((state) => state.manual)
  const staleIndex = useGraphStore((state) => state.staleIndex)
  const refreshing = useGraphStore((state) => state.refreshing)
  const refreshNotice = useGraphStore((state) => state.refreshNotice)
  const viewport = useGraphStore((state) => state.viewport)
  const indexPhase = useLinksStore((state) => state.status.phase)

  const hostRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [panning, setPanning] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)
  /** 上一帧真正画出来的卡片数（视口裁剪之后）—— 只用于诊断属性，不参与渲染决策。 */
  const [paintedCards, setPaintedCards] = useState(0)
  const pointerRef = useRef<PointerState | null>(null)

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

  // -------------------------------------------------------------------------
  // 数据加载
  //   · 焦点视图：以当前笔记为圆心拉子图（含每篇正文）
  //   · 全库视图：原来的 `graph_data`
  //   · 保存成功 / 索引就绪 → 由 store 的自动刷新订阅补齐（见 startGraphAutoRefresh）
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (rootPath === null) {
      useGraphStore.getState().clear()
      return
    }
    if (mode === 'focus') {
      // `keepView` 由 store 判断（同一个圆心 + 同一个跳数才谈得上"保留视角"）
      void useGraphStore.getState().loadEgo(focusRoot, { keepView: true })
      return
    }
    const state = useGraphStore.getState()
    void state.load(rootPath, {
      indexBuilding: useLinksStore.getState().status.phase === 'building',
      keepView: state.rootPath === rootPath && state.data !== null,
    })
  }, [rootPath, mode, focusRoot, depth])

  // 保存成功 / 索引就绪后的自动刷新。装在这里、卸载即取消：
  // 模块级监听会永不清理，而"画布是否可见"这个上下文只有组件知道。
  useEffect(() => startGraphAutoRefresh(), [])

  // -------------------------------------------------------------------------
  // 布局（纯函数 + useMemo：平移/缩放**不会**让这里重算）
  // -------------------------------------------------------------------------

  const autoLayout = useMemo(
    () => (mode === 'vault' && data !== null ? buildLayout(data.nodes, collapsed) : null),
    [mode, data, collapsed],
  )
  // 手工位置是 O(n) 的坐标覆盖（不重建文件夹树），拖动时只有这一步会重跑
  const vaultLayout = useMemo(
    () => (autoLayout === null ? null : applyManualPositions(autoLayout, manual)),
    [autoLayout, manual],
  )

  const cardsById = useMemo(() => {
    const map = new Map<string, GraphCardBox>()
    for (const card of vaultLayout?.cards ?? []) map.set(card.relPath, card)
    return map
  }, [vaultLayout])

  const rectIndex = useMemo(
    () => (vaultLayout === null ? null : buildRectIndex(vaultLayout.cards)),
    [vaultLayout],
  )

  /**
   * 焦点视图的几何：先把每篇正文排成卡片（尺寸由此得出），再摆同心环。
   *
   * 顺序不能反：环半径取决于"卡片有多大"，而卡片高度取决于正文排完有多高。
   * 正文是**一次性**跟着子图回来的（`loadEgo` 一起读），所以这里不会出现"排版到一半、
   * 环半径反复变"的跳动 —— 只有读不到正文的那几篇用兜底尺寸。
   */
  const egoLayout = useMemo(() => {
    if (mode !== 'focus' || ego === null || measure === null || layoutRef.current === null) return null
    const cache = layoutRef.current.cache
    const sizes = new Map<string, EgoSize>()
    const layouts = new Map<string, CardLayout>()

    for (const node of ego.data.nodes) {
      const text = texts.get(node.relPath)
      if (text === undefined) {
        sizes.set(node.relPath, EGO_FALLBACK_SIZE)
        continue
      }
      const card = cache.get(
        { relPath: node.relPath, title: node.title, text, width: EGO_CARD_WIDTH, maxHeight: EGO_CARD_MAX_HEIGHT },
        () =>
          layoutCard({
            relPath: node.relPath,
            title: node.title,
            text,
            width: EGO_CARD_WIDTH,
            maxHeight: EGO_CARD_MAX_HEIGHT,
            measure,
          }),
      )
      layouts.set(node.relPath, card)
      sizes.set(node.relPath, { width: card.width, height: card.height })
    }

    const layout = layoutEgo({
      nodes: ego.data.nodes,
      edges: ego.data.edges,
      root: ego.root,
      depth: ego.depth,
      sizes,
      fallbackSize: EGO_FALLBACK_SIZE,
    })
    return { layout, layouts }
  }, [mode, ego, texts, measure])

  // -------------------------------------------------------------------------
  // 视口换算与"屏幕上有哪些卡片"
  // -------------------------------------------------------------------------

  const transform = useMemo(() => transformOf(view, viewport), [view, viewport])
  const visibleWorldRect = useMemo(() => visibleWorld(transform, OVERSCAN), [transform])

  const visibleCardsList = useMemo<EgoCardBox[] | GraphCardBox[]>(() => {
    if (mode === 'focus') {
      return egoLayout === null ? [] : visibleCards(egoLayout.layout.cards, visibleWorldRect)
    }
    if (rectIndex === null) return []
    return queryIndex(rectIndex, visibleWorldRect)
  }, [mode, egoLayout, rectIndex, visibleWorldRect])

  const visibleSet = useMemo(
    () => new Set(visibleCardsList.map((card) => card.relPath)),
    [visibleCardsList],
  )

  const visibleFolders = useMemo(
    () => (vaultLayout === null ? [] : queryViewport(vaultLayout.folders, visibleWorldRect)),
    [vaultLayout, visibleWorldRect],
  )

  // -------------------------------------------------------------------------
  // 画笔的入参
  // -------------------------------------------------------------------------

  const paintNodes = useMemo<PaintNode[]>(() => {
    if (mode === 'focus') {
      if (egoLayout === null) return []
      const root = ego?.root ?? null
      return egoLayout.layout.cards.map((card) => ({
        relPath: card.relPath,
        title: card.node.title,
        rect: card.rect,
        hop: card.hop,
        isRoot: card.relPath === root,
        hasFocus: card.relPath === root || card.relPath === selected,
        layout: egoLayout.layouts.get(card.relPath) ?? null,
        // 正文读不到的那几篇退成紧凑卡片（标题 + 目录 + 度数），至少还能看出它是谁
        ...(egoLayout.layouts.has(card.relPath) ? {} : { compactLines: compactLinesFor(card.node) }),
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
  }, [mode, egoLayout, ego, vaultLayout, selected])

  /** 连线：两种视图都交给 SVG 层（正交折线、箭头、悬空虚影都已经在那里实现好了）。 */
  const edgeVisuals = useMemo<GraphEdgeVisual[]>(() => {
    if (mode === 'focus') {
      if (egoLayout === null || ego === null) return []
      const cards = egoLayout.layout.cardsByPath
      const root = ego.root
      const visuals: GraphEdgeVisual[] = []
      for (const edge of ego.data.edges) {
        // 悬空边在焦点视图里不画：目标不在这一圈里，"线到这里断了"的小刺只会让环更乱
        if (edge.toRelPath === null) continue
        const from = cards.get(edge.fromRelPath)
        const to = cards.get(edge.toRelPath)
        if (from === undefined || to === undefined) continue
        const anchors = edgeAnchors(from.rect, to.rect)
        const touchesRoot = edge.fromRelPath === root || edge.toRelPath === root
        const touchesSelected =
          selected !== null && (edge.fromRelPath === selected || edge.toRelPath === selected)
        const style: EdgeStyle = {
          // 与中心无关的边画虚线：环与环之间的横线是"这两篇也互相提到"，属于上下文，不是主角
          dashed: !touchesRoot,
          dim: !touchesRoot && !touchesSelected,
          highlight: touchesRoot || touchesSelected,
        }
        visuals.push({
          key: edgeKey(edge),
          edge,
          style,
          d: edgePath(anchors.start, anchors.end, anchors.axis, anchors.loop),
          start: anchors.start,
          end: anchors.end,
          phantom: false,
          title:
            edge.count > 1
              ? `${from.node.title} → ${to.node.title} · 共 ${edge.count} 条链接`
              : `${from.node.title} → ${to.node.title}`,
        })
      }
      return visuals
    }
    if (data === null || mode !== 'vault') return []
    // 注意这里用的是**全部可见卡片**（而不是裁剪后的那一批）：线要从卡片边缘出发，
    // 只画两端都在视口里的边会让"线在屏幕中间凭空开始"
    return buildEdgeVisuals(data.edges, cardsById, selected, visibleWorldRect)
  }, [mode, egoLayout, ego, data, cardsById, selected, visibleWorldRect])

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
      // 连线归 SVG 层（见文件头第 2 条）：这里刻意给空数组，避免同一条线画两遍
      edges: [],
      palette: palette.palette,
      measure: measure ?? (() => 0),
      mode,
      selected,
      hovered,
      visible: visibleSet,
      token: palette.token,
    })
    // 真正画出来的张数（视口裁剪之后）也报给宿主属性：它与"交给画笔的张数"是两件事，
    // 而"这一帧到底画了几张"是排查"画布怎么空了/卡了"时第一个想看的事实
    setPaintedCards(stats.cards)
  }, [
    viewport,
    transform,
    paintNodes,
    visibleSet,
    themeId,
    rootPath,
    measure,
    mode,
    selected,
    hovered,
  ])

  // -------------------------------------------------------------------------
  // "定位笔记"：几千张卡片里按名字直达（见 find.ts 的说明）
  // -------------------------------------------------------------------------

  const [findQuery, setFindQuery] = useState('')
  /** 待定位的笔记：卡片可能还在折叠的容器里，展开后要等布局重算才能找到它。 */
  const pendingLocateRef = useRef<string | null>(null)

  const nodesByPath = useMemo(() => {
    const map = new Map<string, GraphNode>()
    for (const node of data?.nodes ?? []) map.set(node.relPath, node)
    for (const node of ego?.data.nodes ?? []) map.set(node.relPath, node)
    return map
  }, [data, ego])

  const findIndex = useMemo(
    () => buildGraphFindIndex(mode === 'focus' ? (ego?.data.nodes ?? []) : (data?.nodes ?? [])),
    [mode, ego, data],
  )
  const findMatches = useMemo(
    () => (findQuery.trim() === '' ? [] : findGraphMatches(findIndex, findQuery, nodesByPath)),
    [findIndex, findQuery, nodesByPath],
  )

  /** 焦点视图里所有卡片（含视口外的）：定位与键盘导航都要用它，不能只看可见的那一批。 */
  const focusCardByPath = useMemo(() => {
    const map = new Map<string, EgoCardBox>()
    for (const card of egoLayout?.layout.cards ?? []) map.set(card.relPath, card)
    return map
  }, [egoLayout])

  /**
   * 把某张卡片摆到视口中央并选中它。
   *
   * 找不到时先**展开它的祖先文件夹**再重试一次（折叠容器里的卡片不在布局里，
   * 直接报"找不到"会让用户以为图谱缺了这篇笔记）；展开是异步的（要等 layout 重算），
   * 因此把目标记进 `pendingLocateRef`，由下面的 effect 在布局更新后补做。
   * 焦点视图没有折叠，找不到就是真的不在子图里 —— 提示"调大跳数"比默默无反应好。
   */
  const locateCard = useCallback(
    (relPath: string): void => {
      // 两种视图的卡片类型不同，但"中心点在哪"这件事一样：先各自取出矩形
      const rect: Rect | undefined = focusCardByPath.get(relPath)?.rect ?? cardsById.get(relPath)
      if (rect === undefined) {
        // 焦点视图没有折叠：找不到就是不在当前深度里（提示由"深度"那一栏负责）
        if (mode !== 'vault') return
        const ancestors = ancestorFolders(relPath)
        const collapsedNow = useGraphStore.getState().collapsed
        const next = [...collapsedNow].filter((path) => !ancestors.includes(path))
        if (next.length !== collapsedNow.size) {
          pendingLocateRef.current = relPath
          useGraphStore.getState().setCollapsed(next)
        }
        return
      }
      const state = useGraphStore.getState()
      const zoom = state.view.zoom
      state.setView({
        zoom,
        x: state.viewport.width / 2 - (rect.x + rect.width / 2) * zoom,
        y: state.viewport.height / 2 - (rect.y + rect.height / 2) * zoom,
      })
      state.select(relPath)
    },
    [mode, focusCardByPath, cardsById],
  )

  // 展开祖先之后补做那一次定位（只做一次，避免每次布局变化都抢镜头）
  useEffect(() => {
    const target = pendingLocateRef.current
    if (target === null) return
    if (!cardsById.has(target)) return
    pendingLocateRef.current = null
    locateCard(target)
  }, [cardsById, locateCard])

  const submitFind = (): void => {
    const first = findMatches[0]
    if (first === undefined) return
    locateCard(first.relPath)
    setFindQuery('')
  }

  // -------------------------------------------------------------------------
  // 视口尺寸上报 + 首次自动"适应窗口"
  // -------------------------------------------------------------------------

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

  useEffect(() => {
    if (mode !== 'vault') return
    // 自动"适应窗口"（同一个 Vault 只做一次，跨挂载记账）。
    // 数据变化、折叠变化、拖动卡片都会让 layout 换一个对象，这里再跑一次也只是空转 ——
    // 镜头属于用户，只有换 Vault / 真实尺寸到手 / 用户自己按"适应窗口"时才该动。
    useGraphStore.getState().autoFit()
  }, [mode, vaultLayout, rootPath, viewport])

  useEffect(() => {
    if (mode !== 'focus' || egoLayout === null) return
    // 焦点视图的包围盒只有组件量得到（它取决于每篇正文排完有多高），所以"适应窗口"的算术
    // 留在 store、包围盒由这里交进去（`Ctrl+0` 那条命令路径也要用它）；同一个 (圆心, 跳数)
    // 只适应一次（跨挂载记账）
    const bounds = egoLayout.layout.bounds
    useGraphStore.getState().setEgoBounds(bounds)
    const key = `${ego?.root ?? ''}\u0000${depth}`
    useGraphStore.getState().autoFitBounds(key, bounds)
  }, [mode, egoLayout, ego, depth, viewport])

  // -------------------------------------------------------------------------
  // 交互：滚轮（平移 + Ctrl 缩放）、拖动平移 / 拖动卡片、命中测试
  //
  // 键盘（`+ - 0 Esc`）已经是命令表里的 `graph.*`（`app/builtin-commands.ts`），
  // 由全局快捷键统一分发；方向键选卡片是本组件自己的（见下）。
  // -------------------------------------------------------------------------

  /**
   * `+` / `=` 的兜底分发。
   *
   * 为什么需要它：命令表的快捷键串用 `+` 当分隔符（`'Mod+='.split('+')`），
   * 所以**加号键本身写不进命令表** —— 真实键盘上 `Ctrl`+`+` 的事件会被算成 `Mod+Shift++`，
   * 与任何归一化后的串都对不上（`Mod+=` 只覆盖"按 `Ctrl` 和 `=`"这一种按法）。
   * 这里只做**转交**：按键 → `graph.zoomIn` 命令 → store 动作，不自己算缩放。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return
      if (event.key !== '+' && event.key !== '=') return
      if (isTextEntryTarget(event.target)) return
      const command = commands.get(GRAPH_COMMAND_IDS.zoomIn)
      if (command === undefined || !(command.when?.() ?? true)) return
      event.preventDefault()
      void commands.execute(command.id)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const applyWheel = useCallback((event: WheelEvent): void => {
    const host = hostRef.current
    if (host === null) return
    // 预览面板里的滚轮属于"滚正文"，不该把画布缩放掉。
    // （HUD 没有可滚动内容，因此不在排除之列 —— 光标停在 HUD 上时滚轮照样平移/缩放画布。）
    if (event.target instanceof Element && event.target.closest('.mn-graph-preview') !== null) {
      return
    }
    event.preventDefault()
    const state = useGraphStore.getState()
    if (event.ctrlKey || event.metaKey) {
      // Ctrl + 滚轮：以光标为锚点缩放（光标下的那张卡片不会跑掉）
      const rect = host.getBoundingClientRect()
      state.zoomAt(Math.exp(-event.deltaY * WHEEL_ZOOM_K), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      })
      return
    }
    // 滚轮平移：默认纵向，Shift 转横向（`deltaX` 也照常吃，触控板横滑因此可用）
    if (event.shiftKey) state.panBy(-event.deltaY - event.deltaX, 0)
    else state.panBy(-event.deltaX, -event.deltaY)
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    // 必须用原生监听 + `passive: false`：React 的 onWheel 是**被动**监听，
    // 在那里 preventDefault 无效，页面/WebView 会跟着滚（也会触发浏览器缩放）
    host.addEventListener('wheel', applyWheel, { passive: false })
    return () => host.removeEventListener('wheel', applyWheel)
  }, [applyWheel])

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
        for (let index = cards.length - 1; index >= 0; index -= 1) {
          const card = cards[index]
          if (card === undefined) continue
          if (rectHit(card.rect, point, tolerance)) return { relPath: card.relPath, rect: card.rect }
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
    [mode, egoLayout, vaultLayout, transform.scale],
  )

  const fitNow = useCallback(() => {
    const state = useGraphStore.getState()
    if (state.mode === 'focus') {
      const bounds = egoLayout?.layout.bounds
      if (bounds !== undefined) state.fitToBounds(bounds)
      return
    }
    state.fitToWindow()
  }, [egoLayout])

  const zoomIn = useCallback(() => {
    useGraphStore.getState().zoomIn()
  }, [])

  const zoomOut = useCallback(() => {
    useGraphStore.getState().zoomOut()
  }, [])

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const target = event.target
      if (!(target instanceof Element)) return
      // HUD / 预览面板 / 文件夹标题按钮：它们自己处理点击，不参与画布平移
      if (target.closest('[data-mn-graph-nopan]') !== null) return
      if (event.button !== 0 && event.button !== 1) return

      const world = worldPointOf(event.clientX, event.clientY)
      if (world === null) return
      const hit = event.button === 0 ? hitCard(world) : null

      const element = event.currentTarget
      if (typeof element.setPointerCapture === 'function') {
        try {
          element.setPointerCapture(event.pointerId)
        } catch {
          // 环境不支持指针捕获（jsdom）：不影响拖动，只是指针移出元素后会断开
        }
      }
      pointerRef.current = {
        pointerId: event.pointerId,
        button: event.button,
        lastX: event.clientX,
        lastY: event.clientY,
        moved: false,
        startWorldX: world.x,
        startWorldY: world.y,
        // 拖卡片只在全库视图里成立：焦点视图里卡片的位置**就是**"离中心几跳"，
        // 拖动会把这个唯一的信息变成谎话（"我明明把它拖到外圈了"）
        card:
          hit !== null && mode === 'vault'
            ? { relPath: hit.relPath, grabX: world.x - hit.rect.x, grabY: world.y - hit.rect.y }
            : null,
      }
      setPanning(true)
    },
    [hitCard, mode, worldPointOf],
  )

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = pointerRef.current
      // 没按下时只更新悬停（用于高亮与鼠标指针形状）
      if (state === null) {
        const world = worldPointOf(event.clientX, event.clientY)
        const hit = world === null ? null : hitCard(world)
        setHovered((current) => (current === (hit?.relPath ?? null) ? current : (hit?.relPath ?? null)))
        return
      }
      if (state.pointerId !== event.pointerId) return

      const dx = event.clientX - state.lastX
      const dy = event.clientY - state.lastY
      if (dx === 0 && dy === 0) return
      if (Math.abs(dx) + Math.abs(dy) > CLICK_SLOP_PX) state.moved = true
      state.lastX = event.clientX
      state.lastY = event.clientY

      if (state.card !== null && state.moved) {
        // 拖卡片：抓点相对卡片左上角的偏移保持不变（否则卡片会"跳"到光标下）
        const world = worldPointOf(event.clientX, event.clientY)
        if (world !== null) {
          useGraphStore.getState().moveCard(
            state.card.relPath,
            world.x - state.card.grabX,
            world.y - state.card.grabY,
          )
        }
        return
      }
      // 按在卡片上但还没超过拖动阈值：**先不动**（否则拖卡片之前画布会先抖一下）
      if (state.card !== null) return
      useGraphStore.getState().panBy(dx, dy)
    },
    [hitCard, worldPointOf],
  )

  const endPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const state = pointerRef.current
    if (state === null || state.pointerId !== event.pointerId) return
    pointerRef.current = null
    setPanning(false)
    const element = event.currentTarget
    if (typeof element.releasePointerCapture === 'function') {
      try {
        element.releasePointerCapture(event.pointerId)
      } catch {
        // 指针已经释放
      }
    }
    if (event.type !== 'pointerup' || state.button !== 0) return

    if (state.moved) return // 拖动过：不改选中（拖卡片 / 拖画布都不是"点了一下"）
    // 没拖动：点在卡片上 = 选中（右侧出现预览），点在空白 = 关掉预览
    const world = { x: state.startWorldX, y: state.startWorldY }
    const hit = hitCard(world)
    useGraphStore.getState().select(hit?.relPath ?? null)
  }, [hitCard])

  /** 双击卡片 = 在编辑器里打开它（焦点视图里这也顺带把圆心换成了它）。 */
  const handleDoubleClick = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const world = worldPointOf(event.clientX, event.clientY)
      if (world === null) return
      const hit = hitCard(world)
      if (hit === null) return
      useUiStore.getState().setViewMode('edit')
      void openNote(hit.relPath)
    },
    [hitCard, worldPointOf],
  )

  /**
   * 键盘：方向键在同一方向上的**最近卡片**之间移动选中项。
   *
   * 为什么要有它：卡片不再是 DOM 元素，Tab 键再也走不到它们身上 —— 没有这一步，
   * 画布对键盘用户就等于一块不可操作的图片。判据只需要几何：以当前选中的卡片中心为原点，
   * 在目标方向 ±60° 的扇形里找最近的（没有选中时从最靠左上角的一张开始）。
   */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      const steps: Record<string, { x: number; y: number }> = {
        ArrowLeft: { x: -1, y: 0 },
        ArrowRight: { x: 1, y: 0 },
        ArrowUp: { x: 0, y: -1 },
        ArrowDown: { x: 0, y: 1 },
      }
      const direction = steps[event.key]
      if (direction === undefined) return
      // 输入框与预览面板里的方向键属于它们自己（一个是要移动光标，一个是要滚正文）：
      // 画布只在"焦点就在画布上"时接管
      if (isTextEntryTarget(event.target)) return
      if (event.target instanceof Element && event.target.closest('.mn-graph-preview') !== null) return
      const cards =
        mode === 'focus'
          ? (egoLayout?.layout.cards ?? []).map((card) => ({ relPath: card.relPath, rect: card.rect }))
          : (vaultLayout?.cards ?? []).map((card) => ({ relPath: card.relPath, rect: card }))
      if (cards.length === 0) return
      event.preventDefault()

      const current = cards.find((card) => card.relPath === selected)
      if (current === undefined) {
        useGraphStore.getState().select(cards[0]?.relPath ?? null)
        return
      }
      const originX = current.rect.x + current.rect.width / 2
      const originY = current.rect.y + current.rect.height / 2
      let best: { relPath: string; distance: number } | null = null
      for (const card of cards) {
        if (card.relPath === current.relPath) continue
        const dx = card.rect.x + card.rect.width / 2 - originX
        const dy = card.rect.y + card.rect.height / 2 - originY
        const forward = dx * direction.x + dy * direction.y
        if (forward <= 0) continue // 不在这个方向上
        const distance = Math.hypot(dx, dy)
        if (distance > KEYBOARD_REACH) continue
        // ±60° 扇形：横向偏移不超过前进距离的 1.7 倍（`tan(60°)`）
        const sideways = Math.abs(dx * direction.y - dy * direction.x)
        if (sideways > forward * 1.7) continue
        if (best === null || distance < best.distance) best = { relPath: card.relPath, distance }
      }
      const target = best?.relPath
      if (target === undefined) return
      useGraphStore.getState().select(target)
      locateCard(target)
    },
    [mode, egoLayout, vaultLayout, selected, locateCard],
  )

  // -------------------------------------------------------------------------
  // 卡片 / 容器的回调
  // -------------------------------------------------------------------------

  const handleOpenInEditor = useCallback((relPath: string) => {
    useUiStore.getState().setViewMode('edit')
    void openNote(relPath)
  }, [])

  const handleToggleFolder = useCallback((path: string) => {
    useGraphStore.getState().toggleFolder(path)
  }, [])

  /** 手动"重新读取图谱"：**完整重载**（清空视角/折叠/选中）。 */
  const handleRefresh = useCallback(() => {
    const state = useGraphStore.getState()
    if (state.mode === 'focus') {
      void state.loadEgo(focusRoot, { keepView: false })
      return
    }
    void state.load(rootPath, { indexBuilding: useLinksStore.getState().status.phase === 'building' })
  }, [rootPath, focusRoot])

  const selectedCard =
    selected === null ? undefined : (focusCardByPath.get(selected) ?? cardsById.get(selected))
  const selectedNode = selected === null ? undefined : nodesByPath.get(selected)
  const nodeCount = mode === 'focus' ? (ego?.data.nodes.length ?? 0) : (data?.nodes.length ?? 0)
  const edgeCount = mode === 'focus' ? (ego?.data.edges.length ?? 0) : (data?.edges.length ?? 0)
  const truncated = mode === 'focus' ? (ego?.data.truncated ?? false) : (data?.truncated ?? true)
  const showIndexNotice = indexPhase === 'building' || staleIndex
  const loading = mode === 'focus' ? egoStatus === 'loading' : status === 'loading'
  const activeError = mode === 'focus' ? egoError : error
  // 焦点视图里"没有圆心"= 没有打开的笔记（这一条要压住 loading 态：两者同时成立时
  // 说的是同一件事，叠两层遮罩只会互相盖住）
  const empty =
    mode === 'focus' ? focusRoot === null && !loading : status === 'ready' && (data?.nodes.length ?? 0) === 0

  return (
    <div
      className={`mn-graph${panning ? ' mn-graph--panning' : ''}${
        hovered === null ? '' : ' mn-graph--over-card'
      } mn-graph--${mode}`}
      ref={hostRef}
      role="application"
      aria-label={
        mode === 'focus'
          ? `与「${focusRoot ?? '（未打开笔记）'}」相关的关系图，${depth} 跳`
          : '整个 Vault 的知识图谱'
      }
      tabIndex={0}
      data-graph-mode={mode}
      data-graph-depth={depth}
      /*
        当前的世界 → 屏幕换算，写成属性是为了**可断言**：卡片画在 canvas 上，测试与自动化
        没有 DOM 节点可点，而"世界原点的屏幕位置"就是中心那张卡片的中心 —— 有了这三个数，
        端到端用例可以精确点到某张卡片，而不必去猜像素（与预览层的 `data-mn-render` 同一个思路：
        把"这次到底怎么算的"变成界面上读得到的事实）。
      */
      data-graph-scale={view.zoom}
      data-graph-offset-x={Math.round(view.x)}
      data-graph-offset-y={Math.round(view.y)}
      /* 交给画笔的卡片数（= 布局里的全部卡片，**未**经视口裁剪） */
      data-graph-canvas-cards={paintNodes.length}
      /* 上一帧真正画出来的张数（裁剪之后） */
      data-graph-painted-cards={paintedCards}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onPointerLeave={() => setHovered(null)}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
    >
      {/* 连线与文件夹容器留在 DOM 里（同一套 CSS transform），卡片画在 canvas 上 */}
      <div
        className="mn-graph__viewport"
        style={{
          transform: `translate(${Math.round(view.x)}px, ${Math.round(view.y)}px) scale(${view.zoom})`,
        }}
      >
        <div
          className="mn-graph__world"
          style={{
            width: vaultLayout?.bounds.width ?? 0,
            height: vaultLayout?.bounds.height ?? 0,
          }}
        >
          <GraphEdges visuals={edgeVisuals} viewBox={visibleWorldRect} />

          {mode === 'vault' &&
            visibleFolders.map((folder) => (
              <GraphFolder
                key={folder.path === '' ? '\u0000root' : folder.path}
                folder={folder}
                onToggle={handleToggleFolder}
              />
            ))}
        </div>
      </div>

      {/* 卡片层：自己算世界 → 屏幕的换算，因此缩放时文字是**重新排版**而不是被放大 */}
      <canvas
        className="mn-graph__canvas"
        ref={canvasRef}
        data-mn-cards={paintNodes.length}
        aria-hidden="true"
      />

      {/* ---------------------------------------------------------------- HUD */}
      <div className="mn-graph__hud" data-mn-graph-nopan>
        <div className="mn-graph__stats">
          {/* 视图切换：焦点（默认）与整个 Vault。两个按钮而不是一个开关：
              "我现在在哪个视图"必须一眼看出来，开关的两种样子容易看混 */}
          <div className="mn-graph__modes" role="group" aria-label="图谱视图">
            <button
              type="button"
              className={`mn-graph__mode${mode === 'focus' ? ' mn-graph__mode--active' : ''}`}
              aria-pressed={mode === 'focus'}
              data-graph-action="mode-focus"
              onClick={() => useGraphStore.getState().setMode('focus')}
              title="只看与当前笔记相关的部分"
            >
              <Icon name="links" size={12} />
              关系图
            </button>
            <button
              type="button"
              className={`mn-graph__mode${mode === 'vault' ? ' mn-graph__mode--active' : ''}`}
              aria-pressed={mode === 'vault'}
              data-graph-action="mode-vault"
              onClick={() => useGraphStore.getState().setMode('vault')}
              title="整个 Vault（按文件夹分组）"
            >
              <Icon name="folderOpen" size={12} />
              整个 Vault
            </button>
          </div>

          {/* 跳数调节：进入时是 1（只有直接相关的），要看得更远自己往上加 */}
          {mode === 'focus' && (
            <div className="mn-graph__depth" role="group" aria-label="关系图深度">
              <span className="mn-graph__depth-label">深度</span>
              <button
                type="button"
                className="mn-graph__depth-step"
                data-graph-action="depth-down"
                aria-label="减少一跳"
                disabled={depth <= MIN_EGO_DEPTH}
                onClick={() => useGraphStore.getState().setDepth(depth - 1)}
              >
                −
              </button>
              <span className="mn-graph__depth-value" data-graph-depth-value={depth}>
                {depth} 跳
              </span>
              <button
                type="button"
                className="mn-graph__depth-step"
                data-graph-action="depth-up"
                aria-label="增加一跳"
                disabled={depth >= MAX_EGO_DEPTH}
                onClick={() => useGraphStore.getState().setDepth(depth + 1)}
              >
                +
              </button>
            </div>
          )}

          <span className="mn-graph__stat">{nodeCount} 节点</span>
          <span className="mn-graph__stat">{edgeCount} 边</span>
          <span className="mn-graph__stat" title="当前缩放（Ctrl+滚轮 / Ctrl+= 放大 / Ctrl+- 缩小 / Ctrl+0 适应窗口）">
            {Math.round(view.zoom * 100)}%
          </span>
          {refreshing && (
            <span className="mn-graph__badge mn-graph__badge--busy" title="正在重新读取图谱数据（保留当前视角）">
              刷新中…
            </span>
          )}
          {truncated && (
            <span
              className="mn-graph__badge mn-graph__badge--warn"
              title={
                mode === 'focus'
                  ? '相关的笔记太多，只显示了离中心最近的一部分（调小深度可以看得更清）'
                  : '节点数超过宿主上限，只返回了度数最高的一部分'
              }
            >
              已截断
            </span>
          )}
          {mode === 'vault' && vaultLayout !== null && vaultLayout.hiddenCards > 0 && (
            <span className="mn-graph__badge" title="被折叠的容器里的卡片">
              已折叠 {vaultLayout.hiddenCards}
            </span>
          )}
        </div>

        <div className="mn-graph__legend">
          {mode === 'focus' ? (
            <>
              <span className="mn-graph__legend-item">
                <i className="mn-graph__legend-dot" />
                半径 = 离当前笔记几跳
              </span>
              <span className="mn-graph__legend-item">
                <i className="mn-graph__legend-line" />
                实线 = 与它直接相关
              </span>
              <span className="mn-graph__legend-item">
                <i className="mn-graph__legend-line mn-graph__legend-line--dashed" />
                虚线 = 环与环之间
              </span>
            </>
          ) : (
            <>
              <span className="mn-graph__legend-item">
                <i className="mn-graph__legend-line" />
                实线 = 出链
              </span>
              <span className="mn-graph__legend-item">
                <i className="mn-graph__legend-line mn-graph__legend-line--dashed" />
                虚线 = 入链
              </span>
              <span className="mn-graph__legend-item">
                <i className="mn-graph__legend-dot" />
                悬空链接
              </span>
            </>
          )}
        </div>

        <div className="mn-graph__tools">
          {/* 定位笔记：几千张卡片时，"我想看看某一篇周围连了什么"没法靠拖拽完成 */}
          <div className="mn-graph__find">
            <input
              className="mn-graph__find-input"
              type="search"
              value={findQuery}
              placeholder={mode === 'focus' ? '在关系图里定位…' : '定位笔记…'}
              aria-label="定位笔记"
              onChange={(event) => setFindQuery(event.target.value)}
              onKeyDown={(event) => {
                // 画布自己也监听键盘（+/-/0 与方向键），这里把输入框里的事件拦住，
                // 否则在输入框里敲 "-" 会顺手把画布缩小
                event.stopPropagation()
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submitFind()
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setFindQuery('')
                }
              }}
            />
            {findQuery.trim() !== '' && (
              <ul className="mn-graph__find-list" role="listbox" aria-label="定位候选">
                {findMatches.length === 0 ? (
                  // 空态要说清楚：焦点视图里"没有匹配"往往意味着"这篇不在当前深度里"，
                  // 与全库视图的"被截断掉了"是两回事
                  <li className="mn-graph__find-empty">
                    {mode === 'focus' ? '当前深度里没有这篇笔记' : '没有匹配的卡片'}
                  </li>
                ) : (
                  findMatches.slice(0, 8).map((match) => (
                    <li key={match.relPath}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={match.relPath === selected}
                        data-find-path={match.relPath}
                        onClick={() => {
                          locateCard(match.relPath)
                          setFindQuery('')
                        }}
                      >
                        <span className="mn-graph__find-title">{match.title}</span>
                        {match.folder !== '' && (
                          <span className="mn-graph__find-folder">{match.folder}</span>
                        )}
                      </button>
                    </li>
                  ))
                )}
              </ul>
            )}
          </div>
          <button type="button" className="mn-icon-button" onClick={fitNow} title="适应窗口（Ctrl+0）" aria-label="适应窗口">
            <Icon name="eye" size={14} />
          </button>
          <button type="button" className="mn-icon-button" onClick={zoomOut} title="缩小（Ctrl+-）" aria-label="缩小">
            <span className="mn-graph__zoom-glyph">−</span>
          </button>
          <button type="button" className="mn-icon-button" onClick={zoomIn} title="放大（Ctrl+=）" aria-label="放大">
            <span className="mn-graph__zoom-glyph">+</span>
          </button>
          {mode === 'vault' && (
            <>
              <button
                type="button"
                className="mn-icon-button"
                onClick={() => useGraphStore.getState().resetManual()}
                title="重新自动排布（清除手工拖动的位置）"
                aria-label="重新自动排布"
              >
                <Icon name="columns" size={14} />
              </button>
              <button
                type="button"
                className="mn-icon-button"
                onClick={() => useGraphStore.getState().setCollapsed([])}
                title="展开全部文件夹"
                aria-label="展开全部文件夹"
              >
                <Icon name="folderOpen" size={14} />
              </button>
              <button
                type="button"
                className="mn-icon-button"
                onClick={() => useGraphStore.getState().setCollapsed(vaultLayout?.folderPaths ?? [])}
                title="收起全部文件夹"
                aria-label="收起全部文件夹"
              >
                <Icon name="folder" size={14} />
              </button>
            </>
          )}
          <button type="button" className="mn-icon-button" onClick={handleRefresh} title="重新读取图谱" aria-label="重新读取图谱">
            <Icon name="refresh" size={14} />
          </button>
        </div>
      </div>

      {/*
        顶部只留**一条**横幅：刷新提示与"索引构建中"说的是同一件事（画布上的数据可能不是最新），
        刷新的那条更具体（它直接说明"你看到的是上一次的结果"），所以同时成立时优先显示它 ——
        两条横幅叠在同一个位置只会互相盖住。
      */}
      {(refreshNotice !== null || showIndexNotice) && (
        <div className="mn-graph__notice" data-mn-graph-nopan>
          <Icon name="refresh" size={12} />
          <span>{refreshNotice ?? '链接索引构建中…（图谱可能还不完整）'}</span>
          <button type="button" className="mn-graph__notice-action" onClick={handleRefresh}>
            {refreshNotice === null ? '立即刷新' : '重新读取'}
          </button>
        </div>
      )}

      {loading && nodeCount === 0 && (
        <div className="mn-graph__overlay">
          {mode === 'focus' ? '正在读取关系图（含每篇正文）…' : '正在读取图谱…'}
        </div>
      )}

      {activeError !== null && (
        <div className="mn-graph__overlay">
          <p className="mn-empty__text">{describeError(activeError, '读取图谱失败')}</p>
          <button type="button" className="mn-graph__notice-action" onClick={handleRefresh}>
            重试
          </button>
        </div>
      )}

      {empty && !showIndexNotice && (
        <div className="mn-graph__overlay">
          <p className="mn-empty__text">
            {mode === 'focus'
              ? '打开一篇笔记，这里就会显示与它相关的关系图'
              : '这个 Vault 里还没有笔记（图谱的卡片来自 Markdown 笔记与它们之间的链接）'}
          </p>
          {mode === 'focus' && (
            <button
              type="button"
              className="mn-graph__notice-action"
              onClick={() => useGraphStore.getState().setMode('vault')}
            >
              看看整个 Vault
            </button>
          )}
        </div>
      )}

      {mode === 'focus' && egoStatus === 'ready' && nodeCount === 1 && (
        <div className="mn-graph__overlay mn-graph__overlay--hint">
          <p className="mn-empty__text">这篇笔记还没有任何链接（调大深度也不会多出东西来）</p>
        </div>
      )}

      {selected !== null && (
        <GraphPreview
          relPath={selected}
          title={selectedNode?.title ?? selectedCard?.node.title ?? selected}
          onClose={() => useGraphStore.getState().closePreview()}
          onOpenInEditor={handleOpenInEditor}
        />
      )}
    </div>
  )
}

/** 一个文件夹容器（展开时是圆角区域，收起时是紧凑的"文件夹卡片"）。 */
function GraphFolder({
  folder,
  onToggle,
}: {
  folder: GraphFolderBox
  onToggle: (path: string) => void
}) {
  const action = folder.collapsed ? '展开' : '收起'
  return (
    <div
      className={`mn-graph-folder${folder.collapsed ? ' mn-graph-folder--chip' : ''}`}
      style={{ left: folder.x, top: folder.y, width: folder.width, height: folder.height }}
      data-folder={folder.path}
      data-depth={folder.depth}
    >
      <button
        type="button"
        className="mn-graph-folder__header"
        data-mn-graph-nopan
        aria-expanded={!folder.collapsed}
        aria-label={`${action} ${folder.label}（${folder.noteCount} 篇）`}
        title={
          folder.collapsed
            ? `${folder.label}：${folder.noteCount} 篇（点击展开）`
            : `${folder.label}：${folder.noteCount} 篇（点击收起）`
        }
        onClick={() => onToggle(folder.path)}
      >
        <Icon name={folder.collapsed ? 'folder' : 'folderOpen'} size={12} />
        <span className="mn-graph-folder__label">{folder.label}</span>
        <span className="mn-graph-folder__count">{folder.noteCount}</span>
      </button>
    </div>
  )
}
