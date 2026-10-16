/**
 * Vault 门闸：未打开 Vault 时的独立起始窗口（也是浏览器预览模式的说明页）。
 *
 * 「管理 Vault」入口（侧栏最近列表底部）走 `closeVault` 回到这里。
 * 本页负责：主题色品牌、打开新库、最近库列表（打开 / 从列表移除）。
 *
 * 底部的"运行环境"一行会真实发起一次 IPC（`version_info`），因此它同时是
 * **人眼可见的连通性指示**：显示出版本号 = WebView 渲染成功 + 前端 JS 执行成功 + IPC 通道可用。
 */

import { useEffect, useState } from 'react'

import { openVaultInteractive } from '@/app/actions'
import { BrandMark } from '@/components/BrandMark'
import { Icon } from '@/components/Icon'
import { Tooltip } from '@/components/Tooltip'
import { shortenPath } from '@/domain/paths'
import { currentAdapterKind, ipc } from '@/ipc/client'
import { MimenoteError } from '@/ipc/types'
import { useVaultStore } from '@/state/vault-store'

export function VaultGate() {
  const status = useVaultStore((state) => state.status)
  const error = useVaultStore((state) => state.error)
  const recentVaults = useVaultStore((state) => state.recentVaults)
  const openVault = useVaultStore((state) => state.openVault)
  const removeRecentVault = useVaultStore((state) => state.removeRecentVault)
  const [adapter, setAdapter] = useState<string>('')
  const [runtime, setRuntime] = useState<string>('正在检测运行环境…')

  useEffect(() => {
    let cancelled = false
    const kind = currentAdapterKind()
    setAdapter(kind ?? '')

    void ipc
      .versionInfo()
      .then((version) => {
        if (cancelled) return
        setRuntime(
          `运行环境：Tauri ${version.tauri} · mn-core ${version.core} · app ${version.app} · IPC ${kind ?? '未初始化'}`,
        )
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setRuntime(`IPC 不可用（${MimenoteError.from(cause).code}）：文件操作将失败`)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const busy = status === 'loading'

  return (
    <div className="mn-gate">
      <div className="mn-gate__card">
        <div className="mn-gate__brand">
          <BrandMark className="mn-gate__logo" label="Mimenote Logo" />
          <div className="mn-gate__brand-copy">
            <h1 className="mn-gate__title">Mimenote</h1>
            <p className="mn-gate__tagline">本地优先的 Markdown 知识库</p>
          </div>
        </div>

        <div className="mn-gate__actions">
          <button
            type="button"
            className="mn-button mn-button--primary"
            disabled={busy}
            onClick={() => void openVaultInteractive()}
          >
            <Icon name="folderOpen" size="md" />
            {busy ? '正在打开…' : '打开文件夹作为 Vault'}
          </button>
        </div>

        <section className="mn-gate__manage" aria-labelledby="mn-gate-manage-title">
          <h2 className="mn-gate__manage-title" id="mn-gate-manage-title">
            管理 Vault
          </h2>
          {recentVaults.length === 0 ? (
            <p className="mn-gate__manage-empty">还没有最近打开的库。用上方按钮选择一个文件夹。</p>
          ) : (
            <ul className="mn-gate__vault-list">
              {recentVaults.map((item) => (
                <li key={item.rootPath} className="mn-gate__vault-row">
                  <button
                    type="button"
                    className="mn-gate__vault-open"
                    disabled={busy}
                    title={item.rootPath}
                    onClick={() => void openVault(item.rootPath)}
                  >
                    <Icon name="folder" size="sm" />
                    <span className="mn-gate__vault-copy">
                      <span className="mn-gate__vault-name">{item.name}</span>
                      <span className="mn-gate__vault-path">{shortenPath(item.rootPath, 48)}</span>
                    </span>
                  </button>
                  <Tooltip label={`从最近列表移除「${item.name}」`}>
                    <button
                      type="button"
                      className="mn-gate__vault-remove"
                      aria-label={`从最近列表移除 ${item.name}`}
                      disabled={busy}
                      onClick={() => removeRecentVault(item.rootPath)}
                    >
                      <Icon name="x" size="xs" />
                    </button>
                  </Tooltip>
                </li>
              ))}
            </ul>
          )}
        </section>

        {error !== null && (
          <div className="mn-gate__error">
            <Icon name="alert" size="md" />
            <span>{error.message}</span>
          </div>
        )}

        {adapter === 'mock' && (
          <p className="mn-gate__hint">
            当前运行在<strong>浏览器预览模式</strong>（内存 Mock Vault）：
            可以体验界面与编辑流程，但不会读写本机文件。请用 <code>pnpm tauri:dev</code> 启动桌面应用。
          </p>
        )}

        <p className="mn-gate__runtime">{runtime}</p>
      </div>
    </div>
  )
}
