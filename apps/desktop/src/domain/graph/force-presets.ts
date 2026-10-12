/**
 * 力导向浮动态的**预设**（HUD / 参数面板上点一下就是一套数字）。
 *
 * 为什么要有预设，而不是只给一组默认值：这 8 个参数互相牵制 —— `repelStrength` 与
 * `linkDistance` 一起决定环被撑到多宽、`damping` 与 `alphaDecay` 一起决定"多久落定"，
 * 逐个调很容易调出"卡片全叠在中心"或"整幅图在抖"这两种谁都不想要的中间态。
 * 预设提供的是"从一条已知的观感出发再微调"。
 *
 * **数值依据**（与 `force.ts` 的 `DEFAULT_FORCE_PARAMS` 同一套基准）：卡片 320×400
 * （完整 markdown 预览的典型尺寸）、屏幕 1200×800、一跳环半径 ≈ 560px
 * （`layout-ego.ts` 的弧长公式在 6 个邻居时算出 562）。每个预设下面写了它为什么这么填。
 *
 * 预设只描述 `ForceParams`。"抖动"（`jitter`）不在参数里 —— 它只在 `createForceSimulation`
 * 创建那一刻有意义（模拟一旦跑起来，改抖动没有可解释的语义），所以它不进预设；
 * 想要"一进来就稍稍错开一点"的观感，在创建时给 `jitter`（见「漂浮」档的注释）。
 */

import { DEFAULT_FORCE_PARAMS, type ForceParams } from './force'

export interface ForcePreset {
  id: string
  label: string
  hint: string
  params: ForceParams
}

/** 冻结一份参数：预设是"共享的一组数字"，被谁就地改一个字段都会让别的调用点跟着变。 */
function frozen(params: ForceParams): ForceParams {
  return Object.freeze(params)
}

/**
 * 均衡（= 默认档）。
 *
 * 依据：与 `DEFAULT_FORCE_PARAMS` 逐字相同（两处共用同一个常量，避免"面板上的默认"与
 * "不传参数时的默认"漂成两个东西）。实测（6 个 320×400 邻居、一跳种子半径 562、二跳种子半径
 * 1124、`settle()` 274 步、**相交对 0**）：落定后一跳 ≈392、二跳 ≈692。
 * ⚠️ 与"加碰撞之前"的数字（377 / 672、249 步）比，环**变大**了：过去那点收紧有一半是
 * "让卡片叠着"换来的，现在卡片不许重叠，环只能停在几何上放得下的那个半径上。
 */
const BALANCED: ForcePreset = {
  id: 'balanced',
  label: '均衡',
  hint: '默认档：三股力都在中等强度，既不塌掉环的层次、也不让卡片叠着；拿不定主意时先用它。',
  params: DEFAULT_FORCE_PARAMS,
}

/**
 * 紧凑。
 *
 * 依据：`linkDistance` 220 ≈ 卡片宽 320 的三分之二 —— 中心距小于一张卡片宽时，两张卡片在视觉上
 * 就是"挨着"，这正是"紧凑"要看的东西；`linkStrength` 0.09 是默认的三倍，否则压不住同时被加大的
 * 斥力（弹簧必须是最硬的力）；`repelStrength` 5 比默认大，因为压缩之后卡片间的归一化距离 q 变小，
 * 斥力要在更近的距离上仍然够硬才不会叠；`centerStrength` 0.008 与 `alphaDecay` 0.014（约 70 步
 * 落定）—— 压缩是有向的位移，向心力太小会"压到一半就冻住"，而 k = 0.008 配 70 步刚好收敛
 * （慢特征值 0.951^70 ≈ 0.03）。
 *
 * 实测（两环 ego、种子 562 / 1124）：一跳 ≈394、二跳 ≈689、162 步、相交对 0。
 * ⚠️ **一个必须说清楚的发现**：加了碰撞约束之后，这一档的"更紧"在几何上**饱和**了 ——
 * 过去它能把一跳压到 307，靠的是让卡片互相叠着；现在卡片不许重叠，环的半径就由"320×400 的
 * 卡片在这个圈里最少要占多大"决定（≈392），于是它与「均衡」的落定半径几乎一样（394 vs 392）。
 * 它现在真正的差别是**过程**：弹簧最硬、降温最快，162 步（均衡要 274 步）就收拢归位；
 * 而且在稀疏图上（没有挤压压力时）它确实会把相连的两点拉得更近。
 * 想要更"紧"的观感只能靠布局层（卡片尺寸 / 环半径），那不是力场这一层能给的
 * —— 见 `force.ts` 里"碰撞是约束，不是第四股力"那一节。
 */
const COMPACT: ForcePreset = {
  id: 'compact',
  label: '紧凑',
  hint: '邻居很多、环上已经挨在一起时用它：把卡片压到"刚好不重叠"的极限，并且最快收拢归位（实测 162 步 vs 均衡 274 步）。',
  params: frozen({
    centerStrength: 0.008,
    repelStrength: 5,
    linkStrength: 0.09,
    linkDistance: 220,
    damping: 0.86,
    maxSpeed: 26,
    linkMaxHop: Number.POSITIVE_INFINITY,
    alphaDecay: 0.014,
    // 碰撞必须**最硬**：这一档把卡片压缩到彼此不到一张卡片宽，弹簧在持续把相连接的两点往里挤，
    // 只有硬约束（strength 1）才挡得住；轮数取满 4，因为"挤成一片"正是最需要多轮的场景。
    collideStrength: 1,
    collideIterations: 4,
  }),
}

/**
 * 舒展。
 *
 * 依据：`linkDistance` 520 略小于种子环半径 562 —— 一环基本停在布局给出的位置上（不再被弹簧
 * 往内拉），而种子里只有 100~300px 的二跳边会被推到 520，二跳因此被明确推到外圈；
 * `repelStrength` 6 让不相连的卡片也被撑开；`centerStrength` 0.0035 只有默认的七成，
 * 因为这一档要的是"散开"，向心力只需兜住孤岛（完全没有边的节点）。
 * 实测（两环 ego、种子 562 / 1124、261 步、相交对 0）：一跳 ≈494（基本停在种子附近）、
 * 二跳 ≈928 —— 一环几乎没被拉动，二跳被弹簧明确推到了外圈。加了碰撞之后这一档**几乎没变**
 * （过去是 493 / 928）：它本来就没有挤压，碰撞没有可解的重叠。
 */
const SPACIOUS: ForcePreset = {
  id: 'spacious',
  label: '舒展',
  hint: '一跳只有三五个邻居、想看清每条连线从哪到哪时用它：卡片之间留出约一条连线的宽度。',
  params: frozen({
    centerStrength: 0.0035,
    repelStrength: 6,
    linkStrength: 0.045,
    linkDistance: 520,
    damping: 0.84,
    maxSpeed: 30,
    linkMaxHop: Number.POSITIVE_INFINITY,
    alphaDecay: 0.005,
    // 这一档的卡片本来就离得远（斥力 6 + 自然长度 520），重叠是**偶发**的（拖动、换深度时擦一下），
    // 因此不需要硬约束的"瞬间弹开"：0.8 既能在几步之内把偶发的重叠压掉，又不会在拖动时把卡片
    // 从用户手上"弹"一下。轮数 2 够用（没有稳定挤压，就不需要多轮反复解）。
    collideStrength: 0.8,
    collideIterations: 2,
  }),
}

/**
 * 漂浮。
 *
 * 依据：`alphaDecay` 0 是这一档的定义 —— 力场**永不降温**，因此拖动、钉住、换深度之后它不会
 * 立刻"冻住"，张力会顺着边一路传下去；`damping` 0.93（每步只损失 7% 速度，接近无阻尼）让这股
 * 波动传得远、看得见；`maxSpeed` 10 只有卡片宽的 3%/步，慢到不打断阅读。
 *
 * 诚实说明：`alphaDecay: 0` 保证的是"不会冻结"，不是"永远在动" —— 有阻尼的力场最终会停在
 * 受力平衡处（那时速度自然衰减到 0），这是物理，不是缺陷。想要一进来就"活"着，在创建模拟时给
 * 一点抖动：`createForceSimulation({ ..., jitter: 12, seed: 1 })`（12 ≈ 卡片宽的 4%，
 * 已经看得出错落，又不会让"跳数 = 半径"的层次模糊）。抖动不进 `ForceParams`：它只在创建那一刻
 * 有意义，模拟跑起来之后"改抖动"没有可解释的语义。
 * 实测（两环 ego、种子 562 / 1124）：一跳 ≈495、二跳 ≈925，且 600 步仍不见停
 * （`settle(600)` 跑满上限 —— 这一档本来就是"不落定"）；这条真实输入上只剩 6 处相交、
 * 最深 0.07px（远小于一个像素，等于没有）。
 * **唯一的例外，如实说**：13 张卡片挤成一团这种极端输入下，这一档会留下约 15px 的稳态重叠 ——
 * 因为它的力**永不降温**，弹簧每步把卡片挤进来多少，软约束就补回去多少（见 `force.ts` 的
 * `collidePass`）。默认档与其余各档在这种输入上都是 0。
 */
const FLOATING: ForcePreset = {
  id: 'floating',
  label: '漂浮',
  hint: '当"活的"背景挂着、或一边读一边看卡片慢慢让位时用它：力场永不降温，但速度压得很低，动作像在水里。（代价：力一直在挤，密集时可能留下极小重叠 —— 真实数据上实测 0.07 像素，肉眼不可见；要严格零重叠就换「均衡」档）',
  params: frozen({
    centerStrength: 0.0025,
    repelStrength: 3.5,
    linkStrength: 0.03,
    linkDistance: 320,
    damping: 0.93,
    maxSpeed: 10,
    linkMaxHop: Number.POSITIVE_INFINITY,
    alphaDecay: 0,
    // 最软的一档：速度上限只有 10 px/步，硬约束的"瞬移式"位置修正会看起来像跳帧。
    // 实测（13 张卡片挤成一圈的密集输入）定了这两个数：0.75/2 会留下 27.9px 的稳态重叠
    // （看得见），0.85/3 降到 14.7px（每步解决 99.7%），再往上加就与硬约束没有区别了。
    collideStrength: 0.85,
    collideIterations: 3,
  }),
}

/**
 * 聚焦。
 *
 * 依据：`linkMaxHop` 1 —— 只有"中心 ↔ 一跳"之间的弹簧在工作（判据是**两端都在圈内**，
 * 用 max 而不是 min；否则那条从二跳拉向一跳的边会被算成"一跳的边"，二跳会被整体吸进内圈）；
 * `centerStrength` 0.008 是默认的 1.6 倍：二跳没有弹簧兜着，全靠向心力，弱了它们会慢慢飘出屏幕；
 * `linkDistance` 300 小于相切距离 320，让内圈收紧成"中心 + 一圈清晰的直接邻居"。
 * 实测（两环 ego、种子 562 / 1124、169 步、相交对 0）：一跳 ≈385、二跳 ≈669 —— 二跳因为不再有
 * 弹簧，只受斥力与向心力，摊在外圈当背景。⚠️ 与加碰撞之前的 315 / 595 比，内圈**变大了**：
 * `linkDistance: 300` 比卡片自身（320×400）还窄，那个"300"现在被碰撞约束挡住了 ——
 * 弹簧可以要求一个放不下的距离，几何不答应（同样的事也发生在「紧凑」档）。
 */
const FOCUS: ForcePreset = {
  id: 'focus',
  label: '聚焦',
  hint: '只关心"中心这篇直接连着谁"时用它：只有中心与一跳之间有弹簧，二跳以外摊平成安静的一圈背景。',
  params: frozen({
    centerStrength: 0.008,
    repelStrength: 4,
    linkStrength: 0.07,
    linkDistance: 300,
    damping: 0.85,
    maxSpeed: 22,
    linkMaxHop: 1,
    alphaDecay: 0.012,
    // 内圈被 `linkDistance: 300` 收得比卡片自身还窄（300 < 320），弹簧会一直把一跳邻居往中心
    // 挤 —— 这里必须是硬约束，否则"聚焦"的结果就是中心那张卡片被一圈卡片压住。
    collideStrength: 1,
    collideIterations: 3,
  }),
}

export const FORCE_PRESETS: readonly ForcePreset[] = Object.freeze([
  BALANCED,
  COMPACT,
  SPACIOUS,
  FLOATING,
  FOCUS,
])

/**
 * 按 id 取预设。
 *
 * 未知 id 退到**均衡**（而不是返回 `null`）：调用点是从 `localStorage` 里读回一个 id 的
 * （用户可能装过一版有「阅读」档、后来被删掉的版本），那里拿到一组可用的参数，比拿到 null
 * 再写一遍兜底判断更实在。签名里也就不用出现 `| null`，调用点不必为空值写分支。
 */
export function forcePreset(id: string): ForcePreset {
  return FORCE_PRESETS.find((preset) => preset.id === id) ?? BALANCED
}
