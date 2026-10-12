/**
 * 文件树**容器**：把"两种画法共用的那部分"收在一处，再按 `treeLayout` 分派给
 * 单栏视图（`SingleColumnTree.tsx`）或分栏视图（`ColumnsTree.tsx`）。
 *
 * ## 为什么拆成三个文件
 *
 * 单栏（缩进表达的树）与分栏（Miller columns）共用：可见行/可见列的推导、标签过滤、
 * 选中与打开、重命名/移动/删除、右键菜单、拖拽状态、`REVEAL_ROW_EVENT`。
 * 差别只有"行画在哪儿、`←/→/Enter` 往哪走"。从前这些全在 `FileTree.tsx` 一个文件里，
 * 再塞进一套分栏渲染就会变成一个 1500 行的组件 —— 于是：
 *
 * * 本文件 = 状态 + 动作 + 分派（**判据**都在这里与 `domain/` 里）；
 * * `SingleColumnTree.tsx` / `ColumnsTree.tsx` = 只负责虚拟化与滚动；
 * * `TreeRow.tsx` = 两种画法**共用**的一行（否则第一次改图标就会只改一边）；
 * * `use-tree-drag.ts` = 共用的拖拽手柄（落点判定仍在 `domain/drag.ts`）。
 *
 * ## 不变量（ADR-0058 / `docs/design/04-miller-columns.md`）
 *
 * * **排序只有一套判据**：`domain/tree.ts` 的 `makeEntryComparator`（`vault-store` 建树时用）。
 *   分栏视图不排序，只按 `TreeNode.children` 的现成顺序取行；
 * * **过滤只有一套判据**：文本走 `flattenTree` + `matchesFilter`，标签走
 *   `tag-filter-store` 的可见路径集合；分栏把同一份集合按 `Set` 成员判定逐列应用；
 * * **虚拟化只有一套实现**：`domain/virtual-list.ts` + 同一组尺寸常量
 *   （`tree-metrics.ts` 的 `ROW_HEIGHT = 30` / `OVERSCAN = 10`）；
 * * **`selected` 是唯一的选中项**：分栏的列链由它推导，不存第二份焦点状态
 *   —— 换列因此不重建树、不需要任何对账（性能预算见设计文档 §6）。
 *
 * ## 拖拽（M3 最后一项）
 *
 * * **只拖 Markdown 笔记**（目录拖动与多选都推迟），所以行上的 `draggable` 是有条件的；
 * * **落点判定**全部交给 `domain/drag` 的纯函数（文件夹 → 那个文件夹；笔记 → 它的目录；
 *   空白 → 那块空白代表的目录）；
 * * 悬停高亮只改**一行**（或分栏里的**一列**）：其余行按 `memo` 原样跳过
 *   —— 否则每移动一次鼠标都要重渲染几十行；
 * * HTML5 的 `dragover` 阶段读不到 `dataTransfer.getData()`，所以"当前拖的是谁"留在
 *   组件状态里，`dataTransfer` 只用于过手（顺带让外部程序能拿到相对路径）。
 *
 * ## 标签过滤（`TagFilterControl.tsx` + `domain/tag-filter.ts`，见 architecture.md §8 第 3 条）
 *
 * * **只读的收窄视图**：单栏的可见行 = `flattenTree` 的结果 ∩ 标签命中集合；
 *   分栏的每一列 = 直接子项 ∩ 标签命中集合（祖先路径由列链本身保证可见）。
 *   两个条件都交给既有判据，过滤视图里不会长出第二套"怎么展开、怎么排"的规则；
 * * **命中的祖先目录自动展开**（单栏）：与文本过滤的 `autoExpandMatches` 同一观感。
 *   行集是 `flattenTree` 与标签集合的交集，所以这里把可见目录并进 `expanded` 一起喂给它
 *   （否则命中项会藏在没展开的目录里，看起来像"过滤没生效"）；
 * * **拖拽的唯一例外**：过滤期间"空白处 = 某个目录"这个落点被停用，并给出原因。
 *   过滤之后列表很短、空白区域很大，一次不经意的拖动就会把笔记静默搬到别处；
 * * 重命名 / 新建 / 删除 / F6 移动照旧可用：它们作用在**选中项**上，与视图收窄无关；
 * * **Esc**：过滤生效时按下即回到全量（与控件上的「清除」同一条路径）。
 */

import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'

import {
  createNoteHere,
  deleteSelected,
  openNote,
  openNoteInNewTab,
  renameSelected,
} from '@/app/actions'
import { commands } from '@/app/commands'
import { REVEAL_ROW_EVENT } from '@/app/dom-events'
import { ContextMenu, type ContextMenuItem } from '@/components/ContextMenu'
import { copyText } from '@/domain/clipboard'
import {
  arrowLeftTarget,
  columnRowCount,
  columnsFor,
  directoryPathsOf,
  drillTarget,
  siblingRowTarget,
  type ColumnView,
  type ColumnsView,
} from '@/domain/columns'
import { sameDropTarget, type DragPayload, type DropTarget } from '@/domain/drag'
import { isMarkdown } from '@/domain/paths'
import { flattenTree, type TreeNode } from '@/domain/tree'
import { isViewable } from '@/domain/viewable'
import { useLayoutDrag } from '@/features/layout/layout-drag'
import type { EntryMeta } from '@/ipc/types'
import { useTagFilterStore } from '@/state/tag-filter-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'
import { ColumnsTree } from './ColumnsTree'
import { MoveDialog } from './MoveDialog'
import { RenameDialog } from './RenameDialog'
import { SingleColumnTree } from './SingleColumnTree'
import type { RowRef } from './TreeRow'
import { loadTreeFocus, saveTreeFocus } from './tree-focus'
import { useTreeLayout } from './tree-layout-pref'
import { useTreeDrag } from './use-tree-drag'
import type { TreeViewHandle } from './tree-view'
import { useTagFilterView } from './use-tag-filter-view'

import './drag-drop.css'
// 标签过滤的样式也在这里托管一条（空态按钮的排版）：`styles/app.css` 不在本次改动的范围内，
// 而它属于"标签过滤"这个能力带来的界面，因此与控件样式放在一起；重复 import 会被打包器去重
import './tag-filter.css'

/** 空的分栏视图（单栏模式下不白算一遍列链）。 */
const EMPTY_COLUMNS_VIEW: ColumnsView = {
  directories: [],
  activeIndex: -1,
  columns: [],
  focusAccepted: true,
}

function revealRow(relPath: string): void {
  window.dispatchEvent(new CustomEvent<string>(REVEAL_ROW_EVENT, { detail: relPath }))
}

export function FileTree() {
  const tree = useVaultStore((state) => state.tree)
  const expanded = useVaultStore((state) => state.expanded)
  const filter = useVaultStore((state) => state.filter)
  const selected = useVaultStore((state) => state.selected)
  const toggleExpanded = useVaultStore((state) => state.toggleExpanded)
  const select = useVaultStore((state) => state.select)
  const setFilter = useVaultStore((state) => state.setFilter)

  /** 单栏 / 分栏（偏好由 Lead 落地在 `settings-store`，默认 `'single'`）。 */
  const layout = useTreeLayout()

  // 标签过滤：文件树是**唯一**开自动重算的地方（条目表变了就重新问一次宿主）。
  // 控件不再开一份，否则"重扫"这一个事件会被两个组件各触发一轮 IPC。
  const tagView = useTagFilterView({ autoRefresh: true })
  const clearTagFilter = useTagFilterStore((state) => state.clear)
  const reloadTagFilter = useTagFilterStore((state) => state.reload)
  /** 生效中的标签可见集合；`null` = 没有标签过滤（走原来那条路，一个像素都不变）。 */
  const tagVisible = tagView.applied ? tagView.visiblePaths : null

  // 过滤是 O(n) 遍历：用 deferred value 让它不阻塞输入
  const deferredFilter = useDeferredValue(filter)

  /**
   * 标签过滤时把可见目录并入展开集合，交给 `flattenTree` 一并展平。
   *
   * 为什么不是过滤完之后再补行：`flattenTree` 只在目录"被展开"时才下探子节点，
   * 没展开的目录里的命中笔记根本不会出现在结果里（然后再怎么筛也筛不回来）。
   * 文件路径也在集合里，但它们没有子节点，`expanded` 对它们不被读到 —— 无害。
   *
   * 引用稳定性：`tagVisible` 由 hook 按引用 memo，`expanded` 只在真的改动时换新 Set，
   * 因此这份 memo 不会每次渲染都失效（4000 条目的展平不该被无谓地重做）。
   */
  const expandedForRows = useMemo(() => {
    if (tagVisible === null) return expanded
    const next = new Set(expanded)
    for (const relPath of tagVisible) next.add(relPath)
    return next
  }, [expanded, tagVisible])

  /**
   * 单栏的可见行 = `flattenTree` 的结果 ∩ 标签可见集合。
   *
   * 为什么不给 `flattenTree` 加一个"只看这些路径"的选项：那要改 `domain/tree.ts`
   * （别的改动的战场），而这里**两处过滤共用同一份展平结果**正是我们要的
   * —— 文本过滤与标签过滤的祖先保留、排序、自动展开因此不可能漂移。
   *
   * 分栏模式下**不**算它：分栏的每一列是"直接子项 ∩ 同一份集合"，由
   * `domain/columns.ts` 负责（那边不复制排序、也不复制 `matchesFilter`）。
   */
  const rows = useMemo(() => {
    if (layout === 'columns') return []
    const all = flattenTree(tree, { expanded: expandedForRows, filter: deferredFilter })
    return tagVisible === null
      ? all
      : all.filter((row) => tagVisible.has(row.node.entry.relPath))
  }, [layout, tree, expandedForRows, deferredFilter, tagVisible])

  /**
   * 分栏的**焦点目录**（末列显示它的内容）。
   *
   * 这是分栏唯一的额外状态：由 `selected` 推导不出"用户点开了哪个目录"
   * （见 `domain/columns.ts` 的文件头，那两条在真机走查里当场被否掉）。
   *
   * 三种取值，别把 `null` 与 `''` 混起来：
   * - `null` = **跟随选中项**（末列 = 选中项所在的目录）。打开笔记 / 从别处定位过来、
   *   以及首次打开 Vault 都落在这里 —— 那是"自动跟随"的语义；
   * - `''` = Vault 根（用户点回了根那一列，或者是显式钻进去的根）；
   * - 其他 = 用户点开的那一层。
   *
   * 初始化时先按上次记录恢复；记的那个目录已经不在了就退回 `null`（跟随选中项）
   * —— 宁可多滚一列，也不把用户扔进一个已经不存在的地方。
   */
  const directoryPaths = useMemo(() => directoryPathsOf(tree), [tree])
  const vaultRoot = useVaultStore((state) => state.info?.rootPath ?? '')
  const [focusedDir, setFocusedDir] = useState<string | null>(() => {
    const saved = loadTreeFocus(vaultRoot)
    return saved !== null && (saved === '' || directoryPaths.has(saved)) ? saved : null
  })

  /** 焦点目录变化时持久化（按 Vault 根分桶；换 Vault 后打开的是另一套"我在看哪儿"）。 */
  const focusChanged = useCallback(
    (next: string): void => {
      setFocusedDir(next)
      saveTreeFocus(vaultRoot, next)
    },
    [vaultRoot],
  )

  /**
   * **换 Vault**（不是每次渲染）时把焦点换成那个 Vault 的记录。
   *
   * 用 ref 记住上一个 Vault 根而不是直接依赖 `vaultRoot`：后者会在这个 effect
   * 自己调 `setFocusedDir` 之后再次触发（自我循环）。只在"根变了"时动手，
   * 用 `useLayoutEffect` 是为了让切换后的第一帧就是新 Vault 的那一层。
   * 只在两个根都非空时才动（挂载时已在 `useState` 的初始化里读过一次）。
   */
  const lastVaultRoot = useRef(vaultRoot)
  useLayoutEffect(() => {
    const previous = lastVaultRoot.current
    lastVaultRoot.current = vaultRoot
    if (previous === vaultRoot || previous === '' || vaultRoot === '') return
    const saved = loadTreeFocus(vaultRoot)
    setFocusedDir(saved !== null && (saved === '' || directoryPaths.has(saved)) ? saved : null)
  }, [vaultRoot, directoryPaths])

  /**
   * 分栏的列链与每列的行（纯函数，见 `domain/columns.ts`）。
   *
   * 依赖里只有 `focusedDir`/`tree`/`selected`/`filter`/`tagVisible`：换一列只改
   * `focusedDir` 或 `selected`，因此这次重算的代价是"每一列过滤它自己的直接子项"，
   * **不重建树**（设计文档 §6 的性能预算）。
   */
  const columnsView = useMemo(
    () =>
      layout === 'columns'
        ? columnsFor({
            tree,
            selected,
            focus: focusedDir,
            filter: deferredFilter,
            visiblePaths: tagVisible,
          })
        : EMPTY_COLUMNS_VIEW,
    [layout, tree, selected, focusedDir, deferredFilter, tagVisible],
  )

  /**
   * `focus` 不合法（被删掉 / 持久化回来的是陈旧值）时，`columnsFor` 已经回退到一个
   * 合理的目录 —— 这里把回退值写回持久化，免得那条陈旧值一直传下去。
   *
   * 只在 `focusAccepted` 为假时动手，因此正常的列链变化不会触发写盘。
   */
  useEffect(() => {
    if (layout !== 'columns' || columnsView.focusAccepted || focusedDir === null) return
    const resolved = columnsView.directories[columnsView.directories.length - 1] ?? ''
    focusChanged(resolved)
  }, [columnsView, focusChanged, focusedDir, layout])

  /**
   * 过滤生效时，子行是自动展开的（见 `expandedForRows`）；行上的三角必须跟着说同一件事，
   * 否则界面自相矛盾（子行明明在，三角却指着右边）。文本过滤走的是同一条
   * （`flattenTree` 的 `autoExpandMatches`），所以这里两个条件合并成一个开关。
   */
  const autoExpanded = deferredFilter.trim() !== '' || tagVisible !== null

  /** 没有任何行可看：单栏看行数，分栏看"所有列的行加总"。 */
  const empty =
    layout === 'columns' ? columnRowCount(columnsView.columns) === 0 : rows.length === 0

  // -- 拖拽整理 -------------------------------------------------------------
  //
  // `dragRef` 是"当前拖的是谁"的**权威副本**：HTML5 在 `dragover` 阶段不允许读取
  // `dataTransfer.getData()`（只在 `drop` 时可读），没有它就没法在悬停时算出落点。
  const dragRef = useRef<DragPayload | null>(null)
  const [dragPayload, setDragPayload] = useState<DragPayload | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)

  const clearDrag = useCallback((): void => {
    useLayoutDrag.getState().end()
    dragRef.current = null
    setDragPayload(null)
    setDropTarget(null)
  }, [])

  /** 悬停时更新落点；同一处不重复 set（避免每次 `dragover` 都重渲染）。 */
  const showDropTarget = useCallback((next: DropTarget): void => {
    setDropTarget((current) => (sameDropTarget(current, next) ? current : next))
  }, [])

  const drag = useTreeDrag({
    dragRef,
    select,
    setDragPayload,
    setDropTarget,
    clearDrag,
    showDropTarget,
    tagVisible,
  })

  // -- 视图句柄（`REVEAL_ROW_EVENT` 用）-------------------------------------
  //
  // 单栏与分栏各拿一个 ref：事件只订阅**一次**（下面那个 effect），
  // 滚到哪儿由当前那个视图回答（单栏滚那一行，分栏滚那一列里的那一行）。
  const singleRef: RefObject<TreeViewHandle | null> = useRef<TreeViewHandle | null>(null)
  const columnsRef: RefObject<TreeViewHandle | null> = useRef<TreeViewHandle | null>(null)

  useEffect(() => {
    const reveal = (event: Event): void => {
      const relPath = (event as CustomEvent<string>).detail
      const handle = layout === 'columns' ? columnsRef.current : singleRef.current
      handle?.reveal(relPath)
    }
    window.addEventListener(REVEAL_ROW_EVENT, reveal)
    return () => {
      window.removeEventListener(REVEAL_ROW_EVENT, reveal)
    }
  }, [layout])

  /**
   * 打开一行（**两种模式共用一个"打开"语义**，只有目录不一样）。
   *
   * 单栏的目录是"展开/收起"（缩进表达的树），分栏的目录是"推进一列"
   * —— 同一个动作在两种画法下的自然结果不同，因此目录那一支由调用方给。
   */
  const activateRow = useCallback(
    (row: RowRef, newTab = false): void => {
      const entry = row.node.entry
      select(entry.relPath)
      if (entry.isDir) {
        // 修饰键在这里没有别的意思，照旧展开/收起（"在新标签里打开目录"没有语义）
        toggleExpanded(entry.relPath)
      } else if (isMarkdown(entry.relPath)) {
        void (newTab ? openNoteInNewTab(entry.relPath) : openNote(entry.relPath))
      } else if (isViewable(entry.relPath)) {
        // 图片一类附件能打开成**只读预览**（ADR-0032）。其余附件（`.txt`、`.zip`…）保持原样：
        // 只选中。判据在 `domain/viewable.ts`，加一类只改那一处。
        useUiStore.getState().openFile(entry.relPath)
      }
    },
    [select, toggleExpanded],
  )

  /**
   * 分栏的"打开/点击一行"。
   *
   * 目录 = **推进一列**（`focus` 换成它，末列变成它的内容），而 `selected` **不动**
   * —— 于是那一行在左边那一列里保持高亮，右边已经是它的内容。这正是 Finder 的样子，
   * 也是"点一下就能往下钻"的实现。
   *
   * 文件那一支与单栏逐字相同（打开笔记 / 开查看器 / 只选中）。
   */
  const activateRowInColumns = useCallback(
    (row: RowRef, newTab = false): void => {
      const entry = row.node.entry
      const target = drillTarget(entry, directoryPaths)
      if (target !== null) {
        focusChanged(target)
        return
      }
      activateRow(row, newTab)
    },
    [activateRow, directoryPaths, focusChanged],
  )

  /**
   * 回退一列（`←` 与**点焦点列的列头**共用这一条）。
   *
   * 两处共用而不是各写一遍：`focus` 与 `selected` 必须**同时**指到父目录
   * （见设计文档 §4 第 2 条），两处各写一遍的第一天就会分叉成"点列头只换了内容、
   * 高亮还留在子目录里"。
   */
  const columnsBack = useCallback((): void => {
    const focusPath = columnsView.directories[columnsView.directories.length - 1] ?? ''
    const parent = arrowLeftTarget(focusPath)
    if (parent === null) return
    focusChanged(parent)
    select(parent)
  }, [columnsView.directories, focusChanged, select])

  /**
   * 与画法**无关**的那几个键：`F2` / `Delete` / `Escape`。两种模式共用这一段
   * —— 它们作用在 `selected` 上，或者作用在"标签过滤生效中"这个状态上，
   * 都与"行画在哪儿"没有关系。
   *
   * 单独成函数是为了让分栏那一段能把未处理的键原样交回来（见 `handleColumnsKey`），
   * 而不是把 F2 再实现一遍 —— 两份实现的第一天就会分叉。
   */
  const handleSharedKey = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      switch (event.key) {
        case 'Delete': {
          if (selected === null) return
          event.preventDefault()
          void deleteSelected(selected)
          return
        }
        case 'F2': {
          // 与 Windows 资源管理器一致：F2 重命名（目录暂不支持，renameSelected 里说明原因）
          if (selected === null) return
          event.preventDefault()
          renameSelected(selected)
          return
        }
        case 'Escape': {
          // 一键回到全量（与控件上的「清除」同一条路径）。焦点在树上时按 Esc 是用户最自然的
          // 第一反应，而过滤把树收窄之后"怎么退回去"必须是零思考的。
          if (!tagView.active) return
          event.preventDefault()
          clearTagFilter()
          return
        }
        default:
          return
      }
    },
    [clearTagFilter, selected, tagView.active],
  )

  /**
   * 键盘模型：两种画法共用一个入口（设计文档 §4）。
   *
   * 差别只在"往哪走"：单栏靠 `expanded` + 展平行列表，分栏靠焦点目录 + `selected`。
   * 分栏那几条的落点全部取自 `domain/columns.ts` 的纯函数（`siblingRowTarget` /
   * `drillTarget` / `arrowLeftTarget`），不在这里拼第二套"先看 isDir 再看下一行"。
   */
  const handleColumnsKey = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      const column = columnsView.columns[columnsView.activeIndex]
      if (column === undefined) return
      const focusedRow = indexAt(column, selected)
      const focusedEntry = focusedRow === -1 ? null : column.rows[focusedRow]?.entry

      switch (event.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
          const target = siblingRowTarget(
            column,
            selected,
            event.key === 'ArrowDown' ? 'down' : 'up',
          )
          if (target === null) return
          event.preventDefault()
          select(target)
          return
        }
        case 'ArrowRight':
        case 'Enter': {
          /*
           * 目录 → 推进一列（`Enter` 与 `→` 在目录上是同一件事，与单栏"Enter 展开目录"对应）；
           * 文件 → `Enter` 打开、`→` 不做事（右边没有"下一列"）。
           */
          const drill = drillTarget(focusedEntry, directoryPaths)
          if (drill !== null) {
            event.preventDefault()
            focusChanged(drill)
            return
          }
          if (event.key === 'ArrowRight' || focusedRow === -1) return
          const row = column.rows[focusedRow]
          if (row === undefined) return
          event.preventDefault()
          activateRow({ node: row, hasChildren: row.children.length > 0 })
          return
        }
        case 'ArrowLeft': {
          // 回退一列（与点焦点列的列头同一条路径，见 `columnsBack`）
          event.preventDefault()
          columnsBack()
          return
        }
        default: {
          // F2 / Delete / Escape：与画法无关，判据在共用那一段（不在这里实现第二遍）
          handleSharedKey(event)
          return
        }
      }
    },
    [activateRow, columnsBack, columnsView, directoryPaths, focusChanged, handleSharedKey, select, selected],
  )

  /**
   * 键盘模型：两种画法共用一个入口（设计文档 §4）。
   *
   * 差别只在"往哪走"：单栏靠 `expanded` + 展平行列表，分栏靠焦点目录 + `selected`。
   * 分栏那几条的落点全部取自 `domain/columns.ts` 的纯函数（`siblingRowTarget` /
   * `drillTarget` / `arrowLeftTarget`），不在这里拼第二套"先看 isDir 再看下一行"。
   */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (empty) return

      if (layout === 'columns') {
        handleColumnsKey(event)
        return
      }

      const found = rows.findIndex((row) => row.node.entry.relPath === selected)
      const index = found === -1 ? 0 : found
      const row = rows[index]
      if (row === undefined) return
      const entry = row.node.entry

      switch (event.key) {
        case 'ArrowDown': {
          const next = rows[Math.min(rows.length - 1, index + 1)]
          if (next === undefined) return
          event.preventDefault()
          select(next.node.entry.relPath)
          revealRow(next.node.entry.relPath)
          return
        }
        case 'ArrowUp': {
          const previous = rows[Math.max(0, index - 1)]
          if (previous === undefined) return
          event.preventDefault()
          select(previous.node.entry.relPath)
          revealRow(previous.node.entry.relPath)
          return
        }
        case 'ArrowRight': {
          event.preventDefault()
          if (entry.isDir && !expanded.has(entry.relPath)) {
            toggleExpanded(entry.relPath)
          } else if (row.hasChildren) {
            const child = rows[index + 1]
            if (child !== undefined) {
              select(child.node.entry.relPath)
              revealRow(child.node.entry.relPath)
            }
          }
          return
        }
        case 'ArrowLeft': {
          event.preventDefault()
          if (entry.isDir && expanded.has(entry.relPath)) {
            toggleExpanded(entry.relPath)
            return
          }
          const parent = rows
            .slice(0, index)
            .reverse()
            .find((candidate) => candidate.depth === row.depth - 1)
          if (parent !== undefined) {
            select(parent.node.entry.relPath)
            revealRow(parent.node.entry.relPath)
          }
          return
        }
        case 'Enter': {
          event.preventDefault()
          activateRow(row)
          return
        }
        default:
          // F2 / Delete / Escape
          handleSharedKey(event)
          return
      }
    },
    [
      activateRow,
      empty,
      expanded,
      handleColumnsKey,
      handleSharedKey,
      layout,
      rows,
      select,
      selected,
      toggleExpanded,
    ],
  )

  /**
   * 右键菜单：`null` = 没打开。
   *
   * 菜单项**直接执行既有命令**（`note.new` / `note.rename` / `note.move` / `note.delete` /
   * `tree.expandAll` …），而不是在这里重写一遍动作 —— 命令表是"这些动作到底做什么"的唯一事实来源，
   * 右键只是它的又一个入口（与 F2/F6/Delete、工具栏按钮完全同一条链路）。
   * 需要"针对哪一行"的命令先 `select(relPath)`：命令读的就是 store 里的选中项。
   *
   * 状态里只存坐标：菜单项由"当前选中项"现算（右键即选中，两者必然一致），
   * 于是菜单打开期间选中项被别处改掉（外部改动 / 命令）也不会出现"菜单说的是这一行、
   * 动作作用在另一行"这种错位。
   */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  const openRowMenu = useCallback(
    (row: RowRef, event: React.MouseEvent<HTMLDivElement>): void => {
      event.preventDefault()
      // 右键即选中：菜单上的动作都作用于这一行，而选中态是它唯一的载体
      select(row.node.entry.relPath)
      setMenu({ x: event.clientX, y: event.clientY })
    },
    [select],
  )

  const menuEntry = useMemo(
    () => (menu === null ? null : findEntry(tree, selected)),
    [menu, selected, tree],
  )

  const menuItemsFor = useCallback(
    (entry: EntryMeta): ContextMenuItem[] => {
      const path = entry.relPath
      const row: RowRef = { node: { entry, children: [] }, hasChildren: false }
      const markdown = isMarkdown(path)
      const run = (id: string) => () => void commands.execute(id)
      const items: ContextMenuItem[] = [
        {
          id: 'open',
          label: entry.isDir ? (expanded.has(path) ? '折叠' : '展开') : '打开',
          disabled: !entry.isDir && !markdown,
          // 目录的"展开/折叠"只对单栏有视觉意义；分栏里目录的激活是"推进一列"，
          // 因此这里按当前模式分派（与点击一行走的是同一个函数）
          onSelect: () => (layout === 'columns' ? activateRowInColumns(row) : activateRow(row)),
        },
        { id: 'new', label: '在这里新建笔记', onSelect: run('note.new') },
        { id: 'rename', label: '重命名…', onSelect: run('note.rename'), separatorBefore: true },
        { id: 'move', label: '移动到文件夹…', onSelect: run('note.move') },
        {
          id: 'reveal',
          label: '在文件树中定位',
          onSelect: () => {
            select(path)
            revealRow(path)
          },
        },
        {
          id: 'copy-path',
          label: '复制相对路径',
          // 失败时 `copyText` 自己弹 toast（剪贴板权限被拒的场合），这里不假装成功
          onSelect: () => void copyText(path),
        },
      ]
      if (entry.isDir) {
        items.push(
          { id: 'expand-all', label: '展开全部目录', onSelect: run('tree.expandAll'), separatorBefore: true },
          { id: 'collapse-all', label: '折叠全部目录', onSelect: run('tree.collapseAll') },
        )
      }
      items.push({
        id: 'delete',
        label: '删除到回收站…',
        danger: true,
        separatorBefore: true,
        onSelect: run('note.delete'),
      })
      return items
    },
    [activateRow, activateRowInColumns, expanded, layout, select],
  )

  if (empty) {
    /*
     * 空态必须回答"为什么空"。标签过滤是**收窄**视图，用户看不到笔记时第一反应是
     * "我的笔记是不是没了" —— 所以这里把三种可能分开说：没有笔记用这些标签 /
     * 命中的都不在当前条目表里（刚重扫）/ 被文本过滤又筛掉了。
     */
    if (tagVisible !== null) {
      const labels = tagView.labels.map((label) => `#${label}`).join('、')
      const excludedLabels = tagView.excludeLabels.map((label) => `#${label}`).join('、')
      const wanted =
        labels === ''
          ? `不含 ${excludedLabels}`
          : excludedLabels === ''
            ? `使用 ${labels}`
            : `使用 ${labels} 且不含 ${excludedLabels}`
      const reason =
        tagView.hitCount === 0
          ? tagView.taggedTotal === 0
            ? '这个 Vault 里还没有带标签的笔记'
            : `没有笔记${wanted}`
          : tagView.visibleNoteCount > 0
            ? `标签命中的 ${tagView.visibleNoteCount} 篇笔记都被文本过滤排除了`
            : `命中（${wanted}）的 ${tagView.hitCount} 篇笔记都不在当前文件树里`
      return (
        <div className="mn-tree mn-tree--empty" role="tree" aria-label="文件树">
          <p className="mn-empty__text" data-tag-filter-empty>
            {reason}。
          </p>
          {filter !== '' && (
            <p className="mn-empty__text">文本过滤「{filter}」也在生效。</p>
          )}
          <div className="mn-tree__empty-buttons">
            {tagView.hitCount > 0 && (
              <button
                type="button"
                className="mn-button"
                onClick={() => void reloadTagFilter()}
              >
                重新过滤
              </button>
            )}
            <button type="button" className="mn-button" onClick={clearTagFilter}>
              清除标签过滤
            </button>
          </div>
          {filter !== '' && (
            <button type="button" className="mn-button" onClick={() => setFilter('')}>
              清除文本过滤
            </button>
          )}
        </div>
      )
    }
    return (
      <div className="mn-tree mn-tree--empty" role="tree" aria-label="文件树">
        <p className="mn-empty__text">
          {filter !== '' ? '没有匹配的笔记' : '这个 Vault 还没有 Markdown 文件'}
        </p>
        {filter !== '' ? (
          <button type="button" className="mn-button" onClick={() => setFilter('')}>
            清除过滤
          </button>
        ) : (
          <button type="button" className="mn-button" onClick={() => void createNoteHere()}>
            新建第一篇笔记
          </button>
        )}
      </div>
    )
  }

  return (
    <>
      {layout === 'columns' ? (
        <ColumnsTree
          viewRef={columnsRef}
          view={columnsView}
          selected={selected}
          autoExpanded={autoExpanded}
          draggingPath={dragPayload?.relPath ?? null}
          dropTarget={dropTarget}
          drag={drag}
          onActivate={activateRowInColumns}
          onContextMenu={openRowMenu}
          onKeyDown={handleKeyDown}
          onColumnBack={columnsBack}
        />
      ) : (
        <SingleColumnTree
          viewRef={singleRef}
          rows={rows}
          selected={selected}
          autoExpanded={autoExpanded}
          draggingPath={dragPayload?.relPath ?? null}
          dropTarget={dropTarget}
          drag={drag}
          onActivate={activateRow}
          onContextMenu={openRowMenu}
          onKeyDown={handleKeyDown}
        />
      )}
      {/* 对话框挂在这里而不是 App：叠加层是 fixed 定位，位置与挂载点无关，
          而"谁能请求重命名/移动"的信息（选中行、F2/F6）本来就属于文件树。 */}
      <RenameDialog />
      <MoveDialog />
      {menu !== null && menuEntry !== null && (
        <ContextMenu
          items={menuItemsFor(menuEntry)}
          x={menu.x}
          y={menu.y}
          ariaLabel={`${menuEntry.name} 的操作菜单`}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  )
}

/** 在树里按 `relPath` 找一条条目（右键菜单用：菜单项按当前选中项现算）。 */
function findEntry(tree: readonly TreeNode[], relPath: string | null): EntryMeta | null {
  if (relPath === null) return null
  const stack: TreeNode[] = [...tree]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) continue
    if (node.entry.relPath === relPath) return node.entry
    for (const child of node.children) stack.push(child)
  }
  return null
}

/** 一行在某一列里的下标（`-1` = 不在这一列）。 */
function indexAt(column: ColumnView, relPath: string | null): number {
  if (relPath === null) return -1
  return column.rows.findIndex((node) => node.entry.relPath === relPath)
}
