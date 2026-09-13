/**
 * 系统保存对话框（导出目标路径的**唯一**来源）。
 *
 * 为什么单独成模块：`app/dialogs.ts` 已经声明"唯一依赖 `@tauri-apps/plugin-dialog` 的模块"，
 * 而那个文件不在本次改动的可改范围内 —— 于是在本特性里再收一个小口子，把"选路径"这件事
 * 集中在一个可替换的函数上（返回值是绝对路径字符串，组件不碰插件 API）。
 *
 * ⚠️ 这是能力声明里 `dialog:allow-save` 对应的那一次调用，也是宿主 `export_write_html`
 * 能被触达的唯一前提：路径由用户在系统对话框里选定，宿主才允许写 Vault 之外的文件。
 */

import { isTauriRuntime } from '@/ipc/client'

/** 保存对话框：给定默认文件名，返回用户选定的绝对路径；取消返回 `null`。 */
export type SavePathPicker = (defaultName: string) => Promise<string | null>

/** 默认实现：Tauri 的 `save()`（浏览器预览模式下没有系统对话框，直接返回 `null`）。 */
const tauriSavePath: SavePathPicker = async (defaultName) => {
  if (!isTauriRuntime()) return null

  const { save } = await import('@tauri-apps/plugin-dialog')
  const selected = await save({
    title: '导出为 HTML',
    defaultPath: defaultName,
    // 只列 .html/.htm：宿主也只允许写这两种（其余扩展名会被 PATH_INVALID 拒绝）
    filters: [{ name: 'HTML 文档', extensions: ['html', 'htm'] }],
  })
  return typeof selected === 'string' ? selected : null
}

let picker: SavePathPicker = tauriSavePath

/**
 * 替换保存对话框实现（**测试注入点**）。
 *
 * 与 `ipc/client.ts` 的 `setIpcAdapter` 同一个理由：jsdom 里没有 Tauri 运行时，
 * 而"导出到哪"这条主路径必须能在单测里整条跑通（而不是把 `exportNoteHtml()` 拆成两半、
 * 只测其中一半）。传 `null` 恢复默认实现。
 */
export function setSavePathPicker(next: SavePathPicker | null): void {
  picker = next ?? tauriSavePath
}

/** 弹出保存对话框，返回绝对路径（取消/无对话框 → `null`）。 */
export function pickExportPath(defaultName: string): Promise<string | null> {
  return picker(defaultName)
}
