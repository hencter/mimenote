/**
 * frontmatter 区块判定与"预览只渲染正文"的测试。
 *
 * 判定必须与 `mn_core::frontmatter::parse` 一致 —— 两边不一致的后果很具体：
 * 宿主认为有 frontmatter（面板里显示属性），预览却把 `---` 后面所有内容当成正文渲染出来，
 * 或者反过来把正文前几行吃掉。这里把边界逐条钉死。
 */

import { describe, expect, it } from 'vitest'

import { frontmatterBody, frontmatterRegion } from '@/domain/frontmatter'

describe('frontmatterRegion', () => {
  it('识别标准的开头区块（0 起、闭区间）', () => {
    expect(frontmatterRegion('---\ntitle: t\n---\n正文\n')).toEqual({ startLine: 0, endLine: 2 })
    expect(frontmatterRegion('---\n---\n正文\n')).toEqual({ startLine: 0, endLine: 1 })
  })

  it('允许 BOM 与行尾空白，但不允许前导空白', () => {
    expect(frontmatterRegion('\u{feff}---\r\ntags: [甲]\r\n---\r\n正文\r\n')).toEqual({
      startLine: 0,
      endLine: 2,
    })
    expect(frontmatterRegion('---  \ntitle: t\n---  \n正文\n')).toEqual({ startLine: 0, endLine: 2 })
    expect(frontmatterRegion(' ---\ntitle: t\n---\n正文\n')).toBeNull()
  })

  it('未闭合 / 首行不是分隔行 / 只有一行 → 不是 frontmatter', () => {
    expect(frontmatterRegion('---\ntitle: t\n正文\n')).toBeNull()
    expect(frontmatterRegion('# 标题\n\n---\n\n正文\n')).toBeNull()
    expect(frontmatterRegion('---\n')).toBeNull()
    expect(frontmatterRegion('普通正文\n')).toBeNull()
    expect(frontmatterRegion('')).toBeNull()
  })

  it('`...` 结束标记不支持（与 Rust 侧一致）', () => {
    expect(frontmatterRegion('---\ntitle: t\n...\n正文\n')).toBeNull()
  })
})

describe('frontmatterBody', () => {
  it('去掉区块后只剩正文（保留原换行风格）', () => {
    expect(frontmatterBody('---\ntitle: t\n---\n\n正文\n')).toBe('\n正文\n')
    expect(frontmatterBody('---\r\ntitle: t\r\n---\r\n\r\n正文\r\n')).toBe('\r\n正文\r\n')
  })

  it('没有合法区块时原样返回（`---` 只是分隔线的情况）', () => {
    const source = '# 标题\n\n---\n\n正文\n'
    expect(frontmatterBody(source)).toBe(source)
    expect(frontmatterBody('')).toBe('')
  })

  it('空区块（---/---）返回其后的正文', () => {
    expect(frontmatterBody('---\n---\n正文\n')).toBe('正文\n')
  })
})
