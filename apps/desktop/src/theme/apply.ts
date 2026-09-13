/**
 * 主题装载与应用。
 *
 * 主题来自 `./themes/*.json`（构建期内联，无运行时网络请求）。
 * 应用方式是往 `<html>` 写 CSS 变量 + `data-theme` / `data-appearance`，
 * 因此 CodeMirror 的 `EditorView.theme` 里可以直接引用 `var(--mn-*)`，
 * 切换主题无需重建编辑器。
 */

import type { ThemeManifest } from './tokens'
import { validateTheme } from './tokens'

const modules = import.meta.glob<{ default: ThemeManifest }>('./themes/*.json', { eager: true })

/** 默认主题 ID（必须先于 THEMES 声明，排序回调会用到）。 */
export const DEFAULT_THEME_ID = 'mimenote-dark'

/** 全部内置主题（按名称排序，默认主题排在最前）。 */
export const THEMES: readonly ThemeManifest[] = Object.values(modules)
  .map((module) => module.default)
  .filter((theme): theme is ThemeManifest => typeof theme?.id === 'string')
  .sort((a, b) => {
    if (a.id === DEFAULT_THEME_ID) return -1
    if (b.id === DEFAULT_THEME_ID) return 1
    return a.name.localeCompare(b.name, 'zh-Hans-CN')
  })

export function getTheme(id: string): ThemeManifest {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0] ?? FALLBACK_THEME
}

/** 极端情况下的兜底主题（主题文件全部损坏时仍能渲染）。 */
const FALLBACK_THEME: ThemeManifest = {
  id: 'fallback',
  name: '兜底主题',
  appearance: 'dark',
  tokens: { '--mn-bg': '#000000', '--mn-fg': '#ffffff' },
}

/** 把主题写入 DOM。 */
export function applyTheme(theme: ThemeManifest, root: HTMLElement = document.documentElement): void {
  const problems = validateTheme(theme)
  if (problems.length > 0) {
    console.warn(`[theme] 主题 ${theme.id} 缺少令牌：${problems.join(', ')}`)
  }
  for (const [token, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(token, value)
  }
  root.dataset['theme'] = theme.id
  root.dataset['appearance'] = theme.appearance
  root.style.colorScheme = theme.appearance
}

/** 下一个主题（循环切换命令用）。 */
export function nextThemeId(currentId: string): string {
  const index = THEMES.findIndex((theme) => theme.id === currentId)
  const next = THEMES[(index + 1) % Math.max(1, THEMES.length)]
  return next?.id ?? DEFAULT_THEME_ID
}
