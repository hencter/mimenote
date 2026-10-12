import { StateField, type EditorState } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { frontmatterRegion } from '@/domain/frontmatter'
function decorations(state: EditorState): DecorationSet {
  const last = Math.min(state.doc.lines, 200)
  const region = frontmatterRegion(state.doc.sliceString(0, state.doc.line(last).to))
  if (!region) return Decoration.none
  const end = state.doc.line(region.endLine + 1).to
  return Decoration.set([Decoration.replace({ block: true }).range(0, end)])
}
/** 只扫描前 200 行；原始属性通过属性表的源码入口编辑。 */
export const metadataFold = StateField.define<DecorationSet>({
  create: decorations,
  update: (value, tr) => tr.docChanged ? decorations(tr.state) : value,
  provide: (field) => EditorView.decorations.from(field),
})
