// @vitest-environment jsdom
/**
 * Markdown 表格格式化（`domain/table-format.ts` + 编辑器命令）。
 *
 * 分两层，与 `tests/editor-input.test.tsx` 同一思路：
 * 1. **纯函数**：解析（转义竖线、省略首尾竖线、分隔行判定）与格式化（列宽、对齐、CJK 宽度）；
 * 2. **编辑器命令**：一次事务、光标留在原来那个单元格里、"不是表格/已对齐"时**不**派发事务。
 *
 * 最要紧的两条不变式：
 * - **幂等**：格式化过的表格再格式化一次，输出必须逐字相同（否则每次保存都带上无意义 diff）；
 * - **不动内容**：无论怎么格式化，单元格文字本身一个字符都不能变。
 */

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { registerBuiltinCommands } from '@/app/builtin-commands'
import { commands } from '@/app/commands'
import {
  displayWidth,
  findTableBlock,
  formatTable,
  formatTableAt,
  isDelimiterRow,
  isTableRow,
  parseRowCells,
  splitRow,
} from '@/domain/table-format'
import { MarkdownEditor } from '@/features/editor/MarkdownEditor'
import { cellAnchorAt, formatTableCommand } from '@/features/editor/cm/table-format'
import { createEditorExtensions } from '@/features/editor/cm/setup'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter, MOCK_VAULT_PATH } from '@/ipc/mock-adapter'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { useVaultStore } from '@/state/vault-store'

/** 造一个真编辑器（与 `editor-input.test.tsx` 的装配方式一致）。 */
const views: EditorView[] = []

function mount(doc: string, cursor: number): EditorView {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, extensions: createEditorExtensions({}, true) }),
  })
  view.dispatch({ selection: { anchor: cursor } })
  views.push(view)
  return view
}

function textAt(doc: string, needle: string): number {
  const index = doc.indexOf(needle)
  if (index === -1) throw new Error(`文档里没有：${needle}`)
  return index + needle.length
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  cleanup()
  document.body.innerHTML = ''
})

beforeEach(() => {
  setIpcAdapter(createMockAdapter())
  useNoteStore.getState().close()
  useLinksStore.getState().clear()
  useVaultStore.setState({ status: 'idle', info: null, entries: [], tree: [], selected: null })
})

describe('解析', () => {
  it('识别表格行与分隔行（省略首尾竖线的写法也算）', () => {
    expect(isTableRow('| 甲 | 乙 |')).toBe(true)
    expect(isTableRow('甲 | 乙')).toBe(true)
    expect(isTableRow('普通正文')).toBe(false)
    expect(isTableRow('')).toBe(false)

    expect(isDelimiterRow('| --- | --- |')).toBe(true)
    expect(isDelimiterRow('|---|:--:|')).toBe(true)
    expect(isDelimiterRow('| --- | 乙 |')).toBe(false)
  })

  it('切分单元格：转义竖线属于内容，不算分隔符', () => {
    expect(splitRow('| 甲 | 乙 |')).toEqual(['甲', '乙'])
    expect(splitRow('甲 | 乙')).toEqual(['甲', '乙'])
    expect(splitRow('| 含 \\| 竖线 | 乙 |')).toEqual(['含 \\| 竖线', '乙'])
  })

  it('给出每个单元格内容在本行里的字符范围（供光标回位用）', () => {
    const cells = parseRowCells('|  甲  | 乙 |')
    expect(cells.map((cell) => cell.text)).toEqual(['甲', '乙'])
    // 第一格内容 "甲" 在第 3 个字符（`|`、两个空格之后）
    expect(cells[0]?.start).toBe(3)
    expect(cells[0]?.end).toBe(4)
  })

  it('从光标所在行扩展出一整块表格；不在表格里返回 null', () => {
    const lines = ['前言', '', '| 甲 | 乙 |', '| --- | --- |', '| 1 | 2 |', '', '尾巴']
    const block = findTableBlock(lines, 3)
    expect(block).not.toBeNull()
    expect(block?.start).toBe(2)
    expect(block?.end).toBe(4)
    expect(block?.rows).toHaveLength(3)

    // 光标在表格紧邻的空行上也算"在表格里"（刚在表后面回车就按格式化是最常见的场景）
    expect(findTableBlock(lines, 5)?.start).toBe(2)
    expect(findTableBlock(lines, 0)).toBeNull()
    // 只有一行含竖线的普通文本不是表格
    expect(findTableBlock(['甲 | 乙'], 1)).toBeNull()
  })
})

describe('格式化', () => {
  it('按显示宽度对齐：CJK 算两列，竖线严格对齐', () => {
    const text = ['| 名称 | 说明 |', '| --- | --- |', '| 甲 | short |', '| 项目名称 | 更长的中文说明文字 |'].join(
      '\n',
    )
    const formatted = formatTableAt(text, 0)
    expect(formatted).not.toBeNull()
    const lines = (formatted ?? '').split('\n')

    // 每一行的竖线位置完全一致（这就是这个功能存在的意义）
    const pipes = lines.map((line) =>
      Array.from(line)
        .map((char, index) => (char === '|' ? index : -1))
        .filter((index) => index >= 0),
    )
    const widths = lines.map((line) => displayWidth(line))
    expect(Array.from(new Set(widths))).toHaveLength(1)
    for (const row of pipes) {
      expect(row).toHaveLength(pipes[0]?.length ?? 0)
    }

    // 内容一个字符都没变
    const cells = lines.map((line) => splitRow(line))
    expect(cells[0]).toEqual(['名称', '说明'])
    expect(cells[2]).toEqual(['甲', 'short'])
    expect(cells[3]).toEqual(['项目名称', '更长的中文说明文字'])
  })

  it('保留对齐方式（左 / 居中 / 右）并按它补空白', () => {
    const text = ['| 甲 | 乙 | 丙 |', '| :--- | :---: | ---: |', '| 1 | 22 | 333 |'].join('\n')
    const formatted = formatTableAt(text, 0)
    const lines = (formatted ?? '').split('\n')

    // 分隔行按列宽重建：左对齐全是减号、居中两侧冒号、右对齐尾部冒号
    // （列宽至少 3 —— 居中的 `:-:` 也需要放得下一个减号）
    expect(lines[1]).toBe('| --- | :-: | --: |')
    // 居中：`22` 两边补的空格数量差不超过 1；右对齐：内容贴右
    expect(lines[2]?.endsWith('333 |')).toBe(true)
    expect(lines[2]).toContain(' 22 ')
    // 三行的显示宽度完全一致（这才是"对齐"）
    expect(Array.from(new Set(lines.map((line) => displayWidth(line))))).toHaveLength(1)
  })

  it('幂等：格式化两次的结果逐字相同', () => {
    const messy = ['|甲|乙|', '|---|---|', '|1|2|'].join('\n')
    const once = formatTableAt(messy, 0)
    expect(once).not.toBeNull()
    const twice = formatTableAt(once ?? '', 0)
    // 第二次应当**没有任何改动**（返回 null = 不需要派发事务）
    expect(twice).toBeNull()
  })

  it('行数不齐：少列补空、多列保留（整块按最宽的那一行统一列数）', () => {
    const text = ['| 甲 | 乙 | 丙 |', '| --- | --- | --- |', '| 1 |', '| 1 | 2 | 3 | 4 |'].join('\n')
    const formatted = formatTableAt(text, 0)
    const lines = (formatted ?? '').split('\n')
    // 这块表格实际有 4 列（最后一行写了 4 个），因此少列的那一行补两个空格
    expect(splitRow(lines[2] ?? '')).toEqual(['1', '', '', ''])
    expect(splitRow(lines[3] ?? '')).toEqual(['1', '2', '3', '4'])
    expect(Array.from(new Set(lines.map((line) => displayWidth(line))))).toHaveLength(1)
  })

  it('表格之外一个字符都不动', () => {
    const text = ['# 标题', '', '| 甲 | 乙 |', '| --- | --- |', '| 1 | 2 |', '', '结尾段落'].join('\n')
    const formatted = formatTableAt(text, 2)
    const lines = (formatted ?? '').split('\n')
    expect(lines[0]).toBe('# 标题')
    expect(lines[6]).toBe('结尾段落')
    // 表格本身重排了（列宽至少 3：`---` 要放得下），但**内容**没变
    expect(splitRow(lines[2] ?? '')).toEqual(['甲', '乙'])
    expect(splitRow(lines[4] ?? '')).toEqual(['1', '2'])
    expect(lines[3]).toBe('| --- | --- |')
  })

  it('不是表格时返回 null（调用方据此不派发事务）', () => {
    expect(formatTableAt('普通正文\n不带表格', 0)).toBeNull()
    expect(formatTableAt('', 0)).toBeNull()
  })

  it('formatTable 单独可用（表格块 → 各行）', () => {
    const block = findTableBlock(['| a | b |', '| --- | --- |', '| 1 | 2 |'], 0)
    expect(block).not.toBeNull()
    expect(formatTable(block as NonNullable<typeof block>)[0]).toBe('| a   | b   |')
  })
})

describe('编辑器命令', () => {
  const doc = ['| 名称 | 说明 |', '| --- | --- |', '| 甲 | short |'].join('\n')

  it('按一次就把表格对齐，光标仍在原来那一格', () => {
    const view = mount(doc, textAt(doc, '甲'))
    const anchorBefore = cellAnchorAt(view.state, view.state.selection.main.head)
    expect(anchorBefore).not.toBeNull()

    const handled = formatTableCommand(view)
    expect(handled).toBe(true)

    const lines = view.state.doc.toString().split('\n')
    expect(lines[0]).toBe('| 名称 | 说明  |')
    expect(Array.from(new Set(lines.map((line) => displayWidth(line))))).toHaveLength(1)

    // 光标还在第一列的内容里（这一格是 "甲"）
    const anchorAfter = cellAnchorAt(view.state, view.state.selection.main.head)
    expect(anchorAfter?.row).toBe(anchorBefore?.row)
    expect(anchorAfter?.column).toBe(anchorBefore?.column)
    const line = view.state.doc.lineAt(view.state.selection.main.head)
    expect(line.text).toContain('甲')
  })

  it('已经对齐的表格：不派发事务（不留"没变化"的撤销步骤）', () => {
    const aligned = ['| a   | b   |', '| --- | --- |', '| 1   | 2   |'].join('\n')
    const view = mount(aligned, textAt(aligned, '1'))
    const before = view.state.doc.toString()

    expect(formatTableCommand(view)).toBe(false)
    expect(view.state.doc.toString()).toBe(before)
  })

  it('不是表格 / 有选区时什么都不做', () => {
    const plain = '普通正文'
    const view = mount(plain, plain.length)
    expect(formatTableCommand(view)).toBe(false)

    const selected = mount(doc, 0)
    selected.dispatch({ selection: { anchor: 0, head: 5 } })
    expect(formatTableCommand(selected)).toBe(false)
    expect(selected.state.doc.toString()).toBe(doc)
  })

  it('单元格里的转义竖线不会被当成新列（格式化后内容仍然完整）', () => {
    const withEscape = ['| 甲 \\| 乙 | 说明 |', '| --- | --- |', '| 1 | 2 |'].join('\n')
    const view = mount(withEscape, textAt(withEscape, '1'))
    expect(formatTableCommand(view)).toBe(true)
    expect(view.state.doc.toString()).toContain('甲 \\| 乙')
    expect(splitRow(view.state.doc.line(1).text)).toEqual(['甲 \\| 乙', '说明'])
  })
})

describe('命令表接线', () => {
  it('Mod+Alt+F 指向 `note.formatTable`，执行后编辑器里的表格真的对齐了', async () => {
    const dispose = registerBuiltinCommands()
    try {
      render(<MarkdownEditor />)
      await act(async () => {
        await useVaultStore.getState().openVault(MOCK_VAULT_PATH)
      })
      await act(async () => {
        await useNoteStore.getState().open('项目/设计.md')
      })

      const view = EditorView.findFromDOM(
        document.querySelector<HTMLElement>('.cm-editor') as HTMLElement,
      )
      expect(view).not.toBeNull()
      const editor = view as EditorView

      // 把光标放进 mock 笔记里的那张表格（含 `层` / `职责` 两列）
      const doc = editor.state.doc
      let tableLine = 0
      for (let number = 1; number <= doc.lines; number += 1) {
        if (doc.line(number).text.includes('文件层')) {
          tableLine = number
          break
        }
      }
      expect(tableLine).toBeGreaterThan(0)
      await act(async () => {
        editor.dispatch({ selection: { anchor: doc.line(tableLine).from + 4 } })
      })

      expect(commands.byChord('Mod+Alt+F')[0]?.id).toBe('note.formatTable')
      await act(async () => {
        await commands.execute('note.formatTable')
      })

      // 表格块（含分隔行）每一行的显示宽度一致 = 对齐
      const lines = editor.state.doc.toString().split('\n')
      const start = lines.findIndex((line) => line.includes('| 层 |') || line.includes('| 层'))
      const block = lines.slice(start, start + 4).filter((line) => line.includes('|'))
      expect(block.length).toBeGreaterThanOrEqual(3)
      expect(Array.from(new Set(block.map((line) => displayWidth(line))))).toHaveLength(1)
    } finally {
      dispose()
    }
  })
})
