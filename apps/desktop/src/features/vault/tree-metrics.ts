/**
 * 两种文件树画法共用的尺寸常量与**落点状态**换算。
 *
 * 放在一处是为了守住"虚拟化与拖拽反馈只有一套实现"这条纪律：行高（`ROW_HEIGHT`）是
 * `computeWindow` 的输入，单栏与分栏各写一个 30 只会让"某一种模式的行高悄悄不一样"
 * 变成可能；而 E2E 里那条"树行上下留白 ≥3px"的门禁正是按这个数算出来的。
 */

import type { DropTarget } from '@/domain/drag'
import type { RowDropState } from './TreeRow'

/** 每一行的固定高度（px）。**唯一来源**：改这一个数，滚动与可见行数都自己跟上。 */
export const ROW_HEIGHT = 30
/** 视口上下各多渲染的行数：吸收快速滚动时的空白。 */
export const OVERSCAN = 10
/**
 * 尚未测量出视口高度时的兜底值。
 *
 * 首帧渲染时容器高度可能还是 0（尚未布局 / 被隐藏 / 测试环境没有布局引擎）。
 * 直接用 0 去算窗口就只会渲染 overscan 那几行，看起来像"文件树空的"。
 * 只影响**首次**渲染，ResizeObserver 一触发就被真实高度替代。
 */
export const FALLBACK_VIEWPORT_HEIGHT = 640

/**
 * 这个元素是不是当前落点（是就画 valid/invalid 的样式，否则原样）。
 *
 * 单栏传行的 `relPath`，分栏传列的目录路径（列本身也是一个落点）—— 判据是同一条：
 * **谁等于 `hostRelPath`，谁就画落点**（`domain/drag.ts` 的 `sameDropTarget` 也是按它判重的）。
 */
export function dropStateOf(dropTarget: DropTarget | null, hostRelPath: string): RowDropState {
  if (dropTarget === null || dropTarget.hostRelPath !== hostRelPath) return 'none'
  return dropTarget.dataState
}
