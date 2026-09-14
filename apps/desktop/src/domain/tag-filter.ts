/**
 * 按标签收窄文件树：标签命中集合 → 可见路径集合（纯函数，可单测）。
 *
 * ## 命中集合从哪来
 * **宿主的 `tag_filter` 命令一次算好**：`含 any 里任意一个 且 不含 none 里任何一个`
 * （可带后代）。在这之前，前端只能一个个标签问 `tag_notes` 再自己合并 ——
 * 而层级标签的"含子标签"要展开成"父 + 每个后代各一次 IPC"（200 个子标签就是 201 次往返），
 * "有 A 且没有 B"更是只能两次查询再相减。现在一次往返，规则也只剩宿主那一处。
 *
 * 这一层因此只做**与界面观感有关的纯计算**：可见路径集合（保留祖先）、计数、条件指纹。
 *
 * ## 行为契约（与界面上的提示同源）
 * 1. **无选中 = 不过滤**：空条件返回空结果，调用方据此走原路径，一个像素都不变；
 * 2. **多选 = 并集**：含的那一组里任一命中即显示（交集不做 —— 标签用量不均衡的大 Vault 里
 *    随手多选最容易得到空集，而"空集"与"过滤坏了"在界面上没有区别）；
 *    **排除是减法**：不含的那一组里任意命中即被剔除，两者可同时用（"有 A 且没有 B"）；
 * 3. **层级**：`#父/子` 是 `#父` 的子标签（`/` 就是层级，`tags_list` 的键已归一化）。
 *    选 `#父` 时**是否**把后代算进来由"含子标签"开关决定（默认开），宿主与这里同一套口径；
 * 4. **保留祖先目录**：命中笔记的每一级祖先目录都可见，与搜索框的"过滤保留祖先"同一规则；
 * 5. **空目录不显示**：见下面对 {@link tagFilterVisiblePaths} 的不变式说明；
 * 6. **只收窄，不改动**：本模块只产出"哪些路径可见"，不产生任何写操作。
 */

import type { EntryMeta } from '@/ipc/types'
import { isMarkdown, parentOf } from './paths'

/** 选了标签才算"过滤生效"（含或排除都算）。 */
export function isTagFilterActive(keys: readonly string[]): boolean {
  return keys.length > 0
}

/**
 * 一次过滤的完整条件（含 / 不含 + 是否带后代）。
 *
 * **这是与宿主 `tag_filter` 命令一一对应的形状**：宿主一次算完"含任意一个且不含任何一个"，
 * 前端不再自己一个个标签问、也不自己相减。理由见 `commands.rs` 里 `tag_filter` 的文档：
 * 层级标签的"含后代"在前端只能展开成"父 + 每个后代各一次 IPC"（200 个子标签 = 201 次往返），
 * 而"有 A 且没有 B"在前端只能两次查询再相减。
 */
export interface TagFilterQuery {
  /** 必须含其中之一（空数组 = 不限制"含"，即全部有标签的笔记）。 */
  any: readonly string[]
  /** 必须**不含**其中任何一个。 */
  none: readonly string[]
  /** `父` 是否也匹配 `父/子`、`父/子/孙`（宿主与这里用同一套 `/` 切段口径）。 */
  includeChildren: boolean
}

/** 条件是否"什么都不限"（此时应当完全不收窄）。 */
export function isTagFilterQueryEmpty(query: TagFilterQuery): boolean {
  return query.any.length === 0 && query.none.length === 0
}

/**
 * 条件的指纹（用来判断"当前的命中集合是不是为这组条件算的"）。
 *
 * 两侧键都排过序：选标签的**先后顺序**不影响结果，也就不该让结果过期（否则点两次同一个标签
 * 顺序一变就会白跑一轮）。空条件是空串 —— 调用方据此判定"未生效"，树保持全量。
 */
export function tagFilterSignature(query: TagFilterQuery): string {
  if (isTagFilterQueryEmpty(query)) return ''
  const any = [...query.any].sort(comparePaths).join('\u0000')
  const none = [...query.none].sort(comparePaths).join('\u0000')
  return `${query.includeChildren ? 'sub' : 'self'}|${any}\u0001${none}`
}

/**
 * 某个键下的全部子标签键（含更深层，如 `父/子/孙`），字典序。
 *
 * 层级就是键里的 `/`，因此"是不是后代"是一次前缀比较 —— 不需要在前端再养一棵标签树，
 * 也不会与服务端的归一化规则不一致（键本来就来自 `tags_list`，已经是归一化后的写法）。
 *
 * **注意**：这条只用于界面上的提示（"含子标签会多算 N 个"）与置灰判断；
 * 真正的过滤在宿主侧按同一套 `/` 切段口径算（`TagIndex::filter_notes`）。
 */
export function descendantTagKeys(allKeys: readonly string[], key: string): string[] {
  if (key === '') return []
  const prefix = `${key}/`
  return allKeys.filter((candidate) => candidate.startsWith(prefix)).sort(comparePaths)
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

/** 路径比较：与 `localeCompare` 无关的稳定字典序（只用于让输出确定，不用于展示）。 */
function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
