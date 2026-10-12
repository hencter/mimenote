/**
 * 提示条（toast）：异步失败必须被用户看见。
 *
 * 为什么住在 `features/shell/`（B9，ADR-0060 §2 的 P5）：它订阅 `state/toast-store`，
 * 和确认框一样是**应用外壳**（文案由各调用点经 store 给），不是可独立复用的通用控件。
 */

import { useToastStore } from '@/state/toast-store'
import { Icon, type IconName } from '@/components/Icon'

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
          <Icon name={ICONS[toast.kind] ?? 'info'} size="md" />
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
            <Icon name="x" size="sm" />
          </button>
        </div>
      ))}
    </div>
  )
}
