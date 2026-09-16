/**
 * 正在被拖动的那个标签（**瞬时状态**，不持久化）。
 *
 * 与旧 `features/dock/dock-drag.ts` 同一个存在理由，只是被拖的东西从"视图模块"
 * 推广成了任意标签（模块或笔记）：拖拽的起点在 A 格的标签条上，终点可能在 B 格 ——
 * 两个组件之间没有父子关系，`dataTransfer.getData()` 在 `dragover` 阶段又**读不到值**
 * （浏览器的安全限制：只有 `drop` 时才给数据）。HTML5 拖拽因此必须把"正在拖谁"记在
 * 两边都看得到的地方，`dragover` 才能画出正确的落点提示。
 *
 * 用 zustand 而不是模块级变量：落点提示要在拖动**过程中**重渲染，模块级变量不会触发
 * React 更新。它刻意不进 `ui-store`：那是"用户偏好"，而这是"手正在做什么"，重启后不该存在。
 */

import { create } from 'zustand'

import type { LayoutItemId } from './tree-layout'

interface LayoutDragState {
  /** 正在拖的标签；`null` = 没有拖动。 */
  dragging: LayoutItemId | null
  begin: (item: LayoutItemId) => void
  end: () => void
}

export const useLayoutDrag = create<LayoutDragState>((set) => ({
  dragging: null,
  begin: (item) => set({ dragging: item }),
  end: () => set({ dragging: null }),
}))
