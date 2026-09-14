/**
 * callout（`> [!note] 标题`）在**所见即所得**里的判读、行类名与折叠标记改写。
 *
 * "哪种写法算 callout"的判据只有一份（`domain/callouts.ts` 的 `parseCallout`），这里只做
 * 编辑器特有的一步：**从一行源码里切出标记本身的位置**。
 *
 * 为什么按"行"判读而不是查语法树：callout 寄生在引用块上，而引用块的语法树里只有一串
 * `QuoteMark` 与一个 `Paragraph` —— 标记 `[!note]` 只是段落文本的前几个字符，没有节点。
 * 编辑器里的一切又都是按行现算的（视口、光标、折叠），所以判据落在"行文本"这一层最省。
 *
 * 折叠（`[!note]-` / `[!note]+`）在**编辑器**里是真的折叠（正文那些行整行收起），
 * 而在阅读视图 / 导出件里只是一个说明角标 —— 见 ADR-0022 的两侧取舍。
 */

import type { ChangeSpec, EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

import { CALLOUT_TYPES, calloutTitle, parseCallout, type CalloutType } from '@/domain/callouts'

import { MD } from './theme'

/**
 * 引用标记前缀：`> `、`> > `、`>  > ` 都算。
 *
 * 与 `build.ts` 隐藏 `QuoteMark` 的口径一致：那里逐节点隐藏 `>`，等价于"删掉行首这一串"，
 * 所以这里"标记从第几个字符开始"可以直接由前缀长度算出来，不必去查节点。
 */
const QUOTE_PREFIX = /^[ \t]*(?:>[ \t]*)+/

export interface LiveCallout {
  /** `[!type]`（含折叠符）在文档里的区间；光标不在这一行时被图标 widget 替换。 */
  markerFrom: number
  /** 区间终点（开区间）：`[!note]-` 的终点在 `-` 之后。 */
  markerTo: number
  /** 规范化类型（未知类型已回落成 `note`）。 */
  type: CalloutType
  /** 用户写的类型名（未知类型时用它当默认标题）。 */
  rawType: string
  known: boolean
  /** 标记用的字形（未知类型已回落）。 */
  glyph: string
  /** 强调色令牌（`--mn-callout-*`）；行类名会把它挂到行元素上，见 {@link calloutLineClass}。 */
  accent: string
  /** 要显示的名字（标题为空时已退化成类型名）。 */
  label: string
  /** 标记行除了标记之外**是否还有**标题文字：有就让它保持正文（可继续编辑），没有才由 widget 补名字。 */
  hasTitle: boolean
  fold: '-' | '+' | null
}

/**
 * 给定**一行**源码，读出其中的 callout 标记；不是 callout 起始行时返回 `null`。
 *
 * `lineText` 是整行（含 `>` 前缀），`lineFrom` 是这一行在文档里的起点 —— 返回的位置是绝对位置。
 */
export function readCallout(lineText: string, lineFrom: number): LiveCallout | null {
  const prefix = QUOTE_PREFIX.exec(lineText)?.[0]
  if (prefix === undefined) return null
  const content = lineText.slice(prefix.length)
  // 先做一次廉价排除：绝大多数引用行在这里就退出了，不必进解析器
  if (!content.startsWith('[!')) return null

  // 只传**这一行**：编辑器按行判读，行内不存在"标记行 + 正文"同段的情况
  const parsed = parseCallout(content)
  if (parsed === null) return null

  const close = content.indexOf(']')
  if (close < 0) return null
  let length = close + 1
  const after = content.slice(close + 1)
  if (after.startsWith('-') || after.startsWith('+')) length += 1

  const definition = CALLOUT_TYPES[parsed.type]
  return {
    markerFrom: lineFrom + prefix.length,
    markerTo: lineFrom + prefix.length + length,
    type: parsed.type,
    rawType: parsed.rawType,
    known: parsed.known,
    glyph: definition.glyph,
    accent: definition.token,
    label: calloutTitle(parsed),
    hasTitle: parsed.title !== '',
    fold: parsed.fold,
  }
}

/** 一行在 callout 里的位置（首行 / 末行 / 中间）：圆角与上下留白靠它。 */
export type CalloutLinePosition = 'first' | 'middle' | 'last'

/**
 * callout 行的类名。
 *
 * `depth > 1` 时补一个缩进类：隐藏掉 `>` 之后，嵌套引用会失去原本由 `> ` 撑出来的缩进
 * （与 `mn-md-quote--nested` 同一个补偿，值也成对维护）。
 *
 * 强调色**不再抄一遍色表**：`mn-callout--<type>` 是 `styles/app.css` 里那条
 * "只声明 `--mn-callout-accent`、别的属性一概没有"的规则。把类名挂到行上，行元素就有那个
 * 变量，行内的一切（左边框、图标、标题）都读同一个值 —— 于是"阅读视图是蓝色、编辑器是绿色"
 * 这类差异在结构上不可能出现。
 */
export function calloutLineClass(
  callout: LiveCallout,
  depth: number,
  position: CalloutLinePosition,
): string {
  const classes = [MD.callout, `${MD.callout}--${callout.type}`, `${MD.calloutAccent}${callout.type}`]
  if (depth > 1) classes.push(MD.calloutNested)
  if (position === 'first') classes.push(MD.calloutFirst)
  if (position === 'last') classes.push(MD.calloutLast)
  return classes.join(' ')
}

/**
 * 点击图标时把 `[!note]` ↔ `[!note]-` / `-` ↔ `+` 翻过来。
 *
 * 纯函数（只读 `EditorState`）：与 `task.ts` 的勾选同一个纪律 —— 位置可能因为"一次还没被
 * 装饰跟上的编辑"而漂移，所以 `hintFrom`（widget 上记的位置）只是**提示**：
 * 真正改哪里由**当前这一行的重新判读**决定。宁可什么都不做，也不能改错字符。
 */
export function foldChangeAt(state: EditorState, hintFrom: number): ChangeSpec | null {
  if (!Number.isFinite(hintFrom)) return null
  const doc = state.doc
  if (doc.length === 0) return null
  const line = doc.lineAt(Math.min(Math.max(hintFrom, 0), doc.length))
  const callout = readCallout(line.text, line.from)
  if (callout === null) return null

  // `markerTo` 是开区间：前一个字符要么是 `]`（没写折叠符），要么是 `-` / `+`
  const last = doc.sliceString(callout.markerTo - 1, callout.markerTo)
  if (last === '-' || last === '+') {
    return {
      from: callout.markerTo - 1,
      to: callout.markerTo,
      insert: last === '-' ? '+' : '-',
    }
  }
  // 没有折叠符：补一个 `-`（默认收起），位置紧跟在 `]` 之后
  return { from: callout.markerTo, to: callout.markerTo, insert: '-' }
}

/** 点击图标的命令：派发一次普通变更（因此会被保存流水线看见，与勾选框同一条路径）。 */
export function toggleCalloutFold(view: EditorView, hintFrom: number): boolean {
  const change = foldChangeAt(view.state, hintFrom)
  if (change === null) return false
  view.dispatch({ changes: change })
  return true
}
