/**
 * 「移动到…」对话框的状态（**唯一**的"移动框是否开着"的事实来源）。
 *
 * 与 `rename-store` 是同一套写法的两个实例：拖拽之外的**键盘路径**必须存在
 * （纯拖拽对键盘用户不可用），而对话框需要"打开/关闭"这个结果被别的模块只读地观察到
 * （面板的全局按键在它开着时不该再叠一层命令面板）。
 *
 * 为什么与重命名分成两个 store 而不是合并成一个"工程对话框"：两者的**目标**不同 ——
 * 重命名填的是文件名，移动选的是目录；合并以后每个消费者都要先判断"这个 target 现在
 * 表示文件名还是目录"，那正是最容易写错的地方（判错的代价是改错文件位置）。
 */

import { create } from 'zustand'

interface MoveState {
  /** 正在移动的笔记相对路径；`null` = 对话框关闭。 */
  target: string | null
  /** 打开移动框（命令面板 / 文件树按键 / 菜单都走这里）。 */
  open: (relPath: string) => void
  close: () => void
}

export const useMoveStore = create<MoveState>((set) => ({
  target: null,

  open: (relPath) => {
    set({ target: relPath })
  },

  close: () => {
    set({ target: null })
  },
}))
