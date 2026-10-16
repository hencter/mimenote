/**
 * 正文行内 `#标签` 的 span 扫描。
 *
 * 两个真实调用方（预览用的 `markdown-core`、编辑器 Live Preview 的 `build.ts`）都直接拿
 * `from`/`to` 去 slice 原文：下标差一位不会抛异常，只会把标签切掉半个字、或者把后面的空格吞进来，
 * 肉眼还未必看得出来。所以每个用例都同时断言下标字面量**和** `text.slice(from, to)` —— 只断言数字
 * 看不出"切歪"。
 *
 * 另外标题行必须整体不认标签（`#`/`##` 开头）：预览侧本来就跳过标题，编辑器侧若放行，
 * 同一行在两种视图里会长得不一样。
 */

import { describe, expect, it } from 'vitest'

import { inlineTagSpans } from '@/domain/inline-tags'

/** 把 span 还原成文本：`from`/`to` 的最终判据是"切出来的这一段对不对"。 */
function slicesOf(text: string): string[] {
  return inlineTagSpans(text).map((span) => text.slice(span.from, span.to))
}

describe('基本命中', () => {
  it('行中间的标签覆盖 `#` 到标签体末尾（下标相对这一行）', () => {
    const text = '正文 #结构'
    // 正0 文1 空格2 #3 结4 构5 → span 是半开区间 [3, 6)
    expect(inlineTagSpans(text)).toEqual([{ from: 3, to: 6 }])
    expect(slicesOf(text)).toEqual(['#结构'])
  })

  it('行首没有前置空白也算标签', () => {
    // `#` 位于行首时 `(?:^|\s)` 由 `^` 命中；这条与"标题行不认标签"只差后面有没有空白，
    // 是同一段判断里最容易写错的地方。
    const text = '#结构 的说明'
    expect(inlineTagSpans(text)).toEqual([{ from: 0, to: 3 }])
    expect(slicesOf(text)).toEqual(['#结构'])
  })

  it('层级标签 `#项目/子项` 整体命中', () => {
    const text = '参见 #项目/子项 的说明'
    expect(inlineTagSpans(text)).toEqual([{ from: 3, to: 9 }])
    expect(slicesOf(text)).toEqual(['#项目/子项'])
  })

  it('末尾多余的 `/` 不算进 span（`#项目/` 与 `#项目` 是同一个标签）', () => {
    const text = '标签 #项目/ 结束'
    // 若把 `/` 算进去，标签体就会变成 `项目/`，索引侧会多出一个永远匹配不到的标签。
    expect(inlineTagSpans(text)).toEqual([{ from: 3, to: 6 }])
    expect(slicesOf(text)).toEqual(['#项目'])
  })
})

describe('不命中', () => {
  it('标题行（`##` 或多级、`#` 后是空白）整体返回空', () => {
    expect(inlineTagSpans('## 标题')).toEqual([])
    expect(inlineTagSpans('### 三级标题')).toEqual([])
    expect(inlineTagSpans('# 标题')).toEqual([])
    // 缩进的标题同样要挡住：Markdown 允许最多 3 个前导空格
    expect(inlineTagSpans('   # 标题')).toEqual([])
  })

  it('纯数字、`#` 后没有合法字符、`#` 前不是空白/行首都不算标签', () => {
    expect(inlineTagSpans('#123')).toEqual([])
    expect(inlineTagSpans('编号 #123 结束')).toEqual([])
    expect(inlineTagSpans('正文 #')).toEqual([])
    // `#/` 里只有一个分隔符，去掉尾部 `/` 后标签体为空
    expect(inlineTagSpans('正文 #/ 结束')).toEqual([])
    // 词中间的 `#` 不是标签（`C#`、URL 锚点、`foo#bar` 都靠这条挡掉）
    expect(inlineTagSpans('a#b')).toEqual([])
    expect(inlineTagSpans('https://a.example/#锚点')).toEqual([])
  })
})

describe('一行多个与字符集', () => {
  it('一行里多个标签各自独立命中，下标互不影响', () => {
    const text = '甲 #一号 乙 #二号/子 丙'
    // 甲0 空格1 #2 一3 号4 空格5 乙6 空格7 #8 二9 号10 /11 子12 空格13 丙14
    expect(inlineTagSpans(text)).toEqual([
      { from: 2, to: 5 },
      { from: 8, to: 13 },
    ])
    expect(slicesOf(text)).toEqual(['#一号', '#二号/子'])
  })

  it('`_`、`-`、Unicode 字母数字（含中文）都是合法标签体', () => {
    const text = '标记 #snake_case-甲 结束'
    // 标0 记1 空格2 #3 标签体 12 个字符（4..15）→ 半开区间 [3, 16)
    expect(inlineTagSpans(text)).toEqual([{ from: 3, to: 16 }])
    expect(slicesOf(text)).toEqual(['#snake_case-甲'])

    const cjk = '看 #中文标签'
    expect(inlineTagSpans(cjk)).toEqual([{ from: 2, to: 7 }])
    expect(slicesOf(cjk)).toEqual(['#中文标签'])
  })

  it('换行后一行的行首标签仍然命中（正文是多行拼接时不能只认整段开头）', () => {
    const text = '正文\n#标签'
    // 正0 文1 \n2 #3 标4 签5
    expect(inlineTagSpans(text)).toEqual([{ from: 3, to: 6 }])
    expect(slicesOf(text)).toEqual(['#标签'])
  })
})

describe('空输入与超长输入不抛错', () => {
  it('空字符串、纯空白、超长无标签文本都返回空数组', () => {
    expect(inlineTagSpans('')).toEqual([])
    expect(inlineTagSpans('   \n\t  ')).toEqual([])
    // 超长输入只是防"整段过一遍正则"炸掉/卡死：这条也是性能兜底
    expect(inlineTagSpans('纯文本 '.repeat(5000))).toEqual([])
  })

  it('成千上万个标签时逐个给对下标', () => {
    const text = '#标签 '.repeat(300)
    const spans = inlineTagSpans(text)
    expect(spans).toHaveLength(300)
    // 每块 4 个字符（`#标签` + 一个空格），第 300 块起点 1196、终点 1199
    expect(spans[0]).toEqual({ from: 0, to: 3 })
    expect(spans[299]).toEqual({ from: 1196, to: 1199 })
    expect(slicesOf(text)).toEqual(Array.from({ length: 300 }, () => '#标签'))
  })
})

describe('多行文本（标题守卫只作用于自己那一行）', () => {
  it('标题行整行不扫，但它后面的行照常扫（偏移量相对整段文本）', () => {
    // 守卫按**行**判：`## 标题` 不该让同一段文本里其它行的标签一起消失。
    expect(inlineTagSpans('# 标题\n正文 #结构')).toEqual([{ from: 8, to: 11 }])
    expect(inlineTagSpans('正文 #甲\n## 小标题\n正文 #乙')).toEqual([
      { from: 3, to: 5 },
      { from: 16, to: 18 },
    ])
    // 只有标题时仍然是空的
    expect(inlineTagSpans('## 标题')).toEqual([])
  })
})
