/**
 * 两种文件树画法（单栏 / 分栏）共用的视图契约。
 *
 * 放在一个单独的小模块里，是为了让 `FileTree.tsx`（容器）与两个视图之间**只有一份**
 * 接口定义：容器负责状态与动作（过滤推导、标签过滤、选中、打开、拖拽、右键菜单），
 * 视图只负责"把行画在哪儿、滚到哪儿"。
 *
 * 键盘处理**留在容器**：那些键要同时管"选中项、展开状态、分栏的列链"，
 * 判据只应有一处（`domain/columns.ts` 与 `FileTree` 的 `handleKeyDown`）。
 * 视图把它挂在自己那个可聚焦的根元素上。
 */

import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

import type { RowRef } from './TreeRow'

/** 视图可以命令容器做的事（都作用在 `selected` 上，与模式无关）。 */
export interface TreeViewHandle {
  /**
   * 把某个路径滚进可视区（`REVEAL_ROW_EVENT`）。
   *
   * 返回是否真的找到并滚动了：找不到（被过滤掉 / 不在条目表里）时调用方照样要给出别的反馈，
   * 而"悄悄什么都没发生"是定位功能最差的失败方式。
   */
  reveal: (relPath: string) => boolean
}

export interface TreeViewProps {
  /** 当前选中项（`vault-store.selected`）。 */
  selected: string | null
  /**
   * 当前有过滤生效（文本或标签）—— 此时子行是**自动展开**的，三角必须跟着说同一件事。
   * 见 `FileTree` 里 `autoExpanded` 的注释。
   */
  autoExpanded: boolean
  onActivate: (row: RowRef, newTab: boolean) => void
  onContextMenu: (row: RowRef, event: React.MouseEvent<HTMLDivElement>) => void
  /** 容器的键盘处理（判据只有一处，见文件头）。 */
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void
}
