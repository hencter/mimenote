/**
 * 回收站状态（列出 + 恢复 + 永久删除）。
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
 * ## 永久删除为什么也要走这里
 * 它和恢复是同一个列表上的两个动作，都要"点一下 → 宿主逐条校验 → 按结果更新列表"。
 * 结果**逐条**汇报（`removed` / `missing` / `failed`），因此列表更新不是"整表清空"，
 * 而是**只摘掉真的清掉了的那些**：被拒的（`failed`）必须留在列表里 —— 它们是用户唯一
 * 还能看见"这条我没能清掉"的地方。
 *
 * ## 失败与空态都要有话说
 * `status === 'error'` 时对话框显示原因 + 重试；列表为空时说明"还没有删过东西"或
 * "台账里有几条孤儿记录"（两种情况文案不同）。恢复失败（例如目标已被占用）**不吞**错误，
 * 由对话框把宿主的稳定错误码翻成人话（`ALREADY_EXISTS` → 建议用「恢复为…」）。
 */

import { create } from 'zustand'

import { ipc } from '@/ipc/client'
import { MimenoteError } from '@/ipc/types'
import type { PurgeSummary, RestoreSummary, TrashEntry } from '@/ipc/types'

export type TrashStatus = 'idle' | 'loading' | 'ready' | 'error'

interface TrashState {
  entries: TrashEntry[]
  status: TrashStatus
  error: MimenoteError | null
  /** 正在恢复的那一条（按钮置忙，避免连点恢复两次）。 */
  restoringId: string | null
  /** 正在永久删除的那一条（`''` = 正在清空整个回收站）。 */
  purgingId: string | null
  /** 读一次台账（打开对话框时调用；`force` 用于恢复之后刷新）。 */
  refresh: () => Promise<void>
  /**
   * 恢复一条。成功返回宿主的结果（调用方据此提示"顺手建了 N 个目录"与"要不要重扫"）；
   * 失败返回 `null` 并把错误留在 store 里（对话框负责展示）。
   */
  restore: (id: string, targetRelPath?: string) => Promise<RestoreSummary | null>
  /**
   * **永久删除一条**。成功返回宿主的逐条汇报（调用方据此说出"删了 N 项、释放 X、
   * 哪几条没成、为什么"）；失败（连台账都读不出来、或那条 ID 早已不在台账里）返回 `null`。
   *
   * `confirm` 由调用方先跑完二次确认再传 `true`：宿主侧它是**必填**的，缺了直接
   * `CONFIRMATION_REQUIRED` —— 这道闸门不该在前端有"默认打开"的写法。
   */
  purge: (id: string, confirm: boolean) => Promise<PurgeSummary | null>
  /** **清空回收站**：对当前台账里的所有条目执行同一套逻辑。 */
  emptyTrash: (confirm: boolean) => Promise<PurgeSummary | null>
}

/** 列表请求序号：连点"刷新"时只采纳最后一次（与 tags-store / tag-filter-store 同一套做法）。 */
let listSeq = 0

/**
 * 永久删除之后，把"真的清掉了"的那些从列表里摘掉。
 *
 * `removed`（真删了文件）与 `missing`（只清了孤儿记录）都要摘 —— 两者在台账里都已经
 * 没有记录了。`failed` 的那些**必须留着**：宿主的拒绝是"这一条不执行、台账记录原样保留"，
 * 界面若把它一起抹掉，用户就再也看不到"这条为什么没清掉"了。
 */
function keepAfterPurge(state: TrashEntry[], summary: PurgeSummary): TrashEntry[] {
  const gone = new Set([...summary.removed, ...summary.missing])
  return state.filter((entry) => !gone.has(entry.id))
}

export const useTrashStore = create<TrashState>((set, get) => ({
  entries: [],
  status: 'idle',
  error: null,
  restoringId: null,
  purgingId: null,

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
    if (get().restoringId !== null || get().purgingId !== null) return null
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

  purge: async (id, confirm) => {
    if (get().purgingId !== null || get().restoringId !== null) return null
    set({ purgingId: id, error: null })
    try {
      const summary = await ipc.trashDelete(id, confirm)
      set((state) => ({ entries: keepAfterPurge(state.entries, summary), status: 'ready', error: null }))
      return summary
    } catch (cause) {
      set({ status: 'error', error: MimenoteError.from(cause) })
      return null
    } finally {
      set({ purgingId: null })
    }
  },

  emptyTrash: async (confirm) => {
    if (get().purgingId !== null || get().restoringId !== null) return null
    // `''` 表示"整批"：对话框据此把顶部那颗按钮也置忙（列表里没有哪一行是"正在处理的"）
    set({ purgingId: '', error: null })
    try {
      const summary = await ipc.trashEmpty(confirm)
      set((state) => ({ entries: keepAfterPurge(state.entries, summary), status: 'ready', error: null }))
      return summary
    } catch (cause) {
      set({ status: 'error', error: MimenoteError.from(cause) })
      return null
    } finally {
      set({ purgingId: null })
    }
  },
}))

/** 关闭对话框时复位（下次打开重新拉一次，避免展示一份过期的台账）。 */
export function resetTrashStore(): void {
  listSeq += 1
  useTrashStore.setState({
    entries: [],
    status: 'idle',
    error: null,
    restoringId: null,
    purgingId: null,
  })
}
