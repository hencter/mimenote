/**
 * 全文搜索面板的**异步查询**：防抖 + 竞态丢弃 + 卸载即作废。
 *
 * 这是第三种模式与另外两种（命令面板 / 快速切换）最本质的差别：它们的数据源在内存里，
 * 一次按键 = 一次 O(n) 扫描；搜索要打到宿主（SQLite FTS5），必须处理三件事：
 *
 * 1. **防抖**（{@link SEARCH_DEBOUNCE_MS}）：`键入 → 发起 IPC` 不是一对一。
 *    每个字符都打一次 IPC，在 1 万篇笔记的库上是每秒几十次跨进程调用，
 *    而其中绝大多数结果在被返回时就已经过期了。等用户停顿一下再问，是"少问几次"
 *    而不是"晚一点给结果"：只要用户还在打字，他要的答案本来就不确定。
 * 2. **竞态丢弃**：异步响应**不保证按请求顺序返回**（搜索耗时随查询串而变），
 *    不丢弃就会出现"先敲的词后回来，把新结果盖掉"的经典竞态。
 *    这里用请求序号（与 `note-store` 的 `readToken`、`links-store` 的 `requestSeq` 同一套），
 *    **序号在 effect 里立刻递增**（而不是等请求真正发出）：
 *    这样"防抖窗口内用户又敲了一个字"时，上一条在途请求当场作废。
 * 3. **关闭即取消**：面板关闭 = 组件卸载，卸载时把序号推大，让在途响应再也 setState 不到
 *    （`React 19` 对卸载后的 setState 是静默忽略，但"结果落进一个已经不存在的面板"
 *    在加了 search store 之后就会变成真 bug，所以这里从源头掐掉）。
 *
 * 不做请求取消（AbortSignal）：宿主命令没有取消通道，而"丢弃结果"已经足够
 * —— 代价只是一次被浪费的计算，换来的是不需要为取消再引入一条 IPC 语义。
 */

import { useEffect, useRef, useState } from 'react'

import { ipc } from '@/ipc/client'
import { MimenoteError } from '@/ipc/types'
import type { SearchHit } from '@/ipc/types'
import { MAX_PALETTE_RESULTS } from './match'

/**
 * 输入防抖窗口。
 *
 * 150ms 是"手速快的连续输入一定落在同一个窗口里、而正常停顿一定会触发查询"的经验值：
 * 再短（如 80ms）对中文输入/连打没有过滤效果，再长（如 300ms）会让"输入完看结果"明显发木。
 */
export const SEARCH_DEBOUNCE_MS = 150

export interface PaletteSearchState {
  /** 宿主已按 score 降序排好的命中（未截断；渲染时再切前 N 条）。 */
  hits: readonly SearchHit[]
  /** 命中总数（来自宿主，可能大于 `hits.length`）。 */
  total: number
  loading: boolean
  error: MimenoteError | null
  /**
   * **已经拿到结果**的那次查询串（`''` = 还没有任何结果回来）。
   *
   * 空态文案要靠它区分"结果还没回来"与"回来了但没有命中"：只看 `loading` 会少一帧
   * ——防抖窗口内 `loading` 还是 false，此时显示"没有结果"是错的。
   */
  settledQuery: string
}

const IDLE: PaletteSearchState = {
  hits: [],
  total: 0,
  loading: false,
  error: null,
  settledQuery: '',
}

/**
 * 按查询串取全文搜索结果。
 *
 * @param query 输入框里的原始串（**不要**传 deferred 版本：防抖已经承担了降频，
 *   再叠一层延迟只会让"最后一次输入的查询"更晚发出）
 * @param enabled 面板是否处于搜索模式**且**已打开 Vault。未打开 Vault 时不必打扰宿主
 *   （宿主会返回空结果，但一次无意义的跨进程调用同样不该发）
 */
export function usePaletteSearch(query: string, enabled: boolean): PaletteSearchState {
  const [state, setState] = useState<PaletteSearchState>(IDLE)
  /** 请求序号：只有最后一次发起的请求的结果会被采纳。 */
  const seqRef = useRef(0)

  // 卸载（= 面板关闭）后回来的结果不能再 setState：把序号推大，在途请求全部作废。
  // 放在独立 effect 里而不是主 effect 的 cleanup 中：主 effect 每次 `query` 变化都会
  // cleanup 一次，那是"被新请求超过"，与"面板没了"是两件事，混在一起会误伤。
  useEffect(() => {
    return () => {
      seqRef.current += 1
    }
  }, [])

  useEffect(() => {
    // 空查询 / 未打开 Vault：直接回到空态，**不调用 IPC**（宿主也会返回空结果）。
    // setState 传同一个 IDLE 对象引用 → React 直接跳过重渲染，所以每次清空不产生额外渲染。
    const trimmed = query.trim()
    if (!enabled || trimmed === '') {
      seqRef.current += 1
      setState(IDLE)
      return
    }

    const seq = (seqRef.current += 1)
    const timer = setTimeout(() => {
      // loading 只在请求真正发出后置位：防抖窗口内的短暂停顿不应该闪一下"搜索中…"
      setState((previous) => ({ ...previous, loading: true, error: null }))
      void (async () => {
        try {
          const result = await ipc.searchQuery(trimmed, MAX_PALETTE_RESULTS)
          if (seq !== seqRef.current) return
          // 次要防线：宿主原样回显 query，与本次请求不一致说明响应错配
          // （正常情况下不会发生；代价只是一次字符串比较，但能挡住宿主将来做批量/重排）
          if (result.query.trim() !== trimmed) return
          setState({
            hits: result.hits,
            total: result.total,
            loading: false,
            error: null,
            settledQuery: trimmed,
          })
        } catch (cause) {
          if (seq !== seqRef.current) return
          // 失败必须显式呈现：静默空白会让用户以为"库里没有这个词"
          setState({
            hits: [],
            total: 0,
            loading: false,
            error: MimenoteError.from(cause),
            settledQuery: trimmed,
          })
        }
      })()
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
    }
  }, [query, enabled])

  return state
}
