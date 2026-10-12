/**
 * 图谱的**卡片、力度与浮窗**切片（zustand slice）。
 *
 * 一句话职责：卡片的手工尺寸、连线张力与力导向参数（预设 + 手调）、四个观感开关
 * （从链接引出 / 仅标题 / 沿环走线 / 漂浮），以及浮动笔记面板（位置、层级、开关）。
 *
 * 为什么这四样算一件事：它们全是"我怎么看这张卡片、这条边"的偏好 —— 都按
 * `mimenote.graph.prefs.v1` / `mimenote.graph.sizes.v1` 落盘，改动只影响观感、不影响数据正确性。
 * 浮窗面板是刻意的例外：**不落盘**（临时的阅读姿势，见 `FloatingPane` 的说明）。
 *
 * 切片之间用 `get()` 交叉读：`setCardSize` 要知道 `rootPath`（数据切片）才落得到正确的 Vault，
 * `openFloating` 要知道 `viewport`（视图切片）才知道面板该摆在哪儿。**不要**为了"少一次交叉读"
 * 把这些字段复制一份 —— 那就是第二份判据。
 */

import type { StateCreator } from 'zustand'

import type { ForceParams } from '@/domain/graph/force'
import { forcePreset } from '@/domain/graph/force-presets'
import {
  DEFAULT_FORCE_PRESET,
  DEFAULT_TENSION,
  clampCardHeight,
  clampCardWidth,
  clampForceParam,
  clampTension,
  type CardSize,
} from '@/domain/graph/prefs'

import { PREFS_KEY, persistCardSizes, prefsOf, readPrefs } from './graph-persist'
import type { GraphState } from './graph-store'
import { saveJson } from './persist'

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

/** 浮动面板的层级：只增不减（`z` 只用来排序，数值本身没有意义）。 */
function topZ(panes: readonly FloatingPane[]): number {
  return panes.reduce((max, pane) => Math.max(max, pane.z), 0)
}

/** 卡片与浮窗切片：尺寸、张力/力度、四个观感开关、浮动面板。 */
export interface CardsSlice {
  /** 用户手工调过的卡片尺寸（按 Vault + relPath 持久化）。 */
  cardSizes: ReadonlyMap<string, CardSize>
  /** 调宽度（同时把高度上限放开到新宽度下自然需要的高度，见实现里的说明）。 */
  setCardWidth: (relPath: string, width: number) => void
  /** 调正文高度上限。 */
  setCardHeight: (relPath: string, height: number) => void
  /**
   * 同时调宽度与高度（右下角缩放手柄的拖动路径）。
   *
   * 为什么与 `setCardWidth` 分开：单独拉宽时"高度回到自动"是对的（换行变了，旧上限会让
   * 人以为"拉宽反而变矮"）；但手柄拖动的语义是"我在圈定这张卡片的框"，两个方向都是
   * 用户的显式意图 —— 这时再把高度重置回自动，就等于"高度永远调不了"（用户报的那个毛病）。
   */
  setCardSize: (relPath: string, width: number, height: number) => void
  /** 「全文」开关：`true` = 不截断（整篇正文都排进卡片），`false` = 回到高度上限。 */
  setCardFull: (relPath: string, full: boolean) => void
  /** 恢复一张卡片（或全部）的自动尺寸。 */
  resetCardSize: (relPath?: string) => void

  /** 连线张力（0..1）：控制点沿垂直方向偏移弦长的多少。 */
  tension: number
  setTension: (tension: number) => void
  /** 连接线是否从正文里的 wiki link 文字处引出（关掉 = 全部从卡片边界出发）。 */
  edgeFromLink: boolean
  setEdgeFromLink: (on: boolean) => void
  /**
   * 力导向的**当前参数**（可以是一整套预设，也可以是用户手调过的）。
   *
   * 为什么存整份参数而不是"预设 id + 覆盖项"：滑杆一拧就是"我在改这一套手感"，
   * 而"哪些字段被改过"对用户没有意义（见 `forcePreset` 只用来显示"当前基于哪一档"）。
   */
  forceParams: ForceParams
  /** 当前力度基于哪一档预设（手调之后界面显示"自定义"，但仍记得从哪一档出发）。 */
  forcePreset: string
  setForcePreset: (id: string) => void
  /** 改一个力度参数（越界会被夹回范围内；面板上的滑杆走它）。 */
  setForceParam: (key: string, value: number) => void
  /** 把力度恢复成当前预设的那一套。 */
  resetForceParams: () => void
  /** 是否让节点持续漂浮（false = 落定后静止，省电）。 */
  floating: boolean
  setFloating: (on: boolean) => void
  /**
   * 纯标题卡片：焦点视图只画标题（文件名），不排正文。
   *
   * 用户要它是为了"一屏看更多关系"：正文卡片动辄几百像素高，跳数一多整幅图就只剩
   * 几张卡片；纯标题卡片把每篇压成一行高，环上的密度完全不同。正文没有了，连线也就
   * 没有 `[[链接]]` 文字可指 —— 那种情况下引线如实降级成"从卡片边界出发"。
   */
  titleOnly: boolean
  setTitleOnly: (on: boolean) => void
  /**
   * 连线是否走环向走线（ADR-0028）：同环的线沿环外弧走、跨环的线朝外鼓，都不再横穿圆心。
   *
   * 关掉就退回"两点一条贝塞尔"（ADR-0023 的老画法）—— 保留它是为了能当场对比，
   * 也因为"线长什么样"是观感偏好，不该由代码替用户拍板。
   */
  ringRouting: boolean
  setRingRouting: (on: boolean) => void

  /** 当前打开的浮动面板（可多个；`z` 大的在上面）。 */
  floatingPanes: readonly FloatingPane[]  /** 打开（或置顶）一篇笔记的浮动面板。 */
  openFloating: (relPath: string) => void
  closeFloating: (relPath: string) => void
  closeAllFloating: () => void
  moveFloating: (relPath: string, rect: { x: number; y: number; width: number; height: number }) => void
  raiseFloating: (relPath: string) => void
}

export const createCardsSlice: StateCreator<GraphState, [], [], CardsSlice> = (set, get) => ({
  cardSizes: new Map<string, CardSize>(),
  tension: readPrefs().tension ?? DEFAULT_TENSION,
  edgeFromLink: readPrefs().edgeFromLink !== false,
  forcePreset: readPrefs().forcePreset ?? DEFAULT_FORCE_PRESET,
  /**
   * 当前力度参数：优先用手调过的那一份，否则用当前预设那一套。
   * 两者都在 `readPrefs` 里算好（见 `readForceParams`：逐项夹范围 + 吸附步长）。
   */
  forceParams: readPrefs().forceParams ?? forcePreset(readPrefs().forcePreset ?? DEFAULT_FORCE_PRESET).params,
  floating: readPrefs().floating !== false,
  titleOnly: readPrefs().titleOnly === true,
  ringRouting: readPrefs().ringRouting !== false,
  floatingPanes: [],

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
    // `full` 保持不变："看全文"与"卡片多宽"是两个正交的意图。
    sizes.set(relPath, { width: next, height: null, full: current.get(relPath)?.full === true })
    persistCardSizes(get().rootPath, sizes)
    set({ cardSizes: sizes })
  },

  setCardHeight: (relPath, height) => {
    const next = clampCardHeight(height)
    const current = get().cardSizes
    if (current.get(relPath)?.height === next && current.get(relPath)?.full !== true) return
    const width = current.get(relPath)?.width ?? null
    const sizes = new Map(current)
    // 显式给了上限就退出「全文」：两者是"这一篇怎么显示"的两种互斥答案
    sizes.set(relPath, { width, height: next, full: false })
    persistCardSizes(get().rootPath, sizes)
    set({ cardSizes: sizes })
  },

  setCardSize: (relPath, width, height) => {
    const nextWidth = clampCardWidth(width)
    const nextHeight = clampCardHeight(height)
    const current = get().cardSizes
    const existing = current.get(relPath)
    if (existing !== undefined && existing.width === nextWidth && existing.height === nextHeight && existing.full !== true) {
      return
    }
    const sizes = new Map(current)
    // 手柄拖动是"圈定这张卡片的框"：宽高都是显式意图，同时退出全文态（见接口处的说明）
    sizes.set(relPath, { width: nextWidth, height: nextHeight, full: false })
    persistCardSizes(get().rootPath, sizes)
    set({ cardSizes: sizes })
  },

  setCardFull: (relPath, full) => {
    const current = get().cardSizes
    const existing = current.get(relPath)
    if ((existing?.full === true) === full) return
    const sizes = new Map(current)
    if (full) {
      sizes.set(relPath, { width: existing?.width ?? null, height: null, full: true })
    } else if (existing !== undefined) {
      // 关掉全文回到"自动上限"（不恢复某个旧上限 —— 那是切换前的历史，不是现在的意图）
      sizes.set(relPath, { ...existing, full: false })
    }
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
    const params = forcePreset(id).params
    // 换预设 = 换**整套**力度（用户点的是"改用这一档手感"），因此手调过的参数一起被覆盖
    saveJson(PREFS_KEY, prefsOf({ ...get(), forcePreset: id, forceParams: params }))
    set({ forcePreset: id, forceParams: params })
  },

  setForceParam: (key, value) => {
    const current = get().forceParams
    const next = clampForceParam(key, value)
    if ((current as unknown as Record<string, number>)[key] === next) return
    // `key` 来自面板上那份固定清单（`FORCE_SLIDER_KEYS`），"按动态键改一个字段"在 TS 里
    // 表达不出来 —— 这里是本文件唯一一处断言：值已经过 `clampForceParam`，形状必然是 `ForceParams`
    const params = { ...current, [key]: next } as ForceParams
    saveJson(PREFS_KEY, prefsOf({ ...get(), forceParams: params }))
    set({ forceParams: params })
  },

  resetForceParams: () => {
    const params = forcePreset(get().forcePreset).params
    saveJson(PREFS_KEY, prefsOf({ ...get(), forceParams: params }))
    set({ forceParams: params })
  },

  setFloating: (on) => {
    if (get().floating === on) return
    saveJson(PREFS_KEY, prefsOf({ ...get(), floating: on }))
    set({ floating: on })
  },

  setTitleOnly: (on) => {
    if (get().titleOnly === on) return
    saveJson(PREFS_KEY, prefsOf({ ...get(), titleOnly: on }))
    set({ titleOnly: on })
  },

  setRingRouting: (on) => {
    if (get().ringRouting === on) return
    saveJson(PREFS_KEY, prefsOf({ ...get(), ringRouting: on }))
    set({ ringRouting: on })
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
})
