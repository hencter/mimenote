/**
 * 标签栏（M3）：把"现在开着哪几篇笔记"摆在一眼能看到的地方。
 *
 * 交互（全部落在 store 上，组件自己不编排顺序约束）：
 * - **点击**切换；**中键**或 **×** 关闭；`Mod+W` 关闭当前；`Mod+Alt+←/→` 循环切换
 *   （后两个是命令，见 `app/builtin-commands.ts` 的 `tabs.*`）；
 * - `↑↓←→`/`Home`/`End` 在标签之间移动焦点并顺手切换（标签栏的键盘模型就是"选中即切换"）；
 * - `Delete`/`Backspace` **刻意不关闭**标签 —— 误按的代价太大，关闭只走 `Mod+W` 或 `×`。
 *
 * 组件本身只做两件事：渲染 `tabs-store` 的列表 + 监听事件后调用 store 的动作。
 * 它同时是"标签页与 note-store/vault-store 对账"的装配点（{@link installTabsSync}）——
 * 挂载即安装、卸载即撤销（副作用可逆）。
 *
 * 布局：根节点是 `flex: 0 0 auto` 的一行，挂在 **`.mn-app`** 上（标题栏之下、`.mn-body` 之上），
 * 因此横跨整个窗口宽度 —— 标签是"这个窗口开着哪几篇笔记"的全局信息，不该被侧栏挤窄。
 * 它曾经挂在 `.mn-main` 里并靠 `:has(> .mn-tabs)` 把主区域改成列方向；移到窗口顶部之后
 * 那条规则已删（见 `tabs.css` 的文件头）。
 *
 * 右键一个标签会打开操作菜单（关闭 / 关闭其他 / 关闭全部 / 在文件树中定位）——
 * 关闭走的是 store 里的同一批动作（`closeTab` / `closeOthers` / `closeAll`），
 * 未保存确认与光标记忆因此与 `Ctrl+W`、`×` 完全一致。
 */

import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'

import { REVEAL_ROW_EVENT } from '@/app/dom-events'
import { ContextMenu, type ContextMenuItem } from '@/components/ContextMenu'
import { Icon } from '@/components/Icon'
import { basename, displayName } from '@/domain/paths'
import { useNoteStore } from '@/state/note-store'
import { installTabsSync, setCaretMemory, useTabsStore } from '@/state/tabs-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

import { clearCaretMemory, editorCaretMemory } from './caret-memory'
import './tabs.css'

/** 标签上的状态标记：未保存（●）与冲突（警示图标）必须一眼分得开。 */
type TabMark = 'dirty' | 'conflict'

const MARK_TITLE: Record<TabMark, string> = {
  dirty: '有未保存的修改',
  conflict: '这篇笔记在磁盘上被外部改动过：需要你决定「覆盖」还是「重新加载」',
}

export function TabBar() {
  const tabs = useTabsStore((state) => state.tabs)
  const activate = useTabsStore((state) => state.activate)
  const closeTab = useTabsStore((state) => state.closeTab)

  // 高亮读 note-store（"当前文档"的唯一事实来源），而不是 tabs-store 里的镜像：
  // 镜像由对账回调写，直接读源头可以少一层中间态。
  const activeRelPath = useNoteStore((state) => state.doc?.relPath ?? null)
  const dirty = useNoteStore((state) => state.dirty)
  const conflicted = useNoteStore((state) => state.conflict !== null)

  const stripRef = useRef<HTMLDivElement | null>(null)
  /** 标签右键菜单（`null` = 没打开）。位置与目标都在这里，`TabBar` 自己持有。 */
  const [menu, setMenu] = useState<{ relPath: string; x: number; y: number } | null>(null)

  useEffect(() => {
    // 安装对账（note-store 新打开的笔记 → 补进列表；换 Vault → 清空并恢复）
    const dispose = installTabsSync()
    // 注册光标/滚动位置记忆器（实现放在本目录，state 层不认识 CodeMirror）
    setCaretMemory(editorCaretMemory)
    return () => {
      setCaretMemory(null)
      clearCaretMemory()
      dispose()
    }
  }, [])

  // 激活项变化时把它滚进可视区：标签多到需要横向滚动时，否则看不见当前是哪个
  useEffect(() => {
    if (activeRelPath === null) return
    const node = findTabNode(stripRef.current, activeRelPath)
    if (node !== null && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [activeRelPath, tabs.length])

  // 没有打开的笔记 → 不渲染任何东西：空态就是编辑器的占位提示，
  // 这样"没有标签时"的布局与引入标签栏之前**逐像素一致**（E2E 有高度断言）
  if (tabs.length === 0) return null

  const onKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    index: number,
    relPath: string,
  ): void => {
    // 误按删除键不该关掉标签（可访问性要求：关闭只走 Mod+W 或点 ×）
    if (event.key === 'Delete' || event.key === 'Backspace') return

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      void activate(relPath)
      return
    }

    let target = -1
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') target = index + 1
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') target = index - 1
    else if (event.key === 'Home') target = 0
    else if (event.key === 'End') target = tabs.length - 1
    else return

    event.preventDefault()
    const wrapped = ((target % tabs.length) + tabs.length) % tabs.length
    const next = tabs[wrapped]
    if (next === undefined) return
    void activate(next)
    // 焦点跟着走（roving tabindex）：无论激活是否成功，键盘焦点都该停在这一项上
    findTabNode(stripRef.current, next)?.focus()
  }

  const onAuxClick = (event: ReactMouseEvent<HTMLDivElement>, relPath: string): void => {
    if (event.button !== 1) return // 只有中键
    event.preventDefault()
    void closeTab(relPath)
  }

  /**
   * 「在文件树中定位」：把那一行选中并滚进视野。
   *
   * 文件树可能正被收起（`Ctrl+B`）或已经被拖到别的停靠区 —— 所以先确保它可见，
   * 再走既有的"选中 + 逐个展开祖先"链路（`vault-store` 的 `select` / `revealPath`），
   * 最后发一条滚动事件（文件树是虚拟列表，滚动到某一行是它自己的知识）。
   */
  const revealInTree = (relPath: string): void => {
    if (!useUiStore.getState().sidebarVisible) useUiStore.getState().toggleSidebar()
    const vault = useVaultStore.getState()
    vault.revealPath(relPath)
    vault.select(relPath)
    window.dispatchEvent(new CustomEvent(REVEAL_ROW_EVENT, { detail: { relPath } }))
  }

  const menuItems = (relPath: string): ContextMenuItem[] => [
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

  return (
    <div className="mn-tabs" role="tablist" aria-label="打开的笔记" ref={stripRef}>
      {tabs.map((relPath, index) => {
        const isActive = relPath === activeRelPath
        // 未保存状态只有当前文档可能有（note-store 只持有一份），所以标记只出现在激活标签上
        const mark: TabMark | null = !isActive
          ? null
          : conflicted
            ? 'conflict'
            : dirty
              ? 'dirty'
              : null
        const statusSuffix = mark === 'conflict' ? '（冲突）' : mark === 'dirty' ? '（未保存）' : ''

        return (
          <div
            key={relPath}
            className={isActive ? 'mn-tabs__tab mn-tabs__tab--active' : 'mn-tabs__tab'}
            role="tab"
            aria-selected={isActive}
            // roving tabindex：Tab 键只落在当前标签上，进入后用 ←/→ 走
            tabIndex={isActive || (activeRelPath === null && index === 0) ? 0 : -1}
            data-tab-path={relPath}
            title={`${relPath}${statusSuffix}`}
            aria-label={`${relPath}${statusSuffix}`}
            onClick={() => void activate(relPath)}
            onKeyDown={(event) => onKeyDown(event, index, relPath)}
            onAuxClick={(event) => onAuxClick(event, relPath)}
            onContextMenu={(event) => {
              event.preventDefault()
              setMenu({ relPath, x: event.clientX, y: event.clientY })
            }}
            // 中键默认会触发自动滚动，先挡掉
            onMouseDown={(event) => {
              if (event.button === 1) event.preventDefault()
            }}
          >
            <span className="mn-tabs__label">{displayName(relPath)}</span>
            {mark !== null && (
              <span
                className={`mn-tabs__mark mn-tabs__mark--${mark}`}
                title={MARK_TITLE[mark]}
                aria-hidden="true"
              >
                {mark === 'conflict' ? <Icon name="alert" size={11} /> : '●'}
              </span>
            )}
            <button
              type="button"
              className="mn-tabs__close"
              aria-label={`关闭 ${relPath}`}
              title="关闭（Ctrl+W 关闭当前标签）"
              onClick={(event) => {
                // 不要让点击穿透到标签本身（那会先切过去再关掉，白读一次盘）
                event.stopPropagation()
                void closeTab(relPath)
              }}
            >
              <Icon name="x" size={11} />
            </button>
          </div>
        )
      })}
      {menu !== null && (
        <ContextMenu
          items={menuItems(menu.relPath)}
          x={menu.x}
          y={menu.y}
          ariaLabel={`${basename(menu.relPath)} 标签的操作菜单`}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

/** 按 `data-tab-path` 找标签节点（不使用属性选择器，避免路径里的特殊字符需要转义）。 */
function findTabNode(root: HTMLElement | null, relPath: string): HTMLElement | null {
  if (root === null) return null
  for (const node of root.querySelectorAll<HTMLElement>('[data-tab-path]')) {
    if (node.dataset.tabPath === relPath) return node
  }
  return null
}
