/**
 * 文件树工具栏：过滤、展开/折叠、新建、重扫、切换 Vault。
 *
 * 第二行是**标签过滤控件**（`TagFilterControl`）：它同样属于文件树头部 ——
 * 两个入口并排放在一起，"文本收窄"与"标签收窄"在同一处可发现、可清除。
 * 因此这个容器加了 `--with-tags`（只在 CSS 里给自己开一行 `flex-wrap`，不改动
 * 原有的单行布局，见 `tag-filter.css`）。
 */

import { useEffect, useRef, useState } from 'react'

import { FOCUS_FILTER_EVENT } from '@/app/dom-events'
import { createNoteHere, moveSelected, openVaultInteractive, renameSelected, rescanVault } from '@/app/actions'
import { Icon } from '@/components/Icon'
import type { TreeSort } from '@/domain/tree'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'
import { TagFilterControl } from './TagFilterControl'

import './tree-sort.css'

/** 排序依据的可选项（标签是给人看的；键与 `TreeSort['by']` 一一对应）。 */
const SORT_BY_OPTIONS: readonly { value: TreeSort['by']; label: string }[] = [
  { value: 'name', label: '名称' },
  { value: 'mtime', label: '修改时间' },
  { value: 'size', label: '大小' },
  { value: 'type', label: '类型' },
]

export function TreeToolbar() {
  const filter = useVaultStore((state) => state.filter)
  const setFilter = useVaultStore((state) => state.setFilter)
  const expandAll = useVaultStore((state) => state.expandAll)
  const collapseAll = useVaultStore((state) => state.collapseAll)
  const info = useVaultStore((state) => state.info)
  const treeSort = useUiStore((state) => state.treeSort)
  const setTreeSort = useUiStore((state) => state.setTreeSort)
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

  // 排序菜单：点外面 / 按 Esc 收起（与标签过滤控件同一套手势，见 TagFilterControl）
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

      <div className="mn-tree-toolbar__actions">
        <button
          type="button"
          className="mn-icon-button"
          title="新建笔记（Ctrl+N）"
          aria-label="新建笔记"
          onClick={() => void createNoteHere()}
        >
          <Icon name="plus" />
        </button>
        <button
          type="button"
          className="mn-icon-button"
          title="重命名选中笔记（F2，会同时更新指向它的链接）"
          aria-label="重命名选中笔记"
          onClick={() => renameSelected()}
        >
          <Icon name="pencil" />
        </button>
        <button
          type="button"
          className="mn-icon-button"
          // 拖拽的键盘等价物（F6 同一条命令）：纯拖拽对键盘用户不可用，
          // 而工具栏按钮是最容易被发现的那个入口
          title="移动到文件夹…（F6，也可以直接拖拽文件树里的笔记）"
          aria-label="移动到文件夹"
          onClick={() => moveSelected()}
        >
          <Icon name="move" />
        </button>
        <button
          type="button"
          className="mn-icon-button"
          title="展开全部目录（Ctrl+Alt+E）"
          aria-label="展开全部目录"
          onClick={expandAll}
        >
          <Icon name="panelLeft" />
        </button>
        <button
          type="button"
          className="mn-icon-button"
          title="折叠全部目录（Ctrl+Alt+W）"
          aria-label="折叠全部目录"
          onClick={collapseAll}
        >
          <Icon name="columns" />
        </button>
        <button
          type="button"
          className="mn-icon-button"
          title="重新扫描 Vault（Ctrl+Alt+R）"
          aria-label="重新扫描 Vault"
          onClick={() => void rescanVault()}
        >
          <Icon name="refresh" />
        </button>
        <div className="mn-tree-sort" ref={sortRef}>
          <button
            type="button"
            className={`mn-icon-button${sortOpen ? ' mn-icon-button--active' : ''}`}
            title="文件树排序…"
            aria-label="文件树排序"
            aria-haspopup="menu"
            aria-expanded={sortOpen}
            onClick={() => setSortOpen((open) => !open)}
          >
            <Icon name="sort" />
          </button>
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
                    // 选中后不自动关菜单：排序常常要连调几项（依据 + 方向），
                    // 每点一次就收起来等于逼着用户重开三次
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
                <input
                  type="checkbox"
                  checked={treeSort.foldersFirst}
                  onChange={(event) => setTreeSort({ foldersFirst: event.target.checked })}
                />
                目录在前
              </label>
            </div>
          )}
        </div>
        <button
          type="button"
          className="mn-icon-button"
          title={`切换 Vault（当前：${info?.rootPath ?? '未打开'}）`}
          aria-label="切换 Vault"
          onClick={() => void openVaultInteractive()}
        >
          <Icon name="folderOpen" />
        </button>
      </div>

      <TagFilterControl />
    </div>
  )
}
