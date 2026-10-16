// @vitest-environment jsdom
/**
 * `@` 模板记号补全（`features/editor/cm/template-complete/`）测试。
 *
 * 分三层（与 `editor-wikilink-complete.test.tsx` 同一套分工）：
 * 1. **纯函数层**：上下文判定（`templateContextAt`）与补全编辑（`completionEdit`）——
 *    "哪些地方不弹""替换整条记号"可以逐字断言，不用模拟键盘；
 * 2. **候选层**：列表内容与右侧的展开值（设计 02 §5.2"候选里显示展开后的真实值"）；
 * 3. **装配层**：真的建 `EditorView`（与产品同一套 `createEditorExtensions`）、真的派发输入
 *    与 keydown，断言弹层出现/过滤/插入/`Esc` 不改文档，以及 §9 第 5 条
 *    "撤销一次回到插入前"。
 *
 * 弹层与 `[[` 补全**共用样式类**，所以这里一律按 `aria-label`（"模板记号补全"）认出自己那一个
 * —— 断言"模板弹层没开"时也不会误判成"笔记弹层没开"。
 */

import { undo } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TEMPLATE_BUILTINS, type TemplateSnapshot } from '@/domain/template/builtins'
import { filterTemplateCandidates } from '@/features/editor/cm/template-complete/candidates'
import { completionEdit, templateContextAt } from '@/features/editor/cm/template-complete/context'
import { createEditorExtensions } from '@/features/editor/cm/setup'
import { makeEntry } from '@/ipc/client'
import { useNoteStore } from '@/state/note-store'
import { useVaultStore } from '@/state/vault-store'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 与编辑器**同一套** Markdown 语言扩展：上下文判定要看语法树（`[[` 互斥那一条）。 */
const LANGUAGE = markdown({ base: markdownLanguage })

function stateOf(doc: string, cursor: number): EditorState {
  return EditorState.create({ doc, selection: { anchor: cursor }, extensions: [LANGUAGE] })
}

/** `needle` 在 `doc` 里的位置。 */
function at(doc: string, needle: string, from = 0): number {
  const index = doc.indexOf(needle, from)
  if (index === -1) throw new Error(`文档里找不到 ${needle}`)
  return index
}

const views: EditorView[] = []

function mountEditor(doc: string, cursor: number): EditorView {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: createEditorExtensions({}, true),
    }),
  })
  views.push(view)
  return view
}

/** 像用户那样打一段字（`input.type`，与真实输入同一类事务）。 */
function typeText(view: EditorView, text: string): void {
  const range = view.state.selection.main
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: { anchor: range.from + text.length },
    userEvent: 'input.type',
  })
}

/** 逐个字符地打（真实的键盘/输入法就是这个粒度）。 */
function typeChars(view: EditorView, text: string): void {
  for (const char of text) typeText(view, char)
}

/** 派发一次 keydown，返回"是否被吃掉"。 */
function pressKey(view: EditorView, key: string, modifiers: { ctrlKey?: boolean } = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers })
  view.contentDOM.dispatchEvent(event)
  return event.defaultPrevented
}

const TEMPLATE_LIST_LABEL = '模板记号补全'

function templatePanelOf(view: EditorView): HTMLElement | null {
  const list = view.dom.querySelector(`[role="listbox"][aria-label="${TEMPLATE_LIST_LABEL}"]`)
  return list?.closest<HTMLElement>('.mn-wiki-complete') ?? null
}

function optionsOf(view: EditorView): HTMLElement[] {
  const panel = templatePanelOf(view)
  return panel === null ? [] : Array.from(panel.querySelectorAll<HTMLElement>('[role="option"]'))
}

/** 主文本（`@today`）。 */
function optionNames(view: EditorView): string[] {
  return optionsOf(view).map((option) => option.querySelector('.mn-wiki-complete__name')?.textContent ?? '')
}

/** 右侧那一列（展开后的真实值）。 */
function optionValues(view: EditorView): string[] {
  return optionsOf(view).map((option) => option.querySelector('.mn-wiki-complete__path')?.textContent ?? '')
}

function activeName(view: EditorView): string | undefined {
  const active = optionsOf(view).find((option) => option.getAttribute('aria-selected') === 'true')
  return active?.querySelector('.mn-wiki-complete__name')?.textContent ?? undefined
}

function pretendOpenNote(relPath: string, text = ''): void {
  useNoteStore.setState({
    doc: {
      relPath,
      text,
      format: { bom: false, eol: '\n' },
      baseMtimeMs: 0,
      sizeBytes: text.length,
      revision: 1,
      openedAt: 0,
    },
  })
}

const SNAPSHOT: TemplateSnapshot = {
  now: new Date(2026, 9, 12, 20, 50, 30),
  title: '我的笔记',
  filename: '我的笔记.md',
  path: '笔记/我的笔记.md',
  vault: 'mimenote-vault',
}

beforeEach(() => {
  useNoteStore.getState().closeAll()
  useVaultStore.setState({ info: null, entries: [] })
})

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  document.body.innerHTML = ''
})

// ---------------------------------------------------------------------------
// 1. 纯函数：上下文判定
// ---------------------------------------------------------------------------

describe('上下文判定（哪些地方该弹、哪些地方绝不能弹）', () => {
  it('刚敲下 `@`：认出一个空查询的上下文，替换区间就是那一个字符', () => {
    const doc = '正文 @'
    const context = templateContextAt(stateOf(doc, doc.length))
    expect(context).toMatchObject({ from: 3, to: 4, query: '', argument: null, raw: '@' })
  })

  it('继续输入：查询串是光标之前的名字', () => {
    expect(templateContextAt(stateOf('正文 @tod', 7))?.query).toBe('tod')
  })

  it('参数参与上下文（`@today=YY` 的整段都会被替换）', () => {
    const doc = '@today=YY'
    expect(templateContextAt(stateOf(doc, doc.length))).toMatchObject({
      from: 0,
      to: doc.length,
      query: 'today',
      argument: 'YY',
      raw: doc,
    })
  })

  it('邮箱与词内字符之后不算（`mail@`）', () => {
    expect(templateContextAt(stateOf('mail@', 5))).toBeNull()
  })

  it('`@@` 转义里不算（那是字面量 `@`）', () => {
    expect(templateContextAt(stateOf('@@today', 6))).toBeNull()
  })

  it('光标在 `@` 之前、或离开记号之后都不算', () => {
    expect(templateContextAt(stateOf('正文 @today', 3))).toBeNull()
    expect(templateContextAt(stateOf('@today 后面', 8))).toBeNull()
  })

  it('代码上下文里不算：围栏代码块与行内代码', () => {
    const fenced = '```\n@today\n```'
    expect(templateContextAt(stateOf(fenced, at(fenced, '@today') + 6))).toBeNull()

    const inline = '看 `@today` 后面'
    expect(templateContextAt(stateOf(inline, 6))).toBeNull()
  })

  it('`[[…` 里不弹（`@` 是链接目标的一部分，那时该弹的是笔记候选）', () => {
    // 把光标放在 `[[设计@to` 的末尾
    const doc = '见 [[设计@to'
    expect(templateContextAt(stateOf(doc, doc.length))).toBeNull()
  })

  it('frontmatter 里照常弹（与 `[[` 补全**故意不同**：模板的 frontmatter 也参与展开）', () => {
    const doc = '---\ncreated: @no\n---\n'
    expect(templateContextAt(stateOf(doc, at(doc, '@no') + 3))?.query).toBe('no')
  })
})

describe('补全编辑', () => {
  it('把整条记号替换成插入文本，光标落在插入文本之后', () => {
    const state = stateOf('正文 @tod', 7)
    const context = templateContextAt(state)
    if (context === null) throw new Error('预期处在 `@` 上下文里')
    const edit = completionEdit(context, '2026-10-12')
    const next = state.update({ changes: edit.changes, selection: edit.selection }).state
    expect(next.doc.toString()).toBe('正文 2026-10-12')
    expect(next.selection.main.head).toBe('正文 2026-10-12'.length)
  })
})

// ---------------------------------------------------------------------------
// 2. 候选：列表内容与右侧的展开值
// ---------------------------------------------------------------------------

describe('候选列表', () => {
  it('空查询列出全部内建记号（`@cursor` 除外，它只在模板文件里有意义）', () => {
    const names = filterTemplateCandidates('', null, SNAPSHOT).map((item) => item.name)
    expect(names).toEqual(TEMPLATE_BUILTINS.filter((builtin) => builtin.name !== 'cursor').map((b) => b.name))
    expect(names).toContain('today')
    expect(names).not.toContain('cursor')
  })

  it('右侧显示展开后的真实值（用户不必记名字）', () => {
    const items = filterTemplateCandidates('', null, SNAPSHOT)
    const value = (name: string): string => items.find((item) => item.name === name)?.value ?? ''
    expect(value('today')).toBe('2026-10-12')
    expect(value('now')).toBe('2026-10-12 20:50')
    expect(value('time')).toBe('20:50')
    expect(value('title')).toBe('我的笔记')
    expect(value('path')).toBe('笔记/我的笔记.md')
    expect(value('vault')).toBe('mimenote-vault')
  })

  it('已经敲下的参数会带进展开值（`@today=ddd` → 周一）', () => {
    const items = filterTemplateCandidates('today', 'ddd', SNAPSHOT)
    expect(items[0]?.value).toBe('周一')
  })

  it('三个"问出来才有"的记号给的是占位说明，不是假值', () => {
    const items = filterTemplateCandidates('', null, SNAPSHOT)
    const find = (name: string) => items.find((item) => item.name === name)
    expect(find('clipboard')?.value).toBe('（读取剪贴板）')
    expect(find('prompt')?.value).toBe('（创建时询问）')
    expect(find('uuid')?.value).toBe('（每次生成新的 v4）')
  })

  it('子序列匹配（打 `tdy` 也能找到 `today`）', () => {
    expect(filterTemplateCandidates('tdy', null, SNAPSHOT)[0]?.name).toBe('today')
  })

  it('`@prompt` 的插入文本是**原样记号**（编辑器里不弹输入框，设计 02 §5.2 的例外）', () => {
    const item = filterTemplateCandidates('prompt', null, SNAPSHOT)[0]
    expect(item?.source).toBe('literal-token')
    expect(item?.insert).toBe('@prompt')
    // 带标签时保留标签（创建笔记时对话框的标题就是它）
    expect(filterTemplateCandidates('prompt', '标题', SNAPSHOT)[0]?.insert).toBe('@prompt=标题')
  })

  it('未知名字一条都不剩（补全列表不出现，§6）', () => {
    expect(filterTemplateCandidates('username', null, SNAPSHOT)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3. 真实装配
// ---------------------------------------------------------------------------

describe('真实装配：敲 `@` 弹层出现', () => {
  beforeEach(() => {
    pretendOpenNote('笔记/我的笔记.md')
    useVaultStore.setState({
      entries: [makeEntry({ relPath: '笔记/我的笔记.md' })],
      // Vault 名（`@vault` 的值）来自 info，不在条目表里
      info: {
        rootPath: 'D:/vault',
        name: 'mimenote-vault',
        entryCount: 1,
        noteCount: 1,
        folderCount: 0,
        truncated: false,
        skipped: 0,
        scanMs: 0,
      },
    })
  })

  it('敲出 `@` 弹层立刻出现，右侧是真值', () => {
    const view = mountEditor('正文', 2)
    typeText(view, '@')
    const panel = templatePanelOf(view)
    expect(panel).not.toBeNull()
    expect(optionsOf(view).length).toBeGreaterThan(0)
    expect(optionNames(view)).toContain('@today')
    // 右侧那一列是展开值：`@today` 一行直接显示今天的日期
    const todayIndex = optionNames(view).indexOf('@today')
    expect(optionValues(view)[todayIndex]).toMatch(/^\d{4}-\d{2}-\d{2}$/u)
  })

  it('继续输入即过滤；查询串排空候选时弹层关掉且不拦输入', () => {
    const view = mountEditor('正文', 2)
    typeChars(view, '@to')
    expect(optionNames(view)).toEqual(['@today'])

    typeChars(view, 'zzz')
    expect(templatePanelOf(view)).toBeNull()
    expect(view.state.doc.toString()).toBe('正文@tozzz')
  })

  it('`Enter` 插入展开值（不是记号），且 `@` 一起被替换掉', () => {
    const view = mountEditor('正文', 2)
    typeChars(view, '@today')
    expect(templatePanelOf(view)).not.toBeNull()

    expect(pressKey(view, 'Enter')).toBe(true)
    expect(view.state.doc.toString()).toMatch(/^正文\d{4}-\d{2}-\d{2}$/u)
    expect(templatePanelOf(view)).toBeNull()
  })

  it('§9 第 5 条：展开是纯文本，撤销一次回到**展开值插入之前**', () => {
    const view = mountEditor('甲', 1)
    typeChars(view, '@today')
    pressKey(view, 'Enter')
    expect(view.state.doc.toString()).not.toBe('甲')

    // 一次撤销 = 取消这次补全（`@today` 还在）——`input.complete` 是独立的一步，
    // CodeMirror 只合并 `input.type` / `delete`（见 plugin.ts 里 applyEdit 的注释）
    undo(view)
    expect(view.state.doc.toString()).toBe('甲@today')

    // 再撤一次才回到最初：两次都说明展开写进文档的是**真文本**，而不是一个不可撤销的组件
    undo(view)
    expect(view.state.doc.toString()).toBe('甲')
  })

  it('`↑` `↓` 换选中项（循环）', () => {
    const view = mountEditor('正文', 2)
    typeText(view, '@')
    const names = optionNames(view)
    expect(activeName(view)).toBe(names[0])

    expect(pressKey(view, 'ArrowDown')).toBe(true)
    expect(activeName(view)).toBe(names[1])
    expect(pressKey(view, 'ArrowUp')).toBe(true)
    expect(activeName(view)).toBe(names[0])
  })

  it('确认的是**高亮那一条**', () => {
    const view = mountEditor('正文', 2)
    typeText(view, '@')
    pressKey(view, 'ArrowDown')
    expect(activeName(view)).toBe('@now')
    pressKey(view, 'Enter')
    expect(view.state.doc.toString()).toMatch(/^正文\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u)
  })

  it('`@prompt` 插入字面记号，且选完不会再弹一次', () => {
    const view = mountEditor('正文', 2)
    typeChars(view, '@prompt')
    expect(optionsOf(view)[0]?.textContent).toContain('原样插入')

    pressKey(view, 'Enter')
    expect(view.state.doc.toString()).toBe('正文@prompt')
    expect(templatePanelOf(view)).toBeNull()
  })

  it('`Esc` 关闭弹层且一个字符都不改', () => {
    const view = mountEditor('正文', 2)
    typeChars(view, '@tod')
    const before = view.state.doc.toString()
    expect(pressKey(view, 'Escape')).toBe(true)
    expect(templatePanelOf(view)).toBeNull()
    expect(view.state.doc.toString()).toBe(before)
  })

  it('`Ctrl+Space` 手动唤出（光标停在已经写好的 `@today` 里时）', () => {
    const doc = '@today'
    const view = mountEditor(doc, 3)
    expect(templatePanelOf(view)).toBeNull() // 只是把光标放进去：不该自动弹

    expect(pressKey(view, ' ', { ctrlKey: true })).toBe(true)
    expect(optionNames(view)).toEqual(['@today'])
  })

  it('光标移出记号之后弹层关闭', () => {
    const doc = '@today 后面'
    const idle = mountEditor(doc, doc.length)
    // 光标不在任何记号里：Ctrl+Space 不吞键、也不弹
    expect(pressKey(idle, ' ', { ctrlKey: true })).toBe(false)
    expect(templatePanelOf(idle)).toBeNull()

    const typed = mountEditor('正文', 2)
    typeText(typed, '@')
    expect(templatePanelOf(typed)).not.toBeNull()
    typed.dispatch({ selection: { anchor: 0 } })
    expect(templatePanelOf(typed)).toBeNull()
  })

  it('代码上下文里不触发：围栏代码块与行内代码', () => {
    const fenced = '```\n\n```'
    const view = mountEditor(fenced, at(fenced, '\n') + 1)
    typeText(view, '@')
    expect(templatePanelOf(view)).toBeNull()
    expect(view.state.doc.toString()).toBe('```\n@\n```')

    const inline = '看 `` 后面'
    const inlineView = mountEditor(inline, at(inline, '``') + 1)
    typeText(inlineView, '@')
    expect(templatePanelOf(inlineView)).toBeNull()
  })

  it('`[[…` 里不弹模板补全（那时弹的是笔记候选）', () => {
    const doc = '见 [[设计'
    const view = mountEditor(doc, doc.length)
    typeText(view, '@')
    expect(templatePanelOf(view)).toBeNull()
  })

  it('弹层关着时 `Enter` / `Tab` 的既有语义一概不受影响（列表续行 / 缩进）', () => {
    const view = mountEditor('- 甲', 3)
    expect(pressKey(view, 'Enter')).toBe(true)
    expect(view.state.doc.toString()).toBe('- 甲\n- ')
    expect(pressKey(view, 'Tab')).toBe(true)
    expect(view.state.doc.toString()).toBe('- 甲\n    - ')
  })

  it('多光标下不弹（一次确认只能改主光标那一处）', () => {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: '甲\n乙',
        selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(3)]),
        extensions: createEditorExtensions({}, true),
      }),
    })
    views.push(view)
    view.dispatch({ changes: { from: 0, insert: '@' }, userEvent: 'input.type' })
    expect(view.state.selection.ranges).toHaveLength(2)
    expect(templatePanelOf(view)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 4. 样式契约（与 `[[` 补全共用同一份主题）
// ---------------------------------------------------------------------------

describe('样式复用', () => {
  it('弹层用的是 `[[` 补全那一套类名（不新造一套样式）', () => {
    const view = mountEditor('正文', 2)
    typeText(view, '@')
    const panel = templatePanelOf(view)
    expect(panel).not.toBeNull()
    // 同一个面板类 + 自己的 aria-label：样式一份，归属可辨
    expect(panel?.classList.contains('mn-wiki-complete')).toBe(true)
    expect(panel?.querySelector('.mn-wiki-complete__list')).not.toBeNull()
    expect(panel?.querySelector('.mn-wiki-complete__item')).not.toBeNull()
  })
})
