/**
 * 知识图谱画布 —— **容器装箱布局与手工位置**（不 import React / 不碰 DOM / 不读全局状态）。
 *
 * 一句话职责：按 `folder` 字段把笔记组织成文件夹树，再把树**整齐装箱**成卡片的绝对坐标
 * （以及缩放/平移/适应窗口的视口换算、手工拖动的坐标覆盖）。
 *
 * 为什么独立成一层：画布上"卡片在哪、容器多大"全部是可以用数字说清楚的问题，
 * 它们必须在 vitest 里能直接断言（见 `tests/features/graph/graph.test.tsx`），而不是只能靠人眼看像素。
 * 组件层只负责把这里算出来的盒子渲染出来、把交互换算成输入。
 *
 * 布局的三条取舍（对应需求「不需要人为处理」）：
 *
 * 1. **不用力导向（force-directed）**。力导向的坐标是"迭代出来的"，有三个本质上无法接受的后果：
 *    每次打开同一份数据布局都不一样（用户的空间记忆失效）、环形/团簇结构无法预测、
 *    迭代本身是 O(n²) 且要跑几百轮（1 万节点直接卡死）。
 *    这里用**文件夹树 + 整齐装箱**：坐标是数据（`folder` + `relPath`）的纯函数，
 *    同一份 Vault 每次打开都一样 —— 这才是"和整个 Vault 有映射"的前提。
 * 2. **容器是自动成组的**：`folder` 字段直接决定树形结构，子文件夹天然嵌套在父文件夹里，
 *    中间层（`A/B` 里的 `A`）即使没有直接笔记也会被补齐，所以结构完整、不需要人工摆放。
 * 3. **卡片尺寸固定、容器尺寸由内容算出来**：整块画布的边界因此可以在 O(n) 内算完，
 *    不依赖任何测量（不需要等 DOM 布局，也就不存在"首帧位置错乱再回填"的抖动）。
 *
 * 这个文件只放"什么时候摆一次"的东西（数据或折叠集合变了才重算）：基础几何在
 * `geometry.ts`、每帧都要跑的裁剪索引在 `rect-index.ts`、连线几何在 `edge-visuals.ts`。
 * 三者都由这里**再导出**，因此原来 `import … from '@/features/graph/layout'` 的消费点
 * 只改路径、不改取的符号 —— 对外形状与切分前逐字相同。
 */

import type { GraphNode } from '@/ipc/types'

import {
  MAX_ZOOM,
  MIN_ZOOM,
  clampNumber,
  clampZoom,
  comparePaths,
  type GraphView,
  type Point,
  type Rect,
  type Size,
} from './geometry'

// 对外形状不变：基础几何、裁剪索引与连线几何的符号继续从本文件可取。
export type { Point, Rect, Size, GraphView } from './geometry'
export { MAX_ZOOM, MIN_ZOOM, centerOf, clampZoom, comparePaths, rectsIntersect } from './geometry'
export type { RectIndex } from './rect-index'
export { INDEX_CELL_SIZE, buildRectIndex, queryIndex, queryViewport } from './rect-index'
export type { EdgeAnchors, EdgeStyle, GraphEdgeVisual } from './edge-visuals'
export {
  PHANTOM_GAP_Y,
  PHANTOM_OFFSET_X,
  buildEdgeVisuals,
  edgeAnchors,
  edgeBounds,
  edgeKey,
  edgePath,
  edgeStyle,
} from './edge-visuals'

// ---------------------------------------------------------------------------
// 尺寸常量（全部集中在这里：布局是"可预测"的，前提是所有魔法数字只有一份）
// ---------------------------------------------------------------------------

/** 卡片固定尺寸。固定才能让容器尺寸、画布边界、裁剪都在 O(n) 内算完。 */
export const CARD_WIDTH = 190
export const CARD_HEIGHT = 84
export const CARD_GAP = 14

/** 容器：内边距 + 标题条高度（标题条就是"文件夹的名字"和折叠按钮）。 */
export const CONTAINER_PADDING = 14
export const CONTAINER_HEADER_HEIGHT = 30
export const CONTAINER_GAP = 18

/**
 * 一个容器内部的笔记网格最多几列。
 *
 * 3 列（约 598px）是"容器不会无限变宽"与"容器里能一眼看完"的折中：
 * 列数固定 ⇒ 容器宽度只随**列数**变，不会随笔记数增长，超出的笔记自动换行成更多行。
 */
export const CARD_GRID_COLUMNS = 3

/** 顶层容器装箱的行宽上限：超过就换行（既不会拉成一条无限长的横带，也不会无限往右长）。 */
export const CANVAS_ROW_WIDTH = 1280

/** 画布四周留白。 */
export const CANVAS_MARGIN = 48

/** 折叠后的"文件夹卡片"（紧凑形态）。 */
export const FOLDER_CHIP_WIDTH = 190
export const FOLDER_CHIP_HEIGHT = 54

/** Vault 根那一块的标题（`folder === ''` 的散笔记）。 */
export const VAULT_ROOT_LABEL = '（Vault 根）'


/** 视口裁剪的 overscan（屏幕像素）：稍微多画一圈，平移时边缘不会"闪"出来。 */
export const OVERSCAN = 240


/** 每按一次"放大/缩小"（按钮、命令或快捷键）的倍率。 */
export const ZOOM_STEP = 1.25

/** "适应窗口"时四周留白。放在这里而不是组件里：画布按钮与 `graph.zoomIn` 这类命令
 *  都必须用同一个数值，否则两条入口会算出不一样的视角。 */
export const FIT_PADDING = 64

// ---------------------------------------------------------------------------
// 文件夹树（自动成组）
// ---------------------------------------------------------------------------

export interface FolderTreeNode {
  /** POSIX 目录；虚拟根为 `''`。 */
  path: string
  /** 显示名：最后一段；虚拟根显示"（Vault 根）"。 */
  name: string
  /** **直接**位于该目录下的笔记（按 `relPath` 排序）。 */
  notes: GraphNode[]
  /** 子目录（按路径排序）。 */
  children: FolderTreeNode[]
  /** 含子目录在内的笔记总数（折叠卡片上要显示"这里面一共多少篇"）。 */
  noteCount: number
}

/** 归一化目录写法：去掉首尾 `/`、把 `\` 折成 `/`（IPC 契约是 POSIX，防御一下脏数据）。 */
export function normalizeFolder(folder: string): string {
  return folder.replaceAll('\\', '/').split('/').filter((segment) => segment !== '').join('/')
}

/** 目录的显示名（最后一段；根目录用占位标题）。 */

/**
 * 按 `folder` 字段把笔记组织成文件夹树。
 *
 * 关键点：**中间层会被补齐**。只有 `A/B/C/x.md` 时，`A` 与 `A/B` 这两个"没有直接笔记的目录"
 * 也会作为节点存在 —— 否则嵌套容器会断链，`A/B/C` 会被挂到根上，结构就散了。
 */
export function buildFolderTree(nodes: readonly GraphNode[]): FolderTreeNode {
  const root: FolderTreeNode = {
    path: '',
    name: VAULT_ROOT_LABEL,
    notes: [],
    children: [],
    noteCount: 0,
  }
  const byPath = new Map<string, FolderTreeNode>([['', root]])

  // 排序后建树 ⇒ 同级顺序天然稳定（同一份数据每次打开的布局完全一致）
  const sorted = [...nodes].sort((left, right) => comparePaths(left.relPath, right.relPath))
  for (const node of sorted) {
    const path = normalizeFolder(node.folder)
    const folder = byPath.get(path) ?? ensureFolder(byPath, root, path)
    folder.notes.push(node)
  }

  countNotes(root)
  return root
}

function ensureFolder(
  byPath: Map<string, FolderTreeNode>,
  root: FolderTreeNode,
  path: string,
): FolderTreeNode {
  let parent = root
  let current = ''
  for (const segment of path.split('/')) {
    current = current === '' ? segment : `${current}/${segment}`
    let node = byPath.get(current)
    if (node === undefined) {
      node = { path: current, name: segment, notes: [], children: [], noteCount: 0 }
      byPath.set(current, node)
      parent.children.push(node)
    }
    parent = node
  }
  parent.children.sort((left, right) => comparePaths(left.path, right.path))
  return parent
}

function countNotes(node: FolderTreeNode): number {
  let total = node.notes.length
  for (const child of node.children) total += countNotes(child)
  node.noteCount = total
  return total
}

/** 收集所有"会出现在画布上的容器路径"（虚拟根只有在它有散笔记时才算一块）。 */
export function collectFolderPaths(root: FolderTreeNode): string[] {
  const paths: string[] = []
  if (root.notes.length > 0) paths.push('')
  const walk = (node: FolderTreeNode): void => {
    for (const child of node.children) {
      paths.push(child.path)
      walk(child)
    }
  }
  walk(root)
  return paths
}

// ---------------------------------------------------------------------------
// 装箱与网格（整齐、可预测，不引入力导向）
// ---------------------------------------------------------------------------

export interface PackResult {
  /** 每一项相对装箱原点的位置（与输入等长、同序）。 */
  positions: Point[]
  width: number
  height: number
}

/**
 * 行优先的贪心装箱（flex-wrap 的确定性版本）：从左到右放，放不下就换行。
 *
 * 为什么不用"最优装箱"：最优矩形装箱是 NP-hard，而这里只需要**可预测**——
 * 同一份数据永远得到同一份坐标，用户的手工拖动才有意义（否则每次重排都换位置）。
 */
export function packRows(sizes: readonly Size[], maxWidth: number, gap: number): PackResult {
  const positions: Point[] = []
  let x = 0
  let y = 0
  let rowHeight = 0
  let width = 0

  for (let index = 0; index < sizes.length; index += 1) {
    const size = sizes[index]
    if (size === undefined) continue
    if (x > 0 && x + size.width > maxWidth) {
      y += rowHeight + gap
      x = 0
      rowHeight = 0
    }
    positions[index] = { x, y }
    x += size.width + gap
    width = Math.max(width, x - gap)
    rowHeight = Math.max(rowHeight, size.height)
  }

  if (sizes.length === 0) return { positions, width: 0, height: 0 }
  return { positions, width, height: y + rowHeight }
}

/** 网格里第 `index` 张卡片的位置（行优先）。 */
export function gridPositions(index: number, columns: number): Point {
  const safeColumns = Math.max(1, columns)
  const column = index % safeColumns
  const row = Math.floor(index / safeColumns)
  return { x: column * (CARD_WIDTH + CARD_GAP), y: row * (CARD_HEIGHT + CARD_GAP) }
}

/** 一个容器内部内容的装箱宽度（所有容器共用同一个上限，嵌套容器因此不会互相挤成一条线）。 */
function contentRowWidth(): number {
  return CANVAS_ROW_WIDTH - CONTAINER_PADDING * 2
}

// ---------------------------------------------------------------------------
// 布局结果
// ---------------------------------------------------------------------------

export interface GraphCardBox extends Rect {
  relPath: string
  /** 卡片上要展示的内容（标题 / 标签 / 度数）都来自它。 */
  node: GraphNode
}

export interface GraphFolderBox extends Rect {
  /** POSIX 目录；`''` = Vault 根那一块。 */
  path: string
  label: string
  /** 0 = 顶层容器；嵌套容器 = 父级 + 1（只用于标题缩进与视觉层次）。 */
  depth: number
  /** 含子目录在内的笔记总数。 */
  noteCount: number
  collapsed: boolean
}

export interface GraphLayout {
  /** **可见**卡片（折叠容器里的卡片不在其中 ⇒ 它们的连线也不会画）。 */
  cards: GraphCardBox[]
  /** 全部可见容器，**前序**（父在子前）⇒ 渲染时父容器自然垫在子容器下面。 */
  folders: GraphFolderBox[]
  /** 整块画布的包围盒（"适应窗口"用它）。 */
  bounds: Rect
  /** 数据里的卡片总数。 */
  totalCards: number
  /** 因为容器折叠而隐藏的卡片数（状态栏用）。 */
  hiddenCards: number
  /** 所有可折叠容器路径（"全部收起"按钮用）。 */
  folderPaths: string[]
}

type LayoutBlock =
  | { kind: 'notes'; width: number; height: number; nodes: GraphNode[]; columns: number }
  | {
      kind: 'folder'
      width: number
      height: number
      path: string
      label: string
      depth: number
      noteCount: number
      collapsed: boolean
      children: LayoutBlock[]
      childOffsets: Point[]
      /** 内容区相对容器左上角的偏移（标题条 + 内边距）。 */
      contentOrigin: Point
    }

interface LayoutSink {
  cards: GraphCardBox[]
  folders: GraphFolderBox[]
}

/**
 * 算出整块画布的自动布局。
 *
 * 输入是 `GraphData.nodes` + 折叠集合，输出是**全部**卡片的绝对坐标 ——
 * 组件层不再做任何位置推导（也就不用每帧改每个卡片的坐标）。
 */
export function buildLayout(
  nodes: readonly GraphNode[],
  collapsed: ReadonlySet<string> = new Set<string>(),
): GraphLayout {
  const root = buildFolderTree(nodes)
  const folderPaths = collectFolderPaths(root)

  // 顶层 = 「（Vault 根）那一块」+ 各顶层文件夹。注意：顶层文件夹**不**嵌套进
  // 「（Vault 根）」里面 —— 那一块只放根目录下的散笔记，否则整个 Vault 会被套进一个大盒子里，
  // 视觉上完全看不出结构。
  const topLevel: LayoutBlock[] = []
  if (root.notes.length > 0) {
    topLevel.push(
      collapsed.has('')
        ? chipBlock('', VAULT_ROOT_LABEL, 0, root.notes.length)
        : containerBlock('', VAULT_ROOT_LABEL, 0, root.notes.length, [notesBlock(root.notes)]),
    )
  }
  for (const child of root.children) {
    topLevel.push(folderBlock(child, 0, collapsed))
  }

  const packed = packRows(
    topLevel.map((block) => ({ width: block.width, height: block.height })),
    CANVAS_ROW_WIDTH,
    CONTAINER_GAP,
  )

  const sink: LayoutSink = { cards: [], folders: [] }
  topLevel.forEach((block, index) => {
    const offset = packed.positions[index]
    if (offset === undefined) return
    placeBlock(block, { x: CANVAS_MARGIN + offset.x, y: CANVAS_MARGIN + offset.y }, sink)
  })

  return {
    cards: sink.cards,
    folders: sink.folders,
    bounds: {
      x: 0,
      y: 0,
      width: packed.width + CANVAS_MARGIN * 2,
      height: packed.height + CANVAS_MARGIN * 2,
    },
    totalCards: nodes.length,
    hiddenCards: nodes.length - sink.cards.length,
    folderPaths,
  }
}

function notesBlock(nodes: readonly GraphNode[]): LayoutBlock {
  const columns = clampNumber(Math.min(CARD_GRID_COLUMNS, nodes.length), 1, CARD_GRID_COLUMNS)
  const rows = Math.ceil(nodes.length / columns)
  return {
    kind: 'notes',
    width: columns * (CARD_WIDTH + CARD_GAP) - CARD_GAP,
    height: rows * (CARD_HEIGHT + CARD_GAP) - CARD_GAP,
    nodes: [...nodes],
    columns,
  }
}

function chipBlock(
  path: string,
  label: string,
  depth: number,
  noteCount: number,
): Extract<LayoutBlock, { kind: 'folder' }> {
  return {
    kind: 'folder',
    path,
    label,
    depth,
    noteCount,
    collapsed: true,
    // 折叠后是**紧凑卡片**：只有名字与笔记数，没有内容区
    width: FOLDER_CHIP_WIDTH,
    height: FOLDER_CHIP_HEIGHT,
    children: [],
    childOffsets: [],
    contentOrigin: { x: 0, y: 0 },
  }
}

function containerBlock(
  path: string,
  label: string,
  depth: number,
  noteCount: number,
  children: LayoutBlock[],
): LayoutBlock {
  const packed = packRows(
    children.map((child) => ({ width: child.width, height: child.height })),
    contentRowWidth(),
    CONTAINER_GAP,
  )
  return {
    kind: 'folder',
    path,
    label,
    depth,
    noteCount,
    collapsed: false,
    // 容器尺寸由内容算出来：宽度取内容宽度（不会随笔记数无限增长），高度随行数增长
    width: packed.width + CONTAINER_PADDING * 2,
    height: CONTAINER_HEADER_HEIGHT + packed.height + CONTAINER_PADDING * 2,
    children,
    childOffsets: packed.positions,
    contentOrigin: { x: CONTAINER_PADDING, y: CONTAINER_HEADER_HEIGHT + CONTAINER_PADDING },
  }
}

function folderBlock(
  node: FolderTreeNode,
  depth: number,
  collapsed: ReadonlySet<string>,
): LayoutBlock {
  if (collapsed.has(node.path)) return chipBlock(node.path, node.name, depth, node.noteCount)

  const children: LayoutBlock[] = []
  if (node.notes.length > 0) children.push(notesBlock(node.notes))
  for (const child of node.children) children.push(folderBlock(child, depth + 1, collapsed))
  return containerBlock(node.path, node.name, depth, node.noteCount, children)
}

function placeBlock(block: LayoutBlock, origin: Point, sink: LayoutSink): void {
  if (block.kind === 'notes') {
    block.nodes.forEach((node, index) => {
      const offset = gridPositions(index, block.columns)
      sink.cards.push({
        relPath: node.relPath,
        node,
        x: origin.x + offset.x,
        y: origin.y + offset.y,
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
      })
    })
    return
  }

  // 前序：父容器先入列 ⇒ 渲染顺序天然是"父在子下"，不需要手工算 z-index
  sink.folders.push({
    path: block.path,
    label: block.label,
    depth: block.depth,
    noteCount: block.noteCount,
    collapsed: block.collapsed,
    x: origin.x,
    y: origin.y,
    width: block.width,
    height: block.height,
  })
  if (block.collapsed) return // 折叠容器里没有任何子节点可画

  const contentX = origin.x + block.contentOrigin.x
  const contentY = origin.y + block.contentOrigin.y
  block.children.forEach((child, index) => {
    const offset = block.childOffsets[index]
    if (offset === undefined) return
    placeBlock(child, { x: contentX + offset.x, y: contentY + offset.y }, sink)
  })
}

/**
 * 手工拖动的位置覆盖自动布局。
 *
 * 单独一个函数（而不是塞进 `buildLayout`）是为了**性能**：拖动时每次都重算整棵文件夹树
 * 在 3000 节点上是浪费的，而这一步只是 O(n) 的坐标替换，且 `buildLayout` 的结果被
 * `useMemo` 缓存住（拖动期间自动布局不重算）。
 */
export function applyManualPositions(
  layout: GraphLayout,
  manual: ReadonlyMap<string, Point>,
): GraphLayout {
  if (manual.size === 0) return layout
  let changed = false
  const cards = layout.cards.map((card) => {
    const override = manual.get(card.relPath)
    if (override === undefined) return card
    if (override.x === card.x && override.y === card.y) return card
    changed = true
    return { ...card, x: override.x, y: override.y }
  })
  return changed ? { ...layout, cards } : layout
}

/** 清掉不在当前数据里的手工位置（Vault 里删掉的笔记不该永远占着 localStorage）。 */
export function pruneManualPositions(
  manual: ReadonlyMap<string, Point>,
  nodes: readonly GraphNode[],
): Map<string, Point> {
  if (manual.size === 0) return new Map()
  const alive = new Set(nodes.map((node) => node.relPath))
  const next = new Map<string, Point>()
  for (const [relPath, point] of manual) {
    if (alive.has(relPath)) next.set(relPath, point)
  }
  return next
}

/**
 * 视口换算到世界坐标（含 overscan）。
 *
 * 单独一个纯函数是为了让"只渲染相交项"这件事可测：给定视口与同一份布局，
 * 无论走索引还是线性扫描，结果必须一致（`tests/features/graph/graph.test.tsx` 里就钉住了这一点）。
 */
export function worldViewport(
  view: GraphView,
  size: Size,
  overscan: number = OVERSCAN,
): Rect {
  const zoom = clampZoom(view.zoom)
  const pad = overscan / zoom
  return {
    x: -view.x / zoom - pad,
    y: -view.y / zoom - pad,
    width: size.width / zoom + pad * 2,
    height: size.height / zoom + pad * 2,
  }
}

// ---------------------------------------------------------------------------
// 缩放与适应窗口
// ---------------------------------------------------------------------------

/** 以 `focal`（屏幕坐标）为锚点缩放：锚点下的世界坐标保持不动。 */
export function zoomAround(
  view: GraphView,
  factor: number,
  focal: Point,
  min: number = MIN_ZOOM,
  max: number = MAX_ZOOM,
): GraphView {
  const zoom = view.zoom
  const next = clampNumber(zoom * factor, min, max)
  if (next === zoom) return view
  const worldX = (focal.x - view.x) / zoom
  const worldY = (focal.y - view.y) / zoom
  return { zoom: next, x: focal.x - worldX * next, y: focal.y - worldY * next }
}

export function panBy(view: GraphView, dx: number, dy: number): GraphView {
  if (dx === 0 && dy === 0) return view
  return { ...view, x: view.x + dx, y: view.y + dy }
}

/** 让整块画布刚好落进视口（`0` 键）。缩放仍受 MIN/MAX 限制。 */
export function fitView(bounds: Rect, size: Size, padding = FIT_PADDING): GraphView {
  const usableWidth = Math.max(1, size.width - padding * 2)
  const usableHeight = Math.max(1, size.height - padding * 2)
  const zoom = clampZoom(
    Math.min(usableWidth / Math.max(1, bounds.width), usableHeight / Math.max(1, bounds.height)),
  )
  return {
    zoom,
    x: (size.width - bounds.width * zoom) / 2 - bounds.x * zoom,
    y: (size.height - bounds.height * zoom) / 2 - bounds.y * zoom,
  }
}
