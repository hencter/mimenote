/**
 * CodeMirror 6 扩展装配点。
 *
 * 这里是"编辑器可扩展"的落点（ADR-0005）：M4 的插件通过向
 * {@link createEditorExtensions} 的返回值追加 `Extension` 来增强编辑器。
 *
 * 两条与输入手感相关的约定：
 *
 * 1. **Tab 只在"我们理解的上下文"里被吃掉**：Tab / Shift+Tab 用来升降列表层级或插入缩进
 *    （见 `list-input.ts`），因此编辑器不再是无条件放行 Tab 的"纯阅读器"。
 *    代价是键盘用户不能靠 Tab 直接离开编辑器 —— 这是为了让"写列表"这件事成立而做的取舍，
 *    焦点仍可用 `Ctrl+K`、点击、`Ctrl+Shift+E` 等路径离开。纯文本行上的 Tab 只插入空白，
 *    不会改变任何结构，随时可以 `Ctrl+Z` 撤销。
 * 2. **Markdown 的按键交给两层**：我们自己的列表输入层（`list-input.ts`）在前，
 *    `@codemirror/lang-markdown` 的 `markdownKeymap` 在后兜底。`markdown()` 的
 *    `addKeymap` 因此显式关掉 —— 它默认会用 `Prec.high` 把 `markdownKeymap` 装进来
 *    （正是"我们想要的那一份"，但顺序不可控），这里改成自己装，顺序才看得见、说得清。
 */

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown'
import {
  bracketMatching,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state'
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'

import { mnEditorTheme, mnHighlightStyle } from './theme'
import { flashLineExtensions } from './flash-line'
import { imageInputExtensions } from '../image-input'
import {
  continueListOnEnter,
  deleteListMarkupBackward,
  indentOnTab,
  outdentOnShiftTab,
} from './list-input'
import { livePreviewExtensions } from './live-preview/plugin'
import { wikiCompleteExtensions } from './wiki-complete/plugin'

/** 允许运行时替换的扩展槽（明暗模式）。 */
export const appearanceCompartment = new Compartment()

/**
 * 允许运行时替换的扩展槽（Tab 宽度）。
 *
 * 为什么必须是 `Compartment` 而不是"重建编辑器"或"把宽度当 props 往下传"：
 * `EditorState.tabSize` 是一个 facet，它参与**光标列计算**（`countColumn` / `moveByChar`
 * 的列位置）与我们的缩进命令。设置页改了 Tab 宽度之后，如果重建 `EditorView`，
 * 光标位置、选区、撤销历史、滚动位置**全部丢失** —— 用户只是改了个显示宽度，
 * 却要付出"当前编辑状态清零"的代价。`Compartment.reconfigure` 只做一次
 * `StateEffect`，既把新 facet 值灌进去，又保留其他一切。
 */
export const tabSizeCompartment = new Compartment()

/**
 * Tab 宽度的兜底值。
 *
 * 生产路径上由 {@link createEditorExtensions} 的第三个参数提供（`MarkdownEditor.tsx`
 * 读 `useSettingsStore.tabWidth`），这里只是"没接线时"的默认：
 * 必须与 `state/settings-store.ts` 的 `DEFAULT_SETTINGS.tabWidth`、
 * 以及 `EditorState.tabSize` 自身的默认值（4）保持一致。
 * 刻意**不** import 那个 store —— 编辑器装配层不该依赖 zustand。
 */
export const DEFAULT_TAB_WIDTH = 4

export interface EditorCallbacks {
  /** 文档内容变化（每次输入都会调用，必须保持廉价：只写 store，不做 IO）。 */
  onDocChanged?: (text: string) => void
  /** 焦点变化。 */
  onFocusChanged?: (focused: boolean) => void
}

/**
 * Tab 宽度对应的扩展：光标列口径 + 缩进单位一起改。
 *
 * 为什么连 `indentUnit` 也要改：`indentUnit` 是"一次缩进插入多少个空白"的口径，
 * `markdownKeymap` 内部的 `normalizeIndent` 也会读它（值为 `"\t"` 时才会把缩进改写成制表符）。
 * 让它与 `tabSize` 同源，缩进宽度就只有一个真相来源。
 */
export function tabSizeExtensions(tabWidth: number): Extension {
  const width = Number.isFinite(tabWidth) && tabWidth > 0 ? Math.round(tabWidth) : DEFAULT_TAB_WIDTH
  return [EditorState.tabSize.of(width), indentUnit.of(' '.repeat(width))]
}

/**
 * 组装编辑器扩展。
 *
 * 顺序有讲究：
 * 1. Live Preview 放在**最后** —— 它的样式规则要能盖住基础主题的同权规则（同权重时后注册的胜出），
 *    且它的装饰插件依赖语法高亮/语言扩展已经装好（`syntaxTree` 才有东西可读）；
 * 2. `markdown()` 与列表输入 keymap 相邻，方便一眼看出"哪些键被我们接管、哪些交给上游"。
 */
export function createEditorExtensions(
  callbacks: EditorCallbacks,
  isDark: boolean,
  tabWidth: number = DEFAULT_TAB_WIDTH,
): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    crosshairCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    tabSizeCompartment.of(tabSizeExtensions(tabWidth)),
    // `addKeymap: false`：不装默认的那份 markdownKeymap，改由下面的 keymap 显式安排顺序
    markdown({ base: markdownLanguage, addKeymap: false }),
    /*
     * Markdown 输入层，`Prec.high`（与上游 `markdown()` 默认安装时的优先级一致，
     * 因此相对 `defaultKeymap` 的地位没有变化）。
     *
     * 同一个 keymap 里**从上到下**匹配，所以顺序就是分工：
     * 1. 我们的命令只在"列表项整行"这类明确场景里返回 `true`；
     * 2. 返回 `false` 时落到 `markdownKeymap` —— 光标在行中间拆分列表项、
     *    引用续 `>`、松散列表补空行、嵌套上下文，全部保持既有语义不变；
     * 3. 都返回 `false` 时才轮到 `defaultKeymap`（普通换行 / 普通退格）。
     */
    Prec.high(
      keymap.of([
        { key: 'Enter', run: continueListOnEnter },
        { key: 'Backspace', run: deleteListMarkupBackward },
        { key: 'Tab', run: indentOnTab },
        { key: 'Shift-Tab', run: outdentOnShiftTab },
        ...markdownKeymap,
      ]),
    ),
    syntaxHighlighting(mnHighlightStyle),
    mnEditorTheme,
    appearanceCompartment.of(EditorView.darkTheme.of(isDark)),
    EditorView.lineWrapping,
    // 所见即所得（Live Preview）：装饰层，不改文档、不换编辑器
    ...livePreviewExtensions(),
    // `[[` 笔记补全（ADR-0009 之后的写作手感补齐）：弹层是 ViewPlugin，键位是 Prec.highest ——
    // 但**只在弹层开着时**才吃 Enter/Tab/↑↓/Esc，关闭时一律返回 false（详细分工见该模块文档）
    ...wikiCompleteExtensions(),
    // 粘贴 / 拖入图片（ADR-0013）：走 `EditorView.domEventHandlers` —— 插件提供的处理器排在
    // CodeMirror 内置粘贴之前，返回 `true` 才吃掉事件，返回 `false` 时文本粘贴原样落到默认实现
    // （完整理由见 `image-input.ts` 的模块文档）
    ...imageInputExtensions(),
    // "跳到第 N 行"的短暂高亮（搜索结果 / 反向链接的落点）：同样是纯装饰，不改文档
    ...flashLineExtensions(),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        callbacks.onDocChanged?.(update.state.doc.toString())
      }
      if (update.focusChanged) {
        callbacks.onFocusChanged?.(update.view.hasFocus)
      }
    }),
  ]
}

/** 运行时切换明暗（不重建编辑器）。 */
export function setEditorAppearance(view: EditorView, isDark: boolean): void {
  view.dispatch({
    effects: appearanceCompartment.reconfigure(EditorView.darkTheme.of(isDark)),
  })
}

/**
 * 运行时切换 Tab 宽度（不重建编辑器）。
 *
 * 只重配置 {@link tabSizeCompartment}：文档、光标、选区、撤销历史、滚动位置都不变，
 * 变的是 `state.tabSize`（光标列口径）和缩进单位。
 * 值没变时直接跳过 —— 避免每次设置页重渲染都派发一次无意义的事务。
 */
export function setEditorTabSize(view: EditorView, tabWidth: number): void {
  const next = Number.isFinite(tabWidth) && tabWidth > 0 ? Math.round(tabWidth) : DEFAULT_TAB_WIDTH
  if (view.state.tabSize === next) return
  view.dispatch({ effects: tabSizeCompartment.reconfigure(tabSizeExtensions(next)) })
}

/** 用整篇文本替换编辑器内容（切换文件 / 重新加载时使用）。 */
export function replaceEditorText(view: EditorView, text: string): void {
  if (view.state.doc.toString() === text) return
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: Math.min(view.state.selection.main.anchor, text.length) },
    scrollIntoView: false,
  })
}
