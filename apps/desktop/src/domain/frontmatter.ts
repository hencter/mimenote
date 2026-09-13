/**
 * frontmatter 的纯展示函数（领域层规则：不 import React / store / IPC）。
 *
 * 解析权威在 Rust（`mn_core::frontmatter`，含 37 个单测）；前端只负责把已经解析好的
 * `FrontmatterValue` 变成人能读的文本 —— 属性表、标签列的逗号切分都走这里，
 * 避免"同一份渲染逻辑在 Mock 与组件里各写一遍"。
 */

import type { FrontmatterValue } from '@/ipc/types'

/** 值的展示文本（列表用 `、` 连接；`null` 显示为空串）。 */
export function frontmatterValueText(value: FrontmatterValue): string {
  switch (value.kind) {
    case 'scalar':
      return value.value
    case 'number':
      return value.value
    case 'bool':
      return value.value ? 'true' : 'false'
    case 'list':
      return value.value.join('、')
    case 'null':
      return ''
    default:
      return ''
  }
}

/** 值是否是"空的"（属性表里可以灰显）。 */
export function isFrontmatterEmpty(value: FrontmatterValue): boolean {
  if (value.kind === 'null') return true
  return value.kind === 'list' && value.value.length === 0
}

/**
 * frontmatter 区块占用的行范围（**0 起、闭区间**）；没有合法区块时返回 `null`。
 *
 * 识别口径与 `mn_core::frontmatter::parse` 一致：允许 BOM；首行（去行尾空白）必须正好是 `---`；
 * 必须存在另一行 `---` 作为结束 —— **未闭合就不是 frontmatter**（普通 Markdown 里
 * `---` 常被当作分隔线，误判会把整篇正文吃掉）。这也是为什么预览要跳过它：
 * 它是"元数据"，该显示在属性面板里，而不是渲染成一条横线加几行文字。
 */
export function frontmatterRegion(text: string): { startLine: number; endLine: number } | null {
  const lines = text.split('\n')
  const first = (lines[0] ?? '').replace(/^\u{feff}/u, '').trimEnd()
  if (first !== '---') return null
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trimEnd() === '---') return { startLine: 0, endLine: index }
  }
  return null
}

/** 去掉开头 frontmatter 区块后的正文（没有合法区块时原样返回）。 */
export function frontmatterBody(text: string): string {
  const region = frontmatterRegion(text)
  if (region === null) return text
  return text.split('\n').slice(region.endLine + 1).join('\n')
}
