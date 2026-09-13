/** 原生对话框（目录选择）。唯一依赖 `@tauri-apps/plugin-dialog` 的模块，按需动态加载。 */

import { isTauriRuntime } from '@/ipc/client'

/**
 * 弹出系统目录选择框。
 *
 * 返回 `null` 表示用户取消，或当前不在 Tauri 运行时（浏览器预览模式）。
 */
export async function pickDirectory(title: string): Promise<string | null> {
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
