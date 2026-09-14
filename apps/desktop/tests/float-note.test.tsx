// @vitest-environment jsdom
/**
 * 浮动笔记面板（图谱上的浮窗）的行为测试。
 *
 * 断言尽量落在**可观测的结果**上：几何（`onMove` 收到的 rect）、回调（置顶/关闭/打开）、
 * 焦点去哪儿了、正文渲没渲染出来。刻意不断言像素级的 CSS（那要靠页面 E2E，见 e2e/），
 * 也不断言内部状态（哪一个 ref、哪一层 memo）—— 换实现不该让这些用例变红。
 *
 * 拖动与缩放派发的是**真的** `PointerEvent`（jsdom 30 有它，`pointerId` 也是真的在比较，
 * 而不是两边都 undefined 的空比较；`setPointerCapture` 在 jsdom 里不存在，实现用
 * `typeof … === 'function'` + try/catch 兜住了）。区域尺寸用 `area` 这个 prop 直接给，
 * 不需要真的去动窗口。
 *
 * 与停靠面板的链接链路是同一套写法：`@/app/actions` 只包一层**计数**（工厂里 delegating 到
 * `importActual` 拿到的真实现，与 `preview-link-annotation.test.tsx` 同一种做法），
 * 因此"点了 wikilink"既是"调到了 openNote"，也真的把那篇笔记读进了编辑器。
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  FloatingNote,
  MIN_FLOAT_HEIGHT,
  MIN_FLOAT_WIDTH,
  type FloatingNoteProps,
  type FloatingRect,
} from '@/features/graph/FloatingNote'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import { useNoteStore } from '@/state/note-store'

/** `openNote` 被调到了哪些路径（`vi.hoisted`：mock 工厂会在 import 之前执行）。 */
const opened = vi.hoisted((): { relPaths: string[] } => ({ relPaths: [] }))

vi.mock('@/app/actions', async (importActual) => {
  const actual = await importActual<typeof import('@/app/actions')>()
  return {
    ...actual,
    openNote: async (relPath: string): Promise<boolean> => {
      opened.relPaths.push(relPath)
      return actual.openNote(relPath)
    },
  }
})

/** 画布可用区域（宿主元素的像素尺寸）。 */
const AREA = { width: 1000, height: 700 }

/** 浮窗的起始位置与大小：离左上角留了点边距，这样"夹取"在两个方向上都能观察到。 */
const START: FloatingRect = { x: 120, y: 90, width: 380, height: 300 }

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function renderFloat(overrides: Partial<FloatingNoteProps> = {}) {
  /** `onMove` 收到的每一个 rect（按顺序）—— 几何断言都读它。 */
  const rects: FloatingRect[] = []
  const onRaise = vi.fn()
  const onClose = vi.fn()
  const onOpenInEditor = vi.fn()

  const propsOf = (next: Partial<FloatingNoteProps>): FloatingNoteProps => ({
    relPath: '项目/设计.md',
    title: '设计',
    rect: START,
    zIndex: 6,
    area: AREA,
    active: true,
    onRaise,
    // `onMove` 的身份必须稳定：它进了"区域变化重新夹一次"那个 effect 的依赖，
    // 每次渲染都换一个新函数会让那个 effect 白跑一遍（虽然不会出错，但会让断言变脆）
    onMove: (rect: FloatingRect): void => {
      rects.push(rect)
    },
    onClose,
    onOpenInEditor,
    ...overrides,
    ...next,
  })

  const view = render(<FloatingNote {...propsOf({})} />)
  return {
    view,
    rects,
    onRaise,
    onClose,
    onOpenInEditor,
    rerender: (next: Partial<FloatingNoteProps>): void => {
      view.rerender(<FloatingNote {...propsOf(next)} />)
    },
  }
}

function part(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector)
  if (element === null) throw new Error(`没有这个元素：${selector}`)
  return element
}

/** 浮窗根元素（每次现取：重渲染之后 DOM 节点可能被换掉）。 */
function panel(): HTMLElement {
  return part('.mn-float-note')
}

/**
 * 等正文渲染出来再拿它。
 *
 * 正文要等一次 `note_read` 往返（初始态是加载中，那时 DOM 里没有这个元素），
 * 涉及正文的用例都必须先等它 —— 否则 `part` 直接抛错，而那条红与被测行为无关。
 */
async function article(): Promise<HTMLElement> {
  await waitFor(() => {
    expect(document.querySelector('.mn-float-note__article')).not.toBeNull()
  })
  return part('.mn-float-note__article')
}

function lastRect(rects: readonly FloatingRect[]): FloatingRect {
  const rect = rects.at(-1)
  if (rect === undefined) throw new Error('onMove 一次都没有被调到')
  return rect
}

/**
 * "夹在区域内"的断言：**整块矩形**都在区域里。
 *
 * 它比需求里那句"标题栏始终留在区域内"更强 —— 标题栏是面板顶部那一条，整块在区域内
 * 自然就包含它。刻意用更强的那个：真出问题时（浮窗被拖到只剩一条边露在外面）它也照样会红，
 * 而只断言"标题栏可见"在 jsdom 里根本量不出来（没有布局）。
 */
function expectInside(rect: FloatingRect, area = AREA): void {
  expect(rect.x).toBeGreaterThanOrEqual(0)
  expect(rect.y).toBeGreaterThanOrEqual(0)
  expect(rect.x + rect.width).toBeLessThanOrEqual(area.width)
  expect(rect.y + rect.height).toBeLessThanOrEqual(area.height)
}

/** 派发一次真的指针事件（坐标是**屏幕**坐标，与实现里的 clientX/clientY 同口径）。 */
function pointer(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  at: { x: number; y: number },
): void {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: at.x,
        clientY: at.y,
        button: 0,
        pointerId: 1,
      }),
    )
  })
}

/** 一次完整的拖动：按下 → 移动 → 松手。 */
function drag(target: Element, from: { x: number; y: number }, to: { x: number; y: number }): void {
  pointer(target, 'pointerdown', from)
  pointer(target, 'pointermove', to)
  pointer(target, 'pointerup', to)
}

beforeEach(() => {
  opened.relPaths.length = 0
  useNoteStore.getState().close()
  setIpcAdapter(createMockAdapter())
})

afterEach(cleanup)

// ---------------------------------------------------------------------------

describe('浮动笔记面板', () => {
  it('渲染标题、路径与无障碍信息，位置大小来自受控 props', () => {
    renderFloat({ rect: { x: 40, y: 30, width: 420, height: 260 }, zIndex: 9 })

    const root = panel()
    // 浮窗是对话框语义（`aria-modal={false}`：它不挡画布，画布仍然可点可拖）
    expect(root.getAttribute('role')).toBe('dialog')
    expect(root.getAttribute('aria-label')).toBe('设计（项目/设计.md）')
    expect(root.getAttribute('aria-modal')).toBe('false')
    /*
      这条属性是**集成契约**：画布 `GraphCanvas.handlePointerDown` 靠它把"这一块不参与平移"筛出去。
      少了它，在浮窗上拖动会同时平移画布。所以它必须有用例守着，而不是只写在注释里。
    */
    expect(root.hasAttribute('data-mn-graph-nopan')).toBe(true)

    // 位置与大小不自己存：行内样式就是 props 给的那一份
    expect(root.style.left).toBe('40px')
    expect(root.style.top).toBe('30px')
    expect(root.style.width).toBe('420px')
    expect(root.style.height).toBe('260px')
    expect(root.style.zIndex).toBe('9')

    // 标题与路径都在标题栏上（用户靠这两个认"这是哪一篇"）
    const header = part('.mn-float-note__header')
    expect(header.textContent).toContain('设计')
    expect(header.textContent).toContain('项目/设计.md')
    // 标题栏同时是键盘可聚焦的落点
    expect(header.getAttribute('tabindex')).toBe('0')
    // 缩放把手只响应指针：它不该出现在 Tab 序列里（键盘用户不会遇到一个按下去没反应的控件）
    expect(part('.mn-float-note__handle').getAttribute('aria-hidden')).toBe('true')
  })

  it('正文走与停靠面板同一条渲染链路（渲染后的正文 + wikilink 的已解析标注）', async () => {
    renderFloat()

    // Mock Vault 里 项目/设计.md 的正文里有表格与 [[路线图]]
    await waitFor(() => {
      expect(part('.mn-float-note__article').textContent).toContain('原子写')
    })
    // 正文容器用阅读视图的类（同一套排版规则），不是另一套 markdown 渲染
    expect(part('.mn-float-note__article').classList.contains('mn-preview__body')).toBe(true)

    // 出链表回来之后，wikilink 被标成"已解析"并带上目标路径（与 GraphPreview 逐字一致）
    await waitFor(() => {
      const link = document.querySelector('a.mn-wikilink[data-target="路线图"]')
      expect(link).not.toBeNull()
      expect(link?.getAttribute('data-rel-path')).toBe('项目/路线图.md')
      expect(link?.classList.contains('mn-wikilink--unresolved')).toBe(false)
    })
  })

  it('读盘期间显示加载态，读完再换成正文（不是只处理"有正文"这一条路）', async () => {
    const base = createMockAdapter()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    setIpcAdapter({
      kind: 'test',
      async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
        if (method === 'note_read') await gate
        return base.invoke<T>(method, args)
      },
    })

    renderFloat()
    expect(screen.getByText('正在读取…')).toBeTruthy()

    await act(async () => {
      release()
    })
    await waitFor(() => {
      expect(part('.mn-float-note__article').textContent).toContain('原子写')
    })
    expect(screen.queryByText('正在读取…')).toBeNull()
  })

  it('读盘失败时显示错误文案，而不是空白面板', async () => {
    setIpcAdapter({
      kind: 'test',
      // 故意失败：正文与出链两次请求都会走到这里的 catch
      invoke<T>(): Promise<T> {
        return Promise.reject(new Error('宿主读取失败'))
      },
    })

    renderFloat()
    const message = await screen.findByText(/无法预览/)
    expect(message.textContent).toBe('无法预览：宿主读取失败')
    expect(message.classList.contains('mn-float-note__error')).toBe(true)
  })

  it('拖动标题栏：按位移算出新位置，并在松手时再报一次收尾', () => {
    const { rects } = renderFloat()

    drag(part('.mn-float-note__header'), { x: 300, y: 200 }, { x: 350, y: 240 })

    // 位移 (+50, +40) 加在**按下那一刻**的 rect 上（不是逐帧累加）
    expect(rects).toEqual([
      { x: 170, y: 130, width: 380, height: 300 },
      { x: 170, y: 130, width: 380, height: 300 },
    ])
  })

  it('拖动被夹在区域内：往左上角或右下角拖很多都不出界', () => {
    const { rects } = renderFloat()

    // 往左上角拖出天际 —— 夹到 (0, 0)，标题栏仍然完整地在区域内
    drag(part('.mn-float-note__header'), { x: 300, y: 200 }, { x: -5000, y: -5000 })
    const topLeft = lastRect(rects)
    expect(topLeft.x).toBe(0)
    expect(topLeft.y).toBe(0)
    expectInside(topLeft)

    // 往右下角拖出天际 —— 夹到"右下角贴住区域边缘"
    drag(part('.mn-float-note__header'), { x: 300, y: 200 }, { x: 5000, y: 5000 })
    const bottomRight = lastRect(rects)
    expect(bottomRight.x).toBe(AREA.width - START.width)
    expect(bottomRight.y).toBe(AREA.height - START.height)
    expectInside(bottomRight)
  })

  it('只按在标题栏上才拖动：按在正文里不会移动面板', async () => {
    const { rects } = renderFloat()

    drag(await article(), { x: 300, y: 200 }, { x: 400, y: 300 })

    expect(rects).toEqual([])
  })

  it('右下角把手缩放：宽高按位移变化，位置不动', () => {
    const { rects } = renderFloat()

    drag(part('[data-float-resize]'), { x: 500, y: 390 }, { x: 620, y: 470 })

    expect(rects).toEqual([
      { x: 120, y: 90, width: 500, height: 380 },
      { x: 120, y: 90, width: 500, height: 380 },
    ])
  })

  it('缩放不小于最小尺寸（标题 + 两行正文还看得见的那个下限）', () => {
    const { rects } = renderFloat()

    // 往左上角拖把手 = 往小里缩；拖到 -5000 也只是顶到最小尺寸
    drag(part('[data-float-resize]'), { x: 500, y: 390 }, { x: -5000, y: -5000 })

    const clamped = lastRect(rects)
    expect(clamped.width).toBe(MIN_FLOAT_WIDTH)
    expect(clamped.height).toBe(MIN_FLOAT_HEIGHT)
    expect(clamped.x).toBe(START.x)
    expect(clamped.y).toBe(START.y)
  })

  it('缩放同样被夹在区域内：往右下角拖只会顶到区域右/下缘', () => {
    const { rects } = renderFloat()

    drag(part('[data-float-resize]'), { x: 500, y: 390 }, { x: 5000, y: 5000 })

    const grown = lastRect(rects)
    expect(grown.x + grown.width).toBe(AREA.width)
    expect(grown.y + grown.height).toBe(AREA.height)
    expectInside(grown)
  })

  it('面板任意处 pointerdown 都请求置顶（标题栏 / 正文 / 把手三处）', async () => {
    const { onRaise } = renderFloat()
    const body = await article()

    pointer(part('.mn-float-note__header'), 'pointerdown', { x: 300, y: 200 })
    expect(onRaise).toHaveBeenCalledTimes(1)
    pointer(body, 'pointerdown', { x: 300, y: 260 })
    expect(onRaise).toHaveBeenCalledTimes(2)
    pointer(part('[data-float-resize]'), 'pointerdown', { x: 500, y: 390 })
    expect(onRaise).toHaveBeenCalledTimes(3)
  })

  it('点位在正文里的链接上时也先置顶（置顶发生在 pointerdown，早于 click）', async () => {
    const { onRaise } = renderFloat()

    const link = await waitFor(() => {
      const found = document.querySelector<HTMLAnchorElement>('a.mn-wikilink[data-target="路线图"]')
      expect(found).not.toBeNull()
      return found
    })
    if (link === null) throw new Error('没有渲染出 wikilink')

    pointer(link, 'pointerdown', { x: 320, y: 280 })
    expect(onRaise).toHaveBeenCalledTimes(1)
  })

  it('Esc 关掉自己（最上面那个才响应）', () => {
    const { onClose } = renderFloat({ active: true })

    expect(panel().classList.contains('mn-float-note--active')).toBe(true)
    fireEvent.keyDown(panel(), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('焦点在输入框里时 Esc 不关浮窗（让用户先取消这次输入）', () => {
    const { onClose } = renderFloat()

    /*
      正文是 Markdown 渲染出来的，里面不会有输入框 —— 但"浮窗里放一个输入框"这件事
      （搜索、内联重命名）将来一定会有，而 `isTextEntryTarget` 这条判据现在就该成立。
      把它塞进正文容器，就是这一情形最忠实的模拟（输入框真的在浮窗的 DOM 里）。
    */
    const input = document.createElement('input')
    part('.mn-float-note__body').append(input)
    input.focus()

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    input.remove()
  })

  it('不是最上面那个时不响应 Esc（一次 Esc 只关一个浮窗）', () => {
    const { onClose } = renderFloat({ active: false })

    expect(panel().classList.contains('mn-float-note--active')).toBe(false)
    fireEvent.keyDown(panel(), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('「在编辑器中打开」与关闭按钮各走各的回调', () => {
    const { onOpenInEditor, onClose } = renderFloat()

    fireEvent.click(screen.getByLabelText('在编辑器中打开'))
    expect(onOpenInEditor).toHaveBeenCalledWith('项目/设计.md')
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByLabelText('关闭浮窗'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('打开时焦点进入浮窗，关闭后还给打开它的那个元素', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    expect(document.activeElement).toBe(opener)

    const { view } = renderFloat()
    // 打开即聚焦：键盘用户不会"浮窗开了但焦点还留在画布上"
    expect(document.activeElement).toBe(panel())

    view.unmount()
    // 关闭后焦点不会掉到 body 上（那意味着键盘用户要从头 Tab 一遍）
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('正文里的 [[wikilink]] 点了打开目标笔记（与停靠面板同一条链路）', async () => {
    renderFloat()

    const link = await waitFor(() => {
      const found = document.querySelector<HTMLAnchorElement>('a.mn-wikilink[data-target="路线图"]')
      expect(found).not.toBeNull()
      expect(found?.getAttribute('data-rel-path')).toBe('项目/路线图.md')
      return found
    })
    if (link === null) throw new Error('没有渲染出 wikilink')

    fireEvent.click(link)

    // 走的是 `openNote`（与文件树、双击卡片同一条动作链），不是浮窗自己发明的一套
    await waitFor(() => {
      expect(opened.relPaths).toContain('项目/路线图.md')
    })
    // 而且真的读进来了：目标笔记成了编辑器里的当前文档
    await waitFor(() => {
      expect(useNoteStore.getState().doc?.relPath).toBe('项目/路线图.md')
    })
  })

  it('区域变小之后重新夹一次位置（窗口缩放后浮窗仍然在看得见的地方）', () => {
    const { rects, rerender } = renderFloat()

    // 位置本来就在区域内：不该有任何上报（否则父组件每次渲染都会被"抖"一下）
    rerender({})
    expect(rects).toEqual([])

    // 区域缩到 400×200：原来的 (120, 90) 会露到外面，必须夹回来
    rerender({ area: { width: 400, height: 200 } })
    const clamped = lastRect(rects)
    // x 夹到"右缘贴住"（400 - 380）；y 因为**面板比区域还高**而退化成 0（左上角对齐）
    expect(clamped).toEqual({ x: 20, y: 0, width: 380, height: 300 })
    // 退化的只是"整块放不下"，要守住的性质仍然成立：标题栏（顶部那一条）在区域内
    expect(clamped.y).toBeGreaterThanOrEqual(0)
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(400)
  })

  it('浮窗里的滚轮不传给画布（否则画布缩放、而正文根本滚不动）', () => {
    const { view } = renderFloat()

    const reachedCanvas: number[] = []
    // 冒充画布：画布的滚轮监听挂在宿主上（浮窗的祖先），这里挂在 RTL 容器上就是同一个位置
    view.container.addEventListener('wheel', () => {
      reachedCanvas.push(1)
    })

    act(() => {
      part('.mn-float-note__body').dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 }),
      )
    })
    expect(reachedCanvas).toEqual([])

    // 对照：不经过浮窗的滚轮照常传到"画布"上 —— 证明上面那条不是"监听压根没生效"
    act(() => {
      view.container.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 }),
      )
    })
    expect(reachedCanvas).toHaveLength(1)
  })
})
