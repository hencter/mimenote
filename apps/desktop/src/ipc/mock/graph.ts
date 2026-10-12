/**
 * ipc/mock/graph.ts
 *
 * 图谱（`graph_data` / `graph_ego`）。
 */
import type { MockHost } from './host'



/**
 * `graph_data` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function graphData(host: MockHost, _a: Record<string, unknown>): Promise<unknown> {
  const { graphDataOf } = host
          return graphDataOf()
}

/**
 * `graph_ego` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function graphEgo(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { graphDataOf } = host
          // 自我中心子图（ADR-0021）：双向 BFS + 与宿主**同口径**的截断与排序
          // （`crates/mn-index/src/graph.rs` 的 `select_ego`）。
          //
          // Mock 的价值就在于"浏览器里也能把深度调节、截断提示、环形布局完整走一遍"，
          // 所以归一化（depth 1..5、maxNodes 1..300、缺省 1/80）与排序规则必须照抄，
          // 随便截一刀会让"Mock 好用、真机不好用"这类差异藏到发布前。
          const root = String(a.relPath ?? '')
          const rawDepth = Math.trunc(Number(a.depth ?? 1))
          const rawMax = Math.trunc(Number(a.maxNodes ?? 80))
          const depth = Math.min(5, Math.max(1, Number.isFinite(rawDepth) ? rawDepth : 1))
          const maxNodes = Math.min(300, Math.max(1, Number.isFinite(rawMax) ? rawMax : 80))

          const all = graphDataOf()
          const present = new Set(all.nodes.map((node) => node.relPath))
          // 起点不在索引里（还没保存、刚被删）→ 空结果，**不报错**（与宿主同一个口径）
          if (!present.has(root)) {
            return { nodes: [], edges: [], truncated: false, elapsedMs: 1 }
          }

          const neighbours = new Map<string, Set<string>>()
          const link = (from: string, to: string): void => {
            const forward = neighbours.get(from)
            if (forward === undefined) neighbours.set(from, new Set([to]))
            else forward.add(to)
            // 反向也连：出链与反链都算一跳（用户说的"先关联"就是这个意思）
            const backward = neighbours.get(to)
            if (backward === undefined) neighbours.set(to, new Set([from]))
            else backward.add(from)
          }
          for (const edge of all.edges) {
            if (edge.toRelPath === null) continue
            link(edge.fromRelPath, edge.toRelPath)
          }

          const hops = new Map<string, number>([[root, 0]])
          let frontier = [root]
          for (let step = 1; step <= depth && frontier.length > 0; step += 1) {
            const next: string[] = []
            for (const current of frontier) {
              for (const neighbour of neighbours.get(current) ?? []) {
                if (hops.has(neighbour)) continue
                hops.set(neighbour, step)
                next.push(neighbour)
              }
            }
            frontier = next.sort()
          }

          const degree = new Map(
            all.nodes.map((node) => [node.relPath, node.inDegree + node.outDegree]),
          )
          const ordered = [...hops.keys()].sort(
            (left, right) =>
              (hops.get(left) ?? 0) - (hops.get(right) ?? 0) ||
              (degree.get(right) ?? 0) - (degree.get(left) ?? 0) ||
              left.localeCompare(right),
          )
          const kept = new Set(ordered.slice(0, maxNodes))
          const nodes = all.nodes.filter((node) => kept.has(node.relPath))
          const edges = all.edges.filter((edge) => {
            if (!kept.has(edge.fromRelPath)) return false
            // 悬空边只在中心那一侧出现：别人指向"不存在的笔记"的边不属于这张子图
            if (edge.toRelPath === null) return edge.fromRelPath === root
            return kept.has(edge.toRelPath)
          })
          return {
            nodes,
            edges,
            truncated: ordered.length > maxNodes,
            elapsedMs: 1,
          }
}
