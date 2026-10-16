/**
 * 分栏（Miller columns）文件树：一列 = 一个目录的直接子项，最后一列 = **焦点目录**的内容。
 *
 * 列链、每列的行、过滤口径、导航落点**全部**在 `domain/columns.ts`（纯函数）里，
 * 这个文件只负责三件事：每列各自的虚拟化、滚动、把行画出来。
 * 设计细节与被否决的替代方案见 `docs/design/04-miller-columns.md`（对应 ADR-0058）。
 *
 * ## 焦点目录是分栏唯一的额外状态
 *
 * 它由**容器**（`FileTree.tsx`）持有并持久化（`tree-focus.ts`，按 Vault 根分桶），
 * 这里只通过 props 收 `view`（`columnsFor` 的结果）—— 视图不持有它，因此"换列"永远
 * 只是父级重渲染，不需要在这个组件里对账。
 *
 * 为什么必须是独立状态（而不是由 `selected` 推导）：见 `domain/columns.ts` 的文件头
 * —— 由 `selected` 推导时"点一个目录右侧不会多出一列、键盘无法向下钻"，那两条在
 * 真机走查里当场就被否掉了。
 *
 * ## 为什么每列有自己的滚动与虚拟窗口
 *
 * 一列 = 一个目录，行数可以到几千（一个放了几千篇笔记的目录）。整块容器只有一个
 * 虚拟窗口的话，"左边那列滚到底"会带着右边所有的列一起滚 —— 而分栏的价值恰恰是
 * "每一层都在原位看得见"。所以每一列跑一次 `computeWindow`，行高常量与单栏共用
 * （`tree-metrics.ts` 的 `ROW_HEIGHT`，30px）。
 *
 * ## 焦点列、选中、ARIA
 *
 * 行上的 `--selected` 是 `vault-store.selected` 的直接投影，这里**不另画一种"光标"**。
 * 焦点列（`view.activeIndex`，判据在 `domain/columns.ts`）只是多一条左边框与一层极淡
 * 的底色，用来回答"`↑/↓` 会动哪一列"，它不改变任何状态。
 *
 * `role="tree"` 挂在整块上、`role="treeitem"` 在每一行上（与单栏同一套），
 * 没有 `aria-activedescendant`：分栏里"活动项"按列为单位，套一个单层的
 * activedescendant 只会指向另一列的行、反而误导读屏（这条边界记在 ADR-0058 的代价里）。
 *
 * ## 空白处的拖拽落点
 *
 * 落在某一列的空白处 = 放进**那一列显示的目录**（行自己会 `stopPropagation`，
 * 所以走到这里的一定是空白）。第一列就是 Vault 根的内容，于是"移到根目录"这个落点
 * 天然存在，不必让整块容器代表根目录 —— 容器因此不接管 `dragover/drop`，
 * 也不画 `data-drop-root`（见 `use-tree-drag.ts` 的文件头）。
 */

import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { RefObject } from 'react'

import {
  columnRowCount,
  revealTargetIn,
  type ColumnView,
  type ColumnsView,
} from '@/domain/columns'
import type { DropTarget } from '@/domain/drag'
import { computeWindow, scrollTopToReveal } from '@/domain/virtual-list'
import { TreeRow } from './TreeRow'
import {
  COLUMN_WIDTH_DEFAULT,
  COLUMN_WIDTH_MAX,
  COLUMN_WIDTH_MIN,
  columnWidthOf,
  loadColumnWidths,
  saveColumnWidths,
  type ColumnWidths,
  clampColumnWidth,
} from './tree-column-widths'
import { dropStateOf, FALLBACK_VIEWPORT_HEIGHT, OVERSCAN, ROW_HEIGHT } from './tree-metrics'
import type { TreeDragHandlers } from './use-tree-drag'
import type { TreeViewHandle, TreeViewProps } from './tree-view'

import './columns-tree.css'

/** 空目录 / 被过滤光的列里的提示（与单栏空态同一口径：说清为什么空）。 */
const EMPTY_COLUMN_TEXT = '（没有匹配的项）'

/** 堆叠卡片静止态：每层祖先露边宽度（px）。 */
export const STACK_PEEK_PX = 28

/** 分栏画法：横排列 / 堆叠卡片（滚动摊开）。 */
export type ColumnsPresentation = 'flat' | 'stack'

export interface ColumnsTreeProps extends TreeViewProps {
  view: ColumnsView
  /** 当前被拖动的条目（由容器持有）。 */
  draggingPath: string | null
  dropTarget: DropTarget | null
  drag: TreeDragHandlers
  viewRef: RefObject<TreeViewHandle | null>
  /**
   * 点**焦点列的列头** = 回退一列（它写着这一层的目录名，点它回上一层是文件管理器里
   * 最顺手的一个动作）。根那一列的列头点了没有任何反应 —— 根没有上一级。
   */
  onColumnBack: () => void
  /**
   * 堆叠模式下点**非焦点列**的列头 / 露边 = 把焦点目录设成那一层
   * （列链收到该层为止，相当于连按多次 `←`）。
   */
  onFocusColumn: (dirPath: string) => void
  /** Vault 根：列宽偏好按它分桶（见 `tree-column-widths.ts`）。 */
  vaultRoot: string
  /** 默认 `flat`（经典 Miller）；`stack` = 左侧露边叠卡 + 横向滚动摊开。 */
  presentation?: ColumnsPresentation
}

export function ColumnsTree({
  view,
  selected,
  autoExpanded,
  draggingPath,
  dropTarget,
  drag,
  viewRef,
  onActivate,
  onContextMenu,
  onKeyDown,
  onColumnBack,
  onFocusColumn,
  vaultRoot,
  presentation = 'flat',
}: ColumnsTreeProps) {
  /**
   * 每一列的滚动容器（`dirPath` → 元素）。
   *
   * 用 ref 表而不是把元素交给各列自己：`reveal` 是**跨列**的 —— 定位一条路径要先知道
   * 该滚哪一列（`revealTargetIn` 算出来），由容器一次滚到位比"通知每一列各自判断"简单。
   */
  const columnRefs = useRef(new Map<string, HTMLDivElement>())
  /** 列元素的滚动/高度状态：只有它变化时才重算窗口（各列自己的 rAF 合并）。 */
  const [metrics, setMetrics] = useState<Record<string, { scrollTop: number; height: number }>>({})
  const pending = useRef(new Map<string, number>())
  const frames = useRef(new Map<string, number>())
  const [widths, setWidths] = useState<ColumnWidths>(() => loadColumnWidths(vaultRoot))
  const widthsRef = useRef(widths)
  widthsRef.current = widths

  // 换 Vault：读那一桶的列宽（与 `FileTree` 换焦点目录同一时机）。
  useEffect(() => {
    setWidths(loadColumnWidths(vaultRoot))
  }, [vaultRoot])

  const setColumnWidth = useCallback(
    (path: string, px: number, persist: boolean): void => {
      const nextWidth = clampColumnWidth(px)
      setWidths((current) => {
        if (columnWidthOf(current, path) === nextWidth) return current
        const next = { ...current, [path]: nextWidth }
        if (nextWidth === COLUMN_WIDTH_DEFAULT) delete next[path]
        if (persist) saveColumnWidths(vaultRoot, next)
        return next
      })
    },
    [vaultRoot],
  )

  /** 拖动手松开时落盘（拖动中只改内存，避免每像素写 localStorage）。 */
  const commitColumnWidths = useCallback((): void => {
    saveColumnWidths(vaultRoot, widthsRef.current)
  }, [vaultRoot])

  const measureColumn = useCallback((dirPath: string, element: HTMLDivElement) => {
    setMetrics((current) => {
      const previous = current[dirPath]
      if (previous !== undefined && previous.height === element.clientHeight) return current
      return {
        ...current,
        [dirPath]: { scrollTop: previous?.scrollTop ?? 0, height: element.clientHeight },
      }
    })
  }, [])

  /** 每列一个 ResizeObserver：窗口缩放 / 侧栏拖拽 / 横向滚动条出现都要重新量。 */
  const attachColumn = useCallback(
    (dirPath: string, element: HTMLDivElement | null): ResizeObserver | null => {
      if (element === null) {
        columnRefs.current.delete(dirPath)
        return null
      }
      columnRefs.current.set(dirPath, element)
      measureColumn(dirPath, element)
      if (typeof ResizeObserver === 'undefined') return null
      const observer = new ResizeObserver(() => measureColumn(dirPath, element))
      observer.observe(element)
      return observer
    },
    [measureColumn],
  )

  // 列被移除时（列链变短）清掉那一列的滚动状态，别让 map 无限长
  useEffect(() => {
    const live = new Set(view.directories)
    setMetrics((current) => {
      const stale = Object.keys(current).filter((path) => !live.has(path))
      if (stale.length === 0) return current
      const next = { ...current }
      for (const path of stale) delete next[path]
      return next
    })
  }, [view.directories])

  /**
   * 滚动：与单栏同一条 rAF 合并写法，只是按列各来一份。
   *
   * 依赖为空是刻意的：它只用 ref 表（`pending` / `frames`）与 `setMetrics`（引用稳定），
   * 列多了之后每次重渲染都换一个新回调会让所有列一起重渲染 —— 而滚动恰恰是最热的路径。
   */
  const handleScroll = useCallback(
    (dirPath: string, event: React.UIEvent<HTMLDivElement>) => {
      pending.current.set(dirPath, event.currentTarget.scrollTop)
      if (frames.current.has(dirPath)) return
      const frame = requestAnimationFrame(() => {
        frames.current.delete(dirPath)
        const next = pending.current.get(dirPath) ?? 0
        setMetrics((current) => {
          const previous = current[dirPath]
          if (previous !== undefined && previous.scrollTop === next) return current
          return { ...current, [dirPath]: { scrollTop: next, height: previous?.height ?? 0 } }
        })
      })
      frames.current.set(dirPath, frame)
    },
    [],
  )

  useEffect(() => {
    const handles = frames.current
    return () => {
      for (const frame of handles.values()) cancelAnimationFrame(frame)
      handles.clear()
    }
  }, [])

  /**
   * 焦点列自动滚进视野：`→` 推进一列时，新出现的那一列必须在可视区里
   * —— 否则用户按了右键，界面上什么动静都没有（横向滚动条之外发生了什么，他看不见）。
   *
   * `scrollIntoView({ block: 'nearest', inline: 'nearest' })` 只滚"必要的那个方向"，
   * 不会把几列一起甩走。jsdom 没有实现它，所以先判存在（真实浏览器由 E2E 走查）。
   */
  const activePath = view.columns[view.activeIndex]?.path
  useEffect(() => {
    if (activePath === undefined) return
    const element = columnRefs.current.get(activePath)
    if (element === undefined || typeof element.scrollIntoView !== 'function') return
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activePath, view.columns.length])

  useImperativeHandle(
    viewRef,
    () => ({
      reveal: (relPath: string): boolean => {
        const target = revealTargetIn(view.columns, relPath)
        if (target === null) return false
        const column = view.columns[target.columnIndex]
        const element = column === undefined ? undefined : columnRefs.current.get(column.path)
        if (column === undefined || element === undefined) return false
        const nextTop = scrollTopToReveal(
          target.rowIndex,
          element.scrollTop,
          element.clientHeight,
          ROW_HEIGHT,
          column.rows.length,
        )
        element.scrollTop = nextTop
        setMetrics((current) => ({
          ...current,
          [column.path]: { scrollTop: nextTop, height: element.clientHeight },
        }))
        return true
      },
    }),
    [view.columns],
  )

  // 一行都没有（整块被过滤光 / Vault 空）：不画列，交给容器的空态（与单栏同一份）
  if (columnRowCount(view.columns) === 0) return null
  /** 末列就是焦点目录（`columnsFor` 已经保证了这一点：不合法时它会回退）。 */
  const focusPath = view.directories[view.directories.length - 1] ?? ''

  const stacked = presentation === 'stack'

  return (
    <div
      className={`mn-tree mn-tree--columns${stacked ? ' mn-tree--stack' : ''}`}
      data-tree-columns=""
      data-tree-stack={stacked ? '' : undefined}
      role="tree"
      aria-label="文件树"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onDragLeave={drag.handleDragLeave}
      // dragend 会从源行冒泡上来：无论成功与否都收掉高亮，不留一个假的"落点"
      onDragEnd={drag.handleDragEnd}
    >
      <div className="mn-tree--columns-scroll">
        <div className="mn-tree__columns">
          {view.columns.map((column, index) => (
            <TreeColumn
              key={column.path}
              column={column}
              active={index === view.activeIndex}
              last={index === view.columns.length - 1}
              width={columnWidthOf(widths, column.path)}
              stackIndex={stacked ? index : null}
              selected={selected}
              /* 这一列里通向下一列的目录 = 列链上下一项（Finder 路径高亮） */
              pathItem={view.directories[index + 1] ?? null}
              autoExpanded={autoExpanded}
              draggingPath={draggingPath}
              dropTarget={dropTarget}
              drag={drag}
              metrics={metrics[column.path]}
              onActivate={onActivate}
              onContextMenu={onContextMenu}
              onScroll={handleScroll}
              attach={attachColumn}
              onColumnBack={onColumnBack}
              onFocusColumn={onFocusColumn}
              onResizeWidth={(px) => setColumnWidth(column.path, px, false)}
              onResizeCommit={commitColumnWidths}
              onResizeReset={() => setColumnWidth(column.path, COLUMN_WIDTH_DEFAULT, true)}
            />
          ))}
        </div>
      </div>
      {/*
        当前目录的完整路径贴在整块的底部：列头在窄列里只能用省略号，
        而"我现在到底在哪一层"是分栏里最需要一眼看到的信息（浏览器的地址栏做的也是这件事）。
        分段画成面包屑，与列内 `--path` 高亮是同一条路径的两种读法。
      */}
      <div
        className="mn-tree__columns-path"
        title={focusPath === '' ? 'Vault 根目录' : focusPath}
        data-columns-path={focusPath}
      >
        {focusPath === '' ? (
          <span className="mn-tree__columns-path__seg">Vault 根目录</span>
        ) : (
          focusPath.split('/').map((segment, index, parts) => (
            <span key={`${index}-${segment}`} className="mn-tree__columns-path__item">
              {index > 0 && (
                <span className="mn-tree__columns-path__sep" aria-hidden="true">
                  /
                </span>
              )}
              <span
                className={`mn-tree__columns-path__seg${
                  index === parts.length - 1 ? ' mn-tree__columns-path__seg--current' : ''
                }`}
              >
                {segment}
              </span>
            </span>
          ))
        )}
      </div>
    </div>
  )
}

interface TreeColumnProps {
  column: ColumnView
  /** 焦点列（`↑/↓` 作用在它上面）。 */
  active: boolean
  /** 末列：吃掉侧栏余量（`flex-grow`），偏好宽度只作下限。 */
  last: boolean
  width: number
  /** 堆叠模式下的列序（`null` = 横排列，不用 sticky）。 */
  stackIndex: number | null
  selected: string | null
  /** 通向下一列的目录相对路径；末列没有下一项时为 `null`。 */
  pathItem: string | null
  autoExpanded: boolean
  draggingPath: string | null
  dropTarget: DropTarget | null
  drag: TreeDragHandlers
  metrics: { scrollTop: number; height: number } | undefined
  onActivate: TreeViewProps['onActivate']
  onContextMenu: TreeViewProps['onContextMenu']
  onScroll: (dirPath: string, event: React.UIEvent<HTMLDivElement>) => void
  attach: (dirPath: string, element: HTMLDivElement | null) => ResizeObserver | null
  /** 点列头 = 回退一列（只对焦点列有意义）。 */
  onColumnBack: () => void
  onFocusColumn: (dirPath: string) => void
  onResizeWidth: (px: number) => void
  onResizeCommit: () => void
  onResizeReset: () => void
}

function TreeColumn({
  column,
  active,
  last,
  width,
  stackIndex,
  pathItem,
  autoExpanded,
  draggingPath,
  dropTarget,
  drag,
  metrics,
  onActivate,
  onContextMenu,
  onScroll,
  attach,
  onColumnBack,
  onFocusColumn,
  onResizeWidth,
  onResizeCommit,
  onResizeReset,
}: TreeColumnProps) {
  /** 这一列的观察者：ref 回调每次挂/卸都要换一个，挂在 ref 里最省事。 */
  const observer = useRef<ResizeObserver | null>(null)
  const columnEl = useRef<HTMLDivElement | null>(null)
  const dragStart = useRef<{ x: number; width: number } | null>(null)
  const [resizing, setResizing] = useState(false)
  const scrollTop = metrics?.scrollTop ?? 0
  const height = metrics?.height ?? 0

  const range = computeWindow({
    scrollTop,
    // 未测量到高度时用兜底值，保证首帧就画出行（与单栏同一条理由）
    viewportHeight: height > 0 ? height : FALLBACK_VIEWPORT_HEIGHT,
    rowHeight: ROW_HEIGHT,
    itemCount: column.rows.length,
    overscan: OVERSCAN,
  })
  const visibleRows = column.rows.slice(range.start, range.end)
  const empty = column.rows.length === 0
  const label = column.path === '' ? '根目录' : (column.path.split('/').pop() ?? column.path)

  const handleResizePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    // 末列可能被 flex-grow 撑得比偏好更宽：下一次拖动以**可见宽度**为起点，避免"一拖就跳"。
    const visual = columnEl.current?.getBoundingClientRect().width ?? width
    dragStart.current = { x: event.clientX, width: visual }
    setResizing(true)
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // jsdom / 部分 WebView 没有指针捕获：拖动仍可用，只是移出手柄会丢事件
      }
    }
  }

  const handleResizePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = dragStart.current
    if (start === null) return
    event.preventDefault()
    onResizeWidth(start.width + (event.clientX - start.x))
  }

  const endResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragStart.current === null) return
    dragStart.current = null
    setResizing(false)
    onResizeCommit()
    if (typeof event.currentTarget.releasePointerCapture === 'function') {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {
        // 已经释放
      }
    }
  }

  const handleResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 48 : 16
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      onResizeWidth(width - step)
      onResizeCommit()
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      onResizeWidth(width + step)
      onResizeCommit()
    } else if (event.key === 'Home') {
      event.preventDefault()
      onResizeReset()
    }
  }

  const stacked = stackIndex !== null

  return (
    <div
      ref={columnEl}
      className={`mn-tree-column${active ? ' mn-tree-column--active' : ''}${last ? ' mn-tree-column--last' : ''}${resizing ? ' mn-tree-column--resizing' : ''}`}
      data-column-path={column.path}
      data-column-active={active ? '' : undefined}
      style={{
        flex: last ? `1 0 ${width}px` : `0 0 ${width}px`,
        width,
        minWidth: width,
        ...(stacked
          ? {
              position: 'sticky' as const,
              left: stackIndex * STACK_PEEK_PX,
              zIndex: stackIndex + 1,
            }
          : {}),
      }}
      // 列的空白 = 这一列显示的目录（行自己会 stopPropagation）
      data-drop-root={
        dropTarget !== null && dropTarget.hostRelPath === column.path
          ? dropTarget.dataState
          : undefined
      }
    >
      {/*
        列头是**导航**用的：
        - 横排列：只有焦点列可点（回退一列）；
        - 堆叠：非焦点列也可点，把焦点收到那一层（露边回退）。
        完整路径放 `title`：窄列必然被省略号截断（设计文档 §3）。
      */}
      <button
        type="button"
        className="mn-tree-column__header"
        title={column.path === '' ? 'Vault 根目录' : column.path}
        data-column-header={column.path}
        disabled={
          stacked
            ? active && column.path === ''
            : !active || column.path === ''
        }
        onClick={() => {
          if (active) {
            if (column.path !== '') onColumnBack()
            return
          }
          if (stacked) onFocusColumn(column.path)
        }}
      >
        {label}
      </button>
      <div
        className="mn-tree-column__scroll"
        ref={(element) => {
          observer.current?.disconnect()
          observer.current = attach(column.path, element)
        }}
        onScroll={(event) => onScroll(column.path, event)}
        onDragOver={(event) => drag.handleBlankDragOver(column.path, event)}
        onDrop={(event) => drag.handleBlankDrop(column.path, event)}
        onDragLeave={drag.handleDragLeave}
      >
        {empty ? (
          <p className="mn-tree-column__empty">{EMPTY_COLUMN_TEXT}</p>
        ) : (
          <div className="mn-tree__spacer" style={{ height: range.totalHeight }}>
            <div className="mn-tree__window" style={{ transform: `translateY(${range.offsetY}px)` }}>
              {visibleRows.map((node) => (
                <TreeRow
                  key={node.entry.relPath}
                  // 分栏的行没有"深度"：层级由它在哪一列表达（`TreeRow` 不传 `depth` 时
                  // `padding-left` 是固定值，不加缩进）—— 见 `TreeRow.tsx` 的文件头
                  row={{ node, hasChildren: node.children.length > 0 }}
                  height={ROW_HEIGHT}
                  onActivate={onActivate}
                  onContextMenu={onContextMenu}
                  onDragStart={drag.handleDragStart}
                  onDragOver={drag.handleDragOver}
                  onDrop={drag.handleDrop}
                  dragging={draggingPath === node.entry.relPath}
                  autoExpanded={autoExpanded}
                  pathHighlight={pathItem !== null && pathItem === node.entry.relPath}
                  dropState={dropStateOf(dropTarget, node.entry.relPath)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
      {/*
        "这一列还有项目被挡住了"：收窄视图里最贵的一类误判是"我的笔记丢了"。
        绝对定位贴在列的底部，**不占**滚动区的高度（参与布局的话列的可见高度会随它
        出现/消失变化，虚拟窗口跟着抖）。
      */}
      {column.truncated && !empty && (
        <div className="mn-tree-column__truncated">还有项目被过滤挡住了</div>
      )}
      {/*
        列右缘拖宽：命中区比可见线宽，避免点不中。双击 / Home = 恢复默认 240。
        堆叠（露边叠卡）下不放手柄：列被 sticky 压成窄条时拖宽没有意义，
        切回横排列再调。不复用布局树的 `.mn-splitter`。
      */}
      {stackIndex === null && (
        <div
          className={`mn-tree-column__resize${resizing ? ' mn-tree-column__resize--dragging' : ''}`}
          role="separator"
          aria-orientation="vertical"
          aria-label={`调整「${label}」列宽`}
          aria-valuenow={width}
          aria-valuemin={COLUMN_WIDTH_MIN}
          aria-valuemax={COLUMN_WIDTH_MAX}
          tabIndex={0}
          data-column-resize={column.path}
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onDoubleClick={(event) => {
            event.preventDefault()
            onResizeReset()
          }}
          onKeyDown={handleResizeKeyDown}
        />
      )}
    </div>
  )
}
