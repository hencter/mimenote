/** Tauri 运行时适配器：唯一直接依赖 `@tauri-apps/api` 的模块。 */

import { convertFileSrc, invoke } from '@tauri-apps/api/core'

import type { IpcAdapter } from './client'

export const tauriAdapter: IpcAdapter = {
  kind: 'tauri',
  async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
    return invoke<T>(method, args)
  },
}

/**
 * 本地绝对路径 → asset 协议 URL（预览渲染本地图片用，见 ADR-0007）。
 *
 * 放在这里而不是组件里：`@tauri-apps/api` 的依赖只允许出现在这一个文件中（既有约定），
 * 组件拿到的是"纯函数式"的 URL 转换，不关心协议细节（Windows 是 `http://asset.localhost/…`，
 * macOS/Linux 是 `asset://localhost/…`）。
 */
export function convertAssetUrl(absolutePath: string): string {
  return convertFileSrc(absolutePath)
}
