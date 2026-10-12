/**
 * 单栏文件树：**一棵会展开的树**（缩进表达层级）＋ 虚拟化渲染。
 *
 * 这一段是从 `FileTree.tsx` 原地搬出来的（行为一个字节都没改），容器因此只负责
 * "两种画法共用的那部分"（过滤推导、标签过滤视图、拖拽状态、右键菜单、对话框）。
 * 搬出来的理由见 `docs/design/04-miller-columns.md` §7 与 ADR-0058 第 4 条：
 * 分栏视图要跟它并列，`FileTree.tsx` 不能再继续膨胀。
 *
 * 性能（architecture.md §6）：固定行高 + 只渲染可视行（overscan 10 行）。
 * 无论 Vault 有 1 千还是 10 万条目，DOM 中的行数恒定在几十行以内，滚动因此稳定在 60fps。
 * 行组件只订阅自己的布尔状态，选中某一项不会重渲染整棵树。
 */

import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

import type { DropTarget } from '@/domain/drag'
import type { FlatRow } from '@/domain/tree'
import { computeWindow, scrollTopToReveal } from '@/domain/virtual-list'
import { TreeRow, treeRowId } from './TreeRow'
import { dropStateOf, FALLBACK_VIEWPORT_HEIGHT, OVERSCAN, ROW_HEIGHT } from './tree-metrics'
import type { TreeDragHandlers } from './use-tree-drag'
import type { TreeViewHandle, TreeViewProps } from './tree-view'

export interface SingleColumnTreeProps extends TreeViewProps {
  rows: readonly FlatRow[]
  /** 当前被拖动的条目（由容器持有：右键菜单与工具栏也要看它）。 */
  draggingPath: string | null
  dropTarget: DropTarget | null
  drag: TreeDragHandlers
  viewRef: RefObject<TreeViewHandle | null>
}

export function SingleColumnTree({
  rows,
  selected,
  autoExpanded,
  draggingPath,
  dropTarget,
  drag,
  viewRef,
  onActivate,
  onContextMenu,
  onKeyDown,
}: SingleColumnTreeProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 })
  const pendingScrollTop = useRef(0)
  const frameHandle = useRef<number | null>(null)

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

  /** 打开笔记后把对应行滚入可视区（`REVEAL_ROW_EVENT`，由容器转发进来）。 */
  useImperativeHandle(
    viewRef,
    () => ({
      reveal: (relPath: string): boolean => {
        const element = scrollRef.current
        if (element === null) return false
        const index = rows.findIndex((row) => row.node.entry.relPath === relPath)
        if (index === -1) return false
        const nextTop = scrollTopToReveal(
          index,
          element.scrollTop,
          element.clientHeight,
          ROW_HEIGHT,
          rows.length,
        )
        element.scrollTop = nextTop
        setViewport((current) => ({ ...current, scrollTop: nextTop }))
        return true
      },
    }),
    [rows],
  )

  const range = computeWindow({
    scrollTop: viewport.scrollTop,
    // 未测量到高度时用兜底值，保证首次渲染就有行（而不是空白）
    viewportHeight: viewport.height > 0 ? viewport.height : FALLBACK_VIEWPORT_HEIGHT,
    rowHeight: ROW_HEIGHT,
    itemCount: rows.length,
    overscan: OVERSCAN,
  })
  const visibleRows = rows.slice(range.start, range.end)

  return (
    <div
      className="mn-tree"
      ref={scrollRef}
      role="tree"
      aria-label="文件树"
      aria-activedescendant={selected === null ? undefined : treeRowId(selected)}
      tabIndex={0}
      onScroll={handleScroll}
      onKeyDown={onKeyDown}
      // 空白区域（含行下方的留白）＝ Vault 根目录：行自己会 stopPropagation，
      // 所以能走到这里的 dragover/drop 一定是"落在树上但没落在某一行上"
      onDragOver={(event) => drag.handleBlankDragOver('', event)}
      onDrop={(event) => drag.handleBlankDrop('', event)}
      onDragLeave={drag.handleDragLeave}
      // dragend 会从源行冒泡上来：无论成功与否都收掉高亮，不留一个假的"落点"
      onDragEnd={drag.handleDragEnd}
      data-drop-root={
        dropTarget !== null && dropTarget.hostRelPath === '' ? dropTarget.dataState : undefined
      }
    >
      <div className="mn-tree__spacer" style={{ height: range.totalHeight }}>
        <div className="mn-tree__window" style={{ transform: `translateY(${range.offsetY}px)` }}>
          {visibleRows.map((row) => (
            <TreeRow
              key={row.node.entry.relPath}
              row={row}
              height={ROW_HEIGHT}
              onActivate={onActivate}
              onContextMenu={onContextMenu}
              onDragStart={drag.handleDragStart}
              onDragOver={drag.handleDragOver}
              onDrop={drag.handleDrop}
              dragging={draggingPath === row.node.entry.relPath}
              autoExpanded={autoExpanded}
              dropState={dropStateOf(dropTarget, row.node.entry.relPath)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
