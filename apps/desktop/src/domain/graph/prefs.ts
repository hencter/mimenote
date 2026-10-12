/**
 * 图谱偏好与参数域 —— **纯函数层**（不 import React / 不碰 DOM / 不读 store）。
 *
 * 一句话职责：视图偏好（模式/跳数/张力）的默认值与夹值，以及"力度管理"面板那一整套参数域
 * （每个旋钮的范围、步长、展示精度）与它们的归一化。
 *
 * 为什么住 `domain/**`：这些函数不碰 store、不碰 DOM，而 `state/graph-store.ts` 拆出来的
 * 三个切片都要用它们（视图切片用 `clampEgoDepth`/`clampTension`，卡片切片用
 * `clampCardWidth`/`clampForceParam`）。放进 `state/**` 就等于让"纯模型"再依赖一次状态层，
 * 也失去了"能在 node 环境直接断言"的能力（门禁的方向只允许 `state → domain`）。
 *
 * 力度参数的**读回**（`readForceParams`）也住在这里：它逐项夹范围 + 吸附步长，
 * 因此手工改过 localStorage 的脏值不会让模拟发散；预设只是这套参数的起点（见 `force-presets.ts`）。
 */

import { forcePreset } from './force-presets'
import type { ForceParams } from './force-params'

/** 图谱的两种视图（ADR-0021）。它同时是被持久化的偏好，所以类型定义住在这一层。 */
export type GraphMode = 'focus' | 'vault'

/** 自我中心视图的跳数范围：与宿主（`mn_index::graph`）的 `depth.clamp(1, 5)` 逐字一致。 */
export const MIN_EGO_DEPTH = 1
export const MAX_EGO_DEPTH = 5

/**
 * 进入自我中心视图的默认跳数：**1 跳**。
 *
 * 用户的诉求是"进入后只有先关联的" —— 那就先给直接相关的那一圈（1 跳），
 * 想看更远的自己往上加。默认给 2 或 3 会在几十个邻居的笔记上立刻变成一屏乱线，
 * 而那正是这次要修掉的东西。
 */
export const DEFAULT_EGO_DEPTH = 1

/** 连线张力的范围：0 = 直线，1 = 最绷（控制点偏移弦长的 1/4）。 */
export const MIN_TENSION = 0
export const MAX_TENSION = 1

/**
 * 默认张力：**0.35**。
 *
 * 依据：0 时线是直的，"张力"这个旋钮看不出效果；1 时曲线会绕过卡片、也容易与其它线交叉。
 * 0.35 在 1200×800 的视口、一跳邻居围一圈的情况下曲线微微外扩，既不压住卡片也不像乱麻。
 */
export const DEFAULT_TENSION = 0.35

/** 默认力导向预设（见 `domain/graph/force-presets.ts`）。 */
export const DEFAULT_FORCE_PRESET = 'balanced'

/**
 * 每个力度参数的可调范围（HUD 的「力度管理」面板用滑杆改它们，`step` 是滑杆的步长）。
 *
 * 为什么范围写在这里而不是 `force.ts` 里：`force.ts` 是**模拟**（只关心数学），
 * 而"滑杆能给到多细、最大能到多少"是**界面与人心的取舍** —— 比如阻尼低于 0.5 会晃得像果冻、
 * 高于 0.99 基本就不动了，滑杆没有理由伸到那些地方去。两者混在一起，改滑杆范围就得动模拟层。
 */
export interface ForceParamRange {
  /** 中文名（面板上那一行）。 */
  label: string
  /** 一句话说明"这个旋钮往两边拧分别会发生什么"。 */
  hint: string
  min: number
  max: number
  step: number
  /** 展示时保留几位小数（`0` = 整数）。 */
  digits: number
}

export const FORCE_PARAM_RANGES: Readonly<Record<string, ForceParamRange>> = {
  centerStrength: {
    label: '向心力',
    hint: '把所有卡片往圆心（当前笔记）拉的强度；调大更紧凑、调小更散',
    min: 0,
    max: 0.05,
    step: 0.001,
    digits: 3,
  },
  repelStrength: {
    label: '斥力',
    hint: '卡片之间互相推开的强度；调大更松（重叠也会更少）',
    min: 0,
    max: 20,
    step: 0.5,
    digits: 1,
  },
  linkStrength: {
    label: '弹簧强度',
    hint: '有链接的两张被拉向"弹簧长度"的强度；调大把有关的卡片拉得更近',
    min: 0,
    max: 0.3,
    step: 0.005,
    digits: 3,
  },
  linkDistance: {
    label: '弹簧长度',
    hint: '有链接的两张之间的自然距离（世界像素）—— 这就是"连线张力"最直观的旋钮',
    min: 120,
    max: 1200,
    step: 20,
    digits: 0,
  },
  damping: {
    label: '阻尼',
    hint: '越小越"黏"、越大越晃；0.84 左右是"落定快又不僵"的手感',
    min: 0.5,
    max: 0.99,
    step: 0.01,
    digits: 2,
  },
  maxSpeed: {
    label: '速度上限',
    hint: '每一步最多移动多少像素；调小让运动更柔和，调大允许更强的弹开',
    min: 0,
    max: 80,
    step: 2,
    digits: 0,
  },
  alphaDecay: {
    label: '强度衰减',
    hint: '每步的强度衰减；0 = 永不衰减（一直漂浮），调大更快落定',
    min: 0,
    max: 0.05,
    step: 0.001,
    digits: 3,
  },
  collideStrength: {
    label: '碰撞强度',
    hint: '卡片不许重叠的力度：1 = 硬约束（落定后保证一张都不叠），0 = 只靠斥力（可能叠在一起）',
    min: 0,
    max: 1,
    step: 0.05,
    digits: 2,
  },
  collideIterations: {
    label: '碰撞轮数',
    hint: '每一步之后解几轮重叠（一轮在密集处推不开 —— A 推开 B 又把 B 推进 C）',
    min: 1,
    max: 4,
    step: 1,
    digits: 0,
  },
}

/** 力度参数里可以用滑杆调的那些键（`linkMaxHop` 是"几跳以内算弹簧"，用选项而不是滑杆）。 */
export const FORCE_SLIDER_KEYS: readonly string[] = [
  'centerStrength',
  'repelStrength',
  'linkStrength',
  'linkDistance',
  'damping',
  'maxSpeed',
  'collideStrength',
  'collideIterations',
  'alphaDecay',
]

/** `linkMaxHop` 的可选值（`Infinity` 在界面里显示成「全部」）。 */
export const FORCE_HOP_OPTIONS: readonly number[] = [1, 2, 3, 4, Number.POSITIVE_INFINITY]

export function formatForceParam(key: string, value: number): string {
  if (!Number.isFinite(value)) return '全部'
  const range = FORCE_PARAM_RANGES[key]
  if (range === undefined) return String(value)
  return value.toFixed(range.digits)
}

/**
 * 把参数值夹进滑杆的范围并按步长吸附。
 *
 * 两条都要：夹范围防"手工改过 localStorage 的极端值"（比如把阻尼写成 2 会让模拟直接发散），
 * 吸附步长则是为了让"面板上显示的"与"实际生效的"永远是同一个数 —— 否则滑杆会显示一个
 * 它自己再也回不去的值（拖回去也差一点点）。
 */
export function clampForceParam(key: string, value: number): number {
  if (!Number.isFinite(value)) return value
  const range = FORCE_PARAM_RANGES[key]
  if (range === undefined) return value
  const clamped = Math.min(range.max, Math.max(range.min, value))
  const steps = Math.round((clamped - range.min) / range.step)
  const snapped = range.min + steps * range.step
  // 浮点乘法会留下 0.30000000000000004 这种尾巴：按步长的小数位数收一下，
  // 否则滑杆的 `value` 与 store 里的值永远不严格相等（受控输入会因此抖动）
  const decimals = range.step < 1 ? (`${range.step}`.split('.')[1]?.length ?? 0) : 0
  return Number(snapped.toFixed(decimals))
}

/** 卡片宽度的范围：比手机窄就没法读，比一屏还宽就不像卡片了。 */
export const MIN_CARD_WIDTH = 220
export const MAX_CARD_WIDTH = 900

/**
 * 卡片**正文高度上限**的范围。
 *
 * 为什么是"上限"而不是固定高度：卡片正面是笔记正文，高度本来就由内容决定；
 * 用户调小它是"这一篇太长，我只要看开头"，调大它是"这一篇我想多看点"。
 * 固定高度反而会把短笔记撑成一堆空白。
 */
export const MIN_CARD_HEIGHT = 120
export const MAX_CARD_HEIGHT = 2400

/** 卡片的手工尺寸（按 Vault + relPath 持久化；没调过的字段是 `null` = 用默认）。 */
export interface CardSize {
  /** 卡片宽度；`null` = 默认宽度（焦点视图 320）。 */
  width: number | null
  /** 正文高度上限；`null` = 用默认上限。 */
  height: number | null
  /**
   * `true` = **不截断**：整篇正文都排进卡片（忽略 `height` 上限）。
   *
   * 为什么是一个独立开关而不是"一个很大的 height"：用户要的是"这篇我要看全文"，
   * 而不是"这篇的上限是 99999" —— 前者在内容变长之后依然成立，后者只是又一次截断。
   * 缺省（字段不存在）= `false`，老版本存下来的尺寸记录因此原样有效。
   */
  full?: boolean
}

/** 卡片尺寸的归一化（越界与非法值都夹回范围内）。 */
export function clampCardWidth(width: number): number {
  if (!Number.isFinite(width)) return MAX_CARD_WIDTH
  return Math.min(MAX_CARD_WIDTH, Math.max(MIN_CARD_WIDTH, Math.round(width)))
}

/** 高度上限可以显式"自动"（`null`），所以这里接受 `null` 原样返回。 */
export function clampCardSizeHeight(height: number | null): number | null {
  return height === null ? null : clampCardHeight(height)
}

export function clampCardHeight(height: number): number {
  if (!Number.isFinite(height)) return MIN_CARD_HEIGHT
  return Math.min(MAX_CARD_HEIGHT, Math.max(MIN_CARD_HEIGHT, Math.round(height)))
}

/** 跳数归一化：非法值一律回到范围内（宿主也会再夹一次，前端不做"等宿主纠正"的假设）。 */
export function clampEgoDepth(depth: number): number {
  if (!Number.isFinite(depth)) return DEFAULT_EGO_DEPTH
  return Math.min(MAX_EGO_DEPTH, Math.max(MIN_EGO_DEPTH, Math.round(depth)))
}

/** 张力归一化（0 = 直线，1 = 最绷）。 */
export function clampTension(tension: number): number {
  if (!Number.isFinite(tension)) return DEFAULT_TENSION
  return Math.min(MAX_TENSION, Math.max(MIN_TENSION, tension))
}

/**
 * 力度参数的落盘/读回。
 *
 * 为什么整份存下来（而不是只存预设名）：用户拧过的滑杆必须跨会话保留 —— 那是"我怎么看这幅图"
 * 的一部分，重启就回到默认值等于白调。读回时逐项走 {@link readForceParams}（夹范围 + 吸附步长），
 * 因此手工改过 localStorage 的脏值不会让模拟发散。
 */
export function readForceParams(raw: unknown): ForceParams | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const out: Record<string, number> = {
    ...(forcePreset(DEFAULT_FORCE_PRESET).params as unknown as Record<string, number>),
  }
  let known = 0
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    if (!(key in out)) continue
    out[key] = clampForceParam(key, value)
    known += 1
  }
  // 一个认识的字段都没有 ⇒ 当成"没存过"（让调用方回到预设那一套），而不是塞一份缺项的参数
  if (known === 0) return null
  return out as unknown as ForceParams
}
