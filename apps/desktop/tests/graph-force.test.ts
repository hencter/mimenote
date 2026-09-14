/**
 * 力导向浮动态（`features/graph/force.ts` + `force-presets.ts`）。
 *
 * 这一层全是纯函数（不 import React、不碰 DOM、不读时钟），所以测试也全是"输入 → 输出"的直接断言。
 * 四条最该钉死的性质：
 *
 * 1. **确定性**：同一份输入跑同样的步数 ⇒ 逐字节相同的位置（换 `seed` 才换排布）。
 *    这是本层存在的理由 —— 它必须能与 ADR-0021"坐标是数据的纯函数"共存；
 * 2. **三股力各自真的有效**：向心力收拢、斥力分开重叠的卡片、弹簧让"张力"这个旋钮可感；
 * 3. **钉住 = 事实**：`fixed` 一步都不动但仍在推别人，`pin/unpin` 真的钉住与松开；
 * 4. **边界不炸**：`0` 参数、单节点、零边、`dt = 0`、极端参数都不抛错、不出 NaN/Infinity。
 *
 * 断言里凡是出现"某个距离应该小于多少"，都是**性质**（收拢了、分开了、更远了），不是
 * 某一次跑出来的具体数字；只有确定性的那几条才比较逐字节相等。
 */

import { describe, expect, it } from 'vitest'

import { rectsIntersect, type Rect } from '@/features/graph/layout'
import {
  DEFAULT_FORCE_PARAMS,
  createForceSimulation,
  type ForceEdge,
  type ForceNode,
  type ForceParams,
  type ForceSimulation,
} from '@/features/graph/force'
import { FORCE_PRESETS, forcePreset } from '@/features/graph/force-presets'

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 基准卡片：完整 markdown 预览的典型尺寸（与 `force.ts` 里默认参数的依据同一套）。 */
const CARD_WIDTH = 320
const CARD_HEIGHT = 400

interface SeedNode {
  relPath: string
  x: number
  y: number
  width: number
  height: number
  hop: number
  fixed?: boolean
}

function seed(
  relPath: string,
  x: number,
  y: number,
  extra: Partial<Omit<SeedNode, 'relPath' | 'x' | 'y'>> = {},
): SeedNode {
  return {
    relPath,
    x,
    y,
    width: extra.width ?? CARD_WIDTH,
    height: extra.height ?? CARD_HEIGHT,
    hop: extra.hop ?? 1,
    fixed: extra.fixed,
  }
}

function edge(from: string, to: string): ForceEdge {
  return { from, to }
}

function nodeOf(sim: ForceSimulation, relPath: string): ForceNode {
  const found = sim.nodes.find((node) => node.relPath === relPath)
  if (found === undefined) throw new Error(`图上没有这个节点：${relPath}`)
  return found
}

/** 位置快照：逐字节比较用（`toEqual` 对数字是精确相等，NaN 与 -0 也会被发现）。 */
function snapshot(sim: ForceSimulation): [string, number, number][] {
  return [...sim.positions()].map(([relPath, point]) => [relPath, point.x, point.y])
}

function distanceBetween(sim: ForceSimulation, from: string, to: string): number {
  const a = nodeOf(sim, from)
  const b = nodeOf(sim, to)
  const dx = b.x - a.x
  const dy = b.y - a.y
  return Math.sqrt(dx * dx + dy * dy)
}

function radiusOf(sim: ForceSimulation, relPath: string): number {
  const node = nodeOf(sim, relPath)
  return Math.sqrt(node.x * node.x + node.y * node.y)
}

function maxSpeedOf(sim: ForceSimulation): number {
  let max = 0
  for (const node of sim.nodes) {
    max = Math.max(max, Math.sqrt(node.vx * node.vx + node.vy * node.vy))
  }
  return max
}

function expectFinite(sim: ForceSimulation): void {
  for (const node of sim.nodes) {
    expect(Number.isFinite(node.x)).toBe(true)
    expect(Number.isFinite(node.y)).toBe(true)
    expect(Number.isFinite(node.vx)).toBe(true)
    expect(Number.isFinite(node.vy)).toBe(true)
  }
  expect(Number.isFinite(sim.alpha)).toBe(true)
}

/**
 * 卡片矩形：`positions()`（= 中心 − 尺寸/2）配上 `ForceNode.width/height`。
 * 这是画笔真正会画出来的那个盒子，碰撞的判据必须落在这上面。
 */
function cardRects(sim: ForceSimulation): Rect[] {
  const positions = sim.positions()
  const rects: Rect[] = []
  for (const node of sim.nodes) {
    const point = positions.get(node.relPath)
    if (point === undefined) continue
    rects.push({ x: point.x, y: point.y, width: node.width, height: node.height })
  }
  return rects
}

/**
 * 相交的卡片对数。判据直接复用 `layout.ts` 的 `rectsIntersect`（贴边不算相交）——
 * 刻意**不**重写一份"中心距 > 对角线"之类的近似：那种近似会把"竖直相切"也算成重叠。
 */
function intersectingPairs(sim: ForceSimulation): number {
  const rects = cardRects(sim)
  let pairs = 0
  for (let i = 0; i < rects.length; i += 1) {
    const a = rects[i]
    if (a === undefined) continue
    for (let j = i + 1; j < rects.length; j += 1) {
      const b = rects[j]
      if (b === undefined) continue
      if (rectsIntersect(a, b)) pairs += 1
    }
  }
  return pairs
}

/** 最深的一处重叠（世界像素）：0 = 没有任何一对相交；用于比较"1 轮 vs 4 轮"这类相对效果。 */
function maxOverlapDepth(sim: ForceSimulation): number {
  let worst = 0
  const list = sim.nodes
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i]
    if (a === undefined) continue
    for (let j = i + 1; j < list.length; j += 1) {
      const b = list[j]
      if (b === undefined) continue
      const overlapX = (a.width + b.width) / 2 - Math.abs(b.x - a.x)
      const overlapY = (a.height + b.height) / 2 - Math.abs(b.y - a.y)
      if (overlapX > 0 && overlapY > 0) worst = Math.max(worst, Math.min(overlapX, overlapY))
    }
  }
  return worst
}

/** 12 张卡片全挤在原点附近（最狠的一档：相邻中心距只有 10px，重叠量接近一整个卡片宽）。 */
function crowdedCluster(): SeedNode[] {
  return Array.from({ length: 12 }, (_, index) =>
    seed(`挤${index}.md`, (index % 4) * 10 - 15, (Math.floor(index / 4) % 3) * 10 - 5, {
      hop: index % 3,
    }),
  )
}

/** 一圈很密的环：中心 + 12 个邻居摆在半径 80 上（相邻中心距 ≈41px，全部互相重叠）。 */
function crowdedRing(): { nodes: SeedNode[]; edges: ForceEdge[] } {
  const DEG = Math.PI / 180
  const nodes = [
    seed('环心.md', 0, 0, { hop: 0 }),
    ...Array.from({ length: 12 }, (_, index) =>
      seed(`环${index}.md`, Math.cos(index * 30 * DEG) * 80, Math.sin(index * 30 * DEG) * 80, {
        hop: 1,
      }),
    ),
  ]
  const edges = nodes.slice(1).map((node) => edge('环心.md', node.relPath))
  return { nodes, edges }
}

// ---------------------------------------------------------------------------
// 确定性
// ---------------------------------------------------------------------------

describe('确定性（本层存在的理由：必须与 ADR-0021 的"坐标是数据的纯函数"共存）', () => {
  it('同一份输入跑同样的步数 ⇒ 位置逐字节相同', () => {
    const nodes = [
      seed('中心.md', 0, 0, { hop: 0 }),
      seed('甲.md', 560, 0),
      seed('乙.md', 0, 560),
      seed('丙.md', -560, 0),
      seed('丁.md', 0, -560, { hop: 2 }),
    ]
    const edges = [edge('中心.md', '甲.md'), edge('甲.md', '丁.md'), edge('丙.md', '中心.md')]
    const build = (): ForceSimulation =>
      createForceSimulation({ nodes, edges, jitter: 24, seed: 7 })

    const first = build()
    const second = build()
    const firstSteps = first.settle()
    const secondSteps = second.settle()

    expect(firstSteps).toBe(secondSteps)
    expect(snapshot(first)).toEqual(snapshot(second))
    expect(first.alpha).toBe(second.alpha)
  })

  it('抖动由 seed 决定：同一个 seed 一致，换个 seed 就换一个排布', () => {
    const nodes = [seed('甲.md', 100, 0), seed('乙.md', -100, 60), seed('丙.md', 0, -120)]
    const jittered = (seedValue: number): ForceSimulation =>
      createForceSimulation({ nodes, edges: [], jitter: 40, seed: seedValue })

    const same = snapshot(jittered(3))
    const other = snapshot(jittered(4))

    expect(snapshot(jittered(3))).toEqual(same)
    expect(other).not.toEqual(same)
    // 逐个点比：换 seed 之后**每个**节点的抖动值都变了（不是"只错开了一个点"就通过）
    for (const [index, entry] of same.entries()) {
      const counterpart = other[index]
      if (counterpart === undefined) throw new Error('两次快照的节点数不一致')
      expect([entry[1], entry[2]]).not.toEqual([counterpart[1], counterpart[2]])
    }
  })

  it('不修改传入的数组与对象；positions() 每次都是新的快照', () => {
    const nodes = [seed('甲.md', 0, 0), seed('乙.md', 300, 0)]
    const edges = [edge('甲.md', '乙.md')]
    const nodesBefore = nodes.map((node) => ({ ...node }))
    const edgesBefore = edges.map((item) => ({ ...item }))

    const sim = createForceSimulation({ nodes, edges })
    sim.settle()

    expect(nodes).toEqual(nodesBefore)
    expect(edges).toEqual(edgesBefore)
    expect(nodes).toHaveLength(2)

    const first = sim.positions()
    const second = sim.positions()
    expect(first).not.toBe(second)
    first.set('甲.md', { x: 99999, y: 99999 })
    // 改快照不影响模拟：再问一次还是原来的位置
    expect(sim.positions()).toEqual(second)
  })
})

// ---------------------------------------------------------------------------
// 向心力
// ---------------------------------------------------------------------------

describe('向心力', () => {
  it('单个散开的节点被拉回原点附近（其余力关掉，隔离出向心力）', () => {
    const sim = createForceSimulation({
      nodes: [seed('散.md', 600, 400, { hop: 0 })],
      edges: [],
      params: { centerStrength: 0.02, repelStrength: 0, linkStrength: 0, alphaDecay: 0 },
    })
    const start = radiusOf(sim, '散.md')
    sim.settle(400)

    expect(start).toBeGreaterThan(700) // 起点确实在很远的地方（否则测的就不是"收回"）
    expect(radiusOf(sim, '散.md')).toBeLessThan(1)
  })

  it('默认参数下，一圈散开的孤立节点全部向内收拢（但斥力不许它们叠成一点）', () => {
    const nodes = [
      seed('甲.md', 700, 0),
      seed('乙.md', 350, 606),
      seed('丙.md', -350, 606),
      seed('丁.md', -700, 0),
      seed('戊.md', -350, -606),
      seed('己.md', 350, -606),
    ]
    const sim = createForceSimulation({ nodes, edges: [] })
    const start = nodes.map((node) => radiusOf(sim, node.relPath))
    sim.settle()
    const end = nodes.map((node) => radiusOf(sim, node.relPath))

    for (const [index, radius] of end.entries()) {
      const before = start[index] ?? 0
      expect(radius).toBeLessThan(before) // 每一个都更近了
    }
    const meanStart = start.reduce((sum, value) => sum + value, 0) / start.length
    const meanEnd = end.reduce((sum, value) => sum + value, 0) / end.length
    // 实测（默认参数）：平均半径 700 → 339，也就是**收缩到一半以下**；这里留到 0.6 倍，
    // 是给"以后微调默认参数"留的余量，不是给公式留的
    expect(meanEnd).toBeLessThan(meanStart * 0.6)
    // 但没有互相叠进去：六张卡片仍按 0.8 张卡片宽以上的间距散开（斥力还在工作）
    expect(meanEnd).toBeGreaterThan(CARD_WIDTH * 0.8)
  })
})

// ---------------------------------------------------------------------------
// 斥力
// ---------------------------------------------------------------------------

describe('斥力', () => {
  it('两张重叠的卡片被分开到不再相交', () => {
    const sim = createForceSimulation({
      nodes: [seed('甲.md', 0, 0, { hop: 0 }), seed('乙.md', 60, 0)],
      edges: [],
    })
    expect(Math.abs(nodeOf(sim, '乙.md').x - nodeOf(sim, '甲.md').x)).toBeLessThan(CARD_WIDTH)

    sim.settle()

    // 不相交：中心距 ≥ 两张卡片的半步长之和
    expect(distanceBetween(sim, '甲.md', '乙.md')).toBeGreaterThanOrEqual(CARD_WIDTH)
  })

  it('同样 400px 的中心距，竖直方向（两张高卡已相切）比水平方向推得更狠', () => {
    const params: Partial<ForceParams> = {
      centerStrength: 0,
      linkStrength: 0,
      repelStrength: 4,
      damping: 1,
      maxSpeed: 1000,
      alphaDecay: 0,
    }
    const build = (x: number, y: number): ForceSimulation =>
      createForceSimulation({
        nodes: [seed('甲.md', 0, 0, { hop: 0 }), seed('乙.md', x, y)],
        edges: [],
        params,
      })

    const horizontal = build(400, 0)
    const vertical = build(0, 400)
    horizontal.step()
    vertical.step()

    const pushedX = Math.abs(nodeOf(horizontal, '乙.md').vx)
    const pushedY = Math.abs(nodeOf(vertical, '乙.md').vy)

    // 320×400 的卡片：竖直方向 400px 已经相切（q=1），水平方向 400px 还差 80px 才相切（q=1.25）。
    // 椭圆半步长度量会把这个差别算进力里；纯圆心距离会给出**完全相同**的两个力。
    expect(pushedY).toBeGreaterThan(pushedX)
    expect(pushedY - pushedX).toBeGreaterThan(0.5)
  })

  it('完全重合的两张卡片也会被确定地推开（方向由下标决定，不是随机）', () => {
    const params: Partial<ForceParams> = { centerStrength: 0, alphaDecay: 0 }
    const build = (): ForceSimulation =>
      createForceSimulation({
        nodes: [seed('甲.md', 0, 0), seed('乙.md', 0, 0)],
        edges: [],
        params,
      })

    const sim = build()
    sim.step()
    const twin = build()
    twin.step()

    expectFinite(sim)
    expect(distanceBetween(sim, '甲.md', '乙.md')).toBeGreaterThan(0)
    expect(snapshot(twin)).toEqual(snapshot(sim))
  })

  it('repelStrength = 0 时两张重叠的卡片不分开（也不抛错）', () => {
    // ⚠️ 这条测的是"斥力这一股力被关掉之后没有任何东西再把它们推开"，所以必须**同时**把碰撞
    // 约束也关掉（`collideStrength: 0`）：两张卡片本来就是重叠摆的（中心距 44px < 320），
    // 有了碰撞之后它们会被约束直接分开 —— 那是**新加的一条正确行为**，不是这条测试要测的东西。
    // 换句话说：这条断言在加碰撞之前成立，是因为"当时允许重叠"；现在"允许重叠"必须显式声明。
    const sim = createForceSimulation({
      nodes: [seed('甲.md', 0, 0), seed('乙.md', 40, 20)],
      edges: [],
      params: { repelStrength: 0, centerStrength: 0, alphaDecay: 0, collideStrength: 0 },
    })
    const before = snapshot(sim)

    sim.step()
    sim.step()

    expect(snapshot(sim)).toEqual(before)
    expectFinite(sim)
  })
})

// ---------------------------------------------------------------------------
// 碰撞（约束，不是第四股力）
// ---------------------------------------------------------------------------

describe('碰撞（约束：矩形不许相交）', () => {
  it('12 张卡片全挤在原点附近：settle() 之后零重叠（矩形判据，0 容差）', () => {
    const sim = createForceSimulation({ nodes: crowdedCluster(), edges: [] })

    // 起点确实是"叠成一坨"（否则这条测试什么也没证明）
    expect(intersectingPairs(sim)).toBeGreaterThan(0)

    const steps = sim.settle()

    expect(steps).toBeGreaterThan(0)
    expect(intersectingPairs(sim)).toBe(0)
    expect(maxOverlapDepth(sim)).toBe(0)
    expectFinite(sim)
  })

  it('一圈很密的环（中心 + 12 邻居 + 连线）：settle() 之后同样零重叠', () => {
    const { nodes, edges } = crowdedRing()
    const sim = createForceSimulation({ nodes, edges })

    expect(intersectingPairs(sim)).toBeGreaterThan(0)

    sim.settle()

    expect(intersectingPairs(sim)).toBe(0)
    expect(maxOverlapDepth(sim)).toBe(0)
    expectFinite(sim)
  })

  it('把碰撞关掉（collideStrength: 0）就会重叠 —— 上面那两条不是恒真的', () => {
    // 同一份"挤在原点"的输入，只把碰撞约束关掉：斥力是"倾向"，它推不开这么密的堆。
    const sim = createForceSimulation({
      nodes: crowdedCluster(),
      edges: [],
      params: { collideStrength: 0 },
    })

    sim.settle()

    expect(intersectingPairs(sim)).toBeGreaterThan(0)
    expect(maxOverlapDepth(sim)).toBeGreaterThan(0)
  })

  it('4 轮之后的最大残余重叠 ≤ 1 轮之后（多轮确实在收敛）', () => {
    const { nodes, edges } = crowdedRing()
    // alphaDecay 0 ⇒ 力一直热着（一直在把卡片往里挤），残余重叠不会被"降温"掩盖，
    // 这样比较的才是**轮数**的效果，而不是"谁先冻住"
    const build = (collideIterations: number): ForceSimulation =>
      createForceSimulation({
        nodes,
        edges,
        params: { alphaDecay: 0, collideStrength: 1, collideIterations },
      })

    const one = build(1)
    const four = build(4)
    for (let index = 0; index < 6; index += 1) {
      one.step()
      four.step()
    }

    const residualOne = maxOverlapDepth(one)
    const residualFour = maxOverlapDepth(four)

    expect(residualOne).toBeGreaterThan(0) // 1 轮真的推不干净（否则这条比较是空转）
    expect(residualFour).toBeLessThanOrEqual(residualOne)
  })

  it('被钉住的卡片不因碰撞而移动，但它仍然把别人推开', () => {
    const sim = createForceSimulation({
      nodes: [seed('钉.md', 0, 0, { hop: 0, fixed: true }), seed('游.md', 40, 0)],
      edges: [],
      // 只留碰撞：把斥力也关掉，才能确定"游.md 动了"是约束干的
      params: { centerStrength: 0, repelStrength: 0, alphaDecay: 0 },
    })
    const pinned = nodeOf(sim, '钉.md')

    sim.step()

    expect({ x: pinned.x, y: pinned.y }).toEqual({ x: 0, y: 0 })
    expect(pinned.vx).toBe(0)
    expect(pinned.vy).toBe(0)
    // 钉住的那一半修正全部让给对面：40 + (320 − 40) = 320，正好相切 —— 再多推一微米
    // （碰撞的"皮"，见 `force.ts` 的 `COLLIDE_SLOP`）。所以这里是"到 320 的几微米以内"（精度 5），
    // 不是恰好相等；"分开"这个事实由下面那条 0 相交断言钉住。
    expect(nodeOf(sim, '游.md').x).toBeCloseTo(320, 5)
    expect(intersectingPairs(sim)).toBe(0)
  })

  it('两张都钉住时谁都不动（重叠只能如实留着）', () => {
    const sim = createForceSimulation({
      nodes: [
        seed('钉甲.md', 0, 0, { hop: 0, fixed: true }),
        seed('钉乙.md', 40, 0, { fixed: true }),
      ],
      edges: [],
      params: { centerStrength: 0, repelStrength: 0, alphaDecay: 0 },
    })
    const before = snapshot(sim)

    for (let index = 0; index < 5; index += 1) sim.step()

    expect(snapshot(sim)).toEqual(before)
    // 谁都不能动 ⇒ 这一对只能叠着（不是"解开了"，是"没得解"）
    expect(intersectingPairs(sim)).toBe(1)
  })

  describe('heat（交互把力场重新唤醒）', () => {
    /*
      为什么需要这一组：`settle()` 之后 alpha = 0，力全部停摆 —— 打开图谱很安静是对的，
      但用户一旦开始拖卡片，"邻居让开"必须靠力（只有硬碰撞的话就是"撞上去才动"）。
      `heat` 于是成了**交互层唯一的重启开关**，它的语义要被逐条钉住。
    */

    it('settle() 之后加热会让邻居重新受力', () => {
      const nodes = [seed('甲.md', 0, 0, { hop: 0, fixed: true }), seed('乙.md', 900, 0)]
      const edges: ForceEdge[] = [edge('甲.md', '乙.md')]
      const sim = createForceSimulation({ nodes, edges, params: { damping: 0.5 } })
      sim.settle()
      // 落定的定义就是"已经冷了"：alpha = 0，之后再走步位置一点不动
      expect(sim.alpha).toBe(0)

      const before = snapshot(sim)
      sim.heat(0.6)
      expect(sim.alpha).toBe(0.6)
      for (let index = 0; index < 5; index += 1) sim.step()

      expect(snapshot(sim)).not.toEqual(before)
      expect(intersectingPairs(sim)).toBe(0)
    })

    it('只升温不降温：heat(0) 不会把已经热着的模拟冷下来', () => {
      const sim = createForceSimulation({ nodes: [seed('甲.md', 0, 0), seed('乙.md', 900, 0)], edges: [] })
      sim.heat(0.8)
      const hot = sim.alpha
      sim.heat(0)
      sim.heat(-5)
      expect(sim.alpha).toBe(hot)
    })

    it('强度夹在 0..1：heat(2) 不会让斥力比参数面板给的更强', () => {
      const sim = createForceSimulation({ nodes: [seed('甲.md', 0, 0)], edges: [] })
      sim.settle()
      sim.heat(2)
      expect(sim.alpha).toBe(1)
    })

    it('加热是临时的：力全开时可以短暂重叠，但重新落定之后仍然零重叠', () => {
      /*
        这条把"零重叠"的**适用范围**钉清楚：它是**落定状态**的不变量，不是"任意时刻"的。
        力全开（alpha = 1）时卡片被推得很快，约束在追但追不上，中间帧可以有重叠 ——
        这是力导向本来就有的样子（用户看到的也是"撞开"的动感）。
        真正要保证的是：加热不会留下一个永久重叠的终态。
      */
      const { nodes, edges } = crowdedRing()
      const sim = createForceSimulation({ nodes, edges })
      sim.settle()
      sim.heat(1)
      for (let index = 0; index < 40; index += 1) sim.step()
      sim.settle()
      expect(intersectingPairs(sim)).toBe(0)
    })

    it('加热 + 同样的步数 ⇒ 位置逐字节可复现（确定性没有被交互打破）', () => {
      const run = (): [string, number, number][] => {
        const { nodes, edges } = crowdedRing()
        const sim = createForceSimulation({ nodes, edges })
        sim.settle()
        sim.pin('环心.md', 120, -80)
        sim.heat(0.5)
        for (let index = 0; index < 12; index += 1) sim.step()
        return snapshot(sim)
      }
      expect(run()).toEqual(run())
    })
  })

  it('collideStrength 取中间值：重叠减少但不为零（软约束的语义）', () => {
    // 两张卡片被一条 linkDistance 0 的弹簧一直往一起拉（alphaDecay 0 ⇒ 力永不降温），
    // 于是"稳态残余重叠"会一直存在，正好用来比较三种强度。
    const build = (collideStrength: number): ForceSimulation =>
      createForceSimulation({
        nodes: [seed('甲.md', 0, 0), seed('乙.md', 200, 0)],
        edges: [edge('甲.md', '乙.md')],
        params: {
          centerStrength: 0,
          repelStrength: 0,
          linkStrength: 0.05,
          linkDistance: 0,
          maxSpeed: 24,
          alphaDecay: 0,
          collideStrength,
          collideIterations: 1,
        },
      })

    const off = build(0)
    const soft = build(0.5)
    const hard = build(1)
    for (let index = 0; index < 200; index += 1) {
      off.step()
      soft.step()
      hard.step()
    }

    const residualOff = maxOverlapDepth(off)
    const residualSoft = maxOverlapDepth(soft)
    const residualHard = maxOverlapDepth(hard)

    expect(residualSoft).toBeGreaterThan(0) // 软约束**允许**一点稳态重叠
    expect(residualSoft).toBeLessThan(residualOff) // 但比关掉碰撞时少得多
    expect(residualHard).toBeLessThanOrEqual(residualSoft) // 越硬越干净
  })

  it('沿重叠量较小的那一轴分离（MTV 的定义）', () => {
    // 竖直方向只重叠 20px、水平方向重叠 320px ⇒ 应该沿 y 分开，x 一动都不动。
    // 如果实现成"总是沿 x 推"（很容易犯的错），这条会立刻红。
    const sim = createForceSimulation({
      nodes: [seed('甲.md', 0, 0), seed('乙.md', 0, 380)],
      edges: [],
      params: { centerStrength: 0, repelStrength: 0, alphaDecay: 0 },
    })

    sim.step()

    expect(nodeOf(sim, '甲.md').x).toBe(0)
    expect(nodeOf(sim, '乙.md').x).toBe(0)
    // 两边都可动 ⇒ 各推一半：乙 380 → 390+、甲 0 → −10−，**相对距离**从 380 变成 400
    // （正好相切 + 一微米的"皮"，所以精度取 5 而不是 6）
    expect(nodeOf(sim, '乙.md').y - nodeOf(sim, '甲.md').y).toBeCloseTo(400, 5)
    expect(intersectingPairs(sim)).toBe(0)
  })

  it('碰撞只改位置、不改速度（约束不是冲量）', () => {
    const sim = createForceSimulation({
      nodes: [seed('甲.md', 0, 0), seed('乙.md', 40, 0)],
      edges: [],
      params: { centerStrength: 0, repelStrength: 0, alphaDecay: 0 },
    })
    // ⚠️ 必须把数字读出来：`nodeOf` 返回的是模拟**内部**那个对象（每帧就地更新），
    // 抓着它当"改动前的快照"是错的（读到的永远是新值）
    const beforeX = nodeOf(sim, '乙.md').x

    sim.step()

    const after = nodeOf(sim, '乙.md')
    expect(after.x).not.toBe(beforeX) // 位置被约束修正了
    expect(after.vx).toBe(0) // 但速度没被碰过（那是力场的职责）
    expect(after.vy).toBe(0)
  })

  it('dt = 0 时连碰撞也不跑（整步暂停）；有 dt 的一步才会解重叠', () => {
    const sim = createForceSimulation({
      nodes: [seed('甲.md', 0, 0), seed('乙.md', 40, 0)],
      edges: [],
      params: { centerStrength: 0, repelStrength: 0, alphaDecay: 0 },
    })
    const before = snapshot(sim)

    sim.step(0)
    sim.step(Number.NaN)
    expect(snapshot(sim)).toEqual(before) // 暂停：位置修正也不该发生
    expect(intersectingPairs(sim)).toBe(1)

    sim.step(1)
    expect(intersectingPairs(sim)).toBe(0) // 真的走了一步，约束才生效
  })

  it('collideIterations 被夹到 1..4 的整数：越界、小数、非有限值都落到合法档', () => {
    const { nodes, edges } = crowdedRing()
    const run = (collideIterations: number): [string, number, number][] => {
      const sim = createForceSimulation({
        nodes,
        edges,
        params: { alphaDecay: 0, collideIterations },
      })
      for (let index = 0; index < 5; index += 1) sim.step()
      return snapshot(sim)
    }

    expect(run(99)).toEqual(run(4)) // 上界夹到 4
    expect(run(0)).toEqual(run(1)) // 下界夹到 1（关掉碰撞只有 collideStrength: 0 一条路）
    expect(run(2.6)).toEqual(run(3)) // 小数四舍五入
    expect(run(Number.NaN)).toEqual(run(3)) // 非有限值退到默认的 3
  })

  it('碰撞不看边也不看跳数：不相连的卡片照样被分开', () => {
    const sim = createForceSimulation({
      nodes: [seed('甲.md', 0, 0, { hop: 0 }), seed('乙.md', 60, 0, { hop: 3 })],
      edges: [edge('甲.md', '别处.md')],
      // linkMaxHop 1 + 只有一条悬空边 ⇒ 弹簧什么都没连上，能分开它们的只有斥力与碰撞
      params: { centerStrength: 0, repelStrength: 0, linkMaxHop: 1, alphaDecay: 0 },
    })

    sim.step()

    expect(intersectingPairs(sim)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 弹簧（"张力"这个旋钮）
// ---------------------------------------------------------------------------

describe('弹簧（张力）', () => {
  it('linkDistance 变大时，相连的两点确实更远（旋钮真的有效）', () => {
    // ⚠️ 这里显式关掉碰撞（`collideStrength: 0`）：这条测试要的是"弹簧把两点拉到**自然长度**上"，
    // 而 linkDistance 200 < 卡片宽 320 —— 落点 200 意味着两张卡片必须叠着。带碰撞时它们会被
    // 分开到 ≥320，弹簧的自然长度就永远达不到（那是正确行为，但不是这条测试要钉的东西）。
    // 断言本身一个字没改。
    const build = (linkDistance: number): ForceSimulation =>
      createForceSimulation({
        nodes: [seed('甲.md', -200, 0), seed('乙.md', 200, 0)],
        edges: [edge('甲.md', '乙.md')],
        params: {
          centerStrength: 0,
          repelStrength: 0,
          linkDistance,
          alphaDecay: 0.008,
          collideStrength: 0,
        },
      })

    const tight = build(200)
    tight.settle()
    const loose = build(400)
    loose.settle()

    const tightDistance = distanceBetween(tight, '甲.md', '乙.md')
    const looseDistance = distanceBetween(loose, '甲.md', '乙.md')

    expect(looseDistance).toBeGreaterThan(tightDistance)
    // 弹簧的落点是**自然长度**本身：容差 5% 只用来吸收阻尼下的残余摆动
    expect(Math.abs(tightDistance - 200)).toBeLessThan(10)
    expect(Math.abs(looseDistance - 400)).toBeLessThan(20)
  })

  it('linkStrength = 0 时弹簧不拉（两个相距很远的相连点原地不动）', () => {
    const sim = createForceSimulation({
      nodes: [seed('甲.md', -600, 0), seed('乙.md', 600, 0)],
      edges: [edge('甲.md', '乙.md')],
      params: { linkStrength: 0, centerStrength: 0, repelStrength: 0, alphaDecay: 0 },
    })
    const before = snapshot(sim)

    sim.step()
    sim.step()

    expect(snapshot(sim)).toEqual(before)
  })

  it('linkMaxHop = 1 时二跳的边不参与弹簧力（等价于把那一条边删掉）', () => {
    const nodes = [
      seed('中心.md', 0, 0, { hop: 0 }),
      seed('一跳.md', 560, 0, { hop: 1 }),
      seed('二跳.md', 560, 560, { hop: 2 }),
    ]
    const params: Partial<ForceParams> = { alphaDecay: 0.01 }

    const capped = createForceSimulation({
      nodes,
      edges: [edge('中心.md', '一跳.md'), edge('一跳.md', '二跳.md')],
      params: { ...params, linkMaxHop: 1 },
    })
    const without = createForceSimulation({
      nodes,
      edges: [edge('中心.md', '一跳.md')],
      params: { ...params, linkMaxHop: 1 },
    })
    const all = createForceSimulation({
      nodes,
      edges: [edge('中心.md', '一跳.md'), edge('一跳.md', '二跳.md')],
      params: { ...params, linkMaxHop: Number.POSITIVE_INFINITY },
    })

    expect(capped.settle()).toBe(without.settle())
    expect(snapshot(capped)).toEqual(snapshot(without))
    // 对照组：放开之后同一条边**确实**会改变结果（否则上面那条断言可能因为边根本没接上而假通过）
    all.settle()
    expect(snapshot(all)).not.toEqual(snapshot(capped))
  })

  it('指向不存在的节点、自环都不抛错，也不产生任何力', () => {
    const nodes = [seed('甲.md', -300, 0), seed('乙.md', 300, 0)]
    const params: Partial<ForceParams> = { alphaDecay: 0.008 }
    const withJunk = createForceSimulation({
      nodes,
      edges: [
        edge('甲.md', '还不存在.md'),
        edge('幽灵.md', '乙.md'),
        edge('甲.md', '甲.md'),
        edge('甲.md', '乙.md'),
      ],
      params,
    })
    const clean = createForceSimulation({
      nodes,
      edges: [edge('甲.md', '乙.md')],
      params,
    })

    expect(withJunk.settle()).toBe(clean.settle())
    expect(snapshot(withJunk)).toEqual(snapshot(clean))
    expectFinite(withJunk)
  })
})

// ---------------------------------------------------------------------------
// 固定与拖动
// ---------------------------------------------------------------------------

describe('固定与拖动', () => {
  it('fixed 节点一步都不动，但仍然在把别人推开', () => {
    const sim = createForceSimulation({
      nodes: [seed('钉.md', 0, 0, { hop: 0, fixed: true }), seed('游.md', 100, 0)],
      edges: [],
      params: { centerStrength: 0, alphaDecay: 0 },
    })
    const pinned = nodeOf(sim, '钉.md')
    const start = { x: pinned.x, y: pinned.y }

    for (let index = 0; index < 10; index += 1) sim.step()

    expect({ x: pinned.x, y: pinned.y }).toEqual(start)
    expect(pinned.vx).toBe(0)
    expect(pinned.vy).toBe(0)
    // 被推开的证据：游.md 沿着 +x 走远了（斥力来自那张钉住的卡片）
    expect(nodeOf(sim, '游.md').x).toBeGreaterThan(100)
  })

  it('pin 把节点钉在指定点（并且一步不动），unpin 之后它又被力场接管', () => {
    const sim = createForceSimulation({
      nodes: [seed('甲.md', 0, 0, { hop: 0 }), seed('乙.md', 200, 0)],
      edges: [],
      params: { centerStrength: 0, alphaDecay: 0 },
    })

    sim.pin('甲.md', 1000, -500)
    expect({ x: nodeOf(sim, '甲.md').x, y: nodeOf(sim, '甲.md').y }).toEqual({ x: 1000, y: -500 })

    for (let index = 0; index < 20; index += 1) sim.step()
    expect({ x: nodeOf(sim, '甲.md').x, y: nodeOf(sim, '甲.md').y }).toEqual({ x: 1000, y: -500 })

    sim.unpin('甲.md')
    sim.settle(60)
    // 松手之后只剩乙的斥力：它一定被推离 (1000, -500)
    expect({ x: nodeOf(sim, '甲.md').x, y: nodeOf(sim, '甲.md').y }).not.toEqual({
      x: 1000,
      y: -500,
    })
  })

  it('pin / unpin 一个不存在的 relPath 不抛错', () => {
    const sim = createForceSimulation({ nodes: [seed('甲.md', 0, 0)], edges: [] })

    expect(() => sim.pin('早就删掉了.md', 10, 10)).not.toThrow()
    expect(() => sim.unpin('早就删掉了.md')).not.toThrow()
    expectFinite(sim)
  })
})

// ---------------------------------------------------------------------------
// 落定与 alpha
// ---------------------------------------------------------------------------

describe('落定与 alpha', () => {
  it('settle() 返回步数；落定之后再 settle 是 0 步且位置不再变化；settle(0) 一步不走', () => {
    const sim = createForceSimulation({
      nodes: [seed('甲.md', 0, 0, { hop: 0 }), seed('乙.md', 560, 0), seed('丙.md', 0, 560)],
      edges: [edge('甲.md', '乙.md'), edge('乙.md', '丙.md')],
      params: { alphaDecay: 0.02 },
    })

    const steps = sim.settle(500)
    expect(steps).toBeGreaterThan(0)
    expect(steps).toBeLessThan(500) // 真的是"跑到了稳定"，不是撞上限

    const settled = snapshot(sim)
    expect(sim.settle(500)).toBe(0)
    expect(snapshot(sim)).toEqual(settled)
    expect(sim.settle(0)).toBe(0)
    expect(snapshot(sim)).toEqual(settled)
  })

  it('alphaDecay > 0 时 alpha 单调降到 0', () => {
    const sim = createForceSimulation({
      nodes: [seed('甲.md', 400, 0)],
      edges: [],
      params: { alphaDecay: 0.01 },
    })
    expect(sim.alpha).toBe(1)

    let previous = sim.alpha
    for (let index = 0; index < 120; index += 1) {
      sim.step()
      expect(sim.alpha).toBeLessThanOrEqual(previous)
      previous = sim.alpha
    }
    expect(sim.alpha).toBe(0)
  })

  it('alphaDecay = 0 时 alpha 恒为 1，settle 跑满上限（永不落定 = 持续漂浮）', () => {
    const sim = createForceSimulation({
      nodes: [seed('甲.md', 0, 0, { hop: 0 }), seed('乙.md', 560, 0)],
      edges: [edge('甲.md', '乙.md')],
      params: { alphaDecay: 0 },
    })

    for (let index = 0; index < 30; index += 1) sim.step()

    expect(sim.alpha).toBe(1)
    expect(sim.settle(50)).toBe(50)
    expect(sim.alpha).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 边界与安全阀
// ---------------------------------------------------------------------------

describe('边界与安全阀', () => {
  it('positions() 就是"中心 − 尺寸/2"（直接喂给画笔的那一份）', () => {
    const nodes = [
      seed('甲.md', 0, 0, { width: 320, height: 400 }),
      seed('乙.md', 100, -50, { width: 200, height: 90 }),
    ]
    const sim = createForceSimulation({ nodes, edges: [], jitter: 30, seed: 5 })

    const positions = sim.positions()
    expect(positions.size).toBe(2)
    for (const [relPath, point] of positions) {
      const node = nodeOf(sim, relPath)
      expect(point).toEqual({ x: node.x - node.width / 2, y: node.y - node.height / 2 })
    }
  })

  it('单个节点、零条边：不抛错，原地不动，也不会产生 NaN', () => {
    const sim = createForceSimulation({ nodes: [seed('独.md', 0, 0, { hop: 0 })], edges: [] })

    const steps = sim.settle()
    expect(Number.isInteger(steps)).toBe(true)
    expectFinite(sim)
    expect(sim.positions().get('独.md')).toEqual({ x: -CARD_WIDTH / 2, y: -CARD_HEIGHT / 2 })
  })

  it('dt = 0 不移动；非有限的 dt 当作"这一步不动"（不产生 NaN）', () => {
    const sim = createForceSimulation({
      nodes: [seed('甲.md', 0, 0, { hop: 0 }), seed('乙.md', 200, 0)],
      edges: [edge('甲.md', '乙.md')],
      params: { alphaDecay: 0 },
    })
    const before = snapshot(sim)

    sim.step(0)
    expect(snapshot(sim)).toEqual(before)
    sim.step(Number.NaN)
    expect(snapshot(sim)).toEqual(before)
    sim.step(Number.POSITIVE_INFINITY)
    expect(snapshot(sim)).toEqual(before)
    expectFinite(sim)
  })

  it('maxSpeed 是硬上限；取 0 时谁都动不了', () => {
    const nodes = [
      seed('甲.md', 0, 0, { hop: 0 }),
      seed('乙.md', 40, 20),
      seed('丙.md', -40, -20),
    ]
    const edges = [edge('甲.md', '乙.md'), edge('乙.md', '丙.md')]
    const extreme: ForceParams = {
      centerStrength: 1e3,
      repelStrength: 1e6,
      linkStrength: 1e3,
      linkDistance: 1e4,
      damping: 1,
      maxSpeed: 12,
      linkMaxHop: Number.POSITIVE_INFINITY,
      alphaDecay: 0,
      collideStrength: 1,
      collideIterations: 3,
    }

    const sim = createForceSimulation({ nodes, edges, params: extreme })
    for (let index = 0; index < 5; index += 1) {
      sim.step()
      // 1e-9 是"按 speed 重标定速度"的浮点末位误差，不是给公式留的余量
      expect(maxSpeedOf(sim)).toBeLessThanOrEqual(12 + 1e-9)
    }

    // ⚠️ maxSpeed = 0 的那一半**也要关掉碰撞**：`maxSpeed` 是"速度上限为零"，而碰撞是位置层面的
    // 约束 —— 三张卡片本来就是重叠摆的（中心距 ~45px），约束会照样把它们分开。
    // 这条断言（"谁都动不了"）是"速度被钳住"的直接结果，因此把约束关掉才是它要测的场景。
    const pinned: ForceParams = { ...extreme, maxSpeed: 0, collideStrength: 0 }
    const frozen = createForceSimulation({ nodes, edges, params: pinned })
    const before = snapshot(frozen)
    frozen.step()
    frozen.step()
    expect(snapshot(frozen)).toEqual(before)
    expectFinite(frozen)
  })

  it('极端 / 自相矛盾的参数组合都不产生 NaN 或 Infinity', () => {
    const nodes = [
      seed('甲.md', 0, 0, { hop: 0 }),
      seed('乙.md', 0, 0), // 完全重合：走退化方向那条分支
      seed('丙.md', Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER),
    ]
    const edges = [edge('甲.md', '乙.md'), edge('乙.md', '丙.md'), edge('甲.md', '不存在.md')]
    const table: Partial<ForceParams>[] = [
      { centerStrength: 1e9, repelStrength: 1e9, linkStrength: 1e9, linkDistance: 1e9, damping: 1, maxSpeed: 1e9, alphaDecay: 0 },
      { centerStrength: -1e6, repelStrength: -1e6, linkStrength: -1e6, linkDistance: -1e6, alphaDecay: -5 },
      { centerStrength: 0, repelStrength: 0, linkStrength: 0, maxSpeed: 0 },
      { damping: 0 },
      { damping: 5 },
      { damping: Number.NaN },
      { linkMaxHop: 0 },
      { linkMaxHop: Number.NaN },
      { linkDistance: Number.NaN },
      { alphaDecay: Number.POSITIVE_INFINITY },
      { centerStrength: Number.NaN, repelStrength: Number.NaN, linkStrength: Number.NaN },
    ]

    for (const params of table) {
      const sim = createForceSimulation({ nodes, edges, params, jitter: 10, seed: 2 })
      for (let index = 0; index < 20; index += 1) sim.step()
      expectFinite(sim)
      for (const [, x, y] of snapshot(sim)) {
        expect(Number.isFinite(x)).toBe(true)
        expect(Number.isFinite(y)).toBe(true)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 预设
// ---------------------------------------------------------------------------

describe('预设（参数面板上的那几档）', () => {
  it('id 唯一、文案齐备、数值都在可解释的范围内，而且每一档都能真的跑起来', () => {
    expect(FORCE_PRESETS.length).toBeGreaterThanOrEqual(4)

    const ids = new Set<string>()
    for (const preset of FORCE_PRESETS) {
      expect(ids.has(preset.id)).toBe(false)
      ids.add(preset.id)
      expect(preset.label.length).toBeGreaterThan(0)
      expect(preset.hint.length).toBeGreaterThan(0)

      const { params } = preset
      expect(Number.isFinite(params.centerStrength)).toBe(true)
      expect(Number.isFinite(params.repelStrength)).toBe(true)
      expect(Number.isFinite(params.linkStrength)).toBe(true)
      expect(Number.isFinite(params.linkDistance)).toBe(true)
      expect(Number.isFinite(params.damping)).toBe(true)
      expect(Number.isFinite(params.maxSpeed)).toBe(true)
      expect(Number.isFinite(params.alphaDecay)).toBe(true)
      expect(params.centerStrength).toBeGreaterThan(0)
      expect(params.repelStrength).toBeGreaterThan(0)
      expect(params.linkStrength).toBeGreaterThan(0)
      expect(params.linkDistance).toBeGreaterThan(0)
      expect(params.damping).toBeGreaterThan(0)
      expect(params.damping).toBeLessThanOrEqual(1)
      expect(params.maxSpeed).toBeGreaterThan(0)
      expect(params.maxSpeed).toBeLessThanOrEqual(64)
      expect(params.alphaDecay).toBeGreaterThanOrEqual(0)
      expect(params.linkMaxHop === Number.POSITIVE_INFINITY || params.linkMaxHop >= 1).toBe(true)
      // 碰撞这两项也要在合法区间里：strength 0..1、轮数 1..4 的整数
      expect(Number.isFinite(params.collideStrength)).toBe(true)
      expect(params.collideStrength).toBeGreaterThanOrEqual(0)
      expect(params.collideStrength).toBeLessThanOrEqual(1)
      expect(Number.isInteger(params.collideIterations)).toBe(true)
      expect(params.collideIterations).toBeGreaterThanOrEqual(1)
      expect(params.collideIterations).toBeLessThanOrEqual(4)
      // "笔记之间应该有碰撞"：除了「漂浮」（要慢、要软）之外，每一档都得真的能分开卡片
      expect(params.collideStrength).toBeGreaterThan(0.5)

      const sim = createForceSimulation({
        nodes: [seed('甲.md', 0, 0, { hop: 0 }), seed('乙.md', 560, 0), seed('丙.md', 0, 560, { hop: 2 })],
        edges: [edge('甲.md', '乙.md'), edge('乙.md', '丙.md')],
        params,
        jitter: 12,
        seed: 1,
      })
      sim.settle(200)
      expectFinite(sim)
    }
  })

  it('forcePreset：按 id 取到同一档，未知 id 退到均衡档（签名里没有 null）', () => {
    expect(forcePreset('balanced')).toBe(FORCE_PRESETS[0])
    for (const preset of FORCE_PRESETS) {
      expect(forcePreset(preset.id)).toBe(preset)
    }
    expect(forcePreset('还没实现过的档').label).toBe('均衡')
    expect(forcePreset('还没有的档').params).toEqual(DEFAULT_FORCE_PARAMS)
    expect(forcePreset('').id).toBe('balanced')
    // 预设是共享的一份参数：就地改一个字段不该污染默认值
    expect(Object.isFrozen(DEFAULT_FORCE_PARAMS)).toBe(true)
    expect(Object.isFrozen(FORCE_PRESETS)).toBe(true)
  })
})
