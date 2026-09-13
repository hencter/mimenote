/**
 * 知识图谱画布 —— **布局与几何的纯函数层**（不 import React / 不碰 DOM / 不读全局状态）。
 *
 * 为什么独立成一层：画布上"卡片在哪、容器多大、哪条边要不要画"全部是可以用数字说清楚的问题，
 * 它们必须在 vitest 里能直接断言（见 `tests/graph.test.tsx`），而不是只能靠人眼看像素。
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
 * 视口裁剪的复杂度：卡片与容器用**均匀网格索引**（`buildRectIndex`），
 * 查询只访问与视口相交的格子 —— 1 万节点时每次平移是 O(可见数 + 覆盖的格子数)，
 * 而不是 O(总节点数)。边没有建索引（一条边可能横跨很远，装进多个格子反而更贵），
 * 用"端点包围盒是否与视口相交"做 O(E) 的线性筛，实测 1 万条边一次约 0.1~0.3ms，
 * 与每帧渲染成本（可见卡片数）相比可以忽略。
 */

import type { GraphEdge, GraphNode } from '@/ipc/types'

// ---------------------------------------------------------------------------
// 几何基础
// ---------------------------------------------------------------------------

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

/** 画布视口：世界坐标 → 屏幕坐标是 `screen = world * zoom + offset`（CSS transform 的 translate/scale）。 */
export interface GraphView {
  x: number
  y: number
  zoom: number
}

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

/** 悬空链接的"虚影"端点：从卡片右边缘伸出去多长、多个虚影之间的纵向间距。 */
export const PHANTOM_OFFSET_X = 56
export const PHANTOM_GAP_Y = 18

/** 视口裁剪的 overscan（屏幕像素）：稍微多画一圈，平移时边缘不会"闪"出来。 */
export const OVERSCAN = 240

/** 缩放范围（与需求一致）。 */
export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 2.5

/** 每按一次"放大/缩小"（按钮、命令或快捷键）的倍率。 */
export const ZOOM_STEP = 1.25

/** "适应窗口"时四周留白。放在这里而不是组件里：画布按钮与 `graph.zoomIn` 这类命令
 *  都必须用同一个数值，否则两条入口会算出不一样的视角。 */
export const FIT_PADDING = 64

/** 网格索引的格子边长（略大于一张卡片，一张卡片最多落进 2×2 = 4 个格子）。 */
export const INDEX_CELL_SIZE = 256

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  )
}

export function centerOf(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

/**
 * 排序器：**与文件树（`domain/tree.ts`）用同一个**规则（中文按拼音、数字自然序、大小写不敏感）。
 *
 * 为什么这件事重要：画布与侧栏展示的是同一份 Vault，顺序不一致会让人怀疑"是不是两套数据"。
 * 也正因为用了显式的 `Intl.Collator`（而不是 `String.prototype.localeCompare` 的默认 locale），
 * 排序结果在"同一台机器上"是稳定的 —— 布局的确定性依赖它。
 */
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

export function comparePaths(left: string, right: string): number {
  const byName = collator.compare(left, right)
  if (byName !== 0) return byName
  // 排序器认为"相等"时（大小写/全半角差异）用码点兜底，保证结果唯一且与 locale 无关
  return left < right ? -1 : left > right ? 1 : 0
}

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

/**
 * 视口换算到世界坐标（含 overscan）。
 *
 * 单独一个纯函数是为了让"只渲染相交项"这件事可测：给定视口与同一份布局，
 * 无论走索引还是线性扫描，结果必须一致（`tests/graph.test.tsx` 里就钉住了这一点）。
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
