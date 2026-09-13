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
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'

import { openNote } from '@/app/actions'
import { Icon } from '@/components/Icon'
import { describeError } from '@/ipc/types'
import { useGraphStore } from '@/state/graph-store'
import { useLinksStore } from '@/state/links-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'
import { GraphCard } from './GraphCard'
import { GraphEdges } from './GraphEdges'
import { GraphPreview } from './GraphPreview'
import {
  OVERSCAN,
  applyManualPositions,
  buildEdgeVisuals,
  buildLayout,
  buildRectIndex,
  fitView,
  queryIndex,
  queryViewport,
  worldViewport,
  type GraphCardBox,
  type GraphFolderBox,
  type Size,
} from './layout'

import './graph.css'

/**
 * 首帧（或 jsdom 这类没有布局的环境）用的视口尺寸。
 *
 * 为什么要有兜底：`clientWidth` 为 0 时任何"适应窗口"都会算出 zoom = 0 或无穷，
 * 于是整块画布被裁成空。用一个合理的默认值可以让**没有真实布局的环境**（单元测试）
 * 依然渲染出正确的结构；真实环境里第一帧之后 ResizeObserver 会立刻给出真实尺寸，
 * 那时会再自动适应一次（见下面的 fit 逻辑）。
 */
const FALLBACK_VIEWPORT: Size = { width: 1280, height: 800 }

/** 适应窗口时四周留白。 */
const FIT_PADDING = 64

/** 按一次 `+`/`-` 按钮或键的缩放倍率。 */
const ZOOM_STEP = 1.25

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
  const indexPhase = useLinksStore((state) => state.status.phase)

  const hostRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState<{ width: number; height: number; known: boolean }>({
    ...FALLBACK_VIEWPORT,
    known: false,
  })
  const [panning, setPanning] = useState(false)
  const panRef = useRef<{
    pointerId: number | undefined
    button: number
    lastX: number
    lastY: number
    moved: boolean
  } | null>(null)

  // -------------------------------------------------------------------------
  // 数据加载（Vault 变化 → 拉一次图谱；索引未就绪 → 就绪后自动补一次）
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (rootPath === null) {
      useGraphStore.getState().clear()
      return
    }
    const building = useLinksStore.getState().status.phase === 'building'
    void useGraphStore.getState().load(rootPath, { indexBuilding: building })
  }, [rootPath])

  useEffect(() => {
    if (rootPath === null || indexPhase !== 'ready') return
    if (!useGraphStore.getState().staleIndex) return
    // 数据是在索引构建期间拿的（可能不完整）：索引一就绪就自动补一次，不需要用户手动刷新
    void useGraphStore.getState().load(rootPath, { indexBuilding: false })
  }, [indexPhase, rootPath])

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
  const visibleWorld = useMemo(() => worldViewport(view, size, OVERSCAN), [view, size])

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
  // 视口尺寸 + 首次自动"适应窗口"
  // -------------------------------------------------------------------------

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const sync = (): void => {
      const width = host.clientWidth
      const height = host.clientHeight
      if (width > 0 && height > 0) setSize({ width, height, known: true })
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

  const fitRef = useRef<{ key: string; fallback: boolean }>({ key: '', fallback: true })
  useEffect(() => {
    if (layout === null || layout.totalCards === 0) return
    const key = `${rootPath ?? ''}\u0000${layout.bounds.width}x${layout.bounds.height}\u0000${layout.totalCards}`
    const previous = fitRef.current
    const fallback = !size.known
    // 同一份布局只适应一次；唯一例外是"第一次用的是兜底尺寸"（真实尺寸到手后再适应一次）
    if (previous.key === key && (previous.fallback === false || fallback)) return
    fitRef.current = { key, fallback }
    useGraphStore.getState().setView(fitView(layout.bounds, size, FIT_PADDING))
  }, [layout, rootPath, size])

  // -------------------------------------------------------------------------
  // 交互：滚轮（平移 + Ctrl 缩放）、拖动平移、键盘
  // -------------------------------------------------------------------------

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
    if (layout === null) return
    useGraphStore.getState().setView(fitView(layout.bounds, size, FIT_PADDING))
  }, [layout, size])

  const zoomByStep = useCallback((factor: number) => {
    // 按钮/键缩放以视口中心为锚点：内容不会因为连续缩放而漂出屏幕
    useGraphStore.getState().zoomAt(factor, { x: size.width / 2, y: size.height / 2 })
  }, [size.height, size.width])

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const state = useGraphStore.getState()
      switch (event.key) {
        case '+':
        case '=':
          event.preventDefault()
          zoomByStep(ZOOM_STEP)
          return
        case '-':
        case '_':
          event.preventDefault()
          zoomByStep(1 / ZOOM_STEP)
          return
        case '0':
          event.preventDefault()
          fitNow()
          return
        case 'Escape':
          event.preventDefault()
          state.select(null) // 关掉预览面板
          return
        default:
          return
      }
    },
    [fitNow, zoomByStep],
  )

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
      useGraphStore.getState().select(null)
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
      onKeyDown={handleKeyDown}
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
          <span className="mn-graph__stat" title="当前缩放（Ctrl+滚轮 / +- / 0 适应窗口）">
            {Math.round(view.zoom * 100)}%
          </span>
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
          <button type="button" className="mn-icon-button" onClick={fitNow} title="适应窗口（0）" aria-label="适应窗口">
            <Icon name="eye" size={14} />
          </button>
          <button type="button" className="mn-icon-button" onClick={() => zoomByStep(1 / ZOOM_STEP)} title="缩小（-）" aria-label="缩小">
            <span className="mn-graph__zoom-glyph">−</span>
          </button>
          <button type="button" className="mn-icon-button" onClick={() => zoomByStep(ZOOM_STEP)} title="放大（+）" aria-label="放大">
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

      {showIndexNotice && (
        <div className="mn-graph__notice" data-mn-graph-nopan>
          <Icon name="refresh" size={12} />
          <span>链接索引构建中…（图谱可能还不完整）</span>
          <button type="button" className="mn-graph__notice-action" onClick={handleRefresh}>
            立即刷新
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
          onClose={() => useGraphStore.getState().select(null)}
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
