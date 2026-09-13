/**
 * 启动流程（main.tsx 在渲染前 await 它）。
 *
 * 职责：选择 IPC 适配器 → 注册命令 → 应用主题。
 * 全程无网络请求；浏览器预览模式下退化为内存 Mock Vault。
 */

import { isTauriRuntime, setIpcAdapter } from '@/ipc/client'
import { ipc } from '@/ipc/client'
import { useUiStore } from '@/state/ui-store'
import { applyTheme, getTheme } from '@/theme/apply'
import { registerBuiltinCommands } from './builtin-commands'

export type AdapterKind = 'tauri' | 'mock'

export interface BootstrapResult {
  adapter: AdapterKind
}

export async function bootstrap(): Promise<BootstrapResult> {
  // 1. 主题先落地，避免首帧闪烁
  const ui = useUiStore.getState()
  applyTheme(getTheme(ui.themeId))

  // 2. IPC 适配器
  let adapter: AdapterKind
  if (isTauriRuntime()) {
    const { tauriAdapter } = await import('@/ipc/tauri-adapter')
    setIpcAdapter(tauriAdapter)
    adapter = 'tauri'
  } else {
    const { createMockAdapter } = await import('@/ipc/mock-adapter')
    setIpcAdapter(createMockAdapter())
    adapter = 'mock'
    console.info('[bootstrap] 未检测到 Tauri 运行时，使用内存 Mock Vault（仅用于预览与测试）')
  }

  // 3. 命令
  registerBuiltinCommands()

  // 4. 启动握手（不阻塞渲染）：确认 IPC 通道可用，并让宿主日志留下"前端已就绪"的证据
  void ipc
    .versionInfo()
    .then((version) => {
      console.info(
        `[bootstrap] IPC 就绪：app ${version.app} / mn-core ${version.core} / tauri ${version.tauri}`,
      )
    })
    .catch((cause: unknown) => {
      console.warn('[bootstrap] IPC 握手失败（界面仍会渲染，但文件操作会失败）：', cause)
    })

  return { adapter }
}
