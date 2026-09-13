/**
 * 链接状态：索引进度 + 当前笔记的出链/反向链接。
 *
 * 数据来自宿主的 `mn-index`（权威实现），前端不做链接解析；
 * 索引进度通过 Tauri 事件推送，避免轮询。
 */

import { create } from 'zustand'

import { ipc } from '@/ipc/client'
import { MimenoteError } from '@/ipc/types'
import type { IndexStatus, NoteLinks } from '@/ipc/types'

/** 宿主推送索引进度的事件名（与 `src-tauri/src/indexer.rs` 保持一致）。 */
export const INDEX_STATUS_EVENT = 'mn://index-status'

const IDLE_STATUS: IndexStatus = {
  phase: 'idle',
  indexed: 0,
  total: 0,
  durationMs: 0,
  links: 0,
}

interface LinksState {
  status: IndexStatus
  /** 当前打开笔记的链接；`null` 表示没有笔记或尚未加载。 */
  links: NoteLinks | null
  loading: boolean
  error: MimenoteError | null

  refresh: (relPath: string | null) => Promise<void>
  refreshStatus: () => Promise<void>
  clear: () => void
}

/**
 * 请求序号：快速切换笔记时，只有最后一次请求的结果会被采纳
 * （与笔记读取用同一套"过期响应丢弃"策略）。
 */
let requestSeq = 0

export const useLinksStore = create<LinksState>((set) => ({
  status: IDLE_STATUS,
  links: null,
  loading: false,
  error: null,

  refresh: async (relPath) => {
    if (relPath === null) {
      requestSeq += 1
      set({ links: null, loading: false, error: null })
      return
    }

    const seq = ++requestSeq
    set({ loading: true })
    try {
      const links = await ipc.noteLinks(relPath)
      if (seq !== requestSeq) return
      set({ links, loading: false, error: null })
    } catch (cause) {
      if (seq !== requestSeq) return
      set({ links: null, loading: false, error: MimenoteError.from(cause) })
    }
  },

  refreshStatus: async () => {
    try {
      const status = await ipc.indexStatus()
      set({ status })
    } catch {
      // 索引状态拿不到不影响主流程（浏览器预览模式下就没有这个命令）
    }
  },

  clear: () => {
    requestSeq += 1
    set({ links: null, loading: false, error: null, status: IDLE_STATUS })
  },
}))

/** 把宿主推来的索引进度写入 store（供事件订阅与测试调用）。 */
export function applyIndexStatus(status: IndexStatus): void {
  useLinksStore.setState({ status })
}

/**
 * 订阅索引进度事件。
 *
 * 返回取消订阅函数；在浏览器预览模式下（没有 Tauri 事件系统）静默降级 ——
 * 此时索引状态由 `refreshStatus()` 手动刷新。
 */
export function subscribeIndexStatus(): () => void {
  let disposed = false
  let unlisten: (() => void) | null = null

  void (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event')
      const stop = await listen<IndexStatus>(INDEX_STATUS_EVENT, (event) => {
        applyIndexStatus(event.payload)
      })
      if (disposed) stop()
      else unlisten = stop
    } catch (cause) {
      // 浏览器预览模式（没有 Tauri 事件系统）会走到这里，属于预期降级
      console.debug('[index] 订阅索引进度事件失败，改用状态查询：', cause)
    }
  })()

  return () => {
    disposed = true
    unlisten?.()
    unlisten = null
  }
}
