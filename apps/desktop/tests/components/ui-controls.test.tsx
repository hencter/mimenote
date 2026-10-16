// @vitest-environment jsdom
/**
 * 表单控件（Switch / Select / Checkbox / Slider / Tooltip）：行为层是 Base UI，
 * 外观是手写 `ui-controls.css`。
 *
 * 这里只钉"行为契约"（切换、键盘、禁用、受控值、选项文案），不管像素：
 * 换行为库时这些用例是验收标准；换皮肤时它们不该变红。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Checkbox } from '@/components/Checkbox'
import { Select } from '@/components/Select'
import { Slider } from '@/components/Slider'
import { Switch } from '@/components/Switch'
import { Tooltip } from '@/components/Tooltip'

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

describe('Checkbox', () => {
  it('点击切换（独立使用时 label 必填，名字走 aria-label）', () => {
    const onCheckedChange = vi.fn()
    render(<Checkbox label="同时改写全库链接" checked={false} onCheckedChange={onCheckedChange} />)
    const control = screen.getByRole('checkbox', { name: '同时改写全库链接' })
    expect(control.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(control)
    expect(onCheckedChange).toHaveBeenCalledWith(true)
  })

  it('包在有可见文字的 label 里时省略 label：名字只有一份（不叠成两遍）', () => {
    const onCheckedChange = vi.fn()
    render(
      <label>
        <Checkbox checked={false} onCheckedChange={onCheckedChange} />
        目录在前
      </label>,
    )
    const control = screen.getByRole('checkbox', { name: '目录在前' })
    fireEvent.click(control)
    expect(onCheckedChange).toHaveBeenCalledWith(true)
  })

  it('禁用时点不动', () => {
    const onCheckedChange = vi.fn()
    render(
      <Checkbox label="同时改写全库链接" checked={false} onCheckedChange={onCheckedChange} disabled />,
    )
    const control = screen.getByRole('checkbox', { name: '同时改写全库链接' })
    expect(control.getAttribute('aria-disabled')).toBe('true')

    fireEvent.click(control)
    expect(onCheckedChange).not.toHaveBeenCalled()
  })
})

describe('Slider', () => {
  it('键盘方向键改值并透传（设置页字号行靠它）', () => {
    const onChange = vi.fn()
    render(<Slider label="界面字号" value={16} onChange={onChange} min={11} max={18} step={1} />)
    const thumb = screen.getByRole('slider', { name: '界面字号' })
    expect(thumb.getAttribute('aria-valuenow')).toBe('16')

    fireEvent.keyDown(thumb, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith(17)

    fireEvent.keyDown(thumb, { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenCalledWith(15)
  })

  it('值受控：父组件不更新，显示不动', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <Slider label="界面字号" value={16} onChange={onChange} min={11} max={18} step={1} />,
    )
    expect(screen.getByRole('slider', { name: '界面字号' }).getAttribute('aria-valuenow')).toBe(
      '16',
    )

    rerender(<Slider label="界面字号" value={18} onChange={onChange} min={11} max={18} step={1} />)
    expect(screen.getByRole('slider', { name: '界面字号' }).getAttribute('aria-valuenow')).toBe(
      '18',
    )
  })

  it('禁用渲染的是原生 disabled 输入（真浏览器里聚焦与按键都到不了它）', () => {
    const onChange = vi.fn()
    render(
      <Slider label="界面字号" value={16} onChange={onChange} min={11} max={18} step={1} disabled />,
    )
    // Base 的滑杆本体就是原生 input：disabled 是语义级保证，不是"样式藏起来"。
    // jsdom 里对它发合成键盘事件仍会触发回调（真实按键到不了不可聚焦元素），
    // 所以这里只断言原生属性，不模拟按键。
    expect(screen.getByRole('slider', { name: '界面字号' }).hasAttribute('disabled')).toBe(true)
  })
})

describe('Tooltip', () => {
  it('悬停/聚焦打开（触发器挂 data-popup-open），Esc 关闭；点击透传给原按钮', async () => {
    const onClick = vi.fn()
    render(
      // delay 压到 0：计时是 Base 的行为（它自己有测试），这里只钉"开/关/透传"接线
      <Tooltip label="新建笔记（Ctrl+N）" delay={0}>
        <button type="button" aria-label="新建笔记" onClick={onClick}>
          +
        </button>
      </Tooltip>,
    )
    const trigger = screen.getByRole('button', { name: '新建笔记' })
    expect(trigger.hasAttribute('data-popup-open')).toBe(false)
    // 描述关系在挂载时就连好（读屏知道"描述在哪"），不需要等弹层内容
    expect(trigger.getAttribute('aria-describedby')).not.toBeNull()

    fireEvent.mouseEnter(trigger)
    await waitFor(() => {
      expect(trigger.hasAttribute('data-popup-open')).toBe(true)
    })

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => {
      expect(trigger.hasAttribute('data-popup-open')).toBe(false)
    })

    fireEvent.click(trigger)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('聚焦也打开（键盘用户不依赖鼠标）', async () => {
    render(
      <Tooltip label="新建笔记">
        <button type="button" aria-label="新建笔记">
          +
        </button>
      </Tooltip>,
    )
    const trigger = screen.getByRole('button', { name: '新建笔记' })
    fireEvent.focus(trigger)
    await waitFor(() => {
      expect(trigger.hasAttribute('data-popup-open')).toBe(true)
    })
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
