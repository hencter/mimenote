/**
 * CodeMirror 6 编辑器宿主。
 *
 * 三条性能纪律：
 * 1. 编辑器实例只在**承载节点挂载时**创建一次，绝不因为文档内容变化而重建；
 * 2. 组件只订阅 `relPath` 与 `revision` 这类**原始值**（外加设置页的 `tabWidth`，
 *    它只触发一次 Compartment 重配置，不重建编辑器），**不订阅 `text`**，
 *    因此每次按键不会触发 React 重渲染（文本直接进 store / CM 自己的文档模型）；
 * 3. 整篇替换只发生在"切换文件 / 从磁盘重新加载"时（revision 变化）。
 */

import { EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useCallback, useEffect, useRef } from 'react'

import { Icon } from '@/components/Icon'
import { useCursorStore } from '@/state/cursor-store'
import { useNoteStore } from '@/state/note-store'
import { useSettingsStore } from '@/state/settings-store'
import { useUiStore } from '@/state/ui-store'
import { getTheme } from '@/theme/apply'
import {
  createEditorExtensions,
  currentCursorLine,
  replaceEditorText,
  setEditorAppearance,
  setEditorLineNumbers,
  setEditorTabSize,
} from './cm/setup'

export function MarkdownEditor() {
  const viewRef = useRef<EditorView | null>(null)
  const isDarkRef = useRef(true)
  // 创建编辑器那一瞬间要用"当下"的 Tab 宽度：值放 ref 里，回调 ref 才能读到最新值
  // （回调 ref 的依赖是空的，不能把 tabWidth 当闭包变量捕获进去 —— 那会把它冻在首次渲染）
  const tabWidthRef = useRef(useSettingsStore.getState().tabWidth)
  /** 同上：创建编辑器那一瞬间的行号开关。 */
  const lineNumbersRef = useRef(useSettingsStore.getState().editorLineNumbers)

  const relPath = useNoteStore((state) => state.doc?.relPath ?? null)
  const revision = useNoteStore((state) => state.doc?.revision ?? 0)
  const themeId = useUiStore((state) => state.themeId)
  // 只读订阅"Tab 宽度"：编辑器不改它，设置页改它，这里跟着重配置 Compartment
  const tabWidth = useSettingsStore((state) => state.tabWidth)
  // 同上：行号栏的开关（默认开，可在设置页关掉）
  const showLineNumbers = useSettingsStore((state) => state.editorLineNumbers)
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
        // 光标行 → 大纲面板的"当前章节"。只在行号变化时回调（节流在装配层）。
        onCursorLineChanged: (line) => {
          useCursorStore.getState().setLine(line)
        },
      },
      isDarkRef.current,
      tabWidthRef.current,
      lineNumbersRef.current,
    )

    viewRef.current = new EditorView({
      parent: node,
      state: EditorState.create({
        doc: useNoteStore.getState().doc?.text ?? '',
        extensions,
      }),
    })
    // 装上就上报一次初值：否则"打开一篇笔记、什么都没点"时大纲里没有任何高亮
    useCursorStore.getState().setLine(currentCursorLine(viewRef.current))
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
      useCursorStore.getState().setLine(null)
      return
    }
    if (doc.relPath !== relPath) return
    replaceEditorText(view, doc.text)
    // 整篇替换后光标被夹到文档开头附近：同步一次，别让大纲停在上一个笔记的章节上
    useCursorStore.getState().setLine(currentCursorLine(view))
  }, [relPath, revision])

  // 主题明暗切换：重配置 Compartment，不重建编辑器
  useEffect(() => {
    isDarkRef.current = isDark
    const view = viewRef.current
    if (view !== null) setEditorAppearance(view, isDark)
  }, [isDark])

  // Tab 宽度变化（设置页）：同样只重配置 Compartment —— 光标、选区、撤销历史全部保留。
  // 这样 `EditorState.tabSize`（光标列计算）与我们自己的缩进命令用的是同一个值。
  useEffect(() => {
    tabWidthRef.current = tabWidth
    const view = viewRef.current
    if (view !== null) setEditorTabSize(view, tabWidth)
  }, [tabWidth])

  // 行号开关变化（设置页）：同样只重配置 Compartment —— 关掉它不该丢掉光标与撤销历史。
  useEffect(() => {
    lineNumbersRef.current = showLineNumbers
    const view = viewRef.current
    if (view !== null) setEditorLineNumbers(view, showLineNumbers)
  }, [showLineNumbers])

  return (
    <div className="mn-editor">
      {relPath === null ? (
        <div className="mn-editor__placeholder">
          <Icon name="file" size="lg" />
          <p>从左侧选择一篇笔记，或按 <kbd>Ctrl</kbd>+<kbd>N</kbd> 新建</p>
        </div>
      ) : (
        // 这里曾经还有一行「当前路径」的工具栏（26px）。它搬到了标题栏中区（ADR-0029）：
        // 那一行只横跨中间一列、只在编辑视图里存在，打开/关闭笔记时会让下面所有内容上下跳 26px。
        <div className="mn-editor__surface" ref={attachSurface} />
      )}
    </div>
  )
}
