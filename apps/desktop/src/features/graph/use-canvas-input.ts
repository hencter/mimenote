/**
 * 图谱画布的**输入层**（hook）：滚轮、指针（平移 / 拖卡片 / 拉缩放手柄 / 单击选中 / 双击打开）、
 * 键盘（方向键选卡片、`+` 兜底）以及悬停命中（卡片 / 连线 / 缩放手柄）。
 *
 * 一句话职责：把浏览器的原始事件翻译成 store 动作与本地悬停状态，**不自己算位置与几何**。
 *
 * ## 为什么单独成 hook（而不是留在容器里）
 *
 * 这些处理器只依赖"坐标换算 + 命中测试 + 当前矩形 + 力场推进"这几样东西，全部由外部传进来：
 * 于是"点在哪儿算哪张卡片"这条判据只有一份（`hitCard`），而它读的**当前矩形**来自力场那一层的
 * 共享 `positionsRef`（见 `use-force-sim.ts` 的不变量）。容器只负责把这几样接上。
 *
 * ## 两条纪律
 *
 * 1. **滚轮必须原生监听且 `passive: false`**：React 的 `onWheel` 是被动监听，在那里
 *    `preventDefault()` 无效，WebView 会跟着滚（也会触发浏览器缩放）。
 * 2. **命中的线是"上一帧真画出来的那条"**（`paintedEdgesRef`）：漂浮时几何每帧都在变，
 *    用别处算出来的线去命中，会提示一条已经不在那儿的线。
 */

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

import { openNote } from '@/app/actions'
import { GRAPH_COMMAND_IDS } from '@/app/builtin-commands'
import { commands } from '@/app/commands'
import { isTextEntryTarget } from '@/app/keymap'
import { edgeAt, type PaintedEdge } from './canvas/edge-paint'
import { cardResizeHandleRect } from './canvas/paint'
import type { GraphLayout, Point, Rect } from '@/domain/graph/layout'
import { useGraphStore } from '@/state/graph-store'
import type { GraphMode } from '@/state/graph-store'
import { useUiStore } from '@/state/ui-store'

import { rectHit, toWorld, type ViewTransform } from '@/domain/graph/viewport'
import type { EgoGeometry } from './use-force-sim'
import type { HoveredLink } from './use-card-links'
import { DRAG_HEAT, DRAG_STEPS } from './use-force-sim'
import type { ForceSimulation } from '@/domain/graph/force'
import type { RefObject } from 'react'

/** 滚轮缩放的灵敏度（`factor = exp(-deltaY * k)`）。 */
const WHEEL_ZOOM_K = 0.0016

/** 平移拖动与"单击空白处关闭预览"之间的位移阈值。 */
const CLICK_SLOP_PX = 3

/** 键盘上下左右选卡片时的最大搜索距离（世界坐标）。 */
const KEYBOARD_REACH = 2400

/**
 * 连线的悬停容差（**屏幕像素**）。
 *
 * 5px：一条 1.6px 的线（缩放到 1 倍时）其实只有 1~2px 宽，按"正好压在线上"判命中根本点不着；
 * 而太宽（比如 12px）会让空白处也弹出提示、还会把卡片上的悬停抢走。换算成世界单位时除以缩放，
 * 于是"容差看起来永远是 5px"（与 `hitTolerance` 同一个思路）。
 */
const EDGE_HIT_SLOP = 5

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

export function useCanvasInput(input: {
  hostRef: RefObject<HTMLDivElement | null>
  transform: ViewTransform
  mode: GraphMode
  egoLayout: EgoGeometry | null
  vaultLayout: GraphLayout | null
  selected: string | null
  currentRect: (relPath: string) => Rect | null
  worldPointOf: (clientX: number, clientY: number) => Point | null
  hitCard: (point: Point) => { relPath: string; rect: Rect } | null
  simRef: RefObject<ForceSimulation | null>
  advanceSimulation: (sim: ForceSimulation, steps: number) => void
  draggedPinRef: RefObject<{ relPath: string; center: Point } | null>
  setDragging: Dispatch<SetStateAction<string | null>>
  releasePinsExcept: (keep: string | null) => void
  linkAt: (world: Point) => HoveredLink | null
  setHoveredLinkIfChanged: (next: HoveredLink | null) => void
  paintedEdgesRef: RefObject<readonly PaintedEdge[]>
  /** 卡片悬停（`null` = 不在任何卡片上）。容器持有它：画笔也要用它决定高亮。 */
  setHovered: Dispatch<SetStateAction<string | null>>
  /** 最近一次指针位置（屏幕坐标）；漂浮时指针不动也要按当前几何重算命中。 */
  lastPointerRef: RefObject<{ x: number; y: number } | null>
  /** 位置变化的时钟（漂浮每帧、落定、拖动、主题都在推进）—— 悬停的线也要按当前几何重算。 */
  tick: number
  /** 「定位笔记」：方向键选中之后把镜头摆过去（同一个入口，见 `use-graph-data.ts`）。 */
  locateCard: (relPath: string) => void
}) {
  const {
    hostRef,
    transform,
    mode,
    egoLayout,
    vaultLayout,
    selected,
    currentRect,
    worldPointOf,
    hitCard,
    simRef,
    advanceSimulation,
    draggedPinRef,
    setDragging,
    releasePinsExcept,
    linkAt,
    setHoveredLinkIfChanged,
    paintedEdgesRef,
    setHovered,
    lastPointerRef,
    locateCard,
    tick,
  } = input

  const [panning, setPanning] = useState(false)

  /** 光标是否停在卡片的缩放手柄上（决定 nwse-resize 光标；手柄画在 canvas 上，光标只能自己来）。 */
  const [overResizeHandle, setOverResizeHandle] = useState(false)

  /**
   * 悬停的**连线**（`null` = 不在任何一条上）。
   *
   * 连线搬进 canvas 之后（ADR-0036）没有 DOM 可挂 `<title>`，所以 tooltip 由这里驱动：
   * 命中判据是"指针离那条折线多远"（`edgeAt`），文案与 SVG 那一版的 `<title>` 逐字相同。
   *
   * `x` / `y` 是**进入这条边时的屏幕坐标**，不跟着指针走：跟着走意味着每一次 pointermove
   * 都要 setState（漂浮时每帧都在重画，再加上指针事件就变成两股刷新互相打），
   * 而"悬停提示停在进入的位置"本来就是常见的做法。
   */
  const [hoveredEdge, setHoveredEdge] = useState<{ key: string; title: string; x: number; y: number } | null>(
    null,
  )

  const pointerRef = useRef<PointerState | null>(null)

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
        setHoveredLinkIfChanged(link)
        // 悬停在**连线本身**上 → 悬停提示（文案就是 SVG 那一版的 `<title>`）。
        // 卡片上的热区优先：指针同时在卡片与线上时，"指着那段字"是更具体的意图
        // （`edgeAt` 因此只在没有 link 命中时才问）。
        const pointer = lastPointerRef.current
        const edge =
          world === null || pointer === null || link !== null
            ? null
            : edgeAt(paintedEdgesRef.current, world, EDGE_HIT_SLOP / transform.scale)
        setHoveredEdge((current) => {
          if (edge === null || pointer === null) return current === null ? current : null
          if (current !== null && current.key === edge.key) return current
          return { key: edge.key, title: edge.title, x: pointer.x, y: pointer.y }
        })
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

  /**
   * 漂浮开着时，指针不动也可能"从指着这条线"变成"指着空白"（卡片与连线都在动）：
   * 于是每次位置推进（`tick`）/ 缩放平移（`transform`）之后按当前几何重算一次命中。
   *
   * 与 `hoveredLink` 那条 effect 是同一个理由、同一套写法 —— 两处都不能只靠 pointermove，
   * 否则高亮与提示会停在已经离开的地方（"线突然指错了"比"没有提示"更难解释）。
   * 命中用的是**上一帧真画出来的**那份几何（`paintedEdgesRef`），所以不会出现
   * "提示的是一条已经不在那儿的线"。
   */
  useEffect(() => {
    if (hoveredEdge === null) return
    const point = lastPointerRef.current
    if (point === null) return
    const next = edgeAt(paintedEdgesRef.current, toWorld(transform, point), EDGE_HIT_SLOP / transform.scale)
    if (next === null) setHoveredEdge(null)
    else if (next.key !== hoveredEdge.key) {
      setHoveredEdge({ key: next.key, title: next.title, x: point.x, y: point.y })
    }
  }, [tick, transform, hoveredEdge])

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

  /**
   * 指针离开画布：清掉全部悬停态与最近指针位置。
   *
   * 为什么必须清：卡片与连线都画在 canvas 上，pointerleave 是唯一能确定"光标已经不在
   * 画布上"的信号；不清掉的话高亮与提示会停在最后一次命中的地方。
   */
  const handlePointerLeave = useCallback((): void => {
    setHovered(null)
    setHoveredLinkIfChanged(null)
    setHoveredEdge(null)
    setOverResizeHandle(false)
    lastPointerRef.current = null
  }, [setHovered, setHoveredLinkIfChanged, lastPointerRef])

  return {
    panning,
    handlePointerLeave,
    hoveredEdge,
    overResizeHandle,
    handlePointerDown,
    handlePointerMove,
    endPointer,
    handleDoubleClick,
    handleKeyDown,
  }
}
