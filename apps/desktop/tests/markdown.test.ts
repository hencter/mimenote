// @vitest-environment jsdom
/**
 * Markdown 渲染与 XSS 净化。
 *
 * 这是安全门禁的核心测试：笔记内容即便来自不可信来源（别人分享的 Vault、
 * 剪贴板粘贴），也不允许在 WebView 里执行脚本。
 */

import { describe, expect, it } from 'vitest'

import { renderInline, renderMarkdown, sanitizeHtml } from '@/domain/markdown'

describe('renderMarkdown 基础渲染', () => {
  it('标题', () => {
    expect(renderMarkdown('# 标题')).toContain('<h1>标题</h1>')
  })

  it('段落、强调、行内代码', () => {
    const html = renderMarkdown('这是 **粗体** 与 `code`\n\n第二段')
    expect(html).toContain('<strong>粗体</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<p>第二段</p>')
  })

  it('列表与引用', () => {
    const html = renderMarkdown('- a\n- b\n\n> 引用')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>a</li>')
    expect(html).toContain('<blockquote>')
  })

  it('表格（GFM 常用语法）', () => {
    const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')
    expect(html).toContain('<table>')
    expect(html).toContain('<th>a</th>')
    expect(html).toContain('<td>1</td>')
  })

  it('围栏代码块保留内容并转义', () => {
    const html = renderMarkdown('```ts\nconst a = 1 < 2\n```')
    expect(html).toContain('<pre>')
    expect(html).toContain('const a = 1 &lt; 2')
  })

  it('外链带上 target 与 rel=noopener', () => {
    const html = renderMarkdown('[站点](https://example.com)')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer nofollow"')
  })

  it('本地图片渲染为占位元素（M1 限制，见 architecture.md §8.1）', () => {
    const html = renderMarkdown('![示意图](images/a.png)')
    expect(html).toContain('mn-image-placeholder')
    expect(html).toContain('示意图')
    expect(html).not.toContain('<img')
  })
})

describe('wikilink（M2）', () => {
  it('渲染成带 data-target 的锚点', () => {
    const html = renderMarkdown('见 [[另一篇]]。')
    expect(html).toContain('class="mn-wikilink"')
    expect(html).toContain('data-target="另一篇"')
    expect(html).toContain('>另一篇</a>')
  })

  it('别名与锚点', () => {
    const html = renderMarkdown('[[某篇#小节|显示文本]]')
    expect(html).toContain('data-target="某篇"')
    expect(html).toContain('data-anchor="小节"')
    expect(html).toContain('>显示文本</a>')
  })

  it('空目标指向文内锚点', () => {
    const html = renderMarkdown('[[#小节]]')
    expect(html).toContain('data-target=""')
    expect(html).toContain('>#小节</a>')
  })

  it('wikilink 不加 target=_blank（它是文内跳转，不是外链）', () => {
    const html = renderMarkdown('[[另一篇]]')
    expect(html).not.toContain('target="_blank"')
    expect(html).not.toContain('noopener')
  })

  it('普通外链仍然带 target 与 rel=noopener', () => {
    const html = renderMarkdown('[站点](https://example.com)')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer nofollow"')
  })

  it('未闭合或空 wikilink 保持原文', () => {
    expect(renderMarkdown('[[没有闭合')).toContain('[[没有闭合')
    expect(renderMarkdown('[[]]')).not.toContain('mn-wikilink')
  })

  it('代码块与行内代码里的 [[ ]] 不渲染', () => {
    expect(renderMarkdown('```\n[[不是链接]]\n```')).not.toContain('mn-wikilink')
    expect(renderMarkdown('`[[不是链接]]`')).not.toContain('mn-wikilink')
  })

  it('wikilink 里的 HTML 不会变成元素（净化仍然生效）', () => {
    const html = renderMarkdown('[[<img src=x onerror=alert(1)>]]')
    // 断 DOM 而不是断字符串：属性值里出现 `<img` 字样是无害的（在引号内），
    // 真正要保证的是它没有变成元素。
    const container = document.createElement('div')
    container.innerHTML = html
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('a.mn-wikilink')?.getAttribute('data-target')).toBe(
      '<img src=x onerror=alert(1)>',
    )
  })
})

describe('XSS 防护', () => {
  it('raw HTML 被关闭：script 变成纯文本', () => {
    const html = renderMarkdown('<script>alert(1)</script>')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;script&gt;')
  })

  it('事件属性载荷被转义为纯文本（不会成为真实属性）', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">')
    // 关键断言：标签本身没有进入 DOM
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
    // onerror 只能作为转义后的文本出现
    expect(html).not.toMatch(/<[^>]*\sonerror=/)
  })

  it('javascript: 链接被拒绝（markdown-it 校验 + DOMPurify 双保险）', () => {
    const html = renderMarkdown('[点我](javascript:alert(1))')
    expect(html).not.toContain('href="javascript:')
  })

  it('data:text/html 链接被拒绝', () => {
    const html = renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)')
    expect(html).not.toContain('href="data:text/html')
  })

  it('sanitizeHtml 作为第二道防线独立生效', () => {
    expect(sanitizeHtml('<img src=x onerror="alert(1)">')).not.toContain('onerror')
    expect(sanitizeHtml('<iframe src="https://evil.example"></iframe>')).not.toContain('<iframe')
    expect(sanitizeHtml('<style>body{display:none}</style>')).not.toContain('<style')
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:')
    // 保留下来的元素也必须是安全的
    expect(sanitizeHtml('<a href="https://ok.example">x</a>')).toContain('href="https://ok.example"')
  })

  it('renderInline 同样净化', () => {
    expect(renderInline('**粗** <b>原样</b>')).toContain('<strong>粗</strong>')
    expect(renderInline('<b>原样</b>')).not.toContain('<b>')
  })
})
