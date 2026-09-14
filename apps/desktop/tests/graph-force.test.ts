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
    const sim = createForceSimulation({
      nodes: [seed('甲.md', 0, 0), seed('乙.md', 40, 20)],
      edges: [],
      params: { repelStrength: 0, centerStrength: 0, alphaDecay: 0 },
    })
    const before = snapshot(sim)

    sim.step()
    sim.step()

    expect(snapshot(sim)).toEqual(before)
    expectFinite(sim)
  })
})

// ---------------------------------------------------------------------------
// 弹簧（"张力"这个旋钮）
// ---------------------------------------------------------------------------

describe('弹簧（张力）', () => {
  it('linkDistance 变大时，相连的两点确实更远（旋钮真的有效）', () => {
    const build = (linkDistance: number): ForceSimulation =>
      createForceSimulation({
        nodes: [seed('甲.md', -200, 0), seed('乙.md', 200, 0)],
        edges: [edge('甲.md', '乙.md')],
        params: { centerStrength: 0, repelStrength: 0, linkDistance, alphaDecay: 0.008 },
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
    }

    const sim = createForceSimulation({ nodes, edges, params: extreme })
    for (let index = 0; index < 5; index += 1) {
      sim.step()
      // 1e-9 是"按 speed 重标定速度"的浮点末位误差，不是给公式留的余量
      expect(maxSpeedOf(sim)).toBeLessThanOrEqual(12 + 1e-9)
    }

    const frozen = createForceSimulation({ nodes, edges, params: { ...extreme, maxSpeed: 0 } })
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
