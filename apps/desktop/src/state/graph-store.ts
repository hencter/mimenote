/**
 * 知识图谱画布的状态：数据加载、选中卡片、视口（平移/缩放）、折叠的文件夹、手工位置。
 *
 * 分层同其它 store：
 * - **数据来自 IPC**（`graph_data`），前端不自己解析链接 —— 权威实现在 Rust 的链接索引里，
 *   前端只负责"怎么画"（见 `features/graph/layout.ts`）；
 * - **视图状态放这里而不是组件里**：折叠集合与手工位置要跨渲染保留，视口与缩放还必须能被
 *   **组件之外**的入口驱动（画布按钮、以及 `app/builtin-commands.ts` 里的 `graph.*` 命令 ——
 *   命令的 `run` 拿不到组件 state，所以"视口尺寸/适应窗口/缩放步进"必须落在这一层）；
 * - **持久化只写 localStorage**（`mimenote.graph.positions.v1`），不往 Vault 目录里写任何东西
 *   —— 保持"用户的笔记文件夹是干净的纯 Markdown"。
 *
 * ## 两条加载路径：完整重载 vs 保留视角的刷新
 *
 * `load()` 默认是**完整重载**（"从头再来"）：换 Vault、用户点"重新读取图谱"时，视角、
 * 折叠、选中都属于**另一个上下文**，留着只会画出错的图。但"数据变新了"是另一回事 ——
 * 编辑完一篇笔记、自动保存成功、索引重建完成，这些都不该动用户的镜头：他好不容易把镜头
 * 对准某片区域，一次后台刷新就把他甩回"适应窗口"，下一次他就不敢相信这幅画布了。
 *
 * 把两件事合并成一个函数必然二选一（要么刷新时镜头乱跳，要么换 Vault 时残留脏状态），
 * 所以显式分成 `keepView: true` 与完整重载两条路。保留视角的刷新还必须**不闪白**：
 * 它不进 `loading` 状态（画布继续用旧数据渲染），只在 HUD 上给一个轻量指示；
 * 宿主返回空数据时同样保留旧数据并给提示（见 `load` 的实现）。
 */

import { create } from 'zustand'

import {
  FIT_PADDING,
  ZOOM_STEP,
  buildLayout,
  clampZoom,
  fitView,
  panBy as panByPure,
  pruneManualPositions,
  zoomAround as zoomAroundPure,
  type GraphView,
  type Point,
  type Size,
} from '@/features/graph/layout'
import { ipc } from '@/ipc/client'
import { MimenoteError, describeError } from '@/ipc/types'
import type { GraphData } from '@/ipc/types'
import { useLinksStore } from './links-store'
import { useNoteStore } from './note-store'
import { loadJson, saveJson } from './persist'
import { useUiStore } from './ui-store'

/** 手工位置的存储键：`{ [Vault 根]: { [relPath]: {x, y} } }`。 */
export const POSITIONS_KEY = 'mimenote.graph.positions.v1'

/** 拖动时每次 pointermove 都写 localStorage 是浪费（一次 JSON.stringify 可能是几千项），
 *  因此合并成一次延迟写入；窗口关闭前的最后一次拖动仍在 400ms 内落盘。 */
const PERSIST_DEBOUNCE_MS = 400

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

/** 宿主返回空数据时给用户看的提示（保留视角的刷新专用）。 */
const EMPTY_NOTICE = '图谱这次没有返回任何节点（索引可能正在重建），当前显示的是上一次的结果'

/** 保留视角的刷新失败时的提示后缀。 */
const STALE_SUFFIX = '（当前显示的是上一次的结果）'

export type GraphStatus = 'idle' | 'loading' | 'ready' | 'error'

type StoredPositions = Record<string, Record<string, Point>>

/** 画布视口的像素尺寸。 */
export interface GraphViewport {
  width: number
  height: number
  /** 是否已经拿到**真实**尺寸（首帧/无布局环境里只有兜底值，之后会自动再适应一次）。 */
  known: boolean
}

export interface GraphLoadOptions {
  /** 数据是在索引构建期间拿的 ⇒ 索引就绪后要自动补一次。 */
  indexBuilding?: boolean
  /**
   * 保留视角的刷新：只更新 `nodes` / `edges`，保留缩放、偏移、选中、手工位置与折叠集合
   * （指向已消失笔记的手工位置与选中会被清掉）。
   *
   * 由调用方声明意图，但**换 Vault 时会被强制降级为完整重载**（见 `load`）——
   * 那种情况下"保留视角"没有意义，而且很容易写错。
   */
  keepView?: boolean
}

function isStoredPositions(value: unknown): value is StoredPositions {
  return typeof value === 'object' && value !== null
}

function readStoredPositions(): StoredPositions {
  return loadJson<StoredPositions>(POSITIONS_KEY, {}, isStoredPositions)
}

function toMap(record: Record<string, Point> | undefined): Map<string, Point> {
  const map = new Map<string, Point>()
  if (record === undefined) return map
  for (const [relPath, point] of Object.entries(record)) {
    if (point !== null && typeof point === 'object' && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      map.set(relPath, { x: point.x, y: point.y })
    }
  }
  return map
}

function toRecord(map: ReadonlyMap<string, Point>): Record<string, Point> {
  const record: Record<string, Point> = {}
  for (const [relPath, point] of map) record[relPath] = point
  return record
}

let persistTimer: ReturnType<typeof setTimeout> | null = null

function flushPositions(rootPath: string | null, manual: ReadonlyMap<string, Point>): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  if (rootPath === null) return
  const stored = readStoredPositions()
  saveJson(POSITIONS_KEY, { ...stored, [rootPath]: toRecord(manual) })
}

/** 测试用：立刻把待写的手工位置落盘。 */
export function flushPositionPersist(): void {
  const state = useGraphStore.getState()
  flushPositions(state.rootPath, state.manual)
}

function schedulePositions(rootPath: string | null, manual: ReadonlyMap<string, Point>): void {
  if (persistTimer !== null) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    flushPositions(rootPath, manual)
  }, PERSIST_DEBOUNCE_MS)
}

interface GraphState {
  status: GraphStatus
  /** 节点与边；`null` 表示还没加载成功过。 */
  data: GraphData | null
  error: MimenoteError | null
  /** 当前数据属于哪个 Vault（换 Vault 即作废）。 */
  rootPath: string | null
  /** 选中的卡片 = 画布上正在预览的那一篇；`null` = 没有预览。 */
  selected: string | null
  view: GraphView
  /** 收起的文件夹（POSIX 目录路径）。**默认空集 = 全部展开**（用户说"不需要人为处理"）。 */
  collapsed: ReadonlySet<string>
  /** 用户手工拖动过的卡片位置（覆盖自动布局，按 `Vault 根 + relPath` 持久化）。 */
  manual: ReadonlyMap<string, Point>
  /** 加载时索引还在构建 ⇒ 索引就绪后自动补一次（不需要用户手动刷新）。 */
  staleIndex: boolean
  loadedAtMs: number
  /** 画布视口尺寸（由画布组件上报）：命令表里的缩放/适应窗口要按它算锚点。 */
  viewport: GraphViewport
  /** 正在做"保留视角的刷新"：HUD 上的轻量指示，画布照常渲染旧数据（**不闪白**）。 */
  refreshing: boolean
  /** 上一次刷新留下的提示（空数据 / 刷新失败）；`null` = 一切正常。 */
  refreshNotice: string | null
  /** 已经自动"适应窗口"过的键（`Vault 根 + 尺寸是否已知`）。 */
  fitKey: string | null

  load: (rootPath: string | null, options?: GraphLoadOptions) => Promise<void>
  clear: () => void

  select: (relPath: string | null) => void
  /** 关闭预览面板（`Esc` 命令走这里）。 */
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

/** 加载请求序号：连续切换 Vault / 手动刷新时只采纳最后一次。 */
let loadSeq = 0

/** 当前视口下的"适应窗口"结果；没有可适应内容时返回 `null`。 */
function computeFit(state: {
  data: GraphData | null
  collapsed: ReadonlySet<string>
  viewport: GraphViewport
}): GraphView | null {
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

export const useGraphStore = create<GraphState>((set, get) => ({
  status: 'idle',
  data: null,
  error: null,
  rootPath: null,
  selected: null,
  view: DEFAULT_VIEW,
  collapsed: new Set<string>(),
  manual: new Map<string, Point>(),
  staleIndex: false,
  loadedAtMs: 0,
  viewport: { ...FALLBACK_VIEWPORT, known: false },
  refreshing: false,
  refreshNotice: null,
  fitKey: null,

  load: async (rootPath, options = {}) => {
    if (rootPath === null) {
      get().clear()
      return
    }
    const previous = get()
    // 只有"同一个 Vault 且已经有数据"才谈得上保留视角：换 Vault 时旧的视角/折叠/手工位置
    // 都属于上一个 Vault，必须完整重载（哪怕调用方传了 keepView，也不该按它的意图走）。
    const keepView =
      options.keepView === true && previous.rootPath === rootPath && previous.data !== null

    const seq = ++loadSeq
    if (keepView) {
      // 保留视角的刷新**不进 `loading` 状态**：画布必须继续用旧数据渲染（否则会先闪一片白），
      // "正在刷新"只体现在 HUD 的轻量指示上。
      set({ refreshing: true })
    } else {
      // 完整重载顺手把"刷新中"按下去：可能有一次保留视角的刷新正在途中被这次完整重载取代
      // （序号一变它的响应就被丢弃），不按下去 HUD 上的指示会一直亮着。
      set({ status: 'loading', error: null, rootPath, refreshing: false })
    }

    try {
      const data = await ipc.graphData()
      if (seq !== loadSeq) return // 过期响应：丢弃
      const state = get()
      const empty = data.nodes.length === 0 && data.edges.length === 0

      if (keepView && empty) {
        // 宿主返回空 = 索引正在重建（或还没建好）。此时**保留旧数据**：把画布清空会让用户
        // 以为"笔记都没了"，而且重建完成后还得靠他自己再点一次刷新。
        // 只有在"保留视角的刷新"里才这样做 —— 显式的"重新读取"（keepView 为 false）照旧采纳
        // 空结果，那既是用户明确要求的"从头再来"，也是真正变空的 Vault 唯一能被画出来的路径。
        set({
          refreshing: false,
          refreshNotice: EMPTY_NOTICE,
          // 标记"数据可能是旧的"：索引一就绪就会自动再补一次（画布的索引订阅看这个标志）
          staleIndex: true,
        })
        return
      }

      // 手工位置：只清掉"确实已经从 Vault 里消失"的笔记。
      // `truncated` 时**不能**按"不在列表里"判定消失：宿主只返回了度数最高的一部分，
      // 没返回的笔记并不是被删了，清掉就等于把用户手工摆好的布局悄悄丢了。
      let manual: ReadonlyMap<string, Point>
      if (keepView) {
        // 保留视角的刷新**不重新读 localStorage**：内存里的手工位置可能还有一次防抖没落盘，
        // 重读会把用户刚拖过的位置吃掉（这也是"刷新"与"重新加载"的区别之一）。
        manual = data.truncated ? state.manual : pruneManualPositions(state.manual, data.nodes)
        // 真的清掉了东西就顺手落盘，别让已删除笔记的位置一直躺在 localStorage 里
        if (manual.size !== state.manual.size) flushPositions(rootPath, manual)
      } else {
        const stored = toMap(readStoredPositions()[rootPath])
        manual = data.truncated ? stored : pruneManualPositions(stored, data.nodes)
      }

      // 选中的卡片若已经不在数据里（笔记被删/改名），预览必须关掉 —— 否则面板会挂着一条
      // 指向不存在文件的路径。`truncated` 时同样不能判定"消失"（理由同手工位置）。
      const alive = data.truncated ? null : new Set(data.nodes.map((node) => node.relPath))
      const selected =
        state.selected !== null && alive !== null && !alive.has(state.selected)
          ? null
          : state.selected

      set({
        status: 'ready',
        data,
        error: null,
        rootPath,
        loadedAtMs: Date.now(),
        staleIndex: options.indexBuilding === true,
        refreshing: false,
        refreshNotice: null,
        manual,
        ...(keepView
          ? { selected }
          : {
              // 完整重载 = 真正的"从头再来"：视角回到适应窗口（`fitKey` 一并清空，
              // 画布据此重新适应一次），折叠与选中清空 —— 旧路径在新的数据里没有意义
              selected: null,
              collapsed: new Set<string>(),
              view: DEFAULT_VIEW,
              fitKey: null,
            }),
      })
    } catch (cause) {
      if (seq !== loadSeq) return
      if (keepView) {
        // 保留视角的刷新失败：**不能把 data 清空**（画布会瞬间变成白板并弹出全屏错误层），
        // 只记一条提示，让用户知道"看到的是上一次的结果"。
        set({
          refreshing: false,
          refreshNotice: `${describeError(MimenoteError.from(cause), '刷新图谱失败')}${STALE_SUFFIX}`,
        })
        return
      }
      set({ status: 'error', error: MimenoteError.from(cause), data: null })
    }
  },

  clear: () => {
    loadSeq += 1
    flushPositions(get().rootPath, get().manual)
    set({
      status: 'idle',
      data: null,
      error: null,
      rootPath: null,
      selected: null,
      collapsed: new Set<string>(),
      manual: new Map<string, Point>(),
      staleIndex: false,
      view: DEFAULT_VIEW,
      refreshing: false,
      refreshNotice: null,
      fitKey: null,
    })
  },

  select: (selected) => set({ selected }),

  closePreview: () => set({ selected: null }),

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
}))

/**
 * 拉一次"保留视角的刷新"（`startGraphAutoRefresh` 的两条信号都走它，测试也直接用它）。
 *
 * 拿不到 rootPath（还没打开过 Vault）时什么都不做：那说明画布根本没有数据，
 * 也就没有"刷新"可言。
 */
export async function refreshGraphData(): Promise<void> {
  const rootPath = useGraphStore.getState().rootPath
  if (rootPath === null) return
  await useGraphStore.getState().load(rootPath, {
    keepView: true,
    indexBuilding: useLinksStore.getState().status.phase === 'building',
  })
}

/**
 * 订阅"该刷新图谱了"的信号，返回取消函数（**调用方必须在卸载时调用它**）。
 *
 * 三条触发线，覆盖"数据变了"的全部来源：
 * 1. **切到图谱视图**：`App` 只在 `viewMode === 'graph'` 时渲染画布，"切过去"就等于
 *    "画布挂载"，因此这件事由画布的**挂载刷新**表达（见 `GraphCanvas`）。
 *    刻意不再单独订阅 `ui-store.viewMode`：画布一旦卸载，那条监听就再也等不到"变回图谱"
 *    的那一刻（重新挂载会新建一个监听，而挂载刷新本身已经干了这件事），写出来只是死代码。
 * 2. **保存成功后**（`note-store.saveCount` 变化）：自动保存会改索引。用户此刻正盯着画布
 *    （典型的"敲完字立刻 Ctrl+G"，防抖中的那次保存在切过来之后才落盘），所以必须跟上。
 *    只在画布可见时发请求 —— 否则每次自动保存都白跑一次 IPC，而切回图谱时的挂载刷新
 *    本来就会拉到最新数据。
 * 3. **索引就绪**（`links-store` 的 `phase` 变成 `ready`）：数据是在索引构建期间拿的
 *    （`staleIndex`）时，图谱可能残缺，索引一就绪就自动补一次，不需要用户手动刷新。
 *
 * 为什么不做成模块级监听：模块级监听一旦注册就永不清理（热更新、测试里会越挂越多），
 * 也拿不到"当前是否还有画布在显示"这个上下文。交给画布在挂载时安装、卸载时取消 ——
 * 监听的生命周期跟着界面走，卸载后一次多余的 IPC 都不会发。
 */
export function startGraphAutoRefresh(): () => void {
  const unsubscribeNote = useNoteStore.subscribe((state, previous) => {
    if (state.saveCount === previous.saveCount) return
    if (useUiStore.getState().viewMode !== 'graph') return
    void refreshGraphData()
  })
  const unsubscribeIndex = useLinksStore.subscribe((state, previous) => {
    if (state.status.phase === previous.status.phase) return
    if (state.status.phase !== 'ready') return
    if (useUiStore.getState().viewMode !== 'graph') return
    // 数据不是"构建期间拿的"就没必要再拉一次（`load` 会自己维护这个标志）
    if (!useGraphStore.getState().staleIndex) return
    void refreshGraphData()
  })
  return () => {
    unsubscribeNote()
    unsubscribeIndex()
  }
}

/** 测试与"换 Vault"时用：清掉所有持久化的手工位置。 */
export function clearStoredPositions(): void {
  saveJson(POSITIONS_KEY, {})
}
