/**
 * 通用右键菜单（任何一个"模块"都能用它挂自己的菜单项）。
 *
 * ## 为什么做成一个通用组件，而不是给每个模块各写一个浮层
 *
 * 右键菜单看起来只是"一列按钮"，真正难写的全是**共有的周边行为**：点外面关、`Esc` 关、
 * 方向键走位、`Enter` 执行、弹出位置超出视口时夹回/翻转、关闭后焦点还给打开它的那个元素。
 * 每多一个模块就复制一份这些行为，迟早有一个模块漏了"点外面关"或者把焦点丢到 body 上。
 * 所以判据只有这一份：调用方给**项目清单**与**屏幕坐标**，剩下的全在这里。
 *
 * ## 位置：先按光标放，再夹回视口
 *
 * `position: fixed` + 光标的 `clientX/clientY` 就是"跟着鼠标弹出来"。但窗口右下角右键时，
 * 菜单会有一半在窗口外 —— 用户只能看见前几项，还以为菜单坏了。所以挂载后量一次自己的尺寸，
 * 把位置夹进视口（`padding` 留一点余量）。量不到尺寸时（jsdom 里一律是 0）**原样保留**：
 * 那里没有真实布局，"夹到 0"反而会把菜单固定到左上角，断言与实际都失真。
 *
 * ## 焦点
 *
 * 打开时焦点进入菜单的第一项（键盘用户因此能立刻用 `↑↓` 走位），关闭时还给**打开它的那个
 * 元素**（`document.activeElement` 快照）。不还焦点的话，键盘用户按一次右键再关掉，
 * 焦点就掉到 `body` 上，接下来要 Tab 一长串才能回到原来那一行。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import './context-menu.css'

/** 菜单项。`onSelect` 在**菜单关闭之前**执行，因此调用方可以直接在里面 focus 别的东西。 */
export interface ContextMenuItem {
  /** 稳定 id（测试与排障用；同一个菜单里不能重复）。 */
  id: string
  label: string
  onSelect: () => void
  /** 置灰：不响应点击、也**不进**键盘走位（走位要能停下来的才叫可选项）。 */
  disabled?: boolean
  /** 危险动作（删除等）：用主题的危险色标出来。 */
  danger?: boolean
  /** 在这一项**之前**画一条分隔线（把"分组"表达在视觉上）。 */
  separatorBefore?: boolean
}

export interface ContextMenuProps {
  items: readonly ContextMenuItem[]
  /** 屏幕坐标（`clientX/clientY`）：菜单以它为左上角弹出。 */
  x: number
  y: number
  /** 关闭请求（`Esc`、点外面、点了一项、窗口尺寸变化）。 */
  onClose: () => void
  /** 无障碍名（例如「文件 项目/设计.md 的操作菜单」）。 */
  ariaLabel?: string
}

/** 夹回视口时四周留的余量（与圆角/阴影的观感匹配）。 */
const VIEWPORT_PADDING = 8

export function ContextMenu({ items, x, y, onClose, ariaLabel = '操作菜单' }: ContextMenuProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState({ x, y })
  /**
   * 焦点归属：打开它的那个元素。
   *
   * 在**首次渲染时**捕获（`useRef` 的惰性初始化），而不是在 effect 里读 —— effect 跑之前
   * 我们已经把焦点移进菜单了，那时读到的会是菜单自己。
   */
  const restoreFocusRef = useRef<HTMLElement | null>(
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  )

  // 打开即把焦点移进菜单里的第一项（下面 `tabIndex` 的分配保证 Tab 键在菜单内循环）
  useEffect(() => {
    const root = rootRef.current
    if (root === null) return
    const first = root.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')
    ;(first ?? root).focus()
  }, [])

  // 关闭时把焦点还给打开它的元素（元素已经不在文档里时不动焦点：那会把焦点丢到 body）
  useEffect(() => {
    return () => {
      const previous = restoreFocusRef.current
      restoreFocusRef.current = null
      if (previous !== null && previous.isConnected) previous.focus()
    }
  }, [])

  // 量一次自己的尺寸，把位置夹回视口（理由见文件头）
  useLayoutEffect(() => {
    const root = rootRef.current
    if (root === null) return
    const rect = root.getBoundingClientRect()
    if (!Number.isFinite(rect.width) || rect.width <= 0 || rect.height <= 0) return
    const maxX = Math.max(VIEWPORT_PADDING, window.innerWidth - rect.width - VIEWPORT_PADDING)
    const maxY = Math.max(VIEWPORT_PADDING, window.innerHeight - rect.height - VIEWPORT_PADDING)
    setPosition({
      x: Math.min(Math.max(VIEWPORT_PADDING, x), maxX),
      y: Math.min(Math.max(VIEWPORT_PADDING, y), maxY),
    })
  }, [x, y])

  // 点菜单外面 / 在别处再右键：关闭（捕获阶段监听，免得被模块自己的 handler 吞掉）
  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      const root = rootRef.current
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    const onResize = (): void => onClose()
    document.addEventListener('mousedown', onPointerDown, true)
    document.addEventListener('contextmenu', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      document.removeEventListener('contextmenu', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onResize)
    }
  }, [onClose])

  const moveFocus = useCallback((delta: number | 'first' | 'last') => {
    const root = rootRef.current
    if (root === null) return
    const nodes = Array.from(
      root.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])'),
    )
    if (nodes.length === 0) return
    const current = nodes.indexOf(document.activeElement as HTMLElement)
    let next: number
    if (delta === 'first') next = 0
    else if (delta === 'last') next = nodes.length - 1
    else if (current < 0) next = delta > 0 ? 0 : nodes.length - 1
    else next = (current + delta + nodes.length) % nodes.length
    nodes[next]?.focus()
  }, [])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        moveFocus(1)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        moveFocus(-1)
        return
      }
      if (event.key === 'Home') {
        event.preventDefault()
        moveFocus('first')
        return
      }
      if (event.key === 'End') {
        event.preventDefault()
        moveFocus('last')
      }
    },
    [moveFocus],
  )

  return (
    <div
      ref={rootRef}
      className="mn-context-menu"
      role="menu"
      aria-label={ariaLabel}
      tabIndex={-1}
      style={{ left: position.x, top: position.y }}
      onKeyDown={handleKeyDown}
      // 菜单自己吞掉右键：在菜单上再右键不该把它关掉又重新打开一次（会闪）
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          data-menu-item={item.id}
          className={`mn-context-menu__item${item.danger === true ? ' mn-context-menu__item--danger' : ''}${
            item.separatorBefore === true ? ' mn-context-menu__item--separated' : ''
          }`}
          aria-disabled={item.disabled === true ? 'true' : undefined}
          // `disabled` 而不是 `aria-disabled` 的 `pointer-events`：既要点不动，又要能被读屏念出来
          disabled={item.disabled === true}
          onClick={() => {
            if (item.disabled === true) return
            item.onSelect()
            onClose()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
