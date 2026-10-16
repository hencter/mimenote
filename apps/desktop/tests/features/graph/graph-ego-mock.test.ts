// @vitest-environment jsdom
/**
 * Mock 适配器里的 `graph_ego`（浏览器预览与 UI 测试都走它）。
 *
 * 为什么值得单独钉一遍：真正的自我中心子图在宿主里（Rust 索引，纯内存 BFS + 截断），
 * Mock 是它在浏览器里的镜像。两边口径一旦分开，就会出现"浏览器里演示得好好的、
 * 真机上邻居少了一半"这类只有用户能发现的问题。所以这里断言的是**规则**：
 * 双向（出链与反链都算一跳）、起点恒在、跳数归一化到 1..5、截断后仍然连通、
 * 悬空边只在中心那一侧。
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { ipc, setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import type { GraphData } from '@/ipc/types'

const VAULT_ROOT = 'C:\\Mock\\Vault'

/** 直接相关的一圈：中心 ↔ 甲（出链）、中心 ← 丙（反链）；甲 → 甲二 是第二跳；孤岛无关。 */
const NOTES = [
  { relPath: '中心.md', text: '[[甲]] 与 [[乙]]\n\n[[不存在的笔记]]\n' },
  { relPath: '甲.md', text: '[[甲二]]\n' },
  { relPath: '甲二.md', text: '正文\n' },
  { relPath: '乙.md', text: '正文\n' },
  { relPath: '丙.md', text: '[[中心]]\n' },
  { relPath: '丁.md', text: '[[也不存在]]\n' },
  { relPath: '孤岛.md', text: '没有任何链接\n' },
]

function noteText(relPath: string): string {
  const note = NOTES.find((entry) => entry.relPath === relPath)
  if (note === undefined) throw new Error(`夹具里没有 ${relPath}`)
  return note.text
}

async function ego(relPath: string, depth?: number, maxNodes?: number): Promise<GraphData> {
  return ipc.graphEgo(relPath, depth ?? 1, maxNodes)
}

function paths(data: GraphData): string[] {
  return data.nodes.map((node) => node.relPath).sort()
}

/**
 * 期望值也走**同一套排序**（`Array#sort` 的 UTF-16 码元序）。
 *
 * 为什么不手写期望数组的顺序：`中心`(U+4E2D) 其实排在 `丙`(U+4E19) **之后**，
 * 手写顺序会变成在测"中文码位"，而不是测"子图里有哪些节点"。
 */
function sorted(...names: string[]): string[] {
  return [...names].sort()
}

beforeEach(() => {
  window.localStorage.clear()
  setIpcAdapter(createMockAdapter({ rootPath: VAULT_ROOT, notes: NOTES }))
})

describe('Mock 的 graph_ego', () => {
  it('1 跳：出链与**反链**都算一跳，第二跳与无关节点都不进来', async () => {
    const data = await ego('中心.md')

    expect(paths(data)).toEqual(sorted('中心.md', '甲.md', '乙.md', '丙.md'))
    expect(data.truncated).toBe(false)
    // 度数保持**全库**口径（丙 有 1 条出链，中心 有 3 条出链 1 条入链）
    expect(data.nodes.find((node) => node.relPath === '中心.md')?.outDegree).toBe(3)
    expect(data.nodes.find((node) => node.relPath === '中心.md')?.inDegree).toBe(1)
  })

  it('2 跳：把甲二带进来，但孤岛仍然不在（它谁也不连）', async () => {
    const data = await ego('中心.md', 2)

    expect(paths(data)).toEqual(sorted('中心.md', '甲.md', '甲二.md', '乙.md', '丙.md'))
    expect(paths(data)).not.toContain('孤岛.md')
    // 截断后子图必须仍然连通：每个非起点节点都能顺着边回到起点
    const reachable = new Set(['中心.md'])
    const edges = data.edges.filter((edge) => edge.toRelPath !== null)
    for (let round = 0; round < 3; round += 1) {
      for (const edge of edges) {
        const to = edge.toRelPath
        if (to === null) continue
        if (reachable.has(edge.fromRelPath)) reachable.add(to)
        if (reachable.has(to)) reachable.add(edge.fromRelPath)
      }
    }
    for (const relPath of paths(data)) expect(reachable.has(relPath)).toBe(true)
  })

  it('悬空边只在中心那一侧：别人的悬空链接不属于这张子图', async () => {
    const data = await ego('中心.md', 5)
    const dangling = data.edges
      .filter((edge) => edge.toRelPath === null)
      .map((edge) => `${edge.fromRelPath} → ${edge.toRawTarget}`)

    expect(dangling).toContain('中心.md → 不存在的笔记')
    // 丁 的悬空链接与中心无关（而且丁 根本不该进这张图）
    expect(dangling.some((entry) => entry.startsWith('丁.md'))).toBe(false)
  })

  it('跳数被归一化到 1..5：0 当 1，99 当 5，非数字当 1', async () => {
    const oneHop = sorted('中心.md', '甲.md', '乙.md', '丙.md')
    expect(paths(await ego('中心.md', 0))).toEqual(oneHop)
    expect(paths(await ego('中心.md', 99))).toContain('甲二.md')
    expect(paths(await ego('中心.md', Number.NaN))).toEqual(oneHop)
  })

  it('截断：起点恒在，且报 `truncated`', async () => {
    const data = await ego('中心.md', 2, 1)

    expect(paths(data)).toEqual(['中心.md'])
    expect(data.truncated).toBe(true)
  })

  it('起点不在索引里：空结果，**不报错**（笔记刚被删、或还没保存）', async () => {
    const data = await ego('不存在的笔记.md')

    expect(data.nodes).toEqual([])
    expect(data.edges).toEqual([])
    expect(data.truncated).toBe(false)
  })

  it('同一对节点的多条链接合并成一条带 `count` 的边（与 `graph_data` 同一份投影）', async () => {
    setIpcAdapter(
      createMockAdapter({
        rootPath: VAULT_ROOT,
        notes: [
          { relPath: '中心.md', text: '[[甲]]\n[[甲]]\n' },
          { relPath: '甲.md', text: '正文\n' },
        ],
      }),
    )
    const data = await ego('中心.md')

    const forward = data.edges.filter((edge) => edge.fromRelPath === '中心.md')
    expect(forward).toHaveLength(1)
    expect(forward[0]?.count).toBe(2)
  })

  it('夹具自检：`noteText` 只服务上面的读数，别让夹具悄悄漂走', () => {
    expect(noteText('中心.md')).toContain('[[甲]]')
  })
})
