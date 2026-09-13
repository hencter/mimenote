/** 轻量提示（toast）。所有异步失败都应在这里被"看见"，而不是静默 console.error。 */

import { create } from 'zustand'

export type ToastKind = 'info' | 'success' | 'warn' | 'error'

export interface Toast {
  id: number
  kind: ToastKind
  message: string
  detail?: string
  at: number
}

interface ToastState {
  toasts: Toast[]
  push: (toast: { kind: ToastKind; message: string; detail?: string; ttlMs?: number }) => number
  dismiss: (id: number) => void
  clear: () => void
}

let nextId = 1

/** 默认存活时间（毫秒）。错误停留更久，方便用户看清。 */
const DEFAULT_TTL = 4000
const ERROR_TTL = 8000

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  push: ({ kind, message, detail, ttlMs }) => {
    const id = nextId++
    const toast: Toast = { id, kind, message, at: Date.now() }
    if (detail !== undefined) toast.detail = detail
    set((state) => ({ toasts: [...state.toasts, toast] }))

    const ttl = ttlMs ?? (kind === 'error' ? ERROR_TTL : DEFAULT_TTL)
    if (ttl > 0 && typeof setTimeout === 'function') {
      setTimeout(() => {
        get().dismiss(id)
      }, ttl)
    }
    return id
  },

  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),

  clear: () => set({ toasts: [] }),
}))

/** 便捷函数（非组件上下文也能调用）。 */
export const toast = {
  info: (message: string, detail?: string) => useToastStore.getState().push({ kind: 'info', message, ...(detail === undefined ? {} : { detail }) }),
  success: (message: string, detail?: string) =>
    useToastStore.getState().push({ kind: 'success', message, ...(detail === undefined ? {} : { detail }) }),
  warn: (message: string, detail?: string) =>
    useToastStore.getState().push({ kind: 'warn', message, ...(detail === undefined ? {} : { detail }) }),
  error: (message: string, detail?: string) =>
    useToastStore.getState().push({ kind: 'error', message, ...(detail === undefined ? {} : { detail }) }),
}
