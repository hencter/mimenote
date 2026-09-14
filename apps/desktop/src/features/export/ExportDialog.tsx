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
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

import { EXPORT_REQUEST_EVENT, EXPORT_RUN_EVENT, type ExportKind } from './export-events'
import { exportNoteHtml, isLargeExport, printNote } from './export-note'
import { exportVaultSite } from './site-export'

import './export.css'

export function ExportDialog() {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  /** 正在跑的是哪一种导出（决定"取消"能不能用：整库导出按批检查取消标志，单篇不行）。 */
  const [running, setRunning] = useState<ExportKind | null>(null)
  const relPath = useNoteStore((state) => state.doc?.relPath ?? null)
  const sizeBytes = useNoteStore((state) => state.doc?.sizeBytes ?? 0)
  const hasVault = useVaultStore((state) => state.info !== null)
  const indexPhase = useLinksStore((state) => state.status.phase)
  /**
   * "取消"请求：用 ref 而不是 state，因为 `shouldContinue` 是**每次批边界**被回调的，
   * 它必须读到"此刻"的值 —— 闭包捕获 state 会一直读到开始那一刻的旧值。
   */
  const cancelRef = useRef(false)
  /** 关闭后把焦点还给打开它的元素（键盘用户不会"掉焦点"）。 */
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const firstChoiceRef = useRef<HTMLButtonElement | null>(null)

  const close = useCallback((): void => {
    setOpen(false)
    setBusy(false)
    setProgress(null)
    setRunning(null)
    cancelRef.current = false
    const previous = restoreFocusRef.current
    restoreFocusRef.current = null
    if (previous !== null && previous.isConnected) previous.focus()
  }, [])

  const show = useCallback((): void => {
    const active = typeof document === 'undefined' ? null : document.activeElement
    restoreFocusRef.current = active instanceof HTMLElement ? active : null
    setBusy(false)
    setProgress(null)
    setRunning(null)
    cancelRef.current = false
    setOpen(true)
  }, [])

  /** 跑一次导出：忙碌期间禁用入口，并把进度写在那行状态文字上。 */
  const run = useCallback(
    async (kind: ExportKind): Promise<void> => {
      if (busy) return
      cancelRef.current = false
      setBusy(true)
      setRunning(kind)
      setProgress(
        kind === 'html'
          ? '正在准备导出…'
          : kind === 'print'
            ? '正在准备打印…'
            : '正在准备整库导出…',
      )
      try {
        if (kind === 'html') await exportNoteHtml({ onProgress: setProgress })
        else if (kind === 'print') await printNote({ onProgress: setProgress })
        else {
          await exportVaultSite({
            onProgress: (done, total, message) => {
              setProgress(total === 0 ? message : `${message}（${done}/${total}）`)
            },
            shouldContinue: () => !cancelRef.current,
          })
        }
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
      // 整库导出还没到能跑的时候（索引在构建）：**打开对话框但不要跑** ——
      // 跑一次只会得到一条"索引还在构建"的提示然后自动关掉，用户看不到那个选项为什么灰着。
      // 停在对话框里，"链接索引还在构建"那句话就在按钮下方，建好之后按钮自己会亮。
      if (kind === 'site' && useLinksStore.getState().status.phase !== 'ready') {
        show()
        return
      }
      // 命令（`export.html` / `export.pdf` / `export.site`）直接执行时不问"要哪种"，
      // 但**照旧打开对话框**：大笔记/整库导出要好几秒，用户得看到"正在导出…"
      // 而不是一个毫无反应的界面。对话框这时兼作进度面板，跑完自己收起。
      show()
      void run(kind)
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
  // 整库导出要的是"整个 Vault + 一个完整的链接索引"，与"有没有打开笔记"无关：
  // 索引没建好时按钮置灰并说明原因（点下去才吃到 `INDEX_NOT_READY` 是更差的体验）
  const siteDisabled = busy || !hasVault || indexPhase !== 'ready'
  const siteReason =
    indexPhase === 'building'
      ? '链接索引还在构建，整库导出要等它建好（建完这里会自动可用）'
      : indexPhase === 'failed'
        ? '链接索引构建失败，请先重扫一次 Vault（Ctrl+Alt+R）'
        : indexPhase === 'cancelled'
          ? '上次的索引构建被取消了，请重扫一次 Vault（Ctrl+Alt+R）'
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

          {/*
            整库导出放在同一张对话框里而不是另开一个入口：对用户来说这三件事都属于"导出"，
            而**区别必须在点下去之前就看得见**（对象是"这一篇"还是"整个 Vault"、
            产物是一个文件还是一个目录）。
          */}
          <button
            type="button"
            className="mn-export__choice"
            data-export-site
            disabled={siteDisabled}
            onClick={() => void run('site')}
          >
            <span className="mn-export__choice-title">
              <Icon name="folder" size={15} />
              整个 Vault → 静态站点
            </span>
            <span className="mn-export__choice-hint">
              {siteReason ??
                '每篇笔记一个 HTML、双链变成可点的相对链接、图片复制进 assets/，零 JavaScript，' +
                  '打开目录里的 index.html 就能看（输出目录要选在 Vault 之外）'}
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
          {/*
            整库导出可以在**批边界**上停下（宿主侧没有可取消的后台任务，取消就是"不再发下一批"），
            所以只有它能把「取消」变成"停止导出"；单篇导出是一步阻塞工作，给一个按不动的按钮
            比不给更让人困惑 —— 那种情况下按钮保持禁用，进度文字就是唯一的反馈。
          */}
          {busy && running === 'site' ? (
            <button
              type="button"
              className="mn-button"
              data-export-cancel
              onClick={() => {
                cancelRef.current = true
                setProgress('正在停止（等当前这一批写完）…')
              }}
            >
              停止导出
            </button>
          ) : (
            <button type="button" className="mn-button" disabled={busy} onClick={close}>
              取消
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
