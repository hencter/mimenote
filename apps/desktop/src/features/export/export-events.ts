/**
 * 导出对话框的打开请求（一次性 DOM 事件）。
 *
 * 与重命名对话框同样的取舍（见 `app/dom-events.ts` 的注释）：这是"谁请求谁打开"的瞬时 UI，
 * 放进全局 store 只会让状态图变复杂。命令（`export.html` / `export.pdf`）与标题栏按钮都只
 * 负责派发事件，对话框组件负责监听、渲染与收起。
 *
 * 定义在本特性目录内（而不是 `app/dom-events.ts`）：那个文件不在本次改动的可改范围内，
 * 而这条事件的消费者与生产者都在 `features/export/`。
 */

/** 请求打开导出选择对话框。 */
export const EXPORT_REQUEST_EVENT = 'mimenote:export-request'

export function requestExport(): void {
  window.dispatchEvent(new CustomEvent(EXPORT_REQUEST_EVENT))
}

/** 请求**直接**执行某一种导出（命令面板里的 `export.html` / `export.pdf` 走这条路）。 */
export const EXPORT_RUN_EVENT = 'mimenote:export-run'

export type ExportKind = 'html' | 'print'

export function requestExportKind(kind: ExportKind): void {
  window.dispatchEvent(new CustomEvent<ExportKind>(EXPORT_RUN_EVENT, { detail: kind }))
}
