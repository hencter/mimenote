/**
 * 模板展开（`domain/template/expand.ts`）的判据测试。
 *
 * 钉死设计 02 §9 的验收：
 * 1. 三种内建格式（无参 / `=YYYY年M月D日` / `=ddd`）正确，且**与系统时区一致**；
 * 2. `mail@example.com`、`@username`、`@@` 都不被误伤；
 * 3. 同一个 `scanTemplateTokens` 同时驱动补全与展开（{@link previewTemplateValue} 与
 *    {@link expandTemplate} 对同一个记号必须给出同一个值）；
 * 4. `@cursor` 落点；没有它时 `cursor === null`（= 文档末尾）；
 * 5. 展开是纯文本（源码里就是最终值）；
 * 6. 代码块内的 `@today` 保持字面量。
 */

import { describe, expect, it } from 'vitest'

import { TEMPLATE_BUILTINS, type TemplateValues } from '@/domain/template/builtins'
import {
  collectTemplatePrompts,
  expandTemplate,
  formatTemplatePattern,
  previewTemplateValue,
  randomUuidV4,
} from '@/domain/template/expand'
import { displayName } from '@/domain/paths'

/** 固定时刻（**本地**构造 → 展开也是本地取值，两边天然同口径）。 */
const NOW = new Date(2026, 9, 12, 20, 50, 30)

const SNAPSHOT = {
  now: NOW,
  // 标题按 ADR-0030 的 `displayName` 口径（去扩展名）—— 展开器不碰路径字符串
  title: displayName('folder/我的笔记.md'),
  filename: '我的笔记.md',
  path: 'folder/我的笔记.md',
  vault: 'mimenote-vault',
}

function values(partial: Partial<TemplateValues> = {}): TemplateValues {
  return {
    ...SNAPSHOT,
    clipboard: null,
    prompt: () => '',
    ...partial,
  }
}

/** 只取展开后的文本（大多数断言只关心它）。 */
function expand(text: string, partial: Partial<TemplateValues> = {}): string {
  return expandTemplate(text, values(partial)).text
}

describe('模式串与内建格式（§9 第 1 条）', () => {
  it('不带参数时用表里的默认模式串', () => {
    expect(expand('@today')).toBe('2026-10-12')
    expect(expand('@date')).toBe('2026-10-12')
    expect(expand('@now')).toBe('2026-10-12 20:50')
    expect(expand('@time')).toBe('20:50')
  })

  it('`=YYYY年M月D日` 这种带中文的模式串原样保留不认识的字', () => {
    expect(expand('@today=YYYY年M月D日')).toBe('2026年10月12日')
    expect(expand('@date=YYYY/M/D')).toBe('2026/10/12')
    expect(expand('@now=HH:mm:ss')).toBe('20:50:30')
    expect(expand('@today=YY')).toBe('26')
  })

  it('星期几：`dddd` 全称、`ddd` 简写', () => {
    expect(expand('@today=dddd')).toBe('星期一')
    expect(expand('@today=ddd')).toBe('周一')
    // 换一天也能对上（本地构造的每一天都验一遍，避免"只有今天对"）
    for (let day = 11; day <= 17; day += 1) {
      const date = new Date(2026, 9, day, 12, 0, 0)
      const pattern = formatTemplatePattern(date, 'ddd')
      expect(['周日', '周一', '周二', '周三', '周四', '周五', '周六']).toContain(pattern)
      expect(pattern).toBe(`周${'日一二三四五六'[date.getDay()]}`)
    }
  })

  it('取的是**本地**时间：UTC 与本地跨日时以本地为准（§9 第 1 条）', () => {
    // 本地 00:30：在 UTC+8 这类时区里 `toISOString()` 会给出前一天
    const midnight = new Date(2026, 9, 12, 0, 30, 0)
    expect(formatTemplatePattern(midnight, 'YYYY-MM-DD')).toBe('2026-10-12')
    expect(formatTemplatePattern(midnight, 'HH:mm')).toBe('00:30')
  })

  it('展开结果里不认识的字符不会被吃掉（模式串之外一字不动）', () => {
    expect(expand('第 @today=YYYY 周')).toBe('第 2026 周')
  })
})

describe('不该被误伤的三种输入（§9 第 2 条）', () => {
  it('邮箱地址原样保留', () => {
    const outcome = expandTemplate('联系 mail@example.com', values())
    expect(outcome.text).toBe('联系 mail@example.com')
    expect(outcome.notes).toEqual([])
  })

  it('汉字之后的 `@example` 只算"未识别"，正文一字不动', () => {
    // 汉字算边界（见 scan.ts 模块头），所以 `用户@example.com` 里确实出现了候选记号；
    // 名字不认识 → 原样保留 + 一条"未识别的记号"
    const outcome = expandTemplate('用户@example.com', values())
    expect(outcome.text).toBe('用户@example.com')
    expect(outcome.notes).toEqual([{ kind: 'unknown', raw: '@example' }])
  })

  it('汉字紧挨 `@` 时仍是记号（中文没有空格，行内落点必须能用）', () => {
    const outcome = expandTemplate('今天@cursor完成了', values())
    expect(outcome.text).toBe('今天完成了')
    expect(outcome.cursor).toBe(2)
  })

  it('已知边界：`团队@today` 会展开（左邻排除集合只收 ASCII，见 scan.ts 模块头）', () => {
    // 把这条钉成断言而不是留成"说不定"：`@` 前是汉字时按边界处理，
    // 因为 `今天@cursor完成了` 必须可用；代价就是这个（很罕见的）写法会展开
    expect(expand('团队@today')).toBe('团队2026-10-12')
  })

  it('`@username` 原样保留，但会被列为"未识别的记号"', () => {
    const outcome = expandTemplate('作者：@username', values())
    expect(outcome.text).toBe('作者：@username')
    expect(outcome.notes).toEqual([{ kind: 'unknown', raw: '@username' }])
  })

  it('同一个未识别记号出现多次只提示一条（界面不必重复念同一句话）', () => {
    const outcome = expandTemplate('@foo 和 @foo', values())
    expect(outcome.text).toBe('@foo 和 @foo')
    expect(outcome.notes).toEqual([{ kind: 'unknown', raw: '@foo' }])
  })

  it('`@@` 是转义：`@@today` 展开成字面量 `@today`，不展开日期', () => {
    expect(expand('@@today')).toBe('@today')
    expect(expand('@@')).toBe('@')
    expect(expand('邮箱是 a@@b')).toBe('邮箱是 a@b')
  })

  it('转义与展开可以共存于一行', () => {
    expect(expand('@@today 真正的 @today')).toBe('@today 真正的 2026-10-12')
  })
})

describe('纯文本展开（§9 第 5 条）', () => {
  it('模板整篇展开：标记全部消失，frontmatter 也参与', () => {
    const template = [
      '---',
      'created: @now',
      'title: @title',
      '---',
      '',
      '# @title',
      '',
      '路径：@path（@filename，库 @vault）',
    ].join('\n')
    expect(expand(template)).toBe(
      [
        '---',
        'created: 2026-10-12 20:50',
        'title: 我的笔记',
        '---',
        '',
        '# 我的笔记',
        '',
        '路径：folder/我的笔记.md（我的笔记.md，库 mimenote-vault）',
      ].join('\n'),
    )
  })

  it('`@title` 走调用方给的 displayName 口径（不含扩展名），展开器不自己拼路径', () => {
    // 判据在 `domain/paths.displayName` 那一份：这里给什么就展开成什么
    const text = expand('@title', { title: displayName('归档/会议记录.md') })
    expect(text).toBe('会议记录')
    expect(text.endsWith('.md')).toBe(false)
  })

  it('`none` 类的记号带上参数时忽略参数（参数只对模式串与 prompt 有意义）', () => {
    expect(expand('@title=甲')).toBe('我的笔记')
  })

  it('空模板与没有记号的模板原样返回', () => {
    expect(expand('')).toBe('')
    expect(expand('一段没有任何记号的正文。')).toBe('一段没有任何记号的正文。')
  })
})

describe('`@cursor`（§9 第 4 条）', () => {
  it('落点被移除，`cursor` 指向它在展开结果里的位置', () => {
    const outcome = expandTemplate('甲@cursor乙', values())
    expect(outcome.text).toBe('甲乙')
    expect(outcome.cursor).toBe(1)
  })

  it('行中间、行尾、单独一行都能算准', () => {
    expect(expandTemplate('会议记录：@cursor', values())).toMatchObject({ text: '会议记录：', cursor: 5 })
    expect(expandTemplate('@cursor\n正文', values())).toMatchObject({ text: '\n正文', cursor: 0 })
    // `@cursor` 展开出的空串会让**后面**的记号位置前移：落点必须按输出算，不是按原文算
    expect(expandTemplate('@today:@cursor', values())).toMatchObject({
      text: '2026-10-12:',
      cursor: 11,
    })
  })

  it('没有 `@cursor` 时 `cursor === null`（= 光标落文档末尾，不是 0）', () => {
    expect(expandTemplate('只有正文', values()).cursor).toBeNull()
  })

  it('多个 `@cursor`：第一个生效，其余原样保留并提示', () => {
    const outcome = expandTemplate('甲@cursor乙@cursor丙', values())
    expect(outcome.text).toBe('甲乙@cursor丙')
    expect(outcome.cursor).toBe(1)
    expect(outcome.notes).toEqual([{ kind: 'extra-cursor', raw: '@cursor' }])
  })
})

describe('代码上下文（§9 第 6 条）', () => {
  it('围栏代码块与行内代码里的记号保持字面量', () => {
    const text = ['```md', 'created: @now', '```', '', '`@today` 与正文 @today'].join('\n')
    expect(expand(text)).toBe(['```md', 'created: @now', '```', '', '`@today` 与正文 2026-10-12'].join('\n'))
  })
})

describe('`@clipboard` / `@prompt` / `@uuid`', () => {
  it('剪贴板拿不到：空串 + 非阻断提示', () => {
    const outcome = expandTemplate('>[!quote] @clipboard', values({ clipboard: null }))
    expect(outcome.text).toBe('>[!quote] ')
    expect(outcome.notes).toEqual([{ kind: 'clipboard-missing', raw: '@clipboard' }])
  })

  it('剪贴板有内容：原样插入（含换行）', () => {
    expect(expand('@clipboard 结束', { clipboard: '第一行\n第二行' })).toBe('第一行\n第二行 结束')
  })

  it('剪贴板为空串与拿不到同一种表现（用户眼里是同一件事）', () => {
    expect(expand('@clipboard', { clipboard: '' })).toBe('')
  })

  it('`@prompt` 的答案是展开前就收集好的：参数是输入框标题', () => {
    expect(collectTemplatePrompts('@prompt=标题 与 @prompt 与 @prompt=标题')).toEqual(['标题', ''])
    const outcome = expandTemplate('名称：@prompt=名称', values({ prompt: (label) => `<${label}>` }))
    expect(outcome.text).toBe('名称：<名称>')
  })

  it('`@prompt` 没有答案时展开成空串（不阻断创建）', () => {
    expect(expand('名称：@prompt')).toBe('名称：')
  })

  it('`@uuid` 用注入的生成器（形状与随机源可测）', () => {
    expect(expand('@uuid', { uuid: () => '3f2a0000-0000-4000-8000-000000000000' })).toBe(
      '3f2a0000-0000-4000-8000-000000000000',
    )
    expect(randomUuidV4()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    )
  })
})

describe('同一个判据驱动补全与展开（§9 第 3 条）', () => {
  it('候选右侧的预览值与真正展开的结果逐字相同（模式串与路径类）', () => {
    for (const builtin of TEMPLATE_BUILTINS) {
      // 这三个给不出同步真值（剪贴板要读、prompt 要问、uuid 每次都不同），预览是占位说明
      if (builtin.name === 'clipboard' || builtin.name === 'prompt' || builtin.name === 'uuid') continue
      if (builtin.name === 'cursor') continue
      const preview = previewTemplateValue(builtin.name, null, SNAPSHOT)
      expect(expand(`@${builtin.name}`)).toBe(preview)
    }
  })

  it('带模式串时预览值也一致（用户在列表里看到的就是选中后拿到的）', () => {
    for (const pattern of ['YYYY年M月D日', 'ddd', 'HH:mm', 'YY']) {
      expect(expand(`@today=${pattern}`)).toBe(previewTemplateValue('today', pattern, SNAPSHOT))
    }
  })

  it('预览对三个"问出来才有"的记号给的是占位说明，而不是假值', () => {
    expect(previewTemplateValue('clipboard', null, SNAPSHOT)).toBe('（读取剪贴板）')
    expect(previewTemplateValue('prompt', null, SNAPSHOT)).toBe('（创建时询问）')
    expect(previewTemplateValue('uuid', null, SNAPSHOT)).toBe('（每次生成新的 v4）')
  })
})
