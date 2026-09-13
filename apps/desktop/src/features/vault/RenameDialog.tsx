/**
 * 重命名对话框（F2 / 工具栏 / 命令面板都走这里）。
 *
 * 为什么不做"行内改名"：文件树是虚拟列表，行一旦滚出可视区就被卸载，
 * 行内输入框会随滚动消失；对话框不受虚拟化影响，也能一次说清"会顺带改写哪些链接"。
 *
 * 触发方式是**一次性 DOM 事件**而不是 store 里的布尔标志位：改名对话框属于
 * "谁请求谁打开"的瞬时 UI，放进全局 store 只会让状态图变复杂（同 `dom-events.ts` 的约定）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { renameNote } from '@/app/actions'
import { RENAME_REQUEST_EVENT } from '@/app/dom-events'
import { extensionOf, parentOf, stem } from '@/domain/paths'
import { useRenameStore } from '@/state/rename-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

import './rename-dialog.css'

export function RenameDialog() {
  const target = useRenameStore((state) => state.target)
  const [value, setValue] = useState('')
  const [updateLinks, setUpdateLinks] = useState(true)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  /** 关闭后把焦点还给打开它的元素（键盘用户不会"掉焦点"）。 */
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  const close = useCallback((): void => {
    useRenameStore.getState().close()
    setValue('')
    setBusy(false)
    const previous = restoreFocusRef.current
    restoreFocusRef.current = null
    if (previous !== null && previous.isConnected) previous.focus()
  }, [])

  const open = useCallback((relPath: string): void => {
    const active = typeof document === 'undefined' ? null : document.activeElement
    restoreFocusRef.current = active instanceof HTMLElement ? active : null
    setValue(stem(relPath))
    setUpdateLinks(true)
    setBusy(false)
    useRenameStore.getState().open(relPath)
  }, [])

  useEffect(() => {
    const handler = (event: Event): void => {
      // 命令面板/快速切换已经开着时不要再叠一层：两个模态层叠在一起，
      // Esc 的归属和焦点归还都会变得含混（面板那边对确认框也有同样的守卫）。
      if (useUiStore.getState().paletteMode !== null) return
      const detail = (event as CustomEvent<string | undefined>).detail
      const relPath = detail ?? useVaultStore.getState().selected
      if (relPath === null || relPath === undefined) return
      const entry = useVaultStore.getState().entries.find((item) => item.relPath === relPath)
      if (entry === undefined || entry.isDir) return
      open(relPath)
    }
    window.addEventListener(RENAME_REQUEST_EVENT, handler)
    return () => {
      window.removeEventListener(RENAME_REQUEST_EVENT, handler)
    }
  }, [open])

  // 打开即聚焦并全选文件名（不含扩展名 —— 扩展名不进输入框）
  useEffect(() => {
    if (target === null) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [target])

  const submit = useCallback(async (): Promise<void> => {
    if (target === null || busy) return
    const title = value.trim()
    // 名字没变就直接关掉：发一次 IPC 只会白白改写一遍链接（虽然结果相同）
    if (title === '' || title === stem(target)) {
      close()
      return
    }
    setBusy(true)
    const outcome = await renameNote(target, title, { updateLinks })
    if (outcome !== null) {
      close()
      return
    }
    // 失败（重名/非法字符/磁盘错误）时保留对话框，让用户直接改；原因由 toast 说明
    setBusy(false)
    inputRef.current?.focus()
  }, [busy, close, target, updateLinks, value])

  if (target === null) return null

  const parent = parentOf(target)
  const ext = extensionOf(target)

  return (
    <div
      className="mn-overlay"
      role="presentation"
      onClick={() => {
        if (!busy) close()
      }}
    >
      <div
        className="mn-dialog mn-dialog--rename"
        role="dialog"
        aria-modal="true"
        aria-label="重命名笔记"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mn-dialog__header">
          <h2>重命名笔记</h2>
        </div>

        <p className="mn-dialog__message">
          位置：{parent === '' ? 'Vault 根目录' : parent}
          {updateLinks && <span className="mn-rename__hint"> · 会同时改写指向它的链接</span>}
        </p>

        <div className="mn-rename__field">
          <input
            ref={inputRef}
            className="mn-rename__input"
            type="text"
            aria-label="新文件名"
            value={value}
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              // 对话框自己处理 Esc/Enter，不让冒泡到全局快捷键（文件树、编辑器）
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                if (!busy) close()
                return
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                event.stopPropagation()
                void submit()
              }
            }}
          />
          {ext !== '' && <span className="mn-rename__ext">.{ext}</span>}
        </div>

        <label className="mn-rename__option">
          <input
            type="checkbox"
            checked={updateLinks}
            disabled={busy}
            onChange={(event) => setUpdateLinks(event.target.checked)}
          />
          同时改写全库指向它的链接
        </label>

        <div className="mn-dialog__actions">
          <button type="button" className="mn-button" disabled={busy} onClick={close}>
            取消
          </button>
          <button
            type="button"
            className="mn-button mn-button--primary"
            disabled={busy || value.trim() === ''}
            onClick={() => void submit()}
          >
            {busy ? '重命名中…' : '重命名'}
          </button>
        </div>
      </div>
    </div>
  )
}
