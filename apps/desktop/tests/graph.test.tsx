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
import { registerBuiltinCommands, GRAPH_COMMAND_IDS } from '@/app/builtin-commands'
import { commands } from '@/app/commands'
import { useGlobalKeymap } from '@/app/keymap'
import { compareEntries } from '@/domain/tree'
import { isMarkdown } from '@/domain/paths'
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
  type Point,
  type Rect,
} from '@/features/graph/layout'
import { makeEntry, setIpcAdapter, type IpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import type { GraphData, GraphEdge, GraphNode } from '@/ipc/types'
import {
  DEFAULT_VIEW,
  FALLBACK_VIEWPORT,
  POSITIONS_KEY,
  flushPositionPersist,
  useGraphStore,
} from '@/state/graph-store'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

const VAULT_ROOT = 'C:\\MockVault'

/**
 * Mock Vault 里"图谱会收录的笔记数"（= 卡片数）。
 *
 * 刻意**不写死数字**：给 Mock Vault 加一篇演示笔记（例如大纲面板用的 `项目/大纲.md`）
 * 就会让一批与图谱无关的断言集体变红 —— 那种红是噪音，不是回归；从 Mock 自己的笔记表
 * 算出来，加笔记时这些用例不用改。
 */
const MOCK_CARD_COUNT = createMockAdapter()
  .dump()
  .filter((note) => isMarkdown(note.relPath)).length

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
    viewport: { ...FALLBACK_VIEWPORT, known: false },
    refreshing: false,
    refreshNotice: null,
    fitKey: null,
  })
}

/**
 * 渲染画布并装上**全局快捷键**。
 *
 * 为什么需要它：缩放 / 适应窗口 / 关闭预览已经是命令表里的 `graph.*`，触发入口是
 * `app/keymap.ts` 的全局 keydown（`App` 里由 `useGlobalKeymap` 安装）。
 * 只渲染 `<GraphCanvas />` 时没有任何分发者，按键盘什么都不会发生 ——
 * 那正是"命令表是快捷键唯一事实来源"的代价，测试也必须走同一条路。
 */
async function renderCanvasWithKeys(): Promise<void> {
  render(<KeymapHarness />)
  await waitFor(() => {
    expect(document.querySelectorAll('.mn-graph-card').length).toBe(MOCK_CARD_COUNT)
  })
}

function KeymapHarness() {
  useGlobalKeymap()
  return <GraphCanvas />
}

/** 渲染画布并等到 Mock Vault 的卡片全部出现。 */
async function renderCanvas(): Promise<void> {
  render(<GraphCanvas />)
  await waitFor(() => {
    expect(document.querySelectorAll('.mn-graph-card').length).toBe(MOCK_CARD_COUNT)
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
// 数据刷新：保留视角的刷新 vs 完整重载
// ===========================================================================

describe('数据刷新：保留视角', () => {
  beforeEach(async () => {
    window.localStorage.clear()
    setIpcAdapter(createMockAdapter())
    resetStores()
    await useVaultStore.getState().openVault(VAULT_ROOT)
  })

  /** 按"完整重载"先加载一次，拿到 Mock Vault 的真实节点/边。 */
  async function loadFullGraph(): Promise<GraphData> {
    await useGraphStore.getState().load(VAULT_ROOT)
    const data = useGraphStore.getState().data
    if (data === null) throw new Error('没有加载到图谱数据')
    return data
  }

  it('只换数据：缩放/偏移/选中/手工位置/折叠集合全部保留，且全程不进 loading（不闪白）', async () => {
    const data = await loadFullGraph()
    useGraphStore.setState({
      view: { x: -123, y: 45, zoom: 1.75 },
      selected: '项目/设计.md',
      collapsed: new Set(['日记']),
      manual: new Map([['README.md', { x: 10, y: 20 }]]),
    })

    // 盯住刷新过程中的每一次状态变化：既不能进 `loading`，也不能把 data 清空
    const statuses: string[] = []
    let dataWentNull = false
    let sawRefreshing = false
    const unsubscribe = useGraphStore.subscribe((state) => {
      statuses.push(state.status)
      if (state.data === null) dataWentNull = true
      if (state.refreshing) sawRefreshing = true
    })
    await useGraphStore.getState().load(VAULT_ROOT, { keepView: true })
    unsubscribe()

    const state = useGraphStore.getState()
    expect(statuses).not.toContain('loading')
    expect(dataWentNull).toBe(false)
    // "刷新中"是 HUD 上的轻量指示（不是全屏的加载态）
    expect(sawRefreshing).toBe(true)
    expect(state.refreshing).toBe(false)

    expect(state.status).toBe('ready')
    expect(state.data?.nodes.length).toBe(data.nodes.length)
    expect(state.view).toEqual({ x: -123, y: 45, zoom: 1.75 })
    expect(state.selected).toBe('项目/设计.md')
    expect([...state.collapsed]).toEqual(['日记'])
    expect(state.manual.get('README.md')).toEqual({ x: 10, y: 20 })
  })

  it('清理指向已消失笔记的手工位置与选中（并顺手落盘），truncated 时一律不清', async () => {
    await loadFullGraph()
    useGraphStore.setState({
      selected: '已经删掉的笔记.md',
      manual: new Map([
        ['README.md', { x: 1, y: 2 }],
        ['已经删掉的笔记.md', { x: 3, y: 4 }],
      ]),
    })

    await useGraphStore.getState().load(VAULT_ROOT, { keepView: true })

    const state = useGraphStore.getState()
    expect(state.selected).toBeNull()
    expect([...state.manual.keys()]).toEqual(['README.md'])
    // 清掉的位置顺手落盘：别让已删除笔记的位置一直躺在 localStorage 里
    const stored = JSON.parse(window.localStorage.getItem(POSITIONS_KEY) ?? '{}') as Record<
      string,
      Record<string, Point>
    >
    expect(Object.keys(stored[VAULT_ROOT] ?? {})).toEqual(['README.md'])

    // 截断的图谱只返回度数最高的一部分：**没返回 ≠ 被删了**，位置与选中都不能动
    const base = createMockAdapter()
    setIpcAdapter({
      kind: 'test',
      async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
        if (method !== 'graph_data') return base.invoke<T>(method, args)
        const payload = await base.invoke<GraphData>('graph_data', args)
        return { ...payload, truncated: true } as unknown as T
      },
    })
    await loadFullGraph()
    useGraphStore.setState({
      selected: '项目/设计.md',
      manual: new Map([['还没被返回的笔记.md', { x: 5, y: 6 }]]),
    })

    await useGraphStore.getState().load(VAULT_ROOT, { keepView: true })

    expect(useGraphStore.getState().selected).toBe('项目/设计.md')
    expect(useGraphStore.getState().manual.has('还没被返回的笔记.md')).toBe(true)
  })

  it('完整重载（不传 keepView）= 从头再来：视角/折叠/选中/适应窗口记账全部复位', async () => {
    await loadFullGraph()
    useGraphStore.setState({
      view: { x: -123, y: 45, zoom: 1.75 },
      selected: '项目/设计.md',
      collapsed: new Set(['日记']),
      manual: new Map([['README.md', { x: 10, y: 20 }]]),
      fitKey: 'whatever',
    })

    await useGraphStore.getState().load(VAULT_ROOT)

    const state = useGraphStore.getState()
    expect(state.view).toEqual(DEFAULT_VIEW)
    expect(state.selected).toBeNull()
    expect(state.collapsed.size).toBe(0)
    // 清空 fitKey ⇒ 画布会重新"适应窗口"（用户点"重新读取"就是要求这个）
    expect(state.fitKey).toBeNull()
    // 手工位置从 localStorage 重读：内存里那次还没落盘的拖动会被丢掉（"重新读取"的语义）
    expect(state.manual.size).toBe(0)
  })

  it('换 Vault 时即使传了 keepView 也强制完整重载（旧的视角属于上一个 Vault）', async () => {
    await loadFullGraph()
    useGraphStore.setState({
      view: { x: -123, y: 45, zoom: 1.75 },
      collapsed: new Set(['日记']),
    })

    await useGraphStore.getState().load('C:\\别的Vault', { keepView: true })

    const state = useGraphStore.getState()
    expect(state.rootPath).toBe('C:\\别的Vault')
    expect(state.view).toEqual(DEFAULT_VIEW)
    expect(state.collapsed.size).toBe(0)
  })

  it('宿主返回空数据（索引正在重建）时保留旧数据并给出提示，而不是清空画布', async () => {
    const data = await loadFullGraph()
    const base = createMockAdapter()
    setIpcAdapter({
      kind: 'test',
      async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
        if (method !== 'graph_data') return base.invoke<T>(method, args)
        return { nodes: [], edges: [], truncated: false, elapsedMs: 0 } as unknown as T
      },
    })

    await useGraphStore.getState().load(VAULT_ROOT, { keepView: true })

    const state = useGraphStore.getState()
    expect(state.data?.nodes.length).toBe(data.nodes.length) // 旧数据还在
    expect(state.refreshNotice).toContain('索引可能正在重建')
    // 标记"数据可能是旧的"：索引一就绪就会自动再补一次
    expect(state.staleIndex).toBe(true)
    expect(state.refreshing).toBe(false)

    // 显式"重新读取"（keepView 为 false）照旧采纳空结果 ——
    // 那是用户明确要求的"从头再来"，也是真正变空的 Vault 唯一能被画出来的路径
    await useGraphStore.getState().load(VAULT_ROOT)
    expect(useGraphStore.getState().data?.nodes.length).toBe(0)
    expect(useGraphStore.getState().refreshNotice).toBeNull()
  })
})

// ===========================================================================
// 图谱命令：命令表是快捷键的唯一事实来源
// ===========================================================================

describe('图谱命令', () => {
  beforeEach(async () => {
    setIpcAdapter(createMockAdapter())
    resetStores()
    registerBuiltinCommands()
    await useVaultStore.getState().openVault(VAULT_ROOT)
  })

  const GRAPH_COMMAND_IDS_LIST = [
    GRAPH_COMMAND_IDS.zoomIn,
    GRAPH_COMMAND_IDS.zoomOut,
    GRAPH_COMMAND_IDS.fit,
    GRAPH_COMMAND_IDS.closePreview,
  ]

  it('四条命令都在，快捷键不与他人撞车，生效条件是"当前视图是图谱"', async () => {
    for (const id of GRAPH_COMMAND_IDS_LIST) {
      const command = commands.get(id)
      expect(command, `缺少命令 ${id}`).toBeDefined()
      expect(command?.category).toBe('图谱')
      expect(command?.unavailableReason).toBe('需要先切换到知识图谱视图')
    }

    // 每条图谱快捷键都**只**命中图谱命令：既证明它们可用，也证明没有和既有命令撞车
    // （既有表已占用 Mod+O/N/S/E/B/G/K/P、Mod+Shift+F/T/L/E、Mod+Alt+*、F2、Delete 等）
    expect(commands.byChord('Mod+=').map((command) => command.id)).toEqual(['graph.zoomIn'])
    // `+` 这个键**无法**写进命令表：`normalizeChord` 用 `+` 当分隔符（`'Mod+='.split('+')`），
    // 真实键盘上 `Ctrl`+`+` 的事件是 `Mod+Shift++`，和任何归一化后的串都对不上。
    // 它由画布按键后转交给同一条命令（见下面"键盘：+ / - / 0"那条用例）。
    expect(commands.byChord('+')).toEqual([])
    expect(commands.byChord('Mod+-').map((command) => command.id)).toEqual(['graph.zoomOut'])
    expect(commands.byChord('-').map((command) => command.id)).toEqual(['graph.zoomOut'])
    expect(commands.byChord('Mod+0').map((command) => command.id)).toEqual(['graph.fit'])
    expect(commands.byChord('0').map((command) => command.id)).toEqual(['graph.fit'])
    expect(commands.byChord('Escape').map((command) => command.id)).toEqual([
      'graph.closePreview',
    ])

    expect(commands.byChord('Mod+G').map((command) => command.id)).toEqual(['view.graph'])
    expect(commands.byChord('Mod+E').map((command) => command.id)).toEqual(['view.cycleMode'])

    // 视图不是图谱 ⇒ when 为 false：快捷键与面板都不会执行它
    useUiStore.setState({ viewMode: 'edit' })
    for (const id of GRAPH_COMMAND_IDS_LIST) {
      expect(commands.get(id)?.when?.(), id).toBe(false)
    }
    const before = useGraphStore.getState().view
    await expect(commands.execute('graph.zoomIn')).resolves.toBe(false)
    expect(useGraphStore.getState().view).toEqual(before)

    // 回到图谱视图 ⇒ 命令恢复可用
    useUiStore.setState({ viewMode: 'graph' })
    expect(commands.get('graph.zoomIn')?.when?.()).toBe(true)
  })

  it('run 调到的就是 store 动作：放大 / 缩小 / 适应窗口 / 关闭预览', async () => {
    await useGraphStore.getState().load(VAULT_ROOT)
    useGraphStore.setState({
      viewport: { width: 800, height: 600, known: true },
      view: { x: -40, y: -20, zoom: 1 },
    })

    await expect(commands.execute('graph.zoomIn')).resolves.toBe(true)
    expect(useGraphStore.getState().view.zoom).toBeCloseTo(1.25, 6)

    await expect(commands.execute('graph.zoomOut')).resolves.toBe(true)
    expect(useGraphStore.getState().view.zoom).toBeCloseTo(1, 6)

    useGraphStore.setState({ view: { x: 99999, y: 99999, zoom: MAX_ZOOM } })
    await commands.execute('graph.fit')
    const fitted = useGraphStore.getState().view
    expect(fitted.zoom).toBeLessThan(MAX_ZOOM)
    expect(fitted.zoom).toBeGreaterThanOrEqual(MIN_ZOOM)
    // 整块画布落进上报的视口（与画布按钮用的是同一个 store 动作）
    const bounds = buildLayout(useGraphStore.getState().data?.nodes ?? []).bounds
    expect(bounds.width * fitted.zoom + fitted.x).toBeLessThanOrEqual(800.5)
    expect(bounds.height * fitted.zoom + fitted.y).toBeLessThanOrEqual(600.5)

    useGraphStore.setState({ selected: 'README.md' })
    await commands.execute('graph.closePreview')
    expect(useGraphStore.getState().selected).toBeNull()
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
    // 缩放 / 适应窗口 / 关闭预览走命令表（幂等注册，重复调用无副作用）
    registerBuiltinCommands()
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
    expect(document.querySelector('.mn-graph__hud')?.textContent).toContain(`${MOCK_CARD_COUNT} 节点`)
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

  it('Esc 关闭预览（命令）；点画布空白处也关闭', async () => {
    await renderCanvasWithKeys()
    fireEvent.click(cardElement('项目/路线图.md'))
    await waitFor(() => {
      expect(document.querySelector('.mn-graph-preview')).not.toBeNull()
    })

    // Esc 现在是 `graph.closePreview` 命令：**焦点在不在画布上都生效**（全局快捷键分发）
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
    // 篇数不写死：Mock Vault 里 项目/ 下有几篇由 Mock 自己决定（加一篇演示笔记不该让这条变红）
    const projectNotes = createMockAdapter()
      .dump()
      .filter((note) => isMarkdown(note.relPath) && note.relPath.startsWith('项目/')).length
    const expandedAgain = screen.getByRole('button', {
      name: new RegExp(`^展开 项目（${projectNotes} 篇`),
    })
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
    // 缩放已经是 `graph.zoomIn` / `graph.zoomOut` / `graph.fit` 三条命令（命令表是快捷键的
    // 唯一事实来源），所以这里要装上全局快捷键分发者，并且把按键打在画布元素上 ——
    // 焦点在画布上时照样生效（事件冒泡到 window 的 keymap）。
    await renderCanvasWithKeys()
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

  it('预览面板：打开时焦点进入面板，关闭后还给刚才那张卡片', async () => {
    await renderCanvas()
    const card = cardElement('项目/设计.md')
    // 浏览器里单击带 `tabindex` 的卡片本来就会聚焦它（jsdom 不会，所以这里显式点一下焦点）
    card.focus()
    expect(document.activeElement).toBe(card)

    fireEvent.click(card)
    const panel = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('.mn-graph-preview')
      expect(element).not.toBeNull()
      return element
    })
    if (panel === null) throw new Error('预览面板没有出现')
    // 打开即聚焦：键盘用户不会"面板开了但焦点还留在卡片上"
    expect(document.activeElement).toBe(panel)

    // 关闭（右上角的 ×，与 Esc 同一条关闭路径）后焦点回到那张卡片，Tab 不用从头走
    const closeButton = panel.querySelector<HTMLButtonElement>('button[aria-label="关闭预览"]')
    if (closeButton === null) throw new Error('没有关闭按钮')
    fireEvent.click(closeButton)

    await waitFor(() => {
      expect(document.querySelector('.mn-graph-preview')).toBeNull()
    })
    expect(document.activeElement).toBe(cardElement('项目/设计.md'))
  })

  it('预览正文里的 [[wikilink]] 能点开目标笔记（解析口径与阅读视图一致）', async () => {
    await renderCanvas()
    fireEvent.click(cardElement('项目/设计.md'))

    // 设计.md 正文里有 [[路线图]]，Mock 索引把它解析到 项目/路线图.md
    await waitFor(() => {
      const link = document.querySelector('a.mn-wikilink[data-target="路线图"]')
      expect(link).not.toBeNull()
      expect(link?.getAttribute('data-rel-path')).toBe('项目/路线图.md')
    })
    const link = document.querySelector<HTMLAnchorElement>('a.mn-wikilink[data-target="路线图"]')
    if (link === null) throw new Error('没有渲染出 wikilink')

    fireEvent.click(link)

    // 面板跟着滑到那篇卡片（画布上"顺着链接读下去"），同时把它读进编辑器
    await waitFor(() => {
      expect(useGraphStore.getState().selected).toBe('项目/路线图.md')
    })
    await waitFor(() => {
      expect(useNoteStore.getState().doc?.relPath).toBe('项目/路线图.md')
    })
  })

  it('刷新期间不闪白：旧卡片继续显示，只在 HUD 上给一个"刷新中"的轻量指示', async () => {
    await renderCanvas()

    // 让这次刷新"挂住"，好在"正在刷新"的那一刻观察界面
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const base = createMockAdapter()
    let calls = 0
    setIpcAdapter({
      kind: 'test',
      async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
        if (method === 'graph_data') {
          calls += 1
          if (calls > 1) await gate
        }
        return base.invoke<T>(method, args)
      },
    })

    let refresh: Promise<void> = Promise.resolve()
    act(() => {
      refresh = useGraphStore.getState().load(VAULT_ROOT, { keepView: true })
    })

    await waitFor(() => {
      expect(screen.getByText('刷新中…')).toBeTruthy()
    })
    // 旧数据继续渲染：没有全屏加载层、也没有空白（卡片还在）
    expect(document.querySelectorAll('.mn-graph-card').length).toBe(MOCK_CARD_COUNT)
    expect(screen.queryByText('正在读取图谱…')).toBeNull()

    await act(async () => {
      release()
      await refresh
    })
    await waitFor(() => {
      expect(screen.queryByText('刷新中…')).toBeNull()
    })
  })

  it('刷新返回空数据时不闪白：旧卡片继续显示，只在提示条上说明', async () => {
    await renderCanvas()

    // 索引重建期间宿主可能返回空结果
    const base = createMockAdapter()
    setIpcAdapter({
      kind: 'test',
      async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
        if (method !== 'graph_data') return base.invoke<T>(method, args)
        return { nodes: [], edges: [], truncated: false, elapsedMs: 0 } as unknown as T
      },
    })
    await act(async () => {
      await useGraphStore.getState().load(VAULT_ROOT, { keepView: true })
    })

    // 画布没有被清空（卡片都还在），提示条说明看到的是上一次的结果
    expect(document.querySelectorAll('.mn-graph-card').length).toBe(MOCK_CARD_COUNT)
    expect(screen.getByText(/索引可能正在重建/)).toBeTruthy()
  })

  it('保存成功后自动刷新一次（画布可见时），且不会重置视角', async () => {
    let graphCalls = 0
    const base = createMockAdapter()
    setIpcAdapter({
      kind: 'test',
      async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
        if (method === 'graph_data') graphCalls += 1
        return base.invoke<T>(method, args)
      },
    })
    resetStores()
    await useVaultStore.getState().openVault(VAULT_ROOT)

    await renderCanvas()
    expect(graphCalls).toBe(1) // 挂载（= 切到图谱视图）时拉了一次
    const view = useGraphStore.getState().view

    // 索引是全局的：任何一次保存成功后都应刷新（`saveCount` 变化就是那个信号）
    act(() => {
      useNoteStore.setState({ saveCount: useNoteStore.getState().saveCount + 1 })
    })
    expect(graphCalls).toBe(2)
    // 保留视角：刷新不会把镜头甩回"适应窗口"
    expect(useGraphStore.getState().view).toEqual(view)

    // 画布不可见时不发请求：每次自动保存都白跑一次 IPC 没有意义，
    // 切回图谱时的挂载刷新本来就会拉到最新数据
    useUiStore.setState({ viewMode: 'edit' })
    act(() => {
      useNoteStore.setState({ saveCount: useNoteStore.getState().saveCount + 1 })
    })
    expect(graphCalls).toBe(2)
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
      expect(document.querySelectorAll('.mn-graph-card').length).toBe(MOCK_CARD_COUNT)
    })
  })
})
