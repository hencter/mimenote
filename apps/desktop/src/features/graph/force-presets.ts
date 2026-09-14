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
 * "不传参数时的默认"漂成两个东西）。实测（6 个 320×400 邻居、种子环半径 562、`settle()` 249 步）：落定后**一跳 ≈377、二跳 ≈672** —— 两层都收紧了约三成，但"谁在内、谁在外"的层次一点没变。
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
 * （慢特征值 0.951^70 ≈ 0.03）。实测（两环 ego、种子 562 / 1124）：一跳 ≈307、二跳 ≈563，
 * 比均衡档再紧约两成。
 */
const COMPACT: ForcePreset = {
  id: 'compact',
  label: '紧凑',
  hint: '邻居很多、环上挤成一片时用它：相连的两点被拉到一张卡片宽以内，不相连的则被推开。',
  params: frozen({
    centerStrength: 0.008,
    repelStrength: 5,
    linkStrength: 0.09,
    linkDistance: 220,
    damping: 0.86,
    maxSpeed: 26,
    linkMaxHop: Number.POSITIVE_INFINITY,
    alphaDecay: 0.014,
  }),
}

/**
 * 舒展。
 *
 * 依据：`linkDistance` 520 略小于种子环半径 562 —— 一环基本停在布局给出的位置上（不再被弹簧
 * 往内拉），而种子里只有 100~300px 的二跳边会被推到 520，二跳因此被明确推到外圈；
 * `repelStrength` 6 让不相连的卡片也被撑开；`centerStrength` 0.0035 只有默认的七成，
 * 因为这一档要的是"散开"，向心力只需兜住孤岛（完全没有边的节点）。
 * 实测（两环 ego、种子 562 / 1124）：一跳 ≈493（基本停在种子附近）、二跳 ≈928 ——
 * 一环几乎没被拉动，二跳被弹簧明确推到了外圈。
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
 * 实测（两环 ego、种子 562 / 1124）：一跳 ≈502、二跳 ≈925，且 600 步仍不见停
 * （`settle(600)` 跑满上限 —— 这一档本来就是"不落定"）。
 */
const FLOATING: ForcePreset = {
  id: 'floating',
  label: '漂浮',
  hint: '当"活的"背景挂着、或一边读一边看卡片慢慢让位时用它：力场永不降温，但速度压得很低，动作像在水里。',
  params: frozen({
    centerStrength: 0.0025,
    repelStrength: 3.5,
    linkStrength: 0.03,
    linkDistance: 320,
    damping: 0.93,
    maxSpeed: 10,
    linkMaxHop: Number.POSITIVE_INFINITY,
    alphaDecay: 0,
  }),
}

/**
 * 聚焦。
 *
 * 依据：`linkMaxHop` 1 —— 只有"中心 ↔ 一跳"之间的弹簧在工作（判据是**两端都在圈内**，
 * 用 max 而不是 min；否则那条从二跳拉向一跳的边会被算成"一跳的边"，二跳会被整体吸进内圈）；
 * `centerStrength` 0.008 是默认的 1.6 倍：二跳没有弹簧兜着，全靠向心力，弱了它们会慢慢飘出屏幕；
 * `linkDistance` 300 小于相切距离 320，让内圈收紧成"中心 + 一圈清晰的直接邻居"。
 * 实测（两环 ego、种子 562 / 1124）：一跳 ≈315、二跳 ≈595 —— 内圈收得比均衡档还紧，
 * 二跳因为不再有弹簧，只受斥力与向心力，摊在外圈当背景。
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
