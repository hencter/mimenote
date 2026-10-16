/** 前端链接领域函数：归一化规则必须与 Rust `mn_core::links` 保持一致。 */

import { describe, expect, it } from 'vitest'

import {
  isInternalNoteHref,
  normalizeLinkTarget,
  splitWikilink,
  wikilinkDisplayText,
} from '@/domain/links'

describe('splitWikilink', () => {
  it('纯目标', () => {
    expect(splitWikilink('某篇笔记')).toEqual({ target: '某篇笔记', alias: null, anchor: null })
  })

  it('别名', () => {
    expect(splitWikilink('某篇笔记|显示文本')).toEqual({
      target: '某篇笔记',
      alias: '显示文本',
      anchor: null,
    })
  })

  it('锚点与块引用', () => {
    expect(splitWikilink('某篇#小节')).toEqual({ target: '某篇', alias: null, anchor: '小节' })
    expect(splitWikilink('某篇^块')).toEqual({ target: '某篇', alias: null, anchor: '块' })
    // 带别名 + 锚点
    expect(splitWikilink('某篇#小节|别名')).toEqual({
      target: '某篇',
      alias: '别名',
      anchor: '小节',
    })
  })

  it('纯锚点（文内引用）', () => {
    expect(splitWikilink('#小节')).toEqual({ target: '', alias: null, anchor: '小节' })
  })

  it('空别名视为没有别名', () => {
    expect(splitWikilink('某篇|')).toEqual({ target: '某篇', alias: null, anchor: null })
  })
})

describe('wikilinkDisplayText', () => {
  it('优先别名，其次目标，最后锚点', () => {
    expect(wikilinkDisplayText({ target: 'A', alias: '别名', anchor: null })).toBe('别名')
    expect(wikilinkDisplayText({ target: 'A', alias: null, anchor: null })).toBe('A')
    expect(wikilinkDisplayText({ target: '', alias: null, anchor: '小节' })).toBe('#小节')
  })
})

describe('normalizeLinkTarget（与 Rust 实现对齐）', () => {
  it('小写、去扩展名、统一分隔符', () => {
    expect(normalizeLinkTarget('笔记/某篇.md')).toBe('笔记/某篇')
    expect(normalizeLinkTarget('笔记\\某篇.MD')).toBe('笔记/某篇')
    expect(normalizeLinkTarget('./某篇.markdown')).toBe('某篇')
    expect(normalizeLinkTarget('/前导斜杠/某篇')).toBe('前导斜杠/某篇')
    expect(normalizeLinkTarget('  Trim  ')).toBe('trim')
    expect(normalizeLinkTarget('Note')).toBe('note')
  })

  it('空目标保持为空', () => {
    expect(normalizeLinkTarget('')).toBe('')
    expect(normalizeLinkTarget('  ')).toBe('')
  })
})

describe('isInternalNoteHref', () => {
  it('识别内部笔记链接', () => {
    expect(isInternalNoteHref('别的笔记.md')).toBe(true)
    expect(isInternalNoteHref('子目录/笔记.MARKDOWN')).toBe(true)
    expect(isInternalNoteHref('笔记')).toBe(true)
  })

  it('排除外链、锚点与空值', () => {
    expect(isInternalNoteHref('https://example.com/a.md')).toBe(false)
    expect(isInternalNoteHref('mailto:a@b.c')).toBe(false)
    expect(isInternalNoteHref('#小节')).toBe(false)
    expect(isInternalNoteHref('')).toBe(false)
    expect(isInternalNoteHref('图.png')).toBe(false)
  })
})
