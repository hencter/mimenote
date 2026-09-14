/** 原生对话框（目录选择）。唯一依赖 `@tauri-apps/plugin-dialog` 的模块，按需动态加载。 */

import { isTauriRuntime } from '@/ipc/client'

/** 目录选择器：给定标题，返回用户选定的绝对路径；取消返回 `null`。 */
export type DirectoryPicker = (title: string) => Promise<string | null>

/**
 * 默认实现：Tauri 的 `open({ directory: true })`。
 *
 * 返回 `null` 表示用户取消，或当前不在 Tauri 运行时（浏览器预览模式）。
 */
const tauriDirectoryPicker: DirectoryPicker = async (title) => {
  if (!isTauriRuntime()) return null

  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({
    directory: true,
    multiple: false,
    title,
  })

  if (typeof selected === 'string') return selected
  if (Array.isArray(selected)) {
    const first = selected[0]
    return typeof first === 'string' ? first : null
  }
  return null
}

let picker: DirectoryPicker = tauriDirectoryPicker

/**
 * 替换目录选择器实现（**测试注入点**）。
 *
 * 与 `ipc/client.ts` 的 `setIpcAdapter`、`export-save.ts` 的 `setSavePathPicker` 同一个理由：
 * jsdom 里没有系统对话框，而"整库导出"是一条要跑几千次 IO 的主路径，必须在单测里整条跑通。
 * 传 `null` 恢复默认实现。
 */
export function setDirectoryPicker(next: DirectoryPicker | null): void {
  picker = next ?? tauriDirectoryPicker
}

/** 弹出系统目录选择框。 */
export function pickDirectory(title: string): Promise<string | null> {
  return picker(title)
}
