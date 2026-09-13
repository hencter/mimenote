/**
 * CodeMirror 6 编辑器宿主。
 *
 * 三条性能纪律：
 * 1. 编辑器实例只在挂载时创建一次，绝不因为文档内容变化而重建；
 * 2. 组件只订阅 `relPath` 与 `revision`（都是原始值），**不订阅 `text`**，
 *    因此每次按键不会触发 React 重渲染（文本直接进 store / CM 自己的文档模型）；
 * 3. 整篇替换只发生在"切换文件 / 从磁盘重新加载"时（revision 变化）。
 */

import { EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useEffect, useRef } from 'react'

import { Icon } from '@/components/Icon'
import { useNoteStore } from '@/state/note-store'
import { useUiStore } from '@/state/ui-store'
import { getTheme } from '@/theme/apply'
import {
  createEditorExtensions,
  replaceEditorText,
  setEditorAppearance,
} from './cm/setup'

export function MarkdownEditor() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const isDarkRef = useRef(true)

  const relPath = useNoteStore((state) => state.doc?.relPath ?? null)
  const revision = useNoteStore((state) => state.doc?.revision ?? 0)
  const status = useNoteStore((state) => state.status)
  const themeId = useUiStore((state) => state.themeId)
  const isDark = getTheme(themeId).appearance === 'dark'

  // 创建编辑器（仅一次）
  useEffect(() => {
    const parent = containerRef.current
    if (parent === null) return

    const extensions: Extension[] = createEditorExtensions(
      {
        onDocChanged: (text) => {
          // 只写内存，不触发任何 IO；保存由防抖流水线负责
          useNoteStore.getState().setText(text)
        },
      },
      isDarkRef.current,
    )

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: useNoteStore.getState().doc?.text ?? '',
        extensions,
      }),
    })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [])

  // 文档切换 / 重新加载：整篇替换
  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    const doc = useNoteStore.getState().doc
    if (doc === null) {
      replaceEditorText(view, '')
      return
    }
    if (doc.relPath !== relPath) return
    replaceEditorText(view, doc.text)
  }, [relPath, revision])

  // 主题明暗切换：重配置 Compartment，不重建编辑器
  useEffect(() => {
    isDarkRef.current = isDark
    const view = viewRef.current
    if (view !== null) setEditorAppearance(view, isDark)
  }, [isDark])

  return (
    <div className="mn-editor">
      {relPath === null ? (
        <div className="mn-editor__placeholder">
          <Icon name="file" size={22} />
          <p>从左侧选择一篇笔记，或按 <kbd>Ctrl</kbd>+<kbd>N</kbd> 新建</p>
        </div>
      ) : (
        <>
          <div className="mn-editor__path" title={relPath}>
            <Icon name="pencil" size={13} />
            <span>{relPath}</span>
            {status === 'saving' && <span className="mn-editor__status">保存中…</span>}
          </div>
          <div className="mn-editor__surface" ref={containerRef} />
        </>
      )}
    </div>
  )
}
