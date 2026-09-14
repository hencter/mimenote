/**
 * Markdown 表格的**对齐格式化**（纯函数）。
 *
 * ## 为什么值得做
 * 手写 Markdown 表格时"竖线对齐"全靠人肉数空格，写完一改内容就错位 —— 阅读源码时几乎没法看。
 * 这类工具（Obsidian 的 Advanced Tables）之所以流行，就是因为它把"数空格"这件机器该做的事
 * 交给了机器，而**不动任何内容**：只改空白与竖线位置。
 *
 * ## 三条纪律
 * 1. **幂等**：格式化过的表格再格式化一次，输出必须与输入逐字相同（否则"保存即产生 diff"，
 *    用户的每一次保存都会带上一串无意义改动）；
 * 2. **只认自己那一块**：从光标所在行向上/向下扩展，遇到非表格行就停；表格之外一个字符不动；
 * 3. **宽度按显示宽度算**：CJK 字符占两列（`isCjk` 与统计口径同源），否则中文表格永远对不齐 ——
 *    这是纯按 `length` 算最容易踩的坑。
 *
 * ## 边界（都写成测试）
 * - 分隔行（`|---|:--:|`）决定对齐方式，格式化时**保留**它，并按它给每一列补空格方向；
 * - 单元格里的转义竖线（`\|`）不算分隔符；
 * - 行首/行尾的竖线可有可无（GFM 允许 `甲 | 乙` 这种写法）——格式化后统一补上，让形状稳定；
 * - 列数不一致的行（少列补空、多列保留）不做"报错"，表格是人写的，宽容比严格有用。
 */

import { isCjk } from './stats'

/** 一列的对齐方式（来自分隔行）。 */
export type ColumnAlign = 'left' | 'center' | 'right'

/** 解析出来的一块表格。 */
export interface TableBlock {
  /** 表格在本行数组里的起止下标（含两端）。 */
  start: number
  end: number
  /** 每行的单元格（已去掉首尾空白；不含竖线本身）。 */
  rows: string[][]
  /** 每列的对齐方式（长度 = 列数）。 */
  aligns: ColumnAlign[]
}

const DELIMITER_CELL = /^\s*:?-{1,}:?\s*$/u

/**
 * 是不是"表格行"：去掉首尾竖线与空白后仍含有竖线，或者本身就以竖线开头/结尾。
 *
 * `甲 | 乙` 这种省略首尾竖线的写法也算（GFM 允许），因此判据不能只看 `startsWith('|')`。
 */
export function isTableRow(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed === '') return false
  return trimmed.includes('|')
}

/** 是不是分隔行（`|---|:--:|`）：每一段都必须是 `:?-+:?` 且至少有一段。 */
export function isDelimiterRow(line: string): boolean {
  if (!isTableRow(line)) return false
  const cells = splitRow(line)
  if (cells.length === 0) return false
  return cells.every((cell) => DELIMITER_CELL.test(cell))
}

/**
 * 按未转义的竖线切分一行，并给出每个单元格**内容**在本行里的字符范围。
 *
 * 为什么需要范围（不只是文本）：格式化只改空白与竖线位置、不改内容，因此"光标在单元格内容里的
 * 字符偏移"是格式化前后**唯一稳定**的坐标。编辑器的命令层据此把光标放回原处（比按显示列算
 * 简单得多，也不会被 CJK 宽度问题带偏）。
 */
export interface RowCell {
  /** 去掉首尾空白后的内容。 */
  text: string
  /** 内容起点在本行里的字符下标。 */
  start: number
  /** 内容终点（不含）。 */
  end: number
}

export function parseRowCells(line: string): RowCell[] {
  let text = line
  let base = 0
  const leading = /^\s*/u.exec(text)?.[0].length ?? 0
  base += leading
  text = text.slice(leading)

  if (text.startsWith('|')) {
    text = text.slice(1)
    base += 1
  }
  const trailingBar = text.endsWith('|') && !text.endsWith('\\|')
  if (trailingBar) text = text.slice(0, -1)

  const cells: RowCell[] = []
  let current = ''
  // 剥掉前导竖线之后，第一格的内容从 `base` 开始 —— 忘了这一步，所有偏移都会少 1
  // （而偏移是光标回位的唯一依据，错了就会"格式化一下光标跳一格"）
  let contentStart = base
  const push = (): void => {
    const leadingSpace = /^\s*/u.exec(current)?.[0].length ?? 0
    const trailingSpace = /\s*$/u.exec(current)?.[0].length ?? 0
    const start = contentStart + leadingSpace
    const end = Math.max(start, contentStart + current.length - trailingSpace)
    cells.push({ text: current.slice(leadingSpace, current.length - trailingSpace), start, end })
    current = ''
  }

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? ''
    if (char === '\\' && text[i + 1] === '|') {
      current += '\\|'
      i += 1
      continue
    }
    if (char === '|') {
      push()
      contentStart = base + i + 1
      continue
    }
    current += char
  }
  push()
  return cells
}

/** 只取文本（`parseRowCells` 的轻量版；格式化与判定都用同一个解析结果）。 */
export function splitRow(line: string): string[] {
  return parseRowCells(line).map((cell) => cell.text)
}

/** 从分隔行读出每列的对齐方式。 */
function alignsOf(delimiter: readonly string[]): ColumnAlign[] {
  return delimiter.map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })
}

/** 显示宽度：CJK 字符占 2 列，其余占 1 列（制表符按 1 列算，表格里不该出现）。 */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += isCjk(char) ? 2 : 1
  return width
}

/**
 * 在 `lines` 里找光标行所在的表格块。
 *
 * 光标可能停在表格**上/下相邻的空行**上（比如刚在表格后面按了回车），因此以"光标行或它
 * 上面那一行是表格行"为起点；找不到返回 `null`（调用方据此让按键继续往下走）。
 */
export function findTableBlock(lines: readonly string[], cursorLine: number): TableBlock | null {
  const anchor = lines[cursorLine]?.trim() === '' ? cursorLine - 1 : cursorLine
  if (anchor < 0 || anchor >= lines.length) return null
  if (!isTableRow(lines[anchor] ?? '')) return null

  let start = anchor
  while (start > 0 && isTableRow(lines[start - 1] ?? '')) start -= 1
  let end = anchor
  while (end + 1 < lines.length && isTableRow(lines[end + 1] ?? '')) end += 1

  const raw = lines.slice(start, end + 1)
  // 分隔行必须在第二行（GFM 的表格定义）；否则这只是一段含竖线的普通文本
  const delimiter = raw[1]
  if (raw.length < 2 || delimiter === undefined || !isDelimiterRow(delimiter)) return null

  const rows = raw.map((line) => splitRow(line))
  const aligns = alignsOf(splitRow(delimiter))
  return { start, end, rows, aligns }
}

/**
 * 把一个单元格按对齐方式补到目标宽度。
 *
 * 补到**恰好**列宽（不再多补）：单元格之间的空白由 `' | '` 提供，多补一格会让"最长的那一格"
 * 比同列其它格宽一个字符 —— 那正是"看起来总差一点"的来源。
 */
function padCell(cell: string, width: number, align: ColumnAlign): string {
  const missing = Math.max(0, width - displayWidth(cell))
  if (align === 'right') return ' '.repeat(missing) + cell
  if (align === 'center') {
    const left = Math.floor(missing / 2)
    return ' '.repeat(left) + cell + ' '.repeat(missing - left)
  }
  return cell + ' '.repeat(missing)
}

/** 分隔行渲染成 `| :--- | ---: |`（宽度与列宽一致，`:---` 最少三个减号）。 */
function renderDelimiter(widths: readonly number[], aligns: readonly ColumnAlign[]): string {
  const cells = widths.map((width, index) => {
    const align = aligns[index] ?? 'left'
    const dashes = '-'.repeat(Math.max(3, width))
    if (align === 'center') return `:${dashes.slice(1, -1)}:`
    if (align === 'right') return `${dashes.slice(1)}:`
    return dashes
  })
  return `| ${cells.join(' | ')} |`
}

/**
 * 格式化一块表格，返回格式化后的各行。
 *
 * 列宽 = 该列所有单元格的**显示宽度**最大值（分隔行的宽度不参与计算：它由列宽决定）。
 */
export function formatTable(block: TableBlock): string[] {
  const columnCount = Math.max(...block.rows.map((row) => row.length), block.aligns.length, 1)

  const widths: number[] = []
  for (let column = 0; column < columnCount; column += 1) {
    let width = 0
    for (let row = 0; row < block.rows.length; row += 1) {
      // 第 2 行是分隔行：它的宽度由列宽反推，不参与
      if (row === 1) continue
      const cell = block.rows[row]?.[column] ?? ''
      width = Math.max(width, displayWidth(cell))
    }
    // 表头至少要能放下 `---`（三个减号）
    widths.push(Math.max(3, width))
  }

  return block.rows.map((row, index) => {
    if (index === 1) return renderDelimiter(widths, block.aligns)
    const cells = widths.map((width, column) =>
      padCell(row[column] ?? '', width, block.aligns[column] ?? 'left'),
    )
    return `| ${cells.join(' | ')} |`
  })
}

/**
 * 一步到位：给定整篇文本与光标行（0 起算），返回格式化后的整篇文本。
 *
 * 找不到表格、或格式化结果与原文完全相同时返回 `null` —— 调用方据此**不派发事务**
 * （避免产生"看起来没变化"的撤销步骤）。
 */
export function formatTableAt(text: string, cursorLine: number): string | null {
  const lines = text.split('\n')
  const block = findTableBlock(lines, cursorLine)
  if (block === null) return null

  const formatted = formatTable(block)
  const before = lines.slice(block.start, block.end + 1)
  if (formatted.every((line, index) => line === before[index])) return null

  const next = [...lines.slice(0, block.start), ...formatted, ...lines.slice(block.end + 1)]
  return next.join('\n')
}
