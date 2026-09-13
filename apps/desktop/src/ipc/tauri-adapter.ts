/** Tauri 运行时适配器：唯一直接依赖 `@tauri-apps/api` 的模块。 */

import { invoke } from '@tauri-apps/api/core'

import type { IpcAdapter } from './client'

export const tauriAdapter: IpcAdapter = {
  kind: 'tauri',
  async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
    return invoke<T>(method, args)
  },
}
