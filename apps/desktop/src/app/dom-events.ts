/** 跨组件的一次性 DOM 事件（避免为了"聚焦某个输入框"而往 store 里塞 UI 标志位）。 */

export const FOCUS_FILTER_EVENT = 'mimenote:focus-filter'
export const REVEAL_ROW_EVENT = 'mimenote:reveal-row'

/** 请求聚焦文件过滤框。 */
export function requestFilterFocus(): void {
  window.dispatchEvent(new CustomEvent(FOCUS_FILTER_EVENT))
}

/** 请求把某一行滚动到可视区。 */
export function requestRevealRow(relPath: string): void {
  window.dispatchEvent(new CustomEvent<string>(REVEAL_ROW_EVENT, { detail: relPath }))
}
