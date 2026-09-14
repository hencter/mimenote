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
 * 斥力与弹簧可能让个别二跳节点挤进一环的缝里，而**默认参数会把两层环半径都收到种子的七成上下**
 * （实测：6 邻居、一跳种子 562 → 392、二跳种子 1124 → 692，`settle()` 274 步、零相交）。
 * 也就是说"谁在内、谁在外"这个信息保住了，但"半径 = 布局算出来的那个数"不再成立。
 * 想尽量保住环半径，用「舒展」档（`linkDistance` 520、向心力 0.0035，实测一跳 494 ≈ 种子），
 * 或者干脆不启用本层。
 *
 * ⚠️ 加了碰撞约束（第四节）之后这条代价有了一个"地板"：环半径**不可能**小于"这一圈的卡片
 * 按 320×400 摆开所需的空间"，所以"把环压得更紧"这件事在力场这一层已经到头了
 * （实测：「紧凑」与「均衡」的落定半径几乎一样，394 vs 392）。要更紧只能改布局层的卡片尺寸/环半径。
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
 * ## 四、碰撞是**约束**，不是第四股力
 *
 * 斥力只是"倾向"：它是力，会被阻尼、弹簧、向心力一起拉扯，参数一极端（节点多、向心力大、
 * 或 `repelStrength` 被调小）就会出现真的叠在一起的卡片 —— 那是看得见的错误，不是风格。
 * 所以碰撞做成**位置层面的约束**：每一步（积分之后）把相交的矩形沿最小平移向量分开，
 * `collideStrength: 1` + 多轮时静止就能保证零重叠（测试里用矩形判据钉住）。
 *
 * 被否掉的替代：**只把斥力调大**（它永远只是趋势，而且为了在密集处也推得开，得把强度提到
 * 在稀疏处"像爆炸"的量级）；**把碰撞做成速度冲量**（力与冲量混在一起、与阻尼打架，
 * 而且我们只要"不重叠"这个几何事实，不需要把它变成动量）；**用圆近似卡片**
 * （320×400 的对角线是 512，圆会把上下两排之间撑出一条一眼可见的空缝）。
 *
 * ## 五、不要碰的东西
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
  /**
   * 碰撞约束的强度（0..1）：**每一步之后**把重叠的卡片沿最小平移向量推开的比例。
   *
   * `1` = 硬约束（一轮就把这一对完全分开，因此静止时可以保证零重叠）；`0` = 关掉碰撞
   * （回到"只有斥力、只是倾向于不重叠"的老行为，供对照与测试）；中间值是"每轮只解决这么多
   * 比例" —— 软一些、不会在密集处抖，代价是**允许一点点稳态重叠**（见 `collidePass` 的注释）。
   */
  collideStrength: number
  /** 每次 `step()` 之后跑几轮解重叠（1..4 的整数）：一轮在密集处可能推不开（A 推开 B 又把 B 推进 C）。 */
  collideIterations: number
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
 * - `collideStrength` 1（硬约束）：用户的反馈是"笔记之间应该有碰撞"，而**斥力只是倾向**——
 *   节点一多、向心力一大、或者 `repelStrength` 被调小，卡片就会真的叠在一起，那是看得见的错误。
 *   硬约束换来一条可以断言的保证：`settle()` 之后零重叠（测试里用矩形判据钉住）。
 *   为什么不取 0.5 之类的软值：软值只把重叠按比例压小，稳态残余重叠 ≈ 每步被推进来的距离 /
 *   (1 − (1 − strength)^轮数)；密集处仍然看得见叠着的一条边，等于没解决用户的抱怨。
 * - `collideIterations` 3：**为什么不是 1**：一轮是顺序处理的（`i < j` 逐对），把 A 从 B 身上
 *   推开之后，后续更靠后的那一对可能又把 A 挤回去 —— 密集处一轮推不干净（实测：12 张卡片挤在
 *   原点附近时，1 轮之后还剩明显残余，3 轮基本干净）。
 *   **为什么不是 4**：每加一轮都是又一遍 O(n²)（300 节点 = 4.5 万对），而第 4 轮能修掉的只是
 *   前 3 轮剩下的极小残余 —— 收益递减而代价线性增长。上限就钉在 4：再多轮数在面板上也没人会用，
 *   而"极端密集"该用「紧凑」档（硬 + 4 轮）而不是把默认值调钝。
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
  collideStrength: 1,
  collideIterations: 3,
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
/**
 * 碰撞求解的轮数上限。
 *
 * 为什么有上限（而不是"一直迭代到没有重叠"）：每一轮都是一遍 O(n²)，而 300 节点已经是
 * 4.5 万对/步；"迭代到干净"在极端密集时可能要走几十轮，把每一帧的成本变成不可预期的东西。
 * 4 轮是"实测量级上足够干净"与"每步成本可控"之间的取舍；真到推不开的密度，用户该调的是
 * 预设（`compact`）而不是指望这个上限自己长大。
 */
const MAX_COLLIDE_ITERATIONS = 4
/**
 * 碰撞分离时多推的那一点"皮"（世界像素）：1e-6。
 *
 * **为什么必须有它**（这是实测出来的，不是理论洁癖）：只推到"刚好相切"时，任何一次后续修正带来
 * 的浮点噪声（量级 ≈ eps × 坐标 ≈ 1e-12）都能把这一对**翻回相交**，于是"某一轮什么都没动"
 * ——也就是"零重叠"的那条证据——永远不可达：`settle()` 会一直跑到步数上限，最后留下几处
 * 1e-9 px 级的相交。实测（13 张卡片挤在半径 80 的一圈里）：没有这一微米时落定后仍有 3~8 处相交，
 * 加上之后归零，而且 `settle()` 也提前停下来了。
 *
 * **为什么是 1e-6 而不是 0.01 那种"看得见的缝"**：它只用来消除浮点噪声。一微米在任何缩放下
 * 都比一个像素小九个数量级，既看不见，也不会让相邻卡片看起来"没挨着"。
 */
const COLLIDE_SLOP = 1e-6
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
  /**
   * 走一步（`dt` 默认 1）。返回是否"还在动"：alpha 还没冷、还有节点的速度不为零、
   * 或者碰撞求解这一步还在挪卡片（位置修正也是"动"）。
   */
  step(dt?: number): boolean
  /**
   * 直接跑到稳定（最多 `maxSteps` 步），返回实际步数。用于"打开就落定"的确定性路径。
   *
   * "稳定"的定义是三个条件都满足：力已经冷（alpha = 0）、速度都衰减到阈值以下、
   * **碰撞求解有一整轮什么都没动**。最后一条不是凑数的：它同时证明了当前状态零重叠
   * （见 `collidePass`），于是"`settle()` 之后不重叠"是一个被证明的结论而不是运气。
   */
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
    collideStrength: clamp01(finite(raw.collideStrength ?? base.collideStrength, base.collideStrength)),
    // 轮数按契约（1..4 的整数）夹紧：**关掉碰撞只有 `collideStrength: 0` 一条路**，
    // 不让轮数也能"关"（两个旋钮都能开/关同一件事时，面板上的状态就说不清了）。
    collideIterations: clampIterations(
      finite(raw.collideIterations ?? base.collideIterations, base.collideIterations),
    ),
  }
}

/** 轮数夹到 1..4 的整数：小数四舍五入（0.5 轮没有意义），超界夹紧，非有限值已经被 `finite` 兜过。 */
function clampIterations(value: number): number {
  return Math.min(MAX_COLLIDE_ITERATIONS, Math.max(1, Math.round(value)))
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
  /**
   * 最近一步里碰撞求解**最后一轮**的最大位置修正量（世界像素）。
   *
   * 为什么要记住它：位置修正不改变速度，所以"速度衰减到阈值"不足以说明模拟停了 —— 约束还在
   * 挪卡片时也得算"还在动"。返回 0 还有更强的含义：**那一轮没有动过任何一个节点**，
   * 于是"没有任何一对相交"是被证明的，而不是"看起来差不多"（见 `collidePass`）。
   */
  let lastCorrection = 0

  /**
   * 一轮碰撞求解：把所有相交的矩形对沿**最小平移向量**（MTV）分开。
   *
   * ## 为什么要有这一步（而不是只把斥力调大）
   *
   * 斥力是"倾向"：它是力，被阻尼、弹簧、向心力一起拉扯，参数一极端（节点多、`centerStrength`
   * 大、或 `repelStrength` 调小）就会出现真的叠着的卡片。用户要的是"笔记之间应该有碰撞"——
   * 那是一个**几何事实**，不是趋势。约束（每一步之后直接解重叠）才能给出可断言的不变量：
   * 静止时零重叠。
   *
   * ## MTV 的两个取舍
   *
   * 1. **轴对齐矩形，不是圆**：卡片在世界坐标里就是轴对齐矩形（`width × height`），用圆近似
   *    会凭空在上下两排之间留出一条对角线级的缝（320×400 的对角线是 512）。
   * 2. **取重叠量较小的那一轴**：这就是"最小平移向量"的定义 —— 沿它推开所走的距离最短，
   *    因此对布局的扰动最小。两轴相等时取 y（代码里是 `overlapX < overlapY ? x : y`），
   *    与"哪个看起来更自然"无关，只是要一个确定的选择。
   *
   * ## 分配修正量与确定性
   *
   * 两边都可动就各推一半；有一侧被钉住（`fixed`）就把它那一半让给对面（钉住 = 位置是事实）；
   * 两侧都钉住直接跳过。遍历严格按 `i < j`、每轮重新遍历：浮点加法不满足结合律，
   * 换一个遍历顺序就会得到另一份坐标，"同一份输入逐字节相同"这条纪律就没了。
   *
   * ## 软约束（`strength < 1`）的代价（如实说）
   *
   * `strength` 是每轮实际推开的比例。软值并不会"最终也完全分开"：只要还有力把卡片往里挤，
   * 就会停在一个**稳态残余重叠**上（≈ 每步被推进来的距离 / (1 − (1 − strength)^轮数)）。
   * 这是刻意的取舍 —— 软一点的观感更"顺"，而"必须有碰撞"的要求由默认值 1（硬约束）满足。
   *
   * @returns 这一轮里单个节点被挪动的最大距离（0 = 这一轮什么都没动 ⇒ 当前状态零重叠）。
   */
  function collidePass(strength: number): number {
    let maxCorrection = 0
    for (let i = 0; i < count; i += 1) {
      const a = nodes[i]
      if (a === undefined) continue
      for (let j = i + 1; j < count; j += 1) {
        const b = nodes[j]
        if (b === undefined) continue
        if (a.fixed && b.fixed) continue // 两张都钉住：谁也不能动，这一对只能留着（诚实地留着）

        const dx = b.x - a.x
        const dy = b.y - a.y
        // 轴对齐矩形的相交判据，与 `layout.ts` 的 `rectsIntersect` 同一口径：贴边（重叠量恰为 0）
        // 不算相交，因此判据是"重叠量 ≤ 0"。下面推的时候会多带一微米的皮（`COLLIDE_SLOP`），
        // 于是刚分开的一对不会被邻居的浮点噪声翻回相交。
        const overlapX = (a.width + b.width) / 2 - Math.abs(dx)
        if (overlapX <= 0) continue
        const overlapY = (a.height + b.height) / 2 - Math.abs(dy)
        if (overlapY <= 0) continue

        const alongX = overlapX < overlapY
        // 先留出一微米的"皮"（COLLIDE_SLOP）再按强度解决：`strength = 1` 时这一对是**完全分开**
        // 且带一点余量，浮点噪声就再也翻不动"相交/不相交"这个符号了。
        const total = ((alongX ? overlapX : overlapY) + COLLIDE_SLOP) * strength
        if (!(total > 0)) continue // strength = 0 或算出了 0：这一对不需要动
        const half = a.fixed || b.fixed ? total : total / 2
        const shareA = a.fixed ? 0 : half
        const shareB = b.fixed ? 0 : half

        // 方向：从 a 指向 b。两心在该轴上的坐标恰好相等时（dx = 0 / dy = 0）取 + 方向 ——
        // 那时方向在几何上无意义，但**必须确定**（不许用随机数，也不许"跳过不管"，
        // 跳过会让完全重合的卡片永远叠着）。
        if (alongX) {
          const sign = dx >= 0 ? 1 : -1
          a.x -= sign * shareA
          b.x += sign * shareB
        } else {
          const sign = dy >= 0 ? 1 : -1
          a.y -= sign * shareA
          b.y += sign * shareB
        }
        if (shareA > maxCorrection) maxCorrection = shareA
        if (shareB > maxCorrection) maxCorrection = shareB
      }
    }
    return maxCorrection
  }

  function isMoving(): boolean {
    if (alpha > ALPHA_MIN) return true
    // 位置修正也是"动"：约束还在挪卡片时，`settle` 不该说"已经落定"。
    if (lastCorrection > 0) return true
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

    // --- 碰撞约束：轴对齐矩形不许相交（在**积分之后**修位置，力的顺序不受影响）-------------
    //
    // 为什么放在积分之后：碰撞改的是位置而不是力，摆在力之后就等于"力算完了，再把不合法的位置
    // 挪回合法的位置"，这与"约束"的语义一致（约束不该反过来改变力的大小）。
    // 为什么 dt = 0 时整段跳过：dt = 0 的语义是"这一步什么都不发生"（可以用它当暂停），
    // 位置修正也是这一步的结果，跳过它才自洽 —— 注意这与 `maxSpeed: 0` 不同：后者只是"速度上限
    // 为零"，约束照样会把叠着的卡片分开（那是几何事实，不是速度）。别把两者当成同一个开关。
    lastCorrection = 0
    if (h !== 0 && params.collideStrength > 0) {
      for (let pass = 0; pass < params.collideIterations; pass += 1) {
        lastCorrection = collidePass(params.collideStrength)
        // 某一轮什么都没动 ⇒ 当前状态已经零重叠（`collidePass` 没改过任何坐标），
        // 后面几轮是纯浪费，提前结束。这条也是"多轮会收敛"的实证入口。
        if (lastCorrection <= 0) break
      }
    }

    // alpha 按**步**衰减，不随 dt 缩放：它是"已经跑了多少步"的进度，而 dt 只是"这一步走多远"的
    // 旋钮。让 dt 影响降温速度，慢动作就会连"落定时间"也一起变，参数面板上的 1/alphaDecay 会失准。
    if (params.alphaDecay > 0) alpha = Math.max(0, alpha - params.alphaDecay)

    return alpha > ALPHA_MIN || maxVelocity > SPEED_EPSILON || lastCorrection > 0
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
