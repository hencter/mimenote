/**
 * 知识图谱画布（M3 的核心功能，ADR-0021 起改为 canvas 渲染）。
 *
 * ## 两种视图
 *
 * - **焦点视图（默认）**：以**当前打开的笔记**为圆心，只画与它相关的子图，跳数可调（1..5，双向）。
 *   用户的原话是"进入后只有先关联的图谱，然后图谱深度是可以调节的"，并且"每个节点是完整的
 *   markdown 预览"—— 所以这一视图里每张卡片正面就是那篇笔记的正文（标题/段落/列表/引用/代码/
 *   表格/图片占位/提示框，与阅读视图同一套块清单），排版在 `canvas/` 那一层。
 * - **整个 Vault**：原来的全库视图（文件夹装箱 + 手工拖动 + 折叠容器），卡片是紧凑卡片。
 *   它没有被删掉，只是不再是默认入口 —— 几千张卡片适合"看结构"，不适合"看内容"。
 *
 * ## 为什么改成 canvas
 *
 * 原来每张卡片是一个 DOM 元素：整篇正文的富文本要变成几千个节点，浏览器排版一帧就要几十毫秒，
 * 于是只能做"虚拟化 + 卡片摘要"，而摘要恰恰是用户不满意的部分（他要的是完整预览）。
 * canvas 里画 300 张卡片是一串 `fillText`，量级是毫秒；缩放时文字**重新排版**而不是被放大成
 * 模糊的一团。代价是命中测试、光标、可访问性都要自己来 —— 见下面的"交互"与"键盘"两节。
 *
 * ## 三层各画什么（坐标只有一套）
 *
 * 1. **canvas**（`canvas/paint.ts`）：卡片本体与卡片里的正文；
 * 2. **SVG**（`GraphEdges`）：连线 —— 保留正交折线、箭头、悬空链接的虚影与目标名，
 *    这些都已经实现且更细腻，用 canvas 重画直线会是一种退步（所以画笔收到的 `edges` 是空数组）；
 * 3. **DOM**（文件夹容器标题）：全库视图里可点、可折叠的文件夹头，几百个 DOM 节点不是负担。
 *
 * 三层的坐标关系只有一条：`屏幕 = 世界 × zoom + 偏移`（`viewport.ts`），
 * canvas 自己算，SVG 与 DOM 走同一套 CSS `transform`（`transform-origin: 0 0`）。
 *
 * ## 交互（canvas 之后必须自己实现的那部分）
 *
 * - 命中的是**世界坐标**里的卡片矩形（`cardAt` / `rectIndex`），因此缩放与平移不影响点击；
 * - 空白处拖动 = 平移画布，空白处单击 = 取消选中（同时松开被按住的卡片，见「失去焦点」那条）；
 * - 卡片上拖动 = 移动卡片（**只有全库视图**：焦点视图的位置就是"离中心几跳"，拖动会把它变成谎话）；
 *   焦点视图里拖动 = **把这张卡片按住**（力场不再移动它）；选中另一张或点空白处 = 它失去焦点，
 *   随即被松开、继续漂浮（用户原话："聚焦后的失去焦点继续松开卡片，保持浮动"）；
 * - 卡片上单击 = 选中（相关连线高亮 + HUD 出现它的高度档与「浮窗打开」）；**卡片正面就是完整
 *   正文**，所以不再有侧边预览面板（ADR-0025 把它移除了）；双击 = 进编辑器打开；
 * - 悬停在正文里某段 `[[链接]]` 上时，**对应的那条连线**提亮、那段文字也描边 ——
 *   找线不再需要"从卡片边缘往回猜"。
 * - 焦点视图里"换圆心"不需要额外按钮：双击某张卡片就打开了它，圆心自然跟着当前笔记走。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

import { openNote } from '@/app/actions'
import { GRAPH_COMMAND_IDS } from '@/app/builtin-commands'
import { commands } from '@/app/commands'
import { isTextEntryTarget } from '@/app/keymap'
import { ContextMenu, type ContextMenuItem } from '@/components/ContextMenu'
import { Icon } from '@/components/Icon'
import { describeError, type GraphEdge, type GraphNode } from '@/ipc/types'
import {
  MAX_EGO_DEPTH,
  MIN_EGO_DEPTH,
  startGraphAutoRefresh,
  useGraphStore,
} from '@/state/graph-store'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'
import { GraphEdges } from './GraphEdges'
import { ancestorFolders, buildGraphFindIndex, findGraphMatches } from './find'
import {
  canvasMeasure,
  cardChrome,
  createCardLayoutCache,
  layoutCard,
  titleOnlyCardHeight,
  type CardLayout,
  type MeasureText,
} from './canvas/measure'
import { readPalette, type GraphPalette } from './canvas/palette'
import { paintGraph, cardResizeHandleRect, type PaintNode } from './canvas/paint'
import { createTokenReader } from './canvas/probe'
import { DEFAULT_METRICS } from './canvas/text-layout'
import { FORCE_PRESETS } from './force-presets'
import { ForcePanel } from './ForcePanel'
import { createForceSimulation, type ForceSimulation } from './force'
import { outerExit, routeEdgePath, routingKind } from './edge-routing'
import {
  leadPathBetween,
  linkEdgeGeometry,
  linkZones,
  normalizeLinkText,
  type LinkZone,
} from './link-edge'
import { FloatingNote } from './FloatingNote'
import {
  OVERSCAN,
  applyManualPositions,
  buildEdgeVisuals,
  buildLayout,
  buildRectIndex,
  edgeKey,
  queryIndex,
  queryViewport,
  type EdgeStyle,
  type GraphCardBox,
  type GraphEdgeVisual,
  type GraphFolderBox,
  type Point,
  type Rect,
} from './layout'
import {
  layoutEgo,
  visibleCards,
  type EgoCardBox,
  type EgoSize,
} from './layout-ego'
import {
  canvasSize,
  rectHit,
  toWorld,
  transformOf,
  visibleWorld,
} from './viewport'

import './graph.css'

/** 滚轮缩放的灵敏度（`factor = exp(-deltaY * k)`）。 */
const WHEEL_ZOOM_K = 0.0016

/** 平移拖动与"单击空白处关闭预览"之间的位移阈值。 */
const CLICK_SLOP_PX = 3

/**
 * 拖动卡片时把力场加热到的强度（`ForceSimulation.heat`）。
 *
 * 为什么要加热：打开图谱时 `settle()` 已经把强度跑到 0，**力全部停摆**。被拖的那张卡片是
 * `fixed` 的（位置由光标决定，本来就不受力），但"邻居让开"必须靠力 —— 只有硬碰撞会推人，
 * 手感就是"撞上去才动、其余时候整幅图是死的"。0.3 是实测的形状：足以让斥力与弹簧推动邻居
 * （被连接的卡片会跟着走），又不会让整幅图重新洗牌。
 */
const DRAG_HEAT = 0.3

/** 每次 pointermove 推进几步：一步推不完"多个重叠对"，太多又会让一次移动滑出去很远。 */
const DRAG_STEPS = 2

/** 松开卡片、把它重新交给力场时的热度：比拖动时更高，"松开"才看起来真的松开了。 */
const RELEASE_HEAT = 0.6

/**
 * 开着"漂浮"时力场强度的**底值**：每帧把强度抬到至少这个数。
 *
 * 为什么需要它：`settle()` 会把强度跑到 0，之后`step()` 一点点力都没有 —— 实测每步每张卡片
 * 只移动 0.003px，也就是说"漂浮"这个开关打开与关掉**看起来完全一样**（用户说的"整体非常僵硬"
 * 里有一半是这件事）。给一个很小的底值让力场始终醒着：实测 0.2 时每步平均 0.12px
 * （20fps ≈ 2.3px/秒）—— 是看得见的缓慢呼吸，而不是乱飞。
 */
const FLOAT_HEAT_FLOOR = 0.2

/** 焦点视图的卡片宽度（世界坐标）：一屏放得下 3~4 张，正文一行 ≈ 34 个汉字。 */
const EGO_CARD_WIDTH = 320

/**
 * 焦点视图卡片的高度上限。
 *
 * 为什么要有上限：一篇长笔记排完可能有两千像素高，一张卡片就能把整个环撑到屏幕外，
 * 于是"离中心几跳"这个唯一的信息反而看不见了。超出就按**块**截断（`layoutCard` 会在末尾补一行 `…`）。
 */
const EGO_CARD_MAX_HEIGHT = 420

/** 正文还没读到的节点（读失败、或刚好被删）用这个尺寸占位：比空白好，也不会让环半径乱跳。 */
const EGO_FALLBACK_SIZE: EgoSize = { width: EGO_CARD_WIDTH, height: 76 }

/** 全库视图紧凑卡片里标签那一行最多显示几个字符（超出截断加省略号）。 */
const COMPACT_TAG_CHARS = 20

/**
 * 跳数 → 线宽 / 不透明度（ADR-0028）。
 *
 * 判据是"这条边最远牵到第几跳"（两端跳数的较大者）：一跳的线最实最粗、越远越细越淡。
 * 为什么用连续的一组数而不是"虚实两档"：环布局里"几跳"是唯一的结构信息，
 * 让线自己把它画出来，比在 tooltip 里写一遍有用得多。
 */
const EDGE_WEIGHT_BY_HOP: readonly { width: number; opacity: number }[] = [
  { width: 2.2, opacity: 0.98 }, // 0：理论上不存在（圆心只有自己），留着占位免得索引错位
  { width: 2, opacity: 0.95 },
  { width: 1.5, opacity: 0.72 },
  { width: 1.25, opacity: 0.55 },
]

/** 更远（4 跳及以上）统一落到最轻的那一档。 */
const EDGE_WEIGHT_FAR = { width: 1, opacity: 0.4 }

/**
 * 淡化 / 强调是**在跳数权重上调制**，而不是替换它。
 *
 * 为什么必须这样：如果"强调"直接把宽度钉成 2.2、"淡化"直接钉成 1/0.16，
 * 那么跳数权重永远看不见 —— 与圆心相关的边全是强调档、环与环之间的边全是淡化档，
 * 而这两档恰好覆盖了所有边（"越远越细越淡"就成了空话，图上没人能看出来）。
 * 乘法还有第二个好处：强调过的二跳边仍然比强调过的一跳边细一点，
 * "这条线牵得多远"在**任何**状态下都还在。
 */
const EDGE_DIM_FACTOR = { width: 0.7, opacity: 0.3, minWidth: 1 }
const EDGE_HIGHLIGHT_GAIN = { minWidth: 2.2, opacity: 0.22 }

function edgeWeight(hop: number): { width: number; opacity: number } {
  return EDGE_WEIGHT_BY_HOP[hop] ?? EDGE_WEIGHT_FAR
}

/** 键盘上下左右选卡片时的最大搜索距离（世界坐标）。 */
const KEYBOARD_REACH = 2400

/**
 * 漂浮的刷新率（每秒几帧）。
 *
 * 位置一变，画布上的卡片与 SVG 层的连线都要重画，而后者是 React 渲染 —— 20fps 下
 * "缓慢漂移"看起来已经是连续的，代价只有 60fps 的三分之一。要更顺就得把连线也搬到 canvas
 * （ADR-0023 的"下一步"）。
 */
const FLOAT_FPS = 20

/**
 * 浮动面板的层级基数。
 *
 * 面板之间的顺序由 store 里的 `z` 决定（点一下置顶）；基数本身要高于画布上的一切
 * （HUD 3 / 引线 2 / 卡片 1）。曾经有一个 z-index 5 的停靠预览面板（`.mn-graph-preview`），
 * 移除它之后这个基数保留不动：层级表是稳定的外部契约（CSS 与测试都在数它），
 * 没必要为了"数值连续"去挪动其它层。
 */
const FLOAT_PANE_Z = 6

/** 浮动面板里最上面的那个（只有它响应 `Esc`，也只有它有醒目的边框）。 */
function topPaneZ(panes: readonly { z: number }[]): number {
  return panes.reduce((max, pane) => Math.max(max, pane.z), 0)
}

/**
 * "正文高度上限"的几档（HUD 上的小胶囊）。
 *
 * 为什么给档位而不是一个滑块：卡片高度是**内容决定**的（短笔记撑不成高卡片），
 * 上限只在"这篇太长、我只要看开头"时才有意义；档位比连续滑块更容易一眼选中想要的那个量级。
 * `null` = 自动（回到默认上限）；`'full'` = **全文**（不截断，整篇都排进卡片 ——
 * 长文的卡片会非常高，这正是用户要的"卡片完整展示全文"）。
 * 想随手调就拖卡片右下角的把手（宽高同时改，见 `setCardSize`）。
 */
const CARD_HEIGHT_CHOICES: readonly { label: string; value: number | null | 'full'; hint: string }[] = [
  { label: '自动', value: null, hint: '按默认上限截断（长笔记会在末尾补一行 …）' },
  { label: '短', value: 400, hint: '只留开头几段（一屏能放下更多卡片）' },
  { label: '中', value: 900, hint: '中等长度笔记基本能看全' },
  { label: '长', value: 2000, hint: '尽量看全（卡片会很高）' },
  { label: '全文', value: 'full', hint: '不截断：整篇笔记都画在卡片上（长文的卡片会非常高）' },
]

/**
 * 把模拟给出的位置换算成卡片矩形。
 *
 * ⚠️ `ForceSimulation.positions()` 给的是**左上角**（它内部已经做过 `中心 − 尺寸/2`），
 * 这里**不能**再减一次 —— 真实踩过：多减半张卡片之后整幅图看着"没对齐"，
 * 而错位量恰好是半个尺寸，很像布局算错了，查起来绕了一圈。
 */
function applySimulation(
  cards: readonly EgoCardBox[],
  positions: ReadonlyMap<string, Point>,
): Map<string, Rect> {
  const rects = new Map<string, Rect>()
  for (const card of cards) {
    const topLeft = positions.get(card.relPath)
    rects.set(
      card.relPath,
      topLeft === undefined
        ? card.rect
        : { x: topLeft.x, y: topLeft.y, width: card.rect.width, height: card.rect.height },
    )
  }
  return rects
}

/**
 * 当前布局里**重叠的卡片对数**。
 *
 * 为什么值得算一遍并暴露出来：用户的反馈是"笔记之间应该有碰撞！"—— 碰撞约束对不对，
 * 唯一说了算的判据就是"矩形还相交吗"。把它算成这个数之后，界面调试、组件测试与端到端
 * 都能直接断言 `0`，而不是靠肉眼看画布。
 *
 * 代价：`O(n²)` 的两两判交。ego 子图的节点上限是 300（宿主保证），最坏 4.5 万次简单比较，
 * 亚毫秒级；因此不做空间索引 —— 加一层网格只会让这段代码更难读，收益在噪声里。
 */
function countOverlaps(rects: ReadonlyMap<string, Rect>): number {
  const list = [...rects.values()]
  let overlaps = 0
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i]
    if (a === undefined) continue
    for (let j = i + 1; j < list.length; j += 1) {
      const b = list[j]
      if (b === undefined) continue
      // 轴对齐矩形相交：两个轴都必须有正的重叠量（贴边不算重叠）
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) {
        overlaps += 1
      }
    }
  }
  return overlaps
}

/** 一组卡片的包围盒（力导向落定之后用它"适应窗口"）。 */
function boundsOfRects(rects: ReadonlyMap<string, Rect>): Rect | null {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const rect of rects.values()) {
    minX = Math.min(minX, rect.x)
    minY = Math.min(minY, rect.y)
    maxX = Math.max(maxX, rect.x + rect.width)
    maxY = Math.max(maxY, rect.y + rect.height)
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) }
}

/**
 * 一条边在正文里**可能**被写成哪几种样子（用于把边匹配到某一段 `[[…]]` 文字）。
 *
 * 三种来源，按"越具体越先试"排：用户写的原始目标（`[[笔记/丙|别名]]` 里那一整段不算、
 * 锚点已经剥离）、目标笔记的标题、以及路径主干（`项目/子项目/细节.md` → `细节`）。
 * 别名那一侧由写笔记的人决定，我们无法穷举 —— 匹配不到就如实降级（ADR-0023）。
 */
function edgeTargets(edge: GraphEdge, to: GraphNode): string[] {
  const basename = (to.relPath.split('/').pop() ?? to.relPath).replace(/\.(md|markdown)$/i, '')
  return [...new Set([edge.toRawTarget, to.title, basename, to.relPath].filter((text) => text !== ''))]
}

/**
 * 两个悬停热区是否同一个（逐字段比较）。
 *
 * 为什么不能靠引用：`linkZones` 的返回每次 memo 重建都换对象引用，引用比较会让
 * `setHoveredLink` 每个 pointermove 都触发一次重渲染 —— 而内容没变时一个像素都不该重画。
 */
function sameHoveredLink(
  a: { relPath: string; zone: LinkZone; edgeKey: string } | null,
  b: { relPath: string; zone: LinkZone; edgeKey: string } | null,
): boolean {
  if (a === null || b === null) return a === b
  return (
    a.relPath === b.relPath &&
    a.edgeKey === b.edgeKey &&
    a.zone.x === b.zone.x &&
    a.zone.y === b.zone.y &&
    a.zone.width === b.zone.width &&
    a.zone.height === b.zone.height
  )
}

interface PointerState {
  pointerId: number | undefined
  button: number
  lastX: number
  lastY: number
  moved: boolean
  /** 按下的位置在**世界坐标**里的点（判断"点到了哪张卡片"）。 */
  startWorldX: number
  startWorldY: number
  /** 按在卡片上时：那张卡片的路径与"按下点相对卡片左上角"的偏移（拖动时保持不跳）。 */
  card: { relPath: string; grabX: number; grabY: number } | null
  /**
   * 按在**右下角的缩放手柄**上时：那张卡片与"它当时的左边界 / 上边界"（世界坐标）。
   *
   * 为什么与拖动分开记：两者的意图完全不同（一个搬位置、一个改大小），
   * 而手柄落在卡片**内部** —— 不先判它，拖手柄就会变成拖动卡片。
   * 左边界与上边界都记：手柄拖动同时改**宽与高**（宽度 = 光标 − 左边界，
   * 高度 = 光标 − 上边界；"只能调宽度"是用户报回来的缺陷）。
   */
  resize: { relPath: string; left: number; top: number } | null
}

/** 全库视图紧凑卡片的附加行：目录、出入度、标签。 */
function compactLinesFor(node: GraphNode): string[] {
  const folder = node.folder === '' ? '（Vault 根）' : node.folder
  const degrees = `${node.outDegree} 出 · ${node.inDegree} 入`
  if (node.tags.length === 0) return [folder, degrees]
  const tags = node.tags.join(' ')
  return [
    folder,
    degrees,
    tags.length <= COMPACT_TAG_CHARS ? tags : `${tags.slice(0, COMPACT_TAG_CHARS)}…`,
  ]
}

export function GraphCanvas() {
  const rootPath = useVaultStore((state) => state.info?.rootPath ?? null)
  /** 焦点视图的圆心：当前打开的笔记（换笔记 = 换圆心，不需要单独的"设为中心"按钮）。 */
  const focusRoot = useNoteStore((state) => state.doc?.relPath ?? null)
  const themeId = useUiStore((state) => state.themeId)

  const mode = useGraphStore((state) => state.mode)
  const depth = useGraphStore((state) => state.depth)
  const ego = useGraphStore((state) => state.ego)
  const egoStatus = useGraphStore((state) => state.egoStatus)
  const egoError = useGraphStore((state) => state.egoError)
  const texts = useGraphStore((state) => state.texts)
  const cardSizes = useGraphStore((state) => state.cardSizes)
  const tension = useGraphStore((state) => state.tension)
  const edgeFromLink = useGraphStore((state) => state.edgeFromLink)
  /** 纯标题卡片（只画文件名，不排正文；见 store 里 `titleOnly` 的说明）。 */
  const titleOnly = useGraphStore((state) => state.titleOnly)
  /** 环向走线（ADR-0028）：同环的线沿环外弧走、跨环的线朝外鼓。 */
  const ringRouting = useGraphStore((state) => state.ringRouting)
  const floatingPanes = useGraphStore((state) => state.floatingPanes)
  /** 力导向的预设 id 与"是否持续漂浮"（两个偏好，见 `features/graph/force-presets.ts`）。 */
  const forcePresetId = useGraphStore((state) => state.forcePreset)
  const floating = useGraphStore((state) => state.floating)
  const status = useGraphStore((state) => state.status)
  const data = useGraphStore((state) => state.data)
  const error = useGraphStore((state) => state.error)
  const selected = useGraphStore((state) => state.selected)
  const view = useGraphStore((state) => state.view)
  const collapsed = useGraphStore((state) => state.collapsed)
  const manual = useGraphStore((state) => state.manual)
  const staleIndex = useGraphStore((state) => state.staleIndex)
  const refreshing = useGraphStore((state) => state.refreshing)
  const refreshNotice = useGraphStore((state) => state.refreshNotice)
  const viewport = useGraphStore((state) => state.viewport)
  const indexPhase = useLinksStore((state) => state.status.phase)

  const hostRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [panning, setPanning] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)
  /**
   * 悬停的 wikilink 热区（卡片 + 热区矩形 + 对应边的 key）。
   *
   * 一份状态喂两个消费者：SVG 连线层（提亮那条边）与 canvas 画笔（给那段文字描边）——
   * 两边看同一份，"高亮的字"与"高亮的线"才永远指的是同一条边。
   */
  const [hoveredLink, setHoveredLink] = useState<{ relPath: string; zone: LinkZone; edgeKey: string } | null>(null)
  /** 光标是否停在卡片的缩放手柄上（决定 nwse-resize 光标；手柄画在 canvas 上，光标只能自己来）。 */
  const [overResizeHandle, setOverResizeHandle] = useState(false)
  /**
   * 最近一次指针位置（屏幕坐标）。漂浮开着时卡片持续在动，指针不动也会从"指着这段 [[链接]]"
   * 变成"指着空白"—— 热区命中要按当前矩形重算（见 `tick` 那条 effect），重算需要这个点。
   */
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null)
  /**
   * 卡片右键菜单（`null` = 没打开）。
   *
   * 卡片画在 canvas 上、命中测试是组件自己做的，所以右键也必须自己接：
   * `onContextMenu` 里先按世界坐标找出是哪一张，再把菜单弹在光标处。
   * 菜单项全部指向**既有入口**（`openNote` / `openFloating` / `unpinCards` / 尺寸档），
   * 不在这里重写任何动作。
   */
  const [cardMenu, setCardMenu] = useState<{ relPath: string; x: number; y: number } | null>(null)
  /** 「力度管理」面板是否打开（瞬时状态，不持久化）。 */
  const [forcePanelOpen, setForcePanelOpen] = useState(false)
  /** 上一帧真正画出来的卡片数（视口裁剪之后）—— 只用于诊断属性，不参与渲染决策。 */
  const [paintedCards, setPaintedCards] = useState(0)
  const pointerRef = useRef<PointerState | null>(null)

  /**
   * 量字用的上下文（离屏 canvas）。
   *
   * 为什么单独一个：量宽只需要 `measureText`，与真正的画布无关；而**必须用同一个字族与字号**
   * （`fontString` 的缺省族），否则"量出来的宽度"与"画出来的字"会分家（换行位置因此偏移）。
   * 排版缓存也挂在这里：平移/缩放每帧都会问同一批卡片的排版，缓存让这条路只跑一次。
   */
  const layoutRef = useRef<{ measure: MeasureText; cache: ReturnType<typeof createCardLayoutCache> } | null>(
    null,
  )
  if (layoutRef.current === null && typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    layoutRef.current = {
      measure: context === null ? () => 0 : canvasMeasure(context),
      cache: createCardLayoutCache({ maxEntries: 400 }),
    }
  }
  const measure = layoutRef.current?.measure ?? null

  // -------------------------------------------------------------------------
  // 数据加载
  //   · 焦点视图：以当前笔记为圆心拉子图（含每篇正文）
  //   · 全库视图：原来的 `graph_data`
  //   · 保存成功 / 索引就绪 → 由 store 的自动刷新订阅补齐（见 startGraphAutoRefresh）
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (rootPath === null) {
      useGraphStore.getState().clear()
      return
    }
    if (mode === 'focus') {
      // `keepView` 由 store 判断（同一个圆心 + 同一个跳数才谈得上"保留视角"）
      void useGraphStore.getState().loadEgo(focusRoot, { keepView: true })
      return
    }
    const state = useGraphStore.getState()
    void state.load(rootPath, {
      indexBuilding: useLinksStore.getState().status.phase === 'building',
      keepView: state.rootPath === rootPath && state.data !== null,
    })
  }, [rootPath, mode, focusRoot, depth])

  // 保存成功 / 索引就绪后的自动刷新。装在这里、卸载即取消：
  // 模块级监听会永不清理，而"画布是否可见"这个上下文只有组件知道。
  useEffect(() => startGraphAutoRefresh(), [])

  // -------------------------------------------------------------------------
  // 布局（纯函数 + useMemo：平移/缩放**不会**让这里重算）
  // -------------------------------------------------------------------------

  const autoLayout = useMemo(
    () => (mode === 'vault' && data !== null ? buildLayout(data.nodes, collapsed) : null),
    [mode, data, collapsed],
  )
  // 手工位置是 O(n) 的坐标覆盖（不重建文件夹树），拖动时只有这一步会重跑
  const vaultLayout = useMemo(
    () => (autoLayout === null ? null : applyManualPositions(autoLayout, manual)),
    [autoLayout, manual],
  )

  const cardsById = useMemo(() => {
    const map = new Map<string, GraphCardBox>()
    for (const card of vaultLayout?.cards ?? []) map.set(card.relPath, card)
    return map
  }, [vaultLayout])

  const rectIndex = useMemo(
    () => (vaultLayout === null ? null : buildRectIndex(vaultLayout.cards)),
    [vaultLayout],
  )

  /**
   * 焦点视图的几何：先把每篇正文排成卡片（尺寸由此得出），再摆同心环。
   *
   * 顺序不能反：环半径取决于"卡片有多大"，而卡片高度取决于正文排完有多高。
   * 正文是**一次性**跟着子图回来的（`loadEgo` 一起读），所以这里不会出现"排版到一半、
   * 环半径反复变"的跳动 —— 只有读不到正文的那几篇用兜底尺寸。
   *
   * 每张卡片的宽度与"正文高度上限"都取自 store 里的**手工尺寸**（可调大小，ADR-0023）：
   * 用户拉宽一张卡片之后，这里排出来的高度会跟着变（换行变了），环半径也随之外扩。
   */
  const egoLayout = useMemo(() => {
    if (mode !== 'focus' || ego === null || measure === null || layoutRef.current === null) return null
    const cache = layoutRef.current.cache
    const sizes = new Map<string, EgoSize>()
    const layouts = new Map<string, CardLayout>()

    for (const node of ego.data.nodes) {
      const manual = cardSizes.get(node.relPath)
      const width = manual?.width ?? EGO_CARD_WIDTH
      // 纯标题模式：不排正文（layouts 里刻意没有它，画笔退成"只有标题行"的壳）。
      // 高度由同一份壳几何推出（`titleOnlyCardHeight`），不手写数字；
      // 正文排版（markdown 解析 + 折行）的开销这一模式下全省掉。
      if (titleOnly) {
        sizes.set(node.relPath, { width, height: titleOnlyCardHeight() })
        continue
      }
      const text = texts.get(node.relPath)
      if (text === undefined) {
        sizes.set(node.relPath, EGO_FALLBACK_SIZE)
        continue
      }
      // 「全文」开关：不截断（`layoutCard` 对非有限上限按"不截断"处理，缓存键也随之分开）。
      // 长文的卡片会非常高 —— 这正是用户要的效果（"卡片完整展示全文"）。
      const maxHeight =
        manual?.full === true ? Number.POSITIVE_INFINITY : (manual?.height ?? EGO_CARD_MAX_HEIGHT)
      const card = cache.get(
        { relPath: node.relPath, title: node.title, text, width, maxHeight },
        () =>
          layoutCard({
            relPath: node.relPath,
            title: node.title,
            text,
            width,
            maxHeight,
            measure,
          }),
      )
      layouts.set(node.relPath, card)
      sizes.set(node.relPath, { width: card.width, height: card.height })
    }

    const layout = layoutEgo({
      nodes: ego.data.nodes,
      edges: ego.data.edges,
      root: ego.root,
      depth: ego.depth,
      sizes,
      fallbackSize: EGO_FALLBACK_SIZE,
    })
    return { layout, layouts }
  }, [mode, ego, texts, measure, cardSizes, titleOnly])

  // -------------------------------------------------------------------------
  // 视口换算与"屏幕上有哪些卡片"
  // -------------------------------------------------------------------------

  const transform = useMemo(() => transformOf(view, viewport), [view, viewport])
  const visibleWorldRect = useMemo(() => visibleWorld(transform, OVERSCAN), [transform])

  // -------------------------------------------------------------------------
  // 力导向浮动态（ADR-0023）
  //
  // 位置**不进 React state**：漂移是每帧都在变的，把它塞进 state 会让整棵画布跟着重渲染。
  // 这里把"当前世界矩形"放在 ref 里，由 `tick`（下面那个低速时钟）与直接重画来驱动 ——
  // 命中测试读的也是同一份 ref，因此"看到的"和"点得中的"永远是同一个位置。
  // -------------------------------------------------------------------------

  /**
   * 力导向的**当前参数**：来自 store（预设或用户手调过的那一份）。
   *
   * 为什么不再 `forcePreset(id).params` 现算：面板上的滑杆改了参数之后必须立刻生效，
   * 而 store 里那份才是"当前这一套力度"的唯一真相（预设只是它的起点）。
   */
  const forceParams = useGraphStore((state) => state.forceParams)
  /** 被用户按住的卡片（ADR-0023）：力场不再移动它们，但它们仍然推开别人。 */
  const pins = useGraphStore((state) => state.pins)
  const positionsRef = useRef<Map<string, Rect>>(new Map())
  const simRef = useRef<ForceSimulation | null>(null)
  const [tick, setTick] = useState(0)

  /**
   * 被按住卡片的**最新**位置（每次渲染刷新）。
   *
   * 为什么必须走 ref、不能把它写进下面那条 effect 的依赖：`pins` 是"每个 pointermove 都可能变"的状态。
   * 一旦成为依赖，拖动过程中模拟会被**反复重建**（每次都从同心环的种子重新落定），于是：
   * 卡片每一帧都被拽回原位、邻居永远来不及被推开、镜头还会跟着重新取景 —— 用户看到的就是
   * "拖拽卡片没有变动位置、没有碰撞推动卡片、整体非常僵硬"。改成 ref 之后：
   * 拖动只改"活着的那个模拟"（`pin` + `heat` + 推进），而真正的重建
   * （换力度档、换圆心、改参数）仍然以用户摆好的位置为**种子**。
   */
  const pinsRef = useRef(pins)
  pinsRef.current = pins

  /** 正在被拖动的那张卡片（松手时把最终位置写回 store；拖动过程中不写，免得每个 pointermove 都重渲染）。 */
  const draggedPinRef = useRef<{ relPath: string; center: { x: number; y: number } } | null>(null)
  /**
   * 拖动中的卡片路径（用于**画在最上层**，见 `paintNodes`）。
   *
   * 与 `draggedPinRef` 分开：那个是"松手时要落盘的数据"（不该触发渲染），这个纯粹是画笔的入参。
   */
  const [dragging, setDragging] = useState<string | null>(null)

  /**
   * 种子：同心环布局给出的位置。
   *
   * 这就是 ADR-0021 与力导向共存的方式 —— 环布局保证"离中心几跳"一眼可分且每次打开都一样，
   * 力导向只负责**松弛**（张力拉紧、斥力分开、向心力收拢）。因此几何仍然可复现：
   * 同一份数据 + 同一组参数 ⇒ 同一份位置。
   */
  const seedKey = useMemo(() => {
    if (egoLayout === null) return ''
    return egoLayout.layout.cards
      .map(
        (card) =>
          `${card.relPath}\u0001${Math.round(card.rect.x)},${Math.round(card.rect.y)},${Math.round(card.rect.width)},${Math.round(card.rect.height)}`,
      )
      .join('\u0002')
  }, [egoLayout])

  useEffect(() => {
    if (mode !== 'focus' || egoLayout === null || ego === null) {
      simRef.current = null
      positionsRef.current = new Map()
      return
    }
    const cards = egoLayout.layout.cards
    const held = pinsRef.current
    const nodes = cards.map((card) => {
      // 被按住的卡片以**用户摆下的位置**为种子，而不是环上的原位：重建（换档 / 改参数）时
      // 用户手动摆好的排布必须活下来。没被按住的仍然从同心环出发（那是可复现性的来源）。
      const pin = held.get(card.relPath)
      return {
        relPath: card.relPath,
        // 模拟跑在**中心点**上，卡片矩形由尺寸还原（见 force.ts 的说明）
        x: pin?.x ?? card.rect.x + card.rect.width / 2,
        y: pin?.y ?? card.rect.y + card.rect.height / 2,
        width: card.rect.width,
        height: card.rect.height,
        hop: card.hop,
        // 圆心那一篇钉在原点：用户打开图谱时希望"当前这篇"始终在中心
        fixed: card.relPath === ego.root || pin !== undefined,
      }
    })
    const edges = ego.data.edges
      .filter((edge) => edge.toRelPath !== null)
      .map((edge) => ({ from: edge.fromRelPath, to: edge.toRelPath ?? '' }))
    const sim = createForceSimulation({ nodes, edges, params: forceParams })
    // 先**确定性地落定**：打开图谱时不该看到一团正在乱飞的卡片（ADR-0021 的"空间记忆"
    // 要求位置可复现，而"跑多少步"是输入的一部分）。
    sim.settle()
    simRef.current = sim
    const rects = applySimulation(cards, sim.positions())
    positionsRef.current = rects
    // "适应窗口"必须用**落定之后**的包围盒：力场会把环收紧（默认档实测约收三分之二），
    // 用环的包围盒去 fit 会让整幅图偏在一角。键里**只有"图形本身"变了才重新取景**
    // （圆心 / 深度 / 力度档），特意不含 `pins`：按住或拖动一张卡片不该让镜头跳一下。
    const bounds = boundsOfRects(rects)
    if (bounds !== null) {
      useGraphStore.getState().setEgoBounds(bounds)
      useGraphStore
        .getState()
        .autoFitBounds(`${ego.root}\u0000${ego.depth}\u0000${forcePresetId}`, bounds)
    }
    setTick((value) => value + 1)
    // ⚠️ 依赖里**不能**有 `pins`（理由见 `pinsRef`）：它会随拖动每一帧变化，加进来就等于
    // "每拖动一像素就把整个模拟推倒重来"，那正是用户报的"拖不动 + 没有碰撞"。
  }, [mode, egoLayout, ego, forceParams, forcePresetId, seedKey])

  /**
   * 漂浮：以 **20fps** 推进模拟并重画。
   *
   * 为什么不是 60fps：位置一变，连线（SVG 层）也要跟着重画，而那是 React 渲染 ——
   * 20fps 下"缓慢漂移"看起来是连续的，代价却只有 1/3。要更顺的话下一步应当把连线也搬到
   * canvas 上（那时就能 60fps），这条取舍写在 ADR-0023 里。
   */
  useEffect(() => {
    if (mode !== 'focus' || !floating || egoLayout === null) return
    const interval = 1000 / FLOAT_FPS
    const timer = setInterval(() => {
      const sim = simRef.current
      if (sim === null) return
      // 每帧把强度抬到"漂浮底值"（见 `FLOAT_HEAT_FLOOR`）：不加这一笔的话，"漂浮"开着也
      // 只是每 50ms 白跑一次 `step()` —— 落定之后没有力，位置一动不动。
      sim.heat(FLOAT_HEAT_FLOOR)
      const moving = sim.step()
      if (!moving) return
      positionsRef.current = applySimulation(egoLayout.layout.cards, sim.positions())
      setTick((value) => value + 1)
    }, interval)
    return () => clearInterval(timer)
  }, [mode, floating, egoLayout, forceParams])


  /** 当前（可能是漂浮之后的）卡片矩形；没有模拟时退回布局给的确定性位置。 */
  const currentRect = useCallback(
    (relPath: string): Rect | null => {
      const simulated = positionsRef.current.get(relPath)
      if (simulated !== undefined) return simulated
      return egoLayout?.layout.cardsByPath.get(relPath)?.rect ?? null
    },
    [egoLayout],
  )

  /**
   * 立刻推进模拟 `steps` 步，并把新位置交给画笔。
   *
   * 为什么要"手动推进"而不是等漂浮循环（20fps）：拖动是离散事件（pointermove 每秒几十到一百多次），
   * 等定时器意味着"一秒钟只有 20 次反馈"，手感发涩；而且拖动时每一步都必须**当场**解掉碰撞，
   * 否则指针穿过邻居时看起来像"穿模"。相邻卡片的让位就发生在这一步里
   * （`step` 内部先算力、再解重叠，硬约束保证走完不重叠）。
   */
  const advanceSimulation = useCallback(
    (sim: ForceSimulation, steps: number) => {
      for (let index = 0; index < steps; index += 1) sim.step()
      if (egoLayout === null) return
      positionsRef.current = applySimulation(egoLayout.layout.cards, sim.positions())
      setTick((value) => value + 1)
    },
    [egoLayout],
  )

  /**
   * 松开所有被按住的卡片：重新交给力场（否则它们会永远停在手放下的地方）。
   *
   * 必须同时**加热**：`settle()` 之后强度是 0，只 `unpin` 的话卡片会"松开了但一动不动"，
   * 用户只会觉得按钮没生效；这不只是观感问题 —— 松开的语义就是"让力场重新接管它"。
   */
  const releasePins = useCallback(() => {
    const held = [...useGraphStore.getState().pins.keys()]
    if (held.length === 0) return
    useGraphStore.getState().unpinCards()
    const sim = simRef.current
    if (sim === null) return
    for (const relPath of held) sim.unpin(relPath)
    sim.heat(RELEASE_HEAT)
    advanceSimulation(sim, DRAG_STEPS * 4)
  }, [advanceSimulation])

  /**
   * 松开"除 keep 之外"所有被按住的卡片（保持浮动：加热后重新交给力场）。
   *
   * 与 `releasePins` 的差别只在"留一张"：选中另一张卡片时，上一张失去焦点、该松开；
   * 而新选中的这张若正被拖着，不该因为兄弟被松开而自己跳走。
   */
  const releasePinsExcept = useCallback(
    (keep: string | null) => {
      const held = [...useGraphStore.getState().pins.keys()].filter((relPath) => relPath !== keep)
      if (held.length === 0) return
      for (const relPath of held) useGraphStore.getState().unpinCards(relPath)
      const sim = simRef.current
      if (sim === null) return
      for (const relPath of held) sim.unpin(relPath)
      sim.heat(RELEASE_HEAT)
      advanceSimulation(sim, DRAG_STEPS * 4)
    },
    [advanceSimulation],
  )

  /**
   * 选中变化 = 上一张卡片"失去焦点"：松开它（们），让力场重新接管（用户原话：
   * "聚焦后的失去焦点继续松开卡片，保持浮动"）。
   *
   * 判据放在这里而不是 `select` 里：选中也可能来自键盘方向键 / 「定位笔记」/ 命令 ——
   * 无论哪条路换的选中，"上一张失去焦点就松开"都该成立。空看点空白处的松开在
   * `endPointer` 里单独做（那一次选中可能没变 —— 比如拖完卡片后本来就没选中任何东西）。
   */
  const previousSelectedRef = useRef(selected)
  useEffect(() => {
    const previous = previousSelectedRef.current
    previousSelectedRef.current = selected
    if (previous === selected) return
    releasePinsExcept(selected)
  }, [selected, releasePinsExcept])

  const visibleCardsList = useMemo<EgoCardBox[] | GraphCardBox[]>(() => {
    if (mode === 'focus') {
      return egoLayout === null ? [] : visibleCards(egoLayout.layout.cards, visibleWorldRect)
    }
    if (rectIndex === null) return []
    return queryIndex(rectIndex, visibleWorldRect)
  }, [mode, egoLayout, rectIndex, visibleWorldRect])

  const visibleSet = useMemo(
    () => new Set(visibleCardsList.map((card) => card.relPath)),
    [visibleCardsList],
  )

  const visibleFolders = useMemo(
    () => (vaultLayout === null ? [] : queryViewport(vaultLayout.folders, visibleWorldRect)),
    [vaultLayout, visibleWorldRect],
  )

  // -------------------------------------------------------------------------
  // 画笔的入参
  // -------------------------------------------------------------------------

  const paintNodes = useMemo<PaintNode[]>(() => {
    if (mode === 'focus') {
      if (egoLayout === null) return []
      const root = ego?.root ?? null
      const ordered =
        dragging === null
          ? egoLayout.layout.cards
          : // 拖动中的那张画在**最后**（最上层）：不这么做的话，把它拖到别的卡片上时会被盖住 ——
            // 用户看到的是"卡片没了"，而不是"我在搬它"（画布没有 z-index，顺序就是层级）。
            [
              ...egoLayout.layout.cards.filter((card) => card.relPath !== dragging),
              ...egoLayout.layout.cards.filter((card) => card.relPath === dragging),
            ]
      return ordered.map((card) => ({
        relPath: card.relPath,
        title: card.node.title,
        // 位置取**当前**（漂浮之后的）矩形；`tick` 是这里的刷新时钟
        rect: currentRect(card.relPath) ?? card.rect,
        hop: card.hop,
        isRoot: card.relPath === root,
        hasFocus: card.relPath === root || card.relPath === selected,
        layout: egoLayout.layouts.get(card.relPath) ?? null,
        // 纯标题模式：正文区整段留空（连"目录/度数"都不画 —— 这个档位要的就是"只有标题"）；
        // 否则正文读不到的那几篇退成紧凑卡片（标题 + 目录 + 度数），至少还能看出它是谁
        ...(titleOnly
          ? { compactLines: [] as readonly string[] }
          : egoLayout.layouts.has(card.relPath)
            ? {}
            : { compactLines: compactLinesFor(card.node) }),
      }))
    }
    if (vaultLayout === null || mode !== 'vault') return []
    return vaultLayout.cards.map((card) => ({
      relPath: card.relPath,
      title: card.node.title,
      rect: card,
      hop: 0,
      isRoot: false,
      hasFocus: card.relPath === selected,
      layout: null,
      compactLines: compactLinesFor(card.node),
    }))
  }, [mode, egoLayout, ego, vaultLayout, selected, currentRect, tick, dragging, titleOnly])

  /**
   * 连线：两种视图都交给 SVG 层（正交折线、箭头、悬空虚影都已经在那里实现好了）。
   *
   * **焦点视图**的连线从正文里那段 `[[链接]]` 文字出发（ADR-0023）：卡片内是虚线引线，
   * 出了卡片边界才变成实线/张力曲线。找不到对应文字时（正文没读到、卡片被截断、
   * 或者作者写的是 Markdown 链接）如实降级成"从卡片边界出发"，并在 tooltip 里说明。
   */
  const edgeVisuals = useMemo<GraphEdgeVisual[]>(() => {
    if (mode === 'focus') {
      if (egoLayout === null || ego === null) return []
      const root = ego.root
      const visuals: GraphEdgeVisual[] = []
      for (const edge of ego.data.edges) {
        // 悬空边在焦点视图里不画：目标不在这一圈里，"线到这里断了"的小刺只会让环更乱
        if (edge.toRelPath === null) continue
        const fromRect = currentRect(edge.fromRelPath)
        const toRect = currentRect(edge.toRelPath)
        const fromCard = egoLayout.layout.cardsByPath.get(edge.fromRelPath)
        const toCard = egoLayout.layout.cardsByPath.get(edge.toRelPath)
        if (fromRect === null || toRect === null || fromCard === undefined || toCard === undefined) {
          continue
        }
        const touchesRoot = edge.fromRelPath === root || edge.toRelPath === root
        const touchesSelected =
          selected !== null && (edge.fromRelPath === selected || edge.toRelPath === selected)
        const key = edgeKey(edge)
        // 悬停正文里某段 [[链接]] 时，它对应的那条边提亮（哪怕它原本是"环与环之间"的淡虚线）
        const hoveredEdge = hoveredLink !== null && hoveredLink.edgeKey === key
        const highlight = touchesRoot || touchesSelected || hoveredEdge
        const dim = !touchesRoot && !touchesSelected && !hoveredEdge
        /*
          语义色相（ADR-0028）：**以当前笔记为参照** —— 圆心指向别人是出链（暖），
          别人指向圆心是入链（冷），既不碰圆心也不碰选中的是环与环之间的上下文（中性）。
          为什么以圆心为参照：整幅图就是围着它组织的（"离它几跳"是唯一的结构维度），
          边在别处没有稳定的"出/入"可言（环与环之间是双向都算一跳的）。
        */
        const hue: 'out' | 'in' | 'context' =
          edge.fromRelPath === root ? 'out' : edge.toRelPath === root ? 'in' : 'context'
        // "这条边最远牵到第几跳" = 两端跳数的较大者
        const edgeHop = Math.max(fromCard.hop, toCard.hop)
        const base = edgeWeight(edgeHop)
        const weight = highlight
          ? {
              width: Math.max(base.width, EDGE_HIGHLIGHT_GAIN.minWidth),
              opacity: Math.min(1, base.opacity + EDGE_HIGHLIGHT_GAIN.opacity),
            }
          : dim
            ? {
                width: Math.max(EDGE_DIM_FACTOR.minWidth, base.width * EDGE_DIM_FACTOR.width),
                opacity: base.opacity * EDGE_DIM_FACTOR.opacity,
              }
            : base
        const style: EdgeStyle = {
          // 与中心无关的边画虚线：环与环之间的横线是"这两篇也互相提到"，属于上下文，不是主角
          dashed: !touchesRoot,
          dim,
          highlight,
          hue,
          width: weight.width,
          opacity: weight.opacity,
        }
        const title =
          edge.count > 1
            ? `${fromCard.node.title} → ${toCard.node.title} · 共 ${edge.count} 条链接`
            : `${fromCard.node.title} → ${toCard.node.title}`

        // `edgeFromLink` 关掉时就当"没有正文位置"处理（回到从卡片边界出发的老行为）
        const layout = edgeFromLink ? (egoLayout.layouts.get(edge.fromRelPath) ?? null) : null
        const geometry = linkEdgeGeometry({
          edge,
          from: { rect: fromRect, layout, title: fromCard.node.title },
          to: { rect: toRect, title: toCard.node.title },
          targets: edgeTargets(edge, toCard.node),
          tension,
          // 量宽函数必须传：`LaidOutLine` 只记了整行宽度，而"这段字从哪开始"要知道它前面的
          // run 各有多宽 —— 不传就只能按字符数摊派（中英混排会偏十几像素）
          ...(measure === null ? {} : { measure }),
        })
        /*
          环向走线（ADR-0028）：同环走弧、跨环朝外鼓 —— 两种形状都要把锚点换到卡片**外缘**。
          为什么连锚点一起换：环外的弧与"朝目标"的内侧锚点之间那段连接会被卡片挡住
          （卡片是不透明底、线段在它下面），看起来就是"线在卡片里断了"（理由写在
          `edge-routing.ts` 的文件头）。换了锚点，引线也必须重画到同一个点上 ——
          分界处严丝合缝那条纪律（ADR-0023）不能因为换了形状就破。
        */
        const route = ringRouting
          ? routingKind(
              { rect: fromRect, hop: fromCard.hop },
              { rect: toRect, hop: toCard.hop },
            )
          : 'straight-to-center'
        const exit = route === 'straight-to-center' ? geometry.exit : outerExit(fromRect)
        const entry = route === 'straight-to-center' ? geometry.entry : outerExit(toRect)
        const spanPath =
          route === 'straight-to-center'
            ? geometry.spanPath
            : (routeEdgePath({
                exit,
                entry,
                from: { rect: fromRect, hop: fromCard.hop },
                to: { rect: toRect, hop: toCard.hop },
                tension,
              }) ?? geometry.spanPath)
        const leadPath = geometry.fromLink
          ? route === 'straight-to-center'
            ? geometry.leadPath
            : leadPathBetween(geometry.anchor, exit)
          : ''

        visuals.push({
          key,
          edge,
          style,
          d: spanPath,
          start: exit,
          end: entry,
          phantom: false,
          title: geometry.fromLink
            ? `${title}（从正文里的 [[${geometry.matchedText ?? ''}]] 引出）`
            : `${title}（正文里没找到对应的链接写法，从卡片边缘出发）`,
          ...(geometry.fromLink && leadPath !== ''
            ? { leadPath, leadFrom: geometry.anchor }
            : {}),
        })
      }
      return visuals
    }
    if (data === null || mode !== 'vault') return []
    // 注意这里用的是**全部可见卡片**（而不是裁剪后的那一批）：线要从卡片边缘出发，
    // 只画两端都在视口里的边会让"线在屏幕中间凭空开始"
    return buildEdgeVisuals(data.edges, cardsById, selected, visibleWorldRect)
  }, [
    mode,
    egoLayout,
    ego,
    data,
    cardsById,
    selected,
    visibleWorldRect,
    currentRect,
    tension,
    edgeFromLink,
    ringRouting,
    measure,
    tick,
    hoveredLink,
  ])

  const paletteRef = useRef<{
    key: string
    palette: GraphPalette
    token: (name: string) => string | null
  } | null>(null)

  /**
   * 重画一帧。
   *
   * 为什么不用 `requestAnimationFrame` 排队：所有会触发重画的输入（数据、缩放、平移、悬停）
   * 都已经由 React 的批处理合并过了，一帧最多跑一次；再加一层 rAF 只会让"拖动时卡片跟手"
   * 变成"慢一帧"（用户能看出来）。真正的开销在 `paintGraph` 里被视口裁剪挡住了。
   */
  useEffect(() => {
    const canvas = canvasRef.current
    const host = hostRef.current
    if (canvas === null || host === null) return
    if (viewport.width <= 0 || viewport.height <= 0) return

    /**
     * 调色板与令牌读取器：**按主题 + Vault 缓存**，不在每次重画时重读。
     *
     * 两个约束把做法夹在这里：
     * 1. 不能在渲染期读（第一次渲染时 ref 还没挂上 DOM，读到的是 null，而 memo 之后再也不会重算）；
     * 2. 不能每帧读 —— `getComputedStyle` 会强制一次样式计算，拖动时每帧一发就是白花的钱。
     * 于是"主题或 Vault 变了才重建"：主题切换本来就会改变所有卡片颜色，重读一次正合适。
     */
    const key = `${themeId}\u0000${rootPath ?? ''}`
    let palette = paletteRef.current
    if (palette === null || palette.key !== key) {
      palette = { key, palette: readPalette(host), token: createTokenReader(host) }
      paletteRef.current = palette
    }

    const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio
    const pixels = canvasSize({ width: viewport.width, height: viewport.height }, ratio)
    if (canvas.width !== pixels.width || canvas.height !== pixels.height) {
      canvas.width = pixels.width
      canvas.height = pixels.height
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
    }

    const context = canvas.getContext('2d')
    if (context === null) return
    // DPR 只在这一次换算里出现：之后画笔画的每个坐标都按 CSS 像素理解
    context.setTransform(pixels.dpr, 0, 0, pixels.dpr, 0, 0)
    // 每一帧都清空：卡片的数量随缩放/裁剪变化，残留的旧像素会让画布糊上一层
    context.clearRect(0, 0, viewport.width, viewport.height)

    const stats = paintGraph(context, {
      transform,
      nodes: paintNodes,
      // 连线归 SVG 层（见文件头第 2 条）：这里刻意给空数组，避免同一条线画两遍
      edges: [],
      palette: palette.palette,
      measure: measure ?? (() => 0),
      mode,
      selected,
      hovered,
      // 悬停的那段 [[链接]]（卡片内坐标）：画笔给它描一个强调色的框，
      // 与 SVG 层"提亮对应连线"是同一个动作的两半
      hoveredLink:
        hoveredLink === null ? null : { relPath: hoveredLink.relPath, zone: hoveredLink.zone },
      visible: visibleSet,
      token: palette.token,
    })
    // 真正画出来的张数（视口裁剪之后）也报给宿主属性：它与"交给画笔的张数"是两件事，
    // 而"这一帧到底画了几张"是排查"画布怎么空了/卡了"时第一个想看的事实
    setPaintedCards(stats.cards)
  }, [
    viewport,
    transform,
    paintNodes,
    visibleSet,
    themeId,
    rootPath,
    measure,
    mode,
    selected,
    hovered,
    hoveredLink,
  ])

  // -------------------------------------------------------------------------
  // "定位笔记"：几千张卡片里按名字直达（见 find.ts 的说明）
  // -------------------------------------------------------------------------

  const [findQuery, setFindQuery] = useState('')
  /** 待定位的笔记：卡片可能还在折叠的容器里，展开后要等布局重算才能找到它。 */
  const pendingLocateRef = useRef<string | null>(null)

  const nodesByPath = useMemo(() => {
    const map = new Map<string, GraphNode>()
    for (const node of data?.nodes ?? []) map.set(node.relPath, node)
    for (const node of ego?.data.nodes ?? []) map.set(node.relPath, node)
    return map
  }, [data, ego])

  const findIndex = useMemo(
    () => buildGraphFindIndex(mode === 'focus' ? (ego?.data.nodes ?? []) : (data?.nodes ?? [])),
    [mode, ego, data],
  )
  const findMatches = useMemo(
    () => (findQuery.trim() === '' ? [] : findGraphMatches(findIndex, findQuery, nodesByPath)),
    [findIndex, findQuery, nodesByPath],
  )

  /** 焦点视图里所有卡片（含视口外的）：定位与键盘导航都要用它，不能只看可见的那一批。 */
  const focusCardByPath = useMemo(() => {
    const map = new Map<string, EgoCardBox>()
    for (const card of egoLayout?.layout.cards ?? []) map.set(card.relPath, card)
    return map
  }, [egoLayout])

  /**
   * 把某张卡片摆到视口中央并选中它。
   *
   * 找不到时先**展开它的祖先文件夹**再重试一次（折叠容器里的卡片不在布局里，
   * 直接报"找不到"会让用户以为图谱缺了这篇笔记）；展开是异步的（要等 layout 重算），
   * 因此把目标记进 `pendingLocateRef`，由下面的 effect 在布局更新后补做。
   * 焦点视图没有折叠，找不到就是真的不在子图里 —— 提示"调大跳数"比默默无反应好。
   */
  const locateCard = useCallback(
    (relPath: string): void => {
      // 两种视图的卡片类型不同，但"中心点在哪"这件事一样：先各自取出矩形
      const rect: Rect | undefined = focusCardByPath.get(relPath)?.rect ?? cardsById.get(relPath)
      if (rect === undefined) {
        // 焦点视图没有折叠：找不到就是不在当前深度里（提示由"深度"那一栏负责）
        if (mode !== 'vault') return
        const ancestors = ancestorFolders(relPath)
        const collapsedNow = useGraphStore.getState().collapsed
        const next = [...collapsedNow].filter((path) => !ancestors.includes(path))
        if (next.length !== collapsedNow.size) {
          pendingLocateRef.current = relPath
          useGraphStore.getState().setCollapsed(next)
        }
        return
      }
      const state = useGraphStore.getState()
      const zoom = state.view.zoom
      state.setView({
        zoom,
        x: state.viewport.width / 2 - (rect.x + rect.width / 2) * zoom,
        y: state.viewport.height / 2 - (rect.y + rect.height / 2) * zoom,
      })
      state.select(relPath)
    },
    [mode, focusCardByPath, cardsById],
  )

  // 展开祖先之后补做那一次定位（只做一次，避免每次布局变化都抢镜头）
  useEffect(() => {
    const target = pendingLocateRef.current
    if (target === null) return
    if (!cardsById.has(target)) return
    pendingLocateRef.current = null
    locateCard(target)
  }, [cardsById, locateCard])

  const submitFind = (): void => {
    const first = findMatches[0]
    if (first === undefined) return
    locateCard(first.relPath)
    setFindQuery('')
  }

  // -------------------------------------------------------------------------
  // 视口尺寸上报 + 首次自动"适应窗口"
  // -------------------------------------------------------------------------

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const sync = (): void => {
      const width = host.clientWidth
      const height = host.clientHeight
      // 尺寸为 0（首帧 / 无布局环境）时不上报：store 里的兜底尺寸比 0 有用得多
      if (width > 0 && height > 0) useGraphStore.getState().setViewport({ width, height })
    }
    sync()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', sync)
      return () => window.removeEventListener('resize', sync)
    }
    const observer = new ResizeObserver(sync)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (mode !== 'vault') return
    // 自动"适应窗口"（同一个 Vault 只做一次，跨挂载记账）。
    // 数据变化、折叠变化、拖动卡片都会让 layout 换一个对象，这里再跑一次也只是空转 ——
    // 镜头属于用户，只有换 Vault / 真实尺寸到手 / 用户自己按"适应窗口"时才该动。
    useGraphStore.getState().autoFit()
  }, [mode, vaultLayout, rootPath, viewport])

  // 焦点视图的"适应窗口"由**力导向那条 effect** 负责（它在落定之后用**落定后**的包围盒调用
  // `setEgoBounds` / `autoFitBounds`）—— 这里刻意不再单独来一次：两个 effect 各调一次
  // 会互相覆盖（真实踩过：后声明的那个用**环**的包围盒把镜头拉回去，画布看起来"偏在角落"）。

  // -------------------------------------------------------------------------
  // 交互：滚轮（平移 + Ctrl 缩放）、拖动平移 / 拖动卡片、命中测试
  //
  // 键盘（`+ - 0 Esc`）已经是命令表里的 `graph.*`（`app/builtin-commands.ts`），
  // 由全局快捷键统一分发；方向键选卡片是本组件自己的（见下）。
  // -------------------------------------------------------------------------

  /**
   * `+` / `=` 的兜底分发。
   *
   * 为什么需要它：命令表的快捷键串用 `+` 当分隔符（`'Mod+='.split('+')`），
   * 所以**加号键本身写不进命令表** —— 真实键盘上 `Ctrl`+`+` 的事件会被算成 `Mod+Shift++`，
   * 与任何归一化后的串都对不上（`Mod+=` 只覆盖"按 `Ctrl` 和 `=`"这一种按法）。
   * 这里只做**转交**：按键 → `graph.zoomIn` 命令 → store 动作，不自己算缩放。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return
      if (event.key !== '+' && event.key !== '=') return
      if (isTextEntryTarget(event.target)) return
      const command = commands.get(GRAPH_COMMAND_IDS.zoomIn)
      if (command === undefined || !(command.when?.() ?? true)) return
      event.preventDefault()
      void commands.execute(command.id)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const applyWheel = useCallback((event: WheelEvent): void => {
    const host = hostRef.current
    if (host === null) return
    // 浮动面板里的滚轮属于"滚正文"，不该把画布缩放掉。
    // （HUD 没有可滚动内容，因此不在排除之列 —— 光标停在 HUD 上时滚轮照样平移/缩放画布。
    // 曾经的停靠预览面板 `.mn-graph-preview` 已随 ADR-0025 移除，只剩浮窗要排除。）
    if (event.target instanceof Element && event.target.closest('.mn-float-note') !== null) {
      return
    }
    event.preventDefault()
    const state = useGraphStore.getState()
    if (event.ctrlKey || event.metaKey) {
      // Ctrl + 滚轮：以光标为锚点缩放（光标下的那张卡片不会跑掉）
      const rect = host.getBoundingClientRect()
      state.zoomAt(Math.exp(-event.deltaY * WHEEL_ZOOM_K), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      })
      return
    }
    // 滚轮平移：默认纵向，Shift 转横向（`deltaX` 也照常吃，触控板横滑因此可用）
    if (event.shiftKey) state.panBy(-event.deltaY - event.deltaX, 0)
    else state.panBy(-event.deltaX, -event.deltaY)
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    // 必须用原生监听 + `passive: false`：React 的 onWheel 是**被动**监听，
    // 在那里 preventDefault 无效，页面/WebView 会跟着滚（也会触发浏览器缩放）
    host.addEventListener('wheel', applyWheel, { passive: false })
    return () => host.removeEventListener('wheel', applyWheel)
  }, [applyWheel])

  /** 屏幕点 → 世界坐标（命中测试的第一步）。 */
  const worldPointOf = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const host = hostRef.current
      if (host === null) return null
      const rect = host.getBoundingClientRect()
      return toWorld(transform, { x: clientX - rect.left, y: clientY - rect.top })
    },
    [transform],
  )

  /**
   * 世界坐标上最上面的卡片（后画的在上）。
   *
   * 焦点视图用 `cardAt`（同心环那层自带的命中判据）；全库视图用矩形索引，
   * 两者都带一点屏幕上的宽容度（缩到 25% 时卡片只有十几像素宽，纯矩形命中会点不中）。
   */
  const hitCard = useCallback(
    (point: { x: number; y: number }): { relPath: string; rect: Rect } | null => {
      const tolerance = 4 / transform.scale
      if (mode === 'focus') {
        const cards = egoLayout?.layout.cards ?? []
        // ⚠️ 命中的必须是**当前**矩形（力场松弛之后、或被用户拖过之后的位置），而不是
        // `card.rect`（同心环给的原始位置）。两者默认档下就差着大约三分之二的距离，
        // 用原始矩形命中的后果是"按在画着的那张卡片上，抓住的却是另一张"——
        // 拖动的表现是"按不住 / 一按就跳"，这正是"拖拽很僵硬"的一半来源。
        // 顺序与画笔一致（后画的在上），所以倒着找第一个命中的就是"最上面那张"。
        for (let index = cards.length - 1; index >= 0; index -= 1) {
          const card = cards[index]
          if (card === undefined) continue
          const rect = currentRect(card.relPath) ?? card.rect
          if (rectHit(rect, point, tolerance)) return { relPath: card.relPath, rect }
        }
        return null
      }
      const cards = vaultLayout?.cards ?? []
      for (let index = cards.length - 1; index >= 0; index -= 1) {
        const card = cards[index]
        if (card === undefined) continue
        if (rectHit(card, point, tolerance)) return { relPath: card.relPath, rect: card }
      }
      return null
    },
    [mode, egoLayout, vaultLayout, transform.scale, currentRect],
  )

  // -------------------------------------------------------------------------
  // 悬停 wikilink → 高亮对应连线
  // -------------------------------------------------------------------------

  /**
   * 每张卡片正文里的 wikilink 热区（**卡片内坐标**）。
   *
   * 为什么按卡片内坐标存而不是世界坐标：漂浮开着时卡片每帧都在动，世界坐标的热区
   * 立刻就过期；卡片内坐标与排版一样是稳定的，命中测试时再用**当前**矩形换算 ——
   * "看到的"和"悬停到的"永远是同一个位置（与 `hitCard` 用当前矩形同理）。
   */
  const linkZonesByCard = useMemo(() => {
    const map = new Map<string, LinkZone[]>()
    // 纯标题模式没有正文排版，自然没有热区可指（连线也如实退成"从卡片边界出发"）
    if (mode !== 'focus' || titleOnly || egoLayout === null || measure === null) return map
    for (const [relPath, layout] of egoLayout.layouts) {
      map.set(relPath, linkZones({ layout, measure }))
    }
    return map
  }, [mode, titleOnly, egoLayout, measure])

  /**
   * 卡片 → 它的出边（按"正文里可能写成的样子"归一化后索引）。
   *
   * 热区命中的是"一段文字"，要提亮的是"一条边"：两者的桥梁就是与 `matchRun`
   * 同一套的候选写法（`edgeTargets` + `normalizeLinkText`）。匹配不上（悬空边、
   * 或目标不在当前深度里）就如实不亮 —— 不拿猜出来的边去高亮。
   */
  const edgeKeysByCard = useMemo(() => {
    const map = new Map<string, { keys: ReadonlySet<string>; key: string }[]>()
    if (mode !== 'focus' || ego === null) return map
    for (const edge of ego.data.edges) {
      if (edge.toRelPath === null) continue
      const to = nodesByPath.get(edge.toRelPath)
      if (to === undefined) continue
      const keys = new Set(edgeTargets(edge, to).map(normalizeLinkText))
      const entry = { keys, key: edgeKey(edge) }
      const list = map.get(edge.fromRelPath)
      if (list === undefined) map.set(edge.fromRelPath, [entry])
      else list.push(entry)
    }
    return map
  }, [mode, ego, nodesByPath])

  /**
   * 世界坐标 → 悬停的 wikilink（卡片 + 热区 + 对应边的 key）；不在任何"有对应边"的
   * 链接上时 `null`。指向图外的 `[[链接]]`（悬空 / 超出深度）不会提亮任何线，
   * 也就**不**伪装成可悬停 —— 光标与描边只对"真的能高亮一条线"的段落出现。
   */
  const linkAt = useCallback(
    (world: Point): { relPath: string; zone: LinkZone; edgeKey: string } | null => {
      if (mode !== 'focus') return null
      const hit = hitCard(world)
      if (hit === null) return null
      const zones = linkZonesByCard.get(hit.relPath)
      if (zones === undefined || zones.length === 0) return null
      const chrome = cardChrome(DEFAULT_METRICS)
      const localX = world.x - (hit.rect.x + chrome.padding)
      const localY = world.y - (hit.rect.y + chrome.bodyTop)
      for (const zone of zones) {
        if (localX < zone.x || localX > zone.x + zone.width) continue
        if (localY < zone.y || localY > zone.y + zone.height) continue
        const normalized = normalizeLinkText(zone.text)
        const hrefNormalized = zone.href === undefined ? '' : normalizeLinkText(zone.href)
        const match = (edgeKeysByCard.get(hit.relPath) ?? []).find(
          (entry) =>
            entry.keys.has(normalized) || (hrefNormalized !== '' && entry.keys.has(hrefNormalized)),
        )
        if (match === undefined) return null
        return { relPath: hit.relPath, zone, edgeKey: match.key }
      }
      return null
    },
    [mode, hitCard, linkZonesByCard, edgeKeysByCard],
  )

  /**
   * 漂浮开着时热区跟着卡片走：指针不动，悬停命中也要按**当前**矩形重算一次，
   * 否则高亮会停在卡片已经离开的地方。`transform` 也在依赖里：滚轮平移/缩放
   * 不会触发 pointermove，但同样改变世界坐标（"线突然指错了"比"不高亮"更难解释）。
   */
  useEffect(() => {
    if (hoveredLink === null) return
    const point = lastPointerRef.current
    if (point === null) return
    const next = linkAt(toWorld(transform, point))
    if (!sameHoveredLink(hoveredLink, next)) setHoveredLink(next)
  }, [tick, transform, hoveredLink, linkAt])

  const fitNow = useCallback(() => {
    const state = useGraphStore.getState()
    if (state.mode === 'focus') {
      const bounds = egoLayout?.layout.bounds
      if (bounds !== undefined) state.fitToBounds(bounds)
      return
    }
    state.fitToWindow()
  }, [egoLayout])

  const zoomIn = useCallback(() => {
    useGraphStore.getState().zoomIn()
  }, [])

  const zoomOut = useCallback(() => {
    useGraphStore.getState().zoomOut()
  }, [])

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const target = event.target
      if (!(target instanceof Element)) return
      // HUD / 预览面板 / 文件夹标题按钮：它们自己处理点击，不参与画布平移
      if (target.closest('[data-mn-graph-nopan]') !== null) return
      if (event.button !== 0 && event.button !== 1) return

      const world = worldPointOf(event.clientX, event.clientY)
      if (world === null) return
      const hit = event.button === 0 ? hitCard(world) : null
      // 手柄落在卡片**内部**，所以必须先判它：否则拖手柄会变成拖动卡片（焦点视图里那种"拖不动"的观感）
      const handle =
        hit !== null && mode === 'focus' && rectHit(cardResizeHandleRect(hit.rect), world, 2 / transform.scale)
          ? { relPath: hit.relPath, left: hit.rect.x, top: hit.rect.y }
          : null
      // 记住指针位：漂浮时的热区重算（见 `tick` effect）从这次按下也要拿得到
      {
        const host = hostRef.current
        if (host !== null) {
          const rect = host.getBoundingClientRect()
          lastPointerRef.current = { x: event.clientX - rect.left, y: event.clientY - rect.top }
        }
      }

      const element = event.currentTarget
      if (typeof element.setPointerCapture === 'function') {
        try {
          element.setPointerCapture(event.pointerId)
        } catch {
          // 环境不支持指针捕获（jsdom）：不影响拖动，只是指针移出元素后会断开
        }
      }
      pointerRef.current = {
        pointerId: event.pointerId,
        button: event.button,
        lastX: event.clientX,
        lastY: event.clientY,
        moved: false,
        startWorldX: world.x,
        startWorldY: world.y,
        // 焦点视图里拖动 = **把这张卡片按住**（力场不再移动它，但它仍然推开别人）：
        // 位置本来就是"离中心几跳 + 张力"的产物，允许用户按住其中一张正是"漂浮"该有的手感。
        // 全库视图里拖动 = 搬位置（那是装箱布局，位置由用户说了算，并且要落盘）。
        card:
          handle === null && hit !== null
            ? { relPath: hit.relPath, grabX: world.x - hit.rect.x, grabY: world.y - hit.rect.y }
            : null,
        resize: handle,
      }
      // 上一次拖动如果被别的事件打断（例如中途按了 Esc、或指针被系统抢走），残留的记录会让
      // 松手时把**上一张**卡片钉到这一次的位置上 —— 每次按下都从干净的开始。
      draggedPinRef.current = null
      setDragging(null)
      setPanning(true)
    },
    [hitCard, mode, worldPointOf, transform.scale],
  )

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = pointerRef.current
      // 没按下时只更新悬停（用于高亮与鼠标指针形状）
      if (state === null) {
        {
          const host = hostRef.current
          if (host !== null) {
            const rect = host.getBoundingClientRect()
            lastPointerRef.current = { x: event.clientX - rect.left, y: event.clientY - rect.top }
          }
        }
        const world = worldPointOf(event.clientX, event.clientY)
        const hit = world === null ? null : hitCard(world)
        setHovered((current) => (current === (hit?.relPath ?? null) ? current : (hit?.relPath ?? null)))
        // 悬停在正文里某段 [[链接]] 上 → 高亮对应的那条连线（`linkAt` 的判据）；
        // 停在右下角手柄上 → nwse-resize 光标（手柄画在 canvas 上，光标形状只能组件自己给）
        const link = world === null ? null : linkAt(world)
        setHoveredLink((current) => (sameHoveredLink(current, link) ? current : link))
        setOverResizeHandle(
          hit !== null &&
            world !== null &&
            mode === 'focus' &&
            rectHit(cardResizeHandleRect(hit.rect), world, 2 / transform.scale),
        )
        return
      }
      if (state.pointerId !== event.pointerId) return

      const dx = event.clientX - state.lastX
      const dy = event.clientY - state.lastY
      if (dx === 0 && dy === 0) return
      if (Math.abs(dx) + Math.abs(dy) > CLICK_SLOP_PX) state.moved = true
      state.lastX = event.clientX
      state.lastY = event.clientY

      if (state.resize !== null) {
        // 右下角手柄：宽高**一起**跟着光标走（左边界与上边界固定），在 store 里夹好范围并落盘。
        // 历史包袱：这里曾经只调宽度 —— "卡片不能调高度"是用户报回来的缺陷。
        // 注意高度是**上限**：内容没那么高时卡片仍按内容收缩（它本来就是"最多多高"）。
        const world = worldPointOf(event.clientX, event.clientY)
        if (world === null) return
        useGraphStore
          .getState()
          .setCardSize(state.resize.relPath, world.x - state.resize.left, world.y - state.resize.top)
        return
      }

      if (state.card !== null && state.moved) {
        const world = worldPointOf(event.clientX, event.clientY)
        if (world === null) return
        if (mode === 'focus') {
          // 焦点视图：把这张卡片**钉在光标下**（`fixed`），并给力场加热 —— 邻居得重新受力才会让位。
          const rect = currentRect(state.card.relPath)
          const sim = simRef.current
          if (rect === null || sim === null) return
          const centerX = world.x - state.card.grabX + rect.width / 2
          const centerY = world.y - state.card.grabY + rect.height / 2
          sim.pin(state.card.relPath, centerX, centerY)
          // 加热 + 当场推进：被拖的那张是 `fixed` 的（位置由光标决定），斥力 / 弹簧 / 硬碰撞
          // 全都作用在**别人**身上 —— "把卡片推到另一张上，它自己让开"就是这么来的。
          // 不加热的话 alpha 从打开起就是 0，整幅图会像死的一样纹丝不动。
          sim.heat(DRAG_HEAT)
          advanceSimulation(sim, DRAG_STEPS)
          // 记住最终位置，松手时写回 store（一为 HUD 的"已按住"，二为重建模拟时的种子）。
          // 拖动过程中**不**写 store：每个 pointermove 都写会让整棵画布重渲染，位置已经
          // 由 `positionsRef` 直接喂给画笔了，不需要绕一趟 React 状态。
          draggedPinRef.current = { relPath: state.card.relPath, center: { x: centerX, y: centerY } }
          setDragging((current) => (current === state.card?.relPath ? current : state.card?.relPath ?? null))
          return
        }
        // 全库视图：抓点相对卡片左上角的偏移保持不变（否则卡片会"跳"到光标下）
        useGraphStore.getState().moveCard(
          state.card.relPath,
          world.x - state.card.grabX,
          world.y - state.card.grabY,
        )
        return
      }
      // 按在卡片上但还没超过拖动阈值：**先不动**（否则拖卡片之前画布会先抖一下）
      if (state.card !== null) return
      useGraphStore.getState().panBy(dx, dy)
    },
    [hitCard, worldPointOf, mode, currentRect, advanceSimulation, linkAt, transform.scale],
  )

  const endPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const state = pointerRef.current
    if (state === null || state.pointerId !== event.pointerId) return
    pointerRef.current = null
    setPanning(false)
    const element = event.currentTarget
    if (typeof element.releasePointerCapture === 'function') {
      try {
        element.releasePointerCapture(event.pointerId)
      } catch {
        // 指针已经释放
      }
    }
    if (event.type !== 'pointerup' || state.button !== 0) return

    if (state.moved) {
      // 拖动结束：把**最终**位置写回 store。
      // 为什么不在每次 pointermove 里写：那会让整个画布随指针重渲染（几十次/秒），
      // 而位置已经由 `positionsRef` 直接喂给画笔了；store 里这份只服务两件事 ——
      // HUD 上"已按住 N 张"，以及重建模拟时"以用户摆好的位置为种子"。
      setDragging(null)
      const dragged = draggedPinRef.current
      if (dragged !== null) {
        draggedPinRef.current = null
        useGraphStore.getState().pinCard(dragged.relPath, dragged.center)
      }
      return // 拖动过：不改选中（拖卡片 / 拉宽 / 拖画布都不是"点了一下"）
    }
    // 没拖动：点在卡片上 = 选中（相关连线高亮 + HUD 出现尺寸档），点在空白 = 取消选中。
    // 点空白同时**松开所有被按住的卡片**：它们已经没有焦点了，继续钉着只会让人以为
    // "漂浮坏了"（用户原话："失去焦点继续松开卡片，保持浮动"）。
    // 选中没变化时这条也要走：拖完卡片后本来就什么都没选中，那一次点空白同样该松开。
    const world = { x: state.startWorldX, y: state.startWorldY }
    const hit = hitCard(world)
    useGraphStore.getState().select(hit?.relPath ?? null)
    if (hit === null) releasePinsExcept(null)
  }, [hitCard, releasePinsExcept])


  /** 双击卡片 = 在编辑器里打开它（焦点视图里这也顺带把圆心换成了它）。 */
  const handleDoubleClick = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const world = worldPointOf(event.clientX, event.clientY)
      if (world === null) return
      const hit = hitCard(world)
      if (hit === null) return
      useUiStore.getState().setViewMode('edit')
      void openNote(hit.relPath)
    },
    [hitCard, worldPointOf],
  )

  /**
   * 键盘：方向键在同一方向上的**最近卡片**之间移动选中项。
   *
   * 为什么要有它：卡片不再是 DOM 元素，Tab 键再也走不到它们身上 —— 没有这一步，
   * 画布对键盘用户就等于一块不可操作的图片。判据只需要几何：以当前选中的卡片中心为原点，
   * 在目标方向 ±60° 的扇形里找最近的（没有选中时从最靠左上角的一张开始）。
   */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      const steps: Record<string, { x: number; y: number }> = {
        ArrowLeft: { x: -1, y: 0 },
        ArrowRight: { x: 1, y: 0 },
        ArrowUp: { x: 0, y: -1 },
        ArrowDown: { x: 0, y: 1 },
      }
      const direction = steps[event.key]
      if (direction === undefined) return
      // 输入框里的方向键属于它自己（要在候选里上下选）：画布只在焦点不在文本输入处时接管。
      //
      // 为什么**不**排除预览面板：面板自己不消费方向键（它没有键盘滚动的实现），
      // 排除掉就等于"预览打开时方向键是死键" —— 而画布是一块可键盘操作的整体，
      // 换选中项是它最重要的键盘动作。要滚正文用滚轮（或先 `Esc` 关掉预览）。
      if (isTextEntryTarget(event.target)) return
      const cards =
        mode === 'focus'
          ? // 用**当前**矩形：方向键选的"同一方向上最近的卡片"必须按眼睛看到的排布算，
            // 用环上的原始位置会让方向键指到一张画在别处的卡片（拖动过之后更明显）
            (egoLayout?.layout.cards ?? []).map((card) => ({
              relPath: card.relPath,
              rect: currentRect(card.relPath) ?? card.rect,
            }))
          : (vaultLayout?.cards ?? []).map((card) => ({ relPath: card.relPath, rect: card }))
      if (cards.length === 0) return
      event.preventDefault()

      const current = cards.find((card) => card.relPath === selected)
      if (current === undefined) {
        useGraphStore.getState().select(cards[0]?.relPath ?? null)
        return
      }
      const originX = current.rect.x + current.rect.width / 2
      const originY = current.rect.y + current.rect.height / 2
      let best: { relPath: string; distance: number } | null = null
      for (const card of cards) {
        if (card.relPath === current.relPath) continue
        const dx = card.rect.x + card.rect.width / 2 - originX
        const dy = card.rect.y + card.rect.height / 2 - originY
        const forward = dx * direction.x + dy * direction.y
        if (forward <= 0) continue // 不在这个方向上
        const distance = Math.hypot(dx, dy)
        if (distance > KEYBOARD_REACH) continue
        // ±60° 扇形：横向偏移不超过前进距离的 1.7 倍（`tan(60°)`）
        const sideways = Math.abs(dx * direction.y - dy * direction.x)
        if (sideways > forward * 1.7) continue
        if (best === null || distance < best.distance) best = { relPath: card.relPath, distance }
      }
      const target = best?.relPath
      if (target === undefined) return
      useGraphStore.getState().select(target)
      locateCard(target)
    },
    [mode, egoLayout, vaultLayout, selected, locateCard, currentRect],
  )

  // -------------------------------------------------------------------------
  // 卡片 / 容器的回调
  // -------------------------------------------------------------------------

  const handleOpenInEditor = useCallback((relPath: string) => {
    useUiStore.getState().setViewMode('edit')
    void openNote(relPath)
  }, [])
  /**
   * 右键卡片：命中哪一张就把菜单弹在光标处（空白处右键不弹 —— 画布本身没有"上下文"）。
   *
   * 顺带把这张卡片选中：菜单上的大多数动作（尺寸档、「浮窗打开」）作用于"当前选中的那一张"，
   * 而右键不做这一步的话，用户会看到菜单里的操作作用在别处。
   */
  const handleContextMenu = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const world = worldPointOf(event.clientX, event.clientY)
      const hit = world === null ? null : hitCard(world)
      if (hit === null) return
      event.preventDefault()
      useGraphStore.getState().select(hit.relPath)
      setCardMenu({ relPath: hit.relPath, x: event.clientX, y: event.clientY })
    },
    [hitCard, worldPointOf],
  )

  /** 卡片的右键菜单项（每一项都指向既有入口，见 `cardMenu` 的说明）。 */
  const cardMenuItems = useCallback(
    (relPath: string): ContextMenuItem[] => {
      const pinned = useGraphStore.getState().pins.has(relPath)
      return [
        {
          id: 'open',
          label: '在编辑器中打开',
          onSelect: () => handleOpenInEditor(relPath),
        },
        {
          id: 'floating',
          label: '浮窗打开',
          onSelect: () => useGraphStore.getState().openFloating(relPath),
        },
        {
          id: 'locate',
          label: '居中显示',
          onSelect: () => locateCard(relPath),
        },
        {
          id: 'unpin',
          label: '松开这张卡片',
          disabled: !pinned,
          separatorBefore: true,
          onSelect: () => releasePinsExcept(null),
        },
        {
          id: 'reset-size',
          label: '恢复自动尺寸',
          disabled: !useGraphStore.getState().cardSizes.has(relPath),
          onSelect: () => useGraphStore.getState().resetCardSize(relPath),
        },
      ]
    },
    [handleOpenInEditor, locateCard, releasePinsExcept],
  )

  const handleToggleFolder = useCallback((path: string) => {
    useGraphStore.getState().toggleFolder(path)
  }, [])

  /** 手动"重新读取图谱"：**完整重载**（清空视角/折叠/选中）。 */
  const handleRefresh = useCallback(() => {
    const state = useGraphStore.getState()
    if (state.mode === 'focus') {
      void state.loadEgo(focusRoot, { keepView: false })
      return
    }
    void state.load(rootPath, { indexBuilding: useLinksStore.getState().status.phase === 'building' })
  }, [rootPath, focusRoot])


  /**
   * 圆心那张卡片**当前**的世界矩形（`x,y,w,h`）。
   *
   * 卡片画在 canvas 上，位置还受力导向影响 —— 外面（测试、自动化、调试）无从知道它此刻在哪，
   * 而"精确点到它"和"拖它的缩放手柄"正需要这个数。
   */
  const rootRect = mode === 'focus' && ego !== null ? currentRect(ego.root) : null
  const rootRectAttr =
    rootRect === null
      ? ''
      : [rootRect.x, rootRect.y, rootRect.width, rootRect.height].map((value) => Math.round(value)).join(',')

  /**
   * 当前**可见**卡片的矩形（`relPath|x,y,w,h`，世界坐标，`;` 分隔，保留一位小数）。
   *
   * 与 `data-graph-root-rect` 同一个理由，只是把"一张"扩成"看得见的每一张"：
   * 卡片画在 canvas 上，外面的自动化无从知道某张此刻在哪，而"把甲拖到乙身上"
   * "拖完之后两张不许重叠"这类断言**必须**知道它 —— 否则只能靠"某段文字画在哪个坐标"
   * 去反推，而正文里同样会出现那两个字（真实踩过：标题「路线图」与正文里的 `[[路线图]]`
   * 撞名，反推出来的位置是正文那一段的）。
   *
   * 只列可见的那些（视口外的不可能在自动化里被点到），并且**保留一位小数**：
   * 整数舍入会让"位移 120px 对不对"这类断言多出 ±0.5px 的噪声。
   */
  const cardRectsAttr = useMemo(() => {
    if (mode !== 'focus') return ''
    return paintNodes
      .filter((node) => visibleSet.has(node.relPath))
      .map((node) => {
        const round = (value: number): number => Math.round(value * 10) / 10
        return `${node.relPath}|${round(node.rect.x)},${round(node.rect.y)},${round(node.rect.width)},${round(node.rect.height)}`
      })
      .join(';')
  }, [mode, paintNodes, visibleSet])
  /** 当前布局里重叠的卡片对数（见 `countOverlaps`）：碰撞起作用时应当恒为 0。 */
  const overlaps = useMemo(
    () => (mode === 'focus' ? countOverlaps(positionsRef.current) : 0),
    // `tick` 是位置变化的时钟（漂浮每帧、落定、拖动都会推进它）
    [mode, tick],
  )
  const nodeCount = mode === 'focus' ? (ego?.data.nodes.length ?? 0) : (data?.nodes.length ?? 0)
  const edgeCount = mode === 'focus' ? (ego?.data.edges.length ?? 0) : (data?.edges.length ?? 0)
  const truncated = mode === 'focus' ? (ego?.data.truncated ?? false) : (data?.truncated ?? true)
  const showIndexNotice = indexPhase === 'building' || staleIndex
  const loading = mode === 'focus' ? egoStatus === 'loading' : status === 'loading'
  const activeError = mode === 'focus' ? egoError : error
  // 焦点视图里"没有圆心"= 没有打开的笔记（这一条要压住 loading 态：两者同时成立时
  // 说的是同一件事，叠两层遮罩只会互相盖住）
  const empty =
    mode === 'focus' ? focusRoot === null && !loading : status === 'ready' && (data?.nodes.length ?? 0) === 0

  return (
    <div
      className={`mn-graph${panning ? ' mn-graph--panning' : ''}${
        hovered === null ? '' : ' mn-graph--over-card'
      }${hoveredLink === null ? '' : ' mn-graph--over-link'}${
        overResizeHandle ? ' mn-graph--over-resize' : ''
      } mn-graph--${mode}`}
      ref={hostRef}
      role="application"
      aria-label={
        mode === 'focus'
          ? `与「${focusRoot ?? '（未打开笔记）'}」相关的关系图，${depth} 跳`
          : '整个 Vault 的知识图谱'
      }
      tabIndex={0}
      data-graph-mode={mode}
      data-graph-depth={depth}
      /*
        当前的世界 → 屏幕换算，写成属性是为了**可断言**：卡片画在 canvas 上，测试与自动化
        没有 DOM 节点可点，而"世界原点的屏幕位置"就是中心那张卡片的中心 —— 有了这三个数，
        端到端用例可以精确点到某张卡片，而不必去猜像素（与预览层的 `data-mn-render` 同一个思路：
        把"这次到底怎么算的"变成界面上读得到的事实）。
      */
      data-graph-scale={view.zoom}
      data-graph-offset-x={Math.round(view.x)}
      data-graph-offset-y={Math.round(view.y)}
      /* 交给画笔的卡片数（= 布局里的全部卡片，**未**经视口裁剪） */
      data-graph-canvas-cards={paintNodes.length}
      /* 上一帧真正画出来的张数（裁剪之后） */
      data-graph-painted-cards={paintedCards}
      data-graph-root-rect={rootRectAttr}
      data-graph-card-rects={cardRectsAttr}
      /* 被按住的卡片数（漂浮时"我按住了几张"一眼可见） */
      data-graph-pinned={pins.size}
      /* 当前选中的卡片（单击选中/空白取消；自动化据此断言"选中了谁"，画布上没有 DOM 可查） */
      data-graph-selected={selected ?? ''}
      /* 当前布局里重叠的卡片对数（碰撞是硬约束时应当恒为 0） */
      data-graph-overlaps={overlaps}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onPointerLeave={() => {
        setHovered(null)
        setHoveredLink(null)
        setOverResizeHandle(false)
        lastPointerRef.current = null
      }}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
    >
      {/* 连线与文件夹容器留在 DOM 里（同一套 CSS transform），卡片画在 canvas 上 */}
      <div
        className="mn-graph__viewport"
        style={{
          transform: `translate(${Math.round(view.x)}px, ${Math.round(view.y)}px) scale(${view.zoom})`,
        }}
      >
        <div
          className="mn-graph__world"
          style={{
            width: vaultLayout?.bounds.width ?? 0,
            height: vaultLayout?.bounds.height ?? 0,
          }}
        >
          {/* 卡外那一段（张力曲线 + 箭头 + 虚线）留在 viewport 里：它本来就该被路过的卡片盖住 */}
          <GraphEdges visuals={edgeVisuals} viewBox={visibleWorldRect} layer="span" />

          {mode === 'vault' &&
            visibleFolders.map((folder) => (
              <GraphFolder
                key={folder.path === '' ? '\u0000root' : folder.path}
                folder={folder}
                onToggle={handleToggleFolder}
              />
            ))}
        </div>
      </div>

      {/* 卡片层：自己算世界 → 屏幕的换算，因此缩放时文字是**重新排版**而不是被放大 */}
      <canvas
        className="mn-graph__canvas"
        ref={canvasRef}
        data-mn-cards={paintNodes.length}
        aria-hidden="true"
      />

      {/*
        卡片**内**那段引线（从正文里的 `[[链接]]` 到卡片边界）必须画在卡片层**之上**。

        为什么不能和卡外那段一起留在 viewport 里：卡片是不透明底、画在 canvas 上（`z-index: 1`），
        而 `.mn-graph__viewport` 带 `will-change: transform`、自成一个层叠上下文 —— viewport 里
        任何 z-index（哪怕 2）都盖不过 canvas。引线整段都在卡片矩形里，于是被整段盖掉，
        用户看到的就是"线从卡片边缘凭空开始"，正是这一轮要修的那句报障。
        （`.mn-graph__leads` 的样式在 `graph.css`：z-index 2 + `pointer-events: none`。）
      */}
      <div
        className="mn-graph__leads"
        style={{
          transform: `translate(${Math.round(view.x)}px, ${Math.round(view.y)}px) scale(${view.zoom})`,
        }}
      >
        <GraphEdges visuals={edgeVisuals} viewBox={visibleWorldRect} layer="lead" />
      </div>

      {/* ---------------------------------------------------------------- HUD */}
      <div className="mn-graph__hud" data-mn-graph-nopan>
        <div className="mn-graph__stats">
          {/* 视图切换：焦点（默认）与整个 Vault。两个按钮而不是一个开关：
              "我现在在哪个视图"必须一眼看出来，开关的两种样子容易看混 */}
          <div className="mn-graph__modes" role="group" aria-label="图谱视图">
            <button
              type="button"
              className={`mn-graph__mode${mode === 'focus' ? ' mn-graph__mode--active' : ''}`}
              aria-pressed={mode === 'focus'}
              data-graph-action="mode-focus"
              onClick={() => useGraphStore.getState().setMode('focus')}
              title="只看与当前笔记相关的部分"
            >
              <Icon name="links" size="xs" />
              关系图
            </button>
            <button
              type="button"
              className={`mn-graph__mode${mode === 'vault' ? ' mn-graph__mode--active' : ''}`}
              aria-pressed={mode === 'vault'}
              data-graph-action="mode-vault"
              onClick={() => useGraphStore.getState().setMode('vault')}
              title="整个 Vault（按文件夹分组）"
            >
              <Icon name="folderOpen" size="xs" />
              整个 Vault
            </button>
          </div>

          {/* 跳数调节：进入时是 1（只有直接相关的），要看得更远自己往上加 */}
          {mode === 'focus' && (
            <div className="mn-graph__depth" role="group" aria-label="关系图深度">
              <span className="mn-graph__depth-label">深度</span>
              <button
                type="button"
                className="mn-graph__depth-step"
                data-graph-action="depth-down"
                aria-label="减少一跳"
                disabled={depth <= MIN_EGO_DEPTH}
                onClick={() => useGraphStore.getState().setDepth(depth - 1)}
              >
                −
              </button>
              <span className="mn-graph__depth-value" data-graph-depth-value={depth}>
                {depth} 跳
              </span>
              <button
                type="button"
                className="mn-graph__depth-step"
                data-graph-action="depth-up"
                aria-label="增加一跳"
                disabled={depth >= MAX_EGO_DEPTH}
                onClick={() => useGraphStore.getState().setDepth(depth + 1)}
              >
                +
              </button>
            </div>
          )}

          <span className="mn-graph__stat">{nodeCount} 节点</span>
          <span className="mn-graph__stat">{edgeCount} 边</span>
          <span className="mn-graph__stat" title="当前缩放（Ctrl+滚轮 / Ctrl+= 放大 / Ctrl+- 缩小 / Ctrl+0 适应窗口）">
            {Math.round(view.zoom * 100)}%
          </span>
          {refreshing && (
            <span className="mn-graph__badge mn-graph__badge--busy" title="正在重新读取图谱数据（保留当前视角）">
              刷新中…
            </span>
          )}
          {truncated && (
            <span
              className="mn-graph__badge mn-graph__badge--warn"
              title={
                mode === 'focus'
                  ? '相关的笔记太多，只显示了离中心最近的一部分（调小深度可以看得更清）'
                  : '节点数超过宿主上限，只返回了度数最高的一部分'
              }
            >
              已截断
            </span>
          )}
          {mode === 'vault' && vaultLayout !== null && vaultLayout.hiddenCards > 0 && (
            <span className="mn-graph__badge" title="被折叠的容器里的卡片">
              已折叠 {vaultLayout.hiddenCards}
            </span>
          )}
        </div>

        {/*
          浮动态（ADR-0023）：张力、预设、两个开关，以及选中那张卡片的浮窗/尺寸。
          只在关系图里出现 —— 全库视图是"看结构"的视图，卡片是紧凑卡片、没有正文位置可指。
        */}
        {mode === 'focus' && (
          <div className="mn-graph__physics" data-mn-graph-nopan>
            <div className="mn-graph__row">
              <span className="mn-graph__row-label">浮动态</span>
              {FORCE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`mn-graph__chip${preset.id === forcePresetId ? ' mn-graph__chip--active' : ''}`}
                  aria-pressed={preset.id === forcePresetId}
                  data-force-preset={preset.id}
                  title={preset.hint}
                  onClick={() => useGraphStore.getState().setForcePreset(preset.id)}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <div className="mn-graph__row">
              <span className="mn-graph__row-label">张力</span>
              <input
                className="mn-graph__slider"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={tension}
                aria-label="连线张力"
                data-graph-tension={tension}
                onChange={(event) =>
                  useGraphStore.getState().setTension(Number(event.target.value))
                }
              />
              <span className="mn-graph__row-value">{Math.round(tension * 100)}%</span>
            </div>

            <div className="mn-graph__row">
              <button
                type="button"
                className={`mn-graph__chip${edgeFromLink ? ' mn-graph__chip--active' : ''}`}
                aria-pressed={edgeFromLink}
                data-graph-action="toggle-edge-from-link"
                title="连线从正文里对应的 [[链接]] 文字处画虚线引出，出了卡片再变实线"
                onClick={() => useGraphStore.getState().setEdgeFromLink(!edgeFromLink)}
              >
                从链接引出
              </button>
              <button
                type="button"
                className={`mn-graph__chip${titleOnly ? ' mn-graph__chip--active' : ''}`}
                aria-pressed={titleOnly}
                data-graph-action="toggle-title-only"
                title="只画标题（文件名），不排正文：一屏能看更多关系；此时连线改从卡片边界出发"
                onClick={() => useGraphStore.getState().setTitleOnly(!titleOnly)}
              >
                仅标题
              </button>
              <button
                type="button"
                className={`mn-graph__chip${ringRouting ? ' mn-graph__chip--active' : ''}`}
                aria-pressed={ringRouting}
                data-graph-action="toggle-ring-routing"
                title="同环的连线沿环外弧走、跨环的线朝外鼓：线不再横穿圆心那块最挤的地方（关掉 = 两点一条曲线）"
                onClick={() => useGraphStore.getState().setRingRouting(!ringRouting)}
              >
                沿环走线
              </button>
              <button
                type="button"
                className={`mn-graph__chip${floating ? ' mn-graph__chip--active' : ''}`}
                aria-pressed={floating}
                data-graph-action="toggle-floating"
                title="节点持续缓慢漂浮（关掉 = 落定后静止，省电）"
                onClick={() => useGraphStore.getState().setFloating(!floating)}
              >
                漂浮
              </button>
              <button
                type="button"
                className="mn-graph__chip"
                data-graph-action="reset-card-size"
                title="把调过大小的卡片恢复成自动尺寸"
                onClick={() => useGraphStore.getState().resetCardSize()}
              >
                重置卡片
              </button>
              <button
                type="button"
                className="mn-graph__chip"
                data-graph-action="unpin-cards"
                title="松开被拖住的卡片，让张力重新把它们摆回去"
                onClick={releasePins}
              >
                松开卡片
              </button>
              <button
                type="button"
                className={`mn-graph__chip${forcePanelOpen ? ' mn-graph__chip--active' : ''}`}
                aria-pressed={forcePanelOpen}
                data-graph-action="toggle-force-panel"
                title="力度管理：逐项调整向心力 / 斥力 / 弹簧 / 阻尼 / 碰撞…"
                onClick={() => setForcePanelOpen((open) => !open)}
              >
                力度管理
              </button>
            </div>

            {selected !== null && !titleOnly && (
              <div className="mn-graph__row">
                <span className="mn-graph__row-label">高度</span>
                {CARD_HEIGHT_CHOICES.map((choice) => {
                  const size = cardSizes.get(selected)
                  // 「全文」与具体上限互斥：active 判据先看 full 开关，再比数值
                  const current: number | null | 'full' =
                    size?.full === true ? 'full' : (size?.height ?? null)
                  const active = current === choice.value
                  return (
                    <button
                      key={choice.label}
                      type="button"
                      className={`mn-graph__chip${active ? ' mn-graph__chip--active' : ''}`}
                      aria-pressed={active}
                      data-card-height={choice.value === null ? 'auto' : String(choice.value)}
                      title={choice.hint}
                      onClick={() => {
                        if (choice.value === null) useGraphStore.getState().resetCardSize(selected)
                        else if (choice.value === 'full') useGraphStore.getState().setCardFull(selected, true)
                        else useGraphStore.getState().setCardHeight(selected, choice.value)
                      }}
                    >
                      {choice.label}
                    </button>
                  )
                })}
                <button
                  type="button"
                  className="mn-graph__chip"
                  data-graph-action="open-floating"
                  title="把这篇文章拎出来，浮在画布上看（可拖动、可缩放、可多个）"
                  onClick={() => useGraphStore.getState().openFloating(selected)}
                >
                  浮窗打开
                </button>
              </div>
            )}
          </div>
        )}

        <div className="mn-graph__legend">
          {mode === 'focus' ? (
            <>
              <span className="mn-graph__legend-item">
                <i className="mn-graph__legend-dot" />
                半径 = 离当前笔记几跳
              </span>
              <span className="mn-graph__legend-item">
                <i className="mn-graph__legend-line" />
                实线 = 与它直接相关
              </span>
              <span className="mn-graph__legend-item">
                <i className="mn-graph__legend-line mn-graph__legend-line--dashed" />
                虚线 = 环与环之间
              </span>
              {/* 语义色相与权重（ADR-0028）：图例只说这两句，具体数值不写死在这里 */}
              <span className="mn-graph__legend-item">
                <i className="mn-graph__legend-line mn-graph__legend-line--out" />
                暖色 = 我指向它
              </span>
              <span className="mn-graph__legend-item">
                <i className="mn-graph__legend-line mn-graph__legend-line--in" />
                冷色 = 它指向我
              </span>
              <span className="mn-graph__legend-item">
                <i className="mn-graph__legend-dot" />
                越远越细越淡 = 牵到第几跳
              </span>
            </>
          ) : (
            <>
              <span className="mn-graph__legend-item">
                <i className="mn-graph__legend-line" />
                实线 = 出链
              </span>
              <span className="mn-graph__legend-item">
                <i className="mn-graph__legend-line mn-graph__legend-line--dashed" />
                虚线 = 入链
              </span>
              <span className="mn-graph__legend-item">
                <i className="mn-graph__legend-dot" />
                悬空链接
              </span>
            </>
          )}
        </div>

        <div className="mn-graph__tools">
          {/* 定位笔记：几千张卡片时，"我想看看某一篇周围连了什么"没法靠拖拽完成 */}
          <div className="mn-graph__find">
            <input
              className="mn-graph__find-input"
              type="search"
              value={findQuery}
              placeholder={mode === 'focus' ? '在关系图里定位…' : '定位笔记…'}
              aria-label="定位笔记"
              onChange={(event) => setFindQuery(event.target.value)}
              onKeyDown={(event) => {
                // 画布自己也监听键盘（+/-/0 与方向键），这里把输入框里的事件拦住，
                // 否则在输入框里敲 "-" 会顺手把画布缩小
                event.stopPropagation()
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submitFind()
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setFindQuery('')
                }
              }}
            />
            {findQuery.trim() !== '' && (
              <ul className="mn-graph__find-list" role="listbox" aria-label="定位候选">
                {findMatches.length === 0 ? (
                  // 空态要说清楚：焦点视图里"没有匹配"往往意味着"这篇不在当前深度里"，
                  // 与全库视图的"被截断掉了"是两回事
                  <li className="mn-graph__find-empty">
                    {mode === 'focus' ? '当前深度里没有这篇笔记' : '没有匹配的卡片'}
                  </li>
                ) : (
                  findMatches.slice(0, 8).map((match) => (
                    <li key={match.relPath}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={match.relPath === selected}
                        data-find-path={match.relPath}
                        onClick={() => {
                          locateCard(match.relPath)
                          setFindQuery('')
                        }}
                      >
                        <span className="mn-graph__find-title">{match.title}</span>
                        {match.folder !== '' && (
                          <span className="mn-graph__find-folder">{match.folder}</span>
                        )}
                      </button>
                    </li>
                  ))
                )}
              </ul>
            )}
          </div>
          <button type="button" className="mn-icon-button" onClick={fitNow} title="适应窗口（Ctrl+0）" aria-label="适应窗口">
            <Icon name="eye" size="sm" />
          </button>
          <button type="button" className="mn-icon-button" onClick={zoomOut} title="缩小（Ctrl+-）" aria-label="缩小">
            <span className="mn-graph__zoom-glyph">−</span>
          </button>
          <button type="button" className="mn-icon-button" onClick={zoomIn} title="放大（Ctrl+=）" aria-label="放大">
            <span className="mn-graph__zoom-glyph">+</span>
          </button>
          {mode === 'vault' && (
            <>
              <button
                type="button"
                className="mn-icon-button"
                onClick={() => useGraphStore.getState().resetManual()}
                title="重新自动排布（清除手工拖动的位置）"
                aria-label="重新自动排布"
              >
                <Icon name="columns" size="sm" />
              </button>
              <button
                type="button"
                className="mn-icon-button"
                onClick={() => useGraphStore.getState().setCollapsed([])}
                title="展开全部文件夹"
                aria-label="展开全部文件夹"
              >
                <Icon name="folderOpen" size="sm" />
              </button>
              <button
                type="button"
                className="mn-icon-button"
                onClick={() => useGraphStore.getState().setCollapsed(vaultLayout?.folderPaths ?? [])}
                title="收起全部文件夹"
                aria-label="收起全部文件夹"
              >
                <Icon name="folder" size="sm" />
              </button>
            </>
          )}
          <button type="button" className="mn-icon-button" onClick={handleRefresh} title="重新读取图谱" aria-label="重新读取图谱">
            <Icon name="refresh" size="sm" />
          </button>
        </div>
      </div>

      {/* 力度管理：贴着 HUD 的详细旋钮面板（打开状态是瞬时的，不持久化） */}
      {mode === 'focus' && forcePanelOpen && (
        <ForcePanel onClose={() => setForcePanelOpen(false)} />
      )}

      {/*
        浮动笔记面板（ADR-0023）：可拖动、可缩放、可多个并存，点一下置顶。
        渲染在停靠面板之后（DOM 靠后 = 盖在上面），层级再用 `zIndex` 排一次。
      */}
      {floatingPanes.map((pane) => (
        <FloatingNote
          key={pane.relPath}
          relPath={pane.relPath}
          title={nodesByPath.get(pane.relPath)?.title ?? pane.relPath}
          rect={{ x: pane.x, y: pane.y, width: pane.width, height: pane.height }}
          zIndex={FLOAT_PANE_Z + pane.z}
          active={pane.z === topPaneZ(floatingPanes)}
          area={{ width: viewport.width, height: viewport.height }}
          onRaise={() => useGraphStore.getState().raiseFloating(pane.relPath)}
          onMove={(rect) => useGraphStore.getState().moveFloating(pane.relPath, rect)}
          onClose={() => useGraphStore.getState().closeFloating(pane.relPath)}
          onOpenInEditor={handleOpenInEditor}
        />
      ))}

      {cardMenu !== null && (
        <ContextMenu
          items={cardMenuItems(cardMenu.relPath)}
          x={cardMenu.x}
          y={cardMenu.y}
          ariaLabel={`${cardMenu.relPath} 的卡片菜单`}
          onClose={() => setCardMenu(null)}
        />
      )}

      {/*
        顶部只留**一条**横幅：刷新提示与"索引构建中"说的是同一件事（画布上的数据可能不是最新），
        刷新的那条更具体（它直接说明"你看到的是上一次的结果"），所以同时成立时优先显示它 ——
        两条横幅叠在同一个位置只会互相盖住。
      */}
      {(refreshNotice !== null || showIndexNotice) && (
        <div className="mn-graph__notice" data-mn-graph-nopan>
          <Icon name="refresh" size="xs" />
          <span>{refreshNotice ?? '链接索引构建中…（图谱可能还不完整）'}</span>
          <button type="button" className="mn-graph__notice-action" onClick={handleRefresh}>
            {refreshNotice === null ? '立即刷新' : '重新读取'}
          </button>
        </div>
      )}

      {loading && nodeCount === 0 && (
        <div className="mn-graph__overlay">
          {mode === 'focus' ? '正在读取关系图（含每篇正文）…' : '正在读取图谱…'}
        </div>
      )}

      {activeError !== null && (
        <div className="mn-graph__overlay">
          <p className="mn-empty__text">{describeError(activeError, '读取图谱失败')}</p>
          <button type="button" className="mn-graph__notice-action" onClick={handleRefresh}>
            重试
          </button>
        </div>
      )}

      {empty && !showIndexNotice && (
        <div className="mn-graph__overlay">
          <p className="mn-empty__text">
            {mode === 'focus'
              ? '打开一篇笔记，这里就会显示与它相关的关系图'
              : '这个 Vault 里还没有笔记（图谱的卡片来自 Markdown 笔记与它们之间的链接）'}
          </p>
          {mode === 'focus' && (
            <button
              type="button"
              className="mn-graph__notice-action"
              onClick={() => useGraphStore.getState().setMode('vault')}
            >
              看看整个 Vault
            </button>
          )}
        </div>
      )}

      {mode === 'focus' && egoStatus === 'ready' && nodeCount === 1 && (
        <div className="mn-graph__overlay mn-graph__overlay--hint">
          <p className="mn-empty__text">这篇笔记还没有任何链接（调大深度也不会多出东西来）</p>
        </div>
      )}

    </div>
  )
}

/** 一个文件夹容器（展开时是圆角区域，收起时是紧凑的"文件夹卡片"）。 */
function GraphFolder({
  folder,
  onToggle,
}: {
  folder: GraphFolderBox
  onToggle: (path: string) => void
}) {
  const action = folder.collapsed ? '展开' : '收起'
  return (
    <div
      className={`mn-graph-folder${folder.collapsed ? ' mn-graph-folder--chip' : ''}`}
      style={{ left: folder.x, top: folder.y, width: folder.width, height: folder.height }}
      data-folder={folder.path}
      data-depth={folder.depth}
    >
      <button
        type="button"
        className="mn-graph-folder__header"
        data-mn-graph-nopan
        aria-expanded={!folder.collapsed}
        aria-label={`${action} ${folder.label}（${folder.noteCount} 篇）`}
        title={
          folder.collapsed
            ? `${folder.label}：${folder.noteCount} 篇（点击展开）`
            : `${folder.label}：${folder.noteCount} 篇（点击收起）`
        }
        onClick={() => onToggle(folder.path)}
      >
        <Icon name={folder.collapsed ? 'folder' : 'folderOpen'} size="xs" />
        <span className="mn-graph-folder__label">{folder.label}</span>
        <span className="mn-graph-folder__count">{folder.noteCount}</span>
      </button>
    </div>
  )
}
