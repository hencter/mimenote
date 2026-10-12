/**
 * 行内格式的开关（加粗 / 斜体 / 行内代码 / 删除线 / 链接）—— ADR-0055 的"编辑器手感"部分。
 *
 * 为什么这件事必须有：在 Live Preview（ADR-0009）里 `**重点**` 会被渲染成粗体，
 * 但**没有任何一条命令能把它加上去** —— 用户只能自己敲两个星号再移动光标。
 * 而 `Mod+B` 此前绑在"显示/隐藏侧栏"上（任何编辑器里它都是加粗），
 * 于是手上最顺的那个键做了最不相干的事。这里补上真正的格式化动作，键位见
 * `app/builtin-commands.ts`（命令表是快捷键的唯一事实来源）。
 *
 * 实现纪律：
 * - **切换语义**（toggle）：对已经带标记的选区再按一次要能摘掉它，否则"加粗"只能加不能减，
 *   用户会开始手工删星号 —— 那正是这个功能想消灭的动作；
 * - **一次撤销**：整个包裹/摘除是**一个**事务（`userEvent: 'input.format'`），
 *   与列表续行、表格格式化同一取舍 —— 撤销一次回到按键之前，不是"撤销两次才干净"；
 * - **多选区**：走 CodeMirror 的 `changeByRange`，每个选区各自包裹，
 *   而不是只处理 `state.selection.main`（多光标下"只有主选区生效"是很怪的半截行为）。
 */

import { EditorSelection } from '@codemirror/state'
import type { ChangeSpec, EditorState, SelectionRange } from '@codemirror/state'
import type { Command, EditorView } from '@codemirror/view'

/** 行内标记：`marker` 是包裹用的字符序列。 */
export interface InlineMark {
  readonly marker: string
  readonly label: string
}

export const INLINE_MARKS = {
  bold: { marker: '**', label: '加粗' },
  italic: { marker: '*', label: '斜体' },
  code: { marker: '`', label: '行内代码' },
  strike: { marker: '~~', label: '删除线' },
} as const satisfies Record<string, InlineMark>

export type InlineMarkName = keyof typeof INLINE_MARKS

/** 命令：切换某个行内标记（`Mod+B` / `Mod+I` / `Mod+Shift+K` / `Mod+Shift+X`）。 */
export function toggleInlineMarkCommand(name: InlineMarkName): Command {
  const { marker } = INLINE_MARKS[name]
  return (view: EditorView): boolean => {
    // 空光标 + 两侧已经是标记（`**|**`）：这是"插进去了但还没写字"的标准形态，
    // 再按一次该**摘掉**它，而不是又插一层（否则会得到 `****|****`）
    const spec = view.state.changeByRange((range) => toggleAtRange(view.state, range, marker))
    if (spec.changes.empty) return false
    view.dispatch({
      changes: spec.changes,
      selection: spec.selection,
      userEvent: 'input.format',
      scrollIntoView: true,
    })
    return true
  }
}

/**
 * 单个选区上的切换结果。
 *
 * 三种情形：
 * 1. 选区**含**标记（用户框选了 `**粗**`）→ 摘掉紧贴选区的标记；
 * 2. 选区**被**标记夹住（`**|粗|**`，或空光标正好落在 `**|**` 之间）→ 摘掉两侧；
 * 3. 其余 → 包裹选区；空光标时插入成对标记并把光标放到中间。
 */
function toggleAtRange(
  state: EditorState,
  range: SelectionRange,
  marker: string,
): { changes: ChangeSpec; range: SelectionRange } {
  const length = marker.length
  const before = state.sliceDoc(Math.max(0, range.from - length), range.from)
  const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + length))
  const selected = state.sliceDoc(range.from, range.to)

  // 情形 1：标记在选区**内部**的两端
  if (selected.length >= length * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
    const inner = selected.slice(length, selected.length - length)
    return {
      changes: { from: range.from, to: range.to, insert: inner },
      range: EditorSelection.range(range.from, range.from + inner.length),
    }
  }

  // 情形 2：标记紧贴选区外侧
  if (before === marker && after === marker) {
    return {
      changes: [
        { from: range.from - length, to: range.from },
        { from: range.to, to: range.to + length },
      ],
      range: EditorSelection.range(range.from - length, range.to - length),
    }
  }

  // 情形 3：包裹
  return {
    changes: { from: range.from, to: range.to, insert: `${marker}${selected}${marker}` },
    range: EditorSelection.range(range.from + length, range.to + length),
  }
}

/**
 * 命令：插入 Markdown 链接。
 *
 * 三种情形（与 Obsidian 的心智一致）：
 * - 有选区且选区**已经是链接** `[文字](地址)` → 摘成纯文字（切换语义）；
 * - 有选区 → `[文字](|)`，光标落在括号里等用户粘地址（最常走的路径）；
 * - 空光标 → `[](|)`，光标落在方括号里等用户写文字。
 *
 * **不读剪贴板**：`navigator.clipboard.readText()` 是异步且需要权限的，
 * 在"按键 → 立刻改文档"这条路上引入一次不可预测的等待，比"光标已经等在那里"差得多。
 * 需要"粘 URL 自动成链接"的场景由既有的 `pasteURLAsLink`（`@codemirror/lang-markdown`）
 * 负责 —— 那边发生在**粘贴事件**上，语义天然正确。
 */
export const insertLinkCommand: Command = (view: EditorView): boolean => {
  const spec = view.state.changeByRange((range) => insertLinkAtRange(view.state, range))
  if (spec.changes.empty) return false
  view.dispatch({
    changes: spec.changes,
    selection: spec.selection,
    userEvent: 'input.format',
    scrollIntoView: true,
  })
  return true
}

function insertLinkAtRange(
  state: EditorState,
  range: SelectionRange,
): { changes: ChangeSpec; range: SelectionRange } {
  const selected = state.sliceDoc(range.from, range.to)
  const existing = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(selected)
  if (existing !== null && existing[1] !== undefined) {
    const text = existing[1]
    return {
      changes: { from: range.from, to: range.to, insert: text },
      range: EditorSelection.range(range.from, range.from + text.length),
    }
  }

  if (selected !== '') {
    const insert = `[${selected}]()`
    // 光标落在括号内：`[文字](|)`
    const caret = range.from + insert.length - 1
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(caret, caret),
    }
  }

  return {
    changes: { from: range.from, insert: '[]()' },
    // 光标落在方括号内：`[|]()`
    range: EditorSelection.range(range.from + 1, range.from + 1),
  }
}
