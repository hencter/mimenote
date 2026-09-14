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
 */

import { memo, useId } from 'react'

import type { GraphEdgeVisual } from './layout'

export interface GraphEdgesProps {
  visuals: readonly GraphEdgeVisual[]
  /** SVG 的 `viewBox` = 视口对应的世界矩形：SVG 元素本身只占视口大小，
   *  它的用户坐标就是世界坐标（画布再大也不会生成一块巨大的 SVG）。 */
  viewBox: { x: number; y: number; width: number; height: number }
}

function edgeClassName(visual: GraphEdgeVisual): string {
  const classes = ['mn-graph-edge']
  if (visual.style.dashed) classes.push('mn-graph-edge--dashed')
  if (visual.style.highlight) classes.push('mn-graph-edge--highlight')
  if (visual.style.dim) classes.push('mn-graph-edge--dim')
  return classes.join(' ')
}

const ARROW_VARIANTS = ['default', 'highlight', 'dim'] as const

export const GraphEdges = memo(function GraphEdges({ visuals, viewBox }: GraphEdgesProps) {
  // 同一页面可能出现多个画布（未来分屏）：marker 的 id 必须唯一，否则后一个会覆盖前一个
  const uid = useId().replaceAll(/[^a-zA-Z0-9_-]/g, '')
  const markerId = (variant: (typeof ARROW_VARIANTS)[number]): string =>
    `mn-graph-arrow-${variant}-${uid}`

  const arrowFor = (visual: GraphEdgeVisual): string => {
    if (visual.style.highlight) return markerId('highlight')
    if (visual.style.dim) return markerId('dim')
    return markerId('default')
  }

  return (
    <svg
      className="mn-graph__edges"
      viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{ left: viewBox.x, top: viewBox.y, width: viewBox.width, height: viewBox.height }}
    >
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

      {visuals.map((visual) => (
        <g key={visual.key}>
          {/*
            卡片**内部**的引线（ADR-0023）：从正文里 `[[链接]]` 那段文字画到卡片边界。
            虚线 + 更细 + 半透明：它是"这条线从哪句话出来的"的**指示**，不是边本身 ——
            画得和外面那段一样重，卡片里就会多出一堆横穿正文的线，正文反而读不了。
          */}
          {visual.leadPath !== undefined && (
            <path className="mn-graph-edge mn-graph-edge--lead" d={visual.leadPath}>
              <title>{visual.title}</title>
            </path>
          )}
          <path
            className={edgeClassName(visual)}
            d={visual.d}
            markerEnd={`url(#${arrowFor(visual)})`}
          >
            <title>{visual.title}</title>
          </path>
          {/* 起点的小圆点：没有它，"线从哪句话出来"在卡片里只是一段虚线的末端 */}
          {visual.leadFrom !== undefined && (
            <circle
              className="mn-graph-edge-lead-dot"
              cx={visual.leadFrom.x}
              cy={visual.leadFrom.y}
              r={2}
            />
          )}
          {visual.phantom && (
            <circle className="mn-graph-phantom" cx={visual.end.x} cy={visual.end.y} r={4}>
              <title>{visual.title}</title>
            </circle>
          )}
          {/* 悬空边的目标名字直接画在虚影旁边：光靠 tooltip 要悬停才知道指向谁，
              而"这里缺一篇笔记"恰恰是需要一眼看见的信息（名字取自 toRawTarget） */}
          {visual.phantom && visual.edge.toRawTarget !== '' && (
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
