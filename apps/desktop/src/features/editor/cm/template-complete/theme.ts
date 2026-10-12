/**
 * `@` 补全弹层的类名与样式：**直接复用 `[[` 补全那一套**。
 *
 * 为什么不新造一套：两个弹层在交互上完全同构 —— 同样的键位（↑↓/Enter/Tab/Esc/Ctrl+Space）、
 * 同样的 `role="listbox"` + `aria-activedescendant`、同样"挂在 `.cm-editor` 下的绝对定位
 * 兄弟节点"（见 `wiki-complete/theme.ts` 与 `plugin.ts` 的模块文档）。用户不需要学第二套
 * 外观，仓库的样式纪律也要求"类名只在一处定义、随扩展装配随扩展卸载"。
 *
 * `templateCompleteTheme` 就是那一份 `EditorView.theme` 扩展本身：CodeMirror 按**对象身份**
 * 收集样式模块，两份扩展装配同一份主题不会重复注入 CSS；而如果只 import 类名不带上主题，
 * 这个扩展单独装配（比如测试里只装模板补全）就会没有样式。
 */

import { WIKI, wikiCompleteTheme } from '../wiki-complete/theme'

/** 模板补全沿用的类名契约（与 `[[` 补全同一份，含 `path` 那一列的"辅助信息"样式）。 */
export const TEMPLATE = WIKI

/**
 * 候选**右侧**那一列（展开后的真实值）复用的类名。
 *
 * 单独起一个名字是为了在插件里读起来是"这一格显示的是值"：样式却仍然是 `__path` 那一档
 * （淡色、`min-width: 0`、省略号截断）—— 它的语义本来就是"辅助信息，不要挤掉主文本"。
 */
export const TEMPLATE_VALUE = WIKI.path

/** 弹层主题（= `[[` 补全那一份，见模块头）。 */
export const templateCompleteTheme = wikiCompleteTheme
