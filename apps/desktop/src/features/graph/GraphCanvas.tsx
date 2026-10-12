/**
 * 知识图谱画布 —— **容器**（接 store 的那一层）。
 *
 * 一句话职责：订阅 store、组织子 hook 的调用顺序、把"算出来的事实"与回调交给纯视图
 * （`canvas-view.tsx` / `canvas-hud.tsx`），并把浮窗、右键菜单、力度面板挂在宿主里。
 *
 * ## 两种视图
 *
 * - **焦点视图（默认）**：以当前打开的笔记为圆心，只画与它相关的子图，跳数可调（1..5，双向）。
 *   卡片正面是那篇笔记的**完整 Markdown 预览**（排版在 `canvas/` 那一层）。
 * - **整个 Vault**：文件夹装箱 + 手工拖动 + 折叠容器，卡片是紧凑卡片（看结构，不看内容）。
 *
 * ## 为什么改成 canvas（ADR-0023/0036）
 *
 * 每张卡片一个 DOM 元素时，整篇正文的富文本要变成几千个节点，浏览器排版一帧就要几十毫秒，
 * 于是只能做"虚拟化 + 摘要"，而摘要恰恰是用户不满意的部分。canvas 里画 300 张卡片是一串
 * `fillText`；代价是命中测试、光标、可访问性都要自己来 —— 那部分分别住在
 * `use-canvas-input.ts`（输入）、`use-card-links.ts`（连线与 wikilink 热区）与
 * `canvas-api.ts`（refs / 坐标 / 每帧重画）里。
 *
 * ## 调用顺序（改动这里之前先读）
 *
 * store → `useCanvasFrame`（refs/量字）→ `useGraphLayout`（几何 memo）→ 视口换算与可见集合 →
 * `useForceSim`（共享的位置 ref）→ `useGraphData`（装载 + 定位）→ `useCanvasHit`（命中）→
 * `useCardLinks`（热区 + 连线几何）→ `useCanvasPaint`（画笔入参 + 每帧重画）→
 * `useCanvasFacts`（可断言事实）→ `useCanvasInput`（输入）。
 * 顺序由数据依赖决定：命中要用"当前矩形"、画笔要用"连线几何"、输入要用"命中的线"。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

import { openNote } from '@/app/actions'
import { ContextMenu, type ContextMenuItem } from '@/components/ContextMenu'
import { OVERSCAN, queryIndex, queryViewport, type GraphCardBox } from '@/domain/graph/layout'
import { visibleCards, type EgoCardBox } from '@/domain/graph/layout-ego'
import { useGraphStore } from '@/state/graph-store'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

import { useCanvasFrame, useCanvasHit, useCanvasPaint } from './canvas-api'
import { CanvasHud, type HudActions } from './canvas-hud'
import { CanvasView } from './canvas-view'
import { FloatingNote } from './FloatingNote'
import { ForcePanel } from './ForcePanel'
import { useCanvasFacts } from './use-canvas-facts'
import { useCanvasInput } from './use-canvas-input'
import { useCardLinks } from './use-card-links'
import { useForceSim } from './use-force-sim'
import { useGraphData } from './use-graph-data'
import { useGraphLayout } from './use-graph-layout'
import { transformOf, visibleWorld } from '@/domain/graph/viewport'

import './graph.css'

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
  /** 力导向的预设 id 与"是否持续漂浮"（两个偏好，见 `domain/graph/force-presets.ts`）。 */
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

  const [hovered, setHovered] = useState<string | null>(null)

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

  const pins = useGraphStore((state) => state.pins)

  const { hostRef, canvasRef, layoutRef, measure } = useCanvasFrame()

  const { vaultLayout, cardsById, rectIndex, egoLayout } = useGraphLayout({
    mode,
    data,
    collapsed,
    manual,
    ego,
    texts,
    cardSizes,
    titleOnly,
    measure,
    layoutRef,
  })

  const transform = useMemo(() => transformOf(view, viewport), [view, viewport])
  const visibleWorldRect = useMemo(() => visibleWorld(transform, OVERSCAN), [transform])

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

  const {
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
  } = useForceSim({ mode, egoLayout, ego, pins, selected, floating, forcePresetId })

  const { findQuery, setFindQuery, findMatches, locateCard, submitFind, nodesByPath } = useGraphData({
    rootPath,
    mode,
    focusRoot,
    depth,
    ego,
    data,
    egoLayout,
    cardsById,
  })

  const { worldPointOf, hitCard } = useCanvasHit({
    hostRef,
    transform,
    mode,
    egoLayout,
    vaultLayout,
    currentRect,
  })

  const { hoveredLink, setHoveredLinkIfChanged, linkAt, edgeVisuals } = useCardLinks({
    mode,
    titleOnly,
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
    transform,
    hitCard,
    nodesByPath,
    lastPointerRef,
  })

  const { paintNodes, paintedCards, edgeStats, paintedEdgesRef } = useCanvasPaint({
    hostRef,
    canvasRef,
    viewport,
    transform,
    edgeVisuals,
    visibleSet,
    mode,
    selected,
    hovered,
    hoveredLink,
    themeId,
    rootPath,
    measure,
    egoLayout,
    ego,
    vaultLayout,
    currentRect,
    tick,
    dragging,
    titleOnly,
  })

  const {
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
  } = useCanvasFacts({
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
  })

  const {
    panning,
    hoveredEdge,
    overResizeHandle,
    handlePointerDown,
    handlePointerMove,
    endPointer,
    handleDoubleClick,
    handleKeyDown,
    handlePointerLeave,
  } = useCanvasInput({
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
  })

  /**
   * 全库视图的自动"适应窗口"（同一个 Vault 只做一次，跨挂载记账）。
   *
   * 数据变化、折叠变化、拖动卡片都会让 layout 换一个对象，这里再跑一次也只是空转 ——
   * 镜头属于用户，只有换 Vault / 真实尺寸到手 / 用户自己按"适应窗口"时才该动。
   * 焦点视图的适应窗口由**力导向那条 effect** 负责（它用落定之后的包围盒，见 `use-force-sim.ts`）：
   * 这里刻意不再单独来一次，两个 effect 各调一次会互相覆盖。
   */
  useEffect(() => {
    if (mode !== 'vault') return
    useGraphStore.getState().autoFit()
  }, [mode, vaultLayout, rootPath, viewport])

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
   * HUD 的动作入口：全部指向既有 store 动作（`getState()` 与组件订阅的是同一个 store）。
   * 引用固定：HUD 是纯视图，props 每次换新对象会让它在漂浮时白重渲染。
   */
  const hudActions = useMemo<HudActions>(
    () => ({
      setMode: (next) => useGraphStore.getState().setMode(next),
      setDepth: (next) => useGraphStore.getState().setDepth(next),
      setForcePreset: (id) => useGraphStore.getState().setForcePreset(id),
      setTension: (value) => useGraphStore.getState().setTension(value),
      setEdgeFromLink: (on) => useGraphStore.getState().setEdgeFromLink(on),
      setTitleOnly: (on) => useGraphStore.getState().setTitleOnly(on),
      setRingRouting: (on) => useGraphStore.getState().setRingRouting(on),
      setFloating: (on) => useGraphStore.getState().setFloating(on),
      setCardHeight: (relPath, height) => useGraphStore.getState().setCardHeight(relPath, height),
      setCardFull: (relPath, full) => useGraphStore.getState().setCardFull(relPath, full),
      resetCardSize: (relPath) => useGraphStore.getState().resetCardSize(relPath),
      openFloating: (relPath) => useGraphStore.getState().openFloating(relPath),
      resetManual: () => useGraphStore.getState().resetManual(),
      setCollapsed: (paths) => useGraphStore.getState().setCollapsed(paths),
    }),
    [],
  )

  return (
    <CanvasView
      hostRef={hostRef}
      canvasRef={canvasRef}
      view={view}
      mode={mode}
      depth={depth}
      focusRoot={focusRoot}
      egoStatus={egoStatus}
      vaultLayout={vaultLayout}
      visibleFolders={visibleFolders}
      onToggleFolder={handleToggleFolder}
      paintNodeCount={paintNodes.length}
      paintedCards={paintedCards}
      rootRectAttr={rootRectAttr}
      cardRectsAttr={cardRectsAttr}
      pinnedCount={pins.size}
      selected={selected}
      overlaps={overlaps}
      edgeStats={edgeStats}
      hoveredEdge={hoveredEdge}
      panning={panning}
      hovered={hovered}
      hoveredLink={hoveredLink}
      overResizeHandle={overResizeHandle}
      nodeCount={nodeCount}
      loading={loading}
      activeError={activeError}
      empty={empty}
      showIndexNotice={showIndexNotice}
      refreshNotice={refreshNotice}
      handlePointerDown={handlePointerDown}
      handlePointerMove={handlePointerMove}
      endPointer={endPointer}
      handleDoubleClick={handleDoubleClick}
      handleContextMenu={handleContextMenu}
      handleKeyDown={handleKeyDown}
      onPointerLeave={handlePointerLeave}
      onRefresh={handleRefresh}
      onShowVault={() => useGraphStore.getState().setMode('vault')}
    >
      <CanvasHud
        mode={mode}
        depth={depth}
        nodeCount={nodeCount}
        edgeCount={edgeCount}
        view={view}
        vaultLayout={vaultLayout}
        refreshing={refreshing}
        truncated={truncated}
        forcePresetId={forcePresetId}
        tension={tension}
        edgeFromLink={edgeFromLink}
        titleOnly={titleOnly}
        ringRouting={ringRouting}
        floating={floating}
        selected={selected}
        cardSizes={cardSizes}
        forcePanelOpen={forcePanelOpen}
        findQuery={findQuery}
        findMatches={findMatches}
        releasePins={releasePins}
        onToggleForcePanel={() => setForcePanelOpen((open) => !open)}
        onRefresh={handleRefresh}
        submitFind={submitFind}
        locateCard={locateCard}
        setFindQuery={setFindQuery}
        fitNow={fitNow}
        zoomIn={zoomIn}
        zoomOut={zoomOut}
        actions={hudActions}
      />

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
    </CanvasView>
  )
}
