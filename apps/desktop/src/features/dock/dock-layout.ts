/**
 * 视图模块的**停靠模型**（纯函数，不含 React）。
 *
 * 用户原话是「每个视图模块要做到在整个编辑器中可以拖拽到任意区域占位」。这里的"视图模块"
 * 是左侧栏那几块可停靠的面板：文件树 / 链接 / 标签 / 大纲。模型做成**三个停靠区**
 * （左、右、底）+ 每个区域内一排模块：
 *
 * ```
 * ┌──────────┬────────────────────────────┬──────────┐
 * │ 左停靠区 │        主区域（编辑器）     │ 右停靠区 │
 * │          ├────────────────────────────┤          │
 * │          │        底部停靠区           │          │
 * └──────────┴────────────────────────────┴──────────┘
 * ```
 *
 * 为什么是"三个区 + 区内顺序"而不是"任意坐标的浮窗"：这一层要解决的是"**位置**"，
 * 而窗格布局（自由拖动、任意分格）是一个二三十倍大的系统（尺寸记忆、最小尺寸、嵌套分栏、
 * 相机复位…）。三个区已经覆盖"放左边还是右边还是下边"这个真实诉求，
 * 而每个区内的顺序用拖拽/键盘都能改。
 *
 * ## 只存"位置"，不存"可见性"
 *
 * 可见性仍然留在各自的既有开关上（文件树 = `sidebarVisible`、链接 = `linksPanelVisible`、
 * 大纲 = `outlinePanelVisible`、标签 = tags-store 的 `open`）—— `Ctrl+B` / `Ctrl+Shift+L` /
 * `Ctrl+Shift+T` / `Ctrl+Shift+O` 四条快捷键因此一字不用改，且"哪块面板开着"只有一个真相。
 * 这一层只回答"它开在哪儿"。
 *
 * ## 不变式：每个模块**恰好出现一次**
 *
 * 校验（{@link isDockLayout}）会拒绝"同一个模块出现在两个区"的配置 —— 那会让它被渲染两遍，
 * 而两遍的 DOM 都带 `data-dock-module` 与相同的 id，后续任何按 id 查询的代码都会拿到第一个。
 * 这种错误一旦落进 localStorage 就会一直复现，所以宁可整份退回默认。
 */

/** 停靠区（三选一）。 */
export type DockSide = 'left' | 'right' | 'bottom'

/** 可以被停靠的视图模块。 */
export type DockModuleId = 'tree' | 'links' | 'tags' | 'outline'

export type DockLayout = Record<DockSide, readonly DockModuleId[]>

/** 全部停靠区（顺序即"从左到右、再到底部"，与 `Alt+1/2/3` 一一对应）。 */
export const DOCK_SIDES: readonly DockSide[] = ['left', 'right', 'bottom']

/** 模块元信息（标题头与菜单上给人看的字）。 */
export const DOCK_MODULES: Readonly<Record<DockModuleId, { label: string; hint: string }>> = {
  tree: { label: '文件', hint: '文件树（Vault 的目录与笔记）' },
  links: { label: '链接', hint: '反向链接与出链' },
  tags: { label: '标签', hint: '本篇标签、属性与全库标签' },
  outline: { label: '大纲', hint: '当前笔记的标题树' },
}

/** 全部模块（校验与"每个模块恰好一次"的判据都用它）。 */
export const DOCK_MODULE_IDS: readonly DockModuleId[] = ['tree', 'links', 'tags', 'outline']

/**
 * 缺省停靠：**与引入停靠之前的界面逐像素一致** —— 文件树在左（可见），
 * 链接 / 标签 / 大纲在右（默认都收起，顺序与从前 `.mn-body` 里三块面板的排列一致）。
 */
export const DEFAULT_DOCK_LAYOUT: DockLayout = {
  left: ['tree'],
  right: ['links', 'tags', 'outline'],
  bottom: [],
}

/** 形状 + 不变式校验（见文件头）。 */
export function isDockLayout(value: unknown): value is DockLayout {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const seen = new Set<DockModuleId>()
  for (const side of DOCK_SIDES) {
    const list = record[side]
    if (!Array.isArray(list)) return false
    for (const item of list) {
      if (typeof item !== 'string' || !DOCK_MODULE_IDS.includes(item as DockModuleId)) return false
      // 同一个模块出现两次 = 会被渲染两遍（见文件头），整份拒绝
      if (seen.has(item as DockModuleId)) return false
      seen.add(item as DockModuleId)
    }
  }
  return true
}

/** 某个模块此刻在哪个区（没出现过时 `null`：调用方据此决定要不要兜底）。 */
export function sideOfModule(layout: DockLayout, id: DockModuleId): DockSide | null {
  for (const side of DOCK_SIDES) {
    if (layout[side].includes(id)) return side
  }
  return null
}

/**
 * 把模块搬到 `side` 的第 `index` 位（`index` 缺省 = 追加到末尾）。
 *
 * 索引的语义是"**移除之后**的目标数组下标"：同一区内上下移动时，调用方只要给
 * `currentIndex ± 1` 就够了，不必自己处理"先删后插导致的下标漂移"。
 * 越界会被夹进合法范围（拖到空白处的落点常常是一个略大的数）。
 */
export function moveDockModule(
  layout: DockLayout,
  id: DockModuleId,
  side: DockSide,
  index?: number,
): DockLayout {
  const without: DockLayout = {
    left: layout.left.filter((item) => item !== id),
    right: layout.right.filter((item) => item !== id),
    bottom: layout.bottom.filter((item) => item !== id),
  }
  const target = [...without[side]]
  const at = index === undefined ? target.length : Math.min(Math.max(0, index), target.length)
  target.splice(at, 0, id)
  return { ...without, [side]: target }
}

/**
 * 拖拽落点 → 插入下标。
 *
 * `centers` 是**同侧现有模块**在拖拽轴上的中线坐标（竖排用 y、横排用 x），
 * `value` 是指针在那条轴上的位置。判据是"落在哪个模块的前半段就插在它前面" ——
 * 比"按间隙判定"少一次边界特判，指针在任何位置上都有确定答案。
 */
export function insertionIndexFor(centers: readonly number[], value: number): number {
  for (let index = 0; index < centers.length; index += 1) {
    const center = centers[index]
    if (center !== undefined && value < center) return index
  }
  return centers.length
}

/**
 * 键盘等价物（拖拽之外的第二条路，可访问性要求）。
 *
 * 键位规则只有两条，都好记：
 * - `Alt+1/2/3` = **搬到** 左 / 右 / 底部（"放哪儿"只有三个答案，用数字最直白）；
 * - `Alt+↑/↓`（左/右区内）与 `Alt+←/→`（底部区内）= 在**同一区里**前移/后移。
 *
 * 返回 `null` 表示"这次按键不改变任何东西"（已经在第一个还想往前、或按了没定义的组合），
 * 调用方据此决定要不要 `preventDefault`（不该吞掉没用的按键）。
 */
export function keyboardMove(
  layout: DockLayout,
  id: DockModuleId,
  key: string,
): DockLayout | null {
  const side = sideOfModule(layout, id)
  if (side === null) return null

  const destination = DOCK_SIDES.find((_, index) => key === `Alt+${index + 1}`)
  if (destination !== undefined) {
    if (destination === side) return null
    return moveDockModule(layout, id, destination)
  }

  const axis: readonly string[] = side === 'bottom' ? ['Alt+ArrowLeft', 'Alt+ArrowRight'] : ['Alt+ArrowUp', 'Alt+ArrowDown']
  const delta = key === axis[0] ? -1 : key === axis[1] ? 1 : 0
  if (delta === 0) return null
  const index = layout[side].indexOf(id)
  const next = index + delta
  if (index < 0 || next < 0 || next >= layout[side].length) return null
  return moveDockModule(layout, id, side, next)
}

/** 键盘提示（标题头的 tooltip 与无障碍名共用一份文案）。 */
export const DOCK_KEYBOARD_HINT = 'Alt+1/2/3 搬到左/右/底部；同区内 Alt+方向键换位置'
