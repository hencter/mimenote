/**
 * 连线层（一层 `<svg>` 垫在卡片层下面）。
 *
 * 语义（这是需求里被特别强调的部分）：
 * - **入链（别人指向它）画虚线**，**出链（它指向别人）画实线**，都带箭头；
 * - 选中/预览某张卡片时只有与它相关的边保持醒目，其余**淡化**（不是隐藏：上下文还在，
 *   只是让读者的视线先落在"这张卡片"上）；
 * - 没有任何选中时，所有边都是统一的淡色细实线 + 箭头，**不需要按 Ctrl 就能看到关联**；
 * - 悬空链接（目标笔记还不存在）画成虚线 + 一个"虚影"小圆点，表示线到这里就断了。
 *
 * 线段本身不堆文字（一堆标签会把这层变成噪声），信息放在 `<title>` 里：
 * 同一条边 `count > 1` 时提示"共 N 条链接"。
 *
 * ## 分界处（卡片边界那一点）的两条纪律
 *
 * 一条边在画布上是两段：卡片**内**那段虚线引线（`leadPath`）与卡片**外**那条张力曲线
 * （`d` / `spanPath`），两段在卡片边界上相接。用户要的画法就是"从 wiki 链接处虚线开始，
 * 卡片边缘处实线出连接到卡片"，所以那个交界点必须经得起看：
 *
 * 1. **端点逐坐标相同**：两段的 `d` 共用同一个 `exit`（由 `link-edge.ts` 保证，并有测试钉住），
 *    这一层不做任何取整/偏移 —— 少一个 `Math.round` 就少一道半像素的缝；
 * 2. **虚线的相位锚在边界那一端**：`stroke-dasharray` / `stroke-dashoffset` 由
 *    `link-edge.ts` 的 `leadDash(长度)` 算出来（CSS 里算不了：相位依赖引线有多长），
 *    让最后一段实线正好在 `exit` 处收笔 —— 否则虚线可能在离卡边 1~3px 的地方就断在空隙里。
 *
 * 两段都用 `linecap: butt`：分界点要"齐平切断"。圆头（`round`）会让最后一段虚线鼓出半个
 * 线宽、越过边界探进卡外那段里，分界处就多出一个本该没有的小圆头。
 *
 * ## 引线为什么要分成单独一层（`layer`）
 *
 * 卡片是**不透明底**画在 canvas 上（`canvas/paint.ts`），而 canvas 的 `z-index` 比本层高 ——
 * 引线整段都在卡片矩形里，留在这一层里会被卡片**整段盖掉**，用户看到的就是"线从卡片边缘
 * 凭空开始"。所以 `GraphEdges` 支持只渲染其中一层（`layer`），让调用方把引线那一层挂到
 * 卡片层**之上**（同一个画布 transform 之下），卡片外那段仍然留在这一层（它本来就该被
 * 路上的卡片盖住 —— 那是既有的图层约定）。
 */

import { memo, useId } from 'react'

import type { GraphEdgeVisual } from './layout'
import { leadDash } from './link-edge'

/**
 * 画哪一层。
 *
 * - `all`（缺省）：两段都在这一层里画完 —— 连线整层垫在卡片下面，与"先画线后画卡片"的观感一致；
 * - `span`：只画卡片**外**那一段（张力曲线 + 箭头 + 悬空虚影），留在卡片层下面；
 * - `lead`：只画卡片**内**那一段虚线引线（+ 起点小圆点），要挂到卡片层**之上**才看得见。
 *
 * 为什么用一次渲染里的开关而不是两个组件：两段的 class、tooltip、`key` 与"引线的相位"
 * 都来自同一份 `visuals`，拆成两个组件就会把这些口径复制两份，早晚分家。
 */
export type GraphEdgeLayer = 'all' | 'lead' | 'span'

export interface GraphEdgesProps {
  visuals: readonly GraphEdgeVisual[]
  /** SVG 的 `viewBox` = 视口对应的世界矩形：SVG 元素本身只占视口大小，
   *  它的用户坐标就是世界坐标（画布再大也不会生成一块巨大的 SVG）。 */
  viewBox: { x: number; y: number; width: number; height: number }
  /** 画哪一层，见 `GraphEdgeLayer`。 */
  layer?: GraphEdgeLayer
}

function edgeClassName(visual: GraphEdgeVisual): string {
  const classes = ['mn-graph-edge']
  if (visual.style.dashed) classes.push('mn-graph-edge--dashed')
  if (visual.style.highlight) classes.push('mn-graph-edge--highlight')
  if (visual.style.dim) classes.push('mn-graph-edge--dim')
  return classes.join(' ')
}

/**
 * 引线的虚线图案与相位。
 *
 * 长度取 `leadFrom → start`：`GraphEdgeVisual` 的契约里，引线的两端就是这两个点
 * （调用方用 `leadFrom = anchor`、`start = exit` 填的）。拿不到起点时交给 `leadDash` 的
 * 合法化分支（长度 0）—— 宁可按"从文字那端开始数虚线"的老样子画，也不要凭一个猜出来的
 * 长度去错开相位。
 */
function leadDashAttributes(visual: GraphEdgeVisual): {
  strokeDasharray?: string
  strokeDashoffset?: number
} {
  if (visual.leadFrom === undefined) return {}
  const length = Math.hypot(
    visual.start.x - visual.leadFrom.x,
    visual.start.y - visual.leadFrom.y,
  )
  const { dashArray, dashOffset } = leadDash(length)
  return { strokeDasharray: dashArray, strokeDashoffset: dashOffset }
}

const ARROW_VARIANTS = ['default', 'highlight', 'dim'] as const

export const GraphEdges = memo(function GraphEdges({
  visuals,
  viewBox,
  layer = 'all',
}: GraphEdgesProps) {
  // 同一页面可能出现多个画布（未来分屏）：marker 的 id 必须唯一，否则后一个会覆盖前一个
  const uid = useId().replaceAll(/[^a-zA-Z0-9_-]/g, '')
  const markerId = (variant: (typeof ARROW_VARIANTS)[number]): string =>
    `mn-graph-arrow-${variant}-${uid}`

  const arrowFor = (visual: GraphEdgeVisual): string => {
    if (visual.style.highlight) return markerId('highlight')
    if (visual.style.dim) return markerId('dim')
    return markerId('default')
  }

  // 两层的分工见文件头：箭头（marker）只有卡片外那段用得到，引线层里不生成 <defs>
  const withLead = layer !== 'span'
  const withSpan = layer !== 'lead'

  return (
    <svg
      className="mn-graph__edges"
      viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{ left: viewBox.x, top: viewBox.y, width: viewBox.width, height: viewBox.height }}
    >
      {withSpan && (
        <defs>
          {/* 箭头用 currentColor 取不到 stroke 的颜色，因此按三种状态各定义一个 marker */}
          {ARROW_VARIANTS.map((variant) => (
            <marker
              key={variant}
              id={markerId(variant)}
              className={`mn-graph-arrow mn-graph-arrow--${variant}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" />
            </marker>
          ))}
        </defs>
      )}

      {visuals.map((visual) => (
        /*
          `data-edge` 是这条边在两层的**同一个身份**：引线与卡外那段现在分居两个 `<svg>`
          （引线要盖在卡片层之上，见文件头），"同一条边的两段"没法再靠"同一个父节点"认出来 ——
          自动化（测试、E2E）配对靠这个属性，比按 tooltip 文字或路径形状去猜可靠得多。
        */
        <g key={visual.key} data-edge={visual.key}>
          {/*
            卡片**内部**的引线（ADR-0023）：从正文里 `[[链接]]` 那段文字画到卡片边界。
            虚线 + 更细 + 半透明：它是"这条线从哪句话出来的"的**指示**，不是边本身 ——
            画得和外面那段一样重，卡片里就会多出一堆横穿正文的线，正文反而读不了。
            （这一段的粗细/透明度因此**刻意**与卡外那段不同：分界处的"严丝合缝"靠的是
            端点逐坐标相同 + 相位收在边界上 + 两端都是 butt 线帽，而不是把粗细做成一样。）
          */}
          {withLead && visual.leadPath !== undefined && (
            <path
              className="mn-graph-edge mn-graph-edge--lead"
              d={visual.leadPath}
              strokeLinecap="butt"
              {...leadDashAttributes(visual)}
            >
              <title>{visual.title}</title>
            </path>
          )}
          {withSpan && (
            <path
              className={edgeClassName(visual)}
              d={visual.d}
              strokeLinecap="butt"
              markerEnd={`url(#${arrowFor(visual)})`}
            >
              <title>{visual.title}</title>
            </path>
          )}
          {/* 起点的小圆点：没有它，"线从哪句话出来"在卡片里只是一段虚线的末端；
              它同时盖住相位在链接那一端可能留下的空隙（见 `leadDash` 的推导） */}
          {withLead && visual.leadFrom !== undefined && (
            <circle
              className="mn-graph-edge-lead-dot"
              cx={visual.leadFrom.x}
              cy={visual.leadFrom.y}
              r={2}
            />
          )}
          {withSpan && visual.phantom && (
            <circle className="mn-graph-phantom" cx={visual.end.x} cy={visual.end.y} r={4}>
              <title>{visual.title}</title>
            </circle>
          )}
          {/* 悬空边的目标名字直接画在虚影旁边：光靠 tooltip 要悬停才知道指向谁，
              而"这里缺一篇笔记"恰恰是需要一眼看见的信息（名字取自 toRawTarget） */}
          {withSpan && visual.phantom && visual.edge.toRawTarget !== '' && (
            <text
              className="mn-graph-phantom-label"
              x={visual.end.x + 8}
              y={visual.end.y + 3.5}
            >
              {visual.edge.toRawTarget}
            </text>
          )}
        </g>
      ))}
    </svg>
  )
})
