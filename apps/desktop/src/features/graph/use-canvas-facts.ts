/**
 * 图谱画布的**可断言事实**（hook）。
 *
 * 一句话职责：把"这一帧画布长什么样"变成读得到的数字 —— 圆心卡片的矩形、可见卡片的矩形表、
 * 重叠对数，以及节点/边数与加载/错误/空/截断这几个状态。
 *
 * 为什么单独成 hook：这些值只服务 `data-graph-*` 属性与状态栏文案，与绘制、命中、输入都无关。
 * 它们是 **canvas 化的代价**：卡片与连线没有 DOM 可查，于是"这次到底怎么算的"必须写回属性，
 * 否则自动化就只能去截图里数像素（这些属性的前身是 SVG 元素上的类名，逐条对应过来）。
 *
 * 位置来自力场那一层的共享 `positionsRef`（见 `use-force-sim.ts` 文件头）——
 * 这里只**读**它算重叠数，不持有、不复制。
 */

import { useMemo } from 'react'
import type { RefObject } from 'react'

import type { GraphData, MimenoteError } from '@/ipc/types'
import type { Rect } from '@/domain/graph/layout'
import type { EgoSnapshot, GraphMode, GraphStatus } from '@/state/graph-store'

import type { GraphEdgeStats } from './canvas-view'
import { countOverlaps } from './use-force-sim'

export function useCanvasFacts(input: {
  mode: GraphMode
  data: GraphData | null
  ego: EgoSnapshot | null
  egoStatus: GraphStatus
  status: GraphStatus
  error: MimenoteError | null
  egoError: MimenoteError | null
  focusRoot: string | null
  staleIndex: boolean
  indexPhase: string
  /** 焦点视图里圆心那一篇的当前矩形（世界坐标）。 */
  currentRect: (relPath: string) => Rect | null
  positionsRef: RefObject<Map<string, Rect>>
  paintNodes: readonly { relPath: string; rect: Rect }[]
  visibleSet: ReadonlySet<string>
  tick: number
}) {
  const {
    mode,
    data,
    ego,
    egoStatus,
    status,
    error,
    egoError,
    focusRoot,
    staleIndex,
    indexPhase,
    currentRect,
    positionsRef,
    paintNodes,
    visibleSet,
    tick,
  } = input

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

  return {
    rootRectAttr,
    cardRectsAttr,
    overlaps,
    nodeCount,
    edgeCount,
    truncated,
    showIndexNotice,
    loading,
    activeError,
    empty,
  }
}

export type { GraphEdgeStats }
