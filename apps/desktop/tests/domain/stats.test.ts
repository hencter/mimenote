/** 文本统计：必须与 Rust 侧 `mn_core::text_stats` 口径一致。 */

import { describe, expect, it } from 'vitest'

import { computeStats, isCjk } from '@/domain/stats'

describe('isCjk', () => {
  it('识别汉字/假名/谚文，排除拉丁与标点', () => {
    expect(isCjk('漢')).toBe(true)
    expect(isCjk('あ')).toBe(true)
    expect(isCjk('한')).toBe(true)
    expect(isCjk('a')).toBe(false)
    expect(isCjk('1')).toBe(false)
    expect(isCjk('，')).toBe(false)
  })
})

describe('computeStats', () => {
  it('中文按字计词', () => {
    const stats = computeStats('中文笔记')
    expect(stats.cjkChars).toBe(4)
    expect(stats.words).toBe(4)
    expect(stats.chars).toBe(4)
    expect(stats.lines).toBe(1)
    expect(stats.readingMinutes).toBe(1)
  })

  it('英文按连续字母数字串计词', () => {
    const stats = computeStats('hello world, markdown!')
    expect(stats.words).toBe(3)
    expect(stats.cjkChars).toBe(0)
  })

  it('中英混排', () => {
    const stats = computeStats('使用 Tauri 2 构建桌面应用')
    // 使用(2) + Tauri(1) + 2(1) + 构建桌面应用(6)
    expect(stats.words).toBe(10)
    expect(stats.cjkChars).toBe(8)
  })

  it('空文本', () => {
    expect(computeStats('')).toMatchObject({ chars: 0, words: 0, lines: 0, readingMinutes: 0 })
  })

  it('行数按换行符计（末尾换行不产生额外行）', () => {
    expect(computeStats('a\nb\n').lines).toBe(2)
    expect(computeStats('\n\n\n').lines).toBe(3)
  })

  it('阅读时长随内容增长', () => {
    expect(computeStats('字'.repeat(4000)).readingMinutes).toBe(10)
    expect(computeStats('word '.repeat(2000)).readingMinutes).toBe(10)
  })

  it('去掉空白后的字符数', () => {
    expect(computeStats('a b\nc').charsNoWhitespace).toBe(3)
  })
})
