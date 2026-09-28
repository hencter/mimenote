/**
 * 复选框（对话框里的布尔项用它，不用原生 checkbox）。
 *
 * 与 `Switch` 是同一族（Base UI，`checked`/`onCheckedChange`/`data-checked`），
 * 区别只有外观：方形盒 + 勾。设置页的偏好用开关（Switch），对话框里的表单项用它 ——
 * 两处语义不同（"偏好" vs "表单确认"），视觉上也不该长一样。
 */

import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox'

import { Icon } from './Icon'
import './ui-controls.css'

export interface CheckboxProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /**
   * 无障碍名。包在有可见文字的 `<label>` 里时**省略**（名字走 label 文本；
   * 同时写两处会被读屏拼成"目录在前 目录在前"）。独立使用（周围没有 label）时必填。
   */
  label?: string
  disabled?: boolean
}

export function Checkbox({ checked, onCheckedChange, label, disabled = false }: CheckboxProps) {
  return (
    <BaseCheckbox.Root
      className="mn-checkbox"
      checked={checked}
      onCheckedChange={(next) => onCheckedChange(next)}
      disabled={disabled}
      aria-label={label}
    >
      <BaseCheckbox.Indicator className="mn-checkbox__indicator">
        <Icon name="check" size="xs" />
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  )
}
