/**
 * 固定行高虚拟列表的窗口计算（纯函数）。
 *
 * 为什么自己写而不引三方库：逻辑只有几十行，且**必须有单测**
 * （见 `tests/virtual-list.test.ts`）。虚拟化是"文件树滚动稳定 60fps"的结构性保证：
 * 无论 1 万还是 10 万条目，DOM 中只存在可视行 + overscan。
 */

export interface WindowInput {
  scrollTop: number
  viewportHeight: number
  rowHeight: number
  itemCount: number
  /** 视口上下各多渲染的行数（默认 8），用于吸收快速滚动时的空白。 */
  overscan?: number
}

export interface WindowRange {
  /** 起始行下标（含）。 */
  start: number
  /** 结束行下标（不含）。 */
  end: number
  /** 占位高度：撑起滚动条。 */
  totalHeight: number
  /** 顶部占位高度：把可视行推到正确位置。 */
  offsetY: number
}

export function computeWindow(input: WindowInput): WindowRange {
  const { scrollTop, viewportHeight, rowHeight, itemCount } = input
  const overscan = Math.max(0, input.overscan ?? 8)

  if (itemCount <= 0 || rowHeight <= 0) {
    return { start: 0, end: 0, totalHeight: 0, offsetY: 0 }
  }

  const totalHeight = itemCount * rowHeight
  const maxScroll = Math.max(0, totalHeight - Math.max(0, viewportHeight))
  const clampedScrollTop = Math.min(Math.max(0, scrollTop), maxScroll)

  const firstVisible = Math.floor(clampedScrollTop / rowHeight)
  const visibleCount = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + 1

  const start = Math.max(0, firstVisible - overscan)
  const end = Math.min(itemCount, firstVisible + visibleCount + overscan)

  return { start, end, totalHeight, offsetY: start * rowHeight }
}

/** 确保某行在视口内所需的目标 scrollTop（键盘导航用）。 */
export function scrollTopToReveal(
  index: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  itemCount: number,
): number {
  if (rowHeight <= 0 || itemCount <= 0) return 0
  const maxScroll = Math.max(0, itemCount * rowHeight - Math.max(0, viewportHeight))
  const rowTop = index * rowHeight
  const rowBottom = rowTop + rowHeight

  if (rowTop < scrollTop) return Math.min(Math.max(0, rowTop), maxScroll)
  if (rowBottom > scrollTop + viewportHeight) {
    return Math.min(Math.max(0, rowBottom - viewportHeight), maxScroll)
  }
  return Math.min(Math.max(0, scrollTop), maxScroll)
}
