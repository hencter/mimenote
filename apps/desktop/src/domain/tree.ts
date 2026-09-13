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

export function compareEntries(a: EntryMeta, b: EntryMeta): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  const byName = collator.compare(a.name, b.name)
  // 同名的极端情况（不同目录同名文件不可能同 relPath）用 relPath 兜底保证确定性
  return byName !== 0 ? byName : collator.compare(a.relPath, b.relPath)
}

/**
 * 构建树。
 *
 * 父目录缺失的条目（被 ignore 规则/深度上限漏掉）会被**提升为根节点**，
 * 而不是被静默丢弃 —— 宁可多显示，不可让用户的文件"人间蒸发"。
 */
export function buildTree(entries: readonly EntryMeta[]): TreeNode[] {
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

  sortTree(roots)
  return roots
}

/** 递归排序（就地对 children 排序）。 */
export function sortTree(nodes: TreeNode[]): TreeNode[] {
  nodes.sort((a, b) => compareEntries(a.entry, b.entry))
  for (const node of nodes) {
    if (node.children.length > 0) sortTree(node.children)
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
