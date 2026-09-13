/**
 * UI 偏好（视图模式、布局尺寸、主题、片段开关）。
 *
 * 全部持久化到 localStorage：这些是**跨 Vault 的用户偏好**，
 * 不写进 Vault 目录（保持用户的笔记文件夹干净）。
 */

import { create } from 'zustand'

import { DEFAULT_THEME_ID, getTheme, nextThemeId } from '@/theme/apply'
import { loadJson, saveJson } from './persist'

export type ViewMode = 'editor' | 'split' | 'preview'

export interface UiPreferences {
  viewMode: ViewMode
  sidebarVisible: boolean
  sidebarWidth: number
  previewRatio: number
  themeId: string
  snippetsEnabled: boolean
  /** 右侧链接面板（反向链接 / 出链）。 */
  linksPanelVisible: boolean
  linksPanelWidth: number
}

const STORAGE_KEY = 'mimenote.ui.v1'

export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 560
export const PREVIEW_MIN_RATIO = 0.15
export const PREVIEW_MAX_RATIO = 0.85
export const LINKS_PANEL_MIN = 200
export const LINKS_PANEL_MAX = 520

const DEFAULTS: UiPreferences = {
  viewMode: 'split',
  sidebarVisible: true,
  sidebarWidth: 288,
  previewRatio: 0.5,
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
  viewMode:
    restored.viewMode === 'editor' || restored.viewMode === 'split' || restored.viewMode === 'preview'
      ? restored.viewMode
      : DEFAULTS.viewMode,
  sidebarVisible: restored.sidebarVisible ?? DEFAULTS.sidebarVisible,
  sidebarWidth: clamp(restored.sidebarWidth ?? DEFAULTS.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX),
  previewRatio: clamp(
    restored.previewRatio ?? DEFAULTS.previewRatio,
    PREVIEW_MIN_RATIO,
    PREVIEW_MAX_RATIO,
  ),
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
  setViewMode: (mode: ViewMode) => void
  cycleViewMode: () => void
  toggleSidebar: () => void
  setSidebarWidth: (width: number) => void
  setPreviewRatio: (ratio: number) => void
  setThemeId: (id: string) => void
  cycleTheme: () => void
  setSnippetsEnabled: (enabled: boolean) => void
  toggleLinksPanel: () => void
  setLinksPanelWidth: (width: number) => void
}

function persist(state: UiState): void {
  saveJson(STORAGE_KEY, {
    viewMode: state.viewMode,
    sidebarVisible: state.sidebarVisible,
    sidebarWidth: state.sidebarWidth,
    previewRatio: state.previewRatio,
    themeId: state.themeId,
    snippetsEnabled: state.snippetsEnabled,
    linksPanelVisible: state.linksPanelVisible,
    linksPanelWidth: state.linksPanelWidth,
  } satisfies UiPreferences)
}

export const useUiStore = create<UiState>((set, get) => ({
  ...initial,

  setViewMode: (viewMode) => {
    set({ viewMode })
    persist(get())
  },

  cycleViewMode: () => {
    const order: ViewMode[] = ['editor', 'split', 'preview']
    const current = get().viewMode
    const next = order[(order.indexOf(current) + 1) % order.length] ?? 'split'
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

  setPreviewRatio: (ratio) => {
    set({ previewRatio: clamp(ratio, PREVIEW_MIN_RATIO, PREVIEW_MAX_RATIO) })
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
