/**
 * 任务列表的勾选切换。
 *
 * 为什么是"写回文档"而不是"只改显示"：复选框代表的是**文件里的** `- [ ]`。
 * 点击 = 编辑内容，于是它自动走既有的变更通道（`updateListener` → `note-store.setText`
 * → 防抖保存 → 原子写 + mtime 冲突保护），不需要为它开任何新的写路径。
 */

import type { ChangeSpec, EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

const MARKER = /^\[([ xX])\]$/
const MARKER_IN_LINE = /\[[ xX]\]/

/**
 * 把位置 `markerFrom` 处的任务标记取反，返回变更描述；不是合法任务标记时返回 `null`。
 *
 * 纯函数：只读 `EditorState`，不派发事务 —— 这样"在哪切、切成什么"可以在 jsdom 里逐条钉死。
 */
export function toggleTaskChange(state: EditorState, markerFrom: number): ChangeSpec | null {
  const doc = state.doc
  if (!Number.isFinite(markerFrom) || markerFrom < 0 || markerFrom + 3 > doc.length) return null
  const marker = doc.sliceString(markerFrom, markerFrom + 3)
  const match = MARKER.exec(marker)
  if (match === null) return null
  const checked = (match[1] ?? ' ').toLowerCase() === 'x'
  return { from: markerFrom, to: markerFrom + 3, insert: checked ? '[ ]' : '[x]' }
}

/**
 * 位置可能因为"装饰还没跟上的一次编辑"而漂移：退一步在**同一行**里再找一次任务标记。
 *
 * 找不到就返回 `null`（什么都不改）—— 宁可点不动，也不能把别的字符改掉。
 */
export function taskChangeNear(state: EditorState, markerFrom: number): ChangeSpec | null {
  const direct = toggleTaskChange(state, markerFrom)
  if (direct !== null) return direct
  if (state.doc.length === 0) return null

  const pos = Math.min(Math.max(markerFrom, 0), state.doc.length)
  const line = state.doc.lineAt(pos)
  const at = MARKER_IN_LINE.exec(line.text)?.index
  if (at === undefined) return null
  return toggleTaskChange(state, line.from + at)
}

/** 点击复选框的命令：派发一次普通变更（因此会被保存流水线看见）。 */
export function toggleTaskAt(view: EditorView, markerFrom: number): boolean {
  const change = taskChangeNear(view.state, markerFrom)
  if (change === null) return false
  view.dispatch({ changes: change })
  return true
}
