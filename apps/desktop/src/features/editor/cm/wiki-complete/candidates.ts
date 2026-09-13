/**
 * `[[` 补全的**候选索引与排序**（纯函数：不 import React / Zustand / CodeMirror / DOM）。
 *
 * ## 为什么单独成模块
 * "敲 `[[` 之后列什么、按什么顺序列"是这一整块功能里唯一有算法含量的部分，
 * 而它完全由 `vault-store` 的条目表决定（条目表**已经在内存里**，不需要新 IPC）。
 * 拆成纯函数之后，"1 万条时每次按键的代价"可以在 vitest 里直接量（见
 * `tests/editor-wikilink-complete-perf.test.ts`），排序口径也能逐条钉死。
 *
 * ## 三条性能纪律（architecture.md §6 的"输入延迟 ≤ 16ms"）
 * 1. **索引只在条目表换新数组时重建**（{@link buildWikilinkIndex}），按键路径上只做
 *    一次 O(n) 扫描 —— 与 `features/palette/match.ts` 的 `buildNoteIndex` / `filterNotes`
 *    是同一套分工（那里是面板打开时派生一次）；
 * 2. **空查询不排序**：刚敲下 `[[` 的那一帧查询是空串，此时"命中"是全库，
 *    对 1 万条排序是纯粹白付的代价。索引在构建时就把"路径更短 → 字典序"这一档排好
 *    （{@link WikilinkIndex.byPath}），并额外按下标分桶（{@link WikilinkIndex.byDir}），
 *    于是空查询只需要"先取同目录那桶、再沿着预排序表补齐"即可，O(同目录条数 + N)；
 * 3. **插入目标只给渲染出来的那 N 条算**：`relativeAssetHref` 要拼字符串，
 *    1 万条全算一遍就白花了；而这个值只有列表里看得见的那几行才需要。
 *
 * ## 排序口径与宿主解析一致（`crates/mn-index` 的 `resolve_target` / `pick_candidate`）
 * 同名多篇时宿主按"**同目录 → 路径更短 → 字典序**"挑一个。列表必须与它同序，
 * 否则会出现"列表第一项 ≠ `[[这个名字]]` 实际指向的那一篇"这种最难解释的错位。
 * 于是分数只算**文件名**（同一名字的若干篇分数必然相同），把消歧规则留给并列时的名次：
 *
 * | 名次 | 依据 |
 * | --- | --- |
 * | 1 | 命中层级：完全同名(0) → 文件名子序列(1) → 路径子序列(2) |
 * | 2 | 匹配分（同层同名时必然并列） |
 * | 3 | 同目录优先（与宿主一致：当前笔记在 Vault 根时**不**启用这一档） |
 * | 4 | 路径更短优先（按**字符**数，与 Rust 的 `chars().count()` 同口径） |
 * | 5 | 字典序 |
 *
 * 层级 0 的存在是为了让"列表第一项 = `[[你打的字]]` 会解析到的那一篇"成为**定理**而不是巧合：
 * 完全同名的一批分数必然相同，于是第 3~5 档就是宿主的 `pick_candidate` 本体。
 * 反过来，若把"文件名命中"和"路径命中"混在一个分数体系里比较，
 * `设计文档.md` 完全可能靠分数压过 `[[设计]]` 真正指向的 `设计.md`。
 */

import { relativeAssetHref } from '@/domain/attachments'
import { basename, extensionOf, isMarkdown, parentOf, stem } from '@/domain/paths'
import { fuzzyMatch } from '@/features/palette/match'
import type { EntryMeta } from '@/ipc/types'

/**
 * 列表里最多渲染多少条。
 *
 * 与命令面板的 `MAX_PALETTE_RESULTS` 同一个数量级：多出来的只在页脚里报个数
 * （"还有 N 条，继续输入以缩小范围"），不进入 DOM。
 */
export const MAX_WIKILINK_ITEMS = 50

/** 索引里的一个候选（全部字段与查询无关，构建时算一次）。 */
export interface WikilinkIndexEntry {
  /** Vault 相对路径（含扩展名）。 */
  relPath: string
  /** 小写路径（子序列匹配用；调用方在索引里预计算，避免每次按键 `toLowerCase`）。 */
  lowerPath: string
  /**
   * 消歧与匹配用的名字键（**小写**）：笔记 = 文件名主干（去扩展名），附件 = 完整文件名。
   *
   * 为什么两者口径不同：`[[设计]]` 解析的是**主干**（`normalize_target` 会去掉 `.md`），
   * 而 `![[图.png]]` 解析的是**完整文件名**（`isImageAssetTarget` 要看扩展名）。
   */
  lowerName: string
  /** 名字原文（列表主文本，也是"唯一时直接插入的那段文本"）。 */
  name: string
  /** 插入文档时用的路径形态（笔记去扩展名，附件保留扩展名）。 */
  linkPath: string
  /** 是不是 Markdown 笔记（判定沿用 `domain/paths.isMarkdown`，与命令面板同一处规则）。 */
  isNote: boolean
  /** 所在目录（`''` = Vault 根）。 */
  dir: string
  /** 路径的**字符**数（消歧第 4 档）。 */
  pathLength: number
  /** 全库同名的条目数；`1` = 不冲突。 */
  conflicts: number
}

export interface WikilinkIndex {
  /** 构建顺序（过滤扫描用）。 */
  all: readonly WikilinkIndexEntry[]
  /** 预排序副本：路径更短 → 字典序（消歧第 4、5 档）。 */
  byPath: readonly WikilinkIndexEntry[]
  /** 目录 → 该目录下的条目（沿用 `byPath` 的顺序，用于"同目录优先"那一档）。 */
  byDir: ReadonlyMap<string, readonly WikilinkIndexEntry[]>
}

/**
 * 从 Vault 条目表派生补全索引。
 *
 * 复杂度：O(n log n)（只有一次"按路径长度排序"）+ O(n)。**只在条目表换新数组时执行**
 * —— 打开/重扫 Vault、新建/删除/改名/落附件都会换新数组（`vault-store` 的每个写动作
 * 都是 `[...entries]` 或 `map`），其余时候复用同一个索引对象。
 */
export function buildWikilinkIndex(entries: readonly EntryMeta[]): WikilinkIndex {
  const all: WikilinkIndexEntry[] = []
  const nameCounts = new Map<string, number>()

  for (const entry of entries) {
    // 目录不参与（链接目标是文件）
    if (entry.isDir) continue
    const relPath = entry.relPath
    const name = basename(relPath)
    if (name === '') continue

    const isNote = isMarkdown(relPath)
    const ext = extensionOf(relPath)
    // 笔记：`[[目标]]` 里写的是主干；附件：必须带扩展名，否则 `isImageAssetTarget` 认不出
    const displayName = isNote ? stem(relPath) : name
    if (displayName === '') continue

    const lowerName = displayName.toLowerCase()
    nameCounts.set(lowerName, (nameCounts.get(lowerName) ?? 0) + 1)

    all.push({
      relPath,
      lowerPath: relPath.toLowerCase(),
      lowerName,
      name: displayName,
      linkPath: isNote && ext !== '' ? relPath.slice(0, relPath.length - ext.length - 1) : relPath,
      isNote,
      dir: parentOf(relPath),
      // 用码点个数而不是 `String.length`：与 Rust 的 `chars().count()` 同口径，
      // 否则含 Emoji / 扩展区汉字的路径会在"路径更短"这一档上与宿主给出不同名次
      pathLength: [...relPath].length,
      conflicts: 1, // 第二遍回填
    })
  }

  // 第二遍回填"全库同名数"：冲突提示与"要不要写路径"都由它决定
  for (const entry of all) {
    entry.conflicts = nameCounts.get(entry.lowerName) ?? 1
  }

  // 预排序：只排"与当前笔记无关"的两档（长度、字典序）。同目录那一档在过滤时靠分桶实现，
  // 因为它随当前笔记变化，放进索引里就会让"换笔记"变成"重建索引"。
  const byPath = [...all].sort(compareByPath)
  const byDir = new Map<string, WikilinkIndexEntry[]>()
  for (const entry of byPath) {
    const bucket = byDir.get(entry.dir)
    if (bucket === undefined) byDir.set(entry.dir, [entry])
    else bucket.push(entry)
  }

  return { all, byPath, byDir }
}

/** 消歧规则的后两档（同目录那一档由调用方在过滤时补上）。 */
function compareByPath(a: WikilinkIndexEntry, b: WikilinkIndexEntry): number {
  if (a.pathLength !== b.pathLength) return a.pathLength - b.pathLength
  // 与 Rust 的 `String::cmp`（字节序）在 BMP 内一致；扩展区/私用区混排的极端情况不保证
  return a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0
}

/** 一条候选（列表需要的最小信息，已经与当前笔记绑定）。 */
export interface WikilinkCandidate {
  relPath: string
  /** 列表主文本（笔记主干 / 附件文件名）。 */
  name: string
  /** 列表次文本：Vault 相对路径（同名冲突时用户就是靠它区分的）。 */
  displayPath: string
  /** 全库同名条目数；`> 1` 时列表里给一个提示。 */
  conflicts: number
  /** 确认后写进文档的目标文本（已按消歧规则决定带不带路径）。 */
  target: string
  /** 是不是 `[[名字]]` 默认会解析到的那一篇（同名冲突时用来提示"默认"）。 */
  preferred: boolean
  isNote: boolean
  /** 命中字符在 {@link name} 里的下标（升序；空查询为空）。 */
  indices: readonly number[]
}

export interface WikilinkFilterOptions {
  /** 当前笔记的 Vault 相对路径（决定"同目录优先"与相对目标写法）。 */
  noteRelPath: string | null
  /** 是否处在 `![[` 里（嵌入：附件也要列出来）。 */
  embed: boolean
}

export interface WikilinkOutcome {
  items: WikilinkCandidate[]
  /** 命中总数（可能大于 `items.length`，用于页脚提示）。 */
  total: number
}

const NO_INDICES: readonly number[] = []

/** 过滤 + 排序。复杂度：空查询 O(同目录条数 + N)；非空查询 O(n·L) 扫描 + O(k log k) 排序。 */
export function filterWikilinkCandidates(
  index: WikilinkIndex,
  query: string,
  options: WikilinkFilterOptions,
): WikilinkOutcome {
  const lowerQuery = query.trim().toLowerCase()
  const noteRelPath = options.noteRelPath
  const noteDir = noteRelPath === null ? '' : parentOf(noteRelPath)
  const inScope = (entry: WikilinkIndexEntry): boolean => {
    // 当前笔记自己不进列表：`[[` 之后最容易误按的就是"自己"这一项，而"给自己加链接"
    // 在补全里几乎不是用户此刻的意图（真要写，手打 `[[自己的名字]]` 照样解析、照样渲染）。
    // 这一条也让"刚敲下 `[[` 就回车"永远落到别的笔记上，而不是把当前笔记链回自己
    if (entry.relPath === noteRelPath) return false
    return options.embed || entry.isNote
  }

  if (lowerQuery === '') {
    // 刚敲下 `[[`：按"同目录优先 → 路径更短 → 字典序"取前 N 条。
    // 同目录那桶已经按预排序表的顺序（长度、字典序），所以直接扫就是最终名次
    const items: WikilinkCandidate[] = []
    let total = 0
    if (noteDir !== '') {
      for (const entry of index.byDir.get(noteDir) ?? []) {
        if (!inScope(entry)) continue
        total += 1
        if (items.length < MAX_WIKILINK_ITEMS) items.push(toCandidate(entry, noteRelPath, NO_INDICES))
      }
    }
    for (const entry of index.byPath) {
      // 同目录那桶已经取过，这里跳过（桶与预排序表共用同一批对象引用）
      if (noteDir !== '' && entry.dir === noteDir) continue
      if (!inScope(entry)) continue
      total += 1
      if (items.length < MAX_WIKILINK_ITEMS) items.push(toCandidate(entry, noteRelPath, NO_INDICES))
    }
    return { items, total }
  }

  const matches: Ranked[] = []
  for (const entry of index.all) {
    if (!inScope(entry)) continue
    // 层级 0/1 都算"文件名命中"，差别只在名次（见模块文档的排序表）
    const byName = fuzzyMatch(entry.lowerName, lowerQuery)
    if (byName !== null) {
      matches.push({
        entry,
        tier: entry.lowerName === lowerQuery ? 0 : 1,
        score: byName.score,
        indices: byName.indices,
      })
      continue
    }
    // 退一步匹配整条路径：`日记/2025-01-01` 打"日记"也要能找得到
    const byPath = fuzzyMatch(entry.lowerPath, lowerQuery)
    if (byPath !== null) {
      matches.push({ entry, tier: 2, score: byPath.score, indices: byPath.indices })
    }
  }

  matches.sort((a, b) => compareRanked(a, b, noteDir))
  const items = matches
    .slice(0, MAX_WIKILINK_ITEMS)
    .map((match) => toCandidate(match.entry, noteRelPath, match.indices))
  // 层级 0 的首项就是宿主 `pick_candidate` 会挑中的那一篇（见模块文档）
  const best = items[0]
  if (best !== undefined && matches[0]?.tier === 0 && best.isNote) best.preferred = true

  return { items, total: matches.length }
}

interface Ranked {
  entry: WikilinkIndexEntry
  /** 命中层级：0 = 完全同名，1 = 文件名子序列，2 = 路径子序列。 */
  tier: number
  score: number
  indices: readonly number[]
}

function compareRanked(a: Ranked, b: Ranked, noteDir: string): number {
  if (a.tier !== b.tier) return a.tier - b.tier
  if (a.score !== b.score) return b.score - a.score
  const aSame = noteDir !== '' && a.entry.dir === noteDir
  const bSame = noteDir !== '' && b.entry.dir === noteDir
  if (aSame !== bSame) return aSame ? -1 : 1
  return compareByPath(a.entry, b.entry)
}

function toCandidate(
  entry: WikilinkIndexEntry,
  noteRelPath: string | null,
  indices: readonly number[],
): WikilinkCandidate {
  return {
    relPath: entry.relPath,
    name: entry.name,
    displayPath: entry.relPath,
    conflicts: entry.conflicts,
    target: linkTargetFor(entry, noteRelPath),
    preferred: false,
    isNote: entry.isNote,
    indices,
  }
}

/**
 * 确认后写进文档的目标文本。
 *
 * 规则：**唯一时写裸名**（`[[设计]]` / `![[图.png]]`，与 Obsidian 的手感一致，
 * 也正是 `resolve_target` 的第 2 条规则与 `createAssetResolver` 的全库同名兜底所覆盖的写法）；
 * **同名冲突时写"相对当前笔记目录"的路径**，因为裸名会被消歧规则解析到**别人**身上 ——
 * 那正是"同名多篇必须都能选到"这条要求要防的事。
 *
 * 为什么相对路径（而不是 `/绝对路径`）：`join_relative` 会正确处理 `..`，
 * 于是"相对当前目录"的写法在宿主侧是**精确命中**（先按当前目录拼、命中即返回），
 * 而笔记被移动时它也仍然指向同一个文件 —— 与 `domain/attachments.relativeAssetHref`
 * 的取舍一致（粘贴图片写的就是相对路径）。
 */
function linkTargetFor(entry: WikilinkIndexEntry, noteRelPath: string | null): string {
  if (entry.conflicts <= 1) return entry.name
  if (noteRelPath === null) return entry.linkPath
  return relativeAssetHref(noteRelPath, entry.linkPath)
}
