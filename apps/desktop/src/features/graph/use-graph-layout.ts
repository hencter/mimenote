/**
 * 图谱的**布局与几何 memo**（hook）。
 *
 * 一句话职责：算出"哪些卡片在哪、容器多大" —— 全库视图的文件夹装箱布局 + 手工位置覆盖 +
 * 矩形索引，以及焦点视图的同心环布局 + 每张卡片的正文排版。
 *
 * 为什么单独成 hook：这些全是纯函数与 `useMemo` 的组合，输入只有数据与折叠/尺寸/正文偏好，
 * 与 canvas、指针、力场都无关（那些在 `canvas-api.ts` / `use-canvas-input.ts` /
 * `use-force-sim.ts` 里）。**平移与缩放不会让这里重算**（只有数据/折叠/尺寸/正文变了才重算）——
 * 这是画布流畅的前提，所以它必须与"视口换算"分开住。
 *
 * 焦点视图的几何顺序不可反：环半径取决于"卡片有多大"，而卡片高度取决于正文排完有多高；
 * 正文是跟着子图一次性回来的，因此不会出现"排版到一半、环半径反复变"的跳动。
 */

import { useMemo } from 'react'
import type { RefObject } from 'react'

import type { GraphData } from '@/ipc/types'
import { applyManualPositions, buildLayout, buildRectIndex, type GraphCardBox, type Point } from '@/domain/graph/layout'
import { layoutEgo, type EgoSize } from '@/domain/graph/layout-ego'
import type { CardSize, EgoSnapshot, GraphMode } from '@/state/graph-store'

import { createCardLayoutCache, layoutCard, titleOnlyCardHeight, type CardLayout, type MeasureText } from './canvas/measure'

/** 焦点视图的卡片宽度（世界坐标）：一屏放得下 3~4 张，正文一行 ≈ 34 个汉字。 */
const EGO_CARD_WIDTH = 320

/**
 * 焦点视图卡片的高度上限。
 *
 * 为什么要有上限：一篇长笔记排完可能有两千像素高，一张卡片就能把整个环撑到屏幕外，
 * 于是"离中心几跳"这个唯一的信息反而看不见了。超出就按**块**截断（`layoutCard` 会在末尾补一行 `…`）。
 */
const EGO_CARD_MAX_HEIGHT = 420

/** 正文还没读到的节点（读失败、或刚好被删）用这个尺寸占位：比空白好，也不会让环半径乱跳。 */
const EGO_FALLBACK_SIZE: EgoSize = { width: EGO_CARD_WIDTH, height: 76 }

export function useGraphLayout(input: {
  mode: GraphMode
  data: GraphData | null
  collapsed: ReadonlySet<string>
  manual: ReadonlyMap<string, Point>
  ego: EgoSnapshot | null
  texts: ReadonlyMap<string, string>
  cardSizes: ReadonlyMap<string, CardSize>
  titleOnly: boolean
  measure: MeasureText | null
  /** 量字上下文与排版缓存（由 `canvas-api.ts` 的 frame hook 创建，全画布共用一份）。 */
  layoutRef: RefObject<{ measure: MeasureText; cache: ReturnType<typeof createCardLayoutCache> } | null>
}) {
  const { mode, data, collapsed, manual, ego, texts, cardSizes, titleOnly, measure, layoutRef } = input

  const autoLayout = useMemo(
    () => (mode === 'vault' && data !== null ? buildLayout(data.nodes, collapsed) : null),
    [mode, data, collapsed],
  )
  // 手工位置是 O(n) 的坐标覆盖（不重建文件夹树），拖动时只有这一步会重跑
  const vaultLayout = useMemo(
    () => (autoLayout === null ? null : applyManualPositions(autoLayout, manual)),
    [autoLayout, manual],
  )

  const cardsById = useMemo(() => {
    const map = new Map<string, GraphCardBox>()
    for (const card of vaultLayout?.cards ?? []) map.set(card.relPath, card)
    return map
  }, [vaultLayout])

  const rectIndex = useMemo(
    () => (vaultLayout === null ? null : buildRectIndex(vaultLayout.cards)),
    [vaultLayout],
  )

  /**
   * 焦点视图的几何：先把每篇正文排成卡片（尺寸由此得出），再摆同心环。
   *
   * 顺序不能反：环半径取决于"卡片有多大"，而卡片高度取决于正文排完有多高。
   * 正文是**一次性**跟着子图回来的（`loadEgo` 一起读），所以这里不会出现"排版到一半、
   * 环半径反复变"的跳动 —— 只有读不到正文的那几篇用兜底尺寸。
   *
   * 每张卡片的宽度与"正文高度上限"都取自 store 里的**手工尺寸**（可调大小，ADR-0023）：
   * 用户拉宽一张卡片之后，这里排出来的高度会跟着变（换行变了），环半径也随之外扩。
   */
  const egoLayout = useMemo(() => {
    if (mode !== 'focus' || ego === null || measure === null || layoutRef.current === null) return null
    const cache = layoutRef.current.cache
    const sizes = new Map<string, EgoSize>()
    const layouts = new Map<string, CardLayout>()

    for (const node of ego.data.nodes) {
      const manual = cardSizes.get(node.relPath)
      const width = manual?.width ?? EGO_CARD_WIDTH
      // 纯标题模式：不排正文（layouts 里刻意没有它，画笔退成"只有标题行"的壳）。
      // 高度由同一份壳几何推出（`titleOnlyCardHeight`），不手写数字；
      // 正文排版（markdown 解析 + 折行）的开销这一模式下全省掉。
      if (titleOnly) {
        sizes.set(node.relPath, { width, height: titleOnlyCardHeight() })
        continue
      }
      const text = texts.get(node.relPath)
      if (text === undefined) {
        sizes.set(node.relPath, EGO_FALLBACK_SIZE)
        continue
      }
      // 「全文」开关：不截断（`layoutCard` 对非有限上限按"不截断"处理，缓存键也随之分开）。
      // 长文的卡片会非常高 —— 这正是用户要的效果（"卡片完整展示全文"）。
      const maxHeight =
        manual?.full === true ? Number.POSITIVE_INFINITY : (manual?.height ?? EGO_CARD_MAX_HEIGHT)
      const card = cache.get(
        { relPath: node.relPath, title: node.title, text, width, maxHeight },
        () =>
          layoutCard({
            relPath: node.relPath,
            title: node.title,
            text,
            width,
            maxHeight,
            measure,
          }),
      )
      layouts.set(node.relPath, card)
      sizes.set(node.relPath, { width: card.width, height: card.height })
    }

    const layout = layoutEgo({
      nodes: ego.data.nodes,
      edges: ego.data.edges,
      root: ego.root,
      depth: ego.depth,
      sizes,
      fallbackSize: EGO_FALLBACK_SIZE,
    })
    return { layout, layouts }
  }, [mode, ego, texts, measure, cardSizes, titleOnly])

  return { autoLayout, vaultLayout, cardsById, rectIndex, egoLayout }
}
