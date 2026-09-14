/**
 * 文件树：扁平条目表 → 树 → 可见行。
 *
 * 纯函数、无 React 依赖，便于单测（见 `tests/tree.test.ts`）。
 * 10k 条目的构建与展开是 O(n)，并由调用方 memo 化；隐藏行不渲染（虚拟列表）。
 */

import type { EntryMeta } from '@/ipc/types'
import { parentOf } from './paths'

/** 树节点。 */
export interface TreeNode {
  entry: EntryMeta
  /** 子节点（仅目录非空，且已排序）。 */
  children: TreeNode[]
}

/** 虚拟列表中的一行。 */
export interface FlatRow {
  node: TreeNode
  depth: number
  hasChildren: boolean
}

/** 排序：目录在前，其次按名称（自然序，中文按拼音，大小写不敏感）。 */
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

/**
 * 文件树的排序配置。
 *
 * 判据只有这一份（`makeEntryComparator`）：数据层（`vault-store` 建树时）用它，
 * 视图层**不**再自己排序 —— 两处各写一份顺序规则，结果必然是"树上是一种序、
 * 别的消费者（标签过滤视图）是另一种序"。
 */
export interface TreeSort {
  /** 排序主键：名称 / 修改时间 / 大小 / 类型（扩展名）。 */
  by: 'name' | 'mtime' | 'size' | 'type'
  direction: 'asc' | 'desc'
  /** 目录是否总是排在文件之前（关掉后目录与文件一起按主键混排）。 */
  foldersFirst: boolean
}

/** 默认排序：目录在前 + 名称升序 —— 升级上来的用户看到的树必须和原来一模一样。 */
export const DEFAULT_TREE_SORT: TreeSort = { by: 'name', direction: 'asc', foldersFirst: true }

/**
 * 校验持久化回来的排序配置；不合法时调用方退回 {@link DEFAULT_TREE_SORT}。
 *
 * 为什么连值都要逐个字段判：这份数据可能被旧版本/手工改成任何形状，而它直接决定
 * 数据层建树的顺序 —— 校验不严格，结果是一棵顺序莫名变化、且没有任何提示的树。
 */
export function isTreeSort(value: unknown): value is TreeSort {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return (
    (candidate['by'] === 'name' ||
      candidate['by'] === 'mtime' ||
      candidate['by'] === 'size' ||
      candidate['by'] === 'type') &&
    (candidate['direction'] === 'asc' || candidate['direction'] === 'desc') &&
    typeof candidate['foldersFirst'] === 'boolean'
  )
}

/** 条目比较器（`Array#sort` 用）。 */
export type EntryComparator = (a: EntryMeta, b: EntryMeta) => number

/**
 * 按配置构造条目比较器。
 *
 * 三条确定性规则（任何配置下都成立）：
 * 1. **`mtimeMs: null` 恒排最后**，且不随方向翻转 —— null 的含义是"没有这个时间"
 *    （目录与附件），降序时把它翻到最前等于把"未知"显示成"最新"，那是误导；
 * 2. 主键相同再按名称（自然序），仍相同按 `relPath` 兜底 —— 保证结果与输入顺序无关；
 * 3. 兜底（名称/路径）永远是升序：只有**主键**跟随 `direction`，否则"名称相同的两条"
 *    在降序模式下会颠倒，读起来像不稳定排序。
 */
export function makeEntryComparator(sort: TreeSort): EntryComparator {
  const sign = sort.direction === 'desc' ? -1 : 1
  return (a, b) => {
    if (a.isDir !== b.isDir && sort.foldersFirst) return a.isDir ? -1 : 1

    if (sort.by === 'mtime') {
      // 缺失值恒在最后（规则 1），所以这里直接返回、不乘 sign
      if (a.mtimeMs === null || b.mtimeMs === null) {
        if (a.mtimeMs === null && b.mtimeMs === null) return fallback(a, b)
        return a.mtimeMs === null ? 1 : -1
      }
    }

    const primary = comparePrimary(sort.by, a, b)
    if (primary !== 0) return sign * primary
    return fallback(a, b)
  }
}

/** 主键比较（不含目录/文件分层 —— 那由 `foldersFirst` 独立负责）。 */
function comparePrimary(by: TreeSort['by'], a: EntryMeta, b: EntryMeta): number {
  switch (by) {
    case 'name':
      return collator.compare(a.name, b.name)
    case 'mtime':
      // null 已在调用方拦截（恒排最后），到这里两边都是数字
      return (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0)
    case 'size':
      return a.sizeBytes - b.sizeBytes
    case 'type':
      // 无扩展名（目录、无后缀文件）按空串处理：空串在 collator 下排在最前，
      // 落点确定即可，"没有类型"没有更合理的序
      return collator.compare(a.ext ?? '', b.ext ?? '')
  }
}

/** 兜底键：名称升序，再 relPath 升序（与默认口径一致，保证整体确定性）。 */
function fallback(a: EntryMeta, b: EntryMeta): number {
  const byName = collator.compare(a.name, b.name)
  // 同名的极端情况（不同目录同名文件不可能同 relPath）用 relPath 兜底保证确定性
  return byName !== 0 ? byName : collator.compare(a.relPath, b.relPath)
}

/** 默认排序的比较器（`DEFAULT_TREE_SORT` 的别名；老调用点不受影响）。 */
export const compareEntries: EntryComparator = makeEntryComparator(DEFAULT_TREE_SORT)

/**
 * 构建树。
 *
 * 父目录缺失的条目（被 ignore 规则/深度上限漏掉）会被**提升为根节点**，
 * 而不是被静默丢弃 —— 宁可多显示，不可让用户的文件"人间蒸发"。
 *
 * `comparator` 缺省为默认排序（{@link compareEntries}）；数据层传当前用户偏好，
 * 领域层自己不读任何 store（保持纯函数、可在 Worker/测试里跑）。
 */
export function buildTree(
  entries: readonly EntryMeta[],
  comparator: EntryComparator = compareEntries,
): TreeNode[] {
  const nodes = new Map<string, TreeNode>()
  for (const entry of entries) {
    nodes.set(entry.relPath, { entry, children: [] })
  }

  const roots: TreeNode[] = []
  for (const entry of entries) {
    const node = nodes.get(entry.relPath)
    if (node === undefined) continue
    const parent = nodes.get(parentOf(entry.relPath))
    if (parent === undefined) roots.push(node)
    else parent.children.push(node)
  }

  sortTree(roots, comparator)
  return roots
}

/** 递归排序（就地对 children 排序；⚠️ 会改动传入的数组与节点，别对共享状态直接调）。 */
export function sortTree(nodes: TreeNode[], comparator: EntryComparator = compareEntries): TreeNode[] {
  nodes.sort((a, b) => comparator(a.entry, b.entry))
  for (const node of nodes) {
    if (node.children.length > 0) sortTree(node.children, comparator)
  }
  return nodes
}

/** 展开状态 + 过滤词。 */
export interface FlattenOptions {
  expanded: ReadonlySet<string>
  /** 过滤词（大小写不敏感的子串匹配 relPath 或文件名）。 */
  filter?: string
  /** 目录名包含过滤词时是否连带显示其子项。 */
  autoExpandMatches?: boolean
}

/**
 * 展平为可见行。
 *
 * 过滤时：命中的条目可见，其祖先也被保留（保证路径上下文），且自动展开。
 * 未过滤时：只有被展开的目录才会展开其子项。
 */
export function flattenTree(roots: readonly TreeNode[], options: FlattenOptions): FlatRow[] {
  const filter = (options.filter ?? '').trim().toLowerCase()
  const autoExpand = options.autoExpandMatches ?? true
  const rows: FlatRow[] = []

  const visit = (node: TreeNode, depth: number): boolean => {
    const selfMatch = filter === '' || matchesFilter(node.entry, filter)
    const expanded = filter !== '' ? autoExpand : options.expanded.has(node.entry.relPath)
    const insertAt = rows.length
    let childVisible = false

    if (node.children.length > 0 && expanded) {
      for (const child of node.children) {
        if (visit(child, depth + 1)) childVisible = true
      }
    }

    if (selfMatch || childVisible) {
      // 父行必须插在子行之前，因此用 splice 而不是 push
      rows.splice(insertAt, 0, { node, depth, hasChildren: node.children.length > 0 })
      return true
    }
    return false
  }

  for (const root of roots) visit(root, 0)
  return rows
}

/** 单个条目是否命中过滤词。 */
export function matchesFilter(entry: EntryMeta, lowerCaseFilter: string): boolean {
  if (lowerCaseFilter === '') return true
  return (
    entry.name.toLowerCase().includes(lowerCaseFilter) ||
    entry.relPath.toLowerCase().includes(lowerCaseFilter)
  )
}

/** 全部目录的相对路径（"全部展开/折叠"用）。 */
export function collectDirectoryPaths(roots: readonly TreeNode[]): string[] {
  const out: string[] = []
  const walk = (nodes: readonly TreeNode[]): void => {
    for (const node of nodes) {
      if (node.entry.isDir) {
        out.push(node.entry.relPath)
        walk(node.children)
      }
    }
  }
  walk(roots)
  return out
}

/** 展开某个路径的所有祖先（打开笔记时定位用）。 */
export function ancestorsOf(relPath: string): string[] {
  const out: string[] = []
  let current = parentOf(relPath)
  while (current !== '') {
    out.push(current)
    current = parentOf(current)
  }
  return out
}

/** 统计树中所有条目数（含目录）。 */
export function countNodes(roots: readonly TreeNode[]): number {
  let total = 0
  const walk = (nodes: readonly TreeNode[]): void => {
    for (const node of nodes) {
      total += 1
      walk(node.children)
    }
  }
  walk(roots)
  return total
}
