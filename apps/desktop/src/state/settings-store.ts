/**
 * 设置页状态：分区导航 + 数值型偏好 + "关于"页要的版本信息。
 *
 * 为什么设置放**独立 store**（而不是塞进 `ui-store` 或组件内 state）：
 * 1. 打开设置的调用方不止设置页自己 —— 标题栏菜单（`components/AppMenu.tsx`）、
 *    将来登记的 `settings.open` 命令（`app/builtin-commands.ts`）都要能打开它，
 *    `open` 因此是应用级状态，组件内 state 给不了它们；
 * 2. 偏好值的**生效点全在 React 之外**：自动保存延迟要喂给 `configureAutosave()`、
 *    字号要写进 `<html>` 的 CSS 变量、Tab 宽度要注入 `--mn-tab-size`。
 *    这些落点（`features/settings/*`）读的是 store，而不是某个组件的 props；
 * 3. 这些偏好是**跨 Vault 的用户偏好**，与 `ui-store` 同性质，但语义上不属于"界面布局"
 *    （那个 store 已经有 8 个布局字段），合进去只会让它继续膨胀。
 *
 * 持久化（键名固定，改动需同步升级版本后缀）：
 * - `mimenote.settings.v1`（JSON，`saveJson/loadJson`）：4 个数值偏好 + 附件目录；
 * - `mimenote.settings.section`（字符串，`saveString/loadString`）：上次停留的分区。
 * 只写这几个标量：没有任何敏感/大对象（附件目录是**Vault 内的相对目录**，
 * 不是本机绝对路径 —— 换 Vault 后它仍然有意义，这也是它敢被持久化的原因）。
 */

import { create } from 'zustand'

import { DEFAULT_ATTACHMENT_DIR, normalizeAttachmentDir } from '@/domain/attachments'
import { ipc } from '@/ipc/client'
import { MimenoteError } from '@/ipc/types'
import type { VersionInfo } from '@/ipc/types'
import { loadJson, loadString, saveJson, saveString } from './persist'

/** 设置页的分区（左侧导航）。 */
export type SettingsSection = 'appearance' | 'editor' | 'vault' | 'about'

/** 全部设置页分区（顺序即导航顺序）。 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'appearance',
  'editor',
  'vault',
  'about',
]

export const SETTINGS_SECTIONS_META: Readonly<
  Record<SettingsSection, { label: string; description: string }>
> = {
  appearance: { label: '外观', description: '主题、界面字号、编辑器字号' },
  editor: { label: '编辑器', description: '自动保存延迟、Tab 宽度、行号' },
  vault: { label: 'Vault', description: 'CSS 片段、索引与缓存' },
  about: { label: '关于', description: '版本、Vault 统计、日志位置' },
}

/** 数值偏好的持久化键。 */
export const SETTINGS_STORAGE_KEY = 'mimenote.settings.v1'
/** 上次停留分区的持久化键。 */
export const SETTINGS_SECTION_KEY = 'mimenote.settings.section'

/** 字号范围（px）。默认值与主题令牌 `--mn-font-size-ui` / `--mn-font-size-editor` 对齐。 */
export const UI_FONT_SIZE_RANGE = { min: 11, max: 18, step: 1 } as const
export const EDITOR_FONT_SIZE_RANGE = { min: 12, max: 28, step: 1 } as const
/**
 * 阅读视图字号范围。
 *
 * 为什么单独一项而不是跟着编辑器字号：**边写边看和纯阅读是两种姿势** ——
 * 写作时要在一屏里看到更多上下文（字号偏小），阅读时要的是舒适（字号偏大）。
 * 此前两者共用 `--mn-font-size-editor`，改一个必然动另一个（`--mn-font-size-reading`
 * 的默认值取编辑器默认值，所以不调它时观感与从前完全一致）。
 */
export const READING_FONT_SIZE_RANGE = { min: 12, max: 30, step: 1 } as const

/** 自动保存延迟的可选档位（ms）。默认 600ms，与 `note-store` 的默认值一致。 */
export const AUTOSAVE_DELAY_OPTIONS: readonly number[] = [200, 400, 600, 1000, 2000]
/** Tab 宽度的可选档位（字符数）。默认 4，与 CodeMirror 的 `EditorState.tabSize` 默认一致。 */
export const TAB_WIDTH_OPTIONS: readonly number[] = [2, 4, 8]

/** 可持久化的数值偏好 + 附件目录。 */
export interface SettingsValues {
  /** 界面字号（px）→ `--mn-font-size-ui`。 */
  uiFontSize: number
  /** 编辑器字号（px）→ `--mn-font-size-editor`。 */
  editorFontSize: number
  /** 阅读视图字号（px）→ `--mn-font-size-reading`（不设置时回落到编辑器字号）。 */
  readingFontSize: number
  /** 自动保存防抖延迟（ms）→ `configureAutosave({ delayMs })`。 */
  autosaveDelayMs: number
  /** Tab 宽度（字符数）→ `--mn-tab-size`。 */
  tabWidth: number
  /**
   * 编辑器是否显示**行号**（左侧那一栏 gutter）。
   *
   * 为什么默认开、而且要能关：行号对"跳到第 N 行""对着日志找位置"有用，
   * 但纯写作时那一栏是纯噪声（也占掉十几像素的正文宽度）。它属于"我怎么写"的偏好，
   * 因此与别的项一样跨 Vault 保存。
   */
  editorLineNumbers: boolean
  /**
   * 附件目录（**Vault 内的相对目录**，空串 = Vault 根）→ `attachment_save` 的 `dirRel`。
   *
   * 粘贴/拖入的图片落在这里（见 ADR-0013）。它与前面四项一样是**跨 Vault 的用户偏好**：
   * 值本身是相对的，换一个 Vault 仍然指向"那个 Vault 里的同名目录"。
   */
  attachmentDir: string
}

/*
 * 默认字号：**三档统一 16**（VI 规范第 2.3 节 / 用户诉求"整体默认字体统一 16 号"）。
 *
 * 这三个数才是**真值**：`features/settings/font-overrides.ts` 把它们写成 `<html>` 上的行内变量
 * 外加一条 `!important` 的作者样式，压过主题 JSON 与 `styles/app.css` 的 `:root`
 * （—— 那两处的 `--mn-font-size-*` 是兜底与"令牌清单完整性"用的，别在那边改默认值）。
 *
 * 老用户读的是**自己存下来的值**（localStorage），所以升级后不会被动变字号；
 * 设置页「外观」里的「恢复默认字号」就是按这三个数恢复。
 */
export const DEFAULT_SETTINGS: SettingsValues = {
  uiFontSize: 16,
  editorFontSize: 16,
  readingFontSize: 16,
  autosaveDelayMs: 600,
  tabWidth: 4,
  editorLineNumbers: true,
  attachmentDir: DEFAULT_ATTACHMENT_DIR,
}

export interface SettingsState extends SettingsValues {
  /** 设置页是否打开。**刻意不持久化**：重启后不该自己弹出一层模态。 */
  open: boolean
  section: SettingsSection

  openSettings: (section?: SettingsSection) => void
  closeSettings: () => void
  setSection: (section: SettingsSection) => void

  setUiFontSize: (px: number) => void
  setEditorFontSize: (px: number) => void
  /** 阅读视图字号（px）。 */
  setReadingFontSize: (px: number) => void
  setAutosaveDelayMs: (ms: number) => void
  setTabWidth: (width: number) => void
  /** 编辑器是否显示行号（即时生效：重配置 Compartment，不重建编辑器）。 */
  setEditorLineNumbers: (on: boolean) => void
  /** 附件目录（相对 Vault 根；空串 = Vault 根）。非法值会被归一化回默认值。 */
  setAttachmentDir: (dir: string) => void
  /** 三档字号一起恢复到默认值（见 `DEFAULT_SETTINGS` 上面那段）。 */
  resetFontSizes: () => void

  /** "关于"页的版本信息（`version_info`）。 */
  versionInfo: VersionInfo | null
  versionError: MimenoteError | null
  /** 读取版本信息（失败不抛，写进 `versionError` 由界面展示）。 */
  loadVersionInfo: () => Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * 把值吸附到最近的档位。
 *
 * 为什么不用 `clamp` 了事：这些值由 `<select>` 提供，若持久化里存着一个不在档位里的数
 * （手工改过 localStorage、或将来档位变了），下拉框会显示成空选中 —— 吸附到最近档位
 * 保证界面与生效值永远一致。
 */
function snapToOption(value: unknown, options: readonly number[], fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  let best = fallback
  let bestDistance = Number.POSITIVE_INFINITY
  for (const option of options) {
    const distance = Math.abs(option - value)
    if (distance < bestDistance) {
      bestDistance = distance
      best = option
    }
  }
  return best
}

function isSection(value: unknown): value is SettingsSection {
  return typeof value === 'string' && (SETTINGS_SECTIONS as readonly string[]).includes(value)
}

/** 从 localStorage 读回数值偏好（模块初始化时执行一次）。 */
function restoreValues(): SettingsValues {
  // 不用类型守卫：每个字段下面都会各自做"范围 + 档位"校验，形状对不对不影响安全
  const raw = loadJson<unknown>(SETTINGS_STORAGE_KEY, null)
  const saved = isRecord(raw) ? raw : {}
  return {
    uiFontSize: clampNumber(
      saved['uiFontSize'],
      UI_FONT_SIZE_RANGE.min,
      UI_FONT_SIZE_RANGE.max,
      DEFAULT_SETTINGS.uiFontSize,
    ),
    editorFontSize: clampNumber(
      saved['editorFontSize'],
      EDITOR_FONT_SIZE_RANGE.min,
      EDITOR_FONT_SIZE_RANGE.max,
      DEFAULT_SETTINGS.editorFontSize,
    ),
    readingFontSize: clampNumber(
      saved['readingFontSize'],
      READING_FONT_SIZE_RANGE.min,
      READING_FONT_SIZE_RANGE.max,
      DEFAULT_SETTINGS.readingFontSize,
    ),
    autosaveDelayMs: snapToOption(
      saved['autosaveDelayMs'],
      AUTOSAVE_DELAY_OPTIONS,
      DEFAULT_SETTINGS.autosaveDelayMs,
    ),
    tabWidth: snapToOption(saved['tabWidth'], TAB_WIDTH_OPTIONS, DEFAULT_SETTINGS.tabWidth),
    // 布尔偏好按"只有显式写了 false 才算关"读：老版本存下来的那份里没有这个字段，
    // 缺省必须是**开**（否则升级之后行号会悄悄消失）
    editorLineNumbers:
      typeof saved['editorLineNumbers'] === 'boolean'
        ? saved['editorLineNumbers']
        : DEFAULT_SETTINGS.editorLineNumbers,
    // 字符串偏好走**归一化**而不是"信它一次"：手工改过 localStorage、或从旧版本升上来时，
    // 一个非法的目录值会让之后每次粘贴都失败（宿主报 PATH_INVALID），而归一化把它挡在设置层
    attachmentDir:
      typeof saved['attachmentDir'] === 'string'
        ? normalizeAttachmentDir(saved['attachmentDir'])
        : DEFAULT_SETTINGS.attachmentDir,
  }
}

function restoreSection(): SettingsSection {
  const saved = loadString(SETTINGS_SECTION_KEY)
  return isSection(saved) ? saved : 'appearance'
}

/** 白名单式持久化：只写这几个标量（`open` / `versionInfo` 是瞬时状态，不入库）。 */
function persistValues(state: SettingsValues): void {
  saveJson(SETTINGS_STORAGE_KEY, {
    uiFontSize: state.uiFontSize,
    editorFontSize: state.editorFontSize,
    readingFontSize: state.readingFontSize,
    autosaveDelayMs: state.autosaveDelayMs,
    tabWidth: state.tabWidth,
    editorLineNumbers: state.editorLineNumbers,
    attachmentDir: state.attachmentDir,
  } satisfies SettingsValues)
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...restoreValues(),
  open: false,
  section: restoreSection(),

  openSettings: (section) => {
    // 不带参数时停在"上次看的分区"（store 初始化已读回），比每次回到第一页更贴近使用习惯
    const next = section ?? get().section
    set({ open: true, section: next })
    saveString(SETTINGS_SECTION_KEY, next)
  },

  closeSettings: () => {
    // 不调用 persistValues()：开关不是需要记住的偏好（同 paletteMode）
    set({ open: false })
  },

  setSection: (section) => {
    set({ section })
    saveString(SETTINGS_SECTION_KEY, section)
  },

  setUiFontSize: (px) => {
    set({
      uiFontSize: clampNumber(
        px,
        UI_FONT_SIZE_RANGE.min,
        UI_FONT_SIZE_RANGE.max,
        DEFAULT_SETTINGS.uiFontSize,
      ),
    })
    persistValues(get())
  },

  setEditorFontSize: (px) => {
    set({
      editorFontSize: clampNumber(
        px,
        EDITOR_FONT_SIZE_RANGE.min,
        EDITOR_FONT_SIZE_RANGE.max,
        DEFAULT_SETTINGS.editorFontSize,
      ),
    })
    persistValues(get())
  },

  setReadingFontSize: (px) => {
    set({
      readingFontSize: clampNumber(
        px,
        READING_FONT_SIZE_RANGE.min,
        READING_FONT_SIZE_RANGE.max,
        DEFAULT_SETTINGS.readingFontSize,
      ),
    })
    persistValues(get())
  },

  setAutosaveDelayMs: (ms) => {
    set({ autosaveDelayMs: snapToOption(ms, AUTOSAVE_DELAY_OPTIONS, DEFAULT_SETTINGS.autosaveDelayMs) })
    persistValues(get())
  },

  setTabWidth: (width) => {
    set({ tabWidth: snapToOption(width, TAB_WIDTH_OPTIONS, DEFAULT_SETTINGS.tabWidth) })
    persistValues(get())
  },

  setEditorLineNumbers: (on) => {
    set({ editorLineNumbers: on })
    persistValues(get())
  },

  setAttachmentDir: (dir) => {
    set({ attachmentDir: normalizeAttachmentDir(dir) })
    persistValues(get())
  },

  resetFontSizes: () => {
    set({
      uiFontSize: DEFAULT_SETTINGS.uiFontSize,
      editorFontSize: DEFAULT_SETTINGS.editorFontSize,
      readingFontSize: DEFAULT_SETTINGS.readingFontSize,
    })
    persistValues(get())
  },

  versionInfo: null,
  versionError: null,

  loadVersionInfo: async () => {
    try {
      // 组件不直接 invoke IPC（architecture.md §2 规则 5）：这一层就是"设置页的 store"
      const versionInfo = await ipc.versionInfo()
      set({ versionInfo, versionError: null })
    } catch (cause) {
      set({ versionError: MimenoteError.from(cause) })
    }
  },
}))
