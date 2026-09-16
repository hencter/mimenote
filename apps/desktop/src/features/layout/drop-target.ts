/**
 * 拖标签的**落点几何**（ADR-0035 渲染层的行为判据，纯函数，不碰 DOM/React）。
 *
 * 一个叶子（leaf）有两种可放的区域，对应模型的两个操作：
 *
 * ```text
 * ┌── 标签条 ──────────────────┐
 * │ [甲] [乙]  ⇥ 插到第几位     │  ← 标签条：index 语义（重排 / 并入指定位置）
 * ├────────────────────────────┤
 * │ 左带 │                   │ 右带 │
 * │     │      中 央         │     │  ← 内容区：边缘带 = 切一刀，中央 = 并入末尾
 * │     │                   │     │
 * └─────┴────────────────────┴─────┘
 * ```
 *
 * 拆成纯函数的原因与 `tree-layout.ts` 相同：几何判据只有一份，单测可以直接手算坐标钉住，
 * 组件里只剩"量矩形 → 调这里"。
 */

/** 切割方向（落在哪条边上）。 */
export type DropEdge = 'left' | 'right' | 'top' | 'bottom'

/**
 * 一个叶子内容区里的落点。
 *
 * - `merge`：并入这一格（追加到标签条末尾并激活）—— `moveItem` 的 `edge` 缺省；
 * - `split`：在这条边上切一刀，被拖的标签独占新叶 —— `moveItem` 的 `edge`。
 */
export type ContentDrop = { kind: 'merge' } | { kind: 'split'; edge: DropEdge }

/** 一个矩形（`getBoundingClientRect` 的最小子集，单测可以直接手写字面量）。 */
export interface RectLike {
  left: number
  top: number
  width: number
  height: number
}

/**
 * 边缘带占整条边长的比例（0.25 = 四边各留四分之一）。
 *
 * 为什么不是固定的 48px：叶子尺寸差异极大（全宽主区 vs 右下角一小块），固定像素在
 * 小叶子里会吃掉一半以上面积，"中央并入"就再也指不中；比例带随格子缩放，两种落点
 * 在任何尺寸下都指得中。
 */
export const EDGE_BAND = 0.25

/**
 * 指针落在内容区的哪个落点。
 *
 * 判据：算出指针到四条边的**相对距离**（0..1），最近的那条边若近到 `< EDGE_BAND` 就是它，
 * 否则算中央。角落自然归到更近的那条边 —— 不需要给角落单独定规则。
 *
 * 退化的矩形（宽或高 ≤ 0）一律算中央：边缘带本来就是为了"还有地方切一刀"，
 * 没有面积时并入是唯一有意义的落点。
 */
export function contentDropAt(rect: RectLike, x: number, y: number): ContentDrop {
  if (rect.width <= 0 || rect.height <= 0) return { kind: 'merge' }
  const distances: Array<[DropEdge, number]> = [
    ['left', (x - rect.left) / rect.width],
    ['right', (rect.left + rect.width - x) / rect.width],
    ['top', (y - rect.top) / rect.height],
    ['bottom', (rect.top + rect.height - y) / rect.height],
  ]
  let best: [DropEdge, number] = distances[0]!
  for (const candidate of distances) {
    if (candidate[1] < best[1]) best = candidate
  }
  return best[1] < EDGE_BAND ? { kind: 'split', edge: best[0] } : { kind: 'merge' }
}

/**
 * 标签条上的插入下标：落在哪个标签的左半段就插到它前面。
 *
 * `centers` 是各标签中线在条内的横坐标（升序）。与旧停靠模型的 `insertionIndexFor`
 * 同一个判据（"指针在任何位置都有确定答案"，不做间隙特判）—— 旧函数随停靠模型退役，
 * 这里是它唯一的继承者。
 */
export function tabIndexAt(centers: readonly number[], x: number): number {
  for (let index = 0; index < centers.length; index += 1) {
    const center = centers[index]
    if (center !== undefined && x < center) return index
  }
  return centers.length
}
