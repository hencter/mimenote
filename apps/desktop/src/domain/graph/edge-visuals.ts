/**
 * 知识图谱画布 —— **连线的分类、连接点与路径**（不 import React / 不碰 DOM / 不读全局状态）。
 *
 * 一句话职责：一条边该画成什么形状（直线/曲线/自环/悬空虚影）、什么虚实、从卡片哪条边出去。
 *
 * 为什么单独一个文件：这一层全部是可以用数字说清楚的纯几何 —— 与 `layout.ts` 的
 * "卡片放在哪"是两个独立的问题，混在一起时 986 行既看不清边界也过不了门禁。
 * 切出来之后两者都在 600 行以内，而对外形状不变：`layout.ts` 仍然再导出这里的符号。
 *
 * **不变量（ADR-0023）**：卡内那段引线（`GraphEdgeVisual.leadPath`）的终点就是
 * `GraphEdgeVisual.start`，也就是卡外那段的起点 —— 两段在卡片边界上必须严丝合缝。
 * 引线的虚线相位按 `leadFrom → start` 的长度算（见 `link-edge.ts` 的 `leadDash`），
 * 所以这两处口径必须一直保持一致。
 *
 * 悬空边的"虚影"端点参数（`PHANTOM_OFFSET_X` / `PHANTOM_GAP_Y`）跟着一起搬：
 * 它们只对这里的 `buildEdgeVisuals` 有意义（虚影从右边缘伸出去多长、彼此间距多少）。
 */

import type { GraphEdge } from '@/ipc/types'

import { centerOf, clampNumber, comparePaths, rectsIntersect, type Point, type Rect } from './geometry'
import type { GraphCardBox } from './layout'

/** 悬空链接的"虚影"端点：从卡片右边缘伸出去多长、多个虚影之间的纵向间距。 */
export const PHANTOM_OFFSET_X = 56
export const PHANTOM_GAP_Y = 18

// ---------------------------------------------------------------------------
// 连线：分类 + 连接点 + 路径
// ---------------------------------------------------------------------------

/**
 * 边相对"当前选中卡片"的分类。
 *
 * 为什么入链用虚线、出链用实线：读一张卡片时最想问的是"它是从哪儿被提到的"（入链，
 * 别人指向它）与"它把我带到哪里去"（出链，它指向别人）。同一组连线里，虚线天生比实线
 * "轻"，正好用来表示**被动**的入链；实线 + 箭头表示**主动**的出链。
 * 于是不需要点开任何面板、不需要按 Ctrl，一眼就能读出这张卡片在知识网络里的角色。
 */
export interface EdgeStyle {
  /** 虚线：入链（指向选中卡片）或悬空边（目标还不存在）。 */
  dashed: boolean
  /** 淡化：与选中卡片无关的边（保留上下文但不抢注意力）。 */
  dim: boolean
  /** 强调：与选中卡片直接相关。 */
  highlight: boolean
  /**
   * **语义色相**（只有关系图会填，ADR-0028）：
   * `out` = 圆心指向别人（我提到它）、`in` = 别人指向圆心（它提到我）、
   * `context` = 环与环之间（既不碰圆心、也不碰当前选中，属于上下文）。
   *
   * 为什么做成可选：全库视图有自己的两条语义（入链虚线 / 出链实线，见 `edgeStyle()`），
   * 它不该被这里的色相规则影响 —— 缺省（`undefined`）时颜色完全由 CSS 类决定。
   */
  hue?: 'out' | 'in' | 'context'
  /**
   * 线宽与不透明度（世界像素 / 0..1，缺省由 CSS 决定）。
   *
   * 关系图按"这条边最远牵到第几跳"给一组数：越远越细越淡。
   * 同样做成可选：全库视图那一套（统一细线 + 选中强调）继续走 CSS。
   */
  width?: number
  opacity?: number
}

export function edgeStyle(edge: GraphEdge, selected: string | null): EdgeStyle {
  const dangling = edge.toRelPath === null
  if (selected === null) {
    // 没有选中时：所有边都是统一的淡色细实线 + 箭头（悬空边仍是虚线 + 端点小圆），
    // 保证"不按任何键就能看到关联"，同时不与卡片抢视觉优先级
    return { dashed: dangling, dim: false, highlight: false }
  }
  if (edge.toRelPath === selected) {
    // 入链：别人指向它 ⇒ 虚线
    return { dashed: true, dim: false, highlight: true }
  }
  if (edge.fromRelPath === selected) {
    // 出链：它指向别人 ⇒ 实线（悬空边保留虚线，因为"虚线"在这里表示端点缺席）
    return { dashed: dangling, dim: false, highlight: true }
  }
  return { dashed: dangling, dim: true, highlight: false }
}

/** 边的稳定标识（同一对节点 + 同一种链接种类唯一）。 */
export function edgeKey(edge: GraphEdge): string {
  return `${edge.fromRelPath}\u0000${edge.toRelPath ?? ''}\u0000${edge.kind}`
}

export interface EdgeAnchors {
  start: Point
  end: Point
  /** 主轴：`h` = 从左右边缘出发，`v` = 从上下边缘出发（决定贝塞尔的控制点方向）。 */
  axis: 'h' | 'v'
  /** 自环（笔记链接到自己）——需要一条绕卡片外侧的弧线。 */
  loop: boolean
}

/**
 * 连接点：从**卡片边缘**出发，而不是从中心穿过卡片。
 *
 * 规则：比较两端中心的位移，主轴方向决定从哪条边出去/进来（左右 or 上下）。
 * 这样连线总是"离开一张卡片、进入到对面那张卡片"，箭头方向一看就懂；
 * 而"从中心画到中心"会让线压在卡片上，把标题与标签遮住。
 */
export function edgeAnchors(from: Rect, to: Rect): EdgeAnchors {
  if (from.x === to.x && from.y === to.y && from.width === to.width && from.height === to.height) {
    // 自环：走右侧的一小段弧（两端都在右边缘）
    return {
      start: { x: from.x + from.width, y: from.y + from.height * 0.34 },
      end: { x: from.x + from.width, y: from.y + from.height * 0.66 },
      axis: 'h',
      loop: true,
    }
  }

  const fromCenter = centerOf(from)
  const toCenter = centerOf(to)
  const dx = toCenter.x - fromCenter.x
  const dy = toCenter.y - fromCenter.y

  if (Math.abs(dx) >= Math.abs(dy)) {
    const y1 = from.y + from.height / 2
    const y2 = to.y + to.height / 2
    return dx >= 0
      ? {
          start: { x: from.x + from.width, y: y1 },
          end: { x: to.x, y: y2 },
          axis: 'h',
          loop: false,
        }
      : {
          start: { x: from.x, y: y1 },
          end: { x: to.x + to.width, y: y2 },
          axis: 'h',
          loop: false,
        }
  }

  const x1 = from.x + from.width / 2
  const x2 = to.x + to.width / 2
  return dy >= 0
    ? {
        start: { x: x1, y: from.y + from.height },
        end: { x: x2, y: to.y },
        axis: 'v',
        loop: false,
      }
    : {
        start: { x: x1, y: from.y },
        end: { x: x2, y: to.y + to.height },
        axis: 'v',
        loop: false,
      }
}

function round(value: number): number {
  return Math.round(value)
}

/** 三次贝塞尔路径（控制点沿主轴伸出，让线有"出卡片 / 入卡片"的手感）。 */
export function edgePath(start: Point, end: Point, axis: 'h' | 'v', loop = false): string {
  const sx = round(start.x)
  const sy = round(start.y)
  const ex = round(end.x)
  const ey = round(end.y)
  if (loop) {
    // 自环：向右鼓出去再回到右边缘
    const bulge = 46
    return `M ${sx} ${sy} C ${sx + bulge} ${sy}, ${sx + bulge} ${ey}, ${ex} ${ey}`
  }
  if (axis === 'h') {
    const control = clampNumber((end.x - start.x) * 0.45, -160, 160)
    return `M ${sx} ${sy} C ${round(start.x + control)} ${sy}, ${round(end.x - control)} ${ey}, ${ex} ${ey}`
  }
  const control = clampNumber((end.y - start.y) * 0.45, -160, 160)
  return `M ${sx} ${sy} C ${sx} ${round(start.y + control)}, ${ex} ${round(end.y - control)}, ${ex} ${ey}`
}

/** 连线两端点的包围盒（含曲线鼓出的余量）——视口裁剪用它，避免整条线看不见还在发 SVG 节点。 */
export function edgeBounds(start: Point, end: Point, pad = 48): Rect {
  const minX = Math.min(start.x, end.x) - pad
  const minY = Math.min(start.y, end.y) - pad
  return {
    x: minX,
    y: minY,
    width: Math.abs(end.x - start.x) + pad * 2,
    height: Math.abs(end.y - start.y) + pad * 2,
  }
}

export interface GraphEdgeVisual {
  key: string
  edge: GraphEdge
  style: EdgeStyle
  /** SVG `path` 的 `d`。 */
  d: string
  start: Point
  end: Point
  /** 悬空边：终点是"虚影"端点（小圆点），没有对应卡片。 */
  phantom: boolean
  /** tooltip 文案（线段本身不堆文字；同一条边 `count > 1` 时在这里说明"共 N 条链接"）。 */
  title: string
  /**
   * 卡片**内部**的那一段虚线引线（ADR-0023）：从正文里 `[[链接]]` 那一段文字开始，
   * 画到卡片边界为止。缺省 = 没有（全库视图的紧凑卡片没有正文位置，那里也就没有引线）。
   *
   * 为什么与卡片外那段放在同一个 visual 里：它们是**同一条边**的两段，分开渲染会出现
   * "一段在图层上面、一段在下面"，以及 tooltip 只挂在其中一段上。
   *
   * **不变量**：这段引线的另一端就是 `start`（= 卡片边界上的那个 `exit` 点），
   * 而 `start` 同时是卡片外那段的起点 —— 两段因此在边界上严丝合缝。
   * 引线的虚线相位按 `leadFrom → start` 的长度算（见 `link-edge.ts` 的 `leadDash`），
   * 所以这两处口径必须一直保持一致。
   */
  leadPath?: string
  /** 引线的起点（正文里那段文字的位置，世界坐标）；只有 `leadPath` 存在时有意义。 */
  leadFrom?: Point
}

const KIND_LABEL: Record<GraphEdge['kind'], string> = {
  wiki: '双链',
  embed: '嵌入',
  markdown: 'Markdown 链接',
}

/**
 * 把边编译成可直接渲染的 SVG 图元。
 *
 * 三条规则（每一条都同时解决正确性与性能）：
 * 1. **两端都必须可见**：卡片在折叠容器里（或 Vault 里不存在）就整条不画 ——
 *    否则会出现"线通到一块空地上"的错觉；
 * 2. **悬空边**（`toRelPath === null`）：没有目标卡片，画一个短小的虚影端点（小圆点），
 *    同一张卡片上的多个虚影纵向散开，不会叠成一团；
 * 3. **视口裁剪**：给定视口时丢掉两端包围盒都不相交的边。
 */
export function buildEdgeVisuals(
  edges: readonly GraphEdge[],
  cards: ReadonlyMap<string, GraphCardBox>,
  selected: string | null,
  viewport: Rect | null = null,
): GraphEdgeVisual[] {
  // 悬空边的槽位：按来源卡片分组、按 (count 降序, kind, 原序) 排序后分配 ——
  // 排序键全部来自数据，因此**与视口无关**，平移/缩放时虚影圆点不会跳来跳去。
  const danglingSlots = new Map<string, number>()
  const danglingCounts = new Map<string, number>()
  const danglingByFrom = new Map<string, GraphEdge[]>()
  for (const edge of edges) {
    if (edge.toRelPath !== null) continue
    const list = danglingByFrom.get(edge.fromRelPath)
    if (list === undefined) danglingByFrom.set(edge.fromRelPath, [edge])
    else list.push(edge)
  }
  for (const [from, list] of danglingByFrom) {
    const sorted = [...list].sort(
      (left, right) =>
        right.count - left.count ||
        comparePaths(left.kind, right.kind) ||
        comparePaths(left.toRelPath ?? '', right.toRelPath ?? ''),
    )
    sorted.forEach((edge, slot) => danglingSlots.set(edgeKey(edge), slot))
    danglingCounts.set(from, sorted.length)
  }

  const visuals: GraphEdgeVisual[] = []
  for (const edge of edges) {
    const from = cards.get(edge.fromRelPath)
    // 来源卡片不可见（被折叠）⇒ 不画
    if (from === undefined) continue

    let start: Point
    let end: Point
    let axis: 'h' | 'v'
    let loop = false
    let phantom = false

    if (edge.toRelPath === null) {
      phantom = true
      const slot = danglingSlots.get(edgeKey(edge)) ?? 0
      const total = danglingCounts.get(edge.fromRelPath) ?? 1
      const midY = from.y + from.height / 2
      start = { x: from.x + from.width, y: midY }
      end = {
        x: from.x + from.width + PHANTOM_OFFSET_X,
        y: midY + (slot - (total - 1) / 2) * PHANTOM_GAP_Y,
      }
      axis = 'h'
    } else {
      const to = cards.get(edge.toRelPath)
      if (to === undefined) continue
      const anchors = edgeAnchors(from, to)
      start = anchors.start
      end = anchors.end
      axis = anchors.axis
      loop = anchors.loop
    }

    if (viewport !== null && !rectsIntersect(edgeBounds(start, end), viewport)) continue

    const toTitle =
      edge.toRelPath === null
        ? `${edge.toRawTarget === '' ? '未知目标' : edge.toRawTarget}（还不存在）`
        : (cards.get(edge.toRelPath)?.node.title ?? edge.toRelPath)
    const title =
      `${from.node.title} → ${toTitle}\n${KIND_LABEL[edge.kind]}` +
      (edge.count > 1 ? ` · 共 ${edge.count} 条链接` : '')

    visuals.push({
      key: edgeKey(edge),
      edge,
      style: edgeStyle(edge, selected),
      d: edgePath(start, end, axis, loop),
      start,
      end,
      phantom,
      title,
    })
  }

  // 稳定顺序：同一份数据 + 同一视口的渲染顺序完全一致（避免 React 频繁重排 SVG 节点）
  return visuals.sort((left, right) => comparePaths(left.key, right.key))
}
