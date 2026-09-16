/**
 * 一个叶子的**标签条**（ADR-0035：「每个模块都是标签 + 内容」的那条标签）。
 *
 * 笔记与视图模块在这里是**同一类东西**（都是 `LayoutItemId`，都能拖到别的格子）：
 *
 * - **笔记标签**：点击 → `tabs-store.activate`（全局唯一当前文档切过去，对账会把这一格的
 *   激活项跟过去）；中键 / × 关闭；右键是旧全局标签栏那份菜单（关闭 / 关闭其他 /
 *   关闭全部 / 在文件树中定位）；未保存（●）与冲突标记只出现在**当前文档**的标签上
 *   （note-store 只持有一份文档，其它标签不可能脏）。
 * - **模块标签**：点击 → 这一格切到它；右键 / `Enter` 是位置菜单（搬到主叶左/右/下、
 *   条内前移/后移、隐藏这一块）；× = 隐藏（与它的快捷键走的是**同一条**开关，
 *   见 `module-visibility.ts`）。
 * - 键盘：`←/→/Home/End` 在条内移动焦点并顺手激活（roving tabindex，选中即切换 ——
 *   与旧标签栏同一模型）；`Alt+1/2/3` 搬到主叶左/右/下、`Alt+←/→` 条内换位置
 *   （判据只有 `tree-keys.ts` 一份，模块菜单的置灰也用它）。
 *
 * 拖拽（HTML5）：标签是拖动源，落点计算在 `LeafPane`（条上 = 插到第几位、内容区 =
 * 并入或切一刀，见 `drop-target.ts`）。本组件只负责**渲染**：拖动状态与落点 hint
 * 都由父组件持有并作为 props 传进来。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react'

import { REVEAL_ROW_EVENT } from '@/app/dom-events'
import { ContextMenu, type ContextMenuItem } from '@/components/ContextMenu'
import { Icon } from '@/components/Icon'
import { basename, displayName } from '@/domain/paths'
import { useNoteStore } from '@/state/note-store'
import { useTabsStore } from '@/state/tabs-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

import { useLayoutDrag } from './layout-drag'
import { hideModule, showModule } from './module-visibility'
import { adjustNewSplitRatio } from './split-size'
import { keyboardMoveItem, LAYOUT_KEYBOARD_HINT } from './tree-keys'
import {
  isViewModule,
  leafOfItem,
  notePathOf,
  setActive,
  VIEW_MODULES,
  type LayoutItemId,
  type LeafNode,
} from './tree-layout'

/** 标签上的状态标记：未保存（●）与冲突（警示图标）必须一眼分得开。 */
type TabMark = 'dirty' | 'conflict'

const MARK_TITLE: Record<TabMark, string> = {
  dirty: '有未保存的修改',
  conflict: '这篇笔记在磁盘上被外部改动过：需要你决定「覆盖」还是「重新加载」',
}

export interface LeafTabsProps {
  leaf: LeafNode
  /** 这一格**可见**的标签（隐藏面板的标签不在其中，顺序 = 树上的顺序）。 */
  items: readonly LayoutItemId[]
  /** 拖动中的插入位（`null` = 没有在拖/不落在本条上）。 */
  dropIndex: number | null
}

export function LeafTabs({ leaf, items, dropIndex }: LeafTabsProps) {
  const activate = useTabsStore((state) => state.activate)
  const closeTab = useTabsStore((state) => state.closeTab)

  // 笔记标签的"当前"读 note-store（唯一事实来源）；模块标签的"当前" = 这一格的 active
  const currentDoc = useNoteStore((state) => state.doc?.relPath ?? null)
  const dirty = useNoteStore((state) => state.dirty)
  const conflicted = useNoteStore((state) => state.conflict !== null)

  const stripRef = useRef<HTMLDivElement | null>(null)
  /** 右键菜单（`null` = 没打开）。位置与目标标签都在这里。 */
  const [menu, setMenu] = useState<{ item: LayoutItemId; x: number; y: number } | null>(null)

  /** 这一格"实际显示"的标签：active 可见就它，否则第一个可见（active 可能指着被隐藏的面板）。 */
  const shown =
    leaf.active !== null && items.includes(leaf.active) ? leaf.active : (items[0] ?? null)

  // 激活项变化时把它滚进可视区：标签多到需要横向滚动时，否则看不见当前是哪个
  useEffect(() => {
    if (shown === null) return
    const node = findTabNode(stripRef.current, shown)
    if (node !== null && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [shown, items.length])

  /**
   * 键盘/菜单共用的搬运入口（`Alt+1/2/3`、`Alt+←/→` 与模块菜单的每一项都走这里）。
   * 切出去独占一格的模块，新刀调成它的家尺寸比例（见 `split-size.ts`）。
   */
  const applyKeyMove = useCallback((item: LayoutItemId, key: string): boolean => {
    const ui = useUiStore.getState()
    let next = keyboardMoveItem(ui.layout, item, key)
    if (next === null) return false
    const edge = key === 'Alt+1' ? 'left' : key === 'Alt+2' ? 'right' : key === 'Alt+3' ? 'bottom' : null
    if (edge !== null) {
      // 量的是**主叶**此刻的像素（Alt+1/2/3 的落点总是主叶的一侧，见 tree-keys.ts）
      const rect = document
        .querySelector('[data-leaf-id="main"] .mn-leaf__content')
        ?.getBoundingClientRect()
      const extent = edge === 'bottom' ? (rect?.height ?? 0) : (rect?.width ?? 0)
      next = adjustNewSplitRatio({ layout: next, item, edge, extentPx: extent })
    }
    ui.setLayout(next)
    return true
  }, [])

  /** 激活一个标签：笔记走全局切换（单文档模型），模块只翻这一格。 */
  const activateItem = useCallback(
    (item: LayoutItemId): void => {
      const note = notePathOf(item)
      if (note !== null) {
        void activate(note)
        return
      }
      const ui = useUiStore.getState()
      ui.setLayout(setActive(ui.layout, leaf.id, item))
    },
    [activate, leaf.id],
  )

  /** 「在文件树中定位」：文件树可能正被收起、或它那一格停在别的标签上 —— 先让它露面再定位。 */
  const revealInTree = useCallback((relPath: string): void => {
    showModule('tree')
    const ui = useUiStore.getState()
    const treeLeaf = leafOfItem(ui.layout, 'tree')
    if (treeLeaf !== null && treeLeaf.active !== 'tree') {
      ui.setLayout(setActive(ui.layout, treeLeaf.id, 'tree'))
    }
    const vault = useVaultStore.getState()
    vault.revealPath(relPath)
    vault.select(relPath)
    window.dispatchEvent(new CustomEvent(REVEAL_ROW_EVENT, { detail: { relPath } }))
  }, [])

  // -------------------------------------------------------------------------
  // 键盘
  // -------------------------------------------------------------------------

  const onKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    index: number,
    item: LayoutItemId,
  ): void => {
    // 误按删除键不该关掉标签（可访问性要求：关闭只走 Mod+W 或 ×）
    if (event.key === 'Delete' || event.key === 'Backspace') return

    // Alt 组合：搬运与换位置（判据在 tree-keys.ts；null = 这键不归这里，别吞）
    if (event.altKey) {
      if (!applyKeyMove(item, `Alt+${event.key}`)) return
      event.preventDefault()
      return
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      // 模块标签的 Enter = 打开位置菜单（右键的键盘入口，与旧停靠头同一约定）；
      // 笔记标签的 Enter = 切换（它本来就是"点一下"的键盘等价）
      if (isViewModule(item)) {
        const rect = event.currentTarget.getBoundingClientRect()
        setMenu({ item, x: rect.left, y: rect.bottom + 2 })
      } else {
        activateItem(item)
      }
      return
    }

    let target = -1
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') target = index + 1
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') target = index - 1
    else if (event.key === 'Home') target = 0
    else if (event.key === 'End') target = items.length - 1
    else return

    event.preventDefault()
    const wrapped = ((target % items.length) + items.length) % items.length
    const next = items[wrapped]
    if (next === undefined) return
    activateItem(next)
    // 焦点跟着走（roving tabindex）：无论激活是否成功，键盘焦点都该停在这一项上
    findTabNode(stripRef.current, next)?.focus()
  }

  // -------------------------------------------------------------------------
  // 菜单（两类标签各一份）
  // -------------------------------------------------------------------------

  /** 笔记标签的菜单：与旧全局标签栏逐字一致（同一份动作，未保存确认也走同一条路）。 */
  const noteMenuItems = (relPath: string): ContextMenuItem[] => {
    const tabs = useTabsStore.getState().tabs
    return [
      { id: 'close', label: '关闭', onSelect: () => void closeTab(relPath) },
      {
        id: 'close-others',
        label: '关闭其他',
        disabled: tabs.length <= 1,
        onSelect: () => void useTabsStore.getState().closeOthers(relPath),
      },
      {
        id: 'close-all',
        label: '关闭全部',
        onSelect: () => void useTabsStore.getState().closeAll(),
      },
      {
        id: 'reveal',
        label: '在文件树中定位',
        separatorBefore: true,
        onSelect: () => revealInTree(relPath),
      },
    ]
  }

  /**
   * 模块标签的位置菜单。
   *
   * 搬运与换位置的**判据与键盘完全同一处**（`keyboardMoveItem`）：返回 `null` 的组合
   * 在菜单里就是置灰项 —— 菜单与快捷键因此永远不会出现"一个能用一个不能用"。
   * 置灰而不是删掉：菜单的项数与位置稳定，用户第二次右键不用重新找。
   */
  const moduleMenuItems = (id: LayoutItemId): ContextMenuItem[] => {
    const tryKey = (key: string) => keyboardMoveItem(useUiStore.getState().layout, id, key)
    const move = (key: string, label: string): ContextMenuItem => ({
      id: label,
      label,
      disabled: tryKey(key) === null,
      onSelect: () => {
        applyKeyMove(id, key)
      },
    })
    return [
      move('Alt+1', '搬到主区左侧'),
      move('Alt+2', '搬到主区右侧'),
      move('Alt+3', '搬到主区下方'),
      { ...move('Alt+ArrowLeft', '前移一位'), separatorBefore: true },
      move('Alt+ArrowRight', '后移一位'),
      {
        id: 'hide',
        label: '隐藏这一块',
        separatorBefore: true,
        onSelect: () => {
          if (isViewModule(id)) hideModule(id)
        },
      },
    ]
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  return (
    <div
      className="mn-tabs mn-tabs--leaf"
      role="tablist"
      aria-label="这一格的标签"
      data-leaf-tabs={leaf.id}
      ref={stripRef}
    >
      {items.map((item, index) => {
        const note = notePathOf(item)
        const isShown = item === shown
        const tab = (
          <div
            key={item}
            className={[
              'mn-tabs__tab',
              isShown ? 'mn-tabs__tab--active' : '',
              note === null ? 'mn-tabs__tab--module' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            role="tab"
            aria-selected={isShown}
            // roving tabindex：Tab 键只落在"这一格正在显示"的标签上，进入后用 ←/→ 走
            tabIndex={isShown ? 0 : -1}
            data-tab-path={note ?? undefined}
            data-module-tab={note === null ? item : undefined}
            // 标签就是拖动源（ADR-0035：「拖拽的内容是标签」）
            draggable
            onDragStart={(event: ReactDragEvent<HTMLDivElement>) => {
              useLayoutDrag.getState().begin(item)
              event.dataTransfer.effectAllowed = 'move'
              // 有些平台要求 dragstart 时写入数据，拖拽才会真的开始（值本身没人读）
              event.dataTransfer.setData('text/plain', item)
            }}
            onDragEnd={() => useLayoutDrag.getState().end()}
            onClick={() => activateItem(item)}
            onKeyDown={(event) => onKeyDown(event, index, item)}
            onContextMenu={(event: ReactMouseEvent<HTMLDivElement>) => {
              event.preventDefault()
              setMenu({ item, x: event.clientX, y: event.clientY })
            }}
            {...(note !== null
              ? (() => {
                  // 未保存/冲突后缀同时进 title 与 aria-label：可见文案只圈文件名，
                  // 状态给悬停与读屏（与旧全局标签栏同一契约）
                  const isCurrent = currentDoc === note
                  const statusSuffix = !isCurrent
                    ? ''
                    : conflicted
                      ? '（冲突）'
                      : dirty
                        ? '（未保存）'
                        : ''
                  return {
                    title: `${note}${statusSuffix}`,
                    'aria-label': `${note}${statusSuffix}`,
                    onAuxClick: (event: ReactMouseEvent<HTMLDivElement>) => {
                      if (event.button !== 1) return // 只有中键
                      event.preventDefault()
                      void closeTab(note)
                    },
                    // 中键默认会触发自动滚动，先挡掉
                    onMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => {
                      if (event.button === 1) event.preventDefault()
                    },
                  }
                })()
              : {
                  title: `${VIEW_MODULES[item as keyof typeof VIEW_MODULES].hint}\n拖动换位置；${LAYOUT_KEYBOARD_HINT}`,
                  'aria-label': `${VIEW_MODULES[item as keyof typeof VIEW_MODULES].label} 面板标签`,
                })}
          >
            <span className="mn-tabs__label">
              {note !== null ? displayName(note) : VIEW_MODULES[item as keyof typeof VIEW_MODULES].label}
            </span>
            {note !== null && currentDoc === note && (conflicted || dirty) && (
              <span
                className={`mn-tabs__mark mn-tabs__mark--${conflicted ? 'conflict' : 'dirty'}`}
                title={MARK_TITLE[conflicted ? 'conflict' : 'dirty']}
                aria-hidden="true"
              >
                {conflicted ? <Icon name="alert" size="xs" /> : '●'}
              </span>
            )}
            <button
              type="button"
              className="mn-tabs__close"
              aria-label={
                note !== null
                  ? `关闭 ${note}`
                  : `隐藏${VIEW_MODULES[item as keyof typeof VIEW_MODULES].label}面板`
              }
              title={note !== null ? '关闭（Ctrl+W 关闭当前标签）' : '隐藏这一块（与它的快捷键等价）'}
              onClick={(event) => {
                // 不要让点击穿透到标签本身（那会先切过去再关掉/隐藏，白翻一次页）
                event.stopPropagation()
                if (note !== null) void closeTab(note)
                else if (isViewModule(item)) hideModule(item)
              }}
            >
              <Icon name="x" size="xs" />
            </button>
          </div>
        )
        // 落点线插在第 dropIndex 位之前（流内占位，标签自然让位 —— 与旧停靠区同一手法）
        return (
          <TabWithDropLine key={item} lineBefore={dropIndex === index}>
            {tab}
          </TabWithDropLine>
        )
      })}
      {dropIndex === items.length && <div className="mn-tabs__drop-line" data-drop-line="end" />}
      {menu !== null && (
        <ContextMenu
          items={
            notePathOf(menu.item) !== null
              ? noteMenuItems(notePathOf(menu.item)!)
              : moduleMenuItems(menu.item)
          }
          x={menu.x}
          y={menu.y}
          ariaLabel={
            notePathOf(menu.item) !== null
              ? `${basename(notePathOf(menu.item)!)} 标签的操作菜单`
              : `${VIEW_MODULES[menu.item as keyof typeof VIEW_MODULES].label} 面板的位置菜单`
          }
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

/** 标签 + 它前面的落点线（落点线是流内占位，见上面 map 里的注释）。 */
function TabWithDropLine({
  lineBefore,
  children,
}: {
  lineBefore: boolean
  children: ReactNode
}) {
  return (
    <>
      {lineBefore && <div className="mn-tabs__drop-line" data-drop-line="before" />}
      {children}
    </>
  )
}

/** 按身份钩子找标签节点（不用属性选择器：路径里的特殊字符不用转义）。 */
function findTabNode(root: HTMLElement | null, item: LayoutItemId): HTMLElement | null {
  if (root === null) return null
  const note = notePathOf(item)
  for (const node of root.querySelectorAll<HTMLElement>('[data-tab-path], [data-module-tab]')) {
    if (note !== null ? node.dataset.tabPath === note : node.dataset.moduleTab === item) return node
  }
  return null
}
