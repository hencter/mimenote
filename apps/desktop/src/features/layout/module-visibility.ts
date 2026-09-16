/**
 * 视图模块的**可见性**：唯一真相在各自的既有开关上（ADR-0026 定下的分工，树模型原样继承）。
 *
 * - 文件树 = `ui-store.sidebarVisible`（`Ctrl+B`）
 * - 链接 = `ui-store.linksPanelVisible`（`Ctrl+Shift+L`）
 * - 标签 = `tags-store.open`（`Ctrl+Shift+T`）
 * - 大纲 = `ui-store.outlinePanelVisible`（`Ctrl+Shift+O`）
 *
 * 布局树只管"谁在哪一格"，**不管**"它开着没"——所以"隐藏 ≠ 移除"：
 * 隐藏时渲染层把那一格收缩掉，树里什么都没变，再打开就回原位（见 `layout-sync.ts` 文件头）。
 * 这个模块只做两件事：把四个开关汇成一张表（渲染层用），以及"隐藏一个模块"
 * 仍然走那条与它快捷键**完全同一个**的动作（菜单、标签上的 ×、快捷键因此永远一致）。
 */

import { useTagsStore } from '@/state/tags-store'
import { useUiStore } from '@/state/ui-store'
import type { ViewModuleId } from './tree-layout'

/** 四个模块此刻的可见性（React 订阅版：四个开关都订，变化即重渲染）。 */
export function useModuleVisibility(): Record<ViewModuleId, boolean> {
  const sidebarVisible = useUiStore((state) => state.sidebarVisible)
  const linksPanelVisible = useUiStore((state) => state.linksPanelVisible)
  const outlinePanelVisible = useUiStore((state) => state.outlinePanelVisible)
  const tagsOpen = useTagsStore((state) => state.open)
  return {
    tree: sidebarVisible,
    links: linksPanelVisible,
    tags: tagsOpen,
    outline: outlinePanelVisible,
  }
}

/** 非 React 环境（命令、菜单回调）里读同一张表。 */
export function moduleVisible(id: ViewModuleId): boolean {
  const ui = useUiStore.getState()
  switch (id) {
    case 'tree':
      return ui.sidebarVisible
    case 'links':
      return ui.linksPanelVisible
    case 'outline':
      return ui.outlinePanelVisible
    case 'tags':
      return useTagsStore.getState().open
  }
}

/**
 * 隐藏一个模块：走它自己的那条开关（与快捷键等价）。
 *
 * 为什么不是"从树上摘掉"：摘掉会丢位置（再打开就回默认落点了），而开关只动可见性 ——
 * 这正是"隐藏 ≠ 移除"。
 */
export function hideModule(id: ViewModuleId): void {
  const ui = useUiStore.getState()
  if (id === 'tree') {
    if (ui.sidebarVisible) ui.toggleSidebar()
  } else if (id === 'links') {
    if (ui.linksPanelVisible) ui.toggleLinksPanel()
  } else if (id === 'outline') {
    if (ui.outlinePanelVisible) ui.toggleOutlinePanel()
  } else {
    const tags = useTagsStore.getState()
    if (tags.open) tags.toggle()
  }
}

/**
 * 显示一个模块（「在文件树中定位」这类"必须先让它露面"的动作用）。
 * 与 {@link hideModule} 同一条开关，只是方向相反。
 */
export function showModule(id: ViewModuleId): void {
  const ui = useUiStore.getState()
  if (id === 'tree') {
    if (!ui.sidebarVisible) ui.toggleSidebar()
  } else if (id === 'links') {
    if (!ui.linksPanelVisible) ui.toggleLinksPanel()
  } else if (id === 'outline') {
    if (!ui.outlinePanelVisible) ui.toggleOutlinePanel()
  } else {
    const tags = useTagsStore.getState()
    if (!tags.open) tags.toggle()
  }
}
