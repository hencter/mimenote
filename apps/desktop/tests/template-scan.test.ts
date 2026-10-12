/**
 * `@` 记号扫描（`domain/template/scan.ts`）的判据测试。
 *
 * 这里钉死设计 02 §9 里与扫描有关的几条：
 * - 第 2 条：`mail@example.com`、`@username`、`@@` 三种输入**都不被误伤**；
 * - 第 3 条：同一个 `scanTemplateTokens` 同时驱动补全与展开（本文件断言的是"它是唯一判据"
 *   的一半：编辑器那侧的 `templateDraftAt` 与它给出**同一套**边界结论）；
 * - 第 6 条：围栏代码块 / 行内代码里的 `@today` 保持字面量。
 */

import { describe, expect, it } from 'vitest'

import { TEMPLATE_BUILTINS } from '@/domain/template/builtins'
import {
  linesOfText,
  scanTemplate,
  scanTemplateTokens,
  scanUnknownTemplateTokens,
  templateDraftAt,
} from '@/domain/template/scan'

/** 记号原文数组（比较"哪几段被判成记号"比逐个字段断言可读）。 */
function raws(text: string): string[] {
  return scanTemplateTokens(text).map((token) => token.raw)
}

describe('记号成立的两条边界规则', () => {
  it('行首、空白之后、左括号之后都算记号', () => {
    expect(raws('@today')).toEqual(['@today'])
    expect(raws('正文 @today')).toEqual(['@today'])
    expect(raws('（@today）')).toEqual(['@today'])
    expect(raws('(@today)')).toEqual(['@today'])
    expect(raws('【@today】')).toEqual(['@today'])
    expect(raws('[@today]')).toEqual(['@today'])
    expect(raws('{@today}')).toEqual(['@today'])
    expect(raws('一行里两个：@today 和 @now')).toEqual(['@today', '@now'])
  })

  it('左邻是"词里的一部分"时不是记号（邮箱绝不被吃）', () => {
    expect(raws('mail@example.com')).toEqual([])
    expect(raws('mail@today')).toEqual([])
    expect(raws('2026@today')).toEqual([])
    expect(raws('a.b@today')).toEqual([])
    expect(raws('a_b@today')).toEqual([])
    expect(raws('a-b@today')).toEqual([])
    expect(raws('a+b@today')).toEqual([])
    expect(raws('路径/ @today')).toEqual(['@today'])
  })

  it('汉字与中文标点都算边界（中文没有空格，行内落点必须能用）', () => {
    expect(raws('，@today')).toEqual(['@today'])
    expect(raws('：@today')).toEqual(['@today'])
    expect(raws('。@today')).toEqual(['@today'])
    expect(raws('」@today')).toEqual(['@today'])
    expect(raws('、@today')).toEqual(['@today'])
    expect(raws('会议记录：@cursor')).toEqual(['@cursor'])
    expect(raws('今天@cursor完成了')).toEqual(['@cursor'])
    // 汉字之后的 `@` 也是记号：`用户@example.com` 之所以原样保留，靠的是**第 2 条**
    // （`example` 不是内建名），而不是靠左邻规则
    expect(raws('用户@example.com')).toEqual([])
    expect(raws('用户@today')).toEqual(['@today'])
  })

  it('反斜杠不在左邻的排除集合里（规格只定义 `@@` 这一种转义）', () => {
    // v1 刻意不做 `\@` 转义：多一种转义就多一条要维护的规则，而 `@@` 已经覆盖了需求
    expect(raws('\\@today')).toEqual(['@today'])
  })

  it('名字必须命中内建表：未知名字原样保留，且单独列出来', () => {
    expect(raws('@username')).toEqual([])
    expect(scanUnknownTemplateTokens('@username')).toEqual([
      { start: 0, end: 9, name: 'username', raw: '@username' },
    ])
    // `@foo=bar` 的参数也一起进"未识别"的原文里（原样保留的就是这一整段）
    expect(scanUnknownTemplateTokens('@foo=bar 后面').map((item) => item.raw)).toEqual(['@foo=bar'])
  })

  it('大小写不敏感；`raw` 保留用户写法', () => {
    const tokens = scanTemplateTokens('@TODAY 与 @Now')
    expect(tokens.map((token) => token.name)).toEqual(['today', 'now'])
    expect(tokens.map((token) => token.raw)).toEqual(['@TODAY', '@Now'])
  })

  it('参数：`=` 之后到空白或行尾，允许中文', () => {
    expect(scanTemplateTokens('@today=YYYY年M月D日')).toEqual([
      { start: 0, end: 16, name: 'today', argument: 'YYYY年M月D日', raw: '@today=YYYY年M月D日' },
    ])
    // 参数到空白为止：后面的普通文本不受影响
    expect(scanTemplateTokens('@today=YYYY 后面的话')[0]?.argument).toBe('YYYY')
    expect(scanTemplateTokens('@today=')[0]?.argument).toBe('')
    expect(scanTemplateTokens('@today')[0]?.argument).toBeNull()
  })

  it('裸 `@` 不是记号（它只是还没打完）', () => {
    expect(raws('@')).toEqual([])
    expect(raws('@ 后面')).toEqual([])
    expect(scanUnknownTemplateTokens('@ 后面')).toEqual([])
  })

  it('内建表里的每一个名字都能被扫出来（表与判据同源）', () => {
    for (const builtin of TEMPLATE_BUILTINS) {
      expect(raws(`@${builtin.name}`)).toEqual([`@${builtin.name}`])
    }
  })
})

describe('`@@` 转义', () => {
  it('`@@today` 不是记号，只留下一个转义点', () => {
    const scan = scanTemplate('@@today')
    expect(scan.tokens).toEqual([])
    expect(scan.escapes).toEqual([{ start: 0, end: 2 }])
  })

  it('`@@` 单独出现也是转义（展开成字面量 `@`）', () => {
    expect(scanTemplate('@@').escapes).toEqual([{ start: 0, end: 2 }])
  })

  it('转义只吃两个字符：`@@@today` = 一个转义 + 一个真假记号', () => {
    const scan = scanTemplate('@@@today')
    expect(scan.escapes).toEqual([{ start: 0, end: 2 }])
    // 第三个 `@` 的左邻是 `@`（不在词内字符集合里）→ 它照样是记号的起点
    expect(scan.tokens.map((token) => token.raw)).toEqual(['@today'])
  })

  it('`@today` 后面紧跟 `@@` 时两边都认得出来', () => {
    const scan = scanTemplate('@today @@')
    expect(scan.tokens.map((token) => token.raw)).toEqual(['@today'])
    expect(scan.escapes).toEqual([{ start: 7, end: 9 }])
  })
})

describe('代码上下文里保持字面量（§9 第 6 条）', () => {
  it('围栏代码块内不认记号（含开/闭围栏那两行）', () => {
    expect(raws('```\n@today\n```')).toEqual([])
    expect(raws('```ts\nconst a = "@today"\n```')).toEqual([])
    expect(raws('~~~\n@today\n~~~')).toEqual([])
    // 围栏行自己就是代码：`@today` 写在开围栏行的 info 里也不算
    expect(raws('```@today\n代码\n```')).toEqual([])
  })

  it('围栏结束之后照常认记号', () => {
    expect(raws('```\n@today\n```\n@today')).toEqual(['@today'])
  })

  it('结束围栏必须"同种字符、长度不短于开始"（与 domain/outline.ts 同口径）', () => {
    // `~~~` 不会关掉 ``` 开的块
    expect(raws('```\n@today\n~~~\n@today\n```')).toEqual([])
    // 更短的反引号串也关不掉
    expect(raws('````\n@today\n```\n@today\n````')).toEqual([])
    expect(raws('````\n@today\n````\n@today')).toEqual(['@today'])
  })

  it('行内代码里不认记号', () => {
    expect(raws('前 `@today` 后')).toEqual([])
    expect(raws('`` `@today` ``')).toEqual([])
  })

  it('未闭合的反引号里也不认（用户正打到一半，那一段本来就是代码）', () => {
    expect(raws('看 `@today')).toEqual([])
  })

  it('转义的反引号不开代码区间', () => {
    // `\`` 是字面量，它不开代码区间：后面（空格之后）的 `@today` 在正文里
    expect(raws('看 \\` 和 @today')).toEqual(['@today'])
    // 对照组：同一个位置没转义时它开了区间，后面的 `@today` 就不是记号了
    expect(raws('看 ` 和 @today')).toEqual([])
  })

  it('同一行里代码区间之外的记号照常认', () => {
    expect(raws('@today 与 `@now`')).toEqual(['@today'])
  })
})

describe('frontmatter 也参与（与 `[[` 补全故意不同）', () => {
  it('frontmatter 里的记号照常扫出来', () => {
    expect(raws('---\ncreated: @now\ntitle: @title\n---\n\n@today')).toEqual([
      '@now',
      '@title',
      '@today',
    ])
  })
})

describe('光标记号（编辑器补全的上下文判定）', () => {
  it('刚敲下 `@`：查询串为空，替换区间就是那一个字符', () => {
    const text = '正文 @'
    const draft = templateDraftAt(linesOfText(text), text.length)
    expect(draft).toEqual({
      start: 3,
      end: 4,
      name: '',
      query: '',
      argument: null,
    })
  })

  it('继续输入：查询串是光标之前的名字，替换区间覆盖整条记号', () => {
    const text = '正文 @tod'
    const draft = templateDraftAt(linesOfText(text), text.length)
    expect(draft?.query).toBe('tod')
    expect(draft?.name).toBe('tod')
    expect(draft).toMatchObject({ start: 3, end: 7 })
    // 光标停在记号末尾（名字已经打完）同样算"正在书写"：用户接着就想按确认
    expect(templateDraftAt(linesOfText('正文 @today'), 8)?.name).toBe('today')
  })

  it('光标在名字中间：查询串只取光标之前那一段', () => {
    const text = '@today'
    expect(templateDraftAt(linesOfText(text), 3)?.query).toBe('to')
  })

  it('光标在参数里：查询串退回整个名字（此刻在改的是参数）', () => {
    const text = '@today=YY'
    const draft = templateDraftAt(linesOfText(text), text.length)
    expect(draft?.query).toBe('today')
    expect(draft?.argument).toBe('YY')
    expect(draft?.end).toBe(text.length)
  })

  it('光标在 `@` 之前或离开之后都不算', () => {
    expect(templateDraftAt(linesOfText('正文 @today'), 3)).toBeNull()
    expect(templateDraftAt(linesOfText('@today 后面'), 8)).toBeNull()
  })

  it('边界规则与扫描器同一套：邮箱之后不算，汉字与中文标点之后算', () => {
    expect(templateDraftAt(linesOfText('mail@'), 5)).toBeNull()
    expect(templateDraftAt(linesOfText('2026@'), 5)).toBeNull()
    expect(templateDraftAt(linesOfText('@@today'), 6)).toBeNull()
    expect(templateDraftAt(linesOfText('，@today'), 7)?.name).toBe('today')
    expect(templateDraftAt(linesOfText('今天@cursor'), 9)?.name).toBe('cursor')
  })

  it('代码上下文里不算（围栏与行内代码）', () => {
    const fenced = '```\n@today\n```'
    const inFence = fenced.indexOf('@today') + 6
    expect(templateDraftAt(linesOfText(fenced), inFence)).toBeNull()

    const inline = '看 `@today` 后面'
    expect(templateDraftAt(linesOfText(inline), 6)).toBeNull()
    // 未闭合的反引号同样不算
    expect(templateDraftAt(linesOfText('看 `@today'), 8)).toBeNull()
  })

  it('空文档 / 越界位置不炸', () => {
    expect(templateDraftAt(linesOfText(''), 0)).toBeNull()
    expect(templateDraftAt(linesOfText('@'), 99)).toBeNull()
  })
})

describe('行视图', () => {
  it('`\\r\\n` 的行文本不带 `\\r`，偏移按原文算', () => {
    const lines = linesOfText('甲\r\n@today')
    expect(lines.lineCount).toBe(2)
    expect(lines.line(1)).toEqual({ text: '甲', from: 0 })
    expect(lines.line(2)).toEqual({ text: '@today', from: 3 })
  })
})
