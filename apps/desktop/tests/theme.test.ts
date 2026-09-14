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

  it('「纸墨」阅读主题在内置清单里：浅色、令牌完整', () => {
    // 通用校验（上面的"每个内置主题都完整"）只能发现"缺令牌"，发现不了"主题根本没被
    // import.meta.glob 收进来"（例如文件放错了目录）—— 所以按 id 点名一次
    const paper = THEMES.find((theme) => theme.id === 'mimenote-paper')
    expect(paper).toBeDefined()
    if (paper === undefined) return
    expect(paper.appearance).toBe('light')
    expect(validateTheme(paper)).toEqual([])
  })

  it('nextThemeId 循环切换（走满一圈回到起点，中途不重复）', () => {
    // 断言不能假设"只有两个主题"（新增主题时 `next(next(first)) === first` 就会假红）：
    // 走满 THEMES.length 步必须正好遍历每个主题一次并回到起点
    const seen: string[] = [DEFAULT_THEME_ID]
    for (let step = 1; step < THEMES.length; step += 1) {
      seen.push(nextThemeId(seen[seen.length - 1] as string))
    }
    expect(new Set(seen).size).toBe(THEMES.length)
    expect(nextThemeId(seen[seen.length - 1] as string)).toBe(DEFAULT_THEME_ID)
  })
})
