// @vitest-environment jsdom
import { markdown } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { expect, it } from 'vitest'
import { buildLivePreviewDecorations } from '@/features/editor/cm/live-preview/build'
import { parseMarkdown } from '@/domain/markdown-core'

/**
 * 建一个**语法树已解析完整**的 state。
 *
 * 为什么必须显式逼：`EditorState.create` 的初始解析带**时间预算**，机器忙（并行跑全量套件、
 * 同时还在构建）时只会解析前几行 —— "围栏代码块里的标签不算标签"这条判据就会因为**围栏还没
 * 进树**而失败，表现为 `['#结构','#项目/子项','#围栏']`：第 2 行的 `#代码` 排除了、第 3-5 行的
 * `#围栏` 没有。也就是说结果取决于"这台机器当时有多忙"。
 *
 * 与 `live-preview-table.test.tsx` 的 `decosOf` 是同一件事，那里还记着"单次 `ensureSyntaxTree`
 * 在并行时有约 10% 概率不够"，所以这里同样循环几次、并在彻底失败时**明确报错**。
 */
function parsedState(doc: string, anchor: number): EditorState {
  const state = EditorState.create({ doc, selection: { anchor }, extensions: [markdown()] })
  if (state.doc.length > 0) {
    let parsed = ensureSyntaxTree(state, state.doc.length, 10_000)
    for (let attempt = 0; parsed === null && attempt < 5; attempt += 1) {
      parsed = ensureSyntaxTree(state, state.doc.length, 10_000)
    }
    if (parsed === null) throw new Error('语法树在预算内没有解析完，本用例无法继续')
  }
  return state
}

it('实时编辑中的正文标签保持可编辑文字并带有样式，排除代码、标题和链接', () => {
  const doc = '正文 #结构 #项目/子项\n`#代码`\n```\n#围栏\n```\n# 标题 #不标记\n[链接](https://a/#锚点) #123'
  const state = parsedState(doc, 5)
  const decorated: string[] = []
  buildLivePreviewDecorations(state, { noteRelPath: null, outbound: [], resolveAsset: () => null, resolveImage: () => ({ kind: 'placeholder' }) }).between(0, doc.length, (from, to, deco) => {
    if (deco.spec.class === 'mn-inline-tag') decorated.push(doc.slice(from, to))
  })
  expect(decorated).toEqual(['#结构', '#项目/子项'])
  expect(state.doc.toString()).toBe(doc)
})

it('预览使用同一个标签样式，代码和 URL 不会变成标签', () => {
  const html = parseMarkdown('正文 #结构 #项目/子项 `#代码` https://a/#锚点')
  expect(html).toContain('<span class="mn-inline-tag">#结构</span>')
  expect(html).toContain('<span class="mn-inline-tag">#项目/子项</span>')
  expect(html.match(/class="mn-inline-tag"/g)).toHaveLength(2)
})
