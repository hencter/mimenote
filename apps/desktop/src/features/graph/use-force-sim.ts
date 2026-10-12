/**
 * 图谱的**力导向浮动态**（hook）。
 *
 * 一句话职责：造并维护那一个 `ForceSimulation`、把每帧位置写进**一个共享的 `positionsRef`**、
 * 提供"命中测试要用的当前矩形"，以及"按住 / 松开"的收尾动作。
 *
 * ## 不变量（ADR-0023；拆分时最容易破的一条）
 *
 * `positionsRef` 是"位置**不进 React state**"这条纪律的载体：它同时喂给画笔
 * （`paintNodes` 经 `currentRect` 读它）与命中测试（`hitCard` 读它）。因此它**必须**由本 hook
 * 创建一次、由容器**原样**传给其它消费者，**不许**在别处再 `useRef(new Map())` 复制一份 ——
 * 复制出来的那一刻"看到的"与"点得中的"就分家了，表现是"按住一张卡片却抓住了另一张"。
 *
 * `pins` 只以 ref 的形态参与 effect（`pinsRef`）：它是"每个 pointermove 都可能变"的状态，
 * 一旦成为 effect 依赖，拖动过程中模拟会被**反复重建**（每次都从同心环的种子重新落定）——
 * 用户看到的就是"拖拽卡片没有变动位置、没有碰撞推动卡片、整体非常僵硬"。
 *
 * 松弛的语义（ADR-0021 的纪律见 `domain/graph/force.ts` 文件头）：环是事实、力是手感 ——
 * 本 hook 只把环布局当**种子**，从不决定"谁离中心近"。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { createForceSimulation, type ForceSimulation } from '@/domain/graph/force'
import type { EgoCardBox, EgoLayout } from '@/domain/graph/layout-ego'
import type { Point, Rect } from '@/domain/graph/layout'
import type { EgoSnapshot, GraphMode } from '@/state/graph-store'
import { useGraphStore } from '@/state/graph-store'

import type { CardLayout } from './canvas/measure'

/** 焦点视图的几何：同心环布局 + 每张卡片排好版的正文（由容器一次 memo 出来）。 */
export interface EgoGeometry {
  layout: EgoLayout
  layouts: ReadonlyMap<string, CardLayout>
}

/**
 * 拖动卡片时把力场加热到的强度（`ForceSimulation.heat`）。
 *
 * 为什么要加热：打开图谱时 `settle()` 已经把强度跑到 0，**力全部停摆**。被拖的那张卡片是
 * `fixed` 的（位置由光标决定，本来就不受力），但"邻居让开"必须靠力 —— 只有硬碰撞会推人，
 * 手感就是"撞上去才动、其余时候整幅图是死的"。0.3 是实测的形状：足以让斥力与弹簧推动邻居
 * （被连接的卡片会跟着走），又不会让整幅图重新洗牌。
 */
export const DRAG_HEAT = 0.3

/** 每次 pointermove 推进几步：一步推不完"多个重叠对"，太多又会让一次移动滑出去很远。 */
export const DRAG_STEPS = 2

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

/**
 * 漂浮的刷新率（每秒几帧）。
 *
 * **60fps**：连线搬进 canvas 之后（ADR-0036），"位置一变就要重画的东西"只剩 canvas 这一层 ——
 * 而卡片本来每帧都在重画，连线跟着一起画不再额外付出"一次 React 渲染"的代价。
 * 在这之前是 20fps，唯一的理由就是 SVG 连线层是 React 渲染的（那条取舍写在 ADR-0023 里）。
 *
 * 代价如实记在这里：卡片的重画次数从 20 次/秒 变成 60 次/秒。真觉得重时的下一招是
 * "只把动过的那块矩形擦掉重画"（脏矩形），而不是把帧率偷偷压回去 ——
 * 后者会让"漂浮"重新变成一顿一顿的，而这正是用户要的观感。
 */
const FLOAT_FPS = 60

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
export function countOverlaps(rects: ReadonlyMap<string, Rect>): number {
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

export function useForceSim(input: {
  mode: GraphMode
  egoLayout: EgoGeometry | null
  ego: EgoSnapshot | null
  /** 被用户按住的卡片（ADR-0023）：只在 ref 里参与 effect，理由见文件头。 */
  pins: ReadonlyMap<string, Point>
  selected: string | null
  /** 是否让节点持续漂浮（false = 落定后静止，省电）。 */
  floating: boolean
  /** 力度档 id：它进"适应窗口"的键（换档 = 换一幅图的手感，要重新取景）。 */
  forcePresetId: string
}) {
  const { mode, egoLayout, ego, pins, selected, floating, forcePresetId } = input

  /**
   * 力导向的**当前参数**：来自 store（预设或用户手调过的那一份）。
   *
   * 为什么不再 `forcePreset(id).params` 现算：面板上的滑杆改了参数之后必须立刻生效，
   * 而 store 里那份才是"当前这一套力度"的唯一真相（预设只是它的起点）。
   */
  const forceParams = useGraphStore((state) => state.forceParams)

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

  return {
    positionsRef,
    simRef,
    currentRect,
    advanceSimulation,
    releasePins,
    releasePinsExcept,
    dragging,
    setDragging,
    draggedPinRef,
    tick,
  }
}
