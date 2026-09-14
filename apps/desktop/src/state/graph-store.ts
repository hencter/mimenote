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
  type Rect,
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

/**
 * 视图偏好的存储键（模式与跳数）。
 *
 * 为什么**不按 Vault 分**：它们是"我怎么看图"的偏好，不是"这个 Vault 长什么样"的数据。
 * 换一个 Vault 还要重新选一遍自我中心视图，只会让人以为这个开关坏了。
 */
export const PREFS_KEY = 'mimenote.graph.prefs.v1'

/** 图谱的两种视图（ADR-0021）。 */
export type GraphMode = 'focus' | 'vault'

/** 自我中心视图的跳数范围：与宿主（`mn_index::graph`）的 `depth.clamp(1, 5)` 逐字一致。 */
export const MIN_EGO_DEPTH = 1
export const MAX_EGO_DEPTH = 5

/**
 * 进入自我中心视图的默认跳数：**1 跳**。
 *
 * 用户的诉求是"进入后只有先关联的" —— 那就先给直接相关的那一圈（1 跳），
 * 想看更远的自己往上加。默认给 2 或 3 会在几十个邻居的笔记上立刻变成一屏乱线，
 * 而那正是这次要修掉的东西。
 */
export const DEFAULT_EGO_DEPTH = 1

/**
 * 一次 `notes_read_batch` 要几篇正文。
 *
 * 宿主逐篇读文件（本地磁盘），40 篇一批在 SSD 上是几毫秒级；批太大只会让"第一张卡片出现"
 * 的时间变长（我们要等这一批回来才排版），批太小则多几轮 IPC 往返。
 */
const TEXT_BATCH_SIZE = 40

/** 连线张力的范围：0 = 直线，1 = 最绷（控制点偏移弦长的 1/4）。 */
export const MIN_TENSION = 0
export const MAX_TENSION = 1

/**
 * 默认张力：**0.35**。
 *
 * 依据：0 时线是直的，"张力"这个旋钮看不出效果；1 时曲线会绕过卡片、也容易与其它线交叉。
 * 0.35 在 1200×800 的视口、一跳邻居围一圈的情况下曲线微微外扩，既不压住卡片也不像乱麻。
 */
export const DEFAULT_TENSION = 0.35

/** 默认力导向预设（见 `features/graph/force-presets.ts`）。 */
export const DEFAULT_FORCE_PRESET = 'balanced'

// ---------------------------------------------------------------------------
// 卡片尺寸（可调大小）
// ---------------------------------------------------------------------------

/** 卡片宽度的范围：比手机窄就没法读，比一屏还宽就不像卡片了。 */
export const MIN_CARD_WIDTH = 220
export const MAX_CARD_WIDTH = 900

/**
 * 卡片**正文高度上限**的范围。
 *
 * 为什么是"上限"而不是固定高度：卡片正面是笔记正文，高度本来就由内容决定；
 * 用户调小它是"这一篇太长，我只要看开头"，调大它是"这一篇我想多看点"。
 * 固定高度反而会把短笔记撑成一堆空白。
 */
export const MIN_CARD_HEIGHT = 120
export const MAX_CARD_HEIGHT = 2400

/** 卡片的手工尺寸（按 Vault + relPath 持久化；没调过的字段是 `null` = 用默认）。 */
export interface CardSize {
  /** 卡片宽度；`null` = 默认宽度（焦点视图 320）。 */
  width: number | null
  /** 正文高度上限；`null` = 用默认上限。 */
  height: number | null
}

export const CARD_SIZE_KEY = 'mimenote.graph.sizes.v1'

/** 卡片尺寸的归一化（越界与非法值都夹回范围内）。 */
export function clampCardWidth(width: number): number {
  if (!Number.isFinite(width)) return MAX_CARD_WIDTH
  return Math.min(MAX_CARD_WIDTH, Math.max(MIN_CARD_WIDTH, Math.round(width)))
}

/** 高度上限可以显式"自动"（`null`），所以这里接受 `null` 原样返回。 */
export function clampCardSizeHeight(height: number | null): number | null {
  return height === null ? null : clampCardHeight(height)
}

export function clampCardHeight(height: number): number {
  if (!Number.isFinite(height)) return MIN_CARD_HEIGHT
  return Math.min(MAX_CARD_HEIGHT, Math.max(MIN_CARD_HEIGHT, Math.round(height)))
}

// ---------------------------------------------------------------------------
// 浮动笔记面板（ADR-0023）
// ---------------------------------------------------------------------------

/**
 * 一个浮动面板的位置与大小（屏幕像素，相对画布宿主）。
 *
 * 为什么不持久化：浮窗是**临时**的阅读姿势（Obsidian 的 hover editor 同样不跨会话保留）——
 * 下次打开应用还挂着一堆不知道从哪来的浮窗，比"什么都没有"更让人困惑。
 * 卡片尺寸则相反：那是"我怎么看这一篇"的偏好，要留住。
 */
export interface FloatingPane {
  relPath: string
  x: number
  y: number
  width: number
  height: number
  /** 层级：点一下置顶（数值越大越靠上）。 */
  z: number
}

/**
 * 浮动面板的最小/默认尺寸。
 *
 * ⚠️ 最小值必须与 `features/graph/FloatingNote.tsx` 导出的那两个常量**一致**：
 * 面板自己拖动时会按它的常量夹一次，store 在写入时再夹一次，两处数值不同就会出现
 * "拖到某个尺寸又被弹回来"这种说不清的抖动。这里取同一组数（220/140）。
 */
export const MIN_FLOAT_WIDTH = 220
export const MIN_FLOAT_HEIGHT = 140
export const DEFAULT_FLOAT_WIDTH = 420
export const DEFAULT_FLOAT_HEIGHT = 520

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

/** 自我中心视图的三样东西：根、跳数、数据（前两者换掉即作废）。 */
export interface EgoSnapshot {
  /** 圆心那一篇（Vault 相对路径）。 */
  root: string
  /** 算这份数据时用的跳数：它也是"能不能保留视角"的判据之一。 */
  depth: number
  data: GraphData
}

type StoredPositions = Record<string, Record<string, Point>>

interface StoredPrefs {
  mode: GraphMode
  depth: number
  /** 连线的张力（0..1，ADR-0023）。缺省按默认值补（老用户的偏好里没有这一项）。 */
  tension?: number
  /** 连接线是否从正文里的 wiki link 文字处引出（ADR-0023）。 */
  edgeFromLink?: boolean
  /** 力导向浮动态的预设 id（ADR-0023）。 */
  forcePreset?: string
  /** 是否让节点持续漂浮（false = 打开时落定后就静止）。 */
  floating?: boolean
}

function isStoredPrefs(value: unknown): value is StoredPrefs {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { mode?: unknown; depth?: unknown }
  return (
    (record.mode === 'focus' || record.mode === 'vault') && typeof record.depth === 'number'
  )
}

function readPrefs(): StoredPrefs {
  const stored = loadJson<StoredPrefs>(
    PREFS_KEY,
    { mode: 'focus', depth: DEFAULT_EGO_DEPTH },
    isStoredPrefs,
  )
  return {
    mode: stored.mode,
    depth: clampEgoDepth(stored.depth),
    tension: clampTension(stored.tension ?? DEFAULT_TENSION),
    // 缺省开：这条是用户明确要的（"虚线从对应的 wiki link 处引出"），不是可选装饰
    edgeFromLink: stored.edgeFromLink !== false,
    floating: stored.floating !== false,
    forcePreset: stored.forcePreset ?? DEFAULT_FORCE_PRESET,
  }
}

/** 跳数归一化：非法值一律回到范围内（宿主也会再夹一次，前端不做"等宿主纠正"的假设）。 */
export function clampEgoDepth(depth: number): number {
  if (!Number.isFinite(depth)) return DEFAULT_EGO_DEPTH
  return Math.min(MAX_EGO_DEPTH, Math.max(MIN_EGO_DEPTH, Math.round(depth)))
}

/** 张力归一化（0 = 直线，1 = 最绷）。 */
export function clampTension(tension: number): number {
  if (!Number.isFinite(tension)) return DEFAULT_TENSION
  return Math.min(MAX_TENSION, Math.max(MIN_TENSION, tension))
}

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

  // ---------------------------------------------------------------------------
  // 自我中心视图（ADR-0021）
  // ---------------------------------------------------------------------------

  /** 当前是哪一种视图：`focus` = 以当前笔记为圆心的子图，`vault` = 整个 Vault。 */
  mode: GraphMode
  /** 自我中心视图的跳数（1..5，双向）。 */
  depth: number
  /** 自我中心子图（`null` = 还没拿到过；`status` 说明当前在干什么）。 */
  ego: EgoSnapshot | null
  egoStatus: GraphStatus
  egoError: MimenoteError | null
  /**
   * 圆心那一篇的正文（节点卡片画的是**完整 Markdown 预览**，不是摘要行）。
   *
   * 键是 Vault 相对路径。每次重载子图时**整体替换**：一篇笔记保存后，正文变了，
   * 旧的那份必须一起失效 —— 增量合并会让画布上留着上一次保存前的内容。
   */
  texts: ReadonlyMap<string, string>

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

  // ---------------------------------------------------------------------------
  // 可调大小的卡片（ADR-0023）
  // ---------------------------------------------------------------------------

  /** 用户手工调过的卡片尺寸（按 Vault + relPath 持久化）。 */
  cardSizes: ReadonlyMap<string, CardSize>
  /** 调宽度（同时把高度上限放开到新宽度下自然需要的高度，见实现里的说明）。 */
  setCardWidth: (relPath: string, width: number) => void
  /** 调正文高度上限。 */
  setCardHeight: (relPath: string, height: number) => void
  /** 恢复一张卡片（或全部）的自动尺寸。 */
  resetCardSize: (relPath?: string) => void

  // ---------------------------------------------------------------------------
  // 连线张力与浮动态（ADR-0023）
  // ---------------------------------------------------------------------------

  /** 连线张力（0..1）：控制点沿垂直方向偏移弦长的多少。 */
  tension: number
  setTension: (tension: number) => void
  /** 连接线是否从正文里的 wiki link 文字处引出（关掉 = 全部从卡片边界出发）。 */
  edgeFromLink: boolean
  setEdgeFromLink: (on: boolean) => void
  /** 力导向的预设 id（见 `features/graph/force-presets.ts`）。 */
  forcePreset: string
  setForcePreset: (id: string) => void
  /** 是否让节点持续漂浮（false = 落定后静止，省电）。 */
  floating: boolean
  setFloating: (on: boolean) => void

  // ---------------------------------------------------------------------------
  // 浮动笔记面板（ADR-0023）
  // ---------------------------------------------------------------------------

  /** 当前打开的浮动面板（可多个；`z` 大的在上面）。 */
  floatingPanes: readonly FloatingPane[]  /** 打开（或置顶）一篇笔记的浮动面板。 */
  openFloating: (relPath: string) => void
  closeFloating: (relPath: string) => void
  closeAllFloating: () => void
  moveFloating: (relPath: string, rect: { x: number; y: number; width: number; height: number }) => void
  raiseFloating: (relPath: string) => void

  // ---------------------------------------------------------------------------
  // 被"按住"的卡片（ADR-0023）
  // ---------------------------------------------------------------------------

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
  /** 拉一次自我中心子图（`relPath` 为 `null` = 没有打开的笔记，清空）。 */
  loadEgo: (relPath: string | null, options?: { keepView?: boolean }) => Promise<void>
  /** 把自我中心布局的包围盒交给 store 做"适应窗口"（尺寸只有组件量得出来）。 */
  fitToBounds: (bounds: Rect) => void
  /** 首次拿到某个 (圆心, 跳数) 的布局时自动适应一次；同一个键只做一次（跨挂载记账）。 */
  autoFitBounds: (key: string, bounds: Rect) => void

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

/** 自我中心子图的请求序号（与全库那份**各算各的**：两种视图可以同时在途）。 */
let egoSeq = 0

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

// ---------------------------------------------------------------------------
// 偏好与卡片尺寸的落盘
// ---------------------------------------------------------------------------

interface PrefsSource {
  mode: GraphMode
  depth: number
  tension: number
  edgeFromLink: boolean
  floating: boolean
  forcePreset: string
}

/** 把当前状态收成一份可落盘的偏好（四个 setter 共用，避免各自漏写一个字段）。 */
function prefsOf(source: PrefsSource): StoredPrefs {
  return {
    mode: source.mode,
    depth: source.depth,
    tension: source.tension,
    edgeFromLink: source.edgeFromLink,
    floating: source.floating,
    forcePreset: source.forcePreset,
  }
}

/** 浮动面板的层级：只增不减（`z` 只用来排序，数值本身没有意义）。 */
function topZ(panes: readonly FloatingPane[]): number {
  return panes.reduce((max, pane) => Math.max(max, pane.z), 0)
}

type StoredCardSizes = Record<
  string,
  Record<string, { width: number | null; height: number | null }>
>

function readStoredCardSizes(): StoredCardSizes {
  return loadJson<StoredCardSizes>(CARD_SIZE_KEY, {}, (value): value is StoredCardSizes => {
    return typeof value === 'object' && value !== null
  })
}

function toStoredSizes(sizes: ReadonlyMap<string, CardSize>): Record<string, CardSize> {
  const record: Record<string, CardSize> = {}
  for (const [relPath, size] of sizes) record[relPath] = size
  return record
}

/** 落盘卡片尺寸（按 Vault 分：这是"这个 Vault 长什么样"的一部分）。 */
function persistCardSizes(rootPath: string | null, sizes: ReadonlyMap<string, CardSize>): void {
  const stored = readStoredCardSizes()
  if (rootPath === null) return
  saveJson(CARD_SIZE_KEY, { ...stored, [rootPath]: toStoredSizes(sizes) })
}

/**
 * 换 Vault 时把该 Vault 的卡片尺寸读回来。
 *
 * 与手工位置（`positions`）不同，尺寸是**布局的输入**：不读回来的话，用户为一个长笔记
 * 调好的宽度每次打开都要重调，而"卡片多大"恰恰是这一轮新增的东西。
 */
function loadCardSizes(rootPath: string | null): Map<string, CardSize> {
  const map = new Map<string, CardSize>()
  if (rootPath === null) return map
  const record = readStoredCardSizes()[rootPath]
  if (record === undefined) return map
  for (const [relPath, size] of Object.entries(record)) {
    if (size === null || typeof size !== 'object') continue
    const width = size.width
    if (width !== null && !Number.isFinite(width)) continue
    map.set(relPath, {
      width: width === null ? null : clampCardWidth(width),
      height: clampCardSizeHeight(size.height === undefined ? null : size.height),
    })
  }
  return map
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
  mode: readPrefs().mode,
  depth: readPrefs().depth,
  ego: null,
  egoStatus: 'idle',
  egoError: null,
  texts: new Map<string, string>(),
  egoBounds: null,
  cardSizes: new Map<string, CardSize>(),
  tension: readPrefs().tension ?? DEFAULT_TENSION,
  edgeFromLink: readPrefs().edgeFromLink !== false,
  forcePreset: readPrefs().forcePreset ?? DEFAULT_FORCE_PRESET,
  floating: readPrefs().floating !== false,
  floatingPanes: [],
  pins: new Map<string, Point>(),

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
      // 卡片尺寸、浮动面板、力导向都跟着 Vault 一起作废（它们都是"这个 Vault 的视图状态"）
      cardSizes: new Map<string, CardSize>(),
      floatingPanes: [],
      ego: null,
      egoStatus: 'idle',
      egoError: null,
      texts: new Map<string, string>(),
      egoBounds: null,
    })
  },

  select: (selected) => set({ selected }),

  /**
   * `Esc`（`graph.closePreview` 命令）走这里。
   *
   * **先关最上面的浮窗，没有浮窗才关停靠预览**：`Esc` 在用户心里的意思是"关掉最上面那层"，
   * 而浮窗是后出现的、盖在停靠面板之上的东西。反过来的话，用户按 `Esc` 会发现
   * "浮窗还在，右下角那个面板却没了"。
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
    saveJson(PREFS_KEY, { mode, depth: current.depth } satisfies StoredPrefs)
    // 换视图 = 换一套布局，视角与选中都属于上一个上下文：清掉"已适应过"的记账，
    // 让新视图自己适应一次（否则从全库切到某篇笔记的关系图时，镜头可能停在空地上）。
    // 包围盒也要清：它属于上一个视图的几何，留着会让"适应窗口"对着一幅已经不存在的图算。
    set({ mode, fitKey: null, selected: null, egoBounds: null })
  },

  setDepth: (depth) => {
    const next = clampEgoDepth(depth)
    const current = get()
    if (current.depth === next) return
    saveJson(PREFS_KEY, { mode: current.mode, depth: next } satisfies StoredPrefs)
    // 深度变了 = 环的半径全变了：保留平移缩放没有意义（用户是在"要看得更远"），
    // 因此清掉适应记账，由组件在新的布局上重新适应一次。
    // 至于"要重新拉数据"：`loadEgo` 会拿 `ego.depth` 跟当前 `depth` 比，因此它自己
    // 就知道这是一幅**新的图**（不进保留视角那条路），这里不必抢先改状态。
    set({ depth: next, fitKey: null })
  },

  loadEgo: async (relPath, options = {}) => {
    if (relPath === null) {
      egoSeq += 1
      set({ ego: null, egoStatus: 'idle', egoError: null, texts: new Map<string, string>() })
      return
    }

    const seq = ++egoSeq
    const depth = get().depth
    const previous = get().ego
    // 保留视角的刷新（保存成功 / 索引就绪）不进 `loading`：画布继续用旧数据渲染（不闪白）。
    // **换圆心或改跳数则相反** —— 那是一幅新的图，留着旧的只会让人以为按钮没反应；
    // 判据放在这里而不是调用方：只有 store 同时知道"旧的这份数据是谁的、用的几跳"。
    const keepView =
      options.keepView === true && previous !== null && previous.root === relPath && previous.depth === depth
    if (!keepView) {
      // 卡片尺寸是**布局的输入**：非保留视角的加载顺手把它从落盘读回来（用户为此调过宽度，
      // 每次换深度都重调一遍是不能接受的）。保留视角的刷新不动它 —— 内存里的才是最新的。
      set({ egoStatus: 'loading', egoError: null, cardSizes: loadCardSizes(get().rootPath) })
    }
    try {
      const data = await ipc.graphEgo(relPath, depth)
      if (seq !== egoSeq) return
      // 正文是**卡片正面**的内容：与子图一起换，避免"节点换了一批、卡片还写着上一批的正文"
      const texts = await readTexts(data.nodes.map((node) => node.relPath))
      if (seq !== egoSeq) return
      set({
        ego: { root: relPath, depth, data },
        egoStatus: 'ready',
        egoError: null,
        texts,
        ...(keepView ? {} : { selected: null }),
      })
    } catch (cause) {
      if (seq !== egoSeq) return
      if (keepView) {
        // 刷新失败：留住旧数据，只记一条提示（与全库视图同一条纪律）
        set({ refreshNotice: `${describeError(MimenoteError.from(cause), '刷新关系图失败')}${STALE_SUFFIX}` })
        return
      }
      set({ egoStatus: 'error', egoError: MimenoteError.from(cause), ego: null })
    }
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

  // -------------------------------------------------------------------------
  // 可调大小的卡片（ADR-0023）
  // -------------------------------------------------------------------------

  setCardWidth: (relPath, width) => {
    const next = clampCardWidth(width)
    const current = get().cardSizes
    if (current.get(relPath)?.width === next) return
    const sizes = new Map(current)
    // 调宽度时把**高度上限一并重置成"自动"**：宽度变了，正文的换行就变了 —— 同一个上限下
    // 更宽的卡片会显示更多行。若此时仍钉着旧上限，用户会觉得"我拉宽了，怎么反而看着更短"。
    sizes.set(relPath, { width: next, height: null })
    persistCardSizes(get().rootPath, sizes)
    set({ cardSizes: sizes })
  },

  setCardHeight: (relPath, height) => {
    const next = clampCardHeight(height)
    const current = get().cardSizes
    if (current.get(relPath)?.height === next) return
    const width = current.get(relPath)?.width ?? null
    const sizes = new Map(current)
    sizes.set(relPath, { width, height: next })
    persistCardSizes(get().rootPath, sizes)
    set({ cardSizes: sizes })
  },

  resetCardSize: (relPath) => {
    const current = get().cardSizes
    const sizes = new Map(current)
    if (relPath === undefined) sizes.clear()
    else sizes.delete(relPath)
    persistCardSizes(get().rootPath, sizes)
    set({ cardSizes: sizes })
  },

  // -------------------------------------------------------------------------
  // 张力与浮动态（ADR-0023）
  // -------------------------------------------------------------------------

  setTension: (tension) => {
    const next = clampTension(tension)
    if (get().tension === next) return
    saveJson(PREFS_KEY, prefsOf({ ...get(), tension: next }))
    set({ tension: next })
  },

  setEdgeFromLink: (on) => {
    if (get().edgeFromLink === on) return
    saveJson(PREFS_KEY, prefsOf({ ...get(), edgeFromLink: on }))
    set({ edgeFromLink: on })
  },

  setForcePreset: (id) => {
    if (get().forcePreset === id) return
    saveJson(PREFS_KEY, prefsOf({ ...get(), forcePreset: id }))
    set({ forcePreset: id })
  },

  setFloating: (on) => {
    if (get().floating === on) return
    saveJson(PREFS_KEY, prefsOf({ ...get(), floating: on }))
    set({ floating: on })
  },

  // -------------------------------------------------------------------------
  // 浮动笔记面板（ADR-0023）
  // -------------------------------------------------------------------------

  openFloating: (relPath) => {
    const current = get().floatingPanes
    if (current.some((pane) => pane.relPath === relPath)) {
      get().raiseFloating(relPath)
      return
    }
    // 位置错开一点：同一处叠着会让人以为只开了一个；尺寸不超过视口（小窗口里也要能用）
    const step = (current.length % 5) * 28
    const { viewport } = get()
    const width = Math.min(DEFAULT_FLOAT_WIDTH, Math.max(MIN_FLOAT_WIDTH, viewport.width - 48))
    const height = Math.min(DEFAULT_FLOAT_HEIGHT, Math.max(MIN_FLOAT_HEIGHT, viewport.height - 48))
    const pane: FloatingPane = {
      relPath,
      x: Math.max(12, viewport.width - width - 24 - step),
      y: Math.max(12, 60 + step),
      width,
      height,
      z: topZ(current) + 1,
    }
    set({ floatingPanes: [...current, pane] })
  },

  closeFloating: (relPath) => {
    const current = get().floatingPanes
    const next = current.filter((pane) => pane.relPath !== relPath)
    if (next.length === current.length) return
    set({ floatingPanes: next })
  },

  closeAllFloating: () => {
    if (get().floatingPanes.length === 0) return
    set({ floatingPanes: [] })
  },

  moveFloating: (relPath, rect) => {
    const current = get().floatingPanes
    const index = current.findIndex((pane) => pane.relPath === relPath)
    const pane = index < 0 ? undefined : current[index]
    if (pane === undefined) return
    const next = [...current]
    next[index] = {
      ...pane,
      x: rect.x,
      y: rect.y,
      width: Math.max(MIN_FLOAT_WIDTH, rect.width),
      height: Math.max(MIN_FLOAT_HEIGHT, rect.height),
    }
    set({ floatingPanes: next })
  },

  raiseFloating: (relPath) => {
    const current = get().floatingPanes
    const index = current.findIndex((pane) => pane.relPath === relPath)
    const pane = index < 0 ? undefined : current[index]
    if (pane === undefined) return
    const top = topZ(current)
    if (pane.z === top) return
    const next = [...current]
    next[index] = { ...pane, z: top + 1 }
    set({ floatingPanes: next })
  },

  // -------------------------------------------------------------------------
  // 被按住的卡片
  // -------------------------------------------------------------------------

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

  autoFitBounds: (key, bounds) => {    const state = get()
    if (state.fitKey === key) return
    if (bounds.width <= 0 || bounds.height <= 0) return
    set({
      fitKey: key,
      view: fitView(bounds, { width: state.viewport.width, height: state.viewport.height }, FIT_PADDING),
    })
  },
}))

/**
 * 批量读一批笔记的正文（节点卡片正面画的就是它）。
 *
 * 两件事刻意这样做：
 *
 * 1. **分批**：一次 IPC 读 300 篇正文会让第一张卡片出现得很晚，而且任何一篇读失败都可能
 *    把整批拖成错误；按 `TEXT_BATCH_SIZE` 切开，前几批回来就能开始排版。
 * 2. **失败不抛**：读不到正文的节点退化成"只画标题/标签/度数"的紧凑卡片 —— 图谱的结构
 *    仍然完整可读，比整幅画布变成错误层好得多（宿主那边 `notes_read_batch` 本来就会把
 *    跳过的东西放在 `skipped` 里，不是异常）。
 */
async function readTexts(relPaths: readonly string[]): Promise<Map<string, string>> {
  const texts = new Map<string, string>()
  for (let start = 0; start < relPaths.length; start += TEXT_BATCH_SIZE) {
    const batch = relPaths.slice(start, start + TEXT_BATCH_SIZE)
    if (batch.length === 0) continue
    try {
      const result = await ipc.notesReadBatch(batch)
      for (const item of result.items) texts.set(item.relPath, item.text)
    } catch {
      // 整批失败就跳过这一批：剩下的批次照旧读（一篇坏文件不该让其余卡片没有正文）
      continue
    }
  }
  return texts
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

/** 测试与"换 Vault"时用：清掉所有持久化的手工位置。 */
export function clearStoredPositions(): void {
  saveJson(POSITIONS_KEY, {})
}
