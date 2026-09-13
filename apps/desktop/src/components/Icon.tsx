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
} as const

export type IconName = keyof typeof PATHS

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName
  size?: number
  className?: string
}): JSX.Element {
  const paths = PATHS[name]
  return (
    <svg
      className={className === undefined ? 'mn-icon' : `mn-icon ${className}`}
      width={size}
      height={size}
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
