/**
 * 换行与高度（`features/graph/canvas/text-layout.ts`）。
 *
 * 测量函数在这里是**注入的假实现**，于是每条断行都能用整数心算出来：
 * "宽度 50、每字 10px ⇒ 每行 5 个字"这种断言只有把测量固定住才写得出来，
 * 而它正是画布排版里最容易错的地方（CJK 逐字、西文按词、超长词硬断、按 run 换字体累加）。
 *
 * 期望值全部手算成字面量，不从实现里推导 —— 推出来的期望值只能证明"实现没变"，证明不了"实现是对的"。
 */

import { describe, expect, it } from 'vitest'

import { toDrawBlocks, type CalloutBlock, type DrawBlock, type InlineRun } from '@/features/graph/canvas/blocks'
import {
  DEFAULT_METRICS,
  fontFor,
  fontOfRun,
  layoutBlocks,
  totalHeight,
  type LayoutMetrics,
  type MeasureText,
} from '@/features/graph/canvas/text-layout'

/**
 * 假测量：每个字符 10px，并按字号等比缩放。
 *
 * 为什么不做"数字比字母窄"的分级：这一份是用来钉"逐字符累加 + 按字号放大"的，
 * 混排与等宽另有 `MIXED` 负责 —— 一个测试里的假测量只应该让**它要断言的规则**可见。
 */
const TEN_PER_CHAR: MeasureText = (text, font) =>
  Array.from(text).length * 10 * (font.size / DEFAULT_METRICS.fontSize)

/** 假测量：拉丁/半角 5px、其它（CJK）10px，等宽再多 4px/字符 —— 用来验混排与 run 累加。 */
const MIXED: MeasureText = (text, font) => {
  const chars = Array.from(text)
  let width = 0
  for (const char of chars) width += /[\x20-\x7e]/.test(char) ? 5 : 10
  if (font.code === true) width += chars.length * 4
  return width * (font.size / DEFAULT_METRICS.fontSize)
}

/** 一套"心算友好"的几何参数：行高 20、块间距 6、每级缩进 10、符号留白 10。 */
const METRICS: LayoutMetrics = {
  ...DEFAULT_METRICS,
  width: 200,
  fontSize: 13,
  lineHeight: 20,
  blockGap: 6,
  indentPerLevel: 10,
  markerWidth: 10,
  codeLineHeight: 15,
}

function metrics(overrides: Partial<LayoutMetrics> = {}): LayoutMetrics {
  return { ...METRICS, ...overrides }
}

function paragraph(text: string): DrawBlock {
  return { kind: 'paragraph', runs: [{ text }] }
}

/**
 * 一套"心算友好"的几何参数：内边距 8、正文内缩 8、每级嵌套 8、最多两级。
 * （与 `METRICS` 的其余部分相加之后，提示框的每个数字都是 8 的倍数，手算不会出错。）
 */
const CALLOUT_METRICS: Partial<LayoutMetrics> = {
  calloutPadding: 8,
  calloutBarWidth: 3,
  calloutBodyInset: 8,
  calloutIndentPerLevel: 8,
  calloutMaxDepth: 2,
}

/** 造一个提示框块（默认就是一个空提示框，用例只写自己关心的字段）。 */
function callout(overrides: Partial<Omit<CalloutBlock, 'kind'>> = {}): DrawBlock {
  return {
    kind: 'callout',
    type: 'note',
    known: true,
    glyph: '✎',
    accent: '--mn-callout-note',
    title: '提示语',
    fold: null,
    depth: 0,
    children: [],
    ...overrides,
  }
}

function linesOf(
  markdownBlock: DrawBlock,
  measure: MeasureText,
  overrides?: Partial<LayoutMetrics>,
) {
  const metricsUsed = metrics(overrides)
  const laidOut = layoutBlocks([markdownBlock], metricsUsed, measure)[0]
  if (laidOut === undefined) throw new Error('没有排版结果')
  return laidOut
}

/** 一行的纯文本（把 run 拼回去，断言断行位置时最直观）。 */
function texts(line: { runs: InlineRun[] }): string {
  return line.runs.map((run) => run.text).join('')
}

describe('中文按字符换行', () => {
  it('每字 10px、宽度 50 ⇒ 每行 5 个字', () => {
    const laidOut = linesOf(paragraph('一二三四五六七八九十'), TEN_PER_CHAR, { width: 50 })

    expect(laidOut.lines.map(texts)).toEqual(['一二三四五', '六七八九十'])
    expect(laidOut.lines.map((line) => line.width)).toEqual([50, 50])
    expect(laidOut.height).toBe(40) // 2 行 × 20
  })

  it('正好放得下时不提前断行（边界是 > 不是 >=）', () => {
    const laidOut = linesOf(paragraph('一二三四五'), TEN_PER_CHAR, { width: 50 })
    expect(laidOut.lines.map(texts)).toEqual(['一二三四五'])
  })
})

describe('西文按词换行', () => {
  it('不在单词中间断（hello world foo ⇒ hello / world foo）', () => {
    const laidOut = linesOf(paragraph('hello world foo'), MIXED, { width: 50 })

    expect(laidOut.lines.map(texts)).toEqual(['hello', 'world foo'])
    // 每一行的宽度都按词算：hello = 25、world foo = 25 + 5 + 15
    expect(laidOut.lines.map((line) => line.width)).toEqual([25, 45])
  })

  it('行尾的空白不占宽、也不留在文字里', () => {
    const laidOut = linesOf(paragraph('hello  '), MIXED, { width: 50 })
    expect(laidOut.lines.map(texts)).toEqual(['hello'])
    expect(laidOut.lines[0]?.width).toBe(25)
  })

  it('行首的空白被丢掉（不会每行都莫名缩进一格）', () => {
    const laidOut = linesOf(paragraph('   hello'), MIXED, { width: 50 })
    expect(laidOut.lines.map(texts)).toEqual(['hello'])
  })

  it('单个词比整行还宽时**硬断**（长网址不能永远溢出卡片）', () => {
    // abcdefghij = 10 字 × 5px = 50，宽度只有 30 ⇒ 先放满 6 个字再断
    const laidOut = linesOf(paragraph('abcdefghij'), MIXED, { width: 30 })
    expect(laidOut.lines.map(texts)).toEqual(['abcdef', 'ghij'])
    expect(laidOut.lines.map((line) => line.width)).toEqual([30, 20])
  })
})

describe('中英混排', () => {
  it('汉字逐字累加，夹在中间的英文单词整体不拆', () => {
    // 中(10)文(10) + abc(15) + 中(10) = 45 ≤ 50，再放一个 文 就 55 超宽
    const laidOut = linesOf(paragraph('中文abc中文'), MIXED, { width: 50 })
    expect(laidOut.lines.map(texts)).toEqual(['中文abc中', '文'])
    expect(laidOut.lines.map((line) => line.width)).toEqual([45, 10])
  })

  it('混排时长单词仍然整体挪到下一行', () => {
    // 甲(10)乙(10) + hello(25) = 45 ≤ 50；再放 world(25) 就 75 超宽
    const laidOut = linesOf(paragraph('甲乙hello world'), MIXED, { width: 50 })
    expect(laidOut.lines.map(texts)).toEqual(['甲乙hello', 'world'])
  })
})

describe('按 run 累加宽度（不能把整段当一个字体量）', () => {
  const block: DrawBlock = {
    kind: 'paragraph',
    runs: [{ text: '一二三' }, { text: 'code', code: true }],
  }

  it('行内代码更宽时按 run 分段累加，换行位置随之改变', () => {
    // 一二三 = 30；code 用等宽 = 4×5 + 4×4 = 36；30 + 36 > 50 ⇒ 断成两行
    const laidOut = linesOf(block, MIXED, { width: 50 })
    expect(laidOut.lines.map(texts)).toEqual(['一二三', 'code'])
    expect(laidOut.lines.map((line) => line.width)).toEqual([30, 36])
  })

  it('每行的宽度 = 该行各 run 在自己字体下量出来的宽度之和', () => {
    const metricsUsed = metrics({ width: 50 })
    const laidOut = linesOf(block, MIXED, { width: 50 })
    const base = fontFor(block, metricsUsed)

    for (const line of laidOut.lines) {
      const expected = line.runs.reduce(
        (sum, run) => sum + MIXED(run.text, fontOfRun(base, run)),
        0,
      )
      expect(line.width).toBe(expected)
    }
  })

  it('同一行的相邻同样式片段会合并回一条 run，但宽度不变', () => {
    const laidOut = linesOf(paragraph('一二三'), TEN_PER_CHAR, { width: 200 })
    expect(laidOut.lines).toHaveLength(1)
    expect(laidOut.lines[0]?.runs).toEqual([{ text: '一二三' }])
    expect(laidOut.lines[0]?.width).toBe(30)
  })
})

describe('强制换行（run 文本里的 \\n）', () => {
  it('硬换行产出一行，且不额外加块间距', () => {
    const laidOut = linesOf(paragraph('上\n下'), TEN_PER_CHAR, { width: 200 })
    expect(laidOut.lines.map(texts)).toEqual(['上', '下'])
    expect(laidOut.height).toBe(40)
  })

  it('连续两个硬换行之间是一个空行（用户在引用/列表里刻意留的间隔）', () => {
    const laidOut = linesOf(paragraph('上\n\n下'), TEN_PER_CHAR, { width: 200 })
    expect(laidOut.lines.map(texts)).toEqual(['上', '', '下'])
    expect(laidOut.height).toBe(60)
  })
})

describe('标题', () => {
  it('字号随级别放大，行高同步放大（否则字会互相压住）', () => {
    const heading = linesOf({ kind: 'heading', level: 1, runs: [{ text: '标题' }] }, TEN_PER_CHAR)
    const body = linesOf(paragraph('标题'), TEN_PER_CHAR)

    expect(fontFor({ kind: 'heading', level: 1, runs: [] }, METRICS).size).toBeCloseTo(13 * 1.6)
    expect(heading.height).toBeCloseTo(20 * METRICS.headingScale[1])
    expect(heading.height).toBeGreaterThan(body.height)
  })

  it('标题默认粗体（量宽与绘制必须同一个字体）', () => {
    expect(fontFor({ kind: 'heading', level: 3, runs: [] }, METRICS).bold).toBe(true)
    expect(fontFor(paragraph('x'), METRICS).bold).toBeUndefined()
  })
})

describe('列表与引用的缩进', () => {
  /** 18 个字 × 10px = 180px：在宽度 100 下，缩进每多一级就多折一行。 */
  const item = (depth: number): DrawBlock => ({
    kind: 'list-item',
    ordered: false,
    index: 0,
    depth,
    runs: [{ text: '一二三四五六七八九十一二三四五六七八' }],
  })

  it('indent = depth × indentPerLevel，引用同理', () => {
    expect(linesOf(item(0), TEN_PER_CHAR).indent).toBe(0)
    expect(linesOf(item(2), TEN_PER_CHAR).indent).toBe(20)
    expect(linesOf(paragraph('x'), TEN_PER_CHAR).indent).toBe(0)
    const quote: DrawBlock = { kind: 'quote', depth: 3, runs: [{ text: 'x' }] }
    expect(linesOf(quote, TEN_PER_CHAR).indent).toBe(30)
  })

  it('缩进（以及符号留白）会**减少可用宽度**，于是行数、高度都跟着变', () => {
    // depth 0：可用 100 - 0 - 10(符号) = 90 ⇒ 每行 9 字 ⇒ 2 行
    // depth 2：可用 100 - 20 - 10 = 70 ⇒ 每行 7 字 ⇒ 3 行
    const shallow = linesOf(item(0), TEN_PER_CHAR, { width: 100 })
    const deep = linesOf(item(2), TEN_PER_CHAR, { width: 100 })

    expect(shallow.lines).toHaveLength(2)
    expect(deep.lines).toHaveLength(3)
    expect(shallow.height).toBe(40)
    expect(deep.height).toBe(60)
  })

  it('符号留白与缩进是两笔预算（文字从 indent + markerWidth 起画）', () => {
    const metricsUsed = metrics({ width: 100 })
    const laidOut = linesOf(item(0), TEN_PER_CHAR, { width: 100 })
    const longest = Math.max(...laidOut.lines.map((line) => line.width))
    expect(longest).toBeLessThanOrEqual(metricsUsed.width - metricsUsed.markerWidth)
  })
})

describe('代码块', () => {
  it('不折行：一行就是一行，宽度可以远超可用宽度（交给画笔裁切）', () => {
    const long = 'x'.repeat(80)
    const laidOut = linesOf(
      { kind: 'code', language: 'ts', lines: [long, 'short'] },
      TEN_PER_CHAR,
      { width: 50 },
    )

    expect(laidOut.lines).toHaveLength(2)
    expect(laidOut.lines.map(texts)).toEqual([long, 'short'])
    expect(laidOut.lines[0]?.width).toBe(800) // 没有被折行 ⇒ 远超 50
    expect(laidOut.height).toBe(2 * METRICS.codeLineHeight)
  })

  it('代码行的宽度按等宽字体量', () => {
    const laidOut = linesOf({ kind: 'code', language: '', lines: ['ab'] }, MIXED)
    expect(laidOut.lines[0]?.width).toBe(MIXED('ab', { size: 13, code: true }))
  })
})

describe('图片与分隔线', () => {
  it('图片按可用宽度等比缩放，块高就是缩放后的高', () => {
    const laidOut = linesOf(
      { kind: 'image', alt: '图', src: '图.png', width: 400, height: 300 },
      TEN_PER_CHAR,
      { width: 200 },
    )
    expect(laidOut.image).toEqual({ width: 200, height: 150 })
    expect(laidOut.height).toBe(150)
  })

  it('只有宽度时按默认比例估高；什么都不知道时给一个保守的占位盒', () => {
    const onlyWidth = linesOf(
      { kind: 'image', alt: '', src: 'a.png', width: 100, height: null },
      TEN_PER_CHAR,
      { width: 200 },
    )
    expect(onlyWidth.image?.height).toBeCloseTo(66)

    const unknown = linesOf(
      { kind: 'image', alt: '', src: 'a.png', width: null, height: null },
      TEN_PER_CHAR,
      { width: 200 },
    )
    expect(unknown.height).toBe(METRICS.lineHeight * 4)
  })

  it('分隔线占一行的高度（零高度会和上下块贴在一起）', () => {
    const laidOut = linesOf({ kind: 'hr' }, TEN_PER_CHAR)
    expect(laidOut.lines).toEqual([])
    expect(laidOut.height).toBe(METRICS.lineHeight)
  })
})

describe('表格', () => {
  const table: DrawBlock = {
    kind: 'table',
    header: [['名称', '值']],
    rows: [['a', '1']],
    aligns: ['left', 'right'],
  }

  it('列宽：自然宽度夹在上下限内，再把余量平均分给每列', () => {
    // 自然宽度 20 / 10 → 都夹到下限 36；总宽 72，余量 (200-72)/2 = 64 平均分 ⇒ 100 / 100
    const laidOut = linesOf(table, TEN_PER_CHAR, { width: 200 })
    expect(laidOut.table?.columnWidths).toEqual([100, 100])
    // 表头一行、数据行一行，行高都是 20
    expect(laidOut.table?.rowHeights).toEqual([20, 20])
    expect(laidOut.height).toBe(40)
  })

  it('单元格带上对齐方式与可用宽度（画笔据此决定从哪一端起画）', () => {
    const laidOut = linesOf(table, TEN_PER_CHAR, { width: 200 })
    expect(laidOut.table?.headerRows[0]?.map((cell) => cell.align)).toEqual(['left', 'right'])
    expect(laidOut.table?.rows[0]?.map((cell) => cell.align)).toEqual(['left', 'right'])
    expect(laidOut.table?.rows[0]?.[0]?.width).toBe(100 - METRICS.tableCellPadding * 2)
  })

  it('收缩装不下（有一列会被压到下限之下）时整体退到等分，表格绝不横向溢出', () => {
    // 自然宽度 180 / 10 → 夹到 [36,200] 后是 180 / 36，总 216 > 200：
    // 按比例收缩会得到 166.67 / 33.33，而 33.33 < 下限 36 ⇒ 整体等分 100 / 100。
    // 第一列可用宽度 = 100 - 12 = 88 ⇒ 每行 8 个字 ⇒ 18 个字折成 3 行
    const wide: DrawBlock = {
      kind: 'table',
      header: [['一', '二']],
      rows: [['一二三四五六七八九十一二三四五六七八', '短']],
      aligns: ['left', 'left'],
    }
    const laidOut = linesOf(wide, TEN_PER_CHAR, { width: 200 })
    expect(laidOut.table?.columnWidths).toEqual([100, 100])
    expect(laidOut.table?.rows[0]?.[0]?.lines.map(texts)).toEqual([
      '一二三四五六七八',
      '九十一二三四五六',
      '七八',
    ])
    expect(laidOut.table?.rowHeights).toEqual([20, 60])
    expect(laidOut.height).toBe(80)
  })

  it('收缩后每列仍在下限之上时按比例分配', () => {
    // 自然宽度 120 / 80，总 200 = 可用宽度 ⇒ 不进收缩分支（余量为 0），列宽就是 120 / 80。
    // 第一列可用宽度 = 120 - 12 = 108 ⇒ 每行 10 个字 ⇒ 12 个字折成 2 行
    const wide: DrawBlock = {
      kind: 'table',
      header: [['一', '二']],
      rows: [['一二三四五六七八九十一二', '一二三四五六七八']],
      aligns: ['left', 'left'],
    }
    const laidOut = linesOf(wide, TEN_PER_CHAR, { width: 200 })
    expect(laidOut.table?.columnWidths).toEqual([120, 80])
    expect(laidOut.table?.rows[0]?.[0]?.lines.map(texts)).toEqual(['一二三四五六七八九十', '一二'])
    expect(laidOut.table?.rowHeights).toEqual([20, 40])
  })

  it('列数按表头/对齐数组算，短行补空单元格（画笔不必再判越界）', () => {
    const ragged: DrawBlock = {
      kind: 'table',
      header: [['a', 'b']],
      rows: [['1']],
      aligns: ['left', 'right'],
    }
    const laidOut = linesOf(ragged, TEN_PER_CHAR, { width: 200 })
    expect(laidOut.table?.rows[0]).toHaveLength(2)
    expect(laidOut.table?.rows[0]?.[1]?.lines).toEqual([])
  })
})

describe('提示框', () => {
  it('容器高度 = 内边距 ×2 + 标题行 + 块间距 + 子块高度（手算 62）', () => {
    const laidOut = linesOf(
      callout({ title: '提示语', children: [paragraph('正文')] }),
      TEN_PER_CHAR,
      CALLOUT_METRICS,
    )

    expect(laidOut.lines.map(texts)).toEqual(['✎ 提示语'])
    expect(laidOut.callout?.titleHeight).toBe(20)
    // 8(上内边距) + 20(标题) + 6(间距) = 34：正文从容器顶部往下 34px 处开始
    expect(laidOut.callout?.bodyTop).toBe(34)
    // 8×2 + 20 + 6 + 20
    expect(laidOut.height).toBe(62)
    // 盒子宽度 = 本块可用宽度（画笔按它描边框）
    expect(laidOut.callout?.width).toBe(200)
  })

  it('没有正文时只有"内边距 + 标题行"（空提示框不多出一条空隙）', () => {
    const laidOut = linesOf(callout(), TEN_PER_CHAR, CALLOUT_METRICS)
    expect(laidOut.children).toEqual([])
    expect(laidOut.callout?.bodyTop).toBe(28) // 8 + 20 + 0
    expect(laidOut.height).toBe(36) // 8×2 + 20
  })

  it('正文子块在容器内左右各内缩 calloutBodyInset', () => {
    const laidOut = linesOf(
      callout({ children: [paragraph('正文')] }),
      TEN_PER_CHAR,
      CALLOUT_METRICS,
    )
    expect(laidOut.children?.[0]?.indent).toBe(8)
    // 内缩也要从可用宽度里扣掉：200 - 8(内边距) ×2 - 8(正文内缩) = 176
    expect(laidOut.children?.[0]?.lines[0]?.width).toBe(20) // 正文只有两个字
    expect(laidOut.children?.[0]?.height).toBe(20)
  })

  it('多段正文不重叠：逐个累加子块，正好落在容器底线再减一个内边距', () => {
    const children = [paragraph('第一段'), paragraph('第二段'), paragraph('第三段')]
    const laidOut = linesOf(callout({ children }), TEN_PER_CHAR, CALLOUT_METRICS)
    const bodyTop = laidOut.callout?.bodyTop ?? 0

    expect(laidOut.children?.map((child) => child.height)).toEqual([20, 20, 20])
    // 容器高度 = 上下内边距 + 标题 + 间距 + 子块之和 + 子块间距
    expect(laidOut.height).toBe(16 + 20 + 6 + totalHeight(laidOut.children ?? []))
    // 画笔按 `y += height + gapAfter` 累加子块（末块之后不加间距），最后一块的下沿
    // 加上下内边距必须**正好**是容器高度 —— 否则子块之间会重叠或多出空白
    let y = bodyTop
    const listLen = (laidOut.children ?? []).length
    ;(laidOut.children ?? []).forEach((child, index) => {
      y += child.height + (index < listLen - 1 ? child.gapAfter : 0)
    })
    expect(y + 8).toBe(laidOut.height)
  })

  it('子块走的是同一套排版：代码用等宽行高、列表项带自己的缩进', () => {
    const children: DrawBlock[] = [
      { kind: 'code', language: 'ts', lines: ['a', 'b'] },
      { kind: 'list-item', ordered: false, index: 0, depth: 1, runs: [{ text: '项' }] },
    ]
    const laidOut = linesOf(callout({ children }), TEN_PER_CHAR, CALLOUT_METRICS)

    // 代码块 2 行 × 等宽行高 15
    expect(laidOut.children?.[0]?.height).toBe(30)
    // 列表项：提示框正文那一笔(8) + 它自己的层级(1 × 10)
    expect(laidOut.children?.[1]?.indent).toBe(18)
  })

  it('嵌套提示框的缩进在 calloutMaxDepth 级之后不再加深', () => {
    const nest = (depth: number): DrawBlock =>
      callout({ depth, children: depth < 4 ? [nest(depth + 1)] : [] })
    const laidOut = linesOf(nest(0), TEN_PER_CHAR, CALLOUT_METRICS)

    const indents: number[] = []
    const widths: number[] = []
    let node: typeof laidOut | undefined = laidOut
    while (node !== undefined) {
      indents.push(node.indent)
      widths.push(node.callout?.width ?? -1)
      node = node.children?.[0]
    }

    // 0；第 1 层 8(正文内缩) + 1×8；第 2 层 8 + 2×8 = 24；第 3、4 层**停在同一档**
    expect(indents).toEqual([0, 16, 24, 24, 24])
    // 盒子宽度仍在递减（每层要付 16 的内边距 + 24 的缩进），但缩进封顶之后不会加速
    expect(widths).toEqual([200, 168, 128, 88, 48])
  })

  it('顶层提示框的缩进也要算（`> > [!tip]` 在块清单上是平级的）', () => {
    const laidOut = linesOf(callout({ depth: 1 }), TEN_PER_CHAR, CALLOUT_METRICS)
    expect(laidOut.indent).toBe(8)
    expect(laidOut.callout?.width).toBe(192)
  })

  it('标题太长时标题行折行，容器跟着变高', () => {
    const title = '一二三四五六七八九十'.repeat(3) // 30 字 + 字形 + 空格 = 32 字 = 320px
    const laidOut = linesOf(callout({ title }), TEN_PER_CHAR, CALLOUT_METRICS)
    // 正文宽 184 ⇒ 每行 18 个字 ⇒ 32 个字折成两行
    expect(laidOut.lines).toHaveLength(2)
    expect(laidOut.callout?.titleHeight).toBe(40)
    expect(laidOut.callout?.bodyTop).toBe(48) // 8 + 40 + 0
    expect(laidOut.height).toBe(56) // 8×2 + 40
  })

  it('totalHeight 把提示框当普通块（容器高度里已经含了子块）', () => {
    const layout = layoutBlocks(
      [callout({ children: [paragraph('正文')] }), paragraph('后面的段落')],
      metrics(CALLOUT_METRICS),
      TEN_PER_CHAR,
    )
    expect(layout.map((item) => item.height)).toEqual([62, 20])
    expect(totalHeight(layout)).toBe(62 + 6 + 20)
  })
})

describe('列表项之间的间距', () => {
  /**
   * 用户报过一条："有序/无序列表换行出现多换行（2 次换行）"。
   *
   * 读起来像编辑器的问题，实际是**卡片预览**：阅读视图里的列表是 `<ul><li>…`（`li` 没有外边距），
   * 行距就是唯一的间隔；而画布上每个块下面都被加了 `blockGap`，于是一列 `- 甲 / - 乙`
   * 看起来像"每项之间空了一行"。修法是"相邻两个列表项之间不留块间距"（见 `gapAfterFor`），
   * 这几条把它钉住 —— 同时确认**别的块之间的间距没有被顺手改掉**。
   */
  function listItem(text: string, depth = 0): DrawBlock {
    return { kind: 'list-item', runs: [{ text }], ordered: false, depth, index: 1 }
  }

  it('相邻的两个列表项之间没有间距（列表是"一组"，不是两段）', () => {
    const layout = layoutBlocks([listItem('甲'), listItem('乙'), listItem('丙')], metrics(), TEN_PER_CHAR)

    expect(layout.map((item) => item.gapAfter)).toEqual([0, 0, 6])
    // 总高 = 三行文字（**最后一块之后那一个间距不计入**，`totalHeight` 的既有口径）
    expect(totalHeight(layout)).toBe(20 + 20 + 20)
  })

  it('嵌套与退回父级同样不留间距（阅读视图里也没有多余空行）', () => {
    const nested = layoutBlocks(
      [listItem('甲'), listItem('乙', 1), listItem('丙')],
      metrics(),
      TEN_PER_CHAR,
    )
    expect(nested.map((item) => item.gapAfter)).toEqual([0, 0, 6])
  })

  it('列表后面接段落：间距照旧（列表与正文是两段不同的内容）', () => {
    const layout = layoutBlocks([listItem('甲'), paragraph('正文')], metrics(), TEN_PER_CHAR)
    expect(layout.map((item) => item.gapAfter)).toEqual([6, 6])
  })

  it('段落之间、列表项与别的块之间都不受影响（只动"列表项接列表项"这一种组合）', () => {
    const layout = layoutBlocks(
      [paragraph('前'), listItem('甲'), listItem('乙'), paragraph('后')],
      metrics(),
      TEN_PER_CHAR,
    )
    expect(layout.map((item) => item.gapAfter)).toEqual([6, 0, 6, 6])
  })

  it('提示框里的列表子块也走同一条规则（子块共用 `layoutWithin`）', () => {
    const callout = toDrawBlocks('> [!note] 标题\n> - 甲\n> - 乙')
    const layout = layoutBlocks(callout, metrics(), TEN_PER_CHAR)
    const children = layout[0]?.children ?? []
    expect(children).toHaveLength(2)
    expect(children.map((item) => item.gapAfter)).toEqual([0, 6])
  })
})

describe('totalHeight', () => {
  it('等于各行之和加块间距（手算：20 + 6 + 20）', () => {
    const layout = layoutBlocks([paragraph('一段'), paragraph('二段')], metrics(), TEN_PER_CHAR)
    expect(layout.map((item) => item.height)).toEqual([20, 20])
    expect(layout.map((item) => item.gapAfter)).toEqual([6, 6])
    expect(totalHeight(layout)).toBe(46)
  })

  it('最后一块之后不加间距（卡片底部就是最后一行文字）', () => {
    const layout = layoutBlocks([paragraph('一段')], metrics(), TEN_PER_CHAR)
    expect(totalHeight(layout)).toBe(20)
  })

  it('空清单是 0', () => {
    expect(totalHeight([])).toBe(0)
  })

  it('块高与间距是同一份 metrics（换一套参数总高跟着变）', () => {
    const layout = layoutBlocks(
      [paragraph('一'), paragraph('二'), paragraph('三')],
      metrics({ lineHeight: 10, blockGap: 4 }),
      TEN_PER_CHAR,
    )
    expect(totalHeight(layout)).toBe(10 + 4 + 10 + 4 + 10)
  })
})
