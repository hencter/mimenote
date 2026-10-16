/** 换行风格与 BOM：M1 的"可移植性"底线 —— 保存不能把 CRLF 文件整体改写。 */

import { describe, expect, it } from 'vitest'

import { detectFormat, fromEditorText, toEditorText } from '@/domain/eol'

describe('detectFormat', () => {
  it('识别 LF 与无 BOM', () => {
    expect(detectFormat('a\nb\n')).toEqual({ bom: false, eol: '\n' })
  })

  it('识别 CRLF', () => {
    expect(detectFormat('a\r\nb\r\n')).toEqual({ bom: false, eol: '\r\n' })
  })

  it('识别 BOM', () => {
    expect(detectFormat('\uFEFF# 标题\n')).toEqual({ bom: true, eol: '\n' })
  })

  it('混合换行时以多数为准', () => {
    expect(detectFormat('a\r\nb\r\nc\n').eol).toBe('\r\n')
    expect(detectFormat('a\nb\nc\r\n').eol).toBe('\n')
  })

  it('空文本按 LF 处理', () => {
    expect(detectFormat('')).toEqual({ bom: false, eol: '\n' })
  })
})

describe('toEditorText / fromEditorText', () => {
  it('编辑器内统一为 \\n，并剥离 BOM', () => {
    const { text, format } = toEditorText('\uFEFFa\r\nb\r\n')
    expect(text).toBe('a\nb\n')
    expect(format).toEqual({ bom: true, eol: '\r\n' })
  })

  it('往返保持 CRLF + BOM 不变（Git diff 不为换行翻车）', () => {
    const original = '\uFEFF标题\r\n\r\n正文\r\n'
    const { text, format } = toEditorText(original)
    expect(fromEditorText(text, format)).toBe(original)
  })

  it('往返保持 LF 无 BOM 不变', () => {
    const original = '# 标题\n\n正文\n'
    const { text, format } = toEditorText(original)
    expect(fromEditorText(text, format)).toBe(original)
  })

  it('孤立 \\r（老 Mac）被归一化为 \\n 再按 LF 写回', () => {
    const { text, format } = toEditorText('a\rb')
    expect(text).toBe('a\nb')
    expect(format.eol).toBe('\n')
    expect(fromEditorText(text, format)).toBe('a\nb')
  })

  it('用户在编辑器里改的换行会被还原成磁盘风格', () => {
    const { format } = toEditorText('a\r\nb\r\n')
    expect(fromEditorText('a\nb\nc\n', format)).toBe('a\r\nb\r\nc\r\n')
  })
})
