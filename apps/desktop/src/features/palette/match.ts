/**
 * 命令面板 / 快速切换的**匹配与索引**（纯函数，不依赖 React / store / IPC）。
 *
 * 单独成模块的原因：面板的交互只有几十行，真正的算法都在这里 —— 拆出来既能单测，
 * 也方便把同一套匹配复用到全文搜索面板（M2 已接入：{@link substringMatchIndices}）。
 *
 * 性能约束（architecture.md §6 的 1 万笔记基线）：
 *
 * 1. **索引只在数据变化时派生一次**：`build*Index` 由调用方 `useMemo` 包住
 *    （命令表变化 / Vault 变化才重算），把「小写化、文件名起点、排序」这些
 *    与查询无关的开销从按键路径上挪走。
 * 2. **每次按键只做一次 O(n) 扫描**：`filter*` 对索引线性遍历，命中即早退
 *    （子序列在某个字符上凑不齐就立刻放弃，不再往下看）。
 * 3. **不做 DP 最优对齐**：最优对齐是 O(L·Q)，1 万条目下每次按键都要重跑，
 *    换来的只是高亮"更好看"一点 —— 代价远大于收益。这里用贪心扫描 O(L)，
 *    而贪心最左匹配对"子序列是否存在"的判断本来就是完备的（存在即命中）。
 * 4. **不引入 fuzzy 库**：仓库的依赖策略是逐个登记理由与许可证
 *    （docs/dependencies.md），而子序列匹配本身只有十几行。
 * 5. **只渲染前 N 条**：命中项按分数排序后切片（见 {@link MAX_PALETTE_RESULTS}），
 *    未命中项在扫描阶段就被丢弃，不进入排序。
 *
 * 本机实测（1 万篇笔记 / 2 万条目，Node 环境，含 IPC 之外的纯计算）：
 *
 * | 步骤 | 耗时 | 触发频率 |
 * | --- | --- | --- |
 * | `buildNoteIndex` | 约 22~32 ms | 每次 Vault 变化（不是每次打开面板） |
 * | `filterNotes` 全命中（最坏） | 约 3~6 ms | 每次按键 |
 * | `filterNotes` 少命中 | 约 2~3 ms | 每次按键 |
 * | `filterNotes` 空查询 | < 0.2 ms | 面板刚打开那一帧 |
 * | `filterCommands` | < 0.3 ms | 每次按键 |
 *
 * 也就是说按键路径上最坏约 6ms，仍在"输入延迟 ≤ 16ms"的预算内（architecture.md §6）。
 */

import type { Command } from '@/app/commands'
import { formatChord } from '@/app/commands'
import { displayName, displayPath, isMarkdown } from '@/domain/paths'
import type { EntryMeta } from '@/ipc/types'

/** 面板一次最多渲染多少条（其余只在提示里报"还有 N 条"）。 */
export const MAX_PALETTE_RESULTS = 50

/** 共享的空下标数组：空查询 / 未命中时复用，避免每次按键都分配。 */
const NO_INDICES: readonly number[] = []

/** 标题命中比分类 / ID 命中更"贴近用户的意图"。 */
const TITLE_WEIGHT = 20
/** 命中落在文件名（而不是目录）里时加分：用户按名字找笔记是常态。 */
const NAME_WEIGHT = 20
/** 连续命中加分。 */
const CONSECUTIVE_BONUS = 8
/** 命中词首（路径段开头、`-`/`_`/`.`/空格之后）加分。 */
const WORD_START_BONUS = 6
/** 命中于整串开头加分。 */
const START_BONUS = 12
/**
 * 长度惩罚：相同命中质量时，短标题 / 短路径更可能是用户想要的
 * （`日记/2025-01-01.md` 打"日记"应该排在 `很长的目录/日记/…` 前面）。
 */
const LENGTH_PENALTY_DIVISOR = 12

export interface FuzzyMatch {
  /** 命中字符在原文中的下标（升序），供高亮使用。 */
  indices: readonly number[]
  /** 相对分数：只用于排序，没有绝对含义。 */
  score: number
}

/** 面板结果：渲染前 `limit` 条 + 命中总数（总数用于"还有 N 条未显示"）。 */
export interface PaletteOutcome<T> {
  items: T[]
  total: number
}

// ---------------------------------------------------------------------------
// 子序列匹配
// ---------------------------------------------------------------------------

/** 判定某个下标是否是"词首"（路径段 / 单词的开头）。 */
function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true
  switch (text.charCodeAt(index - 1)) {
    case 32: // 空格
    case 45: // -
    case 46: // .
    case 47: // /
    case 92: // \
    case 95: // _
      return true
    default:
      return false
  }
}

/**
 * 子序列模糊匹配。
 *
 * `lowerText` / `lowerQuery` 必须**已经小写化**（调用方在索引里预计算，
 * 避免每次按键对 1 万条路径重复 `toLowerCase`）。
 *
 * 复杂度：O(L)（L = 文本长度，逐字符扫描、凑不齐即返回 null），
 * 最坏情况（全部字符都参与）也只是一趟，不做任何回溯。
 */
export function fuzzyMatch(lowerText: string, lowerQuery: string): FuzzyMatch | null {
  if (lowerQuery === '') return { indices: NO_INDICES, score: 0 }

  const indices: number[] = []
  let score = 0
  let cursor = 0

  for (let q = 0; q < lowerQuery.length; q += 1) {
    const target = lowerQuery.charCodeAt(q)
    let found = -1
    while (cursor < lowerText.length) {
      if (lowerText.charCodeAt(cursor) === target) {
        found = cursor
        break
      }
      cursor += 1
    }
    if (found === -1) return null

    indices.push(found)
    score += 1
    if (found === 0) score += START_BONUS
    else if (isWordStart(lowerText, found)) score += WORD_START_BONUS

    const previous = indices[indices.length - 2]
    if (previous !== undefined && previous === found - 1) score += CONSECUTIVE_BONUS

    cursor = found + 1
  }

  score -= Math.floor(lowerText.length / LENGTH_PENALTY_DIVISOR)
  return { indices, score }
}

/**
 * 子串高亮：把 `query` 在 `text` 里**所有**大小写不敏感的出现位置展开成下标数组。
 *
 * 为什么不能复用 {@link fuzzyMatch}：后者的语义是"子序列命中"（打 `切主` 也能命中
 * 「切换主题」），而全文搜索的宿主语义是**子串**匹配（FTS5 → 近似为逐行
 * `toLowerCase().includes()`）。用子序列去标子串结果，会把高亮打在用户根本没搜到的
 * 位置之间，看起来像 bug。
 *
 * 复杂度：O(L)（`indexOf` 逐个跳，不回溯）；只在渲染前 N 条结果时调用，可忽略。
 */
export function substringMatchIndices(text: string, query: string): readonly number[] {
  if (query === '') return NO_INDICES

  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  // 极端 Unicode 情况（例如 'İ'.toLowerCase() 长度变成 2）会让小写串与原文下标错位。
  // 这时退回大小写敏感匹配：宁可不命中，也不要把 `<mark>` 标在错误的字符上。
  const aligned = lowerText.length === text.length && lowerQuery.length === query.length
  const haystack = aligned ? lowerText : text
  const needle = aligned ? lowerQuery : query

  const indices: number[] = []
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    for (let index = at; index < at + needle.length; index += 1) indices.push(index)
    at = haystack.indexOf(needle, at + needle.length)
  }
  return indices
}

// ---------------------------------------------------------------------------
// 命令索引（命令面板的数据源 = 命令注册表）
// ---------------------------------------------------------------------------

/** 命令的预计算索引项（与查询无关，只在命令表变化 / 面板打开时构建一次）。 */
export interface CommandIndexEntry {
  id: string
  title: string
  category: string
  /** 展示用快捷键（已按平台格式化），无快捷键为 `null`。 */
  keybindingLabel: string | null
  /** `when()` 的判定结果快照；真正执行时注册表还会再判一次。 */
  enabled: boolean
  /** 不可用时的展示原因（见 `Command.unavailableReason`）。 */
  disabledReason: string | null
  lowerTitle: string
  lowerCategory: string
  lowerId: string
}

export interface RankedCommand {
  entry: CommandIndexEntry
  /** 标题与分类的高亮下标（未命中的那个为空数组）。 */
  titleIndices: readonly number[]
  categoryIndices: readonly number[]
}

/**
 * 构建命令索引。
 *
 * 复杂度：O(m·L)（m = 命令数，通常几十条；L 为标题长度），只在面板打开 /
 * 命令表变化时执行一次。`when()` 在这里求值一次作为展示快照。
 */
export function buildCommandIndex(list: readonly Command[]): CommandIndexEntry[] {
  return list.map((command) => {
    const keybinding = Array.isArray(command.keybinding)
      ? (command.keybinding[0] ?? null)
      : (command.keybinding ?? null)
    return {
      id: command.id,
      title: command.title,
      category: command.category,
      keybindingLabel: keybinding === null ? null : formatChord(keybinding),
      enabled: command.when?.() ?? true,
      disabledReason: command.unavailableReason ?? null,
      lowerTitle: command.title.toLowerCase(),
      // 只把**分类**（而不是分类 + ID）当作可高亮的次字段：
      // 高亮下标必须与渲染出来的那段文字一一对应，否则标记会错位。
      lowerCategory: command.category.toLowerCase(),
      lowerId: command.id.toLowerCase(),
    }
  })
}

/**
 * 过滤命令。
 *
 * 复杂度：空查询 O(1)（直接切片，这是面板刚打开那一帧）；非空查询 O(m·L) 单次扫描
 * + O(k log k) 排序（k = 命中数，只对命中项排序）。
 */
export function filterCommands(
  index: readonly CommandIndexEntry[],
  lowerQuery: string,
  limit = MAX_PALETTE_RESULTS,
): PaletteOutcome<RankedCommand> {
  if (lowerQuery === '') {
    return {
      items: index
        .slice(0, limit)
        .map((entry) => ({ entry, titleIndices: NO_INDICES, categoryIndices: NO_INDICES })),
      total: index.length,
    }
  }

  const candidates: Array<RankedCommand & { score: number }> = []
  for (const entry of index) {
    const titleMatch = fuzzyMatch(entry.lowerTitle, lowerQuery)
    const categoryMatch = fuzzyMatch(entry.lowerCategory, lowerQuery)
    // ID 也参与匹配（方便按 `theme.next` 这类稳定 ID 找命令），但它不参与高亮：
    // ID 不在列表里显示，给它下标没有意义。
    const idMatch = titleMatch === null && categoryMatch === null
      ? fuzzyMatch(entry.lowerId, lowerQuery)
      : null

    if (titleMatch === null && categoryMatch === null && idMatch === null) continue

    const score = Math.max(
      titleMatch === null ? Number.NEGATIVE_INFINITY : titleMatch.score + TITLE_WEIGHT,
      categoryMatch?.score ?? Number.NEGATIVE_INFINITY,
      idMatch?.score ?? Number.NEGATIVE_INFINITY,
    )

    candidates.push({
      entry,
      titleIndices: titleMatch?.indices ?? NO_INDICES,
      categoryIndices: categoryMatch?.indices ?? NO_INDICES,
      score,
    })
  }

  // Array.prototype.sort 是稳定排序：同分时保持注册表顺序（分类 + 标题），结果可预期
  candidates.sort((a, b) => b.score - a.score)
  return {
    items: candidates.slice(0, limit).map(({ entry, titleIndices, categoryIndices }) => ({
      entry,
      titleIndices,
      categoryIndices,
    })),
    total: candidates.length,
  }
}

// ---------------------------------------------------------------------------
// 笔记索引（快速切换的数据源 = vault-store 的 entries）
// ---------------------------------------------------------------------------

/**
 * 笔记的预计算索引项（与查询无关）。
 *
 * `relPath` 是**身份**（打开哪一篇、`data-rel-path` 用什么），`displayPath` 才是
 * 被匹配与被渲染的字符串 —— 界面上不显示 `.md`（ADR-0030），而高亮下标必须落在
 * **看得见的那串字符**上：拿 relPath 去匹配、把结尾三个字符藏起来的话，
 * 用户搜 "md" 会得到一串指向不存在位置的空 `<mark>`。
 */
export interface NoteIndexEntry {
  relPath: string
  /** 显示用路径（笔记不带扩展名），既是匹配目标也是渲染文本。 */
  displayPath: string
  lowerPath: string
  /** 文件名在 `displayPath` 中的起始下标（用于"文件名命中优先"的加分）。 */
  nameStart: number
}

export interface RankedNote {
  relPath: string
  /** 与 `NoteIndexEntry.displayPath` 同一串字符（渲染与高亮都用它）。 */
  displayPath: string
  /** 命中字符在 `displayPath` 中的下标（渲染时按连续段合并成 `<mark>`）。 */
  indices: readonly number[]
}

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

/**
 * 从 Vault 条目表派生「笔记索引」。
 *
 * - **只收 Markdown 笔记**：判定沿用仓库既有约定 {@link isMarkdown}（`domain/paths`），
 *   不再用 `entry.ext` 自己判一次，避免两处规则漂移；目录一并排除。
 * - 复杂度：O(n) 过滤 + O(n log n) 排序。**只在 Vault 变化时执行一次**：
 *   排序换来的是"空查询下顺序稳定且符合直觉"（中文按拼音、数字按自然序），
 *   而每次按键都排序才是要避免的事。实测 1 万篇笔记约 22~32ms，其中大头是
 *   ICU collator 排序（约 10~15ms）；把它放到每次打开面板都会卸载重建的组件里，
 *   就等于每次 Ctrl+P 都白付这笔钱（见 `PaletteHost` 的注释）。
 */
export function buildNoteIndex(entries: readonly EntryMeta[]): NoteIndexEntry[] {
  const items: NoteIndexEntry[] = []
  for (const entry of entries) {
    if (entry.isDir) continue
    if (!isMarkdown(entry.relPath)) continue
    const shown = displayPath(entry.relPath)
    const lowerPath = shown.toLowerCase()
    items.push({
      relPath: entry.relPath,
      displayPath: shown,
      lowerPath,
      nameStart: Math.max(0, lowerPath.length - displayName(entry.relPath).toLowerCase().length),
    })
  }
  items.sort((a, b) => collator.compare(a.relPath, b.relPath))
  return items
}

/**
 * 过滤笔记。
 *
 * 复杂度：空查询 O(1) 切片；非空查询 O(n·L) 单次扫描 + O(k log k) 排序（仅命中项）。
 */
export function filterNotes(
  index: readonly NoteIndexEntry[],
  lowerQuery: string,
  limit = MAX_PALETTE_RESULTS,
): PaletteOutcome<RankedNote> {
  if (lowerQuery === '') {
    return {
      items: index.slice(0, limit).map((entry) => ({ relPath: entry.relPath, displayPath: entry.displayPath, indices: NO_INDICES })),
      total: index.length,
    }
  }

  const candidates: Array<RankedNote & { score: number }> = []
  for (const entry of index) {
    const match = fuzzyMatch(entry.lowerPath, lowerQuery)
    if (match === null) continue
    const first = match.indices[0]
    const inName = first !== undefined && first >= entry.nameStart
    candidates.push({
      relPath: entry.relPath,
      displayPath: entry.displayPath,
      indices: match.indices,
      score: match.score + (inName ? NAME_WEIGHT : 0),
    })
  }

  candidates.sort((a, b) => b.score - a.score)
  return {
    items: candidates.slice(0, limit).map(({ relPath, displayPath: shown, indices }) => ({ relPath, displayPath: shown, indices })),
    total: candidates.length,
  }
}
