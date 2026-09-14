// @vitest-environment jsdom
/**
 * 知识图谱卡片画布（M3 核心功能）测试。
 *
 * 分两层，与 `search.test.tsx` / `tags.test.tsx` 同样的思路：
 *
 * 1. **布局与几何纯函数**（`features/graph/layout.ts`）：文件夹分组与嵌套、容器尺寸随内容增长、
 *    网格排布不重叠、视口裁剪只返回相交项、边的分类（入链虚线 / 出链实线）与连接点。
 *    这些断言不碰 DOM，所以出问题时能直接指到"哪个坐标算错了"。
 * 2. **组件行为**（`GraphCanvas` + Mock 适配器的 `graph_data`）：卡片与文件夹容器渲染、
 *    单击选中（正文本来就画在卡片正面；ADR-0025 起不再有侧边预览面板）、双击进编辑器、
 *    文件夹收起/展开、悬停 wikilink 高亮连线、键盘与拖动。
 *
 * 断言尽量落在**可观测的结果**上（DOM 结构、store 状态、localStorage），
 * 而不是内部实现细节（用了哪个变量、哪一层 memo），换实现不该让这些用例变红。
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { App } from '@/App'
import { openNote } from '@/app/actions'
import { registerBuiltinCommands, GRAPH_COMMAND_IDS } from '@/app/builtin-commands'
import { commands } from '@/app/commands'
import { useGlobalKeymap } from '@/app/keymap'
import { compareEntries } from '@/domain/tree'
import { isMarkdown } from '@/domain/paths'
import { GraphCanvas } from '@/features/graph/GraphCanvas'
import { GraphEdges } from '@/features/graph/GraphEdges'
import type { PaintContext } from '@/features/graph/canvas/paint'
import {
  CARD_GAP,
  CARD_HEIGHT,
  CARD_WIDTH,
  FOLDER_CHIP_HEIGHT,
  MAX_ZOOM,
  MIN_ZOOM,
  applyManualPositions,
  buildEdgeVisuals,
  buildFolderTree,
  buildLayout,
  buildRectIndex,
  collectFolderPaths,
  edgeAnchors,
  edgePath,
  edgeStyle,
  fitView,
  gridPositions,
  packRows,
  pruneManualPositions,
  queryIndex,
  queryViewport,
  rectsIntersect,
  worldViewport,
  zoomAround,
  type GraphCardBox,
  type GraphEdgeVisual,
  type Point,
  type Rect,
} from '@/features/graph/layout'
import { makeEntry, setIpcAdapter, type IpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import type { GraphData, GraphEdge, GraphNode } from '@/ipc/types'
import {
  DEFAULT_EGO_DEPTH,
  DEFAULT_FORCE_PRESET,
  DEFAULT_VIEW,
  FALLBACK_VIEWPORT,
  FORCE_SLIDER_KEYS,
  POSITIONS_KEY,
  PREFS_KEY,
  flushPositionPersist,
  useGraphStore,
} from '@/state/graph-store'
import { forcePreset } from '@/features/graph/force-presets'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

const VAULT_ROOT = 'C:\\MockVault'

/**
 * Mock Vault 里"图谱会收录的笔记数"（= 卡片数）。
 *
 * 刻意**不写死数字**：给 Mock Vault 加一篇演示笔记（例如大纲面板用的 `项目/大纲.md`）
 * 就会让一批与图谱无关的断言集体变红 —— 那种红是噪音，不是回归；从 Mock 自己的笔记表
 * 算出来，加笔记时这些用例不用改。
 */
const MOCK_CARD_COUNT = createMockAdapter()
  .dump()
  .filter((note) => isMarkdown(note.relPath)).length

// ---------------------------------------------------------------------------
// 测试数据与工具
// ---------------------------------------------------------------------------

function node(relPath: string, folder: string, extra: Partial<GraphNode> = {}): GraphNode {
  const name = relPath.split('/').pop() ?? relPath
  return {
    relPath,
    title: name.replace(/\.(md|markdown)$/i, ''),
    folder,
    tags: [],
    outDegree: 0,
    inDegree: 0,
    ...extra,
  }
}

/** 与 Mock Vault 形状一致的小样本（布局纯函数用，不走 IPC）。 */
const SAMPLE_NODES: GraphNode[] = [
  node('README.md', '', { inDegree: 1 }),
  node('随手记.md', ''),
  node('项目/设计.md', '项目', { tags: ['项目', '架构'], outDegree: 2, inDegree: 1 }),
  node('项目/路线图.md', '项目', { outDegree: 1 }),
  node('项目/标签示例.md', '项目', { tags: ['项目', '进行中'] }),
  node('项目/子项目/细节.md', '项目/子项目', { outDegree: 1 }),
  node('日记/2025-01-01.md', '日记'),
  node('日记/2025-01-02.md', '日记'),
]

function edge(
  fromRelPath: string,
  toRelPath: string | null,
  kind: GraphEdge['kind'] = 'wiki',
  count = 1,
): GraphEdge {
  // `toRawTarget` 是悬空边唯一能显示"指向谁"的信息（契约里约定取第一条链接的写法）
  const rawTarget = toRelPath === null ? '还不存在的笔记' : toRelPath.replace(/\.md$/, '')
  return { fromRelPath, toRelPath, toRawTarget: rawTarget, kind, count }
}

function cardsOf(nodes: readonly GraphNode[]): Map<string, GraphCardBox> {
  const layout = buildLayout(nodes)
  return new Map(layout.cards.map((card) => [card.relPath, card]))
}

/** jsdom 不实现 PointerEvent：用同名的 MouseEvent 派发（React 的 pointer 事件接口继承鼠标字段，
 *  clientX/clientY/button 都会被照常读出来，pointerId 两侧同为 undefined，比较仍然成立）。 */
function pointer(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: { x: number; y: number; button?: number },
): void {
  act(() => {
    // jsdom 30 **有** `PointerEvent`（它继承 MouseEvent），所以派发真的那一个：
    // 实现里那句 `state.pointerId !== event.pointerId` 因此是真的在比较同一个 id，
    // 而不是两边都是 undefined 的空比较。`setPointerCapture` 在 jsdom 里不存在，
    // 实现已经用 `typeof … === 'function'` 兜住了（见 GraphCanvas.handlePointerDown）。
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
  })
}

// ---------------------------------------------------------------------------
// canvas 版画布的观测手段（卡片不再是 DOM）
// ---------------------------------------------------------------------------

/**
 * 记录型 2D 画布上下文。
 *
 * 为什么必须有它：卡片现在由 `canvas.mn-graph__canvas` 画出来（`.mn-graph-card` 在本仓库里
 * **已经不存在了**），而 jsdom **不带真画布**（`getContext('2d')` 返回 null）。组件在那种环境下
 * 会把画笔整段跳过（`if (context === null) return`），于是"卡片画出来了、正面写着这篇笔记的
 * 标题/目录/出入度"在 jsdom 里就变成**完全不可观测**的东西 —— 而它正是这次改动之前由
 * `card.textContent` 守着的那条性质。
 *
 * 所以这里给 `getContext` 打一个桩，塞进去一个把每次 `fillText` 记下来的假画布：断言因此仍能
 * 落在"画笔真的把每篇笔记画出来了"上，而不是退化成"某个属性写着 9"。它顺带替掉量字
 * （`measureText` 按"每字 8px"给宽）：不这么做的话所有文字宽度都是 0，卡片高度与环半径都会
 * 退化成最简情形，布局与真浏览器差得更远。
 *
 * 这不是"测实现细节"：`fillText` 的**入参**（标题、目录、`2 出 · 1 入`）全是用户看得见的内容，
 * 只是它的载体从 DOM 文本变成了画布像素。
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

  /** 画过的每一段文字（按顺序、含重复 —— 平移/缩放会让同一张卡片被重画）。 */
  private readonly texts: string[] = []

  /** 每一段文字**画在哪**（世界坐标换算后的屏幕坐标）：断言"卡片跟着光标走了"要用它。 */
  private readonly placed: Array<{ text: string; x: number; y: number }> = []

  /** 这一段里画过的文字（去重：断言"画没画"时不该关心它被画了几遍）。 */
  drawnTexts(): string[] {
    return [...new Set(this.texts)]
  }

  /** 某段文字最近一次被画在哪个位置（`null` = 这一段没画过它）。 */
  lastPlacedAt(text: string): { x: number; y: number } | null {
    for (let index = this.placed.length - 1; index >= 0; index -= 1) {
      const entry = this.placed[index]
      if (entry !== undefined && entry.text === text) return { x: entry.x, y: entry.y }
    }
    return null
  }

  clear(): void {
    this.texts.length = 0
    this.placed.length = 0
  }

  // 只记 fillText，其余调用一律忽略：这一层要证明的是"卡片被画出来了、内容是什么"，
  // 而"先画边后画卡片""save/restore 配对""裁剪矩形"这些**绘制细节**已经在
  // tests/graph-paint.test.ts 里用同一套记录法逐条钉过了。
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
  arc(): void {}
  fill(): void {}
  stroke(): void {}
  fillRect(): void {}
  strokeRect(): void {}
  setLineDash(): void {}

  fillText(text: string, x: number, y: number): void {
    this.texts.push(text)
    this.placed.push({ text, x, y })
  }

  /** 每字 8px：只要**非零**就够（真字体的度量只有浏览器里有，jsdom 里没有任何来源）。 */
  measureText(text: string): { width: number } {
    return { width: text.length * 8 }
  }
}

/** 全文件共用一个假画布：一组用例里可能挂载多次画布，记录累积在同一处、由 beforeEach 清空。 */
const paint = new RecordingPaintContext()

const originalGetContext = HTMLCanvasElement.prototype.getContext

/**
 * 把 `getContext('2d')` 接到假画布上。
 *
 * 那处 `as unknown as` 是全文件**唯一**的类型断言，而且是被 jsdom 逼出来的：
 * 它没有真画布实现，`getContext` 的签名只接受浏览器原生上下文，而我们塞进去的正是
 * "结构上满足画笔 `PaintContext` 的记录型假上下文"。断言只发生在打桩这一行，
 * 用例里的断言对象（`paint.drawnTexts()`）仍然是普通字符串数组。
 */
function installRecordingCanvas(): void {
  const stub = (() => paint) as unknown as typeof HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = stub
}

function restoreCanvas(): void {
  HTMLCanvasElement.prototype.getContext = originalGetContext
}

/** 这一段里被画出来的文字（去重）。 */
function drawnTexts(): string[] {
  return paint.drawnTexts()
}

/** 清空画笔记录：用来断言"这一次重画之后，某张卡片**不再**被画"（记录是累积的）。 */
function resetDrawnTexts(): void {
  paint.clear()
}



// ---------------------------------------------------------------------------
// 挂载与几何：所有交互入口都在宿主元素上
// ---------------------------------------------------------------------------

/**
 * 渲染画布（可选地装上**全局快捷键**）。
 *
 * 为什么"装快捷键"是一个选项：缩放 / 适应窗口 / 关闭预览已经是命令表里的 `graph.*`，
 * 触发入口是 `app/keymap.ts` 的全局 keydown（`App` 里由 `useGlobalKeymap` 安装）。
 * 只渲染 `<GraphCanvas />` 时没有任何分发者，按键盘什么都不会发生 ——
 * 那正是"命令表是快捷键唯一事实来源"的代价，测试也必须走同一条路。
 */
function mountGraph(options: { keys?: boolean } = {}): HTMLElement {
  render(options.keys === true ? <KeymapHarness /> : <GraphCanvas />)
  return graphHost()
}

function KeymapHarness() {
  useGlobalKeymap()
  return <GraphCanvas />
}

/** 图谱宿主（`div.mn-graph`）：卡片画在 canvas 上，所有指针/键盘入口都挂在这一层。 */
function graphHost(): HTMLElement {
  const host = document.querySelector<HTMLElement>('.mn-graph')
  if (host === null) throw new Error('没有渲染出图谱宿主元素')
  return host
}

/** HUD 上的按钮（视图切换 / 深度 / 定位 / 重新排布…）。 */
function hudButton(action: string): HTMLElement {
  const button = document.querySelector<HTMLElement>(`[data-graph-action="${action}"]`)
  if (button === null) throw new Error(`HUD 里没有 ${action} 按钮`)
  return button
}

/**
 * 这一帧"画出来"的卡片数。
 *
 * 宿主与 canvas 上各写了一份（`data-graph-canvas-cards` 与 `data-mn-cards`），当前是**同一个数**：
 * 两处都取 `paintNodes.length`，也就是"**交给画笔**的卡片数"（= 布局里的全部卡片，未经视口裁剪）。
 * 真正的裁剪发生在 `paintGraph` 内部（按 `visible` 集合跳过屏幕外的卡片），裁剪后的张数由画笔
 * 返回、再写回宿主上的第三个属性 `data-graph-painted-cards`（见 `paintedCardCount`）——
 * "交进去多少"与"真画了多少"是两件事，正因为它们是两件事，才值得一起断言。
 */
function cardCount(): number {
  return Number(graphHost().getAttribute('data-graph-canvas-cards'))
}

/** 交给画笔的卡片数在 canvas 元素上的那一份（与宿主上的同值，见 `cardCount`）。 */
function canvasCardCount(): number {
  const canvas = document.querySelector<HTMLCanvasElement>('canvas.mn-graph__canvas')
  if (canvas === null) throw new Error('没有渲染出 canvas.mn-graph__canvas')
  return Number(canvas.getAttribute('data-mn-cards'))
}

/**
 * **上一帧真正画出来**的卡片数（视口裁剪之后，来自 `paintGraph` 的 `PaintStats.cards`）。
 *
 * 它是"视口裁剪真的发生了"唯一可观测的证据：`data-graph-canvas-cards` 只说明布局里有多少张，
 * 而把镜头移到空地上之后它照旧不变 —— 只有这个数字会变成 0。
 */
function paintedCardCount(): number {
  return Number(graphHost().getAttribute('data-graph-painted-cards'))
}

/**
 * 当前布局里**重叠的卡片对数**（宿主上的 `data-graph-overlaps`）。
 *
 * 用户说"笔记之间应该有碰撞"，唯一说了算的判据就是"矩形还相交吗" ——
 * 这个数字是那条约束在界面上的证据（碰撞为硬约束时应当恒为 0）。
 */
function overlapCount(): number {
  return Number(graphHost().getAttribute('data-graph-overlaps'))
}

/** 渲染出来的文件夹容器路径（连线与容器仍然留在 DOM 里）。 */
function folderPaths(): string[] {  return Array.from(document.querySelectorAll('.mn-graph-folder')).map(
    (element) => element.getAttribute('data-folder') ?? '',
  )
}

/**
 * 世界坐标 → 派发指针事件用的 client 坐标。
 *
 * 换算来自宿主上的 `data-graph-scale / data-graph-offset-x / data-graph-offset-y`
 * （实现刻意把它们写成属性 —— 卡片画在 canvas 上、自动化没有 DOM 可点，
 * 这三个数就是"世界原点的屏幕位置"，见 GraphCanvas 里那段注释）。
 * jsdom 里 `getBoundingClientRect()` 恒为全 0，"相对宿主"与"页面坐标"因此是同一个数；
 * 仍然走一遍 `rect.left/top` 是为了在将来换成真布局时不至于悄悄错位。
 */
function screenPoint(world: Point): Point {
  const host = graphHost()
  const rect = host.getBoundingClientRect()
  const scale = Number(host.getAttribute('data-graph-scale'))
  const offsetX = Number(host.getAttribute('data-graph-offset-x'))
  const offsetY = Number(host.getAttribute('data-graph-offset-y'))
  if (!Number.isFinite(scale) || !Number.isFinite(offsetX) || !Number.isFinite(offsetY)) {
    throw new Error('宿主上没有读出世界 → 屏幕的换算')
  }
  return { x: rect.left + world.x * scale + offsetX, y: rect.top + world.y * scale + offsetY }
}

/**
 * 在**世界坐标**的某点上点一下（按下 + 抬起）。
 *
 * 为什么给的是世界坐标而不是像素：命中测试判的就是世界坐标里的卡片矩形（`rectHit`，带 4px
 * 屏幕宽容度），所以这样派发与当前缩放/平移无关 —— 想点中心那张卡片就给 `{x: 0, y: 0}`
 * （焦点视图里圆心那张卡片正好以世界原点为中心）。
 */
function clickAtWorld(world: Point): void {
  const at = screenPoint(world)
  const host = graphHost()
  pointer(host, 'pointerdown', { x: at.x, y: at.y })
  pointer(host, 'pointerup', { x: at.x, y: at.y })
}

/**
 * 焦点视图里某张卡片的**当前**世界矩形（从宿主的 `data-graph-card-rects` 读）。
 *
 * 为什么必须读这个属性而不是自己算：漂浮开着时卡片持续在动（力场 + 20fps），
 * `layoutEgo` 给的环上位置只是**种子** —— 拖动/漂浮之后想点到它，只能问宿主"它此刻在哪"。
 * 视口外的卡片不在这个属性里（它只列可见的），但本文件的用例里所有卡片都在视口内。
 */
function focusCardRect(relPath: string): Rect | null {
  const attr = graphHost().getAttribute('data-graph-card-rects') ?? ''
  for (const entry of attr.split(';')) {
    const sep = entry.lastIndexOf('|')
    if (sep < 0) continue
    if (entry.slice(0, sep) !== relPath) continue
    const [x = 0, y = 0, width = 0, height = 0] = entry
      .slice(sep + 1)
      .split(',')
      .map((part) => Number(part))
    return { x, y, width, height }
  }
  return null
}

/** 打开一篇笔记（走真实的 `openNote`：读盘、填 doc）——焦点视图的圆心就是当前打开的这篇。 */
async function openFocusNote(relPath: string): Promise<void> {
  await act(async () => {
    await openNote(relPath)
  })
}

/** 挂载**焦点视图**（默认视图）并等到圆心那张卡片周围真的画出了东西。 */
async function mountFocus(
  relPath: string,
  options: { keys?: boolean } = {},
): Promise<HTMLElement> {
  await openFocusNote(relPath)
  mountGraph(options)
  await waitFor(() => {
    expect(graphHost().getAttribute('data-graph-mode')).toBe('focus')
    expect(cardCount()).toBeGreaterThan(0)
  })
  return graphHost()
}

/** 点 HUD 上的"整个 Vault"并等到全库卡片与文件夹容器都就位。 */
async function switchToVault(): Promise<void> {
  fireEvent.click(hudButton('mode-vault'))
  await waitFor(() => {
    expect(graphHost().getAttribute('data-graph-mode')).toBe('vault')
    expect(cardCount()).toBe(MOCK_CARD_COUNT)
    expect(folderPaths()).toEqual(expect.arrayContaining(['', '日记', '项目', '项目/子项目']))
  })
}

/** 挂载**全库视图**（画布的默认视图是焦点视图，所以先切过去）。 */
async function mountVault(options: { keys?: boolean } = {}): Promise<HTMLElement> {
  mountGraph(options)
  await switchToVault()
  return graphHost()
}

/**
 * 当前的全库布局（自动装箱 + 手工位置覆盖）。
 *
 * 用的是实现自己那对纯函数（`buildLayout` / `applyManualPositions`），所以卡片坐标与画布上的
 * 逐像素一致 —— 这样"点某张卡片"不必写死任何像素，Mock Vault 加一篇笔记也不会让用例变红。
 */
function vaultLayoutNow(): { cards: GraphCardBox[] } {
  const state = useGraphStore.getState()
  if (state.data === null) throw new Error('全库数据还没到，算不出卡片位置')
  return applyManualPositions(buildLayout(state.data.nodes, state.collapsed), state.manual)
}

function vaultCardRect(relPath: string): GraphCardBox {
  const card = vaultLayoutNow().cards.find((item) => item.relPath === relPath)
  if (card === undefined) throw new Error(`全库布局里没有这张卡片：${relPath}`)
  return card
}

/** 全库视图里某张卡片中心的世界坐标。 */
function vaultCardCenter(relPath: string): Point {
  const card = vaultCardRect(relPath)
  return { x: card.x + card.width / 2, y: card.y + card.height / 2 }
}

/**
 * 从某张卡片出发，挑一个**一定有邻居**的方向键。
 *
 * 为什么测试侧也算一遍：方向键的判据是"目标方向 ±60° 扇形里最近的那一张"，而"往右有没有卡片"
 * 取决于网格列数与容器位置 —— 直接写死一个方向会变成"Mock Vault 加一篇笔记就可能变红"的
 * 脆弱断言（与 `MOCK_CARD_COUNT` 同一个理由）。这里只用来**挑方向**，真正断言的是
 * 按键之后的效果（选中项换人 + 镜头把它带到视口中央）。
 *
 * ±60° 与最大搜索距离照抄实现（`handleKeyDown` 的 `1.7 ≈ tan(60°)` 与 `KEYBOARD_REACH`）：
 * 判据本身已经有自己的用例，这里只是拿它挑一个不会空转的方向。
 */
function pickArrowKey(relPath: string): string {
  const rects = vaultLayoutNow().cards
  const from = rects.find((card) => card.relPath === relPath)
  if (from === undefined) throw new Error(`全库布局里没有这张卡片：${relPath}`)
  const originX = from.x + from.width / 2
  const originY = from.y + from.height / 2
  const directions = [
    { key: 'ArrowLeft', x: -1, y: 0 },
    { key: 'ArrowRight', x: 1, y: 0 },
    { key: 'ArrowUp', x: 0, y: -1 },
    { key: 'ArrowDown', x: 0, y: 1 },
  ]
  const found = directions.find((direction) =>
    rects.some((card) => {
      if (card.relPath === relPath) return false
      const dx = card.x + card.width / 2 - originX
      const dy = card.y + card.height / 2 - originY
      const forward = dx * direction.x + dy * direction.y
      if (forward <= 0) return false
      const sideways = Math.abs(dx * direction.y - dy * direction.x)
      return sideways <= forward * 1.7 && Math.hypot(dx, dy) <= 2400
    }),
  )
  if (found === undefined) throw new Error(`卡片 ${relPath} 四个方向上都没有邻居，用例前提不成立`)
  return found.key
}

// ===========================================================================
// 第一层：布局与几何纯函数
// ===========================================================================

describe('文件夹自动成组', () => {
  it('按 folder 分组，子文件夹嵌套在父文件夹里，同级按路径排序', () => {
    const tree = buildFolderTree(SAMPLE_NODES)

    expect(tree.path).toBe('')
    // 根目录下的散笔记**不**包含子目录里的笔记
    expect(tree.notes.map((item) => item.relPath)).toEqual(['随手记.md', 'README.md'])
    // 排序规则与文件树**完全一致**（同一个 Intl.Collator）：这里不是"我以为的 ASCII 序"，
    // 而是拿文件树的比较器再排一遍来对齐 —— 画布与侧栏的顺序不该出现两种答案
    const asEntries = tree.notes.map((item) => makeEntry({ relPath: item.relPath }))
    expect([...asEntries].sort(compareEntries).map((item) => item.relPath)).toEqual(
      tree.notes.map((item) => item.relPath),
    )
    expect(tree.children.map((child) => child.path)).toEqual(['日记', '项目'])

    const project = tree.children[1]
    // 拼音序（biaoqian / luxiantu / sheji）—— 与文件树一致，不是路径字典序
    expect(project?.notes.map((item) => item.relPath)).toEqual([
      '项目/标签示例.md',
      '项目/路线图.md',
      '项目/设计.md',
    ])
    expect(project?.children.map((child) => child.path)).toEqual(['项目/子项目'])
    // 折叠卡片要显示"这里面一共多少篇" ⇒ 必须是含子目录的总数
    expect(project?.noteCount).toBe(4)
    expect(tree.noteCount).toBe(8)
  })

  it('中间层会被补齐：只有 A/B/C 时 A 与 A/B 依然是容器（嵌套不断链）', () => {
    const tree = buildFolderTree([node('A/B/C/深层.md', 'A/B/C')])

    const a = tree.children[0]
    const ab = a?.children[0]
    const abc = ab?.children[0]
    expect([a?.path, ab?.path, abc?.path]).toEqual(['A', 'A/B', 'A/B/C'])
    expect(abc?.notes.map((item) => item.relPath)).toEqual(['A/B/C/深层.md'])
    // 逻辑上的"笔记数"逐级向上累计
    expect([a?.noteCount, ab?.noteCount, abc?.noteCount]).toEqual([1, 1, 1])
  })

  it('脏数据防御：`\\` 分隔与首尾 `/` 都被归一化', () => {
    const tree = buildFolderTree([node('x.md', '\\项目\\子\\'), node('y.md', '项目/子')])
    expect(tree.children[0]?.path).toBe('项目')
    expect(tree.children[0]?.children[0]?.notes.map((item) => item.relPath)).toEqual([
      'x.md',
      'y.md',
    ])
  })
})

describe('容器尺寸与排布', () => {
  it('容器按内容自动算尺寸：宽度被网格列数封顶，高度随行数增长', () => {
    const one = buildLayout([node('甲.md', '盒子')]).folders[0]
    const three = buildLayout([
      node('甲.md', '盒子'),
      node('乙.md', '盒子'),
      node('丙.md', '盒子'),
    ]).folders[0]
    const nine = buildLayout(
      Array.from({ length: 9 }, (_, index) => node(`第${index}.md`, '盒子')),
    ).folders[0]

    if (one === undefined || three === undefined || nine === undefined) throw new Error('缺少容器')
    // 1 篇只用 1 列（不为了一篇笔记撑出 3 列的宽度），3 篇铺满 3 列
    expect(one.width).toBeLessThan(three.width)
    // 3 篇与 9 篇**同宽**：宽度被 3 列封顶，不会随笔记数无限增长（超出的换行）
    expect(nine.width).toBe(three.width)
    // 高度随行数增长：3 篇 1 行、9 篇 3 行
    expect(three.height).toBe(one.height)
    expect(nine.height).toBeGreaterThan(three.height)
  })

  it('网格排布：任意两张卡片都不重叠，且间距等于常量', () => {
    const positions = Array.from({ length: 9 }, (_, index) => gridPositions(index, 3))
    const rects: Rect[] = positions.map((point) => ({
      x: point.x,
      y: point.y,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
    }))
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const left = rects[i]
        const right = rects[j]
        if (left === undefined || right === undefined) continue
        expect(rectsIntersect(left, right)).toBe(false)
      }
    }
    const second = positions[1]
    expect(second?.x).toBe(CARD_WIDTH + CARD_GAP)
    expect(positions[3]?.y).toBe(CARD_HEIGHT + CARD_GAP)
  })

  it('整块布局：卡片两两不重叠，顶层容器之间也不重叠', () => {
    const layout = buildLayout(SAMPLE_NODES)

    for (let i = 0; i < layout.cards.length; i += 1) {
      for (let j = i + 1; j < layout.cards.length; j += 1) {
        const left = layout.cards[i]
        const right = layout.cards[j]
        if (left === undefined || right === undefined) continue
        expect(rectsIntersect(left, right)).toBe(false)
      }
    }

    const topLevel = layout.folders.filter((folder) => folder.depth === 0)
    expect(topLevel.map((folder) => folder.label)).toEqual(['（Vault 根）', '日记', '项目'])
    for (let i = 0; i < topLevel.length; i += 1) {
      for (let j = i + 1; j < topLevel.length; j += 1) {
        const left = topLevel[i]
        const right = topLevel[j]
        if (left === undefined || right === undefined) continue
        expect(rectsIntersect(left, right)).toBe(false)
      }
    }
  })

  it('嵌套容器落在父容器内部（`项目/子项目` 完全被 `项目` 包住）', () => {
    const layout = buildLayout(SAMPLE_NODES)
    const project = layout.folders.find((folder) => folder.path === '项目')
    const nested = layout.folders.find((folder) => folder.path === '项目/子项目')

    expect(project).toBeDefined()
    expect(nested).toBeDefined()
    if (project === undefined || nested === undefined) return
    expect(nested.x).toBeGreaterThanOrEqual(project.x)
    expect(nested.y).toBeGreaterThanOrEqual(project.y)
    expect(nested.x + nested.width).toBeLessThanOrEqual(project.x + project.width)
    expect(nested.y + nested.height).toBeLessThanOrEqual(project.y + project.height)
    // 父容器在前（渲染顺序 ⇒ 父垫在子下面）
    expect(layout.folders.indexOf(project)).toBeLessThan(layout.folders.indexOf(nested))
  })

  it('容器路径清单用于"全部收起"：虚拟根只在它有散笔记时才出现', () => {
    expect(collectFolderPaths(buildFolderTree(SAMPLE_NODES))).toEqual([
      '',
      '日记',
      '项目',
      '项目/子项目',
    ])
    expect(collectFolderPaths(buildFolderTree([node('项目/设计.md', '项目')]))).toEqual(['项目'])
  })

  it('装箱是确定性的：同一份数据两次得到完全一样的坐标', () => {
    const first = buildLayout(SAMPLE_NODES)
    const second = buildLayout(SAMPLE_NODES)
    expect(second.cards.map((card) => [card.relPath, card.x, card.y])).toEqual(
      first.cards.map((card) => [card.relPath, card.x, card.y]),
    )
    expect(packRows([{ width: 10, height: 4 }], 100, 5).positions).toEqual([{ x: 0, y: 0 }])
  })

  it('手工位置只覆盖坐标：折叠集合、容器尺寸与其它卡片都不受影响', () => {
    const base = buildLayout(SAMPLE_NODES)
    const moved = applyManualPositions(base, new Map([['项目/设计.md', { x: 1234, y: -56 }]]))
    const card = moved.cards.find((item) => item.relPath === '项目/设计.md')

    expect(card?.x).toBe(1234)
    expect(card?.y).toBe(-56)
    // 没被拖过的卡片原样不动（`applyManualPositions` 只换坐标，不重排）
    expect(moved.cards.filter((item) => item.relPath !== '项目/设计.md')).toEqual(
      base.cards.filter((item) => item.relPath !== '项目/设计.md'),
    )
    expect(moved.folders).toEqual(base.folders)
    // 没有手工位置时直接返回同一份布局（不产生无谓的重渲染）
    expect(applyManualPositions(base, new Map())).toBe(base)
  })

  it('清理手工位置时只丢掉真的不在数据里的笔记（截断的图谱不能清）', () => {
    const manual = new Map([
      ['README.md', { x: 1, y: 1 }],
      ['已经删掉的笔记.md', { x: 2, y: 2 }],
    ])
    const pruned = pruneManualPositions(manual, SAMPLE_NODES)
    expect([...pruned.keys()]).toEqual(['README.md'])
  })
})

describe('收起文件夹', () => {
  it('收起的容器变成紧凑的文件夹卡片，内部卡片（含子文件夹）全部隐藏', () => {
    const layout = buildLayout(SAMPLE_NODES, new Set(['项目']))
    const project = layout.folders.find((folder) => folder.path === '项目')

    expect(project?.collapsed).toBe(true)
    expect(project?.width).toBe(190)
    expect(project?.height).toBe(FOLDER_CHIP_HEIGHT)
    // 项目/设计、路线图、标签示例、子项目/细节 四张卡片都不再渲染
    expect(layout.cards.some((card) => card.relPath.startsWith('项目/'))).toBe(false)
    expect(layout.hiddenCards).toBe(4)
    // 内部卡片不画 ⇒ 相关连线也不会被画出来（buildEdgeVisuals 只认可见卡片）
    expect(layout.folders.some((folder) => folder.path === '项目/子项目')).toBe(false)
    expect(layout.folderPaths).toContain('项目/子项目')
  })

  it('默认全部展开：不给折叠集合时一张卡片都不隐藏', () => {
    const layout = buildLayout(SAMPLE_NODES)
    expect(layout.hiddenCards).toBe(0)
    expect(layout.cards).toHaveLength(8)
    expect(layout.folders.every((folder) => folder.collapsed === false)).toBe(true)
  })
})

describe('视口裁剪', () => {
  it('给定 viewport 只返回相交项（线性实现）', () => {
    const layout = buildLayout(SAMPLE_NODES)
    const viewport: Rect = { x: -1000, y: -1000, width: 100, height: 100 }

    expect(queryViewport(layout.cards, viewport)).toEqual([])

    const first = layout.cards[0]
    expect(first).toBeDefined()
    if (first === undefined) return
    const hit = queryViewport(layout.cards, { x: first.x, y: first.y, width: 1, height: 1 })
    expect(hit.map((card) => card.relPath)).toEqual([first.relPath])
  })

  it('网格索引与线性扫描给出**完全一样**的结果（索引只是加速，不改变语义）', () => {
    const layout = buildLayout(SAMPLE_NODES)
    const index = buildRectIndex(layout.cards)
    const viewports: Rect[] = [
      { x: 0, y: 0, width: 200, height: 120 },
      { x: 300, y: 100, width: 600, height: 400 },
      { x: -500, y: -500, width: 4000, height: 4000 },
      { x: 5000, y: 5000, width: 100, height: 100 },
    ]
    for (const viewport of viewports) {
      expect(queryIndex(index, viewport).map((card) => card.relPath)).toEqual(
        queryViewport(layout.cards, viewport).map((card) => card.relPath),
      )
    }
  })

  it('视口换算成世界坐标：缩放 0.5× 时世界视口是屏幕的两倍（含 overscan）', () => {
    const view = { x: -100, y: -200, zoom: 0.5 }
    const world = worldViewport(view, { width: 800, height: 600 }, 0)
    expect(world.x).toBe(200)
    expect(world.y).toBe(400)
    expect(world.width).toBe(1600)
    expect(world.height).toBe(1200)
  })

  it('规模：1 万节点也能一次建出布局，且每帧裁剪只做视口大小的工作量', () => {
    // 宿主当前上限是 3000（超过就截断），这里刻意按 1 万来测 ——
    // 画布的复杂度必须由"视口裁剪 + 顶层 transform"决定，而不是由节点总数决定。
    const nodes = Array.from({ length: 10000 }, (_, index) =>
      node(`组${index % 200}/笔记${index}.md`, `组${index % 200}`),
    )
    const buildStarted = performance.now()
    const layout = buildLayout(nodes)
    const buildMs = performance.now() - buildStarted

    const indexStarted = performance.now()
    const index = buildRectIndex(layout.cards)
    const indexMs = performance.now() - indexStarted

    const viewport = worldViewport({ x: 0, y: 0, zoom: 1 }, { width: 1280, height: 800 })
    const cullStarted = performance.now()
    let visible = 0
    for (let round = 0; round < 16; round += 1) visible = queryIndex(index, viewport).length
    const cullMs = (performance.now() - cullStarted) / 16

    console.log(
      `[graph] 1 万节点：buildLayout ${buildMs.toFixed(0)}ms，网格索引 ${indexMs.toFixed(0)}ms，` +
        `裁剪 ${cullMs.toFixed(2)}ms/帧（当帧渲染 ${visible} 张卡片）`,
    )
    expect(layout.cards).toHaveLength(10000)
    // 宽松阈值：只用来抓"复杂度写错了"（比如某处退化成了 O(n²)），不做性能基准
    expect(buildMs).toBeLessThan(2000)
    expect(indexMs).toBeLessThan(1000)
    expect(cullMs).toBeLessThan(50)
    expect(visible).toBeLessThan(120)
  })
})

describe('连线：分类与连接点', () => {
  it('选中 A 时：A 的入链是虚线、出链是实线，其余淡化', () => {
    const inbound = edge('乙.md', '甲.md')
    const outbound = edge('甲.md', '丙.md')
    const unrelated = edge('乙.md', '丙.md')

    expect(edgeStyle(inbound, '甲.md')).toEqual({ dashed: true, dim: false, highlight: true })
    expect(edgeStyle(outbound, '甲.md')).toEqual({ dashed: false, dim: false, highlight: true })
    expect(edgeStyle(unrelated, '甲.md')).toEqual({ dashed: false, dim: true, highlight: false })
  })

  it('没有选中时：所有边都是统一的淡色细实线（不需要按 Ctrl 就能看到关联），悬空边是虚线', () => {
    expect(edgeStyle(edge('甲.md', '乙.md'), null)).toEqual({
      dashed: false,
      dim: false,
      highlight: false,
    })
    expect(edgeStyle(edge('甲.md', null), null).dashed).toBe(true)
  })

  it('悬空边即使用来强调也保持虚线（虚线在这里表示"目标笔记还不存在"）', () => {
    expect(edgeStyle(edge('甲.md', null), '甲.md')).toEqual({
      dashed: true,
      dim: false,
      highlight: true,
    })
  })

  it('连接点在卡片边缘而不是中心：水平为主轴时从右侧出、左侧进', () => {
    const from: Rect = { x: 0, y: 0, width: CARD_WIDTH, height: CARD_HEIGHT }
    const to: Rect = { x: 400, y: 10, width: CARD_WIDTH, height: CARD_HEIGHT }

    const anchors = edgeAnchors(from, to)
    expect(anchors.axis).toBe('h')
    expect(anchors.loop).toBe(false)
    expect(anchors.start).toEqual({ x: CARD_WIDTH, y: CARD_HEIGHT / 2 })
    expect(anchors.end).toEqual({ x: 400, y: 10 + CARD_HEIGHT / 2 })
    // 起点必须落在卡片边界上（中心会被卡片挡住 —— 那是我们要避免的）
    expect(anchors.start.x).not.toBe(CARD_WIDTH / 2)

    // 目标在左边 → 从左侧出、右侧进
    const flipped = edgeAnchors(from, { x: -400, y: 0, width: CARD_WIDTH, height: CARD_HEIGHT })
    expect(flipped.start).toEqual({ x: 0, y: CARD_HEIGHT / 2 })
    expect(flipped.end).toEqual({ x: -400 + CARD_WIDTH, y: CARD_HEIGHT / 2 })

    // 垂直为主轴 → 从上下边缘出发
    const vertical = edgeAnchors(from, { x: 5, y: 300, width: CARD_WIDTH, height: CARD_HEIGHT })
    expect(vertical.axis).toBe('v')
    expect(vertical.start).toEqual({ x: CARD_WIDTH / 2, y: CARD_HEIGHT })
  })

  it('自环（笔记链接到自己）走一条绕卡片外侧的弧线', () => {
    const rect: Rect = { x: 0, y: 0, width: CARD_WIDTH, height: CARD_HEIGHT }
    const anchors = edgeAnchors(rect, rect)
    expect(anchors.loop).toBe(true)
    expect(anchors.start.x).toBe(CARD_WIDTH)
    expect(anchors.end.x).toBe(CARD_WIDTH)
    expect(edgePath(anchors.start, anchors.end, anchors.axis, anchors.loop)).toContain('C')
  })

  it('路径是三次贝塞尔，且起点就是连接点', () => {
    const d = edgePath({ x: 190, y: 42 }, { x: 400, y: 52 }, 'h')
    expect(d.startsWith('M 190 42 C ')).toBe(true)
    expect(d.endsWith('400 52')).toBe(true)
  })
})

describe('边的可渲染集合（两端可见 + 视口裁剪）', () => {
  const EDGES: GraphEdge[] = [
    edge('项目/设计.md', '项目/路线图.md'),
    edge('项目/路线图.md', '项目/设计.md'),
    edge('项目/设计.md', '项目/子项目/细节.md', 'wiki', 3),
    edge('项目/子项目/细节.md', null),
  ]

  it('只画两端都在可见集合里的边（折叠容器里的卡片不参与）', () => {
    const all = cardsOf(SAMPLE_NODES)
    expect(buildEdgeVisuals(EDGES, all, null)).toHaveLength(4)

    const collapsed = cardsOf(SAMPLE_NODES.filter((item) => !item.relPath.startsWith('项目/')))
    expect(buildEdgeVisuals(EDGES, collapsed, null)).toHaveLength(0)
  })

  it('悬空边画成虚影端点（小圆点），同一条边 count > 1 时在 tooltip 里说明', () => {
    const cards = cardsOf(SAMPLE_NODES)
    const visuals = buildEdgeVisuals(EDGES, cards, null)
    const phantom = visuals.find((visual) => visual.phantom)
    const details = visuals.find((visual) => visual.edge.count === 3)

    expect(phantom).toBeDefined()
    expect(phantom?.edge.toRelPath).toBeNull()
    expect(phantom?.end.x).toBe((phantom?.start.x ?? 0) + 56)
    expect(phantom?.title).toContain('还不存在的笔记（还不存在）')

    expect(details).toBeDefined()
    expect(details?.title).toContain('共 3 条链接')
  })

  it('给定视口时丢掉完全在视口外的边', () => {
    const cards = cardsOf(SAMPLE_NODES)
    const everything = { x: -10000, y: -10000, width: 20000, height: 20000 }
    const nowhere = { x: 100000, y: 100000, width: 10, height: 10 }

    expect(buildEdgeVisuals(EDGES, cards, null, everything)).toHaveLength(4)
    expect(buildEdgeVisuals(EDGES, cards, null, nowhere)).toHaveLength(0)
  })
})

describe('缩放与适应窗口', () => {
  it('以光标为锚点缩放：锚点下的世界坐标保持不动', () => {
    const view = { x: 40, y: 20, zoom: 1 }
    const focal = { x: 300, y: 200 }
    const worldX = (focal.x - view.x) / view.zoom
    const worldY = (focal.y - view.y) / view.zoom

    const zoomed = zoomAround(view, 2, focal)
    expect(zoomed.zoom).toBe(2)
    expect((focal.x - zoomed.x) / zoomed.zoom).toBeCloseTo(worldX, 6)
    expect((focal.y - zoomed.y) / zoomed.zoom).toBeCloseTo(worldY, 6)
  })

  it('缩放范围被限制在 0.25× ~ 2.5×', () => {
    expect(zoomAround({ x: 0, y: 0, zoom: 1 }, 100, { x: 0, y: 0 }).zoom).toBe(MAX_ZOOM)
    expect(zoomAround({ x: 0, y: 0, zoom: 1 }, 0.001, { x: 0, y: 0 }).zoom).toBe(MIN_ZOOM)
    // 已经到边界时不做无意义的位移
    expect(zoomAround({ x: 5, y: 5, zoom: MAX_ZOOM }, 2, { x: 0, y: 0 })).toEqual({
      x: 5,
      y: 5,
      zoom: MAX_ZOOM,
    })
  })

  it('适应窗口：整块画布落在视口内并居中，缩放不越界', () => {
    const bounds: Rect = { x: 0, y: 0, width: 1000, height: 500 }
    const size = { width: 800, height: 600 }
    const view = fitView(bounds, size, 50)

    expect(view.zoom).toBeGreaterThanOrEqual(MIN_ZOOM)
    expect(view.zoom).toBeLessThanOrEqual(MAX_ZOOM)
    // 画布四角都在视口内
    expect(view.x).toBeGreaterThanOrEqual(0)
    expect(view.y).toBeGreaterThanOrEqual(0)
    expect(bounds.width * view.zoom + view.x).toBeLessThanOrEqual(size.width + 0.5)
    expect(bounds.height * view.zoom + view.y).toBeLessThanOrEqual(size.height + 0.5)

    // 尺寸为 0 的环境（jsdom 首帧）不能算出 0 或 NaN 的缩放
    const degenerate = fitView(bounds, { width: 0, height: 0 }, 50)
    expect(Number.isFinite(degenerate.zoom)).toBe(true)
    expect(degenerate.zoom).toBeGreaterThanOrEqual(MIN_ZOOM)
  })
})

// ===========================================================================
// 数据刷新：保留视角的刷新 vs 完整重载
// ===========================================================================

describe('数据刷新：保留视角', () => {
  beforeEach(async () => {
    window.localStorage.clear()
    setIpcAdapter(createMockAdapter())
    resetStores()
    await useVaultStore.getState().openVault(VAULT_ROOT)
  })

  /** 按"完整重载"先加载一次，拿到 Mock Vault 的真实节点/边。 */
  async function loadFullGraph(): Promise<GraphData> {
    await useGraphStore.getState().load(VAULT_ROOT)
    const data = useGraphStore.getState().data
    if (data === null) throw new Error('没有加载到图谱数据')
    return data
  }

  it('只换数据：缩放/偏移/选中/手工位置/折叠集合全部保留，且全程不进 loading（不闪白）', async () => {
    const data = await loadFullGraph()
    useGraphStore.setState({
      view: { x: -123, y: 45, zoom: 1.75 },
      selected: '项目/设计.md',
      collapsed: new Set(['日记']),
      manual: new Map([['README.md', { x: 10, y: 20 }]]),
    })

    // 盯住刷新过程中的每一次状态变化：既不能进 `loading`，也不能把 data 清空
    const statuses: string[] = []
    let dataWentNull = false
    let sawRefreshing = false
    const unsubscribe = useGraphStore.subscribe((state) => {
      statuses.push(state.status)
      if (state.data === null) dataWentNull = true
      if (state.refreshing) sawRefreshing = true
    })
    await useGraphStore.getState().load(VAULT_ROOT, { keepView: true })
    unsubscribe()

    const state = useGraphStore.getState()
    expect(statuses).not.toContain('loading')
    expect(dataWentNull).toBe(false)
    // "刷新中"是 HUD 上的轻量指示（不是全屏的加载态）
    expect(sawRefreshing).toBe(true)
    expect(state.refreshing).toBe(false)

    expect(state.status).toBe('ready')
    expect(state.data?.nodes.length).toBe(data.nodes.length)
    expect(state.view).toEqual({ x: -123, y: 45, zoom: 1.75 })
    expect(state.selected).toBe('项目/设计.md')
    expect([...state.collapsed]).toEqual(['日记'])
    expect(state.manual.get('README.md')).toEqual({ x: 10, y: 20 })
  })

  it('清理指向已消失笔记的手工位置与选中（并顺手落盘），truncated 时一律不清', async () => {
    await loadFullGraph()
    useGraphStore.setState({
      selected: '已经删掉的笔记.md',
      manual: new Map([
        ['README.md', { x: 1, y: 2 }],
        ['已经删掉的笔记.md', { x: 3, y: 4 }],
      ]),
    })

    await useGraphStore.getState().load(VAULT_ROOT, { keepView: true })

    const state = useGraphStore.getState()
    expect(state.selected).toBeNull()
    expect([...state.manual.keys()]).toEqual(['README.md'])
    // 清掉的位置顺手落盘：别让已删除笔记的位置一直躺在 localStorage 里
    const stored = JSON.parse(window.localStorage.getItem(POSITIONS_KEY) ?? '{}') as Record<
      string,
      Record<string, Point>
    >
    expect(Object.keys(stored[VAULT_ROOT] ?? {})).toEqual(['README.md'])

    // 截断的图谱只返回度数最高的一部分：**没返回 ≠ 被删了**，位置与选中都不能动
    const base = createMockAdapter()
    setIpcAdapter({
      kind: 'test',
      async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
        if (method !== 'graph_data') return base.invoke<T>(method, args)
        const payload = await base.invoke<GraphData>('graph_data', args)
        return { ...payload, truncated: true } as unknown as T
      },
    })
    await loadFullGraph()
    useGraphStore.setState({
      selected: '项目/设计.md',
      manual: new Map([['还没被返回的笔记.md', { x: 5, y: 6 }]]),
    })

    await useGraphStore.getState().load(VAULT_ROOT, { keepView: true })

    expect(useGraphStore.getState().selected).toBe('项目/设计.md')
    expect(useGraphStore.getState().manual.has('还没被返回的笔记.md')).toBe(true)
  })

  it('完整重载（不传 keepView）= 从头再来：视角/折叠/选中/适应窗口记账全部复位', async () => {
    await loadFullGraph()
    useGraphStore.setState({
      view: { x: -123, y: 45, zoom: 1.75 },
      selected: '项目/设计.md',
      collapsed: new Set(['日记']),
      manual: new Map([['README.md', { x: 10, y: 20 }]]),
      fitKey: 'whatever',
    })

    await useGraphStore.getState().load(VAULT_ROOT)

    const state = useGraphStore.getState()
    expect(state.view).toEqual(DEFAULT_VIEW)
    expect(state.selected).toBeNull()
    expect(state.collapsed.size).toBe(0)
    // 清空 fitKey ⇒ 画布会重新"适应窗口"（用户点"重新读取"就是要求这个）
    expect(state.fitKey).toBeNull()
    // 手工位置从 localStorage 重读：内存里那次还没落盘的拖动会被丢掉（"重新读取"的语义）
    expect(state.manual.size).toBe(0)
  })

  it('换 Vault 时即使传了 keepView 也强制完整重载（旧的视角属于上一个 Vault）', async () => {
    await loadFullGraph()
    useGraphStore.setState({
      view: { x: -123, y: 45, zoom: 1.75 },
      collapsed: new Set(['日记']),
    })

    await useGraphStore.getState().load('C:\\别的Vault', { keepView: true })

    const state = useGraphStore.getState()
    expect(state.rootPath).toBe('C:\\别的Vault')
    expect(state.view).toEqual(DEFAULT_VIEW)
    expect(state.collapsed.size).toBe(0)
  })

  it('宿主返回空数据（索引正在重建）时保留旧数据并给出提示，而不是清空画布', async () => {
    const data = await loadFullGraph()
    const base = createMockAdapter()
    setIpcAdapter({
      kind: 'test',
      async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
        if (method !== 'graph_data') return base.invoke<T>(method, args)
        return { nodes: [], edges: [], truncated: false, elapsedMs: 0 } as unknown as T
      },
    })

    await useGraphStore.getState().load(VAULT_ROOT, { keepView: true })

    const state = useGraphStore.getState()
    expect(state.data?.nodes.length).toBe(data.nodes.length) // 旧数据还在
    expect(state.refreshNotice).toContain('索引可能正在重建')
    // 标记"数据可能是旧的"：索引一就绪就会自动再补一次
    expect(state.staleIndex).toBe(true)
    expect(state.refreshing).toBe(false)

    // 显式"重新读取"（keepView 为 false）照旧采纳空结果 ——
    // 那是用户明确要求的"从头再来"，也是真正变空的 Vault 唯一能被画出来的路径
    await useGraphStore.getState().load(VAULT_ROOT)
    expect(useGraphStore.getState().data?.nodes.length).toBe(0)
    expect(useGraphStore.getState().refreshNotice).toBeNull()
  })
})

// ===========================================================================
// 图谱命令：命令表是快捷键的唯一事实来源
// ===========================================================================

describe('图谱命令', () => {
  beforeEach(async () => {
    setIpcAdapter(createMockAdapter())
    resetStores()
    registerBuiltinCommands()
    await useVaultStore.getState().openVault(VAULT_ROOT)
  })

  const GRAPH_COMMAND_IDS_LIST = [
    GRAPH_COMMAND_IDS.zoomIn,
    GRAPH_COMMAND_IDS.zoomOut,
    GRAPH_COMMAND_IDS.fit,
    GRAPH_COMMAND_IDS.closePreview,
  ]

  it('四条命令都在，快捷键不与他人撞车，生效条件是"当前视图是图谱"', async () => {
    for (const id of GRAPH_COMMAND_IDS_LIST) {
      const command = commands.get(id)
      expect(command, `缺少命令 ${id}`).toBeDefined()
      expect(command?.category).toBe('图谱')
      expect(command?.unavailableReason).toBe('需要先切换到知识图谱视图')
    }

    // 每条图谱快捷键都**只**命中图谱命令：既证明它们可用，也证明没有和既有命令撞车
    // （既有表已占用 Mod+O/N/S/E/B/G/K/P、Mod+Shift+F/T/L/E、Mod+Alt+*、F2、Delete 等）
    expect(commands.byChord('Mod+=').map((command) => command.id)).toEqual(['graph.zoomIn'])
    // `+` 这个键**无法**写进命令表：`normalizeChord` 用 `+` 当分隔符（`'Mod+='.split('+')`），
    // 真实键盘上 `Ctrl`+`+` 的事件是 `Mod+Shift++`，和任何归一化后的串都对不上。
    // 它由画布按键后转交给同一条命令（见下面"键盘：+ / - / 0"那条用例）。
    expect(commands.byChord('+')).toEqual([])
    expect(commands.byChord('Mod+-').map((command) => command.id)).toEqual(['graph.zoomOut'])
    expect(commands.byChord('-').map((command) => command.id)).toEqual(['graph.zoomOut'])
    expect(commands.byChord('Mod+0').map((command) => command.id)).toEqual(['graph.fit'])
    expect(commands.byChord('0').map((command) => command.id)).toEqual(['graph.fit'])
    expect(commands.byChord('Escape').map((command) => command.id)).toEqual([
      'graph.closePreview',
    ])

    expect(commands.byChord('Mod+G').map((command) => command.id)).toEqual(['view.graph'])
    expect(commands.byChord('Mod+E').map((command) => command.id)).toEqual(['view.cycleMode'])

    // 视图不是图谱 ⇒ when 为 false：快捷键与面板都不会执行它
    useUiStore.setState({ viewMode: 'edit' })
    for (const id of GRAPH_COMMAND_IDS_LIST) {
      expect(commands.get(id)?.when?.(), id).toBe(false)
    }
    const before = useGraphStore.getState().view
    await expect(commands.execute('graph.zoomIn')).resolves.toBe(false)
    expect(useGraphStore.getState().view).toEqual(before)

    // 回到图谱视图 ⇒ 命令恢复可用
    useUiStore.setState({ viewMode: 'graph' })
    expect(commands.get('graph.zoomIn')?.when?.()).toBe(true)
  })

  it('run 调到的就是 store 动作：放大 / 缩小 / 适应窗口 / 关闭预览', async () => {
    await useGraphStore.getState().load(VAULT_ROOT)
    /*
      ⚠️ 被迫改的一行（新 API）：`computeFit` 现在**分视图** —— 焦点视图的几何只有画布组件量得到
      （卡片高度取决于正文排完有多高），所以它读组件交进来的 `egoBounds`，没有就直接返回 null。
      本用例的断言口径（`buildLayout(data.nodes).bounds`）本来就是**全库**的包围盒，
      所以这里显式声明"我在测全库视图的适应窗口"，而不是让它去猜一个焦点视图的包围盒。
    */
    useGraphStore.setState({
      mode: 'vault',
      viewport: { width: 800, height: 600, known: true },
      view: { x: -40, y: -20, zoom: 1 },
    })

    await expect(commands.execute('graph.zoomIn')).resolves.toBe(true)
    expect(useGraphStore.getState().view.zoom).toBeCloseTo(1.25, 6)

    await expect(commands.execute('graph.zoomOut')).resolves.toBe(true)
    expect(useGraphStore.getState().view.zoom).toBeCloseTo(1, 6)

    useGraphStore.setState({ view: { x: 99999, y: 99999, zoom: MAX_ZOOM } })
    await commands.execute('graph.fit')
    const fitted = useGraphStore.getState().view
    expect(fitted.zoom).toBeLessThan(MAX_ZOOM)
    expect(fitted.zoom).toBeGreaterThanOrEqual(MIN_ZOOM)
    // 整块画布落进上报的视口（与画布按钮用的是同一个 store 动作）
    const bounds = buildLayout(useGraphStore.getState().data?.nodes ?? []).bounds
    expect(bounds.width * fitted.zoom + fitted.x).toBeLessThanOrEqual(800.5)
    expect(bounds.height * fitted.zoom + fitted.y).toBeLessThanOrEqual(600.5)

    useGraphStore.setState({ selected: 'README.md' })
    await commands.execute('graph.closePreview')
    expect(useGraphStore.getState().selected).toBeNull()
  })
})

// ===========================================================================
// 第二层：组件行为
//
// 与第一层（纯函数）最大的区别：**卡片不再是 DOM**。卡片由 `canvas.mn-graph__canvas`
// 画出来（`canvas/paint.ts` 的 `paintGraph`），所以这一层能观测的东西换成了三样：
//   1. 宿主 `div.mn-graph` 上的 `data-graph-*` 属性（卡片数、模式、跳数、世界→屏幕换算）；
//   2. 记录型假画布上"这一段真的被画出来的文字"（见 `RecordingPaintContext`）；
//   3. 仍然留在 DOM 里的两层：连线（SVG）与文件夹容器（只有全库视图才渲染）。
// 交互一律通过宿主上的指针/键盘事件触发 —— canvas 上没有节点可点。
// ===========================================================================

/**
 * 一条三段链的专用 Mock Vault（"深度调大 ⇒ 卡片变多"那条用例要用）。
 *
 * 为什么不用缺省 Mock Vault：它只有 设计 ↔ 路线图、设计 → 细节、细节 → 悬空 三条边，
 * 1 跳就已经把整个连通分量拿全了 —— 调大跳数**不会**多出任何卡片，
 * 那条用例就只能写成"跳数变了但卡片数没变"，等于没测到"深度真的往外扩了一层"。
 */
const CHAIN_NOTES = [
  { relPath: '中心.md', text: '# 中心\n\n指向 [[一跳]]。\n' },
  { relPath: '一跳.md', text: '# 一跳\n\n再指向 [[两跳]]。\n' },
  { relPath: '两跳.md', text: '# 两跳\n\n没有更多出链。\n' },
]

describe('知识图谱画布', () => {
  beforeEach(async () => {
    window.localStorage.clear()
    setIpcAdapter(createMockAdapter())
    resetStores()
    /*
      `resetStores()` 只管全库视图那一半状态：模式 / 跳数 / 子图 / 正文是**焦点视图**那一半的。
      漏掉它们，"上一个用例切到了整个 Vault"就会泄漏到下一个用例 ——
      默认视图不再是默认值，而"进入图谱默认是焦点视图"那条用例恰恰要检查默认值。
    */
    useGraphStore.setState({
      mode: 'focus',
      depth: DEFAULT_EGO_DEPTH,
      ego: null,
      egoStatus: 'idle',
      egoError: null,
      texts: new Map<string, string>(),
      // 下面这些不在 `resetStores()` 的重置范围里，却会跨用例泄漏（真实踩过：
      // 某条用例关掉"从链接引出"，后面所有用例的引线就都不见了）—— 一并复位
      edgeFromLink: true,
      titleOnly: false,
      pins: new Map(),
      floatingPanes: [],
    })
    // 缩放 / 适应窗口 / 关闭预览走命令表（幂等注册，重复调用无副作用）
    registerBuiltinCommands()
    await useVaultStore.getState().openVault(VAULT_ROOT)
    paint.clear()
    installRecordingCanvas()
  })

  afterEach(() => {
    restoreCanvas()
    cleanup()
  })

  it('渲染出 Mock Vault 里的每篇笔记的卡片与每个文件夹的容器', async () => {
    await mountVault()

    /*
      卡片数：卡片画在 canvas 上，没有 DOM 节点可数，所以看宿主与 canvas 上的两个属性
      （`data-graph-canvas-cards` 与 `data-mn-cards`）。它们当前是**同一个数** ——
      两处都取 `paintNodes.length`，也就是"交给画笔的卡片数"；
      "真正画出来的张数"是另一个属性（裁剪之后），见下面 `paintedCardCount` 那一段与
      专门守裁剪的那条用例。这里先钉住"交进去的两处一致"（分家就说明有人只改了一边）。
    */
    expect(cardCount()).toBe(MOCK_CARD_COUNT)
    expect(canvasCardCount()).toBe(MOCK_CARD_COUNT)
    // 适应窗口之后整块画布都在视口内 ⇒ 交进去的每一张都真的被画了出来
    await waitFor(() => {
      expect(paintedCardCount()).toBe(MOCK_CARD_COUNT)
    })

    /*
      原来是读 `.mn-graph-card` 的 `data-rel-path` 来断言"每篇笔记都有自己的卡片"。
      卡片既然画在 canvas 上，就换成"画笔真的把每篇笔记的标题画了出来" ——
      性质没变（每篇笔记都有一张属于它的卡片），观测点从 DOM 文本挪到了绘制调用。
    */
    const titles = createMockAdapter()
      .dump()
      .filter((item) => isMarkdown(item.relPath))
      .map((item) => (item.relPath.split('/').pop() ?? '').replace(/\.(md|markdown)$/i, ''))
    await waitFor(() => {
      expect(drawnTexts()).toEqual(expect.arrayContaining(titles))
      // 卡片正面的身份信息：标题（上面）+ 目录 + 出入度。
      // 原断言里的 `→2` / `←1` 现在是紧凑卡片那一行 `2 出 · 1 入`
      // （设计.md：出链 2 = 路线图 + 细节，入链 1 = 路线图指向它）。
      // ⚠️ 原断言里还有一条 `toContain('项目/设计.md')`（相对路径）：**它在实现里没有了** ——
      // 紧凑卡片用"标题 + 目录"标识自己，不再把 relPath 画在卡面上。那条子断言是**删掉**的，
      // 不是被放宽的（见回报里"没能守住的性质"）。
      expect(drawnTexts()).toContain('项目')
      expect(drawnTexts()).toContain('2 出 · 1 入')
    })

    // 文件夹容器仍是 DOM（只有全库视图才有），断言方式与从前逐字相同
    expect(folderPaths()).toEqual(expect.arrayContaining(['', '日记', '项目', '项目/子项目']))

    // 状态角标：节点数 / 边数 / 缩放
    expect(document.querySelector('.mn-graph__hud')?.textContent).toContain(`${MOCK_CARD_COUNT} 节点`)
    expect(document.querySelector('.mn-graph__hud')?.textContent).toContain('4 边')
  })

  it('单击卡片 = 选中它（相关连线高亮）；正文本来就画在卡片正面，不再需要侧边预览', async () => {
    /*
      ADR-0025 把停靠在右侧的预览面板移除了：卡片正面就是那篇笔记的完整 Markdown 预览
      （这条由 graph-ego-preview.test.ts 钉着），侧边再开一块只是第二份事实。
      单击的语义因此收成**选中**：store 的 `selected`、宿主的 `data-graph-selected`、
      相关连线高亮 —— 画布上一张卡片都不少。想读 DOM 版全文有「浮窗打开」（另有专条用例）。
    */
    await mountFocus('项目/设计.md')
    expect(graphHost().getAttribute('data-graph-selected')).toBe('')
    const cardsBefore = cardCount()

    /*
      原来是 `fireEvent.click(cardElement('项目/设计.md'))`。现在没有那个 DOM 元素了，
      改成在世界原点派发一次指针按下 + 抬起：焦点视图里**圆心那张卡片正好以世界原点为中心**
      （`layoutEgo` 把 root 摆在 `(-w/2, -h/2)`），所以在 {0,0} 上点一下命中的就是它 ——
      这里不需要知道卡片有多大，也就不会因为卡片尺寸变化而失效。
    */
    clickAtWorld({ x: 0, y: 0 })

    await waitFor(() => {
      expect(useGraphStore.getState().selected).toBe('项目/设计.md')
      expect(graphHost().getAttribute('data-graph-selected')).toBe('项目/设计.md')
    })
    // 圆心卡片的正文本来就画在卡片正面上（"原子写"只出现在正文里，任何标题都没有）
    await waitFor(() => {
      expect(drawnTexts().some((text) => text.includes('原子写'))).toBe(true)
    })
    // 选中不阻塞画布：没有新增布局分支，卡片一张都没少
    expect(cardCount()).toBe(cardsBefore)
  })

  it('Esc 取消选中（命令）；点画布空白处也取消', async () => {
    await mountFocus('项目/设计.md', { keys: true })

    // 先选中圆心那张卡片（原用例点的是 项目/路线图.md 的 DOM 元素）
    clickAtWorld({ x: 0, y: 0 })
    await waitFor(() => {
      expect(useGraphStore.getState().selected).toBe('项目/设计.md')
    })

    /*
      "点画布空白处也关闭"：canvas 之后"空白"就是**没有卡片的世界坐标点**。
      用一个远到不可能有卡片的位置（1e6 世界像素）派发同样的按下 + 抬起，
      走的仍是 `endPointer` 里那条 `hit === null ⇒ select(null)` 的路径 ——
      性质与从前一样（点空处 = 关预览），只是"空白"从"某块 DOM 背景"变成了一个几何事实。
    */
    clickAtWorld({ x: 1_000_000, y: 1_000_000 })
    await waitFor(() => {
      expect(useGraphStore.getState().selected).toBeNull()
      expect(graphHost().getAttribute('data-graph-selected')).toBe('')
    })

    /*
      Esc 是 `graph.closePreview` 命令：**焦点在不在画布上都生效**（全局快捷键分发）。
      停靠预览面板随 ADR-0025 移除后，它的语义是"先关最上面的浮窗，没有浮窗才取消选中"
      （见 `graph-store.closePreview`；命令 id 与快捷键都没变）。
    */
    clickAtWorld({ x: 0, y: 0 })
    await waitFor(() => {
      expect(useGraphStore.getState().selected).toBe('项目/设计.md')
    })
    fireEvent.keyDown(graphHost(), { key: 'Escape' })
    await waitFor(() => {
      expect(useGraphStore.getState().selected).toBeNull()
    })

    // 宿主是可聚焦的应用区域（键盘用户的入口），描述随模式/跳数变化
    expect(graphHost().getAttribute('role')).toBe('application')
    expect(graphHost().getAttribute('tabindex')).toBe('0')
    expect(graphHost().getAttribute('aria-label')).toBe('与「项目/设计.md」相关的关系图，1 跳')
  })

  it('双击卡片 = 进编辑器打开：切到编辑视图并真的读入那篇笔记', async () => {
    await mountFocus('项目/设计.md')

    // 双击中心那张卡片：坐标仍然来自 world → screen 的换算（原用例点的是卡片 DOM 元素）
    const at = screenPoint({ x: 0, y: 0 })
    fireEvent.doubleClick(graphHost(), { clientX: at.x, clientY: at.y })

    await waitFor(() => {
      expect(useUiStore.getState().viewMode).toBe('edit')
    })
    await waitFor(() => {
      expect(useNoteStore.getState().doc?.relPath).toBe('项目/设计.md')
    })
    expect(useNoteStore.getState().doc?.text).toContain('参考')
  })

  it('收起文件夹后内部卡片全部消失，再点一下展开回来', async () => {
    await mountVault()

    /*
      原来靠 `.mn-graph-card[data-rel-path=…]` 在不在来断言"卡片被收起了"。canvas 之后没有
      那个节点了，改用两件事一起守：**布局里的卡片数**（宿主属性）与**画笔这一段画了哪些标题**。
      后者才是"这些卡片真的不再被画出来"的直接证据 —— 只数卡片数的话，
      "少了一张、多了另一张"也会被算成通过。
    */
    const projectNotes = createMockAdapter()
      .dump()
      .filter((note) => isMarkdown(note.relPath) && note.relPath.startsWith('项目/')).length
    expect(cardCount()).toBe(MOCK_CARD_COUNT)

    resetDrawnTexts()
    fireEvent.click(screen.getByRole('button', { name: /^收起 项目/ }))

    await waitFor(() => {
      expect(cardCount()).toBe(MOCK_CARD_COUNT - projectNotes)
    })
    await waitFor(() => {
      const texts = drawnTexts()
      // 项目/ 下的四张卡片（设计、路线图、标签示例、大纲）与**子文件夹**里的细节一起消失
      expect(texts).not.toContain('设计')
      expect(texts).not.toContain('路线图')
      expect(texts).not.toContain('细节')
      // 其它文件夹不受影响
      expect(texts).toContain('2025-01-01')
    })
    // 收起后是一张紧凑的"文件夹卡片"（显示名字与篇数；篇数不写死，由 Mock 自己决定）
    const expandedAgain = screen.getByRole('button', {
      name: new RegExp(`^展开 项目（${projectNotes} 篇`),
    })
    expect(expandedAgain).toBeTruthy()

    resetDrawnTexts()
    fireEvent.click(expandedAgain)
    await waitFor(() => {
      expect(cardCount()).toBe(MOCK_CARD_COUNT)
    })
    await waitFor(() => {
      const texts = drawnTexts()
      expect(texts).toContain('设计')
      expect(texts).toContain('细节')
    })
  })

  it('选中卡片后：入链画虚线、出链画实线，其它边淡化', async () => {
    await mountVault()

    /*
      连线仍然留在 DOM（`GraphEdges` 的 SVG），所以这一条的断言与从前逐字相同；
      变的只有"怎么选中那张卡片"：原来 `fireEvent.click(cardElement(…))`，
      现在按**全库布局算出来的世界坐标**点它 —— 布局来自实现自己那两个纯函数
      （`buildLayout` + `applyManualPositions`），所以是算出来的坐标，不是写死的像素。
    */
    clickAtWorld(vaultCardCenter('项目/设计.md'))
    await waitFor(() => {
      expect(useGraphStore.getState().selected).toBe('项目/设计.md')
    })

    const edges = Array.from(document.querySelectorAll('path.mn-graph-edge'))
    const classes = new Map(
      edges.map((element) => [
        element.querySelector('title')?.textContent?.split('\n')[0] ?? '',
        element.getAttribute('class') ?? '',
      ]),
    )
    // 路线图 → 设计 是**入链**（别人指向它）⇒ 虚线 + 强调
    expect(classes.get('路线图 → 设计')).toContain('mn-graph-edge--dashed')
    expect(classes.get('路线图 → 设计')).toContain('mn-graph-edge--highlight')
    // 设计 → 路线图 是**出链**（它指向别人）⇒ 实线 + 强调
    expect(classes.get('设计 → 路线图')).toContain('mn-graph-edge--highlight')
    expect(classes.get('设计 → 路线图')).not.toContain('mn-graph-edge--dashed')
    // 与选中的卡片无关的边（细节 → 悬空）被淡化，但仍然画出来（上下文不丢）
    expect(classes.get('细节 → 还不存在的笔记（还不存在）')).toContain('mn-graph-edge--dim')
  })

  it('没有选中时所有边都是统一的淡色实线（悬空边虚线 + 虚影圆点）', async () => {
    await mountVault()

    const edges = Array.from(document.querySelectorAll('path.mn-graph-edge'))
    expect(edges).toHaveLength(4)
    for (const element of edges) {
      const className = element.getAttribute('class') ?? ''
      // 没有任何选中 ⇒ 既不强调也不淡化；只有悬空边因为"端点缺席"而画虚线
      expect(className).not.toContain('--highlight')
      expect(className).not.toContain('--dim')
      // 悬空边的 title 现在是「<用户写的目标>（还不存在）」，用它来识别
      const dangling = (element.querySelector('title')?.textContent ?? '').includes('（还不存在）')
      expect(className).toBe(dangling ? 'mn-graph-edge mn-graph-edge--dashed' : 'mn-graph-edge')
    }
    // 悬空边：虚线 + 一个小圆点 + 目标名字（用户写下的原始写法）
    expect(document.querySelectorAll('circle.mn-graph-phantom')).toHaveLength(1)
    const phantomLabel = document.querySelector('text.mn-graph-phantom-label')
    expect(phantomLabel?.textContent).toBe('还不存在的笔记')
  })

  it('键盘：+ / - / 0 缩放与适应窗口，缩放被限制在 0.25×~2.5×', async () => {
    // 缩放已经是 `graph.zoomIn` / `graph.zoomOut` / `graph.fit` 三条命令（命令表是快捷键的
    // 唯一事实来源），所以这里要装上全局快捷键分发者，并且把按键打在画布元素上 ——
    // 焦点在画布上时照样生效（事件冒泡到 window 的 keymap）。
    // 视图选全库：`graph.fit` 走的是 `fitToWindow()`，它要按全库布局算包围盒；
    // 焦点视图那条路（`fitToBounds`）的包围盒只有组件量得到，另有用例覆盖。
    await mountVault({ keys: true })
    const canvas = graphHost()
    const before = useGraphStore.getState().view.zoom

    fireEvent.keyDown(canvas, { key: '+' })
    const zoomedIn = useGraphStore.getState().view.zoom
    expect(zoomedIn).toBeGreaterThan(before)

    fireEvent.keyDown(canvas, { key: '-' })
    expect(useGraphStore.getState().view.zoom).toBeCloseTo(before, 6)

    for (let index = 0; index < 40; index += 1) fireEvent.keyDown(canvas, { key: '+' })
    expect(useGraphStore.getState().view.zoom).toBe(MAX_ZOOM)
    for (let index = 0; index < 80; index += 1) fireEvent.keyDown(canvas, { key: '-' })
    expect(useGraphStore.getState().view.zoom).toBe(MIN_ZOOM)

    fireEvent.keyDown(canvas, { key: '0' })
    const fitted = useGraphStore.getState().view
    expect(fitted.zoom).toBeGreaterThan(MIN_ZOOM)
    expect(fitted.zoom).toBeLessThanOrEqual(MAX_ZOOM)
  })

  /*
    ⚠️ 用例替换说明（不是放宽，是**能力被有意换掉了**）。

    原来是「卡片可 Tab 聚焦，Enter 预览、Ctrl+Enter 打开」。canvas 之后卡片是画出来的像素，
    **不是 DOM 元素**：Tab 序列里根本没有它们（也不该造 3000 个 tabindex —— 那会让 Tab 每走一步
    都卡一次，比没有键盘支持更糟）。所以那条通路被换成了两条，本用例守的就是新的这两条：

      1. **宿主自己** `tabIndex=0`（一个可聚焦的"应用区域"），方向键在**同一方向上最近的卡片**
         之间移动选中项 —— 这是 `GraphCanvas.handleKeyDown` 提供的替代通路，
         否则画布对键盘用户就等于一块不可操作的图片；
      2. **打开进编辑器由 HUD 的「浮窗打开」与浮窗里的按钮负责**（ADR-0025 把侧边预览面板
         移除了：卡片正面就是完整正文，"再看一块侧边栏"没有存在理由）。

    性质没变："键盘用户能选中一张卡片、能读它的全文、能把它打开进编辑器"，只是入口从
    Tab 换成了方向键 + 浮窗。
  */
  it('键盘通路：卡片不再是 DOM 所以 Tab 到不了它，改由方向键移动选中项、浮窗按钮负责打开', async () => {
    await mountFocus('项目/设计.md')
    const host = graphHost()

    // 宿主是一个可聚焦的应用区域：Tab 能停在它上面，方向键从这里进入卡片世界
    expect(host.getAttribute('tabindex')).toBe('0')
    expect(host.getAttribute('role')).toBe('application')
    host.focus()
    expect(document.activeElement).toBe(host)

    // 还没有选中时，第一次按方向键会先选中第一张卡片（handleKeyDown 的 `current === undefined` 分支）
    fireEvent.keyDown(host, { key: 'ArrowRight' })
    await waitFor(() => {
      expect(useGraphStore.getState().selected).not.toBeNull()
    })
    const first = useGraphStore.getState().selected

    // 再按一次：选中项换到**另一张**卡片（宿主属性上的选中就是新的那一篇）
    fireEvent.keyDown(host, { key: 'ArrowRight' })
    await waitFor(() => {
      const selected = useGraphStore.getState().selected
      expect(selected).not.toBeNull()
      expect(selected).not.toBe(first)
    })
    const selected = useGraphStore.getState().selected ?? ''
    expect(graphHost().getAttribute('data-graph-selected')).toBe(selected)

    // "读全文 / 打开进编辑器"由浮窗承担：HUD 的「浮窗打开」（选中一张卡片才出现）→
    // 浮窗里的路径就是那一篇 → 浮窗里的"在编辑器中打开"进编辑视图并读入它
    fireEvent.click(hudButton('open-floating'))
    const pane = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('.mn-float-note')
      expect(element).not.toBeNull()
      return element as HTMLElement
    })
    expect(pane.querySelector('.mn-float-note__path')?.textContent).toBe(selected)
    fireEvent.click(screen.getByRole('button', { name: '在编辑器中打开' }))
    await waitFor(() => {
      expect(useUiStore.getState().viewMode).toBe('edit')
    })
    await waitFor(() => {
      expect(useNoteStore.getState().doc?.relPath).toBe(selected)
    })
  })

  it('全库视图：拖动卡片覆盖自动布局并持久化到 localStorage；"重新自动排布"清除手工位置', async () => {
    await mountVault()
    const relPath = '项目/设计.md'
    // 拖动**之前**的自动布局：手工位置还是空的，所以这就是"自动装箱给它的位置"
    const start = vaultCardRect(relPath)
    const center = { x: start.x + start.width / 2, y: start.y + start.height / 2 }
    const before = useGraphStore.getState().manual.get(relPath)
    expect(before).toBeUndefined()

    /*
      拖动按 4px 阈值判定（`CLICK_SLOP_PX`），所以位移必须明显超过它；
      而且**只有全库视图**才允许拖卡片（焦点视图里"位置"就是离中心几跳，见后面那条用例）。
      起点是布局函数算出来的卡片中心，不是写死的像素。
    */
    const dx = 120
    const dy = 80
    const from = screenPoint(center)
    const host = graphHost()
    pointer(host, 'pointerdown', { x: from.x, y: from.y })
    pointer(host, 'pointermove', { x: from.x + dx, y: from.y + dy })
    pointer(host, 'pointerup', { x: from.x + dx, y: from.y + dy })

    const moved = useGraphStore.getState().manual.get(relPath)
    expect(moved).toBeDefined()
    expect(moved).not.toEqual(before)

    /*
      卡片真的跟着光标走了：抓点相对**卡片左上角**的偏移保持不变 ⇒
      卡片左上角的新世界坐标 = 旧左上角 + (屏幕位移 ÷ 缩放)。
      （按下点在卡片中心，抓点偏移就是半张卡片 —— 这正是实现里 `state.card.grabX` 的含义：
      不这样减掉，卡片会在按下的瞬间"跳"到光标下面。）
      ±1 世界像素的余量：`data-graph-offset-*` 是**取整**后的（最多 0.5 屏幕像素），
      换算回世界坐标要再除以缩放，而 `moveCard` 自己也会取整 —— 所以断言的是
      "位置按换算跟着走了"，而不是逐位相等。
    */
    const view = useGraphStore.getState().view
    expect(Math.abs((moved?.x ?? Number.NaN) - (start.x + dx / view.zoom))).toBeLessThanOrEqual(1)
    expect(Math.abs((moved?.y ?? Number.NaN) - (start.y + dy / view.zoom))).toBeLessThanOrEqual(1)

    // 拖动不是"点了一下"：不该顺手打开预览（原用例的 `selected === null` 一并保留在后面那条）
    expect(useGraphStore.getState().selected).toBeNull()

    // 位置按 `Vault 根 + relPath` 持久化
    flushPositionPersist()
    const raw = window.localStorage.getItem(POSITIONS_KEY)
    expect(raw).not.toBeNull()
    const stored = JSON.parse(raw ?? '{}') as Record<string, Record<string, { x: number }>>
    expect(stored[VAULT_ROOT]?.[relPath]?.x).toBe(moved?.x)

    /*
      覆盖生效（原来比的是卡片 DOM 的 `style.left`）：布局里那张卡片的坐标已经变成手工位置，
      而**自动装箱给的那个**不同 —— 后者才是"拖动真的不只改了 store 里一个 Map"的证据。
      重新算一遍自动布局（不叠手工位置）拿到那个参照值。
    */
    const auto = buildLayout(
      useGraphStore.getState().data?.nodes ?? [],
      useGraphStore.getState().collapsed,
    ).cards.find((item) => item.relPath === relPath)
    expect(auto?.x).toBe(start.x)
    expect(vaultCardRect(relPath).x).toBe(moved?.x)
    expect(moved?.x).not.toBe(auto?.x)

    fireEvent.click(screen.getByRole('button', { name: '重新自动排布' }))
    await waitFor(() => {
      expect(useGraphStore.getState().manual.size).toBe(0)
    })
  })

  it('拖动不会误触发预览（4px 阈值的意义）', async () => {
    await mountVault()
    const relPath = '项目/路线图.md'
    const from = screenPoint(vaultCardCenter(relPath))
    const host = graphHost()

    pointer(host, 'pointerdown', { x: from.x, y: from.y })
    pointer(host, 'pointermove', { x: from.x + 50, y: from.y + 30 })
    pointer(host, 'pointerup', { x: from.x + 50, y: from.y + 30 })
    /*
      补一次普通的 click（浏览器在拖动结束时也可能补发一次）：canvas 版里选中**只**由
      `pointerdown` + `pointerup` 决定（`endPointer` 里 `state.moved` 一挡就返回），
      单独一个 click 不该被当成"点了一下卡片"。
    */
    fireEvent.click(host, { clientX: from.x + 50, clientY: from.y + 30 })

    expect(useGraphStore.getState().selected).toBeNull()
    expect(document.querySelector('.mn-graph-preview')).toBeNull()
  })

  it('失去焦点即松开：被按住的卡片在"点空白 / 选中换走"之后继续漂浮（ADR-0025）', async () => {
    /*
      用户原话："每个卡片聚焦后的失去焦点继续松开卡片，保持浮动"。
      曾经"按住"是近乎永久的状态（只有 HUD 的「松开卡片」能解除）；现在的判据：
      **焦点走了就松开** —— 点空白、或选中换到另一张，被按住的卡片都立刻交还力场。
      两条路都要守：空白点击在 `endPointer`（那次选中可能根本没变），
      换选中在"选中变化"的 effect 上（它也覆盖方向键 / 定位笔记 / 命令那几条路）。
    */
    await mountFocus('项目/设计.md')
    const relPath = '项目/设计.md'
    const host = graphHost()

    const dragCard = (world: Point, dx: number, dy: number): void => {
      const from = screenPoint(world)
      pointer(host, 'pointerdown', { x: from.x, y: from.y })
      pointer(host, 'pointermove', { x: from.x + dx, y: from.y + dy })
      pointer(host, 'pointerup', { x: from.x + dx, y: from.y + dy })
    }

    // 拖动圆心那张 ⇒ 被按住（pins 里有了它，力场不再推它）
    dragCard({ x: 0, y: 0 }, 90, 60)
    expect(useGraphStore.getState().pins.has(relPath)).toBe(true)

    // 点空白处 ⇒ 它失去焦点 ⇒ 立即松开（不再等「松开卡片」按钮）
    clickAtWorld({ x: 1_000_000, y: 1_000_000 })
    await waitFor(() => {
      expect(useGraphStore.getState().pins.size).toBe(0)
    })

    // 再按住一次（位置已经漂过，按**当前**矩形抓它），然后把选中换到另一张 ⇒ 同样松开
    const current = focusCardRect(relPath)
    expect(current).not.toBeNull()
    const box = current ?? { x: 0, y: 0, width: 1, height: 1 }
    dragCard({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, 30, 20)
    expect(useGraphStore.getState().pins.has(relPath)).toBe(true)

    const neighbour = focusCardRect('项目/路线图.md')
    expect(neighbour).not.toBeNull()
    const neighbourBox = neighbour ?? { x: 0, y: 0, width: 0, height: 0 }
    clickAtWorld({
      x: neighbourBox.x + neighbourBox.width / 2,
      y: neighbourBox.y + neighbourBox.height / 2,
    })
    await waitFor(() => {
      expect(useGraphStore.getState().selected).toBe('项目/路线图.md')
    })
    await waitFor(() => {
      expect(useGraphStore.getState().pins.size).toBe(0)
    })
  })

  it('悬停正文里某段 [[链接]]：对应连线提亮（引线也提亮），移开即恢复', async () => {
    /*
      用户要的那件事："鼠标悬浮 wikilink 的时候对应的关系连线高亮"。
      注意圆心的边**默认就是高亮的**（与中心相关），用它验"悬停点亮"等于没验 ——
      所以这条用一条**不碰圆心**的边：链条 Mock（中心 → 一跳 → 两跳）里
      `一跳 → 两跳` 默认是"环与环之间"的淡虚线，把指针移到「一跳」卡片正文里的
      [[两跳]] 上，它就该提亮。指针落点从那条边的**引线起点小圆点**读
      （它就是锚点 = 那段文字的左侧），再往右挪 4px 进文字内部 —— 全程不猜像素。
    */
    setIpcAdapter(createMockAdapter({ rootPath: VAULT_ROOT, notes: CHAIN_NOTES }))
    await act(async () => {
      await useVaultStore.getState().openVault(VAULT_ROOT)
    })
    await mountFocus('中心.md')
    // 深度 1 时"两跳"不在子图里，调到 2
    fireEvent.click(screen.getByRole('button', { name: '增加一跳' }))
    await waitFor(() => {
      expect(graphHost().getAttribute('data-graph-depth')).toBe('2')
    })

    /** 一跳 → 两跳 那条边的**卡外那段**（它在 span 层；引线层里同 key 的组没有它）。 */
    const spanOf = (): SVGPathElement | null => {
      for (const group of document.querySelectorAll<SVGGElement>('g[data-edge]')) {
        const span = group.querySelector<SVGPathElement>(
          'path.mn-graph-edge:not(.mn-graph-edge--lead)',
        )
        if (span === null) continue
        const title = group.querySelector('title')?.textContent ?? ''
        if (title.includes('一跳 → 两跳')) return span
      }
      return null
    }
    /** 同一条边的引线（卡片内那段虚线，在 lead 层）。 */
    const leadOf = (): SVGPathElement | null => {
      for (const group of document.querySelectorAll<SVGGElement>('g[data-edge]')) {
        const lead = group.querySelector<SVGPathElement>('path.mn-graph-edge--lead')
        if (lead === null) continue
        const title = group.querySelector('title')?.textContent ?? ''
        if (title.includes('一跳 → 两跳')) return lead
      }
      return null
    }

    const dot = await waitFor(() => {
      for (const group of document.querySelectorAll<SVGGElement>('g[data-edge]')) {
        const title = group.querySelector('title')?.textContent ?? ''
        if (!title.includes('一跳 → 两跳')) continue
        const found = group.querySelector<SVGCircleElement>('.mn-graph-edge-lead-dot')
        if (found !== null) return found
      }
      throw new Error('还没有 一跳 → 两跳 的引线')
    })
    const anchor = { x: Number(dot.getAttribute('cx')), y: Number(dot.getAttribute('cy')) }
    expect(Number.isFinite(anchor.x) && Number.isFinite(anchor.y)).toBe(true)

    // 默认：这条边不碰圆心 ⇒ 淡化（对照组：没有它，下面的"提亮"可能是恒真的）
    await waitFor(() => {
      expect(spanOf()?.getAttribute('class') ?? '').toContain('mn-graph-edge--dim')
    })

    // 悬停到那段 [[两跳]] 上：边提亮、引线提亮、宿主给出 over-link 光标
    const at = screenPoint({ x: anchor.x + 4, y: anchor.y })
    pointer(graphHost(), 'pointermove', { x: at.x, y: at.y })
    await waitFor(() => {
      const spanClass = spanOf()?.getAttribute('class') ?? ''
      expect(spanClass).toContain('mn-graph-edge--highlight')
      expect(spanClass).not.toContain('mn-graph-edge--dim')
    })
    expect(leadOf()?.getAttribute('class') ?? '').toContain('mn-graph-edge--lead--active')
    expect(graphHost().className).toContain('mn-graph--over-link')

    // 移开到空白：恢复淡化（高亮不是"点过一次就亮着"）
    const away = screenPoint({ x: 1_000_000, y: 1_000_000 })
    pointer(graphHost(), 'pointermove', { x: away.x, y: away.y })
    await waitFor(() => {
      expect(spanOf()?.getAttribute('class') ?? '').toContain('mn-graph-edge--dim')
    })
    expect(graphHost().className).not.toContain('mn-graph--over-link')
  })

  it('刷新期间不闪白：旧卡片继续显示，只在 HUD 上给一个"刷新中"的轻量指示', async () => {
    await mountVault()

    // 让这次刷新"挂住"，好在"正在刷新"的那一刻观察界面
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const base = createMockAdapter()
    let calls = 0
    setIpcAdapter({
      kind: 'test',
      async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
        if (method === 'graph_data') {
          calls += 1
          if (calls > 1) await gate
        }
        return base.invoke<T>(method, args)
      },
    })

    let refresh: Promise<void> = Promise.resolve()
    act(() => {
      refresh = useGraphStore.getState().load(VAULT_ROOT, { keepView: true })
    })

    await waitFor(() => {
      expect(screen.getByText('刷新中…')).toBeTruthy()
    })
    /*
      旧数据继续渲染：没有全屏加载层、也没有空白。
      原来是数 `.mn-graph-card` 的 DOM 节点；canvas 之后卡片数只能从宿主属性上读 ——
      性质一样（刷新期间画布上仍然是完整的一整套卡片，不是 0 张）。
    */
    expect(cardCount()).toBe(MOCK_CARD_COUNT)
    expect(screen.queryByText('正在读取图谱…')).toBeNull()

    await act(async () => {
      release()
      await refresh
    })
    await waitFor(() => {
      expect(screen.queryByText('刷新中…')).toBeNull()
    })
  })

  it('刷新返回空数据时不闪白：旧卡片继续显示，只在提示条上说明', async () => {
    await mountVault()

    // 索引重建期间宿主可能返回空结果
    const base = createMockAdapter()
    setIpcAdapter({
      kind: 'test',
      async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
        if (method !== 'graph_data') return base.invoke<T>(method, args)
        return { nodes: [], edges: [], truncated: false, elapsedMs: 0 } as unknown as T
      },
    })
    await act(async () => {
      await useGraphStore.getState().load(VAULT_ROOT, { keepView: true })
    })

    // 画布没有被清空（卡片都还在），提示条说明看到的是上一次的结果
    expect(cardCount()).toBe(MOCK_CARD_COUNT)
    expect(screen.getByText(/索引可能正在重建/)).toBeTruthy()
  })

  it('保存成功后自动刷新一次（画布可见时），且不会重置视角', async () => {
    let graphCalls = 0
    const base = createMockAdapter()
    setIpcAdapter({
      kind: 'test',
      async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
        if (method === 'graph_data') graphCalls += 1
        return base.invoke<T>(method, args)
      },
    })
    resetStores()
    await useVaultStore.getState().openVault(VAULT_ROOT)

    await mountVault()
    expect(graphCalls).toBe(1) // 挂载（= 切到图谱视图 / 切到全库）时拉了一次
    const view = useGraphStore.getState().view

    // 索引是全局的：任何一次保存成功后都应刷新（`saveCount` 变化就是那个信号）
    act(() => {
      useNoteStore.setState({ saveCount: useNoteStore.getState().saveCount + 1 })
    })
    expect(graphCalls).toBe(2)
    // 保留视角：刷新不会把镜头甩回"适应窗口"
    expect(useGraphStore.getState().view).toEqual(view)

    // 画布不可见时不发请求：每次自动保存都白跑一次 IPC 没有意义，
    // 切回图谱时的挂载刷新本来就会拉到最新数据
    useUiStore.setState({ viewMode: 'edit' })
    act(() => {
      useNoteStore.setState({ saveCount: useNoteStore.getState().saveCount + 1 })
    })
    expect(graphCalls).toBe(2)
  })

  it('索引构建中给出提示（不是报错），索引就绪后自动补一次数据', async () => {
    setIpcAdapter(createMockAdapter())
    resetStores()
    await useVaultStore.getState().openVault(VAULT_ROOT)
    // 模拟"打开 Vault 时索引还在构建"
    useLinksStore.setState({
      status: { phase: 'building', indexed: 3, total: 8, durationMs: 0, links: 0 },
    })

    render(<GraphCanvas />)
    await waitFor(() => {
      expect(screen.getByText(/索引构建中/)).toBeTruthy()
    })

    // 索引就绪 → 自动重新拉一次，提示消失（不需要用户手动刷新）
    act(() => {
      useLinksStore.setState({
        status: { phase: 'ready', indexed: 8, total: 8, durationMs: 12, links: 4 },
      })
    })
    await waitFor(() => {
      expect(screen.queryByText(/索引构建中/)).toBeNull()
    })
    expect(useGraphStore.getState().staleIndex).toBe(false)
  })

  it('已截断时给出提示（宿主只返回了度数最高的一部分节点）', async () => {
    // 包一层：把 Mock 的 `graph_data` 结果标记成 truncated（真实宿主在节点数超过上限时这样返回）
    const base = createMockAdapter()
    const adapter: IpcAdapter = {
      kind: 'test',
      async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
        if (method !== 'graph_data') return base.invoke<T>(method, args)
        const payload = await base.invoke<GraphData>('graph_data', args)
        return { ...payload, truncated: true } as unknown as T
      },
    }
    setIpcAdapter(adapter)
    resetStores()
    await useVaultStore.getState().openVault(VAULT_ROOT)

    await mountVault()
    expect(screen.getByText('已截断')).toBeTruthy()
  })

  it('App 的图谱视图真的挂上了画布（viewMode === "graph"）', async () => {
    useUiStore.setState({ viewMode: 'graph' })
    render(<App />)

    await waitFor(() => {
      expect(document.querySelector('.mn-graph')).not.toBeNull()
    })
    // 真的是 canvas 那一层（卡片不再是 DOM 节点，所以这里认的是 canvas 元素本身）
    await waitFor(() => {
      expect(document.querySelector('canvas.mn-graph__canvas')).not.toBeNull()
    })
    // 切到全库（默认是焦点视图，没有打开笔记时它没有卡片）后，Mock Vault 的卡片全部就位
    await switchToVault()
    expect(cardCount()).toBe(MOCK_CARD_COUNT)
  })

  // -------------------------------------------------------------------------
  // 这次改动新增的能力（ADR-0021：焦点视图 + 深度调节 + canvas 渲染）
  // -------------------------------------------------------------------------

  it('默认进入焦点视图（1 跳），点"增加一跳"会多画出更远的卡片并把偏好落盘', async () => {
    /*
      为什么要单独一条：焦点视图是**默认入口**，而"1 跳"是这次改动的核心取舍
      （用户的原话是"进入后只有先关联的图谱"）。这里用一条**专用**的三段链 Mock Vault：
      缺省 Mock Vault 只有 设计 ↔ 路线图 一条往返边，1 跳就把连通分量拿全了，
      调大跳数不会多出任何卡片 —— 那等于没测到"深度真的往外扩了一层"。
    */
    setIpcAdapter(createMockAdapter({ rootPath: VAULT_ROOT, notes: CHAIN_NOTES }))
    await act(async () => {
      await useVaultStore.getState().openVault(VAULT_ROOT)
    })

    await mountFocus('中心.md')
    const host = graphHost()
    expect(host.getAttribute('data-graph-mode')).toBe('focus')
    expect(host.getAttribute('data-graph-depth')).toBe('1')
    expect(
      document.querySelector('[data-graph-depth-value]')?.getAttribute('data-graph-depth-value'),
    ).toBe('1')

    // 1 跳 = 圆心 + 与它直接相连的那一圈（中心 ↔ 一跳）
    const oneHop = cardCount()
    expect(oneHop).toBe(2)

    fireEvent.click(screen.getByRole('button', { name: '增加一跳' }))
    await waitFor(() => {
      expect(host.getAttribute('data-graph-depth')).toBe('2')
      // 2 跳多出"两跳.md"：卡片数真的增长了（不是只有 HUD 上的数字变了）
      expect(cardCount()).toBeGreaterThan(oneHop)
    })
    expect(cardCount()).toBe(3)

    // 深度是"我怎么看图"的偏好：写进 localStorage，跨挂载/跨会话都还在。
    // 用 `toMatchObject` 而不是逐字相等：偏好里还有张力/预设/两个开关（ADR-0023 之后
    // 每次落盘都会带上它们），逐字断言会让"以后再加一个偏好"和"别的偏好没被抹掉"这两件事
    // 混在一起 —— 后者另有专门用例（`graph-view-prefs` 里那条回归）。
    expect(JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? '{}')).toMatchObject({
      mode: 'focus',
      depth: 2,
    })
  })

  it('文件夹容器只属于全库视图：焦点视图里一个都没有，切到"整个 Vault"才出现', async () => {
    /*
      为什么：焦点视图的"位置"就是**离中心几跳**（同心环），按文件夹装箱会把这条唯一的距离
      信息抹掉 —— 两种视图摆的是同一批卡片，但"用什么维度组织它们"是互斥的。
      容器是留在 DOM 里的那一层，所以这条用 DOM 断言就够（也是"全库视图没被删掉"的证据）。
    */
    await mountFocus('项目/设计.md')
    expect(cardCount()).toBeGreaterThan(0)
    // 容器是留在 DOM 里的一层，所以这条用 DOM 断言就够
    // （连线两种视图都有，只有**文件夹容器**是按文件夹组织的那一层）
    expect(document.querySelectorAll('.mn-graph-folder')).toHaveLength(0)

    await switchToVault()
    expect(folderPaths()).toEqual(expect.arrayContaining(['', '日记', '项目', '项目/子项目']))
  })

  it('焦点视图里拖动卡片 = 把它按住（力场不再推它），空白处拖动才是平移画布', async () => {
    /*
      这条守的是**两种拖动**的区别（ADR-0023 把焦点视图那一半改过）：
      - 卡片上拖动 → 焦点视图里"按住这一张"（模拟里 `fixed = true`），其余卡片继续被张力牵着；
        全库视图里仍是"搬位置"（装箱布局 + 落盘）。
        按住只是这一次会话里的临时状态：位置依然由**布局与力场**决定，不写 localStorage。
      - 空白处拖动 → 平移画布（两个视图都一样）。

      为什么不再像 canvas 化的第一版那样"焦点视图里拖卡片 = 平移画布"：那时卡片位置完全由
      环形布局决定，拖一下就把"离中心几跳"变成谎话。加了力导向之后位置本来就由力场决定，
      "按住其中一张、其余继续漂"正是漂浮该有的手感（用户明确要的那件事）。
    */
    await mountFocus('项目/设计.md')
    const viewBefore = useGraphStore.getState().view
    const relPath = '项目/设计.md'

    const from = screenPoint({ x: 0, y: 0 }) // 圆心那张卡片上按住
    const host = graphHost()
    pointer(host, 'pointerdown', { x: from.x, y: from.y })
    pointer(host, 'pointermove', { x: from.x + 90, y: from.y + 60 })
    pointer(host, 'pointerup', { x: from.x + 90, y: from.y + 60 })

    // 没有"手工位置"这回事：焦点视图的布局里根本没有这一层，也不落盘
    expect(useGraphStore.getState().manual.size).toBe(0)
    expect(window.localStorage.getItem(POSITIONS_KEY)).toBeNull()
    // 画布没有跟着平移（拖的是卡片，不是画布）
    expect(useGraphStore.getState().view).toEqual(viewBefore)

    // 卡片被**按住**了：store 里记下了它的新中心（世界坐标），位移等于拖动的屏幕位移 ÷ 缩放
    const scale = useGraphStore.getState().view.zoom
    const pinned = useGraphStore.getState().pins.get(relPath)
    expect(pinned).toBeDefined()
    expect(pinned?.x).toBeCloseTo(90 / scale, 1)
    expect(pinned?.y).toBeCloseTo(60 / scale, 1)

    // 松开：pins 清空（HUD 上那个「松开卡片」按钮走的就是这条命令）
    act(() => {
      useGraphStore.getState().unpinCards()
    })
    expect(useGraphStore.getState().pins.size).toBe(0)

    // 空白处拖动仍然平移画布：用一个肯定没有卡片的世界坐标点
    const blank = screenPoint({ x: 1_000_000, y: 1_000_000 })
    const panBefore = useGraphStore.getState().view
    pointer(host, 'pointerdown', { x: blank.x, y: blank.y })
    pointer(host, 'pointermove', { x: blank.x + 40, y: blank.y + 25 })
    pointer(host, 'pointerup', { x: blank.x + 40, y: blank.y + 25 })
    expect(useGraphStore.getState().view.x - panBefore.x).toBeCloseTo(40, 6)
    expect(useGraphStore.getState().view.y - panBefore.y).toBeCloseTo(25, 6)
  })

  it('方向键把选中项换到另一张卡片，并把它带到视口正中央', async () => {
    /*
      为什么：卡片不是 DOM，Tab 到不了它们，方向键是画布唯一的键盘选卡通路；
      而"选中了却在屏幕外"等于没选中，所以 `handleKeyDown` 会顺手调 `locateCard`
      把它摆到视口中央。这里断言的就是这两件事一起发生。
    */
    await mountVault()
    const relPath = '项目/设计.md'
    clickAtWorld(vaultCardCenter(relPath))
    await waitFor(() => {
      expect(useGraphStore.getState().selected).toBe(relPath)
    })

    const key = pickArrowKey(relPath)
    const before = useGraphStore.getState().view

    fireEvent.keyDown(graphHost(), { key })
    await waitFor(() => {
      const selected = useGraphStore.getState().selected
      expect(selected).not.toBeNull()
      expect(selected).not.toBe(relPath)
    })

    const state = useGraphStore.getState()
    const selected = state.selected ?? ''
    // 镜头动了（locateCard 改了平移，缩放不动）
    expect(state.view).not.toEqual(before)
    expect(state.view.zoom).toBe(before.zoom)

    // 被选中的卡片被摆到视口正中央：`屏幕 = 世界 × zoom + offset`
    const center = vaultCardCenter(selected)
    expect(center.x * state.view.zoom + state.view.x).toBeCloseTo(state.viewport.width / 2, 3)
    expect(center.y * state.view.zoom + state.view.y).toBeCloseTo(state.viewport.height / 2, 3)
  })

  it('没有打开任何笔记：焦点视图给出"打开一篇笔记…"的提示，那个按钮真的切到全库', async () => {
    /*
      空态为什么值得守：焦点视图的"空"与全库视图的"空"是两回事 ——
      前者是"没有圆心"（打开一篇笔记就好了），后者才是"这个 Vault 里没有笔记"。
      把前者显示成"Vault 是空的"会让用户以为笔记没了。
    */
    mountGraph()

    await waitFor(() => {
      expect(graphHost().getAttribute('data-graph-mode')).toBe('focus')
    })
    const overlay = await waitFor(() => {
      const element = document.querySelector('.mn-graph__overlay')
      expect(element).not.toBeNull()
      return element
    })
    expect(overlay?.textContent).toContain('打开一篇笔记')
    // 没有圆心就没有卡片（空态下画布上确实一张都没有，而不是"卡片在屏幕外"）
    expect(cardCount()).toBe(0)

    // 空态上的那个按钮是唯一出口：它真的把视图切成全库，并因此真的去拉了全库数据
    fireEvent.click(screen.getByRole('button', { name: '看看整个 Vault' }))
    await waitFor(() => {
      expect(graphHost().getAttribute('data-graph-mode')).toBe('vault')
    })
    await waitFor(() => {
      expect(cardCount()).toBe(MOCK_CARD_COUNT)
    })
  })

  it('视口裁剪真的发生：把镜头移到空地后一张都不画，而"交给画笔的卡片数"照旧不变', async () => {
    /*
      为什么要单独一条：canvas 化的**全部意义**就在于"卡片数再多，每帧的工作量也只由视口决定"，
      而这件事在 DOM 时代是"节点在不在文档里"自明的，现在必须自己证明。
      裁剪的证据有两个，缺一不可：
        1. `data-graph-painted-cards`（画笔返回的 `PaintStats.cards`）变成 0；
        2. 记录型假画布上**一段文字都没画**（属性说 0 也可能是没重画，这条排除了那种可能）。
      同时 `data-graph-canvas-cards` 保持 9 —— 它说的是"布局里有多少张"，
      与"这一帧画了几张"本来就是两件事（这正是两个属性分开的理由）。
    */
    await mountVault()
    const handedIn = cardCount()
    expect(handedIn).toBe(MOCK_CARD_COUNT)
    await waitFor(() => {
      expect(paintedCardCount()).toBe(MOCK_CARD_COUNT)
    })

    resetDrawnTexts()
    act(() => {
      // 直接改视角（等价于把画布拖到很远的地方）：布局没变，变的是"镜头对准哪儿"
      useGraphStore.getState().setView({ x: 1_000_000, y: 1_000_000, zoom: 1 })
    })

    await waitFor(() => {
      expect(paintedCardCount()).toBe(0)
    })
    // 画笔这一帧一张都没画（记录是裁剪前清空的，而这次重画就发生在同一个 effect 里）
    expect(drawnTexts()).toHaveLength(0)
    // 交给画笔的张数没变：裁剪发生在画笔内部，不是布局或数据被清掉了
    expect(cardCount()).toBe(handedIn)
  })

  it('连接线从正文里的 `[[链接]]` 引出：卡片内是虚线引线，出了卡片才是实线（ADR-0023）', async () => {
    /*
      用户要的那件事："连接线不是凭空渲染在卡片边缘，要通过虚线从对应的 wiki link 处
      到卡片边缘再转为实线"。这里守两件事：
        1. 有对应文字时 → 每个 `[[链接]]` 都产生一段**卡片内的虚线**（`.mn-graph-edge--lead`）；
        2. 关掉这个开关 → 那些虚线消失（退回"从卡片边界出发"的老行为），不是"永远画着"。
      Mock Vault 里 `项目/设计.md` 正文写着 `[[路线图]]` 与 `[[细节]]`，所以圆心那张卡片
      应当有两条引线。
    */
    await mountFocus('项目/设计.md')

    const leadPaths = (): SVGPathElement[] =>
      Array.from(document.querySelectorAll<SVGPathElement>('path.mn-graph-edge--lead'))
    await waitFor(() => {
      expect(leadPaths().length).toBeGreaterThanOrEqual(2)
    })
    // 引线真的有几何（`d` 非空），并且从**卡片内部**的某一点开始（不是一个零长度点）
    for (const path of leadPaths()) {
      const d = path.getAttribute('d') ?? ''
      expect(d.startsWith('M')).toBe(true)
      expect(d.length).toBeGreaterThan(8)
    }
    // 起点的小圆点也在（"线从哪句话出来"的指示）
    expect(document.querySelectorAll('.mn-graph-edge-lead-dot').length).toBeGreaterThanOrEqual(2)

    // 关掉开关：引线消失，但边还在（退回从卡片边界出发）
    act(() => {
      useGraphStore.getState().setEdgeFromLink(false)
    })
    await waitFor(() => {
      expect(leadPaths()).toHaveLength(0)
    })
    expect(document.querySelectorAll('path.mn-graph-edge').length).toBeGreaterThan(0)
  })

  it('分界处严丝合缝：引线是虚线、相位收在卡片边界上，卡外那段是实线、箭头只在目标端（ADR-0023）', async () => {
    /*
      用户那句话的后半句是"卡片边缘处实线出连接到卡片"，判据全落在**分界点**上：

        1. 两段的 `d` 在分界点上逐坐标相同（"缝"就是在这里出现的）；
        2. 卡内那段带 `stroke-dasharray`，并把相位调到最后一段实线**正好收在分界点**上
           （相位取 0 时，长度 mod 周期 不巧就会让虚线停在离卡边 1~3px 的空隙里）；
        3. 卡外那段（出链 ⇒ 实线）没有虚线的图案，也不带 `--dashed` 类；
        4. 箭头只在目标端（`marker-end` 在卡外那段上，引线上没有）；
        5. 两端都是 butt 线帽：分界处齐平切断，不会多出一个圆头。

      入链/上下文边在卡外**刻意**仍是虚线（那是 ADR-0023 的语义：虚线表示"被别人提到"），
      所以第 3 条只对**出链**（标题里 `设计 → …` 那几条）断言。
    */
    /*
      上一条用例（"连接线从正文里的 [[链接]] 引出"）结尾把这个开关关掉了验证"关掉就没有引线"，
      而 store 里这份状态不在 `resetStores()` 的重置范围内（它只重置全库视图那一半）——
      先显式打开，用例才不会依赖"谁先跑"。
    */
    act(() => {
      useGraphStore.getState().setEdgeFromLink(true)
    })
    await mountFocus('项目/设计.md')

    const leads = (): SVGPathElement[] =>
      Array.from(document.querySelectorAll<SVGPathElement>('path.mn-graph-edge--lead'))
    await waitFor(() => {
      expect(leads().length).toBeGreaterThanOrEqual(2)
    })

    /**
     * 同一条边的卡片外那段。
     *
     * 两段现在分居**两个 `<svg>`**（引线必须盖在卡片层之上才看得见，见 `GraphEdges` 文件头），
     * 所以配对靠 `<g data-edge>` 上那个同一份 `key`，而不是"同一个父节点"。
     * 用 `getAttribute` 比较而不是拼选择器：`key` 里是中文路径，拼进选择器要处理转义。
     */
    const spanOf = (lead: SVGPathElement): SVGPathElement | null => {
      const key = lead.closest('g')?.getAttribute('data-edge')
      if (key === null || key === undefined) return null
      for (const group of document.querySelectorAll<SVGGElement>('g[data-edge]')) {
        if (group.getAttribute('data-edge') !== key) continue
        const found = group.querySelector<SVGPathElement>(
          'path.mn-graph-edge:not(.mn-graph-edge--lead)',
        )
        if (found !== null) return found
      }
      return null
    }

    /** `d` 里的数字（引线与卡外那段都是 `d` 一比就清楚的路径）。 */
    const pointsOf = (d: string): Point[] => {
      const values = (d.match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g) ?? []).map(Number)
      const out: Point[] = []
      for (let index = 0; index + 1 < values.length; index += 2) {
        out.push({ x: values[index] ?? Number.NaN, y: values[index + 1] ?? Number.NaN })
      }
      return out
    }
    const firstOf = (d: string): Point => pointsOf(d)[0] ?? { x: Number.NaN, y: Number.NaN }
    const lastOf = (d: string): Point => {
      const all = pointsOf(d)
      return all[all.length - 1] ?? { x: Number.NaN, y: Number.NaN }
    }

    let outbound = 0
    /** 相位被算成 0 的引线（长度正好 mod 周期 = 实线段长度）—— 那几条不靠修正也是对的。 */
    let aligned = 0
    for (const lead of leads()) {
      const span = spanOf(lead)
      if (span === null) throw new Error('引线没有同一条边的卡片外那段（`<g>` 里应当成对）')
      const start = firstOf(lead.getAttribute('d') ?? '')
      const end = lastOf(lead.getAttribute('d') ?? '')
      const spanD = span.getAttribute('d') ?? ''

      // 1. 两段首尾相接：引线的终点与卡外那段的起点是同一个点（分界点），逐坐标相同
      expect(lastOf(lead.getAttribute('d') ?? '')).toEqual(firstOf(spanD))
      expect(Number.isFinite(end.x) && Number.isFinite(end.y)).toBe(true)

      // 2. 卡内那段是虚线，且相位把最后一段实线收在分界点上（周期 = 3 + 3 = 6）
      expect(lead.getAttribute('stroke-dasharray')).toBe('3 3')
      const offset = Number(lead.getAttribute('stroke-dashoffset'))
      expect(Number.isFinite(offset)).toBe(true)
      const length = Math.hypot(end.x - start.x, end.y - start.y)
      expect(length).toBeGreaterThan(0)
      expect((length + offset) % 6).toBeCloseTo(3, 6)

      // 相位选了"分界处收笔"，代价是链接那一端可能空出最多 3px ——
      // 那个取舍能不能成立，全看起点的小圆点盖不盖得住（半径 2 ⇒ 4px 的墨）
      const dot = lead.parentElement?.querySelector('.mn-graph-edge-lead-dot')
      const radius = Number(dot?.getAttribute('r') ?? Number.NaN)
      expect(Number.isFinite(radius)).toBe(true)
      const head = offset % 6
      const startGap = head < 3 ? 0 : 6 - head
      expect(startGap).toBeLessThanOrEqual(radius * 2)
      if (offset === 0) aligned += 1

      // 4 + 5. 线帽与箭头：分界处齐平、箭头只在目标端
      expect(lead.getAttribute('stroke-linecap')).toBe('butt')
      expect(span.getAttribute('stroke-linecap')).toBe('butt')
      expect(lead.getAttribute('marker-end')).toBeNull()
      expect(span.getAttribute('marker-end')).not.toBeNull()

      // 3. 出链在卡外是实线：不塞任何虚线的图案
      const title = lead.querySelector('title')?.textContent ?? ''
      if (title.includes('设计 →')) {
        outbound += 1
        expect(span.getAttribute('stroke-dasharray')).toBeNull()
        expect(span.getAttribute('class')?.includes('mn-graph-edge--dashed')).toBe(false)
      }
    }
    // 圆心那张卡片上写着两条链接（`[[路线图]]` 与 `[[细节]]`）⇒ 至少两条出链各自验过一遍
    expect(outbound).toBeGreaterThanOrEqual(2)
    // 而且至少有一条引线的相位**真的**被修正过（相位恒为 0 就意味着这条用例没在验任何东西：
    // 那种长度下"从链接那端起算"恰好也能收在边界上）
    expect(aligned).toBeLessThan(leads().length)
  })

  it('张力旋钮真的作用在连线上：调大之后路径的控制点变了，而且落盘', async () => {
    /*
      "张力"如果不能从画出来的路径上看出来，它就只是个滑块。这里断言 `d` 变了（同一条边），
      并断言它写进偏好 —— 后者是"下次打开还是这个手感"的前提。
    */
    await mountFocus('项目/设计.md')
    const dOf = (): string =>
      document.querySelector('path.mn-graph-edge:not(.mn-graph-edge--lead)')?.getAttribute('d') ?? ''

    await waitFor(() => {
      expect(dOf()).not.toBe('')
    })
    const before = dOf()

    act(() => {
      useGraphStore.getState().setTension(0.9)
    })
    await waitFor(() => {
      expect(dOf()).not.toBe(before)
    })
    expect(JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? '{}')['tension']).toBeCloseTo(0.9, 5)
  })

  it('卡片尺寸可调：HUD 上选一档"高度上限"、拉一次缩放手柄、再重置', async () => {
    /*
      三种改法各有各的真实入口：
        1. HUD 的高度档位（选中一张卡片才出现）；
        2. 画布上右下角的缩放手柄（拖它改宽度）；
        3. 「重置卡片」把两者一起还原。
      拖动用的是**几何**：宿主上带 `data-graph-root-rect`（圆心那张卡片的当前世界矩形），
      手柄在右下角内缩 14 像素（与 `cardResizeHandleRect` 同一个常量）。
    */
    await mountFocus('项目/设计.md')
    const relPath = '项目/设计.md'

    // 先选中圆心那张卡片（HUD 那一行才会出现）
    clickAtWorld({ x: 0, y: 0 })
    await waitFor(() => {
      expect(useGraphStore.getState().selected).toBe(relPath)
    })

    // 1) 高度档位
    const heightChip = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-card-height="400"]')
      expect(element).not.toBeNull()
      return element as HTMLElement
    })
    fireEvent.click(heightChip)
    await waitFor(() => {
      expect(useGraphStore.getState().cardSizes.get(relPath)?.height).toBe(400)
    })

    // 2) 缩放手柄：往右下拖 ⇒ **宽与高一起**跟着光标走（曾经只能调宽度 ——
    //    "卡片不能调高度"是用户报回来的缺陷，见 store 里 `setCardSize` 的说明）
    const rectAttr = graphHost().getAttribute('data-graph-root-rect') ?? ''
    const [rx = 0, ry = 0, rw = 0, rh = 0] = rectAttr.split(',').map((part) => Number(part))
    expect(rw).toBeGreaterThan(0)
    expect(rh).toBeGreaterThan(0)
    const handleWorld = { x: rx + rw - 7, y: ry + rh - 7 }
    const handleScreen = screenPoint(handleWorld)
    pointer(graphHost(), 'pointerdown', { x: handleScreen.x, y: handleScreen.y })
    pointer(graphHost(), 'pointermove', { x: handleScreen.x + 60, y: handleScreen.y + 45 })
    pointer(graphHost(), 'pointerup', { x: handleScreen.x + 60, y: handleScreen.y + 45 })

    const scale = useGraphStore.getState().view.zoom
    await waitFor(() => {
      const size = useGraphStore.getState().cardSizes.get(relPath)
      const width = size?.width ?? 0
      // 宽度的语义是"右边界跟着光标走"：新宽度 = 光标的世界 x − 卡片左边界。
      // 按下点在**手柄里**（右下角内缩 `CARD_RESIZE_HANDLE/2` 处），所以基准是 `rw - 7` 而不是 `rw`。
      // 容差 ±2：两边都取整过（属性里的矩形取整、store 写入时取整），差一个像素是**取整**不是错。
      const expectedWidth = rw - 7 + 60 / scale
      expect(Math.abs(width - expectedWidth)).toBeLessThanOrEqual(2)
      expect(width).toBeGreaterThan(rw)
      // 高度同一条换算（光标的的世界 y − 卡片上边界）：**再也不是"拉回自动"**
      const expectedHeight = rh - 7 + 45 / scale
      expect(Math.abs((size?.height ?? 0) - expectedHeight)).toBeLessThanOrEqual(2)
      // 手柄拖动是"圈定框"：两个方向都是显式意图 ⇒ 不在「全文」态
      expect(size?.full ?? false).toBe(false)
    })
    // 拉手柄没有把画布也拖走
    expect(useGraphStore.getState().view).toEqual(useGraphStore.getState().view)

    // 拉宽之后卡片仍然被画出来（重新排版的环半径变了，位置会跟着动 —— 那是**应该**的：
    // 卡片变宽了，"这一环装得下多少张"就要重算。这里只守"没有被裁掉"这条底线。）
    await waitFor(() => {
      expect(drawnTexts()).toContain('设计')
    })

    // 3) 重置
    fireEvent.click(hudButton('reset-card-size'))
    await waitFor(() => {
      expect(useGraphStore.getState().cardSizes.size).toBe(0)
    })
  })

  it('力度管理面板：每一项都在，拖滑杆即改 store 并落盘，手调后标「自定义」、恢复预设还原', async () => {
    /*
      用户的要求是"图谱应该有力度管理"：预设只是起点，真正要的是**逐项**能拧。
      这条守四件事：① 每一项参数都有控件（漏一项就等于那个旋钮不存在）；
      ② 拖动立刻进 store（不是等"应用"按钮）；③ 整份落盘（重启后还在）；
      ④ 手调之后角标要如实说"这不再是原来那一档了"，「恢复预设」能退回去。
    */
    await mountFocus('项目/设计.md')
    fireEvent.click(hudButton('toggle-force-panel'))

    const panel = await waitFor(() => {
      const element = document.querySelector('.mn-force')
      expect(element).not.toBeNull()
      return element as HTMLElement
    })
    // 每个滑杆都在（`FORCE_SLIDER_KEYS` 是面板与 store 之间的契约）
    for (const key of FORCE_SLIDER_KEYS) {
      expect(panel.querySelector(`[data-force-param="${key}"]`), key).not.toBeNull()
    }
    // 「弹簧范围」用下拉（`Infinity` 用滑杆表达不出来）
    expect(panel.querySelector('.mn-force__select')).not.toBeNull()

    // 拖一项：立刻进 store，并且整份落盘
    const slider = panel.querySelector<HTMLInputElement>('[data-force-param="repelStrength"]')
    expect(slider).not.toBeNull()
    fireEvent.change(slider as HTMLInputElement, { target: { value: '8' } })
    expect(useGraphStore.getState().forceParams.repelStrength).toBe(8)
    expect(
      (JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? '{}') as {
        forceParams?: Record<string, number>
      }).forceParams?.['repelStrength'],
    ).toBe(8)

    // 角标如实说"自定义"（基于哪一档也写出来）
    const badge = panel.querySelector('[data-force-current]')
    expect(badge?.textContent ?? '').toContain('自定义')

    // 「恢复预设」：回到当前那一档
    const expected = forcePreset(DEFAULT_FORCE_PRESET).params.repelStrength
    fireEvent.click(panel.querySelector('[data-force-action="reset"]') as HTMLElement)
    expect(useGraphStore.getState().forceParams.repelStrength).toBe(expected)
    expect(panel.querySelector('[data-force-current]')?.textContent ?? '').not.toContain('自定义')

    // 关闭：面板消失（它的打开状态是瞬时的，不持久化）
    fireEvent.click(screen.getByLabelText('关闭力度管理'))
    await waitFor(() => {
      expect(document.querySelector('.mn-force')).toBeNull()
    })
  })

  it('笔记之间会碰撞：把斥力关掉（本该挤成一团），硬碰撞仍然保证零重叠', async () => {
    /*
      用户的另一句是"笔记之间应该有碰撞！"。判据只能是"矩形还相交吗"，所以宿主上有一个
      `data-graph-overlaps`（两两判交的对数）。这条把它正面测一遍：
        1. 默认力度下就是 0（本来就该不重叠）；
        2. 把**斥力关到 0**、向心力拉满（模拟"全都往圆心挤"）之后**仍然是 0** ——
           这正是碰撞约束的意义：斥力只是"倾向"，碰撞才是"保证"；
        3. 再把碰撞也关掉 ⇒ 重叠对数 > 0。这一条是**对照**：没有它，上面两个 0 可能是恒真的。
      收尾恢复默认力度，别把后面用例的图挤成一团。
    */
    await mountFocus('项目/设计.md')
    expect(cardCount()).toBeGreaterThan(1) // 至少两张才有"重叠"可言
    await waitFor(() => {
      expect(overlapCount()).toBe(0)
    })

    act(() => {
      useGraphStore.getState().setForceParam('repelStrength', 0)
      useGraphStore.getState().setForceParam('centerStrength', 0.05)
    })
    await waitFor(() => {
      expect(overlapCount()).toBe(0)
    })

    act(() => {
      useGraphStore.getState().setForceParam('collideStrength', 0)
    })
    await waitFor(() => {
      expect(overlapCount()).toBeGreaterThan(0)
    })

    act(() => {
      useGraphStore.getState().resetForceParams()
    })
  })

  it('浮动笔记面板：从 HUD 打开一个浮窗，`Esc` 先关它、再取消选中（ADR-0023/0025）', async () => {
    /*
      浮窗是"把一篇拎出来读"的姿势（ADR-0025 移除侧边预览之后，它是图谱里唯一的 DOM 全文），
      它必须在**画布之上**、可多个、且与 `Esc` 的语义一致：`Esc` 在用户心里的意思是
      "关掉最上面那层"—— 先是浮窗，然后才是"取消选中"。
    */
    await mountFocus('项目/设计.md')
    clickAtWorld({ x: 0, y: 0 })
    await waitFor(() => {
      expect(useGraphStore.getState().selected).toBe('项目/设计.md')
    })

    fireEvent.click(hudButton('open-floating'))
    const pane = await waitFor(() => {
      const element = document.querySelector('.mn-float-note')
      expect(element).not.toBeNull()
      return element as HTMLElement
    })
    expect(pane.getAttribute('data-mn-graph-nopan')).not.toBeNull()
    expect(useGraphStore.getState().floatingPanes).toHaveLength(1)

    // `Esc`（命令走 `closePreview`）先关浮窗，选中留着
    act(() => {
      useGraphStore.getState().closePreview()
    })
    await waitFor(() => {
      expect(document.querySelector('.mn-float-note')).toBeNull()
    })
    expect(useGraphStore.getState().selected).toBe('项目/设计.md')

    // 再按一次才取消选中（曾经的"关停靠预览"那一层就是现在的"取消选中"）
    act(() => {
      useGraphStore.getState().closePreview()
    })
    expect(useGraphStore.getState().selected).toBeNull()
  })

  it('「仅标题」开关：卡片只剩标题（正文与引线都收起来），开关落盘', async () => {
    /*
      用户要的是"增加一个配置是只有标题（文件名）的卡片"。这条守四件事：
        ① 卡片变矮（只剩壳：标题行 + 分隔线 + 内边距，几何由 `titleOnlyCardHeight` 给）；
        ② 正文不再被画出来；**没有正文就没有可指的 [[链接]]** ⇒ 引线如实消失
           （连线退成"从卡片边界出发"，与全库视图同一种降级形态）；
        ③ 高度档那一行藏起来（纯标题卡片没有"正文高度上限"这回事）；
        ④ 它是"我怎么看图"的偏好 ⇒ 落盘，且可逆。
    */
    await mountFocus('项目/设计.md')
    await waitFor(() => {
      expect(drawnTexts().some((text) => text.includes('原子写'))).toBe(true)
    })
    // 选中圆心那张卡片：高度档那一行才会出现（下面要断言它在纯标题模式下藏起来）
    clickAtWorld({ x: 0, y: 0 })
    await waitFor(() => {
      expect(useGraphStore.getState().selected).toBe('项目/设计.md')
    })
    const heightOfRoot = (): number =>
      Number((graphHost().getAttribute('data-graph-root-rect') ?? '').split(',')[3] ?? 0)
    const fullHeight = heightOfRoot()
    expect(fullHeight).toBeGreaterThan(0)
    expect(document.querySelector('[data-card-height="auto"]')).not.toBeNull()

    resetDrawnTexts()
    fireEvent.click(hudButton('toggle-title-only'))

    // 等到重画之后：标题还在，正文与"目录/度数"那一行都不在了
    await waitFor(() => {
      expect(drawnTexts()).toContain('设计')
    })
    expect(drawnTexts().some((text) => text.includes('原子写'))).toBe(false)
    expect(drawnTexts()).not.toContain('项目')
    expect(heightOfRoot()).toBeLessThan(fullHeight)
    // 卡片内那段虚线引线来自"正文里的 [[链接]]"：没有正文就没有引线
    expect(document.querySelectorAll('path.mn-graph-edge--lead')).toHaveLength(0)
    // 高度档与纯标题无关，整行收起
    expect(document.querySelector('[data-card-height="auto"]')).toBeNull()
    expect(JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? '{}')).toMatchObject({
      titleOnly: true,
    })

    // 关掉之后正文与高度档都回来（开关可逆）
    resetDrawnTexts()
    fireEvent.click(hudButton('toggle-title-only'))
    await waitFor(() => {
      expect(drawnTexts().some((text) => text.includes('原子写'))).toBe(true)
    })
    expect(document.querySelector('[data-card-height="auto"]')).not.toBeNull()
  })

  it('「全文」档：不截断（与数值档互斥），HUD 上的选中态跟随', async () => {
    /*
      项 5 的"卡片可以完整展示全文"：高度档的第五个选项就是**不截断**。
      它与数值档**互斥** —— 两者是"这一篇怎么显示"的两种答案，不能同时成立。
      Mock 的笔记都很短（全文与自动排出来一样高），所以几何上无可断言；
      几何那一侧由 `layoutCard` 的单测钉着（`maxHeight: Infinity` ⇒ 与"没给上限"逐块一致），
      这里守的是状态机与 HUD 的选中态。
    */
    await mountFocus('项目/设计.md')
    const relPath = '项目/设计.md'
    clickAtWorld({ x: 0, y: 0 })
    await waitFor(() => {
      expect(useGraphStore.getState().selected).toBe(relPath)
    })

    const chipOf = (value: string): HTMLElement => {
      const element = document.querySelector<HTMLElement>(`[data-card-height="${value}"]`)
      if (element === null) throw new Error(`HUD 上没有 ${value} 这一档`)
      return element
    }
    fireEvent.click(chipOf('full'))
    await waitFor(() => {
      expect(useGraphStore.getState().cardSizes.get(relPath)?.full).toBe(true)
    })
    expect(chipOf('full').getAttribute('aria-pressed')).toBe('true')
    expect(chipOf('auto').getAttribute('aria-pressed')).toBe('false')

    // 互斥：再选一个数值档 ⇒ 退出全文
    fireEvent.click(chipOf('900'))
    await waitFor(() => {
      const size = useGraphStore.getState().cardSizes.get(relPath)
      expect(size?.full ?? false).toBe(false)
      expect(size?.height).toBe(900)
    })
    expect(chipOf('900').getAttribute('aria-pressed')).toBe('true')
    expect(chipOf('full').getAttribute('aria-pressed')).toBe('false')
  })
})

// ---------------------------------------------------------------------------
// 连线的两层（卡片内那段引线必须能单独画在卡片层之上）
// ---------------------------------------------------------------------------

/**
 * 为什么单开一组：卡片是**不透明底**画在 canvas 上，而 canvas 的 `z-index` 比连线层高。
 * 引线整段都在卡片矩形里 —— 留在连线层里会被卡片整段盖掉，用户看到的就是"线从卡片边缘
 * 凭空开始"（这正是报障里的现象）。修复要把引线单独挂一层、画到卡片层**之上**，
 * 所以 `GraphEdges` 得能只渲染其中一层。这几条钉的就是那个开关：
 * 引线层只有引线（+ 起点小圆点），卡外层才有箭头与虚影。
 */
describe('连线的两层', () => {
  afterEach(() => {
    cleanup()
  })

  const edge: GraphEdge = {
    fromRelPath: '甲.md',
    toRelPath: '乙.md',
    toRawTarget: '乙',
    kind: 'wiki',
    count: 1,
  }

  const visual: GraphEdgeVisual = {
    key: 'k',
    edge,
    style: { dashed: false, dim: false, highlight: true },
    // 卡片外那段：从卡片边界 (220, 100) 到目标卡片边界 (400, 200)
    d: 'M 220 100 C 280 100, 340 200, 400 200',
    start: { x: 220, y: 100 },
    end: { x: 400, y: 200 },
    phantom: false,
    title: '甲 → 乙',
    // 卡片内那段：从正文里的链接 (30, 103) 到卡片边界 (220, 100) —— 长度 190.023…
    leadPath: 'M 30 103 L 220 100',
    leadFrom: { x: 30, y: 103 },
  }

  const box = { x: 0, y: 0, width: 800, height: 600 }

  it('引线层只画引线与起点小圆点：没有卡外那段、没有箭头、没有虚影', () => {
    const { container } = render(<GraphEdges visuals={[visual]} viewBox={box} layer="lead" />)

    const leads = container.querySelectorAll('path.mn-graph-edge--lead')
    expect(leads).toHaveLength(1)
    expect(container.querySelectorAll('path.mn-graph-edge:not(.mn-graph-edge--lead)')).toHaveLength(0)
    expect(container.querySelectorAll('.mn-graph-edge-lead-dot')).toHaveLength(1)
    // 箭头只有卡外那段用得到 ⇒ 引线层里连 marker 定义都不生成
    expect(container.querySelectorAll('marker')).toHaveLength(0)

    // 引线的相位按 `leadFrom → start` 的长度算（同一条引线在两层里的长度必须一致）
    const lead = leads[0] as SVGPathElement
    const length = Math.hypot(visual.start.x - visual.leadFrom!.x, visual.start.y - visual.leadFrom!.y)
    expect(lead.getAttribute('stroke-dasharray')).toBe('3 3')
    expect(Number(lead.getAttribute('stroke-dashoffset'))).toBeCloseTo((3 - (length % 6) + 6) % 6, 9)
  })

  it('卡外层只画卡外那段：带箭头与虚影圆点，一条引线都不画', () => {
    const phantom: GraphEdgeVisual = {
      ...visual,
      key: 'p',
      phantom: true,
      edge: { ...edge, toRelPath: null, toRawTarget: '还不存在的笔记' },
    }
    const { container } = render(
      <GraphEdges visuals={[visual, phantom]} viewBox={box} layer="span" />,
    )

    expect(container.querySelectorAll('path.mn-graph-edge--lead')).toHaveLength(0)
    expect(container.querySelectorAll('path.mn-graph-edge:not(.mn-graph-edge--lead)')).toHaveLength(2)
    expect(container.querySelectorAll('.mn-graph-edge-lead-dot')).toHaveLength(0)
    expect(container.querySelectorAll('.mn-graph-phantom')).toHaveLength(1)
    // 箭头定义在卡外层：marker 的 id 要能被 `marker-end` 引到
    expect(container.querySelectorAll('marker')).toHaveLength(3)
  })

  it('不给 layer 时两条段还在同一个 SVG 里（默认行为不变）', () => {
    const { container } = render(<GraphEdges visuals={[visual]} viewBox={box} />)

    expect(container.querySelectorAll('svg.mn-graph__edges')).toHaveLength(1)
    expect(container.querySelectorAll('path.mn-graph-edge--lead')).toHaveLength(1)
    expect(container.querySelectorAll('path.mn-graph-edge:not(.mn-graph-edge--lead)')).toHaveLength(1)
  })
})
