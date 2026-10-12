/**
 * `@` 补全的**上下文判定与补全编辑**（纯函数，可脱离 `EditorView` 单测）。
 *
 * 这一层刻意很薄：**判据本体全在 `domain/template/scan.ts`**（左邻规则、`@@` 转义、
 * 内建名字、代码上下文、光标处那条草稿的起止）。这里只做三件事：
 *
 * 1. 把 `EditorState.doc` 包成 `TemplateLines` —— 不整篇 `toString()`（那是 O(全文)，
 *    而这段判定在每次按键上都会跑，见 `scan.ts` 模块头的性能说明）；
 * 2. 把 domain 的草稿换算成"替换区间 + 过滤串 + 参数 + 原文"；
 * 3. 加一条**跨功能的互斥规则**：光标在 `[[…` 里时不弹模板补全 ——
 *    `[[@today]]` 里的 `@` 是链接目标的一部分，那时该弹的是笔记候选（`wiki-complete`），
 *    两个弹层同时挂出来会互相盖住，也说不清回车会确认哪一个。
 *
 * 与 `[[` 补全的另一个**刻意不同**：这里**不排除 frontmatter**。设计 02 §5.1 要求模板的
 * frontmatter 参与展开（`created: @now`），而用户就是要在 frontmatter 里敲这些记号。
 */

import type { EditorState, SelectionRange, Text } from '@codemirror/state'
import { EditorSelection } from '@codemirror/state'

import { templateDraftAt, type TemplateLines } from '@/domain/template/scan'

import { wikilinkContextAt } from '../wiki-complete/context'

/** 光标处正在书写的一个 `@` 记号。 */
export interface TemplateCompletionContext {
  /** `@` 的位置 —— 补全时的**替换起点**。 */
  from: number
  /** 替换终点（整条记号，包含已经敲下的参数）。 */
  to: number
  /** 过滤候选用的查询串（`@` 与光标之间的名字；可能为空）。 */
  query: string
  /** 已经敲下的参数（`=` 之后）；没有 `=` 时为 `null`。 */
  argument: string | null
  /** 原文（`@today=YY`）—— 确认前用它复核"文档没被改过"（异步读剪贴板那一档要用）。 */
  raw: string
}

/**
 * 光标处是否正在写一个 `@` 记号。
 *
 * 返回 `null` 的全部场合：空文档、光标不在任何 `@` 里、光标在 `[[…`（链接目标）里、
 * 或者 `domain` 判据认定它在代码上下文（围栏代码块 / 行内代码）里。
 *
 * @param state 编辑器状态（只读）
 * @param pos 光标位置（不传 = 主选区光标）
 */
export function templateContextAt(state: EditorState, pos?: number): TemplateCompletionContext | null {
  if (state.doc.length === 0) return null
  const at = clamp(state, pos ?? state.selection.main.head)
  // `[[@…` 里不弹：那里的 `@` 属于链接目标（见模块头）
  if (wikilinkContextAt(state, at) !== null) return null

  const draft = templateDraftAt(docLines(state.doc), at)
  if (draft === null) return null
  return {
    from: draft.start,
    to: draft.end,
    query: draft.query,
    argument: draft.argument,
    raw: state.sliceDoc(draft.start, draft.end),
  }
}

/**
 * 一次补全编辑（纯数据：调用方自己决定要不要派发）。
 *
 * 坐标两套要分清（与 `wiki-complete/context.ts` 同一个坑）：`changes` 用**原文档**坐标，
 * 而 `selection` 是**新文档**坐标（CodeMirror 不会把 `spec.selection` 映射过 changes）。
 * 这里两者恰好相同/可推导，但顺序仍然不能颠倒。
 */
export interface TemplateCompletionEdit {
  changes: { from: number; to: number; insert: string }
  selection: SelectionRange
}

/** 把整条记号替换成要插入的文本，光标落在插入文本之后。 */
export function completionEdit(
  context: TemplateCompletionContext,
  insert: string,
): TemplateCompletionEdit {
  return {
    changes: { from: context.from, to: context.to, insert },
    selection: EditorSelection.cursor(context.from + insert.length, -1),
  }
}

/** `EditorState.doc` → {@link TemplateLines}（按需取行，不整篇 `toString()`）。 */
export function docLines(doc: Text): TemplateLines {
  return {
    lineCount: doc.lines,
    line: (n: number) => {
      const line = doc.line(n)
      return { text: line.text, from: line.from }
    },
  }
}

function clamp(state: EditorState, pos: number): number {
  if (!Number.isFinite(pos)) return 0
  return Math.min(Math.max(Math.round(pos), 0), state.doc.length)
}
