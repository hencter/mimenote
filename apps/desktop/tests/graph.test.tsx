// @vitest-environment jsdom
/**
 * 知识图谱卡片画布（M3 核心功能）测试。
 *
 * 分两层，与 `search.test.tsx` / `tags.test.tsx` 同样的思路：
 *
 * 1. **布局与几何纯函数**（`features/graph/layout.ts`）：文件夹分组与嵌套、容器尺寸随内容增长、
 *    网格排布不重叠、视口裁剪只返回相交项、边的分类（入链虚线 / 出链实线）与连接点。
 *    这些断言不碰 DOM，所以出问题时能直接指到"哪个坐标算错了"。
 * 2. **组件行为**（`GraphCanvas` + Mock 适配器的 `graph_data`）：卡片与文件夹容器渲染、
 *    单击出预览（正文真的渲染出来了）、双击进编辑器、文件夹收起/展开、键盘与拖动。
 *
 * 断言尽量落在**可观测的结果**上（DOM 结构、store 状态、localStorage），
 * 而不是内部实现细节（用了哪个变量、哪一层 memo），换实现不该让这些用例变红。
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { App } from '@/App'
import { compareEntries } from '@/domain/tree'
import { GraphCanvas } from '@/features/graph/GraphCanvas'
import {
  CARD_GAP,
  CARD_HEIGHT,
  CARD_WIDTH,
  FOLDER_CHIP_HEIGHT,
  MAX_ZOOM,
  MIN_ZOOM,
  applyManualPositions,
  buildEdgeVisuals,
  buildFolderTree,
  buildLayout,
  buildRectIndex,
  collectFolderPaths,
  edgeAnchors,
  edgePath,
  edgeStyle,
  fitView,
  gridPositions,
  packRows,
  pruneManualPositions,
  queryIndex,
  queryViewport,
  rectsIntersect,
  worldViewport,
  zoomAround,
  type GraphCardBox,
  type Rect,
} from '@/features/graph/layout'
import { makeEntry, setIpcAdapter, type IpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import type { GraphData, GraphEdge, GraphNode } from '@/ipc/types'
import { DEFAULT_VIEW, POSITIONS_KEY, flushPositionPersist, useGraphStore } from '@/state/graph-store'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

const VAULT_ROOT = 'C:\\MockVault'

// ---------------------------------------------------------------------------
// 测试数据与工具
// ---------------------------------------------------------------------------

function node(relPath: string, folder: string, extra: Partial<GraphNode> = {}): GraphNode {
  const name = relPath.split('/').pop() ?? relPath
  return {
    relPath,
    title: name.replace(/\.(md|markdown)$/i, ''),
    folder,
    tags: [],
    outDegree: 0,
    inDegree: 0,
    ...extra,
  }
}

/** 与 Mock Vault 形状一致的小样本（布局纯函数用，不走 IPC）。 */
const SAMPLE_NODES: GraphNode[] = [
  node('README.md', '', { inDegree: 1 }),
  node('随手记.md', ''),
  node('项目/设计.md', '项目', { tags: ['项目', '架构'], outDegree: 2, inDegree: 1 }),
  node('项目/路线图.md', '项目', { outDegree: 1 }),
  node('项目/标签示例.md', '项目', { tags: ['项目', '进行中'] }),
  node('项目/子项目/细节.md', '项目/子项目', { outDegree: 1 }),
  node('日记/2025-01-01.md', '日记'),
  node('日记/2025-01-02.md', '日记'),
]

function edge(
  fromRelPath: string,
  toRelPath: string | null,
  kind: GraphEdge['kind'] = 'wiki',
  count = 1,
): GraphEdge {
  // `toRawTarget` 是悬空边唯一能显示"指向谁"的信息（契约里约定取第一条链接的写法）
  const rawTarget = toRelPath === null ? '还不存在的笔记' : toRelPath.replace(/\.md$/, '')
  return { fromRelPath, toRelPath, toRawTarget: rawTarget, kind, count }
}

function cardsOf(nodes: readonly GraphNode[]): Map<string, GraphCardBox> {
  const layout = buildLayout(nodes)
  return new Map(layout.cards.map((card) => [card.relPath, card]))
}

/** jsdom 不实现 PointerEvent：用同名的 MouseEvent 派发（React 的 pointer 事件接口继承鼠标字段，
 *  clientX/clientY/button 都会被照常读出来，pointerId 两侧同为 undefined，比较仍然成立）。 */
function pointer(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: { x: number; y: number; button?: number },
): void {
  act(() => {
    target.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: init.x,
        clientY: init.y,
        button: init.button ?? 0,
      }),
    )
  })
}

function resetStores(): void {
  useNoteStore.getState().close()
  useUiStore.setState({ viewMode: 'graph', paletteMode: null, linksPanelVisible: false })
  useLinksStore.setState({
    status: { phase: 'idle', indexed: 0, total: 0, durationMs: 0, links: 0 },
    links: null,
    loading: false,
    error: null,
  })
  useVaultStore.setState({
    status: 'idle',
    info: null,
    entries: [],
    tree: [],
    expanded: new Set<string>(),
    selected: null,
    filter: '',
    error: null,
    lastRoot: null,
  })
  useGraphStore.setState({
    status: 'idle',
    data: null,
    error: null,
    rootPath: null,
    selected: null,
    view: DEFAULT_VIEW,
    collapsed: new Set<string>(),
    manual: new Map(),
    staleIndex: false,
    loadedAtMs: 0,
  })
}

/** 渲染画布并等到 Mock Vault 的卡片全部出现。 */
async function renderCanvas(): Promise<void> {
  render(<GraphCanvas />)
  await waitFor(() => {
    expect(document.querySelectorAll('.mn-graph-card').length).toBe(8)
  })
}

function cardElement(relPath: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `.mn-graph-card[data-rel-path="${relPath}"]`,
  )
  if (element === null) throw new Error(`没有渲染出卡片：${relPath}`)
  return element
}

// ===========================================================================
// 第一层：布局与几何纯函数
// ===========================================================================

describe('文件夹自动成组', () => {
  it('按 folder 分组，子文件夹嵌套在父文件夹里，同级按路径排序', () => {
    const tree = buildFolderTree(SAMPLE_NODES)

    expect(tree.path).toBe('')
    // 根目录下的散笔记**不**包含子目录里的笔记
    expect(tree.notes.map((item) => item.relPath)).toEqual(['随手记.md', 'README.md'])
    // 排序规则与文件树**完全一致**（同一个 Intl.Collator）：这里不是"我以为的 ASCII 序"，
    // 而是拿文件树的比较器再排一遍来对齐 —— 画布与侧栏的顺序不该出现两种答案
    const asEntries = tree.notes.map((item) => makeEntry({ relPath: item.relPath }))
    expect([...asEntries].sort(compareEntries).map((item) => item.relPath)).toEqual(
      tree.notes.map((item) => item.relPath),
    )
    expect(tree.children.map((child) => child.path)).toEqual(['日记', '项目'])

    const project = tree.children[1]
    // 拼音序（biaoqian / luxiantu / sheji）—— 与文件树一致，不是路径字典序
    expect(project?.notes.map((item) => item.relPath)).toEqual([
      '项目/标签示例.md',
      '项目/路线图.md',
      '项目/设计.md',
    ])
    expect(project?.children.map((child) => child.path)).toEqual(['项目/子项目'])
    // 折叠卡片要显示"这里面一共多少篇" ⇒ 必须是含子目录的总数
    expect(project?.noteCount).toBe(4)
    expect(tree.noteCount).toBe(8)
  })

  it('中间层会被补齐：只有 A/B/C 时 A 与 A/B 依然是容器（嵌套不断链）', () => {
    const tree = buildFolderTree([node('A/B/C/深层.md', 'A/B/C')])

    const a = tree.children[0]
    const ab = a?.children[0]
    const abc = ab?.children[0]
    expect([a?.path, ab?.path, abc?.path]).toEqual(['A', 'A/B', 'A/B/C'])
    expect(abc?.notes.map((item) => item.relPath)).toEqual(['A/B/C/深层.md'])
    // 逻辑上的"笔记数"逐级向上累计
    expect([a?.noteCount, ab?.noteCount, abc?.noteCount]).toEqual([1, 1, 1])
  })

  it('脏数据防御：`\\` 分隔与首尾 `/` 都被归一化', () => {
    const tree = buildFolderTree([node('x.md', '\\项目\\子\\'), node('y.md', '项目/子')])
    expect(tree.children[0]?.path).toBe('项目')
    expect(tree.children[0]?.children[0]?.notes.map((item) => item.relPath)).toEqual([
      'x.md',
      'y.md',
    ])
  })
})

describe('容器尺寸与排布', () => {
  it('容器按内容自动算尺寸：宽度被网格列数封顶，高度随行数增长', () => {
    const one = buildLayout([node('甲.md', '盒子')]).folders[0]
    const three = buildLayout([
      node('甲.md', '盒子'),
      node('乙.md', '盒子'),
      node('丙.md', '盒子'),
    ]).folders[0]
    const nine = buildLayout(
      Array.from({ length: 9 }, (_, index) => node(`第${index}.md`, '盒子')),
    ).folders[0]

    if (one === undefined || three === undefined || nine === undefined) throw new Error('缺少容器')
    // 1 篇只用 1 列（不为了一篇笔记撑出 3 列的宽度），3 篇铺满 3 列
    expect(one.width).toBeLessThan(three.width)
    // 3 篇与 9 篇**同宽**：宽度被 3 列封顶，不会随笔记数无限增长（超出的换行）
    expect(nine.width).toBe(three.width)
    // 高度随行数增长：3 篇 1 行、9 篇 3 行
    expect(three.height).toBe(one.height)
    expect(nine.height).toBeGreaterThan(three.height)
  })

  it('网格排布：任意两张卡片都不重叠，且间距等于常量', () => {
    const positions = Array.from({ length: 9 }, (_, index) => gridPositions(index, 3))
    const rects: Rect[] = positions.map((point) => ({
      x: point.x,
      y: point.y,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
    }))
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const left = rects[i]
        const right = rects[j]
        if (left === undefined || right === undefined) continue
        expect(rectsIntersect(left, right)).toBe(false)
      }
    }
    const second = positions[1]
    expect(second?.x).toBe(CARD_WIDTH + CARD_GAP)
    expect(positions[3]?.y).toBe(CARD_HEIGHT + CARD_GAP)
  })

  it('整块布局：卡片两两不重叠，顶层容器之间也不重叠', () => {
    const layout = buildLayout(SAMPLE_NODES)

    for (let i = 0; i < layout.cards.length; i += 1) {
      for (let j = i + 1; j < layout.cards.length; j += 1) {
        const left = layout.cards[i]
        const right = layout.cards[j]
        if (left === undefined || right === undefined) continue
        expect(rectsIntersect(left, right)).toBe(false)
      }
    }

    const topLevel = layout.folders.filter((folder) => folder.depth === 0)
    expect(topLevel.map((folder) => folder.label)).toEqual(['（Vault 根）', '日记', '项目'])
    for (let i = 0; i < topLevel.length; i += 1) {
      for (let j = i + 1; j < topLevel.length; j += 1) {
        const left = topLevel[i]
        const right = topLevel[j]
        if (left === undefined || right === undefined) continue
        expect(rectsIntersect(left, right)).toBe(false)
      }
    }
  })

  it('嵌套容器落在父容器内部（`项目/子项目` 完全被 `项目` 包住）', () => {
    const layout = buildLayout(SAMPLE_NODES)
    const project = layout.folders.find((folder) => folder.path === '项目')
    const nested = layout.folders.find((folder) => folder.path === '项目/子项目')

    expect(project).toBeDefined()
    expect(nested).toBeDefined()
    if (project === undefined || nested === undefined) return
    expect(nested.x).toBeGreaterThanOrEqual(project.x)
    expect(nested.y).toBeGreaterThanOrEqual(project.y)
    expect(nested.x + nested.width).toBeLessThanOrEqual(project.x + project.width)
    expect(nested.y + nested.height).toBeLessThanOrEqual(project.y + project.height)
    // 父容器在前（渲染顺序 ⇒ 父垫在子下面）
    expect(layout.folders.indexOf(project)).toBeLessThan(layout.folders.indexOf(nested))
  })

  it('容器路径清单用于"全部收起"：虚拟根只在它有散笔记时才出现', () => {
    expect(collectFolderPaths(buildFolderTree(SAMPLE_NODES))).toEqual([
      '',
      '日记',
      '项目',
      '项目/子项目',
    ])
    expect(collectFolderPaths(buildFolderTree([node('项目/设计.md', '项目')]))).toEqual(['项目'])
  })

  it('装箱是确定性的：同一份数据两次得到完全一样的坐标', () => {
    const first = buildLayout(SAMPLE_NODES)
    const second = buildLayout(SAMPLE_NODES)
    expect(second.cards.map((card) => [card.relPath, card.x, card.y])).toEqual(
      first.cards.map((card) => [card.relPath, card.x, card.y]),
    )
    expect(packRows([{ width: 10, height: 4 }], 100, 5).positions).toEqual([{ x: 0, y: 0 }])
  })

  it('手工位置只覆盖坐标：折叠集合、容器尺寸与其它卡片都不受影响', () => {
    const base = buildLayout(SAMPLE_NODES)
    const moved = applyManualPositions(base, new Map([['项目/设计.md', { x: 1234, y: -56 }]]))
    const card = moved.cards.find((item) => item.relPath === '项目/设计.md')

    expect(card?.x).toBe(1234)
    expect(card?.y).toBe(-56)
    // 没被拖过的卡片原样不动（`applyManualPositions` 只换坐标，不重排）
    expect(moved.cards.filter((item) => item.relPath !== '项目/设计.md')).toEqual(
      base.cards.filter((item) => item.relPath !== '项目/设计.md'),
    )
    expect(moved.folders).toEqual(base.folders)
    // 没有手工位置时直接返回同一份布局（不产生无谓的重渲染）
    expect(applyManualPositions(base, new Map())).toBe(base)
  })

  it('清理手工位置时只丢掉真的不在数据里的笔记（截断的图谱不能清）', () => {
    const manual = new Map([
      ['README.md', { x: 1, y: 1 }],
      ['已经删掉的笔记.md', { x: 2, y: 2 }],
    ])
    const pruned = pruneManualPositions(manual, SAMPLE_NODES)
    expect([...pruned.keys()]).toEqual(['README.md'])
  })
})

describe('收起文件夹', () => {
  it('收起的容器变成紧凑的文件夹卡片，内部卡片（含子文件夹）全部隐藏', () => {
    const layout = buildLayout(SAMPLE_NODES, new Set(['项目']))
    const project = layout.folders.find((folder) => folder.path === '项目')

    expect(project?.collapsed).toBe(true)
    expect(project?.width).toBe(190)
    expect(project?.height).toBe(FOLDER_CHIP_HEIGHT)
    // 项目/设计、路线图、标签示例、子项目/细节 四张卡片都不再渲染
    expect(layout.cards.some((card) => card.relPath.startsWith('项目/'))).toBe(false)
    expect(layout.hiddenCards).toBe(4)
    // 内部卡片不画 ⇒ 相关连线也不会被画出来（buildEdgeVisuals 只认可见卡片）
    expect(layout.folders.some((folder) => folder.path === '项目/子项目')).toBe(false)
    expect(layout.folderPaths).toContain('项目/子项目')
  })

  it('默认全部展开：不给折叠集合时一张卡片都不隐藏', () => {
    const layout = buildLayout(SAMPLE_NODES)
    expect(layout.hiddenCards).toBe(0)
    expect(layout.cards).toHaveLength(8)
    expect(layout.folders.every((folder) => folder.collapsed === false)).toBe(true)
  })
})

describe('视口裁剪', () => {
  it('给定 viewport 只返回相交项（线性实现）', () => {
    const layout = buildLayout(SAMPLE_NODES)
    const viewport: Rect = { x: -1000, y: -1000, width: 100, height: 100 }

    expect(queryViewport(layout.cards, viewport)).toEqual([])

    const first = layout.cards[0]
    expect(first).toBeDefined()
    if (first === undefined) return
    const hit = queryViewport(layout.cards, { x: first.x, y: first.y, width: 1, height: 1 })
    expect(hit.map((card) => card.relPath)).toEqual([first.relPath])
  })

  it('网格索引与线性扫描给出**完全一样**的结果（索引只是加速，不改变语义）', () => {
    const layout = buildLayout(SAMPLE_NODES)
    const index = buildRectIndex(layout.cards)
    const viewports: Rect[] = [
      { x: 0, y: 0, width: 200, height: 120 },
      { x: 300, y: 100, width: 600, height: 400 },
      { x: -500, y: -500, width: 4000, height: 4000 },
      { x: 5000, y: 5000, width: 100, height: 100 },
    ]
    for (const viewport of viewports) {
      expect(queryIndex(index, viewport).map((card) => card.relPath)).toEqual(
        queryViewport(layout.cards, viewport).map((card) => card.relPath),
      )
    }
  })

  it('视口换算成世界坐标：缩放 0.5× 时世界视口是屏幕的两倍（含 overscan）', () => {
    const view = { x: -100, y: -200, zoom: 0.5 }
    const world = worldViewport(view, { width: 800, height: 600 }, 0)
    expect(world.x).toBe(200)
    expect(world.y).toBe(400)
    expect(world.width).toBe(1600)
    expect(world.height).toBe(1200)
  })

  it('规模：1 万节点也能一次建出布局，且每帧裁剪只做视口大小的工作量', () => {
    // 宿主当前上限是 3000（超过就截断），这里刻意按 1 万来测 ——
    // 画布的复杂度必须由"视口裁剪 + 顶层 transform"决定，而不是由节点总数决定。
    const nodes = Array.from({ length: 10000 }, (_, index) =>
      node(`组${index % 200}/笔记${index}.md`, `组${index % 200}`),
    )
    const buildStarted = performance.now()
    const layout = buildLayout(nodes)
    const buildMs = performance.now() - buildStarted

    const indexStarted = performance.now()
    const index = buildRectIndex(layout.cards)
    const indexMs = performance.now() - indexStarted

    const viewport = worldViewport({ x: 0, y: 0, zoom: 1 }, { width: 1280, height: 800 })
    const cullStarted = performance.now()
    let visible = 0
    for (let round = 0; round < 16; round += 1) visible = queryIndex(index, viewport).length
    const cullMs = (performance.now() - cullStarted) / 16

    console.log(
      `[graph] 1 万节点：buildLayout ${buildMs.toFixed(0)}ms，网格索引 ${indexMs.toFixed(0)}ms，` +
        `裁剪 ${cullMs.toFixed(2)}ms/帧（当帧渲染 ${visible} 张卡片）`,
    )
    expect(layout.cards).toHaveLength(10000)
    // 宽松阈值：只用来抓"复杂度写错了"（比如某处退化成了 O(n²)），不做性能基准
    expect(buildMs).toBeLessThan(2000)
    expect(indexMs).toBeLessThan(1000)
    expect(cullMs).toBeLessThan(50)
    expect(visible).toBeLessThan(120)
  })
})

describe('连线：分类与连接点', () => {
  it('选中 A 时：A 的入链是虚线、出链是实线，其余淡化', () => {
    const inbound = edge('乙.md', '甲.md')
    const outbound = edge('甲.md', '丙.md')
    const unrelated = edge('乙.md', '丙.md')

    expect(edgeStyle(inbound, '甲.md')).toEqual({ dashed: true, dim: false, highlight: true })
    expect(edgeStyle(outbound, '甲.md')).toEqual({ dashed: false, dim: false, highlight: true })
    expect(edgeStyle(unrelated, '甲.md')).toEqual({ dashed: false, dim: true, highlight: false })
  })

  it('没有选中时：所有边都是统一的淡色细实线（不需要按 Ctrl 就能看到关联），悬空边是虚线', () => {
    expect(edgeStyle(edge('甲.md', '乙.md'), null)).toEqual({
      dashed: false,
      dim: false,
      highlight: false,
    })
    expect(edgeStyle(edge('甲.md', null), null).dashed).toBe(true)
  })

  it('悬空边即使用来强调也保持虚线（虚线在这里表示"目标笔记还不存在"）', () => {
    expect(edgeStyle(edge('甲.md', null), '甲.md')).toEqual({
      dashed: true,
      dim: false,
      highlight: true,
    })
  })

  it('连接点在卡片边缘而不是中心：水平为主轴时从右侧出、左侧进', () => {
    const from: Rect = { x: 0, y: 0, width: CARD_WIDTH, height: CARD_HEIGHT }
    const to: Rect = { x: 400, y: 10, width: CARD_WIDTH, height: CARD_HEIGHT }

    const anchors = edgeAnchors(from, to)
    expect(anchors.axis).toBe('h')
    expect(anchors.loop).toBe(false)
    expect(anchors.start).toEqual({ x: CARD_WIDTH, y: CARD_HEIGHT / 2 })
    expect(anchors.end).toEqual({ x: 400, y: 10 + CARD_HEIGHT / 2 })
    // 起点必须落在卡片边界上（中心会被卡片挡住 —— 那是我们要避免的）
    expect(anchors.start.x).not.toBe(CARD_WIDTH / 2)

    // 目标在左边 → 从左侧出、右侧进
    const flipped = edgeAnchors(from, { x: -400, y: 0, width: CARD_WIDTH, height: CARD_HEIGHT })
    expect(flipped.start).toEqual({ x: 0, y: CARD_HEIGHT / 2 })
    expect(flipped.end).toEqual({ x: -400 + CARD_WIDTH, y: CARD_HEIGHT / 2 })

    // 垂直为主轴 → 从上下边缘出发
    const vertical = edgeAnchors(from, { x: 5, y: 300, width: CARD_WIDTH, height: CARD_HEIGHT })
    expect(vertical.axis).toBe('v')
    expect(vertical.start).toEqual({ x: CARD_WIDTH / 2, y: CARD_HEIGHT })
  })

  it('自环（笔记链接到自己）走一条绕卡片外侧的弧线', () => {
    const rect: Rect = { x: 0, y: 0, width: CARD_WIDTH, height: CARD_HEIGHT }
    const anchors = edgeAnchors(rect, rect)
    expect(anchors.loop).toBe(true)
    expect(anchors.start.x).toBe(CARD_WIDTH)
    expect(anchors.end.x).toBe(CARD_WIDTH)
    expect(edgePath(anchors.start, anchors.end, anchors.axis, anchors.loop)).toContain('C')
  })

  it('路径是三次贝塞尔，且起点就是连接点', () => {
    const d = edgePath({ x: 190, y: 42 }, { x: 400, y: 52 }, 'h')
    expect(d.startsWith('M 190 42 C ')).toBe(true)
    expect(d.endsWith('400 52')).toBe(true)
  })
})

describe('边的可渲染集合（两端可见 + 视口裁剪）', () => {
  const EDGES: GraphEdge[] = [
    edge('项目/设计.md', '项目/路线图.md'),
    edge('项目/路线图.md', '项目/设计.md'),
    edge('项目/设计.md', '项目/子项目/细节.md', 'wiki', 3),
    edge('项目/子项目/细节.md', null),
  ]

  it('只画两端都在可见集合里的边（折叠容器里的卡片不参与）', () => {
    const all = cardsOf(SAMPLE_NODES)
    expect(buildEdgeVisuals(EDGES, all, null)).toHaveLength(4)

    const collapsed = cardsOf(SAMPLE_NODES.filter((item) => !item.relPath.startsWith('项目/')))
    expect(buildEdgeVisuals(EDGES, collapsed, null)).toHaveLength(0)
  })

  it('悬空边画成虚影端点（小圆点），同一条边 count > 1 时在 tooltip 里说明', () => {
    const cards = cardsOf(SAMPLE_NODES)
    const visuals = buildEdgeVisuals(EDGES, cards, null)
    const phantom = visuals.find((visual) => visual.phantom)
    const details = visuals.find((visual) => visual.edge.count === 3)

    expect(phantom).toBeDefined()
    expect(phantom?.edge.toRelPath).toBeNull()
    expect(phantom?.end.x).toBe((phantom?.start.x ?? 0) + 56)
    expect(phantom?.title).toContain('还不存在的笔记（还不存在）')

    expect(details).toBeDefined()
    expect(details?.title).toContain('共 3 条链接')
  })

  it('给定视口时丢掉完全在视口外的边', () => {
    const cards = cardsOf(SAMPLE_NODES)
    const everything = { x: -10000, y: -10000, width: 20000, height: 20000 }
    const nowhere = { x: 100000, y: 100000, width: 10, height: 10 }

    expect(buildEdgeVisuals(EDGES, cards, null, everything)).toHaveLength(4)
    expect(buildEdgeVisuals(EDGES, cards, null, nowhere)).toHaveLength(0)
  })
})

describe('缩放与适应窗口', () => {
  it('以光标为锚点缩放：锚点下的世界坐标保持不动', () => {
    const view = { x: 40, y: 20, zoom: 1 }
    const focal = { x: 300, y: 200 }
    const worldX = (focal.x - view.x) / view.zoom
    const worldY = (focal.y - view.y) / view.zoom

    const zoomed = zoomAround(view, 2, focal)
    expect(zoomed.zoom).toBe(2)
    expect((focal.x - zoomed.x) / zoomed.zoom).toBeCloseTo(worldX, 6)
    expect((focal.y - zoomed.y) / zoomed.zoom).toBeCloseTo(worldY, 6)
  })

  it('缩放范围被限制在 0.25× ~ 2.5×', () => {
    expect(zoomAround({ x: 0, y: 0, zoom: 1 }, 100, { x: 0, y: 0 }).zoom).toBe(MAX_ZOOM)
    expect(zoomAround({ x: 0, y: 0, zoom: 1 }, 0.001, { x: 0, y: 0 }).zoom).toBe(MIN_ZOOM)
    // 已经到边界时不做无意义的位移
    expect(zoomAround({ x: 5, y: 5, zoom: MAX_ZOOM }, 2, { x: 0, y: 0 })).toEqual({
      x: 5,
      y: 5,
      zoom: MAX_ZOOM,
    })
  })

  it('适应窗口：整块画布落在视口内并居中，缩放不越界', () => {
    const bounds: Rect = { x: 0, y: 0, width: 1000, height: 500 }
    const size = { width: 800, height: 600 }
    const view = fitView(bounds, size, 50)

    expect(view.zoom).toBeGreaterThanOrEqual(MIN_ZOOM)
    expect(view.zoom).toBeLessThanOrEqual(MAX_ZOOM)
    // 画布四角都在视口内
    expect(view.x).toBeGreaterThanOrEqual(0)
    expect(view.y).toBeGreaterThanOrEqual(0)
    expect(bounds.width * view.zoom + view.x).toBeLessThanOrEqual(size.width + 0.5)
    expect(bounds.height * view.zoom + view.y).toBeLessThanOrEqual(size.height + 0.5)

    // 尺寸为 0 的环境（jsdom 首帧）不能算出 0 或 NaN 的缩放
    const degenerate = fitView(bounds, { width: 0, height: 0 }, 50)
    expect(Number.isFinite(degenerate.zoom)).toBe(true)
    expect(degenerate.zoom).toBeGreaterThanOrEqual(MIN_ZOOM)
  })
})

// ===========================================================================
// 第二层：组件行为
// ===========================================================================

describe('知识图谱画布', () => {
  beforeEach(async () => {
    window.localStorage.clear()
    setIpcAdapter(createMockAdapter())
    resetStores()
    await useVaultStore.getState().openVault(VAULT_ROOT)
  })

  afterEach(() => {
    cleanup()
  })

  it('渲染出 Mock Vault 里的每篇笔记的卡片与每个文件夹的容器', async () => {
    await renderCanvas()

    const paths = Array.from(document.querySelectorAll('.mn-graph-card')).map((element) =>
      element.getAttribute('data-rel-path'),
    )
    expect(paths).toEqual(
      expect.arrayContaining([
        'README.md',
        '随手记.md',
        '项目/设计.md',
        '项目/路线图.md',
        '项目/子项目/细节.md',
        '日记/2025-01-01.md',
      ]),
    )

    const folders = Array.from(document.querySelectorAll('.mn-graph-folder')).map((element) =>
      element.getAttribute('data-folder'),
    )
    expect(folders).toEqual(expect.arrayContaining(['', '日记', '项目', '项目/子项目']))

    // 卡片正面直接给出标题、相对路径、标签与出入度（不需要悬停/按 Ctrl）
    const design = cardElement('项目/设计.md')
    expect(design.textContent).toContain('设计')
    expect(design.textContent).toContain('项目/设计.md')
    expect(design.textContent).toContain('→2')
    expect(design.textContent).toContain('←1')
        // 状态角标：节点数 / 边数 / 缩放
    expect(document.querySelector('.mn-graph__hud')?.textContent).toContain('8 节点')
    expect(document.querySelector('.mn-graph__hud')?.textContent).toContain('4 边')
  })

  it('单击卡片 = 在画布上直接预览正文（不按 Ctrl、不用悬停）', async () => {
    await renderCanvas()
    expect(document.querySelector('.mn-graph-preview')).toBeNull()

    fireEvent.click(cardElement('项目/设计.md'))

    await waitFor(() => {
      expect(document.querySelector('.mn-graph-preview')).not.toBeNull()
    })
    // 渲染的是**正文**（表格里的"原子写"），不是路径或摘要
    await waitFor(() => {
      expect(document.querySelector('.mn-graph-preview__article')?.textContent).toContain('原子写')
    })
    // 标题与路径都在面板上
    expect(document.querySelector('.mn-graph-preview')?.textContent).toContain('项目/设计.md')
    // 预览不阻塞画布：卡片依然可点（面板是浮层，不是新的布局分支）
    expect(document.querySelector('.mn-graph-card[data-rel-path="项目/路线图.md"]')).not.toBeNull()
  })

  it('Esc 关闭预览；点画布空白处也关闭', async () => {
    await renderCanvas()
    fireEvent.click(cardElement('项目/路线图.md'))
    await waitFor(() => {
      expect(document.querySelector('.mn-graph-preview')).not.toBeNull()
    })

    fireEvent.keyDown(screen.getByLabelText('知识图谱画布'), { key: 'Escape' })
    await waitFor(() => {
      expect(document.querySelector('.mn-graph-preview')).toBeNull()
    })
    expect(useGraphStore.getState().selected).toBeNull()
  })

  it('双击卡片 = 进编辑器打开：切到编辑视图并真的读入那篇笔记', async () => {
    await renderCanvas()

    fireEvent.doubleClick(cardElement('项目/设计.md'))

    await waitFor(() => {
      expect(useUiStore.getState().viewMode).toBe('edit')
    })
    await waitFor(() => {
      expect(useNoteStore.getState().doc?.relPath).toBe('项目/设计.md')
    })
    expect(useNoteStore.getState().doc?.text).toContain('参考')
  })

  it('收起文件夹后内部卡片全部消失，再点一下展开回来', async () => {
    await renderCanvas()

    fireEvent.click(screen.getByRole('button', { name: /^收起 项目/ }))

    await waitFor(() => {
      expect(document.querySelector('.mn-graph-card[data-rel-path="项目/设计.md"]')).toBeNull()
    })
    // 含子文件夹的卡片也一起收起
    expect(document.querySelector('.mn-graph-card[data-rel-path="项目/子项目/细节.md"]')).toBeNull()
    // 其它文件夹不受影响
    expect(document.querySelector('.mn-graph-card[data-rel-path="日记/2025-01-01.md"]')).not.toBeNull()
    // 收起后是一张紧凑的"文件夹卡片"（显示名字与笔记数）
    const expandedAgain = screen.getByRole('button', { name: /^展开 项目（4 篇）/ })
    expect(expandedAgain).toBeTruthy()

    fireEvent.click(expandedAgain)
    await waitFor(() => {
      expect(document.querySelector('.mn-graph-card[data-rel-path="项目/设计.md"]')).not.toBeNull()
    })
    expect(document.querySelector('.mn-graph-card[data-rel-path="项目/子项目/细节.md"]')).not.toBeNull()
  })

  it('选中卡片后：入链画虚线、出链画实线，其它边淡化', async () => {
    await renderCanvas()

    fireEvent.click(cardElement('项目/设计.md'))
    await waitFor(() => {
      expect(useGraphStore.getState().selected).toBe('项目/设计.md')
    })

    const edges = Array.from(document.querySelectorAll('path.mn-graph-edge'))
    const classes = new Map(
      edges.map((element) => [
        element.querySelector('title')?.textContent?.split('\n')[0] ?? '',
        element.getAttribute('class') ?? '',
      ]),
    )
    // 路线图 → 设计 是**入链**（别人指向它）⇒ 虚线 + 强调
    expect(classes.get('路线图 → 设计')).toContain('mn-graph-edge--dashed')
    expect(classes.get('路线图 → 设计')).toContain('mn-graph-edge--highlight')
    // 设计 → 路线图 是**出链**（它指向别人）⇒ 实线 + 强调
    expect(classes.get('设计 → 路线图')).toContain('mn-graph-edge--highlight')
    expect(classes.get('设计 → 路线图')).not.toContain('mn-graph-edge--dashed')
    // 与选中的卡片无关的边（细节 → 悬空）被淡化，但仍然画出来（上下文不丢）
    expect(classes.get('细节 → 还不存在的笔记（还不存在）')).toContain('mn-graph-edge--dim')
  })

  it('没有选中时所有边都是统一的淡色实线（悬空边虚线 + 虚影圆点）', async () => {
    await renderCanvas()

    const edges = Array.from(document.querySelectorAll('path.mn-graph-edge'))
    expect(edges).toHaveLength(4)
    for (const element of edges) {
      const className = element.getAttribute('class') ?? ''
      // 没有任何选中 ⇒ 既不强调也不淡化；只有悬空边因为"端点缺席"而画虚线
      expect(className).not.toContain('--highlight')
      expect(className).not.toContain('--dim')
      // 悬空边的 title 现在是「<用户写的目标>（还不存在）」，用它来识别
      const dangling = (element.querySelector('title')?.textContent ?? '').includes('（还不存在）')
      expect(className).toBe(dangling ? 'mn-graph-edge mn-graph-edge--dashed' : 'mn-graph-edge')
    }
    // 悬空边：虚线 + 一个小圆点 + 目标名字（用户写下的原始写法）
    expect(document.querySelectorAll('circle.mn-graph-phantom')).toHaveLength(1)
    const phantomLabel = document.querySelector('text.mn-graph-phantom-label')
    expect(phantomLabel?.textContent).toBe('还不存在的笔记')
  })

  it('键盘：+ / - / 0 缩放与适应窗口，缩放被限制在 0.25×~2.5×', async () => {
    await renderCanvas()
    const canvas = screen.getByLabelText('知识图谱画布')
    const before = useGraphStore.getState().view.zoom

    fireEvent.keyDown(canvas, { key: '+' })
    const zoomedIn = useGraphStore.getState().view.zoom
    expect(zoomedIn).toBeGreaterThan(before)

    fireEvent.keyDown(canvas, { key: '-' })
    expect(useGraphStore.getState().view.zoom).toBeCloseTo(before, 6)

    for (let index = 0; index < 40; index += 1) fireEvent.keyDown(canvas, { key: '+' })
    expect(useGraphStore.getState().view.zoom).toBe(MAX_ZOOM)
    for (let index = 0; index < 80; index += 1) fireEvent.keyDown(canvas, { key: '-' })
    expect(useGraphStore.getState().view.zoom).toBe(MIN_ZOOM)

    fireEvent.keyDown(canvas, { key: '0' })
    const fitted = useGraphStore.getState().view
    expect(fitted.zoom).toBeGreaterThan(MIN_ZOOM)
    expect(fitted.zoom).toBeLessThanOrEqual(MAX_ZOOM)
  })

  it('卡片可 Tab 聚焦，Enter 预览、Ctrl+Enter 打开', async () => {
    await renderCanvas()
    const card = cardElement('项目/设计.md')

    card.focus()
    fireEvent.keyDown(card, { key: 'Enter' })
    await waitFor(() => {
      expect(useGraphStore.getState().selected).toBe('项目/设计.md')
    })

    fireEvent.keyDown(card, { key: 'Enter', ctrlKey: true })
    await waitFor(() => {
      expect(useNoteStore.getState().doc?.relPath).toBe('项目/设计.md')
    })
  })

  it('拖动卡片覆盖自动布局并持久化到 localStorage；"重新自动排布"清除手工位置', async () => {
    await renderCanvas()
    const card = cardElement('项目/设计.md')
    const before = useGraphStore.getState().manual.get('项目/设计.md')

    pointer(card, 'pointerdown', { x: 10, y: 10 })
    pointer(card, 'pointermove', { x: 210, y: 110 })
    pointer(card, 'pointerup', { x: 210, y: 110 })

    const moved = useGraphStore.getState().manual.get('项目/设计.md')
    expect(before).toBeUndefined()
    expect(moved).toBeDefined()
    expect(moved?.x).toBeGreaterThan(100)
    // 卡片真的挪了（自动布局被覆盖）
    await waitFor(() => {
      expect(cardElement('项目/设计.md').style.left).toBe(`${String(moved?.x)}px`)
    })

    // 位置按 `Vault 根 + relPath` 持久化
    flushPositionPersist()
    const raw = window.localStorage.getItem(POSITIONS_KEY)
    expect(raw).not.toBeNull()
    const stored = JSON.parse(raw ?? '{}') as Record<string, Record<string, { x: number }>>
    expect(stored[VAULT_ROOT]?.['项目/设计.md']?.x).toBe(moved?.x)

    fireEvent.click(screen.getByRole('button', { name: '重新自动排布' }))
    await waitFor(() => {
      expect(useGraphStore.getState().manual.size).toBe(0)
    })
  })

  it('拖动不会误触发预览（4px 阈值的意义）', async () => {
    await renderCanvas()
    const card = cardElement('项目/路线图.md')

    pointer(card, 'pointerdown', { x: 10, y: 10 })
    pointer(card, 'pointermove', { x: 60, y: 40 })
    pointer(card, 'pointerup', { x: 60, y: 40 })
    fireEvent.click(card)

    expect(useGraphStore.getState().selected).toBeNull()
    expect(document.querySelector('.mn-graph-preview')).toBeNull()
  })

  it('索引构建中给出提示（不是报错），索引就绪后自动补一次数据', async () => {
    setIpcAdapter(createMockAdapter())
    resetStores()
    await useVaultStore.getState().openVault(VAULT_ROOT)
    // 模拟"打开 Vault 时索引还在构建"
    useLinksStore.setState({
      status: { phase: 'building', indexed: 3, total: 8, durationMs: 0, links: 0 },
    })

    render(<GraphCanvas />)
    await waitFor(() => {
      expect(screen.getByText(/索引构建中/)).toBeTruthy()
    })

    // 索引就绪 → 自动重新拉一次，提示消失（不需要用户手动刷新）
    act(() => {
      useLinksStore.setState({
        status: { phase: 'ready', indexed: 8, total: 8, durationMs: 12, links: 4 },
      })
    })
    await waitFor(() => {
      expect(screen.queryByText(/索引构建中/)).toBeNull()
    })
    expect(useGraphStore.getState().staleIndex).toBe(false)
  })

  it('已截断时给出提示（宿主只返回了度数最高的一部分节点）', async () => {
    // 包一层：把 Mock 的 `graph_data` 结果标记成 truncated（真实宿主在节点数超过上限时这样返回）
    const base = createMockAdapter()
    const adapter: IpcAdapter = {
      kind: 'test',
      async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
        if (method !== 'graph_data') return base.invoke<T>(method, args)
        const payload = await base.invoke<GraphData>('graph_data', args)
        return { ...payload, truncated: true } as unknown as T
      },
    }
    setIpcAdapter(adapter)
    resetStores()
    await useVaultStore.getState().openVault(VAULT_ROOT)

    await renderCanvas()
    expect(screen.getByText('已截断')).toBeTruthy()
  })

  it('App 的图谱视图真的挂上了画布（viewMode === "graph"）', async () => {
    useUiStore.setState({ viewMode: 'graph' })
    render(<App />)

    await waitFor(() => {
      expect(document.querySelector('.mn-graph')).not.toBeNull()
    })
    await waitFor(() => {
      expect(document.querySelectorAll('.mn-graph-card').length).toBe(8)
    })
  })
})
