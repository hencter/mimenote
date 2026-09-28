/**
 * 滑杆（设置页的字号三档用它，不用原生 `input[type="range"]`）。
 *
 * 行为层是 Base UI 的无样式 `Slider`（键盘方向键/PageUp/Home、拖拽、
 * `role="slider"` + `aria-valuenow` 全由它管）；**外观**仍是手写 CSS
 * （`ui-controls.css`），只读 `--mn-*` 令牌。
 */

import { Slider as BaseSlider } from '@base-ui/react/slider'

import './ui-controls.css'

export interface SliderProps {
  /** 受控值。 */
  value: number
  /** 值变化（拖拽中连续触发；只在"落定"时写 store 由调用方决定）。 */
  onChange: (value: number) => void
  min: number
  max: number
  step?: number
  /** 无障碍名（行内已有可见标题时也保留：读屏与测试都靠它定位）。 */
  label: string
  disabled?: boolean
}

export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  label,
  disabled = false,
}: SliderProps) {
  return (
    <BaseSlider.Root
      className="mn-slider"
      value={value}
      onValueChange={(next) => {
        if (typeof next === 'number') onChange(next)
      }}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
    >
      <BaseSlider.Control className="mn-slider__control">
        <BaseSlider.Track className="mn-slider__track">
          <BaseSlider.Indicator className="mn-slider__indicator" />
          <BaseSlider.Thumb className="mn-slider__thumb" aria-label={label} />
        </BaseSlider.Track>
      </BaseSlider.Control>
    </BaseSlider.Root>
  )
}
