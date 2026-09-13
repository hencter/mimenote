/**
 * 导出对话框（标题栏按钮 / 命令 `export.html`、`export.pdf` 都走这里）。
 *
 * 为什么先弹一个"极简选择"而不是两个独立按钮：导出有两种完全不同的产物（自包含 HTML /
 * 打印成 PDF），它们的**语义**（一个落盘、一个交给系统打印对话框）与**代价**（前者要内嵌图片）
 * 都不一样。让用户在点下去之前就看清区别，比事后解释"你刚点的是哪个"划算。
 *
 * 触发方式是**一次性 DOM 事件**（`export-events.ts`）而不是全局 store 标志位：与重命名对话框
 * 同一个取舍 —— 这是"谁请求谁打开"的瞬时 UI，放进全局 store 只会让状态图变复杂。
 *
 * ⚠️ 本组件**不直接调用 IPC**（架构 §2 第 5 条）：它只调用 `export-note.ts` 里的高层动作。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { Icon } from '@/components/Icon'
import { formatBytes } from '@/domain/format'
import { useNoteStore } from '@/state/note-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

import { EXPORT_REQUEST_EVENT, EXPORT_RUN_EVENT, type ExportKind } from './export-events'
import { exportNoteHtml, isLargeExport, printNote } from './export-note'

import './export.css'

export function ExportDialog() {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const relPath = useNoteStore((state) => state.doc?.relPath ?? null)
  const sizeBytes = useNoteStore((state) => state.doc?.sizeBytes ?? 0)
  const hasVault = useVaultStore((state) => state.info !== null)
  /** 关闭后把焦点还给打开它的元素（键盘用户不会"掉焦点"）。 */
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const firstChoiceRef = useRef<HTMLButtonElement | null>(null)

  const close = useCallback((): void => {
    setOpen(false)
    setBusy(false)
    setProgress(null)
    const previous = restoreFocusRef.current
    restoreFocusRef.current = null
    if (previous !== null && previous.isConnected) previous.focus()
  }, [])

  const show = useCallback((): void => {
    const active = typeof document === 'undefined' ? null : document.activeElement
    restoreFocusRef.current = active instanceof HTMLElement ? active : null
    setBusy(false)
    setProgress(null)
    setOpen(true)
  }, [])

  /** 跑一次导出：忙碌期间禁用两个入口，并把进度写在那行状态文字上。 */
  const run = useCallback(
    async (kind: ExportKind): Promise<void> => {
      if (busy) return
      setBusy(true)
      setProgress(kind === 'html' ? '正在准备导出…' : '正在准备打印…')
      try {
        if (kind === 'html') await exportNoteHtml({ onProgress: setProgress })
        else await printNote({ onProgress: setProgress })
      } finally {
        // 成功/取消/失败都不需要用户在对话框里做决定 —— 结果已由 toast 说明
        close()
      }
    },
    [busy, close],
  )

  useEffect(() => {
    const onRequest = (): void => {
      // 命令面板/快速切换已经开着时不要叠一层（与重命名对话框同样的守卫）：
      // 两层模态的 Esc 归属与焦点归还都会变得含混
      if (useUiStore.getState().paletteMode !== null) return
      show()
    }
    const onRun = (event: Event): void => {
      const kind = (event as CustomEvent<ExportKind>).detail
      // 命令（`export.html` / `export.pdf`）直接执行时不问"要哪种"，但**照旧打开对话框**：
      // 大笔记的导出要几秒，用户得看到"正在导出…"而不是一个毫无反应的界面。
      // 对话框这时兼作进度面板，跑完自己收起。
      show()
      void run(kind === 'print' ? 'print' : 'html')
    }
    window.addEventListener(EXPORT_REQUEST_EVENT, onRequest)
    window.addEventListener(EXPORT_RUN_EVENT, onRun)
    return () => {
      window.removeEventListener(EXPORT_REQUEST_EVENT, onRequest)
      window.removeEventListener(EXPORT_RUN_EVENT, onRun)
    }
  }, [run, show])

  // 打开即把焦点放到第一个选项上（键盘可以直接选，Esc 也能立刻关）
  useEffect(() => {
    if (!open) return
    firstChoiceRef.current?.focus()
  }, [open])

  if (!open) return null

  const disabled = busy || relPath === null || !hasVault
  const reason = !hasVault
    ? '还没有打开 Vault'
    : relPath === null
      ? '没有打开的笔记'
      : null

  return (
    <div
      className="mn-overlay"
      role="presentation"
      onClick={() => {
        if (!busy) close()
      }}
    >
      <div
        className="mn-dialog mn-dialog--export"
        role="dialog"
        aria-modal="true"
        aria-label="导出当前笔记"
        onKeyDown={(event) => {
          // 对话框自己处理 Esc，不让冒泡到全局快捷键（编辑器、文件树）
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          if (!busy) close()
        }}
      >
        <div className="mn-dialog__header">
          <h2>导出当前笔记</h2>
        </div>

        <p className="mn-dialog__message">
          {reason ?? (
            <>
              {relPath}
              {sizeBytes > 0 && ` · ${formatBytes(sizeBytes)}`}
            </>
          )}
        </p>

        <div className="mn-export__choices">
          <button
            type="button"
            ref={firstChoiceRef}
            className="mn-export__choice"
            disabled={disabled}
            onClick={() => void run('html')}
          >
            <span className="mn-export__choice-title">
              <Icon name="save" size={15} />
              自包含 HTML
            </span>
            <span className="mn-export__choice-hint">
              图片内嵌成 data: 地址、样式写死在这一个文件里，拷到任何地方用浏览器都能看
            </span>
          </button>

          <button
            type="button"
            className="mn-export__choice"
            disabled={disabled}
            onClick={() => void run('print')}
          >
            <span className="mn-export__choice-title">
              <Icon name="file" size={15} />
              打印 / 另存为 PDF
            </span>
            <span className="mn-export__choice-hint">
              打开系统打印对话框，在里面选「另存为 PDF」即可得到 PDF
            </span>
          </button>
        </div>

        {isLargeExport(sizeBytes) && !busy && (
          <p className="mn-export__notice">
            这篇笔记较大（{formatBytes(sizeBytes)}），导出需要几秒，请不要关闭窗口
          </p>
        )}

        {busy && (
          <p className="mn-export__busy" role="status" aria-live="polite">
            <Icon name="refresh" size={13} />
            {progress ?? '正在导出…'}
          </p>
        )}

        <div className="mn-dialog__actions">
          <button type="button" className="mn-button" disabled={busy} onClick={close}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
