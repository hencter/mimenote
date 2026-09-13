/**
 * 文件树：虚拟化渲染 + 键盘导航 + 过滤。
 *
 * 性能（architecture.md §6）：固定行高 + 只渲染可视行（overscan 10 行）。
 * 无论 Vault 有 1 千还是 10 万条目，DOM 中的行数恒定在几十行以内，
 * 滚动因此稳定在 60fps。行组件只订阅自己的布尔状态，选中某一项不会重渲染整棵树。
 */

import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { createNoteHere, deleteSelected, openNote, renameSelected } from '@/app/actions'
import { REVEAL_ROW_EVENT } from '@/app/dom-events'
import { Icon } from '@/components/Icon'
import { formatBytes } from '@/domain/format'
import { isMarkdown } from '@/domain/paths'
import { flattenTree, type FlatRow } from '@/domain/tree'
import { computeWindow, scrollTopToReveal } from '@/domain/virtual-list'
import { useNoteStore } from '@/state/note-store'
import { useVaultStore } from '@/state/vault-store'
import { RenameDialog } from './RenameDialog'

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
      >
        <div className="mn-tree__spacer" style={{ height: range.totalHeight }}>
          <div className="mn-tree__window" style={{ transform: `translateY(${range.offsetY}px)` }}>
            {visibleRows.map((row) => (
              <FileTreeRow key={row.node.entry.relPath} row={row} onActivate={activateRow} />
            ))}
          </div>
        </div>
      </div>
      {/* 对话框挂在这里而不是 App：叠加层是 fixed 定位，位置与挂载点无关，
          而"谁能请求重命名"的信息（选中行、F2）本来就属于文件树。 */}
      <RenameDialog />
    </>
  )
}

function rowId(relPath: string): string {
  return `mn-tree-row-${encodeURIComponent(relPath)}`
}

interface RowProps {
  row: FlatRow
  onActivate: (row: FlatRow) => void
}

const FileTreeRow = memo(function FileTreeRow({ row, onActivate }: RowProps) {
  const entry = row.node.entry
  const relPath = entry.relPath
  const isSelected = useVaultStore((state) => state.selected === relPath)
  const isExpanded = useVaultStore((state) => entry.isDir && state.expanded.has(relPath))
  const isOpen = useNoteStore((state) => state.doc?.relPath === relPath)
  const markdown = isMarkdown(relPath)

  const iconName = entry.isDir ? (isExpanded ? 'folderOpen' : 'folder') : markdown ? 'file' : 'dot'

  return (
    <div
      id={rowId(relPath)}
      data-rel-path={relPath}
      className={[
        'mn-tree-row',
        isSelected ? 'mn-tree-row--selected' : '',
        isOpen ? 'mn-tree-row--open' : '',
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
