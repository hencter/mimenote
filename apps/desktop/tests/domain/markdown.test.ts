// @vitest-environment jsdom
/**
 * Markdown 渲染与 XSS 净化。
 *
 * 这是安全门禁的核心测试：笔记内容即便来自不可信来源（别人分享的 Vault、
 * 剪贴板粘贴），也不允许在 WebView 里执行脚本。
 */

import { describe, expect, it } from 'vitest'

import { renderInline, renderMarkdown, sanitizeHtml } from '@/domain/markdown'

describe('本地图片（asset: 协议，ADR-0007）', () => {
  const source = '![示例图](../附件/图.png)'

  it('没有解析器时渲染占位元素（含原始地址，便于用户看懂缺了什么）', () => {
    const html = renderMarkdown(source)
    expect(html).toContain('mn-image-placeholder')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('data-mn-asset')
    // markdown-it 会把非 ASCII 路径百分号编码，所以要解码后再比对
    expect(decodeURIComponent(html)).toContain('../附件/图.png')
  })

  it('解析器说"未授权"时渲染带 data-mn-asset 标记的占位元素（等宿主授权）', () => {
    const html = renderMarkdown(source, {
      resolveImage: () => ({ kind: 'unauthorized', rel: '附件/图.png' }),
    })
    expect(html).not.toContain('<img')
    expect(html).toContain('data-mn-asset="附件/图.png"')
  })

  it('解析器说"已授权"时渲染 img，并把原始地址留在 data-mn-src 上（加载失败回退用）', () => {
    const html = renderMarkdown(source, {
      resolveImage: (src: string) => ({
        kind: 'ready',
        url: `http://asset.localhost/${encodeURIComponent(src)}`,
      }),
    })
    expect(html).toContain('<img')
    expect(html).toContain('class="mn-image"')
    expect(html).toContain('alt="示例图"')
    expect(decodeURIComponent(html)).toContain('data-mn-src="../附件/图.png"')
  })

  it('解析器返回 null（外部地址/越界路径）时回退占位元素', () => {
    const html = renderMarkdown('![x](https://example.com/a.png)', { resolveImage: () => null })
    expect(html).not.toContain('<img')
    expect(html).toContain('mn-image-placeholder')
    expect(html).not.toContain('data-mn-asset')
  })

  it('渲染成功时外面套一层 .mn-figure（承载图注与"点击查看原图"），失败回退不含它', () => {
    const ready = renderMarkdown(source, {
      resolveImage: () => ({ kind: 'ready', url: 'asset://localhost/x.png' }),
    })
    expect(ready).toContain('class="mn-figure')
    expect(ready).toContain('mn-image__caption')
    expect(ready).toContain('mn-image__hint')

    // 占位路径刻意**不**包容器：预览层的失败回退是把 <img> 原地换成占位元素，
    // 两种情况下结构必须一模一样，否则"失败后"和"从没成功过"会长得不一样
    const placeholder = renderMarkdown(source, { resolveImage: () => null })
    expect(placeholder).not.toContain('mn-figure')
  })

  it('图注优先用 alt，没有 alt 时用 title（markdown 的 `"标题"` 写法）', () => {
    const withAlt = renderMarkdown(source, {
      resolveImage: () => ({ kind: 'ready', url: 'asset://localhost/x.png' }),
    })
    expect(withAlt).toContain('<span class="mn-image__caption">示例图</span>')

    const noAlt = renderMarkdown('![](图.png "磁盘上的图")', {
      resolveImage: () => ({ kind: 'ready', url: 'asset://localhost/x.png' }),
    })
    expect(noAlt).toContain('<span class="mn-image__caption">磁盘上的图</span>')
  })

  it('独占一段的图片用块级容器（能居中），夹在文字里的仍然是行内', () => {
    const resolver = {
      resolveImage: () => ({ kind: 'ready' as const, url: 'asset://localhost/x.png' }),
    }
    expect(renderMarkdown('![](图.png)', resolver)).toContain('mn-figure mn-figure--block')
    expect(renderMarkdown('前面 ![](图.png) 后面', resolver)).toContain(
      'class="mn-figure"><img',
    )
  })

  it('`asset:` scheme 能通过净化（否则 macOS/Linux 上图片会被静默剥掉）', () => {
    const html = renderMarkdown(source, {
      resolveImage: () => ({ kind: 'ready', url: 'asset://localhost/%E5%9B%BE.png' }),
    })
    expect(html).toContain('asset://localhost/%E5%9B%BE.png')
  })

  it('解析器给出可疑 scheme 时不渲染 img（渲染层只认白名单）', () => {
    const html = renderMarkdown('![x](图.png)', {
      resolveImage: () => ({ kind: 'ready', url: 'javascript:alert(1)' }),
    })
    expect(html).not.toContain('<img')
    expect(html).toContain('mn-image-placeholder')
    expect(html).not.toMatch(/src\s*=\s*"javascript:/i)
  })
})

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

  it('没有解析器时（浏览器预览、非 Tauri 运行时）渲染为占位元素而不是必然失败的 img', () => {
    const html = renderMarkdown('![示意图](images/a.png)')
    expect(html).toContain('mn-image-placeholder')
    expect(html).toContain('示意图')
    expect(html).not.toContain('<img')
  })
})

describe('`![[…]]` 嵌入（Obsidian 风格）', () => {
  const ready = {
    resolveImage: () => ({ kind: 'ready' as const, url: 'asset://localhost/x.png' }),
  }

  it('图片目标是图片时走与 `![](…)` 同一条路径：目标原样交给解析器，渲染出 img', () => {
    const seen: string[] = []
    const html = renderMarkdown('![[附件/图.png]]', {
      resolveImage: (src: string) => {
        seen.push(src)
        return { kind: 'ready', url: `asset://localhost/${encodeURIComponent(src)}` }
      },
    })

    // 同一个解析器、同一个 src：与 `![](附件/图.png)` 完全一致（含相对路径的解析口径）
    expect(seen).toEqual(['附件/图.png'])
    expect(html).toContain('class="mn-image"')
    // 没有别名 → alt 用文件名
    expect(html).toContain('alt="图.png"')
    expect(decodeURIComponent(html)).toContain('data-mn-src="附件/图.png"')
  })

  it('图片目标在"等宿主授权"时渲染带 data-mn-asset 的占位（与 `![](…)` 同一约定）', () => {
    const html = renderMarkdown('![[附件/图.png]]', {
      resolveImage: () => ({ kind: 'unauthorized', rel: '附件/图.png' }),
    })
    expect(html).not.toContain('<img')
    expect(html).toContain('mn-image-placeholder')
    expect(html).toContain('data-mn-asset="附件/图.png"')
  })

  it('没有解析器时渲染普通占位元素（不带授权标记）', () => {
    const html = renderMarkdown('![[附件/图.png]]')
    expect(html).toContain('mn-image-placeholder')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('data-mn-asset')
    expect(decodeURIComponent(html)).toContain('附件/图.png')
  })

  it('别名作为 alt 与图注（`![[图.png|图注]]`）', () => {
    const html = renderMarkdown('![[附件/图.png|一张图注]]', ready)
    expect(html).toContain('alt="一张图注"')
    expect(html).toContain('<span class="mn-image__caption">一张图注</span>')
    expect(decodeURIComponent(html)).toContain('data-mn-src="附件/图.png"')
  })

  it('扩展名大小写不敏感，且白名单与宿主一致（png/jpg/jpeg/gif/webp/avif/bmp/svg/ico）', () => {
    const names = [
      '图.PNG',
      '图.jpg',
      '图.JpEg',
      '图.GIF',
      '图.WebP',
      '图.AVIF',
      '图.bmp',
      '图.SVG',
      '图.Ico',
    ]
    for (const name of names) {
      expect(renderMarkdown(`![[${name}]]`, ready), name).toContain('class="mn-image"')
    }
  })

  it('非图片目标渲染成与 wikilink 一致的链接，并带说明性 title', () => {
    const html = renderMarkdown('![[另一篇笔记]]')
    expect(html).toContain('class="mn-wikilink"')
    expect(html).toContain('data-target="另一篇笔记"')
    expect(html).toContain('data-mn-embed="non-image"')
    expect(html).toContain('嵌入非图片目标，按链接显示')
    expect(html).not.toContain('<img')
  })

  it('非图片目标的别名仍然按链接显示', () => {
    const html = renderMarkdown('![[另一篇笔记|显示文本]]')
    expect(html).toContain('data-target="另一篇笔记"')
    expect(html).toContain('>显示文本</span>')
    expect(html).not.toContain('<img')
  })

  it('`![[…]]` 自己也能解析出别名与锚点', () => {
    const html = renderMarkdown('![[笔记#小节|别名]]')
    expect(html).toContain('data-target="笔记"')
    expect(html).toContain('data-anchor="小节"')
  })

  it('`[[x]]`（不带 `!`）的行为一个字都没变', () => {
    const html = renderMarkdown('见 [[另一篇#小节|显示]]。')
    expect(html).toContain(
      '<a class="mn-wikilink" href="#mn-wikilink" data-target="另一篇" data-anchor="小节">显示</a>',
    )
    expect(html).not.toContain('data-mn-embed')
    expect(html).not.toContain('mn-wikilink__embed')
  })

  it('未闭合、空目标、代码块与行内代码里的 `![[…]]` 都不渲染', () => {
    expect(renderMarkdown('![[没有闭合')).toContain('![[没有闭合')
    expect(renderMarkdown('![[]]')).not.toContain('mn-wikilink')
    expect(renderMarkdown('```\n![[图.png]]\n```')).not.toContain('mn-image')
    expect(renderMarkdown('`![[图.png]]`')).not.toContain('mn-image')
  })

  it('嵌入目标里的 HTML 不会变成元素（净化仍然生效）', () => {
    const html = renderMarkdown('![[<img src=x onerror=alert(1)>.png]]')
    const container = document.createElement('div')
    container.innerHTML = html
    // 解析器缺席 → 占位元素，路径只作为（转义后的）文本出现
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('.mn-image-placeholder')).not.toBeNull()
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
