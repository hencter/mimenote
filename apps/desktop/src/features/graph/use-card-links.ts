/**
 * 图谱的**连线几何与 wikilink 热区**（hook）。
 *
 * 一句话职责：把"边 + 卡片位置"编译成可直接渲染的 `GraphEdgeVisual[]`，并把卡片正文里
 * 每一段 `[[链接]]` 的热区映射到"它对应的那条边"，供悬停时同时提亮文字与连线。
 *
 * ## 为什么这两件事在一个 hook 里
 *
 * 它们是同一个动作的两半（ADR-0023）：`hoveredLink` 是"指针此刻压在正文的哪一段链接上"，
 * 而 `edgeVisuals` 用它决定"哪条线要提亮"。分开成两个 hook 就得把 `hoveredLink` 再穿一次针，
 * 而"高亮的字"与"高亮的线"必须永远指同一条边 —— 放在一个文件里，这条不变量看得见。
 *
 * ## 两条坐标纪律（拆 hook 时最容易破）
 *
 * 1. **热区存卡片内坐标**：漂浮开着时卡片每帧都在动，世界坐标的热区立刻就过期；
 *    命中测试时再用**当前**矩形（`currentRect`）换算 —— "看到的"与"悬停到的"永远是同一个位置。
 * 2. **命中的是当前矩形**：`hitCard` 与 `currentRect` 都来自力场那一层（共享 `positionsRef`），
 *    本 hook 不自己算位置，也不缓存一份位置。
 */

import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react'

import type { GraphData, GraphEdge, GraphNode } from '@/ipc/types'
import {
  buildEdgeVisuals,
  edgeKey,
  type EdgeStyle,
  type GraphCardBox,
  type GraphEdgeVisual,
  type Point,
  type Rect,
} from '@/domain/graph/layout'
import type { EgoSnapshot, GraphMode } from '@/state/graph-store'

import { DEFAULT_METRICS } from './canvas/text-layout'
import { cardChrome, type MeasureText } from './canvas/measure'
import { outerExit, routeEdgePath, routingKind } from './edge-routing'
import {
  leadPathBetween,
  linkEdgeGeometry,
  linkZones,
  normalizeLinkText,
  type LinkZone,
} from './link-edge'
import { toWorld, type ViewTransform } from '@/domain/graph/viewport'
import type { EgoGeometry } from './use-force-sim'

/** 悬停到的 wikilink 热区：卡片 + 热区矩形 + 对应边的 key（一份状态喂两个消费者）。 */
export type HoveredLink = { relPath: string; zone: LinkZone; edgeKey: string }

/**
 * 跳数 → 线宽 / 不透明度（ADR-0028）。
 *
 * 判据是"这条边最远牵到第几跳"（两端跳数的较大者）：一跳的线最实最粗、越远越细越淡。
 * 为什么用连续的一组数而不是"虚实两档"：环布局里"几跳"是唯一的结构信息，
 * 让线自己把它画出来，比在 tooltip 里写一遍有用得多。
 */
const EDGE_WEIGHT_BY_HOP: readonly { width: number; opacity: number }[] = [
  { width: 2.2, opacity: 0.98 }, // 0：理论上不存在（圆心只有自己），留着占位免得索引错位
  { width: 2, opacity: 0.95 },
  { width: 1.5, opacity: 0.72 },
  { width: 1.25, opacity: 0.55 },
]

/** 更远（4 跳及以上）统一落到最轻的那一档。 */
const EDGE_WEIGHT_FAR = { width: 1, opacity: 0.4 }

/**
 * 淡化 / 强调是**在跳数权重上调制**，而不是替换它。
 *
 * 为什么必须这样：如果"强调"直接把宽度钉成 2.2、"淡化"直接钉成 1/0.16，
 * 那么跳数权重永远看不见 —— 与圆心相关的边全是强调档、环与环之间的边全是淡化档，
 * 而这两档恰好覆盖了所有边（"越远越细越淡"就成了空话，图上没人能看出来）。
 * 乘法还有第二个好处：强调过的二跳边仍然比强调过的一跳边细一点，
 * "这条线牵得多远"在**任何**状态下都还在。
 */
const EDGE_DIM_FACTOR = { width: 0.7, opacity: 0.3, minWidth: 1 }
const EDGE_HIGHLIGHT_GAIN = { minWidth: 2.2, opacity: 0.22 }

function edgeWeight(hop: number): { width: number; opacity: number } {
  return EDGE_WEIGHT_BY_HOP[hop] ?? EDGE_WEIGHT_FAR
}

/**
 * 一条边在正文里**可能**被写成哪几种样子（用于把边匹配到某一段 `[[…]]` 文字）。
 *
 * 三种来源，按"越具体越先试"排：用户写的原始目标（`[[笔记/丙|别名]]` 里那一整段不算、
 * 锚点已经剥离）、目标笔记的标题、以及路径主干（`项目/子项目/细节.md` → `细节`）。
 * 别名那一侧由写笔记的人决定，我们无法穷举 —— 匹配不到就如实降级（ADR-0023）。
 */
function edgeTargets(edge: GraphEdge, to: GraphNode): string[] {
  const basename = (to.relPath.split('/').pop() ?? to.relPath).replace(/\.(md|markdown)$/i, '')
  return [...new Set([edge.toRawTarget, to.title, basename, to.relPath].filter((text) => text !== ''))]
}

/**
 * 两个悬停热区是否同一个（逐字段比较）。
 *
 * 为什么不能靠引用：`linkZones` 的返回每次 memo 重建都换对象引用，引用比较会让
 * `setHoveredLink` 每个 pointermove 都触发一次重渲染 —— 而内容没变时一个像素都不该重画。
 */
function sameHoveredLink(
  a: { relPath: string; zone: LinkZone; edgeKey: string } | null,
  b: { relPath: string; zone: LinkZone; edgeKey: string } | null,
): boolean {
  if (a === null || b === null) return a === b
  return (
    a.relPath === b.relPath &&
    a.edgeKey === b.edgeKey &&
    a.zone.x === b.zone.x &&
    a.zone.y === b.zone.y &&
    a.zone.width === b.zone.width &&
    a.zone.height === b.zone.height
  )
}

export function useCardLinks(input: {
  mode: GraphMode
  /** 纯标题卡片：没有正文排版，自然没有热区可指（连线也如实退成"从卡片边界出发"）。 */
  titleOnly: boolean
  egoLayout: EgoGeometry | null
  ego: EgoSnapshot | null
  data: GraphData | null
  cardsById: ReadonlyMap<string, GraphCardBox>
  selected: string | null
  visibleWorldRect: Rect
  currentRect: (relPath: string) => Rect | null
  tension: number
  edgeFromLink: boolean
  ringRouting: boolean
  measure: MeasureText | null
  /** 位置变化的时钟（漂浮每帧、落定、拖动都会推进它）：热区要跟着当前矩形重算。 */
  tick: number
  transform: ViewTransform
  hitCard: (point: Point) => { relPath: string; rect: Rect } | null
  nodesByPath: ReadonlyMap<string, GraphNode>
  /** 最近一次指针位置（屏幕坐标）：漂浮时指针不动也要重算热区，重算需要这个点。 */
  lastPointerRef: RefObject<{ x: number; y: number } | null>
}) {
  const {
    mode,
    titleOnly,
    egoLayout,
    ego,
    data,
    cardsById,
    selected,
    visibleWorldRect,
    currentRect,
    tension,
    edgeFromLink,
    ringRouting,
    measure,
    tick,
    transform,
    hitCard,
    nodesByPath,
    lastPointerRef,
  } = input

  /**
   * 悬停的 wikilink 热区（卡片 + 热区矩形 + 对应边的 key）。
   *
   * 一份状态喂两个消费者：SVG 连线层（提亮那条边）与 canvas 画笔（给那段文字描边）——
   * 两边看同一份，"高亮的字"与"高亮的线"才永远指的是同一条边。
   */
  const [hoveredLink, setHoveredLink] = useState<{ relPath: string; zone: LinkZone; edgeKey: string } | null>(null)

  /**
   * 每张卡片正文里的 wikilink 热区（**卡片内坐标**）。
   *
   * 为什么按卡片内坐标存而不是世界坐标：漂浮开着时卡片每帧都在动，世界坐标的热区
   * 立刻就过期；卡片内坐标与排版一样是稳定的，命中测试时再用**当前**矩形换算 ——
   * "看到的"和"悬停到的"永远是同一个位置（与 `hitCard` 用当前矩形同理）。
   */
  const linkZonesByCard = useMemo(() => {
    const map = new Map<string, LinkZone[]>()
    // 纯标题模式没有正文排版，自然没有热区可指（连线也如实退成"从卡片边界出发"）
    if (mode !== 'focus' || titleOnly || egoLayout === null || measure === null) return map
    for (const [relPath, layout] of egoLayout.layouts) {
      map.set(relPath, linkZones({ layout, measure }))
    }
    return map
  }, [mode, titleOnly, egoLayout, measure])

  /**
   * 卡片 → 它的出边（按"正文里可能写成的样子"归一化后索引）。
   *
   * 热区命中的是"一段文字"，要提亮的是"一条边"：两者的桥梁就是与 `matchRun`
   * 同一套的候选写法（`edgeTargets` + `normalizeLinkText`）。匹配不上（悬空边、
   * 或目标不在当前深度里）就如实不亮 —— 不拿猜出来的边去高亮。
   */
  const edgeKeysByCard = useMemo(() => {
    const map = new Map<string, { keys: ReadonlySet<string>; key: string }[]>()
    if (mode !== 'focus' || ego === null) return map
    for (const edge of ego.data.edges) {
      if (edge.toRelPath === null) continue
      const to = nodesByPath.get(edge.toRelPath)
      if (to === undefined) continue
      const keys = new Set(edgeTargets(edge, to).map(normalizeLinkText))
      const entry = { keys, key: edgeKey(edge) }
      const list = map.get(edge.fromRelPath)
      if (list === undefined) map.set(edge.fromRelPath, [entry])
      else list.push(entry)
    }
    return map
  }, [mode, ego, nodesByPath])

  /**
   * 世界坐标 → 悬停的 wikilink（卡片 + 热区 + 对应边的 key）；不在任何"有对应边"的
   * 链接上时 `null`。指向图外的 `[[链接]]`（悬空 / 超出深度）不会提亮任何线，
   * 也就**不**伪装成可悬停 —— 光标与描边只对"真的能高亮一条线"的段落出现。
   */
  const linkAt = useCallback(
    (world: Point): { relPath: string; zone: LinkZone; edgeKey: string } | null => {
      if (mode !== 'focus') return null
      const hit = hitCard(world)
      if (hit === null) return null
      const zones = linkZonesByCard.get(hit.relPath)
      if (zones === undefined || zones.length === 0) return null
      const chrome = cardChrome(DEFAULT_METRICS)
      const localX = world.x - (hit.rect.x + chrome.padding)
      const localY = world.y - (hit.rect.y + chrome.bodyTop)
      for (const zone of zones) {
        if (localX < zone.x || localX > zone.x + zone.width) continue
        if (localY < zone.y || localY > zone.y + zone.height) continue
        const normalized = normalizeLinkText(zone.text)
        const hrefNormalized = zone.href === undefined ? '' : normalizeLinkText(zone.href)
        const match = (edgeKeysByCard.get(hit.relPath) ?? []).find(
          (entry) =>
            entry.keys.has(normalized) || (hrefNormalized !== '' && entry.keys.has(hrefNormalized)),
        )
        if (match === undefined) return null
        return { relPath: hit.relPath, zone, edgeKey: match.key }
      }
      return null
    },
    [mode, hitCard, linkZonesByCard, edgeKeysByCard],
  )

  /**
   * 内容没变就不写 state（逐字段比较，见 `sameHoveredLink`）：`linkZones` 每次 memo 重建都会
   * 换对象引用，引用比较会让每个 pointermove 都触发一次重渲染 —— 而内容没变时一个像素都不该重画。
   *
   * 指针处理器只调这一个入口，因此"是否真的变了"这条判据只有一份。
   */
  const setHoveredLinkIfChanged = useCallback((next: HoveredLink | null): void => {
    setHoveredLink((current) => (sameHoveredLink(current, next) ? current : next))
  }, [])

  /**
   * 漂浮开着时热区跟着卡片走：指针不动，悬停命中也要按**当前**矩形重算一次，
   * 否则高亮会停在卡片已经离开的地方。`transform` 也在依赖里：滚轮平移/缩放
   * 不会触发 pointermove，但同样改变世界坐标（"线突然指错了"比"不高亮"更难解释）。
   */
  useEffect(() => {
    if (hoveredLink === null) return
    const point = lastPointerRef.current
    if (point === null) return
    const next = linkAt(toWorld(transform, point))
    if (!sameHoveredLink(hoveredLink, next)) setHoveredLink(next)
  }, [tick, transform, hoveredLink, linkAt])

  /**
   * 连线：两种视图都交给 SVG 层（正交折线、箭头、悬空虚影都已经在那里实现好了）。
   *
   * **焦点视图**的连线从正文里那段 `[[链接]]` 文字出发（ADR-0023）：卡片内是虚线引线，
   * 出了卡片边界才变成实线/张力曲线。找不到对应文字时（正文没读到、卡片被截断、
   * 或者作者写的是 Markdown 链接）如实降级成"从卡片边界出发"，并在 tooltip 里说明。
   */
  const edgeVisuals = useMemo<GraphEdgeVisual[]>(() => {
    if (mode === 'focus') {
      if (egoLayout === null || ego === null) return []
      const root = ego.root
      const visuals: GraphEdgeVisual[] = []
      for (const edge of ego.data.edges) {
        // 悬空边在焦点视图里不画：目标不在这一圈里，"线到这里断了"的小刺只会让环更乱
        if (edge.toRelPath === null) continue
        const fromRect = currentRect(edge.fromRelPath)
        const toRect = currentRect(edge.toRelPath)
        const fromCard = egoLayout.layout.cardsByPath.get(edge.fromRelPath)
        const toCard = egoLayout.layout.cardsByPath.get(edge.toRelPath)
        if (fromRect === null || toRect === null || fromCard === undefined || toCard === undefined) {
          continue
        }
        const touchesRoot = edge.fromRelPath === root || edge.toRelPath === root
        const touchesSelected =
          selected !== null && (edge.fromRelPath === selected || edge.toRelPath === selected)
        const key = edgeKey(edge)
        // 悬停正文里某段 [[链接]] 时，它对应的那条边提亮（哪怕它原本是"环与环之间"的淡虚线）
        const hoveredEdge = hoveredLink !== null && hoveredLink.edgeKey === key
        const highlight = touchesRoot || touchesSelected || hoveredEdge
        const dim = !touchesRoot && !touchesSelected && !hoveredEdge
        /*
          语义色相（ADR-0028）：**以当前笔记为参照** —— 圆心指向别人是出链（暖），
          别人指向圆心是入链（冷），既不碰圆心也不碰选中的是环与环之间的上下文（中性）。
          为什么以圆心为参照：整幅图就是围着它组织的（"离它几跳"是唯一的结构维度），
          边在别处没有稳定的"出/入"可言（环与环之间是双向都算一跳的）。
        */
        const hue: 'out' | 'in' | 'context' =
          edge.fromRelPath === root ? 'out' : edge.toRelPath === root ? 'in' : 'context'
        // "这条边最远牵到第几跳" = 两端跳数的较大者
        const edgeHop = Math.max(fromCard.hop, toCard.hop)
        const base = edgeWeight(edgeHop)
        const weight = highlight
          ? {
              width: Math.max(base.width, EDGE_HIGHLIGHT_GAIN.minWidth),
              opacity: Math.min(1, base.opacity + EDGE_HIGHLIGHT_GAIN.opacity),
            }
          : dim
            ? {
                width: Math.max(EDGE_DIM_FACTOR.minWidth, base.width * EDGE_DIM_FACTOR.width),
                opacity: base.opacity * EDGE_DIM_FACTOR.opacity,
              }
            : base
        const style: EdgeStyle = {
          // 与中心无关的边画虚线：环与环之间的横线是"这两篇也互相提到"，属于上下文，不是主角
          dashed: !touchesRoot,
          dim,
          highlight,
          hue,
          width: weight.width,
          opacity: weight.opacity,
        }
        const title =
          edge.count > 1
            ? `${fromCard.node.title} → ${toCard.node.title} · 共 ${edge.count} 条链接`
            : `${fromCard.node.title} → ${toCard.node.title}`

        // `edgeFromLink` 关掉时就当"没有正文位置"处理（回到从卡片边界出发的老行为）
        const layout = edgeFromLink ? (egoLayout.layouts.get(edge.fromRelPath) ?? null) : null
        const geometry = linkEdgeGeometry({
          edge,
          from: { rect: fromRect, layout, title: fromCard.node.title },
          to: { rect: toRect, title: toCard.node.title },
          targets: edgeTargets(edge, toCard.node),
          tension,
          // 量宽函数必须传：`LaidOutLine` 只记了整行宽度，而"这段字从哪开始"要知道它前面的
          // run 各有多宽 —— 不传就只能按字符数摊派（中英混排会偏十几像素）
          ...(measure === null ? {} : { measure }),
        })
        /*
          环向走线（ADR-0028）：同环走弧、跨环朝外鼓 —— 两种形状都要把锚点换到卡片**外缘**。
          为什么连锚点一起换：环外的弧与"朝目标"的内侧锚点之间那段连接会被卡片挡住
          （卡片是不透明底、线段在它下面），看起来就是"线在卡片里断了"（理由写在
          `edge-routing.ts` 的文件头）。换了锚点，引线也必须重画到同一个点上 ——
          分界处严丝合缝那条纪律（ADR-0023）不能因为换了形状就破。
        */
        const route = ringRouting
          ? routingKind(
              { rect: fromRect, hop: fromCard.hop },
              { rect: toRect, hop: toCard.hop },
            )
          : 'straight-to-center'
        const exit = route === 'straight-to-center' ? geometry.exit : outerExit(fromRect)
        const entry = route === 'straight-to-center' ? geometry.entry : outerExit(toRect)
        const spanPath =
          route === 'straight-to-center'
            ? geometry.spanPath
            : (routeEdgePath({
                exit,
                entry,
                from: { rect: fromRect, hop: fromCard.hop },
                to: { rect: toRect, hop: toCard.hop },
                tension,
              }) ?? geometry.spanPath)
        const leadPath = geometry.fromLink
          ? route === 'straight-to-center'
            ? geometry.leadPath
            : leadPathBetween(geometry.anchor, exit)
          : ''

        visuals.push({
          key,
          edge,
          style,
          d: spanPath,
          start: exit,
          end: entry,
          phantom: false,
          title: geometry.fromLink
            ? `${title}（从正文里的 [[${geometry.matchedText ?? ''}]] 引出）`
            : `${title}（正文里没找到对应的链接写法，从卡片边缘出发）`,
          ...(geometry.fromLink && leadPath !== ''
            ? { leadPath, leadFrom: geometry.anchor }
            : {}),
        })
      }
      return visuals
    }
    if (data === null || mode !== 'vault') return []
    // 注意这里用的是**全部可见卡片**（而不是裁剪后的那一批）：线要从卡片边缘出发，
    // 只画两端都在视口里的边会让"线在屏幕中间凭空开始"
    return buildEdgeVisuals(data.edges, cardsById, selected, visibleWorldRect)
  }, [
    mode,
    egoLayout,
    ego,
    data,
    cardsById,
    selected,
    visibleWorldRect,
    currentRect,
    tension,
    edgeFromLink,
    ringRouting,
    measure,
    tick,
    hoveredLink,
  ])

  return { hoveredLink, setHoveredLinkIfChanged, linkAt, edgeVisuals }
}
