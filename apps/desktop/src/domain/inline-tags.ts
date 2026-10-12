/**
 * 正文行内 `#标签` 的 span 扫描。
 *
 * ## 为什么单独一份
 * "什么算标签"的判据必须与**宿主索引**（`crates/mn-core` 的标签抽取）一致，否则
 * 索引里有的标签在界面上不亮、界面上亮的标签索引里没有 —— 同一份数据两个真相。
 * 所以这里只做"在**一行文本**里找出标签的位置"，供两处消费：
 * 编辑器所见即所得（`cm/live-preview/build.ts` 加 `mn-inline-tag` 装饰）与
 * 阅读视图（`domain/markdown-core.ts` 的 markdown-it 规则加同一个类名）。
 * 两处都拿它的**下标**，因此样式与判据各只有一份。
 *
 * ## 与索引（Rust）对齐的口径
 * - `#` 前必须是行首或空白，后面必须是 Unicode 字母/数字/`_`/`-`/`/`；
 * - **纯数字不算标签**（`#123` 是 Issue 号，不是标签）；
 * - 行首的 `# 标题` / `## 标题` 不算 —— 那是 ATX 标题的语法，不是标签；
 * - 尾部的 `/` 归分隔符（`#项目/` 的 span 到 `项目` 为止）。
 *
 * 调用方自己负责"哪些行不该扫"（代码块、行内代码、frontmatter、链接目标）——
 * 那件事只有块级/文档级信息才知道，行内扫描器看不到。
 */

/** 一行文本里的标签区间（下标是**该行文本内**的偏移，不是全文偏移）。 */
export interface InlineTagSpan {
  from: number
  to: number
}

/**
 * 「标签名字符」的**唯一判据**（Unicode 字母数字 + `_` + `-` + 层级 `/`）。
 *
 * 为什么导出它：Mock 适配器（`ipc/mock/tags.ts`）也要按同一个口径逐字符扫描
 * （它比这里的行内扫描多做了代码块/注释的遮蔽）。判据写两遍，就会出现
 * "编辑器认为 `#项目/子` 是标签、Mock 认为不是"这类只在浏览器预览里复现的偏差。
 */
export const INLINE_TAG_CHAR_CLASS = '\\p{L}\\p{N}_/-'

const TAG_CHAR = new RegExp(`^[${INLINE_TAG_CHAR_CLASS}]$`, 'u')
const TAG_AT = new RegExp(`(?:^|\\s)#([${INLINE_TAG_CHAR_CLASS}]+)`, 'gu')

/** 单个字符是否算标签名字符（见 {@link INLINE_TAG_CHAR_CLASS}）。 */
export function isInlineTagChar(char: string): boolean {
  return TAG_CHAR.test(char)
}

/**
 * 扫描文本里的标签（**逐行**判，偏移量相对整段文本）。
 *
 * 标题守卫是按**行**作用的：`## 标题` 整行不扫（与索引口径一致 —— 宿主抽取标签
 * 同样跳过标题行），但它**不该**让同一段文本里其它行的标签一起消失。
 * 调用方现在都传单行（编辑器传 `line.text`、markdown-it 传行内 token），
 * 所以这条对线上行为没有影响；对导出的纯函数来说，它是"多行输入也对"的那一半。
 *
 * 返回的是**位置**而不是文本：调用方要在编辑器里加装饰、在阅读视图里插 `<span>`，
 * 两者都需要位置；只返回文本会逼调用方自己去 `indexOf`，于是同一行里重复出现的
 * 标签必然定位错。
 */
export function inlineTagSpans(text: string): InlineTagSpan[] {
  const spans: InlineTagSpan[] = []
  let offset = 0
  for (const line of text.split('\n')) {
    // 标题行整行不扫：`# 标题` / `## 标题` 的 `#` 后面要么是空白、要么是连续 `#`，
    // 两种情况都不该产出一个"标签"。整行短路比逐个 match 再去重便宜。
    if (!/^\s*#{2,}|^\s*#(?:\s|$)/u.test(line)) {
      // `(?:^|\s)` 收进 match 里（要让"前面是空白"参与匹配），算下标时再把它扣掉。
      for (const match of line.matchAll(TAG_AT)) {
        // 层级标签的尾部 `/` 是分隔符，不是名字的一部分
        const body = (match[1] ?? '').replace(/\/+$/, '')
        if (!body || /^[\p{N}]+$/u.test(body)) continue
        const from = offset + match.index + match[0].indexOf('#')
        // `to` 是**排他**边界（CodeMirror 与 DOM Range 同一口径）
        spans.push({ from, to: from + body.length + 1 })
      }
    }
    // +1 = 被 `split('\n')` 吃掉的那个换行符
    offset += line.length + 1
  }
  return spans
}
