/**
 * 连线锚到"正文里那段 wiki link"（`features/graph/link-edge.ts`）。
 *
 * 这里的几何全部是**手算成字面量**的：假测量让每个汉字正好 10px、行高 20、块间距 6、
 * 卡片内边距 10，于是"第几段、第几行、第几个字"都能用整数心算出来。
 * 期望值**不从实现里推导** —— 推出来的期望值只能证明"实现没变"，证明不了"实现是对的"。
 *
 * 排版本身（折几行、哪一段多高）不由本文件负责：那是 `text-layout.ts` 的事，
 * 这里只消费它的结果，并断言"引线起点确实落在那段文字上"。
 */

import { describe, expect, it } from 'vitest'

import type { CardLayout } from '@/features/graph/canvas/measure'
import { layoutCard } from '@/features/graph/canvas/measure'
import {
  DEFAULT_METRICS,
  type LayoutMetrics,
  type MeasureText,
} from '@/features/graph/canvas/text-layout'
import type { Point, Rect } from '@/features/graph/layout'
import {
  cardLocalToWorld,
  findLinkAnchor,
  leadDash,
  linkEdgeGeometry,
  rayRectExit,
  tensionPath,
} from '@/features/graph/link-edge'

/**
 * 假测量：每个字符 10px（正文字号下的系数为 1，标题那种放大字号按比例放大）。
 *
 * 只做"每字等宽"这一件事，是为了让本文件要断言的东西（落在哪一行哪一列）可见；
 * 混排宽度是 `tests/graph-text-layout.test.ts` 的职责。
 */
const TEN_PER_CHAR: MeasureText = (text, font) =>
  Array.from(text).length * 10 * (font.size / DEFAULT_METRICS.fontSize)

/**
 * 心算友好的几何参数：行高 20、块间距 6（其余沿用缺省）。
 *
 * 于是 `cardChrome` 给的是：内边距 10、标题高 20 × 1.25 = 25、分隔线 y = 41、
 * **正文起点 bodyTop = 47** —— 下面每一个世界坐标的 y 都是"47 + 卡片内 y"。
 */
const METRICS: LayoutMetrics = { ...DEFAULT_METRICS, lineHeight: 20, blockGap: 6 }

/** 卡片外框宽 220 ⇒ 内容宽 200 ⇒ 每行正好 20 个汉字。 */
const CARD_WIDTH = 220

/** 25 个字 ⇒ 在 200px 内容宽下折成两行（20 + 5），于是后面那一段的 y 可以手算。 */
const WRAPPED = '一'.repeat(25)
/** 一行里两段链接：显示出来是 `见 甲 与 乙`（方括号是语法，不占宽度）。 */
const LINKS = '见 [[甲]] 与 [[乙]]'
/** 两段 `[[甲]]`（中间隔着 `再`，所以是两条独立的 run，不会被合并）。 */
const TWICE = '又见 [[甲]] 再 [[甲]]'
/** 三段：第一段折两行、第二段两段链接、第三段两个 `[[甲]]`。 */
const THREE_PARA = `${WRAPPED}\n\n${LINKS}\n\n${TWICE}`

function card(
  text: string,
  options: { width?: number; maxHeight?: number } = {},
): CardLayout {
  return layoutCard({
    relPath: '甲.md',
    title: '甲卡',
    text,
    width: options.width ?? CARD_WIDTH,
    metrics: METRICS,
    measure: TEN_PER_CHAR,
    maxHeight: options.maxHeight,
  })
}

/** 卡片内坐标 → 世界坐标用的矩形（x/y 非 0，好让"忘了加 rect 原点"这类错立刻暴露）。 */
const CARD_RECT: Rect = { x: 100, y: 200, width: CARD_WIDTH, height: 200 }

/**
 * `findLinkAnchor` 的常用入参：本文件里 targets 几乎总是 `['甲']`、量宽函数总是那一份假测量。
 * 收成一个 helper 只是为了让每一行断言短到能一眼看完（入参本身仍逐项写在这里）。
 */
function anchorOf(
  layout: CardLayout,
  options: { targets?: readonly string[]; occurrence?: number } = {},
): { x: number; y: number; text: string } | null {
  return findLinkAnchor({
    layout,
    targets: options.targets ?? ['甲'],
    occurrence: options.occurrence,
    metrics: METRICS,
    measure: TEN_PER_CHAR,
  })
}

// ---------------------------------------------------------------------------
// SVG `d` 的读回（用来断言"路径端点是哪个点"，而不是断言一串拼出来的字符串）
// ---------------------------------------------------------------------------

function pathNumbers(d: string): number[] {
  const matches = d.match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g)
  return matches === null ? [] : matches.map(Number)
}

function firstPoint(d: string): Point {
  const values = pathNumbers(d)
  return { x: values[0] ?? Number.NaN, y: values[1] ?? Number.NaN }
}

function lastPoint(d: string): Point {
  const values = pathNumbers(d)
  return { x: values[values.length - 2] ?? Number.NaN, y: values[values.length - 1] ?? Number.NaN }
}

function controlPoints(d: string): { c1: Point; c2: Point } {
  const values = pathNumbers(d)
  return {
    c1: { x: values[2] ?? Number.NaN, y: values[3] ?? Number.NaN },
    c2: { x: values[4] ?? Number.NaN, y: values[5] ?? Number.NaN },
  }
}

/** 点到"起点→终点"这条弦所在直线的距离（|叉积| / 弦长）。 */
function distanceToChord(start: Point, end: Point, point: Point): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const chord = Math.hypot(dx, dy)
  return Math.abs(dx * (point.y - start.y) - dy * (point.x - start.x)) / chord
}

/**
 * 点在矩形**内**时，离最近那条边有多远（分界点的定义就是"这个数为 0"）。
 *
 * 只对内部点有意义：给一个外面的点，返回的"到最近边的距离"是负数 —— 那正好也是想知道的
 * （"这点不在卡片里"），所以不额外做分支，读到负数就当"在外面"。
 */
function distanceToBorder(rect: Rect, point: Point): number {
  return Math.min(
    point.x - rect.x,
    rect.x + rect.width - point.x,
    point.y - rect.y,
    rect.y + rect.height - point.y,
  )
}

// ---------------------------------------------------------------------------

describe('findLinkAnchor：在哪一行哪一列', () => {
  it('同一行里两段链接：x 按前面 run 的宽度排开，y 是同一个行中线', () => {
    const layout = card(THREE_PARA)

    const jia = findLinkAnchor({ layout, targets: ['甲'], metrics: METRICS, measure: TEN_PER_CHAR })
    const yi = findLinkAnchor({ layout, targets: ['乙'], metrics: METRICS, measure: TEN_PER_CHAR })
    if (jia === null || yi === null) throw new Error('应该命中')

    // 第二段 top = 40 + 6 = 46（第一段两行 = 40 高），行中线 = 46 + 10 = 56
    // `见 [[甲]] 与 [[乙]]` 显示为 `见 甲 与 乙`（方括号是语法，不占宽度）：
    //   甲 前是 `见 ` = 2 个字 = 20px；乙 前再加 `甲 与 ` = 4 个字 = 40px ⇒ 20 + 40 = 60
    expect(jia).toEqual({ x: 20, y: 56, text: '甲' })
    expect(yi).toEqual({ x: 60, y: 56, text: '乙' })

    expect(yi.x).toBeGreaterThan(jia.x)
    expect(yi.y).toBe(jia.y)
  })

  it('折到第二行的链接：y 是第二行的中线，x 从行首重新起算', () => {
    // 一×21 + 空格 + 甲 = 23 个字：第一行放 20 个（都是 `一`），
    // 第二行是 `一` + 空格 + `甲` ⇒ 链接的左边界在 2 个字之后
    const layout = card(`${'一'.repeat(21)} [[甲]]`)

    expect(
      findLinkAnchor({ layout, targets: ['甲'], metrics: METRICS, measure: TEN_PER_CHAR }),
    ).toEqual({ x: 20, y: 30, text: '甲' })
  })

  it('occurrence 按阅读顺序数：0 = 第二段，1/2 = 第三段的两个', () => {
    const layout = card(THREE_PARA)

    // 第三段 top = 46 + 20 + 6 = 72 ⇒ 行中线 82；
    // 第二段 `见 甲…` 的 甲 前有 2 个字（20px）；第三段 `又见 甲 再 甲` 的两段分别在 30 与 70
    expect(anchorOf(layout, { occurrence: 0 })).toEqual({ x: 20, y: 56, text: '甲' })
    expect(anchorOf(layout, { occurrence: 1 })).toEqual({ x: 30, y: 82, text: '甲' })
    expect(anchorOf(layout, { occurrence: 2 })).toEqual({ x: 70, y: 82, text: '甲' })
  })

  it('occurrence 取第 2 个时 x 与第 1 个不同', () => {
    const layout = card(THREE_PARA)
    const first = anchorOf(layout, { occurrence: 1 })
    const second = anchorOf(layout, { occurrence: 2 })
    if (first === null || second === null) throw new Error('应该命中')
    expect(second.x).not.toBe(first.x)
    expect(second.y).toBe(first.y)
  })

  it('occurrence 越界时退回第 0 个（不是 null）', () => {
    const layout = card(THREE_PARA)
    expect(anchorOf(layout, { occurrence: 9 })).toEqual(anchorOf(layout, { occurrence: 0 }))
  })

  it('提示框正文里的链接：x/y 含容器内边距与正文内缩（与画笔同一套几何）', () => {
    // 提示框（内容宽 200、内边距 8、标题一行 20 高 + 正文前 6 间距）：
    //   正文子块左边界 = 0 + 0 + 8 = 8，顶 = 8 + 20 + 6 = 34；
    //   子块自己的 indent 含 `calloutBodyInset` 8 ⇒ 文字左边 = 8 + 8 = 16；
    //   `见 [[甲]]` 里 `甲` 前面还有 2 个字（20px）⇒ x = 36；行中线 = 34 + 10 = 44
    const layout = card('> [!note] 提示\n> 见 [[甲]]')

    expect(
      findLinkAnchor({ layout, targets: ['甲'], metrics: METRICS, measure: TEN_PER_CHAR }),
    ).toEqual({ x: 36, y: 44, text: '甲' })
  })
})

describe('findLinkAnchor：匹配规则', () => {
  it('不做"包含"匹配：只有 `[[甲虫]]` 时 targets: [\'甲\'] 不命中', () => {
    const layout = card('见 [[甲虫]] 而已')

    expect(
      findLinkAnchor({ layout, targets: ['甲'], metrics: METRICS, measure: TEN_PER_CHAR }),
    ).toBeNull()
  })

  it('`[[甲虫]]` 与 `[[甲]]` 并存时，命中的是逐字相等的那一个', () => {
    // `见 甲虫 与 甲`：若退化成包含匹配，会命中左边那个（x = 20 且 text 是 `甲虫`）；
    // 逐字相等 ⇒ 命中的是右边那个：`见 `(20) + `甲虫`(20) + ` 与 `(30) = 70
    const layout = card('见 [[甲虫]] 与 [[甲]]')

    expect(
      findLinkAnchor({ layout, targets: ['甲'], metrics: METRICS, measure: TEN_PER_CHAR }),
    ).toEqual({ x: 70, y: 10, text: '甲' })
  })

  it('别名命中：`[[某篇|别名]]` 的 run.text 是别名（调用方把别名放进 targets）', () => {
    const layout = card('见 [[某篇|别名]]')

    expect(
      findLinkAnchor({ layout, targets: ['别名'], metrics: METRICS, measure: TEN_PER_CHAR }),
    ).toEqual({ x: 20, y: 10, text: '别名' })
  })

  it('别名不在 targets 里时，用链接自己的目标（href = data-target）兜底', () => {
    // `GraphEdge.toRawTarget` 是目标（`某篇`），别名根本不在边里 —— 调用方想"把别名放进 targets"
    // 也无从得知，所以这一处必须由 run 自己的 href 兜底，否则别名写法永远退化成边缘连线
    const layout = card('见 [[某篇|别名]]')

    expect(
      findLinkAnchor({ layout, targets: ['某篇'], metrics: METRICS, measure: TEN_PER_CHAR }),
    ).toEqual({ x: 20, y: 10, text: '别名' })
  })

  it('完整路径命中：`[[笔记/丙]]` 用完整路径当 targets', () => {
    const layout = card('见 [[笔记/丙]]')

    expect(
      findLinkAnchor({ layout, targets: ['笔记/丙'], metrics: METRICS, measure: TEN_PER_CHAR }),
    ).toEqual({ x: 20, y: 10, text: '笔记/丙' })
  })

  it('裸名命中，并且容忍 `.md` 后缀与大小写、首尾空白', () => {
    const layout = card('见 [[甲]] 与 [[Note]]')

    // `[[甲]]` 对上 `甲.md`（`见 ` 2 个字 ⇒ x = 20）；
    // `[[Note]]` 对上 ` note `（去空白 + 忽略大小写）⇒ 20 + `甲`(10) + ` 与 `(30) = 60
    expect(
      findLinkAnchor({ layout, targets: ['甲.md'], metrics: METRICS, measure: TEN_PER_CHAR }),
    ).toEqual({ x: 20, y: 10, text: '甲' })
    expect(
      findLinkAnchor({ layout, targets: [' note '], metrics: METRICS, measure: TEN_PER_CHAR }),
    ).toEqual({ x: 60, y: 10, text: 'Note' })
  })

  it('`![[甲]]`（嵌入）也算命中 —— 它是同一条边', () => {
    const layout = card('见 ![[甲]]')

    expect(
      findLinkAnchor({ layout, targets: ['甲'], metrics: METRICS, measure: TEN_PER_CHAR }),
    ).toEqual({ x: 20, y: 10, text: '甲' })
  })

  it('Markdown 链接 `[文字](路径.md)` 不命中：它不是 wikilink', () => {
    const layout = card('见 [甲](甲.md)')

    expect(
      findLinkAnchor({ layout, targets: ['甲'], metrics: METRICS, measure: TEN_PER_CHAR }),
    ).toBeNull()
  })

  it('相邻的同款链接被合并成一条 run 时，两份仍各有各的位置', () => {
    // `[[甲]][[甲]]` 相邻、样式与 href 都一样 ⇒ `blocks.ts` 合成一条 run（text = `甲甲`）。
    // 认不出这件事，一条真有位置的边就会退化成"从卡片边缘出发"
    const layout = card('[[甲]][[甲]]')

    expect(anchorOf(layout, { occurrence: 0 })).toEqual({ x: 0, y: 10, text: '甲' })
    expect(anchorOf(layout, { occurrence: 1 })).toEqual({ x: 10, y: 10, text: '甲' })
  })

  it('不给量宽函数也能命中：y 精确，x 是按字符数摊派的（纯 CJK 下与真值一致）', () => {
    const layout = card('见 [[甲]]')

    expect(findLinkAnchor({ layout, targets: ['甲'], metrics: METRICS })).toEqual({
      x: 20,
      y: 10,
      text: '甲',
    })
  })
})

describe('findLinkAnchor：截断', () => {
  it('被截断且目标文字落在被截掉的部分 ⇒ null', () => {
    // 三段共 72px，只给 40px：先是第三段被丢，再回退到"只放得下省略号那一行"
    const layout = card('第一段\n\n第二段\n\n第三段 [[甲]]', { maxHeight: 40 })

    expect(layout.truncated).toBe(true)
    expect(layout.blocks.map((item) => item.block.kind)).toEqual(['paragraph'])
    expect(
      findLinkAnchor({ layout, targets: ['甲'], metrics: METRICS, measure: TEN_PER_CHAR }),
    ).toBeNull()
  })

  it('被截断但目标文字还在 ⇒ 照常命中（`truncated` 本身不该让命中失败）', () => {
    const layout = card('第一段 [[甲]]\n\n二\n\n三', { maxHeight: 50 })

    expect(layout.truncated).toBe(true)
    // `第一段 [[甲]]` 显示为 `第一段 甲`：链接前有 4 个字（40px），行中线 10
    expect(
      findLinkAnchor({ layout, targets: ['甲'], metrics: METRICS, measure: TEN_PER_CHAR }),
    ).toEqual({ x: 40, y: 10, text: '甲' })
  })
})

describe('cardLocalToWorld', () => {
  it('用 cardChrome 的 padding/bodyTop：默认 metrics 下是 (10, 45.75)', () => {
    // 缺省行高 19 ⇒ 标题高 19 × 1.25 = 23.75 ⇒ 分隔线 10 + 23.75 + 6 = 39.75 ⇒ bodyTop = 45.75
    expect(cardLocalToWorld(CARD_RECT, { x: 30, y: 56 })).toEqual({ x: 140, y: 301.75 })
  })

  it('换一套 metrics 结果跟着变（bodyTop 不是写死的数）', () => {
    // 行高 20 ⇒ 标题高 25 ⇒ 分隔线 41 ⇒ bodyTop 47（比上面高 1.25px）
    expect(cardLocalToWorld(CARD_RECT, { x: 30, y: 56 }, METRICS)).toEqual({ x: 140, y: 303 })
  })
})

describe('rayRectExit', () => {
  const rect: Rect = { x: 0, y: 0, width: 100, height: 60 }
  const center: Point = { x: 50, y: 30 }

  it('从矩形内朝右上：落在上/右边界上，且在另一轴的范围内', () => {
    const exit = rayRectExit(rect, center, { x: 200, y: 10 })

    expect(exit.x).toBe(100) // 右边界，精确值（交点被贴回边界）
    expect(exit.y).toBeGreaterThanOrEqual(0)
    expect(exit.y).toBeLessThanOrEqual(60)
    expect(exit.y).toBeLessThan(center.y) // 确实"朝右上"
  })

  it('从矩形内朝左下：落在下边界上', () => {
    const exit = rayRectExit(rect, center, { x: -100, y: 200 })

    expect(exit.y).toBe(60)
    expect(exit.x).toBeGreaterThanOrEqual(0)
    expect(exit.x).toBeLessThanOrEqual(100)
    expect(exit.x).toBeLessThan(center.x)
  })

  it('正右 / 正下：只穿过一条边，另一轴不变', () => {
    expect(rayRectExit(rect, center, { x: 200, y: 30 })).toEqual({ x: 100, y: 30 })
    expect(rayRectExit(rect, center, { x: 50, y: 200 })).toEqual({ x: 50, y: 60 })
  })

  it('`from` 恰好是矩形的中心时不产生 NaN（朝哪边都能给出边界上的点）', () => {
    const exit = rayRectExit(rect, { x: 50, y: 30 }, { x: 150, y: 30 })

    expect(Number.isFinite(exit.x)).toBe(true)
    expect(Number.isFinite(exit.y)).toBe(true)
    expect(exit).toEqual({ x: 100, y: 30 })
  })

  it('退化方向（`to` 与 `from` 重合）给一个确定的结果，而不是 0/0', () => {
    // 缺省方向是 +x：结果仍然是"右边界上、与 from 同高"的那个点，逐字可重复
    expect(rayRectExit(rect, center, { x: 50, y: 30 })).toEqual({ x: 100, y: 30 })
  })

  it('`from` 在矩形外且射线背离矩形 ⇒ 原样返回 `from`（零长度引线，而不是 NaN）', () => {
    expect(rayRectExit(rect, { x: -50, y: 30 }, { x: -100, y: 30 })).toEqual({ x: -50, y: 30 })
  })
})

describe('tensionPath', () => {
  it('tension = 0 时是直线：两个控制点都在弦上（1/3 与 2/3 处）', () => {
    const start: Point = { x: 0, y: 0 }
    const end: Point = { x: 100, y: 50 }
    const { c1, c2 } = controlPoints(tensionPath(start, end, 0))

    // 离弦距离为 0 ⇒ 三点共线 ⇒ 整条曲线就是直线段
    expect(distanceToChord(start, end, c1)).toBeCloseTo(0, 6)
    expect(distanceToChord(start, end, c2)).toBeCloseTo(0, 6)
    // 控制点落在弦的 1/3、2/3 处：这是"张力滑到 0 时线不会跳一下"的原因
    expect(c1.x).toBeCloseTo(100 / 3, 10)
    expect(c1.y).toBeCloseTo(50 / 3, 10)
    expect(c2.x).toBeCloseTo(200 / 3, 10)
    expect(c2.y).toBeCloseTo(100 / 3, 10)
  })

  it('tension 越大控制点离弦越远，偏移量正好是 tension × 弦长 × 0.25', () => {
    const start: Point = { x: 0, y: 0 }
    const end: Point = { x: 300, y: 400 } // 弦长 500

    const near = controlPoints(tensionPath(start, end, 0.2)).c1
    const far = controlPoints(tensionPath(start, end, 0.8)).c1

    expect(distanceToChord(start, end, near)).toBeCloseTo(0.2 * 500 * 0.25, 6) // 25
    expect(distanceToChord(start, end, far)).toBeCloseTo(0.8 * 500 * 0.25, 6) // 100
    expect(distanceToChord(start, end, far)).toBeGreaterThan(distanceToChord(start, end, near))
  })

  it('起点与终点逐字出现在 d 里（端点必须能对回 anchor/exit）', () => {
    const d = tensionPath({ x: 10, y: 20 }, { x: 110, y: 60 }, 0.5)

    expect(d.startsWith('M 10 20')).toBe(true)
    expect(d.endsWith('110 60')).toBe(true)
  })

  it('弦长为 0（自环 / 卡片重叠）时不产生 NaN', () => {
    const d = tensionPath({ x: 10, y: 20 }, { x: 10, y: 20 }, 0.5)

    expect(d).toBe('M 10 20 L 10 20')
    expect(d.includes('NaN')).toBe(false)
  })
})

describe('linkEdgeGeometry', () => {
  const fromRect: Rect = { x: 0, y: 0, width: CARD_WIDTH, height: 200 }
  const toRect: Rect = { x: 400, y: 300, width: 200, height: 120 }

  it('端到端：anchor 在卡片里、exit/entry 在各自的边界上、两段路径的首尾点对得上', () => {
    const layout = card(THREE_PARA)
    const geometry = linkEdgeGeometry({
      edge: { toRawTarget: '甲', toRelPath: '甲.md', count: 1 },
      from: { rect: fromRect, layout, title: '甲卡' },
      to: { rect: toRect, title: '乙卡' },
      targets: ['甲'],
      metrics: METRICS,
      measure: TEN_PER_CHAR,
    })

    expect(geometry.fromLink).toBe(true)
    expect(geometry.matchedText).toBe('甲')
    // 卡片内 (20, 56) → 世界：x = 0 + 10 + 20、y = 0 + bodyTop(47) + 56
    expect(geometry.anchor).toEqual({ x: 30, y: 103 })

    // anchor 严格落在来源卡片里
    expect(geometry.anchor.x).toBeGreaterThan(fromRect.x)
    expect(geometry.anchor.x).toBeLessThan(fromRect.x + fromRect.width)
    expect(geometry.anchor.y).toBeGreaterThan(fromRect.y)
    expect(geometry.anchor.y).toBeLessThan(fromRect.y + fromRect.height)

    // 目标卡片在右下方 ⇒ 射线从**下边界**出去
    expect(geometry.exit.y).toBe(fromRect.y + fromRect.height)
    expect(geometry.exit.x).toBeGreaterThan(fromRect.x)
    expect(geometry.exit.x).toBeLessThan(fromRect.x + fromRect.width)

    // 入点在目标卡片的**左边界**上（它正对着 exit）
    expect(geometry.entry.x).toBe(toRect.x)
    expect(geometry.entry.y).toBeGreaterThanOrEqual(toRect.y)
    expect(geometry.entry.y).toBeLessThanOrEqual(toRect.y + toRect.height)

    // 引线是**直线**（不是曲线），且首尾点分别等于 anchor / exit
    expect(geometry.leadPath.split('L')).toHaveLength(2)
    expect(geometry.leadPath.includes('C')).toBe(false)
    expect(firstPoint(geometry.leadPath)).toEqual(geometry.anchor)
    expect(lastPoint(geometry.leadPath)).toEqual(geometry.exit)

    // 卡片外那段：首尾点分别等于 exit / entry
    expect(firstPoint(geometry.spanPath)).toEqual(geometry.exit)
    expect(lastPoint(geometry.spanPath)).toEqual(geometry.entry)
  })

  it('命中时用 occurrence 取值：取出的 anchor 跟着换一个点', () => {
    const layout = card(THREE_PARA)
    const base = {
      edge: { toRawTarget: '甲', toRelPath: '甲.md', count: 2 },
      from: { rect: fromRect, layout, title: '甲卡' },
      to: { rect: toRect, title: '乙卡' },
      targets: ['甲'],
      metrics: METRICS,
      measure: TEN_PER_CHAR,
    }

    // 卡片内 (20, 56) 与 (30, 82) → 世界 (10 + x, 47 + y) = (30, 103) 与 (40, 129)
    expect(linkEdgeGeometry({ ...base, occurrence: 0 }).anchor).toEqual({ x: 30, y: 103 })
    expect(linkEdgeGeometry({ ...base, occurrence: 1 }).anchor).toEqual({ x: 40, y: 129 })
  })

  it('layout 为 null（正文还没读到）⇒ 降级：fromLink false、引线为空、anchor 在朝目标的边界上', () => {
    const geometry = linkEdgeGeometry({
      edge: { toRawTarget: '甲', toRelPath: '甲.md', count: 1 },
      from: { rect: fromRect, layout: null, title: '甲卡' },
      to: { rect: toRect, title: '乙卡' },
      targets: ['甲'],
      metrics: METRICS,
      measure: TEN_PER_CHAR,
    })

    expect(geometry.fromLink).toBe(false)
    expect(geometry.matchedText).toBeNull()
    expect(geometry.leadPath).toBe('')
    // 降级时 anchor 与 exit 是同一个点：调用方不需要分支就能画
    expect(geometry.anchor).toEqual(geometry.exit)
    // 目标卡片在右下方 ⇒ 从右边界出去（中点方向：卡片中心朝目标中心）
    expect(geometry.exit.x).toBe(fromRect.x + fromRect.width)
    expect(geometry.exit.y).toBeGreaterThan(fromRect.y)
    expect(geometry.exit.y).toBeLessThan(fromRect.y + fromRect.height)
    // 卡片外那一段仍然是真的跨卡片段
    expect(firstPoint(geometry.spanPath)).toEqual(geometry.exit)
    expect(lastPoint(geometry.spanPath)).toEqual(geometry.entry)
  })

  it('正文里只有 Markdown 链接 ⇒ 同样降级（如实标注，不假装命中）', () => {
    const layout = card('见 [甲](甲.md)')
    const geometry = linkEdgeGeometry({
      edge: { toRawTarget: '甲', toRelPath: '甲.md', count: 1 },
      from: { rect: fromRect, layout, title: '甲卡' },
      to: { rect: toRect, title: '乙卡' },
      targets: ['甲'],
      metrics: METRICS,
      measure: TEN_PER_CHAR,
    })

    expect(geometry.fromLink).toBe(false)
    expect(geometry.matchedText).toBeNull()
    expect(geometry.leadPath).toBe('')
  })

  it('卡片排版变了（更宽 ⇒ 一行放得下）时 anchor 跟着变：几何是从排版结果推出来的', () => {
    const text = `${'一'.repeat(21)} [[甲]]`
    // 同一段正文、两种卡片宽度 ⇒ 两种折行 ⇒ 两个不同的锚点
    const wideRect: Rect = { x: 0, y: 0, width: 320, height: 200 }
    const narrowRect: Rect = { x: 0, y: 0, width: 170, height: 200 }

    // 外框 320 ⇒ 内容 300 ⇒ 23 个字一行放得下 ⇒ 链接在 (220, 10) → 世界 (230, 57)
    const wide = linkEdgeGeometry({
      edge: { toRawTarget: '甲', toRelPath: '甲.md', count: 1 },
      from: { rect: wideRect, layout: card(text, { width: 320 }), title: '甲卡' },
      to: { rect: toRect, title: '乙卡' },
      targets: ['甲'],
      metrics: METRICS,
      measure: TEN_PER_CHAR,
    })

    // 外框 170 ⇒ 内容 150 ⇒ 折成两行，第二行是 `一×6 + 空格 + 甲` ⇒ 链接在 (70, 30) → 世界 (80, 77)
    const narrow = linkEdgeGeometry({
      edge: { toRawTarget: '甲', toRelPath: '甲.md', count: 1 },
      from: { rect: narrowRect, layout: card(text, { width: 170 }), title: '甲卡' },
      to: { rect: toRect, title: '乙卡' },
      targets: ['甲'],
      metrics: METRICS,
      measure: TEN_PER_CHAR,
    })

    expect(wide.anchor).toEqual({ x: 230, y: 57 })
    expect(narrow.anchor).toEqual({ x: 80, y: 77 })
  })

  it('没命中时 entry 依然落在目标卡片边界上（降级只影响来源那一侧）', () => {
    const geometry = linkEdgeGeometry({
      edge: { toRawTarget: '甲', toRelPath: '甲.md', count: 1 },
      from: { rect: fromRect, layout: null, title: '甲卡' },
      to: { rect: toRect, title: '乙卡' },
      targets: ['甲'],
      metrics: METRICS,
    })

    const onVertical =
      geometry.entry.x === toRect.x || geometry.entry.x === toRect.x + toRect.width
    const onHorizontal =
      geometry.entry.y === toRect.y || geometry.entry.y === toRect.y + toRect.height
    expect(onVertical || onHorizontal).toBe(true)
    expect(geometry.entry.y).toBeGreaterThanOrEqual(toRect.y)
    expect(geometry.entry.y).toBeLessThanOrEqual(toRect.y + toRect.height)
  })
})

// ---------------------------------------------------------------------------
// 分界点：虚线在哪里交到卡片边界（用户那句话的判据全在这几条里）
// ---------------------------------------------------------------------------

/**
 * 用户的原话是"从 wiki 链接处虚线开始，卡片边缘处实线出连接到卡片"。
 * 这句话能拆成三个**坐标级**的判据，下面逐条钉：
 *
 * 1. 虚线的起点 = 链接文字的位置（在卡片**里**，不是卡片边缘、不是卡片中心）；
 * 2. 虚线的终点 = 分界点 = 卡片边界上"从起点朝目标中心那条射线"的交点（距离四条边最近的那条为 0）；
 * 3. 实线的第一个点 = 分界点（与虚线的终点逐坐标相同），最后一个点 = 目标卡片的入点。
 *
 * 本文件里的数字全部手算（0 不用实现里的常量拼），所以它证明的是"画法对不对"，
 * 而不是"实现有没有变"。卡片外框 220 ⇒ 内容宽 200 ⇒ 每行 20 个汉字（每字 10px）。
 */
describe('分界点：虚线在哪里交到卡片边界', () => {
  const fromRect: Rect = { x: 0, y: 0, width: CARD_WIDTH, height: 200 }
  const toRect: Rect = { x: 400, y: 300, width: 200, height: 120 }
  /** 目标卡片中心 —— `exit` / `entry` 的方向判据都从它出发（见 `linkEdgeGeometry`）。 */
  const toCenter: Point = { x: 500, y: 360 }

  /**
   * 本文件里那条边的几何：来源卡片在左上、目标在右下。
   *
   * `bodyTop = 47` 是手算出来的（内边距 10 + 标题 20×1.25 = 25 + 间距 6），
   * 所以卡片内坐标 `(x, y)` 对应的世界坐标恒是 `(rect.x + 10 + x, rect.y + 47 + y)`。
   */
  function geometryOf(
    options: {
      text?: string
      width?: number
      fromRect?: Rect
      toRect?: Rect
      occurrence?: number
    } = {},
  ) {
    const width = options.width ?? CARD_WIDTH
    return linkEdgeGeometry({
      edge: { toRawTarget: '甲', toRelPath: '甲.md', count: 1 },
      from: {
        rect: options.fromRect ?? fromRect,
        layout: card(options.text ?? THREE_PARA, { width }),
        title: '甲卡',
      },
      to: { rect: options.toRect ?? toRect, title: '乙卡' },
      targets: ['甲'],
      occurrence: options.occurrence,
      metrics: METRICS,
      measure: TEN_PER_CHAR,
    })
  }

  it('起点在链接文字上（卡片里），终点 = 射线与卡片边界的交点（与 rayRectExit 逐位相同）', () => {
    const geometry = geometryOf()

    // 起点：卡片内 (20, 56) ⇒ 世界 (0 + 10 + 20, 0 + 47 + 56) —— 它离卡片左边界还有 30px
    // （= 内边距 10 + 链接前那两个字符 `见 `），所以它不是"卡片边缘上的那个点"
    expect(geometry.anchor).toEqual({ x: 30, y: 103 })
    expect(geometry.anchor.x - fromRect.x).toBe(30)

    // 终点：目标在右下方 ⇒ 射线从**下边界**出去。
    //   手算：dx = 500 - 30 = 470、dy = 360 - 103 = 257；下边界 t = (200 - 103) / 257 = 97/257，
    //   此时 x = 30 + 470 × 97/257 = 207.3937741…（在 [0, 220] 内 ⇒ 这条边先被穿过）
    expect(geometry.exit.y).toBe(200)
    expect(geometry.exit.x).toBeCloseTo(30 + (470 * 97) / 257, 9)

    // 同一个交点在测试里独立算一遍（不经过实现）：两者必须逐位相同
    expect(geometry.exit).toEqual(rayRectExit(fromRect, geometry.anchor, toCenter))
  })

  it('分界点严格在边界上（离最近那条边 0px），起点严格在卡片里（离最近那条边 > 0）', () => {
    const geometry = geometryOf()

    expect(Math.abs(distanceToBorder(fromRect, geometry.exit))).toBeLessThan(0.5)
    expect(distanceToBorder(fromRect, geometry.anchor)).toBeGreaterThan(0.5)
    // 而且分界点不是起点自己（引线有真实的长度）
    expect(Math.hypot(geometry.exit.x - geometry.anchor.x, geometry.exit.y - geometry.anchor.y))
      .toBeGreaterThan(1)
  })

  it('引线整段都在卡片里：沿线上每一点都不冒到卡片外（边界那一点除外）', () => {
    const geometry = geometryOf()

    for (let step = 0; step <= 100; step += 1) {
      const t = step / 100
      const point = {
        x: geometry.anchor.x + (geometry.exit.x - geometry.anchor.x) * t,
        y: geometry.anchor.y + (geometry.exit.y - geometry.anchor.y) * t,
      }
      // 1e-9 的容差只用来吃浮点噪声：交点被 `snapTo` 贴回边界之后，t = 1 那一点离边界正好是 0
      expect(distanceToBorder(fromRect, point)).toBeGreaterThanOrEqual(-1e-9)
    }
  })

  it('两段首尾相接：实线的第一个点与虚线的最后一个点逐坐标相同（差 < 1e-9）', () => {
    const geometry = geometryOf()

    const leadEnd = lastPoint(geometry.leadPath)
    const spanStart = firstPoint(geometry.spanPath)
    expect(Math.abs(spanStart.x - leadEnd.x)).toBeLessThan(1e-9)
    expect(Math.abs(spanStart.y - leadEnd.y)).toBeLessThan(1e-9)
    // 两段的交点就是 `exit` 本身：分界点没有第二套口径
    expect(leadEnd).toEqual(geometry.exit)
    expect(spanStart).toEqual(geometry.exit)
  })

  it('实线一路连到目标卡片：最后一个点是 entry，且落在目标卡片的边界上', () => {
    const geometry = geometryOf()

    expect(lastPoint(geometry.spanPath)).toEqual(geometry.entry)
    expect(Math.abs(distanceToBorder(toRect, geometry.entry))).toBeLessThan(0.5)
    // 目标在右下方 ⇒ 从**左**边界进来（手算：左侧 t = (400 - 500) / (207.39… - 500) 最小）
    expect(geometry.entry.x).toBe(toRect.x)
    expect(geometry.entry.y).toBeGreaterThan(toRect.y)
    expect(geometry.entry.y).toBeLessThan(toRect.y + toRect.height)
  })

  it('链接靠右（同一行末尾）：分界点改落在**右**边界上，x 是卡片的右边界精确值', () => {
    // `一×18 + 空格 + 甲` = 20 个字 ⇒ 正好一行放得下；链接前有 19 个字符
    // 卡片内 (190, 10) ⇒ 世界 (200, 57)
    const geometry = geometryOf({ text: `${'一'.repeat(18)} [[甲]]` })

    expect(geometry.anchor).toEqual({ x: 200, y: 57 })
    // dx = 300、dy = 303：右边界 t = 20/300 = 1/15 ⇒ y = 57 + 303/15 = 77.2（在下边界之前）
    expect(geometry.exit.x).toBe(fromRect.x + fromRect.width)
    expect(geometry.exit.y).toBeCloseTo(77.2, 9)
    expect(Math.abs(distanceToBorder(fromRect, geometry.exit))).toBeLessThan(0.5)
  })

  it('链接折到第二行：分界点按第二行的锚点重算（仍然落在边界上）', () => {
    // `一×21 + 空格 + 甲`：第一行 20 个 `一`，第二行是 `一 空格 甲` ⇒ 链接在 (20, 30) ⇒ 世界 (30, 77)
    const geometry = geometryOf({ text: `${'一'.repeat(21)} [[甲]]` })

    expect(geometry.anchor).toEqual({ x: 30, y: 77 })
    // dx = 470、dy = 283：右边界 t = 190/470 = 19/47 ⇒ y = 77 + 283 × 19/47 = 191.4042553…
    expect(geometry.exit.x).toBe(fromRect.x + fromRect.width)
    expect(geometry.exit.y).toBeCloseTo(77 + (283 * 19) / 47, 9)
    expect(Math.abs(distanceToBorder(fromRect, geometry.exit))).toBeLessThan(0.5)
  })

  it('链接顶在行首：起点是**文字**的位置（内边距之内），不是卡片外框那一条边', () => {
    // `[[甲]] 开头`：链接是这一行的第一段 ⇒ 卡片内 x = 0 ⇒ 世界 x = 0 + 内边距 10
    const geometry = geometryOf({ text: '[[甲]] 开头' })

    expect(geometry.anchor).toEqual({ x: 10, y: 57 })
    expect(geometry.anchor.x).toBe(fromRect.x + 10)
    expect(geometry.anchor.x).toBeGreaterThan(fromRect.x)
    // 目标在右下方：dx = 490、dy = 303 ⇒ 右边界 t = 210/490 = 3/7 ⇒ y = 57 + 303 × 3/7 = 186.8571428…
    expect(geometry.exit.x).toBe(fromRect.x + fromRect.width)
    expect(geometry.exit.y).toBeCloseTo(57 + (303 * 3) / 7, 9)
  })

  it('目标在左上方：分界点落在**左**边界上（引线朝左走，仍然是同一条判据）', () => {
    const geometry = geometryOf({ toRect: { x: -400, y: -300, width: 200, height: 120 } })

    // 起点不变（它只由正文排版决定）：世界 (30, 103)
    expect(geometry.anchor).toEqual({ x: 30, y: 103 })
    // dx = -300 - 30 = -330、dy = -240 - 103 = -343：左边界 t = 30/330 = 1/11
    // ⇒ y = 103 - 343/11 = 71.8181818…（在上边界 t = 103/343 之前，所以这条边先被穿过）
    expect(geometry.exit.x).toBe(fromRect.x)
    expect(geometry.exit.y).toBeCloseTo(103 - 343 / 11, 9)
    expect(Math.abs(distanceToBorder(fromRect, geometry.exit))).toBeLessThan(0.5)
  })

  it('卡片被拖动（两张一起平移）：三个点与两段路径跟着平移，分界点仍在边界上', () => {
    const before = geometryOf()
    const dx = 120
    const dy = -45
    const moved = geometryOf({
      fromRect: { ...fromRect, x: fromRect.x + dx, y: fromRect.y + dy },
      toRect: { ...toRect, x: toRect.x + dx, y: toRect.y + dy },
    })

    // 整体平移是**严格**等距的：三个点各偏 (dx, dy)，差为 0（不是"差不多"）
    expect(moved.anchor.x - before.anchor.x).toBeCloseTo(dx, 9)
    expect(moved.anchor.y - before.anchor.y).toBeCloseTo(dy, 9)
    expect(moved.exit.x - before.exit.x).toBeCloseTo(dx, 9)
    expect(moved.exit.y - before.exit.y).toBeCloseTo(dy, 9)
    expect(moved.entry.x - before.entry.x).toBeCloseTo(dx, 9)
    expect(moved.entry.y - before.entry.y).toBeCloseTo(dy, 9)

    // 分界点跟着卡片走：它是**新**矩形边界上的点，不再是老矩形上的那个点
    const movedRect: Rect = { ...fromRect, x: fromRect.x + dx, y: fromRect.y + dy }
    expect(Math.abs(distanceToBorder(movedRect, moved.exit))).toBeLessThan(0.5)
    expect(Math.abs(moved.exit.y - before.exit.y)).toBeCloseTo(Math.abs(dy), 9)
  })

  it('只拖动来源卡片：分界点落在**新**矩形的边界上（用的是当前矩形，不是老位置）', () => {
    const movedRect: Rect = { ...fromRect, x: fromRect.x - 300 }
    const moved = geometryOf({ fromRect: movedRect })

    // 起点跟着卡片走：卡片内 (20, 56) ⇒ 世界 (-300 + 30, 103) = (-270, 103)
    expect(moved.anchor).toEqual({ x: -270, y: 103 })
    // dx = 500 - (-270) = 770、dy = 257：下边界 t = 97/257 ⇒ x = -270 + 770 × 97/257 = 20.62…
    // 越过了右边界（-80）⇒ 右边界 t = 190/770 = 19/77 先被穿过：y = 103 + 257 × 19/77 = 166.4155844…
    expect(moved.exit.x).toBe(movedRect.x + movedRect.width)
    expect(moved.exit.y).toBeCloseTo(103 + (257 * 19) / 77, 9)
    expect(Math.abs(distanceToBorder(movedRect, moved.exit))).toBeLessThan(0.5)
    // 老矩形上的那个点已经不在了（卡片被拖走之后再画在老边界上就是错的位置）
    expect(moved.exit.x).not.toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 引线虚线的相位（分界处不能留缝）
// ---------------------------------------------------------------------------

/**
 * 虚线的图案位置定义成 `p(s) = (s + strokeDashoffset) mod 周期`（SVG 的语义：
 * `stroke-dashoffset` 是"从图案的第几个像素开始画"）。`p` 落在 `[0, 实线段长度)` 就是有墨。
 *
 * 这两条判据合起来才是用户要的"卡片边缘处实线出"：
 * 1. **分界处必须有墨**（`p(L)` 正好落在实线段末尾 ⇒ 虚线一路画到卡片边界，不留缝）；
 * 2. 链接那一端最多只空 `空隙` 那么大 —— 它由起点那个半径 2 的圆点盖住（见渲染层）。
 */
describe('引线虚线的相位', () => {
  const DASH = 3
  const GAP = 3
  const PERIOD = DASH + GAP

  /** 图案位置（`s` 处的墨是第几段图案）。 */
  function patternAt(s: number, offset: number): number {
    return (((s + offset) % PERIOD) + PERIOD) % PERIOD
  }

  it('最后一段实线正好在卡片边界处收笔（分界处不会留下一段空隙）', () => {
    // 覆盖"长度 mod 6"的全部六种余数：0 / 1 / 2 / 3 / 4 / 5 都要能收在边界上
    for (const length of [3, 6, 7, 8, 9, 10.5, 12, 17.4, 30, 61.5, 200]) {
      const { segments, offset } = leadDash(length)

      expect(segments).toEqual([DASH, GAP])
      // 边界那一点正好落在"实线段结束"上
      expect(patternAt(length, offset)).toBeCloseTo(DASH, 9)
      // 边界**之前**的一小段仍然在实线段上 ⇒ 卡边附近确实有墨（这就是"不留缝"）
      expect(patternAt(length - 0.5, offset)).toBeLessThan(DASH)
      // 相位是非负数且在 [0, 周期) 内：负的偏移量在不同渲染器里的解释更绕，不给自己找麻烦
      expect(offset).toBeGreaterThanOrEqual(0)
      expect(offset).toBeLessThan(PERIOD)
    }
  })

  it('链接那一端的空隙不超过起点小圆点的直径（半径 2 ⇒ 4px）', () => {
    for (const length of [3, 6, 7, 8, 9, 10.5, 12, 17.4, 30, 61.5, 200]) {
      const { offset } = leadDash(length)
      // 从起点量到第一笔墨有多远：图案在实线段里就说明起点就有墨（空隙 0）
      const head = patternAt(0, offset)
      const startGap = head < DASH ? 0 : PERIOD - head
      expect(startGap).toBeLessThanOrEqual(GAP)
      expect(startGap).toBeLessThanOrEqual(4) // 圆点直径
    }
  })

  it('相位是可重复的：同一条引线每次算出来逐位相同（重算不会让虚线跳动）', () => {
    expect(leadDash(37.25)).toEqual(leadDash(37.25))
    // 长度合法化：NaN / 负数 / 0 都按 0 处理，不产生 NaN 的相位
    expect(leadDash(Number.NaN).offset).toBe(leadDash(0).offset)
    expect(leadDash(-5).offset).toBe(leadDash(0).offset)
    expect(Number.isFinite(leadDash(Number.POSITIVE_INFINITY).offset)).toBe(true)
  })
})
