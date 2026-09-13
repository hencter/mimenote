/** 可拖拽分隔条（同时支持键盘方向键调整，满足可访问性要求）。 */

import { useCallback, useState } from 'react'

export interface SplitterProps {
  /** `vertical` = 竖直分隔条（左右分栏）。 */
  orientation?: 'vertical' | 'horizontal'
  onDrag: (event: PointerEvent) => void
  /** 键盘微调（方向键）回调。 */
  onNudge?: (delta: number) => void
  ariaLabel: string
}

export function Splitter({ orientation = 'vertical', onDrag, onNudge, ariaLabel }: SplitterProps) {
  const [dragging, setDragging] = useState(false)

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
  }, [])

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return
      event.preventDefault()
      onDrag(event.nativeEvent)
    },
    [dragging, onDrag],
  )

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    setDragging(false)
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // 指针已释放：忽略
    }
  }, [])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 48 : 16
      const decrease = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp'
      const increase = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown'
      if (event.key === decrease) {
        event.preventDefault()
        onNudge?.(-step)
      } else if (event.key === increase) {
        event.preventDefault()
        onNudge?.(step)
      }
    },
    [onNudge, orientation],
  )

  return (
    <div
      className={`mn-splitter mn-splitter--${orientation}${dragging ? ' mn-splitter--dragging' : ''}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={ariaLabel}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
    />
  )
}
