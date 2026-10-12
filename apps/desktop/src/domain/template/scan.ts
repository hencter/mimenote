/**
 * `@` 记号的**唯一判据**（设计 02 §1/§5，ADR-0056）。
 *
 * ## 这一个模块回答的问题
 * "一段 Markdown 里，哪些 `@xxx` 是记号；每个记号从哪到哪；名字与参数各是什么。"
 * 编辑器补全（`features/editor/cm/template-complete/`）与模板展开器（`expand.ts`）
 * **都只消费这里**（{@link scanTemplateTokens} / {@link scanTemplate}）——
 * 设计 02 §5 把这条写成硬要求，理由就是 `[测试]` 在别处烂掉的那种方式：
 * 补全列表与展开器各写一遍正则，改一处另一处不变，于是"列表里有的记号展开时认不出"。
 *
 * ## 两条边界规则（同时成立才算记号，设计 02 §1）
 * 1. `@` 的**左邻不能是"词里的一部分"**：ASCII 字母/数字与 `.`、`_`、`-`、`+` ——
 *    于是 `mail@example.com` 里那个 `@` 的左边是 `l`，**根本不是记号起点**（邮件地址
 *    绝不被吃）；行首、空白、`（(【[{`、中文标点（`：`、`，`、`」`）、以及汉字都算边界；
 * 2. `@` 后的名字必须命中内建变量表（大小写不敏感）—— 于是 `@username` 原样保留。
 *    它**不是错误**，只是一段普通文本（§6：不加装饰、不标红）。
 *
 * 第 1 条按规格里那句"即左邻**不是**字母/数字/`.`/`_`/`-`/`+`"实现（**否定式**），
 * 而不是按前半句"必须是行首、空白或 `（(【[{` 之一"（**枚举式**）实现。两者在
 * `mail@` 这类输入上结论一致，但枚举式会连中文标点一起否掉 —— `会议记录：@cursor`、
 * `正文，@today` 是中文写作里最自然的写法，被否掉的话这个语法在中文里几乎不可用
 * （`：` 不在那六个字符里）。否定式是枚举式的**超集**（规格里认可的一切它都认可），
 * 因此没有放宽"什么算记号"以外的任何行为，且这正是规格自己给出的判据表述。
 *
 * 排除集合里**只有 ASCII**、没有汉字："字母"在这里指的是邮件地址那类词内字符
 * （`字母@域名`），而中文没有空格 —— `今天@cursor完成了` 这种行内落点是 `@cursor`
 * 最正常的用法之一，把汉字也算成词内字符会让它静默失效。代价是 `团队@today` 会展开
 * （`today` 是内建名）；真出现这种写法时用户看到的是展开值，而不是"点了没反应"。
 *
 * 转义：`@@` → 一个字面量 `@`（{@link TemplateScan.escapes}）。规格只定义了这一种转义，
 * 因此 `\@today` 里的 `@` 仍是记号（`\` 不在左邻的排除集合里，会原样留在正文里）——
 * 刻意**不加**第二套反斜杠转义：多一种转义就多一条"哪些字符能转义"的规则要维护。
 *
 * ## 代码上下文：`@` 在代码里保持字面量（§5.2 末、§9 第 6 条）
 * 围栏代码块（``` / ~~~，含开/闭围栏那一行）与行内代码里的 `@today` **不是记号**。
 * 判定是**纯文本**的（这个模块不 import CodeMirror：`domain/` 不认编辑器），
 * 围栏规则与 `domain/outline.ts` 的那一份逐字一致（同种字符、长度不短于开始才算结束），
 * 行内代码用 CommonMark 的"反引号串长度相同才配对"规则，**未闭合**的一串算到行尾 ——
 * 用户正打到一半（`` `@today ``）时，那一段本来就是代码。
 *
 * 刻意**不**跳过 frontmatter：设计 02 §5.1 明确要求模板的 frontmatter 也参与展开
 * （`created: @now`）。这与 `[[` 补全跳过 frontmatter 的口径**故意不同**，不是漏了。
 *
 * ## 性能：光标路径上不做整篇扫描
 * {@link templateDraftAt} 先只对**光标那一行**做词法（O(行长)），只有真的摸到一个 `@`
 * 之后才算代码区间（围栏要从第 1 行数起）。于是"每次按键"的常见情形 —— 光标那行
 * 根本没有 `@` —— 不付任何与文档长度相关的代价（`wiki-complete` 对 `[[` 的同一条纪律）。
 */

import { isTemplateBuiltin } from './builtins'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 一个**成立**的记号（名字命中内建表、且不在代码上下文里）。偏移是全文偏移，`end` 排他。 */
export interface TemplateToken {
  start: number
  end: number
  /** **规范化后**的名字（小写）——查表与分支都用它。 */
  name: string
  /** `=` 之后的参数（原文，允许中文）；没有 `=` 时为 `null`。 */
  argument: string | null
  /**
   * 原文（`@today=YYYY年`）。
   *
   * "原样保留"与提示都用它：正文里留下的必须是用户写的**那串字符**，
   * 而不是我们重新拼出来的（大小写、参数都可能被拼错）。
   */
  raw: string
}

/**
 * 词法上成立、但名字不在内建表里的 `@xxx`。
 *
 * 为什么单列而不是混进 {@link TemplateToken}：设计 02 §1 定义"记号"时要求名字命中内建表
 * （两条边界规则**同时**成立），所以它不是记号、不能进 `scanTemplateTokens` 的返回值；
 * 但 §6 又要求模板展开时把"未识别的记号"列出来 —— 那个列表正是这个类型。
 */
export interface TemplateUnknownSpan {
  start: number
  end: number
  /** 规范化后的名字（小写）。 */
  name: string
  raw: string
}

/** `@@` 转义里的第一个 `@`（展开时整段换成单个 `@`）。 */
export interface TemplateEscape {
  start: number
  end: number
}

/** 一次扫描的全部词法事实（消费者各取所需，判据本身只有这一份）。 */
export interface TemplateScan {
  /** 成立的记号，按正文顺序。 */
  tokens: TemplateToken[]
  /** 未识别的 `@xxx`，按正文顺序。 */
  unknown: TemplateUnknownSpan[]
  /** `@@` 转义点，按正文顺序。 */
  escapes: TemplateEscape[]
}

/** 一行文本 + 它在全文里的起始偏移。 */
export interface TemplateLine {
  /** 行文本（**不含**换行符）。 */
  text: string
  /** 本行第一个字符的全文偏移。 */
  from: number
}

/**
 * 只读的行视图。
 *
 * 为什么不让扫描器直接吃字符串：编辑器那一侧拿的是 `EditorState.doc`，
 * 把它 `toString()` 出来是 O(全文) 的一次分配 —— 正是 `wiki-complete` 明确避开的东西。
 * 有了这层接口，同一份判据既吃字符串（展开模板），也吃文档行（按键路径）。
 */
export interface TemplateLines {
  /** 行数（至少 1，空文档也有 1 行空行 —— 与 `Text.lines` 同口径）。 */
  readonly lineCount: number
  /** 取第 `n` 行（**1 起算**）。 */
  line(n: number): TemplateLine
}

// ---------------------------------------------------------------------------
// 行视图
// ---------------------------------------------------------------------------

/** 把整段文本切成 {@link TemplateLines}；接受 `\n` 与 `\r\n`（行文本里不留 `\r`）。 */
export function linesOfText(text: string): TemplateLines {
  const starts: number[] = []
  const texts: string[] = []
  let index = 0
  for (;;) {
    starts.push(index)
    const breakAt = text.indexOf('\n', index)
    if (breakAt === -1) {
      texts.push(stripCarriageReturn(text.slice(index)))
      break
    }
    texts.push(stripCarriageReturn(text.slice(index, breakAt)))
    index = breakAt + 1
  }
  return {
    lineCount: texts.length,
    line: (n: number): TemplateLine => {
      const position = clampLine(n, texts.length)
      return { text: texts[position - 1] ?? '', from: starts[position - 1] ?? 0 }
    },
  }
}

function stripCarriageReturn(text: string): string {
  return text.endsWith('\r') ? text.slice(0, -1) : text
}

function clampLine(n: number, lineCount: number): number {
  if (!Number.isFinite(n)) return 1
  return Math.min(Math.max(Math.trunc(n), 1), Math.max(lineCount, 1))
}

// ---------------------------------------------------------------------------
// 判据本体
// ---------------------------------------------------------------------------

/**
 * "词里的一部分"：左邻命中它就说明 `@` 在某个词内部（邮箱、路径、编号、URL 用户信息），
 * 那里的 `@` 一律不是记号。
 *
 * 刻意**只收 ASCII**：`用户@example.com` 里的 `@` 之后是 `example`（不是内建名），
 * 靠第 2 条就已经原样保留；而把汉字收进来会误伤 `今天@cursor完成了` 这种中文行内写法
 * （中文没有空格，汉字紧挨 `@` 是最常见的情形之一）。理由详见模块头。
 * BOM（`\uFEFF`）不在这张表里，于是带 BOM 的模板文件开头那个记号照常成立
 * （"BOM 不是内容"是全仓库的既有口径，见 `domain/eol.ts`）。
 */
const WORD_CHAR_PATTERN = /[A-Za-z0-9._+-]/u

/** 围栏代码块的开头/结尾（与 `domain/outline.ts` 的 `FENCE_PATTERN` 逐字一致）。 */
const FENCE_PATTERN = /^[ \t]{0,3}(`{3,}|~{3,})/u

/** 一行里一个 `@` 的**词法**结果（不管名字认不认识、也不管它在不在代码区间里）。 */
interface LexSpan {
  /** 行内下标（`@` 的位置）。 */
  start: number
  /** 行内下标（排他）。转义时指向第二个 `@` 之后。 */
  end: number
  /** `@` 之后的名字原文（可能为空 —— 刚敲下 `@`；也可能不是内建）。 */
  name: string
  /** `=` 之后的参数；没有 `=` 时为 `null`。 */
  argument: string | null
  /** 是不是 `@@` 转义。 */
  escaped: boolean
}

function isWhitespace(char: string): boolean {
  return /\s/u.test(char)
}

function isNameChar(char: string): boolean {
  return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z')
}

/** `@` 的位置是否满足左邻规则（左邻不是词里的一部分）。 */
function hasLeftBoundary(text: string, index: number): boolean {
  if (index === 0) return true
  const previous = text[index - 1]
  if (previous === undefined) return true
  return !WORD_CHAR_PATTERN.test(previous)
}

/**
 * 一行的词法扫描（**唯一**一份记号词法）。
 *
 * 名字为空、名字不认识、参数里有中文…… 全都在这里原样读出来；
 * "算不算记号"交给调用方用内建表判（{@link scanTemplateLines}），
 * "光标在不在一个记号里"也用它（{@link draftInLine}）。
 * 两处若各写一份词法，`@` 的边界规则立刻变成两个真相 —— 这正是本模块存在的理由。
 */
function lexLine(text: string): LexSpan[] {
  const spans: LexSpan[] = []
  let index = 0
  while (index < text.length) {
    if (text[index] !== '@') {
      index += 1
      continue
    }
    // **唯一的转义形式**：`@@` → 字面量 `@`（两个字符一起跳过，第二个 `@` 不再是记号的起点）。
    // 刻意**没有** `\@`：不要以为漏了 —— 规格（设计 02 §1 / 本模块头）只定义了这一种转义，
    // 加第二套就等于多一条"哪些字符能转义、转义后还算不算记号"的规则要维护。
    // `\@today` 里的 `@` 因此仍是记号，`\` 原样留在正文里。
    if (text[index + 1] === '@') {
      spans.push({ start: index, end: index + 2, name: '', argument: null, escaped: true })
      index += 2
      continue
    }
    if (!hasLeftBoundary(text, index)) {
      index += 1
      continue
    }
    const nameStart = index + 1
    let cursor = nameStart
    while (cursor < text.length && isNameChar(text[cursor] ?? '')) cursor += 1
    const name = text.slice(nameStart, cursor)
    let argument: string | null = null
    let end = cursor
    // 参数"到行尾或空白为止"（§2）：中文没有空格，所以中文标题/模式串照常吃得下
    if (text[cursor] === '=') {
      const argumentStart = cursor + 1
      let argumentEnd = argumentStart
      while (argumentEnd < text.length && !isWhitespace(text[argumentEnd] ?? '')) argumentEnd += 1
      argument = text.slice(argumentStart, argumentEnd)
      end = argumentEnd
    }
    spans.push({ start: index, end, name, argument, escaped: false })
    // 从记号末尾继续：`@today@now` 里第二个 `@` 的左邻是 `y`，本来就不该被判成记号
    index = Math.max(end, index + 1)
  }
  return spans
}

/**
 * 围栏状态机的**一步**。
 *
 * 两种遍历（整篇从第 1 行扫一遍 / 只问光标那一行）共用这一份转移规则，
 * 于是"哪种写法能开一个块、哪种能关掉它"只有一处实现。
 * 与 `domain/outline.ts` 同一口径：同种字符、长度不短于开始的那一串才算结束围栏。
 */
function fenceStep(fence: string | null, text: string): { inCode: boolean; next: string | null } {
  const marker = FENCE_PATTERN.exec(text)?.[1]
  if (fence !== null) {
    if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
      return { inCode: true, next: null }
    }
    return { inCode: true, next: fence }
  }
  if (marker !== undefined) return { inCode: true, next: marker }
  return { inCode: false, next: null }
}

/** 行内代码区间（行内下标，`from` 含、`to` 不含）。 */
type InlineRange = readonly [number, number]

/**
 * 一行里的行内代码区间。
 *
 * 规则取 CommonMark 的**反引号串**语义：长度相同才算配对（`` `` ` `` `` 里的单个
 * 反引号不闭合）；`\`` 是转义，不算分隔符。**未闭合**的一串算到行尾 ——
 * `[[` 补全那边用"未转义反引号奇偶"实现同一件事（`wiki-complete/context.ts` 的
 * `countBackticks`），两种写法在"已配对"的行上结论一致；长度匹配这一层更准
 * （`` ` `` 里的单个反引号不会把后面半行变成代码）。
 */
function inlineCodeRanges(text: string): InlineRange[] {
  const ranges: InlineRange[] = []
  let index = 0
  while (index < text.length) {
    if (text[index] !== '`' || isEscaped(text, index)) {
      index += 1
      continue
    }
    let openEnd = index
    while (text[openEnd] === '`') openEnd += 1
    const runLength = openEnd - index
    let scan = openEnd
    let closeEnd = -1
    while (scan < text.length) {
      if (text[scan] !== '`' || isEscaped(text, scan)) {
        scan += 1
        continue
      }
      let candidateEnd = scan
      while (text[candidateEnd] === '`') candidateEnd += 1
      if (candidateEnd - scan === runLength) {
        closeEnd = candidateEnd
        break
      }
      scan = candidateEnd
    }
    if (closeEnd === -1) {
      // 还没闭合：从开分隔符到行尾都是代码（用户正在敲 `` `@today `` 时就是这个状态）
      ranges.push([index, text.length])
      return ranges
    }
    ranges.push([index, closeEnd])
    index = closeEnd
  }
  return ranges
}

/** `index` 处的字符是否被奇数个反斜杠转义。 */
function isEscaped(text: string, index: number): boolean {
  let backslashes = 0
  for (let scan = index - 1; scan >= 0 && text[scan] === '\\'; scan -= 1) backslashes += 1
  return backslashes % 2 === 1
}

function inRanges(ranges: readonly InlineRange[], index: number): boolean {
  return ranges.some((range) => index >= range[0] && index < range[1])
}

// ---------------------------------------------------------------------------
// 对外的扫描结果
// ---------------------------------------------------------------------------

/** 扫描一个行视图（编辑器的按键路径用这个，避免整篇 `toString()`）。 */
export function scanTemplateLines(lines: TemplateLines): TemplateScan {
  const tokens: TemplateToken[] = []
  const unknown: TemplateUnknownSpan[] = []
  const escapes: TemplateEscape[] = []

  let fence: string | null = null
  for (let number = 1; number <= lines.lineCount; number += 1) {
    const { text, from } = lines.line(number)
    const step = fenceStep(fence, text)
    fence = step.next
    // 围栏代码块里的一切（含开/闭围栏那一行本身）都不是正文
    if (step.inCode) continue

    const code = inlineCodeRanges(text)
    for (const span of lexLine(text)) {
      if (inRanges(code, span.start)) continue
      if (span.escaped) {
        escapes.push({ start: from + span.start, end: from + span.end })
        continue
      }
      const start = from + span.start
      const end = from + span.end
      const name = span.name.toLowerCase()
      if (isTemplateBuiltin(span.name)) {
        tokens.push({ start, end, name, argument: span.argument, raw: text.slice(span.start, span.end) })
      } else if (name !== '') {
        // 空名字（刚敲下的 `@`）不算"未识别的记号"：它只是还没打完
        unknown.push({ start, end, name, raw: text.slice(span.start, span.end) })
      }
    }
  }

  return { tokens, unknown, escapes }
}

/** 扫描整段文本。 */
export function scanTemplate(text: string): TemplateScan {
  return scanTemplateLines(linesOfText(text))
}

/**
 * **设计 02 §5 的那一个函数**：`{ start, end, name, argument, raw }[]`。
 *
 * 只回名字命中内建表的记号（规则 2）。需要"未识别的记号"用
 * {@link scanUnknownTemplateTokens}，需要转义点用 {@link scanTemplate}。
 */
export function scanTemplateTokens(text: string): TemplateToken[] {
  return scanTemplate(text).tokens
}

/** 词法成立但名字不在内建表里的 `@xxx`（模板展开时的"未识别的记号"列表）。 */
export function scanUnknownTemplateTokens(text: string): TemplateUnknownSpan[] {
  return scanTemplate(text).unknown
}

// ---------------------------------------------------------------------------
// 编辑器：光标处正在书写的记号
// ---------------------------------------------------------------------------

/** 光标处正在书写的一个记号（名字或参数都可能还没打完）。偏移是全文偏移，`end` 排他。 */
export interface TemplateDraft {
  /** `@` 的位置（补全时的**替换起点**）。 */
  start: number
  /** 记号当前的结束位置（**替换终点**：整条记号都会被展开值替换掉）。 */
  end: number
  /** `@` 之后已经输入的名字（原文，可能为空）。 */
  name: string
  /**
   * 过滤候选用的查询串：光标**之前**那一段名字。
   *
   * 光标停在参数里（`@today=YY|`）时它就是整个名字 —— 用户此刻在改参数，
   * 候选列表不该因为"参数不符合任何名字"而空掉。
   */
  query: string
  /** 已经输入的参数（`=` 之后）；没有 `=` 时为 `null`。 */
  argument: string | null
}

/**
 * 光标是否正写在某个 `@` 记号里（编辑器补全的上下文判定）。
 *
 * 返回 `null` 的场合：
 * - 光标所在行、光标之前没有开始的 `@`（绝大多数按键都走这里，**不做围栏扫描**）；
 * - 光标在一个 `@@` 转义里（那是字面量 `@`，不是记号）；
 * - 光标在代码上下文里（{@link isCodeColumn}）。
 *
 * 光标**紧贴** `@` 右边（`pos === start + 1`）算命中：那正是用户刚敲下 `@` 的那一帧。
 *
 * 刻意不判 frontmatter（理由见模块头）也不判"这个 `@` 后面紧跟的字母够不够" ——
 * 那些都不是词法问题，交给候选过滤去自然收敛（一个候选都不剩时补全弹层自己关掉）。
 */
export function templateDraftAt(lines: TemplateLines, pos: number): TemplateDraft | null {
  const located = locateLine(lines, pos)
  if (located === null) return null
  const column = pos - located.from
  // 1) 先做 O(行长) 的词法：光标那行没有 `@` 时一次围栏扫描都不该发生
  const draft = draftInLine(located.text, located.from, column)
  if (draft === null) return null
  // 2) 真的摸到一个记号之后，才算代码上下文（围栏要从第 1 行数起）
  if (isCodeColumn(lines, located.number, column)) return null
  return draft
}

function draftInLine(text: string, from: number, column: number): TemplateDraft | null {
  for (const span of lexLine(text)) {
    if (span.escaped) continue
    // `column > span.start`：光标在 `@` 上（左边）时不算"正在写"；
    // `column <= span.end`：光标停在记号末尾也算（刚打完名字、还没按确认）
    if (column <= span.start || column > span.end) continue
    const nameEnd = span.start + 1 + span.name.length
    return {
      start: from + span.start,
      end: from + span.end,
      name: span.name,
      query: column <= nameEnd ? text.slice(span.start + 1, column) : span.name,
      argument: span.argument,
    }
  }
  return null
}

/** 把 `pos` 定位到某一行；`pos` 落在文档之外时返回 `null`。 */
function locateLine(
  lines: TemplateLines,
  pos: number,
): { number: number; text: string; from: number } | null {
  if (!Number.isFinite(pos)) return null
  const target = Math.round(pos)
  // 行首偏移单调递增 → 二分找"最后一个 from <= pos 的行"
  let low = 1
  let high = Math.max(lines.lineCount, 1)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (lines.line(mid).from <= target) low = mid
    else high = mid - 1
  }
  const line = lines.line(low)
  if (target < line.from || target > line.from + line.text.length) return null
  return { number: low, text: line.text, from: line.from }
}

/** 第 `lineNumber` 行的第 `column` 个字符是否落在代码上下文里（围栏块或行内代码）。 */
function isCodeColumn(lines: TemplateLines, lineNumber: number, column: number): boolean {
  let fence: string | null = null
  for (let number = 1; number <= lineNumber; number += 1) {
    const { text } = lines.line(number)
    const step = fenceStep(fence, text)
    fence = step.next
    if (step.inCode) {
      if (number === lineNumber) return true
      continue
    }
    if (number === lineNumber) {
      return inlineCodeRanges(text).some((range) => column >= range[0] && column < range[1])
    }
  }
  return false
}
