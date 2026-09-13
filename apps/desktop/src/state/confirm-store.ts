/** 破坏性操作的确认对话框（Promise 化的 `window.confirm` 替代品，可样式化、可键盘操作）。 */

import { create } from 'zustand'

export interface ConfirmRequest {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  /** 确认按钮是否为危险样式。 */
  danger?: boolean
  /** 需要用户输入的内容？M1 不做，保留字段位置。 */
  detail?: string
}

interface ConfirmState {
  request: ConfirmRequest | null
  /** 内部：悬挂的 promise resolve。 */
  answer: ((value: boolean) => void) | null
  ask: (request: ConfirmRequest) => Promise<boolean>
  respond: (value: boolean) => void
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  request: null,
  answer: null,

  ask: (request) => {
    // 已经有对话框在等待时，先前的请求按"取消"处理，避免 promise 永久悬挂
    get().answer?.(false)
    return new Promise<boolean>((resolve) => {
      set({ request, answer: resolve })
    })
  },

  respond: (value) => {
    const resolve = get().answer
    set({ request: null, answer: null })
    resolve?.(value)
  },
}))

/** 便捷函数。 */
export function confirmAction(request: ConfirmRequest): Promise<boolean> {
  return useConfirmStore.getState().ask(request)
}
