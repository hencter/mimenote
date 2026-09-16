/**
 * 画笔的**公共地基**：2D 上下文的最小接口、视口变换、以及唯一那条坐标换算。
 *
 * 为什么单独一个文件：`paint.ts`（卡片）与 `edge-paint.ts`（连线）都要这三样东西，
 * 而 `edge-paint.ts` 由 `paint.ts` 调用 —— 类型与换算函数留在 `paint.ts` 里就会形成
 * 循环依赖（在打包器里表现为"某个导出是 undefined"，排查成本远高于拆一个文件）。
 *
 * 坐标关系只有一条，写在这里也只有一个地方会出现"忘了乘 scale"这类错误：
 *
 * ```text
 * screen = world × scale + offset
 * ```
 */

import type { Point } from '../layout'

/**
 * 我们用到的那一小撮 2D 上下文。
 *
 * 为什么是结构类型而不是 `CanvasRenderingContext2D`：测试要喂一个"记录每次调用与属性赋值"的
 * 假上下文，而 node 里没有画布（装 jsdom + node-canvas 只为了这点断言不成比例）。
 * 结构类型让真上下文与假上下文**同一份签名**都过：真实 `CanvasRenderingContext2D` 可以直接传进来
 * （它的 `fillStyle` 是 `string | CanvasGradient | CanvasPattern`，比这里的 `string` 宽，赋值方向对得上）。
 *
 * `setTransform` / `arc` / `strokeRect` 这几个成员本层基本不用（或一次都不用），
 * 留着是因为"我需要什么就声明什么"比"抄一份完整接口"更安全：多声明一个不用的成员没有代价，
 * 少声明一个就会让真调用方在这里编译不过。
 */
export interface PaintContext {
  font: string
  /**
   * 这两个属性的类型**故意**写成联合类型（而不是 `string`）：真实的
   * `CanvasRenderingContext2D.fillStyle` 就是 `string | CanvasGradient | CanvasPattern`。
   * 写成 `string` 时，`getContext('2d')` 的返回值不能直接传进来（缺的那一支让它不满足本接口），
   * 调用方就只能加一个 `as` 或包一层转发 —— 那是把类型系统当障碍物绕，而不是用它描述事实。
   * 画笔自己只会赋字符串，这里宽一点没有任何损失。
   */
  fillStyle: string | CanvasGradient | CanvasPattern
  strokeStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  globalAlpha: number
  textAlign: string
  textBaseline: string
  lineJoin: string
  /** 虚线的相位（`setLineDash` 的配套）。连线的引线靠它把最后一段实线收在卡片边界上。 */
  lineDashOffset: number
  save(): void
  restore(): void
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
  beginPath(): void
  closePath(): void
  rect(x: number, y: number, width: number, height: number): void
  clip(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void
  fill(): void
  stroke(): void
  fillRect(x: number, y: number, width: number, height: number): void
  strokeRect(x: number, y: number, width: number, height: number): void
  fillText(text: string, x: number, y: number): void
  measureText(text: string): { width: number }
  setLineDash(segments: number[]): void
}

/**
 * 换算真正用到的那三个数。
 *
 * 单独列出来是因为**宽高不属于坐标换算**：`width` / `height` 是画布尺寸（判"在不在视口里"
 * 才用它），而 `screenPoint` 只关心缩放与偏移。连线画笔（`edge-paint.ts`）只需要这三个数，
 * 让它为了调用一个函数去伪造一份 `ViewTransform` 是把类型当摆设。
 */
export interface ViewOffset {
  scale: number
  offsetX: number
  offsetY: number
}

/** 视口与缩放：`screen = world × scale + offset`；`width`/`height` 是画布尺寸（CSS 像素）。 */
export interface ViewTransform extends ViewOffset {
  width: number
  height: number
}

/**
 * 世界坐标 → 屏幕坐标（CSS 像素）。
 *
 * `scale` 传的是**安全化之后**的缩放（见 `paint.ts` 的 `normalizeScale`）：
 * 缩放为 0 / NaN 时所有坐标都会变成 NaN，而 canvas 对含 NaN 的路径**静默不画** ——
 * 表现为"整幅图消失了，控制台一句错都没有"。
 */
export function screenPoint(point: Point, transform: ViewOffset, scale: number): Point {
  return { x: point.x * scale + transform.offsetX, y: point.y * scale + transform.offsetY }
}
