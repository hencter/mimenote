/**
 * 静态站点的**路径与 URL 算术**（ADR-0019 的骨架）。
 *
 * 这一层全是纯函数，所以测试也全是"输入 → 输出"的直接断言。两条最该钉死的性质：
 *
 * 1. **编码规则**：CJK、空格、`#`、`%` 都要变成**大写**十六进制的百分号编码，而 unreserved 集合
 *    一个都不许动（多编一个字符会让地址栏里多出一串 `%2D`，看起来像坏了）；
 * 2. **相对路径**：跨目录的 `../` 层数、同页的退化写法。宿主侧（`mn_core::site::relative_href`）
 *    有一份等价实现，两边的输出必须一致 —— 不一致就会出现"页面里的链接指向不存在的文件名"。
 */

import { describe, expect, it } from 'vitest'

import {
  assignPagePaths,
  encodeUrlPath,
  encodeUrlSegment,
  pageDir,
  pagePathForNote,
  siteAssetHref,
  siteRelativeHref,
} from '@/domain/site-paths'

describe('页面命名：镜像目录树 + .md → .html', () => {
  it('笔记映射到同目录同名的 .html（保留 CJK 与空格）', () => {
    expect(pagePathForNote('设计.md')).toBe('设计.html')
    expect(pagePathForNote('项目/设计 草案.md')).toBe('项目/设计 草案.html')
    expect(pagePathForNote('笔记.markdown')).toBe('笔记.html')
    // 大小写不敏感的扩展名：Windows 上 `README.MD` 也是笔记
    expect(pagePathForNote('README.MD')).toBe('README.html')
  })

  it('不是 Markdown 的一律不给页面（附件、图片、无扩展名）', () => {
    expect(pagePathForNote('附件/图.png')).toBeNull()
    expect(pagePathForNote('笔记.txt')).toBeNull()
    expect(pagePathForNote('无扩展名')).toBeNull()
    // 隐藏文件（`.md` 开头）也不算：`lastIndexOf('.')` 落在 0 上
    expect(pagePathForNote('.md')).toBeNull()
  })

  it('同名笔记撞到同一个页面路径时，第二份按顺序加后缀并如实报出', () => {
    const { pageOf, renamed } = assignPagePaths(['笔记/设计.md', '笔记/设计.markdown', '另一篇.md'])

    expect(pageOf.get('笔记/设计.md')).toBe('笔记/设计.html')
    expect(pageOf.get('笔记/设计.markdown')).toBe('笔记/设计-2.html')
    expect(pageOf.get('另一篇.md')).toBe('另一篇.html')
    expect(renamed).toEqual([{ relPath: '笔记/设计.markdown', pagePath: '笔记/设计-2.html' }])
  })

  it('没有撞名报告为空（界面据此决定要不要说"有 N 篇换了地址"）', () => {
    const { renamed } = assignPagePaths(['甲.md', '乙.md'])
    expect(renamed).toEqual([])
  })

  it('页面所在目录：根目录是空串', () => {
    expect(pageDir('设计.html')).toBe('')
    expect(pageDir('项目/设计.html')).toBe('项目')
    expect(pageDir('项目/子/设计.html')).toBe('项目/子')
  })
})

describe('URL 编码：只放行 unreserved，十六进制大写', () => {
  it('CJK、空格、`#`、`%` 都被编码', () => {
    expect(encodeUrlSegment('设计')).toBe('%E8%AE%BE%E8%AE%A1')
    expect(encodeUrlSegment('设计 草案')).toBe('%E8%AE%BE%E8%AE%A1%20%E8%8D%89%E6%A1%88')
    expect(encodeUrlSegment('C# 笔记')).toBe('C%23%20%E7%AC%94%E8%AE%B0')
    // `%` 必须是 `%25`：文件名里带 `%` 时不编码会让浏览器把后面两个字符当成转义
    expect(encodeUrlSegment('100%.md')).toBe('100%25.md')
  })

  it('unreserved 集合一个都不动（`-._~` 与字母数字原样保留）', () => {
    expect(encodeUrlSegment('aZ09-._~')).toBe('aZ09-._~')
  })

  it('路径逐段编码但保留分隔符', () => {
    expect(encodeUrlPath('项目/设计 草案.html')).toBe(
      '%E9%A1%B9%E7%9B%AE/%E8%AE%BE%E8%AE%A1%20%E8%8D%89%E6%A1%88.html',
    )
  })
})

describe('相对链接：`../` 算术与同页退化', () => {
  // 期望值都是**编码之后**的：href 会原样写进 `<a href="…">`，所以相对链接里的 CJK
  // 与磁盘上的文件名长得不一样是正常的（磁盘保留原名，链接里是编码形式）。
  it('同目录：只有文件名', () => {
    expect(siteRelativeHref('项目/甲.html', '项目/乙.html')).toBe('%E4%B9%99.html')
  })

  it('跨目录：先上后下', () => {
    expect(siteRelativeHref('项目/甲.html', '甲.html')).toBe('../%E7%94%B2.html')
    expect(siteRelativeHref('项目/子/甲.html', '项目/乙.html')).toBe('../%E4%B9%99.html')
    expect(siteRelativeHref('甲.html', '项目/子/乙.html')).toBe(
      '%E9%A1%B9%E7%9B%AE/%E5%AD%90/%E4%B9%99.html',
    )
    expect(siteRelativeHref('甲/乙/丙.html', '甲/丁.html')).toBe('../%E4%B8%81.html')
  })

  it('每一段都编码（目录名里的空格与 CJK 也一样）', () => {
    expect(siteRelativeHref('甲.html', '项目 空/设计 草案.html')).toBe(
      '%E9%A1%B9%E7%9B%AE%20%E7%A9%BA/%E8%AE%BE%E8%AE%A1%20%E8%8D%89%E6%A1%88.html',
    )
  })

  it('锚点：编码后接在片段上；同页时退化成纯片段', () => {
    expect(siteRelativeHref('项目/甲.html', '项目/乙.html', '小节')).toBe(
      '%E4%B9%99.html#%E5%B0%8F%E8%8A%82',
    )
    expect(siteRelativeHref('项目/甲.html', '项目/甲.html', '小节')).toBe('#%E5%B0%8F%E8%8A%82')
  })

  it('同页且没有锚点时给文件名本身，而不是 `#`（`#` 会让浏览器跳到页面顶部）', () => {
    expect(siteRelativeHref('项目/甲.html', '项目/甲.html')).toBe('%E7%94%B2.html')
  })

  it('图片地址固定落在 assets/ 下（保留原 Vault 相对路径）', () => {
    expect(siteAssetHref('项目/甲.html', '附件/图.png')).toBe(
      '../assets/%E9%99%84%E4%BB%B6/%E5%9B%BE.png',
    )
    expect(siteAssetHref('甲.html', '附件/图 1.png')).toBe(
      'assets/%E9%99%84%E4%BB%B6/%E5%9B%BE%201.png',
    )
  })
})
