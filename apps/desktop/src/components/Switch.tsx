/**
 * 开关（设置页的布尔项用它，不用原生 checkbox）。
 *
 * 行为层是 Base UI 的无样式 `Switch`（键盘 Space/Enter、aria `role="switch"`、
 * `aria-checked`、禁用态全由它管）；**外观**仍是手写 CSS（`ui-controls.css`），
 * 只读 `--mn-*` 令牌 —— 换主题、纸墨、用户片段都不用改这里。
 *
 * 为什么包一层而不是直接用 `Switch.Root`：调用方只关心"值 + 无障碍名"，
 * 类名与 Thumb 组装是本文件的唯一口径（以后换行为库只改这里）。
 */

import { Switch as BaseSwitch } from '@base-ui/react/switch'

import './ui-controls.css'

export interface SwitchProps {
  /** 受控值。 */
  checked: boolean
  /** 值变化（点击 / Space / Enter）。 */
  onCheckedChange: (checked: boolean) => void
  /** 无障碍名（行内已有可见标题时也保留：读屏与测试都靠它定位）。 */
  label: string
  /** 禁用。 */
  disabled?: boolean
}

export function Switch({ checked, onCheckedChange, label, disabled = false }: SwitchProps) {
  return (
    <BaseSwitch.Root
      className="mn-switch"
      checked={checked}
      onCheckedChange={(next) => onCheckedChange(next)}
      disabled={disabled}
      aria-label={label}
    >
      <BaseSwitch.Thumb className="mn-switch__thumb" />
    </BaseSwitch.Root>
  )
}
