// @vitest-environment jsdom
/**
 * 自绘标题栏右侧的窗口按钮（`features/window/WindowControls.tsx`）。
 *
 * 为什么值得这些测试：`tauri.conf.json` 关掉了系统装饰（`decorations: false`），这条 34px 的
 * 自绘标题栏就成了**唯一**的标题栏 —— 窗口按钮是"关掉系统标题栏"的必要配套，不能点了没反应，
 * 也不能在没有窗口 API 的环境里渲染出三个死按钮。这里用假的 `@tauri-apps/api/window` 把
 * 三种状态钉住：拿不到 API、正常点击、以及**从外部（双击标题栏 / Win+↑）最大化之后图标要跟上**。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WindowControls } from '@/features/window/WindowControls'

/** 假的窗口对象：把三个动作记下来，并允许测试随时改变"是否最大化"。 */
interface FakeWindow {
  minimize: ReturnType<typeof vi.fn>
  toggleMaximize: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  isMaximized: ReturnType<typeof vi.fn>
  onResized: ReturnType<typeof vi.fn>
  /** 让"窗口从外部被最大化"发生：调用注册过的 resize 回调。 */
  emitResized: () => void
}

let fake: FakeWindow
let maximizeState = false
let resizeHandlers: Array<() => void> = []
let windowApiThrows = false

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => {
    if (windowApiThrows) throw new Error('no __TAURI_INTERNALS__')
    return fake
  },
}))

beforeEach(() => {
  maximizeState = false
  resizeHandlers = []
  windowApiThrows = false
  fake = {
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {
      maximizeState = !maximizeState
    }),
    close: vi.fn(async () => {}),
    isMaximized: vi.fn(async () => maximizeState),
    onResized: vi.fn(async (handler: () => void) => {
      resizeHandlers.push(handler)
      return () => {
        resizeHandlers = resizeHandlers.filter((item) => item !== handler)
      }
    }),
    emitResized: () => {
      for (const handler of resizeHandlers) handler()
    },
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('窗口按钮', () => {
  it('没有窗口 API 时整组不渲染（浏览器预览里不该出现点了没反应的按钮）', async () => {
    windowApiThrows = true
    const { container } = render(<WindowControls />)
    // 探测是异步的：等一拍，确认它没有被渲染出来
    await waitFor(() => expect(container.querySelector('.mn-window-controls')).toBeNull())
    expect(screen.queryByLabelText('关闭窗口')).toBeNull()
  })

  it('有窗口 API 时给出三个按钮，且都可访问（aria-label + title）', async () => {
    render(<WindowControls />)
    const minimize = await screen.findByLabelText('最小化')
    expect(minimize).toBeTruthy()
    expect(screen.getByLabelText('最大化')).toBeTruthy()
    expect(screen.getByLabelText('关闭窗口')).toBeTruthy()
    expect(minimize.getAttribute('title')).toBe('最小化')
  })

  it('点击最小化 / 关闭分别调用窗口的最小化与关闭', async () => {
    render(<WindowControls />)

    // 动作是异步的（动态 import + IPC）：`waitFor` 等它落地，而不是断言"点完立刻调用"
    fireEvent.click(await screen.findByLabelText('最小化'))
    await waitFor(() => expect(fake.minimize).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByLabelText('关闭窗口'))
    await waitFor(() => expect(fake.close).toHaveBeenCalledTimes(1))
  })

  it('点最大化会切换状态，按钮随之变成「还原」（aria-pressed 同步）', async () => {
    render(<WindowControls />)

    fireEvent.click(await screen.findByLabelText('最大化'))
    await waitFor(() => expect(fake.toggleMaximize).toHaveBeenCalledTimes(1))

    const restore = await screen.findByLabelText('还原')
    expect(restore.getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByLabelText('最大化')).toBeNull()
  })

  it('窗口从外部被最大化（双击标题栏 / Win+↑）之后，图标要跟上', async () => {
    render(<WindowControls />)
    await screen.findByLabelText('最大化')

    // 模拟"用户双击标题栏"：Tauri 直接改了窗口状态，只通过 resize 事件让我们知道
    maximizeState = true
    fake.emitResized()

    expect(await screen.findByLabelText('还原')).toBeTruthy()

    // 再还原一次，图标转回「最大化」
    maximizeState = false
    fake.emitResized()
    expect(await screen.findByLabelText('最大化')).toBeTruthy()
  })
})
