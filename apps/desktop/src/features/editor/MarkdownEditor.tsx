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

import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useCallback, useEffect, useMemo, useRef } from 'react'

import { Icon } from '@/components/Icon'
import { metadataBlock } from '@/domain/frontmatter-edit'
import { useCursorStore } from '@/state/cursor-store'
import { openNoteText, useNoteStore } from '@/state/note-store'
import { useSettingsStore } from '@/state/settings-store'
import { useUiStore } from '@/state/ui-store'
import { getTheme } from '@/theme/apply'
import { FrontmatterEditor } from './FrontmatterEditor'
import { metadataFold } from './cm/metadata-fold'
import { notePathFacet } from './cm/note-path'
import {
  createEditorExtensions,
  currentCursorLine,
  replaceEditorText,
  setEditorAppearance,
  setEditorLineNumbers,
  setEditorTabSize,
} from './cm/setup'

export function MarkdownEditor({ notePath }: { notePath?: string } = {}) {
  const viewRef = useRef<EditorView | null>(null)
  const pathRef = useRef(notePath)
  pathRef.current = notePath
  const editableRef = useRef(new Compartment())
  const metadataRef = useRef(new Compartment())
  /** 这一格显示的是哪一篇（CodeMirror 的 facet，插件按它解析图片与链接）。 */
  const notePathCompartment = useRef(new Compartment())
  const isDarkRef = useRef(true)
  // 创建编辑器那一瞬间要用"当下"的 Tab 宽度：值放 ref 里，回调 ref 才能读到最新值
  // （回调 ref 的依赖是空的，不能把 tabWidth 当闭包变量捕获进去 —— 那会把它冻在首次渲染）
  const tabWidthRef = useRef(useSettingsStore.getState().tabWidth)
  /** 同上：创建编辑器那一瞬间的行号开关。 */
  const lineNumbersRef = useRef(useSettingsStore.getState().editorLineNumbers)

  const activePath = useNoteStore((state) => state.doc?.relPath ?? null)
  const relPath = notePath ?? activePath
  /**
   * 这一格绑定的文档**读到了没有**。
   *
   * 为什么要单独订阅：编辑器实例是"挂载即创建"的，那时正文可能还没从磁盘读回来。
   * 读到之前先只读（不让用户往空文档里打字，否则读回来的整篇替换会把它冲掉）；
   * 读到之后这一格就是**可写**的 —— 每格各有自己的文档，不再有"一格可写、其余只读"。
   *
   * 镜像兜底（`state.doc?.relPath === relPath`）是为了兼容"直接 `setState({doc})` 注入"
   * 的旧形态（既有测试大量这么摆当前文档）。
   */
  const docLoaded = useNoteStore((state) =>
    relPath === null ? false : state.docs[relPath] !== undefined || state.doc?.relPath === relPath,
  )
  /** 这一篇的整篇替换版本号（**按篇**订阅，不再看当前文档那篇的）。 */
  const revision = useNoteStore((state) =>
    relPath === null ? 0 : (state.docs[relPath]?.revision ?? state.doc?.relPath === relPath ? (state.doc?.revision ?? 0) : 0),
  )
  const themeId = useUiStore((state) => state.themeId)
  // 只读订阅"Tab 宽度"：编辑器不改它，设置页改它，这里跟着重配置 Compartment
  const tabWidth = useSettingsStore((state) => state.tabWidth)
  // 同上：行号栏的开关（默认开，可在设置页关掉）
  const showLineNumbers = useSettingsStore((state) => state.editorLineNumbers)
  const isDark = getTheme(themeId).appearance === 'dark'

  /**
   * 交给属性面板的"这一版 frontmatter"。
   *
   * 为什么在这里算、而不是让面板自己 `read()`：面板的挂载时机可能早于正文到位
   * （分栏里的格子是挂载后才读盘的），那时编辑器里还是空的 —— 面板会因此停在上一次的
   * 折叠态。**刻意读 store 而不是订阅 `text`**：换笔记时 store 已经更新，而订阅它
   * 会让每次按键都重渲染（见文件头第 2 条纪律）。依赖里放 `revision`：外部重新加载
   * 与"分栏正文终于读到了"都会让它变。
   */
  const metadataSeed = useMemo(() => {
    if (relPath === null) return undefined
    const text = openNoteText(relPath)
    return text === undefined ? undefined : metadataBlock(text)
  }, [relPath, revision])

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

    /** 这一格绑定的路径（`notePath` 没给时退回"当前文档"）。 */
    const boundPath = (): string | null =>
      pathRef.current ?? useNoteStore.getState().doc?.relPath ?? null

    const extensions: Extension[] = createEditorExtensions(
      {
        onDocChanged: (text) => {
          // 只写内存，不触发任何 IO；保存由防抖流水线负责。
          // ⚠️ 写的是**这一格**那一篇（`setTextFor`），不是"当前文档"：分栏里两格
          // 同时开着两篇时，写错目标就是把 A 的正文盖到 B 上。
          const path = boundPath()
          if (path !== null) useNoteStore.getState().setTextFor(path, text)
        },
        // 光标行 → 大纲面板的"当前章节"。只在行号变化时回调（节流在装配层）。
        // 只上报**当前文档**那一格的光标：大纲讲的是"你在看的那一篇"。
        onCursorLineChanged: (line) => {
          const path = boundPath()
          if (path !== null && useNoteStore.getState().doc?.relPath === path) {
            useCursorStore.getState().setLine(line)
          }
        },
      },
      isDarkRef.current,
      tabWidthRef.current,
      lineNumbersRef.current,
    )

    const loaded = boundPath()
    const initialDoc = loaded === null ? undefined : useNoteStore.getState().docs[loaded]
    // 这一格**可写**（每格各有自己的文档）；正文还没读到之前先只读，见 `docLoaded` 的说明
    extensions.push(editableRef.current.of(EditorState.readOnly.of(initialDoc === undefined)))
    extensions.push(metadataRef.current.of(metadataFold))
    // 这一格显示的是哪一篇：live-preview / wiki 补全 / 粘贴附件都按它解析相对路径
    extensions.push(notePathCompartment.current.of(notePathFacet.of(pathRef.current ?? '')))
    viewRef.current = new EditorView({
      parent: node,
      state: EditorState.create({
        doc: initialDoc?.text ?? '',
        extensions,
      }),
    })
    // 装上就上报一次初值：否则"打开一篇笔记、什么都没点"时大纲里没有任何高亮
    if (loaded !== null && useNoteStore.getState().doc?.relPath === loaded) {
      useCursorStore.getState().setLine(currentCursorLine(viewRef.current))
    }
  }, [])

  // 每一格自己的文档：进仓库（读盘）由 store 负责，读到的正文由下面那条 effect 整篇替换。
  // 分栏里新出现的格子**不抢当前文档**（大纳/标签面板认的仍是用户点过的那一篇）。
  useEffect(() => {
    if (relPath === null) return
    if (useNoteStore.getState().docs[relPath] !== undefined) return
    void useNoteStore.getState().openDoc(relPath)
  }, [relPath])

  // 可写性跟着"这一篇读到了没有"走（读到之前只读，避免输入被整篇替换冲掉）
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: editableRef.current.reconfigure(EditorState.readOnly.of(!docLoaded)),
    })
  }, [docLoaded])

  // 换笔记（同一格里切标签）时把 facet 里的路径也换掉：插件按它解析图片/附件相对路径，
  // 不换的话新笔记里的图片会按上一篇的目录去找。
  useEffect(() => {
    if (relPath === null) return
    viewRef.current?.dispatch({
      effects: notePathCompartment.current.reconfigure(notePathFacet.of(relPath)),
    })
  }, [relPath])

  // 组件整体卸载时兜底销毁（回调 ref 传 null 通常已经处理，这里防御性再清一次）
  useEffect(
    () => () => {
      viewRef.current?.destroy()
      viewRef.current = null
    },
    [],
  )

  // 文档切换 / 重新加载：整篇替换（**按这一格绑定的那一篇**取文本，不看"当前文档"）
  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    if (relPath === null) {
      replaceEditorText(view, '')
      useCursorStore.getState().setLine(null)
      return
    }
    // 仓库里那一篇；注入形态（只有镜像）时退回镜像 —— 与 `docLoaded` 同一套兜底
    const state = useNoteStore.getState()
    const doc =
      state.docs[relPath] ?? (state.doc?.relPath === relPath ? state.doc : undefined)
    // 还没读到（分栏里的格子读完之前）：保持现状，等 `revision` 变了再来
    if (doc === undefined) return
    if (view.state.doc.toString() !== doc.text) replaceEditorText(view, doc.text)
    // 整篇替换后光标被夹到文档开头附近：同步一次，别让大纲停在上一个笔记的章节上。
    // 只上报当前文档那一格（大纲讲的是"你在看的那一篇"）。
    if (state.doc?.relPath === relPath) useCursorStore.getState().setLine(currentCursorLine(view))
  }, [relPath, activePath, revision, notePath])

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
    <div className={`mn-editor${relPath === activePath ? ' mn-editor--active' : ''}`} data-note-path={relPath ?? undefined}>
      {/*
        属性面板**每一格都有**（用户要求：分栏两边同时看得到 frontmatter）。
        从前这里是 `relPath === activePath` —— 非当前那格连"看"都看不到（frontmatter 在编辑器里
        默认折叠成装饰，而唤出它的入口只长在这个面板里）。
        `docLoaded` 之前不渲染：那一刻正文还没到，先渲染会闪一下"折叠态"。
      */}
      {relPath !== null && docLoaded && <FrontmatterEditor key={relPath}
        seed={metadataSeed}
        onSourceMode={(raw) => {
          const view = viewRef.current
          if (!view) return
          view.dispatch({ effects: metadataRef.current.reconfigure(raw ? [] : metadataFold) })
          if (raw) { view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true }); view.focus() }
        }}
        read={() => viewRef.current?.state.doc.toString() ?? openNoteText(relPath) ?? ''}
        apply={(text) => {
          const view = viewRef.current
          if (view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
        }} />}
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
