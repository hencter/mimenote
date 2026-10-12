/**
 * 图谱的**视图状态**切片（zustand slice）。
 *
 * 一句话职责：视口（平移/缩放/适应窗口）、折叠集合、手工拖动位置、选中项与"被按住的卡片"，
 * 以及"焦点视图 vs 全库视图"这个模式与跳数。
 *
 * 为什么与数据/卡片分开（ADR-0060 §3(b)）：这四份状态的读写频率差三个数量级 ——
 * `view` 每帧都可能变（滚轮、拖动、漂浮），`collapsed` 一天动一次；混在一个 store 里时
 * 一次视口更新会把订阅了"折叠"的地方也拖进来重算。切片之间用 `get()` 交叉读（现状就是这样），
 * **不要**把它们再合并回去（那正是拆分前的形状）。
 *
 * 两个跨切片的约定：
 * - `fitKey` / `egoBounds` 这类"适应窗口的记账"住在视图切片（记录的是**镜头**的状态），
 *   并且刻意记在 store 而不是组件 ref 里：图谱视图切走会卸载画布组件，ref 随之丢失，
 *   每次切回来都重新适应窗口会把用户刚摆好的视角悄悄重置；
 * - `mode` / `depth` 一变就清掉记账 —— 换视图/换跳数等于换一幅图，旧包围盒属于上一幅图。
 */

import type { StateCreator } from 'zustand'

import {
  FIT_PADDING,
  ZOOM_STEP,
  buildLayout,
  clampZoom,
  fitView,
  panBy as panByPure,
  zoomAround as zoomAroundPure,
  type GraphView,
  type Point,
  type Rect,
  type Size,
} from '@/domain/graph/layout'
import { clampEgoDepth, type GraphMode } from '@/domain/graph/prefs'
import type { GraphData } from '@/ipc/types'

import type { FloatingPane } from './graph-cards-store'
import { PREFS_KEY, flushPositions, prefsOf, readPrefs, schedulePositions } from './graph-persist'
import type { GraphState } from './graph-store'
import { saveJson } from './persist'

export const DEFAULT_VIEW: GraphView = { x: 0, y: 0, zoom: 1 }

/**
 * 首帧（或 jsdom 这类没有布局的环境）用的视口尺寸。
 *
 * 为什么要有兜底：`clientWidth` 为 0 时任何"适应窗口"都会算出 zoom = 0 或无穷，
 * 于是整块画布被裁成空。用一个合理的默认值可以让**没有真实布局的环境**（单元测试）
 * 依然算出可用的视角；真实环境里第一帧之后 ResizeObserver 会立刻上报真实尺寸，
 * 那时会再自动适应一次（见 `fitKey` 的说明）。
 */
export const FALLBACK_VIEWPORT: Size = { width: 1280, height: 800 }

/** 画布视口的像素尺寸。 */
export interface GraphViewport {
  width: number
  height: number
  /** 是否已经拿到**真实**尺寸（首帧/无布局环境里只有兜底值，之后会自动再适应一次）。 */
  known: boolean
}

/** 当前视口下的"适应窗口"结果；没有可适应内容时返回 `null`。 */
function computeFit(state: {
  mode: GraphMode
  data: GraphData | null
  collapsed: ReadonlySet<string>
  viewport: GraphViewport
  egoBounds: Rect | null
}): GraphView | null {
  if (state.mode === 'focus') {
    // 焦点视图的几何只有组件知道（卡片高度取决于正文排完有多高），所以用它交进来的包围盒
    const bounds = state.egoBounds
    if (bounds === null || bounds.width <= 0 || bounds.height <= 0) return null
    return fitView(bounds, { width: state.viewport.width, height: state.viewport.height }, FIT_PADDING)
  }
  const data = state.data
  if (data === null || data.nodes.length === 0) return null
  // 手工位置不参与：它只改卡片坐标，不改"整块画布的边界"（`buildLayout` 的 bounds）
  const layout = buildLayout(data.nodes, state.collapsed)
  if (layout.totalCards === 0) return null
  return fitView(layout.bounds, { width: state.viewport.width, height: state.viewport.height }, FIT_PADDING)
}

/** 自动适应窗口的键：换 Vault、或从"兜底尺寸"变成"真实尺寸"时要重新适应一次。 */
function autoFitKey(rootPath: string | null, viewport: GraphViewport): string {
  return `${rootPath ?? ''}\u0000${viewport.known ? 'known' : 'fallback'}`
}

/** 视图切片：镜头、折叠、手工位置、选中与按住，以及两种视图的模式与跳数。 */
export interface ViewSlice {
  /** 选中的卡片 = 画布上正在预览的那一篇；`null` = 没有预览。 */
  selected: string | null
  view: GraphView
  /** 收起的文件夹（POSIX 目录路径）。**默认空集 = 全部展开**（用户说"不需要人为处理"）。 */
  collapsed: ReadonlySet<string>
  /** 用户手工拖动过的卡片位置（覆盖自动布局，按 `Vault 根 + relPath` 持久化）。 */
  manual: ReadonlyMap<string, Point>

  /** 画布视口尺寸（由画布组件上报）：命令表里的缩放/适应窗口要按它算锚点。 */
  viewport: GraphViewport

  /** 已经自动"适应窗口"过的键（`Vault 根 + 尺寸是否已知`）。 */
  fitKey: string | null

  /** 当前是哪一种视图：`focus` = 以当前笔记为圆心的子图，`vault` = 整个 Vault。 */
  mode: GraphMode
  /** 自我中心视图的跳数（1..5，双向）。 */
  depth: number

  /**
   * 焦点视图当前布局的包围盒（由组件交进来）。
   *
   * 为什么放在 store 而不是组件里：`Ctrl+0`（`graph.fit` 命令）走的是全局命令表 →
   * `fitToWindow()`，那条路拿不到组件的 state。"适应窗口"必须对**当前正在看的那幅图**成立，
   * 否则在关系图里按 `Ctrl+0` 会去适应全库的包围盒（镜头被甩到一片空地上）。
   */
  egoBounds: Rect | null
  /** 组件上报焦点视图的包围盒（`null` = 没有可适应的内容）。 */
  setEgoBounds: (bounds: Rect | null) => void

  /**
   * 用户按住的卡片（relPath → 世界坐标里的**中心点**）。
   *
   * 放在 store 而不是组件 ref 里：它是**用户看得见的状态**（HUD 上要显示"已按住 N 张"、
   * 力导向的重建也要以它为输入），而且"按住/松开"要能被命令与测试观察到。
   * 不落盘：这是这一次会话里的临时摆放，下次打开图谱应当重新落定。
   */
  pins: ReadonlyMap<string, Point>
  /** 按住一张卡片（拖动时逐帧调用，中心点坐标）。 */
  pinCard: (relPath: string, center: Point) => void
  /** 松开全部（或某一张）被按住的卡片，让张力重新把位置摆回去。 */
  unpinCards: (relPath?: string) => void

  setMode: (mode: GraphMode) => void
  /** 调节跳数（会立刻重拉子图；视角保留）。 */
  setDepth: (depth: number) => void
  /** 把自我中心布局的包围盒交给 store 做"适应窗口"（尺寸只有组件量得出来）。 */
  fitToBounds: (bounds: Rect) => void
  /** 首次拿到某个 (圆心, 跳数) 的布局时自动适应一次；同一个键只做一次（跨挂载记账）。 */
  autoFitBounds: (key: string, bounds: Rect) => void

  select: (relPath: string | null) => void
  /**
   * `Esc`（`graph.closePreview` 命令）走这里：**先关最上面的浮窗，没有浮窗才取消选中**。
   *
   * 名字里的 "Preview" 是历史遗留：停靠在画布右侧的预览面板已随 ADR-0025 移除
   * （卡片正面就是完整正文），命令 id 不变是为了不惊动快捷键与测试。
   */
  closePreview: () => void

  toggleFolder: (path: string) => void
  setCollapsed: (paths: readonly string[]) => void

  setView: (view: GraphView) => void
  panBy: (dx: number, dy: number) => void
  /** 以 `focal`（**屏幕坐标**）为锚点缩放；按钮缩放传视口中心。 */
  zoomAt: (factor: number, focal: Point) => void
  /** 画布组件上报视口尺寸（命令表要按它算缩放锚点与适应窗口）。 */
  setViewport: (size: Size) => void
  /** 放大 / 缩小（以视口中心为锚点）：画布按钮与 `graph.zoomIn` / `graph.zoomOut` 共用。 */
  zoomIn: () => void
  zoomOut: () => void
  /** 让整块画布落进视口（画布按钮与 `graph.fit` 共用）。 */
  fitToWindow: () => void
  /**
   * 首次拿到某个 Vault 的布局时自动"适应窗口"（同一个 Vault 只做一次）。
   *
   * 为什么记在 store 而不是组件的 ref 里：图谱视图切走会**卸载**画布组件，ref 随之丢失，
   * 于是每次切回来都会重新适应窗口 —— 用户刚摆好的视角被悄悄重置（这正是要修的问题）。
   */
  autoFit: () => void

  moveCard: (relPath: string, x: number, y: number) => void
  resetManual: () => void
}

export const createViewSlice: StateCreator<GraphState, [], [], ViewSlice> = (set, get) => ({
  selected: null,
  view: DEFAULT_VIEW,
  collapsed: new Set<string>(),
  manual: new Map<string, Point>(),
  viewport: { ...FALLBACK_VIEWPORT, known: false },
  fitKey: null,
  mode: readPrefs().mode,
  depth: readPrefs().depth,
  egoBounds: null,
  pins: new Map<string, Point>(),

  select: (selected) => set({ selected }),

  /**
   * `Esc`（`graph.closePreview` 命令）走这里。
   *
   * **先关最上面的浮窗，没有浮窗才取消选中**：`Esc` 在用户心里的意思是"关掉最上面那层"，
   * 而浮窗是后出现的、盖在画布之上的东西。停靠预览面板已随 ADR-0025 移除
   * （卡片正面就是完整正文），所以第二层语义从"关预览"变成"取消选中"。
   */
  closePreview: () => {
    const panes = get().floatingPanes
    if (panes.length > 0) {
      const top = panes.reduce((best, pane) => (pane.z > best.z ? pane : best), panes[0] as FloatingPane)
      get().closeFloating(top.relPath)
      return
    }
    set({ selected: null })
  },

  toggleFolder: (path) => {
    const next = new Set(get().collapsed)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    set({ collapsed: next })
  },

  setCollapsed: (paths) => set({ collapsed: new Set(paths) }),

  setView: (view) => set({ view: { ...view, zoom: clampZoom(view.zoom) } }),

  panBy: (dx, dy) => set({ view: panByPure(get().view, dx, dy) }),

  zoomAt: (factor, focal) => {
    // 锚点缩放：以光标（或视图中心）下的世界坐标不动，这是"缩放不迷路"的关键
    set({ view: zoomAroundPure(get().view, factor, focal) })
  },

  setViewport: (size) => {
    const current = get().viewport
    const width = Math.max(0, Math.round(size.width))
    const height = Math.max(0, Math.round(size.height))
    // 尺寸没变就不要写 state：ResizeObserver 的回调会让整棵画布重渲染
    if (current.known && current.width === width && current.height === height) return
    set({ viewport: { width, height, known: true } })
  },

  zoomIn: () => {
    const { view, viewport } = get()
    set({ view: zoomAroundPure(view, ZOOM_STEP, { x: viewport.width / 2, y: viewport.height / 2 }) })
  },

  zoomOut: () => {
    const { view, viewport } = get()
    set({ view: zoomAroundPure(view, 1 / ZOOM_STEP, { x: viewport.width / 2, y: viewport.height / 2 }) })
  },

  fitToWindow: () => {
    const view = computeFit(get())
    if (view !== null) set({ view })
  },

  autoFit: () => {
    const state = get()
    const view = computeFit(state)
    // 没有可适应的内容（数据还没到）时**不记账**：等数据到了再适应
    if (view === null) return
    const key = autoFitKey(state.rootPath, state.viewport)
    if (state.fitKey === key) return
    set({ fitKey: key, view })
  },

  moveCard: (relPath, x, y) => {
    const manual = new Map(get().manual)
    manual.set(relPath, { x: Math.round(x), y: Math.round(y) })
    set({ manual })
    schedulePositions(get().rootPath, manual)
  },

  resetManual: () => {
    set({ manual: new Map<string, Point>() })
    flushPositions(get().rootPath, new Map<string, Point>())
  },

  setMode: (mode) => {
    const current = get()
    if (current.mode === mode) return
    // 落盘时**带上其余偏好**（`prefsOf`）：只写 `{mode, depth}` 会把用户调好的张力、预设、
    // 两个开关从 localStorage 里抹掉 —— 内存里还在，但重启就回到默认值（真实踩过）
    saveJson(PREFS_KEY, prefsOf({ ...current, mode }))
    // 换视图 = 换一套布局，视角与选中都属于上一个上下文：清掉"已适应过"的记账，
    // 让新视图自己适应一次（否则从全库切到某篇笔记的关系图时，镜头可能停在空地上）。
    // 包围盒也要清：它属于上一个视图的几何，留着会让"适应窗口"对着一幅已经不存在的图算。
    set({ mode, fitKey: null, selected: null, egoBounds: null })
  },

  setDepth: (depth) => {
    const next = clampEgoDepth(depth)
    const current = get()
    if (current.depth === next) return
    saveJson(PREFS_KEY, prefsOf({ ...current, depth: next }))
    // 深度变了 = 环的半径全变了：保留平移缩放没有意义（用户是在"要看得更远"），
    // 因此清掉适应记账，由组件在新的布局上重新适应一次。
    // 至于"要重新拉数据"：`loadEgo` 会拿 `ego.depth` 跟当前 `depth` 比，因此它自己
    // 就知道这是一幅**新的图**（不进保留视角那条路），这里不必抢先改状态。
    set({ depth: next, fitKey: null })
  },

  fitToBounds: (bounds) => {
    const { viewport } = get()
    if (bounds.width <= 0 || bounds.height <= 0) return
    set({ view: fitView(bounds, { width: viewport.width, height: viewport.height }, FIT_PADDING) })
  },

  setEgoBounds: (bounds) => {
    const current = get().egoBounds
    // 尺寸没变就不写 state：这个 effect 会跟着布局走，写多余的状态只会让整棵画布重渲染
    if (current === bounds) return
    if (current !== null && bounds !== null && current.x === bounds.x && current.y === bounds.y && current.width === bounds.width && current.height === bounds.height) {
      return
    }
    set({ egoBounds: bounds })
  },

  pinCard: (relPath, center) => {
    if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) return
    const pins = new Map(get().pins)
    pins.set(relPath, { x: center.x, y: center.y })
    set({ pins })
  },

  unpinCards: (relPath) => {
    const current = get().pins
    if (current.size === 0) return
    if (relPath === undefined) {
      set({ pins: new Map<string, Point>() })
      return
    }
    if (!current.has(relPath)) return
    const pins = new Map(current)
    pins.delete(relPath)
    set({ pins })
  },

  autoFitBounds: (key, bounds) => {
    const state = get()
    if (state.fitKey === key) return
    if (bounds.width <= 0 || bounds.height <= 0) return
    set({
      fitKey: key,
      view: fitView(bounds, { width: state.viewport.width, height: state.viewport.height }, FIT_PADDING),
    })
  },
})
