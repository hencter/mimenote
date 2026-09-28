/**
 * 图标集（Iconify 构建期打包 + lucide 字形，见 ADR-0043）。
 *
 * 为什么不再手写 SVG 路径：35 个图标的手绘路径是"能用但不优雅" —— 笔画粗细、
 * 圆角、光学对齐全凭手感，lucide 是专业画过的同一套（24 网格、圆线帽、统一留白）。
 * 打包方式是构建期（`unplugin-icons` + `@iconify-json/lucide`，devDependencies）：
 * 用到的图标在 `vite build` 时编进包，运行时零网络 —— 离线与 CSP 都不受影响；
 * 不用 Iconify 运行时 CDN（那需要出站请求，与"默认离线"直接冲突）。
 *
 * 不变的东西（调用方与测试都不用改）：
 * - `IconName` 仍是联合类型，名字沿用旧名（`trash` 等个别字形换了画法，名字不变）；
 * - `ICON_SIZES` 五档刻度与 `--icon-*` 令牌的对应关系不变（ADR-0033 的两道闸还在）；
 * - `stroke: currentColor` 跟随主题，`mn-icon` 类名保留。
 */

import type { JSX } from 'react'

import LucideAlert from '~icons/lucide/triangle-alert'
import LucideCalendar from '~icons/lucide/calendar'
import LucideCheck from '~icons/lucide/check'
import LucideChevron from '~icons/lucide/chevron-right'
import LucideClock from '~icons/lucide/clock'
import LucideColumns from '~icons/lucide/columns-2'
import LucideDot from '~icons/lucide/dot'
import LucideEye from '~icons/lucide/eye'
import LucideFile from '~icons/lucide/file'
import LucideFolder from '~icons/lucide/folder'
import LucideFolderOpen from '~icons/lucide/folder-open'
import LucideHash from '~icons/lucide/hash'
import LucideInfo from '~icons/lucide/info'
import LucideLink from '~icons/lucide/link'
import LucideList from '~icons/lucide/list'
import LucideMenu from '~icons/lucide/menu'
import LucideMove from '~icons/lucide/folder-input'
import LucideOutline from '~icons/lucide/list-tree'
import LucidePalette from '~icons/lucide/palette'
import LucidePanelLeft from '~icons/lucide/panel-left'
import LucidePencil from '~icons/lucide/pencil'
import LucidePlus from '~icons/lucide/plus'
import LucideRefresh from '~icons/lucide/refresh-cw'
import LucideSave from '~icons/lucide/save'
import LucideSearch from '~icons/lucide/search'
import LucideSettings from '~icons/lucide/settings'
import LucideSidebarRight from '~icons/lucide/panel-right'
import LucideSort from '~icons/lucide/arrow-up-down'
import LucideSparkle from '~icons/lucide/sparkle'
import LucideTag from '~icons/lucide/tag'
import LucideTrash from '~icons/lucide/trash'
import LucideType from '~icons/lucide/type'
import LucideX from '~icons/lucide/x'

/**
 * 名字 → lucide 字形。名字是本项目的稳定契约（调用点与测试只认它），
 * 右边是具体的画法：觉得某个画得不好，换右边的映射即可，不用动调用方。
 */
const GLYPHS = {
  folder: LucideFolder,
  folderOpen: LucideFolderOpen,
  file: LucideFile,
  hash: LucideHash,
  chevron: LucideChevron,
  search: LucideSearch,
  plus: LucidePlus,
  trash: LucideTrash,
  refresh: LucideRefresh,
  columns: LucideColumns,
  eye: LucideEye,
  pencil: LucidePencil,
  palette: LucidePalette,
  info: LucideInfo,
  alert: LucideAlert,
  calendar: LucideCalendar,
  x: LucideX,
  panelLeft: LucidePanelLeft,
  check: LucideCheck,
  clock: LucideClock,
  save: LucideSave,
  links: LucideLink,
  list: LucideList,
  sparkle: LucideSparkle,
  dot: LucideDot,
  sidebarRight: LucideSidebarRight,
  menu: LucideMenu,
  settings: LucideSettings,
  type: LucideType,
  // "移动"：文件夹 + 进入箭头（工具栏的「移动到文件夹…」按钮用）
  move: LucideMove,
  // "大纲"：标题层级树（面板头的图标；标签面板头仍用品牌闪点，不改）
  outline: LucideOutline,
  // "排序"：升降双向箭头，文件树工具栏的排序菜单入口用
  sort: LucideSort,
  // "标签"：斜挂牌（模块标签页的图标；标签面板头仍用品牌闪点，不改）
  tag: LucideTag,
} as const

export type IconName = keyof typeof GLYPHS

/**
 * 图标尺寸**刻度**（ADR-0033）。
 *
 * 为什么不是一个裸数字：这个仓库曾经有 78 个调用点、9 种字面尺寸（11/12/13/14/15/16/18/22/26），
 * 于是"同一个地方的两个图标差 1px"这种事谁也发现不了 —— 用户报的就是这条。
 * 现在 `size` 是**联合类型**，写刻度外的数字**编译不过**；刻度本身与 VI 规范对齐：
 * 24×24 网格、输出 16/20/24，外加密集处需要的两档（12/14）。
 *
 * 五档的用法（照着它挑，不要凭手感）：
 * - `xs` 12：密集处 —— 树行/页签里的图标、页签与面板头的关闭、状态点一类；
 * - `sm` 14：常规控件 —— 面板头、工具条按钮；
 * - `md` 16：默认档 —— 工具栏、正文级、对话框里的动作图标；
 * - `lg` 20：空状态与提醒 —— 对话框的警示图标、编辑器占位里的文件图标；
 * - `xl` 24：整块插画级的空态（例如门闸页的品牌图标）。
 *
 * ⚠️ 两类图标**不走**这把尺子，它们按字号走（`em`）：callout 的字形图标
 * （`.mn-callout__icon` / `.mn-md-callout-glyph`）与编辑器行内的 `✓` ——
 * 那些是**文字**，跟着正文字号缩放才对。
 */
export const ICON_SIZES = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
  xl: 24,
} as const

export type IconSize = keyof typeof ICON_SIZES

export function Icon({
  name,
  size = 'md',
  className,
}: {
  name: IconName
  size?: IconSize
  className?: string
}): JSX.Element {
  const pixels = ICON_SIZES[size]
  const Glyph = GLYPHS[name]
  return (
    <Glyph
      className={className === undefined ? 'mn-icon' : `mn-icon ${className}`}
      width={pixels}
      height={pixels}
      // lucide 默认 2px 偏粗：1.6 与旧手绘一致，细笔画才有"气"
      strokeWidth={1.6}
      aria-hidden="true"
      focusable="false"
    />
  )
}
