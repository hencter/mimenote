/**
 * `[[` 补全的**上下文判定与补全编辑**（纯函数，可脱离 EditorView 单测）。
 *
 * 这一层回答两个问题：
 * 1. "光标现在是不是正在写一个 `[[目标`？"（{@link wikilinkContextAt}）；
 * 2. "确认某条候选之后，文档应该变成什么样？"（{@link completionEdit}）。
 *
 * 两者都只读 `EditorState`、只返回数据，**不派发事务** —— 于是
 * "代码块里不弹""`]]` 不重复插入""光标落在 `]]` 之前"这些边界可以在 vitest 里逐条钉死，
 * 不用模拟键盘、不用等 DOM。
 *
 * ## 为什么用"行级扫描"而不是语法树节点
 * `[[双链|别名]]` 在 lezer 里是"一个孤立的 `[` + 一个 `Link` 节点"，节点上根本没有
 * "目标/别名的边界"这个信息。宿主索引侧（`mn-core::links`）与 live-preview 的装饰层
 * （`build.ts` 的 `WIKILINK_PATTERN`）也都是行级正则口径，这里保持一致比硬凑节点可靠。
 *
 * ## 为什么代码区间仍然必须看语法树
 * 行级扫描看不见上下文：围栏代码块里的 `[[` 是普通文本。`syntaxTree().resolveInner`
 * 是 O(树深) 的，而"向上找未闭合的 ```"是 O(行数)。上游 `markdownKeymap` 与
 * 我们的列表输入层（`list-input.ts` 的 `inCodeContext`）都是这么判的。
 */

import { syntaxTree } from '@codemirror/language'
import {
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type SelectionRange,
} from '@codemirror/state'

/** 这些节点里面的一切都不是 Markdown（与 `build.ts` / `list-input.ts` 同一份口径）。 */
const CODE_NODES = new Set(['FencedCode', 'CodeBlock', 'CodeText', 'InlineCode', 'Comment'])

/**
 * frontmatter 的扫描行数上限。
 *
 * 与 `build.ts` 的 `FRONTMATTER_SCAN_LINES` 同值同理由：frontmatter 必然在文档最开头，
 * 为它整篇 `doc.toString()`（O(全文)）会毁掉"按键路径上没有全量开销"这条纪律；
 * 超过上限的"疑似 frontmatter"按普通正文处理（宁可允许补全，也不要吞掉整篇的性能）。
 */
const FRONTMATTER_SCAN_LINES = 200

/** 光标所在位置上，一个正在编写的 wikilink（`[[` / `![[`）的内部结构。 */
export interface WikilinkCompletionContext {
  /** `[[` 的起点（`![[` 时指第一个 `[`，`!` 不包含在内）。 */
  from: number
  /** 目标文本的替换起点（`[[` 之后）。 */
  targetFrom: number
  /** 目标文本的替换终点（`|` 或 `]]` 或光标处）。 */
  targetTo: number
  /**
   * 需要补 `]]` 的位置；文档里已经有 `]]` 时为 `null`（**绝不重复插入**）。
   */
  insertAt: number | null
  /** 有别名时：确认后光标落在别名的末尾（也就是 `]]` 之前）；没有别名时 `null`。 */
  aliasTo: number | null
  /** 是否处在 `![[` 嵌入里（决定要不要把图片等附件列出来）。 */
  embed: boolean
  /** 过滤用的查询串（目标部分）。 */
  query: string
}

/**
 * 光标处是否正在写一个 wikilink。
 *
 * 返回 `null` 的全部场合：光标后面紧邻 `]`（已经在链接之外）、往回找不到成对的 `[[`
 * （`[文字](地址)` 这类普通链接走这里）、被 `\[[` 转义、处在代码区间或 frontmatter 里。
 *
 * @param state 编辑器状态（只读）
 * @param pos 光标位置（不传 = 主选区光标）
 */
export function wikilinkContextAt(state: EditorState, pos?: number): WikilinkCompletionContext | null {
  const doc = state.doc
  if (doc.length === 0) return null
  const at = clamp(state, pos ?? state.selection.main.head)
  const line = doc.lineAt(at)
  const text = line.text
  const rel = at - line.from

  // 1) 往回找成对的 `[[`。中途遇到 `]` 就说明光标已经在链接之外（`[[甲]] 后面`）
  let open = -1
  for (let index = rel - 1; index >= 0; index -= 1) {
    const char = text[index]
    if (char === ']') return null
    if (char === '[') {
      if (index > 0 && text[index - 1] === '[') {
        open = index - 1
        break
      }
      // 孤立的 `[`：不是 wikilink（`[文字](地址)` 的起点走这里）
      return null
    }
  }
  if (open < 0) return null

  const embed = open > 0 && text[open - 1] === '!'
  // 转义的 `\[[x]]` 不是链接（宿主链接抽取与装饰层都是这个口径）
  const linkStart = embed ? open - 1 : open
  if (linkStart > 0 && text[linkStart - 1] === '\\') return null

  if (inFrontmatter(state, line.number)) return null
  if (inCodeContext(state, at)) return null
  // 2) 行内代码的兜底判定：`` `[[ `` 这种"还没闭合的反引号"在语法树里**还不是** InlineCode
  //    （lezer 要看到配对的结束反引号才会建节点），只靠树判定会漏 —— 正在打字时恰恰是这种状态
  if (countBackticks(text, open) % 2 === 1) return null

  const contentStart = open + 2
  // 3) 向后找 `]]`：它界定"链接内部文本"的结束位置
  let closeRel = -1
  for (let index = rel; index + 1 < text.length; index += 1) {
    if (text[index] === ']' && text[index + 1] === ']') {
      closeRel = index
      break
    }
  }
  const contentEnd = closeRel === -1 ? text.length : closeRel

  // 只有落在 `]]` 之前的 `|` 才是别名分隔符：表格行的 `| a | [[x]] |` 不能被当成别名
  const pipe = text.indexOf('|', contentStart)
  const pipeRel = pipe !== -1 && pipe < contentEnd ? pipe : -1

  let targetToRel: number
  let queryEndRel: number
  let aliasEndRel: number | null
  let insertAtRel: number | null

  if (pipeRel === -1) {
    // 目标就是全部内容；没有 `]]` 时"已经输入的部分"到光标为止
    targetToRel = closeRel === -1 ? rel : closeRel
    queryEndRel = closeRel === -1 ? rel : closeRel
    aliasEndRel = null
    insertAtRel = closeRel === -1 ? rel : null
  } else {
    // 有别名：目标在 `|` 之前结束，别名的末尾才是"链接内部文本的结束"
    // （`[[设|别名` 这种未闭合写法按"别名一直到行尾"理解，与 Markdown 的直觉一致）
    targetToRel = pipeRel
    queryEndRel = pipeRel
    aliasEndRel = closeRel === -1 ? Math.max(rel, pipeRel + 1) : closeRel
    insertAtRel = closeRel === -1 ? aliasEndRel : null
  }

  return {
    from: line.from + open,
    targetFrom: line.from + contentStart,
    targetTo: line.from + targetToRel,
    insertAt: insertAtRel === null ? null : line.from + insertAtRel,
    aliasTo: aliasEndRel === null ? null : line.from + aliasEndRel,
    embed,
    query: text.slice(contentStart, queryEndRel),
  }
}

/** 一次补全编辑（纯数据：调用方自己决定要不要派发）。 */
export interface WikilinkCompletionEdit {
  changes: ChangeSpec[]
  /** 确认后光标的位置；`SelectionRange` 与 `{ anchor, head }` 结构兼容，测试里可原样喂回。 */
  selection: SelectionRange
}

/**
 * 确认候选之后的编辑。
 *
 * 三条规则：
 * 1. 只替换**目标**那一段（别名与后续文字一个字符都不动）；
 * 2. 文档里已经有 `]]` 就**不再插入**（`[[设计|别名]]` 里再补全一次仍然只有一个 `]]`）；
 * 3. 光标落在 `]]` **之前** —— 没有别名时紧贴目标之后，有别名时落在别名末尾
 *    （用户多半正想接着改别名）。
 *
 * 坐标有两套，必须分清：`changes` 里的位置是**原文档**坐标，而 `selection` 里的位置是
 * **新文档**坐标（`@codemirror/state` 的 `resolveTransactionInner` 把 `spec.selection`
 * 原样交给新状态，**不会**把它映射过 changes —— 这一点没有文档说明，是读实现确认的，
 * 也是本函数唯一"看起来多余"的 `delta` 的由来）。
 */
export function completionEdit(
  context: WikilinkCompletionContext,
  target: string,
): WikilinkCompletionEdit {
  const changes: ChangeSpec[] = [
    { from: context.targetFrom, to: context.targetTo, insert: target },
  ]
  if (context.insertAt !== null) {
    changes.push({ from: context.insertAt, insert: ']]' })
  }
  // 替换目标带来的长度差：别名末尾（原坐标）要加上它才是新文档里的位置
  const delta = target.length - (context.targetTo - context.targetFrom)
  const cursor =
    context.aliasTo !== null ? context.aliasTo + delta : context.targetFrom + target.length
  return { changes, selection: EditorSelection.cursor(cursor, -1) }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 光标是否处在"不是 Markdown"的区间里（与 `list-input.ts` 同一套判定）。 */
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

/**
 * 光标所在行是否属于文档开头的 frontmatter 区块。
 *
 * 口径与 `domain/frontmatter.frontmatterRegion` 一致，但**按行读**而不是 `doc.toString()`：
 * 后者是 O(全文)，而这段判定在每次按键上都会跑。未闭合的 `---` 不是 frontmatter
 * （普通 Markdown 里 `---` 是分隔线），因此允许补全。
 */
function inFrontmatter(state: EditorState, lineNumber: number): boolean {
  const doc = state.doc
  const head = doc.line(1).text.replace(/^\u{feff}/u, '').trimEnd()
  if (head !== '---') return false
  const limit = Math.min(doc.lines, FRONTMATTER_SCAN_LINES)
  for (let number = 2; number <= limit; number += 1) {
    if (doc.line(number).text.trimEnd() === '---') return lineNumber <= number
  }
  return false
}

/** `text` 里 `end` 之前有多少个**未转义**的反引号（行内代码的奇偶判定）。 */
function countBackticks(text: string, end: number): number {
  let count = 0
  for (let index = 0; index < end; index += 1) {
    if (text[index] !== '`') continue
    // `\`` 是转义，不算代码分隔符
    let backslashes = 0
    for (let scan = index - 1; scan >= 0 && text[scan] === '\\'; scan -= 1) backslashes += 1
    if (backslashes % 2 === 0) count += 1
  }
  return count
}

function clamp(state: EditorState, pos: number): number {
  if (!Number.isFinite(pos)) return 0
  return Math.min(Math.max(Math.round(pos), 0), state.doc.length)
}
