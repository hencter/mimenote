/**
 * 设置页状态：分区导航 + 偏好值 + **Vault 配置文件**（ADR-0055）+ "关于"页要的版本信息。
 *
 * 为什么设置放**独立 store**（而不是塞进 `ui-store` 或组件内 state）：
 * 1. 打开设置的调用方不止设置页自己 —— 标题栏菜单、命令（`settings.open`）都要能打开它，
 *    `open` 因此是应用级状态，组件内 state 给不了它们；
 * 2. 偏好值的**生效点全在 React 之外**：自动保存延迟要喂给 `configureAutosave()`、
 *    字号要写进 `<html>` 的 CSS 变量、Tab 宽度要注入 `--mn-tab-size`。
 *    这些落点（`features/settings/*`）读的是 store，而不是某个组件的 props；
 * 3. 这些偏好是**跨 Vault 的用户偏好**，与 `ui-store` 同性质，但语义上不属于"界面布局"，
 *    合进去只会让它继续膨胀。
 *
 * ## 持久化（ADR-0055 之后是两层）
 *
 * - **Vault 配置文件** `<Vault>/.mimenote/config.<toml|yaml|json>`：**偏好值的真相**。
 *   换 Vault 就换一套偏好，而且它能被 git 管理 —— 这是"本地优先、文件即真相"该有的样子。
 * - **localStorage `mimenote.settings.v1`**：始终写一份**镜像**，但它只在两种情况下被**读**：
 *   ① **没有打开 Vault** 时（门闸页也要能改字号/主题）；
 *   ② **旧值迁移**：Vault 里还没有配置文件时，把这里的值写进新建的 `config.toml`。
 *   规矩只有一条：**配置文件存在时它赢**。镜像存在的意义是"打开 Vault 之前那一刻"的兜底，
 *   不是第二份真相。
 *
 * ## 为什么写盘要防抖
 *
 * 字号是滑杆驱动的：拖一次动几十个像素就是几十次 set。每次 set 都落一次盘
 * （原子写要 fsync）既慢又毫无意义；但也不能攒到退出再写（崩溃就丢）。
 * 300ms 的合并窗口是同一取舍下"手感"与"安全"的交点，与 `use-search.ts` 的防抖同源。
 */

import { create } from 'zustand'

import {
  CONFIG_SCHEMA_VERSION,
  hasConfigComments,
  parseConfigText,
  serializeConfigText,
  type ConfigFormat,
} from '@/domain/config-file'
import { DEFAULT_ATTACHMENT_DIR, normalizeAttachmentDir } from '@/domain/attachments'
import {
  DEFAULT_KEYMAP_PROFILE,
  normalizeOverrides,
  type KeymapOverrides,
  type KeymapProfileId,
} from '@/domain/keymap'
/** 收件箱目录：默认值与归一化**只有一份实现**（`domain/inbox.ts`）——
 *  设置层与收件箱判定必须用同一套口径，否则配置写成 `Inbox/x.` 这类值时，
 *  设置页显示的值与"哪些文件算收件箱"会不一致。 */
import { DEFAULT_INBOX_DIR, normalizeInboxDir } from '@/domain/inbox'
import { ipc } from '@/ipc/client'
import { MimenoteError } from '@/ipc/types'
import type { ConfigFileDto, VersionInfo } from '@/ipc/types'
import { loadJson, loadString, saveJson, saveString } from './persist'

/** 设置页的分区（左侧导航）。 */
export type SettingsSection = 'appearance' | 'editor' | 'keymap' | 'vault' | 'config' | 'about'

/** 全部设置页分区（顺序即导航顺序）。 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'appearance',
  'editor',
  'keymap',
  'vault',
  'config',
  'about',
]

export const SETTINGS_SECTIONS_META: Readonly<
  Record<SettingsSection, { label: string; description: string }>
> = {
  appearance: { label: '外观', description: '主题、界面字号、编辑器字号' },
  editor: { label: '编辑器', description: '自动保存延迟、Tab 宽度、行号' },
  keymap: { label: '键位', description: '档案与逐条覆盖（写进 Vault 配置）' },
  vault: { label: 'Vault', description: '附件目录、收件箱、模板、索引与缓存' },
  config: { label: '配置', description: '当前生效的配置文件与它的问题' },
  about: { label: '关于', description: '版本、Vault 统计、日志位置' },
}

/** 数值偏好的持久化键（**迁移来源**，见文件头）。 */
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

/** 文件树形态（ADR-0058；`stack` = 分栏的堆叠卡片画法）。 */
export type TreeLayout = 'single' | 'columns' | 'stack'

/** 文件树形态的展示元信息（设置页与命令共用一个判据）。 */
export const TREE_LAYOUT_META: Readonly<Record<TreeLayout, { label: string; description: string }>> = {
  single: { label: '单栏', description: '一棵可展开的树（现状）。窄侧栏里信息密度最高。' },
  columns: { label: '分栏（列视图）', description: '苹果 Finder 式逐列推进；不用展开/折叠，一路点到底。' },
  stack: {
    label: '堆叠卡片',
    description: '分栏列叠成卡片堆，左侧露边；横向滚动把叠在上面的卡片往右摊开。',
  },
}

/** 模板目录的默认值（ADR-0056）。 */
export const DEFAULT_TEMPLATES_DIR = '.mimenote/templates'

/** 可持久化的偏好值。 */
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
   * 但纯写作时那一栏是纯噪声（也占掉十几像素的正文宽度）。它属于"我怎么写"的偏好。
   */
  editorLineNumbers: boolean
  /**
   * 附件目录（**Vault 内的相对目录**，空串 = Vault 根）→ `attachment_save` 的 `dirRel`。
   *
   * 粘贴/拖入的图片落在这里（见 ADR-0013）。值本身是相对的，换一个 Vault 仍然指向
   * "那个 Vault 里的同名目录"——因此它进得去配置文件。
   */
  attachmentDir: string
  /**
   * frontmatter 时间挂钩（`created` / `updated`，见 ADR-0044）。
   *
   * 为什么默认关：打开后每次保存都会改写正文头两行（`updated` 刷新），
   * 不知情的用户会在 diff 里看到"没动过的地方变了"；而同步盘丢 mtime 的风险
   * 只存在于部分用户 —— 默认不替用户做决定。只读不写。
   */
  frontmatterTimestamps: boolean
  /** 文件树形态：单栏（默认）或分栏列视图（ADR-0058）。 */
  treeLayout: TreeLayout
  /** 收件箱目录（Vault 内相对目录，ADR-0057）。 */
  inboxDir: string
  /** 模板目录（Vault 内相对目录，ADR-0056）。 */
  templatesDir: string
  /** 键位档案（ADR-0055）：默认按人体工学排的 `mimenote`。 */
  keymapProfile: KeymapProfileId
  /** 键位用户覆盖：命令 id → 键位数组（**空数组 = 显式解绑**，键不存在 = 没配过）。 */
  keymapOverrides: KeymapOverrides
}

/*
 * 默认字号：**三档统一 16**（VI 规范第 2.3 节 / 用户诉求"整体默认字体统一 16 号"）。
 *
 * 这三个数才是**真值**：`features/settings/font-overrides.ts` 把它们写成 `<html>` 上的行内变量
 * 外加一条 `!important` 的作者样式，压过主题 JSON 与 `styles/tokens.css` 的 `:root`。
 *
 * 老用户读的是**自己存下来的值**，所以升级后不会被动变字号；
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
  frontmatterTimestamps: false,
  treeLayout: 'single',
  inboxDir: DEFAULT_INBOX_DIR,
  templatesDir: DEFAULT_TEMPLATES_DIR,
  keymapProfile: DEFAULT_KEYMAP_PROFILE,
  keymapOverrides: {},
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
  /** frontmatter 时间挂钩开关（只决定调宿主命令时带不带 `stampTimes`）。 */
  setFrontmatterTimestamps: (on: boolean) => void
  /** 附件目录（相对 Vault 根；空串 = Vault 根）。非法值会被归一化回默认值。 */
  setAttachmentDir: (dir: string) => void
  /** 三档字号一起恢复到默认值（见 `DEFAULT_SETTINGS` 上面那段）。 */
  resetFontSizes: () => void

  /** 文件树形态（ADR-0058）。 */
  setTreeLayout: (layout: TreeLayout) => void
  /** 收件箱目录（ADR-0057）。 */
  setInboxDir: (dir: string) => void
  /** 模板目录（ADR-0056）。 */
  setTemplatesDir: (dir: string) => void
  /** 切换键位档案（ADR-0055）。 */
  setKeymapProfile: (profile: KeymapProfileId) => void
  /** 覆盖一条命令的键位；`null` = 撤销覆盖、回到默认（与"解绑"是两件事）。 */
  setKeymapBinding: (commandId: string, chords: readonly string[] | null) => void
  /** 清掉所有键位覆盖（回到档案的原始形态）。 */
  resetKeymapBindings: () => void

  // ---- Vault 配置文件（ADR-0055）------------------------------------------
  /** 当前生效的配置文件（Vault 内相对路径）；`null` = 还没有配置文件。 */
  configPath: string | null
  /** 当前生效的格式；`null` = 还不知道（没有配置文件）。 */
  configFormat: ConfigFormat | null
  /** 当前 Vault 根（绝对路径）；`null` = 没有打开 Vault（只落 localStorage）。 */
  configRootPath: string | null
  /** 配置文件是否可写：含注释、或 version 比应用更新时为 `false`。 */
  configWritable: boolean
  /** 配置文件的问题（解析失败、字段类型不对、只读原因），在「配置」分区里如实展示。 */
  configIssues: readonly string[]
  /** Vault 打开后调用：读取（或首次迁移生成）配置文件。 */
  loadFromVault: (rootPath: string) => Promise<void>
  /** 重新读一遍当前 Vault 的配置文件（用户在外部改完之后用）。 */
  reloadConfig: () => Promise<void>
  /** 立刻落盘（跳过防抖）；换 Vault 与关窗口前用。 */
  writeConfigNow: () => Promise<void>

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
 * （手工改过配置文件、或将来档位变了），下拉框会显示成空选中 —— 吸附到最近档位
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

function isTreeLayout(value: unknown): value is TreeLayout {
  return value === 'single' || value === 'columns' || value === 'stack'
}

function isKeymapProfileId(value: unknown): value is KeymapProfileId {
  return value === 'mimenote' || value === 'obsidian' || value === 'vscode'
}

/**
 * Vault 内相对目录的归一化（附件目录 / 收件箱 / 模板目录共用）。
 *
 * 归一化而不是"信它一次"：非法值会让之后每一次相关操作都失败（宿主报 PATH_INVALID），
 * 而归一化把它挡在设置层 —— 用户看到的是"值被纠正了"，不是"功能坏了"。
 * 前导 `./`、多余的分隔符、结尾斜杠都吃掉；空串合法（表示 Vault 根）。
 */
export function normalizeVaultDir(input: string): string {
  const trimmed = input.trim().replace(/\\/g, '/')
  const withoutPrefix = trimmed.replace(/^(\.\/)+/, '')
  return withoutPrefix
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/')
}

/** 从 localStorage 读回偏好值（模块初始化时执行一次）—— 迁移来源，见文件头。 */
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
    // 布尔偏好按"只有显式写了对应值才算数"读（缺省走各自的默认值）
    editorLineNumbers:
      typeof saved['editorLineNumbers'] === 'boolean'
        ? saved['editorLineNumbers']
        : DEFAULT_SETTINGS.editorLineNumbers,
    // 字符串偏好走**归一化**而不是"信它一次"
    attachmentDir:
      typeof saved['attachmentDir'] === 'string'
        ? normalizeVaultDir(saved['attachmentDir']) === ''
          ? ''
          : normalizeAttachmentDir(saved['attachmentDir'])
        : DEFAULT_SETTINGS.attachmentDir,
    frontmatterTimestamps: saved['frontmatterTimestamps'] === true,
    treeLayout: isTreeLayout(saved['treeLayout']) ? saved['treeLayout'] : DEFAULT_SETTINGS.treeLayout,
    inboxDir:
      typeof saved['inboxDir'] === 'string'
        ? normalizeInboxDir(saved['inboxDir'])
        : DEFAULT_SETTINGS.inboxDir,
    templatesDir:
      typeof saved['templatesDir'] === 'string' && normalizeVaultDir(saved['templatesDir']) !== ''
        ? normalizeVaultDir(saved['templatesDir'])
        : DEFAULT_SETTINGS.templatesDir,
    keymapProfile: isKeymapProfileId(saved['keymapProfile'])
      ? saved['keymapProfile']
      : DEFAULT_SETTINGS.keymapProfile,
    keymapOverrides: normalizeOverrides(saved['keymapOverrides']),
  }
}

function restoreSection(): SettingsSection {
  const saved = loadString(SETTINGS_SECTION_KEY)
  return isSection(saved) ? saved : 'appearance'
}

/** 白名单式持久化：只写这几个标量（`open` / 配置状态是瞬时状态，不入库）。 */
function persistValues(state: SettingsValues): void {
  saveJson(SETTINGS_STORAGE_KEY, {
    uiFontSize: state.uiFontSize,
    editorFontSize: state.editorFontSize,
    readingFontSize: state.readingFontSize,
    autosaveDelayMs: state.autosaveDelayMs,
    tabWidth: state.tabWidth,
    editorLineNumbers: state.editorLineNumbers,
    attachmentDir: state.attachmentDir,
    frontmatterTimestamps: state.frontmatterTimestamps,
    treeLayout: state.treeLayout,
    inboxDir: state.inboxDir,
    templatesDir: state.templatesDir,
    keymapProfile: state.keymapProfile,
    keymapOverrides: state.keymapOverrides,
  } satisfies SettingsValues)
}

// ---------------------------------------------------------------------------
// 配置文件：文档形状与读回
// ---------------------------------------------------------------------------

/**
 * 偏好值 → 配置文档。
 *
 * 键名与结构就是设计文档 §2 的那张表；**这里是唯一生成它的地方**
 * （`domain/config-file.ts` 只管序列化格式，不管字段）。
 * 输出顺序固定：配置文件的 diff 应当只反映"值变了"，不该反映"键的顺序飘了"。
 */
export function configDocumentOf(values: SettingsValues): Record<string, unknown> {
  const bindings = Object.entries(values.keymapOverrides)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([command, chords]) => ({ command, chords: [...chords] }))

  return {
    version: CONFIG_SCHEMA_VERSION,
    keymap: {
      profile: values.keymapProfile,
      bindings,
    },
    ui: {
      fontSize: values.uiFontSize,
    },
    editor: {
      fontSize: values.editorFontSize,
      readingFontSize: values.readingFontSize,
      autosaveDelayMs: values.autosaveDelayMs,
      tabWidth: values.tabWidth,
      lineNumbers: values.editorLineNumbers,
      frontmatterTimestamps: values.frontmatterTimestamps,
    },
    tree: {
      layout: values.treeLayout,
    },
    vault: {
      attachmentDir: values.attachmentDir,
    },
    inbox: {
      dir: values.inboxDir,
    },
    templates: {
      dir: values.templatesDir,
    },
  }
}

interface AppliedConfig {
  values: SettingsValues
  issues: string[]
  /** `version` 比当前应用更新：只读，绝不写回（否则会抹掉新版本的字段）。 */
  versionNewer: boolean
}

/**
 * 配置文档 → 偏好值。
 *
 * **缺省即默认值**（不从 localStorage 兜底）：配置文件存在时它是唯一真相，
 * 把 localStorage 混进来会让"到底哪个值生效"变成一件需要推理的事。
 * 类型不对的字段：回退默认值 + 记一条 issue（在「配置」分区里如实展示），绝不静默吞掉。
 */
export function applyConfigDocument(raw: Record<string, unknown>): AppliedConfig {
  const issues: string[] = []
  const values: SettingsValues = { ...DEFAULT_SETTINGS }

  const version = raw['version']
  const versionNewer = typeof version === 'number' && version > CONFIG_SCHEMA_VERSION
  if (versionNewer) {
    issues.push(
      `配置文件的 version=${version} 比本应用支持的 ${CONFIG_SCHEMA_VERSION} 更新：本次只读，不会写回。`,
    )
  } else if (version !== undefined && typeof version !== 'number') {
    issues.push('version 应当是数字，已忽略。')
  }

  const keymap = groupOf(raw, 'keymap')
  if (isKeymapProfileId(keymap['profile'])) values.keymapProfile = keymap['profile']
  else if (keymap['profile'] !== undefined) issues.push(`keymap.profile 只能是 mimenote / obsidian / vscode，收到 ${JSON.stringify(keymap['profile'])}。`)
  const bindingsRaw = bindingsToRecord(keymap['bindings'], issues)
  const overrides = normalizeOverrides(bindingsRaw)
  const requested = Object.keys(bindingsRaw).length
  const accepted = Object.keys(overrides).length
  if (accepted < requested) issues.push(`keymap.bindings 里有 ${requested - accepted} 条格式不对（chords 应为字符串或字符串数组），已忽略。`)
  values.keymapOverrides = overrides

  const ui = groupOf(raw, 'ui')
  values.uiFontSize = readNumber(ui, 'fontSize', values.uiFontSize, issues, 'ui.fontSize', (value) =>
    clampNumber(value, UI_FONT_SIZE_RANGE.min, UI_FONT_SIZE_RANGE.max, values.uiFontSize),
  )

  const editor = groupOf(raw, 'editor')
  values.editorFontSize = readNumber(editor, 'fontSize', values.editorFontSize, issues, 'editor.fontSize', (value) =>
    clampNumber(value, EDITOR_FONT_SIZE_RANGE.min, EDITOR_FONT_SIZE_RANGE.max, values.editorFontSize),
  )
  values.readingFontSize = readNumber(editor, 'readingFontSize', values.readingFontSize, issues, 'editor.readingFontSize', (value) =>
    clampNumber(value, READING_FONT_SIZE_RANGE.min, READING_FONT_SIZE_RANGE.max, values.readingFontSize),
  )
  values.autosaveDelayMs = readNumber(editor, 'autosaveDelayMs', values.autosaveDelayMs, issues, 'editor.autosaveDelayMs', (value) =>
    snapToOption(value, AUTOSAVE_DELAY_OPTIONS, values.autosaveDelayMs),
  )
  values.tabWidth = readNumber(editor, 'tabWidth', values.tabWidth, issues, 'editor.tabWidth', (value) =>
    snapToOption(value, TAB_WIDTH_OPTIONS, values.tabWidth),
  )
  values.editorLineNumbers = readBoolean(editor, 'lineNumbers', values.editorLineNumbers, issues, 'editor.lineNumbers')
  values.frontmatterTimestamps = readBoolean(editor, 'frontmatterTimestamps', values.frontmatterTimestamps, issues, 'editor.frontmatterTimestamps')

  const tree = groupOf(raw, 'tree')
  if (isTreeLayout(tree['layout'])) values.treeLayout = tree['layout']
  else if (tree['layout'] !== undefined) {
    issues.push(`tree.layout 只能是 single / columns / stack，收到 ${JSON.stringify(tree['layout'])}。`)
  }

  const vault = groupOf(raw, 'vault')
  values.attachmentDir = readString(vault, 'attachmentDir', values.attachmentDir, issues, 'vault.attachmentDir', (value) =>
    normalizeVaultDir(value) === '' ? '' : normalizeAttachmentDir(value),
  )

  const inbox = groupOf(raw, 'inbox')
  // 收件箱目录的归一化只有一份实现（`domain/inbox.ts`）：非法/空值一律回退默认，
  // 因此这里不需要再判一次"空串该怎么办"
  values.inboxDir = readString(inbox, 'dir', values.inboxDir, issues, 'inbox.dir', (value) =>
    normalizeInboxDir(value),
  )

  const templates = groupOf(raw, 'templates')
  values.templatesDir = readString(templates, 'dir', values.templatesDir, issues, 'templates.dir', (value) =>
    normalizeVaultDir(value) === '' ? values.templatesDir : normalizeVaultDir(value),
  )

  return { values, issues, versionNewer }
}

function groupOf(raw: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = raw[name]
  return isRecord(value) ? value : {}
}

function readNumber(
  group: Record<string, unknown>,
  key: string,
  fallback: number,
  issues: string[],
  label: string,
  coerce: (value: number) => number,
): number {
  const value = group[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push(`${label} 应当是数字，已用默认值 ${fallback}。`)
    return fallback
  }
  return coerce(value)
}

function readBoolean(
  group: Record<string, unknown>,
  key: string,
  fallback: boolean,
  issues: string[],
  label: string,
): boolean {
  const value = group[key]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    issues.push(`${label} 应当是布尔值，已用默认值 ${String(fallback)}。`)
    return fallback
  }
  return value
}

function readString(
  group: Record<string, unknown>,
  key: string,
  fallback: string,
  issues: string[],
  label: string,
  coerce: (value: string) => string,
): string {
  const value = group[key]
  if (value === undefined) return fallback
  if (typeof value !== 'string') {
    issues.push(`${label} 应当是字符串，已用默认值 ${JSON.stringify(fallback)}。`)
    return fallback
  }
  return coerce(value)
}

/**
 * `keymap.bindings` 的两种写法都认：
 * - **规范写法**：`[{ command = "note.save", chords = ["Mod+S"] }]`（应用写出的形态，TOML 友好）；
 * - **顺手写法**：`{ "note.save" = ["Mod+S"] }`（手工编辑时更好敲）。
 *
 * 宽容读、严格写：解析两种，写回永远只有规范形态。
 */
function bindingsToRecord(raw: unknown, issues: string[]): Record<string, unknown> {
  if (Array.isArray(raw)) {
    const out: Record<string, unknown> = {}
    for (const entry of raw) {
      if (!isRecord(entry)) {
        issues.push('keymap.bindings 里有一项不是表（应为 command / chords）。')
        continue
      }
      const command = entry['command']
      if (typeof command !== 'string' || command.trim() === '') {
        issues.push('keymap.bindings 里有一项缺少 command。')
        continue
      }
      out[command.trim()] = entry['chords']
    }
    return out
  }
  if (isRecord(raw)) return raw
  if (raw !== undefined) issues.push('keymap.bindings 应当是表数组或表，已忽略。')
  return {}
}

// ---------------------------------------------------------------------------
// 落盘：localStorage 镜像 + 配置文件防抖写
// ---------------------------------------------------------------------------

/** 配置文件写入的合并窗口（见文件头"为什么写盘要防抖"）。 */
export const CONFIG_WRITE_DEBOUNCE_MS = 300

let writeTimer: ReturnType<typeof setTimeout> | null = null

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...restoreValues(),
  open: false,
  section: restoreSection(),

  configPath: null,
  configFormat: null,
  configRootPath: null,
  configWritable: true,
  configIssues: [],

  openSettings: (section) => {
    // 不带参数时停在"上次看的分区"（store 初始化已读回），比每次回到第一页更贴近使用习惯
    const next = section ?? get().section
    set({ open: true, section: next })
    saveString(SETTINGS_SECTION_KEY, next)
  },

  closeSettings: () => {
    // 不调用落盘：开关不是需要记住的偏好（同 paletteMode）
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
    schedulePersist(get())
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
    schedulePersist(get())
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
    schedulePersist(get())
  },

  setAutosaveDelayMs: (ms) => {
    set({ autosaveDelayMs: snapToOption(ms, AUTOSAVE_DELAY_OPTIONS, DEFAULT_SETTINGS.autosaveDelayMs) })
    schedulePersist(get())
  },

  setTabWidth: (width) => {
    set({ tabWidth: snapToOption(width, TAB_WIDTH_OPTIONS, DEFAULT_SETTINGS.tabWidth) })
    schedulePersist(get())
  },

  setEditorLineNumbers: (on) => {
    set({ editorLineNumbers: on })
    schedulePersist(get())
  },

  setFrontmatterTimestamps: (on) => {
    set({ frontmatterTimestamps: on })
    schedulePersist(get())
  },

  setAttachmentDir: (dir) => {
    set({ attachmentDir: normalizeAttachmentDir(dir) })
    schedulePersist(get())
  },

  resetFontSizes: () => {
    set({
      uiFontSize: DEFAULT_SETTINGS.uiFontSize,
      editorFontSize: DEFAULT_SETTINGS.editorFontSize,
      readingFontSize: DEFAULT_SETTINGS.readingFontSize,
    })
    schedulePersist(get())
  },

  setTreeLayout: (layout) => {
    set({ treeLayout: layout })
    schedulePersist(get())
  },

  setInboxDir: (dir) => {
    set({ inboxDir: normalizeInboxDir(dir) })
    schedulePersist(get())
  },

  setTemplatesDir: (dir) => {
    const normalized = normalizeVaultDir(dir)
    set({ templatesDir: normalized === '' ? DEFAULT_SETTINGS.templatesDir : normalized })
    schedulePersist(get())
  },

  setKeymapProfile: (profile) => {
    set({ keymapProfile: profile })
    schedulePersist(get())
  },

  setKeymapBinding: (commandId, chords) => {
    const current = get().keymapOverrides
    const next: Record<string, readonly string[]> = { ...current }
    if (chords === null) delete next[commandId]
    else next[commandId] = [...chords]
    set({ keymapOverrides: next })
    schedulePersist(get())
  },

  resetKeymapBindings: () => {
    set({ keymapOverrides: {} })
    schedulePersist(get())
  },

  loadFromVault: async (rootPath) => {
    // 换 Vault 之前先把上一个 Vault 待写的内容落定：防抖窗口里换库会丢掉最后一次修改
    await flushPendingWrite(get())
    set({
      configRootPath: rootPath,
      configPath: null,
      configFormat: null,
      configWritable: true,
      configIssues: [],
    })
    await get().reloadConfig()
  },

  reloadConfig: async () => {
    const rootPath = get().configRootPath
    if (rootPath === null) return

    let read: ConfigFileDto
    try {
      read = await ipc.configRead()
    } catch (cause) {
      set({ configIssues: [MimenoteError.from(cause).message], configWritable: false })
      return
    }

    if (read.path === null || read.content === null || read.format === null) {
      // 没有配置文件 → **迁移**：把当前值（默认值 ∪ localStorage 旧值）写成 config.toml。
      // 这是 localStorage 唯一一次被"搬进"配置文件的时机，之后它只作为"没打开 Vault 时"的兜底。
      set({ configFormat: 'toml' })
      await get().writeConfigNow()
      return
    }

    const parsed = parseConfigText(read.content, read.format)
    if (!parsed.ok) {
      // 解析失败：**保持当前值不变**，把错误原样交给「配置」分区。
      // 悄悄回退默认值会让用户以为"我的配置没生效"却不知道为什么。
      set({
        configPath: read.path,
        configFormat: read.format,
        configWritable: false,
        configIssues: [parsed.message],
      })
      return
    }

    const applied = applyConfigDocument(parsed.value)
    const hasComments = hasConfigComments(read.content, read.format)
    const issues = [...applied.issues]
    if (hasComments) issues.push('这份配置文件里有注释：应用不会改写它（改写会吃掉注释），请在源码中编辑。')
    if (applied.versionNewer && !issues.some((issue) => issue.startsWith('配置文件的 version='))) {
      issues.push('配置文件由更新的 Mimenote 写入：本次只读。')
    }

    set({
      ...applied.values,
      configPath: read.path,
      configFormat: read.format,
      configWritable: !hasComments && !applied.versionNewer,
      configIssues: issues,
    })
  },

  writeConfigNow: async () => {
    const rootPath = get().configRootPath
    if (rootPath === null) return
    if (!get().configWritable) return
    const format = get().configFormat ?? 'toml'
    const serialized = serializeConfigText(configDocumentOf(get()), format)
    if (!serialized.ok) {
      set({ configIssues: [serialized.message] })
      return
    }
    try {
      const outcome = await ipc.configWrite(format, serialized.text)
      set({ configPath: outcome.path, configFormat: format, configIssues: [] })
    } catch (cause) {
      set({ configIssues: [MimenoteError.from(cause).message] })
    }
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

/**
 * 一次偏好改动的落盘：localStorage 镜像（**始终**写）+ 配置文件防抖写（有 Vault 时）。
 *
 * 为什么 localStorage 仍然始终写一份镜像：它是**门闸页**（还没有打开 Vault）唯一可用的存储，
 * 而且模块初始化时读的就是它。真正的规矩只有一条：**配置文件存在时它赢** ——
 * 镜像只是"没有 Vault 这一刻"的兜底，不会覆盖配置文件里的值。
 * （反过来若"有 Vault 就不写镜像"，同一个进程里换过 Vault 之后门闸页就会开始丢设置。）
 */
function schedulePersist(state: SettingsState): void {
  persistValues(state)
  if (state.configRootPath === null) return
  if (writeTimer !== null) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    writeTimer = null
    void useSettingsStore.getState().writeConfigNow()
  }, CONFIG_WRITE_DEBOUNCE_MS)
}

/** 立刻落定待写的配置（换 Vault / 关窗口 / 测试里用）。 */
export async function flushPendingWrite(state?: SettingsState): Promise<void> {
  if (writeTimer !== null) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  const target = state ?? useSettingsStore.getState()
  if (target.configRootPath !== null) await target.writeConfigNow()
}
