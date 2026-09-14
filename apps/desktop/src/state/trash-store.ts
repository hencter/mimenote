/**
 * 回收站状态（列出 + 恢复）。
 *
 * ## 为什么单独一个 store
 * 与 `tag-filter-store` 同一理由：它回答的是"**我现在想处理哪一条已删除的东西**"，
 * 生命周期跟着回收站对话框走，与 `vault-store`（"这个 Vault 长什么样"）不是一回事。
 * 恢复成功之后由调用方（对话框 / 应用动作）去刷新条目表与树 —— 本 store 不动别人的字段。
 *
 * ## 为什么列表要带 `present`
 * 台账是**追加写入**的，用户在文件管理器里清过 `.mimenote/trash` 之后，台账里仍留着指向
 * 不存在文件的记录。那种记录点"恢复"只会得到 `NOT_FOUND` —— 所以列表里就把它标成
 * "文件已不在回收站"，先让用户知道，而不是让他点两次才明白。
 *
 * ## 失败与空态都要有话说
 * `status === 'error'` 时对话框显示原因 + 重试；列表为空时说明"还没有删过东西"或
 * "台账里有几条孤儿记录"（两种情况文案不同）。恢复失败（例如目标已被占用）**不吞**错误，
 * 由对话框把宿主的稳定错误码翻成人话（`ALREADY_EXISTS` → 建议用「恢复为…」）。
 */

import { create } from 'zustand'

import { ipc } from '@/ipc/client'
import { MimenoteError } from '@/ipc/types'
import type { RestoreSummary, TrashEntry } from '@/ipc/types'

export type TrashStatus = 'idle' | 'loading' | 'ready' | 'error'

interface TrashState {
  entries: TrashEntry[]
  status: TrashStatus
  error: MimenoteError | null
  /** 正在恢复的那一条（按钮置忙，避免连点恢复两次）。 */
  restoringId: string | null
  /** 读一次台账（打开对话框时调用；`force` 用于恢复之后刷新）。 */
  refresh: () => Promise<void>
  /**
   * 恢复一条。成功返回宿主的结果（调用方据此提示"顺手建了 N 个目录"与"要不要重扫"）；
   * 失败返回 `null` 并把错误留在 store 里（对话框负责展示）。
   */
  restore: (id: string, targetRelPath?: string) => Promise<RestoreSummary | null>
}

/** 列表请求序号：连点"刷新"时只采纳最后一次（与 tags-store / tag-filter-store 同一套做法）。 */
let listSeq = 0

export const useTrashStore = create<TrashState>((set, get) => ({
  entries: [],
  status: 'idle',
  error: null,
  restoringId: null,

  refresh: async () => {
    const seq = ++listSeq
    set({ status: 'loading', error: null })
    try {
      const entries = await ipc.trashList()
      if (seq !== listSeq) return
      set({ entries, status: 'ready', error: null })
    } catch (cause) {
      if (seq !== listSeq) return
      set({ status: 'error', error: MimenoteError.from(cause) })
    }
  },

  restore: async (id, targetRelPath) => {
    if (get().restoringId !== null) return null
    set({ restoringId: id, error: null })
    try {
      const summary = await ipc.noteRestore(id, targetRelPath)
      // 恢复成功：把这一条从列表里摘掉（不等整表刷新，用户立刻看到它消失了）
      set((state) => ({
        entries: state.entries.filter((entry) => entry.id !== id),
        status: 'ready',
        error: null,
      }))
      return summary
    } catch (cause) {
      set({ status: 'error', error: MimenoteError.from(cause) })
      return null
    } finally {
      set({ restoringId: null })
    }
  },
}))

/** 关闭对话框时复位（下次打开重新拉一次，避免展示一份过期的台账）。 */
export function resetTrashStore(): void {
  listSeq += 1
  useTrashStore.setState({ entries: [], status: 'idle', error: null, restoringId: null })
}
