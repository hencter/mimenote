/**
 * "这个编辑器实例正在显示哪一篇笔记"（CodeMirror facet）。
 *
 * ## 为什么必须按实例传，而不是让插件去读 `note-store`
 * 分栏之后**同时存在多个编辑器实例**（每格一个，ADR-0049）。插件（Live Preview 的图片解析、
 * `[[` 补全的候选排序、粘贴附件的相对路径）需要的都是"**我这一格**在显示哪一篇"；
 * 从前它们读 `useNoteStore.getState().doc?.relPath` —— 那是**当前文档**那一篇，
 * 于是在非当前那格里：图片按别人的目录去找、粘进来的图片按别人的路径写链接。
 * 更糟的是那位"别人"还会随点击而变，同一个格子前后行为都不一致。
 *
 * ## 用法
 * `MarkdownEditor` 在创建编辑器时提供它，并在同一格换笔记时用 `Compartment` 重配置
 * （`replaceEditorText` 只换正文，facet 得自己跟着换 —— 编辑器实例不重建是刻意的，
 * 换文档不该丢掉撤销历史与光标）。
 *
 * 读的一侧一律走 {@link notePathOf}：空串（没提供）时**退回** `note-store` 的当前文档，
 * 这样"没接线的编辑器"（大量既有单测直接 `createEditorExtensions`）行为与从前完全一致。
 */

import { Facet } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

import { useNoteStore } from '@/state/note-store'

/** 这一格显示的笔记路径（相对 Vault 根）；空串 = 没提供。 */
export const notePathFacet = Facet.define<string, string>({
  combine: (values) => values[0] ?? '',
})

/** 读某一格的笔记路径；facet 空着时退回"当前文档"（旧行为）。 */
export function notePathOf(view: EditorView): string | null {
  const path = view.state.facet(notePathFacet)
  if (path !== '') return path
  return useNoteStore.getState().doc?.relPath ?? null
}
