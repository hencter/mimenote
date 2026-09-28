/**
 * 悬停/聚焦提示（图标按钮的说明文字用它，不用原生 `title`）。
 *
 * 原生 `title` 有三个毛病：出现慢（约 1s）、样式不可控（与主题脱节）、
 * 触摸设备上根本不出现。Base UI 的 Tooltip：悬停/聚焦即现、Esc 关闭、
 * `role="tooltip"` 与触发器自动关联。
 *
 * 用法（`render` 透传，被包的元素不增加 DOM 层级）：
 *
 * ```tsx
 * <Tooltip label="新建笔记（Ctrl+N）">
 *   <button type="button" className="mn-icon-button" aria-label="新建笔记" onClick={...}>
 *     <Icon name="plus" />
 *   </button>
 * </Tooltip>
 * ```
 *
 * 被包元素必须能收 `ref` 与处理器（原生 button 全都可以）；`aria-label` 留在元素上，
 * Tooltip 只负责"看得见的提示"，读屏走原标签 —— 两边不抢。
 */

import * as React from 'react'

import { mergeProps } from '@base-ui/react/merge-props'
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip'

import './ui-controls.css'

export interface TooltipProps {
  /** 提示文本（与触发器的 `aria-label` 同文，保持"看到的"与"听到的"一致）。 */
  label: string
  /** 被包装的单个可交互元素。 */
  children: React.ReactElement
  /** 弹出方位（默认上方；空间不够时 Base 自动翻面）。 */
  side?: 'top' | 'bottom' | 'left' | 'right'
  /** 悬停多久出现（ms；聚焦立刻出现，不受它影响）。 */
  delay?: number
}

export function Tooltip({ label, children, side = 'top', delay = 400 }: TooltipProps) {
  // Base 不替我们连 trigger 与 popup（无障碍名不需要它，但读屏需要知道"描述在哪"）：
  // id 稳定，popup 没打开时引用悬空 —— 悬空引用会被读屏忽略，不会误报。
  const popupId = React.useId()
  return (
    // `delay` 只在 Provider 上：相邻的几个 Tooltip 共用一组计时，鼠标从一个按钮
    // 滑到下一个时不会重新等一遍（与 shadcn 默认行为一致）
    <BaseTooltip.Provider delay={delay}>
      <BaseTooltip.Root>
        <BaseTooltip.Trigger
          // `render` 透传：Base 把自己定位用的 ref 与处理器并进子元素，不增加 DOM 层级；
          // `mergeProps` 保证子元素自己的 onClick 等处理器不被吃掉（直接展开会覆盖）。
          render={(triggerProps) =>
            React.cloneElement(
              children,
              mergeProps(
                {
                  ...(children.props as Record<string, unknown>),
                  'aria-describedby': popupId,
                },
                triggerProps as Record<string, unknown>,
              ) as React.Attributes,
            )
          }
        />
        <BaseTooltip.Portal>
          <BaseTooltip.Positioner className="mn-tooltip__positioner" side={side} sideOffset={6}>
            <BaseTooltip.Popup id={popupId} role="tooltip" className="mn-tooltip">
              {label}
            </BaseTooltip.Popup>
          </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
      </BaseTooltip.Root>
    </BaseTooltip.Provider>
  )
}
