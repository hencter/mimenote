// @vitest-environment jsdom
/**
 * 任务列表（`- [ ] 待办` / `- [x] 已完成`）。
 *
 * 这一层钉三件事，对应这个功能的三处改动：
 *
 * 1. **判据**：`domain/task-list.ts` 的 `parseTaskMarker` —— 什么算任务标记、什么不算
 *    （"不算"的那一半比"算"的那一半重要：判错方向会**吃掉用户的正文**）；
 * 2. **渲染**：`renderMarkdown` 的产物里是真的复选框、且标记本身不再是可见文字
 *    （阅读视图 / 导出件 / 打印 / 静态站点都走这一条管线，所以钉住它就钉住了四处）；
 * 3. **净化放开的边界**：`domain/markdown.ts` 为了让复选框活下来，把 `input` 从
 *    `FORBID_TAGS` 里单独拿出去了 —— 于是"放开的**只有**禁用的复选框"这件事必须同样钉住，
 *    否则一次手滑就能让渲染结果里出现一个真能输入的控件。
 *
 * 导出件与静态站点的产物在 `export.test.tsx` / `site-export.test.tsx` 里各自断言
 * （那边才有写文件的通道），这里只管到"HTML 字符串长什么样"。
 *
 * 环境必须是 jsdom：`renderMarkdown` 走 DOMPurify，它在没有 `window` 的环境里
 * `isSupported === false`、`sanitize` 甚至没有被定义（见 `domain/markdown.ts` 的说明）。
 */

import { describe, expect, it } from 'vitest'

import { renderMarkdown, sanitizeHtml } from '@/domain/markdown'
import { parseMarkdownTokens } from '@/domain/markdown-core'
import {
  TASK_CHECKED_ATTR,
  parseTaskMarker,
  taskCheckedFromAttr,
  taskCheckedValue,
} from '@/domain/task-list'

/** 把渲染结果挂进 DOM 再断言：比对上字符串更接近"用户看到什么"，也不吃属性顺序的亏。 */
function parse(html: string): HTMLElement {
  const holder = document.createElement('div')
  holder.innerHTML = html
  return holder
}

/** 渲染结果里的列表项（按文档顺序）。 */
function itemsOf(html: string): HTMLLIElement[] {
  return [...parse(html).querySelectorAll('li')]
}

/** 渲染结果里的复选框（按文档顺序）。 */
function boxesOf(html: string): HTMLInputElement[] {
  return [...parse(html).querySelectorAll('input[type=checkbox]')] as HTMLInputElement[]
}

describe('判据：什么算任务标记（parseTaskMarker）', () => {
  it('行首的 `[ ]` / `[x]` / `[X]` 是标记，且标记与它后面的空白都从正文里去掉', () => {
    expect(parseTaskMarker('[ ] 待办')).toEqual({ checked: false, rest: '待办' })
    expect(parseTaskMarker('[x] 已完成')).toEqual({ checked: true, rest: '已完成' })
    // `[X]` 与大写/小写无关地算"已完成"：同一个人在同一篇笔记里两种都会写
    expect(parseTaskMarker('[X] 大写也算')).toEqual({ checked: true, rest: '大写也算' })
  })

  it('标记后面什么都没有也算任务项（`- [ ]` 是一个合法的空待办）', () => {
    expect(parseTaskMarker('[ ]')).toEqual({ checked: false, rest: '' })
    expect(parseTaskMarker('[x]')).toEqual({ checked: true, rest: '' })
  })

  it('非任务：标记不在最前面', () => {
    // 句子中间的方括号是**用户的正文**（"我选 [x] 这一项"），认它等于把文字改成语法
    expect(parseTaskMarker('我选 [x] 这一项')).toBeNull()
    expect(parseTaskMarker('  [ ] 前导空格也不算（缩进由列表结构负责）')).toBeNull()
    expect(parseTaskMarker('文字\n[x] 下一行')).toBeNull()
  })

  it('非任务：方括号里的内容不对，或标记后面紧跟非空白', () => {
    expect(parseTaskMarker('[  ] 两个空格不是标记')).toBeNull()
    expect(parseTaskMarker('[] 空方括号不是标记')).toBeNull()
    expect(parseTaskMarker('[y] 只有 x/X 算已完成')).toBeNull()
    expect(parseTaskMarker('[x]没有空白')).toBeNull()
    expect(parseTaskMarker('[x]yz')).toBeNull()
    expect(parseTaskMarker('')).toBeNull()
    expect(parseTaskMarker('[ ] ')).toEqual({ checked: false, rest: '' })
  })
})

describe('渲染：`- [ ] 待办` 长成带复选框的列表项', () => {
  const source = ['- [ ] 未完成', '- [x] 已完成', '- [X] 大写也算', '- 普通条目'].join('\n')

  it('列表项带上任务类名，已完成的那两条带修饰类名', () => {
    expect(itemsOf(renderMarkdown(source)).map((item) => item.className)).toEqual([
      'mn-task-item',
      'mn-task-item mn-task-item--done',
      'mn-task-item mn-task-item--done',
      '',
    ])
  })

  it('复选框是**禁用**的真 input，勾选状态与 `[ ]`/`[x]`/`[X]` 一致', () => {
    const boxes = boxesOf(renderMarkdown(source))
    expect(boxes).toHaveLength(3)
    expect(boxes.map((box) => box.checked)).toEqual([false, true, true])
    // 阅读视图是只读的：这里勾选不会改文档（改文档只能走编辑器），所以每一个都必须是 disabled
    expect(boxes.every((box) => box.disabled)).toBe(true)
  })

  it('复选框长在 `li` **里面**（跟在 `</li>` 后面就成了一个游离的控件）', () => {
    // 只 parse 一次：`itemsOf`/`boxesOf` 各 parse 一次会得到**两棵** DOM 树，
    // 节点对象对不上，`toContain` 会对着同一个节点报"没找到"
    const tree = parse(renderMarkdown(source))
    const items = [...tree.querySelectorAll('li')]
    const boxes = [...tree.querySelectorAll('input[type=checkbox]')] as HTMLInputElement[]

    expect(boxes).toHaveLength(3)
    for (const box of boxes) expect(items).toContain(box.closest('li'))
    // 任务项的复选框一定在带任务类名的那一项里（不是跑到上一条普通条目里去了）
    expect(boxes.map((box) => box.closest('li')?.className)).toEqual([
      'mn-task-item',
      'mn-task-item mn-task-item--done',
      'mn-task-item mn-task-item--done',
    ])
  })

  it('标记本身不再是可见文字（否则复选框旁边还留着一份 `[ ]`）', () => {
    const text = parse(renderMarkdown(source)).textContent ?? ''
    expect(text).toContain('未完成')
    expect(text).toContain('已完成')
    expect(text).toContain('普通条目')
    expect(text).not.toContain('[ ]')
    expect(text).not.toContain('[x]')
    expect(text).not.toContain('[')
  })

  it('`*` / `+` / 有序列表里的写法一样认（列表符号与序号不参与判据）', () => {
    const html = renderMarkdown('* [ ] 星号\n+ [x] 加号\n\n1. [ ] 有序未完成\n2. [x] 有序已完成')
    expect(boxesOf(html).map((box) => box.checked)).toEqual([false, true, false, true])
  })

  it('嵌套缩进：父子各自的标记各归各的（内层条目有自己的 list_item_open）', () => {
    const html = renderMarkdown('- [x] 父任务\n  - [ ] 子任务\n    - [ ] 孙任务')
    expect(boxesOf(html).map((box) => box.checked)).toEqual([true, false, false])
    expect(itemsOf(html).map((item) => item.className)).toEqual([
      'mn-task-item mn-task-item--done',
      'mn-task-item',
      'mn-task-item',
    ])
  })

  it('勾选框与行内样式共存：`- [x] **重要**` 的第一个文字 token 被切掉标记后照样出粗体', () => {
    const html = renderMarkdown('- [x] **重要** 的事')
    expect(boxesOf(html).map((box) => box.checked)).toEqual([true])
    expect(html).toContain('<strong>重要</strong>')
    expect(parse(html).textContent).not.toContain('[x]')
  })

  it('非任务：手写的方括号原样留在文字里，一行都不加复选框', () => {
    const html = renderMarkdown(
      ['- **[x]** 手写', '- 我选 [x] 这一项', '- [[链接]] [x] 标记不在最前面', '- [x][[链接]] 标记后没空白'].join(
        '\n',
      ),
    )
    expect(html).not.toContain('<input')
    expect(html).not.toContain('mn-task-item')
    const text = parse(html).textContent ?? ''
    expect(text).toContain('[x]')
    expect(text).toContain('手写')
    expect(text).toContain('我选')
  })

  it('非任务：显式转义的 `\\[x\\]` 不算（判据看段落**原文**，不看解析后的文字）', () => {
    // `\[` 被 markdown-it 解析之后与真的 `[` 逐字相同 —— 只看文字已经分不清，
    // 所以核心规则拿 `inline.content`（原文）来判，这也是这一条存在的理由
    const html = renderMarkdown('- \\[x\\] 不是任务')
    expect(html).not.toContain('<input')
    expect(parse(html).textContent).toContain('[x] 不是任务')
  })
})

describe('token：结论写在 list_item_open 上（画布读的就是它）', () => {
  it('已完成写 `1`、未完成写 `0`、普通条目没有这个属性', () => {
    const tokens = parseMarkdownTokens('- [x] 甲\n- [ ] 乙\n- 丙')
    const opens = tokens.filter((token) => token.type === 'list_item_open')
    expect(opens.map((token) => token.attrGet?.(TASK_CHECKED_ATTR) ?? null)).toEqual([
      '1',
      '0',
      null,
    ])
  })

  it('这个内部属性**不进 HTML**（它只服务 token 消费者之间的通信）', () => {
    expect(renderMarkdown('- [x] 甲')).not.toContain(TASK_CHECKED_ATTR)
  })

  it('读端的三态：`1` 已完成、`0` 未完成、读不出来 = **不是任务项**（不是"未完成"）', () => {
    expect(taskCheckedValue(true)).toBe('1')
    expect(taskCheckedValue(false)).toBe('0')
    expect(taskCheckedFromAttr('1')).toBe(true)
    expect(taskCheckedFromAttr('0')).toBe(false)
    expect(taskCheckedFromAttr(null)).toBeUndefined()
    expect(taskCheckedFromAttr('')).toBeUndefined()
    expect(taskCheckedFromAttr('true')).toBeUndefined()
    expect(taskCheckedFromAttr('yes')).toBeUndefined()
  })
})

describe('净化：放开的只有"禁用的复选框"这一种 input', () => {
  it('渲染出来的那个复选框活着（禁用 + 勾选状态都在）', () => {
    const boxes = boxesOf(renderMarkdown('- [x] 已完成'))
    expect(boxes).toHaveLength(1)
    expect(boxes[0]?.disabled).toBe(true)
    expect(boxes[0]?.checked).toBe(true)
  })

  it('其它 input 一律被剥掉：可输入的类型、没禁用的复选框都不行', () => {
    // `input` 是从 FORBID_TAGS 里单独放开的一条，放开的**边界**就是这里：
    // 白名单只能表达"允许 input"，"必须是禁用的 checkbox"由净化钩子当场强制
    expect(sanitizeHtml('<input type="text" />')).not.toContain('<input')
    expect(sanitizeHtml('<input type="checkbox" />')).not.toContain('<input')
    expect(sanitizeHtml('<input type="radio" disabled />')).not.toContain('<input')
    expect(sanitizeHtml('<input type="submit" />')).not.toContain('<input')
    // 嵌在别的元素里也一样（钩子是在遍历中逐个元素调用的，不只看顶层）
    expect(sanitizeHtml('<div>前面 <input type="text" /> 后面</div>')).not.toContain('<input')
    // 反面：禁用的复选框本身是允许的（否则任务列表在阅读视图里就什么都不剩了）
    expect(sanitizeHtml('<input type="checkbox" disabled checked />')).toContain('<input')
  })

  it('笔记里写不进 HTML 结构（`html: false`）：这些 input 只可能来自我们自己的渲染规则', () => {
    const html = renderMarkdown('<input type="checkbox" checked>\n\n正文')
    expect(html).not.toContain('<input')
    expect(html).toContain('&lt;input')
  })
})
