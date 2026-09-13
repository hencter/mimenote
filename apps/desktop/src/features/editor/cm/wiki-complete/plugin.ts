/**
 * `[[` 笔记补全的 ViewPlugin：弹层、键位、插入。
 *
 * ## 交互一览
 * | 触发 | 行为 |
 * | --- | --- |
 * | 正文里敲出第二个 `[`（形成 `[[` / `![[`） | 立刻列出当前 Vault 的候选 |
 * | 继续输入 | 用 `[[` 之后已经输入的部分过滤（子序列匹配，与命令面板同一手感） |
 * | `↑` `↓` | 换一条（循环） |
 * | `Enter` / `Tab` | 确认：插入目标文本，缺 `]]` 就补上，光标落到 `]]` 之前 |
 * | `Esc` | 关闭，**不改文档** |
 * | `Ctrl+Space` | 手动唤出（在代码块 / 行内代码 / frontmatter 里同样不弹） |
 *
 * ## 键位的优先级关系
 * 键位走 `Prec.highest`，比 `setup.ts` 里那层 `Prec.high`（列表输入层 `list-input.ts` +
 * `markdownKeymap`）更靠前，**但每个命令在弹层关闭时一律返回 `false`** ——
 * 于是"弹层开着"这件事本身就成了优先级判据，Tab/Enter/Escape 在弹层关闭时的既有语义
 * （列表缩进、列表续行、关闭搜索面板……）一个都没变。刻意不用 `Prec.highest` 去抢
 * `Backspace`、不用 `domEventHandlers` 去抢按键：那两条路都会在弹层关着的时候也留下痕迹。
 *
 * ## 与所见即所得（Live Preview）共存
 * `[[双链]]` 的标记隐藏规则是"**选区与整段链接相交就整段露出原文**"（`build.ts` 的
 * `selectionTouches`），而弹层只在"光标正写在 `[[…` 里面"时才存在 —— 这两个条件天然互斥，
 * 于是**不需要任何额外处理**：弹层开着时 `[[` 一定是可见的（用户正在编辑它），
 * 光标一旦离开，弹层先关、标记随后才隐藏。`![[图.png]]` 同理：图片 widget 的
 * `emitImage` 里就写着"光标在这一行 → 露原文"。
 * 唯一的纪律是弹层不能进 `.cm-content`（会被当成文档内容参与排版与测量），
 * 所以它挂在 `.cm-editor` 下当兄弟节点（见 `theme.ts`）。
 *
 * ## 副作用可逆
 * 弹层是 `ViewPlugin` 的成员：`destroy()` 里摘掉 DOM，键位随扩展一起卸载，
 * 样式随 `EditorView.theme` 一起卸载。**刻意不订阅任何 store** ——
 * 候选索引是"每次要用时现读 `useVaultStore.getState().entries`"，
 * 没有订阅就没有需要解除的订阅（architecture.md §2 第 6 条）。
 */

import { Prec, type EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  ViewPlugin,
  keymap,
  type Command,
  type KeyBinding,
  type PluginValue,
  type ViewUpdate,
} from '@codemirror/view'

import type { EntryMeta } from '@/ipc/types'
import { useNoteStore } from '@/state/note-store'
import { useVaultStore } from '@/state/vault-store'

import {
  buildWikilinkIndex,
  filterWikilinkCandidates,
  type WikilinkCandidate,
  type WikilinkIndex,
} from './candidates'
import { completionEdit, wikilinkContextAt, type WikilinkCompletionContext } from './context'
import { WIKI, wikiCompleteTheme } from './theme'

// ---------------------------------------------------------------------------
// 索引缓存
// ---------------------------------------------------------------------------

let cachedEntries: readonly EntryMeta[] | null = null
let cachedIndex: WikilinkIndex | null = null
let buildCount = 0

/**
 * 取当前条目表对应的补全索引。
 *
 * **按数组身份缓存**：`vault-store` 的每个写动作（打开/重扫/新建/删除/改名/落附件）
 * 都会换一个新数组，其余时候 `entries` 引用不变。于是"重建整张索引"严格发生在
 * Vault 数据真的变了之后，而**绝不会**发生在按键路径上 —— 这正是
 * `live-preview/plugin.ts` 缓存 `createAssetResolver` 的同一套做法。
 *
 * 首建是**惰性**的（第一次真的有人敲 `[[` 时才算）：整场都不写双链的用户不该为它付钱。
 * 1 万条时的构建耗时见 `tests/editor-wikilink-complete-perf.test.ts`。
 */
export function wikilinkIndexFor(entries: readonly EntryMeta[]): WikilinkIndex {
  if (cachedEntries !== entries || cachedIndex === null) {
    cachedIndex = buildWikilinkIndex(entries)
    cachedEntries = entries
    buildCount += 1
  }
  return cachedIndex
}

// ---------------------------------------------------------------------------
// 触发判定
// ---------------------------------------------------------------------------

/** `[[` 的输入是否**刚刚发生**（而不是"光标碰巧停在某个 `[[` 里"）。 */
function isTrigger(update: ViewUpdate): boolean {
  if (!update.docChanged) return false
  if (update.state.selection.ranges.length !== 1) return false
  const pos = update.state.selection.main.head

  let triggered = false
  update.changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
    if (triggered) return
    // 光标必须紧跟在这次插入的末尾：把 `[[` 粘到别处（或撤回）都不该弹
    if (fromB + inserted.length !== pos) return
    if (!inserted.toString().endsWith('[')) return
    if (update.state.sliceDoc(Math.max(0, pos - 2), pos) !== '[[') return
    triggered = true
  })
  return triggered
}

/**
 * 这次变更是不是"整篇替换"（切换笔记 / 从磁盘重新加载）。
 *
 * 编辑器实例不会因为换文档而重建（`MarkdownEditor.tsx` 只替换文本），
 * 所以"卸载即清理"在这里不够用：弹层必须自己认出"这已经是另一篇文档了"。
 * 判据取"变更覆盖了整个旧文档"，比订阅 `note-store` 便宜，也不用管订阅的生命周期。
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

class WikilinkComplete implements PluginValue {
  private panel: HTMLElement | null = null
  private list: HTMLElement | null = null
  private options: HTMLElement[] = []
  private items: WikilinkCandidate[] = []
  private total = 0
  private active = 0
  private context: WikilinkCompletionContext | null = null
  private readonly panelId: string

  constructor(private readonly view: EditorView) {
    this.panelId = `mn-wiki-complete-${(panelSeq += 1)}`
  }

  /** 弹层是否开着（键位命令的判据）。 */
  isOpen(): boolean {
    return this.panel !== null
  }

  update(update: ViewUpdate): void {
    if (this.panel === null) {
      if (isTrigger(update)) this.refresh(update.state, true)
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
    // 只动选区（点别处、按方向键）：还在同一个链接里就留着，出去了就关
    if (update.selectionSet) {
      this.refresh(update.state, false)
      return
    }
    // 焦点离开编辑器（点了文件树、状态栏、别的面板）：弹层留着就是一块飘在界面上的残留
    // （点弹层自己不会走到这里：候选项的 mousedown 已经 `preventDefault`，焦点不会被抢走）
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

  /** `Ctrl+Space`：在光标处手动唤出。不在 `[[` 上下文里时返回 `false`（不吃键）。 */
  openAtCursor(): boolean {
    const state = this.view.state
    const range = state.selection.main
    if (state.selection.ranges.length !== 1 || !range.empty) return false
    if (wikilinkContextAt(state, range.head) === null) return false
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
    const edit = completionEdit(context, item.target)
    // 先关再改：`dispatch` 会同步跑一遍 update，此时弹层必须已经不在了
    this.close()
    this.view.dispatch({
      changes: edit.changes,
      selection: edit.selection,
      scrollIntoView: true,
      // `input.complete`：与相邻的 `input.type` 合成一次撤销步骤（一次 Ctrl+Z 撤掉
      // "敲 `[[` + 补全"这一整个动作），与 `image-input.ts` 用 `input.paste` 是同一套理由
      userEvent: 'input.complete',
    })
    this.view.focus()
  }

  /** 重算候选并渲染。`resetActive`：本次是不是"用户又敲了一个字"。 */
  private refresh(state: EditorState, resetActive: boolean): void {
    const range = state.selection.main
    // 多光标：一次确认只能改主光标那一处，其余几处会留下半截 `[[`，所以干脆不弹
    if (state.selection.ranges.length !== 1 || !range.empty) {
      this.close()
      return
    }
    const context = wikilinkContextAt(state, range.head)
    if (context === null) {
      this.close()
      return
    }

    const index = wikilinkIndexFor(useVaultStore.getState().entries)
    const outcome = filterWikilinkCandidates(index, context.query, {
      noteRelPath: useNoteStore.getState().doc?.relPath ?? null,
      embed: context.embed,
    })
    // 一条都没有（查询串已经排除了所有候选）：关掉，不要留一个空壳浮层挡住正文。
    // 这时 Enter 会落回列表/换行的既有语义，用户不会"按了回车却什么都没发生"
    if (outcome.items.length === 0) {
      this.close()
      return
    }

    this.context = context
    this.items = outcome.items
    this.total = outcome.total
    if (resetActive || this.active >= this.items.length) this.active = 0
    this.render()
    this.reposition()
  }

  private close(): void {
    this.panel?.remove()
    this.panel = null
    this.list = null
    this.options = []
    this.items = []
    this.total = 0
    this.active = 0
    this.context = null
  }

  private render(): void {
    const panel = this.ensurePanel()
    const list = this.list
    if (list === null) return
    list.textContent = ''
    this.options = []

    for (const [index, item] of this.items.entries()) {
      const option = document.createElement('div')
      option.className = WIKI.item
      option.id = `${this.panelId}-option-${index}`
      option.setAttribute('role', 'option')
      option.setAttribute('title', item.relPath)
      // `mousedown` 而不是 `click`：`click` 会先让面板抢走焦点，
      // 编辑器一失焦，Live Preview 的"光标所在处露出原文"就会当场失效
      option.addEventListener('mousedown', (event) => {
        event.preventDefault()
        this.accept(index)
      })
      appendName(option, item)
      option.append(text(WIKI.path, item.displayPath))
      if (item.conflicts > 1) option.append(text(WIKI.badge, `同名 ${item.conflicts}`))
      // 「默认」只在真的有歧义时才标：不冲突的笔记直接写裸名就行，多说一句只是噪音
      if (item.preferred && item.conflicts > 1) option.append(text(WIKI.badge, '默认'))
      list.append(option)
      this.options.push(option)
    }

    if (this.total > this.items.length) {
      panel.append(
        text(WIKI.footer, `还有 ${this.total - this.items.length} 条，继续输入以缩小范围`),
      )
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
      option.classList.toggle(WIKI.itemActive, selected)
    }
    const active = this.options[this.active]
    if (active !== undefined) {
      list.setAttribute('aria-activedescendant', active.id)
      // jsdom 没有布局，`scrollIntoView` 有无实现都无所谓——所以不做存在性判断以外的假设
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
      panel.className = WIKI.panel
      panel.id = this.panelId
      this.view.dom.append(panel)
      this.panel = panel
    }
    const list = document.createElement('div')
    list.className = WIKI.list
    // 弹层对屏幕阅读器就是一个"键盘操作的下拉列表"：焦点始终在编辑器上，
    // 当前项通过 `aria-activedescendant` 暴露（这就是"焦点留在输入框"的列表模式）
    list.setAttribute('role', 'listbox')
    list.setAttribute('aria-label', '笔记补全')
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
    // 右边不出界：长路径的弹层比光标右侧的空白宽时，往左让（偏移量在 jsdom 里是 0，
    // 那一档自然退化成"贴左边"，与原来一致）
    const maxLeft = Math.max(0, frame.width - panel.offsetWidth)
    const left = Math.min(Math.max(0, coords.left - frame.left), maxLeft)
    panel.style.left = `${Math.round(left)}px`
    panel.style.top = `${Math.round(Math.max(0, coords.bottom - frame.top))}px`
  }
}

const wikilinkCompletePlugin = ViewPlugin.fromClass(WikilinkComplete)

/** 建一个带类名的行内元素。 */
function text(className: string, content: string): HTMLElement {
  const element = document.createElement('span')
  element.className = className
  element.textContent = content
  return element
}

/** 列表主文本 + 命中字符高亮。 */
function appendName(option: HTMLElement, item: WikilinkCandidate): void {
  const name = text(WIKI.name, '')
  const indices = item.indices
  const lower = item.name.toLowerCase()
  // 下标是按小写串算的：极少数 Unicode 字符（`İ`）小写化后长度会变，那样下标就错位了。
  // 宁可不加粗，也不能把标记打在错误的字符上（与 `palette/match.ts` 的取舍一致）
  if (indices.length === 0 || lower.length !== item.name.length) {
    name.textContent = item.name
    option.append(name)
    return
  }
  const marked = new Set(indices)
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
    name.append(text(WIKI.highlight, char))
  }
  flush()
  option.append(name)
}

// ---------------------------------------------------------------------------
// 键位
// ---------------------------------------------------------------------------

/** 只在弹层开着时生效：关闭时一律 `false`，让按键原样落到既有的处理器上。 */
function withPanel(view: EditorView, action: (panel: WikilinkComplete) => void): boolean {
  const panel = view.plugin(wikilinkCompletePlugin)
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

/** `Ctrl+Space`：手动唤出。不在 `[[` 上下文里时返回 `false`（不吞键、也不弹）。 */
const openManually: Command = (view) => {
  if (view.composing) return false
  const panel = view.plugin(wikilinkCompletePlugin)
  if (panel === null) return false
  return panel.openAtCursor()
}

/** 弹层的键位（顺序即同一按键的优先级）。 */
export const wikiCompleteKeymap: readonly KeyBinding[] = [
  { key: 'ArrowDown', run: moveDown },
  { key: 'ArrowUp', run: moveUp },
  { key: 'Enter', run: acceptCompletion },
  { key: 'Tab', run: acceptCompletion },
  { key: 'Escape', run: dismissCompletion },
  { key: 'Ctrl-Space', run: openManually },
]

/** 补全扩展三件套：样式 + 弹层插件 + `Prec.highest` 键位（见模块文档）。 */
export function wikiCompleteExtensions(): Extension[] {
  return [wikiCompleteTheme, wikilinkCompletePlugin, Prec.highest(keymap.of([...wikiCompleteKeymap]))]
}

/**
 * 给测试用的接缝：索引构建次数。
 *
 * "按键路径上绝不重建索引"是这一块唯一的性能承诺，而它只能靠**数构建次数**来钉死
 * （耗时在 CI 上会抖，次数不会）。
 */
export const __testing = {
  buildCount: (): number => buildCount,
  resetBuildCount: (): void => {
    buildCount = 0
  },
}
