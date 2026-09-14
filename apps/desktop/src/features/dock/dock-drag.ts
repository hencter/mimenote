/**
 * 正在被拖动的那块停靠模块（**瞬时状态**，不持久化）。
 *
 * 为什么需要一个"全局"的拖动状态：拖拽的起点在 A 停靠区的标题头上，终点可能在 B 停靠区 ——
 * 两个组件之间没有父子关系，`dataTransfer.getData()` 在 `dragover` 阶段又**读不到值**
 * （浏览器的安全限制：只有 `drop` 时才给数据）。HTML5 拖拽因此必须把"正在拖谁"记在两边都看得到
 * 的地方，`dragover` 才能画出正确的落点、空停靠区才知道自己该变成一条可放的轨道。
 *
 * 为什么用 zustand 而不是模块级变量 + 事件：落点提示与"空区轨道"都要在拖动**过程中**重渲染，
 * 而模块级变量不会触发 React 更新（真实踩过：指示条要等下一次别的更新才出现）。
 * 它刻意不进 `ui-store`：那是"用户偏好"，而这是"手正在做什么"，重启后不该存在。
 */

import { create } from 'zustand'

import type { DockModuleId } from './dock-layout'

interface DockDragState {
  /** 正在拖的模块；`null` = 没有拖动。 */
  dragging: DockModuleId | null
  begin: (id: DockModuleId) => void
  end: () => void
}

export const useDockDrag = create<DockDragState>((set) => ({
  dragging: null,
  begin: (id) => set({ dragging: id }),
  end: () => set({ dragging: null }),
}))
