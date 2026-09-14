/**
 * 「移动到文件夹…」对话框 —— **不依赖鼠标**的移动入口。
 *
 * 为什么必须有它：拖拽对键盘用户、对精确操作（目标目录很深时）都不可用，
 * 而"把这篇笔记/这个文件夹挪到那个文件夹"本身是一件与手势无关的事。拖拽只是它的另一种
 * 触发方式，两者最终都走到 `app/actions.moveEntry`，行为与错误提示完全一致。
 *
 * 设计取舍：
 *
 * * 目标用**可输入 + 可点选**的输入框（`<datalist>`）：既支持"打字直达一个很深的目录"，
 *   也支持"从现有目录里挑一个"；输入不存在的目录名也是合法的 —— 宿主会创建它
 *   （"新建一个文件夹把它放进去"是整理的常见动作）；
 * * 不做目录树选择器：那需要把文件树搬进对话框，收益只是少打几个字，却多一份要维护的
 *   交互（以及"对话框里的树要不要跟着过滤器走"这类没完没了的问题）；
 * * 与 `RenameDialog` 一样由 `FileTree` 挂载，触发方式是一次性 DOM 事件；
 * * **文件夹同样支持**：输入它自己的后代时这里就判成非法（`sameOrNested`），
 *   按钮置灰并说明原因 —— 不用等宿主报一句"系统找不到指定的路径"。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { moveEntry } from '@/app/actions'
import { MOVE_REQUEST_EVENT } from '@/app/dom-events'
import { isSameOrInside } from '@/domain/drag'
import { collectDirectoryPaths } from '@/domain/tree'
import { basename, parentOf } from '@/domain/paths'
import { useMoveStore } from '@/state/move-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

import './move-dialog.css'

/** Vault 根的显示名（下拉选项与提示里用）。 */
const ROOT_LABEL = '（Vault 根目录）'

export function MoveDialog() {
  const target = useMoveStore((state) => state.target)
  const entryCount = useVaultStore((state) => state.entries.length)
  const tree = useVaultStore((state) => state.tree)
  const [value, setValue] = useState('')
  const [updateLinks, setUpdateLinks] = useState(true)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const datalistId = useRef(`mn-move-dirs-${Math.random().toString(36).slice(2)}`)
  /** 关闭后把焦点还给打开它的元素（键盘用户不会"掉焦点"）。 */
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  // 现有目录清单：`entryCount` 一变化（换 Vault、新建/移动）就重算，避免列出一个旧目录
  const directories = useMemo(() => collectDirectoryPaths(tree), [tree, entryCount])

  /** 目标是不是文件夹（决定文案，以及"能不能搬进自己后代"这条校验）。 */
  const isDir = useVaultStore((state) =>
    target === null
      ? false
      : state.entries.find((item) => item.relPath === target)?.isDir === true,
  )

  const close = useCallback((): void => {
    useMoveStore.getState().close()
    setValue('')
    setBusy(false)
    const previous = restoreFocusRef.current
    restoreFocusRef.current = null
    if (previous !== null && previous.isConnected) previous.focus()
  }, [])

  const open = useCallback((relPath: string): void => {
    const active = typeof document === 'undefined' ? null : document.activeElement
    restoreFocusRef.current = active instanceof HTMLElement ? active : null
    setValue('')
    setUpdateLinks(true)
    setBusy(false)
    useMoveStore.getState().open(relPath)
  }, [])

  useEffect(() => {
    const handler = (event: Event): void => {
      // 命令面板/快速切换已经开着时不要再叠一层（与 RenameDialog 同一条守卫）
      if (useUiStore.getState().paletteMode !== null) return
      const detail = (event as CustomEvent<string | undefined>).detail
      const relPath = detail ?? useVaultStore.getState().selected
      if (relPath === null || relPath === undefined) return
      const found = useVaultStore.getState().entries.find((item) => item.relPath === relPath)
      if (found === undefined) return
      open(relPath)
    }
    window.addEventListener(MOVE_REQUEST_EVENT, handler)
    return () => {
      window.removeEventListener(MOVE_REQUEST_EVENT, handler)
    }
  }, [open])

  useEffect(() => {
    if (target === null) return
    inputRef.current?.focus()
  }, [target])

  const submit = useCallback(async (): Promise<void> => {
    if (target === null || busy) return
    // 目录写法统一成相对 Vault 根的形式：首尾 `/` 与反斜杠都容忍（与宿主同一口径）
    const targetParentRel = value.trim().replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '')
    setBusy(true)
    const outcome = await moveEntry(target, targetParentRel, { updateLinks })
    if (outcome !== null) {
      close()
      return
    }
    // 失败（重名/非法目录名/磁盘错误）时保留对话框，让用户直接改；原因由 toast 说明
    setBusy(false)
    inputRef.current?.focus()
  }, [busy, close, target, updateLinks, value])

  if (target === null) return null

  const currentDir = parentOf(target)
  const name = basename(target)
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '')
  const newRelPath = normalized === '' ? name : `${normalized}/${name}`
  const samePlace = newRelPath === target
  // 文件夹搬进自己或自己的后代：这里就判成非法（宿主也拦同一件事，但那里的错误话术
  // 来自文件系统，用户无法据以行动）
  const nested = isDir && isSameOrInside(normalized, target)

  return (
    <div
      className="mn-overlay"
      role="presentation"
      onClick={() => {
        if (!busy) close()
      }}
    >
      <div
        className="mn-dialog mn-dialog--move"
        role="dialog"
        aria-modal="true"
        aria-label="移动到"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mn-dialog__header">
          <h2>{isDir ? '移动文件夹到…' : '移动到…'}</h2>
        </div>

        <p className="mn-dialog__message">
          当前位置：{currentDir === '' ? 'Vault 根目录' : currentDir}
          {updateLinks && (
            <span className="mn-move__hint">
              {isDir ? ' · 会同时改写子树里每一篇的链接' : ' · 会同时改写指向它的链接'}
            </span>
          )}
        </p>

        <div className="mn-move__field">
          <input
            ref={inputRef}
            className="mn-move__input"
            type="text"
            aria-label="目标目录"
            placeholder="留空 = Vault 根目录；目录不存在会自动创建"
            list={datalistId.current}
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
          <datalist id={datalistId.current}>
            <option value="">{ROOT_LABEL}</option>
            {directories.map((dir) => (
              <option key={dir} value={dir} />
            ))}
          </datalist>
        </div>

        <p className="mn-dialog__message" data-move-preview={newRelPath}>
          {samePlace
            ? '已经在这个目录里，不需要移动。'
            : nested
              ? '不能把文件夹移动到它自己或它的子目录里。'
              : `将移动到：${newRelPath}`}
        </p>

        <label className="mn-move__option">
          <input
            type="checkbox"
            checked={updateLinks}
            disabled={busy}
            onChange={(event) => setUpdateLinks(event.target.checked)}
          />
          {isDir ? '同时改写全库指向这棵子树里笔记的链接' : '同时改写全库指向它的链接'}
        </label>

        <div className="mn-dialog__actions">
          {directories.length > 0 && (
            <button
              type="button"
              className="mn-button mn-move__root"
              disabled={busy}
              onClick={() => setValue('')}
            >
              根目录
            </button>
          )}
          <button type="button" className="mn-button" disabled={busy} onClick={close}>
            取消
          </button>
          <button
            type="button"
            className="mn-button mn-button--primary"
            disabled={busy || samePlace || nested}
            onClick={() => void submit()}
          >
            {busy ? '移动中…' : '移动'}
          </button>
        </div>
      </div>
    </div>
  )
}
