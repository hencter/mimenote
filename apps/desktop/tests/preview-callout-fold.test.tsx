// @vitest-environment jsdom
/**
 * 阅读视图 callout 的手动折叠（点标题收起/展开，键盘 Enter/Space 同理）。
 *
 * 编辑器里折叠是真的（`[!note]-` 进装饰）；阅读视图的 HTML 是静态的，
 * 这里的折叠只是呈现层的 `data-mn-collapsed`（与灯箱的 `data-mn-clipped` 同一手法）：
 * 丢了也只是全展开，内容一个字不少 —— 导出件与静态站点没有这段 JS，那里永远全展开。
 */

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openNote } from '@/app/actions'
import { MarkdownPreview } from '@/features/preview/MarkdownPreview'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { useVaultStore } from '@/state/vault-store'

const NOTES = [
  {
    relPath: '笔记/提示框.md',
    text: ['# 提示', '', '> [!warning] 小心', '> 第一段正文', '> 第二段正文', ''].join('\n'),
  },
]

beforeEach(() => {
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
    await openNote('笔记/提示框.md')
  })
  await waitFor(() => {
    expect(document.querySelector('.mn-callout__title')).not.toBeNull()
  })
}

describe('阅读视图的 callout 折叠', () => {
  it('标题有按钮语义：role/tabindex/aria-expanded', async () => {
    await renderPreview()
    const title = document.querySelector('.mn-callout__title') as HTMLElement
    expect(title.getAttribute('role')).toBe('button')
    expect(title.getAttribute('tabindex')).toBe('0')
    expect(title.getAttribute('aria-expanded')).toBe('true')
  })

  it('点标题收起正文，再点展开（内容一个字不少）', async () => {
    await renderPreview()
    const callout = document.querySelector('.mn-callout') as HTMLElement
    const title = document.querySelector('.mn-callout__title') as HTMLElement
    const body = callout.querySelector('p') as HTMLElement
    expect(body.textContent).toContain('第一段正文')

    fireEvent.click(title)
    expect(callout.hasAttribute('data-mn-collapsed')).toBe(true)
    expect(title.getAttribute('aria-expanded')).toBe('false')
    // jsdom 不算外联样式表：用 matches 断言"隐藏选择器命中了正文"
    // （`.mn-callout[data-mn-collapsed] > :not(.mn-callout__title)`，见 app.css）
    expect(body.matches('.mn-callout[data-mn-collapsed] > :not(.mn-callout__title)')).toBe(true)

    fireEvent.click(title)
    expect(callout.hasAttribute('data-mn-collapsed')).toBe(false)
    expect(title.getAttribute('aria-expanded')).toBe('true')
    expect(body.textContent).toContain('第一段正文')
  })

  it('键盘 Enter/Space 也能折叠（空格不滚屏）', async () => {
    await renderPreview()
    const title = document.querySelector('.mn-callout__title') as HTMLElement

    fireEvent.keyDown(title, { key: 'Enter' })
    expect(document.querySelector('.mn-callout')?.hasAttribute('data-mn-collapsed')).toBe(true)

    fireEvent.keyDown(title, { key: ' ' })
    expect(document.querySelector('.mn-callout')?.hasAttribute('data-mn-collapsed')).toBe(false)
  })

  it('点正文不折叠（只有标题是开关）', async () => {
    await renderPreview()
    const body = document.querySelector('.mn-callout p') as HTMLElement
    fireEvent.click(body)
    expect(document.querySelector('.mn-callout')?.hasAttribute('data-mn-collapsed')).toBe(false)
  })
})
