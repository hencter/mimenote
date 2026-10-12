/**
 * 知识图谱画布 —— **基础几何与视角的纯函数层**（不 import React / 不碰 DOM / 不读全局状态）。
 *
 * 一句话职责：点 / 矩形 / 尺寸 / 视角这几种形状，加上它们共用的夹值、相交、中心与路径排序。
 *
 * 为什么从 `layout.ts` 里切出来：这几个函数被容器装箱布局（`layout.ts`）、每帧都在跑的
 * 裁剪索引（`rect-index.ts`）与连线几何（`edge-visuals.ts`）三处同时使用，判据单一、互不依赖；
 * 单独成一层之后那三个文件才能各自落进门禁的 600 行以内，而"同一个判据只有一份实现"
 * 没有被破坏 —— `layout.ts` 仍然把它们**再导出**，消费点只改路径、不改取的符号。
 *
 * 排序器（`comparePaths`）刻意住在这里：画布与文件树必须用**同一个** collator，
 * 否则同一份 Vault 在侧栏与画布上的顺序会不一致（见下面 `comparePaths` 的说明）。
 * 搬走之后**不许**在别处再写一份 collator。
 */

// ---------------------------------------------------------------------------
// 几何基础
// ---------------------------------------------------------------------------

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

/** 画布视口：世界坐标 → 屏幕坐标是 `screen = world * zoom + offset`（CSS transform 的 translate/scale）。 */
export interface GraphView {
  x: number
  y: number
  zoom: number
}

// ---------------------------------------------------------------------------
// 缩放范围与夹值
// ---------------------------------------------------------------------------

/** 缩放范围（与需求一致）。 */
export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 2.5

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/** 数值夹紧（非有限值退到 `min`）：布局的装箱宽度与连线的控制点都用它，所以在这一层公开。 */
export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

// ---------------------------------------------------------------------------
// 矩形与点
// ---------------------------------------------------------------------------

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  )
}

export function centerOf(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

// ---------------------------------------------------------------------------
// 路径排序（画布与文件树共用同一个 collator）
// ---------------------------------------------------------------------------

/**
 * 排序器：**与文件树（`domain/tree.ts`）用同一个**规则（中文按拼音、数字自然序、大小写不敏感）。
 *
 * 为什么这件事重要：画布与侧栏展示的是同一份 Vault，顺序不一致会让人怀疑"是不是两套数据"。
 * 也正因为用了显式的 `Intl.Collator`（而不是 `String.prototype.localeCompare` 的默认 locale），
 * 排序结果在"同一台机器上"是稳定的 —— 布局的确定性依赖它。
 */
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

export function comparePaths(left: string, right: string): number {
  const byName = collator.compare(left, right)
  if (byName !== 0) return byName
  // 排序器认为"相等"时（大小写/全半角差异）用码点兜底，保证结果唯一且与 locale 无关
  return left < right ? -1 : left > right ? 1 : 0
}
