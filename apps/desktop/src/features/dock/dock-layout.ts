/**
 * **旧落盘格式的读取面**（ADR-0026 的三区停靠，已被 ADR-0035 的容器切割树取代）。
 *
 * 这个文件现在只剩两个用途：
 *
 * 1. **迁移**：`ui-store` 恢复时，若 localStorage 里只有旧的 `dockLayout`，
 *    由 `features/layout/layout-sync.ts` 的 `migrateLayout` 转成切割树；
 * 2. **回滚可读**：`mimenote.ui.v1` 里的 `dockLayout` 键**不删** —— 回滚到旧版本时
 *    还能读到升级前那份布局。
 *
 * 因此这里只保留类型、缺省值与形状校验；操作面（搬移 / 键盘 / 落点下标）随渲染器
 * 一起退役，树的等价物在 `features/layout/tree-layout.ts`（操作）与
 * `features/layout/tree-keys.ts`（键盘）。
 */

/** 停靠区（三选一）。 */
export type DockSide = 'left' | 'right' | 'bottom'

/** 可以被停靠的视图模块。 */
export type DockModuleId = 'tree' | 'links' | 'tags' | 'outline'

export type DockLayout = Record<DockSide, readonly DockModuleId[]>

/** 全部停靠区（顺序即"从左到右、再到底部"）。 */
export const DOCK_SIDES: readonly DockSide[] = ['left', 'right', 'bottom']

/** 全部模块（校验与"每个模块恰好一次"的判据都用它）。 */
export const DOCK_MODULE_IDS: readonly DockModuleId[] = ['tree', 'links', 'tags', 'outline']

/**
 * 缺省停靠：**与引入停靠之前的界面逐像素一致** —— 文件树在左（可见），
 * 链接 / 标签 / 大纲在右（默认都收起）。
 *
 * 它现在同时是"没有任何旧配置时"的迁移种子：新用户的树由它转出来
 * （见 `ui-store` 的恢复逻辑），两边不一致时由 `layout-sync` 的单测钉住。
 */
export const DEFAULT_DOCK_LAYOUT: DockLayout = {
  left: ['tree'],
  right: ['links', 'tags', 'outline'],
  bottom: [],
}

/**
 * 形状 + 不变式校验：每个模块**恰好出现一次**。
 *
 * 校验会拒绝"同一个模块出现在两个区"的配置 —— 那会让它被渲染两遍。
 * 这种错误一旦落进 localStorage 就会一直复现，所以宁可整份退回默认。
 */
export function isDockLayout(value: unknown): value is DockLayout {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const seen = new Set<DockModuleId>()
  for (const side of DOCK_SIDES) {
    const list = record[side]
    if (!Array.isArray(list)) return false
    for (const item of list) {
      if (typeof item !== 'string' || !DOCK_MODULE_IDS.includes(item as DockModuleId)) return false
      // 同一个模块出现两次 = 会被渲染两遍，整份拒绝
      if (seen.has(item as DockModuleId)) return false
      seen.add(item as DockModuleId)
    }
  }
  return true
}
