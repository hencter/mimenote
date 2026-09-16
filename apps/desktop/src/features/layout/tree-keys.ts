/**
 * 容器切割树的**键盘等价物**（ADR-0035：拖拽之外的第二条路，可访问性要求）。
 *
 * 键位是旧停靠模型那一套（`Alt+1/2/3` + `Alt+方向键`，见 `features/dock/dock-layout.ts`
 * 的历史版本）在树上的对应物：
 *
 * | 按键 | 语义 |
 * | --- | --- |
 * | `Alt+1 / 2 / 3` | 把聚焦的标签搬到**主叶的左 / 右 / 下方**（主叶 = 笔记默认住的那一格） |
 * | `Alt+← / →` | 在同一格的标签条里前移 / 后移一位 |
 *
 * 两条刻意的收窄：
 * - `Alt+↑ / ↓` 无操作：旧模型里它管"竖排区内的上下移动"，而树上所有标签条都是横排的，
 *   上下两个方向没有对应物，留给将来"在上下相邻叶子之间搬移"也不迟；
 * - 已经在主叶对应侧（**独占一格**、且那格正是主叶在该侧的兄弟）时 `Alt+数字` 返回 `null` ——
 *   不拦的话每按一次就会在主叶上再切一刀，主叶被越切越窄（旧模型里"已经在那一区"也是无操作）。
 *
 * 返回 `null` 表示"这次按键不改变任何东西"，调用方据此决定要不要 `preventDefault`
 * （不该吞掉没用的按键）。
 */

import {
  attachItem,
  DEFAULT_MAIN_LEAF_ID,
  findLeaf,
  leafOfItem,
  moveItem,
  type SplitAxis,
  type TreeLayout,
} from './tree-layout'
import type { LayoutItemId } from './tree-layout'

/** `Alt+数字` 与落点的对应：1 左、2 右、3 下（沿用旧停靠模型的肌肉记忆）。 */
const SIDE_BY_KEY: Readonly<Record<string, { edge: 'left' | 'right' | 'bottom'; axis: SplitAxis }>> = {
  'Alt+1': { edge: 'left', axis: 'row' },
  'Alt+2': { edge: 'right', axis: 'row' },
  'Alt+3': { edge: 'bottom', axis: 'column' },
}

/**
 * 这个标签是不是**已经**在主叶的对应侧（独占一格、那格是主叶在该侧 split 下的兄弟）。
 *
 * 这是 `Alt+数字` 的幂等闸（见文件头第二条收窄）。判据刻意很严：只要标签不是独占一格、
 * 或中间隔着别的 split，都算"不在"，照样执行搬运 —— 宽松会让"想搬却按了没反应"重现。
 */
function alreadyAtSide(layout: TreeLayout, item: LayoutItemId, mainId: string, axis: SplitAxis, before: boolean): boolean {
  const leaf = leafOfItem(layout, item)
  if (leaf === null || leaf.items.length !== 1) return false

  /** 找 `target` 的父 split（顺带知道它是前半还是后半）。 */
  const findParent = (
    node: TreeLayout,
    targetId: string,
  ): { parent: Extract<TreeLayout, { kind: 'split' }>; inA: boolean } | null => {
    if (node.kind === 'leaf') return null
    if (node.a.id === targetId) return { parent: node, inA: true }
    if (node.b.id === targetId) return { parent: node, inA: false }
    return findParent(node.a, targetId) ?? findParent(node.b, targetId)
  }

  const found = findParent(layout, leaf.id)
  if (found === null) return false
  const { parent, inA } = found
  if (parent.axis !== axis || inA !== before) return false
  // 另一半子树里得有主叶 —— 否则"它在主叶左边"这个说法本身就不成立
  return findLeaf(inA ? parent.b : parent.a, mainId) !== null
}

/**
 * 键盘搬运。`key` 的写法与 `dock-layout` 时代一致（`Alt+1`、`Alt+ArrowLeft`…），
 * 由调用方从 `KeyboardEvent` 拼出来。
 */
export function keyboardMoveItem(
  layout: TreeLayout,
  item: LayoutItemId,
  key: string,
): TreeLayout | null {
  const leaf = leafOfItem(layout, item)
  if (leaf === null) return null

  const side = SIDE_BY_KEY[key]
  if (side !== undefined) {
    const anchor = findLeaf(layout, DEFAULT_MAIN_LEAF_ID) ?? null
    if (anchor === null) return null
    const before = side.edge === 'left'
    if (alreadyAtSide(layout, item, anchor.id, side.axis, before)) return null
    return attachItem(layout, item, { leafId: anchor.id, edge: side.edge })
  }

  const delta = key === 'Alt+ArrowLeft' ? -1 : key === 'Alt+ArrowRight' ? 1 : 0
  if (delta === 0) return null
  const index = leaf.items.indexOf(item)
  const next = index + delta
  if (index < 0 || next < 0 || next >= leaf.items.length) return null
  // `moveItem` 的下标语义是"移除自己之后"的数组下标：前移用 next、后移也是 next
  // （移除后数组短一位，两种方向落在同一个下标语义上，由模型层保证不重复插入）
  return moveItem(layout, item, { leafId: leaf.id, index: next })
}

/** 键盘提示（标签的 tooltip 与无障碍名共用一份文案）。 */
export const LAYOUT_KEYBOARD_HINT = 'Alt+1/2/3 搬到主区左/右/下；Alt+←/→ 在标签条里换位置'
