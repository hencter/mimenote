/** 图标集（内联 SVG，无图标依赖；`stroke: currentColor` 以跟随主题）。 */

import type { JSX } from 'react'

const PATHS = {
  folder: ['M3 7.5A2 2 0 0 1 5 5.5h3.2l1.6 2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  folderOpen: [
    'M3 7.5A2 2 0 0 1 5 5.5h3.2l1.6 2H19a2 2 0 0 1 2 2v1H3z',
    'M3 10.5h18l-1.8 6.2a2 2 0 0 1-1.9 1.3H5.7a2 2 0 0 1-1.9-1.3z',
  ],
  file: ['M6 3.5h7.5L18 8v12.5H6z', 'M13.5 3.5V8H18'],
  chevron: ['M9.5 6l6 6-6 6'],
  search: ['M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M20 20l-4-4'],
  plus: ['M12 5.5v13', 'M5.5 12h13'],
  trash: ['M4.5 7h15', 'M9.5 11v6', 'M14.5 11v6', 'M6.5 7l.9 12.5h9.2L17.5 7', 'M9.5 7V4.5h5V7'],
  refresh: ['M20 12a8 8 0 1 1-2.4-5.7', 'M20 4.5V9h-4.5'],
  columns: ['M4 5.5h16v13H4z', 'M12 5.5v13'],
  eye: [
    'M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z',
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  ],
  pencil: ['M4 20h4l10.5-10.5-4-4L4 16z', 'M14.5 5.5l4 4'],
  palette: [
    'M12 3.5a8.5 8.5 0 1 0 0 17h1.8a1.9 1.9 0 0 0 0-3.8h-.9a1.9 1.9 0 0 1 0-3.8h3.6a2 2 0 0 0 2-2A8.6 8.6 0 0 0 12 3.5z',
    'M8 9.5h.01',
    'M8 13.5h.01',
  ],
  info: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M12 11v5.5', 'M12 8h.01'],
  alert: ['M12 4l8.5 15.5h-17z', 'M12 10v5', 'M12 18h.01'],
  x: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
  panelLeft: ['M4 5.5h16v13H4z', 'M10 5.5v13'],
  check: ['M5 12.5l4.5 4.5L19 7'],
  save: ['M5 5.5h11L19 8.5v10H5z', 'M9 5.5v5h6v-5', 'M9 18.5v-5h6v5'],
  links: [
    'M10.5 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7l-1.1 1.1',
    'M13.5 10.5a4 4 0 0 0-5.7 0l-2.3 2.3a4 4 0 0 0 5.7 5.7l1.1-1.1',
  ],
  sparkle: ['M12 4l1.7 4.6L18.5 10l-4.8 1.4L12 16l-1.7-4.6L5.5 10l4.8-1.4z'],
  dot: ['M12 12h.01'],
  sidebarRight: ['M4 5.5h16v13H4z', 'M14 5.5v13'],
  // 以下为设置页与标题栏菜单新增（不改动上面任何既有条目）
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  settings: [
    'M4 8h15.5',
    'M4 16h15.5',
    'M9.5 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z',
    'M15 14.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z',
  ],
  type: ['M5 7.5V5.5h14v2', 'M9.5 18.5h5', 'M12 5.5v13'],
  // "移动"：一个文件夹 + 指向文件夹内部的箭头（工具栏的「移动到文件夹…」按钮用）
  move: [
    'M4 7.5A2 2 0 0 1 6 5.5h3.2l1.6 2H18a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z',
    'M8.5 13.5h6',
    'M12 11l2.5 2.5L12 16',
  ],
  // "大纲"：长短不一的横线（标题层级），最上面一条最短 = 一级标题
  outline: ['M4 6.5h8', 'M7 12h11', 'M10 17.5h8'],
  // "排序"：两支反向箭头（左升右降），文件树工具栏的排序菜单入口用
  sort: ['M7 4.5v14', 'M4 8l3-3.5L10 8', 'M17 19.5v-14', 'M14 16l3 3.5 3-3.5'],
} as const

export type IconName = keyof typeof PATHS

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
  const paths = PATHS[name]
  return (
    <svg
      className={className === undefined ? 'mn-icon' : `mn-icon ${className}`}
      width={pixels}
      height={pixels}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}
