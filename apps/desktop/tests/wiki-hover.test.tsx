// @vitest-environment jsdom
/**
 * `[[链接]]` 悬停预览（ADR-0052）的行为测试。
 *
 * ## 为什么用**真编辑器** + 假 IPC
 *
 * 命中判据读的是**装饰写出来的 DOM**（`data-mn-wikilink`）与 `links-store` 里的出链，
 * 卡片的正文来自唯一那条渲染管线（`StaticNotePreview` → `ipc.noteRead`）。
 * 这条链路里没有可以单独喂输入的纯函数，所以这里挂真的 `EditorView`（与产品同一套
 * `createEditorExtensions`）、真的派发事件、真的等 React 渲染完，
 * 只有 IPC 用 Mock 适配器顶上 —— 与 `editor-wikilink-complete.test.tsx` 同一套做法。
 *
 * ## jsdom 没有布局，两处都是**显式**补的
 *
 * 1. `document.elementFromPoint` 在 jsdom 里恒返回 `null`：这里按"每个 wikilink 占
 *    100px 宽的一格"合成一张假布局（见 `stubGeometry`），于是"指针在哪一个链接上"
 *    由 x 坐标算出来 —— 用例仍然在驱动真实代码路径；
 * 2. `getBoundingClientRect` 一律是 0：面板尺寸由 stub 直接给出，
 *    于是"下方放不下就翻到上方"可以被逐字断言，而不依赖浏览器排版。
 *
 * 事件派发包在 `act()` 里：卡片是一棵 React 树，`act()` 保证"派发 → 渲染 → 断言"
 * 之间没有未刷新的更新。
 *
 * ## 定时器：**一条都不用假定时器**
 *
 * "快速扫过"那条曾经用 `vi.useFakeTimers()`，代价是两条不稳的用例：假定时器窗口里
 * React 的异步渲染与 `act()` 的排空互相等（跑整轮套件时偶发只渲染到卡片标题行）。
 * 现在的写法是**真定时器 + 误差方向永远偏向"等得更久"**：
 *
 * - "该出现"的用例一律**轮询到出现为止**（`waitForCard()` / `waitForArticle()`）——
 *   机器慢只会让它多等几百毫秒，只有功能真的坏了才会超时；
 * - "不该出现"的用例一律**等过头再断言**（`waitPastDelay()` / `HOVER_DELAY_MS * 3`）——
 *   本来就该缺席的东西，等多久都还是缺席。
 *
 * 唯一的例外是"延迟不是 0"那条的第一次检查：它就在 `hoverSlot` 之后的**同步帧**里断言，
 * 那时计时器不可能已经烧到（同一条 JS 线程），因此不需要任何时间余量。
 */

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CARD_MAX_HEIGHT_PX,
  CARD_WIDTH_PX,
  CLOSE_GRACE_MS,
  HOVER_DELAY_MS,
  MIN_CARD_HEIGHT_PX,
  placement,
} from '@/features/editor/cm/wiki-hover/wiki-hover'
import { createEditorExtensions } from '@/features/editor/cm/setup'
import { makeEntry, setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import type { ResolvedLink } from '@/ipc/types'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { useVaultStore } from '@/state/vault-store'

/** 当前笔记（出链表挂给它）。 */
const NOTE = '笔记/测试.md'
/** 已解析的目标（Mock Vault 里真实存在，正文可辨识）。 */
const DESIGN = '项目/设计.md'

/** 卡片根元素与它内部的钩子（类名由 `WikiHoverCard.tsx` 定义）。 */
const CARD = '.mn-wiki-hover'
const CARD_TITLE = `${CARD} .mn-wiki-hover__title`
const CARD_PATH = `${CARD} .mn-wiki-hover__path`
const CARD_ARTICLE = `${CARD} .mn-wiki-hover__article`

/**
 * 假布局里每个 wikilink 的宽度（像素）。
 *
 * 为什么需要：jsdom 里所有元素的 `getBoundingClientRect()` 都是 0，"指针在第一个链接上
 * 还是第二个上"就区分不开。这里让每个 `[data-mn-wikilink]` 独占 100px 宽的一格
 * （按 DOM 顺序从左往右排），`elementFromPoint` 与 `getBoundingClientRect` 都按它算。
 */
const SLOT_WIDTH_PX = 100

/** 面板的假尺寸（宽到能放下卡片，高到默认放在链接下方还有余量）。 */
const FRAME = { width: 800, height: 600 }

const views: EditorView[] = []

/** 造一个 `DOMRect`（不依赖 jsdom 的 `DOMRect` 构造器是否存在）。 */
function domRect(parts: { left: number; top: number; width: number; height: number }): DOMRect {
  const rect = {
    x: parts.left,
    y: parts.top,
    left: parts.left,
    top: parts.top,
    width: parts.width,
    height: parts.height,
    right: parts.left + parts.width,
    bottom: parts.top + parts.height,
  }
  return { ...rect, toJSON: () => rect } as DOMRect
}

/**
 * 铺一张假布局（见文件头）。
 *
 * @param frame 面板矩形；改它的高度就能构造"下方放不下 ⇒ 翻到上方"的场景
 */
function stubGeometry(frame: { width: number; height: number } = FRAME): void {
  /** 当前编辑器里所有 wikilink 元素（按 DOM 顺序 = 从左往右的格子顺序）。 */
  const slots = (): HTMLElement[] => {
    const view = views.at(-1)
    return view === undefined
      ? []
      : Array.from(view.dom.querySelectorAll<HTMLElement>('[data-mn-wikilink]'))
  }

  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ): DOMRect {
    const index = slots().indexOf(this)
    if (index >= 0) {
      return domRect({ left: index * SLOT_WIDTH_PX, top: 40, width: SLOT_WIDTH_PX, height: 20 })
    }
    return domRect({ left: 0, top: 0, width: frame.width, height: frame.height })
  })

  document.elementFromPoint = (x: number, y: number): Element | null => {
    // 指针落在链接那一行上：按 x 找格子；其余地方返回内容区（命中判据会往上找
    // `[data-mn-wikilink]`，找不到就是不弹）
    const view = views.at(-1)
    if (view === undefined) return null
    if (y >= 40 && y <= 60) {
      const index = Math.floor(x / SLOT_WIDTH_PX)
      const list = slots()
      if (index >= 0 && index < list.length) return list[index] ?? null
    }
    return view.contentDOM
  }
}

function mountEditor(doc: string, cursor = 0): EditorView {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: createEditorExtensions({}, true),
    }),
  })
  views.push(view)
  return view
}

// ---------------------------------------------------------------------------
// 桩：出链表 / 当前笔记 / Vault
// ---------------------------------------------------------------------------

function link(target: string, relPath: string | null): ResolvedLink {
  return {
    kind: 'wiki',
    rawTarget: target,
    display: target,
    alias: null,
    anchor: null,
    line: 1,
    resolvedRelPath: relPath,
    ambiguous: false,
  }
}

function setOutbound(outbound: readonly ResolvedLink[]): void {
  useLinksStore.setState({
    links: { relPath: NOTE, outbound: [...outbound], backlinks: [], unresolvedCount: 0 },
  })
}

function setCurrentNote(relPath: string): void {
  useNoteStore.setState({
    doc: {
      relPath,
      text: '',
      format: { bom: false, eol: '\n' },
      baseMtimeMs: 0,
      sizeBytes: 0,
      revision: 1,
      openedAt: 0,
    },
  })
}

function setVault(relPaths: readonly string[]): void {
  useVaultStore.setState({ entries: relPaths.map((relPath) => makeEntry({ relPath })) })
}

// ---------------------------------------------------------------------------
// 驱动
// ---------------------------------------------------------------------------

/** 等一轮事件循环（IPC 是异步的，微任务不够）。 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}


/**
 * 等**过**悬停延迟（负例专用：给足机会让它弹，然后断言它没有弹）。
 *
 * 为什么不复用 `waitForCard()`：那一个现在会**轮询到卡片出现**（正例），
 * 在"本来就不该弹"的场景里等它只会超时报错 —— 而这里要表达的恰恰是
 * "延迟一定已经过了，它仍然没有弹"。
 */
async function waitPastDelay(extra = 150): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, HOVER_DELAY_MS + extra))
  })
}

/** 让装饰先落到 DOM 上（jsdom 不会自己触发 measure 循环）。 */
async function renderDecorations(view: EditorView): Promise<void> {
  view.requestMeasure()
  await act(async () => {
    await settle()
  })
}

/**
 * 逼编辑器跑一次测量循环（用来让"几何变了"这件事真的发生）。
 *
 * 为什么必须显式逼：`geometryChanged` 是**这次测量结果与上一次不同**才置位的，而 jsdom 不会
 * 自己触发测量 —— 只改我们的假布局（stub）而不派发任何事件时，CodeMirror 根本不知道要重量。
 * 真实浏览器里滚动/窗口变化会自己走这一趟，测试里得手动代替它。
 */
async function remeasure(view: EditorView): Promise<void> {
  await act(async () => {
    view.requestMeasure()
    await settle()
    await settle()
  })
}

/**
 * 等卡片出现（**轮询**，而不是睡一个固定时长）。
 *
 * 要等的是"悬停延迟的定时器到点 → `flushSync` 渲染 → React 提交"这一条链。跑整轮套件时
 * 机器被别的用例占着，固定 sleep 就是在赌（第一版写的就是固定 sleep，单独跑全绿、
 * 整文件跑这一条会红 —— `waitForArticle` 已经因为同一个原因改过）。超时则说清等了多久，
 * 而不是让断言在后面莫名其妙地报"卡片是 null"。
 */
async function waitForCard(timeout = HOVER_DELAY_MS + 150): Promise<void> {
  const started = Date.now()
  while (card() === null && Date.now() - started < timeout) {
    await act(async () => {
      await settle()
    })
  }
  if (card() === null) throw new Error(`等了 ${timeout}ms，卡片始终没有出现`)
}

/**
 * 等卡片里的正文渲染出来。
 *
 * 卡片本体是同步渲染的（`flushSync`），而正文要等一次 `ipc.noteRead` + React 的再渲染 ——
 * 那是**两次微任务/宏任务跳转**，不能用"再睡固定 50ms"去赌（跑整轮套件时偶发只渲染到标题行，
 * 真实踩过一次）。这里轮询到出现为止，超时就失败并说清等了多久。
 */
async function waitForArticle(timeout = 2000): Promise<void> {
  const started = Date.now()
  while (cardArticle() === null && Date.now() - started < timeout) {
    await act(async () => {
      await settle()
    })
  }
  if (cardArticle() === null) throw new Error(`等了 ${timeout}ms，卡片正文始终没有渲染出来`)
}

/**
 * 把指针移到第 `slot` 个 wikilink 上（假布局按 DOM 顺序编号，见 `stubGeometry`）。
 *
 * 派发到 `contentDOM` 而不是 `view.dom`：CodeMirror 把插件的事件处理器挂在**内容区**上
 * （`ensureHandlers` 用的是 `view.contentDOM`），挂在根元素上收不到 —— 真实浏览器里
 * 指针本来就在内容区上，所以这样也更接近真实路径。
 */
async function hoverSlot(view: EditorView, slot: number): Promise<void> {
  const x = slot * SLOT_WIDTH_PX + SLOT_WIDTH_PX / 2
  await act(async () => {
    view.contentDOM.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: 50 }),
    )
    await settle()
  })
}

/** 指针移到编辑器正文的空白处（不命中任何链接）。 */
async function hoverBlank(view: EditorView): Promise<void> {
  await act(async () => {
    view.contentDOM.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, clientX: 5000, clientY: 50 }),
    )
    await settle()
  })
}


/**
 * 造一个带 `relatedTarget` 的 `mouseleave`。
 *
 * jsdom 的 `MouseEvent` 构造器**不支持** `relatedTarget`（`MouseEventInit` 里没有这一项，
 * 传了也会被丢掉），于是"指针从链接走进卡片"这条路没法用构造参数表达。
 * 这里手动把属性装上去：被测的判据就是"读 `relatedTarget`"，不是"读构造参数"。
 */
function leaveEvent(related: EventTarget | null): MouseEvent {
  const event = new MouseEvent('mouseleave', { bubbles: false })
  Object.defineProperty(event, 'relatedTarget', { value: related, configurable: true })
  return event
}

/** 鼠标整个离开编辑器的内容区。 */
async function leaveEditor(view: EditorView): Promise<void> {
  await act(async () => {
    view.contentDOM.dispatchEvent(leaveEvent(null))
    await settle()
  })
}

/** 在编辑器里按 `Esc`。 */
async function pressEscape(view: EditorView): Promise<void> {
  await act(async () => {
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
  })
}

function card(): HTMLElement | null {
  return document.querySelector<HTMLElement>(CARD)
}

function cardTitle(): string {
  return document.querySelector<HTMLElement>(CARD_TITLE)?.textContent ?? ''
}

function cardPath(): string {
  return document.querySelector<HTMLElement>(CARD_PATH)?.textContent ?? ''
}

function cardArticle(): HTMLElement | null {
  return document.querySelector<HTMLElement>(CARD_ARTICLE)
}

/** 一个 wikilink 元素（按 DOM 顺序）。 */
function linkElement(view: EditorView, slot: number): HTMLElement {
  const list = Array.from(view.dom.querySelectorAll<HTMLElement>('[data-mn-wikilink]'))
  const element = list[slot]
  if (element === undefined) {
    throw new Error(`编辑器里没有第 ${slot} 个 wikilink（只有 ${list.length} 个）`)
  }
  return element
}

beforeEach(() => {
  // 每个用例都从一张干净的"布局 spy 表"开始：`stubGeometry` 用的是 `vi.spyOn`，
  // 同一个用例里再铺一次（改面板尺寸）时上一次的实现必须已经不在了 ——
  // 否则它会把尺寸换回旧值（真实踩过：断言"翻到上方"时位置纹丝不动）
  vi.restoreAllMocks()
  setIpcAdapter(createMockAdapter())
  useNoteStore.getState().close()
  useLinksStore.getState().clear()
  useVaultStore.setState({ info: null, entries: [] })
  setCurrentNote(NOTE)
  setVault([NOTE, DESIGN])
})

afterEach(() => {
  /*
   * `vi.clearAllTimers()`：**必须是这一条**，不能只靠 `vi.useRealTimers()`。
   * 每条用例都会派发鼠标事件，而插件按设计会留下一个"等延迟/等宽限"的定时器；
   * 前一条用例留下的那个定时器可能在**下一条用例**派发事件之后才到期，
   * 于是它在下一条用例里关掉/打开一张卡片 —— 表现为"单独跑必过、整轮跑偶发红"
   * （真实踩过：`停在链接上不动` 偶发只渲染到标题行）。
   * 先切回真定时器再清，两种状态下的定时器都清掉。
   */
  vi.useRealTimers()
  vi.clearAllTimers()
  for (const view of views.splice(0)) view.destroy()
  document.body.innerHTML = ''
  // `elementFromPoint` 是直接赋值上去的（不是 spy），要自己摘掉
  Reflect.deleteProperty(document, 'elementFromPoint')
})

// ---------------------------------------------------------------------------
// 1. 弹出来的是目标笔记的正文
// ---------------------------------------------------------------------------

describe('悬停在一个已解析的 `[[链接]]` 上', () => {
  it('等过延迟之后弹出卡片，卡片里是目标笔记的正文（不是目标名字，也不是空卡片）', async () => {
    stubGeometry()
    setOutbound([link('设计', DESIGN)])
    const view = mountEditor('见 [[设计]] 吧', 0)
    await renderDecorations(view)

    expect(card()).toBeNull()
    await hoverSlot(view, 0)
    // 延迟没到：还是不该弹（这条与"快速扫过"是同一个判据的两面）
    expect(card()).toBeNull()

    await waitForCard()
    expect(card()).not.toBeNull()
    // 卡片的宿主是编辑器自己（同屏多编辑器时，"弹在别人的格子里"在结构上不可能）
    expect(view.dom.contains(card())).toBe(true)

    // 标题用显示名（`domain/paths.ts` 的 displayName：不带 `.md`），全路径在它旁边
    expect(cardTitle()).toBe('设计')
    expect(cardPath()).toBe(DESIGN)

    // 正文是真的渲染出来了：`项目/设计.md` 里那句可辨识的文字
    await waitForArticle()
    const article = cardArticle()
    expect(article).not.toBeNull()
    expect(article?.textContent).toContain('参考')
    expect(article?.querySelector('h1')?.textContent).toBe('设计')

    // 只读浮层：不进文档、不进标签页、不碰编辑器状态
    expect(view.state.doc.toString()).toBe('见 [[设计]] 吧')
    expect(useNoteStore.getState().doc?.relPath).toBe(NOTE)
  })

  it('悬空链接（`resolvedRelPath` 为 null）**不弹** —— 弹一张空卡片比不弹更糟', async () => {
    stubGeometry()
    setOutbound([link('还没写', null)])
    const view = mountEditor('见 [[还没写]] 吧', 0)
    await renderDecorations(view)
    // 悬空链接在编辑器里带 `--unresolved` 类名：先确认它真的被装饰成了链接
    expect(linkElement(view, 0).classList.contains('mn-wikilink--unresolved')).toBe(true)

    await hoverSlot(view, 0)
    await waitPastDelay()
    expect(card()).toBeNull()
    expect(view.state.doc.toString()).toBe('见 [[还没写]] 吧')
  })

  it('出链表里根本没有这条链接（索引还没回来）同样不弹', async () => {
    stubGeometry()
    setOutbound([])
    const view = mountEditor('见 [[设计]] 吧', 0)
    await renderDecorations(view)

    await hoverSlot(view, 0)
    await waitPastDelay()
    expect(card()).toBeNull()
  })

  it('`![[别的笔记]]`（嵌入但目标是笔记）同样可以预览；图片目标不弹', async () => {
    stubGeometry()
    setOutbound([link('设计', DESIGN), link('图.png', '附件/图.png')])
    const view = mountEditor('![[设计]]\n\n![[图.png]]', 0)
    await renderDecorations(view)

    // 第二格是图片：即使装饰出了元素，目标不是 Markdown 笔记也不弹
    await hoverSlot(view, 1)
    await waitPastDelay()
    expect(card()).toBeNull()

    await hoverSlot(view, 0)
    await waitForCard()
    expect(card()).not.toBeNull()
    expect(cardTitle()).toBe('设计')
  })
})

// ---------------------------------------------------------------------------
// 2. 收起：mouseleave / Esc / 点击别处 / 滚动
// ---------------------------------------------------------------------------

describe('收起', () => {
  /** 弹出一张卡片（本组用例的公共前置）。 */
  async function openCard(): Promise<EditorView> {
    stubGeometry()
    setOutbound([link('设计', DESIGN)])
    const view = mountEditor('见 [[设计]] 吧', 0)
    await renderDecorations(view)
    await hoverSlot(view, 0)
    await waitForCard()
    expect(card()).not.toBeNull()
    return view
  }

  it('指针离开编辑器：立刻收起（这里**不**走宽限：真的走了就是走了）', async () => {
    const view = await openCard()
    await leaveEditor(view)
    expect(card()).toBeNull()
  })

  it('`Esc`：收起，且不改文档、不吃掉这次按键（默认行为仍在）', async () => {
    const view = await openCard()
    await pressEscape(view)
    expect(card()).toBeNull()
    expect(view.state.doc.toString()).toBe('见 [[设计]] 吧')
  })

  it('点击编辑器别处：收起', async () => {
    const view = await openCard()
    await act(async () => {
      view.contentDOM.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      await settle()
    })
    expect(card()).toBeNull()
  })

  it('滚动 / 重排：卡片收起（不跟文档一起滚）', async () => {
    const view = await openCard()
    expect(card()).not.toBeNull()

    /*
     * 触发一次真正的重排：整篇换掉（装饰全部重建、行高重新量）会推出 `geometryChanged`。
     * jsdom 里量出来的高度永远是 0，所以"滚动多少像素"这件事没法直接表达 ——
     * 但被测判据是同一个：`update` 报告几何变了 ⇒ 收起卡片。
     */
    await act(async () => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: '见 [[设计]] 吧\n\n这一段让行数变多' },
      })
      await remeasure(view)
    })
    expect(card()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 3. 宽限：指针从链接走向卡片不会被"半路收起"
// ---------------------------------------------------------------------------

describe('宽限（`CLOSE_GRACE_MS`）', () => {
  it('指针离开链接但没停够宽限：卡片还在（用户正走在去卡片的路上）', async () => {
    stubGeometry()
    setOutbound([link('设计', DESIGN)])
    const view = mountEditor('见 [[设计]] 吧', 0)
    await renderDecorations(view)
    await hoverSlot(view, 0)
    await waitForCard()
    expect(card()).not.toBeNull()

    await hoverBlank(view)
    // 宽限未到：卡片必须还在 —— 少了这条，用户永远滚不动卡片里的长正文
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, CLOSE_GRACE_MS / 2))
    })
    expect(card()).not.toBeNull()

    // 宽限过了：收起
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, CLOSE_GRACE_MS + 80))
    })
    expect(card()).toBeNull()
  })

  it('指针从链接直接走向卡片：走的是 `mouseleave(relatedTarget = 卡片)` 这条路，卡片留着', async () => {
    stubGeometry()
    setOutbound([link('设计', DESIGN)])
    const view = mountEditor('见 [[设计]] 吧', 0)
    await renderDecorations(view)
    await hoverSlot(view, 0)
    await waitForCard()

    const element = card()
    expect(element).not.toBeNull()
    /*
     * 真实浏览器里的顺序是：指针离开内容区 → `contentDOM` 收到 `mouseleave`
     * （`relatedTarget` = 卡片）→ 之后的 `mousemove` 只落在卡片上（内容区上的处理器
     * 收不到，因为卡片是 `.cm-editor` 的孩子、不是内容区的后代）。
     * 所以"移进卡片不收起"这条只能由 `mouseleave` 的 `relatedTarget` 判据来保证 ——
     * 它要是没写，指针一离开内容区卡片就当场消失，宽限根本轮不到。
     */
    await act(async () => {
      view.contentDOM.dispatchEvent(leaveEvent(element))
      await new Promise((resolve) => setTimeout(resolve, CLOSE_GRACE_MS + 80))
    })
    expect(card()).not.toBeNull()

    // 卡片里的滚轮被截住（不会漏到编辑器上：卡片的滚轮只滚自己、不 preventDefault）
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true })
    await act(async () => {
      element?.dispatchEvent(wheel)
      await settle()
    })
    expect(wheel.defaultPrevented).toBe(false)
    expect(card()).not.toBeNull()
    // 卡片里的文字没被拖进文档（只读浮层）
    expect(view.state.doc.toString()).toBe('见 [[设计]] 吧')
  })
})

// ---------------------------------------------------------------------------
// 4. 快速扫过（真定时器 + 两头留足余量）
// ---------------------------------------------------------------------------

describe('快速扫过一行', () => {
  it('延迟没到就移开：卡片不出现（而且移开之后再等多久也不会"补弹"）', async () => {
    stubGeometry()
    setOutbound([link('设计', DESIGN)])
    const view = mountEditor('见 [[设计]] 吧', 0)
    await renderDecorations(view)

    await hoverSlot(view, 0)
    // 刚落到链接上就检查一次（同一个同步帧里计时器不可能已经烧到）：延迟不是 0
    expect(card()).toBeNull()

    /*
     * "扫过"= 指针**在延迟到点之前**就移开。这里刻意不先睡一小会儿再移开：那段"睡"就是竞态
     * —— 机器忙时 55ms 的睡眠可能被拖到 220ms 之后，于是延迟先到、卡片先弹，下一句断言
     * 就以"卡片弹了"的形式红（真实踩过：整轮套件里偶发）。移开之后等 `HOVER_DELAY_MS * 3`：
     * 若计时器只是"还没到"，这一等必然让它弹出；它没弹 ⇒ 那次移动真的**取消**了计时器。
     * 误差方向永远是"等得更久"，所以这条只会因为功能真的坏了而红。
     */
    await hoverBlank(view)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, HOVER_DELAY_MS * 3))
    })
    expect(card()).toBeNull()
  })

  it('停在链接上不动：延迟一到就弹（对照组，证明上一条不是"功能没装"）', async () => {
    stubGeometry()
    setOutbound([link('设计', DESIGN)])
    const view = mountEditor('见 [[设计]] 吧', 0)
    await renderDecorations(view)

    await hoverSlot(view, 0)
    // 等得更久（延迟 + 200ms）：真定时器下"等一下"只会更稳，不会改变结论
    await waitForCard(HOVER_DELAY_MS + 200)
    expect(card()).not.toBeNull()
    // 卡片头一行与正文一起渲染；正文要等一次 IPC，所以这里等到它出现为止
    expect(cardTitle()).toBe('设计')
    await waitForArticle()
    expect(cardArticle()?.textContent).toContain('参考')
  })
})

// ---------------------------------------------------------------------------
// 5. 文档变更之后卡片不能停在错误的位置/内容上
// ---------------------------------------------------------------------------

describe('文档变更（`[[` 被删掉）', () => {
  it('把 `[[设计]]` 删成普通文字：卡片立刻收起（判据是"那个链接元素还在不在"）', async () => {
    stubGeometry()
    setOutbound([link('设计', DESIGN)])
    const view = mountEditor('见 [[设计]] 吧', 0)
    await renderDecorations(view)
    await hoverSlot(view, 0)
    await waitForCard()
    expect(card()).not.toBeNull()

    await act(async () => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '见 设计 吧' } })
      await settle()
    })
    expect(card()).toBeNull()
  })

  it('在别处输入：卡片要么留着、要么收起，但**绝不**指向过期的内容', async () => {
    stubGeometry()
    setOutbound([link('设计', DESIGN)])
    const view = mountEditor('见 [[设计]] 吧', 0)
    await renderDecorations(view)
    await hoverSlot(view, 0)
    await waitForCard()
    expect(card()).not.toBeNull()

    await act(async () => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\n尾巴' } })
      await settle()
    })

    /*
     * 刻意**不**断言"卡片一定留着"：装饰在文档变更后会不会复用同一个 `<span>` 是
     * CodeMirror 的内部事（同一段代码在整轮套件里两种结果都出现过），
     * 把它写死等于让这条用例去测 CodeMirror 的重用策略。
     * 用户能看见的纪律只有一条：**卡片存在 ⇒ 它指着的那条链接也还在**，
     * 不允许出现"链接已经没了、卡片还在讲那篇笔记"。这正是这里断言的东西。
     */
    const element = card()
    if (element !== null) {
      expect(cardTitle()).toBe('设计')
      expect(view.dom.querySelector('[data-mn-wikilink]')).not.toBeNull()
    }
    expect(view.state.doc.toString()).toBe('见 [[设计]] 吧\n尾巴')
  })
})

// ---------------------------------------------------------------------------
// 6. 样式契约（类名 ↔ CSS 规则，与 wiki-complete 的同一套约定）
// ---------------------------------------------------------------------------

describe('样式契约（与 wiki-hover.css 逐条对齐）', () => {
  /** 直接从磁盘读样式表（与 `styleheets` 那道门禁同一套候选路径与理由）。 */
  function readSheet(): string {
    const candidates = [
      resolve(process.cwd(), 'src/features/editor/cm/wiki-hover/wiki-hover.css'),
      resolve(
        process.cwd(),
        'apps/desktop/src/features/editor/cm/wiki-hover/wiki-hover.css',
      ),
    ]
    for (const candidate of candidates) {
      try {
        return readFileSync(candidate, 'utf8')
      } catch {
        // 换下一个候选路径
      }
    }
    throw new Error(`找不到 wiki-hover.css（尝试过：${candidates.join('、')}）`)
  }

  const sheet = readSheet()

  /** 取某个选择器块里的某个属性值（够用的极简解析：本文件里没有嵌套的 `{}`）。 */
  function ruleOf(selector: string, property: string): string {
    const at = sheet.indexOf(`${selector} {`)
    if (at === -1) throw new Error(`样式表里没有 ${selector}`)
    const block = sheet.slice(at, sheet.indexOf('}', at))
    const matched = new RegExp(`${property}\\s*:\\s*([^;]+);`, 'u').exec(block)
    if (matched === null) throw new Error(`${selector} 里没有 ${property}`)
    return matched[1]!.trim()
  }

  it('卡片是绝对定位的浮层，自己纵向滚动（flex 里必须有 min-height: 0）', () => {
    expect(ruleOf('.mn-wiki-hover', 'position')).toBe('absolute')
    expect(ruleOf('.mn-wiki-hover', 'display')).toBe('flex')
    expect(ruleOf('.mn-wiki-hover', 'flex-direction')).toBe('column')
    expect(ruleOf('.mn-wiki-hover__body', 'overflow-y')).toBe('auto')
    // 少了这一条，flex 子项会被内容撑高，`overflow: auto` 永远不生效（滚动条跑到面板上）
    expect(ruleOf('.mn-wiki-hover__body', 'min-height')).toBe('0')
  })

  it('颜色只走令牌（换主题不需要改这个文件）', () => {
    expect(ruleOf('.mn-wiki-hover', 'background')).toContain('--mn-bg-elevated')
    expect(ruleOf('.mn-wiki-hover', 'border')).toContain('--mn-border')
    expect(ruleOf('.mn-wiki-hover', 'box-shadow')).toContain('--mn-shadow')
    expect(ruleOf('.mn-wiki-hover__title', 'color')).toContain('--mn-heading')
    expect(ruleOf('.mn-wiki-hover__path', 'color')).toContain('--mn-fg-subtle')
  })

  it('JS 与 CSS 的高度下限成对（改了 CSS 不改 JS，卡片会塌成一条缝）', () => {
    // 宽度与最大高度只由 JS 写进行内样式（CSS 里没有这两个数字）——
    // 能成对钉住的只有高度下限：`placement()` 算出来的 `max-height` 不会小于它
    expect(ruleOf('.mn-wiki-hover', 'min-height')).toBe(`${MIN_CARD_HEIGHT_PX}px`)
    expect(CARD_WIDTH_PX).toBeGreaterThan(200)
    expect(CARD_MAX_HEIGHT_PX).toBeGreaterThan(MIN_CARD_HEIGHT_PX)
  })
})

// ---------------------------------------------------------------------------
// 7. 位置：夹在面板内、不挡住链接所在那一行
// ---------------------------------------------------------------------------

describe('位置', () => {
  it('默认放在链接**下方**（不挡光标所在那一行）', () => {
    const position = placement({ left: 100, top: 40, bottom: 60 }, FRAME)
    expect(position.top).toBe(60 + 8)
    expect(position.left).toBe(100)
    expect(position.width).toBe(CARD_WIDTH_PX)
    expect(position.maxHeight).toBeLessThanOrEqual(CARD_MAX_HEIGHT_PX)
  })

  it('下方放不下就翻到链接**上方**', () => {
    // 面板很矮、链接偏下：上下都放不下整张卡片，取更宽裕的那一侧（上方）
    const position = placement({ left: 100, top: 300, bottom: 320 }, { width: 800, height: 400 })
    expect(position.top).toBeLessThan(300)
    expect(position.top + position.maxHeight).toBeLessThanOrEqual(300)
  })

  it('右侧放不下就贴住右缘（面板比卡片窄时贴左缘，左上角永远可见）', () => {
    expect(placement({ left: 700, top: 0, bottom: 20 }, FRAME).left).toBe(
      FRAME.width - CARD_WIDTH_PX,
    )
    expect(placement({ left: 700, top: 0, bottom: 20 }, { width: 300, height: 400 }).left).toBe(0)
  })

  it('高度永远落在 [下限, 上限] 之间（卡片自己滚，绝不把面板撑出滚动条）', () => {
    const tiny = placement({ left: 0, top: 0, bottom: 20 }, { width: 800, height: 30 })
    expect(tiny.maxHeight).toBeGreaterThanOrEqual(MIN_CARD_HEIGHT_PX)
    const roomy = placement({ left: 0, top: 0, bottom: 20 }, FRAME)
    expect(roomy.maxHeight).toBeLessThanOrEqual(CARD_MAX_HEIGHT_PX)
  })

  it('真实装配里位置真的写进了行内样式（不是只算不写）', async () => {
    stubGeometry()
    setOutbound([link('设计', DESIGN)])
    const view = mountEditor('见 [[设计]] 吧', 0)
    await renderDecorations(view)
    await hoverSlot(view, 0)
    await waitForCard()

    const element = card()
    expect(element?.style.left).toBe('0px')
    expect(element?.style.top).toBe(`${60 + 8}px`)
    expect(element?.style.width).toBe(`${CARD_WIDTH_PX}px`)
    expect(element?.style.maxHeight).toBe(`${CARD_MAX_HEIGHT_PX}px`)
  })
})