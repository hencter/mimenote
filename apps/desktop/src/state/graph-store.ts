/**
 * 知识图谱画布的状态：数据加载、选中卡片、视口（平移/缩放）、折叠的文件夹、手工位置。
 *
 * 分层同其它 store：
 * - **数据来自 IPC**（`graph_data`），前端不自己解析链接 —— 权威实现在 Rust 的链接索引里，
 *   前端只负责"怎么画"（见 `features/graph/layout.ts`）；
 * - **视图状态放这里而不是组件里**：折叠集合与手工位置要跨渲染保留，视口还要能被
 *   键盘/按钮（适应窗口、缩放按钮）从组件之外驱动；
 * - **持久化只写 localStorage**（`mimenote.graph.positions.v1`），不往 Vault 目录里写任何东西
 *   —— 保持"用户的笔记文件夹是干净的纯 Markdown"。
 */

import { create } from 'zustand'

import {
  clampZoom,
  panBy as panByPure,
  pruneManualPositions,
  zoomAround as zoomAroundPure,
  type GraphView,
  type Point,
} from '@/features/graph/layout'
import { ipc } from '@/ipc/client'
import { MimenoteError } from '@/ipc/types'
import type { GraphData } from '@/ipc/types'
import { loadJson, saveJson } from './persist'

/** 手工位置的存储键：`{ [Vault 根]: { [relPath]: {x, y} } }`。 */
export const POSITIONS_KEY = 'mimenote.graph.positions.v1'

/** 拖动时每次 pointermove 都写 localStorage 是浪费（一次 JSON.stringify 可能是几千项），
 *  因此合并成一次延迟写入；窗口关闭前的最后一次拖动仍在 400ms 内落盘。 */
const PERSIST_DEBOUNCE_MS = 400

export const DEFAULT_VIEW: GraphView = { x: 0, y: 0, zoom: 1 }

export type GraphStatus = 'idle' | 'loading' | 'ready' | 'error'

type StoredPositions = Record<string, Record<string, Point>>

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

  load: (rootPath: string | null, options?: { indexBuilding?: boolean }) => Promise<void>
  clear: () => void

  select: (relPath: string | null) => void

  toggleFolder: (path: string) => void
  setCollapsed: (paths: readonly string[]) => void

  setView: (view: GraphView) => void
  panBy: (dx: number, dy: number) => void
  /** 以 `focal`（**屏幕坐标**）为锚点缩放；按钮缩放传视口中心。 */
  zoomAt: (factor: number, focal: Point) => void

  moveCard: (relPath: string, x: number, y: number) => void
  resetManual: () => void
}

/** 加载请求序号：连续切换 Vault / 手动刷新时只采纳最后一次。 */
let loadSeq = 0

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

  load: async (rootPath, options = {}) => {
    if (rootPath === null) {
      get().clear()
      return
    }
    const seq = ++loadSeq
    set({ status: 'loading', error: null, rootPath })
    try {
      const data = await ipc.graphData()
      if (seq !== loadSeq) return // 过期响应：丢弃
      const stored = toMap(readStoredPositions()[rootPath])
      // 只清掉"确实已经从 Vault 里消失"的笔记的位置。
      // `truncated` 时**不能**清：宿主只返回了度数最高的一部分，没返回的笔记并不是被删了，
      // 清掉就等于把用户手工摆好的布局悄悄丢了。
      const manual = data.truncated ? stored : pruneManualPositions(stored, data.nodes)
      set({
        status: 'ready',
        data,
        error: null,
        rootPath,
        loadedAtMs: Date.now(),
        staleIndex: options.indexBuilding === true,
        // 换 Vault 时清掉选中与折叠状态（旧路径在新 Vault 里没有意义）
        selected: null,
        collapsed: new Set<string>(),
        manual,
        view: DEFAULT_VIEW,
      })
    } catch (cause) {
      if (seq !== loadSeq) return
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
    })
  },

  select: (selected) => set({ selected }),

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

/** 测试与"换 Vault"时用：清掉所有持久化的手工位置。 */
export function clearStoredPositions(): void {
  saveJson(POSITIONS_KEY, {})
}
