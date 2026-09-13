/**
 * 重命名对话框的状态（**唯一**的"改名框是否开着"的事实来源）。
 *
 * 为什么从组件内 state 提出来：
 * - 别的模态层需要知道它开着 —— 面板的全局按键（`use-palette-hotkeys.ts`）在改名框
 *   打开时不应该再叠一层命令面板上去；
 * - 状态提出去以后，触发方式仍然是一次性 DOM 事件（`requestRename`），
 *   只是"打开/关闭"这个结果落在 store 里，别的模块可以只读地观察到它。
 *
 * 与 `confirm-store` 的区别：改名框不需要 Promise 化（调用方不等结果，
 * 成功与否由 `renameNote` 自己 toast），所以这里只是一个可读写的目标路径。
 */

import { create } from 'zustand'

interface RenameState {
  /** 正在改名的笔记相对路径；`null` = 对话框关闭。 */
  target: string | null
  /** 打开改名框（键盘/工具栏/命令面板都走这里）。 */
  open: (relPath: string) => void
  close: () => void
}

export const useRenameStore = create<RenameState>((set) => ({
  target: null,

  open: (relPath) => {
    set({ target: relPath })
  },

  close: () => {
    set({ target: null })
  },
}))
