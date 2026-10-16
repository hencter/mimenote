/**
 * 文件树的一行：**单栏与分栏共用**同一个组件。
 *
 * 为什么抽出来：两种画法的行在视觉上必须逐像素一致（图标、去扩展名的显示名、附件徽标、
 * 选中/打开的底色、拖拽落点的描边），而它们唯一的差别是"层级怎么表达"
 * —— 单栏靠 `padding-left` 的缩进，分栏靠"它在哪一列"。把行留成两份复制品，
 * 第一次改图标或加一种状态（比如以后要加的"收件箱置顶"徽标）就会只改一边。
 *
 * 两条纪律：
 *
 * 1. **性能**：行组件只订阅自己的布尔状态（`selected === relPath` / `expanded.has(relPath)` /
 *    `doc?.relPath === relPath`），因此选中某一项只会重渲染那一行（与整棵树多大无关）；
 *    `memo` 让它对"父级重渲染但自己三个 prop 没变"也免疫。单栏的虚拟列表与分栏的每一列
 *    都依赖这条（见 `docs/design/04-miller-columns.md` §6）；
 * 2. **`RowRef` 而不是 `FlatRow`**：分栏的列里没有"深度"这个概念（层级由列表达），
 *    所以行组件只要求"一个条目 + 它有没有子项" —— 单栏传 `FlatRow` 时由调用方给出
 *    `depth`（缩进），分栏不传（`depth = 0`，列宽固定）。
 */

import { memo } from 'react'

import { Icon } from '@/components/Icon'
import { formatBytes } from '@/domain/format'
import { displayName, isMarkdown } from '@/domain/paths'
import type { TreeNode } from '@/domain/tree'
import { useNoteStore } from '@/state/note-store'
import { useVaultStore } from '@/state/vault-store'

/** 一行在当前拖拽里的角色（决定样式与 `data-*` 断言点）。 */
export type RowDropState = 'none' | 'valid' | 'invalid'

/**
 * 行的最小形状。
 *
 * `depth` 只被单栏用（缩进）；分栏不传，于是分栏里的行 `padding-left` 是固定值
 * —— 列的位置本身已经表达了层级，再加缩进会把名字挤掉。
 */
export interface RowRef {
  node: TreeNode
  depth?: number
  hasChildren: boolean
}

export interface TreeRowProps {
  row: RowRef
  /**
   * 点开这一行。
   *
   * `newTab` 为真表示"在新标签里打开"（`Ctrl/⌘ + 点击` 或中键）：默认行为是
   * **顶掉当前那条标签**（用户约定：「默认的新文件替换中的叶标签」），
   * 而多标签仍然要有路可走（`Ctrl+Tab` / `Ctrl+1..9` / 关闭其他 / 拖到别的格子都要它）。
   */
  onActivate: (row: RowRef, newTab: boolean) => void
  /** 右键：菜单由**父组件**持有（一行一份状态会让虚拟列表里几十行各挂一个菜单） */
  onContextMenu: (row: RowRef, event: React.MouseEvent<HTMLDivElement>) => void
  onDragStart: (row: RowRef, event: React.DragEvent<HTMLDivElement>) => void
  onDragOver: (row: RowRef, event: React.DragEvent<HTMLDivElement>) => void
  onDrop: (row: RowRef, event: React.DragEvent<HTMLDivElement>) => void
  /** 行高（px）。固定行高虚拟化的**唯一来源**（`computeWindow({ rowHeight })`）。 */
  height: number
  /** 这一行是不是被拖动的源。 */
  dragging: boolean
  /** 这一行是不是当前落点。 */
  dropState: RowDropState
  /**
   * 当前有过滤生效（文本或标签）—— 此时子行是**自动展开**的，三角必须跟着说同一件事。
   * 见 `FileTree` 里 `autoExpanded` 的注释。
   */
  autoExpanded: boolean
  /**
   * 分栏路径链上的这一项（打开右侧下一列的那个目录）。
   * 与 `--selected` 分开：选中项可能已是末列的文件，但祖先列仍要画出整条路径。
   */
  pathHighlight?: boolean
}

/** 行的 DOM id（`aria-activedescendant` 用）。 */
export function treeRowId(relPath: string): string {
  return `mn-tree-row-${encodeURIComponent(relPath)}`
}

export const TreeRow = memo(function TreeRow({
  row,
  onActivate,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
  height,
  dragging,
  dropState,
  autoExpanded,
  pathHighlight = false,
}: TreeRowProps) {
  const entry = row.node.entry
  const relPath = entry.relPath
  const isSelected = useVaultStore((state) => state.selected === relPath)
  const isExpanded = useVaultStore((state) => entry.isDir && state.expanded.has(relPath))
  const isOpen = useNoteStore((state) => state.doc?.relPath === relPath)
  const markdown = isMarkdown(relPath)
  /** 视觉上这一行的子项在不在下面（过滤时子项由过滤条件强制展开，与 store 无关）。 */
  const showsChildren = isExpanded || (entry.isDir && autoExpanded)
  const depth = row.depth ?? 0
  // 路径链上的目录在分栏里视为"已打开"：用开着的文件夹图标，和 Finder 一致
  const pathOpen = pathHighlight && entry.isDir

  const iconName = entry.isDir
    ? showsChildren || pathOpen
      ? 'folderOpen'
      : 'folder'
    : markdown
      ? 'file'
      : 'dot'
  // 笔记与**文件夹**都可以拖（附件不行：索引里没有它们的条目，见 `canDrag`）；
  // 目录行同样是**合法的落点**
  const draggable = true

  return (
    <div
      id={treeRowId(relPath)}
      data-rel-path={relPath}
      data-drop-state={dropState === 'none' ? undefined : dropState}
      data-path-highlight={pathHighlight ? '' : undefined}
      className={[
        'mn-tree-row',
        isSelected ? 'mn-tree-row--selected' : '',
        pathHighlight && !isSelected ? 'mn-tree-row--path' : '',
        isOpen ? 'mn-tree-row--open' : '',
        dragging ? 'mn-tree-row--dragging' : '',
        dropState === 'valid' ? 'mn-tree-row--drop-valid' : '',
        dropState === 'invalid' ? 'mn-tree-row--drop-invalid' : '',
      ]
        .filter((name) => name !== '')
        .join(' ')}
      role="treeitem"
      aria-selected={isSelected || pathHighlight}
      aria-expanded={entry.isDir ? showsChildren : undefined}
      aria-level={depth + 1}
      style={{ paddingLeft: `${6 + depth * 14}px`, height }}
      title={`${relPath}${entry.isDir ? '' : ` · ${formatBytes(entry.sizeBytes)}`}`}
      onClick={(event) => onActivate(row, event.ctrlKey || event.metaKey)}
      /*
        中键 = 在新标签里打开（浏览器里就是这么用的，用户不用学）。
        `onAuxClick` 只在**按下中键之后**触发，所以这里还要挡掉中键自带的自动滚动：
        `onMouseDown` 里对 `button === 1` 调 `preventDefault`（同一件事在标签条上也是这么做的）。
      */
      onAuxClick={(event) => {
        if (event.button !== 1) return
        onActivate(row, true)
      }}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault()
      }}
      onContextMenu={(event) => onContextMenu(row, event)}
      // 笔记与文件夹都可拖（见上面的 `draggable`）；目录行仍然是**合法的落点**
      draggable={draggable}
      onDragStart={(event) => onDragStart(row, event)}
      onDragOver={(event) => onDragOver(row, event)}
      onDrop={(event) => onDrop(row, event)}
      aria-dropeffect={entry.isDir ? 'move' : undefined}
    >
      {entry.isDir ? (
        <span
          className={`mn-tree-row__chevron${showsChildren ? ' mn-tree-row__chevron--open' : ''}`}
        >
          <Icon name="chevron" size="xs" />
        </span>
      ) : (
        <span className="mn-tree-row__chevron mn-tree-row__chevron--placeholder" />
      )}
      <Icon name={iconName} size="sm" className="mn-tree-row__icon" />
      <span className="mn-tree-row__name">{entry.isDir ? entry.name : displayName(relPath)}</span>
      {!entry.isDir && !markdown && <span className="mn-tree-row__badge">{entry.ext ?? '?'}</span>}
    </div>
  )
})
