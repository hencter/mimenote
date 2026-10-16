/**
 * 文件树工具栏：搜索 + 五个视图图标（展开 / 折叠 / 分栏画法 / 刷新 / 排序）
 * + 导出按钮 + 标签过滤控件。
 *
 * 打开库与隐藏面板从这里撤走了（等价入口在 VaultGate 与 `Ctrl+B`，那条判断成立）；
 * 但**导出**与**标签过滤**撤不得 —— 前者是三选一导出对话框（单篇 HTML / 打印 / 整库站点）
 * 的**唯一入口**（ADR-0051），命令面板里那三条 `export.*` 是直达、不经过对话框；后者
 * 根本不存在第二入口（没有命令、快捷键或右键菜单能打开它）。这两件曾随「桌面 UI 收口」
 * 一起被摘掉，靠 UI E2E 与 ADR-0051 的对照才发现（见 `TreeToolbar` 渲染处那条注释）。
 */

import { useEffect, useRef, useState } from 'react'

import { FOCUS_FILTER_EVENT } from '@/app/dom-events'
import { rescanVault } from '@/app/actions'
import { Checkbox } from '@/components/Checkbox'
import { Tooltip } from '@/components/Tooltip'
import { Icon } from '@/components/Icon'
import type { TreeSort } from '@/domain/tree'
import { ExportButton } from '@/features/export/ExportButton'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'
import { TagFilterControl } from './TagFilterControl'
import {
  isColumnsFamily,
  toggleTreeLayout,
  useTreeLayout,
  type TreeLayoutKind,
} from './tree-layout-pref'

const LAYOUT_NEXT_HINT: Record<TreeLayoutKind, string> = {
  single: '切换为分栏文件树（Ctrl+Alt+C）',
  columns: '切换为堆叠卡片（Ctrl+Alt+C）',
  stack: '切回单栏文件树（Ctrl+Alt+C）',
}

import './tree-sort.css'

/** 排序依据的可选项（标签是给人看的；键与 `TreeSort['by']` 一一对应）。 */
const SORT_BY_OPTIONS: readonly { value: TreeSort['by']; label: string }[] = [
  { value: 'name', label: '名称' },
  { value: 'mtime', label: '修改时间' },
  { value: 'size', label: '大小' },
  { value: 'type', label: '类型' },
]

/**
 * 工具栏五图标条的右缘宽度（px）：侧栏拖窄时不能再窄过这条。
 * 5×28 图标 + 4×2 组内间隙 + 左右各 10 内边距。
 */
export const TREE_TOOLBAR_MIN_WIDTH_PX = 5 * 28 + 4 * 2 + 10 * 2

export function TreeToolbar() {
  const filter = useVaultStore((state) => state.filter)
  const setFilter = useVaultStore((state) => state.setFilter)
  const expandAll = useVaultStore((state) => state.expandAll)
  const collapseAll = useVaultStore((state) => state.collapseAll)
  const treeSort = useUiStore((state) => state.treeSort)
  const setTreeSort = useUiStore((state) => state.setTreeSort)
  const treeLayout = useTreeLayout()
  const columnsOn = isColumnsFamily(treeLayout)
  const layoutTooltip = LAYOUT_NEXT_HINT[treeLayout]
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [sortOpen, setSortOpen] = useState(false)
  const sortRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const focus = (): void => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener(FOCUS_FILTER_EVENT, focus)
    return () => {
      window.removeEventListener(FOCUS_FILTER_EVENT, focus)
    }
  }, [])

  useEffect(() => {
    if (!sortOpen) return
    const onPointerDown = (event: MouseEvent): void => {
      const node = sortRef.current
      if (node !== null && event.target instanceof Node && node.contains(event.target)) return
      setSortOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSortOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [sortOpen])

  return (
    <div className="mn-tree-toolbar mn-tree-toolbar--with-tags">
      <div className="mn-search-field">
        <Icon name="search" size="sm" />
        <input
          ref={inputRef}
          type="search"
          className="mn-search-field__input"
          placeholder="过滤笔记…"
          aria-label="过滤文件树"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setFilter('')
          }}
        />
        {filter !== '' && (
          <button
            type="button"
            className="mn-icon-button"
            aria-label="清除过滤"
            onClick={() => setFilter('')}
          >
            <Icon name="x" size="xs" />
          </button>
        )}
      </div>

      <div className="mn-tree-toolbar__actions" role="group" aria-label="视图整理">
        <Tooltip label="展开全部目录（Ctrl+Alt+E）">
          <button
            type="button"
            className="mn-icon-button"
            aria-label="展开全部目录"
            onClick={expandAll}
          >
            <Icon name="expandAll" />
          </button>
        </Tooltip>
        <Tooltip label="折叠全部目录（Ctrl+Alt+W）">
          <button
            type="button"
            className="mn-icon-button"
            aria-label="折叠全部目录"
            onClick={collapseAll}
          >
            <Icon name="collapseAll" />
          </button>
        </Tooltip>
        <Tooltip label={layoutTooltip}>
          <button
            type="button"
            className={`mn-icon-button${columnsOn ? ' mn-icon-button--active' : ''}`}
            aria-label={
              treeLayout === 'stack'
                ? '切换文件树视图（当前：堆叠卡片）'
                : treeLayout === 'columns'
                  ? '切换文件树视图（当前：分栏）'
                  : '切换文件树视图（当前：单栏）'
            }
            aria-pressed={columnsOn}
            onClick={toggleTreeLayout}
          >
            <Icon name="columns" />
          </button>
        </Tooltip>
        <Tooltip label="重新扫描 Vault（Ctrl+Alt+R）">
          <button
            type="button"
            className="mn-icon-button"
            aria-label="重新扫描 Vault"
            onClick={() => void rescanVault()}
          >
            <Icon name="refresh" />
          </button>
        </Tooltip>
        <div className="mn-tree-sort" ref={sortRef}>
          <Tooltip label="文件树排序…">
            <button
              type="button"
              className={`mn-icon-button${sortOpen ? ' mn-icon-button--active' : ''}`}
              aria-label="文件树排序"
              aria-haspopup="menu"
              aria-expanded={sortOpen}
              onClick={() => setSortOpen((open) => !open)}
            >
              <Icon name="sort" />
            </button>
          </Tooltip>
          {sortOpen && (
            <div className="mn-tree-sort__popover" role="menu" aria-label="文件树排序">
              <div className="mn-tree-sort__group" role="group" aria-label="排序依据">
                {SORT_BY_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={treeSort.by === option.value}
                    className={`mn-tree-sort__option${
                      treeSort.by === option.value ? ' mn-tree-sort__option--active' : ''
                    }`}
                    onClick={() => setTreeSort({ by: option.value })}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="mn-tree-sort__group" role="group" aria-label="排序方向">
                {(
                  [
                    { value: 'asc', label: '升序' },
                    { value: 'desc', label: '降序' },
                  ] as const
                ).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={treeSort.direction === option.value}
                    className={`mn-tree-sort__option${
                      treeSort.direction === option.value ? ' mn-tree-sort__option--active' : ''
                    }`}
                    onClick={() => setTreeSort({ direction: option.value })}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <label className="mn-tree-sort__toggle">
                <Checkbox
                  checked={treeSort.foldersFirst}
                  onCheckedChange={(next) => setTreeSort({ foldersFirst: next })}
                />
                目录在前
              </label>
            </div>
          )}
        </div>
      </div>

      {/*
        这两件挂在工具栏下、**不塞进上面那条图标行**：那条行的 `aria-label` 是"视图整理"，
        而它们属于"对产物 / 内容动手"；而且 `ExportButton` 是带文字的按钮，会撑宽图标行，
        而侧栏最小宽度 `TREE_TOOLBAR_MIN_WIDTH_PX` 是按 5 个图标算出来的（`TreeHost` 用它
        定 row 轴叶子的下限），塞进去就得跟着改那个算式。
      */}
      <ExportButton />
      <TagFilterControl />
    </div>
  )
}
