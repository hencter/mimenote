/**
 * 图谱画布的 **HUD**（只收 props）：视图切换 / 跳数 / 统计徽标 / 浮动态与观感开关 / 图例 / 工具条。
 *
 * 一句话职责：画布上所有"可点的小控件"与它们的状态显示。它是**视图**：不读 store，
 * 点击时调用容器递进来的 `actions`（每个动作都指向既有入口，不在这里重写任何业务）。
 *
 * 为什么与宿主分开（ADR-0060 §3.4 + §3 第 4 条）：这一块 JSX 超过 250 行、且有自己的大量
 * 条件渲染；放在宿主里会让"宿主负责坐标与生命周期、HUD 负责控件"这条边界看不见。
 *
 * 不变量：`.mn-graph__*` 的块名与 `data-graph-action` / `data-force-preset` / `data-card-height`
 * / `data-find-path` 这些属性是 e2e 与单测的抓手，**逐字不许改**。
 */

import { Icon } from '@/components/Icon'
import { FORCE_PRESETS } from '@/domain/graph/force-presets'
import type { GraphLayout, GraphView } from '@/domain/graph/layout'
import { MAX_EGO_DEPTH, MIN_EGO_DEPTH, type CardSize, type GraphMode } from '@/state/graph-store'

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

/** HUD 能触发的 store 动作（容器把 `useGraphStore.getState()` 的那几个入口原样递进来）。 */
export interface HudActions {
  setMode: (mode: GraphMode) => void
  setDepth: (depth: number) => void
  setForcePreset: (id: string) => void
  setTension: (tension: number) => void
  setEdgeFromLink: (on: boolean) => void
  setTitleOnly: (on: boolean) => void
  setRingRouting: (on: boolean) => void
  setFloating: (on: boolean) => void
  setCardHeight: (relPath: string, height: number) => void
  setCardFull: (relPath: string, full: boolean) => void
  resetCardSize: (relPath?: string) => void
  openFloating: (relPath: string) => void
  resetManual: () => void
  setCollapsed: (paths: readonly string[]) => void
}

export interface CanvasHudProps {
  mode: GraphMode
  depth: number
  nodeCount: number
  edgeCount: number
  view: GraphView
  vaultLayout: GraphLayout | null
  refreshing: boolean
  truncated: boolean
  forcePresetId: string
  tension: number
  edgeFromLink: boolean
  titleOnly: boolean
  ringRouting: boolean
  floating: boolean
  selected: string | null
  cardSizes: ReadonlyMap<string, CardSize>
  forcePanelOpen: boolean
  findQuery: string
  findMatches: readonly { relPath: string; title: string; folder: string }[]
  /** 松开被按住的卡片（力场那一层的收尾动作，见 `use-force-sim.ts`）。 */
  releasePins: () => void
  onToggleForcePanel: () => void
  /** 手动"重新读取图谱"：**完整重载**（清空视角/折叠/选中）。 */
  onRefresh: () => void
  submitFind: () => void
  locateCard: (relPath: string) => void
  setFindQuery: (value: string) => void
  fitNow: () => void
  zoomIn: () => void
  zoomOut: () => void
  actions: HudActions
}

export function CanvasHud(props: CanvasHudProps) {
  const {
    mode,
    depth,
    nodeCount,
    edgeCount,
    view,
    vaultLayout,
    refreshing,
    truncated,
    forcePresetId,
    tension,
    edgeFromLink,
    titleOnly,
    ringRouting,
    floating,
    selected,
    cardSizes,
    forcePanelOpen,
    findQuery,
    findMatches,
    releasePins,
    onToggleForcePanel,
    onRefresh,
    submitFind,
    locateCard,
    setFindQuery,
    fitNow,
    zoomIn,
    zoomOut,
    actions,
  } = props

  // ---------------------------------------------------------------- HUD
  return (
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
              onClick={() => actions.setMode('focus')}
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
              onClick={() => actions.setMode('vault')}
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
                onClick={() => actions.setDepth(depth - 1)}
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
                onClick={() => actions.setDepth(depth + 1)}
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
                  onClick={() => actions.setForcePreset(preset.id)}
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
                  actions.setTension(Number(event.target.value))
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
                onClick={() => actions.setEdgeFromLink(!edgeFromLink)}
              >
                从链接引出
              </button>
              <button
                type="button"
                className={`mn-graph__chip${titleOnly ? ' mn-graph__chip--active' : ''}`}
                aria-pressed={titleOnly}
                data-graph-action="toggle-title-only"
                title="只画标题（文件名），不排正文：一屏能看更多关系；此时连线改从卡片边界出发"
                onClick={() => actions.setTitleOnly(!titleOnly)}
              >
                仅标题
              </button>
              <button
                type="button"
                className={`mn-graph__chip${ringRouting ? ' mn-graph__chip--active' : ''}`}
                aria-pressed={ringRouting}
                data-graph-action="toggle-ring-routing"
                title="同环的连线沿环外弧走、跨环的线朝外鼓：线不再横穿圆心那块最挤的地方（关掉 = 两点一条曲线）"
                onClick={() => actions.setRingRouting(!ringRouting)}
              >
                沿环走线
              </button>
              <button
                type="button"
                className={`mn-graph__chip${floating ? ' mn-graph__chip--active' : ''}`}
                aria-pressed={floating}
                data-graph-action="toggle-floating"
                title="节点持续缓慢漂浮（关掉 = 落定后静止，省电）"
                onClick={() => actions.setFloating(!floating)}
              >
                漂浮
              </button>
              <button
                type="button"
                className="mn-graph__chip"
                data-graph-action="reset-card-size"
                title="把调过大小的卡片恢复成自动尺寸"
                onClick={() => actions.resetCardSize()}
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
                onClick={onToggleForcePanel}
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
                        if (choice.value === null) actions.resetCardSize(selected)
                        else if (choice.value === 'full') actions.setCardFull(selected, true)
                        else actions.setCardHeight(selected, choice.value)
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
                  onClick={() => actions.openFloating(selected)}
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
                onClick={() => actions.resetManual()}
                title="重新自动排布（清除手工拖动的位置）"
                aria-label="重新自动排布"
              >
                <Icon name="columns" size="sm" />
              </button>
              <button
                type="button"
                className="mn-icon-button"
                onClick={() => actions.setCollapsed([])}
                title="展开全部文件夹"
                aria-label="展开全部文件夹"
              >
                <Icon name="folderOpen" size="sm" />
              </button>
              <button
                type="button"
                className="mn-icon-button"
                onClick={() => actions.setCollapsed(vaultLayout?.folderPaths ?? [])}
                title="收起全部文件夹"
                aria-label="收起全部文件夹"
              >
                <Icon name="folder" size="sm" />
              </button>
            </>
          )}
          <button type="button" className="mn-icon-button" onClick={onRefresh} title="重新读取图谱" aria-label="重新读取图谱">
            <Icon name="refresh" size="sm" />
          </button>
        </div>
      </div>
  )
}
