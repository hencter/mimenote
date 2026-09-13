/**
 * 主题令牌定义（渲染层与主题 JSON 的**唯一契约**）。
 *
 * 主题 = 一份 JSON 清单 + 一组 CSS 变量（见 `docs/architecture.md` §2 主题层）。
 * 新增令牌时必须同步 {@link REQUIRED_TOKENS}，单测会校验所有内置主题都提供全部令牌。
 */

/** 主题清单（`theme/themes/*.json`）。 */
export interface ThemeManifest {
  /** 唯一 ID，写入 `<html data-theme>`。 */
  id: string
  /** 展示名。 */
  name: string
  /** 明暗属性，用于滚动条/原生控件配色。 */
  appearance: 'dark' | 'light'
  /** CSS 变量表（键必须以 `--mn-` 开头）。 */
  tokens: Record<string, string>
}

/** CSS 与编辑器主题共同依赖的令牌。 */
export const REQUIRED_TOKENS: readonly string[] = [
  '--mn-bg',
  '--mn-bg-elevated',
  '--mn-bg-sidebar',
  '--mn-fg',
  '--mn-fg-muted',
  '--mn-fg-subtle',
  '--mn-border',
  '--mn-accent',
  '--mn-accent-fg',
  '--mn-hover',
  '--mn-active',
  '--mn-selection',
  '--mn-editor-bg',
  '--mn-editor-fg',
  '--mn-editor-gutter-bg',
  '--mn-editor-gutter-fg',
  '--mn-active-line',
  '--mn-code-bg',
  '--mn-quote-border',
  '--mn-scrollbar',
  '--mn-danger',
  '--mn-warning',
  '--mn-success',
  '--mn-heading',
  '--mn-link',
  '--mn-font-ui',
  '--mn-font-mono',
  '--mn-font-size-ui',
  '--mn-font-size-editor',
  '--mn-radius',
  '--mn-shadow',
]

/** 校验主题完整性，返回缺失/非法的令牌名。 */
export function validateTheme(theme: ThemeManifest): string[] {
  const problems: string[] = []
  for (const token of REQUIRED_TOKENS) {
    const value = theme.tokens[token]
    if (value === undefined || value.trim() === '') problems.push(token)
  }
  for (const key of Object.keys(theme.tokens)) {
    if (!key.startsWith('--mn-')) problems.push(`非法令牌名：${key}`)
  }
  if (theme.id.trim() === '') problems.push('缺少 id')
  return problems
}
