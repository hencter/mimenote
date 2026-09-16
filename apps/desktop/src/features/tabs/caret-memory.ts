/**
 * 编辑器光标 / 滚动位置的记忆（切标签时"回到上次看到的位置"）。
 *
 * ## 为什么不改 `features/editor/**`
 * 编辑器实例是 CodeMirror 自己持有的（`MarkdownEditor` 用回调 ref 创建，只在承载节点
 * 挂载/卸载时创建销毁）。要"保存现场"，只需要一个能拿到**当前实例**的入口 ——
 * CodeMirror 6 提供了 `EditorView.findFromDOM(dom)`，于是这一层可以完全待在编辑器之外：
 * 本模块只管读/写 view，不注册任何扩展、不改编辑器的任何代码。
 *
 * ## 时机
 * - **capture**：在 `openNote` 之前调用（那时编辑器里还是旧文档）；
 * - **restore**：在新文档已经进编辑器之后。调用方（`tabs-store.activate`）在
 *   `await openNote()` 之后立刻调它，但 React 的 effect（`replaceEditorText`）要等这次
 *   提交跑完才执行，所以这里用 rAF 等一帧再落地 —— 否则刚设好的 selection 会被
 *   紧接着的整篇替换覆盖掉。
 *
 * 记忆是**尽力而为**的：没有编辑器（阅读/图谱视图）、拿不到实例、文档变短了，都静默跳过。
 */

import { EditorView } from '@codemirror/view'

import type { CaretMemory } from '@/state/tabs-store'

interface CaretSnapshot {
  anchor: number
  scrollTop: number
}

/** 记忆条数上限（远超正常标签数，只是防止长期运行下无限增长）。 */
const MAX_SNAPSHOTS = 64

const snapshots = new Map<string, CaretSnapshot>()

/** 拿到当前编辑器实例；没有（未挂载/非编辑视图）时返回 `null`。 */
function editorView(): EditorView | null {
  if (typeof document === 'undefined') return null
  try {
    // 优先按编辑器自己的容器找（`features/editor` 的 DOM 结构）；找不到再退到"页面里唯一的
    // CodeMirror"。两条都失败就只是"不恢复现场"，不影响切标签本身。
    const host =
      document.querySelector<HTMLElement>('.mn-editor__surface .cm-editor') ??
      document.querySelector<HTMLElement>('.cm-editor')
    if (host === null) return null
    return EditorView.findFromDOM(host)
  } catch {
    // 拿不到实例只是"不恢复现场"，绝不能影响切换标签本身
    return null
  }
}

function remember(relPath: string, snapshot: CaretSnapshot): void {
  snapshots.delete(relPath)
  snapshots.set(relPath, snapshot)
  while (snapshots.size > MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next()
    if (oldest.done === true) break
    snapshots.delete(oldest.value)
  }
}

/** 下一帧执行（等 React 提交 + 编辑器的整篇替换跑完）。 */
function afterPaint(run: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(run)
    return
  }
  setTimeout(run, 0)
}

/** 记忆器实现：由 `TreeHost` 挂载时注册到 `tabs-store`。 */
export const editorCaretMemory: CaretMemory = {
  capture: (relPath) => {
    const view = editorView()
    if (view === null) return
    remember(relPath, {
      anchor: view.state.selection.main.anchor,
      scrollTop: view.scrollDOM.scrollTop,
    })
  },

  restore: (relPath) => {
    const snapshot = snapshots.get(relPath)
    if (snapshot === undefined) return
    afterPaint(() => {
      const view = editorView()
      if (view === null) return
      // 文档可能比记忆时短（例如外部改过、或者这根本不是同一篇）：夹到合法范围内
      const anchor = Math.min(snapshot.anchor, view.state.doc.length)
      if (view.state.selection.main.anchor !== anchor) {
        view.dispatch({ selection: { anchor }, scrollIntoView: false })
      }
      if (snapshot.scrollTop > 0) view.scrollDOM.scrollTop = snapshot.scrollTop
    })
  },
}

/** 忘掉全部记忆（关闭 Vault / 卸载标签栏时调用：路径是相对根的，跨 Vault 无意义）。 */
export function clearCaretMemory(): void {
  snapshots.clear()
}
