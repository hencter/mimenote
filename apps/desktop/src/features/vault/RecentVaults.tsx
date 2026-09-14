/**
 * 最近打开的 Vault：固定在**左侧栏底部**的快速切换区。
 *
 * 为什么放这里而不是状态栏/菜单：切 Vault 是文件树这个上下文的动作 ——
 * 用户的视线就在这一栏；而且它必须跟着侧栏一起被 `Ctrl+B` 藏掉（`App.tsx` 里
 * 它在 `.mn-sidebar` 内部，侧栏隐藏时不渲染，不需要第二个落点）。
 *
 * 形态：收起时只有一行低调摘要（「最近 · N」），点击展开列表。
 * - 列表项 = Vault 名 + 完整路径（title 里再给一份，路径被截断时也能看全）；
 * - 当前 Vault 那一条高亮且**不可重复点**（重开同一个 Vault 只会白白重扫一次）；
 * - 条目右侧的 × 把它从列表里移除（`removeRecentVault`）—— 不碰磁盘、不影响
 *   「上次打开」的恢复键，只影响这张列表；
 * - 点击切换走 `openRecentVault`（先落盘未保存内容，再 `openVault`）；
 *   目录已不在时 `openVault` 自己弹 toast，这里**不**额外加确认框。
 */

import { useState } from 'react'

import { openRecentVault } from '@/app/actions'
import { Icon } from '@/components/Icon'
import { useVaultStore } from '@/state/vault-store'

import './recent-vaults.css'

export function RecentVaults() {
  const recentVaults = useVaultStore((state) => state.recentVaults)
  const currentRoot = useVaultStore((state) => state.info?.rootPath ?? null)
  const removeRecentVault = useVaultStore((state) => state.removeRecentVault)
  const [open, setOpen] = useState(false)

  // 一条记录都没有时整块不渲染：空区域比一个永远灰着的入口更诚实
  if (recentVaults.length === 0) return null

  return (
    <div className="mn-recent-vaults">
      <button
        type="button"
        className="mn-recent-vaults__summary"
        aria-expanded={open}
        aria-label="最近打开的 Vault"
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="folderOpen" size={13} />
        <span className="mn-recent-vaults__summary-text">最近 · {recentVaults.length}</span>
        <span className={`mn-recent-vaults__chevron${open ? ' mn-recent-vaults__chevron--open' : ''}`}>
          <Icon name="chevron" size={12} />
        </span>
      </button>
      {open && (
        <ul className="mn-recent-vaults__list">
          {recentVaults.map((item) => {
            const isCurrent = item.rootPath === currentRoot
            return (
              <li key={item.rootPath} className="mn-recent-vaults__item">
                <button
                  type="button"
                  className={`mn-recent-vaults__entry${
                    isCurrent ? ' mn-recent-vaults__entry--current' : ''
                  }`}
                  title={item.rootPath}
                  disabled={isCurrent}
                  aria-current={isCurrent ? 'true' : undefined}
                  onClick={() => void openRecentVault(item.rootPath)}
                >
                  <span className="mn-recent-vaults__name">{item.name}</span>
                  <span className="mn-recent-vaults__path">{item.rootPath}</span>
                </button>
                <button
                  type="button"
                  className="mn-recent-vaults__remove"
                  aria-label={`从最近列表移除 ${item.name}`}
                  title="从最近列表移除"
                  onClick={() => removeRecentVault(item.rootPath)}
                >
                  <Icon name="x" size={12} />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
