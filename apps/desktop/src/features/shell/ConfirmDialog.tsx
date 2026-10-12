/**
 * 破坏性操作确认框（键盘可用：Esc 取消，Enter 确认）。
 *
 * 为什么住在 `features/shell/`（B9，ADR-0060 §2 的 P5）：它订阅 `state/confirm-store`
 * —— "谁按了确定"直接决定应用的破坏性动作，所以它是**应用外壳**的一部分，不是能独立复用的通用控件。
 * 从前它住在 `components/**`，于是"通用控件层值依赖状态层"成了一条要冻结的越界登记。
 */

import { useEffect, useRef } from 'react'

import { useConfirmStore } from '@/state/confirm-store'
import { Icon } from '@/components/Icon'

export function ConfirmDialog() {
  const request = useConfirmStore((state) => state.request)
  const respond = useConfirmStore((state) => state.respond)
  const confirmRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (request === null) return
    confirmRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        respond(false)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [request, respond])

  if (request === null) return null

  return (
    <div className="mn-overlay" role="presentation" onClick={() => respond(false)}>
      <div
        className="mn-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={request.title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mn-dialog__header">
          <Icon name="alert" size="lg" />
          <h2>{request.title}</h2>
        </div>
        <p className="mn-dialog__message">{request.message}</p>
        <div className="mn-dialog__actions">
          <button type="button" className="mn-button" onClick={() => respond(false)}>
            {request.cancelLabel ?? '取消'}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={request.danger === true ? 'mn-button mn-button--danger' : 'mn-button mn-button--primary'}
            onClick={() => respond(true)}
          >
            {request.confirmLabel ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  )
}
