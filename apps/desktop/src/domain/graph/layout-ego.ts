/**
 * 自我中心图谱（ego graph）的**布局与几何**：以当前笔记为圆心，按"跳数"分环摆放（ADR-0021）。
 *
 * 为什么单独一层：这一层是纯函数（不 import React / 不碰 DOM / 不读全局状态），
 * 因此"第 2 跳的节点到底在第几个环上、卡片会不会重叠、画布要多大"全都能在 vitest 里断言。
 * 画笔只负责把这里算出来的盒子画出来（`canvas/paint.ts`）。
 *
 * ## 为什么是同心环，而不是（既有的）文件夹装箱或力导向
 *
 * 用户的原始反馈是"有点乱" —— 乱的根源不是卡片本身，而是**画布上没有"距离"这个维度**：
 * 全库视图里所有卡片都在同一层平面上，读者只能靠连线形状去猜谁离谁近。自我中心视图把
 * "离这篇笔记几跳"直接变成**半径**，于是"先关联的"与"隔了两层的"一眼可分，这个信息不需要
 * 用户去推理。
 *
 * 三条具体的取舍：
 *
 * 1. **坐标是数据的纯函数**：同一篇笔记 + 同一个深度 ⇒ 每次打开位置完全一样（力导向做不到，
 *    而"空间记忆"恰恰是图谱最有用的地方）。同一个环内按 `relPath` 字典序排，因此也稳定。
 * 2. **环半径由"这一环装得下多少卡片"算出来**（弧长求和），不是一个写死的间隔 ——
 *    否则第 1 跳有 40 个邻居时卡片会叠成一团（那正是"乱"的另一种形态）。
 * 3. **卡片尺寸从外面传进来**（`sizes`），因为高度取决于"这篇笔记的 markdown 排完有多高"，
 *    那要用 canvas 量字 —— 测量在 `canvas/measure.ts`，这里只消费结果。测试因此可以喂
 *    一组假尺寸，不必有真 canvas。
 */

import type { GraphEdge, GraphNode } from '@/ipc/types'
import type { Point, Rect } from './layout'

/** 一个节点在画布上的盒子（世界坐标）。 */
export interface EgoCardBox {
  relPath: string
  node: GraphNode
  /** 离中心几跳（中心自己是 0）。 */
  hop: number
  rect: Rect
}

/** 整幅自我中心图的几何结果。 */
export interface EgoLayout {
  cards: EgoCardBox[]
  cardsByPath: ReadonlyMap<string, EgoCardBox>
  /** 每一环的半径（下标 = 跳数，`[0]` 是圆心那一环 = 0）。 */
  ringRadii: number[]
  /** 整幅图的包围盒（含卡片自身尺寸）。 */
  bounds: Rect
  /** 没有出现在图里的节点（数据里有、但 BFS 到不了）—— 正常不该发生，留作如实汇报用。 */
  unreachable: string[]
}

export interface EgoSize {
  width: number
  height: number
}

/** 圆心到第一环的最小间距：卡片再小也要留出"围绕"的观感。 */
const MIN_RING_GAP = 90
/** 相邻两环之间的最小径向间距（按"卡片对角线的最大值"再放大一点算，避免两层挤在一起）。 */
const RING_CLEARANCE = 1.35

/**
 * 从中心出发算每一跳能到达哪些节点（**双向**：出链与反链都算一跳）。
 *
 * 为什么把 BFS 放在前端也算一遍（宿主给的是已经筛好的子图）：宿主只需要知道"哪些节点在这个
 * 子图里"，而**摆在第几个环上**是布局的信息 —— 让宿主把 `hop` 也带回来，等于把布局的知识
 * 泄漏进 IPC 契约（将来换成径向/径向+聚类时又要改契约）。这里从边集算一次，代价是 O(V+E)，
 * 对 ≤300 个节点的子图可以忽略。
 *
 * 悬空边（`toRelPath === null`）不参与：它指向的笔记不存在，没有节点可放。
 */
export function egoHops(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  root: string,
  maxDepth: number,
): Map<string, number> {
  const present = new Set(nodes.map((node) => node.relPath))
  if (!present.has(root)) return new Map<string, number>()

  const neighbours = new Map<string, Set<string>>()
  const link = (from: string, to: string): void => {
    const forward = neighbours.get(from)
    if (forward === undefined) neighbours.set(from, new Set([to]))
    else forward.add(to)
    // 反向也要连：`A → B` 时从 B 出发一跳能到 A（用户说的"先关联"就是双向的）
    const backward = neighbours.get(to)
    if (backward === undefined) neighbours.set(to, new Set([from]))
    else backward.add(from)
  }
  for (const edge of edges) {
    if (edge.toRelPath === null) continue
    if (!present.has(edge.fromRelPath) || !present.has(edge.toRelPath)) continue
    link(edge.fromRelPath, edge.toRelPath)
  }

  const hops = new Map<string, number>([[root, 0]])
  let frontier: string[] = [root]
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const next: string[] = []
    for (const current of frontier) {
      for (const neighbour of neighbours.get(current) ?? []) {
        if (hops.has(neighbour)) continue
        hops.set(neighbour, depth)
        next.push(neighbour)
      }
    }
    // 下一层按字典序展开：同一个 Vault 每次算出来的"发现顺序"一致，环内排序才有意义
    frontier = next.sort()
  }
  return hops
}

/** 一组卡片围绕圆心摆一圈所需的最小半径（弧长必须放得下所有卡片的对角线）。 */
function ringRadius(entries: readonly EgoSize[], minimum: number): number {
  if (entries.length === 0) return minimum
  if (entries.length === 1) return minimum
  let circumference = 0
  let widest = 0
  for (const entry of entries) {
    const diagonal = Math.hypot(entry.width, entry.height)
    circumference += diagonal * 1.15 // 留一点缝：卡片是矩形而环是圆的，弦长比弧长短
    widest = Math.max(widest, diagonal)
  }
  // 半径来自 `2πr = 周长`；同时保证"最大的那张卡片不与圆心重叠"
  return Math.max(minimum, circumference / (2 * Math.PI), widest)
}

/**
 * 把自我中心子图摆成同心环。
 *
 * `sizes` 是每个节点的卡片尺寸（缺省用 `fallbackSize`）：调用方通常先量有限几篇正文，
 * 量不到的（还没读到、或读失败）就用兜底尺寸 —— 布局不应该因为"某篇正文还没到"而失败。
 */
export function layoutEgo(input: {
  nodes: readonly GraphNode[]
  edges: readonly GraphEdge[]
  root: string
  depth: number
  sizes: ReadonlyMap<string, EgoSize>
  fallbackSize: EgoSize
}): EgoLayout {
  const { nodes, edges, root, depth, sizes, fallbackSize } = input
  const hops = egoHops(nodes, edges, root, depth)
  const nodeByPath = new Map(nodes.map((node) => [node.relPath, node]))

  // 按环分组，环内按 relPath 字典序（确定性的第二半：第一半是 BFS 的展开顺序）
  const rings = new Map<number, string[]>()
  const unreachable: string[] = []
  for (const node of nodes) {
    const hop = hops.get(node.relPath)
    if (hop === undefined) {
      unreachable.push(node.relPath)
      continue
    }
    const bucket = rings.get(hop)
    if (bucket === undefined) rings.set(hop, [node.relPath])
    else bucket.push(node.relPath)
  }
  for (const bucket of rings.values()) bucket.sort()
  unreachable.sort()

  const sizesOf = (relPath: string): EgoSize => sizes.get(relPath) ?? fallbackSize
  const maxHop = Math.max(0, ...[...rings.keys()])

  // 环半径：逐环累积（每一环的半径既要放得下自己，也要与上一环留出径向净空）
  const ringRadii: number[] = [0]
  let previousRadius = 0
  for (let hop = 1; hop <= maxHop; hop += 1) {
    const members = (rings.get(hop) ?? []).map((relPath) => sizesOf(relPath))
    const widest = members.reduce((max, size) => Math.max(max, Math.hypot(size.width, size.height) / 2), 0)
    const minimum = Math.max(previousRadius + MIN_RING_GAP, widest * RING_CLEARANCE + previousRadius)
    const radius = ringRadius(members, minimum)
    ringRadii.push(radius)
    previousRadius = radius
  }

  const cards: EgoCardBox[] = []
  const place = (relPath: string, hop: number, rect: Rect): void => {
    const node = nodeByPath.get(relPath)
    if (node === undefined) return
    cards.push({ relPath, node, hop, rect })
  }

  // 圆心：中心那一篇（`hop === 0`）只有一篇，放在原点
  const rootSize = sizesOf(root)
  place(root, 0, {
    x: -rootSize.width / 2,
    y: -rootSize.height / 2,
    width: rootSize.width,
    height: rootSize.height,
  })

  for (let hop = 1; hop <= maxHop; hop += 1) {
    const members = rings.get(hop) ?? []
    if (members.length === 0) continue
    const radius = ringRadii[hop] ?? 0
    // 从正上方（-π/2）开始顺时针排：第一张卡片永远落在同一个位置，用户的"空间记忆"才成立。
    // 每一张卡片占的**圆心角**按它自己的对角线除以半径算 —— 卡片大小不一（正文长度不同），
    // 按"平均分角度"会让高卡片在环上互相咬进去。
    let angle = -Math.PI / 2
    for (const relPath of members) {
      const size = sizesOf(relPath)
      const span = (Math.hypot(size.width, size.height) * 1.15) / (radius === 0 ? 1 : radius)
      const centerAngle = angle + span / 2
      angle += span
      const centerX = Math.cos(centerAngle) * radius
      const centerY = Math.sin(centerAngle) * radius
      place(relPath, hop, {
        x: centerX - size.width / 2,
        y: centerY - size.height / 2,
        width: size.width,
        height: size.height,
      })
    }
  }

  return { cards, cardsByPath: new Map(cards.map((card) => [card.relPath, card])), ringRadii, bounds: boundsOf(cards), unreachable }
}

/** 所有卡片的包围盒（空图时给一个原点附近的小盒子，避免"适应窗口"算出 0 尺寸）。 */
export function boundsOf(cards: readonly EgoCardBox[]): Rect {
  if (cards.length === 0) return { x: -1, y: -1, width: 2, height: 2 }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const card of cards) {
    minX = Math.min(minX, card.rect.x)
    minY = Math.min(minY, card.rect.y)
    maxX = Math.max(maxX, card.rect.x + card.rect.width)
    maxY = Math.max(maxY, card.rect.y + card.rect.height)
  }
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) }
}

/** 命中测试：世界坐标点上最上面的卡片（后画的在上），没有则 `null`。 */
export function cardAt(cards: readonly EgoCardBox[], point: Point): EgoCardBox | null {
  for (let index = cards.length - 1; index >= 0; index -= 1) {
    const card = cards[index]
    if (card === undefined) continue
    const { rect } = card
    if (
      point.x >= rect.x &&
      point.x <= rect.x + rect.width &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.height
    ) {
      return card
    }
  }
  return null
}

/** 视线框筛选：与 `viewport` 相交的卡片（画笔用它跳过屏幕外的卡片）。 */
export function visibleCards(cards: readonly EgoCardBox[], viewport: Rect): EgoCardBox[] {
  return cards.filter((card) => {
    const { rect } = card
    return (
      rect.x < viewport.x + viewport.width &&
      rect.x + rect.width > viewport.x &&
      rect.y < viewport.y + viewport.height &&
      rect.y + rect.height > viewport.y
    )
  })
}
