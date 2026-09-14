// @vitest-environment jsdom
/**
 * Obsidian 风格 **callout**（`> [!note] 标题`）的解析与渲染。
 *
 * 这一层测的是"哪种写法算 callout、渲染成什么 HTML"——两份都是纯函数，因此可以直接断言：
 *
 * 1. **解析只有一份**（`domain/callouts.ts`）：类型别名、折叠标记、未知类型、误判边界；
 * 2. **渲染**（`renderMarkdown`，与阅读视图、单篇导出、静态站点同一条管线）：callout 的
 *    结构、标题回落、块内其它内容原样保留、普通引用块一个字不变。
 *
 * Rust 侧不参与（Markdown 渲染只有前端一份，见 ADR-0002/0011/0019）。
 */

import { describe, expect, it } from 'vitest'

import {
  CALLOUT_TYPES,
  FALLBACK_CALLOUT_TYPE,
  calloutTitle,
  parseCallout,
} from '@/domain/callouts'
import { renderMarkdown } from '@/domain/markdown'

describe('解析：哪种写法算 callout', () => {
  it('基本形态：类型 + 标题 + 折叠标记', () => {
    expect(parseCallout('[!note] 标题')).toEqual({
      type: 'note',
      rawType: 'note',
      known: true,
      title: '标题',
      body: '',
      fold: null,
    })
    expect(parseCallout('[!note]-')).toEqual({
      type: 'note',
      rawType: 'note',
      known: true,
      title: '',
      body: '',
      fold: '-',
    })
    expect(parseCallout('[!tip]+ 展开的提示')).toMatchObject({ type: 'tip', title: '展开的提示', fold: '+' })
  })

  it('标题与正文的分界：**第一个换行**之后都算正文（相邻两行引用是同一个段落）', () => {
    // CommonMark 里 `> [!note] 标题` 与 `> 正文` 是同段落的软换行，markdown-it 交给我们的是
    // 一个 inline 令牌，内容是 "[!note] 标题\n正文" —— 分界线只能在这里切。
    const callout = parseCallout('[!note] 标题\n正文第一行\n正文第二行')
    expect(callout).toMatchObject({ title: '标题', body: '正文第一行\n正文第二行' })

    // 正文里再出现 `[!…]` 不算新的标记（它不在第一行）
    expect(parseCallout('[!note] 甲\n[!tip] 这不是标记')).toMatchObject({ title: '甲' })
  })

  it('类型大小写不敏感，别名归到同一种', () => {
    expect(parseCallout('[!NOTE] 甲')?.type).toBe('note')
    expect(parseCallout('[!Hint] 甲')?.type).toBe('tip')
    expect(parseCallout('[!important] 甲')?.type).toBe('tip')
    expect(parseCallout('[!caution] 甲')?.type).toBe('warning')
    expect(parseCallout('[!error] 甲')?.type).toBe('danger')
    expect(parseCallout('[!summary] 甲')?.type).toBe('abstract')
    expect(parseCallout('[!faq] 甲')?.type).toBe('question')
  })

  it('未知类型不报错：按 note 的样式渲染，但保留用户写的名字', () => {
    const callout = parseCallout('[!摘录] 一段原文')
    expect(callout).toMatchObject({
      type: FALLBACK_CALLOUT_TYPE,
      rawType: '摘录',
      known: false,
      title: '一段原文',
    })
    // 标题留空时才回落到"用户写的类型名" —— 他至少能看出"系统不认识这个词"
    expect(calloutTitle(callout!)).toBe('一段原文')
    expect(calloutTitle(parseCallout('[!摘录]')!)).toBe('摘录')
    expect(calloutTitle(parseCallout('[!note]')!)).toBe('笔记')
  })

  it('前后空白与 `[!` 前的空格都容忍', () => {
    expect(parseCallout('  [!note]   标题  ')?.title).toBe('标题')
    expect(parseCallout('[! note ] 标题')?.rawType).toBe('note')
  })

  it('不是 callout 的几种写法一律拒绝（引用里写方括号很常见）', () => {
    expect(parseCallout('[note] 甲')).toBeNull() // 少了 `!`
    expect(parseCallout('我觉得 [!note] 挺好')).toBeNull() // 不在行首
    expect(parseCallout('[!]')).toBeNull() // 类型为空
    expect(parseCallout('[!note')).toBeNull() // 没有闭合
    expect(parseCallout('')).toBeNull()
  })

  it('每种类型的图标名都在 Icon 组件的名单里（写错名字会渲染成空白）', () => {
    // 这条断言的价值：图标名是**跨模块的字符串契约**（callouts.ts ↔ components/Icon.tsx），
    // 类型系统拦不住拼错，而错了以后界面上只是"少了一个图标"，很难被发现。
    const available = new Set([
      'alert',
      'check',
      'chevron',
      'columns',
      'dot',
      'eye',
      'file',
      'folder',
      'folderOpen',
      'info',
      'links',
      'menu',
      'move',
      'name',
      'outline',
      'palette',
      'panelLeft',
      'pencil',
      'plus',
      'refresh',
      'save',
      'search',
      'settings',
      'sidebarRight',
      'sparkle',
      'trash',
      'type',
      'x',
    ])
    for (const [type, definition] of Object.entries(CALLOUT_TYPES)) {
      expect(available.has(definition.icon), `${type} 的图标 ${definition.icon} 不在 Icon 里`).toBe(true)
      expect(definition.token.startsWith('--mn-callout-'), `${type} 的令牌名要带 --mn-callout- 前缀`).toBe(true)
    }
  })
})

describe('渲染（与阅读视图/导出件同一条管线）', () => {
  it('引用块变成带类型类名的 callout，标题栏里有图标与标题', () => {
    const html = renderMarkdown('> [!warning] 小心\n> 正文一行。\n')

    expect(html).toContain('<div class="mn-callout mn-callout--warning">')
    expect(html).toContain('class="mn-callout__title"')
    expect(html).toContain('class="mn-callout__icon"')
    expect(html).toContain('class="mn-callout__label">小心<')
    // 正文照旧在块里（callout 不吞内容）
    expect(html).toContain('正文一行。')
    // 不再是 blockquote
    expect(html).not.toContain('<blockquote>')
  })

  it('标题留空时用类型的展示名（未知类型则用用户写的名字）', () => {
    expect(renderMarkdown('> [!tip]\n> 甲\n')).toContain('class="mn-callout__label">提示<')
    expect(renderMarkdown('> [!摘录]\n> 甲\n')).toContain('class="mn-callout__label">摘录<')
  })

  it('折叠标记渲染成一个说明性符号（静态渲染**不真的收起**）', () => {
    const html = renderMarkdown('> [!note]- 标题\n> 甲\n')
    expect(html).toContain('class="mn-callout__fold"')
    expect(html).toContain('甲')
  })

  it('块内的列表 / 代码块 / 表格原样保留（只有首行的标记被换成标题栏）', () => {
    const html = renderMarkdown(
      ['> [!example] 示例', '>', '> - 甲', '> - 乙', '>', '> ```ts', '> const a = 1', '> ```'].join('\n'),
    )

    expect(html).toContain('mn-callout--example')
    expect(html).toContain('<li>甲</li>')
    expect(html).toContain('language-ts')
    expect(html).toContain('const a = 1')
  })

  it('嵌套：callout 里的引用是**普通引用**，不会被当成第二个 callout', () => {
    const html = renderMarkdown('> [!note] 外层\n> > 内层引用\n')
    expect((html.match(/mn-callout /gu) ?? []).length).toBe(1)
    expect(html).toContain('<blockquote>')
  })

  it('嵌套 callout（引用里再写 `[!…]`）也能工作，两层各有一个标题栏', () => {
    const html = renderMarkdown('> [!note] 外层\n> > [!tip] 内层\n> > 甲\n')
    expect(html).toContain('mn-callout--note')
    expect(html).toContain('mn-callout--tip')
    expect((html.match(/mn-callout__title/gu) ?? []).length).toBe(2)
  })

  it('`> > [!tip]` 的标记属于**内层**引用：外层保持普通引用，只有内层变成 callout', () => {
    // 两层都读同一行：判据若不分层，同一段会被改两次（外层先把 `[!tip]` 换成标题栏，
    // 内层再去解析就只能读到 HTML），结果是"两层引用变成两层 callout"这种没人想要的嵌套
    const html = renderMarkdown('> > [!tip] 内层\n')
    expect((html.match(/mn-callout /gu) ?? []).length).toBe(1)
    expect(html).toContain('mn-callout--tip')
    expect(html).toContain('<blockquote>')
  })

  it('普通引用块**一个字都不变**（不因为这条新语法而多出类名）', () => {    const html = renderMarkdown('> 只是引用\n')
    expect(html).toContain('<blockquote>')
    expect(html).not.toContain('mn-callout')
  })

  it('行内的 `[!note]` 不触发（只有引用块的首行才算）', () => {
    const html = renderMarkdown('这一段里写了 [!note] 几个字。\n')
    expect(html).not.toContain('mn-callout')
  })

  it('XSS：callout 里的原始 HTML 一律被转义/剥掉，不留可执行的东西', () => {
    const html = renderMarkdown('> [!note] <img src=x onerror=alert(1)>\n> <script>alert(1)</script>\n')

    // 标签本身不许出现（用户写的那两行都只是文字）
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    // 转义后的**文本**留在标题里（可见、无害），这才是"原文保真 + 不执行"的正确结果
    expect(html).toContain('&lt;img')
  })
})
