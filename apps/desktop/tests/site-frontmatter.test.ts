/**
 * 站点导出的 frontmatter 判据（ADR-0047 §4）：`draft` 过滤与 `slug` / `url` 覆盖输出路径。
 *
 * 全是纯函数，所以断言也全是"输入 → 输出"。这一层要钉死的是**两条不能含糊的性质**：
 *
 * 1. **越界一律拒绝**：覆盖值来自笔记正文，而它直接决定写盘路径 —— 每一个 `..`、盘符、UNC、
 *    保留名、非法字符的用例都是"必须退回默认路径"的钉子。少钉一个，就等于给"往输出目录外面写"
 *    留了一扇门；
 * 2. **拒绝是降级不是失败**：被拒绝的那一页照样导出（用默认地址），只是要**如实记一条**。
 *    这里断言那条记录的形态 —— 索引页与结果提示都消费它。
 */

import { describe, expect, it } from 'vitest'

import {
  buildSiteExportPathPlan,
  describeReject,
  pagePathForSlug,
  pagePathForUrl,
  parseSiteFrontmatter,
  resolveSitePagePath,
  type SiteNoteOverrideInput,
} from '@/domain/site-frontmatter'

/** 造一页输入（`frontmatter` 缺省 = 什么都不写）。 */
function note(
  relPath: string,
  defaultPagePath: string | null,
  frontmatter: Partial<ReturnType<typeof parseSiteFrontmatter>> = {},
): SiteNoteOverrideInput {
  return {
    relPath,
    defaultPagePath,
    frontmatter: { draft: false, slug: null, url: null, ...frontmatter },
  }
}

describe('解析 frontmatter 里的三个字段', () => {
  it('读得到顶格的 draft / slug / url，值去掉引号与行内注释', () => {
    const parsed = parseSiteFrontmatter(
      ['---', 'title: 甲', 'draft: true', "slug: 'abc'", 'url: "/docs/a/"', '---', '', '正文'].join(
        '\n',
      ),
    )
    expect(parsed).toEqual({ draft: true, slug: 'abc', url: '/docs/a/' })
    expect(parseSiteFrontmatter('---\nslug: abc # 顺手写的注释\n---\n正文').slug).toBe('abc')
  })

  it('没有 frontmatter、或 frontmatter 里没写这三个字段 → 全缺省（退回默认路径）', () => {
    const empty = { draft: false, slug: null, url: null }
    expect(parseSiteFrontmatter('# 就是一篇普通笔记\n')).toEqual(empty)
    expect(parseSiteFrontmatter('---\ntitle: 甲\ntags: [a]\n---\n正文')).toEqual(empty)
    // 未闭合的 `---` 不是 frontmatter（与 `frontmatterRegion` 同一口径：普通 Markdown 里它是分隔线）
    expect(parseSiteFrontmatter('---\ndraft: true\n\n正文\n')).toEqual(empty)
  })

  it('**只有** 字面 true 才算草稿（`yes` / `on` / `1` / `"false"` 都不算）', () => {
    const draftOf = (value: string): boolean =>
      parseSiteFrontmatter(`---\ndraft: ${value}\n---\n正文`).draft

    expect(draftOf('true')).toBe(true)
    // 带引号的 `"true"` 照收：它没有任何歧义，而漏判的后果是"作者以为下架了、其实还在站点里"
    expect(draftOf('"true"')).toBe(true)
    expect(draftOf('TRUE')).toBe(false)
    expect(draftOf('yes')).toBe(false)
    expect(draftOf('on')).toBe(false)
    expect(draftOf('1')).toBe(false)
    expect(draftOf('false')).toBe(false)
    expect(draftOf('"false"')).toBe(false)
  })

  it('缩进的行、带子键的字段、块标量都不当作取值（宁可退回默认，也不猜）', () => {
    const nested = parseSiteFrontmatter('---\nslug:\n  name: abc\nurl: |\n  /docs/\n---\n正文')
    expect(nested.slug).toBeNull()
    expect(nested.url).toBeNull()
    expect(parseSiteFrontmatter('---\n  slug: abc\n---\n正文').slug).toBeNull()
    expect(parseSiteFrontmatter('---\nurl: [a, b]\n---\n正文').url).toBeNull()
  })
})

describe('覆盖语义：slug 留原目录、url 按 Hugo 解释', () => {
  it('slug 换的是文件名主干，目录不动', () => {
    expect(pagePathForSlug('笔记/甲.html', 'abc')).toEqual({ ok: true, path: '笔记/abc.html' })
    expect(pagePathForSlug('甲.html', 'abc')).toEqual({ ok: true, path: 'abc.html' })
    // CJK 与空格照收（磁盘上双击得开；href 里那一份编码由 `encodeUrlPath` 负责）
    expect(pagePathForSlug('笔记/甲.html', '设计 草案')).toEqual({
      ok: true,
      path: '笔记/设计 草案.html',
    })
  })

  it('url 以 `/` 开头 → 相对输出根；不带 `/` → 相对本页所在目录', () => {
    expect(pagePathForUrl('笔记/甲.html', '/docs/a/')).toEqual({ ok: true, path: 'docs/a/index.html' })
    expect(pagePathForUrl('笔记/甲.html', '/docs/a.html')).toEqual({
      ok: true,
      path: 'docs/a.html',
    })
    expect(pagePathForUrl('笔记/甲.html', 'a/b')).toEqual({ ok: true, path: '笔记/a/b' })
  })

  it('尾随 `/` 换成 index.html（Hugo 的 pretty URL），于是链接算术不用为目录型页面开分支', () => {
    expect(pagePathForUrl('甲.html', '/guides/setup/')).toEqual({
      ok: true,
      path: 'guides/setup/index.html',
    })
  })
})

describe('安全：任何覆盖都不得逃出输出根', () => {
  const cases: Array<[string, string]> = [
    ['含 `..` 段', '../../evil.html'],
    ['根相对也要逐段审（`/../x`）', '/../x.html'],
    ['盘符', 'C:/evil.html'],
    ['仅盘符前缀', 'C:evil.html'],
    ['UNC', '//host/share/x.html'],
    ['反斜杠', '..\\..\\evil.html'],
    ['Windows 保留名', 'con.html'],
    ['保留名带扩展名', 'nul'],
    ['非法字符 `?`', 'a?b.html'],
    ['非法字符 `#`', 'a#b.html'],
    ['非法字符 `%`（会被当成转义前缀）', 'a%20b.html'],
    ['尾随点（Windows 会吃掉它）', 'abc./x.html'],
    ['空值', '   '],
  ]

  it.each(cases)('%s 一律拒绝', (_name, value) => {
    const result = resolveSitePagePath({ value, resourceDir: '笔记' })
    expect(result.ok).toBe(false)
  })

  it('拒绝的原因码是分开的（作者看提示时能立刻知道怎么改）', () => {
    const reasonOf = (value: string): string => {
      const result = resolveSitePagePath({ value, resourceDir: '' })
      return result.ok ? 'ok' : result.reject.reason
    }
    expect(reasonOf('a/../b')).toBe('escape')
    expect(reasonOf('C:/x')).toBe('drive')
    expect(reasonOf('//host/share')).toBe('unc')
    expect(reasonOf('con.html')).toBe('reserved-name')
    expect(reasonOf('a?b')).toBe('bad-segment')
    expect(reasonOf('   ')).toBe('empty')
  })

  it('slug 不能借道换目录（`a/b` 是路径，不是主干）', () => {
    expect(pagePathForSlug('笔记/甲.html', 'a/b')).toEqual({
      ok: false,
      reject: { reason: 'bad-segment' },
    })
  })

  it('每个原因码都有中文说明（索引页与提示共用同一句）', () => {
    const reasons = [
      'empty',
      'escape',
      'absolute',
      'drive',
      'unc',
      'reserved-name',
      'bad-segment',
    ] as const
    for (const reason of reasons) {
      expect(describeReject(reason).length).toBeGreaterThan(1)
    }
  })
})

describe('计划：覆盖 + 撞名 + 草稿一起算', () => {
  /**
   * 结果按 `relPath` 的**码元序**排（纯函数层不沿用入参顺序，见模块注释）。
   *
   * 码元序与中文的拼音/笔画直觉都不一样（`乙` U+4E59 就排在 `甲` U+7532 前面），
   * 这正是它值得被信任的原因：它不随系统的语言与区域设置变 —— 换台机器导出，顺序还是这个顺序。
   * 断言用这个函数求出实际顺序，字面量就不必去迁就码位。
   */
  const byRelPath = (items: ReadonlyArray<{ relPath: string }>): string[] =>
    items.map((item) => item.relPath).sort()

  it('覆盖生效的页面按最终路径写出去，且记下来源', () => {
    const plan = buildSiteExportPathPlan([
      note('笔记/甲.md', '笔记/甲.html', { slug: 'abc' }),
      note('笔记/乙.md', '笔记/乙.html', { url: '/docs/b/' }),
      note('笔记/丙.md', '笔记/丙.html'),
    ])

    expect(plan.pages).toEqual([
      { relPath: '笔记/丙.md', pagePath: '笔记/丙.html' },
      { relPath: '笔记/乙.md', pagePath: 'docs/b/index.html' },
      { relPath: '笔记/甲.md', pagePath: '笔记/abc.html' },
    ])
    expect(plan.pathSource.get('笔记/abc.html')).toBe('slug')
    expect(plan.pathSource.get('docs/b/index.html')).toBe('url')
    expect(plan.overrides.get('笔记/甲.md')).toBe('笔记/abc.html')
    // 覆盖也是"换了地址"，索引页要说得出这一篇为什么不在默认位置
    expect(plan.renamed).toEqual([
      { relPath: '笔记/乙.md', pagePath: 'docs/b/index.html' },
      { relPath: '笔记/甲.md', pagePath: '笔记/abc.html' },
    ])
    expect(plan.rejected).toEqual([])
    expect(plan.conflicts).toEqual([])
  })

  it('显式覆盖赢过默认命名：被占位的那一篇退成 `-2`（两个页面绝不会写同一个文件）', () => {
    const plan = buildSiteExportPathPlan([
      note('笔记/甲.md', '笔记/甲.html', { slug: '乙' }),
      note('笔记/乙.md', '笔记/乙.html'),
    ])

    expect(plan.pages).toEqual([
      { relPath: '笔记/乙.md', pagePath: '笔记/乙-2.html' },
      { relPath: '笔记/甲.md', pagePath: '笔记/乙.html' },
    ])
    expect(plan.renamed).toEqual([
      { relPath: '笔记/乙.md', pagePath: '笔记/乙-2.html' },
      { relPath: '笔记/甲.md', pagePath: '笔记/乙.html' },
    ])
  })

  it('两个覆盖撞在同一个路径：先到的占住，后到的退回默认地址并如实报出', () => {
    const plan = buildSiteExportPathPlan([
      note('笔记/甲.md', '笔记/甲.html', { slug: '同一页' }),
      note('笔记/乙.md', '笔记/乙.html', { slug: '同一页' }),
    ])

    expect(plan.pages).toEqual([
      { relPath: '笔记/乙.md', pagePath: '笔记/同一页.html' },
      { relPath: '笔记/甲.md', pagePath: '笔记/甲.html' },
    ])
    expect(plan.conflicts).toEqual([
      { relPath: '笔记/甲.md', field: 'slug', value: '同一页', path: '笔记/同一页.html' },
    ])
    // 被退回的那一篇**没有**退成"同一页-2.html"：退回的是它的**默认路径**，
    // 不是"在被占用的路径后面加后缀"（后者会让"退回"本身也变成一次改名，越退越乱）
    expect(plan.renamed).toEqual([{ relPath: '笔记/乙.md', pagePath: '笔记/同一页.html' }])
  })

  it('被拒绝的覆盖退回默认地址，并记一条原因（不是删掉这一页）', () => {
    const plan = buildSiteExportPathPlan([
      note('笔记/甲.md', '笔记/甲.html', { url: '../../evil.html' }),
      note('笔记/乙.md', '笔记/乙.html', { slug: 'con' }),
    ])

    expect(plan.pages).toEqual([
      { relPath: '笔记/乙.md', pagePath: '笔记/乙.html' },
      { relPath: '笔记/甲.md', pagePath: '笔记/甲.html' },
    ])
    expect(plan.rejected).toEqual([
      { relPath: '笔记/乙.md', field: 'slug', value: 'con', reason: 'reserved-name' },
      { relPath: '笔记/甲.md', field: 'url', value: '../../evil.html', reason: 'escape' },
    ])
  })

  it('`draft: true` 不进计划（不占路径、不改名），其余照常', () => {
    const plan = buildSiteExportPathPlan([
      note('笔记/草稿.md', '笔记/草稿.html', { draft: true }),
      note('笔记/甲.md', '笔记/甲.html'),
      note('笔记/草稿二号.md', '笔记/草稿二号.html', { draft: true, slug: '同名' }),
      note('笔记/乙.md', '笔记/乙.html', { slug: '同名' }),
    ])

    // 草稿连"占一个 slug"都不该发生：它的覆盖不参与分配
    expect(byRelPath(plan.pages)).toEqual(['笔记/甲.md', '笔记/乙.md'].sort())
    expect(plan.drafts).toEqual(['笔记/草稿.md', '笔记/草稿二号.md'])
    expect(plan.pages.find((page) => page.relPath === '笔记/乙.md')?.pagePath).toBe(
      '笔记/同名.html',
    )
    expect(plan.rejected).toEqual([])
    expect(plan.conflicts).toEqual([])
  })

  it('分配与笔记顺序无关（两次导出必须得到同一张表 —— 逐字节相同的前提）', () => {
    const forward = buildSiteExportPathPlan([
      note('a.md', 'a.html', { slug: 'b' }),
      note('b.md', 'b.html'),
      note('c.md', 'c.html', { url: '/x/' }),
    ])
    const backward = buildSiteExportPathPlan([
      note('c.md', 'c.html', { url: '/x/' }),
      note('b.md', 'b.html'),
      note('a.md', 'a.html', { slug: 'b' }),
    ])

    expect(forward.pages.map((page) => page.relPath)).toEqual(['a.md', 'b.md', 'c.md'])
    expect(backward.pages).toEqual(forward.pages)
    expect([...backward.overrides]).toEqual([...forward.overrides])
    expect(backward.renamed).toEqual(forward.renamed)
  })

  it('不是笔记的条目（`defaultPagePath: null`）既不进计划也不参与占位', () => {
    const plan = buildSiteExportPathPlan([note('附件/图.png', null, { slug: 'x' })])
    expect(plan.pages).toEqual([])
    expect(plan.renamed).toEqual([])
  })
})
