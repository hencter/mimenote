/**
 * 图谱画布的**视口换算**：世界坐标 ↔ 屏幕坐标（CSS 像素）、以及 canvas 的物理像素尺寸。
 *
 * 为什么单独成一层纯函数：这一层是整个"canvas 化"最容易出错的地方 ——
 * 卡片画在 canvas 上（屏幕空间，坐标系自己算），连线与文件夹标题还留在 DOM 里
 * （走 `transform: translate(x,y) scale(z)`，`transform-origin: 0 0`）。两套坐标只要差一点，
 * 表现就是"点卡片点不中""线跟方框错位"，而且只在某些缩放下出现。
 * 把换算钉成纯函数，`tests/graph-viewport.test.ts` 就能把"屏幕点 → 世界点 → 屏幕点"
 * 这类不变量直接断言出来，不必开真浏览器。
 *
 * 换算关系（与 `layout.ts` 的 `worldViewport` / `zoomAround`、`graph.css` 的
 * `.mn-graph__viewport { transform-origin: 0 0 }` 是**同一套**）：
 *
 * ```
 * 屏幕 = 世界 × scale + offset        世界 = (屏幕 − offset) ÷ scale
 * ```
 *
 * `paint.ts` 里有一个字段相同的 `ViewTransform`（那是画笔的入参形状）：两者靠结构类型对上，
 * 刻意不互相 import —— 画笔不应该为了拿一个形状而依赖"视口这一层的实现"。
 */

import { clampZoom, type GraphView, type Point, type Rect, type Size } from './layout'

/** 世界 → 屏幕（CSS 像素）的仿射变换；`width`/`height` 是画布的 CSS 尺寸。 */
export interface ViewTransform {
  scale: number
  offsetX: number
  offsetY: number
  width: number
  height: number
}

/** 从 store 里的视角与视口尺寸算出变换（缩放先过 `clampZoom`，与 DOM 层同一条口径）。 */
export function transformOf(view: GraphView, viewport: Size): ViewTransform {
  return {
    scale: clampZoom(view.zoom),
    offsetX: view.x,
    offsetY: view.y,
    width: Math.max(0, viewport.width),
    height: Math.max(0, viewport.height),
  }
}

export function toScreen(transform: ViewTransform, point: Point): Point {
  return {
    x: point.x * transform.scale + transform.offsetX,
    y: point.y * transform.scale + transform.offsetY,
  }
}

export function toWorld(transform: ViewTransform, point: Point): Point {
  return {
    x: (point.x - transform.offsetX) / transform.scale,
    y: (point.y - transform.offsetY) / transform.scale,
  }
}

/** 世界矩形 → 屏幕矩形（宽高也乘缩放，画布上的盒子因此与 DOM 里的容器逐像素对齐）。 */
export function screenRect(transform: ViewTransform, rect: Rect): Rect {
  return {
    x: rect.x * transform.scale + transform.offsetX,
    y: rect.y * transform.scale + transform.offsetY,
    width: rect.width * transform.scale,
    height: rect.height * transform.scale,
  }
}

/** 屏幕矩形 → 世界矩形（命中测试、裁剪用）。 */
export function worldRect(transform: ViewTransform, rect: Rect): Rect {
  return {
    x: (rect.x - transform.offsetX) / transform.scale,
    y: (rect.y - transform.offsetY) / transform.scale,
    width: rect.width / transform.scale,
    height: rect.height / transform.scale,
  }
}

/** 当前屏幕上看得到的世界区域（`overscan` 是屏幕像素，会按缩放折算成世界距离）。 */
export function visibleWorld(transform: ViewTransform, overscan = 0): Rect {
  const pad = overscan / transform.scale
  return {
    x: (0 - transform.offsetX) / transform.scale - pad,
    y: (0 - transform.offsetY) / transform.scale - pad,
    width: transform.width / transform.scale + pad * 2,
    height: transform.height / transform.scale + pad * 2,
  }
}

/**
 * canvas 的像素尺寸与要设置的 `transform`。
 *
 * DPR 的处理方式：**画布宽度 = CSS 宽度 × dpr**，并把 `setTransform(dpr, 0, 0, dpr, 0, 0)`
 * 交给调用方 —— 之后画笔画的每个坐标都可以直接按 CSS 像素理解，不必到处乘 dpr。
 * `dpr > 3` 时封顶：4K/5K 屏上取 4 会让 3000 张卡片的画布变成 4 倍像素量，
 * 而人眼在那种密度下看不出差别（代价却实打实）。
 */
export function canvasSize(size: Size, dpr: number): { width: number; height: number; dpr: number } {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? Math.min(dpr, 3) : 1
  return {
    width: Math.max(0, Math.round(size.width * ratio)),
    height: Math.max(0, Math.round(size.height * ratio)),
    dpr: ratio,
  }
}

/**
 * 画布上一个**点**的命中半径（按屏幕像素给，折算到世界坐标）。
 *
 * 为什么需要它：缩到 25% 时一张卡片在屏幕上可能只有十几像素宽，纯矩形命中会变得
 * "怎么点都点不中"；放大到 250% 时又反过来 —— 手指/鼠标按下的位置与视觉中心差几个像素，
 * 却落在卡片外面。所以命中判定统一留一点屏幕上的宽容度。
 */
export function hitTolerance(transform: ViewTransform, screenPx = 4): number {
  return screenPx / transform.scale
}

/** 世界矩形（可带宽容度）内的点是否算命中。 */
export function rectHit(rect: Rect, point: Point, tolerance = 0): boolean {
  return (
    point.x >= rect.x - tolerance &&
    point.x <= rect.x + rect.width + tolerance &&
    point.y >= rect.y - tolerance &&
    point.y <= rect.y + rect.height + tolerance
  )
}
