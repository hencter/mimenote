/**
 * 图谱的持久化 —— **三个 localStorage 键的读写 + 400ms 防抖**。
 *
 * 一句话职责：把"手工位置 / 视图偏好 / 卡片尺寸"三份东西安全地读回来、写下去
 * （含脏值归一化、按 Vault 分组、以及拖动时的合并写入）。
 *
 * 三个键是**对外契约，不许改名**（它们是老用户升级时唯一的迁移依据）：
 * - `mimenote.graph.positions.v1`：按 Vault 分的手工拖动位置；
 * - `mimenote.graph.prefs.v1`：**不按 Vault 分**的"我怎么看图"的偏好（模式/跳数/张力/预设/开关）；
 * - `mimenote.graph.sizes.v1`：按 Vault 分的卡片手工尺寸。
 *
 * ⚠️ **防抖器必须唯一**：`persistTimer` 是模块级单例。拖动一次会连续调 `schedulePositions`，
 * 若在别处再写一个防抖器，两条定时器会互相盖掉 —— 最后一次拖动就永远不落盘
 * （"窗口关闭前的最后一次拖动仍在 400ms 内落盘"这条承诺挂在这个单例上）。
 *
 * 这个文件刻意**不认识 store**：`flushPositionPersist` 那种"从 store 取状态再落盘"的胶水
 * 住在 `graph-store.ts` 的壳里 —— 否则 `store → persist → store` 就成了模块级环
 * （门禁会红，而且热更新时会出现半初始化的 store）。
 */

import type { Point } from '@/domain/graph/geometry'
import type { ForceParams } from '@/domain/graph/force'
import { forcePreset } from '@/domain/graph/force-presets'
import {
  DEFAULT_EGO_DEPTH,
  DEFAULT_FORCE_PRESET,
  DEFAULT_TENSION,
  clampCardSizeHeight,
  clampCardWidth,
  clampEgoDepth,
  clampTension,
  readForceParams,
  type CardSize,
  type GraphMode,
} from '@/domain/graph/prefs'

import { loadJson, saveJson } from './persist'

/** 手工位置的存储键：`{ [Vault 根]: { [relPath]: {x, y} } }`。 */
export const POSITIONS_KEY = 'mimenote.graph.positions.v1'

/**
 * 视图偏好的存储键（模式与跳数）。
 *
 * 为什么**不按 Vault 分**：它们是"我怎么看图"的偏好，不是"这个 Vault 长什么样"的数据。
 * 换一个 Vault 还要重新选一遍自我中心视图，只会让人以为这个开关坏了。
 */
export const PREFS_KEY = 'mimenote.graph.prefs.v1'

export const CARD_SIZE_KEY = 'mimenote.graph.sizes.v1'

/** 拖动时每次 pointermove 都写 localStorage 是浪费（一次 JSON.stringify 可能是几千项），
 *  因此合并成一次延迟写入；窗口关闭前的最后一次拖动仍在 400ms 内落盘。 */
const PERSIST_DEBOUNCE_MS = 400

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
  /** 手调过的力度参数（整份存下来，读回时逐项夹范围 + 吸附步长，见 `readForceParams`）。 */
  forceParams?: ForceParams
  /**
   * 纯标题卡片：焦点视图里只画标题（文件名），不排正文。
   *
   * 缺省 `false`（保留"卡片正面是完整预览"的默认形态）。这是"我怎么看图"的偏好，
   * 与 `mode`/`depth` 同属一份偏好存储，不按 Vault 分。
   */
  titleOnly?: boolean
  /**
   * 连线是否走**环向走线**（同环的线沿环外弧走、跨环的线朝外鼓，ADR-0028）。
   *
   * 缺省 `true`（新的默认观感）；关掉就退回"两点一条贝塞尔"的老画法。
   * 做成可关不只是为了对比：这是纯观感的选择，而观感这件事没有"对所有人都是对的答案"。
   */
  ringRouting?: boolean
}

function isStoredPrefs(value: unknown): value is StoredPrefs {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { mode?: unknown; depth?: unknown }
  return (
    (record.mode === 'focus' || record.mode === 'vault') && typeof record.depth === 'number'
  )
}

export function readPrefs(): StoredPrefs {
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
    titleOnly: stored.titleOnly === true,
    ringRouting: stored.ringRouting !== false,
    forcePreset: stored.forcePreset ?? DEFAULT_FORCE_PRESET,
    // 整份力度：没有存过就用预设那一套（`null` 表示"没存过/存坏了"）
    forceParams: readForceParams(stored.forceParams) ?? forcePreset(stored.forcePreset ?? DEFAULT_FORCE_PRESET).params,
  }
}

function isStoredPositions(value: unknown): value is StoredPositions {
  return typeof value === 'object' && value !== null
}

export function readStoredPositions(): StoredPositions {
  return loadJson<StoredPositions>(POSITIONS_KEY, {}, isStoredPositions)
}

export function toMap(record: Record<string, Point> | undefined): Map<string, Point> {
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

export function flushPositions(rootPath: string | null, manual: ReadonlyMap<string, Point>): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  if (rootPath === null) return
  const stored = readStoredPositions()
  saveJson(POSITIONS_KEY, { ...stored, [rootPath]: toRecord(manual) })
}

export function schedulePositions(rootPath: string | null, manual: ReadonlyMap<string, Point>): void {
  if (persistTimer !== null) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    flushPositions(rootPath, manual)
  }, PERSIST_DEBOUNCE_MS)
}

interface PrefsSource {
  mode: GraphMode
  depth: number
  tension: number
  edgeFromLink: boolean
  floating: boolean
  forcePreset: string
  forceParams: ForceParams
  titleOnly: boolean
  ringRouting: boolean
}

/** 把当前状态收成一份可落盘的偏好（所有 setter 共用，避免各自漏写一个字段）。 */
export function prefsOf(source: PrefsSource): StoredPrefs {
  return {
    mode: source.mode,
    depth: source.depth,
    tension: source.tension,
    edgeFromLink: source.edgeFromLink,
    floating: source.floating,
    forcePreset: source.forcePreset,
    forceParams: { ...source.forceParams },
    titleOnly: source.titleOnly,
    ringRouting: source.ringRouting,
  }
}

type StoredCardSizes = Record<
  string,
  Record<string, { width: number | null; height: number | null; full?: boolean }>
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
export function persistCardSizes(rootPath: string | null, sizes: ReadonlyMap<string, CardSize>): void {
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
export function loadCardSizes(rootPath: string | null): Map<string, CardSize> {
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
      // `full` 是老版本记录里没有的字段：缺省按 false（截断形态不变）
      full: size.full === true,
    })
  }
  return map
}

/** 测试与"换 Vault"时用：清掉所有持久化的手工位置。 */
export function clearStoredPositions(): void {
  saveJson(POSITIONS_KEY, {})
}
