/**
 * 连线几何的**点模型**：把 `GraphEdgeVisual.d` / `leadPath` 那一串 SVG path 数据，
 * 变成"自己画得出来、自己也算得出命中"的命令序列。
 *
 * ## 为什么需要这一层（ADR-0036）
 *
 * 连线原先是一层 `<svg>`：形状、虚线相位、箭头全交给浏览器排版。搬进 canvas 之后，
 * 两件事都要自己来：
 *
 * 1. **画**：{@link tracePath} 把命令逐个变成 `moveTo` / `lineTo` / `bezierCurveTo`；
 * 2. **命中**：canvas 里没有"元素"可以挂 tooltip，悬停只能自己算距离 ——
 *    {@link distanceToPath} 用同一份命令算"指针离这条线多远"。
 *
 * 判据只有一份：**画与命中读的是同一份命令**。画笔每帧解析一次，把结果放进
 * `PaintedEdge.commands`，命中测试直接用那份结果 —— 于是"看到的那条线"与"悬停到的那条线"
 * 不可能分家（分家的话，用户会在离线 20px 的地方看到 tooltip，或者在线正中反而没有）。
 *
 * ## 只认 M / L / C / A（绝对坐标）
 *
 * 几何层（`layout.ts` 的 `edgePath`、`edge-routing.ts` 的 `routeEdgePath` 与 `ringArcPath`、
 * `link-edge.ts` 的 `leadPathBetween` / `tensionPath`）只产出这四种命令，而且全是绝对坐标。
 * 其中 `A`（椭圆弧）在解析时**展开成三次贝塞尔**（见 `arcToCubics`），于是命令集实际只有三种 ——
 * 采样、命中、描边三处因此都不用为弧单独写一遍。
 *
 * 见到别的命令（`Q` / `S` / `T` / 小写相对坐标…）**当场抛错**，不猜、不近似：
 * 那说明几何层换了写法，这里必须补一条实现 —— 悄悄画错一条线比崩溃难查得多
 * （崩溃有栈，画错只有"看起来有点怪"）。
 *
 * ## 每帧的代价
 *
 * 漂浮开着时每帧都要重画，因此解析必须是"敢每帧调"的东西：这些路径串只有一个
 * `M` 加一两个 `C`（十几个数），`String(数字)` 的输出格式也固定，所以走
 * "正则取词 + `Number()`" 的直路；**不做**通用的 SVG 路径解析（弧线转贝塞尔那一套）
 * —— 那份复杂度这里用不上。换算成量级：一条边几微秒，几百条边每帧不到 1ms。
 */

import type { Point } from '../layout'

/** 一条命令：只有三种（理由见文件头）。坐标都是**世界坐标**，与几何层同一口径。 */
export type PathCommand =
  | { readonly kind: 'move'; readonly to: Point }
  | { readonly kind: 'line'; readonly to: Point }
  | { readonly kind: 'cubic'; readonly c1: Point; readonly c2: Point; readonly to: Point }

/**
 * 画路径时真正用到的那几个成员。
 *
 * 为什么是结构类型：真正的 `CanvasRenderingContext2D` 与测试里的假上下文都直接满足它，
 * 不必让这一层认识 `paint.ts` 的 `PaintContext`（那会造成 `paint.ts` ⇄ `edge-path.ts`
 * 的循环依赖，而循环依赖在打包器里表现为"某个函数是 undefined"，排查成本很高）。
 */
export interface PathTarget {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void
}

/** 每个字母要吃掉几个数。 */
const ARITY: Readonly<Record<string, number>> = { M: 2, L: 2, C: 6, A: 7 }

/** 取词：一个字母，或者一个（可带符号/小数/指数的）数字。 */
const TOKEN = /([A-Za-z])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/y

/**
 * 把一条 path 数据解析成命令序列。
 *
 * 支持 SVG 的**隐式重复**（`M 1 2 3 4` 里第二对是 `L`，`C` 后面多出来的六元组还是 `C`）——
 * 这不是为了迁就几何层（它总是把字母写全），而是因为"少写一个字母"是手改路径时最常见的手误，
 * 而规范早就定义了它该是什么意思，按规范读比抛错更省事。
 *
 * 取词失败 / 遇到不认识的命令 / 数字个数不齐，一律抛错（理由见文件头）。
 */
export function parsePathData(d: string): PathCommand[] {
  const commands: PathCommand[] = []
  let letter = ''
  let numbers: number[] = []
  /** 当前点：只有 `A`（椭圆弧）要它 —— 弧的两个端点一起决定圆心在哪。 */
  let cursor: Point = { x: 0, y: 0 }

  const flush = (): void => {
    if (numbers.length === 0) return
    const arity = ARITY[letter]
    if (arity === undefined) throw new Error(`连线路径里出现了未支持的命令「${letter}」：${d}`)
    if (numbers.length % arity !== 0) {
      throw new Error(`连线路径「${letter}」后面的数字个数（${numbers.length}）不是 ${arity} 的整数倍：${d}`)
    }
    for (let at = 0; at < numbers.length; at += arity) {
      if (letter === 'A') {
        // 弧在这个模型里**展开成三次贝塞尔**：命令集因此保持 M/L/C 三种，
        // 采样、命中、描边三处都不用为它各写一遍（展开是精确到亚像素的，见 arcToCubics）
        const cubics = arcToCubics(cursor, numbers.slice(at, at + arity))
        for (const cubic of cubics) commands.push(cubic)
        cursor = cubics[cubics.length - 1]!.to
        continue
      }
      const to = { x: numbers[at]!, y: numbers[at + 1]! }
      if (letter === 'M') {
        // 隐式重复：一个 M 之后的多余坐标对是 L（SVG 规范），不是第二个 M
        commands.push(at === 0 ? { kind: 'move', to } : { kind: 'line', to })
        cursor = to
      } else if (letter === 'L') {
        commands.push({ kind: 'line', to })
        cursor = to
      } else {
        /*
          ⚠️ `C` 的参数顺序是 `c1x c1y c2x c2y x y`：**终点在最后**。
          上面那个 `to` 是按 `A` 的口径取的（弧的参数里终点确实排在最后两位），
          这里必须重新取一遍 —— 两种顺序混用会把控制点与终点对调：曲线照样画得出来，
          只是形状完全不同（"看起来有点怪"里最难查的一类），而且命中测试会跟着一起错。
        */
        const cubic: PathCommand = {
          kind: 'cubic',
          c1: { x: numbers[at]!, y: numbers[at + 1]! },
          c2: { x: numbers[at + 2]!, y: numbers[at + 3]! },
          to: { x: numbers[at + 4]!, y: numbers[at + 5]! },
        }
        commands.push(cubic)
        cursor = cubic.to
      }
    }
    numbers = []
  }

  TOKEN.lastIndex = 0
  let at = 0
  while (at < d.length) {
    const char = d[at]!
    if (char === ' ' || char === ',' || char === '\t' || char === '\n' || char === '\r') {
      at += 1
      continue
    }
    TOKEN.lastIndex = at
    const matched = TOKEN.exec(d)
    if (matched === null || matched.index !== at) {
      throw new Error(`连线路径里有一个读不懂的片段（第 ${at} 个字符起）：${d.slice(at, at + 12)}…`)
    }
    at = TOKEN.lastIndex
    if (matched[1] !== undefined) {
      flush()
      letter = matched[1]
      const arity = ARITY[letter]
      if (arity === undefined) {
        // 小写（相对坐标）也走到这里：几何层从不产出它，见到就是换了写法
        throw new Error(`连线路径里出现了未支持的命令「${letter}」（只认绝对坐标的 M / L / C / A）：${d}`)
      }
    } else {
      if (letter === '') throw new Error(`连线路径以数字开头（缺少命令字母）：${d}`)
      numbers.push(Number(matched[2]))
    }
  }
  flush()
  if (commands.length > 0 && commands[0]!.kind !== 'move') {
    throw new Error(`连线路径必须以 M 开头：${d}`)
  }
  return commands
}

/**
 * 椭圆弧（SVG 的 `A`）→ 一串三次贝塞尔。
 *
 * 为什么要支持它：几何层的"沿环走弧"（`edge-routing.ts` 的 `ringArcPath`）产出的正是
 * `M … L … A r r 0 largeArc sweep … L …`。canvas 没有现成的椭圆弧 API
 * （`ctx.ellipse` 只能在**已知圆心与角度**时用，而 SVG 的 `A` 给的是两个端点），
 * 于是按规范把端点参数换算成圆心与扫角，再切段逼近（每段 ≤ 90°）。
 *
 * 为什么是"精确到亚像素"而不是"看起来差不多"：
 * 1. 每段 ≤ 90° 时，`k = 4/3·tan(Δ/4)` 的三次贝塞尔与真实弧的偏差在千分之一半径量级
 *    （半径 400px 的弧上不到 0.2px），远小于线的宽度；
 * 2. **最后一段的终点强制取规范给的 `to`**：浮点算下来可能与它差 1e-13，
 *    而"引线的终点必须与卡外那段的起点逐坐标相同"是 ADR-0023 的硬纪律，
 *    分界点上不能有任何累计误差（这也是本函数唯一的特殊处理）。
 *
 * 参数是规范里那七个：`rx ry rotation largeArc sweep x y`。
 * 半径退化成 0 时按规范当作直线段；`largeArc` / `sweep` 是 0/1 标志位。
 */
function arcToCubics(from: Point, parameters: readonly number[]): PathCommand[] {
  const rx0 = Math.abs(parameters[0]!)
  const ry0 = Math.abs(parameters[1]!)
  const rotation = ((parameters[2]! % 360) * Math.PI) / 180
  const largeArc = parameters[3]! !== 0
  const sweep = parameters[4]! !== 0
  const to: Point = { x: parameters[5]!, y: parameters[6]! }

  // 规范：任一半径为 0 ⇒ 当作直线段（不然下面的除法会炸）
  if (rx0 === 0 || ry0 === 0) return [{ kind: 'line', to }]

  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)

  // 1. 把端点差旋进椭圆自己的坐标系，得到规范里的 x1' / y1'
  const halfDx = (from.x - to.x) / 2
  const halfDy = (from.y - to.y) / 2
  const x1 = cos * halfDx + sin * halfDy
  const y1 = -sin * halfDx + cos * halfDy

  // 2. 半径太小画不过去时**按规范等比放大**（不是抛错：这是合法的输入）
  let rx = rx0
  let ry = ry0
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
  if (lambda > 1) {
    const scale = Math.sqrt(lambda)
    rx *= scale
    ry *= scale
  }

  // 3. 圆心（椭圆坐标系里），符号由 largeArc 与 sweep 是否相同决定
  const numerator = Math.max(0, rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1)
  const denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
  const coefficient =
    (largeArc === sweep ? -1 : 1) * Math.sqrt(denominator === 0 ? 0 : numerator / denominator)
  const centerX1 = coefficient * ((rx * y1) / ry)
  const centerY1 = coefficient * ((-ry * x1) / rx)
  const center: Point = {
    x: cos * centerX1 - sin * centerY1 + (from.x + to.x) / 2,
    y: sin * centerX1 + cos * centerY1 + (from.y + to.y) / 2,
  }

  // 4. 起角与扫角（扫角按 sweep 归一化到正确的方向）
  const startAngle = angleBetween(1, 0, (x1 - centerX1) / rx, (y1 - centerY1) / ry)
  let delta = angleBetween(
    (x1 - centerX1) / rx,
    (y1 - centerY1) / ry,
    (-x1 - centerX1) / rx,
    (-y1 - centerY1) / ry,
  )
  if (!sweep && delta > 0) delta -= Math.PI * 2
  else if (sweep && delta < 0) delta += Math.PI * 2

  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)))
  const step = delta / segments
  const k = (4 / 3) * Math.tan(step / 4)
  const pointAt = (angle: number): Point => ({
    x: center.x + cos * rx * Math.cos(angle) - sin * ry * Math.sin(angle),
    y: center.y + sin * rx * Math.cos(angle) + cos * ry * Math.sin(angle),
  })
  const derivativeAt = (angle: number): Point => ({
    x: -cos * rx * Math.sin(angle) - sin * ry * Math.cos(angle),
    y: -sin * rx * Math.sin(angle) + cos * ry * Math.cos(angle),
  })

  const cubics: PathCommand[] = []
  for (let index = 0; index < segments; index += 1) {
    const t1 = startAngle + step * index
    const t2 = t1 + step
    const p1 = pointAt(t1)
    const p3 = index === segments - 1 ? to : pointAt(t2)
    const d1 = derivativeAt(t1)
    const d2 = derivativeAt(t2)
    cubics.push({
      kind: 'cubic',
      c1: { x: p1.x + k * d1.x, y: p1.y + k * d1.y },
      c2: { x: p3.x - k * d2.x, y: p3.y - k * d2.y },
      to: p3,
    })
  }
  return cubics
}

/** 两个向量之间的**有向**夹角（`atan2(叉积, 点积)`），弧度。 */
function angleBetween(ux: number, uy: number, vx: number, vy: number): number {
  return Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
}

/** 三次贝塞尔在 `t` 处的点。 */
function cubicAt(from: Point, c1: Point, c2: Point, to: Point, t: number): Point {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const e = t * t * t
  return {
    x: a * from.x + b * c1.x + c * c2.x + e * to.x,
    y: a * from.y + b * c1.y + c * c2.y + e * to.y,
  }
}

/** 把命令序列铺成折线点（含首尾）。曲线按 `perCurve` 段采样。 */
export function samplePoints(commands: readonly PathCommand[], perCurve = 16): Point[] {
  const points: Point[] = []
  let from: Point | null = null
  for (const command of commands) {
    if (command.kind === 'move') {
      points.push(command.to)
      from = command.to
      continue
    }
    if (from === null) {
      // 只在手写的路径串里可能出现（`L` 起头）：按当前点处理，不抛错
      from = command.to
      points.push(command.to)
      continue
    }
    if (command.kind === 'line') {
      points.push(command.to)
      from = command.to
      continue
    }
    for (let step = 1; step <= perCurve; step += 1) {
      points.push(cubicAt(from, command.c1, command.c2, command.to, step / perCurve))
    }
    from = command.to
  }
  return points
}

/** 点到线段的距离。 */
function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) return Math.hypot(point.x - a.x, point.y - a.y)
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq
  if (t < 0) t = 0
  else if (t > 1) t = 1
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy))
}

/**
 * 点到整条路径的距离（世界单位）。
 *
 * 曲线按 `perCurve` 段折线近似：`tensionPath` 的控制点只沿主轴伸出 45%，
 * 一条 300px 的曲线分 16 段时误差远小于 1px，而命中容差是**好几个像素**
 * （见 `GraphCanvas` 的 `EDGE_HIT_SLOP`）—— 更精确的"点到三次贝塞尔的最短距离"
 * （解五次方程）在这里换不来任何用户能察觉的差别。
 */
export function distanceToPath(
  commands: readonly PathCommand[],
  point: Point,
  perCurve = 16,
): number {
  let best = Infinity
  let from: Point | null = null
  for (const command of commands) {
    if (command.kind === 'move') {
      from = command.to
      continue
    }
    if (from === null) {
      from = command.to
      continue
    }
    if (command.kind === 'line') {
      best = Math.min(best, distanceToSegment(point, from, command.to))
      from = command.to
      continue
    }
    let previous = from
    for (let step = 1; step <= perCurve; step += 1) {
      const next = cubicAt(from, command.c1, command.c2, command.to, step / perCurve)
      best = Math.min(best, distanceToSegment(point, previous, next))
      previous = next
    }
    from = command.to
  }
  return best
}

/**
 * 终点的**单位切向**（箭头朝哪边）。
 *
 * 三次贝塞尔在 `t = 1` 处的切向由 `to − c2` 给出；它退化成零向量时依次退到 `to − c1`、
 * 最后一段的方向 —— 控制点与终点重合是合法的（几何层在"两点几乎重合"时会产出它），
 * 那时按"朝最后一段的方向"画箭头，总比画一个朝 (1,0) 的箭头好。
 */
export function endDirection(commands: readonly PathCommand[]): Point {
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const command = commands[index]!
    if (command.kind === 'move') continue
    const previous = commands[index - 1]
    const from: Point | undefined = previous?.to
    const candidates =
      command.kind === 'cubic'
        ? [sub(command.to, command.c2), sub(command.to, command.c1)]
        : []
    for (const candidate of candidates) {
      const unit = normalize(candidate)
      if (unit !== null) return unit
    }
    if (from !== undefined) {
      const unit = normalize(sub(command.to, from))
      if (unit !== null) return unit
    }
    return { x: 1, y: 0 }
  }
  return { x: 1, y: 0 }
}

function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y }
}

function normalize(vector: Point): Point | null {
  const length = Math.hypot(vector.x, vector.y)
  if (!Number.isFinite(length) || length < 1e-6) return null
  return { x: vector.x / length, y: vector.y / length }
}

/**
 * 把命令画到目标上：`map` 负责世界 → 屏幕（画笔那边就是 `world * scale + offset`）。
 *
 * 只调 `moveTo` / `lineTo` / `bezierCurveTo` 三个成员，路径的开闭与样式由调用方负责
 * （与 SVG 一样：路径本身不描述颜色）。
 */
export function tracePath(
  target: PathTarget,
  commands: readonly PathCommand[],
  map: (point: Point) => Point,
): void {
  for (const command of commands) {
    if (command.kind === 'move') {
      const to = map(command.to)
      target.moveTo(to.x, to.y)
      continue
    }
    if (command.kind === 'line') {
      const to = map(command.to)
      target.lineTo(to.x, to.y)
      continue
    }
    const c1 = map(command.c1)
    const c2 = map(command.c2)
    const to = map(command.to)
    target.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, to.x, to.y)
  }
}
