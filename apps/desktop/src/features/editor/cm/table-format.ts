/**
 * 表格格式化在编辑器里的接线（命令 + 光标位置保持）。
 *
 * 与 `list-input.ts` 同一套思路：真正"文档会变成什么样"的逻辑在 `domain/table-format.ts`
 * （纯函数、可单测），这里只负责三件事：把光标所在行喂给它、把结果派发成**一次**事务、
 * 以及把光标放回**原来那个单元格**里的同一个字符位置。
 *
 * 光标为什么按"单元格内容里的字符偏移"记账：格式化只改空白与竖线位置、不改内容，
 * 因此这个坐标是格式化前后唯一稳定、且不受 CJK 宽度影响的东西。
 */

import type { EditorState } from '@codemirror/state'
import type { Command, EditorView } from '@codemirror/view'

import { findTableBlock, formatTable, parseRowCells } from '@/domain/table-format'

/** 光标在表格里的位置：第几行、第几列、以及单元格内容内的字符偏移。 */
interface CellAnchor {
  row: number
  column: number
  offset: number
}

/** 把文档位置换算成"表格里的坐标"（不在表格里返回 `null`）。 */
export function cellAnchorAt(state: EditorState, pos: number): CellAnchor | null {
  const line = state.doc.lineAt(pos)
  const lines = Array.from({ length: state.doc.lines }, (_, index) => state.doc.line(index + 1).text)
  const block = findTableBlock(lines, line.number - 1)
  if (block === null) return null

  const row = line.number - 1 - block.start
  const cells = parseRowCells(line.text)
  const offsetInLine = pos - line.from

  for (let column = 0; column < cells.length; column += 1) {
    const cell = cells[column]
    if (cell === undefined) continue
    // 落在这一格里（含紧邻的分隔空白）：把偏差夹进内容范围
    if (offsetInLine <= cell.end || column === cells.length - 1) {
      return { row, column, offset: Math.max(0, Math.min(offsetInLine - cell.start, cell.text.length)) }
    }
  }
  return { row, column: 0, offset: 0 }
}

/**
 * 命令：格式化光标所在的表格。
 *
 * 返回 `false`（什么都不做）的三种情况：不是表格、有选区、或结果与原文逐字相同 ——
 * 最后一种刻意**不派发事务**，否则每次按都会多一条"看起来没变化"的撤销步骤。
 */
export const formatTableCommand: Command = (view: EditorView): boolean => {
  const state = view.state
  const cursor = state.selection.main
  if (!cursor.empty) return false

  const anchor = cellAnchorAt(state, cursor.head)
  if (anchor === null) return false

  const lines = Array.from({ length: state.doc.lines }, (_, index) => state.doc.line(index + 1).text)
  const block = findTableBlock(lines, state.doc.lineAt(cursor.head).number - 1)
  if (block === null) return false

  const formatted = formatTable(block)
  const before = lines.slice(block.start, block.end + 1)
  if (formatted.every((line, index) => line === before[index])) return false

  const from = state.doc.line(block.start + 1).from
  const to = state.doc.line(block.end + 1).to
  const rowStart =
    from + formatted.slice(0, anchor.row).reduce((sum, line) => sum + line.length + 1, 0)
  const rowText = formatted[anchor.row] ?? ''

  // 光标放回同一格里的同一处（内容没变，只是两边的空白变了）
  const cell = parseRowCells(rowText)[anchor.column]
  const nextPos =
    cell === undefined ? rowStart : rowStart + cell.start + Math.min(anchor.offset, cell.text.length)

  view.dispatch({
    changes: { from, to, insert: formatted.join('\n') },
    selection: { anchor: Math.min(nextPos, rowStart + rowText.length) },
    // 格式化是一次"重排"：与相邻输入合成一个撤销步骤（与列表续行同一取舍）
    userEvent: 'input.format',
    scrollIntoView: true,
  })
  return true
}
