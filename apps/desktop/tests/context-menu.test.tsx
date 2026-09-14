// @vitest-environment jsdom
/**
 * 通用右键菜单（`components/ContextMenu.tsx`）。
 *
 * 为什么它值得单独一组用例：菜单项本身只是按钮，真正容易坏的是**周边行为** ——
 * 点外面关、`Esc` 关、方向键走位（跳过置灰项）、`Enter` 执行、超出视口时夹回、
 * 关闭后焦点还给打开它的元素。这些行为一旦漏掉，表现是"菜单关不掉"或"键盘用户迷路"，
 * 而它们每个模块都要用，所以判据必须钉在组件这一层。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ContextMenu, type ContextMenuItem } from '@/components/ContextMenu'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function items(overrides: Partial<ContextMenuItem> = {}): ContextMenuItem[] {
  return [
    { id: 'open', label: '打开', onSelect: vi.fn(), ...overrides },
    { id: 'rename', label: '重命名…', onSelect: vi.fn() },
    { id: 'delete', label: '删除', onSelect: vi.fn(), danger: true, separatorBefore: true },
  ]
}

describe('ContextMenu', () => {
  it('渲染成 role=menu 的菜单，每个可选项是 menuitem，危险项带自己的类', () => {
    render(<ContextMenu items={items()} x={10} y={20} onClose={vi.fn()} ariaLabel="测试菜单" />)

    const menu = screen.getByRole('menu', { name: '测试菜单' })
    expect(menu).toBeTruthy()
    expect(screen.getAllByRole('menuitem').map((node) => node.textContent)).toEqual([
      '打开',
      '重命名…',
      '删除',
    ])
    expect(
      document.querySelector('[data-menu-item="delete"]')?.className,
    ).toContain('mn-context-menu__item--danger')
  })

  it('点一项：先执行 onSelect，再请求关闭', async () => {
    const onClose = vi.fn()
    const menuItems = items()
    render(<ContextMenu items={menuItems} x={10} y={20} onClose={onClose} />)

    fireEvent.click(screen.getByRole('menuitem', { name: '重命名…' }))

    expect(menuItems[1]?.onSelect).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('置灰的项：点不动，也**不进**键盘走位', () => {
    const onClose = vi.fn()
    const disabled = vi.fn()
    render(
      <ContextMenu
        items={[
          { id: 'a', label: '甲', onSelect: vi.fn() },
          { id: 'b', label: '乙（不可用）', onSelect: disabled, disabled: true },
          { id: 'c', label: '丙', onSelect: vi.fn() },
        ]}
        x={0}
        y={0}
        onClose={onClose}
      />,
    )

    const middle = screen.getByRole('menuitem', { name: '乙（不可用）' })
    fireEvent.click(middle)
    expect(disabled).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()

    // 走位从"甲"直接到"丙"（跳过置灰项）
    const first = screen.getByRole('menuitem', { name: '甲' })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '丙' }))
  })

  it('方向键在首尾循环，Home / End 直达两端', () => {
    render(<ContextMenu items={items()} x={0} y={0} onClose={vi.fn()} />)
    const [first, second, third] = screen.getAllByRole('menuitem') as HTMLElement[]

    first?.focus()
    fireEvent.keyDown(first as HTMLElement, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(third) // 从第一个往上 = 绕到最后一个

    fireEvent.keyDown(third as HTMLElement, { key: 'Home' })
    expect(document.activeElement).toBe(first)

    fireEvent.keyDown(first as HTMLElement, { key: 'End' })
    expect(document.activeElement).toBe(third)

    fireEvent.keyDown(third as HTMLElement, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first as HTMLElement, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(second)
  })

  it('Esc 关闭；点菜单外面关闭（在菜单里面点不关）', () => {
    const onClose = vi.fn()
    render(
      <div>
        <button type="button">外面</button>
        <ContextMenu items={items()} x={0} y={0} onClose={onClose} />
      </div>,
    )

    fireEvent.mouseDown(screen.getByRole('menuitem', { name: '打开' }))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.mouseDown(screen.getByRole('button', { name: '外面' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('打开时焦点进入第一项；卸载后焦点还给"打开它的那个元素"', async () => {
    const trigger = document.createElement('button')
    trigger.textContent = '触发者'
    document.body.append(trigger)
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    const { unmount } = render(<ContextMenu items={items()} x={0} y={0} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '打开' }))
    })

    // 关闭（父组件把菜单从树里摘掉）之后焦点回到触发它的元素，不从 body 重新 Tab
    unmount()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('超出视口时夹回可视区（窗口右下角右键不该只看得见前两项）', () => {
    // jsdom 里没有布局：把尺寸与窗口大小都造出来，才谈得上"夹回"
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 200,
      height: 150,
      top: 0,
      left: 0,
      right: 200,
      bottom: 150,
      toJSON: () => ({}),
    } as DOMRect)
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(300)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(200)

    render(<ContextMenu items={items()} x={280} y={190} onClose={vi.fn()} />)

    const menu = screen.getByRole('menu')
    // 右边与下边各留 8px：x ≤ 300 - 200 - 8，y ≤ 200 - 150 - 8
    expect(menu.style.left).toBe('92px')
    expect(menu.style.top).toBe('42px')
  })
})
