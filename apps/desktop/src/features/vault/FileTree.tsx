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
 */

import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { createNoteHere, deleteSelected, moveEntry, openNote, renameSelected } from '@/app/actions'
import { REVEAL_ROW_EVENT } from '@/app/dom-events'
import { Icon } from '@/components/Icon'
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
import { isMarkdown } from '@/domain/paths'
import { flattenTree, type FlatRow } from '@/domain/tree'
import { computeWindow, scrollTopToReveal } from '@/domain/virtual-list'
import { useNoteStore } from '@/state/note-store'
import { toast } from '@/state/toast-store'
import { useVaultStore } from '@/state/vault-store'
import { MoveDialog } from './MoveDialog'
import { RenameDialog } from './RenameDialog'

import './drag-drop.css'

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

  // 过滤是 O(n) 遍历：用 deferred value 让它不阻塞输入
  const deferredFilter = useDeferredValue(filter)
  const rows = useMemo(
    () => flattenTree(tree, { expanded, filter: deferredFilter }),
    [tree, expanded, deferredFilter],
  )

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

  /** 容器的空白区域：等于"移到 Vault 根目录"。 */
  const handleRootDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      const payload = dragRef.current ?? readDragPayload(event.dataTransfer)
      if (payload === null) return
      const target = dropTargetFor(null, payload)
      event.preventDefault()
      event.dataTransfer.dropEffect = target.valid ? 'move' : 'none'
      showDropTarget(target)
    },
    [showDropTarget],
  )

  const handleRootDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      const payload = dragRef.current ?? readDragPayload(event.dataTransfer)
      if (payload === null) return
      event.preventDefault()
      const target = dropTargetFor(null, payload)
      clearDrag()
      void applyDrop(payload, target)
    },
    [clearDrag],
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
        default:
          return
      }
    },
    [activateRow, expanded, rows, select, selected, toggleExpanded],
  )

  if (rows.length === 0) {
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
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                dragging={dragPayload?.relPath === row.node.entry.relPath}
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
  onDragStart: (row: FlatRow, event: React.DragEvent<HTMLDivElement>) => void
  onDragOver: (row: FlatRow, event: React.DragEvent<HTMLDivElement>) => void
  onDrop: (row: FlatRow, event: React.DragEvent<HTMLDivElement>) => void
  /** 这一行是不是被拖动的源。 */
  dragging: boolean
  /** 这一行是不是当前落点。 */
  dropState: RowDropState
}

const FileTreeRow = memo(function FileTreeRow({
  row,
  onActivate,
  onDragStart,
  onDragOver,
  onDrop,
  dragging,
  dropState,
}: RowProps) {
  const entry = row.node.entry
  const relPath = entry.relPath
  const isSelected = useVaultStore((state) => state.selected === relPath)
  const isExpanded = useVaultStore((state) => entry.isDir && state.expanded.has(relPath))
  const isOpen = useNoteStore((state) => state.doc?.relPath === relPath)
  const markdown = isMarkdown(relPath)

  const iconName = entry.isDir ? (isExpanded ? 'folderOpen' : 'folder') : markdown ? 'file' : 'dot'
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
      aria-expanded={entry.isDir ? isExpanded : undefined}
      aria-level={row.depth + 1}
      style={{ paddingLeft: `${6 + row.depth * 14}px`, height: ROW_HEIGHT }}
      title={`${relPath}${entry.isDir ? '' : ` · ${formatBytes(entry.sizeBytes)}`}`}
      onClick={() => onActivate(row)}
      // 笔记与文件夹都可拖（见上面的 `draggable`）；目录行仍然是**合法的落点**
      draggable={draggable}
      onDragStart={(event) => onDragStart(row, event)}
      onDragOver={(event) => onDragOver(row, event)}
      onDrop={(event) => onDrop(row, event)}
      aria-dropeffect={entry.isDir ? 'move' : undefined}
    >
      {entry.isDir ? (
        <span className={`mn-tree-row__chevron${isExpanded ? ' mn-tree-row__chevron--open' : ''}`}>
          <Icon name="chevron" size={13} />
        </span>
      ) : (
        <span className="mn-tree-row__chevron mn-tree-row__chevron--placeholder" />
      )}
      <Icon name={iconName} size={14} className="mn-tree-row__icon" />
      <span className="mn-tree-row__name">{entry.name}</span>
      {!entry.isDir && !markdown && <span className="mn-tree-row__badge">{entry.ext ?? '?'}</span>}
    </div>
  )
})
