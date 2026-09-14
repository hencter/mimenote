/**
 * 大纲的"显示什么"（级别过滤）与"看到多深"（章节折叠）的纯函数测试。
 *
 * 这一层要钉住的是一条**坐标约定**：过滤与折叠只决定"哪几条渲染"，绝不重新编号 ——
 * 高亮与跳转都按完整列表的下标走，一旦在过滤后再编号，"当前章节"就会悄悄跳到别的条目上
 * （组件测试会用真实光标把这条约定再验一次）。另外钉住折叠的层级归属：H2 收起要隐藏其后
 * 所有更深的标题，直到遇到同级或更浅的那一条。
 */

import { describe, expect, it } from 'vitest'

import { outlineDepths, parseOutline } from '@/domain/outline'
import {
  ALL_HEADING_LEVELS,
  buildOutlineRows,
  normalizeHeadingLevels,
  toggleHeadingLevel,
} from '@/features/outline/outline-view'

/** 多级标题（行号：1 一 / 2 二 / 3 三 / 4 四 / 5 五 / 6 六 / 7 七 / 8 八）。 */
const NESTED = ['# 一', '## 二', '### 三', '#### 四', '## 五', '### 六', '# 七', '## 八'].join('\n')

function rowsOf(text: string, levels: readonly number[], collapsed: readonly number[] = []) {
  const headings = parseOutline(text)
  return buildOutlineRows(headings, outlineDepths(headings), new Set(levels), new Set(collapsed))
}

/** 可见条目的行号。 */
function linesOf(text: string, levels: readonly number[], collapsed: readonly number[] = []) {
  return rowsOf(text, levels, collapsed).map((row) => row.heading.line)
}

/** 可见条目的下标（完整列表里的位置）。 */
function ordinalsOf(text: string, levels: readonly number[], collapsed: readonly number[] = []) {
  return rowsOf(text, levels, collapsed).map((row) => row.ordinal)
}

describe('大纲级别过滤的取值', () => {
  it('规范化：只留 1–6 的整数、去重、升序', () => {
    expect(normalizeHeadingLevels([3, 1, 3, 0, 7, 2.5, -1, 6])).toEqual([1, 3, 6])
    expect(normalizeHeadingLevels([])).toEqual([])
    // 默认值本身就是规范形态（否则"默认"与"用户手动全选"会写出两份不同的持久化值）
    expect(normalizeHeadingLevels(ALL_HEADING_LEVELS)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('切换一级：关掉再打开回到原值，且允许一级都不显示', () => {
    expect(toggleHeadingLevel(ALL_HEADING_LEVELS, 2)).toEqual([1, 3, 4, 5, 6])
    expect(toggleHeadingLevel([1, 3, 4, 5, 6], 2)).toEqual([1, 2, 3, 4, 5, 6])
    expect(toggleHeadingLevel([1], 1)).toEqual([])
    expect(toggleHeadingLevel([], 4)).toEqual([4])
  })
})

describe('大纲的级别过滤', () => {
  it('默认（全部级别）时一条不少，且下标就是原顺序', () => {
    const rows = rowsOf(NESTED, ALL_HEADING_LEVELS)
    expect(rows.map((row) => row.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(rows.map((row) => row.heading.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(rows.every((row) => !row.collapsed)).toBe(true)
  })

  it('只渲染被选中的级别，但**下标仍然按完整列表算**（不重新编号）', () => {
    // 只剩 H2：二(1) 与 五(4) 与 八(7)
    expect(linesOf(NESTED, [2])).toEqual([2, 5, 8])
    expect(ordinalsOf(NESTED, [2])).toEqual([1, 4, 7])
    // 空选择是合法状态（面板会给出空态文案 + 一键还原）
    expect(linesOf(NESTED, [])).toEqual([])
  })

  it('缩进仍按完整列表算：过滤掉中间层级后，剩余条目的深浅不变', () => {
    const rows = rowsOf(NESTED, [3, 4])
    expect(rows.map((row) => row.heading.line)).toEqual([3, 4, 6])
    // 三 / 四 在原文里是第 2/3 层，过滤掉 H1/H2 之后仍然是第 2/3 层的缩进
    expect(rows.map((row) => row.depth)).toEqual([2, 3, 2])
  })
})

describe('大纲的章节折叠', () => {
  it('收起一条 = 隐藏其后所有更深的标题，直到同级或更浅的那一条', () => {
    // 收起「二」（H2，下标 1）：三 / 四 一起消失，五（同级 H2）把它截断
    expect(linesOf(NESTED, ALL_HEADING_LEVELS, [1])).toEqual([1, 2, 5, 6, 7, 8])
    // 收起「一」（H1，下标 0）：一路隐藏到下一个 H1（第 7 行）
    expect(linesOf(NESTED, ALL_HEADING_LEVELS, [0])).toEqual([1, 7, 8])
    // 收起最深的「三」（H3，下标 2）：只影响它自己的子树（四）
    expect(linesOf(NESTED, ALL_HEADING_LEVELS, [2])).toEqual([1, 2, 3, 5, 6, 7, 8])
  })

  it('收起的条目自己也留在列表里，并且仍然带着展开用的三角', () => {
    const rows = rowsOf(NESTED, ALL_HEADING_LEVELS, [1])
    const collapsedRow = rows.find((row) => row.ordinal === 1)
    // 收起之后三角必须还在，否则这一节就再也展不开了
    expect(collapsedRow?.collapsed).toBe(true)
    expect(collapsedRow?.hasChildren).toBe(true)
  })

  it('没有子标题（或子标题全被过滤掉）的条目不带三角', () => {
    const [一, 二, 三] = rowsOf('# 一\n## 二\n### 三', ALL_HEADING_LEVELS)
    expect([一?.hasChildren, 二?.hasChildren, 三?.hasChildren]).toEqual([true, true, false])
    // 只剩 H1：H2 被过滤掉之后，H1 后面没有"可见的子标题" → 不给假控件
    const onlyH1 = rowsOf('# 一\n## 二\n### 三', [1])
    expect(onlyH1[0]?.hasChildren).toBe(false)
  })

  it('看不见的折叠项不生效：三角只能长在看得见的条目上', () => {
    // 「二」被过滤掉时，它上面那份折叠状态不该继续吞掉可见的「三」
    // （否则关掉 H2 之后，H3 会莫名其妙一起消失，而屏幕上没有任何可以点的三角）
    expect(linesOf('# 一\n## 二\n### 三', [3], [1])).toEqual([3])
    // 反过来，看得见的折叠项照常生效
    expect(linesOf('# 一\n## 二\n### 三', [1, 2], [1])).toEqual([1, 2])
  })

  it('越界 / 已不存在的折叠下标被忽略（内容变化后序号会漂）', () => {
    expect(linesOf(NESTED, ALL_HEADING_LEVELS, [99])).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    // 短文档 + 大下标：绝不能因此吞掉任何条目
    expect(linesOf('# 一\n## 二', ALL_HEADING_LEVELS, [7])).toEqual([1, 2])
  })

  it('空文档不产生任何条目', () => {
    expect(buildOutlineRows([], [], new Set(ALL_HEADING_LEVELS), new Set())).toEqual([])
  })
})
