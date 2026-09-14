/**
 * GFM 表格在 Live Preview 里的渲染（**纯逻辑**；DOM 与样式分别在 widgets.ts / table.css）。
 *
 * ### 为什么渲染整块，而不是"只露光标那一行"
 * 一张表在渲染态是**一个** `<table>` 元素：列宽由全部行共同决定。若做成"光标在哪一行就露哪一行的
 * 原文"，要么把表格拆成"每行一张小表"（列宽不再共享，每一行的竖线都对不上，观感比不渲染还差），
 * 要么让那一行的单元格宽度与它渲染时不同 —— 无论哪种，光标每上下移动一行，整张表的行高与列宽
 * 都会重排一次，读者的视线要重新找位置。所以判据是"**选区是否与整块相交**"：进则整块露原文
 * （与 `heading` 的"光标进入即露原文"是同一条纪律，只是粒度从一行放大到一块），出则整块渲染。
 *
 * ### 为什么复用 `domain/markdown.ts`，而不是自己写一个表格解析器
 * 表格的边界情况（缺列补齐 / 多列截断、`\|` 转义、代码跨度里的竖线、对齐标记、引用块与列表里的
 * 变体）多得离谱，而这些判据**阅读视图已经有一份、并且有测试**。再写一份"自己的"解析，
 * 立刻就会出现"编辑器里是表格、切到阅读视图不是"这类无法解释的漂移（ADR-0009 把它列为已知代价，
 * 这里的做法正好相反：让两个视图共用同一个渲染入口，从结构上不可能不一致）。
 *
 * 因此本文件不解析任何单元格：只负责"把一块源码交给唯一那条渲染管线，并判断它给出的东西
 * 是不是**一整张**表"。是不是表格由 markdown-it 说了算 —— 它不认（例如 GFM 要求表头与分隔行
 * 列数一致，而 `| a | b |` + `| --- |` 不满足）时返回 `null`，调用方据此**原样显示**，
 * 这正是 ADR-0009 的"宁可原样显示，也不要渲染得和阅读视图不同"。
 */

import { renderMarkdown } from '@/domain/markdown'

import type { ImageResolution } from './types'

/**
 * 规模上限：超过就**不**渲染（原样显示）。
 *
 * 为什么需要：lezer 的 `Table` 节点覆盖的是"整个段落"（GFM 允许表体行没有竖线、由渲染器补齐），
 * 所以一篇"每一行都含 `|` 的一万行笔记"在语法上就是一张一万行的表。渲染它要跑一遍
 * markdown-it + DOMPurify（还要产出上万个 DOM 节点），而装饰是**每次按键**都要算的 ——
 * 那会直接违反 ADR-0009 的"装饰只按视口算"。
 * 真人写的表格不会到这个量级；真到了，原样显示仍然可用（可读、可编辑、可格式化）。
 */
export const MAX_TABLE_LINES = 200
export const MAX_TABLE_CHARS = 20_000

/** 语法树节点里"表格不能被渲染"的容器：引用块与列表项。 */
const NESTED_CONTAINERS = new Set(['Blockquote', 'ListItem'])

/**
 * 节点是活的语法树节点（这里只要它的 `name` 与 `parent`）。
 *
 * 与 `build.ts` 的 `SyntaxNodeLike` 同一个理由：`@lezer/common` 不是本包的直接依赖，
 * 不去 import 它的类型，只描述用到的形状。
 */
interface NodeLike {
  readonly name: string
  readonly parent: NodeLike | null
}

/**
 * 这块源码值得交给渲染管线吗（行数 / 字符数上限）。
 *
 * 与 {@link MAX_TABLE_LINES} 的说明对应：这是"异常大"的护栏，不是正常路径上的判断。
 */
export function tableSourceWithinLimits(lineCount: number, source: string): boolean {
  return lineCount <= MAX_TABLE_LINES && source.length <= MAX_TABLE_CHARS
}

/**
 * 表格是否嵌在引用块 / 列表项里。
 *
 * GFM 在带 `> ` 前缀或列表缩进时**也**能解析出表格（阅读视图就是这么渲染的），但编辑器里的这一块
 * 还叠着引用块的左侧竖线（`emitQuoteLines`）与列表的续行规则：把一块 `display: block` 的表格
 * 塞进那些行里，等于让两条互不知情的排版规则争同一行。这里选择**原样显示**（ADR-0009 的口径：
 * 宁可不装饰），而不是渲染出一个"与阅读视图未必一致、还带竖线"的表格。
 */
export function isNestedTable(node: NodeLike): boolean {
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (NESTED_CONTAINERS.has(parent.name)) return true
  }
  return false
}

/**
 * 把一块表格源码渲染成 HTML（**已经过唯一那条净化管线**）。
 *
 * 返回 `null` = "这不是一张能整块渲染的表"，调用方保持原样显示。三种情况：
 * 1. markdown-it 压根没解析成表（列数不齐、没有分隔行……）；
 * 2. 只解析出了前半截（超出 markdown-it 的"补齐单元格"上限时会提前收尾），
 *    后半截会变成段落 —— 那样 widget 里会多出一段文字，而它在阅读视图里是表格外面的一行；
 * 3. 渲染结果不是从 `<table>` 开始到 `</table>` 结束（同上，留出更严的判据）。
 *
 * @param resolveImage 编辑器侧的"这张图现在能不能显示"（只读缓存、不发请求，见 assets.ts）
 */
export function renderTableHtml(
  source: string,
  resolveImage: (src: string) => ImageResolution,
): string | null {
  const html = renderMarkdown(source, {
    // 预览层的 `unauthorized` 分支（带 `data-mn-asset` 骨架、由预览组件去换授权）在这里**刻意不用**：
    // 编辑器有一条自己的逐文件授权链路（live-preview/assets.ts 的 stage/flush）。
    // 两边都做一次，同一张图会被请求两遍，还会多出一个与授权状态不同步的骨架。
    // "还没授权"在这里就是 `null` → 占位文本，授权回来后会重算成真的 `<img>`。
    resolveImage: (src: string) => {
      const resolution = resolveImage(src)
      return resolution.kind === 'ready' ? { kind: 'ready', url: resolution.url } : null
    },
  })

  const trimmed = html.trim()
  if (!trimmed.startsWith('<table')) return null
  if (!trimmed.endsWith('</table>')) return null
  return trimmed
}
