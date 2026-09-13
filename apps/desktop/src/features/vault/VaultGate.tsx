/**
 * Vault 门闸：未打开 Vault 时的首屏（也是浏览器预览模式的说明页）。
 *
 * 底部的"运行环境"一行会真实发起一次 IPC（`version_info`），因此它同时是
 * **人眼可见的连通性指示**：显示出版本号 = WebView 渲染成功 + 前端 JS 执行成功 + IPC 通道可用。
 */

import { useEffect, useState } from 'react'

import { openVaultInteractive } from '@/app/actions'
import { Icon } from '@/components/Icon'
import { shortenPath } from '@/domain/paths'
import { currentAdapterKind, ipc } from '@/ipc/client'
import { MimenoteError } from '@/ipc/types'
import { useVaultStore } from '@/state/vault-store'

export function VaultGate() {
  const status = useVaultStore((state) => state.status)
  const error = useVaultStore((state) => state.error)
  const lastRoot = useVaultStore((state) => state.lastRoot)
  const openVault = useVaultStore((state) => state.openVault)
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

  return (
    <div className="mn-gate">
      <div className="mn-gate__card">
        <div className="mn-gate__brand">
          <Icon name="sparkle" size={26} />
          <div>
            <h1>Mimenote</h1>
            <p className="mn-gate__tagline">本地优先的 Markdown 知识库</p>
          </div>
        </div>

        <ul className="mn-gate__features">
          <li>你的笔记就是普通文件夹里的普通 Markdown 文件</li>
          <li>可被 Git 管理，可被任何编辑器打开，随时可以搬走</li>
          <li>默认离线：无遥测、无自动上传、运行时不发起任何网络请求</li>
          <li>写入原子替换、外部修改检测、删除进回收站</li>
        </ul>

        <div className="mn-gate__actions">
          <button
            type="button"
            className="mn-button mn-button--primary"
            disabled={status === 'loading'}
            onClick={() => void openVaultInteractive()}
          >
            <Icon name="folderOpen" size={15} />
            {status === 'loading' ? '正在打开…' : '打开文件夹作为 Vault'}
          </button>

          {lastRoot !== null && lastRoot !== '' && (
            <button
              type="button"
              className="mn-button"
              disabled={status === 'loading'}
              title={lastRoot}
              onClick={() => void openVault(lastRoot)}
            >
              上次打开：{shortenPath(lastRoot, 40)}
            </button>
          )}
        </div>

        {error !== null && (
          <div className="mn-gate__error">
            <Icon name="alert" size={15} />
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
