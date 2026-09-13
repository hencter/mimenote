/**
 * 把设置页的字号与 Tab 宽度落到 DOM 上（可逆副作用）。
 *
 * **为什么字号走 CSS 变量而不是重渲染组件树**：
 * `--mn-font-size-editor` 同时被编辑器（`features/editor/cm/theme.ts` 里
 * `EditorView.theme` 的 `&{fontSize}`）与预览（`styles/app.css` 的 `.mn-preview__body`）
 * 引用，`--mn-font-size-ui` 被 `body` 引用。写变量 = 浏览器只做一次样式重算，
 * CodeMirror 的实例、React 组件树、撤销历史、光标位置**全都不用动**；
 * 反过来"把字号当 props 往下传"会重建编辑器、丢掉正在编辑的状态 —— 这是纯亏。
 *
 * **为什么要两条路径一起写**（内联 + `!important` 样式表）：
 * `theme/apply.ts` 的 `applyTheme()` 会把主题 JSON 里的**全部**令牌一次性写进
 * `<html>` 的内联样式，其中就包括这两个字号令牌。只写内联的话，用户每换一次主题
 * （`Ctrl+Alt+T` / 状态栏下拉 / 设置页里选主题）字号就被主题值覆盖回去 ——
 * 一个"设置悄悄失效"的 bug。所以：
 *   1. 写内联 —— 立即可见，`getComputedStyle` 与开发者工具都能看到，也是最小改动；
 *   2. 注入一条 `!important` 的作者样式表规则 —— 作者样式表里的 important 声明
 *      **优先于内联的普通声明**，主题再怎么整批重写内联也冲不掉用户的选择。
 * 卸载（{@link clearFontOverrides}）时两处一起撤掉，字号回落到主题令牌。
 *
 * Tab 宽度用 `--mn-tab-size`：它是本功能私有的变量（主题令牌里没有），
 * 不会有被 `applyTheme` 覆盖的问题，因此只写内联 + `settings.css` 里的一条 `tab-size` 规则。
 */

/** 注入的 `<style>` 的 id（重复应用时复用同一个元素，不会越积越多）。 */
const STYLE_ELEMENT_ID = 'mn-settings-font-overrides'

export const UI_FONT_SIZE_PROPERTY = '--mn-font-size-ui'
export const EDITOR_FONT_SIZE_PROPERTY = '--mn-font-size-editor'
export const TAB_SIZE_PROPERTY = '--mn-tab-size'

export interface AppearanceOverrides {
  uiFontSize: number
  editorFontSize: number
  tabWidth: number
}

function styleElement(): HTMLStyleElement | null {
  if (typeof document === 'undefined') return null
  const existing = document.getElementById(STYLE_ELEMENT_ID)
  if (existing instanceof HTMLStyleElement) return existing
  const style = document.createElement('style')
  style.id = STYLE_ELEMENT_ID
  // 与 theme/snippets.ts 一样挂到 <head>：卸载时整块移除，不留残余
  document.head.appendChild(style)
  return style
}

/** 应用字号与 Tab 宽度覆盖。 */
export function applyAppearanceOverrides(overrides: AppearanceOverrides): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.style.setProperty(UI_FONT_SIZE_PROPERTY, `${overrides.uiFontSize}px`)
  root.style.setProperty(EDITOR_FONT_SIZE_PROPERTY, `${overrides.editorFontSize}px`)
  root.style.setProperty(TAB_SIZE_PROPERTY, String(overrides.tabWidth))

  const style = styleElement()
  if (style === null) return
  // tab-size 是继承属性，写在 html 上即可覆盖编辑器、预览代码块与设置页自身
  style.textContent = [
    ':root {',
    `  ${UI_FONT_SIZE_PROPERTY}: ${overrides.uiFontSize}px !important;`,
    `  ${EDITOR_FONT_SIZE_PROPERTY}: ${overrides.editorFontSize}px !important;`,
    '}',
    `html { tab-size: var(${TAB_SIZE_PROPERTY}, 4); }`,
    '',
  ].join('\n')
}

/** 撤销全部覆盖（组件卸载 / 用户重置时调用）：字号回到主题令牌。 */
export function clearAppearanceOverrides(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.style.removeProperty(UI_FONT_SIZE_PROPERTY)
  root.style.removeProperty(EDITOR_FONT_SIZE_PROPERTY)
  root.style.removeProperty(TAB_SIZE_PROPERTY)
  document.getElementById(STYLE_ELEMENT_ID)?.remove()
}
