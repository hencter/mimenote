/**
 * 图谱的**数据装载与定位**（hook）。
 *
 * 一句话职责：按当前视图拉数据（全库 `graph_data` / 自我中心子图）、订阅"该刷新了"的两条信号，
 * 以及"在几千张卡片里按名字直达"的索引与镜头搬运。
 *
 * ## 加载的两条路（与 store 的分工，别在这里重新发明）
 *
 * 本 hook 只负责**发请求**：焦点视图调 `loadEgo(focusRoot, { keepView: true })`，
 * 全库视图调 `load(rootPath, { indexBuilding, keepView })`。"保留视角的刷新 vs 完整重载"
 * 的判据在 store 的 `load` / `loadEgo` 里（见 `state/graph-data.ts` 文件头）——
 * 这里**不许**自己判断该不该保留视角，否则就会长出第二份判据。
 *
 * 自动刷新用 `startGraphAutoRefresh()` 的**挂载式订阅**（卸载即取消）：模块级监听一旦注册
 * 就永不清理（热更新、测试里会越挂越多），而且拿不到"当前是否还有画布在显示"这个上下文。
 *
 * ## 定位（`locateCard`）
 *
 * 折叠容器里的卡片不在布局里，所以先**展开它的祖先文件夹**再重试一次（展开是异步的，
 * 目标记进 `pendingLocateRef`，由布局更新后的 effect 补做）。焦点视图没有折叠，
 * 找不到就是真的不在子图里 —— 那时如实不动作（提示由"深度"那一栏负责）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { GraphData } from '@/ipc/types'
import type { GraphCardBox, Rect } from '@/domain/graph/layout'
import type { EgoCardBox } from '@/domain/graph/layout-ego'
import type { GraphNode } from '@/ipc/types'
import { startGraphAutoRefresh, useGraphStore, type EgoSnapshot, type GraphMode } from '@/state/graph-store'
import { useLinksStore } from '@/state/links-store'

import { ancestorFolders, buildGraphFindIndex, findGraphMatches } from './find'
import type { EgoGeometry } from './use-force-sim'

export function useGraphData(input: {
  rootPath: string | null
  mode: GraphMode
  /** 焦点视图的圆心：当前打开的笔记。 */
  focusRoot: string | null
  depth: number
  ego: EgoSnapshot | null
  data: GraphData | null
  egoLayout: EgoGeometry | null
  cardsById: ReadonlyMap<string, GraphCardBox>
}) {
  const { rootPath, mode, focusRoot, depth, ego, data, egoLayout, cardsById } = input

  // -------------------------------------------------------------------------
  // 数据加载
  //   · 焦点视图：以当前笔记为圆心拉子图（含每篇正文）
  //   · 全库视图：原来的 `graph_data`
  //   · 保存成功 / 索引就绪 → 由 store 的自动刷新订阅补齐（见 startGraphAutoRefresh）
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (rootPath === null) {
      useGraphStore.getState().clear()
      return
    }
    if (mode === 'focus') {
      // `keepView` 由 store 判断（同一个圆心 + 同一个跳数才谈得上"保留视角"）
      void useGraphStore.getState().loadEgo(focusRoot, { keepView: true })
      return
    }
    const state = useGraphStore.getState()
    void state.load(rootPath, {
      indexBuilding: useLinksStore.getState().status.phase === 'building',
      keepView: state.rootPath === rootPath && state.data !== null,
    })
  }, [rootPath, mode, focusRoot, depth])

  // 保存成功 / 索引就绪后的自动刷新。装在这里、卸载即取消：
  // 模块级监听会永不清理，而"画布是否可见"这个上下文只有组件知道。
  useEffect(() => startGraphAutoRefresh(), [])

  // -------------------------------------------------------------------------
  // "定位笔记"：几千张卡片里按名字直达（见 find.ts 的说明）
  // -------------------------------------------------------------------------

  const [findQuery, setFindQuery] = useState('')
  /** 待定位的笔记：卡片可能还在折叠的容器里，展开后要等布局重算才能找到它。 */
  const pendingLocateRef = useRef<string | null>(null)

  const nodesByPath = useMemo(() => {
    const map = new Map<string, GraphNode>()
    for (const node of data?.nodes ?? []) map.set(node.relPath, node)
    for (const node of ego?.data.nodes ?? []) map.set(node.relPath, node)
    return map
  }, [data, ego])

  const findIndex = useMemo(
    () => buildGraphFindIndex(mode === 'focus' ? (ego?.data.nodes ?? []) : (data?.nodes ?? [])),
    [mode, ego, data],
  )
  const findMatches = useMemo(
    () => (findQuery.trim() === '' ? [] : findGraphMatches(findIndex, findQuery, nodesByPath)),
    [findIndex, findQuery, nodesByPath],
  )

  /** 焦点视图里所有卡片（含视口外的）：定位与键盘导航都要用它，不能只看可见的那一批。 */
  const focusCardByPath = useMemo(() => {
    const map = new Map<string, EgoCardBox>()
    for (const card of egoLayout?.layout.cards ?? []) map.set(card.relPath, card)
    return map
  }, [egoLayout])

  /**
   * 把某张卡片摆到视口中央并选中它。
   *
   * 找不到时先**展开它的祖先文件夹**再重试一次（折叠容器里的卡片不在布局里，
   * 直接报"找不到"会让用户以为图谱缺了这篇笔记）；展开是异步的（要等 layout 重算），
   * 因此把目标记进 `pendingLocateRef`，由下面的 effect 在布局更新后补做。
   * 焦点视图没有折叠，找不到就是真的不在子图里 —— 提示"调大跳数"比默默无反应好。
   */
  const locateCard = useCallback(
    (relPath: string): void => {
      // 两种视图的卡片类型不同，但"中心点在哪"这件事一样：先各自取出矩形
      const rect: Rect | undefined = focusCardByPath.get(relPath)?.rect ?? cardsById.get(relPath)
      if (rect === undefined) {
        // 焦点视图没有折叠：找不到就是不在当前深度里（提示由"深度"那一栏负责）
        if (mode !== 'vault') return
        const ancestors = ancestorFolders(relPath)
        const collapsedNow = useGraphStore.getState().collapsed
        const next = [...collapsedNow].filter((path) => !ancestors.includes(path))
        if (next.length !== collapsedNow.size) {
          pendingLocateRef.current = relPath
          useGraphStore.getState().setCollapsed(next)
        }
        return
      }
      const state = useGraphStore.getState()
      const zoom = state.view.zoom
      state.setView({
        zoom,
        x: state.viewport.width / 2 - (rect.x + rect.width / 2) * zoom,
        y: state.viewport.height / 2 - (rect.y + rect.height / 2) * zoom,
      })
      state.select(relPath)
    },
    [mode, focusCardByPath, cardsById],
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

  return { findQuery, setFindQuery, findMatches, locateCard, submitFind, nodesByPath }
}
