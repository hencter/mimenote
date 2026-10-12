/**
 * 最近打开的 Vault：固定在**左侧栏底部**的快速切换区（Base UI Select 版）。
 *
 * 从前这里是手写摘要按钮 + `ul` 浮层：没有键盘走位、没有 typeahead、Esc 与焦点管理
 * 全靠自己写 —— 正是 ADR-0042 说要换掉的那类"行为手写"控件。现在行为层是 Base UI
 * （combobox/listbox + 方向键 + Esc + 点外面关 + 焦点归还），外观仍是手写
 * `ui-controls.css`（`mn-select*` 类名，与设置页的下拉同一套， token 映射只有一份）。
 *
 * 两处与通用 `components/Select` 不同的地方，所以没有复用它而是直接组装 Base 零件：
 * 1. 选项是两行的（Vault 名 + 完整路径），通用版只渲染单行 label；
 * 2. 每行尾部有一个移除 ×（`removeRecentVault`，不碰磁盘、只影响这张列表）。
 *    × 是真正的 button（`stopPropagation` 拦住选中提交，键盘 Tab 可达、Enter 删除）；
 *    当前 Vault 保留在选项中并显示对勾；只有一个库时也保留 Select。
 *
 * 形态保持不变：一条记录都没有时整块不渲染（空区域比永远灰着的入口更诚实）；
 * 切换走 `openRecentVault`（先落盘未保存内容），目录已不在时 `openVault` 自己弹 toast。
 */

import { useState } from 'react'

import { Select as BaseSelect } from '@base-ui/react/select'

import { openRecentVault } from '@/app/actions'
import { Icon } from '@/components/Icon'
import { useVaultStore } from '@/state/vault-store'

export function RecentVaults() {
  const recentVaults = useVaultStore((state) => state.recentVaults)
  const currentRoot = useVaultStore((state) => state.info?.rootPath ?? null)
  const removeRecentVault = useVaultStore((state) => state.removeRecentVault)
  // 受控开合：删掉最后一行时主动收起（否则 Portal 里会留一个空弹层）
  const [open, setOpen] = useState(false)

  // 一条记录都没有时整块不渲染：空区域比一个永远灰着的入口更诚实
  if (recentVaults.length === 0) return null

  const current = recentVaults.find((item) => item.rootPath === currentRoot) ?? null
  const removeButton = (item: (typeof recentVaults)[number]) => (
    <button
      type="button"
      className="mn-select__remove"
      aria-label={`从最近列表移除 ${item.name}`}
      title="从最近列表移除（不会删除文件）"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        removeRecentVault(item.rootPath)
        if (recentVaults.length <= 1) setOpen(false)
      }}
    >
      <Icon name="x" size="xs" />
    </button>
  )

  return (
    <div className="mn-recent-vaults">
      <BaseSelect.Root
        items={recentVaults.map((item) => ({ label: item.name, value: item.rootPath }))}
        value={current?.rootPath ?? null}
        onValueChange={(next) => {
          if (typeof next === 'string' && next !== '' && next !== currentRoot) void openRecentVault(next)
        }}
        open={open}
        onOpenChange={(next) => setOpen(next)}
      >
        <BaseSelect.Trigger
          className="mn-select mn-select--vault"
          aria-label={`切换 Vault（最近 ${recentVaults.length} 个）`}
          title={current !== null ? current.rootPath : '切换 Vault'}
        >
          <Icon name="folderOpen" size="xs" />
          <span className="mn-select__value">{current?.name ?? '最近打开的 Vault'}</span>
          <BaseSelect.Icon className="mn-select__icon">
            <Icon name="chevron" size="xs" />
          </BaseSelect.Icon>
        </BaseSelect.Trigger>
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
                {recentVaults.map((item) => {
                  return (
                    <BaseSelect.Item
                      key={item.rootPath}
                      value={item.rootPath}
                      className="mn-select__item mn-select__item--vault"
                      title={item.rootPath}
                    >
                      <Icon name="folder" size="sm" />
                      <span className="mn-vault-copy"><BaseSelect.ItemText>{item.name}</BaseSelect.ItemText><small>{item.rootPath}</small></span>
                      <BaseSelect.ItemIndicator className="mn-vault-check">
                        <Icon name="check" size="sm" />
                      </BaseSelect.ItemIndicator>
                      {removeButton(item)}
                    </BaseSelect.Item>
                  )
                })}
              </BaseSelect.List>
            </BaseSelect.Popup>
          </BaseSelect.Positioner>
        </BaseSelect.Portal>
      </BaseSelect.Root>
    </div>
  )
}
