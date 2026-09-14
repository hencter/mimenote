/**
 * 标签过滤的**派生视图**：把 `tag-filter-store` 的状态 + Vault 条目表算成
 * "树上该显示哪些路径、现在只显示 M/N 篇、有哪些情况要跟用户交代"。
 *
 * 为什么单独一个 hook 而不是让每个组件各算一遍：
 * 控件（计数与提示）与文件树（可见行）读的是**同一份推导**，两处各写一遍必然漂移
 * ——表现就是"计数说 2 篇、树上有 3 行"。
 *
 * 为什么派生的东西不进 store：`visiblePaths` 依赖 Vault 条目表（另一个 store），
 * 写进自己的 store 就要靠订阅去同步别人的变化，多出一整条容易漏更新的链路；
 * 在这里用 `useMemo` 按引用算，天然跟着两个来源一起更新。
 *
 * `autoRefresh`：条目表换了身份（重扫 / 外部改动 / 增删改名）就重算一次命中集合。
 * 只让**文件树**开这个开关（它一定在挂载着），控件不开 —— 否则同一个事件会被两个组件
 * 各触发一次 IPC 往返。
 */

import { useEffect, useMemo } from 'react'

import {
  countMarkdownEntries,
  countTagHitNotes,
  countVisibleNotes,
  descendantTagKeys,
  isTagFilterQueryEmpty,
  tagFilterSignature,
  tagFilterVisiblePaths,
  type TagFilterQuery,
} from '@/domain/tag-filter'
import { useNoteStore } from '@/state/note-store'
import { tagFilterErrorMessage, useTagFilterStore } from '@/state/tag-filter-store'
import type { MimenoteError } from '@/ipc/types'
import { useVaultStore } from '@/state/vault-store'

export interface TagFilterView {
  /** 选了标签（不管是否已经算出结果）。 */
  active: boolean
  /** 命中集合已经与当前选择对上 —— 只有此时树上才是收窄的。 */
  applied: boolean
  keys: readonly string[]
  /** 「不含」那一组（"有 A 且没有 B"里的 B）。 */
  excludeKeys: readonly string[]
  /** 选中键的人类可读写法（`tags_list` 里的首次出现写法；拿不到就退回键）。 */
  labels: readonly string[]
  /** 「不含」那一组的可读写法。 */
  excludeLabels: readonly string[]
  includeSubtags: boolean
  /** 选中键一共展开出多少个子标签（0 = 这个开关当前是空操作）。 */
  subtagCount: number
  /** 可见路径集合（命中笔记 + 祖先目录）；未生效时为 `null`（= 全量）。 */
  visiblePaths: ReadonlySet<string> | null
  /** "只显示 M/N 篇"：M 是可见集合里真实存在的笔记数。 */
  visibleNoteCount: number
  totalNoteCount: number
  /** 命中集合里的笔记数（用来区分"命中为空"与"命中的都不在树里"）。 */
  hitCount: number
  /**
   * 这个 Vault 里"有标签的笔记"总数（宿主 `tag_filter` 一并回报）。
   *
   * 用来把"这些条件下没有笔记"与"这个 Vault 里还没有带标签的笔记"分开说 ——
   * 空态文案含糊是用户最容易误判成"我的笔记丢了"的地方。
   */
  taggedTotal: number
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: MimenoteError | null
  errorText: string
  summaryStatus: 'idle' | 'loading' | 'ready' | 'error'
  summaryErrorText: string
  /** 选中的键已经不在全库标签里（被重命名/合并/删掉）——空树时这是关键线索。 */
  missingKeys: readonly string[]
  /** 命中了笔记，但一篇都不在当前条目表里（通常刚重扫/刚改名）。 */
  hitsOutsideTree: boolean
  /** 当前打开的笔记（编辑器里那篇）。 */
  openRelPath: string | null
  /** 当前打开的笔记不在命中结果里（树里找不到它 —— 说出来，别让用户以为记录丢了）。 */
  openNoteHidden: boolean
}

export function useTagFilterView(options: { autoRefresh?: boolean } = {}): TagFilterView {
  const autoRefresh = options.autoRefresh === true

  const keys = useTagFilterStore((state) => state.keys)
  const excludeKeys = useTagFilterStore((state) => state.excludeKeys)
  const includeSubtags = useTagFilterStore((state) => state.includeSubtags)
  const hits = useTagFilterStore((state) => state.hits)
  const hitsSignature = useTagFilterStore((state) => state.hitsSignature)
  const status = useTagFilterStore((state) => state.status)
  const error = useTagFilterStore((state) => state.error)
  const summary = useTagFilterStore((state) => state.summary)
  const summaryStatus = useTagFilterStore((state) => state.summaryStatus)
  const summaryError = useTagFilterStore((state) => state.summaryError)
  const taggedTotal = useTagFilterStore((state) => state.taggedTotal)
  const syncWithVault = useTagFilterStore((state) => state.syncWithVault)

  const entries = useVaultStore((state) => state.entries)
  const tree = useVaultStore((state) => state.tree)
  const openRelPath = useNoteStore((state) => state.doc?.relPath ?? null)

  useEffect(() => {
    if (!autoRefresh) return
    syncWithVault(tree)
  }, [autoRefresh, tree, syncWithVault])

  /** 当前条件（含 / 不含 + 层级）：指纹、是否生效、是否有内容都从它派生。 */
  const query: TagFilterQuery = useMemo(
    () => ({ any: keys, none: excludeKeys, includeChildren: includeSubtags }),
    [keys, excludeKeys, includeSubtags],
  )

  const applied =
    status === 'ready' && hitsSignature !== '' && hitsSignature === tagFilterSignature(query)

  const visiblePaths = useMemo(
    () => (applied ? tagFilterVisiblePaths(hits) : null),
    [applied, hits],
  )
  const totalNoteCount = useMemo(() => countMarkdownEntries(entries), [entries])
  const visibleNoteCount = useMemo(
    () =>
      visiblePaths === null ? totalNoteCount : countVisibleNotes(visiblePaths, entries),
    [visiblePaths, entries, totalNoteCount],
  )
  const hitCount = useMemo(() => countTagHitNotes(hits), [hits])

  const labels = useMemo(
    () => keys.map((key) => summary.find((item) => item.key === key)?.tag ?? key),
    [keys, summary],
  )

  /** 「不含」那一组的可读写法。 */
  const excludeLabels = useMemo(
    () => excludeKeys.map((key) => summary.find((item) => item.key === key)?.tag ?? key),
    [excludeKeys, summary],
  )

  /**
   * 「含子标签」当前会多查几个键：0 表示选中键没有子标签（开关是空操作）。
   * 界面据此把开关置灰并说明原因 —— 一个点了没反应的开关比禁用更难懂。
   */
  const subtagCount = useMemo(() => {
    if (keys.length === 0) return 0
    const allKeys = summary.map((item) => item.key)
    return keys.reduce((total, key) => total + descendantTagKeys(allKeys, key).length, 0)
  }, [keys, summary])

  const missingKeys = useMemo(() => {
    if (keys.length === 0 || summaryStatus !== 'ready') return []
    return keys.filter((key) => !summary.some((item) => item.key === key))
  }, [keys, summary, summaryStatus])

  return {
    active: !isTagFilterQueryEmpty(query),
    applied,
    keys,
    excludeKeys,
    labels,
    excludeLabels,
    includeSubtags,
    subtagCount,
    visiblePaths,
    visibleNoteCount,
    totalNoteCount,
    hitCount,
    taggedTotal,
    status,
    error,
    errorText: tagFilterErrorMessage(error),
    summaryStatus,
    summaryErrorText: tagFilterErrorMessage(summaryError),
    missingKeys,
    hitsOutsideTree: applied && hitCount > 0 && visibleNoteCount === 0,
    openRelPath,
    openNoteHidden:
      visiblePaths !== null && openRelPath !== null && !visiblePaths.has(openRelPath),
  }
}
