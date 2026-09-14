/** 展示层格式化。 */

import { describe, expect, it } from 'vitest'

import { formatBytes, formatClock, formatDuration } from '@/domain/format'
import { basename, displayName, displayPath, extensionOf, isMarkdown, parentOf, shortenPath, stem } from '@/domain/paths'

describe('formatBytes', () => {
  it('字节以内不加单位换算', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
  })

  it('按 1024 进位并保留合适精度', () => {
    expect(formatBytes(1024)).toBe('1.00 KB')
    expect(formatBytes(1536)).toBe('1.50 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB')
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB')
  })

  it('非法输入不抛异常', () => {
    expect(formatBytes(Number.NaN)).toBe('—')
    expect(formatBytes(-1)).toBe('—')
  })
})

describe('formatDuration', () => {
  it('毫秒与秒的切换', () => {
    expect(formatDuration(0.4)).toBe('<1ms')
    expect(formatDuration(8)).toBe('8ms')
    expect(formatDuration(999)).toBe('999ms')
    expect(formatDuration(1500)).toBe('1.50s')
    expect(formatDuration(-5)).toBe('—')
  })
})

describe('formatClock', () => {
  it('输出 HH:MM:SS', () => {
    const stamp = new Date(2025, 0, 2, 9, 5, 7).getTime()
    expect(formatClock(stamp)).toBe('09:05:07')
  })
})

describe('路径工具', () => {
  it('basename / parentOf / stem / extensionOf', () => {
    expect(basename('a/b/c.md')).toBe('c.md')
    expect(parentOf('a/b/c.md')).toBe('a/b')
    expect(parentOf('c.md')).toBe('')
    expect(stem('a/b/c.md')).toBe('c')
    expect(extensionOf('a/b/c.MD')).toBe('md')
    expect(extensionOf('a/b/README')).toBe('')
  })

  it('isMarkdown 只认 md / markdown', () => {
    expect(isMarkdown('a.md')).toBe(true)
    expect(isMarkdown('a.MARKDOWN')).toBe(true)
    expect(isMarkdown('a.txt')).toBe(false)
    expect(isMarkdown('a.png')).toBe(false)
  })

  it('shortenPath 保尾部文件名', () => {
    const long = `${'很长的目录/'.repeat(8)}笔记.md`
    const short = shortenPath(long, 30)
    expect(short.length).toBeLessThanOrEqual(31)
    expect(short.endsWith('笔记.md')).toBe(true)
    expect(shortenPath('短.md', 30)).toBe('短.md')
  })

  it('displayName / displayPath：只剥笔记的扩展名（ADR-0030）', () => {
    expect(displayName('项目/设计.md')).toBe('设计')
    expect(displayName('项目/设计.MARKDOWN')).toBe('设计')
    expect(displayPath('项目/设计.md')).toBe('项目/设计')
    expect(displayPath('项目/子/设计.md')).toBe('项目/子/设计')
    // 目录那一段即使叫 `归档.md` 也不动：被剥的只是最后那一段
    expect(displayPath('归档.md/笔记.md')).toBe('归档.md/笔记')
    // 附件、无扩展名、以及"."开头的名字一律原样
    expect(displayName('附件/图.png')).toBe('图.png')
    expect(displayPath('附件/图.png')).toBe('附件/图.png')
    expect(displayName('LICENSE')).toBe('LICENSE')
    expect(displayPath('a/.md')).toBe('a/.md')
  })
})
