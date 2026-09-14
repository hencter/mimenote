/**
 * 一个停靠区（左 / 右 / 底）的渲染与拖拽。
 *
 * ## 三件事
 *
 * 1. **渲染**：按 `ui-store` 的 `dockLayout` 取出落在这个区里的模块，再按各自的可见性开关过滤
 *    （可见性仍归各开关管，见 `dock-layout.ts` 的文件头），逐个套上"标题头 + 内容"的壳；
 * 2. **拖拽落点**：拖到本区任意位置都能放 —— 落点由**现有模块的中线**算出来
 *    （`insertionIndexFor`），并用一条指示线画在将要插入的位置上；
 * 3. **键盘等价物**：`Alt+1/2/3` 搬到左/右/底，`Alt+方向键` 在本区内换位置，
 *    `Enter` / `空格` 打开该模块的菜单（右键菜单的键盘入口）。
 *
 * ## 空区也是一条可放的轨道
 *
 * 停靠区在"没有可见模块"时**不渲染**（默认状态下底部区就是空的，DOM 与从前一致）。
 * 但拖动时就相反：用户正要把模块搬过去，那个区必须**先出现**，否则"放到底部"这件事
 * 无处可落。所以拖动期间空区会渲染成一条细轨道（`mn-dock--rail`），它的高度/宽度来自
 * 该区的默认尺寸（底部 = `bottomDockHeight` 但压到 56px 的提示条，左右 = 默认宽度）。
 *
 * ## 标题头是"拖动手柄 + 菜单按钮"的合体
 *
 * 为什么不做成两个元素（一个手柄图标、一个菜单按钮）：面板很窄时两个 12px 的图标加标签
 * 会挤成一排；而"在这块面板的字上按右键/按回车"是用户本来就会做的动作。
 * `draggable` 与 `role="button"` 因此落在同一个元素上，键盘入口（Enter）打开的就是右键那份菜单。
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'

import { Icon } from '@/components/Icon'
import { ContextMenu, type ContextMenuItem } from '@/components/ContextMenu'
import { LinksPanel } from '@/features/links/LinksPanel'
import { OutlinePanel } from '@/features/outline/OutlinePanel'
import { TagsPanel } from '@/features/tags/TagsPanel'
import { FileTree } from '@/features/vault/FileTree'
import { RecentVaults } from '@/features/vault/RecentVaults'
import { TreeToolbar } from '@/features/vault/TreeToolbar'
import { useTagsStore } from '@/state/tags-store'
import { useUiStore } from '@/state/ui-store'
import {
  DOCK_KEYBOARD_HINT,
  DOCK_MODULES,
  DOCK_SIDES,
  insertionIndexFor,
  keyboardMove,
  sideOfModule,
  type DockModuleId,
  type DockSide,
} from './dock-layout'
import { useDockDrag } from './dock-drag'

import './dock.css'

/** 某块模块此刻是否可见（**唯一真相在各自的既有开关上**，见 dock-layout.ts）。 */
function useModuleVisible(id: DockModuleId): boolean {
  // 四个开关都要读（Hook 不能条件调用），再按 id 挑 —— 代价是四个选择器订阅，可以忽略
  const sidebarVisible = useUiStore((state) => state.sidebarVisible)
  const linksPanelVisible = useUiStore((state) => state.linksPanelVisible)
  const outlinePanelVisible = useUiStore((state) => state.outlinePanelVisible)
  const tagsOpen = useTagsStore((state) => state.open)
  switch (id) {
    case 'tree':
      return sidebarVisible
    case 'links':
      return linksPanelVisible
    case 'tags':
      return tagsOpen
    case 'outline':
      return outlinePanelVisible
  }
}

/** 关闭（隐藏）一块模块：走的仍然是那四条既有开关（快捷键与菜单因此是同一个效果）。 */
export function hideDockModule(id: DockModuleId): void {
  const ui = useUiStore.getState()
  if (id === 'tree') ui.toggleSidebar()
  else if (id === 'links') ui.toggleLinksPanel()
  else if (id === 'outline') ui.toggleOutlinePanel()
  else useTagsStore.getState().toggle()
}

/**
 * 某个停靠区里**可见**的模块（按落位顺序）。
 *
 * 导出给 `App` 用：布局要据此决定"这一区要不要渲染、要不要配分隔条" ——
 * 两处各自判断会出现"分隔条画着、面板却没有"这种对不上的画面。
 */
export function useVisibleDockModules(side: DockSide): readonly DockModuleId[] {
  const dockLayout = useUiStore((state) => state.dockLayout)
  const treeVisible = useModuleVisible('tree')
  const linksVisible = useModuleVisible('links')
  const tagsVisible = useModuleVisible('tags')
  const outlineVisible = useModuleVisible('outline')
  const visibleOf = (id: DockModuleId): boolean =>
    id === 'tree'
      ? treeVisible
      : id === 'links'
        ? linksVisible
        : id === 'tags'
          ? tagsVisible
          : outlineVisible
  return useMemo(
    () => dockLayout[side].filter((id) => visibleOf(id)),
    // `visibleOf` 是每次渲染新建的闭包，但它的判据就是下面这四个布尔量，列进来即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dockLayout, side, treeVisible, linksVisible, tagsVisible, outlineVisible],
  )
}

/** 模块的内容。四种模块各自是一个自洽的面板（这里只负责摆进去）。 */
function DockModuleContent({ id }: { id: DockModuleId }) {
  switch (id) {
    case 'tree':
      return (
        <>
          <TreeToolbar />
          <FileTree />
          {/* 「最近打开的 Vault」跟着文件树走：切 Vault 是文件树这个上下文的动作，
              视线本来就在这一块；它**不是**独立模块 —— 单独搬来搬去没有语义，
              而"文件树在哪一区"已经由停靠模型决定了 */}
          <RecentVaults />
        </>
      )
    case 'links':
      return <LinksPanel />
    case 'tags':
      return <TagsPanel />
    case 'outline':
      return <OutlinePanel />
  }
}

export function DockHost({ side }: { side: DockSide }) {
  const modules = useVisibleDockModules(side)
  const dockLayout = useUiStore((state) => state.dockLayout)
  const moveDockModule = useUiStore((state) => state.moveDockModule)
  const sidebarWidth = useUiStore((state) => state.sidebarWidth)
  const linksPanelWidth = useUiStore((state) => state.linksPanelWidth)
  const bottomDockHeight = useUiStore((state) => state.bottomDockHeight)
  const dragging = useDockDrag((state) => state.dragging)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ id: DockModuleId; x: number; y: number } | null>(null)
  const sectionRef = useRef<HTMLElement | null>(null)

  /**
   * 停靠区的尺寸。
   *
   * 宽度/高度仍然存在 `ui-store` 的**既有字段**里（左 = `sidebarWidth`、右 = `linksPanelWidth`、
   * 底 = `bottomDockHeight`）—— 这样分隔条、设置与持久化都沿用原来的口径，
   * 不因为"面板换了位置"就多出一套尺寸记忆（同一块面板搬到右边时，用的就是右边那一栏的宽度）。
   */
  const sizeStyle: { width?: number; height?: number } =
    side === 'left'
      ? { width: sidebarWidth }
      : side === 'right'
        ? { width: linksPanelWidth }
        : { height: bottomDockHeight }

  /** 拖拽轴上的坐标（竖排用 y、横排用 x）—— 落点判据只认这一条轴。 */
  const axisValue = useCallback(
    (event: { clientX: number; clientY: number }): number =>
      side === 'bottom' ? event.clientX : event.clientY,
    [side],
  )

  const handleDragOver = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      if (dragging === null) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      const section = sectionRef.current
      if (section === null) return
      const nodes = Array.from(section.querySelectorAll<HTMLElement>('[data-dock-module]'))
      const centers = nodes.map((node) => {
        const rect = node.getBoundingClientRect()
        return side === 'bottom' ? rect.left + rect.width / 2 : rect.top + rect.height / 2
      })
      setDropIndex(insertionIndexFor(centers, axisValue(event)))
    },
    [dragging, side, axisValue],
  )

  const handleDrop = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      if (dragging === null) return
      event.preventDefault()
      const from = dockLayout[side].indexOf(dragging)
      let index = dropIndex
      // 落点是按**含自己在内**的列表算出来的；真正插入的下标是"移除自己之后"的
      // （与 `moveDockModule` 的索引语义一致）：自己以前的位置之前的项不受影响，
      // 之后的项要整体前移一位
      if (index !== null && from >= 0 && index > from) index -= 1
      if (index === null || index !== from) {
        moveDockModule(dragging, side, index ?? undefined)
      }
      useDockDrag.getState().end()
      setDropIndex(null)
    },
    [dragging, dockLayout, side, dropIndex, moveDockModule],
  )

  const handleDragLeave = useCallback((event: ReactDragEvent<HTMLElement>) => {
    // 只有真的离开这一区才清指示线（进入子元素也会触发 dragleave）
    const next = event.relatedTarget
    if (next instanceof Node && event.currentTarget.contains(next)) return
    setDropIndex(null)
  }, [])

  const openMenu = useCallback((id: DockModuleId, x: number, y: number) => {
    setMenu({ id, x, y })
  }, [])

  /**
   * 一块模块的菜单：搬运 + 隐藏。
   *
   * "已经在那一侧"的项**置灰而不是删掉**：菜单的项数与位置因此是稳定的，
   * 用户第二次右键时不用重新找（这与"按状态换菜单"相比是可预期性优先）。
   */
  const menuItems = useCallback(
    (id: DockModuleId): ContextMenuItem[] => {
      const current = sideOfModule(dockLayout, id)
      const index = current === null ? -1 : dockLayout[current].indexOf(id)
      const count = current === null ? 0 : dockLayout[current].length
      const move = (target: DockSide): ContextMenuItem => ({
        id: `to-${target}`,
        label: target === 'left' ? '移到左侧' : target === 'right' ? '移到右侧' : '移到底部',
        disabled: current === target,
        onSelect: () => moveDockModule(id, target),
      })
      const before: ContextMenuItem =
        current === 'bottom'
          ? {
              id: 'move-prev',
              label: '左移一位',
              disabled: index <= 0,
              onSelect: () => moveDockModule(id, 'bottom', index - 1),
            }
          : {
              id: 'move-prev',
              label: '上移一位',
              disabled: index <= 0,
              onSelect: () => current !== null && moveDockModule(id, current, index - 1),
            }
      const after: ContextMenuItem =
        current === 'bottom'
          ? {
              id: 'move-next',
              label: '右移一位',
              disabled: index < 0 || index >= count - 1,
              onSelect: () => moveDockModule(id, 'bottom', index + 1),
            }
          : {
              id: 'move-next',
              label: '下移一位',
              disabled: current === null || index < 0 || index >= count - 1,
              onSelect: () => current !== null && moveDockModule(id, current, index + 1),
            }
      return [
        move('left'),
        move('right'),
        move('bottom'),
        { ...before, separatorBefore: true },
        after,
        {
          id: 'hide',
          label: '隐藏这一块',
          onSelect: () => hideDockModule(id),
          separatorBefore: true,
        },
      ]
    },
    [dockLayout, moveDockModule],
  )

  /** 标题头的键盘：Alt+数字/方向 = 换位置，Enter/空格 = 打开菜单。 */
  const handleHeaderKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>, id: DockModuleId) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        const rect = event.currentTarget.getBoundingClientRect()
        openMenu(id, rect.left, rect.bottom + 2)
        return
      }
      if (!event.altKey) return
      const next = keyboardMove(dockLayout, id, `Alt+${event.key}`)
      if (next === null) return
      event.preventDefault()
      const target = sideOfModule(next, id)
      if (target !== null) {
        moveDockModule(id, target, next[target].indexOf(id))
      }
    },
    [dockLayout, moveDockModule, openMenu],
  )

  // 没有可见模块：不拖动时整区不渲染（默认状态与从前一致）；拖动时给一条可放的轨道
  if (modules.length === 0) {
    if (dragging === null) return null
    return (
      <section
        className={`mn-dock mn-dock--${side} mn-dock--rail`}
        data-dock={side}
        data-dock-rail={side}
        ref={sectionRef}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <span className="mn-dock__rail-label">
          放到{DOCK_SIDES.indexOf(side) === 0 ? '左' : DOCK_SIDES.indexOf(side) === 1 ? '右' : '底'}侧
        </span>
      </section>
    )
  }

  return (
    <section
      // 左停靠区**保留 `mn-sidebar` 这个类**：它是"左侧那一栏"在样式与端到端用例里的既有名字
      // （侧栏宽度、`Ctrl+B` 后的存在与否都有断言），换名字只会让那些断言全部重写而没有收益
      className={`mn-dock mn-dock--${side}${side === 'left' ? ' mn-sidebar' : ''}`}
      data-dock={side}
      ref={sectionRef}
      style={sizeStyle}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {modules.map((id, index) => {
        const meta = DOCK_MODULES[id]
        return (
          <div key={id} className="mn-dock__module" data-dock-module={id}>
            {dropIndex === index && <div className="mn-dock__drop-line" data-dock-drop-line={index} />}
            <header
              className="mn-dock__header"
              data-dock-module-header={id}
              // 手柄图标只是"这里能拖"的提示：拖动与菜单都挂在这一整行上
              draggable
              tabIndex={0}
              role="button"
              aria-haspopup="menu"
              aria-label={`${meta.label} 面板：拖动换位置，回车打开菜单（${DOCK_KEYBOARD_HINT}）`}
              title={`${meta.hint}\n拖动换位置；${DOCK_KEYBOARD_HINT}`}
              onDragStart={(event) => {
                useDockDrag.getState().begin(id)
                event.dataTransfer.effectAllowed = 'move'
                // 有些平台要求 dragstart 时写入数据，拖拽才会真的开始（值本身没人读）
                event.dataTransfer.setData('text/plain', id)
              }}
              onDragEnd={() => {
                useDockDrag.getState().end()
                setDropIndex(null)
              }}
              onKeyDown={(event) => handleHeaderKeyDown(event, id)}
              onContextMenu={(event: ReactMouseEvent<HTMLElement>) => {
                event.preventDefault()
                openMenu(id, event.clientX, event.clientY)
              }}
            >
              <Icon name="move" size={12} />
              <span className="mn-dock__title">{meta.label}</span>
              <button
                type="button"
                className="mn-dock__hide"
                aria-label={`隐藏${meta.label}面板`}
                title="隐藏这一块（与它的快捷键等价）"
                onClick={() => hideDockModule(id)}
              >
                <Icon name="x" size={11} />
              </button>
            </header>
            <div className="mn-dock__body">
              <DockModuleContent id={id} />
            </div>
          </div>
        )
      })}
      {dropIndex === modules.length && (
        <div className="mn-dock__drop-line" data-dock-drop-line={modules.length} />
      )}
      {menu !== null && (
        <ContextMenu
          items={menuItems(menu.id)}
          x={menu.x}
          y={menu.y}
          ariaLabel={`${DOCK_MODULES[menu.id].label} 面板的位置菜单`}
          onClose={() => setMenu(null)}
        />
      )}
    </section>
  )
}
