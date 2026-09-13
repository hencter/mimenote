/**
 * 画布上的一张笔记卡片。
 *
 * 与 Obsidian 那种"小圆点 + 悬停才出信息"的做法相反：卡片正面直接给出**标题、相对路径、
 * 标签、出入度**，所以"这张卡片是谁、它连了几条线"是**看**出来的，不是"按住 Ctrl 或悬停"
 * 试探出来的。单击 = 在画布上预览（右侧滑出正文），双击 = 进编辑器打开。
 *
 * 拖动：位置在拖动结束时覆盖自动布局（`graph-store.moveCard`），并带 4px 阈值 ——
 * 否则"单击预览"会被手指/鼠标的轻微抖动吃掉，变成一次 1px 的拖动。
 */

import { memo, useCallback, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'

import type { GraphCardBox } from './layout'

/** 超过这个位移才算"拖动"，否则当作点击（避免单击预览被抖动手感破坏）。 */
const DRAG_THRESHOLD_PX = 4

/** 卡片正面最多显示几个标签（再多就只是噪声，且会把卡片撑爆）。 */
const MAX_TAG_CHIPS = 3

export interface GraphCardProps {
  box: GraphCardBox
  selected: boolean
  /** 当前缩放：把屏幕位移换算成世界位移（拖动的正确性依赖它）。 */
  zoom: number
  onSelect: (relPath: string) => void
  onOpen: (relPath: string) => void
  onMove: (relPath: string, x: number, y: number) => void
}

interface DragState {
  pointerId: number | undefined
  startClientX: number
  startClientY: number
  originX: number
  originY: number
  moved: boolean
}

export const GraphCard = memo(function GraphCard({
  box,
  selected,
  zoom,
  onSelect,
  onOpen,
  onMove,
}: GraphCardProps) {
  const dragRef = useRef<DragState | null>(null)
  /** 拖动结束后紧接着会来一次 click：必须吞掉它，否则"拖完手一松就弹预览"。 */
  const suppressClickRef = useRef(false)

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return // 中键留给画布平移
      event.stopPropagation() // 卡片上按下不该同时触发画布平移
      const element = event.currentTarget
      if (typeof element.setPointerCapture === 'function') {
        try {
          element.setPointerCapture(event.pointerId)
        } catch {
          // jsdom 等环境没有实现指针捕获：拖动仍可用（只是指针移出卡片后会断），忽略即可
        }
      }
      dragRef.current = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        originX: box.x,
        originY: box.y,
        moved: false,
      }
    },
    [box.x, box.y],
  )

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (drag === null || drag.pointerId !== event.pointerId) return
      const dx = event.clientX - drag.startClientX
      const dy = event.clientY - drag.startClientY
      if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return
      drag.moved = true
      // 屏幕位移 ÷ 缩放 = 世界位移；起点取**按下时**的坐标（再叠加总位移），避免逐帧累加误差
      onMove(box.relPath, drag.originX + dx / zoom, drag.originY + dy / zoom)
    },
    [box.relPath, onMove, zoom],
  )

  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (drag === null) return
    dragRef.current = null
    if (drag.moved) suppressClickRef.current = true
    const element = event.currentTarget
    if (typeof element.releasePointerCapture === 'function') {
      try {
        element.releasePointerCapture(event.pointerId)
      } catch {
        // 指针已经释放
      }
    }
  }, [])

  const handleClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    onSelect(box.relPath)
  }, [box.relPath, onSelect])

  const handleDoubleClick = useCallback(() => {
    onOpen(box.relPath)
  }, [box.relPath, onOpen])

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      // 键盘事件不冒泡到画布：否则会同时触发画布的按键处理（缩放等）
      event.stopPropagation()
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) onOpen(box.relPath)
      else onSelect(box.relPath)
    },
    [box.relPath, onOpen, onSelect],
  )

  const node = box.node
  const tags = node.tags.slice(0, MAX_TAG_CHIPS)
  const extraTags = node.tags.length - tags.length

  return (
    <div
      className={`mn-graph-card${selected ? ' mn-graph-card--selected' : ''}`}
      style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
      role="button"
      tabIndex={0}
      aria-label={`预览笔记 ${node.title}`}
      aria-pressed={selected}
      data-rel-path={node.relPath}
      title={`${node.relPath}\n单击预览 · 双击在编辑器中打开 · 拖动可移动`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
    >
      <div className="mn-graph-card__title">{node.title}</div>
      <div className="mn-graph-card__path">{node.relPath}</div>
      <div className="mn-graph-card__footer">
        <div className="mn-graph-card__tags">
          {tags.map((tag) => (
            <span className="mn-graph-card__tag" key={tag}>
              {tag}
            </span>
          ))}
          {extraTags > 0 && <span className="mn-graph-card__tag-more">+{extraTags}</span>}
        </div>
        <div
          className="mn-graph-card__degree"
          title={`出链 ${node.outDegree} 条 · 入链 ${node.inDegree} 条`}
        >
          {/* 箭头直接写在数字前面：→ 出链（它指向别人）、← 入链（别人指向它），
              与画布上的"实线出 / 虚线入"是同一套语义 */}
          <span className="mn-graph-card__degree-out">→{node.outDegree}</span>
          <span className="mn-graph-card__degree-in">←{node.inDegree}</span>
        </div>
      </div>
    </div>
  )
})
