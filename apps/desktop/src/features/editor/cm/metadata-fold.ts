import { Prec, StateField, type EditorState } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  keymap,
  type Command,
  type DecorationSet,
} from '@codemirror/view'
import { frontmatterRegion } from '@/domain/frontmatter'

function decorations(state: EditorState): DecorationSet {
  const last = Math.min(state.doc.lines, 200)
  const region = frontmatterRegion(state.doc.sliceString(0, state.doc.line(last).to))
  if (!region) return Decoration.none
  const end = state.doc.line(region.endLine + 1).to
  return Decoration.set([Decoration.replace({ block: true }).range(0, end)])
}

/** 正文起点：闭合围栏下一行的行首；没有下一行则是围栏行末。 */
export function frontmatterBodyStart(state: EditorState): number | null {
  const last = Math.min(state.doc.lines, 200)
  const region = frontmatterRegion(state.doc.sliceString(0, state.doc.line(last).to))
  if (region === null) return null
  const fenceLine = region.endLine + 1
  if (fenceLine >= state.doc.lines) return state.doc.line(fenceLine).to
  return state.doc.line(fenceLine + 1).from
}

/**
 * 光标已在 frontmatter 后第一行行首时，Backspace 不再向前删 ——
 * 否则会吃掉闭合围栏后的换行、甚至拆掉被折叠的元数据区块。
 * 选区只要碰到正文起点之前的字节，同样拦下。
 */
export const protectFrontmatterBackspace: Command = (view) => {
  const bodyStart = frontmatterBodyStart(view.state)
  if (bodyStart === null) return false
  for (const range of view.state.selection.ranges) {
    if (range.empty) {
      if (range.head === bodyStart) return true
      continue
    }
    if (range.from < bodyStart) return true
  }
  return false
}

/** 只扫描前 200 行；原始属性在属性表里改（frontmatter 默认折叠，不在正文 DOM 里）。 */
export const metadataFold = StateField.define<DecorationSet>({
  create: decorations,
  update: (value, tr) => (tr.docChanged ? decorations(tr.state) : value),
  provide: (field) => EditorView.decorations.from(field),
})

/** 与折叠一起装：优先级高于列表 Backspace / 默认退格。 */
export const metadataFoldKeymap = Prec.high(
  keymap.of([{ key: 'Backspace', run: protectFrontmatterBackspace }]),
)
