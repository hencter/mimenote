/**
 * 分栏（Miller columns）文件树的**列模型**：纯函数、无 React/DOM 依赖，便于单测
 * （见 `tests/domain/columns.test.ts`）。
 *
 * ## 列链 = 焦点目录的祖先链
 *
 * 设焦点目录为 `focus`，列链就是 `['', …祖先, focus]`；最后一列显示 `focus` 的**内容**。
 * "焦点目录"由调用方持有（`features/vault/ColumnsTree.tsx` 的 `focusedDir` + localStorage），
 * 它是分栏唯一的额外状态 —— 必需的那一份，见下。
 *
 * ## 为什么"焦点目录"不能由 `selected` 推导
 *
 * 一开始的设计是 `focus = parentOf(selected)`（"选中项在最后一列里"），不新增任何状态。
 * 它在真机上过不了两条：**点一个目录之后右边不会多出一列**（`focus` 还是它的父目录，
 * 列链没变），以及**键盘完全无法向下钻**。想让它成立就必须让"末列"跟着选中项走，
 * 而那正是分栏要解决的那个问题（"一层一层往下看"）。
 *
 * 于是 `focus` 是独立状态，三件事的语义分开、各管一段：
 *
 * | 动作 | `focus` | `selected` |
 * | --- | --- | --- |
 * | 点/`→`/`Enter` 一个目录 | 推进到那个目录（末列 = 它的内容） | 不变（那一行保持高亮） |
 * | `↑/↓` | 不变 | 在**焦点列内**移动 |
 * | `←` | 回退到父目录 | 设成父目录 |
 *
 * `selected` 与 `focus` 不一致的那一瞬（点目录之后）正是 Finder 的样子：被点的目录在
 * 左边那一列高亮着，右边已经是它的内容。
 *
 * ## 三条复用纪律（这里一行排序逻辑都没有）
 *
 * 1. **排序**：只按 `TreeNode.children` 的现成顺序取行 —— 它由 `vault-store` 建树时的
 *    `makeEntryComparator` 排好（`domain/tree.ts` 是判据的唯一真源）。在这里再排一次，
 *    "单栏是拼音序、分栏是字典序"只是时间问题；
 * 2. **文本过滤**：直接复用 `domain/tree.ts` 的 `matchesFilter`（不另写一份"包含"判断）；
 * 3. **标签过滤**：调用方给的是 `tag-filter-store` 算出的可见路径集合，这里只做 Set 成员判定。
 *
 * ## 每列只列**直接子项**
 *
 * 不像单栏的 `flattenTree` 那样把命中的深孙子拉平显示：分栏的层级由"哪一列"表达，
 * 把子树铺进一列就退化成了带缩进的单栏（设计文档 §2.2 的方案 1，已否决）。
 * 祖先路径仍然一直可见 —— 那正是列链本身。
 */

import type { EntryMeta } from '@/ipc/types'
import { ancestorsOf, matchesFilter, type TreeNode } from './tree'

/** 一列的稳定标识：就是它显示的目录（Vault 根为 `''`）。DOM 上用作 `data-column-path`。 */
export type ColumnPath = string

/** 一列：某个目录的直接子项（已排序、已过滤）。 */
export interface ColumnView {
  /** 这一列显示的目录（`''` = Vault 根）。 */
  path: ColumnPath
  /** 可见行（顺序 = `TreeNode.children` 的顺序 = 全树排序的唯一判据）。 */
  rows: readonly TreeNode[]
  /**
   * 这一列有子项被过滤掉了（`children.length > rows.length`）。
   *
   * 有它界面才能说"这一列还有 N 项被过滤/标签收窄挡住了"，而不是让用户以为
   * "这个目录里就这些东西" —— 收窄视图最贵的一类误判就是"我的笔记丢了"。
   */
  truncated: boolean
}

/** 当前列链（不含行内容）。 */
export interface ColumnChain {
  /** 从 Vault 根到焦点目录的目录序列；空 Vault 时为 `[]`。 */
  directories: readonly ColumnPath[]
  /**
   * 焦点列的下标（`↑/↓` 作用在它上面）；空链时为 `-1`。
   *
   * 取值规则：焦点**不是**选中项所在目录时 = 最后一列（点目录之后，用户要的就是
   * 立刻在新出现的那一列里上下走）；否则 = 包含选中项的那一列（`selected === null`
   * 或它不在可见行里时同样是最后一列）。
   */
  activeIndex: number
}

/** `columnsFor` 的完整结果。 */
export interface ColumnsView extends ColumnChain {
  columns: readonly ColumnView[]
  /**
   * 列链末尾真的是调用方给的 `focus`（false = 它不合法/不存在，已回退到选中项所在目录
   * 或 Vault 根）。界面据此把回退后的值写回持久化，不让"陈旧焦点"一直传下去。
   */
  focusAccepted: boolean
}

/** 过滤/可见性输入（两个条件都缺省 = 全量，一个像素都不收窄）。 */
export interface ColumnFilter {
  /** 文本过滤词（原样给，这里自己 trim + 小写，与 `flattenTree` 同一条口径）。 */
  filter?: string
  /**
   * 标签过滤的可见路径集合（`null`/`undefined` = 没有标签过滤）。
   *
   * 刻意收一个 `ReadonlySet` 而不是布尔数组：`useTagFilterView` 给的本来就是集合，
   * 调用方不必为每一列再切一次数组。
   */
  visiblePaths?: ReadonlySet<string> | null
}

export interface ColumnsInput extends ColumnFilter {
  /** 树（`vault-store.tree`）。 */
  tree: readonly TreeNode[]
  /** 选中项的 Vault 相对路径（`vault-store.selected`）。 */
  selected: string | null
  /** 焦点目录（末列显示它的内容；`null` = 还没有焦点，按选中项推导）。 */
  focus: ColumnPath | null
}

/**
 * 焦点目录的祖先链（含焦点自己）。
 *
 * 三条回退规则，按顺序：
 *
 * 1. 空 Vault（`tree` 为空）→ `[]`（界面走与单栏同一份空态）；
 * 2. `focus` 不在条目表里（被删掉 / 持久化回来的是陈旧值）→ 退回选中项的父目录；
 * 3. 祖先链中间断了一级 → 在断点处停下（宁可少一列，也不画一列空内容）。
 *
 * 第 3 条会用上的场合：条目表是"打开 Vault 时扫一次"的快照，某个中间目录刚好在被
 * ignore 规则漏掉/刚被删掉时，`domain/tree` 会把它的子项提升成根节点 —— 那时这条路径
 * 在树里**已经不存在**了，画出来只会是一列空壳。
 */
export function directoryChainFor(
  tree: readonly TreeNode[],
  focus: ColumnPath | null,
  selected: string | null = null,
): readonly ColumnPath[] {
  if (tree.length === 0) return []

  const dirs = entriesByRelPath(tree).directories
  const requested = focus ?? (selected === null ? '' : parentOfPath(selected))
  const resolved = dirs.has(requested) ? requested : fallbackFocus(dirs, selected)

  const out: ColumnPath[] = ['']
  for (const ancestor of ancestorsOf(resolved).reverse()) {
    if (!dirs.has(ancestor)) return out
    out.push(ancestor)
  }
  if (resolved !== '') out.push(resolved)
  return out
}

/** 焦点不合法时的回退：选中项的父目录（还在的话），否则 Vault 根。 */
function fallbackFocus(dirs: ReadonlySet<ColumnPath>, selected: string | null): ColumnPath {
  if (selected === null) return ''
  const parent = parentOfPath(selected)
  return dirs.has(parent) ? parent : ''
}

/**
 * 算出整个分栏视图：列链 + 每列的行。
 *
 * 复杂度：建索引 O(全部条目)（一次遍历，与"树有多大"成正比，这是任何一条渲染路径
 * 都躲不掉的），之后**每列取行 O(该列行数)**。换一列时只重算每列的 `children` 过滤，
 * **不重建树、不重算展开**（见设计文档 §6 的性能预算）。
 */
export function columnsFor(input: ColumnsInput): ColumnsView {
  const directories = directoryChainFor(input.tree, input.focus, input.selected)
  if (directories.length === 0) {
    return {
      directories: [],
      activeIndex: -1,
      columns: [],
      focusAccepted: input.focus === null || input.focus === '',
    }
  }

  const byPath = entriesByRelPath(input.tree)
  const columns = directories.map((path) => columnViewOf(path, byPath.children, input))
  const last = columns.length - 1
  const selectedColumn = columns.findIndex((column) =>
    column.rows.some((node) => node.entry.relPath === input.selected),
  )
  const focusPath = directories[last] ?? ''
  /*
   * 焦点列：
   * - 点了一个目录之后（`focus !== parentOf(selected)`）：最后一列 —— 用户刚打开它，
   *   要的就是立刻在新那一列里上下走；
   * - 否则：包含选中项的那一列（`↑/↓` 在"选中项所在的那一列"里移动是最直观的）。
   */
  const focusDiffers = input.selected !== null && focusPath !== parentOfPath(input.selected)
  const activeIndex = focusDiffers ? last : selectedColumn === -1 ? last : selectedColumn

  return {
    directories,
    activeIndex,
    columns,
    focusAccepted: input.focus === null || directories[last] === input.focus,
  }
}

/**
 * 某一列的行（只列直接子项）。
 *
 * 空目录 / 被过滤光的目录也返回一列（`rows: []`）：列链是稳定的，界面据此画
 * "没有匹配的项"而不是让整列消失 —— 后者会让右边的列**整体左移**，
 * 用户按 `←` 时看到的列位置与刚才不是同一个。
 */
export function columnViewOf(
  path: ColumnPath,
  childrenOf: ReadonlyMap<ColumnPath, readonly TreeNode[]>,
  filter: ColumnFilter = {},
): ColumnView {
  const children = childrenOf.get(path) ?? []
  const rows = rowsFor(children, filter)
  return { path, rows, truncated: rows.length < children.length }
}

/** 一列里可见的那些行（`children` 的现成顺序，不排序）。 */
export function rowsFor(
  children: readonly TreeNode[],
  filter: ColumnFilter = {},
): readonly TreeNode[] {
  const needle = (filter.filter ?? '').trim().toLowerCase()
  const visible = filter.visiblePaths ?? null
  if (needle === '' && visible === null) return children
  return children.filter((node) => matches(node.entry, needle, visible))
}

/** 某一条是否可见（文本过滤 ∩ 标签可见集合）。 */
function matches(
  entry: EntryMeta,
  needle: string,
  visible: ReadonlySet<string> | null,
): boolean {
  if (visible !== null && !visible.has(entry.relPath)) return false
  return matchesFilter(entry, needle)
}

/**
 * 一列里第一个**目录**行（`→` 在"当前行的下一个子项"上的落点、以及"自动推进"用）。
 *
 * 返回下标而不是节点：调用方要么 `select` 它、要么按它算滚动位置，
 * 拿到下标就不用再 `indexOf` 一次（行对象在每列里是稳定的，但下标更直接）。
 */
export function firstDirectoryIndex(rows: readonly TreeNode[]): number {
  return rows.findIndex((node) => node.entry.isDir)
}

/** 分栏里可见的行总数（空态判据：0 = 一行都没有，界面画与单栏同一份空态）。 */
export function columnRowCount(columns: readonly ColumnView[]): number {
  return columns.reduce((total, column) => total + column.rows.length, 0)
}

/** 一行在某一列里的下标（`-1` = 不在这一列）。 */
export function indexInColumn(column: ColumnView, relPath: string | null): number {
  if (relPath === null) return -1
  return column.rows.findIndex((node) => node.entry.relPath === relPath)
}

/**
 * `↑/↓` 的目标：**焦点列内**的相邻一行。
 *
 * `selected` 不在这一列里（例如刚推进一列、焦点列还没有选中项）时从第一行起步
 * （`↓`）/从最后一行起步（`↑`）—— 那正是"进到一个新目录之后按一下就能走"的期待。
 * 到边界返回 `null`：这一列走完了，跨列是 `←/→` 的事（与单栏的 `↑/↓` 同一口径）。
 */
export function siblingRowTarget(
  column: ColumnView,
  selected: string | null,
  direction: 'up' | 'down',
): string | null {
  const index = indexInColumn(column, selected)
  const next =
    index === -1
      ? direction === 'down'
        ? 0
        : column.rows.length - 1
      : direction === 'down'
        ? index + 1
        : index - 1
  return column.rows[next]?.entry.relPath ?? null
}

/**
 * `→`/点击/`Enter` 在**目录**上的目标：推进到那个目录（末列换成它的内容）。
 *
 * 返回 `null` 表示"不能推进"：调用方给的不是目录（那一支走"打开笔记"），或者这个目录
 * 不在条目表里（新建的目录可能会这样 —— 那时宁可无操作，也不把焦点设成一个不存在的地方）。
 */
export function drillTarget(
  entry: EntryMeta | null | undefined,
  directories: ReadonlySet<ColumnPath>,
): ColumnPath | null {
  if (entry === null || entry === undefined || !entry.isDir) return null
  return directories.has(entry.relPath) ? entry.relPath : null
}

/**
 * `←` 的目标：**焦点目录**的父目录。
 *
 * 已经在 Vault 根时返回 `null` —— 根没有上一级，按住 `←` 不该有动静
 * （设计文档 §4 第 2 条）。返回 `''` 与"没有目标"是两件事，所以这里用 `null` 表示后者。
 */
export function arrowLeftTarget(focus: ColumnPath): ColumnPath | null {
  if (focus === '') return null
  return parentOfPath(focus)
}

/**
 * 所有目录的路径集合（判断"这个目录还能不能推进"用）。
 *
 * 与 `directoryChainFor` 内部那份索引同一口径（都只看 `isDir` 的条目）：视图层不必
 * 自己遍历树去查一个目录在不在。
 */
export function directoryPathsOf(tree: readonly TreeNode[]): ReadonlySet<ColumnPath> {
  return entriesByRelPath(tree).directories
}

/** 定位一个路径要滚哪一列、滚到第几行（`REVEAL_ROW_EVENT` 用）。 */
export interface RevealTarget {
  columnIndex: number
  rowIndex: number
}

/**
 * 算出"把 `relPath` 滚进视野"要动的那一列与那一行。
 *
 * 只滚**最右**那个包含它的列：同一行不可能出现在两列里（列 = 互不相交的目录），
 * 但 `selected` 是目录时它出现在父列、`relPath` 也可能同时是某个更深目录的祖先
 * —— 取最右的那一列 = 用户当前在看的那一列。
 *
 * 找不到时返回 `null`（例如刚被过滤掉）：调用方什么都不做，比滚到一个随机位置诚实。
 */
export function revealTargetIn(
  columns: readonly ColumnView[],
  relPath: string,
): RevealTarget | null {
  for (let columnIndex = columns.length - 1; columnIndex >= 0; columnIndex -= 1) {
    const column = columns[columnIndex]
    if (column === undefined) continue
    const rowIndex = column.rows.findIndex((node) => node.entry.relPath === relPath)
    if (rowIndex !== -1) return { columnIndex, rowIndex }
  }
  return null
}

/** 父目录（与 `domain/paths.ts` 的 `parentOf` 同一条口径；这里内联是为了不引第二份语义）。 */
function parentOfPath(relPath: string): ColumnPath {
  const index = relPath.lastIndexOf('/')
  return index === -1 ? '' : relPath.slice(0, index)
}

/**
 * 树 → "目录路径 → 直接子节点"与"目录路径集合"。
 *
 * 一次遍历同时产出两张表：逐列取行的代价因此与"该列有几个子项"成正比，
 * 而不是每次都对整棵树做一次查找（10 万条目下这就是"换列卡不卡"的分水岭）。
 */
function entriesByRelPath(tree: readonly TreeNode[]): {
  children: ReadonlyMap<ColumnPath, readonly TreeNode[]>
  directories: ReadonlySet<ColumnPath>
} {
  const children = new Map<ColumnPath, readonly TreeNode[]>()
  const directories = new Set<ColumnPath>()
  const walk = (nodes: readonly TreeNode[]): void => {
    for (const node of nodes) {
      if (!node.entry.isDir) continue
      directories.add(node.entry.relPath)
      children.set(node.entry.relPath, node.children)
      walk(node.children)
    }
  }
  // 根那一列：树的顶层节点（`''` 本身不是条目的 relPath，没有对应的 TreeNode）。
  // 空串也必须进 `directories` —— 它是**真实存在的一列**（Vault 根），
  // 少了它 `directoryChainFor` 会把"选中顶层目录/文件"当成"这一路都不存在"而退回无列。
  children.set('', tree)
  directories.add('')
  walk(tree)
  return { children, directories }
}
