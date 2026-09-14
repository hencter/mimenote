/**
 * 自我中心图谱的**跳数与几何**（ADR-0021）。
 *
 * 这一层全是纯函数，所以测试也全是"输入 → 输出"的直接断言。三条最该钉死的性质：
 *
 * 1. **双向**：`A → B` 时，以 `B` 为中心的一跳里必须有 `A`（用户说的"先关联"就是这个意思）；
 * 2. **确定性**：同一份数据每次算出来的坐标完全一样（坐标是数据的纯函数 —— 力导向做不到，
 *    而"空间记忆"正是图谱最有用的地方）；
 * 3. **不重叠**：同一环上卡片大小不一时，按各自的**对角线**分圆心角，谁也不咬进谁；
 *    环半径由弧长求和算出来，不是写死的间隔。
 */

import { describe, expect, it } from 'vitest'

import type { GraphEdge, GraphNode } from '@/ipc/types'
import {
  boundsOf,
  cardAt,
  egoHops,
  layoutEgo,
  visibleCards,
  type EgoSize,
} from '@/features/graph/layout-ego'

function node(relPath: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    relPath,
    title: relPath.replace(/\.md$/u, ''),
    folder: relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '',
    tags: [],
    outDegree: 0,
    inDegree: 0,
    ...overrides,
  }
}

function edge(fromRelPath: string, toRelPath: string | null): GraphEdge {
  return { fromRelPath, toRelPath, toRawTarget: toRelPath ?? '不存在的目标', kind: 'wiki', count: 1 }
}

const SIZE: EgoSize = { width: 240, height: 120 }

describe('跳数（BFS，双向）', () => {
  it('以中心的一跳同时含出链与反链指向的笔记', () => {
    const nodes = [node('甲.md'), node('乙.md'), node('丙.md')]
    const edges = [edge('甲.md', '乙.md'), edge('丙.md', '甲.md')]

    const hops = egoHops(nodes, edges, '甲.md', 3)

    expect(hops.get('甲.md')).toBe(0)
    expect(hops.get('乙.md')).toBe(1)
    expect(hops.get('丙.md')).toBe(1)
  })

  it('深度限制按链式传播逐层放开（A→B→C→D）', () => {
    const nodes = ['A.md', 'B.md', 'C.md', 'D.md'].map((rel) => node(rel))
    const edges = [edge('A.md', 'B.md'), edge('B.md', 'C.md'), edge('C.md', 'D.md')]

    expect([...egoHops(nodes, edges, 'A.md', 1).keys()].sort()).toEqual(['A.md', 'B.md'])
    expect([...egoHops(nodes, edges, 'A.md', 2).keys()].sort()).toEqual(['A.md', 'B.md', 'C.md'])
    expect([...egoHops(nodes, edges, 'A.md', 3).keys()].sort()).toEqual([
      'A.md',
      'B.md',
      'C.md',
      'D.md',
    ])
  })

  it('无关的那一簇不出现（X↔Y 与中心没有任何路径）', () => {
    const nodes = ['甲.md', '乙.md', 'X.md', 'Y.md'].map((rel) => node(rel))
    const edges = [edge('甲.md', '乙.md'), edge('X.md', 'Y.md')]

    const hops = egoHops(nodes, edges, '甲.md', 5)

    expect(hops.has('X.md')).toBe(false)
    expect(hops.has('Y.md')).toBe(false)
  })

  it('中心还没有进索引时给空结果（不抛错）', () => {
    const hops = egoHops([node('别的.md')], [], '还没进索引.md', 2)
    expect(hops.size).toBe(0)
  })

  it('悬空边不参与（它指向的笔记不存在，没有节点可放）', () => {
    const hops = egoHops([node('甲.md')], [edge('甲.md', null)], '甲.md', 2)
    expect([...hops.keys()]).toEqual(['甲.md'])
  })
})

describe('同心环布局', () => {
  const nodes = [
    node('甲.md'),
    node('乙.md'),
    node('丙.md'),
    node('丁.md'),
    node('戊.md'),
  ]
  const edges = [
    edge('甲.md', '乙.md'),
    edge('甲.md', '丙.md'),
    edge('乙.md', '丁.md'),
    edge('丙.md', '戊.md'),
  ]

  it('半径 = 跳数：中心在圆心，一跳在内环，两跳在外环', () => {
    const layout = layoutEgo({ nodes, edges, root: '甲.md', depth: 2, sizes: new Map(), fallbackSize: SIZE })

    const center = layout.cardsByPath.get('甲.md')
    expect(center?.hop).toBe(0)
    // 圆心那一张的**中心**落在原点
    expect(center?.rect.x).toBeCloseTo(-SIZE.width / 2, 5)
    expect(center?.rect.y).toBeCloseTo(-SIZE.height / 2, 5)

    const first = ['乙.md', '丙.md'].map((rel) => layout.cardsByPath.get(rel))
    const second = ['丁.md', '戊.md'].map((rel) => layout.cardsByPath.get(rel))
    expect(first.every((card) => card?.hop === 1)).toBe(true)
    expect(second.every((card) => card?.hop === 2)).toBe(true)

    // 外环半径严格大于内环
    expect(layout.ringRadii[1]).toBeGreaterThan(0)
    expect(layout.ringRadii[2]).toBeGreaterThan(layout.ringRadii[1] ?? 0)
  })

  it('同一份数据算两次，坐标逐字节一样（空间记忆的前提）', () => {
    const first = layoutEgo({ nodes, edges, root: '甲.md', depth: 2, sizes: new Map(), fallbackSize: SIZE })
    const second = layoutEgo({ nodes, edges, root: '甲.md', depth: 2, sizes: new Map(), fallbackSize: SIZE })

    expect(JSON.stringify(first.cards)).toBe(JSON.stringify(second.cards))
  })

  it('卡片高度不同时也不重叠：环上按各自的对角线分圆心角', () => {
    const sizes = new Map<string, EgoSize>([
      ['甲.md', SIZE],
      ['乙.md', { width: 240, height: 600 }], // 很长的正文
      ['丙.md', { width: 240, height: 600 }],
    ])
    const layout = layoutEgo({
      nodes: [node('甲.md'), node('乙.md'), node('丙.md')],
      edges: [edge('甲.md', '乙.md'), edge('甲.md', '丙.md')],
      root: '甲.md',
      depth: 1,
      sizes,
      fallbackSize: SIZE,
    })

    // 半径至少要放得下"最高那张卡片的半对角线"，否则它会与圆心那张重叠
    const diagonal = Math.hypot(600, 240)
    expect(layout.ringRadii[1] ?? 0).toBeGreaterThan(diagonal / 2)

    // 两张高卡片之间不重叠（矩形相交判定，世界坐标）
    const a = layout.cardsByPath.get('乙.md')?.rect
    const b = layout.cardsByPath.get('丙.md')?.rect
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    const overlap =
      a !== undefined &&
      b !== undefined &&
      a.x < b.x + b.width &&
      a.x + a.width > b.x &&
      a.y < b.y + b.height &&
      a.y + a.height > b.y
    expect(overlap).toBe(false)
  })

  it('到不了的节点如实列进 `unreachable`（不静默丢掉）', () => {
    const layout = layoutEgo({
      nodes: [...nodes, node('孤岛.md')],
      edges,
      root: '甲.md',
      depth: 1,
      sizes: new Map(),
      fallbackSize: SIZE,
    })

    // 顺序按**码元**（`sort()` 的默认口径）：丁 < 孤 < 戊。这条断言顺带钉住"汇报顺序也是确定的"
    expect(layout.unreachable).toEqual(['丁.md', '孤岛.md', '戊.md'])
    expect(layout.cardsByPath.has('孤岛.md')).toBe(false)
  })

  it('包围盒覆盖所有卡片（适应窗口据此算缩放）', () => {
    const layout = layoutEgo({ nodes, edges, root: '甲.md', depth: 2, sizes: new Map(), fallbackSize: SIZE })

    const bounds = layout.bounds
    for (const card of layout.cards) {
      expect(card.rect.x).toBeGreaterThanOrEqual(bounds.x - 1e-6)
      expect(card.rect.y).toBeGreaterThanOrEqual(bounds.y - 1e-6)
      expect(card.rect.x + card.rect.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1e-6)
      expect(card.rect.y + card.rect.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1e-6)
    }
  })

  it('空图给一个非零的小包围盒（"适应窗口"不会算出 0 或无穷的缩放）', () => {
    const bounds = boundsOf([])
    expect(bounds.width).toBeGreaterThan(0)
    expect(bounds.height).toBeGreaterThan(0)
  })
})

describe('命中与裁剪', () => {
  const layout = layoutEgo({
    nodes: [node('甲.md'), node('乙.md')],
    edges: [edge('甲.md', '乙.md')],
    root: '甲.md',
    depth: 1,
    sizes: new Map(),
    fallbackSize: SIZE,
  })

  it('点在卡片里 → 命中那一张；点在空白处 → null', () => {
    const root = layout.cardsByPath.get('甲.md')
    expect(root).toBeDefined()
    const center = {
      x: (root?.rect.x ?? 0) + SIZE.width / 2,
      y: (root?.rect.y ?? 0) + SIZE.height / 2,
    }
    expect(cardAt(layout.cards, center)?.relPath).toBe('甲.md')
    // 远到画布外面
    expect(cardAt(layout.cards, { x: 10_000, y: 10_000 })).toBeNull()
  })

  it('视口裁剪只留下与视口相交的卡片', () => {
    const root = layout.cardsByPath.get('甲.md')
    expect(root).toBeDefined()
    const tiny = {
      x: root?.rect.x ?? 0,
      y: root?.rect.y ?? 0,
      width: 4,
      height: 4,
    }
    expect(visibleCards(layout.cards, tiny).map((card) => card.relPath)).toEqual(['甲.md'])
    // 视口覆盖全部
    expect(visibleCards(layout.cards, layout.bounds)).toHaveLength(layout.cards.length)
  })
})
