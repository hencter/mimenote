// @vitest-environment jsdom
/**
 * 表单控件（Switch / Select）：行为层是 Base UI，外观是手写 `ui-controls.css`。
 *
 * 这里只钉"行为契约"（切换、键盘、禁用、受控值、选项文案），不管像素：
 * 换行为库时这些用例是验收标准；换皮肤时它们不该变红。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Select } from '@/components/Select'
import { Switch } from '@/components/Switch'

afterEach(() => {
  cleanup()
})

/**
 * 真实鼠标点选项 = pointerdown + click：Base UI 靠 pointerdown 置位才提交 click
 *（防"打开瞬间光标下的选项被误点"；见 SelectItem 的 allowMouseSelection）。
 * 测试里只发 click 等于发了一个"没有按下去过的点击"，会被合法地忽略。
 */
function clickOption(option: HTMLElement): void {
  fireEvent.pointerDown(option)
  fireEvent.click(option)
}

describe('Switch', () => {
  it('点击切换值并如实反映 aria-checked', () => {
    const onCheckedChange = vi.fn()
    const { rerender } = render(
      <Switch label="显示行号" checked={false} onCheckedChange={onCheckedChange} />,
    )
    const control = screen.getByRole('switch', { name: '显示行号' })
    expect(control.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(control)
    expect(onCheckedChange).toHaveBeenCalledWith(true)

    rerender(<Switch label="显示行号" checked={true} onCheckedChange={onCheckedChange} />)
    expect(screen.getByRole('switch', { name: '显示行号' }).getAttribute('aria-checked')).toBe(
      'true',
    )
  })

  it('键盘 Space/Enter 也能切换（键盘用户不依赖鼠标）', () => {
    const onCheckedChange = vi.fn()
    render(<Switch label="显示行号" checked={false} onCheckedChange={onCheckedChange} />)
    const control = screen.getByRole('switch', { name: '显示行号' })

    fireEvent.keyDown(control, { key: ' ' })
    fireEvent.keyUp(control, { key: ' ' })
    expect(onCheckedChange).toHaveBeenCalledWith(true)
  })

  it('禁用时点不动', () => {
    const onCheckedChange = vi.fn()
    render(<Switch label="显示行号" checked={false} onCheckedChange={onCheckedChange} disabled />)
    const control = screen.getByRole('switch', { name: '显示行号' })
    expect(control.getAttribute('aria-disabled')).toBe('true')

    fireEvent.click(control)
    expect(onCheckedChange).not.toHaveBeenCalled()
  })
})

const OPTIONS = [
  { value: '600', label: '600 ms' },
  { value: '2000', label: '2000 ms' },
]

describe('Select', () => {
  it('点开后选一项，onChange 拿到值且 trigger 显示文案', async () => {
    const onChange = vi.fn()
    render(<Select label="自动保存延迟" value="600" onChange={onChange} options={OPTIONS} />)

    const trigger = screen.getByRole('combobox', { name: '自动保存延迟' })
    expect(trigger.textContent).toContain('600 ms')

    fireEvent.click(trigger)
    const option = await screen.findByRole('option', { name: '2000 ms' })
    clickOption(option)

    expect(onChange).toHaveBeenCalledWith('2000')
  })

  it('键盘在选项上按回车选中', async () => {
    const onChange = vi.fn()
    render(<Select label="自动保存延迟" value="600" onChange={onChange} options={OPTIONS} />)

    fireEvent.click(screen.getByRole('combobox', { name: '自动保存延迟' }))
    const option = await screen.findByRole('option', { name: '2000 ms' })
    fireEvent.keyDown(option, { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith('2000')
  })

  it('禁用时打不开', () => {
    const onChange = vi.fn()
    render(
      <Select label="自动保存延迟" value="600" onChange={onChange} options={OPTIONS} disabled />,
    )
    // trigger 是原生 button：禁用就是真的 disabled（点不动、Tab 跳过）
    const trigger = screen.getByRole<HTMLButtonElement>('combobox', { name: '自动保存延迟' })
    expect(trigger.disabled).toBe(true)

    fireEvent.click(trigger)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })
})
