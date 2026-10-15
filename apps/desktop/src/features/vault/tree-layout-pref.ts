/**
 * 文件树画法偏好（单栏 / 分栏 / 堆叠卡片）的**读取口与切换口**。
 *
 * 偏好本身由 `settings-store` 持有（`treeLayout: 'single' | 'columns' | 'stack'`，默认 `'single'`；
 * 见 ADR-0058 与 `docs/design/04-miller-columns.md` §7）。这里只做三件事：
 *
 * 1. **类型化 + 兜底**：把 store 上那个字段读成一个确定的联合类型。字段缺失、值不合法、
 *    或这份 `settings-store` 还没有落地它时，一律按 `'single'` 处理
 *    —— **升级上来的用户看到的树必须和原来一模一样**，所以"读不到"绝不能变成
 *    "分栏"或者崩溃；
 * 2. **订阅**：`useSyncExternalStore` 直接订阅 store，`getSnapshot` 返回一个字符串
 *    （引用比较的陷阱因此不存在）；
 * 3. **切换**：调 `settings-store` 的 `setTreeLayout`（`tree.toggleColumns` 命令与工具栏
 *    按钮都走这一条）—— 视图层不自己写偏好。三态循环：`single → columns → stack → single`。
 */

import { useSyncExternalStore } from 'react'

import { useSettingsStore, type SettingsState, type TreeLayout } from '@/state/settings-store'

export type TreeLayoutKind = TreeLayout

export const DEFAULT_TREE_LAYOUT: TreeLayoutKind = 'single'

/** 工具栏 / 命令循环顺序。 */
export const TREE_LAYOUT_CYCLE: readonly TreeLayoutKind[] = ['single', 'columns', 'stack']

/**
 * 编译期一致性检查：本模块的联合类型必须与 `settings-store` 的 `TreeLayout` 完全一致。
 *
 * 两边分叉（比如那边加了第四种画法）时 `TreeLayoutMatchesSettings` 会变成 `never`，
 * 而它被 `readTreeLayout` 的返回类型用着 —— 于是**类型检查当场报错**，
 * 比"界面上多了一种永远读不到的状态"便宜得多。
 */
export type TreeLayoutMatchesSettings = TreeLayoutKind extends SettingsState['treeLayout']
  ? SettingsState['treeLayout'] extends TreeLayoutKind
    ? true
    : never
  : never

/** 分栏族（横排列 / 堆叠卡片）共用列模型与键盘。 */
export function isColumnsFamily(layout: TreeLayoutKind): boolean {
  return layout === 'columns' || layout === 'stack'
}

/** 从一份 store 状态里读出画法（任何异常形状都退回默认值）。 */
export function readTreeLayout(state: unknown): TreeLayoutMatchesSettings extends true
  ? TreeLayoutKind
  : never {
  if (typeof state !== 'object' || state === null) return DEFAULT_TREE_LAYOUT
  const value = (state as Record<string, unknown>)['treeLayout']
  if (value === 'columns' || value === 'stack') return value
  return DEFAULT_TREE_LAYOUT
}

/** 当前画法的下一个（循环）。 */
export function nextTreeLayout(current: TreeLayoutKind): TreeLayoutKind {
  const index = TREE_LAYOUT_CYCLE.indexOf(current)
  const safe = index < 0 ? 0 : index
  return TREE_LAYOUT_CYCLE[(safe + 1) % TREE_LAYOUT_CYCLE.length] ?? DEFAULT_TREE_LAYOUT
}

/** 订阅 store（快照是字符串：`useSyncExternalStore` 的相等判断因此是值比较）。 */
function subscribe(onChange: () => void): () => void {
  return useSettingsStore.subscribe(onChange)
}

function snapshot(): TreeLayoutKind {
  return readTreeLayout(useSettingsStore.getState())
}

/**
 * 当前画法（响应 store 变化）。
 *
 * 快照函数返回的是字符串常量之一，所以"每次渲染都换一个新值"这种
 * `useSyncExternalStore` 经典死循环在这里不可能发生。
 */
export function useTreeLayout(): TreeLayoutKind {
  return useSyncExternalStore(subscribe, snapshot, () => DEFAULT_TREE_LAYOUT)
}

/** 单栏 → 分栏 → 堆叠 → 单栏（工具栏按钮与 `tree.toggleColumns` 命令共用这一条）。 */
export function toggleTreeLayout(): void {
  const state = useSettingsStore.getState()
  state.setTreeLayout(nextTreeLayout(readTreeLayout(state)))
}
