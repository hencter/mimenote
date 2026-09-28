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
 *    当前 Vault 那一行禁用（重开同一个只会白白重扫一次），同时挂着选中勾。
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

  return (
    <div className="mn-recent-vaults">
      <BaseSelect.Root
        items={recentVaults.map((item) => ({ label: item.name, value: item.rootPath }))}
        value={current?.rootPath ?? null}
        onValueChange={(next) => {
          if (typeof next === 'string' && next !== '') void openRecentVault(next)
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
          <BaseSelect.Value
            className="mn-select__value"
            placeholder="最近打开的 Vault"
          >
            {(value: string | null) =>
              recentVaults.find((item) => item.rootPath === value)?.name ?? '最近打开的 Vault'
            }
          </BaseSelect.Value>
          <BaseSelect.Icon className="mn-select__icon">
            <Icon name="chevron" size="xs" />
          </BaseSelect.Icon>
        </BaseSelect.Trigger>
        <BaseSelect.Portal>
          <BaseSelect.Positioner
            className="mn-select__positioner"
            side="top"
            sideOffset={6}
            alignItemWithTrigger={false}
          >
            <BaseSelect.Popup className="mn-select__popup" aria-label="最近打开的 Vault">
              <BaseSelect.List className="mn-select__list">
                {recentVaults.map((item) => {
                  const isCurrent = item.rootPath === currentRoot
                  return (
                    <BaseSelect.Item
                      key={item.rootPath}
                      value={item.rootPath}
                      disabled={isCurrent}
                      className="mn-select__item mn-select__item--vault"
                    >
                      <BaseSelect.ItemIndicator className="mn-select__indicator">
                        <Icon name="check" size="xs" />
                      </BaseSelect.ItemIndicator>
                      <span className="mn-select__item-main" title={item.rootPath}>
                        <SelectValueText className="mn-select__text" value={item.name} />
                        <span className="mn-select__path">{item.rootPath}</span>
                      </span>
                      <button
                        type="button"
                        className="mn-select__remove"
                        aria-label={`从最近列表移除 ${item.name}`}
                        title="从最近列表移除（不碰磁盘）"
                        // 两道都要拦：pointerdown 拦 Base 的选中置位，click 拦选中提交 ——
                        // 点 × 是"删除这一行"，绝不能顺手把 Vault 切过去
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation()
                          removeRecentVault(item.rootPath)
                          if (recentVaults.length <= 1) setOpen(false)
                        }}
                      >
                        <Icon name="x" size="xs" />
                      </button>
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

/**
 * 行内文本（`ItemText` 的轻量替代）。
 *
 * 不用 `Select.ItemText` 是因为它只能有一个（单行 label），而这里一行里
 * 名字与路径是两个独立的截断单元 —— 各自 ellipsis，互不顶替。
 */
function SelectValueText({ className, value }: { className?: string; value: string }) {
  return <span className={className}>{value}</span>
}
