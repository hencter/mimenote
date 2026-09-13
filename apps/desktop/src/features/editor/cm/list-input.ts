/**
 * Markdown 列表与缩进的**输入层**：Enter 续行 / 空项退出 / Backspace 去标记 / Tab 升降级。
 *
 * ### 为什么不直接让 `markdownKeymap` 全量接管
 * `@codemirror/lang-markdown` 的 `markdown()` 默认会装一份 `markdownKeymap`
 * （`config.addKeymap` 默认 `true`，而且是 `Prec.high`），实测它**已经**能让 Enter 续行、
 * 能让有序列表递增并顺带修正后续编号、能在引用里续 `>`。所以"Enter 什么都不做"并不成立 ——
 * 但它在两处与写笔记的手感不符，且都不可配置：
 *
 * 1. **空列表项**上按 Enter，它会走"把紧凑的两项列表改成松散列表"的分支：
 *    `- 甲\n- ` + Enter → `- 甲\n\n- `（多出一个空行），而写作直觉是**结束列表**；
 * 2. 它把 Backspace 绑给 `deleteMarkupBackward`，在"只剩标记"的行上会留下半截空白
 *    （`- 甲\n- ` → `- 甲\n  `），既不是删掉标记，也不是删掉换行。
 *
 * 于是这里把 `markdown()` 的 `addKeymap` 关掉，换成我们自己的纯函数 + 命令，并把
 * `markdownKeymap` 作为**兜底**排在后面（见 `setup.ts` 的 keymap）。分工是明确的：
 *
 * - **我们接管**：光标在列表项**整行**上的场景（续行 / 空项退出 / 去标记 / 升降级）；
 * - **让给上游**：光标在内容中间（那是"拆分这一项"）、引用行续 `>`、松散列表补空行、
 *   以及代码区间 —— 这些都原样保留既有语义。
 * - **唯一的例外是缩进**：`Tab` / `Shift+Tab` 不做代码区间判定（理由见 `changeIndent` 的注释）。
 *
 * ### 为什么全是纯函数
 * `continueList` / `changeIndent` / `deleteListMarkerBackward` 只读 `EditorState`，
 * 只返回 `{ changes, selection }`，**不派发事务**。于是"按一下键文档会变成什么样"
 * 可以在 vitest 里直接对 `EditorState` 断言，不用模拟键盘、不用 DOM，
 * 边界（空项、嵌套、任务项、编号不连续）也能逐条钉死。
 *
 * ### 性能
 * 全部落在**当前行**上：`lineAt` 是 O(log 行数)，标记解析是 O(行长)，
 * 代码区间判定是语法树的 `resolveInner`（O(树深)）。
 * 唯一的例外是有序列表的**连续重编号**：它只沿"紧接其后、同缩进、同分隔符、编号连续"
 * 的兄弟项走，遇到第一个不连续的项立刻停 —— 这与上游 `renumberList` 的口径一致，
 * 代价是 O(连续的兄弟项数)，不是 O(全文)。
 */

import { syntaxTree } from '@codemirror/language'
import {
  EditorSelection,
  countColumn,
  type ChangeSpec,
  type EditorState,
  type Line,
  type SelectionRange,
} from '@codemirror/state'
import type { Command, EditorView } from '@codemirror/view'

/** 一个光标位置上的编辑结果（纯数据：调用方自己决定要不要派发）。 */
export interface ListInputEdit {
  /** 变更描述；所有位置都基于**原文档**。 */
  changes: readonly ChangeSpec[]
  /**
   * 编辑完成后光标应该落在哪里。
   *
   * 类型是 `SelectionRange`（`EditorSelection.cursor()` 的返回）——
   * `state.update({ selection })` 与 `view.dispatch({ selection })` 都直接接受它
   * （`{ anchor, head }` 与它结构兼容），所以测试里可以原样喂回 `EditorState`。
   */
  selection: SelectionRange
}

/** 列表标记的解析结果（`- 甲` / `* 甲` / `1. 甲` / `- [ ] 甲` …）。 */
export interface ListMarker {
  /** 行首缩进原文（保留制表符，不做归一化）。 */
  indent: string
  /**
   * 缩进宽度（**列数**）。
   *
   * 用 `countColumn(text, state.tabSize, n)` 而不是 `indent.length`：
   * `state.tabSize` 由设置页的"Tab 宽度"通过 Compartment 灌进来，
   * 于是"一个制表符算几列"在光标列计算、缩进宽度、列表等级判定三处完全一致。
   */
  indentColumns: number
  kind: 'bullet' | 'ordered'
  /** 无序列表的符号（`-` / `*` / `+`）；有序列表为 `null`。 */
  bullet: string | null
  /** 有序列表的编号；无序列表为 `0`。 */
  number: number
  /** 有序列表的分隔符（`.` / `)`）；无序列表为 `null`。 */
  delimiter: string | null
  /** 是不是任务项（`- [ ]` / `1. [x]`）。 */
  task: boolean
  /** 任务项当前是否已勾选。 */
  checked: boolean
  /** 内容起点（相对行首的**字符**偏移，不是列）。 */
  contentStart: number
}

/** 缩进方向：`1` = 升一级，`-1` = 降一级。 */
export type IndentDirection = 1 | -1

/**
 * 行首到内容的标记结构。
 *
 * 与 CommonMark/GFM 的要点对齐：
 * - 无序标记必须是单个 `-` / `*` / `+`，后面**至少一个**空白（所以 `*斜体*` 不是列表）；
 * - 有序标记是 1–9 位数字 + `.` 或 `)`；
 * - 任务框 `[ ]` / `[x]` 后面也必须有空白，否则它只是普通文本内容。
 */
const MARKER_PATTERN = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))([ \t]+)(?:\[([ xX])\]([ \t]+))?/

/**
 * 代码区间：这些节点里面的一切都不是 Markdown。
 *
 * 为什么需要它：本模块按**行**解析标记，看不见上下文 —— 围栏代码块里的
 * `- 甲` 会被误判成列表项（真实会发生的错误）。语法树能给出 O(树深) 的答案，
 * 而"向上找未闭合的 ```"是 O(行数)。上游 `markdownKeymap` 也是靠语法树判断的。
 */
const CODE_NODES = new Set(['FencedCode', 'CodeBlock', 'CodeText', 'InlineCode', 'Comment'])

/**
 * 解析一行的列表标记；不是列表项返回 `null`。
 *
 * @param state 用来取 `tabSize`（缩进列数的口径）
 * @param line 目标行
 */
export function parseListMarker(state: EditorState, line: Line): ListMarker | null {
  const match = MARKER_PATTERN.exec(line.text)
  if (match === null) return null

  const indent = match[1] ?? ''
  const bullet = match[2] ?? null
  const numberText = match[3]
  // `- 甲` 与 `1. 甲` 二选一：两个都没匹配上说明正则里的交替分支都没走通
  if (bullet === null && numberText === undefined) return null

  const check = match[6]
  return {
    indent,
    indentColumns: countColumn(line.text, state.tabSize, indent.length),
    kind: bullet === null ? 'ordered' : 'bullet',
    bullet,
    number: numberText === undefined ? 0 : Number(numberText),
    delimiter: match[4] ?? null,
    task: check !== undefined,
    checked: (check ?? '').toLowerCase() === 'x',
    contentStart: match[0].length,
  }
}

// ---------------------------------------------------------------------------
// Enter：续行 / 空项退出
// ---------------------------------------------------------------------------

/**
 * Enter 的行为（纯函数）。
 *
 * | 场景 | 结果 |
 * | --- | --- |
 * | 非空列表项、光标在行尾 | 插入同缩进、同类型的新项（有序 +1，并顺延连续编号；任务项继承 `- [ ]` 且**一律未勾选**） |
 * | 只剩标记的列表项 | **结束列表**：删掉标记；有缩进则先退一级（`  - ` → `- `） |
 * | 光标在内容中间 | `null`（交给上游拆分成两项 —— 它做得比我们稳） |
 * | 松散列表（兄弟项间有空行） | `null`（上游会在新项前后补空行，接管反而破坏排版） |
 * | 代码区间 / 不是列表项 | `null`（普通换行） |
 */
export function continueList(state: EditorState, pos?: number): ListInputEdit | null {
  const at = clampPosition(state, pos ?? state.selection.main.head)
  const line = state.doc.lineAt(at)
  if (inCodeContext(state, at)) return null

  const marker = parseListMarker(state, line)
  if (marker === null) return null

  const contentStart = line.from + marker.contentStart
  // 光标停在标记里（`-| 甲`）：标记正在被编辑，交回既有实现，绝不在这里改坏它
  if (at < contentStart) return null

  const contentEnd = line.from + trimmedLength(line.text)
  // 空项 → 结束列表（上游在这里会把紧凑列表改成松散列表，与写作直觉不符）
  if (contentStart >= contentEnd) return exitListEdit(state, line, marker)
  if (at < contentEnd) return null
  if (isLooseList(state, line, marker)) return null

  // 新项的前缀：同缩进、同类型；任务框**重置为未勾选**（新的一项按定义还没做完）
  const prefix = renderPrefix(marker, marker.number + 1, marker.indent, marker.task)
  // 光标后面的尾随空白一起吃进这次替换，避免留下 `- 甲   `
  let from = at
  while (from > line.from && isBlankChar(state.doc.sliceString(from - 1, from))) from -= 1

  const changes: ChangeSpec[] = [{ from, to: at, insert: `\n${prefix}` }]
  if (marker.kind === 'ordered') changes.push(...renumberFollowing(state, line, marker))

  return {
    changes,
    selection: EditorSelection.cursor(from + prefix.length + 1),
  }
}

/**
 * "结束列表"：把这一行的标记删掉。
 *
 * - 有缩进 → 降一级并保留标记（`  - ` → `- `），这是"退到上级列表"；
 * - 顶级 → 整行标记清空，这一行变成空行（等价于回到普通段落），光标落到行首。
 *
 * 只删**行内**的 `[line.from, line.to)`，所以上一行的换行永远不会被动到。
 */
function exitListEdit(state: EditorState, line: Line, marker: ListMarker): ListInputEdit {
  const outdented = outdentIndent(state, marker.indent)
  const nested = outdented.length < marker.indent.length
  const prefix = nested ? renderPrefix(marker, marker.number, outdented, marker.task) : ''
  return {
    changes: [{ from: line.from, to: line.to, insert: prefix }],
    selection: EditorSelection.cursor(line.from + prefix.length),
  }
}

/**
 * 有序列表的连续重编号。
 *
 * 为什么必须做：在 `1. 甲` 行尾按 Enter 插入 `2. ` 之后，原来紧跟的 `2. 乙`
 * 就出现了重号。上游 `renumberList` 会沿"编号连续"的兄弟项依次顺延，
 * 遇到第一个不连续的项就停（`1. 甲` / `3. 丙` 这种本来就不连续的列表保持原样）。
 * 这里用行解析实现同一口径：同缩进 + 同分隔符 + 编号正好等于期望值才继续。
 */
function renumberFollowing(state: EditorState, line: Line, marker: ListMarker): ChangeSpec[] {
  const changes: ChangeSpec[] = []
  const delimiter = marker.delimiter ?? '.'
  let expected = marker.number + 1

  for (let number = line.number + 1; number <= state.doc.lines; number += 1) {
    const next = state.doc.line(number)
    const parsed = parseListMarker(state, next)
    if (
      parsed === null ||
      parsed.kind !== 'ordered' ||
      parsed.delimiter !== delimiter ||
      parsed.indentColumns !== marker.indentColumns ||
      parsed.number !== expected
    ) {
      break
    }
    const from = next.from + parsed.indent.length
    changes.push({
      from,
      to: from + String(parsed.number).length,
      insert: String(expected + 1),
    })
    expected += 1
  }
  return changes
}

/**
 * 列表是不是"松散"的（兄弟项之间夹着空行）。
 *
 * 只看当前项的**紧邻**上下文（上一行 / 下一行），保持 O(1)：
 * 松散列表里 Enter 要补空行是上游的活，我们不接管，也就没有"补一半"的风险。
 */
function isLooseList(state: EditorState, line: Line, marker: ListMarker): boolean {
  const isSibling = (number: number): boolean => {
    if (number < 1 || number > state.doc.lines) return false
    const parsed = parseListMarker(state, state.doc.line(number))
    return parsed !== null && parsed.indentColumns === marker.indentColumns
  }
  const previous = line.number - 1
  if (previous >= 1 && isBlankText(state.doc.line(previous).text) && isSibling(previous - 1)) {
    return true
  }
  const next = line.number + 1
  if (next <= state.doc.lines && isBlankText(state.doc.line(next).text) && isSibling(next + 1)) {
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Tab / Shift+Tab：升降一级
// ---------------------------------------------------------------------------

/**
 * Tab / Shift+Tab 的行为（纯函数）。
 *
 * | 行 | Tab（`direction = 1`） | Shift+Tab（`direction = -1`） |
 * | --- | --- | --- |
 * | 列表项 | 整行升一级（行首插入"Tab 宽度"个空格） | 整行降一级；已在顶级 → `null`（交回默认的焦点移动） |
 * | 普通行 | 在**光标处**插入"Tab 宽度"个空格 | 删掉光标前至多一级的空白；前面没有空白 → `null` |
 *
 * 为什么列表项是"整行"而普通行是"光标处"：列表缩进是**结构**（改变它是改变层级），
 * 普通行的 Tab 只是插入缩进，两者用同一把键但语义不同，这是 Markdown 编辑器的通行做法。
 *
 * 为什么插入的是空格而不是 `\t`：Markdown 里制表符的对齐依赖阅读器（渲染器按 4 列展开），
 * 混排 tab 与空格很容易把列表层级弄乱；插入空格能保证"看到的对齐 = 文件里的对齐"。
 * "Tab 宽度"仍然真的生效 —— 它决定一次插入几个空格，也决定 `state.tabSize` 的列口径。
 *
 * ### 为什么这里**不做**代码区间判定（Enter / Backspace 有，缩进没有）
 * 缩进只改空白，不会产出错误文本，也永远可以撤销；而 CommonMark 里"缩进一级的列表项"
 * 与"缩进代码块"**就是同一段文本**（顶级列表项按 Tab 之后，解析器必然把它看成缩进代码块）。
 * 如果这里也按语法树拒绝，`Tab` 之后立刻 `Shift+Tab` 就退不回来了 —— 往返不成立是更严重的问题。
 * Enter / Backspace 则不同：它们会**插入标记**（在代码块里凭空多出一个 `- ` 是实打实的破坏），
 * 所以那两处必须判定代码区间。
 */
export function changeIndent(
  state: EditorState,
  direction: IndentDirection,
  pos?: number,
): ListInputEdit | null {
  const at = clampPosition(state, pos ?? state.selection.main.head)
  const line = state.doc.lineAt(at)

  const marker = parseListMarker(state, line)
  if (marker !== null) {
    if (direction === 1) {
      const indent = ' '.repeat(state.tabSize)
      return {
        changes: [{ from: line.from, insert: indent }],
        selection: EditorSelection.cursor(at + indent.length),
      }
    }
    const outdented = outdentIndent(state, marker.indent)
    const removed = marker.indent.length - outdented.length
    // 顶级列表项已无处可退：返回 null 而不是"什么都不改却吃掉按键"
    if (removed <= 0) return null
    return {
      changes: [{ from: line.from, to: line.from + marker.indent.length, insert: outdented }],
      selection: EditorSelection.cursor(Math.max(line.from, at - removed)),
    }
  }

  if (direction === 1) {
    const indent = ' '.repeat(state.tabSize)
    return {
      changes: [{ from: at, insert: indent }],
      selection: EditorSelection.cursor(at + indent.length),
    }
  }

  const limit = Math.max(0, at - state.tabSize)
  let start = at
  while (start > limit && isBlankChar(state.doc.sliceString(start - 1, start))) start -= 1
  if (start === at) return null
  return {
    changes: [{ from: start, to: at, insert: '' }],
    selection: EditorSelection.cursor(start),
  }
}

// ---------------------------------------------------------------------------
// Backspace：去掉"只剩标记"的标记
// ---------------------------------------------------------------------------

/**
 * Backspace 在列表项上的行为（纯函数）。
 *
 * 只接管"**只剩标记**"的行（`- ` / `1. ` / `- [ ] `）：
 * 这时按退格在编辑器里没有任何可见反馈（上游 `deleteMarkupBackward` 会留下半截空白），
 * 而用户想要的就是**退出列表** —— 与空项上按 Enter 完全同义。
 *
 * 明确不做的事：
 * - 内容非空（`- 甲|`）→ `null`，那就是普通的删除一个字符；
 * - 光标在标记里（`-| `）→ `null`，交给默认的逐字符删除；
 * - 绝不跨越上一行的换行（只动本行 `[line.from, line.to)`）。
 */
export function deleteListMarkerBackward(state: EditorState, pos?: number): ListInputEdit | null {
  const at = clampPosition(state, pos ?? state.selection.main.head)
  const line = state.doc.lineAt(at)
  if (inCodeContext(state, at)) return null

  const marker = parseListMarker(state, line)
  if (marker === null) return null
  if (at < line.from + marker.contentStart) return null
  if (!isBlankText(state.doc.sliceString(line.from + marker.contentStart, line.to))) return null

  return exitListEdit(state, line, marker)
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/** 针对一个光标位置算出编辑（`continueList` 等纯函数的统一形状）。 */
type PositionEdit = (state: EditorState, pos: number) => ListInputEdit | null

/**
 * 把"单光标位置"的编辑包成 CodeMirror 命令。
 *
 * 只在**恰好一个、且折叠的**选区上工作，其余情况一律返回 `false` 让按键继续往下走：
 * - 多光标：一次事务里对同一行产出两处重叠变更会被 CodeMirror 拒绝，而这些编辑
 *   又可能是"跨行"的（有序列表重编号会碰到下一行），所以不做逐选区映射；
 *   多光标下的 Enter 仍旧由兜底的 `markdownKeymap` 处理，功能不会丢；
 * - 非折叠选区：Enter 的既有语义是"替换选区"，我们的插入语义不该插进去。
 *
 * @param userEvent 事务的语义标签：`input`（插入，和相邻输入合成一次撤销）或
 *   `delete`（删除，和相邻删除合成一次）—— 与上游 `markdownKeymap` 的用法一致。
 */
function runOnSingleCursor(
  view: EditorView,
  edit: PositionEdit,
  userEvent: 'input' | 'delete',
): boolean {
  const state = view.state
  const range = state.selection.main
  if (state.selection.ranges.length !== 1 || !range.empty) return false

  const result = edit(state, range.head)
  if (result === null) return false

  view.dispatch({
    changes: result.changes,
    selection: result.selection,
    scrollIntoView: true,
    userEvent,
  })
  return true
}

/** Enter：列表续行 / 空项结束列表；不适用时返回 `false`（普通换行）。 */
export const continueListOnEnter: Command = (view) =>
  runOnSingleCursor(view, continueList, 'input')

/** Backspace：在"只剩标记"的列表项上去掉标记；不适用时返回 `false`（普通退格）。 */
export const deleteListMarkupBackward: Command = (view) =>
  runOnSingleCursor(view, deleteListMarkerBackward, 'delete')

/** Tab：列表项升一级 / 普通行在光标处插入一级缩进。 */
export const indentOnTab: Command = (view) =>
  runOnSingleCursor(view, (state, pos) => changeIndent(state, 1, pos), 'input')

/** Shift+Tab：列表项降一级 / 普通行删掉光标前的一级缩进。 */
export const outdentOnShiftTab: Command = (view) =>
  runOnSingleCursor(view, (state, pos) => changeIndent(state, -1, pos), 'input')

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 标记头（不含缩进与任务框）：`-` / `1.` / `2)`。 */
function markerHead(marker: ListMarker, number: number): string {
  if (marker.kind === 'ordered') return `${number}${marker.delimiter ?? '.'}`
  return marker.bullet ?? '-'
}

/**
 * 规范化前缀：`缩进 + 标记 + 一个空格 (+ `[ ] `)`。
 *
 * 刻意**不**复用原行的分隔空白：原来写 `-   甲`（多个空格）时，新项统一成 `- `。
 * 一致性比"逐字符复刻"更重要 —— 而且列表层级只由缩进决定，分隔空白不参与。
 */
function renderPrefix(marker: ListMarker, number: number, indent: string, task: boolean): string {
  return `${indent}${markerHead(marker, number)} ${task ? '[ ] ' : ''}`
}

/**
 * 缩进降一级：从**列**上减去一个 `tabSize`，结果统一用空格表示。
 *
 * 用列而不是字符数，是因为缩进里可能有制表符（`\t- 甲` 只占 1 个字符但占 4 列）。
 * 混排时统一重建成空格，避免"tab 与空格各按各的算法"把层级算歪。
 */
function outdentIndent(state: EditorState, indent: string): string {
  if (indent === '') return ''
  const columns = countColumn(indent, state.tabSize)
  return ' '.repeat(Math.max(0, columns - state.tabSize))
}

/** 光标是否处在"不是 Markdown"的区间里。 */
function inCodeContext(state: EditorState, pos: number): boolean {
  const tree = syntaxTree(state)
  if (tree.length === 0) return false
  let node = tree.resolveInner(pos, -1)
  for (;;) {
    if (CODE_NODES.has(node.name)) return true
    const parent = node.parent
    if (parent === null) return false
    node = parent
  }
}

/** 去掉行尾空白之后的长度（行文本里只可能出现空格与制表符）。 */
function trimmedLength(text: string): number {
  return text.replace(/[ \t]+$/u, '').length
}

function isBlankText(text: string): boolean {
  return /^[ \t]*$/u.test(text)
}

function isBlankChar(char: string): boolean {
  return char === ' ' || char === '\t'
}

function clampPosition(state: EditorState, pos: number): number {
  if (!Number.isFinite(pos)) return 0
  return Math.min(Math.max(Math.round(pos), 0), state.doc.length)
}
