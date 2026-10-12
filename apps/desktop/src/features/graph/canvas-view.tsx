/**
 * 图谱画布的**视图**（只收 props，不读 store、不碰 ref 的所有权）。
 *
 * 一句话职责：把宿主 `div.mn-graph`（连同全部 `data-graph-*` 可断言事实与指针/键盘入口）、
 * 世界层里的文件夹容器、`<canvas>`、连线悬停提示与四层遮罩渲染出来。
 *
 * 为什么与容器分开（ADR-0060 §3.4）：**接 store 的是容器（`canvas-api.tsx`），只收 props 的
 * 是视图**。拆开的收益是可断言性：这一层的每个数字都是"容器这次算出来的事实"，
 * 读这份 props 就能知道画布当前的样子，不必再去 store 里推。
 *
 * ## 两条不许破的纪律
 *
 * 1. **DOM 结构与属性一个都不许改**（含顺序）：`e2e/*.e2e.test.ts` 的 610 处选择器、
 *    `tests/*.tsx` 的 744 处选择器都压在 `.mn-*` 与 `data-graph-*` 上。
 * 2. **`data-graph-*` 是 canvas 的唯一抓手**：卡片与连线都画在 canvas 上，没有 DOM 可查，
 *    所以"当前视图/跳数/缩放/偏移/画了几张/画了几条线/悬停到哪条线"必须继续如实写在宿主属性上。
 */

import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject } from 'react'

import { Icon } from '@/components/Icon'
import type { GraphFolderBox, GraphLayout, GraphView } from '@/domain/graph/layout'
import type { MimenoteError } from '@/ipc/types'
import { describeError } from '@/ipc/types'
import type { GraphMode, GraphStatus } from '@/state/graph-store'

import { GraphFolder } from './GraphFolder'
import type { HoveredLink } from './use-card-links'

/** 连线一帧之后的诊断数字（只用于 `data-graph-edge-*` 属性，不参与渲染决策）。 */
export interface GraphEdgeStats {
  /** 卡外那段画了几条（= 有几何可画的边数）。 */
  span: number
  /** 其中画成虚线的（悬空边、或"被选中卡片提到"的入链）。 */
  dashed: number
  /** 与圆心/选中相关的（强调档）。 */
  highlight: number
  /** 强调且虚线的（"入链画虚线、出链实线"这一条就靠这两个数的差来断言）。 */
  highlightDashed: number
  /** 与圆心/选中无关而被淡化的（淡化不等于隐藏：上下文还在）。 */
  dim: number
  /** 其中走弧的（几何层的"同环走弧"，见 `edge-paint.ts` 的 `PaintedEdge.shape`）。 */
  arcs: number
  /** 三类语义色相各几条（出链 / 入链 / 环间），写成 `出,入,环间` —— ADR-0028 的分类抓手。 */
  hues: string
  /** 卡内那段引线画了几条（关掉「从正文链接引出」时应为 0）。 */
  leads: number
  /** 卡外那些**曲线**的"鼓出比"（控制点到弦的距离 ÷ 弦长；`;` 连接，直线不参与）。 */
  bulges: string
  /** 悬空边标出的目标名（`;` 连接；"这里缺一篇笔记"必须一眼看得见）。 */
  phantoms: string
  /** 画成**平行束**的边有几条（ADR-0052：同一对笔记之间有多条链接时画 2–3 条平行线）。 */
  bundled: number
  /** 卡外那段一共画了几条**笔触**（= Σ 每条边的 `bundle`；没有束时与 `span` 相等）。 */
  lines: number
}

export interface CanvasViewProps {
  hostRef: RefObject<HTMLDivElement | null>
  canvasRef: RefObject<HTMLCanvasElement | null>
  view: GraphView
  mode: GraphMode
  depth: number
  focusRoot: string | null
  egoStatus: GraphStatus
  /** 全库布局（焦点视图为 `null`）：世界层的尺寸与"已折叠 N 张"来自它。 */
  vaultLayout: GraphLayout | null
  visibleFolders: readonly GraphFolderBox[]
  onToggleFolder: (path: string) => void
  /** 交给画笔的卡片数（= 布局里的全部卡片，**未**经视口裁剪）。 */
  paintNodeCount: number
  /** 上一帧真正画出来的张数（裁剪之后）。 */
  paintedCards: number
  /** 圆心那张卡片当前的世界矩形（`x,y,w,h`，保留整数）。 */
  rootRectAttr: string
  /** 当前**可见**卡片的矩形（`relPath|x,y,w,h`，世界坐标，`;` 分隔，保留一位小数）。 */
  cardRectsAttr: string
  pinnedCount: number
  selected: string | null
  /** 当前布局里重叠的卡片对数（碰撞是硬约束时应当恒为 0）。 */
  overlaps: number
  edgeStats: GraphEdgeStats
  hoveredEdge: { key: string; title: string; x: number; y: number } | null
  panning: boolean
  hovered: string | null
  hoveredLink: HoveredLink | null
  overResizeHandle: boolean
  nodeCount: number
  loading: boolean
  activeError: MimenoteError | null
  empty: boolean
  showIndexNotice: boolean
  refreshNotice: string | null
  handlePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  handlePointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void
  endPointer: (event: ReactPointerEvent<HTMLDivElement>) => void
  handleDoubleClick: (event: ReactPointerEvent<HTMLDivElement>) => void
  handleContextMenu: (event: ReactPointerEvent<HTMLDivElement>) => void
  handleKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
  onPointerLeave: () => void
  /** 手动"重新读取图谱"（完整重载）。 */
  onRefresh: () => void
  /** 空态里"看看整个 Vault"那个按钮。 */
  onShowVault: () => void
  /** HUD / 力度面板 / 浮窗 / 卡片右键菜单：都由容器备好，插在连线提示之后。 */
  children?: ReactNode
}

export function CanvasView(props: CanvasViewProps) {
  const {
    hostRef,
    canvasRef,
    view,
    mode,
    depth,
    focusRoot,
    egoStatus,
    vaultLayout,
    visibleFolders,
    onToggleFolder,
    paintNodeCount,
    paintedCards,
    rootRectAttr,
    cardRectsAttr,
    pinnedCount,
    selected,
    overlaps,
    edgeStats,
    hoveredEdge,
    panning,
    hovered,
    hoveredLink,
    overResizeHandle,
    nodeCount,
    loading,
    activeError,
    empty,
    showIndexNotice,
    refreshNotice,
    handlePointerDown,
    handlePointerMove,
    endPointer,
    handleDoubleClick,
    handleContextMenu,
    handleKeyDown,
    onPointerLeave,
    onRefresh,
    onShowVault,
    children,
  } = props

  return (
    <div
      className={`mn-graph${panning ? ' mn-graph--panning' : ''}${
        hovered === null ? '' : ' mn-graph--over-card'
      }${hoveredLink === null ? '' : ' mn-graph--over-link'}${
        hoveredEdge === null ? '' : ' mn-graph--over-edge'
      }${overResizeHandle ? ' mn-graph--over-resize' : ''} mn-graph--${mode}`}
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
      data-graph-canvas-cards={paintNodeCount}
      /* 上一帧真正画出来的张数（裁剪之后） */
      data-graph-painted-cards={paintedCards}
      data-graph-root-rect={rootRectAttr}
      data-graph-card-rects={cardRectsAttr}
      /* 被按住的卡片数（漂浮时"我按住了几张"一眼可见） */
      data-graph-pinned={pinnedCount}
      /* 当前选中的卡片（单击选中/空白取消；自动化据此断言"选中了谁"，画布上没有 DOM 可查） */
      data-graph-selected={selected ?? ''}
      /* 当前布局里重叠的卡片对数（碰撞是硬约束时应当恒为 0） */
      data-graph-overlaps={overlaps}
      /*
        连线的可断言事实（ADR-0036）。连线画在 canvas 上，没有 DOM 节点可查 ——
        于是"这一帧画了几条线、其中几条是提亮的/虚线的/淡化的/走弧的、悬空边标出了哪些名字"
        必须变成读得到的事实，否则两层 E2E 就只能去截图里数像素。
        这些数字的**前身**是 SVG 元素上的那一串类名（`--dashed` / `--highlight` / `--dim` /
        `--out`），搬迁时逐条对应过来，断言的性质没有变弱。
      */
      data-graph-edges={edgeStats.span}
      data-graph-edge-dashed={edgeStats.dashed}
      data-graph-edge-highlight={edgeStats.highlight}
      data-graph-edge-highlight-dashed={edgeStats.highlightDashed}
      data-graph-edge-dim={edgeStats.dim}
      data-graph-edge-arcs={edgeStats.arcs}
      data-graph-edge-hues={edgeStats.hues}
      data-graph-edge-leads={edgeStats.leads}
      data-graph-edge-bulges={edgeStats.bulges}
      data-graph-edge-phantoms={edgeStats.phantoms}
      data-graph-edge-bundled={edgeStats.bundled}
      data-graph-edge-lines={edgeStats.lines}
      /* 悬停到的那条线（key = `from\0to\0kind`；空串 = 没有悬停） */
      data-graph-edge-hover={hoveredEdge?.key ?? ''}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onPointerLeave={onPointerLeave}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
    >

      {/* 文件夹容器留在 DOM 里（同一套 CSS transform），连线与卡片都画在 canvas 上 */}
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
          {mode === 'vault' &&
            visibleFolders.map((folder) => (
              <GraphFolder
                key={folder.path === '' ? '\u0000root' : folder.path}
                folder={folder}
                onToggle={onToggleFolder}
              />
            ))}
        </div>
      </div>

      {/*
        卡片与连线都画在这一张 canvas 上（ADR-0036）。

        原先连线是两层 `<svg>`（卡外那段垫在卡片下面、卡内引线挂在卡片上面，靠 z-index 0/2 凑出
        "卡片盖住穿过它的线、但它自己肚子里那段引线还在"）。搬家之后这件事变成了**同一次绘制里的
        调用顺序**：卡外那段 → 卡片 → 卡内引线（见 `paintGraph` 的入口注释）。
        少两层 DOM、少两份 CSS transform、还少一次"每帧的 React 渲染"（漂浮因此能到 60fps）。
      */}
      <canvas
        className="mn-graph__canvas"
        ref={canvasRef}
        data-mn-cards={paintNodeCount}
        aria-hidden="true"
      />

      {/*
        连线上的悬停提示。
        为什么必须有它：SVG 那一版的 `<title>` 其实**从来没有生效过** —— `.mn-graph__edges` 上写着
        `pointer-events: none`，子元素继承它，鼠标永远落不到那条 path 上。搬进 canvas 之后
        "悬停到哪条线"是自己算的（`edgeAt`），提示也就自己画：同一条边的 `count > 1`（共 N 条链接）、
        这条线是从正文哪段 `[[链接]]` 引出来的，这些信息只有这里能看到。
      */}
      {hoveredEdge !== null && (
        <div
          className="mn-graph__edge-tip"
          role="tooltip"
          data-graph-edge-tip={hoveredEdge.key}
          style={{ left: hoveredEdge.x, top: hoveredEdge.y }}
        >
          {hoveredEdge.title}
        </div>
      )}

      {children}

      {/*
        顶部只留**一条**横幅：刷新提示与"索引构建中"说的是同一件事（画布上的数据可能不是最新），
        刷新的那条更具体（它直接说明"你看到的是上一次的结果"），所以同时成立时优先显示它 ——
        两条横幅叠在同一个位置只会互相盖住。
      */}
      {(refreshNotice !== null || showIndexNotice) && (
        <div className="mn-graph__notice" data-mn-graph-nopan>
          <Icon name="refresh" size="xs" />
          <span>{refreshNotice ?? '链接索引构建中…（图谱可能还不完整）'}</span>
          <button type="button" className="mn-graph__notice-action" onClick={onRefresh}>
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
          <button type="button" className="mn-graph__notice-action" onClick={onRefresh}>
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
              onClick={onShowVault}
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
