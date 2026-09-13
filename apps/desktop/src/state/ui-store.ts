/**
 * UI 偏好（视图模式、布局尺寸、主题、片段开关）。
 *
 * 全部持久化到 localStorage：这些是**跨 Vault 的用户偏好**，
 * 不写进 Vault 目录（保持用户的笔记文件夹干净）。
 */

import { create } from 'zustand'

import { DEFAULT_THEME_ID, getTheme, nextThemeId } from '@/theme/apply'
import { loadJson, saveJson } from './persist'

/**
 * 主区域的视图模式。
 *
 * 只有三种：**所见即所得编辑**、**只读预览**、**知识图谱画布**。
 * 原来的"分栏（编辑 + 预览并排）"已经移除 —— 编辑器本身就是所见即所得的，
 * 并排显示同一份内容只会挤掉写作宽度（见 ADR-0009）。
 */
export type ViewMode = 'edit' | 'read' | 'graph'

/** 旧版本持久化过的值 → 新模型（`split` 折到编辑，`preview` 折到阅读）。 */
function migrateViewMode(value: unknown): ViewMode | null {
  if (value === 'edit' || value === 'read' || value === 'graph') return value
  if (value === 'editor' || value === 'split') return 'edit'
  if (value === 'preview') return 'read'
  return null
}

/**
 * 面板的模式（`null` = 未打开）。
 *
 * 三种模式共用同一个面板组件，区别只有"数据源"与"激活后做什么"：
 * - `commands`：命令注册表，同步过滤（每次按键一次 O(n) 扫描）；
 * - `quickSwitch`：Vault 条目表派生的笔记索引，同步过滤；
 * - `search`：宿主（SQLite FTS5）的全文搜索结果，**异步** —— 防抖 + 竞态丢弃
 *   （见 `features/palette/use-search.ts`），这是它与前两种模式最大的不同。
 */
export type PaletteMode = 'commands' | 'quickSwitch' | 'search'

export interface UiPreferences {
  viewMode: ViewMode
  sidebarVisible: boolean
  sidebarWidth: number
  themeId: string
  snippetsEnabled: boolean
  /** 右侧链接面板（反向链接 / 出链）。 */
  linksPanelVisible: boolean
  linksPanelWidth: number
}

const STORAGE_KEY = 'mimenote.ui.v1'

export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 560
export const LINKS_PANEL_MIN = 200
export const LINKS_PANEL_MAX = 520

const DEFAULTS: UiPreferences = {
  viewMode: 'edit',
  sidebarVisible: true,
  sidebarWidth: 288,
  themeId: DEFAULT_THEME_ID,
  snippetsEnabled: true,
  linksPanelVisible: false,
  linksPanelWidth: 300,
}

function isPreferences(value: unknown): value is Partial<UiPreferences> {
  return typeof value === 'object' && value !== null
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
}

const restored = loadJson<Partial<UiPreferences>>(STORAGE_KEY, {}, isPreferences)

const initial: UiPreferences = {
  viewMode: migrateViewMode(restored.viewMode) ?? DEFAULTS.viewMode,
  sidebarVisible: restored.sidebarVisible ?? DEFAULTS.sidebarVisible,
  sidebarWidth: clamp(restored.sidebarWidth ?? DEFAULTS.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX),
  themeId: typeof restored.themeId === 'string' ? restored.themeId : DEFAULTS.themeId,
  snippetsEnabled: restored.snippetsEnabled ?? DEFAULTS.snippetsEnabled,
  linksPanelVisible: restored.linksPanelVisible ?? DEFAULTS.linksPanelVisible,
  linksPanelWidth: clamp(
    restored.linksPanelWidth ?? DEFAULTS.linksPanelWidth,
    LINKS_PANEL_MIN,
    LINKS_PANEL_MAX,
  ),
}

interface UiState extends UiPreferences {
  /**
   * 面板是否打开 / 打开哪一个。
   *
   * 为什么放在这个 store 而不是组件内 state：
   * 它是**跨组件共享**的应用级状态 —— 调用方既有 React 组件，也有非 React 的
   * 全局快捷键监听与命令注册表（`palette.open` / `palette.quickSwitch` / `search.open`），
   * 组件内状态给不了它们。查询串、高亮下标与搜索结果则相反（面板私有、每次打开都要重置），
   * 留在组件与 `usePaletteSearch` 里，见 `features/palette/CommandPalette.tsx`。
   *
   * 刻意**不持久化**（见 `persist()` 的白名单）：重启后不该自动弹出一个面板。
   */
  paletteMode: PaletteMode | null
  openPalette: (mode: PaletteMode) => void
  closePalette: () => void

  setViewMode: (mode: ViewMode) => void
  /** 在 编辑 → 阅读 → 图谱 之间循环（状态栏与快捷键用它）。 */
  cycleViewMode: () => void
  toggleSidebar: () => void
  setSidebarWidth: (width: number) => void
  setThemeId: (id: string) => void
  cycleTheme: () => void
  setSnippetsEnabled: (enabled: boolean) => void
  toggleLinksPanel: () => void
  setLinksPanelWidth: (width: number) => void
}

function persist(state: UiState): void {
  // 白名单式持久化：只写用户偏好，不写瞬时状态（例如 paletteMode）
  saveJson(STORAGE_KEY, {
    viewMode: state.viewMode,
    sidebarVisible: state.sidebarVisible,
    sidebarWidth: state.sidebarWidth,
    themeId: state.themeId,
    snippetsEnabled: state.snippetsEnabled,
    linksPanelVisible: state.linksPanelVisible,
    linksPanelWidth: state.linksPanelWidth,
  } satisfies UiPreferences)
}

export const useUiStore = create<UiState>((set, get) => ({
  ...initial,

  paletteMode: null,

  openPalette: (mode) => {
    // 不调用 persist()：面板开关不是需要记住的偏好
    set({ paletteMode: mode })
  },

  closePalette: () => {
    set({ paletteMode: null })
  },

  setViewMode: (viewMode) => {
    set({ viewMode })
    persist(get())
  },

  cycleViewMode: () => {
    const order: ViewMode[] = ['edit', 'read', 'graph']
    const current = get().viewMode
    const next = order[(order.indexOf(current) + 1) % order.length] ?? 'edit'
    set({ viewMode: next })
    persist(get())
  },

  toggleSidebar: () => {
    set((state) => ({ sidebarVisible: !state.sidebarVisible }))
    persist(get())
  },

  setSidebarWidth: (width) => {
    set({ sidebarWidth: clamp(width, SIDEBAR_MIN, SIDEBAR_MAX) })
    persist(get())
  },

  setThemeId: (themeId) => {
    set({ themeId })
    persist(get())
  },

  cycleTheme: () => {
    const current = getTheme(get().themeId)
    set({ themeId: nextThemeId(current.id) })
    persist(get())
  },

  setSnippetsEnabled: (snippetsEnabled) => {
    set({ snippetsEnabled })
    persist(get())
  },

  toggleLinksPanel: () => {
    set((state) => ({ linksPanelVisible: !state.linksPanelVisible }))
    persist(get())
  },

  setLinksPanelWidth: (width) => {
    set({ linksPanelWidth: clamp(width, LINKS_PANEL_MIN, LINKS_PANEL_MAX) })
    persist(get())
  },
}))
