/**
 * UI 偏好（视图模式、布局尺寸、主题、片段开关）。
 *
 * 全部持久化到 localStorage：这些是**用户偏好**，
 * 不写进 Vault 目录（保持用户的笔记文件夹干净）。
 * 唯一的例外是大纲的级别过滤：它按 Vault 根分桶存（见 {@link OutlineLevelsByVault}），
 * 因为"这个 Vault 想看到第几级标题"跟 Vault 的规模绑在一起，而不是跟人绑在一起。
 */

import { create } from 'zustand'

import { DEFAULT_THEME_ID, getTheme, nextThemeId } from '@/theme/apply'
import { DEFAULT_TREE_SORT, isTreeSort, type TreeSort } from '@/domain/tree'
import {
  DEFAULT_DOCK_LAYOUT,
  isDockLayout,
  type DockLayout,
} from '@/features/dock/dock-layout'
import {
  defaultLayout,
  layoutsEqual,
  type TreeLayout,
} from '@/features/layout/tree-layout'
import { migrateLayout } from '@/features/layout/layout-sync'
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

/**
 * 大纲面板的级别过滤（只显示哪几级标题），**按 Vault 根存**。
 *
 * 为什么它不像其它偏好那样只存一份：过滤表达的是"这个 Vault 的笔记有多深"—— 几百篇的
 * 大 Vault 往往只想看 H1/H2 的骨架，而另一台目录里那个小 Vault 的 H4 正是正文的组织方式。
 * 混用一份会逼着用户每换一次 Vault 就重调一次（与标签列表同一个理由，见
 * `state/tabs-store.ts` 的"为什么按 Vault 根持久化"）。
 *
 * 缺省（某个 Vault 没有这一项）= 全部级别都显示：**升级上来的老用户看到的大纲必须和
 * 原来一模一样**，新能力只能是一排默认全亮的开关。
 */
export type OutlineLevelsByVault = Record<string, readonly number[]>

export interface UiPreferences {
  viewMode: ViewMode
  sidebarVisible: boolean
  sidebarWidth: number
  themeId: string
  snippetsEnabled: boolean
  /** 右侧链接面板（反向链接 / 出链）。 */
  linksPanelVisible: boolean
  linksPanelWidth: number
  /** 右侧大纲面板（当前笔记的标题树）。 */
  outlinePanelVisible: boolean
  /** 大纲面板的级别过滤，按 Vault 根存（见 {@link OutlineLevelsByVault}）。 */
  outlineLevelsByVault: OutlineLevelsByVault
  /**
   * 文件树的排序（依据 / 方向 / 目录是否在前）。
   *
   * 只存配置、不存排好的顺序：树由 `vault-store` 用这份配置重建（判据只有
   * `domain/tree.ts` 一份），配置变了由 vault-store 订阅触发重排。
   */
  treeSort: TreeSort
  /**
   * 视图模块的停靠位置（左 / 右 / 底部三个区 + 每区内的顺序）。
   *
   * **迁移期留档**（ADR-0035）：渲染与交互都已走 `layout`（容器切割树），这个字段
   * 不再被读 —— 它留在落盘里只是因为**回滚到旧版本时还能读到升级前那份布局**。
   * 别再给它加新的消费方。
   */
  dockLayout: DockLayout
  /**
   * **容器切割树**（ADR-0035）：谁在哪一格、每格显示谁、每刀的比例。
   *
   * 渲染与交互的唯一依据（`features/layout/TreeHost.tsx`）；从 `dockLayout` 迁移而来、
   * 随打开的笔记对账（`layout-sync.ts`）。
   */
  layout: TreeLayout
  /** 底部停靠区的高度（px）。**迁移期留档**：树模型里尺寸是 split 的比例，这个字段不再被读。 */
  bottomDockHeight: number
}

const STORAGE_KEY = 'mimenote.ui.v1'

export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 560
export const LINKS_PANEL_MIN = 200
export const LINKS_PANEL_MAX = 520
/** 底部停靠区的高度范围：比 120 矮就放不下任何面板的内容，比 640 高就不像"停靠"了。 */
export const BOTTOM_DOCK_MIN = 120
export const BOTTOM_DOCK_MAX = 640

const DEFAULTS: UiPreferences = {
  viewMode: 'edit',
  sidebarVisible: true,
  sidebarWidth: 288,
  themeId: DEFAULT_THEME_ID,
  snippetsEnabled: true,
  linksPanelVisible: false,
  linksPanelWidth: 300,
  outlinePanelVisible: false,
  outlineLevelsByVault: {},
  treeSort: DEFAULT_TREE_SORT,
  dockLayout: DEFAULT_DOCK_LAYOUT,
  layout: defaultLayout(),
  bottomDockHeight: 220,
}

function isPreferences(value: unknown): value is Partial<UiPreferences> {
  return typeof value === 'object' && value !== null
}

/**
 * 校验持久化回来的级别过滤：只认"1–6 的整数数组"。
 *
 * 为什么连值的形状都要校验：这份数据会被用户手工改（或者被旧版本、别的分支写成另一种形状），
 * 而它直接喂给渲染层的 `Set`。一道校验就能把"大纲里突然少了几条、且没有任何提示"挡在门外 ——
 * 校验不过时整份退回空对象，也就是"全部显示"这个安全默认。
 */
function isOutlineLevelsByVault(value: unknown): value is OutlineLevelsByVault {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every(
    (levels) =>
      Array.isArray(levels) &&
      levels.every(
        (level) => typeof level === 'number' && Number.isInteger(level) && level >= 1 && level <= 6,
      ),
  )
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
  outlinePanelVisible: restored.outlinePanelVisible ?? DEFAULTS.outlinePanelVisible,
  outlineLevelsByVault: isOutlineLevelsByVault(restored.outlineLevelsByVault)
    ? restored.outlineLevelsByVault
    : DEFAULTS.outlineLevelsByVault,
  // 逐字段校验的形状守卫在 domain/tree.ts（判据唯一真源）：坏数据整份退回默认
  treeSort: isTreeSort(restored.treeSort) ? restored.treeSort : DEFAULTS.treeSort,
  // 停靠模型有一条不变式（每个模块恰好出现一次），坏数据整份退回默认 —— 见 dock-layout.ts 的文件头
  dockLayout: isDockLayout(restored.dockLayout) ? restored.dockLayout : DEFAULT_DOCK_LAYOUT,
  /*
   * 树的新旧迁移：已经有树就用树；只有旧的 dockLayout 就迁移；都没有就用**今天默认的停靠布局**
   * 迁移出来（于是"外观不变"在默认情况下也成立）。
   *
   * **刻意不传 notes**：这一行在模块初始化时执行，那时 `tabs-store` 还没加载 ——
   * 传 `[]` 会被对账理解成"一篇都没开"，把树上的笔记标签全裁掉。传 `undefined` 的语义是
   * "还没拿到名单，别动树上的笔记"，真正的裁剪交给挂载后的对账。
   *
   * `sizes` 把旧的像素宽度换算成迁移比例的分母（只在这一个迁移时刻用；窗口尺寸取此刻的
   * 真实视口，jsdom/测试里则是 1024×768 —— 迁移结果仍是合法比例，见 `MigrateSizes`）。
   */
  layout: migrateLayout(restored.layout, {
    dock: isDockLayout(restored.dockLayout) ? restored.dockLayout : DEFAULT_DOCK_LAYOUT,
    sizes: {
      sidebarWidth: clamp(restored.sidebarWidth ?? DEFAULTS.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX),
      linksPanelWidth: clamp(
        restored.linksPanelWidth ?? DEFAULTS.linksPanelWidth,
        LINKS_PANEL_MIN,
        LINKS_PANEL_MAX,
      ),
      bottomDockHeight: clamp(
        restored.bottomDockHeight ?? DEFAULTS.bottomDockHeight,
        BOTTOM_DOCK_MIN,
        BOTTOM_DOCK_MAX,
      ),
      viewport: {
        width: typeof window === 'undefined' ? 1280 : window.innerWidth,
        height: typeof window === 'undefined' ? 800 : window.innerHeight,
      },
    },
  }),
  bottomDockHeight: clamp(
    restored.bottomDockHeight ?? DEFAULTS.bottomDockHeight,
    BOTTOM_DOCK_MIN,
    BOTTOM_DOCK_MAX,
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
  /** 大纲面板（与标签面板一样是固定宽度，不需要拖拽分隔条）。 */
  toggleOutlinePanel: () => void
  /**
   * 记下某个 Vault 的大纲级别过滤。
   *
   * 值是"要显示的级别"（空数组 = 一级都不显示）。规范化（去重 / 升序 / 只留 1–6）由
   * 调用方 `features/outline/outline-view.ts` 的纯函数负责 —— 那里是这条规则的唯一出处，
   * 不在 store 里再抄一份口径。
   */
  setOutlineLevels: (vaultRoot: string, levels: readonly number[]) => void

  /**
   * 更新文件树排序（部分合并：菜单一次只翻一个字段）。
   *
   * 只负责存偏好；**重排不在这里做** —— `vault-store` 订阅了这个字段，
   * 变化时用同一份 `makeEntryComparator` 判据重建树（见那边的模块级订阅）。
   */
  setTreeSort: (patch: Partial<TreeSort>) => void

  /** 底部停靠区高度（夹在 `BOTTOM_DOCK_MIN..MAX`；**迁移期留档**，见 `dockLayout` 的注释）。 */
  setBottomDockHeight: (height: number) => void

  /**
   * 回收站对话框是否打开。
   *
   * 与 `paletteMode` 同一类**瞬时状态**：刻意不进 `persist()` 的白名单 ——
   * 重启后不该自动弹出一个对话框。
   */
  trashDialogOpen: boolean
  setTrashDialogOpen: (open: boolean) => void

  /**
   * 换一棵布局树（对账 / 以后的各种拖拽都走它）。
   *
   * 结构没变时**直接返回**：对账是"每帧都可能调"的路径，不挡住的话每次切标签都会写一遍
   * localStorage。
   */
  setLayout: (layout: TreeLayout) => void

  /**
   * 主区里**正在用查看器打开的附件**（Vault 相对路径；`null` = 主区显示的是笔记）。
   *
   * 与 `paletteMode` / `trashDialogOpen` 同一类**瞬时状态**：刻意不进 `persist()` ——
   * 重启后不该自己弹回上次看过的那张图。它只回答一个问题："主区现在显示的是笔记还是文件"，
   * 判断"这个文件能不能打开、用哪种查看器"是 `domain/viewable.ts` 的事（判据只有一份）。
   *
   * 两条清除路径：打开一篇笔记（`app/actions.openNote`）与点视图按钮（`setViewMode` /
   * `cycleViewMode` —— "回到编辑/阅读/图谱"这个动作的语义就是"我要看笔记了"）。
   */
  openedFile: string | null
  openFile: (relPath: string) => void
  closeFile: () => void
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
    outlinePanelVisible: state.outlinePanelVisible,
    outlineLevelsByVault: state.outlineLevelsByVault,
    treeSort: state.treeSort,
    dockLayout: state.dockLayout,
    layout: state.layout,
    bottomDockHeight: state.bottomDockHeight,
  } satisfies UiPreferences)
}

export const useUiStore = create<UiState>((set, get) => ({
  ...initial,

  paletteMode: null,

  trashDialogOpen: false,

  openedFile: null,

  setTrashDialogOpen: (open) => {
    // 与 `openPalette` 一样：对话框开关不是需要记住的偏好，不调用 persist()
    set({ trashDialogOpen: open })
  },

  openPalette: (mode) => {
    // 不调用 persist()：面板开关不是需要记住的偏好
    set({ paletteMode: mode })
  },

  closePalette: () => {
    set({ paletteMode: null })
  },

  setLayout: (layout) => {
    if (layoutsEqual(get().layout, layout)) return
    set({ layout })
    persist(get())
  },

  openFile: (relPath) => {
    // 不调用 persist()：看过的文件不是需要记住的偏好
    set({ openedFile: relPath })
  },

  closeFile: () => {
    if (get().openedFile === null) return
    set({ openedFile: null })
  },

  setViewMode: (viewMode) => {
    // 视图按钮的语义是"我要看**笔记**的哪一种形态" ⇒ 顺手把附件查看器关掉
    set({ viewMode, openedFile: null })
    persist(get())
  },

  cycleViewMode: () => {
    const order: ViewMode[] = ['edit', 'read', 'graph']
    const current = get().viewMode
    const next = order[(order.indexOf(current) + 1) % order.length] ?? 'edit'
    set({ viewMode: next, openedFile: null })
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

  toggleOutlinePanel: () => {
    set((state) => ({ outlinePanelVisible: !state.outlinePanelVisible }))
    persist(get())
  },

  setOutlineLevels: (vaultRoot, levels) => {
    // 复制一份再存：调用方可能把模块级的 `ALL_HEADING_LEVELS` 常量递进来，
    // 直接引用会让"以后谁改了这个常量"变成"某个 Vault 的偏好悄悄变了"
    set((state) => ({
      outlineLevelsByVault: { ...state.outlineLevelsByVault, [vaultRoot]: [...levels] },
    }))
    persist(get())
  },

  setTreeSort: (patch) => {
    // 部分合并后仍然过一次形状校验：补丁可能携带错误类型（类型系统之外的调用方），
    // 写进 store 的必须是一份合法配置；无实际变化时不动状态（免得触发无谓的重排）
    const current = get().treeSort
    const next = { ...current, ...patch }
    if (!isTreeSort(next)) return
    if (
      next.by === current.by &&
      next.direction === current.direction &&
      next.foldersFirst === current.foldersFirst
    ) {
      return
    }
    set({ treeSort: next })
    persist(get())
  },

  setBottomDockHeight: (height) => {
    const next = clamp(height, BOTTOM_DOCK_MIN, BOTTOM_DOCK_MAX)
    if (next === get().bottomDockHeight) return
    set({ bottomDockHeight: next })
    persist(get())
  },
}))
