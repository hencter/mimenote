/**
 * 图谱里的"定位笔记"：在几千张卡片里找到某一篇并把它摆到视口中央。
 *
 * ## 为什么需要
 * 卡片画布的价值是"看清结构"，但 Vault 到了几千篇之后，"我想看看『设计文档』周围连了什么"
 * 这件事就没法靠拖拽完成了 —— 画布可以缩到 0.25× 纵览，也可以放大逐张看，却缺少
 * **按名字直达**这一步。侧栏的 `Ctrl+P` 是"打开这篇笔记"，而这里的语义是"在画布上找到它"。
 *
 * ## 为什么复用命令面板的匹配器
 * 同一个应用里"输入几个字找一篇笔记"不该有两套手感（子序列匹配、文件名命中优先、
 * 拼音/数字排序）。匹配本身用 `features/palette/match.ts` 的纯函数（`buildNoteIndex` /
 * `filterNotes`），这里只负责把**图谱节点**喂成它认的形状 —— 注意图谱节点比条目表少
 * （被宿主按度数截断过），所以候选集就是"画布上真的有的那些卡片"，这正是不该用
 * `vault-store.entries` 的原因：那会出现"列表里选得中、画布上找不到"的落差。
 */

import { displayName, displayPath } from '@/domain/paths'
import { filterNotes, type NoteIndexEntry, type RankedNote } from '@/features/palette/match'

import type { GraphNode } from '@/ipc/types'

/** 一次最多给出几条候选（下拉列表不做虚拟化，几十条足够选）。 */
export const FIND_LIMIT = 30

/** 定位候选（`indices` 是命中字符在 `displayPath` 里的下标，渲染高亮用）。 */
export interface GraphFindMatch extends RankedNote {
  /** 卡片标题（图谱写的是文件名主干）。 */
  title: string
  /** 所在文件夹（`''` = Vault 根）。 */
  folder: string
}

/** 把图谱节点整理成匹配器认的索引（按路径排序，保证空查询下顺序稳定）。 */
export function buildGraphFindIndex(nodes: readonly GraphNode[]): NoteIndexEntry[] {
  const items: NoteIndexEntry[] = nodes.map((node) => {
    // 匹配与高亮都跑在**显示用路径**上（不带 `.md`），与命令面板同一口径（ADR-0030）
    const shown = displayPath(node.relPath)
    const lowerPath = shown.toLowerCase()
    return {
      relPath: node.relPath,
      displayPath: shown,
      lowerPath,
      // 文件名起点：路径长度 - 路径末段长度。`title` 是主干（可能被宿主换过），
      // 而"文件名命中优先"这条加权是照着**路径**算的，所以用末段而不是 title
      nameStart: Math.max(0, lowerPath.length - displayName(node.relPath).toLowerCase().length),
    }
  })
  items.sort((left, right) =>
    left.relPath < right.relPath ? -1 : left.relPath > right.relPath ? 1 : 0,
  )
  return items
}

/**
 * 按查询串找卡片。
 *
 * 查询为空时返回**全部**卡片的前 {@link FIND_LIMIT} 条（与面板一致：空查询不是"没有结果"，
 * 而是"列出全部，让你挑"）。
 */
export function findGraphMatches(
  index: readonly NoteIndexEntry[],
  query: string,
  nodes: ReadonlyMap<string, GraphNode>,
  limit = FIND_LIMIT,
): GraphFindMatch[] {
  const outcome = filterNotes(index, query.trim().toLowerCase(), limit)
  const matches: GraphFindMatch[] = []
  for (const item of outcome.items) {
    const node = nodes.get(item.relPath)
    if (node === undefined) continue
    matches.push({
      relPath: item.relPath,
      displayPath: item.displayPath,
      indices: item.indices,
      title: node.title === '' ? displayName(node.relPath) : node.title,
      folder: node.folder,
    })
  }
  return matches
}

/**
 * 把某张卡片摆到视口中央所需的视口偏移。
 *
 * 纯函数：输入卡片矩形、视口尺寸与缩放，输出新的 `view.x/y`（缩放不变 ——
 * "定位"不该顺手改用户的缩放级别，那会让人失去方向感）。
 *
 * 坐标系关系：屏幕位置 = 世界坐标 × 缩放 + 偏移，因此让卡片中心落在视口中心就是
 * `offset = 视口中心 - 卡片中心 × 缩放`。
 */
export function centerViewOnCard(
  card: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
  zoom: number,
): { x: number; y: number } {
  const centerX = card.x + card.width / 2
  const centerY = card.y + card.height / 2
  return {
    x: Math.round(viewport.width / 2 - centerX * zoom),
    y: Math.round(viewport.height / 2 - centerY * zoom),
  }
}

/**
 * 一篇笔记的所有祖先文件夹（从最外层到直接父目录）。
 *
 * 定位到一张卡片前要先把装着它的容器**展开**：折叠状态下的卡片不在布局里，
 * 找不到就会给用户"明明有这篇笔记却定位不到"的错觉。
 */
export function ancestorFolders(relPath: string): string[] {
  const parts = relPath.split('/')
  parts.pop()
  const ancestors: string[] = []
  let current = ''
  for (const part of parts) {
    current = current === '' ? part : `${current}/${part}`
    ancestors.push(current)
  }
  return ancestors
}
