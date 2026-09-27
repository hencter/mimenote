/**
 * 插件安装确认框（M4 权限模型的用户侧）：把 manifest 的身份与权限逐条摆出来，
 * 用户点"允许"才加载，点"取消"/遮罩/Esc 一律视为拒绝。
 *
 * 样式沿用全站 `.mn-overlay` / `.mn-dialog` / `.mn-button`（见 `ConfirmDialog`），
 * 不新增样式表；`role="alertdialog"` 让全局快捷键层自动把它当模态（见 `app/keymap.ts`）。
 */

import { useEffect, useRef } from 'react'

import type { PluginManifest } from './manifest'
import { describePermissions } from './manifest'

export interface PluginPermissionDialogProps {
  /** 为空时不渲染（调用方据此控制开关）。 */
  manifest: PluginManifest | null
  onAllow: () => void
  onDeny: () => void
}

export function PluginPermissionDialog({ manifest, onAllow, onDeny }: PluginPermissionDialogProps) {
  const allowRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (manifest === null) return
    allowRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onDeny()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [manifest, onDeny])

  if (manifest === null) return null

  return (
    <div className="mn-overlay" role="presentation" onClick={onDeny}>
      <div
        className="mn-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={`安装插件 ${manifest.name}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mn-dialog__header">
          <h2>安装插件？</h2>
        </div>
        <p className="mn-dialog__message">
          {manifest.name}（{manifest.id} {manifest.version}，要求应用 ≥ {manifest.minAppVersion}）
          请求以下权限：
        </p>
        <ul>
          {describePermissions(manifest.permissions).map((description) => (
            <li key={description}>{description}</li>
          ))}
        </ul>
        <div className="mn-dialog__actions">
          <button type="button" className="mn-button" onClick={onDeny}>
            取消
          </button>
          <button ref={allowRef} type="button" className="mn-button mn-button--primary" onClick={onAllow}>
            允许并安装
          </button>
        </div>
      </div>
    </div>
  )
}
