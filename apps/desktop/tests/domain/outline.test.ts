// @vitest-environment jsdom
/**
 * 大纲解析（`domain/outline.ts`）的纯函数测试。
 *
 * 这一层的价值在于**行号**：跳转能不能到对地方，完全取决于"这个标题在第几行"。
 * 因此重点全在"哪些 `#` 不算标题"上 —— 代码块、frontmatter、行内代码、
 * 围栏里的伪标题，一旦判错，用户点大纲就会跳到别处。
 */

import { describe, expect, it } from 'vitest'

import { outlineDepths, parseOutline } from '@/domain/outline'

describe('大纲解析', () => {
  it('抽出 ATX 标题的级别、文本与 1 起算的行号', () => {
    const text = ['# 甲', '', '正文', '', '## 乙', '', '### 丙', '', '#### 丁', '', '##### 戊', '', '###### 己'].join(
      '\n',
    )
    expect(parseOutline(text)).toEqual([
      { level: 1, text: '甲', line: 1 },
      { level: 2, text: '乙', line: 5 },
      { level: 3, text: '丙', line: 7 },
      { level: 4, text: '丁', line: 9 },
      { level: 5, text: '戊', line: 11 },
      { level: 6, text: '己', line: 13 },
    ])
  })

  it('跳过围栏代码块里的伪标题（``` 与 ~~~ 都算，含嵌套与语言标注）', () => {
    const text = [
      '# 真标题',
      '```ts',
      '# 这是代码里的注释，不是标题',
      '```',
      '~~~',
      '## 也不是标题',
      '~~~',
      '## 真二级',
    ].join('\n')
    expect(parseOutline(text).map((item) => item.text)).toEqual(['真标题', '真二级'])
  })

  it('跳过文首的 frontmatter，但文档中部的 --- 只是分隔线', () => {
    const text = ['---', 'title: "不是标题 # 也不是"', 'tags: [a]', '---', '', '# 标题', '', '---', '', '## 后面的标题'].join(
      '\n',
    )
    expect(parseOutline(text)).toEqual([
      { level: 1, text: '标题', line: 6 },
      { level: 2, text: '后面的标题', line: 10 },
    ])
  })

  it('CRLF 原文也能解析（行尾的 \\r 不能混进标题文本）', () => {
    expect(parseOutline('# 甲\r\n\r\n## 乙\r\n')).toEqual([
      { level: 1, text: '甲', line: 1 },
      { level: 2, text: '乙', line: 3 },
    ])
  })

  it('剥掉行内标记，只留可读文本（强调 / 行内代码 / wikilink / 链接 / 图片 / 闭尾 #）', () => {
    const text = [
      '# **加粗** 与 `代码`',
      '## [[设计文档|设计]] 与 [[路线图]]',
      '### [文字](https://example.com) 与 ![图](../附件/图.png)',
      '#### 带闭尾井号 ####',
    ].join('\n')
    expect(parseOutline(text).map((item) => item.text)).toEqual([
      '加粗 与 代码',
      '设计 与 路线图',
      '文字 与 图',
      '带闭尾井号',
    ])
  })

  it('不把行内代码 / 分隔线 / 七级井号当成标题', () => {
    const text = [
      '正文里有 `# 井号` 与 #不是标题（井号后没有空格）',
      '####### 七个井号不算标题',
      '   # 三个前导空格的标题',
      '    # 四个前导空格是代码块',
      '',
      '---',
    ].join('\n')
    expect(parseOutline(text)).toEqual([{ level: 1, text: '三个前导空格的标题', line: 3 }])
  })

  it('空标题也能被识别（渲染层负责显示占位）', () => {
    expect(parseOutline('#\n## \n')).toEqual([
      { level: 1, text: '', line: 1 },
      { level: 2, text: '', line: 2 },
    ])
  })

  it('空文档与无标题文档返回空数组', () => {
    expect(parseOutline('')).toEqual([])
    expect(parseOutline('只有正文\n没有标题\n')).toEqual([])
  })

  it('层级深度只在自己比前一个深时才加一层（缺少中间层级时不跳缩进）', () => {
    const headings = parseOutline('# 一\n### 一跳\n## 回到二\n#### 深\n# 又是新的一')
    expect(outlineDepths(headings)).toEqual([0, 1, 0, 1, 0])
  })
})
