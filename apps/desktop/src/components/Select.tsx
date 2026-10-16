/**
 * 下拉选择（设置页的枚举项用它，不用原生 `<select>`）。
 *
 * 行为层是 Base UI 的无样式 `Select`：trigger `role="combobox"`、列表 `role="listbox"`、
 * 方向键走位、Home/End、打字 typeahead、Esc 关闭、点外面关闭、开合时焦点管理，
 * 全由它管。**外观**仍是手写 CSS（`ui-controls.css`），只读 `--mn-*` 令牌。
 *
 * 两处刻意的设计取舍：
 * 1. `alignItemWithTrigger={false}`：弹出层永远是 trigger 下方的普通下拉，而不是
 *    Base UI 默认的"选中项与 trigger 值对齐"模式 —— 后者在设置页这种窄行里飘忽，
 *    而普通下拉的行为用户已经从别处学会了；
 * 2. **对勾在右、文字在左**（`1fr 16px`）：文字永远落在第一列左对齐；对勾只在选中行
 *    出现，未选中行右侧留空。勾放左边时，Base UI 不渲染未选中的 Indicator，文字会错位。
 */

import { Select as BaseSelect } from '@base-ui/react/select'

import { Icon, type IconName } from './Icon'
import './ui-controls.css'

/** 一个选项。 */
export interface SelectOption {
  value: string
  label: string
}

export interface SelectProps {
  /** 受控值（必须是 `options` 里某一项的 `value`）。 */
  value: string
  /** 值变化。 */
  onChange: (value: string) => void
  /** 选项（顺序即展示顺序）。 */
  options: readonly SelectOption[]
  /** 无障碍名。 */
  label: string
  /** 禁用。 */
  disabled?: boolean
  /** 紧凑属性类型入口：只展示图标，无障碍名称仍由 label 提供。 */
  icon?: IconName
}

export function Select({ value, onChange, options, label, disabled = false, icon }: SelectProps) {
  return (
    <BaseSelect.Root
      items={options.map((option) => ({ label: option.label, value: option.value }))}
      value={value}
      onValueChange={(next) => onChange(next as string)}
      disabled={disabled}
    >
      <BaseSelect.Trigger className={`mn-select${icon ? ' mn-select--icon' : ''}`} aria-label={label} title={label}>
        {icon ? <Icon name={icon} size="sm" /> : <BaseSelect.Value />}
        {!icon && <BaseSelect.Icon className="mn-select__icon">
          <Icon name="chevron" size="xs" />
        </BaseSelect.Icon>}
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner className="mn-select__positioner" sideOffset={4} alignItemWithTrigger={false}>
          <BaseSelect.Popup className="mn-select__popup" aria-label={label}>
            <BaseSelect.List className="mn-select__list">
              {options.map((option) => (
                <BaseSelect.Item key={option.value} value={option.value} className="mn-select__item">
                  <BaseSelect.ItemText className="mn-select__text">{option.label}</BaseSelect.ItemText>
                  <span className="mn-select__indicator" aria-hidden="true">
                    <BaseSelect.ItemIndicator>
                      <Icon name="check" size="xs" />
                    </BaseSelect.ItemIndicator>
                  </span>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  )
}
