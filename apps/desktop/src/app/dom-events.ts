/** 跨组件的一次性 DOM 事件（避免为了"聚焦某个输入框"而往 store 里塞 UI 标志位）。 */

export const FOCUS_FILTER_EVENT = 'mimenote:focus-filter'
export const REVEAL_ROW_EVENT = 'mimenote:reveal-row'
/** 请求打开重命名对话框（detail 为 relPath；缺省表示"当前选中项"）。 */
export const RENAME_REQUEST_EVENT = 'mimenote:rename-request'
/** 请求打开「移动到…」对话框（detail 为 relPath；缺省表示"当前选中项"）。 */
export const MOVE_REQUEST_EVENT = 'mimenote:move-request'

/** 请求聚焦文件过滤框。 */
export function requestFilterFocus(): void {
  window.dispatchEvent(new CustomEvent(FOCUS_FILTER_EVENT))
}

/** 请求把某一行滚动到可视区。 */
export function requestRevealRow(relPath: string): void {
  window.dispatchEvent(new CustomEvent<string>(REVEAL_ROW_EVENT, { detail: relPath }))
}

/** 请求重命名某篇笔记（不传则针对文件树当前选中项）。 */
export function requestRename(relPath?: string): void {
  window.dispatchEvent(new CustomEvent<string | undefined>(RENAME_REQUEST_EVENT, { detail: relPath }))
}

/**
 * 请求移动某篇笔记（不传则针对文件树当前选中项）。
 *
 * 这是"不依赖鼠标"的移动入口：拖拽只是**同一件事**的手势，`moveNote` 才是那件事本身。
 */
export function requestMove(relPath?: string): void {
  window.dispatchEvent(new CustomEvent<string | undefined>(MOVE_REQUEST_EVENT, { detail: relPath }))
}
