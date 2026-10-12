// @vitest-environment jsdom
import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { expect, it } from 'vitest'
import { buildLivePreviewDecorations } from '@/features/editor/cm/live-preview/build'
import { parseMarkdown } from '@/domain/markdown-core'

it('实时编辑中的正文标签保持可编辑文字并带有样式，排除代码、标题和链接', () => {
  const doc = '正文 #结构 #项目/子项\n`#代码`\n```\n#围栏\n```\n# 标题 #不标记\n[链接](https://a/#锚点) #123'
  const state = EditorState.create({ doc, selection: { anchor: 5 }, extensions: [markdown()] })
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
