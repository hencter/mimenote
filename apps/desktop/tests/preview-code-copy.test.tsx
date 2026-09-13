// @vitest-environment jsdom
/**
 * 阅读视图代码块的"复制"按钮（含语言标签与"渲染完再挂"的可逆性）。
 *
 * 为什么要单测这段 DOM 操作：它挂在 React 拥有的 `dangerouslySetInnerHTML` 子树里 ——
 * 一旦"每次渲染都多挂一个按钮"或"卸载后按钮留在页面上"，就说明可逆性被破坏了；
 * 这两件事在界面上表现为"按钮越点越多 / 幽灵按钮点了没反应"，很难靠肉眼定位。
 * 剪贴板走 `domain/clipboard.ts`（`navigator.clipboard` + `execCommand` 兜底），
 * 因此这里可以用桩精确控制成功与失败两条路。
 */

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { openNote } from '@/app/actions'
import { copyText } from '@/domain/clipboard'
import { CODE_COPY_CLASS, CODE_COPY_FEEDBACK_MS } from '@/features/preview/code-copy'
import { MarkdownPreview } from '@/features/preview/MarkdownPreview'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { useVaultStore } from '@/state/vault-store'

const NOTES = [
  {
    relPath: '笔记/代码.md',
    text: ['# 代码', '', '```ts', 'const a = 1', 'const b = 2', '```', '', '行内 `code` 不算代码块', ''].join(
      '\n',
    ),
  },
]

let copied: string[] = []
let clipboardOk = true

beforeEach(() => {
  copied = []
  clipboardOk = true
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        if (!clipboardOk) return Promise.reject(new Error('denied'))
        copied.push(text)
        return Promise.resolve()
      },
    },
  })

  setIpcAdapter(createMockAdapter({ notes: NOTES }))
  useNoteStore.getState().close()
  useLinksStore.getState().clear()
  useVaultStore.setState({ status: 'idle', info: null, entries: [], tree: [], selected: null })
})

afterEach(() => {
  cleanup()
})

async function renderPreview(): Promise<void> {
  render(<MarkdownPreview />)
  await act(async () => {
    await openNote('笔记/代码.md')
  })
  await waitFor(() => {
    expect(document.querySelector('.mn-preview__body pre')).not.toBeNull()
  })
}

describe('阅读视图的代码块复制', () => {
  it('每个代码块挂一个复制按钮与语言标签，行内代码不挂', async () => {
    await renderPreview()

    const buttons = document.querySelectorAll(`.${CODE_COPY_CLASS}`)
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.textContent).toBe('复制')
    expect(buttons[0]?.getAttribute('aria-label')).toContain('ts')
    // 语言标签来自围栏的 info string
    expect(document.querySelector('.mn-code-lang')?.textContent).toBe('ts')
    // 行内代码（`code`）不该有按钮
    expect(document.querySelectorAll('.mn-preview__body code').length).toBeGreaterThan(1)
  })

  it('点击复制的是代码内容（不含语言标签），并给出"已复制"反馈后复原', async () => {
    await renderPreview()
    // 只在"等反馈消失"这一段用假定时器：渲染与 waitFor 需要真实定时器
    vi.useFakeTimers()
    try {
      const button = document.querySelector<HTMLButtonElement>(`.${CODE_COPY_CLASS}`)
      expect(button).not.toBeNull()

      await act(async () => {
        fireEvent.click(button as HTMLButtonElement)
        await Promise.resolve()
      })

      expect(copied).toEqual(['const a = 1\nconst b = 2'])
      expect(button?.textContent).toBe('已复制')

      await act(async () => {
        vi.advanceTimersByTime(CODE_COPY_FEEDBACK_MS + 10)
      })
      expect(button?.textContent).toBe('复制')
    } finally {
      vi.useRealTimers()
    }
  })

  it('剪贴板不可用时按钮显示"复制失败"而不是假装成功', async () => {
    clipboardOk = false
    await renderPreview()
    const button = document.querySelector<HTMLButtonElement>(`.${CODE_COPY_CLASS}`)

    await act(async () => {
      fireEvent.click(button as HTMLButtonElement)
      await Promise.resolve()
    })

    expect(button?.textContent).toBe('复制失败')
  })

  it('重新渲染不会叠加按钮（按钮随 DOM 重建，不留在旧节点上）', async () => {
    await renderPreview()

    // 改一次正文（触发 HTML 重建）后仍然只有一个按钮
    await act(async () => {
      useNoteStore.setState((state) =>
        state.doc === null
          ? state
          : { doc: { ...state.doc, text: `${state.doc.text}\n\n新增一行\n` } },
      )
    })

    await waitFor(() => {
      expect(document.querySelector('.mn-preview__body')?.textContent).toContain('新增一行')
    })
    expect(document.querySelectorAll(`.${CODE_COPY_CLASS}`)).toHaveLength(1)
  })

  it('复制按钮的点击不会被链接逻辑吃掉（委托分支互不干扰）', async () => {
    await renderPreview()
    const button = document.querySelector<HTMLButtonElement>(`.${CODE_COPY_CLASS}`)
    await act(async () => {
      fireEvent.click(button as HTMLButtonElement)
      await Promise.resolve()
    })
    // 没有跳转/创建笔记：剪贴板仍然是这条点击的唯一效果
    expect(copied).toHaveLength(1)
  })

  it('copyText 在空字符串上直接失败（不调用剪贴板）', async () => {
    await expect(copyText('')).resolves.toBe(false)
    expect(copied).toEqual([])
  })
})
