/**
 * 文件树工具栏：过滤、展开/折叠、重扫、排序、切换 Vault 与**导出**。
 *
 * 文档操作组（新建 / 重命名 / 移动到文件夹）在 ADR-0051 的走查里撤出了这里 ——
 * 它们的等价入口在文件树右键菜单、`Ctrl+N` / `F2` / `F6` 与命令面板里；
 * **导出留下**：那是三选一对话框的唯一入口（理由见下方那处注释）。
 *
 * 第二行是**标签过滤控件**（`TagFilterControl`）：它同样属于文件树头部 ——
 * 两个入口并排放在一起，"文本收窄"与"标签收窄"在同一处可发现、可清除。
 * 因此这个容器加了 `--with-tags`（只在 CSS 里给自己开一行 `flex-wrap`，不改动
 * 原有的单行布局，见 `tag-filter.css`）。
 */

import { useEffect, useRef, useState } from 'react'

import { FOCUS_FILTER_EVENT } from '@/app/dom-events'
import { openVaultInteractive, rescanVault } from '@/app/actions'
import { Checkbox } from '@/components/Checkbox'
import { Tooltip } from '@/components/Tooltip'
import { Icon } from '@/components/Icon'
import type { TreeSort } from '@/domain/tree'
import { ExportButton } from '@/features/export/ExportButton'
import { hideModule } from '@/features/layout/module-visibility'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'
import { TagFilterControl } from './TagFilterControl'
import { toggleTreeLayout, useTreeLayout } from './tree-layout-pref'

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
  /** 文件树画法（单栏 / 分栏）。偏好落在 `settings-store`，见 `tree-layout-pref.ts`。 */
  const columnsOn = useTreeLayout() === 'columns'
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
        {/* 视图整理：展开 / 折叠只改变看到多少，不动任何文件 */}
        <span className="mn-tree-toolbar__group" role="group" aria-label="展开折叠">
          <Tooltip label="展开全部目录（Ctrl+Alt+E）">
            <button
              type="button"
              className="mn-icon-button"
              aria-label="展开全部目录"
              onClick={expandAll}
            >
              <Icon name="expandAll" /><span>展开</span>
            </button>
          </Tooltip>
          <Tooltip label="折叠全部目录（Ctrl+Alt+W）">
            <button
              type="button"
              className="mn-icon-button"
              aria-label="折叠全部目录"
              onClick={collapseAll}
            >
              <Icon name="collapseAll" /><span>折叠</span>
            </button>
          </Tooltip>
          {/*
            单栏 ⇄ 分栏（Miller columns，ADR-0058）：与展开/折叠同属"视图整理"这一组
            —— 它同样只改变**看得见多少、怎么看**，不动任何文件。
            `aria-pressed` 表达"此刻是否在分栏"（一个开关型按钮的两态，而不是"再做一次"），
            与排序按钮的 `aria-expanded` 是两种不同的语义，别混。
          */}
          <Tooltip label={columnsOn ? '切回单栏文件树（Ctrl+Alt+C）' : '切换为分栏文件树（Ctrl+Alt+C）'}>
            <button
              type="button"
              className={`mn-icon-button${columnsOn ? ' mn-icon-button--active' : ''}`}
              aria-label="切换分栏视图"
              aria-pressed={columnsOn}
              onClick={toggleTreeLayout}
            >
              <Icon name="columns" /><span>分栏</span>
            </button>
          </Tooltip>
        </span>
        {/* 库操作：重扫 / 排序 / 换库（作用对象是整个 Vault，不是某篇笔记） */}
        <span className="mn-tree-toolbar__group" role="group" aria-label="库操作">
          <Tooltip label="重新扫描 Vault（Ctrl+Alt+R）">
            <button
              type="button"
              className="mn-icon-button"
              aria-label="重新扫描 Vault"
              onClick={() => void rescanVault()}
            >
              <Icon name="refresh" /><span>刷新</span>
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
              <Icon name="sort" /><span>排序</span>
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
                  <Checkbox
                    checked={treeSort.foldersFirst}
                    onCheckedChange={(next) => setTreeSort({ foldersFirst: next })}
                  />
                  目录在前
                </label>
            </div>
          )}
        </div>
          <Tooltip label={`切换 Vault（当前：${info?.rootPath ?? '未打开'}）`}>
            <button
              type="button"
              className="mn-icon-button"
              aria-label="切换 Vault"
              onClick={() => void openVaultInteractive()}
            >
              <Icon name="folderOpen" /><span>打开库</span>
            </button>
          </Tooltip>
        </span>
        <span className="mn-tree-toolbar__divider" aria-hidden="true" />
        {/*
          导出**留在这里**（ADR-0051 的走查结论）：它是"产物出口"，而且是**三选一对话框**
          （单篇 HTML / 打印为 PDF / 整库静态站点）的唯一入口 —— 命令面板里那三条命令是
          "直接执行"，不经过对话框。撤掉这个按钮会让那张对话框的说明（比如"链接索引还在构建"
          为什么灰着）在任何地方都看不到。文档操作组（新建/重命名/移动）则确实撤了：
          它们的等价入口在文件树右键菜单与快捷键里。
        */}
        <ExportButton />
        {/*
          「隐藏这一块」住在**面板自己**的头上（用户要求：功能面板的隐藏由功能面板进行）——
          与标签面板 / 链接面板头部的那个关闭按钮同一约定，不再只依赖标签条的右键菜单。
          走 `hideModule` = 与 `Ctrl+B` **同一条开关**，因此"隐藏 ≠ 移除"：树里的位置原样留着，
          再打开就回原位（见 `module-visibility.ts` 文件头）。
        */}
        <button
          type="button"
          className="mn-icon-button"
          aria-label="隐藏文件树面板"
          title="隐藏文件树（Ctrl+B）"
          onClick={() => hideModule('tree')}
        >
          <Icon name="x" size="xs" />
        </button>
      </div>

      <TagFilterControl />
    </div>
  )
}
