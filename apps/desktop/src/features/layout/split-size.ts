/**
 * 模块被切出去**独占一格**时的默认尺寸（ADR-0035 渲染层的观感判据）。
 *
 * 为什么需要它：`moveItem` 的切割永远给 0.5 比例 —— 拖拽时这没问题（用户接着拖分隔条），
 * 但键盘搬运（`Alt+1/2/3`）与"放到边缘"都该直接给出一个**像样的默认大小**：
 * 否则"Alt+1 把文件树搬回左侧"的结果是它占掉半个窗口（旧停靠区的默认是 288px）。
 *
 * 这里的像素值就是旧停靠区的默认尺寸（`ui-store` 的 `DEFAULTS`）：迁移只发生一次、
 * 而键盘搬运是日常动作，两者口径一致，用户感受不到"换了一套布局模型"。
 *
 * 纯函数：像素矩形由调用方量（UI 层），这里只算比例。
 */

import {
  clampRatioForExtent,
  isViewModule,
  leafOfItem,
  setRatio,
  type LayoutItemId,
  type TreeLayout,
  type ViewModuleId,
} from './tree-layout'
import type { DropEdge } from './drop-target'

/** 每个模块的"家"尺寸（px）：row 切割看宽度、column 切割看高度。 */
export const MODULE_HOME_PX: Readonly<Record<ViewModuleId, { width: number; height: number }>> = {
  tree: { width: 288, height: 220 },
  links: { width: 300, height: 220 },
  tags: { width: 300, height: 220 },
  outline: { width: 300, height: 220 },
}

/**
 * 新那一刀该用的比例（`setRatio` 的入参 = **前半**的占比）。
 *
 * - `extentPx` 是**被切那一格**在切割方向上的像素尺寸（调用方量；量不到 → `null`，
 *   调用方保持 0.5 不动）；
 * - 模块落在前半（左/上）⇒ 比例就是它的份额；落在后半（右/下）⇒ 1 − 份额；
 * - 笔记没有"家尺寸"：返回 `null`（切两篇笔记的对半分是合理的起点）。
 */
export function preferredSplitRatio(
  item: LayoutItemId,
  edge: DropEdge,
  extentPx: number,
): number | null {
  if (!isViewModule(item) || !Number.isFinite(extentPx) || extentPx <= 0) return null
  const px = edge === 'left' || edge === 'right' ? MODULE_HOME_PX[item].width : MODULE_HOME_PX[item].height
  // 家尺寸也要过像素下限：被切的格子本身不大时，不能让新叶窄成废条（ADR-0035 后续修订）
  const share = clampRatioForExtent(px / extentPx, extentPx)
  return edge === 'left' || edge === 'top' ? share : 1 - share
}

/** 某个节点的父 split 的 id（它自己就是根时返回 `null`）。 */
export function parentSplitIdOf(layout: TreeLayout, nodeId: string): string | null {
  if (layout.kind === 'leaf') return null
  if (layout.a.id === nodeId || layout.b.id === nodeId) return layout.id
  return parentSplitIdOf(layout.a, nodeId) ?? parentSplitIdOf(layout.b, nodeId)
}

/**
 * 一次"切一刀"搬移（`moveItem` 带 `edge`）之后，把新那一刀的比例调成模块的家尺寸。
 *
 * 调用时机要在**搬完之后立刻**（同一个动作里）：`moveItem` 给的是 0.5，
 * 这里按"被切那一格在切割方向上的像素尺寸"换算出模块该有的份额。
 * 量不到尺寸 / 移的是笔记 / 结构上没有新刀 → 原样返回（保持 0.5）。
 */
export function adjustNewSplitRatio(args: {
  layout: TreeLayout
  item: LayoutItemId
  edge: DropEdge
  extentPx: number
}): TreeLayout {
  const ratio = preferredSplitRatio(args.item, args.edge, args.extentPx)
  if (ratio === null) return args.layout
  const leaf = leafOfItem(args.layout, args.item)
  if (leaf === null) return args.layout
  const splitId = parentSplitIdOf(args.layout, leaf.id)
  if (splitId === null) return args.layout
  return setRatio(args.layout, splitId, ratio)
}
