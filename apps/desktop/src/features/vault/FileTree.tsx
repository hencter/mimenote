/**
 * 文件树：虚拟化渲染 + 键盘导航 + 过滤 + **拖拽整理**。
 *
 * 性能（architecture.md §6）：固定行高 + 只渲染可视行（overscan 10 行）。
 * 无论 Vault 有 1 千还是 10 万条目，DOM 中的行数恒定在几十行以内，
 * 滚动因此稳定在 60fps。行组件只订阅自己的布尔状态，选中某一项不会重渲染整棵树。
 *
 * 拖拽（M3 最后一项）：
 *
 * * **只拖 Markdown 笔记**（目录拖动与多选都推迟），所以行上的 `draggable` 是有条件的；
 * * **落点判定**全部交给 `domain/drag` 的纯函数（文件夹 → 那个文件夹；笔记 → 它的目录；
 *   空白 → Vault 根目录），组件只负责把结果显示出来；
 * * 悬停高亮只改**一行**：被拖的那一行与当前落点行（`dropTarget.hostRelPath`），
 *   其余行按 `memo` 原样跳过 —— 否则每移动一次鼠标都要重渲染几十行；
 * * HTML5 的 `dragover` 阶段读不到 `dataTransfer.getData()`，所以"当前拖的是谁"留在
 *   组件状态里，`dataTransfer` 只用于过手（顺带让外部程序能拿到相对路径）。
 *
 * 标签过滤（`TagFilterControl.tsx` + `domain/tag-filter.ts`，见 architecture.md §8 第 3 条）：
 *
 * * **只读的收窄视图**：可见行 = 文本过滤的结果 ∩ 标签命中集合。两个条件都交给既有的
 *   `flattenTree` 展平，因此排序、祖先保留、虚拟窗口、键盘导航**只有一套实现**
 *   —— 过滤视图里不会长出第二套"怎么展开、怎么排"的规则；
 * * **命中的祖先目录自动展开**：与文本过滤的 `autoExpandMatches` 同一观感。行集是
 *   `flattenTree` 与标签集合的交集，所以这里把可见目录并进 `expanded` 一起喂给它
 *   （否则命中项会藏在没展开的目录里，看起来像"过滤没生效"）；
 * * **拖拽的唯一例外**：过滤期间"树的空白区域 = Vault 根目录"这个落点被停用，并给出原因。
 *   过滤之后列表很短、空白区域很大，一次不经意的拖动就会把笔记静默搬到根目录 ——
 *   而根目录在收窄视图里通常根本看不见。行与行之间的拖动照旧（落点都是看得见的行，
 *   "拖到看不见的地方"在结构上不可能发生）；
 * * 重命名 / 新建 / 删除 / F6 移动照旧可用：它们作用在**选中项**上，与视图收窄无关
 *   （`F6` 的移动对话框会把目标目录名逐条列出来，不存在"选了看不见的落点"）；
 * * **Esc**：过滤生效时按下即回到全量（与控件上的「清除」同一条路径）。
 */

import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { createNoteHere, deleteSelected, moveEntry, openNote, renameSelected } from '@/app/actions'
import { commands } from '@/app/commands'
import { REVEAL_ROW_EVENT } from '@/app/dom-events'
import { ContextMenu, type ContextMenuItem } from '@/components/ContextMenu'
import { Icon } from '@/components/Icon'
import { copyText } from '@/domain/clipboard'
import {
  canDrag,
  dragPayloadOf,
  dropTargetFor,
  readDragPayload,
  sameDropTarget,
  writeDragPayload,
  type DragPayload,
  type DropTarget,
} from '@/domain/drag'
import { formatBytes } from '@/domain/format'
import { displayName, isMarkdown } from '@/domain/paths'
import { flattenTree, type FlatRow } from '@/domain/tree'
import { computeWindow, scrollTopToReveal } from '@/domain/virtual-list'
import { useNoteStore } from '@/state/note-store'
import { useTagFilterStore } from '@/state/tag-filter-store'
import { toast } from '@/state/toast-store'
import { useVaultStore } from '@/state/vault-store'
import { MoveDialog } from './MoveDialog'
import { RenameDialog } from './RenameDialog'
import { useTagFilterView } from './use-tag-filter-view'

import './drag-drop.css'
// 标签过滤的样式也在这里托管一条（空态按钮的排版）：`styles/app.css` 不在本次改动的范围内，
// 而它属于"标签过滤"这个能力带来的界面，因此与控件样式放在一起；重复 import 会被打包器去重
import './tag-filter.css'

const ROW_HEIGHT = 26
const OVERSCAN = 10
/**
 * 尚未测量出视口高度时的兜底值。
 *
 * 为什么需要它：首帧渲染时容器高度可能还是 0（尚未布局/被隐藏/测试环境无布局引擎）。
 * 若直接用 0 去算窗口，就只会渲染 overscan 那几行，看起来像"文件树空的"。
 * 兜底值只会影响**首次**渲染，ResizeObserver 一触发就被真实高度替代。
 */
const FALLBACK_VIEWPORT_HEIGHT = 640

function revealRow(relPath: string): void {
  window.dispatchEvent(new CustomEvent<string>(REVEAL_ROW_EVENT, { detail: relPath }))
}

/**
 * 落点的最终执行：**唯一**的"把拖拽变成移动"的地方。
 *
 * 笔记与文件夹都走同一条 `moveEntry`（它按条目类型分派）：拖拽只是"把某个条目挪到某个目录"
 * 的手势，两种条目在"搬 + 改写链接 + 索引同步"这条链路上没有区别。
 *
 * 不可放置的落点（同一目录、拖到自己身上、拖进自己的后代）在这里就被拦下：不触发 IPC，
 * 只把**原因**告诉用户 —— 静默无反应是拖拽最糟的反馈。
 */
async function applyDrop(payload: DragPayload, target: DropTarget): Promise<void> {
  if (!target.valid || target.parentRel === null) {
    toast.info(target.label, target.reason ?? '')
    return
  }
  await moveEntry(payload.relPath, target.parentRel)
}

export function FileTree() {
  const tree = useVaultStore((state) => state.tree)
  const expanded = useVaultStore((state) => state.expanded)
  const filter = useVaultStore((state) => state.filter)
  const selected = useVaultStore((state) => state.selected)
  const toggleExpanded = useVaultStore((state) => state.toggleExpanded)
  const select = useVaultStore((state) => state.select)
  const setFilter = useVaultStore((state) => state.setFilter)

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
   * 可见行 = `flattenTree` 的结果 ∩ 标签可见集合。
   *
   * 为什么不给 `flattenTree` 加一个"只看这些路径"的选项：那要改 `domain/tree.ts`
   * （别的改动的战场），而这里**两处过滤共用同一份展平结果**正是我们要的
   * —— 文本过滤与标签过滤的祖先保留、排序、自动展开因此不可能漂移。
   */
  const rows = useMemo(() => {
    const all = flattenTree(tree, { expanded: expandedForRows, filter: deferredFilter })
    return tagVisible === null
      ? all
      : all.filter((row) => tagVisible.has(row.node.entry.relPath))
  }, [tree, expandedForRows, deferredFilter, tagVisible])

  /**
   * 过滤生效时，子行是自动展开的（见 `expandedForRows`）；行上的三角必须跟着说同一件事，
   * 否则界面自相矛盾（子行明明在，三角却指着右边）。文本过滤走的是同一条
   * （`flattenTree` 的 `autoExpandMatches`），所以这里两个条件合并成一个开关。
   */
  const autoExpanded = deferredFilter.trim() !== '' || tagVisible !== null

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 })
  const pendingScrollTop = useRef(0)
  const frameHandle = useRef<number | null>(null)

  // -- 拖拽整理 -------------------------------------------------------------
  //
  // `dragRef` 是"当前拖的是谁"的**权威副本**：HTML5 在 `dragover` 阶段不允许读取
  // `dataTransfer.getData()`（只在 `drop` 时可读），没有它就没法在悬停时算出落点。
  const dragRef = useRef<DragPayload | null>(null)
  const [dragPayload, setDragPayload] = useState<DragPayload | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)

  const clearDrag = useCallback((): void => {
    dragRef.current = null
    setDragPayload(null)
    setDropTarget(null)
  }, [])

  /** 悬停时更新落点；同一处不重复 set（避免每次 `dragover` 都重渲染）。 */
  const showDropTarget = useCallback((next: DropTarget): void => {
    setDropTarget((current) => (sameDropTarget(current, next) ? current : next))
  }, [])

  const handleDragStart = useCallback(
    (row: FlatRow, event: React.DragEvent<HTMLDivElement>): void => {
      const entry = row.node.entry
      if (!canDrag(entry)) {
        // 附件（图片/`.txt`）不可拖动：移动它们要"顺带改写指向它的链接"，而索引里没有它们
        // 的条目 —— 拖了只会得到一次无提示的裸搬迁
        event.preventDefault()
        return
      }
      const payload = dragPayloadOf(entry)
      dragRef.current = payload
      setDragPayload(payload)
      writeDragPayload(event.dataTransfer, payload)
      select(entry.relPath)
    },
    [select],
  )

  const handleDragOver = useCallback(
    (row: FlatRow, event: React.DragEvent<HTMLDivElement>): void => {
      const payload = dragRef.current ?? readDragPayload(event.dataTransfer)
      if (payload === null) return
      const target = dropTargetFor(row.node.entry, payload)
      // 必须 preventDefault，否则浏览器不认这里是可放置区（也就不会有 drop 事件）
      event.preventDefault()
      // 行自己处理落点，不要再冒泡到容器 —— 那里代表"树的空白区域 = Vault 根目录"
      event.stopPropagation()
      event.dataTransfer.dropEffect = target.valid ? 'move' : 'none'
      showDropTarget(target)
    },
    [showDropTarget],
  )

  const handleDrop = useCallback(
    (row: FlatRow, event: React.DragEvent<HTMLDivElement>): void => {
      const payload = dragRef.current ?? readDragPayload(event.dataTransfer)
      if (payload === null) return
      event.preventDefault()
      event.stopPropagation()
      const target = dropTargetFor(row.node.entry, payload)
      clearDrag()
      void applyDrop(payload, target)
    },
    [clearDrag],
  )

  /** 容器的空白区域：等于"移到 Vault 根目录"（**标签过滤期间除外**，见下）。 */
  const handleRootDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      const payload = dragRef.current ?? readDragPayload(event.dataTransfer)
      if (payload === null) return
      if (tagVisible !== null) {
        // 过滤期间**不接收**空白区域的落点：收窄之后列表往往只有几行，下方全是空白，
        // 而"空白 = Vault 根目录"在收窄视图里恰恰是最看不见的那个目标。
        // 不 `preventDefault` = 浏览器给出"不可放置"的光标 —— 比静默搬家诚实。
        setDropTarget(null)
        return
      }
      const target = dropTargetFor(null, payload)
      event.preventDefault()
      event.dataTransfer.dropEffect = target.valid ? 'move' : 'none'
      showDropTarget(target)
    },
    [showDropTarget, tagVisible],
  )

  const handleRootDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      const payload = dragRef.current ?? readDragPayload(event.dataTransfer)
      if (payload === null) return
      if (tagVisible !== null) {
        // 真实浏览器里到不了这里（没有 `preventDefault` 就没有 `drop`），但把原因说出来
        // 成本极低：静默吞掉一次拖拽才是最糟的反馈（也是这句提示存在的唯一理由）
        clearDrag()
        toast.info(
          '过滤期间不能拖到树的空白处',
          '空白处 = Vault 根目录。请拖到看得见的文件夹行上，或先清除标签过滤。',
        )
        return
      }
      event.preventDefault()
      const target = dropTargetFor(null, payload)
      clearDrag()
      void applyDrop(payload, target)
    },
    [clearDrag, tagVisible],
  )

  /** 拖出树的范围时收掉高亮（`dragleave` 在子元素之间移动也会触发，所以要判包含关系）。 */
  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget
    if (next instanceof Node && event.currentTarget.contains(next)) return
    setDropTarget(null)
  }, [])

  // 视口高度：用 useLayoutEffect 在首次绘制前测一次，避免首帧渲染空白；
  // 之后交给 ResizeObserver（窗口缩放、侧栏拖拽、视图切换都会触发）。
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    const measure = (): void => {
      setViewport((current) =>
        current.height === element.clientHeight
          ? current
          : { ...current, height: element.clientHeight },
      )
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => {
        window.removeEventListener('resize', measure)
      }
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [])

  // 滚动：用 rAF 合并高频事件，每个 scroll 事件不再各触发一次 React 渲染
  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    pendingScrollTop.current = event.currentTarget.scrollTop
    if (frameHandle.current !== null) return
    frameHandle.current = requestAnimationFrame(() => {
      frameHandle.current = null
      const next = pendingScrollTop.current
      setViewport((current) =>
        current.scrollTop === next ? current : { ...current, scrollTop: next },
      )
    })
  }, [])

  useEffect(
    () => () => {
      if (frameHandle.current !== null) cancelAnimationFrame(frameHandle.current)
    },
    [],
  )

  // 打开笔记后把对应行滚入可视区
  useEffect(() => {
    const reveal = (event: Event): void => {
      const relPath = (event as CustomEvent<string>).detail
      const element = scrollRef.current
      if (element === null) return
      const index = rows.findIndex((row) => row.node.entry.relPath === relPath)
      if (index === -1) return
      const nextTop = scrollTopToReveal(
        index,
        element.scrollTop,
        element.clientHeight,
        ROW_HEIGHT,
        rows.length,
      )
      element.scrollTop = nextTop
      setViewport((current) => ({ ...current, scrollTop: nextTop }))
    }
    window.addEventListener(REVEAL_ROW_EVENT, reveal)
    return () => {
      window.removeEventListener(REVEAL_ROW_EVENT, reveal)
    }
  }, [rows])

  const range = computeWindow({
    scrollTop: viewport.scrollTop,
    // 未测量到高度时用兜底值，保证首次渲染就有行（而不是空白）
    viewportHeight: viewport.height > 0 ? viewport.height : FALLBACK_VIEWPORT_HEIGHT,
    rowHeight: ROW_HEIGHT,
    itemCount: rows.length,
    overscan: OVERSCAN,
  })
  const visibleRows = rows.slice(range.start, range.end)

  const activateRow = useCallback(
    (row: FlatRow): void => {
      const entry = row.node.entry
      select(entry.relPath)
      if (entry.isDir) {
        toggleExpanded(entry.relPath)
      } else if (isMarkdown(entry.relPath)) {
        void openNote(entry.relPath)
      }
    },
    [select, toggleExpanded],
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (rows.length === 0) return
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
        case 'Delete': {
          event.preventDefault()
          void deleteSelected(entry.relPath)
          return
        }
        case 'F2': {
          // 与 Windows 资源管理器一致：F2 重命名（目录暂不支持，renameSelected 里说明原因）
          event.preventDefault()
          renameSelected(entry.relPath)
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
    [activateRow, clearTagFilter, expanded, rows, select, selected, tagView.active, toggleExpanded],
  )

  /**
   * 右键菜单：`null` = 没打开。
   *
   * 菜单项**直接执行既有命令**（`note.new` / `note.rename` / `note.move` / `note.delete` /
   * `tree.expandAll` …），而不是在这里重写一遍动作 —— 命令表是"这些动作到底做什么"的唯一事实来源，
   * 右键只是它的又一个入口（与 F2/F6/Delete、工具栏按钮完全同一条链路）。
   * 需要"针对哪一行"的命令先 `select(relPath)`：命令读的就是 store 里的选中项。
   */
  const [menu, setMenu] = useState<{ row: FlatRow; x: number; y: number } | null>(null)

  const openRowMenu = useCallback(
    (row: FlatRow, event: React.MouseEvent<HTMLDivElement>): void => {
      event.preventDefault()
      // 右键即选中：菜单上的动作都作用于这一行，而选中态是它唯一的载体
      select(row.node.entry.relPath)
      setMenu({ row, x: event.clientX, y: event.clientY })
    },
    [select],
  )

  const menuItemsFor = useCallback((row: FlatRow): ContextMenuItem[] => {
    const entry = row.node.entry
    const markdown = isMarkdown(entry.relPath)
    const run = (id: string) => () => void commands.execute(id)
    const items: ContextMenuItem[] = [
      {
        id: 'open',
        label: entry.isDir ? (expanded.has(entry.relPath) ? '折叠' : '展开') : '打开',
        disabled: !entry.isDir && !markdown,
        onSelect: () => activateRow(row),
      },
      { id: 'new', label: '在这里新建笔记', onSelect: run('note.new') },
      { id: 'rename', label: '重命名…', onSelect: run('note.rename'), separatorBefore: true },
      { id: 'move', label: '移动到文件夹…', onSelect: run('note.move') },
      {
        id: 'reveal',
        label: '在文件树中定位',
        onSelect: () => {
          select(entry.relPath)
          revealRow(entry.relPath)
        },
      },
      {
        id: 'copy-path',
        label: '复制相对路径',
        // 失败时 `copyText` 自己弹 toast（剪贴板权限被拒的场合），这里不假装成功
        onSelect: () => void copyText(entry.relPath),
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
  }, [activateRow, expanded, select])

  if (rows.length === 0) {
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
      <div
        className="mn-tree"
        ref={scrollRef}
        role="tree"
        aria-label="文件树"
        aria-activedescendant={selected === null ? undefined : rowId(selected)}
        tabIndex={0}
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
        // 空白区域（含行下方的留白）＝ Vault 根目录：行自己会 stopPropagation，
        // 所以能走到这里的 dragover/drop 一定是"落在树上但没落在某一行上"
        onDragOver={handleRootDragOver}
        onDrop={handleRootDrop}
        onDragLeave={handleDragLeave}
        // dragend 会从源行冒泡上来：无论成功与否都收掉高亮，不留一个假的"落点"
        onDragEnd={clearDrag}
        data-drop-root={
          dropTarget !== null && dropTarget.hostRelPath === '' ? dropTarget.dataState : undefined
        }
      >
        <div className="mn-tree__spacer" style={{ height: range.totalHeight }}>
          <div className="mn-tree__window" style={{ transform: `translateY(${range.offsetY}px)` }}>
            {visibleRows.map((row) => (
              <FileTreeRow
                key={row.node.entry.relPath}
                row={row}
                onActivate={activateRow}
                onContextMenu={openRowMenu}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                dragging={dragPayload?.relPath === row.node.entry.relPath}
                autoExpanded={autoExpanded}
                dropState={
                  dropTarget !== null && dropTarget.hostRelPath === row.node.entry.relPath
                    ? dropTarget.dataState
                    : 'none'
                }
              />
            ))}
          </div>
        </div>
      </div>
      {/* 对话框挂在这里而不是 App：叠加层是 fixed 定位，位置与挂载点无关，
          而"谁能请求重命名/移动"的信息（选中行、F2/F6）本来就属于文件树。 */}
      <RenameDialog />
      <MoveDialog />
      {menu !== null && (
        <ContextMenu
          items={menuItemsFor(menu.row)}
          x={menu.x}
          y={menu.y}
          ariaLabel={`${menu.row.node.entry.name} 的操作菜单`}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  )
}

function rowId(relPath: string): string {
  return `mn-tree-row-${encodeURIComponent(relPath)}`
}

/** 一行在当前拖拽里的角色（决定样式与 `data-*` 断言点）。 */
type RowDropState = 'none' | 'valid' | 'invalid'

interface RowProps {
  row: FlatRow
  onActivate: (row: FlatRow) => void
  /** 右键：菜单由**父组件**持有（一行一份状态会让虚拟列表里几十行各挂一个菜单） */
  onContextMenu: (row: FlatRow, event: React.MouseEvent<HTMLDivElement>) => void
  onDragStart: (row: FlatRow, event: React.DragEvent<HTMLDivElement>) => void
  onDragOver: (row: FlatRow, event: React.DragEvent<HTMLDivElement>) => void
  onDrop: (row: FlatRow, event: React.DragEvent<HTMLDivElement>) => void
  /** 这一行是不是被拖动的源。 */
  dragging: boolean
  /** 这一行是不是当前落点。 */
  dropState: RowDropState
  /**
   * 当前有过滤生效（文本或标签）—— 此时子行是**自动展开**的，三角必须跟着说同一件事。
   * 见 `FileTree` 里 `autoExpanded` 的注释。
   */
  autoExpanded: boolean
}

const FileTreeRow = memo(function FileTreeRow({
  row,
  onActivate,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
  dragging,
  dropState,
  autoExpanded,
}: RowProps) {
  const entry = row.node.entry
  const relPath = entry.relPath
  const isSelected = useVaultStore((state) => state.selected === relPath)
  const isExpanded = useVaultStore((state) => entry.isDir && state.expanded.has(relPath))
  const isOpen = useNoteStore((state) => state.doc?.relPath === relPath)
  const markdown = isMarkdown(relPath)
  /** 视觉上这一行的子项在不在下面（过滤时子项由过滤条件强制展开，与 store 无关）。 */
  const showsChildren = isExpanded || (entry.isDir && autoExpanded)

  const iconName = entry.isDir
    ? showsChildren
      ? 'folderOpen'
      : 'folder'
    : markdown
      ? 'file'
      : 'dot'
  // 笔记与**文件夹**都可以拖（附件不行：索引里没有它们的条目，见 `canDrag`）；
  // 目录行同样是**合法的落点**
  const draggable = entry.isDir || markdown

  return (
    <div
      id={rowId(relPath)}
      data-rel-path={relPath}
      data-drop-state={dropState === 'none' ? undefined : dropState}
      className={[
        'mn-tree-row',
        isSelected ? 'mn-tree-row--selected' : '',
        isOpen ? 'mn-tree-row--open' : '',
        dragging ? 'mn-tree-row--dragging' : '',
        dropState === 'valid' ? 'mn-tree-row--drop-valid' : '',
        dropState === 'invalid' ? 'mn-tree-row--drop-invalid' : '',
      ]
        .filter((name) => name !== '')
        .join(' ')}
      role="treeitem"
      aria-selected={isSelected}
      aria-expanded={entry.isDir ? showsChildren : undefined}
      aria-level={row.depth + 1}
      style={{ paddingLeft: `${6 + row.depth * 14}px`, height: ROW_HEIGHT }}
      title={`${relPath}${entry.isDir ? '' : ` · ${formatBytes(entry.sizeBytes)}`}`}
      onClick={() => onActivate(row)}
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
          <Icon name="chevron" size={13} />
        </span>
      ) : (
        <span className="mn-tree-row__chevron mn-tree-row__chevron--placeholder" />
      )}
      <Icon name={iconName} size={14} className="mn-tree-row__icon" />
      <span className="mn-tree-row__name">{entry.isDir ? entry.name : displayName(relPath)}</span>
      {!entry.isDir && !markdown && <span className="mn-tree-row__badge">{entry.ext ?? '?'}</span>}
    </div>
  )
})
