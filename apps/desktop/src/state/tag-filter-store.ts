/**
 * 标签过滤状态：文件树的"收窄视图"（选中哪些标签 → 命中哪些笔记）。
 *
 * ## 为什么单独一个 store，而不是塞进 `vault-store`
 * `vault-store` 里的字段回答的是"**这个 Vault 长什么样**"（条目表、树、展开状态、文本过滤），
 * 换 Vault 时整体重置；标签过滤回答的是"**我现在只想看哪一类笔记**"，它的生命周期跟着
 * 自己那个控件走。混在一起会让"谁把它重置掉了"变得难追踪（也容易与另一个在改标签的
 * 改动打架）。这里与 `vault-store` 没有写关系：条目表变化由调用方通过
 * {@link TagFilterActions.syncWithVault} 通知，本 store 不订阅、不写别人的字段。
 *
 * ## 为什么不持久化（与"知识图谱的折叠状态"同一取舍）
 * 过滤条件是**临时视图**，不是偏好：
 * 1. 同一条工具栏里的文本过滤本身就不持久化（`vault-store.filter` 在打开/关闭 Vault 时清空），
 *    两个过滤框并排放着却一个记得一个不记得，是最难解释的那种不一致；
 * 2. 大纲的级别过滤之所以按 Vault 存，是因为"这个 Vault 的笔记有多深"是 Vault 的**稳定属性**；
 *    而"我这会儿想看哪一类标签"随工作流变，重启后带着一个上一次的过滤进来，
 *    用户看到的第一屏就不是他的全库；
 * 3. 标签命名空间是活的（重命名/合并随时会发生），一个记下来的键可能悄悄烂成"命中 0 篇"的死视图。
 * 因此每次启动都从"无过滤 = 全量"开始，需要它时两次点击就能重建。
 *
 * ## 失败与空集都必须是**有话说**的状态
 * `status === 'error'` 时**不放行任何收窄**（树上仍是全量）并在控件里说明原因 ——
 * 宁可不过滤，也不给一个"少了几篇"的假收窄：那会让用户以为那些笔记没有这个标签。
 * 同理，命中集合为空、或命中的路径都不在当前条目表里（重扫刚发生），都各有各的文案。
 */

import { create } from 'zustand'

import {
  TAG_MATCH_MODE,
  expandTagKeys,
  mergeTagHits,
  tagFilterSignature,
} from '@/domain/tag-filter'
import { ipc } from '@/ipc/client'
import { MimenoteError, describeError } from '@/ipc/types'
import type { TagSummary } from '@/ipc/types'

/**
 * 并发上限：子标签要一个一个问（宿主没有批量接口），限并发既保护宿主
 * （每次 `tag_notes` 都是一次 `spawn_blocking` + 索引读），也不至于把总时长拉成串行。
 */
const TAG_QUERY_PARALLELISM = 8

export type TagFilterStatus = 'idle' | 'loading' | 'ready' | 'error'
export type TagSummaryStatus = 'idle' | 'loading' | 'ready' | 'error'

interface TagFilterState {
  /** 选中的标签键（**宿主归一化后的写法**，来自 `tags_list`）。顺序 = 用户点选的顺序。 */
  keys: readonly string[]
  /** 选 `#父` 时是否把 `#父/子` 也算进来（层级标签的明确选择，界面上一对一）。 */
  includeSubtags: boolean
  /** 命中笔记（各标签结果**合并后**的路径集合，已去重排序）。 */
  hits: readonly string[]
  /** {@link hits} 是对哪一组条件算出来的（与当前条件不一致 = 还没生效）。 */
  hitsSignature: string
  status: TagFilterStatus
  error: MimenoteError | null

  /** 全库标签概览：选择器的选项 + 层级展开 + "这个标签还在不在"的判据。 */
  summary: TagSummary[]
  summaryStatus: TagSummaryStatus
  summaryError: MimenoteError | null

  toggleKey: (key: string) => void
  setIncludeSubtags: (includeSubtags: boolean) => void
  /** 一键回到全量（Esc / 控件上的「清除」都走这里）。 */
  clear: () => void
  /** 取一次全库标签概览（已经拿到就不重复问，`force` 用于重扫后刷新）。 */
  ensureSummary: (force?: boolean) => Promise<void>
  /** 重新计算命中集合（选中的标签变了、条目表变了、用户点了「重新过滤」）。 */
  reload: () => Promise<void>
  /**
   * 条目表换了"身份"就重算一次（同一棵树不重复问）。
   *
   * 为什么要有它：命中集合是**宿主回答的快照**，而重扫（手工/外部改动）之后条目表可能变了
   * —— 笔记被删、被改名、标签被改。不重算就会出现"能看见的路径在树里已经不存在"这种
   * 静默错乱（表现是树空着但计数还说有几篇）。
   */
  syncWithVault: (tree: unknown) => void
}

/** 上一次同步过的条目表（树）的引用：用来识别"真的换了一棵树"。 */
let lastTreeToken: unknown = null

/** 命中集合请求序号：快速改选择时只采纳最后一次（与 tags-store 同一套做法）。 */
let hitSeq = 0
/** 标签概览请求序号（与命中集合分开：两者互不阻塞）。 */
let summarySeq = 0

export const useTagFilterStore = create<TagFilterState>((set, get) => ({
  keys: [],
  includeSubtags: true,
  hits: [],
  hitsSignature: '',
  status: 'idle',
  error: null,
  summary: [],
  summaryStatus: 'idle',
  summaryError: null,

  toggleKey: (key) => {
    const current = get().keys
    const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
    set({ keys: next })
    if (next.length === 0) {
      // 取消最后一个标签 = 回到全量：连"上一次的命中集合"也一并丢掉，
      // 免得下游（以及测试）读到一份没人用的旧数据
      get().clear()
      return
    }
    void get().reload()
  },

  setIncludeSubtags: (includeSubtags) => {
    if (get().includeSubtags === includeSubtags) return
    set({ includeSubtags })
    if (get().keys.length > 0) void get().reload()
  },

  clear: () => {
    // 序号往前推：在途的响应回来时会被丢弃，不会把过滤又"复活"
    hitSeq += 1
    set({ keys: [], hits: [], hitsSignature: '', status: 'idle', error: null })
  },

  ensureSummary: async (force = false) => {
    if (!force && get().summaryStatus === 'ready') return
    const seq = ++summarySeq
    set({ summaryStatus: 'loading', summaryError: null })
    try {
      const summary = await ipc.tagsList()
      if (seq !== summarySeq) return
      set({ summary, summaryStatus: 'ready', summaryError: null })
    } catch (cause) {
      if (seq !== summarySeq) return
      // 概览拿不到不影响"已经选中的标签"继续过滤，只是没法再选新标签
      set({ summary: [], summaryStatus: 'error', summaryError: MimenoteError.from(cause) })
    }
  },

  reload: async () => {
    const keys = get().keys
    if (keys.length === 0) {
      set({ hits: [], hitsSignature: '', status: 'idle', error: null })
      return
    }
    // 层级展开要全库标签键：没有概览就先取一次，否则「含子标签」会**静默**退化成只查自己
    // （那正是"界面说含子标签、结果却不含"的那种错）
    if (get().includeSubtags && get().summaryStatus !== 'ready') {
      await get().ensureSummary()
    }

    const includeSubtags = get().includeSubtags
    const signature = tagFilterSignature(keys, includeSubtags)
    const seq = ++hitSeq
    set({ status: 'loading', error: null })
    try {
      const hits = await fetchHits(keys, includeSubtags, get().summary)
      if (seq !== hitSeq) return // 已被更新的一次选择取代
      set({ hits, hitsSignature: signature, status: 'ready', error: null })
    } catch (cause) {
      if (seq !== hitSeq) return
      // 失败 = 不放行任何收窄：清掉命中集合（`hitsSignature` 置空 → 树上仍是全量），
      // 由控件如实说明"过滤未生效 + 原因 + 重试"
      set({
        hits: [],
        hitsSignature: '',
        status: 'error',
        error: MimenoteError.from(cause),
      })
    }
  },

  syncWithVault: (tree) => {
    if (tree === lastTreeToken) return
    lastTreeToken = tree
    if (get().keys.length === 0) return
    void (async () => {
      // 重扫之后标签概览也会过期（标签被增删），选择器用过它就一并刷新，
      // 否则"含子标签"会按一份旧概览算，漏掉新出现的子标签
      if (get().summaryStatus !== 'idle') await get().ensureSummary(true)
      await get().reload()
    })()
  },
}))

/** 取一组标签键的命中笔记（含子标签时先展开成"精确键"再并起来）。 */
async function fetchHits(
  keys: readonly string[],
  includeSubtags: boolean,
  summary: readonly TagSummary[],
): Promise<string[]> {
  const allKeys = summary.map((item) => item.key)
  const effective = expandTagKeys(keys, allKeys, includeSubtags)
  const lists = await mapLimit(effective, TAG_QUERY_PARALLELISM, async (key) => {
    const result = await ipc.tagNotes(key)
    return result.notes
  })
  return mergeTagHits(lists, TAG_MATCH_MODE)
}

/** 并发受限的 map（保持结果顺序）。 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let cursor = 0
  const workerCount = Math.max(1, Math.min(limit, items.length))
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      const item = items[index]
      if (item === undefined) continue
      results[index] = await run(item)
    }
  })
  await Promise.all(workers)
  return results
}

/** 报错文案（控件直接显示，不解析 message）。 */
export function tagFilterErrorMessage(error: MimenoteError | null): string {
  return error === null ? '' : describeError(error, '读取标签下的笔记失败')
}
