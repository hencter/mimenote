// @vitest-environment jsdom
/**
 * 图谱里的「定位笔记」（`features/graph/find.ts` + 画布 HUD 上的输入框）。
 *
 * 为什么单测这一层：几千张卡片时"按名字直达某一张"是画布可用性的关键一步，而它最容易错的
 * 两处都不是"看起来对不对"能发现的 —— ① 卡片在**折叠的容器**里时第一步找不到，必须先展开
 * 祖先再补做定位；② 居中用的视口偏移（屏幕 = 世界 × 缩放 + 偏移）算错一格，卡片就会落在
 * 视口之外，而画布仍然"看起来正常"，只是没跳过去。第二条用"卡片中心 × 缩放 + 偏移 ==
 * 视口中心"直接算一遍来钉住。
 */

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ancestorFolders,
  buildGraphFindIndex,
  centerViewOnCard,
  findGraphMatches,
} from '@/features/graph/find'
import { GraphCanvas } from '@/features/graph/GraphCanvas'
import { CARD_HEIGHT, CARD_WIDTH, buildLayout } from '@/features/graph/layout'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import type { GraphNode } from '@/ipc/types'
import { useGraphStore } from '@/state/graph-store'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

/** 造一个图谱节点（字段与 `mn_index::graph::GraphNode` 对齐）。 */
function makeNode(relPath: string, folder = ''): GraphNode {
  const name = relPath.slice(relPath.lastIndexOf('/') + 1)
  return {
    relPath,
    title: name.replace(/\.(md|markdown)$/i, ''),
    folder,
    tags: [],
    outDegree: 0,
    inDegree: 0,
  }
}

const NODES: GraphNode[] = [
  makeNode('README.md'),
  makeNode('项目/设计文档.md', '项目'),
  makeNode('项目/路线图.md', '项目'),
  makeNode('项目/子项目/细节.md', '项目/子项目'),
  makeNode('日记/2025-01-01.md', '日记'),
]

function resetStores(): void {
  useNoteStore.getState().close()
  useLinksStore.getState().clear()
  useUiStore.setState({ viewMode: 'graph' })
  useGraphStore.setState({
    status: 'ready',
    data: { nodes: NODES, edges: [], truncated: false, elapsedMs: 0 },
    error: null,
    selected: null,
    collapsed: new Set<string>(),
    manual: new Map(),
    viewport: { width: 1000, height: 600, known: true },
    staleIndex: false,
    refreshNotice: null,
    refreshing: false,
    rootPath: 'C:\\MockVault',
  })
  useVaultStore.setState({
    status: 'ready',
    info: {
      rootPath: 'C:\\MockVault',
      name: 'MockVault',
      noteCount: NODES.length,
      entryCount: NODES.length,
      folderCount: 3,
      scanMs: 3,
      truncated: false,
      skipped: 0,
    },
    entries: [],
    tree: [],
    selected: null,
  })
}

beforeEach(() => {
  setIpcAdapter(createMockAdapter())
  window.localStorage.clear()
  resetStores()
})

afterEach(() => {
  cleanup()
})

describe('定位候选（纯函数）', () => {
  it('按子序列匹配路径，文件名命中优先', () => {
    const index = buildGraphFindIndex(NODES)
    const matches = findGraphMatches(index, '设计', new Map(NODES.map((n) => [n.relPath, n])))

    expect(matches[0]?.relPath).toBe('项目/设计文档.md')
    expect(matches[0]?.title).toBe('设计文档')
    expect(matches[0]?.folder).toBe('项目')
  })

  it('跳字也能命中；没有匹配时返回空数组', () => {
    const index = buildGraphFindIndex(NODES)
    const byPath = new Map(NODES.map((n) => [n.relPath, n]))

    expect(findGraphMatches(index, '细节', byPath).map((m) => m.relPath)).toEqual([
      '项目/子项目/细节.md',
    ])
    expect(findGraphMatches(index, 'zzz-不存在', byPath)).toEqual([])
  })

  it('祖先文件夹按从外到内列出（定位前要展开它们）', () => {
    expect(ancestorFolders('项目/子项目/细节.md')).toEqual(['项目', '项目/子项目'])
    expect(ancestorFolders('README.md')).toEqual([])
  })

  it('居中偏移按"屏幕 = 世界 × 缩放 + 偏移"算，缩放不变', () => {
    const card = { x: 100, y: 50, width: CARD_WIDTH, height: CARD_HEIGHT }
    const viewport = { width: 1000, height: 600 }

    // 卡片中心 (195, 92) → 屏幕中心 (500, 300)，缩放 1 ⇒ 偏移 (305, 208)
    expect(centerViewOnCard(card, viewport, 1)).toEqual({ x: 305, y: 208 })
    // 缩放 2 时卡片被放大，偏移要把它推回来：500 - 195*2 = 110、300 - 92*2 = 116
    expect(centerViewOnCard(card, viewport, 2)).toEqual({ x: 110, y: 116 })
  })
})

describe('画布上的定位输入框', () => {
  /**
   * 焦点视图（默认）的圆心是"当前打开的笔记"，这里没有打开任何笔记 ⇒ 画布是空态。
   * 定位/折叠这两件事属于**整个 Vault** 视图（ADR-0021），所以这几条用例先切过去。
   */
  function renderVaultView(): HTMLElement {
    useGraphStore.setState({ mode: 'vault' })
    const { container } = render(<GraphCanvas />)
    return container
  }

  /** 画布交给画笔的卡片数（卡片本身画在 canvas 上，DOM 里没有节点可数）。 */
  function paintedCards(): number {
    return Number(document.querySelector('canvas.mn-graph__canvas')?.getAttribute('data-mn-cards') ?? '0')
  }

  /**
   * 当前**真实**布局里有哪几张卡片。
   *
   * 为什么不能拿测试自己的 `NODES` 去算：画布挂载时会按 `rootPath` 拉一次数据
   * （`load()`），Mock 适配器返回的是它自己那套 Vault —— 于是进入画布之后数据是**它**的，
   * 不是这里的 NODES。断言必须对着画布真正在画的那份布局做，否则量的是另一个世界。
   */
  function layoutNow(): { paths: string[]; card: (relPath: string) => { x: number; y: number; width: number; height: number } | undefined } {
    const state = useGraphStore.getState()
    const cards = buildLayout(state.data?.nodes ?? [], state.collapsed).cards
    return {
      paths: cards.map((card) => card.relPath),
      card: (relPath) => cards.find((candidate) => candidate.relPath === relPath),
    }
  }

  it('输入后列出候选，点一条把卡片选中并把它摆到视口中央', async () => {
    renderVaultView()
    await waitFor(() => {
      expect(paintedCards()).toBeGreaterThan(0)
    })

    const input = document.querySelector<HTMLInputElement>('.mn-graph__find-input')
    expect(input).not.toBeNull()

    await act(async () => {
      fireEvent.change(input as HTMLInputElement, { target: { value: '细节' } })
    })
    const option = await waitFor(() => {
      const node = document.querySelector<HTMLElement>('[data-find-path="项目/子项目/细节.md"]')
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    await act(async () => {
      fireEvent.click(option)
    })

    expect(useGraphStore.getState().selected).toBe('项目/子项目/细节.md')
    // 定位完成后清空查询串（否则下一次找别的东西还得先删掉上一次的输入）
    expect(document.querySelector<HTMLInputElement>('.mn-graph__find-input')?.value).toBe('')

    // 卡片中心落在视口中心：屏幕位置 = 世界坐标 × 缩放 + 偏移。
    // 卡片画在 canvas 上，没有 DOM 节点可读坐标 —— 所以直接问**布局**要那张卡片的矩形，
    // 再用与画布同一套换算算一遍（这正是"点得中"的前提）。
    const { view, viewport } = useGraphStore.getState()
    const rect = layoutNow().card('项目/子项目/细节.md')
    expect(rect).toBeDefined()
    const box = rect as { x: number; y: number; width: number; height: number }
    expect(box.x * view.zoom + view.x + (box.width / 2) * view.zoom).toBeCloseTo(
      viewport.width / 2,
      0,
    )
    expect(box.y * view.zoom + view.y + (box.height / 2) * view.zoom).toBeCloseTo(
      viewport.height / 2,
      0,
    )
  })

  it('卡片在折叠的容器里时：先展开祖先，再自动补做定位', async () => {
    useGraphStore.setState({ collapsed: new Set(['项目/子项目']) })
    renderVaultView()
    await waitFor(() => {
      expect(paintedCards()).toBeGreaterThan(0)
    })
    // 折叠状态下那张卡片不在布局里（画布上自然也没有它）
    const folded = layoutNow()
    expect(folded.paths).not.toContain('项目/子项目/细节.md')
    const total = (useGraphStore.getState().data?.nodes ?? []).length
    expect(paintedCards()).toBeLessThan(total)

    const input = document.querySelector<HTMLInputElement>('.mn-graph__find-input')
    await act(async () => {
      fireEvent.change(input as HTMLInputElement, { target: { value: '细节' } })
    })
    await act(async () => {
      fireEvent.keyDown(input as HTMLInputElement, { key: 'Enter' })
    })

    await waitFor(() => {
      expect(useGraphStore.getState().collapsed.has('项目/子项目')).toBe(false)
    })
    // 展开之后那次定位真的补做了（否则用户会以为"图谱里没有这篇笔记"）
    await waitFor(() => {
      expect(useGraphStore.getState().selected).toBe('项目/子项目/细节.md')
    })
    // 展开之后它真的回到画布上（卡片数跟着回来）
    await waitFor(() => {
      expect(layoutNow().paths).toContain('项目/子项目/细节.md')
      expect(paintedCards()).toBe(total)
    })
  })

  it('输入框里按 Esc 只清空查询（画布自己的 Esc 处理不该起来）', async () => {
    renderVaultView()
    await waitFor(() => {
      expect(paintedCards()).toBeGreaterThan(0)
    })

    const input = document.querySelector<HTMLInputElement>('.mn-graph__find-input')
    await act(async () => {
      fireEvent.change(input as HTMLInputElement, { target: { value: '细节' } })
    })
    await act(async () => {
      fireEvent.keyDown(input as HTMLInputElement, { key: 'Escape' })
    })

    expect(document.querySelector<HTMLInputElement>('.mn-graph__find-input')?.value).toBe('')
  })

  it('没有匹配时给出空态说明而不是"按了没反应"', async () => {
    renderVaultView()
    await waitFor(() => {
      expect(paintedCards()).toBeGreaterThan(0)
    })

    const input = document.querySelector<HTMLInputElement>('.mn-graph__find-input')
    await act(async () => {
      fireEvent.change(input as HTMLInputElement, { target: { value: 'zzz-不存在' } })
    })

    await waitFor(() => {
      expect(document.querySelector('.mn-graph__find-empty')?.textContent).toBe('没有匹配的卡片')
    })
  })
})
