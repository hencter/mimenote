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
 * 面板可见性仍归各自的开关（`Ctrl+B` 等）。叶子里**有标签但全被隐藏**时整格收缩
 * （split 的另一边吃满、分隔条不画），树里什么都不变 ⇒ 再打开就回原位。
 * **空叶永远渲染**（它是占位空态，不是被隐藏的面板）—— 判据是 `tree-layout.ts` 的
 * `subtreeRenderable`（就一份，别在组件里再写）。
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

import { AppMenu } from '@/components/AppMenu'
import { Splitter } from '@/components/Splitter'
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
import { installTabsSync, setCaretMemory } from '@/state/tabs-store'
import { useUiStore } from '@/state/ui-store'

import { contentDropAt, tabIndexAt, type DropEdge } from './drop-target'
import { useLayoutDrag } from './layout-drag'
import { LeafTabs } from './LeafTabs'
import { useModuleVisibility } from './module-visibility'
import { adjustNewSplitRatio } from './split-size'
import {
  DEFAULT_MAIN_LEAF_ID,
  evenSplit,
  findLeaf,
  isViewModule,
  leafOfItem,
  leaves,
  moveItem,
  noteItem,
  notePathOf,
  setActive,
  setRatio,
  subtreeRenderable,
  type LayoutItemId,
  type LeafNode,
  type SplitNode,
  type TreeLayout,
  type ViewModuleId,
} from './tree-layout'

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
  /** 主叶 id：当前文档所在的格子；没有当前文档时是 `main`（再没有就第一个叶子）。 */
  primaryLeafId: string | null
  /** 当前文档的相对路径（`null` = 没有打开）。 */
  currentDoc: string | null
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

  const primaryLeafId = useMemo(() => {
    if (currentDoc !== null) {
      const leaf = leafOfItem(layout, noteItem(currentDoc))
      if (leaf !== null) return leaf.id
    }
    return (findLeaf(layout, DEFAULT_MAIN_LEAF_ID) ?? leaves(layout)[0])?.id ?? null
  }, [layout, currentDoc])

  const ctx: RenderContext = { isVisibleItem, primaryLeafId, currentDoc }

  return (
    <div className="mn-tree-host">
      {/*
        整棵树都不可渲染（所有格子都只剩被隐藏的模块 —— 例如四块面板全关且没开笔记）时，
        也不能让主区空白：退回一格"主视图空态"（与旧布局"主区域永远在"同一底线）。
      */}
      {subtreeRenderable(layout, isVisibleItem) ? (
        <NodeView node={layout} ctx={ctx} />
      ) : (
        <div className="mn-leaf" data-leaf-id="fallback">
          <div className="mn-leaf__content">
            <MainViews />
          </div>
        </div>
      )}
    </div>
  )
}

/** 递归渲染一个节点。 */
function NodeView({ node, ctx }: { node: TreeLayout; ctx: RenderContext }) {
  if (node.kind === 'leaf') return <LeafPane leaf={node} ctx={ctx} />

  const aOk = subtreeRenderable(node.a, ctx.isVisibleItem)
  const bOk = subtreeRenderable(node.b, ctx.isVisibleItem)
  if (!aOk && !bOk) return null
  // 一边整棵收缩：另一边吃满、分隔条不画（树里什么都没变，见文件头「隐藏 ≠ 移除」）
  if (!aOk) return <NodeView node={node.b} ctx={ctx} />
  if (!bOk) return <NodeView node={node.a} ctx={ctx} />
  return <SplitView node={node} ctx={ctx} />
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
          const ui = useUiStore.getState()
          ui.setLayout(setRatio(ui.layout, node.id, ratio))
        }}
        onNudge={(delta) => {
          const el = ref.current
          if (el === null) return
          const rect = el.getBoundingClientRect()
          const size = node.axis === 'row' ? rect.width : rect.height
          if (size <= 0) return
          const ui = useUiStore.getState()
          ui.setLayout(setRatio(ui.layout, node.id, node.ratio + delta / size))
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

  /** 有标签但全被隐藏 ⇒ 整格收缩（空叶永远渲染，见文件头）。 */
  const collapsed = leaf.items.length > 0 && visibleItems.length === 0

  const handleDragOver = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      if (useLayoutDrag.getState().dragging === null) return
      event.preventDefault()
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
    (event: ReactDragEvent<HTMLElement>) => {
      const item = useLayoutDrag.getState().dragging
      if (item === null) return
      event.preventDefault()
      const ui = useUiStore.getState()
      const current = hint

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
        const soloHere = source !== null && source.id === leaf.id && leaf.items.length === 1
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

  return (
    <section
      className={`mn-leaf${shown !== null && isViewModule(shown) ? ' mn-leaf--module' : ''}`}
      data-leaf-id={leaf.id}
      ref={rootRef}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {visibleItems.length > 0 && (
        <LeafTabs
          leaf={leaf}
          items={visibleItems}
          dropIndex={dragging !== null && hint?.kind === 'tab' ? hint.index : null}
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
  if (shown !== null && isViewModule(shown)) return <ModuleContent id={shown} />

  const note = shown === null ? null : notePathOf(shown)
  if (note !== null && note !== ctx.currentDoc) {
    // 非当前文档：只读预览（单文档模型：编辑器全局只有一份，点它的标签把它变成当前）
    return <StaticNotePreview relPath={note} className="mn-leaf__preview" />
  }
  // 当前文档、或空叶（`shown === null` 时这只可能是主叶 —— 不变式 2 保证空叶是整树最后一格，
  // 而主叶落空时 `primaryLeafId` 就指它）：主视图/查看器都渲染在这里
  return <MainViews />
}

/**
 * 主视图：当前文档的三种形态（编辑 / 阅读 / 图谱）或附件查看器（ADR-0032）。
 *
 * 从旧 `App.tsx` 的 `.mn-main` 里原样搬来 —— 区别只是它现在渲染在"当前文档所在的格子"
 * 里，而不是一个固定的主区域。
 */
function MainViews() {
  const viewMode = useUiStore((state) => state.viewMode)
  const openedFile = useUiStore((state) => state.openedFile)

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
        <MarkdownEditor />
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
            底部一行：左边「最近打开的 Vault」（ADR-0027 定的左下角），右下角是**应用菜单**。
            从旧停靠区原样搬来 —— 菜单是"这个库/这个应用能做什么"的入口，
            与文件导航是同一个上下文。
          */}
          <div className="mn-tree-bottom">
            <RecentVaults />
            <AppMenu />
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
