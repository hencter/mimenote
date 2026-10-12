/**
 * 知识图谱画布 —— **均匀网格裁剪索引**（不 import React / 不碰 DOM / 不读全局状态）。
 *
 * 一句话职责：把"哪些卡片/容器与当前视口相交"从 O(总卡片数) 降到 O(可见数 + 覆盖的格子数)。
 *
 * 为什么单独一个文件：这一段是**每帧都在跑**的部分（平移/缩放时每次都要重查），与
 * `layout.ts` 里"数据或折叠变了才跑一次"的装箱布局相比，运行频率差三个数量级，
 * 改动它的理由也完全不同（那里关心"坐标对不对"，这里关心"每帧查多少格子"）。
 * 切出来之后两个文件都在门禁的 600 行以内，判据没有分家：`layout.ts` 仍然再导出这里的符号。
 *
 * 索引的格子边长（`INDEX_CELL_SIZE`）跟着它一起搬：这个数字只对"查询要访问多少格子"有意义，
 * 留在这里才不会让"索引的精度"看起来像"布局的尺寸"。
 *
 * 视口裁剪的复杂度：卡片与容器用**均匀网格索引**（`buildRectIndex`），
 * 查询只访问与视口相交的格子 —— 1 万节点时每次平移是 O(可见数 + 覆盖的格子数)，
 * 而不是 O(总节点数)。边没有建索引（一条边可能横跨很远，装进多个格子反而更贵），
 * 用"端点包围盒是否与视口相交"做 O(E) 的线性筛，实测 1 万条边一次约 0.1~0.3ms，
 * 与每帧渲染成本（可见卡片数）相比可以忽略。
 */

import { rectsIntersect, type Rect } from './geometry'
import type { GraphCardBox } from './layout'

/** 网格索引的格子边长（略大于一张卡片，一张卡片最多落进 2×2 = 4 个格子）。 */
export const INDEX_CELL_SIZE = 256

// ---------------------------------------------------------------------------
// 视口裁剪
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 视口裁剪
// ---------------------------------------------------------------------------

/**
 * 均匀网格索引。
 *
 * 为什么不是纯线性扫描：`buildLayout` 只在数据/折叠变化时跑一次，但**裁剪每帧都跑**。
 * 线性扫 1 万张卡片 ≈ 每次平移 1 万次矩形判定（约 0.5~1ms，且随节点数线性增长）。
 * 建索引是 O(n) 一次性成本，之后每次查询只访问视口覆盖的几十个格子。
 */
export interface RectIndex {
  cellSize: number
  /** `${col}:${row}` → 卡片在 `boxes` 里的下标。 */
  cells: Map<string, number[]>
  boxes: readonly GraphCardBox[]
}

export function buildRectIndex(
  boxes: readonly GraphCardBox[],
  cellSize: number = INDEX_CELL_SIZE,
): RectIndex {
  const cells = new Map<string, number[]>()
  const size = Math.max(32, cellSize)
  boxes.forEach((box, index) => {
    const firstCol = Math.floor(box.x / size)
    const lastCol = Math.floor((box.x + box.width) / size)
    const firstRow = Math.floor(box.y / size)
    const lastRow = Math.floor((box.y + box.height) / size)
    for (let col = firstCol; col <= lastCol; col += 1) {
      for (let row = firstRow; row <= lastRow; row += 1) {
        const key = `${col}:${row}`
        const bucket = cells.get(key)
        if (bucket === undefined) cells.set(key, [index])
        else bucket.push(index)
      }
    }
  })
  return { cellSize: size, cells, boxes }
}

/** 查询与视口相交的卡片（结果按 `boxes` 下标升序 ⇒ DOM 顺序稳定、平移时不抖动）。 */
export function queryIndex(index: RectIndex, viewport: Rect): GraphCardBox[] {
  const { cellSize, cells, boxes } = index
  const hits = new Set<number>()
  const firstCol = Math.floor(viewport.x / cellSize)
  const lastCol = Math.floor((viewport.x + viewport.width) / cellSize)
  const firstRow = Math.floor(viewport.y / cellSize)
  const lastRow = Math.floor((viewport.y + viewport.height) / cellSize)

  for (let col = firstCol; col <= lastCol; col += 1) {
    for (let row = firstRow; row <= lastRow; row += 1) {
      const bucket = cells.get(`${col}:${row}`)
      if (bucket === undefined) continue
      for (const index of bucket) {
        if (hits.has(index)) continue
        const box = boxes[index]
        if (box !== undefined && rectsIntersect(box, viewport)) hits.add(index)
      }
    }
  }

  return [...hits].sort((left, right) => left - right).map((index) => boxes[index] as GraphCardBox)
}

/** 线性裁剪（索引未建好时的兜底，也是索引正确性的对照实现）。 */
export function queryViewport<T extends Rect>(boxes: readonly T[], viewport: Rect): T[] {
  return boxes.filter((box) => rectsIntersect(box, viewport))
}
