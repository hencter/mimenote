/**
 * 知识图谱画布的状态 —— **组合壳与对外 API**（ADR-0060 §3(b)）。
 *
 * 一句话职责：把"数据装载 / 视图 / 卡片与浮窗"三个切片合成一个 zustand store，
 * 再导出原来的全部公开符号，并把三条需要**读整个 store** 的模块级函数留在这里
 * （`flushPositionPersist` / `refreshGraphData` / `startGraphAutoRefresh`）。
 *
 * 为什么壳必须存在：`useGraphStore` 的对外形状（字段名、动作名、`getState()` 的用法）
 * 是十几个消费点与 6 个测试文件的契约。拆分的价值在"内部边界清楚"，不在"让调用方改代码"。
 * 切片用 `get()` 交叉读，仍然是**一个** store —— 不拆成多个 store：那会把
 * "选中变化 → 松开按住 / 关浮窗"这类跨片不变量变成需要订阅两处的竞态。
 *
 * 三条加载与刷新的纪律都住在各自的切片里（`graph-data.ts`）：
 * 完整重载 vs 保留视角的刷新**不许合并**，文件头有原样的说明；
 * `state/graph-persist.ts` 只管落盘、不认识 store（否则 `store → persist → store` 成环）。
 */

import { create } from 'zustand'

import { createCardsSlice, type CardsSlice } from './graph-cards-store'
import { createDataSlice, type DataSlice } from './graph-data'
import { createViewSlice, type ViewSlice } from './graph-view-store'
import { flushPositions } from './graph-persist'
import { useLinksStore } from './links-store'
import { useNoteStore } from './note-store'
import { useUiStore } from './ui-store'

/** 合成后的 store 形状：三个切片的并集（字段名与拆分前逐字相同）。 */
export type GraphState = DataSlice & ViewSlice & CardsSlice

export const useGraphStore = create<GraphState>()((...args) => ({
  ...createDataSlice(...args),
  ...createViewSlice(...args),
  ...createCardsSlice(...args),
}))

/** 测试用：立刻把待写的手工位置落盘。 */
export function flushPositionPersist(): void {
  const state = useGraphStore.getState()
  flushPositions(state.rootPath, state.manual)
}

/**
 * 拉一次"保留视角的刷新"（`startGraphAutoRefresh` 的两条信号都走它，测试也直接用它）。
 *
 * **两种视图各刷各的**：全库视图刷 `graph_data`，自我中心视图刷它自己那张子图
 * （圆心 = 当前打开的笔记）。刷新图谱与"当前在看哪一种图"无关，用户不需要知道这件事。
 *
 * 拿不到 rootPath（还没打开过 Vault）时什么都不做：那说明画布根本没有数据，
 * 也就没有"刷新"可言。
 */
export async function refreshGraphData(): Promise<void> {
  const state = useGraphStore.getState()
  if (state.rootPath === null) return
  if (state.mode === 'focus') {
    const focus = useNoteStore.getState().doc?.relPath ?? null
    if (focus === null) return
    await state.loadEgo(focus, { keepView: true })
    return
  }
  await state.load(state.rootPath, {
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

// ---------------------------------------------------------------------------
// 再导出：对外形状与拆分前逐字相同（消费点与测试一行都不用改）
// ---------------------------------------------------------------------------

export { CARD_SIZE_KEY, POSITIONS_KEY, PREFS_KEY, clearStoredPositions } from './graph-persist'

export type { EgoSnapshot, GraphLoadOptions, GraphStatus } from './graph-data'

export type { GraphViewport } from './graph-view-store'
export { DEFAULT_VIEW, FALLBACK_VIEWPORT } from './graph-view-store'

export type { FloatingPane } from './graph-cards-store'
export {
  DEFAULT_FLOAT_HEIGHT,
  DEFAULT_FLOAT_WIDTH,
  MIN_FLOAT_HEIGHT,
  MIN_FLOAT_WIDTH,
} from './graph-cards-store'

export type { CardSize, ForceParamRange, GraphMode } from '@/domain/graph/prefs'
export {
  DEFAULT_EGO_DEPTH,
  DEFAULT_FORCE_PRESET,
  DEFAULT_TENSION,
  FORCE_HOP_OPTIONS,
  FORCE_PARAM_RANGES,
  FORCE_SLIDER_KEYS,
  MAX_CARD_HEIGHT,
  MAX_CARD_WIDTH,
  MAX_EGO_DEPTH,
  MAX_TENSION,
  MIN_CARD_HEIGHT,
  MIN_CARD_WIDTH,
  MIN_EGO_DEPTH,
  MIN_TENSION,
  clampCardHeight,
  clampCardSizeHeight,
  clampCardWidth,
  clampEgoDepth,
  clampForceParam,
  clampTension,
  formatForceParam,
} from '@/domain/graph/prefs'
