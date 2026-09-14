/**
 * 光标所在行（供大纲面板显示"当前章节"）。
 *
 * ## 为什么单独一个 store，而不是塞进 `note-store`
 * 它的更新频率是**每次光标移动**（打字、方向键、点击），而 `note-store` 里挂着自动保存流水线、
 * 冲突令牌与编辑器整篇替换的时机 —— 把高频的瞬时状态混进那个 store，等于让"每按一次方向键"
 * 都去走一遍与保存相关的订阅者。这里只有大纲面板订阅，且**只在行号真的变了**时才写入
 * （节流在编辑器装配层，见 `features/editor/cm/setup.ts` 的 `publishCursorLine`）。
 *
 * ## 为什么是"行号"而不是"哪个标题"
 * 解析标题属于 `domain/outline.ts` 的职责，这里只做搬运：store 不认识 Markdown，
 * 面板拿到行号自己算"最后一个 `line <= 光标行` 的标题"。这样"什么算标题"的口径
 * 仍然只有一处（与大纲列表本身同源）。
 */

import { create } from 'zustand'

interface CursorState {
  /** 当前光标所在行（1 起算）；没有打开的笔记或编辑器不在场时为 `null`。 */
  line: number | null
  setLine: (line: number | null) => void
}

export const useCursorStore = create<CursorState>((set) => ({
  line: null,
  setLine: (line) => {
    set({ line })
  },
}))
