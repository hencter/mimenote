/**
 * 知识图谱画布（M3 的核心功能）。
 *
 * 一句话：**这是一个和整个 Vault 有映射的无限画布** —— 每一篇笔记就是一张卡片，
 * 卡片正面直接给出标题/路径/标签/度数，单击就在画布上预览正文，双击进编辑器，
 * 文件夹自动成组（可点一下收起/展开），入链画虚线、出链画实线。
 * 不需要"按住 Ctrl"才能看到内容，也不需要人手工摆放才能看到结构。
 *
 * ## 为什么是 transform 而不是"逐卡片算坐标"
 *
 * 平移/缩放**只改一层容器的 `transform: translate(...) scale(...)`**，
 * 不重算任何卡片的坐标。这样一来：
 * - 平移是 O(1) 的 CSS 变更（合成器就能处理），1 万节点也不会因为"每帧重排 1 万个绝对定位元素"卡住；
 * - 卡片坐标只依赖数据与折叠状态（`layout.ts` 的纯函数 + `useMemo` 缓存），拖动卡片时才局部失效；
 * - 缩放是同一层的事，卡片与连线（SVG 在同一层里）永远对齐，不会出现"线跟卡片错位"。
 *
 * ## 视口裁剪
 *
 * 只渲染与视口相交的卡片与容器（含 overscan）。卡片/容器走均匀网格索引（`buildRectIndex`），
 * 每次平移查询的是 O(可见数 + 覆盖格子数)；边用端点包围盒做 O(E) 线性筛（见 layout.ts 的注释）。
 * 这是"3000 个节点也必须能拖动"的结构性保证，而不是靠"祈祷 DOM 撑得住"。
 *
 * ## 数据刷新与视角
 *
 * 画布只在图谱视图里挂载，所以"切到图谱"＝"组件挂载"，挂载时拉一次数据即可
 * （**保留视角**：切走会卸载组件，切回来不能把用户刚摆好的镜头重置掉）。
 * 保存成功、索引就绪这两类"数据变新了"的信号由 `startGraphAutoRefresh()` 订阅补齐，
 * 刷新过程复用同一份旧数据渲染（HUD 上只有一个小小的"刷新中"），不闪白。
 * 完整重载（换 Vault、点"重新读取"）才会重置视角 —— 两条路的区别见 `state/graph-store.ts`。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

import { openNote } from '@/app/actions'
import { GRAPH_COMMAND_IDS } from '@/app/builtin-commands'
import { commands } from '@/app/commands'
import { isTextEntryTarget } from '@/app/keymap'
import { Icon } from '@/components/Icon'
import { describeError, type GraphNode } from '@/ipc/types'
import { startGraphAutoRefresh, useGraphStore } from '@/state/graph-store'
import { useLinksStore } from '@/state/links-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'
import { GraphCard } from './GraphCard'
import { GraphEdges } from './GraphEdges'
import { GraphPreview } from './GraphPreview'
import {
  ancestorFolders,
  buildGraphFindIndex,
  centerViewOnCard,
  findGraphMatches,
} from './find'
import {
  OVERSCAN,
  applyManualPositions,
  buildEdgeVisuals,
  buildLayout,
  buildRectIndex,
  queryIndex,
  queryViewport,
  worldViewport,
  type GraphCardBox,
  type GraphFolderBox,
} from './layout'

import './graph.css'

/** 滚轮缩放的灵敏度（`factor = exp(-deltaY * k)`）。 */
const WHEEL_ZOOM_K = 0.0016

/** 平移拖动与"单击空白处关闭预览"之间的位移阈值。 */
const CLICK_SLOP_PX = 3

export function GraphCanvas() {
  const rootPath = useVaultStore((state) => state.info?.rootPath ?? null)
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
  const [panning, setPanning] = useState(false)
  const panRef = useRef<{
    pointerId: number | undefined
    button: number
    lastX: number
    lastY: number
    moved: boolean
  } | null>(null)

  // -------------------------------------------------------------------------
  // 数据加载
  //   · 进入图谱视图（= 本组件挂载）→ 拉一次，**保留视角**
  //   · 保存成功 / 索引就绪 → 由 store 的自动刷新订阅补齐（见 startGraphAutoRefresh）
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (rootPath === null) {
      useGraphStore.getState().clear()
      return
    }
    const state = useGraphStore.getState()
    void state.load(rootPath, {
      indexBuilding: useLinksStore.getState().status.phase === 'building',
      // 「切到图谱视图」就是"本组件挂载"（`App` 只在 `viewMode === 'graph'` 时渲染画布），
      // 所以"切过来时刷新一次"就是这一次加载。
      // 保留视角：切走会卸载画布，切回来若走完整重载，用户刚摆好的缩放/偏移/选中会被重置；
      // 换 Vault 时 store 会强制退化成完整重载（见 load 的说明），这里不必自己判断。
      keepView: state.rootPath === rootPath && state.data !== null,
    })
  }, [rootPath])

  // 保存成功 / 索引就绪后的自动刷新。装在这里、卸载即取消：
  // 模块级监听会永不清理，而"画布是否可见"这个上下文只有组件知道。
  useEffect(() => startGraphAutoRefresh(), [])

  // -------------------------------------------------------------------------
  // 布局（纯函数 + useMemo：平移/缩放**不会**让这里重算）
  // -------------------------------------------------------------------------

  const autoLayout = useMemo(
    () => (data === null ? null : buildLayout(data.nodes, collapsed)),
    [data, collapsed],
  )
  // 手工位置是 O(n) 的坐标覆盖（不重建文件夹树），拖动时只有这一步会重跑
  const layout = useMemo(
    () => (autoLayout === null ? null : applyManualPositions(autoLayout, manual)),
    [autoLayout, manual],
  )

  const cardsById = useMemo(() => {
    const map = new Map<string, GraphCardBox>()
    if (layout === null) return map
    for (const card of layout.cards) map.set(card.relPath, card)
    return map
  }, [layout])

  const rectIndex = useMemo(() => (layout === null ? null : buildRectIndex(layout.cards)), [layout])
  const visibleWorld = useMemo(() => worldViewport(view, viewport, OVERSCAN), [view, viewport])

  // -------------------------------------------------------------------------
  // "定位笔记"：几千张卡片里按名字直达（见 find.ts 的说明）
  // -------------------------------------------------------------------------

  const [findQuery, setFindQuery] = useState('')
  /** 待定位的笔记：卡片可能还在折叠的容器里，展开后要等布局重算才能找到它。 */
  const pendingLocateRef = useRef<string | null>(null)

  const nodesByPath = useMemo(() => {
    const map = new Map<string, GraphNode>()
    for (const node of data?.nodes ?? []) map.set(node.relPath, node)
    return map
  }, [data])

  const findIndex = useMemo(() => buildGraphFindIndex(data?.nodes ?? []), [data])
  const findMatches = useMemo(
    () => (findQuery.trim() === '' ? [] : findGraphMatches(findIndex, findQuery, nodesByPath)),
    [findIndex, findQuery, nodesByPath],
  )

  /**
   * 把某张卡片摆到视口中央并选中它。
   *
   * 找不到时先**展开它的祖先文件夹**再重试一次（折叠容器里的卡片不在布局里，
   * 直接报"找不到"会让用户以为图谱缺了这篇笔记）；展开是异步的（要等 layout 重算），
   * 因此把目标记进 `pendingLocateRef`，由下面的 effect 在布局更新后补做。
   */
  const locateCard = useCallback(
    (relPath: string): void => {
      const card = cardsById.get(relPath)
      if (card === undefined) {
        const ancestors = ancestorFolders(relPath)
        const collapsed = useGraphStore.getState().collapsed
        const next = [...collapsed].filter((path) => !ancestors.includes(path))
        if (next.length !== collapsed.size) {
          pendingLocateRef.current = relPath
          useGraphStore.getState().setCollapsed(next)
        }
        return
      }
      const state = useGraphStore.getState()
      state.setView({ ...state.view, ...centerViewOnCard(card, state.viewport, state.view.zoom) })
      state.select(relPath)
    },
    [cardsById],
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

  const visibleCards = useMemo(
    () => (rectIndex === null ? [] : queryIndex(rectIndex, visibleWorld)),
    [rectIndex, visibleWorld],
  )
  const visibleFolders = useMemo(
    () => (layout === null ? [] : queryViewport(layout.folders, visibleWorld)),
    [layout, visibleWorld],
  )
  // 注意这里用的是**全部可见卡片**（而不是裁剪后的那一批）：线要从卡片边缘出发，
  // 只画两端都在视口里的边会让"线在屏幕中间凭空开始"
  const visibleEdges = useMemo(
    () =>
      data === null
        ? []
        : buildEdgeVisuals(data.edges, cardsById, selected, visibleWorld),
    [data, cardsById, selected, visibleWorld],
  )

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
    // 自动"适应窗口"（同一个 Vault 只做一次，跨挂载记账）。
    // 数据变化、折叠变化、拖动卡片都会让 layout 换一个对象，这里再跑一次也只是空转 ——
    // 镜头属于用户，只有换 Vault / 真实尺寸到手 / 用户自己按"适应窗口"时才该动。
    useGraphStore.getState().autoFit()
  }, [layout, rootPath, viewport])

  // -------------------------------------------------------------------------
  // 交互：滚轮（平移 + Ctrl 缩放）、拖动平移
  //
  // 键盘（`+ - 0 Esc`）已经是命令表里的 `graph.*`（`app/builtin-commands.ts`），
  // 由全局快捷键统一分发 —— 只在画布里有焦点才生效既难发现、也会和命令表漂移。
  // 唯一的例外是**加号键**，见下面的兜底分发。
  // 卡片自己的 Enter / 空格仍由 `GraphCard` 处理（它需要卡片私有的上下文）。
  // -------------------------------------------------------------------------

  /**
   * `+` / `=` 的兜底分发。
   *
   * 为什么需要它：命令表的快捷键串用 `+` 当分隔符（`'Mod+='.split('+')`），
   * 所以**加号键本身写不进命令表** —— 真实键盘上 `Ctrl`+`+` 的事件会被算成 `Mod+Shift++`，
   * 与任何归一化后的串都对不上（`Mod+=` 只覆盖"按 `Ctrl` 和 `=`"这一种按法）。
   * 这里只做**转交**：按键 → `graph.zoomIn` 命令 → store 动作，不自己算缩放，
   * 因此缩放逻辑仍然只有一份实现（不会出现"两套逻辑漂移"）。
   *
   * 监听装在 window 上、但**生命周期跟着画布**：画布只在图谱视图里挂载，
   * 所以它天然只在图谱视图生效（编辑器里敲 `+` 不会被打断），卸载即移除。
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
    // 预览面板里的滚轮属于"滚正文"，不该把画布缩放掉。
    // （HUD 没有可滚动内容，因此不在排除之列 —— 光标停在 HUD 上时滚轮照样平移/缩放画布。）
    if (event.target instanceof Element && event.target.closest('.mn-graph-preview') !== null) {
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

  const fitNow = useCallback(() => {
    useGraphStore.getState().fitToWindow()
  }, [])

  // 按钮与命令（`graph.zoomIn` / `graph.zoomOut`）走**同一个** store 动作：
  // 缩放以视口中心为锚点，内容不会因为连续缩放而漂出屏幕
  const zoomIn = useCallback(() => {
    useGraphStore.getState().zoomIn()
  }, [])

  const zoomOut = useCallback(() => {
    useGraphStore.getState().zoomOut()
  }, [])

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target
    if (!(target instanceof Element)) return
    // HUD / 预览面板 / 文件夹标题按钮：它们自己处理点击，不参与画布平移
    if (target.closest('[data-mn-graph-nopan]') !== null) return
    // 左键落在卡片上由卡片自己处理（它在那里 stopPropagation）；这里只兜住卡片外的情况
    if (event.button === 0 && target.closest('.mn-graph-card') !== null) return
    if (event.button !== 0 && event.button !== 1) return

    const element = event.currentTarget
    if (typeof element.setPointerCapture === 'function') {
      try {
        element.setPointerCapture(event.pointerId)
      } catch {
        // 环境不支持指针捕获（jsdom）：不影响拖动，只是指针移出元素后会断开
      }
    }
    panRef.current = {
      pointerId: event.pointerId,
      button: event.button,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
    }
    setPanning(true)
  }, [])

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current
    if (pan === null || pan.pointerId !== event.pointerId) return
    const dx = event.clientX - pan.lastX
    const dy = event.clientY - pan.lastY
    if (dx === 0 && dy === 0) return
    if (Math.abs(dx) + Math.abs(dy) > CLICK_SLOP_PX) pan.moved = true
    pan.lastX = event.clientX
    pan.lastY = event.clientY
    useGraphStore.getState().panBy(dx, dy)
  }, [])

  const endPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current
    if (pan === null || pan.pointerId !== event.pointerId) return
    panRef.current = null
    setPanning(false)
    const element = event.currentTarget
    if (typeof element.releasePointerCapture === 'function') {
      try {
        element.releasePointerCapture(event.pointerId)
      } catch {
        // 指针已经释放
      }
    }
    // 在空白处"点一下"（不是拖动）= 关掉预览面板；拖动则不改变选中
    if (!pan.moved && pan.button === 0 && event.type === 'pointerup') {
      useGraphStore.getState().closePreview()
    }
  }, [])

  // -------------------------------------------------------------------------
  // 卡片 / 容器的回调（全部稳定，`GraphCard` 是 memo 的：平移时不会重渲染）
  // -------------------------------------------------------------------------

  const handleSelect = useCallback((relPath: string) => {
    useGraphStore.getState().select(relPath)
  }, [])

  /** 双击 / Ctrl+Enter：真的进编辑器打开（与文件树、wikilink 走同一条动作链）。 */
  const handleOpenInEditor = useCallback((relPath: string) => {
    useUiStore.getState().setViewMode('edit')
    void openNote(relPath)
  }, [])

  const handleMoveCard = useCallback((relPath: string, x: number, y: number) => {
    useGraphStore.getState().moveCard(relPath, x, y)
  }, [])

  const handleToggleFolder = useCallback((path: string) => {
    useGraphStore.getState().toggleFolder(path)
  }, [])

  /** 手动"重新读取图谱"：**完整重载**（清空视角/折叠/选中）。 */
  const handleRefresh = useCallback(() => {
    void useGraphStore.getState().load(rootPath, {
      indexBuilding: useLinksStore.getState().status.phase === 'building',
    })
  }, [rootPath])

  const selectedCard = selected === null ? undefined : cardsById.get(selected)
  const nodeCount = data?.nodes.length ?? 0
  const edgeCount = data?.edges.length ?? 0
  const showIndexNotice = indexPhase === 'building' || staleIndex
  const isEmpty = status === 'ready' && nodeCount === 0

  return (
    <div
      className={`mn-graph${panning ? ' mn-graph--panning' : ''}`}
      ref={hostRef}
      role="group"
      aria-label="知识图谱画布"
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
    >
      <div
        className="mn-graph__viewport"
        style={{
          transform: `translate(${Math.round(view.x)}px, ${Math.round(view.y)}px) scale(${view.zoom})`,
        }}
      >
        <div
          className="mn-graph__world"
          style={{
            width: layout?.bounds.width ?? 0,
            height: layout?.bounds.height ?? 0,
          }}
        >
          <GraphEdges visuals={visibleEdges} viewBox={visibleWorld} />

          {visibleFolders.map((folder) => (
            <GraphFolder key={folder.path === '' ? '\u0000root' : folder.path} folder={folder} onToggle={handleToggleFolder} />
          ))}

          {visibleCards.map((card) => (
            <GraphCard
              key={card.relPath}
              box={card}
              selected={card.relPath === selected}
              zoom={view.zoom}
              onSelect={handleSelect}
              onOpen={handleOpenInEditor}
              onMove={handleMoveCard}
            />
          ))}
        </div>
      </div>

      {/* ---------------------------------------------------------------- HUD */}
      <div className="mn-graph__hud" data-mn-graph-nopan>
        <div className="mn-graph__stats">
          <span className="mn-graph__stat">{nodeCount} 节点</span>
          <span className="mn-graph__stat">{edgeCount} 边</span>
          <span className="mn-graph__stat" title="当前缩放（Ctrl+滚轮 / Ctrl+= 放大 / Ctrl+- 缩小 / Ctrl+0 适应窗口）">
            {Math.round(view.zoom * 100)}%
          </span>
          {/* 保留视角的刷新：画布继续画旧数据，只在 HUD 上给一个轻量指示（不闪白） */}
          {refreshing && (
            <span className="mn-graph__badge mn-graph__badge--busy" title="正在重新读取图谱数据（保留当前视角）">
              刷新中…
            </span>
          )}
          {data?.truncated === true && (
            <span className="mn-graph__badge mn-graph__badge--warn" title="节点数超过宿主上限，只返回了度数最高的一部分">
              已截断
            </span>
          )}
          {layout !== null && layout.hiddenCards > 0 && (
            <span className="mn-graph__badge" title="被折叠的容器里的卡片">
              已折叠 {layout.hiddenCards}
            </span>
          )}
        </div>

        <div className="mn-graph__legend">
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
        </div>

        <div className="mn-graph__tools">
          {/* 定位笔记：几千张卡片时，"我想看看某一篇周围连了什么"没法靠拖拽完成 */}
          <div className="mn-graph__find">
            <input
              className="mn-graph__find-input"
              type="search"
              value={findQuery}
              placeholder="定位笔记…"
              aria-label="定位笔记"
              onChange={(event) => setFindQuery(event.target.value)}
              onKeyDown={(event) => {
                // 画布自己也监听键盘（+/-/0 与 Esc），这里把输入框里的事件拦住，
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
                  // 空态要说清楚：卡片可能根本没进图谱（节点数超过宿主上限时按度数截断），
                  // 而不是"这个输入框坏了"
                  <li className="mn-graph__find-empty">没有匹配的卡片</li>
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
            <Icon name="eye" size={14} />
          </button>
          <button type="button" className="mn-icon-button" onClick={zoomOut} title="缩小（Ctrl+-）" aria-label="缩小">
            <span className="mn-graph__zoom-glyph">−</span>
          </button>
          <button type="button" className="mn-icon-button" onClick={zoomIn} title="放大（Ctrl+=）" aria-label="放大">
            <span className="mn-graph__zoom-glyph">+</span>
          </button>
          <button
            type="button"
            className="mn-icon-button"
            onClick={() => useGraphStore.getState().resetManual()}
            title="重新自动排布（清除手工拖动的位置）"
            aria-label="重新自动排布"
          >
            <Icon name="columns" size={14} />
          </button>
          <button
            type="button"
            className="mn-icon-button"
            onClick={() => useGraphStore.getState().setCollapsed([])}
            title="展开全部文件夹"
            aria-label="展开全部文件夹"
          >
            <Icon name="folderOpen" size={14} />
          </button>
          <button
            type="button"
            className="mn-icon-button"
            onClick={() => useGraphStore.getState().setCollapsed(layout?.folderPaths ?? [])}
            title="收起全部文件夹"
            aria-label="收起全部文件夹"
          >
            <Icon name="folder" size={14} />
          </button>
          <button type="button" className="mn-icon-button" onClick={handleRefresh} title="重新读取图谱" aria-label="重新读取图谱">
            <Icon name="refresh" size={14} />
          </button>
        </div>
      </div>

      {/*
        顶部只留**一条**横幅：刷新提示与"索引构建中"说的是同一件事（画布上的数据可能不是最新），
        刷新的那条更具体（它直接说明"你看到的是上一次的结果"），所以同时成立时优先显示它 ——
        两条横幅叠在同一个位置只会互相盖住。
      */}
      {(refreshNotice !== null || showIndexNotice) && (
        <div className="mn-graph__notice" data-mn-graph-nopan>
          <Icon name="refresh" size={12} />
          <span>{refreshNotice ?? '链接索引构建中…（图谱可能还不完整）'}</span>
          <button type="button" className="mn-graph__notice-action" onClick={handleRefresh}>
            {refreshNotice === null ? '立即刷新' : '重新读取'}
          </button>
        </div>
      )}

      {status === 'loading' && nodeCount === 0 && (
        <div className="mn-graph__overlay">正在读取图谱…</div>
      )}

      {status === 'error' && error !== null && (
        <div className="mn-graph__overlay">
          <p className="mn-empty__text">{describeError(error, '读取图谱失败')}</p>
          <button type="button" className="mn-graph__notice-action" onClick={handleRefresh}>
            重试
          </button>
        </div>
      )}

      {isEmpty && !showIndexNotice && (
        <div className="mn-graph__overlay">
          <p className="mn-empty__text">
            这个 Vault 里还没有笔记（图谱的卡片来自 Markdown 笔记与它们之间的链接）
          </p>
        </div>
      )}

      {selected !== null && (
        <GraphPreview
          relPath={selected}
          title={selectedCard?.node.title ?? selected}
          onClose={() => useGraphStore.getState().closePreview()}
          onOpenInEditor={handleOpenInEditor}
        />
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
        <Icon name={folder.collapsed ? 'folder' : 'folderOpen'} size={12} />
        <span className="mn-graph-folder__label">{folder.label}</span>
        <span className="mn-graph-folder__count">{folder.noteCount}</span>
      </button>
    </div>
  )
}

/**
 * 把布局盒子转成卡片索引里的条目。
 *
 * 这里只是给 `Map` 一个明确的类型：`buildEdgeVisuals` 需要卡片上的 `node`
 * 来做 tooltip 文案（"甲 → 乙 · 双链 · 共 N 条链接"），所以不能退化成裸矩形。
 */
