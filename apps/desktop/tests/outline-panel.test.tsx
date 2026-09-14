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
import { OutlinePanel, currentHeadingIndex } from '@/features/outline/OutlinePanel'
import { OUTLINE_FLASH_CLASS } from '@/features/outline/outline-scroll'
import { MarkdownPreview } from '@/features/preview/MarkdownPreview'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter, MOCK_VAULT_PATH } from '@/ipc/mock-adapter'
import { useCursorStore } from '@/state/cursor-store'
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

  it('当前章节高亮：光标所在行及以上最近的那个标题被标出来（含 aria-current）', async () => {
    render(<OutlinePanel />)
    await openVault()
    await open('笔记/大纲.md')

    await waitFor(() => {
      expect(outlineTexts()).toHaveLength(4)
    })

    // 纯函数：行号 → 当前章节下标（`<=` 语义：光标落在正文里时仍属于上面那一节）
    const headings = [
      { level: 1, text: '一', line: 1 },
      { level: 2, text: '二', line: 5 },
      { level: 2, text: '三', line: 10 },
    ]
    expect(currentHeadingIndex(headings, null)).toBe(-1)
    expect(currentHeadingIndex(headings, 1)).toBe(0)
    expect(currentHeadingIndex(headings, 4)).toBe(0)
    expect(currentHeadingIndex(headings, 5)).toBe(1)
    expect(currentHeadingIndex(headings, 9)).toBe(1)
    expect(currentHeadingIndex(headings, 999)).toBe(2)

    // 契约：光标在第 10 行 → 「子目标」是当前章节
    await act(async () => {
      useCursorStore.getState().setLine(10)
    })
    await waitFor(() => {
      const current = document.querySelectorAll('.mn-outline__item--current')
      expect(current).toHaveLength(1)
      expect(current[0]?.getAttribute('data-outline-line')).toBe('10')
      expect(current[0]?.getAttribute('aria-current')).toBe('location')
    })

    // 光标移进正文（第 12 行）仍属于第 10 行那一节
    await act(async () => {
      useCursorStore.getState().setLine(12)
    })
    await waitFor(() => {
      expect(document.querySelector('.mn-outline__item--current')?.getAttribute('data-outline-line')).toBe(
        '10',
      )
    })

    // 光标回到开头：高亮切到第一个标题
    await act(async () => {
      useCursorStore.getState().setLine(1)
    })
    await waitFor(() => {
      expect(document.querySelector('.mn-outline__item--current')?.getAttribute('data-outline-line')).toBe(
        '1',
      )
    })

    // 阅读视图**没有挂预览**时不高亮：那时"读到哪一节"没有任何依据（不猜）
    await act(async () => {
      useUiStore.getState().setViewMode('read')
    })
    await waitFor(() => {
      expect(document.querySelectorAll('.mn-outline__item--current')).toHaveLength(0)
    })
  })

  it('编辑器把光标行写进 store（真编辑器里移动光标 → 大纲跟着变）', async () => {
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

    const view = EditorView.findFromDOM(
      document.querySelector<HTMLElement>('.cm-editor') as HTMLElement,
    ) as EditorView

    // 把光标放到「子目标」那一行（第 10 行）
    await act(async () => {
      view.dispatch({ selection: { anchor: view.state.doc.line(10).from } })
    })
    await waitFor(() => {
      expect(useCursorStore.getState().line).toBe(10)
      expect(document.querySelector('.mn-outline__item--current')?.getAttribute('data-outline-line')).toBe(
        '10',
      )
    })

    // 同一行里左右移动不该重复写入（节流：只有行号变化才回调）
    await act(async () => {
      const from = view.state.doc.line(10).from
      view.dispatch({ selection: { anchor: from + 1 } })
    })
    expect(useCursorStore.getState().line).toBe(10)
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

  it('按滚动位置判定"当前读到哪一节"：视口顶部最后一个标题（没有布局就返回 -1）', async () => {
    const { visibleHeadingOrdinal } = await import('@/features/outline/outline-scroll')

    // jsdom 不做布局：手工给出每个标题相对容器顶边的位置
    const container = document.createElement('div')
    const body = document.createElement('div')
    body.className = 'mn-preview__body'
    const stubRect = (element: Element, top: number): void => {
      Object.defineProperty(element, 'getBoundingClientRect', {
        value: () => ({ top }) as DOMRect,
        // 可重定义：同一条用例里会改同一个元素的 top 来模拟滚动
        configurable: true,
      })
    }
    for (const top of [120, 320, 560]) {
      const heading = document.createElement('h2')
      stubRect(heading, top)
      body.appendChild(heading)
    }
    container.appendChild(body)
    stubRect(container, 100)

    // 还没滚到第一个标题（120 > 100 + 8）
    expect(visibleHeadingOrdinal(container)).toBe(-1)
    // 第一个标题刚贴到顶边（≈ 容器顶边 + 余量）→ 算作"进入这一节"
    const first = body.querySelector('h2') as HTMLElement
    stubRect(first, 104)
    expect(visibleHeadingOrdinal(container)).toBe(0)
    // 滚过第二个标题 → 第 1 号（0 起算）是当前章节
    const second = body.querySelectorAll('h2')[1] as HTMLElement
    stubRect(second, 90)
    expect(visibleHeadingOrdinal(container)).toBe(1)

    expect(visibleHeadingOrdinal(null)).toBe(-1)
  })

  it('阅读视图里滚动预览：大纲的高亮跟着走（并且没有预览时不猜）', async () => {
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

    // jsdom 不做布局：给滚动容器与四个标题手工安排位置
    const scroller = document.querySelector<HTMLElement>('.mn-preview__scroller')
    expect(scroller).not.toBeNull()
    Object.defineProperty(scroller as HTMLElement, 'getBoundingClientRect', {
      value: () => ({ top: 0 }) as DOMRect,
    })
    const headings = Array.from(document.querySelectorAll<HTMLElement>('.mn-preview__body h1, .mn-preview__body h2, .mn-preview__body h3'))
    headings.forEach((heading, index) => {
      // 第 3 个标题（`### 小节`，data-outline-line=10）已经滚过顶边，其余还在下面
      const top = index <= 2 ? -20 + index * 10 : 300
      Object.defineProperty(heading, 'getBoundingClientRect', { value: () => ({ top }) as DOMRect })
    })

    await act(async () => {
      scroller?.dispatchEvent(new Event('scroll'))
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })

    await waitFor(() => {
      const current = document.querySelector('.mn-outline__item--current')
      expect(current?.getAttribute('data-outline-line')).toBe('10')
    })
  })
})

/**
 * 「按级别过滤」与「章节折叠」（规则在 `features/outline/outline-view.ts`，接线在本组件）。
 *
 * 这一层要守住的是**坐标**：过滤与折叠只决定"渲染哪几条"，高亮与跳转仍然按完整标题列表
 * 的下标走 —— 否则"当前章节"会悄悄跳到相邻的条目上（这类错误在纯函数测试里看不出来，
 * 只有把真实光标放进去才会现形）。
 *
 * 键盘可操作性这里只验证**语义**（原生按钮 + 可读名称 + 不嵌套在条目按钮里）：
 * Enter/Space 触发按钮是浏览器的默认行为，jsdom 不模拟它，真按键由 UI 层 E2E 复核。
 */
describe('大纲面板：级别过滤与章节折叠', () => {
  /**
   * 级别过滤按 Vault 根存在 ui-store 里（模块级、跨用例共享），
   * 每个用例都必须从"没过滤过"开始 —— 外层 beforeEach 只重置视图与面板开关。
   */
  beforeEach(() => {
    useUiStore.setState({ outlineLevelsByVault: {} })
  })

  /** H1…H6 的级别开关。 */
  function levelButton(level: number): HTMLElement {
    const node = document.querySelector<HTMLElement>(
      `.mn-outline__level[data-outline-level="${level}"]`,
    )
    if (node === null) throw new Error(`没有 H${level} 的过滤开关`)
    return node
  }

  /** 某一行条目的折叠三角（没有可见子标题的条目不会渲染它）。 */
  function collapseToggle(line: number): HTMLElement {
    const node = document.querySelector<HTMLElement>(`[data-outline-collapse="${line}"]`)
    if (node === null) throw new Error(`第 ${line} 行没有折叠三角`)
    return node
  }

  async function openOutline(): Promise<void> {
    await openVault()
    await open('笔记/大纲.md')
    await waitFor(() => {
      expect(outlineTexts()).toEqual(['项目说明', '目标', '子目标', '结论'])
    })
  }

  it('默认六级全亮（不过滤）：可见条目与从前的完整标题树一模一样', async () => {
    render(<OutlinePanel />)
    await openOutline()

    for (const level of [1, 2, 3, 4, 5, 6]) {
      expect(levelButton(level).getAttribute('aria-pressed')).toBe('true')
    }
    expect(document.querySelector('.mn-outline__count')?.textContent).toBe('4')
    // 默认不过滤 = 每条都带缩进、都在原位置（"不改变现有用户的观感"）
    expect(outlineItem(5).style.paddingLeft).toBe('20px')

    await act(async () => {
      fireEvent.click(levelButton(2))
    })
    await waitFor(() => {
      expect(outlineTexts()).toEqual(['项目说明', '子目标'])
    })
    expect(levelButton(2).getAttribute('aria-pressed')).toBe('false')
    // 计数补上分母：用户要知道"还有几条没显示"
    expect(document.querySelector('.mn-outline__count')?.textContent).toBe('2/4')

    await act(async () => {
      fireEvent.click(levelButton(2))
    })
    await waitFor(() => {
      expect(outlineTexts()).toHaveLength(4)
    })
    expect(document.querySelector('.mn-outline__count')?.textContent).toBe('4')
  })

  it('过滤选择按 Vault 根持久化，且不碰别的偏好', async () => {
    render(<OutlinePanel />)
    await openOutline()

    await act(async () => {
      fireEvent.click(levelButton(2))
    })

    expect(useUiStore.getState().outlineLevelsByVault[MOCK_VAULT_PATH]).toEqual([1, 3, 4, 5, 6])
    const raw = window.localStorage.getItem('mimenote.ui.v1') ?? '{}'
    const persisted: { outlineLevelsByVault: Record<string, number[]>; outlinePanelVisible: boolean } =
      JSON.parse(raw)
    expect(persisted.outlineLevelsByVault[MOCK_VAULT_PATH]).toEqual([1, 3, 4, 5, 6])
    // 同一个 store 里别的字段语义不变（只是多了一个字段）
    expect(persisted.outlinePanelVisible).toBe(false)
  })

  it('过滤之后高亮仍按完整列表算：不会跳到相邻的条目上', async () => {
    render(<OutlinePanel />)
    await openOutline()
    await act(async () => {
      fireEvent.click(levelButton(2))
    })
    await waitFor(() => {
      expect(outlineTexts()).toEqual(['项目说明', '子目标'])
    })

    // 光标在第 12 行（正文里）→ 当前章节是第 10 行的「子目标」= **完整列表的第 3 条**
    await act(async () => {
      useCursorStore.getState().setLine(12)
    })
    await waitFor(() => {
      const current = document.querySelectorAll('.mn-outline__item--current')
      expect(current).toHaveLength(1)
      expect(current[0]?.getAttribute('data-outline-line')).toBe('10')
    })
  })

  it('当前章节被过滤掉时：不高亮到别的条目，只如实说明它在第几行', async () => {
    render(<OutlinePanel />)
    await openOutline()
    await act(async () => {
      fireEvent.click(levelButton(2))
    })

    // 光标在第 6 行 → 当前章节是第 5 行的「目标」（H2，此刻被过滤掉）
    await act(async () => {
      useCursorStore.getState().setLine(6)
    })
    await waitFor(() => {
      expect(document.querySelectorAll('.mn-outline__item--current')).toHaveLength(0)
      expect(
        document
          .querySelector('[data-outline-hidden-current]')
          ?.getAttribute('data-outline-hidden-current'),
      ).toBe('5')
    })
    expect(document.querySelector('.mn-outline__hidden')?.textContent).toContain('第 5 行')

    // 把 H2 放回来：高亮立刻回到真正的当前章节上（方位一直没丢）
    await act(async () => {
      fireEvent.click(levelButton(2))
    })
    await waitFor(() => {
      expect(document.querySelector('.mn-outline__item--current')?.getAttribute('data-outline-line')).toBe(
        '5',
      )
    })
  })

  it('收起一条章节：子标题一起消失，三角留在原地可以再展开', async () => {
    render(<OutlinePanel />)
    await openOutline()

    await act(async () => {
      fireEvent.click(collapseToggle(5))
    })
    await waitFor(() => {
      expect(outlineTexts()).toEqual(['项目说明', '目标', '结论'])
    })
    expect(collapseToggle(5).getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('.mn-outline__count')?.textContent).toBe('3/4')

    await act(async () => {
      fireEvent.click(collapseToggle(5))
    })
    await waitFor(() => {
      expect(outlineTexts()).toEqual(['项目说明', '目标', '子目标', '结论'])
    })
    expect(collapseToggle(5).getAttribute('aria-expanded')).toBe('true')
  })

  it('当前章节被收起时也不丢方位：展开回来还是同一条', async () => {
    render(<OutlinePanel />)
    await openOutline()
    await act(async () => {
      useCursorStore.getState().setLine(12)
    })
    await waitFor(() => {
      expect(document.querySelector('.mn-outline__item--current')?.getAttribute('data-outline-line')).toBe(
        '10',
      )
    })

    await act(async () => {
      fireEvent.click(collapseToggle(5))
    })
    await waitFor(() => {
      expect(outlineTexts()).toEqual(['项目说明', '目标', '结论'])
      expect(document.querySelectorAll('.mn-outline__item--current')).toHaveLength(0)
      expect(
        document
          .querySelector('[data-outline-hidden-current]')
          ?.getAttribute('data-outline-hidden-current'),
      ).toBe('10')
    })

    await act(async () => {
      fireEvent.click(collapseToggle(5))
    })
    await waitFor(() => {
      expect(document.querySelector('.mn-outline__item--current')?.getAttribute('data-outline-line')).toBe(
        '10',
      )
    })
  })

  it('折叠刻意不持久化：把面板摘掉重挂（等价于下次打开）就是完整的树', async () => {
    render(<OutlinePanel />)
    await openOutline()
    await act(async () => {
      fireEvent.click(collapseToggle(5))
    })
    await waitFor(() => {
      expect(outlineTexts()).toEqual(['项目说明', '目标', '结论'])
    })

    cleanup()
    render(<OutlinePanel />)
    await waitFor(() => {
      expect(outlineTexts()).toEqual(['项目说明', '目标', '子目标', '结论'])
    })
    expect(window.localStorage.getItem('mimenote.ui.v1') ?? '').not.toContain('collapse')
  })

  it('一级都不剩时给一句人话，并能一键还原', async () => {
    render(<OutlinePanel />)
    await openOutline()

    for (const level of [1, 2, 3, 4, 5, 6]) {
      await act(async () => {
        fireEvent.click(levelButton(level))
      })
    }
    await waitFor(() => {
      expect(outlineTexts()).toHaveLength(0)
      expect(document.querySelector('.mn-outline__empty')?.textContent).toContain(
        '当前过滤条件下没有标题',
      )
    })

    await act(async () => {
      fireEvent.click(document.querySelector<HTMLElement>('.mn-outline__reset') as HTMLElement)
    })
    await waitFor(() => {
      expect(outlineTexts()).toHaveLength(4)
      expect(document.querySelector('.mn-outline__empty')).toBeNull()
    })
  })

  it('两个控件都是原生按钮，且三角不嵌套在条目按钮里（键盘与读屏都走得通）', async () => {
    render(<OutlinePanel />)
    await openOutline()

    const toggle = collapseToggle(5)
    const item = outlineItem(5)
    // 按钮套按钮是非法结构：读屏与键盘都会乱，而且点三角会连带触发"跳转"
    expect(item.contains(toggle)).toBe(false)
    expect(item.parentElement).toBe(toggle.parentElement)
    expect(toggle.tagName).toBe('BUTTON')
    expect(toggle.getAttribute('type')).toBe('button')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toContain('目标')
    // 原生按钮天然可被 Tab 聚焦、被 Enter/Space 触发（真浏览器里由 E2E 复核）
    expect(toggle.tabIndex).toBe(0)
    expect(levelButton(1).tagName).toBe('BUTTON')
    expect(levelButton(1).tabIndex).toBe(0)
    // 没有可见子标题的条目不给三角（按下去什么都不会发生的假控件）
    expect(document.querySelector('[data-outline-collapse="16"]')).toBeNull()
    // 条目的键盘行为没有被抢：条目本身仍是唯一的跳转入口，类名与行号口径不变
    expect(item.getAttribute('data-outline-line')).toBe('5')
  })

  it('阅读视图里过滤与折叠同样生效，且序号仍按完整列表算', async () => {
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

    // 关掉 H1：面板只剩三条，而它们仍然是完整列表里的第 2/3/4 条
    await act(async () => {
      fireEvent.click(levelButton(1))
    })
    await waitFor(() => {
      expect(outlineTexts()).toEqual(['目标', '子目标', '结论'])
    })

    // 点最后一条 → 滚到预览里第 **4** 个标题（「结论」）。若按可见列表的下标算，
    // 这里会滚到第 3 个「子目标」—— 这正是"序号必须按完整列表算"的现场。
    await act(async () => {
      fireEvent.click(outlineItem(16))
    })
    expect(scrollCalls).toEqual(['结论'])

    // 收起「目标」：它的 H3 子标题从面板消失（阅读视图里折叠同样生效）
    await act(async () => {
      fireEvent.click(collapseToggle(5))
    })
    await waitFor(() => {
      expect(outlineTexts()).toEqual(['目标', '结论'])
    })

    /*
     * 阅读视图的"当前章节"跟着滚动位置走（序号来自 `visibleHeadingOrdinal`）。
     * 让视口顶部停在第 3 个标题（`### 子目标`，第 10 行）—— 它此刻正被收起的「目标」藏着。
     */
    const scroller = document.querySelector<HTMLElement>('.mn-preview__scroller')
    Object.defineProperty(scroller as HTMLElement, 'getBoundingClientRect', {
      value: () => ({ top: 0 }) as DOMRect,
    })
    const headings = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.mn-preview__body h1, .mn-preview__body h2, .mn-preview__body h3',
      ),
    )
    headings.forEach((heading, index) => {
      const top = index <= 2 ? -20 + index * 10 : 300
      Object.defineProperty(heading, 'getBoundingClientRect', { value: () => ({ top }) as DOMRect })
    })
    await act(async () => {
      scroller?.dispatchEvent(new Event('scroll'))
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })
    await waitFor(() => {
      expect(document.querySelectorAll('.mn-outline__item--current')).toHaveLength(0)
      expect(
        document
          .querySelector('[data-outline-hidden-current]')
          ?.getAttribute('data-outline-hidden-current'),
      ).toBe('10')
    })

    // 换成"被过滤掉"这条路径：先展开（三角在 H3 还显示时才存在），再把 H3 关掉
    await act(async () => {
      fireEvent.click(collapseToggle(5))
    })
    await waitFor(() => {
      expect(outlineTexts()).toEqual(['目标', '子目标', '结论'])
    })
    await act(async () => {
      fireEvent.click(levelButton(3))
    })
    await waitFor(() => {
      expect(outlineTexts()).toEqual(['目标', '结论'])
      expect(document.querySelectorAll('.mn-outline__item--current')).toHaveLength(0)
      expect(
        document
          .querySelector('[data-outline-hidden-current]')
          ?.getAttribute('data-outline-hidden-current'),
      ).toBe('10')
    })

    // 全部还原：视图切回来时高亮就在原来的那一条上（面板是同一个实例，方位从未改变）
    await act(async () => {
      fireEvent.click(levelButton(1))
      fireEvent.click(levelButton(3))
    })
    await waitFor(() => {
      expect(outlineTexts()).toEqual(['项目说明', '目标', '子目标', '结论'])
      expect(
        document.querySelector('.mn-outline__item--current')?.getAttribute('data-outline-line'),
      ).toBe('10')
    })
  })
})
