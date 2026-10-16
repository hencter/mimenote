// @vitest-environment jsdom
/**
 * 把 URL 粘到**选中的文字**上 → 变成 Markdown 链接（线上真实行为，见 `cm/setup.ts` 里的说明）。
 *
 * 这个能力**不是我们写的**：`markdown()` 默认就装了 `@codemirror/lang-markdown` 的
 * `pasteURLAsLink`（该选项默认 `true`）。我们曾经手写过一份等价实现（`features/editor/url-paste.ts`），
 * 调试中发现两份实现会互相抢先、真实生效的始终是上游那份，因此把自写版删掉了 ——
 * 留下这个文件是为了**把上游的真实行为钉死**：它既然是我们对外宣传的输入体验之一，
 * 就得有测试守着；上游升级改了规则，这里会先红。
 *
 * 上游的规则（读的是 6.5.2 的实现）：
 * 1. 主选区非空；
 * 2. 剪贴板 `text/plain` 以 `https?://` / `mailto:` / `xmpp:` / `www.` 开头（`www.` 会补成 `https://`）；
 * 3. 选区在 Markdown 正文里（`markdownLanguage.isActiveAt`），且**不跨越语法节点**、
 *    也不落在行内代码/链接/图片/HTML 这类非纯文本节点里；
 * 4. 它**不设光标位置**：在选区两端各插一段（`[` 与 `](url)`），选区因此**仍然选中原来那几个字**。
 *    这不是遗漏 —— "包好了还选着"比"跳到链接后面"更利于接着调整链接文字。
 */

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'

import { createEditorExtensions } from '@/features/editor/cm/setup'

const views: EditorView[] = []

function mount(doc: string, from = 0, to = 0): EditorView {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, extensions: createEditorExtensions({}, true) }),
  })
  view.dispatch({ selection: { anchor: from, head: to } })
  views.push(view)
  return view
}

/**
 * 造一份"像真的"剪贴板载荷：jsdom 里既没有 `DataTransfer` 也没有可用的 `ClipboardEvent` 构造器，
 * 与 `editor-attachments.test.tsx` 用的是同一套替身（普通 `Event` + `defineProperty` 挂 `clipboardData`）。
 */
function paste(view: EditorView, text: string): void {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files: [],
      items: [],
      types: ['text/plain'],
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    },
  })
  view.contentDOM.dispatchEvent(event)
}

/** 当前选中的文字（上游不改选区，因此断言用"选中的是谁"比"光标在几"更能说明意图）。 */
function selected(view: EditorView): string {
  const range = view.state.selection.main
  return view.state.sliceDoc(range.from, range.to)
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  document.body.innerHTML = ''
})

describe('把 URL 粘到选中的文字上', () => {
  it('选中文字 + http(s) 地址 → 包成链接，且那几个字仍然选着', () => {
    const view = mount('参考 文档 结尾', 3, 5)
    paste(view, 'https://example.com/doc')

    expect(view.state.doc.toString()).toBe('参考 [文档](https://example.com/doc) 结尾')
    // 选区仍在「文档」上：包好之后接着改链接文字是常见动作
    expect(selected(view)).toBe('文档')
  })

  it('`www.` 开头会自动补成 https://', () => {
    const view = mount('参考 文档', 3, 5)
    paste(view, 'www.example.com/a')

    expect(view.state.doc.toString()).toBe('参考 [文档](https://www.example.com/a)')
  })

  it('`mailto:` 也算链接目标（写"发邮件给某某"时不必先手打尖括号）', () => {
    const view = mount('参考 某人', 3, 5)
    paste(view, 'mailto:a@example.com')

    expect(view.state.doc.toString()).toBe('参考 [某人](mailto:a@example.com)')
  })

  it('没有选区：地址原样插入，不包链接', () => {
    const view = mount('开头', 2, 2)
    paste(view, 'https://example.com')

    expect(view.state.doc.toString()).toBe('开头https://example.com')
    expect(view.state.doc.toString()).not.toContain('](')
  })

  it('粘的不是地址：走 CodeMirror 的默认粘贴（替换选区）', () => {
    const view = mount('参考 文档', 3, 5)
    paste(view, '一段普通的文字')

    expect(view.state.doc.toString()).toBe('参考 一段普通的文字')
    expect(view.state.doc.toString()).not.toContain('](')
  })

  it('带说明的文本（"见 https://…"）整段按普通文本替换，不猜用户意图', () => {
    const view = mount('参考 文档', 3, 5)
    paste(view, '见 https://example.com')

    expect(view.state.doc.toString()).toBe('参考 见 https://example.com')
    expect(view.state.doc.toString()).not.toContain('](')
  })

  it('选中的是行内代码：不加链接（代码里要的就是那串原始地址）', () => {
    // 选中 `文档` 两字本体（不含反引号）：若被包成链接，代码片段就被改坏了
    const view = mount('参考 `文档` 结尾', 4, 6)
    paste(view, 'https://example.com')

    // 上游的守卫放行 → 落到 CodeMirror 的默认粘贴：选区被地址替换，**没有**多出 `](…)`
    expect(view.state.doc.toString()).toBe('参考 `https://example.com` 结尾')
    expect(view.state.doc.toString()).not.toContain('](')
  })

  it('选区跨越语法节点：不加链接（否则会把加粗/链接切成两半）', () => {
    // 选区横跨 `**粗**` 的收尾星号：包成链接会破坏加粗结构
    const view = mount('前 **粗** 后', 4, 6)
    paste(view, 'https://example.com')

    // 同样落到默认粘贴（选区被替换），关键是**没有**把这段包成链接
    expect(view.state.doc.toString()).toBe('前 **https://example.com* 后')
    expect(view.state.doc.toString()).not.toContain('](')
  })
})
