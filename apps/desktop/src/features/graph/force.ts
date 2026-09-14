/**
 * 力导向**浮动态**：把同心环布局（`layout-ego.ts`）算出来的位置当**种子**，让卡片被张力牵着
 * 松弛一下 —— 相连的靠拢、重叠的让开、飞散的收回来。
 *
 * ## 一、与 ADR-0021 的关系（这一层最重要的约束）
 *
 * ADR-0021 决策 2 把"跳数 = 半径、坐标是数据的纯函数"定为纪律，并且**明确否掉**了力导向。
 * 这一层不是推翻那条决策，而是把它当成**种子**：
 *
 * - 环形布局仍然决定"谁在第几环、环内谁在谁旁边"，同一篇笔记每次打开的初始位置完全一样；
 * - 力导向只做**松弛**：弹簧把相连的两点拉紧、斥力让卡片不重叠、向心力防止孤岛飞散。
 *   它从不负责"谁离中心近" —— 那是 `hop` 与环半径的职责；
 * - 因此 `createForceSimulation` 的初始位置**必须**来自环形布局（`EgoCardBox.rect` 过一遍
 *   `centerOf`），本层刻意不提供第二种初始化方式；`settle()` 在同一份输入下确定性，
 *   "打开就落定"因此和环形布局一样可复现。
 *
 * 一句话：**环是事实，力是手感**。把力当成布局的来源，就回到了 ADR-0021 否掉的那条路
 * （每次打开都不一样、空间记忆失效）。
 *
 * 已知代价（如实写在这里，别让人以后以为白拿）：松弛之后"跳数 = 半径"不再被**严格**保证 ——
 * 斥力与弹簧可能让个别二跳节点挤进一环的缝里，而**默认参数会把两层环半径都收紧到种子的约三分之二**
 * （实测：6 邻居、一跳种子 562 → 377，二跳种子 1124 → 672，`settle()` 249 步）。
 * 也就是说"谁在内、谁在外"这个信息保住了，但"半径 = 布局算出来的那个数"不再成立。
 * 想尽量保住环半径，用「舒展」档（`linkDistance` 520、向心力 0.0035，实测一跳 493 ≈ 种子），
 * 或者干脆不启用本层。
 *
 * **被否掉的替代**：按 hop 把节点弹回各自的环半径（力场变成"环的橡皮筋"）。它确实能严格保住
 * 层次，但那等于把环形布局在力场里再算一遍：参数面板上要多暴露 5 个环半径，用户钉住一张卡片
 * 之后环会被拉成椭圆而参数却还是原样 —— 观感比"松弛"更假，代码也多一倍。
 *
 * ## 二、确定性（第二条纪律）
 *
 * 同一份 `nodes`（同顺序）、同一组 `params`、同一个 `seed`、同样的步数 ⇒ **逐字节相同**的位置。
 * 为此：
 *
 * 1. **不用 `Math.random()` / `Date.now()`**：抖动来自自带的 xorshift32，`seed` 定它；
 * 2. **遍历顺序固定**：斥力是 `for i { for j > i }`、弹簧按传入顺序、积分按节点下标 ——
 *    浮点加法不满足结合律，换个求和顺序结果就不再逐字节相同；
 * 3. **不用 `Math.hypot`**：它的精度是实现定义的（不同引擎/版本会给出不同末位），
 *    这里只用 `Math.sqrt(x*x + y*y)`（IEEE-754 要求 sqrt 正确舍入）；
 * 4. **不读环境**：没有时钟、没有 DPR、不依赖 `Map` 的隐式遍历顺序（只用它按 key 查）。
 *
 * ## 三、为什么是这三股力（以及为什么没有第四股）
 *
 * 缺任何一股都会有一个具体的坏结果：没有弹簧 ⇒ 相连的两点不比其他点更近，"关联"只剩线的形状；
 * 没有斥力 ⇒ 卡片叠在一起，而卡片上是完整 markdown 预览，叠一张就少读一篇；
 * 没有向心力 ⇒ 孤岛（没有任何边的节点）在斥力下只会越飘越远，最后飞出屏幕。
 *
 * **为什么没有"环半径弹簧"**：见上面被否掉的替代。
 * **为什么不上 Barnes-Hut**：ADR-0021 把子图上限钉在 300 节点，`O(n²)` 是 4.5 万对/步、
 * 单步不到 1ms，够用；而近似求和会把"按固定顺序累加"这条确定性依据换成"按树的分组顺序累加"，
 * 代码与参数都翻几倍，换来的常数优化在这里没有意义。
 * **为什么不用 d3-force**：硬约束是不加依赖之外，它自己的定时器与 `Math.random()` 与"每帧一步、
 * 结果可复现"直接冲突，`alphaMin` 的几何衰减也没法表达"永不降温"的持续漂浮。
 *
 * ## 四、不要碰的东西
 *
 * 世界 → 屏幕的换算在 `viewport.ts`（本层不参与），画笔只要"每张卡片左上角"（`positions()`）。
 * 本层不 import React、不碰 DOM、不读全局状态，因此全部性质都能在 vitest 里直接断言。
 */

import type { Point } from './layout'

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

/** 力导向模拟的参数（全部可调，且都进 ADR 的可调面板）。 */
export interface ForceParams {
  /** 向心力：把所有节点往原点（中心那张卡片）拉的强度。 */
  centerStrength: number
  /** 斥力：任意两节点之间的排斥强度（库仑式，按 1/距离² 衰减）。 */
  repelStrength: number
  /** 弹簧强度：有边相连的两点被拉向目标距离的强度。 */
  linkStrength: number
  /** 弹簧的自然长度（世界像素）——"张力"最直观的那个旋钮。 */
  linkDistance: number
  /** 阻尼（0..1，越小越"黏"，越大越晃）。 */
  damping: number
  /** 每步速度上限（世界像素/步），防止参数极端时炸开。 */
  maxSpeed: number
  /** 只对"几跳以内"的边施加弹簧力（Infinity = 全部边都算）。 */
  linkMaxHop: number
  /** 每步的强度衰减（alpha 从 1 衰减到 0 时停止；0 = 永不衰减，用于持续漂浮）。 */
  alphaDecay: number
}

/**
 * 默认参数。**基准**（下面每个数字的依据都落在这上面）：卡片 320×400（完整 markdown 预览的
 * 典型尺寸）、屏幕 1200×800、一跳环半径 ≈ 560px（`layout-ego.ts` 的弧长公式，6 个 320×400
 * 邻居时算出 562）。
 *
 * 三股力的**分工**是这套数字的全部依据：向心力只负责"别飞散"、弹簧负责"相连的两点该多远"、
 * 斥力负责"别重叠"。任何数值都不要读成"好看"，它们全都是"在这台屏幕上的观感"。
 *
 * - `centerStrength` 0.005：在 560px 处给出 ≈2.8 px/步²，与同一点上的弹簧（0.03 × 200 ≈ 6）、
 *   斥力（3.5/3 ≈ 1.2）同量级。**不能再小**：这个离散系统在 `damping · centerStrength / (1 − damping)`
 *   变小时会变成**过阻尼**的，慢特征值 ≈ 1 − damping·k/(1 − damping) —— k 掉到 0.002 时每一步只恢复
 *   1%，`alphaDecay` 给的那点步数预算根本走不完，"打开后一直在慢慢挪、还没落定就冻住了"。
 *   **不能再大**：环半径就由向心力决定而不是由布局决定，ADR-0021 的层次被抹平。
 * - `repelStrength` 3.5：q=1（两张 320×400 刚好相切）时 3.5 px/步²。它比弹簧弱、比向心力略弱，
 *   是刻意的排序：斥力只负责"别叠着"，不该决定整幅图有多大。
 * - `linkStrength` 0.03：比自然长度远 200px 时给出 6 px/步² 的回拉，是整套里最硬的力。
 *   弹簧必须最硬，否则"相连的应该更近"这个视觉承诺不成立。
 * - `linkDistance` 440：两张 320 宽的卡片中心距 320 时刚好相切，440 留出 120px（≈ 一条连线的
 *   长度）。为什么不取环半径 562：弹簧的职责是"让相连的两点看起来挨着"，不是复述环半径
 *   （那是布局的活）。实测（6 个 320×400 邻居、种子环半径 562）：落定后一环 ≈405px，
 *   也就是环被收紧到种子的 0.72 倍 —— 层次还在，但能看出"被张力拉过"。
 * - `damping` 0.84：每步速度乘 0.84。离散二阶系统的特征值模长 = √0.84 ≈ 0.917，
 *   即振幅每步衰减 8.3%，衰减到 1% 约 54 步。再大（0.9+）整幅图会明显"荡秋千"，
 *   再小（0.7-）则像在糖浆里（拖动后要等半天才落定）。
 * - `maxSpeed` 24：一张 320×400 卡片约 7.5% 的宽度/步。它是"参数填错时的安全阀"，
 *   不是手感旋钮 —— 斥力在 q 很小时会很大（有封底，最大 4×3.5 = 14 px/步²），
 *   但任何公式改动都不该让一张卡片一帧飞出屏幕。
 * - `linkMaxHop` Infinity：默认所有边都参与弹簧力。
 * - `alphaDecay` 0.005：alpha 每步减 0.005 ⇒ 200 步归零（60fps 下一帧一步 ≈ 3.3 秒后冻结；
 *   实测 6 邻居的一跳 ego 图 `settle()` 走 246 步 = 200 步降温 + 46 步把残余速度衰减到阈值）。
 *   为什么是线性而不是 d3 的几何衰减：线性让"步数 ↔ 进度"可以心算（第 N 步的力是 1 − 0.005N 倍），
 *   于是参数面板上 `alphaDecay` 有一个可解释的含义：**几步落定 = 1 / alphaDecay**。
 *   为什么给 200 步而不是 100 步：向心力的慢模式（≈0.98/步）要 ~200 步才收敛，
 *   预算短于它就会"冻在半路"（观感是每次打开都停在一个不太对劲的中间态）。
 *
 * `Object.freeze`：它是所有模拟共享的一份"同一组参数"，被谁就地改一个字段都会让别的模拟
 * （以及测试里"同一组参数"的前提）失去意义。
 */
export const DEFAULT_FORCE_PARAMS: ForceParams = Object.freeze({
  centerStrength: 0.005,
  repelStrength: 3.5,
  linkStrength: 0.03,
  linkDistance: 440,
  damping: 0.84,
  maxSpeed: 24,
  linkMaxHop: Number.POSITIVE_INFINITY,
  alphaDecay: 0.005,
})

// ---------------------------------------------------------------------------
// 常量（所有魔法数字只有一份）
// ---------------------------------------------------------------------------

/**
 * 归一化距离平方的**封底**：`m = repelStrength / q²` 在 q→0 时会发散，两个中心完全重合就会
 * 算出 Infinity（或 NaN）。
 *
 * 为什么是封底而不是"加一个极小值 ε"：ε 的写法会让力在 ε 处出现一个 1e12 量级的尖峰，
 * 观感是"重合的卡片像被弹弓打出去"；封到 q² ≥ 0.25（q ≥ 0.5，两张卡片叠了一半以上）
 * 之后最大力就是 4×repelStrength = 16 px/步²，比 `maxSpeed` 还小，既推得开又不会窜。
 */
const REPEL_MIN_Q2 = 0.25
/** 归一化距离平方小于它 ⇒ 两个中心几乎重合（差 < 0.01% 的卡片宽），力的方向无定义（梯度趋近 0）。 */
const DEGENERATE_Q2 = 1e-8
/** 两中心的世界距离小于它（像素）⇒ 弹簧方向无定义，跳过这条边（交给斥力分开）。 */
const DIRECTION_EPSILON = 1e-6
/** alpha 低于它就当作"已经冷了"（`settle` 的判据之一）。与 d3-force 的 alphaMin 同源。 */
const ALPHA_MIN = 0.001
/** 速度低于它（世界像素/步）就当作静止。没有它，`settle` 永远等不到"速度恰好是 0"那一步。 */
const SPEED_EPSILON = 1e-4
/** `settle()` 的默认步数上限：100 步冻结（alphaDecay 0.01）之后再留 5 倍余量给速度衰减。 */
const DEFAULT_SETTLE_STEPS = 600
/**
 * 抖动的默认种子。取哪个值不重要（xorshift32 把 0 当不动点，所以不能用 0），
 * 重要的是**它固定**：抖动因此是一条确定的序列，不是"每次打开都不一样的随机"。
 */
const DEFAULT_SEED = 0x9e3779b9

// ---------------------------------------------------------------------------
// 节点与边
// ---------------------------------------------------------------------------

export interface ForceNode {
  relPath: string
  /** 卡片**中心**的当前世界坐标（模拟在中心点上跑，卡片矩形由尺寸还原）。 */
  x: number
  y: number
  vx: number
  vy: number
  /** 与中心差几跳（0 = 中心那张）。 */
  hop: number
  /**
   * 卡片尺寸。斥力按"两个矩形不相交"的直觉按**半步长**算（见 `step` 里的公式与注释）：
   * 同样 400px 的中心距，"两张高卡竖直相切"与"两张宽卡还差 80px 才相切"是两回事。
   */
  width: number
  height: number
  /** 被钉住的节点（用户拖过 / 中心那张）：永不移动，但**仍然向外施加力**。 */
  fixed: boolean
}

export interface ForceEdge {
  from: string
  to: string
}

export interface ForceSimulation {
  /**
   * 当前节点（顺序与传入一致，位置是**中心点**）。
   *
   * 类型是 `readonly`：模拟内部要就地更新这对象（每帧新建 300 个对象纯属浪费），
   * 但调用方读到的是"某一帧的快照"，不该拿它当自己的数据结构改。
   */
  nodes: readonly ForceNode[]
  /** 当前强度（1 → 0 衰减；`params.alphaDecay === 0` 时恒为 1）。 */
  alpha: number
  /** 走一步（`dt` 默认 1）。返回是否"还在动"（alpha > 阈值 或 还有节点速度不为零）。 */
  step(dt?: number): boolean
  /** 直接跑到稳定（最多 `maxSteps` 步），返回实际步数。用于"打开就落定"的确定性路径。 */
  settle(maxSteps?: number): number
  /** 把某个节点钉在指定中心点（拖动时用），返回新的模拟状态（不可变风格也行）。 */
  pin(relPath: string, x: number, y: number): void
  /** 松开钉子（松手后它继续被力场接管）。 */
  unpin(relPath: string): void
  /** 每张卡片左上角的坐标（= 中心 − 尺寸/2），直接喂给画笔。 */
  positions(): Map<string, Point>
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 非有限的数值退到兜底值。**只拦 NaN / ±Infinity**：负值是"反过来的力"，仍然有界，不拦。 */
function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * xorshift32：自带、自足、跨平台逐位一致（只有异或与移位，不涉及浮点）。
 *
 * 为什么不用 `Math.random()`：它无法复现，而"换个 seed 就换个排布"恰恰是一个可以放进参数面板的
 * 特性。为什么不用 `Math.sin(n * 12.9898)` 那类"哈希式随机"：`Math.sin` 的精度是实现定义的，
 * 同一份输入在不同引擎上会给出不同的小数位，逐字节复现就没了。
 */
function createRandom(seed: number): () => number {
  // 0 是 xorshift 的不动点（异或移位后仍是 0），非有限值同理，两者都换成常量
  let state = Number.isFinite(seed) ? Math.floor(seed) >>> 0 : DEFAULT_SEED
  if (state === 0) state = DEFAULT_SEED
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 4294967296
  }
}

/** 补全 + 兜底。`linkMaxHop` 例外：`Infinity` 是有意义的取值（"所有边都算"）。 */
function resolveParams(overrides: Partial<ForceParams> | undefined): ForceParams {
  const base = DEFAULT_FORCE_PARAMS
  const raw = overrides ?? {}
  return {
    centerStrength: finite(raw.centerStrength ?? base.centerStrength, base.centerStrength),
    repelStrength: finite(raw.repelStrength ?? base.repelStrength, base.repelStrength),
    linkStrength: finite(raw.linkStrength ?? base.linkStrength, base.linkStrength),
    linkDistance: Math.max(0, finite(raw.linkDistance ?? base.linkDistance, base.linkDistance)),
    // damping 是"每步保留多少速度"：>1 等于每步注能，即使被 maxSpeed 兜住也更像 bug 而不是旋钮，
    // 所以按契约（0..1）夹紧。0 是最黏的一端：每一步都把速度清零，只肯挪"这一步的力"那么一点。
    damping: clamp01(finite(raw.damping ?? base.damping, base.damping)),
    maxSpeed: Math.max(0, finite(raw.maxSpeed ?? base.maxSpeed, base.maxSpeed)),
    linkMaxHop:
      raw.linkMaxHop === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : Math.max(0, finite(raw.linkMaxHop ?? base.linkMaxHop, base.linkMaxHop)),
    alphaDecay: Math.max(0, finite(raw.alphaDecay ?? base.alphaDecay, base.alphaDecay)),
  }
}

/** 边的下标对（字符串比较只在创建时做一次）。 */
interface ForceLink {
  a: number
  b: number
}

/**
 * 加速度累加器的读/写。
 *
 * 为什么要这两个小函数：`noUncheckedIndexedAccess` 对**类型化数组**的下标访问也照样给出
 * `number | undefined`（它看的是索引签名，不看"这是一个定长数组"），于是 `accel[i] += x`
 * 这种写法过不了类型检查。把 `?? 0` 收口在两处，比在每个力上都写一遍更不容易漏 ——
 * 而且这里的 `0` 是**正确**的初值（每步开头 `fill(0)`），不是掩盖问题的兜底。
 */
function readAt(values: Float64Array, index: number): number {
  return values[index] ?? 0
}

function addInto(values: Float64Array, index: number, delta: number): void {
  values[index] = (values[index] ?? 0) + delta
}

// ---------------------------------------------------------------------------
// 创建
// ---------------------------------------------------------------------------

/** 造一个模拟：初始位置来自 `seed`（通常是环形布局的中心点），速度全零。 */
export function createForceSimulation(input: {
  nodes: readonly {
    relPath: string
    x: number
    y: number
    width: number
    height: number
    hop: number
    fixed?: boolean
  }[]
  edges: readonly ForceEdge[]
  params?: Partial<ForceParams>
  /** 初始抖动幅度（世界像素）：0 = 完全按种子；>0 时用**确定性伪随机**（见下）撒开。 */
  jitter?: number
  seed?: number
}): ForceSimulation {
  const params = resolveParams(input.params)
  const jitter = Math.max(0, finite(input.jitter ?? 0, 0))

  // 位置与尺寸都**拷贝**一份：调用方（布局层）算出的结果还有别的用处，本层不就地改别人的对象。
  // 非有限值就地兜底：一粒 NaN 会顺着力场污染整幅图，而"某张卡片的尺寸没量出来"完全不该让模拟崩。
  const nodes: ForceNode[] = input.nodes.map((node) => ({
    relPath: node.relPath,
    x: finite(node.x, 0),
    y: finite(node.y, 0),
    vx: 0,
    vy: 0,
    hop: finite(node.hop, 0),
    // 宽高出现在斥力的分母上（rx = 两卡半步长之和），0 会让 q² 变成 0 或 NaN
    width: Math.max(1, finite(node.width, 1)),
    height: Math.max(1, finite(node.height, 1)),
    fixed: node.fixed === true,
  }))

  if (jitter > 0) {
    const random = createRandom(finite(input.seed ?? DEFAULT_SEED, DEFAULT_SEED))
    for (const node of nodes) {
      // 两次取样**固定**（先 x 后 y），并且先取样再判 fixed：抖动值与节点下标一一对应，
      // 因此"把中心那张钉住"不会改变其余节点的抖动序列（否则钉一个节点会重排整幅图）。
      const offsetX = (random() * 2 - 1) * jitter
      const offsetY = (random() * 2 - 1) * jitter
      if (node.fixed) continue // 被钉住的节点位置是"事实"，抖动不是
      node.x += offsetX
      node.y += offsetY
    }
  }

  // 路径 → 下标。重复路径只认第一个：否则同一条边会被算两遍，且 `positions()` 会覆盖自己。
  const indexByPath = new Map<string, number>()
  nodes.forEach((node, index) => {
    if (!indexByPath.has(node.relPath)) indexByPath.set(node.relPath, index)
  })

  const links: ForceLink[] = []
  for (const edge of input.edges) {
    const from = indexByPath.get(edge.from)
    const to = indexByPath.get(edge.to)
    if (from === undefined || to === undefined) continue // 悬空边：端点不在图上，没有力可算
    if (from === to) continue // 自环：斥力需要"另一个"节点，弹簧对自己也没有自然长度
    const a = nodes[from]
    const b = nodes[to]
    if (a === undefined || b === undefined) continue
    // 跳数筛选只做一次（参数在创建时就固定：本层没有"运行中改参数"，改参数 = 新建一个模拟）。
    // 两端都要在允许的圈内 —— 用 max 而不是 min：`linkMaxHop: 1` 想表达的是"只有中心与它
    // 直接邻居之间的弹簧"，若按 min 算，那条从二跳拉向一跳的边会被算成"一跳的边"，
    // 于是二跳会被整体吸进内圈，这个旋钮就名不副实了。
    if (a.hop > params.linkMaxHop || b.hop > params.linkMaxHop) continue
    links.push({ a: from, b: to })
  }

  // 定长加速度累加器：每步 `fill(0)` 复用同一块内存，不会每帧新建几百个对象。
  // ⚠️ `noUncheckedIndexedAccess` 对**类型化数组**也生效（它看索引签名，不看"这是定长数组"），
  // 所以读写都走上面对那两处 `readAt` / `addInto`，而不是直接 `accel[i] += …`。
  const count = nodes.length
  const accelX = new Float64Array(count)
  const accelY = new Float64Array(count)
  let alpha = 1

  function isMoving(): boolean {
    if (alpha > ALPHA_MIN) return true
    for (const node of nodes) {
      if (Math.sqrt(node.vx * node.vx + node.vy * node.vy) > SPEED_EPSILON) return true
    }
    return false
  }

  function step(dt = 1): boolean {
    // 非有限的 dt 当作"这一步不动"：Infinity 步长会立刻把坐标变成 Infinity，
    // 而 NaN 会静默污染整幅图（之后每一步都是 NaN，再也没有机会恢复）。
    const h = finite(dt, 0)
    // 力随 alpha 一起降温：alpha 是唯一的"总强度"旋钮，"还在动"的判据也挂在它上面。
    const heat = alpha

    accelX.fill(0)
    accelY.fill(0)

    // --- 斥力：所有节点对（严格 i < j，因此每对只算一次、求和顺序固定）----------------
    for (let i = 0; i < count; i += 1) {
      const a = nodes[i]
      if (a === undefined) continue
      for (let j = i + 1; j < count; j += 1) {
        const b = nodes[j]
        if (b === undefined) continue

        const dx = b.x - a.x
        const dy = b.y - a.y
        // 半步长之和 = 两个矩形在某个方向上"刚好相切"时的中心距。用**椭圆**而不是圆心连线度量：
        // 两张 320×400 的卡片，中心竖直相距 400 时已经相切，水平方向却还差 80px 才相切 ——
        // 纯圆心距离会把这两种情况当成"一样近"，于是高卡片之间总是推不开（这正是要避免的"叠着"）。
        const rx = (a.width + b.width) / 2
        const ry = (a.height + b.height) / 2
        const nx = dx / rx
        const ny = dy / ry
        const q2 = nx * nx + ny * ny
        // q = 1 就是相切，此时力正好等于 repelStrength；除以 q² 是库仑式衰减，只不过衰减用的是
        // 椭圆归一化的距离。封底见 REPEL_MIN_Q2：极限情况下力有限，不会被弹弓打出去。
        const magnitude = (params.repelStrength * heat) / Math.max(q2, REPEL_MIN_Q2)

        let ux: number
        let uy: number
        if (q2 < DEGENERATE_Q2) {
          // 两中心几乎重合 ⇒ 椭圆度量的梯度也趋近 0，方向无定义。用下标决定一个确定的**对角**方向：
          // 不用随机数（同一份输入必须给出同一个方向），也不用三角函数（精度是实现定义的）。
          ux = (i + j) % 2 === 0 ? Math.SQRT1_2 : -Math.SQRT1_2
          uy = (j + Math.floor(i / 2)) % 2 === 0 ? Math.SQRT1_2 : -Math.SQRT1_2
        } else {
          // 方向取椭圆度量的**梯度** (dx/rx², dy/ry²)，而不是两心连线：矩形不是圆，
          // 对一个又高又窄的邻居，"往左右让"比"往上下让"更省距离。
          const gx = dx / (rx * rx)
          const gy = dy / (ry * ry)
          const length = Math.sqrt(gx * gx + gy * gy)
          ux = gx / length
          uy = gy / length
        }

        // a 被 b 推开（沿 −u）、b 被 a 推开（沿 +u）：两边一样大（牛顿第三定律），
        // 所以固定节点也会用同一个力去推别人 —— 这正是"钉住的卡片仍然在把别人推开"。
        addInto(accelX, i, -ux * magnitude)
        addInto(accelY, i, -uy * magnitude)
        addInto(accelX, j, ux * magnitude)
        addInto(accelY, j, uy * magnitude)
      }
    }

    // --- 弹簧：只有两端都在 linkMaxHop 以内的边 --------------------------------------
    for (const link of links) {
      const a = nodes[link.a]
      const b = nodes[link.b]
      if (a === undefined || b === undefined) continue

      const dx = b.x - a.x
      const dy = b.y - a.y
      const distance = Math.sqrt(dx * dx + dy * dy)
      // 两点重合时方向无定义：交给斥力把它们分开，比"随便挑一个方向"更不容易出怪事。
      if (distance < DIRECTION_EPSILON) continue

      // 胡克定律：偏离自然长度多少，就给多少加速度（所以 linkStrength 的量纲是 1/步²）。
      // 太远（为正）⇒ a 被拉向 b（沿 +u）；太近（为负）⇒ 被推开（沿 −u）。
      const magnitude = params.linkStrength * heat * (distance - params.linkDistance)
      const ux = dx / distance
      const uy = dy / distance
      addInto(accelX, link.a, ux * magnitude)
      addInto(accelY, link.a, uy * magnitude)
      addInto(accelX, link.b, -ux * magnitude)
      addInto(accelY, link.b, -uy * magnitude)
    }

    // --- 向心力 + 积分 ---------------------------------------------------------------
    let maxVelocity = 0
    for (let i = 0; i < count; i += 1) {
      const node = nodes[i]
      if (node === undefined) continue
      if (node.fixed) {
        // 钉住 = 位置是事实。速度也清零：拖动是"瞬移"而不是"加速"，把它当速度用就是伪造动量。
        node.vx = 0
        node.vy = 0
        continue
      }

      const forceX = readAt(accelX, i) - node.x * params.centerStrength
      const forceY = readAt(accelY, i) - node.y * params.centerStrength
      // 半隐式欧拉：先按力更新速度（力随 alpha 降温），再按阻尼衰减，再限速，最后才走位置。
      let vx = (node.vx + forceX * heat * h) * params.damping
      let vy = (node.vy + forceY * heat * h) * params.damping
      const speed = Math.sqrt(vx * vx + vy * vy)
      // maxSpeed = 0 时这里给 vx = vy = 0（速度上限为零 ⇒ 谁都别动），且不会除零。
      if (speed > params.maxSpeed) {
        const scale = params.maxSpeed / speed
        vx *= scale
        vy *= scale
      }
      node.vx = vx
      node.vy = vy
      node.x += vx * h
      node.y += vy * h

      const moved = Math.sqrt(vx * vx + vy * vy)
      if (moved > maxVelocity) maxVelocity = moved
    }

    // alpha 按**步**衰减，不随 dt 缩放：它是"已经跑了多少步"的进度，而 dt 只是"这一步走多远"的
    // 旋钮。让 dt 影响降温速度，慢动作就会连"落定时间"也一起变，参数面板上的 1/alphaDecay 会失准。
    if (params.alphaDecay > 0) alpha = Math.max(0, alpha - params.alphaDecay)

    return alpha > ALPHA_MIN || maxVelocity > SPEED_EPSILON
  }

  function settle(maxSteps = DEFAULT_SETTLE_STEPS): number {
    const limit = Math.max(0, Math.floor(finite(maxSteps, 0)))
    let steps = 0
    // 先判"还在动"再走步：已经落定的模拟因此立刻返回 0，位置一点不动（"再 settle 一次是 0 步"
    // 这条性质就挂在这个顺序上）。反过来写成 do/while 的话，第二次调用总会白走一步。
    while (steps < limit && isMoving()) {
      step()
      steps += 1
    }
    return steps
  }

  function pin(relPath: string, x: number, y: number): void {
    const index = indexByPath.get(relPath)
    if (index === undefined) return // 拖动的可能是一张已经不在图上的卡片：静默忽略，不抛
    const node = nodes[index]
    if (node === undefined) return
    node.x = finite(x, node.x)
    node.y = finite(y, node.y)
    node.vx = 0
    node.vy = 0
    node.fixed = true
  }

  function unpin(relPath: string): void {
    const index = indexByPath.get(relPath)
    if (index === undefined) return
    const node = nodes[index]
    if (node === undefined) return
    node.fixed = false
    // 归零速度：pin 期间的速度一直是 0，这里显式写一次是为了"松手 = 干净的起点"不依赖 pin 的实现
    node.vx = 0
    node.vy = 0
  }

  function positions(): Map<string, Point> {
    // 每次新建 Map 与新对象：调用方拿到的是某一帧的快照，改它（或把它缓存起来画上一帧）
    // 都不该影响模拟内部的状态。
    const result = new Map<string, Point>()
    for (const node of nodes) {
      result.set(node.relPath, {
        x: node.x - node.width / 2,
        y: node.y - node.height / 2,
      })
    }
    return result
  }

  return {
    get nodes(): readonly ForceNode[] {
      return nodes
    },
    get alpha(): number {
      return alpha
    },
    step,
    settle,
    pin,
    unpin,
    positions,
  }
}
