/**
 * **容器切割树**：主界面的布局模型（ADR-0035）。
 *
 * ## 它解决什么
 * 用户对布局的要求最终收敛成一句话：**每个模块都是"标签 + 内容"，标签可以随便拖到别的容器里**。
 * 而在此之前，界面上有**两套互不相干的机制**：
 *
 * - 视图模块（文件树 / 链接 / 标签 / 大纲）走 ADR-0026 的"三个固定停靠区 + 区内一条列表"；
 * - 笔记走 `tabs-store` 的"全窗口唯一一条标签栏"，且**不能搬区**。
 *
 * 这个模块把两者换成**一棵二叉切割树**：
 *
 * ```text
 * TreeLayout = Split { axis, ratio, a, b }      // 一刀切成两半（row = 左右、column = 上下）
 *            | Leaf  { items, active }          // 一个叶子：一条标签栏 + 一块内容
 * ```
 *
 * 于是"把文件树拖到右边"和"把某篇笔记拖到下面"是**同一个操作**，只是被拖的标签不同。
 *
 * ## 与 ADR-0026 的关系
 * 那是这个模型的**退化特例**：固定三刀 + 每区一条互不分栏的列表。迁移由
 * {@link fromDockLayout} 给出（左区多块模块 → 竖直切两刀，视觉上仍≈平分高度）。
 *
 * ## 六条不变式（本模块存在的全部理由）
 * 1. **每个标签全树恰好出现一次** —— 拖过去就是**移过去**（同一篇笔记不会同时出现在两个叶子里：
 *    `note-store` 是单文档模型，冲突令牌 / 自动保存 / 撤销历史都只有一份）；
 * 2. **空叶塌缩**（父节点被兄弟替换），但有两个例外：**整棵树至少留一个叶子**（那个叶子
 *    可以为空），以及**主叶（`main`）允许为空** —— "还没有打开任何笔记"是正常状态，
 *    而主叶是笔记的**默认落点**：它若因为暂时为空就被塌缩掉，下一篇打开的笔记会被
 *    对账挂到 DFS 的第一个叶子（通常是文件树那一格）里 —— 真实踩到的坑，
 *    见 `layout-sync.ts` 与 ADR-0035 的后续修订；
 * 3. **比例夹在 [MIN_RATIO, MAX_RATIO]** —— 否则一刀就能把一格拖成 0 像素而再也拖不回来；
 * 4. **认不出的标签一律丢弃** —— 版本升级 / 功能下线之后，老配置不能把界面卡死；
 * 5. **至少一个叶子**、整棵树始终合法；不合法就退回 {@link defaultLayout}（降级方向安全）；
 * 6. **`active` 必须是本叶的标签之一**（否则取第一个；叶空则 null）—— 它只描述"这一格现在显示谁"，
 *    不参与"谁在哪"。
 *
 * 本模块是**纯函数**：不 import React / store / IPC，所有操作返回新树（旧树不动），
 * 因此可以被单测逐条钉住，也可以被随机的操作序列反复捶（见 `tests/tree-layout.test.ts`）。
 */

/** 切割方向。`row` = 一刀竖着切（左右并排）；`column` = 一刀横着切（上下相叠）。 */
export type SplitAxis = 'row' | 'column'

/** 视图模块（今天由 `features/dock/dock-layout.ts` 管的那四种）。 */
export type ViewModuleId = 'tree' | 'links' | 'tags' | 'outline'

/** 标签（= 可被拖动的东西）。视图模块是裸词，笔记带 `note:` 前缀避免撞名。 */
export type LayoutItemId = ViewModuleId | `note:${string}`

export interface LeafNode {
  kind: 'leaf'
  id: string
  /** 这一格的标签（顺序 = 标签栏里的顺序）。空 = 还没显示任何东西（**只有主叶允许为空**，见不变式 2）。 */
  items: LayoutItemId[]
  /** 这一格现在显示谁。 */
  active: LayoutItemId | null
}

export interface SplitNode {
  kind: 'split'
  id: string
  axis: SplitAxis
  /** 前半（a）占的比例，夹在 [MIN_RATIO, MAX_RATIO]。 */
  ratio: number
  a: TreeLayout
  b: TreeLayout
}

export type TreeLayout = LeafNode | SplitNode

/** 比例上下限：给每一边留出可点可拖的最小宽度。 */
export const MIN_RATIO = 0.15
export const MAX_RATIO = 0.85

/**
 * 一格在切割方向上的**绝对最小尺寸**（px）。
 *
 * 不变式 3 的比例钳制是**相对父容器**的：嵌套切割时 0.15 连乘，绝对宽度可以任意小
 * （真实踩到：两级 0.15 嵌套在 2000px 窗口里切出 ≈31px 的窄叶，面板内容被压成
 * 逐字竖排，既不可读、几像素宽的分隔条也几乎拖不回来）。拖分隔条与"切一刀给家尺寸"
 * 都必须同时满足这一下限 —— 见 {@link clampRatioForExtent}。
 */
export const MIN_LEAF_PIXELS = 120

/**
 * 窄格的**降级阈值**（px）：小于它时渲染层把内容收起、只留标签条。
 *
 * 已落盘的旧窄叶与极端小窗口绕不过 {@link MIN_LEAF_PIXELS}（比例钳制拦不住历史数据），
 * 这一档保证它们呈现为"一条标签条"而不是逐字竖排的废条 —— 标签仍然可点可拖，
 * 把标签拖走就是窄格的自救出口。取值约为最小尺寸的一半强：既不误伤"小但可用"的格子，
 * 也兜住几十像素的病态窄叶。
 */
export const NARROW_LEAF_PIXELS = 72

/**
 * 比例钳制的**像素加强版**：在 {@link MIN_RATIO}..{@link MAX_RATIO} 之上，再保证
 * 切完之后两边都不小于 {@link MIN_LEAF_PIXELS}（像素下限换算成这一刀的比例份额，
 * 与比例钳制取更严者）。
 *
 * 容器本身不足两个下限（窗口太小）时退回比例钳制 —— 下限是为了"不造出废格"，
 * 不该在小窗口上制造"怎么夹都不合法"。`extentPx` 量不到（jsdom）时同样退回。
 */
export function clampRatioForExtent(ratio: number, extentPx: number): number {
  const base = clampRatio(ratio)
  if (!Number.isFinite(extentPx) || extentPx <= 0) return base
  const minShare = MIN_LEAF_PIXELS / extentPx
  if (minShare * 2 >= 1) return base
  return Math.min(1 - minShare, Math.max(minShare, base))
}

/** 四种视图模块（顺序即默认左叶里的顺序）。 */
export const VIEW_MODULE_IDS: readonly ViewModuleId[] = ['tree', 'links', 'tags', 'outline']

/**
 * 模块元信息（标签条与菜单上给人看的字）。
 *
 * 原来住在 `features/dock/dock-layout.ts`（`DOCK_MODULES`）；树接管渲染之后，
 * 模块的身份与文案归这里 —— 停靠文件只保留"旧落盘格式"的读取面。
 */
export const VIEW_MODULES: Readonly<Record<ViewModuleId, { label: string; hint: string }>> = {
  tree: { label: '文件', hint: '文件树（Vault 的目录与笔记）' },
  links: { label: '链接', hint: '反向链接与出链' },
  tags: { label: '标签', hint: '本篇标签、属性与全库标签' },
  outline: { label: '大纲', hint: '当前笔记的标题树' },
}

/** 把一个 Vault 相对路径包成笔记标签。 */
export function noteItem(relPath: string): LayoutItemId {
  return `note:${relPath}`
}

/** 笔记标签 → 相对路径；不是笔记标签时返回 `null`。 */
export function notePathOf(item: LayoutItemId): string | null {
  return item.startsWith('note:') ? item.slice('note:'.length) : null
}

/** 是不是视图模块标签。 */
export function isViewModule(item: LayoutItemId): item is ViewModuleId {
  return (VIEW_MODULE_IDS as readonly string[]).includes(item)
}

// ---------------------------------------------------------------------------
// 遍历与查询
// ---------------------------------------------------------------------------

/** 深度优先遍历所有节点（先父后子）。 */
export function walk(node: TreeLayout, visit: (node: TreeLayout) => void): void {
  visit(node)
  if (node.kind === 'split') {
    walk(node.a, visit)
    walk(node.b, visit)
  }
}

/** 所有叶子（按从左到右、从上到下的顺序）。 */
export function leaves(layout: TreeLayout): LeafNode[] {
  const found: LeafNode[] = []
  walk(layout, (node) => {
    if (node.kind === 'leaf') found.push(node)
  })
  return found
}

/** 按 id 找叶子。 */
export function findLeaf(layout: TreeLayout, leafId: string): LeafNode | null {
  for (const leaf of leaves(layout)) {
    if (leaf.id === leafId) return leaf
  }
  return null
}

/** 某个标签在哪个叶子里（不在树里返回 `null`）—— 不变式 1 的查询面。 */
export function leafOfItem(layout: TreeLayout, item: LayoutItemId): LeafNode | null {
  for (const leaf of leaves(layout)) {
    if (leaf.items.includes(item)) return leaf
  }
  return null
}

/** 全树的标签（不变式 1 的检查面：应当无重复）。 */
export function itemsOf(layout: TreeLayout): LayoutItemId[] {
  return leaves(layout).flatMap((leaf) => leaf.items)
}

/**
 * 这棵子树**该不该渲染**（渲染层的收缩判据）。
 *
 * 收缩的触发条件是"叶子里**有**标签但全被隐藏"（用户关掉了那些面板，见 ADR-0035
 * 「隐藏 ≠ 移除」：树里什么都不变，只是画面上那一格暂时不在）。
 * **空叶永远渲染**：它是"还没有打开任何笔记"的占位空态，不是需要收缩掉的隐藏面板 ——
 * 不这么判的话，默认布局（一个空主叶 + 模块叶）在关掉全部面板后连主区都会消失。
 */
export function subtreeRenderable(
  node: TreeLayout,
  isVisible: (item: LayoutItemId) => boolean,
): boolean {
  if (node.kind === 'leaf') return node.items.length === 0 || node.items.some(isVisible)
  return subtreeRenderable(node.a, isVisible) || subtreeRenderable(node.b, isVisible)
}

// ---------------------------------------------------------------------------
// 规范化（结构校验 + 六条不变式）
// ---------------------------------------------------------------------------

export interface NormalizeOptions {
  /**
   * 这个标签还认不认。默认：视图模块一律认；`note:` 一律认
   * （笔记是否还存在由上层对账 —— 删掉的笔记打不开，标签会自己消失）。
   */
  isKnownItem?: (item: LayoutItemId) => boolean
  /** 结构非法时用的兜底树。 */
  fallback?: TreeLayout
}

const defaultKnownItem = (item: LayoutItemId): boolean =>
  isViewModule(item) || notePathOf(item) !== null

/**
 * 把任意输入（通常是 localStorage 里的 JSON）规范成一棵**合法**的树。
 *
 * 顺序刻意如此：先剔掉认不出的标签 ⇒ 再塌缩空叶 ⇒ 再修 `active` ⇒ 最后夹紧比例。
 * 反过来（先夹比例再塌缩）会在"整棵树只剩一个空叶"时留下一个 `ratio` 已经被改过的残骸。
 */
export function normalizeLayout(raw: unknown, options: NormalizeOptions = {}): TreeLayout {
  const fallback = options.fallback ?? defaultLayout()
  const isKnown = options.isKnownItem ?? defaultKnownItem
  const seen = new Set<LayoutItemId>()

  const parse = (value: unknown, depth: number): TreeLayout | null => {
    // 深度上限：合法树最深也就十几层，防止畸形输入把递归打爆
    if (depth > 32 || typeof value !== 'object' || value === null) return null
    const node = value as Record<string, unknown>

    if (node['kind'] === 'leaf') {
      const id = typeof node['id'] === 'string' && node['id'] !== '' ? node['id'] : null
      if (id === null) return null
      const rawItems = Array.isArray(node['items']) ? node['items'] : []
      const items: LayoutItemId[] = []
      for (const candidate of rawItems) {
        if (typeof candidate !== 'string') continue
        const item = candidate as LayoutItemId
        // 不变式 4：认不出的丢掉；不变式 1：重复的只留第一份
        if (!isKnown(item) || seen.has(item)) continue
        seen.add(item)
        items.push(item)
      }
      // 不变式 2：空叶不留在树里（交给调用方塌缩）—— 但**主叶允许为空**（它是笔记的默认落点，
      // 塌缩掉它，下一篇笔记就会被挂进文件树那一格；见文件头不变式 2 的注释）。
      // 整棵树都空时由下面的兜底给出默认布局
      if (items.length === 0 && id !== DEFAULT_MAIN_LEAF_ID) return null
      const active =
        typeof node['active'] === 'string' && items.includes(node['active'] as LayoutItemId)
          ? (node['active'] as LayoutItemId)
          : (items[0] ?? null)
      return { kind: 'leaf', id, items, active }
    }

    if (node['kind'] === 'split') {
      const id = typeof node['id'] === 'string' && node['id'] !== '' ? node['id'] : null
      if (id === null) return null
      const axis: SplitAxis = node['axis'] === 'column' ? 'column' : 'row'
      const a = parse(node['a'], depth + 1)
      const b = parse(node['b'], depth + 1)
      // 塌缩：只有一边活着时，父节点被那一边替换（不变式 2 的另一半）
      if (a === null && b === null) return null
      if (a === null) return b
      if (b === null) return a
      const ratio = typeof node['ratio'] === 'number' ? clampRatio(node['ratio']) : 0.5
      return { kind: 'split', id, axis, ratio, a, b }
    }

    return null
  }

  return adoptMainLeaf(parse(raw, 0) ?? fallback)
}

/**
 * 树里**必须有一个主叶**：没有 `main` 时，把"没有任何视图模块的那一格"认作主叶（连同它的 id 改名）。
 *
 * 为什么需要它（用户报的 bug 的根因）：`leaves()` 是 DFS 序，而模块的家把**文件树放在最左**，
 * 所以"找不到 main 就退回第一个叶"退到的通常正是文件树那一格 —— 新打开的笔记会被挂进文件树里，
 * 用户看到的就是「点了文件，它跑到文件树那个容器去了」。而 `main` 的 id 是会被切分吃掉的：
 * 用户把笔记从主叶拖到别的格子、主叶空掉之后，虽然 `normalizeLayout` 会**保住空的主叶**，
 * 但用户手上那份布局经过一串切割之后 `main` 已经不在了（实测：`left-tree~b~b-2` 那样一串 id，
 * 一格都没有 main），于是从那以后每篇笔记都落进文件树那一格。
 *
 * 为什么是"改名"而不是"新建一格"：位置是用户摆的，凭空插一格会改布局；而 id 是**内部**标识
 * （不出现在界面上），把"显然就是内容区的那一格"认成主叶，既不动物理布局，又把不变式补回来 ——
 * 而且从此以后它和其它主叶一样**允许为空**（空叶不塌缩），笔记永远有家。
 */
function adoptMainLeaf(layout: TreeLayout): TreeLayout {
  const all = leaves(layout)
  if (all.some((leaf) => leaf.id === DEFAULT_MAIN_LEAF_ID)) return layout
  const content = all.find((leaf) => leaf.items.every((item) => !isViewModule(item)))
  if (content === undefined) return layout
  const rename = (node: TreeLayout): TreeLayout => {
    if (node.kind === 'leaf') return node.id === content.id ? { ...node, id: DEFAULT_MAIN_LEAF_ID } : node
    return { ...node, a: rename(node.a), b: rename(node.b) }
  }
  return rename(layout)
}

/**
 * 在树上**没被用过**的 id：给"切一刀"生成新节点用。
 *
 * 为什么不能简单地用 `${目标叶}~b`：切一刀之后**目标叶仍在树上**（它只是多了一个兄弟），
 * 所以同一个叶被切第二次就会再造出一个同名叶 —— 两个叶子共用一个 id，`findLeaf` / 落盘
 * 对位 / React key 全部会错位（真实踩到：对账时连续挂四个模块，树上出现四个 `main~b`）。
 */
function uniqueId(layout: TreeLayout, base: string): string {
  const used = new Set<string>()
  walk(layout, (node) => used.add(node.id))
  if (!used.has(base)) return base
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!used.has(candidate)) return candidate
  }
}

/** 两棵树结构上是否**逐字相同**（对账用它决定"要不要写盘"）。 */
export function layoutsEqual(a: TreeLayout, b: TreeLayout): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false
  if (a.kind === 'leaf' && b.kind === 'leaf') {
    return (
      a.active === b.active &&
      a.items.length === b.items.length &&
      a.items.every((item, index) => item === b.items[index])
    )
  }
  if (a.kind === 'split' && b.kind === 'split') {
    return (
      a.axis === b.axis &&
      a.ratio === b.ratio &&
      layoutsEqual(a.a, b.a) &&
      layoutsEqual(a.b, b.b)
    )
  }
  return false
}

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
}

// ---------------------------------------------------------------------------
// 操作（全部返回新树）
// ---------------------------------------------------------------------------

/**
 * 移动一个标签到目标叶子的**中心**（成为那一格的一个标签）或某条**边缘**（在那里切一刀）。
 *
 * - 已经在目标叶里 → 只调整顺序 / 激活项，不重复插入（不变式 1）；
 * - `edge` 的分割方向由边缘决定：左/右 → `row`，上/下 → `column`；被拖的标签落在那一侧；
 * - 拖到自己所在叶子的边缘是**无操作**（切出一格只装自己、原格少一个标签），
 *   这条由调用方（拖拽层）拦下并给提示，模型这里也照样安全。
 */
export function moveItem(
  layout: TreeLayout,
  item: LayoutItemId,
  target: { leafId: string; edge?: 'left' | 'right' | 'top' | 'bottom'; index?: number },
): TreeLayout {
  const source = leafOfItem(layout, item)
  if (source === null) return layout
  const targetLeaf = findLeaf(layout, target.leafId)
  if (targetLeaf === null) return layout

  const edge = target.edge ?? 'center'
  const removed = removeItemFromLeaf(layout, source.id, item)
  if (edge === 'center') {
    const at = target.index ?? null
    return normalizeLayout(insertIntoLeaf(removed, target.leafId, item, at), { fallback: layout })
  }

  // 切一刀：把目标叶换成 split，被拖的标签独占新叶
  const axis: SplitAxis = edge === 'left' || edge === 'right' ? 'row' : 'column'
  const before = edge === 'left' || edge === 'top'
  const newLeaf: LeafNode = {
    kind: 'leaf',
    id: uniqueId(removed, `${target.leafId}~b`),
    items: [item],
    active: item,
  }
  const withSplit = replaceLeaf(removed, target.leafId, (leaf) => ({
    kind: 'split',
    id: uniqueId(removed, `${target.leafId}~split`),
    axis,
    ratio: 0.5,
    a: before ? newLeaf : leaf,
    b: before ? leaf : newLeaf,
  }))
  return normalizeLayout(withSplit, { fallback: layout })
}

/** 从树里彻底移除一个标签（关掉一个标签 / 一个视图模块下线）。 */
export function removeItem(layout: TreeLayout, item: LayoutItemId): TreeLayout {
  const leaf = leafOfItem(layout, item)
  if (leaf === null) return layout
  return normalizeLayout(removeItemFromLeaf(layout, leaf.id, item), { fallback: layout })
}

/** 设某一格现在显示谁（必须是那一格的标签）。 */
export function setActive(layout: TreeLayout, leafId: string, item: LayoutItemId): TreeLayout {
  return replaceLeaf(layout, leafId, (leaf) =>
    leaf.items.includes(item) ? { ...leaf, active: item } : leaf,
  )
}

/** 调一条分隔线的比例（自动夹紧）。 */
export function setRatio(layout: TreeLayout, splitId: string, ratio: number): TreeLayout {
  const update = (node: TreeLayout): TreeLayout => {
    if (node.kind === 'leaf') return node
    if (node.id === splitId) return { ...node, ratio: clampRatio(ratio) }
    return { ...node, a: update(node.a), b: update(node.b) }
  }
  return update(layout)
}

/** 把某一格的两半均分。 */
export function evenSplit(layout: TreeLayout, splitId: string): TreeLayout {
  return setRatio(layout, splitId, 0.5)
}

function removeItemFromLeaf(layout: TreeLayout, leafId: string, item: LayoutItemId): TreeLayout {
  return replaceLeaf(layout, leafId, (leaf) => {
    // 空叶由 `normalizeLayout` 塌缩掉，所以这里可以放心先造一个空叶
    const items = leaf.items.filter((candidate) => candidate !== item)
    const active = leaf.active === item ? (items[0] ?? null) : leaf.active
    return { ...leaf, items, active }
  })
}

function insertIntoLeaf(
  layout: TreeLayout,
  leafId: string,
  item: LayoutItemId,
  index: number | null,
): TreeLayout {
  return replaceLeaf(layout, leafId, (leaf) => {
    if (leaf.items.includes(item)) {
      // 已经在这一格里：只把激活项挪过去（不变式 1 不允许重复）
      return { ...leaf, active: item }
    }
    const items = [...leaf.items]
    items.splice(index === null ? items.length : Math.max(0, Math.min(index, items.length)), 0, item)
    return { ...leaf, items, active: item }
  })
}

/**
 * 把某个叶子替换成别的节点。
 *
 * 空叶的处理在这里收口：替换结果如果是"没有标签的叶子"，就直接把它从树上摘掉
 * （交给 `normalizeLayout` 的塌缩逻辑）—— 这一步让上面每个操作都不必自己处理空叶。
 */
function replaceLeaf(
  layout: TreeLayout,
  leafId: string,
  create: (leaf: LeafNode) => TreeLayout,
): TreeLayout {
  if (layout.kind === 'leaf') {
    return layout.id === leafId ? create(layout) : layout
  }
  return {
    ...layout,
    a: replaceLeaf(layout.a, leafId, create),
    b: replaceLeaf(layout.b, leafId, create),
  }
}

// ---------------------------------------------------------------------------
// 默认布局与迁移
// ---------------------------------------------------------------------------

/** 默认布局的节点 id（固定值，便于测试与落盘对位）。 */
export const DEFAULT_MAIN_LEAF_ID = 'main'
/**
 * 默认布局：一个主叶（笔记标签住在里面）。
 *
 * 视图模块**不预置**：它们由停靠开关（`Ctrl+B` 等）决定要不要出现在树上 ——
 * 出现时由 {@link attachItem} 插到主叶左侧或右侧（调用方给落点），
 * 于是"我从来没用过大纲"的用户不会先看到一格空的。
 */
export function defaultLayout(): TreeLayout {
  return { kind: 'leaf', id: DEFAULT_MAIN_LEAF_ID, items: [], active: null }
}

/** 迁移时的尺寸线索：把旧的**像素**偏好换算成树的比例（只在大搬家时用一次）。 */
export interface MigrateSizes {
  /** 旧左区宽度（px，缺省 288 = 旧默认）。 */
  sidebarWidth?: number
  /** 旧右区宽度（px，缺省 300）。 */
  linksPanelWidth?: number
  /** 旧底区高度（px，缺省 220）。 */
  bottomDockHeight?: number
  /** 窗口尺寸（比例的**分母**；缺省 1280×800 = 最常见桌面窗口）。 */
  viewport?: { width: number; height: number }
}

/**
 * 从 ADR-0026 的停靠布局迁移（老用户的配置不丢）。
 *
 * 形态照抄旧模型的几何：**左/右区里多块模块是上下叠（平分该侧高度）、底区里是左右排
 * （平分该区宽度）**，而整条左带在主区左侧、右带在右侧、底带在下方。于是：
 *
 * ```text
 * row[ column[左带…], column[ row[ main, 右带… ], 底带… ] ]
 * ```
 *
 * 比例不是一律 0.5：那会让文件树独占半个窗口（旧默认是 288px）。迁移把旧的**像素宽度**
 * 按窗口尺寸换算成比例（见 `MigrateSizes`），观感与升级前一致；换算的分母只在迁移这一刻
 * 用一次，之后拖分隔条改的就是比例本身。
 *
 * 一处**知道的差异**：旧模型里同一区的模块是"各自占满该区宽度、上下平分"，
 * 而这里每个模块是一个独立叶子，中间多了可拖的分隔条 —— 观感接近，但可以分别调比例
 * （这正是用户要的"容器切割"）。
 */
export function fromDockLayout(
  dock: { left: readonly ViewModuleId[]; right: readonly ViewModuleId[]; bottom: readonly ViewModuleId[] },
  notes: readonly string[] = [],
  sizes: MigrateSizes = {},
): TreeLayout {
  const main: LeafNode = {
    kind: 'leaf',
    id: DEFAULT_MAIN_LEAF_ID,
    items: notes.map(noteItem),
    active: notes.length > 0 ? noteItem(notes[0]!) : null,
  }

  // 迁移几何的分母（见 `MigrateSizes`）：钳到合理区间，防止 0 / NaN / 极小窗口把比例算爆
  const viewportW = Math.max(320, sizes.viewport?.width ?? 1280)
  const viewportH = Math.max(240, sizes.viewport?.height ?? 800)
  const leftPx = dock.left.length > 0 ? (sizes.sidebarWidth ?? 288) : 0
  const rightPx = dock.right.length > 0 ? (sizes.linksPanelWidth ?? 300) : 0
  const bottomPx = dock.bottom.length > 0 ? (sizes.bottomDockHeight ?? 220) : 0

  /** 把一串模块做成一条带：**上下叠**（`column`）或**左右排**（`row`），比例各半 ⇒ 等价于旧的"平分"。 */
  const strip = (
    side: 'left' | 'right' | 'bottom',
    modules: readonly ViewModuleId[],
    axis: SplitAxis,
  ): TreeLayout | null => {
    let tree: TreeLayout | null = null
    for (const module of modules) {
      const leaf: LeafNode = { kind: 'leaf', id: `${side}-${module}`, items: [module], active: module }
      tree =
        tree === null
          ? leaf
          : {
              kind: 'split',
              id: `${side}-${module}~split`,
              axis,
              ratio: 0.5,
              a: tree,
              b: leaf,
            }
    }
    return tree
  }

  const left = strip('left', dock.left, 'column')
  const right = strip('right', dock.right, 'column')
  const bottom = strip('bottom', dock.bottom, 'row')

  let center: TreeLayout = main
  if (right !== null) {
    // 这一刀分的是"左带之外"的宽度：main 占 (剩余 − 右带)
    const restW = viewportW - leftPx
    center = {
      kind: 'split',
      id: 'right~split',
      axis: 'row',
      ratio: clampRatio(restW <= 0 ? 0.5 : (restW - rightPx) / restW),
      a: center,
      b: right,
    }
  }
  if (bottom !== null) {
    // 这一刀分的是整列高度：上半（main + 右带）占 (高度 − 底带)
    center = {
      kind: 'split',
      id: 'bottom~split',
      axis: 'column',
      ratio: clampRatio((viewportH - bottomPx) / viewportH),
      a: center,
      b: bottom,
    }
  }
  const tree: TreeLayout = left === null
    ? center
    : {
        kind: 'split',
        id: 'left~split',
        axis: 'row',
        ratio: clampRatio(leftPx / viewportW),
        a: left,
        b: center,
      }

  return normalizeLayout(tree)
}

/**
 * **内容叶**：新笔记该落到哪一格（`null` = 整棵树里一格内容区都没有）。
 *
 * 判据按顺序：
 * 1. `main` 那一格 —— 切割树的**主叶**（笔记的默认落点，也是模块"往左/右/下切一刀"的锚点）；
 * 2. 没有任何视图模块的那一格 —— 老配置里 `main` 的 id 可能已经不在了（用户手上那份布局就是这样：
 *    一串 `left-tree~b~b-2` 之类的 id，一格 main 都没有），而"没有模块的那一格"就是内容区；
 * 3. 都没有 ⇒ `null`，调用方自己决定（`attachItem` 会退到最左边的叶）。
 *
 * ⚠️ 这里（以及 `layout-sync.mainLeafId`）以前都是 `?? all[0]`。`leaves()` 是 DFS 序，
 * 而模块的家（`DEFAULT_MODULE_HOME`）把**文件树放在最左**，于是 `all[0]` 常常正是文件树那一格
 * —— 新笔记会被挂进文件树里，看起来就是"点了文件，它跑到文件树那个容器去了"（用户报的）。
 */
export function contentLeafId(layout: TreeLayout): string | null {
  const all = leaves(layout)
  const main = all.find((leaf) => leaf.id === DEFAULT_MAIN_LEAF_ID)
  if (main !== undefined) return main.id
  const content = all.find((leaf) => leaf.items.every((item) => !isViewModule(item)))
  return content?.id ?? null
}

/**
 * **右上叶**：贴着窗口右上角的那一格（窗口按钮的宿主，ADR-0038）。
 *
 * 走法就一句：`row` 刀往右（`b`）、`column` 刀往上（`a`）—— 递归到底就是"最右侧、且在同列里
 * 最靠上"的那一格。**不可渲染的半边直接跳过**（被隐藏的面板不占空间），所以这个判据与
 * 渲染器实际画出来的树逐格一致：用户把右侧面板收起来时，按钮自然回到剩下的最右一格。
 *
 * 为什么不按 `main` / 当前文档格找：右停靠面板（链接/标签/大纲）的家就在主叶右边，
 * 按钮跟着主叶走会停在窗口**中间**（用户报的"放错位置了"）。
 *
 * `null` = 整棵树都不可渲染（渲染层会退回兜底空态，按钮由那里自己兜住）。
 */
export function topRightLeafId(
  layout: TreeLayout,
  isVisible: (item: LayoutItemId) => boolean,
): string | null {
  // 不可渲染的叶（有标签但全被隐藏）不占空间 ⇒ 它没有"右上"可言
  if (layout.kind === 'leaf') return subtreeRenderable(layout, isVisible) ? layout.id : null
  const a = topRightLeafId(layout.a, isVisible)
  const b = topRightLeafId(layout.b, isVisible)
  // 半边不可渲染就取另一半；都在时 row 取右（b）、column 取上（a）
  if (a === null) return b
  if (b === null) return a
  return layout.axis === 'row' ? b : a
}

/**
 * 把一个标签插到某个叶子旁边（没有就在右侧切一刀）。
 *
 * 用途：打开一篇笔记 / 显示一个视图模块。**不**检查唯一性 —— 交给
 * {@link normalizeLayout} 去重（不变式 1 只有一处实现）。
 */
export function attachItem(
  layout: TreeLayout,
  item: LayoutItemId,
  target: { leafId?: string; edge?: 'left' | 'right' | 'top' | 'bottom' } = {},
): TreeLayout {
  // 默认落点是**内容叶**（`contentLeafId`：主叶 → 没有任何视图模块的那一格）。
  // 不能退回"DFS 的第一个叶"：那通常是**文件树那一格**，新打开的笔记会挂进文件树里
  // —— 真实踩到过两次：一次是对账用例抓到的，一次是用户报的"点文件跑到文件树那个容器里去了"。
  const all = leaves(layout)
  const leafId = target.leafId ?? contentLeafId(layout) ?? all[0]?.id
  if (leafId === undefined) {
    return normalizeLayout({ kind: 'leaf', id: DEFAULT_MAIN_LEAF_ID, items: [item], active: item })
  }
  return moveItem(
    // 先"放"进树里（若已在别处，`moveItem` 会把它移过来）
    leafOfItem(layout, item) === null ? insertIntoLeaf(layout, leafId, item, null) : layout,
    item,
    { leafId, edge: target.edge },
  )
}
