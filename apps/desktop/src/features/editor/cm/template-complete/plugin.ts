/**
 * `@` 模板记号补全的 ViewPlugin：弹层、键位、插入。
 *
 * ## 与 `[[` 补全的关系（这是刻意的"第二个 trigger"，不是第二套交互）
 * | 关注点 | `[[` 补全（`wiki-complete`） | `@` 补全（这里） |
 * | --- | --- | --- |
 * | 触发 | 敲出第二个 `[` | 敲出 `@` |
 * | 候选来源 | `vault-store` 的条目表 | `builtins.ts` 那一张内建表 |
 * | 确认后插入 | 目标文本 + 补 `]]` | **展开值**（`@today` → `2026-10-12`） |
 * | 弹层样式/类名 | `wiki-complete/theme.ts` 的 `WIKI` | **同一份**（`theme.ts` 只做转出） |
 * | 键位与优先级 | `Prec.highest`，弹层关着一律 `false` | **同一套** |
 *
 * ## 交互一览
 * | 触发 | 行为 |
 * | --- | --- |
 * | 正文里敲出 `@`（左邻不是词内字符） | 列出全部内建记号，右侧是**展开后的真实值** |
 * | 继续输入 | 用 `@` 之后已经输入的名字过滤（子序列匹配，与命令面板同一手感） |
 * | `↑` `↓` | 换一条（循环） |
 * | `Enter` / `Tab` | 确认：把整条记号替换成展开值；`@prompt` 例外，插入字面记号 |
 * | `Esc` | 关闭，**不改文档** |
 * | `Ctrl+Space` | 手动唤出（代码块 / 行内代码 / `[[…` 里同样不弹） |
 *
 * ## 三个"确认那一刻才拿得到值"的记号
 * 候选右侧那一列是**真实值**，但有三处只能给占位说明（理由见 `expand.ts`）：
 * `@clipboard`（异步读，读不到就插空串 + 提示，设计 02 §6）、`@prompt`（插入字面记号，
 * 创建笔记时再问 —— 编辑器里弹输入框会打断写作）、`@uuid`（每次生成都不同）。
 * 三者的分支只在 `candidates.ts` 里分一次（`TemplateInsertSource`），这里按它取东西。
 *
 * ## 副作用可逆 / 不订阅 store
 * 与 `wiki-complete/plugin.ts` 同一套纪律：弹层是 `ViewPlugin` 的成员（`destroy()` 里摘掉
 * DOM），键位与样式随扩展装卸；**不订阅任何 store** —— 当前笔记路径与 Vault 名都是
 * "要用时现读"（`notePathOf` / `useVaultStore.getState()`），没有需要解除的订阅。
 *
 * ## 为什么不与 `[[` 弹层抢键
 * 两个插件都在 `Prec.highest` 上装了同一组键，但每个命令都在**自己的弹层关着时返回
 * `false`**，于是"弹层开着"本身就是优先级判据。两者不可能同时开着：光标在 `[[…` 里时
 * `templateContextAt` 直接返回 `null`（见 `context.ts`）。
 */

import { Prec, Transaction, type EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  ViewPlugin,
  keymap,
  type Command,
  type KeyBinding,
  type PluginValue,
  type ViewUpdate,
} from '@codemirror/view'

import { basename, displayName } from '@/domain/paths'
import type { TemplateSnapshot } from '@/domain/template/builtins'
import { randomUuidV4 } from '@/domain/template/expand'
import { readClipboardText } from '@/features/template/clipboard-text'
import { toast } from '@/state/toast-store'
import { useVaultStore } from '@/state/vault-store'

import { notePathOf } from '../note-path'
import { filterTemplateCandidates, type TemplateCandidate } from './candidates'
import { completionEdit, templateContextAt, type TemplateCompletionContext } from './context'
import { TEMPLATE, TEMPLATE_VALUE, templateCompleteTheme } from './theme'

// ---------------------------------------------------------------------------
// 触发判定
// ---------------------------------------------------------------------------

/** `@` 的输入是否**刚刚发生**（而不是"光标碰巧停在某个 `@` 记号里"）。 */
function isTrigger(update: ViewUpdate): boolean {
  if (!update.docChanged) return false
  if (update.state.selection.ranges.length !== 1) return false
  const pos = update.state.selection.main.head

  let triggered = false
  update.changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
    if (triggered) return
    // 光标必须紧跟在这次插入的末尾：把 `@today` 粘到别处（或撤回）都不该弹
    if (fromB + inserted.length !== pos) return
    if (!inserted.toString().endsWith('@')) return
    if (update.state.sliceDoc(Math.max(0, pos - 1), pos) !== '@') return
    // 左邻规则、`@@` 转义、代码上下文全部由判据本体判：`mail@` 不是触发点，
    // `@@`（第二个 `@`）也不是 —— 那是一个转义
    if (templateContextAt(update.state, pos) === null) return
    triggered = true
  })
  return triggered
}

/**
 * 这次编辑之后，光标是不是落在一个 `@` 记号的草稿里。
 *
 * 补上 `isTrigger` 够不到的三条路（与 `wiki-complete` 的 `editedInsideLink` 同一组理由）：
 * 粘贴 `@to` 后继续打字（事务以普通字符结尾）、输入法一次提交多个字符、
 * 点进已经写好的 `@today` 里改。
 */
function editedInsideToken(update: ViewUpdate): boolean {
  if (!update.docChanged) return false
  // 刚确认完一条候选（`input.complete`）：这次事务是补全的结果，不是新的编辑意图。
  // `@prompt` 插入的就是记号本身，不豁免的话光标停在 `@prompt` 末尾会当场再弹一次
  if (
    update.transactions.some(
      (transaction) => transaction.annotation(Transaction.userEvent) === 'input.complete',
    )
  ) {
    return false
  }
  if (update.state.selection.ranges.length !== 1) return false
  const range = update.state.selection.main
  if (!range.empty) return false
  return templateContextAt(update.state, range.head) !== null
}

/**
 * 这次变更是不是"整篇替换"（切换笔记 / 从磁盘重新加载）。
 *
 * 编辑器实例不因换文档而重建（`MarkdownEditor.tsx` 只替换文本），所以"卸载即清理"不够用：
 * 弹层必须自己认出"这已经是另一篇文档了"。判据取"变更覆盖了整个旧文档"，比订阅
 * `note-store` 便宜，也不用管订阅的生命周期（与 `wiki-complete` 同一做法）。
 */
function replacedWholeDoc(update: ViewUpdate): boolean {
  let whole = false
  for (const transaction of update.transactions) {
    if (!transaction.docChanged) continue
    const length = transaction.startState.doc.length
    if (length === 0) continue
    transaction.changes.iterChanges((fromA, toA) => {
      if (fromA === 0 && toA === length) whole = true
    })
  }
  return whole
}

// ---------------------------------------------------------------------------
// 弹层
// ---------------------------------------------------------------------------

let panelSeq = 0

class TemplateComplete implements PluginValue {
  private panel: HTMLElement | null = null
  private list: HTMLElement | null = null
  private options: HTMLElement[] = []
  private items: TemplateCandidate[] = []
  private active = 0
  private context: TemplateCompletionContext | null = null
  private readonly panelId: string

  constructor(private readonly view: EditorView) {
    this.panelId = `mn-template-complete-${(panelSeq += 1)}`
  }

  /** 弹层是否开着（键位命令的判据）。 */
  isOpen(): boolean {
    return this.panel !== null
  }

  update(update: ViewUpdate): void {
    if (this.panel === null) {
      // 触发条件 = "刚敲出 `@`" **或**"编辑后光标落在记号草稿里"（粘贴半截、输入法提交、
      // 点进旧记号里改）。纯光标移动不开：路过一个 `@today` 就弹比没有更烦；想手动唤出
      // 有 Ctrl+Space。整篇替换（切笔记/重载）不开 —— 打开笔记就弹推荐属于打扰
      if (isTrigger(update) || (editedInsideToken(update) && !replacedWholeDoc(update))) {
        this.refresh(update.state, true)
      }
      return
    }
    if (update.docChanged) {
      if (replacedWholeDoc(update)) {
        this.close()
        return
      }
      this.refresh(update.state, true)
      return
    }
    // 只动选区（点别处、按方向键）：还在同一条记号里就留着，出去了就关
    if (update.selectionSet) {
      this.refresh(update.state, false)
      return
    }
    // 焦点离开编辑器：弹层留着就是一块飘在界面上的残留
    // （点弹层自己不会走到这里：候选项的 mousedown 已经 `preventDefault`）
    if (update.focusChanged && !update.view.hasFocus) {
      this.close()
      return
    }
    // 滚动 / 重排：跟着光标重新定位（CodeMirror 不会替我们挪一个自己挂的节点）
    if (update.geometryChanged) this.reposition()
  }

  destroy(): void {
    this.close()
  }

  /** `Ctrl+Space`：在光标处手动唤出。不在 `@` 上下文里时返回 `false`（不吃键）。 */
  openAtCursor(): boolean {
    const state = this.view.state
    const range = state.selection.main
    if (state.selection.ranges.length !== 1 || !range.empty) return false
    if (templateContextAt(state, range.head) === null) return false
    this.refresh(state, true)
    return this.panel !== null
  }

  move(delta: number): void {
    if (this.items.length === 0) return
    this.active = (this.active + delta + this.items.length) % this.items.length
    this.syncActive()
  }

  dismiss(): void {
    this.close()
  }

  accept(index = this.active): void {
    const context = this.context
    const item = this.items[index]
    if (context === null || item === undefined) {
      this.close()
      return
    }
    // 剪贴板是异步的：先关弹层，读到之后再改文档（拿不到 → 空串 + 提示，§6）
    if (item.source === 'clipboard') {
      this.close()
      void readClipboardText().then((text) => {
        if (text === null || text === '') {
          toast.warn('剪贴板里没有可用的文本', '已插入空内容，可以手工粘贴')
        }
        this.applyEdit(context, text ?? '')
      })
      return
    }
    this.close()
    this.applyEdit(context, item.source === 'uuid' ? randomUuidV4() : item.insert)
  }

  /**
   * 派发一次替换。
   *
   * `input.complete` 是**语义标注**：这次改动是"确认了一条补全"，不是新的编辑意图 ——
   * `editedInsideToken` 据此豁免"选完又弹"（`@prompt` 插入的就是记号本身，不豁免会当场
   * 再弹一次）。与 `image-input.ts` 用 `input.paste` 是同一套理由。
   *
   * ⚠️ 它**不会**与前面敲字母的那些 `input.type` 合并成一次撤销：CodeMirror 的
   * `HistoryState.addChanges` 只把 `input.type` / `delete` 开头的 userEvent 与相邻事件合并
   * （装好的 `@codemirror/commands` 里写着 `joinableUserEvent = /^(input\.type|delete)($|\.)/`），
   * 所以"敲 `@today` → 确认 → 撤销一次"回到的是**展开值插入之前**（`@today` 还在），
   * 再撤一次才回到最初。这样"撤销"对用户是"取消这次补全"，而不是"把我刚敲的一整段抹掉"。
   * （`wiki-complete/plugin.ts` 的注释里写着"合成一次撤销步骤"，与实际实现不符 —— 这里
   * 不复制那个说法。）
   *
   * 派发前复核 `context.raw`：`@clipboard` 那条路是**异步**的，读到剪贴板时用户可能已经
   * 改了那几个字。位置对不上就不插 —— 宁可不插，也不能把值写到别的地方去。
   */
  private applyEdit(context: TemplateCompletionContext, insert: string): void {
    const state = this.view.state
    if (context.to > state.doc.length || state.sliceDoc(context.from, context.to) !== context.raw) {
      return
    }
    const edit = completionEdit(context, insert)
    this.view.dispatch({
      changes: edit.changes,
      selection: edit.selection,
      scrollIntoView: true,
      userEvent: 'input.complete',
    })
    this.view.focus()
  }

  /** 重算候选并渲染。`resetActive`：本次是不是"用户又敲了一个字"。 */
  private refresh(state: EditorState, resetActive: boolean): void {
    const range = state.selection.main
    // 多光标：一次确认只能改主光标那一处，其余几处会留下半截 `@`，所以干脆不弹
    if (state.selection.ranges.length !== 1 || !range.empty) {
      this.close()
      return
    }
    const context = templateContextAt(state, range.head)
    if (context === null) {
      this.close()
      return
    }

    const items = filterTemplateCandidates(context.query, context.argument, this.snapshot())
    // 一条都没有（查询串排除了全部记号）：关掉，不要留一个空壳浮层挡住正文。
    // 这时 Enter 落回换行的既有语义，用户不会"按了回车却什么都没发生"
    if (items.length === 0) {
      this.close()
      return
    }

    this.context = context
    this.items = items
    if (resetActive || this.active >= items.length) this.active = 0
    this.render()
    this.reposition()
  }

  /**
   * 候选右侧那些值的求值快照。
   *
   * "当前笔记"取 `notePathOf`（**这一格**的笔记，分栏时不是"当前文档"那一篇），
   * 标题按 ADR-0030 的 `displayName` 口径 —— 与模板展开器同一份判据（`expand.ts` 只消费
   * 调用方算好的值，不自己碰路径字符串）。
   */
  private snapshot(): TemplateSnapshot {
    const relPath = notePathOf(this.view)
    return {
      now: new Date(),
      title: relPath === null ? '' : displayName(relPath),
      filename: relPath === null ? '' : basename(relPath),
      path: relPath ?? '',
      vault: useVaultStore.getState().info?.name ?? '',
    }
  }

  private close(): void {
    this.panel?.remove()
    this.panel = null
    this.list = null
    this.options = []
    this.items = []
    this.active = 0
    this.context = null
  }

  private render(): void {
    // 页脚不需要（内建表只有 12 条，列表不可能被截断），所以这里只建壳、不接返回值
    this.ensurePanel()
    const list = this.list
    if (list === null) return
    list.textContent = ''
    this.options = []

    for (const [index, item] of this.items.entries()) {
      const option = document.createElement('div')
      option.className = TEMPLATE.item
      option.id = `${this.panelId}-option-${index}`
      option.setAttribute('role', 'option')
      option.setAttribute('title', item.summary)
      // `mousedown` 而不是 `click`：`click` 会先让面板抢走焦点，编辑器一失焦，
      // Live Preview 的"光标所在处露出原文"就会当场失效
      option.addEventListener('mousedown', (event) => {
        event.preventDefault()
        this.accept(index)
      })
      appendName(option, item)
      option.append(text(TEMPLATE_VALUE, item.value))
      // `@prompt` 插入的是**记号本身**（不是展开值）：不标出来用户会以为没生效
      if (item.source === 'literal-token') option.append(text(TEMPLATE.badge, '原样插入'))
      list.append(option)
      this.options.push(option)
    }

    this.syncActive()
  }

  /** 同步"当前高亮第几条"：`aria-selected`、类名、滚动。 */
  private syncActive(): void {
    const list = this.list
    if (list === null) return
    for (const [index, option] of this.options.entries()) {
      const selected = index === this.active
      option.setAttribute('aria-selected', selected ? 'true' : 'false')
      option.classList.toggle(TEMPLATE.itemActive, selected)
    }
    const active = this.options[this.active]
    if (active !== undefined) {
      list.setAttribute('aria-activedescendant', active.id)
      // jsdom 没有布局，`scrollIntoView` 有无实现都无所谓
      if (typeof active.scrollIntoView === 'function') {
        active.scrollIntoView({ block: 'nearest' })
      }
    }
  }

  private ensurePanel(): HTMLElement {
    if (this.panel !== null) {
      // 上一帧可能留了页脚：整段重建比精确增删更不容易漏
      this.panel.textContent = ''
    } else {
      const panel = document.createElement('div')
      panel.className = TEMPLATE.panel
      panel.id = this.panelId
      this.view.dom.append(panel)
      this.panel = panel
    }
    const list = document.createElement('div')
    list.className = TEMPLATE.list
    // 弹层对屏幕阅读器是一个"键盘操作的下拉列表"：焦点始终在编辑器上，
    // 当前项通过 `aria-activedescendant` 暴露（"焦点留在输入框"的列表模式）
    list.setAttribute('role', 'listbox')
    list.setAttribute('aria-label', '模板记号补全')
    this.panel.append(list)
    this.list = list
    return this.panel
  }

  /**
   * 把弹层放到光标下方。
   *
   * `coordsAtPos` 在没有真实排版的环境（jsdom、编辑器被隐藏）里拿不到坐标甚至可能抛异常 ——
   * 那只是"放不准"，绝不能让弹层消失或让编辑器崩掉，所以兜底到左上角并吞掉异常。
   */
  private reposition(): void {
    const panel = this.panel
    if (panel === null) return
    const pos = this.view.state.selection.main.head
    let coords: { left: number; bottom: number } | null = null
    try {
      const rect = this.view.coordsAtPos(pos)
      if (rect !== null) coords = { left: rect.left, bottom: rect.bottom }
    } catch {
      coords = null
    }
    if (coords === null) {
      panel.style.left = '0px'
      panel.style.top = '0px'
      return
    }
    const frame = this.view.dom.getBoundingClientRect()
    const maxLeft = Math.max(0, frame.width - panel.offsetWidth)
    const left = Math.min(Math.max(0, coords.left - frame.left), maxLeft)
    panel.style.left = `${Math.round(left)}px`
    panel.style.top = `${Math.round(Math.max(0, coords.bottom - frame.top))}px`
  }
}

const templateCompletePlugin = ViewPlugin.fromClass(TemplateComplete)

/** 建一个带类名的行内元素。 */
function text(className: string, content: string): HTMLElement {
  const element = document.createElement('span')
  element.className = className
  element.textContent = content
  return element
}

/**
 * 列表主文本（`@today`）+ 命中字符高亮。
 *
 * `@` 参与渲染但不参与匹配（候选的 `indices` 相对的是**不含 `@`** 的名字），
 * 所以高亮时下标要整体 +1 —— 直接拿名字的下标去标 `@today` 会把标记打在错位的字符上。
 */
function appendName(option: HTMLElement, item: TemplateCandidate): void {
  const name = text(TEMPLATE.name, '')
  name.append(document.createTextNode('@'))
  const lower = item.name.toLowerCase()
  // 下标是按小写串算的：极少数 Unicode 字符小写化后长度会变，那样下标就错位了。
  // 宁可不加粗，也不能把标记打在错误的字符上（与 `palette/match.ts` 的取舍一致）
  if (item.indices.length === 0 || lower.length !== item.name.length) {
    name.append(document.createTextNode(item.name))
    option.append(name)
    return
  }
  const marked = new Set(item.indices)
  let plain = ''
  const flush = (): void => {
    if (plain === '') return
    name.append(document.createTextNode(plain))
    plain = ''
  }
  for (let index = 0; index < item.name.length; index += 1) {
    const char = item.name[index] ?? ''
    if (!marked.has(index)) {
      plain += char
      continue
    }
    flush()
    name.append(text(TEMPLATE.highlight, char))
  }
  flush()
  option.append(name)
}

// ---------------------------------------------------------------------------
// 键位
// ---------------------------------------------------------------------------

/** 只在弹层开着时生效：关闭时一律 `false`，让按键原样落到既有的处理器上。 */
function withPanel(view: EditorView, action: (panel: TemplateComplete) => void): boolean {
  const panel = view.plugin(templateCompletePlugin)
  if (panel === null || !panel.isOpen()) return false
  // 输入法组合输入中：Enter / ↑↓ / Esc 都属于输入法（选词、翻页、取消），抢过来会把中日韩
  // 输入直接弄坏。这条守卫只影响"弹层开着时"，组合输入结束后的按键照常
  if (view.composing) return false
  action(panel)
  return true
}

const moveDown: Command = (view) => withPanel(view, (panel) => panel.move(1))
const moveUp: Command = (view) => withPanel(view, (panel) => panel.move(-1))
const acceptCompletion: Command = (view) => withPanel(view, (panel) => panel.accept())
const dismissCompletion: Command = (view) => withPanel(view, (panel) => panel.dismiss())

/** `Ctrl+Space`：手动唤出。不在 `@` 上下文里时返回 `false`（不吞键、也不弹）。 */
const openManually: Command = (view) => {
  if (view.composing) return false
  const panel = view.plugin(templateCompletePlugin)
  if (panel === null) return false
  return panel.openAtCursor()
}

/** 弹层的键位（顺序即同一按键的优先级；与 `[[` 补全逐字同构）。 */
export const templateCompleteKeymap: readonly KeyBinding[] = [
  { key: 'ArrowDown', run: moveDown },
  { key: 'ArrowUp', run: moveUp },
  { key: 'Enter', run: acceptCompletion },
  { key: 'Tab', run: acceptCompletion },
  { key: 'Escape', run: dismissCompletion },
  { key: 'Ctrl-Space', run: openManually },
]

/** 补全扩展三件套：样式（复用 `[[` 那一份）+ 弹层插件 + `Prec.highest` 键位。 */
export function templateCompleteExtensions(): Extension[] {
  return [
    templateCompleteTheme,
    templateCompletePlugin,
    Prec.highest(keymap.of([...templateCompleteKeymap])),
  ]
}
