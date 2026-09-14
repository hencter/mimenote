/**
 * 画笔（`features/graph/canvas/paint.ts`）与它的两个邻居（`palette.ts` / `measure.ts`）。
 *
 * 测试用的是一个**记录型假上下文**：每次绘制调用与每次属性赋值都按顺序 push 进数组。
 * 为什么不用真画布（jsdom + node-canvas）：这一层要钉的性质几乎全是"**顺序与状态**"——
 * 先画边后画卡片、`save`/`restore` 配平、画这段文字时用的是哪个 `font`/`fillStyle`、
 * 屏幕外的卡片一次都不画。这些在假上下文上是**逐字**可断言的字面量，
 * 而在真画布上只能靠抓像素去猜（还会把"字体渲染"与"绘制逻辑"两件事混在一起）。
 *
 * 断言只写在两处来源上：
 * 1. **字面量**（`'600 15px system-ui, sans-serif'`、`0.45`、矩形坐标）——手算出来的期望值；
 * 2. **排版层给出的数字**（`rowHeights`、`markerWidth`、`chrome.bodyTop`）——
 *    画笔与排版的接口就是这些数，断言它们之间的一致性才有意义。
 * 绝不从画笔的实现里反推期望值（那样的测试只能证明"实现没变"）。
 */

import { describe, expect, it } from 'vitest'

import { CALLOUT_TYPES } from '@/domain/callouts'
import type { DrawBlock } from '@/features/graph/canvas/blocks'
import {
  CARD_PADDING,
  canvasMeasure,
  cardChrome,
  createCardLayoutCache,
  fontString,
  layoutCard,
  type CardLayout,
  type MeasureText,
} from '@/features/graph/canvas/measure'
import { calloutAccent, paletteFrom, type GraphPalette } from '@/features/graph/canvas/palette'
import {
  paintGraph,
  type PaintContext,
  type PaintEdge,
  type PaintInput,
  type PaintNode,
  type PaintStats,
  type ViewTransform,
} from '@/features/graph/canvas/paint'
import {
  DEFAULT_METRICS,
  layoutBlocks,
  totalHeight,
  type LaidOutBlock,
} from '@/features/graph/canvas/text-layout'
import type { Rect } from '@/features/graph/layout'

// ---------------------------------------------------------------------------
// 记录型假上下文
// ---------------------------------------------------------------------------

/** 每条绘制调用的记录。属性赋值也在这里（`op: 'prop'`），因为它们同样决定观感。 */
type Op =
  | { readonly op: 'prop'; readonly name: string; readonly value: string | number }
  | { readonly op: 'save' }
  | { readonly op: 'restore' }
  | { readonly op: 'setTransform' }
  | { readonly op: 'beginPath' }
  | { readonly op: 'closePath' }
  | { readonly op: 'clip' }
  | { readonly op: 'rect'; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  | { readonly op: 'moveTo'; readonly x: number; readonly y: number }
  | { readonly op: 'lineTo'; readonly x: number; readonly y: number }
  | {
      readonly op: 'arc'
      readonly x: number
      readonly y: number
      readonly radius: number
      readonly startAngle: number
      readonly endAngle: number
    }
  | { readonly op: 'fill' }
  | { readonly op: 'stroke' }
  | { readonly op: 'fillRect'; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  | {
      readonly op: 'strokeRect'
      readonly x: number
      readonly y: number
      readonly width: number
      readonly height: number
    }
  | { readonly op: 'fillText'; readonly text: string; readonly x: number; readonly y: number }
  | { readonly op: 'measureText'; readonly text: string }
  | { readonly op: 'setLineDash'; readonly segments: readonly number[] }

/** 某个时刻的画笔状态（属性 + 虚线）。 */
type PropState = Readonly<Record<string, string | number>>

/** 画布的初始状态（与真 canvas 的初值一致，否则"没有显式设置"的断言会凭空通过）。 */
const INITIAL_STATE: PropState = {
  font: '10px sans-serif',
  fillStyle: '#000000',
  strokeStyle: '#000000',
  lineWidth: 1,
  globalAlpha: 1,
  textAlign: 'start',
  textBaseline: 'alphabetic',
  lineJoin: 'miter',
  lineDash: '',
}

/**
 * 记录型假上下文。
 *
 * `stateAt(index)` 把此前的属性赋值与 `save`/`restore` **重放**一遍，于是"画这段文字时用的是哪个
 * 字体/颜色"可以被直接断言 —— 而不是去属性赋值的历史里猜哪一次算数。
 * 重放同时实现 `save`/`restore` 的栈语义（真 canvas 会把状态存起来），所以它顺手也验证了配对。
 */
class RecordingContext implements PaintContext {
  readonly ops: Op[] = []
  private readonly props = new Map<string, Array<string | number>>()

  get font(): string {
    return this.stringProp('font')
  }
  set font(value: string) {
    this.recordProp('font', value)
  }

  get fillStyle(): string {
    return this.stringProp('fillStyle')
  }
  set fillStyle(value: string) {
    this.recordProp('fillStyle', value)
  }

  get strokeStyle(): string {
    return this.stringProp('strokeStyle')
  }
  set strokeStyle(value: string) {
    this.recordProp('strokeStyle', value)
  }

  get lineWidth(): number {
    return this.numberProp('lineWidth')
  }
  set lineWidth(value: number) {
    this.recordProp('lineWidth', value)
  }

  get globalAlpha(): number {
    return this.numberProp('globalAlpha')
  }
  set globalAlpha(value: number) {
    this.recordProp('globalAlpha', value)
  }

  get textAlign(): string {
    return this.stringProp('textAlign')
  }
  set textAlign(value: string) {
    this.recordProp('textAlign', value)
  }

  get textBaseline(): string {
    return this.stringProp('textBaseline')
  }
  set textBaseline(value: string) {
    this.recordProp('textBaseline', value)
  }

  get lineJoin(): string {
    return this.stringProp('lineJoin')
  }
  set lineJoin(value: string) {
    this.recordProp('lineJoin', value)
  }

  save(): void {
    this.ops.push({ op: 'save' })
  }
  restore(): void {
    this.ops.push({ op: 'restore' })
  }
  /** 参数刻意不记：画笔**不该**调用它（DPR 由调用方处理），测试断言的是"一次都没调过"。 */
  setTransform(): void {
    this.ops.push({ op: 'setTransform' })
  }
  beginPath(): void {
    this.ops.push({ op: 'beginPath' })
  }
  closePath(): void {
    this.ops.push({ op: 'closePath' })
  }
  clip(): void {
    this.ops.push({ op: 'clip' })
  }
  rect(x: number, y: number, width: number, height: number): void {
    this.ops.push({ op: 'rect', x, y, width, height })
  }
  moveTo(x: number, y: number): void {
    this.ops.push({ op: 'moveTo', x, y })
  }
  lineTo(x: number, y: number): void {
    this.ops.push({ op: 'lineTo', x, y })
  }
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void {
    this.ops.push({ op: 'arc', x, y, radius, startAngle, endAngle })
  }
  fill(): void {
    this.ops.push({ op: 'fill' })
  }
  stroke(): void {
    this.ops.push({ op: 'stroke' })
  }
  fillRect(x: number, y: number, width: number, height: number): void {
    this.ops.push({ op: 'fillRect', x, y, width, height })
  }
  strokeRect(x: number, y: number, width: number, height: number): void {
    this.ops.push({ op: 'strokeRect', x, y, width, height })
  }
  fillText(text: string, x: number, y: number): void {
    this.ops.push({ op: 'fillText', text, x, y })
  }
  /** 固定宽度（每字符 5px）：这一份的用途是验 `canvasMeasure` 的缓存与"先设字体再量"。 */
  measureText(text: string): { width: number } {
    this.ops.push({ op: 'measureText', text })
    return { width: Array.from(text).length * 5 }
  }
  setLineDash(segments: number[]): void {
    this.ops.push({ op: 'setLineDash', segments: [...segments] })
  }

  /** 第 `index` 条 op **执行时**的画笔状态（重放属性赋值与 save/restore 栈）。 */
  stateAt(index: number): PropState {
    let state: Record<string, string | number> = { ...INITIAL_STATE }
    const stack: Array<Record<string, string | number>> = []
    this.ops.forEach((op, position) => {
      if (position > index) return
      if (op.op === 'prop') {
        state = { ...state, [op.name]: op.value }
        return
      }
      if (op.op === 'setLineDash') {
        state = { ...state, lineDash: op.segments.join(',') }
        return
      }
      if (op.op === 'save') {
        stack.push({ ...state })
        return
      }
      if (op.op === 'restore') {
        state = stack.pop() ?? state
      }
    })
    return state
  }

  private recordProp(name: string, value: string | number): void {
    this.ops.push({ op: 'prop', name, value })
    const list = this.props.get(name)
    if (list === undefined) this.props.set(name, [value])
    else list.push(value)
  }

  private last(name: string): string | number | undefined {
    return this.props.get(name)?.at(-1)
  }

  private stringProp(name: string): string {
    const value = this.last(name)
    return typeof value === 'string' ? value : ''
  }

  private numberProp(name: string): number {
    const value = this.last(name)
    return typeof value === 'number' ? value : 0
  }
}

// ---------------------------------------------------------------------------
// 断言辅助
// ---------------------------------------------------------------------------

function countOps(context: RecordingContext, name: Op['op']): number {
  return context.ops.filter((op) => op.op === name).length
}

/** 属性赋值过的所有值（按顺序），用来断言"设过某个字体/颜色"。 */
function propValues(context: RecordingContext, name: string): Array<string | number> {
  return context.ops.flatMap((op) => (op.op === 'prop' && op.name === name ? [op.value] : []))
}

function textsOf(context: RecordingContext): string[] {
  return context.ops.flatMap((op) => (op.op === 'fillText' ? [op.text] : []))
}

/** 画某段文字**时**的画笔状态（没有画过就抛，免得断言对着空对象通过）。 */
function stateAtText(context: RecordingContext, text: string): PropState {
  const index = context.ops.findIndex((op) => op.op === 'fillText' && op.text === text)
  if (index < 0) throw new Error(`这一帧没有画过文字：${text}`)
  return context.stateAt(index)
}

/**
 * 从状态快照里读一个字符串属性。
 *
 * `PropState` 是 `Record<string, string | number>` + `noUncheckedIndexedAccess`，直接读出来是
 * `string | number | undefined`；颜色/字体这些字段一定是字符串，这里收窄一次，
 * 免得每组断言都写一遍 `String(...)`（那会让"没设过"这件事变得看不出来）。
 */
function stateString(state: PropState, name: string): string {
  const value = state[name]
  return typeof value === 'string' ? value : ''
}

/** 每次 `fill` / `fillRect` **当时**的 `fillStyle`（断言"底色用了哪个令牌"）。 */
function fillStyles(context: RecordingContext): string[] {
  return context.ops.flatMap((op, index) =>
    op.op === 'fill' || op.op === 'fillRect' ? [stateString(context.stateAt(index), 'fillStyle')] : [],
  )
}

/** 每一次 `clip()` 之前那个 `rect()` 的矩形（卡片一次、代码超宽行一次、图片标签一次）。 */
function clipRects(context: RecordingContext): Rect[] {
  const rects: Rect[] = []
  context.ops.forEach((op, index) => {
    if (op.op !== 'clip') return
    for (let scan = index - 1; scan >= 0; scan -= 1) {
      const previous = context.ops[scan]
      if (previous === undefined) break
      if (previous.op === 'rect') {
        rects.push({ x: previous.x, y: previous.y, width: previous.width, height: previous.height })
        break
      }
      if (previous.op !== 'beginPath') break
    }
  })
  return rects
}

/** 水平线的 y（`moveTo` 与紧跟的 `lineTo` 同 y 的那些）。 */
function horizontalLineYs(context: RecordingContext): number[] {
  return context.ops.flatMap((op, index) => {
    if (op.op !== 'moveTo') return []
    const next = context.ops[index + 1]
    return next !== undefined && next.op === 'lineTo' && next.y === op.y ? [op.y] : []
  })
}

/** 垂直线的 x。 */
function verticalLineXs(context: RecordingContext): number[] {
  return context.ops.flatMap((op, index) => {
    if (op.op !== 'moveTo') return []
    const next = context.ops[index + 1]
    return next !== undefined && next.op === 'lineTo' && next.x === op.x ? [op.x] : []
  })
}

/** 每一次 `save()` 都要有配对的 `restore()`（不配对的 `clip` 会把后面所有卡片裁没）。 */
function expectBalancedSaveRestore(context: RecordingContext): void {
  expect(countOps(context, 'save')).toBe(countOps(context, 'restore'))
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/**
 * 假测量：每字符 7px、按字号等比缩放。
 *
 * 只让"宽度"这件事在断言里看得见（比如"这行代码比卡片宽"），不做像素级像素比对 ——
 * 真字体的宽度是画笔与排版**共用**的，不需要在这里再验一遍。
 */
const measure: MeasureText = (text, font) =>
  Array.from(text).length * 7 * (font.size / DEFAULT_METRICS.fontSize)

/** 调色板用一组"哨兵色"：断言里出现 `#090909` 就一定是 `codeBg` 被用到了，不可能是撞色。 */
const palette: GraphPalette = {
  background: '#010101',
  cardBg: '#020202',
  cardBorder: '#030303',
  cardBorderFocus: '#040404',
  title: '#050505',
  text: '#060606',
  muted: '#070707',
  link: '#080808',
  codeBg: '#090909',
  codeText: '#0a0a0a',
  quoteBorder: '#0b0b0b',
  edge: '#0c0c0c',
  edgeActive: '#0d0d0d',
  imageBox: '#0e0e0e',
}

const VIEW: ViewTransform = { scale: 1, offsetX: 0, offsetY: 0, width: 800, height: 600 }

const CARD_WIDTH = DEFAULT_METRICS.width + CARD_PADDING * 2

function paragraph(text: string): DrawBlock {
  return { kind: 'paragraph', runs: [{ text }] }
}

/** 一次绘制：用记录型上下文跑一遍 `paintGraph`。 */
function paint(overrides: Partial<PaintInput> = {}): {
  context: RecordingContext
  stats: PaintStats
} {
  const context = new RecordingContext()
  const stats = paintGraph(context, {
    transform: VIEW,
    nodes: [],
    edges: [],
    palette,
    measure,
    mode: 'focus',
    selected: null,
    hovered: null,
    metrics: DEFAULT_METRICS,
    ...overrides,
  })
  return { context, stats }
}

/** 一张排好版的卡片（正文按 `DEFAULT_METRICS` 排，所以画笔也用同一份 metrics）。 */
function noteCard(options: {
  relPath?: string
  title?: string
  blocks?: readonly DrawBlock[]
  x?: number
  y?: number
  rect?: Rect
  hasFocus?: boolean
}): PaintNode {
  const blocks = options.blocks ?? [paragraph('正文')]
  const laidOut = layoutBlocks(blocks, DEFAULT_METRICS, measure)
  const height = cardChrome(DEFAULT_METRICS).bodyTop + totalHeight(laidOut) + CARD_PADDING
  const relPath = options.relPath ?? 'note.md'
  const title = options.title ?? '笔记'
  return {
    relPath,
    title,
    rect: options.rect ?? { x: options.x ?? 100, y: options.y ?? 100, width: CARD_WIDTH, height },
    hop: 0,
    isRoot: false,
    hasFocus: options.hasFocus ?? false,
    layout: { relPath, title, width: CARD_WIDTH, height, blocks: laidOut, truncated: false },
  }
}

/** 全库模式的紧凑卡片（`layout === null`，只有调用方折好的几行纯文本）。 */
function compactCard(options: {
  relPath: string
  title: string
  rect: Rect
  lines: readonly string[]
}): PaintNode {
  return {
    relPath: options.relPath,
    title: options.title,
    rect: options.rect,
    hop: 1,
    isRoot: false,
    hasFocus: false,
    layout: null,
    compactLines: options.lines,
  }
}

/** 一行的纯文本（把 run 拼回去，断言"画了哪一行"最直观）。 */
function lineText(item: LaidOutBlock | undefined): string {
  return (item?.lines ?? []).map((line) => line.runs.map((run) => run.text).join('')).join('|')
}

function bodyHeight(blocks: readonly LaidOutBlock[]): number {
  return blocks.reduce(
    (sum, item, index) => sum + item.height + (index < blocks.length - 1 ? item.gapAfter : 0),
    0,
  )
}

// ---------------------------------------------------------------------------
// 调色板
// ---------------------------------------------------------------------------

describe('paletteFrom / calloutAccent', () => {
  it('令牌全是 null 时整块退到内置深色主题的兜底值（已声明为深色、可读）', () => {
    const fallback = paletteFrom(() => null)

    expect(fallback).toEqual({
      background: '#14161a',
      cardBg: '#1b1e24',
      cardBorder: '#272b33',
      cardBorderFocus: '#7aa2f7',
      title: '#7aa2f7',
      text: '#d7dce5',
      muted: '#98a2b3',
      link: '#7dcfff',
      codeBg: '#1b1f27',
      codeText: '#d7dce5',
      quoteBorder: '#3a4358',
      edge: '#6b7480',
      edgeActive: '#7aa2f7',
      imageBox: '#1b1e24',
    })
  })

  it('给了值的令牌原样返回（不 trim）；空串 / 纯空白算没给，走兜底；每个字段都真的问过令牌', () => {
    const asked: string[] = []
    const result = paletteFrom((name) => {
      asked.push(name)
      if (name === '--mn-bg') return '  #001122  '
      if (name === '--mn-fg') return '   '
      return ''
    })

    expect(result.background).toBe('  #001122  ')
    expect(result.text).toBe('#d7dce5')
    expect(result.cardBorder).toBe('#272b33')
    // 14 个字段各问一次：没有哪个字段偷懒直接用常量（那样换主题时它会永远停在兜底上）
    expect(asked).toHaveLength(14)
    expect(asked.every((name) => name.startsWith('--mn-'))).toBe(true)
    expect(asked).toContain('--mn-quote-border')
    expect(asked).toContain('--mn-fg-subtle')
    expect(asked).toContain('--mn-code-bg')
  })

  it('calloutAccent：问的是 CALLOUT_TYPES 里那个类型的令牌名，未知类型回落 note', () => {
    const asked: string[] = []
    const token = (name: string): string | null => {
      asked.push(name)
      return `色:${name}`
    }

    expect(calloutAccent(token, 'warning')).toBe(`色:${CALLOUT_TYPES.warning.token}`)
    expect(calloutAccent(token, 'abstract')).toBe(`色:${CALLOUT_TYPES.abstract.token}`)
    // 用户手写的类型名 / 原型上的名字都不能当"认识这种 callout"
    expect(calloutAccent(token, '摘录')).toBe(`色:${CALLOUT_TYPES.note.token}`)
    expect(calloutAccent(token, 'constructor')).toBe(`色:${CALLOUT_TYPES.note.token}`)
    expect(asked[0]).toBe('--mn-callout-warning')
  })

  it('calloutAccent：类型令牌读不到时退到引用竖线那一档（与 app.css 的兜底一致），不抛', () => {
    const neutral = calloutAccent(() => null, 'tip')

    expect(neutral).toBe(calloutAccent(() => null, 'danger'))
    expect(neutral).toBe(paletteFrom(() => null).quoteBorder)
    // 第二档：`--mn-callout-accent`（调用方可以给它一个"挂了 callout 类的探针元素"的实现）
    expect(calloutAccent((name) => (name === '--mn-callout-accent' ? '#123456' : null), 'tip')).toBe(
      '#123456',
    )
  })
})

// ---------------------------------------------------------------------------
// 字体串与量宽
// ---------------------------------------------------------------------------

describe('fontString / canvasMeasure', () => {
  it('fontString：CSS 的 style/weight/size/family 顺序；等宽不跟着传进来的族走', () => {
    expect(fontString({ size: 15, bold: true })).toBe('600 15px system-ui, sans-serif')
    expect(fontString({ size: 13 })).toBe('13px system-ui, sans-serif')
    expect(fontString({ size: 13, italic: true })).toBe('italic 13px system-ui, sans-serif')
    expect(fontString({ size: 13, bold: true, italic: true })).toBe(
      'italic 600 13px system-ui, sans-serif',
    )

    const code = fontString({ size: 13, code: true }, '自定义族')
    expect(code).toBe("13px 'Cascadia Code', Consolas, ui-monospace, monospace")
    expect(code).not.toContain('自定义族')
  })

  it('canvasMeasure：同一 (字体, 字符串) 只量一次，量之前先把 font 设成同一个串', () => {
    const context = new RecordingContext()
    const measureText = canvasMeasure(context)

    const first = measureText('甲乙', { size: 13 })
    const again = measureText('甲乙', { size: 13 })

    expect(again).toBe(first)
    expect(countOps(context, 'measureText')).toBe(1)
    // 不同字体不是同一个缓存项（否则粗体那段会按正常体的宽度折行）
    measureText('甲乙', { size: 20 })
    expect(countOps(context, 'measureText')).toBe(2)
    // 量之前设过字体：这条顺序错了的话，"量出来的宽度"与"画出来的字体"是两回事
    expect(propValues(context, 'font').slice(0, 2)).toEqual([
      fontString({ size: 13 }),
      fontString({ size: 20 }),
    ])
  })
})

// ---------------------------------------------------------------------------
// 卡片排版
// ---------------------------------------------------------------------------

describe('layoutCard', () => {
  it('正文经 toDrawBlocks + layoutBlocks 出块；高度含标题行与内边距', () => {
    const card = layoutCard({
      relPath: 'a.md',
      title: '甲',
      text: '# 大标题\n\n正文一段',
      width: 260,
      measure,
    })

    expect(card.blocks.map((item) => item.block.kind)).toEqual(['heading', 'paragraph'])
    expect(card.title).toBe('甲')
    expect(card.relPath).toBe('a.md')
    expect(card.truncated).toBe(false)
    expect(card.width).toBe(260)
    // 卡片外框高度 = 正文起点 + 正文高 + 底部内边距（与画笔"正文从 bodyTop 起画"是同一个口径）
    expect(card.height).toBeCloseTo(
      cardChrome(DEFAULT_METRICS).bodyTop + bodyHeight(card.blocks) + CARD_PADDING,
    )
  })

  it('超过 maxHeight 时按块截断、末尾补一行 …，且保留的都是完整的块', () => {
    const text = '# 标题\n\n第一段\n\n第二段'
    const full = layoutCard({ relPath: 'a.md', title: '甲', text, width: 260, measure })
    // 正好放得下"标题 + 第一段"的正文区高度
    const limit = (full.blocks[0]?.height ?? 0) + (full.blocks[0]?.gapAfter ?? 0) + (full.blocks[1]?.height ?? 0)

    const cut = layoutCard({ relPath: 'a.md', title: '甲', text, width: 260, measure, maxHeight: limit })

    expect(cut.truncated).toBe(true)
    expect(cut.blocks.map((item) => item.block.kind)).toEqual(['heading', 'paragraph'])
    expect(lineText(cut.blocks[cut.blocks.length - 1])).toBe('…')
    // 省略号那一行本身是一整行（不是把某个块切一半），且总高没有超过上限
    expect(cut.blocks[cut.blocks.length - 1]?.height).toBe(DEFAULT_METRICS.lineHeight)
    expect(bodyHeight(cut.blocks)).toBeLessThanOrEqual(limit)
    // 保留的块与未截断时逐块一致（截断发生在块的边界上）
    expect(cut.blocks[0]?.height).toBe(full.blocks[0]?.height)

    const roomy = layoutCard({ relPath: 'a.md', title: '甲', text, width: 260, measure, maxHeight: 10_000 })
    expect(roomy.truncated).toBe(false)
    expect(textsOfLayout(roomy)).not.toContain('…')
  })
})

/** 一份排版结果里所有行的纯文本（断言"没有省略号"用）。 */
function textsOfLayout(card: CardLayout): string[] {
  return card.blocks.flatMap((item) =>
    item.lines.map((line) => line.runs.map((run) => run.text).join('')),
  )
}

describe('createCardLayoutCache', () => {
  const key = { relPath: 'a.md', title: '甲', text: '正文', width: 200 }

  it('命中缓存时 build 只调一次（返回同一个引用），clear 之后重新排', () => {
    const cache = createCardLayoutCache()
    let builds = 0
    const build = (): CardLayout => {
      builds += 1
      return layoutCard({ ...key, measure })
    }

    const first = cache.get(key, build)
    const second = cache.get(key, build)

    expect(builds).toBe(1)
    expect(second).toBe(first)
    expect(cache.size).toBe(1)

    cache.clear()
    expect(cache.size).toBe(0)
    cache.get(key, build)
    expect(builds).toBe(2)
  })

  it('超过 maxEntries 时按插入序淘汰最早的那一条（不是最近最少使用）', () => {
    const cache = createCardLayoutCache({ maxEntries: 2 })
    const builds = new Map<string, number>()
    const ref = (relPath: string) => ({ relPath, title: relPath, text: '正文', width: 200 })
    const build = (relPath: string) => (): CardLayout => {
      builds.set(relPath, (builds.get(relPath) ?? 0) + 1)
      return layoutCard({ ...ref(relPath), measure })
    }

    cache.get(ref('a.md'), build('a.md'))
    cache.get(ref('b.md'), build('b.md'))
    cache.get(ref('c.md'), build('c.md'))

    expect(cache.size).toBe(2)
    // `a.md` 最早插入 ⇒ 已被淘汰；再问一次必须重新排
    cache.get(ref('a.md'), build('a.md'))
    expect(builds.get('a.md')).toBe(2)
    expect(cache.size).toBe(2)
    // `c.md` 还在（按插入序淘汰，而不是按访问时间）
    cache.get(ref('c.md'), build('c.md'))
    expect(builds.get('c.md')).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 画笔：整体契约
// ---------------------------------------------------------------------------

describe('paintGraph：整体契约', () => {
  it('先画边后画卡片；卡片按数组顺序、每张的标题都被画出来', () => {
    const first = noteCard({ relPath: 'a.md', title: '甲', x: 100, y: 100 })
    const second = noteCard({ relPath: 'b.md', title: '乙', x: 500, y: 100 })
    const edges: PaintEdge[] = [
      { from: { x: 240, y: 150 }, to: { x: 640, y: 150 }, muted: false },
      { from: { x: 240, y: 170 }, to: { x: 640, y: 170 }, muted: true },
    ]

    const { context, stats } = paint({ nodes: [first, second], edges })

    expect(stats).toEqual({ cards: 2, edges: 2, culled: 0 })
    // 边（stroke）全部发生在第一张卡片的底色（fill）之前 —— 卡片要盖住穿过它的线段
    const firstStroke = context.ops.findIndex((op) => op.op === 'stroke')
    expect(firstStroke).toBeGreaterThanOrEqual(0)
    expect(firstFillIndexOf(context, palette.cardBg)).toBeGreaterThan(firstStroke)
    // 标题顺序 = 数组顺序（后画的在上）
    expect(textsOf(context).filter((text) => text === '甲' || text === '乙')).toEqual(['甲', '乙'])
    expectBalancedSaveRestore(context)
  })

  it('屏幕外的卡片与不在 visible 里的卡片都不画，只计入 culled', () => {
    const visible = noteCard({ relPath: 'in.md', title: '里', x: 10, y: 10 })
    const offscreen = noteCard({ relPath: 'out.md', title: '外', rect: { x: -900, y: -900, width: 200, height: 100 } })
    const hidden = noteCard({ relPath: 'hidden.md', title: '隐', x: 400, y: 300 })

    const { context, stats } = paint({
      nodes: [visible, offscreen, hidden],
      visible: new Set(['in.md', 'out.md']),
    })

    expect(stats.cards).toBe(1)
    expect(stats.culled).toBe(2)
    expect(textsOf(context)).toContain('里')
    expect(textsOf(context)).not.toContain('外')
    expect(textsOf(context)).not.toContain('隐')
    // 被跳过的卡片一次绘制调用都没有（连裁剪都没做）：整帧只画了那一张卡片的标题与正文
    expect(clipRects(context)).toHaveLength(1)
    expect(textsOf(context)).toEqual(['里', '正文'])
  })

  it('贴边卡片的 clip 矩形就是卡片矩形（不随视口收缩）', () => {
    const rect: Rect = { x: -60, y: -40, width: 300, height: 200 }
    const { context, stats } = paint({ nodes: [noteCard({ relPath: 'edge.md', rect })] })

    expect(stats.cards).toBe(1)
    expect(stats.culled).toBe(0)
    expect(clipRects(context)).toEqual([{ x: -60, y: -40, width: 300, height: 200 }])
  })

  it('每次 save 都配对 restore；一次都不调用 setTransform（DPR 归调用方）', () => {
    const longCode = 'const value = "一行很长很长的代码用来超过卡片的宽度，再长一点就更稳妥了"'
    const node = noteCard({
      blocks: [
        paragraph('正文'),
        { kind: 'code', language: 'ts', lines: [longCode] },
        { kind: 'image', alt: '图', src: 'a.png', width: 300, height: 200 },
      ],
    })

    const { context } = paint({ nodes: [node], edges: [{ from: { x: 240, y: 150 }, to: { x: 400, y: 400 }, muted: false }] })

    expect(countOps(context, 'setTransform')).toBe(0)
    expectBalancedSaveRestore(context)
    // 卡片自己一次 + 代码超宽行的嵌套裁剪 + 图片标签的裁剪 —— 至少三处 save/restore
    expect(countOps(context, 'save')).toBeGreaterThanOrEqual(3)
    expect(countOps(context, 'clip')).toBeGreaterThanOrEqual(3)
    // 一帧结束时透明度必须复位（留在 0.45 会让下一帧整张卡半透明）
    const last = context.ops.length - 1
    expect(context.stateAt(last).globalAlpha).toBe(1)
  })

  it('确定性：同一份输入两次绘制得到逐字相同的调用序列', () => {
    const nodes = [
      noteCard({ relPath: 'a.md', title: '甲', x: 100, y: 100 }),
      noteCard({ relPath: 'b.md', title: '乙', x: 500, y: 100 }),
    ]
    const edges: PaintEdge[] = [{ from: { x: 240, y: 150 }, to: { x: 640, y: 150 }, muted: true }]

    const first = paint({ nodes, edges, hovered: 'a.md' })
    const second = paint({ nodes, edges, hovered: 'a.md' })

    expect(second.context.ops).toEqual(first.context.ops)
  })

  it('scale / offset 换算：卡片矩形、标题位置都按世界坐标放大平移', () => {
    const transform: ViewTransform = { scale: 2, offsetX: 100, offsetY: 50, width: 800, height: 600 }
    const node = noteCard({ relPath: 'a.md', title: '甲', rect: { x: 10, y: 20, width: 100, height: 60 } })

    const { context, stats } = paint({ nodes: [node], transform })

    expect(stats.cards).toBe(1)
    expect(clipRects(context)).toEqual([{ x: 120, y: 90, width: 200, height: 120 }])
    const title = context.ops.find((op) => op.op === 'fillText' && op.text === '甲')
    expect(title?.op === 'fillText' ? title.x : null).toBe(120 + CARD_PADDING * 2)
    // 标题中线的 y = 卡片顶 + (内边距 + 标题行高/2) × 2
    const chrome = cardChrome(DEFAULT_METRICS)
    expect(title?.op === 'fillText' ? title.y : null).toBeCloseTo(
      90 + (chrome.padding + chrome.titleHeight / 2) * 2,
    )
  })
})

// ---------------------------------------------------------------------------
// 画笔：块
// ---------------------------------------------------------------------------

describe('paintGraph：正文块', () => {
  it('行内样式：bold run 用更粗的 font 串、code run 画 codeBg 的小底并用 codeText', () => {
    const blocks: DrawBlock[] = [
      {
        kind: 'paragraph',
        runs: [{ text: '普通 ' }, { text: '加粗', bold: true }, { text: '代码', code: true }],
      },
    ]

    const { context } = paint({ nodes: [noteCard({ blocks })] })

    expect(stateAtText(context, '普通 ').font).toBe(fontString({ size: DEFAULT_METRICS.fontSize }))
    expect(stateAtText(context, '加粗').font).toBe(
      fontString({ size: DEFAULT_METRICS.fontSize, bold: true }),
    )
    expect(stateAtText(context, '代码').font).toBe(
      fontString({ size: DEFAULT_METRICS.fontSize, code: true }),
    )
    expect(stateAtText(context, '代码').fillStyle).toBe(palette.codeText)
    // 行内代码的底色走一个 fill（圆角小底），颜色是 codeBg
    expect(fillStyles(context)).toContain(palette.codeBg)
    expectBalancedSaveRestore(context)
  })

  it('列表项画项目符号、文字从 indent + markerWidth 起；引用画竖线并用 muted 文字', () => {
    const blocks: DrawBlock[] = [
      { kind: 'list-item', ordered: false, index: 0, depth: 0, runs: [{ text: '条目' }] },
      { kind: 'list-item', ordered: true, index: 7, depth: 0, runs: [{ text: '第七' }] },
      { kind: 'list-item', ordered: false, index: 0, depth: 0, runs: [{ text: '待办' }], checked: false },
      { kind: 'quote', depth: 0, runs: [{ text: '引用' }] },
    ]

    const { context } = paint({ nodes: [noteCard({ blocks })] })
    const left = 100 + CARD_PADDING

    expect(textsOf(context)).toEqual(expect.arrayContaining(['•', '7.', '☐', '条目', '第七', '待办']))
    expect(textAt(context, '•').x).toBeLessThanOrEqual(left + DEFAULT_METRICS.markerWidth)
    expect(textAt(context, '•').x).toBeGreaterThanOrEqual(left)
    expect(stateAtText(context, '•').textAlign).toBe('right')
    // 文字从符号留白之后起画（折行就是按这个宽度算的）
    expect(textAt(context, '条目').x).toBe(left + DEFAULT_METRICS.markerWidth)
    // 引用的竖线：fillRect 用了 quoteBorder，文字偏 muted
    expect(fillStyles(context)).toContain(palette.quoteBorder)
    expect(stateAtText(context, '引用').fillStyle).toBe(palette.muted)
    expect(textAt(context, '引用').x).toBe(left + DEFAULT_METRICS.markerWidth)
  })

  it('代码块：底色 + 等宽文字；超宽的行不折行、被裁掉并补一个省略号', () => {
    const short = '短行'
    const long = 'const veryLongLine = "这一行很长很长很长很长很长很长很长很长"'
    const blocks: DrawBlock[] = [{ kind: 'code', language: 'ts', lines: [short, long] }]

    const { context } = paint({ nodes: [noteCard({ blocks })] })

    expect(fillStyles(context)).toContain(palette.codeBg)
    // 整行一次画完（没有折行：折行会让代码的缩进结构失效）
    expect(textsOf(context)).toContain(short)
    expect(textsOf(context)).toContain(long)
    expect(stateAtText(context, long).font).toBe(
      fontString({ size: DEFAULT_METRICS.fontSize, code: true }),
    )
    expect(stateAtText(context, long).fillStyle).toBe(palette.codeText)
    // 只有超宽的那一行补省略号：卡片一次 clip + 这一行的嵌套 clip
    expect(textsOf(context).filter((text) => text === '…')).toHaveLength(1)
    expect(clipRects(context)).toHaveLength(2)
    expectBalancedSaveRestore(context)
  })

  it('表格：网格线按 rowHeights / columnWidths 排，单元格文字不重排', () => {
    const blocks: DrawBlock[] = [
      {
        kind: 'table',
        header: [['甲', '乙']],
        rows: [
          ['1', '2'],
          ['3', '4'],
        ],
        aligns: ['left', 'center'],
      },
    ]
    const node = noteCard({ blocks })
    const table = node.layout?.blocks[0]?.table

    const { context } = paint({ nodes: [node] })

    expect(table).toBeDefined()
    const rowHeights = table?.rowHeights ?? []
    const columnWidths = table?.columnWidths ?? []
    expect(rowHeights).toHaveLength(3)
    expect(columnWidths).toHaveLength(2)

    const top = 100 + cardChrome(DEFAULT_METRICS).bodyTop
    const horizontal = horizontalLineYs(context).filter((y) => y >= top - 0.001)
    expect(horizontal).toHaveLength(4)
    expect(horizontal[0]).toBeCloseTo(top)
    expect((horizontal[1] ?? 0) - (horizontal[0] ?? 0)).toBeCloseTo(rowHeights[0] ?? 0)
    expect((horizontal[2] ?? 0) - (horizontal[1] ?? 0)).toBeCloseTo(rowHeights[1] ?? 0)
    expect((horizontal[3] ?? 0) - (horizontal[2] ?? 0)).toBeCloseTo(rowHeights[2] ?? 0)

    const vertical = verticalLineXs(context)
    expect(vertical).toHaveLength(3)
    expect((vertical[1] ?? 0) - (vertical[0] ?? 0)).toBeCloseTo(columnWidths[0] ?? 0)
    expect((vertical[2] ?? 0) - (vertical[1] ?? 0)).toBeCloseTo(columnWidths[1] ?? 0)

    expect(textsOf(context)).toEqual(expect.arrayContaining(['甲', '乙', '1', '2', '3', '4']))
    // 表头单元格的 run 是粗体（排版层标的），画笔按同一个字体画
    expect(String(stateAtText(context, '甲').font)).toContain('600 ')
  })

  it('图片：画 imageBox 占位框与 alt/尺寸文字，从不尝试解码图片', () => {
    const blocks: DrawBlock[] = [{ kind: 'image', alt: '架构图', src: 'a.png', width: 300, height: 200 }]
    const node = noteCard({ blocks })
    const image = node.layout?.blocks[0]?.image

    const { context } = paint({ nodes: [node] })

    expect(fillStyles(context)).toContain(palette.imageBox)
    const expected = `架构图 ${Math.round(image?.width ?? 0)}×${Math.round(image?.height ?? 0)}`
    expect(textsOf(context)).toContain(expected)
    expect(stateAtText(context, expected).fillStyle).toBe(palette.muted)
    // 画笔的上下文里根本没有 drawImage —— 结构性保证（这条断言是防"将来有人加了它"）
    expect(context.ops.map((op) => String(op.op))).not.toContain('drawImage')
    // 占位框是虚线（实线会被误读成"真画了张图"）
    expect(context.ops.some((op) => op.op === 'setLineDash' && op.segments.length > 0)).toBe(true)
  })

  it('callout：竖条与标题行用强调色（给了 token 就用类型色，没给就退到 palette.quoteBorder）', () => {
    const blocks: DrawBlock[] = [
      {
        kind: 'callout',
        type: 'warning',
        known: true,
        glyph: '!',
        accent: '--mn-callout-warning',
        title: '当心',
        fold: null,
        depth: 0,
        children: [paragraph('内文')],
      },
    ]

    const withToken = paint({
      nodes: [noteCard({ blocks })],
      token: (name) => (name === '--mn-callout-warning' ? '#ff9100' : null),
    })

    expect(fillStyles(withToken.context)).toContain('#ff9100')
    expect(stateAtText(withToken.context, '! 当心').fillStyle).toBe('#ff9100')
    // 正文子块走的是同一条块绘制路径（不需要为 callout 再写一份排版）
    expect(textsOf(withToken.context)).toContain('内文')

    const withoutToken = paint({ nodes: [noteCard({ blocks })] })
    expect(fillStyles(withoutToken.context)).toContain(palette.quoteBorder)
    expect(fillStyles(withoutToken.context)).not.toContain('#ff9100')
  })

  it('未知块种类不抛错，按它的 lines 照常把文字画出来', () => {
    // 用 `JSON.parse` 造一个"将来才会有的块种类"：这是唯一不需要 `as` / `any` 就能让类型检查
    // 放行未知种类的写法（它同时也正好模拟了"数据来自宿主/缓存、版本比前端新"的真实情形）。
    const mystery: DrawBlock = JSON.parse('{"kind":"gallery","runs":[{"text":"未来的块"}]}')
    const laidOut: LaidOutBlock[] = [
      { block: mystery, lines: [{ runs: [{ text: '未来的块' }], width: 35 }], height: 19, indent: 0, gapAfter: 8 },
    ]
    const node: PaintNode = {
      relPath: 'future.md',
      title: '未来',
      rect: { x: 100, y: 100, width: CARD_WIDTH, height: 120 },
      hop: 0,
      isRoot: false,
      hasFocus: false,
      layout: {
        relPath: 'future.md',
        title: '未来',
        width: CARD_WIDTH,
        height: 120,
        blocks: laidOut,
        truncated: false,
      },
    }

    const { context, stats } = paint({ nodes: [node] })

    expect(stats.cards).toBe(1)
    expect(textsOf(context)).toContain('未来的块')
    expect(stateAtText(context, '未来的块').fillStyle).toBe(palette.text)
    expectBalancedSaveRestore(context)
  })

  it('全库模式（layout === null）只画紧凑卡片：标题 + 调用方折好的行', () => {
    const nodes = [
      compactCard({
        relPath: 'a.md',
        title: '甲',
        rect: { x: 100, y: 100, width: 200, height: 90 },
        lines: ['第一行', '第二行'],
      }),
      compactCard({
        relPath: 'b.md',
        title: '乙',
        rect: { x: 400, y: 100, width: 200, height: 90 },
        lines: ['只有一行'],
      }),
    ]

    const { context, stats } = paint({ nodes, mode: 'vault' })

    expect(stats).toEqual({ cards: 2, edges: 0, culled: 0 })
    expect(textsOf(context)).toEqual(
      expect.arrayContaining(['甲', '乙', '第一行', '第二行', '只有一行']),
    )
    // 紧凑卡片没有任何块级装饰（没有代码底色、图片占位框、表格网格）
    expect(countOps(context, 'fillRect')).toBe(0)
    expect(clipRects(context)).toHaveLength(2)
    expectBalancedSaveRestore(context)
  })
})

// ---------------------------------------------------------------------------
// 画笔：边与焦点
// ---------------------------------------------------------------------------

describe('paintGraph：边与焦点', () => {
  /** 取第 `index` 次 `stroke` 时的状态（边先画，所以前几次是边）。 */
  function strokeState(context: RecordingContext, index: number): PropState {
    const strokes = context.ops.flatMap((op, position) => (op.op === 'stroke' ? [position] : []))
    const position = strokes[index]
    if (position === undefined) throw new Error(`没有第 ${index} 次 stroke`)
    return context.stateAt(position)
  }

  it('普通边 alpha 0.45；与 hovered 相连的边用 edgeActive、alpha 1；muted 的边用虚线', () => {
    const a = noteCard({ relPath: 'a.md', title: '甲', rect: { x: 0, y: 0, width: 280, height: 80 } })
    const b = noteCard({ relPath: 'b.md', title: '乙', rect: { x: 300, y: 0, width: 280, height: 80 } })
    const c = noteCard({ relPath: 'c.md', title: '丙', rect: { x: 600, y: 300, width: 280, height: 80 } })
    const edges: PaintEdge[] = [
      { from: { x: 440, y: 40 }, to: { x: 740, y: 340 }, muted: false },
      { from: { x: 140, y: 40 }, to: { x: 440, y: 40 }, muted: false },
      { from: { x: 440, y: 60 }, to: { x: 740, y: 360 }, muted: true },
    ]

    const { context, stats } = paint({ nodes: [a, b, c], edges, hovered: 'a.md' })

    expect(stats.edges).toBe(3)
    // 第 1 条：两端都不是活跃卡片 ⇒ 弱化显示、实线
    expect(strokeState(context, 0).globalAlpha).toBe(0.45)
    expect(strokeState(context, 0).strokeStyle).toBe(palette.edge)
    expect(strokeState(context, 0).lineDash).toBe('')
    // 第 2 条：端点落在 hovered 的卡片里 ⇒ 高亮、alpha 1
    expect(strokeState(context, 1).strokeStyle).toBe(palette.edgeActive)
    expect(strokeState(context, 1).globalAlpha).toBe(1)
    // 第 3 条：muted ⇒ 虚线
    expect(String(strokeState(context, 2).lineDash)).not.toBe('')
  })

  it('焦点卡片（hasFocus / selected）用 cardBorderFocus 且线宽 2，其余用 cardBorder / 1', () => {
    const focused = noteCard({ relPath: 'a.md', title: '甲', x: 100, y: 100, hasFocus: true })
    const selected = noteCard({ relPath: 'b.md', title: '乙', x: 500, y: 100 })

    const { context } = paint({ nodes: [focused, selected], selected: 'b.md' })

    const strokes = context.ops.flatMap((op, position) =>
      op.op === 'stroke' ? [context.stateAt(position)] : [],
    )
    // 两张卡片的边框：焦点那张用强调色 + 线宽 2，另一张用普通边框色 + 线宽 1
    expect(strokes.filter((state) => state.strokeStyle === palette.cardBorderFocus)).toHaveLength(2)
    expect(
      strokes
        .filter((state) => state.strokeStyle === palette.cardBorderFocus)
        .every((state) => state.lineWidth === 2),
    ).toBe(true)
    expect(
      strokes.filter((state) => state.strokeStyle === palette.cardBorder && state.lineWidth === 1)
        .length,
    ).toBeGreaterThanOrEqual(2)
    // 边框两笔都是圆角路径（arc 画四角），不是直角矩形
    expect(countOps(context, 'arc')).toBeGreaterThanOrEqual(8)
  })
})

/** 找某段文字的绘制位置（没有画过就抛 —— 让断言失败在"根本没画"而不是"坐标差了 1px"）。 */
function textAt(context: RecordingContext, text: string): { x: number; y: number } {
  const op = context.ops.find((item) => item.op === 'fillText' && item.text === text)
  if (op === undefined || op.op !== 'fillText') throw new Error(`这一帧没有画过文字：${text}`)
  return { x: op.x, y: op.y }
}

/** 第一次用某个颜色填充（`fill` 或 `fillRect`）的位置，用来断言"边先于卡片"。 */
function firstFillIndexOf(context: RecordingContext, color: string): number {
  return context.ops.findIndex(
    (op, index) =>
      (op.op === 'fill' || op.op === 'fillRect') && context.stateAt(index).fillStyle === color,
  )
}
