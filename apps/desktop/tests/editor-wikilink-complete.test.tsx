// @vitest-environment jsdom
/**
 * `[[` 笔记补全（wiki 链接补全）测试。
 *
 * 分三层：
 * 1. **纯函数层**：`wikilinkContextAt` / `completionEdit` 只吃 `EditorState`、只返回数据，
 *    于是"哪些上下文不许弹""`]]` 会不会重复插入""光标落在哪"可以逐字断言
 *    （不用模拟键盘、不用看 DOM）；
 * 2. **索引层**：候选从 `vault-store` 的条目表派生，排序口径必须与宿主
 *    `mn-index::pick_candidate`（同目录 → 路径更短 → 字典序）一致 —— 这是
 *    "同名多篇都能选到、而且第一项就是 `[[名字]]` 真正指向的那一篇"的唯一保证；
 * 3. **装配层**：真的建 `EditorView`（与产品同一套 `createEditorExtensions`）、
 *    真的派发输入与 keydown，断言弹层真的出现、真的过滤、真的插入、`Esc` 真的不改文档。
 *
 * 性能（1 万条时每次按键的耗时）在 `editor-wikilink-complete-perf.test.ts` 里量。
 */

import { undo } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildWikilinkIndex,
  filterWikilinkCandidates,
} from '@/features/editor/cm/wiki-complete/candidates'
import { completionEdit, wikilinkContextAt } from '@/features/editor/cm/wiki-complete/context'
import { __testing as completeTesting } from '@/features/editor/cm/wiki-complete/plugin'
import { WIKI, wikiCompleteThemeSpec } from '@/features/editor/cm/wiki-complete/theme'
import { createEditorExtensions } from '@/features/editor/cm/setup'
import { makeEntry } from '@/ipc/client'
import { useNoteStore } from '@/state/note-store'
import { useVaultStore } from '@/state/vault-store'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 与编辑器**同一套** Markdown 语言扩展：上下文判定要看语法树（代码区间）。 */
const LANGUAGE = markdown({ base: markdownLanguage })

function stateOf(doc: string, cursor: number): EditorState {
  return EditorState.create({ doc, selection: { anchor: cursor }, extensions: [LANGUAGE] })
}

/** `needle` 在 `doc` 里的位置（用它写断言比硬编码偏移可读得多）。 */
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

/** 逐个字符地打（真实的输入法/键盘就是这个粒度：一次事务一个字符）。 */
function typeChars(view: EditorView, text: string): void {
  for (const char of text) typeText(view, char)
}

/** 派发一次 keydown，返回"是否被吃掉"（`defaultPrevented` 就是命令返回 true 的证据）。 */
function pressKey(view: EditorView, key: string, modifiers: { ctrlKey?: boolean } = {}): boolean {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  })
  view.contentDOM.dispatchEvent(event)
  return event.defaultPrevented
}

/** `Ctrl+Space`（手动唤出）。 */
function pressCtrlSpace(view: EditorView): boolean {
  return pressKey(view, ' ', { ctrlKey: true })
}

function panelOf(view: EditorView): HTMLElement | null {
  return view.dom.querySelector<HTMLElement>(`.${WIKI.panel}`)
}

function optionsOf(view: EditorView): HTMLElement[] {
  const panel = panelOf(view)
  return panel === null ? [] : Array.from(panel.querySelectorAll<HTMLElement>('[role="option"]'))
}

/** 列表里每一行的主文本（也就是用户看到的候选名字）。 */
function optionNames(view: EditorView): string[] {
  return optionsOf(view).map(
    (option) => option.querySelector(`.${WIKI.name}`)?.textContent ?? option.textContent ?? '',
  )
}

function optionPaths(view: EditorView): string[] {
  return optionsOf(view).map((option) => option.querySelector(`.${WIKI.path}`)?.textContent ?? '')
}

function activeName(view: EditorView): string | undefined {
  const active = optionsOf(view).find(
    (option) => option.getAttribute('aria-selected') === 'true',
  )
  return active?.querySelector(`.${WIKI.name}`)?.textContent ?? undefined
}

function contentText(view: EditorView): string {
  return view.dom.querySelector('.cm-content')?.textContent ?? ''
}

/** 让编辑器认为"当前笔记是这一篇"（候选排序里的"同目录优先"要用它）。 */
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

function setVault(relPaths: readonly string[]): void {
  useVaultStore.setState({ entries: relPaths.map((relPath) => makeEntry({ relPath })) })
}

beforeEach(() => {
  useNoteStore.getState().close()
  useVaultStore.setState({ info: null, entries: [] })
  completeTesting.resetBuildCount()
})

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  document.body.innerHTML = ''
})

// ---------------------------------------------------------------------------
// 1. 纯函数：上下文判定
// ---------------------------------------------------------------------------

describe('上下文判定（哪些地方该弹、哪些地方绝不能弹）', () => {
  it('刚敲出 `[[`：认出一个空查询的上下文', () => {
    const doc = '正文[['
    const context = wikilinkContextAt(stateOf(doc, doc.length))
    expect(context).not.toBeNull()
    expect(context?.query).toBe('')
    expect(context?.embed).toBe(false)
    expect(context?.targetFrom).toBe(at(doc, '[[') + 2)
    expect(context?.insertAt).toBe(doc.length)
  })

  it('`![[` 认成嵌入（附件要一起列出来）', () => {
    const doc = '看图 ![[图'
    const context = wikilinkContextAt(stateOf(doc, doc.length))
    expect(context?.embed).toBe(true)
    expect(context?.query).toBe('图')
  })

  it('光标已经越过 `]]`：不是上下文（否则点回去就会莫名弹出）', () => {
    const doc = '见 [[设计]] 吧'
    expect(wikilinkContextAt(stateOf(doc, at(doc, '吧')))).toBeNull()
  })

  it('普通 Markdown 链接 `[文字](地址)` 不参与', () => {
    const doc = '[设计](设计.md)'
    expect(wikilinkContextAt(stateOf(doc, at(doc, '设计.md')))).toBeNull()
  })

  it('转义的 `\\[[` 不是链接（与宿主链接抽取同一口径）', () => {
    const doc = '看 \\[[设计'
    expect(wikilinkContextAt(stateOf(doc, doc.length))).toBeNull()
  })

  it('围栏代码块里不弹（靠语法树，不是靠行首字符）', () => {
    const doc = '```\n甲\n```'
    expect(wikilinkContextAt(stateOf(doc, at(doc, '甲') + 1))).toBeNull()
  })

  it('行内代码里不弹（配对的 `` ` `` 由语法树判定）', () => {
    const doc = '前 `代码` 后'
    expect(wikilinkContextAt(stateOf(doc, at(doc, '码')))).toBeNull()
  })

  it('还没闭合的反引号里也不弹（语法树此时还没有 InlineCode 节点）', () => {
    expect(wikilinkContextAt(stateOf('看 `', 3))).toBeNull()
  })

  it('frontmatter 里不弹（那里的 `[[` 不是链接）', () => {
    const doc = '---\ntitle: [[设计\n---\n\n正文[[设'
    expect(wikilinkContextAt(stateOf(doc, at(doc, '设计') + 2))).toBeNull()
    // 正文里同样的写法照常成立
    expect(wikilinkContextAt(stateOf(doc, doc.length))).not.toBeNull()
  })

  it('未闭合的 `---` 不是 frontmatter，正文照常可以补全', () => {
    const doc = '---\n这是正文 [[设'
    expect(wikilinkContextAt(stateOf(doc, doc.length))).not.toBeNull()
  })

  it('有别名时查询串取目标那一段（别名不参与过滤）', () => {
    const doc = '见 [[设计|别名'
    const context = wikilinkContextAt(stateOf(doc, doc.length))
    expect(context?.query).toBe('设计')
    expect(context?.insertAt).toBe(doc.length)
    expect(context?.aliasTo).toBe(doc.length)
  })
})

// ---------------------------------------------------------------------------
// 2. 纯函数：补全编辑
// ---------------------------------------------------------------------------

/** 把一次补全编辑应用到状态上，返回"按一下确认之后文件里到底是什么"。 */
function after(state: EditorState, target: string): { doc: string; cursor: number } {
  const context = wikilinkContextAt(state)
  if (context === null) throw new Error('预期处在 `[[` 上下文里，实际不是')
  const edit = completionEdit(context, target)
  const next = state.update({ changes: edit.changes, selection: edit.selection }).state
  return { doc: next.doc.toString(), cursor: next.selection.main.head }
}

describe('补全编辑：插入规则', () => {
  it('没有 `]]` 时补上，并把光标放在 `]]` 之前', () => {
    const result = after(stateOf('正文[[设计', 6), '设计文档')
    expect(result.doc).toBe('正文[[设计文档]]')
    expect(result.cursor).toBe(result.doc.indexOf(']]'))
  })

  it('已经有 `]]` 时不重复插入', () => {
    const doc = '正文[[设计]]'
    const result = after(stateOf(doc, at(doc, ']]')), '设计文档')
    expect(result.doc).toBe('正文[[设计文档]]')
    expect(result.doc.match(/\]\]/gu)).toHaveLength(1)
    expect(result.cursor).toBe(result.doc.indexOf(']]'))
  })

  it('有别名时只换目标，光标落在别名末尾（`]]` 之前）', () => {
    const doc = '见 [[设计|别名'
    const result = after(stateOf(doc, doc.length), '设计文档')
    expect(result.doc).toBe('见 [[设计文档|别名]]')
    expect(result.cursor).toBe(result.doc.indexOf(']]'))
  })

  it('别名的 `]]` 已经存在时同样不重复插入', () => {
    const doc = '见 [[设计|别名]]'
    const result = after(stateOf(doc, at(doc, ']]')), '设计文档')
    expect(result.doc).toBe('见 [[设计文档|别名]]')
    expect(result.doc.match(/\]\]/gu)).toHaveLength(1)
    expect(result.cursor).toBe(result.doc.indexOf(']]'))
  })

  it('目标里的路径形态照原样进文档（同名冲突时写相对路径）', () => {
    expect(after(stateOf('[[设计', 4), '../B/设计').doc).toBe('[[../B/设计]]')
  })
})

// ---------------------------------------------------------------------------
// 3. 候选索引与排序（与宿主消歧规则同序）
// ---------------------------------------------------------------------------

describe('候选排序与消歧', () => {
  const index = buildWikilinkIndex(
    [
      '笔记/测试.md', // 当前笔记
      '笔记/设计文档.md',
      '设计.md',
      'A/设计.md',
      'B/设计.md',
      '笔记/设计.md',
      '附件/图.png',
    ].map((relPath) => makeEntry({ relPath })),
  )
  const options = { noteRelPath: '笔记/测试.md', embed: false }

  it('空查询：同目录优先 → 路径更短 → 字典序', () => {
    const outcome = filterWikilinkCandidates(index, '', options)
    expect(outcome.items.map((item) => item.relPath)).toEqual([
      '笔记/设计.md',
      '笔记/设计文档.md',
      '设计.md',
      'A/设计.md',
      'B/设计.md',
    ])
    // 附件只在 `![[` 里出现；当前笔记自己不列
    expect(outcome.items.some((item) => item.relPath === '附件/图.png')).toBe(false)
    expect(outcome.items.some((item) => item.relPath === '笔记/测试.md')).toBe(false)
  })

  it('同名多篇全部在列表里，且名次与宿主 `pick_candidate` 一致', () => {
    const outcome = filterWikilinkCandidates(index, '设计', options)
    const notes = outcome.items.filter((item) => item.relPath.endsWith('设计.md'))
    expect(notes.map((item) => item.relPath)).toEqual([
      '笔记/设计.md', // 同目录优先
      '设计.md', // 同为同名冲突，先比路径长度，再比字典序
      'A/设计.md',
      'B/设计.md',
    ])
    // 第一项就是 `[[设计]]` 会解析到的那一篇（UI 上标「默认」）
    expect(outcome.items[0]?.relPath).toBe('笔记/设计.md')
    expect(outcome.items[0]?.preferred).toBe(true)
  })

  it('同名冲突时每一篇写进文档的目标都不同（都能选到自己那一篇）', () => {
    const outcome = filterWikilinkCandidates(index, '设计', options)
    const targets = outcome.items
      .filter((item) => item.relPath.endsWith('设计.md'))
      .map((item) => item.target)
    // 同目录那篇写裸名仍然解析到自己（宿主的"同目录优先"），其余写相对路径
    expect(targets).toEqual(['设计', '../设计', '../A/设计', '../B/设计'])
  })

  it('不冲突的笔记写裸名（`[[设计文档]]`，与 Obsidian 一致）', () => {
    const outcome = filterWikilinkCandidates(index, '设计文档', options)
    expect(outcome.items[0]?.target).toBe('设计文档')
  })

  it('`![[` 里附件也在列表里，且按裸文件名插入（全库同名兜底那条规则）', () => {
    const outcome = filterWikilinkCandidates(index, '图', {
      noteRelPath: '笔记/测试.md',
      embed: true,
    })
    expect(outcome.items.map((item) => item.relPath)).toContain('附件/图.png')
    const asset = outcome.items.find((item) => item.relPath === '附件/图.png')
    // 全库只有这一张 `图.png` → 裸名（`createAssetResolver` 的同名兜底会命中它）
    expect(asset?.target).toBe('图.png')
    expect(asset?.isNote).toBe(false)
  })

  it('同名冲突的附件写相对路径（裸名会落到别人的图上）', () => {
    const conflicted = buildWikilinkIndex(
      ['笔记/测试.md', '附件/图.png', '旧备份/图.png'].map((relPath) => makeEntry({ relPath })),
    )
    const outcome = filterWikilinkCandidates(conflicted, '图', {
      noteRelPath: '笔记/测试.md',
      embed: true,
    })
    expect(outcome.items.map((item) => [item.relPath, item.target])).toEqual([
      ['附件/图.png', '../附件/图.png'],
      ['旧备份/图.png', '../旧备份/图.png'],
    ])
  })

  it('同名冲突在列表里带得出提示（`同名 N`）', () => {
    const outcome = filterWikilinkCandidates(index, '设计', options)
    expect(outcome.items[0]?.conflicts).toBe(4)
  })

  it('路径子序列也能命中（层级低于文件名命中）', () => {
    const outcome = filterWikilinkCandidates(index, '笔记设', options)
    expect(outcome.items.map((item) => item.relPath)).toEqual([
      '笔记/设计.md',
      '笔记/设计文档.md',
    ])
  })
})

// ---------------------------------------------------------------------------
// 4. 真实装配：输入 `[[` → 弹层
// ---------------------------------------------------------------------------

describe('真实装配：输入 `[[` 弹出候选', () => {
  beforeEach(() => {
    pretendOpenNote('笔记/测试.md')
    setVault(['笔记/测试.md', '笔记/设计文档.md', '笔记/日报.md', '附件/图.png'])
  })

  it('敲出第二个 `[` 时弹层立刻出现（第一个 `[` 不弹）', () => {
    const view = mountEditor('正文', 2)
    typeText(view, '[')
    expect(panelOf(view)).toBeNull()

    typeText(view, '[')
    const panel = panelOf(view)
    expect(panel).not.toBeNull()
    // `role="listbox"` 挂在滚动容器上（页脚在它外面，保证 listbox 的子节点只有 option）
    expect(panel?.querySelector(`.${WIKI.list}`)?.getAttribute('role')).toBe('listbox')
    expect(view.state.doc.toString()).toBe('正文[[')
    // 同目录优先 + 路径更短 → `日报` 在前
    expect(optionNames(view)).toEqual(['日报', '设计文档'])
    // 附件不在 `[[` 的列表里
    expect(optionPaths(view)).toEqual(['笔记/日报.md', '笔记/设计文档.md'])
  })

  it('继续输入即过滤（子序列匹配，与命令面板同一手感）', () => {
    const view = mountEditor('正文', 2)
    typeText(view, '[[')
    expect(optionNames(view)).toEqual(['日报', '设计文档'])

    typeText(view, '日')
    expect(optionNames(view)).toEqual(['日报'])
  })

  it('子序列命中（打「设档」也能找到「设计文档」）', () => {
    const view = mountEditor('正文', 2)
    typeText(view, '[[')
    typeText(view, '设档')
    expect(optionNames(view)).toEqual(['设计文档'])
  })

  it('查询串排除掉全部候选时弹层关闭（不留空壳浮层挡住正文）', () => {
    const view = mountEditor('正文', 2)
    typeText(view, '[[')
    expect(panelOf(view)).not.toBeNull()

    typeText(view, 'zzz')
    expect(panelOf(view)).toBeNull()
    // 我们只是不弹，并不拦输入
    expect(view.state.doc.toString()).toBe('正文[[zzz')
  })

  it('`↑` `↓` 换选中项（循环），且始终只有一项 `aria-selected`', () => {
    const view = mountEditor('正文', 2)
    typeText(view, '[[')
    const names = optionNames(view)
    expect(names.length).toBeGreaterThan(1)
    expect(activeName(view)).toBe(names[0])

    expect(pressKey(view, 'ArrowDown')).toBe(true)
    expect(activeName(view)).toBe(names[1])
    expect(optionsOf(view).filter((o) => o.getAttribute('aria-selected') === 'true')).toHaveLength(
      1,
    )

    expect(pressKey(view, 'ArrowUp')).toBe(true)
    expect(activeName(view)).toBe(names[0])

    // 从第一项往上 = 绕到最后一项
    expect(pressKey(view, 'ArrowUp')).toBe(true)
    expect(activeName(view)).toBe(names[names.length - 1])
  })

  it('`aria-activedescendant` 指向当前项（焦点始终留在编辑器里）', () => {
    const view = mountEditor('正文', 2)
    typeText(view, '[[')
    const list = panelOf(view)?.querySelector(`.${WIKI.list}`)
    const active = optionsOf(view).find(
      (option) => option.getAttribute('aria-selected') === 'true',
    )
    expect(list?.getAttribute('aria-activedescendant')).toBe(active?.id)
    expect(active?.id).toBeTruthy()
    // 键盘可达：焦点没有被弹层拿走
    expect(view.dom.contains(document.activeElement) || document.activeElement === document.body).toBe(
      true,
    )
  })

  it('`↓` 之后 `Enter` 补全的是选中那一条，光标落在 `]]` 之前', () => {
    const view = mountEditor('正文', 2)
    typeText(view, '[[')
    pressKey(view, 'ArrowDown')
    expect(activeName(view)).toBe('设计文档')

    expect(pressKey(view, 'Enter')).toBe(true)

    const doc = view.state.doc.toString()
    expect(doc).toBe('正文[[设计文档]]')
    expect(view.state.selection.main.head).toBe(doc.indexOf(']]'))
    expect(panelOf(view)).toBeNull()
  })

  it('`Tab` 与 `Enter` 等价（弹层开着时）', () => {
    const view = mountEditor('正文', 2)
    typeText(view, '[[')
    expect(pressKey(view, 'Tab')).toBe(true)
    expect(view.state.doc.toString()).toBe('正文[[日报]]')
  })

  it('点击候选项也能确认', () => {
    const view = mountEditor('正文', 2)
    typeText(view, '[[')
    optionsOf(view)[1]?.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    )
    expect(view.state.doc.toString()).toBe('正文[[设计文档]]')
  })

  it('同名多篇都能选中（第三项写入的是它自己的相对路径）', () => {
    setVault(['笔记/测试.md', 'A/设计.md', 'B/设计.md', '笔记/设计.md'])
    const view = mountEditor('正文', 2)
    typeText(view, '[[')
    typeText(view, '设计')
    expect(optionPaths(view)).toEqual(['笔记/设计.md', 'A/设计.md', 'B/设计.md'])
    // 列表里给出「同名 3」与「默认」提示
    expect(panelOf(view)?.textContent).toContain('同名 3')

    pressKey(view, 'ArrowDown')
    pressKey(view, 'ArrowDown')
    expect(activeName(view)).toBe('设计')
    pressKey(view, 'Enter')
    expect(view.state.doc.toString()).toBe('正文[[../B/设计]]')
  })

  it('`![[` 之后能补附件（非 Markdown 文件出现在列表里）', () => {
    const view = mountEditor('正文', 2)
    typeChars(view, '![')
    typeChars(view, '[')
    expect(optionPaths(view)).toContain('附件/图.png')

    typeText(view, '图')
    // 附件显示**完整文件名**（扩展名是它的身份：`isImageAssetTarget` 就靠它分流）
    expect(optionNames(view)).toEqual(['图.png'])
    pressKey(view, 'Enter')
    expect(view.state.doc.toString()).toBe('正文![[图.png]]')
  })

  it('`![[设计|别名` 里补全：不重复插入 `]]`，光标落在别名末尾', () => {
    const view = mountEditor('正文', 2)
    typeChars(view, '![[设计|别名')
    expect(panelOf(view)).not.toBeNull()

    pressKey(view, 'Enter')
    const doc = view.state.doc.toString()
    expect(doc).toBe('正文![[设计文档|别名]]')
    expect(doc.match(/\]\]/gu)).toHaveLength(1)
    expect(view.state.selection.main.head).toBe(doc.indexOf(']]'))
  })
})

// ---------------------------------------------------------------------------
// 5. 关闭 / 手动唤出 / 不污染文档与历史
// ---------------------------------------------------------------------------

describe('关闭与手动唤出', () => {
  beforeEach(() => {
    pretendOpenNote('笔记/测试.md')
    setVault(['笔记/测试.md', '笔记/设计文档.md'])
  })

  it('`Esc` 关闭弹层且一个字符都不改', () => {
    const view = mountEditor('正文', 2)
    typeText(view, '[[')
    const before = view.state.doc.toString()
    expect(panelOf(view)).not.toBeNull()

    expect(pressKey(view, 'Escape')).toBe(true)
    expect(panelOf(view)).toBeNull()
    expect(view.state.doc.toString()).toBe(before)
  })

  it('弹层开开关关不会往撤销历史里塞东西（一次撤销直接回到最初）', () => {
    const view = mountEditor('甲', 1)
    typeText(view, '[')
    typeText(view, '[')
    expect(panelOf(view)).not.toBeNull()
    pressKey(view, 'ArrowDown')
    pressKey(view, 'Escape')
    expect(panelOf(view)).toBeNull()

    undo(view)
    expect(view.state.doc.toString()).toBe('甲')
  })

  it('`Ctrl+Space` 手动唤出（光标停在已有的 `[[设计]]` 里时）', () => {
    const doc = '见 [[设计]] 吧'
    const view = mountEditor(doc, at(doc, '设计'))
    expect(panelOf(view)).toBeNull() // 只是把光标放进链接：不该自动弹

    expect(pressCtrlSpace(view)).toBe(true)
    expect(optionNames(view)).toEqual(['设计文档'])
  })

  it('`Ctrl+Space` 在代码块 / frontmatter 里同样不弹（也不吞键）', () => {
    const code = '```\n[[设计\n```'
    const codeView = mountEditor(code, at(code, '设计') + 2)
    expect(pressCtrlSpace(codeView)).toBe(false)
    expect(panelOf(codeView)).toBeNull()

    const front = '---\ntags: [[设计\n---\n'
    const frontView = mountEditor(front, at(front, '设计') + 2)
    expect(pressCtrlSpace(frontView)).toBe(false)
    expect(panelOf(frontView)).toBeNull()
  })

  it('弹层关着时 `Enter` / `Tab` 的既有语义一概不受影响（列表续行 / 缩进）', () => {
    const view = mountEditor('- 甲', 3)
    expect(pressKey(view, 'Enter')).toBe(true)
    expect(view.state.doc.toString()).toBe('- 甲\n- ')
    expect(pressKey(view, 'Tab')).toBe(true)
    expect(view.state.doc.toString()).toBe('- 甲\n    - ')
  })
})

// ---------------------------------------------------------------------------
// 6. 不该弹的地方（真实装配，逐条钉死）
// ---------------------------------------------------------------------------

describe('不该弹的地方（真实装配）', () => {
  beforeEach(() => {
    pretendOpenNote('笔记/测试.md')
    setVault(['笔记/测试.md', '笔记/设计文档.md'])
  })

  it('围栏代码块里不弹', () => {
    const doc = '```\n甲\n```'
    const view = mountEditor(doc, at(doc, '甲') + 1)
    typeText(view, '[[')
    expect(panelOf(view)).toBeNull()
    expect(view.state.doc.toString()).toBe('```\n甲[[\n```')
  })

  it('行内代码里不弹', () => {
    const doc = '前 `代码` 后'
    const view = mountEditor(doc, at(doc, '码'))
    typeText(view, '[[')
    expect(panelOf(view)).toBeNull()
  })

  it('frontmatter 里不弹', () => {
    const doc = '---\ntags: 甲\n---\n\n正文'
    const view = mountEditor(doc, at(doc, '甲') + 1)
    typeText(view, '[[')
    expect(panelOf(view)).toBeNull()
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
    // 只给 changes、不给 selection：让 CodeMirror 把两个光标各自映射过去。
    // （`typeText` 会显式设定选区，那会把多光标压成一个 —— 那样测的就不是多光标了）
    view.dispatch({ changes: { from: 0, insert: '[[' }, userEvent: 'input.type' })
    expect(view.state.selection.ranges).toHaveLength(2)
    expect(view.state.doc.toString()).toBe('[[甲\n乙')
    expect(panelOf(view)).toBeNull()
  })

  it('正文里照常弹（对照组，证明上面几条不是"功能没装"）', () => {
    const view = mountEditor('正文', 2)
    typeText(view, '[[')
    expect(panelOf(view)).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 7. 与所见即所得共存 / 索引重建时机
// ---------------------------------------------------------------------------

describe('与所见即所得（Live Preview）共存', () => {
  beforeEach(() => {
    pretendOpenNote('笔记/测试.md')
    setVault(['笔记/测试.md', '设计.md'])
  })

  it('弹层开着时 `[[ ]]` 标记保持可见（用户正在编辑它）', () => {
    const view = mountEditor('[[设计]]', 2)
    expect(pressCtrlSpace(view)).toBe(true)
    expect(panelOf(view)).not.toBeNull()
    // `[[` / `]]` 都是原样的文本：没有被任何 replace 装饰吃掉
    expect(contentText(view)).toBe('[[设计]]')
  })

  it('光标离开链接（弹层已关）之后标记才隐藏 —— 两条规则天然互斥', () => {
    const doc = '[[设计]]\n\n尾巴'
    const view = mountEditor(doc, doc.length)
    expect(panelOf(view)).toBeNull()
    expect(contentText(view)).toContain('设计')
    expect(contentText(view)).not.toContain('[[')
  })
})

describe('索引重建时机', () => {
  beforeEach(() => {
    pretendOpenNote('笔记/测试.md')
    setVault(['笔记/测试.md', '笔记/设计文档.md', '笔记/日报.md'])
  })

  it('连敲多个字符只建一次索引（按键路径上绝不重建整张表）', () => {
    const view = mountEditor('正文', 2)
    expect(completeTesting.buildCount()).toBe(0) // 还没人敲 `[[`

    typeText(view, '[[')
    expect(completeTesting.buildCount()).toBe(1)

    typeText(view, '设')
    typeText(view, '计')
    pressKey(view, 'ArrowDown')
    pressKey(view, 'ArrowUp')
    expect(completeTesting.buildCount()).toBe(1)
  })

  it('只有条目表换新数组之后才重建（Vault 变化 ⇒ 一次）', () => {
    const view = mountEditor('正文', 2)
    typeText(view, '[[')
    expect(completeTesting.buildCount()).toBe(1)

    setVault(['笔记/测试.md', '笔记/设计文档.md', '笔记/日报.md', '笔记/新的一篇.md'])
    typeText(view, '新的')
    expect(completeTesting.buildCount()).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 8. 样式契约（类名 ↔ CSS 规则，与 live-preview 的同一套约定）
// ---------------------------------------------------------------------------

describe('样式契约', () => {
  it('弹层是绝对定位的兄弟节点；列表自己滚动，页脚留得住', () => {
    expect(wikiCompleteThemeSpec['.mn-wiki-complete']?.position).toBe('absolute')
    expect(wikiCompleteThemeSpec['.mn-wiki-complete']?.zIndex).toBe('100')
    expect(wikiCompleteThemeSpec['.mn-wiki-complete__list']?.maxHeight).toBe('13.5rem')
    expect(wikiCompleteThemeSpec['.mn-wiki-complete__list']?.overflowY).toBe('auto')
    // 路径是辅助信息：可省略号截断，不许把名字挤没
    expect(wikiCompleteThemeSpec['.mn-wiki-complete__path']?.textOverflow).toBe('ellipsis')
  })
})
