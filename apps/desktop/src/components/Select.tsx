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
 * 2. 文本列固定在第二列（`.mn-select__text { grid-column: 2 }`）：选中勾只在选中行挂载，
 *    不固定列的话每行的文字会对不齐。
 */

import { Select as BaseSelect } from '@base-ui/react/select'

import { Icon } from './Icon'
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
}

export function Select({ value, onChange, options, label, disabled = false }: SelectProps) {
  return (
    <BaseSelect.Root
      items={options.map((option) => ({ label: option.label, value: option.value }))}
      value={value}
      onValueChange={(next) => onChange(next as string)}
      disabled={disabled}
    >
      <BaseSelect.Trigger className="mn-select" aria-label={label}>
        <BaseSelect.Value />
        <BaseSelect.Icon className="mn-select__icon">
          <Icon name="chevron" size="xs" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner className="mn-select__positioner" sideOffset={4} alignItemWithTrigger={false}>
          <BaseSelect.Popup className="mn-select__popup" aria-label={label}>
            <BaseSelect.List className="mn-select__list">
              {options.map((option) => (
                <BaseSelect.Item key={option.value} value={option.value} className="mn-select__item">
                  <BaseSelect.ItemIndicator className="mn-select__indicator">
                    <Icon name="check" size="xs" />
                  </BaseSelect.ItemIndicator>
                  <BaseSelect.ItemText className="mn-select__text">{option.label}</BaseSelect.ItemText>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  )
}
