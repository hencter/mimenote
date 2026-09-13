/** 主题完整性：所有内置主题必须提供全部令牌（防止改了 CSS 忘了改 JSON）。 */

import { describe, expect, it } from 'vitest'

import { DEFAULT_THEME_ID, THEMES, getTheme, nextThemeId } from '@/theme/apply'
import { REQUIRED_TOKENS, validateTheme } from '@/theme/tokens'

describe('主题', () => {
  it('至少加载到默认主题', () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(2)
    expect(THEMES.some((theme) => theme.id === DEFAULT_THEME_ID)).toBe(true)
  })

  it('每个内置主题都完整、id 唯一、令牌命名合法', () => {
    const ids = new Set<string>()
    for (const theme of THEMES) {
      expect(validateTheme(theme), `主题 ${theme.id} 校验失败`).toEqual([])
      expect(ids.has(theme.id)).toBe(false)
      ids.add(theme.id)
      expect(['dark', 'light']).toContain(theme.appearance)
    }
  })

  it('令牌清单受控：缺失会被 validateTheme 指出', () => {
    const broken = {
      id: 'broken',
      name: '残缺',
      appearance: 'dark' as const,
      tokens: { '--mn-bg': '#000' },
    }
    const problems = validateTheme(broken)
    expect(problems).toContain('--mn-fg')
    expect(problems.length).toBe(REQUIRED_TOKENS.length - 1)
  })

  it('非法令牌名会被指出', () => {
    const theme = THEMES[0]
    expect(theme).toBeDefined()
    if (theme === undefined) return
    const problems = validateTheme({ ...theme, tokens: { ...theme.tokens, 'color': 'red' } })
    expect(problems.some((problem) => problem.includes('非法令牌名'))).toBe(true)
  })

  it('默认主题排在最前，未知 id 回退到第一个主题', () => {
    expect(THEMES[0]?.id).toBe(DEFAULT_THEME_ID)
    expect(getTheme('不存在的主题').id).toBe(DEFAULT_THEME_ID)
  })

  it('nextThemeId 循环切换', () => {
    const first = DEFAULT_THEME_ID
    const second = nextThemeId(first)
    expect(second).not.toBe(first)
    expect(nextThemeId(second)).toBe(first)
  })
})
