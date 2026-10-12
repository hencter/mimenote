/**
 * 力导向浮动态 —— **参数域与全部魔法数字**（不 import React / 不碰 DOM / 不读全局状态）。
 *
 * 一句话职责：每个旋钮的范围/步长/展示精度，以及每个物理常量的取值依据 + 参数归一化。
 *
 * 为什么从 `force.ts` 里切出来：这一层回答的是"每个数字为什么是这个值"，与
 * "力怎么算、位置怎么积分"是两个可以分开审查的问题 —— 而 `force.ts` 单文件 777 行，
 * 既看不清边界也过不了新文件的 600 行上限。切法只有一条约束：`DEFAULT_FORCE_PARAMS`
 * 是所有模拟共享的同一份参数，因此它必须仍然只有一份，`force.ts` 只引用、不重写。
 *
 * 参数归一化（`resolveParams`）也住在这里：夹范围、兜底非有限值、以及"哪些字段可以缺省"
 * 全都是参数域的事 —— 模拟层拿到的一定是**已经归一化**的一份，不必自己再判一次。
 */

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
export const REPEL_MIN_Q2 = 0.25
/** 归一化距离平方小于它 ⇒ 两个中心几乎重合（差 < 0.01% 的卡片宽），力的方向无定义（梯度趋近 0）。 */
export const DEGENERATE_Q2 = 1e-8
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
export const COLLIDE_SLOP = 1e-6
/** 两中心的世界距离小于它（像素）⇒ 弹簧方向无定义，跳过这条边（交给斥力分开）。 */
export const DIRECTION_EPSILON = 1e-6
/** alpha 低于它就当作"已经冷了"（`settle` 的判据之一）。与 d3-force 的 alphaMin 同源。 */
export const ALPHA_MIN = 0.001
/** 速度低于它（世界像素/步）就当作静止。没有它，`settle` 永远等不到"速度恰好是 0"那一步。 */
export const SPEED_EPSILON = 1e-4
/** `settle()` 的默认步数上限：100 步冻结（alphaDecay 0.01）之后再留 5 倍余量给速度衰减。 */
export const DEFAULT_SETTLE_STEPS = 600
/**
 * 抖动的默认种子。取哪个值不重要（xorshift32 把 0 当不动点，所以不能用 0），
 * 重要的是**它固定**：抖动因此是一条确定的序列，不是"每次打开都不一样的随机"。
 */
export const DEFAULT_SEED = 0x9e3779b9

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 非有限的数值退到兜底值。**只拦 NaN / ±Infinity**：负值是"反过来的力"，仍然有界，不拦。 */
export function finite(value: number, fallback: number): number {
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
export function createRandom(seed: number): () => number {
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
export function resolveParams(overrides: Partial<ForceParams> | undefined): ForceParams {
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
