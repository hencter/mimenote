/**
 * 按标签收窄文件树：标签命中集合 → 可见路径集合（纯函数，可单测）。
 *
 * ## 为什么单独一层纯函数
 * 宿主的标签接口只有"问**一个**标签下有哪些笔记"（`tag_notes`，精确匹配、**不含子标签**、
 * 也没有批量的写法），所以"选中的标签 → 命中笔记集合"必须在前端拼出来。拼接规则
 * （层级怎么算、多选是并还是交）容易写错，又必须与界面上那行说明文字**逐字对上**，
 * 因此放在这里用单测钉住，组件只负责接线。
 *
 * ## 行为契约（与界面上的提示同源）
 * 1. **无选中 = 不过滤**：空集合返回空结果，调用方据此走原路径，一个像素都不变；
 * 2. **多选 = 并集（`or`）**：任一选中标签命中即显示。理由见 {@link TAG_MATCH_MODE}；
 * 3. **层级**：`#父/子` 是 `#父` 的子标签（`/` 就是层级，`tags_list` 的键已归一化）。
 *    选 `#父` 时**是否**把它算进来由"含子标签"开关决定（默认开），
 *    界面上的「含子标签」按钮与它一对一；
 * 4. **保留祖先目录**：命中笔记的每一级祖先目录都可见，与搜索框的"过滤保留祖先"同一规则；
 * 5. **空目录不显示**：见下面对 {@link tagFilterVisiblePaths} 的不变式说明；
 * 6. **只收窄，不改动**：本模块只产出"哪些路径可见"，不产生任何写操作。
 */

import type { EntryMeta } from '@/ipc/types'
import { isMarkdown, parentOf } from './paths'

/**
 * 多选语义：**并集**（任一选中标签命中即显示）。
 *
 * 为什么不是交集（`and`）：在一个标签用量不均衡的大 Vault 里，随手多选两个标签最容易
 * 得到空集，而"空集"在界面上与"过滤坏了"没有区别；并集还顺带省掉一次宿主往返 ——
 * 每个标签的命中集合都已经由 `tag_notes` 给出，合并是纯集合运算。
 *
 * 这里是这条语义的**唯一出处**：界面上的说明文字（`data-tag-filter-hint="or"`）
 * 与它同源，改这里就必须同时改那句话。
 */
export const TAG_MATCH_MODE = 'or' as const

export type TagMatchMode = 'or' | 'and'

/** 选了标签才算"过滤生效"。 */
export function isTagFilterActive(keys: readonly string[]): boolean {
  return keys.length > 0
}

/**
 * `key` 下的全部子标签键（含更深层，如 `父/子/孙`），字典序。
 *
 * 层级就是键里的 `/`，因此"是不是后代"是一次前缀比较 —— 不需要在前端再养一棵标签树，
 * 也不会与服务端的归一化规则不一致（键本来就来自 `tags_list`，已经是归一化后的写法）。
 */
export function descendantTagKeys(allKeys: readonly string[], key: string): string[] {
  if (key === '') return []
  const prefix = `${key}/`
  return allKeys.filter((candidate) => candidate.startsWith(prefix)).sort(comparePaths)
}

/**
 * 选中键 → **真正要问宿主的键集合**：「含子标签」在这里生效。
 *
 * 宿主没有"含子标签"这个入参，所以前端要把它展开成一串**精确**查询（`父` + 每个后代），
 * 再把结果并起来。顺序：先自己、再它的后代（读起来与界面上的层级一致），去重保序。
 */
export function expandTagKeys(
  keys: readonly string[],
  allKeys: readonly string[],
  includeSubtags: boolean,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const key of keys) {
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(key)
    if (!includeSubtags) continue
    for (const child of descendantTagKeys(allKeys, key)) {
      if (seen.has(child)) continue
      seen.add(child)
      out.push(child)
    }
  }
  return out
}

/**
 * 合并多次 `tag_notes` 的结果（并集或交集），结果按路径字典序去重。
 *
 * 传入的每个数组对应**一个键**的命中（含子标签时，键已被 {@link expandTagKeys} 展开）。
 * 交集只用来把"另一种多选口径"钉在测试里，产品路径固定走并集（见 {@link TAG_MATCH_MODE}）。
 */
export function mergeTagHits(
  hitLists: readonly (readonly string[])[],
  mode: TagMatchMode,
): string[] {
  if (hitLists.length === 0) return []
  if (mode === 'and') {
    const sets = hitLists.map((list) => new Set(list))
    const first = sets[0]
    if (first === undefined) return []
    const intersection: string[] = []
    for (const path of first) {
      if (sets.every((set) => set.has(path))) intersection.push(path)
    }
    return intersection.sort(comparePaths)
  }
  const union = new Set<string>()
  for (const list of hitLists) {
    for (const path of list) union.add(path)
  }
  return [...union].sort(comparePaths)
}

/**
 * 命中笔记 + 它们的**全部祖先目录** → 可见路径集合。
 *
 * 祖先用纯路径算术（`parentOf`）推出来，**不查条目表**：这样它就是一个不依赖 Vault 状态的
 * 纯函数；集合里出现一个并不存在的目录也无害（可见行终究来自树本身，树里没有的行不会渲染）。
 *
 * 非 Markdown 的命中在这里被丢掉：宿主的标签索引只索引笔记，但 Mock 适配器（以及未来任何
 * 更宽的索引口径）可能把附件也算进来 —— 过滤视图是"收窄到用了某标签的**笔记**"，
 * 让 `附件/x.txt` 混进来只会让计数（`M 篇`）与眼睛看到的行数对不上。
 *
 * **不变式**（决定了空目录天然不显示）：集合里的目录一定是某条命中笔记的祖先。
 * 因此不存在"命中为空却被留下的目录"，也不需要为"空目录不显示"再写一条判断 ——
 * 那种目录在过滤视图里只会骗人："这里面还有命中"。
 */
export function tagFilterVisiblePaths(hits: readonly string[]): Set<string> {
  const visible = new Set<string>()
  for (const hit of hits) {
    if (!isMarkdown(hit)) continue
    visible.add(hit)
    let parent = parentOf(hit)
    while (parent !== '') {
      visible.add(parent)
      parent = parentOf(parent)
    }
  }
  return visible
}

/** 命中里属于笔记的那些（空态文案要如实说"命中了 N 篇"）。 */
export function countTagHitNotes(hits: readonly string[]): number {
  let total = 0
  for (const hit of hits) {
    if (isMarkdown(hit)) total += 1
  }
  return total
}

/** 条目表里 Markdown 笔记的总数（"只显示 M/**N** 篇"里的分母）。 */
export function countMarkdownEntries(entries: readonly EntryMeta[]): number {
  let total = 0
  for (const entry of entries) {
    if (!entry.isDir && isMarkdown(entry.relPath)) total += 1
  }
  return total
}

/**
 * 可见集合里、**当前条目表里真的存在**的笔记数（"只显示 M / N 篇"里的分子 M）。
 *
 * 分母与分子都从同一份条目表算：混用 Vault 概要里的 `noteCount`（宿主口径）会得到
 * "2/9 篇"里分母是 9、而树里其实只有 8 篇这类自相矛盾的数字。
 */
export function countVisibleNotes(
  visible: ReadonlySet<string>,
  entries: readonly EntryMeta[],
): number {
  let total = 0
  for (const entry of entries) {
    if (!entry.isDir && isMarkdown(entry.relPath) && visible.has(entry.relPath)) total += 1
  }
  return total
}

/**
 * 过滤条件的指纹：用来判断"当前命中集合是不是这批选中标签算出来的"。
 *
 * 键排过序：选标签的**先后顺序**不影响结果，也就不该让结果过期（否则点两次同一个标签顺序一变
 * 就会白跑一轮 IPC）。空选中返回空串，调用方据此判定"未生效"。
 */
export function tagFilterSignature(keys: readonly string[], includeSubtags: boolean): string {
  if (keys.length === 0) return ''
  return `${includeSubtags ? 'sub' : 'self'}|${[...keys].sort(comparePaths).join('\u0000')}`
}

/** 路径比较：与 `localeCompare` 无关的稳定字典序（只用于让输出确定，不用于展示）。 */
function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
