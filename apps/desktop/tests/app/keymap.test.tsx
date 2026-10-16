// @vitest-environment jsdom
/**
 * 全局快捷键分发（`app/keymap.ts`）的回归测试。
 *
 * 为什么单独有这一层：快捷键装在 window 的哪个阶段（捕捉 / 冒泡）决定了
 * "注册过的组合键能不能赢过编辑器自己的绑定"。CodeMirror 把 `Mod+G` 绑成了
 * 「查找下一个」、`Mod+K` 绑成了「删到行尾」，并且会 `preventDefault()`；
 * 冒泡阶段的全局监听收到事件时已经被吃掉，于是"在编辑器里按 Ctrl+G 打不开图谱，
 * 反而跳到了下一个匹配"—— 这是真实撞到过的缺陷（应用层 E2E 抓到的），
 * 所以这里用"模拟编辑器先吃掉事件"的方式把它钉住。
 *
 * 同时钉住三条不能破的边界：输入框里不抢键、模态层里不抢键、未注册的组合键
 * 原样放行（否则编辑器/浏览器的默认行为会被全局监听顺手破坏）。
 */

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PALETTE_COMMAND_IDS } from '@/app/builtin-commands'
import { commands, type Disposer } from '@/app/commands'
import { useGlobalKeymap } from '@/app/keymap'

/** 记录命令是否被执行（命令本身只做这一件事，避免断言落到实现细节上）。 */
let fired: string[] = []
let disposers: Disposer[] = []

/** 装上全局快捷键的宿主：编辑器（contenteditable）/ 输入框 / 模态层各一个。 */
function Harness() {
  useGlobalKeymap()
  return (
    <div>
      <div className="cm-content" contentEditable data-testid="editor" />
      <input data-testid="input" />
      <div role="dialog" tabIndex={-1} data-testid="dialog">
        <button type="button">对话框里的按钮</button>
      </div>
    </div>
  )
}

/** 模拟 CodeMirror：在元素自身的 keydown 里把事件标记为"已处理"。 */
function installSwallowingEditor(element: HTMLElement): void {
  element.addEventListener('keydown', (event) => {
    event.preventDefault()
  })
}

beforeEach(() => {
  fired = []
  disposers = [
    commands.register({
      id: 'test.graphLike',
      title: '测试：图谱',
      category: '测试',
      keybinding: 'Mod+G',
      run: () => {
        fired.push('test.graphLike')
      },
    }),
    commands.register({
      id: 'test.plain',
      title: '测试：无修饰键组合',
      category: '测试',
      keybinding: 'Mod+Alt+Z',
      run: () => {
        fired.push('test.plain')
      },
    }),
  ]
})

afterEach(() => {
  cleanup()
  for (const dispose of disposers) dispose()
  disposers = []
})

describe('全局快捷键分发', () => {
  it('编辑器先 preventDefault 的事件，注册过的组合键仍然会执行（捕捉阶段赢过编辑器）', () => {
    const view = render(<Harness />)
    const editor = view.getByTestId('editor')
    installSwallowingEditor(editor)

    // 真实 CodeMirror 会把事件吃掉；这里前置一个监听模拟同样的行为
    const swallowed = fireEvent.keyDown(editor, { key: 'g', ctrlKey: true })

    expect(fired).toEqual(['test.graphLike'])
    // 事件必须是"被吃掉"的：否则编辑器会同时执行它自己的绑定（例如查找下一个）
    expect(swallowed).toBe(false)
  })

  it('未注册的组合键原样放行，不 preventDefault（编辑器/浏览器默认行为不受影响）', () => {
    const view = render(<Harness />)
    const editor = view.getByTestId('editor')

    const notPrevented = fireEvent.keyDown(editor, { key: 'x', ctrlKey: true })

    expect(fired).toEqual([])
    expect(notPrevented).toBe(true)
  })

  it('输入框里打字不触发命令（用户正常输入优先）', () => {
    const view = render(<Harness />)
    const input = view.getByTestId('input')

    const notPrevented = fireEvent.keyDown(input, { key: 'g', ctrlKey: true })

    expect(fired).toEqual([])
    expect(notPrevented).toBe(true)
  })

  it('焦点在模态层里时不抢键（一次 Esc 只该关掉一层）', () => {
    const view = render(<Harness />)
    const dialog = view.getByTestId('dialog')

    const notPrevented = fireEvent.keyDown(dialog, { key: 'g', ctrlKey: true })

    expect(fired).toEqual([])
    expect(notPrevented).toBe(true)
  })

  it('面板的三个键位由面板监听独占，全局层不重复执行', () => {
    // 面板命令在别的用例里由 registerBuiltinCommands 注册；这里只补一条占位实现，
    // 断言的是"全局分发器不碰它"，与面板本身怎么实现无关
    const dispose = commands.has(PALETTE_COMMAND_IDS.open)
      ? null
      : commands.register({
          id: PALETTE_COMMAND_IDS.open,
          title: '测试：命令面板',
          category: '测试',
          keybinding: 'Mod+K',
          run: () => {
            fired.push('palette.open')
          },
        })

    try {
      const view = render(<Harness />)
      fireEvent.keyDown(view.getByTestId('editor'), { key: 'k', ctrlKey: true })
      expect(fired).toEqual([])
    } finally {
      dispose?.()
    }
  })

  it('不响应 when 为 false 的命令（置灰的命令不该被快捷键绕过）', () => {
    const dispose = commands.register({
      id: 'test.disabled',
      title: '测试：条件不满足',
      category: '测试',
      keybinding: 'Mod+Alt+Q',
      when: () => false,
      run: () => {
        fired.push('test.disabled')
      },
    })

    try {
      const view = render(<Harness />)
      const notPrevented = fireEvent.keyDown(view.getByTestId('editor'), {
        key: 'q',
        ctrlKey: true,
        altKey: true,
      })
      expect(fired).toEqual([])
      // 没有可执行的命令时也要放行：否则"按了没反应"会连累编辑器自己的键位
      expect(notPrevented).toBe(true)
    } finally {
      dispose()
    }
  })
})
