/**
 * CodeMirror 6 编辑器宿主。
 *
 * 三条性能纪律：
 * 1. 编辑器实例只在**承载节点挂载时**创建一次，绝不因为文档内容变化而重建；
 * 2. 组件只订阅 `relPath` 与 `revision`（都是原始值），**不订阅 `text`**，
 *    因此每次按键不会触发 React 重渲染（文本直接进 store / CM 自己的文档模型）；
 * 3. 整篇替换只发生在"切换文件 / 从磁盘重新加载"时（revision 变化）。
 */

import { EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useCallback, useEffect, useRef } from 'react'

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
  const viewRef = useRef<EditorView | null>(null)
  const isDarkRef = useRef(true)

  const relPath = useNoteStore((state) => state.doc?.relPath ?? null)
  const revision = useNoteStore((state) => state.doc?.revision ?? 0)
  const status = useNoteStore((state) => state.status)
  const themeId = useUiStore((state) => state.themeId)
  const isDark = getTheme(themeId).appearance === 'dark'

  // 创建编辑器：用**回调 ref**，节点挂载即创建、卸载即销毁。
  //
  // 为什么不用 useEffect(.., [])：没有文档时渲染的是占位符，`.mn-editor__surface`
  // 这个 div 根本不存在，effect 会空转一次并且再也不会重跑 ——
  // 结果是"打开第一篇笔记时编辑器是空的"（E2E 抓到的真实 bug）。
  // 回调 ref 会在节点真正出现/消失时被调用，天然覆盖"先启动后打开笔记"的顺序，
  // 对 StrictMode 的双挂载也正确（挂载→销毁→再挂载）。
  const attachSurface = useCallback((node: HTMLDivElement | null) => {
    // 节点被卸载（或换成另一个节点）：先销毁旧实例，避免泄漏与重复挂载
    if (viewRef.current !== null) {
      viewRef.current.destroy()
      viewRef.current = null
    }
    if (node === null) return

    const extensions: Extension[] = createEditorExtensions(
      {
        onDocChanged: (text) => {
          // 只写内存，不触发任何 IO；保存由防抖流水线负责
          useNoteStore.getState().setText(text)
        },
      },
      isDarkRef.current,
    )

    viewRef.current = new EditorView({
      parent: node,
      state: EditorState.create({
        doc: useNoteStore.getState().doc?.text ?? '',
        extensions,
      }),
    })
  }, [])

  // 组件整体卸载时兜底销毁（回调 ref 传 null 通常已经处理，这里防御性再清一次）
  useEffect(
    () => () => {
      viewRef.current?.destroy()
      viewRef.current = null
    },
    [],
  )

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
          <div className="mn-editor__surface" ref={attachSurface} />
        </>
      )}
    </div>
  )
}
