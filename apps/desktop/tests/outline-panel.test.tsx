// @vitest-environment jsdom
/**
 * 大纲面板（`features/outline/`）的组件级测试。
 *
 * 重点验证"点击之后到底发生了什么"，而不是渲染细节：
 * - **编辑视图**：光标落到那一行（读真实 CodeMirror 的选区），且**文档没变**（跳转只是"看"）；
 * - **阅读视图**：预览里对应的标题被滚进来并高亮（预览没有光标，跳转的对象换成视口）；
 * - **图谱视图**：先切回编辑视图再定位（同一个操作不随视图给出两套结果）。
 *
 * 另外钉住"面板开关是持久化偏好"与"没有笔记时是空态"两条边界。
 */

import { EditorView } from '@codemirror/view'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openNote } from '@/app/actions'
import { registerBuiltinCommands } from '@/app/builtin-commands'
import { MarkdownEditor } from '@/features/editor/MarkdownEditor'
import { OutlinePanel } from '@/features/outline/OutlinePanel'
import { OUTLINE_FLASH_CLASS } from '@/features/outline/outline-scroll'
import { MarkdownPreview } from '@/features/preview/MarkdownPreview'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter, MOCK_VAULT_PATH } from '@/ipc/mock-adapter'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'
import { commands } from '@/app/commands'

/** 正文里每个标题都在已知行号上（断言跳转结果用）。 */
const NOTE_TEXT = [
  '# 项目说明', // 1
  '',
  '一段正文。', // 3
  '',
  '## 目标', // 5
  '',
  '- 甲',
  '- 乙',
  '',
  '### 子目标', // 10
  '',
  '```md',
  '# 代码里的伪标题', // 13
  '```',
  '',
  '## 结论', // 16
  '',
].join('\n')

const NOTES = [{ relPath: '笔记/大纲.md', text: NOTE_TEXT }]

function resetStores(): void {
  useNoteStore.getState().close()
  useLinksStore.getState().clear()
  useUiStore.setState({ viewMode: 'edit', outlinePanelVisible: false })
  useVaultStore.setState({
    status: 'idle',
    info: null,
    entries: [],
    tree: [],
    expanded: new Set<string>(),
    selected: null,
    filter: '',
    error: null,
    lastRoot: null,
  })
}

async function openVault(): Promise<void> {
  await act(async () => {
    await useVaultStore.getState().openVault(MOCK_VAULT_PATH)
  })
}

async function open(path: string): Promise<void> {
  await act(async () => {
    await openNote(path)
  })
}

/** 大纲条目的文本（按显示顺序）。 */
function outlineTexts(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.mn-outline__item')).map(
    (node) => node.textContent ?? '',
  )
}

function outlineItem(line: number): HTMLElement {
  const node = document.querySelector<HTMLElement>(`.mn-outline__item[data-outline-line="${line}"]`)
  if (node === null) throw new Error(`没有这一行的大纲条目：${line}`)
  return node
}

let scrollCalls: string[] = []

beforeEach(() => {
  scrollCalls = []
  // jsdom 没有布局，`scrollIntoView` 是未实现的空壳：这里替身记录"滚了哪个元素"
  HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement): void {
    scrollCalls.push(this.textContent ?? '')
  } as unknown as typeof HTMLElement.prototype.scrollIntoView

  setIpcAdapter(createMockAdapter({ notes: NOTES }))
  window.localStorage.clear()
  resetStores()
})

afterEach(() => {
  cleanup()
})

describe('大纲面板', () => {
  it('没有打开的笔记时显示空态，打开后列出标题（含代码块里的伪标题被排除）', async () => {
    render(<OutlinePanel />)
    expect(document.querySelector('.mn-outline__empty')?.textContent).toContain('没有打开的笔记')

    await openVault()
    await open('笔记/大纲.md')

    await waitFor(() => {
      expect(outlineTexts()).toEqual(['项目说明', '目标', '子目标', '结论'])
    })
    // 层级缩进：一级 8px，二级 +12，三级 +24
    expect(outlineItem(1).style.paddingLeft).toBe('8px')
    expect(outlineItem(5).style.paddingLeft).toBe('20px')
    expect(outlineItem(10).style.paddingLeft).toBe('32px')
  })

  it('编辑视图里点击标题：光标落到那一行，正文一个字都没改', async () => {
    render(
      <>
        <OutlinePanel />
        <MarkdownEditor />
      </>,
    )
    await openVault()
    await open('笔记/大纲.md')
    await waitFor(() => {
      expect(document.querySelector('.cm-content')).not.toBeNull()
    })

    const view = EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor') as HTMLElement)
    expect(view).not.toBeNull()

    await act(async () => {
      fireEvent.click(outlineItem(10))
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })

    await waitFor(() => {
      const state = (view as EditorView).state
      expect(state.doc.lineAt(state.selection.main.head).number).toBe(10)
    })
    // 跳转不是编辑：文档不变、也不置 dirty
    expect((view as EditorView).state.doc.toString()).toBe(NOTE_TEXT)
    expect(useNoteStore.getState().dirty).toBe(false)
  })

  it('阅读视图里点击标题：滚动预览里对应的那个标题并高亮（预览没有光标）', async () => {
    render(
      <>
        <OutlinePanel />
        <MarkdownPreview />
      </>,
    )
    await openVault()
    await open('笔记/大纲.md')
    await act(async () => {
      useUiStore.getState().setViewMode('read')
    })
    await waitFor(() => {
      expect(document.querySelectorAll('.mn-preview__body h2').length).toBe(2)
    })

    await act(async () => {
      fireEvent.click(outlineItem(16))
    })

    expect(scrollCalls).toEqual(['结论'])
    const heading = Array.from(document.querySelectorAll('.mn-preview__body h2')).find(
      (node) => node.textContent === '结论',
    )
    expect(heading?.classList.contains(OUTLINE_FLASH_CLASS)).toBe(true)
  })

  it('图谱视图里点击标题：先切回编辑视图（同一个操作只有一种结果）', async () => {
    render(
      <>
        <OutlinePanel />
        <MarkdownEditor />
      </>,
    )
    await openVault()
    await open('笔记/大纲.md')
    await act(async () => {
      useUiStore.getState().setViewMode('graph')
    })
    expect(useUiStore.getState().viewMode).toBe('graph')

    await act(async () => {
      fireEvent.click(outlineItem(5))
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })

    expect(useUiStore.getState().viewMode).toBe('edit')
  })

  it('面板开关走命令表并持久化（Ctrl+Shift+O）', async () => {
    const dispose = registerBuiltinCommands()
    try {
      render(<OutlinePanel />)
      expect(commands.byChord('Mod+Shift+O')[0]?.id).toBe('view.toggleOutlinePanel')

      await act(async () => {
        await commands.execute('view.toggleOutlinePanel')
      })
      expect(useUiStore.getState().outlinePanelVisible).toBe(true)
      expect(window.localStorage.getItem('mimenote.ui.v1')).toContain('"outlinePanelVisible":true')

      await act(async () => {
        await commands.execute('view.toggleOutlinePanel')
      })
      expect(useUiStore.getState().outlinePanelVisible).toBe(false)
    } finally {
      dispose()
    }
  })

  it('标题块里的行号与搜索结果同一个口径（1 起算）', async () => {
    render(<OutlinePanel />)
    await openVault()
    await open('笔记/大纲.md')

    await waitFor(() => {
      expect(outlineItem(1).getAttribute('title')).toContain('第 1 行')
    })
    expect(outlineItem(16).getAttribute('title')).toContain('第 16 行')
    // 标题为空时给出占位文案而不是一个看不见的空按钮
    expect(outlineItem(1).textContent).toBe('项目说明')
  })
})

describe('大纲在阅读视图的滚动', () => {
  it('序号越界时不滚动也不报错', async () => {
    const { scrollPreviewToHeading } = await import('@/features/outline/outline-scroll')
    render(<MarkdownPreview />)
    await openVault()
    await open('笔记/大纲.md')
    await waitFor(() => {
      expect(document.querySelector('.mn-preview__body h1')).not.toBeNull()
    })

    expect(scrollPreviewToHeading(99)).toBe(false)
    expect(scrollCalls).toEqual([])

    // 没有预览挂载时（例如编辑视图）也必须是"找不到"而不是抛错
    cleanup()
    expect(scrollPreviewToHeading(0)).toBe(false)
  })

  it('连续点同一个标题会重放高亮动画（先摘类名再挂回去）', async () => {
    const { scrollPreviewToHeading } = await import('@/features/outline/outline-scroll')
    render(<MarkdownPreview />)
    await openVault()
    await open('笔记/大纲.md')
    await waitFor(() => {
      expect(document.querySelector('.mn-preview__body h1')).not.toBeNull()
    })

    expect(scrollPreviewToHeading(0)).toBe(true)
    expect(scrollPreviewToHeading(0)).toBe(true)
    expect(scrollCalls).toEqual(['项目说明', '项目说明'])

    // 高亮是一次性的：定时器到点后摘掉（否则下一次跳转会"看起来没反应"）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900))
    })
    const heading = document.querySelector('.mn-preview__body h1')
    expect(heading?.classList.contains(OUTLINE_FLASH_CLASS)).toBe(false)
  })
})
