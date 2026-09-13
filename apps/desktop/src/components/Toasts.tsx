/** 提示条（toast）：异步失败必须被用户看见。 */

import { useToastStore } from '@/state/toast-store'
import { Icon, type IconName } from './Icon'

const ICONS: Record<string, IconName> = {
  info: 'info',
  success: 'check',
  warn: 'alert',
  error: 'alert',
}

export function Toasts() {
  const toasts = useToastStore((state) => state.toasts)
  const dismiss = useToastStore((state) => state.dismiss)

  if (toasts.length === 0) return null

  return (
    <div className="mn-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`mn-toast mn-toast--${toast.kind}`}>
          <Icon name={ICONS[toast.kind] ?? 'info'} size={15} />
          <div className="mn-toast__body">
            <div className="mn-toast__message">{toast.message}</div>
            {toast.detail !== undefined && <div className="mn-toast__detail">{toast.detail}</div>}
          </div>
          <button
            type="button"
            className="mn-icon-button"
            aria-label="关闭提示"
            onClick={() => dismiss(toast.id)}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
