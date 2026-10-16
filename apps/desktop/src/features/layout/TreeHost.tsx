/**
 * 容器切割树的**渲染器**（ADR-0035 的 UI 层）：把 `ui-store.layout` 那棵二叉切割树
 * 画成"格子 + 分隔条"，每个格子 = 一条标签栏（`LeafTabs`）+ 一块内容。
 *
 * ## 每个格子显示什么（内容分派只有这一套规则）
 *
 * 1. 激活标签是**视图模块** → 那一块面板（文件树 / 链接 / 标签 / 大纲）；
 * 2. 激活标签是**当前文档**（`note-store.doc`）→ 主视图三选一（编辑 / 阅读 / 图谱），
 *    或附件查看器（`openedFile`，见 ADR-0032）；
 * 3. 激活标签是**别的笔记** → 只读预览（`StaticNotePreview`）。note-store 是单文档模型，
 *    编辑器全局只有一份；"一格可写、其余可读"，点那篇笔记的标签就把它变成当前文档；
 * 4. **空叶**（整棵树只剩一格且没有标签，= "还没打开任何笔记"）→ 主视图的空文档态。
 *
 * ## 隐藏 ≠ 移除（收缩规则）
 *
 * 面板可见性仍归各自的开关（`Ctrl+B` 等）。半边不可渲染时另一边吃满、分隔条不画。
 * **纯模块侧栏**收起后整栏卸掉（不另开边缘窄轨）；折叠/展开按钮固定在**内容叶标签条**
 * 左右两端，收起后同一颗按钮原地变「展开」。**空叶永远渲染**—— 判据是
 * `tree-layout.ts` 的 `subtreeRenderable`。
 *
 * ## 顶部空间（ADR-0038）
 *
 * 独立标题栏退役后，**右上叶**（贴着窗口右上角的那一格，判据是 `topRightLeafId`）
 * 的标签条**即使没有标签也渲染**：它是三个窗口按钮的宿主，也是整窗保证存在的拖动区
 * （`data-tauri-drag-region="deep"`，Tauri 自动跳过 `role=tab` / `button` 等可点击元素）。
 * 按钮跟着"最右一格"走而不是跟着主叶走：右停靠面板的家就在主叶右边，跟主叶会停在窗口中间。
 *
 * ## 拖标签的落点
 *
 * 标签是拖动源（`LeafTabs`），落点由这里算（`drop-target.ts` 出判据）：
 * 落在**标签条**上 = 插到第几位（条内画落点线）；落在**内容区** = 中央并入这一格、
 * 四边带在那里切一刀（画半格高亮）。拖到自己**独占**格子的边缘是无操作
 * （切出一格只装自己，AD​​R-0035 写明这条由拖拽层拦下）。
 *
 * ## 装配职责
 *
 * 旧全局标签栏（`TabBar`）退役后，它挂着的两件事搬到这里：`installTabsSync`
 * （标签/布局树与其它 store 的对账）与光标记忆器（`caret-memory`）——
 * TreeHost 与旧 TabBar 同一生命周期（打开 Vault 后才挂载），挂载即安装、卸载即撤销。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'

import { Splitter } from '@/components/Splitter'
import { Icon } from '@/components/Icon'
import { Tooltip } from '@/components/Tooltip'
import { openNoteInNewTab } from '@/app/actions'
import { isMarkdown } from '@/domain/paths'
import { MarkdownEditor } from '@/features/editor/MarkdownEditor'
import { GraphCanvas } from '@/features/graph/GraphCanvas'
import { LinksPanel } from '@/features/links/LinksPanel'
import { OutlinePanel } from '@/features/outline/OutlinePanel'
import { MarkdownPreview } from '@/features/preview/MarkdownPreview'
import { StaticNotePreview } from '@/features/preview/StaticNotePreview'
import { TagsPanel } from '@/features/tags/TagsPanel'
import { clearCaretMemory, editorCaretMemory } from '@/features/tabs/caret-memory'
import { FileTree } from '@/features/vault/FileTree'
import { RecentVaults } from '@/features/vault/RecentVaults'
import { TreeToolbar } from '@/features/vault/TreeToolbar'
import { FileViewer } from '@/features/viewer/FileViewer'
import { useNoteStore } from '@/state/note-store'
import { installTabsSync, setCaretMemory, useTabsStore } from '@/state/tabs-store'
import { useSettingsStore } from '@/state/settings-store'
import { useUiStore } from '@/state/ui-store'

import { contentDropAt, tabIndexAt, type DropEdge } from './drop-target'
import { useLayoutDrag } from './layout-drag'
import { LeafTabs, type SideToggle } from './LeafTabs'
import { useModuleVisibility } from './module-visibility'
import { adjustNewSplitRatio } from './split-size'
import { TREE_TOOLBAR_MIN_WIDTH_PX } from '@/features/vault/TreeToolbar'
import {
  clampRatioForExtent,
  evenSplit,
  isViewModule,
  leafOfItem,
  leftDrawerModules,
  MIN_LEAF_PIXELS,
  moveItem,
  NARROW_LEAF_PIXELS,
  nodeContainsItem,
  noteItem,
  notePathOf,
  rightDrawerModules,
  setActive,
  setRatio,
  subtreeRenderable,
  contentLeafId as resolveContentLeafId,
  topRightLeafId,
  type LayoutItemId,
  type LeafNode,
  type SplitNode,
  type TreeLayout,
  type ViewModuleId,
} from '@/domain/layout/tree-layout'

import './tree-host.css'

/** 一次拖动的落点提示（`null` = 没有/不落在这一格）。 */
type DropHint =
  | { kind: 'tab'; index: number }
  | { kind: 'merge' }
  | { kind: 'split'; edge: DropEdge }

function hintEqual(a: DropHint | null, b: DropHint | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind !== b.kind) return false
  if (a.kind === 'tab' && b.kind === 'tab') return a.index === b.index
  if (a.kind === 'split' && b.kind === 'split') return a.edge === b.edge
  return true
}

/** 渲染层需要的上下文（往递归里传的只有这些）。 */
interface RenderContext {
  /** 一个标签此刻可见吗（模块看开关、笔记永远可见）。 */
  isVisibleItem: (item: LayoutItemId) => boolean
  /**
   * 右上叶 id（贴着窗口右上角的那一格，判据 `tree-layout.topRightLeafId`）：
   * 三个窗口按钮挂在它的标签条右端（ADR-0038）。
   */
  windowControlsLeafId: string | null
  /**
   * 内容主叶：左右侧栏折叠/展开按钮都挂在它的标签条上（左在标签左侧、右在滚动区右侧）。
   */
  contentLeafId: string | null
  /** 内容叶左侧折叠控件（`null` = 没有独立左栏）。 */
  leftSide: SideToggle | null
  /** 内容叶右侧折叠控件（`null` = 没有独立右栏）。 */
  rightSide: SideToggle | null
  /** 当前文档的相对路径（`null` = 没有打开）。 */
  currentDoc: string | null
}

/** 侧栏模块名单 → 折叠/展开控件；任一模块可见则「折叠」，否则「展开」。 */
function sideToggleFor(
  modules: ViewModuleId[] | null,
  visibility: Record<ViewModuleId, boolean>,
): SideToggle | null {
  if (modules === null || modules.length === 0) return null
  return {
    mode: modules.some((id) => visibility[id]) ? 'collapse' : 'expand',
    modules,
  }
}

export function TreeHost() {
  const layout = useUiStore((state) => state.layout)
  const visibility = useModuleVisibility()
  const currentDoc = useNoteStore((state) => state.doc?.relPath ?? null)

  // 标签/布局树对账 + 光标记忆器（旧 TabBar 的装配职责，见文件头）
  useEffect(() => {
    const dispose = installTabsSync()
    setCaretMemory(editorCaretMemory)
    return () => {
      setCaretMemory(null)
      clearCaretMemory()
      dispose()
    }
  }, [])

  /**
   * 「我要看当前文档」的显式意图（切视图模式 / 打开附件）把那一格翻回当前文档：
   * 用户把当前文档所在的格子翻到了模块标签、再按 `Ctrl+G`，图谱必须真的出现 ——
   * 否则"切换视图"在那一格毫无表象，像快捷键坏了。
   */
  const viewMode = useUiStore((state) => state.viewMode)
  const openedFile = useUiStore((state) => state.openedFile)
  useEffect(() => {
    if (currentDoc === null) return
    const ui = useUiStore.getState()
    const item = noteItem(currentDoc)
    const leaf = leafOfItem(ui.layout, item)
    if (leaf !== null && leaf.active !== item) ui.setLayout(setActive(ui.layout, leaf.id, item))
  }, [viewMode, openedFile, currentDoc])

  const isVisibleItem = useCallback(
    (item: LayoutItemId): boolean => (isViewModule(item) ? visibility[item] : true),
    [visibility],
  )

  /**
   * 窗口按钮的宿主 = **右上叶**（ADR-0038；`topRightLeafId` 的注释里写了为什么不是主叶：
   * 右停靠面板的家在主叶右边，跟着主叶走按钮会停在窗口中间）。
   * 判据只认"渲染器实际画出来的树"（不可渲染的半边跳过），因此与 `LeafPane` 的渲染一致。
   */
  const windowControlsLeafId = useMemo(
    () => topRightLeafId(layout, isVisibleItem),
    [layout, isVisibleItem],
  )
  const contentId = useMemo(() => resolveContentLeafId(layout), [layout])
  // 侧栏开/关会改 visibility，但不改 layout 树 —— 依赖 visibility 才能在折叠后切成「展开」
  const leftSide = useMemo(
    () => sideToggleFor(leftDrawerModules(layout), visibility),
    [layout, visibility],
  )
  const rightSide = useMemo(
    () => sideToggleFor(rightDrawerModules(layout), visibility),
    [layout, visibility],
  )

  const ctx: RenderContext = {
    isVisibleItem,
    windowControlsLeafId,
    contentLeafId: contentId,
    leftSide,
    rightSide,
    currentDoc,
  }

  return (
    <div className="mn-tree-host">
      {/*
        整棵树都不可渲染（所有格子都只剩被隐藏的模块 —— 例如四块面板全关且没开笔记）时，
        也不能让主区空白：退回一格"主视图空态"（与旧布局"主区域永远在"同一底线）。
        这一格同样要带上标签条 —— 窗口按钮住在那里，不能随空态一起消失（ADR-0038）。
      */}
      {subtreeRenderable(layout, isVisibleItem) ? (
        <NodeView node={layout} ctx={ctx} />
      ) : (
        <div className="mn-leaf" data-leaf-id="fallback">
          <LeafTabs leaf={FALLBACK_LEAF} items={[]} dropIndex={null} windowControls />
          <div className="mn-leaf__content">
            <MainViews />
          </div>
        </div>
      )}
    </div>
  )
}

/** 空态兜底格子的合成叶（只为给标签条一个身份；没有标签）。 */
const FALLBACK_LEAF: LeafNode = { kind: 'leaf', id: 'fallback', items: [], active: null }

/** 递归渲染一个节点。 */
function NodeView({ node, ctx }: { node: TreeLayout; ctx: RenderContext }) {
  if (node.kind === 'leaf') return <LeafPane leaf={node} ctx={ctx} />

  const aOk = subtreeRenderable(node.a, ctx.isVisibleItem)
  const bOk = subtreeRenderable(node.b, ctx.isVisibleItem)
  if (!aOk && !bOk) return null
  // 半边不可渲染（含纯模块侧栏收起）→ 另一边吃满；折叠按钮在内容叶标签条上，不另开窄轨
  if (!aOk) return <NodeView node={node.b} ctx={ctx} />
  if (!bOk) return <NodeView node={node.a} ctx={ctx} />
  return <SplitView node={node} ctx={ctx} />
}

/** 左右（或上下）两侧各自的像素下限：装着文件树的那侧抬到工具栏图标条宽度。 */
function splitMins(node: SplitNode): { a: number; b: number } {
  const treeMin = node.axis === 'row' ? TREE_TOOLBAR_MIN_WIDTH_PX : MIN_LEAF_PIXELS
  return {
    a: nodeContainsItem(node.a, 'tree') ? treeMin : MIN_LEAF_PIXELS,
    b: nodeContainsItem(node.b, 'tree') ? treeMin : MIN_LEAF_PIXELS,
  }
}

/** 一刀 split：两个半格 + 中间一条分隔条（拖它改比例、双击均分）。 */
function SplitView({ node, ctx }: { node: SplitNode; ctx: RenderContext }) {
  const ref = useRef<HTMLDivElement | null>(null)

  /** 指针位置 → 这一刀的比例（前半占多少）。容器量不到时不改（jsdom 里没有布局）。 */
  const ratioFrom = (event: PointerEvent): number | null => {
    const el = ref.current
    if (el === null || typeof el.getBoundingClientRect !== 'function') return null
    const rect = el.getBoundingClientRect()
    const ratio =
      node.axis === 'row'
        ? (event.clientX - rect.left) / rect.width
        : (event.clientY - rect.top) / rect.height
    return Number.isFinite(ratio) ? ratio : null
  }

  return (
    <div
      className={`mn-tree-split mn-tree-split--${node.axis}`}
      data-split-id={node.id}
      data-axis={node.axis}
      ref={ref}
    >
      <div className="mn-tree-split__pane" style={{ flex: `${node.ratio} 1 0` }}>
        <NodeView node={node.a} ctx={ctx} />
      </div>
      <Splitter
        orientation={node.axis === 'row' ? 'vertical' : 'horizontal'}
        ariaLabel="调整分栏比例（双击均分）"
        onDrag={(event) => {
          const ratio = ratioFrom(event)
          if (ratio === null) return
          const el = ref.current
          const rect = el?.getBoundingClientRect()
          const extent = node.axis === 'row' ? (rect?.width ?? 0) : (rect?.height ?? 0)
          const ui = useUiStore.getState()
          ui.setLayout(
            setRatio(ui.layout, node.id, clampRatioForExtent(ratio, extent, splitMins(node))),
          )
        }}
        onNudge={(delta) => {
          const el = ref.current
          if (el === null) return
          const rect = el.getBoundingClientRect()
          const size = node.axis === 'row' ? rect.width : rect.height
          if (size <= 0) return
          const ui = useUiStore.getState()
          ui.setLayout(
            setRatio(
              ui.layout,
              node.id,
              clampRatioForExtent(node.ratio + delta / size, size, splitMins(node)),
            ),
          )
        }}
        onEven={() => {
          const ui = useUiStore.getState()
          ui.setLayout(evenSplit(ui.layout, node.id))
        }}
      />
      <div className="mn-tree-split__pane" style={{ flex: `${1 - node.ratio} 1 0` }}>
        <NodeView node={node.b} ctx={ctx} />
      </div>
    </div>
  )
}

/** 一个叶子：标签栏 + 内容 + 拖放落点。 */
function LeafPane({ leaf, ctx }: { leaf: LeafNode; ctx: RenderContext }) {
  const { isVisibleItem } = ctx
  const visibleItems = useMemo(
    () => leaf.items.filter((item) => isVisibleItem(item)),
    [leaf.items, isVisibleItem],
  )
  const dragging = useLayoutDrag((state) => state.dragging)
  const [hint, setHint] = useState<DropHint | null>(null)
  const rootRef = useRef<HTMLElement | null>(null)

  /**
   * 窄格降级：小于阈值时把内容收起、只留标签条。
   *
   * 为什么需要：像素下限（`MIN_LEAF_PIXELS`）只拦得住**新的**拖动；已落盘的旧窄叶、
   * 以及窗口被缩到比两个下限还小时，格子照样会窄成废条 —— 那种形态下正文逐字竖排，
   * 既不可读也把分隔条藏进垃圾里。收起内容之后标签条仍在：标签可点、可拖走，
   * 这就是窄格的自救出口（搭配命令面板的「重置布局」兜底）。
   */
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const element = rootRef.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect === undefined) return
      const isNarrow = rect.width < NARROW_LEAF_PIXELS || rect.height < NARROW_LEAF_PIXELS
      setNarrow((prev) => (prev === isNarrow ? prev : isNarrow))
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [])

  /** 这一格是不是**右上叶**：三个窗口按钮与"空态标签条"都挂在它身上（ADR-0038）。 */
  const hostsWindowControls = leaf.id === ctx.windowControlsLeafId

  /** 有标签但全被隐藏 ⇒ 整格收缩（空叶永远渲染，见文件头）。 */
  const collapsed = leaf.items.length > 0 && visibleItems.length === 0

  const handleDragOver = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      if (useLayoutDrag.getState().dragging === null) return
      if (useLayoutDrag.getState().fromTree && (event.target as Element).closest('.mn-tree')) return
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'move'
      const target = event.target
      if (!(target instanceof HTMLElement)) return

      // 落在标签条上：插到第几位（按各标签中线算）
      const strip = target.closest('[data-leaf-tabs]')
      if (strip !== null) {
        const centers = Array.from(strip.querySelectorAll<HTMLElement>('.mn-tabs__tab')).map(
          (node) => {
            const rect = node.getBoundingClientRect()
            return rect.left + rect.width / 2
          },
        )
        const next: DropHint = { kind: 'tab', index: tabIndexAt(centers, event.clientX) }
        setHint((prev) => (hintEqual(prev, next) ? prev : next))
        return
      }

      // 落在内容区：中央并入 / 四边带切一刀
      const content = rootRef.current?.querySelector('.mn-leaf__content')
      if (content == null) return
      const drop = contentDropAt(content.getBoundingClientRect(), event.clientX, event.clientY)
      const next: DropHint =
        drop.kind === 'merge' ? { kind: 'merge' } : { kind: 'split', edge: drop.edge }
      setHint((prev) => (hintEqual(prev, next) ? prev : next))
    },
    [],
  )

  const handleDragLeave = useCallback((event: ReactDragEvent<HTMLElement>) => {
    // 只有真的离开这一格才清提示（进入子元素也会触发 dragleave）
    const next = event.relatedTarget
    if (next instanceof Node && event.currentTarget.contains(next)) return
    setHint(null)
  }, [])

  const handleDrop = useCallback(
    async (event: ReactDragEvent<HTMLElement>) => {
      const item = useLayoutDrag.getState().dragging
      if (item === null) return
      if (useLayoutDrag.getState().fromTree && (event.target as Element).closest('.mn-tree')) return
      event.preventDefault()
      event.stopPropagation()
      const current = hint
      const fromTree = useLayoutDrag.getState().fromTree
      useLayoutDrag.getState().end()
      setHint(null)
      if (fromTree) {
        const path = notePathOf(item)
        if (path === null || current === null) return
        if (isMarkdown(path)) {
          if (!(await openNoteInNewTab(path))) return
        } else {
          const tabs = useTabsStore.getState()
          useTabsStore.setState({ tabs: tabs.tabs.includes(path) ? tabs.tabs : [...tabs.tabs, path], active: path })
        }
      }
      const ui = useUiStore.getState()

      if (current !== null && current.kind === 'tab') {
        // 条内重排 / 从别的格子插到第几位。下标语义 = "移除自己之后"的数组下标
        const from = leaf.items.indexOf(item)
        let index = current.index
        if (from >= 0 && index > from) index -= 1
        if (from < 0 || index !== from) {
          ui.setLayout(moveItem(ui.layout, item, { leafId: leaf.id, index }))
        }
      } else if (current !== null && current.kind === 'merge') {
        ui.setLayout(moveItem(ui.layout, item, { leafId: leaf.id }))
      } else if (current !== null) {
        // 切一刀。拖到自己独占格子的边缘 = 无操作（ADR-0035：这条由拖拽层拦下）
        const source = leafOfItem(ui.layout, item)
        const soloHere = source !== null && source.id === leaf.id && source.items.length === 1
        if (!soloHere) {
          // 模块被切出去独占一格时，新刀调成它的家尺寸比例（而不是 0.5）——
          // 量的是被切这一格此刻的像素
          const rect = rootRef.current
            ?.querySelector('.mn-leaf__content')
            ?.getBoundingClientRect()
          const extent =
            current.edge === 'left' || current.edge === 'right'
              ? (rect?.width ?? 0)
              : (rect?.height ?? 0)
          let next = moveItem(ui.layout, item, { leafId: leaf.id, edge: current.edge })
          next = adjustNewSplitRatio({ layout: next, item, edge: current.edge, extentPx: extent })
          ui.setLayout(next)
        }
      }

      useLayoutDrag.getState().end()
      setHint(null)
    },
    [hint, leaf],
  )

  if (collapsed) return null

  const shown =
    leaf.active !== null && visibleItems.includes(leaf.active)
      ? leaf.active
      : (visibleItems[0] ?? null)

  // 左右折叠都只挂在内容叶：左在标签左侧、右在滚动区右侧（收起后原地变「展开」）。
  const isContentLeaf = leaf.id === ctx.contentLeafId
  const leftSide = isContentLeaf ? ctx.leftSide : null
  const rightSide = isContentLeaf ? ctx.rightSide : null
  const showTabs =
    visibleItems.length > 0 ||
    hostsWindowControls ||
    leftSide !== null ||
    rightSide !== null

  return (
    <section
      className={`mn-leaf${shown !== null && isViewModule(shown) ? ' mn-leaf--module' : ''}${narrow ? ' mn-leaf--narrow' : ''}`}
      data-leaf-id={leaf.id}
      data-narrow={narrow ? '' : undefined}
      ref={rootRef}
      onDragOverCapture={handleDragOver}
      onDragLeave={handleDragLeave}
      onDropCapture={handleDrop}
    >
      {/*
        右上叶**即使没有标签也渲染标签条**：三个窗口按钮住在它的右端（ADR-0038），
        空态下不能让它们消失；顺带它也是整窗唯一保证存在的拖动区。
        内容叶在只有折叠按钮、尚无笔记标签时也要有条。
      */}
      {showTabs && (
        <LeafTabs
          leaf={leaf}
          items={visibleItems}
          dropIndex={dragging !== null && hint?.kind === 'tab' ? hint.index : null}
          windowControls={hostsWindowControls}
          leftSide={leftSide}
          rightSide={rightSide}
        />
      )}
      <div className="mn-leaf__content">
        <LeafContent shown={shown} ctx={ctx} />
        {/* 落点高亮：并入 = 盖满内容区；切一刀 = 盖住那一半（都不抢指针事件） */}
        {dragging !== null && hint !== null && hint.kind !== 'tab' && (
          <div
            className={
              hint.kind === 'merge'
                ? 'mn-leaf__drop mn-leaf__drop--merge'
                : `mn-leaf__drop mn-leaf__drop--${hint.edge}`
            }
            data-drop-hint={hint.kind === 'merge' ? 'merge' : hint.edge}
          />
        )}
      </div>
    </section>
  )
}

/** 叶子内容的分派（规则见文件头，就这一套）。 */
function LeafContent({ shown, ctx }: { shown: LayoutItemId | null; ctx: RenderContext }) {
  const viewMode = useUiStore((state) => state.viewMode)
  const openedFile = useUiStore((state) => state.openedFile)
  if (shown !== null && isViewModule(shown)) return <ModuleContent id={shown} />

  const note = shown === null ? null : notePathOf(shown)
  if (note !== null && !isMarkdown(note)) return <section className="mn-pane mn-pane--file"><FileViewer relPath={note} /></section>
  if (note !== null) {
    const isCurrent = note === ctx.currentDoc
    /*
      ⚠️ **附件查看器（`openedFile`，ADR-0032）优先**：当前文档那一格在"文件树里点一张图片/
      一个 `.txt`"之后必须换成查看器。这正是 UI E2E 抓到的回归
      （"先打开一篇笔记、再点附件"，见 `e2e/ui.e2e.test.ts`）。
    */
    if (isCurrent && openedFile !== null) {
      return (
        <section className="mn-pane mn-pane--file">
          <FileViewer relPath={openedFile} />
        </section>
      )
    }
    /*
      编辑视图：**当前与非当前走同一个元素形状**（`<section class="mn-pane mn-pane--editor">`
      里放 `<MarkdownEditor>`），只是"点击是否把它变成当前"不同。

      为什么必须同形：React 按位置 + 类型复用子树。从前当前文档那一格渲染的是
      `<MainViews/>`、非当前那格是内联的 `<section>` —— 于是**点一下非当前那格把它变成当前**
      会让 React 把整棵子树卸载重建：CodeMirror 实例没了（光标、滚动、撤销历史一起丢），
      属性面板的展开态也回到默认。同形之后这一步只是换个 prop，实例原地保留。
    */
    if (viewMode === 'edit') {
      return (
        <section
          className="mn-pane mn-pane--editor"
          onPointerDownCapture={
            isCurrent ? undefined : () => { void useTabsStore.getState().activate(note) }
          }
        >
          <MarkdownEditor notePath={note} />
        </section>
      )
    }
    // 阅读/图谱视图：当前文档渲染真视图，别的格子渲染只读预览（与图谱浮窗同一条渲染链路）
    if (isCurrent) {
      return viewMode === 'read' ? (
        <section className="mn-pane">
          <MarkdownPreview />
        </section>
      ) : (
        <section className="mn-pane mn-pane--graph">
          <GraphCanvas />
        </section>
      )
    }
    return <StaticNotePreview relPath={note} className="mn-leaf__preview" />
  }
  // 空叶（`shown === null` 时这只可能是主叶 —— 不变式 2 保证空叶是整树最后一格）
  return <MainViews />
}

/**
 * 空叶的主视图：当前文档的三种形态（编辑 / 阅读 / 图谱）或附件查看器（ADR-0032）。
 *
 * 从前它也负责"当前文档所在的格子"，但那条路已经收进 {@link LeafContent} 的笔记分支
 * （理由见那里的注释：两条分支的元素形状必须一致，否则激活一格就会重建编辑器）。
 * 现在它只剩一个用途：**空的主叶** —— 那时没有 `notePath` 可传，编辑器也还没有文档。
 */
function MainViews() {
  const viewMode = useUiStore((state) => state.viewMode)
  const openedFile = useUiStore((state) => state.openedFile)
  /**
   * 当前文档路径**显式**传给编辑器。
   *
   * 从前这里是 `<MarkdownEditor />`（"当前文档"由组件内部读 store 猜）。分栏之后每格一个
   * 编辑器实例、各有自己的文档，靠"内部读当前文档"来绑定就会让两格抢同一篇 ——
   * 显式传路径是这一层唯一的正确做法（`notePath` 缺失时的兜底仍然保留）。
   */
  const currentDoc = useNoteStore((state) => state.doc?.relPath ?? null)

  if (openedFile !== null) {
    return (
      <section className="mn-pane mn-pane--file">
        <FileViewer relPath={openedFile} />
      </section>
    )
  }
  if (viewMode === 'edit') {
    return (
      <section className="mn-pane mn-pane--editor">
        <MarkdownEditor notePath={currentDoc ?? undefined} />
      </section>
    )
  }
  if (viewMode === 'read') {
    return (
      <section className="mn-pane">
        <MarkdownPreview />
      </section>
    )
  }
  return (
    <section className="mn-pane mn-pane--graph">
      <GraphCanvas />
    </section>
  )
}

/** 模块的内容。四种模块各自是一个自洽的面板（这里只负责摆进去）。 */
function ModuleContent({ id }: { id: ViewModuleId }) {
  switch (id) {
    case 'tree':
      return (
        <>
          <TreeToolbar />
          <FileTree />
          {/*
            底部一行：左边「最近打开的 Vault」（ADR-0027 定的左下角），右下角是**设置按钮**。
            从前这里是一个汉堡菜单（全部命令的弹出列表），但命令面板（`Ctrl+K`）已经是
            更好的发现入口 —— 菜单只是它的弱化复刻，还多占一次点击。改成直达设置的按钮。
          */}
          <div className="mn-tree-bottom">
            <RecentVaults />
            <Tooltip label="设置（Ctrl+,）">
              <button
                type="button"
                className="mn-icon-button"
                aria-label="设置"
                onClick={() => useSettingsStore.getState().openSettings()}
              >
                <Icon name="settings" size="md" />
              </button>
            </Tooltip>
          </div>
        </>
      )
    case 'links':
      return <LinksPanel />
    case 'tags':
      return <TagsPanel />
    case 'outline':
      return <OutlinePanel />
  }
}
