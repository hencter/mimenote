// @vitest-environment jsdom
/**
 * 拖拽手感（ADR-0023 后续修订）测试。
 *
 * 用户原话：「拖拽卡片没有变动位置，然后没有碰撞推动卡片，整体非常僵硬！」
 * 三句话对应三条必须守住的**可观测**性质：
 *
 * 1. 「拖拽没有变动位置」→ 拖动时卡片的世界矩形必须跟着光标走（不是弹回环上的原位）；
 * 2. 「没有碰撞推动卡片」→ 把一张拖到另一张上时，后者必须让开（拖动过程中零重叠）；
 * 3. 「整体非常僵硬」→ 交互必须**重新加热**力场：`settle()` 之后 alpha = 0，不加热的话
 *    除硬碰撞以外的力全部停摆，观感就是"整幅图是死的"，而且"漂浮"开关会看起来完全没用。
 *
 * 还有一个隐蔽的根因值得单独钉住：**命中测试必须用当前矩形**。力场会把同心环收紧大约
 * 三分之二，如果按环上的原始矩形判命中，用户"按在画着的那张卡片上"抓住的却是另一张。
 *
 * 断言全部落在宿主上的诊断属性与画布的绘制顺序上：
 * - `data-graph-card-rects` 给出**看得见的每张卡片**的世界矩形（一位小数）；
 * - 画笔记录给出"这一帧按什么顺序画的"（画布没有 z-index，顺序就是层级）。
 *
 * ⚠️ 特意**不**用"某段文字画在哪"来反推卡片位置：正文里同样会出现那两个字
 * （标题「路线图」与正文里的 `[[路线图]]` 撞名），反推出来的位置会是正文那一段的。
 */

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openNote } from '@/app/actions'
import { GraphCanvas } from '@/features/graph/GraphCanvas'
import type { PaintContext } from '@/features/graph/canvas/paint'
import type { Point, Rect } from '@/features/graph/layout'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import { DEFAULT_VIEW, FALLBACK_VIEWPORT, useGraphStore } from '@/state/graph-store'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

// ---------------------------------------------------------------------------
// 观测手段
// ---------------------------------------------------------------------------

/**
 * 记录型 2D 上下文。
 *
 * 为什么必须有它：卡片画在 canvas 上，jsdom 没有真画布（`getContext('2d')` 返回 null），
 * 组件会把整段绘制跳过 —— 于是"这一帧按什么顺序画的"完全不可观测。
 */
class RecordingPaintContext implements PaintContext {
  font = '10px sans-serif'
  fillStyle: string | CanvasGradient | CanvasPattern = '#000000'
  strokeStyle: string | CanvasGradient | CanvasPattern = '#000000'
  lineWidth = 1
  globalAlpha = 1
  textAlign = 'start'
  textBaseline = 'alphabetic'
  lineJoin = 'miter'
  /** 连线的虚线相位（本文件只关心文字顺序，这里留着只是为了满足接口契约）。 */
  lineDashOffset = 0

  private readonly texts: string[] = []

  /** 这一帧里文字被画出来的**顺序**（画布没有 z-index，顺序就是层级）。 */
  drawnOrder(): string[] {
    return [...this.texts]
  }

  clear(): void {
    this.texts.length = 0
  }

  save(): void {}
  restore(): void {}
  setTransform(): void {}
  clearRect(): void {}
  beginPath(): void {}
  closePath(): void {}
  rect(): void {}
  clip(): void {}
  moveTo(): void {}
  lineTo(): void {}
  bezierCurveTo(): void {}
  arc(): void {}
  fill(): void {}
  stroke(): void {}
  fillRect(): void {}
  strokeRect(): void {}
  setLineDash(): void {}

  fillText(text: string): void {
    this.texts.push(text)
  }

  /** 每字 8px：只要非零就够（真字体度量只有浏览器里有）。 */
  measureText(text: string): { width: number } {
    return { width: text.length * 8 }
  }
}

const paint = new RecordingPaintContext()
const originalGetContext = HTMLCanvasElement.prototype.getContext

function installRecordingCanvas(): void {
  HTMLCanvasElement.prototype.getContext = (() =>
    paint) as unknown as typeof HTMLCanvasElement.prototype.getContext
}

function restoreCanvas(): void {
  HTMLCanvasElement.prototype.getContext = originalGetContext
}

const ROOT = '项目/设计.md'
/** Mock Vault 的根（与 `tests/graph.test.tsx` 同一个）。 */
const VAULT_ROOT = 'C:\\MockVault'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 派发真的 `PointerEvent`（jsdom 有它，`pointerId` 两侧比较因此是真的在比同一个数）。 */
function pointer(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: { x: number; y: number; button?: number },
): void {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: init.x,
        clientY: init.y,
        button: init.button ?? 0,
        pointerId: 1,
      }),
    )
  })
}

function graphHost(): HTMLElement {
  const host = document.querySelector<HTMLElement>('.mn-graph')
  if (host === null) throw new Error('没有渲染出图谱宿主元素')
  return host
}

function numberAttr(name: string): number {
  return Number(graphHost().getAttribute(name))
}

/**
 * 当前**可见**卡片的矩形（世界坐标），来自宿主上的 `data-graph-card-rects`。
 *
 * 这是拖拽唯一可靠的观测入口：卡片画在 canvas 上，没有 DOM 可量。
 */
function cardRects(): Map<string, Rect> {
  const raw = graphHost().getAttribute('data-graph-card-rects') ?? ''
  const result = new Map<string, Rect>()
  for (const entry of raw.split(';')) {
    if (entry === '') continue
    const [relPath, numbers] = entry.split('|')
    if (relPath === undefined || numbers === undefined) continue
    const [x, y, width, height] = numbers.split(',').map((part) => Number(part))
    if (x === undefined || y === undefined || width === undefined || height === undefined) continue
    result.set(relPath, { x, y, width, height })
  }
  return result
}

function rectOf(relPath: string): Rect {
  const found = cardRects().get(relPath)
  if (found === undefined) throw new Error(`这一帧没有列出「${relPath}」的矩形`)
  return found
}

/** 除圆心之外的**另一张**（取离圆心最远的那张：压住它需要真的搬过去，断言才有意义）。 */
function otherCardPath(): string {
  const root = rectOf(ROOT)
  const origin = { x: root.x + root.width / 2, y: root.y + root.height / 2 }
  let best: { relPath: string; distance: number } | null = null
  for (const [relPath, rect] of cardRects()) {
    if (relPath === ROOT) continue
    const distance = Math.hypot(rect.x + rect.width / 2 - origin.x, rect.y + rect.height / 2 - origin.y)
    if (best === null || distance > best.distance) best = { relPath, distance }
  }
  if (best === null) throw new Error('焦点视图里只有圆心那一张卡片，本用例无法继续')
  return best.relPath
}

function centerOf(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

/** 世界坐标 → 派发指针事件用的 client 坐标（宿主上的三个属性就是"世界原点的屏幕位置"）。 */
function screenPoint(world: Point): Point {
  const rect = graphHost().getBoundingClientRect()
  return {
    x: rect.left + world.x * numberAttr('data-graph-scale') + numberAttr('data-graph-offset-x'),
    y: rect.top + world.y * numberAttr('data-graph-scale') + numberAttr('data-graph-offset-y'),
  }
}

function worldScale(): number {
  return numberAttr('data-graph-scale')
}

/** 两个矩形中心的距离（世界坐标）。 */
function distanceBetween(a: Rect, b: Rect): number {
  const ca = centerOf(a)
  const cb = centerOf(b)
  return Math.hypot(cb.x - ca.x, cb.y - ca.y)
}

function resetStores(): void {
  useNoteStore.getState().close()
  useUiStore.setState({ viewMode: 'graph', paletteMode: null, linksPanelVisible: false })
  useLinksStore.setState({
    status: { phase: 'idle', indexed: 0, total: 0, durationMs: 0, links: 0 },
    links: null,
    loading: false,
    error: null,
  })
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
  useGraphStore.setState({
    status: 'idle',
    data: null,
    error: null,
    rootPath: null,
    selected: null,
    view: DEFAULT_VIEW,
    collapsed: new Set<string>(),
    manual: new Map(),
    staleIndex: false,
    loadedAtMs: 0,
    viewport: { ...FALLBACK_VIEWPORT, known: false },
    refreshing: false,
    refreshNotice: null,
    fitKey: null,
    pins: new Map(),
  })
}

/** 挂载焦点视图（默认视图），等到圆心那张卡片连位置一起就位。 */
async function mountFocus(relPath: string): Promise<void> {
  // 先开库：焦点图谱走 `graph_ego`，而圆心是从"当前打开的笔记"推出来的
  await useVaultStore.getState().openVault(VAULT_ROOT)
  await act(async () => {
    await openNote(relPath)
  })
  render(<GraphCanvas />)
  await waitFor(() => {
    expect(graphHost().getAttribute('data-graph-mode')).toBe('focus')
    expect(numberAttr('data-graph-canvas-cards')).toBeGreaterThan(1)
    expect(cardRects().size).toBeGreaterThan(1)
    expect(rectOf(ROOT).width).toBeGreaterThan(0)
  })
}

beforeEach(() => {
  installRecordingCanvas()
  paint.clear()
  setIpcAdapter(createMockAdapter())
  resetStores()
})

afterEach(() => {
  cleanup()
  restoreCanvas()
})

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('拖拽卡片', () => {
  it('拖动时卡片跟着光标走（不是弹回环上的原位）', async () => {
    /*
      用户报的第一件事。根因不是"没把位置写进去"，而是 `pins` 曾是模拟 effect 的依赖：
      每个 pointermove 都重建一次模拟（从同心环的种子重新落定），刚摆下的位置立刻被覆盖 ——
      观感就是"怎么拖都不动"。
    */
    await mountFocus(ROOT)
    const before = rectOf(ROOT)
    const offsetBefore = numberAttr('data-graph-offset-x')
    const scale = worldScale()
    const from = screenPoint(centerOf(before))

    pointer(graphHost(), 'pointerdown', { x: from.x, y: from.y })
    pointer(graphHost(), 'pointermove', { x: from.x + 120, y: from.y + 90 })

    // 拖动**过程中**就已经跟着走了（不是等松手才跳过去）。
    // 容差 0.2px：宿主上那份矩形保留一位小数，两次取整相加最多带来 0.1px 的量化误差。
    const during = rectOf(ROOT)
    expect(Math.abs(during.x - before.x - 120 / scale)).toBeLessThan(0.2)
    expect(Math.abs(during.y - before.y - 90 / scale)).toBeLessThan(0.2)

    pointer(graphHost(), 'pointerup', { x: from.x + 120, y: from.y + 90 })

    // 松手之后位置仍然是拖到的那个（它是 `fixed` 的，力场不会把它拽回去）
    const after = rectOf(ROOT)
    expect(Math.abs(after.x - during.x)).toBeLessThan(0.2)
    expect(Math.abs(after.y - during.y)).toBeLessThan(0.2)
    expect(useGraphStore.getState().pins.has(ROOT)).toBe(true)
    // 拖卡片不是平移画布（画布原点没有被挪动）
    expect(numberAttr('data-graph-offset-x')).toBe(offsetBefore)
  })

  it('命中测试用当前矩形：同心环收紧之后依然抓得住、抓得对', async () => {
    /*
      力场会把环收紧（默认档实测约收三分之二），所以"环上的原始矩形"与"画着的位置"差很远。
      这条用例按**当前矩形**的中心去点，抓住的必须正是那一张 ——
      按原始矩形判命中的话，这里抓到的会是另一张（或什么都抓不到）。
    */
    await mountFocus(ROOT)
    const target = otherCardPath()
    const at = screenPoint(centerOf(rectOf(target)))

    pointer(graphHost(), 'pointerdown', { x: at.x, y: at.y })
    pointer(graphHost(), 'pointermove', { x: at.x + 40, y: at.y + 10 })
    pointer(graphHost(), 'pointerup', { x: at.x + 40, y: at.y + 10 })

    expect([...useGraphStore.getState().pins.keys()]).toEqual([target])
  })

  it('碰撞：把卡片拖到另一张上，它会被推开（拖动过程中零重叠）', async () => {
    /*
      用户报的第二件事。硬碰撞（`collidePass`）每一步都会解重叠，所以"拖过去压住别人"时
      后者必须让开；而"让开"只在**模拟真的在被推进**时才发生 —— 拖动时手动推步
      （`advanceSimulation`）就是为此。
    */
    await mountFocus(ROOT)
    const target = otherCardPath()
    const targetBefore = rectOf(target)

    // 把圆心那张（它本来就是 `fixed`）搬到另一张卡片上
    const grab = screenPoint(centerOf(rectOf(ROOT)))
    const landing = screenPoint(centerOf(targetBefore))
    pointer(graphHost(), 'pointerdown', { x: grab.x, y: grab.y })
    pointer(graphHost(), 'pointermove', { x: landing.x, y: landing.y })

    // 零重叠：硬约束在**拖动过程中**同样成立（不是"松手之后才修好"）
    expect(numberAttr('data-graph-overlaps')).toBe(0)
    // 被压住的那张已经让开了：两张的中心距不可能还是"叠着"的距离
    const pushed = rectOf(target)
    expect(distanceBetween(pushed, rectOf(ROOT))).toBeGreaterThan(
      distanceBetween(targetBefore, rectOf(ROOT)),
    )

    pointer(graphHost(), 'pointerup', { x: landing.x, y: landing.y })
    expect(numberAttr('data-graph-overlaps')).toBe(0)
  })

  it('拖动会重新加热力场：邻居被斥力/弹簧推着动（不是只有硬碰撞在动）', async () => {
    /*
      用户报的第三件事（"整体非常僵硬"）的根因：打开图谱时 `settle()` 已经把 alpha 跑到 0，
      此后除硬碰撞外所有力都停摆。这条用例守的是"交互会 `heat`"：
      把圆心那张**往邻居的反方向**拖（这条路径上没有碰撞，只有弹簧被拉长），
      邻居也必须动 —— 只有力被唤醒才可能发生。
    */
    await mountFocus(ROOT)
    const target = otherCardPath()
    const targetBefore = rectOf(target)
    const grab = screenPoint(centerOf(rectOf(ROOT)))
    const origin = centerOf(rectOf(ROOT))
    const away = centerOf(targetBefore)

    // 远离邻居的方向（单位向量取反），保证这一次拖动不会撞上它
    const dx = origin.x - away.x
    const dy = origin.y - away.y
    const length = Math.hypot(dx, dy)
    const to = screenPoint({
      x: origin.x + (dx / length) * 220,
      y: origin.y + (dy / length) * 220,
    })

    pointer(graphHost(), 'pointerdown', { x: grab.x, y: grab.y })
    pointer(graphHost(), 'pointermove', { x: to.x, y: to.y })

    const targetAfter = rectOf(target)
    // 被拉长的弹簧把它往回拽：位置必须变（这条路径上硬碰撞完全没参与）
    expect(
      Math.abs(targetAfter.x - targetBefore.x) + Math.abs(targetAfter.y - targetBefore.y),
    ).toBeGreaterThan(0.1)

    pointer(graphHost(), 'pointerup', { x: to.x, y: to.y })
    expect(numberAttr('data-graph-overlaps')).toBe(0)
  })

  it('拖动中的卡片画在最上层（拖到别人身上不会被盖住）', async () => {
    /*
      画布没有 z-index：绘制顺序就是层级。拖动时把这一张排到最后，用户才看得见"我在搬它"；
      不这么做的话拖到另一张上就变成"卡片消失了"。
    */
    await mountFocus(ROOT)
    const target = otherCardPath()
    const titleOf = (relPath: string): string => (relPath.split('/').pop() ?? relPath).replace(/\.md$/, '')
    const grab = screenPoint(centerOf(rectOf(ROOT)))

    paint.clear()
    pointer(graphHost(), 'pointerdown', { x: grab.x, y: grab.y })
    pointer(graphHost(), 'pointermove', { x: grab.x + 30, y: grab.y + 20 })

    // 一帧里每张卡片的标题都被画一次。取"圆心那张标题**最后一次**出现"的位置：
    // 圆心那篇的正文里会出现别的卡片名（`[[路线图]]` 的 run 文本就是 `路线图`），
    // 所以要认准"它自己那张卡片被画的时刻"。
    const order = paint.drawnOrder()
    const draggedTitle = titleOf(ROOT)
    const otherTitle = titleOf(target)
    const draggedAt = order.lastIndexOf(draggedTitle)
    // 别人取**第一次**出现：那是它自己卡片标题被画的时刻（圆心那张的正文排在后面）
    const otherAt = order.indexOf(otherTitle)
    expect(draggedAt).toBeGreaterThanOrEqual(0)
    expect(otherAt).toBeGreaterThanOrEqual(0)
    expect(draggedAt).toBeGreaterThan(otherAt) // 后画 = 在上

    pointer(graphHost(), 'pointerup', { x: grab.x + 30, y: grab.y + 20 })
  })

  it('「松开卡片」把被按住的卡片交还力场（会真的被张力拉走）', async () => {
    /*
      只 `unpin` 是不够的：alpha 已经是 0，卡片会"松开了但一动不动"，用户只会觉得按钮没生效。
      松开必须同时加热 + 推步（`releasePins`），位置才会重新被张力牵引。
    */
    await mountFocus(ROOT)
    const grab = screenPoint(centerOf(rectOf(ROOT)))
    pointer(graphHost(), 'pointerdown', { x: grab.x, y: grab.y })
    pointer(graphHost(), 'pointermove', { x: grab.x + 260, y: grab.y + 180 })
    pointer(graphHost(), 'pointerup', { x: grab.x + 260, y: grab.y + 180 })

    const dragged = rectOf(ROOT)
    expect(useGraphStore.getState().pins.size).toBe(1)
    expect(numberAttr('data-graph-pinned')).toBe(1)

    const button = document.querySelector<HTMLElement>('[data-graph-action="unpin-cards"]')
    if (button === null) throw new Error('HUD 上没有「松开卡片」按钮')
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(useGraphStore.getState().pins.size).toBe(0)
    expect(numberAttr('data-graph-pinned')).toBe(0)
    // 交还力场之后位置被张力重新拉（不要求拉回原点，只要求"真的动了"）
    const released = rectOf(ROOT)
    expect(Math.abs(released.x - dragged.x) + Math.abs(released.y - dragged.y)).toBeGreaterThan(1)
    expect(numberAttr('data-graph-overlaps')).toBe(0)
  })
})
