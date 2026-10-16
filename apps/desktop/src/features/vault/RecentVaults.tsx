/**
 * 最近打开的 Vault：固定在**左侧栏底部**的快速切换区（Base UI Select 版）。
 *
 * 行为层是 Base UI（combobox/listbox + 方向键 + Esc + 点外面关），外观走
 * `ui-controls.css` 的 `mn-select*`。列表只显示库名；完整路径悬停走 `Tooltip`。
 * 底部固定一项「管理 Vault」—— 点它走 `closeVault`，回到门闸起始页（VaultGate）。
 */

import { useState } from 'react'

import { Select as BaseSelect } from '@base-ui/react/select'

import { closeVault, openRecentVault } from '@/app/actions'
import { Icon } from '@/components/Icon'
import { Tooltip } from '@/components/Tooltip'
import { useVaultStore } from '@/state/vault-store'

/** 与真实路径区分开的哨兵值：选中它 = 回门闸，不写进 `value`。 */
const MANAGE_VAULT = '__manage_vault__'

export function RecentVaults() {
  const recentVaults = useVaultStore((state) => state.recentVaults)
  const currentRoot = useVaultStore((state) => state.info?.rootPath ?? null)
  const [open, setOpen] = useState(false)

  if (recentVaults.length === 0) return null

  const current = recentVaults.find((item) => item.rootPath === currentRoot) ?? null
  const triggerLabel =
    current !== null ? `${current.name}（${current.rootPath}）` : '切换 Vault'

  return (
    <div className="mn-recent-vaults">
      <BaseSelect.Root
        items={[
          ...recentVaults.map((item) => ({ label: item.name, value: item.rootPath })),
          { label: '管理 Vault', value: MANAGE_VAULT },
        ]}
        value={current?.rootPath ?? null}
        onValueChange={(next) => {
          if (next === MANAGE_VAULT) {
            setOpen(false)
            void closeVault()
            return
          }
          if (typeof next === 'string' && next !== '' && next !== currentRoot) {
            void openRecentVault(next)
          }
        }}
        open={open}
        onOpenChange={(next) => setOpen(next)}
      >
        <Tooltip label={triggerLabel}>
          <BaseSelect.Trigger
            className="mn-select mn-select--vault"
            aria-label={`切换 Vault（最近 ${recentVaults.length} 个）`}
          >
            <Icon name="folderOpen" size="xs" />
            <span className="mn-select__value">{current?.name ?? '最近打开的 Vault'}</span>
            <BaseSelect.Icon className="mn-select__icon">
              <Icon name="chevron" size="xs" />
            </BaseSelect.Icon>
          </BaseSelect.Trigger>
        </Tooltip>
        <BaseSelect.Portal>
          <BaseSelect.Positioner
            className="mn-select__positioner"
            side="top"
            sideOffset={6}
            align="start"
            alignItemWithTrigger={false}
          >
            <BaseSelect.Popup className="mn-select__popup mn-vault-popup" aria-label="最近打开的 Vault">
              <BaseSelect.List className="mn-select__list">
                {recentVaults.map((item) => (
                  <Tooltip key={item.rootPath} label={item.rootPath} side="right">
                    <BaseSelect.Item
                      value={item.rootPath}
                      className="mn-select__item mn-select__item--vault"
                    >
                      <Icon name="folder" size="sm" />
                      <span className="mn-vault-copy">
                        <BaseSelect.ItemText>{item.name}</BaseSelect.ItemText>
                      </span>
                      <BaseSelect.ItemIndicator className="mn-vault-check">
                        <Icon name="check" size="sm" />
                      </BaseSelect.ItemIndicator>
                    </BaseSelect.Item>
                  </Tooltip>
                ))}
                <div className="mn-vault-popup__sep" role="separator" />
                <BaseSelect.Item
                  value={MANAGE_VAULT}
                  className="mn-select__item mn-select__item--vault mn-select__item--manage"
                >
                  <Icon name="settings" size="sm" />
                  <span className="mn-vault-copy">
                    <BaseSelect.ItemText>管理 Vault</BaseSelect.ItemText>
                  </span>
                </BaseSelect.Item>
              </BaseSelect.List>
            </BaseSelect.Popup>
          </BaseSelect.Positioner>
        </BaseSelect.Portal>
      </BaseSelect.Root>
    </div>
  )
}
