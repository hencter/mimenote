/**
 * "打开笔记并定位到第 N 行"（搜索结果、反向链接的落点）。
 *
 * ## 为什么必须"等文档进编辑器"再算位置
 * 打开文档只有一条路径（`app/actions.openNote`：切走前落盘 → 读取 → `revision` 自增），
 * 而编辑器是在 `revision` 变化的 effect 里**整篇替换**文本的。`openNote` 一 resolve 就去
 * 算行首偏移，算出来的是**上一篇文档**里的位置 —— 展开成一次"跳到奇怪的地方"的 bug。
 * 本模块把"等编辑器里真的已经是这篇文档"收敛在一个地方（{@link jumpToLineWhenReady}），
 * 调用方只写 `openNoteAt(path, line)`，不必知道 React 的提交时序。
 *
 * ## 为什么实现放在 features（而不是 state / app）
 * 它要两样东西：编辑器实例（CodeMirror）与编辑器内部的装饰（`cm/flash-line.ts`）。
 * 于是实现留在编辑器目录，其它层只调这里的函数 —— 与 `features/tabs/caret-memory.ts`
 * 同一套思路：`state/` 不认识 CodeMirror，谁需要就拿这里导出的函数。
 * "打开笔记 + 定位"这个**高层动作**在 `app/actions.openNoteAt`（打开路径只有一条，
 * 不能在这里再开一条），这里只负责"文档已经进编辑器之后"的那一半 —— 两边分工明确，
 * 也不会形成 `actions ↔ line-jump` 的循环依赖。
 */

import { Transaction, type EditorState, type TransactionSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { resolveLineTarget, type LineTarget } from '@/domain/line-target'
import { useNoteStore } from '@/state/note-store'

import { flashLineEffect } from './cm/flash-line'

/**
 * 定位所需的最小编辑器接口。
 *
 * 真实的 `EditorView` 天然满足它，因此生产路径上零成本；测试可以只给一个
 * 只实现这三个成员的对象（配合真实的 `EditorState`），于是"派发了什么事务"
 * 能被逐字断言，不必在 jsdom 里假装有布局（jsdom 没有高度，滚动的结果不可观测）。
 */
export interface LineJumpView {
  readonly state: EditorState
  dispatch(...specs: TransactionSpec[]): void
  focus(): void
}

/** 跳转的等待上限（毫秒）。 */
export const JUMP_TIMEOUT_MS = 1_500

/**
 * 已排队跳转的令牌：只有最后一次生效。
 *
 * 用户连按两次回车（两条不同的命中）时，第一次排的帧还在队列里 —— 不挡住的话，
 * 第二次跳完的几百毫秒内光标会被第一次的"幽灵"再挪走一次。
 */
let jumpToken = 0

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/** 下一帧执行（没有 rAF 的环境退化成宏任务，语义不变：晚一拍）。 */
function nextFrame(run: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(run)
    return
  }
  setTimeout(run, 0)
}

/**
 * 找当前编辑器实例；没有（阅读/图谱视图、还没挂载）时返回 `null`。
 *
 * DOM 查法与 `features/tabs/caret-memory.ts` 同一套约定（`.mn-editor__surface .cm-editor`，
 * 找不到再退到"页面里唯一的 CodeMirror"）。刻意不 import 那个模块：它是标签页的私有实现，
 * 而这里的失败语义不同 —— 拿不到实例 = 放弃这次跳转（那边只是"不恢复现场"）。
 */
export function findEditorView(): EditorView | null {
  if (typeof document === 'undefined') return null
  try {
    const host =
      document.querySelector<HTMLElement>('.mn-editor__surface .cm-editor') ??
      document.querySelector<HTMLElement>('.cm-editor')
    if (host === null) return null
    return EditorView.findFromDOM(host)
  } catch {
    // 拿不到实例只是"这次不跳"，绝不能影响打开笔记本身
    return null
  }
}

/** 编辑器里现在装的**就是**这篇笔记吗（路径 + 正文逐字一致）。 */
function editorViewHolding(relPath: string): EditorView | null {
  const view = findEditorView()
  if (view === null) return null
  const doc = useNoteStore.getState().doc
  if (doc === null || doc.relPath !== relPath) return null
  // 先比长度再比内容：整篇替换还没跑时长度通常就不一样，先短路掉绝大多数全量比较
  if (view.state.doc.length !== doc.text.length) return null
  return view.state.doc.toString() === doc.text ? view : null
}

/**
 * 把光标放到第 `line` 行行首、把这一行滚到视口正中，并让它闪一下。
 *
 * 这里只做一件事：**派发一次事务**。文档不变（不 dirty、不进撤销历史），
 * 因此自动保存流水线完全不受影响 —— 跳转只是"看"。
 *
 * 两个细节：
 * - `Transaction.addToHistory.of(false)`：只改选区的事务**默认会进撤销历史**
 *   （`@codemirror/commands` 的 history 会把 `tr.selection` 记成一条 selection 事件）。
 *   那样用户跳转后按 `Ctrl+Z` 会先把光标弹回原处，而不是撤销上一次真正的编辑。
 * - 滚动交给 `EditorView.scrollIntoView(..., { y: 'center' })`：视口正中而不是贴边
 *   （贴边时目标行的上下文全在屏幕外，用户还得自己再滚一下确认"是不是这里"）。
 *   也刻意**不**自己算 `scrollTop`：CodeMirror 会先按行高估算滚一次、再在测量后修正，
 *   远在屏外的行也能滚准；手写一套平行的 `scrollTop` 计算只会造出第二个真相源。
 */
export function locateLine(view: LineJumpView, line: number): LineTarget {
  const target = resolveLineTarget(line, view.state.doc.lines, (n) => view.state.doc.line(n).from)
  view.dispatch({
    selection: { anchor: target.from },
    effects: [
      flashLineEffect.of(target.line),
      EditorView.scrollIntoView(target.from, { y: 'center' }),
    ],
    annotations: Transaction.addToHistory.of(false),
    // 选区自己别滚（那是 `nearest` 语义）：滚动只由上面那条显式 effect 负责
    scrollIntoView: false,
  })
  // 跳转之后焦点落在编辑器上：用户多半想直接开始改这一行。
  // `EditorView.focus()` 内部用 `preventScroll`，不会把上面刚滚好的位置顶掉。
  view.focus()
  return target
}

export interface JumpOptions {
  /** 等待上限（毫秒，默认 {@link JUMP_TIMEOUT_MS}）：编辑器迟迟不到位就静默放弃。 */
  timeoutMs?: number
}

/**
 * 把**当前已打开**的笔记定位到第 `line` 行（不打开任何笔记）。
 *
 * 给"已经在那儿"的入口用：大纲面板点标题、将来可能的"跳到某行"。与
 * {@link jumpToLineWhenReady} 的区别是不等待、不切视图 —— 调用方自己决定
 * 编辑器不在场时怎么办（大纲在阅读视图里改用滚动正文）。
 *
 * @returns 是否真的跳了（编辑器不在场、或装的不是当前文档时返回 `false`）
 */
export function jumpToLineInOpenNote(line: number): boolean {
  const doc = useNoteStore.getState().doc
  if (doc === null) return false
  const view = editorViewHolding(doc.relPath)
  if (view === null) return false
  locateLine(view, line)
  return true
}

/**
 * 等编辑器里装上 `relPath` 这篇文档，然后把光标落到第 `line` 行。
 *
 * 按帧重试而不是"等一帧就动手"：`openNote` resolve 之后还要经过
 * React 提交 → `revision` effect → 整篇替换，大文档下不止一帧；
 * 靠固定帧数会把"偶尔跳错位置"变成难以复现的偶发 bug。
 *
 * 放弃是**静默**的（不弹提示）：用户看到的是"笔记打开了但没跳"，而跳转本来就是增强。
 * 反过来，超时后还在后台排队的跳转是绝不能接受的 —— 那会在用户已经开始打字之后
 * 突然把光标挪走。
 *
 * "打开 + 定位"的高层动作是 `app/actions.openNoteAt`（唯一的打开入口在那层），
 * 这里只负责"文档已经进编辑器之后"的那一半。
 *
 * @returns 取消函数（同一调用点可撤销；新的一次跳转也会自动作废旧的）
 */
export function jumpToLineWhenReady(
  relPath: string,
  line: number,
  options: JumpOptions = {},
): () => void {
  const token = (jumpToken += 1)
  const deadline = nowMs() + (options.timeoutMs ?? JUMP_TIMEOUT_MS)
  let cancelled = false

  const attempt = (): void => {
    if (cancelled || token !== jumpToken) return
    const view = editorViewHolding(relPath)
    if (view !== null) {
      locateLine(view, line)
      return
    }
    if (nowMs() >= deadline) return
    nextFrame(attempt)
  }

  // 第一帧之后再动手：面板关闭（`close()`）会卸载搜索框，而它的清理回调把焦点还给
  // "打开面板之前的元素"——抢在那一帧之前 focus 编辑器，会被那个回调当场抢走。
  nextFrame(attempt)
  return () => {
    cancelled = true
  }
}
